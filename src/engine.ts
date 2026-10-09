import type { Store, CommandRow, ParamDef } from './db.ts';
import { computeSpecHash } from './db.ts';
import { runScript, serviceDef, validateScript } from './runner.ts';
import type { Signer } from './identity.ts';
import { redact, type SecretVault } from './secrets.ts';
import type { ExecutorHub } from './executors.ts';

let HUB: ExecutorHub | undefined;
/** Where commands with script.env are sent (D50); set once at startup. */
export function setExecutorHub(h: ExecutorHub): void { HUB = h; }
export function executorHub(): ExecutorHub | undefined { return HUB; }

let WEB_URL = '';
/** The website, for "set it there" hints (#3); set once at startup. */
export function setWebUrl(u: string): void { WEB_URL = u; }

/** Parameters asked at each run, and configuration items (#3) set once on the website. */
export const runParams = (params: ParamDef[]): ParamDef[] => params.filter(p => p.scope !== 'config');
export const configParams = (params: ParamDef[]): ParamDef[] => params.filter(p => p.scope === 'config');

/** Where a command's secrets and configuration live: its chat and its line (#4), shared by its versions. */
export function lineOf(c: { chatId: string; name: string; line?: string }): { chatId: string; name: string } {
  return { chatId: c.chatId, name: c.line ?? c.name };
}

/** Stored configuration values of a command line. Callers read only the items the version declares. */
export function configValues(store: Store, c: { chatId: string; name: string; line?: string }): Record<string, string> {
  const l = lineOf(c);
  return Object.fromEntries(store.configRows(l.chatId, l.name).map(r => [r.name, r.value]));
}

/** Required configuration items with neither a value nor a default. */
export function missingConfig(store: Store, c: { chatId: string; name: string; line?: string; params: ParamDef[] }, values = configValues(store, c)): string[] {
  return configParams(c.params).filter(p => p.required && p.default === undefined && !(values[p.name] ?? '').trim()).map(p => p.label ?? p.name);
}

export function missingConfigMessage(missing: string[]): string {
  return `还没设置配置项：${missing.join('、')}。请应用创建人或管理员在网站${WEB_URL ? `（${WEB_URL}）` : ''}的应用页面设置`;
}

let VAULT: SecretVault | undefined;
/** The secret store used for runs (D48); set once at startup. */
export function setSecretVault(v: SecretVault): void { VAULT = v; }
export function secretVault(): SecretVault | undefined { return VAULT; }

/** Declared secret names that have no value yet (all of them when no vault is configured). */
export function missingSecrets(c: { chatId: string; name: string; line?: string; script: { secrets?: string[] } }): string[] {
  const names = c.script.secrets ?? [];
  if (!names.length) return [];
  if (!VAULT) return names;
  return VAULT.info(lineOf(c), names).filter(i => !i.set).map(i => i.name);
}

/** After a command line ends (retired, or a draft dropped / rejected with nothing active left under that
 *  name), its secrets and configuration values go too, so a later, unrelated command with the same name cannot inherit them. */
export function dropOrphanSettings(store: Store, chatId: string, name: string, actor: string | null): void {   // name: the line
  if (store.activeByName(chatId, name) || store.nameInProgress(chatId, name)) return;
  const c = store.deleteConfigOf(chatId, name);
  if (c) store.audit(actor, 'config.drop_all', { chatId, name, count: c });
  if (!VAULT) return;
  const n = VAULT.deleteAll({ chatId, name });
  if (n) store.audit(actor, 'secret.drop_all', { chatId, name, count: n });
}

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
 * - local (default): only its creator sees and runs it (#4), and only in the chat it was created in (D11/D14);
 *   a p2p command is also visible in its owner's private chat with Amber (D12). Others get their own copy by
 *   installing it from Amber Store once it is listed. Admins can look at it and take it offline, not run it.
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
  add(store.listActiveByChat(caller.chatId).filter(c => !!caller.unionId && c.ownerUnionId === caller.unionId));
  if (caller.chatType === 'p2p') add(store.listActiveP2pByOwner(caller.unionId));
  add(store.listActiveGlobal());
  return out;
}

export function findVisible(store: Store, caller: Caller, idOrName: string): CommandRow {
  const c = visibleCommands(store, caller).find(x => x.id === idOrName || x.name === idOrName);
  // Out-of-scope and non-existent look the same to the caller.
  if (!c) throw new AmberError('not_found', `没有找到应用「${idOrName}」`);
  return c;
}

/** For managing (take offline, change scope): what the caller can run, and for an admin also anyone's
 *  command by id, or by name in this chat. Never for running. */
