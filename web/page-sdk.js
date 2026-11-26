// Amber page SDK: load it in a page app with <script src="/sdk/amber-page.js"></script>.
//   const r = await Amber.run('应用名', { 参数: '值' });   // runs the app as the person looking at the page
//   r.markdown  the app's output; r.blocks  [{kind:'markdown',text} | {kind:'table',data} | {kind:'chart',data} | {kind:'json',data}]
//   r.json      the first ```json block's data, when the app prints one
//   Amber.render(element, r)   shows the result the way Amber's cards do (text, tables, charts)
//   Amber.open(url)            opens a link on the network allow list (Feishu by default) in a new tab
//   Amber.me()                 { name, page, embedded }
// Embedding other pages (amber.json "embeds"; the embedded page allows it with "embeddable"):
//   const h = await Amber.embed(element, 'key', { height, tools })   the embedded page; clicking a blank spot of it shows
//                                           icons at its left: click filter on/off, open the original page, plus your own
//                                           tools [{ icon: '<svg…>', title, onClick(h) }]
//   Amber.setParams({ date: '2026-11' })    shared parameters: embeds get theirs (mapped in amber.json; "follow": false opts out)
//   Amber.setFilter({ region: '泰国' })      click filter: every embed with filtering on that receives the field; null clears
//   Amber.onFilter(fn)                      fn(filter) when the filter changes (from this page or an embed)
//   Amber.filterBar(element, { region: '区域' })   shows 「联动筛选：区域=泰国 ×」 while a filter is on
// In an embedded page:
//   Amber.embedded                          true when shown inside another page
//   Amber.onParams(fn)                      fn(params, { follow }): params from the host, or null when not following (show your own)
//   Amber.onFilter(fn)                      fn(filter) from the host (only the fields this page declared in "receive")
//   Amber.emit({ region: '泰国' })           a click here filters the host and its other embeds (fields declared in "emit")
//   Amber.onExport(fn)                      fn() → { name, columns, rows } or { sheets: [...] } for the host's 导出 Excel (default: the page's tables)
// Anywhere: Amber.exportExcel('文件名', { columns: [{ name, label }], rows }) downloads an .xlsx file.
// Calls go through Amber (the window around the page); the page itself cannot reach the network.
(function () {
  const AMBER = __AMBER_ORIGIN__;
  // Amber's window is always the top one; an embedded page sits in a frame inside its host page.
  const EMBEDDED = window.parent !== window.top;
  const PAGE_ID = (/^\/c\/([0-9a-f]{8})\./.exec(location.pathname) || [])[1] || '';
  let seq = 0;
  const waiting = new Map();
  window.addEventListener('message', ev => {
    if (ev.source !== window.top || ev.origin !== AMBER) return;
    const m = ev.data || {};
    if (m.amber !== 1 || !waiting.has(m.id)) return;
    const { ok, fail } = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.ok) ok(m.result); else fail(Object.assign(new Error(m.message || '执行失败'), { code: m.error }));
  });
  const ask = msg => new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    window.top.postMessage(Object.assign({ amber: 1, id, page: PAGE_ID }, msg), AMBER);
  });

  // A small status line Amber shows while an app runs, and when it fails (the page may hide it: Amber.quiet = true).
  let tip;
  const status = (text, bad) => {
    if (Amber.quiet) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:360px;padding:8px 14px;font:13px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .3s';
      document.body.appendChild(tip);
    }
    tip.textContent = text;
    tip.style.background = bad ? '#fdecea' : '#fff7e8';
    tip.style.color = bad ? '#b42318' : '#5c3b00';
    tip.style.opacity = text ? '1' : '0';
  };
  let busy = 0, hideTimer;

  const loaded = {};
  const lib = src => loaded[src] || (loaded[src] = new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => fail(new Error('加载失败：' + src)); document.head.appendChild(s); }));

  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const Amber = {
    quiet: false,
    async run(app, args) {
      busy++;
      clearTimeout(hideTimer);
      status(`正在执行「${app}」……`);
      const t0 = Date.now();
      try {
        const r = await ask({ type: 'run', app: String(app), args: args || {} });
        if (!r.ok) throw Object.assign(new Error(r.error || '执行失败'), { code: 'failed', result: r });
        status(`「${app}」完成 · 以你的身份执行 · ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
        hideTimer = setTimeout(() => { if (!busy) status(''); }, 2500);
        return r;
      } catch (e) {
        if (e.code !== 'canceled') status(`「${app}」没有执行成功：${e.message}`, true);
        throw e;
      } finally { busy--; }
    },
    open(url) { return ask({ type: 'open', url: String(url) }); },
    me() { return ask({ type: 'me' }); },
    /** Shows a result like Amber's cards: Markdown text, tables and vega-lite charts. */
    async render(el, r) {
      await lib('/vendor/marked.min.js'); await lib('/vendor/purify.min.js');
      el.innerHTML = '';
      for (const b of (r && r.blocks) || []) {
        const box = document.createElement('div');
        box.className = 'amber-block amber-' + b.kind;
        if (b.kind === 'markdown') box.innerHTML = window.DOMPurify.sanitize(window.marked.parse(b.text || ''));
        else if (b.kind === 'table') {
          const t = b.data || {}, cols = Array.isArray(t.columns) ? t.columns : [], rows = Array.isArray(t.rows) ? t.rows : [];
          box.innerHTML = `<table><thead><tr>${cols.map(c => `<th>${esc(c.label || c.name)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${cols.map(c => `<td${c.type === 'number' ? ' style="text-align:right"' : ''}>${esc(row[c.name])}</td>`).join('')}</tr>`).join('')}</tbody></table>`
            + (t.total > rows.length ? `<p>共 ${esc(t.total)} 行，这里显示 ${rows.length} 行</p>` : '');
        } else if (b.kind === 'chart') {
          await lib('/vendor/vega.min.js'); await lib('/vendor/vega-lite.min.js'); await lib('/vendor/vega-embed.min.js');
          box.style.cssText = 'display:block;width:100%';   // vega-embed makes it inline-block, which measures 0 wide
          el.appendChild(box);   // in the page first: a "container" width is measured from it
          const spec = Object.assign({ width: 'container' }, b.data || {});
          await window.vegaEmbed(box, spec, { actions: false, renderer: 'svg' }).catch(() => { box.textContent = '（图表无法显示）'; });
          continue;
        } else continue;   // json: data for the page, not shown
        el.appendChild(box);
      }
    },
  };

  // ---------- embeds (host side)
  const ME = location.origin;
  const embeds = new Map();          // key -> { e, frame, follow, link, bar }
  let shared = {}, filter = {};
  const filterFns = [], paramFns = [], bars = [];
  let infoP;
  const store = (k, v) => { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (_) { return null; } };
  const pick = (o, keys) => { const r = {}; for (const k of keys || []) if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k]; return r; };
  const css = () => {
    if (document.getElementById('amber-embed-css')) return;
    const st = document.createElement('style');
    st.id = 'amber-embed-css';
    st.textContent = `.amber-embed{position:relative;border:1px dashed transparent;border-radius:6px;min-width:0;transition:border-color .15s}
.amber-embed:hover,.amber-embed.tools-on{border-color:#f0b45e}
.amber-embed iframe{border:0;width:100%;display:block;min-height:120px;background:transparent}
.amber-embed-tools{position:absolute;right:100%;margin-right:6px;top:50%;transform:translateY(-50%);z-index:3;display:none;flex-direction:column;gap:2px;padding:3px;background:#fff;border:1px solid #e5e6eb;border-radius:8px;box-shadow:0 4px 16px rgba(31,35,41,.12)}
.amber-embed.tools-on .amber-embed-tools{display:flex}
.amber-embed-tools button{all:unset;box-sizing:border-box;position:relative;width:30px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;color:#4e5969;transition:background .12s,color .12s}
.amber-embed-tools button:hover{background:#f2f3f5;color:#1f2329}
.amber-embed-tools button.on{background:#e8efff;color:#3370ff}
.amber-embed-tools button.on:hover{background:#d9e5ff}
.amber-embed-tools button svg{width:18px;height:18px;display:block}
.amber-embed-tools button[data-tip]:hover::after{content:attr(data-tip);position:absolute;right:38px;top:50%;transform:translateY(-50%);white-space:nowrap;background:#1f2329;color:#fff;font:12px/1.5 -apple-system,"PingFang SC",system-ui,sans-serif;padding:4px 8px;border-radius:4px;pointer-events:none;z-index:4}
.amber-embed-deny{padding:40px 16px;text-align:center;color:#646a73;font:13px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif;background:#fafbfc;border-radius:6px}
.amber-embed-deny::before{content:"🔒";display:block;font-size:22px;margin-bottom:4px}
.amber-filter{display:none;align-items:center;gap:8px;flex-wrap:wrap;font:13px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif;color:#3370ff}
.amber-filter.on{display:flex}.amber-filter span{background:#fff;border:1px solid #c6d6ff;border-radius:12px;padding:0 10px}
.amber-filter a{margin-left:6px;cursor:pointer;color:#d83931}`;
    document.head.appendChild(st);
  };
  const stateFor = x => {
    const params = {};
    for (const [mine, theirs] of Object.entries(x.e.params || {})) if (shared[theirs] !== undefined) params[mine] = shared[theirs];
    return { amberEmbed: 1, type: 'state', follow: x.follow, params: x.follow ? params : null, link: x.link, filter: x.link ? pick(filter, x.e.receive) : {} };
  };
  const push = x => { if (x.frame && x.frame.contentWindow) x.frame.contentWindow.postMessage(stateFor(x), ME); };
  const pushAll = () => embeds.forEach(push);
  const drawBars = () => bars.forEach(b => {
    const keys = Object.keys(filter);
    b.el.classList.toggle('on', keys.length > 0);
    b.el.innerHTML = keys.length ? '联动筛选：' + keys.map(k => `<span>${esc(b.labels[k] || k)}=${esc(filter[k])}<a data-k="${esc(k)}" title="取消">×</a></span>`).join('') : '';
  });
  const setFilter = f => {
    filter = f === null ? {} : pick(Object.assign({}, filter, f), Object.keys(Object.assign({}, filter, f)));
    filterFns.forEach(fn => { try { fn(Object.assign({}, filter)); } catch (e) { console.error(e); } });
    drawBars();
    pushAll();
  };
  window.addEventListener('message', ev => {
    if (ev.origin !== ME) return;
    const m = ev.data || {};
    if (m.amberEmbed !== 1) return;
    if (EMBEDDED && ev.source === window.parent) return embeddedState(m);
    for (const x of embeds.values()) {
      if (!x.frame || ev.source !== x.frame.contentWindow) continue;
      if (m.type === 'reply' && x.waiting && x.waiting.has(m.rid)) { x.waiting.get(m.rid)(m.data); x.waiting.delete(m.rid); }
      else if (m.type === 'hello') push(x);
      else if (m.type === 'tap') x.toggleTools && x.toggleTools();
      else if (m.type === 'height' && !x.fixed) x.frame.style.height = Math.max(120, Math.min(4000, Number(m.h) || 0)) + 'px';
      else if (m.type === 'emit' && x.link) {
        // Declared fields only; a field set to null clears it.
        const f = {}, got = m.filter || {};
        for (const k of x.e.emit || []) if (Object.prototype.hasOwnProperty.call(got, k)) f[k] = got[k];
        if (Object.keys(f).length) setFilter(f);
      }
    }
  });

  let rseq = 0;
  /** Asks an embedded page for something (export data); undefined after 5 s without an answer. */
  const askEmbed = (x, what) => new Promise(ok => {
    if (!x.frame || !x.frame.contentWindow) return ok(undefined);
    const rid = ++rseq;
    (x.waiting = x.waiting || new Map()).set(rid, ok);
    x.frame.contentWindow.postMessage({ amberEmbed: 1, type: 'ask', what, rid }, ME);
    setTimeout(() => { if (x.waiting.has(rid)) { x.waiting.delete(rid); ok(undefined); } }, 5000);
  });

  // ---------- Excel export: a small .xlsx writer (stored zip, inline strings), no libraries
  const sheetsOf = d => {
    const list = Array.isArray(d) ? d : d && Array.isArray(d.sheets) ? d.sheets : d && d.rows ? [d] : [];
    return list.map((sh, i) => {
      const rows = Array.isArray(sh.rows) ? sh.rows : [];
      const cols = Array.isArray(sh.columns) && sh.columns.length ? sh.columns.map(c => typeof c === 'string' ? { name: c, label: c } : { name: c.name, label: c.label || c.name })
        : Array.isArray(rows[0]) ? rows[0].map((_, j) => ({ name: j, label: '' })) : Object.keys(rows[0] || {}).map(k => ({ name: k, label: k }));
      return { name: String(sh.name || `Sheet${i + 1}`), cols, rows: rows.map(r => cols.map(c => Array.isArray(r) ? r[c.name] : r[c.name])), header: cols.some(c => c.label) };
    });
  };
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const zip = files => {
    const enc = new TextEncoder(), parts = [], dir = [];
    let off = 0;
    const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
    for (const [name, text] of files) {
      const nb = enc.encode(name), data = enc.encode(text), crc = crc32(data);
      const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0x21), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(nb.length), ...u16(0)];
      const head = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...common]);
      parts.push(head, nb, data);
      dir.push(new Uint8Array([0x50, 0x4b, 0x01, 0x02, ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(off)]), nb);
      off += head.length + nb.length + data.length;
    }
    const size = dir.reduce((n, p) => n + p.length, 0);
    return new Blob([...parts, ...dir, new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(size), ...u32(off), 0, 0])], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  };
  const xe = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  const colName = i => { let s = ''; for (i++; i; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + (i - 1) % 26) + s; return s; };
  const cell = (v, ref, bold) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number' && isFinite(v)) return `<c r="${ref}"${bold ? ' s="1"' : ''}><v>${v}</v></c>`;
    return `<c r="${ref}" t="inlineStr"${bold ? ' s="1"' : ''}><is><t xml:space="preserve">${xe(v)}</t></is></c>`;
  };
  /** Downloads data as an .xlsx file: { columns: [{ name, label }], rows: [...] }, or { sheets: [{ name, columns, rows }] }. */
  Amber.exportExcel = (filename, data) => {
    const sheets = sheetsOf(data);
    if (!sheets.length) throw new Error('没有可导出的数据');
    const used = new Set();
    const names = sheets.map((sh, i) => { let n = sh.name.replace(/[\\/?*\[\]:]/g, ' ').slice(0, 31) || `Sheet${i + 1}`; while (used.has(n)) n = (n.slice(0, 28) + '_' + i); used.add(n); return n; });
    const files = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${xe(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`],
      ['xl/styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
      ...sheets.map((sh, i) => {
        const rows = (sh.header ? [sh.cols.map(c => c.label)] : []).concat(sh.rows);
        const xml = rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => cell(v, colName(ci) + (ri + 1), sh.header && ri === 0)).join('')}</row>`).join('');
        return [`xl/worksheets/sheet${i + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xml}</sheetData></worksheet>`];
      }),
    ];
    const a = document.createElement('a');
    a.href = URL.createObjectURL(zip(files));
    a.download = String(filename || '导出').replace(/[\\/:*?"<>|]/g, ' ').slice(0, 80) + '.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  };

  document.addEventListener('click', () => embeds.forEach(o => o.toggleTools && o.toggleTools(false)));
  // 20px line icons: link (two chain links), open (box with an arrow out), download (arrow into a tray).
  const ICON = {
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13.5a4.5 4.5 0 006.4.4l2.6-2.6a4.5 4.5 0 00-6.4-6.4l-1.4 1.4"/><path d="M14 10.5a4.5 4.5 0 00-6.4-.4l-2.6 2.6a4.5 4.5 0 006.4 6.4l1.4-1.4"/></svg>',
    open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4.5A1.5 1.5 0 0116.5 20h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10"/></svg>',
    excel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 15.5v3A1.5 1.5 0 005.5 20h13a1.5 1.5 0 001.5-1.5v-3"/></svg>',
  };
  Amber.setParams = p => { shared = Object.assign({}, shared, p || {}); pushAll(); };
  Amber.setFilter = f => setFilter(f);
  Amber.onFilter = fn => { filterFns.push(fn); if (Object.keys(filter).length) fn(Object.assign({}, filter)); };
  Amber.filterBar = (el, labels) => {
    css();
    el = typeof el === 'string' ? document.querySelector(el) : el;
    el.classList.add('amber-filter');
    el.addEventListener('click', ev => { const k = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-k'); if (k) setFilter({ [k]: null }); });
    bars.push({ el, labels: labels || {} });
    drawBars();
  };
  Amber.embed = async (el, key, opts) => {
    if (EMBEDDED) throw new Error('嵌入的页面里不能再嵌入页面');
    opts = opts || {};
    el = typeof el === 'string' ? document.querySelector(el) : el;
    const all = await (infoP || (infoP = ask({ type: 'embeds' })));
    const e = all[key];
    if (!e) throw new Error(`amber.json 的 embeds 里没有「${key}」`);
    css();
    const box = document.createElement('div');
    box.className = 'amber-embed';
    const saved = store(`amber-embed:${PAGE_ID}:${key}`) || {};
    const canFollow = !e.denied && Object.keys(e.params || {}).length > 0;
    const canLink = !e.denied && ((e.receive || []).length + (e.emit || []).length) > 0;
    // Parameters follow the host's as amber.json says (no switch for viewers); filtering can be switched off per viewer.
    const x = { e, follow: canFollow && e.follow !== false, link: canLink && (saved.link !== undefined ? saved.link : true), fixed: !!opts.height };
    // Tools: a column of icons at the report's left, shown when the viewer clicks a blank spot of it (or the notice).
    const tools = document.createElement('div');
    tools.className = 'amber-embed-tools';
    const tool = (t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', t.title);
      b.setAttribute('data-tip', t.tip || t.title);
      b.innerHTML = t.icon;
      b.onclick = ev => { ev.stopPropagation(); t.onClick(b); };
      tools.appendChild(b);
      return b;
    };
    if (canLink) {
      const fields = [(e.receive || []).length ? '接收：' + e.receive.join('、') : '', (e.emit || []).length ? '发出：' + e.emit.join('、') : ''].filter(Boolean).join('；');
      const tip = () => `点击联动：${x.link ? '已打开' : '已关闭'}（${fields}），点一下${x.link ? '关闭' : '打开'}`;
      const short = () => x.link ? '点击联动：开' : '点击联动：关';
      const b = tool({ title: tip(), tip: short(), icon: ICON.link, onClick: b => {
        x.link = !x.link;
        store(`amber-embed:${PAGE_ID}:${key}`, { link: x.link });
        b.classList.toggle('on', x.link); b.setAttribute('aria-label', tip()); b.setAttribute('data-tip', short());
        push(x);
      } });
      b.classList.toggle('on', x.link);
    }
    if (e.page) tool({ tip: e.owner ? `打开原页面 · ${e.owner} 维护` : '打开原页面', title: `打开原页面：${opts.title || e.title}${e.name ? `（${e.name}${e.owner ? '，' + e.owner + ' 维护' : ''}）` : ''}`, icon: ICON.open, onClick: () => ask({ type: 'openEmbed', key, state: { params: stateFor(x).params, filter: stateFor(x).filter } }) });
    if (e.src) tool({ tip: '导出 Excel', title: '导出 Excel：这个报表当前的数据', icon: ICON.excel, onClick: async () => {
      try {
        const data = await askEmbed(x, 'export');
        if (!data || !sheetsOf(data).some(sh => sh.rows.length)) return alert('这个报表没有可导出的数据');
        // One table taken from the page: name its sheet after the report.
        if (Array.isArray(data.sheets) && data.sheets.length === 1 && /^表\d+$/.test(data.sheets[0].name || '')) data.sheets[0].name = opts.title || e.title;
        Amber.exportExcel(data.name || opts.title || e.title, data);
      } catch (err) { alert('导出失败：' + (err && err.message || err)); }
    } });
    for (const t of opts.tools || []) tool({ title: String(t.title || ''), icon: t.icon || esc(String(t.title || '?').slice(0, 1)), onClick: () => t.onClick && t.onClick(handle) });
    if (tools.children.length) box.appendChild(tools);
    x.toggleTools = on => {
      const want = on === undefined ? !box.classList.contains('tools-on') : on;
      if (want) embeds.forEach(o => o !== x && o.toggleTools && o.toggleTools(false));
      box.classList.toggle('tools-on', want && tools.children.length > 0);
    };
    if (e.src) {
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-downloads allow-modals');
      f.setAttribute('referrerpolicy', 'no-referrer');
      if (opts.height) f.style.height = typeof opts.height === 'number' ? opts.height + 'px' : opts.height;
      f.src = e.src;
      x.frame = f;
      box.appendChild(f);
    } else {
      const d = document.createElement('div');
      d.className = 'amber-embed-deny';
      d.textContent = e.message || '无法显示这个页面';
      d.onclick = ev => { ev.stopPropagation(); x.toggleTools(); };
      box.appendChild(d);
    }
    el.innerHTML = '';
    el.appendChild(box);
    embeds.set(key, x);
    const handle = { key, info: e, frame: x.frame || null, element: box, get follow() { return x.follow; }, get link() { return x.link; }, refresh: () => push(x), showTools: on => x.toggleTools(on !== false) };
    return handle;
  };

  // ---------- embedded side
  let lastParams = null, lastFilter = '{}', got = false, follow = false;
  let exportFn = null;
  /** The tables on the page, for export when it registered nothing: header from <th>, numbers kept as numbers. */
  const scrapeTables = () => [...document.querySelectorAll('table')].map((t, i) => {
    const rows = [...t.rows].map(r => [...r.cells].map(c => { const v = c.innerText.trim(); return /^-?[\d,]+(\.\d+)?$/.test(v) ? Number(v.replace(/,/g, '')) : v; }));
    const head = t.tHead && t.tHead.rows.length ? rows.shift() : null;
    return { name: (t.caption && t.caption.innerText) || `表${i + 1}`, columns: head ? head.map((h, j) => ({ name: j, label: String(h) })) : undefined, rows };
  }).filter(sh => sh.rows.length);
  Amber.onExport = fn => { exportFn = fn; };
  async function embeddedAsk(m) {
    let data;
    try { data = m.what === 'export' ? (exportFn ? await exportFn() : { sheets: scrapeTables() }) : undefined; } catch (e) { console.error(e); }
    window.parent.postMessage({ amberEmbed: 1, type: 'reply', rid: m.rid, data: data === undefined ? null : JSON.parse(JSON.stringify(data)) }, ME);
  }
  function embeddedState(m) {
    if (m.type === 'ask') return embeddedAsk(m);
    if (m.type !== 'state') return;
    const p = JSON.stringify(m.params), f = JSON.stringify(m.filter || {});
    if (!got || p !== JSON.stringify(lastParams) || follow !== !!m.follow) { lastParams = m.params; follow = !!m.follow; paramFns.forEach(fn => { try { fn(m.params, { follow }); } catch (e) { console.error(e); } }); }
    if (!got || f !== lastFilter) { lastFilter = f; filter = m.filter || {}; filterFns.forEach(fn => { try { fn(Object.assign({}, filter)); } catch (e) { console.error(e); } }); }
    got = true;
  }
  Amber.embedded = EMBEDDED;
  Amber.onParams = fn => { paramFns.push(fn); if (got) fn(lastParams, { follow }); };
  Amber.emit = f => { if (!EMBEDDED) return false; window.parent.postMessage({ amberEmbed: 1, type: 'emit', filter: f || {} }, ME); return true; };
  // Opened from a host page (打开原页面): start from the host's parameters and filter, with its own controls shown.
  if (!EMBEDDED && /^#amber=/.test(location.hash)) {
    try {
      const st = JSON.parse(decodeURIComponent(location.hash.slice(7)));
      lastParams = st.params || null; filter = st.filter || {}; lastFilter = JSON.stringify(filter); got = true; follow = false;
    } catch (_) {}
  }
  if (EMBEDDED) {
    const hello = () => window.parent.postMessage({ amberEmbed: 1, type: 'hello' }, ME);
    hello();
    let lastH = 0;
    // The content's own height (the document's scrollHeight never drops below the frame it is in).
    const size = () => { const b = document.body; if (!b) return; const cs = getComputedStyle(b); const h = Math.ceil(b.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)); if (Math.abs(h - lastH) > 2) { lastH = h; window.parent.postMessage({ amberEmbed: 1, type: 'height', h }, ME); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { hello(); size(); }); else size();
    if (window.ResizeObserver) { const watch = () => document.body && new ResizeObserver(size).observe(document.body); if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch); }
    window.addEventListener('load', size);
    // A click on a blank spot (not a link, control or something the page handles) shows the host's tools for this report.
    document.addEventListener('click', ev => {
      if (ev.defaultPrevented) return;
      for (let n = ev.target; n && n !== document; n = n.parentNode) {
        if (n.onclick || (n.matches && n.matches('a,button,input,select,textarea,label,summary,[role=button],[data-amber-action],.bar,tr.click'))) return;
      }
      window.parent.postMessage({ amberEmbed: 1, type: 'tap' }, ME);
    });
  }

  window.Amber = Amber;
})();
