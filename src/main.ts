import { loadConfig } from './config.ts';
import { startAmber } from './app.ts';

const cfg = loadConfig();
await startAmber(cfg, { apiPort: Number(process.env.AMBER_API_PORT ?? 7341), webPort: Number(process.env.AMBER_WEB_PORT ?? 7342) });
console.log(new Date().toISOString(), 'amber started; data dir', cfg.dataDir);
