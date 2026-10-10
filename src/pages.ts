// Page apps: a directory of static files (index.html, styles, scripts, images) an agent publishes for a person.
// Pages are not reviewed. They run in a locked frame on a separate origin: no network, no navigation away, and
// the only way to data is calling the apps bound to the page through Amber (Amber.run in the page). Each call runs
// that app as the person looking at the page, so a page can never see more than its viewer could themselves.
//   - Publishing: the agent uploads the files with the owner's email. A new page, or a change to the apps it
//     calls, waits for the owner to confirm on a Feishu card (the API cannot tell who is behind an agent); a
//     content-only update takes effect at once.
//   - Who may open it: the owner sets it on the website — only the owner (default), everyone in the group, or
//     chosen members. Checked on every open and every call, with fresh group membership.
//   - Apps: bound by name when the owner confirms — the owner's own apps in that chat, or global apps. Viewers run
//     them as themselves; apps that use secrets run only for the owner (a viewer would otherwise use the owner's
//     credentials).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import type { Store, PageRow, PageApp, PageAccess, CommandRow, ScopeType } from './db.ts';
import { AmberError, findVisible, runCommand, type Caller, type CallerFacts, type RunOutcome } from './engine.ts';
import { sanitizeMarkdown, person, closedCard } from './cards.ts';

export const MAX_PAGE_FILES = 200;
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGE_APPS = 20;
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PATH = /^[A-Za-z0-9_\-][A-Za-z0-9._\-]*(\/[A-Za-z0-9_\-][A-Za-z0-9._\-]*)*$/;
/** Static file types a page may contain, and how they are served. */
export const PAGE_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};
/** How long a content link from the shell stays valid. Reloading the page gets a new one. */
const TOKEN_TTL_MS = 6 * 3600_000;
const PUBLISH_PER_CHAT_10MIN = 20;

export interface PageFile { path: string; data: string /* base64 */ }
export interface PublishCtx { chatId: string; chatType: ScopeType; user: { unionId: string; openId?: string; email: string }; replyTo?: string; inThread: boolean; requestedBy: string; machine: string }

export interface PageDeps {
  send(to: { chatId?: string; unionId?: string; replyTo?: string; inThread?: boolean }, card: object): Promise<string | undefined>;
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  cityOf(unionId: string): Promise<string | undefined>;
  facts: Pick<CallerFacts, 'signer'>;
  /** Where the shell is (Amber's website), e.g. http://amber.example.com. */
  webUrl: () => string;
}

/** One file list, checked: safe relative paths, known types, size and count limits, index.html present. */
export function checkFiles(files: unknown): { path: string; bytes: Buffer }[] {
  if (!Array.isArray(files) || files.length === 0) throw new AmberError('bad_page', '页面没有文件');
  if (files.length > MAX_PAGE_FILES) throw new AmberError('bad_page', `页面最多 ${MAX_PAGE_FILES} 个文件`);
  let total = 0;
  const seen = new Set<string>();
  const out = files.map((f: any) => {
    const path = String(f?.path ?? '');
    if (path.length > 200 || !PATH.test(path)) throw new AmberError('bad_page', `文件名不对：${path.slice(0, 80)}（只能用字母、数字、. _ -，不能以点开头）`);
    if (!PAGE_TYPES[extname(path).toLowerCase()]) throw new AmberError('bad_page', `不支持的文件类型：${path}（支持 ${Object.keys(PAGE_TYPES).join(' ')}）`);
    if (seen.has(path)) throw new AmberError('bad_page', `文件重复：${path}`);
    seen.add(path);
    const bytes = Buffer.from(String(f?.data ?? ''), 'base64');
    total += bytes.length;
    if (total > MAX_PAGE_BYTES) throw new AmberError('bad_page', `页面总大小不能超过 ${MAX_PAGE_BYTES / 1024 / 1024}MB`);
    return { path, bytes };
  });
  if (!seen.has('index.html')) throw new AmberError('bad_page', '页面目录里要有 index.html');
  return out;
}

/** amber.json: {"apps": ["应用名", ...]} — the apps the page will call. Absent = none. */
export function appsOf(files: { path: string; bytes: Buffer }[]): string[] {
  const f = files.find(x => x.path === 'amber.json');
  if (!f) return [];
  let j: any;
  try { j = JSON.parse(f.bytes.toString('utf8')); } catch { throw new AmberError('bad_page', 'amber.json 不是合法的 JSON'); }
  const apps = j?.apps ?? [];
  if (!Array.isArray(apps) || apps.length > MAX_PAGE_APPS || apps.some((a: unknown) => typeof a !== 'string' || !a.trim() || a.length > 40)) throw new AmberError('bad_page', `amber.json 的 apps 要是应用名数组（最多 ${MAX_PAGE_APPS} 个）`);
  return [...new Set(apps.map((a: string) => a.trim()))];
}

