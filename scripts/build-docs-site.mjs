// Renders docs/*.md into a static site for GitHub Pages, using the same docs page as the Amber website
// (web/docs.html, rendered in the browser). Published at https://xu4wang.github.io/amber-manual/docs/
// by .github/workflows/docs-site.yml.
// usage: node scripts/build-docs-site.mjs <out-dir>   writes <out>/docs/*.html, <out>/vendor/*, <out>/logo.svg
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(import.meta.dirname, '..');
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node scripts/build-docs-site.mjs <out-dir>'); process.exit(2); }
mkdirSync(join(OUT, 'docs'), { recursive: true });
mkdirSync(join(OUT, 'vendor'), { recursive: true });

// The same list and titles the website uses (src/web.ts).
const web = readFileSync(join(ROOT, 'src/web.ts'), 'utf8');
const DOCS = JSON.parse(/const DOCS: \[string, string\]\[\] = (\[.*?\]);/.exec(web)[1].replace(/'/g, '"'));

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
  const nav = DOCS.map(([n, t]) => ({ name: n, title: t, current: n === name }));
  // JSON inside <script>: escape "<" so the document can never close the script tag.
  const data = JSON.stringify({ md, nav }).replace(/</g, '\\u003c');
  writeFileSync(join(OUT, 'docs', name + '.html'), tpl.replace('__TITLE__', `${title} · Amber`).replace('__DOC_DATA__', data));
}
const [first, firstTitle] = DOCS[0];
writeFileSync(join(OUT, 'docs', 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${first}.html"><title>Amber 文档</title><a href="${first}.html">${firstTitle}</a>\n`);
for (const f of ['marked.min.js', 'purify.min.js', 'highlight.min.js']) copyFileSync(join(ROOT, 'web/vendor', f), join(OUT, 'vendor', f));
copyFileSync(join(ROOT, 'web/logo.svg'), join(OUT, 'logo.svg'));
console.log(`docs site: ${DOCS.length} pages -> ${OUT}`);
