import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import { ExecutorRegistry } from './executors.ts';
import { AmberBot } from './bot.ts';
import { startApi, machineToken } from './api.ts';
import { join } from 'node:path';
import { homedir } from 'node:os';

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const executors = new ExecutorRegistry(cfg.executorsFile);
const bot = new AmberBot(cfg, store, executors);
await bot.start();
const configDir = process.env.AMBER_CONFIG_DIR ?? join(homedir(), '.config', 'amber');
startApi(Number(process.env.AMBER_API_PORT ?? 7341), machineToken(configDir), bot.flow, executors);
console.log(new Date().toISOString(), 'amber started; data dir', cfg.dataDir);
