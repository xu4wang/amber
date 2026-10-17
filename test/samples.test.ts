// The sample apps in samples/ (docs/samples.md): each one is a valid draft, its script compiles, and
// `amber submit samples/<x>/app.json` (code in app.py, chat and claimer from the command line) submits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeEnv, activate, GROUP } from './env.ts';

const ROOT = join(import.meta.dirname, '..');
const SAMPLES = readdirSync(join(ROOT, 'samples'), { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const FAKE = join(import.meta.dirname, 'fake-claude.py');

function load(name: string): Record<string, any> {
  const app = JSON.parse(readFileSync(join(ROOT, 'samples', name, 'app.json'), 'utf8'));
  const { codeFile, ...script } = app.script;
  return { ...app, script: { ...script, code: readFileSync(join(ROOT, 'samples', name, codeFile), 'utf8') } };
}

test('samples: there are the documented ones, and every script compiles', () => {
  assert.deepEqual(SAMPLES.sort(), ['chat-digest', 'my-lark-data', 'secret-vault', 'weather']);
  const doc = readFileSync(join(ROOT, 'docs', 'samples.md'), 'utf8');
  for (const s of SAMPLES) {
    assert.ok(doc.includes(`samples/${s}/`), `docs/samples.md explains ${s}`);
    execFileSync('python3', ['-c', 'import sys; compile(open(sys.argv[1]).read(), sys.argv[1], "exec")', join(ROOT, 'samples', s, 'app.py')]);
  }
});

test('samples: each is accepted as a draft; the vault runs with nothing set and never prints values', async () => {
  const env = await makeEnv({ llm: { command: FAKE, models: ['haiku', 'sonnet'] } });
  try {
    for (const s of SAMPLES) {
      const r = await env.submit({ chatId: GROUP, chatType: 'group', claimer: env.bob.email, ...load(s) });
      assert.equal(r.ok, true, `${s}: ${JSON.stringify(r)}`);
      await env.click(env.bob, r.claimMessageId, { a: 'claim_drop', c: r.id });
    }
    const id = await activate(env, { chatId: GROUP, chatType: 'group', ...load('secret-vault') }, env.bob);
    const run = env.amber.store.runsByCaller(env.bob.unionId, 5).find(x => x.commandId === id)!;
    assert.match(run.result ?? '', /KEY1 \| 未填/);
  } finally { await env.close(); }
});

test('samples: my-lark-data reads with the person\'s token, read-only commands only, and caps what it hands over', () => {
  const dir = mkdtempSync(join(tmpdir(), 'amber-mld-'));
  const log = join(dir, 'calls.log');
  // A stand-in lark-cli: records each call and answers with the shapes the app reads.
  writeFileSync(join(dir, 'lark-cli'), `#!/usr/bin/env python3
import json, os, sys
a = sys.argv[1:]
open(${JSON.stringify(log)}, "a").write(json.dumps(a) + "\\n")
assert os.environ.get("LARKSUITE_CLI_USER_ACCESS_TOKEN") == "u-tok", "the person's token"
assert a[-2:] == ["--as", "user"], "always as the person"
k = " ".join(a[:2])
msg = lambda i, t: {"message_id": "om_%d" % i, "create_time": "2026-10-17 10:%02d" % i, "sender": {"name": "张三"}, "chat_name": "项目群", "content": t}
data = {
  "im +messages-search": {"messages": [msg(1, "周报 已发"), msg(2, "x" * 5000)]},
  "im +chat-messages-list": {"messages": [msg(3, "晚些"), msg(2, "早些")]},
  "im +chat-search": {"items": [{"name": "项目群", "chat_id": "oc_abc"}]},
  "mail +triage": {"messages": [{"message_id": "M1", "date": "Fri", "from": "A <a@x.com>", "subject": "合同"}]},
  "mail +message": {"subject": "合同", "from": "A <a@x.com>", "to": "me", "body_plain_text": "正文内容" * 20000},
  "docs +fetch": {"document": {"title": "方案", "content": "# 方案\\n内容"}},
}[k]
print(json.dumps({"ok": True, "data": data}))
`, { mode: 0o755 });
  const run = (params: Record<string, string>) => execFileSync('python3', [join(ROOT, 'samples', 'my-lark-data', 'app.py')], {
    input: JSON.stringify({ params, larkUser: { accessToken: 'u-tok', appId: 'cli_x', expiresAt: 0, env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-tok', LARKSUITE_CLI_APP_ID: 'cli_x' }, cli: join(dir, 'lark-cli') } }),
  }).toString();
  const s1 = run({ op: '搜消息', q: '周报', hours: '24', limit: '30' });
  assert.match(s1, /项目群/); assert.match(s1, /张三：周报 已发/); assert.match(s1, /om_1/); assert.match(s1, /x{2000}…/, 'one message is capped');
  const s2 = run({ op: '会话记录', q: 'oc_abc' });
  assert.ok(s2.indexOf('早些') < s2.indexOf('晚些'), 'oldest first');
  assert.match(run({ op: '找会话', q: '项目' }), /oc_abc/);
  assert.match(run({ op: '搜邮件', q: '合同' }), /M1/);
  const s5 = run({ op: '读邮件', q: 'M1' });
  assert.match(s5, /发件人：A/); assert.match(s5, /已截断/); assert.ok(s5.length < 61000);
  assert.match(run({ op: '读文档', q: 'https://x.feishu.cn/docx/abc' }), /文档：方案/);
  assert.throws(() => run({ op: '会话记录', q: '项目群' }), 'a chat id or a person id only');
  // Read-only: every command it ran is a read.
  const used = new Set(readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).slice(0, 2).join(' ')));
  assert.deepEqual([...used].sort(), ['docs +fetch', 'im +chat-messages-list', 'im +chat-search', 'im +messages-search', 'mail +message', 'mail +triage']);
});

test('samples: amber submit takes app.json as it is in the repo (code file, this chat, --user)', async () => {
  const env = await makeEnv();
  try {
    // Not spawnSync: the Amber under test answers in this same process.
    const r = await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const p = spawn('python3', [join(ROOT, 'client', 'amber'), 'submit', join(ROOT, 'samples', 'secret-vault', 'app.json'), '--chat', GROUP, '--user', env.bob.email, '--label', 'TestBot'],
        { env: { ...process.env, AMBER_URL: `http://127.0.0.1:${env.apiPort}`, NO_PROXY: '*', no_proxy: '*' } });
      let stdout = '', stderr = '';
      p.stdout.on('data', d => stdout += d); p.stderr.on('data', d => stderr += d);
      p.on('close', status => resolve({ status, stdout, stderr }));
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /已提交草稿/);
    const d = env.amber.store.listAll().find(c => c.name === '密钥保管箱')!;
    assert.equal(d.chatId, GROUP);
    assert.equal(env.amber.store.getMeta(d.id).expectedClaimer ?? null, null, 'a group draft: anyone in the group may claim');
    assert.match(d.script.code, /密钥保管箱/);
    assert.equal(d.script.secretsOptional, true);
  } finally { await env.close(); }
});
