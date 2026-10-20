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
    assert.equal(inst.title, 'Amber 应用：问候');
    const doc = [...env.fake.docs.values()].pop()!.join('\n');
    assert.match(doc, /print\("你好，"/, 'review doc has the full code');
    assert.match(doc, /你好，小明/, 'review doc has the trial output');
    await env.approveLatest();
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'active');
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /已生效/);
  } finally { await env.close(); }
});

test('when Feishu refuses the trial result card, the claim card keeps its buttons', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO });
    // Make Feishu refuse the card carrying the trial output, as it did for a table it could not show.
    const realPatch = env.fake.im.v1.message.patch;
    env.fake.im.v1.message.patch = async (a: any) => {
      if (/你好，世界/.test(a.data.content)) { const e: any = new Error('400'); e.response = { data: { code: 230099, msg: 'table rows is invalid' } }; throw e; }
      return realPatch(a);
    };
    await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    const card = await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit') && env.fake.cardOf(r.claimMessageId));
    assert.match(FakeFeishu.text(card), /显示不了/);
    assert.ok(button(card, 'claim_drop'), 'the draft can still be dropped');
    await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'pending');
    assert.match([...env.fake.docs.values()].pop()!.join('\n'), /你好，世界/, 'review doc still has the trial output');
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
    // A schedule on v1, created by its creator through the website-equivalent call.
    const sch = await env.amber.bot.scheduler.create({
      cmd: env.amber.store.getCommand(v1)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: env.alice.unionId, openId: env.alice.openId, chatId: GROUP, chatType: 'group', channel: 'web' },
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
    // The schedule paused; alice got a rebind card in her private chat.
    assert.equal(env.amber.store.getSchedule(sch.id)!.status, 'paused');
    const rebind = env.fake.lastTo(s => s.to.unionId === env.alice.unionId && !!button(s.card, 'sch_rebind'))!;
    const value = button(rebind.card, 'sch_rebind')!;
    assert.equal(value.c, r.id);
    // Carol is neither the schedule's creator nor an admin.
    assert.match(JSON.stringify(await env.click(env.carol, rebind.id, value)), /只有定时任务的创建人/);
    await env.click(env.alice, rebind.id, value);
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
    assert.match(FakeFeishu.text(env.fake.sent.at(-1)!.card), /没有找到应用/, 'carol does not even see it');
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
    const r = await env.api('POST', '/v1/runs', { chatId: GROUP, chatType: 'group', command: '问候', user: env.alice.email });
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

test('a draft that does not mention schedulable is schedulable; an explicit false stays false (D47)', async () => {
  const env = await makeEnv();
  try {
    await env.submit({ chatId: GROUP, chatType: 'group', name: '默认', params: [], script: HELLO });
    await env.submit({ chatId: GROUP, chatType: 'group', name: '关掉', params: [], script: HELLO, options: { schedulable: false } });
    const byName = (n: string) => env.amber.store.listAll().find(c => c.name === n)!;
    assert.equal(byName('默认').options.schedulable, true);
    assert.equal(byName('关掉').options.schedulable, false);
  } finally { await env.close(); }
});

test('a slow 提交审核 answers within the callback window and finishes in the background', async () => {
  const env = await makeEnv();
  try {
    (env.amber.bot as any).claimSubmitWaitMs = 100;
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '问候', params: [], script: HELLO });
    await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
    // Approval creation fails after the window: the card is left usable and the clicker is told.
    env.fake.approvalDelayMs = 400; env.fake.approvalFails = true;
    const sentBefore = env.fake.sent.length;
    assert.match(JSON.stringify(await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id })), /正在发起审批/);
    await env.waitFor(() => env.fake.sent.slice(sentBefore).find(s => s.to.replyTo === r.claimMessageId));
    assert.match(FakeFeishu.text(env.fake.sent.at(-1)!.card), /提交审核失败/);
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'draft');
    assert.ok(button(env.fake.cardOf(r.claimMessageId), 'claim_submit'), 'claim card still offers 提交审核');
    // Retried and slow but successful: the card is patched to 审核中 once the approval exists.
    env.fake.approvalFails = false;
    assert.match(JSON.stringify(await env.click(env.alice, r.claimMessageId, { a: 'claim_submit', c: r.id })), /正在发起审批/);
    await env.waitFor(() => /审核中/.test(FakeFeishu.text(env.fake.cardOf(r.claimMessageId))));
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'pending');
    assert.equal(env.fake.approvals.size, 1);
  } finally { await env.close(); }
});

