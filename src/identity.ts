// Execution identity tokens (D27). For each run Amber signs a short-lived assertion of who is
// running which command; backend services that choose to trust Amber verify it with Amber's
// public key. Amber itself knows nothing about those services.
//
// Format: JWS compact, alg EdDSA (Ed25519).
//   header  { alg: "EdDSA", typ: "JWT", kid }
//   payload { iss: "amber", aud, sub: <caller union_id>, cmd, rev: <spec_hash>, run, chat, channel,
//             call_index, call_count, iat, exp, jti }
// A run gets call_count tokens per declared service (D41), each with its own jti, meant to be used once.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, randomUUID, randomBytes, createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sealJob, relayResponseInput, signLinkRequest, type JobEnvelope } from './exec-proto.ts';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

function publicSet(publicKey: KeyObject): { kid: string; jwks: object } {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;
  const kid = createHash('sha256').update(jwk.x).digest('hex').slice(0, 16);
  return { kid, jwks: { keys: [{ ...jwk, kid, alg: 'EdDSA', use: 'sig' }] } };
}

/** Read-only export for `amber cli keys` (D42): the existing signing key must already be there as a
 *  regular 0600 file. Never generates a key and touches nothing else. */
export function exportPublicKeys(configDir: string): { kid: string; jwks: object } {
  const p = join(configDir, 'signing-key.pem');
  let st;
  try { st = lstatSync(p); } catch { throw new Error(`没有找到签名私钥 ${p}（不会自动生成；请确认配置目录）`); }
  if (!st.isFile()) throw new Error(`${p} 不是普通文件`);
  if ((st.mode & 0o077) !== 0) throw new Error(`${p} 的权限是 ${(st.mode & 0o777).toString(8)}，不能对同组或其他用户开放（建议 600）`);
  return publicSet(createPublicKey(createPrivateKey(readFileSync(p))));
}

export class Signer {
  private key: KeyObject;
  readonly publicKey: KeyObject;
  readonly kid: string;

  constructor(configDir: string) {
    const p = join(configDir, 'signing-key.pem');
    if (!existsSync(p)) {
      const { privateKey } = generateKeyPairSync('ed25519');
      writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    }
    this.key = createPrivateKey(readFileSync(p));
    this.publicKey = createPublicKey(this.key);
    this.kid = publicSet(this.publicKey).kid;
  }

  /** JWKS document for verifiers. */
  jwks(): object {
    return publicSet(this.publicKey).jwks;
  }

  /** A job for an executor (D50): encrypted to its key, signed with this key. */
  sealJob(executorId: string, boxPub: string, jobId: string, ttlMs: number, payload: unknown): JobEnvelope {
    return sealJob(this.key, executorId, boxPub, jobId, ttlMs, payload);
  }

  /** Signs a relayed service response for the executor that asked (D52). */
  /** Headers for a request Amber makes to a link-mode executor (D58). */
  signLink(name: string, method: string, path: string, body: string): Record<string, string> {
    return signLinkRequest(this.key, name, method, path, body);
  }

  signRelayResponse(jobId: string, reqId: string, r: Parameters<typeof relayResponseInput>[2]): string {
    return sign(null, relayResponseInput(jobId, reqId, r), this.key).toString('base64');
  }

  /** `ttlSec`: services accept at most 300 (data-mcp's DATA_MCP_AMBER_MAX_TOKEN_LIFETIME_SECONDS default). */
  issue(c: { aud: string; sub: string; cmd: string; rev: string; run: string; chat: string; channel: string; callIndex: number; callCount: number; ttlSec?: number }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.kid };
    const payload = { iss: 'amber', aud: c.aud, sub: c.sub, cmd: c.cmd, rev: c.rev, run: c.run, chat: c.chat, channel: c.channel, call_index: c.callIndex, call_count: c.callCount, iat: now, exp: now + (c.ttlSec ?? 300), jti: randomUUID() };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), this.key))}`;
  }
}

/** How long a service token is valid. It is signed when the call passes Amber's relay (ExecutorHub.forward), so this
 *  covers one call (the relay waits at most 60 s) plus clock skew — not the run, which may take up to 30 minutes. */
export const SERVICE_TOKEN_TTL_SEC = 120;
/** What a script holds in place of a token: random, single use, worth something only to Amber's relay during its run. */
export const newTicket = (): string => 'amber-ticket-' + randomBytes(24).toString('base64url');
