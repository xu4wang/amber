#!/usr/bin/env node
// Exports a botmux bot's data access as an Amber environment definition (D51), so scripts in that
// environment can access exactly what the bot's agent can in its botmux sandbox — no more. The
// executor only reads the definition file and knows nothing about botmux; this script is the adapter.
//
//   node export-botmux-env.mjs --bot <appId> [--name <env>] [--python <path>] [--readonly] [--allow-hosts a,b] [--bots-json <path>] > env.json
//   node amber-executor.mjs env import env.json
//
// Following botmux (D53): write the definition to a file, keep it current, and let the executor follow that file.
//   node export-botmux-env.mjs --bot <appId> … --out <file>      writes <file> only when the definition changed
//   node export-botmux-env.mjs --bot <appId> … --out <file> --install-launchd
//                                                               the same, every 5 minutes (launchd); --uninstall-launchd removes it
//   node amber-executor.mjs env follow <file>
// The executor only reads the file; it does not know botmux. This script is the botmux adapter.
//
// What it includes (mirrors botmux's FsPolicy for that bot, src/adapters/cli/fs-policy.ts):
//   read-write  the bot's workingDir, bots.json sandboxPaths.readWrite, its BOT_HOME (~/.botmux/bots/<appId>),
//               its role-library subtree (~/botmux-roles/<appId>), its lark-cli config (~/.lark-cli-bots/<appId>)
//   read-only   sandboxPaths.readOnly; on macOS its own lark-cli app secret + the store's master key (not any
//               other bot's)
//   deny        sandboxPaths.deny; BOT_HOME/send-cred.json (botmux's send credential: a script must not post as
//               the bot behind Amber's back)
//   variables   LARKSUITE_CLI_CONFIG_DIR, so lark-cli in a script uses the bot's own identity, as in its sessions
//   HOME        the user's real home, as in the bot's sessions (lark-cli finds its key store under $HOME/Library);
//               only the paths above are reachable there
//   allowHosts  only with --allow-hosts a,b: extra hosts for this environment. Feishu (lark-cli) is on Amber's global
//               list, which every environment gets
// --readonly turns every data grant read-only (the lark-cli config stays writable: lark-cli refreshes tokens there).
import { readFileSync, existsSync, lstatSync, writeFileSync, renameSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const die = m => { console.error(`export-botmux-env: ${m}`); process.exit(1); };
const H = homedir();

const appId = flag('--bot');
if (!appId || !/^[A-Za-z0-9_-]+$/.test(appId)) die('用 --bot <appId> 指定机器人，例如 --bot cli_xxx');
const botsPath = flag('--bots-json') ?? join(H, '.botmux', 'bots.json');
let raw;
try { raw = JSON.parse(readFileSync(botsPath, 'utf8')); } catch (e) { die(`读不了 ${botsPath}：${e.message}`); }
// bots.json is a list of bot entries; also accept { bots: [...] } and an object keyed by appId.
let bots;
if (Array.isArray(raw)) bots = raw;
else if (Array.isArray(raw?.bots)) bots = raw.bots;
else if (raw && typeof raw === 'object' && Object.values(raw).every(v => v && typeof v === 'object' && 'larkAppId' in v)) bots = Object.values(raw);
else die(`${botsPath} 的格式不认识（应该是机器人配置的数组）`);
const bot = bots.find(b => b?.larkAppId === appId);
if (!bot) die(`${botsPath} 里没有机器人 ${appId}`);

const isDir = p => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const exists = p => existsSync(p);
const sp = bot.sandboxPaths ?? {};
const expand = p => (p === '~' || p.startsWith('~/') ? H + p.slice(1) : p);
const list = v => (Array.isArray(v) ? v.map(String).map(expand) : []);

const botHome = join(H, '.botmux', 'bots', appId);
// The bot's working directory. Missing, or the whole home directory: an environment can never open all of
// home (it holds ~/.ssh and the executor's own keys), so the bot's role library (or BOT_HOME) stands in as
// WORKDIR and the home directory itself is not granted. The definition says so in its source.
const rawWd = bot.workingDir ? expand(String(bot.workingDir)).replace(/\/+$/, '') : '';
const homeLike = !rawWd || rawWd === H;

const roleSubtree = join(H, 'botmux-roles', appId);
const larkDir = join(H, '.lark-cli-bots', appId);
const larkStore = join(H, 'Library', 'Application Support', 'lark-cli');

const workdir = homeLike ? (isDir(roleSubtree) ? roleSubtree : botHome) : rawWd;
if (!isDir(workdir)) die(`机器人 ${appId} 没有可用的工作目录（workingDir、角色库、机器人目录都不存在）`);
const dataRw = [...(homeLike ? [] : [workdir]), ...list(sp.readWrite).filter(p => p !== H), ...(isDir(botHome) ? [botHome] : []), ...(isDir(roleSubtree) ? [roleSubtree] : [])];
const readonly = args.includes('--readonly');
const readWrite = [...(readonly ? [] : dataRw), ...(isDir(larkDir) ? [larkDir] : [])];
const readOnly = [...(readonly ? dataRw : []), ...list(sp.readOnly),
  ...(process.platform === 'darwin' ? [join(larkStore, 'master.key.file'), join(larkStore, `appsecret_${appId}.enc`)].filter(exists) : [])];
const deny = [...list(sp.deny), join(botHome, 'send-cred.json')];

const uniq = a => [...new Set(a)];
const allowHosts = flag('--allow-hosts') ? flag('--allow-hosts').split(',').map(s => s.trim()).filter(Boolean) : [];
const def = {
  format: 'amber-env/1',
  name: flag('--name') ?? appId,
  workdir,
  ...(flag('--python') ? { python: flag('--python') } : {}),
  access: { readWrite: uniq(readWrite), readOnly: uniq(readOnly), deny: uniq(deny) },
  ...(isDir(larkDir) ? { vars: { LARKSUITE_CLI_CONFIG_DIR: larkDir } } : {}),
  ...(allowHosts.length ? { allowHosts } : {}),
  realHome: true,
  source: `botmux:${appId}${readonly ? '（只读）' : ''}${homeLike ? '（workingDir 是主目录或未配置，未开放整个主目录）' : ''}`,
};
const text = JSON.stringify(def, null, 2) + '\n';
const out = flag('--out');
const label = `com.amber.botmux-env.${appId}`;
const plist = join(H, 'Library', 'LaunchAgents', `${label}.plist`);
const domain = `gui/${process.getuid()}`;
if (args.includes('--uninstall-launchd')) {
  try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
  if (existsSync(plist)) unlinkSync(plist);
  console.log('已停止并移除', label);
} else if (!out) {
  process.stdout.write(text);
} else {
  const file = resolve(out);
  // Only when the definition changed, atomically: the executor re-reads this file and re-registers on change.
  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, text, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
    console.log(new Date().toISOString(), 'updated', file);
  }
  if (args.includes('--install-launchd')) {
    const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const node = ['/opt/homebrew/bin/node', '/usr/local/bin/node'].find(p => { try { return realpathSync(p) === realpathSync(process.execPath); } catch { return false; } }) ?? process.execPath;
    const keep = [];
    for (const f of ['--bot', '--name', '--python', '--bots-json', '--allow-hosts']) if (flag(f)) keep.push(f, flag(f));
    if (args.includes('--readonly')) keep.push('--readonly');
    keep.push('--out', file);
    const argv = [node, fileURLToPath(import.meta.url), ...keep].map(a => `<string>${esc(a)}</string>`).join('');
    try { execFileSync('launchctl', ['bootout', `${domain}/${label}`], { stdio: 'ignore' }); } catch { /* not loaded */ }
    for (let i = 0; i < 50; i++) { try { execFileSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' }); } catch { break; } execFileSync('sleep', ['0.2']); }
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${argv}</array>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${esc(file)}.log</string>
  <key>StandardErrorPath</key><string>${esc(file)}.log</string>
</dict></plist>
`);
    execFileSync('launchctl', ['bootstrap', domain, plist]);
    console.log(`已安装：每 5 分钟导出一次到 ${file}（${plist}）。在执行端上运行 env follow ${file} 跟随它。`);
  }
}
