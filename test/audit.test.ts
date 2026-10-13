// The audit log on the website (admins only): newest first, by category or text, 50 at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { makeEnv, urlButton, activate, script, GROUP } from './env.ts';

test('audit: listing filters by prefix, text and person; pages by id; wildcards in the query are literal', () => {
  const st = new Store(mkdtempSync(join(tmpdir(), 'amber-audit-')));
  for (let i = 0; i < 120; i++) st.audit(i % 2 ? 'on_a' : 'on_b', i % 3 ? 'run.ok' : 'schedule.create', { n: i, name: i === 7 ? '100%_报表' : 'x' });
  const first = st.listAudit({ limit: 50 });
  assert.equal(first.length, 50);
  assert.equal(JSON.parse(first[0].detail).n, 119, 'newest first');
  const next = st.listAudit({ limit: 50, before: first.at(-1)!.id });
  assert.equal(JSON.parse(next[0].detail).n, 69, 'continues below the last one');
  assert.ok(st.listAudit({ prefixes: ['schedule.'], limit: 200 }).every(r => r.action === 'schedule.create'));
  assert.equal(st.listAudit({ prefixes: ['schedule.'], limit: 200 }).length, 40);
  assert.deepEqual(st.listAudit({ q: '100%_', limit: 200 }).map(r => JSON.parse(r.detail).n), [7]);
  assert.equal(st.listAudit({ q: '%', limit: 200 }).length, 1, '% is a character, not a wildcard');
  assert.ok(st.listAudit({ actor: 'on_a', limit: 200 }).every(r => r.actor === 'on_a'));
  assert.equal(st.listAudit({ prefixes: ['run_'], limit: 200 }).length, 0, '_ in a prefix is literal');
});

test('audit: the website shows it to admins only, with names and categories', async () => {
  const env = await makeEnv();
  const base = `http://127.0.0.1:${env.webPort}`;
  const login = async (u: any) => { await env.dm(u, '登录'); return (await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0]; };
  try {
    const a = await login(env.alice), b = await login(env.bob);
    env.amber.store.audit(env.bob.unionId, 'schedule.create', { scheduleId: 's1', name: '日报' });
    env.amber.store.audit(null, 'startup.seed', { setting: 'x' });
    assert.equal((await fetch(base + '/web/api/audit', { headers: { cookie: b } })).status, 404, 'not for others');
    const all = await (await fetch(base + '/web/api/audit', { headers: { cookie: a } })).json();
    assert.equal(all.ok, true);
    assert.equal(all.rows[0].action, 'startup.seed');
    assert.equal(all.rows[0].actorName, null, 'no person: the system');
    assert.ok(all.categories.some((c: any) => c.key === 'schedule'));
    const sch = await (await fetch(base + '/web/api/audit?cat=schedule', { headers: { cookie: a } })).json();
    assert.deepEqual(sch.rows.map((r: any) => r.action), ['schedule.create']);
    assert.equal(sch.rows[0].actorName, 'bob', 'the person\'s name');
    const q = await (await fetch(base + '/web/api/audit?q=' + encodeURIComponent('日报'), { headers: { cookie: a } })).json();
    assert.equal(q.rows.length, 1);
    const logins = await (await fetch(base + '/web/api/audit?cat=login', { headers: { cookie: a } })).json();
    assert.ok(logins.rows.length >= 2 && logins.rows.every((r: any) => r.action.startsWith('web.login') || r.action.startsWith('web.logout')));
  } finally { await env.close(); }
});

