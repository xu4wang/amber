// Command secrets (D48): declared with the code, set only in a private chat or on the website by
// whoever may manage the command, encrypted at rest, given only to that command's runs, masked in output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { SecretVault } from '../src/secrets.ts';

const VALUE = 'sk-live-ABCDEFGH1234';
// Prints the secret (must come out masked) and something derived from it (must come out intact).
const USES_SECRET = script('import json,sys\ninp=json.load(sys.stdin)\ns=inp.get("secrets",{})\nprint("token=" + s.get("API_TOKEN","NONE"))\nprint("len=" + str(len(s.get("API_TOKEN",""))))\nprint("names=" + ",".join(sorted(s)))', { secrets: ['API_TOKEN'] });

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('secrets: declared, set in private chat by the claimer, masked in output, shared by the group, inherited and dropped', async () => {
  const env = await makeEnv();
  try {
    const { alice, bob, carol, fake } = env;
    // A draft that declares a secret: the claim card says so and offers "设置密钥".
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '查余额', params: [], script: USES_SECRET });
    assert.equal(r.ok, true);
    const claim = fake.cardOf(r.claimMessageId);
    assert.match(FakeFeishu.text(claim), /API_TOKEN/);
    assert.ok(button(claim, 'sec_form'));
    // Trial without the value: refused before anything runs.
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    const failed = await env.waitFor(() => /还没设置密钥/.test(FakeFeishu.text(fake.cardOf(r.claimMessageId))) && fake.cardOf(r.claimMessageId));
    assert.match(FakeFeishu.text(failed), /API_TOKEN/);
    // Someone outside the group may not set it.
    assert.match(JSON.stringify(await env.click(carol, r.claimMessageId, { a: 'sec_form', c: r.id })), /群的成员/);
    // Alice (a member) asks: the form goes to her private chat, as password inputs.
    const before = fake.sent.length;
    await env.click(alice, r.claimMessageId, { a: 'sec_form', c: r.id });
    const form = fake.sent.slice(before).find(s => s.to.unionId === alice.unionId)!;
    assert.ok(form, 'form sent privately');
    assert.match(FakeFeishu.text(form.card), /"input_type":"password"/);
    // Saving is only possible from the private chat.
    assert.match(JSON.stringify(await env.click(alice, r.claimMessageId, { a: 'sec_save', c: r.id }, { API_TOKEN: VALUE })), /私聊/);
    assert.match(JSON.stringify(await env.click(alice, form.id, { a: 'sec_save', c: r.id }, { API_TOKEN: 'short' })), /至少 6 个字符/);
    const saved = await env.click(alice, form.id, { a: 'sec_save', c: r.id }, { API_TOKEN: VALUE });
    assert.match(JSON.stringify(saved), /已保存：API_TOKEN/);
    assert.match(JSON.stringify(saved), /1234/);
    assert.doesNotMatch(JSON.stringify(saved), new RegExp(VALUE), 'the value is never shown back');
    // At rest: encrypted.
    const rows = env.amber.store.secretRows(GROUP, '查余额');
    assert.equal(rows.length, 1);
    assert.ok(!rows[0].cipher.includes(VALUE) && !rows[0].cipher.includes(Buffer.from(VALUE).toString('base64')));
    // Trial now runs with the value, which is masked in what is shown and stored.
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    const tried = await env.waitFor(() => button(fake.cardOf(r.claimMessageId), 'claim_submit') && fake.cardOf(r.claimMessageId));
    const out = FakeFeishu.text(tried);
    assert.match(out, /token=\*\*\*/);
    assert.match(out, /len=20/);
    assert.match(out, /names=API_TOKEN/);
    assert.doesNotMatch(out, new RegExp(VALUE));
    await env.click(alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    await env.approveLatest();
    const cmd = env.amber.store.getCommand(r.id)!;
    assert.equal(cmd.status, 'active');
    // Bob, another member, runs it with the shared value; the result says the secret is shared.
    await env.say(bob, GROUP, '查余额');
    const result = await env.waitFor(() => fake.sent.map(s => fake.cardOf(s.id)).find(c => c?.header?.title?.content === 'Amber · 查余额' && /len=20/.test(FakeFeishu.text(c))));
    assert.match(FakeFeishu.text(result), /本群共用的密钥/);
    for (const run of env.amber.store.runsByCaller(bob.unionId, 5)) assert.doesNotMatch(String(run.result), new RegExp(VALUE), 'stored output is masked');
    // Agents: the name is visible, the value never; running needs a person's click.
    const shown = await env.api('POST', '/v1/commands/show', { chatId: GROUP, chatType: 'group', command: '查余额' });
    assert.deepEqual(shown.body.command.secrets, ['API_TOKEN']);
    assert.deepEqual(shown.body.command.secretsMissing, []);
    assert.equal(shown.body.command.run, 'confirm_card');
    assert.doesNotMatch(JSON.stringify(shown.body), new RegExp(VALUE));
    // Website: names for everyone; only the creator or an admin may change it. Alice claimed; carol is in the group but not an admin.
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    (env.amber.bot as any).memberCache.clear();
    const base = `http://127.0.0.1:${env.webPort}`;
    const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
    const carolCookie = await login(env, carol);
    const ov = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: carolCookie } })).json();
    const view = ov.groups[0].commands.find((c: any) => c.name === '查余额');
    assert.deepEqual(view.secrets, [{ name: 'API_TOKEN', set: true }], 'no tail or time for non-managers');
    assert.equal((await post(carolCookie, `/web/api/commands/${cmd.id}/secrets`, { scope: 'group:' + GROUP, name: 'API_TOKEN', value: 'carol-overwrites' })).status, 403);
    const aliceCookie = await login(env, alice);
    assert.equal((await post(aliceCookie, `/web/api/commands/${cmd.id}/secrets`, { scope: 'group:' + GROUP, name: 'OTHER', value: 'whatever-123' })).status, 400, 'only declared names');
    const del = await post(aliceCookie, `/web/api/commands/${cmd.id}/secrets`, { scope: 'group:' + GROUP, name: 'API_TOKEN', delete: true });
    assert.equal(del.body.ok, true);
    const noSecret = await post(aliceCookie, '/web/api/run', { scope: 'group:' + GROUP, commandId: cmd.id, args: {} });
    assert.match(noSecret.body.message, /还没设置密钥/);
    const set = await post(aliceCookie, `/web/api/commands/${cmd.id}/secrets`, { scope: 'group:' + GROUP, name: 'API_TOKEN', value: 'sk-second-value-9999' });
    assert.equal(set.body.secrets[0].last4, '9999');
    // A new version keeps the values (same chat + name) …
    const v2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '查余额', params: [], script: { ...USES_SECRET, code: USES_SECRET.code + '\nprint("v2")' } }, alice);
    assert.equal(env.amber.store.getCommand(v2)!.status, 'active');
    assert.equal(env.amber.store.secretRows(GROUP, '查余额').length, 1);
    // … and retiring drops them, so a later unrelated command with the same name cannot inherit them.
    await env.say(alice, GROUP, '下线 查余额');
    const confirmCard = fake.sent.at(-1)!;
    await env.click(alice, confirmCard.id, button(confirmCard.card, 'retire_ok')!);
    assert.equal(env.amber.store.getCommand(v2)!.status, 'retired');
    assert.equal(env.amber.store.secretRows(GROUP, '查余额').length, 0);
  } finally { await env.close(); }
});

