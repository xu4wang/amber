// Review inside Feishu: one wiki doc per submitted revision (full code, readable, line comments)
// plus one Feishu approval instance (会签: every reviewer must approve). Amber stays the source of
// truth: it re-reads the approval instance from the API before activating anything.
import type * as lark from '@larksuiteoapi/node-sdk';
import { executorHub } from './engine.ts';
import { describeSecrets } from './secrets.ts';
import type { CommandRow } from './db.ts';
import { lineDiff } from './diff.ts';
import { describeServices } from './runner.ts';

function log(...a: unknown[]): void { console.log(new Date().toISOString(), ...a); }

export interface ReviewConfig {
  approval?: { code: string; reviewNodeId: string; formFieldId: string };
  wiki?: { spaceId: string; parentNodeToken: string; baseUrl: string };
}

const FENCE = '`'.repeat(3);

function docMarkdown(c: CommandRow, opts: { creator: string; submittedBy?: string; trial?: string; prev?: CommandRow }): string {
  const params = c.params.length
    ? ['| 参数 | 显示名 | 类型 | 默认值 | 必填 |', '|---|---|---|---|---|',
       ...c.params.map(p => `| ${p.name}${p.scope === 'config' ? '（配置项）' : ''} | ${p.label ?? ''} | ${p.type === 'integer' ? '整数' : '文本'} | ${p.defaultFrom === 'caller.city' ? '执行人办公城市' + (p.default ? `（兜底 ${p.default}）` : '') : (p.default ?? '')} | ${p.required ? '是' : '否'} |`)].join('\n')
    : '无参数。';
  const s = c.script;
  const how = '沙盒脚本';
  const net = s.network ? '，可访问外网' : s.services && Object.keys(s.services).length ? `，以执行人身份调用：${describeServices(s)}（不能访问外网）` : '，不联网';
  const interp = (s.interpreter ? `\n\n**解释器**：${s.interpreter}` : '') + (s.env ? `\n\n**执行位置**：${executorHub()?.describe(s.env) ?? s.env}。脚本在那台机器上执行，能访问的就是这个环境的路径（由管理员批准，指令不能自己加）。` : '');
  const sec = s.secrets?.length ? `\n\n**使用的密钥**：${describeSecrets(c)}。审核时请确认代码只把密钥用在该用的地方，不会打印或发往别处。` : '';
  const code = `## 代码\n\n${how}${net}；超时 ${(s.timeoutMs ?? 30000) / 1000} 秒。${sec}${interp}\n\n${FENCE}python\n${s.code.split(FENCE).join('``\u200b`')}\n${FENCE}`;
  const trial = opts.trial
    ? `## 试运行结果\n\n由认领人试运行时的输出：\n\n${FENCE}text\n${opts.trial.slice(0, 20000).split(FENCE).join('``​`')}\n${FENCE}`
    : '';
  let change = '';
  if (opts.prev) {
    const d = lineDiff(opts.prev.script.code, c.script.code);
    const body = d === null ? '代码改动太大，无法逐行比较，请直接看下面的完整代码。'
      : !d.text ? '代码没有变化（只改了参数、选项、说明或运行方式）。'
      : `新增 ${d.stat.added} 行，删除 ${d.stat.removed} 行。\n\n${FENCE}diff\n${d.text.slice(0, 30000).split(FENCE).join('``\u200b`')}\n${FENCE}`;
    change = `## 与当前版本的差异\n\n这是「${c.name}」的新版本，审核通过后替换当前版本 ${opts.prev.specHash.slice(0, 12)}。\n\n${body}`;
  }
  return [
    `# ${c.name}${opts.prev ? '（新版本）' : ''}`,
    `**版本**：${c.specHash}`,
    `**范围**：${c.scopeType === 'p2p' ? '私聊（只有创建人）' : '群'}　**选项**：${c.options.confirm ? '执行前需要确认' : '直接执行'}，${c.options.schedulable ? '允许定时执行' : '不允许定时执行'}　**创建人**：${opts.creator}${opts.submittedBy ? `　**提交方**：${opts.submittedBy}` : ''}`,
    change,
    `## 说明\n\n${c.description || '（无）'}`,
    `## 参数\n\n${params}`,
    code,
    trial,
    '## 审批记录\n\n审批在飞书「审批」里进行；结果由 Amber 追加到这里。',
  ].filter(Boolean).join('\n\n');
}

export class FeishuReview {
  private client: lark.Client;
  cfg: ReviewConfig;

  constructor(client: lark.Client, cfg: ReviewConfig) {
    this.client = client;
    this.cfg = cfg;
  }

