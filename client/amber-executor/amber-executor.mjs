#!/usr/bin/env node
// Amber executor (D50): runs reviewed Amber commands on this machine, next to the data they need.
// No dependencies beyond Node ≥ 22. See docs/executor.md.
//
//   amber-executor init --name <name> [--amber <url>]     keys + config (once)
//   amber-executor env import <file.json> [--name <env>]  an environment from a definition file (D51): the one format,
//                                                         e.g. exported from a botmux bot by export-botmux-env.mjs
//   Environments are the files in ~/.config/amber-executor/envs/: <name>.json, one definition each (D51/D53).
//   The executor re-reads the folder every 5 minutes: a new file is a new environment (needs approval); changes
//   to an existing one's paths / vars / Python apply at once (admins notified); other changes need approval.
//   amber-executor env set <env> <dir> [--python <p>] [--readonly] [--print]   writes the simplest definition
//   amber-executor env import <file.json> [--name <env>]  checks a definition and puts it in the folder
//   amber-executor env export <env>                       prints an environment's file
//   amber-executor env show | env rm <env>
//   amber-executor status                                  register / show fingerprint and approval
//   amber-executor run                                     long-poll Amber and run jobs (launchd runs this)
//   amber-executor install-launchd | uninstall-launchd
//
// Every job is signed by Amber (key pinned at init) and encrypted to this executor's key. Before
// running, the executor checks the signature, the addressee, the expiry, that it has not seen the job
// before, and recomputes the spec hash; then runs the code in a sandbox built from the environment's
// approved access (same rules as Amber, lib/ is generated from Amber's sources). Commands declare no paths.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { newExecutorKeys, keyFromPem, pubB64, fingerprint, showFingerprint, signRequest, openJob, specHashOf, redact, verifyRelayResponse, EXECUTOR_NAME, ENV_NAME } from './lib/exec-proto.mjs';
import { randomBytes } from 'node:crypto';
import { setSandboxContext, validateEnvAccess, buildPolicy, compileToSeatbelt, normalizePath, hardDenyRoots, credentialGrants, describeAccess } from './lib/sandbox-policy.mjs';
import { runSandboxed } from './lib/sandbox-run.mjs';

export const VERSION = '1';
const DIR = process.env.AMBER_EXECUTOR_DIR ?? join(homedir(), '.config', 'amber-executor');
const ENV_DIR = join(DIR, 'envs');
const P = { envCache: join(DIR, 'envs.last-good.json'), config: join(DIR, 'config.json'), sign: join(DIR, 'sign-key.pem'), box: join(DIR, 'box-key.pem'), amber: join(DIR, 'amber-key.json'), seen: join(DIR, 'seen-jobs.json') };
const DEFAULT_PYTHON = '/usr/bin/python3';
/** Jobs at once on this machine, unless config.json sets maxParallel (1–64). Amber also caps each executor;
 *  whichever is lower applies (a job over this one is refused here and fails at once). */
const MAX_PARALLEL_DEFAULT = 4;
const maxParallel = cfg => { const n = Number(cfg?.maxParallel); return Number.isInteger(n) && n >= 1 && n <= 64 ? n : MAX_PARALLEL_DEFAULT; };
const FOLLOW_MS = Number(process.env.AMBER_EXECUTOR_FOLLOW_MS) || 300_000;
const LABEL = 'com.amber.executor';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = m => { console.error(`amber-executor: ${m}`); process.exit(1); };
const isDir = p => { try { return statSync(p).isDirectory(); } catch { return false; } };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writePrivate = (p, s) => { const t = `${p}.tmp`; writeFileSync(t, s, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, p); };

function loadConfig() {
  const c = readJson(P.config, null);
  if (!c) die(`还没初始化：先运行 amber-executor init --name <名称>（配置目录 ${DIR}）`);
  // Environments live in the envs/ folder, one definition file each (D53). Older configs kept them inside
  // config.json: move them out once, unchanged.
  if (c.envs && Object.keys(c.envs).length) {
    mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 });
    for (const [name, v] of Object.entries(c.envs)) {
      const f = join(ENV_DIR, `${name}.json`);
      if (!existsSync(f)) writePrivate(f, JSON.stringify(toDef(name, v), null, 2) + '\n');
    }
    delete c.envs;
    writePrivate(P.config, JSON.stringify(c, null, 2));
  }
  c.envs = loadEnvs();
  return c;
}

