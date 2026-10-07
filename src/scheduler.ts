// Schedules (D32). A schedule is created only by a person's click on a confirmation card, and runs
// as that person. It is bound to the exact reviewed version (spec hash): if the command is retired
// or changes, the schedule pauses instead of running something nobody approved for it.
import type { Store, ScheduleRow, RequestRow, CommandRow } from './db.ts';
import { computeSpecHash } from './db.ts';
import type { Caller } from './engine.ts';
import { findVisible, runCommand, validateArgs, AmberError } from './engine.ts';
import { validateRule, nextRun, describeRule, formatAt } from './schedule-rule.ts';
import type { Rule } from './schedule-rule.ts';
import { scheduleResultCard, errorCard, scheduleListCard } from './cards.ts';
import type { ScheduleView } from './cards.ts';
import type { Deps } from './agent.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

const TICK_MS = 30_000;
/** A run more than this late (Amber was down) is skipped, not caught up (D32). */
const LATE_MS = 2 * 60_000;
const MAX_CONCURRENT = 2;
const MAX_FAILS = 3;
export const MAX_PER_CHAT = 20;

export class Scheduler {
  private store: Store;
  private deps: Deps;
  private running = new Set<string>();
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(store: Store, deps: Deps) {
    this.store = store;
    this.deps = deps;
  }

  start(): void {
    const tick = () => { this.tick().catch(e => log('scheduler tick failed', (e as Error).message)); };
    tick();
    setInterval(tick, TICK_MS);
    log('scheduler started');
  }

