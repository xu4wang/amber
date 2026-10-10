// Screenshots of page apps for their confirmation cards: a headless Chrome loads the page from Amber itself.
// The page cannot run apps here (there is no shell around it), and it reaches nothing but its own files:
// every host name resolves to nowhere except the pages host, which goes straight to Amber's website port, and
// everything else (IP addresses too) is sent to a proxy that does not exist.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SHOT_TIMEOUT_MS = 20_000;
const MAX_SHOTS_AT_ONCE = 2;            // more publishes at the same moment just go without a picture
const MAX_PNG_BYTES = 5 * 1024 * 1024;

export function makePageShooter(chrome: string, pagesBaseUrl: string, webPort: number): (path: string) => Promise<Buffer | undefined> {
  const base = new URL(pagesBaseUrl);
  let running = 0;
  return path => new Promise(resolve => {
    if (running >= MAX_SHOTS_AT_ONCE) return resolve(undefined);
    let dir: string;
    try { dir = mkdtempSync(join(tmpdir(), 'amber-shot-')); } catch { return resolve(undefined); }
    running++;
    const out = join(dir, 'page.png');
    const args = [
      '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--mute-audio',
      '--proxy-server=http://127.0.0.1:9', `--proxy-bypass-list=${base.hostname};<-loopback>`,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',   // WebRTC goes through the (missing) proxy too
      `--user-data-dir=${join(dir, 'profile')}`,
      `--host-resolver-rules=MAP ${base.hostname} 127.0.0.1:${webPort}, MAP * ~NOTFOUND`,
      '--window-size=1280,800', '--virtual-time-budget=4000', `--screenshot=${out}`,
      new URL(path, base).href,
    ];
    // Its own process group, so a hung Chrome goes with all its helper processes.
    const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } }, SHOT_TIMEOUT_MS);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      running--;
      const png = existsSync(out) && statSync(out).size <= MAX_PNG_BYTES ? readFileSync(out) : undefined;
      rmSync(dir, { recursive: true, force: true });
      resolve(png && png.length ? png : undefined);
    };
    child.on('exit', finish);
    child.on('error', finish);
  });
}
