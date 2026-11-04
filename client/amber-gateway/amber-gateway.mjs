#!/usr/bin/env node
// Amber gateway: Amber's agent API for callers outside the company network. No dependencies beyond Node ≥ 22.
// See docs/gateway.md.
//
//   amber-gateway init --name <name> --amber-key <key> [--listen 127.0.0.1:7360] [--rate 60] [--repin]
//                                    config (once); <key> is Amber's public signing key (the JSON from <amber>/v1/keys,
//                                    or its "x"); <name> is this gateway's name in Amber's apiLinks
//   amber-gateway token add <client> [--rate <n>]   a new client token, printed once (only its hash is kept)
//   amber-gateway token rm <client> | token list
//   amber-gateway serve [--host 127.0.0.1] [--port 7360]   run (plain HTTP: put nginx / caddy with HTTPS in front)
//   amber-gateway status
//
// Outside callers send the same requests they would send Amber (/v1/...) with "Authorization: Bearer <token>".
// Nothing connects into Amber's network: Amber connects out to this service (/amber-link/next, signed with its key,
// which init pinned) and takes the queued requests, answers each as it answers its own API — under the policy its
// admin set for that client — and posts the answer back (/amber-link/reply). The token never reaches Amber.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, renameSync, statSync, appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLinkRequest, parseAmberKey, REQUEST_SKEW_MS, EXECUTOR_NAME } from './lib/exec-proto.mjs';

export const VERSION = '1';
const DIR = process.env.AMBER_GATEWAY_DIR ?? join(homedir(), '.config', 'amber-gateway');
const P = { config: join(DIR, 'config.json'), audit: join(DIR, 'audit.jsonl') };
const DEFAULT_LISTEN = '127.0.0.1:7360';
/** Requests per minute per client, unless its token or the config says otherwise. */
const DEFAULT_RATE = 60;
const CLIENT_NAME = EXECUTOR_NAME;
/** How long an empty /amber-link/next is held (same as executor links: Amber's own timeout is this + 15 s). */
const LINK_WAIT_MS = 25_000;
/** Amber counts as connected while it asked for requests this recently (it keeps several long polls open). */
const CONNECTED_MS = 60_000;
/** How long an outside request waits for Amber's answer; `amber wait` long polls (?wait=, at most 50 s on Amber) get
 *  their wait plus this margin. */
const ANSWER_MS = 60_000;
const WAIT_MARGIN_MS = 15_000;
/** Request bodies from outside: page publishing (16MB) is not offered, everything else Amber caps at 256KB. */
const MAX_BODY = 1024 * 1024;
/** A reply carries Amber's answer (a command list can be large). */
const LINK_MAX_BODY = 16 * 1024 * 1024;
/** Requests waiting at once, all clients together: beyond this, refuse rather than queue without bound. */
const MAX_PENDING = 256;

// Amber's API as far as a gateway carries it. Amber decides per client what is allowed (apiLinks); this list only
// keeps what is not Amber's API from being queued at all.
const GET_PATHS = [/^\/v1\/info$/, /^\/v1\/envs$/, /^\/v1\/requests\/[A-Za-z0-9-]{1,40}$/];
const POST_PATHS = [/^\/v1\/drafts$/, /^\/v1\/reads(\/fetch)?$/, /^\/v1\/commands\/(list|show|retire|scope)$/, /^\/v1\/runs$/,
  /^\/v1\/schedules(\/list)?$/, /^\/v1\/schedules\/[A-Za-z0-9-]{1,40}\/(pause|resume|delete)$/, /^\/v1\/triggers(\/list)?$/, /^\/v1\/triggers\/[0-9a-f]{8}\/pause$/];
/** Never carried, whatever Amber's configuration says (Amber refuses them too). */
const NEVER = /^\/v1\/(secrets|executor|pages)(\/|$)/;

const log = (...a) => console.log(new Date().toISOString(), ...a);
const die = m => { console.error(`amber-gateway: ${m}`); process.exit(1); };
const readJson = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return d; } };
const writePrivate = (p, s) => { const t = `${p}.tmp`; writeFileSync(t, s, { mode: 0o600 }); chmodSync(t, 0o600); renameSync(t, p); };
const sha256 = s => createHash('sha256').update(s).digest('hex');

