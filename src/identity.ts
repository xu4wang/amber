// Execution identity tokens (D27). For each run Amber signs a short-lived assertion of who is
// running which command; backend services that choose to trust Amber verify it with Amber's
// public key. Amber itself knows nothing about those services.
//
// Format: JWS compact, alg EdDSA (Ed25519).
//   header  { alg: "EdDSA", typ: "JWT", kid }
//   payload { iss: "amber", aud, sub: <caller union_id>, cmd, rev: <spec_hash>, run, chat, channel, iat, exp, jti }
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, randomUUID, createHash } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');

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
    const raw = this.publicKey.export({ format: 'jwk' }) as { x: string };
    this.kid = createHash('sha256').update(raw.x).digest('hex').slice(0, 16);
  }

  /** JWKS document for verifiers. */
  jwks(): object {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    return { keys: [{ ...jwk, kid: this.kid, alg: 'EdDSA', use: 'sig' }] };
  }

  issue(c: { aud: string; sub: string; cmd: string; rev: string; run: string; chat: string; channel: string; ttlSec?: number }): string {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT', kid: this.kid };
    const payload = { iss: 'amber', aud: c.aud, sub: c.sub, cmd: c.cmd, rev: c.rev, run: c.run, chat: c.chat, channel: c.channel, iat: now, exp: now + (c.ttlSec ?? 300), jti: randomUUID() };
    const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), this.key))}`;
  }
}
