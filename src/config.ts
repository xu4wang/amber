import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { validateLinks, type LinkConfig } from './exec-link.ts';

export interface AmberConfig {
  appId: string;
  appSecret: string;
  /** Directory for the SQLite database and logs. */
  dataDir: string;
  /** Reviewer emails (D19). Resolved to union_id at runtime. */
  reviewers: string[];
  /** How many reviewers must approve: every one (default) or any one. A rejection from any reviewer always rejects. */
  reviewPolicy: 'all' | 'any';
  /** Self-use without review: a creator's app that reaches nothing beyond what its creator and their agent already
   *  can goes live after their trial run, for them only. `services` = the services such an app may use (they answer
   *  with the runner's own permissions, as they would the agent). Unset = every app is reviewed. */
  selfUse?: { services: string[] };
  /** Admins: emails (resolved to union_id at runtime) or union_ids ("on_..."). Admins change command scope by chatting with Amber. */
  admins: string[];
  /** Local services scripts may call with an execution identity token (D27). */
  /** executor: scripts running on an executor may call it through Amber's relay (D52). Off unless set.
   *  links: also from link-mode executors (D58), whose machines are outside the network. Off unless set. */
  services: Record<string, { audience: string; tcpPort?: number; unixSocket?: string; executor?: boolean; links?: boolean }>;
  configDir: string;
  /** IP → machine name. Only these addresses may submit drafts (D31). */
  machines: Record<string, string>;
  approval?: { code: string; reviewNodeId: string; formFieldId: string };
  wiki?: { spaceId: string; parentNodeToken: string; baseUrl: string };
  /** Time zones offered for schedules; the first is the default. Empty = the server's own time zone. */
  timezones: { tz: string; label: string }[];
  /** Public address of the website (D34), used in login links. */
  webBaseUrl: string;
  /** Separate origin page apps are served from (their files), e.g. http://pages.amber.example.com. Unset = no page apps. */
  pagesBaseUrl?: string;
  /** A headless Chrome (or chrome-headless-shell) for screenshots on page confirmation cards. Unset = no screenshots. */
  pageScreenshotChrome?: string;
  /** The built-in large-model service (service name "llm", src/llm.ts). Unset = scripts cannot declare llm. */
  llm?: { command: string; models?: string[]; maxConcurrent?: number; timeoutMs?: number; configDir?: string };
  /** Link-mode executors Amber connects to (D58, exec-link.ts). */
  executorLinks?: LinkConfig[];
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
    reviewPolicy: reviewPolicyOf(fileCfg.reviewPolicy),
    ...(fileCfg.selfUse !== undefined ? { selfUse: selfUseOf(fileCfg.selfUse) } : {}),
    admins: Array.isArray(fileCfg.admins) ? fileCfg.admins : [],
    services: fileCfg.services && typeof fileCfg.services === 'object' ? fileCfg.services : {},
    configDir,
    machines: fileCfg.machines && typeof fileCfg.machines === 'object' ? fileCfg.machines : { '127.0.0.1': 'local' },
    approval: fileCfg.approval,
    wiki: fileCfg.wiki,
    timezones: Array.isArray(fileCfg.timezones) ? fileCfg.timezones : [],
    webBaseUrl: String(fileCfg.webBaseUrl ?? `http://localhost:${process.env.AMBER_WEB_PORT ?? 7342}`).replace(/\/$/, ''),
    ...(fileCfg.pagesBaseUrl ? { pagesBaseUrl: String(fileCfg.pagesBaseUrl).replace(/\/$/, '') } : {}),
    ...(fileCfg.pageScreenshotChrome ? { pageScreenshotChrome: String(fileCfg.pageScreenshotChrome) } : {}),
    ...(fileCfg.llm && typeof fileCfg.llm === 'object' && fileCfg.llm.command ? { llm: fileCfg.llm } : {}),
    ...(fileCfg.executorLinks ? { executorLinks: validateLinks(fileCfg.executorLinks) } : {}),
  };
}

function selfUseOf(v: unknown): { services: string[] } {
  const s = (v as { services?: unknown })?.services ?? [];
  if (!v || typeof v !== 'object' || !Array.isArray(s) || s.some(x => typeof x !== 'string')) throw new Error('config.json: selfUse must be {"services": ["服务名", …]}');
  return { services: s as string[] };
}

function reviewPolicyOf(v: unknown): 'all' | 'any' {
  if (v === undefined || v === null || v === 'all') return 'all';
  if (v === 'any') return 'any';
  throw new Error(`config.json: reviewPolicy must be "all" or "any" (got ${JSON.stringify(v)})`);
}
