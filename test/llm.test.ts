// The built-in large-model service (llm): declared like any service, answered by Amber itself with its own
// credentials; the model CLI runs with no tools, no settings files, no saved session and a bare environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeEnv, activate, script, GROUP } from './env.ts';
import { runCommand } from '../src/engine.ts';

const FAKE = join(import.meta.dirname, 'fake-claude.py');
// Calls llm once per request in `asks` and prints each answer as JSON lines.
const caller = (code: string) => script([
  'import json,sys,urllib.request,urllib.error',
  'inp=json.load(sys.stdin); s=inp["services"]["llm"]; toks=list(s["tokens"])',
  'op=urllib.request.build_opener(urllib.request.ProxyHandler({}))',
  'def call(path, body, tok=None):',
  '  t = tok if tok is not None else (toks.pop(0) if toks else "none")',
  '  req=urllib.request.Request("http://127.0.0.1:%d%s" % (s["tcpPort"], path), data=json.dumps(body, ensure_ascii=False).encode(), headers={"Authorization":"Amber "+t,"Content-Type":"application/json"}, method="POST")',
  '  try:',
  '    r=op.open(req, timeout=60); return [r.status, json.load(r)]',
  '  except urllib.error.HTTPError as e:',
  '    return [e.code, json.load(e)]',
  code,
].join('\n'), { services: { llm: { calls: 5 } } });