function loadConfig() {
  const c = readJson(P.config, null);
  if (!c) die(`还没初始化：先运行 amber-gateway init --name <名称> --amber-key <Amber 公钥>（配置目录 ${DIR}）`);
  return c;
}
const saveConfig = c => writePrivate(P.config, JSON.stringify(c, null, 2) + '\n');

/** Clients as the config file has them now: `token rm` takes effect on the next request, without a restart. */
let clientCache = { key: '', clients: {} };
function currentClients() {
  let key = '';
  try { const st = statSync(P.config); key = `${st.mtimeMs}:${st.size}`; } catch { return {}; }
  if (key !== clientCache.key) clientCache = { key, clients: readJson(P.config, {})?.clients ?? {} };
  return clientCache.clients;
}

/** The client a bearer token belongs to. Every client's hash is compared, in constant time, whatever matches. */
export function clientOf(authorization, clients) {
  const m = /^Bearer +([A-Za-z0-9_-]{16,200})$/.exec(String(authorization ?? ''));
  if (!m) return undefined;
  const got = Buffer.from(sha256(m[1]), 'hex');
  let found;
  for (const [name, c] of Object.entries(clients)) {
    const want = /^[0-9a-f]{64}$/.test(String(c?.hash)) ? Buffer.from(c.hash, 'hex') : Buffer.alloc(32);
    if (timingSafeEqual(got, want) && CLIENT_NAME.test(name) && found === undefined) found = name;
  }
  return found;
}

/** For the audit log: the query's names, and the value of `wait` only (other values could be anything). */
export function auditPath(pathname, search) {
  const q = [...new URLSearchParams(search).entries()].map(([k, v]) => `${encodeURIComponent(k.slice(0, 40))}=${k === 'wait' ? encodeURIComponent(v.slice(0, 8)) : ''}`);
  return pathname.slice(0, 200) + (q.length ? `?${q.slice(0, 10).join('&')}` : '');
}

// ---------- serve

