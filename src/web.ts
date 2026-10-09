// Website (D34). Login happens in a chat with Amber: the person sends 「登录」 in their private chat,
// Amber answers with a one-time link (5 minutes, single use, bound to the sender from the Feishu
// event). No OAuth redirect URL, nothing for Feishu to call back. The link is only ever shown in the
// person's own private chat, so nobody can make someone else's browser log in as them.
// Served on its own loopback port, separate from the agent API.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store, CommandRow, ScheduleRow } from './db.ts';
import type { Caller } from './engine.ts';
import { runCommand, AmberError, secretVault, runParams, configParams, configValues, validateArgs } from './engine.ts';
import type { Signer } from './identity.ts';
import type { Scheduler } from './scheduler.ts';
import { envsHash, effectiveAccess, credentialPaths, type ExecutorHub } from './executors.ts';
import { showFingerprint } from './exec-proto.ts';
import { describeRule, formatAt, defaultTz, timezones } from './schedule-rule.ts';

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
  retire(cmdId: string, actor: { unionId: string }, byLabel: string): Promise<{ name: string; schedules: number }>;
  isAdmin(unionId: string): boolean;
  /** Executors (D50): admins see and decide them on the website too. */
  hub?: ExecutorHub;
  /** Origin of the site, e.g. http://amber.example.com — POSTs from anywhere else are refused. */
  origin: string;
}

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
async function target(store: Store, deps: WebDeps, unionId: string, scope: string, commandId: string): Promise<{ cmd: CommandRow; chatId: string; chatType: 'group' | 'p2p' }> {
  const cmd = store.getCommand(String(commandId));
  const nf = new AmberError('not_found', '没有找到这条指令');
  if (!cmd || cmd.status !== 'active') throw nf;
  if (scope === 'p2p') {
    if (cmd.scopeType !== 'p2p' || cmd.ownerUnionId !== unionId) throw nf;
    return { cmd, chatId: cmd.chatId, chatType: 'p2p' };
  }
  if (scope === 'global') {
    if (!cmd.global) throw nf;
    // Results of global commands used from the website go to the person's private chat with Amber.
    return { cmd, chatId: `web:${unionId}`, chatType: 'p2p' };
  }
  const m = /^group:(oc_[A-Za-z0-9]+)$/.exec(scope);
  if (!m || cmd.scopeType !== 'group' || cmd.chatId !== m[1]) throw nf;
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
  const DOCS: [string, string][] = [['usage', '使用指南'], ['cli-and-skill', 'amber 命令行与 skill'], ['executor', '执行端'], ['environment-format', '运行环境定义格式'], ['identity', '可信身份'], ['identity-example', '可信身份：完整示例'], ['install', '安装与部署'], ['feishu-setup', '飞书应用配置']];
  const docTemplate = readFileSync(join(import.meta.dirname, '..', 'web', 'docs.html'), 'utf8');
  const docPages = new Map<string, string>();
  for (const [name, title] of DOCS) {
    const md = readFileSync(join(import.meta.dirname, '..', 'docs', `${name}.md`), 'utf8');
    const nav = DOCS.map(([n, t]) => ({ name: n, title: t, current: n === name }));
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

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://amber');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return send(res, 200, 'text/html; charset=utf-8', page);
      if (req.method === 'GET' && (url.pathname === '/docs' || url.pathname === '/docs/')) return send(res, 200, 'text/html; charset=utf-8', docPages.get('usage')!);
      const dm = /^\/docs\/([a-z-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && dm && docPages.has(dm[1])) return send(res, 200, 'text/html; charset=utf-8', docPages.get(dm[1])!);
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
          location: '/',
          'set-cookie': `${COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`,
        });
      }

      const raw = cookieOf(req);
      const who = raw ? store.webSession(hashToken(raw)) : undefined;

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
          // Same visibility rule as running it: anyone who may run a command may read its code.
          const t = await target(store, deps, who.unionId, String(url.searchParams.get('scope') ?? ''), m[1]);
          const c = t.cmd;
          const review = store.getReview(c.id);
          return json(res, 200, { ok: true, id: c.id, name: c.name, specHash: c.specHash, createdAt: c.createdAt,
            script: { kind: c.script.kind, lang: c.script.lang, network: !!c.script.network, services: c.script.services ?? {}, secrets: c.script.secrets ?? [], interpreter: c.script.interpreter ?? null, env: c.script.env ?? null, timeoutMs: c.script.timeoutMs ?? 30000, code: c.script.code },
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
        if (url.pathname === '/web/api/run') {
          rateLimit(who.unionId);
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), String(body.commandId ?? ''));
          if (t.cmd.options.confirm && body.confirm !== true) throw new AmberError('needs_confirm', '这条指令需要确认后执行');
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.args ?? {})) if (v !== null && v !== undefined) args[k] = String(v).slice(0, 2000);
          const r = await runCommand(store, t.cmd, args, { ...person, chatId: t.chatId, chatType: t.chatType },
            { city: () => deps.cityOf(who.unionId), signer: deps.signer }, { viaForm: true });
          return json(res, 200, { ok: r.ok, runId: r.runId, markdown: r.markdown, error: r.error, elapsedMs: r.elapsedMs });
        }
        if (url.pathname === '/web/api/schedules') {
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), String(body.commandId ?? ''));
          if (t.cmd.options.confirm && body.confirm !== true) throw new AmberError('needs_confirm', '这条指令需要确认后才能定时');
          const args: Record<string, string> = {};
          for (const [k, v] of Object.entries(body.args ?? {})) if (v !== null && v !== undefined && String(v) !== '') args[k] = String(v).slice(0, 2000);
          const { parseRule } = await import('./schedule-rule.ts');
          const sch = await deps.scheduler.create({ cmd: t.cmd, chatId: t.chatId, chatType: t.chatType, replyTo: null, inThread: false, creator: { ...person, chatId: t.chatId, chatType: t.chatType },
            args, rule: parseRule(String(body.at ?? ''), String(body.tz || defaultTz())), requestedBy: 'web', via: { via: 'web' } });
          return json(res, 200, { ok: true, scheduleId: sch.id, rule: describeRule(sch.rule), next: formatAt(sch.nextRunAt, sch.rule.tz) });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/secrets$/.exec(url.pathname))) {
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          const c = t.cmd;
          if (c.ownerUnionId !== who.unionId && !deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有指令的创建人或管理员可以设置密钥');
          const name = String(body.name ?? '');
          if (!(c.script.secrets ?? []).includes(name)) throw new AmberError('bad_secret', `这条指令没有声明密钥 ${name}`);
          const vault = secretVault();
          if (!vault) throw new AmberError('no_vault', '密钥存储不可用');
          if (body.delete === true) {
            vault.delete(c, name);
            store.audit(who.unionId, 'secret.delete', { commandId: c.id, chatId: c.chatId, name: c.name, secret: name, via: 'web' });
          } else {
            try { vault.set(c, name, String(body.value ?? '').trim(), who.unionId); } catch (e) { throw new AmberError('bad_secret', (e as Error).message); }
            store.audit(who.unionId, 'secret.set', { commandId: c.id, chatId: c.chatId, name: c.name, secrets: [name], via: 'web' });
          }
          return json(res, 200, { ok: true, secrets: vault.info(c, c.script.secrets!) });
        }
        if ((m = /^\/web\/api\/commands\/([A-Za-z0-9-]{1,40})\/config$/.exec(url.pathname))) {
          // Configuration items (#3) are set here only: by the command's creator or an admin.
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          const c = t.cmd;
          if (c.ownerUnionId !== who.unionId && !deps.isAdmin(who.unionId)) throw new AmberError('forbidden', '只有指令的创建人或管理员可以设置配置项');
          const p = configParams(c.params).find(x => x.name === String(body.name ?? ''));
          if (!p) throw new AmberError('bad_config', `这条指令没有配置项 ${String(body.name ?? '').slice(0, 40)}`);
          if (body.delete === true) {
            store.deleteConfig(c.chatId, c.name, p.name);
            store.audit(who.unionId, 'config.delete', { commandId: c.id, chatId: c.chatId, name: c.name, item: p.name, via: 'web' });
          } else {
            const value = String(body.value ?? '').trim();
            if (!value) throw new AmberError('bad_config', '请填写值；要清空请点「清除」');
            // Same checks as a run (type, range, length, pattern), without the required/default rules.
            const ok = await validateArgs([{ ...p, required: true, default: undefined }], { [p.name]: value.slice(0, 2000) });
            store.putConfig(c.chatId, c.name, p.name, ok[p.name], who.unionId);
            store.audit(who.unionId, 'config.set', { commandId: c.id, chatId: c.chatId, name: c.name, item: p.name, value: ok[p.name], via: 'web' });
          }
          return json(res, 200, { ok: true });
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
          const t = await target(store, deps, who.unionId, String(body.scope ?? ''), m[1]);
          if (body.confirm !== true) throw new AmberError('needs_confirm', '请确认后再下线');
          const r = await deps.retire(t.cmd.id, { unionId: who.unionId }, (await deps.nameOf(who.unionId)) ?? '创建人');
          return json(res, 200, { ok: true, ...r });
        }
        if ((m = /^\/web\/api\/schedules\/([A-Za-z0-9-]{1,40})\/(pause|resume|delete|run)$/.exec(url.pathname))) {
          const sch = store.getSchedule(m[1]);
          if (!sch || !deps.scheduler.canManage(sch, who.unionId)) return json(res, 404, { ok: false, error: 'not_found', message: '没有这个定时任务，或你不是它的创建人' });
          if (m[2] === 'pause') deps.scheduler.pauseBy(sch, who.unionId, '在网站上暂停');
          else if (m[2] === 'resume') deps.scheduler.resume(sch, who.unionId);
          else if (m[2] === 'delete') deps.scheduler.remove(sch, who.unionId);
          else {
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

function cmdView(c: CommandRow, viewer?: string, isAdmin?: (u: string) => boolean, store?: Store) {
  const canManage = !!viewer && (c.ownerUnionId === viewer || !!isAdmin?.(viewer));
  // Secret names for everyone; when and what tail only for those who may change them (D48). Never values.
  const secrets = c.script.secrets?.length ? (secretVault()?.info(c, c.script.secrets) ?? c.script.secrets.map(name => ({ name, set: false })))
    .map(i => (canManage ? i : { name: i.name, set: i.set })) : [];
  return {
    canManage,
    secrets,
    version: store ? store.versionsOf(c.id).length + 1 : 1,
    id: c.id, name: c.name, description: c.description, global: c.global, options: c.options,
    params: runParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required, default: p.default, fromCity: p.defaultFrom === 'caller.city' })),
    // Configuration items (#3): values are not secret, everyone who sees the command sees them.
    config: (v => configParams(c.params).map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required, default: p.default ?? null, value: v[p.name] ?? null })))(store ? configValues(store, c) : {}),
  };
}