export function findManageable(store: Store, caller: Caller, idOrName: string, admin: boolean): CommandRow {
  try { return findVisible(store, caller, idOrName); } catch (e) {
    if (!admin) throw e;
    const active = store.listAll().filter(c => c.status === 'active');
    const c = active.find(x => x.id === idOrName) ?? active.find(x => x.name === idOrName && x.chatId === caller.chatId);
    if (!c) throw e;
    return c;
  }
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

export async function runCommand(store: Store, cmd: CommandRow, rawArgs: Record<string, string | undefined>, caller: Caller, facts: CallerFacts = {}, opts: { trial?: boolean; viaForm?: boolean } = {}): Promise<RunOutcome> {
  if (cmd.status !== 'active' && !(opts.trial && cmd.status === 'draft')) throw new AmberError('not_active', '应用未生效');
  if (computeSpecHash(cmd) !== cmd.specHash) throw new AmberError('spec_mismatch', '应用定义与审核通过的版本不一致，已拒绝执行');
  // The stored definition is re-validated with the same rules as a new draft, and only the validated
  // copy runs: unknown kinds, the old services list (D41), calls outside 1–20, services
  // together with internet, unknown services … are all refused before any run record or token exists.
  let script;
  try { script = validateScript(cmd.script); } catch (e) { throw new AmberError('invalid_script', `应用定义不合规，已拒绝执行：${(e as Error).message}`); }
  // confirm = true: only runnable from the confirmation form, never from a one-line shortcut (D30).
  if (cmd.options.confirm && !opts.trial && !opts.viaForm) throw new AmberError('needs_confirm', '这个应用需要在表单卡片上确认后执行');
  const args = await validateArgs(runParams(cmd.params), rawArgs, facts);
  // Configuration items (#3): the stored values, never the caller's. A trial run (the command is not live yet, so
  // nothing can be stored) takes them from the trial form instead.
  let config: Record<string, string> = {};
  if (configParams(cmd.params).length) {
    const stored = configValues(store, cmd);
    const raw = opts.trial ? { ...stored, ...Object.fromEntries(configParams(cmd.params).filter(p => (rawArgs[p.name] ?? '').trim()).map(p => [p.name, rawArgs[p.name]!])) } : stored;
    const missing = missingConfig(store, cmd, raw);
    if (missing.length) throw new AmberError('missing_config', opts.trial ? `试运行需要填写配置项：${missing.join('、')}` : missingConfigMessage(missing));
    config = await validateArgs(configParams(cmd.params), raw);
  }
  // Command secrets (D48): all declared names must be set before anything runs.
  let secrets: Record<string, string> | undefined;
  if (script.secrets?.length) {
    if (!VAULT) throw new AmberError('no_vault', '密钥存储不可用');
    const got = VAULT.values(lineOf(cmd), script.secrets);
    if ('missing' in got) throw new AmberError('missing_secret', `还没设置密钥：${got.missing.join('、')}。请应用创建人或管理员先设置（私聊 Amber 发「设置密钥 ${cmd.name}」，或在网站的应用页面设置）`);
    secrets = got.values;
  }
  const city = facts.city ? await facts.city() : undefined;
  const started = Date.now();
  const runId = store.startRun({ commandId: cmd.id, specHash: cmd.specHash, channel: opts.trial ? `${caller.channel}.trial` : caller.channel, callerUnionId: caller.unionId, chatId: caller.chatId, args });
  store.audit(caller.unionId, 'run.start', { runId, commandId: cmd.id, name: cmd.name, channel: caller.channel, chatId: caller.chatId });
  const services: Record<string, { tokens: string[]; tcpPort?: number; unixSocket?: string }> = {};
  const channel = opts.trial ? `${caller.channel}.trial` : caller.channel;
  for (const [name, use] of Object.entries(script.services ?? {})) {
    const d = serviceDef(name);
    if (!d || !facts.signer) continue;
    // One single-use token per declared call (D41); no refills while the script runs.
    const tokens = Array.from({ length: use.calls }, (_, i) => facts.signer!.issue({ aud: d.audience, sub: caller.unionId, cmd: cmd.id, rev: cmd.specHash, run: runId, chat: caller.chatId, channel, callIndex: i + 1, callCount: use.calls }));
    store.audit(caller.unionId, 'identity.issue', { runId, service: name, aud: d.audience, count: use.calls });
    services[name] = { tokens, ...(d.tcpPort ? { tcpPort: d.tcpPort } : {}), ...(d.unixSocket ? { unixSocket: d.unixSocket } : {}) };
  }
  const input = { params: { ...args, ...config }, caller: { unionId: caller.unionId, chatId: caller.chatId, channel: caller.channel, city }, runId, ...(Object.keys(services).length ? { services } : {}), ...(secrets ? { secrets } : {}) };
  // script.env (D50): on the executor that holds the data, never here.
  const raw = script.env
    ? (HUB ? await HUB.run(script, { name: cmd.name, params: cmd.params, script: cmd.script, options: cmd.options }, cmd.specHash, input) : { ok: false, content: '', error: '执行端服务不可用' })
    : await runScript(script, input);
  // A secret that ends up in the output or the error message is masked before it is stored or shown.
  const r = secrets ? { ...raw, content: redact(raw.content, secrets), ...(raw.error ? { error: redact(raw.error, secrets) } : {}) } : raw;
  if (secrets) store.audit(caller.unionId, 'secret.use', { runId, commandId: cmd.id, names: Object.keys(secrets) });
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
