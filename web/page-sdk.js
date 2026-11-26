// Amber page SDK: load it in a page app with <script src="/sdk/amber-page.js"></script>.
//   const r = await Amber.run('应用名', { 参数: '值' });   // runs the app as the person looking at the page
//   r.markdown  the app's output; r.blocks  [{kind:'markdown',text} | {kind:'table',data} | {kind:'chart',data} | {kind:'json',data}]
//   r.json      the first ```json block's data, when the app prints one
//   Amber.render(element, r)   shows the result the way Amber's cards do (text, tables, charts)
//   Amber.open(url)            opens a link on the network allow list (Feishu by default) in a new tab
//   Amber.me()                 { name, page, embedded }
// Embedding other pages (amber.json "embeds"; the embedded page allows it with "embeddable"):
//   const h = await Amber.embed(element, 'key', { height })   frame + title bar (source, maintainer, switches, open original)
//   Amber.setParams({ date: '2026-11' })    shared parameters: embeds that follow them get theirs (mapped in amber.json)
//   Amber.setFilter({ region: '泰国' })      click filter: every embed with filtering on that receives the field; null clears
//   Amber.onFilter(fn)                      fn(filter) when the filter changes (from this page or an embed)
//   Amber.filterBar(element, { region: '区域' })   shows 「联动筛选：区域=泰国 ×」 while a filter is on
// In an embedded page:
//   Amber.embedded                          true when shown inside another page
//   Amber.onParams(fn)                      fn(params, { follow }): params from the host, or null when not following (show your own)
//   Amber.onFilter(fn)                      fn(filter) from the host (only the fields this page declared in "receive")
//   Amber.emit({ region: '泰国' })           a click here filters the host and its other embeds (fields declared in "emit")
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
    st.textContent = `.amber-embed{border:1px dashed #f0b45e;border-radius:6px;background:#fffdf8;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.amber-embed-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px;padding:6px 10px;background:#fff4e5;border-bottom:1px dashed #f0b45e;font:12px/1.6 -apple-system,"PingFang SC",system-ui,sans-serif;color:#646a73}
.amber-embed-bar b{font-size:13px;color:#1f2329}.amber-embed-bar .sp{flex:1}
.amber-embed-bar label{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none}
.amber-embed-bar input{appearance:none;-webkit-appearance:none;width:26px;height:14px;border-radius:7px;background:#c9cdd4;position:relative;margin:0;cursor:pointer;transition:.15s}
.amber-embed-bar input::after{content:"";position:absolute;width:10px;height:10px;border-radius:50%;background:#fff;top:2px;left:2px;transition:.15s}
.amber-embed-bar input:checked{background:#3370ff}.amber-embed-bar input:checked::after{left:14px}
.amber-embed-bar a{color:#b26a00;cursor:pointer;text-decoration:none}.amber-embed-bar a:hover{text-decoration:underline}
.amber-embed iframe{border:0;width:100%;display:block;min-height:120px;flex:1 0 auto;background:#fff}
.amber-embed-deny{padding:40px 16px;text-align:center;color:#646a73;font:13px/1.7 -apple-system,"PingFang SC",system-ui,sans-serif}
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
      if (m.type === 'hello') push(x);
      else if (m.type === 'height' && !x.fixed) x.frame.style.height = Math.max(120, Math.min(4000, Number(m.h) || 0)) + 'px';
      else if (m.type === 'emit' && x.link) {
        // Declared fields only; a field set to null clears it.
        const f = {}, got = m.filter || {};
        for (const k of x.e.emit || []) if (Object.prototype.hasOwnProperty.call(got, k)) f[k] = got[k];
        if (Object.keys(f).length) setFilter(f);
      }
    }
  });

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
    const bar = document.createElement('div');
    bar.className = 'amber-embed-bar';
    const saved = store(`amber-embed:${PAGE_ID}:${key}`) || {};
    const canFollow = !e.denied && Object.keys(e.params || {}).length > 0;
    const canLink = !e.denied && ((e.receive || []).length + (e.emit || []).length) > 0;
    const x = { e, follow: canFollow && (saved.follow !== undefined ? saved.follow : e.follow), link: canLink && (saved.link !== undefined ? saved.link : true), fixed: !!opts.height };
    bar.innerHTML = `<b>${esc(opts.title || e.title)}</b>` + (e.name ? `<span class="src">来自「${esc(e.name)}」${e.owner ? ' · ' + esc(e.owner) + ' 维护' : ''}</span>` : '') + '<span class="sp"></span>'
      + (canFollow ? `<label title="跟随本页顶部的参数；关掉后显示它自己的参数"><input type="checkbox" data-s="follow"${x.follow ? ' checked' : ''}>参数跟随</label>` : '')
      + (canLink ? `<label title="${esc([(e.receive || []).length ? '接收：' + e.receive.join('、') : '', (e.emit || []).length ? '发出：' + e.emit.join('、') : ''].filter(Boolean).join('；'))}"><input type="checkbox" data-s="link"${x.link ? ' checked' : ''}>点击联动</label>` : '')
      + (e.page ? '<a data-open="1">打开原页面 ↗</a>' : '');
    bar.addEventListener('change', ev => {
      const s = ev.target.getAttribute('data-s');
      if (!s) return;
      x[s] = ev.target.checked;
      store(`amber-embed:${PAGE_ID}:${key}`, { follow: x.follow, link: x.link });
      push(x);
    });
    bar.addEventListener('click', ev => { if (ev.target.getAttribute('data-open')) ask({ type: 'openEmbed', key }); });
    if (opts.bar !== false) box.appendChild(bar);
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
      box.appendChild(d);
    }
    el.innerHTML = '';
    el.appendChild(box);
    embeds.set(key, x);
    return { key, info: e, frame: x.frame || null, element: box, get follow() { return x.follow; }, get link() { return x.link; }, refresh: () => push(x) };
  };

  // ---------- embedded side
  let lastParams = null, lastFilter = '{}', got = false, follow = false;
  function embeddedState(m) {
    if (m.type !== 'state') return;
    const p = JSON.stringify(m.params), f = JSON.stringify(m.filter || {});
    if (!got || p !== JSON.stringify(lastParams) || follow !== !!m.follow) { lastParams = m.params; follow = !!m.follow; paramFns.forEach(fn => { try { fn(m.params, { follow }); } catch (e) { console.error(e); } }); }
    if (!got || f !== lastFilter) { lastFilter = f; filter = m.filter || {}; filterFns.forEach(fn => { try { fn(Object.assign({}, filter)); } catch (e) { console.error(e); } }); }
    got = true;
  }
  Amber.embedded = EMBEDDED;
  Amber.onParams = fn => { paramFns.push(fn); if (got) fn(lastParams, { follow }); };
  Amber.emit = f => { if (!EMBEDDED) return false; window.parent.postMessage({ amberEmbed: 1, type: 'emit', filter: f || {} }, ME); return true; };
  if (EMBEDDED) {
    const hello = () => window.parent.postMessage({ amberEmbed: 1, type: 'hello' }, ME);
    hello();
    let lastH = 0;
    // The content's own height (the document's scrollHeight never drops below the frame it is in).
    const size = () => { const b = document.body; if (!b) return; const cs = getComputedStyle(b); const h = Math.ceil(b.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom)); if (Math.abs(h - lastH) > 2) { lastH = h; window.parent.postMessage({ amberEmbed: 1, type: 'height', h }, ME); } };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { hello(); size(); }); else size();
    if (window.ResizeObserver) { const watch = () => document.body && new ResizeObserver(size).observe(document.body); if (document.body) watch(); else document.addEventListener('DOMContentLoaded', watch); }
    window.addEventListener('load', size);
  }

  window.Amber = Amber;
})();
