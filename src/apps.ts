// Amber Store (#4). A command that is live can be listed: reviewers approve the listing once, and then anyone can
// install their own copy of it into a group they are in, or into their private chat with Amber, without another
// approval. An installation is an ordinary command owned by the installer, on a line of its own, so its secrets,
// configuration and schedules are the installer's. The command it was listed from is the app's original.
import { randomUUID } from 'node:crypto';
import type { Store, CommandRow, AppRow, ListingRow } from './db.ts';
import { computeSpecHash } from './db.ts';
import type { Flow } from './flow.ts';
import { specSummary, codePanels } from './flow.ts';
import { AmberError, visibleCommands, runParams, configParams } from './engine.ts';
import { sanitizeMarkdown, person, buttonRow } from './cards.ts';
import { describeServices } from './runner.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

export interface AppDeps {
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  isAdmin(unionId: string): boolean;
  nameOf(unionId: string): Promise<string | undefined>;
  openIdOf(unionId: string): Promise<string | undefined>;
}

type Who = { unionId: string; openId?: string };

const shell = (title: string, template: string, elements: unknown[]) => ({ schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template }, body: { elements } });
const btn = (text: string, value: Record<string, string>, type = 'default', extra: Record<string, unknown> = {}) => ({ tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }], ...extra });

/** Without a Feishu approval configured, reviewers approve a listing on a card (like a command review). */
export function listingReviewCard(c: CommandRow, l: ListingRow, ownerOpenId: string | undefined, state: { approved: number; total: number; mine?: 'approve' | 'reject' }): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `**申请上架到 Amber Store**：上架后其他人可以安装自己的一份（自己的配置项和密钥，以自己的身份执行），安装不再审批。需要 **全部 ${state.total} 位**审核人通过，目前已通过 ${state.approved} 位。\n请额外检查：代码里有没有写死只适用于某个群或某个人的内容，这些应该改成配置项。` },
    { tag: 'markdown', content: specSummary(c) },
    ...codePanels(c),
    { tag: 'markdown', content: `**创建人**：${person(ownerOpenId)}　**spec**：\`${c.specHash.slice(0, 12)}\`` },
  ];
  if (state.mine) els.push({ tag: 'markdown', content: state.mine === 'approve' ? '✅ 你已通过' : '❌ 你已驳回' });
  else els.push({
    tag: 'form', name: 'review', elements: [
      { tag: 'input', name: 'reason', label: { tag: 'plain_text', content: '驳回原因' }, label_position: 'left', placeholder: { tag: 'plain_text', content: '驳回时填写' } },
      buttonRow([
        btn('通过', { a: 'lst_ok', l: l.id }, 'primary', { form_action_type: 'submit', name: 'ok' }),
        btn('驳回', { a: 'lst_no', l: l.id }, 'danger', { form_action_type: 'submit', name: 'no' }),
      ]),
    ],
  });
  return shell(`上架审核：${c.name}`, 'purple', els);
}

export const INSTALL_NAME_MAX = 40;

export class AppStore {
  private store: Store;
  private flow: Flow;
  private deps: AppDeps;

  constructor(store: Store, flow: Flow, deps: AppDeps) {
    this.store = store;
    this.flow = flow;
    this.deps = deps;
  }

  /** The app a command was listed from (its original), if any. */
  appOfOriginal(c: CommandRow): AppRow | undefined { return this.store.appByOrigin(c.chatId, c.line); }

  /** Why this command cannot be listed by this person right now; undefined when it can. */
  whyNotListable(c: CommandRow, who: string): string | undefined {
    if (c.status !== 'active') return '指令未生效';
    if (c.ownerUnionId !== who) return '只有指令的创建人可以申请上架';
    if (this.store.installOf(c.id)) return '这是从 Amber Store 安装的指令，不能再上架';
    if (c.script.env) return '在执行端环境里运行的指令（写了 env）暂时不能上架：环境绑定在某台机器、某个机器人上，装到别处用不了';
    if (this.appOfOriginal(c)) return '已经上架了';
    if (this.store.pendingListingFor(c.id)) return '上架申请正在审核中';
    return undefined;
  }

