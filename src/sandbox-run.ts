// Runs one Python script under sandbox-exec with a compiled profile (D49). Used by Amber for local
// runs and, generated into client/amber-executor, by executors (D50). Node built-ins only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { startEgressProxy, proxyEnv } from './egress-proxy.ts';

export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Last three non-empty lines, joined, capped so one long line (a JSON table) cannot flood the error. */
const tail = (s: string) => { const t = s.trim().split('\n').filter(l => l.trim()).slice(-3).join(' / '); return t.length > 500 ? '…' + t.slice(-500) : t; };
export interface SandboxResult { ok: boolean; content: string; error?: string }

/** `profileFor` gets the run's private dir (also cwd, HOME and TMPDIR); inputs go in on stdin as JSON. */
/** `home`: HOME for the script (default: the run dir). Only reachable as far as the profile allows. With a real home,
 *  Python also loads the user's own site-packages (`-E` instead of `-I`), as it does in that user's sessions.
 *  `egress`: the environment's network allow list. When set, a local proxy lets the script reach those hosts only;
 *  `profileFor` gets the proxy's port among the local ports to allow, and the script gets HTTPS_PROXY. */
export async function runSandboxed(o: { code: string; python: string; profileFor: (runDir: string, localPorts: number[]) => string; input: unknown; timeoutMs?: number; env?: Record<string, string>; home?: string; egress?: string[] }): Promise<SandboxResult> {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'amber-run-')));
  let proxy: { port: number; close(): void } | undefined;
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, o.code);
    if (o.egress?.length) proxy = await startEgressProxy(o.egress);
    const args = ['-p', o.profileFor(work, proxy ? [proxy.port] : []), o.python, o.home ? '-E' : '-I', file];
    // Nothing user-supplied is ever placed on a command line.
    const env: Record<string, string> = { PATH: `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ...o.env, ...(proxy ? proxyEnv(proxy.port) : {}), TMPDIR: work, HOME: o.home ?? work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
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
        if (code !== 0) {
          // A script may report its failure on either stream; show the tail of both, stderr first.
          const why = [err, out.toString('utf8')].map(tail).filter(Boolean).join(' / ');
          return resolve({ ok: false, content: '', error: `脚本退出码 ${code}${why ? `：${why}` : ''}` });
        }
        resolve({ ok: true, content: out.toString('utf8') });
      });
      child.stdin.on('error', () => { /* script exited without reading stdin */ });
      child.stdin.end(JSON.stringify(o.input));
    });
  } finally {
    proxy?.close();
    rmSync(work, { recursive: true, force: true });
  }
}
