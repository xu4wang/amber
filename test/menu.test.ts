// The bot menu under the private chat with Amber (D57): 我的应用 / 定时任务 / 授权飞书 without typing a command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, script, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const menu = (u: any, key: string, ts = String(Date.now() + Math.random())) => ({ operator: { operator_id: { union_id: u.unionId, open_id: u.openId } }, event_key: key, timestamp: ts });

test('bot menu: 我的应用 lists what the person can use in their private chat, with buttons; 定时任务 and unknown keys answer too', async () => {
  const env = await makeEnv();
  const { alice, bob, fake } = env;
  try {
    const bot = env.amber.bot as any;
    fake.chats.set('oc_dmalice', { mode: 'p2p', name: '', members: new Set(['BOT', alice.unionId]) });
    // alice: one app in her private chat, one in the group (not usable in her private chat), one global.
    await activate(env, { chatId: 'oc_dmalice', chatType: 'p2p', claimer: alice.email, name: '我的私聊应用', params: [], script: script('print(1)') }, alice);
    await activate(env, { chatId: GROUP, chatType: 'group', name: '群里的应用', params: [], script: script('print(2)') }, alice);
    const g = await activate(env, { chatId: GROUP, chatType: 'group', name: '大家的应用', params: [], script: script('print(3)') }, alice);
    env.amber.store.setGlobal(g, true);

    let before = fake.sent.length;
    await bot.onMenu(menu(alice, 'amber_apps'));
    const sent = fake.sent.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to.unionId, alice.unionId, 'to her private chat');
    const card = sent[0].card;
    const text = FakeFeishu.text(card);
    assert.match(text, /我的私聊应用/); assert.match(text, /大家的应用/); assert.doesNotMatch(text, /群里的应用/);
    assert.ok(button(card, 'pick'), 'click to run');

    // bob sees only the global one.
    before = fake.sent.length;
    await bot.onMenu(menu(bob, 'amber_apps'));
    const bt = FakeFeishu.text(fake.sent[before].card);
    assert.match(bt, /大家的应用/); assert.doesNotMatch(bt, /我的私聊应用/);

    before = fake.sent.length;
    await bot.onMenu(menu(alice, 'amber_schedules'));
    assert.match(FakeFeishu.text(fake.sent[before].card), /定时任务/);

    before = fake.sent.length;
    await bot.onMenu(menu(alice, 'something_else'));
    assert.match(FakeFeishu.text(fake.sent[before].card), /还不认识/);

    // The same event delivered twice answers once; no operator, no answer.
    before = fake.sent.length;
    const e = menu(alice, 'amber_apps', 'fixed-ts');
    await bot.onMenu(e); await bot.onMenu(e);
    await bot.onMenu({ event_key: 'amber_apps' });
    assert.equal(fake.sent.length - before, 1);
  } finally { await env.close(); }
});

test('bot menu: 授权飞书 sends the authorization card to the private chat', async () => {
  let started = 0;
  const oauth: any = {
    async userScopes() { return ['im:message:readonly']; },
    async deviceStart() { started++; return { deviceCode: 'dc-1', userCode: 'UC-1', verificationUrl: 'https://accounts.example/verify?flow=dc-1', expiresIn: 600, interval: 0 }; },
    async devicePoll() { return { status: 'pending' }; },
    async refresh() { throw new Error('no'); },
    async whoAmI() { throw new Error('no'); },
  };
  const env = await makeEnv({}, { larkOAuth: oauth });
  try {
    const before = env.fake.sent.length;
    await (env.amber.bot as any).onMenu(menu(env.alice, 'amber_auth'));
    const sent = env.fake.sent.slice(before);
    assert.equal(started, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to.unionId, env.alice.unionId);
    assert.match(JSON.stringify(sent[0].card), /accounts\.example\/verify/);
    assert.match(FakeFeishu.text(sent[0].card), /UC-1/);
  } finally { await env.close(); }
});

test('bot menu: 打开网站 (amber_login) sends a one-time login link to the private chat', async () => {
  const env = await makeEnv();
  try {
    const before = env.fake.sent.length;
    await (env.amber.bot as any).onMenu(menu(env.alice, 'amber_login'));
    const sent = env.fake.sent.slice(before);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to.unionId, env.alice.unionId, 'only to her private chat');
    const m = /\/login\?t=([A-Za-z0-9_-]+)/.exec(JSON.stringify(sent[0].card));
    assert.ok(m, 'a login link');
    // The link logs in as alice.
    const r = await fetch(`http://127.0.0.1:${env.webPort}/login?t=${m![1]}`, { redirect: 'manual' });
    assert.ok([200, 302, 303].includes(r.status), String(r.status));
    assert.match(r.headers.get('set-cookie') ?? '', /=/, 'a session cookie');
  } finally { await env.close(); }
});
