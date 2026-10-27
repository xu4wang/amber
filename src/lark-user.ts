// Feishu user identity (D54): a command can run as the person who runs it on Feishu, with whatever lark-cli /
// Feishu OpenAPI calls its reviewed script makes. Amber's part is only the trusted identity and the person's token:
//
// - A person authorizes once, in their private chat with Amber (「授权飞书」): OAuth device flow on Amber's own
//   Feishu app, asking for every user scope the app has (plus offline_access). Whoever opens the link and approves
//   is checked against the person who asked; a different account is thrown away (a forwarded link cannot plant
//   someone else's token under your name).
// - Only the refresh token is kept, encrypted at rest (AES-256-GCM, its own key file next to the signing key, bound
//   to the person's union_id). Each run gets a short-lived user_access_token on stdin, never the refresh token.
// - Who the token is for is decided exactly as for service tokens (docs/identity.md): the run's caller. Runs that
//   stand for nobody (agent channel) get none.
// - What the script does with it is not limited here: the review of the script is the control. Amber records that
//   a run got the token; what it called is only in Feishu's own logs.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import type { Store } from './db.ts';

export interface OAuthTokens { accessToken: string; expiresIn: number; refreshToken?: string; refreshExpiresIn?: number; scope?: string }
export interface DeviceStart { deviceCode: string; userCode: string; verificationUrl: string; expiresIn: number; interval: number }
export type PollResult = { status: 'pending' | 'slow_down' | 'denied' | 'expired' } | { status: 'ok'; tokens: OAuthTokens };

/** A refresh that can never succeed again (revoked, expired, rotated away). Anything else is treated as transient. */
export class OAuthRejected extends Error {}

/** The Feishu side, behind an interface so tests can fake it. */
export interface LarkOAuth {
  /** The user scopes Amber's app has, to ask for all of them (option B: one authorization covers every app). */
  userScopes(): Promise<string[]>;
  deviceStart(scopes: string[]): Promise<DeviceStart>;
  devicePoll(deviceCode: string): Promise<PollResult>;
  refresh(refreshToken: string): Promise<OAuthTokens>;
  whoAmI(accessToken: string): Promise<{ unionId: string; openId?: string }>;
}

const OPEN = 'https://open.feishu.cn';
const ACCOUNTS = 'https://accounts.feishu.cn';