  /** The creator asks to list a live command: reviewers approve it once, in Feishu approval (or on cards). */
  async requestListing(cmdId: string, who: Who): Promise<{ listingId: string; docUrl?: string }> {
    const c = this.store.getCommand(cmdId);
    if (!c) throw new AmberError('not_found', '没有找到这条指令');
    const why = this.whyNotListable(c, who.unionId);
    if (why) throw new AmberError('not_listable', why);
    if (computeSpecHash(c) !== c.specHash) throw new AmberError('spec_mismatch', '指令定义与审核通过的版本不一致');
    if (this.flow.reviewers.length === 0) throw new AmberError('no_reviewers', '审核人名单未配置或无法解析，暂时不能上架');
    const l = this.store.insertListing({ commandId: c.id, specHash: c.specHash, requestedBy: who.unionId });
    this.store.audit(who.unionId, 'app.listing_request', { listingId: l.id, commandId: c.id, name: c.name, specHash: c.specHash });
    const review = this.flow.review;
    if (review?.enabled) {
      const openId = who.openId ?? await this.deps.openIdOf(who.unionId);
      if (!openId) { this.store.updateListing(l.id, { status: 'canceled', reason: 'no_open_id' }); throw new AmberError('no_open_id', '无法识别申请人'); }
      if (this.flow.reviewerOpenIds.length !== this.flow.reviewers.length) { this.store.updateListing(l.id, { status: 'canceled', reason: 'reviewers' }); throw new AmberError('no_reviewers', '审核人名单无法解析成飞书账号，暂时不能上架'); }
      const creator = (await this.deps.nameOf(who.unionId)) ?? '创建人';
      try {
        const doc = await review.createDoc(c, { creator, listing: true });
        const instance = await review.startApproval(c, openId, this.flow.reviewerOpenIds, doc.url, creator, undefined, true);
        this.store.updateListing(l.id, { approvalInstance: instance, docUrl: doc.url, docId: doc.docId });
        log('listing approval started', c.id, instance);
        return { listingId: l.id, docUrl: doc.url };
      } catch (e) {
        this.store.updateListing(l.id, { status: 'canceled', reason: 'approval_failed' });
        throw new AmberError('feishu_review_failed', `发起飞书审批失败：${(e as Error).message.slice(0, 200)}`);
      }
    }
    const ownerOpenId = await this.deps.openIdOf(c.ownerUnionId);
    for (const r of this.flow.reviewers) {
      try { await this.flow.send({ unionId: r }, listingReviewCard(c, l, ownerOpenId, { approved: 0, total: this.flow.reviewers.length })); }
      catch (e: any) { log('listing review card failed', r.slice(0, 8), e?.response?.data?.code ?? e?.message); }
    }
    return { listingId: l.id };
  }

  /** Feishu approval result for a listing. Returns false when the instance is not a listing. */
  async onApprovalEvent(instance: string): Promise<boolean> {
    const l = this.store.listingByInstance(instance);
    if (!l) return false;
    const review = this.flow.review;
    if (l.status !== 'pending' || !review?.enabled) return true;
    const inst = await review.getInstance(instance);
    if (inst.approvalCode !== review.cfg.approval!.code) { log('listing approval code mismatch', instance); return true; }
    const note = async (md: string) => { if (l.docId) await review.appendMarkdown(l.docId, md).catch(e => log('doc append failed', (e as Error).message)); };
    if (inst.status === 'APPROVED') {
      const approved = new Set(inst.tasks.filter(t => t.status === 'APPROVED').map(t => t.openId));
      const all = this.flow.reviewerOpenIds.length > 0 && this.flow.reviewerOpenIds.every(o => approved.has(o));
      if (!all) { log('listing approved but not by all reviewers', l.id); this.store.audit(null, 'app.listing_check_failed', { listingId: l.id, instance }); return true; }
      await this.approve(l, 'feishu_approval');
      await note(`**${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC：飞书审批通过，已上架到 Amber Store。**`);
    } else if (['REJECTED', 'CANCELED', 'DELETED'].includes(inst.status)) {
      const why = inst.status === 'REJECTED' ? `审核人驳回${inst.comments.length ? `：${inst.comments.join('；')}` : ''}` : '审批已撤回';
      await this.reject(l, why);
      await note(`**${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC：${why}，没有上架。**`);
    }
    return true;
  }