/** The environments: every <name>.json in envs/. A file that does not pass the checks keeps its last good
 *  version (logged); a file that is gone removes its environment. Each entry records the file it came from. */
export function loadEnvs() {
  const cache = readJson(P.envCache, {});
  const out = {};
  let files = [];
  try { files = readdirSync(ENV_DIR).filter(f => f.endsWith('.json')).sort(); } catch { /* no folder yet */ }
  for (const f of files) {
    const name = f.slice(0, -5), file = join(ENV_DIR, f);
    if (!ENV_NAME.test(name)) { log('env file skipped (bad name)', f); continue; }
    try { out[name] = { ...buildEntry(JSON.parse(readFileSync(file, 'utf8'))), follow: file }; }
    catch (e) { log('env file not valid, keeping the last good version', f, e.message); if (cache[name]) out[name] = cache[name]; }
  }
  if (JSON.stringify(out) !== JSON.stringify(cache)) { mkdirSync(DIR, { recursive: true, mode: 0o700 }); writePrivate(P.envCache, JSON.stringify(out)); }
  return out;
}

export function identity() {
  const sign = keyFromPem(readFileSync(P.sign, 'utf8')), box = keyFromPem(readFileSync(P.box, 'utf8'));
  const signPub = pubB64(createPublicKey(sign)), boxPub = pubB64(createPublicKey(box));
  const fp = fingerprint(signPub, boxPub);
  return { sign, box, signPub, boxPub, fp, id: fp.slice(0, 16) };
}

function amberKey() {
  const jwk = readJson(P.amber, null);
  if (!jwk) die('没有 Amber 的公钥：重新运行 init');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

async function call(cfg, me, path, body, timeoutMs = 20_000) {
  const raw = JSON.stringify(body ?? {});
  const r = await fetch(cfg.amber + path, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', ...signRequest(me.sign, me.id, 'POST', path, raw) }, signal: AbortSignal.timeout(timeoutMs) });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!j.ok && r.status !== 200) throw new Error(j.message ?? j.error ?? `HTTP ${r.status}`);
  return j;
}

const register = (cfg, me) => call(cfg, me, '/v1/executor/register', { name: cfg.name, envs: cfg.envs, signPub: me.signPub, boxPub: me.boxPub, version: VERSION });

// ---------- jobs

/** Jobs already accepted (jobId → expiry), so a replayed envelope never runs twice, even across restarts. */
export function firstSeen(jobId, exp) {
  const now = Date.now();
  const seen = Object.fromEntries(Object.entries(readJson(P.seen, {})).filter(([, e]) => e > now));
  if (seen[jobId]) return false;
  seen[jobId] = exp;
  writePrivate(P.seen, JSON.stringify(seen));
  return true;
}

/** Everything a job must satisfy before it runs. Returns how to run it, or throws with the reason. */
export function prepare(cfg, payload) {
  if (specHashOf(payload.spec) !== payload.specHash) throw new Error('规格哈希不符（代码与审核通过的版本不一致）');
  const s = payload.spec?.script;
  if (s?.kind !== 'script' || s.lang !== 'python' || typeof s.code !== 'string') throw new Error('不支持的脚本类型');
  if (s.env !== `${cfg.name}/${payload.env}`) throw new Error(`任务的执行位置 ${s.env} 不是本执行端的环境`);
  const env = cfg.envs?.[payload.env];
  if (!env) throw new Error(`本执行端没有环境「${payload.env}」`);
  if (s.sandbox !== undefined) throw new Error('应用不再声明 sandbox：访问权限由运行环境决定');
  const workdir = normalizePath(env.workdir);
  if (!isDir(workdir)) throw new Error(`环境的 workdir 不是已存在的目录：${workdir}`);
  // The environment's approved access, re-checked here against this machine's protected dirs.
  const access = validateEnvAccess(env.access ?? { readWrite: [workdir] }, { workdir });
  const python = normalizePath(s.interpreter ?? env.interpreter ?? DEFAULT_PYTHON);
  if (hardDenyRoots().some(r => python === r || python.startsWith(r + '/'))) throw new Error('解释器在受保护的目录里');
  if (!/\/python(3(\.\d+)?)?$/.test(python)) throw new Error('解释器要是 Python（以 python、python3 或 python3.x 结尾）');
  const vars = checkVars(env.vars);
  // Amber sends the limit for this run (the admin's run limits applied); older Amber did not, so fall back to the app's own.
  const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs ?? s.timeoutMs) || 30000, 1000), 1_800_000);
  return { code: s.code, python, timeoutMs, workdir, vars, realHome: env.realHome === true, profileFor: (dir, tcpPorts = []) => compileToSeatbelt(buildPolicy({ runDir: dir, access }), { all: !!s.network, tcpPorts }) };
}

