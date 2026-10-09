// #3: configuration items. Declared with the code (`"scope": "config"`), set once on the website by the
// command's creator or an admin, given to every run; callers cannot override them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, urlButton, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const PRINT = script('import json,sys\np=json.load(sys.stdin)["params"]\nprint("params=" + json.dumps(p, sort_keys=True, ensure_ascii=False))');
const PARAMS = [
  { name: 'who', label: '对象', type: 'string' },
  { name: 'repo', label: '仓库', type: 'string', required: true, scope: 'config' },
  { name: 'days', label: '天数', type: 'integer', min: 1, max: 30, required: true, default: '1', scope: 'config' },
];

async function login(env: any, u: any): Promise<string> {
  await env.dm(u, '登录');
  const r = await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' });
  return r.headers.get('set-cookie')!.split(';')[0];
}

test('config: refused shapes at submit', async () => {
  const env = await makeEnv();
  try {
    const bad = await env.submit({ chatId: GROUP, chatType: 'group', name: '坏', params: [{ name: 'x', type: 'string', scope: 'install' }], script: PRINT });
    assert.equal(bad.error, 'bad_params');
    const city = await env.submit({ chatId: GROUP, chatType: 'group', name: '坏2', params: [{ name: 'x', type: 'string', scope: 'config', defaultFrom: 'caller.city' }], script: PRINT });
    assert.equal(city.error, 'bad_params');
  } finally { await env.close(); }
});

