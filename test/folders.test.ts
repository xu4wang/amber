// Folders: people file pages and apps under folders on the website ("财务/上账"). Display only: set when publishing
// or submitting, changed on the website by the creator (or an admin); who may open or run something does not change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, button, GROUP } from './env.ts';
import { normFolder, movedPath } from '../src/folder.ts';

const file = (path: string, s: string) => ({ path, data: Buffer.from(s).toString('base64') });

test('folders: normalising', () => {
  assert.equal(normFolder(' 财务 / 上账/ '), '财务/上账');
  assert.equal(normFolder(''), '');
  assert.equal(normFolder(undefined), '');
  assert.equal(normFolder('//'), '');
  assert.throws(() => normFolder('a/b/c/d'), /最多 3 层/);
  assert.throws(() => normFolder('x'.repeat(21)), /最多 20 个字/);
  assert.throws(() => normFolder('a\\b'), /反斜杠/);
  assert.throws(() => normFolder(3), /文字/);
  assert.equal(movedPath('财务/上账/明细', '财务/上账', '财务/结算'), '财务/结算/明细');
  assert.equal(movedPath('财务/上账', '财务/上账', '财务'), '财务');
  assert.equal(movedPath('财务/上账明细', '财务/上账', '财务'), '财务/上账明细', 'a name that only starts the same is another folder');
  assert.equal(movedPath('财务', '财务', ''), '');
});

test('folders: set when publishing or submitting, moved on the website by the creator only', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;   // bob owns everything; carol is another member; alice is an admin
  fake.chats.get(GROUP)!.members.add(carol.unionId);
  const web = `http://127.0.0.1:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, path: string, body: unknown) => fetch(web + path, { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const overview = async (cookie: string) => (await fetch(`${web}/web/api/overview`, { headers: { cookie } })).json();
  const publish = (name: string, extra: object = {}) => env.api('POST', '/v1/pages', { chatId: GROUP, chatType: 'group', user: bob.email, label: 'TestBot', name, files: [file('index.html', '<h1>x</h1>'), file('amber.json', '{}')], ...extra });
  try {
    // A page filed when it is first published; a content update without --folder keeps it there, with one moves it.
    assert.equal((await publish('settle', { folder: ' 财务 /上账 ' })).body.status, 'awaiting');
    const c = fake.sent.at(-1)!;
    await env.click(bob, c.id, button(c.card, 'pg_ok')!);
    const page = env.amber.store.pageByName(GROUP, 'settle')!;
    const bobC = await login(bob), carolC = await login(carol), aliceC = await login(alice);
    const pageIn = async (cookie: string) => (await overview(cookie)).groups.find((g: any) => g.chatId === GROUP).pages.find((p: any) => p.id === page.id);
    assert.equal((await pageIn(bobC)).folder, '财务/上账');
    assert.equal((await publish('settle')).body.status, 'updated');
    assert.equal((await pageIn(bobC)).folder, '财务/上账', 'an update without a folder keeps it');
    await publish('settle', { folder: '运营' });
    assert.equal((await pageIn(bobC)).folder, '运营');
    assert.equal((await publish('bad', { folder: 'a/b/c/d' })).body.error, 'bad_folder');

    // On the website: the creator moves it; another member cannot; an admin can.
    assert.equal((await post(bobC, `/web/api/pages/${page.id}/folder`, { folder: '财务/日报' })).body.folder, '财务/日报');
    assert.equal((await post(carolC, `/web/api/pages/${page.id}/folder`, { folder: 'x' })).status, 403);
    assert.equal((await post(aliceC, `/web/api/pages/${page.id}/folder`, { folder: '' })).body.ok, true);
    assert.equal((await pageIn(bobC)).folder, '', 'cleared: back to the top level');
    assert.equal(env.amber.store.getPage(page.id)!.access, 'owner', 'filing changes nothing about who may open it');

    // A new app filed when it is submitted; its new version stays where its owner filed it.
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '上账日报', params: [], script: script('print("ok")'), folder: '财务' }, bob);
    const appIn = async (cookie: string, cid: string) => (await overview(cookie)).groups.find((g: any) => g.chatId === GROUP)?.commands.find((x: any) => x.id === cid);
    assert.equal((await appIn(bobC, id)).folder, '财务');
    assert.equal((await post(bobC, `/web/api/commands/${id}/folder`, { scope: 'group:' + GROUP, folder: '财务/日报' })).body.folder, '财务/日报');
    assert.equal((await post(carolC, `/web/api/commands/${id}/folder`, { scope: 'group:' + GROUP, folder: 'x' })).body.ok, false);
    const v2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '上账日报', params: [], script: script('print("v2")'), folder: '别处' }, bob);
    assert.notEqual(v2, id);
    assert.equal((await appIn(bobC, v2)).folder, '财务/日报', 'versions share the folder; a new version does not move it');
    assert.equal((await appIn(carolC, v2)), undefined, 'others still do not see bob\'s app');
  } finally { await env.close?.(); }
});

test('folders: 目录管理 makes, renames and removes folders in a group (admins only)', async () => {
  const env = await makeEnv();
  const { fake, alice, bob } = env;   // alice is an admin
  const web = `http://127.0.0.1:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, body: unknown) => fetch(web + '/web/api/folders', { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const group = async (cookie: string) => (await (await fetch(`${web}/web/api/overview`, { headers: { cookie } })).json()).groups.find((g: any) => g.chatId === GROUP);
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '上账日报', params: [], script: script('print("ok")'), folder: '财务/上账/明细' }, bob);
    const aliceC = await login(alice), bobC = await login(bob);
    assert.equal((await post(bobC, { chatId: GROUP, op: 'add', path: '运营' })).status, 403, 'only admins');

    // Made folders show while empty.
    assert.equal((await post(aliceC, { chatId: GROUP, op: 'add', path: '财务/上账/对账' })).body.ok, true);
    assert.deepEqual((await group(aliceC)).dirs, ['财务/上账/对账']);
    assert.equal((await post(aliceC, { chatId: GROUP, op: 'add', path: 'a/b/c/d' })).body.error, 'bad_folder');

    // Renaming a level moves everything under it, made folders included.
    const r = await post(aliceC, { chatId: GROUP, op: 'rename', path: '财务/上账', name: '结算' });
    assert.deepEqual([r.body.path, r.body.moved], ['财务/结算', 1]);
    assert.equal((await group(aliceC)).commands.find((c: any) => c.id === id).folder, '财务/结算/明细');
    assert.deepEqual((await group(aliceC)).dirs, ['财务/结算/对账']);
    assert.equal((await post(aliceC, { chatId: GROUP, op: 'rename', path: '财务', name: 'x/y' })).body.error, 'bad_folder');

    // Removing a folder moves what is in it up a level; nothing is deleted.
    assert.equal((await post(aliceC, { chatId: GROUP, op: 'delete', path: '财务/结算' })).body.path, '财务');
    const g = await group(aliceC);
    assert.equal(g.commands.find((c: any) => c.id === id).folder, '财务/明细');
    assert.deepEqual(g.dirs, ['财务/对账']);
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
  } finally { await env.close?.(); }
});
