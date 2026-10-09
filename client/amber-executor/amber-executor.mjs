#!/usr/bin/env node
// Amber executor (D50): runs reviewed Amber commands on this machine, next to the data they need.
// No dependencies beyond Node ≥ 22. See docs/executor.md.
//
//   amber-executor init --name <name> [--amber <url>]     keys + config (once)
//   amber-executor env set <env> <workdir> [--python <p>]  what {WORKDIR} means for an environment
//   amber-executor env rm <env>
//   amber-executor status                                  register / show fingerprint and approval
//   amber-executor run                                     long-poll Amber and run jobs (launchd runs this)
//   amber-executor install-launchd | uninstall-launchd
//
// Every job is signed by Amber (key pinned at init) and encrypted to this executor's key. Before
// running, the executor checks the signature, the addressee, the expiry, that it has not seen the job
// before, and recomputes the spec hash; then runs the code under the job's own reviewed sandbox
// policy (same rules as Amber, lib/ is generated from Amber's sources) with {WORKDIR} set here.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { newExecutorKeys, keyFromPem, pubB64, fingerprint, showFingerprint, signRequest, openJob, specHashOf, redact, EXECUTOR_NAME, ENV_NAME } from './lib/exec-proto.mjs';
import { setSandboxContext, validateAppSandbox, buildPolicy, compileToSeatbelt, normalizePath, mandatoryDenyRoots } from './lib/sandbox-policy.mjs';
import { runSandboxed } from './lib/sandbox-run.mjs';

export const VERSION = '1';
const DIR = process.env.AMBER_EXECUTOR_DIR ?? join(homedir(), '.config', 'amber-executor');
const P = { config: join(DIR, 'config.json'), sign: join(DIR, 'sign-key.pem'), box: join(DIR, 'box-key.pem'), amber: join(DIR, 'amber-key.json'), seen: join(DIR, 'seen-jobs.json') };
const DEFAULT_PYTHON = '/usr/bin/python3';
const MAX_PARALLEL = 4;
const LABEL = 'com.amber.executor';

const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = m => { console.error(`amber-executor: ${m}`); process.exit(1); };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writePrivate = (p, s) => { const t = `${p}.tmp`; writeFileSync(t, s, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, p); };

function loadConfig() {
  const c = readJson(P.config, null);
  if (!c) die(`还没初始化：先运行 amber-executor init --name <名称>（配置目录 ${DIR}）`);
  return c;
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
  if (s.services && Object.keys(s.services).length) throw new Error('执行端不支持调用内部服务');
  const workdir = normalizePath(env.workdir);
  validateAppSandbox(s.sandbox, { workdir });   // with {WORKDIR} resolved: protected dirs checked here
  const python = normalizePath(s.interpreter ?? env.interpreter ?? DEFAULT_PYTHON);
  if (mandatoryDenyRoots().some(r => python === r || python.startsWith(r + '/'))) throw new Error('解释器在受保护的目录里');
  const timeoutMs = Math.min(Math.max(Number(s.timeoutMs) || 30000, 1000), 120000);
  return { code: s.code, python, timeoutMs, workdir, profileFor: dir => compileToSeatbelt(buildPolicy({ runDir: dir, app: s.sandbox, workdir }), { all: !!s.network }) };
}

export async function handle(cfg, me, amberPub, envelope) {
  let payload, secrets = {};
  try {
    payload = openJob(amberPub, me.id, me.box, envelope);
    if (!firstSeen(envelope.jobId, envelope.exp)) return log('job replayed, ignored', envelope.jobId);
    secrets = payload.input?.secrets ?? {};
    const job = prepare(cfg, payload);
    log('job start', envelope.jobId, payload.spec.name, payload.env, `run ${payload.runId}`);
    const r = await runSandboxed({ code: job.code, python: job.python, profileFor: job.profileFor, input: payload.input, timeoutMs: job.timeoutMs, env: { WORKDIR: job.workdir } });
    log('job done', envelope.jobId, r.ok ? 'ok' : `failed: ${r.error}`);
    await call(cfg, me, '/v1/executor/result', { jobId: envelope.jobId, ok: r.ok, content: redact(r.content, secrets), ...(r.error ? { error: redact(r.error, secrets) } : {}) });
  } catch (e) {
    log('job refused', envelope?.jobId, e.message);
    // Only answer jobs that were really for us (signature checked); anything else is dropped.
    if (payload) await call(cfg, me, '/v1/executor/result', { jobId: envelope.jobId, ok: false, error: redact(e.message, secrets) }).catch(() => {});
  }
}

