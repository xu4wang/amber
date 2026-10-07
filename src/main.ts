import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { AmberBot } from './bot.ts';
import { setServices } from './runner.ts';
import { startApi } from './api.ts';

const cfg = loadConfig();
setServices(cfg.services);
const store = new Store(cfg.dataDir);
const bot = new AmberBot(cfg, store);
await bot.start();
startApi(Number(process.env.AMBER_API_PORT ?? 7341), cfg.machines, bot.flow, () => bot.signer.jwks());
console.log(new Date().toISOString(), 'amber started; data dir', cfg.dataDir);
