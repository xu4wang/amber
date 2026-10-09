// #4 Amber Store, phase 1: list a live command (reviewers approve once), browse, install your own copy anywhere
// you are (no approval), uninstall, delist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { secretVault } from '../src/engine.ts';

const GROUP2 = 'oc_group2';
async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}
const CODE = script('import json,sys\ni=json.load(sys.stdin)\nprint("repo=" + i["params"].get("repo","") + " who=" + i["params"].get("who","") + " token=" + i.get("secrets",{}).get("API_TOKEN","")[-4:])', { secrets: ['API_TOKEN'] });
const PARAMS = [{ name: 'who', label: '对象', type: 'string' }, { name: 'repo', label: '仓库', type: 'string', required: true, scope: 'config' }];

test('store: list once, install anywhere you are, each copy with its own settings; delist stops new installs', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const get = (cookie: string, path: string) => fetch(base + path, { headers: { cookie } }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    fake.chats.set(GROUP2, { mode: 'group', name: '二群', members: new Set(['BOT', carol.unionId]) });
    // bob's live command, with his secret and configuration.
    secretVault()!.set({ chatId: GROUP, name: '检查' }, 'API_TOKEN', 'bob-token-AAAA', bob.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '检查', description: '检查仓库', params: PARAMS, script: CODE, options: { schedulable: true } }, bob, { repo: 'r' });
    env.amber.store.putConfig(GROUP, '检查', 'repo', 'bob/repo', bob.unionId);
    const bobC = await login(env, bob), carolC = await login(env, carol), aliceC = await login(env, alice);
    const scope = 'group:' + GROUP;

    // Listing: only the creator; reviewed in Feishu approval like a command.
    assert.equal((await post(carolC, `/web/api/commands/${id}/publish`, { scope })).status, 404);
    const approvalsBefore = fake.approvals.size;
    const pub = await post(bobC, `/web/api/commands/${id}/publish`, { scope });
    assert.equal(pub.body.ok, true, JSON.stringify(pub.body));
    assert.equal(fake.approvals.size, approvalsBefore + 1);
    const inst = [...fake.approvals.values()].pop()!;
    assert.match(inst.title!, /Amber 上架：检查/);
    assert.match([...fake.docs.values()].pop()!.join('\n'), /上架到 Amber Store/);
    assert.match((await post(bobC, `/web/api/commands/${id}/publish`, { scope })).body.message, /审核中/);
    assert.deepEqual((await get(carolC, '/web/api/store')).body.apps, [], 'not in the Store before approval');
    await env.approveLatest();
    assert.ok(fake.sent.some(s => s.to.unionId === bob.unionId && /已上架：检查/.test(FakeFeishu.text(s.card))));
    assert.match((await post(bobC, `/web/api/commands/${id}/publish`, { scope })).body.message, /已经上架/);
    const bobView = (await get(bobC, '/web/api/overview')).body.groups[0].commands.find((c: any) => c.id === id);
    assert.equal(bobView.listed.status, 'listed');

    // Browsing.
    const st = (await get(carolC, '/web/api/store')).body;
    assert.equal(st.apps.length, 1);
    const app = st.apps[0];
    assert.deepEqual([app.name, app.version, app.description, app.secrets, app.config.map((x: any) => x.name), app.params.map((x: any) => x.name)], ['检查', 1, '检查仓库', ['API_TOKEN'], ['repo'], ['who']]);
    assert.deepEqual(st.targets.map((t: any) => t.target).sort(), ['group:' + GROUP, 'group:' + GROUP2, 'p2p'].sort());
    assert.match((await get(carolC, `/web/api/store/${app.id}/source`)).body.code, /repo=/);

    // carol installs into her other group: live at once, hers alone, nothing of bob's.
    const ins = await post(carolC, `/web/api/store/${app.id}/install`, { target: 'group:' + GROUP2 });
    assert.equal(ins.body.ok, true, JSON.stringify(ins.body));
    assert.deepEqual(ins.body.needs, { config: ['仓库'], secrets: ['API_TOKEN'] });
    const c2 = env.amber.store.getCommand(ins.body.commandId)!;
    assert.deepEqual([c2.status, c2.ownerUnionId, c2.chatId, c2.name], ['active', carol.unionId, GROUP2, '检查']);
    assert.notEqual(c2.line, '检查');
    assert.equal(fake.approvals.size, approvalsBefore + 1, 'no approval to install');
    assert.match((await post(carolC, '/web/api/run', { scope: 'group:' + GROUP2, commandId: c2.id, args: {} })).body.message, /还没设置配置项：仓库/);
    await post(carolC, `/web/api/commands/${c2.id}/config`, { scope: 'group:' + GROUP2, name: 'repo', value: 'carol/repo' });
    assert.match((await post(carolC, '/web/api/run', { scope: 'group:' + GROUP2, commandId: c2.id, args: {} })).body.message, /还没设置密钥/);
    await post(carolC, `/web/api/commands/${c2.id}/secrets`, { scope: 'group:' + GROUP2, name: 'API_TOKEN', value: 'carol-token-CCCC' });
    assert.equal((await post(carolC, '/web/api/run', { scope: 'group:' + GROUP2, commandId: c2.id, args: { who: 'x' } })).body.markdown, 'repo=carol/repo who=x token=CCCC');

    // Into the group where bob's original lives, under the same name: a separate line, separate settings.
    const ins3 = await post(carolC, `/web/api/store/${app.id}/install`, { target: scope });
    assert.equal(ins3.body.ok, true, JSON.stringify(ins3.body));
    const c3 = env.amber.store.getCommand(ins3.body.commandId)!;
    assert.equal(c3.name, '检查');
    assert.match((await post(carolC, `/web/api/store/${app.id}/install`, { target: scope })).body.message, /已经有一条叫「检查」/);
    await post(carolC, `/web/api/commands/${c3.id}/config`, { scope, name: 'repo', value: 'carol/other' });
    assert.deepEqual(env.amber.store.configRows(GROUP, '检查').map(r => r.value), ['bob/repo'], "bob's settings untouched");
    // Each person sees only their own: bob his original, carol her copy.
    await env.say(carol, GROUP, '指令');
    assert.equal((FakeFeishu.text(fake.sent.at(-1)!.card).match(/检查/g) ?? []).length >= 1, true);
    await env.say(bob, GROUP, '检查 b');
    await env.waitFor(() => fake.sent.some(s => /repo=bob\/repo who=b token=AAAA/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    // A new draft named 检查 in this group is a new version of bob's original, never of carol's copy.
    const nv = await env.submit({ chatId: GROUP, chatType: 'group', name: '检查', params: PARAMS, script: CODE });
    assert.match(JSON.stringify(await env.click(carol, nv.claimMessageId, { a: 'claim_try', c: nv.id }, { repo: 'x' })), /只有原创建人可以认领/);
    await env.click(bob, nv.claimMessageId, { a: 'claim_drop', c: nv.id });

    // In a chat where only an installation carries the name, a new draft of that name is a brand-new command.
    const fresh = await env.submit({ chatId: GROUP2, chatType: 'group', name: '检查', params: PARAMS, script: CODE });
    assert.equal(env.amber.store.getMeta(fresh.id).replaces ?? null, null);
    await env.click(carol, fresh.claimMessageId, { a: 'claim_drop', c: fresh.id });

    // Private chat: runs there, and on a schedule, as carol with her own settings.
    const ins4 = await post(carolC, `/web/api/store/${app.id}/install`, { target: 'p2p', name: '我的检查' });
    const c4 = env.amber.store.getCommand(ins4.body.commandId)!;
    assert.equal(c4.scopeType, 'p2p');
    await post(carolC, `/web/api/commands/${c4.id}/config`, { scope: 'p2p', name: 'repo', value: 'carol/p2p' });
    await post(carolC, `/web/api/commands/${c4.id}/secrets`, { scope: 'p2p', name: 'API_TOKEN', value: 'carol-token-PPPP' });
    await env.dm(carol, '我的检查 dm');
    await env.waitFor(() => fake.sent.some(s => /repo=carol\/p2p who=dm token=PPPP/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    const sch = await post(carolC, '/web/api/schedules', { scope: 'p2p', commandId: c4.id, at: '每天 09:00', args: { who: 'sch' } });
    assert.equal(sch.body.ok, true, JSON.stringify(sch.body));
    const before = fake.sent.length;
    await env.amber.bot.scheduler.tick(env.amber.store.getSchedule(sch.body.scheduleId)!.nextRunAt + 1000);
    const out = await env.waitFor(() => fake.sent.slice(before).find(s => s.to.unionId === carol.unionId && /repo=carol\/p2p who=sch token=PPPP/.test(FakeFeishu.text(s.card))));
    assert.ok(out);
    assert.equal((await post(bobC, `/web/api/store/${app.id}/install`, { target: 'group:' + GROUP2 })).status, 403);
    assert.match((await post(carolC, `/web/api/store/${app.id}/install`, { target: 'p2p', name: '有 空格' })).body.message, /不能有空格/);
    // An installation cannot be listed again; nor can a command that runs on an executor.
    assert.match((await post(carolC, `/web/api/commands/${c2.id}/publish`, { scope: 'group:' + GROUP2 })).body.message, /从 Amber Store 安装/);

    // Uninstall = retire: carol's settings go, bob's stay.
    const r = await post(carolC, `/web/api/commands/${c3.id}/retire`, { scope, confirm: true });
    assert.equal(r.body.ok, true);
    assert.deepEqual(env.amber.store.configRows(GROUP, c3.line), []);
    assert.deepEqual(env.amber.store.configRows(GROUP, '检查').map(r => r.value), ['bob/repo']);

    // Delist: the maintainer or an admin; installed copies keep working, no new ones.
    assert.equal((await post(carolC, `/web/api/store/${app.id}/delist`, { confirm: true })).status, 403);
    assert.equal((await post(bobC, `/web/api/store/${app.id}/delist`, { confirm: true })).body.status, 'delisted');
    assert.deepEqual((await get(carolC, '/web/api/store')).body.apps, []);
    assert.equal((await get(aliceC, '/web/api/store')).body.apps[0].status, 'delisted', 'admins still see it');
    assert.match((await post(carolC, `/web/api/store/${app.id}/install`, { target: 'p2p', name: '再装' })).body.message, /已经下架/);
    assert.equal((await post(carolC, '/web/api/run', { scope: 'group:' + GROUP2, commandId: c2.id, args: {} })).body.ok, true);
  } finally { await env.close(); }
});

test('store: commands that run on an executor cannot be listed; a listing whose command changed is not approved', async () => {
  const env = await makeEnv();
  const { bob } = env;
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '本地', params: [], script: script('print(1)') }, bob);
    (env.amber.store as any).db.prepare('UPDATE commands SET script_json = ? WHERE id = ?').run(JSON.stringify({ ...script('print(1)'), env: 'box/e' }), id);
    assert.match(env.amber.bot.apps.whyNotListable(env.amber.store.getCommand(id)!, bob.unionId)!, /执行端环境/);
    const id2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '会变', params: [], script: script('print(1)') }, bob);
    await env.amber.bot.apps.requestListing(id2, { unionId: bob.unionId, openId: bob.openId });
    // A new version goes live while the listing is under review: the listing is not approved.
    await activate(env, { chatId: GROUP, chatType: 'group', name: '会变', params: [], script: script('print(2)') }, bob);
    const code = [...env.fake.approvals.entries()].find(([, a]) => /上架：会变/.test(a.title ?? ''))![0];
    env.fake.decide(code, Object.fromEntries(env.fake.approvals.get(code)!.tasks.map(t => [t.open_id, 'APPROVED' as const])));
    await env.amber.bot.onApprovalEvent(code);
    assert.deepEqual(env.amber.store.listApps(), []);
    assert.ok(env.fake.sent.some(s => s.to.unionId === bob.unionId && /没有上架：会变/.test(FakeFeishu.text(s.card))));
  } finally { await env.close(); }
});

