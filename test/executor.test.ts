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
    // env set is only a shorthand for a definition in the one JSON format; --print shows it, export gives it back.
    const printed = JSON.parse(await cli(dir, 'env', 'set', 'e', data, '--readonly', '--print'));
    assert.deepEqual(printed, { format: 'amber-env/1', name: 'e', workdir: data, access: { readOnly: ['{WORKDIR}'] } });
    await cli(dir, 'env', 'set', 'e', data, '--readonly');
    const exported = JSON.parse(await cli(dir, 'env', 'export', 'e'));
    assert.deepEqual(exported, printed, 'the file in envs/ is the definition itself');
    writeFileSync(join(base, 'e.json'), JSON.stringify(exported));
    const before = readFileSync(join(dir, 'envs', 'e.json'), 'utf8');
    await cli(dir, 'env', 'import', join(base, 'e.json'));
    assert.equal(readFileSync(join(dir, 'envs', 'e.json'), 'utf8'), before, 'export → import is a no-op');
    writeFileSync(join(base, 'e2.json'), JSON.stringify({ ...exported, format: 'amber-env/2' }));
    await assert.rejects(cli(dir, 'env', 'import', join(base, 'e2.json')), /不认识的格式版本/);
    // The checklist in docs/environment-format.md, at import.
    writeFileSync(join(data, 'afile'), 'x');
    for (const [bad, msg] of [
      [{ workdir: join(data, 'afile') }, /不是已存在的目录/], [{ workdir: data + '/../d' }, /不能含 \.\./],
      [{ python: '/usr/bin/node' }, /Python 解释器/], [{ realHome: 'yes' }, /true 或 false/], [{ source: 1 }, /字符串/],
      [{ vars: { A: 'x'.repeat(1025) } }, /1024/], [{ vars: { A: 1 } }, /要是字符串/], [{ vars: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, 'x'])) }, /最多 20 个/],
      [{ access: { readWrit: [data] } }, /不认识的字段/],
    ] as [Record<string, unknown>, RegExp][]) {
      writeFileSync(join(base, 'bad.json'), JSON.stringify({ ...exported, ...bad }));
      await assert.rejects(cli(dir, 'env', 'import', join(base, 'bad.json')), msg, JSON.stringify(bad).slice(0, 80));
    }
    rmSync(join(data, 'afile'));
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
    const body = JSON.stringify({ name: 'web-box', envs: { e: { workdir: '/tmp/x' }, mine: { workdir: '/tmp/y', source: 'botmux:cli_me', realHome: true, access: { readWrite: ['/tmp/y', '/tmp/secret-list'] } } }, signPub, boxPub });
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
    assert.deepEqual((await fetch(`http://127.0.0.1:${env.apiPort}/v1/envs`).then(x => x.json())).executors, [], 'pending executors are not offered to agents');
    assert.equal(ex.fingerprint, showFingerprint(fingerprint(signPub, boxPub)));
    assert.equal((await post(aliceC, `/web/api/executors/${id}/approve`, { h: ex.h })).status, 400, 'needs confirm');
    assert.match((await post(aliceC, `/web/api/executors/${id}/approve`, { confirm: true, h: '0'.repeat(16) })).body.message, /已经变了/);
    assert.equal((await post(aliceC, `/web/api/executors/${id}/approve`, { confirm: true, h: ex.h })).body.status, 'approved');
    assert.equal(env.amber.store.approvedExecutor('web-box')?.id, id);
    // Agents list environments by name (amber envs): approved only, no path lists; --mine picks the bot's own.
    const envsApi = await fetch(`http://127.0.0.1:${env.apiPort}/v1/envs`).then(x => x.json());
    assert.deepEqual(envsApi.executors.map((x: any) => x.name), ['web-box']);
    assert.ok(!JSON.stringify(envsApi).includes('/tmp/secret-list'), 'no access lists for agents');
    const cliEnv = { ...process.env, AMBER_URL: `http://127.0.0.1:${env.apiPort}`, BOTMUX_LARK_APP_ID: 'cli_me' };
    const all = (await promisify(execFile)('python3', [join(ROOT, 'client', 'amber'), 'envs'], { env: cliEnv, encoding: 'utf8' })).stdout;
    assert.match(all, /web-box\/e\t/);
    assert.match(all, /web-box\/mine\t在线|web-box\/mine\t离线/);
    assert.match(all, /web-box\/mine.*← 你自己的环境/);
    const mineOut = (await promisify(execFile)('python3', [join(ROOT, 'client', 'amber'), 'envs', '--mine'], { env: cliEnv, encoding: 'utf8' })).stdout;
    assert.match(mineOut, /web-box\/mine/);
    assert.doesNotMatch(mineOut, /web-box\/e\t/);
    const other = (await promisify(execFile)('python3', [join(ROOT, 'client', 'amber'), 'envs', '--mine'], { env: { ...cliEnv, BOTMUX_LARK_APP_ID: 'cli_other' }, encoding: 'utf8' })).stdout;
    assert.match(other, /没有找到属于你的运行环境/);
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
    const d = await exp('--bot', 'cli_x', '--name', '结算助手');
    assert.equal(d.name, '结算助手');
    assert.equal(d.format, 'amber-env/1');
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
    // Other bots.json shapes: wrapped and keyed by appId; anything else is refused clearly.
    const bj = join(home, '.botmux', 'bots.json');
    const entry = { larkAppId: 'cli_x', workingDir: work };
    for (const shape of [{ bots: [entry] }, { cli_x: entry }]) {
      writeFileSync(bj, JSON.stringify(shape));
      assert.equal((await exp('--bot', 'cli_x')).workdir, work, JSON.stringify(shape));
    }
    writeFileSync(bj, JSON.stringify({ version: 2, things: 1 }));
    await assert.rejects(exp('--bot', 'cli_x'), /格式不认识/);
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
  for (const f of ['/u/.cargo/credentials.toml', '/u/.gem/credentials', '/u/.m2/settings.xml', '/u/.m2/settings-security.xml', '/u/.gradle/gradle.properties']) {
    const t2 = FakeFeishu.text(executorApprovalCard({ ...row, envs: { e: { workdir: '/u/w', access: { readOnly: [f] } } } }, 'h'));
    assert.match(t2, /含凭证路径/, f);
  }
  // A plain directory environment: {WORKDIR} read-write, no warning for it.
  assert.equal((t.match(/含凭证路径/g) ?? []).length, 1);
});

