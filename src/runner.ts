// Runs a command's script. A command is parameters + one script (D23/D26/D28): no executor
// registry, no SQL step, no multi-step. One kind of script:
//   script      — Python code, run inside a macOS sandbox built from sandbox-policy.ts (D49): system
//                 dirs and language toolchains readable, credentials and Amber's keys never. A command
//                 declares no paths: on Amber's machine it sees only its per-run temp dir (also cwd,
//                 HOME and TMPDIR); with script.env it runs on an executor with that environment's
//                 access (D51). Network is one of: none (default), internet, or a list of
//                 registered local services. A script that talks to services gets a signed execution
//                 identity token per service (D27) but no internet, so query results cannot leave.
// The script's output is content: Markdown, optionally with ```vega-lite and ```table blocks (D24/D25).
import { SECRET_NAME, MAX_SECRETS } from './secrets.ts';
import { buildPolicy, compileToSeatbelt, normalizePath, hardDenyRoots } from './sandbox-policy.ts';
import { runSandboxed } from './sandbox-run.ts';
import { EXECUTOR_NAME, ENV_NAME } from './exec-proto.ts';

export type ScriptKind = 'script';
/** Per-service declaration: how many calls one run may make (D41). One token is issued per call. */
export interface ServiceUse { calls: number }
export interface Script {
  kind: ScriptKind; lang: 'python'; code: string; network?: boolean; services?: Record<string, ServiceUse>; timeoutMs?: number;
  /** Names of the command secrets this script needs (D48). Reviewed with the code; values are set separately. */
  secrets?: string[];
  /** Absolute path of the Python interpreter to use (e.g. a venv with packages), reviewed with the code. Default: the system Python. */
  interpreter?: string;
  /** Where it runs (D50): "<executor>/<environment>" — an approved executor on the machine that holds the data. Default: on Amber's machine. */
  env?: string;
}

/** Splits script.env into executor and environment names. */
export function parseEnv(env: string): { executor: string; env: string } | undefined {
  const i = env.indexOf('/');
  if (i < 0) return undefined;
  const executor = env.slice(0, i), name = env.slice(i + 1);
  return EXECUTOR_NAME.test(executor) && ENV_NAME.test(name) ? { executor, env: name } : undefined;
}

export const MAX_SERVICE_CALLS = 20;
/** Names of the services a script declares. */
export function serviceNames(s: Pick<Script, 'services'>): string[] { return Object.keys(s.services ?? {}); }
/** Human-readable "name（N 次）" list for cards and review documents. */
export function describeServices(s: Pick<Script, 'services'>): string {
  return Object.entries(s.services ?? {}).map(([n, u]) => `${n}（每次执行最多 ${u.calls} 次调用）`).join('、');
}

/** Local services a script may call (config: services). Only these addresses are reachable from the sandbox. */
export interface ServiceDef { audience: string; tcpPort?: number; unixSocket?: string }
let SERVICES: Record<string, ServiceDef> = {};
export function setServices(s: Record<string, ServiceDef>): void { SERVICES = s; }
export function knownServices(): string[] { return Object.keys(SERVICES); }
export function serviceDef(name: string): ServiceDef | undefined { return SERVICES[name]; }

export const MAX_CODE_BYTES = 64 * 1024;
const PYTHON = process.env.AMBER_PYTHON ?? '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9';

function profile(script: Script, runDir: string): string {
  const tcpPorts: number[] = [], unixSockets: string[] = [];
  for (const name of serviceNames(script)) {
    const d = SERVICES[name];
    if (d?.tcpPort) tcpPorts.push(d.tcpPort);
    if (d?.unixSocket) unixSockets.push(d.unixSocket);
  }
  return compileToSeatbelt(buildPolicy({ runDir }), { all: !!script.network, tcpPorts, unixSockets });
}

export interface ScriptInput {
  params: Record<string, string>;
  caller: { unionId: string; chatId: string; channel: string; city?: string };
  runId: string;
  /** service name -> { tokens, address }, only for services the script declared. One single-use token per declared call. */
  services?: Record<string, { tokens: string[]; tcpPort?: number; unixSocket?: string }>;
  /** Command secret name -> value, only the names the script declared (D48). */
  secrets?: Record<string, string>;
}

export interface ScriptResult { ok: boolean; content: string; error?: string }

