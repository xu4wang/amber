// Executors (D50): a real executor process registers, waits for an admin's approval, then runs
// reviewed commands next to their data, with exactly the access the approved environment grants (D51).
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
    // The environment comes from a definition file: the ledger readable, private denied, a variable for scripts.
    const defFile = join(base, 'env.json');
    // A definition that opens the executor's own keys is refused on import.
    writeFileSync(defFile, JSON.stringify({ name: '台账', workdir: data, access: { readOnly: [dir] } }));
    await assert.rejects(cli(dir, 'env', 'import', defFile), /受保护的目录/);
    writeFileSync(defFile, JSON.stringify({ name: '台账', workdir: data, access: { readOnly: ['{WORKDIR}'], deny: ['{WORKDIR}/private'] }, vars: { LEDGER_HINT: 'from-env' }, source: 'test:ledger' }));
    assert.match(await cli(dir, 'env', 'import', defFile), /只读/);

    // A command for that environment can be written and reviewed before the executor exists; runs fail clearly.
    const SPEC = { chatId: GROUP, chatType: 'group', name: '读台账', params: [], script: script(
      'import os,json,sys\ninp=json.load(sys.stdin)\n' +
      'def t(p):\n    try: return open(p).read()[:12]\n    except Exception as e: return type(e).__name__\n' +
      'w=os.environ["WORKDIR"]\nprint("ledger", t(w+"/ledger/march.txt"))\nprint("private", t(w+"/private/p.txt"))\n' +
      `print("key", t(${JSON.stringify(join(dir, 'box-key.pem'))}))\nprint("ssh", t(os.path.expanduser("~/.ssh/known_hosts")))\n` +
      'print("cwd", os.getcwd()==os.environ["HOME"])\nprint("token", inp.get("secrets",{}).get("API_TOKEN","NONE"))\n' +
      'print("hint", os.environ.get("LEDGER_HINT"))\n' +
      'try:\n    open(w+"/ledger/new.txt","w").write("x"); print("write ok")\nexcept Exception as e: print("write", type(e).__name__)\n',
      { env: 'ledger-box/台账', secrets: ['API_TOKEN'] }) };
    const r = await env.submit(SPEC);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(FakeFeishu.text(fake.cardOf(r.claimMessageId)), /执行位置.*ledger-box.*还没有登记/);
    // Commands cannot add paths of their own.
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
    assert.match(regText, /只读/);
    assert.match(regText, /禁止/);
    assert.match(regText, /LEDGER_HINT=from-env/);
    assert.match(regText, /test:ledger/);
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
    assert.match(t, /key PermissionError/, "the executor's own keys stay closed");
    assert.match(t, /hint from-env/);
    assert.match(t, /write PermissionError/, 'read-only environment');
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
    await cli(dir, 'env', 'set', 'e', data, '--readonly');
    const start = () => { child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir } }); };
    start();
    const cards = () => fake.sent.filter(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card)));
    const reg = await env.waitFor(() => cards()[0]);
    await env.click(alice, reg.id, button(reg.card, 'exe_ok')!);
    mkdirSync(join(data, 'a')); writeFileSync(join(data, 'a', 'x'), 'AAA'); mkdirSync(join(data, 'b')); writeFileSync(join(data, 'b', 'y'), 'BBB');
    const code = 'import os\ndef t(p):\n    try: return open(p).read()\n    except Exception as e: return type(e).__name__\nw=os.environ["WORKDIR"]\ntry:\n    open(w+"/a/new","w").write("x"); wr="write ok"\nexcept Exception as e: wr="write "+type(e).__name__\nprint("remote ok", t(w+"/a/x"), t(w+"/b/y"), wr)';
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '远程', params: [], script: script(code, { env: 'box2/e' }) }, alice);
    await env.say(alice, GROUP, '远程');
    // A read-only directory environment: the whole {WORKDIR} readable, nothing writable.
    await env.waitFor(() => fake.sent.some(s => /remote ok AAA BBB write PermissionError/.test(FakeFeishu.text(fake.cardOf(s.id)))));
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
    // An environment with realHome: HOME is the user's home (as in a bot's own session); vars reach the script.
    const homeSpec = { ...spec, script: { ...spec.script, code: 'import os\nprint("home", os.environ["HOME"], os.environ.get("XV"))' } };
    const cfgHome = { ...cfg, envs: { e: { workdir: work, realHome: true, vars: { XV: 'xv1' } } } };
    await ex.handle(cfgHome, me, amber.publicKey, job('j10', { spec: homeSpec, specHash: specHashOf(homeSpec) }));
    assert.equal(results.at(-1).content.trim(), `home ${homedir()} xv1`);
    // …and Python sees the user's site-packages there (packages the bot installed with pip --user), but not without realHome.
    const siteSpec = { ...spec, script: { ...spec.script, code: 'import site,sys\nprint("usersite", site.ENABLE_USER_SITE, sys.flags.isolated)' } };
    await ex.handle(cfgHome, me, amber.publicKey, job('j13', { spec: siteSpec, specHash: specHashOf(siteSpec) }));
    assert.match(results.at(-1).content, /usersite True 0/);
    await ex.handle(cfg, me, amber.publicKey, job('j14', { spec: siteSpec, specHash: specHashOf(siteSpec) }));
    assert.match(results.at(-1).content, /usersite False 1/);
    // Reserved variables cannot be set by an environment.
    await ex.handle({ ...cfg, envs: { e: { workdir: work, vars: { PATH: '/evil' } } } }, me, amber.publicKey, job('j11'));
    assert.match(results.at(-1).error, /PATH 不能设置/);
    // A job whose command still carries a sandbox field is refused.
    const old = { ...spec, script: { ...spec.script, sandbox: { readOnly: ['/'] } } };
    await ex.handle(cfg, me, amber.publicKey, job('j12', { spec: old, specHash: specHashOf(old) }));
    assert.match(results.at(-1).error, /不再声明 sandbox/);
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