  /** Card review of a listing (no Feishu approval configured): all reviewers must approve; one rejection ends it. */
  async onListingReview(action: string, listingId: string, reason: string, who: Who): Promise<object> {
    if (!this.flow.reviewers.includes(who.unionId)) throw new AmberError('not_reviewer', '你不在审核人名单里');
    const l = this.store.getListing(listingId);
    const c = l ? this.store.getCommand(l.commandId) : undefined;
    if (!l || !c) throw new AmberError('not_found', '上架申请不存在');
    if (l.status !== 'pending') return shell(`上架审核：${c.name}`, 'grey', [{ tag: 'markdown', content: '这张审核卡已失效（已上架、被驳回或已撤回）。' }]);
    const ownerOpenId = await this.deps.openIdOf(c.ownerUnionId);
    if (action === 'lst_no') {
      if (!reason.trim()) throw new AmberError('reason_required', '驳回请填写原因');
      this.store.audit(who.unionId, 'app.listing_reject', { listingId: l.id, reason: reason.trim() });
      await this.reject(l, `审核人驳回：${reason.trim()}`);
      return listingReviewCard(c, l, ownerOpenId, { approved: l.approvedBy.length, total: this.flow.reviewers.length, mine: 'reject' });
    }
    const approvedBy = [...new Set([...l.approvedBy, who.unionId])].filter(u => this.flow.reviewers.includes(u));
    this.store.updateListing(l.id, { approvedBy });
    this.store.audit(who.unionId, 'app.listing_approve', { listingId: l.id });
    if (this.flow.reviewers.every(r => approvedBy.includes(r))) await this.approve(this.store.getListing(l.id)!, 'card_review');
    return listingReviewCard(c, l, ownerOpenId, { approved: approvedBy.length, total: this.flow.reviewers.length, mine: 'approve' });
  }

  private async approve(l: ListingRow, via: string): Promise<void> {
    const c = this.store.getCommand(l.commandId);
    // The listed version must still be the live one.
    if (!c || c.status !== 'active' || c.specHash !== l.specHash || computeSpecHash(c) !== c.specHash) {
      await this.reject(l, '审核期间这条指令已更新或下线，没有上架；需要的话请重新申请');
      return;
    }
    if (this.appOfOriginal(c)) { this.store.updateListing(l.id, { status: 'canceled', reason: 'already_listed' }); return; }
    if (!this.store.updateListing(l.id, { status: 'approved' })) return;
    const app = this.store.insertApp({ id: randomUUID().slice(0, 8), name: c.name, description: c.description, maintainerUnionId: c.ownerUnionId, originChatId: c.chatId, originLine: c.line, status: 'listed' });
    const version = this.store.addAppVersion(app.id, c.id, c.specHash, l.docUrl);
    this.store.audit(null, 'app.listed', { appId: app.id, listingId: l.id, commandId: c.id, version, via });
    try { await this.flow.send({ unionId: c.ownerUnionId }, shell(`已上架：${c.name}`, 'green', [{ tag: 'markdown', content: `「${sanitizeMarkdown(c.name, 40)}」已通过上架审核，现在出现在 Amber Store 里，别人可以在网站上安装自己的一份。你的这条指令照常使用，标「已上架」；以后它审核通过的新版本，会成为 Store 里的新版本。` }])); }
    catch (e) { log('listed notice failed', (e as Error).message); }
  }

  private async reject(l: ListingRow, why: string): Promise<void> {
    if (!this.store.updateListing(l.id, { status: 'rejected', reason: why })) return;
    const c = this.store.getCommand(l.commandId);
    this.store.audit(null, 'app.listing_rejected', { listingId: l.id, reason: why });
    if (c) try { await this.flow.send({ unionId: l.requestedBy }, shell(`没有上架：${c.name}`, 'red', [{ tag: 'markdown', content: sanitizeMarkdown(why, 500) }])); }
    catch (e) { log('listing reject notice failed', (e as Error).message); }
  }

  /** The newest version of an app, with the command row holding its reviewed spec. */
  latest(app: AppRow): { version: number; cmd: CommandRow; docUrl: string | null } {
    const v = this.store.appVersions(app.id)[0];
    const cmd = v ? this.store.getCommand(v.commandId) : undefined;
    if (!v || !cmd || cmd.specHash !== v.specHash || computeSpecHash(cmd) !== v.specHash) throw new AmberError('app_broken', '这个应用的版本记录不完整，暂时不能安装');
    return { version: v.version, cmd, docUrl: v.docUrl };
  }

