// Agent-facing operations (D33). People talk to their own agent; the agent calls Amber through the
// `amber` CLI. The API cannot tell which person is behind an agent (access is by machine IP only),
// so it never acts as a person:
//   1. lookups (commands, schedules, results) — answered directly;
//   2. commands that need no identity (no services, no confirm) — run directly as "agent@machine";
//   3. anything else (needs a person's identity, confirm, schedules) — Amber posts a confirmation
//      card in the chat; whoever clicks it is the identity, taken from the Feishu event.
import type { Store, CommandRow, RequestRow, RequestKind, ScopeType } from './db.ts';
import type { Caller, Block } from './engine.ts';
import { visibleCommands, findVisible, runCommand, validateArgs, AmberError, missingSecrets } from './engine.ts';
import type { Signer } from './identity.ts';
import { requestCard, runningCard, resultCard, errorCard, closedCard, person, sanitizeMarkdown, type Mentions } from './cards.ts';
import { parseRule, validateRule, nextRun, describeRule, formatAt, defaultTz } from './schedule-rule.ts';
import type { Scheduler } from './scheduler.ts';
import { MAX_PER_CHAT } from './scheduler.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

export interface Deps {
  send(to: { chatId?: string; unionId?: string; replyTo?: string; inThread?: boolean }, card: object): Promise<string | undefined>;
  patch(messageId: string, card: object): Promise<void>;
  resolveUser(email: string): Promise<{ unionId: string; openId?: string } | undefined>;
  cityOf(unionId: string): Promise<string | undefined>;
  isAdmin(unionId: string): boolean;
  /** undefined = cannot tell (missing permission). */
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  signer: Signer;
  /** Take a command offline (checks creator/admin, pauses its schedules). */
  retire(cmdId: string, actor: { unionId: string }, byLabel: string): Promise<{ name: string; schedules: number }>;
  nameOf(unionId: string): Promise<string | undefined>;
  /** Group members a real run's result may @ (#1); undefined in private chats, without `@` in the output, or when unknown. */
  mentionsFor(chatId: string, chatType: ScopeType, blocks: Block[]): Promise<Mentions | undefined>;
}

/** What the agent says about where it is. Nothing here is trusted as identity. */
export interface AgentContext {
  chatId: string;
  chatType: ScopeType;
  /** Email of the person the agent is working for: picks p2p commands and who may click. Not an identity. */
  user?: string;
  /** Message to reply under (a thread root), so cards land in the topic. */
  replyTo?: string;
  inThread?: boolean;
  /** Free-form agent name, shown after the machine name. */
  label?: string;
}

interface Ctx { chatId: string; chatType: ScopeType; user?: { unionId: string; openId?: string; email: string }; replyTo?: string; inThread: boolean; requestedBy: string; machine: string }

const REQUEST_TTL_MS = 24 * 3600_000;
const REQUESTS_PER_CHAT_10MIN = 10;

export function needsPerson(c: CommandRow): boolean {
  // Commands with secrets (D48) always need a person: an agent alone never gets to use them.
  return c.options.confirm || Object.keys(c.script.services ?? {}).length > 0 || !!c.script.secrets?.length;
}

/** Checks the given arguments before asking a person; values taken from the clicker (city) are filled in later. */
async function precheck(cmd: CommandRow, args: Record<string, string>): Promise<void> {
  await validateArgs(cmd.params.map(p => (p.defaultFrom ? { ...p, required: false } : p)), args);
  const missing = missingSecrets(cmd);
  if (missing.length) throw new AmberError('missing_secret', `还没设置密钥：${missing.join('、')}。请指令创建人或管理员先私聊 Amber 发「设置密钥 ${cmd.name}」`);
}

export class AgentGate {
  private store: Store;
  private deps: Deps;
  scheduler!: Scheduler;

  constructor(store: Store, deps: Deps) {
    this.store = store;
    this.deps = deps;
  }

