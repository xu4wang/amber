// Draft → claim → review → active, rejection, new versions, retiring.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const HELLO = script('import json,sys\ninp=json.load(sys.stdin)\nprint("你好，" + inp["params"].get("who","世界"))');

test('draft is claimed, trial-run, reviewed in Feishu and becomes active', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', description: 'say hi', params: [{ name: 'who', label: '对象', type: 'string' }], script: HELLO });
    assert.equal(r.ok, true);
    const claim = env.fake.cardOf(r.claimMessageId);
    assert.match(FakeFeishu.text(claim), /TestBot/);
    assert.doesNotMatch(FakeFeishu.text(claim), /local/, 'machine names are not shown to people');
    // Submitting before a trial run is refused.
    assert.match(JSON.stringify(await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id })), /试运行/);
    // Someone outside the group cannot claim.
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'draft');
    await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id }, { who: '小明' });
    const tried = await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit') && env.fake.cardOf(r.claimMessageId));
    assert.match(FakeFeishu.text(tried), /你好，小明/);
    await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'pending');
    const [inst] = [...env.fake.approvals.values()];
    assert.equal(inst.title, 'Amber 指令：问候');
    const doc = [...env.fake.docs.values()].pop()!.join('\n');
    assert.match(doc, /print\("你好，"/, 'review doc has the full code');
    assert.match(doc, /你好，小明/, 'review doc has the trial output');
    await env.approveLatest();
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'active');
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /已生效/);
  } finally { await env.close(); }
});

test('a rejected approval rejects the command', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO });
    await env.click(env.bob, r.claimMessageId, { a: 'claim_try', c: r.id });
    await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
    await env.click(env.bob, r.claimMessageId, { a: 'claim_submit', c: r.id });
    const code = [...env.fake.approvals.keys()].pop()!;
    env.fake.decide(code, { [env.alice.openId]: 'REJECTED' });
    await env.amber.bot.flow.onApprovalEvent(code);
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'rejected');
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /未通过/);
  } finally { await env.close(); }
});

test('submitting a draft into a chat Amber is not in fails cleanly', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: 'oc_nowhere', chatType: 'group', name: '问候', params: [], script: HELLO });
    assert.equal(r.ok, false);
    assert.match(r.message, /不在这个群里/);
  } finally { await env.close(); }
});

test('the API refuses machines that are not on the allowlist', async () => {
  const env = await makeEnv();
  try {
    const r = await env.api('POST', '/v1/drafts', {}, '10.9.9.9');
    assert.equal(r.status, 403);
    const ok = await env.api('GET', '/v1/info', undefined, '10.0.0.2');
    assert.equal(ok.body.machine, 'fleet-b');
  } finally { await env.close(); }
});

test('a new version shows the diff, only the owner may claim it, and it replaces the old one', async () => {
  const env = await makeEnv();
  try {
    const v1 = await activate(env, { chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO, options: { schedulable: true } }, env.alice);
    // A schedule on v1, created by bob through the website-equivalent call.
    const sch = await env.amber.bot.scheduler.create({
      cmd: env.amber.store.getCommand(v1)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: env.bob.unionId, openId: env.bob.openId, chatId: GROUP, chatType: 'group', channel: 'web' },
      args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, requestedBy: 'test', via: {},
    });
    const v2code = script('import json,sys\nprint("您好（第 2 版）")');
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: v2code, options: { schedulable: true } });
    assert.equal(r.ok, true);
    const card = FakeFeishu.text(env.fake.cardOf(r.claimMessageId));
    assert.match(card, /新版本/);
    assert.match(card, /- print\(\\"你好，/);
    assert.match(card, /\+ print\(\\"您好（第 2 版）/);
    // Only one version in progress at a time.
    assert.equal((await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: v2code })).ok, false);
    // Bob is not the owner.
    assert.match(JSON.stringify(await env.click(env.bob, r.claimMessageId, { a: 'claim_try', c: r.id })), /原创建人/);
    await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
    await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    const doc = [...env.fake.docs.values()].pop()!.join('\n');
    assert.match(doc, /与当前版本的差异/);
    assert.match([...env.fake.approvals.values()].pop()!.title!, /新版本/);
    await env.approveLatest();
    assert.equal(env.amber.store.getCommand(v1)!.status, 'retired');
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'active');
    // The schedule paused; bob got a rebind card in his private chat.
    assert.equal(env.amber.store.getSchedule(sch.id)!.status, 'paused');
    const rebind = env.fake.lastTo(s => s.to.unionId === env.bob.unionId)!;
    const value = button(rebind.card, 'sch_rebind')!;
    assert.equal(value.c, r.id);
    // Alice is not the schedule's creator (but she is an admin, so allowed); carol is not.
    assert.match(JSON.stringify(await env.click(env.carol, rebind.id, value)), /创建人或管理员/);
    await env.click(env.bob, rebind.id, value);
    const s = env.amber.store.getSchedule(sch.id)!;
    assert.equal(s.status, 'active');
    assert.equal(s.commandId, r.id);
    assert.equal(env.amber.store.versionsOf(r.id).length, 1);
  } finally { await env.close(); }
});

