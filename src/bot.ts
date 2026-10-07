import * as lark from '@larksuiteoapi/node-sdk';
import type { Store, CommandRow } from './db.ts';
import type { Caller } from './engine.ts';
import { visibleCommands, findVisible, runCommand, AmberError } from './engine.ts';
import { listCard, formCard, runningCard, resultCard, errorCard, infoCard } from './cards.ts';
import type { AmberConfig } from './config.ts';
import { Flow } from './flow.ts';
import { Signer } from './identity.ts';
import { FeishuReview } from './feishu-review.ts';

function log(...a: unknown[]): void {
  console.log(new Date().toISOString(), ...a);
}

/** Split "天气 \"New York\" 3" into ["天气", "New York", "3"]. */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|“([^”]*)”|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

export class AmberBot {
  private client: lark.Client;
  private ws: lark.WSClient;
  private botOpenId = '';
  private seen = new Map<string, number>();
  private chatTypeCache = new Map<string, 'group' | 'p2p'>();
  private store: Store;
  private cfg: AmberConfig;
  private adminUnionIds = new Set<string>();
  flow: Flow;
  signer: Signer;

  constructor(cfg: AmberConfig, store: Store) {
    this.cfg = cfg;
    this.store = store;
    this.client = new lark.Client({ appId: cfg.appId, appSecret: cfg.appSecret });
    this.ws = new lark.WSClient({ appId: cfg.appId, appSecret: cfg.appSecret, loggerLevel: lark.LoggerLevel.warn });
    this.signer = new Signer(cfg.configDir);
    this.flow = new Flow(this.client, store, cfg.reviewers);
    this.flow.signer = this.signer;
    this.flow.review = new FeishuReview(this.client, { approval: cfg.approval, wiki: cfg.wiki });
    this.flow.nameOf = (u: string) => this.nameOf(u);
    this.flow.isAdmin = (u: string) => this.isAdmin(u);
  }

