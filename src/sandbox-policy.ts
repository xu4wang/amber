// Sandbox policy (D49, D51). Every script runs under macOS Seatbelt with a policy built from:
//   baseline     system + language toolchains readable, so scripts can use external dependencies;
//                credential stores denied (they can be re-opened only by an approved environment)
//   environment  what the environment the command runs in grants (D51): an executor environment's
//                access, approved by an admin with the environment. Commands declare no paths of their own.
//   run          this run's private temp dir (read-write; also the cwd, HOME and TMPDIR)
//   hard denies  Amber's and the executor's own config dirs (keys, database), ~/.ssh and keychains —
//                emitted last, nothing re-opens them
// Model (three tiers, deny by default, the deepest matching rule wins) and the macOS baseline are
// ported from botmux's FsPolicy (src/adapters/cli/fs-policy.ts, MIT License, © botmux contributors),
// narrowed for scripts: no ~/Library, ~/.cache or /private/var/folders grants (HOME is the run dir).
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

export type FsAccess = 'readWrite' | 'readOnly' | 'deny';
export type FsRuleSource = 'baseline' | 'env' | 'run';
export interface FsRule { path: string; access: FsAccess; source: FsRuleSource }
/** An environment's file access (D51). Paths: absolute, ~/… or {WORKDIR}/… (resolved on the executor). */
export interface EnvAccess { readOnly?: string[]; readWrite?: string[]; deny?: string[] }

export const MAX_ACCESS_PATHS = 100;

let CTX = { home: homedir(), configDir: '' };
/** Set once at startup: the home directory and this process's config dir (signing key, secrets key, database / executor keys). */
export function setSandboxContext(c: { home?: string; configDir: string }): void { CTX = { home: c.home ?? homedir(), configDir: c.configDir }; }

/** Never readable or writable, whatever an environment says: Amber's and the executor's own keys, SSH keys, keychains. */
export function hardDenyRoots(home = CTX.home, configDir = CTX.configDir): string[] {
  const h = home;
  return [
    ...(configDir ? [configDir] : []),
    `${h}/.config/amber`, `${h}/.config/amber-executor`,
    `${h}/.ssh`, `${h}/Library/Keychains`, '/Library/Keychains',
  ];
}

/** Credential stores, denied by default. An environment may re-open a path inside them (e.g. a bot's own
 *  lark-cli config); the approval card flags such grants. */
export function credentialRoots(home = CTX.home): string[] {
  const h = home;
  return [
    `${h}/.gnupg`, `${h}/.aws`, `${h}/.azure`, `${h}/.netrc`, `${h}/.git-credentials`,
    `${h}/.npmrc`, `${h}/.pypirc`, `${h}/.docker`, `${h}/.kube`,
    `${h}/.config/gh`, `${h}/.config/glab-cli`, `${h}/.config/gcloud`, `${h}/.config/op`, `${h}/.config/1Password`,
    `${h}/.1password`, `${h}/.password-store`,
    `${h}/.lark-cli`, `${h}/.lark-cli-bots`, `${h}/Library/Application Support/lark-cli`,
    `${h}/.botmux`, `${h}/.config/botmux`, `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`, `${h}/Library/Cookies`,
  ];
}

/** Read-only toolchains and system dirs, so interpreters, packages and CLIs work inside the sandbox. */
function baseline(h: string): FsRule[] {
  const ro = (p: string): FsRule => ({ path: p, access: 'readOnly', source: 'baseline' });
  const deny = (p: string): FsRule => ({ path: p, access: 'deny', source: 'baseline' });
  return [
    ro('/System'), ro('/usr'), ro('/bin'), ro('/sbin'), ro('/Library'), ro('/opt'),
    ro('/private/etc'), ro('/private/var/select'), ro('/private/var/db/timezone'), ro('/private/var/run'),
    { path: '/dev', access: 'readWrite', source: 'baseline' },
    // Language toolchains / version managers commonly under $HOME (read + exec, never write).
    ...['.fnm', '.nvm', '.volta', '.npm-global', '.nodenv', '.yarn', '.pnpm', '.bun', '.deno',
      '.pyenv', 'Library/Python', '.local/lib', '.local/bin', '.pipx', '.rbenv', '.rvm', '.gem',
      'perl5', '.cargo', '.rustup', 'go', '.gvm', '.goenv', '.sdkman', '.jenv', '.m2', '.gradle',
      '.asdf', '.mise', '.plenv'].map(d => ro(`${h}/${d}`)),
    // Publish / registry tokens that live inside the trees above.
    deny(`${h}/.cargo/credentials`), deny(`${h}/.cargo/credentials.toml`), deny(`${h}/.gem/credentials`),
    deny(`${h}/.m2/settings.xml`), deny(`${h}/.m2/settings-security.xml`), deny(`${h}/.gradle/gradle.properties`),
    // Credential stores: denied here at their own depth, so a deeper environment grant can re-open one file or dir.
    ...credentialRoots(h).map(deny),
  ];
}

