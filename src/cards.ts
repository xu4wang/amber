import type { CommandRow, ExecutorRow } from './db.ts';
import { showFingerprint } from './exec-proto.ts';
import { effectiveAccess, credentialPaths, type FollowChange } from './executors.ts';
import type { Block } from './engine.ts';
import type { SecretInfo } from './secrets.ts';

/** Executor output is untrusted text: no @mentions, no raw tags, links shown as plain text. */
export function sanitizeMarkdown(md: string, maxChars = 6000): string {
  let s = md.replace(/</g, '＜').replace(/>/g, '＞');
  s = s.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1（$2）');
  s = s.replace(/@/g, '＠');
  if (s.length > maxChars) s = s.slice(0, maxChars) + '\n\n……（内容过长，已截断）';
  return s;
}

function shell(title: string, template: string, elements: unknown[]): object {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: title }, template },
    body: { elements },
  };
}

function btn(text: string, value: Record<string, string>, type: 'primary' | 'default' | 'danger' = 'default', extra: Record<string, unknown> = {}): object {
  return { tag: 'button', text: { tag: 'plain_text', content: text }, type, behaviors: [{ type: 'callback', value }], ...extra };
}

/** Buttons side by side on one line (wrapping only when the card is too narrow). */
export function buttonRow(buttons: unknown[]): object {
  return { tag: 'column_set', flex_mode: 'flow', columns: buttons.map(b => ({ tag: 'column', width: 'auto', elements: [b] })) };
}

export function listCard(cmds: CommandRow[], scopeLabel: string): object {
  if (cmds.length === 0) {
    return shell('Amber', 'orange', [{ tag: 'markdown', content: `${scopeLabel}还没有可用的指令。\n\n在这里和 agent 把一次操作跑通后，让它把操作提交给 Amber，经认领和审核后就会出现在这里。` }]);
  }
  const els: unknown[] = [{ tag: 'markdown', content: `${scopeLabel}可用的指令：` }];
  for (const c of cmds) {
    els.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: [
        { tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center', elements: [{ tag: 'markdown', content: `**${sanitizeMarkdown(c.name, 40)}**${c.global ? '　<font color="blue">全局</font>' : ''}${c.options.confirm ? '　<font color="red">需确认</font>' : ''}\n<font color="grey">${sanitizeMarkdown(c.description || '（无说明）', 120)}</font>` }] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [btn('选择', { a: 'pick', c: c.id }, 'primary')] },
      ],
    });
  }
  return shell('Amber · 指令', 'orange', els);
}

export function formCard(c: CommandRow, prefill: Record<string, string> = {}): object {
  const isWrite = c.options.confirm;
  const runText = isWrite ? '确认执行' : '执行';
  const runType = isWrite ? 'danger' : 'primary';
  const warn = isWrite ? [{ tag: 'markdown', content: '<font color="red">⚠️ 这条指令要求执行前确认，请核对参数后再点「确认执行」。</font>' }] : [];
  if (c.params.length === 0) {
    return shell(`Amber · ${c.name}`, isWrite ? 'red' : 'orange', [
      { tag: 'markdown', content: sanitizeMarkdown(c.description || '') || '这条指令没有参数。' },
      ...warn,
      buttonRow([btn(runText, { a: 'run', c: c.id }, runType), btn('返回', { a: 'list' })]),
    ]);
  }
  const inputs = c.params.map(p => ({
    tag: 'input',
    name: p.name,
    label: { tag: 'plain_text', content: p.label ?? p.name },
    label_position: 'left',
    placeholder: { tag: 'plain_text', content: p.defaultFrom === 'caller.city' ? `不填则用你的办公城市${p.default ? `（查不到时用 ${p.default}）` : ''}` : p.default !== undefined ? `默认：${p.default}` : (p.required ? '必填' : '可不填') },
    ...(prefill[p.name] !== undefined ? { default_value: prefill[p.name] } : p.default !== undefined && !p.defaultFrom ? { default_value: p.default } : {}),
    required: !!p.required,
  }));
  return shell(`Amber · ${c.name}`, isWrite ? 'red' : 'orange', [
    ...(c.description ? [{ tag: 'markdown', content: `<font color="grey">${sanitizeMarkdown(c.description, 200)}</font>` }] : []),
    ...warn,
    {
      tag: 'form',
      name: 'args',
      elements: [
        ...inputs,
        // Both are submit buttons so they can share a line inside the form; 返回 ignores the form values.
        buttonRow([
          btn(runText, { a: 'run', c: c.id }, runType, { form_action_type: 'submit', name: 'submit' }),
          btn('返回', { a: 'list' }, 'default', { form_action_type: 'submit', name: 'back' }),
        ]),
      ],
    },
  ]);
}