test('llm: a declared service answered by Amber, text in and text out', async () => {
  const env = await makeEnv({ llm: { command: FAKE, models: ['sonnet', 'haiku'], maxConcurrent: 1, timeoutMs: 3000 } });
  const { bob } = env;
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '总结', params: [], script: caller([
      'print(json.dumps(call("/complete", {"prompt": "群里说了很多话", "system": "写成三句话"})))',
      'print(json.dumps(call("/complete", {"prompt": "x", "model": "gpt"})))',
      'print(json.dumps(call("/other", {"prompt": "x"})))',
      'print(json.dumps(call("/complete", {"prompt": "keep this one", "persist": True})))',
      'print(json.dumps(call("/complete", {"prompt": "x", "persist": "yes"})))',
      'print(json.dumps(call("/complete", {"prompt": "one more"})))',
    ].join('\n')) }, bob);
    const r = await runCommand(env.amber.store, env.amber.store.getCommand(id)!, {}, { unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group', channel: 'bot' }, { signer: env.amber.bot.signer });
    assert.equal(r.ok, true, r.error);
    const lines = r.markdown.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines[0][0], 200);
    assert.equal(lines[0][1].text, 'summary[sonnet|写成三句话] of 7 chars', 'the default model, the system prompt, the text');
    assert.equal(lines[1][0], 400);
    assert.match(lines[1][1].message, /model 只能是：sonnet、haiku/);
    assert.equal(lines[2][0], 404);
    assert.equal(lines[0][1].persist, false);
    assert.equal(lines[0][1].sessionId, undefined, 'no session kept, none to name');
    assert.equal(lines[3][0], 200);
    assert.equal(lines[3][1].persist, true);
    assert.equal(lines[3][1].sessionId, 'sess-1', 'a kept session is named');
    assert.equal(lines[4][0], 400, 'persist is true or false');
    assert.equal(lines[5][0], 403, 'five calls declared: the sixth has no ticket left');
    // How the CLI was started: no tools, no settings files, its own empty directory, a bare environment;
    // no saved session unless the call asked for one.
    const calls = readFileSync(join(env.cfg.dataDir, 'llm-work', 'calls.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).slice(-2);
    const last = calls[0];
    assert.deepEqual(last.args.slice(0, 9), ['-p', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json']);
    assert.ok(last.args.includes('--model'));
    assert.deepEqual(calls[1].args.slice(0, 8), ['-p', '--tools', '', '--setting-sources', '', '--strict-mcp-config', '--output-format', 'json'], 'persist: the session is kept, still no tools');
    assert.deepEqual(last.env.filter((k: string) => !['__CF_USER_TEXT_ENCODING', 'PWD', 'SHLVL', '_', 'CPATH', 'LIBRARY_PATH', 'MANPATH', 'SDKROOT'].includes(k)), ['HOME', 'LANG', 'PATH'], 'nothing from Amber\'s own environment (the rest come from the macOS python3 shim)');
    // Audit: sizes and outcomes, never the text.
    const audit = env.amber.store.listAudit({ prefixes: ['llm.'], limit: 20 }).filter(a => JSON.parse(a.detail).runId === r.runId);   // the trial run made its own
    assert.equal(audit.length, 5, 'bad requests count as calls too');
    assert.equal(audit.filter(a => JSON.parse(a.detail).persist === true).length, 1, 'kept sessions are marked');
    assert.ok(audit.every(a => !a.detail.includes('群里说了很多话') && !a.detail.includes('summary[')));
    assert.deepEqual(audit.map(a => JSON.parse(a.detail).status).sort(), [200, 200, 400, 400, 404]);
  } finally { await env.close(); }
});

test('llm: failures, time limit, prompt size, and not offered unless configured', async () => {
  const env = await makeEnv({ llm: { command: FAKE, timeoutMs: 1500 } });
  const { bob } = env;
  try {
    const id = await activate(env, { chatId: GROUP, chatType: 'group', name: '出错', params: [], script: caller([
      'print(json.dumps(call("/complete", {"prompt": "FAIL please"})))',
      'print(json.dumps(call("/complete", {"prompt": "SLEEP please"})))',
      'print(json.dumps(call("/complete", {"prompt": "字" * 150001})))',
    ].join('\n')) }, bob);
    const r = await runCommand(env.amber.store, env.amber.store.getCommand(id)!, {}, { unionId: bob.unionId, openId: bob.openId, chatId: GROUP, chatType: 'group', channel: 'bot' }, { signer: env.amber.bot.signer });
    const lines = r.markdown.trim().split('\n').map(l => JSON.parse(l));
    assert.equal(lines[0][0], 502);
    assert.match(lines[0][1].message, /model said no/);
    assert.equal(lines[1][0], 504, 'killed at the time limit');
    assert.ok([413].includes(lines[2][0]), JSON.stringify(lines[2]));
  } finally { await env.close(); }
  const plain = await makeEnv();
  try {
    const r = await plain.submit({ chatId: GROUP, chatType: 'group', name: '没有大模型', params: [], script: script('print(1)', { services: { llm: { calls: 1 } } }) });
    assert.equal(r.ok, false);
    assert.match(r.message, /未知的服务 llm/);
  } finally { await plain.close(); }
});

test('llm: at most maxConcurrent at once; a call whose run ends while waiting gives nothing back', async () => {
  const { LlmService } = await import('../src/llm.ts');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const svc = new LlmService({ command: FAKE, maxConcurrent: 1, timeoutMs: 1500 }, mkdtempSync(join(tmpdir(), 'amber-llm-')));
  const ask = (prompt: string, signal: AbortSignal) => svc.handle('POST', '/complete', Buffer.from(JSON.stringify({ prompt })), signal);
  const slow = ask('SLEEP', new AbortController().signal);   // holds the only slot until its time limit
  const gone = new AbortController();
  const waiting = ask('never runs', gone.signal);
  const next = ask('runs after', new AbortController().signal);
  await new Promise(r => setTimeout(r, 100));
  assert.deepEqual(svc.load, { running: 1, waiting: 2 });
  gone.abort();
  assert.equal((await waiting).status, 499);
  assert.deepEqual(svc.load, { running: 1, waiting: 1 }, 'the canceled call took no slot');
  assert.equal((await slow).status, 504);
  assert.equal((await next).status, 200);
  assert.deepEqual(svc.load, { running: 0, waiting: 0 });
});
