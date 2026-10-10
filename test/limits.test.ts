// Run limits (admin, on the website): how long a run may take, and how many may run at once — on Amber's own
// machine, on each executor, and per person. Over a limit a run is refused at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, urlButton, GROUP } from './env.ts';
import { checkLimits, effectiveTimeoutMs, RunSlots, DEFAULT_LIMITS, timeoutLabel, getLimits } from '../src/limits.ts';

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('limits: checked, applied to the run time, counted per place and per person', () => {
  assert.throws(() => checkLimits({ ...DEFAULT_LIMITS, defaultTimeoutSec: 700 }), /默认时限不能比最长时限长/);
  assert.throws(() => checkLimits({ ...DEFAULT_LIMITS, maxTimeoutSec: 1801 }), /5–1800/);
  assert.throws(() => checkLimits({ ...DEFAULT_LIMITS, maxConcurrentLocal: 0 }), /1–64/);
  assert.throws(() => checkLimits({ ...DEFAULT_LIMITS, maxConcurrentPerUser: 1.5 }), /整数/);
  assert.throws(() => checkLimits({ ...DEFAULT_LIMITS, executors: { 'Bad Name': 3 } }));
  assert.deepEqual(checkLimits({ ...DEFAULT_LIMITS, executors: { 'ledger-mac': 6 } }).executors, { 'ledger-mac': 6 });

  const L = { ...DEFAULT_LIMITS };
  assert.equal(effectiveTimeoutMs(undefined, L), 60_000, 'no time asked: the default');
  assert.equal(effectiveTimeoutMs(240_000, L), 240_000);
  assert.equal(effectiveTimeoutMs(900_000, L), 600_000, 'never more than the maximum now in force');
  assert.match(timeoutLabel(undefined, L), /1 分钟（默认）/);
  assert.match(timeoutLabel(900_000, L), /超过了现在的上限/);

  const slots = new RunSlots();
  const lim = { ...L, maxConcurrentLocal: 2, maxConcurrentExecutor: 1, executors: { big: 3 }, maxConcurrentPerUser: 2 };
  const a1 = slots.acquire('a', undefined, lim), b1 = slots.acquire('b', undefined, lim);
  assert.throws(() => slots.acquire('c', undefined, lim), /Amber 本机同时运行的应用已经到上限（2 个）/);
  const c1 = slots.acquire('c', 'small/env', lim);   // another machine has its own count
  assert.throws(() => slots.acquire('d', 'small/x', lim), /执行端 small 同时运行的应用已经到上限（1 个）/);
  slots.acquire('d', 'big/x', lim); slots.acquire('e', 'big/x', lim); slots.acquire('f', 'big/x', lim);
  assert.throws(() => slots.acquire('g', 'big/x', lim), /执行端 big/, 'an executor\'s own limit');
  assert.throws(() => slots.acquire('a', 'big/x', lim), /执行端 big/);
  const a2 = slots.acquire('a', 'small2/x', lim);
  assert.throws(() => slots.acquire('a', 'other/x', lim), /你已经有 2 个应用在运行/, 'per person, across places');
  a1(); a1();   // releasing twice is harmless
  assert.deepEqual(slots.snapshot().local, 1);
  slots.acquire('a', undefined, lim);
  b1(); c1(); a2();
  assert.equal(slots.snapshot()['exe:small'], undefined);
});

