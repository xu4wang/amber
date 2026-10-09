// Executors (D50): run a command on the machine that holds its data — a bot's ledger, an export
// directory — instead of on Amber's machine. Generic infrastructure: Amber knows nothing about the
// machine, the bot or the data format; a command names "<executor>/<environment>" in script.env, its
// sandbox policy uses {WORKDIR} for that environment's directory, and both are reviewed with the code.
//
// Lifecycle
//   register  once, when the executor is installed: it sends its name, its environments (name →
//             directory, optional Python) and two public keys, signed with the new key. Amber sends
//             every admin a card with the fingerprint; nothing is dispatched until one approves.
//             A new key pair, a changed environment list or a revocation needs a new approval.
//   poll      the executor keeps a long-poll open (this is also its heartbeat). Amber hands out jobs
//             signed with its own key and encrypted to the executor's key.
//   relay     a script's call to a registered service (D52): the executor forwards it, signed, to Amber,
//             which checks the job, the service and the call count and passes it to the local service.
//   result    the executor posts the output (already masked), Amber masks again, records and shows it.
// An offline executor fails the run immediately; a job that is not picked up or answered in time
// fails too. Nothing is queued for later.
import { createHash, randomUUID } from 'node:crypto';
import type { Store, ExecutorRow, ExecutorEnv } from './db.ts';
import type { Signer } from './identity.ts';
import type { Script, ScriptInput, ScriptResult } from './runner.ts';
import { parseEnv, serviceDef } from './runner.ts';
import { request as httpRequest } from 'node:http';
import { EXECUTOR_NAME, ENV_NAME, fingerprint, verifyRequest, pubFromB64, showFingerprint, REQUEST_SKEW_MS, type JobEnvelope } from './exec-proto.ts';
import { AmberError } from './engine.ts';

export const POLL_WAIT_MS = 25_000;
/** Seen within this long (or polling right now) = online. */
export const ONLINE_MS = 60_000;
/** A job must be picked up within this long. */
export const PICKUP_MS = 30_000;
/** Extra time for a picked-up job beyond the script's own timeout. */
export const RESULT_GRACE_MS = 30_000;
const MAX_ENVS = 20;
const MAX_ACCESS_PATHS = 100;
const MAX_PENDING = 10;
const MAX_NONCES = 50_000;
/** Jobs waiting for or running on one executor; more fail at once instead of piling up. */
export const MAX_JOBS_PER_EXECUTOR = 20;
const RELAY_MAX_REQUEST = 512 * 1024;
const RELAY_MAX_RESPONSE = 4 * 1024 * 1024;
const RELAY_TIMEOUT_MS = 60_000;

export const envsHash = (name: string, envs: Record<string, ExecutorEnv>) => createHash('sha256').update(JSON.stringify({ name, envs })).digest('hex').slice(0, 16);

interface Waiter { resolve: (jobs: JobEnvelope[]) => void; timer: NodeJS.Timeout }
interface PendingJob { executorId: string; envelope: JobEnvelope; picked: boolean; resolve: (r: ScriptResult) => void; timer: NodeJS.Timeout;
  /** Service requests in flight for this job; cancelled when the job ends (D52). */
  inflight?: Set<import('node:http').ClientRequest>;
  /** Relay calls left per declared service (D52): at most the declared count, one per token. */
  calls: Record<string, number> }

export class ExecutorHub {
  private store: Store;
  private signer: Signer;
  /** Sends a card to every admin. */
  notifyAdmins: (card: object) => Promise<void> = async () => {};
  approvalCard: (e: ExecutorRow, h: string) => object = () => ({});
  private nonces = new Map<string, number>();
  private waiters = new Map<string, Waiter>();
  private queues = new Map<string, JobEnvelope[]>();
  private jobs = new Map<string, PendingJob>();
  pollWaitMs = POLL_WAIT_MS;
  pickupMs = PICKUP_MS;
  onlineMs = ONLINE_MS;
  maxJobs = MAX_JOBS_PER_EXECUTOR;

  constructor(store: Store, signer: Signer) {
    this.store = store;
    this.signer = signer;
  }

