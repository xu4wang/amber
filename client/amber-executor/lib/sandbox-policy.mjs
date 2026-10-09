// GENERATED from src/sandbox-policy.ts by scripts/build-executor.mjs — do not edit.
// App sandbox policy (D49). Every script runs under macOS Seatbelt with a policy built from:
//   baseline   system + language toolchains readable, so scripts can use external dependencies
//   app        what the command declares in script.sandbox (reviewed with the code)
//   run        this run's private temp dir (read-write; also the cwd and TMPDIR)
//   mandatory  credentials and Amber's own keys — denied last, nothing can re-open them
// Model (three tiers, deny by default, the deepest matching rule wins) and the macOS baseline are
// ported from botmux's FsPolicy (src/adapters/cli/fs-policy.ts, MIT License, © botmux contributors),
// narrowed for scripts: no ~/Library, ~/.cache or /private/var/folders grants (HOME is the run dir).
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

                                                         
                                                                    
                                                                                
/** script.sandbox as submitted: absolute paths or ~/… paths. */
                                                                                          

export const MAX_SANDBOX_PATHS = 50;

let CTX = { home: homedir(), configDir: '' };
/** Set once at startup: the home directory and Amber's config dir (signing key, secrets key, database). */
export function setSandboxContext(c                                      )       { CTX = { home: c.home ?? homedir(), configDir: c.configDir }; }

/** Credentials and Amber's own keys. Denied after everything else; declaring them is refused at submit time. */
export function mandatoryDenyRoots(home = CTX.home, configDir = CTX.configDir)           {
  const h = home;
  return [
    ...(configDir ? [configDir] : []),
    // Amber's and the executor's default config dirs, whichever process this is.
    `${h}/.config/amber`, `${h}/.config/amber-executor`,
    `${h}/.ssh`, `${h}/.gnupg`, `${h}/.aws`, `${h}/.azure`, `${h}/.netrc`, `${h}/.git-credentials`,
    `${h}/.npmrc`, `${h}/.pypirc`, `${h}/.docker`, `${h}/.kube`,
    `${h}/.config/gh`, `${h}/.config/glab-cli`, `${h}/.config/gcloud`, `${h}/.config/op`, `${h}/.config/1Password`,
    `${h}/.1password`, `${h}/.password-store`,
    `${h}/.lark-cli`, `${h}/.lark-cli-bots`, `${h}/Library/Application Support/lark-cli`,
    `${h}/.botmux`, `${h}/.config/botmux`, `${h}/.claude`, `${h}/.claude.json`, `${h}/.codex`,
    `${h}/Library/Keychains`, `${h}/Library/Cookies`, '/Library/Keychains',
  ];
}

/** Read-only toolchains and system dirs, so interpreters, packages and CLIs work inside the sandbox. */
function baseline(h        )           {
  const ro = (p        )         => ({ path: p, access: 'readOnly', source: 'baseline' });
  const deny = (p        )         => ({ path: p, access: 'deny', source: 'baseline' });
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
  ];
}

const within = (p        , root        ) => p === root || p.startsWith(root === '/' ? '/' : `${root}/`);

/** The executor's per-environment directory (D50): `{WORKDIR}` or `{WORKDIR}/…` in a sandbox path. */
export const WORKDIR_VAR = '{WORKDIR}';
export const usesWorkdir = (raw        ) => raw.trim() === WORKDIR_VAR || raw.trim().startsWith(WORKDIR_VAR + '/');

