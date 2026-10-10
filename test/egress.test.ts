// Network allow lists: scripts that may not connect directly reach only the allowed hosts, through a local
// proxy. The list is part of the environment (executors) or an admin setting (Amber's own machine).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateHosts, hostAllowed, startEgressProxy } from '../src/egress-proxy.ts';
import { runScript } from '../src/runner.ts';
import { followDiff } from '../src/executors.ts';
import { makeEnv, urlButton } from './env.ts';
import { getGlobalAllowHosts, seedAllowHosts, localEgress, FEISHU_HOSTS } from '../src/limits.ts';
import { Store } from '../src/db.ts';

test('egress: list syntax and matching', () => {
  assert.deepEqual(validateHosts(['Open.Feishu.cn', '*.feishu.cn', 'api.example.com:8443', '*.feishu.cn']), ['open.feishu.cn', '*.feishu.cn', 'api.example.com:8443']);
  for (const bad of ['*', '10.0.0.1', 'localhost', 'a..b.com', 'http://x.com', '*.com:99999', 'x.com/path']) assert.throws(() => validateHosts([bad]), /不对/, bad);
  assert.throws(() => validateHosts('x.com'), /数组/);
  const L = ['*.feishu.cn', 'api.example.com:8443'];
  assert.ok(hostAllowed('open.feishu.cn', 443, L));
  assert.ok(hostAllowed('a.b.feishu.cn', 443, L));
  assert.ok(!hostAllowed('feishu.cn', 443, L), '*. means subdomains only');
  assert.ok(!hostAllowed('evilfeishu.cn', 443, L));
  assert.ok(!hostAllowed('open.feishu.cn', 80, L), 'default port 443 only');
  assert.ok(hostAllowed('api.example.com', 8443, L));
  assert.ok(!hostAllowed('api.example.com', 443, L));
});

