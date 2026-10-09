// Sandbox (D49/D51): commands declare no paths; an environment's approved access is the only way to
// reach data. Credential stores are denied unless an environment re-opens a path inside one; Amber's
// and the executor's keys, ~/.ssh and keychains are never reachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, realpathSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { setSandboxContext, buildPolicy, compileToSeatbelt, validateEnvAccess, credentialGrants, type EnvAccess } from '../src/sandbox-policy.ts';
import { runSandboxed } from '../src/sandbox-run.ts';
import { runScript, validateScript } from '../src/runner.ts';
import { makeEnv, GROUP } from './env.ts';
import { FakeFeishu } from './fake-feishu.ts';

const H = homedir();
const PY = '/usr/bin/python3';
// Prints, for each path, the first characters read or the error class; then tries one write.
const probe = (paths: string[], write?: string) => `def t(p):
    try: return open(p).read()[:8]
    except Exception as e: return type(e).__name__
${paths.map(p => `print(${JSON.stringify(p)}, t(${JSON.stringify(p)}))`).join('\n')}
${write ? `try:\n    open(${JSON.stringify(write)}, "w").write("x"); print("write ok")\nexcept Exception as e: print("write", type(e).__name__)` : ''}
`;
/** Runs code with an environment's access, the way the executor does. */
const inEnv = async (code: string, access: EnvAccess | undefined, home = H) => {
  const r = await runSandboxed({ code, python: PY, input: {}, timeoutMs: 15000, profileFor: dir => compileToSeatbelt(buildPolicy({ runDir: dir, access, home }), { all: false }) });
  assert.equal(r.ok, true, r.error);
  return r.content;
};