  /** Install an app: a new command in the target chat, owned by the installer, live at once (the code was reviewed
   *  when it was listed). `target`: 'p2p' (the installer's private chat with Amber) or 'group:<chat_id>'. */
  async install(appId: string, who: Who, target: string, name?: string): Promise<CommandRow> {
    const app = this.store.getApp(appId);
    if (!app || app.status !== 'listed') throw new AmberError('not_found', '没有这个应用，或它已经下架');
    const { version, cmd: src } = this.latest(app);
    const n = (name ?? app.name).trim();
    if (!n || n.length > INSTALL_NAME_MAX || /\s/.test(n)) throw new AmberError('bad_name', '名称不能为空、不能有空格、最多 40 个字');
    let chatId: string, scopeType: 'group' | 'p2p';
    if (target === 'p2p') { chatId = `p2p:${who.unionId}`; scopeType = 'p2p'; }
    else {
      const m = /^group:(oc_[A-Za-z0-9]+)$/.exec(target);
      if (!m) throw new AmberError('bad_target', '安装位置不对');
      const member = await this.deps.isMember(m[1], who.unionId);
      if (member !== true) throw new AmberError('forbidden', member === undefined ? 'Amber 暂时无法确认你是否在这个群里' : '只能装到你所在的群');
      chatId = m[1]; scopeType = 'group';
    }
    // Names must stay unique among what this person sees there (their own commands and global ones).
    const seen = visibleCommands(this.store, { unionId: who.unionId, chatId, chatType: scopeType, channel: 'web' });
    if (seen.some(c => c.name === n)) throw new AmberError('name_taken', `你在这里已经有一条叫「${n}」的指令，请换个名字`);
    const row = this.store.insertCommand({
      scopeType, chatId, ownerUnionId: who.unionId, name: n, description: src.description,
      params: src.params, script: src.script, options: src.options, status: 'active', line: `${n}#${randomUUID().slice(0, 8)}`,
    });
    this.store.setMeta(row.id, { ownerOpenId: who.openId ?? null });
    this.store.setInstall(row.id, app.id, version);
    this.store.audit(who.unionId, 'app.install', { appId: app.id, version, commandId: row.id, chatId, name: n });
    return this.store.getCommand(row.id)!;
  }

  /** No new installations; existing ones keep working. The maintainer or an admin. */
  delist(appId: string, actor: string): AppRow {
    const app = this.store.getApp(appId);
    if (!app) throw new AmberError('not_found', '没有这个应用');
    if (app.maintainerUnionId !== actor && !this.deps.isAdmin(actor)) throw new AmberError('forbidden', '只有应用的维护人或管理员可以下架');
    if (app.status === 'delisted') throw new AmberError('not_needed', '已经下架了');
    this.store.setAppStatus(app.id, 'delisted');
    this.store.audit(actor, 'app.delist', { appId: app.id });
    return this.store.getApp(app.id)!;
  }

  /** What the Store page shows about an app. */
  async view(app: AppRow, viewer: string): Promise<object> {
    let latest: ReturnType<AppStore['latest']> | undefined;
    try { latest = this.latest(app); } catch { /* shown as unavailable */ }
    const c = latest?.cmd;
    const s = c?.script;
    return {
      id: app.id, name: app.name, description: app.description, status: app.status,
      maintainer: (await this.deps.nameOf(app.maintainerUnionId)) ?? '', mine: app.maintainerUnionId === viewer,
      canDelist: app.status === 'listed' && (app.maintainerUnionId === viewer || this.deps.isAdmin(viewer)),
      version: latest?.version ?? null, docUrl: latest?.docUrl ?? null, updatedAt: app.updatedAt,
      params: c ? runParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required })) : [],
      config: c ? configParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, required: !!p.required, default: p.default ?? null })) : [],
      secrets: s?.secrets ?? [],
      network: !!s?.network, services: s?.services ? describeServices(s) : '',
      options: c?.options ?? null,
      installs: app.maintainerUnionId === viewer || this.deps.isAdmin(viewer) ? this.store.installsOf(app.id).length : undefined,
    };
  }

  /** The code of an app's newest version (anyone may read what they would install). */
  source(app: AppRow): object {
    const { cmd, version, docUrl } = this.latest(app);
    return { name: app.name, version, specHash: cmd.specHash, docUrl, code: cmd.script.code, lang: cmd.script.lang, timeoutMs: cmd.script.timeoutMs ?? 30000, params: cmd.params, options: cmd.options };
  }
}