export function startGateway(opts = {}) {
  const cfg = loadConfig();
  const amberPub = createPublicKey({ key: cfg.amberKey, format: 'jwk' });
  const linkName = `gateway:${cfg.name}`;
  const auditFile = opts.audit ?? P.audit;
  const listen = opts.listen ?? cfg.listen ?? DEFAULT_LISTEN;
  const [host, port] = listen.split(/:(?=\d+$)/);
  /** Requests waiting for Amber to take them, and those taken and waiting for Amber's answer. */
  const outbox = [];
  const pending = new Map();
  let nextWaiters = [];
  const nonces = new Map();
  let lastContact = 0;
  const buckets = new Map();
  const connected = () => Date.now() - lastContact < CONNECTED_MS;
  const flushNext = () => { const w = nextWaiters; nextWaiters = []; for (const f of w) f(); };

  const fresh = nonce => {
    const now = Date.now();
    for (const [k, t] of nonces) if (now - t > 2 * REQUEST_SKEW_MS) nonces.delete(k);
    if (nonces.has(nonce) || nonces.size > 50_000) return false;
    nonces.set(nonce, now);
    return true;
  };

  /** Token bucket per client: `rate` requests a minute, bursts up to `rate`. */
  const allow = (client, rate) => {
    const now = Date.now();
    const b = buckets.get(client) ?? { tokens: rate, at: now };
    b.tokens = Math.min(rate, b.tokens + (now - b.at) * rate / 60_000);
    b.at = now;
    buckets.set(client, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };

  /** One line per outside request; never bodies, tokens or answers. */
  const audit = (client, method, url, status, started) => {
    try {
      appendFileSync(auditFile, JSON.stringify({ time: new Date().toISOString(), client: client ?? null, method: String(method).slice(0, 8), path: auditPath(url.pathname, url.search), status, ms: Date.now() - started }) + '\n', { mode: 0o600 });
    } catch (e) { log('audit write failed', e.message); }
  };

  const readBody = (req, limit) => new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('too_large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  /** Queues one outside request for Amber and resolves with Amber's answer, or a 504 of our own. */
  const forward = (item, timeoutMs, gone) => new Promise(resolve => {
    const timer = setTimeout(() => {
      pending.delete(item.id);
      const i = outbox.indexOf(item);
      if (i >= 0) outbox.splice(i, 1);
      resolve({ status: 504, body: JSON.stringify({ ok: false, error: 'gateway_timeout', message: i >= 0 && !connected() ? 'Amber 没有连上网关，请稍后再试' : 'Amber 没有在时限内答复，请稍后再试' }) });
    }, timeoutMs);
    pending.set(item.id, (status, body) => { clearTimeout(timer); pending.delete(item.id); resolve({ status, body }); });
    // The caller gave up: nobody is left to answer, so Amber need not take it.
    gone(() => {
      if (!pending.has(item.id)) return;
      clearTimeout(timer);
      pending.delete(item.id);
      const i = outbox.indexOf(item);
      if (i >= 0) outbox.splice(i, 1);
    });
    outbox.push(item);
    flushNext();
  });

  async function outside(req, res, url) {
    const started = Date.now();
    const path = url.pathname, method = req.method ?? 'GET';
    let client;
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
      audit(client, method, url, status, started);
    };
    // Public on Amber too: the key set services use to verify Amber's identity tokens. Answered from the key init
    // pinned (the same one this gateway trusts links with), so it works while Amber is away.
    if (method === 'GET' && path === '/v1/keys') {
      const kid = createHash('sha256').update(cfg.amberKey.x).digest('hex').slice(0, 16);
      return send(200, { keys: [{ ...cfg.amberKey, kid, alg: 'EdDSA', use: 'sig' }] });
    }
    const clients = currentClients();
    client = clientOf(req.headers.authorization, clients);
    if (!client) return send(401, { ok: false, error: 'unauthorized', message: '缺少或无效的网关令牌（请求头 Authorization: Bearer <令牌>）' }, { 'www-authenticate': 'Bearer' });
    if (NEVER.test(path)) return send(403, { ok: false, error: 'forbidden', message: '外网网关不开放这个接口（密钥、执行端和页面发布只能在内网使用）' });
    if (!(method === 'GET' ? GET_PATHS : method === 'POST' ? POST_PATHS : []).some(r => r.test(path))) return send(404, { ok: false, error: 'not_found' });
    const rate = Number(clients[client]?.rate) || Number(cfg.rate) || DEFAULT_RATE;
    if (!allow(client, rate)) return send(429, { ok: false, error: 'rate_limited', message: `请求太频繁（每分钟最多 ${rate} 次），请稍后再试` }, { 'retry-after': '5' });
    let raw = '';
    if (method === 'POST') {
      if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) { res.setHeader('connection', 'close'); return send(413, { ok: false, error: 'too_large', message: '请求太大' }); }
      try { raw = await readBody(req, MAX_BODY); } catch { return send(413, { ok: false, error: 'too_large', message: '请求太大' }); }
    }
    if (!connected()) return send(504, { ok: false, error: 'gateway_timeout', message: 'Amber 没有连上网关，请稍后再试' });
    if (pending.size >= MAX_PENDING) return send(503, { ok: false, error: 'busy', message: '网关排队的请求太多，请稍后再试' }, { 'retry-after': '5' });
    const wait = /^\/v1\/requests\//.test(path) ? Math.min(Math.max(Number(url.searchParams.get('wait')) || 0, 0), 50) * 1000 : 0;
    const ct = req.headers['content-type'];
    // Only what Amber's API reads: never the Authorization header, cookies or proxy headers.
    const item = { id: randomBytes(12).toString('hex'), client, method, path: path + url.search, headers: typeof ct === 'string' ? { 'content-type': ct } : {}, body: raw };
    const r = await forward(item, Math.max(ANSWER_MS, wait + WAIT_MARGIN_MS), f => res.on('close', () => { if (!res.writableFinished) f(); }));
    if (res.destroyed) return audit(client, method, url, 499, started);
    send(r.status, r.body);
  }

  function link(req, res, path) {
    const send = (status, body) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    // Bodies are read before the signature can be checked: keep them small (a reply carries an answer, up to 16MB).
    const limit = path === '/amber-link/next' ? 4096 : LINK_MAX_BODY;
    if (Number(req.headers['content-length'] ?? 0) > limit) { res.setHeader('connection', 'close'); return send(413, { ok: false, error: 'too_large' }); }
    readBody(req, limit).then(raw => {
      try {
        const nonce = verifyLinkRequest(amberPub, linkName, req.headers, 'POST', path, raw);
        if (!fresh(nonce)) throw new Error('重复的请求');
      } catch (e) { return send(401, { ok: false, error: 'unauthorized', message: e.message }); }
      lastContact = Date.now();
      if (path === '/amber-link/reply') {
        let b;
        try { b = JSON.parse(raw); } catch { return send(400, { ok: false, error: 'bad_json' }); }
        const p = pending.get(String(b?.id ?? ''));
        if (!p) return send(200, { ok: false });
        const status = Number(b.status);
        p(Number.isInteger(status) && status >= 200 && status <= 599 ? status : 502, typeof b.body === 'string' ? b.body : JSON.stringify({ ok: false, message: '无法解析 Amber 的答复' }));
        return send(200, { ok: true });
      }
      // next: hand out what is waiting, or wait for something (Amber keeps several of these open).
      const take = () => {
        const items = outbox.splice(0, 8);
        // Not delivered (the connection dropped): back in line for the next one.
        res.on('close', () => { if (!res.writableFinished) outbox.unshift(...items.filter(it => pending.has(it.id))); });
        send(200, { ok: true, requests: items.map(({ id, client, method, path: p, headers, body }) => ({ id, client, method, path: p, headers, body })) });
      };
      if (outbox.length) return take();
      let done = false;
      const timer = setTimeout(() => { if (done) return; done = true; nextWaiters = nextWaiters.filter(f => f !== wake); send(200, { ok: true, requests: [] }); }, LINK_WAIT_MS);
      const wake = () => { if (done) return; if (!outbox.length) { nextWaiters.push(wake); return; } done = true; clearTimeout(timer); take(); };
      nextWaiters.push(wake);
      res.on('close', () => { if (!done) { done = true; clearTimeout(timer); nextWaiters = nextWaiters.filter(f => f !== wake); } });
    }, () => { if (!res.headersSent) send(413, { ok: false, error: 'too_large' }); });
  }

  const server = createServer((req, res) => {
    let url;
    try { url = new URL(req.url ?? '/', 'http://gateway'); } catch { res.writeHead(400); return res.end(); }
    const path = url.pathname;
    // Health for monitoring: whether Amber is connected, nothing else.
    if (req.method === 'GET' && path === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, service: 'amber-gateway', name: cfg.name, version: VERSION, amberConnected: connected() }));
    }
    if (req.method === 'POST' && (path === '/amber-link/next' || path === '/amber-link/reply')) return link(req, res, path);
    if (path.startsWith('/v1/')) return void outside(req, res, url).catch(e => { log('error', path, e.message); if (!res.headersSent) { res.writeHead(500); res.end(); } });
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'not_found' }));
  });
  // A public endpoint (behind HTTPS): slow clients are cut off; long polls (Amber's, and `amber wait`) fit inside.
  server.headersTimeout = 10_000;
  server.requestTimeout = 120_000;
  server.maxConnections = 1024;
  server.listen(Number(port), host, () => log(`amber-gateway ${cfg.name}: listening on ${host}:${port}`));
  return server;
}

