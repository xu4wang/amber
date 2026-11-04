// API links: callers outside the company network reach Amber's agent API through an amber-gateway
// (client/amber-gateway, docs/gateway.md) on an internet host. Amber connects out to the gateway — nothing listens
// inward — over the same transport as link-mode executors (exec-link.ts LinkPoller): it long-polls
// <url>/amber-link/next, signed with its key for "gateway:<name>" (a prefix no executor name can have, so a signed
// request for one kind of link is never good for the other), and posts each answer to /amber-link/reply.
//
// Trust: the gateway authenticates its clients (a bearer token each) and names the client on every request it
// queues; Amber trusts that name because only this gateway (pinned by URL / certificate, answering requests only
// Amber can sign) hands it out. Everything else is decided here, default-deny, per client in the configuration:
//   - paths:  which API paths it may call (DEFAULT_PATHS when unset); NEVER_PATHS whatever the configuration says;
//   - users:  which people (email) it may name as `user` / `claimer`; none when unset;
//   - chats:  which chats it may name as `chatId`; none when unset.
// LAN machines may name any person or chat (the API never acts as a person: cards are clicked by people), but a
// caller on the internet naming any chat could list and run that chat's identity-free apps and post cards into it,
// so outside callers get only what an admin wrote down. Each request is handled exactly as if it had come in over
// the API, as machine "gw:<link>:<client>": lookups of requests and sealed results only find that client's own.
import type { Signer } from './identity.ts';
import { LinkPoller, validateLinks, type LinkConfig, type LinkItem } from './exec-link.ts';
import { apiBodyLimit, type ApiHandler } from './api.ts';
import { EXECUTOR_NAME } from './exec-proto.ts';

export interface ApiClientPolicy { paths?: string[]; users?: string[]; chats?: string[] }
export interface ApiLinkConfig extends LinkConfig { clients: Record<string, ApiClientPolicy> }

/** Read and run: what an outside caller needs to use apps. Changing apps, schedules or triggers must be listed. */
export const DEFAULT_PATHS = ['/v1/info', '/v1/keys', '/v1/requests/:id', '/v1/commands/list', '/v1/commands/show', '/v1/runs', '/v1/reads', '/v1/reads/fetch'];
/** Never through a gateway: secrets, executors (they have links of their own) and page publishing (16MB bodies, v1). */
const NEVER_PATHS = [/^\/v1\/secrets(\/|$)/, /^\/v1\/executor(\/|$)/, /^\/v1\/pages(\/|$)/];
export const CLIENT_NAME = EXECUTOR_NAME;
const CLIENT_KEYS = new Set(['paths', 'users', 'chats']);

const strings = (v: unknown, what: string, ok: (s: string) => boolean): string[] => {
  if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !ok(s))) throw new Error(`${what} 要写成字符串数组，且每一项格式正确`);
  return v as string[];
};

/** Checks `apiLinks`; throws with a message for the admin. */
export function validateApiLinks(x: unknown): ApiLinkConfig[] {
  return validateLinks<ApiLinkConfig>(x, 'apiLinks', (l, name) => {
    const raw = l?.clients;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`apiLinks.${name}.clients 要写成对象：{"客户端名": {"paths": [...], "users": [...], "chats": [...]}}`);
    const clients: Record<string, ApiClientPolicy> = Object.create(null);
    for (const [client, p] of Object.entries(raw as Record<string, any>)) {
      const at = `apiLinks.${name}.clients.${client}`;
      if (!CLIENT_NAME.test(client)) throw new Error(`${at}：客户端名只能用小写字母、数字、连字符`);
      if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`${at} 要写成对象`);
      // A typo ("user", "chat") would otherwise silently mean "none".
      for (const k of Object.keys(p)) if (!CLIENT_KEYS.has(k)) throw new Error(`${at}.${k}：不认识的设置（只有 paths、users、chats）`);
      clients[client] = {
        ...(p.paths !== undefined ? { paths: strings(p.paths, `${at}.paths`, s => s.startsWith('/v1/')) } : {}),
        ...(p.users !== undefined ? { users: strings(p.users, `${at}.users`, s => s.includes('@')).map(s => s.trim().toLowerCase()) } : {}),
        ...(p.chats !== undefined ? { chats: strings(p.chats, `${at}.chats`, s => /^oc_[A-Za-z0-9]+$/.test(s)) } : {}),
      };
    }
    return { clients };
  });
}

