// Link-mode executors (D58): Amber connects to them. For a machine Amber can reach (over HTTPS) but that cannot reach
// Amber — a server outside the company network — the executor serves a small HTTP API instead of polling Amber, and
// Amber, for each link in its configuration, keeps asking it for the requests the executor would otherwise have sent:
// register, poll, result, relay. Each one is handled exactly as if it had come in over the API (api.ts
// executorRequest): the executor still signs it with its own key, jobs are still signed by Amber and encrypted to
// the executor, an admin still approves the executor and its environments. What the link adds:
//   - Amber only connects to the addresses in its configuration, and signs every request it makes with its own key
//     (the executor pinned it at setup), so nobody else can take the executor's requests or answer them;
//   - the executor may only register under the link's name (a link cannot claim another executor's name);
//   - its executor row says where it came from: machine "link:<name>"; relayed service calls are refused for it
//     unless the service allows it (config services.<name>.links), since its data would leave the network.
// The transport is plain HTTPS long polling (no WebSocket, no dependencies on either side). `tlsFingerprint` pins
// the executor's certificate (SHA-256), for a self-signed certificate or to bypass a CDN that would see the traffic;
// `connectTo` connects to that address while still using the URL's host for TLS and the Host header.
import { request as httpsRequest } from 'node:https';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import type { ExecutorHub } from './executors.ts';
import type { Signer } from './identity.ts';
import { EXECUTOR_NAME } from './exec-proto.ts';

export interface LinkConfig { name: string; url: string; tlsFingerprint?: string; connectTo?: string; parallel?: number }

/** How long the executor holds an empty /amber-link/next before answering with nothing. */
export const LINK_WAIT_MS = 25_000;
const MAX_RESPONSE = 16 * 1024 * 1024;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

/** Checks the configured links; throws with a message for the admin. */
export function validateLinks(x: unknown): LinkConfig[] {
  if (x === undefined || x === null) return [];
  if (!Array.isArray(x)) throw new Error('executorLinks 要写成数组');
  const seen = new Set<string>();
  return x.map((l: any) => {
    const name = String(l?.name ?? '');
    if (!EXECUTOR_NAME.test(name)) throw new Error(`executorLinks 里的 name 不对：${name}`);
    if (seen.has(name)) throw new Error(`executorLinks 里重复的 name：${name}`);
    seen.add(name);
    let u: URL;
    try { u = new URL(String(l?.url ?? '')); } catch { throw new Error(`executorLinks.${name}.url 不是合法的地址`); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) throw new Error(`executorLinks.${name}.url 要用 https（本机测试可以用 http://127.0.0.1）`);
    const fp = l?.tlsFingerprint === undefined ? undefined : String(l.tlsFingerprint).replace(/:/g, '').toUpperCase();
    if (fp !== undefined && !/^[0-9A-F]{64}$/.test(fp)) throw new Error(`executorLinks.${name}.tlsFingerprint 要是证书的 SHA-256（64 位十六进制）`);
    const parallel = l?.parallel === undefined ? 4 : Number(l.parallel);
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 16) throw new Error(`executorLinks.${name}.parallel 要是 1–16 的整数`);
    return { name, url: u.toString().replace(/\/+$/, ''), ...(fp ? { tlsFingerprint: fp } : {}), ...(l?.connectTo ? { connectTo: String(l.connectTo) } : {}), parallel };
  });
}

type Handle = (path: string, headers: Record<string, string | undefined>, raw: string, machine: string) => Promise<{ status: number; body: unknown }>;

export class ExecutorLinks {
  private closed = false;
  private active = new Set<import('node:http').ClientRequest>();
  /** Per link: last error (logged once until it changes), and whether a request is getting through. */
  readonly state = new Map<string, { connected: boolean; error?: string; since: number }>();

  private links: LinkConfig[];
  private signer: Signer;
  private handle: Handle;

  constructor(links: LinkConfig[], signer: Signer, handle: Handle) {
    this.links = links;
    this.signer = signer;
    this.handle = handle;
  }

  start(): void {
    for (const l of this.links) {
      this.state.set(l.name, { connected: false, since: Date.now() });
      for (let i = 0; i < (l.parallel ?? 4); i++) void this.loop(l);
    }
  }

