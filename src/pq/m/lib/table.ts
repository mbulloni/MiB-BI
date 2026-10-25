// Table.* and #table. Cells may be lazy or ErrorCell: errors stay in their cell (Table.AddColumn,
// TransformColumns, TransformColumnTypes) like Power Query, and raise only when the cell is read.
import { ErrorCell, MError, MFunction, MList, MRecord, MTable, MType, TYPE, compare, equals, force, typeOfValue } from '../values';
import { appendTables, invoke } from '../eval';
import { type Lib, bool, call, cell, culture, def, eqWith, err, fn, hashKey, items, keyWith, list, names, num, opt, rec, sorter, table, text, typ } from './core';
import { findText, renamePairs, transformPairs } from './list';
import { convertTo } from './convert';

const L = (a: unknown[]) => new MList(a);
/** Runs f, keeping an M error in the cell instead of failing the whole table. */
const safe = (f: () => unknown): unknown => { try { return f(); } catch (e) { if (e instanceof MError) return new ErrorCell(e); throw e; } };
const rowRec = (t: MTable, r: unknown[]) => new MRecord(t.columns, r);
const withTypes = (t: MTable, cols: string[], rows: unknown[][], types?: (MType | undefined)[]) => new MTable(cols, rows, types);
/** MissingField.Error = 0, Ignore = 1, UseNull = 2 */
const has = (t: MTable, c: string, mode: unknown) => { if (t.columns.includes(c)) return true; if (mode === 1 || mode === 2) return false; t.col(c); return false; };

/** Count or predicate on rows (FirstN, Skip…). */
function countRows(t: MTable, c: unknown, fromEnd = false): number {
  if (c === null) return 1;
  if (typeof c === 'number') return c;
  const f = fn(c);
  let n = 0;
  const rows = fromEnd ? [...t.rows].reverse() : t.rows;
  for (const r of rows) { if (!bool(invoke(f, [rowRec(t, r)]))) break; n++; }
  return n;
}

/** Sort criteria for tables: "Col", {"Col", Order}, {{"A", 0}, {"B", 1}}, each/compare function. */
function rowSorter(t: MTable, criteria: unknown): (a: unknown[], b: unknown[]) => number {
  const one = (c: unknown): ((a: unknown[], b: unknown[]) => number) => {
    if (typeof c === 'string') { const i = t.col(c); return (a, b) => compare(cell(a[i]), cell(b[i])); }
    if (c instanceof MList) {
      const [k, o] = c.values();
      if (typeof k === 'string' && (typeof o === 'number' || o === null)) { const base = one(k); return o === 1 ? (a, b) => base(b, a) : base; }
      if (k instanceof MFunction && typeof o === 'number') { const base = one(k); return o === 1 ? (a, b) => base(b, a) : base; }
      const fs = c.values().map(one);
      return (a, b) => { for (const f of fs) { const r = f(a, b); if (r) return r; } return 0; };
    }
    if (c instanceof MFunction) {
      if (c.arity === 2) return (a, b) => num(invoke(c, [rowRec(t, a), rowRec(t, b)]));
      return (a, b) => compare(invoke(c, [rowRec(t, a)]), invoke(c, [rowRec(t, b)]));
    }
    return () => 0;
  };
  return one(criteria);
}

/** Rows of a list of records → table (columns = union of field names in order). */
export function fromRecords(recs: MRecord[], columns: string[] | null = null): MTable {
  const cols = columns ?? recs.reduce((acc: string[], r) => { for (const n of r.names) if (!acc.includes(n)) acc.push(n); return acc; }, []);
  return new MTable(cols, recs.map((r) => cols.map((c) => (r.has(c) ? r.vals[r.names.indexOf(c)] : null))));
}

/** Columns argument (list of names, a number, or a table type) for FromRows/FromList/SplitColumn. */
function columnNames(v: unknown, n: number): { cols: string[]; types?: (MType | undefined)[] } {
  if (v === null) return { cols: Array.from({ length: n }, (_, i) => `Column${i + 1}`) };
  if (typeof v === 'number') return { cols: Array.from({ length: v }, (_, i) => `Column${i + 1}`) };
  if (v instanceof MType && v.columns) return { cols: v.columns.map((c) => c.name), types: v.columns.map((c) => c.type) };
  return { cols: names(v) };
}