/** Mentions a person by open_id (only ids Amber received from Feishu itself). */
export function person(openId: string | undefined): string {
  if (!openId || !/^ou_[A-Za-z0-9]+$/.test(openId)) return '（未知用户）';
  return `<at id=${openId}></at>`;
}

/** Splits ```vega-lite fences out of markdown and turns simple bar/line specs into card charts. */
export function markdownWithCharts(md: string): unknown[] {
  const els: unknown[] = [];
  const re = /```(vega-lite|table)\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => { const x = t.trim(); if (x) els.push({ tag: 'markdown', content: sanitizeMarkdown(x) }); };
  while ((m = re.exec(md))) {
    pushText(md.slice(last, m.index));
    last = m.index + m[0].length;
    let converted = m[1] === 'table' ? tableToCard(m[2]) : vegaLiteToChart(m[2]);
    // The script often prints the chart's title right above it; don't show the same title twice.
    const prev: any = els[els.length - 1];
    if (converted && m[1] === 'vega-lite' && prev?.tag === 'markdown' && (converted[0] as any)?.tag === 'markdown') {
      const lastLine = (s: string) => s.trim().split('\n').pop()!.replace(/\*\*/g, '').trim();
      if (lastLine(prev.content) === lastLine((converted[0] as any).content)) converted = converted.slice(1);
    }
    if (converted) els.push(...converted); else pushText(m[1] === 'table' ? '（表格格式不正确，无法显示）' : '（这个图表在飞书里无法显示，请在网站查看）');
  }
  pushText(md.slice(last));
  return els;
}

const CARD_TABLE_MAX_ROWS = 100;

/** ```table {"columns":[{name,label,type}],"rows":[...],"total":N} → native card table. */
function tableToCard(src: string): unknown[] | null {
  let t: any;
  try { t = JSON.parse(src); } catch { return null; }
  if (!Array.isArray(t?.columns) || !Array.isArray(t?.rows) || t.columns.length === 0 || t.columns.length > 30) return null;
  const cols = t.columns.filter((c: any) => typeof c?.name === 'string').map((c: any, i: number) => ({
    key: `c${i}`, name: c.name, label: sanitizeMarkdown(String(c.label ?? c.name), 40), number: c.type === 'number',
  }));
  const rows = t.rows.slice(0, CARD_TABLE_MAX_ROWS).map((r: any) => {
    const o: Record<string, unknown> = {};
    for (const c of cols) {
      const v = r?.[c.name];
      o[c.key] = c.number && typeof v === 'number' ? v : sanitizeMarkdown(v === null || v === undefined ? '' : String(v), 200);
    }
    return o;
  });
  const total = Number.isFinite(t.total) ? Number(t.total) : t.rows.length;
  const out: unknown[] = [{
    tag: 'table',
    page_size: 10,
    row_height: 'low',
    header_style: { bold: true, background_style: 'grey' },
    columns: cols.map((c: any) => ({ name: c.key, display_name: c.label, data_type: c.number ? 'number' : 'text', ...(c.number ? { horizontal_align: 'right' } : {}) })),
    rows,
  }];
  if (total > rows.length) out.push({ tag: 'markdown', content: `<font color="grey">共 ${total} 行，这里显示前 ${rows.length} 行，完整数据请在网站查看</font>` });
  return out;
}

function vegaLiteToChart(src: string): unknown[] | null {
  let spec: any;
  try { spec = JSON.parse(src); } catch { return null; }
  const values: any[] = spec?.data?.values;
  const mark = typeof spec?.mark === 'string' ? spec.mark : spec?.mark?.type;
  const title = typeof spec.title === 'string' ? spec.title : spec?.title?.text;
  // Pie (mark arc): theta = value, color = category → Feishu pie chart.
  if (mark === 'arc') {
    const vf = spec?.encoding?.theta?.field, cf = spec?.encoding?.color?.field;
    if (!Array.isArray(values) || values.length === 0 || values.length > 50 || !vf || !cf) return null;
    const out: unknown[] = [];
    if (title) out.push({ tag: 'markdown', content: `**${sanitizeMarkdown(String(title), 80)}**` });
    out.push({ tag: 'chart', aspect_ratio: '4:3', chart_spec: { type: 'pie', data: { values: values.map(v => ({ [cf]: v[cf], [vf]: v[vf] })) }, valueField: vf, categoryField: cf, label: { visible: true }, legends: { visible: true } } });
    return out;
  }
  const ex = spec?.encoding?.x?.field, ey = spec?.encoding?.y?.field;
  if (!Array.isArray(values) || values.length === 0 || values.length > 500 || !ex || !ey) return null;
  if (mark !== 'bar' && mark !== 'line') return null;
  const clean = values.map(v => ({ [ex]: v[ex], [ey]: v[ey] }));
  const horizontal = mark === 'bar' && spec.encoding.x.type === 'quantitative' && spec.encoding.y.type !== 'quantitative';
  const out: unknown[] = [];
  if (title) out.push({ tag: 'markdown', content: `**${sanitizeMarkdown(String(title), 80)}**` });
  out.push({
    tag: 'chart',
    aspect_ratio: horizontal && clean.length > 4 ? '4:3' : '16:9',
    chart_spec: {
      type: mark,
      ...(horizontal ? { direction: 'horizontal' } : {}),
      data: { values: clean },
      xField: ex,
      yField: ey,
      label: { visible: true },
      // Axis titles carry the units (vega-lite encoding.*.title, falling back to the field name).
      axes: [
        { orient: horizontal ? 'bottom' : 'left', title: { visible: true, text: String(spec.encoding.y.title ?? ey) } },
        { orient: horizontal ? 'left' : 'bottom', title: { visible: true, text: String(spec.encoding.x.title ?? ex) } },
      ],
    },
  });
  return out;
}

export function renderBlocks(blocks: Block[]): unknown[] {
  const els: unknown[] = [];
  for (const b of blocks) if (b.text) els.push(...markdownWithCharts(b.text));
  return els.length ? els : [{ tag: 'markdown', content: '（没有输出）' }];
}

export function runningCard(name: string, whoOpenId?: string): object {
  return shell(`Amber · ${name}`, 'wathet', [{ tag: 'markdown', content: `⏳ 正在以 ${person(whoOpenId)} 的身份执行……` }]);
}

export function resultCard(name: string, whoOpenId: string | undefined, blocks: Block[], runId: string, elapsedMs: number, cmdId: string, sharedSecrets = false): object {
  return shell(`Amber · ${name}`, 'green', [
    ...renderBlocks(blocks),
    { tag: 'markdown', content: `由 ${person(whoOpenId)} 执行 · ${(elapsedMs / 1000).toFixed(1)} 秒 · run ${runId}${sharedSecrets ? ' · 使用本群共用的密钥' : ''}`, text_size: 'notation' },
    btn('再执行一次', { a: 'pick', c: cmdId }),
  ]);
}

export function errorCard(name: string, message: string, cmdId?: string): object {
  return shell(`Amber · ${name}`, 'red', [
    { tag: 'markdown', content: `❌ ${sanitizeMarkdown(message, 500)}` },
    ...(cmdId ? [btn('重新填写', { a: 'pick', c: cmdId })] : [btn('返回', { a: 'list' })]),
  ]);
}

export function infoCard(title: string, markdown: string): object {
  return shell(`Amber · ${title}`, 'blue', [{ tag: 'markdown', content: sanitizeMarkdown(markdown) }]);
}

// ---------- agent requests (D33) and schedules (D32)

function argLines(c: CommandRow, args: Record<string, string>): string {
  const lines = c.params.map(p => `- ${sanitizeMarkdown(p.label ?? p.name, 40)}：${args[p.name] !== undefined && args[p.name] !== '' ? sanitizeMarkdown(args[p.name], 200) : '<font color="grey">（不填，按默认）</font>'}`);
  return lines.length ? lines.join('\n') : '（无参数）';
}

/** Agent asked to run a command / create a schedule on someone's behalf; the click decides who. */
export function requestCard(o: {
  kind: 'run' | 'schedule' | 'schedule_resume' | 'schedule_delete' | 'retire' | 'scope_global' | 'scope_local'; reqId: string; cmd: CommandRow; args: Record<string, string>;
  requestedBy: string; targetOpenId?: string; ruleText?: string; nextText?: string; scheduleId?: string; schedules?: number;
}): object {
  const danger = o.cmd.options.confirm || o.kind === 'schedule_delete' || o.kind === 'retire';
  const who = o.targetOpenId ? person(o.targetOpenId) : '你';
  const by = sanitizeMarkdown(o.requestedBy, 80);
  const name = sanitizeMarkdown(o.cmd.name, 40);
  const els: unknown[] = [];
  let title: string, ok: string;
  if (o.kind === 'run') {
    title = `请确认执行：${o.cmd.name}`;
    ok = danger ? '确认执行' : '执行';
    els.push({ tag: 'markdown', content: `**${by}** 请求以 ${who} 的身份执行「**${name}**」。` });
  } else if (o.kind === 'schedule') {
    title = `请确认定时任务：${o.cmd.name}`;
    ok = danger ? '确认并创建定时任务' : '创建定时任务';
    els.push({ tag: 'markdown', content: `**${by}** 请求为 ${who} 创建定时任务：**${sanitizeMarkdown(o.ruleText ?? '', 80)}** 自动执行「**${name}**」。\n首次运行：${sanitizeMarkdown(o.nextText ?? '', 40)}` });
  } else if (o.kind === 'retire') {
    title = `请确认下线指令：${o.cmd.name}`;
    ok = '确认下线';
    els.push({ tag: 'markdown', content: `**${by}** 请求下线指令「**${name}**」（${o.cmd.id}）。下线后任何人都不能再执行它，不需要审核，也不能撤销。${o.schedules ? `\n它的 **${o.schedules}** 个定时任务会暂停，并私聊通知各自的创建人。` : ''}` });
    els.push({ tag: 'markdown', content: '<font color="grey">只有指令的创建人或管理员可以确认。</font>' });
  } else if (o.kind === 'scope_global' || o.kind === 'scope_local') {
    const g = o.kind === 'scope_global';
    title = g ? `请确认设为全局：${o.cmd.name}` : `请确认取消全局：${o.cmd.name}`;
    ok = g ? '设为全局' : '取消全局';
    els.push({ tag: 'markdown', content: g
      ? `**${by}** 请求把指令「**${name}**」（${o.cmd.id}）设为**全局**：Amber 所在的任何群和私聊都能使用。`
      : `**${by}** 请求把指令「**${name}**」（${o.cmd.id}）改回**只在创建处可用**。` });
    els.push({ tag: 'markdown', content: '<font color="grey">只有管理员可以确认。</font>' });
  } else if (o.kind === 'schedule_resume') {
    title = `请确认恢复定时任务：${o.cmd.name}`;
    ok = '恢复';
    els.push({ tag: 'markdown', content: `**${by}** 请求恢复定时任务 ${o.scheduleId}：**${sanitizeMarkdown(o.ruleText ?? '', 80)}** 执行「**${name}**」。` });
  } else {
    title = `请确认删除定时任务：${o.cmd.name}`;
    ok = '删除';
    els.push({ tag: 'markdown', content: `**${by}** 请求删除定时任务 ${o.scheduleId}（${sanitizeMarkdown(o.ruleText ?? '', 80)} 执行「${name}」）。` });
  }
  if (o.kind === 'run' || o.kind === 'schedule') {
    if (o.cmd.description) els.push({ tag: 'markdown', content: `<font color="grey">${sanitizeMarkdown(o.cmd.description, 200)}</font>` });
    els.push({ tag: 'markdown', content: `**参数**\n${argLines(o.cmd, o.args)}` });
    els.push({ tag: 'markdown', content: o.kind === 'run'
      ? '<font color="grey">点「执行」即以你本人的身份执行一次；结果只显示在这张卡片上（完整内容在网站上），不会交给发起请求的 agent。</font>'
      : '<font color="grey">创建后，每次都以你本人的身份自动执行，结果发到这里（没有输出时不发）。运行失败会私聊通知你，连续失败 3 次自动暂停。</font>' });
    if (o.cmd.options.confirm) els.push({ tag: 'markdown', content: '<font color="red">⚠️ 这条指令要求执行前确认，请核对参数。</font>' });
  }
  els.push({
    tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'auto', elements: [btn(ok, { a: 'req_ok', r: o.reqId }, danger ? 'danger' : 'primary')] },
      { tag: 'column', width: 'auto', elements: [btn('取消', { a: 'req_no', r: o.reqId })] },
    ],
  });
  els.push({ tag: 'markdown', content: `<font color="grey">请求 ${o.reqId}${o.targetOpenId ? ' · 只有被请求人可以点' : ''} · 24 小时内有效</font>`, text_size: 'notation' });
  return shell(`Amber · ${title}`, danger ? 'red' : 'orange', els);
}

