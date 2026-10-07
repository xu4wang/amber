// Line diff between two versions of a command's code, for claim cards and review docs (D38).
// Plain LCS; scripts are at most 64KB, and very large diffs fall back to "too large".

export interface DiffStat { added: number; removed: number }

/** Unified-style diff with `context` unchanged lines around each change. Returns null when too large. */
export function lineDiff(a: string, b: string, context = 3): { text: string; stat: DiffStat } | null {
  const x = a.replace(/\n$/, '').split('\n');
  const y = b.replace(/\n$/, '').split('\n');
  const n = x.length, m = y.length;
  if (n * m > 4_000_000) return null;
  // lcs[i][j] = LCS length of x[i..] and y[j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const ops: { op: ' ' | '-' | '+'; line: string; a: number; b: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) { ops.push({ op: ' ', line: x[i], a: i + 1, b: j + 1 }); i++; j++; }
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) { ops.push({ op: '-', line: x[i], a: i + 1, b: j }); i++; }
    else { ops.push({ op: '+', line: y[j], a: i, b: j + 1 }); j++; }
  }
  const stat = { added: ops.filter(o => o.op === '+').length, removed: ops.filter(o => o.op === '-').length };
  if (!stat.added && !stat.removed) return { text: '', stat };
  // Keep changed lines plus `context` lines around them; mark skipped stretches.
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o.op !== ' ') for (let d = -context; d <= context; d++) if (ops[k + d]) keep[k + d] = true; });
  const out: string[] = [];
  let skipping = false;
  ops.forEach((o, k) => {
    if (!keep[k]) { if (!skipping) out.push(`@@ …… @@`); skipping = true; return; }
    if (skipping || k === 0) out.push(`@@ 第 ${o.op === '+' ? o.b : o.a} 行 @@`);
    skipping = false;
    out.push(`${o.op} ${o.line}`);
  });
  return { text: out.filter((l, k, arr) => !(l === '@@ …… @@' && arr[k + 1]?.startsWith('@@'))).join('\n'), stat };
}
