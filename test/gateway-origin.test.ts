// Requests from outside the company network (through an amber-gateway) are marked as such on the cards people click.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, activate, button, script, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';
import { gatewayClient } from '../src/agent.ts';

const call = (env: any, machine: string, path: string, body: object) =>
  env.amber.handleApi({ method: 'POST', path, search: new URLSearchParams(), headers: { 'content-type': 'application/json' }, raw: JSON.stringify(body), machine, scoped: machine.startsWith('gw:') });

test('gateway: only a well-formed gateway machine name yields a client', () => {
  assert.equal(gatewayClient('gw:sgvps-gw:doubao'), 'doubao');
  assert.equal(gatewayClient('dev-prem'), undefined);
  assert.equal(gatewayClient('link:sgvps'), undefined);
  assert.equal(gatewayClient('gw:sgvps-gw:'), undefined);
});

test('gateway: a confirmation card says the request came from outside, whatever label the caller chose', async () => {
  const env = await makeEnv();
  try {
    await activate(env, { chatId: GROUP, chatType: 'group', name: '确认', params: [], script: script('print("ok")'), options: { confirm: true } }, env.bob);
    // The caller pretends to be an inside agent; the trusted client name still comes first.
    const r = await call(env, 'gw:sgvps-gw:doubao', '/v1/runs', { chatId: GROUP, chatType: 'group', user: env.bob.email, label: '数捞仔', command: '确认' });
    assert.equal(r.body.mode, 'confirm_card');
    const card = env.fake.sent.at(-1)!;
    const text = FakeFeishu.text(card.card);
    assert.match(text, /来自\*\*公司外网\*\*（网关接入方 doubao）/);
    assert.match(text, /外网·doubao｜数捞仔/);
    assert.ok(button(card.card, 'req_ok'));
    // The same request from a LAN machine carries no such line.
    await call(env, 'local', '/v1/runs', { chatId: GROUP, chatType: 'group', user: env.bob.email, label: '数捞仔', command: '确认' });
    const inside = FakeFeishu.text(env.fake.sent.at(-1)!.card);
    assert.doesNotMatch(inside, /公司外网|外网·/);
  } finally { await env.close(); }
});