  private fresh(nonce: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.nonces) if (now - t > 2 * REQUEST_SKEW_MS) this.nonces.delete(k);
    if (this.nonces.has(nonce)) return false;
    // Bounded: registration requests from any allowed IP with a fresh key also land here. Full = refuse (fail closed).
    if (this.nonces.size >= MAX_NONCES) throw new AmberError('busy', '请求太多，请稍后再试');
    this.nonces.set(nonce, now);
    return true;
  }

  private check(signPub: string, h: Record<string, string | undefined>, method: string, path: string, body: string): void {
    try { verifyRequest(signPub, h, method, path, body); } catch (e) { throw new AmberError('unauthorized', (e as Error).message); }
    if (!this.fresh(String(h['x-amber-nonce']))) throw new AmberError('unauthorized', '重复的请求');
  }

  /** A signed request from a registered executor (any status). */
  authenticate(h: Record<string, string | undefined>, method: string, path: string, body: string): ExecutorRow {
    const e = this.store.getExecutor(String(h['x-amber-executor'] ?? ''));
    if (!e) throw new AmberError('unauthorized', '未登记的执行端');
    this.check(e.signPub, h, method, path, body);
    this.store.touchExecutor(e.id);
    return e;
  }

  async register(h: Record<string, string | undefined>, method: string, path: string, raw: string, machine: string): Promise<{ id: string; status: string; fingerprint: string }> {
    let b: any;
    try { b = JSON.parse(raw); } catch { throw new AmberError('bad_json', '请求不是合法的 JSON'); }
    const name = String(b?.name ?? '');
    if (!EXECUTOR_NAME.test(name)) throw new AmberError('invalid', '执行端名称只能用小写字母、数字和连字符，最多 32 个字符');
    const envs = validateEnvs(b?.envs);
    const signPub = String(b?.signPub ?? ''), boxPub = String(b?.boxPub ?? '');
    try { pubFromB64(signPub, 'ed25519'); pubFromB64(boxPub, 'x25519'); } catch (e) { throw new AmberError('invalid', `公钥不对：${(e as Error).message}`); }
    // Proof of possession: the request is signed with the key being registered.
    this.check(signPub, h, method, path, raw);
    const fp = fingerprint(signPub, boxPub);
    const id = fp.slice(0, 16);
    if (h['x-amber-executor'] !== id) throw new AmberError('unauthorized', '执行端 id 与公钥不符');
    const version = String(b?.version ?? '').slice(0, 40);
    const prev = this.store.getExecutor(id);
    const same = prev && prev.name === name && envsHash(prev.name, prev.envs) === envsHash(name, envs);
    // Asking again with the same content changes nothing (a rejected or revoked key stays so: a new key is a new request).
    if (prev && (same || prev.status === 'rejected' || prev.status === 'revoked')) {
      this.store.touchExecutor(id);
      return { id, status: prev.status, fingerprint: fp };
    }
    if (this.store.listExecutors().filter(x => x.status === 'pending').length >= MAX_PENDING) throw new AmberError('busy', '等待批准的执行端太多，请先让管理员处理');
    // A changed environment list loses the approval until an admin approves the new one.
    if (prev) this.dropQueue(id);
    this.store.putExecutor({ id, name, fingerprint: fp, signPub, boxPub, envs, machine, version });
    this.store.touchExecutor(id);
    this.store.audit(null, 'executor.register', { id, name, machine, envs: Object.keys(envs), fingerprint: fp, replaces: prev ? prev.status : null });
    const row = this.store.getExecutor(id)!;
    await this.notifyAdmins(this.approvalCard(row, envsHash(name, envs))).catch(() => {});
    return { id, status: 'pending', fingerprint: fp };
  }

  /** An admin's decision on the card. `h` binds it to what the card showed. */
  decide(id: string, h: string, approve: boolean, admin: string): { ok: boolean; message: string; row?: ExecutorRow } {
    const e = this.store.getExecutor(id);
    if (!e) return { ok: false, message: '这个执行端不存在' };
    if (e.status !== 'pending') return { ok: false, message: `这个执行端已经${statusText(e.status)}`, row: e };
    if (envsHash(e.name, e.envs) !== h) return { ok: false, message: '执行端的登记内容已经变了，请看新的卡片', row: e };
    if (approve) {
      // One approved key pair per name: the new one replaces the old.
      const old = this.store.approvedExecutor(e.name);
      if (old && old.id !== id) { this.store.setExecutorStatus(old.id, 'revoked', admin); this.dropQueue(old.id); this.store.audit(admin, 'executor.revoke', { id: old.id, name: old.name, replacedBy: id }); }
    }
    this.store.setExecutorStatus(id, approve ? 'approved' : 'rejected', admin);
    this.wake(id);
    this.store.audit(admin, approve ? 'executor.approve' : 'executor.reject', { id, name: e.name, fingerprint: e.fingerprint, envs: e.envs });
    if (!approve) this.dropQueue(id);
    return { ok: true, message: approve ? '已批准' : '已拒绝', row: this.store.getExecutor(id) };
  }

  revoke(name: string, admin: string): ExecutorRow | undefined {
    const e = this.store.approvedExecutor(name);
    return e ? this.revokeId(e.id, admin) : undefined;
  }

  /** Only an approved executor can be revoked. */
  revokeId(id: string, admin: string): ExecutorRow | undefined {
    const e = this.store.getExecutor(id);
    if (!e || e.status !== 'approved') return undefined;
    this.store.setExecutorStatus(e.id, 'revoked', admin);
    this.store.audit(admin, 'executor.revoke', { id: e.id, name: e.name });
    this.dropQueue(e.id);
    return this.store.getExecutor(e.id);
  }

  /** Ends a waiting poll early, so the executor sees a new status at once. */
  private wake(id: string): void {
    const w = this.waiters.get(id);
    if (w) { clearTimeout(w.timer); this.waiters.delete(id); w.resolve([]); }
  }

  private dropQueue(id: string): void {
    this.wake(id);
    this.queues.delete(id);
    for (const [jobId, j] of this.jobs) if (j.executorId === id) this.finish(jobId, { ok: false, content: '', error: '执行端已被撤销' });
  }

  online(e: ExecutorRow): boolean { return this.waiters.has(e.id) || (e.lastSeen !== null && Date.now() - e.lastSeen < this.onlineMs); }

  /** Long poll: returns with jobs, or empty after the wait; a pending executor is woken by the admin's decision. */
  async poll(e: ExecutorRow): Promise<{ status: string; jobs?: JobEnvelope[] }> {
    if (e.status === 'rejected' || e.status === 'revoked') return { status: e.status };
    if (e.status === 'approved') {
      const ready = (this.queues.get(e.id) ?? []).filter(j => this.markPicked(j));
      this.queues.delete(e.id);
      if (ready.length) return { status: 'approved', jobs: ready };
    }
    const prev = this.waiters.get(e.id);
    if (prev) { clearTimeout(prev.timer); prev.resolve([]); }
    const jobs = await new Promise<JobEnvelope[]>(resolve => {
      const timer = setTimeout(() => { if (this.waiters.get(e.id)?.timer === timer) this.waiters.delete(e.id); resolve([]); }, this.pollWaitMs);
      this.waiters.set(e.id, { resolve, timer });
    });
    this.store.touchExecutor(e.id);
    const now = this.store.getExecutor(e.id)!;
    if (now.status !== 'approved') return { status: now.status };
    return { status: 'approved', jobs: jobs.filter(j => this.markPicked(j)) };
  }

  private markPicked(env: JobEnvelope): boolean {
    const j = this.jobs.get(env.jobId);
    if (!j || j.picked) return false;
    j.picked = true;
    return true;
  }

  result(e: ExecutorRow, raw: string): { ok: boolean } {
    let b: any;
    try { b = JSON.parse(raw); } catch { throw new AmberError('bad_json', '请求不是合法的 JSON'); }
    const j = this.jobs.get(String(b?.jobId ?? ''));
    // Late, unknown or someone else's: ignored (the run has already failed or belongs elsewhere).
    if (!j || j.executorId !== e.id || !j.picked) return { ok: false };
    const content = typeof b.content === 'string' ? b.content.slice(0, 300 * 1024) : '';
    this.finish(b.jobId, b.ok === true ? { ok: true, content } : { ok: false, content: '', error: `执行端：${String(b.error ?? '失败').slice(0, 1000)}` });
    return { ok: true };
  }

  /** A script's call to a registered service, relayed by the executor running its job (D52).
   *  Amber does not read the request or the response; the service checks the token itself. */
  async relay(e: ExecutorRow, raw: string): Promise<{ ok: boolean; status?: number; contentType?: string; body?: string; error?: string; message?: string }> {
    let b: any;
    try { b = JSON.parse(raw); } catch { throw new AmberError('bad_json', '请求不是合法的 JSON'); }
    const j = this.jobs.get(String(b?.jobId ?? ''));
    // Only the executor this job went to, only while it is running.
    if (!j || j.executorId !== e.id || !j.picked) throw new AmberError('forbidden', '没有这个正在运行的任务');
    const name = String(b?.service ?? '');
    const d = serviceDef(name);
    if (!(name in j.calls) || !d || d.executor !== true) throw new AmberError('forbidden', `这条指令没有声明服务 ${name}，或这个服务不允许在执行端上调用`);
    if (j.calls[name] <= 0) throw new AmberError('forbidden', `服务 ${name} 的调用次数已用完`);
    const method = String(b?.method ?? '');
    const path = String(b?.path ?? '');
    if (!['GET', 'POST'].includes(method)) throw new AmberError('invalid', '只支持 GET / POST');
    if (!/^\/[\x21-\x7e]*$/.test(path) || path.length > 2048 || /(^|\/)\.\.(\/|\?|$)/.test(path)) throw new AmberError('invalid', '请求路径不对');
    const body = Buffer.from(typeof b?.body === 'string' ? b.body : '', 'base64');
    if (body.length > RELAY_MAX_REQUEST) throw new AmberError('too_large', '请求太大');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(b?.headers ?? {})) {
      const key = k.toLowerCase();
      if (['authorization', 'content-type', 'accept'].includes(key) && typeof v === 'string' && v.length < 8192 && !/[\r\n]/.test(v)) headers[key] = v;
    }
    j.calls[name]--;
    const inflight = j.inflight ?? (j.inflight = new Set());
    this.store.audit(null, 'executor.relay', { jobId: b.jobId, executor: e.id, service: name, method, path: path.split('?')[0] });
    return await new Promise(resolve => {
      const req = httpRequest({ ...(d.unixSocket ? { socketPath: d.unixSocket } : { host: '127.0.0.1', port: d.tcpPort }), method, path, headers: { ...headers, 'content-length': String(body.length) }, timeout: RELAY_TIMEOUT_MS }, res => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; if (n > RELAY_MAX_RESPONSE) { req.destroy(); resolve({ ok: false, error: 'too_large', message: `服务 ${name} 的响应超过 ${RELAY_MAX_RESPONSE / 1024 / 1024}MB` }); } else chunks.push(c); });
        res.on('end', () => { if (n <= RELAY_MAX_RESPONSE) resolve({ ok: true, status: res.statusCode ?? 502, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('base64') }); });
      });
      inflight.add(req);
      req.on('close', () => inflight.delete(req));
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', err => resolve({ ok: false, error: 'service_unavailable', message: `服务 ${name} 不可用：${err.message}` }));
      req.end(body);
    });
  }

  private finish(jobId: string, r: ScriptResult): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    clearTimeout(j.timer);
    this.jobs.delete(jobId);
    // A job that ended (result, timeout, revocation) stops its service requests too.
    for (const req of j.inflight ?? []) req.destroy(new Error('job ended'));
    j.resolve(r);
  }

  /** Where a command's script.env points, for cards and review documents. */
  describe(env: string): string {
    const p = parseEnv(env);
    if (!p) return env;
    const e = this.store.approvedExecutor(p.executor);
    if (!e) return `执行端 ${p.executor} 的环境「${p.env}」（这个执行端还没有登记或没有批准）`;
    const d = e.envs[p.env];
    if (!d) return `执行端 ${p.executor} 的环境「${p.env}」（这个执行端没有这个环境）`;
    return `执行端 ${p.executor}（${e.machine}）的环境「${p.env}」${d.source ? `（${d.source}）` : ''}：${describeEnvAccess(d)}${d.interpreter ? `；Python ${d.interpreter}` : ''}`;
  }

  /** Runs a remote command: never on Amber's machine. */
  async run(script: Script, spec: { name: string; params: unknown; script: unknown; options: unknown }, specHash: string, input: ScriptInput): Promise<ScriptResult> {
    const p = parseEnv(script.env ?? '');
    if (!p) return { ok: false, content: '', error: '执行位置（env）写得不对' };
    const e = this.store.approvedExecutor(p.executor);
    if (!e) return { ok: false, content: '', error: `执行端 ${p.executor} 还没有登记或没有被管理员批准` };
    if (!e.envs[p.env]) return { ok: false, content: '', error: `执行端 ${p.executor} 没有环境「${p.env}」` };
    if (!this.online(e)) return { ok: false, content: '', error: `执行端 ${p.executor} 离线（最后在线：${e.lastSeen ? new Date(e.lastSeen).toISOString() : '从未'}），这次没有执行` };
    if ([...this.jobs.values()].filter(j => j.executorId === e.id).length >= this.maxJobs) return { ok: false, content: '', error: `执行端 ${p.executor} 正在处理的任务太多，这次没有执行，请稍后再试` };
    const jobId = randomUUID();
    const timeoutMs = (script.timeoutMs ?? 30000) + RESULT_GRACE_MS;
    // Services: only the tokens travel; the executor gives the script a local port and relays the calls here.
    const remoteInput = input.services ? { ...input, services: Object.fromEntries(Object.entries(input.services).map(([n, s]) => [n, { tokens: s.tokens }])) } : input;
    const envelope = this.signer.sealJob(e.id, e.boxPub, jobId, this.pickupMs * 2, { jobId, runId: input.runId, env: p.env, spec, specHash, input: remoteInput });
    this.store.audit(input.caller.unionId, 'executor.dispatch', { runId: input.runId, executor: e.id, name: e.name, env: p.env, jobId });
    return await new Promise<ScriptResult>(resolve => {
      const calls = Object.fromEntries(Object.entries(script.services ?? {}).map(([n, u]) => [n, u.calls]));
      const job: PendingJob = { executorId: e.id, envelope, picked: false, resolve, timer: setTimeout(() => {}, 0), calls };
      const fail = (msg: string) => this.finish(jobId, { ok: false, content: '', error: msg });
      job.timer = setTimeout(() => {
        if (!job.picked) return fail(`执行端 ${p.executor} 没有取走任务（可能刚刚离线），这次没有执行`);
        job.timer = setTimeout(() => fail(`执行端 ${p.executor} 没有在时限内返回结果`), timeoutMs);
      }, this.pickupMs);
      this.jobs.set(jobId, job);
      const w = this.waiters.get(e.id);
      if (w) { clearTimeout(w.timer); this.waiters.delete(e.id); w.resolve([envelope]); }
      else this.queues.set(e.id, [...(this.queues.get(e.id) ?? []), envelope]);
    });
  }

  close(): void {
    for (const [id, w] of this.waiters) { clearTimeout(w.timer); w.resolve([]); this.waiters.delete(id); }
    for (const id of [...this.jobs.keys()]) this.finish(id, { ok: false, content: '', error: 'Amber 正在重启' });
  }
}

