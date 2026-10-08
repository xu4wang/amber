import type { CommandRow } from './db.ts';
import type { Block } from './engine.ts';

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
      btn(runText, { a: 'run', c: c.id }, runType),
      btn('返回', { a: 'list' }),
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
        btn(runText, { a: 'run', c: c.id }, runType, { form_action_type: 'submit', name: 'submit' }),
      ],
    },
    btn('返回', { a: 'list' }),
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
    const converted = m[1] === 'table' ? tableToCard(m[2]) : vegaLiteToChart(m[2]);
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
  const ex = spec?.encoding?.x?.field, ey = spec?.encoding?.y?.field;
  if (!Array.isArray(values) || values.length === 0 || values.length > 500 || !ex || !ey) return null;
  if (mark !== 'bar' && mark !== 'line') return null;
  const title = typeof spec.title === 'string' ? spec.title : spec?.title?.text;
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

export function resultCard(name: string, whoOpenId: string | undefined, blocks: Block[], runId: string, elapsedMs: number, cmdId: string): object {
  return shell(`Amber · ${name}`, 'green', [
    ...renderBlocks(blocks),
    { tag: 'markdown', content: `由 ${person(whoOpenId)} 执行 · ${(elapsedMs / 1000).toFixed(1)} 秒 · run ${runId}`, text_size: 'notation' },
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
  kind: 'run' | 'schedule' | 'schedule_resume' | 'schedule_delete'; reqId: string; cmd: CommandRow; args: Record<string, string>;
  requestedBy: string; targetOpenId?: string; ruleText?: string; nextText?: string; scheduleId?: string;
}): object {
  const danger = o.cmd.options.confirm || o.kind === 'schedule_delete';
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
      ? '<font color="grey">点「执行」即以你本人的身份执行一次；结果显示在这张卡片上，同时返回给发起请求的 agent。</font>'
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
    if (buttons.length) els.push({ tag: 'column_set', flex_mode: 'none', columns: buttons.map(b => ({ tag: 'column', width: 'auto', elements: [b] })) });
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