const RESERVED_VARS = /^(PATH|HOME|TMPDIR|WORKDIR|LANG|PYTHON.*|DYLD_.*|LD_.*|NODE_OPTIONS)$/;
function checkVars(v) {
  const out = {};
  if (v === undefined || v === null) return out;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error('vars 要写成 {"名字": "值"}');
  const entries = Object.entries(v);
  if (entries.length > 20) throw new Error('环境变量最多 20 个');
  for (const [k, x] of entries) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || RESERVED_VARS.test(k)) throw new Error(`环境变量 ${k} 不能设置`);
    if (typeof x !== 'string' || x.length > 1024 || /[\0\n\r]/.test(x)) throw new Error(`环境变量 ${k} 的值要是字符串，最多 1024 个字符，不能含换行`);
    out[k] = x;
  }
  return out;
}

export async function handle(cfg, me, amberPub, envelope) {
  let payload, secrets = {}, relays = { ports: [], close() {} };
  try {
    payload = openJob(amberPub, me.id, me.box, envelope);
    if (!firstSeen(envelope.jobId, envelope.exp)) return log('job replayed, ignored', envelope.jobId);
    secrets = payload.input?.secrets ?? {};
    const job = prepare(cfg, payload);
    log('job start', envelope.jobId, payload.spec.name, payload.env, `run ${payload.runId}`);
    // Declared services (D52): a local port per service, relayed to Amber; the script only reaches these ports.
    relays = await startRelays(cfg, me, amberPub, envelope.jobId, payload.input?.services);
    const input = relays.services ? { ...payload.input, services: relays.services } : payload.input;
    const r = await runSandboxed({ code: job.code, python: job.python, profileFor: dir => job.profileFor(dir, relays.ports), input, timeoutMs: job.timeoutMs, env: { ...job.vars, WORKDIR: job.workdir }, ...(job.realHome ? { home: homedir() } : {}) });
    // The log never sees a secret: the error text can contain one (e.g. an exception message).
    log('job done', envelope.jobId, r.ok ? 'ok' : `failed: ${redact(r.error ?? '', secrets)}`);
    await call(cfg, me, '/v1/executor/result', { jobId: envelope.jobId, ok: r.ok, content: redact(r.content, secrets), ...(r.error ? { error: redact(r.error, secrets) } : {}) });
  } catch (e) {
    log('job refused', envelope?.jobId, redact(e.message, secrets));
    // Only answer jobs that were really for us (signature checked); anything else is dropped.
    if (payload) await call(cfg, me, '/v1/executor/result', { jobId: envelope.jobId, ok: false, error: redact(e.message, secrets) }).catch(() => {});
  } finally {
    relays.close();
  }
}

const RELAY_MAX_REQUEST = 512 * 1024;
/** One local HTTP port per declared service. Each request is passed, signed and unchanged, to Amber's relay
 *  for this job; Amber checks it and forwards it to the registered service. The script's code is the same as
 *  on Amber's own machine: services[name].tcpPort is this port. */