export function register(lib: Lib) {
  const D = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Table.' + n, p, f);

  def(lib, '#table', ['columns', 'rows'], (c, r) => {
    const rows = items(r).map((x) => list(x).items);
    const { cols, types } = columnNames(c, rows[0]?.length ?? 0);
    rows.forEach((x) => { if (x.length !== cols.length) throw err('Il numero di valori di una riga non corrisponde al numero di colonne.'); });
    return new MTable(cols, rows, types);
  });

  /* ---- construction / conversion ---- */
  D('FromRows', ['rows', 'columns?'], (r, c) => { const rows = items(r).map((x) => list(x).items); const { cols, types } = columnNames(c, Math.max(0, ...rows.map((x) => x.length))); return new MTable(cols, rows.map((x) => cols.map((_, i) => (i < x.length ? x[i] : null))), types); });
  D('FromRecords', ['records', 'columns?', 'missingField?'], (r, c) => { const { cols, types } = c === null ? { cols: null as string[] | null, types: undefined } : columnNames(c, 0); const t = fromRecords(items(r).map(rec), cols); return types ? new MTable(t.columns, t.rows, types) : t; });
  D('FromColumns', ['lists', 'columns?'], (ls, c) => { const cs = items(ls).map(items); const n = Math.max(0, ...cs.map((x) => x.length)); const { cols, types } = columnNames(c, cs.length); return new MTable(cols, Array.from({ length: n }, (_, i) => cs.map((x) => (i < x.length ? x[i] : null))), types); });
  D('FromList', ['list', 'splitter?', 'columns?', 'default?', 'extraValues?'], (l, sp, c) => {
    const vals = items(l);
    const split = sp === null ? (x: unknown) => (x instanceof MList ? x.items : typeof x === 'string' ? x.split(',') : [x]) : (x: unknown) => items(call(sp, x));
    const rows = vals.map(split);
    const { cols, types } = columnNames(c, Math.max(1, ...rows.map((x) => x.length)));
    return new MTable(cols, rows.map((x) => cols.map((_, i) => (i < x.length ? x[i] : null))), types);
  });
  D('FromValue', ['value', 'options?'], (v) => {
    if (v instanceof MRecord) return new MTable(['Name', 'Value'], v.names.map((n, i) => [n, v.vals[i]]));
    if (v instanceof MList) return new MTable(['Value'], v.items.map((x) => [x]));
    return new MTable(['Value'], [[v]]);
  });
  D('ToRows', ['table'], (t) => L(table(t).rows.map((r) => L(r))));
  D('ToRecords', ['table'], (t) => L(table(t).rows.map((r) => rowRec(table(t), r))));
  D('ToColumns', ['table'], (t) => L(table(t).columns.map((_, i) => L(table(t).rows.map((r) => r[i])))));
  D('ToList', ['table', 'combiner?'], (t, c) => L(table(t).rows.map((r) => (c === null ? r.map((x) => String(cell(x) ?? '')).join(',') : call(c, L(r))))));
  D('Column', ['table', 'column'], (t, c) => { const i = table(t).col(text(c)); return L(table(t).rows.map((r) => r[i])); });
  D('ColumnNames', ['table'], (t) => L([...table(t).columns]));
  D('ColumnCount', ['table'], (t) => table(t).columns.length);
  D('RowCount', ['table'], (t) => table(t).rows.length);
  D('ApproximateRowCount', ['table'], (t) => table(t).rows.length);
  D('IsEmpty', ['table'], (t) => table(t).rows.length === 0);
  D('HasColumns', ['table', 'columns'], (t, c) => names(c).every((n) => table(t).columns.includes(n)));
  D('ColumnsOfType', ['table', 'listOfTypes'], (t, ts) => { const want = items(ts).map(typ); return L(table(t).columns.filter((_, i) => { const ty = table(t).typeOf(i); return ty && want.some((w) => w.kind === ty.kind && (!w.facet || w.facet === ty.facet)); })); });
  D('Schema', ['table'], (t) => new MTable(['Name', 'Position', 'TypeName', 'Kind', 'IsNullable'], table(t).columns.map((c, i) => { const ty = table(t).typeOf(i) ?? TYPE.any; return [c, i, ty.facet ? `${ty.facet}.Type` : `${ty.kind[0].toUpperCase()}${ty.kind.slice(1)}.Type`, ty.kind, ty.nullable || ty.kind === 'any']; })));
  D('Profile', ['table', 'additionalAggregates?'], (t) => {
    const tb = table(t);
    return new MTable(['Column', 'Min', 'Max', 'Average', 'StandardDeviation', 'Count', 'NullCount', 'DistinctCount'], tb.columns.map((c, i) => {
      const vs = tb.rows.map((r) => force(r[i])).filter((v) => !(v instanceof ErrorCell));
      const nn = vs.filter((v) => v !== null);
      const nums = nn.filter((v): v is number => typeof v === 'number');
      const avg = nums.length ? nums.reduce((s, x) => s + x, 0) / nums.length : null;
      const sd = nums.length > 1 ? Math.sqrt(nums.reduce((s, x) => s + (x - avg!) ** 2, 0) / (nums.length - 1)) : null;
      return [c, nn.length ? nn.reduce((m, x) => (compare(x, m) < 0 ? x : m)) : null, nn.length ? nn.reduce((m, x) => (compare(x, m) > 0 ? x : m)) : null, avg, sd, vs.length, vs.length - nn.length, new Set(vs.map((v) => hashKey(v))).size];
    }));
  });

  /* ---- columns ---- */
  D('SelectColumns', ['table', 'columns', 'missingField?'], (t, c, m) => {
    const tb = table(t), ns = names(c).filter((n) => has(tb, n, m) || m === 2);
    const idx = ns.map((n) => tb.columns.indexOf(n));
    return withTypes(tb, ns, tb.rows.map((r) => idx.map((i) => (i < 0 ? null : r[i]))), idx.map((i) => (i < 0 ? undefined : tb.typeOf(i))));
  });
  D('RemoveColumns', ['table', 'columns', 'missingField?'], (t, c, m) => {
    const tb = table(t), drop = new Set(names(c).filter((n) => has(tb, n, m)));
    const keep = tb.columns.map((n, i) => [n, i] as const).filter(([n]) => !drop.has(n));
    return withTypes(tb, keep.map((k) => k[0]), tb.rows.map((r) => keep.map((k) => r[k[1]])), keep.map((k) => tb.typeOf(k[1])));
  });
  D('RenameColumns', ['table', 'renames', 'missingField?'], (t, rn, m) => {
    const tb = table(t), cols = [...tb.columns];
    for (const [a, b] of renamePairs(rn)) { const i = cols.indexOf(a); if (i < 0) { has(tb, a, m); continue; } cols[i] = b; }
    return new MTable(cols, tb.rows, tb.types);
  });
  D('ReorderColumns', ['table', 'columnOrder', 'missingField?'], (t, o, m) => {
    const tb = table(t), order = names(o).filter((n) => has(tb, n, m));
    // Listed columns take the positions they occupied, in the new order (like Power Query).
    const slots = tb.columns.map((c, i) => (order.includes(c) ? i : -1)).filter((i) => i >= 0);
    const perm = tb.columns.map((_, i) => i);
    slots.forEach((s, k) => (perm[s] = tb.columns.indexOf(order[k])));
    return withTypes(tb, perm.map((i) => tb.columns[i]), tb.rows.map((r) => perm.map((i) => r[i])), perm.map((i) => tb.typeOf(i)));
  });
  D('PrefixColumns', ['table', 'prefix'], (t, p) => new MTable(table(t).columns.map((c) => `${text(p)}.${c}`), table(t).rows, table(t).types));
  D('DuplicateColumn', ['table', 'columnName', 'newColumnName', 'columnType?'], (t, c, n, ty) => { const tb = table(t), i = tb.col(text(c)); return withTypes(tb, [...tb.columns, text(n)], tb.rows.map((r) => [...r, r[i]]), [...(tb.types ?? tb.columns.map(() => undefined)), ty ?? tb.typeOf(i)]); });
  D('AddColumn', ['table', 'newColumnName', 'columnGenerator', 'columnType?'], (t, n, f, ty) => {
    const tb = table(t);
    return withTypes(tb, [...tb.columns, text(n)], tb.rows.map((r) => [...r, safe(() => invoke(f, [rowRec(tb, r)]))]), [...(tb.types ?? tb.columns.map(() => undefined)), ty ?? undefined]);
  });
  D('AddIndexColumn', ['table', 'newColumnName', 'initialValue?', 'increment?', 'columnType?'], (t, n, s, inc) => {
    const tb = table(t), start = s === null ? 0 : num(s), step = inc === null ? 1 : num(inc);
    return withTypes(tb, [...tb.columns, text(n)], tb.rows.map((r, i) => [...r, start + i * step]), [...(tb.types ?? tb.columns.map(() => undefined)), TYPE.int64]);
  });
  D('TransformColumns', ['table', 'transformOperations', 'defaultTransformation?', 'missingField?'], (t, ops, dflt, m) => {
    const tb = table(t), types = [...(tb.types ?? tb.columns.map(() => undefined))];
    const fs: (unknown | null)[] = tb.columns.map(() => dflt);
    for (const [c, f, ty] of transformPairs(ops)) { if (!has(tb, c, m)) continue; const i = tb.col(c); fs[i] = f; if (ty instanceof MType) types[i] = ty; }
    return withTypes(tb, tb.columns, tb.rows.map((r) => r.map((v, i) => (fs[i] === null ? v : safe(() => invoke(fs[i], [cell(v)]))))), types);
  });
  D('TransformColumnTypes', ['table', 'typeTransformations', 'culture?'], (t, ops, c) => {
    const tb = table(t), types = [...(tb.types ?? tb.columns.map(() => undefined))], conv: ((v: unknown) => unknown)[] = tb.columns.map(() => (v: unknown) => v);
    const cult = culture(c);
    for (const [col, ty] of transformPairs(ops)) { const i = tb.col(col); const tt = typ(ty); types[i] = tt; conv[i] = (v) => convertTo(v, tt, cult); }
    return withTypes(tb, tb.columns, tb.rows.map((r) => r.map((v, i) => (conv[i] === undefined ? v : safe(() => conv[i](cell(v)))))), types);
  });
  D('CombineColumns', ['table', 'sourceColumns', 'combiner', 'column'], (t, cs, f, n) => {
    const tb = table(t), src = names(cs), idx = src.map((c) => tb.col(c));
    const keep = tb.columns.map((c, i) => [c, i] as const).filter(([c]) => !src.includes(c));
    const at = Math.min(...idx);
    const cols = keep.map((k) => k[0]); cols.splice(keep.filter((k) => k[1] < at).length, 0, text(n));
    return new MTable(cols, tb.rows.map((r) => { const out = keep.map((k) => r[k[1]]); out.splice(keep.filter((k) => k[1] < at).length, 0, safe(() => invoke(f, [L(idx.map((i) => cell(r[i])))]))); return out; }));
  });
  D('SplitColumn', ['table', 'sourceColumn', 'splitter', 'columnNamesOrNumber?', 'default?', 'extraColumns?'], (t, c, sp, cn, dflt) => {
    const tb = table(t), i = tb.col(text(c));
    const parts = tb.rows.map((r) => { const v = cell(r[i]); return v === null ? [] : items(call(sp, v)); });
    const n = typeof cn === 'number' ? cn : cn === null ? Math.max(1, ...parts.map((p) => p.length)) : names(cn).length;
    const newCols = cn === null || typeof cn === 'number' ? Array.from({ length: n }, (_, k) => `${text(c)}.${k + 1}`) : names(cn);
    const cols = [...tb.columns.slice(0, i), ...newCols, ...tb.columns.slice(i + 1)];
    return new MTable(cols, tb.rows.map((r, k) => [...r.slice(0, i), ...newCols.map((_, j) => (j < parts[k].length ? parts[k][j] : dflt)), ...r.slice(i + 1)]));
  });

  /* ---- rows ---- */
  D('SelectRows', ['table', 'condition'], (t, f) => { const tb = table(t); return new MTable(tb.columns, tb.rows.filter((r) => bool(invoke(f, [rowRec(tb, r)]))), tb.types); });
  D('RemoveRows', ['table', 'offset', 'count?'], (t, o, c) => { const tb = table(t), rows = [...tb.rows]; rows.splice(num(o), c === null ? 1 : num(c)); return new MTable(tb.columns, rows, tb.types); });
  D('FirstN', ['table', 'countOrCondition'], (t, c) => { const tb = table(t); return new MTable(tb.columns, tb.rows.slice(0, countRows(tb, c)), tb.types); });
  D('LastN', ['table', 'countOrCondition'], (t, c) => { const tb = table(t), n = countRows(tb, c, true); return new MTable(tb.columns, n ? tb.rows.slice(-n) : [], tb.types); });
  D('Skip', ['table', 'countOrCondition?'], (t, c) => { const tb = table(t); return new MTable(tb.columns, tb.rows.slice(countRows(tb, c)), tb.types); });
  D('RemoveFirstN', ['table', 'countOrCondition?'], (t, c) => { const tb = table(t); return new MTable(tb.columns, tb.rows.slice(countRows(tb, c)), tb.types); });
  D('RemoveLastN', ['table', 'countOrCondition?'], (t, c) => { const tb = table(t), n = countRows(tb, c, true); return new MTable(tb.columns, n ? tb.rows.slice(0, -n) : tb.rows, tb.types); });
  D('Range', ['table', 'offset', 'count?'], (t, o, c) => { const tb = table(t); return new MTable(tb.columns, tb.rows.slice(num(o), c === null ? undefined : num(o) + num(c)), tb.types); });
  D('AlternateRows', ['table', 'offset', 'skip', 'take'], (t, o, s, k) => { const tb = table(t), off = num(o), sk = num(s), tk = num(k); return new MTable(tb.columns, tb.rows.filter((_, i) => i < off || (i - off) % (sk + tk) >= sk), tb.types); });
  D('ReverseRows', ['table'], (t) => new MTable(table(t).columns, [...table(t).rows].reverse(), table(t).types));
  D('Repeat', ['table', 'count'], (t, n) => new MTable(table(t).columns, Array.from({ length: num(n) }, () => table(t).rows).flat(), table(t).types));
  D('First', ['table', 'default?'], (t, d) => (table(t).rows.length ? rowRec(table(t), table(t).rows[0]) : d));
  D('Last', ['table', 'default?'], (t, d) => (table(t).rows.length ? rowRec(table(t), table(t).rows[table(t).rows.length - 1]) : d));
  D('FirstValue', ['table', 'default?'], (t, d) => (table(t).rows.length && table(t).columns.length ? cell(table(t).rows[0][0]) : d));
  D('SingleRow', ['table'], (t) => { if (table(t).rows.length !== 1) throw err('La tabella deve contenere esattamente una riga.'); return rowRec(table(t), table(t).rows[0]); });
  D('InsertRows', ['table', 'offset', 'rows'], (t, o, rs) => { const tb = table(t), rows = [...tb.rows]; rows.splice(num(o), 0, ...items(rs).map((r) => tb.columns.map((c) => rec(r).get(c)))); return new MTable(tb.columns, rows, tb.types); });
  D('ReplaceRows', ['table', 'offset', 'count', 'rows'], (t, o, n, rs) => { const tb = table(t), rows = [...tb.rows]; rows.splice(num(o), num(n), ...items(rs).map((r) => tb.columns.map((c) => rec(r).get(c)))); return new MTable(tb.columns, rows, tb.types); });
  D('RemoveMatchingRows', ['table', 'rows', 'equationCriteria?'], (t, rs, c) => { const tb = table(t), drop = items(rs).map(rec), eq = eqWith(c); return new MTable(tb.columns, tb.rows.filter((r) => !drop.some((d) => d.names.every((n) => eq(cell(r[tb.col(n)]), d.get(n))))), tb.types); });
  D('Distinct', ['table', 'equationCriteria?'], (t, c) => {
    const tb = table(t);
    let cols = tb.columns.map((_, i) => i), cmp: unknown = null;
    if (typeof c === 'string') cols = [tb.col(c)];
    else if (c instanceof MList) { const v = c.values(); if (v.every((x) => typeof x === 'string')) cols = v.map((x) => tb.col(x)); else if (typeof v[0] === 'string') { cols = [tb.col(v[0])]; cmp = v[1]; } }
    else if (c !== null) cmp = c;
    const k = keyWith(cmp), seen = new Set<string>();
    return new MTable(tb.columns, tb.rows.filter((r) => { const h = cols.map((i) => k(cell(r[i]))).join('\u0001'); if (seen.has(h)) return false; seen.add(h); return true; }), tb.types);
  });
  D('IsDistinct', ['table', 'comparisonCriteria?'], (t) => { const tb = table(t); const s = new Set(tb.rows.map((r) => r.map((x) => hashKey(cell(x))).join('\u0001'))); return s.size === tb.rows.length; });
  D('Sort', ['table', 'comparisonCriteria'], (t, c) => { const tb = table(t); return new MTable(tb.columns, [...tb.rows].sort(rowSorter(tb, c)), tb.types); });
  D('FillDown', ['table', 'columns'], (t, cs) => { const tb = table(t), idx = names(cs).map((c) => tb.col(c)), last: unknown[] = idx.map(() => null); return new MTable(tb.columns, tb.rows.map((r) => { const o = [...r]; idx.forEach((i, k) => { const v = force(o[i]); if (v === null) o[i] = last[k]; else last[k] = o[i]; }); return o; }), tb.types); });
  D('FillUp', ['table', 'columns'], (t, cs) => { const tb = table(t), idx = names(cs).map((c) => tb.col(c)), last: unknown[] = idx.map(() => null); const rows = tb.rows.map((r) => [...r]); for (let j = rows.length - 1; j >= 0; j--) idx.forEach((i, k) => { const v = force(rows[j][i]); if (v === null) rows[j][i] = last[k]; else last[k] = rows[j][i]; }); return new MTable(tb.columns, rows, tb.types); });
  D('ReplaceValue', ['table', 'oldValue', 'newValue', 'replacer', 'columnsToSearch'], (t, o, n, rp, cs) => {
    const tb = table(t), idx = new Set(names(cs).map((c) => tb.col(c)));
    const old = (r: unknown[]) => (o instanceof MFunction ? invoke(o, [rowRec(tb, r)]) : o), nw = (r: unknown[]) => (n instanceof MFunction ? invoke(n, [rowRec(tb, r)]) : n);
    return new MTable(tb.columns, tb.rows.map((r) => r.map((v, i) => (idx.has(i) ? safe(() => invoke(rp, [cell(v), old(r), nw(r)])) : v))), tb.types);
  });
  D('ReplaceErrorValues', ['table', 'errorReplacement'], (t, reps) => {
    const tb = table(t), map = new Map(transformPairs(reps).map(([c, v]) => [tb.col(c), v]));
    return new MTable(tb.columns, tb.rows.map((r) => r.map((v, i) => (map.has(i) && force(v) instanceof ErrorCell ? map.get(i) : v))), tb.types);
  });
  const isErrRow = (r: unknown[], idx: number[]) => idx.some((i) => { try { return force(r[i]) instanceof ErrorCell; } catch (e) { if (e instanceof MError) return true; throw e; } });
  D('RemoveRowsWithErrors', ['table', 'columns?'], (t, cs) => { const tb = table(t), idx = cs === null ? tb.columns.map((_, i) => i) : names(cs).map((c) => tb.col(c)); return new MTable(tb.columns, tb.rows.filter((r) => !isErrRow(r, idx)), tb.types); });
  D('SelectRowsWithErrors', ['table', 'columns?'], (t, cs) => { const tb = table(t), idx = cs === null ? tb.columns.map((_, i) => i) : names(cs).map((c) => tb.col(c)); return new MTable(tb.columns, tb.rows.filter((r) => isErrRow(r, idx)), tb.types); });
  D('TransformRows', ['table', 'transform'], (t, f) => L(table(t).rows.map((r) => invoke(f, [rowRec(table(t), r)]))));
  D('Contains', ['table', 'row', 'equationCriteria?'], (t, row, c) => { const tb = table(t), r = rec(row), eq = eqWith(c); return tb.rows.some((x) => r.names.every((n) => eq(cell(x[tb.col(n)]), r.get(n)))); });
  D('ContainsAll', ['table', 'rows', 'equationCriteria?'], (t, rows, c) => { const tb = table(t), eq = eqWith(c); return items(rows).every((row) => tb.rows.some((x) => rec(row).names.every((n) => eq(cell(x[tb.col(n)]), rec(row).get(n))))); });
  D('ContainsAny', ['table', 'rows', 'equationCriteria?'], (t, rows, c) => { const tb = table(t), eq = eqWith(c); return items(rows).some((row) => tb.rows.some((x) => rec(row).names.every((n) => eq(cell(x[tb.col(n)]), rec(row).get(n))))); });
  D('PositionOf', ['table', 'row', 'occurrence?', 'equationCriteria?'], (t, row, o, c) => { const tb = table(t), r = rec(row), eq = eqWith(c); const hits = tb.rows.map((x, i) => (r.names.every((n) => eq(cell(x[tb.col(n)]), r.get(n))) ? i : -1)).filter((i) => i >= 0); return o === 2 ? L(hits) : o === 1 ? hits[hits.length - 1] ?? -1 : hits[0] ?? -1; });
  D('MatchesAllRows', ['table', 'condition'], (t, f) => table(t).rows.every((r) => bool(invoke(f, [rowRec(table(t), r)]))));
  D('MatchesAnyRows', ['table', 'condition'], (t, f) => table(t).rows.some((r) => bool(invoke(f, [rowRec(table(t), r)]))));
  D('FindText', ['table', 'text'], (t, s) => new MTable(table(t).columns, table(t).rows.filter((r) => r.some((v) => findText(cell(v), text(s)))), table(t).types));
  const extreme = (dir: 1 | -1) => (t: unknown, c: unknown, d: unknown) => { const tb = table(t); if (!tb.rows.length) return d; const s = rowSorter(tb, c); return rowRec(tb, tb.rows.reduce((m, r) => (s(r, m) * dir > 0 ? r : m))); };
  D('Max', ['table', 'comparisonCriteria', 'default?'], extreme(1));
  D('Min', ['table', 'comparisonCriteria', 'default?'], extreme(-1));
  D('MaxN', ['table', 'comparisonCriteria', 'countOrCondition'], (t, c, n) => { const tb = table(t), s = rowSorter(tb, c); const rows = [...tb.rows].sort((a, b) => s(b, a)); const sorted = new MTable(tb.columns, rows, tb.types); return new MTable(tb.columns, rows.slice(0, countRows(sorted, n)), tb.types); });
  D('MinN', ['table', 'comparisonCriteria', 'countOrCondition'], (t, c, n) => { const tb = table(t), s = rowSorter(tb, c); const rows = [...tb.rows].sort(s); const sorted = new MTable(tb.columns, rows, tb.types); return new MTable(tb.columns, rows.slice(0, countRows(sorted, n)), tb.types); });

  /* ---- reshape ---- */
  D('PromoteHeaders', ['table', 'options?'], (t, o) => {
    const tb = table(t);
    if (!tb.rows.length) return tb;
    const all = opt(o, 'PromoteAllScalars', false) === true;
    const head = tb.rows[0].map((v, i) => { const x = cell(v); return typeof x === 'string' && x !== '' ? x : all && x !== null ? String(x) : `Column${i + 1}`; });
    // Duplicate header names get a suffix, like Power Query.
    const seen = new Map<string, number>();
    const cols = head.map((h) => { const n = seen.get(h) ?? 0; seen.set(h, n + 1); return n ? `${h}_${n}` : h; });
    return new MTable(cols, tb.rows.slice(1));
  });
  D('DemoteHeaders', ['table'], (t) => { const tb = table(t); return new MTable(tb.columns.map((_, i) => `Column${i + 1}`), [tb.columns, ...tb.rows]); });
  D('Transpose', ['table', 'columns?'], (t, c) => { const tb = table(t); const { cols } = columnNames(c, tb.rows.length); return new MTable(cols, tb.columns.map((_, i) => tb.rows.map((r) => r[i]))); });
  D('Unpivot', ['table', 'pivotColumns', 'attributeColumn', 'valueColumn'], (t, cs, a, v) => unpivot(table(t), names(cs), text(a), text(v)));
  D('UnpivotOtherColumns', ['table', 'pivotColumns', 'attributeColumn', 'valueColumn'], (t, cs, a, v) => { const keep = names(cs); return unpivot(table(t), table(t).columns.filter((c) => !keep.includes(c)), text(a), text(v)); });
  D('Pivot', ['table', 'pivotValues', 'attributeColumn', 'valueColumn', 'aggregationFunction?'], (t, pv, ac, vc, agg) => {
    const tb = table(t), ai = tb.col(text(ac)), vi = tb.col(text(vc)), values = items(pv).map((x) => String(cell(x)));
    const keyCols = tb.columns.map((_, i) => i).filter((i) => i !== ai && i !== vi);
    const groups = new Map<string, { key: unknown[]; cells: unknown[][] }>();
    for (const r of tb.rows) {
      const h = keyCols.map((i) => hashKey(cell(r[i]))).join('\u0001');
      let g = groups.get(h); if (!g) { g = { key: keyCols.map((i) => r[i]), cells: values.map(() => []) }; groups.set(h, g); }
      const j = values.indexOf(String(cell(r[ai]))); if (j >= 0) g.cells[j].push(r[vi]);
    }
    return new MTable([...keyCols.map((i) => tb.columns[i]), ...values], [...groups.values()].map((g) => [...g.key, ...g.cells.map((c) => {
      if (agg !== null) return safe(() => invoke(agg, [L(c)]));
      if (c.length > 1) return new ErrorCell(err('Sono presenti troppi elementi nell\'enumerazione per completare l\'operazione.'));
      return c.length ? c[0] : null;
    })]));
  });
  D('Group', ['table', 'key', 'aggregatedColumns', 'groupKind?', 'comparer?'], (t, k, aggs, kind, cmp) => {
    const tb = table(t), keys = names(k), ki = keys.map((c) => tb.col(c)), hk = keyWith(cmp);
    const defs = (() => { const a = items(aggs); return a.length && !(a[0] instanceof MList) ? [a] : a.map(items); })();
    const groups: { key: unknown[]; rows: unknown[][] }[] = [];
    const byKey = new Map<string, { key: unknown[]; rows: unknown[][] }>();
    let last: string | null = null;
    for (const r of tb.rows) {
      const h = ki.map((i) => hk(cell(r[i]))).join('\u0001');
      if (kind === 0) { // GroupKind.Local: consecutive runs
        if (h !== last) { groups.push({ key: ki.map((i) => r[i]), rows: [] }); last = h; }
        groups[groups.length - 1].rows.push(r);
      } else {
        let g = byKey.get(h); if (!g) { g = { key: ki.map((i) => r[i]), rows: [] }; byKey.set(h, g); groups.push(g); }
        g.rows.push(r);
      }
    }
    return new MTable([...keys, ...defs.map((d) => text(d[0]))], groups.map((g) => [...g.key, ...defs.map((d) => safe(() => invoke(d[1], [new MTable(tb.columns, g.rows, tb.types)])))]), [...ki.map((i) => tb.typeOf(i)), ...defs.map((d) => (d[2] instanceof MType ? d[2] : undefined))]);
  });
  D('AggregateTableColumn', ['table', 'column', 'aggregations'], (t, c, aggs) => {
    const tb = table(t), i = tb.col(text(c)), defs = items(aggs).map(items);
    const cols = [...tb.columns.slice(0, i), ...defs.map((d) => text(d[2])), ...tb.columns.slice(i + 1)];
    return new MTable(cols, tb.rows.map((r) => { const sub = cell(r[i]); return [...r.slice(0, i), ...defs.map((d) => safe(() => invoke(d[1], [sub === null ? L([]) : new MList(table(sub).rows.map((x) => x[table(sub).col(text(d[0]))]))]))), ...r.slice(i + 1)]; }));
  });

  /* ---- joins / combine / expand ---- */
  D('Combine', ['tables', 'columns?'], (ts, c) => { const tbs = items(ts).map(table); const out = appendTables(tbs); if (c === null) return out; const want = c instanceof MType && c.columns ? c.columns.map((x) => x.name) : names(c); const idx = want.map((n) => out.columns.indexOf(n)); return new MTable(want, out.rows.map((r) => idx.map((i) => (i < 0 ? null : r[i])))); });
  D('NestedJoin', ['table1', 'key1', 'table2', 'key2', 'newColumnName', 'joinKind?', 'keyEqualityComparers?'], (a, k1, b, k2, n, kind, cmps) => nestedJoin(table(a), names(k1), table(b), names(k2), text(n), kind === null ? 1 : num(kind), cmps));
  D('Join', ['table1', 'key1', 'table2', 'key2', 'joinKind?', 'joinAlgorithm?', 'keyEqualityComparers?'], (a, k1, b, k2, kind, _alg, cmps) => {
    const ta = table(a), tb = table(b);
    for (const c of tb.columns) if (ta.columns.includes(c)) throw err(`Il nome della colonna '${c}' è duplicato. Rinominare le colonne prima di Table.Join.`);
    const nested = nestedJoin(ta, names(k1), tb, names(k2), '\u0000j', kind === null ? 0 : num(kind), cmps);
    return expandTable(nested, '\u0000j', tb.columns, tb.columns);
  });
  D('ExpandTableColumn', ['table', 'column', 'columnNames', 'newColumnNames?'], (t, c, cs, ns) => expandTable(table(t), text(c), names(cs), ns === null ? names(cs) : names(ns)));
  D('ExpandRecordColumn', ['table', 'column', 'fieldNames', 'newColumnNames?'], (t, c, fs, ns) => {
    const tb = table(t), i = tb.col(text(c)), f = names(fs), nn = ns === null ? f : names(ns);
    return new MTable([...tb.columns.slice(0, i), ...nn, ...tb.columns.slice(i + 1)], tb.rows.map((r) => { const v = cell(r[i]); return [...r.slice(0, i), ...f.map((x) => (v === null || !rec(v).has(x) ? null : rec(v).vals[rec(v).names.indexOf(x)])), ...r.slice(i + 1)]; }));
  });
  D('ExpandListColumn', ['table', 'column'], (t, c) => {
    const tb = table(t), i = tb.col(text(c));
    return new MTable(tb.columns, tb.rows.flatMap((r) => { const v = cell(r[i]); if (v === null) return [r]; const xs = list(v).items; return xs.length ? xs.map((x) => { const o = [...r]; o[i] = x; return o; }) : [[...r.slice(0, i), null, ...r.slice(i + 1)]]; }), tb.types);
  });
  D('ExpandRecordColumnWithPrefix', ['table', 'column'], (t) => t);

  /* ---- no-ops kept for compatibility ---- */
  for (const n of ['Buffer', 'StopFolding', 'ConformToPageReader']) D(n, ['table', 'options?'], (t) => t);
  D('AddKey', ['table', 'columns', 'isPrimary'], (t) => t);
  D('ReplaceKeys', ['table', 'keys'], (t) => t);
  D('Keys', ['table'], () => L([]));
  D('View', ['table', 'handlers'], (t) => t);
  D('ViewFunction', ['function'], (f) => f);
  D('Partition', ['table', 'column', 'groups', 'hash'], (t, c, g, h) => { const tb = table(t), i = tb.col(text(c)), n = num(g); const parts: unknown[][][] = Array.from({ length: n }, () => []); for (const r of tb.rows) parts[((num(call(h, cell(r[i]))) % n) + n) % n].push(r); return L(parts.map((p) => new MTable(tb.columns, p, tb.types))); });
  D('PartitionValues', ['table'], () => new MTable([], []));
  void equals; void typeOfValue; void sorter; void fn;
}

