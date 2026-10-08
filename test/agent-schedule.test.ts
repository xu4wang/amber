// Agent API tiers, confirmation cards, schedules.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { nextRun } from '../src/schedule-rule.ts';

const ctx = (env: any, u?: any) => ({ chatId: GROUP, chatType: 'group', label: 'TestBot', ...(u ? { user: u.email } : {}) });

test('agent: identity-free commands run directly; confirm commands need the named person to click', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '直接', params: [], script: script('print("direct ok")') }, env.alice);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [{ name: 'n', label: '数', type: 'integer', required: true }], script: script('import json,sys\nprint("n=" + json.load(sys.stdin)["params"]["n"])'), options: { confirm: true } }, env.alice, { n: '1' });
    const list = await env.api('POST', '/v1/commands/list', ctx(env));
    assert.deepEqual(list.body.commands.map((c: any) => [c.name, c.run]).sort(), [['直接', 'direct'], ['确认', 'confirm_card']]);
    const d = await env.api('POST', '/v1/runs', { ...ctx(env), command: '直接' });
    assert.equal(d.body.mode, 'direct');
    assert.equal(d.body.markdown, 'direct ok');
    // Bad args are refused before anyone is asked.
    assert.equal((await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '确认', args: { n: 'x' } })).body.ok, false);
    const r = await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '确认', args: { n: '7' } });
    assert.equal(r.body.mode, 'confirm_card');
    const card = env.fake.sent.at(-1)!;
    assert.equal(card.to.chatId, GROUP);
    assert.match(FakeFeishu.text(card.card), /TestBot/);
    const ok = button(card.card, 'req_ok')!;
    // Alice was not asked.
    assert.match(JSON.stringify(await env.click(env.alice, card.id, ok)), /发给别人/);
    await env.click(env.bob, card.id, ok);
    const w = await env.api('GET', `/v1/requests/${r.body.requestId}?wait=10`);
    assert.equal(w.body.status, 'done');
    assert.equal(w.body.markdown, 'n=7');
    // A second click does nothing.
    assert.match(JSON.stringify(await env.click(env.bob, card.id, ok)), /处理过/);
    const run = env.amber.store.getRun(w.body.runId)!;
    assert.equal(run.callerUnionId, env.bob.unionId);
    assert.equal(run.channel, 'agent');
  } finally { await env.close(); }
});

test('agent: a person can cancel a request', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [], script: script('print(1)'), options: { confirm: true } }, env.alice);
    const r = await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '确认' });
    const card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, button(card.card, 'req_no')!);
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.status, 'canceled');
  } finally { await env.close(); }
});

