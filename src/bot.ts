import * as lark from '@larksuiteoapi/node-sdk';
import type { Store, CommandRow, ScopeType } from './db.ts';
import type { Caller, Block } from './engine.ts';
import { visibleCommands, findVisible, findManageable, runCommand, AmberError, secretVault, lineOf, dropOrphanSettings, runParams } from './engine.ts';
import { Mentions, reassignCard, listCard, formCard, runningCard, resultCard, errorCard, infoCard, retireConfirmCard, closedCard, secretFormCard, secretPickCard, executorApprovalCard, executorDecidedCard, executorListCard, executorFollowCard } from './cards.ts';
import { ExecutorHub } from './executors.ts';
import { AppStore } from './apps.ts';
import type { AmberConfig } from './config.ts';
import { Flow } from './flow.ts';
import { Signer } from './identity.ts';
import { FeishuReview } from './feishu-review.ts';
import { AgentGate } from './agent.ts';
import type { Deps } from './agent.ts';
import { Scheduler, CREATOR_LEFT } from './scheduler.ts';
import { newToken, hashToken, LOGIN_TTL_MS } from './web.ts';
import { formatAtDefault } from './schedule-rule.ts';

function log(...a: unknown[]): void {
  console.log(new Date().toISOString(), ...a);
}

/** Split "天气 \"New York\" 3" into ["天气", "New York", "3"]. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** #4: how long an offer to take over an orphaned command stays open. */
const REASSIGN_TTL_MS = 7 * 24 * 3600_000;

/** D44: how long a Feishu retire confirmation stays usable. */
const RETIRE_CONFIRM_MS = 5 * 60_000;

export class AmberBot {
  private client: lark.Client;
  private ws: lark.WSClient;
  private botOpenId = '';
  /** How long a 提交审核 click waits before answering and finishing in the background (Feishu allows ~3s). */
  claimSubmitWaitMs = 2500;
  private seen = new Map<string, number>();
  private chatTypeCache = new Map<string, 'group' | 'p2p'>();
  private store: Store;
  private cfg: AmberConfig;
  private adminUnionIds = new Set<string>();
  flow: Flow;
  signer: Signer;
  agent: AgentGate;
  scheduler: Scheduler;
  hub: ExecutorHub;
  apps: AppStore;

  private timers: boolean;