/** Expands ~ (and {WORKDIR} when given) and normalizes; throws on anything that is not an absolute path. */
export function normalizePath(raw        , home = CTX.home, workdir         )         {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('沙箱路径不能为空');
  let p = raw.trim();
  if (usesWorkdir(p)) {
    if (!workdir) throw new Error(`${WORKDIR_VAR} 只能用在执行端上运行的指令里（要声明 env）`);
    p = workdir + p.slice(WORKDIR_VAR.length);
  }
  if (p === '~' || p.startsWith('~/')) p = home + p.slice(1);
  if (!p.startsWith('/')) throw new Error(`沙箱路径必须是绝对路径（或 ~/ 开头）：${raw}`);
  if (/[\0\n\r]/.test(p)) throw new Error(`沙箱路径含有非法字符：${raw}`);
  p = posix.normalize(p);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Checks a submitted script.sandbox. Returns it with paths as written (trimmed), or throws with a message for the submitter.
 *  `remote`: the command runs on an executor, so {WORKDIR} paths are allowed; they are checked against the
 *  protected dirs on the executor once the directory is known (`workdir`). */
export function validateAppSandbox(x         , opt                                         = {})                         {
  if (x === undefined || x === null) return undefined;
  if (typeof x !== 'object' || Array.isArray(x)) throw new Error('sandbox 要写成 {"readOnly": [...], "readWrite": [...], "deny": [...]}');
  const o = x                           ;
  for (const k of Object.keys(o)) if (!['readOnly', 'readWrite', 'deny'].includes(k)) throw new Error(`sandbox 里不认识的字段：${k}（只能是 readOnly / readWrite / deny；联网用 network 字段）`);
  const out             = {};
  let n = 0;
  const roots = mandatoryDenyRoots();
  for (const k of ['readOnly', 'readWrite', 'deny']         ) {
    if (o[k] === undefined) continue;
    if (!Array.isArray(o[k])) throw new Error(`sandbox.${k} 要写成路径数组`);
    const list = (o[k]             ).map(v => String(v).trim());
    for (const raw of list) {
      if (usesWorkdir(raw) && !opt.workdir) {
        if (!opt.remote) throw new Error(`${WORKDIR_VAR} 只能用在执行端上运行的指令里（要声明 env）`);
        if (/(^|\/)\.\.(\/|$)/.test(raw)) throw new Error(`沙箱路径不能含 ..：${raw}`);
        continue;
      }
      const p = normalizePath(raw, CTX.home, opt.workdir);
      if (k !== 'deny' && p === '/') throw new Error('不能开放整个根目录');
      const hit = roots.find(r => within(p, r));
      if (hit && k !== 'deny') throw new Error(`不能开放 ${raw}：它在受保护的目录 ${hit.replace(CTX.home, '~')} 里（凭证、密钥）`);
    }
    n += list.length;
    if (list.length) out[k] = list;
  }
  if (n > MAX_SANDBOX_PATHS) throw new Error(`沙箱路径最多 ${MAX_SANDBOX_PATHS} 条`);
  return Object.keys(out).length ? out : undefined;
}

/** Real path when it exists (Seatbelt matches resolved paths: /tmp → /private/tmp), else the path itself. */
function canonical(p        )         {
  try { if (existsSync(p)) return realpathSync(p); } catch { /* keep as is */ }
  for (const [a, b] of [['/tmp', '/private/tmp'], ['/var', '/private/var'], ['/etc', '/private/etc']]) if (within(p, a)) return b + p.slice(a.length);
  return p;
}

const depth = (p        ) => (p === '/' ? 0 : p.split('/').length - 1);
const RESTRICT                           = { readWrite: 0, readOnly: 1, deny: 2 };

                                                                

/** All rules for one run, sorted shallow → deep (same depth: less restrictive first), mandatory denies separate (emitted last). */
export function buildPolicy(o                                                                                           )         {
  const home = o.home ?? CTX.home;
  const rules           = [...baseline(home)];
  for (const [k, access] of [['readOnly', 'readOnly'], ['readWrite', 'readWrite'], ['deny', 'deny']]         ) {
    for (const raw of o.app?.[k] ?? []) rules.push({ path: normalizePath(raw, home, o.workdir), access, source: 'app' });
  }
  rules.push({ path: o.runDir, access: 'readWrite', source: 'run' });
  const seen = new Map                ();
  for (const r of rules) {
    const c = { ...r, path: canonical(r.path) };
    const prev = seen.get(c.path);
    // Same path twice: the more restrictive wins.
    if (!prev || RESTRICT[c.access] > RESTRICT[prev.access]) seen.set(c.path, c);
  }
  const sorted = [...seen.values()].sort((a, b) => depth(a.path) - depth(b.path) || RESTRICT[a.access] - RESTRICT[b.access] || (a.path < b.path ? -1 : 1));
  const mandatory = [...new Set(mandatoryDenyRoots(home, o.configDir ?? CTX.configDir).map(canonical))];
  return { rules: sorted, mandatory };
}

const esc = (p        ) => p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Every strict ancestor of every non-deny path: stat/readlink only (literal), never listing. */
function ancestors(rules          )           {
  const out = new Set        ();
  for (const r of rules) {
    if (r.access === 'deny') continue;
    for (let p = r.path; p !== '/';) { p = p.slice(0, p.lastIndexOf('/')) || '/'; out.add(p); }
  }
  return [...out].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
}

/** Seatbelt profile. Network: none, everything, or only the declared local services. */
export function compileToSeatbelt(policy        , net                                                               )         {
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
export function describeSandbox(s             , home = CTX.home)         {
  if (!s) return '';
  const show = (l           ) => (l ?? []).map(p => p.replace(home, '~')).join('、');
  return [s.readOnly?.length ? `只读 ${show(s.readOnly)}` : '', s.readWrite?.length ? `读写 ${show(s.readWrite)}` : '', s.deny?.length ? `禁止 ${show(s.deny)}` : ''].filter(Boolean).join('；');
}
