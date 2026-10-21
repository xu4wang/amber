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
if os.environ.get("FAKE_ERR") == "scope":
    # like lark-cli: the error as pretty JSON on stderr, nothing on stdout
    sys.stderr.write(json.dumps({"ok": False, "identity": "user", "error": {"type": "authorization", "code": 99991679, "message": "user not authorized", "missing_scopes": ["search:message"]}}, indent=2))
    sys.exit(1)
if os.environ.get("FAKE_ERR") == "other":
    sys.stderr.write(json.dumps({"ok": False, "error": {"type": "api", "code": 230001, "message": "chat not found"}}, indent=2))
    sys.exit(1)
if k == "api GET":
    # the transcript, written to the -o file in the current directory (the run's temp dir)
    assert "/minutes/v1/minutes/obc" in a[2] and a[2].endswith("/transcript"), a
    open(a[a.index("-o") + 1], "w").write("张三：开场\\n李四：说正事")
    print(json.dumps({"ok": True}))
    sys.exit(0)
msg = lambda i, t, **kw: {"message_id": "om_%d" % i, "create_time": "2026-10-17 10:%02d" % (i % 60), "sender": {"name": "张三"}, "chat_name": "项目群", "content": t, **kw}
if k == "im +threads-messages-list" and os.environ.get("FAKE_SLOW"):
    import time; time.sleep(10)
if k == "im +messages-search" and os.environ.get("FAKE_MANY"):
    print(json.dumps({"ok": True, "data": {"messages": [msg(i, "白名单 " + "y" * 1500) for i in range(100)]}}))
    sys.exit(0)