/** `/v1/requests/:id` matches `/v1/requests/<anything but a slash>`. */
function pathMatches(pattern: string, path: string): boolean {
  const a = pattern.split('/'), b = path.split('/');
  return a.length === b.length && a.every((s, i) => (s.startsWith(':') ? b[i] !== '' : s === b[i]));
}

const deny = (status: number, error: string, message: string) => ({ status, body: { ok: false, error, message } });

/** What a client may not do, before the request reaches the API; undefined = go ahead. */
export function checkPolicy(p: ApiClientPolicy, method: string, path: string, raw: string): { status: number; body: unknown } | undefined {
  if (NEVER_PATHS.some(r => r.test(path))) return deny(403, 'forbidden', '外网网关不开放这个接口（密钥、执行端和页面发布只能在内网使用）');
  if (!(p.paths ?? DEFAULT_PATHS).some(x => pathMatches(x, path))) return deny(403, 'forbidden', `这个网关客户端没有被允许调用 ${path}（请 Amber 管理员在 apiLinks 的 paths 里加上）`);
  if (method !== 'POST') return undefined;
  // Parsed exactly as the API will parse it, so what is checked is what is used.
  let body: any = {};
  if (raw) { try { body = JSON.parse(raw); } catch { return deny(400, 'bad_json', '请求不是合法的 JSON'); } }
  if (!body || typeof body !== 'object') return undefined;
  // The API treats any falsy value as "no one named" (agent.context, flow.submitDraft): so does this.
  for (const field of ['user', 'claimer']) {
    const v = body[field];
    if (v && !(typeof v === 'string' && (p.users ?? []).includes(v.trim().toLowerCase()))) {
      return deny(403, 'forbidden', `这个网关客户端不能代表 ${String(v).slice(0, 80)} 发起请求（请 Amber 管理员在 apiLinks 的 users 里加上）`);
    }
  }
  if (body.chatId !== undefined && !(typeof body.chatId === 'string' && (p.chats ?? []).includes(body.chatId))) {
    return deny(403, 'forbidden', `这个网关客户端不能在会话 ${String(body.chatId).slice(0, 80)} 里发起请求（请 Amber 管理员在 apiLinks 的 chats 里加上）`);
  }
  return undefined;
}

export type GatewayAudit = (detail: { link: string; client: string; method: string; path: string; status: number }) => void;

export class ApiLinks extends LinkPoller<ApiLinkConfig> {
  protected readonly kind = 'api link';
  private handle: ApiHandler;
  private audit?: GatewayAudit;

  constructor(links: ApiLinkConfig[], signer: Signer, handle: ApiHandler, audit?: GatewayAudit) {
    super(links, signer);
    this.handle = handle;
    this.audit = audit;
  }

  protected signName(l: ApiLinkConfig): string { return `gateway:${l.name}`; }

  protected async answer(l: ApiLinkConfig, q: LinkItem): Promise<{ status: number; body: unknown }> {
    const client = String(q?.client ?? ''), method = String(q?.method ?? 'POST').toUpperCase();
    const target = String(q?.path ?? '');
    let path = target.split('?')[0].slice(0, 200);
    let res: { status: number; body: unknown };
    if (!CLIENT_NAME.test(client) || !Object.hasOwn(l.clients, client)) {
      res = deny(403, 'forbidden', `网关客户端 ${client.slice(0, 40)} 没有在 Amber 的 apiLinks 里登记`);
    } else if ((method !== 'GET' && method !== 'POST') || !target.startsWith('/v1/')) {
      res = { status: 404, body: { ok: false, error: 'not_found' } };
    } else {
      // Normalized once ("/v1/./secrets" is "/v1/secrets"): the policy sees exactly the path the API will dispatch on.
      const url = new URL(target, 'http://amber');
      path = url.pathname;
      const raw = method === 'POST' && typeof q.body === 'string' ? q.body : '';
      const headers: Record<string, string | undefined> = {};
      const ct = q.headers?.['content-type'];
      if (typeof ct === 'string') headers['content-type'] = ct;
      res = checkPolicy(l.clients[client], method, path, raw)
        ?? (Buffer.byteLength(raw) > apiBodyLimit(path) ? deny(400, 'too_large', '请求太大') : undefined)
        ?? await this.handle({ method, path, search: url.searchParams, headers, raw, machine: `gw:${l.name}:${client}`, scoped: true });
    }
    this.audit?.({ link: l.name, client: client.slice(0, 40), method: method.slice(0, 8), path, status: res.status });
    return res;
  }
}
