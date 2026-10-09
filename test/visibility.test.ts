// #4 visibility: a command is seen and run only by its creator, unless it is global. Admins can look at
// anyone's command and take it offline, but not run it. Others get their own copy from Amber Store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { secretVault } from '../src/engine.ts';
import { scheduleListCard } from '../src/cards.ts';

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('visibility: only the creator sees and runs a command; an admin looks and retires; global is for everyone', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;   // alice is an admin; bob creates; carol is another member
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const scope = 'group:' + GROUP;
  const text = (id: string) => FakeFeishu.text(fake.cardOf(id));
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    secretVault()!.set({ chatId: GROUP, name: '报表' }, 'API_TOKEN', 'bob-token-123', bob.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '报表', params: [], script: script('print("bob的报表")', { secrets: ['API_TOKEN'] }), options: { schedulable: true } }, bob);
    // A schedule someone else made before #4 pauses instead of running as them.
    const cmd = env.amber.store.getCommand(id)!;
    const old = env.amber.store.insertSchedule({ commandId: id, specHash: cmd.specHash, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creatorUnionId: carol.unionId, creatorOpenId: carol.openId, args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, nextRunAt: Date.now() - 1000, requestedBy: 'test' });
    await env.amber.bot.scheduler.tick(Date.now());
    await env.waitFor(() => env.amber.store.getSchedule(old.id)!.status === 'paused' || undefined);
    assert.equal(env.amber.store.getSchedule(old.id)!.lastRunId, null);
    // Schedules: each person lists only their own; only the creator can run one now (an admin manages, does not run).
    const mine = await env.amber.bot.scheduler.create({ cmd: env.amber.store.getCommand(id)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group', channel: 'web' }, args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, requestedBy: 'test', via: {} });
    await env.say(carol, GROUP, '定时任务');
    const carolList = FakeFeishu.text(fake.sent.at(-1)!.card);
    assert.ok(carolList.includes(old.id) && !carolList.includes(mine.id), 'carol sees her own schedule only');
    await env.say(bob, GROUP, '定时任务');
    const bobList = FakeFeishu.text(fake.sent.at(-1)!.card);
    assert.ok(bobList.includes(mine.id) && !bobList.includes(old.id));
    assert.match(bobList, /立即运行/);
    const listMsg = fake.sent.at(-1)!.id;
    assert.match(JSON.stringify(await env.click(alice, listMsg, { a: 'sch_run', s: mine.id })), /只有定时任务的创建人可以立即运行/);
    // Rebinding decides what runs under the creator's name: the creator only, and only to a newer version of the same command.
    const other = await activate(env, { chatId: GROUP, chatType: 'group', name: '别的', params: [], script: script('print(2)'), options: { schedulable: true } }, bob);
    assert.match(JSON.stringify(await env.click(alice, listMsg, { a: 'sch_rebind', s: mine.id, c: id })), /只有定时任务的创建人可以换绑/);
    assert.match(JSON.stringify(await env.click(bob, listMsg, { a: 'sch_rebind', s: mine.id, c: other })), /同一条指令的新版本/);
    assert.equal(env.amber.store.getSchedule(mine.id)!.commandId, id);
    const adminCard = JSON.stringify(scheduleListCard([{ ...env.amber.bot.scheduler.view(mine, alice.unionId) }], '本群'));
    assert.match(adminCard, /sch_pause/);
    assert.doesNotMatch(adminCard, /sch_run/, 'no run button for an admin');
    const sched = async (u: any) => (await env.api('POST', '/v1/schedules/list', { chatId: GROUP, chatType: 'group', label: 'TestBot', user: u.email })).body.schedules.map((x: any) => x.id);
    assert.deepEqual(await sched(carol), [old.id]);
    assert.deepEqual(await sched(bob), [mine.id]);
    assert.deepEqual((await env.api('POST', '/v1/schedules/list', { chatId: GROUP, chatType: 'group', label: 'TestBot' })).body.schedules, []);
    // An agent pauses only the named person's own schedule (or any, for an admin).
    const pause = (u: any) => env.api('POST', `/v1/schedules/${mine.id}/pause`, { chatId: GROUP, chatType: 'group', label: 'TestBot', ...(u ? { user: u.email } : {}) });
    assert.equal((await pause(carol)).status, 404);
    assert.equal((await pause(null)).status, 404);
    assert.equal(env.amber.store.getSchedule(mine.id)!.status, 'active');
    // A command with no owner on record is nobody's: not visible to a caller without identity.
    const noOwner = await activate(env, { chatId: GROUP, chatType: 'group', name: '无主', params: [], script: script('print(1)') }, bob);
    (env.amber.store as any).db.prepare("UPDATE commands SET owner_union_id = '' WHERE id = ?").run(noOwner);
    assert.deepEqual((await env.api('POST', '/v1/commands/list', { chatId: GROUP, chatType: 'group', label: 'TestBot' })).body.commands, []);

    // Feishu: the list and a one-line run.
    await env.say(carol, GROUP, '指令');
    assert.doesNotMatch(FakeFeishu.text(fake.sent.at(-1)!.card), /报表/);
    await env.say(bob, GROUP, '指令');
    assert.match(FakeFeishu.text(fake.sent.at(-1)!.card), /报表/);
    for (const who of [carol, alice]) {
      await env.say(who, GROUP, '报表');
      await env.waitFor(() => /没有找到指令「报表」/.test(text(fake.sent.at(-1)!.id)) || undefined);
    }
    // Forged card values do not help.
    const msg = fake.sent.at(-1)!.id;
    assert.match(JSON.stringify(await env.click(carol, msg, { a: 'pick', c: id })), /没有找到指令/);
    assert.match(JSON.stringify(await env.click(alice, msg, { a: 'run', c: id }, {})), /没有找到指令/);
    assert.ok(!env.amber.store.runsByCaller(carol.unionId, 5).length && !env.amber.store.runsByCaller(alice.unionId, 5).filter(r => r.commandName === '报表').length);

    // Agents: what the named person owns, nothing else.
    const ctx = (u: any) => ({ chatId: GROUP, chatType: 'group', label: 'TestBot', user: u.email });
    assert.deepEqual((await env.api('POST', '/v1/commands/list', ctx(carol))).body.commands.map((c: any) => c.name), []);
    assert.deepEqual((await env.api('POST', '/v1/commands/list', ctx(bob))).body.commands.map((c: any) => c.name).sort(), ['别的', '报表']);
    assert.match((await env.api('POST', '/v1/runs', { ...ctx(carol), command: '报表' })).body.message, /没有找到指令/);
    assert.match((await env.api('POST', '/v1/schedules', { ...ctx(alice), command: '报表', at: '每天 09:00' })).body.message, /没有找到指令/);

    // Website: carol does not see it; alice (admin) sees it, reads the code, cannot run or schedule it.
    const carolCookie = await login(env, carol), aliceCookie = await login(env, alice);
    const carolOv = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: carolCookie } })).json();
    assert.ok(!carolOv.groups.flatMap((g: any) => g.commands).some((c: any) => c.id === id));
    assert.equal((await post(carolCookie, '/web/api/run', { scope, commandId: id, args: {} })).status, 404);
    const ov = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: aliceCookie } })).json();
    const view = ov.groups.flatMap((g: any) => g.commands).find((c: any) => c.id === id);
    assert.deepEqual([view.canRun, view.canManage], [false, true]);
    assert.equal((await post(aliceCookie, '/web/api/run', { scope, commandId: id, args: {} })).status, 404);
    assert.equal((await post(aliceCookie, '/web/api/schedules', { scope, commandId: id, at: '每天 09:00', args: {} })).status, 404);
    assert.equal((await post(aliceCookie, `/web/api/schedules/${mine.id}/run`, {})).status, 403);
    assert.equal((await post(aliceCookie, `/web/api/schedules/${mine.id}/pause`, {})).body.ok, true, 'an admin may pause it');
    const carolScheds = carolOv.groups.flatMap((g: any) => g.schedules).map((x: any) => x.id);
    assert.deepEqual(carolScheds, [old.id]);
    const adminSch = ov.groups.flatMap((g: any) => g.schedules).find((x: any) => x.id === mine.id);
    assert.deepEqual([adminSch.mine, adminSch.canManage], [false, true], 'an admin sees and manages everyone\'s schedules');
    const src = await (await fetch(`${base}/web/api/commands/${id}/source?scope=${scope}`, { headers: { cookie: aliceCookie } })).json();
    assert.match(src.script.code, /bob的报表/);
    // The admin manages it (here: sets its secret), even from outside the group.
    fake.chats.get(GROUP)!.members.delete(alice.unionId);
    (env.amber.bot as any).memberCache.clear();
    const ov3 = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: aliceCookie } })).json();
    assert.ok(ov3.groups.flatMap((g: any) => g.commands).some((c: any) => c.id === id), 'an admin sees groups they are not in');
    assert.equal((await post(aliceCookie, `/web/api/commands/${id}/secrets`, { scope, name: 'API_TOKEN', value: 'admin-set-123' })).body.ok, true);
    fake.chats.get(GROUP)!.members.add(alice.unionId);
    (env.amber.bot as any).memberCache.clear();
    // Someone's private-chat command: the admin reads it, does not run it.
    fake.chats.set('oc_dmbob', { mode: 'p2p', name: '', members: new Set(['BOT', bob.unionId]) });
    const p2p = await activate(env, { chatId: 'oc_dmbob', chatType: 'p2p', claimer: bob.email, name: '私事', params: [], script: script('print("私事")') }, bob);
    assert.equal((await fetch(`${base}/web/api/commands/${p2p}/source?scope=p2p`, { headers: { cookie: aliceCookie } })).status, 200);
    assert.equal((await post(aliceCookie, '/web/api/run', { scope: 'p2p', commandId: p2p, args: {} })).status, 404);
    assert.equal((await fetch(`${base}/web/api/commands/${p2p}/source?scope=p2p`, { headers: { cookie: carolCookie } })).status, 404);

    // A new version keeps the creator's secrets and configuration: an admin cannot claim (or trial-run) it.
    const nv = await env.submit({ chatId: GROUP, chatType: 'group', name: '报表', params: [], script: script('print("新版")', { secrets: ['API_TOKEN'] }), options: { schedulable: true } });
    assert.match(JSON.stringify(await env.click(alice, nv.claimMessageId, { a: 'claim_try', c: nv.id })), /只有原创建人可以认领/);
    assert.equal(env.amber.store.runsByCaller(alice.unionId, 10).filter(r => r.commandName === '报表').length, 0);
    // … not even after the command it replaces was taken offline meanwhile.
    const before = env.amber.store.getCommand(id)!;
    (env.amber.store as any).db.prepare("UPDATE commands SET status = 'retired' WHERE id = ?").run(id);
    assert.match(JSON.stringify(await env.click(carol, nv.claimMessageId, { a: 'claim_try', c: nv.id })), /只有原创建人可以认领/);
    (env.amber.store as any).db.prepare('UPDATE commands SET status = ? WHERE id = ?').run(before.status, id);
    await env.click(bob, nv.claimMessageId, { a: 'claim_drop', c: nv.id });

    // Global: everyone may run it.
    const g = await env.api('POST', '/v1/commands/scope', { ...ctx(alice), command: '报表', global: true });
    const card = fake.sent.at(-1)!;
    await env.click(alice, card.id, button(card.card, 'req_ok')!);
    assert.equal((await env.api('GET', `/v1/requests/${g.body.requestId}`)).body.status, 'done');
    await env.say(carol, GROUP, '报表');
    await env.waitFor(() => fake.sent.some(s => /bob的报表/.test(text(s.id)) && /<at id=ou_carol>/.test(text(s.id))) || undefined);
    const ov2 = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: carolCookie } })).json();
    assert.equal(ov2.global.find((c: any) => c.id === id)?.canRun, true);
    // Running a global command does not make it yours: its settings stay with the creator and admins.
    assert.equal((await post(carolCookie, `/web/api/commands/${id}/secrets`, { scope: 'global', name: 'API_TOKEN', value: 'carol-1234567' })).status, 403);
    assert.equal((await post(carolCookie, `/web/api/commands/${id}/config`, { scope: 'global', name: 'x', value: 'y' })).status, 403);
    await post(aliceCookie, `/web/api/commands/${id}/retire`, { scope: 'global', confirm: true });

    // An admin takes someone's command offline from Feishu.
    const id2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '周报', params: [], script: script('print(1)') }, bob);
    await env.say(alice, GROUP, '下线 周报');
    const confirm = fake.sent.at(-1)!;
    await env.click(alice, confirm.id, button(confirm.card, 'retire_ok')!);
    assert.equal(env.amber.store.getCommand(id2)!.status, 'retired');
    assert.equal(env.amber.store.getCommand(id)!.status, 'retired');
  } finally { await env.close(); }
});
