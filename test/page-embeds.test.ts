// Page embeds: a page shows other pages inside it. The embedded page opts in, the owner confirms the list like apps,
// and each open checks the viewer may open every embedded page (others get a notice); embedded pages call their own apps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { checkFiles, embedsOf, embeddableOf } from '../src/pages.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const file = (path: string, s: string) => ({ path, data: b64(s) });
const files = (json: object) => checkFiles([file('index.html', ''), file('amber.json', JSON.stringify(json))]);

test('page embeds: amber.json declarations', () => {
  assert.equal(embeddableOf(files({})), undefined, 'not embeddable unless it says so');
  assert.deepEqual(embeddableOf(files({ embeddable: true })), { params: [], receive: [], emit: [] });
  assert.deepEqual(embeddableOf(files({ embeddable: { title: '贸易订单', params: ['date', 'date'], receive: ['region'], emit: ['region', 'mch'] } })),
    { title: '贸易订单', params: ['date'], receive: ['region'], emit: ['region', 'mch'] });
  assert.throws(() => embeddableOf(files({ embeddable: { params: ['a b'] } })), /字段名/);
  assert.deepEqual(embedsOf(files({ embeds: [{ page: 'trade', params: { day: 'date' }, receive: true }] })),
    [{ key: 'trade', page: 'trade', title: undefined, params: { day: 'date' }, follow: true, receive: true, emit: false }]);
  assert.throws(() => embedsOf(files({ embeds: [{ page: 'a' }, { page: 'b', key: 'a' }] })), /重复/);
  assert.throws(() => embedsOf(files({ embeds: [{ page: '../x' }] })), /页面 id/);
  assert.throws(() => embedsOf(files({ embeds: [{ page: 'a', params: ['x'] }] })), /params/);
  assert.throws(() => embedsOf(files({ embeds: Array.from({ length: 11 }, (_, i) => ({ page: `p${i}` })) })), /最多 10/);
});

