// Draft → claim → review → active.
// - A draft is submitted by an agent through the local API (machine credential). Nothing in it is trusted.
// - Claiming establishes the creator: the clicker on the claim card (identity from Feishu), who must
//   first run a successful trial with their own identity.
// - Every configured reviewer must approve the exact spec_hash (D16); any reject rejects.
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Store, CommandRow, ParamDef, StepDef } from './db.ts';
import { computeSpecHash } from './db.ts';
import type { ExecutorRegistry } from './executors.ts';
import type { Caller, CallerFacts, Block } from './engine.ts';
import { runCommand, AmberError } from './engine.ts';
import { sanitizeMarkdown, person, renderBlocks } from './cards.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

export interface DraftInput {
  chatId: string;
  chatType: 'group' | 'p2p';
  name: string;
  description?: string;
  params: ParamDef[];
  steps: StepDef[];
  /** Message to reply under (keeps the claim card in the thread where the work happened). */
  originMessageId?: string;
  /** Whether originMessageId lives in a thread (then the claim card is posted into that thread). */
  inThread?: boolean;
  /** p2p drafts: who must claim. Email or union_id. */
  claimer?: string;
  submittedBy?: string;
}

function shell(title: string, template: string, elements: unknown[]): object {
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template }, body: { elements } };
}
function btn(text: string, value: Record<string, string>, type: 'primary' | 'default' | 'danger' = 'default', extra: Record<string, unknown> = {}): object {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }], ...extra };
}

function specSummary(c: CommandRow, executors: ExecutorRegistry): string {
  const params = c.params.length
    ? c.params.map(p => `${p.label ?? p.name}（${p.type === 'integer' ? '整数' : '文本'}${p.defaultFrom === 'caller.city' ? '，默认办公城市' : p.default !== undefined ? `，默认 ${p.default}` : ''}${p.required ? '，必填' : ''}）`).join('、')
    : '无';
  const steps = c.steps.map((s, i) => {
    const d = executors.get(s.executor);
    return `${i + 1}. 执行器 \`${s.executor}\`${d ? '' : '（**未登记**）'}${s.render?.kind === 'line' ? ' → 折线图' : ''}`;
  }).join('\n');
  return [
    `**名称**：${sanitizeMarkdown(c.name, 40)}`,
    `**说明**：${sanitizeMarkdown(c.description || '（无）', 200)}`,
    `**范围**：${c.scopeType === 'p2p' ? '私聊（只有创建人）' : '本群'}`,
    `**参数**：${sanitizeMarkdown(params, 300)}`,
    `**类型**：${c.sideEffect === 'write' ? '<font color="red">写操作</font>' : '只读'}`,
    `**步骤**：\n${steps}`,
  ].join('\n');
}

export function claimCard(c: CommandRow, executors: ExecutorRegistry, trial?: { by?: string; blocks?: Block[]; error?: string }, submittedBy?: string): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `${submittedBy ? `**${sanitizeMarkdown(submittedBy, 80)}**` : 'agent'} 提交了一条新指令，等待认领。认领人会成为这条指令的创建人，提交后由审核人审核。\n<font color="grey">请确认这是你让 agent 做的；不认识的草稿直接点「丢弃」。</font>` },
    { tag: 'markdown', content: specSummary(c, executors) },
  ];
  if (trial?.error) els.push({ tag: 'markdown', content: `❌ 试运行失败：${sanitizeMarkdown(trial.error, 300)}` });
  if (trial?.blocks) {
    els.push({ tag: 'markdown', content: `**试运行结果**（由 ${person(trial.by)} 执行）` });
    els.push(...renderBlocks(trial.blocks));
  }
  const buttons: unknown[] = [btn('试运行', { a: 'claim_try', c: c.id }, trial?.blocks ? 'default' : 'primary')];
  if (trial?.blocks) buttons.push(btn('提交审核', { a: 'claim_submit', c: c.id }, 'primary'));
  buttons.push(btn('丢弃', { a: 'claim_drop', c: c.id }, 'danger'));
  els.push({ tag: 'column_set', flex_mode: 'flow', columns: buttons.map(b => ({ tag: 'column', width: 'auto', elements: [b] })) });
  return shell(`待认领：${c.name}`, 'orange', els);
}

