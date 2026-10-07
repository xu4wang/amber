// Runs one step of a command. A step carries its own code or SQL (D23); there is no separate
// executor registry. Three kinds:
//   script      — Python code, run inside a macOS sandbox: cannot read $HOME, can only write a
//                 per-run temp dir, network only if the step declares it.
//   privileged  — Python code run without the sandbox (may read local files / credentials).
//                 Only admins may approve commands that contain such a step.
//   sql         — read-only query through Data MCP as the caller (not wired yet).
// Every step's output is content: Markdown, optionally with ```vega-lite and ```table blocks (D24/D25).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export type StepKind = 'script' | 'privileged' | 'sql';
export interface ScriptStep { kind: 'script' | 'privileged'; lang: 'python'; code: string; network?: boolean; timeoutMs?: number }
export interface SqlStep { kind: 'sql'; sql: string }
export type Step = ScriptStep | SqlStep;

export const MAX_CODE_BYTES = 64 * 1024;
const PYTHON = process.env.AMBER_PYTHON ?? '/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/3.9/bin/python3.9';
const MAX_OUTPUT_BYTES = 256 * 1024;

function profile(network: boolean): string {
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec process-fork signal sysctl-read mach-lookup ipc-posix-shm-read-data ipc-posix-shm-write-data)',
    '(allow file-read*)',
    '(deny file-read* (subpath (param "HOME")))',
    '(allow file-read* (subpath (param "WORKDIR")))',
    '(allow file-write* (subpath (param "WORKDIR")) (literal "/dev/null"))',
    ...(network ? ['(allow network-outbound)', '(allow system-socket)'] : []),
  ].join('\n');
}

export interface StepInput {
  params: Record<string, string>;
  caller: { unionId: string; chatId: string; channel: string; city?: string };
  runId: string;
}

export interface StepResult { ok: boolean; content: string; error?: string }

export function validateStep(s: unknown): Step {
  const x = s as Record<string, unknown>;
  if (x?.kind === 'sql') {
    if (typeof x.sql !== 'string' || !x.sql.trim()) throw new Error('sql 步骤缺少 sql');
    return { kind: 'sql', sql: x.sql };
  }
  if (x?.kind === 'script' || x?.kind === 'privileged') {
    if (x.lang !== 'python') throw new Error('脚本目前只支持 python');
    if (typeof x.code !== 'string' || !x.code.trim()) throw new Error('脚本步骤缺少代码');
    if (Buffer.byteLength(x.code) > MAX_CODE_BYTES) throw new Error('单步代码不能超过 64KB');
    const timeoutMs = x.timeoutMs === undefined ? undefined : Math.min(Math.max(Number(x.timeoutMs) || 0, 1000), 120000);
    return { kind: x.kind, lang: 'python', code: x.code, network: !!x.network, ...(timeoutMs ? { timeoutMs } : {}) };
  }
  throw new Error('未知的步骤类型（只支持 script / privileged / sql）');
}

export async function runStep(step: Step, input: StepInput): Promise<StepResult> {
  if (step.kind === 'sql') return { ok: false, content: '', error: 'SQL 查询还没有接入（需要先与 Data MCP 维护方确认身份通道）' };
  const work = mkdtempSync(join(tmpdir(), 'amber-run-'));
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, step.code);
    const pyArgs = ['-I', file];
    const sandboxed = step.kind === 'script';
    const cmd = sandboxed ? '/usr/bin/sandbox-exec' : PYTHON;
    const args = sandboxed
      ? ['-p', profile(!!step.network), '-D', `HOME=${homedir()}`, '-D', `WORKDIR=${work}`, PYTHON, ...pyArgs]
      : pyArgs;
    // Inputs go in on stdin as JSON; nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: '/usr/bin:/bin', TMPDIR: work, HOME: work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    if (!sandboxed) env.HOME = homedir();
    return await new Promise<StepResult>(resolve => {
      const child = spawn(cmd, args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0);
      let err = '';
      let big = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), step.timeoutMs ?? 30000);
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
