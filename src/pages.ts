// Page apps: a directory of static files (index.html, styles, scripts, images) an agent publishes for a person.
// Pages are not reviewed. They run in a locked frame on a separate origin: no network, no navigation away, and
// the only way to data is calling the apps bound to the page through Amber (Amber.run in the page). Each call runs
// that app as the person looking at the page, so a page can never see more than its viewer could themselves.
//   - Publishing: the agent uploads the files with the owner's email. A new page, or a change to the apps it
//     calls, waits for the owner to confirm on a Feishu card (the API cannot tell who is behind an agent); a
//     content-only update takes effect at once.
//   - Who may open it: the owner sets it on the website — only the owner (default), everyone in the group, or
//     chosen members. Checked on every open and every call, with fresh group membership. Admins may open any page
//     (as themselves: its apps run as the admin, and apps using the owner's secrets stay the owner's); each such
//     open is audited as page.admin_open.
//   - Embeds: a page may show other pages inside it (amber.json "embeds"), each in a frame of its own. The embedded
//     page opts in ("embeddable"), the owner confirms the list like apps, and every open checks the viewer may open
//     each embedded page: one they may not shows a notice instead. An embedded page calls only its own apps, as the
//     viewer. Pages share one origin and cannot reach the network, so a page reading its embeds sees nothing its
//     viewer could not; shared parameters and click filters pass between the frames in the page SDK.
//   - Apps: bound by name when the owner confirms — the owner's own apps in that chat, or global apps. Viewers run
//     them as themselves; apps that use secrets run only for the owner (a viewer would otherwise use the owner's
//     credentials).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, renameSync, rmSync, readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import type { Store, PageRow, PageApp, PageAccess, CommandRow, ScopeType } from './db.ts';
import { AmberError, findVisible, runCommand, type Caller, type CallerFacts, type RunOutcome } from './engine.ts';
import { sanitizeMarkdown, person, closedCard } from './cards.ts';
import { emitEvent } from './events.ts';
import { normFolder, pageFolderKey } from './folder.ts';

export const MAX_PAGE_FILES = 200;
export const MAX_PAGE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGE_APPS = 20;
export const MAX_PAGE_EMBEDS = 10;
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
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
/** The viewer named in a link made for the confirmation card's screenshot (never a union_id: those start with on_). */
const PREVIEW = '#preview';
const PREVIEW_TTL_MS = 2 * 60_000;
const PUBLISH_PER_CHAT_10MIN = 20;

export interface PageFile { path: string; data: string /* base64 */ }
export interface PublishCtx { chatId: string; chatType: ScopeType; user: { unionId: string; openId?: string; email: string }; replyTo?: string; inThread: boolean; requestedBy: string; machine: string }

export interface PageDeps {
  send(to: { chatId?: string; unionId?: string; replyTo?: string; inThread?: boolean }, card: object): Promise<string | undefined>;
  isMember(chatId: string, unionId: string): Promise<boolean | undefined>;
  /** Amber admins may open every page (canView). */
  isAdmin?(unionId: string): boolean;
  cityOf(unionId: string): Promise<string | undefined>;
  facts: Pick<CallerFacts, 'signer'>;
  /** Where the shell is (Amber's website), e.g. http://amber.example.com. */
  webUrl: () => string;
  /** Uploads a PNG for cards; returns its image key. */
  uploadImage?(png: Buffer): Promise<string | undefined>;
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
  const apps = manifestOf(files).apps ?? [];
  if (!Array.isArray(apps) || apps.length > MAX_PAGE_APPS || apps.some((a: unknown) => typeof a !== 'string' || !a.trim() || a.length > 40)) throw new AmberError('bad_page', `amber.json 的 apps 要是应用名数组（最多 ${MAX_PAGE_APPS} 个）`);
  return [...new Set(apps.map((a: string) => a.trim()))];
}

/** What a page lets others do when they embed it (amber.json "embeddable"); absent = it cannot be embedded. */
export interface Embeddable { title?: string; params: string[]; receive: string[]; emit: string[] }
/** One embedded page (amber.json "embeds"): `page` is a page id, or a page name in the same chat. `params` maps the
 *  embedded page's parameters to the host's ({"embedded": "host"}); `receive`/`emit` turn click filters on. */
export interface EmbedSpec { key: string; page: string; title?: string; params: Record<string, string>; follow: boolean; receive: boolean; emit: boolean }

