// amber-gateway (docs/gateway.md): Amber's agent API for callers outside the company network. A real gateway process
// takes outside requests with a bearer token per client; Amber connects out to it (API link), handles each request as
// its own API would — as machine "gw:<link>:<client>", under the policy its configuration sets for that client — and
// posts the answer back. Only Amber, signing for this gateway, takes the requests; the token never reaches Amber.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, rmSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { generateKeyPairSync } from 'node:crypto';
import { makeEnv, GROUP } from './env.ts';
import { ApiLinks, validateApiLinks, checkPolicy, DEFAULT_PATHS } from '../src/api-link.ts';
import type { ApiRequest } from '../src/api.ts';
import { signLinkRequest } from '../src/exec-proto.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GW = join(ROOT, 'client', 'amber-gateway', 'amber-gateway.mjs');
const freePort = () => new Promise<number>(r => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => r(p)); }); });

test('api links: configuration is checked; omitted users / chats mean none', () => {
  assert.deepEqual(validateApiLinks(undefined), []);
  const [l] = validateApiLinks([{ name: 'gw1', url: 'https://gw.example.com/', clients: { skill: { users: ['Alice@Example.com'], chats: ['oc_abc'] }, bare: {} } }]);
  assert.equal(l.url, 'https://gw.example.com');
  assert.deepEqual(l.clients.skill.users, ['alice@example.com'], 'emails compared case-insensitively');
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'http://gw.example.com', clients: {} }]), /apiLinks\.gw1\.url 要用 https/);
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'https://x' }]), /clients 要写成对象/);
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'https://x', clients: { 'Bad Name': {} } }]), /客户端名/);
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'https://x', clients: { a: { user: ['a@b.c'] } } }]), /不认识的设置/, 'a typo is not silently "none"');
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'https://x', clients: { a: { chats: ['general'] } } }]), /chats/);
  assert.throws(() => validateApiLinks([{ name: 'gw1', url: 'https://x', clients: { a: { paths: ['/admin'] } } }]), /paths/);

  const bare = l.clients.bare, skill = l.clients.skill;
  const body = (b: unknown) => JSON.stringify(b);
  assert.equal(checkPolicy(bare, 'GET', '/v1/info', ''), undefined);
  assert.equal(checkPolicy(bare, 'GET', '/v1/requests/abc-1', ''), undefined, ':id matches one segment');
  assert.equal((checkPolicy(bare, 'GET', '/v1/requests/a/b', '') as any).status, 403);
  assert.equal((checkPolicy(bare, 'POST', '/v1/commands/retire', '{}') as any).status, 403, 'changing apps is not in the defaults');
  assert.equal((checkPolicy(bare, 'POST', '/v1/commands/list', body({ chatId: 'oc_abc', chatType: 'group' })) as any).status, 403, 'no chats listed = none');
  assert.equal((checkPolicy(skill, 'POST', '/v1/commands/list', body({ chatId: 'oc_abc', chatType: 'group', user: 'bob@example.com' })) as any).status, 403);
  assert.equal((checkPolicy(skill, 'POST', '/v1/drafts', body({ chatId: 'oc_abc', claimer: 'bob@example.com' })) as any).status, 403, 'claimer counts as naming a person');
  assert.equal(checkPolicy(skill, 'POST', '/v1/commands/list', body({ chatId: 'oc_abc', chatType: 'group', user: ' ALICE@example.com ' })), undefined);
  assert.equal(checkPolicy(skill, 'POST', '/v1/reads/fetch', body({ requestId: 'x' })), undefined, 'a path that names no chat');
  const chatsOnly = { chats: ['oc_abc'] };
  assert.equal(checkPolicy(chatsOnly, 'POST', '/v1/runs', body({ chatId: 'oc_abc', chatType: 'group', command: 'x' })), undefined);
  assert.equal((checkPolicy(chatsOnly, 'POST', '/v1/runs', body({ chatId: 'oc_abc', chatType: 'group', command: 'x', user: 'alice@example.com' })) as any).status, 403, 'no users listed = may name no one');
  assert.equal((checkPolicy(skill, 'POST', '/v1/commands/list', body({ chatId: ['oc_abc'] })) as any).status, 403, 'only a listed string');
  assert.equal((checkPolicy(skill, 'POST', '/v1/commands/list', '{"chatId":') as any).status, 400);
  const all = { paths: ['/v1/secrets/read', '/v1/secrets/fetch', '/v1/executor/register', '/v1/pages', ...DEFAULT_PATHS], users: ['alice@example.com'], chats: ['oc_abc'] };
  for (const p of ['/v1/secrets/read', '/v1/secrets/fetch', '/v1/executor/register', '/v1/pages']) assert.equal((checkPolicy(all, 'POST', p, '{}') as any).status, 403, `${p} never, even when listed`);
});

