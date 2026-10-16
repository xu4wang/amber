// `amber secret get`: an agent reads one secret of an app; only the app's creator allows it, each time, on a card
// in their private chat. The value comes sealed to the key pair the client made for that request, once, to the
// machine that asked — never in the clear, never twice. The client side is Python (client/amber); here a Node
// mirror of its open() checks what Amber hands out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, activate, script, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { secretVault } from '../src/engine.ts';

function keyPair() {
  const k = generateKeyPairSync('x25519');
  return { priv: k.privateKey, pub: Buffer.from(k.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64') };
}
function open(priv: any, box: any): string {
  const [epk, nonce, ct, tag] = ['epk', 'nonce', 'ct', 'tag'].map(k => Buffer.from(box[k], 'base64'));
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: epk.toString('base64url') }, format: 'jwk' });
  const keys = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: priv, publicKey: peer }), nonce, 'amber-secret-read/1', 64));
  const want = createHmac('sha256', keys.subarray(32)).update(epk).update(nonce).update(ct).digest();
  if (!timingSafeEqual(want, tag)) throw new Error('bad tag');
  const out = Buffer.alloc(ct.length);
  for (let i = 0, blk = 0; i < ct.length; blk++) {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(blk);
    const ks = createHmac('sha256', keys.subarray(0, 32)).update(nonce).update(ctr).digest();
    for (let j = 0; j < ks.length && i < ct.length; j++, i++) out[i] = ct[i] ^ ks[j];
  }
  return out.toString('utf8');
}

test('secret get: the creator allows it on a card; the value comes sealed, once, to the asking machine', async () => {
  const env = await makeEnv();
  const { alice, bob, carol, fake } = env;
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    // A vault in bob's private chat (as if installed from the Store), and a group app of bob's.
    fake.chats.set('oc_dmbob', { mode: 'p2p', name: '', members: new Set(['BOT', bob.unionId]) });
    const line = { chatId: 'oc_dmbob', name: '密钥保管箱' };
    secretVault()!.set(line, 'KEY1', 'gitlab-秘密-123456', bob.unionId);
    secretVault()!.set(line, 'KEY2', 'temporary-value', bob.unionId);
    const vaultId = await activate(env, { chatId: 'oc_dmbob', chatType: 'p2p', claimer: bob.email, name: '密钥保管箱', params: [], script: script('print("ok")', { secrets: ['KEY1', 'KEY2'] }) }, bob);
    secretVault()!.delete(line, 'KEY2');
    const ctx = (u: any, ip?: string) => ({ chatId: GROUP, chatType: 'group', label: '锦衣卫', user: u.email });
    const ask = (u: any, body: object, ip?: string) => env.api('POST', '/v1/secrets/read', { ...ctx(u), ...body }, ip);
    const { priv, pub } = keyPair();

    // Refused before any card: someone else as --user, an undeclared or unset secret, a bad key, no --user.
    assert.equal((await ask(carol, { command: '密钥保管箱', secret: 'KEY1', publicKey: pub })).body.error, 'not_found', 'not carol\'s app');
    assert.equal((await ask(bob, { command: '密钥保管箱', secret: 'KEY9', publicKey: pub })).body.error, 'not_found');
    assert.equal((await ask(bob, { command: '密钥保管箱', secret: 'KEY2', publicKey: pub })).body.error, 'secret_missing');
    assert.equal((await ask(bob, { command: '密钥保管箱', secret: 'KEY1', publicKey: 'abc' })).body.error, 'bad_request');
    assert.equal((await env.api('POST', '/v1/secrets/read', { chatId: GROUP, chatType: 'group', command: '密钥保管箱', secret: 'KEY1', publicKey: pub })).body.error, 'user_required');
    // A global app of bob's is visible to carol, but its secrets are bob's to give: carol cannot ask for them.
    secretVault()!.set({ chatId: GROUP, name: '公用' }, 'TOKEN', 'shared-token-xyz', bob.unionId);
    const shared = await activate(env, { chatId: GROUP, chatType: 'group', name: '公用', params: [], script: script('print(1)', { secrets: ['TOKEN'] }) }, bob);
    env.amber.store.setGlobal(shared, true);
    assert.equal((await ask(carol, { command: '公用', secret: 'TOKEN', publicKey: pub })).body.error, 'forbidden');

    // Asked: the card goes to bob's private chat, not to the group; it names the machine and the secret.
    const before = fake.sent.length;
    const r = await ask(bob, { command: '密钥保管箱', secret: 'KEY1', publicKey: pub }, '10.0.0.2');
    assert.equal(r.body.ok, true, JSON.stringify(r.body));
    const card = fake.sent.slice(before).find(s => button(s.card, 'req_ok'))!;
    assert.equal(card.to.unionId, bob.unionId);
    assert.equal((card.card as any).header.template, 'red', 'marked as sensitive');
    assert.match(FakeFeishu.text(card.card), /fleet-b/);
    assert.match(FakeFeishu.text(card.card), /KEY1/);
    assert.doesNotMatch(JSON.stringify(card.card), /gitlab-秘密|publicKey|[A-Za-z0-9+/]{43}=/, 'neither the value nor the key on the card');
    // Nothing to fetch before it is allowed; only bob can allow it.
    assert.equal((await env.api('POST', '/v1/secrets/fetch', { requestId: r.body.requestId }, '10.0.0.2')).body.error, 'not_found');
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'req_ok')!)), /只有应用的创建人/);
    await env.click(bob, card.id, button(card.card, 'req_ok')!);
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.status, 'done');
    // Another machine gets nothing; the asking one gets the sealed value once; it opens with its own key only.
    assert.equal((await env.api('POST', '/v1/secrets/fetch', { requestId: r.body.requestId }, '127.0.0.1')).body.error, 'not_found');
    const f = await env.api('POST', '/v1/secrets/fetch', { requestId: r.body.requestId }, '10.0.0.2');
    assert.equal(f.body.ok, true);
    assert.doesNotMatch(JSON.stringify(f.body), /gitlab-秘密/);
    assert.equal(open(priv, f.body.box), 'gitlab-秘密-123456');
    assert.throws(() => open(keyPair().priv, f.body.box));
    assert.equal((await env.api('POST', '/v1/secrets/fetch', { requestId: r.body.requestId }, '10.0.0.2')).body.error, 'not_found', 'once');
    // Audit: who allowed what, for which machine; never the value.
    const audit = env.amber.store.listAudit({ prefixes: ['secret.read'], limit: 10 });
    assert.deepEqual(audit.map(a => a.action).sort(), ['secret.read', 'secret.read_fetched']);
    assert.ok(audit.every(a => !a.detail.includes('gitlab-秘密')));

    // Declined, and expired after 10 minutes.
    const r2 = await ask(bob, { command: '密钥保管箱', secret: 'KEY1', publicKey: pub }, '10.0.0.2');
    const c2 = fake.sent.at(-1)!;
    await env.click(bob, c2.id, button(c2.card, 'req_no')!);
    assert.equal((await env.api('GET', `/v1/requests/${r2.body.requestId}`)).body.status, 'canceled');
    const r3 = await ask(bob, { command: vaultId, secret: 'KEY1', publicKey: pub }, '10.0.0.2');
    assert.equal(r3.body.ok, true, 'by app id too');
    (env.amber.store as any).db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, r3.body.requestId);
    const c3 = fake.sent.at(-1)!;
    assert.match(JSON.stringify(await env.click(bob, c3.id, button(c3.card, 'req_ok')!)), /已过期/);
    assert.equal((await env.api('POST', '/v1/secrets/fetch', { requestId: r3.body.requestId }, '10.0.0.2')).body.error, 'not_found');
  } finally { await env.close(); }
});

