// Triggers: Amber records what happens as events; a person's trigger turns the events they may know about into a
// notice — in their private chat, or in a chat they are in, @-ing a bot there so an agent starts work without polling.
// Who may hear about what follows the rules already in Amber (visibleTo); a notice says who and what, never run output.
import { randomBytes } from 'node:crypto';
import type { Store, TriggerRow, TriggerAction, EventRow } from './db.ts';
import { EVENT_TYPES, isEventType, setEventSink, type EventType, type EventData } from './events.ts';
import { AmberError } from './engine.ts';
import { sanitizeMarkdown, person, closedCard } from './cards.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

export const MAX_TRIGGERS_PER_PERSON = 20;
export const MAX_PER_MINUTE = 10;
export const MAX_PER_DAY = 200;
const RETRY_AFTER_MS = [30_000, 120_000, 600_000];   // then it is given up
const KEEP_EVENTS_MS = 30 * 24 * 3600_000;
const MAX_MENTIONS = 5;

export interface TriggerSpec {
  on: unknown;
  name?: unknown;
  /** Only this app's events: its name and the chat it is in. */
  app?: unknown;
  appChatId?: unknown;
  /** 'me' (private chat) or a chat the owner is in, optionally a thread, @-ing bots there by name. */
  to?: unknown;
  chatId?: unknown;
  rootId?: unknown;
  mention?: unknown;
}

export interface TriggerDeps {
  send(to: { chatId?: string; unionId?: string; replyTo?: string; inThread?: boolean }, card: object): Promise<string | undefined>;
  patch(messageId: string, card: object): Promise<void>;
  isAdmin(unionId: string): boolean;
  isReviewer(unionId: string): boolean;
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  /** The bots in a chat, with the open_ids Amber's app knows them by. */
  chatBots(chatId: string): Promise<{ openId: string; name: string }[]>;
  chatName(chatId: string): Promise<string | undefined>;
  nameOf(unionId: string): Promise<string | undefined>;
  webUrl(): string;
}

export interface TriggerView {
  id: string; name: string; on: EventType; onLabel: string; status: TriggerRow['status']; pauseReason: string | null;
  app: string | null; appChat: string | null; to: string; mentions: string[]; owner: string; ownerName?: string; createdAt: number;
  recent: { type: string; status: string; at: number; error: string | null }[];
}

export class TriggerService {
  private store: Store;
  private deps: TriggerDeps;
  private busy = false;
  private again = false;
  private seenExecutors = new Map<string, boolean>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(store: Store, deps: TriggerDeps, opts: { timers?: boolean } = {}) {
    this.store = store;
    this.deps = deps;
    setEventSink((type, data) => this.emit(type, data));
    store.pruneEvents(Date.now() - KEEP_EVENTS_MS);
    // Deliveries left over from before a restart, and retries, go out from here.
    if (opts.timers !== false) {
      this.timer = setInterval(() => { this.dispatch().catch(e => log('trigger dispatch failed', (e as Error).message)); }, 5000);
      this.timer.unref?.();
    }
  }

  close(): void { if (this.timer) clearInterval(this.timer); setEventSink(undefined); }

  // ---------- events in

  /** Records an event and queues it for every active trigger it may reach. */
  emit(type: EventType, data: EventData): number {
    const id = this.store.insertEvent(type, data as Record<string, unknown>);
    const now = Date.now();
    for (const t of this.store.activeTriggersFor(type)) {
      if (!matches(t, data)) continue;
      // A trigger that fires too often is paused, so a loop or a flood cannot spam a chat.
      if (this.store.countDeliveriesSince(t.id, now - 60_000) >= MAX_PER_MINUTE || this.store.countDeliveriesSince(t.id, now - 24 * 3600_000) >= MAX_PER_DAY) {
        this.store.insertDelivery(t.id, id, 'skipped', 'rate_limited');
        this.pause(t, `触发太频繁（超过每分钟 ${MAX_PER_MINUTE} 次或每天 ${MAX_PER_DAY} 次），已自动暂停`, true);
        continue;
      }
      this.store.insertDelivery(t.id, id);
    }
    setImmediate(() => { this.dispatch().catch(e => log('trigger dispatch failed', (e as Error).message)); });
    return id;
  }

