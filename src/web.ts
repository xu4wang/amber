// Website (D34). Login happens in a chat with Amber: the person sends 「登录」 in their private chat,
// Amber answers with a one-time link (5 minutes, single use, bound to the sender from the Feishu
// event). No OAuth redirect URL, nothing for Feishu to call back. The link is only ever shown in the
// person's own private chat, so nobody can make someone else's browser log in as them.
// Served on its own loopback port, separate from the agent API.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, CommandRow, ScheduleRow, PageRow } from './db.ts';
import type { Caller } from './engine.ts';
import { runCommand, AmberError, secretVault, lineOf, runParams, configParams, configValues, validateArgs } from './engine.ts';
import type { Signer } from './identity.ts';
import type { Scheduler } from './scheduler.ts';
import { envsHash, effectiveAccess, credentialPaths, type ExecutorHub } from './executors.ts';
import type { AppStore } from './apps.ts';
import { outputBlocks, type PageService } from './pages.ts';
import { showFingerprint } from './exec-proto.ts';
import { describeRule, formatAt, defaultTz, timezones } from './schedule-rule.ts';
import { CARD_FOOTER_KEY, CARD_FOOTER_MAX, DEFAULT_CARD_FOOTER, cleanFooter } from './cards.ts';
import { getLimits, saveLimits, timeoutLabel, DEFAULT_LIMITS, TIMEOUT_BOUNDS, CONCURRENCY_BOUNDS, getLocalAllowHosts, getGlobalAllowHosts, saveAllowHosts, checkAllowHosts, FEISHU_HOSTS, SLOTS } from './limits.ts';

export const LOGIN_TTL_MS = 5 * 60_000;
const SESSION_TTL_MS = 7 * 24 * 3600_000;
const COOKIE = 'amber_session';

export function hashToken(t: string): string {
  return createHash('sha256').update(t).digest('hex');
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export interface WebDeps {
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  chatName(chatId: string): Promise<string | undefined>;
  nameOf(unionId: string): Promise<string | undefined>;
  /** The login card in the person's private chat changes to "logged in". */
  onLoginUsed(messageId: string, at: number): Promise<void>;
  feishuChatLink: string;
  cityOf(unionId: string): Promise<string | undefined>;
  signer: Signer;
  scheduler: Scheduler;
  /** Take a command offline (creator or admin only; schedules pause). */
  retire(cmdId: string, actor: { unionId: string }, byLabel: string, opts?: { delist?: boolean }): Promise<{ name: string; schedules: number; delisted?: boolean }>;
  isAdmin(unionId: string): boolean;
  /** #4 orphans: is the command's creator gone from its group; who is in a group; offer a command to a member. */
  isOrphan(c: CommandRow): Promise<boolean | undefined>;
  groupMembers(chatId: string): Promise<{ unionId: string; name: string }[]>;
  requestReassign(cmdId: string, toUnionId: string, admin: { unionId: string; openId?: string }): Promise<{ requestId: string }>;
  requestClone?(cmdId: string, toUnionId: string, from: { unionId: string; openId?: string }): Promise<{ requestId: string }>;
  /** Amber Store (#4), and the groups Amber is in (where apps can be installed). */
  apps?: AppStore;
  botGroups?(): Promise<{ chatId: string; name: string }[]>;
  /** Executors (D50): admins see and decide them on the website too. */
  hub?: ExecutorHub;
  /** Origin of the site, e.g. http://amber.example.com — POSTs from anywhere else are refused. */
  origin: string;
  /** How long a website run is waited for before the page is told to poll for it (default 20 s). */
  runWaitMs?: number;
  /** Page apps (pages.ts) and the separate origin their files are served from. */
  pages?: PageService;
  pagesBaseUrl?: string;
}

/** A website run still going after runWaitMs: the page asks for it by job id. Kept 30 minutes after it ends. */
interface WebJob { owner: string; done?: Record<string, unknown>; endedAt?: number }
const JOB_KEEP_MS = 30 * 60_000;

/** Groups of audit actions for the filter on the audit page (by action name prefix). */
const AUDIT_CATEGORIES: Record<string, { label: string; prefixes: string[] }> = {
  run: { label: '执行', prefixes: ['run.', 'agent.run', 'identity.', 'secret.use', 'request.'] },
  app: { label: '应用与审核', prefixes: ['draft.', 'review.', 'command.', 'operator.', 'scope.', 'app.'] },
  schedule: { label: '定时任务', prefixes: ['schedule.'] },
  executor: { label: '执行端', prefixes: ['executor.', 'web.executor'] },
  settings: { label: '设置、配置项与密钥', prefixes: ['web.card_footer', 'web.run_limits', 'web.allow_hosts', 'config.', 'secret.set', 'secret.delete', 'secret.drop'] },
  page: { label: '页面应用', prefixes: ['page.'] },
  login: { label: '登录', prefixes: ['web.login', 'web.logout', 'web.selftest'] },
  system: { label: '系统', prefixes: ['startup.', 'migrate.'] },
};

const escHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

const pick = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 64 * 1024) { reject(new AmberError('too_large', '请求太大')); req.destroy(); } });
    req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new AmberError('bad_json', '请求格式不对')); } });
    req.on('error', reject);
  });
}

/**
 * Where a command is being used from the website, and whether this person may use it there.
 * scope: "p2p" (their private-chat commands), "global", or "group:<chat id>" (they must be a member).
 */
/** The command a request is about. Running needs it to be the person's own command (or a global one, #4);
 *  `manage` (read the code, settings, take offline) also lets an admin reach anyone's command. */
