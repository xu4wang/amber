// Test environment: a complete Amber (bot, scheduler, agent API, website) on a temp data dir,
// talking to a fake Feishu. Helpers simulate people sending messages and clicking cards.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAmber, type Amber } from '../src/app.ts';
import type { AmberConfig } from '../src/config.ts';
import { FakeFeishu, fakeWs, type User } from './fake-feishu.ts';

export const GROUP = 'oc_testgroup1';

/** A port the OS reports free right now. Test files run in parallel; fixed or random ranges collided (EADDRINUSE). */
async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const p = (srv.address() as { port: number }).port; srv.close(() => resolve(p)); });
  });
}

export interface Env {
  amber: Amber; fake: FakeFeishu; cfg: AmberConfig;
  alice: User; bob: User; carol: User;
  apiPort: number; webPort: number;
  dmChat(u: User): string;
  dm(u: User, text: string): Promise<void>;
  say(u: User, chatId: string, text: string, opts?: { threadRoot?: string }): Promise<string>;
  click(u: User, messageId: string, value: Record<string, string>, form?: Record<string, string>): Promise<any>;
  api(method: string, path: string, body?: unknown, ip?: string): Promise<{ status: number; body: any }>;
  submit(draft: Record<string, unknown>): Promise<any>;
  approveLatest(): Promise<void>;
  waitFor<T>(f: () => T | undefined | false, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export function button(card: any, action: string): Record<string, string> | undefined {
  let found: any;
  const walk = (o: any) => {
    if (!o || typeof o !== 'object' || found) return;
    if (Array.isArray(o.behaviors)) for (const b of o.behaviors) if (b?.value?.a === action) { found = b.value; return; }
    for (const v of Object.values(o)) walk(v);
  };
  walk(card);
  return found;
}

export function urlButton(card: any): string | undefined {
  const m = /"default_url":"([^"]+)"/.exec(JSON.stringify(card));
  return m?.[1];
}