test('schedules: created by a click, run as the creator, silent when empty, paused after 3 failures or when the creator leaves', async () => {
  const env = await makeEnv();
  try {
    const code = 'import json,sys\nm=json.load(sys.stdin)["params"].get("mode","")\nif m=="fail": sys.exit("boom")\nif m!="quiet": print("hi")';
    await activate(env, { chatId: GROUP, chatType: 'group', name: '报告', params: [{ name: 'mode', label: '模式', type: 'string' }], script: script(code), options: { schedulable: true } }, env.alice);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '不可定时', params: [], script: script('print(1)'), options: { schedulable: false } }, env.alice);
    assert.match((await env.api('POST', '/v1/schedules', { ...ctx(env, env.bob), command: '不可定时', at: '每天 09:00' })).body.message, /没有允许定时/);
    assert.match((await env.api('POST', '/v1/schedules', { ...ctx(env, env.bob), command: '报告', at: '每 3 分钟' })).body.message, /最短 5 分钟/);
    const mk = async (mode: string) => {
      const r = await env.api('POST', '/v1/schedules', { ...ctx(env, env.bob), command: '报告', at: '每 5 分钟', args: { mode } });
      const card = env.fake.sent.at(-1)!;
      await env.click(env.bob, card.id, button(card.card, 'req_ok')!);
      return (await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.scheduleId as string;
    };
    const normal = await mk(''), quiet = await mk('quiet'), failing = await mk('fail');
    const s = env.amber.store.getSchedule(normal)!;
    assert.equal(s.creatorUnionId, env.bob.unionId);
    const tickAt = async (t: number) => { await env.amber.bot.scheduler.tick(t); await env.waitFor(() => !(env.amber.bot.scheduler as any).active && (env.amber.bot.scheduler as any).running.size === 0 || undefined); };
    let t = s.nextRunAt + 1000;
    const before = env.fake.sent.length;
    await tickAt(t);
    const posted = env.fake.sent.slice(before);
    assert.equal(posted.filter(p => p.to.chatId === GROUP).length, 1, 'only the normal schedule posts to the group');
    assert.match(FakeFeishu.text(posted.find(p => p.to.chatId === GROUP)!.card), /hi/);
    assert.equal(env.amber.store.getSchedule(quiet)!.lastStatus, 'ok_silent');
    assert.ok(posted.some(p => p.to.unionId === env.bob.unionId && /boom/.test(FakeFeishu.text(p.card))), 'failure goes to the creator privately');
    const run = env.amber.store.getRun(env.amber.store.getSchedule(normal)!.lastRunId!)!;
    assert.equal(run.callerUnionId, env.bob.unionId);
    assert.equal(run.channel, 'schedule');
    for (let k = 0; k < 2; k++) { t = env.amber.store.getSchedule(failing)!.nextRunAt + 1000; await tickAt(t); }
    assert.equal(env.amber.store.getSchedule(failing)!.status, 'paused');
    // Bob leaves the group: his schedules pause instead of running.
    env.fake.chats.get(GROUP)!.members.delete(env.bob.unionId);
    (env.amber.bot as any).memberCache.clear();
    t = env.amber.store.getSchedule(normal)!.nextRunAt + 1000;
    await tickAt(t);
    assert.equal(env.amber.store.getSchedule(normal)!.status, 'paused');
    assert.match(env.amber.store.getSchedule(normal)!.pauseReason!, /不在群里/);
    // D45: the group is told, and any member can take the schedule over as themselves.
    const notice = env.fake.sent.filter(p => p.to.chatId === GROUP && button(p.card, 'sch_takeover')?.s === normal);
    assert.equal(notice.length, 1, 'one takeover notice in the group');
    const take = button(notice[0].card, 'sch_takeover')!;
    await env.click(env.carol, notice[0].id, take);           // carol is not in the group
    assert.equal(env.amber.store.getSchedule(normal)!.status, 'paused');
    // A schedule paused for another reason (3 failures) cannot be taken over through a forged value.
    const forged = await env.click(env.alice, notice[0].id, { a: 'sch_takeover', s: failing });
    assert.match(JSON.stringify(forged), /不需要接手/);
    assert.equal(env.amber.store.getSchedule(failing)!.status, 'paused');
    const old = env.amber.store.getSchedule(normal)!;
    const res = await env.click(env.alice, notice[0].id, take);
    assert.match(JSON.stringify(res), /已接手/);
    assert.equal(env.amber.store.getSchedule(normal)?.status ?? 'deleted', 'deleted');
    const mine = env.amber.store.schedulesInChat(GROUP).filter(x => x.creatorUnionId === env.alice.unionId && x.status === 'active');
    assert.equal(mine.length, 1);
    assert.deepEqual([mine[0].commandId, mine[0].args, mine[0].rule], [old.commandId, old.args, old.rule]);
    const again = await env.click(env.alice, notice[0].id, take);
    assert.match(JSON.stringify(again), /已经被接手/);
    assert.equal(env.amber.store.schedulesInChat(GROUP).filter(x => x.creatorUnionId === env.alice.unionId && x.status === 'active').length, 1, 'no second copy');
    await tickAt(mine[0].nextRunAt + 1000);
    const run2 = env.amber.store.getRun(env.amber.store.getSchedule(mine[0].id)!.lastRunId!)!;
    assert.equal(run2.callerUnionId, env.alice.unionId, 'runs as the person who took over');
  } finally { await env.close(); }
});

test('schedules: runs missed while Amber was down are skipped, not caught up', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '报告', params: [], script: script('print("x")'), options: { schedulable: true } }, env.alice);
    const r = await env.api('POST', '/v1/schedules', { ...ctx(env, env.bob), command: '报告', at: '每天 09:00' });
    const card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, button(card.card, 'req_ok')!);
    const id = (await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.scheduleId;
    const s = env.amber.store.getSchedule(id)!;
    const before = env.fake.sent.length;
    await env.amber.bot.scheduler.tick(s.nextRunAt + 3 * 3600_000);
    assert.equal(env.fake.sent.length, before);
    assert.equal(env.amber.store.getSchedule(id)!.lastStatus, 'missed');
    assert.equal(env.amber.store.getSchedule(id)!.nextRunAt, nextRun(s.rule, s.nextRunAt + 3 * 3600_000));
  } finally { await env.close(); }
});