test('executor: a script calls a registered service through Amber\'s relay — same code as on Amber, nothing else reachable', async () => {
  const { createServer } = await import('node:http');
  const seen: { auth?: string; body: string; path?: string }[] = [];
  const svc = createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
      seen.push({ auth: req.headers.authorization, body: b, path: req.url });
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ status: 'success', rows: [{ n: seen.length }], echo: b }));
    });
  });
  await new Promise<void>(r => svc.listen(0, '127.0.0.1', () => r()));
  const svcPort = (svc.address() as any).port;
  const env = await makeEnv({ services: { demo: { audience: 'demo', tcpPort: svcPort, executor: true }, demo2: { audience: 'demo2', tcpPort: svcPort, executor: true }, localonly: { audience: 'localonly', tcpPort: svcPort } } });
  const base = join(H, `.amber-exectest3-${process.pid}`);
  const dir = join(base, 'conf'), data = join(base, 'd');
  mkdirSync(data, { recursive: true });
  let child: ChildProcess | undefined;
  const execLog: string[] = [];
  try {
    const { alice, fake } = env;
    env.amber.hub.pollWaitMs = 500;
    await cli(dir, 'init', '--name', 'svcbox', '--amber', `http://127.0.0.1:${env.apiPort}`);
    await cli(dir, 'env', 'set', 'e', data);
    child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir } });
    child.stdout!.on('data', b => { execLog.push(String(b)); });
    child.stderr!.on('data', b => { execLog.push(String(b)); });
    const reg = await env.waitFor(() => fake.sent.find(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card))));
    await env.click(alice, reg.id, button(reg.card, 'exe_ok')!);
    // A service an admin has not opened to executors is refused at submit time.
    const no = await env.submit({ chatId: GROUP, chatType: 'group', name: '不行', params: [], script: script('print(1)', { env: 'svcbox/e', services: { localonly: { calls: 1 } } }) });
    assert.equal(no.ok, false);
    assert.match(no.message, /不允许在执行端上调用/);
    // The same code a command uses on Amber's machine (127.0.0.1:tcpPort, Authorization: Amber <token>).
    const code = `import json,sys,urllib.request,urllib.error
inp=json.load(sys.stdin)
svc=inp["services"]["demo"]
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def q(i, tok):
    req=urllib.request.Request("http://127.0.0.1:%d/amber/query" % svc["tcpPort"], data=json.dumps({"sql":"select %d" % i}).encode(),
        headers={"Authorization":"Amber "+tok,"Content-Type":"application/json"})
    try:
        r=op.open(req, timeout=20); return "%d %s" % (r.status, json.load(r)["rows"][0]["n"])
    except urllib.error.HTTPError as e: return "http %d" % e.code
    except Exception as e: return type(e).__name__
print("call1", q(1, svc["tokens"][0]))
print("call2", q(2, svc["tokens"][1]))
print("call3", q(3, "spare"))
print("ports", svc["tcpPort"] != ${svcPort})
try:
    urllib.request.urlopen("http://127.0.0.1:${svcPort}/health", timeout=3); print("direct reached")
except Exception as e: print("direct", type(e).__name__)
`;
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '远程查数', params: [], script: script(code, { env: 'svcbox/e', services: { demo: { calls: 2 } } }) }, alice);
    const before = seen.length;
    await env.say(alice, GROUP, '远程查数');
    const card = await env.waitFor(() => fake.sent.map(s => fake.cardOf(s.id)).find(c => c?.header?.title?.content === 'Amber · 远程查数' && /call3/.test(FakeFeishu.text(c))));
    const t = FakeFeishu.text(card);
    assert.match(t, /call1 200 \d+/);
    assert.match(t, /call2 200 \d+/);
    assert.match(t, /call3 http 403/, 'no more calls than declared');
    assert.match(t, /ports True/, 'the script gets a local relay port, not the service address');
    assert.doesNotMatch(t, /direct reached/, 'the service itself is not reachable from the sandbox');
    // The service saw exactly the two declared calls, with Amber's tokens and the script's body, unchanged.
    const calls = seen.slice(before);
    assert.equal(calls.length, 2);
    for (const c of calls) { assert.match(c.auth!, /^Amber eyJ/); assert.equal(c.path, '/amber/query'); }
    assert.match(calls[0].body, /select 1/);
    // The relay is only for the executor a running job went to.
    const k = newExecutorKeys();
    const sp = pubB64(createPublicKey(keyFromPem(k.signKey))), bp = pubB64(createPublicKey(keyFromPem(k.boxKey)));
    const myId = fingerprint(pubB64(createPublicKey(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')))), pubB64(createPublicKey(keyFromPem(readFileSync(join(dir, 'box-key.pem'), 'utf8'))))).slice(0, 16);
    const rb = JSON.stringify({ jobId: 'nope', reqId: '0'.repeat(32), service: 'demo', method: 'POST', path: '/amber/query', body: '' });
    const st = await fetch(`http://127.0.0.1:${env.apiPort}/v1/executor/relay`, { method: 'POST', body: rb, headers: signRequest(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')), myId, 'POST', '/v1/executor/relay', rb) }).then(x => x.status);
    assert.equal(st, 403, 'no such running job');
    const st2 = await fetch(`http://127.0.0.1:${env.apiPort}/v1/executor/relay`, { method: 'POST', body: rb, headers: signRequest(keyFromPem(k.signKey), fingerprint(sp, bp).slice(0, 16), 'POST', '/v1/executor/relay', rb) }).then(x => x.status);
    assert.equal(st2, 401, 'unknown executor');
    // Another executor's running job, or one not yet picked up: refused.
    const hub: any = env.amber.hub;
    for (const [jid, job, service] of [['other-exec', { executorId: 'ffffffffffffffff', picked: true, calls: { demo: 1 } }, 'demo'], ['not-picked', { executorId: myId, picked: false, calls: { demo: 1 } }, 'demo'],
      ['closed-service', { executorId: myId, picked: true, calls: { localonly: 1 } }, 'localonly'], ['undeclared', { executorId: myId, picked: true, calls: { demo: 1 } }, 'demo2']] as const) {
      hub.jobs.set(jid, { ...job, envelope: {}, resolve() {}, timer: setTimeout(() => {}, 0) });
      const body = JSON.stringify({ jobId: jid, reqId: '0'.repeat(32), service, method: 'POST', path: '/amber/query', body: '' });
      const code = await fetch(`http://127.0.0.1:${env.apiPort}/v1/executor/relay`, { method: 'POST', body, headers: signRequest(keyFromPem(readFileSync(join(dir, 'sign-key.pem'), 'utf8')), myId, 'POST', '/v1/executor/relay', body) }).then(x => x.status);
      assert.equal(code, 403, jid);
      hub.jobs.delete(jid);
    }
    // An admin closing the service to executors takes effect for commands already approved.
    const { setServices } = await import('../src/runner.ts');
    setServices({ demo: { audience: 'demo', tcpPort: svcPort, executor: false } });
    const n0 = seen.length;
    await env.say(alice, GROUP, '远程查数');
    // Refused before dispatch: the stored definition is re-validated against the current service config.
    await env.waitFor(() => fake.sent.some(s => /不允许在执行端上调用/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    assert.equal(seen.length, n0, 'nothing reached the service');
    assert.ok(id);
  } catch (e) {
    console.error('EXECUTOR LOG\n' + execLog.join(''));
    const h: any = env.amber.hub;
    console.error('HUB', JSON.stringify({ queues: [...h.queues].map(([k, v]: any) => [k, v.length]), waiters: [...h.waiters.keys()], jobs: [...h.jobs].map(([k, v]: any) => [k, v.executorId, v.picked]), execs: env.amber.store.listExecutors().map((x: any) => [x.id, x.status, x.lastSeen && Date.now() - x.lastSeen]) }));
    console.error('AUDIT', JSON.stringify((env.amber.store as any).db.prepare("select action, detail from audit where action like 'executor.%' or action like 'run.%'").all()));
    throw e;
  } finally {
    child?.kill('SIGKILL');
    await env.close();
    svc.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('executor relay port: only the job\'s own tokens, each once; size limit; a finished job cancels its service requests', async () => {
  const { createServer } = await import('node:http');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const relayed: any[] = [];
  const amberKeys = generateKeyPairSync('ed25519');
  const { sign: edSign } = await import('node:crypto');
  const { relayResponseInput } = await import('../src/exec-proto.ts');
  let tamper = false;
  const amberStub = createServer((req, res) => { let b = ''; req.on('data', c => { b += c; }); req.on('end', () => {
    const q = JSON.parse(b); relayed.push(q);
    const r = { ok: true, status: 200, contentType: 'text/plain', body: Buffer.from('fine').toString('base64') };
    const sig = edSign(null, relayResponseInput(q.jobId, q.reqId, r), amberKeys.privateKey).toString('base64');
    res.writeHead(200, { 'content-type': 'application/json' });
    // tamper: an on-path party changes the body after Amber signed it
    res.end(JSON.stringify({ ...r, ...(tamper ? { body: Buffer.from('evil').toString('base64') } : {}), sig }));
  }); });
  await new Promise<void>(r => amberStub.listen(0, '127.0.0.1', () => r()));
  const dir = mkdtempSync(join(tmpdir(), 'amber-relay-unit-'));
  const k = newExecutorKeys();
  writeFileSync(join(dir, 'sign-key.pem'), k.signKey); writeFileSync(join(dir, 'box-key.pem'), k.boxKey);
  process.env.AMBER_EXECUTOR_DIR = dir;
  try {
    const ex = await import('../client/amber-executor/amber-executor.mjs' as string);
    // The module may already be loaded with another test's config dir: build the identity from these keys.
    const sp = pubB64(createPublicKey(keyFromPem(k.signKey))), bp = pubB64(createPublicKey(keyFromPem(k.boxKey)));
    const me = { sign: keyFromPem(k.signKey), id: fingerprint(sp, bp).slice(0, 16) };
    const cfg = { name: 'u', amber: `http://127.0.0.1:${(amberStub.address() as any).port}` };
    const r = await ex.startRelays(cfg, me, amberKeys.publicKey, 'job-1', { demo: { tokens: ['tokA', 'tokB', 'tokC'] } });
    const port = r.services.demo.tcpPort;
    const send = (auth?: string, body = '{}') => fetch(`http://127.0.0.1:${port}/amber/query`, { method: 'POST', body, headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) } }).then(async x => [x.status, await x.text()] as const);
    assert.equal((await send())[0], 403, 'no token: another local process');
    assert.equal((await send('Amber guessed'))[0], 403, 'not one of this job\'s tokens');
    assert.deepEqual(await send('Amber tokA'), [200, 'fine']);
    assert.equal((await send('Amber tokA'))[0], 403, 'each token once');
    assert.equal((await send('Amber tokB', 'x'.repeat(600 * 1024)))[0], 413);
    assert.deepEqual(await send('Amber tokB'), [200, 'fine'], 'a refused oversized request does not spend the token');
    tamper = true;
    const t = await send('Amber tokC');
    assert.equal(t[0], 502, 'an altered response never reaches the script');
    assert.doesNotMatch(t[1], /evil/);
    assert.equal(relayed.length, 3);
    relayed.pop();
    assert.deepEqual(relayed.map(x => [x.jobId, x.service, x.headers.authorization]), [['job-1', 'demo', 'Amber tokA'], ['job-1', 'demo', 'Amber tokB']]);
    r.close();
  } finally {
    delete process.env.AMBER_EXECUTOR_DIR;
    amberStub.close();
    rmSync(dir, { recursive: true, force: true });
  }
  // Amber side: when a job ends, its in-flight service requests are destroyed.
  const env = await makeEnv();
  try {
    const hub: any = env.amber.hub;
    const destroyed: string[] = [];
    const fakeReq = { destroy: () => destroyed.push('req') };
    hub.jobs.set('j-end', { executorId: 'x', picked: true, calls: {}, envelope: {}, resolve() {}, timer: setTimeout(() => {}, 0), inflight: new Set([fakeReq]) });
    hub.finish('j-end', { ok: false, content: '', error: 'timeout' });
    assert.deepEqual(destroyed, ['req']);
  } finally { await env.close(); }
});

test('followed environments (D53): changes within the approved follow apply at once and notify admins; others need approval', async () => {
  const { followDiff } = await import('../src/executors.ts');
  const base0 = { workdir: '/w', follow: '/f.json', source: 'botmux:cli_x', access: { readWrite: ['/w'] } };
  assert.equal(followDiff({ e: base0 }, { e: base0 }), null, 'nothing changed');
  assert.deepEqual(followDiff({ e: base0 }, { e: { ...base0, access: { readWrite: ['/w', '/new'], readOnly: ['/ro'] } } }), [{ env: 'e', added: { readWrite: ['/new'], readOnly: ['/ro'] }, removed: {}, vars: [] }]);
  for (const bad of [{ ...base0, workdir: '/other' }, { ...base0, follow: '/g.json' }, { ...base0, source: 'botmux:cli_y' }, { ...base0, realHome: true }]) assert.equal(followDiff({ e: base0 }, { e: bad }), null, JSON.stringify(bad));
  assert.equal(followDiff({ e: { workdir: '/w' } }, { e: { workdir: '/w', access: { readWrite: ['/w', '/x'] } } }), null, 'not following: approval');
  assert.equal(followDiff({ e: base0 }, { e: base0, f: { workdir: '/z' } }), null, 'a new environment: approval');
  assert.deepEqual(followDiff({ e: base0, f: { workdir: '/z' } }, { e: base0 }), [{ env: 'f', added: {}, removed: {}, vars: [], removedEnv: true }], 'removing one: allowed');
  assert.deepEqual(followDiff({ e: { workdir: '/w' } }, { e: { workdir: '/w', follow: '/envs/e.json' } }), [], 'moving to the folder with the same content: silent');
  assert.deepEqual(followDiff({ e: { workdir: '/w' } }, { e: { workdir: '/w', access: { readWrite: ['/w'] }, follow: '/envs/e.json' } }), [], 'the default access written out is the same content');
  assert.deepEqual(followDiff({ e: { workdir: '/w', interpreter: '/p/python3', access: { readOnly: ['/w'] } } }, { e: { access: { readOnly: ['/w'] }, workdir: '/w', interpreter: '/p/python3', follow: '/envs/e.json' } }), [], 'key order does not matter');
  assert.equal(followDiff({ e: { workdir: '/w' } }, { e: { workdir: '/w', follow: '/envs/e.json', access: { readWrite: ['/'] } } }), null, '…but not with other changes');
  assert.equal(followDiff({ e: base0 }, { e: { ...base0, access: { readWrite: ['/w', '/n'] } }, f: { workdir: '/z' } }), null, 'a followed change plus a new environment: approval');

  const env = await makeEnv();
  const base = join(H, `.amber-exectest4-${process.pid}`);
  const dir = join(base, 'conf'), data = join(base, 'd'), extra = join(base, 'extra');
  mkdirSync(data, { recursive: true }); mkdirSync(extra, { recursive: true });
  let child: ChildProcess | undefined;
  try {
    const { alice, bob, fake } = env;
    env.amber.hub.pollWaitMs = 300;
    await cli(dir, 'init', '--name', 'followbox', '--amber', `http://127.0.0.1:${env.apiPort}`);
    // Environments are the files in envs/: the folder is all the executor reads.
    mkdirSync(join(dir, 'envs'), { recursive: true });
    const defFile = join(dir, 'envs', 'bot.json');
    const def = { format: 'amber-env/1', name: 'bot', workdir: data, access: { readWrite: [data] }, source: 'botmux:cli_x' };
    writeFileSync(defFile, JSON.stringify(def));
    child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir, AMBER_EXECUTOR_FOLLOW_MS: '400' } });
    let execOut = '';
    child.stdout!.on('data', b => { execOut += b; });
    const cards = (re: RegExp) => fake.sent.filter(s => s.to.unionId === alice.unionId && re.test(FakeFeishu.text(s.card)));
    const reg = await env.waitFor(() => cards(/执行端申请登记/)[0]);
    assert.match(FakeFeishu.text(reg.card), /定义文件/);
    await env.click(alice, reg.id, button(reg.card, 'exe_ok')!);
    const id = env.amber.store.approvedExecutor('followbox')!.id;
    // The followed file gains a path: applied without approval, admins told what changed.
    writeFileSync(defFile, JSON.stringify({ ...def, access: { readWrite: [data], readOnly: [extra] }, vars: { API_HOST: 'https://new.example' } }));
    const notice = await env.waitFor(() => cards(/已自动更新/)[0]);
    assert.ok(FakeFeishu.text(notice.card).includes(extra));
    assert.match(FakeFeishu.text(notice.card), /API_HOST.*（新增）.*https:\/\/new\.example/, 'variable values shown to admins');
    assert.match(FakeFeishu.text(notice.card), /新增只读/);
    const row = env.amber.store.getExecutor(id)!;
    assert.equal(row.status, 'approved');
    assert.deepEqual(row.envs.bot.access?.readOnly, [extra]);
    // The revoke button on the notice: admins only.
    assert.match(JSON.stringify(await env.click(bob, notice.id, button(notice.card, 'exe_rv')!)), /只有管理员/);
    // A broken file is ignored (the last good version stays, still approved, nothing registered).
    const envsBefore = JSON.stringify(env.amber.store.getExecutor(id)!.envs);
    writeFileSync(defFile, '{ not json');
    await new Promise(r => setTimeout(r, 1500));
    assert.equal(JSON.stringify(env.amber.store.getExecutor(id)!.envs), envsBefore);
    assert.match(execOut, /env file not valid, keeping the last good version bot\.json/);
    assert.doesNotMatch(execOut, /environments changed: none/);
    assert.equal(env.amber.store.getExecutor(id)!.status, 'approved');
    writeFileSync(defFile, JSON.stringify({ ...def, access: { readWrite: [data], readOnly: [extra] }, vars: { API_HOST: 'https://new.example' } }));
    // A second file: a new environment needs approval; removing it again only shrinks access and applies at once.
    writeFileSync(join(dir, 'envs', 'more.json'), JSON.stringify({ workdir: extra }));
    await env.waitFor(() => env.amber.store.getExecutor(id)!.status === 'pending');
    await env.click(alice, (await env.waitFor(() => cards(/执行端申请登记/)[1])).id, button(cards(/执行端申请登记/)[1].card, 'exe_ok')!);
    await env.waitFor(() => env.amber.store.getExecutor(id)!.status === 'approved' && 'more' in env.amber.store.getExecutor(id)!.envs);
    rmSync(join(dir, 'envs', 'more.json'));
    const gone = await env.waitFor(() => cards(/已删除/)[0]);
    assert.match(FakeFeishu.text(gone.card), /环境「more」已删除/);
    assert.equal(env.amber.store.getExecutor(id)!.status, 'approved');
    assert.ok(!('more' in env.amber.store.getExecutor(id)!.envs));
    // A change outside the follow (WORKDIR) needs approval again.
    writeFileSync(defFile, JSON.stringify({ ...def, workdir: extra, access: { readWrite: [extra] } }));
    await env.waitFor(() => env.amber.store.getExecutor(id)!.status === 'pending');
    await env.waitFor(() => cards(/执行端申请登记/).length === 3);
    // While pending, even a followable change is not applied on its own: it is a new request to approve.
    writeFileSync(defFile, JSON.stringify({ ...def, workdir: extra, access: { readWrite: [extra], readOnly: [data] } }));
    await env.waitFor(() => cards(/执行端申请登记/).length === 4);
    assert.equal(env.amber.store.getExecutor(id)!.status, 'pending');
  } finally {
    child?.kill('SIGKILL');
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test('executor: environments kept in config.json by older versions move to the envs/ folder unchanged', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'amber-migrate-'));
  const data = mkdtempSync(join(tmpdir(), 'amber-migrate-data-'));
  try {
    const k = newExecutorKeys();
    writeFileSync(join(dir, 'sign-key.pem'), k.signKey); writeFileSync(join(dir, 'box-key.pem'), k.boxKey);
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ amber: 'http://127.0.0.1:9', name: 'old', envs: { 台账: { workdir: data }, 只读: { workdir: data, access: { readOnly: [data] }, interpreter: '/usr/bin/python3' } } }));
    const out = await cli(dir, 'env', 'show');
    assert.match(out, /台账：/); assert.match(out, /只读：/);
    const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(cfg.envs, undefined, 'moved out of config.json');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'envs', '只读.json'), 'utf8')), { format: 'amber-env/1', name: '只读', workdir: data, python: '/usr/bin/python3', access: { readOnly: [data] } });
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true }); }
});

