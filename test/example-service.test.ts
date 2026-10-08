// The identity example (examples/identity-service) for real: start service.py with a pinned key
// file, sign tokens with Amber's Signer, run the command script against it.
// service.py needs `cryptography`: set AMBER_EXAMPLE_PYTHON to a Python that has it, otherwise skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { Signer } from '../src/identity.ts';

const PY = process.env.AMBER_EXAMPLE_PYTHON;
const EX = join(import.meta.dirname, '..', 'examples', 'identity-service');

test('identity example: pinned keys, first use ok, replay and unknown key refused', { skip: PY ? false : 'set AMBER_EXAMPLE_PYTHON to a python with cryptography' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'amber-example-'));
  mkdirSync(join(dir, 'a')); mkdirSync(join(dir, 'b'));
  const amber = new Signer(join(dir, 'a'));
  const stranger = new Signer(join(dir, 'b'));
  writeFileSync(join(dir, 'keys.json'), JSON.stringify(amber.jwks()));
  const user = Object.keys(JSON.parse(readFileSync(join(EX, 'data.json'), 'utf8')).permissions)[0];
  const port = 22000 + Math.floor(Math.random() * 20000);
  const svc = spawn(PY!, [join(EX, 'service.py')], { env: { ...process.env, DEMO_PORT: String(port), AMBER_KEYS_FILE: join(dir, 'keys.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  svc.stdout.on('data', d => { log += d; }); svc.stderr.on('data', d => { log += d; });
  try {
    for (let i = 0; ; i++) {
      const up = await new Promise<boolean>(r => { const s = createConnection(port, '127.0.0.1', () => { s.end(); r(true); }); s.on('error', () => r(false)); });
      if (up) break;
      assert.ok(i < 50 && svc.exitCode === null, `service did not start:\n${log}`);
      await new Promise(r => setTimeout(r, 100));
    }
    const tok = (s: Signer) => s.issue({ aud: 'demo-profile', sub: user, cmd: 'c1', rev: 'r1', run: 'run1', chat: 'oc_x', channel: 'bot', callIndex: 1, callCount: 1 });
    const run = (t: string) => spawnSync('python3', [join(EX, 'command_script.py')], { input: JSON.stringify({ params: {}, services: { 'demo-profile': { tokens: [t], tcpPort: port } } }), encoding: 'utf8' });
    const t = tok(amber);
    const first = run(t);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /你能看到的区域/);
    const again = run(t);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /已经用过/);
    const forged = run(tok(stranger));
    assert.notEqual(forged.status, 0);
    assert.match(forged.stderr, /不认识的密钥/);
    // The audit line carries the call number (printed right after the reply, so wait for it).
    for (let i = 0; i < 30 && !/call=1\/1/.test(log); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(log, /call=1\/1/);
  } finally { svc.kill(); rmSync(dir, { recursive: true, force: true }); }
});