/** The output of a run, split for pages: text, tables (rows), charts (vega-lite specs) and ```json data. */
export function outputBlocks(markdown: string): { blocks: { kind: 'markdown' | 'table' | 'chart' | 'json'; text?: string; data?: unknown }[]; json?: unknown } {
  const blocks: { kind: 'markdown' | 'table' | 'chart' | 'json'; text?: string; data?: unknown }[] = [];
  const re = /```(vega-lite|table|json)\s*\n([\s\S]*?)```/g;
  let last = 0, m: RegExpExecArray | null, json: unknown;
  const text = (t: string) => { if (t.trim()) blocks.push({ kind: 'markdown', text: t.trim() }); };
  while ((m = re.exec(markdown))) {
    text(markdown.slice(last, m.index));
    last = m.index + m[0].length;
    let data: unknown;
    try { data = JSON.parse(m[2]); } catch { blocks.push({ kind: 'markdown', text: m[0] }); continue; }
    if (m[1] === 'json') { blocks.push({ kind: 'json', data }); if (json === undefined) json = data; }
    else blocks.push({ kind: m[1] === 'table' ? 'table' : 'chart', data });
  }
  text(markdown.slice(last));
  return { blocks, ...(json !== undefined ? { json } : {}) };
}

export class PageService {
  private store: Store;
  private deps: PageDeps;
  private root: string;
  private key: Buffer;
  private asked = new Map<string, number[]>();

  constructor(store: Store, dataDir: string, deps: PageDeps) {
    this.store = store;
    this.deps = deps;
    this.root = join(dataDir, 'pages');
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    // Signs content links (shell → page origin). Kept across restarts so open pages keep working.
    store.setSettingIfAbsent('pages_token_key', randomBytes(32).toString('hex'));
    this.key = Buffer.from(store.getSetting('pages_token_key')!, 'hex');
  }

  private dir(id: string, version: number): string { return join(this.root, id, `v${version}`); }

  private writeVersion(id: string, version: number, files: { path: string; bytes: Buffer }[]): void {
    const final = this.dir(id, version), tmp = `${final}.tmp-${randomBytes(4).toString('hex')}`;
    for (const f of files) {
      const p = join(tmp, f.path);
      mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
      writeFileSync(p, f.bytes, { mode: 0o600 });
    }
    rmSync(final, { recursive: true, force: true });
    renameSync(tmp, final);
  }

  /** Keeps the live version and a pending one; older uploads go. */
  private prune(p: PageRow): void {
    const keep = new Set([`v${p.version}`, ...(p.pending ? [`v${p.pending.version}`] : [])]);
    const d = join(this.root, p.id);
    if (!existsSync(d)) return;
    for (const n of readdirSync(d)) if (!keep.has(n)) rmSync(join(d, n), { recursive: true, force: true });
  }

  url(p: PageRow): string { return `${this.deps.webUrl()}/p/${p.id}/`; }

