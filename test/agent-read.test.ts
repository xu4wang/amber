// `amber read`: an agent reads a person's own data through an app that declares toAgent. The person allows it on a
// card in their private chat with Amber — once, or for that agent session for a time they pick — and the app runs as
// them; its output comes sealed to the key pair the client made for that request, once, to the machine that asked.
// Only from the person's private chat with the agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { makeEnv, activate, script, button, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { validateScript } from '../src/runner.ts';
import { larkUserVault, runCommand } from '../src/engine.ts';
import { OAuthRejected, type LarkOAuth, type OAuthTokens, type PollResult } from '../src/lark-user.ts';

class FakeOAuth implements LarkOAuth {
  scopes = ['im:message:readonly'];
  approvals = new Map<string, string>();
  owners = new Map<string, string>();
  refreshes = new Map<string, string>();
  private n = 0;
  private issue(unionId: string): OAuthTokens {
    const n = ++this.n;
    const at = `u-access-${unionId}-${n}-XXXXXXXX`, rt = `u-refresh-${unionId}-${n}-YYYYYYYY`;
    this.owners.set(at, unionId); this.refreshes.set(rt, unionId);
    return { accessToken: at, expiresIn: 7200, refreshToken: rt, refreshExpiresIn: 30 * 86400, scope: [...this.scopes, 'offline_access'].join(' ') };
  }
  async userScopes() { return this.scopes; }
  async deviceStart() { const code = `dc-${++this.n}`; return { deviceCode: code, userCode: 'UC', verificationUrl: `https://accounts.example/verify?flow=${code}`, expiresIn: 600, interval: 0 }; }
  async devicePoll(code: string): Promise<PollResult> { const who = this.approvals.get(code); return who ? { status: 'ok', tokens: this.issue(who) } : { status: 'pending' }; }
  async refresh(rt: string) { const who = this.refreshes.get(rt); if (!who) throw new OAuthRejected('invalid_grant'); this.refreshes.delete(rt); return this.issue(who); }
  async whoAmI(at: string) { const u = this.owners.get(at); if (!u) throw new Error('bad token'); return { unionId: u }; }
}

async function authorize(env: any, oauth: FakeOAuth, u: any): Promise<void> {
  const before = env.fake.sent.length;
  await env.dm(u, '授权飞书');
  const sent = env.fake.sent.slice(before).find((s: any) => urlButton(s.card));
  oauth.approvals.set(/flow=(dc-\d+)/.exec(urlButton(sent.card)!)![1], u.unionId);
  await env.waitFor(() => { const c = env.fake.cardOf(sent.id); return c?.header?.template !== 'orange' && c; });
}

function keyPair() {
  const k = generateKeyPairSync('x25519');
  return { priv: k.privateKey, pub: Buffer.from(k.publicKey.export({ format: 'jwk' }).x!, 'base64url').toString('base64') };
}
function open(priv: any, box: any, info = 'amber-agent-read/1'): any {
  const [epk, nonce, ct, tag] = ['epk', 'nonce', 'ct', 'tag'].map(k => Buffer.from(box[k], 'base64'));
  const peer = createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: epk.toString('base64url') }, format: 'jwk' });
  const keys = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: priv, publicKey: peer }), nonce, info, 64));
  const want = createHmac('sha256', keys.subarray(32)).update(epk).update(nonce).update(ct).digest();
  if (!timingSafeEqual(want, tag)) throw new Error('bad tag');
  const out = Buffer.alloc(ct.length);
  for (let i = 0, blk = 0; i < ct.length; blk++) {
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(blk);
    const ks = createHmac('sha256', keys.subarray(0, 32)).update(nonce).update(ctr).digest();
    for (let j = 0; j < ks.length && i < ct.length; j++, i++) out[i] = ct[i] ^ ks[j];
  }
  return JSON.parse(out.toString('utf8'));
}

/** Prints whose token it got (the token itself must come out masked) and the parameter. */
const MY_DATA = script(`import json,sys
inp=json.load(sys.stdin)
l=inp["larkUser"]
print("owner=" + l["accessToken"].split("-")[2])
print("token=" + l["accessToken"])
print("q=" + inp["params"].get("q",""))`, { larkUser: true, toAgent: true });

