// Wires Amber together. main.ts runs it for real; tests run it with a fake Feishu client.
import type { Server } from 'node:http';
import type { AmberConfig } from './config.ts';
import { Store } from './db.ts';
import { AmberBot } from './bot.ts';
import { setServices } from './runner.ts';
import { startApi } from './api.ts';
import { startWeb } from './web.ts';
import { setTimezones } from './schedule-rule.ts';

export interface Amber { bot: AmberBot; store: Store; api: Server; web: Server; close(): Promise<void> }

export async function startAmber(cfg: AmberConfig, opts: { apiPort: number; webPort: number; client?: unknown; ws?: unknown; timers?: boolean }): Promise<Amber> {
  setServices(cfg.services);
  setTimezones(cfg.timezones);
  const store = new Store(cfg.dataDir);
  const bot = new AmberBot(cfg, store, { client: opts.client, ws: opts.ws, timers: opts.timers });
  await bot.start();
  const api = startApi(opts.apiPort, cfg.machines, bot.flow, bot.agent, () => bot.signer.jwks(), { webUrl: cfg.webBaseUrl });
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
  return { bot, store, api, web, close: async () => { await Promise.all([closeServer(api), closeServer(web)]); } };
}
