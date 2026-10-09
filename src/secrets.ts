// Command secrets (D48): values a command's script needs at run time — an API token, a service
// account password — like the env vars of a production deployment.
//
// - A command declares the names (script.secrets); the names are reviewed with the code. The values
//   are not reviewed and can change without a new review.
// - Values belong to the command's lineage in its chat (chat + command name), so a new version keeps
//   them. They are set only by the creator or an admin (or, for a new draft, whoever may claim it),
//   in the person's private chat with Amber or on the website — never through an agent.
// - At rest they are encrypted with AES-256-GCM; the key is a separate file next to the signing key.
// - A run gets only the names its command declares, on stdin, never in the environment; any value
//   that shows up in the output or error is replaced with ***.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const MAX_SECRETS = 10;
export const MAX_SECRET_BYTES = 8 * 1024;

export interface SecretInfo { name: string; set: boolean; last4?: string; updatedAt?: number }
type Lineage = { chatId: string; name: string };

export class SecretVault {
  private key: Buffer;
  private store: Store;

  constructor(store: Store, configDir: string) {
    this.store = store;
    const p = join(configDir, 'secrets-key');
    if (!existsSync(p)) writeFileSync(p, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    this.key = Buffer.from(readFileSync(p, 'utf8').trim(), 'base64');
    if (this.key.length !== 32) throw new Error('secrets-key 文件不对：应为 32 字节的 base64');
  }

  // Bound to where the value belongs, so a ciphertext copied to another row does not decrypt.
  private aad(c: Lineage, secret: string): Buffer { return Buffer.from(`amber-secret\0${c.chatId}\0${c.name}\0${secret}`); }

  private seal(c: Lineage, secret: string, value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(c, secret));
    const ct = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
  }

  private open(c: Lineage, secret: string, blob: string): string {
    if (!blob.startsWith('v1:')) throw new Error('unknown secret format');
    const raw = Buffer.from(blob.slice(3), 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAAD(this.aad(c, secret));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }

  set(c: Lineage, secret: string, value: string, by: string): void {
    if (!SECRET_NAME.test(secret)) throw new Error('密钥名称不对');
    if (value.length < 6) throw new Error('密钥至少 6 个字符（太短的值无法在输出里可靠遮盖）');
    if (Buffer.byteLength(value) > MAX_SECRET_BYTES) throw new Error('密钥太长（最多 8KB）');
    const last4 = value.length >= 8 ? value.slice(-4) : '';
    this.store.putSecret(c.chatId, c.name, secret, this.seal(c, secret, value), last4, by);
  }

  delete(c: Lineage, secret: string): boolean { return this.store.deleteSecret(c.chatId, c.name, secret); }

  deleteAll(c: Lineage): number { return this.store.deleteSecretsOf(c.chatId, c.name); }

  /** Status of each declared name, without values. */
  info(c: Lineage, declared: string[]): SecretInfo[] {
    const rows = new Map(this.store.secretRows(c.chatId, c.name).map(r => [r.name, r]));
    return declared.map(n => {
      const r = rows.get(n);
      return r ? { name: n, set: true, ...(r.last4 ? { last4: r.last4 } : {}), updatedAt: r.updatedAt } : { name: n, set: false };
    });
  }

  /** Values for a run: only the declared names. Returns the names that are missing instead when any is. */
  values(c: Lineage, declared: string[]): { values: Record<string, string> } | { missing: string[] } {
    const rows = new Map(this.store.secretRows(c.chatId, c.name).map(r => [r.name, r]));
    const missing = declared.filter(n => !rows.has(n));
    if (missing.length) return { missing };
    const values: Record<string, string> = {};
    for (const n of declared) values[n] = this.open(c, n, rows.get(n)!.cipher);
    return { values };
  }
}

export { redact } from './exec-proto.ts';

/** One line for cards, review documents and approvals: which secrets a command uses and who shares them. */
export function describeSecrets(c: { scopeType: string; script: { secrets?: string[] } }): string {
  const names = c.script.secrets ?? [];
  if (!names.length) return '';
  const who = '只有创建人自己会用到；设为全局指令后，所有执行人共用同一份';
  return `${names.join('、')}（值不参与审核，由创建人或管理员设置；${who}）`;
}