  /** Executors going offline or coming back, seen by polling their state (the first look only records it). */
  checkExecutors(list: { name: string; machine: string; online: boolean }[]): void {
    for (const e of list) {
      const was = this.seenExecutors.get(e.name);
      this.seenExecutors.set(e.name, e.online);
      if (was !== undefined && was !== e.online) this.emit(e.online ? 'executor.online' : 'executor.offline', { executor: e.name, machine: e.machine });
    }
  }

  // ---------- notices out

  /** Sends what is due. One pass at a time; a call during a pass makes it run again after. */
  async dispatch(): Promise<void> {
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    try {
      do {
        this.again = false;
        for (const d of this.store.dueDeliveries(Date.now())) {
          const t = this.store.getTrigger(d.triggerId);
          const ev = this.store.getEvent(d.eventId);
          // Queued while the trigger was active: it goes out even if the trigger was paused since (say, by the rate limit).
          if (!t || !ev) { this.store.updateDelivery(d.triggerId, d.eventId, { status: 'skipped', attempts: d.attempts, error: 'gone' }); continue; }
          const why = await this.blocked(t, ev);
          if (why) { this.store.updateDelivery(t.id, ev.id, { status: 'skipped', attempts: d.attempts, error: why }); continue; }
          try {
            await this.deliver(t, ev);
            this.store.updateDelivery(t.id, ev.id, { status: 'done', attempts: d.attempts + 1 });
          } catch (e: any) {
            const attempts = d.attempts + 1;
            const error = String(e?.response?.data?.code ?? e?.message ?? e).slice(0, 200);
            if (attempts > RETRY_AFTER_MS.length) {
              this.store.updateDelivery(t.id, ev.id, { status: 'failed', attempts, error });
              this.store.audit(t.ownerUnionId, 'trigger.deliver_failed', { id: t.id, eventId: ev.id, type: ev.type, error });
            } else this.store.updateDelivery(t.id, ev.id, { status: 'pending', attempts, nextAt: Date.now() + RETRY_AFTER_MS[attempts - 1], error });
          }
        }
      } while (this.again);
    } finally { this.busy = false; }
  }

  /** Why this notice must not go out now (checked when sending, so lost rights count at once), or undefined. */
  private async blocked(t: TriggerRow, ev: EventRow): Promise<string | undefined> {
    if (!this.visibleTo(t.ownerUnionId, ev.type as EventType, ev.data as EventData)) return 'not_visible';
    if (t.action.to === 'chat' && (await this.deps.isMember(t.action.chatId, t.ownerUnionId)) !== true) {
      this.pause(t, '你已不在通知要发去的群里，已自动暂停', true);
      return 'not_member';
    }
    return undefined;
  }

  /** Whether this person may hear about this event: the same rights as seeing it in Amber. */
  visibleTo(unionId: string, type: EventType, d: EventData): boolean {
    const admin = this.deps.isAdmin(unionId);
    switch (EVENT_TYPES[type].who) {
      case 'app': return admin || this.deps.isReviewer(unionId) || d.ownerUnionId === unionId;
      case 'run': return d.callerUnionId === unionId;
      case 'schedule': return admin || d.ownerUnionId === unionId;
      case 'page': return admin || d.ownerUnionId === unionId;
      case 'admin': return admin;
    }
  }

  private async deliver(t: TriggerRow, ev: EventRow): Promise<void> {
    const card = await this.noticeCard(t, ev);
    const to = t.action.to === 'me' ? { unionId: t.ownerUnionId } : t.action.rootId ? { replyTo: t.action.rootId, inThread: true } : { chatId: t.action.chatId };
    const id = await this.deps.send(to, card);
    if (!id) throw new Error('send returned no message');
  }

