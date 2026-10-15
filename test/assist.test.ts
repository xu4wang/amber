// The guide (assist.ts): a message that matches no command or app gets the large model's suggestion, checked by
// Amber: only apps this person can use here (sent as a prefilled form, never run), only Amber's own commands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, activate, script, urlButton, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.py');
const HELLO = script('import json,sys\ninp=json.load(sys.stdin)\nprint("你好，" + inp["params"].get("who","世界"))');
const answer = (o: object) => `帮我弄一下 @@${JSON.stringify(o)}@@`;

test('the guide: a suggestion, checked; the app comes as a prefilled form and is not run', async () => {
  const env = await makeEnv({ llm: { command: FAKE, models: ['sonnet', 'haiku'], timeoutMs: 5000 } });
  const { alice, bob, fake } = env;
  try {
    const dm = 'oc_dmbob';
    fake.chats.set(dm, { mode: 'p2p', name: '', members: new Set(['BOT', bob.unionId]) });
    await activate(env, { chatId: dm, chatType: 'p2p', claimer: bob.email, name: '问候', params: [{ name: 'who', label: '对象', type: 'string', default: 'DEFAULT_MARK' }], script: HELLO }, bob);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '机密报表', params: [], script: script('print("SECRET_CODE_MARK")') }, alice);
    const runsBefore = env.amber.store.runsByCaller(bob.unionId, 50).length;
    const replies = () => fake.sent.filter(s => s.to.replyTo);

    // An app from the list: the suggestion, then the form prefilled with what was said. Nothing runs.
    let n = replies().length;
    await env.dm(bob, answer({ kind: 'app', app: '问候', args: { who: '小明', evil: 'x' }, reply: '你可能想用问候' }));
    await env.waitFor(() => /你可能想用问候/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    const form = replies().slice(n).find(s => button(s.card, 'run'));
    assert.ok(form, 'the app\'s form');
    assert.match(JSON.stringify(form!.card), /小明/);
    assert.doesNotMatch(JSON.stringify(form!.card), /evil/, 'unknown parameters are dropped');
    assert.equal(env.amber.store.runsByCaller(bob.unionId, 50).length, runsBefore, 'the guide never runs anything');
    // What the model saw: this person's apps here, not others' and no code; the default model is haiku.
    const seen = readFileSync(join(env.cfg.dataDir, 'llm-work', 'prompts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1);
    assert.match(seen.prompt, /问候/);
    assert.doesNotMatch(seen.prompt, /机密报表|SECRET_CODE_MARK|print\(|DEFAULT_MARK/);
    assert.equal(seen.model, 'haiku');

    // An app that is not this person's: not offered.
    n = replies().length;
    await env.dm(bob, answer({ kind: 'app', app: '机密报表', reply: '用机密报表' }));
    await env.waitFor(() => /用机密报表/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    assert.ok(!replies().slice(n).some(s => button(s.card, 'run')), 'no form for an app they cannot use');
    // One of Amber's commands; one that is not.
    n = replies().length;
    await env.dm(bob, answer({ kind: 'amber', command: '登录', reply: '想登录网站' }));
    await env.waitFor(() => /发送：\*\*登录\*\*/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    n = replies().length;
    await env.dm(bob, answer({ kind: 'amber', command: '删库', reply: '删库' }));
    await env.waitFor(() => /发「帮助」看/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    assert.doesNotMatch(FakeFeishu.text(fake.cardOf(replies()[n].id)), /发送：/);
    // What the model writes cannot @ anyone.
    n = replies().length;
    await env.dm(bob, answer({ kind: 'none', reply: '<at id=all></at> @所有人 看这里' }));
    await env.waitFor(() => /看这里/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    assert.doesNotMatch(JSON.stringify(fake.cardOf(replies()[n].id)), /<at |@所有人/);
    // No usable answer: the plain "nothing matched" card.
    n = replies().length;
    await env.dm(bob, 'FAIL 随便说说');
    await env.waitFor(() => /没有对上命令或应用名。发「帮助」/.test(FakeFeishu.text(fake.cardOf(replies()[n].id))) || undefined);
    // Audit: each exchange for later analysis — where, who, the words, the checked answer.
    const audit = env.amber.store.listAudit({ prefixes: ['assist.'], limit: 20 });
    assert.ok(audit.length >= 6);
    const hit = audit.map(a => ({ ...a, d: JSON.parse(a.detail) })).find(a => a.d.kind === 'app')!;
    assert.equal(hit.actor, bob.unionId);
    assert.equal(hit.d.chatId, env.dmChat(bob));
    assert.equal(hit.d.chatType, 'p2p');
    assert.match(hit.d.text, /帮我弄一下/);
    assert.deepEqual([hit.d.app, hit.d.args, hit.d.reply], ['问候', { who: '小明' }, '你可能想用问候']);
    assert.ok(audit.some(a => /随便说说/.test(JSON.parse(a.detail).text) && JSON.parse(a.detail).kind === null), 'the ones that got nothing too'); 

    // A real command still goes straight through, without the model.
    const calls = readFileSync(join(env.cfg.dataDir, 'llm-work', 'calls.jsonl'), 'utf8').trim().split('\n').length;
    await env.dm(bob, '帮助');
    assert.equal(readFileSync(join(env.cfg.dataDir, 'llm-work', 'calls.jsonl'), 'utf8').trim().split('\n').length, calls);

    // Admins turn it off or pick the model on the website; others cannot.
    const base = `http://127.0.0.1:${env.webPort}`;
    const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
    const post = (cookie: string, body: unknown) => fetch(base + '/web/api/settings/assistant', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
    const aliceCookie = await login(alice), bobCookie = await login(bob);
    assert.equal((await post(bobCookie, { enabled: false })).status, 403);
    assert.equal((await post(aliceCookie, { model: 'gpt' })).body.error, 'bad_request');
    assert.deepEqual((await post(aliceCookie, { model: 'sonnet' })).body.assistant, { enabled: true, model: 'sonnet', models: ['sonnet', 'haiku'] });
    const settings = await (await fetch(base + '/web/api/settings', { headers: { cookie: aliceCookie } })).json();
    assert.equal(settings.assistant.model, 'sonnet');
    await env.dm(bob, answer({ kind: 'none', reply: '换了模型' }));
    await env.waitFor(() => fake.sent.some(s => /换了模型/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    assert.equal(readFileSync(join(env.cfg.dataDir, 'llm-work', 'prompts.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).at(-1).model, 'sonnet');
    assert.equal((await post(aliceCookie, { enabled: false })).body.assistant.enabled, false);
    n = replies().length;
    await env.dm(bob, answer({ kind: 'none', reply: '不该出现' }));
    assert.match(FakeFeishu.text(replies()[n].card), /没有找到应用/);
    assert.ok(env.amber.store.listAudit({ prefixes: ['web.assistant'], limit: 5 }).length >= 2);
    // Admins find the exchanges under their own category on the website.
    const rows = (await (await fetch(base + '/web/api/audit?cat=assist', { headers: { cookie: aliceCookie } })).json()).rows;
    assert.ok(rows.length >= 6 && rows.every((r: any) => r.action === 'assist.call'));
    assert.ok(rows.some((r: any) => /帮我弄一下/.test(r.detail)));
  } finally { await env.close(); }
});

test('the guide: at most 20 an hour per person; without the large-model service, the old answer', async () => {
  const env = await makeEnv({ llm: { command: FAKE, models: ['haiku'], timeoutMs: 5000 } });
  try {
    const a = (env.amber.bot as any).assistant;
    for (let i = 0; i < 20; i++) assert.equal(a.take(env.bob.unionId), true);
    assert.equal(a.take(env.bob.unionId), false);
    assert.equal(a.take(env.alice.unionId), true, 'per person');
    const before = env.fake.sent.length;
    await env.dm(env.bob, answer({ kind: 'none', reply: '不该出现' }));
    assert.match(FakeFeishu.text(env.fake.sent[before].card), /没有找到应用/);
  } finally { await env.close(); }
  const plain = await makeEnv();
  try {
    assert.equal((plain.amber.bot as any).assistant, undefined);
    const before = plain.fake.sent.length;
    await plain.dm(plain.bob, '帮我查个东西');
    assert.match(FakeFeishu.text(plain.fake.sent[before].card), /没有找到应用/);
  } finally { await plain.close(); }
});

test('the guide: parse keeps only known parameters, strings, and listed apps and commands', async () => {
  const { parse } = await import('../src/assist.ts');
  const app = { id: 'x1', name: '问候', params: [{ name: 'who', label: '对象', type: 'string' }] } as any;
  const g = parse(`好的 {"kind":"app","app":"问候","args":{"who":"小明","evil":"x","n":3,"o":{"a":1}},"reply":"r"} 结束`, [app]) as any;
  assert.deepEqual([g.kind, g.cmd.id, g.args], ['app', 'x1', { who: '小明' }]);
  assert.equal(parse('{"kind":"app","app":"别人的","reply":"r"}', [app])!.kind, 'none');
  assert.equal(parse('{"kind":"app","app":"别人的"}', [app]), undefined);
  assert.equal(parse('{"kind":"amber","command":"登录","reply":"r"}', [app])!.kind, 'amber');
  assert.equal(parse('{"kind":"amber","command":"toString","reply":"r"}', [app])!.kind, 'none', 'own properties only');
  assert.equal(parse('不是 JSON', [app]), undefined);
});