  async start(): Promise<void> {
    const info = await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }) as { bot?: { open_id?: string; app_name?: string } };
    this.botOpenId = info.bot?.open_id ?? '';
    if (!this.botOpenId) throw new Error('cannot resolve Amber bot open_id');
    log('bot', info.bot?.app_name, this.botOpenId);
    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (d: any) => { this.onMessage(d).catch(e => log('onMessage error', e?.message ?? e)); },
      'card.action.trigger': async (d: any) => this.onCardAction(d),
      'approval_instance': async (d: any) => {
        const code = d?.instance_code ?? d?.event?.instance_code;
        log('approval event', code, d?.status ?? d?.event?.status);
        if (code) this.flow.onApprovalEvent(String(code)).catch(e => log('approval handling failed', (e as Error).message));
      },
    } as any);
    this.ws.start({ eventDispatcher: dispatcher });
    log('long connection started');
    await this.resolveAdmins();
    await this.flow.loadReviewers();
    // Fallback for when approval events are not delivered: poll pending approvals.
    const poll = async () => {
      for (const code of this.store.pendingApprovalInstances()) {
        await this.flow.onApprovalEvent(code).catch(e => log('approval poll failed', code, (e as Error).message));
      }
    };
    await poll();
    setInterval(() => { poll().catch(() => {}); }, 60_000);
  }

  /** Emails are resolved through Amber's own app (needs contact:user.id:readonly); union_ids are taken as-is. */
  async resolveAdmins(): Promise<void> {
    const ids = new Set<string>();
    const emails: string[] = [];
    for (const a of this.cfg.admins) (a.startsWith('on_') ? ids.add(a) : emails.push(a));
    if (emails.length) {
      try {
        const r = await this.client.contact.v3.user.batchGetId({ params: { user_id_type: 'union_id' }, data: { emails } }) as any;
        const list: any[] = r?.data?.user_list ?? [];
        for (const e of emails) {
          const hit = list.find(u => u.email === e && u.user_id);
          if (hit) ids.add(hit.user_id); else log('admin email not resolved', e);
        }
      } catch (e: any) {
        log('admin email lookup failed (missing contact:user.id:readonly?)', e?.response?.data?.code ?? e?.message);
      }
    }
    this.adminUnionIds = ids;
    try {
      const emails = this.cfg.admins.filter(a => !a.startsWith('on_'));
      const r = emails.length ? await this.client.contact.v3.user.batchGetId({ params: { user_id_type: 'open_id' }, data: { emails } }) as any : null;
      this.flow.adminOpenIds = (r?.data?.user_list ?? []).map((u: any) => u.user_id).filter(Boolean);
    } catch { this.flow.adminOpenIds = []; }
    log('admins resolved', ids.size, 'of', this.cfg.admins.length, 'entries');
  }

  private isAdmin(unionId: string): boolean {
    return this.adminUnionIds.has(unionId);
  }

  /** Admin-only chat commands: change a command's scope, or list every command. Returns true when handled. */
  private async adminCommand(parts: string[], caller: Caller, messageId: string, inThread: boolean): Promise<boolean> {
    const verb = parts[0];
    const verbs = ['全局', '设为全局', '取消全局', '设为本地', '所有指令'];
    if (!verbs.includes(verb)) return false;
    if (!this.isAdmin(caller.unionId)) {
      await this.replyCard(messageId, inThread, errorCard('Amber', '只有管理员可以修改指令的执行范围'));
      return true;
    }
    if (verb === '所有指令') {
      const rows = this.store.listAll().filter(c => c.status === 'active');
      const lines = rows.map(c => `- **${c.name}**（${c.id}）· ${c.global ? '全局' : c.scopeType === 'p2p' ? '私聊' : '群'} · 创建于 ${c.chatId}`);
      await this.replyCard(messageId, inThread, infoCard('所有生效的指令', lines.join('\n') || '（没有）'));
      return true;
    }
    const target = parts[1];
    if (!target) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `用法：${verb} <指令名或 id>`));
      return true;
    }
    const all = this.store.listAll().filter(c => c.status === 'active');
    let cmd = all.find(c => c.id === target);
    if (!cmd) {
      const visible = visibleCommands(this.store, caller).filter(c => c.name === target);
      const sameName = all.filter(c => c.name === target);
      cmd = visible[0] ?? (sameName.length === 1 ? sameName[0] : undefined);
      if (!cmd && sameName.length > 1) {
        await this.replyCard(messageId, inThread, errorCard('Amber', `有 ${sameName.length} 条叫「${target}」的指令，请改用 id（发「所有指令」查看）`));
        return true;
      }
    }
    if (!cmd) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `没有找到指令「${target}」`));
      return true;
    }
    const toGlobal = verb === '全局' || verb === '设为全局';
    if (toGlobal && !cmd.global && this.store.listActiveGlobal().some(g => g.name === cmd!.name)) {
      await this.replyCard(messageId, inThread, errorCard('Amber', `已经有一条全局指令叫「${cmd.name}」，不能重名`));
      return true;
    }
    this.store.setGlobal(cmd.id, toGlobal);
    this.store.audit(caller.unionId, toGlobal ? 'scope.promote' : 'scope.demote', { id: cmd.id, name: cmd.name });
    log('scope', toGlobal ? 'promote' : 'demote', cmd.id, cmd.name);
    await this.replyCard(messageId, inThread, infoCard('执行范围已修改', toGlobal
      ? `「${cmd.name}」（${cmd.id}）已设为**全局**：Amber 所在的任何群和私聊都能使用。`
      : `「${cmd.name}」（${cmd.id}）已改回**只在创建处可用**。`));
    return true;
  }

  private firstTime(key: string): boolean {
    const now = Date.now();
    for (const [k, t] of this.seen) if (now - t > 10 * 60_000) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async chatType(chatId: string): Promise<'group' | 'p2p'> {
    const cached = this.chatTypeCache.get(chatId);
    if (cached) return cached;
    const r = await this.client.im.v1.chat.get({ path: { chat_id: chatId } }) as any;
    const mode = r?.data?.chat_mode === 'p2p' ? 'p2p' : 'group';
    this.chatTypeCache.set(chatId, mode);
    return mode;
  }

  private scopeLabel(caller: Caller): string {
    return caller.chatType === 'p2p' ? '你的私聊里' : '本群';
  }

  private async replyCard(messageId: string, inThread: boolean, card: object): Promise<void> {
    await this.client.im.v1.message.reply({
      path: { message_id: messageId },
      data: { msg_type: 'interactive', content: JSON.stringify(card), reply_in_thread: inThread },
    });
  }

  private async onMessage(d: any): Promise<void> {
    const msg = d.message;
    const sender = d.sender;
    if (!msg || !sender) return;
    if (sender.sender_type !== 'user') return; // bots never trigger Amber
    if (!this.firstTime(`m:${msg.message_id}`)) return;
    const chatType: 'group' | 'p2p' = msg.chat_type === 'p2p' ? 'p2p' : 'group';
    const mentions: any[] = msg.mentions ?? [];
    if (chatType === 'group' && !mentions.some(m => m?.id?.open_id === this.botOpenId)) return;
    if (msg.message_type !== 'text') return;
    let text = '';
    try { text = JSON.parse(msg.content).text ?? ''; } catch { return; }
    for (const m of mentions) text = text.split(m.key).join(' ');
    text = text.trim();
    const caller: Caller = {
      unionId: sender.sender_id?.union_id ?? '',
      openId: sender.sender_id?.open_id,
      chatId: msg.chat_id,
      chatType,
      channel: 'bot',
    };
    if (!caller.unionId) return;
    this.chatTypeCache.set(msg.chat_id, chatType);
    const inThread = !!msg.thread_id;
    log('message', chatType, msg.chat_id, inThread ? `thread ${msg.thread_id}` : '', JSON.stringify(text.slice(0, 80)));

    const parts = splitArgs(text);
    if (parts.length > 0 && await this.adminCommand(parts, caller, msg.message_id, inThread)) return;
    if (parts.length === 0 || ['帮助', 'help', '列表', 'list', '指令'].includes(parts[0].toLowerCase())) {
      await this.replyCard(msg.message_id, inThread, listCard(visibleCommands(this.store, caller), this.scopeLabel(caller)));
      return;
    }
    let cmd: CommandRow;
    try {
      cmd = findVisible(this.store, caller, parts[0].replace(/^\//, ''));
    } catch (e) {
      await this.replyCard(msg.message_id, inThread, errorCard('Amber', e instanceof AmberError ? e.message : '出错了'));
      return;
    }
    const positional = parts.slice(1);
    const raw: Record<string, string> = {};
    cmd.params.forEach((p, i) => { if (positional[i] !== undefined) raw[p.name] = positional[i]; });
    // confirm = true: never run from a one-line shortcut; show the confirmation form, prefilled.
    if (cmd.options.confirm || (positional.length === 0 && cmd.params.some(p => p.required && p.default === undefined))) {
      await this.replyCard(msg.message_id, inThread, formCard(cmd, raw));
      return;
    }
    // Reply with a "running" card first, then patch it with the result.
    const sent = await this.client.im.v1.message.reply({
      path: { message_id: msg.message_id },
      data: { msg_type: 'interactive', content: JSON.stringify(runningCard(cmd.name, caller.openId)), reply_in_thread: inThread },
    }) as any;
    const cardMessageId: string | undefined = sent?.data?.message_id;
    const final = await this.execute(cmd, raw, caller);
    if (cardMessageId) await this.patch(cardMessageId, final);
  }

  private async execute(cmd: CommandRow, raw: Record<string, string | undefined>, caller: Caller, viaForm = false): Promise<object> {
    try {
      const r = await runCommand(this.store, cmd, raw, caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }, { viaForm });
      if (!r.ok) return errorCard(cmd.name, `执行失败：${r.error}`, cmd.id);
      return resultCard(cmd.name, caller.openId, r.blocks, r.runId, r.elapsedMs, cmd.id);
    } catch (e) {
      return errorCard(cmd.name, e instanceof AmberError ? e.message : `出错了：${(e as Error).message}`, cmd.id);
    }
  }

  private nameCache = new Map<string, string>();

  async nameOf(unionId: string): Promise<string | undefined> {
    if (this.nameCache.has(unionId)) return this.nameCache.get(unionId);
    try {
      const r = await this.client.contact.v3.user.get({ path: { user_id: unionId }, params: { user_id_type: 'union_id' } }) as any;
      const n = r?.data?.user?.name;
      if (n) this.nameCache.set(unionId, n);
      return n;
    } catch { return undefined; }
  }

  private cityCache = new Map<string, { city?: string; at: number }>();

  /** Office city from the Feishu directory, via Amber's own app. Needs the contact permission for city/work_station. */
  async cityOf(unionId: string): Promise<string | undefined> {
    const hit = this.cityCache.get(unionId);
    if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.city;
    let city: string | undefined;
    try {
      const r = await this.client.contact.v3.user.get({ path: { user_id: unionId }, params: { user_id_type: 'union_id' } }) as any;
      const u = r?.data?.user ?? {};
      city = (u.city || u.work_station || '').trim() || undefined;
    } catch (e: any) {
      log('city lookup failed', e?.response?.data?.code ?? e?.message);
    }
    this.cityCache.set(unionId, { city, at: Date.now() });
    return city;
  }

  private async patch(messageId: string, card: object): Promise<void> {
    try {
      await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } });
    } catch (e: any) {
      log('patch failed', messageId, e?.response?.data ? JSON.stringify(e.response.data) : e?.message);
    }
  }

  private async onCardAction(d: any): Promise<object | undefined> {
    const op = d.operator ?? {};
    const value = d.action?.value ?? {};
    const chatId: string | undefined = d.context?.open_chat_id;
    const messageId: string | undefined = d.context?.open_message_id;
    if (!op.union_id || !chatId) return { toast: { type: 'error', content: '无法识别操作人' } };
    const key = `a:${d.event_id ?? ''}:${messageId}:${JSON.stringify(value)}:${op.union_id}`;
    if (d.event_id && !this.firstTime(key)) return undefined;
    const caller: Caller = { unionId: op.union_id, openId: op.open_id, chatId, chatType: await this.chatType(chatId), channel: 'bot' };
    log('card action', value.a, value.c ?? '', caller.chatType, chatId);
    const raw = (card: object) => ({ card: { type: 'raw', data: card } });
    try {
      if (value.a === 'claim_try') {
        // Trial runs can take longer than the callback window: answer now, patch the card when done.
        this.flow.checkClaimer(String(value.c), caller);
        setTimeout(async () => {
          let card: object;
          try { card = await this.flow.onClaimAction('claim_try', String(value.c), caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }, d.action?.form_value ?? {}); }
          catch (e) { card = errorCard('Amber', e instanceof AmberError ? e.message : '试运行出错'); }
          if (messageId) await this.patch(messageId, card);
        }, 300);
        return { toast: { type: 'info', content: '试运行中，结果会更新在这张卡片上' } };
      }
      if (typeof value.a === 'string' && value.a.startsWith('claim_')) {
        return raw(await this.flow.onClaimAction(value.a, String(value.c), caller, { city: () => this.cityOf(caller.unionId), signer: this.signer }));
      }
      if (value.a === 'review_ok' || value.a === 'review_no') {
        const reason = String(d.action?.form_value?.reason ?? '');
        return raw(await this.flow.onReviewAction(value.a, String(value.c), String(value.h), reason, caller));
      }
      if (value.a === 'list') return raw(listCard(visibleCommands(this.store, caller), this.scopeLabel(caller)));
      if (value.a === 'pick') return raw(formCard(findVisible(this.store, caller, String(value.c))));
      if (value.a === 'run') {
        const cmd = findVisible(this.store, caller, String(value.c));
        const form: Record<string, string> = d.action?.form_value ?? {};
        // Respond within the callback window, then patch the card when execution finishes.
        setTimeout(async () => {
          const final = await this.execute(cmd, form, caller, true);
          if (messageId) await this.patch(messageId, final);
        }, 300);
        return raw(runningCard(cmd.name, caller.openId));
      }
      return { toast: { type: 'warning', content: '未知操作' } };
    } catch (e) {
      // Keep the card as it is (others may still need it); tell only the clicker.
      log('card action rejected', value.a, e instanceof AmberError ? e.code : (e as Error).message);
      return { toast: { type: 'error', content: e instanceof AmberError ? e.message : '出错了' } };
    }
  }
}
