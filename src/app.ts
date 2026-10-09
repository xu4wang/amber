// Wires Amber together. main.ts runs it for real; tests run it with a fake Feishu client.
import type { Server } from 'node:http';
import type { AmberConfig } from './config.ts';
import { Store } from './db.ts';
import { AmberBot } from './bot.ts';
import { setServices, validateScript } from './runner.ts';
import { setSandboxContext } from './sandbox-policy.ts';
import { startApi } from './api.ts';
import { startWeb } from './web.ts';
import { setTimezones } from './schedule-rule.ts';
import { SecretVault } from './secrets.ts';
import { setSecretVault, setExecutorHub } from './engine.ts';
import { ExecutorHub } from './executors.ts';

export interface Amber { bot: AmberBot; store: Store; api: Server; web: Server; hub: ExecutorHub; close(): Promise<void> }

export async function startAmber(cfg: AmberConfig, opts: { apiPort: number; webPort: number; client?: unknown; ws?: unknown; timers?: boolean }): Promise<Amber> {
  setServices(cfg.services);
  setSandboxContext({ configDir: cfg.configDir });
  setTimezones(cfg.timezones);
  const store = new Store(cfg.dataDir);
  setSecretVault(new SecretVault(store, cfg.configDir));
  // Fail closed and say so: these commands stay in the database but every run is refused (D40/D41).
  const interrupted = store.failInterruptedRuns();
  if (interrupted.length) { console.warn(new Date().toISOString(), 'interrupted runs marked failed', interrupted); store.audit(null, 'startup.interrupted_runs', { runs: interrupted }); }
  for (const u of store.listInvalidScripts(validateScript)) {
    console.warn(new Date().toISOString(), 'command cannot run', u);
    store.audit(null, 'startup.unrunnable', u);
  }
  const bot = new AmberBot(cfg, store, { client: opts.client, ws: opts.ws, timers: opts.timers });
  await bot.start();
  const hub = bot.hub;
  setExecutorHub(hub);
  const api = startApi(opts.apiPort, cfg.machines, bot.flow, bot.agent, () => bot.signer.jwks(), { webUrl: cfg.webBaseUrl }, hub);
  const web = startWeb(opts.webPort, store, {
    isMember: (c, u) => bot.isMember(c, u),
    chatName: c => bot.chatName(c),
    nameOf: u => bot.nameOf(u),
    onLoginUsed: (m, at) => bot.onLoginUsed(m, at),
    feishuChatLink: `https://applink.feishu.cn/client/bot/open?appId=${cfg.appId}`,
    cityOf: u => bot.cityOf(u),
    signer: bot.signer,
    scheduler: bot.scheduler,
    origin: new URL(cfg.webBaseUrl).origin,
    retire: (id, actor, by) => bot.retire(id, actor, by),
    isAdmin: u => bot.isAdminPublic(u),
  });
  const closeServer = (s: Server) => new Promise<void>(r => { s.close(() => r()); s.closeAllConnections(); });
  return { bot, store, api, web, hub, close: async () => { hub.close(); await Promise.all([closeServer(api), closeServer(web)]); } };
}
