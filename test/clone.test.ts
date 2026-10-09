// #8: the creator copies their group app to another member; once accepted it is a separate app of theirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { secretVault } from '../src/engine.ts';
import { computeSpecHash } from '../src/db.ts';

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}
const CODE = script('import json,sys\ni=json.load(sys.stdin)\nprint("repo=" + i["params"].get("repo","") + " token=" + i.get("secrets",{}).get("API_TOKEN","")[-4:])', { secrets: ['API_TOKEN'] });
const PARAMS = [{ name: 'repo', label: '仓库', type: 'string', required: true, scope: 'config' }];

test('clone: the creator offers a copy to a member; the copy is theirs, with the configuration and without the secrets', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const scope = 'group:' + GROUP;
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    secretVault()!.set({ chatId: GROUP, name: '报表' }, 'API_TOKEN', 'bob-token-AAAA', bob.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '报表', params: PARAMS, script: CODE }, bob, { repo: 'r' });
    env.amber.store.putConfig(GROUP, '报表', 'repo', 'bob/repo', bob.unionId);
    const bobC = await login(env, bob), carolC = await login(env, carol), aliceC = await login(env, alice);
    const offer = (cookie: string, to: string) => post(cookie, `/web/api/commands/${id}/clone`, { scope, to });

    // Only the creator; only to another member.
    assert.equal((await offer(carolC, carol.unionId)).status, 404);
    assert.equal((await offer(aliceC, carol.unionId)).status, 404, 'not even an admin');
    assert.match((await offer(bobC, bob.unionId)).body.message, /不能复制给自己/);
    assert.match((await offer(bobC, 'on_nobody')).body.message, /群的成员/);
    assert.equal((await fetch(`${base}/web/api/groups/${GROUP}/members`, { headers: { cookie: carolC } })).status, 200, 'members may list members');

    await assert.rejects(env.amber.bot.requestClone(id, alice.unionId, { unionId: carol.unionId }), /只有应用的创建人/);
    // Declined: nothing happens.
    await offer(bobC, carol.unionId);
    let card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    assert.match(FakeFeishu.text(card.card), /1 个配置项会一起复制过来/);
    assert.match(FakeFeishu.text(card.card), /API_TOKEN）：不会复制/);
    await env.click(carol, card.id, button(card.card, 'cl_no')!);
    assert.match(JSON.stringify(await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '报表' })), /已经处理过或被取消/);
    assert.equal(env.amber.store.activeByChatName(GROUP, '报表').length, 1);

    // Accepted.
    await offer(bobC, carol.unionId);
    card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'cl_ok')!, { name: '报表' })), /发给别人/);
    const done = await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '报表' });
    assert.match(JSON.stringify(done), /现在是你自己的应用/);
    assert.ok(fake.sent.some(s => s.to.unionId === bob.unionId && /对方已接收/.test(FakeFeishu.text(s.card))));
    const copy = env.amber.store.activeByChatName(GROUP, '报表').find(c => c.ownerUnionId === carol.unionId)!;
    assert.ok(copy && copy.line !== '报表' && copy.id !== id);
    assert.equal(env.amber.store.installOf(copy.id), undefined, 'not an installation: a separate app');
    assert.deepEqual(env.amber.store.configRows(GROUP, copy.line).map(r => [r.name, r.value]), [['repo', 'bob/repo']]);
    assert.deepEqual(env.amber.store.secretRows(GROUP, copy.line), []);
    assert.match((await post(carolC, '/web/api/run', { scope, commandId: copy.id, args: {} })).body.message, /还没设置密钥/);
    await post(carolC, `/web/api/commands/${copy.id}/secrets`, { scope, name: 'API_TOKEN', value: 'carol-token-CCCC' });
    await post(carolC, `/web/api/commands/${copy.id}/config`, { scope, name: 'repo', value: 'carol/repo' });
    assert.equal((await post(carolC, '/web/api/run', { scope, commandId: copy.id, args: {} })).body.markdown, 'repo=carol/repo token=CCCC');
    assert.equal((await post(bobC, '/web/api/run', { scope, commandId: id, args: {} })).body.markdown, 'repo=bob/repo token=AAAA', "bob's own is untouched");

    // A second copy under the same name for carol: refused, unless she renames it.
    await offer(bobC, carol.unionId);
    card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    assert.match(JSON.stringify(await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '报表' })), /已经有一个叫「报表」/);
    assert.match(JSON.stringify(await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '报表二' })), /现在是你自己的应用/);

    // New versions: by claimer, each person's own; without a claimer and several of that name, refused.
    const ctx = { chatId: GROUP, chatType: 'group', submittedBy: 'TestBot', params: PARAMS, script: { ...CODE, code: CODE.code + '\nprint(2)' } };
    assert.match((await env.api('POST', '/v1/drafts', { ...ctx, name: '报表' })).body.message, /好几个叫「报表」/);
    const forCarol = (await env.api('POST', '/v1/drafts', { ...ctx, name: '报表', claimer: carol.email })).body;
    assert.equal(env.amber.store.getMeta(forCarol.id).replaces, copy.id);
    assert.match(JSON.stringify(await env.click(bob, forCarol.claimMessageId, { a: 'claim_try', c: forCarol.id }, { repo: 'x' })), /只有原创建人可以认领/);
    await env.click(carol, forCarol.claimMessageId, { a: 'claim_drop', c: forCarol.id });
    const forBob = (await env.api('POST', '/v1/drafts', { ...ctx, name: '报表', claimer: bob.email })).body;
    assert.equal(env.amber.store.getMeta(forBob.id).replaces, id);
    await env.click(bob, forBob.claimMessageId, { a: 'claim_drop', c: forBob.id });
    // Someone with no 报表 of their own starts a brand-new one, on a line of its own.
    const forAlice = (await env.api('POST', '/v1/drafts', { ...ctx, name: '报表', claimer: alice.email })).body;
    assert.equal(env.amber.store.getMeta(forAlice.id).replaces ?? null, null);
    assert.notEqual(env.amber.store.getCommand(forAlice.id)!.line, '报表');
    assert.match((await env.api('POST', '/v1/drafts', { ...ctx, name: '报表', claimer: alice.email })).body.message, /已有一个版本在认领或审核中/, 'one new app of a name in progress at a time');
  } finally { await env.close(); }
});