/** D44: retiring from Feishu asks once more; only the person who asked can confirm, for 5 minutes. */
export function retireConfirmCard(c: CommandRow, schedules: number, requester: string, issuedAt: number): object {
  const v = { c: c.id, h: c.specHash, u: requester, t: String(issuedAt) };
  return shell('Amber · 确认下线', 'red', [
    { tag: 'markdown', content: `确定下线「${sanitizeMarkdown(c.name, 80)}」？\n\n下线后这条指令不能再执行${schedules ? `，它的 **${schedules} 个定时任务**会暂停并通知创建人` : ''}。下线不能撤销，需要时只能重新提交、审核。\n<font color="grey">只有发起下线的人能确认，5 分钟内有效。</font>` },
    { tag: 'column_set', columns: [
      { tag: 'column', width: 'auto', elements: [btn('确认下线', { a: 'retire_ok', ...v }, 'danger')] },
      { tag: 'column', width: 'auto', elements: [btn('取消', { a: 'retire_no', ...v })] },
    ] },
  ]);
}

/** D45: the creator left the group — tell the group, and let any member take the schedule over. */
export function takeoverCard(o: { scheduleId: string; name: string; ruleText: string; creatorOpenId: string | null }): object {
  const who = o.creatorOpenId ? `<at id=${o.creatorOpenId}></at>` : '创建人';
  return shell('Amber · 定时任务已暂停', 'orange', [
    { tag: 'markdown', content: `定时任务「${sanitizeMarkdown(o.name, 80)}」（${sanitizeMarkdown(o.ruleText, 80)}）已暂停：${who} 已不在这个群里。\n\n群成员可以点「由我接手」，之后**以你的身份**继续运行（按你的数据权限），参数和时间都不变。没人接手就一直保持暂停。` },
    btn('由我接手', { a: 'sch_takeover', s: o.scheduleId }, 'primary'),
  ]);
}