  async context(raw: AgentContext, machine: string): Promise<Ctx> {
    if (!raw || !/^oc_[A-Za-z0-9]+$/.test(String(raw.chatId ?? ''))) throw new AmberError('bad_chat', 'chatId 格式不对（botmux 里是 $BOTMUX_CHAT_ID）');
    if (raw.chatType !== 'group' && raw.chatType !== 'p2p') throw new AmberError('bad_chat', 'chatType 只能是 group 或 p2p');
    let user: Ctx['user'];
    if (raw.user) {
      const email = String(raw.user).trim();
      const u = await this.deps.resolveUser(email);
      if (!u) throw new AmberError('user_unresolved', `找不到用户 ${email}`);
      user = { ...u, email };
    }
    if (raw.chatType === 'p2p' && !user) throw new AmberError('user_required', '私聊里需要用 --user 指明是谁（email）');
    const replyTo = raw.replyTo && /^om_[A-Za-z0-9]+$/.test(raw.replyTo) ? raw.replyTo : undefined;
    const label = typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim().slice(0, 40) : '';
    return { chatId: raw.chatId, chatType: raw.chatType, user, replyTo, inThread: !!(replyTo && raw.inThread), machine, requestedBy: label || '你的 agent' };
  }

  private viewer(ctx: Ctx): Caller {
    return { unionId: ctx.user?.unionId ?? '', chatId: ctx.chatId, chatType: ctx.chatType, channel: 'agent' };
  }

  private describe(c: CommandRow): object {
    return {
      id: c.id, name: c.name, description: c.description, global: c.global,
      params: c.params.map(p => ({ name: p.name, label: p.label, type: p.type, required: !!p.required, default: p.default, defaultFrom: p.defaultFrom, min: p.min, max: p.max, maxLength: p.maxLength, pattern: p.pattern })),
      options: c.options,
      // How `amber run` will behave for this command.
      run: needsPerson(c) ? 'confirm_card' : 'direct',
      // Names only; values are never exposed through the agent interface (D48).
      ...(c.script.secrets?.length ? { secrets: c.script.secrets, secretsMissing: missingSecrets(c) } : {}),
      ...(c.script.env ? { env: c.script.env } : {}),
    };
  }

  list(ctx: Ctx): object[] {
    return visibleCommands(this.store, this.viewer(ctx)).map(c => this.describe(c));
  }

  show(ctx: Ctx, name: string): object {
    return this.describe(findVisible(this.store, this.viewer(ctx), name));
  }

  /** Tier 2 runs directly; tier 3 posts a confirmation card and returns the request. */
  async run(ctx: Ctx, name: string, args: Record<string, string>): Promise<object> {
    const cmd = findVisible(this.store, this.viewer(ctx), name);
    const cleanArgs = this.cleanArgs(args);
    if (!needsPerson(cmd)) {
      const caller: Caller = { unionId: `agent:${ctx.machine}`, chatId: ctx.chatId, chatType: ctx.chatType, channel: 'agent' };
      // The claimed user only fills "default to the caller's city"; it grants nothing.
      const r = await runCommand(this.store, cmd, cleanArgs, caller, { city: ctx.user ? () => this.deps.cityOf(ctx.user!.unionId) : undefined, signer: this.deps.signer });
      this.store.audit(null, 'agent.run', { runId: r.runId, command: cmd.id, requestedBy: ctx.requestedBy, machine: ctx.machine, claimedUser: ctx.user?.email ?? null });
      return { mode: 'direct', runId: r.runId, status: r.ok ? 'ok' : 'failed', markdown: r.markdown, error: r.error, elapsedMs: r.elapsedMs };
    }
    // Check the arguments now, so the person is not asked to confirm something that cannot run.
    await precheck(cmd, cleanArgs);
    const req = await this.post(ctx, 'run', cmd, cleanArgs, {});
    return { mode: 'confirm_card', requestId: req.id, status: 'awaiting', message: `已在飞书发出确认卡片，等${ctx.user ? ` ${ctx.user.email} ` : '群里有人'}点「执行」。用 amber wait ${req.id} 查看是否完成；结果只显示在飞书卡片上，不返回给 agent。` };
  }