test('egress: in the sandbox, direct connections fail; through the proxy only allowed hosts work', async () => {
  const echo = createServer(s => s.on('data', d => s.write('echo:' + d)));
  const port = await new Promise<number>(r => echo.listen(0, '127.0.0.1', () => r((echo.address() as any).port)));
  try {
    const code = [
      'import os,socket',
      `P=${port}`,
      'try:',
      '  socket.create_connection(("127.0.0.1",P),timeout=3); print("direct=open")',
      'except Exception: print("direct=blocked")',
      'px=os.environ["HTTPS_PROXY"].rsplit(":",1)',
      'def via(host):',
      '  s=socket.create_connection((px[0].split("//")[1],int(px[1])),timeout=3)',
      '  s.sendall(("CONNECT %s:%d HTTP/1.1\\r\\nHost: %s\\r\\n\\r\\n" % (host,P,host)).encode())',
      '  r=s.recv(200).decode(errors="replace").split("\\r\\n")[0]',
      '  if " 200 " in r:',
      '    s.sendall(b"hi"); r=r+" | "+s.recv(100).decode()',
      '  return r',
      'print("allowed=" + via("localhost"))',
      'print("other=" + via("127.0.0.1"))',
    ].join('\n');
    const r = await runScript({ kind: 'script', lang: 'python', code, timeoutMs: 20000 } as any, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' }, { egress: [`localhost:${port}`] });
    assert.equal(r.ok, true, r.error);
    assert.match(r.content, /direct=blocked/);
    assert.match(r.content, /allowed=HTTP\/1.1 200 .*\| echo:hi/);
    assert.match(r.content, /other=HTTP\/1.1 403/);
    // No list: no proxy at all (and still no direct network).
    const none = await runScript({ kind: 'script', lang: 'python', code: 'import os\nprint("proxy=" + str("HTTPS_PROXY" in os.environ))', timeoutMs: 20000 } as any, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' }, { egress: [] });
    assert.match(none.content, /proxy=False/);
  } finally { echo.close(); }
});

test('egress: the proxy refuses plain HTTP, caps open tunnels, and closes them all at the end', async () => {
  const { connect } = await import('node:net');
  const echo = createServer(s => s.on('data', d => s.write(d)));
  const port = await new Promise<number>(r => echo.listen(0, '127.0.0.1', () => r((echo.address() as any).port)));
  const p = await startEgressProxy([`localhost:${port}`], { maxTunnels: 2 });
  const open = () => new Promise<{ s: any; line: string }>(ok => {
    const s = connect(p.port, '127.0.0.1', () => s.write(`CONNECT localhost:${port} HTTP/1.1\r\n\r\n`));
    s.once('data', (d: Buffer) => ok({ s, line: d.toString().split('\r\n')[0] }));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${p.port}/`, { headers: { host: 'x.example.com' } });
    assert.equal(r.status, 403);
    const a = await open(), b = await open(), c = await open();
    assert.match(a.line, / 200 /); assert.match(b.line, / 200 /);
    assert.match(c.line, / 503 /, 'over the cap');
    a.s.destroy();
    await new Promise(ok => setTimeout(ok, 100));
    const d = await open();
    assert.match(d.line, / 200 /, 'a closed tunnel frees its place');
    const closed = new Promise(ok => b.s.on('close', ok));
    p.close();
    await closed;   // the run ended: its tunnels go with it
    d.s.destroy(); c.s.destroy();
  } finally { p.close(); echo.close(); }
});

test('egress: environment allow lists change like paths (direct + notice); executors check the list', async () => {
  const base = { workdir: '/w', follow: '/f.json', access: { readWrite: ['/w'] } };
  const d = followDiff({ e: { ...base, allowHosts: ['*.feishu.cn'] } }, { e: { ...base, allowHosts: ['*.feishu.cn', 'api.x.com'] } });
  assert.deepEqual(d?.[0].hosts, { added: ['api.x.com'], removed: [] });
  const d2 = followDiff({ e: { ...base, allowHosts: ['*.feishu.cn'] } }, { e: { ...base } });
  assert.deepEqual(d2?.[0].hosts, { added: [], removed: ['*.feishu.cn'] });
  assert.equal(followDiff({ e: { ...base, follow: undefined, allowHosts: [] } as any }, { e: { ...base, follow: undefined, allowHosts: ['a.com'] } as any }), null, 'not followed: needs approval');

  process.env.AMBER_EXECUTOR_DIR = mkdtempSync(join(tmpdir(), 'amber-exe-'));
  const { buildEntry, prepare } = await import('../client/amber-executor/amber-executor.mjs');
  const { specHashOf } = await import('../src/exec-proto.ts');
  const workdir = mkdtempSync(join(tmpdir(), 'amber-wd-'));
  assert.deepEqual(buildEntry({ workdir, allowHosts: ['*.Feishu.cn'] }).allowHosts, ['*.feishu.cn']);
  assert.throws(() => buildEntry({ workdir, allowHosts: ['*'] }), /不对/);
  const cfg = { name: 'box', envs: { e: { workdir, access: { readWrite: [workdir] }, allowHosts: ['*.feishu.cn'] } } };
  const spec = (network: boolean) => ({ name: 'x', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)', env: 'box/e', network }, options: {} });
  const job = (network: boolean) => prepare(cfg, { env: 'e', spec: spec(network), specHash: specHashOf(spec(network)) });
  assert.deepEqual(job(false).egress, ['*.feishu.cn']);
  const withGlobal = prepare(cfg, { env: 'e', spec: spec(false), specHash: specHashOf(spec(false)), allowHosts: ['open.feishu.cn', '*.feishu.cn'] });
  assert.deepEqual(withGlobal.egress, ['open.feishu.cn', '*.feishu.cn'], 'Amber\'s global list plus the environment\'s own');
  const noOwn = { name: 'box', envs: { e: { workdir, access: { readWrite: [workdir] } } } };
  assert.deepEqual(prepare(noOwn, { env: 'e', spec: spec(false), specHash: specHashOf(spec(false)), allowHosts: ['*.feishu.cn'] }).egress, ['*.feishu.cn'], 'every environment gets the global list');
  assert.throws(() => prepare(noOwn, { env: 'e', spec: spec(false), specHash: specHashOf(spec(false)), allowHosts: ['*'] }), /不对/, 'a bad list from Amber is refused too');
  assert.equal(job(true).egress, undefined, 'full internet: no proxy needed');
});

test('egress: the global list is seeded once (Feishu), then is whatever admins set; Amber\'s machine adds its own', async () => {
  const st = new Store(mkdtempSync(join(tmpdir(), 'amber-seed-')));
  assert.deepEqual(getGlobalAllowHosts(st), [], 'nothing in code: unset means none');
  assert.equal(seedAllowHosts(st), true);
  assert.deepEqual(getGlobalAllowHosts(st), FEISHU_HOSTS);
  st.setSetting('global_allow_hosts', '[]');
  assert.equal(seedAllowHosts(st), false, 'seeded once only');
  assert.deepEqual(getGlobalAllowHosts(st), [], 'an admin emptying it is kept');

  const env = await makeEnv();
  const base = `http://127.0.0.1:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  const post = (cookie: string, body: unknown) => fetch(base + '/web/api/settings/allow-hosts', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    assert.deepEqual(getGlobalAllowHosts(env.amber.store), FEISHU_HOSTS, 'a new Amber starts with Feishu');
    const a = await login(env.alice), b = await login(env.bob);
    assert.equal((await post(b, { local: ['x.example.com'] })).status, 403);
    const bad = await post(a, { global: ['api.example.com'], local: ['bad host'] });
    assert.equal(bad.body.ok, false);
    assert.deepEqual(getGlobalAllowHosts(env.amber.store), FEISHU_HOSTS, 'nothing saved when either list is wrong');
    const ok = await post(a, { local: ['API.example.com'] });
    assert.deepEqual([ok.body.global, ok.body.local], [FEISHU_HOSTS, ['api.example.com']], 'an omitted list is kept');
    assert.deepEqual(localEgress(env.amber.store), [...FEISHU_HOSTS, 'api.example.com'], 'Amber\'s machine: global + local');
  } finally { await env.close(); }
});

test('egress: runs on an executor carry the global list in the job', async () => {
  const { envsHash } = await import('../src/executors.ts');
  const env = await makeEnv();
  try {
    const envs = { e: { workdir: '/tmp' } };
    env.amber.store.putExecutor({ id: 'abcd1234abcd1234', name: 'box', fingerprint: 'f', signPub: 's', boxPub: 'b', envs, machine: 'm', version: '1' });
    assert.equal(env.amber.hub.decide('abcd1234abcd1234', envsHash('box', envs), true, env.alice.unionId).ok, true);
    env.amber.store.setSetting('global_allow_hosts', JSON.stringify(['*.feishu.cn', 'api.example.com']));
    const seen: any[] = [];
    (env.amber.hub as any).run = async (_s: any, _spec: any, _h: any, _i: any, opts: any) => { seen.push(opts); return { ok: true, content: 'ok' }; };
    const { activate, script, GROUP } = await import('./env.ts');
    await activate(env, { chatId: GROUP, chatType: 'group', name: '远程', params: [], script: script('print(1)', { env: 'box/e' }) }, env.bob);
    assert.deepEqual(seen.at(-1)?.allowHosts, ['*.feishu.cn', 'api.example.com']);
  } finally { await env.close(); }
});

test('egress: the executor job carries the global list and the run\'s time, sealed', async () => {
  const { envsHash } = await import('../src/executors.ts');
  const { newExecutorKeys, keyFromPem, pubB64, openJob } = await import('../src/exec-proto.ts');
  const { createPublicKey } = await import('node:crypto');
  const env = await makeEnv();
  try {
    const box = keyFromPem(newExecutorKeys().boxKey);
    const envs = { e: { workdir: '/tmp' } };
    env.amber.store.putExecutor({ id: 'abcd1234abcd1234', name: 'box', fingerprint: 'f', signPub: 's', boxPub: pubB64(createPublicKey(box)), envs, machine: 'm', version: '1' });
    env.amber.hub.decide('abcd1234abcd1234', envsHash('box', envs), true, env.alice.unionId);
    env.amber.store.touchExecutor('abcd1234abcd1234');
    const script = { kind: 'script', lang: 'python', code: 'print(1)', env: 'box/e', timeoutMs: 42_000 } as any;
    const pending = env.amber.hub.run(script, { name: 'x', params: [], script, options: {} }, 'h', { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' }, { allowHosts: ['*.feishu.cn'] });
    const queued = (env.amber.hub as any).queues.get('abcd1234abcd1234')?.[0];
    assert.ok(queued, 'job queued for the executor');
    const jwk = (await env.api('GET', '/v1/keys')).body.keys[0];
    const payload = openJob(createPublicKey({ key: jwk, format: 'jwk' }), 'abcd1234abcd1234', box, queued);
    assert.deepEqual(payload.allowHosts, ['*.feishu.cn']);
    assert.equal(payload.timeoutMs, 42_000);
    env.amber.hub.close();
    await pending;
  } finally { await env.close(); }
});

test('egress: apps run on Amber\'s machine get the proxy for the global + local list (not with full internet)', async () => {
  const { activate, script, GROUP } = await import('./env.ts');
  const env = await makeEnv();
  try {
    const code = 'import os\nprint("proxy=" + str("HTTPS_PROXY" in os.environ))';
    await activate(env, { chatId: GROUP, chatType: 'group', name: '代理', params: [], script: script(code) }, env.bob);
    const r1 = (env.amber.store as any).db.prepare("select result as output from runs order by started_at desc limit 1").get();
    assert.match(String(r1.output), /proxy=True/, 'the seeded global list applies on Amber\'s machine');
    await activate(env, { chatId: GROUP, chatType: 'group', name: '外网', params: [], script: script(code, { network: true }) }, env.bob);
    const r2 = (env.amber.store as any).db.prepare("select result as output from runs order by started_at desc limit 1").get();
    assert.match(String(r2.output), /proxy=False/, 'full internet: no proxy');
  } finally { await env.close(); }
});