export function closedCard(title: string, template: string, md: string): object {
  return shell(`Amber · ${title}`, template, [{ tag: 'markdown', content: md }]);
}

export interface ScheduleView {
  id: string; name: string; ruleText: string; nextText: string; status: string; pauseReason: string | null;
  creatorOpenId: string | null; lastText: string; canManage: boolean;
}

export function scheduleListCard(items: ScheduleView[], scopeLabel: string): object {
  if (!items.length) return shell('Amber · 定时任务', 'blue', [{ tag: 'markdown', content: `${scopeLabel}还没有定时任务。跟你的 agent 说「每天 9 点跑一下 xxx」，它会发来一张确认卡片。` }]);
  const els: unknown[] = [{ tag: 'markdown', content: `${scopeLabel}的定时任务：` }];
  for (const s of items) {
    const state = s.status === 'active' ? `下次 ${s.nextText}` : `<font color="red">已暂停${s.pauseReason ? `：${sanitizeMarkdown(s.pauseReason, 80)}` : ''}</font>`;
    const buttons: unknown[] = [];
    if (s.canManage) {
      buttons.push(s.status === 'active' ? btn('暂停', { a: 'sch_pause', s: s.id }) : btn('恢复', { a: 'sch_resume', s: s.id }, 'primary'));
      buttons.push(btn('立即运行', { a: 'sch_run', s: s.id }));
      buttons.push(btn('删除', { a: 'sch_del', s: s.id }, 'danger'));
    }
    els.push({ tag: 'hr' });
    els.push({ tag: 'markdown', content: `**${sanitizeMarkdown(s.name, 40)}** · ${sanitizeMarkdown(s.ruleText, 60)}\n${state}\n<font color="grey">创建人 ${person(s.creatorOpenId ?? undefined)} · ${sanitizeMarkdown(s.lastText, 80)} · ${s.id}</font>` });
    if (buttons.length) els.push(buttonRow(buttons));
  }
  return shell('Amber · 定时任务', 'blue', els);
}

