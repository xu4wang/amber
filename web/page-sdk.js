// Amber page SDK: load it in a page app with <script src="/sdk/amber-page.js"></script>.
//   const r = await Amber.run('应用名', { 参数: '值' });   // runs the app as the person looking at the page
//   r.markdown  the app's output; r.blocks  [{kind:'markdown',text} | {kind:'table',data} | {kind:'chart',data} | {kind:'json',data}]
//   r.json      the first ```json block's data, when the app prints one
//   Amber.render(element, r)   shows the result the way Amber's cards do (text, tables, charts)
//   Amber.open(url)            opens a link on the network allow list (Feishu by default) in a new tab
//   Amber.me()                 { name, page }
// Calls go through Amber (the window around the page); the page itself cannot reach the network.
(function () {
  const AMBER = __AMBER_ORIGIN__;
  let seq = 0;
  const waiting = new Map();
  window.addEventListener('message', ev => {
    if (ev.source !== window.parent || ev.origin !== AMBER) return;
    const m = ev.data || {};
    if (m.amber !== 1 || !waiting.has(m.id)) return;
    const { ok, fail } = waiting.get(m.id);
    waiting.delete(m.id);
    if (m.ok) ok(m.result); else fail(Object.assign(new Error(m.message || '执行失败'), { code: m.error }));
  });
  const ask = msg => new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    window.parent.postMessage(Object.assign({ amber: 1, id }, msg), AMBER);
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
  window.Amber = Amber;
})();
