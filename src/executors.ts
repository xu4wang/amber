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
//   result    the executor posts the output (already masked), Amber masks again, records and shows it.
// An offline executor fails the run immediately; a job that is not picked up or answered in time
// fails too. Nothing is queued for later.
import { createHash, randomUUID } from 'node:crypto';
import type { Store, ExecutorRow, ExecutorEnv } from './db.ts';
import type { Signer } from './identity.ts';
import type { Script, ScriptInput, ScriptResult } from './runner.ts';
import { parseEnv } from './runner.ts';
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
const MAX_PENDING = 10;
/** Jobs waiting for or running on one executor; more fail at once instead of piling up. */
export const MAX_JOBS_PER_EXECUTOR = 20;

export const envsHash = (name: string, envs: Record<string, ExecutorEnv>) => createHash('sha256').update(JSON.stringify({ name, envs })).digest('hex').slice(0, 16);

interface Waiter { resolve: (jobs: JobEnvelope[]) => void; timer: NodeJS.Timeout }
interface PendingJob { executorId: string; envelope: JobEnvelope; picked: boolean; resolve: (r: ScriptResult) => void; timer: NodeJS.Timeout }

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
    if (!e) return undefined;
    this.store.setExecutorStatus(e.id, 'revoked', admin);
    this.store.audit(admin, 'executor.revoke', { id: e.id, name });
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

  private finish(jobId: string, r: ScriptResult): void {
    const j = this.jobs.get(jobId);
    if (!j) return;
    clearTimeout(j.timer);
    this.jobs.delete(jobId);
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
    return `执行端 ${p.executor}（${e.machine}）的环境「${p.env}」，{WORKDIR} = ${d.workdir}${d.interpreter ? `，Python ${d.interpreter}` : ''}`;
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
    const envelope = this.signer.sealJob(e.id, e.boxPub, jobId, this.pickupMs * 2, { jobId, runId: input.runId, env: p.env, spec, specHash, input });
    this.store.audit(input.caller.unionId, 'executor.dispatch', { runId: input.runId, executor: e.id, name: e.name, env: p.env, jobId });
    return await new Promise<ScriptResult>(resolve => {
      const job: PendingJob = { executorId: e.id, envelope, picked: false, resolve, timer: setTimeout(() => {}, 0) };
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
    if (interpreter !== undefined && (!interpreter.startsWith('/') || !/python[0-9.]*$/.test(interpreter))) throw new AmberError('invalid', `环境「${k}」的 interpreter 要是 Python 的绝对路径`);
    out[k] = { workdir, ...(interpreter ? { interpreter } : {}) };
  }
  return out;
}

export { showFingerprint };