/** The real Feishu endpoints. Device authorization needs the app's credentials as HTTP Basic auth (code 20140 otherwise). */
export function feishuOAuth(appId: string, appSecret: string, f: typeof fetch = fetch): LarkOAuth {
  const json = async (r: Response) => { try { return await r.json() as any; } catch { return {}; } };
  const tokenCall = async (body: Record<string, string>) => json(await f(`${OPEN}/open-apis/authen/v2/oauth/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, client_id: appId, client_secret: appSecret }),
  }));
  const tokens = (d: any): OAuthTokens => {
    if (typeof d?.access_token !== 'string' || !d.access_token) throw new Error(`飞书没有返回令牌：${d?.error ?? d?.code ?? ''}`);
    return { accessToken: d.access_token, expiresIn: Number(d.expires_in) || 0, refreshToken: d.refresh_token || undefined,
      refreshExpiresIn: Number(d.refresh_token_expires_in) || undefined, scope: d.scope || undefined };
  };
  return {
    async userScopes() {
      const t = await json(await f(`${OPEN}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }) }));
      if (!t?.tenant_access_token) throw new Error(`取应用令牌失败：${t?.code ?? ''} ${t?.msg ?? ''}`);
      const d = await json(await f(`${OPEN}/open-apis/application/v6/applications/${appId}?lang=zh_cn`, { headers: { authorization: `Bearer ${t.tenant_access_token}` } }));
      if (d?.code !== 0) throw new Error(`读取应用权限失败：${d?.code ?? ''} ${d?.msg ?? ''}`);
      return (d.data?.app?.scopes ?? []).filter((s: any) => (s?.token_types ?? []).includes('user')).map((s: any) => String(s.scope));
    },
    async deviceStart(scopes) {
      const r = await f(`${ACCOUNTS}/oauth/v1/device_authorization`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${appId}:${appSecret}`).toString('base64') },
        body: new URLSearchParams({ client_id: appId, scope: scopes.join(' ') }).toString(),
      });
      const d = await json(r);
      if (!d?.device_code || !d?.verification_uri_complete) throw new Error(`发起授权失败：${d?.error ?? d?.code ?? r.status} ${d?.error_description ?? ''}`);
      // The URL is used exactly as returned (Feishu asks for that explicitly).
      return { deviceCode: d.device_code, userCode: String(d.user_code ?? ''), verificationUrl: d.verification_uri_complete, expiresIn: Number(d.expires_in) || 600, interval: Number(d.interval) || 5 };
    },
    async devicePoll(deviceCode) {
      const d = await tokenCall({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: deviceCode });
      if (d?.access_token) return { status: 'ok', tokens: tokens(d) };
      if (d?.error === 'authorization_pending') return { status: 'pending' };
      if (d?.error === 'slow_down') return { status: 'slow_down' };
      if (d?.error === 'access_denied') return { status: 'denied' };
      if (d?.error === 'expired_token') return { status: 'expired' };
      throw new Error(`授权查询失败：${d?.error ?? d?.code ?? ''} ${d?.error_description ?? ''}`);
    },
    async refresh(refreshToken) {
      let d: any;
      try { d = await tokenCall({ grant_type: 'refresh_token', refresh_token: refreshToken }); }
      catch (e) { throw new Error(`刷新令牌时网络出错：${(e as Error).message}`); }
      if (d?.access_token) return tokens(d);
      // An OAuth error answer means this refresh token is done for; anything without one may be a hiccup.
      if (typeof d?.error === 'string') throw new OAuthRejected(`${d.error} ${d.error_description ?? ''}`.trim());
      throw new Error(`刷新令牌失败：${d?.code ?? ''} ${d?.msg ?? ''}`);
    },
    async whoAmI(accessToken) {
      const d = await json(await f(`${OPEN}/open-apis/authen/v1/user_info`, { headers: { authorization: `Bearer ${accessToken}` } }));
      if (d?.code !== 0 || !d.data?.union_id) throw new Error(`读取授权账号失败：${d?.code ?? ''} ${d?.msg ?? ''}`);
      return { unionId: String(d.data.union_id), openId: d.data.open_id ? String(d.data.open_id) : undefined };
    },
  };
}

/** The lark-cli executable a script should call, as an absolute path: the sandbox's PATH may not have it, and the npm
 *  package's entry is a `#!/usr/bin/env node` wrapper (no node on that PATH either), so this is the native binary it
 *  wraps. AMBER_LARK_CLI overrides. undefined when there is none. */
export function resolveLarkCli(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.AMBER_LARK_CLI) return existsSync(env.AMBER_LARK_CLI) ? env.AMBER_LARK_CLI : undefined;
  for (const d of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const p = join(d, 'lark-cli');
    if (!existsSync(p)) continue;
    let real: string;
    try { real = realpathSync(p); } catch { continue; }
    if (real.endsWith('.js')) {
      const native = join(dirname(real), '..', 'bin', 'lark-cli');
      if (existsSync(native)) return realpathSync(native);
      continue;
    }
    return real;
  }
  return undefined;
}

/** Runs refused because the person has not authorized, or the authorization no longer works. */
export class NeedsLarkAuth extends Error {}

export interface LarkUserStatus { authorized: boolean; scopes: string[]; refreshExpiresAt?: number; updatedAt?: number }
export type AuthOutcome = { ok: true; scopes: string[] } | { ok: false; reason: 'denied' | 'expired' | 'mismatch' | 'error'; detail?: string };

interface Row { union_id: string; open_id: string | null; scopes: string; refresh_cipher: string; refresh_expires_at: number | null; updated_at: number; reminded_at: number | null }
interface Cached { token: string; expiresAt: number }

/** Never hand out a token that has less than this left after the run's own time limit. */
const MARGIN_MS = 60_000;
/** How long one person waits between "your authorization stopped working" reminders. */
export const REMIND_EVERY_MS = 24 * 3600_000;

export class LarkUserVault {
  private key: Buffer;
  private store: Store;
  private oauth: LarkOAuth;
  readonly appId: string;
  /** How lark-cli is found (tests replace it). */
  resolveCli: () => string | undefined = () => resolveLarkCli();
  private cli: string | undefined;
  /** Access tokens live in memory only: a restart costs one refresh, and nothing short-lived is ever on disk. */
  private access = new Map<string, Cached>();
  /** One refresh per person at a time: Feishu rotates the refresh token, so two at once would lose the race. */
  private refreshing = new Map<string, Promise<Cached>>();
  /** The person's authorization in progress, at most one each; a new request replaces the old one. */
  private pending = new Map<string, { deviceCode: string; cancelled: boolean }>();
  /** Poll interval floor, lowered by tests. */
  pollFloorMs = 1000;

  constructor(store: Store, configDir: string, oauth: LarkOAuth, appId: string) {
    this.store = store;
    this.oauth = oauth;
    this.appId = appId;
    const p = join(configDir, 'lark-user-key');
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    this.key = Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
    if (this.key.length !== 32) throw new Error('lark-user-key 文件不对：应为 32 字节的 base64');
  }

  // Bound to the person, so a ciphertext copied to another row does not decrypt.
  private aad(unionId: string): Buffer { return Buffer.from(`amber-lark-user\0${unionId}`); }
  private seal(unionId: string, value: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(this.aad(unionId));
    const ct = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    return 'v1:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  private open(unionId: string, blob: string): string {
    if (!blob.startsWith('v1:')) throw new Error('unknown format');
    const raw = Buffer.from(blob.slice(3), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAAD(this.aad(unionId));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  /** The person's live authorization. A dead one (refresh rejected) keeps its row for the reminder bookkeeping. */
  private row(unionId: string): Row | undefined {
    const r = this.store.larkUserRow(unionId) as Row | undefined;
    return r && r.refresh_cipher ? r : undefined;
  }

  /** Absolute path of lark-cli handed to scripts. Looked up when a run needs it, and again whenever the file is gone:
   * an upgrade replaces it, and a lookup made while it was being reinstalled finds nothing (10-22: Amber started in
   * that window and every larkUser run failed until it was restarted). */
  larkCli(): string | undefined {
    if (this.cli && existsSync(this.cli)) return this.cli;
    this.cli = this.resolveCli();
    return this.cli;
  }

  /** The app's user scopes, re-read at most every 10 minutes (missingScopes runs on every larkUser run). */
  private appScopes: { at: number; scopes: string[] } | undefined;

  /** User scopes Amber's app has now that this person's authorization lacks: opened after they authorized, so they
   *  only take effect for them once they authorize again. Empty when unknown (no authorization, lookup failed). */
  async missingScopes(unionId: string): Promise<string[]> {
    const st = this.status(unionId);
    // No scope list stored (Feishu may leave it out of the token response): unknown, not「lacks everything」.
    if (!st.authorized || !st.scopes.length) return [];
    if (!this.appScopes || Date.now() - this.appScopes.at > 10 * 60_000) {
      try { this.appScopes = { at: Date.now(), scopes: await this.oauth.userScopes() }; } catch { return []; }
    }
    const have = new Set(st.scopes);
    return this.appScopes.scopes.filter(s => s !== 'offline_access' && !have.has(s));
  }

  status(unionId: string): LarkUserStatus {
    const r = this.row(unionId);
    if (!r) return { authorized: false, scopes: [] };
    return { authorized: true, scopes: JSON.parse(r.scopes), ...(r.refresh_expires_at ? { refreshExpiresAt: r.refresh_expires_at } : {}), updatedAt: r.updated_at };
  }

  /** Starts the device flow for `unionId`. `done` is called once, when it ends (approved, refused, expired, wrong account). */
  async start(unionId: string, done: (o: AuthOutcome) => void): Promise<DeviceStart & { scopes: string[] }> {
    const scopes = [...new Set([...(await this.oauth.userScopes()), 'offline_access'])];
    const s = await this.oauth.deviceStart(scopes);
    const prev = this.pending.get(unionId);
    if (prev) prev.cancelled = true;
    const job = { deviceCode: s.deviceCode, cancelled: false };
    this.pending.set(unionId, job);
    this.store.audit(unionId, 'larkuser.auth_start', { scopes: scopes.length });
    const deadline = Date.now() + s.expiresIn * 1000;
    let interval = Math.max(s.interval * 1000, this.pollFloorMs);
    const finish = (o: AuthOutcome) => {
      if (this.pending.get(unionId) === job) this.pending.delete(unionId);
      if (!o.ok) this.store.audit(unionId, 'larkuser.auth_failed', { reason: o.reason, ...(o.detail ? { detail: o.detail.slice(0, 200) } : {}) });
      done(o);
    };
    const tick = async () => {
      if (job.cancelled) return;
      if (Date.now() > deadline) return finish({ ok: false, reason: 'expired' });
      let r: PollResult;
      try { r = await this.oauth.devicePoll(s.deviceCode); }
      catch (e) { return finish({ ok: false, reason: 'error', detail: (e as Error).message }); }
      if (job.cancelled) return;
      if (r.status === 'pending' || r.status === 'slow_down') {
        if (r.status === 'slow_down') interval += 5000;
        setTimeout(tick, interval).unref?.();
        return;
      }
      if (r.status !== 'ok') return finish({ ok: false, reason: r.status });
      try { finish(await this.accept(unionId, r.tokens)); }
      catch (e) { finish({ ok: false, reason: 'error', detail: (e as Error).message }); }
    };
    setTimeout(tick, interval).unref?.();
    return { ...s, scopes };
  }

  /** Keeps a fresh authorization, but only if it is the asking person's own account. */
  private async accept(unionId: string, t: OAuthTokens): Promise<AuthOutcome> {
    const who = await this.oauth.whoAmI(t.accessToken);
    if (who.unionId !== unionId) {
      this.store.audit(unionId, 'larkuser.identity_mismatch', { approvedBy: who.unionId });
      return { ok: false, reason: 'mismatch' };
    }
    if (!t.refreshToken) return { ok: false, reason: 'error', detail: '飞书没有返回刷新令牌（应用缺少 offline_access 权限？）' };
    const scopes = (t.scope ?? '').split(/\s+/).filter(Boolean);
    const now = Date.now();
    this.store.upsertLarkUser({ unionId, openId: who.openId ?? null, scopes: JSON.stringify(scopes), refreshCipher: this.seal(unionId, t.refreshToken),
      refreshExpiresAt: t.refreshExpiresIn ? now + t.refreshExpiresIn * 1000 : null, at: now });
    this.access.set(unionId, { token: t.accessToken, expiresAt: now + t.expiresIn * 1000 });
    this.store.audit(unionId, 'larkuser.authorized', { scopes: scopes.length });
    return { ok: true, scopes };
  }

  /** Whether this device flow is still the person's authorization in progress (a newer one replaces it). */
  isPending(unionId: string, deviceCode: string): boolean {
    const p = this.pending.get(unionId);
    return !!p && !p.cancelled && p.deviceCode === deviceCode;
  }

  /** Stops the person's authorization in progress, if any; a stored authorization is kept. */
  cancel(unionId: string): void {
    const p = this.pending.get(unionId);
    if (p) { p.cancelled = true; this.pending.delete(unionId); }
  }

  /** Forgets the person's authorization. Returns whether there was one. */
  revoke(unionId: string): boolean {
    const p = this.pending.get(unionId);
    if (p) { p.cancelled = true; this.pending.delete(unionId); }
    this.access.delete(unionId);
    const had = this.store.deleteLarkUser(unionId);
    this.store.audit(unionId, 'larkuser.revoked', { had });
    return had;
  }

  /** A user_access_token for `unionId` valid for at least `needMs` more. Throws NeedsLarkAuth when there is no
   *  authorization or it can never work again (it is then marked dead, so the person is asked to authorize anew). */
  async token(unionId: string, needMs: number): Promise<{ token: string; expiresAt: number }> {
    const ok = (c?: Cached) => !!c && c.expiresAt - Date.now() >= needMs + MARGIN_MS;
    const cached = this.access.get(unionId);
    if (ok(cached)) return cached!;
    if (!this.row(unionId)) throw new NeedsLarkAuth('还没有授权飞书');
    let p = this.refreshing.get(unionId);
    if (!p) {
      p = this.doRefresh(unionId).finally(() => this.refreshing.delete(unionId));
      this.refreshing.set(unionId, p);
    }
    const fresh = await p;
    if (!ok(fresh)) throw new Error('飞书给的令牌有效期比这次运行的时限还短');
    return fresh;
  }

  private async doRefresh(unionId: string): Promise<Cached> {
    const r = this.row(unionId);
    if (!r) throw new NeedsLarkAuth('还没有授权飞书');
    let rt: string;
    try { rt = this.open(unionId, r.refresh_cipher); }
    catch { this.drop(unionId, 'undecryptable'); throw new NeedsLarkAuth('保存的授权无法读取'); }
    let t: OAuthTokens;
    try { t = await this.oauth.refresh(rt); }
    catch (e) {
      if (e instanceof OAuthRejected) { this.drop(unionId, e.message); throw new NeedsLarkAuth('飞书授权已失效'); }
      throw e;
    }
    const now = Date.now();
    // Feishu rotates the refresh token: keep the new one, or the next refresh fails.
    if (t.refreshToken) this.store.updateLarkUserRefresh(unionId, this.seal(unionId, t.refreshToken), t.refreshExpiresIn ? now + t.refreshExpiresIn * 1000 : r.refresh_expires_at, now);
    const c = { token: t.accessToken, expiresAt: now + t.expiresIn * 1000 };
    this.access.set(unionId, c);
    this.store.audit(unionId, 'larkuser.refresh', {});
    return c;
  }

  private drop(unionId: string, why: string): void {
    this.access.delete(unionId);
    this.store.markLarkUserDead(unionId);
    this.store.audit(unionId, 'larkuser.dead', { why: why.slice(0, 200) });
  }

  /** Last 「new scopes, authorize again」 reminder per person. In memory: after a restart someone may hear it once more. */
  private scopeReminded = new Map<string, number>();
  shouldRemindScopes(unionId: string): boolean {
    const at = this.scopeReminded.get(unionId);
    if (at !== undefined && Date.now() - at < REMIND_EVERY_MS) return false;
    this.scopeReminded.set(unionId, Date.now());
    return true;
  }

  /** Whether to send the "authorize again" reminder now; at most once per REMIND_EVERY_MS per person. */
  shouldRemind(unionId: string): boolean { return this.store.claimLarkUserReminder(unionId, REMIND_EVERY_MS); }
}
