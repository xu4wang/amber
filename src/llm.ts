// The built-in large-model service (service name "llm"): a script hands Amber text and a prompt, Amber runs the
// model with its own credentials and returns text. The script never holds a credential or reaches the model's
// servers; it calls llm like any declared service (tickets, relay port, call counts), and Amber answers the call
// itself instead of forwarding it. The model gets no tools: text in, text out. Whether the session is kept on disk
// (Claude Code's own transcript) is the script's choice per call (persist), off unless asked.
import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export const LLM_SERVICE = 'llm';
export const LLM_MAX_PROMPT_CHARS = 150_000;   // the relay takes at most 512KB a request: about this many Chinese characters
export const LLM_MAX_SYSTEM_CHARS = 8_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface LlmConfig {
  /** The model CLI (Claude Code): an absolute path, since the service runs without the login shell's PATH. */
  command: string;
  /** Models a script may ask for; the first is the default. */
  models?: string[];
  maxConcurrent?: number;
  timeoutMs?: number;
  /** Which Claude login to use when the machine has several: the CLI's config directory (CLAUDE_CONFIG_DIR).
   *  Unset = the default one of the system user running Amber. Saved sessions (persist) go there too. */
  configDir?: string;
}

export interface LlmReply { status: number; body: Record<string, unknown> }

export class LlmService {
  private cfg: Required<Omit<LlmConfig, 'configDir'>> & Pick<LlmConfig, 'configDir'>;
  private workDir: string;
  private running = 0;
  private waiting: (() => void)[] = [];

  constructor(cfg: LlmConfig, dataDir: string) {
    this.cfg = { models: ['sonnet', 'haiku', 'opus'], maxConcurrent: 2, timeoutMs: 240_000, ...cfg };
    // An empty directory of its own: no project instructions or files for the model to pick up.
    this.workDir = join(dataDir, 'llm-work');
    mkdirSync(this.workDir, { recursive: true, mode: 0o700 });
  }

  get models(): string[] { return this.cfg.models; }

  /** One call: POST /complete {prompt, system?, model?, persist?} → {text, model, elapsedMs, sessionId?}. `signal`: the run ended. */
  async handle(method: string, path: string, body: Buffer, signal: AbortSignal): Promise<LlmReply> {
    if (method !== 'POST' || path.split('?')[0] !== '/complete') return { status: 404, body: { error: 'not_found', message: '只有 POST /complete' } };
    let req: any;
    try { req = JSON.parse(body.toString('utf8') || '{}'); } catch { return { status: 400, body: { error: 'bad_json', message: '请求体要是 JSON：{"prompt": "...", "system": "...", "model": "..."}' } }; }
    const prompt = typeof req?.prompt === 'string' ? req.prompt : '';
    const system = typeof req?.system === 'string' ? req.system : '';
    const model = req?.model === undefined ? this.cfg.models[0] : String(req.model);
    if (req?.persist !== undefined && typeof req.persist !== 'boolean') return { status: 400, body: { error: 'bad_request', message: 'persist 只能是 true 或 false' } };
    const persist = req?.persist === true;
    if (!prompt.trim()) return { status: 400, body: { error: 'bad_request', message: 'prompt 不能为空' } };
    if (prompt.length > LLM_MAX_PROMPT_CHARS) return { status: 413, body: { error: 'too_large', message: `prompt 最多 ${LLM_MAX_PROMPT_CHARS} 个字符，请分批` } };
    if (system.length > LLM_MAX_SYSTEM_CHARS) return { status: 413, body: { error: 'too_large', message: `system 最多 ${LLM_MAX_SYSTEM_CHARS} 个字符` } };
    if (!this.cfg.models.includes(model)) return { status: 400, body: { error: 'bad_model', message: `model 只能是：${this.cfg.models.join('、')}` } };
    const started = Date.now();
    // A call whose run ends while it waits never gets a slot, so it must not give one back.
    if (!(await this.slot(signal))) return { status: 499, body: { error: 'canceled', message: '这次运行已经结束' } };
    try {
      if (signal.aborted) return { status: 499, body: { error: 'canceled', message: '这次运行已经结束' } };
      const r = await this.run(prompt, system, model, persist, signal);
      return r.ok ? { status: 200, body: { text: r.text, model, elapsedMs: Date.now() - started, persist, ...(persist && r.sessionId ? { sessionId: r.sessionId } : {}) } } : { status: r.status, body: { error: r.error, message: r.message } };
    } finally { this.release(); }
  }