const AGENT_DM = 'oc_agentdm1';

test('toAgent: declaration rules', () => {
  assert.equal(validateScript({ kind: 'script', lang: 'python', code: 'print(1)', toAgent: true }).toAgent, true);
  assert.equal(validateScript({ kind: 'script', lang: 'python', code: 'print(1)' }).toAgent, undefined);
  assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', toAgent: 'yes' }), /只能写 true 或 false/);
});

test('amber read: allowed once or for a while on a private card; sealed result, once, to the asking machine', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  const { alice, bob, fake } = env;
  try {
    larkUserVault()!.pollFloorMs = 5;
    await authorize(env, oauth, alice);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '我的数据', params: [{ name: 'q', type: 'string', maxLength: 50 }], script: MY_DATA }, alice);
    env.amber.store.setGlobal(id, true);
    const plain = await activate(env, { chatId: GROUP, chatType: 'group', name: '普通', params: [], script: script('print(1)', { larkUser: true }) }, alice);
    env.amber.store.setGlobal(plain, true);
    const ctx = (u: any, o: object = {}) => ({ chatId: AGENT_DM, chatType: 'p2p', label: '锦衣卫', user: u.email, ...o });
    const ask = (u: any, body: object, ip = '10.0.0.2', o: object = {}) => env.api('POST', '/v1/reads', { ...ctx(u, o), ...body }, ip);
    const reqOf = (rid: string) => env.amber.store.getRequest(rid)!;
    const { priv, pub } = keyPair();

    // Refused before any card: in a group, an app without toAgent, a bad key, no --user.
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub }, '10.0.0.2', { chatId: GROUP, chatType: 'group' })).body.error, 'forbidden');
    assert.match((await ask(alice, { command: '普通', publicKey: pub })).body.message, /toAgent/);
    assert.equal((await ask(alice, { command: '我的数据', publicKey: 'abc' })).body.error, 'bad_request');
    assert.equal((await env.api('POST', '/v1/reads', { chatId: GROUP, chatType: 'group', command: '我的数据', publicKey: pub })).body.error, 'user_required');
    assert.equal((await ask(alice, { command: '我的数据', args: { q: 'x'.repeat(60) }, publicKey: pub })).body.error, 'invalid_args', 'arguments checked before asking');

    // Asked: the card goes to alice's private chat with Amber; it names the machine, the agent and its session.
    let before = fake.sent.length;
    const r = await ask(alice, { command: '我的数据', args: { q: '周报' }, publicKey: pub, session: 'sess-A' });
    assert.equal(r.body.mode, 'confirm_card', JSON.stringify(r.body));
    const card = fake.sent.slice(before).find(s => button(s.card, 'req_ok'))!;
    assert.equal(card.to.unionId, alice.unionId);
    assert.equal((card.card as any).header.template, 'red');
    const text = FakeFeishu.text(card.card);
    assert.match(text, /fleet-b/); assert.match(text, /锦衣卫/); assert.match(text, /sess-A/); assert.match(text, /oc_agentdm1/); assert.match(text, /周报/);
    assert.ok(button(card.card, 'ar_hours'), 'can allow for a while');
    assert.doesNotMatch(JSON.stringify(card.card), /publicKey|[A-Za-z0-9+/]{43}=/, 'no key on the card');
    // Nothing to fetch before it is allowed; only alice can allow it.
    assert.equal((await env.api('POST', '/v1/reads/fetch', { requestId: r.body.requestId }, '10.0.0.2')).body.error, 'not_found');
    assert.match(JSON.stringify(await env.click(bob, card.id, button(card.card, 'req_ok')!)), /只有被读取数据的本人/);
    const allowed = await env.click(alice, card.id, button(card.card, 'req_ok')!);
    assert.doesNotMatch(JSON.stringify(allowed), /ar_revoke/, 'allowed once: no grant');
    await env.waitFor(() => reqOf(r.body.requestId).status === 'done');
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.resultIn, 'sealed');
    // Another machine gets nothing; the asking one gets it once; it runs as alice, the token masked.
    assert.equal((await env.api('POST', '/v1/reads/fetch', { requestId: r.body.requestId }, '127.0.0.1')).body.error, 'not_found');
    const f = await env.api('POST', '/v1/reads/fetch', { requestId: r.body.requestId }, '10.0.0.2');
    assert.equal(f.body.ok, true);
    assert.doesNotMatch(JSON.stringify(f.body), /owner=/);
    const res = open(priv, f.body.box);
    assert.equal(res.ok, true);
    assert.match(res.markdown, /owner=on_alice/); assert.match(res.markdown, /q=周报/);
    assert.match(res.markdown, /token=\*\*\*/); assert.doesNotMatch(res.markdown, /u-access/);
    assert.throws(() => open(priv, f.body.box, 'amber-secret-read/1'), 'a read box never opens as a secret');
    assert.throws(() => open(keyPair().priv, f.body.box));
    assert.equal((await env.api('POST', '/v1/reads/fetch', { requestId: r.body.requestId }, '10.0.0.2')).body.error, 'not_found', 'once');
    assert.equal(env.amber.store.getRun(reqOf(r.body.requestId).runId!)!.callerUnionId, alice.unionId, 'the run record is alice\'s');

    // Only an allowed read runs as the person: any other agent-channel run of a larkUser app is still refused.
    await assert.rejects(runCommand(env.amber.store, env.amber.store.getCommand(id)!, {}, { unionId: alice.unionId, chatId: AGENT_DM, chatType: 'p2p', channel: 'agent' }, {}, { viaForm: true }), /只能由人执行/);

    // Allowed once does not cover the next read; allowing for 30 minutes does, for that session only.
    before = fake.sent.length;
    const r2 = await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-A' });
    assert.equal(r2.body.mode, 'confirm_card');
    const c2 = fake.sent.slice(before).find(s => button(s.card, 'ar_hours'))!;
    const done2 = await env.click(alice, c2.id, button(c2.card, 'ar_hours')!, { hours: '0.5' });
    const revoke = button(done2.card?.data ?? done2.card ?? done2, 'ar_revoke') ?? button(done2, 'ar_revoke');
    assert.ok(revoke, 'a button to end the grant');
    await env.waitFor(() => reqOf(r2.body.requestId).status === 'done');
    const grantAudit = env.amber.store.listAudit({ prefixes: ['agentread.grant'], limit: 5 }).find(a => a.action === 'agentread.grant')!;
    const until = JSON.parse(grantAudit.detail).until;
    assert.ok(Math.abs(until - (Date.now() + 30 * 60_000)) < 60_000, 'the picked duration');
    before = fake.sent.length;
    const r3 = await ask(alice, { command: '我的数据', args: { q: '再来' }, publicKey: pub, session: 'sess-A' });
    assert.equal(r3.body.mode, 'granted', JSON.stringify(r3.body));
    await env.waitFor(() => reqOf(r3.body.requestId).status === 'done');
    assert.equal(fake.sent.length, before, 'no card while granted');
    assert.match(open(priv, (await env.api('POST', '/v1/reads/fetch', { requestId: r3.body.requestId }, '10.0.0.2')).body.box).markdown, /q=再来/);
    // Another session, another agent name, another machine, another chat: asked again.
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-B' })).body.mode, 'confirm_card');
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-A' }, '10.0.0.2', { label: '别的' })).body.mode, 'confirm_card');
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-A' }, '127.0.0.1')).body.mode, 'confirm_card');
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-A' }, '10.0.0.2', { chatId: 'oc_otherdm' })).body.mode, 'confirm_card');
    // Only alice can end it; then she is asked again.
    assert.match(JSON.stringify(await env.click(bob, c2.id, revoke!)), /只有授权的本人/);
    assert.match(JSON.stringify(await env.click(alice, c2.id, revoke!)), /已撤销/);
    assert.equal((await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-A' })).body.mode, 'confirm_card');

    // A duration that is not offered falls back to 2 hours.
    before = fake.sent.length;
    const r4 = await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-C' });
    const c4 = fake.sent.slice(before).find(s => button(s.card, 'ar_hours'))!;
    await env.click(alice, c4.id, button(c4.card, 'ar_hours')!, { hours: '999' });
    await env.waitFor(() => reqOf(r4.body.requestId).status === 'done');
    const g4 = env.amber.store.listAudit({ prefixes: ['agentread.grant'], limit: 10 }).filter(a => a.action === 'agentread.grant').map(a => JSON.parse(a.detail)).find(d => d.session === 'sess-C')!;
    assert.ok(Math.abs(g4.until - (Date.now() + 2 * 3600_000)) < 60_000);

    // Declined; expired after 10 minutes.
    before = fake.sent.length;
    const r5 = await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-D' });
    const c5 = fake.sent.slice(before).find(s => button(s.card, 'req_no'))!;
    await env.click(alice, c5.id, button(c5.card, 'req_no')!);
    assert.equal(reqOf(r5.body.requestId).status, 'canceled');
    before = fake.sent.length;
    const r6 = await ask(alice, { command: '我的数据', publicKey: pub, session: 'sess-D' });
    const c6 = fake.sent.slice(before).find(s => button(s.card, 'req_ok'))!;
    (env.amber.store as any).db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(Date.now() - 11 * 60_000, r6.body.requestId);
    assert.match(JSON.stringify(await env.click(alice, c6.id, button(c6.card, 'req_ok')!)), /已过期/);

    // Bob has not authorized Feishu: allowed, but the run is refused, and the reason (no data) is in the status.
    before = fake.sent.length;
    const rb = await ask(bob, { command: '我的数据', publicKey: pub, session: 'sess-bob' });
    const cb = fake.sent.slice(before).find(s => button(s.card, 'req_ok'))!;
    assert.equal(cb.to.unionId, bob.unionId);
    await env.click(bob, cb.id, button(cb.card, 'req_ok')!);
    await env.waitFor(() => reqOf(rb.body.requestId).status === 'failed');
    assert.match((await env.api('GET', `/v1/requests/${rb.body.requestId}`)).body.error, /授权/);

    // Audit: who allowed what, for which machine and session; never the output.
    const audit = env.amber.store.listAudit({ prefixes: ['agentread.'], limit: 50 });
    for (const a of ['agentread.allow', 'agentread.grant', 'agentread.granted', 'agentread.run', 'agentread.fetched', 'agentread.revoke']) assert.ok(audit.some(x => x.action === a), a);
    assert.ok(audit.every(a => !a.detail.includes('owner=') && !a.detail.includes('u-access')));
  } finally { await env.close(); }
});

