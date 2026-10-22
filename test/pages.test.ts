// Page apps: an agent publishes a directory; the owner confirms new pages and new apps; the owner decides who in the
// group may open it; viewers call the bound apps as themselves; files come from a separate origin behind signed links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, activate, script, urlButton, button, GROUP, claimsService, callForClaims } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { checkFiles, appsOf, outputBlocks } from '../src/pages.ts';
import { markdownWithCharts } from '../src/cards.ts';
import { secretVault } from '../src/engine.ts';

const b64 = (s: string) => Buffer.from(s).toString('base64');
const file = (path: string, s: string) => ({ path, data: b64(s) });

test('pages: file lists, amber.json and output blocks', () => {
  assert.throws(() => checkFiles([file('a.html', 'x')]), /index\.html/);
  for (const bad of ['../index.html', '.env', 'a/../../b.html', '/etc/x.html', 'a\\b.html', 'x.exe', 'a//b.html']) assert.throws(() => checkFiles([file('index.html', ''), file(bad, 'x')]), /文件名不对|不支持/, bad);
  assert.throws(() => checkFiles([file('index.html', ''), file('index.html', '')]), /重复/);
  assert.throws(() => checkFiles(Array.from({ length: 201 }, (_, i) => file(i ? `f${i}.txt` : 'index.html', ''))), /最多 200/);
  assert.throws(() => checkFiles([file('index.html', 'x'.repeat(10 * 1024 * 1024 + 1))]), /10MB/);
  assert.equal(checkFiles([file('index.html', '<h1>x</h1>'), file('js/app.js', '1')]).length, 2);
  assert.deepEqual(appsOf(checkFiles([file('index.html', ''), file('amber.json', '{"apps":["查数"," 查数 ","写文档"]}')])), ['查数', '写文档']);
  assert.throws(() => appsOf(checkFiles([file('index.html', ''), file('amber.json', '{"apps":"x"}')])), /apps/);
  const o = outputBlocks('# 标题\n```table\n{"columns":[{"name":"a"}],"rows":[{"a":1}]}\n```\n说明\n```json\n{"n":3}\n```\n```vega-lite\n{"mark":"bar"}\n```');
  assert.deepEqual(o.blocks.map(b => b.kind), ['markdown', 'table', 'markdown', 'json', 'chart']);
  assert.deepEqual(o.json, { n: 3 });
  // ```json is data for pages: cards don't show it.
  assert.deepEqual(markdownWithCharts('前\n```json\n{"secretish":1}\n```\n后'), [{ tag: 'markdown', content: '前' }, { tag: 'markdown', content: '后' }]);
});