  close(): void {
    this.closed = true;
    for (const r of this.active) r.destroy();
  }

  private mark(l: LinkConfig, connected: boolean, error?: string): void {
    const prev = this.state.get(l.name);
    if (prev?.connected !== connected || prev?.error !== error) log('executor link', l.name, connected ? 'connected' : `down: ${error}`);
    this.state.set(l.name, { connected, ...(error ? { error } : {}), since: prev?.connected === connected ? prev.since : Date.now() });
  }

  private async loop(l: LinkConfig): Promise<void> {
    while (!this.closed) {
      try {
        const r = await this.post(l, '/amber-link/next', {}, LINK_WAIT_MS + 15_000);
        if (r.status !== 200 || !Array.isArray((r.body as any)?.requests)) throw new Error(`HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
        this.mark(l, true);
        for (const q of (r.body as any).requests) void this.serve(l, q);
      } catch (e) {
        if (this.closed) return;
        this.mark(l, false, (e as Error).message);
        await new Promise(res => setTimeout(res, 5_000));
      }
    }
  }

  /** One request the executor made: handled as if it came in over the API, the answer posted back. */
  private async serve(l: LinkConfig, q: any): Promise<void> {
    const id = String(q?.id ?? '');
    if (!/^[0-9a-f]{24}$/.test(id)) return;
    const path = String(q?.path ?? ''), raw = typeof q?.body === 'string' ? q.body : '';
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(q?.headers ?? {})) if (typeof v === 'string') headers[k.toLowerCase()] = v;
    let res: { status: number; body: unknown };
    if (!path.startsWith('/v1/executor/')) res = { status: 404, body: { ok: false, error: 'not_found' } };
    else if (path === '/v1/executor/register' && (() => { try { return JSON.parse(raw)?.name !== l.name; } catch { return true; } })()) {
      res = { status: 403, body: { ok: false, error: 'forbidden', message: `这个链接只接受名为 ${l.name} 的执行端` } };
    } else res = await this.handle(path, headers, raw, `link:${l.name}`);
    try {
      await this.post(l, '/amber-link/reply', { id, status: res.status, body: JSON.stringify(res.body) }, 30_000);
    } catch (e) { log('executor link reply failed', l.name, (e as Error).message); }
  }

  private post(l: LinkConfig, path: string, body: unknown, timeoutMs: number): Promise<{ status: number; body: unknown }> {
    const u = new URL(l.url + path);
    const raw = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(raw)), host: u.host, ...this.signer.signLink(l.name, 'POST', path, raw) };
    const https = u.protocol === 'https:';
    return new Promise((resolve, reject) => {
      const host = l.connectTo ?? u.hostname, port = Number(u.port || (https ? 443 : 80));
      // A pinned certificate: the request is written only after the handshake showed exactly that certificate.
      const pinned = https && l.tlsFingerprint ? {
        createConnection: (_o: unknown, cb: (err: Error | null, s?: any) => void) => {
          const s = tlsConnect({ host, port, servername: u.hostname, rejectUnauthorized: false });
          s.once('secureConnect', () => {
            const fp = (s.getPeerCertificate()?.fingerprint256 ?? '').replace(/:/g, '').toUpperCase();
            if (fp === l.tlsFingerprint) cb(null, s);
            else { s.destroy(); cb(new Error(`证书指纹不符（收到 ${fp.slice(0, 16)}…）`)); }
          });
          s.once('error', e => cb(e));
          return undefined;
        },
      } : {};
      const opts = { method: 'POST', host, port, path: u.pathname, headers, timeout: timeoutMs, ...(https ? { servername: u.hostname } : {}), ...pinned };
      const done = (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => { n += c.length; if (n > MAX_RESPONSE) req.destroy(new Error('响应太大')); else chunks.push(c); });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { /* keep the text */ }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
        res.on('error', reject);
      };
      const req = https ? httpsRequest(opts, done) : httpRequest(opts, done);
      this.active.add(req);
      req.on('close', () => this.active.delete(req));
      req.on('timeout', () => req.destroy(new Error('超时')));
      req.on('error', reject);
      req.end(raw);
    });
  }
}