test('sandbox: a command on Amber sees no data — only its run dir and the toolchains', async () => {
  const dir = join(H, `.amber-sbtest-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'ledger.txt'), 'LEDGER-1');
  try {
    const s = validateScript({ kind: 'script', lang: 'python', code: probe([join(dir, 'ledger.txt')], join(dir, 'new.txt')), timeoutMs: 15000 });
    const r = await runScript(s, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' });
    assert.match(r.content, /ledger\.txt PermissionError/);
    assert.match(r.content, /write PermissionError/);
    const g = await runScript(validateScript({ kind: 'script', lang: 'python', code: 'import subprocess\nprint(subprocess.run(["git","--version"],capture_output=True,text=True).stdout.strip())' }), { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' });
    assert.match(g.content, /git version/);
    // Commands cannot declare paths any more.
    assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', sandbox: { readOnly: ['/tmp'] } }), /由运行环境决定/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sandbox: an environment grants exactly its paths; credential stores need an explicit grant; keys never open', async () => {
  // A fake home, so credential stores can be created freely.
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'amber-home-')));
  const conf = join(home, '.config', 'amber-executor');
  setSandboxContext({ home, configDir: conf });
  try {
    const f = (rel: string, body: string) => { mkdirSync(join(home, rel, '..'), { recursive: true }); writeFileSync(join(home, rel), body); return join(home, rel); };
    const ledger = f('bot/data/ledger.txt', 'LEDGER-1'), priv = f('bot/private/p.txt', 'PRIV');
    const botData = f('.botmux/bots/x/db.txt', 'BOTDB'), botCred = f('.botmux/bots/x/send-cred.json', 'SENDCRED'), botmuxRoot = f('.botmux/config.json', 'ROOTCFG');
    const larkSecret = f('Library/Application Support/lark-cli/appsecret_x.enc', 'MINE'), larkOther = f('Library/Application Support/lark-cli/appsecret_y.enc', 'OTHER');
    const key = f('.config/amber-executor/box-key.pem', 'EXECKEY'), ssh = f('.ssh/id_ed25519', 'SSHKEY');
    // Directory environment, read-only: data readable, nothing writable.
    let out = await inEnv(probe([ledger, priv], join(home, 'bot', 'data', 'new.txt')), { readOnly: [join(home, 'bot', 'data')] }, home);
    assert.match(out, /ledger\.txt LEDGER-1/);
    assert.match(out, /p\.txt PermissionError/);
    assert.match(out, /write PermissionError/);
    // Read-write with a deeper deny.
    out = await inEnv(probe([priv, ledger], join(home, 'bot', 'data', 'new.txt')), { readWrite: [join(home, 'bot')], deny: [join(home, 'bot', 'private')] }, home);
    assert.match(out, /p\.txt PermissionError/);
    assert.match(out, /ledger\.txt LEDGER-1/);
    assert.match(out, /write ok/);
    // The whole home readable: credential stores and keys stay closed.
    out = await inEnv(probe([ledger, botData, botmuxRoot, larkSecret, key, ssh]), { readOnly: [home] }, home);
    assert.match(out, /ledger\.txt LEDGER-1/);
    for (const name of ['db.txt', 'config.json', 'appsecret_x.enc', 'box-key.pem', 'id_ed25519']) assert.match(out, new RegExp(`${name.replace('.', '\\.')} PermissionError`), name);
    // A bot environment re-opens its own paths inside the stores — and only those.
    out = await inEnv(probe([botData, botCred, botmuxRoot, larkSecret, larkOther, key, ssh]),
      { readWrite: [join(home, '.botmux', 'bots', 'x')], readOnly: [larkSecret, key, join(home, '.ssh')], deny: [botCred] }, home);
    assert.match(out, /db\.txt BOTDB/);
    assert.match(out, /appsecret_x\.enc MINE/);
    for (const name of ['send-cred.json', 'config.json', 'appsecret_y.enc', 'box-key.pem', 'id_ed25519']) assert.match(out, new RegExp(`${name.replace('.', '\\.')} PermissionError`), name);
    // Same-path grant of a credential root itself re-opens it (the environment chose it explicitly).
    out = await inEnv(probe([botmuxRoot]), { readOnly: [join(home, '.botmux')] }, home);
    assert.match(out, /config\.json ROOTCFG/);
  } finally {
    setSandboxContext({ configDir: '' });
    rmSync(home, { recursive: true, force: true });
  }
});

test('sandbox: what an environment may declare, and the order of the compiled profile', () => {
  setSandboxContext({ configDir: join(H, '.config', 'amber-test') });
  try {
    for (const bad of [{ readOnly: ['~/.ssh'] }, { readOnly: ['~/.ssh/id_ed25519'] }, { readWrite: ['~/.config/amber-test/data'] }, { readOnly: ['~/.config/amber-executor'] },
      { readOnly: ['~/Library/Keychains'] }, { readOnly: ['~/Library'] }, { readOnly: ['relative/path'] }, { readOnly: ['/'] }, { readOnly: ['/a/../b'] },
      { foo: [] }, { readOnly: 'not-a-list' }, { readOnly: Array.from({ length: 101 }, (_, i) => `/tmp/x${i}`) }]) {
      assert.throws(() => validateEnvAccess(bad), undefined, JSON.stringify(bad));
    }
    // Paths come back absolute; {WORKDIR} resolves; denying a protected dir is fine.
    assert.deepEqual(validateEnvAccess({ readOnly: ['~/data', '{WORKDIR}/2026'], deny: ['~/.ssh'] }, { workdir: '/w' }), { readOnly: [`${H}/data`, '/w/2026'], deny: [`${H}/.ssh`] });
    assert.deepEqual(credentialGrants({ readWrite: [`${H}/.botmux/bots/x`, `${H}/data`], readOnly: [`${H}/.lark-cli-bots/x`] }), [`${H}/.botmux/bots/x`, `${H}/.lark-cli-bots/x`]);
    for (const bad of ['/usr/bin/node', '~/.ssh/python3', 'python3']) {
      assert.throws(() => validateScript({ kind: 'script', lang: 'python', code: 'print(1)', interpreter: bad }), undefined, bad);
    }
    // Hard denies come after every grant (Seatbelt: the last matching rule wins).
    const prof = compileToSeatbelt(buildPolicy({ runDir: '/private/tmp/run', access: { readOnly: [H] } }), { all: false });
    assert.ok(prof.indexOf(`(deny file-read* (subpath "${realpathSync(H)}/.ssh"))`) > prof.lastIndexOf('(allow file-read* '), 'hard denies are emitted last');
    assert.doesNotMatch(prof, /\(allow network/);
    assert.match(compileToSeatbelt(buildPolicy({ runDir: '/private/tmp/run' }), { all: false, tcpPorts: [8765] }), /remote ip "localhost:8765"/);
  } finally { setSandboxContext({ configDir: '' }); }
});

test('sandbox: the claim card says where a command runs and that it reaches no data on Amber', async () => {
  const env = await makeEnv();
  try {
    const r = await env.submit({ chatId: GROUP, chatType: 'group', name: '本机', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)' } });
    assert.equal(r.ok, true);
    assert.match(FakeFeishu.text(env.fake.cardOf(r.claimMessageId)), /执行位置.*Amber 本机.*不访问任何业务数据/);
    const bad = await env.submit({ chatId: GROUP, chatType: 'group', name: '自带路径', params: [], script: { kind: 'script', lang: 'python', code: 'print(1)', sandbox: { readOnly: ['~/ledger'] } } });
    assert.equal(bad.ok, false);
    assert.match(bad.message, /由运行环境决定/);
  } finally { await env.close(); }
});

const ALT_PY = ['/opt/homebrew/bin/python3', '/opt/homebrew/bin/python3.13', '/opt/homebrew/bin/python3.12', '/usr/local/bin/python3'].find(p => existsSync(p));
test('sandbox: a declared interpreter is used (packages from its own environment)', { skip: !ALT_PY }, async () => {
  const s = validateScript({ kind: 'script', lang: 'python', code: 'import sys\nprint("exe", sys.executable)', interpreter: ALT_PY });
  const r = await runScript(s, { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' });
  assert.equal(r.ok, true, r.error);
  assert.doesNotMatch(r.content, /CommandLineTools/);
});

test('sandbox: a failing script shows the tail of stdout as well as stderr', async () => {
  const fail = async (code: string) => {
    const r = await runScript(validateScript({ kind: 'script', lang: 'python', code, timeoutMs: 15000 }), { params: {}, caller: { unionId: 'u', chatId: 'c', channel: 'bot' }, runId: 'r' });
    assert.equal(r.ok, false);
    return r.error ?? '';
  };
  // Reason printed to stdout only (the case that used to show a bare exit code).
  assert.equal(await fail('import sys\nprint("## 标题")\nprint("查询失败：validation_error permission_denied")\nsys.exit(1)'), '脚本退出码 1：## 标题 / 查询失败：validation_error permission_denied');
  // Both streams: stderr first.
  assert.equal(await fail('import sys\nprint("out")\nsys.exit("err")'), '脚本退出码 1：err / out');
  // Silent failure keeps the bare form; a huge stdout line is capped.
  assert.equal(await fail('import sys\nsys.exit(3)'), '脚本退出码 3');
  assert.ok((await fail('import sys\nprint("x" * 100000)\nsys.exit(1)')).length < 600);
});