function manifestOf(files: { path: string; bytes: Buffer }[]): any {
  const f = files.find(x => x.path === 'amber.json');
  if (!f) return {};
  try { return JSON.parse(f.bytes.toString('utf8')) ?? {}; } catch { throw new AmberError('bad_page', 'amber.json 不是合法的 JSON'); }
}
const fields = (v: unknown, what: string): string[] => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== 'string' || !FIELD.test(x))) throw new AmberError('bad_page', `amber.json 的 ${what} 要是字段名数组（字母、数字、下划线，最多 20 个）`);
  return [...new Set(v as string[])];
};
const title = (v: unknown, what: string): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 40) throw new AmberError('bad_page', `amber.json 的 ${what} 要是 40 字以内的文字`);
  return v.trim() || undefined;
};

/** amber.json "embeddable": {"title", "params": [...], "receive": [...], "emit": [...]} or true. */
export function embeddableOf(files: { path: string; bytes: Buffer }[]): Embeddable | undefined {
  const e = manifestOf(files).embeddable;
  if (e === undefined || e === null || e === false) return undefined;
  if (e === true) return { params: [], receive: [], emit: [] };
  if (typeof e !== 'object' || Array.isArray(e)) throw new AmberError('bad_page', 'amber.json 的 embeddable 要是 true 或对象');
  return { title: title(e.title, 'embeddable.title'), params: fields(e.params, 'embeddable.params'), receive: fields(e.receive, 'embeddable.receive'), emit: fields(e.emit, 'embeddable.emit') };
}