test('pages: publish with confirmation, access, calls as the viewer, signed files on their own origin', async () => {
  const svc = await claimsService();
  const env = await makeEnv({ services: { demo: { audience: 'demo', tcpPort: svc.port } } });
  const { fake, alice, bob, carol } = env;   // bob owns the page; carol and alice are other members
  fake.chats.get(GROUP)!.members.add(carol.unionId);
  const web = `http://127.0.0.1:${env.webPort}`, pages = `http://localhost:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, path: string, body: unknown) => fetch(web + path, { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const publish = (files: unknown[], name = 'report') => env.api('POST', '/v1/pages', { chatId: GROUP, chatType: 'group', user: bob.email, label: 'TestBot', name, files });
  try {
    const who = 'import json,sys\ninp=json.load(sys.stdin)\nprint("查到了")\nprint("```json\\n" + json.dumps({"who": inp["caller"]["unionId"], "channel": inp["caller"]["channel"]}) + "\\n```")';
    await activate(env, { chatId: GROUP, chatType: 'group', name: '查数', params: [{ name: 'n', type: 'integer', default: '1' }], script: script(who) }, bob);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '写文档', params: [], script: script('print("写好了")'), options: { confirm: true } }, bob);
    secretVault()!.set({ chatId: GROUP, name: '带密钥' }, 'API_TOKEN', 'bob-token', bob.unionId);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '带密钥', params: [], script: script('print("用了密钥")', { secrets: ['API_TOKEN'] }) }, bob);
    // Shows the channel in its identity token: services only know the documented ones, so a page call says "web".
    const claim = callForClaims('demo') + 'print("claim=" + c["channel"])';
    await activate(env, { chatId: GROUP, chatType: 'group', name: '查服务', params: [], script: script(claim, { services: { demo: { calls: 1 } } }) }, bob);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '没绑定', params: [], script: script('print(1)') }, bob);

    // Screenshots for the card: the stand-in browser fetches what a real one would, from the page origin.
    const shots: { path: string; status: number; body: string }[] = [];
    (env.amber.bot as any).pages.shoot = async (path: string) => {
      const r = await fetch(pages + path + 'index.html');
      const body = await r.text();
      shots.push({ path, status: r.status, body });
      return r.ok ? Buffer.from('PNG' + body) : undefined;
    };

    // 1. Publish: a new page waits for the owner's confirmation.
    const index = '<!doctype html><script src="/sdk/amber-page.js"></script><h1>报表</h1>';
    assert.ok(!existsSync(join(env.cfg.dataDir, 'pages', 'x')));
    const r1 = await publish([file('index.html', index), file('amber.json', '{"apps":["查数","写文档","带密钥","查服务"]}'), file('js/app.js', 'console.log(1)')]);
    assert.equal(r1.body.status, 'awaiting', JSON.stringify(r1.body));
    const id = r1.body.pageId;
    const card = fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(card.card), /查数/);
    assert.ok(button(card.card, 'pg_ok'));
    // The card shows a screenshot of the upload waiting for confirmation.
    assert.equal(shots.length, 1);
    assert.equal(shots[0].status, 200);
    assert.match(shots[0].body, /报表/);
    const img = JSON.stringify(card.card).match(/"img_key":"([^"]+)"/);
    assert.ok(img, 'an image on the card');
    assert.match(String(fake.images.get(img![1])), /报表/);
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'pg_ok')!)), /只有页面的创建人/);
    const ok: any = await env.click(bob, card.id, button(card.card, 'pg_ok')!);
    assert.match(JSON.stringify(ok), /页面已发布/);
    assert.match(JSON.stringify(ok), new RegExp(`/p/${id}/`), 'the card opens the page');
    // The screenshot's link only ever showed the upload while it waited.
    assert.equal((await fetch(pages + shots[0].path + 'index.html')).status, 404, 'a preview link does not open the live page');
    const p = env.amber.store.getPage(id)!;
    assert.equal(p.status, 'active');
    assert.deepEqual(p.apps.map(a => a.name), ['查数', '写文档', '带密钥', '查服务']);
    assert.equal(p.access, 'owner', 'only the owner by default');
    // Someone else's name clashes.
    const clash = await env.api('POST', '/v1/pages', { chatId: GROUP, chatType: 'group', user: carol.email, name: 'report', files: [file('index.html', 'x')] });
    assert.equal(clash.body.ok, false);
    assert.match(clash.body.message, /别人的页面/);

    // 2. A content-only update takes effect at once; a new app needs confirming again.
    const sentBefore = fake.sent.length;
    const r2 = await publish([file('index.html', index + '<p>v2</p>'), file('amber.json', '{"apps":["带密钥","查数","写文档","查服务"]}')]);
    assert.equal(r2.body.status, 'updated');
    assert.equal(fake.sent.length, sentBefore, 'no card for a content update');
    const r3 = await publish([file('index.html', index), file('amber.json', '{"apps":["查数","写文档","带密钥","查服务","没绑定"]}')]);
    assert.equal(r3.body.status, 'awaiting');
    assert.deepEqual(env.amber.store.getPage(id)!.apps.length, 4, 'until confirmed, the old apps stay');
    const c3 = fake.sent.at(-1)!;
    // Uploaded again before anyone clicked: the older card no longer approves anything.
    await publish([file('index.html', index + '<p>其他</p>'), file('amber.json', '{"apps":["查数","写文档","带密钥","查服务","没绑定"]}')]);
    const c3b = fake.sent.at(-1)!;
    assert.notEqual(c3b.id, c3.id);
    assert.match(JSON.stringify(await env.click(bob, c3.id, button(c3.card, 'pg_ok')!)), /新的版本/);
    assert.deepEqual(env.amber.store.getPage(id)!.apps.length, 4);
    await env.click(bob, c3b.id, button(c3b.card, 'pg_no')!);
    assert.equal(env.amber.store.getPage(id)!.status, 'active', 'canceling an update keeps the page');
    assert.equal(env.amber.store.getPage(id)!.pending, null);
    // An app the owner cannot use: confirming does not publish.
    const r4 = await publish([file('index.html', index), file('amber.json', '{"apps":["不存在的应用"]}')], 'gone');
    assert.match(JSON.stringify(await env.click(bob, fake.sent.at(-1)!.id, button(fake.sent.at(-1)!.card, 'pg_ok')!)), /找不到你能用的应用/);
    assert.notEqual(env.amber.store.getPage(r4.body.pageId)!.status, 'active');

    // 3. Who may open it. (alice is an admin; admins are checked separately below.)
    const bot = env.amber.bot as any;
    bot.adminUnionIds.delete(alice.unionId);
    const bobC = await login(bob), carolC = await login(carol), aliceC = await login(alice);
    const shell = async (cookie: string) => { const r = await fetch(`${web}/p/${id}/`, { headers: { cookie } }); return { status: r.status, text: await r.text(), csp: r.headers.get('content-security-policy') }; };
    const own = await shell(bobC);
    assert.match(own.text, new RegExp(`${pages}/c/`), 'the owner gets the frame');
    assert.match(own.csp ?? '', new RegExp(`frame-src ${pages}`));
    assert.match((await shell(carolC)).text, /打不开这个页面/);
    assert.match((await (await fetch(`${web}/p/${id}/`)).text()), /请先登录/);
    assert.equal((await post(carolC, `/web/api/pages/${id}/access`, { access: 'group' })).status, 403, 'only the owner sets access');
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'members', members: [] })).body.ok, false, 'members needs someone');
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'members', members: [carol.unionId] })).body.ok, true);
    assert.match((await shell(carolC)).text, /\/c\//, 'a chosen member opens it');
    assert.match((await shell(aliceC)).text, /打不开这个页面/, 'others still cannot');
    // 「私聊我免登录链接」: a one-time link in the clicker's private chat that logs them in and opens the page.
    const openBtn = button(ok, 'pg_open')!;
    assert.match(JSON.stringify(ok), /私聊我免登录链接/, 'the label the login note points to');
    assert.match(JSON.stringify(await env.click(alice, card.id, openBtn)), /没有这个页面的访问权限/);
    const before = fake.sent.length;
    assert.match(JSON.stringify(await env.click(carol, card.id, openBtn)), /已私聊发给你/);
    const dm = fake.sent.slice(before);
    assert.equal(dm.length, 1);
    assert.deepEqual(dm[0].to, { unionId: carol.unionId }, 'only to the clicker, never the group');
    const link = urlButton(dm[0].card)!;
    const landed = await fetch(link, { redirect: 'manual' });
    assert.equal(landed.status, 302);
    assert.equal(landed.headers.get('location'), `/p/${id}/`, 'lands on the page');
    const viaLink = landed.headers.get('set-cookie')!.split(';')[0];
    assert.match((await shell(viaLink)).text, /\/c\//, 'logged in, the page opens');
    assert.equal((await fetch(link, { redirect: 'manual' })).status, 400, 'the link works once');
    assert.ok(env.amber.store.listAudit({ prefixes: ['web.'], limit: 20 }).some(a => a.action === 'web.login_link' && a.actor === carol.unionId && JSON.parse(a.detail).page === id));
    // An admin opens any page, as themselves, on record; the owner's secrets stay the owner's.
    bot.adminUnionIds.add(alice.unionId);
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'owner' })).body.ok, true);
    assert.match((await shell(carolC)).text, /打不开这个页面/);
    assert.match((await shell(aliceC)).text, /\/c\//, 'an admin opens a page not shared with them');
    const adminOpens = env.amber.store.listAudit({ prefixes: ['page.admin_open'], limit: 5 });
    assert.equal(adminOpens.length, 1); assert.equal(adminOpens[0].actor, alice.unionId); assert.equal(JSON.parse(adminOpens[0].detail).owner, bob.unionId);
    const asAdmin = await post(aliceC, `/web/api/pages/${id}/run`, { app: '查数', args: {} });
    assert.deepEqual(asAdmin.body.json, { who: alice.unionId, channel: 'page' }, 'runs as the admin');
    assert.match((await post(aliceC, `/web/api/pages/${id}/run`, { app: '带密钥', args: {} })).body.message, /只有页面创建人/);
    assert.equal((await post(aliceC, `/web/api/pages/${id}/access`, { access: 'group' })).status, 403, 'an admin still cannot change who it is shared with');
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'group' })).body.ok, true);
    assert.match((await shell(aliceC)).text, /\/c\//, 'everyone in the group');
    assert.equal(env.amber.store.listAudit({ prefixes: ['page.admin_open'], limit: 5 }).length, 1, 'shared with them: an ordinary open');

    // 4. Calls run as the viewer; only bound apps; the owner's secrets stay the owner's; confirm apps need confirming.
    const call = (cookie: string, app: string, extra: object = {}) => post(cookie, `/web/api/pages/${id}/run`, { app, args: {}, ...extra });
    const c1 = await call(carolC, '查数');
    assert.equal(c1.body.ok, true, JSON.stringify(c1.body));
    assert.deepEqual(c1.body.json, { who: carol.unionId, channel: 'page' }, 'the viewer\'s identity');
    assert.ok(c1.body.blocks.some((b: any) => b.kind === 'markdown'));
    assert.match((await call(carolC, '没绑定')).body.message, /amber\.json 里没有/);
    assert.match((await call(carolC, '带密钥')).body.message, /只有页面创建人/);
    assert.equal((await call(bobC, '带密钥')).body.ok, true, 'the owner may');
    assert.equal((await call(carolC, '写文档')).body.error, 'needs_confirm');
    assert.equal((await call(carolC, '写文档', { confirm: true })).body.ok, true);
    const sv = await call(carolC, '查服务');
    assert.match(sv.body.markdown, /claim=web/, JSON.stringify(sv.body));
    assert.equal(env.amber.store.getRun(sv.body.runId)!.channel, 'page', 'Amber\'s own record still says page');
    // An app that changed hands is no longer the page owner's to lend.
    const bound = env.amber.store.getPage(id)!.apps.find(a => a.name === '查数')!;
    env.amber.store.setMeta(bound.commandId, { ownerUnionId: alice.unionId });
    assert.match((await call(carolC, '查数')).body.message, /已经不属于/);
    env.amber.store.setMeta(bound.commandId, { ownerUnionId: bob.unionId });
    // A private chat's page is the owner's alone, whatever its row says.
    const pg = (env.amber.bot as any).pages;
    assert.equal(await pg.canView({ ...env.amber.store.getPage(id)!, chatType: 'p2p', access: 'group' }, carol.unionId), false);
    // Leaving the group ends access at once.
    fake.chats.get(GROUP)!.members.delete(carol.unionId);
    (env.amber.bot as any).memberCache.delete(GROUP);
    assert.equal((await call(carolC, '查数')).status, 403);
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    (env.amber.bot as any).memberCache.delete(GROUP);

    // 5. Files: only on the page origin, only with a valid link, with the locked-down policy.
    const src = /"src":"([^"]+)"/.exec(own.text)![1];
    const f = await fetch(src + 'index.html');
    assert.equal(f.status, 200);
    assert.match(await f.text(), /v2/, 'the live version');
    const csp = f.headers.get('content-security-policy')!;
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, new RegExp(`frame-ancestors ${web}`));
    assert.match(csp, /form-action 'none'/);
    assert.equal(f.headers.get('x-frame-options'), null, 'framable by Amber (frame-ancestors decides)');
    assert.equal((await fetch(src + 'js/app.js')).status, 404, 'files of an older upload are gone');
    assert.equal((await fetch(src.replace(/.{4}\/$/, 'AAAA/') + 'index.html')).status, 404, 'a tampered link');
    assert.equal((await fetch(src + '%2e%2e/%2e%2e/amber.db')).status, 404);
    const token = /\/c\/([^/]+)\//.exec(src)![1];
    assert.ok(await pg.file(token, 'index.html'));
    assert.equal(await pg.file(token, `../v${env.amber.store.getPage(id)!.version}/index.html`), undefined, 'no climbing out of the version folder');
    const now = Date.now;
    try { Date.now = () => now() + 7 * 3600_000; assert.equal(await pg.file(token, 'index.html'), undefined, 'links expire'); } finally { Date.now = now; }
    // A link handed to someone stops working as soon as they may no longer open the page.
    const carolSrc = /"src":"([^"]+)"/.exec((await shell(carolC)).text)![1];
    assert.equal((await fetch(carolSrc + 'index.html')).status, 200);
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'owner' })).body.ok, true);
    assert.equal((await fetch(carolSrc + 'index.html')).status, 404, 'access taken back');
    assert.equal((await fetch(src + 'index.html')).status, 200, 'the owner\'s link still works');
    assert.equal((await post(bobC, `/web/api/pages/${id}/access`, { access: 'group' })).body.ok, true);
    assert.equal((await fetch(`${pages}/web/api/me`, { headers: { cookie: bobC } })).status, 404, 'no Amber API on the page origin');
    const sdk = await (await fetch(`${pages}/sdk/amber-page.js`)).text();
    assert.ok(sdk.includes(JSON.stringify(web)), 'the SDK only talks to Amber');
    assert.notEqual((await fetch(`${web}${new URL(src).pathname}index.html`)).headers.get('content-type'), 'text/html; charset=utf-8', 'page files never come from Amber\'s origin');

    // 6. Usage: each call through the page carries its id; opens are counted once per person every 30 minutes.
    assert.deepEqual(env.amber.store.pageRuns(id, 10).map(r => r.app).sort(), ['写文档', '带密钥', '查数', '查数', '查服务'].sort(), 'calls refused before running are not runs (one 查数 is the admin\'s)');
    assert.ok(env.amber.store.pageRuns(id, 10).some(r => r.id === sv.body.runId));
    assert.ok(env.amber.store.listAudit({ prefixes: ['run.'], limit: 50 }).some(a => a.action === 'run.start' && JSON.parse(a.detail).runId === sv.body.runId && JSON.parse(a.detail).pageId === id));
    const opens = env.amber.store.listAudit({ prefixes: ['page.open'], limit: 50 });
    assert.deepEqual(opens.map(a => a.actor).sort(), [alice.unionId, bob.unionId, carol.unionId].sort(), 'once each though opened again and again; refused opens are not opens');
    const usageOf = (cookie: string) => fetch(`${web}/web/api/pages/${id}/usage`, { headers: { cookie } }).then(async x => ({ status: x.status, body: await x.json() }));
    const mine = await usageOf(bobC);
    assert.deepEqual(mine.body.usage, { ...mine.body.usage, calls: 5, ok: 5, failed: 0, callers: 3, opens: 3, openers: 3 }, JSON.stringify(mine.body.usage));
    assert.equal(mine.body.runs.length, 5);
    assert.ok(mine.body.runs.every((r: any) => typeof r.caller === 'string' && r.caller));
    assert.equal(mine.body.openers.length, 3);
    assert.equal((await usageOf(carolC)).status, 404, 'a viewer does not see who else used it');
    assert.equal((await usageOf(aliceC)).status, 200, 'an admin does');
    const adminOv = await (await fetch(`${web}/web/api/overview`, { headers: { cookie: aliceC } })).json();
    const all = adminOv.allPages.find((x: any) => x.id === id);
    assert.equal(all.usage.calls, 5, 'admins see every page with its usage');
    assert.equal(all.where, 'group:' + GROUP);
    assert.ok(all.owner);

    // 7. Listed on the website for the people it is shared with; deleted by the owner.
    const ov = await (await fetch(`${web}/web/api/overview`, { headers: { cookie: carolC } })).json();
    assert.equal(ov.allPages, undefined, 'the all-pages list is for admins');
    const listed = ov.groups.find((g: any) => g.chatId === GROUP).pages;
    assert.deepEqual(listed.map((x: any) => x.name), ['report']);
    assert.equal(listed[0].access, undefined, 'who may open it: shown to the owner only');
    assert.equal(listed[0].usage, undefined, 'and so is its usage');
    assert.equal((await post(carolC, `/web/api/pages/${id}/delete`, {})).status, 403);
    assert.equal((await post(bobC, `/web/api/pages/${id}/delete`, {})).body.ok, true);
    assert.match((await shell(bobC)).text, /打不开这个页面/);
    assert.equal((await fetch(src + 'index.html')).status, 404);
    assert.ok(existsSync(join(env.cfg.dataDir, 'pages')), 'the pages folder');
    assert.ok(!existsSync(join(env.cfg.dataDir, 'pages', id)), 'its files are gone');
    assert.ok(env.amber.store.listAudit({ prefixes: ['page.'], limit: 50 }).some(a => a.action === 'page.call'));
  } finally { await env.close(); svc.close(); }
});

test('pages: refuse to serve pages from Amber\'s own host', async () => {
  await assert.rejects(makeEnv({ webBaseUrl: 'http://amber.test', pagesBaseUrl: 'http://amber.test/' }), /different host/);
});

test('pages: runs from before page ids are matched to their page once', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { Store } = await import('../src/db.ts');
  const dir = mkdtempSync(join(tmpdir(), 'amber-pgmig-'));
  let st = new Store(dir);
  const db = (st as any).db;
  db.exec('DROP INDEX runs_page; ALTER TABLE runs DROP COLUMN page_id');
  const t = 1_800_000_000_000;
  const run = (id: string, cmd: string, who: string, channel: string, at: number) => db.prepare(`INSERT INTO runs (id, command_id, spec_hash, channel, caller_union_id, chat_id, args_json, status, started_at) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, cmd, 'h', channel, who, 'oc_x', '{}', 'ok', at);
  const call = (page: string, cmd: string, who: string, at: number) => db.prepare('INSERT INTO audit (at, actor_union_id, action, detail) VALUES (?,?,?,?)').run(at, who, 'page.call', JSON.stringify({ id: page, commandId: cmd }));
  call('aaaaaaaa', 'c1', 'u1', t); run('r1', 'c1', 'u1', 'page', t + 20);
  call('bbbbbbbb', 'c1', 'u1', t + 3_000); run('r2', 'c1', 'u1', 'page', t + 3_050);     // both calls are close: the later one
  call('aaaaaaaa', 'c2', 'u2', t); run('r3', 'c2', 'u1', 'page', t + 20);               // someone else's call
  run('r4', 'c1', 'u1', 'web', t + 30);                                                    // not through a page
  call('aaaaaaaa', 'c3', 'u1', t); run('r5', 'c3', 'u1', 'page', t + 30_000);            // too long after
  st = new Store(dir);
  const pageOf = (id: string) => ((st as any).db.prepare('SELECT page_id FROM runs WHERE id = ?').get(id) as { page_id: string | null }).page_id;
  assert.deepEqual(['r1', 'r2', 'r3', 'r4', 'r5'].map(pageOf), ['aaaaaaaa', 'bbbbbbbb', null, null, null]);
  assert.equal(st.pageUsage().get('aaaaaaaa')!.calls, 1);
});