  async scheduleAdd(ctx: Ctx, name: string, args: Record<string, string>, at: string, tz?: string): Promise<object> {
    const cmd = findVisible(this.store, this.viewer(ctx), name);
    if (!cmd.options.schedulable) throw new AmberError('not_schedulable', `「${cmd.name}」审核时没有允许定时执行（options.schedulable）`);
    if (this.store.schedulesInChat(ctx.chatId).length >= MAX_PER_CHAT) throw new AmberError('too_many', `这里已有 ${MAX_PER_CHAT} 个定时任务`);
    const rule = parseRule(String(at ?? ''), tz || defaultTz());
    const cleanArgs = this.cleanArgs(args);
    await precheck(cmd, cleanArgs);
    const req = await this.post(ctx, 'schedule', cmd, cleanArgs, { rule });
    return { mode: 'confirm_card', requestId: req.id, status: 'awaiting', rule: describeRule(rule), firstRun: formatAt(nextRun(rule, Date.now()), rule.tz), message: `已在飞书发出确认卡片，点「创建定时任务」后生效。用 amber wait ${req.id} 查看结果。` };
  }

  schedules(ctx: Ctx): object[] {
    const rows = ctx.chatType === 'p2p' && ctx.user
      ? [...this.store.schedulesInChat(ctx.chatId), ...this.store.schedulesByCreator(ctx.user.unionId).filter(s => s.chatType === 'p2p' && s.chatId !== ctx.chatId)]
      : this.store.schedulesInChat(ctx.chatId);
    return rows.map(s => {
      const v = this.scheduler.view(s);
      return { id: v.id, command: v.command, rule: v.ruleText, status: v.status, pauseReason: v.pauseReason, nextRun: v.status === 'active' ? v.nextText : null, last: v.lastText, args: v.args };
    });
  }

  private scheduleInCtx(ctx: Ctx, id: string) {
    const s = this.store.getSchedule(id);
    if (!s || !(s.chatId === ctx.chatId || (ctx.chatType === 'p2p' && s.chatType === 'p2p' && ctx.user?.unionId === s.creatorUnionId))) throw new AmberError('not_found', `这里没有定时任务 ${id}`);
    return s;
  }

  /** Pausing only ever stops something, so the agent may do it directly. */
  schedulePause(ctx: Ctx, id: string): object {
    const s = this.scheduleInCtx(ctx, id);
    this.scheduler.pauseBy(s, `agent:${ctx.machine}`, `由 ${ctx.requestedBy} 暂停`);
    return { id: s.id, status: 'paused' };
  }

  /** Resume and delete change what runs under someone's name: the creator (or an admin) must click. */
  async scheduleChange(ctx: Ctx, id: string, kind: 'schedule_resume' | 'schedule_delete'): Promise<object> {
    const s = this.scheduleInCtx(ctx, id);
    const cmd = this.store.getCommand(s.commandId);
    if (!cmd) throw new AmberError('not_found', '指令不存在');
    const req = await this.post({ ...ctx, user: undefined }, kind, cmd, s.args, { rule: s.rule, scheduleId: s.id, target: s.creatorUnionId, targetOpenId: s.creatorOpenId ?? undefined, toCreatorDm: s.chatType === 'p2p' });
    return { mode: 'confirm_card', requestId: req.id, status: 'awaiting', message: '已发出确认卡片，需要定时任务的创建人（或管理员）点确认。' };
  }