async function target(store: Store, deps: WebDeps, unionId: string, scope: string, commandId: string, manage = false): Promise<{ cmd: CommandRow; chatId: string; chatType: 'group' | 'p2p' }> {
  const cmd = store.getCommand(String(commandId));
  const nf = new AmberError('not_found', '没有找到这个应用');
  if (!cmd || cmd.status !== 'active') throw nf;
  const adminView = manage && deps.isAdmin(unionId);
  if (scope === 'p2p') {
    if (cmd.scopeType !== 'p2p' || (cmd.ownerUnionId !== unionId && !adminView)) throw nf;
    return { cmd, chatId: cmd.chatId, chatType: 'p2p' };
  }
  if (scope === 'global') {
    if (!cmd.global) throw nf;
    // Results of global commands used from the website go to the person's private chat with Amber.
    return { cmd, chatId: `web:${unionId}`, chatType: 'p2p' };
  }
  const m = /^group:(oc_[A-Za-z0-9]+)$/.exec(scope);
  if (!m || cmd.scopeType !== 'group' || cmd.chatId !== m[1]) throw nf;
  if (adminView) return { cmd, chatId: m[1], chatType: 'group' };
  if (cmd.ownerUnionId !== unionId) throw nf;
  const member = await deps.isMember(m[1], unionId);
  if (member !== true) throw new AmberError('forbidden', member === undefined ? 'Amber 暂时无法确认你是否在这个群里（缺少「获取群成员」权限）' : '你不在这个群里');
  return { cmd, chatId: m[1], chatType: 'group' };
}

const runTimes = new Map<string, number[]>();
function rateLimit(unionId: string): void {
  const now = Date.now();
  const list = (runTimes.get(unionId) ?? []).filter(t => now - t < 60_000);
  if (list.length >= 20) throw new AmberError('rate_limited', '一分钟内执行太多次了，请稍后再试');
  list.push(now);
  runTimes.set(unionId, list);
}

function cookieOf(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

const SECURITY_HEADERS = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
};

