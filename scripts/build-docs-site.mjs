// Renders docs/*.md into a static site for GitHub Pages, using the same docs page as the Amber website
// (web/docs.html, rendered in the browser). Published at https://xu4wang.github.io/amber-manual/docs/
// by .github/workflows/docs-site.yml.
// usage: node scripts/build-docs-site.mjs <out-dir>   writes <out>/docs/*.html (index.html: the landing page), <out>/vendor/*, <out>/logo.svg
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(import.meta.dirname, '..');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/build-docs-site.mjs <out-dir>'); process.exit(2); }
mkdirSync(join(OUT, 'docs'), { recursive: true });
mkdirSync(join(OUT, 'vendor'), { recursive: true });

// The same list and titles the website uses (src/web.ts).
const web = readFileSync(join(ROOT, 'src/web.ts'), 'utf8');
const DOCS = JSON.parse(/const DOCS: \[string, string, string\]\[\] = (\[.*?\]);/.exec(web)[1].replace(/'/g, '"'));

// The website serves the docs under /docs/<name> next to the app; here they are plain files.
let tpl = readFileSync(join(ROOT, 'web/docs.html'), 'utf8');
const swap = (from, to) => { if (!tpl.includes(from)) throw new Error('web/docs.html changed, update scripts/build-docs-site.mjs: ' + from); tpl = tpl.split(from).join(to); };
swap('src="/vendor/', 'src="../vendor/');
swap('href="/logo.svg"', 'href="../logo.svg"');
swap('src="/logo.svg"', 'src="../logo.svg"');
swap('<a class="brand" href="/">', '<a class="brand" href="../">');
swap('<a class="back" href="/">← 返回网站</a>', '<a class="back" href="../">▶ 视频手册</a>');
swap("a.setAttribute('href', '/docs/' + m[1] + (m[2] || ''))", "a.setAttribute('href', m[1] + '.html' + (m[2] || ''))");
swap('<a href="/docs/${esc(n.name)}"', '<a href="${esc(n.name)}.html"');

for (const [name, title] of DOCS) {
  const md = readFileSync(join(ROOT, 'docs', `${name}.md`), 'utf8');
  const nav = DOCS.map(([n, t, g]) => ({ name: n, title: t, group: g, current: n === name }));
  // JSON inside <script>: escape "<" so the document can never close the script tag.
  const data = JSON.stringify({ md, nav }).replace(/</g, '\\u003c');
  writeFileSync(join(OUT, 'docs', name + '.html'), tpl.replace('__TITLE__', `${title} · Amber`).replace('__DOC_DATA__', data));
}
// The front page: the same landing page the website shows when not logged in (web/landing.html), its docs blocks,
// under the docs page's own header (theme button, GitHub link) and styles.
const [first] = DOCS[0];
const landing = readFileSync(join(ROOT, 'web/landing.html'), 'utf8').replace(/^<!--[\s\S]*?-->\n/, '')
  .replace(/<!--web-->[\s\S]*?<!--\/web-->\n?/g, '').replace(/<!--\/?docs-->\n?/g, '')
  .split('__DOCS__').join(`${first}.html`).split('__ASSETS__').join('assets');
const pick = re => { const m = re.exec(tpl); if (!m) throw new Error('web/docs.html changed, update scripts/build-docs-site.mjs: ' + re); return m[0]; };
const head = tpl.slice(0, tpl.indexOf('<body>')).replace('__TITLE__', 'Amber · AI 跑通的，Amber 封存。');
const themeBtn = pick(/<button class="themebtn"[\s\S]*?<\/button>/);
const ghLink = pick(/<a class="gh"[\s\S]*?<\/a>/);
const themeJs = pick(/document\.getElementById\('themebtn'\)\.addEventListener[\s\S]*?\n\}\);/);
writeFileSync(join(OUT, 'docs', 'index.html'), `${head}<body>
<header>
  <img src="../logo.svg" alt="">
  <a class="brand" href="./">Amber</a>
  <a class="back" href="${first}.html">阅读文档</a>
  ${themeBtn}
  ${ghLink}
</header>
${landing}<script>
${themeJs}
</script>
</body>
</html>
`);
for (const f of ['marked.min.js', 'purify.min.js', 'highlight.min.js']) copyFileSync(join(ROOT, 'web/vendor', f), join(OUT, 'vendor', f));
copyFileSync(join(ROOT, 'web/logo.svg'), join(OUT, 'logo.svg'));
mkdirSync(join(OUT, 'docs', 'assets'), { recursive: true });
for (const f of readdirSync(join(ROOT, 'docs/assets'))) if (f.endsWith('.svg') || f === 'amber-why.gif') copyFileSync(join(ROOT, 'docs/assets', f), join(OUT, 'docs', 'assets', f));
console.log(`docs site: ${DOCS.length} pages -> ${OUT}`);
