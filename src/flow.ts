// Draft → claim → review → active.
// - A draft is submitted by an agent through the local API (machine credential). Nothing in it is trusted.
// - Claiming establishes the creator: the clicker on the claim card (identity from Feishu), who must
//   first run a successful trial with their own identity.
// - Every configured reviewer must approve the exact spec_hash (D16); any reject rejects.
import type * as lark from '@larksuiteoapi/node-sdk';
import type { Store, CommandRow, ParamDef, Script, CommandOptions } from './db.ts';
import { normalizeOptions } from './db.ts';
import { computeSpecHash } from './db.ts';
import { validateScript } from './runner.ts';
import type { FeishuReview } from './feishu-review.ts';
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
  script: Script;
  /** Message to reply under (keeps the claim card in the thread where the work happened). */
  originMessageId?: string;
  /** Whether originMessageId lives in a thread (then the claim card is posted into that thread). */
  inThread?: boolean;
  /** p2p drafts: who must claim. Email or union_id. */
  claimer?: string;
  submittedBy?: string;
  /** Proposed by the submitter; approved together with the code (D30). */
  options?: Partial<CommandOptions>;
}

function shell(title: string, template: string, elements: unknown[]): object {
  return { schema: '2.0', config: { update_multi: true }, header: { title: { tag: 'plain_text', content: title }, template }, body: { elements } };
}
function btn(text: string, value: Record<string, string>, type: 'primary' | 'default' | 'danger' = 'default', extra: Record<string, unknown> = {}): object {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }], ...extra };
}

function scriptLabel(k: string): string {
  return k === 'privileged' ? '<font color="red">特权脚本（不在沙盒里运行，可读本机文件）</font>' : '脚本（沙盒运行）';
}

function specSummary(c: CommandRow): string {
  const params = c.params.length
    ? c.params.map(p => `${p.label ?? p.name}（${p.type === 'integer' ? '整数' : '文本'}${p.defaultFrom === 'caller.city' ? '，默认办公城市' : p.default !== undefined ? `，默认 ${p.default}` : ''}${p.required ? '，必填' : ''}）`).join('、')
    : '无';
  const s = c.script;
  const how = `${scriptLabel(s.kind)}${s.network ? '，可访问外网' : ''}${s.services?.length ? `，以执行人身份调用：${s.services.join('、')}（不能访问外网）` : ''}`;
  return [
    `**名称**：${sanitizeMarkdown(c.name, 40)}`,
    `**说明**：${sanitizeMarkdown(c.description || '（无）', 200)}`,
    `**范围**：${c.scopeType === 'p2p' ? '私聊（只有创建人）' : '本群'}`,
    `**参数**：${sanitizeMarkdown(params, 300)}`,
    `**选项**：${c.options.confirm ? '<font color="red">执行前需要确认</font>' : '直接执行'}；${c.options.schedulable ? '允许定时执行' : '不允许定时执行'}`,
    `**运行方式**：${how}`,
  ].join('\n');
}

const FENCE = '`'.repeat(3);

/** Full code, so reviewers see exactly what will run. */
function codePanels(c: CommandRow): unknown[] {
  const body = c.script.code;
  const shown = body.length > 12000 ? body.slice(0, 12000) + '\n# ……（超过 12000 字符，完整内容见文档）' : body;
  return [{
    tag: 'collapsible_panel',
    expanded: false,
    header: { title: { tag: 'markdown', content: `代码（${body.length} 字符）` } },
    elements: [{ tag: 'markdown', content: FENCE + 'python\n' + shown.split(FENCE).join('``\u200b`') + '\n' + FENCE }],
  }];
}