test('gateway: outside callers reach Amber with a token, under the policy Amber sets per client; nobody else takes the requests', async () => {
  const env = await makeEnv();
  const dir = mkdtempSync(join(tmpdir(), 'amber-gw-'));
  const gwEnv = { ...process.env, AMBER_GATEWAY_DIR: dir };
  const gw = (...args: string[]) => promisify(execFile)(process.execPath, [GW, ...args], { env: gwEnv, encoding: 'utf8' }).then(r => r.stdout);
  let child: ChildProcess | undefined;
  let links: ApiLinks | undefined;
  let out = '';
  try {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    await gw('init', '--name', 'gw1', '--amber-key', JSON.stringify(env.amber.bot.signer.jwks()), '--listen', `127.0.0.1:${port}`);
    const token: Record<string, string> = {};
    for (const [c, ...extra] of [['skill'], ['other'], ['stranger'], ['revoked'], ['burst', '--rate', '3']]) {
      token[c] = /\n(amg_[A-Za-z0-9_-]+)\n/.exec(await gw('token', 'add', c, ...extra))![1];
    }
    const cfgText = readFileSync(join(dir, 'config.json'), 'utf8');
    for (const t of Object.values(token)) assert.ok(!cfgText.includes(t), 'only hashes are stored');
    assert.doesNotMatch(await gw('token', 'list'), /amg_/, 'token list never shows tokens');
    child = spawn(process.execPath, [GW, 'serve'], { env: gwEnv });
    child.stdout!.on('data', b => { out += b; });
    child.stderr!.on('data', b => { out += b; });
    await env.waitFor(() => /listening on/.test(out));

    const call = async (method: string, path: string, o: { client?: string; auth?: string; body?: unknown } = {}) => {
      const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(o.client ? { authorization: `Bearer ${token[o.client]}` } : o.auth ? { authorization: o.auth } : {}) }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
      const text = await r.text();
      let body: any = text;
      try { body = JSON.parse(text); } catch { /* text */ }
      return { status: r.status, body };
    };
    const health = async () => (await (await fetch(`${url}/healthz`)).json()).amberConnected;

    // Amber is not connected yet: authenticated requests are refused at once, with a reason; keys need no token.
    assert.equal(await health(), false);
    assert.equal((await call('GET', '/v1/info')).status, 401, 'no token');
    assert.equal((await call('GET', '/v1/info', { auth: 'Bearer amg_not-a-real-token-at-all' })).status, 401, 'unknown token');
    assert.equal((await call('GET', '/v1/info', { auth: token.skill })).status, 401, 'not a bearer header');
    const notYet = await call('GET', '/v1/info', { client: 'skill' });
    assert.equal(notYet.status, 504);
    assert.match(notYet.body.message, /Amber 没有连上网关/);
    assert.deepEqual((await call('GET', '/v1/keys')).body, env.amber.bot.signer.jwks(), 'the pinned key, as Amber publishes it');

    // Only Amber, signing for this gateway, takes the requests.
    const next = (headers: Record<string, string>, body = '{}') => fetch(`${url}/amber-link/next`, { method: 'POST', body, headers }).then(r => r.status);
    const amberKey = (env.amber.bot.signer as any).key;
    assert.equal(await next({}), 401, 'unsigned');
    assert.equal(await next(signLinkRequest(generateKeyPairSync('ed25519').privateKey, 'gateway:gw1', 'POST', '/amber-link/next', '{}')), 401, 'not Amber');
    assert.equal(await next(signLinkRequest(amberKey, 'gw1', 'POST', '/amber-link/next', '{}')), 401, 'Amber, but signed as for an executor link of that name');
    assert.equal(await next(signLinkRequest(amberKey, 'gateway:gw2', 'POST', '/amber-link/next', '{}')), 401, 'Amber, but for another gateway');
    assert.equal(await next(signLinkRequest(amberKey, 'gateway:gw1', 'POST', '/amber-link/next', '{}'), '{"x":1}'), 401, 'body bound to the signature');
    const replyBody = JSON.stringify({ id: 'f'.repeat(24), status: 200, body: '{}' });
    const signedReply = signLinkRequest(amberKey, 'gateway:gw1', 'POST', '/amber-link/reply', replyBody);
    const reply = () => fetch(`${url}/amber-link/reply`, { method: 'POST', body: replyBody, headers: signedReply }).then(r => r.status);
    assert.equal(await reply(), 200);
    assert.equal(await reply(), 401, 'a replayed request is refused');
    assert.equal(await health(), true, 'a signed request counts as Amber being there');
    // What Amber is handed for an outside request: the client's name, never its token or other headers.
    const pendingCall = fetch(`${url}/v1/info?wait=1`, { headers: { authorization: `Bearer ${token.skill}`, cookie: 'c=1', 'x-forwarded-for': '1.2.3.4' } });
    // Taken as Amber takes it (a long poll returns as soon as the request is queued).
    const taken = (await fetch(`${url}/amber-link/next`, { method: 'POST', body: '{}', headers: signLinkRequest(amberKey, 'gateway:gw1', 'POST', '/amber-link/next', '{}') }).then(x => x.json())).requests;
    assert.deepEqual(Object.keys(taken[0]).sort(), ['body', 'client', 'headers', 'id', 'method', 'path']);
    assert.equal(taken[0].client, 'skill');
    assert.deepEqual(taken[0].headers, {}, 'no content-type sent, so no headers at all');
    assert.ok(!JSON.stringify(taken).includes(token.skill));
    const answer = JSON.stringify({ id: taken[0].id, status: 200, body: JSON.stringify({ ok: true, fake: 1 }) });
    await fetch(`${url}/amber-link/reply`, { method: 'POST', body: answer, headers: signLinkRequest(amberKey, 'gateway:gw1', 'POST', '/amber-link/reply', answer) });
    assert.deepEqual(await (await pendingCall).json(), { ok: true, fake: 1 }, 'the answer goes back to the caller');

    // Amber connects. Every request it handles is recorded, to see exactly what reached its API.
    const seen: ApiRequest[] = [];
    const handle = (r: ApiRequest) => { seen.push(r); return env.amber.handleApi(r); };
    const config = validateApiLinks([{ name: 'gw1', url, parallel: 2, clients: {
      skill: { users: [env.alice.email.toUpperCase()], chats: [GROUP] },
      other: { paths: ['/v1/secrets/read', '/v1/executor/register', '/v1/pages', '/v1/info', '/v1/commands/list'] },
      revoked: {},
      burst: {},
    } }]);
    links = new ApiLinks(config, env.amber.bot.signer, handle, d => env.amber.store.audit(null, 'gateway.request', d));
    links.start();
    // Its long polls are open at once: the first request is taken by one of them.

    const info = await call('GET', '/v1/info', { client: 'skill' });
    assert.equal(info.status, 200, JSON.stringify(info.body));
    assert.equal(info.body.machine, 'gw:gw1:skill', 'Amber sees the gateway and the client');
    await env.waitFor(() => links!.state.get('gw1')?.connected);
    const list = await call('POST', '/v1/commands/list', { client: 'skill', body: { chatId: GROUP, chatType: 'group', user: env.alice.email } });
    assert.equal(list.status, 200, JSON.stringify(list.body));
    assert.ok(Array.isArray(list.body.commands));
    assert.ok(seen.length >= 2 && seen.every(r => r.machine.startsWith('gw:gw1:') && r.scoped === true));
    assert.ok(seen.every(r => Object.keys(r.headers).every(k => k === 'content-type')), 'only content-type reaches Amber: never the token');
    assert.ok(!JSON.stringify(seen).includes(token.skill));

    // Never through a gateway, even when the configuration lists it: the gateway refuses, and so does Amber.
    for (const p of ['/v1/secrets/read', '/v1/executor/register', '/v1/pages']) assert.equal((await call('POST', p, { client: 'other', body: {} })).status, 403, p);
    assert.ok(!env.amber.store.listAudit({ prefixes: ['gateway.'], limit: 200 }).some(a => /secrets|executor|pages/.test(a.detail)), 'refused at the gateway: never queued for Amber');
    const direct = (q: object) => (links as any).answer(config[0], { id: 'a'.repeat(24), ...q });
    for (const p of ['/v1/secrets/read', '/v1/secrets/fetch', '/v1/executor/register', '/v1/pages', '/v1/./secrets/read', '/v1/x/../executor/poll']) {
      const r = await direct({ client: 'other', method: 'POST', path: p, body: '{}' });
      assert.equal(r.status, 403, `Amber refuses ${p} itself: ${JSON.stringify(r.body)}`);
    }
    assert.ok(!seen.some(r => /secrets|executor|pages/.test(r.path)), 'none of them reached the API');
    // The policy sees the path the API dispatches on, however it was written.
    assert.equal((await direct({ client: 'skill', method: 'POST', path: '/v1/x/../commands/list', body: JSON.stringify({ chatId: GROUP, chatType: 'group' }) })).status, 200);
    assert.equal(seen.at(-1)!.path, '/v1/commands/list');

    // People and chats: only those listed for the client.
    assert.equal((await call('POST', '/v1/commands/list', { client: 'skill', body: { chatId: GROUP, chatType: 'group', user: env.bob.email } })).status, 403, 'an unlisted person');
    assert.equal((await call('POST', '/v1/commands/list', { client: 'skill', body: { chatId: 'oc_elsewhere', chatType: 'group' } })).status, 403, 'an unlisted chat');
    assert.equal((await call('POST', '/v1/commands/list', { client: 'skill', body: { chatId: GROUP, chatType: 'group' } })).status, 200, 'no person named: fine in a group');
    const none = await call('POST', '/v1/commands/list', { client: 'other', body: { chatId: GROUP, chatType: 'group' } });
    assert.equal(none.status, 403, 'no chats configured = no chat');
    assert.match(none.body.message, /chats/);
    assert.equal((await call('POST', '/v1/commands/retire', { client: 'skill', body: { chatId: GROUP, chatType: 'group', command: 'x' } })).status, 403, 'not in the default paths');

    // A client the gateway knows but Amber does not.
    const stranger = await call('GET', '/v1/info', { client: 'stranger' });
    assert.equal(stranger.status, 403);
    assert.match(stranger.body.message, /没有在 Amber 的 apiLinks 里登记/);
    for (const c of ['__proto__', 'constructor', 'toString']) assert.equal((await direct({ client: c, method: 'GET', path: '/v1/info' })).status, 403, c);

    // A revoked token stops working at once, without restarting the gateway.
    assert.equal((await call('GET', '/v1/info', { client: 'revoked' })).status, 200);
    await gw('token', 'rm', 'revoked');
    assert.equal((await call('GET', '/v1/info', { client: 'revoked' })).status, 401);

    // Rate limit per client.
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await call('GET', '/v1/info', { client: 'burst' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
    assert.equal((await call('GET', '/v1/info', { client: 'skill' })).status, 200, 'other clients are not affected');

    // Request status: only requests this client made. LAN callers keep seeing any (unchanged).
    const mk = (machine: string) => env.amber.store.insertRequest({ kind: 'run', commandId: null, specHash: null, chatId: GROUP, chatType: 'group', targetUnionId: null,
      args: {}, rule: null, scheduleId: null, requestedBy: 'x', replyTo: null, inThread: false, machine });
    const theirs = mk('local'), mine = mk('gw:gw1:skill'), otherClient = mk('gw:gw1:other');
    assert.equal((await call('GET', `/v1/requests/${mine.id}?wait=0&secret=LEAK-ME`, { client: 'skill' })).status, 200);
    for (const r of [theirs, otherClient]) {
      const got = await call('GET', `/v1/requests/${r.id}`, { client: 'skill' });
      assert.equal(got.status, 404);
      assert.equal(got.body.message, `没有请求 ${r.id}`, 'indistinguishable from an unknown id');
    }
    assert.equal((await env.api('GET', `/v1/requests/${mine.id}`)).status, 200);
    assert.equal((await call('POST', '/v1/reads/fetch', { client: 'skill', body: { requestId: theirs.id } })).status, 404);

    // Request bodies over the cap are refused at the gateway.
    assert.equal((await call('POST', '/v1/runs', { client: 'skill', body: { pad: 'x'.repeat(1024 * 1024) } })).status, 413);

    // The `amber` command line, outside: the gateway address and a token.
    const home = mkdtempSync(join(tmpdir(), 'amber-gwcli-'));
    mkdirSync(join(home, 'bin'));
    copyFileSync(join(ROOT, 'client', 'amber'), join(home, 'bin', 'amber'));
    // Not spawnSync: Amber answers from this very process.
    const amber = (args: string[], e: Record<string, string>) => promisify(execFile)('python3', [join(home, 'bin', 'amber'), ...args], { env: { PATH: process.env.PATH!, HOME: home, ...e }, encoding: 'utf8' })
      .then(r => r.stdout + r.stderr, (r: any) => String(r.stdout) + String(r.stderr));
    assert.match(await amber(['info'], { AMBER_URL: url, AMBER_TOKEN: token.skill }), /本机名称：gw:gw1:skill/);
    assert.match(await amber(['config', 'set-token', token.skill], {}), /已设置网关令牌/);
    assert.match(await amber(['config', 'set-url', url], {}), /已设置/);
    assert.equal(JSON.parse(readFileSync(join(home, '.config', 'amber-client.json'), 'utf8')).token, token.skill, 'set-url keeps the token');
    assert.equal(statSync(join(home, '.config', 'amber-client.json')).mode & 0o777, 0o600, 'it holds a token');
    assert.match(await amber(['info'], {}), /本机名称：gw:gw1:skill/);
    assert.match(await amber(['info'], { AMBER_URL: 'http://gw.example.com' }), /不是 https/, 'a token is never sent in clear text');
    rmSync(home, { recursive: true, force: true });

    // Audit, on both sides: who called what and how it ended — never a body, a token or an answer.
    const lines = readFileSync(join(dir, 'audit.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.ok(lines.some(l => l.client === 'skill' && l.path === '/v1/info' && l.status === 200 && typeof l.ms === 'number'));
    assert.ok(lines.some(l => l.client === null && l.status === 401));
    assert.ok(lines.some(l => l.client === 'burst' && l.status === 429));
    assert.ok(lines.some(l => l.path === `/v1/requests/${mine.id}?wait=0&secret=`), 'query values dropped, except wait');
    const auditText = readFileSync(join(dir, 'audit.jsonl'), 'utf8');
    for (const t of Object.values(token)) assert.ok(!auditText.includes(t));
    for (const s of ['LEAK-ME', env.alice.email, 'xxxxxxxx', GROUP, '"commands"']) assert.ok(!auditText.includes(s), `audit holds no ${s}`);
    const amberSide = env.amber.store.listAudit({ prefixes: ['gateway.'], limit: 200 }).map(a => JSON.parse(a.detail));
    assert.ok(amberSide.some(d => d.link === 'gw1' && d.client === 'skill' && d.path === '/v1/commands/list' && d.status === 200));
    assert.ok(amberSide.some(d => d.client === 'other' && d.path === '/v1/secrets/read' && d.status === 403));
    assert.ok(!JSON.stringify(amberSide).includes(env.alice.email), 'no bodies on Amber\'s side either');
  } finally {
    links?.close();
    child?.kill();
    await env.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