test('only the owner or an admin can retire a command; its schedules pause', async () => {
  const env = await makeEnv();
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO, options: { schedulable: true } }, env.bob);
    const sch = await env.amber.bot.scheduler.create({
      cmd: env.amber.store.getCommand(id)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: env.bob.unionId, openId: env.bob.openId, chatId: GROUP, chatType: 'group', channel: 'web' },
      args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, requestedBy: 'test', via: {},
    });
    env.fake.chats.get(GROUP)!.members.add(env.carol.unionId);
    await env.say(env.carol, GROUP, '下线 问候');
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
    assert.match(FakeFeishu.text(env.fake.sent.at(-1)!.card), /创建人或管理员/);
    // D44: retiring from Feishu asks once more; only the requester can confirm.
    await env.say(env.bob, GROUP, '下线 问候');
    assert.equal(env.amber.store.getCommand(id)!.status, 'active', 'not retired before confirming');
    const confirmCard = env.fake.sent.at(-1)!;
    assert.match(FakeFeishu.text(confirmCard.card), /确定下线「问候」/);
    assert.match(FakeFeishu.text(confirmCard.card), /1 个定时任务/);
    // Not even an admin (alice) can confirm someone else's request.
    await env.click(env.alice, confirmCard.id, button(confirmCard.card, 'retire_ok')!);
    assert.equal(env.amber.store.getCommand(id)!.status, 'active', 'someone else cannot confirm');
    const cancel = await env.click(env.bob, confirmCard.id, button(confirmCard.card, 'retire_no')!);
    assert.match(JSON.stringify(cancel), /已取消下线/);
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
    // An expired confirmation does nothing.
    const old = { ...button(confirmCard.card, 'retire_ok')!, t: String(Date.now() - 6 * 60_000) };
    const expired = await env.click(env.bob, confirmCard.id, old);
    assert.match(JSON.stringify(expired), /已过期/);
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
    await env.click(env.bob, confirmCard.id, button(confirmCard.card, 'retire_ok')!);
    assert.equal(env.amber.store.getCommand(id)!.status, 'retired');
    assert.equal(env.amber.store.getSchedule(sch.id)!.status, 'paused');
    assert.ok(env.fake.sent.some(s => s.to.unionId === env.bob.unionId && /已被.*下线/.test(FakeFeishu.text(s.card))));
  } finally { await env.close(); }
});

test('a command whose stored definition was changed after approval refuses to run', async () => {
  const env = await makeEnv();
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO }, env.alice);
    // Someone edits the code in the database behind Amber's back.
    (env.amber.store as any).db.prepare('UPDATE commands SET script_json = ? WHERE id = ?').run(JSON.stringify({ ...HELLO, code: 'print("tampered")' }), id);
    const r = await env.api('POST', '/v1/runs', { chatId: GROUP, chatType: 'group', command: '问候' });
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /审核通过的版本不一致/);
  } finally { await env.close(); }
});

test('reviewers can be configured by email or union_id; the approval goes to all of them', async () => {
  const env = await makeEnv({ reviewers: ['alice@example.com', 'on_bob'] });
  try {
    const flow: any = env.amber.bot.flow;
    assert.deepEqual([...flow.reviewers].sort(), ['on_alice', 'on_bob']);
    assert.deepEqual([...flow.reviewerOpenIds].sort(), ['ou_alice', 'ou_bob'], 'a union_id entry also resolves to an open_id');
  } finally { await env.close(); }
});

test('a group draft can name the person who asked; the claim card @-mentions them but anyone may claim (D46)', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO, claimer: env.bob.unionId });
    assert.equal(r.ok ?? true, true);
    const card = env.fake.sent.at(-1)!;
    assert.equal(card.to.chatId, GROUP);
    assert.match(JSON.stringify(card.card), /<at id=ou_bob><\/at>/);
    // Without a claimer nobody is mentioned.
    await env.submit({ chatId: GROUP, chatType: 'group', name: '问候2', params: [], script: HELLO });
    assert.doesNotMatch(JSON.stringify(env.fake.sent.at(-1)!.card), /<at id=/);
    // An unknown claimer is refused instead of silently dropped.
    const bad = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候3', params: [], script: HELLO, claimer: 'nobody@example.com' });
    assert.match(JSON.stringify(bad), /找不到认领人/);
  } finally { await env.close(); }
});
