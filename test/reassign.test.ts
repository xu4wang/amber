// #4 orphans: when a command's creator has left its group, an admin offers it to a member on the website;
// it changes hands only when that person accepts. Secrets and configuration stay; schedules are rebuilt as
// the new owner only if they choose so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { secretVault } from '../src/engine.ts';

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

const CODE = script('import json,sys\ni=json.load(sys.stdin)\nprint("repo=" + i["params"].get("repo","") + " token=" + str(len(i.get("secrets",{}).get("API_TOKEN",""))))', { secrets: ['API_TOKEN'] });
const PARAMS = [{ name: 'repo', label: '仓库', type: 'string', required: true, scope: 'config' }];

test('reassign: an admin offers an orphaned command; the member who accepts owns it, with its settings and (if they choose) its schedules', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;   // alice is an admin; bob creates and leaves; carol takes over
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const scope = 'group:' + GROUP;
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    secretVault()!.set({ chatId: GROUP, name: '检查' }, 'API_TOKEN', 'bob-token-123', bob.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '检查', params: PARAMS, script: CODE, options: { schedulable: true } }, bob, { repo: 'r' });
    env.amber.store.putConfig(GROUP, '检查', 'repo', 'team/app', bob.unionId);
    const mk = (time: string) => env.amber.bot.scheduler.create({ cmd: env.amber.store.getCommand(id)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group', channel: 'web' }, args: {}, rule: { kind: 'daily', time, tz: 'Asia/Shanghai' }, requestedBy: 'test', via: {} });
    const s1 = await mk('09:00'), s2 = await mk('18:00');
    const aliceCookie = await login(env, alice), carolCookie = await login(env, carol);
    const offer = (cookie: string, to: string) => post(cookie, `/web/api/commands/${id}/reassign`, { scope, to });

    // While bob is still in the group, nobody can take it from him.
    assert.match((await offer(aliceCookie, carol.unionId)).body.message, /创建人还在群里/);
    // bob leaves.
    fake.chats.get(GROUP)!.members.delete(bob.unionId);
    (env.amber.bot as any).memberCache.clear();
    const ov = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: aliceCookie } })).json();
    assert.equal(ov.groups[0].commands.find((c: any) => c.id === id).orphan, true, 'admins see it marked');
    // Only admins pick from the group's members, and only members can be chosen.
    assert.equal((await fetch(`${base}/web/api/groups/${GROUP}/members`, { headers: { cookie: carolCookie } })).status, 404);
    const members = (await (await fetch(`${base}/web/api/groups/${GROUP}/members`, { headers: { cookie: aliceCookie } })).json()).members;
    assert.deepEqual(members.map((x: any) => x.name).sort(), ['alice', 'carol']);
    assert.equal((await offer(carolCookie, carol.unionId)).status, 403, 'not an admin');
    await assert.rejects(env.amber.bot.requestReassign(id, carol.unionId, { unionId: carol.unionId }), /只有管理员/);
    // A schedule someone else once made on it (before #4) is not theirs to rebuild: it stays as it is.
    const stray = env.amber.store.insertSchedule({ commandId: id, specHash: env.amber.store.getCommand(id)!.specHash, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creatorUnionId: alice.unionId, creatorOpenId: alice.openId, args: {}, rule: { kind: 'daily', time: '12:00', tz: 'Asia/Shanghai' }, nextRunAt: Date.now() + 3600_000, requestedBy: 'test' });
    assert.match((await offer(aliceCookie, bob.unionId)).body.message, /原创建人|群的成员/);
    assert.match((await offer(aliceCookie, 'on_nobody')).body.message, /群的成员/);

    // Offered twice: only the newest card counts.
    const first = await offer(aliceCookie, carol.unionId);
    const firstCard = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'rs_ok'))!;
    const second = await offer(aliceCookie, carol.unionId);
    assert.notEqual(first.body.requestId, second.body.requestId);
    assert.match(JSON.stringify(await env.click(carol, firstCard.id, button(firstCard.card, 'rs_ok')!)), /已经处理过或被取消/);
    const card = fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'rs_ok'))!;
    const text = FakeFeishu.text(card.card);
    assert.match(text, /2 个定时任务/);
    assert.match(text, /1 个密钥、1 个配置项会保留/);
    // Only carol may answer it.
    assert.match(JSON.stringify(await env.click(alice, card.id, button(card.card, 'rs_ok')!)), /发给别人/);
    assert.equal(env.amber.store.getCommand(id)!.ownerUnionId, bob.unionId);

    // carol accepts and rebuilds the schedules as herself.
    const yes = button(card.card, 'rs_ok')!;
    assert.equal(yes.s, '1');
    const done = await env.click(carol, card.id, yes);
    assert.match(JSON.stringify(done), /你现在是「检查」的创建人/);
    assert.equal(env.amber.store.getCommand(id)!.ownerUnionId, carol.unionId);
    assert.equal(env.amber.store.getSchedule(s1.id)?.status ?? 'deleted', 'deleted');
    assert.equal(env.amber.store.getSchedule(s2.id)?.status ?? 'deleted', 'deleted');
    const now = env.amber.store.schedulesOfCommand(id).filter(s => s.id !== stray.id);
    assert.deepEqual(now.map(s => [s.creatorUnionId, (s.rule as any).time]).sort(), [[carol.unionId, '09:00'], [carol.unionId, '18:00']]);
    assert.equal(env.amber.store.getSchedule(stray.id)!.creatorUnionId, alice.unionId, 'not touched');
    assert.ok(fake.sent.some(s => s.to.unionId === alice.unionId && /已由新的负责人接收/.test(FakeFeishu.text(s.card))), 'the admin is told');
    assert.match(JSON.stringify(await env.click(carol, card.id, yes)), /已经处理过/);
    // Settings stayed; carol runs it now (with bob's secret and the stored configuration).
    await env.say(carol, GROUP, '检查');
    await env.waitFor(() => fake.sent.some(s => /repo=team\/app token=13/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    // Not an orphan any more.
    assert.match((await offer(aliceCookie, alice.unionId)).body.message, /创建人还在群里/);
    void second;
  } finally { await env.close(); }
});