test('secret get: the Python client opens what Amber seals and writes the file 600 without printing the value', async () => {
  const { seal } = await import('../src/secret-box.ts');
  const loader = `import importlib.machinery, importlib.util, sys, json, base64, os
l = importlib.machinery.SourceFileLoader('amber', sys.argv[1]); s = importlib.util.spec_from_loader('amber', l); m = importlib.util.module_from_spec(s); l.exec_module(m)
if sys.argv[2] == 'pub':
    priv = os.urandom(32); open(sys.argv[3], 'wb').write(priv); print(base64.b64encode(m._x25519(priv, (9).to_bytes(32, 'little'))).decode())
else:
    print(m.open_box(open(sys.argv[3], 'rb').read(), json.loads(sys.argv[4])).decode())`;
  const dir = mkdtempSync(join(tmpdir(), 'amber-sg-'));
  writeFileSync(join(dir, 'l.py'), loader);
  const cli = join(import.meta.dirname, '..', 'client', 'amber');
  const pub = execFileSync('python3', [join(dir, 'l.py'), cli, 'pub', join(dir, 'k')]).toString().trim();
  const box = seal(pub, Buffer.from('p@ss-词-✓', 'utf8'));
  assert.equal(execFileSync('python3', [join(dir, 'l.py'), cli, 'open', join(dir, 'k'), JSON.stringify(box)]).toString().trim(), 'p@ss-词-✓');
  assert.ok(existsSync(cli) && statSync(cli).isFile());
  assert.ok(readFileSync(cli, 'utf8').includes('0o600'), 'the client writes the file with mode 600');
});