test('limits: set on the website by admins; enforced on submit and on runs', async () => {
  process.env.AMBER_WEB_RUN_WAIT_MS = '1500';
  const env = await makeEnv({ services: { demo: { audience: 'demo', tcpPort: 1 } } });
  const { alice, bob } = env;   // alice is an admin
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    const aliceCookie = await login(env, alice), bobCookie = await login(env, bob);
    // Only admins change them.
    assert.equal((await post(bobCookie, '/web/api/settings/run-limits', { maxTimeoutSec: 1200 })).status, 403);
    const bad = await post(aliceCookie, '/web/api/settings/run-limits', { defaultTimeoutSec: 900 });
    assert.equal(bad.body.ok, false, 'default longer than the maximum is refused');
    const set = await post(aliceCookie, '/web/api/settings/run-limits', { defaultTimeoutSec: 5, maxTimeoutSec: 300, maxConcurrentPerUser: 1 });
    assert.equal(set.body.ok, true);
    assert.deepEqual([getLimits(env.amber.store).defaultTimeoutSec, getLimits(env.amber.store).maxTimeoutSec, getLimits(env.amber.store).maxConcurrentLocal], [5, 300, 8], 'unchanged fields kept');
    const s = await (await fetch(base + '/web/api/settings', { headers: { cookie: aliceCookie } })).json();
    assert.equal(s.limits.maxTimeoutSec, 300);

    // Submit: asking for more than the maximum is refused.
    const over = await env.submit({ chatId: GROUP, chatType: 'group', name: '太久', params: [], script: script('print(1)', { timeoutMs: 301_000 }) });
    assert.equal(over.ok, false);
    assert.match(JSON.stringify(over), /最多 300000/);

    // Tokens last the run's time limit plus a minute.
    const ttl = 'import json,sys,base64\nt=json.load(sys.stdin)["services"]["demo"]["tokens"][0].split(".")[1]\np=json.loads(base64.urlsafe_b64decode(t+"=="*2))\nprint("ttl=%d" % (p["exp"]-p["iat"]))';
    const tid = await activate(env, { chatId: GROUP, chatType: 'group', name: '凭证', params: [], script: script(ttl, { timeoutMs: 180_000, services: { demo: { calls: 1 } } }) }, bob);
    const tr = await post(bobCookie, '/web/api/run', { scope: 'group:' + GROUP, commandId: tid, args: {} });
    assert.match(tr.body.markdown, /ttl=240/);

    // The default applies to an app that doesn't ask: 5 s, so a 7 s script is cut short. The website hands
    // the long run over as a job to poll; meanwhile bob (1 at a time) cannot start another.
    const slow = { ...script('import json,sys,time\ntime.sleep(int(json.load(sys.stdin)["params"]["secs"]))\nprint("done")'), timeoutMs: undefined };
    const sid = await activate(env, { chatId: GROUP, chatType: 'group', name: '慢', params: [{ name: 'secs', type: 'integer', default: '0' }], script: slow }, bob);
    const first = await post(bobCookie, '/web/api/run', { scope: 'group:' + GROUP, commandId: sid, args: { secs: '7' } });
    assert.equal(first.body.pending, true, 'still going after the short wait: a job to poll');
    const second = await post(bobCookie, '/web/api/run', { scope: 'group:' + GROUP, commandId: tid, args: {} });
    assert.equal(second.body.ok, false);
    assert.match(second.body.message, /你已经有 1 个应用在运行/);
    assert.equal((await fetch(`${base}/web/api/run-jobs/${first.body.job}`, { headers: { cookie: aliceCookie } })).status, 404, 'only the person who ran it sees the job');
    let r: any;
    for (let i = 0; i < 40; i++) {
      r = await (await fetch(`${base}/web/api/run-jobs/${first.body.job}`, { headers: { cookie: bobCookie } })).json();
      if (!r.pending) break;
      await new Promise(ok => setTimeout(ok, 250));
    }
    assert.equal(r.ok, false, 'cut short by the 5 s default');
    assert.match(r.error, /超时/);
    assert.equal((await fetch(`${base}/web/api/run-jobs/${first.body.job}`, { headers: { cookie: bobCookie } })).status, 404, 'handed over once, then gone');
    // Slot given back: bob can run again.
    assert.equal((await post(bobCookie, '/web/api/run', { scope: 'group:' + GROUP, commandId: tid, args: {} })).body.ok, true);
  } finally { delete process.env.AMBER_WEB_RUN_WAIT_MS; await env.close(); }
});

test('limits: an executor runs for the time Amber sends; older Amber (no time sent) keeps the app\'s own', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { specHashOf } = await import('../src/exec-proto.ts');
  process.env.AMBER_EXECUTOR_DIR = mkdtempSync(join(tmpdir(), 'amber-exe-'));
  const { prepare } = await import('../client/amber-executor/amber-executor.mjs');
  const workdir = mkdtempSync(join(tmpdir(), 'amber-wd-'));
  const cfg = { name: 'box', envs: { e: { workdir, access: { readWrite: [workdir] } } } };
  const spec = { name: 'x', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)', env: 'box/e', timeoutMs: 20_000 }, options: {} };
  const payload = { env: 'e', spec, specHash: specHashOf(spec) };
  assert.equal(prepare(cfg, { ...payload, timeoutMs: 420_000 }).timeoutMs, 420_000, 'the time Amber sends');
  assert.equal(prepare(cfg, payload).timeoutMs, 20_000, 'none sent: the app\'s own');
  assert.equal(prepare(cfg, { ...payload, timeoutMs: 99_000_000 }).timeoutMs, 1_800_000, 'never past the hard bound');
});

test('limits: an admin sets one executor\'s own cap; others cannot', async () => {
  const env = await makeEnv();
  const { alice, bob } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    env.amber.store.putExecutor({ id: 'abcd1234abcd1234', name: 'ledger-mac', fingerprint: 'f', signPub: 's', boxPub: 'b', envs: {}, machine: 'm', version: '1' });
    const aliceCookie = await login(env, alice), bobCookie = await login(env, bob);
    assert.equal((await post(bobCookie, '/web/api/executors/abcd1234abcd1234/limit', { value: 9 })).status, 403);
    assert.equal((await post(aliceCookie, '/web/api/executors/abcd1234abcd1234/limit', { value: 99 })).body.ok, false, 'out of bounds');
    const r = await post(aliceCookie, '/web/api/executors/abcd1234abcd1234/limit', { value: 6 });
    assert.equal(r.body.limit, 6);
    assert.deepEqual(getLimits(env.amber.store).executors, { 'ledger-mac': 6 });
    await post(aliceCookie, '/web/api/executors/abcd1234abcd1234/limit', { value: null });
    assert.deepEqual(getLimits(env.amber.store).executors, {}, 'back to the default');
  } finally { await env.close(); }
});
