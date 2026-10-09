// Executors (D50): a real executor process registers, waits for an admin's approval, then runs
// reviewed commands next to their data under the command's own sandbox policy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { sealJob, openJob, newExecutorKeys, keyFromPem, pubB64, signRequest, specHashOf, fingerprint, showFingerprint } from '../src/exec-proto.ts';
import { computeSpecHash } from '../src/db.ts';
import { runScript } from '../src/runner.ts';
import { createPublicKey } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'client', 'amber-executor', 'amber-executor.mjs');
const H = homedir();

test('executor: generated lib matches Amber sources', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-executor.mjs'), '--check'], { stdio: 'pipe' });
});

test('executor protocol: envelopes are bound to Amber, the addressee, time and content', () => {
  const amber = generateKeyPairSync('ed25519');
  const box = keyFromPem(newExecutorKeys().boxKey);
  const boxPub = pubB64(createPublicKey(box));
  const e = sealJob(amber.privateKey, 'exec1', boxPub, 'job1', 60_000, { jobId: 'job1', x: 'SECRET-VALUE' });
  assert.ok(!JSON.stringify(e).includes('SECRET-VALUE'), 'encrypted');
  assert.equal(openJob(amber.publicKey, 'exec1', box, e).x, 'SECRET-VALUE');
  assert.throws(() => openJob(amber.publicKey, 'exec2', box, e), /不是派给本执行端/);
  assert.throws(() => openJob(generateKeyPairSync('ed25519').publicKey, 'exec1', box, e), /签名不对/);
  assert.throws(() => openJob(amber.publicKey, 'exec1', box, e, Date.now() + 61_000), /过期/);
  assert.throws(() => openJob(amber.publicKey, 'exec1', box, { ...e, exp: e.exp + 1e6 }), /签名不对/);
  const ct = Buffer.from(e.ct, 'base64'); ct[0] ^= 1;
  assert.throws(() => openJob(amber.publicKey, 'exec1', box, { ...e, ct: ct.toString('base64') }), /签名不对/);
  // Another executor's key cannot decrypt even a correctly addressed, correctly signed envelope.
  const other = keyFromPem(newExecutorKeys().boxKey);
  assert.throws(() => openJob(amber.publicKey, 'exec1', other, e));
  // A payload whose jobId differs from the envelope's is refused.
  const f = sealJob(amber.privateKey, 'exec1', boxPub, 'job2', 60_000, { jobId: 'job1' });
  assert.throws(() => openJob(amber.publicKey, 'exec1', box, f), /与信封不符/);
  // Amber never runs a remote command on its own machine, whoever calls the runner.
  return runScript({ kind: 'script', lang: 'python', code: 'print("here")', env: 'a/b' }, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' }).then(r => {
    assert.equal(r.ok, false);
    assert.match(r.error!, /执行端/);
  }).then(() => {
  // The executor's spec hash is Amber's.
  const spec = { name: '读台账', params: [{ name: 'q', type: 'string' }], script: { kind: 'script', lang: 'python', code: 'print(1)', env: 'a/b' }, options: { confirm: false, schedulable: true } };
  assert.equal(specHashOf(spec), computeSpecHash(spec as any));
  });
});

/** Runs the executor CLI with its own config dir (async: Amber answers from this same process). */
async function cli(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [EXE, ...args], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir }, encoding: 'utf8' });
  return stdout;
}

