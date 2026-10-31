// reviewPolicy: every reviewer must approve (default), or any one of them. A rejection always rejects.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, script, button, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const REVIEWERS = ['alice@example.com', 'carol@example.com'];

async function submit(env: any, name: string) {
  const r = await env.submit({ chatId: GROUP, chatType: 'group', name, params: [], script: script('print(1)') });
  await env.click(env.bob, r.claimMessageId, { a: 'claim_try', c: r.id });
  await env.waitFor(() => button(env.fake.cardOf(r.claimMessageId), 'claim_submit'));
  const after = await env.click(env.bob, r.claimMessageId, { a: 'claim_submit', c: r.id });
  return { ...r, after: JSON.stringify(after) };
}

for (const policy of ['any', 'all'] as const) {
  test(`review policy ${policy}: Feishu approval with one reviewer approved`, async () => {
    const env = await makeEnv({ reviewers: REVIEWERS, reviewPolicy: policy });
    try {
      const r = await submit(env, '规则');
      assert.match(r.after, policy === 'any' ? /任意 1 位审核人（共 2 位）同意/ : /全部 2 位审核人同意/);
      // The approval definition says approved after alice alone (an "any one" node): Amber checks for itself.
      const code = [...env.fake.approvals.keys()].pop()!;
      const a = env.fake.approvals.get(code)!;
      a.tasks.find(t => t.open_id === 'ou_alice')!.status = 'APPROVED';
      a.status = 'APPROVED';
      await env.amber.bot.onApprovalEvent(code);
      assert.equal(env.amber.store.getCommand(r.id)!.status, policy === 'any' ? 'active' : 'pending');
    } finally { await env.close(); }
  });

  test(`review policy ${policy}: review cards`, async () => {
    const env = await makeEnv({ reviewers: REVIEWERS, reviewPolicy: policy, approval: undefined });
    try {
      const r = await submit(env, '卡片规则');
      const cardTo = (u: any) => env.fake.lastTo((s: any) => s.to.unionId === u.unionId && !!button(s.card, 'review_ok'))!;
      assert.match(FakeFeishu.text(cardTo(env.alice).card), policy === 'any' ? /任意 1 位审核人（共 2 位）/ : /全部 2 位审核人/);
      await env.click(env.alice, cardTo(env.alice).id, button(cardTo(env.alice).card, 'review_ok')!);
      assert.equal(env.amber.store.getCommand(r.id)!.status, policy === 'any' ? 'active' : 'pending');
      if (policy === 'all') {
        await env.click(env.carol, cardTo(env.carol).id, button(cardTo(env.carol).card, 'review_ok')!);
        assert.equal(env.amber.store.getCommand(r.id)!.status, 'active');
      }
    } finally { await env.close(); }
  });
}

test('review policy any: one rejection still rejects', async () => {
  const env = await makeEnv({ reviewers: REVIEWERS, reviewPolicy: 'any', approval: undefined });
  try {
    const r = await submit(env, '驳回');
    const c = env.fake.lastTo((s: any) => s.to.unionId === env.carol.unionId && !!button(s.card, 'review_no'))!;
    await env.click(env.carol, c.id, button(c.card, 'review_no')!, { reason: '不行' });
    assert.equal(env.amber.store.getCommand(r.id)!.status, 'rejected');
  } finally { await env.close(); }
});

test('review policy any: a Store listing goes through with one reviewer\'s approval', async () => {
  const env = await makeEnv({ reviewers: REVIEWERS, reviewPolicy: 'any' });
  try {
    await env.amber.bot.flow.loadReviewers();
    const { activate } = await import('./env.ts');
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '上架规则', params: [], script: script('print(1)') }, env.bob);
    await env.amber.bot.apps.requestListing(id, { unionId: env.bob.unionId, openId: env.bob.openId });
    const code = [...env.fake.approvals.entries()].find(([, a]) => /上架：上架规则/.test(a.title ?? ''))![0];
    const a = env.fake.approvals.get(code)!;
    a.tasks[0].status = 'APPROVED'; a.status = 'APPROVED';
    await env.amber.bot.pollApprovals();
    assert.equal(env.amber.store.listApps().length, 1);
  } finally { await env.close(); }
});
