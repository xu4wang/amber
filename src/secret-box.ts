// Sealing a secret to the one `amber secret get` process that asked for it. The client makes a fresh X25519 key
// pair per request and sends the public half; Amber seals the value to it and hands back only the sealed box, so
// nothing on the way (plain-HTTP LAN, nginx, proxies) sees it, and a box fetched by anyone else is useless.
// The client is Python standard library only (no AES there), so the cipher is built from what both sides have:
// X25519 → HKDF-SHA256 → an HMAC-SHA256 keystream (counter mode) for the text and HMAC-SHA256 over everything
// for integrity (encrypt-then-MAC). client/amber has the matching open().
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from 'node:crypto';

const INFO = 'amber-secret-read/1';

export interface SealedBox { epk: string; nonce: string; ct: string; tag: string }

/** The client's public key: 32 bytes, standard base64. */
export function checkPublicKey(b64: unknown): string {
  const s = typeof b64 === 'string' ? b64.trim() : '';
  if (!/^[A-Za-z0-9+/]{43}=$/.test(s) || Buffer.from(s, 'base64').length !== 32) throw new Error('publicKey 要是 32 字节 X25519 公钥的 base64');
  return s;
}

function keystream(key: Buffer, nonce: Buffer, n: number): Buffer {
  const out: Buffer[] = [];
  for (let i = 0, got = 0; got < n; i++) {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(i);
    const block = createHmac('sha256', key).update(nonce).update(ctr).digest();
    out.push(block); got += block.length;
  }
  return Buffer.concat(out).subarray(0, n);
}

export function seal(publicKeyB64: string, plaintext: Buffer): SealedBox {
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(publicKeyB64, 'base64').toString('base64url') }, format: 'jwk' });
  const eph = generateKeyPairSync('x25519');
  const epk = Buffer.from(eph.publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: peer });
  const nonce = randomBytes(16);
  const keys = Buffer.from(hkdfSync('sha256', shared, nonce, INFO, 64));
  const encKey = keys.subarray(0, 32), macKey = keys.subarray(32);
  const ks = keystream(encKey, nonce, plaintext.length);
  const ct = Buffer.alloc(plaintext.length);
  for (let i = 0; i < ct.length; i++) ct[i] = plaintext[i] ^ ks[i];
  const tag = createHmac('sha256', macKey).update(epk).update(nonce).update(ct).digest();
  return { epk: epk.toString('base64'), nonce: nonce.toString('base64'), ct: ct.toString('base64'), tag: tag.toString('base64') };
}