test('amber read: the Python client asks, waits for the click, opens the result and prints it', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  const { alice, fake } = env;
  try {
    larkUserVault()!.pollFloorMs = 5;
    await authorize(env, oauth, alice);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '我的数据', params: [{ name: 'q', type: 'string', maxLength: 50 }], script: MY_DATA }, alice);
    env.amber.store.setGlobal(id, true);
    const cli = join(import.meta.dirname, '..', 'client', 'amber');
    // Async: the server runs in this process, a blocking child would deadlock it.
    const child = spawn('python3', [cli, 'read', '我的数据', 'q=日报', '--user', alice.email, '--timeout', '60'], {
      env: { ...process.env, AMBER_URL: `http://127.0.0.1:${env.apiPort}`, BOTMUX_CHAT_ID: AGENT_DM, BOTMUX_CHAT_TYPE: 'p2p', CLAUDE_CODE_SESSION_ID: 'sess-cli', CODEX_THREAD_ID: 'codex-other', BOTMUX_ROOT_MESSAGE_ID: '', AMBER_LABEL: '锦衣卫' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const exited = new Promise<number>(res => child.on('close', code => res(code ?? -1)));
    const card = await env.waitFor(() => fake.sent.find(s => s.to.unionId === alice.unionId && button(s.card, 'ar_hours')));
    assert.match(FakeFeishu.text(card.card), /sess-cli/, 'the client reports its Claude Code session');
    await env.click(alice, card.id, button(card.card, 'req_ok')!);
    const code = await exited;
    assert.equal(code, 0, stderr);
    assert.match(stdout, /owner=on_alice/); assert.match(stdout, /q=日报/); assert.doesNotMatch(stdout, /u-access/);
  } finally { await env.close(); }
});