export function scheduleResultCard(name: string, creatorOpenId: string | undefined, blocks: Block[], runId: string, elapsedMs: number, scheduleId: string, ruleText: string): object {
  return shell(`⏰ 定时：${name}`, 'green', [
    ...renderBlocks(blocks),
    { tag: 'markdown', content: `${sanitizeMarkdown(ruleText, 60)} · 以 ${person(creatorOpenId)} 的身份执行 · ${(elapsedMs / 1000).toFixed(1)} 秒 · run ${runId} · 任务 ${scheduleId}`, text_size: 'notation' },
  ]);
}

/** Sent to a schedule's creator when the command it runs got a new version (D38). */
export function rebindCard(o: { scheduleId: string; name: string; ruleText: string; oldHash: string; newId: string; newHash: string; stillSchedulable: boolean }): object {
  const els: unknown[] = [
    { tag: 'markdown', content: `指令「**${sanitizeMarkdown(o.name, 40)}**」更新了版本（${o.oldHash.slice(0, 8)} → ${o.newHash.slice(0, 8)}）。你的定时任务 ${o.scheduleId}（${sanitizeMarkdown(o.ruleText, 60)}）已暂停，不会自动改用新版本。` },
  ];
  if (o.stillSchedulable) {
    els.push({ tag: 'markdown', content: '确认新版本没问题后，点「换绑到新版本」继续运行；参数和时间保持不变。' });
    els.push({ tag: 'column_set', flex_mode: 'none', columns: [
      { tag: 'column', width: 'auto', elements: [btn('换绑到新版本', { a: 'sch_rebind', s: o.scheduleId, c: o.newId }, 'primary')] },
      { tag: 'column', width: 'auto', elements: [btn('删除定时任务', { a: 'sch_drop', s: o.scheduleId })] },
    ] });
  } else {
    els.push({ tag: 'markdown', content: '<font color="red">新版本不允许定时执行，这个定时任务无法继续。</font>' });
    els.push(btn('删除定时任务', { a: 'sch_drop', s: o.scheduleId }));
  }
  return shell(`Amber · 指令已更新：${o.name}`, 'orange', els);
}