test('executor: admins see and decide executors on the website; nobody else can', async () => {
  const env = await makeEnv();
  try {
    const { alice, bob, fake } = env;
    const { urlButton } = await import('./env.ts');
    const base = `http://127.0.0.1:${env.webPort}`;
    const login = async (u: any) => { await env.dm(u, '登录'); const r = await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' }); return r.headers.get('set-cookie')!.split(';')[0]; };
    const get = (cookie: string) => fetch(`${base}/web/api/overview`, { headers: { cookie } }).then(x => x.json());
    const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
    // An executor registers (signed with its own new key).
    const k = newExecutorKeys();
    const signPub = pubB64(createPublicKey(keyFromPem(k.signKey))), boxPub = pubB64(createPublicKey(keyFromPem(k.boxKey)));
    const id = fingerprint(signPub, boxPub).slice(0, 16);
    const body = JSON.stringify({ name: 'web-box', envs: { e: { workdir: '/tmp/x' } }, signPub, boxPub });
    const reg = await fetch(`http://127.0.0.1:${env.apiPort}/v1/executor/register`, { method: 'POST', body, headers: signRequest(keyFromPem(k.signKey), id, 'POST', '/v1/executor/register', body) }).then(x => x.json());
    assert.equal(reg.status, 'pending');
    // Amber checks an environment's shape too: reserved variables, relative paths, root.
    for (const bad of [{ vars: { PATH: '/evil' } }, { vars: { DYLD_INSERT_LIBRARIES: 'x' } }, { access: { readOnly: ['relative'] } }, { access: { readWrite: ['/'] } }, { access: { readOnly: ['/a/../b'] } }, { realHome: 'yes' }]) {
      const k2 = newExecutorKeys();
      const sp2 = pubB64(createPublicKey(keyFromPem(k2.signKey))), bp2 = pubB64(createPublicKey(keyFromPem(k2.boxKey)));
      const b2 = JSON.stringify({ name: 'bad-box', envs: { e: { workdir: '/tmp/x', ...bad } }, signPub: sp2, boxPub: bp2 });
      const st = await fetch(`http://127.0.0.1:${env.apiPort}/v1/executor/register`, { method: 'POST', body: b2, headers: signRequest(keyFromPem(k2.signKey), fingerprint(sp2, bp2).slice(0, 16), 'POST', '/v1/executor/register', b2) }).then(x => x.status);
      assert.equal(st, 400, JSON.stringify(bad));
    }
    // Not an admin: nothing listed, nothing allowed.
    const bobC = await login(bob);
    const bobView = await get(bobC);
    assert.equal(bobView.isAdmin, false);
    assert.equal(bobView.executors, undefined);
    assert.equal((await post(bobC, `/web/api/executors/${id}/approve`, { confirm: true, h: 'x' })).status, 403);
    // Admin: listed with the fingerprint; a decision is bound to what the page showed and needs confirming.
    const aliceC = await login(alice);
    const view = await get(aliceC);
    const ex = view.executors.find((e: any) => e.id === id);
    assert.equal(ex.status, 'pending');
    assert.equal(ex.fingerprint, showFingerprint(fingerprint(signPub, boxPub)));
    assert.equal((await post(aliceC, `/web/api/executors/${id}/approve`, { h: ex.h })).status, 400, 'needs confirm');
    assert.match((await post(aliceC, `/web/api/executors/${id}/approve`, { confirm: true, h: '0'.repeat(16) })).body.message, /已经变了/);
    assert.equal((await post(aliceC, `/web/api/executors/${id}/approve`, { confirm: true, h: ex.h })).body.status, 'approved');
    assert.equal(env.amber.store.approvedExecutor('web-box')?.id, id);
    // The Feishu card for the same registration is now stale.
    const card = fake.sent.find(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card)))!;
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'exe_ok')!)), /已经批准/);
    // Revoke: once.
    assert.equal((await post(bobC, `/web/api/executors/${id}/revoke`, { confirm: true })).status, 403);
    assert.equal((await post(aliceC, `/web/api/executors/${id}/revoke`, { confirm: true })).body.status, 'revoked');
    assert.equal(env.amber.store.approvedExecutor('web-box'), undefined);
    assert.equal((await post(aliceC, `/web/api/executors/${id}/revoke`, { confirm: true })).status, 400);
  } finally { await env.close(); }
});

