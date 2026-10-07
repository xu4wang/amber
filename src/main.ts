import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { AmberBot } from './bot.ts';
import { setServices } from './runner.ts';
import { startApi } from './api.ts';
import { startWeb } from './web.ts';

const cfg = loadConfig();
setServices(cfg.services);
const store = new Store(cfg.dataDir);
const bot = new AmberBot(cfg, store);
await bot.start();
startApi(Number(process.env.AMBER_API_PORT ?? 7341), cfg.machines, bot.flow, bot.agent, () => bot.signer.jwks());
startWeb(Number(process.env.AMBER_WEB_PORT ?? 7342), store, {
  isMember: (c, u) => bot.isMember(c, u),
  chatName: c => bot.chatName(c),
  nameOf: u => bot.nameOf(u),
  onLoginUsed: (m, at) => bot.onLoginUsed(m, at),
  feishuChatLink: `https://applink.feishu.cn/client/bot/open?appId=${cfg.appId}`,
});
console.log(new Date().toISOString(), 'amber started; data dir', cfg.dataDir);