export function claimCard(c: CommandRow, trial?: { by?: string; blocks?: Block[]; error?: string }, submittedBy?: string): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `${submittedBy ? `**${sanitizeMarkdown(submittedBy, 80)}**` : 'agent'} 提交了一条新指令，等待认领。认领人会成为这条指令的创建人，提交后由审核人审核。\n<font color="grey">请确认这是你让 agent 做的；不认识的草稿直接点「丢弃」。</font>` },
    { tag: 'markdown', content: specSummary(c) },
    ...codePanels(c),
  ];
  if (trial?.error) els.push({ tag: 'markdown', content: `❌ 试运行失败：${sanitizeMarkdown(trial.error, 300)}` });
  if (trial?.blocks) {
    els.push({ tag: 'markdown', content: `**试运行结果**（由 ${person(trial.by)} 执行）` });
    els.push(...renderBlocks(trial.blocks));
  }
  els.push({ tag: 'markdown', content: '<font color="grey">试运行就是以你的身份真实执行一次。</font>' });
  const buttons: unknown[] = [];
  if (c.params.length) {
    // Commands with parameters: the trial run takes its inputs from a small form.
    els.push({
      tag: 'form', name: 'trial', elements: [
        ...c.params.map(p => ({
          tag: 'input', name: p.name, label: { tag: 'plain_text', content: p.label ?? p.name }, label_position: 'left',
          placeholder: { tag: 'plain_text', content: p.defaultFrom === 'caller.city' ? '不填则用你的办公城市' : p.default !== undefined ? `默认：${p.default}` : (p.required ? '必填' : '可不填') },
          ...(p.default !== undefined && !p.defaultFrom ? { default_value: p.default } : {}),
        })),
        btn('试运行', { a: 'claim_try', c: c.id }, trial?.blocks ? 'default' : 'primary', { form_action_type: 'submit', name: 'try' }),
      ],
    });
  } else {
    buttons.push(btn('试运行', { a: 'claim_try', c: c.id }, trial?.blocks ? 'default' : 'primary'));
  }
  if (trial?.blocks) buttons.push(btn('提交审核', { a: 'claim_submit', c: c.id }, 'primary'));
  buttons.push(btn('丢弃', { a: 'claim_drop', c: c.id }, 'danger'));
  els.push({ tag: 'column_set', flex_mode: 'flow', columns: buttons.map(b => ({ tag: 'column', width: 'auto', elements: [b] })) });
  return shell(`待认领：${c.name}`, 'orange', els);
}