function unpivot(tb: MTable, cols: string[], a: string, v: string): MTable {
  const idx = cols.map((c) => tb.col(c));
  const keep = tb.columns.map((_, i) => i).filter((i) => !idx.includes(i));
  const rows: unknown[][] = [];
  for (const r of tb.rows) for (const i of idx) { const x = force(r[i]); if (x === null) continue; rows.push([...keep.map((k) => r[k]), tb.columns[i], r[i]]); }
  return new MTable([...keep.map((k) => tb.columns[k]), a, v], rows, [...keep.map((k) => tb.typeOf(k)), TYPE.text, undefined]);
}

/** JoinKind: Inner 0, LeftOuter 1, RightOuter 2, FullOuter 3, LeftAnti 4, RightAnti 5. */
export function nestedJoin(a: MTable, k1: string[], b: MTable, k2: string[], name: string, kind: number, cmps: unknown = null): MTable {
  if (k1.length !== k2.length) throw err('Il numero di colonne chiave non corrisponde.');
  const ia = k1.map((c) => a.col(c)), ib = k2.map((c) => b.col(c));
  const ic = cmps instanceof MList && cmps.values().some((x) => (x as { ignoreCase?: boolean })?.ignoreCase);
  const key = (r: unknown[], idx: number[]) => idx.map((i) => hashKey(cell(r[i]), ic)).join('\u0001');
  const index = new Map<string, unknown[][]>();
  for (const r of b.rows) { const k = key(r, ib); if (k.split('\u0001').includes('n')) continue; const l = index.get(k); if (l) l.push(r); else index.set(k, [r]); }
  const used = new Set<unknown[]>();
  const rows: unknown[][] = [];
  for (const r of a.rows) {
    const k = key(r, ia);
    const m = k.split('\u0001').includes('n') ? [] : index.get(k) ?? [];
    m.forEach((x) => used.add(x));
    if (kind === 0 && !m.length) continue;
    if (kind === 4 && m.length) continue;
    if (kind === 2 || kind === 5) continue;
    rows.push([...r, new MTable(b.columns, kind === 4 ? [] : m, b.types)]);
  }
  if (kind === 2 || kind === 5) {
    // Right outer / anti: driven by the right table.
    const left = new Map<string, unknown[][]>();
    for (const r of a.rows) { const k = key(r, ia); const l = left.get(k); if (l) l.push(r); else left.set(k, [r]); }
    for (const r of b.rows) {
      const m = left.get(key(r, ib)) ?? [];
      if (kind === 5 && m.length) continue;
      if (kind === 5 || !m.length) rows.push([...a.columns.map(() => null), new MTable(b.columns, [r], b.types)]);
      else for (const l of m) rows.push([...l, new MTable(b.columns, [r], b.types)]);
    }
  }
  if (kind === 3) for (const r of b.rows) if (!used.has(r)) rows.push([...a.columns.map(() => null), new MTable(b.columns, [r], b.types)]);
  return new MTable([...a.columns, name], rows, [...(a.types ?? a.columns.map(() => undefined)), TYPE.table]);
}

export function expandTable(tb: MTable, col: string, cols: string[], newNames: string[]): MTable {
  const i = tb.col(col);
  for (const n of newNames) if (tb.columns.includes(n) && n !== col) throw err(`Il nome della colonna '${n}' è duplicato.`);
  const out: unknown[][] = [];
  for (const r of tb.rows) {
    const v = cell(r[i]);
    if (v === null || (v instanceof MTable && !v.rows.length)) { out.push([...r.slice(0, i), ...cols.map(() => null), ...r.slice(i + 1)]); continue; }
    const sub = table(v);
    const idx = cols.map((c) => sub.columns.indexOf(c));
    for (const s of sub.rows) out.push([...r.slice(0, i), ...idx.map((j) => (j < 0 ? null : s[j])), ...r.slice(i + 1)]);
  }
  return new MTable([...tb.columns.slice(0, i), ...newNames, ...tb.columns.slice(i + 1)], out);
}
