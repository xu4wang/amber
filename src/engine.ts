import type { Store, CommandRow, ParamDef } from './db.ts';
import { computeSpecHash } from './db.ts';
import type { ExecutorRegistry } from './executors.ts';
import { runExecutor } from './executors.ts';

export interface Caller {
  unionId: string;
  openId?: string;
  /** Chat the request came from (Feishu event / card context). */
  chatId: string;
  chatType: 'group' | 'p2p';
  channel: 'bot' | 'web' | 'agent' | 'schedule';
}

export class AmberError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/**
 * Scope rules:
 * - local (default): visible only in the chat it was created in (D11/D14); a p2p command is also
 *   visible in its owner's private chat with Amber (D12).
 * - global (D20): promoted by an admin; visible in every chat Amber is in.
 * When a local and a global command share a name, the local one wins in that chat.
 */
export function visibleCommands(store: Store, caller: Caller): CommandRow[] {
  const out: CommandRow[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const add = (list: CommandRow[]) => {
    for (const c of list) {
      if (ids.has(c.id) || names.has(c.name)) continue;
      ids.add(c.id); names.add(c.name); out.push(c);
    }
  };
  add(store.listActiveByChat(caller.chatId));
  if (caller.chatType === 'p2p') add(store.listActiveP2pByOwner(caller.unionId));
  add(store.listActiveGlobal());
  return out;
}

export function findVisible(store: Store, caller: Caller, idOrName: string): CommandRow {
  const c = visibleCommands(store, caller).find(x => x.id === idOrName || x.name === idOrName);
  // Out-of-scope and non-existent look the same to the caller.
  if (!c) throw new AmberError('not_found', `没有找到指令「${idOrName}」`);
  return c;
}

export interface CallerFacts { city?: () => Promise<string | undefined> }

export async function validateArgs(params: ParamDef[], raw: Record<string, string | undefined>, facts: CallerFacts = {}): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of params) {
    let v = (raw[p.name] ?? '').trim();
    if (!v && p.defaultFrom === 'caller.city' && facts.city) v = (await facts.city()) ?? '';
    if (!v && p.default !== undefined) v = p.default;
    if (!v) {
      if (p.required) throw new AmberError('invalid_args', `缺少参数「${p.label ?? p.name}」`);
      continue;
    }
    if (p.type === 'integer') {
      if (!/^-?\d+$/.test(v)) throw new AmberError('invalid_args', `参数「${p.label ?? p.name}」必须是整数`);
      const n = Number(v);
      if (p.min !== undefined && n < p.min) throw new AmberError('invalid_args', `参数「${p.label ?? p.name}」不能小于 ${p.min}`);
      if (p.max !== undefined && n > p.max) throw new AmberError('invalid_args', `参数「${p.label ?? p.name}」不能大于 ${p.max}`);
    } else {
      if (p.maxLength !== undefined && v.length > p.maxLength) throw new AmberError('invalid_args', `参数「${p.label ?? p.name}」太长`);
      if (p.pattern && !new RegExp(p.pattern, 'u').test(v)) throw new AmberError('invalid_args', `参数「${p.label ?? p.name}」格式不对`);
    }
    out[p.name] = v;
  }
  return out;
}

function render(template: string, args: Record<string, string>, caller: Caller): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    if (key === 'caller.union_id') return caller.unionId;
    if (key === 'caller.open_id') return caller.openId ?? '';
    return args[key] ?? '';
  });
}

export type Block = { kind: 'markdown'; text: string } | { kind: 'line'; title?: string; x: string; y: string; yLabel?: string; rows: Record<string, unknown>[] };
export interface RunOutcome { runId: string; ok: boolean; blocks: Block[]; markdown: string; error?: string; elapsedMs: number; args: Record<string, string> }

export async function runCommand(store: Store, executors: ExecutorRegistry, cmd: CommandRow, rawArgs: Record<string, string | undefined>, caller: Caller, facts: CallerFacts = {}, opts: { trial?: boolean } = {}): Promise<RunOutcome> {
  if (cmd.status !== 'active' && !(opts.trial && cmd.status === 'draft')) throw new AmberError('not_active', '指令未生效');
  if (opts.trial && cmd.sideEffect === 'write') throw new AmberError('trial_write', '写操作指令暂不支持试运行');
  if (computeSpecHash(cmd) !== cmd.specHash) throw new AmberError('spec_mismatch', '指令定义与审核通过的版本不一致，已拒绝执行');
  if (cmd.sideEffect === 'write') throw new AmberError('write_needs_confirm', '写操作需要确认（尚未实现）');
  const args = await validateArgs(cmd.params, rawArgs, facts);
  const started = Date.now();
  const runId = store.startRun({ commandId: cmd.id, specHash: cmd.specHash, channel: opts.trial ? `${caller.channel}.trial` : caller.channel, callerUnionId: caller.unionId, chatId: caller.chatId, args });
  store.audit(caller.unionId, 'run.start', { runId, commandId: cmd.id, name: cmd.name, channel: caller.channel, chatId: caller.chatId });
  const blocks: Block[] = [];
  for (const step of cmd.steps) {
    const def = executors.get(step.executor);
    if (!def) {
      store.finishRun(runId, 'failed', null, `executor_missing:${step.executor}`);
      return { runId, ok: false, blocks: [], markdown: '', error: `执行器 ${step.executor} 未登记`, elapsedMs: Date.now() - started, args };
    }
    const stepArgs: Record<string, string> = {};
    for (const [k, t] of Object.entries(step.input)) {
      const v = render(t, args, caller);
      if (v !== '') stepArgs[k] = v;
    }
    const r = await runExecutor(def, stepArgs, { AMBER_CALLER_UNION_ID: caller.unionId, AMBER_CHAT_ID: caller.chatId, AMBER_RUN_ID: runId, AMBER_CHANNEL: caller.channel });
    if (!r.ok) {
      store.finishRun(runId, 'failed', null, r.error ?? 'failed');
      store.audit(caller.unionId, 'run.failed', { runId, error: r.error });
      return { runId, ok: false, blocks: [], markdown: '', error: r.error, elapsedMs: Date.now() - started, args };
    }
    const view = step.render ?? { kind: 'markdown' as const };
    if (view.kind === 'line') {
      let rows: Record<string, unknown>[] = [];
      try { const j = JSON.parse(r.stdout); rows = Array.isArray(j) ? j : (j.rows ?? []); } catch { rows = []; }
      blocks.push({ kind: 'line', title: view.title, x: view.x, y: view.y, yLabel: view.yLabel, rows: rows.slice(0, 500) });
    } else {
      blocks.push({ kind: 'markdown', text: r.stdout.trim() });
    }
  }
  const markdown = blocks.map(b => b.kind === 'markdown' ? b.text : `[图表：${b.title ?? ''}]`).join('\n\n');
  store.finishRun(runId, 'ok', markdown, null);
  store.audit(caller.unionId, 'run.ok', { runId });
  return { runId, ok: true, blocks, markdown, elapsedMs: Date.now() - started, args };
}