/** amber.json "embeds": [{"key", "page", "title", "params": {...}, "follow", "receive", "emit"}]. */
export function embedsOf(files: { path: string; bytes: Buffer }[]): EmbedSpec[] {
  const list = manifestOf(files).embeds ?? [];
  if (!Array.isArray(list) || list.length > MAX_PAGE_EMBEDS) throw new AmberError('bad_page', `amber.json 的 embeds 要是数组（最多 ${MAX_PAGE_EMBEDS} 个）`);
  const seen = new Set<string>();
  return list.map((e: any, i: number) => {
    if (!e || typeof e !== 'object') throw new AmberError('bad_page', `amber.json 的 embeds 第 ${i + 1} 项要是对象`);
    const page = String(e.page ?? '').trim();
    if (!/^[0-9a-f]{8}$/.test(page) && !NAME.test(page)) throw new AmberError('bad_page', `embeds 第 ${i + 1} 项的 page 要写页面 id（8 位）或同一会话里的页面名`);
    const key = String(e.key ?? page);
    if (!KEY.test(key)) throw new AmberError('bad_page', `embeds 第 ${i + 1} 项的 key 只能用字母、数字、_ 和 -`);
    if (seen.has(key)) throw new AmberError('bad_page', `embeds 的 key 重复：${key}`);
    seen.add(key);
    const params: Record<string, string> = {};
    if (e.params !== undefined && e.params !== null) {
      if (typeof e.params !== 'object' || Array.isArray(e.params)) throw new AmberError('bad_page', `embeds「${key}」的 params 要写成 {"被嵌页面的参数": "本页的参数"}`);
      for (const [k, v] of Object.entries(e.params)) {
        if (!FIELD.test(k) || typeof v !== 'string' || !FIELD.test(v)) throw new AmberError('bad_page', `embeds「${key}」的 params 里有不合法的字段名`);
        params[k] = v;
      }
    }
    return { key, page, title: title(e.title, `embeds「${key}」的 title`), params, follow: e.follow !== false, receive: e.receive === true, emit: e.emit === true };
  });
}
const embedsKey = (l: EmbedSpec[]) => JSON.stringify(l.map(e => [e.key, e.page, e.title ?? '', Object.entries(e.params).sort(), e.follow, e.receive, e.emit]));

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
  /** Takes a screenshot of a content path (/c/<link>/) on the page origin; set when a browser is configured. */
  shoot?: (path: string) => Promise<Buffer | undefined>;

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
  /** rawFolder: where to file the page on the website ("财务/上账", '' = top level); undefined keeps it where it is. */
  async publish(ctx: PublishCtx, rawName: string, rawFiles: unknown, rawFolder?: unknown): Promise<object> {
    const name = String(rawName ?? '').trim();
    if (!NAME.test(name)) throw new AmberError('bad_page', '页面名只能用小写字母、数字和 -，以字母或数字开头，最多 40 个字符');
    const folder = rawFolder === undefined ? undefined : normFolder(rawFolder);
    const files = checkFiles(rawFiles);
    const apps = appsOf(files);
    const embeds = embedsOf(files);
    embeddableOf(files);   // checked now, read when another page embeds this one
    const existing = this.store.pageByName(ctx.chatId, name);
    if (existing && existing.ownerUnionId !== ctx.user.unionId) throw new AmberError('conflict', `这里已经有别人的页面叫「${name}」，换个名字`);
    const bytes = files.reduce((n, f) => n + f.bytes.length, 0);
    // Content-only update of a live page: no confirmation needed (the apps it may call did not change).
    if (existing?.status === 'active' && !existing.pending && sameApps(existing.apps.map(a => a.name), apps) && embedsKey(this.liveEmbeds(existing)) === embedsKey(embeds)) {
      const version = existing.version + 1;
      this.writeVersion(existing.id, version, files);
      this.store.updatePage(existing.id, { version });
      if (folder !== undefined) this.store.setFolder(existing.chatId, pageFolderKey(existing.id), folder);
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
    const pending = { version, apps, ...(embeds.length ? { embeds: embeds.map(e => e.key) } : {}), requestedBy: ctx.requestedBy, machine: ctx.machine, at: Date.now() };
    if (existing) this.store.updatePage(id, { pending });
    else this.store.insertPage({ id, name, chatId: ctx.chatId, chatType: ctx.chatType, ownerUnionId: ctx.user.unionId, ownerOpenId: ctx.user.openId ?? null, pending });
    if (folder !== undefined) this.store.setFolder(ctx.chatId, pageFolderKey(id), folder);
    const imageKey = await this.preview(id, version);
    const embedNames = embeds.map(e => this.store.getPage(e.page)?.name ?? this.store.pageByName(ctx.chatId, e.page)?.name ?? e.page);
    const card = publishCard({ id, version, imageKey, name, apps, embeds: embedNames, requestedBy: ctx.requestedBy, ownerOpenId: ctx.user.openId, files: files.length, bytes, update: !!existing });
    const to = ctx.chatType === 'p2p' ? { unionId: ctx.user.unionId } : ctx.replyTo ? { replyTo: ctx.replyTo, inThread: ctx.inThread } : { chatId: ctx.chatId };
    let messageId: string | undefined;
    try { messageId = await this.deps.send(to, card); } catch (e: any) {
      const code = e?.response?.data?.code;
      throw new AmberError('card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `确认卡片发送失败：${code ?? e?.message}`);
    }
    this.store.updatePage(id, { pending: { ...pending, messageId: messageId ?? null } });
    this.store.audit(null, 'page.publish_request', { id, name, version, apps, files: files.length, bytes, chatId: ctx.chatId, requestedBy: ctx.requestedBy, machine: ctx.machine, target: ctx.user.unionId });
    return { status: 'awaiting', pageId: id, message: `已在飞书发出确认卡片，等 ${ctx.user.email} 点「确认发布」。${apps.length ? `页面会调用：${apps.join('、')}。` : ''}${embedNames.length ? `页面嵌入：${embedNames.join('、')}。` : ''}` };
  }

  /** A screenshot of an upload waiting for confirmation, for its card. Best effort: no browser, no picture. */
  private async preview(id: string, version: number): Promise<string | undefined> {
    if (!this.shoot || !this.deps.uploadImage) return undefined;
    try {
      const png = await this.shoot(`/c/${this.token({ id, version }, PREVIEW, PREVIEW_TTL_MS)}/`);
      return png ? await this.deps.uploadImage(png) : undefined;
    } catch (e: any) {
      console.log(new Date().toISOString(), 'page preview failed', e?.message ?? e);
      return undefined;
    }
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
    // Embedded pages: each must exist, allow embedding, and be one the person confirming may open.
    const bad: string[] = [];
    for (const e of this.embedsIn(p, pending.version)) {
      const t = this.embedTarget(p, e.page);
      if (!t) bad.push(`「${sanitizeMarkdown(e.page, 40)}」不存在`);
      else if (!this.embeddableIn(t)) bad.push(`「${sanitizeMarkdown(t.name, 40)}」没有在它的 amber.json 里允许被嵌入（embeddable）`);
      else if (!(await this.canView(t, clicker.unionId))) bad.push(`你没有「${sanitizeMarkdown(t.name, 40)}」的访问权限`);
    }
    if (bad.length) return closedCard(`没有发布：${p.name}`, 'red', `嵌入的页面有问题：${bad.join('；')}。改好后让 agent 重新发布。`);
    const first = p.status === 'pending';
    this.store.updatePage(id, { apps: bound, version: pending.version, status: 'active', pending: null, ownerOpenId: clicker.openId ?? p.ownerOpenId });
    this.prune({ ...p, version: pending.version, pending: null });
    this.store.audit(clicker.unionId, 'page.publish', { id, name: p.name, version: pending.version, apps: bound.map(a => ({ name: a.name, commandId: a.commandId })) });
    emitEvent(first ? 'page.published' : 'page.apps_changed', { pageId: id, name: p.name, chatId: p.chatId, chatType: p.chatType, ownerUnionId: p.ownerUnionId });
    const url = this.url(p);
    return {
      schema: '2.0', config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: `Amber · 页面已发布：${p.name}` }, template: 'green' },
      body: { elements: [
        { tag: 'markdown', content: `由 ${person(clicker.openId)} 确认发布（第 ${pending.version} 版）。${bound.length ? `页面会调用：${bound.map(a => `「${sanitizeMarkdown(a.name, 40)}」`).join('、')}。` : ''}${first ? '\n\n现在只有你能打开。要让群里的人用，在网站上打开这个页面的设置，修改「谁能访问」。' : ''}` },
        { tag: 'column_set', flex_mode: 'flow', columns: [
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '打开页面' }, type: 'primary', behaviors: [{ type: 'open_url', default_url: url }] }] },
          // Not logged in on the website: a one-time link in your private chat logs you in and opens the page.
          { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '私聊我免登录链接' }, type: 'default', behaviors: [{ type: 'callback', value: { a: 'pg_open', p: id } }] }] },
        ] },
      ] },
    };
  }

  // ---------- embeds: read from the amber.json of the version in question

  private manifestFiles(id: string, version: number): { path: string; bytes: Buffer }[] {
    const f = join(this.dir(id, version), 'amber.json');
    return existsSync(f) ? [{ path: 'amber.json', bytes: readFileSync(f) }] : [];
  }
  private embedsIn(p: Pick<PageRow, 'id'>, version: number): EmbedSpec[] { try { return embedsOf(this.manifestFiles(p.id, version)); } catch { return []; } }
  private liveEmbeds(p: PageRow): EmbedSpec[] { return p.status === 'active' ? this.embedsIn(p, p.version) : []; }
  embeddableIn(p: PageRow): Embeddable | undefined {
    if (p.status !== 'active') return undefined;
    try { return embeddableOf(this.manifestFiles(p.id, p.version)); } catch { return undefined; }
  }
  /** An embed's page: by id, or by name in the host's chat. */
  private embedTarget(host: PageRow, ref: string): PageRow | undefined {
    const t = /^[0-9a-f]{8}$/.test(ref) ? this.store.getPage(ref) : this.store.pageByName(host.chatId, ref);
    return t && t.status !== 'deleted' && t.id !== host.id ? t : undefined;
  }

  /** What the shell tells a page about its embeds, for one viewer: a content link for each page they may open,
   *  a reason for the others. The page SDK draws the frames, title bars and switches from this. */
  async embedsFor(p: PageRow, viewer: string, origin: string, nameOf: (u: string) => Promise<string | undefined>): Promise<Record<string, object>> {
    const out: Record<string, object> = {};
    for (const e of this.liveEmbeds(p)) {
      const t = this.embedTarget(p, e.page);
      const decl = t ? this.embeddableIn(t) : undefined;
      const base = { key: e.key, follow: e.follow, title: e.title ?? decl?.title ?? t?.name ?? e.page };
      if (!t || t.status !== 'active') { out[e.key] = { ...base, denied: 'gone', message: '嵌入的页面已不存在' }; continue; }
      const info = { ...base, page: t.id, name: t.name, owner: (await nameOf(t.ownerUnionId)) ?? '', url: this.url(t) };
      if (!decl) { out[e.key] = { ...info, denied: 'not_embeddable', message: `「${t.name}」不再允许被嵌入` }; continue; }
      if (!(await this.canView(t, viewer))) { out[e.key] = { ...info, denied: 'forbidden', message: `你没有「${t.name}」的访问权限，可以联系它的创建人开通` }; continue; }
      // Only what both sides allow: parameters the embedded page takes, filters it declared.
      const params = Object.fromEntries(Object.entries(e.params).filter(([k]) => decl.params.includes(k)));
      out[e.key] = { ...info, params, receive: e.receive ? decl.receive : [], emit: e.emit ? decl.emit : [], src: `${origin}/c/${this.token(t, viewer)}/` };
    }
    return out;
  }

  /** Whether `viewer` may open the page and call its apps right now: by its access setting, or as an admin. */
  async canView(p: PageRow, viewer: string): Promise<boolean> {
    if (p.status !== 'active') return false;
    return (await this.sharedWith(p, viewer)) || !!this.deps.isAdmin?.(viewer);
  }

  /** Whether the page's access setting lets `viewer` in (without the admin exception). */
  async sharedWith(p: PageRow, viewer: string): Promise<boolean> {
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
    const caller: Caller = { unionId: viewer.unionId, openId: viewer.openId, chatId: p.chatId, chatType: p.chatType, channel: 'page', pageId: p.id };
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

  /** Files the page under a folder on the website (display only). */
  setFolder(id: string, actor: string, isAdmin: boolean, raw: unknown): string {
    const p = this.store.getPage(id);
    if (!p || p.status === 'deleted') throw new AmberError('not_found', '页面不存在');
    if (actor !== p.ownerUnionId && !isAdmin) throw new AmberError('forbidden', '只有页面的创建人或管理员可以修改目录');
    const folder = normFolder(raw);
    this.store.setFolder(p.chatId, pageFolderKey(id), folder);
    this.store.audit(actor, 'page.folder', { id, name: p.name, folder });
    return folder;
  }

  remove(id: string, actor: string, isAdmin: boolean): void {
    const p = this.store.getPage(id);
    if (!p || p.status === 'deleted') throw new AmberError('not_found', '页面不存在');
    if (actor !== p.ownerUnionId && !isAdmin) throw new AmberError('forbidden', '只有页面的创建人或管理员可以删除');
    this.store.updatePage(id, { status: 'deleted', pending: null });
    this.store.setFolder(p.chatId, pageFolderKey(id), '');
    rmSync(join(this.root, id), { recursive: true, force: true });
    this.store.audit(actor, 'page.delete', { id, name: p.name });
  }

  // ---------- content links: the shell (Amber's origin) frames the page from the page origin

  token(p: Pick<PageRow, 'id' | 'version'>, viewer: string, ttlMs = TOKEN_TTL_MS): string {
    const body = `${p.id}.${p.version}.${Date.now() + ttlMs}`;
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
    if (!p) return undefined;
    if (viewer === PREVIEW) {
      // The card's screenshot: only the upload waiting for confirmation.
      if (p.status === 'deleted' || p.pending?.version !== Number(m[2])) return undefined;
    } else if (!(await this.canView(p, viewer))) return undefined;   // the link's viewer must still be allowed
    const rel = path === '' ? 'index.html' : path;
    if (!PATH.test(rel) || !PAGE_TYPES[extname(rel).toLowerCase()]) return undefined;
    const f = join(this.dir(p.id, Number(m[2])), rel);
    if (!existsSync(f) || !statSync(f).isFile()) return undefined;
    return { bytes: readFileSync(f), type: PAGE_TYPES[extname(rel).toLowerCase()] };
  }
}

