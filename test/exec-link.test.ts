// Link-mode executors (D58): Amber connects to the executor (a machine it can reach that cannot reach it) and carries
// the executor's own signed requests to the same handlers as the API. Only Amber, for that one link name, can take the
// executor's requests or answer them; the executor may only register under the link's name; services stay closed
// to it unless they allow links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { makeEnv, activate, button, script, GROUP, claimsService, callForClaims } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { ExecutorLinks, validateLinks } from '../src/exec-link.ts';
import { executorRequest } from '../src/api.ts';
import { signLinkRequest } from '../src/exec-proto.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'client', 'amber-executor', 'amber-executor.mjs');

const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });
async function cli(dir: string, ...args: string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(process.execPath, [EXE, ...args], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir }, encoding: 'utf8' });
  return stdout;
}

test('executor links: configuration is checked', () => {
  assert.deepEqual(validateLinks(undefined), []);
  assert.equal(validateLinks([{ name: 'sgvps', url: 'https://runner.example.com/' }])[0].url, 'https://runner.example.com');
  assert.throws(() => validateLinks([{ name: 'Bad Name', url: 'https://x' }]), /name/);
  assert.throws(() => validateLinks([{ name: 'a', url: 'http://runner.example.com' }]), /https/);
  assert.throws(() => validateLinks([{ name: 'a', url: 'https://x' }, { name: 'a', url: 'https://y' }]), /重复/);
  assert.throws(() => validateLinks([{ name: 'a', url: 'https://x', tlsFingerprint: 'abc' }]), /SHA-256/);
  assert.equal(validateLinks([{ name: 'a', url: 'https://x', tlsFingerprint: 'aa:'.repeat(31) + 'aa' }])[0].tlsFingerprint, 'AA'.repeat(32));
});

