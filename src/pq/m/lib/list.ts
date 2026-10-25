// List.* and Record.*
import { MList, MRecord, MTable, compare, equals } from '../values';
import { add, invoke } from '../eval';
import { type Lib, bool, call, cell, def, eqWith, err, fn, hashKey, items, keyWith, list, names, num, numN, rec, sorter, table, text } from './core';

const L = (a: unknown[]) => new MList(a);
const nonNull = (a: unknown[]) => a.filter((x) => x !== null);
/** Numbers of a list (nulls skipped); durations kept as such by callers. */
const nums = (a: unknown[]) => nonNull(a).map((x) => (typeof x === 'number' ? x : (x as any)?.ms ?? (x as any)?.days ?? num(x)));

/** Count / predicate argument used by FirstN, LastN, Skip, RemoveFirstN… */
function countOrWhile(a: any[], c: unknown, fromEnd = false): number {
  if (c === null) return 1;
  if (typeof c === 'number') return c;
  const f = fn(c);
  let n = 0;
  if (fromEnd) { for (let i = a.length - 1; i >= 0 && bool(invoke(f, [a[i]])); i--) n++; }
  else { for (const x of a) { if (!bool(invoke(f, [x]))) break; n++; } }
  return n;
}

export function register(lib: Lib) {
  const D = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'List.' + n, p, f);
  D('Count', ['list'], (l) => list(l).length);
  D('NonNullCount', ['list'], (l) => nonNull(items(l)).length);
  D('IsEmpty', ['list'], (l) => list(l).length === 0);
  D('First', ['list', 'defaultValue?'], (l, d) => (list(l).length ? cell(list(l).items[0]) : d));
  D('Last', ['list', 'defaultValue?'], (l, d) => (list(l).length ? cell(list(l).items[list(l).length - 1]) : d));
  D('FirstN', ['list', 'countOrCondition'], (l, c) => { const a = items(l); return L(a.slice(0, countOrWhile(a, c))); });
  D('LastN', ['list', 'countOrCondition?'], (l, c) => { const a = items(l); const n = countOrWhile(a, c, true); return L(n ? a.slice(-n) : []); });
  D('Skip', ['list', 'countOrCondition?'], (l, c) => { const a = items(l); return L(a.slice(countOrWhile(a, c))); });
  D('RemoveFirstN', ['list', 'countOrCondition?'], (l, c) => { const a = items(l); return L(a.slice(countOrWhile(a, c))); });
  D('RemoveLastN', ['list', 'countOrCondition?'], (l, c) => { const a = items(l); const n = countOrWhile(a, c, true); return L(n ? a.slice(0, -n) : a); });
  D('Range', ['list', 'offset', 'count?'], (l, o, c) => L(items(l).slice(num(o), c === null ? undefined : num(o) + num(c))));
  D('Single', ['list'], (l) => { const a = items(l); if (a.length !== 1) throw err('L\'elenco deve contenere un solo elemento.'); return a[0]; });
  D('SingleOrDefault', ['list', 'default?'], (l, d) => { const a = items(l); if (a.length > 1) throw err('L\'elenco contiene più di un elemento.'); return a.length ? a[0] : d; });
  D('Select', ['list', 'selection'], (l, f) => L(items(l).filter((x) => bool(call(f, x)))));
  D('Transform', ['list', 'transform'], (l, f) => L(items(l).map((x) => call(f, x))));
  D('TransformMany', ['list', 'collectionTransform', 'resultTransform'], (l, c, r) => L(items(l).flatMap((x) => items(call(c, x)).map((y) => call(r, x, y)))));
  D('Accumulate', ['list', 'seed', 'accumulator'], (l, s, f) => items(l).reduce((acc, x) => call(f, acc, x), s));
  D('Generate', ['initial', 'condition', 'next', 'selector?'], (i, c, n, s) => {
    const out: unknown[] = [];
    let v = call(i);
    for (let k = 0; bool(call(c, v)); k++) { if (k > 10_000_000) throw err('List.Generate: troppi elementi.'); out.push(s === null ? v : call(s, v)); v = call(n, v); }
    return L(out);
  });
  D('Numbers', ['start', 'count', 'increment?'], (s, c, i) => L(Array.from({ length: num(c) }, (_, k) => num(s) + k * (i === null ? 1 : num(i)))));
  D('Repeat', ['list', 'count'], (l, n) => { const a = items(l); return L(Array.from({ length: num(n) }, () => a).flat()); });
  D('Reverse', ['list'], (l) => L(items(l).reverse()));
  D('Sort', ['list', 'comparisonCriteria?'], (l, c) => L([...items(l)].sort(sorter(c))));
  D('Distinct', ['list', 'equationCriteria?'], (l, c) => {
    if (c === null || c === lib.get('Comparer.OrdinalIgnoreCase')) { const k = keyWith(c), seen = new Set<string>(); return L(items(l).filter((x) => { const h = k(x); if (seen.has(h)) return false; seen.add(h); return true; })); }
    const eq = eqWith(c), out: unknown[] = [];
    for (const x of items(l)) if (!out.some((y) => eq(x, y))) out.push(x);
    return L(out);
  });
  D('IsDistinct', ['list', 'equationCriteria?'], (l, c) => { const k = keyWith(c); const a = items(l); return new Set(a.map(k)).size === a.length; });
  D('Contains', ['list', 'value', 'equationCriteria?'], (l, v, c) => { const eq = eqWith(c); return items(l).some((x) => eq(x, v)); });
  D('ContainsAll', ['list', 'values', 'equationCriteria?'], (l, vs, c) => { const eq = eqWith(c); const a = items(l); return items(vs).every((v) => a.some((x) => eq(x, v))); });
  D('ContainsAny', ['list', 'values', 'equationCriteria?'], (l, vs, c) => { const eq = eqWith(c); const a = items(l); return items(vs).some((v) => a.some((x) => eq(x, v))); });
  D('PositionOf', ['list', 'value', 'occurrence?', 'equationCriteria?'], (l, v, o, c) => {
    const eq = eqWith(c); const a = items(l); const hits = a.map((x, i) => (eq(x, v) ? i : -1)).filter((i) => i >= 0);
    return o === 2 ? L(hits) : o === 1 ? hits[hits.length - 1] ?? -1 : hits[0] ?? -1;
  });
  D('PositionOfAny', ['list', 'values', 'occurrence?', 'equationCriteria?'], (l, vs, o, c) => {
    const eq = eqWith(c); const set = items(vs); const a = items(l); const hits = a.map((x, i) => (set.some((v) => eq(x, v)) ? i : -1)).filter((i) => i >= 0);
    return o === 2 ? L(hits) : o === 1 ? hits[hits.length - 1] ?? -1 : hits[0] ?? -1;
  });
  D('Positions', ['list'], (l) => L(items(l).map((_, i) => i)));
  D('Combine', ['lists'], (ls) => L(items(ls).flatMap((x) => items(x))));
  D('Zip', ['lists'], (ls) => { const a = items(ls).map(items); const n = Math.max(0, ...a.map((x) => x.length)); return L(Array.from({ length: n }, (_, i) => L(a.map((x) => (i < x.length ? x[i] : null))))); });
  D('Union', ['lists', 'equationCriteria?'], (ls, c) => { const k = keyWith(c); const out: unknown[] = []; const counts = new Map<string, number>(); for (const l of items(ls)) { const local = new Map<string, number>(); for (const x of items(l)) { const h = k(x); local.set(h, (local.get(h) ?? 0) + 1); if ((local.get(h) ?? 0) > (counts.get(h) ?? 0)) { out.push(x); counts.set(h, local.get(h)!); } } } return L(out); });
  D('Intersect', ['lists', 'equationCriteria?'], (ls, c) => { const k = keyWith(c); const [first, ...rest] = items(ls).map(items); if (!first) return L([]); const pools = rest.map((r) => { const m = new Map<string, number>(); r.forEach((x) => m.set(k(x), (m.get(k(x)) ?? 0) + 1)); return m; }); return L(first.filter((x) => pools.every((p) => { const n = p.get(k(x)) ?? 0; if (!n) return false; p.set(k(x), n - 1); return true; }))); });
  D('Difference', ['list1', 'list2', 'equationCriteria?'], (a, b, c) => { const k = keyWith(c); const m = new Map<string, number>(); items(b).forEach((x) => m.set(k(x), (m.get(k(x)) ?? 0) + 1)); return L(items(a).filter((x) => { const n = m.get(k(x)) ?? 0; if (n) { m.set(k(x), n - 1); return false; } return true; })); });
  D('RemoveItems', ['list1', 'list2'], (a, b) => { const set = new Set(items(b).map((x) => hashKey(x))); return L(items(a).filter((x) => !set.has(hashKey(x)))); });
  D('RemoveMatchingItems', ['list1', 'list2', 'equationCriteria?'], (a, b, c) => { const eq = eqWith(c); const r = items(b); return L(items(a).filter((x) => !r.some((y) => eq(x, y)))); });
  D('RemoveNulls', ['list'], (l) => L(nonNull(items(l))));
  D('RemoveRange', ['list', 'index', 'count?'], (l, i, n) => { const a = items(l); a.splice(num(i), n === null ? 1 : num(n)); return L(a); });
  D('InsertRange', ['list', 'index', 'values'], (l, i, v) => { const a = items(l); a.splice(num(i), 0, ...items(v)); return L(a); });
  D('ReplaceRange', ['list', 'index', 'count', 'replaceWith'], (l, i, n, v) => { const a = items(l); a.splice(num(i), num(n), ...items(v)); return L(a); });
  D('ReplaceValue', ['list', 'oldValue', 'newValue', 'replacer'], (l, o, n, r) => L(items(l).map((x) => call(r, x, o, n))));
  D('ReplaceMatchingItems', ['list', 'replacements', 'equationCriteria?'], (l, reps, c) => { const eq = eqWith(c); const rs = items(reps).map(items); return L(items(l).map((x) => { const hit = rs.find((p) => eq(x, p[0])); return hit ? hit[1] : x; })); });
  D('Alternate', ['list', 'count', 'repeatInterval?', 'offset?'], (l, c, r, o) => { const a = items(l); const cnt = num(c), rep = r === null ? 1 : num(r), off = o === null ? 0 : num(o); return L(a.filter((_, i) => { if (i < off) return true; const k = (i - off) % (cnt + rep); return k >= cnt; })); });
  D('Split', ['list', 'pageSize'], (l, n) => { const a = items(l), out: unknown[] = []; for (let i = 0; i < a.length; i += num(n)) out.push(L(a.slice(i, i + num(n)))); return L(out); });
  D('Buffer', ['list'], (l) => L(items(l)));
  D('AllTrue', ['list'], (l) => items(l).every((x) => bool(x)));
  D('AnyTrue', ['list'], (l) => items(l).some((x) => bool(x)));
  D('MatchesAll', ['list', 'condition'], (l, f) => items(l).every((x) => bool(call(f, x))));
  D('MatchesAny', ['list', 'condition'], (l, f) => items(l).some((x) => bool(call(f, x))));
  D('FindText', ['list', 'text'], (l, t) => L(items(l).filter((x) => findText(x, text(t)))));
  /* aggregates */
  const extreme = (dir: 1 | -1) => (l: unknown, d: unknown, c: unknown) => {
    const a = nonNull(items(l)); if (!a.length) return d;
    const cmp = c === null ? compare : sorter(c);
    return a.reduce((m, x) => (cmp(x, m) * dir > 0 ? x : m));
  };
  D('Max', ['list', 'default?', 'comparisonCriteria?', 'includeNulls?'], extreme(1));
  D('Min', ['list', 'default?', 'comparisonCriteria?', 'includeNulls?'], extreme(-1));
  D('MaxN', ['list', 'countOrCondition', 'comparisonCriteria?'], (l, n, c) => { const a = [...nonNull(items(l))].sort((x, y) => (c === null ? compare(y, x) : sorter(c)(y, x))); return L(a.slice(0, countOrWhile(a, n))); });
  D('MinN', ['list', 'countOrCondition', 'comparisonCriteria?'], (l, n, c) => { const a = [...nonNull(items(l))].sort(c === null ? compare : sorter(c)); return L(a.slice(0, countOrWhile(a, n))); });
  D('Sum', ['list', 'precision?'], (l) => { const a = nonNull(items(l)); if (!a.length) return null; return a.reduce((s, x) => add(s, x)); });
  D('Product', ['list', 'precision?'], (l) => { const a = nonNull(items(l)).map(num); return a.length ? a.reduce((s, x) => s * x, 1) : null; });
  D('Average', ['list', 'precision?'], (l) => { const a = nums(items(l)); return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; });
  D('Median', ['list', 'precision?'], (l) => { const a = [...nonNull(items(l))].sort(compare); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (typeof a[m] === 'number' ? (num(a[m - 1]) + num(a[m])) / 2 : a[m - 1]); });
  D('Mode', ['list', 'equationCriteria?'], (l) => { const m = new Map<string, [unknown, number]>(); for (const x of items(l)) { const k = hashKey(x); const e = m.get(k); m.set(k, [x, (e?.[1] ?? 0) + 1]); } let best: [unknown, number] | null = null; for (const e of m.values()) if (!best || e[1] > best[1]) best = e; if (!best) throw err('L\'elenco è vuoto.'); return best[0]; });
  D('Modes', ['list', 'equationCriteria?'], (l) => { const m = new Map<string, [unknown, number]>(); for (const x of items(l)) { const k = hashKey(x); m.set(k, [x, (m.get(k)?.[1] ?? 0) + 1]); } const max = Math.max(...[...m.values()].map((e) => e[1])); return L([...m.values()].filter((e) => e[1] === max).map((e) => e[0])); });
  D('StandardDeviation', ['list'], (l) => { const a = nums(items(l)); if (a.length < 2) return null; const mu = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1)); });
  D('Covariance', ['numberList1', 'numberList2'], (x, y) => { const a = nums(items(x)), b = nums(items(y)); const n = Math.min(a.length, b.length); const ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n; let c = 0; for (let i = 0; i < n; i++) c += (a[i] - ma) * (b[i] - mb); return c / n; });
  D('Percentile', ['list', 'percentiles', 'options?'], (l, p) => {
    const a = nums(items(l)).sort((x, y) => x - y);
    const one = (q: number) => { if (!a.length) return null; const pos = q * (a.length - 1), lo = Math.floor(pos); return a[lo] + (a[Math.min(lo + 1, a.length - 1)] - a[lo]) * (pos - lo); };
    return typeof p === 'number' ? one(p) : L(items(p).map((q) => one(num(q))));
  });
  D('Random', ['count', 'seed?'], (n) => L(Array.from({ length: num(n) }, () => Math.random())));
  D('ConformToPageReader', ['list', 'options?'], (l) => l);

  /* ---- Record ---- */
  const R = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Record.' + n, p, f);
  // MissingField.Error = 0, Ignore = 1, UseNull = 2
  const missing = (r: MRecord, n: string, mode: unknown) => { if (r.has(n)) return true; if (mode === 1 || mode === 2) return false; throw err(`Il campo '${n}' del record non è stato trovato.`); };
  R('Field', ['record', 'field'], (r, f) => rec(r).get(text(f)));
  R('FieldOrDefault', ['record', 'field', 'defaultValue?'], (r, f, d) => (r !== null && rec(r).has(text(f)) ? rec(r).get(text(f)) : d));
  R('FieldNames', ['record'], (r) => L([...rec(r).names]));
  R('FieldValues', ['record'], (r) => L(rec(r).values()));
  R('FieldCount', ['record'], (r) => rec(r).names.length);
  R('HasFields', ['record', 'fields'], (r, f) => names(f).every((n) => rec(r).has(n)));
  R('AddField', ['record', 'fieldName', 'value', 'delayed?'], (r, n, v, delayed) => { if (rec(r).has(text(n))) throw err(`Il campo '${text(n)}' esiste già nel record.`); return new MRecord([...rec(r).names, text(n)], [...rec(r).vals, delayed === true ? call(v) : v]); });
  R('RemoveFields', ['record', 'fields', 'missingField?'], (r, f, m) => { const drop = names(f).filter((n) => missing(rec(r), n, m)); const keep = rec(r).names.map((n, i) => [n, i] as const).filter(([n]) => !drop.includes(n)); return new MRecord(keep.map((k) => k[0]), keep.map((k) => rec(r).vals[k[1]])); });
  R('SelectFields', ['record', 'fields', 'missingField?'], (r, f, m) => { const ns = names(f).filter((n) => missing(rec(r), n, m) || m === 2); return new MRecord(ns, ns.map((n) => (rec(r).has(n) ? rec(r).vals[rec(r).names.indexOf(n)] : null))); });
  R('RenameFields', ['record', 'renames', 'missingField?'], (r, rn, m) => { const pairs = renamePairs(rn); const out = [...rec(r).names]; for (const [a, b] of pairs) { const i = out.indexOf(a); if (i < 0) { missing(rec(r), a, m); continue; } out[i] = b; } return new MRecord(out, [...rec(r).vals]); });
  R('ReorderFields', ['record', 'fieldOrder', 'missingField?'], (r, f) => { const order = names(f); const rest = rec(r).names.filter((n) => !order.includes(n)); const ns = [...order.filter((n) => rec(r).has(n)), ...rest]; return new MRecord(ns, ns.map((n) => rec(r).vals[rec(r).names.indexOf(n)])); });
  R('TransformFields', ['record', 'transformOperations', 'missingField?'], (r, ops, m) => { const ts = transformPairs(ops); const vals = [...rec(r).vals]; for (const [n, f] of ts) { const i = rec(r).names.indexOf(n); if (i < 0) { missing(rec(r), n, m); continue; } vals[i] = call(f, cell(vals[i])); } return new MRecord([...rec(r).names], vals); });
  R('Combine', ['records'], (rs) => items(rs).reduce((acc: MRecord, x) => { const names2 = [...acc.names], vals = [...acc.vals]; rec(x).names.forEach((n, i) => { const j = names2.indexOf(n); if (j >= 0) vals[j] = rec(x).vals[i]; else { names2.push(n); vals.push(rec(x).vals[i]); } }); return new MRecord(names2, vals); }, new MRecord([], [])));
  R('FromList', ['list', 'fields'], (l, f) => { const vs = items(l); const ns = f instanceof MList ? names(f) : (f as any).fields?.map((x: any) => x.name) ?? []; if (ns.length !== vs.length) throw err('Il numero di campi non corrisponde al numero di valori.'); return new MRecord(ns, vs); });
  R('FromTable', ['table'], (t) => { const tb = table(t); const ni = tb.col('Name'), vi = tb.col('Value'); return new MRecord(tb.rows.map((r) => text(cell(r[ni]))), tb.rows.map((r) => r[vi])); });
  R('ToList', ['record'], (r) => L(rec(r).values()));
  R('ToTable', ['record'], (r) => new MTable(['Name', 'Value'], rec(r).names.map((n, i) => [n, rec(r).vals[i]])));
  void numN; void equals;
}

/** {"a","b"} or {{"a","b"},{"c","d"}} → pairs. */
export function renamePairs(v: unknown): [string, string][] {
  const a = items(v);
  if (a.length && !(a[0] instanceof MList)) return [[text(a[0]), text(a[1])]];
  return a.map((p) => { const x = items(p); return [text(x[0]), text(x[1])]; });
}
/** {"col", fn} or {{"col", fn, type?}, …} → [name, fn, type?]. */
export function transformPairs(v: unknown): [string, unknown, unknown?][] {
  const a = items(v);
  if (a.length && !(a[0] instanceof MList)) return [[text(a[0]), a[1], a[2]]];
  return a.map((p) => { const x = items(p); return [text(x[0]), x[1], x[2]]; });
}
/** Text search inside a value (List.FindText, Table.FindText): texts, records and lists recursively. */
export function findText(v: unknown, t: string): boolean {
  if (typeof v === 'string') return v.includes(t);
  if (v instanceof MRecord) return v.values().some((x) => findText(x, t));
  if (v instanceof MList) return v.values().some((x) => findText(x, t));
  return false;
}