export function statusText(s: string): string {
  return ({ pending: '等待管理员批准', approved: '批准', rejected: '被拒绝', revoked: '被撤销' } as Record<string, string>)[s] ?? s;
}

function validateEnvs(x: unknown): Record<string, ExecutorEnv> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new AmberError('invalid', 'envs 要写成 {"环境名": {"workdir": "/绝对路径"}}');
  const out: Record<string, ExecutorEnv> = {};
  const entries = Object.entries(x as Record<string, any>);
  if (!entries.length || entries.length > MAX_ENVS) throw new AmberError('invalid', `执行端要有 1–${MAX_ENVS} 个环境`);
  for (const [k, v] of entries) {
    if (!ENV_NAME.test(k)) throw new AmberError('invalid', `环境名不对：${k}`);
    const workdir = String(v?.workdir ?? '');
    if (!workdir.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(workdir) || workdir === '/' || /[\0\n\r]/.test(workdir)) throw new AmberError('invalid', `环境「${k}」的 workdir 要是绝对路径，不能是根目录：${workdir}`);
    const interpreter = v?.interpreter === undefined ? undefined : String(v.interpreter);
    if (interpreter !== undefined && (!interpreter.startsWith('/') || !/\/python(3(\.\d+)?)?$/.test(interpreter))) throw new AmberError('invalid', `环境「${k}」的 interpreter 要是 Python 的绝对路径`);
    const access = v?.access === undefined ? undefined : validateRemoteAccess(k, v.access);
    const vars = v?.vars === undefined ? undefined : validateVars(k, v.vars);
    const source = v?.source === undefined ? undefined : String(v.source).slice(0, 200);
    if (v?.realHome !== undefined && typeof v.realHome !== 'boolean') throw new AmberError('invalid', `环境「${k}」的 realHome 只能是 true/false`);
    out[k] = { workdir, ...(interpreter ? { interpreter } : {}), ...(access ? { access } : {}), ...(vars ? { vars } : {}), ...(source ? { source } : {}), ...(v?.realHome === true ? { realHome: true } : {}) };
  }
  return out;
}

