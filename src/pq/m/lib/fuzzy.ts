// Fuzzy matching (Unisci query › Usa corrispondenza fuzzy, Raggruppa fuzzy, Cluster valori): Jaccard similarity of
// character bigrams of the normalized texts, like Power Query's options Threshold (0.80), IgnoreCase, IgnoreSpace,
// NumberOfMatches, TransformationTable (From/To pairs applied before comparing).
import { MList, MRecord, MTable, TYPE } from '../values';
import { invoke } from '../eval';
import { type Lib, cell, def, items, names, num, opt, table, text } from './core';
import { expandTable } from './table';

interface Opts { threshold: number; ignoreCase: boolean; ignoreSpace: boolean; matches: number; map: Map<string, string> }
function options(o: unknown): Opts {
  const map = new Map<string, string>();
  const tt = opt(o, 'TransformationTable', null);
  if (tt instanceof MTable) { const f = tt.col('From'), t = tt.col('To'); for (const r of tt.rows) map.set(String(cell(r[f])).toLowerCase(), String(cell(r[t]))); }
  const n = opt(o, 'NumberOfMatches', null);
  return { threshold: opt(o, 'Threshold', 0.8) ?? 0.8, ignoreCase: opt(o, 'IgnoreCase', true) !== false, ignoreSpace: opt(o, 'IgnoreSpace', true) !== false, matches: n === null ? Infinity : num(n), map };
}
function norm(v: unknown, o: Opts): string {
  if (v === null) return '';
  let s = String(v);
  const mapped = o.map.get(s.toLowerCase());
  if (mapped !== undefined) s = mapped;
  if (o.ignoreCase) s = s.toLowerCase();
  if (o.ignoreSpace) s = s.replace(/\s+/g, ''); else s = s.replace(/\s+/g, ' ').trim();
  return s;
}
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  if (s.length < 2) { if (s) out.add(s); return out; }
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}
export function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Best matches of each left row among the right rows (indices with score ≥ threshold, best first). */
function matchRows(left: MTable, k1: string[], right: MTable, k2: string[], o: Opts): number[][] {
  const il = k1.map((c) => left.col(c)), ir = k2.map((c) => right.col(c));
  const rgrams = right.rows.map((r) => ir.map((i) => bigrams(norm(cell(r[i]), o))));
  const index = new Map<string, Set<number>>();
  rgrams.forEach((gs, j) => gs[0]?.forEach((g) => { let s = index.get(g); if (!s) index.set(g, (s = new Set())); s.add(j); }));
  return left.rows.map((r) => {
    const lg = il.map((i) => bigrams(norm(cell(r[i]), o)));
    const cands = new Set<number>();
    lg[0]?.forEach((g) => index.get(g)?.forEach((j) => cands.add(j)));
    const scored: [number, number][] = [];
    for (const j of cands) {
      const s = lg.reduce((acc, g, k) => acc + similarity(g, rgrams[j][k]), 0) / lg.length;
      if (s >= o.threshold) scored.push([j, s]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, o.matches).map((x) => x[0]);
  });
}

function fuzzyNested(a: MTable, k1: string[], b: MTable, k2: string[], name: string, kind: number, o: Opts): MTable {
  const m = matchRows(a, k1, b, k2, o);
  const used = new Set<number>();
  const rows: unknown[][] = [];
  a.rows.forEach((r, i) => {
    const hits = m[i];
    hits.forEach((j) => used.add(j));
    if (kind === 0 && !hits.length) return;
    if (kind === 4 && hits.length) return;
    rows.push([...r, new MTable(b.columns, kind === 4 ? [] : hits.map((j) => b.rows[j]), b.types)]);
  });
  if (kind === 2 || kind === 3) b.rows.forEach((r, j) => { if (!used.has(j)) rows.push([...a.columns.map(() => null), new MTable(b.columns, [r], b.types)]); });
  return new MTable([...a.columns, name], rows, [...(a.types ?? a.columns.map(() => undefined)), TYPE.table]);
}

/** Representative value per cluster: the most frequent original value of the cluster. */
function clusters(values: unknown[], o: Opts): Map<number, unknown> {
  const reps: { grams: Set<string>; value: unknown; count: Map<unknown, number> }[] = [];
  const assign = new Map<number, number>();
  values.forEach((v, i) => {
    const g = bigrams(norm(v, o));
    let best = -1, bestS = -1;
    reps.forEach((c, k) => { const s = similarity(g, c.grams); if (s >= o.threshold && s > bestS) { best = k; bestS = s; } });
    if (best < 0) { reps.push({ grams: g, value: v, count: new Map() }); best = reps.length - 1; }
    reps[best].count.set(v, (reps[best].count.get(v) ?? 0) + 1);
    assign.set(i, best);
  });
  const value = reps.map((c) => [...c.count.entries()].sort((x, y) => y[1] - x[1])[0][0]);
  return new Map([...assign.entries()].map(([i, k]) => [i, value[k]]));
}

export function register(lib: Lib) {
  def(lib, 'Table.FuzzyNestedJoin', ['table1', 'key1', 'table2', 'key2', 'newColumnName', 'joinKind?', 'joinOptions?'], (a, k1, b, k2, n, kind, o) =>
    fuzzyNested(table(a), names(k1), table(b), names(k2), text(n), kind === null ? 1 : num(kind), options(o)));
  def(lib, 'Table.FuzzyJoin', ['table1', 'key1', 'table2', 'key2', 'joinKind?', 'joinOptions?'], (a, k1, b, k2, kind, o) => {
    const nested = fuzzyNested(table(a), names(k1), table(b), names(k2), '\u0000j', kind === null ? 1 : num(kind), options(o));
    return expandTable(nested, '\u0000j', table(b).columns, table(b).columns);
  });
  def(lib, 'Table.AddFuzzyClusterColumn', ['table', 'columnName', 'newColumnName', 'options?'], (t, c, n, o) => {
    const tb = table(t), i = tb.col(text(c));
    const rep = clusters(tb.rows.map((r) => cell(r[i])), options(o));
    return new MTable([...tb.columns, text(n)], tb.rows.map((r, k) => [...r, rep.get(k) ?? null]));
  });
  def(lib, 'Table.FuzzyGroup', ['table', 'key', 'aggregatedColumns', 'groupOptions?'], (t, k, aggs, o) => {
    const tb = table(t), key = names(k)[0], i = tb.col(key);
    const rep = clusters(tb.rows.map((r) => cell(r[i])), options(o));
    const groups = new Map<string, { value: unknown; rows: unknown[][] }>();
    tb.rows.forEach((r, n) => { const v = rep.get(n); const h = String(v); let g = groups.get(h); if (!g) groups.set(h, (g = { value: v, rows: [] })); g.rows.push(r); });
    const defs = (() => { const a = items(aggs); return a.length && !(a[0] instanceof MList) ? [a] : a.map(items); })();
    return new MTable([key, ...defs.map((d) => text(d[0]))], [...groups.values()].map((g) => [g.value, ...defs.map((d) => invoke(d[1], [new MTable(tb.columns, g.rows, tb.types)]))]));
  });
  void MRecord;
}
