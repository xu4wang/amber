// Pure functions: time rules, diffs, card rendering of untrusted output.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRule, nextRun, describeRule, validateRule } from '../src/schedule-rule.ts';
import { lineDiff } from '../src/diff.ts';
import { sanitizeMarkdown, markdownWithCharts } from '../src/cards.ts';

const at = (s: string) => Date.parse(s);

test('time rules: next run for each form, in the rule\'s time zone', () => {
  const now = at('2026-10-07T10:30:00Z'); // Wednesday 18:30 in Shanghai
  const cases: [string, string, string][] = [
    ['每天 9:00', 'Asia/Shanghai', '2026-10-08T01:00:00.000Z'],
    ['工作日 09:00', 'Asia/Bangkok', '2026-10-08T02:00:00.000Z'],
    ['每周日 08:00', 'Asia/Shanghai', '2026-10-11T00:00:00.000Z'],
    ['每 6 小时 15 分', 'Asia/Shanghai', '2026-10-07T16:15:00.000Z'],
    ['每 15 分钟', 'Asia/Shanghai', '2026-10-07T10:45:00.000Z'],
    ['weekly fri 7:05', 'America/New_York', '2026-10-09T11:05:00.000Z'],
  ];
  for (const [text, tz, want] of cases) {
    const r = parseRule(text, tz);
    assert.deepEqual(validateRule(r), r);
    assert.equal(new Date(nextRun(r, now)).toISOString(), want, text);
  }
  // Weekdays skip the weekend.
  const fri = at('2026-10-09T03:00:00Z');
  assert.equal(new Date(nextRun(parseRule('工作日 09:00', 'Asia/Shanghai'), fri)).toISOString(), '2026-10-12T01:00:00.000Z');
  for (const bad of ['每 5 小时', '每天 25:00', '每 3 分钟', '明天']) assert.throws(() => parseRule(bad), bad);
  assert.match(describeRule(parseRule('每 2 小时', 'Asia/Shanghai')), /每 2 小时/);
});

test('diff: changed lines with context, and "no change"', () => {
  const a = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
  const d = lineDiff(a, a.replace('line 3', 'line three'))!;
  assert.deepEqual(d.stat, { added: 1, removed: 1 });
  assert.match(d.text, /- line 3\n\+ line three/);
  assert.doesNotMatch(d.text, /line 12/);
  assert.equal(lineDiff(a, a)!.text, '');
});

test('script output cannot inject mentions, links or tags into cards', () => {
  const s = sanitizeMarkdown('<at id=all></at> @所有人 [点我](http://evil.example)');
  assert.doesNotMatch(s, /<at|@所有人|\]\(/);
  const els = markdownWithCharts('a\n```table\n{"columns":[{"name":"x","label":"X","type":"number"}],"rows":[{"x":1}],"total":5}\n```\n```vega-lite\n{"mark":"bar","data":{"values":[{"k":"a","v":1}]},"encoding":{"x":{"field":"k"},"y":{"field":"v"}}}\n```');
  const json = JSON.stringify(els);
  assert.match(json, /"tag":"table"/);
  assert.match(json, /共 5 行/);
  assert.match(json, /"tag":"chart"/);
});

test('scripts: privileged is disabled; services declare 1–20 calls (D40/D41)', async () => {
  const { validateScript, setServices } = await import('../src/runner.ts');
  setServices({ demo: { audience: 'demo', tcpPort: 9 } });
  const base = { kind: 'script', lang: 'python', code: 'print(1)' };
  assert.throws(() => validateScript({ ...base, kind: 'privileged' }), /已停用/);
  for (const calls of [1, 20]) assert.deepEqual(validateScript({ ...base, services: { demo: { calls } } }).services, { demo: { calls } });
  for (const calls of [0, 21, 1.5, '2', undefined, null]) assert.throws(() => validateScript({ ...base, services: { demo: { calls } } }), /calls/, String(calls));
  assert.throws(() => validateScript({ ...base, services: ['demo'] }), /services 要写成/);
  assert.throws(() => validateScript({ ...base, services: { nope: { calls: 1 } } }), /未知的服务/);
  // calls is part of the reviewed definition: changing it changes the spec hash.
  const { computeSpecHash } = await import('../src/db.ts');
  const def = (calls: number) => ({ name: 'x', params: [], options: { confirm: false, schedulable: false }, script: validateScript({ ...base, services: { demo: { calls } } }) });
  assert.notEqual(computeSpecHash(def(1) as any), computeSpecHash(def(2) as any));
  setServices({});
});

test('run: stored definitions are re-validated before any run or token; startup lists them (D40/D41)', async () => {
  const { runCommand } = await import('../src/engine.ts');
  const { computeSpecHash, Store } = await import('../src/db.ts');
  const { setServices, validateScript } = await import('../src/runner.ts');
  setServices({ demo: { audience: 'demo', tcpPort: 9 } });
  const caller = { unionId: 'on_x', chatId: 'oc_x', chatType: 'group' as const, channel: 'bot' as const };
  const store = { startRun() { throw new Error('must not start a run'); }, audit() {} } as any;
  const signer = { issue() { throw new Error('must not issue a token'); } } as any;
  const base = { kind: 'script', lang: 'python', code: 'print(1)' };
  const bad: Record<string, unknown>[] = [
    { ...base, kind: 'privileged' },
    { ...base, services: ['demo'] },
    { ...base, services: { demo: { calls: 21 } } },
    { ...base, services: { demo: { calls: 0 } } },
    { ...base, services: { demo: { calls: 1.5 } } },
    { ...base, services: { demo: { calls: '2' } } },
    { ...base, services: { nope: { calls: 1 } } },
    { ...base, services: { demo: { calls: 1 } }, network: true },
    { ...base, services: { demo: null } },
    { ...base, services: 'demo' },
    { ...base, lang: 'bash' },
  ];
  for (const script of bad) {
    const c: any = { id: 'c1', name: 'x', params: [], options: { confirm: false, schedulable: true }, script, status: 'active' };
    c.specHash = computeSpecHash(c);
    for (const opts of [{}, { trial: true }, { viaForm: true }]) {
      await assert.rejects(runCommand(store, c, {}, caller, { signer }, opts), (e: any) => e.code === 'invalid_script', JSON.stringify([script, opts]));
    }
  }
  // Startup scan uses the same validation.
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'amber-unit-'));
  try {
    const real = new Store(dir);
    const ins = (name: string, script: any, status = 'active') => real.insertCommand({ scopeType: 'group', chatId: 'oc_x', ownerUnionId: 'on_x', name, description: '', params: [], script, options: { confirm: false, schedulable: false }, status } as any);
    ins('ok', { ...base, services: { demo: { calls: 3 } } });
    ins('too-many', { ...base, services: { demo: { calls: 21 } } });
    ins('net', { ...base, services: { demo: { calls: 1 } }, network: true }, 'draft');
    ins('old-but-retired', { ...base, kind: 'privileged' }, 'retired');
    const found = real.listInvalidScripts(validateScript).map(x => [x.name, x.reason]).sort();
    assert.deepEqual(found, [['net', 'invalid_script'], ['too-many', 'invalid_script']]);
  } finally { rmSync(dir, { recursive: true, force: true }); setServices({}); }
});
