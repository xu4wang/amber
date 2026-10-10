// Renders scene.html frame by frame in headless Chrome and encodes docs/assets/amber-why.gif with ffmpeg.
// usage: node scripts/login-gif/render.mjs [chrome]   (default: $CHROME, else the Playwright headless shell)
// Needs ffmpeg. The scene is drawn on a 720×405 canvas and scaled to W×H; the GIF is shown at 2/3 of that size.
import { spawn, execFileSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
const W = 780, H = 438, FPS = 12, START = 7.9;
const here = import.meta.dirname, out = join(here, '..', '..', 'docs', 'assets', 'amber-why.gif');
const chrome = process.argv[2] || process.env.CHROME || (() => {
  const base = join(homedir(), 'Library/Caches/ms-playwright');
  const d = readdirSync(base).filter(n => n.startsWith('chromium_headless_shell')).sort().pop();
  return join(base, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
})();
const dir = mkdtempSync(join(tmpdir(), 'amber-gif-'));
const p = spawn(chrome, ['--no-sandbox', '--headless', '--remote-debugging-port=9340', 'about:blank'], { stdio: 'ignore' });
try {
  await new Promise(r => setTimeout(r, 1500));
  const tabs = await (await fetch('http://127.0.0.1:9340/json')).json();
  const ws = new WebSocket(tabs.find(t => t.type === 'page').webSocketDebuggerUrl);
  await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map();
  ws.onmessage = m => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d.result); pend.delete(d.id); } };
  const cmd = (method, params = {}) => new Promise(r => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  await cmd('Page.enable');
  await cmd('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
  await cmd('Page.navigate', { url: 'file://' + join(here, 'scene.html') });
  await new Promise(r => setTimeout(r, 1200));
  const L = (await cmd('Runtime.evaluate', { expression: 'L', returnByValue: true })).result.value;
  const n = Math.round(L * FPS);
  for (let i = 0; i < n; i++) {
    // Start on the brand frame, so a still preview (first frame) shows the logo and slogan, then play the story.
    await cmd('Runtime.evaluate', { expression: `render(${((i / FPS) + START) % L})` });
    const r = await cmd('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
    writeFileSync(join(dir, String(i).padStart(4, '0') + '.png'), Buffer.from(r.data, 'base64'));
  }
  ws.close();
  const frames = join(dir, '%04d.png'), pal = join(dir, 'palette.png');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', frames, '-vf', 'palettegen=max_colors=128:stats_mode=full', pal]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(FPS), '-i', frames, '-i', pal, '-lavfi', 'paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', out]);
  console.log(`${n} frames -> ${out}`);
} finally { p.kill(); rmSync(dir, { recursive: true, force: true }); }
process.exit(0);
