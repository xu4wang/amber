// #1: `@名字` in a real run's result becomes a real @ of that group member (a person or a bot).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { Mentions, MAX_MENTIONS } from '../src/cards.ts';

const ECHO = script('import json,sys\nprint(json.load(sys.stdin)["params"].get("text",""))');
const at = (id: string) => `<at id=${id}></at>`;

test('mentions: exact names, longest first, not inside a longer word, @所有人 never, at most 5', () => {
  const m = new Mentions(new Map([['马', 'ou_ma'], ['马小马', 'ou_mxm'], ['alice', 'ou_alice'], ['所有人', 'ou_all'], ['bad', 'oc_notauser']]));
  assert.equal(m.apply('＠马小马 看下'), `${at('ou_mxm')} 看下`);
  assert.equal(m.apply('＠马 好'), `${at('ou_ma')} 好`);
  assert.equal(m.apply('＠alice2 ＠alice_x ＠alice'), `＠alice2 ＠alice_x ${at('ou_alice')}`);
  assert.equal(m.apply('＠所有人 ＠bad ＠bob'), '＠所有人 ＠bad ＠bob');
  const many = new Map(Array.from({ length: MAX_MENTIONS + 2 }, (_, i) => [`u${String.fromCharCode(97 + i)}`, `ou_${i}`] as [string, string]));
  const m2 = new Mentions(many);
  const out = m2.apply([...many.keys()].map(n => `＠${n}`).join(' ') + ' ＠ua');
  assert.equal(out.match(/<at id=/g)!.length, MAX_MENTIONS + 1, 'five distinct members, and the first one again');
  assert.match(out, /＠uf ＠ug/);
  assert.equal(m2.used.size, MAX_MENTIONS);
});

test('mentions: a group result @s members and bots by name; trial runs, private chats and lookup failures do not', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;
  let lookups = 0;
  const req = fake.request.bind(fake);
  fake.request = async (o: any) => { if (/\/members/.test(o.url)) lookups++; return req(o); };
  try {
    fake.chatBots.set(GROUP, [{ name: '同步机器人', openId: 'ou_syncbot' }, { name: '双胞胎', openId: 'ou_twin1' }, { name: '双胞胎', openId: 'ou_twin2' }]);
    // Trial run: shown as plain text.
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '转交', params: [{ name: 'text', label: '内容', type: 'string' }], script: ECHO });
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id }, { text: '@bob 试运行' });
    const tried = await env.waitFor(() => button(fake.cardOf(r.claimMessageId), 'claim_submit') && fake.cardOf(r.claimMessageId));
    assert.match(FakeFeishu.text(tried), /＠bob 试运行/);
    assert.doesNotMatch(FakeFeishu.text(tried), /ou_bob/);
    await env.click(alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    await env.approveLatest();

    // Real run in the group.
    lookups = 0;
    await env.say(alice, GROUP, '转交 "@bob @同步机器人 请拉代码 @carol @所有人 @双胞胎 @amber"');
    const card = await env.waitFor(() => fake.sent.map(s => fake.cardOf(s.id)).find(c => /请拉代码/.test(FakeFeishu.text(c))));
    const text = FakeFeishu.text(card);
    assert.ok(text.includes(at(bob.openId)), text);
    assert.ok(text.includes(at('ou_syncbot')));
    assert.match(text, /＠carol/, 'not in the group');
    assert.match(text, /＠所有人/);
    assert.match(text, /＠双胞胎/, 'two members share the name');
    assert.match(text, /＠amber/, 'not Amber itself');
    assert.deepEqual([...new Set(text.match(/<at id=[^>]+>/g))].sort(), [at(alice.openId), at(bob.openId), at('ou_syncbot')].map(x => x.replace('</at>', '')).sort(), 'the runner (footer), bob and the bot');
    assert.ok(lookups > 0);

    // No @ in the output: no member lookup.
    (env.amber.bot as any).mentionCache.clear();
    lookups = 0;
    await env.say(alice, GROUP, '转交 没有提到人');
    await env.waitFor(() => fake.sent.some(s => /没有提到人/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    assert.equal(lookups, 0);

    // Members cannot be listed: the result still arrives, without @s.
    fake.membersApiAllowed = false;
    await env.say(alice, GROUP, '转交 "@bob 查不到成员"');
    const plain = await env.waitFor(() => fake.sent.map(s => fake.cardOf(s.id)).find(c => /查不到成员/.test(FakeFeishu.text(c))));
    assert.doesNotMatch(FakeFeishu.text(plain), /ou_bob/);
    fake.membersApiAllowed = true;

    // Private chat: never.
    lookups = 0;
    assert.equal(await (env.amber.bot as any).mentionsFor(env.dmChat(carol), 'p2p', [{ kind: 'markdown', text: '@carol 私聊' }]), undefined);
    assert.equal(lookups, 0);
  } finally { await env.close(); }
});

test('mentions: a schedule result @s the member it names', async () => {
  const env = await makeEnv();
  const { fake, bob } = env;
  try {
    fake.chatBots.set(GROUP, [{ name: '同步机器人', openId: 'ou_syncbot' }]);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '检查', params: [], script: script('print("有更新，@同步机器人 请拉代码")'), options: { schedulable: true } }, env.alice);
    const r = await env.api('POST', '/v1/schedules', { chatId: GROUP, chatType: 'group', label: 'TestBot', user: bob.email, command: '检查', at: '每 5 分钟' });
    const req = fake.sent.at(-1)!;
    await env.click(bob, req.id, button(req.card, 'req_ok')!);
    const id = (await env.api('GET', `/v1/requests/${r.body.requestId}`)).body.scheduleId as string;
    const before = fake.sent.length;
    await env.amber.bot.scheduler.tick(env.amber.store.getSchedule(id)!.nextRunAt + 1000);
    const posted = await env.waitFor(() => fake.sent.slice(before).find(s => s.to.chatId === GROUP));
    assert.ok(FakeFeishu.text(posted.card).includes(at('ou_syncbot')), FakeFeishu.text(posted.card));
  } finally { await env.close(); }
});

test('mentions: a run an agent asked for and a person confirmed @s the member it names', async () => {
  const env = await makeEnv();
  const { fake, bob } = env;
  try {
    fake.chatBots.set(GROUP, [{ name: '同步机器人', openId: 'ou_syncbot' }]);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认转交', params: [], script: script('print("@同步机器人 请处理")'), options: { confirm: true } }, env.alice);
    const r = await env.api('POST', '/v1/runs', { chatId: GROUP, chatType: 'group', label: 'TestBot', user: bob.email, command: '确认转交' });
    const card = fake.sent.at(-1)!;
    await env.click(bob, card.id, button(card.card, 'req_ok')!);
    assert.equal((await env.api('GET', `/v1/requests/${r.body.requestId}?wait=10`)).body.status, 'done');
    const done = await env.waitFor(() => /请处理/.test(FakeFeishu.text(fake.cardOf(card.id))) && fake.cardOf(card.id));
    assert.ok(FakeFeishu.text(done).includes(at('ou_syncbot')), FakeFeishu.text(done));
  } finally { await env.close(); }
});