const sameApps = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');

function publishCard(o: { id: string; version: number; imageKey?: string; name: string; apps: string[]; embeds: string[]; requestedBy: string; ownerOpenId?: string; files: number; bytes: number; update: boolean }): object {
  const size = o.bytes > 1024 * 1024 ? `${(o.bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(o.bytes / 1024))}KB`;
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: `Amber · ${o.update ? '页面要调用新的应用或嵌入新的页面' : '发布页面'}：${o.name}` }, template: 'orange' },
    body: { elements: [
      { tag: 'markdown', content: `${sanitizeMarkdown(o.requestedBy, 40)} 要以 ${person(o.ownerOpenId)} 的名义${o.update ? '更新' : '发布'}页面「${sanitizeMarkdown(o.name, 40)}」（${o.files} 个文件，${size}）。\n\n`
        + (o.apps.length ? `页面会调用这些应用：${o.apps.map(a => `「${sanitizeMarkdown(a, 40)}」`).join('、')}。每次调用都以打开页面的人自己的身份执行。` : '页面不调用任何应用。')
        + (o.embeds.length ? `\n\n页面会嵌入这些页面：${o.embeds.map(a => `「${sanitizeMarkdown(a, 40)}」`).join('、')}。打开的人没有某个页面的权限时，那一块显示无权限提示。` : '')
        + (o.update ? '' : '\n\n确认后只有你能打开，之后可以在网站上设置群里谁能访问。') },
      ...(o.imageKey ? [{ tag: 'img', img_key: o.imageKey, alt: { tag: 'plain_text', content: '页面预览' }, preview: true, scale_type: 'fit_horizontal' }] : []),
      { tag: 'column_set', flex_mode: 'flow', columns: [
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '确认发布' }, type: 'primary', behaviors: [{ type: 'callback', value: { a: 'pg_ok', p: o.id, v: String(o.version) } }] }] },
        { tag: 'column', width: 'auto', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消' }, type: 'default', behaviors: [{ type: 'callback', value: { a: 'pg_no', p: o.id, v: String(o.version) } }] }] },
      ] },
    ] },
  };
}