test('reassign: declining leaves it as it was; accepting without schedules deletes them; old offers expire', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  try {
    fake.chats.get(GROUP)!.members.add(carol.unionId);
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '日报', params: [], script: script('print(1)'), options: { schedulable: true } }, bob);
    const s1 = await env.amber.bot.scheduler.create({ cmd: env.amber.store.getCommand(id)!, chatId: GROUP, chatType: 'group', replyTo: null, inThread: false,
      creator: { unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group', channel: 'web' }, args: {}, rule: { kind: 'daily', time: '09:00', tz: 'Asia/Shanghai' }, requestedBy: 'test', via: {} });
    fake.chats.get(GROUP)!.members.delete(bob.unionId);
    (env.amber.bot as any).memberCache.clear();
    const aliceCookie = await login(env, alice);
    const offer = async () => {
      const r = await post(aliceCookie, `/web/api/commands/${id}/reassign`, { scope: 'group:' + GROUP, to: carol.unionId });
      assert.equal(r.body.ok, true);
      return { req: r.body.requestId as string, card: fake.lastTo(s => s.to.unionId === carol.unionId && !!button(s.card, 'rs_no'))! };
    };
    let o = await offer();
    assert.match(JSON.stringify(await env.click(carol, o.card.id, button(o.card.card, 'rs_no')!)), /没有接收/);
    assert.match(JSON.stringify(await env.click(carol, o.card.id, button(o.card.card, 'rs_ok')!)), /已经处理过或被取消/);
    // The creator came back before it was accepted: nothing changes hands.
    o = await offer();
    fake.chats.get(GROUP)!.members.add(bob.unionId);
    (env.amber.bot as any).memberCache.clear();
    assert.match(JSON.stringify(await env.click(carol, o.card.id, button(o.card.card, 'rs_ok')!)), /原创建人已经回到群里/);
    fake.chats.get(GROUP)!.members.delete(bob.unionId);
    (env.amber.bot as any).memberCache.clear();
    assert.equal(env.amber.store.getCommand(id)!.ownerUnionId, bob.unionId);
    assert.equal(env.amber.store.getSchedule(s1.id)!.status, 'active');
    // Expired after 7 days.
    o = await offer();
    (env.amber.store as any).db.prepare('UPDATE requests SET created_at = ? WHERE id = ?').run(Date.now() - 8 * 24 * 3600_000, o.req);
    assert.match(JSON.stringify(await env.click(carol, o.card.id, button(o.card.card, 'rs_ok')!)), /超过 7 天/);
    assert.equal(env.amber.store.getCommand(id)!.ownerUnionId, bob.unionId);
    // Accept the command only: its schedules go.
    o = await offer();
    const only = o.card.card.body.elements.flatMap((e: any) => e.columns ?? []).map((c: any) => c.elements[0]).find((b: any) => b.behaviors?.[0]?.value?.s === '0').behaviors[0].value;
    await env.click(carol, o.card.id, only);
    assert.equal(env.amber.store.getCommand(id)!.ownerUnionId, carol.unionId);
    assert.equal(env.amber.store.schedulesOfCommand(id).length, 0);
  } finally { await env.close(); }
});