test('export-botmux-env: a bot\'s access as an environment definition, mirroring its botmux sandbox', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { validateEnvAccess } = await import('../src/sandbox-policy.ts');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amber-exphome-')));
  try {
    const mk = (rel: string) => { mkdirSync(join(home, rel), { recursive: true }); return join(home, rel); };
    const work = mk('work'), extra = mk('extra');
    mk('.botmux/bots/cli_x'); mk('botmux-roles/cli_x/shared/default'); mk('.lark-cli-bots/cli_x');
    const store = mk('Library/Application Support/lark-cli');
    for (const f of ['master.key.file', 'appsecret_cli_x.enc', 'appsecret_cli_y.enc']) writeFileSync(join(store, f), 'k');
    writeFileSync(join(home, '.botmux', 'bots.json'), JSON.stringify([
      { larkAppId: 'cli_x', workingDir: work, sandbox: true, sandboxPaths: { readWrite: [extra], readOnly: ['/opt/shared'], deny: [join(work, 'secret')] } },
      { larkAppId: 'cli_y', workingDir: '/elsewhere' },
    ]));
    const exp = async (...a: string[]) => JSON.parse((await promisify(execFile)(process.execPath, [join(ROOT, 'client', 'amber-executor', 'export-botmux-env.mjs'), ...a], { env: { ...process.env, HOME: home }, encoding: 'utf8' })).stdout);
    const d = await exp('--bot', 'cli_x', '--name', '象钱看');
    assert.equal(d.name, '象钱看');
    assert.equal(d.workdir, work);
    assert.deepEqual(d.access.readWrite.sort(), [work, extra, join(home, '.botmux/bots/cli_x'), join(home, 'botmux-roles/cli_x'), join(home, '.lark-cli-bots/cli_x')].sort());
    assert.ok(d.access.readOnly.includes('/opt/shared'));
    assert.ok(d.access.readOnly.includes(join(store, 'appsecret_cli_x.enc')) && d.access.readOnly.includes(join(store, 'master.key.file')));
    assert.ok(!JSON.stringify(d).includes('appsecret_cli_y'), "another bot's secret is never included");
    assert.ok(d.access.deny.includes(join(home, '.botmux/bots/cli_x/send-cred.json')));
    assert.ok(d.access.deny.includes(join(work, 'secret')));
    assert.deepEqual(d.vars, { LARKSUITE_CLI_CONFIG_DIR: join(home, '.lark-cli-bots/cli_x') });
    assert.equal(d.realHome, true);
    assert.match(d.source, /botmux:cli_x/);
    // The definition passes the executor's own check (nothing under the hard-denied dirs).
    assert.doesNotThrow(() => validateEnvAccess(d.access, { workdir: d.workdir, home }));
    // Read-only variant: data read-only; the lark-cli config stays writable (token refresh).
    const r = await exp('--bot', 'cli_x', '--readonly');
    assert.deepEqual(r.access.readWrite, [join(home, '.lark-cli-bots/cli_x')]);
    assert.ok(r.access.readOnly.includes(work) && r.access.readOnly.includes(join(home, 'botmux-roles/cli_x')));
    await assert.rejects(exp('--bot', 'cli_nope'), /没有机器人/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('executor approval card: lists every path of each environment and flags credential paths', async () => {
  const { executorApprovalCard } = await import('../src/cards.ts');
  const row: any = { id: 'abcd1234abcd1234', name: 'prem', fingerprint: 'ab'.repeat(32), machine: 'm', version: '1', status: 'pending', envs: {
    bot: { workdir: '/u/work', access: { readWrite: ['/u/work', '/u/.botmux/bots/cli_x'], readOnly: ['/u/Library/Application Support/lark-cli/appsecret_cli_x.enc'], deny: ['/u/.botmux/bots/cli_x/send-cred.json'] }, vars: { LARKSUITE_CLI_CONFIG_DIR: '/u/.lark-cli-bots/cli_x' }, realHome: true, source: 'botmux:cli_x' },
    plain: { workdir: '/u/data' },
  } };
  const t = FakeFeishu.text(executorApprovalCard(row, 'h'));
  for (const s of ['/u/.botmux/bots/cli_x', 'appsecret_cli_x.enc', 'send-cred.json', 'LARKSUITE_CLI_CONFIG_DIR', 'botmux:cli_x', '用户主目录', '/u/data']) assert.ok(t.includes(s), s);
  assert.match(t, /含凭证路径/);
  // A plain directory environment: {WORKDIR} read-write, no warning for it.
  assert.equal((t.match(/含凭证路径/g) ?? []).length, 1);
});