data = {
  # om_5 is a thread root that contains the keyword; its replies don't, and om_7 (also a hit) is one of them.
  "im +messages-search": {"messages": [msg(1, "周报 已发"), msg(2, "x" * 5000), msg(5, "OCBC 上线，周报里加白名单", thread_id="omt_1"), msg(7, "周报 白名单 已加", thread_id="omt_1")]},
  "im +threads-messages-list": {"messages": [msg(5, "OCBC 上线，周报里加白名单", thread_id="omt_1"), msg(6, "给 Wade", thread_id="omt_1"), msg(7, "周报 白名单 已加", thread_id="omt_1")], "has_more": False},
  "im +chat-messages-list": {"messages": [msg(3, "晚些"), msg(2, "早些")]},
  "im +chat-search": {"items": [{"name": "项目群", "chat_id": "oc_abc"}]},
  "mail +triage": {"messages": [{"message_id": "M1", "date": "Fri", "from": "A <a@x.com>", "subject": "合同"}]},
  "mail +message": {"subject": "合同", "from": {"mail_address": "a@x.com", "name": "A"}, "to": [{"mail_address": "me@x.com", "name": "我"}, {"mail_address": "b@x.com"}], "body_plain_text": "正文内容" * 20000},
  "minutes +search": {"items": [{"token": "obc" + ("o" if "--owner-ids" in a else "p") + ("2" if "--page-token" in a else "x") + "x" * 19, "display_info": "&lt;b&gt;周会&lt;/b&gt;\\n开始时间: 2026.10.19 10:00", "meta_data": {"app_link": "https://x.feishu.cn/minutes/obc"}}], "has_more": "--page-token" not in a, "page_token": "p2"},
  "minutes +detail": {"minutes": [{"minute_token": "obcmxxxxxxxxxxxxxxxxxxxx", "title": "周会", "artifacts": {"summary": "定了三件事", "todos": [{"content": "张三发周报"}], "chapters": [{"title": "开场"}]}}]},
  "docs +fetch": {"document": {"title": "方案", "content": "# 方案\\n内容"}},
}[k]
print(json.dumps({"ok": True, "data": data}))
`, { mode: 0o755 });
  const run = (params: Record<string, string>, extraEnv: Record<string, string> = {}) => execFileSync('python3', [join(ROOT, 'samples', 'my-lark-data', 'app.py')], {
    cwd: dir, env: { ...process.env, ...extraEnv },
    input: JSON.stringify({ params, larkUser: { accessToken: 'u-tok', appId: 'cli_x', expiresAt: 0, env: { LARKSUITE_CLI_USER_ACCESS_TOKEN: 'u-tok', LARKSUITE_CLI_APP_ID: 'cli_x' }, cli: join(dir, 'lark-cli') } }),
  }).toString();
  const s1 = run({ op: '搜消息', q: '周报', hours: '24', limit: '30' });
  assert.match(s1, /项目群/); assert.match(s1, /张三：周报 已发/); assert.match(s1, /om_1/); assert.match(s1, /x{2000}…/, 'one message is capped');
  // A hit in a thread brings the thread's other messages along, indented; a reply that is also a hit is listed once.
  assert.match(s1, /OCBC 上线.*`om_5`\n  ↳ - .*张三：给 Wade\n  ↳ - .*张三：周报 白名单 已加/);
  assert.equal(s1.match(/周报 白名单 已加/g)?.length, 1);
  assert.equal(readFileSync(log, 'utf8').split('+threads-messages-list').length - 1, 1, 'each thread is read once');
  // A slow thread read is cut at the remaining time budget and noted, not left to kill the whole run.
  const ss = run({ op: '搜消息', q: '周报' }, { FAKE_SLOW: '1', MLD_THREAD_BUDGET: '8' });
  assert.match(ss, /张三：周报 已发/); assert.match(ss, /话题回复没读到：超时/);
  // Too much for the agent to see in one go: cut on a whole line, under the cap, and say how many are left.
  const sm = run({ op: '搜消息', q: '白名单', limit: '100' }, { FAKE_MANY: '1' });
  assert.ok(sm.length < 25300, String(sm.length)); assert.match(sm, /后面还有 (\d+) 条没显示/);
  const shownN = sm.split('\n').filter(l => l.startsWith('- ')).length;
  assert.equal(shownN + Number(sm.match(/还有 (\d+) 条/)![1]), 100);
  assert.ok(sm.split('\n').filter(l => l.startsWith('- ')).every(l => l.endsWith('`')), 'no line is cut in half');
  const s2 = run({ op: '会话记录', q: 'oc_abc' });
  assert.ok(s2.indexOf('早些') < s2.indexOf('晚些'), 'oldest first');
  assert.match(run({ op: '找会话', q: '项目' }), /oc_abc/);
  assert.match(run({ op: '搜邮件', q: '合同' }), /M1/);
  const s5 = run({ op: '读邮件', q: 'M1' });
  assert.match(s5, /发件人：A <a@x\.com>/); assert.match(s5, /收件人：我 <me@x\.com>、b@x\.com/); assert.doesNotMatch(s5, /mail_address/);
  assert.match(s5, /已截断/); assert.ok(s5.length < 61000);
  const s7 = run({ op: '搜妙记', q: '周会', hours: '48' });
  assert.match(s7, /4 条/, 'owned and joined, two pages each, merged'); assert.match(s7, /周会 · 开始时间: 2026\.10\.19 10:00/);
  const s8 = run({ op: '读妙记', q: 'https://x.feishu.cn/minutes/obcmxxxxxxxxxxxxxxxxxxxx' });
  assert.match(s8, /妙记：周会/); assert.match(s8, /定了三件事/); assert.match(s8, /张三发周报/); assert.match(s8, /李四：说正事/);
  assert.throws(() => run({ op: '读妙记', q: '昨天的会' }), 'a link or token only');
  // Errors reach the agent as a reason it can act on: a missing permission says to authorize again.
  const err = (params: Record<string, string>, e: string) => { try { run(params, { FAKE_ERR: e }); return ''; } catch (x: any) { return String(x.stderr); } };
  const se = err({ op: '搜消息', q: '周报' }, 'scope');
  assert.match(se, /缺少飞书权限（search:message）/); assert.match(se, /授权飞书/);
  const oe = err({ op: '找会话', q: '项目' }, 'other');
  assert.match(oe, /230001/); assert.match(oe, /chat not found/); assert.doesNotMatch(oe, /授权飞书/);
  assert.throws(() => run({ op: '读妙记', q: 'obcmxxxxxxxxxxxxxxxxxxxx/../../other' }), 'nothing but the token reaches the path');
  assert.ok(!readdirSync(dir).some(f => f.startsWith('transcript-')), 'the transcript file is removed');
  assert.match(run({ op: '读文档', q: 'https://x.feishu.cn/docx/abc' }), /文档：方案/);
  assert.throws(() => run({ op: '会话记录', q: '项目群' }), 'a chat id or a person id only');
  // Read-only: every command it ran is a read.
  const used = new Set(readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l).slice(0, 2).join(' ')));
  assert.deepEqual([...used].sort(), ['api GET', 'docs +fetch', 'im +chat-messages-list', 'im +chat-search', 'im +messages-search', 'im +threads-messages-list', 'mail +message', 'mail +triage', 'minutes +detail', 'minutes +search']);
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