  /**
   * Take a command offline, or change its scope (global / local). These change what everyone can run,
   * so — like schedule resume/delete — a person with the right (creator or admin for retire; admin for
   * scope) must click Amber's card. When the agent names the person, the permission is checked now, so
   * nobody is asked to confirm something they cannot do (D44).
   */
  async commandChange(ctx: Ctx, name: string, kind: 'retire' | 'scope_global' | 'scope_local'): Promise<object> {
    const cmd = findVisible(this.store, this.viewer(ctx), name);
    if (ctx.user) {
      const allowed = kind === 'retire'
        ? cmd.ownerUnionId === ctx.user.unionId || this.deps.isAdmin(ctx.user.unionId)
        : this.deps.isAdmin(ctx.user.unionId);
      if (!allowed) throw new AmberError('forbidden', kind === 'retire' ? '只有指令的创建人或管理员可以下线' : '只有管理员可以修改指令的执行范围');
    }
    if (kind === 'scope_global' && cmd.global) throw new AmberError('not_needed', `「${cmd.name}」已经是全局指令`);
    if (kind === 'scope_local' && !cmd.global) throw new AmberError('not_needed', `「${cmd.name}」本来就只在创建处可用`);
    if (kind === 'scope_global' && this.store.listActiveGlobal().some(g => g.name === cmd.name && g.id !== cmd.id)) throw new AmberError('conflict', `已经有一条全局指令叫「${cmd.name}」，不能重名`);
    const schedules = kind === 'retire' ? this.store.schedulesOfCommand(cmd.id).length : 0;
    const req = await this.post(ctx, kind, cmd, {}, { schedules });
    const who = kind === 'retire' ? '指令的创建人（或管理员）' : '管理员';
    return { mode: 'confirm_card', requestId: req.id, status: 'awaiting', message: `已发出确认卡片，需要${ctx.user ? ` ${ctx.user.email}（须是${who}）` : who}点确认。用 amber wait ${req.id} 查看结果。` };
  }