export function validateScript(s: unknown): Script {
  const x = s as Record<string, unknown>;
  if (x?.kind === 'script') {
    if (x.lang !== 'python') throw new Error('脚本目前只支持 python');
    if (typeof x.code !== 'string' || !x.code.trim()) throw new Error('脚本缺少代码');
    if (Buffer.byteLength(x.code) > MAX_CODE_BYTES) throw new Error('代码不能超过 64KB');
    const timeoutMs = x.timeoutMs === undefined ? undefined : Math.min(Math.max(Number(x.timeoutMs) || 0, 1000), 120000);
    if (Array.isArray(x.services)) throw new Error('services 要写成 {"服务名": {"calls": 次数}}，次数是每次执行最多调用几次（1–20）');
    const services: Record<string, ServiceUse> = {};
    if (x.services !== undefined) {
      if (!x.services || typeof x.services !== 'object') throw new Error('services 格式不对');
      for (const [name, u] of Object.entries(x.services as Record<string, unknown>)) {
        if (!SERVICES[name]) throw new Error(`未知的服务 ${name}（可用：${knownServices().join('、') || '无'}）`);
        const calls = (u as { calls?: unknown })?.calls;
        if (!Number.isInteger(calls) || (calls as number) < 1 || (calls as number) > MAX_SERVICE_CALLS) throw new Error(`服务 ${name} 的 calls 必须是 1–${MAX_SERVICE_CALLS} 的整数`);
        services[name] = { calls: calls as number };
      }
    }
    const declared = Object.keys(services).length > 0;
    if (declared && x.network) throw new Error('调用内部服务的脚本不能同时开放外网（防止数据外传）');
    let secrets: string[] = [];
    if (x.secrets !== undefined) {
      if (!Array.isArray(x.secrets)) throw new Error('secrets 要写成密钥名称的数组，例如 ["GITLAB_TOKEN"]');
      secrets = x.secrets.map(String);
      for (const n of secrets) if (!SECRET_NAME.test(n)) throw new Error(`密钥名称 ${n} 不对：只能用大写字母、数字和下划线，以字母开头，最多 64 个字符`);
      if (new Set(secrets).size !== secrets.length) throw new Error('secrets 里有重复的名称');
      if (secrets.length > MAX_SECRETS) throw new Error(`一条指令最多声明 ${MAX_SECRETS} 个密钥`);
    }
    let env: string | undefined;
    if (x.env !== undefined) {
      env = String(x.env).trim();
      if (!parseEnv(env)) throw new Error('env 要写成 "执行端名/环境名"，例如 "ledger-mac/台账"（执行端名：小写字母、数字、连字符）');
      if (declared) throw new Error('在执行端上运行的指令不能调用内部服务（services）');
    }
    if (x.sandbox !== undefined) throw new Error('指令不再声明 sandbox：能访问哪些文件由运行环境决定。需要访问数据时，用 env 选择一个运行环境');
    let interpreter: string | undefined;
    if (x.interpreter !== undefined) {
      const p = normalizePath(String(x.interpreter));
      if (hardDenyRoots().some(r => p === r || p.startsWith(r + '/'))) throw new Error(`解释器不能放在受保护的目录里：${x.interpreter}`);
      if (!/\/python(3(\.\d+)?)?$/.test(p)) throw new Error('interpreter 只能是 Python 解释器（路径以 python、python3 或 python3.x 结尾）');
      interpreter = String(x.interpreter).trim();
    }
    return { kind: 'script', lang: 'python', code: x.code, network: !!x.network, ...(declared ? { services } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(secrets.length ? { secrets } : {}), ...(interpreter ? { interpreter } : {}), ...(env ? { env } : {}) };
  }
  throw new Error('脚本类型只能是 script');
}

export async function runScript(script: Script, input: ScriptInput): Promise<ScriptResult> {
  // Only sandboxed scripts exist; anything else never runs.
  if (script.kind !== 'script') return { ok: false, content: '', error: '脚本类型只能是 script' };
  // Remote commands are dispatched by the engine; never run one here without its environment.
  if (script.env) return { ok: false, content: '', error: '这条指令要在执行端上运行' };
  return runSandboxed({ code: script.code, python: script.interpreter ? normalizePath(script.interpreter) : PYTHON, profileFor: dir => profile(script, dir), input, timeoutMs: script.timeoutMs });
}