test('executor: register → admin approval → runs next to the data, under the reviewed policy; revoke and offline fail runs', async () => {
  const env = await makeEnv();
  const base = join(H, `.amber-exectest-${process.pid}`);
  const dir = join(base, 'conf'), data = join(base, 'bot-data');
  mkdirSync(join(data, 'ledger'), { recursive: true });
  mkdirSync(join(data, 'private'), { recursive: true });
  writeFileSync(join(data, 'ledger', 'march.txt'), 'LEDGER-MARCH');
  writeFileSync(join(data, 'private', 'p.txt'), 'PRIVATE');
  let child: ChildProcess | undefined;
  let out = '';
  try {
    const { alice, bob, fake } = env;
    const hub = env.amber.hub;
    hub.pollWaitMs = 1500;
    const url = `http://127.0.0.1:${env.apiPort}`;
    const init = await cli(dir, 'init', '--name', 'ledger-box', '--amber', url);
    const fp = /公钥指纹：(.+)/.exec(init)![1].trim();
    assert.equal((readFileSync(join(dir, 'sign-key.pem')).length > 0), true);
    assert.equal(execFileSync('stat', ['-f', '%Lp', join(dir, 'sign-key.pem')], { encoding: 'utf8' }).trim(), '600');
    await cli(dir, 'env', 'set', '台账', data);

    // A command for that environment can be written and reviewed before the executor exists; runs fail clearly.
    const SPEC = { chatId: GROUP, chatType: 'group', name: '读台账', params: [], script: script(
      'import os,json,sys\ninp=json.load(sys.stdin)\n' +
      'def t(p):\n    try: return open(p).read()[:12]\n    except Exception as e: return type(e).__name__\n' +
      'w=os.environ["WORKDIR"]\nprint("ledger", t(w+"/ledger/march.txt"))\nprint("private", t(w+"/private/p.txt"))\n' +
      `print("key", t(${JSON.stringify(join(dir, 'box-key.pem'))}))\nprint("ssh", t(os.path.expanduser("~/.ssh/known_hosts")))\n` +
      'print("cwd", os.getcwd()==os.environ["HOME"])\nprint("token", inp.get("secrets",{}).get("API_TOKEN","NONE"))\n',
      { env: 'ledger-box/台账', sandbox: { readOnly: ['{WORKDIR}/ledger', '~'], deny: ['{WORKDIR}/private'] }, secrets: ['API_TOKEN'] }) };
    const r = await env.submit(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(FakeFeishu.text(fake.cardOf(r.claimMessageId)), /执行位置.*ledger-box.*还没有登记/);
    // {WORKDIR} only for commands with env; .. never.
    assert.equal((await env.submit({ ...SPEC, name: 'x1', script: { ...SPEC.script, env: undefined } })).ok, false);
    assert.equal((await env.submit({ ...SPEC, name: 'x2', script: { ...SPEC.script, sandbox: { readOnly: ['{WORKDIR}/../.ssh'] } } })).ok, false);
    assert.equal((await env.submit({ ...SPEC, name: 'x3', script: { ...SPEC.script, env: 'Bad Name/x' } })).ok, false);

    // Start the executor: it registers and every admin gets a card with the same fingerprint.
    child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir } });
    child.stdout!.on('data', b => { out += b; });
    child.stderr!.on('data', b => { out += b; });
    const reg = await env.waitFor(() => fake.sent.find(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card))));
    const regText = FakeFeishu.text(reg.card);
    assert.ok(regText.includes(fp), 'card shows the fingerprint the installer saw');
    assert.match(regText, /ledger-box/);
    assert.ok(regText.includes(realpathSync(data)) || regText.includes(data));
    const ok = button(reg.card, 'exe_ok')!;
    // Pending: nothing is dispatched.
    await env.click(alice, r.claimMessageId, { a: 'sec_form', c: r.id });
    const form = fake.lastTo(s => s.to.unionId === alice.unionId && /API_TOKEN/.test(FakeFeishu.text(s.card)))!;
    await env.click(alice, form.id, { a: 'sec_save', c: r.id }, { API_TOKEN: 'tok-SECRET-123456' });
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    await env.waitFor(() => /没有被管理员批准/.test(FakeFeishu.text(fake.cardOf(r.claimMessageId))));
    // Only admins approve, and only what the card showed.
    assert.match(JSON.stringify(await env.click(bob, reg.id, ok)), /只有管理员/);
    assert.match(JSON.stringify(await env.click(alice, reg.id, { ...ok, h: 'x' + ok.h.slice(1) })), /已经变了/);
    const decided = await env.click(alice, reg.id, ok);
    assert.match(JSON.stringify(decided), /已批准/);
    await env.waitFor(() => /approved; waiting/.test(out));

    // Trial: runs on the executor with the ledger readable, everything else closed, the secret masked.
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    const tried = await env.waitFor(() => button(fake.cardOf(r.claimMessageId), 'claim_submit') && fake.cardOf(r.claimMessageId));
    const t = FakeFeishu.text(tried);
    assert.match(t, /ledger LEDGER-MARCH/);
    assert.match(t, /private PermissionError/, 'a deeper deny wins');
    assert.match(t, /key PermissionError/, "the executor's own keys stay closed even with ~ readable");
    assert.match(t, /ssh (PermissionError|FileNotFoundError)/);
    assert.match(t, /cwd True/);
    assert.match(t, /token \*\*\*/);
    assert.doesNotMatch(t, /tok-SECRET-123456/);
    assert.ok(!out.includes('tok-SECRET-123456'), 'the executor log never has the value');
    await env.click(alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    await env.approveLatest();
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'active');

    // Signed requests only: no signature, a replayed one, or someone else's key are refused.
    const poll = (headers: Record<string, string>, body = '{}') => fetch(url + '/v1/executor/poll', { method: 'POST', body, headers }).then(x => x.status);
    assert.equal(await poll({}), 401);
    const k = newExecutorKeys();
    const myId = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')) && fingerprint(pubB64(createPublicKey(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')))), pubB64(createPublicKey(keyFromPem(readFileSync(join(dir, 'box-key.pem'), 'utf8'))))).slice(0, 16);
    assert.equal(await poll(signRequest(keyFromPem(k.signKey), myId, 'POST', '/v1/executor/poll', '{}')), 401, 'impostor key');
    const good = signRequest(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')), myId, 'POST', '/v1/executor/poll', '{}');
    assert.equal(await poll(good), 200);
    assert.equal(await poll(good), 401, 'replayed nonce');
    assert.equal(await poll(signRequest(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')), myId, 'POST', '/v1/executor/poll', '{}'), '{"x":1}'), 401, 'body bound to signature');
    // Registering someone else's public key without holding it is refused (proof of possession).
    const victim = newExecutorKeys(), thief = newExecutorKeys();
    const vSign = pubB64(createPublicKey(keyFromPem(victim.signKey))), vBox = pubB64(createPublicKey(keyFromPem(victim.boxKey)));
    const regBody = JSON.stringify({ name: 'thief', envs: { e: { workdir: '/tmp' } }, signPub: vSign, boxPub: vBox });
    const regRes = await fetch(url + '/v1/executor/register', { method: 'POST', body: regBody, headers: signRequest(keyFromPem(thief.signKey), fingerprint(vSign, vBox).slice(0, 16), 'POST', '/v1/executor/register', regBody) });
    assert.equal(regRes.status, 401);

    // Revoked: runs fail at once and the executor stops getting jobs.
    await env.say(alice, GROUP, '撤销执行端 ledger-box');
    assert.equal(env.amber.store.approvedExecutor('ledger-box'), undefined);
    await env.say(bob, GROUP, '读台账');
    await env.waitFor(() => fake.sent.some(s => /没有被管理员批准/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    await env.waitFor(() => /status: revoked/.test(out));
    assert.equal(fp, showFingerprint(env.amber.store.listExecutors()[0].fingerprint));
  } finally {
    child?.kill('SIGKILL');
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('executor: offline fails the run at once; a changed environment needs approval again', async () => {
  const env = await makeEnv();
  const base = join(H, `.amber-exectest2-${process.pid}`);
  const dir = join(base, 'conf'), data = join(base, 'd');
  mkdirSync(data, { recursive: true });
  let child: ChildProcess | undefined;
  try {
    const { alice, fake } = env;
    const hub = env.amber.hub;
    hub.pollWaitMs = 500;
    hub.onlineMs = 1500;
    await cli(dir, 'init', '--name', 'box2', '--amber', `http://127.0.0.1:${env.apiPort}`);
    await cli(dir, 'env', 'set', 'e', data);
    const start = () => { child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir } }); };
    start();
    const cards = () => fake.sent.filter(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card)));
    const reg = await env.waitFor(() => cards()[0]);
    await env.click(alice, reg.id, button(reg.card, 'exe_ok')!);
    mkdirSync(join(data, 'a')); writeFileSync(join(data, 'a', 'x'), 'AAA'); mkdirSync(join(data, 'b')); writeFileSync(join(data, 'b', 'y'), 'BBB');
    const code = 'import os\ndef t(p):\n    try: return open(p).read()\n    except Exception as e: return type(e).__name__\nw=os.environ["WORKDIR"]\nprint("remote ok", t(w+"/a/x"), t(w+"/b/y"))';
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '远程', params: [], script: script(code, { env: 'box2/e', sandbox: { readOnly: ['{WORKDIR}/a'] } }) }, alice);
    await env.say(alice, GROUP, '远程');
    await env.waitFor(() => fake.sent.some(s => /remote ok AAA PermissionError/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    // A policy that opens the executor's own config dir is refused there (Amber cannot know that path).
    const steal = await env.submit({ chatId: GROUP, chatType: 'group', name: '偷钥匙', params: [], script: script('print(1)', { env: 'box2/e', sandbox: { readOnly: [dir] } }) });
    await env.click(alice, steal.claimMessageId, { a: 'claim_try', c: steal.id });
    await env.waitFor(() => /执行端：.*受保护的目录/.test(FakeFeishu.text(fake.cardOf(steal.claimMessageId))));
    // Full executor: a job beyond its 4 parallel slots fails at once instead of waiting for the result timeout.
    const slow = { name: 'slow', params: [], script: { kind: 'script', lang: 'python', code: 'import time\ntime.sleep(3)\nprint("slow")', timeoutMs: 15000, env: 'box2/e' }, options: { confirm: false, schedulable: false } };
    const input = { params: {}, caller: { unionId: alice.unionId, chatId: GROUP, channel: 'bot' }, runId: 'r' };
    const t1 = Date.now();
    const five = await Promise.all(Array.from({ length: 5 }, () => hub.run(slow.script as any, slow, specHashOf(slow), input).then(r => ({ ...r, at: Date.now() - t1 }))));
    const busy = five.filter(r => !r.ok);
    assert.equal(busy.length, 1, JSON.stringify(five));
    assert.match(busy[0].error!, /繁忙/);
    assert.ok(busy[0].at < 2500, `refused at once, not after the timeout (${busy[0].at}ms)`);
    assert.equal(five.filter(r => r.ok && /slow/.test(r.content)).length, 4);
    // Offline: killed, and not seen for longer than onlineMs.
    child!.kill('SIGKILL');
    // Still counted online for a moment: at most maxJobs wait for it, the next fails at once.
    hub.maxJobs = 2;
    const waiting = [hub.run(slow.script as any, slow, specHashOf(slow), input), hub.run(slow.script as any, slow, specHashOf(slow), input)];
    const over = await hub.run(slow.script as any, slow, specHashOf(slow), input);
    assert.match(over.error!, /任务太多/);
    void waiting;
    await new Promise(r => setTimeout(r, 2200));
    const t0 = Date.now();
    await env.say(alice, GROUP, '远程');
    await env.waitFor(() => fake.sent.some(s => /离线/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    assert.ok(Date.now() - t0 < 3000, 'fails at once, nothing queued');
    // A new environment list: back to pending, a new card, runs refused until approved.
    await cli(dir, 'env', 'set', 'e2', data);
    start();
    await env.waitFor(() => cards().length === 2);
    assert.equal(env.amber.store.approvedExecutor('box2'), undefined);
    assert.ok(id);
  } finally {
    child?.kill('SIGKILL');
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('executor: its own checks — replay, spec hash, environment — before anything runs', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'amber-exec-unit-'));
  const work = mkdtempSync(join(tmpdir(), 'amber-exec-work-'));
  const results: any[] = [];
  const server = createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => { results.push(JSON.parse(b)); res.end('{"ok":true}'); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  try {
    const k = newExecutorKeys();
    writeFileSync(join(dir, 'sign-key.pem'), k.signKey);
    writeFileSync(join(dir, 'box-key.pem'), k.boxKey);
    process.env.AMBER_EXECUTOR_DIR = dir;
    const ex = await import('../client/amber-executor/amber-executor.mjs' as string);
    const me = ex.identity();
    const amber = generateKeyPairSync('ed25519');
    const cfg = { name: 'unit', amber: `http://127.0.0.1:${(server.address() as any).port}`, envs: { e: { workdir: work } } };
    const spec = { name: 'u', params: [], script: { kind: 'script', lang: 'python', code: 'print("ran")', timeoutMs: 15000, env: 'unit/e' }, options: { confirm: false, schedulable: false } };
    const job = (jobId: string, over: Record<string, unknown> = {}) => sealJob(amber.privateKey, me.id, me.boxPub, jobId, 60_000, { jobId, runId: 'r', env: 'e', spec, specHash: specHashOf(spec), input: { params: {} }, ...over });
    const one = job('j1');
    await ex.handle(cfg, me, amber.publicKey, one);
    await ex.handle(cfg, me, amber.publicKey, one);
    assert.equal(results.length, 1, 'a replayed envelope does not run again');
    assert.equal(results[0].ok, true);
    assert.match(results[0].content, /ran/);
    await ex.handle(cfg, me, amber.publicKey, job('j2', { specHash: 'f'.repeat(64) }));
    assert.match(results.at(-1).error, /规格哈希不符/);
    await ex.handle(cfg, me, amber.publicKey, job('j3', { env: 'other' }));
    assert.match(results.at(-1).error, /不是本执行端的环境/);
    const other = { ...spec, script: { ...spec.script, env: 'unit/missing' } };
    await ex.handle(cfg, me, amber.publicKey, job('j4', { env: 'missing', spec: other, specHash: specHashOf(other) }));
    assert.match(results.at(-1).error, /没有环境「missing」/);
    // Secrets are masked before the output leaves the machine.
    await ex.handle(cfg, me, amber.publicKey, job('j6', { spec: { ...spec, script: { ...spec.script, code: 'import json,sys\nprint(json.load(sys.stdin)["secrets"]["S"])' } }, specHash: specHashOf({ ...spec, script: { ...spec.script, code: 'import json,sys\nprint(json.load(sys.stdin)["secrets"]["S"])' } }), input: { params: {}, secrets: { S: 'secret-val-1' } } }));
    assert.equal(results.at(-1).ok, true);
    assert.match(results.at(-1).content, /^\*\*\*/);
    // A failing script's error is masked in the executor's own log too.
    const logged: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { logged.push(a.join(' ')); };
    try {
      const boom = { ...spec, script: { ...spec.script, code: 'import json,sys\nraise Exception(json.load(sys.stdin)["secrets"]["S"])' } };
      await ex.handle(cfg, me, amber.publicKey, job('j7', { spec: boom, specHash: specHashOf(boom), input: { params: {}, secrets: { S: 'secret-val-2' } } }));
    } finally { console.log = orig; }
    assert.equal(results.at(-1).ok, false);
    assert.ok(logged.some(l => /job done j7 failed/.test(l)), logged.join('\n'));
    assert.ok(!logged.join('\n').includes('secret-val-2'), 'log masked');
    assert.ok(!results.at(-1).error.includes('secret-val-2'), 'result masked');
    // Busy: answered at once, only for jobs really addressed to this executor.
    await ex.handleBusy(cfg, me, amber.publicKey, job('j8'));
    assert.match(results.at(-1).error, /繁忙/);
    const m = results.length;
    await ex.handleBusy(cfg, me, generateKeyPairSync('ed25519').publicKey, job('j9'));
    assert.equal(results.length, m);
    // Not signed by the pinned Amber key: dropped without an answer.
    const n = results.length;
    await ex.handle(cfg, me, generateKeyPairSync('ed25519').publicKey, job('j5'));
    assert.equal(results.length, n);
  } finally {
    delete process.env.AMBER_EXECUTOR_DIR;
    server.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  }
});