export async function makeEnv(over: Partial<AmberConfig> = {}): Promise<Env> {
  const dir = mkdtempSync(join(tmpdir(), 'amber-test-'));
  const fake = new FakeFeishu();
  const mk = (name: string, city?: string): User => ({ email: `${name}@example.com`, unionId: `on_${name}`, openId: `ou_${name}`, name, city });
  const alice = mk('alice', '上海'), bob = mk('bob', '曼谷'), carol = mk('carol');
  fake.users.push(alice, bob, carol);
  fake.chats.set(GROUP, { mode: 'group', name: '测试群', members: new Set(['BOT', alice.unionId, bob.unionId]) });
  for (const u of [alice, bob, carol]) fake.chats.set(`oc_dm_${u.unionId}`, { mode: 'p2p', name: '', members: new Set(['BOT', u.unionId]) });
  const apiPort = await freePort(), webPort = await freePort();
  const cfg: AmberConfig = {
    appId: 'cli_test', appSecret: 'secret', dataDir: join(dir, 'data'), configDir: dir,
    reviewers: [alice.email], admins: [alice.email], services: {},
    machines: { '127.0.0.1': 'local', '10.0.0.2': 'fleet-b' },
    approval: { code: fake.approvalCode, reviewNodeId: 'node-review', formFieldId: 'widget-text' },
    wiki: { spaceId: 'space', parentNodeToken: 'parent', baseUrl: 'https://wiki.example/wiki/' },
    webBaseUrl: `http://127.0.0.1:${webPort}`, timezones: [{ tz: 'Asia/Shanghai', label: '北京时间' }],
    ...over,
  };
  const { mkdirSync } = await import('node:fs');
  mkdirSync(cfg.dataDir, { recursive: true });
  const origLog = console.log;
  console.log = () => {};   // keep test output clean
  const amber = await startAmber(cfg, { apiPort, webPort, client: fake, ws: fakeWs, timers: false });
  await new Promise(r => setTimeout(r, 50));
  const bot = amber.bot as any;
  const msgChat = new Map<string, string>();
  const chatOfMessage = (id: string): string | undefined => {
    if (msgChat.has(id)) return msgChat.get(id);
    const s = fake.sent.find(x => x.id === id);
    if (!s) return undefined;
    if (s.to.chatId) return s.to.chatId;
    if (s.to.unionId) return `oc_dm_${s.to.unionId}`;
    if (s.to.replyTo) return chatOfMessage(s.to.replyTo);
    return undefined;
  };
  const event = (u: User, chatId: string, text: string, mention: boolean, threadRoot?: string) => {
    const id = fake.id('om');
    msgChat.set(id, chatId);
    const mode = fake.chats.get(chatId)!.mode;
    return {
      id,
      ev: {
        sender: { sender_type: 'user', sender_id: { union_id: u.unionId, open_id: u.openId } },
        message: {
          message_id: id, chat_id: chatId, chat_type: mode, message_type: 'text', thread_id: threadRoot ? 'th_' + threadRoot : undefined,
          content: JSON.stringify({ text: mention ? `@_user_1 ${text}` : text }),
          mentions: mention ? [{ key: '@_user_1', id: { open_id: fake.botOpenId } }] : [],
        },
      },
    };
  };
  const env: Env = {
    amber, fake, cfg, alice, bob, carol, apiPort, webPort,
    dmChat: u => `oc_dm_${u.unionId}`,
    dm: async (u, text) => { await bot.onMessage(event(u, `oc_dm_${u.unionId}`, text, false).ev); },
    say: async (u, chatId, text, o = {}) => { const e = event(u, chatId, text, true, o.threadRoot); await bot.onMessage(e.ev); return e.id; },
    click: async (u, messageId, value, form) => bot.onCardAction({
      event_id: fake.id('ev'),
      operator: { union_id: u.unionId, open_id: u.openId },
      action: { value, form_value: form ?? {} },
      context: { open_chat_id: chatOfMessage(messageId), open_message_id: messageId },
    }),
    api: async (method, path, body, ip) => {
      const r = await fetch(`http://127.0.0.1:${apiPort}${path}`, {
        method, headers: { 'content-type': 'application/json', ...(ip ? { 'x-amber-client-ip': ip } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    },
    submit: async draft => (await env.api('POST', '/v1/drafts', { submittedBy: 'TestBot', ...draft })).body,
    approveLatest: async () => {
      const code = [...fake.approvals.keys()].pop()!;
      const a = fake.approvals.get(code)!;
      fake.decide(code, Object.fromEntries(a.tasks.map(t => [t.open_id, 'APPROVED' as const])));
      await amber.bot.flow.onApprovalEvent(code);
    },
    waitFor: async (f, ms = 15000) => {
      const end = Date.now() + ms;
      for (;;) {
        const v = f();
        if (v) return v as any;
        if (Date.now() > end) throw new Error('waitFor timed out');
        await new Promise(r => setTimeout(r, 50));
      }
    },
    close: async () => { await amber.close(); console.log = origLog; rmSync(dir, { recursive: true, force: true }); },
  };
  return env;
}

/** A small Python script for test commands. */
export function script(code: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: 'script', lang: 'python', code, timeoutMs: 15000, ...extra };
}

/** Take a draft through claim → trial → submit → approval, as `owner`. Returns the command id. */
export async function activate(env: Env, draft: Record<string, unknown>, owner: User, trialForm?: Record<string, string>): Promise<string> {
  const r = await env.submit(draft);
  if (!r.ok) throw new Error('submit failed: ' + JSON.stringify(r));
  const claim = r.claimMessageId as string;
  await env.click(owner, claim, { a: 'claim_try', c: r.id }, trialForm);
  try { await env.waitFor(() => button(env.fake.cardOf(claim), 'claim_submit')); }
  catch (e) { throw new Error(`trial did not finish: ${FakeFeishu.text(env.fake.cardOf(claim)).slice(-600)}`); }
  await env.click(owner, claim, { a: 'claim_submit', c: r.id });
  await env.approveLatest();
  const c = env.amber.store.getCommand(r.id)!;
  if (c.status !== 'active') throw new Error('not active: ' + c.status);
  return r.id;
}