test('config: trial from the form, set on the website by the creator, every run gets it, callers cannot override', async () => {
  const env = await makeEnv();
  const { fake, alice, bob, carol } = env;
  const base = `http://127.0.0.1:${env.webPort}`;
  const post = (cookie: string, path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { cookie, origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(async x => ({ status: x.status, body: await x.json() }));
  const scope = 'group:' + GROUP;
  try {
    // Claim card: the configuration items are listed and the trial form asks for them.
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '检查', params: PARAMS, script: PRINT, options: { schedulable: true } });
    const claim = FakeFeishu.text(fake.cardOf(r.claimMessageId));
    assert.match(claim, /配置项\*\*：仓库/);
    assert.match(claim, /仓库（配置项）/);
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id }, { who: '小明' });
    await env.waitFor(() => /试运行需要填写配置项：仓库/.test(FakeFeishu.text(fake.cardOf(r.claimMessageId))) || undefined);
    await env.click(alice, r.claimMessageId, { a: 'claim_try', c: r.id }, { who: '小明', repo: 'trial/repo' });
    const tried = await env.waitFor(() => button(fake.cardOf(r.claimMessageId), 'claim_submit') && FakeFeishu.text(fake.cardOf(r.claimMessageId)));
    assert.match(tried, /"days\\": \\"1\\", \\"repo\\": \\"trial\/repo\\", \\"who\\": \\"小明/, 'trial: form value, default for the unset optional item');
    await env.click(alice, r.claimMessageId, { a: 'claim_submit', c: r.id });
    assert.match([...fake.docs.values()].pop()!.join('\n'), /\| repo（配置项） \| 仓库 \|/, 'the review doc marks configuration items');
    await env.approveLatest();
    const id = r.id;
    assert.equal(env.amber.store.getCommand(id)!.status, 'active');
    // Trial values are not kept.
    assert.deepEqual(env.amber.store.configRows(GROUP, '检查'), []);

    // Not set yet: runs and schedules are refused with a pointer to the website.
    await env.say(bob, GROUP, '检查 小红');
    await env.waitFor(() => fake.sent.some(s => new RegExp(`还没设置配置项：仓库。请指令创建人或管理员在网站（${base}）`).test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    const ctx = { chatId: GROUP, chatType: 'group', label: 'TestBot', user: bob.email };
    assert.match((await env.api('POST', '/v1/schedules', { ...ctx, command: '检查', at: '每天 09:00' })).body.message, /还没设置配置项：仓库/);
    const bobCookie = await login(env, bob), aliceCookie = await login(env, alice);
    assert.match((await post(bobCookie, '/web/api/schedules', { scope, commandId: id, at: '每天 09:00', args: {} })).body.message, /还没设置配置项：仓库/);
    const shown = (await env.api('POST', '/v1/commands/show', { ...ctx, command: '检查' })).body.command;
    assert.deepEqual(shown.params.map((p: any) => p.name), ['who'], 'agents pass run parameters only');
    assert.deepEqual(shown.config.map((p: any) => [p.name, p.value]), [['repo', null], ['days', null]]);
    assert.deepEqual(shown.configMissing, ['仓库']);
    // The form card asks for run parameters only.
    const form = JSON.stringify(await env.click(bob, r.claimMessageId, { a: 'pick', c: id }));
    assert.match(form, /"name":"who"/);
    assert.doesNotMatch(form, /"name":"repo"|"name":"days"/);

    // Website: everyone sees the items; only the creator or an admin sets them. Bob is not an admin.
    assert.equal((await post(bobCookie, `/web/api/commands/${id}/config`, { scope, name: 'repo', value: 'bob/repo' })).status, 403);
    assert.equal((await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'nope', value: 'x' })).status, 400, 'only declared items');
    assert.equal((await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'who', value: 'x' })).status, 400, 'run parameters are not configuration');
    assert.match((await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'days', value: '99' })).body.message, /不能大于 30/);
    assert.equal((await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'repo', value: ' team/app ' })).body.ok, true);
    const ov = await (await fetch(`${base}/web/api/overview`, { headers: { cookie: bobCookie } })).json();
    const view = ov.groups[0].commands.find((c: any) => c.name === '检查');
    assert.deepEqual(view.params.map((p: any) => p.name), ['who']);
    assert.deepEqual(view.config.map((p: any) => [p.name, p.value, p.default]), [['repo', 'team/app', null], ['days', null, '1']]);

    // Runs get the stored value (and the default for an unset optional item); a caller's value is ignored.
    const run = await post(bobCookie, '/web/api/run', { scope, commandId: id, args: { who: '小红', repo: 'evil/repo', days: '7' } });
    assert.equal(run.body.markdown, 'params={"days": "1", "repo": "team/app", "who": "小红"}');
    await env.say(bob, GROUP, '检查 小红 evil/repo');
    await env.waitFor(() => fake.sent.some(s => /"repo\\": \\"team\/app/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);
    assert.ok(!fake.sent.some(s => /evil/.test(FakeFeishu.text(fake.cardOf(s.id)))));
    // A one-line shortcut without arguments runs right away: a required configuration item is not a missing argument.
    await env.say(bob, GROUP, '检查');
    await env.waitFor(() => fake.sent.some(s => /params=\{\\"days\\": \\"1\\", \\"repo\\": \\"team\/app\\"\}/.test(FakeFeishu.text(fake.cardOf(s.id)))) || undefined);

    // A schedule reads the value at each run, so a change on the website applies from the next run.
    const req = await env.api('POST', '/v1/schedules', { ...ctx, command: '检查', at: '每 5 分钟', args: { who: '定时', repo: 'evil/repo' } });
    const card = fake.sent.at(-1)!;
    await env.click(bob, card.id, button(card.card, 'req_ok')!);
    const sid = (await env.api('GET', `/v1/requests/${req.body.requestId}`)).body.scheduleId as string;
    await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'days', value: '3' });
    const before = fake.sent.length;
    await env.amber.bot.scheduler.tick(env.amber.store.getSchedule(sid)!.nextRunAt + 1000);
    const posted = await env.waitFor(() => fake.sent.slice(before).find(s => s.to.chatId === GROUP));
    assert.match(FakeFeishu.text(posted.card), /"days\\": \\"3\\", \\"repo\\": \\"team\/app\\", \\"who\\": \\"定时/);

    // Clearing a required item stops runs again.
    assert.equal((await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'repo', delete: true })).body.ok, true);
    assert.match((await post(bobCookie, '/web/api/run', { scope, commandId: id, args: {} })).body.message, /还没设置配置项：仓库/);
    await post(aliceCookie, `/web/api/commands/${id}/config`, { scope, name: 'repo', value: 'team/app' });

    // A new version keeps the values (same chat + name); retiring drops them.
    const v2 = await activate(env, { chatId: GROUP, chatType: 'group', name: '检查', params: PARAMS, script: { ...PRINT, code: PRINT.code + '\nprint("v2")' } }, alice, { repo: 'trial/repo' });
    assert.equal(env.amber.store.getCommand(v2)!.status, 'active');
    assert.deepEqual(env.amber.store.configRows(GROUP, '检查').map(r => [r.name, r.value]), [['days', '3'], ['repo', 'team/app']]);
    await env.say(alice, GROUP, '下线 检查');
    const confirmCard = fake.sent.at(-1)!;
    await env.click(alice, confirmCard.id, button(confirmCard.card, 'retire_ok')!);
    assert.equal(env.amber.store.getCommand(v2)!.status, 'retired');
    assert.deepEqual(env.amber.store.configRows(GROUP, '检查'), []);
    void carol;
  } finally { await env.close(); }
});