test('store: an app whose version record was tampered with cannot be installed; an old database gets the per-line index', async () => {
  const env = await makeEnv();
  const { bob, carol } = env;
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '甲', params: [], script: script('print(1)') }, bob);
    await env.amber.bot.apps.requestListing(id, { unionId: bob.unionId, openId: bob.openId });
    await env.approveLatest();
    const app = env.amber.store.listApps()[0];
    (env.amber.store as any).db.prepare("UPDATE app_versions SET spec_hash = 'x' WHERE app_id = ?").run(app.id);
    await assert.rejects(env.amber.bot.apps.install(app.id, { unionId: carol.unionId }, 'p2p'), /版本记录不完整/);
  } finally { await env.close(); }
  // A database from before #4: the per-name unique index becomes per-line.
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Store } = await import('../src/db.ts');
  const dir = mkdtempSync(join(tmpdir(), 'amber-mig-'));
  let st = new Store(dir);
  (st as any).db.exec("DROP INDEX commands_active_line; CREATE UNIQUE INDEX commands_active_name ON commands(chat_id, name) WHERE status = 'active';");
  st = new Store(dir);
  const idx = ((st as any).db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'commands'").all() as { name: string }[]).map(r => r.name);
  assert.ok(idx.includes('commands_active_line') && !idx.includes('commands_active_name'), idx.join(','));
  const base = { scopeType: 'group' as const, chatId: 'oc_x', ownerUnionId: 'u1', name: 'n', description: '', params: [], script: script('print(1)') as any, options: { confirm: false, schedulable: true }, status: 'active' as const };
  st.insertCommand(base);
  st.insertCommand({ ...base, ownerUnionId: 'u2', line: 'n#1' });
  assert.throws(() => st.insertCommand({ ...base, ownerUnionId: 'u3' }), /UNIQUE/);
});

test('store: only the creator lists; a listing needs every reviewer; missed approval events are picked up by polling', async () => {
  const env = await makeEnv({ reviewers: ['alice@example.com', 'carol@example.com'] });
  const { bob, carol, fake } = env;
  try {
    await env.amber.bot.flow.loadReviewers();
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '乙', params: [], script: script('print(1)') }, bob);
    await assert.rejects(env.amber.bot.apps.requestListing(id, { unionId: carol.unionId, openId: carol.openId }), /只有指令的创建人/);
    await env.amber.bot.apps.requestListing(id, { unionId: bob.unionId, openId: bob.openId });
    const code = [...fake.approvals.entries()].find(([, a]) => /上架：乙/.test(a.title ?? ''))![0];
    const a = fake.approvals.get(code)!;
    // Marked approved while one reviewer has not approved: not listed.
    a.tasks[0].status = 'APPROVED'; a.status = 'APPROVED';
    await env.amber.bot.pollApprovals();
    assert.deepEqual(env.amber.store.listApps(), []);
    for (const t of a.tasks) t.status = 'APPROVED';
    await env.amber.bot.pollApprovals();
    assert.equal(env.amber.store.listApps().length, 1);
  } finally { await env.close(); }
});