// ---------- command secrets (D48)

const fmtDay = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

/** Private-chat form for a command's secrets. Values are typed here and never shown again. */
export function secretFormCard(c: CommandRow, info: SecretInfo[], note?: string): object {
  const where = c.scopeType === 'p2p' ? '私聊指令' : '群指令';
  const status = info.map(i => `- **${i.name}**：${i.set ? `已设置${i.last4 ? `（末尾 ${sanitizeMarkdown(i.last4, 8)}）` : ''} · ${fmtDay(i.updatedAt!)}` : '<font color="red">未设置</font>'}`).join('\n');
  return shell(`Amber · 设置密钥：${c.name}`, 'orange', [
    { tag: 'markdown', content: `「**${sanitizeMarkdown(c.name, 40)}**」（${where}）运行时需要下面的密钥。这里填的值加密保存在 Amber 里，不会出现在聊天记录里，也不会交给 agent；执行时只交给这条指令。` },
    ...(c.scopeType === 'p2p' ? [] : [{ tag: 'markdown', content: '<font color="red">这是群指令：群里每个执行它的人都会用到这些密钥。请只填权限够用的凭证。</font>' }]),
    { tag: 'markdown', content: status },
    ...(note ? [{ tag: 'markdown', content: `✅ ${sanitizeMarkdown(note, 300)}` }] : []),
    {
      tag: 'form', name: 'secrets', elements: [
        ...info.map(i => ({
          tag: 'input', name: i.name, input_type: 'password', label: { tag: 'plain_text', content: i.name }, label_position: 'top',
          placeholder: { tag: 'plain_text', content: i.set ? '留空表示不修改' : '填写值（至少 6 个字符）' },
        })),
        btn('保存', { a: 'sec_save', c: c.id }, 'primary', { form_action_type: 'submit', name: 'save' }),
      ],
    },
    { tag: 'markdown', content: '<font color="grey">只能覆盖或删除，不能再查看。删除密钥请在网站的指令页面操作。</font>', text_size: 'notation' },
  ]);
}

