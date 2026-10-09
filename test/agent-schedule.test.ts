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
    await activate(env, { chatId: GROUP, chatType: 'group', name: '直接', params: [], script: script('print("direct ok")') }, env.bob);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [{ name: 'n', label: '数', type: 'integer', required: true }], script: script('import json,sys\nprint("n=" + json.load(sys.stdin)["params"]["n"])'), options: { confirm: true } }, env.bob, { n: '1' });
    const list = await env.api('POST', '/v1/commands/list', ctx(env, env.bob));
    assert.deepEqual(list.body.commands.map((c: any) => [c.name, c.run]).sort(), [['直接', 'direct'], ['确认', 'confirm_card']]);
    const d = await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '直接' });
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
    // The output stays in Feishu: the card shows it, the agent only learns the outcome.
    assert.equal(w.body.markdown, undefined);
    assert.equal(w.body.runId, undefined);
    assert.equal(w.body.runStatus, 'ok');
    assert.doesNotMatch(JSON.stringify(w.body), /n=7/);
    await env.waitFor(() => /n=7/.test(FakeFeishu.text(env.fake.cardOf(card.id))) || undefined);
    // A second click does nothing.
    assert.match(JSON.stringify(await env.click(env.bob, card.id, ok)), /处理过/);
    const run = env.amber.store.getRun(env.amber.store.getRequest(r.body.requestId)!.runId!)!;
    assert.equal(run.callerUnionId, env.bob.unionId);
    assert.equal(run.channel, 'agent');
  } finally { await env.close(); }
});

test('agent: run output cannot be read back through the API; ids are long', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [], script: script('print("secret-42")'), options: { confirm: true } }, env.bob);
    const r = await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '确认' });
    assert.ok(r.body.requestId.length >= 32, 'request ids are full random ids');
    const card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, button(card.card, 'req_ok')!);
    const w = await env.api('GET', `/v1/requests/${r.body.requestId}?wait=10`);
    assert.equal(w.body.status, 'done');
    assert.doesNotMatch(JSON.stringify(w.body), /secret-42/);
    const runId = env.amber.store.getRequest(r.body.requestId)!.runId!;
    assert.ok(runId.length >= 32, 'run ids are full random ids');
    const g = await env.api('GET', `/v1/runs/${runId}`);
    assert.equal(g.status, 410);
    assert.doesNotMatch(JSON.stringify(g.body), /secret-42/);
  } finally { await env.close(); }
});

test('agent: a person can cancel a request', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [], script: script('print(1)'), options: { confirm: true } }, env.bob);
    const r = await env.api('POST', '/v1/runs', { ...ctx(env, env.bob), command: '确认' });
    const card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, button(card.card, 'req_no')!);
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.status, 'canceled');
  } finally { await env.close(); }
});

test('schedules: created by a click, run as the creator, silent when empty, paused after 3 failures or when the creator leaves, and nobody else takes it over', async () => {
  const env = await makeEnv();
  try {
    const code = 'import json,sys\nm=json.load(sys.stdin)["params"].get("mode","")\nif m=="fail": sys.exit("boom")\nif m!="quiet": print("hi")';
    await activate(env, { chatId: GROUP, chatType: 'group', name: '报告', params: [{ name: 'mode', label: '模式', type: 'string' }], script: script(code), options: { schedulable: true } }, env.bob);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '不可定时', params: [], script: script('print(1)'), options: { schedulable: false } }, env.bob);
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
    // Only the creator runs their command (#4): nobody in the group can take it over, and the group gets no card.
    assert.equal(env.fake.sent.filter(p => p.to.chatId === GROUP && button(p.card, 'sch_takeover')).length, 0);
    assert.ok(env.fake.sent.some(p => p.to.unionId === env.bob.unionId && /你已不在这个群里/.test(FakeFeishu.text(p.card))), 'the creator is told privately');
    const old = await env.click(env.alice, env.fake.sent.at(-1)!.id, { a: 'sch_takeover', s: normal });
    assert.match(JSON.stringify(old), /不能接手/, 'a takeover card from before cannot be used');
    assert.equal(env.amber.store.getSchedule(normal)!.status, 'paused');
  } finally { await env.close(); }
});

test('schedules: runs missed while Amber was down are skipped, not caught up', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '报告', params: [], script: script('print("x")'), options: { schedulable: true } }, env.bob);
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

