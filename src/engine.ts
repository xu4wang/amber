import type { Store, CommandRow, ParamDef } from './db.ts';
import { computeSpecHash } from './db.ts';
import { runScript, serviceDef } from './runner.ts';
import type { Signer } from './identity.ts';

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

export interface CallerFacts { city?: () => Promise<string | undefined>; signer?: Signer }

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

export type Block = { kind: 'markdown'; text: string };
export interface RunOutcome { runId: string; ok: boolean; blocks: Block[]; markdown: string; error?: string; elapsedMs: number; args: Record<string, string> }

export async function runCommand(store: Store, cmd: CommandRow, rawArgs: Record<string, string | undefined>, caller: Caller, facts: CallerFacts = {}, opts: { trial?: boolean } = {}): Promise<RunOutcome> {
  if (cmd.status !== 'active' && !(opts.trial && cmd.status === 'draft')) throw new AmberError('not_active', '指令未生效');
  if (opts.trial && cmd.sideEffect === 'write') throw new AmberError('trial_write', '写操作指令暂不支持试运行');
  if (computeSpecHash(cmd) !== cmd.specHash) throw new AmberError('spec_mismatch', '指令定义与审核通过的版本不一致，已拒绝执行');
  if (cmd.sideEffect === 'write') throw new AmberError('write_needs_confirm', '写操作需要确认（尚未实现）');
  const args = await validateArgs(cmd.params, rawArgs, facts);
  const city = facts.city ? await facts.city() : undefined;
  const started = Date.now();
  const runId = store.startRun({ commandId: cmd.id, specHash: cmd.specHash, channel: opts.trial ? `${caller.channel}.trial` : caller.channel, callerUnionId: caller.unionId, chatId: caller.chatId, args });
  store.audit(caller.unionId, 'run.start', { runId, commandId: cmd.id, name: cmd.name, channel: caller.channel, chatId: caller.chatId });
  const script = cmd.script;
  const services: Record<string, { token: string; tcpPort?: number; unixSocket?: string }> = {};
  for (const name of script.services ?? []) {
    const d = serviceDef(name);
    if (!d || !facts.signer) continue;
    const token = facts.signer.issue({ aud: d.audience, sub: caller.unionId, cmd: cmd.id, rev: cmd.specHash, run: runId, chat: caller.chatId, channel: opts.trial ? `${caller.channel}.trial` : caller.channel });
    store.audit(caller.unionId, 'identity.issue', { runId, service: name, aud: d.audience });
    services[name] = { token, ...(d.tcpPort ? { tcpPort: d.tcpPort } : {}), ...(d.unixSocket ? { unixSocket: d.unixSocket } : {}) };
  }
  const r = await runScript(script, { params: args, caller: { unionId: caller.unionId, chatId: caller.chatId, channel: caller.channel, city }, runId, ...(Object.keys(services).length ? { services } : {}) }, { forceSandbox: !!opts.trial });
  if (!r.ok) {
    store.finishRun(runId, 'failed', null, r.error ?? 'failed');
    store.audit(caller.unionId, 'run.failed', { runId, error: r.error });
    return { runId, ok: false, blocks: [], markdown: '', error: r.error, elapsedMs: Date.now() - started, args };
  }
  const blocks: Block[] = [{ kind: 'markdown', text: r.content.trim() }];
  const markdown = blocks.map(b => b.text).join('\n\n');
  store.finishRun(runId, 'ok', markdown, null);
  store.audit(caller.unionId, 'run.ok', { runId });
  return { runId, ok: true, blocks, markdown, elapsedMs: Date.now() - started, args };
}
