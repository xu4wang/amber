// Runs a command's script. A command is parameters + one script (D23/D26/D28): no executor
// registry, no SQL step, no multi-step. Two kinds of script:
//   script      — Python code, run inside a macOS sandbox: cannot read $HOME, can only write a
//                 per-run temp dir. Network is one of: none (default), internet, or a list of
//                 registered local services. A script that talks to services gets a signed execution
//                 identity token per service (D27) but no internet, so query results cannot leave.
//   privileged  — Python code run without the sandbox (may read local files / credentials).
//                 Only admins may approve commands that contain such a script.
// The script's output is content: Markdown, optionally with ```vega-lite and ```table blocks (D24/D25).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export type ScriptKind = 'script' | 'privileged';
export interface Script { kind: ScriptKind; lang: 'python'; code: string; network?: boolean; services?: string[]; timeoutMs?: number }

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
  /** service name -> { token, address }, only for services the script declared */
  services?: Record<string, { token: string; tcpPort?: number; unixSocket?: string }>;
}

export interface ScriptResult { ok: boolean; content: string; error?: string }

export function validateScript(s: unknown): Script {
  const x = s as Record<string, unknown>;
  if (x?.kind === 'script' || x?.kind === 'privileged') {
    if (x.lang !== 'python') throw new Error('脚本目前只支持 python');
    if (typeof x.code !== 'string' || !x.code.trim()) throw new Error('脚本缺少代码');
    if (Buffer.byteLength(x.code) > MAX_CODE_BYTES) throw new Error('代码不能超过 64KB');
    const timeoutMs = x.timeoutMs === undefined ? undefined : Math.min(Math.max(Number(x.timeoutMs) || 0, 1000), 120000);
    const services = Array.isArray(x.services) ? x.services.map(String) : [];
    for (const name of services) if (!SERVICES[name]) throw new Error(`未知的服务 ${name}（可用：${knownServices().join('、') || '无'}）`);
    if (services.length && x.network) throw new Error('调用内部服务的脚本不能同时开放外网（防止数据外传）');
    return { kind: x.kind, lang: 'python', code: x.code, network: !!x.network, ...(services.length ? { services } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  }
  throw new Error('未知的脚本类型（只支持 script / privileged）');
}

export async function runScript(script: Script, input: ScriptInput, opts: { forceSandbox?: boolean } = {}): Promise<ScriptResult> {
  const work = mkdtempSync(join(tmpdir(), 'amber-run-'));
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, script.code);
    const pyArgs = ['-I', file];
    // Privileged code that has not been approved yet (trial runs) still goes through the sandbox.
    const sandboxed = script.kind === 'script' || !!opts.forceSandbox;
    const cmd = sandboxed ? '/usr/bin/sandbox-exec' : PYTHON;
    const args = sandboxed
      ? ['-p', profile(!!script.network, script.services ?? []), '-D', `HOME=${homedir()}`, '-D', `WORKDIR=${work}`, PYTHON, ...pyArgs]
      : pyArgs;
    // Inputs go in on stdin as JSON; nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', TMPDIR: work, HOME: work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    if (!sandboxed) env.HOME = homedir();
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
