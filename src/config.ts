import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface AmberConfig {
  appId: string;
  appSecret: string;
  /** Directory for the SQLite database and logs. */
  dataDir: string;
  /** Reviewer emails (D19). Resolved to union_id at runtime. */
  reviewers: string[];
  /** Admins: emails (resolved to union_id at runtime) or union_ids ("on_..."). Admins change command scope by chatting with Amber. */
  admins: string[];
  /** Local services scripts may call with an execution identity token (D27). */
  services: Record<string, { audience: string; tcpPort?: number; unixSocket?: string }>;
  configDir: string;
  /** IP → machine name. Only these addresses may submit drafts (D31). */
  machines: Record<string, string>;
  approval?: { code: string; reviewNodeId: string; formFieldId: string };
  wiki?: { spaceId: string; parentNodeToken: string; baseUrl: string };
  /** Public address of the website (D34), used in login links. */
  webBaseUrl: string;
}

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}

export function loadConfig(): AmberConfig {
  const configDir = process.env.AMBER_CONFIG_DIR ?? join(homedir(), '.config', 'amber');
  const env = { ...parseEnvFile(join(configDir, 'lark-app.env')), ...process.env };
  const fileCfgPath = join(configDir, 'config.json');
  const fileCfg = existsSync(fileCfgPath) ? JSON.parse(readFileSync(fileCfgPath, 'utf8')) : {};
  const appId = env.AMBER_LARK_APP_ID;
  const appSecret = env.AMBER_LARK_APP_SECRET;
  if (!appId || !appSecret) {
    throw new Error(`missing AMBER_LARK_APP_ID / AMBER_LARK_APP_SECRET (looked in ${configDir}/lark-app.env and the environment)`);
  }
  const dataDir = fileCfg.dataDir ?? join(configDir, 'data');
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  return {
    appId,
    appSecret,
    dataDir,
    reviewers: Array.isArray(fileCfg.reviewers) ? fileCfg.reviewers : [],
    admins: Array.isArray(fileCfg.admins) ? fileCfg.admins : [],
    services: fileCfg.services && typeof fileCfg.services === 'object' ? fileCfg.services : {},
    configDir,
    machines: fileCfg.machines && typeof fileCfg.machines === 'object' ? fileCfg.machines : { '127.0.0.1': 'local' },
    approval: fileCfg.approval,
    wiki: fileCfg.wiki,
    webBaseUrl: String(fileCfg.webBaseUrl ?? `http://localhost:${process.env.AMBER_WEB_PORT ?? 7342}`).replace(/\/$/, ''),
  };
}
