// Feishu user identity (D54): a person authorizes once in their private chat; a command that declares larkUser
// gets that person's own short-lived token when they run it, masked in output, with Feishu as the only network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { validateScript } from '../src/runner.ts';
import { runCommand, AmberError, larkUserVault } from '../src/engine.ts';
import { NeedsLarkAuth, OAuthRejected, type LarkOAuth, type OAuthTokens, type PollResult } from '../src/lark-user.ts';
import { FEISHU_HOSTS } from '../src/limits.ts';

/** A fake Feishu OAuth: a device code is approved by whoever `approve` names; tokens map back to that person. */
class FakeOAuth implements LarkOAuth {
  scopes = ['minutes:minutes:readonly', 'docs:doc:readonly'];
  starts = 0;
  approvals = new Map<string, string>();         // device code -> union id of whoever approved
  owners = new Map<string, string>();            // access token -> union id
  refreshes = new Map<string, string>();         // refresh token -> union id (valid ones)
  refreshCalls = 0;
  rejectRefresh = false;
  ttlSec = 7200;
  private n = 0;
  private issue(unionId: string): OAuthTokens {
    const n = ++this.n;
    const at = `u-access-${unionId}-${n}-XXXXXXXX`, rt = `u-refresh-${unionId}-${n}-YYYYYYYY`;
    this.owners.set(at, unionId);
    this.refreshes.set(rt, unionId);
    return { accessToken: at, expiresIn: this.ttlSec, refreshToken: rt, refreshExpiresIn: 30 * 86400, scope: [...this.scopes, 'offline_access'].join(' ') };
  }
  async userScopes() { return this.scopes; }
  async deviceStart(scopes: string[]) {
    assert.ok(scopes.includes('offline_access'), 'always asks for offline_access');
    const code = `dc-${++this.starts}`;
    return { deviceCode: code, userCode: `UC-${this.starts}`, verificationUrl: `https://accounts.example/verify?flow=${code}`, expiresIn: 600, interval: 0 };
  }
  async devicePoll(deviceCode: string): Promise<PollResult> {
    const who = this.approvals.get(deviceCode);
    if (!who) return { status: 'pending' };
    if (who === 'DENY') return { status: 'denied' };
    return { status: 'ok', tokens: this.issue(who) };
  }
  async refresh(rt: string) {
    this.refreshCalls++;
    const who = this.refreshes.get(rt);
    if (this.rejectRefresh || !who) throw new OAuthRejected('invalid_grant');
    this.refreshes.delete(rt);                    // rotated: the old one never works again
    return this.issue(who);
  }
  async whoAmI(at: string) { const u = this.owners.get(at); if (!u) throw new Error('bad token'); return { unionId: u }; }
}

/** Prints what it got: the token itself (must come out masked), facts about it (must come out intact), the proxy. */
const USES_TOKEN = script(`import json,sys,os
inp=json.load(sys.stdin)
l=inp.get("larkUser") or {}
print("token=" + l.get("accessToken","NONE"))
print("envtoken=" + l.get("env",{}).get("LARKSUITE_CLI_USER_ACCESS_TOKEN","NONE"))
print("owner=" + l.get("accessToken","").split("-")[2] if l else "owner=NONE")
print("app=" + l.get("env",{}).get("LARKSUITE_CLI_APP_ID","NONE"))
print("proxy=" + ("yes" if os.environ.get("HTTPS_PROXY") else "no"))`, { larkUser: true });

async function authorize(env: any, oauth: FakeOAuth, u: any, approver = u): Promise<any> {
  const before = env.fake.sent.length;
  await env.dm(u, '授权飞书');
  const sent = env.fake.sent.slice(before).find((s: any) => /授权飞书/.test(FakeFeishu.text(s.card)) && urlButton(s.card));
  assert.ok(sent, 'the authorization card');
  const flow = /flow=(dc-\d+)/.exec(urlButton(sent.card)!)![1];
  oauth.approvals.set(flow, approver.unionId);
  // Done when the card is patched away from the orange "click here" card.
  return env.waitFor(() => { const c = env.fake.cardOf(sent.id); return c?.header?.template !== 'orange' && c; });
}

test('larkUser: script declaration rules', () => {
  assert.equal(validateScript({ kind: 'script', lang: 'python', code: 'print(1)', larkUser: true }).larkUser, true);
  assert.equal(validateScript({ kind: 'script', lang: 'python', code: 'print(1)' }).larkUser, undefined);
  assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', larkUser: true, network: true }), /不能开放外网/);
  assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', larkUser: 'yes' }), /只能写 true 或 false/);
  assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', larkUser: true, env: 'mac/台账' }), /只能在 Amber 本机运行/);
});

