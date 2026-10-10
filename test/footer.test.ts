// Card footer: every card Amber sends or updates ends with one line an admin sets on the website;
// until then it is the project link. Admin input is made safe: one line, no tags, no @.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, urlButton, script, GROUP } from './env.ts';
import { withFooter, cleanFooter, DEFAULT_CARD_FOOTER } from '../src/cards.ts';

const footerOf = (card: any) => card?.body?.elements?.find((e: any) => e.element_id === 'amber_footer')?.content as string | undefined;

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('footer: default on every card, admin changes it on the website, others cannot', async () => {
  const env = await makeEnv();
  const { fake, alice, bob } = env;   // alice is an admin
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, body: unknown) => fetch(base + '/web/api/settings/card-footer', { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    await env.say(bob, GROUP, '帮助');
    const help = fake.sent.at(-1)!;
    assert.ok(footerOf(help.card)?.includes(DEFAULT_CARD_FOOTER), 'help card has the default footer');
    // A card returned from a button click (not sent as a message) gets it too.
    const clicked: any = await env.click(bob, help.id, { a: 'list' });
    assert.ok(footerOf(clicked?.card?.data)?.includes('github.com/xu4wang/amber'), 'card from a click has the footer');

    // Cards the review flow sends (the claim card) and later updates.
    const sub = await env.submit({ chatId: GROUP, chatType: 'group', name: '页脚测试', params: [], script: script('print(1)'), options: {} });
    assert.ok(footerOf(fake.cardOf(sub.claimMessageId))?.includes(DEFAULT_CARD_FOOTER), 'claim card has the footer');

    const aliceCookie = await login(env, alice), bobCookie = await login(env, bob);
    assert.ok(footerOf(fake.sent.at(-1)!.card), 'the login card has the footer');
    // Only admins see or change it.
    assert.equal((await fetch(base + '/web/api/settings', { headers: { cookie: bobCookie } })).status, 404);
    const denied = await post(bobCookie, { value: '别人改的' });
    assert.equal(denied.body.ok, false);
    assert.equal(env.amber.store.getSetting('card_footer'), undefined);
    const s0 = await (await fetch(base + '/web/api/settings', { headers: { cookie: aliceCookie } })).json();
    assert.equal(s0.cardFooter, null);
    assert.equal(s0.defaultCardFooter, DEFAULT_CARD_FOOTER);

    // Set: made safe (one line, no tags, no @), shown on the next card.
    const set = await post(aliceCookie, { value: '数据平台组 @所有人 <at id=all></at>\n[使用手册](https://example.com/manual)' });
    assert.equal(set.body.ok, true);
    const saved = env.amber.store.getSetting('card_footer')!;
    assert.ok(!/[@<>\n]/.test(saved), saved);
    assert.ok(saved.includes('[使用手册](https://example.com/manual)'), 'links are kept');
    await env.say(bob, GROUP, '帮助');
    assert.ok(footerOf(fake.sent.at(-1)!.card)?.includes('数据平台组'), 'new footer on the next card');

    // "" = no footer at all; null = back to the default.
    await post(aliceCookie, { value: '' });
    await env.say(bob, GROUP, '帮助');
    assert.equal(footerOf(fake.sent.at(-1)!.card), undefined, 'turned off');
    assert.ok(!JSON.stringify(fake.sent.at(-1)!.card).includes('amber_footer_hr'), 'no divider either');
    await post(aliceCookie, { value: null });
    await env.say(bob, GROUP, '帮助');
    assert.ok(footerOf(fake.sent.at(-1)!.card)?.includes(DEFAULT_CARD_FOOTER), 'back to the default');
  } finally { await env.close(); }
});

test('footer: added once, kept to one safe line', () => {
  const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'x' }] } };
  const once = withFooter(card, 'F');
  assert.equal(withFooter(once, 'F'), once, 'a card that already has the footer is left alone');
  assert.equal(once.body.elements.length, 3);
  assert.equal(card.body.elements.length, 1, 'the original card is not changed');
  assert.equal(withFooter(card, ''), card);
  assert.equal(cleanFooter('a\r\nb <font> @c'), 'a b ＜font＞ ＠c');
  assert.equal(cleanFooter('x'.repeat(500)).length, 200);
  assert.equal(cleanFooter('[手册](https://a.example/m) [坏](javascript:void0) [文件](file:///etc)'), '[手册](https://a.example/m) 坏（javascript:void0） 文件（file:///etc）');
});