export async function startRelays(cfg, me, amberPub, jobId, services) {
  const names = Object.keys(services ?? {});
  if (!names.length) return { ports: [], close() {} };
  const servers = [], out = {};
  for (const name of names) {
    // Only the job's own script holds its tokens: a request must present one it has not used yet, so
    // other processes on this machine cannot use the port or spend the job's calls.
    const unused = new Set(services[name]?.tokens ?? []);
    const srv = createServer((req, res) => {
      const chunks = [];
      let n = 0, big = false;
      const reply = (status, type, body) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': type }); res.end(body); } };
      req.on('data', c => { n += c.length; if (n > RELAY_MAX_REQUEST) { big = true; chunks.length = 0; } else if (!big) chunks.push(c); });
      req.on('end', async () => {
        if (big) return reply(413, 'application/json', JSON.stringify({ error: 'too_large', message: `请求超过 ${RELAY_MAX_REQUEST / 1024}KB` }));
        const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
        const tok = [...unused].find(t => auth === `Amber ${t}` || auth.endsWith(` ${t}`));
        if (!tok) return reply(403, 'application/json', JSON.stringify({ error: 'relay_refused', message: '请求没有带这次任务未用过的凭证' }));
        unused.delete(tok);
        try {
          const headers = {};
          for (const k of ['authorization', 'content-type', 'accept']) if (typeof req.headers[k] === 'string') headers[k] = req.headers[k];
          const reqId = randomBytes(16).toString('hex');
          const r = await call(cfg, me, '/v1/executor/relay', { jobId, reqId, service: name, method: req.method, path: req.url, headers, body: Buffer.concat(chunks).toString('base64') }, 75_000);
          // Only a response Amber signed for this request reaches the script (nothing on the way can alter it).
          if (!verifyRelayResponse(amberPub, jobId, reqId, r)) return reply(502, 'application/json', JSON.stringify({ error: 'relay_unverified', message: '转发的响应签名不对' }));
          if (!r.ok) return reply(502, 'application/json', JSON.stringify({ error: r.error ?? 'relay_failed', message: r.message ?? '' }));
          reply(r.status, r.contentType || 'application/octet-stream', Buffer.from(r.body ?? '', 'base64'));
        } catch (e) {
          // Amber's refusals are not signed: keep their text in our log, give the script a fixed message only.
          log('relay refused', jobId, name, e.message);
          reply(403, 'application/json', JSON.stringify({ error: 'relay_refused', message: 'Amber 拒绝了这次转发（原因见执行端日志）' }));
        }
      });
    });
    // Bounded: a few connections, and requests that do not finish in time are dropped.
    srv.maxConnections = 8;
    srv.headersTimeout = 10_000;
    srv.requestTimeout = 30_000;
    await new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(0, '127.0.0.1', resolve); });
    servers.push(srv);
    out[name] = { tokens: services[name]?.tokens ?? [], tcpPort: srv.address().port };
  }
  return { ports: servers.map(s => s.address().port), services: out, close() { for (const s of servers) { s.close(); s.closeAllConnections?.(); } } };
}

/** Refuses a job because this executor is full; only for jobs really addressed to it. */
export async function handleBusy(cfg, me, amberPub, envelope) {
  try { openJob(amberPub, me.id, me.box, envelope); } catch { return; }
  await call(cfg, me, '/v1/executor/result', { jobId: envelope.jobId, ok: false, error: `执行端繁忙（同时最多执行 ${maxParallel(cfg)} 个任务），这次没有执行` }).catch(() => {});
}

