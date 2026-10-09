// App sandbox policy (D49): baseline + declared paths + mandatory denies, enforced by Seatbelt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setSandboxContext, buildPolicy, compileToSeatbelt, validateAppSandbox } from '../src/sandbox-policy.ts';
import { runScript, validateScript } from '../src/runner.ts';
import { makeEnv, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const H = homedir();
const run = async (code: string, extra: Record<string, unknown> = {}) => {
  const s = validateScript({ kind: 'script', lang: 'python', code, timeoutMs: 15000, ...extra });
  const r = await runScript(s, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' });
  assert.equal(r.ok, true, r.error);
  return r.content;
};
// Prints, for each path, the first characters read or the error class.
const probe = (paths: string[], write?: string) => `def t(p):
    try: return open(p).read()[:8]
    except Exception as e: return type(e).__name__
${paths.map(p => `print(${JSON.stringify(p)}, t(${JSON.stringify(p)}))`).join('\n')}
${write ? `try:\n    open(${JSON.stringify(write)}, "w").write("x"); print("write ok")\nexcept Exception as e: print("write", type(e).__name__)` : ''}
`;

test('sandbox: declared paths open exactly what they say; credentials and Amber keys stay closed', async () => {
  const dir = join(H, `.amber-sbtest-${process.pid}`);
  const conf = join(dir, 'conf');
  mkdirSync(conf, { recursive: true });
  writeFileSync(join(dir, 'ledger.txt'), 'LEDGER-1');
  writeFileSync(join(conf, 'key.pem'), 'SECRET-1');
  // Pretend this dir holds Amber's keys, so the mandatory deny sits inside a declared tree.
  setSandboxContext({ configDir: conf });
  try {
    const paths = [join(dir, 'ledger.txt'), join(conf, 'key.pem'), join(H, '.ssh', 'known_hosts')];
    // Nothing declared: HOME data is invisible, writes outside the run dir fail.
    let out = await run(probe(paths, join(dir, 'new.txt')));
    assert.match(out, /ledger\.txt PermissionError/);
    assert.match(out, /write PermissionError/);
    // Read-only: the ledger reads; Amber's keys inside the same tree and ~/.ssh do not; no writing.
    out = await run(probe(paths, join(dir, 'new.txt')), { sandbox: { readOnly: [dir] } });
    assert.match(out, /ledger\.txt LEDGER-1/);
    assert.match(out, /key\.pem PermissionError/);
    assert.match(out, /known_hosts (PermissionError|FileNotFoundError)/);
    assert.match(out, /write PermissionError/);
    // Read-write: writing works; a deeper deny wins over it.
    mkdirSync(join(dir, 'private'), { recursive: true });
    writeFileSync(join(dir, 'private', 'p.txt'), 'PRIV');
    out = await run(probe([join(dir, 'private', 'p.txt')], join(dir, 'new.txt')), { sandbox: { readWrite: [dir], deny: [join(dir, 'private')] } });
    assert.match(out, /p\.txt PermissionError/);
    assert.match(out, /write ok/);
    assert.equal(readFileSync(join(dir, 'new.txt'), 'utf8'), 'x');
    // Even the whole home read-only cannot reach the mandatory denies.
    out = await run(probe([join(conf, 'key.pem')]), { sandbox: { readOnly: ['~'] } });
    assert.match(out, /key\.pem PermissionError/);
    // Toolchains outside the declared paths still work (external dependencies).
    out = await run('import subprocess\nprint(subprocess.run(["git","--version"],capture_output=True,text=True).stdout.strip())');
    assert.match(out, /git version/);
  } finally {
    setSandboxContext({ configDir: '' });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sandbox: what may be declared, and the order of the compiled profile', () => {
  setSandboxContext({ configDir: join(H, '.config', 'amber-test') });
  try {
    for (const bad of [{ readOnly: ['~/.ssh'] }, { readWrite: ['~/.config/amber-test/data'] }, { readOnly: ['~/.botmux/bots.json'] }, { readOnly: ['relative/path'] },
      { readOnly: ['/'] }, { foo: [] }, { readOnly: 'not-a-list' }, { readOnly: Array.from({ length: 51 }, (_, i) => `/tmp/x${i}`) }]) {
      assert.throws(() => validateAppSandbox(bad), undefined, JSON.stringify(bad));
    }
    assert.deepEqual(validateAppSandbox({ readOnly: ['~/data'], deny: ['~/.ssh'] }), { readOnly: ['~/data'], deny: ['~/.ssh'] }, 'denying a protected dir is fine');
    for (const bad of ['/usr/bin/node', '~/.ssh/python3', 'python3']) {
      assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', interpreter: bad }), undefined, bad);
    }
    // Mandatory denies come after every grant (Seatbelt: the last matching rule wins).
    const prof = compileToSeatbelt(buildPolicy({ runDir: '/private/tmp/run', app: { readOnly: ['~'] } }), { all: false });
    const lastAllow = prof.lastIndexOf('(allow file-read* ');
    const firstMandatory = prof.indexOf(`(deny file-read* (subpath "${H}/.ssh"))`);
    assert.ok(firstMandatory > lastAllow, 'mandatory denies are emitted last');
    assert.doesNotMatch(prof, /\(allow network/);
    assert.match(compileToSeatbelt(buildPolicy({ runDir: '/private/tmp/run' }), { all: false, tcpPorts: [8765] }), /remote ip "localhost:8765"/);
  } finally { setSandboxContext({ configDir: '' }); }
});

test('sandbox: shown on the claim card and part of the reviewed spec', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '读台账', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)', sandbox: { readOnly: ['~/ledger'] } } });
    assert.equal(r.ok, true);
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /沙箱.*只读 ~\/ledger/);
    const c = env.amber.store.getCommand(r.id)!;
    assert.deepEqual(c.script.sandbox, { readOnly: ['~/ledger'] });
    // Widening the paths behind Amber's back breaks the spec hash, so it will not run.
    (env.amber.store as any).db.prepare('UPDATE commands SET script_json = ? WHERE id = ?').run(JSON.stringify({ ...c.script, sandbox: { readOnly: ['~'] } }), r.id);
    const { computeSpecHash } = await import('../src/db.ts');
    assert.notEqual(computeSpecHash(env.amber.store.getCommand(r.id)!), c.specHash);
    const bad = await env.submit({ chatId: GROUP, chatType: 'group', name: '偷钥匙', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)', sandbox: { readOnly: ['~/.ssh'] } } });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /受保护的目录/);
  } finally { await env.close(); }
});

const ALT_PY = ['/opt/homebrew/bin/python3', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/usr/local/bin/python3'].find(p => existsSync(p));
test('sandbox: a declared interpreter is used (packages from its own environment)', { skip: !ALT_PY }, async () => {
  const out = await run('import sys\nprint("exe", sys.executable)', { interpreter: ALT_PY });
  const real = realpathSync(ALT_PY!);
  assert.ok(out.includes(ALT_PY!) || out.includes(real) || /\/opt\/homebrew|\/usr\/local/.test(out), out);
  assert.doesNotMatch(out, /CommandLineTools/);
});