// ---------- setup

function init(args) {
  const name = flag(args, '--name'), key = flag(args, '--amber-key');
  if (!name || !EXECUTOR_NAME.test(name)) die('要用 --name 给网关起名（Amber 配置 apiLinks 里的 name）：小写字母、数字、连字符');
  if (!key) die('要用 --amber-key 给出 Amber 的签名公钥（Amber 的 /v1/keys 返回的 JSON，或其中的 x；向 Amber 管理员要）');
  const listen = flag(args, '--listen') ?? DEFAULT_LISTEN;
  if (!/^[\w.:[\]-]+:\d{2,5}$/.test(listen)) die('--listen 要写成 地址:端口，例如 127.0.0.1:7360');
  const rate = flag(args, '--rate') === undefined ? DEFAULT_RATE : Number(flag(args, '--rate'));
  if (!Number.isInteger(rate) || rate < 1 || rate > 10_000) die('--rate 要是 1–10000 的整数（每个客户端每分钟的请求数）');
  let jwk;
  try { jwk = parseAmberKey(existsSync(key) ? readFileSync(key, 'utf8') : key); } catch (e) { die(e.message); }
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  chmodSync(DIR, 0o700);
  const prev = readJson(P.config, null);
  if (prev?.amberKey && prev.amberKey.x !== jwk.x && !args.includes('--repin')) die('Amber 的公钥和之前记下的不一样。确认 Amber 换过签名密钥后，加 --repin 重新记录');
  saveConfig({ ...(prev ?? {}), name, amberKey: jwk, listen, rate, clients: prev?.clients ?? {} });
  console.log(`已初始化 ${DIR}\n网关：${name}\n监听：${listen}（用 nginx / caddy 把一个 HTTPS 地址转发到这里）\n每个客户端每分钟最多：${rate} 次\nAmber 签名公钥：已记录\n\n下一步：amber-gateway token add <客户端名> 发令牌；启动 amber-gateway serve；请 Amber 管理员在配置的 apiLinks 里加上 {"name": "${name}", "url": "https://<你的地址>", "clients": {"<客户端名>": {...}}}。`);
}

