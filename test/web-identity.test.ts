// Website login and execution; execution identity tokens reaching a service.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { makeEnv, activate, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const url = urlButton(env.fake.sent.at(-1)!.card)!;
  assert.ok(url.startsWith(`http://127.0.0.1:${env.webPort}/login?t=`));
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302);
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  // The link works once.
  assert.equal((await fetch(url, { redirect: 'manual' })).status, 400);
  return cookie;
}

test('website: login by chat, run as yourself, CSRF and group membership enforced', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '谁', params: [], script: script('import json,sys\nprint("caller=" + json.load(sys.stdin)["caller"]["unionId"])') }, env.alice);
    // Asked in a group, the login link goes to the person's private chat, never into the group (D43).
    const before = env.fake.sent.length;
    await env.say(env.bob, GROUP, '登录');
    const out = env.fake.sent.slice(before);
    const dm = out.filter(m => m.to.unionId === env.bob.unionId);
    assert.equal(dm.length, 1);
    const groupLink = out.filter(m => m !== dm[0] && urlButton(m.card));
    assert.equal(groupLink.length, 0, 'no login link in the group');
    assert.match(FakeFeishu.text(out.at(-1)!.card), /已私聊发给你/);
    const viaGroup = urlButton(dm[0].card)!;
    const g = await fetch(viaGroup, { redirect: 'manual' });
    assert.equal(g.status, 302, 'the link sent to the private chat works');
    const gMe = await (await fetch(`http://127.0.0.1:${env.webPort}/web/api/me`, { headers: { cookie: g.headers.get('set-cookie')!.split(';')[0] } })).json();
    assert.equal(gMe.unionId, env.bob.unionId);
    const bob = await login(env, env.bob);
    const base = `http://127.0.0.1:${env.webPort}`;
    const me = await (await fetch(`${base}/web/api/me`, { headers: { cookie: bob } })).json();
    assert.equal(me.unionId, env.bob.unionId);
    const ov = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: bob } })).json();
    const cmd = ov.groups[0].commands[0];
    const post = (cookie: string, body: unknown, origin = base, type = 'application/json') =>
      fetch(`${base}/web/api/run`, { method: 'POST', headers: { cookie, origin, 'content-type': type }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json() }));
    const ok = await post(bob, { scope: 'group:' + GROUP, commandId: cmd.id, args: {} });
    assert.equal(ok.body.markdown, `caller=${env.bob.unionId}`);
    assert.equal((await post(bob, { scope: 'group:' + GROUP, commandId: cmd.id }, 'http://evil.example')).status, 403);
    assert.equal((await post(bob, { scope: 'group:' + GROUP, commandId: cmd.id }, base, 'text/plain')).status, 403);
    // Carol is not in the group.
    const carol = await login(env, env.carol);
    assert.equal((await post(carol, { scope: 'group:' + GROUP, commandId: cmd.id })).status, 403);
    // Without the members permission, group commands are refused rather than allowed.
    env.fake.membersApiAllowed = false;
    (env.amber.bot as any).memberCache.clear();
    assert.equal((await post(bob, { scope: 'group:' + GROUP, commandId: cmd.id })).status, 403);
    env.fake.membersApiAllowed = true;
    // Source code is visible to those who may run it.
    const src = await (await fetch(`${base}/web/api/commands/${cmd.id}/source?scope=group:${GROUP}`, { headers: { cookie: bob } })).json();
    assert.match(src.script.code, /caller=/);
    // Logging out everywhere.
    await env.dm(env.bob, '退出网站');
    assert.equal((await fetch(`${base}/web/api/me`, { headers: { cookie: bob } })).status, 401);
    // Docs are public.
    assert.equal((await fetch(`${base}/docs/usage`)).status, 200);
  } finally { await env.close(); }
});

test('identity token: the service receives a token for the person who clicked, the sandbox reaches only that service', async () => {
  // A minimal service that verifies Amber's token with Amber's public key.
  const seen: any[] = [];
  let keys: Record<string, any> = {};
  const svc = createServer((req, res) => {
    const tok = String(req.headers.authorization ?? '').replace(/^Amber /, '');
    const [h, p, s] = tok.split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const good = verify(null, Buffer.from(`${h}.${p}`), keys[header.kid], Buffer.from(s, 'base64url')) && payload.aud === 'demo' && payload.iss === 'amber';
    seen.push({ good, payload });
    res.writeHead(good ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ user: payload.sub }));
  });
  const port = await new Promise<number>(r => svc.listen(0, '127.0.0.1', () => r((svc.address() as any).port)));
  const env = await makeEnv({ services: { demo: { audience: 'demo', tcpPort: port } } });
  try {
    const jwks = (await env.api('GET', '/v1/keys')).body;
    keys = Object.fromEntries(jwks.keys.map((k: any) => [k.kid, createPublicKey({ key: k, format: 'jwk' })]));
    const code = [
      'import json,sys,urllib.request',
      'inp=json.load(sys.stdin); s=inp["services"]["demo"]',
      'op=urllib.request.build_opener(urllib.request.ProxyHandler({}))',
      'for t in s["tokens"]:',
      '  r=op.open(urllib.request.Request("http://127.0.0.1:%d/" % s["tcpPort"], headers={"Authorization":"Amber "+t}), timeout=5)',
      '  print("user=" + json.load(r)["user"])',
      'try:',
      '  op.open("http://127.0.0.1:%d/v1/keys" % ' + env.apiPort + ', timeout=3); print("LEAK")',
      'except Exception: print("other port blocked")',
    ].join('\n');
    // Declaring a service and internet access together is refused.
    assert.equal((await env.submit({ chatId: GROUP, chatType: 'group', name: '查', params: [], script: script(code, { services: { demo: { calls: 2 } }, network: true }) })).ok, false);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '查', params: [], script: script(code, { services: { demo: { calls: 2 } } }) }, env.alice);
    // A command that uses a service always needs a person: the agent cannot run it directly.
    const r = await env.api('POST', '/v1/runs', { chatId: GROUP, chatType: 'group', user: env.bob.email, command: '查' });
    assert.equal(r.body.mode, 'confirm_card');
    const card = env.fake.sent.at(-1)!;
    await env.click(env.bob, card.id, { a: 'req_ok', r: r.body.requestId });
    const w = await env.api('GET', `/v1/requests/${r.body.requestId}?wait=15`);
    assert.match(w.body.markdown, new RegExp(`user=${env.bob.unionId}`));
    assert.match(w.body.markdown, /other port blocked/);
    const last = seen.at(-1);
    assert.equal(last.good, true);
    assert.equal(last.payload.sub, env.bob.unionId);
    assert.equal(last.payload.channel, 'agent');
    assert.ok(last.payload.exp - last.payload.iat <= 300);
    assert.equal(seen[0].payload.channel, 'bot.trial', 'the trial run is marked as a trial');
    // calls: 2 => exactly two tokens per run, numbered 1..2 under the signature, each with its own jti (D41).
    assert.equal(seen.length, 4, 'trial run + agent run, two calls each');
    const run = seen.slice(-2).map(x => x.payload);
    assert.deepEqual(run.map(p => [p.call_index, p.call_count]), [[1, 2], [2, 2]]);
    assert.equal(run[0].run, run[1].run);
    assert.notEqual(run[0].jti, run[1].jti);
    assert.ok(seen.every(x => x.good));
  } finally { await env.close(); svc.close(); }
});
