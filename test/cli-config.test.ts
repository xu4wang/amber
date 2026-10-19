// The service address for `amber`: $AMBER_URL, ~/.config/amber-client.json, or a copy next to the command (an agent in a
// sandbox that hides ~/.config still reads where it runs amber from). A config file it may not read is reported as
// such, not as "not configured" — that sent an agent off asking people for an address that was already set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(import.meta.dirname, '..', 'client', 'amber');
// No Amber server is involved: the address shows up in the "cannot connect" message.
const DEAD = 'http://127.0.0.1:9';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'amber-cfg-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  copyFileSync(CLI, join(bin, 'amber'));
  const run = (args: string[], env: Record<string, string> = {}) => {
    const r = spawnSync('python3', [join(bin, 'amber'), ...args], { env: { PATH: process.env.PATH!, HOME: home, ...env }, encoding: 'utf8' });
    return r.stdout + r.stderr;
  };
  return { home, bin, run };
}

test('amber config: set-url writes both places; either one is enough', () => {
  const { home, bin, run } = setup();
  assert.match(run(['config', 'set-url', DEAD]), /已设置/);
  for (const p of [join(home, '.config', 'amber-client.json'), join(bin, 'amber-client.json')]) assert.equal(JSON.parse(readFileSync(p, 'utf8')).url, DEAD);
  assert.match(run(['info']), /127\.0\.0\.1:9/);
  // ~/.config hidden (as in a sandbox): the copy next to the command is used.
  chmodSync(join(home, '.config', 'amber-client.json'), 0o000);
  assert.match(run(['info']), /127\.0\.0\.1:9/);
  chmodSync(join(home, '.config', 'amber-client.json'), 0o600);
});

test('amber config: an unreadable file is reported as unreadable, with the way out; a missing one as not configured', () => {
  const { home, run } = setup();
  assert.match(run(['info']), /还没配置 Amber 服务地址/);
  mkdirSync(join(home, '.config'));
  writeFileSync(join(home, '.config', 'amber-client.json'), JSON.stringify({ url: DEAD }));
  chmodSync(join(home, '.config', 'amber-client.json'), 0o000);
  const out = run(['info']);
  assert.match(out, /读不到配置文件/); assert.match(out, /AMBER_URL/); assert.doesNotMatch(out, /还没配置/);
  // AMBER_URL still wins over everything.
  assert.match(run(['info'], { AMBER_URL: 'http://127.0.0.1:8' }), /127\.0\.0\.1:8/);
  chmodSync(join(home, '.config', 'amber-client.json'), 0o600);
  assert.ok(existsSync(join(home, '.config', 'amber-client.json')));
});