  private async slot<T>(f: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT) await new Promise<void>(r => this.queue.push(r));
    this.active++;
    try { return await f(); } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }

  async tick(now = Date.now()): Promise<void> {
    for (const s of this.store.dueSchedules(now)) {
      // Advance first: a crash mid-run must not make the same slot run twice.
      const next = nextRun(s.rule, now);
      this.store.updateSchedule(s.id, { nextRunAt: next });
      if (now - s.nextRunAt > LATE_MS) {
        this.store.updateSchedule(s.id, { lastStatus: 'missed', lastRunAt: s.nextRunAt });
        this.store.audit(null, 'schedule.missed', { id: s.id, due: s.nextRunAt });
        log('schedule missed', s.id, new Date(s.nextRunAt).toISOString());
        continue;
      }
      if (this.running.has(s.id)) {
        this.store.updateSchedule(s.id, { lastStatus: 'skipped_overlap' });
        continue;
      }
      void this.slot(() => this.runOnce(s, false));
    }
  }

  private pause(s: ScheduleRow, reason: string): void {
    this.store.updateSchedule(s.id, { status: 'paused', pauseReason: reason });
    this.store.audit(null, 'schedule.pause', { id: s.id, reason });
    log('schedule paused', s.id, reason);
  }

  private async notifyCreator(s: ScheduleRow, title: string, message: string): Promise<void> {
    try { await this.deps.send({ unionId: s.creatorUnionId }, errorCard(title, message)); }
    catch (e: any) { log('notify creator failed', s.id, e?.response?.data?.code ?? e?.message); }
  }

  /** One execution. `manual` = 「立即运行」 from the list card (same rules, same identity). */
  async runOnce(s: ScheduleRow, manual: boolean): Promise<void> {
    this.running.add(s.id);
    try {
      const cmd = this.store.getCommand(s.commandId);
      const name = cmd?.name ?? s.commandId;
      const ruleText = describeRule(s.rule);
      // The command must still be the reviewed version this schedule was confirmed for.
      if (!cmd || cmd.status !== 'active' || cmd.specHash !== s.specHash || !cmd.options.schedulable) {
        const why = !cmd || cmd.status !== 'active' ? '指令已下线' : !cmd.options.schedulable ? '指令不再允许定时执行' : '指令已更新为新版本，需要重新确认';
        this.pause(s, why);
        await this.notifyCreator(s, `定时任务已暂停：${name}`, `${why}。定时任务 ${s.id}（${ruleText}）已暂停，没有执行。如需继续，请让 agent 用新版本重新创建。`);
        return;
      }
      const caller: Caller = { unionId: s.creatorUnionId, openId: s.creatorOpenId ?? undefined, chatId: s.chatId, chatType: s.chatType, channel: 'schedule' };
      try { findVisible(this.store, caller, cmd.id); } catch {
        this.pause(s, '指令在这里已不可用');
        await this.notifyCreator(s, `定时任务已暂停：${name}`, `指令「${name}」在原来的会话里已不可用（可能被取消了全局），定时任务 ${s.id} 已暂停。`);
        return;
      }
      if (s.chatType === 'group') {
        const member = await this.deps.isMember(s.chatId, s.creatorUnionId);
        if (member === false) {
          this.pause(s, '创建人已不在群里');
          await this.notifyCreator(s, `定时任务已暂停：${name}`, `你已不在这个群里，定时任务 ${s.id}（${ruleText}）已暂停。`);
          return;
        }
      }
      let r;
      try {
        r = await runCommand(this.store, cmd, s.args, caller, { city: () => this.deps.cityOf(s.creatorUnionId), signer: this.deps.signer }, { viaForm: true });
      } catch (e) {
        r = { ok: false, error: e instanceof AmberError ? e.message : (e as Error).message, runId: '', blocks: [], markdown: '', elapsedMs: 0, args: {} };
      }
      if (r.runId) this.store.setRunSchedule(r.runId, s.id);
      if (!r.ok) {
        const fails = s.failCount + 1;
        this.store.updateSchedule(s.id, { lastRunId: r.runId || null, lastRunAt: Date.now(), lastStatus: 'failed', failCount: fails });
        const stop = fails >= MAX_FAILS && !manual;
        if (stop) this.pause(s, `连续失败 ${fails} 次`);
        await this.notifyCreator(s, `定时任务失败：${name}`, `定时任务 ${s.id}（${ruleText}）执行失败：${r.error}${stop ? `\n\n已连续失败 ${fails} 次，任务已暂停。` : ''}`);
        return;
      }
      this.store.updateSchedule(s.id, { lastRunId: r.runId, lastRunAt: Date.now(), lastStatus: r.markdown.trim() ? 'ok' : 'ok_silent', failCount: 0 });
      // No output = nothing to say (monitoring scripts print only when something is wrong).
      if (!r.markdown.trim()) return;
      const card = scheduleResultCard(name, s.creatorOpenId ?? undefined, r.blocks, r.runId, r.elapsedMs, s.id, ruleText);
      try {
        await this.deps.send(s.chatType === 'p2p' ? { unionId: s.creatorUnionId } : s.replyTo ? { replyTo: s.replyTo, inThread: s.inThread } : { chatId: s.chatId }, card);
      } catch (e: any) {
        log('schedule result delivery failed', s.id, e?.response?.data?.code ?? e?.message);
        this.store.updateSchedule(s.id, { lastStatus: 'delivery_failed' });
      }
    } finally {
      this.running.delete(s.id);
    }
  }

  /** Called when a person confirms a "schedule" request. The clicker becomes the creator. */
  async createFromRequest(req: RequestRow, clicker: Caller): Promise<ScheduleRow> {
    const cmd = this.store.getCommand(req.commandId ?? '');
    if (!cmd || cmd.status !== 'active' || cmd.specHash !== req.specHash) throw new AmberError('changed', '指令在请求之后已变更或下线，请让 agent 重新发起');
    return this.create({ cmd, chatId: req.chatId, chatType: req.chatType, replyTo: req.replyTo, inThread: req.inThread, creator: clicker,
      args: req.args, rule: req.rule, requestedBy: req.requestedBy, via: { requestId: req.id } });
  }

  /** Creates a schedule for `creator` (a person identified by Feishu: a card click or a website session). */
  async create(o: { cmd: CommandRow; chatId: string; chatType: 'group' | 'p2p'; replyTo: string | null; inThread: boolean; creator: Caller; args: Record<string, string>; rule: unknown; requestedBy: string; via: Record<string, unknown> }): Promise<ScheduleRow> {
    const { cmd, creator } = o;
    if (cmd.status !== 'active' || computeSpecHash(cmd) !== cmd.specHash) throw new AmberError('changed', '指令未生效或与审核版本不一致');
    if (!cmd.options.schedulable) throw new AmberError('not_schedulable', '这条指令审核时没有允许定时执行');
    findVisible(this.store, { ...creator, chatId: o.chatId, chatType: o.chatType }, cmd.id);
    if (this.store.schedulesInChat(o.chatId).length >= MAX_PER_CHAT) throw new AmberError('too_many', `这里已有 ${MAX_PER_CHAT} 个定时任务，请先删除一些`);
    const rule = validateRule(o.rule);
    // Validate now with the creator's facts; the stored args are what every run will use.
    await validateArgs(cmd.params, o.args, { city: () => this.deps.cityOf(creator.unionId) });
    const s = this.store.insertSchedule({
      commandId: cmd.id, specHash: cmd.specHash, chatId: o.chatId, chatType: o.chatType, replyTo: o.replyTo, inThread: o.inThread,
      creatorUnionId: creator.unionId, creatorOpenId: creator.openId ?? null, args: o.args, rule, nextRunAt: nextRun(rule, Date.now()), requestedBy: o.requestedBy,
    });
    this.store.audit(creator.unionId, 'schedule.create', { id: s.id, commandId: cmd.id, specHash: cmd.specHash, rule, args: o.args, ...o.via });
    log('schedule created', s.id, cmd.name, describeRule(rule));
    return s;
  }

  canManage(s: ScheduleRow, unionId: string): boolean {
    return s.creatorUnionId === unionId || this.deps.isAdmin(unionId);
  }

  resume(s: ScheduleRow, actor: string): ScheduleRow {
    const cmd = this.store.getCommand(s.commandId);
    if (!cmd || cmd.status !== 'active' || cmd.specHash !== s.specHash) throw new AmberError('changed', '指令已下线或已更新，不能恢复；请让 agent 用新版本重新创建');
    this.store.updateSchedule(s.id, { status: 'active', pauseReason: null, failCount: 0, nextRunAt: nextRun(s.rule, Date.now()) });
    this.store.audit(actor, 'schedule.resume', { id: s.id });
    return this.store.getSchedule(s.id)!;
  }

  remove(s: ScheduleRow, actor: string): void {
    this.store.updateSchedule(s.id, { status: 'deleted' });
    this.store.audit(actor, 'schedule.delete', { id: s.id });
  }

  pauseBy(s: ScheduleRow, actor: string, reason: string): void {
    this.store.updateSchedule(s.id, { status: 'paused', pauseReason: reason });
    this.store.audit(actor, 'schedule.pause', { id: s.id, reason });
  }

  view(s: ScheduleRow, viewer?: string): ScheduleView & { command: string; args: Record<string, string>; rule: Rule; nextRunAt: number; lastStatus: string | null; lastRunId: string | null } {
    const cmd = this.store.getCommand(s.commandId);
    const last = s.lastRunAt ? `上次 ${formatAt(s.lastRunAt, s.rule.tz)} ${({ ok: '成功', ok_silent: '成功（无输出）', failed: '失败', missed: '错过（Amber 未运行）', skipped_overlap: '跳过（上次未结束）', delivery_failed: '结果发送失败' } as Record<string, string>)[s.lastStatus ?? ''] ?? ''}` : '还没运行过';
    return {
      id: s.id, name: cmd?.name ?? s.commandId, command: cmd?.name ?? s.commandId, ruleText: describeRule(s.rule), nextText: formatAt(s.nextRunAt, s.rule.tz),
      status: s.status, pauseReason: s.pauseReason, creatorOpenId: s.creatorOpenId, lastText: last, canManage: viewer ? this.canManage(s, viewer) : false,
      args: s.args, rule: s.rule, nextRunAt: s.nextRunAt, lastStatus: s.lastStatus, lastRunId: s.lastRunId,
    };
  }

  listCard(rows: ScheduleRow[], viewer: string, scopeLabel: string): object {
    return scheduleListCard(rows.map(s => this.view(s, viewer)), scopeLabel);
  }
}
