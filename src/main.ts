import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { AmberBot } from './bot.ts';
import { setServices } from './runner.ts';
import { startApi, machineToken } from './api.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';

const cfg = loadConfig();
setServices(cfg.services);
const store = new Store(cfg.dataDir);
const bot = new AmberBot(cfg, store);
await bot.start();
const configDir = process.env.AMBER_CONFIG_DIR ?? join(homedir(), '.config', 'amber');
startApi(Number(process.env.AMBER_API_PORT ?? 7341), machineToken(configDir), bot.flow, () => bot.signer.jwks());
console.log(new Date().toISOString(), 'amber started; data dir', cfg.dataDir);
