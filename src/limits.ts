// Run limits an admin sets on the website: how long a run may take (the default for apps that don't say, and
// the most an app may ask for) and how many runs may go at once. Runs are counted where they use a machine:
// Amber's own machine, or each executor on its own; plus a per-person cap so one person cannot crowd others out.
import { AmberError } from './engine.ts';

export interface RunLimits {
  defaultTimeoutSec: number; maxTimeoutSec: number;
  /** Runs at once on Amber's own machine (apps without env). */
  maxConcurrentLocal: number;
  /** Runs at once on an executor that has no limit of its own set. */
  maxConcurrentExecutor: number;
  /** Per executor (by name), set on its page. */
  executors: Record<string, number>;
  maxConcurrentPerUser: number;
}

export const DEFAULT_LIMITS: RunLimits = { defaultTimeoutSec: 60, maxTimeoutSec: 600, maxConcurrentLocal: 8, maxConcurrentExecutor: 4, executors: {}, maxConcurrentPerUser: 2 };
/** Bounds for what an admin can set. The time bound is also the most any stored app can ever ask for. */
export const TIMEOUT_BOUNDS = { min: 5, max: 1800 } as const;
export const CONCURRENCY_BOUNDS = { min: 1, max: 64 } as const;
export const RUN_LIMITS_KEY = 'run_limits';

interface Settings { getSetting(k: string): string | undefined; setSetting(k: string, v: string | null): void }

export function getLimits(store: Settings): RunLimits {
  try {
    const v = JSON.parse(store.getSetting(RUN_LIMITS_KEY) ?? 'null');
    return v ? checkLimits({ ...DEFAULT_LIMITS, ...v }) : { ...DEFAULT_LIMITS };
  } catch { return { ...DEFAULT_LIMITS }; }
}

/** Whole numbers within the bounds, and the default no longer than the maximum. Throws with the reason. */
export function checkLimits(x: Record<string, unknown>): RunLimits {
  const int = (k: keyof RunLimits, label: string, b: { min: number; max: number }) => {
    const n = Number(x[k]);
    if (!Number.isInteger(n) || n < b.min || n > b.max) throw new AmberError('bad_request', `${label}要是 ${b.min}–${b.max} 之间的整数`);
    return n;
  };
  const executors: Record<string, number> = {};
  const ex = x.executors && typeof x.executors === 'object' ? x.executors as Record<string, unknown> : {};
  for (const [name, v] of Object.entries(ex)) {
    const n = Number(v);
    if (!/^[a-z0-9-]{1,40}$/.test(name) || !Number.isInteger(n) || n < CONCURRENCY_BOUNDS.min || n > CONCURRENCY_BOUNDS.max) throw new AmberError('bad_request', `执行端 ${name} 的上限要是 ${CONCURRENCY_BOUNDS.min}–${CONCURRENCY_BOUNDS.max} 之间的整数`);
    executors[name] = n;
  }
  const l: RunLimits = {
    defaultTimeoutSec: int('defaultTimeoutSec', '默认时限（秒）', TIMEOUT_BOUNDS),
    maxTimeoutSec: int('maxTimeoutSec', '最长时限（秒）', TIMEOUT_BOUNDS),
    maxConcurrentLocal: int('maxConcurrentLocal', 'Amber 本机同时运行的上限', CONCURRENCY_BOUNDS),
    maxConcurrentExecutor: int('maxConcurrentExecutor', '执行端默认同时运行的上限', CONCURRENCY_BOUNDS),
    executors,
    maxConcurrentPerUser: int('maxConcurrentPerUser', '每人同时运行的上限', CONCURRENCY_BOUNDS),
  };
  if (l.defaultTimeoutSec > l.maxTimeoutSec) throw new AmberError('bad_request', '默认时限不能比最长时限长');
  return l;
}

export function saveLimits(store: Settings, x: Record<string, unknown>): RunLimits {
  const l = checkLimits(x);
  store.setSetting(RUN_LIMITS_KEY, JSON.stringify(l));
  return l;
}

/** How long this run may take: what the app asked for (or the default), never more than the maximum now in force. */
export function effectiveTimeoutMs(asked: number | undefined, l: RunLimits): number {
  return Math.min(asked ?? l.defaultTimeoutSec * 1000, l.maxTimeoutSec * 1000);
}

/** 90 → "1 分 30 秒", 600 → "10 分钟", 45 → "45 秒". */
export function fmtDuration(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m === 0 ? `${s} 秒` : s === 0 ? `${m} 分钟` : `${m} 分 ${s} 秒`;
}

/** What a reader is told about an app's run time, with the limits now in force. */
export function timeoutLabel(asked: number | undefined, l: RunLimits): string {
  if (asked === undefined) return `${fmtDuration(l.defaultTimeoutSec)}（默认）`;
  if (asked > l.maxTimeoutSec * 1000) return `${fmtDuration(l.maxTimeoutSec)}（应用要求 ${fmtDuration(Math.round(asked / 1000))}，超过了现在的上限）`;
  return fmtDuration(Math.round(asked / 1000));
}

/** Longer than this, reviewers are told so plainly. */
export const LONG_RUN_MS = 120_000;

/** Where a run uses a machine: Amber's own, or the executor named in its env ("executor/environment"). */
export function placeOf(env: string | undefined): { key: string; executor?: string } {
  const executor = env ? env.split('/')[0] : undefined;
  return executor ? { key: 'exe:' + executor, executor } : { key: 'local' };
}

export function capOf(place: { executor?: string }, l: RunLimits): number {
  return place.executor ? l.executors[place.executor] ?? l.maxConcurrentExecutor : l.maxConcurrentLocal;
}

/** Runs going on right now, per place and per person. A run over either limit is refused at once, not queued. */
export class RunSlots {
  private byPlace = new Map<string, number>();
  private byUser = new Map<string, number>();

  acquire(unionId: string, env: string | undefined, l: RunLimits): () => void {
    const place = placeOf(env), cap = capOf(place, l);
    const mine = this.byUser.get(unionId) ?? 0, here = this.byPlace.get(place.key) ?? 0;
    if (mine >= l.maxConcurrentPerUser) throw new AmberError('busy', `你已经有 ${mine} 个应用在运行（每人最多同时 ${l.maxConcurrentPerUser} 个），请等它们结束后再试`);
    if (here >= cap) throw new AmberError('busy', `${place.executor ? `执行端 ${place.executor} ` : 'Amber 本机'}同时运行的应用已经到上限（${cap} 个），请稍后再试`);
    const bump = (m: Map<string, number>, k: string, d: number) => { const n = (m.get(k) ?? 0) + d; if (n > 0) m.set(k, n); else m.delete(k); };
    bump(this.byUser, unionId, 1); bump(this.byPlace, place.key, 1);
    let done = false;
    return () => { if (done) return; done = true; bump(this.byUser, unionId, -1); bump(this.byPlace, place.key, -1); };
  }

  /** Runs going on now, per place ("local" or "exe:<name>"). */
  snapshot(): Record<string, number> { return Object.fromEntries(this.byPlace); }
}
