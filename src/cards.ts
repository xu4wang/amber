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
        { tag: 'column', width: 'weighted', weight: 4, vertical_align: 'center', elements: [{ tag: 'markdown', content: `**${sanitizeMarkdown(c.name, 40)}**${c.global ? '　<font color="blue">全局</font>' : ''}${c.sideEffect === 'write' ? '　<font color="red">写操作</font>' : ''}\n<font color="grey">${sanitizeMarkdown(c.description || '（无说明）', 120)}</font>` }] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [btn('选择', { a: 'pick', c: c.id }, 'primary')] },
      ],
    });
  }
  return shell('Amber · 指令', 'orange', els);
}

export function formCard(c: CommandRow): object {
  if (c.params.length === 0) {
    return shell(`Amber · ${c.name}`, 'orange', [
      { tag: 'markdown', content: sanitizeMarkdown(c.description || '') || '这条指令没有参数。' },
      btn('执行', { a: 'run', c: c.id }, 'primary'),
      btn('返回', { a: 'list' }),
    ]);
  }
  const inputs = c.params.map(p => ({
    tag: 'input',
    name: p.name,
    label: { tag: 'plain_text', content: p.label ?? p.name },
    label_position: 'left',
    placeholder: { tag: 'plain_text', content: p.defaultFrom === 'caller.city' ? `不填则用你的办公城市${p.default ? `（查不到时用 ${p.default}）` : ''}` : p.default !== undefined ? `默认：${p.default}` : (p.required ? '必填' : '可不填') },
    ...(p.default !== undefined && !p.defaultFrom ? { default_value: p.default } : {}),
    required: !!p.required,
  }));
  return shell(`Amber · ${c.name}`, 'orange', [
    ...(c.description ? [{ tag: 'markdown', content: `<font color="grey">${sanitizeMarkdown(c.description, 200)}</font>` }] : []),
    {
      tag: 'form',
      name: 'args',
      elements: [
        ...inputs,
        btn('执行', { a: 'run', c: c.id }, 'primary', { form_action_type: 'submit', name: 'submit' }),
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
  const re = /```vega-lite\s*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const pushText = (t: string) => { const x = t.trim(); if (x) els.push({ tag: 'markdown', content: sanitizeMarkdown(x) }); };
  while ((m = re.exec(md))) {
    pushText(md.slice(last, m.index));
    last = m.index + m[0].length;
    const chart = vegaLiteToChart(m[1]);
    if (chart) els.push(...chart); else pushText('（图表无法显示）');
  }
  pushText(md.slice(last));
  return els;
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
  for (const b of blocks) {
    if (b.kind === 'markdown') {
      if (b.text) els.push(...markdownWithCharts(b.text));
      continue;
    }
    const values = b.rows
      .map(r => ({ x: String(r[b.x] ?? ''), y: Number(r[b.y]) }))
      .filter(v => v.x && Number.isFinite(v.y));
    if (values.length === 0) { els.push({ tag: 'markdown', content: '（没有可画图的数据）' }); continue; }
    if (b.title) els.push({ tag: 'markdown', content: `**${sanitizeMarkdown(b.title, 60)}**` });
    els.push({
      tag: 'chart',
      aspect_ratio: '16:9',
      chart_spec: {
        type: 'line',
        data: { values },
        xField: 'x',
        yField: 'y',
        point: { visible: false },
        line: { style: { curveType: 'monotone' } },
        axes: [
          { orient: 'left', title: { visible: !!b.yLabel, text: b.yLabel ?? '' } },
          { orient: 'bottom', label: { autoHide: true } },
        ],
      },
    });
  }
  return els;
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