test('clone: a changed original, an expired card, and an app in an executor environment', async () => {
  const env = await makeEnv();
  const { fake, bob, carol } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const scope = 'group:' + GROUP;
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '甲', params: [], script: script('print(1)') }, bob);
    const bobC = await login(env, bob);
    await post(bobC, `/web/api/commands/${id}/clone`, { scope, to: carol.unionId });
    let card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    (env.amber.store as any).db.prepare('UPDATE requests SET created_at = ? WHERE kind = ?').run(Date.now() - 8 * 24 * 3600_000, 'clone');
    assert.match(JSON.stringify(await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '甲' })), /超过 7 天/);
    await post(bobC, `/web/api/commands/${id}/clone`, { scope, to: carol.unionId });
    card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    const v2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '甲', params: [], script: script('print(2)'), claimer: bob.email }, bob);
    assert.match(JSON.stringify(await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '甲' })), /已经更新、下线或换了负责人/);
    // An app in an executor environment: the copy runs there too, and the card says so.
    const c = env.amber.store.getCommand(v2)!;
    const withEnv = { ...c, script: { ...c.script, env: 'box/e' } };
    (env.amber.store as any).db.prepare('UPDATE commands SET script_json = ?, spec_hash = ? WHERE id = ?').run(JSON.stringify(withEnv.script), computeSpecHash(withEnv), v2);
    await post(bobC, `/web/api/commands/${v2}/clone`, { scope, to: carol.unionId });
    card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'cl_ok'))!;
    assert.match(FakeFeishu.text(card.card), /执行端环境「box\/e」里运行/);
    await env.click(carol, card.id, button(card.card, 'cl_ok')!, { name: '甲' });
    const copy = env.amber.store.activeByChatName(GROUP, '甲').find(x => x.ownerUnionId === carol.unionId)!;
    assert.equal(copy.script.env, 'box/e');
    // An installation from the Store is not copied around: the other person installs it themselves.
    await env.amber.bot.apps.requestListing(v2, { unionId: bob.unionId, openId: bob.openId }).catch(() => {});
    const iid = await activate(env, { chatId: GROUP, chatType: 'group', name: '乙', params: [], script: script('print(3)') }, bob);
    await env.amber.bot.apps.requestListing(iid, { unionId: bob.unionId, openId: bob.openId });
    await env.approveLatest();
    const app = env.amber.store.listApps().find(a => a.name === '乙')!;
    const ins = await env.amber.bot.apps.install(app.id, { unionId: bob.unionId }, scope, '乙装');
    await assert.rejects(env.amber.bot.requestClone(ins.id, carol.unionId, { unionId: bob.unionId }), /从 Amber Store 装的应用不能复制/);
  } finally { await env.close(); }
});
