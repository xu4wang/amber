import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * Executors are registered by machine operators (never from chat).
 * A command may only combine registered executors.
 *
 * executors.json:
 * {
 *   "weather.current": {
 *     "kind": "script",
 *     "executable": "/usr/bin/python3",
 *     "fixedArgs": ["-I", "/path/weather.py", "--mode", "current"],
 *     "scriptFile": "/path/weather.py",          // optional; hashed so edits are detected
 *     "arguments": { "city": { "flag": "--city", "maxLength": 64, "pattern": "^[\\u4e00-\\u9fffA-Za-z -]{1,64}$" } },
 *     "timeoutMs": 15000,
 *     "maxOutputBytes": 16384,
 *     "sideEffect": "read"
 *   }
 * }
 */
export interface ExecutorArgDef { flag: string; maxLength?: number; pattern?: string }
export interface ExecutorDef {
  kind: 'script';
  executable: string;
  fixedArgs: string[];
  scriptFile?: string;
  arguments: Record<string, ExecutorArgDef>;
  timeoutMs?: number;
  maxOutputBytes?: number;
  sideEffect: 'read' | 'write';
}

export class ExecutorRegistry {
  private defs: Record<string, ExecutorDef> = {};
  private file: string;

  constructor(file: string) {
    this.file = file;
    this.reload();
  }

  reload(): void {
    this.defs = existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {};
  }

  list(): { id: string; sideEffect: string; arguments: string[] }[] {
    return Object.entries(this.defs).map(([id, d]) => ({ id, sideEffect: d.sideEffect, arguments: Object.keys(d.arguments ?? {}) }));
  }

  get(id: string): ExecutorDef | undefined {
    return this.defs[id];
  }

  /** Revision = hash of the definition plus the script file content, if any. */
  revision(id: string): string | undefined {
    const d = this.defs[id];
    if (!d) return undefined;
    const h = createHash('sha256').update(JSON.stringify(d));
    if (d.scriptFile && existsSync(d.scriptFile)) h.update(readFileSync(d.scriptFile));
    return h.digest('hex');
  }
}

export interface ExecResult { ok: boolean; stdout: string; error?: string }

/** Runs an executor without a shell: argument values are passed as argv items, never spliced into a command string. */
export function runExecutor(def: ExecutorDef, args: Record<string, string>, env: Record<string, string>): Promise<ExecResult> {
  const argv = [...def.fixedArgs];
  for (const [name, value] of Object.entries(args)) {
    const a = def.arguments[name];
    if (!a) return Promise.resolve({ ok: false, stdout: '', error: `unknown_argument:${name}` });
    if (a.maxLength !== undefined && value.length > a.maxLength) return Promise.resolve({ ok: false, stdout: '', error: `argument_too_long:${name}` });
    if (a.pattern && !new RegExp(a.pattern, 'u').test(value)) return Promise.resolve({ ok: false, stdout: '', error: `argument_invalid:${name}` });
    argv.push(a.flag, value);
  }
  const timeoutMs = def.timeoutMs ?? 15000;
  const maxBytes = def.maxOutputBytes ?? 16384;
  return new Promise(resolve => {
    const child = spawn(def.executable, argv, { shell: false, env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = Buffer.alloc(0);
    let err = '';
    let tooBig = false;
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (b: Buffer) => {
      out = Buffer.concat([out, b]);
      if (out.length > maxBytes) { tooBig = true; child.kill('SIGKILL'); }
    });
    child.stderr.on('data', (b: Buffer) => { if (err.length < 2000) err += b.toString(); });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, stdout: '', error: `spawn_failed:${e.message}` }); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (tooBig) return resolve({ ok: false, stdout: '', error: 'output_too_large' });
      if (signal) return resolve({ ok: false, stdout: '', error: `timeout_or_killed:${signal}` });
      if (code !== 0) return resolve({ ok: false, stdout: '', error: `exit_${code}` });
      resolve({ ok: true, stdout: out.toString('utf8') });
    });
  });
}