export function reviewCard(c: CommandRow, executors: ExecutorRegistry, creatorOpenIdForReviewer: string | undefined, state: { approved: number; total: number; mine?: string }): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `请审核这条指令。需要 **全部 ${state.total} 位**审核人通过才生效，目前已通过 ${state.approved} 位。` },
    { tag: 'markdown', content: specSummary(c, executors) },
    { tag: 'markdown', content: `**创建人**：${person(creatorOpenIdForReviewer)}　**spec**：\`${c.specHash.slice(0, 12)}\`` },
  ];
  if (state.mine === 'approve') els.push({ tag: 'markdown', content: '✅ 你已通过' });
  else if (state.mine === 'reject') els.push({ tag: 'markdown', content: '❌ 你已驳回' });
  else {
    els.push({
      tag: 'form', name: 'review', elements: [
        { tag: 'input', name: 'reason', label: { tag: 'plain_text', content: '驳回原因' }, label_position: 'left', placeholder: { tag: 'plain_text', content: '驳回时填写' } },
        { tag: 'column_set', flex_mode: 'flow', columns: [
          { tag: 'column', width: 'auto', elements: [btn('通过', { a: 'review_ok', c: c.id, h: c.specHash }, 'primary', { form_action_type: 'submit', name: 'ok' })] },
          { tag: 'column', width: 'auto', elements: [btn('驳回', { a: 'review_no', c: c.id, h: c.specHash }, 'danger', { form_action_type: 'submit', name: 'no' })] },
        ] },
      ],
    });
  }
  return shell(`审核：${c.name}`, 'purple', els);
}

export class Flow {
  private client: lark.Client;
  private store: Store;
  private executors: ExecutorRegistry;
  private reviewerEmails: string[];
  reviewers: string[] = [];

  constructor(client: lark.Client, store: Store, executors: ExecutorRegistry, reviewerEmails: string[]) {
    this.client = client;
    this.store = store;
    this.executors = executors;
    this.reviewerEmails = reviewerEmails;
  }

  async resolveEmails(entries: string[]): Promise<{ ids: string[]; missing: string[] }> {
    const ids: string[] = [];
    const emails: string[] = [];
    for (const e of entries) (e.startsWith('on_') ? ids.push(e) : emails.push(e));
    const missing: string[] = [];
    if (emails.length) {
      try {
        const r = await (this.client as any).contact.v3.user.batchGetId({ params: { user_id_type: 'union_id' }, data: { emails } });
        const list: any[] = r?.data?.user_list ?? [];
        for (const e of emails) {
          const hit = list.find(u => u.email === e && u.user_id);
          if (hit) ids.push(hit.user_id); else missing.push(e);
        }
      } catch {
        missing.push(...emails);
      }
    }
    return { ids: [...new Set(ids)], missing };
  }

  /** D19: any unresolved reviewer disables review entirely instead of silently shrinking the list. */
  async loadReviewers(): Promise<void> {
    const { ids, missing } = await this.resolveEmails(this.reviewerEmails);
    if (missing.length) {
      this.reviewers = [];
      log('REVIEW DISABLED: reviewer emails not resolved', missing.join(','));
      return;
    }
    this.reviewers = ids;
    log('reviewers resolved', ids.length);
  }

  private async send(receive: { chatId?: string; unionId?: string; replyTo?: string; inThread?: boolean }, card: object): Promise<string | undefined> {
    const content = JSON.stringify(card);
    if (receive.replyTo) {
      const r = await this.client.im.v1.message.reply({ path: { message_id: receive.replyTo }, data: { msg_type: 'interactive', content, reply_in_thread: !!receive.inThread } }) as any;
      return r?.data?.message_id;
    }
    const r = await this.client.im.v1.message.create({
      params: { receive_id_type: receive.unionId ? 'union_id' : 'chat_id' },
      data: { receive_id: receive.unionId ?? receive.chatId!, msg_type: 'interactive', content },
    }) as any;
    return r?.data?.message_id;
  }

