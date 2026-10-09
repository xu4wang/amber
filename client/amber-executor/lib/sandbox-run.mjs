// GENERATED from src/sandbox-run.ts by scripts/build-executor.mjs — do not edit.
// Runs one Python script under sandbox-exec with a compiled profile (D49). Used by Amber for local
// runs and, generated into client/amber-executor, by executors (D50). Node built-ins only.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

export const MAX_OUTPUT_BYTES = 256 * 1024;
/** Last three non-empty lines, joined, capped so one long line (a JSON table) cannot flood the error. */
const tail = (s        ) => { const t = s.trim().split('\n').filter(l => l.trim()).slice(-3).join(' / '); return t.length > 500 ? '…' + t.slice(-500) : t; };
                                                                               

/** `profileFor` gets the run's private dir (also cwd, HOME and TMPDIR); inputs go in on stdin as JSON. */
/** `home`: HOME for the script (default: the run dir). Only reachable as far as the profile allows. With a real home,
 *  Python also loads the user's own site-packages (`-E` instead of `-I`), as it does in that user's sessions. */
export async function runSandboxed(o                                                                                                                                                           )                         {
  const work = realpathSync(mkdtempSync(join(tmpdir(), 'amber-run-')));
  try {
    const file = join(work, 'main.py');
    writeFileSync(file, o.code);
    const args = ['-p', o.profileFor(work), o.python, o.home ? '-E' : '-I', file];
    // Nothing user-supplied is ever placed on a command line.
    const env                         = { PATH: `/opt/homebrew/bin:/usr/local/bin:${homedir()}/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin`, ...o.env, TMPDIR: work, HOME: o.home ?? work, LANG: 'en_US.UTF-8', PYTHONIOENCODING: 'utf-8' };
    return await new Promise               (resolve => {
      const child = spawn('/usr/bin/sandbox-exec', args, { cwd: work, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0);
      let err = '';
      let big = false;
      const timer = setTimeout(() => child.kill('SIGKILL'), o.timeoutMs ?? 30000);
      child.stdout.on('data', (b        ) => { out = Buffer.concat([out, b]); if (out.length > MAX_OUTPUT_BYTES) { big = true; child.kill('SIGKILL'); } });
      child.stderr.on('data', (b        ) => { if (err.length < 4000) err += b.toString(); });
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
    rmSync(work, { recursive: true, force: true });
  }
}