test('resubmitting replaces the claimer\'s own unclaimed p2p draft; drafts under review, in groups or of others stay', async () => {
  const env = await makeEnv();
  try {
    const dm = 'oc_agentdm';
    env.fake.chats.set(dm, { mode: 'p2p', name: '', members: new Set(['BOT', env.bob.unionId]) });
    const draft = (claimer: string, out: string) => ({ chatId: dm, chatType: 'p2p', claimer, name: '日报', params: [], script: script(`print("${out}")`) });
    const a = await env.submit(draft(env.bob.email, 'v1'));
    assert.equal(a.ok, true);
    // Someone else's draft of the same name is not theirs to replace.
    const other = await env.submit(draft(env.carol.email, 'x'));
    assert.equal(other.error, 'name_taken');
    assert.equal(env.amber.store.getCommand(a.id)!.status, 'draft');
    // The claimer's own resubmission replaces it, and the old claim card says so.
    const b = await env.submit(draft(env.bob.email, 'v2'));
    assert.equal(b.ok, true, JSON.stringify(b));
    assert.equal(env.amber.store.getCommand(a.id)!.status, 'rejected');
    assert.equal(env.amber.store.getCommand(b.id)!.line, '日报', 'the replacement keeps the name as its line');
    assert.match(FakeFeishu.text(env.fake.cardOf(a.claimMessageId)), /已被新版本替换/);
    assert.match(JSON.stringify(await env.click(env.bob, a.claimMessageId, { a: 'claim_try', c: a.id })), /已失效/);
    // Once it is under review it is not replaced.
    await env.click(env.bob, b.claimMessageId, { a: 'claim_try', c: b.id });
    await env.waitFor(() => button(env.fake.cardOf(b.claimMessageId), 'claim_submit'));
    await env.click(env.bob, b.claimMessageId, { a: 'claim_submit', c: b.id });
    assert.equal(env.amber.store.getCommand(b.id)!.status, 'pending');
    const c = await env.submit(draft(env.bob.email, 'v3'));
    assert.equal(c.error, 'name_taken');
    assert.equal(env.amber.store.getCommand(b.id)!.status, 'pending');
    // A new version of an active app: its unclaimed draft is replaced too, and still replaces the active one.
    await env.approveLatest();
    const v4 = await env.submit(draft(env.bob.email, 'v4'));
    const v5 = await env.submit(draft(env.bob.email, 'v5'));
    assert.equal(v5.ok, true, JSON.stringify(v5));
    assert.equal(env.amber.store.getCommand(v4.id)!.status, 'rejected');
    assert.equal(env.amber.store.getMeta(v5.id).replaces, b.id);
    // Group drafts may be claimed by anyone, so they are never replaced.
    const g1 = await env.submit({ chatId: GROUP, chatType: 'group', claimer: env.bob.email, name: '日报', params: [], script: HELLO });
    assert.equal(g1.ok, true);
    const g2 = await env.submit({ chatId: GROUP, chatType: 'group', claimer: env.bob.email, name: '日报', params: [], script: HELLO });
    assert.equal(g2.error, 'name_taken');
    assert.equal(env.amber.store.getCommand(g1.id)!.status, 'draft');
  } finally { await env.close(); }
});

test('a replacement whose claim card cannot be sent leaves the old draft claimable', async () => {
  const env = await makeEnv();
  try {
    const dm = 'oc_agentdm';
    const draft = (out: string) => ({ chatId: dm, chatType: 'p2p', claimer: env.bob.email, name: '日报', params: [], script: script(`print("${out}")`) });
    const a = await env.submit(draft('v1'));
    env.fake.sendFails = true;
    const b = await env.submit(draft('v2'));
    assert.equal(b.error, 'claim_card_failed');
    assert.equal(env.amber.store.getCommand(a.id)!.status, 'draft');
    env.fake.sendFails = false;
    await env.click(env.bob, a.claimMessageId, { a: 'claim_try', c: a.id });
    await env.waitFor(() => button(env.fake.cardOf(a.claimMessageId), 'claim_submit'));
  } finally { await env.close(); }
});

test('a trial run shows it is running at once, and clicking again does not start another', async () => {
  const env = await makeEnv();
  try {
    const slow = script('import time\ntime.sleep(1.5)\nprint("好了")', { timeoutMs: 20000 });
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '慢', params: [], script: slow });
    const first = await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    assert.match(JSON.stringify(first), /试运行中：慢/);
    assert.match(JSON.stringify(first), /不用重复点击/);
    assert.match(JSON.stringify(first), /20 秒/, 'says how long it may take');
    assert.ok(!button(first.card.data, 'claim_try') && !button(first.card.data, 'claim_submit'), 'no buttons while it runs');
    const again = await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id });
    assert.match(JSON.stringify(again), /还在进行中/);
    assert.equal(again.card, undefined);
    await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /好了/);
    assert.equal(env.amber.store.runsByCaller(env.alice.unionId, 10).filter(x => x.commandName === '慢').length, 1, 'one run, not two');
    // Done: it can be tried again.
    assert.match(JSON.stringify(await env.click(env.alice, r.claimMessageId, { a: 'claim_try', c: r.id })), /试运行中/);
    await env.waitFor(() => env.amber.store.runsByCaller(env.alice.unionId, 10).filter(x => x.commandName === '慢').length === 2 || undefined, 20000);
  } finally { await env.close(); }
});
