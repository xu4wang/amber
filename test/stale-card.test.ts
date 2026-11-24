// Feishu updates a card only within 14 days of sending it. 11-24: 「Simba额度与负载」's card from 11-07 answered
// 「选择」 with its form, Feishu kept the old card, and the 执行 button never appeared. On an older card the next
// step goes out as a new card under it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { STALE_CARD_MS } from '../src/bot.ts';

test('a click on a card older than 14 days gets a new card instead of updating the old one', async () => {
  const env = await makeEnv();
  const { fake, alice } = env;
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '额度', params: [], script: script('print("ok")') }, alice);
    const card = fake.sent.filter(s => s.to.chatId === GROUP || s.to.replyTo).at(-1)!;

    // Recent: the form replaces the card, as before.
    const before = fake.sent.length;
    const fresh = await env.click(alice, card.id, { a: 'pick', c: id });
    assert.match(JSON.stringify(fresh), /"a":"run"/);
    assert.equal(fake.sent.length, before, 'nothing new sent');

    // 15 days old (the time is looked up once per message, so a new message stands in for the old one).
    const old = fake.sent.find(s => s.id === card.id)!;
    const oldId = fake.sent.push({ ...old, id: 'om_old', at: Date.now() - STALE_CARD_MS - 3600_000 }) && 'om_old';
    const r = await env.click(alice, oldId, { a: 'pick', c: id });
    assert.equal(r.card, undefined, 'no update Feishu would drop');
    assert.match(r.toast.content, /超过 14 天.*新的/);
    const reply = fake.sent.at(-1)!;
    assert.equal(reply.to.replyTo, oldId);
    assert.match(FakeFeishu.text(reply.card), /"a":"run"/);
    // The new card works the usual way: 执行 runs and updates it.
    const ran = await env.click(alice, reply.id, { a: 'run', c: id });
    assert.match(JSON.stringify(ran), /正在以/);
    await env.waitFor(() => fake.patches.find(p => p.id === reply.id && /ok/.test(FakeFeishu.text(p.card))));
    // 执行 on the old card itself (a form sent long ago): the result goes to the new card, not to the old one.
    const n = fake.sent.length;
    await env.click(alice, oldId, { a: 'run', c: id });
    const runCard = fake.sent[n];
    assert.equal(runCard.to.replyTo, oldId);
    await env.waitFor(() => fake.patches.find(p => p.id === runCard.id && /ok/.test(FakeFeishu.text(p.card))));
    assert.equal(fake.patches.filter(p => p.id === oldId).length, 0);

    // When Feishu cannot tell the time, the card counts as recent (the old behaviour).
    fake.sent.push({ ...old, id: 'om_old2', at: Date.now() - STALE_CARD_MS - 3600_000 });
    const get = fake.im.v1.message.get;
    (fake.im.v1.message as any).get = async () => { throw new Error('down'); };
    const unknown = await env.click(alice, 'om_old2', { a: 'pick', c: id });
    fake.im.v1.message.get = get;
    assert.match(JSON.stringify(unknown), /"a":"run"/);
  } finally { await env.close(); }
});