  /** The agent publishes or updates a page for `ctx.user`. Returns what happened, for the agent to tell the person. */
  async publish(ctx: PublishCtx, rawName: string, rawFiles: unknown): Promise<object> {
    const name = String(rawName ?? '').trim();
    if (!NAME.test(name)) throw new AmberError('bad_page', '页面名只能用小写字母、数字和 -，以字母或数字开头，最多 40 个字符');
    const files = checkFiles(rawFiles);
    const apps = appsOf(files);
    const existing = this.store.pageByName(ctx.chatId, name);
    if (existing && existing.ownerUnionId !== ctx.user.unionId) throw new AmberError('conflict', `这里已经有别人的页面叫「${name}」，换个名字`);
    const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
    // Content-only update of a live page: no confirmation needed (the apps it may call did not change).
    if (existing?.status === 'active' && !existing.pending && sameApps(existing.apps.map(a => a.name), apps)) {
      const version = existing.version + 1;
      this.writeVersion(existing.id, version, files);
      this.store.updatePage(existing.id, { version });
      this.prune({ ...existing, version });
      this.store.audit(null, 'page.update', { id: existing.id, name, version, files: files.length, bytes, requestedBy: ctx.requestedBy, machine: ctx.machine, claimedUser: ctx.user.email });
      return { status: 'updated', pageId: existing.id, url: this.url(existing), version, message: `页面已更新（第 ${version} 版），刷新页面就能看到：${this.url(existing)}` };
    }
    // Agents are not trusted: cap how many confirmation cards they can make Amber post into one chat.
    const recent = (this.asked.get(ctx.chatId) ?? []).filter(t => Date.now() - t < 10 * 60_000);
    if (recent.length >= PUBLISH_PER_CHAT_10MIN) throw new AmberError('rate_limited', '这个会话 10 分钟内发布页面的次数太多了，请稍后再试');
    this.asked.set(ctx.chatId, [...recent, Date.now()]);
    // New page, or the apps it calls changed: the owner confirms on a card (identity from the click).
    // From reading the version to recording it as pending there is no await: concurrent uploads get distinct versions.
    const id = existing?.id ?? randomBytes(4).toString('hex');
    const version = Math.max(existing?.version ?? 0, existing?.pending?.version ?? 0) + 1;
    this.writeVersion(id, version, files);
    const pending = { version, apps, requestedBy: ctx.requestedBy, machine: ctx.machine, at: Date.now() };
    if (existing) this.store.updatePage(id, { pending });
    else this.store.insertPage({ id, name, chatId: ctx.chatId, chatType: ctx.chatType, ownerUnionId: ctx.user.unionId, ownerOpenId: ctx.user.openId ?? null, pending });
    const card = publishCard({ id, version, name, apps, requestedBy: ctx.requestedBy, ownerOpenId: ctx.user.openId, files: files.length, bytes, update: !!existing });
    const to = ctx.chatType === 'p2p' ? { unionId: ctx.user.unionId } : ctx.replyTo ? { replyTo: ctx.replyTo, inThread: ctx.inThread } : { chatId: ctx.chatId };
    let messageId: string | undefined;
    try { messageId = await this.deps.send(to, card); } catch (e: any) {
      const code = e?.response?.data?.code;
      throw new AmberError('card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `确认卡片发送失败：${code ?? e?.message}`);
    }
    this.store.updatePage(id, { pending: { ...pending, messageId: messageId ?? null } });
    this.store.audit(null, 'page.publish_request', { id, name, version, apps, files: files.length, bytes, chatId: ctx.chatId, requestedBy: ctx.requestedBy, machine: ctx.machine, target: ctx.user.unionId });
    return { status: 'awaiting', pageId: id, message: `已在飞书发出确认卡片，等 ${ctx.user.email} 点「确认发布」。${apps.length ? `页面会调用：${apps.join('、')}。` : ''}` };
  }

  /** The owner clicked 确认发布 / 取消 on the card. */
  async onClick(ok: boolean, id: string, version: number, clicker: Caller, cardChatId: string): Promise<object> {
    const p = this.store.getPage(id);
    if (!p || p.status === 'deleted' || !p.pending) throw new AmberError('closed', '这个发布请求已经处理过了');
    // The card approves the upload it shows: a newer upload has a card of its own.
    if (p.pending.version !== version) throw new AmberError('closed', '这个页面又发布了新的版本，请在最新的确认卡片上操作');
    if (clicker.unionId !== p.ownerUnionId) throw new AmberError('forbidden', '只有页面的创建人可以确认');
    if (p.chatType === 'group' && cardChatId !== p.chatId) throw new AmberError('forbidden', '请在原来的群里操作');
    const pending = p.pending;
    if (!ok) {
      this.store.updatePage(id, { pending: null });
      if (p.status === 'pending') this.store.updatePage(id, { status: 'deleted' });
      this.prune({ ...p, pending: null });
      this.store.audit(clicker.unionId, 'page.publish_cancel', { id, name: p.name, version: pending.version });
      return closedCard(`已取消：${p.name}`, 'grey', `${person(clicker.openId)} 取消了发布${p.status === 'active' ? '，页面保持原来的版本' : ''}。`);
    }
    // Bind the apps as the person who clicked: their own apps in this chat, or global ones.
    const caller: Caller = { unionId: clicker.unionId, openId: clicker.openId, chatId: p.chatId, chatType: p.chatType, channel: 'web' };
    const bound: PageApp[] = [];
    const missing: string[] = [];
    for (const name of pending.apps) {
      try {
        const c = findVisible(this.store, caller, name);
        bound.push({ name, commandId: c.id, chatId: c.chatId, line: c.line ?? c.name, global: c.global });
      } catch { missing.push(name); }
    }
    if (missing.length) return closedCard(`没有发布：${p.name}`, 'red', `找不到你能用的应用：${missing.map(n => `「${sanitizeMarkdown(n, 40)}」`).join('、')}。页面只能调用你自己在这里的应用，或者全局应用。改好后让 agent 重新发布。`);
    const first = p.status === 'pending';
    this.store.updatePage(id, { apps: bound, version: pending.version, status: 'active', pending: null, ownerOpenId: clicker.openId ?? p.ownerOpenId });
    this.prune({ ...p, version: pending.version, pending: null });
    this.store.audit(clicker.unionId, 'page.publish', { id, name: p.name, version: pending.version, apps: bound.map(a => ({ name: a.name, commandId: a.commandId })) });
    const url = this.url(p);
    return {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: `Amber · 页面已发布：${p.name}` }, template: 'green' },
      body: { elements: [
        { tag: 'markdown', content: `由 ${person(clicker.openId)} 确认发布（第 ${pending.version} 版）。${bound.length ? `页面会调用：${bound.map(a => `「${sanitizeMarkdown(a.name, 40)}」`).join('、')}。` : ''}${first ? '\n\n现在只有你能打开。要让群里的人用，在网站上打开这个页面的设置，修改「谁能访问」。' : ''}` },
        { tag: 'button', text: { tag: 'plain_text', content: '打开页面' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }] },
      ] },
    };
  }

  /** Whether `viewer` may open the page and call its apps right now. */
  async canView(p: PageRow, viewer: string): Promise<boolean> {
    if (p.status !== 'active') return false;
    if (viewer === p.ownerUnionId) return true;
    if (p.chatType !== 'group' || p.access === 'owner') return false;
    if (p.access === 'members' && !p.members.includes(viewer)) return false;
    return (await this.deps.isMember(p.chatId, viewer)) === true;
  }

  /** The command behind a bound app, as it is now (a new version of the same app is picked up). */
  resolveApp(p: PageRow, name: string): CommandRow {
    const b = p.apps.find(a => a.name === name);
    if (!b) throw new AmberError('not_bound', `这个页面不能调用「${name}」（amber.json 里没有）`);
    const c = b.global ? this.store.listActiveGlobal().find(g => g.name === b.name) : this.store.activeByName(b.chatId, b.line);
    if (!c) throw new AmberError('not_found', `应用「${name}」已下线`);
    // The owner's own app, still theirs (reassigned apps stop working here), or a global one.
    if (!c.global && c.ownerUnionId !== p.ownerUnionId) throw new AmberError('not_found', `应用「${name}」已经不属于页面的创建人`);
    return c;
  }

  /** A viewer's page called an app. Runs it as the viewer. */
  async run(id: string, viewer: { unionId: string; openId?: string }, app: string, args: Record<string, string>, confirmed: boolean): Promise<RunOutcome> {
    const p = this.store.getPage(id);
    if (!p || !(await this.canView(p, viewer.unionId))) throw new AmberError('forbidden', '你没有这个页面的访问权限');
    const cmd = this.resolveApp(p, app);
    if (cmd.script.secrets?.length && viewer.unionId !== p.ownerUnionId) throw new AmberError('forbidden', `「${cmd.name}」用到了创建人的密钥，只有页面创建人自己能通过页面调用`);
    if (cmd.options.confirm && !confirmed) throw new AmberError('needs_confirm', `「${cmd.name}」需要确认后执行`);
    const caller: Caller = { unionId: viewer.unionId, openId: viewer.openId, chatId: p.chatId, chatType: p.chatType, channel: 'page' };
    this.store.audit(viewer.unionId, 'page.call', { id, page: p.name, app: cmd.name, commandId: cmd.id });
    return runCommand(this.store, cmd, args, caller, { city: () => this.deps.cityOf(viewer.unionId), signer: this.deps.facts.signer }, { viaForm: true });
  }

  setAccess(id: string, actor: string, access: unknown, members: unknown): PageRow {
    const p = this.store.getPage(id);
    if (!p || p.status === 'deleted') throw new AmberError('not_found', '页面不存在');
    if (actor !== p.ownerUnionId) throw new AmberError('forbidden', '只有页面的创建人可以设置谁能访问');
    if (access !== 'owner' && access !== 'group' && access !== 'members') throw new AmberError('bad_request', '访问范围只能是 owner / group / members');
    if (p.chatType === 'p2p' && access !== 'owner') throw new AmberError('bad_request', '私聊里的页面只有创建人自己能访问');
    const list = Array.isArray(members) ? [...new Set(members.map(String).filter(u => /^on_[A-Za-z0-9]+$/.test(u)))].slice(0, 500) : [];
    if (access === 'members' && !list.length) throw new AmberError('bad_request', '请至少选一个人');
    this.store.updatePage(id, { access: access as PageAccess, members: access === 'members' ? list : [] });
    this.store.audit(actor, 'page.access', { id, name: p.name, access, members: access === 'members' ? list : [] });
    return this.store.getPage(id)!;
  }

  remove(id: string, actor: string, isAdmin: boolean): void {
    const p = this.store.getPage(id);
    if (!p || p.status === 'deleted') throw new AmberError('not_found', '页面不存在');
    if (actor !== p.ownerUnionId && !isAdmin) throw new AmberError('forbidden', '只有页面的创建人或管理员可以删除');
    this.store.updatePage(id, { status: 'deleted', pending: null });
    rmSync(join(this.root, id), { recursive: true, force: true });
    this.store.audit(actor, 'page.delete', { id, name: p.name });
  }

  // ---------- content links: the shell (Amber's origin) frames the page from the page origin

  token(p: PageRow, viewer: string): string {
    const body = `${p.id}.${p.version}.${Date.now() + TOKEN_TTL_MS}`;
    const sig = createHmac('sha256', this.key).update(`${body}.${viewer}`).digest('base64url').slice(0, 32);
    return `${body}.${Buffer.from(viewer).toString('base64url')}.${sig}`;
  }

  /** The file a content link points to, or undefined (bad/expired link, page gone, no such file). */
  async file(token: string, path: string): Promise<{ bytes: Buffer; type: string } | undefined> {
    const m = /^([0-9a-f]{8})\.(\d+)\.(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{32})$/.exec(token);
    if (!m || Number(m[3]) < Date.now()) return undefined;
    const viewer = Buffer.from(m[4], 'base64url').toString();
    const want = createHmac('sha256', this.key).update(`${m[1]}.${m[2]}.${m[3]}.${viewer}`).digest('base64url').slice(0, 32);
    if (!timingSafeEqual(Buffer.from(want), Buffer.from(m[5]))) return undefined;
    const p = this.store.getPage(m[1]);
    // The link was issued to one viewer: they must still be allowed (access changed, left the group).
    if (!p || !(await this.canView(p, viewer))) return undefined;
    const rel = path === '' ? 'index.html' : path;
    if (!PATH.test(rel) || !PAGE_TYPES[extname(rel).toLowerCase()]) return undefined;
    const f = join(this.dir(p.id, Number(m[2])), rel);
    if (!existsSync(f) || !statSync(f).isFile()) return undefined;
    return { bytes: readFileSync(f), type: PAGE_TYPES[extname(rel).toLowerCase()] };
  }
}