test('audit: a run records which group or private chat the app belongs to, shown with names', async () => {
  const env = await makeEnv();
  const base = `http://127.0.0.1:${env.webPort}`;
  try {
    await env.dm(env.alice, '登录');
    const a = (await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    await activate(env, { chatId: GROUP, chatType: 'group', name: '群里的', params: [], script: script('print("g")') }, env.bob);
    const dm = 'oc_dmbob';
    env.fake.chats.set(dm, { mode: 'p2p', name: '', members: new Set(['BOT', env.bob.unionId]) });
    await activate(env, { chatId: dm, chatType: 'p2p', claimer: env.bob.email, name: '私聊的', params: [], script: script('print("p")') }, env.bob);
    await env.say(env.bob, GROUP, '群里的');
    await env.dm(env.bob, '私聊的');
    const starts = async () => (await (await fetch(base + '/web/api/audit?cat=run', { headers: { cookie: a } })).json()).rows.filter((r: any) => r.action === 'run.start');
    let rows: any[] = [];
    for (let i = 0; i < 40 && rows.length < 2; i++) { rows = await starts(); if (rows.length < 2) await new Promise(ok => setTimeout(ok, 250)); }
    const byName = Object.fromEntries(rows.map((r: any) => [JSON.parse(r.detail).name, r]));
    const g = JSON.parse(byName['群里的'].detail), p = JSON.parse(byName['私聊的'].detail);
    assert.deepEqual([g.appScope, g.appChatId, g.appOwner], ['group', GROUP, undefined]);
    assert.equal(byName['群里的'].refs[GROUP], env.fake.chats.get(GROUP)!.name, 'the group\'s name');
    assert.deepEqual([p.appScope, p.appChatId, p.appOwner], ['p2p', dm, env.bob.unionId]);
    assert.equal(byName['私聊的'].refs[dm], '私聊（创建人 bob）');
    assert.equal(byName['私聊的'].refs[env.bob.unionId], 'bob');
    // Every row of a run says which app and where it belongs, not only the start record.
    const gRun = g.runId, pRun = p.runId;
    const all = (await (await fetch(base + '/web/api/audit', { headers: { cookie: a } })).json()).rows;
    const ofRun = (id: string) => all.filter((r: any) => r.detail.includes(id));
    const groupWhere = `群 ${env.fake.chats.get(GROUP)!.name}`;
    assert.ok(ofRun(gRun).some((r: any) => r.action === 'run.ok'));
    for (const r of ofRun(gRun)) assert.deepEqual(r.app, { name: '群里的', where: groupWhere }, r.action);
    for (const r of ofRun(pRun)) assert.deepEqual(r.app, { name: '私聊的', where: '私聊（创建人 bob）' }, r.action);
    // An older relay record has only a jobId: found through its dispatch record. A record about an app has its commandId.
    env.amber.store.audit(null, 'executor.dispatch', { runId: gRun, jobId: 'job-old' });
    env.amber.store.audit(null, 'executor.relay', { jobId: 'job-old', service: 'demo' });
    env.amber.store.audit(env.bob.unionId, 'schedule.create', { commandId: g.commandId, name: '群里的' });
    env.amber.store.audit(null, 'executor.relay', { jobId: 'job-unknown', service: 'demo' });
    const top = (await (await fetch(base + '/web/api/audit', { headers: { cookie: a } })).json()).rows;
    assert.deepEqual(top.slice(0, 4).map((r: any) => r.app?.name ?? null), [null, '群里的', '群里的', '群里的'], 'unknown job: no app');
  } finally { await env.close(); }
});

test('audit: filter by the group an app belongs to, private-chat apps, and scheduled or one-off runs', async () => {
  const env = await makeEnv();
  const base = `http://127.0.0.1:${env.webPort}`;
  try {
    await env.dm(env.alice, '登录');
    const a = (await fetch(urlButton(env.fake.sent.at(-1)!.card)!, { redirect: 'manual' })).headers.get('set-cookie')!.split(';')[0];
    const gid = await activate(env, { chatId: GROUP, chatType: 'group', name: '群里的', params: [], script: script('print("g")') }, env.bob);
    const dm = 'oc_dmbob';
    env.fake.chats.set(dm, { mode: 'p2p', name: '', members: new Set(['BOT', env.bob.unionId]) });
    const pid = await activate(env, { chatId: dm, chatType: 'p2p', claimer: env.bob.email, name: '私聊的', params: [], script: script('print("p")') }, env.bob);
    await env.say(env.bob, GROUP, '群里的');
    await env.dm(env.bob, '私聊的');
    const st = env.amber.store;
    const runOf = (name: string) => st.listAudit({ prefixes: ['run.start'], limit: 50 }).map(r => JSON.parse(r.detail)).find(d => d.name === name)?.runId as string | undefined;
    for (let i = 0; i < 40 && !(runOf('群里的') && runOf('私聊的')); i++) await new Promise(ok => setTimeout(ok, 250));
    const gRun = runOf('群里的')!, pRun = runOf('私聊的')!;
    // Every run of an app so far (the trial run at activation counts: it is a one-off run of that app).
    const runsOf = (cid: string) => st.listAudit({ prefixes: ['run.start'], limit: 50 }).map(r => JSON.parse(r.detail)).filter(d => d.commandId === cid).map(d => d.runId as string);
    const gOnce = runsOf(gid), pOnce = runsOf(pid);
    assert.ok(gOnce.includes(gRun) && pOnce.includes(pRun));
    // A scheduled run of the group app (the scheduler marks its runs like this).
    const sRun = st.startRun({ commandId: gid, specHash: st.getCommand(gid)!.specHash, channel: 'schedule', callerUnionId: env.bob.unionId, chatId: GROUP, args: {} });
    st.audit(env.bob.unionId, 'run.start', { runId: sRun, commandId: gid, name: '群里的', channel: 'schedule' });
    st.audit(null, 'executor.relay', { jobId: 'j1', runId: sRun, service: 'demo' });
    st.audit(env.bob.unionId, 'schedule.create', { commandId: gid, name: '群里的' });
    // A row whose command field is not an app id still belongs to its run's app.
    st.audit(null, 'agent.run', { runId: sRun, command: 'not-an-app-id' });
    st.audit(null, 'startup.seed', { setting: 'x' });
    const get = async (qs: string) => (await (await fetch(`${base}/web/api/audit?${qs}`, { headers: { cookie: a } })).json());
    const runsIn = (rows: any[]) => new Set(rows.map((r: any) => { const d = JSON.parse(r.detail); return d.runId ?? (d.commandId ? 'cmd:' + d.commandId : r.action); }));
    const first = await get('');
    assert.deepEqual(first.chats, [{ id: GROUP, name: env.fake.chats.get(GROUP)!.name }], 'groups with apps, by name');
    // By group: every row of the group app's runs, and rows about the app; nothing of the private one or unrelated.
    const g = await get('chat=' + GROUP);
    assert.deepEqual([...runsIn(g.rows)].sort(), [...gOnce, sRun, 'cmd:' + gid].sort());
    assert.ok(g.rows.some((r: any) => r.action === 'executor.relay') && g.rows.some((r: any) => r.action === 'run.ok'));
    assert.deepEqual([...runsIn((await get('chat=p2p')).rows)].sort(), [...pOnce].sort());
    assert.equal((await get('chat=oc_nope')).rows.length, 0);
    // By trigger: scheduled runs only / one-off runs only; rows not part of a run are in neither.
    assert.deepEqual([...runsIn((await get('trigger=schedule')).rows)], [sRun]);
    assert.deepEqual([...runsIn((await get('trigger=once')).rows)].sort(), [...gOnce, ...pOnce].sort());
    // Combined with each other and with the category filter.
    assert.deepEqual([...runsIn((await get(`chat=${GROUP}&trigger=once`)).rows)].sort(), [...gOnce].sort());
    assert.deepEqual((await get(`chat=${GROUP}&trigger=schedule&cat=run`)).rows.map((r: any) => r.action), ['agent.run', 'run.start']);
    assert.equal(g.rows.find((r: any) => r.action === 'agent.run')?.app?.name, '群里的', 'shown with its run\'s app too');
    assert.ok((await get('trigger=bogus')).rows.some((r: any) => r.action === 'startup.seed'), 'an unknown value filters nothing');
    // Paging works within a filter.
    const all = st.listAudit({ chat: GROUP, limit: 200 }).map(r => r.id);
    const p1 = st.listAudit({ chat: GROUP, limit: 2 }), p2 = st.listAudit({ chat: GROUP, limit: 200, before: p1[1].id });
    assert.deepEqual([...p1, ...p2].map(r => r.id), all);
  } finally { await env.close(); }
});