async function runLoop() {
  const cfg = loadConfig();
  const me = identity();
  const amberPub = amberKey();
  setSandboxContext({ configDir: DIR });
  log(`amber-executor ${cfg.name} (${me.id}) → ${cfg.amber}; environments: ${Object.keys(cfg.envs ?? {}).join(', ') || 'none'}`);
  let running = 0, lastStatus = '', lastFollow = Date.now();
  refreshEnvs(cfg);
  /** Starts every job in a poll answer, whatever state we thought we were in. */
  const take = r => {
    for (const job of r?.jobs ?? []) {
      // Full: answer at once so the run fails now, not after the result timeout.
      if (running >= maxParallel(cfg)) { log('busy, job refused', job.jobId); handleBusy(cfg, me, amberPub, job); continue; }
      running++;
      handle(cfg, me, amberPub, job).finally(() => { running--; });
    }
  };
  for (;;) {
    try {
      // Followed files are re-read in every state, so a pending request carries the latest content.
      if (Date.now() - lastFollow > FOLLOW_MS) { lastFollow = Date.now(); refreshEnvs(cfg); }
      const reg = await register(cfg, me);
      if (reg.status !== 'approved') {
        if (reg.status !== lastStatus) log(`status: ${reg.status}; fingerprint ${showFingerprint(me.fp)}`);
        lastStatus = reg.status;
        // Pending: wait on Amber (it answers as soon as an admin decides). Rejected / revoked: idle.
        // The approval can land between our register and this poll; the poll then answers as approved and
        // may carry jobs — those are ours (already marked picked up on Amber's side), never drop them.
        if (reg.status === 'pending') take(await call(cfg, me, '/v1/executor/poll', {}, 60_000));
        else await new Promise(r => setTimeout(r, 600_000));
        continue;
      }
      if (lastStatus !== 'approved') log('approved; waiting for jobs');
      lastStatus = 'approved';
      for (;;) {
        const r = await call(cfg, me, '/v1/executor/poll', {}, 60_000);
        take(r);
        if (r.status !== 'approved') break;
        // Followed files: re-read now and then; a change goes back through register (Amber applies or asks).
        if (Date.now() - lastFollow > FOLLOW_MS) { lastFollow = Date.now(); if (refreshEnvs(cfg)) break; }
      }
    } catch (e) {
      log('error', e.message);
      await new Promise(r => setTimeout(r, 5_000));
    }
  }
}

// ---------- setup

async function init(args) {
  const name = flag(args, '--name');
  let url = flag(args, '--amber') ?? process.env.AMBER_URL ?? readJson(join(homedir(), '.config', 'amber-client.json'), {}).url;
  if (!name || !EXECUTOR_NAME.test(name)) die('要用 --name 给执行端起名：小写字母、数字、连字符，例如 --name ledger-mac');
  if (!url) die('要用 --amber 指定 Amber 的地址（和 amber 命令用的地址相同）');
  url = String(url).replace(/\/+$/, '').replace(/\/v1\/drafts$/, '');
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  if (!existsSync(P.sign) || !existsSync(P.box)) {
    const k = newExecutorKeys();
    writePrivate(P.sign, k.signKey);
    writePrivate(P.box, k.boxKey);
  }
  const r = await fetch(`${url}/v1/keys`, { signal: AbortSignal.timeout(10_000) }).then(x => x.json()).catch(e => die(`连不上 Amber（${url}）：${e.message}`));
  const jwk = r?.keys?.[0];
  if (jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519') die('Amber 返回的公钥不对');
  const prev = readJson(P.amber, null);
  if (prev && prev.x !== jwk.x && !args.includes('--repin')) die('Amber 的公钥和之前记下的不一样。确认 Amber 换过签名密钥后，加 --repin 重新记录');
  writePrivate(P.amber, JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }));
  const cfg = { ...readJson(P.config, {}), amber: url, name };
  writePrivate(P.config, JSON.stringify(cfg, null, 2));
  const me = identity();
  console.log(`已初始化 ${DIR}\n执行端：${name}\nAmber：${url}（签名公钥 ${jwk.kid ?? ''} 已记录）\n公钥指纹：${showFingerprint(me.fp)}\n\n下一步：amber-executor env set <环境名> <目录>，然后 amber-executor status 申请登记。`);
}

/** The one way an environment gets into the config: a definition in the JSON format (D51), whatever made it.
 *  Throws with a message for the person (or the follow loop, which keeps the old entry). */