test('agent: retire a command — creator or admin clicks; others are refused up front and at the click', async () => {
  const env = await makeEnv();
  try {
    // bob owns 报表; alice is an admin; carol is neither.
    await activate(env, { chatId: GROUP, chatType: 'group', name: '报表', params: [], script: script('print(1)'), options: { schedulable: true } }, env.bob);
    const id = env.amber.store.listAll().find((c: any) => c.name === '报表')!.id;
    // A named person without the right is refused before any card is posted.
    const before = env.fake.sent.length;
    const bad = await env.api('POST', '/v1/commands/retire', { ...ctx(env, env.carol), command: '报表' });
    assert.equal(bad.body.ok, false);
    assert.match(bad.body.message, /没有找到应用/, 'others do not even see it');
    assert.equal(env.fake.sent.length, before);
    // Without a named person nobody's commands are visible.
    assert.match((await env.api('POST', '/v1/commands/retire', { ...ctx(env), command: '报表' })).body.message, /没有找到应用/);
    const r = await env.api('POST', '/v1/commands/retire', { ...ctx(env, env.bob), command: '报表' });
    assert.equal(r.body.mode, 'confirm_card');
    const card = env.fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(card.card), /下线/);
    const ok = button(card.card, 'req_ok')!;
    assert.match(JSON.stringify(await env.click(env.carol, card.id, ok)), /创建人或管理员/);
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
    await env.click(env.bob, card.id, ok);
    assert.equal(env.amber.store.getCommand(id)!.status, 'retired');
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.status, 'done');
    assert.match(JSON.stringify(await env.click(env.bob, card.id, ok)), /处理过/);
  } finally { await env.close(); }
});

test('agent: retire pauses the schedules; a version change between request and click blocks it', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '日报', params: [], script: script('print(1)'), options: { schedulable: true } }, env.bob);
    const sr = await env.api('POST', '/v1/schedules', { ...ctx(env, env.bob), command: '日报', at: '每天 09:00' });
    let card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, button(card.card, 'req_ok')!);
    const sid = (await env.api('GET', `/v1/requests/${sr.body.requestId}`)).body.scheduleId;
    const r = await env.api('POST', '/v1/commands/retire', { ...ctx(env, env.alice), command: '日报' });
    card = env.fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(card.card), /1\*\* 个定时任务/);
    // Only the named admin may click, even though bob is the creator.
    assert.match(JSON.stringify(await env.click(env.bob, card.id, button(card.card, 'req_ok')!)), /发给别人/);
    await env.click(env.alice, card.id, button(card.card, 'req_ok')!);
    assert.equal(env.amber.store.getSchedule(sid)!.status, 'paused');
    // New version between request and click.
    await activate(env, { chatId: GROUP, chatType: 'group', name: '周报', params: [], script: script('print(1)') }, env.bob);
    const r2 = await env.api('POST', '/v1/commands/retire', { ...ctx(env, env.bob), command: '周报' });
    const c2 = env.fake.sent.at(-1)!;
    await activate(env, { chatId: GROUP, chatType: 'group', name: '周报', params: [], script: script('print(2)') }, env.bob);
    assert.match(JSON.stringify(await env.click(env.bob, c2.id, button(c2.card, 'req_ok')!)), /新版本/);
    assert.equal((await env.api('GET', `/v1/requests/${r2.body.requestId}`)).body.status, 'failed');
    assert.ok(env.amber.store.listAll().some((c: any) => c.name === '周报' && c.status === 'active'));
    void r;
  } finally { await env.close(); }
});

test('agent: global / local need an admin click', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '汇率', params: [], script: script('print(1)') }, env.bob);
    const id = env.amber.store.listAll().find((c: any) => c.name === '汇率')!.id;
    // bob is the creator but not an admin.
    const bad = await env.api('POST', '/v1/commands/scope', { ...ctx(env, env.bob), command: '汇率', global: true });
    assert.match(bad.body.message, /只有管理员/);
    // An admin sees anyone's command for managing it (not for running it).
    const r = await env.api('POST', '/v1/commands/scope', { ...ctx(env, env.alice), command: '汇率', global: true });
    const card = env.fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(card.card), /全局/);
    assert.match(JSON.stringify(await env.click(env.bob, card.id, button(card.card, 'req_ok')!)), /只有管理员/);
    await env.click(env.alice, card.id, button(card.card, 'req_ok')!);
    assert.equal(env.amber.store.getCommand(id)!.global, true);
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.status, 'done');
    // Already global: refused up front.
    assert.match((await env.api('POST', '/v1/commands/scope', { ...ctx(env, env.alice), command: '汇率', global: true })).body.message, /已经是全局/);
    const r2 = await env.api('POST', '/v1/commands/scope', { ...ctx(env, env.alice), command: '汇率', global: false });
    const c2 = env.fake.sent.at(-1)!;
    await env.click(env.alice, c2.id, button(c2.card, 'req_ok')!);
    assert.equal(env.amber.store.getCommand(id)!.global, false);
    assert.equal((await env.api('GET', `/v1/requests/${r2.body.requestId}`)).body.status, 'done');
    // Cancel leaves it unchanged.
    await env.api('POST', '/v1/commands/scope', { ...ctx(env, env.alice), command: '汇率', global: true });
    const c3 = env.fake.sent.at(-1)!;
    await env.click(env.alice, c3.id, button(c3.card, 'req_no')!);
    assert.equal(env.amber.store.getCommand(id)!.global, false);
  } finally { await env.close(); }
});
