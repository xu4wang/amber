// The audit log on the website (admins only): newest first, by category or text, 50 at a time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/db.ts';
import { makeEnv, urlButton } from './env.ts';

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