  async patch(messageId: string, card: object): Promise<void> {
    try { await this.client.im.v1.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card) } }); }
    catch (e: any) { log('patch failed', messageId, e?.response?.data?.code ?? e?.message); }
  }

  async submitDraft(d: DraftInput): Promise<{ id: string; claimMessageId?: string }> {
    if (!/^oc_[A-Za-z0-9]+$/.test(d.chatId)) throw new AmberError('bad_chat', 'chatId 格式不对');
    if (!d.submittedBy || d.submittedBy.length > 80) throw new AmberError('bad_submitter', '请注明提交来源（submittedBy，例如「Beta（botmux @ dev-beta）」）');
    if (!d.name || d.name.length > 40 || /\s/.test(d.name)) throw new AmberError('bad_name', '名称不能为空、不能有空格、最多 40 个字');
    if (!Array.isArray(d.steps) || d.steps.length === 0 || d.steps.length > 8) throw new AmberError('bad_steps', '步骤数要在 1–8 之间');
    for (const s of d.steps) if (!this.executors.get(s.executor)) throw new AmberError('unknown_executor', `执行器 ${s.executor} 未登记，请先由运维登记`);
    if (this.store.nameTaken(d.chatId, d.name)) throw new AmberError('name_taken', `这里已经有一条叫「${d.name}」的指令（生效中或待审核）`);
    const sideEffect = d.steps.some(s => this.executors.get(s.executor)?.sideEffect === 'write') ? 'write' : 'read';
    let expectedClaimer: string | undefined;
    if (d.chatType === 'p2p') {
      if (!d.claimer) throw new AmberError('claimer_required', '私聊草稿需要指定认领人（email）');
      const { ids } = await this.resolveEmails([d.claimer]);
      if (!ids[0]) throw new AmberError('claimer_unresolved', `找不到认领人 ${d.claimer}`);
      expectedClaimer = ids[0];
      // Anti-spam: an agent picks the claimer for p2p drafts, so cap how many claim cards one person can receive.
      if (this.store.recentDraftsFor(expectedClaimer, 3600_000) >= 5) throw new AmberError('rate_limited', '这位认领人一小时内已收到 5 张认领卡，请稍后再提交');
    }
    const row = this.store.insertCommand({
      scopeType: d.chatType, chatId: d.chatId, ownerUnionId: expectedClaimer ?? '', name: d.name, description: d.description ?? '',
      params: d.params ?? [], steps: d.steps, sideEffect, status: 'draft',
    });
    this.store.setMeta(row.id, { expectedClaimer: expectedClaimer ?? null, originMessageId: d.originMessageId ?? null, submittedBy: d.submittedBy ?? null });
    this.store.audit(null, 'draft.submit', { id: row.id, name: row.name, chatId: row.chatId, chatType: d.chatType, submittedBy: d.submittedBy, specHash: row.specHash });
    // Group: claim card in the group (only members can click). p2p: Amber can't enter the agent's DM, so the claim card goes to the claimer's DM with Amber.
    let claimMessageId: string | undefined;
    try {
      claimMessageId = d.chatType === 'p2p'
        ? await this.send({ unionId: expectedClaimer }, claimCard(row, this.executors, undefined, d.submittedBy))
        : await this.send(d.originMessageId ? { replyTo: d.originMessageId, inThread: !!d.inThread } : { chatId: d.chatId }, claimCard(row, this.executors, undefined, d.submittedBy));
    } catch (e: any) {
      const code = e?.response?.data?.code;
      this.store.setStatus(row.id, 'rejected');
      throw new AmberError('claim_card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `认领卡发送失败：${code ?? e?.message}`);
    }
    if (claimMessageId) this.store.setMeta(row.id, { claimMessageId });
    log('draft submitted', row.id, row.name, d.chatType, d.chatId);
    return { id: row.id, claimMessageId };
  }

  /** Fast pre-check used before answering a card callback. */
  checkClaimer(cmdId: string, caller: Caller): void {
    const c = this.store.getCommand(cmdId);
    if (!c || c.status !== 'draft') throw new AmberError('stale', '这张认领卡已失效');
    const meta = this.store.getMeta(c.id);
    if (meta.expectedClaimer && meta.expectedClaimer !== caller.unionId) throw new AmberError('not_claimer', '只有指定的认领人可以操作');
    if (c.scopeType === 'group' && caller.chatId !== c.chatId) throw new AmberError('wrong_chat', '只能在草稿所属的群里认领');
  }

  /** Claim-card actions. `caller.chatId` is the chat where the card was clicked. */
  async onClaimAction(action: string, cmdId: string, caller: Caller, facts: CallerFacts): Promise<object> {
    const c = this.store.getCommand(cmdId);
    if (!c || c.status !== 'draft') return shell('Amber', 'grey', [{ tag: 'markdown', content: '这张认领卡已失效（草稿已提交、丢弃或不存在）。' }]);
    const meta = this.store.getMeta(c.id);
    if (meta.expectedClaimer && meta.expectedClaimer !== caller.unionId) throw new AmberError('not_claimer', '只有指定的认领人可以操作');
    if (c.scopeType === 'group' && caller.chatId !== c.chatId) throw new AmberError('wrong_chat', '只能在草稿所属的群里认领');
    if (action === 'claim_drop') {
      this.store.setStatus(c.id, 'rejected');
      this.store.audit(caller.unionId, 'draft.drop', { id: c.id });
      return shell(`已丢弃：${c.name}`, 'grey', [{ tag: 'markdown', content: `由 ${person(caller.openId)} 丢弃。` }]);
    }
    if (action === 'claim_try') {
      try {
        const r = await runCommand(this.store, this.executors, c, {}, caller, facts, { trial: true });
        if (!r.ok) return claimCard(c, this.executors, { error: r.error }, meta.submittedBy);
        this.store.setMeta(c.id, { trialBy: caller.unionId });
        return claimCard(c, this.executors, { by: caller.openId, blocks: r.blocks }, meta.submittedBy);
      } catch (e) {
        return claimCard(c, this.executors, { error: e instanceof AmberError ? e.message : (e as Error).message }, meta.submittedBy);
      }
    }
    if (action === 'claim_submit') {
      if (meta.trialBy !== caller.unionId) throw new AmberError('trial_first', '请先由你本人试运行成功，再提交审核');
      if (computeSpecHash(c) !== c.specHash) throw new AmberError('spec_mismatch', '定义已变化，请重新提交');
      if (this.reviewers.length === 0) throw new AmberError('no_reviewers', '审核人名单未配置或无法解析，暂时不能提交审核');
      this.store.setMeta(c.id, { ownerUnionId: caller.unionId, ownerOpenId: caller.openId ?? null });
      this.store.setStatus(c.id, 'pending');
      this.store.audit(caller.unionId, 'draft.claim', { id: c.id, specHash: c.specHash });
      const fresh = this.store.getCommand(c.id)!;
      for (const r of this.reviewers) {
        try { await this.send({ unionId: r }, reviewCard(fresh, this.executors, caller.openId, { approved: 0, total: this.reviewers.length })); }
        catch (e: any) { log('review card send failed', r.slice(0, 8), e?.response?.data?.code ?? e?.message); }
      }
      return shell(`审核中：${c.name}`, 'yellow', [
        { tag: 'markdown', content: `${person(caller.openId)} 已认领并提交审核。需要 ${this.reviewers.length} 位审核人全部通过后生效。` },
      ]);
    }
    throw new AmberError('unknown', '未知操作');
  }

  async onReviewAction(action: string, cmdId: string, specHash: string, reason: string, caller: Caller): Promise<object> {
    if (!this.reviewers.includes(caller.unionId)) throw new AmberError('not_reviewer', '你不在审核人名单里');
    const c = this.store.getCommand(cmdId);
    if (!c) throw new AmberError('not_found', '指令不存在');
    if (c.status !== 'pending' || c.specHash !== specHash) {
      return shell(`审核：${c.name}`, 'grey', [{ tag: 'markdown', content: '这张审核卡已失效（指令已生效、被驳回，或审核期间被修改）。' }]);
    }
    if (action === 'review_no' && !reason.trim()) throw new AmberError('reason_required', '驳回请填写原因');
    const decision = action === 'review_ok' ? 'approve' : 'reject';
    this.store.recordReview(c.id, c.specHash, caller.unionId, decision, decision === 'reject' ? reason.trim() : null);
    this.store.audit(caller.unionId, `review.${decision}`, { id: c.id, specHash: c.specHash, reason: decision === 'reject' ? reason.trim() : undefined });
    const reviews = this.store.reviewsFor(c.id, c.specHash).filter(r => this.reviewers.includes(r.reviewer));
    const approved = reviews.filter(r => r.decision === 'approve').length;
    const meta = this.store.getMeta(c.id);
    if (decision === 'reject') {
      this.store.setStatus(c.id, 'rejected');
      if (meta.claimMessageId) await this.patch(meta.claimMessageId, shell(`已驳回：${c.name}`, 'red', [{ tag: 'markdown', content: `审核人驳回：${sanitizeMarkdown(reason.trim(), 300)}` }]));
    } else if (approved >= this.reviewers.length) {
      this.store.setStatus(c.id, 'active');
      this.store.audit(null, 'command.active', { id: c.id, specHash: c.specHash });
      const where = c.scopeType === 'p2p' ? '在你和 Amber 的私聊里' : '在本群 @Amber';
      if (meta.claimMessageId) await this.patch(meta.claimMessageId, shell(`已生效：${c.name}`, 'green', [
        { tag: 'markdown', content: `✅ 指令「${sanitizeMarkdown(c.name, 40)}」已通过全部 ${this.reviewers.length} 位审核人的审核，现已生效。${where}发「${sanitizeMarkdown(c.name, 40)}」即可使用。` },
      ]));
    } else if (meta.claimMessageId) {
      await this.patch(meta.claimMessageId, shell(`审核中：${c.name}`, 'yellow', [{ tag: 'markdown', content: `已提交审核，**${approved} / ${this.reviewers.length}** 位审核人已通过。` }]));
    }
    return reviewCard(c, this.executors, meta.ownerOpenId, { approved, total: this.reviewers.length, mine: decision });
  }
}
