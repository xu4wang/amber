// Events: what happens in Amber, recorded so triggers (src/triggers.ts) can act on it. No imports beyond types, so
// any module can report an event without import cycles.
import type { CommandRow } from './db.ts';

/** Each event type, and whose events they are: that decides who may subscribe. */
export const EVENT_TYPES = {
  'app.review_started': { label: '应用提交审核', who: 'app' },
  'app.approved': { label: '应用审核通过', who: 'app' },
  'app.rejected': { label: '应用被驳回', who: 'app' },
  'app.retired': { label: '应用下线', who: 'app' },
  'run.failed': { label: '执行失败', who: 'run' },
  'run.output': { label: '定时执行有输出', who: 'run' },
  'schedule.paused': { label: '定时任务被自动暂停', who: 'schedule' },
  'executor.offline': { label: '执行端离线', who: 'admin' },
  'executor.online': { label: '执行端重新上线', who: 'admin' },
  'page.published': { label: '页面发布', who: 'page' },
  'page.apps_changed': { label: '页面调用的应用变化', who: 'page' },
} as const;
export type EventType = keyof typeof EVENT_TYPES;
export const isEventType = (t: unknown): t is EventType => typeof t === 'string' && Object.hasOwn(EVENT_TYPES, t);

/** What an event says. ownerUnionId: the app's, page's or schedule's owner; callerUnionId: who ran it. */
export interface EventData {
  name?: string; commandId?: string; specHash?: string; chatId?: string; chatType?: string; ownerUnionId?: string;
  callerUnionId?: string; runId?: string; channel?: string; scheduleId?: string; reason?: string; error?: string;
  executor?: string; machine?: string; pageId?: string; newVersion?: boolean;
}

/** An app event's data: the app as people in its chat know it (its instance name), and whose it is. */
export function appEvent(c: CommandRow, extra: EventData = {}): EventData {
  return { commandId: c.id, specHash: c.specHash, name: c.line ?? c.name, chatId: c.chatId, chatType: c.scopeType, ownerUnionId: c.ownerUnionId, ...extra };
}

// The rest of Amber reports events here; the trigger service installs itself (one per process).
let sink: ((type: EventType, data: EventData) => void) | undefined;
export function setEventSink(fn: typeof sink): void { sink = fn; }
export function emitEvent(type: EventType, data: EventData): void {
  try { sink?.(type, data); } catch (e) { console.log(new Date().toISOString(), 'event not recorded', type, (e as Error).message); }
}
