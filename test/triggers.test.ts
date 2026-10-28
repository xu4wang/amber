// Triggers: events in Amber become notices — in the owner's private chat, or in a group @-ing a bot — for the people
// who may know about them, confirmed by the owner, rate limited, retried, and managed on the website.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { emitEvent } from '../src/events.ts';

test('triggers: who may subscribe, confirmation, notices for reviewers and owners, @ a bot in a group', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;   // alice: reviewer and admin; bob: makes apps; carol: neither
  fake.chats.get(GROUP)!.members.add(carol.unionId);
  fake.chatBots.set(GROUP, [{ name: 'Beta', openId: 'ou_beta' }]);
  const web = `http://127.0.0.1:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, path: string, body: unknown) => fetch(web + path, { method: 'POST', headers: { cookie, origin: web, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const ask = (u: any, body: object) => env.api('POST', '/v1/triggers', { chatId: GROUP, chatType: 'group', user: u.email, label: 'TestBot', ...body });
  const triggers = (env.amber.bot as any).triggers;
  try {
    const chashu = await activate(env, { chatId: GROUP, chatType: 'group', name: '查数', params: [], script: script('print("ok")') }, bob);
    // --app of a global app, asked from somewhere else: the trigger names the app by where it belongs.
    env.amber.store.setGlobal(chashu, true);
    fake.chats.set('oc_carolgroup', { mode: 'group', name: 'carol 的群', members: new Set(['BOT', carol.unionId]) });
    const g = await env.api('POST', '/v1/triggers', { chatId: 'oc_carolgroup', chatType: 'group', user: carol.email, label: 'TestBot', on: 'run.failed', app: '查数' });
    assert.ok(g.body.triggerId, JSON.stringify(g.body));
    assert.equal(env.amber.store.getTrigger(g.body.triggerId)!.filter.chatId, GROUP);
    // Named the way events name it: the app's line (a renamed or Store-installed app keeps its line).
    (env.amber.store as any).db.prepare('UPDATE commands SET line = ? WHERE id = ?').run('查数线', chashu);
    const g2 = await env.api('POST', '/v1/triggers', { chatId: 'oc_carolgroup', chatType: 'group', user: carol.email, label: 'TestBot', on: 'run.failed', app: '查数' });
    assert.deepEqual(env.amber.store.getTrigger(g2.body.triggerId)!.filter, { app: '查数线', chatId: GROUP });
    (env.amber.store as any).db.prepare('UPDATE commands SET line = NULL WHERE id = ?').run(chashu);
    env.amber.store.setGlobal(chashu, false);

    // 1. Everyone's app events are for reviewers and admins; others only their own apps.
    assert.match((await ask(carol, { on: 'app.review_started' })).body.message, /只有审核人和管理员/);
    assert.match((await ask(carol, { on: 'app.review_started', app: '查数' })).body.message, /不是你在这个会话里的应用/);
    assert.match((await ask(carol, { on: 'executor.offline' })).body.message, /只有管理员/);
    assert.match((await ask(alice, { on: 'nonsense' })).body.message, /不认识的事件/);
    assert.equal((await env.api('POST', '/v1/triggers', { chatId: GROUP, chatType: 'group', on: 'run.failed' })).body.error, 'user_required', 'whose trigger it is must be named');
    assert.match((await ask(alice, { on: 'app.review_started', to: 'here', mention: 'Nobody' })).body.message, /群里没有叫「Nobody」的机器人.*Beta/);
    assert.match((await ask(alice, { on: 'app.review_started', mention: 'Beta' })).body.message, /只有发到群里时才能/);

    // 2. A reviewer asks for review notices in this group, @-ing Beta; only she can confirm.
    const r = await ask(alice, { on: 'app.review_started', to: 'here', mention: 'Beta', name: '预审' });
    assert.equal(r.body.status, 'awaiting', JSON.stringify(r.body));
    const card = fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(card.card), /应用提交审核/);
    assert.match(JSON.stringify(await env.click(bob, card.id, button(card.card, 'tg_ok')!)), /只有触发器的主人/);
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'tg_ok')!)), /触发器已生效/);
    assert.equal(env.amber.store.getTrigger(r.body.triggerId)!.status, 'active');

    // 3. bob submits a new app for review: the notice goes to the group, @Beta, with ids an agent can use.
    const before = fake.sent.length;
    const d = await env.submit({ chatId: GROUP, chatType: 'group', name: '新应用', params: [], script: script('print("new")') });
    await env.click(bob, d.claimMessageId, { a: 'claim_try', c: d.id });
    await env.waitFor(() => button(fake.cardOf(d.claimMessageId), 'claim_submit'));
    await env.click(bob, d.claimMessageId, { a: 'claim_submit', c: d.id });
    const notice = await env.waitFor(() => fake.sent.slice(before).find(m => JSON.stringify(m.card).includes('amber-event app.review_started')));
    assert.deepEqual(notice.to, { chatId: GROUP });
    assert.match(JSON.stringify(notice.card), /<at id=ou_beta><\/at>/);
    assert.match(JSON.stringify(notice.card), new RegExp(`command=${d.id}`));
    assert.match(FakeFeishu.text(notice.card), /「新应用」已提交审核/);

    // 4. bob, on the website, wants to hear when his app is approved; it comes to his private chat.
    const bobC = await login(bob);
    assert.equal((await post(bobC, '/web/api/triggers', { on: 'app.approved', app: '新应用', appChatId: GROUP })).body.ok, true);
    const list = await (await fetch(`${web}/web/api/triggers`, { headers: { cookie: bobC } })).json();
    assert.equal(list.triggers.length, 1);
    assert.ok(list.events.find((e: any) => e.type === 'app.approved' && e.all === false), 'not a reviewer: only his own apps');
    assert.ok(!list.events.find((e: any) => e.type === 'executor.offline'), 'executor events are for admins');
    assert.equal(list.others, undefined, 'only admins see other people\'s');
    const beforeApprove = fake.sent.length;
    await env.approveLatest();
    const approved = await env.waitFor(() => fake.sent.slice(beforeApprove).find(m => JSON.stringify(m.card).includes('amber-event app.approved')));
    assert.deepEqual(approved.to, { unionId: bob.unionId });

    // 5. Run failures: only your own. carol's trigger hears nothing when bob's run fails.
    const carolC = await login(carol);
    // Only groups you are in: their bots, and as a place for notices.
    fake.chats.set('oc_other', { mode: 'group', name: '别的群', members: new Set(['BOT', bob.unionId]) });
    assert.equal((await fetch(`${web}/web/api/groups/oc_other/bots`, { headers: { cookie: carolC } })).status, 404);
    assert.equal((await fetch(`${web}/web/api/groups/${GROUP}/bots`, { headers: { cookie: carolC } }).then(x => x.json())).bots[0].name, 'Beta');
    assert.match((await post(carolC, '/web/api/triggers', { on: 'run.failed', to: 'chat', chatId: 'oc_other' })).body.message, /只能发到你自己所在/);
    assert.equal((await post(carolC, '/web/api/triggers', { on: 'run.failed' })).body.ok, true);
    assert.equal((await post(bobC, '/web/api/triggers', { on: 'run.failed' })).body.ok, true);
    const n0 = fake.sent.length;
    emitEvent('run.failed', { runId: 'r1', commandId: d.id, name: '新应用', chatId: GROUP, callerUnionId: bob.unionId, channel: 'bot', error: 'boom' });
    await env.waitFor(() => fake.sent.slice(n0).find(m => JSON.stringify(m.card).includes('amber-event run.failed')));
    await triggers.dispatch();
    const runNotices = fake.sent.slice(n0).filter(m => JSON.stringify(m.card).includes('amber-event run.failed'));
    assert.deepEqual(runNotices.map(m => m.to), [{ unionId: bob.unionId }]);

    // 6. A reviewer who is no longer one stops hearing about everyone's apps at once.
    const reviewers = env.amber.bot.flow.reviewers;
    const admins = new Set((env.amber.bot as any).adminUnionIds);
    env.amber.bot.flow.reviewers = [];
    (env.amber.bot as any).adminUnionIds.clear();
    const n1 = fake.sent.length;
    emitEvent('app.review_started', { commandId: 'x', name: '别的', chatId: GROUP, ownerUnionId: bob.unionId });
    await triggers.dispatch();
    assert.equal(fake.sent.slice(n1).filter(m => JSON.stringify(m.card).includes('amber-event app.review_started')).length, 0);
    assert.equal(env.amber.store.deliveriesOf(r.body.triggerId, 1)[0].error, 'not_visible');
    env.amber.bot.flow.reviewers = reviewers;
    for (const a of admins) (env.amber.bot as any).adminUnionIds.add(a);

    // 7. Leaving the group pauses a trigger that posts there.
    fake.chats.get(GROUP)!.members.delete(alice.unionId);
    (env.amber.bot as any).memberCache.delete(GROUP);
    emitEvent('app.review_started', { commandId: 'y', name: '又一个', chatId: GROUP, ownerUnionId: bob.unionId });
    await triggers.dispatch();
    assert.equal(env.amber.store.getTrigger(r.body.triggerId)!.status, 'paused');
    assert.match(env.amber.store.getTrigger(r.body.triggerId)!.pauseReason!, /不在通知要发去的群里/);
    fake.chats.get(GROUP)!.members.add(alice.unionId);
    (env.amber.bot as any).memberCache.delete(GROUP);

    // 8. Managing: the owner (or an admin) pauses, resumes, deletes; others cannot.
    const bobRun = (await (await fetch(`${web}/web/api/triggers`, { headers: { cookie: bobC } })).json()).triggers.find((t: any) => t.on === 'run.failed');
    assert.equal((await post(carolC, `/web/api/triggers/${bobRun.id}/pause`, {})).status, 403);
    assert.equal((await post(bobC, `/web/api/triggers/${bobRun.id}/pause`, {})).body.ok, true);
    assert.equal(env.amber.store.getTrigger(bobRun.id)!.status, 'paused');
    assert.equal((await post(bobC, `/web/api/triggers/${bobRun.id}/resume`, {})).body.ok, true);
    const aliceC = await login(alice);
    const all = await (await fetch(`${web}/web/api/triggers`, { headers: { cookie: aliceC } })).json();
    assert.ok(all.others.some((t: any) => t.id === bobRun.id && t.ownerName), 'an admin sees everyone\'s');
    assert.equal((await post(aliceC, `/web/api/triggers/${bobRun.id}/delete`, {})).body.ok, true);
    assert.equal(env.amber.store.getTrigger(bobRun.id), undefined);
    // The agent may pause a trigger directly (the safe direction).
    const lst = await env.api('POST', '/v1/triggers/list', { chatId: GROUP, chatType: 'group', user: bob.email });
    assert.ok(lst.body.triggers.length >= 1);
    assert.equal((await env.api('POST', `/v1/triggers/${lst.body.triggers[0].id}/pause`, { chatId: GROUP, chatType: 'group', user: bob.email })).body.ok, true);
    assert.ok(env.amber.store.listAudit({ prefixes: ['trigger.'], limit: 50 }).some(a => a.action === 'trigger.create'));
  } finally { await env.close(); }
});

test('triggers: rate limit, retries, executors, schedules and pages', async () => {
  const env = await makeEnv();
  const { fake, alice, bob } = env;
  const triggers = (env.amber.bot as any).triggers;
  const mk = (owner: any, spec: object) => triggers.create({ unionId: owner.unionId, openId: owner.openId }, spec);
  try {
    // Too many in a minute: paused, and the owner is told.
    const t = await mk(bob, { on: 'run.failed' });
    const n0 = fake.sent.length;
    for (let i = 0; i < 12; i++) emitEvent('run.failed', { runId: 'r' + i, name: 'x', callerUnionId: bob.unionId });
    await triggers.dispatch();
    const sent = fake.sent.slice(n0);
    assert.equal(sent.filter(m => JSON.stringify(m.card).includes('amber-event run.failed')).length, 10);
    assert.equal(env.amber.store.getTrigger(t.id)!.status, 'paused');
    assert.ok(sent.some(m => /触发太频繁/.test(FakeFeishu.text(m.card))), 'the owner hears why');

    // A notice that cannot be sent is retried later, then goes out.
    const g = await mk(alice, { on: 'app.retired', to: 'chat', chatId: GROUP });
    fake.chats.get(GROUP)!.members.delete('BOT');
    emitEvent('app.retired', { commandId: 'c1', name: '旧应用', chatId: GROUP, ownerUnionId: bob.unionId });
    await triggers.dispatch();
    let dlv = env.amber.store.deliveriesOf(g.id, 1)[0];
    assert.equal(dlv.status, 'pending');
    assert.equal(dlv.attempts, 1);
    fake.chats.get(GROUP)!.members.add('BOT');
    const now = Date.now;
    try { Date.now = () => now() + 60_000; await triggers.dispatch(); } finally { Date.now = now; }
    dlv = env.amber.store.deliveriesOf(g.id, 1)[0];
    assert.equal(dlv.status, 'done');
    assert.ok(fake.sent.some(m => m.to.chatId === GROUP && JSON.stringify(m.card).includes('amber-event app.retired')));

    // Executors going offline and back (admins only); the first look only records the state.
    await mk(alice, { on: 'executor.offline' });
    await mk(alice, { on: 'executor.online' });
    await assert.rejects(mk(bob, { on: 'executor.offline' }), /只有管理员/);
    const n1 = fake.sent.length;
    triggers.checkExecutors([{ name: 'box', machine: 'fleet-b', online: true }]);
    triggers.checkExecutors([{ name: 'box', machine: 'fleet-b', online: false }]);
    triggers.checkExecutors([{ name: 'box', machine: 'fleet-b', online: true }]);
    await triggers.dispatch();
    const ex = fake.sent.slice(n1).map(m => JSON.stringify(m.card)).filter(c => c.includes('amber-event executor'));
    assert.equal(ex.length, 2);
    assert.match(ex[0], /executor\.offline/);
    assert.match(ex[1], /executor\.online/);

    // An admin who no longer is one stops hearing about executors.
    (env.amber.bot as any).adminUnionIds.clear();
    const n3 = fake.sent.length;
    triggers.checkExecutors([{ name: 'box', machine: 'fleet-b', online: false }]);
    await triggers.dispatch();
    assert.equal(fake.sent.slice(n3).filter(m => JSON.stringify(m.card).includes('amber-event executor')).length, 0);
    await env.amber.bot.resolveAdmins();

    // Only the app named.
    await mk(bob, { on: 'run.failed', app: '甲', appChatId: GROUP });
    const n4 = fake.sent.length;
    emitEvent('run.failed', { runId: 'x1', name: '乙', chatId: GROUP, callerUnionId: bob.unionId });
    emitEvent('run.failed', { runId: 'x2', name: '甲', chatId: GROUP, callerUnionId: bob.unionId });
    await triggers.dispatch();
    const named = fake.sent.slice(n4).map(m => JSON.stringify(m.card)).filter(c => c.includes('amber-event run.failed'));
    assert.equal(named.length, 1);
    assert.match(named[0], /run=x2/);
    // A global app is named by where it belongs; its runs happen anywhere (someone's private chat, another group).
    const n5 = fake.sent.length;
    emitEvent('run.failed', { runId: 'x3', name: '甲', appChatId: GROUP, chatId: 'oc_elsewhere', callerUnionId: bob.unionId });
    emitEvent('run.failed', { runId: 'x4', name: '甲', appChatId: 'oc_other_home', chatId: GROUP, callerUnionId: bob.unionId });
    await triggers.dispatch();
    const global = fake.sent.slice(n5).map(m => JSON.stringify(m.card)).filter(c => c.includes('amber-event run.failed') && /run=x[34]/.test(c));
    assert.equal(global.length, 1, 'the app of the same name that belongs elsewhere is another app');
    assert.match(global[0], /run=x3/);

    // Schedules paused by Amber, and pages: their owners.
    await mk(bob, { on: 'schedule.paused' });
    await mk(bob, { on: 'page.published' });
    const n2 = fake.sent.length;
    emitEvent('schedule.paused', { scheduleId: 's1', name: '日报', ownerUnionId: bob.unionId, reason: '连续失败' });
    emitEvent('schedule.paused', { scheduleId: 's2', name: '别人的', ownerUnionId: alice.unionId, reason: '连续失败' });
    emitEvent('page.published', { pageId: 'abcd1234', name: 'demo', ownerUnionId: bob.unionId });
    await triggers.dispatch();
    const own = fake.sent.slice(n2).filter(m => m.to.unionId === bob.unionId).map(m => FakeFeishu.text(m.card)).join('\n');
    assert.match(own, /「日报」的定时任务已暂停：连续失败/);
    assert.doesNotMatch(own, /别人的/);
    assert.match(own, /页面「demo」已发布/);
  } finally { await env.close(); }
});

test('triggers: events come from where things happen', async () => {
  const env = await makeEnv();
  const { bob } = env;
  const { runCommand } = await import('../src/engine.ts');
  const types = () => (env.amber.store as any).db.prepare('SELECT type, data FROM events ORDER BY id').all().map((r: any) => ({ type: r.type, ...JSON.parse(r.data) }));
  try {
    const ok = await activate(env, { chatId: GROUP, chatType: 'group', name: '报警', params: [], script: script('print("异常：3 笔")') }, bob);
    const bad = await activate(env, { chatId: GROUP, chatType: 'group', name: '会失败', params: [{ name: 'fail', type: 'string', default: '0' }], script: script('import json,sys\nif json.load(sys.stdin)["params"]["fail"] == "1": sys.exit("坏了")\nprint("好")') }, bob);
    let ev = types();
    assert.ok(ev.some((e: any) => e.type === 'app.review_started' && e.commandId === ok && e.ownerUnionId === bob.unionId && e.name === '报警'));
    assert.ok(ev.some((e: any) => e.type === 'app.approved' && e.commandId === ok));
    const caller = (channel: string) => ({ unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group' as const, channel: channel as any });
    await runCommand(env.amber.store, env.amber.store.getCommand(bad)!, { fail: '1' }, caller('bot'));
    await runCommand(env.amber.store, env.amber.store.getCommand(ok)!, {}, caller('bot'));
    await runCommand(env.amber.store, env.amber.store.getCommand(ok)!, {}, caller('schedule'));
    ev = types();
    assert.ok(ev.some((e: any) => e.type === 'run.failed' && e.commandId === bad && e.callerUnionId === bob.unionId && /坏了/.test(e.error)));
    assert.equal(ev.filter((e: any) => e.type === 'run.output').length, 1, 'only a scheduled run with output');
    // Where the app belongs travels with run and schedule events (for a global app it is not where it ran).
    assert.ok(ev.filter((e: any) => e.type === 'run.failed' || e.type === 'run.output').every((e: any) => e.appChatId === GROUP));
    const cmd = env.amber.store.getCommand(ok)!;
    const s = env.amber.store.insertSchedule({ commandId: ok, specHash: cmd.specHash, chatId: 'oc_dm_on_bob', chatType: 'p2p', replyTo: null, inThread: false,
      creatorUnionId: bob.unionId, creatorOpenId: bob.openId, args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, nextRunAt: Date.now() + 3600_000, requestedBy: 'test' });
    (env.amber.bot.scheduler as any).pause(s, '测试');
    assert.ok(types().some((e: any) => e.type === 'schedule.paused' && e.scheduleId === s.id && e.appChatId === GROUP && e.chatId === 'oc_dm_on_bob'));
    await env.amber.bot.retire(ok, { unionId: bob.unionId }, 'test');
    assert.ok(types().some((e: any) => e.type === 'app.retired' && e.commandId === ok));
  } finally { await env.close(); }
});

test('triggers: review started without Feishu approval (review cards) is an event too', async () => {
  const env = await makeEnv({ approval: undefined });
  const { fake, bob } = env;
  try {
    const d = await env.submit({ chatId: GROUP, chatType: 'group', name: '卡片审核', params: [], script: script('print(1)') });
    await env.click(bob, d.claimMessageId, { a: 'claim_try', c: d.id });
    await env.waitFor(() => button(fake.cardOf(d.claimMessageId), 'claim_submit'));
    await env.click(bob, d.claimMessageId, { a: 'claim_submit', c: d.id });
    const ev = (env.amber.store as any).db.prepare(`SELECT data FROM events WHERE type = 'app.review_started'`).all().map((r: any) => JSON.parse(r.data));
    assert.deepEqual(ev.map((e: any) => e.commandId), [d.id]);
  } finally { await env.close(); }
});
