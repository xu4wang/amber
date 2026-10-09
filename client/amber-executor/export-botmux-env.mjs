#!/usr/bin/env node
// Exports a botmux bot's data access as an Amber environment definition (D51), so scripts in that
// environment can access exactly what the bot's agent can in its botmux sandbox — no more. The
// executor only reads the definition file and knows nothing about botmux; this script is the adapter.
//
//   node export-botmux-env.mjs --bot <appId> [--name <env>] [--python <path>] [--readonly] [--bots-json <path>] > env.json
//   node amber-executor.mjs env import env.json
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
// --readonly turns every data grant read-only (the lark-cli config stays writable: lark-cli refreshes tokens there).
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const die = m => { console.error(`export-botmux-env: ${m}`); process.exit(1); };
const H = homedir();

const appId = flag('--bot');
if (!appId || !/^[A-Za-z0-9_-]+$/.test(appId)) die('用 --bot <appId> 指定机器人，例如 --bot cli_xxx');
const botsPath = flag('--bots-json') ?? join(H, '.botmux', 'bots.json');
let raw;
try { raw = JSON.parse(readFileSync(botsPath, 'utf8')); } catch (e) { die(`读不了 ${botsPath}：${e.message}`); }
const bots = Array.isArray(raw) ? raw : raw?.bots ?? [];
const bot = bots.find(b => b?.larkAppId === appId);
if (!bot) die(`${botsPath} 里没有机器人 ${appId}`);

const isDir = p => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } };
const exists = p => existsSync(p);
const sp = bot.sandboxPaths ?? {};
const list = v => (Array.isArray(v) ? v.map(String) : []);
const workdir = bot.workingDir ? String(bot.workingDir) : '';
if (!workdir) die(`机器人 ${appId} 没有配置 workingDir`);

const botHome = join(H, '.botmux', 'bots', appId);
const roleSubtree = join(H, 'botmux-roles', appId);
const larkDir = join(H, '.lark-cli-bots', appId);
const larkStore = join(H, 'Library', 'Application Support', 'lark-cli');

const dataRw = [workdir, ...list(sp.readWrite), ...(isDir(botHome) ? [botHome] : []), ...(isDir(roleSubtree) ? [roleSubtree] : [])];
const readonly = args.includes('--readonly');
const readWrite = [...(readonly ? [] : dataRw), ...(isDir(larkDir) ? [larkDir] : [])];
const readOnly = [...(readonly ? dataRw : []), ...list(sp.readOnly),
  ...(process.platform === 'darwin' ? [join(larkStore, 'master.key.file'), join(larkStore, `appsecret_${appId}.enc`)].filter(exists) : [])];
const deny = [...list(sp.deny), join(botHome, 'send-cred.json')];

const uniq = a => [...new Set(a)];
const def = {
  name: flag('--name') ?? appId,
  workdir,
  ...(flag('--python') ? { python: flag('--python') } : {}),
  access: { readWrite: uniq(readWrite), readOnly: uniq(readOnly), deny: uniq(deny) },
  ...(isDir(larkDir) ? { vars: { LARKSUITE_CLI_CONFIG_DIR: larkDir } } : {}),
  realHome: true,
  source: `botmux:${appId}${readonly ? '（只读）' : ''}`,
};
process.stdout.write(JSON.stringify(def, null, 2) + '\n');