export function startWeb(port: number, store: Store, deps: WebDeps): import('node:http').Server {
  const page = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8').replace('__FEISHU_CHAT_LINK__', deps.feishuChatLink);
  const logo = readFileSync(join(import.meta.dirname, '..', 'web', 'logo.svg'));
  // Documentation (docs/*.md), readable without logging in. Rendered in the browser.
  // [file, title, nav group "section/subgroup"]; an empty group keeps the page out of the nav (old links still work).
  const DOCS: [string, string, string][] = [['quickstart', '快速上手', '使用手册/业务开发人员'], ['chat', 'Amber 机器人对话', '使用手册/业务开发人员'], ['with-agent', '和自己的 agent 协作', '使用手册/业务开发人员'], ['web', '网站操作', '使用手册/业务开发人员'], ['scenarios', '主要场景的实现方式', '使用手册/业务开发人员'], ['pages', '页面应用', '使用手册/业务开发人员'], ['sharing', '应用的分享', '使用手册/业务开发人员'], ['faq', '常见问题', '使用手册/业务开发人员'], ['review', '审核指南', '使用手册/审核人员'], ['admin', '管理员手册', '使用手册/系统管理员'], ['install', '安装与部署', '安装运维'], ['feishu-setup', '飞书应用配置', '安装运维'], ['executor', '执行端与运行环境', '安装运维'], ['concepts', '概念模型', '概念模型与开发参考'], ['script', '脚本约定', '概念模型与开发参考'], ['cli-and-skill', 'agent 接入：命令行、skill 与接口', '概念模型与开发参考'], ['identity', '可信身份', '概念模型与开发参考'], ['identity-example', '可信身份：完整示例', '概念模型与开发参考'], ['environment-format', '运行环境定义格式', '概念模型与开发参考'], ['usage', '使用指南（已拆分）', '']];
  // Diagrams referenced from the docs as assets/<name>.svg, and the login-page animation (amber-why.gif).
  const docAssets = new Map<string, { type: string; body: Buffer }>();
  for (const f of readdirSync(join(import.meta.dirname, '..', 'docs', 'assets'))) {
    if (/^[a-z0-9-]+\.svg$/.test(f) || f === 'amber-why.gif') docAssets.set(`/docs/assets/${f}`, { type: f.endsWith('.svg') ? 'image/svg+xml' : 'image/gif', body: readFileSync(join(import.meta.dirname, '..', 'docs', 'assets', f)) });
  }
  const docTemplate = readFileSync(join(import.meta.dirname, '..', 'web', 'docs.html'), 'utf8');
  const jobs = new Map<string, WebJob>();
  const docPages = new Map<string, string>();
  for (const [name, title] of DOCS) {
    const md = readFileSync(join(import.meta.dirname, '..', 'docs', `${name}.md`), 'utf8');
    const nav = DOCS.map(([n, t, g]) => ({ name: n, title: t, group: g, current: n === name }));
    // JSON inside <script>: escape "<" so the document can never close the script tag.
    const data = JSON.stringify({ md, nav }).replace(/</g, '\\u003c');
    docPages.set(name, docTemplate.replace('__TITLE__', `${title} · Amber`).replace('__DOC_DATA__', data));
  }

  // Front-end libraries are served from this repo, never from an outside CDN.
  const vendor = new Map<string, Buffer>();
  for (const f of ['marked.min.js', 'purify.min.js', 'vega.min.js', 'vega-lite.min.js', 'vega-embed.min.js', 'highlight.min.js']) {
    vendor.set(`/vendor/${f}`, readFileSync(join(import.meta.dirname, '..', 'web', 'vendor', f)));
  }

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string | string[]> = {}) => {
    res.writeHead(status, { 'content-type': type, ...SECURITY_HEADERS, ...extra });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string | string[]> = {}) =>
    send(res, status, 'application/json; charset=utf-8', JSON.stringify(body), extra);

  // Page apps: files are served from their own origin (pagesBaseUrl), never from Amber's, so a page has no
  // access to Amber's cookies or API; the shell on Amber's origin frames it and relays its calls.
  const pagesOrigin = deps.pagesBaseUrl ? new URL(deps.pagesBaseUrl).origin : '';
  const pagesHost = deps.pagesBaseUrl ? new URL(deps.pagesBaseUrl).host : '';
  // On Amber's own origin the framed page could reach into the shell and lift its sandbox: refuse to start.
  if (pagesOrigin && (pagesOrigin === deps.origin || pagesHost === new URL(deps.origin).host)) throw new Error('pagesBaseUrl must be a different host from Amber\'s website (see docs/install.md)');
  const sdk = readFileSync(join(import.meta.dirname, '..', 'web', 'page-sdk.js'), 'utf8').replace('__AMBER_ORIGIN__', JSON.stringify(deps.origin));
  const shellTpl = readFileSync(join(import.meta.dirname, '..', 'web', 'page-shell.html'), 'utf8');
  const PAGE_CSP = `default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; `
    + `connect-src 'self'; media-src 'self' data: blob:; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'self'; frame-ancestors ${deps.origin}`;
  const pageFile = (res: ServerResponse, status: number, type: string, body: string | Buffer) => {
    res.writeHead(status, { 'content-type': type, 'content-security-policy': PAGE_CSP, 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
    res.end(body);
  };

  /** A run can take minutes (run limits); one still going after a short wait is handed to the page as a job to poll. */
  const longRun = async <T,>(res: ServerResponse, owner: string, run: Promise<T>, view: (r: T) => Record<string, unknown>) => {
    const quick = await Promise.race([run.then(r => ({ r }), e => ({ e })), new Promise<null>(ok => setTimeout(() => ok(null), deps.runWaitMs ?? (Number(process.env.AMBER_WEB_RUN_WAIT_MS) || 20_000)))]);
    if (quick) { if ('e' in quick) throw quick.e; return json(res, 200, view(quick.r)); }
    const id = randomBytes(12).toString('hex');
    const job: WebJob = { owner };
    jobs.set(id, job);
    run.then(r => { job.done = view(r); }, e => { job.done = { ok: false, error: e instanceof AmberError ? e.code : 'internal', message: e instanceof AmberError ? e.message : '执行失败' }; })
      .finally(() => { job.endedAt = Date.now(); });
    return json(res, 200, { ok: true, pending: true, job: id });
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://amber');
    try {
      if (pagesHost && req.headers.host === pagesHost) {
        // The page origin: page files (behind a signed, expiring link), the page SDK and the shared libraries. Nothing else.
        if (req.method !== 'GET') return pageFile(res, 405, 'text/plain; charset=utf-8', '');
        if (url.pathname === '/sdk/amber-page.js') return pageFile(res, 200, 'text/javascript; charset=utf-8', sdk);
        if (vendor.has(url.pathname)) return pageFile(res, 200, 'text/javascript; charset=utf-8', vendor.get(url.pathname)!);
        const cm = /^\/c\/([A-Za-z0-9._-]{1,300})\/(.*)$/.exec(url.pathname);
        const f = cm && deps.pages ? await deps.pages.file(cm[1], decodeURIComponent(cm[2])) : undefined;
        if (!f) return pageFile(res, 404, 'text/plain; charset=utf-8', '链接无效或已过期，请回到页面刷新');
        return pageFile(res, 200, f.type, f.bytes);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', page);
      if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) return send(res, 200, 'text/html; charset=utf-8', docPages.get(DOCS[0][0])!);
      const dm = /^\/docs\/([a-z-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && dm && docPages.has(dm[1])) return send(res, 200, 'text/html; charset=utf-8', docPages.get(dm[1])!);
      if (req.method === 'GET' && docAssets.has(url.pathname)) { const a = docAssets.get(url.pathname)!; return send(res, 200, a.type, a.body, { 'cache-control': 'max-age=3600' }); }
      if (req.method === 'GET' && vendor.has(url.pathname)) return send(res, 200, 'text/javascript; charset=utf-8', vendor.get(url.pathname)!, { 'cache-control': 'max-age=86400' });
      if (req.method === 'GET' && url.pathname === '/logo.svg') return send(res, 200, 'image/svg+xml', logo, { 'cache-control': 'max-age=86400' });

      if (req.method === 'GET' && url.pathname === '/login') {
        const t = url.searchParams.get('t') ?? '';
        const login = t ? store.consumeWebLogin(hashToken(t), LOGIN_TTL_MS) : undefined;
        if (!login) return send(res, 400, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amber</title><body style="font:16px/1.7 system-ui,sans-serif;padding:40px 16px;max-width:560px;margin:auto"><h2>登录链接无效</h2><p>链接已用过或已超过 5 分钟。请在飞书里私聊 Amber，重新发送「登录」。</p><p><a href="/">返回 Amber</a></p>`);
        const session = newToken();
        store.insertWebSession(hashToken(session), login.unionId, login.openId, SESSION_TTL_MS);
        store.audit(login.unionId, 'web.login', { ip: String(req.headers['x-amber-client-ip'] ?? ''), ua: String(req.headers['user-agent'] ?? '').slice(0, 200) });
        if (login.messageId) deps.onLoginUsed(login.messageId, Date.now()).catch(() => {});
        return send(res, 302, 'text/plain', '', {
          location: login.next && /^\/p\/[0-9a-f]{8}\/$/.test(login.next) ? login.next : '/',   // a link sent for a page opens it
          'set-cookie': `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
      }

      const raw = cookieOf(req);
      const who = raw ? store.webSession(hashToken(raw)) : undefined;

      // The shell for a page app: a full-window frame around the page, relaying its calls (web/page-shell.html).
      const pm = req.method === 'GET' ? /^\/p\/([0-9a-f]{8})(\/?)$/.exec(url.pathname) : null;
      if (pm && deps.pages && pagesOrigin) {
        if (!pm[2]) return send(res, 301, 'text/plain', '', { location: `/p/${pm[1]}/` });
        const note = (title: string, text: string) => send(res, 200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Amber</title><body style="font:16px/1.7 system-ui,sans-serif;padding:40px 16px;max-width:560px;margin:auto"><h2>${title}</h2><p>${text}</p>`);
        if (!who) return note('请先登录 Amber', '回到飞书里这个页面的卡片，点「私聊我免登录链接」，在私聊里一点就能打开。也可以私聊 Amber 发送「登录」，登录后回到这个页面刷新。');
        const p = store.getPage(pm[1]);
        if (!p || !(await deps.pages.canView(p, who.unionId))) return note('打不开这个页面', '页面不存在，或者你没有访问权限。需要的话请联系页面的创建人。');
        const data = JSON.stringify({ id: p.id, name: p.name, src: `${pagesOrigin}/c/${deps.pages.token(p, who.unionId)}/`, pagesOrigin, me: (await deps.nameOf(who.unionId)) ?? '', allowHosts: getGlobalAllowHosts(store) }).replace(/</g, '\\u003c');
        return send(res, 200, 'text/html; charset=utf-8', shellTpl.replace('__TITLE__', escHtml(p.name)).replace('__PAGE_DATA__', data), {
          'content-security-policy': `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-src ${pagesOrigin}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
        });
      }

      if (url.pathname === '/web/api/logout' && req.method === 'POST') {
        if (raw) store.revokeWebSession(hashToken(raw));
        if (who) store.audit(who.unionId, 'web.logout', {});
        return json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0` });
      }
      if (url.pathname.startsWith('/web/api/')) {
        if (!who) return json(res, 401, { ok: false, error: 'login_required' });
        if (req.method === 'GET' && url.pathname === '/web/api/me') {
          return json(res, 200, { ok: true, name: (await deps.nameOf(who.unionId)) ?? '', unionId: who.unionId });
        }
        if (req.method === 'GET' && url.pathname === '/web/api/overview') return json(res, 200, { ok: true, ...(await overview(store, deps, who.unionId)), timezones: timezones() });
        if (req.method === 'GET' && url.pathname === '/web/api/audit') {
          // The audit log (admins only): newest first, filtered by category, text or person; 50 at a time.
          if (!deps.isAdmin(who.unionId)) return json(res, 404, { ok: false, error: 'not_found' });
          const cat = url.searchParams.get('cat') ?? '';
          const prefixes = AUDIT_CATEGORIES[cat]?.prefixes;
          const rows = store.listAudit({ before: Number(url.searchParams.get('before')) || undefined, limit: 50, prefixes, q: (url.searchParams.get('q') ?? '').trim().slice(0, 100) || undefined, actor: url.searchParams.get('actor') || undefined });
          const names = new Map<string, string>();
          for (const u of new Set(rows.map(r => r.actor).filter(Boolean) as string[])) names.set(u, (await deps.nameOf(u).catch(() => undefined)) ?? u);
          return json(res, 200, { ok: true, categories: Object.entries(AUDIT_CATEGORIES).map(([k, v]) => ({ key: k, label: v.label })),
            rows: rows.map(r => ({ ...r, actorName: r.actor ? names.get(r.actor) : null, detail: r.detail.length > 2000 ? r.detail.slice(0, 2000) + '…' : r.detail })) });
        }
        if (req.method === 'GET' && url.pathname === '/web/api/settings') {
          // Site-wide settings: admins only.
          if (!deps.isAdmin(who.unionId)) return json(res, 404, { ok: false, error: 'not_found' });
          const v = store.getSetting(CARD_FOOTER_KEY);
          return json(res, 200, { ok: true, cardFooter: v ?? null, defaultCardFooter: DEFAULT_CARD_FOOTER, max: CARD_FOOTER_MAX,
            limits: getLimits(store), defaultLimits: DEFAULT_LIMITS, bounds: { timeout: TIMEOUT_BOUNDS, concurrency: CONCURRENCY_BOUNDS }, running: SLOTS.snapshot(), localAllowHosts: getLocalAllowHosts(store), globalAllowHosts: getGlobalAllowHosts(store), defaultGlobalAllowHosts: FEISHU_HOSTS });
        }
        for (const [id, j] of jobs) if (j.endedAt && Date.now() - j.endedAt > JOB_KEEP_MS) jobs.delete(id);
        const jm = req.method === 'GET' ? /^\/web\/api\/run-jobs\/([0-9a-f]{24})$/.exec(url.pathname) : null;
        if (jm) {
          const j = jobs.get(jm[1]);
          if (!j || j.owner !== who.unionId) return json(res, 404, { ok: false, error: 'not_found', message: '没有这个执行（可能已经过期）' });
          if (!j.done) return json(res, 200, { ok: true, pending: true });
          jobs.delete(jm[1]);   // handed over once; the run itself stays in 最近运行
          return json(res, 200, j.done);
        }
        if (req.method === 'GET' && url.pathname === '/web/api/store') {
          // Amber Store (#4): listed apps (plus your own delisted ones), and where you can install.
          if (!deps.apps) return json(res, 404, { ok: false, error: 'not_found' });
          const apps = store.listApps().filter(a => a.status === 'listed' || a.maintainerUnionId === who.unionId || deps.isAdmin(who.unionId));
          const targets: { target: string; name: string }[] = [{ target: 'p2p', name: '我和 Amber 的私聊' }];
          for (const g of (await deps.botGroups?.().catch(() => [])) ?? []) if (await deps.isMember(g.chatId, who.unionId) === true) targets.push({ target: `group:${g.chatId}`, name: g.name || g.chatId });
          return json(res, 200, { ok: true, apps: await Promise.all(apps.map(a => deps.apps!.view(a, who.unionId))), targets });
        }
        const upMatch = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/upgrade$/.exec(url.pathname);
        if (req.method === 'GET' && upMatch && deps.apps) {
          // What upgrading an installation would change (#4): its owner only.
          const t = await target(store, deps, who.unionId, String(url.searchParams.get('scope') ?? ''), upMatch[1]);
          if (t.cmd.ownerUnionId !== who.unionId) throw new AmberError('forbidden', '只有应用的创建人可以升级');
          return json(res, 200, { ok: true, ...deps.apps.upgradeDiff(t.cmd) });
        }
        const srcMatch = /^\/web\/api\/store\/([A-Za-z0-9-]{1,40})\/source$/.exec(url.pathname);
        if (req.method === 'GET' && srcMatch) {
          const app = deps.apps && store.getApp(srcMatch[1]);
          if (!app || (app.status !== 'listed' && app.maintainerUnionId !== who.unionId && !deps.isAdmin(who.unionId))) return json(res, 404, { ok: false, error: 'not_found', message: '没有这个应用' });
          return json(res, 200, { ok: true, ...deps.apps!.source(app) });
        }
        if (req.method === 'GET' && url.pathname.startsWith('/web/api/groups/')) {
          // Members of a group: for an admin offering an orphaned app to someone (#4), or a member copying their app
          // to another member (#8). Only admins and the group's own members may list it.
          const g = /^\/web\/api\/groups\/(oc_[A-Za-z0-9]+)\/members$/.exec(url.pathname);
          if (!g || (!deps.isAdmin(who.unionId) && await deps.isMember(g[1], who.unionId) !== true)) return json(res, 404, { ok: false, error: 'not_found' });
          return json(res, 200, { ok: true, members: await deps.groupMembers(g[1]) });
        }
        if (req.method === 'GET' && url.pathname === '/web/api/runs') {
          return json(res, 200, { ok: true, runs: store.runsByCaller(who.unionId, 30).map(r => ({
            id: r.id, command: r.commandName, channel: r.channel, status: r.status, startedAt: r.startedAt, elapsedMs: r.finishedAt ? r.finishedAt - r.startedAt : null, args: r.args, scheduleId: r.scheduleId,
          })) });
        }
        let m: RegExpExecArray | null;
        if (req.method === 'GET' && (m = /^\/web\/api\/runs\/([A-Za-z0-9-]{1,40})$/.exec(url.pathname))) {
          const r = store.getRun(m[1]);
          // Only your own runs.
          if (!r || r.callerUnionId !== who.unionId) return json(res, 404, { ok: false, error: 'not_found', message: '没有这条运行记录' });
          return json(res, 200, { ok: true, id: r.id, status: r.status, markdown: r.result ?? '', error: r.error, startedAt: r.startedAt });
        }
        if (req.method === 'GET' && (m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/source$/.exec(url.pathname))) {
          // Whoever may run a command may read its code; so may an admin.
          const t = await target(store, deps, who.unionId, String(url.searchParams.get('scope') ?? ''), m[1], true);
          const c = t.cmd;
          const review = store.getReview(c.id);
          return json(res, 200, { ok: true, id: c.id, name: c.name, specHash: c.specHash, createdAt: c.createdAt,
            script: { kind: c.script.kind, lang: c.script.lang, network: !!c.script.network, services: c.script.services ?? {}, secrets: c.script.secrets ?? [], interpreter: c.script.interpreter ?? null, env: c.script.env ?? null, timeoutMs: c.script.timeoutMs ?? null, timeoutLabel: timeoutLabel(c.script.timeoutMs, getLimits(store)), code: c.script.code },
            params: c.params, options: c.options, reviewDocUrl: review.docUrl ?? null,
            history: store.versionsOf(c.id).map(v => ({ id: v.id, specHash: v.specHash, createdAt: v.createdAt, reviewDocUrl: store.getReview(v.id).docUrl ?? null })) });
        }
        if (req.method !== 'POST') return json(res, 404, { ok: false, error: 'not_found' });
        // Cross-site request protection: JSON only (forces a CORS preflight, which is never granted) and same origin.
        const origin = req.headers.origin;
        if ((origin && origin !== deps.origin) || !String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          return json(res, 403, { ok: false, error: 'forbidden', message: '请求来源不对' });
        }
        const body = await readJson(req);
        const person: Caller = { unionId: who.unionId, openId: who.openId ?? undefined, chatId: '', chatType: 'p2p', channel: 'web' };
        if (deps.pages && (m = /^\/web\/api\/pages\/([0-9a-f]{8})\/(run|access|delete)$/.exec(url.pathname))) {
          const id = m[1];
          if (m[2] === 'access') { const p = deps.pages.setAccess(id, who.unionId, body.access, body.members); return json(res, 200, { ok: true, access: p.access, members: p.members }); }
          if (m[2] === 'delete') { deps.pages.remove(id, who.unionId, deps.isAdmin(who.unionId)); return json(res, 200, { ok: true }); }
          rateLimit(who.unionId);
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.args ?? {})) if (v !== null && v !== undefined) args[k] = String(v).slice(0, 2000);
          const run = deps.pages.run(id, { unionId: who.unionId, openId: who.openId ?? undefined }, String(body.app ?? ''), args, body.confirm === true);
          return await longRun(res, who.unionId, run, r => ({ ok: r.ok, runId: r.runId, markdown: r.markdown, ...outputBlocks(r.markdown), error: r.error, elapsedMs: r.elapsedMs }));
        }
        if (url.pathname === '/web/api/run') {
          rateLimit(who.unionId);
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), String(body.commandId ?? ''));
          if (t.cmd.options.confirm && body.confirm !== true) throw new AmberError('needs_confirm', '这个应用需要确认后执行');
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.args ?? {})) if (v !== null && v !== undefined) args[k] = String(v).slice(0, 2000);
          const run = runCommand(store, t.cmd, args, { ...person, chatId: t.chatId, chatType: t.chatType },
            { city: () => deps.cityOf(who.unionId), signer: deps.signer }, { viaForm: true });
          return await longRun(res, who.unionId, run, r => ({ ok: r.ok, runId: r.runId, markdown: r.markdown, error: r.error, elapsedMs: r.elapsedMs }));
        }
        if (url.pathname === '/web/api/schedules') {
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), String(body.commandId ?? ''));
          if (t.cmd.options.confirm && body.confirm !== true) throw new AmberError('needs_confirm', '这个应用需要确认后才能定时');
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.args ?? {})) if (v !== null && v !== undefined && String(v) !== '') args[k] = String(v).slice(0, 2000);
          const { parseRule } = await import('./schedule-rule.ts');
          const sch = await deps.scheduler.create({ cmd: t.cmd, chatId: t.chatId, chatType: t.chatType, replyTo: null, inThread: false, creator: { ...person, chatId: t.chatId, chatType: t.chatType },
            args, rule: parseRule(String(body.at ?? ''), String(body.tz || defaultTz())), requestedBy: 'web', via: { via: 'web' } });
          return json(res, 200, { ok: true, scheduleId: sch.id, rule: describeRule(sch.rule), next: formatAt(sch.nextRunAt, sch.rule.tz) });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/secrets$/.exec(url.pathname))) {
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1], true);
          const c = t.cmd;
          if (c.ownerUnionId !== who.unionId && !deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有应用的创建人或管理员可以设置密钥');
          const name = String(body.name ?? '');
          if (!(c.script.secrets ?? []).includes(name)) throw new AmberError('bad_secret', `这个应用没有声明密钥 ${name}`);
          const vault = secretVault();
          if (!vault) throw new AmberError('no_vault', '密钥存储不可用');
          if (body.delete === true) {
            vault.delete(lineOf(c), name);
            store.audit(who.unionId, 'secret.delete', { commandId: c.id, chatId: c.chatId, name: c.name, secret: name, via: 'web' });
          } else {
            try { vault.set(lineOf(c), name, String(body.value ?? '').trim(), who.unionId); } catch (e) { throw new AmberError('bad_secret', (e as Error).message); }
            store.audit(who.unionId, 'secret.set', { commandId: c.id, chatId: c.chatId, name: c.name, secrets: [name], via: 'web' });
          }
          return json(res, 200, { ok: true, secrets: vault.info(lineOf(c), c.script.secrets!) });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/clone$/.exec(url.pathname))) {
          // #8: the creator copies their group app to another member; it is theirs once they accept.
          if (!deps.requestClone) throw new AmberError('not_found', '不支持');
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          const r = await deps.requestClone(t.cmd.id, String(body.to ?? ''), { unionId: who.unionId, openId: who.openId ?? undefined });
          return json(res, 200, { ok: true, ...r });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/reassign$/.exec(url.pathname))) {
          if (!deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有管理员可以重新分配应用');
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1], true);
          const r = await deps.requestReassign(t.cmd.id, String(body.to ?? ''), { unionId: who.unionId, openId: who.openId ?? undefined });
          return json(res, 200, { ok: true, ...r });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/config$/.exec(url.pathname))) {
          // Configuration items (#3) are set here only: by the command's creator or an admin.
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1], true);
          const c = t.cmd;
          if (c.ownerUnionId !== who.unionId && !deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有应用的创建人或管理员可以设置配置项');
          const p = configParams(c.params).find(x => x.name === String(body.name ?? ''));
          if (!p) throw new AmberError('bad_config', `这个应用没有配置项 ${String(body.name ?? '').slice(0, 40)}`);
          if (body.delete === true) {
            store.deleteConfig(c.chatId, c.line, p.name);
            store.audit(who.unionId, 'config.delete', { commandId: c.id, chatId: c.chatId, name: c.name, item: p.name, via: 'web' });
          } else {
            const value = String(body.value ?? '').trim();
            if (!value) throw new AmberError('bad_config', '请填写值；要清空请点「清除」');
            // Same checks as a run (type, range, length, pattern), without the required/default rules.
            const ok = await validateArgs([{ ...p, required: true, default: undefined }], { [p.name]: value.slice(0, 2000) });
            store.putConfig(c.chatId, c.line, p.name, ok[p.name], who.unionId);
            store.audit(who.unionId, 'config.set', { commandId: c.id, chatId: c.chatId, name: c.name, item: p.name, value: ok[p.name], via: 'web' });
          }
          return json(res, 200, { ok: true });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/publish$/.exec(url.pathname))) {
          // #4: the creator lists their live command in Amber Store; reviewers approve it once.
          if (!deps.apps) throw new AmberError('not_found', '没有开启 Amber Store');
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          const r = await deps.apps.requestListing(t.cmd.id, { unionId: who.unionId, openId: who.openId ?? undefined });
          return json(res, 200, { ok: true, ...r });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/upgrade$/.exec(url.pathname))) {
          if (!deps.apps) throw new AmberError('not_found', '没有开启 Amber Store');
          if (body.confirm !== true) throw new AmberError('needs_confirm', '请确认后再升级');
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          const n = deps.apps.upgrade(t.cmd.id, { unionId: who.unionId, openId: who.openId ?? undefined });
          return json(res, 200, { ok: true, commandId: n.id, version: store.installOf(n.id)?.version ?? null });
        }
        if ((m = /^\/web\/api\/store\/([A-Za-z0-9-]{1,40})\/(install|delist|relist|maintainer)$/.exec(url.pathname))) {
          if (!deps.apps) throw new AmberError('not_found', '没有开启 Amber Store');
          if (m[2] === 'delist' || m[2] === 'relist') {
            if (body.confirm !== true) throw new AmberError('needs_confirm', '请确认后再操作');
            const a = m[2] === 'delist' ? deps.apps.delist(m[1], who.unionId) : deps.apps.relist(m[1], who.unionId);
            return json(res, 200, { ok: true, status: a.status });
          }
          if (m[2] === 'maintainer') {
            const a = await deps.apps.setMaintainer(m[1], String(body.email ?? ''), who.unionId);
            return json(res, 200, { ok: true, maintainer: (await deps.nameOf(a.maintainerUnionId)) ?? '' });
          }
          rateLimit(who.unionId);
          const c = await deps.apps.install(m[1], { unionId: who.unionId, openId: who.openId ?? undefined }, String(body.target ?? ''), body.name === undefined ? undefined : String(body.name), { dev: body.dev === true });
          return json(res, 200, { ok: true, commandId: c.id, name: c.name, scope: c.scopeType === 'p2p' ? 'p2p' : `group:${c.chatId}`,
            needs: { config: configParams(c.params).filter(p => p.required && p.default === undefined).map(p => p.label ?? p.name), secrets: c.script.secrets ?? [] } });
        }
        if (url.pathname === '/web/api/settings/allow-hosts') {
          // Network allow lists: global (every environment) and Amber's own machine. Admins only.
          if (!deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有管理员可以修改网络白名单');
          const before = { global: getGlobalAllowHosts(store), local: getLocalAllowHosts(store) };
          // Both checked before either is saved.
          const g = checkAllowHosts('global', body.global ?? before.global), l = checkAllowHosts('local', body.local ?? before.local);
          const after = { global: saveAllowHosts(store, 'global', g), local: saveAllowHosts(store, 'local', l) };
          store.audit(who.unionId, 'web.allow_hosts', { before, after });
          return json(res, 200, { ok: true, ...after });
        }
        if (url.pathname === '/web/api/settings/run-limits') {
          // Run time and how many runs at once (Amber's machine, executors by default, per person). Admins only.
          if (!deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有管理员可以修改运行限制');
          const before = getLimits(store);
          const after = saveLimits(store, { ...before, ...pick(body, ['defaultTimeoutSec', 'maxTimeoutSec', 'maxConcurrentLocal', 'maxConcurrentExecutor', 'maxConcurrentPerUser']) });
          store.audit(who.unionId, 'web.run_limits', { before, after });
          return json(res, 200, { ok: true, limits: after });
        }
        if ((m = /^\/web\/api\/executors\/([0-9a-f]{16})\/limit$/.exec(url.pathname))) {
          // One executor's own cap on runs at once; null = back to the executors' default.
          if (!deps.isAdmin(who.unionId) || !deps.hub) throw new AmberError('forbidden', '只有管理员可以修改执行端的并发上限');
          const e = store.listExecutors().find(x => x.id === m![1]);
          if (!e) throw new AmberError('not_found', '没有这个执行端');
          const before = getLimits(store);
          const executors = { ...before.executors };
          if (body.value === null) delete executors[e.name]; else executors[e.name] = Number(body.value);
          const after = saveLimits(store, { ...before, executors });
          store.audit(who.unionId, 'web.executor_limit', { executor: e.id, name: e.name, before: before.executors[e.name] ?? null, after: after.executors[e.name] ?? null });
          return json(res, 200, { ok: true, limit: after.executors[e.name] ?? null, default: after.maxConcurrentExecutor });
        }
        if (url.pathname === '/web/api/settings/card-footer') {
          // The line at the bottom of every card. null = back to the default (the project link); "" = no footer.
          if (!deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有管理员可以修改卡片页脚');
          const before = store.getSetting(CARD_FOOTER_KEY) ?? null;
          const v = body.value === null ? null : cleanFooter(String(body.value ?? ''));
          store.setSetting(CARD_FOOTER_KEY, v);
          store.audit(who.unionId, 'web.card_footer', { before, after: v });
          return json(res, 200, { ok: true, cardFooter: v });
        }
        if ((m = /^\/web\/api\/executors\/([0-9a-f]{16})\/(approve|reject|revoke)$/.exec(url.pathname))) {
          if (!deps.isAdmin(who.unionId) || !deps.hub) throw new AmberError('forbidden', '只有管理员可以管理执行端');
          if (body.confirm !== true) throw new AmberError('needs_confirm', '请确认后再操作');
          if (m[2] === 'revoke') {
            const e = deps.hub.revokeId(m[1], who.unionId);
            if (!e) throw new AmberError('stale', '这个执行端现在不是已批准状态');
            return json(res, 200, { ok: true, status: e.status });
          }
          const r = deps.hub.decide(m[1], String(body.h ?? ''), m[2] === 'approve', who.unionId);
          if (!r.ok) throw new AmberError('stale', r.message);
          store.audit(who.unionId, 'web.executor_decide', { id: m[1], approve: m[2] === 'approve' });
          return json(res, 200, { ok: true, status: r.row!.status });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/retire$/.exec(url.pathname))) {
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1], true);
          if (body.confirm !== true) throw new AmberError('needs_confirm', '请确认后再下线');
          const r = await deps.retire(t.cmd.id, { unionId: who.unionId }, (await deps.nameOf(who.unionId)) ?? '创建人', { delist: body.delist === true });
          return json(res, 200, { ok: true, ...r });
        }
        if ((m = /^\/web\/api\/schedules\/([A-Za-z0-9-]{1,40})\/(pause|resume|delete|run)$/.exec(url.pathname))) {
          const sch = store.getSchedule(m[1]);
          if (!sch || !deps.scheduler.canManage(sch, who.unionId)) return json(res, 404, { ok: false, error: 'not_found', message: '没有这个定时任务，或你不是它的创建人' });
          if (m[2] === 'pause') deps.scheduler.pauseBy(sch, who.unionId, '在网站上暂停');
          else if (m[2] === 'resume') deps.scheduler.resume(sch, who.unionId);
          else if (m[2] === 'delete') deps.scheduler.remove(sch, who.unionId);
          else {
            // Running it now runs the creator's command: the creator only, not an admin (#4).
            if (sch.creatorUnionId !== who.unionId) return json(res, 403, { ok: false, error: 'forbidden', message: '只有定时任务的创建人可以立即运行' });
            await deps.scheduler.runOnce(sch, true);
            const after = store.getSchedule(sch.id);
            return json(res, 200, { ok: true, runId: after?.lastRunId, lastStatus: after?.lastStatus });
          }
          return json(res, 200, { ok: true });
        }
        return json(res, 404, { ok: false, error: 'not_found' });
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      if (e instanceof AmberError) return json(res, e.code === 'not_found' ? 404 : e.code === 'forbidden' ? 403 : 400, { ok: false, error: e.code, message: e.message });
      console.log(new Date().toISOString(), 'web error', url.pathname, (e as Error).message);
      return json(res, 500, { ok: false, error: 'internal' });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(new Date().toISOString(), `web listening on 127.0.0.1:${port}`));
  return server;
}

function cmdView(c: CommandRow, viewer?: string, isAdmin?: (u: string) => boolean, store?: Store, apps?: AppStore) {
  const canManage = !!viewer && (c.ownerUnionId === viewer || !!isAdmin?.(viewer));
  // Secret names for everyone; when and what tail only for those who may change them (D48). Never values.
  const secrets = c.script.secrets?.length ? (secretVault()?.info(lineOf(c), c.script.secrets) ?? c.script.secrets.map(name => ({ name, set: false })))
    .map(i => (canManage ? i : { name: i.name, set: i.set })) : [];
  return {
    canManage,
    // Only the creator runs their command (#4); everyone may run a global one. An admin may look, not run.
    canRun: !!viewer && (c.global || c.ownerUnionId === viewer),
    // Amber Store (#4): listed from here (the original), installed from the Store, or can be listed.
    ...(store && apps ? storeInfo(c, viewer, store, apps) : {}),
    secrets,
    version: store ? store.versionsOf(c.id).length + 1 : 1,
    id: c.id, name: c.name, description: c.description, global: c.global, options: c.options,
    params: runParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required, default: p.default, fromCity: p.defaultFrom === 'caller.city' })),
    // Configuration items (#3): values are not secret, everyone who sees the command sees them.
    config: (v => configParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required, default: p.default ?? null, value: v[p.name] ?? null })))(store ? configValues(store, c) : {}),
  };
}

function storeInfo(c: CommandRow, viewer: string | undefined, store: Store, apps: AppStore) {
  const original = apps.appOfOriginal(c);
  const inst = store.installOf(c.id);
  const from = inst ? store.getApp(inst.appId) : undefined;
  const pending = store.pendingListingFor(c.id);
  return {
    listed: original ? { appId: original.id, status: original.status } : null,
    installed: inst ? { appId: inst.appId, name: from?.name ?? '', version: inst.version } : null,
    listing: !!pending,
    publishable: !!viewer && c.ownerUnionId === viewer && !apps.whyNotListable(c, viewer),
    upgrade: !!viewer && c.ownerUnionId === viewer ? apps.upgradeOf(c) ?? null : null,
    canClone: !!viewer && c.ownerUnionId === viewer && c.scopeType === 'group' && c.status === 'active' && !inst,
  };
}

const LAST: Record<string, string> = { ok: '成功', ok_silent: '成功（无输出）', failed: '失败', missed: '错过', skipped_overlap: '跳过', delivery_failed: '结果发送失败' };

function schView(store: Store, s: ScheduleRow, viewer?: string, isAdmin?: (u: string) => boolean) {
  return {
    mine: viewer ? s.creatorUnionId === viewer : false,
    canManage: !!viewer && (s.creatorUnionId === viewer || !!isAdmin?.(viewer)),
    commandId: s.commandId,
    id: s.id, command: store.getCommand(s.commandId)?.name ?? s.commandId, rule: describeRule(s.rule), status: s.status, pauseReason: s.pauseReason,
    next: s.status === 'active' ? formatAt(s.nextRunAt, s.rule.tz) : null, last: s.lastRunAt ? `${formatAt(s.lastRunAt, s.rule.tz)} ${LAST[s.lastStatus ?? ''] ?? ''}` : null,
    args: s.args,
  };
}

/** What this person can see: their own commands (in their private chat and in groups they are in) and global
 *  commands (#4). An admin also sees everyone's commands, in every group, to look at and take offline. */
async function overview(store: Store, deps: WebDeps, unionId: string) {
  const groups: { chatId: string; name: string; commands: unknown[]; schedules: unknown[]; pages: unknown[] }[] = [];
  const admin = deps.isAdmin(unionId);
  let membershipUnknown = false;
  const allPages = deps.pages ? store.listPages().filter(p => p.status === 'active') : [];
  // A page is listed for its owner, for the people it is shared with, and for admins (to manage; opening still needs access).
  const pagesIn = (chatId: string) => allPages.filter(p => p.chatId === chatId && (admin || p.ownerUnionId === unionId || p.access === 'group' || (p.access === 'members' && p.members.includes(unionId))))
    .map(p => pageView(store, deps, p, unionId));
  for (const chatId of [...new Set([...store.groupChatsWithContent(), ...allPages.filter(p => p.chatType === 'group').map(p => p.chatId)])]) {
    if (!admin) {
      const m = await deps.isMember(chatId, unionId);
      if (m === undefined) { membershipUnknown = true; continue; }
      if (!m) continue;
    }
    const commands = store.listActiveByChat(chatId).filter(c => c.scopeType === 'group' && (admin || c.ownerUnionId === unionId));
    // For admins: which of them lost their creator (#4), so they can be offered to someone else.
    const orphans = new Set<string>();
    if (admin) for (const c of commands) if (await deps.isOrphan(c) === true) orphans.add(c.id);
    const schedules = store.schedulesInChat(chatId).filter(s => admin || s.creatorUnionId === unionId);
    const pages = pagesIn(chatId);
    if (!commands.length && !schedules.length && !pages.length) continue;
    groups.push({
      chatId, name: (await deps.chatName(chatId)) ?? chatId,
      commands: commands.map(c => ({ ...cmdView(c, unionId, deps.isAdmin, store, deps.apps), orphan: orphans.has(c.id) })),
      schedules: schedules.map(s => schView(store, s, unionId, deps.isAdmin)),
      pages,
    });
  }
  return {
    p2p: {
      commands: store.listActiveP2pByOwner(unionId).map(c => cmdView(c, unionId, deps.isAdmin, store, deps.apps)),
      schedules: store.schedulesByCreator(unionId).filter(s => s.chatType === 'p2p').map(s => schView(store, s, unionId)),
      pages: allPages.filter(p => p.chatType === 'p2p' && p.ownerUnionId === unionId).map(p => pageView(store, deps, p, unionId)),
    },
    groups,
    global: store.listActiveGlobal().map(c => cmdView(c, unionId, deps.isAdmin, store, deps.apps)),
    membershipUnknown,
    me: unionId,
    isAdmin: deps.isAdmin(unionId),
    ...(deps.isAdmin(unionId) && deps.hub ? { executors: await executorViews(store, deps) } : {}),
  };
}

/** What the website shows about a page. Who may open it is shown to its owner (and admins) only. */
function pageView(store: Store, deps: WebDeps, p: PageRow, viewer: string) {
  const mine = p.ownerUnionId === viewer, admin = deps.isAdmin(viewer);
  return {
    id: p.id, name: p.name, version: p.version, updatedAt: p.updatedAt, mine, canDelete: mine || admin, url: `/p/${p.id}/`,
    ...(mine || admin ? { access: p.access, members: p.members } : {}),
    apps: p.apps.map(a => {
      try {
        const c = deps.pages!.resolveApp(p, a.name);
        return { name: a.name, global: c.global, env: c.script.env ?? null, secrets: !!c.script.secrets?.length, confirm: !!c.options.confirm };
      } catch (e) { return { name: a.name, missing: (e as Error).message }; }
    }),
  };
}

/** Admins only: every executor with what the approval card shows. */
async function executorViews(store: Store, deps: WebDeps) {
  const out = [];
  for (const e of store.listExecutors()) {
    out.push({
      id: e.id, name: e.name, machine: e.machine, version: e.version, status: e.status, online: e.status === 'approved' && deps.hub!.online(e),
      envs: Object.fromEntries(Object.entries(e.envs).map(([k, v]) => [k, { ...v, access: effectiveAccess(v), credential: credentialPaths(v) }])), fingerprint: showFingerprint(e.fingerprint), createdAt: e.createdAt, lastSeen: e.lastSeen, decidedAt: e.decidedAt,
      decidedBy: e.decidedBy ? (await deps.nameOf(e.decidedBy)) ?? e.decidedBy : null,
      // Binds a decision to what the page showed, like the card.
      ...(e.status === 'pending' ? { h: envsHash(e.name, e.envs) } : {}),
    });
  }
  return out;
}