export function buildEntry(def) {
  if (!def || typeof def !== 'object') throw new Error('定义要是 JSON 对象');
  if (def.format !== undefined && def.format !== 'amber-env/1') throw new Error(`不认识的格式版本：${def.format}（只支持 amber-env/1）`);
  if (!def.workdir || typeof def.workdir !== 'string') throw new Error('定义缺少 workdir');
  if (/(^|\/)\.\.(\/|$)/.test(def.workdir)) throw new Error(`workdir 不能含 ..：${def.workdir}`);
  const workdir = normalizePath(def.workdir);
  if (!isDir(workdir)) throw new Error(`workdir 不是已存在的目录：${workdir}`);
  const access = validateEnvAccess(def.access ?? { readWrite: [workdir] }, { workdir });
  checkVars(def.vars);
  const python = def.python ?? def.interpreter;
  let interpreter;
  if (python !== undefined) {
    interpreter = normalizePath(String(python));
    if (!/\/python(3(\.\d+)?)?$/.test(interpreter)) throw new Error(`python 要是 Python 解释器的绝对路径（文件名是 python、python3 或 python3.x）：${python}`);
  }
  if (def.realHome !== undefined && typeof def.realHome !== 'boolean') throw new Error('realHome 只能是 true 或 false');
  if (def.source !== undefined && typeof def.source !== 'string') throw new Error('source 要是字符串');
  return { workdir, ...(interpreter ? { interpreter } : {}), access, ...(def.vars && Object.keys(def.vars).length ? { vars: def.vars } : {}), ...(def.source ? { source: def.source.slice(0, 200) } : {}), ...(def.realHome === true ? { realHome: true } : {}) };
}

/** Writes a definition into envs/ after checking it (the running executor picks it up). */
function writeDef(def, name) {
  if (!name || !ENV_NAME.test(name)) die('环境名不对：用 --name 指定，或写在定义里的 name');
  let entry;
  try { entry = buildEntry(def); } catch (e) { die(e.message); }
  mkdirSync(ENV_DIR, { recursive: true, mode: 0o700 });
  writePrivate(join(ENV_DIR, `${name}.json`), JSON.stringify({ ...def, name }, null, 2) + '\n');
  const cred = credentialGrants(entry.access);
  console.log(`环境「${name}」：${describeAccess(entry.access)}${cred.length ? `\n注意：含凭证路径 ${cred.join('、')}` : ''}\n已写入 ${join(ENV_DIR, `${name}.json`)}`);
}

/** Re-reads envs/; true when anything changed (the caller re-registers; Amber applies or asks for approval). */
export function refreshEnvs(cfg) {
  const next = loadEnvs();
  if (JSON.stringify(next) === JSON.stringify(cfg.envs ?? {})) return false;
  log('environments changed:', Object.keys(next).join(', ') || 'none');
  cfg.envs = next;
  return true;
}

/** A stored environment as a definition (the same JSON format; re-importable). */
function toDef(name, v) {
  return { format: 'amber-env/1', name, workdir: v.workdir, ...(v.interpreter ? { python: v.interpreter } : {}), access: v.access ?? { readWrite: [v.workdir] },
    ...(v.vars ? { vars: v.vars } : {}), ...(v.realHome ? { realHome: true } : {}), ...(v.source ? { source: v.source } : {}) };
}

