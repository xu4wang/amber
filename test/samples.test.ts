// The sample apps in samples/ (docs/samples.md): each one is a valid draft, its script compiles, and
// `amber submit samples/<x>/app.json` (code in app.py, chat and claimer from the command line) submits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
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
  assert.deepEqual(SAMPLES.sort(), ['chat-digest', 'secret-vault', 'weather']);
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