/** The executor resolves and checks paths against its own protected dirs; here: shape, absolute, no `..`, not `/`. */
function validateRemoteAccess(env: string, x: any): NonNullable<ExecutorEnv['access']> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new AmberError('invalid', `环境「${env}」的 access 格式不对`);
  const out: NonNullable<ExecutorEnv['access']> = {};
  let n = 0;
  for (const key of Object.keys(x)) if (!['readOnly', 'readWrite', 'deny'].includes(key)) throw new AmberError('invalid', `环境「${env}」的 access 里不认识的字段：${key}`);
  for (const key of ['readOnly', 'readWrite', 'deny'] as const) {
    if (x[key] === undefined) continue;
    if (!Array.isArray(x[key])) throw new AmberError('invalid', `环境「${env}」的 access.${key} 要是路径数组`);
    const list = x[key].map(String);
    for (const p of list) if (!p.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(p) || /[\0\n\r]/.test(p) || (key !== 'deny' && p === '/')) throw new AmberError('invalid', `环境「${env}」的路径不对：${p}`);
    n += list.length;
    if (list.length) out[key] = list;
  }
  if (n > MAX_ACCESS_PATHS) throw new AmberError('invalid', `环境「${env}」的路径太多（最多 ${MAX_ACCESS_PATHS} 条）`);
  return out;
}