function envCmd(args) {
  const cfg = loadConfig();
  const [op, name, dir] = args;
  if (op === 'set') {
    // Shorthand for the simplest definition: one directory, read-write (or read-only).
    if (!name || !ENV_NAME.test(name) || !dir) die('用法：amber-executor env set <环境名> <目录> [--python <解释器>] [--readonly] [--print]');
    const python = flag(args, '--python');
    const def = { format: 'amber-env/1', name, workdir: normalizePath(dir), ...(python ? { python: normalizePath(python) } : {}),
      access: args.includes('--readonly') ? { readOnly: ['{WORKDIR}'] } : { readWrite: ['{WORKDIR}'] } };
    if (args.includes('--print')) return void console.log(JSON.stringify(def, null, 2));
    writeDef(def, name);
  } else if (op === 'import') {
    if (!name || !existsSync(name)) die('用法：amber-executor env import <定义文件.json> [--name <环境名>]');
    let def;
    try { def = JSON.parse(readFileSync(name, 'utf8')); } catch (e) { die(`定义文件不是合法的 JSON：${e.message}`); }
    writeDef(def, flag(args, '--name') ?? def?.name);
  } else if (op === 'export') {
    const f = join(ENV_DIR, `${name}.json`);
    if (!name || !existsSync(f)) die(`没有环境「${name}」`);
    return void console.log(readFileSync(f, 'utf8').trimEnd());
  } else if (op === 'show') {
    console.log(`环境文件夹：${ENV_DIR}`);
    for (const [k, v] of Object.entries(cfg.envs ?? {})) console.log(`${k}：{WORKDIR} = ${v.workdir}；${describeAccess(v.access ?? { readWrite: [v.workdir] })}${v.vars ? `；变量 ${Object.keys(v.vars).join('、')}` : ''}${v.source ? `（${v.source}）` : ''}`);
    return;
  } else if (op === 'rm') {
    const f = join(ENV_DIR, `${name}.json`);
    if (!name || !existsSync(f)) die(`没有环境「${name}」`);
    unlinkSync(f);
    console.log(`已删除 ${f}`);
  } else die('用法：amber-executor env set|import|export|show|rm …');
  console.log(`环境文件夹 ${ENV_DIR} 里的文件就是全部环境。正在运行的执行端 5 分钟内会自动读到变化；要马上生效，重启它：launchctl kickstart -k gui/${process.getuid()}/${LABEL}。新增的环境和超出范围的修改要管理员批准。`);
}

async function status() {
  const cfg = loadConfig();
  const me = identity();
  const r = await register(cfg, me).catch(e => die(e.message));
  const text = { pending: '等待管理员批准（管理员会收到 Amber 的卡片，请让对方核对下面的指纹）', approved: '已批准', rejected: '已被拒绝（要重新申请：删除配置目录里的两个密钥文件后重新 init）', revoked: '已被撤销（同上）' }[r.status] ?? r.status;
  console.log(`执行端：${cfg.name}（${me.id}）\nAmber：${cfg.amber}\n环境：${Object.entries(cfg.envs ?? {}).map(([k, v]) => `${k} = ${v.workdir}`).join('；') || '（无）'}\n公钥指纹：${showFingerprint(me.fp)}\n状态：${text}`);
}

function launchd(install) {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  // bootout returns before the job is gone; bootstrapping too early fails with "5: Input/output error".
  for (let i = 0; i < 50; i++) {
    try { execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' }); } catch { break; }
    execFileSync('sleep', ['0.2']);
  }
  if (!install) { if (existsSync(plist)) unlinkSync(plist); return console.log('已停止并移除'); }
  loadConfig();
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const self = fileURLToPath(import.meta.url);
  // A stable path for node: process.execPath is the versioned Cellar path, which disappears when Homebrew upgrades node.
  const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => { try { return realpathSync(p) === realpathSync(process.execPath); } catch { return false; } }) ?? process.execPath;
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(self)}</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>AMBER_EXECUTOR_DIR</key><string>${esc(DIR)}</string></dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(join(DIR, 'executor.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(join(DIR, 'executor.log'))}</string>
</dict></plist>
`);
  execFileSync('launchctl', ['bootstrap', domain, plist]);
  console.log(`已安装并启动（${plist}）。日志：${join(DIR, 'executor.log')}`);
}

function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  // Our own config dir is protected in every command, not only while running jobs.
  setSandboxContext({ configDir: DIR });
  const run = { init: () => init(args), env: () => envCmd(args), status, run: runLoop, 'install-launchd': () => launchd(true), 'uninstall-launchd': () => launchd(false) }[cmd];
  if (!run) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
  await run();
}