test('page embeds: confirm, per-viewer access, embedded pages call their own apps', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;   // bob owns both pages; carol is another member
  fake.chats.get(GROUP)!.members.add(carol.unionId);
  (env.amber.bot as any).adminUnionIds.delete(alice.unionId);
  const web = `http://127.0.0.1:${env.webPort}`, pages = `http://localhost:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, path: string, body: unknown) => fetch(web + path, { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const publish = (name: string, json: object, html = '<h1>x</h1>') => env.api('POST', '/v1/pages', { chatId: GROUP, chatType: 'group', user: bob.email, label: 'TestBot', name, files: [file('index.html', html), file('amber.json', JSON.stringify(json))] });
  const confirm = async () => { const c = fake.sent.at(-1)!; return { card: c, result: JSON.stringify(await env.click(bob, c.id, button(c.card, 'pg_ok')!)) }; };
  const shellData = async (cookie: string, id: string) => {
    const t = await (await fetch(`${web}/p/${id}/`, { headers: { cookie } })).text();
    const m = /const PAGE = (\{.*\});/.exec(t);
    return m ? JSON.parse(m[1]) : t;
  };
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '订单数', params: [], script: script('import json,sys\ninp=json.load(sys.stdin)\nprint("```json\\n" + json.dumps({"who": inp["caller"]["unionId"]}) + "\\n```")') }, bob);

    // The embedded page, and one that does not allow embedding.
    assert.equal((await publish('trade', { apps: ['订单数'], embeddable: { title: '贸易订单看板', params: ['date', 'currency'], receive: ['region'], emit: ['region'] } })).body.status, 'awaiting');
    await confirm();
    const trade = env.amber.store.pageByName(GROUP, 'trade')!;
    await publish('closed', {});
    await confirm();

    // A page embedding one that did not opt in is not published.
    await publish('overview', { embeds: [{ key: 'c', page: 'closed' }] });
    assert.match((await confirm()).result, /没有在它的 amber\.json 里允许被嵌入/);
    assert.notEqual(env.amber.store.pageByName(GROUP, 'overview')!.status, 'active');

    // The host: the card names the embedded page; the mapping keeps only parameters the embedded page takes.
    const r = await publish('overview', { embeds: [{ key: 'orders', page: 'trade', params: { date: 'month', currency: 'cur', other: 'x' }, receive: true, emit: true }] });
    assert.equal(r.body.status, 'awaiting');
    assert.match(r.body.message, /页面嵌入：trade/);
    const c = await confirm();
    assert.match(FakeFeishu.text(c.card.card), /页面会嵌入这些页面：「trade」/);
    assert.match(c.result, /页面已发布/);
    const host = env.amber.store.pageByName(GROUP, 'overview')!;

    // Content-only updates stay unconfirmed; a changed embed list needs the card again.
    const sent = fake.sent.length;
    assert.equal((await publish('overview', { embeds: [{ key: 'orders', page: 'trade', params: { date: 'month', currency: 'cur', other: 'x' }, receive: true, emit: true }] }, '<h1>v2</h1>')).body.status, 'updated');
    assert.equal(fake.sent.length, sent);
    assert.equal((await publish('overview', { embeds: [{ key: 'orders', page: 'trade', params: { date: 'month' }, receive: true, emit: true }] }, '<h1>v3</h1>')).body.status, 'awaiting');
    await env.click(bob, fake.sent.at(-1)!.id, button(fake.sent.at(-1)!.card, 'pg_no')!);

    // Viewers: the owner gets a link for the embedded page; carol can open the host but not (yet) the embedded page.
    const bobC = await login(bob), carolC = await login(carol);
    const own = await shellData(bobC, host.id);
    const e = own.embeds.orders;
    assert.equal(e.page, trade.id);
    assert.equal(e.title, '贸易订单看板');
    assert.deepEqual(e.params, { date: 'month', currency: 'cur' });
    assert.deepEqual(e.receive, ['region']);
    assert.deepEqual(e.emit, ['region']);
    assert.ok(e.src.startsWith(`${pages}/c/${trade.id}.`));
    assert.equal((await fetch(e.src + 'index.html')).status, 200, 'the embedded page\'s files open with its link');
    const f = await fetch(own.src + 'index.html');
    assert.match(f.headers.get('content-security-policy')!, /frame-src 'self'/);
    assert.match(f.headers.get('content-security-policy')!, /frame-ancestors \S+ 'self'/);

    assert.equal((await post(bobC, `/web/api/pages/${host.id}/access`, { access: 'group' })).body.ok, true);
    const theirs = await shellData(carolC, host.id);
    assert.equal(theirs.embeds.orders.denied, 'forbidden');
    assert.equal(theirs.embeds.orders.src, undefined, 'no link to a page they may not open');
    assert.match(theirs.embeds.orders.message, /没有「trade」的访问权限/);
    assert.equal((await post(carolC, `/web/api/pages/${trade.id}/run`, { app: '订单数', args: {} })).status, 403);

    // Shared with carol: the embedded page runs its own apps as her.
    assert.equal((await post(bobC, `/web/api/pages/${trade.id}/access`, { access: 'group' })).body.ok, true);
    assert.ok((await shellData(carolC, host.id)).embeds.orders.src);
    const run = await post(carolC, `/web/api/pages/${trade.id}/run`, { app: '订单数', args: {} });
    assert.deepEqual(run.body.json, { who: carol.unionId });

    // Opened from the host (打开原页面): a way back for viewers who may open the host; nothing for other pages.
    const viaHost = async (cookie: string, from: string) => JSON.parse(/const PAGE = (\{.*\});/.exec(await (await fetch(`${web}/p/${trade.id}/?from=${from}`, { headers: { cookie } })).text())![1]);
    assert.deepEqual((await viaHost(carolC, host.id)).back, { url: `/p/${host.id}/`, name: 'overview' });
    assert.equal((await viaHost(carolC, trade.id)).back, null, 'not back to itself');
    assert.equal((await viaHost(carolC, 'zzzz')).back, null);
    assert.equal((await post(bobC, `/web/api/pages/${host.id}/access`, { access: 'owner' })).body.ok, true);
    assert.equal((await viaHost(carolC, host.id)).back, null, 'no way back to a page they may not open');

    // The embedded page withdraws: the host shows a notice instead.
    await publish('trade', { apps: ['订单数'] }, '<h1>不再允许</h1>');
    assert.equal((await shellData(bobC, host.id)).embeds.orders.denied, 'not_embeddable');
  } finally { await env.close(); }
});