const sameApps = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

function publishCard(o: { id: string; version: number; name: string; apps: string[]; requestedBy: string; ownerOpenId?: string; files: number; bytes: number; update: boolean }): object {
  const size = o.bytes > 1024 * 1024 ? `${(o.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(o.bytes / 1024))}KB`;
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `Amber · ${o.update ? '页面要调用新的应用' : '发布页面'}：${o.name}` }, template: 'orange' },
    body: { elements: [
      { tag: 'markdown', content: `${sanitizeMarkdown(o.requestedBy, 40)} 要以 ${person(o.ownerOpenId)} 的名义${o.update ? '更新' : '发布'}页面「${sanitizeMarkdown(o.name, 40)}」（${o.files} 个文件，${size}）。\n\n`
        + (o.apps.length ? `页面会调用这些应用：${o.apps.map(a => `「${sanitizeMarkdown(a, 40)}」`).join('、')}。每次调用都以打开页面的人自己的身份执行。` : '页面不调用任何应用。')
        + (o.update ? '' : '\n\n确认后只有你能打开，之后可以在网站上设置群里谁能访问。') },
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '确认发布' }, type: 'primary', behaviors: [{ type: 'callback', value: { a: 'pg_ok', p: o.id, v: String(o.version) } }] }] },
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', behaviors: [{ type: 'callback', value: { a: 'pg_no', p: o.id, v: String(o.version) } }] }] },
      ] },
    ] },
  };
}