test('larkUser: authorize in private chat, only as yourself; a group request goes to the private chat', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  try {
    const { alice, bob, fake } = env;
    const v = larkUserVault()!;
    v.pollFloorMs = 5;
    // Bob approves Alice's link (a forwarded link): thrown away, nothing stored under Alice.
    const wrong = await authorize(env, oauth, alice, bob);
    assert.match(FakeFeishu.text(wrong), /不是你本人/);
    assert.equal(v.status(alice.unionId).authorized, false);
    assert.equal(env.amber.store.larkUserRow(alice.unionId), undefined);
    // Alice approves her own: stored, encrypted, with the scopes.
    const done = await authorize(env, oauth, alice);
    assert.match(FakeFeishu.text(done), /已授权，3 项用户权限/);
    const row = env.amber.store.larkUserRow(alice.unionId)!;
    assert.ok(row.refresh_cipher.startsWith('v1:'));
    assert.doesNotMatch(row.refresh_cipher, /u-refresh/, 'the refresh token is not stored in the clear');
    assert.equal(v.status(alice.unionId).authorized, true);
    // Asked in a group: the link goes to the private chat, the group only hears that it did.
    const before = fake.sent.length;
    await env.say(bob, GROUP, '授权飞书');
    const out = fake.sent.slice(before);
    const dm = out.find(s => s.to.unionId === bob.unionId);
    assert.ok(dm && urlButton(dm.card), 'link sent privately');
    const inGroup = out.filter(s => s !== dm);
    assert.ok(inGroup.length >= 1 && inGroup.every(s => !urlButton(s.card)), 'no link in the group');
    // Status and revoke.
    await env.dm(alice, '飞书授权状态');
    assert.match(FakeFeishu.text(fake.sent.at(-1)!.card), /已授权，3 项/);
    await env.dm(alice, '撤销飞书授权');
    assert.match(FakeFeishu.text(fake.sent.at(-1)!.card), /已删除你的飞书授权/);
    assert.equal(v.status(alice.unionId).authorized, false);
  } finally { await env.close(); }
});

test('larkUser: a run gets the caller\'s own token, masked in output, Feishu-only network; no authorization, no run', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  try {
    const { alice, bob, fake } = env;
    larkUserVault()!.pollFloorMs = 5;
    await authorize(env, oauth, alice);
    // Every local run's network allow list, as the engine hands it over.
    // Amber's own allow list has a non-Feishu host: a larkUser run must not get it.
    env.amber.store.setSetting('local_allow_hosts', JSON.stringify(['api.example.com']));
    const hub = env.amber.hub as any;
    const seen: (string[] | undefined)[] = [];
    const orig = hub.runLocal.bind(hub);
    hub.runLocal = (s: any, input: any, o: any) => { seen.push(o?.egress); return orig(s, input, o); };
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '飞书身份', params: [], script: USES_TOKEN }, alice);
    assert.deepEqual(seen.at(-1), FEISHU_HOSTS, 'a larkUser run reaches Feishu only');
    const cmd = env.amber.store.getCommand(id)!;
    const r = await runCommand(env.amber.store, cmd, {}, { unionId: alice.unionId, chatId: GROUP, chatType: 'group', channel: 'bot' });
    assert.equal(r.ok, true, r.error);
    assert.match(r.markdown, /token=\*\*\*/);
    assert.match(r.markdown, /envtoken=\*\*\*/);
    assert.match(r.markdown, /owner=on_alice/, 'the token is the caller\'s own');
    assert.match(r.markdown, /app=cli_test/);
    assert.match(r.markdown, /proxy=yes/);
    assert.doesNotMatch(r.markdown, /u-access-/);
    for (const run of env.amber.store.runsByCaller(alice.unionId, 5)) assert.doesNotMatch(String(run.result), /u-access-/, 'stored output is masked');
    // Bob has not authorized: refused before anything runs, and told how to fix it.
    fake.chats.get(GROUP)!.members.add(bob.unionId);
    await assert.rejects(runCommand(env.amber.store, cmd, {}, { unionId: bob.unionId, chatId: GROUP, chatType: 'group', channel: 'bot' }),
      (e: any) => e instanceof AmberError && e.code === 'needs_lark_auth' && /授权飞书/.test(e.message));
    // An agent run stands for nobody.
    await assert.rejects(runCommand(env.amber.store, cmd, {}, { unionId: 'agent:local', chatId: GROUP, chatType: 'group', channel: 'agent' }),
      (e: any) => e instanceof AmberError && e.code === 'forbidden');
    // A script that does not declare it gets no token, even for an authorized caller.
    const plain = await activate(env, { chatId: GROUP, chatType: 'group', name: '普通', params: [], script: script(USES_TOKEN.code as string) }, alice);
    const r2 = await runCommand(env.amber.store, env.amber.store.getCommand(plain)!, {}, { unionId: alice.unionId, chatId: GROUP, chatType: 'group', channel: 'bot' });
    assert.match(r2.markdown, /token=NONE/);
    assert.ok(seen.at(-1)!.includes('api.example.com'), 'other runs keep Amber\'s allow list');
  } finally { await env.close(); }
});