async function runLoop() {
  const cfg = loadConfig();
  const me = identity();
  const amberPub = amberKey();
  setSandboxContext({ configDir: DIR });
  log(`amber-executor ${cfg.name} (${me.id}) → ${cfg.amber}; environments: ${Object.keys(cfg.envs ?? {}).join(', ') || 'none'}`);
  let running = 0, lastStatus = '';
  for (;;) {
    try {
      const reg = await register(cfg, me);
      if (reg.status !== 'approved') {
        if (reg.status !== lastStatus) log(`status: ${reg.status}; fingerprint ${showFingerprint(me.fp)}`);
        lastStatus = reg.status;
        // Pending: wait on Amber (it answers as soon as an admin decides). Rejected / revoked: idle.
        if (reg.status === 'pending') await call(cfg, me, '/v1/executor/poll', {}, 60_000);
        else await new Promise(r => setTimeout(r, 600_000));
        continue;
      }
      if (lastStatus !== 'approved') log('approved; waiting for jobs');
      lastStatus = 'approved';
      for (;;) {
        const r = await call(cfg, me, '/v1/executor/poll', {}, 60_000);
        if (r.status !== 'approved') break;
        for (const job of r.jobs ?? []) {
          if (running >= MAX_PARALLEL) { log('busy, job left to time out', job.jobId); continue; }
          running++;
          handle(cfg, me, amberPub, job).finally(() => { running--; });
        }
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
  const cfg = { ...readJson(P.config, { envs: {} }), amber: url, name };
  writePrivate(P.config, JSON.stringify(cfg, null, 2));
  const me = identity();
  console.log(`已初始化 ${DIR}\n执行端：${name}\nAmber：${url}（签名公钥 ${jwk.kid ?? ''} 已记录）\n公钥指纹：${showFingerprint(me.fp)}\n\n下一步：amber-executor env set <环境名> <目录>，然后 amber-executor status 申请登记。`);
}

function envCmd(args) {
  const cfg = loadConfig();
  const [op, name, dir] = args;
  if (op === 'set') {
    if (!name || !ENV_NAME.test(name) || !dir) die('用法：amber-executor env set <环境名> <目录> [--python <解释器>]');
    const workdir = normalizePath(dir);
    if (!existsSync(workdir)) die(`目录不存在：${workdir}`);
    const python = flag(args, '--python');
    cfg.envs = { ...cfg.envs, [name]: { workdir, ...(python ? { interpreter: normalizePath(python) } : {}) } };
  } else if (op === 'rm') {
    if (!cfg.envs?.[name]) die(`没有环境「${name}」`);
    delete cfg.envs[name];
  } else die('用法：amber-executor env set|rm …');
  writePrivate(P.config, JSON.stringify(cfg, null, 2));
  console.log(`已保存。环境变了要重新批准：运行 amber-executor status 申请（正在运行的服务会自动重新申请，请重启它：launchctl kickstart -k gui/${process.getuid()}/${LABEL}）`);
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
  if (!install) { if (existsSync(plist)) unlinkSync(plist); return console.log('已停止并移除'); }
  loadConfig();
  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const self = fileURLToPath(import.meta.url);
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(self)}</string><string>run</string></array>
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
  const run = { init: () => init(args), env: () => envCmd(args), status, run: runLoop, 'install-launchd': () => launchd(true), 'uninstall-launchd': () => launchd(false) }[cmd];
  if (!run) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
  await run();
}