const within = (p: string, root: string) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The environment's directory (D50): `{WORKDIR}` or `{WORKDIR}/…` in an environment's access paths. */
export const WORKDIR_VAR = '{WORKDIR}';
export const usesWorkdir = (raw: string) => raw.trim() === WORKDIR_VAR || raw.trim().startsWith(WORKDIR_VAR + '/');

/** Expands ~ (and {WORKDIR} when given) and normalizes; throws on anything that is not an absolute path. */
export function normalizePath(raw: string, home = CTX.home, workdir?: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('路径不能为空');
  let p = raw.trim();
  if (usesWorkdir(p)) {
    if (!workdir) throw new Error(`${WORKDIR_VAR} 只能用在环境定义里`);
    p = workdir + p.slice(WORKDIR_VAR.length);
  }
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  if (!p.startsWith('/')) throw new Error(`路径必须是绝对路径（或 ~/、{WORKDIR}/ 开头）：${raw}`);
  if (/[\0\n\r]/.test(p)) throw new Error(`路径含有非法字符：${raw}`);
  p = posix.normalize(p);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Checks an environment's access and returns it with every path resolved to an absolute path
 *  (~ and {WORKDIR} expanded). Throws with a message for the person setting up the environment. */
export function validateEnvAccess(x: unknown, opt: { workdir?: string; home?: string } = {}): EnvAccess {
  const home = opt.home ?? CTX.home;
  if (x === undefined || x === null) return {};
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error('access 要写成 {"readOnly": [...], "readWrite": [...], "deny": [...]}');
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['readOnly', 'readWrite', 'deny'].includes(k)) throw new Error(`access 里不认识的字段：${k}（只能是 readOnly / readWrite / deny）`);
  const out: EnvAccess = {};
  let n = 0;
  const hard = hardDenyRoots(home);
  for (const k of ['readOnly', 'readWrite', 'deny'] as const) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k])) throw new Error(`access.${k} 要写成路径数组`);
    const list: string[] = [];
    for (const raw of o[k] as unknown[]) {
      if (/(^|\/)\.\.(\/|$)/.test(String(raw))) throw new Error(`路径不能含 ..：${raw}`);
      const p = normalizePath(String(raw), home, opt.workdir);
      if (k !== 'deny' && p === '/') throw new Error('不能开放整个根目录');
      const hit = hard.find(r => within(p, r) || within(r, p));
      if (hit && k !== 'deny') throw new Error(`不能开放 ${raw}：它就是或包含受保护的目录 ${hit.replace(home, '~')}（密钥、SSH、钥匙串）`);
      list.push(p);
    }
    n += list.length;
    if (list.length) out[k] = [...new Set(list)];
  }
  if (n > MAX_ACCESS_PATHS) throw new Error(`一个环境最多 ${MAX_ACCESS_PATHS} 条路径`);
  return out;
}

/** Grants that re-open something inside a credential store (shown as a warning on the approval card). */
export function credentialGrants(a: EnvAccess, home = CTX.home): string[] {
  const roots = credentialRoots(home);
  return [...(a.readWrite ?? []), ...(a.readOnly ?? [])].filter(p => roots.some(r => within(p, r) || within(r, p)));
}

/** Real path when it exists (Seatbelt matches resolved paths: /tmp → /private/tmp), else the path itself. */
function canonical(p: string): string {
  try { if (existsSync(p)) return realpathSync(p); } catch { /* keep as is */ }
  for (const [a, b] of [['/tmp', '/private/tmp'], ['/var', '/private/var'], ['/etc', '/private/etc']]) if (within(p, a)) return b + p.slice(a.length);
  return p;
}

const depth = (p: string) => (p === '/' ? 0 : p.split('/').length - 1);
const RESTRICT: Record<FsAccess, number> = { readWrite: 0, readOnly: 1, deny: 2 };

export interface Policy { rules: FsRule[]; mandatory: string[] }