test('executor links: Amber connects to the executor, which registers, is approved and runs jobs; only Amber, for this link, gets in', async () => {
  const svc = await claimsService();
  const env = await makeEnv({ services: { demo: { audience: 'demo', tcpPort: svc.port, executor: true }, open: { audience: 'open', tcpPort: svc.port, executor: true, links: true } } });
  const base = join(homedir(), `.amber-linktest-${process.pid}`);
  const dir = join(base, 'conf'), data = join(base, 'data');
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, 'note.txt'), 'REMOTE-DATA');
  let child: ChildProcess | undefined;
  let out = '';
  const links: ExecutorLinks[] = [];
  try {
    const { alice, fake } = env;
    env.amber.hub.pollWaitMs = 1500;
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    // The installer is given Amber's public key (this machine may not reach Amber at all).
    const init = await cli(dir, 'init', '--name', 'link-box', '--link', '--amber-key', JSON.stringify(env.amber.bot.signer.jwks()), '--listen', `127.0.0.1:${port}`);
    const fp = /公钥指纹：(.+)/.exec(init)![1].trim();
    await cli(dir, 'env', 'set', 'demo', data, '--readonly');
    child = spawn(process.execPath, [EXE, 'run'], { env: { ...process.env, AMBER_EXECUTOR_DIR: dir } });
    child.stdout!.on('data', b => { out += b; });
    child.stderr!.on('data', b => { out += b; });
    await env.waitFor(() => /link mode: listening/.test(out));
    const hello = await (await fetch(`${url}/amber-link/hello`)).json();
    assert.equal(hello.name, 'link-box');
    assert.equal(hello.amberConnected, false);

    // Nobody but Amber, signing for this very link, takes the executor's requests.
    const next = (headers: Record<string, string>, body = '{}') => fetch(`${url}/amber-link/next`, { method: 'POST', body, headers }).then(r => r.status);
    assert.equal(await next({}), 401, 'unsigned');
    const other = generateKeyPairSync('ed25519').privateKey;
    assert.equal(await next(signLinkRequest(other, 'link-box', 'POST', '/amber-link/next', '{}')), 401, 'not Amber');
    const amberKey = (env.amber.bot.signer as any).key;
    assert.equal(await next(signLinkRequest(amberKey, 'other-box', 'POST', '/amber-link/next', '{}')), 401, 'Amber, but for another link');
    const once = signLinkRequest(amberKey, 'link-box', 'POST', '/amber-link/next', '{}');
    assert.equal(await next(once, '{"x":1}'), 401, 'body bound to the signature');
    const replyBody = JSON.stringify({ id: 'f'.repeat(24), status: 200, body: '{}' });
    const signedReply = signLinkRequest(amberKey, 'link-box', 'POST', '/amber-link/reply', replyBody);
    const reply = () => fetch(`${url}/amber-link/reply`, { method: 'POST', body: replyBody, headers: signedReply }).then(r => r.status);
    assert.equal(await reply(), 200);
    assert.equal(await reply(), 401, 'a replayed request is refused');
    assert.equal((await fetch(`${url}/amber-link/next`, { method: 'POST', body: 'x'.repeat(10_000) })).status, 413, 'an oversized unsigned body is refused before reading');

    // Amber connects: the executor registers through the link and admins get the usual card.
    const handle = (p: string, h: Record<string, string | undefined>, raw: string, machine: string) => executorRequest(env.amber.hub, p, h, raw, machine);
    const link = new ExecutorLinks([{ name: 'link-box', url, parallel: 2 }], env.amber.bot.signer, handle);
    links.push(link);
    link.start();
    const reg = await env.waitFor(() => fake.sent.find(s => s.to.unionId === alice.unionId && /执行端申请登记/.test(FakeFeishu.text(s.card))));
    assert.ok(FakeFeishu.text(reg.card).includes(fp), 'the fingerprint the installer saw');
    assert.equal(env.amber.store.listExecutors().find(e => e.name === 'link-box')!.machine, 'link:link-box', 'marked as a link');
    await env.click(alice, reg.id, button(reg.card, 'exe_ok')!);
    await env.waitFor(() => /approved; waiting/.test(out));
    assert.equal(link.state.get('link-box')!.connected, true);

    // A job runs on the executor, under its environment.
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '读远端', params: [], script: script(
      'import os\nw=os.environ["WORKDIR"]\nprint("note", open(w+"/note.txt").read())\ntry:\n    open(w+"/x","w").write("x"); print("write ok")\nexcept Exception as e: print("write", type(e).__name__)\n',
      { env: 'link-box/demo' }) }, alice);
    const { runCommand } = await import('../src/engine.ts');
    const runAs = (cmdId: string) => runCommand(env.amber.store, env.amber.store.getCommand(cmdId)!, {}, { unionId: alice.unionId, chatId: GROUP, chatType: 'group', channel: 'bot' }, { signer: env.amber.bot.signer });
    const r = await runAs(id);
    assert.equal(r.ok, true, r.error);
    assert.match(r.markdown, /note REMOTE-DATA/);
    assert.match(r.markdown, /write PermissionError/, 'read-only environment');

    // Services stay closed to an executor outside the network, unless the service allows links.
    const svcCode = (name: string) => 'try:\n' + callForClaims(name).split('\n').map(l => '    ' + l).join('\n') + '\n    print("claims", c["aud"] if c else None)\nexcept Exception as e:\n    print("refused", type(e).__name__)\n';
    const closed = await activate(env, { chatId: GROUP, chatType: 'group', name: '远端查数', params: [], script: script(svcCode('demo'), { env: 'link-box/demo', services: { demo: { calls: 1 } } }) }, alice);
    assert.match((await runAs(closed)).markdown, /refused/);
    assert.ok(!env.amber.store.listAudit({ prefixes: ['executor.relay'], limit: 20 }).some(a => JSON.parse(a.detail).service === 'demo'), 'never relayed');
    const opened = await activate(env, { chatId: GROUP, chatType: 'group', name: '远端可查', params: [], script: script(svcCode('open'), { env: 'link-box/demo', services: { open: { calls: 1 } } }) }, alice);
    assert.match((await runAs(opened)).markdown, /claims open/, 'a service that allows links is reached');

    // A link for another name gets nothing from this executor; Amber also refuses a registration under another name.
    const wrong = new ExecutorLinks([{ name: 'other-box', url, parallel: 1 }], env.amber.bot.signer, handle);
    links.push(wrong);
    wrong.start();
    await env.waitFor(() => wrong.state.get('other-box')?.error?.includes('401'));
    const replies: any[] = [];
    (link as any).post = async (_l: unknown, path: string, body: any) => { replies.push({ path, body }); return { status: 200, body: { ok: true } }; };
    await (link as any).serve({ name: 'link-box', url }, { id: 'a'.repeat(24), path: '/v1/executor/register', body: JSON.stringify({ name: 'someone-else' }), headers: {} });
    assert.match(replies[0].body.body, /只接受名为 link-box/);
  } finally {
    for (const l of links) l.close();
    child?.kill();
    svc.close();
    await env.close();
    rmSync(base, { recursive: true, force: true });
  }
});