const LAST: Record<string, string> = { ok: '成功', ok_silent: '成功（无输出）', failed: '失败', missed: '错过', skipped_overlap: '跳过', delivery_failed: '结果发送失败' };

function schView(store: Store, s: ScheduleRow, viewer?: string) {
  return {
    mine: viewer ? s.creatorUnionId === viewer : false,
    commandId: s.commandId,
    id: s.id, command: store.getCommand(s.commandId)?.name ?? s.commandId, rule: describeRule(s.rule), status: s.status, pauseReason: s.pauseReason,
    next: s.status === 'active' ? formatAt(s.nextRunAt, s.rule.tz) : null, last: s.lastRunAt ? `${formatAt(s.lastRunAt, s.rule.tz)} ${LAST[s.lastStatus ?? ''] ?? ''}` : null,
    args: s.args,
  };
}

/** What this person can see: their private-chat commands, groups they are in, and global commands. */
async function overview(store: Store, deps: WebDeps, unionId: string) {
  const groups: { chatId: string; name: string; commands: unknown[]; schedules: unknown[] }[] = [];
  let membershipUnknown = false;
  for (const chatId of store.groupChatsWithContent()) {
    const m = await deps.isMember(chatId, unionId);
    if (m === undefined) { membershipUnknown = true; continue; }
    if (!m) continue;
    groups.push({
      chatId, name: (await deps.chatName(chatId)) ?? chatId,
      commands: store.listActiveByChat(chatId).filter(c => c.scopeType === 'group').map(c => cmdView(c, unionId, deps.isAdmin, store)),
      schedules: store.schedulesInChat(chatId).map(s => schView(store, s, unionId)),
    });
  }
  return {
    p2p: {
      commands: store.listActiveP2pByOwner(unionId).map(c => cmdView(c, unionId, deps.isAdmin, store)),
      schedules: store.schedulesByCreator(unionId).filter(s => s.chatType === 'p2p').map(s => schView(store, s, unionId)),
    },
    groups,
    global: store.listActiveGlobal().map(c => cmdView(c, unionId, deps.isAdmin, store)),
    membershipUnknown,
    isAdmin: deps.isAdmin(unionId),
    ...(deps.isAdmin(unionId) && deps.hub ? { executors: await executorViews(store, deps) } : {}),
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