test('larkUser vault: refresh rotates, a rejected refresh asks the person again (reminded once a day), ciphertext bound to its person', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  try {
    const { alice, bob, fake } = env;
    const v = larkUserVault()!;
    v.pollFloorMs = 5;
    await authorize(env, oauth, alice);
    // Fresh from the authorization: no refresh needed.
    const t1 = await v.token(alice.unionId, 60_000);
    assert.equal(oauth.refreshCalls, 0);
    // Nearly expired: one refresh; concurrent callers share it; the rotated refresh token is kept.
    (v as any).access.get(alice.unionId).expiresAt = Date.now() + 10_000;
    const [a, b] = await Promise.all([v.token(alice.unionId, 60_000), v.token(alice.unionId, 60_000)]);
    assert.equal(oauth.refreshCalls, 1);
    assert.equal(a.token, b.token);
    assert.notEqual(a.token, t1.token);
    (v as any).access.clear();
    await v.token(alice.unionId, 60_000);
    assert.equal(oauth.refreshCalls, 2, 'the rotated refresh token works (the old one would have been rejected)');
    // Feishu rejects the refresh: the authorization is dead, the person must authorize again.
    (v as any).access.clear();
    oauth.rejectRefresh = true;
    await assert.rejects(v.token(alice.unionId, 60_000), NeedsLarkAuth);
    assert.equal(v.status(alice.unionId).authorized, false);
    await assert.rejects(v.token(alice.unionId, 60_000), NeedsLarkAuth);
    assert.equal(oauth.refreshCalls, 3, 'a dead authorization is not retried');
    assert.equal(v.shouldRemind(alice.unionId), true);
    assert.equal(v.shouldRemind(alice.unionId), false, 'at most once a day');
    // Re-authorizing brings it back (and resets the reminder).
    oauth.rejectRefresh = false;
    await authorize(env, oauth, alice);
    assert.equal(v.status(alice.unionId).authorized, true);
    // A ciphertext copied under another person does not decrypt: that authorization is dead, not Alice's.
    const row = env.amber.store.larkUserRow(alice.unionId)!;
    env.amber.store.upsertLarkUser({ unionId: bob.unionId, openId: null, scopes: row.scopes, refreshCipher: row.refresh_cipher, refreshExpiresAt: null, at: Date.now() });
    await assert.rejects(v.token(bob.unionId, 60_000), NeedsLarkAuth);
    assert.equal(v.status(bob.unionId).authorized, false);
    void fake;
  } finally { await env.close(); }
});

test('larkUser: the review document and the claim card say the app runs as the person', async () => {
  const oauth = new FakeOAuth();
  const env = await makeEnv({}, { larkOAuth: oauth });
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '审核提示', params: [], script: USES_TOKEN });
    assert.equal(r.ok, true);
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /以执行人本人的飞书身份运行/);
  } finally { await env.close(); }
});

test('larkUser: lark-cli is handed to scripts as the native binary behind the npm wrapper', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { resolveLarkCli } = await import('../src/lark-user.ts');
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'larkcli-')));
  mkdirSync(join(d, 'pkg/scripts'), { recursive: true }); mkdirSync(join(d, 'pkg/bin')); mkdirSync(join(d, 'path'));
  writeFileSync(join(d, 'pkg/scripts/run.js'), '#!/usr/bin/env node\n'); writeFileSync(join(d, 'pkg/bin/lark-cli'), '');
  symlinkSync(join(d, 'pkg/scripts/run.js'), join(d, 'path/lark-cli'));
  assert.equal(resolveLarkCli({ PATH: `/nonexistent:${join(d, 'path')}` }), join(d, 'pkg/bin/lark-cli'));
  assert.equal(resolveLarkCli({ PATH: '/nonexistent' }), undefined);
  assert.equal(resolveLarkCli({ PATH: join(d, 'path'), AMBER_LARK_CLI: '/x/lark-cli' }), '/x/lark-cli');
});