  /** True once a slot is held (give it back with release); false when the run ended while waiting. */
  private slot(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.running < this.cfg.maxConcurrent) { this.running++; return Promise.resolve(true); }
    return new Promise(resolve => {
      const go = () => { signal.removeEventListener('abort', drop); this.running++; resolve(true); };
      const drop = () => { this.waiting = this.waiting.filter(w => w !== go); resolve(false); };
      this.waiting.push(go);
      signal.addEventListener('abort', drop, { once: true });
    });
  }

  /** For tests and the admin's eye: calls running and waiting now. */
  get load(): { running: number; waiting: number } { return { running: this.running, waiting: this.waiting.length }; }

  private release(): void {
    this.running--;
    this.waiting.shift()?.();
  }

  private run(prompt: string, system: string, model: string, persist: boolean, signal: AbortSignal): Promise<{ ok: true; text: string; sessionId?: string } | { ok: false; status: number; error: string; message: string }> {
    // No tools, no settings files (no hooks, plugins or MCP servers): text in, text out. The session is saved only when asked.
    const args = ['-p', '--tools', '', ...(persist ? [] : ['--no-session-persistence']), '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json', '--model', model,
      ...(system ? ['--system-prompt', system] : [])];
    // Only what the CLI needs to find its login; nothing from Amber's own environment.
    const env: Record<string, string> = { HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' };
    const dir = this.cfg.configDir;
    if (dir !== undefined) {
      // A missing directory would make the CLI quietly start a fresh, logged-out one there.
      let ok = false;
      try { ok = typeof dir === 'string' && isAbsolute(dir) && statSync(dir).isDirectory(); } catch { /* missing */ }
      if (!ok) return Promise.resolve({ ok: false, status: 502, error: 'llm_unavailable', message: '大模型服务配置有误：llm.configDir 要是已存在目录的绝对路径' });
      env.CLAUDE_CONFIG_DIR = dir;
    }
    return new Promise(resolve => {
      const child = spawn(this.cfg.command, args, { cwd: this.workDir, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = Buffer.alloc(0), err = '', done = false;
      const finish = (r: Parameters<typeof resolve>[0]) => { if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(r); };
      const kill = () => { try { child.kill('SIGKILL'); } catch { /* gone */ } };
      const timer = setTimeout(() => { kill(); finish({ ok: false, status: 504, error: 'timeout', message: `大模型 ${Math.round(this.cfg.timeoutMs / 1000)} 秒内没有返回` }); }, this.cfg.timeoutMs);
      const abort = () => { kill(); finish({ ok: false, status: 499, error: 'canceled', message: '这次运行已经结束' }); };
      signal.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (c: Buffer) => { if (out.length < MAX_OUTPUT_BYTES) out = Buffer.concat([out, c]); });
      child.stderr.on('data', (c: Buffer) => { if (err.length < 4000) err += c.toString(); });
      child.on('error', e => finish({ ok: false, status: 502, error: 'llm_unavailable', message: `大模型服务不可用：${e.message}` }));
      child.on('close', code => {
        let j: any;
        try { j = JSON.parse(out.toString('utf8')); } catch { /* not JSON: an error before the model ran */ }
        if (j && j.is_error === false && typeof j.result === 'string') return finish({ ok: true, text: j.result, ...(typeof j.session_id === 'string' ? { sessionId: j.session_id } : {}) });
        const why = (j && typeof j.result === 'string' && j.result) || err.trim().split('\n').pop() || `退出码 ${code}`;
        finish({ ok: false, status: 502, error: 'llm_failed', message: `大模型调用失败：${why.slice(0, 300)}` });
      });
      child.stdin.on('error', () => { /* the CLI quit early; its exit says why */ });
      child.stdin.end(prompt);
    });
  }
}