  private cleanArgs(args: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (args && typeof args === 'object') for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) out[k] = String(v).slice(0, 2000);
    return out;
  }

  private async post(ctx: Ctx, kind: RequestKind, cmd: CommandRow, args: Record<string, string>, o: { rule?: unknown; scheduleId?: string; target?: string; targetOpenId?: string; toCreatorDm?: boolean; schedules?: number }): Promise<RequestRow> {
    // Agents are not trusted: cap how many cards they can make Amber post into one chat.
    if (this.store.recentRequestsInChat(ctx.chatId, 10 * 60_000) >= REQUESTS_PER_CHAT_10MIN) throw new AmberError('rate_limited', '这个会话 10 分钟内的确认请求太多了，请稍后再试');
    const target = o.target ?? ctx.user?.unionId ?? null;
    const req = this.store.insertRequest({
      kind, commandId: cmd.id, specHash: cmd.specHash, chatId: ctx.chatId, chatType: ctx.chatType, targetUnionId: target,
      args, rule: o.rule ?? null, scheduleId: o.scheduleId ?? null, requestedBy: ctx.requestedBy, replyTo: ctx.replyTo ?? null, inThread: ctx.inThread,
    });
    const rule = o.rule ? validateRule(o.rule) : undefined;
    const card = requestCard({
      kind, reqId: req.id, cmd, args, requestedBy: ctx.requestedBy, targetOpenId: o.targetOpenId ?? ctx.user?.openId,
      ruleText: rule ? describeRule(rule) : undefined, nextText: rule ? formatAt(nextRun(rule, Date.now()), rule.tz) : undefined, scheduleId: o.scheduleId,
      schedules: o.schedules,
    });
    // p2p: Amber cannot post into the agent's private chat, so the card goes to the person's chat with Amber.
    const to = ctx.chatType === 'p2p' || o.toCreatorDm ? { unionId: target! } : ctx.replyTo ? { replyTo: ctx.replyTo, inThread: ctx.inThread } : { chatId: ctx.chatId };
    let messageId: string | undefined;
    try { messageId = await this.deps.send(to, card); } catch (e: any) {
      const code = e?.response?.data?.code;
      this.store.transitionRequest(req.id, 'awaiting', 'failed', { error: `card_failed ${code ?? ''}` });
      throw new AmberError('card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `确认卡片发送失败：${code ?? e?.message}`);
    }
    if (messageId) this.store.setRequestMessage(req.id, messageId);
    this.store.audit(null, 'request.create', { id: req.id, kind, command: cmd.id, chatId: ctx.chatId, requestedBy: ctx.requestedBy, machine: ctx.machine, target });
    log('request', req.id, kind, cmd.name, ctx.chatId, ctx.requestedBy);
    return { ...req, messageId: messageId ?? null };
  }

  private async onCommandChangeClick(ok: boolean, req: RequestRow, clicker: Caller, cardChatId: string): Promise<object> {
    const cmd = this.store.getCommand(req.commandId ?? '');
    if (!cmd) throw new AmberError('not_found', '指令不存在');
    const retire = req.kind === 'retire';
    const allowed = retire ? cmd.ownerUnionId === clicker.unionId || this.deps.isAdmin(clicker.unionId) : this.deps.isAdmin(clicker.unionId);
    if (!allowed) throw new AmberError('forbidden', retire ? '只有指令的创建人或管理员可以下线' : '只有管理员可以修改指令的执行范围');
    if (req.targetUnionId && req.targetUnionId !== clicker.unionId) throw new AmberError('forbidden', '这个请求是发给别人的，只有被请求人可以点');
    if (req.chatType === 'group' && cardChatId !== req.chatId) throw new AmberError('forbidden', '请在原来的群里操作');
    const actor = clicker.unionId;
    if (!ok) {
      if (!this.store.transitionRequest(req.id, 'awaiting', 'canceled', { actorUnionId: actor })) throw new AmberError('closed', '这个请求已经处理过了');
      this.store.audit(actor, 'request.cancel', { id: req.id });
      return closedCard('已取消', 'grey', `${person(clicker.openId)} 取消了这个请求（${req.id}），指令没有变化。`);
    }
    // Act only on the version the request was made for.
    if (cmd.status !== 'active' || cmd.specHash !== req.specHash) {
      this.store.transitionRequest(req.id, 'awaiting', 'failed', { error: 'command_changed' });
      return closedCard('没有执行', 'grey', `指令「${sanitizeMarkdown(cmd.name, 40)}」在请求之后已下线或换了新版本，请让 agent 重新发起。`);
    }
    if (!this.store.transitionRequest(req.id, 'awaiting', 'running', { actorUnionId: actor })) throw new AmberError('closed', '这个请求已经处理过了');
    try {
      if (retire) {
        const r = await this.deps.retire(cmd.id, { unionId: actor }, (await this.deps.nameOf(actor)) ?? '创建人');
        this.store.transitionRequest(req.id, 'running', 'done');
        return closedCard(`指令已下线：${cmd.name}`, 'grey', `「${sanitizeMarkdown(r.name, 40)}」已由 ${person(clicker.openId)} 下线，不能再执行。${r.schedules ? `它的 ${r.schedules} 个定时任务已暂停，并已通知创建人。` : ''}`);
      }
      const toGlobal = req.kind === 'scope_global';
      if (toGlobal && this.store.listActiveGlobal().some(g => g.name === cmd.name && g.id !== cmd.id)) throw new AmberError('conflict', `已经有一条全局指令叫「${cmd.name}」，不能重名`);
      this.store.setGlobal(cmd.id, toGlobal);
      this.store.audit(actor, toGlobal ? 'scope.promote' : 'scope.demote', { id: cmd.id, name: cmd.name, via: 'agent', request: req.id });
      log('scope', toGlobal ? 'promote' : 'demote', cmd.id, cmd.name, 'via agent');
      this.store.transitionRequest(req.id, 'running', 'done');
      return closedCard('执行范围已修改', 'green', toGlobal
        ? `「${sanitizeMarkdown(cmd.name, 40)}」已设为**全局**：Amber 所在的任何群和私聊都能使用。`
        : `「${sanitizeMarkdown(cmd.name, 40)}」已改回**只在创建处可用**。`);
    } catch (e) {
      this.store.transitionRequest(req.id, 'running', 'failed', { error: (e as Error).message });
      throw e;
    }
  }

  /** Status for `amber wait`; long-polls up to waitSec while the request is still open. */
  async requestStatus(id: string, waitSec: number): Promise<object> {
    const deadline = Date.now() + Math.min(Math.max(waitSec, 0), 50) * 1000;
    let r = this.store.getRequest(id);
    while (r && (r.status === 'awaiting' || r.status === 'running') && Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 1000));
      r = this.store.getRequest(id);
    }
    if (!r) {
      // Unknown ids are logged: repeated misses from one machine look like enumeration.
      log('request lookup miss', id.slice(0, 40));
      throw new AmberError('not_found', `没有请求 ${id}`);
    }
    if (r.status === 'awaiting' && Date.now() - r.createdAt > REQUEST_TTL_MS) {
      this.store.transitionRequest(r.id, 'awaiting', 'expired');
      r = this.store.getRequest(id)!;
    }
    const run = r.runId ? this.store.getRun(r.runId) : undefined;
    return {
      requestId: r.id, kind: r.kind, status: r.status, scheduleId: r.scheduleId, error: r.error,
      // The output of a confirmed run belongs to the person who clicked: it is shown on the card in
      // Feishu (and on the website), never handed back to the agent. Only the outcome is.
      ...(run ? { runStatus: run.status, resultIn: 'feishu_card' } : {}),
    };
  }


  /**
   * A person clicked 确认 / 取消 on a request card. Returns the card to show right away; long work
   * (running the command) patches the card afterwards.
   */
  async onClick(ok: boolean, reqId: string, clicker: Caller, cardChatId: string, messageId?: string): Promise<object> {
    const req = this.store.getRequest(reqId);
    if (!req) throw new AmberError('not_found', '请求不存在');
    if (req.status !== 'awaiting') throw new AmberError('closed', '这个请求已经处理过了');
    if (Date.now() - req.createdAt > REQUEST_TTL_MS) {
      this.store.transitionRequest(req.id, 'awaiting', 'expired');
      return closedCard('请求已过期', 'grey', '这个请求已超过 24 小时，请让 agent 重新发起。');
    }
    const s = req.scheduleId ? this.store.getSchedule(req.scheduleId) : undefined;
    if (req.kind === 'retire' || req.kind === 'scope_global' || req.kind === 'scope_local') return this.onCommandChangeClick(ok, req, clicker, cardChatId);
    // Who may click.
    if (req.kind === 'schedule_resume' || req.kind === 'schedule_delete') {
      if (!s) throw new AmberError('not_found', '定时任务已不存在');
      if (!this.scheduler.canManage(s, clicker.unionId)) throw new AmberError('forbidden', '只有定时任务的创建人或管理员可以操作');
    } else if (req.targetUnionId && req.targetUnionId !== clicker.unionId) {
      throw new AmberError('forbidden', '这个请求是发给别人的，只有被请求人可以点');
    }
    if (req.chatType === 'group' && !(req.kind === 'schedule_resume' || req.kind === 'schedule_delete') && cardChatId !== req.chatId) throw new AmberError('forbidden', '请在原来的群里操作');
    const actor = clicker.unionId;
    if (!ok) {
      if (!this.store.transitionRequest(req.id, 'awaiting', 'canceled', { actorUnionId: actor })) throw new AmberError('closed', '这个请求已经处理过了');
      this.store.audit(actor, 'request.cancel', { id: req.id });
      return closedCard('已取消', 'grey', `${person(clicker.openId)} 取消了这个请求（${req.id}）。`);
    }
    const cmd = this.store.getCommand(req.commandId ?? '');
    if (!cmd) throw new AmberError('not_found', '指令不存在');
    if (req.kind === 'schedule_resume' || req.kind === 'schedule_delete') {
      if (!this.store.transitionRequest(req.id, 'awaiting', 'running', { actorUnionId: actor })) throw new AmberError('closed', '这个请求已经处理过了');
      try {
        if (req.kind === 'schedule_resume') {
          const n = this.scheduler.resume(s!, actor);
          this.store.transitionRequest(req.id, 'running', 'done');
          return closedCard(`定时任务已恢复：${cmd.name}`, 'green', `${describeRule(n.rule)} · 下次 ${formatAt(n.nextRunAt, n.rule.tz)} · 任务 ${n.id}`);
        }
        this.scheduler.remove(s!, actor);
        this.store.transitionRequest(req.id, 'running', 'done');
        return closedCard(`定时任务已删除：${cmd.name}`, 'grey', `任务 ${s!.id} 已由 ${person(clicker.openId)} 删除。`);
      } catch (e) {
        this.store.transitionRequest(req.id, 'running', 'failed', { error: (e as Error).message });
        throw e;
      }
    }
    // run / schedule: the command must still be the version the request was made for.
    if (cmd.status !== 'active' || cmd.specHash !== req.specHash) {
      this.store.transitionRequest(req.id, 'awaiting', 'failed', { error: 'command_changed' });
      return closedCard('无法执行', 'red', `指令「${sanitizeMarkdown(cmd.name, 40)}」在请求之后已变更或下线，请让 agent 重新发起。`);
    }
    const caller: Caller = { ...clicker, chatId: req.chatId, chatType: req.chatType, channel: 'agent' };
    findVisible(this.store, caller, cmd.id);
    if (!this.store.transitionRequest(req.id, 'awaiting', 'running', { actorUnionId: actor })) throw new AmberError('closed', '这个请求已经处理过了');
    if (req.kind === 'schedule') {
      try {
        const sch = await this.scheduler.createFromRequest(req, caller);
        this.store.transitionRequest(req.id, 'running', 'done', { scheduleId: sch.id });
        return closedCard(`定时任务已创建：${cmd.name}`, 'green',
          `${describeRule(sch.rule)}，以 ${person(clicker.openId)} 的身份执行。\n首次运行：${formatAt(sch.nextRunAt, sch.rule.tz)}\n<font color="grey">任务 ${sch.id} · 在这里 @Amber 发「定时任务」可以查看、暂停或删除</font>`);
      } catch (e) {
        this.store.transitionRequest(req.id, 'running', 'failed', { error: (e as Error).message });
        throw e;
      }
    }
    // Running can outlast the callback window: answer with "running", patch when done.
    setTimeout(async () => {
      let card: object;
      try {
        const r = await runCommand(this.store, cmd, req.args, caller, { city: () => this.deps.cityOf(clicker.unionId), signer: this.deps.signer }, { viaForm: true });
        this.store.transitionRequest(req.id, 'running', r.ok ? 'done' : 'failed', { runId: r.runId, error: r.error });
        card = r.ok ? resultCard(cmd.name, clicker.openId, r.blocks, r.runId, r.elapsedMs, cmd.id, cmd.scopeType !== 'p2p' && !!cmd.script.secrets?.length, await this.deps.mentionsFor(caller.chatId, caller.chatType, r.blocks)) : errorCard(cmd.name, `执行失败：${r.error}`);
      } catch (e) {
        this.store.transitionRequest(req.id, 'running', 'failed', { error: (e as Error).message });
        card = errorCard(cmd.name, e instanceof AmberError ? e.message : `出错了：${(e as Error).message}`);
      }
      if (messageId) await this.deps.patch(messageId, card);
    }, 300);
    return runningCard(cmd.name, clicker.openId);
  }
}
