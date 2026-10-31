// Self-use without review (config selfUse): an app that reaches nothing beyond what its creator's agent already can
// goes live after the creator's trial run, for the creator alone. It cannot be shared until a reviewed version replaces it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { runCommand, selfUseBlockers } from '../src/engine.ts';

const ctx = (u?: any) => ({ chatId: GROUP, chatType: 'group', label: 'TestBot', ...(u ? { user: u.email } : {}) });

async function tried(env: any, name: string, extra: Record<string, unknown> = {}) {
  const r = await env.submit({ chatId: GROUP, chatType: 'group', name, params: [], script: script('print(1)', extra) });
  await env.click(env.bob, r.claimMessageId, { a: 'claim_try', c: r.id });
  await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
  return r;
}

test('self-use off (default): only 提交审核 after the trial run', async () => {
  const env = await makeEnv();
  try {
    const r = await tried(env, '默认');
    assert.equal(button(env.fake.cardOf(r.claimMessageId), 'claim_self'), undefined);
    assert.match(JSON.stringify(await env.click(env.bob, r.claimMessageId, { a: 'claim_self', c: r.id })), /需要审核/);
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'draft');
  } finally { await env.close(); }
});

test('self-use: live for its creator alone, and cannot be shared', async () => {
  const env = await makeEnv({ selfUse: { services: [] } });
  try {
    const r = await tried(env, '自用');
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /直接生效（仅自己用）/);
    // Only after a trial run by the clicker.
    assert.match(JSON.stringify(await env.click(env.alice, r.claimMessageId, { a: 'claim_self', c: r.id })), /试运行/);
    const card = JSON.stringify(await env.click(env.bob, r.claimMessageId, { a: 'claim_self', c: r.id }));
    assert.match(card, /只有你本人能执行/);
    const c = env.amber.store.getCommand(r.id)!;
    assert.equal(c.status, 'active');
    assert.equal(c.selfApproved, true);
    assert.equal(c.ownerUnionId, env.bob.unionId);
    // The creator runs it; anyone else is refused, however they reach it.
    const as = (u: any) => ({ unionId: u.unionId, chatId: GROUP, chatType: 'group' as const, channel: 'page' as const });
    assert.equal((await runCommand(env.amber.store, c, {}, as(env.bob))).ok, true);
    await assert.rejects(runCommand(env.amber.store, c, {}, as(env.alice)), /仅自己用/);
    // Global (chat command by an admin, and via the agent), copy, reassign: all refused.
    const g = await env.api('POST', '/v1/commands/scope', { ...ctx(env.alice), command: '自用', global: true });
    assert.match(g.body.message, /仅自己用/);
    await assert.rejects(env.amber.bot.apps.requestListing(c.id, { unionId: env.bob.unionId, openId: env.bob.openId }), /仅自己用/);
    await assert.rejects(env.amber.bot.requestClone(c.id, env.alice.unionId, { unionId: env.bob.unionId }), /仅自己用/);
    env.fake.chats.get(GROUP)!.members.delete(env.bob.unionId);
    await assert.rejects(env.amber.bot.requestReassign(c.id, env.alice.unionId, { unionId: env.alice.unionId }), /仅自己用/);
    env.amber.store.setGlobal(c.id, true);   // even if it were made global some other way
    await assert.rejects(runCommand(env.amber.store, env.amber.store.getCommand(c.id)!, {}, as(env.alice)), /仅自己用/);
  } finally { await env.close(); }
});

test('self-use: apps that reach more than the agent can are reviewed', async () => {
  for (const extra of [{ secrets: ['TOKEN'] }, { network: true }, { larkUser: true }]) {
    const env = await makeEnv({ selfUse: { services: [] } });
    try {
      const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '扩权', params: [], script: script('print(1)', extra) });
      // Force a successful trial on record without running it (secrets/larkUser would need set-up): the button and the
      // action both follow the script, not the trial.
      env.amber.store.setMeta(r.id, { trialBy: env.bob.unionId });
      assert.equal(button(env.amber.bot.flow.trialUnshownCard(r.id, { unionId: env.bob.unionId, chatId: GROUP, chatType: 'group', channel: 'bot' }), 'claim_self'), undefined, JSON.stringify(extra));
      assert.match(JSON.stringify(await env.click(env.bob, r.claimMessageId, { a: 'claim_self', c: r.id })), /需要审核/);
    } finally { await env.close(); }
  }
  const s = (x: Record<string, unknown>) => ({ kind: 'script', lang: 'python', code: 'print(1)', ...x }) as any;
  assert.deepEqual(selfUseBlockers(s({}), []), []);
  assert.deepEqual(selfUseBlockers(s({ services: { 'data-mcp': { calls: 1 } } }), ['data-mcp']), []);
  assert.match(selfUseBlockers(s({ services: { 'data-mcp': { calls: 1 }, other: { calls: 1 } } }), ['data-mcp']).join(), /other/);
  assert.match(selfUseBlockers(s({ env: 'mac/台账' }), ['data-mcp']).join(), /env/);
});

test('self-use: a new version of a global app is reviewed', async () => {
  const env = await makeEnv({ selfUse: { services: [] } });
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '全局', params: [], script: script('print(1)') }, env.bob);
    env.amber.store.setGlobal(id, true);
    const r = await tried(env, '全局');
    assert.equal(button(env.fake.cardOf(r.claimMessageId), 'claim_self'), undefined);
    assert.match(JSON.stringify(await env.click(env.bob, r.claimMessageId, { a: 'claim_self', c: r.id })), /需要审核/);
  } finally { await env.close(); }
});

test('self-use: a new version of a self-use app may be self-use too; a reviewed one clears the mark', async () => {
  const env = await makeEnv({ selfUse: { services: [] }, approval: undefined });
  try {
    const r1 = await tried(env, '迭代');
    await env.click(env.bob, r1.claimMessageId, { a: 'claim_self', c: r1.id });
    const r2 = await tried(env, '迭代');
    await env.click(env.bob, r2.claimMessageId, { a: 'claim_self', c: r2.id });
    assert.equal(env.amber.store.getCommand(r1.id)!.status, 'retired');
    assert.equal(env.amber.store.getCommand(r2.id)!.selfApproved, true);
    const r3 = await tried(env, '迭代');
    await env.click(env.bob, r3.claimMessageId, { a: 'claim_submit', c: r3.id });
    const rc = env.fake.lastTo((s: any) => s.to.unionId === env.alice.unionId && !!button(s.card, 'review_ok'))!;
    await env.click(env.alice, rc.id, button(rc.card, 'review_ok')!);
    const c3 = env.amber.store.getCommand(r3.id)!;
    assert.equal(c3.status, 'active');
    assert.equal(c3.selfApproved, false);
  } finally { await env.close(); }
});