/** Several commands match a name: pick one. */
export function secretPickCard(items: { c: CommandRow; where: string }[]): object {
  return shell('Amber · 设置密钥', 'orange', [
    { tag: 'markdown', content: '有多条同名指令，选择要设置密钥的那一条：' },
    ...items.map(({ c, where }) => ({
      tag: 'column_set', flex_mode: 'none', columns: [
        { tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center', elements: [{ tag: 'markdown', content: `**${sanitizeMarkdown(c.name, 40)}** · ${sanitizeMarkdown(where, 60)}\n<font color="grey">${c.status === 'active' ? '已生效' : c.status === 'pending' ? '审核中' : '待认领'} · ${c.specHash.slice(0, 8)}</font>` }] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [btn('选择', { a: 'sec_form', c: c.id }, 'primary')] },
      ],
    })),
  ]);
}

// ---------- executors (D50)

function executorLines(e: ExecutorRow): string {
  const envs = Object.entries(e.envs).sort(([a], [b]) => a.localeCompare(b, 'zh')).flatMap(([k, v]) => {
    const a = effectiveAccess(v), cred = new Set(credentialPaths(v));
    // Every path on its own line, sorted; credential paths marked in place.
    const lines = (l?: string[], mark = true) => [...(l ?? [])].sort().map(p => `　　- \`${sanitizeMarkdown(p, 300)}\`${mark && cred.has(p) ? ' <font color="red">⚠️ 凭证</font>' : ''}`);
    const vars = Object.entries(v.vars ?? {}).sort(([x], [y]) => x.localeCompare(y));
    return [
      '',
      `**环境「${sanitizeMarkdown(k, 40)}」**${v.source ? `（来源：${sanitizeMarkdown(v.source, 100)}）` : ''}`,
      `- {WORKDIR}：\`${sanitizeMarkdown(v.workdir, 300)}\``,
      ...(v.interpreter ? [`- Python：\`${sanitizeMarkdown(v.interpreter, 300)}\``] : []),
      ...(a.readWrite?.length ? ['- 可读写：', ...lines(a.readWrite)] : []),
      ...(a.readOnly?.length ? ['- 只读：', ...lines(a.readOnly)] : []),
      ...(a.deny?.length ? ['- 禁止：', ...lines(a.deny, false)] : []),
      ...(vars.length ? ['- 环境变量：', ...vars.map(([n, val]) => `　　- \`${sanitizeMarkdown(n, 64)}=${sanitizeMarkdown(val, 200)}\``)] : []),
      ...(v.realHome ? ['- HOME：用户主目录（能访问的仍只有上面这些路径）'] : []),
      ...(v.follow ? [`- 定义文件：\`${sanitizeMarkdown(v.follow, 300)}\`（之后它的路径、环境变量、Python 有变化会自动生效，并通知管理员）`] : []),
      ...(cred.size ? ['<font color="red">⚠️ 标记的是凭证路径（含凭证路径）：这个环境里的指令能使用这些凭证</font>'] : []),
    ];
  });
  return [
    `**执行端**：${e.name}`,
    `**来源机器**：${sanitizeMarkdown(e.machine, 60)}（按 IP 白名单识别）${e.version ? `　**版本**：${sanitizeMarkdown(e.version, 40)}` : ''}`,
    `**公钥指纹**：\`${showFingerprint(e.fingerprint)}\``,
    ...envs,
  ].join('\n');
}

/** Sent to every admin when an executor registers. Approving lets Amber send it jobs. */
export function executorApprovalCard(e: ExecutorRow, h: string): object {
  return shell('Amber · 执行端申请登记', 'orange', [
    { tag: 'markdown', content: `${executorLines(e)}\n\n批准后，声明了 \`env: "${e.name}/环境名"\` 并通过审核的指令会在这台机器上执行，**能访问的就是上面列出的路径**（指令自己不能再加）。**请先和安装的人核对公钥指纹**（执行端安装时会打印出来），确认是你们自己装的。` },
    buttonRow([btn('批准', { a: 'exe_ok', e: e.id, h }, 'primary'), btn('拒绝', { a: 'exe_no', e: e.id, h }, 'danger')]),
  ]);
}

export function executorDecidedCard(e: ExecutorRow, by: string): object {
  const ok = e.status === 'approved';
  return shell(`Amber · 执行端${ok ? '已批准' : e.status === 'rejected' ? '已拒绝' : '登记'}`, ok ? 'green' : 'grey', [{ tag: 'markdown', content: `${executorLines(e)}\n\n${ok ? '✅ 已批准' : e.status === 'rejected' ? '已拒绝' : `状态：${e.status}`}（${sanitizeMarkdown(by, 40)}）` }]);
}

export function executorListCard(list: { e: ExecutorRow; online: boolean }[]): object {
  const label: Record<string, string> = { pending: '等待批准', approved: '已批准', rejected: '已拒绝', revoked: '已撤销' };
  const lines = list.map(({ e, online }) => `- **${e.name}**（${sanitizeMarkdown(e.machine, 60)}）· ${label[e.status] ?? e.status}${e.status === 'approved' ? ` · ${online ? '在线' : '离线'}` : ''} · 环境：${Object.keys(e.envs).map(k => sanitizeMarkdown(k, 40)).join('、')} · 指纹 \`${showFingerprint(e.fingerprint).slice(0, 9)}\` · 最后在线 ${e.lastSeen ? new Date(e.lastSeen).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '从未'}`);
  return shell('Amber · 执行端', 'blue', [{ tag: 'markdown', content: (lines.join('\n') || '（还没有执行端登记）') + '\n\n撤销：发「撤销执行端 名称」。' }]);
}

/** Sent to admins when a followed environment changed on its own (D53). No approval needed; one click revokes. */
export function executorFollowCard(e: ExecutorRow, changes: FollowChange[]): object {
  const KIND: Record<string, string> = { readWrite: '可读写', readOnly: '只读', deny: '禁止' };
  const lines: string[] = [];
  for (const c of changes) {
    if (c.removedEnv) { lines.push(`**环境「${sanitizeMarkdown(c.env, 40)}」已删除**（它的定义文件不在了；这个环境里的指令会执行失败）`); continue; }
    const v = e.envs[c.env];
    const cred = new Set(v ? credentialPaths(v) : []);
    lines.push(`**环境「${sanitizeMarkdown(c.env, 40)}」**（\`${sanitizeMarkdown(v?.follow ?? '', 300)}\`）`);
    for (const k of ['readWrite', 'readOnly', 'deny']) {
      for (const p of c.added[k] ?? []) lines.push(`- 新增${KIND[k]}：\`${sanitizeMarkdown(p, 300)}\`${cred.has(p) ? ' <font color="red">⚠️ 凭证</font>' : ''}`);
      for (const p of c.removed[k] ?? []) lines.push(`- 去掉${KIND[k]}：\`${sanitizeMarkdown(p, 300)}\``);
    }
    if (c.vars.length) lines.push(`- 环境变量有变化：${c.vars.map(n => `\`${sanitizeMarkdown(n, 64)}\``).join('、')}`);
    if (c.python) lines.push(`- Python：\`${sanitizeMarkdown(c.python[0] ?? '默认', 200)}\` → \`${sanitizeMarkdown(c.python[1] ?? '默认', 200)}\``);
  }
  return shell(`Amber · 执行端环境已自动更新：${e.name}`, 'blue', [
    { tag: 'markdown', content: `执行端 **${e.name}**（${sanitizeMarkdown(e.machine, 60)}）环境文件夹里的定义文件变了，已按新内容生效（这类变化不需要再批准）：\n\n${lines.join('\n')}\n\n有问题可以直接撤销这个执行端，撤销后立即停止派任务。` },
    buttonRow([btn('撤销执行端', { a: 'exe_rv', e: e.id }, 'danger')]),
  ]);
}
