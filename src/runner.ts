// Runs a command's script. A command is parameters + one script (D23/D26/D28): no executor
// registry, no SQL step, no multi-step. Two kinds of script:
//   script      — Python code, run inside a macOS sandbox: cannot read $HOME, can only write a
//                 per-run temp dir. Network is one of: none (default), internet, or a list of
//                 registered local services. A script that talks to services gets a signed execution
//                 identity token per service (D27) but no internet, so query results cannot leave.
//   privileged  — Python code run without the sandbox. DISABLED (D40): it would run as the same OS
//                 user as Amber and could read the signing key, so it is rejected at submit time
//                 and refused at run time until it can run under a separate OS user.
// The script's output is content: Markdown, optionally with ```vega-lite and ```table blocks (D24/D25).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { SECRET_NAME, MAX_SECRETS } from './secrets.ts';

export type ScriptKind = 'script' | 'privileged';
/** Per-service declaration: how many calls one run may make (D41). One token is issued per call. */
export interface ServiceUse { calls: number }
export interface Script {
  kind: ScriptKind; lang: 'python'; code: string; network?: boolean; services?: Record<string, ServiceUse>; timeoutMs?: number;
  /** Names of the command secrets this script needs (D48). Reviewed with the code; values are set separately. */
  secrets?: string[];
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
const MAX_OUTPUT_BYTES = 256 * 1024;

function profile(network: boolean, services: string[]): string {
  const svc: string[] = [];
  for (const name of services) {
    const d = SERVICES[name];
    if (d?.tcpPort) svc.push(`(allow network-outbound (remote ip "localhost:${d.tcpPort}"))`);
    if (d?.unixSocket) svc.push(`(allow network-outbound (literal "${d.unixSocket.replace(/"/g, '')}"))`);
  }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix-shm-read-data ipc-posix-shm-write-data)',
    '(allow file-read*)',
    '(deny file-read* (subpath (param "HOME")))',
    '(allow file-read* (subpath (param "WORKDIR")))',
    '(allow file-write* (subpath (param "WORKDIR")) (literal "/dev/null"))',
    ...(network ? ['(allow network-outbound)'] : svc),
    ...(network || svc.length ? ['(allow system-socket)'] : []),
  ].join('\n');
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
  if (x?.kind === 'privileged') throw new Error('特权脚本（privileged）已停用：它与 Amber 同一系统用户运行，能读到签名私钥');
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
    return { kind: 'script', lang: 'python', code: x.code, network: !!x.network, ...(declared ? { services } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(secrets.length ? { secrets } : {}) };
  }
  throw new Error('未知的脚本类型（只支持 script / privileged）');
}

export async function runScript(script: Script, input: ScriptInput): Promise<ScriptResult> {
  const work = mkdtempSync(join(tmpdir(), 'amber-run-'));
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, script.code);
    const pyArgs = ['-I', file];
    // Privileged scripts are disabled (D40); anything that is not a plain script never runs.
    if (script.kind !== 'script') return { ok: false, content: '', error: '特权脚本已停用' };
    const cmd = '/usr/bin/sandbox-exec';
    const args = ['-p', profile(!!script.network, serviceNames(script)), '-D', `HOME=${homedir()}`, '-D', `WORKDIR=${work}`, PYTHON, ...pyArgs];
    // Inputs go in on stdin as JSON; nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', TMPDIR: work, HOME: work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    return await new Promise<ScriptResult>(resolve => {
      const child = spawn(cmd, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0);
      let err = '';
      let big = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), script.timeoutMs ?? 30000);
      child.stdout.on('data', (b: Buffer) => { out = Buffer.concat([out, b]); if (out.length > MAX_OUTPUT_BYTES) { big = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString(); });
      child.on('error', e => { clearTimeout(timer); resolve({ ok: false, content: '', error: `启动失败：${e.message}` }); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (big) return resolve({ ok: false, content: '', error: '输出超过 256KB' });
        if (signal) return resolve({ ok: false, content: '', error: '运行超时或被终止' });
        if (code !== 0) return resolve({ ok: false, content: '', error: `脚本退出码 ${code}${err ? `：${err.trim().split('\n').slice(-3).join(' / ')}` : ''}` });
        resolve({ ok: true, content: out.toString('utf8') });
      });
      child.stdin.end(JSON.stringify(input));
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