  /** `inject` is for tests: a fake Feishu client / long connection, and no background timers. */
  constructor(cfg: AmberConfig, store: Store, inject: { client?: unknown; ws?: unknown; timers?: boolean } = {}) {
    this.cfg = cfg;
    this.store = store;
    this.timers = inject.timers ?? true;
    this.client = (inject.client as lark.Client) ?? new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
    this.ws = (inject.ws as lark.WSClient) ?? new lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: lark.LoggerLevel.warn });
    this.signer = new Signer(cfg.configDir);
    this.flow = new Flow(this.client, store, cfg.reviewers);
    this.flow.signer = this.signer;
    this.flow.review = new FeishuReview(this.client, { approval: cfg.approval, wiki: cfg.wiki });
    this.flow.nameOf = (u: string) => this.nameOf(u);
    this.flow.isAdmin = (u: string) => this.isAdmin(u);
    const deps: Deps = {
      send: (to, card) => this.flow.send(to, card),
      patch: (id, card) => this.patch(id, card),
      resolveUser: email => this.resolveUser(email),
      cityOf: u => this.cityOf(u),
      isAdmin: u => this.isAdmin(u),
      isMember: (chatId, u) => this.isMember(chatId, u),
      signer: this.signer,
      retire: (id, actor, by) => this.retire(id, actor, by),
      nameOf: u => this.nameOf(u),
      mentionsFor: (chatId, chatType, blocks) => this.mentionsFor(chatId, chatType, blocks),
    };
    this.agent = new AgentGate(store, deps);
    this.scheduler = new Scheduler(store, deps);
    this.agent.scheduler = this.scheduler;
    this.flow.isListed = c => !!this.apps.appOfOriginal(c);
    this.flow.onReplaced = async (prev, next) => {
      await this.scheduler.onCommandReplaced(prev, next);
      await this.apps.onVersionLive(prev, next);
    };
    this.hub = new ExecutorHub(store, this.signer);
    this.apps = new AppStore(store, this.flow, {
      isMember: (c, u) => this.isMember(c, u), isAdmin: u => this.isAdmin(u), nameOf: u => this.nameOf(u), openIdOf: u => this.flow.openIdOf(u), webUrl: cfg.webBaseUrl, resolveUser: e => this.resolveUser(e),
    });
    this.hub.approvalCard = executorApprovalCard;
    this.hub.followCard = executorFollowCard;
    this.hub.notifyAdmins = async card => {
      if (!this.adminUnionIds.size) log('executor registered but no admin resolved to approve it');
      for (const u of this.adminUnionIds) await this.flow.send({ unionId: u }, card).catch(e => log('executor card failed', e?.message));
    };
  }

  /** Take a command offline (D39). Only its creator or an admin. Its schedules pause. */
  async retire(cmdId: string, actor: { unionId: string }, byLabel: string, opts: { delist?: boolean } = {}): Promise<{ name: string; schedules: number; delisted?: boolean }> {
    const c = this.store.getCommand(cmdId);
    if (!c || c.status !== 'active') throw new AmberError('not_found', '应用不存在或已下线');
    if (c.ownerUnionId !== actor.unionId && !this.isAdmin(actor.unionId)) throw new AmberError('forbidden', '只有应用的创建人或管理员可以下线');
    // Check before anything changes: delisting is for the app's maintainer or an admin (#4).
    const app = this.apps.appOfOriginal(c);
    const delist = !!opts.delist && app?.status === 'listed';
    if (delist && app!.maintainerUnionId !== actor.unionId && !this.isAdmin(actor.unionId)) throw new AmberError('forbidden', '只有应用的维护人或管理员可以下架；不下架的话可以直接下线');
    this.store.setStatus(c.id, 'retired');
    this.store.audit(actor.unionId, 'command.retire', { id: c.id, name: c.name, specHash: c.specHash });
    log('command retired', c.id, c.name);
    dropOrphanSettings(this.store, c.chatId, c.line, actor.unionId);
    const schedules = await this.scheduler.onCommandRetired(c, byLabel);
    // An app's original (#4): by default the app stays in the Store (no more new versions); or it goes too.
    if (delist) { this.apps.delist(app!.id, actor.unionId); return { name: c.name, schedules, delisted: true }; }
    return { name: c.name, schedules };
  }

  isAdminPublic(unionId: string): boolean { return this.isAdmin(unionId); }

  /** Who may set a command's secrets (D48): its creator or an admin; for a new draft, whoever may claim it. */
  async checkSecretEditor(c: CommandRow, unionId: string): Promise<void> {
    if (!c.script.secrets?.length) throw new AmberError('no_secrets', `「${c.name}」没有声明需要密钥`);
    if (this.isAdmin(unionId)) return;
    if (c.status === 'active' || c.status === 'pending') {
      if (c.ownerUnionId === unionId) return;
      throw new AmberError('forbidden', '只有应用的创建人或管理员可以设置密钥');
    }
    if (c.status === 'draft') {
      const prev = this.flow.prevOf(c.id);
      if (prev) { if (prev.ownerUnionId === unionId) return; throw new AmberError('forbidden', `这是「${c.name}」的新版本，只有原创建人或管理员可以设置密钥`); }
      const meta = this.store.getMeta(c.id);
      if (meta.expectedClaimer) { if (meta.expectedClaimer === unionId) return; throw new AmberError('forbidden', '只有指定的认领人可以设置密钥'); }
      if (c.scopeType === 'group' && (await this.isMember(c.chatId, unionId)) === true) return;
      throw new AmberError('forbidden', '只有草稿所在群的成员可以设置密钥');
    }
    throw new AmberError('stale', '这个应用已下线或没有通过审核，不能设置密钥');
  }

  private secretCard(c: CommandRow, note?: string): object {
    return secretFormCard(c, secretVault()!.info(lineOf(c), c.script.secrets ?? []), note);
  }

  /** Commands named `name` whose secrets this person may set. */
  private async secretTargets(name: string, unionId: string): Promise<CommandRow[]> {
    const out: CommandRow[] = [];
    for (const c of this.store.listAll()) {
      if (c.name !== name || !c.script.secrets?.length || !['draft', 'pending', 'active'].includes(c.status)) continue;
      try { await this.checkSecretEditor(c, unionId); out.push(c); } catch { /* not theirs */ }
    }
    return out;
  }

  /** Secrets are only ever typed in the person's private chat with Amber. */
  private async secretEntry(text: string, caller: Caller, messageId: string, inThread: boolean): Promise<void> {
    const targets = await this.secretTargets(text, caller.unionId);
    if (!targets.length) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `没有找到你可以设置密钥的应用「${text}」（需要应用声明了密钥，并且你是创建人或管理员）`));
      return;
    }
    let card: object;
    if (targets.length === 1) card = this.secretCard(targets[0]);
    else card = secretPickCard(await Promise.all(targets.map(async c => ({ c, where: c.scopeType === 'p2p' ? '私聊' : `群：${(await this.chatName(c.chatId)) ?? c.chatId}` }))));
    if (caller.chatType === 'p2p') { await this.replyCard(messageId, inThread, card); return; }
    await this.flow.send({ unionId: caller.unionId }, card);
    await this.replyCard(messageId, inThread, infoCard('设置密钥', '密钥只能在私聊里填写，已私聊发给你。'));
  }

  private async onSecretAction(a: string, cmdId: string, caller: Caller, form: Record<string, string>): Promise<object> {
    const c = this.store.getCommand(cmdId);
    if (!c) throw new AmberError('not_found', '应用不存在');
    await this.checkSecretEditor(c, caller.unionId);
    if (a === 'sec_form') {
      if (caller.chatType === 'p2p') return { card: { type: 'raw', data: this.secretCard(c) } };
      await this.flow.send({ unionId: caller.unionId }, this.secretCard(c));
      return { toast: { type: 'info', content: '已私聊你填写密钥' } };
    }
    // sec_save: only from the private chat, only declared names, empty = unchanged.
    if (caller.chatType !== 'p2p') throw new AmberError('p2p_only', '密钥只能在和 Amber 的私聊里填写');
    const saved: string[] = [];
    for (const n of c.script.secrets ?? []) {
      const v = (form[n] ?? '').trim();
      if (!v) continue;
      try { secretVault()!.set(lineOf(c), n, v, caller.unionId); } catch (e) { throw new AmberError('bad_secret', `${n}：${(e as Error).message}`); }
      saved.push(n);
    }
    if (!saved.length) throw new AmberError('empty', '没有填写任何值');
    this.store.audit(caller.unionId, 'secret.set', { commandId: c.id, chatId: c.chatId, name: c.name, secrets: saved, via: 'bot' });
    log('secrets set', c.id, saved.join(','));
    return { card: { type: 'raw', data: this.secretCard(c, `已保存：${saved.join('、')}`) } };
  }

  /** Email → ids as seen by Amber's app. */
  async resolveUser(email: string): Promise<{ unionId: string; openId?: string } | undefined> {
    const get = async (type: 'union_id' | 'open_id') => {
      const r = await this.client.contact.v3.user.batchGetId({ params: { user_id_type: type }, data: { emails: [email] } }) as any;
      return (r?.data?.user_list ?? []).find((u: any) => u.email === email && u.user_id)?.user_id as string | undefined;
    };
    try {
      const unionId = await get('union_id');
      if (!unionId) return undefined;
      return { unionId, openId: await get('open_id').catch(() => undefined) };
    } catch (e: any) {
      log('user lookup failed', e?.response?.data?.code ?? e?.message);
      return undefined;
    }
  }

  private memberCache = new Map<string, { ids: Set<string>; at: number }>();

  /** Whether a person is in a group. undefined when Amber cannot tell (needs im:chat.members:read). */
  /** #4: a group command whose creator is no longer in its group. undefined = cannot tell. */
  async isOrphan(c: CommandRow): Promise<boolean | undefined> {
    if (c.scopeType !== 'group') return false;   // no owner on record counts as gone
    const m = await this.isMember(c.chatId, c.ownerUnionId);
    return m === undefined ? undefined : !m;
  }

  /** People in a group, for an admin choosing who takes over an orphaned command. */
  async groupMembers(chatId: string): Promise<{ unionId: string; name: string }[]> {
    const out: { unionId: string; name: string }[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 50; i++) {
      const r = await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}/members`, params: { member_id_type: 'union_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } }) as any;
      for (const m of r?.data?.items ?? []) if (m.member_id) out.push({ unionId: String(m.member_id), name: String(m.name ?? '') });
      if (!r?.data?.has_more) break;
      pageToken = r.data.page_token;
    }
    return out;
  }

  /** #4: an admin offers an orphaned command to a group member; it changes hands only when that person accepts. */
  async requestReassign(cmdId: string, toUnionId: string, admin: { unionId: string; openId?: string }): Promise<{ requestId: string }> {
    if (!this.isAdmin(admin.unionId)) throw new AmberError('forbidden', '只有管理员可以重新分配应用');
    const c = this.store.getCommand(cmdId);
    if (!c || c.status !== 'active' || c.scopeType !== 'group') throw new AmberError('not_found', '没有找到这个群应用');
    this.memberCache.delete(c.chatId);   // decide on the current roster, not a cached one
    const orphan = await this.isOrphan(c);
    if (orphan === undefined) throw new AmberError('unknown_membership', 'Amber 暂时无法确认创建人是否还在群里（缺少「获取群成员」权限）');
    if (!orphan) throw new AmberError('not_orphan', '创建人还在群里：只有创建人已不在群里的应用才能重新分配');
    if (await this.isMember(c.chatId, toUnionId) !== true) throw new AmberError('bad_target', '只能分配给这个群的成员');
    // One open offer at a time: a new one replaces the old.
    for (const r of this.store.awaitingReassigns(c.id)) this.store.transitionRequest(r.id, 'awaiting', 'canceled', { actorUnionId: admin.unionId });
    const req = this.store.insertRequest({ kind: 'reassign', commandId: c.id, specHash: c.specHash, chatId: c.chatId, chatType: 'group', targetUnionId: toUnionId,
      args: { from: c.ownerUnionId }, rule: null, scheduleId: null, requestedBy: admin.unionId, replyTo: null, inThread: false });
    const schedules = this.store.schedulesOfCommand(c.id).filter(s => s.creatorUnionId === c.ownerUnionId).map(s => this.scheduler.view(s));
    const card = reassignCard({ requestId: req.id, name: c.name, chatName: (await this.chatName(c.chatId)) ?? '这个群', adminOpenId: admin.openId,
      schedules, secrets: this.store.secretRows(c.chatId, c.line).filter(r => (c.script.secrets ?? []).includes(r.name)).length,
      config: this.store.configRows(c.chatId, c.line).filter(r => c.params.some(p => p.scope === 'config' && p.name === r.name)).length });
    try {
      const mid = await this.flow.send({ unionId: toUnionId }, card);
      if (mid) this.store.setRequestMessage(req.id, mid);
    } catch (e) {
      this.store.transitionRequest(req.id, 'awaiting', 'failed', { error: 'card_failed' });
      throw new AmberError('send_failed', '没能把确认卡发给对方，请稍后再试');
    }
    this.store.audit(admin.unionId, 'command.reassign_request', { commandId: c.id, name: c.name, chatId: c.chatId, from: c.ownerUnionId, to: toUnionId, requestId: req.id });
    return { requestId: req.id };
  }

  /** The person an orphaned command was offered to clicks: accept (optionally rebuilding its schedules as them) or decline. */
  private async onReassignClick(value: Record<string, string>, caller: Caller): Promise<object> {
    const req = this.store.getRequest(String(value.r));
    if (!req || req.kind !== 'reassign') throw new AmberError('not_found', '这个请求已不存在');
    if (req.targetUnionId !== caller.unionId) throw new AmberError('forbidden', '这张卡片是发给别人的');
    if (req.status !== 'awaiting') throw new AmberError('closed', '这个请求已经处理过或被取消了');
    const c = req.commandId ? this.store.getCommand(req.commandId) : undefined;
    if (value.a === 'rs_no') {
      this.store.transitionRequest(req.id, 'awaiting', 'canceled', { actorUnionId: caller.unionId });
      this.store.audit(caller.unionId, 'command.reassign_decline', { requestId: req.id, commandId: req.commandId });
      try { await this.flow.send({ unionId: req.requestedBy }, infoCard('对方没有接收', `${c?.name ?? '应用'}：对方选择了不接收。`)); } catch { /* best effort */ }
      return closedCard('没有接收', 'grey', `你没有接收「${c?.name ?? '应用'}」。`);
    }
    if (Date.now() - req.createdAt > REASSIGN_TTL_MS) {
      this.store.transitionRequest(req.id, 'awaiting', 'expired');
      throw new AmberError('expired', '这张卡片已超过 7 天，请管理员重新发起');
    }
    const fail = (why: string) => { this.store.transitionRequest(req.id, 'awaiting', 'failed', { error: why }); return closedCard('没有接收', 'red', why); };
    if (!c || c.status !== 'active' || c.specHash !== req.specHash) return fail('这个应用在发起之后已经更新或下线，请管理员重新发起。');
    // Someone else accepted another offer for it meanwhile.
    if (c.ownerUnionId !== (req.args.from ?? '')) return fail('这个应用已经由别人接手了。');
    this.memberCache.delete(c.chatId);   // decide on the current roster, not a cached one
    if (await this.isOrphan(c) !== true) return fail('原创建人已经回到群里（或暂时无法确认），这个应用不再需要重新分配。');
    if (await this.isMember(c.chatId, caller.unionId) !== true) return fail('你已不在这个群里，不能接手。');
    // The checks above awaited the roster: the command may have been retired or updated meanwhile.
    const fresh = this.store.getCommand(c.id);
    if (!fresh || fresh.status !== 'active' || fresh.specHash !== req.specHash || fresh.ownerUnionId !== (req.args.from ?? '')) return fail('这个应用在发起之后已经更新、下线或由别人接手，请管理员重新发起。');
    // No await from here to the owner change, and taking this offer voids every other one for the command:
    // when two people accept at the same moment, the second finds their offer already voided.
    if (!this.store.transitionRequest(req.id, 'awaiting', 'running', { actorUnionId: caller.unionId })) throw new AmberError('closed', '这个请求已经处理过或被取消了');
    for (const r of this.store.awaitingReassigns(c.id)) this.store.transitionRequest(r.id, 'awaiting', 'canceled', { actorUnionId: caller.unionId });
    const from = c.ownerUnionId;
    const old = this.store.schedulesOfCommand(c.id).filter(s => s.creatorUnionId === from);
    this.store.setMeta(c.id, { ownerUnionId: caller.unionId, ownerOpenId: caller.openId ?? null });
    const now = this.store.getCommand(c.id)!;
    const rebuilt: string[] = [], failed: string[] = [];
    for (const s of old) {
      this.scheduler.remove(s, caller.unionId);
      if (value.s !== '1') continue;
      try {
        const n = await this.scheduler.create({ cmd: now, chatId: s.chatId, chatType: s.chatType, replyTo: s.replyTo, inThread: s.inThread,
          creator: { ...caller, chatId: s.chatId, chatType: s.chatType, channel: 'bot' }, args: s.args, rule: s.rule, requestedBy: '重新分配', via: { reassignFrom: s.id } });
        // Paused because the creator left: that is what this fixes, so it runs again. Paused for any other reason
        // (by hand, after failures): it stays paused.
        if (s.status === 'paused' && s.pauseReason !== CREATOR_LEFT) this.scheduler.pauseBy(n, caller.unionId, s.pauseReason ?? '原来已暂停');
        rebuilt.push(n.id);
      } catch (e) { failed.push(`${s.id}：${e instanceof AmberError ? e.message : '出错了'}`); }
    }
    this.store.transitionRequest(req.id, 'running', 'done', { actorUnionId: caller.unionId });
    this.store.audit(caller.unionId, 'command.reassign', { requestId: req.id, commandId: c.id, name: c.name, chatId: c.chatId, from, to: caller.unionId, schedulesDeleted: old.map(s => s.id), schedulesRebuilt: rebuilt });
    const note = `${old.length ? (value.s === '1' ? `原来的 ${old.length} 个定时任务已以你的身份重建 ${rebuilt.length} 个${failed.length ? `；没能重建：${failed.join('；')}` : ''}。` : `原来的 ${old.length} 个定时任务已删除。`) : ''}`;
    try { await this.flow.send({ unionId: req.requestedBy }, infoCard('应用已接手', `「${c.name}」已由新的负责人接收。${note}`)); } catch { /* best effort */ }
    return closedCard(`已接手：${c.name}`, 'green', `你现在是「${c.name}」的创建人。在网站上可以查看和修改它的配置项、密钥。${note}`);
  }

  private groupsCache?: { at: number; list: { chatId: string; name: string }[] };

  /** Groups Amber is in (#4: where someone may install an app). Kept for a minute. */
  async botGroups(): Promise<{ chatId: string; name: string }[]> {
    if (this.groupsCache && Date.now() - this.groupsCache.at < 60_000) return this.groupsCache.list;
    const list: { chatId: string; name: string }[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < 20; i++) {
      const r = await this.client.request({ method: 'GET', url: '/open-apis/im/v1/chats', params: { page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } }) as any;
      for (const c of r?.data?.items ?? []) if (c.chat_id) list.push({ chatId: String(c.chat_id), name: String(c.name ?? '') });
      if (!r?.data?.has_more) break;
      pageToken = r.data.page_token;
    }
    this.groupsCache = { at: Date.now(), list };
    return list;
  }

  /** Fallback for when approval events are not delivered: look at every pending approval (commands and listings). */
  async pollApprovals(): Promise<void> {
    for (const code of [...this.store.pendingApprovalInstances(), ...this.store.pendingListingInstances()]) {
      await this.onApprovalEvent(code).catch(e => log('approval poll failed', code, (e as Error).message));
    }
  }

  /** An approval instance is either a command review or a Store listing (#4). */
  async onApprovalEvent(code: string): Promise<void> {
    if (await this.apps.onApprovalEvent(code)) return;
    await this.flow.onApprovalEvent(code);
  }

  async isMember(chatId: string, unionId: string): Promise<boolean | undefined> {
    const hit = this.memberCache.get(chatId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ids.has(unionId);
    const ids = new Set<string>();
    let pageToken: string | undefined;
    try {
      for (let i = 0; i < 50; i++) {
        const r = await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}/members`, params: { member_id_type: 'union_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } }) as any;
        for (const m of r?.data?.items ?? []) if (m.member_id) ids.add(m.member_id);
        if (!r?.data?.has_more) break;
        pageToken = r.data.page_token;
      }
    } catch (e: any) {
      log('member check unavailable', chatId, e?.response?.data?.code ?? e?.message);
      return undefined;
    }
    this.memberCache.set(chatId, { ids, at: Date.now() });
    return ids.has(unionId);
  }

  private mentionCache = new Map<string, { members: Map<string, string>; at: number }>();

  /** Who a real run's result may @ in this group (#1): every member, person or bot, by display name. Amber itself
   *  and names two members share are left out. Fetched only when the output has an `@`; kept for a minute. */
  async mentionsFor(chatId: string, chatType: ScopeType, blocks: Block[]): Promise<Mentions | undefined> {
    if (chatType !== 'group' || !blocks.some(b => b.text.includes('@'))) return undefined;
    const hit = this.mentionCache.get(chatId);
    if (hit && Date.now() - hit.at < 60_000) return new Mentions(hit.members);
    const seen = new Map<string, string | null>();   // name -> open_id, or null when the name is taken twice
    const add = (name: unknown, id: unknown) => {
      if (typeof name !== 'string' || typeof id !== 'string' || !name || id === this.botOpenId) return;
      seen.set(name, seen.has(name) && seen.get(name) !== id ? null : id);
    };
    try {
      let pageToken: string | undefined;
      let complete = false;
      for (let i = 0; i < 50; i++) {
        const r = await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}/members`, params: { member_id_type: 'open_id', page_size: 100, ...(pageToken ? { page_token: pageToken } : {}) } }) as any;
        for (const m of r?.data?.items ?? []) add(m.name, m.member_id);
        if (!r?.data?.has_more) { complete = true; break; }
        pageToken = r.data.page_token;
      }
      // Without the whole list a name another member also has could look unique: no @s rather than a wrong one.
      if (!complete) throw new Error('member list too long');
      const b = await this.client.request({ method: 'GET', url: `/open-apis/im/v1/chats/${chatId}/members/bots` }) as any;
      for (const m of b?.data?.items ?? []) add(m.bot_name, m.bot_id);
    } catch (e: any) {
      log('mention lookup unavailable', chatId, e?.response?.data?.code ?? e?.message);
      return undefined;
    }
    const members = new Map([...seen].filter((x): x is [string, string] => x[1] !== null));
    this.mentionCache.set(chatId, { members, at: Date.now() });
    return new Mentions(members);
  }

  async start(): Promise<void> {
    const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as { bot?: { open_id?: string; app_name?: string } };
    this.botOpenId = info.bot?.open_id ?? '';
    if (!this.botOpenId) throw new Error('cannot resolve Amber bot open_id');
    log('bot', info.bot?.app_name, this.botOpenId);
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (d: any) => { this.onMessage(d).catch(e => log('onMessage error', e?.message ?? e)); },
      'card.action.trigger': async (d: any) => this.onCardAction(d),
      'approval_instance': async (d: any) => {
        const code = d?.instance_code ?? d?.event?.instance_code;
        log('approval event', code, d?.status ?? d?.event?.status);
        if (code) this.onApprovalEvent(String(code)).catch(e => log('approval handling failed', (e as Error).message));
      },
    } as any);
    this.ws.start({ eventDispatcher: dispatcher });
    log('long connection started');
    await this.resolveAdmins();
    await this.flow.loadReviewers();
    const poll = () => this.pollApprovals();
    await poll();
    if (!this.timers) return;
    setInterval(() => { poll().catch(() => {}); }, 60_000);
    this.scheduler.start();
  }

  /** Emails are resolved through Amber's own app (needs contact:user.id:readonly); union_ids are taken as-is. */
  async resolveAdmins(): Promise<void> {
    const ids = new Set<string>();
    const emails: string[] = [];
    for (const a of this.cfg.admins) (a.startsWith('on_') ? ids.add(a) : emails.push(a));
    if (emails.length) {
      try {
        const r = await this.client.contact.v3.user.batchGetId({ params: { user_id_type: 'union_id' }, data: { emails } }) as any;
        const list: any[] = r?.data?.user_list ?? [];
        for (const e of emails) {
          const hit = list.find(u => u.email === e && u.user_id);
          if (hit) ids.add(hit.user_id); else log('admin email not resolved', e);
        }
      } catch (e: any) {
        log('admin email lookup failed (missing contact:user.id:readonly?)', e?.response?.data?.code ?? e?.message);
      }
    }
    this.adminUnionIds = ids;
    log('admins resolved', ids.size, 'of', this.cfg.admins.length, 'entries');
  }

  private isAdmin(unionId: string): boolean {
    return this.adminUnionIds.has(unionId);
  }

  /** Admin-only chat commands: change a command's scope, or list every command. Returns true when handled. */
  private async adminCommand(parts: string[], caller: Caller, messageId: string, inThread: boolean): Promise<boolean> {
    // #9: commands are called apps now; the old word keeps working.
    const verb = parts[0] === '所有指令' ? '所有应用' : parts[0];
    const verbs = ['全局', '设为全局', '取消全局', '设为本地', '所有应用', '执行端', '撤销执行端'];
    if (!verbs.includes(verb)) return false;
    if (!this.isAdmin(caller.unionId)) {
      await this.replyCard(messageId, inThread, errorCard('Amber', verb.includes('执行端') ? '只有管理员可以管理执行端' : '只有管理员可以修改应用的执行范围'));
      return true;
    }
    if (verb === '执行端') {
      await this.replyCard(messageId, inThread, executorListCard(this.store.listExecutors().map(e => ({ e, online: this.hub.online(e) }))));
      return true;
    }
    if (verb === '撤销执行端') {
      const e = parts[1] ? this.hub.revoke(parts[1], caller.unionId) : undefined;
      await this.replyCard(messageId, inThread, e ? infoCard('执行端已撤销', `「${e.name}」已撤销：不会再给它派任务，正在等的任务立即失败。要恢复，需要在那台机器上重新生成密钥并再次批准。`) : errorCard('Amber', parts[1] ? `没有已批准的执行端叫「${parts[1]}」` : '用法：撤销执行端 <名称>'));
      return true;
    }
    if (verb === '所有应用') {
      const rows = this.store.listAll().filter(c => c.status === 'active');
      const lines = rows.map(c => `- **${c.name}**（${c.id}）· ${c.global ? '全局' : c.scopeType === 'p2p' ? '私聊' : '群'} · 创建于 ${c.chatId}`);
      await this.replyCard(messageId, inThread, infoCard('所有生效的应用', lines.join('\n') || '（没有）'));
      return true;
    }
    const target = parts[1];
    if (!target) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `用法：${verb} <应用名或 id>`));
      return true;
    }
    const all = this.store.listAll().filter(c => c.status === 'active');
    let cmd = all.find(c => c.id === target);
    if (!cmd) {
      const visible = visibleCommands(this.store, caller).filter(c => c.name === target);
      const sameName = all.filter(c => c.name === target);
      cmd = visible[0] ?? (sameName.length === 1 ? sameName[0] : undefined);
      if (!cmd && sameName.length > 1) {
        await this.replyCard(messageId, inThread, errorCard('Amber', `有 ${sameName.length} 个叫「${target}」的应用，请改用 id（发「所有应用」查看）`));
        return true;
      }
    }
    if (!cmd) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `没有找到应用「${target}」`));
      return true;
    }
    const toGlobal = verb === '全局' || verb === '设为全局';
    if (toGlobal && !cmd.global && this.store.listActiveGlobal().some(g => g.name === cmd!.name)) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `已经有一个全局应用叫「${cmd.name}」，不能重名`));
      return true;
    }
    this.store.setGlobal(cmd.id, toGlobal);
    this.store.audit(caller.unionId, toGlobal ? 'scope.promote' : 'scope.demote', { id: cmd.id, name: cmd.name });
    log('scope', toGlobal ? 'promote' : 'demote', cmd.id, cmd.name);
    await this.replyCard(messageId, inThread, infoCard('执行范围已修改', toGlobal
      ? `「${cmd.name}」（${cmd.id}）已设为**全局**：Amber 所在的任何群和私聊都能使用。${cmd.script.secrets?.length ? `\n\n⚠️ 这个应用使用密钥（${cmd.script.secrets.join('、')}）：设为全局后，任何地方执行都会用到同一份密钥。` : ''}`
      : `「${cmd.name}」（${cmd.id}）已改回**只在创建处可用**。`));
    return true;
  }

  private firstTime(key: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async chatType(chatId: string): Promise<'group' | 'p2p'> {
    const cached = this.chatTypeCache.get(chatId);
    if (cached) return cached;
    const r = await this.client.im.v1.chat.get({ path: { chat_id: chatId } }) as any;
    const mode = r?.data?.chat_mode === 'p2p' ? 'p2p' : 'group';
    this.chatTypeCache.set(chatId, mode);
    return mode;
  }

  private scopeLabel(caller: Caller): string {
    return caller.chatType === 'p2p' ? '你的私聊里' : '你在本群';
  }

  private async replyCard(messageId: string, inThread: boolean, card: object): Promise<void> {
    await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: inThread },
    });
  }

  private async onMessage(d: any): Promise<void> {
    const msg = d.message;
    const sender = d.sender;
    if (!msg || !sender) return;
    if (sender.sender_type !== 'user') return; // bots never trigger Amber
    if (!this.firstTime(`m:${msg.message_id}`)) return;
    const chatType: 'group' | 'p2p' = msg.chat_type === 'p2p' ? 'p2p' : 'group';
    const mentions: any[] = msg.mentions ?? [];
    if (chatType === 'group' && !mentions.some(m => m?.id?.open_id === this.botOpenId)) return;
    if (msg.message_type !== 'text') return;
    let text = '';
    try { text = JSON.parse(msg.content).text ?? ''; } catch { return; }
    for (const m of mentions) text = text.split(m.key).join(' ');
    text = text.trim();
    const caller: Caller = {
      unionId: sender.sender_id?.union_id ?? '',
      openId: sender.sender_id?.open_id,
      chatId: msg.chat_id,
      chatType,
      channel: 'bot',
    };
    if (!caller.unionId) return;
    this.chatTypeCache.set(msg.chat_id, chatType);
    const inThread = !!msg.thread_id;
    log('message', chatType, msg.chat_id, inThread ? `thread ${msg.thread_id}` : '', JSON.stringify(text.slice(0, 80)));

    const parts = splitArgs(text);
    if (parts.length > 0 && await this.adminCommand(parts, caller, msg.message_id, inThread)) return;
    if (parts.length === 1 && ['登录', '登录网站', 'login', '退出网站', 'logout'].includes(parts[0].toLowerCase())) {
      await this.webLogin(parts[0].toLowerCase(), caller, msg.message_id, inThread);
      return;
    }
    if (parts.length === 2 && ['下线', 'retire'].includes(parts[0].toLowerCase())) {
      try {
        const cmd = findManageable(this.store, caller, parts[1], this.isAdmin(caller.unionId));
        // Check the permission now so nobody gets a confirmation they cannot use (D44).
        if (cmd.ownerUnionId !== caller.unionId && !this.isAdmin(caller.unionId)) throw new AmberError('forbidden', '只有应用的创建人或管理员可以下线');
        const schedules = this.store.schedulesOfCommand(cmd.id).length;
        await this.replyCard(msg.message_id, inThread, retireConfirmCard(cmd, schedules, caller.unionId, Date.now(), this.apps.appOfOriginal(cmd)?.status === 'listed'));
      } catch (e) {
        await this.replyCard(msg.message_id, inThread, errorCard('Amber', e instanceof AmberError ? e.message : '出错了'));
      }
      return;
    }
    if (parts.length === 2 && ['设置密钥', '密钥', 'secrets'].includes(parts[0].toLowerCase())) {
      try { await this.secretEntry(parts[1], caller, msg.message_id, inThread); }
      catch (e) { await this.replyCard(msg.message_id, inThread, errorCard('Amber', e instanceof AmberError ? e.message : '出错了')); }
      return;
    }
    if (parts.length === 1 && ['定时任务', '定时', 'schedules'].includes(parts[0].toLowerCase())) {
      await this.replyCard(msg.message_id, inThread, this.scheduleList(caller));
      return;
    }
    if (parts.length === 0 || ['帮助', 'help', '列表', 'list', '应用', '指令'].includes(parts[0].toLowerCase())) {
      await this.replyCard(msg.message_id, inThread, listCard(visibleCommands(this.store, caller), this.scopeLabel(caller)));
      return;
    }
    let cmd: CommandRow;
    try {
      cmd = findVisible(this.store, caller, parts[0].replace(/^\//, ''));
    } catch (e) {
      await this.replyCard(msg.message_id, inThread, errorCard('Amber', e instanceof AmberError ? e.message : '出错了'));
      return;
    }
    const positional = parts.slice(1);
    const raw: Record<string, string> = {};
    const params = runParams(cmd.params);
    params.forEach((p, i) => { if (positional[i] !== undefined) raw[p.name] = positional[i]; });
    // confirm = true: never run from a one-line shortcut; show the confirmation form, prefilled.
    if (cmd.options.confirm || (positional.length === 0 && params.some(p => p.required && p.default === undefined))) {
      await this.replyCard(msg.message_id, inThread, formCard(cmd, raw));
      return;
    }
    // Reply with a "running" card first, then patch it with the result.
    const sent = await this.client.im.v1.message.reply({
      path: { message_id: msg.message_id },
      data: { msg_type: 'interactive', content: JSON.stringify(runningCard(cmd.name, caller.openId)), reply_in_thread: inThread },
    }) as any;
    const cardMessageId: string | undefined = sent?.data?.message_id;
    const final = await this.execute(cmd, raw, caller);
    if (cardMessageId) await this.patch(cardMessageId, final);
  }

  /** D34: website login by chatting with Amber. The link only ever appears in the person's own
   *  private chat with Amber: asked in a group, Amber sends it there and says so in the group (D43). */
  private async webLogin(verb: string, caller: Caller, messageId: string, inThread: boolean): Promise<void> {
    const inGroup = caller.chatType !== 'p2p';
    if (verb === '退出网站' || verb === 'logout') {
      const n = this.store.revokeWebSessionsOf(caller.unionId);
      this.store.audit(caller.unionId, 'web.logout_all', { sessions: n });
      await this.replyCard(messageId, inThread, infoCard('已退出网站', n ? `已让你在所有浏览器里的 ${n} 个登录失效。` : '你当前没有登录中的浏览器。'));
      return;
    }
    if (this.store.recentWebLogins(caller.unionId, 3600_000) >= 10) {
      await this.replyCard(messageId, inThread, errorCard('网站登录', '一小时内申请登录太多次了，请稍后再试'));
      return;
    }
    if (inGroup && !caller.unionId) return;
    const token = newToken();
    const h = hashToken(token);
    this.store.insertWebLogin(h, caller.unionId, caller.openId ?? null);
    const url = `${this.cfg.webBaseUrl}/login?t=${token}`;
    const card = {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Amber · 登录网站' }, template: 'orange' },
      body: { elements: [
        { tag: 'markdown', content: '点下面的按钮，在浏览器里登录 Amber 网站。\n<font color="grey">链接 5 分钟内有效、只能用一次。**不要转发给别人**——拿到链接的人就能以你的身份登录。</font>' },
        { tag: 'button', text: { tag: 'plain_text', content: '打开 Amber 网站' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }] },
      ] },
    };
    let sentId: string | undefined;
    if (inGroup) {
      // Never into the group: anyone there could open the link. Send it to the person's private chat.
      try { sentId = await this.flow.send({ unionId: caller.unionId }, card); } catch (e: any) { log('login dm failed', e?.response?.data?.code ?? e?.message); }
      if (!sentId) {
        this.store.consumeWebLogin(h, LOGIN_TTL_MS + 60_000); // burn the unsent link
        await this.replyCard(messageId, inThread, errorCard('网站登录', '没能给你发私聊消息。请直接私聊 Amber 发送「登录」。'));
        return;
      }
      await this.replyCard(messageId, inThread, infoCard('网站登录', '登录链接已私聊发给你，请到和 Amber 的私聊里打开。链接只在私聊里发，不会出现在群里。'));
    } else {
      const r = await this.client.im.v1.message.reply({ path: { message_id: messageId }, data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: inThread } }) as any;
      sentId = r?.data?.message_id;
    }
    if (sentId) this.store.setWebLoginMessage(h, sentId);
    this.store.audit(caller.unionId, 'web.login_link', inGroup ? { requestedIn: caller.chatId } : {});
    const sent = { data: { message_id: sentId } };
    // Expire the card visibly once the link can no longer be used.
    setTimeout(() => {
      if (sent?.data?.message_id && this.store.consumeWebLogin(h, LOGIN_TTL_MS + 60_000)) {
        this.patch(sent.data.message_id, infoCard('登录链接已过期', '这个登录链接没有使用，已失效。需要时请重新发送「登录」。')).catch(() => {});
      }
    }, LOGIN_TTL_MS + 5_000);
  }

  /** Card in the private chat after the link was used. */
  async onLoginUsed(messageId: string, at: number): Promise<void> {
    await this.patch(messageId, infoCard('已登录网站', `这个链接已于 ${formatAtDefault(at)} 使用，不能再次使用。\n如果不是你本人操作，请立即发送「退出网站」。`));
  }

  private chatNameCache = new Map<string, string>();

  async chatName(chatId: string): Promise<string | undefined> {
    if (this.chatNameCache.has(chatId)) return this.chatNameCache.get(chatId);
    try {
      const r = await this.client.im.v1.chat.get({ path: { chat_id: chatId } }) as any;
      const n = r?.data?.name;
      if (n) this.chatNameCache.set(chatId, n);
      return n;
    } catch { return undefined; }
  }

  private scheduleList(caller: Caller): object {
    // Your own schedules (#4): in a group, those in this group; in the private chat, your private-chat ones.
    const rows = caller.chatType === 'p2p'
      ? this.store.schedulesByCreator(caller.unionId).filter(s => s.chatType === 'p2p')
      : this.store.schedulesInChat(caller.chatId).filter(s => s.creatorUnionId === caller.unionId);
    return this.scheduler.listCard(rows, caller.unionId, caller.chatType === 'p2p' ? '你的私聊' : '本群');
  }

  private async execute(cmd: CommandRow, raw: Record<string, string | undefined>, caller: Caller, viaForm = false): Promise<object> {
    try {
      const r = await runCommand(this.store, cmd, raw, caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }, { viaForm });
      if (!r.ok) return errorCard(cmd.name, `执行失败：${r.error}`, cmd.id);
      return resultCard(cmd.name, caller.openId, r.blocks, r.runId, r.elapsedMs, cmd.id, cmd.global && !!cmd.script.secrets?.length, await this.mentionsFor(caller.chatId, caller.chatType, r.blocks));
    } catch (e) {
      return errorCard(cmd.name, e instanceof AmberError ? e.message : `出错了：${(e as Error).message}`, cmd.id);
    }
  }

  private nameCache = new Map<string, string>();

  async nameOf(unionId: string): Promise<string | undefined> {
    if (this.nameCache.has(unionId)) return this.nameCache.get(unionId);
    try {
      const r = await this.client.contact.v3.user.get({ path: { user_id: unionId }, params: { user_id_type: 'union_id' } }) as any;
      const n = r?.data?.user?.name;
      if (n) this.nameCache.set(unionId, n);
      return n;
    } catch { return undefined; }
  }

  private cityCache = new Map<string, { city?: string; at: number }>();

  /** Office city from the Feishu directory, via Amber's own app. Needs the contact permission for city/work_station. */
  async cityOf(unionId: string): Promise<string | undefined> {
    const hit = this.cityCache.get(unionId);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.city;
    let city: string | undefined;
    try {
      const r = await this.client.contact.v3.user.get({ path: { user_id: unionId }, params: { user_id_type: 'union_id' } }) as any;
      const u = r?.data?.user ?? {};
      city = (u.city || u.work_station || '').trim() || undefined;
    } catch (e: any) {
      log('city lookup failed', e?.response?.data?.code ?? e?.message);
    }
    this.cityCache.set(unionId, { city, at: Date.now() });
    return city;
  }

  private async patch(messageId: string, card: object): Promise<void> {
    try {
      await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
    } catch (e: any) {
      log('patch failed', messageId, e?.response?.data ? JSON.stringify(e.response.data) : e?.message);
    }
  }

  private async onCardAction(d: any): Promise<object | undefined> {
    const op = d.operator ?? {};
    const value = d.action?.value ?? {};
    const chatId: string | undefined = d.context?.open_chat_id;
    const messageId: string | undefined = d.context?.open_message_id;
    if (!op.union_id || !chatId) return { toast: { type: 'error', content: '无法识别操作人' } };
    const key = `a:${d.event_id ?? ''}:${messageId}:${JSON.stringify(value)}:${op.union_id}`;
    if (d.event_id && !this.firstTime(key)) return undefined;
    const caller: Caller = { unionId: op.union_id, openId: op.open_id, chatId, chatType: await this.chatType(chatId), channel: 'bot' };
    log('card action', value.a, value.c ?? '', caller.chatType, chatId);
    const raw = (card: object) => ({ card: { type: 'raw', data: card } });
    try {
      if (value.a === 'claim_try') {
        // Trial runs can take longer than the callback window: answer now, patch the card when done.
        this.flow.checkClaimer(String(value.c), caller);
        setTimeout(async () => {
          let card: object;
          try { card = await this.flow.onClaimAction('claim_try', String(value.c), caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }, d.action?.form_value ?? {}); }
          catch (e) { card = errorCard('Amber', e instanceof AmberError ? e.message : '试运行出错'); }
          if (messageId) await this.patch(messageId, card);
        }, 300);
        return { toast: { type: 'info', content: '试运行中，结果会更新在这张卡片上' } };
      }
      if (value.a === 'claim_submit') {
        // Creating the review doc and the approval can outlast the callback window. Wait briefly so
        // refusals still come back as a toast; past that, answer now and patch the card when done.
        const work = this.flow.onClaimAction('claim_submit', String(value.c), caller, { city: () => this.cityOf(caller.unionId), signer: this.signer });
        let timer: NodeJS.Timeout | undefined;
        const late = new Promise<'late'>(r => { timer = setTimeout(() => r('late'), this.claimSubmitWaitMs); });
        const first = await Promise.race([work, late]).finally(() => clearTimeout(timer));
        if (first !== 'late') return raw(first);
        void work.then(
          async card => { if (messageId) await this.patch(messageId, card); },
          // The command is back to draft, so the claim card stays usable: leave it and reply instead.
          async e => { if (messageId) await this.replyCard(messageId, false, errorCard('提交审核失败', e instanceof AmberError ? e.message : '出错了')).catch(() => {}); },
        );
        return { toast: { type: 'info', content: '正在发起审批，结果会更新在这张卡片上' } };
      }
      if (typeof value.a === 'string' && value.a.startsWith('claim_')) {
        return raw(await this.flow.onClaimAction(value.a, String(value.c), caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }));
      }
      if (value.a === 'sec_form' || value.a === 'sec_save') {
        return await this.onSecretAction(value.a, String(value.c), caller, d.action?.form_value ?? {});
      }
      if (value.a === 'lst_ok' || value.a === 'lst_no') {
        return raw(await this.apps.onListingReview(value.a, String(value.l), String(d.action?.form_value?.reason ?? ''), caller));
      }
      if (value.a === 'review_ok' || value.a === 'review_no') {
        const reason = String(d.action?.form_value?.reason ?? '');
        return raw(await this.flow.onReviewAction(value.a, String(value.c), String(value.h), reason, caller));
      }
      if (value.a === 'exe_ok' || value.a === 'exe_no') {
        if (!this.isAdmin(caller.unionId)) return { toast: { type: 'error', content: '只有管理员可以批准执行端' } };
        const r = this.hub.decide(String(value.e), String(value.h), value.a === 'exe_ok', caller.unionId);
        log('executor decision', value.a, value.e, r.message);
        if (!r.ok || !r.row) return { toast: { type: 'error', content: r.message } };
        return raw(executorDecidedCard(r.row, (await this.nameOf(caller.unionId)) ?? '管理员'));
      }
      if (value.a === 'exe_rv') {
        if (!this.isAdmin(caller.unionId)) return { toast: { type: 'error', content: '只有管理员可以撤销执行端' } };
        const e = this.hub.revokeId(String(value.e), caller.unionId);
        if (!e) return { toast: { type: 'error', content: '这个执行端现在不是已批准状态' } };
        return raw(closedCard('执行端已撤销', 'grey', `「${e.name}」已撤销：不会再给它派任务。要恢复，需要在那台机器上重新生成密钥并再次批准。`));
      }
      if (value.a === 'req_ok' || value.a === 'req_no') {
        return raw(await this.agent.onClick(value.a === 'req_ok', String(value.r), caller, chatId, messageId));
      }
      if (value.a === 'rs_ok' || value.a === 'rs_no') return raw(await this.onReassignClick(value, caller));
      if (value.a === 'sch_rebind' || value.a === 'sch_drop') {
        const s = this.store.getSchedule(String(value.s));
        if (!s) throw new AmberError('not_found', '定时任务已不存在');
        if (value.a === 'sch_rebind') return raw(this.scheduler.rebind(s, String(value.c), caller));
        if (!this.scheduler.canManage(s, caller.unionId)) throw new AmberError('forbidden', '只有定时任务的创建人或管理员可以操作');
        this.scheduler.remove(s, caller.unionId);
        return raw(infoCard('定时任务已删除', `定时任务 ${s.id} 已删除。`));
      }
      // Cards from before #4: a schedule can no longer be taken over, only its creator can run the command.
      if (value.a === 'sch_takeover') return raw(closedCard('不能接手', 'grey', '应用只有创建人自己能执行，定时任务不能再由别人接手。需要的话，等这个应用上架后从 Amber Store 安装一份，再建自己的定时任务。'));
      if (typeof value.a === 'string' && value.a.startsWith('sch_')) {
        const s = this.store.getSchedule(String(value.s));
        if (!s) throw new AmberError('not_found', '定时任务已不存在');
        if (!this.scheduler.canManage(s, caller.unionId)) throw new AmberError('forbidden', '只有创建人或管理员可以操作');
        if (s.chatType === 'group' && s.chatId !== chatId) throw new AmberError('forbidden', '请在原来的群里操作');
        if (value.a === 'sch_pause') this.scheduler.pauseBy(s, caller.unionId, '手动暂停');
        else if (value.a === 'sch_resume') this.scheduler.resume(s, caller.unionId);
        else if (value.a === 'sch_del') this.scheduler.remove(s, caller.unionId);
        else if (value.a === 'sch_run') {
          // Running it now runs the creator's command: the creator only, not an admin (#4).
          if (s.creatorUnionId !== caller.unionId) throw new AmberError('forbidden', '只有定时任务的创建人可以立即运行');
          void this.scheduler.runOnce(s, true).catch(e => log('manual schedule run failed', (e as Error).message));
          return { toast: { type: 'info', content: '已开始运行，结果会发到原来的位置' } };
        }
        return raw(this.scheduleList(caller));
      }
      if (value.a === 'retire_ok' || value.a === 'retire_no') {
        if (String(value.u) !== caller.unionId) throw new AmberError('forbidden', '只有发起下线的人能确认');
        if (value.a === 'retire_no') return raw(closedCard('已取消下线', 'grey', '没有下线，应用照常可用。'));
        if (Date.now() - Number(value.t) > RETIRE_CONFIRM_MS) return raw(closedCard('确认已过期', 'grey', '这张确认卡已超过 5 分钟，没有下线。需要时请重新发送「下线 应用名」。'));
        const c = this.store.getCommand(String(value.c));
        if (!c || c.status !== 'active' || c.specHash !== String(value.h)) return raw(closedCard('没有下线', 'grey', '这个应用在确认前已经下线或换了新版本。需要时请重新发送「下线 应用名」。'));
        const r = await this.retire(c.id, caller, (await this.nameOf(caller.unionId)) ?? '创建人');
        return raw(infoCard('应用已下线', `「${r.name}」已下线，不能再执行。${r.schedules ? `它的 ${r.schedules} 个定时任务已暂停，并已通知创建人。` : ''}`));
      }
      if (value.a === 'list') return raw(listCard(visibleCommands(this.store, caller), this.scopeLabel(caller)));
      if (value.a === 'pick') return raw(formCard(findVisible(this.store, caller, String(value.c))));
      if (value.a === 'run') {
        const cmd = findVisible(this.store, caller, String(value.c));
        const form: Record<string, string> = d.action?.form_value ?? {};
        // Respond within the callback window, then patch the card when execution finishes.
        setTimeout(async () => {
          const final = await this.execute(cmd, form, caller, true);
          if (messageId) await this.patch(messageId, final);
        }, 300);
        return raw(runningCard(cmd.name, caller.openId));
      }
      return { toast: { type: 'warning', content: '未知操作' } };
    } catch (e) {
      // Keep the card as it is (others may still need it); tell only the clicker.
      log('card action rejected', value.a, e instanceof AmberError ? e.code : (e as Error).message);
      return { toast: { type: 'error', content: e instanceof AmberError ? e.message : '出错了' } };
    }
  }
}
