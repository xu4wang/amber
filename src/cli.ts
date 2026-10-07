// Operator CLI. Until the claim/review flow exists, operators can register an
// already-reviewed command directly. Every such action is written to the audit log.
import { readFileSync } from 'node:fs';
import { loadConfig } from './config.ts';
import { Store } from './db.ts';
import type { ParamDef, Script, ScopeType } from './db.ts';

const [, , cmd, ...rest] = process.argv;
const cfg = loadConfig();
const store = new Store(cfg.dataDir);

function usage(): never {
  console.error(`usage:
  amber cli list
  amber cli add <command.json>     # { scopeType, chatId, ownerUnionId, name, description, params, script, sideEffect }
  amber cli retire <id>
  amber cli submit <draft.json>    # submit a draft to the running service (prints the claim info)`);
  process.exit(2);
}

if (cmd === 'list') {
  for (const c of store.listAll()) console.log(`${c.id}  ${c.status.padEnd(8)} ${c.scopeType.padEnd(5)} ${c.chatId}  ${c.name}`);
} else if (cmd === 'add') {
  if (!rest[0]) usage();
  const j = JSON.parse(readFileSync(rest[0], 'utf8')) as {
    scopeType: ScopeType; chatId: string; ownerUnionId: string; name: string; description?: string;
    params: ParamDef[]; script: Script; sideEffect: 'read' | 'write';
  };
  const row = store.insertCommand({ ...j, description: j.description ?? '', status: 'active' });
  store.audit(null, 'operator.add_active', { id: row.id, name: row.name, chatId: row.chatId, specHash: row.specHash });
  console.log('added', row.id, row.name);
} else if (cmd === 'retire') {
  if (!rest[0]) usage();
  store.setStatus(rest[0], 'retired');
  store.audit(null, 'operator.retire', { id: rest[0] });
  console.log('retired', rest[0]);
} else if (cmd === 'submit') {
  const { machineToken } = await import('./api.ts');
  const { join } = await import('node:path');
  const { homedir } = await import('node:os');
  const token = machineToken(process.env.AMBER_CONFIG_DIR ?? join(homedir(), '.config', 'amber'));
  const base = `http://127.0.0.1:${process.env.AMBER_API_PORT ?? 7341}`;
  const r = await fetch(`${base}/v1/drafts`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: readFileSync(rest[0] ?? usage(), 'utf8') });
  console.log(r.status, JSON.stringify(await r.json(), null, 2));
  if (!r.ok) process.exit(1);
} else {
  usage();
}
