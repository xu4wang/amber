// A fake Feishu for tests: records every message, card and patch; answers directory, chat,
// approval and wiki calls from in-memory data. Nothing leaves the process.
export interface User { email: string; unionId: string; openId: string; name: string; city?: string }

export interface Sent { id: string; to: { chatId?: string; unionId?: string; replyTo?: string }; inThread?: boolean; card: any; at: number }

export class FakeFeishu {
  users: User[] = [];
  chats = new Map<string, { mode: 'group' | 'p2p'; name: string; members: Set<string> }>();   // members: union_ids
  sent: Sent[] = [];
  patches: { id: string; card: any }[] = [];
  approvals = new Map<string, { approvalCode: string; status: string; tasks: { open_id: string; status: string }[]; title?: string; form?: string }>();
  docs = new Map<string, string[]>();          // doc id -> markdown chunks
  membersApiAllowed = true;
  private n = 0;
  readonly botOpenId = 'ou_amberbot';
  approvalCode = 'APPROVAL-CODE';
  approvalDelayMs = 0;                         // slow approval creation, to test the card callback window
  approvalFails = false;

  id(prefix: string): string { return `${prefix}_${(++this.n).toString().padStart(6, '0')}`; }
  userByEmail(e: string) { return this.users.find(u => u.email === e); }
  userByUnion(u: string) { return this.users.find(x => x.unionId === u); }
  userByOpen(o: string) { return this.users.find(x => x.openId === o); }

  /** Latest version of a sent card (after patches). */
  cardOf(messageId: string): any {
    const p = [...this.patches].reverse().find(x => x.id === messageId);
    return p ? p.card : this.sent.find(s => s.id === messageId)?.card;
  }
  /** All text in a card, for assertions. */
  static text(card: any): string { return JSON.stringify(card ?? {}); }
  lastTo(pred: (s: Sent) => boolean): Sent | undefined { return [...this.sent].reverse().find(pred); }

  private fail(code: number, msg: string): never {
    const e: any = new Error(msg); e.response = { data: { code, msg } }; throw e;
  }

  private record(to: Sent['to'], content: string, inThread?: boolean): { data: { message_id: string } } {
    const target = to.chatId ? this.chats.get(to.chatId) : undefined;
    if (to.chatId && (!target || !target.members.has('BOT'))) this.fail(230002, 'Bot/User can NOT be out of the chat.');
    const card = JSON.parse(content);
    const id = this.id('om');
    this.sent.push({ id, to, inThread, card, at: Date.now() });
    return { data: { message_id: id } };
  }

  // ---- SDK shape used by Amber
  im = {
    v1: {
      message: {
        reply: async ({ path, data }: any) => this.record({ replyTo: path.message_id }, data.content, data.reply_in_thread),
        create: async ({ params, data }: any) => this.record(params.receive_id_type === 'union_id' ? { unionId: data.receive_id } : { chatId: data.receive_id }, data.content),
        patch: async ({ path, data }: any) => { this.patches.push({ id: path.message_id, card: JSON.parse(data.content) }); return {}; },
      },
      chat: {
        get: async ({ path }: any) => {
          const c = this.chats.get(path.chat_id);
          if (!c) this.fail(232011, 'chat not found');
          return { data: { chat_mode: c.mode, name: c.name } };
        },
      },
    },
  };

  contact = {
    v3: {
      user: {
        batchGetId: async ({ params, data }: any) => ({
          data: { user_list: (data.emails as string[]).map(e => {
            const u = this.userByEmail(e);
            return { email: e, user_id: u ? (params.user_id_type === 'union_id' ? u.unionId : u.openId) : undefined };
          }) },
        }),
        get: async ({ path }: any) => {
          const u = this.userByUnion(path.user_id);
          if (!u) this.fail(41050, 'no user');
          return { data: { user: { name: u.name, city: u.city, open_id: u.openId, union_id: u.unionId } } };
        },
      },
    },
  };

  async request({ method, url, data, params }: any): Promise<any> {
    if (url === '/open-apis/bot/v3/info') return { bot: { open_id: this.botOpenId, app_name: 'amber-test' } };
    let m: RegExpExecArray | null;
    if ((m = /^\/open-apis\/im\/v1\/chats\/([^/]+)\/members$/.exec(url))) {
      if (!this.membersApiAllowed) this.fail(99991672, 'Access denied');
      const c = this.chats.get(m[1]);
      if (!c) this.fail(232011, 'Operator can NOT be out of the chat.');
      return { data: { items: [...c.members].filter(x => x !== 'BOT').map(u => ({ member_id: u })), has_more: false } };
    }
    if (method === 'POST' && /^\/open-apis\/wiki\/v2\/spaces\/[^/]+\/nodes$/.test(url)) {
      const doc = this.id('doc'); this.docs.set(doc, [`TITLE:${data.title}`]);
      return { data: { node: { obj_token: doc, node_token: this.id('wik') } } };
    }
    if (url === '/open-apis/docx/v1/documents/blocks/convert') return { data: { blocks: [{ block_id: 'b1', md: data.content }], first_level_block_ids: ['b1'] } };
    if ((m = /^\/open-apis\/docx\/v1\/documents\/([^/]+)\/blocks\/[^/]+\/descendant$/.exec(url))) {
      this.docs.get(m[1])?.push(...data.descendants.map((b: any) => b.md));
      return { data: {} };
    }
    if (method === 'POST' && url === '/open-apis/approval/v4/instances') {
      if (this.approvalDelayMs) await new Promise(r => setTimeout(r, this.approvalDelayMs));
      if (this.approvalFails) this.fail(1390001, 'approval unavailable');
      const code = this.id('INST');
      const approvers: string[] = data.node_approver_open_id_list?.[0]?.value ?? [];
      this.approvals.set(code, { approvalCode: data.approval_code, status: 'PENDING', tasks: approvers.map(o => ({ open_id: o, status: 'PENDING' })), title: data.title, form: data.form });
      return { data: { instance_code: code } };
    }
    if ((m = /^\/open-apis\/approval\/v4\/instances\/([^/]+)$/.exec(url))) {
      const a = this.approvals.get(m[1]);
      if (!a) this.fail(1390001, 'no instance');
      return { data: { approval_code: a.approvalCode, status: a.status, task_list: a.tasks, comment_list: [] } };
    }
    throw new Error(`fake feishu: unhandled ${method} ${url}`);
  }

  /** Reviewers act in the Feishu approval app. */
  decide(instance: string, decisions: Record<string, 'APPROVED' | 'REJECTED'>): void {
    const a = this.approvals.get(instance)!;
    for (const t of a.tasks) if (decisions[t.open_id]) t.status = decisions[t.open_id];
    a.status = a.tasks.some(t => t.status === 'REJECTED') ? 'REJECTED' : a.tasks.every(t => t.status === 'APPROVED') ? 'APPROVED' : 'PENDING';
  }
}

export const fakeWs = { start: () => {} };