const RESERVED_VARS = /^(PATH|HOME|TMPDIR|WORKDIR|LANG|PYTHON.*|DYLD_.*|LD_.*|NODE_OPTIONS)$/;
function validateVars(env: string, x: any): Record<string, string> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new AmberError('invalid', `环境「${env}」的 vars 格式不对`);
  const out: Record<string, string> = {};
  const entries = Object.entries(x);
  if (entries.length > 20) throw new AmberError('invalid', `环境「${env}」的环境变量太多（最多 20 个）`);
  for (const [k, v] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || RESERVED_VARS.test(k)) throw new AmberError('invalid', `环境「${env}」不能设置环境变量 ${k}`);
    if (typeof v !== 'string') throw new AmberError('invalid', `环境「${env}」的环境变量 ${k} 的值要是字符串`);
    const s = v;
    if (s.length > 1024 || /[\0\n\r]/.test(s)) throw new AmberError('invalid', `环境「${env}」的环境变量 ${k} 的值不对`);
    out[k] = s;
  }
  return out;
}

/** An environment's effective access: absent = {WORKDIR} read-write. */
export const effectiveAccess = (e: ExecutorEnv): NonNullable<ExecutorEnv['access']> => e.access ?? { readWrite: [e.workdir] };

/** Paths in a credential store, recognised by name on any machine (for the warning on approval cards). */
const CRED_NAMES = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.netrc|\.git-credentials|\.npmrc|\.pypirc|\.docker|\.kube|\.password-store|\.1password|\.lark-cli|\.lark-cli-bots|\.botmux|\.claude|\.claude\.json|\.codex|Keychains|Cookies|lark-cli|gh|glab-cli|gcloud|1Password)(\/|$)/;
/** Credential files inside otherwise readable toolchain dirs (denied by the sandbox baseline). */
const CRED_FILES = /\/(\.cargo\/credentials(\.toml)?|\.gem\/credentials|\.m2\/settings(-security)?\.xml|\.gradle\/gradle\.properties)$/;
export function credentialPaths(e: ExecutorEnv): string[] {
  const a = effectiveAccess(e);
  return [...(a.readWrite ?? []), ...(a.readOnly ?? [])].filter(p => CRED_NAMES.test(p) || CRED_FILES.test(p));
}

/** One line: what scripts in this environment can access. */
export function describeEnvAccess(e: ExecutorEnv): string {
  const a = effectiveAccess(e);
  const parts = [a.readWrite?.length ? `读写 ${a.readWrite.join('、')}` : '', a.readOnly?.length ? `只读 ${a.readOnly.join('、')}` : '', a.deny?.length ? `禁止 ${a.deny.join('、')}` : ''].filter(Boolean);
  return (parts.join('；') || '不能访问任何数据') + `（{WORKDIR} = ${e.workdir}）`;
}

export { showFingerprint };
