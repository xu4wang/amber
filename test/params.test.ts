// Parameter forms show the default only as a hint (typing into a prefilled "6" gave "66"), and a refused value
// is quoted back so the person sees what Amber received.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateArgs } from '../src/engine.ts';
import { formCard } from '../src/cards.ts';
import { claimCard } from '../src/flow.ts';

const params = [
  { name: 'month', label: '月份', type: 'string', default: '', maxLength: 7, pattern: '^([0-9]{4}-[0-9]{2})?$' },
  { name: 'months', label: '走势月数', type: 'integer', default: '6', min: 1, max: 12 },
] as any[];
const inputs = (card: any): any[] => JSON.parse(JSON.stringify(card), (_k, v) => v).body.elements.flatMap(function walk(e: any): any[] { return [e, ...(e.elements ?? []).flatMap(walk), ...(e.columns ?? []).flatMap((c: any) => (c.elements ?? []).flatMap(walk))]; }).filter((e: any) => e.tag === 'input');

test('params: numbers compare as numbers; a refused value is quoted back', async () => {
  for (const v of ['1', '6', '12', '06']) assert.equal((await validateArgs(params, { months: v })).months, v);
  assert.equal((await validateArgs(params, {})).months, '6', 'empty: the default');
  await assert.rejects(validateArgs(params, { months: '66' }), /不能大于 12（收到的是「66」）/);
  await assert.rejects(validateArgs(params, { months: '0' }), /不能小于 1（收到的是「0」）/);
  await assert.rejects(validateArgs(params, { months: '6.0' }), /必须是整数（收到的是「6\.0」）/);
  await assert.rejects(validateArgs(params, { month: '2026-1' }), /格式不对（收到的是「2026-1」）/);
  await assert.rejects(validateArgs(params, { month: '2026-10-01' }), /太长（最多 7 个字，收到 10 个）/);
  await assert.rejects(validateArgs(params, { months: '9'.repeat(60) }), /收到的是「9{40}…」/, 'long values are cut');
});

test('params: forms show the default as a hint, never in the box', () => {
  const cmd = { id: 'c1', name: '走势', description: '', params, script: { kind: 'script', lang: 'python', code: 'print(1)' }, options: {}, scopeType: 'group', chatId: 'oc_x' } as any;
  for (const card of [formCard(cmd), claimCard(cmd)]) {
    const months = inputs(card).find(i => i.name === 'months');
    assert.ok(months, 'has the input');
    assert.equal(months.default_value, undefined, 'not prefilled');
    assert.match(months.placeholder.content, /默认：6/);
  }
  // A value the person already typed (e.g. from a one-line shortcut) is still kept.
  assert.equal(inputs(formCard(cmd, { months: '3' })).find(i => i.name === 'months').default_value, '3');
});