test('secrets: a dropped brand-new draft takes its secrets with it; undeclared names are never handed out', async () => {
  const env = await makeEnv();
  try {
    const { alice, fake } = env;
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '临时', params: [], script: USES_SECRET });
    await env.click(alice, r.claimMessageId, { a: 'sec_form', c: r.id });
    const form = fake.lastTo(s => s.to.unionId === alice.unionId)!;
    await env.click(alice, form.id, { a: 'sec_save', c: r.id }, { API_TOKEN: VALUE });
    assert.equal(env.amber.store.secretRows(GROUP, '临时').length, 1);
    await env.click(alice, r.claimMessageId, { a: 'claim_drop', c: r.id });
    assert.equal(env.amber.store.secretRows(GROUP, '临时').length, 0);
    // A command that does not declare the secret gets nothing, even with the same name and chat.
    env.amber.store.putSecret(GROUP, '无声明', 'API_TOKEN', 'v1:garbage', '', alice.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '无声明', params: [], script: script(USES_SECRET.code as string) }, alice);
    await env.say(alice, GROUP, '无声明');
    const card = await env.waitFor(() => fake.sent.map(s => fake.cardOf(s.id)).find(c => c?.header?.title?.content === 'Amber · 无声明' && /names=/.test(FakeFeishu.text(c))));
    assert.match(FakeFeishu.text(card), /token=NONE/);
    assert.ok(id);
    // Bad declarations are refused at submit time.
    for (const bad of [['api_token'], ['A', 'A'], 'API_TOKEN', Array.from({ length: 11 }, (_, i) => `K${i}`)]) {
      const x = await env.submit({ chatId: GROUP, chatType: 'group', name: '坏声明', params: [], script: { ...USES_SECRET, secrets: bad } });
      assert.equal(x.ok, false, JSON.stringify(bad));
    }
  } finally { await env.close(); }
});

test('secrets vault: ciphertext is bound to its command and name', async () => {
  const env = await makeEnv();
  try {
    const vault = new SecretVault(env.amber.store, env.cfg.configDir);
    vault.set({ chatId: GROUP, name: '甲' }, 'API_TOKEN', VALUE, 'x');
    const [row] = env.amber.store.secretRows(GROUP, '甲');
    // Moving the ciphertext to another command, or renaming it, does not decrypt.
    env.amber.store.putSecret(GROUP, '乙', 'API_TOKEN', row.cipher, '', 'x');
    env.amber.store.putSecret(GROUP, '甲', 'OTHER_NAME', row.cipher, '', 'x');
    assert.throws(() => vault.values({ chatId: GROUP, name: '乙' }, ['API_TOKEN']));
    assert.throws(() => vault.values({ chatId: GROUP, name: '甲' }, ['OTHER_NAME']));
    assert.deepEqual(vault.values({ chatId: GROUP, name: '甲' }, ['API_TOKEN']), { values: { API_TOKEN: VALUE } });
    assert.deepEqual(vault.values({ chatId: GROUP, name: '甲' }, ['API_TOKEN', 'MISSING']), { missing: ['MISSING'] });
  } finally { await env.close(); }
});
