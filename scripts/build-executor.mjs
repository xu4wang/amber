// Generates client/amber-executor/lib/*.mjs from the Amber sources the executor shares (D50): the
// protocol, the sandbox policy and the sandboxed run. Types are stripped; nothing else changes, so
// Amber and the executor enforce the same rules. `--check` fails when the generated files are stale.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARED = ['exec-proto', 'sandbox-policy', 'sandbox-run', 'egress-proxy'];
const check = process.argv.includes('--check');
let stale = [];
for (const name of SHARED) {
  const src = readFileSync(join(root, 'src', `${name}.ts`), 'utf8');
  for (const m of src.matchAll(/from '(\.[^']+)'/g)) if (!SHARED.some(s => m[1] === `./${s}.ts`)) throw new Error(`${name}.ts imports ${m[1]}, which the executor does not have`);
  const js = `// GENERATED from src/${name}.ts by scripts/build-executor.mjs — do not edit.\n` +
    stripTypeScriptTypes(src, { mode: 'strip' }).replace(/from '\.\/([a-z-]+)\.ts'/g, "from './$1.mjs'");
  const out = join(root, 'client', 'amber-executor', 'lib', `${name}.mjs`);
  if (check) { if (!existsSync(out) || readFileSync(out, 'utf8') !== js) stale.push(out); }
  else writeFileSync(out, js);
}
if (stale.length) { console.error('stale, run: node scripts/build-executor.mjs\n' + stale.join('\n')); process.exit(1); }
