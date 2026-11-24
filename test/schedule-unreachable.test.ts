// A schedule whose executor is briefly unreachable (its machine overloaded for a minute): the app did not run, so it
// is not the app failing. 11-24: KOL哨兵 runs every 5–15 minutes and raised a failure card per run, and three in a
// row would have paused it, each time dev-prem stalled for a few minutes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { executorHub } from '../src/engine.ts';
import { UNREACHABLE_NOTIFY_MS, UNREACHABLE_PAUSE_MS, UNREACHABLE_PAUSED } from '../src/scheduler.ts';

const HELLO = script('print("你好")');

test('an unreachable executor: no failure, no pause; a frequent schedule hears once after 30 minutes, a sparse one at once', async () => {
  const env = await makeEnv();
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '哨兵', params: [], script: HELLO, options: { schedulable: true } }, env.alice);
    const sch = env.amber.bot.scheduler;
    const mk = (rule: any) => sch.create({ cmd: env.amber.store.getCommand(id)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: env.alice.unionId, openId: env.alice.openId, chatId: GROUP, chatType: 'group', channel: 'web' }, args: {}, rule, requestedBy: 'test', via: {} });
    const hub = executorHub()!;
    const realLocal = hub.runLocal.bind(hub);
    let down = true;
    (hub as any).runLocal = (s: any, i: any, o: any) => down
      ? Promise.resolve({ ok: false, unreachable: true, content: '', error: '执行端 box 离线（最后在线：…），这次没有执行' })
      : realLocal(s, i, o);
    const notices = (sid: string) => env.fake.sent.filter(m => m.to.unionId === env.alice.unionId && FakeFeishu.text(m.card).includes(`定时任务 ${sid}`));
    const run = async (sid: string, manual = false) => { await sch.runOnce(env.amber.store.getSchedule(sid)!, manual); return env.amber.store.getSchedule(sid)!; };

    const every5 = await mk({ kind: 'minutely', every: 5, tz: 'Asia/Shanghai' });
    // Four runs in a row (the old rule paused after three failures): quiet, not counted, still active.
    for (let i = 0; i < 4; i++) {
      const s = await run(every5.id);
      assert.equal(s.status, 'active', s.pauseReason ?? '');
      assert.equal(s.failCount, 0);
      assert.equal(s.lastStatus, 'unreachable');
    }
    assert.equal(notices(every5.id).length, 0, 'nothing while it is short');
    assert.equal(env.amber.store.getRun(env.amber.store.getSchedule(every5.id)!.lastRunId!)?.status, 'failed', 'the run itself is recorded as it was');
    // It has lasted 30 minutes: one notice, then nothing more.
    (sch as any).unreachableSince.set(every5.id, Date.now() - UNREACHABLE_NOTIFY_MS - 1000);
    assert.equal((await run(every5.id)).lastStatus, 'unreachable_notified');
    assert.equal(notices(every5.id).length, 1);
    assert.match(FakeFeishu.text(notices(every5.id)[0].card), /不算这个任务失败，不会因此暂停/);
    await run(every5.id);
    assert.equal(notices(every5.id).length, 1, 'told once');
    // Back: runs normally; the next outage starts its wait from zero.
    down = false;
    assert.equal((await run(every5.id)).lastStatus, 'ok');
    down = true;
    assert.equal((await run(every5.id)).lastStatus, 'unreachable');
    assert.equal(notices(every5.id).length, 1);

    // A daily schedule would not try again for a day: it hears at once.
    // Its time is two hours ago, so the next run is a day away whenever the test runs (a fixed 09:00 failed at 08:30–09:00).
    const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toLocaleTimeString('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false });
    const daily = await mk({ kind: 'daily', time: twoHoursAgo, tz: 'Asia/Shanghai' });
    const d = await run(daily.id);
    assert.equal(d.status, 'active');
    assert.equal(d.failCount, 0);
    assert.equal(notices(daily.id).length, 1);
    // 「立即运行」: whoever pressed it hears why, every time.
    await run(every5.id, true);
    assert.equal(notices(every5.id).length, 2);

    // A real failure of the app still counts as before.
    (hub as any).runLocal = () => Promise.resolve({ ok: false, content: '', error: '脚本退出码 1' });
    const f = await run(every5.id);
    assert.equal(f.lastStatus, 'failed');
    assert.equal(f.failCount, 1);
    assert.equal(notices(every5.id).length, 3);

    // Unreachable for a day: most likely gone for good, so the schedule pauses and its creator hears why.
    (hub as any).runLocal = () => Promise.resolve({ ok: false, unreachable: true, content: '', error: '执行端 box 离线（最后在线：…），这次没有执行' });
    const gone = await mk({ kind: 'minutely', every: 5, tz: 'Asia/Shanghai' });
    assert.equal((await run(gone.id)).status, 'active');
    (sch as any).unreachableSince.set(gone.id, Date.now() - UNREACHABLE_PAUSE_MS - 1000);
    const g = await run(gone.id);
    assert.equal(g.status, 'paused');
    assert.equal(g.pauseReason, UNREACHABLE_PAUSED);
    assert.match(FakeFeishu.text(notices(gone.id).at(-1)!.card), /超过 24 小时连不上，任务已暂停/);
  } finally { await env.close(); }
});
