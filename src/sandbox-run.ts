// Runs one Python script under sandbox-exec with a compiled profile (D49). Used by Amber for local
// runs and, generated into client/amber-executor, by executors (D50). Node built-ins only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export const MAX_OUTPUT_BYTES = 256 * 1024;
export interface SandboxResult { ok: boolean; content: string; error?: string }

/** `profileFor` gets the run's private dir (also cwd, HOME and TMPDIR); inputs go in on stdin as JSON. */
export async function runSandboxed(o: { code: string; python: string; profileFor: (runDir: string) => string; input: unknown; timeoutMs?: number; env?: Record<string, string> }): Promise<SandboxResult> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'amber-run-')));
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, o.code);
    const args = ['-p', o.profileFor(work), o.python, '-I', file];
    // Nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ...o.env, TMPDIR: work, HOME: work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    return await new Promise<SandboxResult>(resolve => {
      const child = spawn('/usr/bin/sandbox-exec', args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0);
      let err = '';
      let big = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 30000);
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
      child.stdin.on('error', () => { /* script exited without reading stdin */ });
      child.stdin.end(JSON.stringify(o.input));
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