function token(args) {
  const [sub, client] = args;
  const cfg = loadConfig();
  cfg.clients ??= {};
  if (sub === 'list') {
    const rows = Object.entries(cfg.clients);
    if (!rows.length) return console.log('（还没有客户端）');
    for (const [n, c] of rows) console.log(`${n}\t创建于 ${c.created ?? '?'}${c.rate ? `\t每分钟 ${c.rate} 次` : ''}`);
    return;
  }
  if ((sub !== 'add' && sub !== 'rm') || !client) die('用法：amber-gateway token add <客户端名> [--rate <n>] | token rm <客户端名> | token list');
  if (!CLIENT_NAME.test(client)) die('客户端名只能用小写字母、数字、连字符（最长 32 个字符），例如 doubao-skill');
  if (sub === 'rm') {
    if (!cfg.clients[client]) die(`没有客户端 ${client}`);
    delete cfg.clients[client];
    saveConfig(cfg);
    return console.log(`已删除 ${client}：它的令牌立即失效（运行中的服务不用重启）`);
  }
  if (cfg.clients[client]) die(`已经有客户端 ${client}。要换令牌：先 token rm ${client}，再 token add`);
  const rate = flag(args, '--rate') === undefined ? undefined : Number(flag(args, '--rate'));
  if (rate !== undefined && (!Number.isInteger(rate) || rate < 1 || rate > 10_000)) die('--rate 要是 1–10000 的整数');
  const t = `amg_${randomBytes(32).toString('base64url')}`;
  cfg.clients[client] = { hash: sha256(t), created: new Date().toISOString(), ...(rate ? { rate } : {}) };
  saveConfig(cfg);
  console.log(`客户端 ${client} 的令牌（只显示这一次，网关只保存它的哈希）：\n${t}\n\n用法：请求头 Authorization: Bearer <令牌>；amber 命令行设置 AMBER_TOKEN 或 amber config set-token。\n别忘了请 Amber 管理员在 apiLinks 的 clients 里加上 "${client}"。`);
}

async function status() {
  const cfg = loadConfig();
  const listen = cfg.listen ?? DEFAULT_LISTEN;
  const h = await fetch(`http://${listen}/healthz`, { signal: AbortSignal.timeout(5000) }).then(r => r.json()).catch(() => null);
  console.log(`网关：${cfg.name}\n配置目录：${DIR}\n监听：${listen}${h ? '' : '（服务没有在运行）'}\n客户端：${Object.keys(cfg.clients ?? {}).join('、') || '（无）'}\n每个客户端每分钟最多：${cfg.rate ?? DEFAULT_RATE} 次\nAmber：${h?.amberConnected ? '已连上' : '还没连上（等 Amber 管理员在 apiLinks 里加上本网关地址）'}`);
}

function serve(args) {
  const cfg = loadConfig();
  const [h0, p0] = String(cfg.listen ?? DEFAULT_LISTEN).split(/:(?=\d+$)/);
  const host = flag(args, '--host') ?? h0, port = flag(args, '--port') ?? p0;
  if (!/^\d{2,5}$/.test(String(port))) die('--port 要是端口号');
  startGateway({ listen: `${host}:${port}`, audit: flag(args, '--audit') });
}

function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [cmd, ...args] = process.argv.slice(2);
  const run = { init: () => init(args), token: () => token(args), serve: () => serve(args), status }[cmd];
  if (!run) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(cmd ? 1 : 0); }
  await run();
}
