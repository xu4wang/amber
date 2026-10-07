// When a schedule runs. Only a few plain forms (no cron): non-technical people must be able to read
// them back on the confirmation card. All times are wall-clock times in an explicit IANA time zone.
import { AmberError } from './engine.ts';

export type Rule =
  | { kind: 'daily' | 'weekdays'; time: string; tz: string }
  | { kind: 'weekly'; weekday: number; time: string; tz: string }   // weekday 1 = Monday … 7 = Sunday
  | { kind: 'hourly'; every: number; minute: number; tz: string }
  | { kind: 'minutely'; every: number; tz: string };                  // every 5/10/15/20/30 minutes, on the clock

const WEEKDAYS = '一二三四五六日';
// Time zones are a deployment setting (config: timezones). The first one is the default; with no
// setting, the Amber server's own time zone is used.
export interface TimeZoneOption { tz: string; label: string }
export const SERVER_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
let ZONES: TimeZoneOption[] = [{ tz: SERVER_TZ, label: '服务器时间' }];
export function setTimezones(list: TimeZoneOption[] | undefined): void {
  const ok = (list ?? []).filter(z => z && typeof z.tz === 'string' && (() => { try { new Intl.DateTimeFormat('en-US', { timeZone: z.tz }); return true; } catch { return false; } })())
    .map(z => ({ tz: z.tz, label: String(z.label || z.tz) }));
  if (ok.length) ZONES = ok;
}
export function timezones(): TimeZoneOption[] { return ZONES; }
export function defaultTz(): string { return ZONES[0].tz; }
function tzLabel(tz: string): string { return ZONES.find(z => z.tz === tz)?.label ?? tz; }

function checkTz(tz: string): string {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch { throw new AmberError('bad_rule', `不认识的时区：${tz}`); }
  return tz;
}

function time(h: string, m: string): string {
  const hh = Number(h), mm = Number(m);
  if (hh > 23 || mm > 59) throw new AmberError('bad_rule', '时间不对，应为 00:00–23:59');
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** "每天 9:00" / "工作日 18:30" / "每周一 9:00" / "每小时" / "每 2 小时" / "每 2 小时 15 分" / "每 15 分钟"; English: "daily 9:00", "weekdays 9:00", "weekly mon 9:00", "every 2h", "every 15m". */
export function parseRule(text: string, tz = defaultTz()): Rule {
  checkTz(tz);
  const s = text.trim().replace(/：/g, ':').replace(/\s+/g, ' ');
  const T = '(\\d{1,2}):(\\d{2})';
  let m: RegExpExecArray | null;
  if ((m = new RegExp(`^(?:每天|daily) ?${T}$`, 'i').exec(s))) return { kind: 'daily', time: time(m[1], m[2]), tz };
  if ((m = new RegExp(`^(?:每个?工作日|工作日|weekdays) ?${T}$`, 'i').exec(s))) return { kind: 'weekdays', time: time(m[1], m[2]), tz };
  if ((m = new RegExp(`^(?:每周|每星期|周|星期)([一二三四五六日天]) ?${T}$`).exec(s))) {
    return { kind: 'weekly', weekday: m[1] === '天' ? 7 : WEEKDAYS.indexOf(m[1]) + 1, time: time(m[2], m[3]), tz };
  }
  if ((m = new RegExp(`^weekly (mon|tue|wed|thu|fri|sat|sun) ?${T}$`, 'i').exec(s))) {
    return { kind: 'weekly', weekday: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(m[1].toLowerCase()) + 1, time: time(m[2], m[3]), tz };
  }
  if ((m = /^(?:每 ?(\d{1,2}) ?分钟|every ?(\d{1,2}) ?m(?:in(?:utes?)?)?)$/i.exec(s))) {
    const every = Number(m[1] ?? m[2]);
    // At least 5 minutes: every run starts a sandboxed process and may call services (D37).
    if (![5, 10, 15, 20, 30].includes(every)) throw new AmberError('bad_rule', '每 N 分钟：N 只能是 5、10、15、20、30（最短 5 分钟）');
    return { kind: 'minutely', every, tz };
  }
  if ((m = /^(?:每 ?(\d{1,2})? ?个?小时(?: ?(?:的?第)? ?(\d{1,2}) ?分)?|every ?(\d{1,2})? ?h(?:ours?)?(?: at :?(\d{1,2}))?)$/i.exec(s))) {
    const every = Number(m[1] ?? m[3] ?? 1);
    const minute = Number(m[2] ?? m[4] ?? 0);
    if (every < 1 || every > 24 || 24 % every !== 0) throw new AmberError('bad_rule', '每 N 小时：N 必须能整除 24（1、2、3、4、6、8、12、24）');
    if (minute > 59) throw new AmberError('bad_rule', '分钟应为 0–59');
    return { kind: 'hourly', every, minute, tz };
  }
  throw new AmberError('bad_rule', '看不懂这个时间。可用写法：每天 09:00、工作日 09:00、每周一 09:00、每小时、每 2 小时、每 5 分钟');
}

export function validateRule(r: unknown): Rule {
  const x = r as Rule;
  if (!x || typeof x !== 'object') throw new AmberError('bad_rule', '缺少时间规则');
  // Re-derive through the parser so a stored or submitted rule can never hold values the parser would refuse.
  return parseRule(describeRuleRaw(x), x.tz);
}

function describeRuleRaw(r: Rule): string {
  if (r.kind === 'daily') return `每天 ${r.time}`;
  if (r.kind === 'weekdays') return `工作日 ${r.time}`;
  if (r.kind === 'weekly') return `每周${WEEKDAYS[r.weekday - 1] ?? '?'} ${r.time}`;
  if (r.kind === 'hourly') return `每 ${r.every} 小时 ${r.minute} 分`;
  if (r.kind === 'minutely') return `每 ${r.every} 分钟`;
  return '?';
}

export function describeRule(r: Rule): string {
  const tz = tzLabel(r.tz);
  if (r.kind === 'hourly') return `${r.every === 1 ? '每小时' : `每 ${r.every} 小时`}的第 ${r.minute} 分（${tz}）`;
  if (r.kind === 'minutely') return `每 ${r.every} 分钟（${tz}）`;
  return `${describeRuleRaw(r)}（${tz}）`;
}

interface Local { y: number; mo: number; d: number; h: number; mi: number; wd: number }

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function local(t: number, tz: string): Local {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(t))) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, wd: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(p.weekday) + 1 };
}