  get enabled(): boolean { return !!(this.cfg.approval && this.cfg.wiki); }

  private async req(method: string, url: string, data?: unknown, params?: Record<string, unknown>): Promise<any> {
    try {
      return await (this.client as any).request({ method, url, data, params });
    } catch (e: any) {
      const d = e?.response?.data;
      throw new Error(`${url} → ${d?.code ?? ''} ${d?.msg ?? e?.message}`);
    }
  }

  async appendMarkdown(docId: string, md: string): Promise<void> {
    const conv = await this.req('POST', '/open-apis/docx/v1/documents/blocks/convert', { content_type: 'markdown', content: md });
    const blocks = (conv.data?.blocks ?? []).map((b: any) => {
      const c = { ...b };
      delete c.parent_id;
      if (c.table?.property) delete c.table.property.merge_info;
      return c;
    });
    if (!blocks.length) return;
    await this.req('POST', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/descendant`,
      { children_id: conv.data.first_level_block_ids, descendants: blocks, index: -1 }, { document_revision_id: -1 });
  }

  /** Creates the review doc in the wiki. Returns { url, docId }. */
  async createDoc(c: CommandRow, opts: { creator: string; submittedBy?: string; trial?: string; prev?: CommandRow }): Promise<{ url: string; docId: string }> {
    const w = this.cfg.wiki!;
    const r = await this.req('POST', `/open-apis/wiki/v2/spaces/${w.spaceId}/nodes`, {
      obj_type: 'docx', node_type: 'origin', parent_node_token: w.parentNodeToken, title: `Amber 指令：${c.name}${opts.prev ? ' 新版本' : ''}（${c.specHash.slice(0, 8)}）`,
    });
    const node = r.data?.node;
    await this.appendMarkdown(node.obj_token, docMarkdown(c, opts));
    return { url: `${w.baseUrl}${node.node_token}`, docId: node.obj_token };
  }

  /** Starts a 会签 approval with the given reviewers. Returns the instance code. */
  async startApproval(c: CommandRow, initiatorOpenId: string, reviewerOpenIds: string[], docUrl: string, creatorLabel: string, prev?: CommandRow): Promise<string> {
    const a = this.cfg.approval!;
    const text = [
      `指令：${c.name}${prev ? `（新版本，替换 ${prev.specHash.slice(0, 12)}）` : ''}`,
      `范围：${c.scopeType === 'p2p' ? '私聊' : '群'}　选项：${c.options.confirm ? '执行前需要确认' : '直接执行'}，${c.options.schedulable ? '允许定时执行' : '不允许定时执行'}`,
      '运行方式：沙盒脚本',
      c.script.secrets?.length ? `使用的密钥：${describeSecrets(c)}` : '',
      c.script.interpreter ? `解释器：${c.script.interpreter}` : '',
      c.script.env ? `执行位置：${executorHub()?.describe(c.script.env) ?? c.script.env}` : '',
      `创建人：${creatorLabel}`,
      `版本：${c.specHash.slice(0, 12)}`,
      `完整代码与试运行结果：${docUrl}`,
    ].filter(Boolean).join('\n');
    const r = await this.req('POST', '/open-apis/approval/v4/instances', {
      approval_code: a.code,
      // Show the command name in the approval list instead of only the definition name.
      title: `Amber 指令：${c.name}${prev ? '（新版本）' : ''}`,
      title_display_method: 1,
      open_id: initiatorOpenId,
      form: JSON.stringify([{ id: a.formFieldId, type: 'textarea', value: text }]),
      node_approver_open_id_list: [{ key: a.reviewNodeId, value: reviewerOpenIds }],
      uuid: `${c.id}-${c.specHash.slice(0, 16)}`,
    });
    return r.data.instance_code;
  }

  /** Authoritative read of an approval instance. */
  async getInstance(code: string): Promise<{ approvalCode: string; status: string; tasks: { openId: string; status: string }[]; comments: string[] }> {
    const r = await this.req('GET', `/open-apis/approval/v4/instances/${code}`, undefined, { user_id_type: 'open_id' });
    const d = r.data ?? {};
    return {
      approvalCode: d.approval_code,
      status: d.status,
      tasks: (d.task_list ?? []).map((t: any) => ({ openId: t.open_id, status: t.status })),
      comments: (d.comment_list ?? []).map((x: any) => String(x.comment ?? '')).filter(Boolean),
    };
  }

  docMarkdownForTest = docMarkdown;
}

export { log as reviewLog };