/** All rules for one run, sorted shallow → deep (same depth: less restrictive first), hard denies separate (emitted last).
 *  `access` must already be validated (absolute paths). */
export function buildPolicy(o: { runDir: string; access?: EnvAccess; home?: string; configDir?: string }): Policy {
  const home = o.home ?? CTX.home;
  const rules: FsRule[] = [...baseline(home)];
  for (const k of ['readOnly', 'readWrite', 'deny'] as const) {
    for (const p of o.access?.[k] ?? []) rules.push({ path: p, access: k, source: 'env' });
  }
  rules.push({ path: o.runDir, access: 'readWrite', source: 'run' });
  const seen = new Map<string, FsRule>();
  for (const r of rules) {
    const c = { ...r, path: canonical(r.path) };
    const prev = seen.get(c.path);
    // Same path twice: the more restrictive wins — except that an environment rule beats a baseline rule
    // at the same path (an approved environment re-opening, or closing, exactly that path).
    const envOverBaseline = prev && prev.source !== c.source && (c.source === 'env' || prev.source === 'env') && (prev.source === 'baseline' || c.source === 'baseline');
    if (!prev) seen.set(c.path, c);
    else if (envOverBaseline) { if (c.source === 'env') seen.set(c.path, c); }
    else if (RESTRICT[c.access] > RESTRICT[prev.access]) seen.set(c.path, c);
  }
  const sorted = [...seen.values()].sort((a, b) => depth(a.path) - depth(b.path) || RESTRICT[a.access] - RESTRICT[b.access] || (a.path < b.path ? -1 : 1));
  const mandatory = [...new Set(hardDenyRoots(home, o.configDir ?? CTX.configDir).map(canonical))];
  return { rules: sorted, mandatory };
}

const esc = (p: string) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Every strict ancestor of every non-deny path: stat/readlink only (literal), never listing. */
function ancestors(rules: FsRule[]): string[] {
  const out = new Set<string>();
  for (const r of rules) {
    if (r.access === 'deny') continue;
    for (let p = r.path; p !== '/';) { p = p.slice(0, p.lastIndexOf('/')) || '/'; out.add(p); }
  }
  return [...out].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
}

/** Seatbelt profile. Network: none, everything, or only the declared local services. */
export function compileToSeatbelt(policy: Policy, net: { all: boolean; tcpPorts?: number[]; unixSockets?: string[] }): string {
  const lines = [
    '(version 1)',
    '(deny default)',
    '(import "/System/Library/Sandbox/Profiles/bsd.sb")',
    '(allow process*)', '(allow signal)', '(allow mach*)', '(allow ipc*)', '(allow sysctl*)', '(allow file-ioctl)', '(allow iokit-open)',
  ];
  if (net.all) lines.push('(allow network*)', '(allow system-socket)');
  else if (net.tcpPorts?.length || net.unixSockets?.length) {
    for (const p of net.tcpPorts ?? []) lines.push(`(allow network-outbound (remote ip "localhost:${Number(p)}"))`);
    for (const s of net.unixSockets ?? []) lines.push(`(allow network-outbound (literal "${esc(s)}"))`);
    lines.push('(allow system-socket)');
  }
  for (const r of policy.rules) {
    const p = esc(r.path);
    if (r.access === 'deny') { lines.push(`(deny file-read* (subpath "${p}"))`, `(deny file-write* (subpath "${p}"))`); continue; }
    lines.push(`(allow file-read* (subpath "${p}"))`);
    lines.push(r.access === 'readWrite' ? `(allow file-write* (subpath "${p}"))` : `(deny file-write* (subpath "${p}"))`);
  }
  for (const p of ancestors(policy.rules)) lines.push(`(allow file-read-metadata (literal "${esc(p)}"))`);
  // Last: Seatbelt applies the last matching rule, so these win over any grant above.
  for (const m of policy.mandatory) lines.push(`(deny file-read* (subpath "${esc(m)}"))`, `(deny file-write* (subpath "${esc(m)}"))`);
  return lines.join('\n') + '\n';
}

/** One line for cards and review documents. */
export function describeAccess(a?: EnvAccess, home = CTX.home): string {
  if (!a) return '';
  const show = (l?: string[]) => (l ?? []).map(p => p.replace(home, '~')).join('、');
  return [a.readWrite?.length ? `读写 ${show(a.readWrite)}` : '', a.readOnly?.length ? `只读 ${show(a.readOnly)}` : '', a.deny?.length ? `禁止 ${show(a.deny)}` : ''].filter(Boolean).join('；');
}