/** UTC instant of a wall-clock time in tz. */
function toUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = (t: number) => { const l = local(t, tz); return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi) - Math.floor(t / 60000) * 60000; };
  let t = guess - off(guess);
  t = guess - off(t);
  return t;
}

/** First run strictly after `after` (ms). */
export function nextRun(r: Rule, after: number): number {
  if (r.kind === 'minutely') {
    let t = Math.floor(after / 60000) * 60000 + 60000;
    for (let i = 0; i < 61; i++, t += 60000) if (local(t, r.tz).mi % r.every === 0) return t;
    throw new Error('no next run');
  }
  if (r.kind === 'hourly') {
    let t = Math.floor(after / 60000) * 60000 + 60000;
    for (let i = 0; i < 49 * 60; i++, t += 60000) {
      const l = local(t, r.tz);
      if (l.mi === r.minute && l.h % r.every === 0) return t;
    }
    throw new Error('no next run');
  }
  const [h, mi] = r.time.split(':').map(Number);
  for (let i = 0; i <= 8; i++) {
    const l = local(after + i * 86400_000, r.tz);
    if (r.kind === 'weekdays' && l.wd > 5) continue;
    if (r.kind === 'weekly' && l.wd !== r.weekday) continue;
    const t = toUtc(l.y, l.mo, l.d, h, mi, r.tz);
    if (t > after) return t;
  }
  throw new Error('no next run');
}

/** "10月8日 周四 09:00（北京时间）" in the default time zone — for times shown outside a schedule. */
export function formatAtDefault(t: number): string {
  return `${formatAt(t, defaultTz())}（${tzLabel(defaultTz())}）`;
}

export function formatAt(t: number, tz: string): string {
  const l = local(t, tz);
  return `${l.mo}月${l.d}日 周${WEEKDAYS[l.wd - 1]} ${String(l.h).padStart(2, '0')}:${String(l.mi).padStart(2, '0')}`;
}