  private async noticeCard(t: TriggerRow, ev: EventRow): Promise<object> {
    const d = ev.data as EventData, type = ev.type as EventType;
    const app = `「${sanitizeMarkdown(String(d.name ?? ''), 60)}」`;
    const where = d.chatId ? (d.chatType === 'p2p' ? '私聊' : `群「${sanitizeMarkdown((await this.deps.chatName(d.chatId)) ?? d.chatId, 40)}」`) : '';
    const ownerName = d.ownerUnionId ? sanitizeMarkdown((await this.deps.nameOf(d.ownerUnionId)) ?? '', 30) : '';
    const lines: Record<EventType, string> = {
      'app.review_started': `${app}${d.newVersion ? '（新版本）' : ''}已提交审核。所在：${where}；创建人：${ownerName}。`,
      'app.approved': `${app}审核通过，已经生效。所在：${where}。`,
      'app.rejected': `${app}没有通过审核${d.reason ? `：${sanitizeMarkdown(d.reason, 200)}` : ''}。所在：${where}。`,
      'app.retired': `${app}已下线。所在：${where}。`,
      'run.failed': `你执行的${app}失败了${d.error ? `：${sanitizeMarkdown(d.error, 200)}` : ''}。`,
      'run.output': `${app}的定时执行有输出，结果已发到它的群里，也可以在网站「最近运行」里查看。`,
      'schedule.paused': `${app}的定时任务已暂停：${sanitizeMarkdown(d.reason ?? '', 200)}。`,
      'executor.offline': `执行端「${sanitizeMarkdown(d.executor ?? '', 40)}」（${sanitizeMarkdown(d.machine ?? '', 40)}）离线了。`,
      'executor.online': `执行端「${sanitizeMarkdown(d.executor ?? '', 40)}」（${sanitizeMarkdown(d.machine ?? '', 40)}）重新上线。`,
      'page.published': `页面${app}已发布。`,
      'page.apps_changed': `页面${app}调用的应用有变化，已重新确认。`,
    };
    // A line agents can read: the event and the ids to look things up with.
    const ids = Object.entries({ event: ev.id, command: d.commandId, spec: d.specHash, run: d.runId, schedule: d.scheduleId, page: d.pageId, executor: d.executor })
      .filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${String(v).replace(/[^\w.-]/g, '')}`).join(' ');
    const mentions = t.action.to === 'chat' ? t.action.mentions.map(m => person(m.openId)).join(' ') : '';
    return {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: `Amber · ${EVENT_TYPES[type].label}` }, template: type === 'run.failed' || type === 'executor.offline' || type === 'schedule.paused' ? 'red' : 'blue' },
      body: { elements: [
        { tag: 'markdown', content: `${mentions ? mentions + ' ' : ''}${lines[type]}` },
        { tag: 'markdown', content: `<font color="grey">amber-event ${type} ${ids}\n来自你的触发器「${sanitizeMarkdown(t.name, 40)}」· 在 Amber 网站「我的触发器」里管理</font>` },
      ] },
    };
  }

  // ---------- managing triggers

  /** Checks a spec for this owner; returns what to store. */
  private async check(owner: string, spec: TriggerSpec): Promise<{ eventType: EventType; name: string; filter: TriggerRow['filter']; action: TriggerAction }> {
    if (!isEventType(spec.on)) throw new AmberError('bad_trigger', `不认识的事件。可以用：${Object.keys(EVENT_TYPES).join('、')}`);
    const eventType = spec.on;
    const who = EVENT_TYPES[eventType].who;
    const admin = this.deps.isAdmin(owner), reviewer = this.deps.isReviewer(owner);
    if (who === 'admin' && !admin) throw new AmberError('forbidden', '执行端的事件只有管理员能订阅');
    const filter: TriggerRow['filter'] = {};
    if (spec.app !== undefined && spec.app !== null && String(spec.app).trim()) {
      if (who === 'admin') throw new AmberError('bad_trigger', '执行端的事件不能按应用筛选');
      filter.app = String(spec.app).trim().slice(0, 80);
      if (spec.appChatId) filter.chatId = String(spec.appChatId);
    }
    // Everyone's app events are for reviewers and admins; others name one of their own apps.
    if (who === 'app' && !admin && !reviewer) {
      if (!filter.app || !filter.chatId) throw new AmberError('forbidden', '只有审核人和管理员能订阅所有应用的事件；请指定你自己的应用');
      const mine = this.store.commandsInChatNamed(filter.chatId, filter.app).some(c => c.ownerUnionId === owner);
      if (!mine) throw new AmberError('forbidden', `「${filter.app}」不是你在这个会话里的应用`);
    }
    let action: TriggerAction;
    if (spec.to === undefined || spec.to === 'me') {
      if (spec.mention && String(spec.mention).trim()) throw new AmberError('bad_trigger', '只有发到群里时才能 @机器人');
      action = { kind: 'notify', to: 'me' };
    }
    else if (spec.to === 'chat') {
      const chatId = String(spec.chatId ?? '');
      if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new AmberError('bad_trigger', '要发到群里，请指明是哪个群');
      if ((await this.deps.isMember(chatId, owner)) !== true) throw new AmberError('forbidden', '只能发到你自己所在、并且 Amber 也在的群');
      const wanted = (Array.isArray(spec.mention) ? spec.mention : spec.mention ? String(spec.mention).split(/[,，]/) : []).map(x => String(x).trim().replace(/^@/, '')).filter(Boolean);
      if (wanted.length > MAX_MENTIONS) throw new AmberError('bad_trigger', `最多 @${MAX_MENTIONS} 个机器人`);
      const bots = wanted.length ? await this.deps.chatBots(chatId) : [];
      const mentions = wanted.map(n => {
        const b = bots.find(x => x.name === n);
        if (!b) throw new AmberError('bad_trigger', `群里没有叫「${n}」的机器人${bots.length ? `，群里的机器人：${bots.map(x => x.name).join('、')}` : ''}`);
        return { openId: b.openId, name: b.name };
      });
      const rootId = spec.rootId ? String(spec.rootId) : undefined;
      if (rootId && !/^om_[A-Za-z0-9]+$/.test(rootId)) throw new AmberError('bad_trigger', '话题编号不对');
      action = { kind: 'notify', to: 'chat', chatId, chatName: await this.deps.chatName(chatId), ...(rootId ? { rootId } : {}), mentions };
    } else throw new AmberError('bad_trigger', '通知只能发到「我的私聊」或一个群');
    const name = (spec.name ? String(spec.name).trim() : `${EVENT_TYPES[eventType].label}${filter.app ? `：${filter.app}` : ''}`).slice(0, 40);
    if (!name) throw new AmberError('bad_trigger', '请给触发器起个名字');
    if (this.store.listTriggers(owner).length >= MAX_TRIGGERS_PER_PERSON) throw new AmberError('too_many', `每人最多 ${MAX_TRIGGERS_PER_PERSON} 个触发器`);
    return { eventType, name, filter, action };
  }

  /** From the website: the owner is the logged-in person, so it is active at once. */
  async create(owner: { unionId: string; openId?: string | null }, spec: TriggerSpec): Promise<TriggerRow> {
    const c = await this.check(owner.unionId, spec);
    const id = randomBytes(4).toString('hex');
    this.store.insertTrigger({ id, ownerUnionId: owner.unionId, ownerOpenId: owner.openId ?? null, ...c, status: 'active', requestedBy: null });
    this.store.audit(owner.unionId, 'trigger.create', { id, name: c.name, on: c.eventType, filter: c.filter, to: describeTo(c.action), via: 'web' });
    return this.store.getTrigger(id)!;
  }

  /** From an agent: the person it names confirms on a card (identity from the click). */
  async request(ctx: { chatId: string; chatType: string; user: { unionId: string; openId?: string }; replyTo?: string; inThread: boolean; requestedBy: string; machine: string }, spec: TriggerSpec): Promise<object> {
    const c = await this.check(ctx.user.unionId, spec);
    const id = randomBytes(4).toString('hex');
    this.store.insertTrigger({ id, ownerUnionId: ctx.user.unionId, ownerOpenId: ctx.user.openId ?? null, ...c, status: 'pending', requestedBy: ctx.requestedBy });
    const card = confirmCard(this.store.getTrigger(id)!, ctx.user.openId);
    const to = ctx.chatType === 'p2p' ? { unionId: ctx.user.unionId } : ctx.replyTo ? { replyTo: ctx.replyTo, inThread: ctx.inThread } : { chatId: ctx.chatId };
    let messageId: string | undefined;
    try { messageId = await this.deps.send(to, card); } catch (e: any) {
      this.store.deleteTrigger(id);
      const code = e?.response?.data?.code;
      throw new AmberError('card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `确认卡片发送失败：${code ?? e?.message}`);
    }
    if (messageId) this.store.updateTrigger(id, { confirmMessageId: messageId });
    this.store.audit(null, 'trigger.request', { id, name: c.name, on: c.eventType, filter: c.filter, to: describeTo(c.action), requestedBy: ctx.requestedBy, machine: ctx.machine, target: ctx.user.unionId });
    return { status: 'awaiting', triggerId: id, message: `已发出确认卡片，等对方点「确认」后生效。` };
  }

  /** 确认 / 取消 on the card. */
  onClick(ok: boolean, id: string, clicker: { unionId: string; openId?: string }): object {
    const t = this.store.getTrigger(id);
    if (!t || t.status !== 'pending') throw new AmberError('closed', '这个请求已经处理过了');
    if (clicker.unionId !== t.ownerUnionId) throw new AmberError('forbidden', '只有触发器的主人可以确认');
    if (!ok) {
      this.store.deleteTrigger(id);
      this.store.audit(clicker.unionId, 'trigger.cancel', { id });
      return closedCard(`已取消：${t.name}`, 'grey', `${person(clicker.openId)} 取消了这个触发器。`);
    }
    this.store.updateTrigger(id, { status: 'active', ownerOpenId: clicker.openId ?? t.ownerOpenId });
    this.store.audit(clicker.unionId, 'trigger.create', { id, name: t.name, on: t.eventType, filter: t.filter, to: describeTo(t.action), via: 'card' });
    return closedCard(`触发器已生效：${t.name}`, 'green', `${person(clicker.openId)} 确认了。以后「${EVENT_TYPES[t.eventType as EventType].label}」${t.filter.app ? `（${sanitizeMarkdown(t.filter.app, 40)}）` : ''}时，会${describeTo(t.action)}。在 Amber 网站「我的触发器」里可以暂停或删除。`);
  }

  private pause(t: TriggerRow, reason: string, tellOwner = false): void {
    if (t.status !== 'active') return;
    this.store.updateTrigger(t.id, { status: 'paused', pauseReason: reason });
    t.status = 'paused';
    this.store.audit(null, 'trigger.pause', { id: t.id, reason });
    if (tellOwner) this.deps.send({ unionId: t.ownerUnionId }, closedCard(`触发器已暂停：${t.name}`, 'orange', `${sanitizeMarkdown(reason, 200)}。在 Amber 网站「我的触发器」里可以恢复。`)).catch(() => {});
  }

  /** Pause, resume or delete: the owner, or an admin. */
  change(id: string, actor: string, op: 'pause' | 'resume' | 'delete'): void {
    const t = this.store.getTrigger(id);
    if (!t || t.status === 'pending') throw new AmberError('not_found', '没有这个触发器');
    if (t.ownerUnionId !== actor && !this.deps.isAdmin(actor)) throw new AmberError('forbidden', '只有触发器的主人或管理员可以操作');
    if (op === 'delete') this.store.deleteTrigger(id);
    else this.store.updateTrigger(id, op === 'pause' ? { status: 'paused', pauseReason: '手动暂停' } : { status: 'active', pauseReason: null });
    this.store.audit(actor, `trigger.${op}`, { id, name: t.name });
  }

  /** Someone's triggers (an admin may ask for everyone's). */
  async list(actor: string, all = false): Promise<TriggerView[]> {
    const rows = all && this.deps.isAdmin(actor) ? this.store.listTriggers() : this.store.listTriggers(actor);
    const out: TriggerView[] = [];
    for (const t of rows) {
      if (t.status === 'pending') continue;
      out.push({
        id: t.id, name: t.name, on: t.eventType as EventType, onLabel: EVENT_TYPES[t.eventType as EventType]?.label ?? t.eventType, status: t.status, pauseReason: t.pauseReason,
        app: t.filter.app ?? null, appChat: t.filter.chatId ? ((await this.deps.chatName(t.filter.chatId)) ?? null) : null,
        to: describeTo(t.action), mentions: t.action.to === 'chat' ? t.action.mentions.map(m => m.name) : [],
        owner: t.ownerUnionId, ...(t.ownerUnionId !== actor ? { ownerName: (await this.deps.nameOf(t.ownerUnionId)) ?? undefined } : {}), createdAt: t.createdAt,
        recent: this.store.deliveriesOf(t.id, 5).map(d => ({ type: d.type, status: d.status, at: d.at, error: d.error })),
      });
    }
    return out;
  }

  /** The event types this person may subscribe to, for forms. */
  eventsFor(unionId: string): { type: EventType; label: string; all: boolean }[] {
    const admin = this.deps.isAdmin(unionId), reviewer = this.deps.isReviewer(unionId);
    return (Object.keys(EVENT_TYPES) as EventType[]).filter(t => EVENT_TYPES[t].who !== 'admin' || admin)
      .map(t => ({ type: t, label: EVENT_TYPES[t].label, all: EVENT_TYPES[t].who !== 'app' || admin || reviewer }));
  }
}

function matches(t: TriggerRow, d: EventData): boolean {
  if (t.filter.app && d.name !== t.filter.app) return false;
  if (t.filter.chatId && d.chatId !== t.filter.chatId) return false;
  return true;
}

function describeTo(a: TriggerAction): string {
  if (a.to === 'me') return '私聊通知你';
  return `在群「${a.chatName ?? a.chatId}」${a.rootId ? '的话题里' : ''}发通知${a.mentions.length ? `并 @${a.mentions.map(m => m.name).join('、@')}` : ''}`;
}

function confirmCard(t: TriggerRow, ownerOpenId?: string): object {
  const label = EVENT_TYPES[t.eventType as EventType].label;
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `Amber · 新建触发器：${t.name}` }, template: 'orange' },
    body: { elements: [
      { tag: 'markdown', content: `${sanitizeMarkdown(t.requestedBy ?? '你的 agent', 40)} 要为 ${person(ownerOpenId)} 建一个触发器：\n\n- 什么时候：${label}${t.filter.app ? `（只看「${sanitizeMarkdown(t.filter.app, 40)}」）` : ''}\n- 做什么：${sanitizeMarkdown(describeTo(t.action), 200)}\n\n通知里只有发生了什么（哪个应用、谁、什么时间），不包含执行结果。` },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '确认' }, type: 'primary', behaviors: [{ type: 'callback', value: { a: 'tg_ok', t: t.id } }] }] },
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', behaviors: [{ type: 'callback', value: { a: 'tg_no', t: t.id } }] }] },
      ] },
    ] },
  };
}
