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
import { describeRule, formatAt } from './schedule-rule.ts';

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

export function startWeb(port: number, store: Store, deps: WebDeps): void {
  const page = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8').replace('__FEISHU_CHAT_LINK__', deps.feishuChatLink);
  const logo = readFileSync(join(import.meta.dirname, '..', 'web', 'logo.svg'));

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
        if (req.method === 'GET' && url.pathname === '/web/api/overview') return json(res, 200, { ok: true, ...(await overview(store, deps, who.unionId)) });
        return json(res, 404, { ok: false, error: 'not_found' });
      }
      return send(res, 404, 'text/plain; charset=utf-8', 'not found');
    } catch (e) {
      console.log(new Date().toISOString(), 'web error', url.pathname, (e as Error).message);
      return json(res, 500, { ok: false, error: 'internal' });
    }
  });
  server.listen(port, '127.0.0.1', () => console.log(new Date().toISOString(), `web listening on 127.0.0.1:${port}`));
}

function cmdView(c: CommandRow) {
  return {
    id: c.id, name: c.name, description: c.description, global: c.global, options: c.options,
    params: c.params.map(p => ({ name: p.name, label: p.label ?? p.name, type: p.type, required: !!p.required, default: p.default, fromCity: p.defaultFrom === 'caller.city' })),
  };
}

function schView(store: Store, s: ScheduleRow) {
  return {
    id: s.id, command: store.getCommand(s.commandId)?.name ?? s.commandId, rule: describeRule(s.rule), status: s.status, pauseReason: s.pauseReason,
    next: s.status === 'active' ? formatAt(s.nextRunAt, s.rule.tz) : null, last: s.lastRunAt ? `${formatAt(s.lastRunAt, s.rule.tz)} ${s.lastStatus ?? ''}` : null,
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
      commands: store.listActiveByChat(chatId).filter(c => c.scopeType === 'group').map(cmdView),
      schedules: store.schedulesInChat(chatId).map(s => schView(store, s)),
    });
  }
  return {
    p2p: {
      commands: store.listActiveP2pByOwner(unionId).map(cmdView),
      schedules: store.schedulesByCreator(unionId).filter(s => s.chatType === 'p2p').map(s => schView(store, s)),
    },
    groups,
    global: store.listActiveGlobal().map(cmdView),
    membershipUnknown,
  };
}