test('export-botmux-env --out: writes the file only when the definition changed', async () => {
  const { mkdtempSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amber-exphome2-')));
  try {
    mkdirSync(join(home, '.botmux'), { recursive: true }); mkdirSync(join(home, 'w'));
    const bj = join(home, '.botmux', 'bots.json');
    writeFileSync(bj, JSON.stringify([{ larkAppId: 'cli_x', workingDir: join(home, 'w') }]));
    const out = join(home, 'out', 'env.json');
    const run = () => promisify(execFile)(process.execPath, [join(ROOT, 'client', 'amber-executor', 'export-botmux-env.mjs'), '--bot', 'cli_x', '--out', out], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.match((await run()).stdout, /updated/);
    const t1 = statSync(out).mtimeMs;
    await new Promise(r => setTimeout(r, 30));
    assert.doesNotMatch((await run()).stdout, /updated/, 'unchanged: not rewritten');
    assert.equal(statSync(out).mtimeMs, t1);
    writeFileSync(bj, JSON.stringify([{ larkAppId: 'cli_x', workingDir: join(home, 'w'), sandboxPaths: { readOnly: ['/opt/x'] } }]));
    assert.match((await run()).stdout, /updated/);
    assert.ok(JSON.parse(readFileSync(out, 'utf8')).access.readOnly.includes('/opt/x'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