export function reviewCard(c: CommandRow, creatorOpenIdForReviewer: string | undefined, state: { approved: number; total: number; mine?: string }): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `请审核这条指令。需要 **全部 ${state.total} 位**审核人通过才生效，目前已通过 ${state.approved} 位。` },
    { tag: 'markdown', content: specSummary(c) },
    ...codePanels(c),
    ...(c.script.kind === 'privileged' ? [{ tag: 'markdown', content: '<font color="red">⚠️ 含特权脚本：通过即允许这段代码不经沙盒在 Amber 所在机器上运行。只有管理员能通过。</font>' }] : []),
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
  private reviewerEmails: string[];
  reviewers: string[] = [];
  /** Only admins may approve commands containing privileged scripts. */
  isAdmin: (unionId: string) => boolean = () => false;
  signer?: import('./identity.ts').Signer;
  review?: FeishuReview;
  reviewerOpenIds: string[] = [];
  adminOpenIds: string[] = [];
  nameOf: (unionId: string) => Promise<string | undefined> = async () => undefined;

  constructor(client: lark.Client, store: Store, reviewerEmails: string[]) {
    this.client = client;
    this.store = store;
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
    try {
      const r = await (this.client as any).contact.v3.user.batchGetId({ params: { user_id_type: 'open_id' }, data: { emails: this.reviewerEmails.filter(e => !e.startsWith('on_')) } });
      this.reviewerOpenIds = (r?.data?.user_list ?? []).map((u: any) => u.user_id).filter(Boolean);
    } catch { this.reviewerOpenIds = []; }
    log('reviewers resolved', ids.length, 'open_ids', this.reviewerOpenIds.length);
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
    if (!d.submittedBy || d.submittedBy.length > 80) throw new AmberError('bad_submitter', '请注明提交来源（submittedBy，例如「Beta（botmux @ host-1）」）');
    if (!d.name || d.name.length > 40 || /\s/.test(d.name)) throw new AmberError('bad_name', '名称不能为空、不能有空格、最多 40 个字');
    if ((d as any).steps !== undefined) throw new AmberError('bad_script', '指令不再有「步骤」：请提交一段 script（参数 + 一段脚本）');
    try { d.script = validateScript(d.script); } catch (e) { throw new AmberError('bad_script', (e as Error).message); }
    if (this.store.nameTaken(d.chatId, d.name)) throw new AmberError('name_taken', `这里已经有一条叫「${d.name}」的指令（生效中或待审核）`);
    if ((d as any).sideEffect !== undefined) throw new AmberError('bad_options', '已不区分读写：请用 options.confirm（执行前确认）/ options.schedulable（允许定时）');
    const options = normalizeOptions(d.options);
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
      params: d.params ?? [], script: d.script, options, status: 'draft',
    });
    this.store.setMeta(row.id, { expectedClaimer: expectedClaimer ?? null, originMessageId: d.originMessageId ?? null, submittedBy: d.submittedBy ?? null });
    this.store.audit(null, 'draft.submit', { id: row.id, name: row.name, chatId: row.chatId, chatType: d.chatType, submittedBy: d.submittedBy, specHash: row.specHash });
    // Group: claim card in the group (only members can click). p2p: Amber can't enter the agent's DM, so the claim card goes to the claimer's DM with Amber.
    let claimMessageId: string | undefined;
    try {
      claimMessageId = d.chatType === 'p2p'
        ? await this.send({ unionId: expectedClaimer }, claimCard(row, undefined, d.submittedBy))
        : await this.send(d.originMessageId ? { replyTo: d.originMessageId, inThread: !!d.inThread } : { chatId: d.chatId }, claimCard(row, undefined, d.submittedBy));
    } catch (e: any) {
      const code = e?.response?.data?.code;
      this.store.setStatus(row.id, 'rejected');
      throw new AmberError('claim_card_failed', code === 230002 || code === 232011 ? 'Amber 机器人不在这个群里，请先把 Amber 拉进群' : `认领卡发送失败：${code ?? e?.message}`);
    }
    if (claimMessageId) this.store.setMeta(row.id, { claimMessageId });
    log('draft submitted', row.id, row.name, d.chatType, d.chatId);
    return { id: row.id, claimMessageId };
  }

  /** Feishu approval status changed. Re-reads the instance from the API; never trusts the event body. */
  async onApprovalEvent(instanceCode: string): Promise<void> {
    if (!this.review?.enabled) return;
    const id = this.store.commandByApprovalInstance(instanceCode);
    if (!id) return;
    const c = this.store.getCommand(id);
    if (!c || c.status !== 'pending') return;
    const inst = await this.review.getInstance(instanceCode);
    if (inst.approvalCode !== this.review.cfg.approval!.code) { log('approval code mismatch', instanceCode); return; }
    const meta = this.store.getMeta(c.id);
    const rv = this.store.getReview(c.id);
    const note = async (md: string) => { if (rv.docId) await this.review!.appendMarkdown(rv.docId, md).catch(e => log('doc append failed', (e as Error).message)); };
    if (inst.status === 'APPROVED') {
      const approved = new Set(inst.tasks.filter(t => t.status === 'APPROVED').map(t => t.openId));
      const allReviewers = this.reviewerOpenIds.length > 0 && this.reviewerOpenIds.every(o => approved.has(o));
      const privilegedOk = !c.script.kind === 'privileged' || this.adminOpenIds.some(o => approved.has(o));
      if (!allReviewers || !privilegedOk || computeSpecHash(c) !== c.specHash) {
        log('approval APPROVED but checks failed', c.id, { allReviewers, privilegedOk });
        this.store.audit(null, 'review.feishu_check_failed', { id: c.id, instanceCode, allReviewers, privilegedOk });
        return;
      }
      for (const o of approved) this.store.recordReview(c.id, c.specHash, o, 'approve', null);
      this.store.setStatus(c.id, 'active');
      this.store.audit(null, 'command.active', { id: c.id, specHash: c.specHash, via: 'feishu_approval', instanceCode });
      const where = c.scopeType === 'p2p' ? '在你和 Amber 的私聊里' : '在本群 @Amber';
      if (meta.claimMessageId) await this.patch(meta.claimMessageId, shell(`已生效：${c.name}`, 'green', [
        { tag: 'markdown', content: `✅ 飞书审批已通过（${approved.size} 位审核人全部同意），指令「${sanitizeMarkdown(c.name, 40)}」现已生效。${where}发「${sanitizeMarkdown(c.name, 40)}」即可使用。${rv.docUrl ? `\n\n[查看代码文档](${rv.docUrl})` : ''}` },
      ]));
      await note(`**${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC：飞书审批通过，指令已生效。**`);
    } else if (inst.status === 'REJECTED' || inst.status === 'CANCELED' || inst.status === 'DELETED') {
      this.store.setStatus(c.id, 'rejected');
      const why = inst.status === 'REJECTED' ? `审核人驳回${inst.comments.length ? `：${inst.comments.join('；')}` : ''}` : '审批已撤回';
      this.store.audit(null, 'review.feishu_closed', { id: c.id, instanceCode, status: inst.status });
      if (meta.claimMessageId) await this.patch(meta.claimMessageId, shell(`未通过：${c.name}`, 'red', [{ tag: 'markdown', content: sanitizeMarkdown(why, 500) }]));
      await note(`**${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC：${why}。**`);
    }
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
  async onClaimAction(action: string, cmdId: string, caller: Caller, facts: CallerFacts, form: Record<string, string> = {}): Promise<object> {
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
        const r = await runCommand(this.store, c, form, caller, facts, { trial: true });
        if (!r.ok) return claimCard(c, { error: r.error }, meta.submittedBy);
        this.store.setMeta(c.id, { trialBy: caller.unionId });
        return claimCard(c, { by: caller.openId, blocks: r.blocks }, meta.submittedBy);
      } catch (e) {
        return claimCard(c, { error: e instanceof AmberError ? e.message : (e as Error).message }, meta.submittedBy);
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
      if (this.review?.enabled) {
        if (!caller.openId) throw new AmberError('no_open_id', '无法识别认领人');
        if (this.reviewerOpenIds.length !== this.reviewers.length) throw new AmberError('no_reviewers', '审核人名单无法解析成飞书账号，暂时不能提交审核');
        const creator = (await this.nameOf(caller.unionId)) ?? '认领人';
        try {
          const doc = await this.review.createDoc(fresh, { creator, submittedBy: meta.submittedBy, trial: this.store.lastTrialResult(c.id) });
          const instance = await this.review.startApproval(fresh, caller.openId, this.reviewerOpenIds, doc.url, creator);
          this.store.setReview(c.id, { instance, docUrl: doc.url, docId: doc.docId });
          this.store.audit(caller.unionId, 'review.feishu_started', { id: c.id, instance, doc: doc.url });
          log('feishu review started', c.id, instance);
          return shell(`审核中：${c.name}`, 'yellow', [
            { tag: 'markdown', content: `${person(caller.openId)} 已认领并提交审核。\n已发起飞书审批「Amber命令申请」，需要 ${this.reviewers.length} 位审核人全部同意后生效。\n\n**完整代码与试运行结果**：[查看文档](${doc.url})` },
          ]);
        } catch (e) {
          // Roll back to draft so the claimer can retry.
          this.store.setStatus(c.id, 'draft');
          log('feishu review failed', (e as Error).message);
          throw new AmberError('feishu_review_failed', `发起飞书审批失败：${(e as Error).message.slice(0, 200)}`);
        }
      }
      for (const r of this.reviewers) {
        try { await this.send({ unionId: r }, reviewCard(fresh, caller.openId, { approved: 0, total: this.reviewers.length })); }
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
    if (action === 'review_ok' && c.script.kind === 'privileged' && !this.isAdmin(caller.unionId)) throw new AmberError('admin_only', '含特权脚本的指令只能由管理员通过');
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
    return reviewCard(c, meta.ownerOpenId, { approved, total: this.reviewers.length, mine: decision });
  }
}
