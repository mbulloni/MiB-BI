// Visual calculations (Home › Nuovo calcolo visivo): DAX evaluated on the visual matrix, the aggregated
// data the visual shows, instead of on the model. Rows of the matrix are the groups of the row axis
// (category, table columns, matrix rows), its columns the groups of the column axis (legend, matrix
// columns). Window functions (RUNNINGSUM, PREVIOUS, MOVINGAVERAGE…) walk an axis; COLLAPSE / EXPAND
// move to a higher / lower level of the axes, whose values come from extra queries of the same visual
// with fewer fields (so non-additive measures stay correct).
import { DaxError, parse, type Node } from '../dax/parse';
import { expandUdfCalls, type Model } from '../dax';
import type { FieldRef, Visual } from '../types';
import { CF_WELL, type QueryItem } from '../query';
import { refLabel, fmtWith } from '../format';
import { visualDef } from './catalog';

export const isCalc = (f: FieldRef) => f.agg === 'visualCalc';
export const hasCalcs = (v: Visual) => Object.values(v.fields).some((l) => l.some(isCalc));
/** Visual types without visual calculations (like Power BI: slicers, AI visuals, scripts, custom visuals…). */
export const NO_CALCS = new Set(['slicer', 'decompositionTree', 'keyInfluencers', 'smartNarrative', 'qna', 'pythonVisual', 'rVisual', 'custom', 'textbox', 'image', 'shape', 'button', 'pageNavigator', 'bookmarkNavigator', 'unsupported']);

/** The visual without its calculations: what the query engine computes. */
export function stripCalcs(v: Visual): Visual {
  const fields = Object.fromEntries(Object.entries(v.fields).map(([k, l]) => [k, l.filter((f) => !isCalc(f))] as const).filter(([, l]) => l.length));
  // "Ordina asse" counts the fields of every well: the index moves past the removed calculations (no sorting by a calculation, like Power BI).
  let format = v.format;
  if (v.format.sortBy !== undefined) {
    const flat = visualDef(v.type, v.custom).wells.flatMap((w) => v.fields[w.key] ?? []);
    const f = flat[v.format.sortBy];
    format = { ...v.format, sortBy: f && !isCalc(f) ? flat.filter((x) => !isCalc(x)).indexOf(f) : undefined };
  }
  return { ...v, fields, format };
}

/** Row and column axes of the visual matrix (grouping items of the query). */
export function axesOf(v: Visual, items: QueryItem[]): { rows: QueryItem[]; cols: QueryItem[] } {
  const colWell = v.type === 'matrix' ? 'columns' : 'legend';
  const dims = items.filter((i) => !i.measure && i.well !== CF_WELL);
  return { rows: dims.filter((i) => i.well !== colWell), cols: dims.filter((i) => i.well === colWell) };
}

export const same = (a: FieldRef, b: FieldRef) => a.table === b.table && a.column === b.column && a.agg === b.agg && a.datePart === b.datePart;

/** The visual grouped only by `keep` (a level of the matrix): measures stay, other grouping fields go. */
export function levelVisual(v: Visual, items: QueryItem[], keep: QueryItem[]): Visual {
  const fields: Record<string, FieldRef[]> = {};
  for (const [w, list] of Object.entries(v.fields)) {
    const dims = items.filter((i) => !i.measure && i.well === w);
    const kept = dims.filter((i) => keep.includes(i));
    const out = kept.length === dims.length ? list : list.filter((f) => f.agg !== 'none' || kept.some((k) => same(k.field, f)));
    if (out.length) fields[w] = out;
  }
  return { ...v, fields, topN: undefined };
}

/** Which levels a set of calculations needs besides the visual's own: none, the axis prefixes, or any subset. */
export function levelsNeeded(nodes: Node[]): 'none' | 'prefix' | 'all' {
  let need: 'none' | 'prefix' | 'all' = 'none';
  const walk = (x: Node) => {
    if (x.k === 'call') {
      if (x.fn === 'LOOKUPWITHTOTALS') need = 'all';
      else if (need === 'none' && ['COLLAPSE', 'COLLAPSEALL', 'EXPAND', 'EXPANDALL'].includes(x.fn)) need = 'prefix';
      x.args.forEach(walk);
    } else if (x.k === 'bin') { walk(x.a); walk(x.b); } else if (x.k === 'neg') walk(x.a);
    else if (x.k === 'let') { x.vars.forEach(([, v]) => walk(v)); walk(x.body); }
  };
  nodes.forEach(walk);
  return need;
}

/** Index sets of the levels to query: [kept row dims, kept column dims]. */
export function levelSets(nr: number, nc: number, need: 'none' | 'prefix' | 'all'): [number[], number[]][] {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const subsets = (n: number): number[][] => (need === 'all'
    ? Array.from({ length: 1 << n }, (_, m) => range(n).filter((i) => m & (1 << i)))
    : range(n + 1).map((k) => range(k)));
  if (need === 'none') return [];
  const out: [number[], number[]][] = [];
  for (const r of subsets(nr)) for (const c of subsets(nc)) if (r.length !== nr || c.length !== nc) out.push([r, c]);
  return out;
}

export interface Level { rk: number[]; ck: number[]; rows: Record<string, any>[]; }
export const levelKey = (rk: number[], ck: number[]) => `${rk.join(',')}|${ck.join(',')}`;

type V = number | string | boolean | null;
interface Cell { L: Level; i: number; }
interface Env { c: Cell; set?: Cell[]; vars: Map<string, V | Cell[]>; }

const AXES = new Set(['ROWS', 'COLUMNS', 'ROWPAGES', 'ROWS COLUMNS', 'COLUMNS ROWS']);
const BLANKS = new Set(['KEEP', 'SKIP', 'DEFAULT']);
const RESET = new Map([['NONE', 0], ['HIGHESTPARENT', 1], ['LOWESTPARENT', -1]]);
const keyOf = (x: unknown) => (x === null || x === undefined ? '\u0000' : String(x));
const num = (x: V) => (x === null || x === '' ? null : typeof x === 'boolean' ? Number(x) : typeof x === 'number' ? x : Number.isFinite(Number(x)) ? Number(x) : null);

export interface CalcDef { name: string; alias: string; expression: string; }

/**
 * Evaluates the calculations of a visual. `refs`: name of each field in the visual → its item;
 * `levels`: the leaf level (the visual's rows) and the other levels available.
 */
export class CalcEngine {
  private calcs = new Map<string, { name: string; alias: string; node: Node }>();
  private memo = new Map<string, V>();
  private busy = new Set<string>();
  private orders = new Map<string, { r: Map<string, number>; c: Map<string, number> }>();
  private leaf: Level;

  constructor(defs: CalcDef[], private refs: Map<string, QueryItem>, private rowDims: QueryItem[], private colDims: QueryItem[],
    private levels: Map<string, Level>, model: Model) {
    for (const d of defs) {
      let node: Node;
      try { node = expandUdfCalls(model, parse(d.expression)); } catch (e) { throw new DaxError(`[${d.name}]: ${(e as Error).message}`); }
      this.calcs.set(d.name.toLowerCase(), { name: d.name, alias: d.alias, node });
    }
    this.leaf = levels.get(levelKey(rowDims.map((_x, i) => i), colDims.map((_x, i) => i)))!;
  }

  /** Value of calculation `name` at row `i` of `L`. */
  value(name: string, L: Level, i: number): V {
    const c = this.calcs.get(name.toLowerCase())!;
    const k = `${c.alias}|${levelKey(L.rk, L.ck)}|${i}`;
    if (this.memo.has(k)) return this.memo.get(k)!;
    if (this.busy.has(k)) throw new DaxError(`Riferimento circolare nel calcolo visivo [${c.name}]`);
    this.busy.add(k);
    try {
      const v = this.ev(c.node, { c: { L, i }, vars: new Map() });
      const out = Array.isArray(v) ? null : v;
      this.memo.set(k, out);
      return out;
    } finally { this.busy.delete(k); }
  }

  /* ------------------------------- matrix ------------------------------- */

  private dimVal(c: Cell, d: QueryItem) { return keyOf(c.L.rows[c.i][d.alias]); }
  private rowKey(c: Cell, idx = c.L.rk) { return idx.map((k) => this.dimVal(c, this.rowDims[k])).join('\u0001'); }
  private colKey(c: Cell, idx = c.L.ck) { return idx.map((k) => this.dimVal(c, this.colDims[k])).join('\u0001'); }

  /** Position of a cell's row / column group in the visual (first appearance in the visual's rows). */
  private ord(c: Cell): { r: number; c: number } {
    const lk = levelKey(c.L.rk, c.L.ck);
    let o = this.orders.get(lk);
    if (!o) {
      o = { r: new Map(), c: new Map() };
      this.leaf.rows.forEach((_row, i) => {
        const lc = { L: this.leaf, i };
        const rk = this.rowKey(lc, c.L.rk), ck = this.colKey(lc, c.L.ck);
        if (!o!.r.has(rk)) o!.r.set(rk, o!.r.size);
        if (!o!.c.has(ck)) o!.c.set(ck, o!.c.size);
      });
      this.orders.set(lk, o);
    }
    return { r: o.r.get(this.rowKey(c)) ?? c.i, c: o.c.get(this.colKey(c)) ?? c.i };
  }

  /** Cell of level `L` with the same values as `c` on the dims both have. */
  private match(c: Cell, L: Level, fixed?: (d: QueryItem) => string | undefined): Cell[] {
    const want: [string, string][] = [];
    for (const k of L.rk) { const d = this.rowDims[k]; const v = fixed?.(d) ?? (c.L.rk.includes(k) ? this.dimVal(c, d) : undefined); if (v !== undefined) want.push([d.alias, v]); }
    for (const k of L.ck) { const d = this.colDims[k]; const v = fixed?.(d) ?? (c.L.ck.includes(k) ? this.dimVal(c, d) : undefined); if (v !== undefined) want.push([d.alias, v]); }
    const out: Cell[] = [];
    L.rows.forEach((row, i) => { if (want.every(([a, v]) => keyOf(row[a]) === v)) out.push({ L, i }); });
    return out;
  }

  private level(rk: number[], ck: number[]): Level {
    const L = this.levels.get(levelKey(rk, ck));
    if (!L) throw new DaxError('Livello della matrice visiva non disponibile');
    return L;
  }

  private defaultAxis(c: Cell) { return c.L.rk.length || (!c.L.ck.length && this.rowDims.length) ? 'ROWS' : 'COLUMNS'; }

  /** Cells walked by a window function from `c` along `axis`, partitioned by `reset`. */
  private seq(c: Cell, axis: string, reset: number | QueryItem): Cell[] {
    const L = c.L;
    const first = axis.startsWith('COLUMNS') ? 'COLUMNS' : 'ROWS';
    const kept = first === 'ROWS' ? L.rk.map((k) => this.rowDims[k]) : L.ck.map((k) => this.colDims[k]);
    let p: number;
    if (typeof reset === 'number') p = reset > 0 ? Math.min(reset, kept.length) : reset < 0 ? Math.max(0, kept.length + reset) : 0;
    else p = Math.min(kept.indexOf(reset) + 1, kept.length);
    const fixed: QueryItem[] = [...kept.slice(0, Math.max(0, p))];
    if (axis === 'ROWS') fixed.push(...L.ck.map((k) => this.colDims[k]));
    if (axis === 'COLUMNS') fixed.push(...L.rk.map((k) => this.rowDims[k]));
    const cells: Cell[] = [];
    L.rows.forEach((row, i) => { if (fixed.every((d) => keyOf(row[d.alias]) === this.dimVal(c, d))) cells.push({ L, i }); });
    const o = (x: Cell) => this.ord(x);
    const cmp = axis === 'ROWS' ? (a: Cell, b: Cell) => o(a).r - o(b).r
      : axis === 'COLUMNS' ? (a: Cell, b: Cell) => o(a).c - o(b).c
        : axis === 'ROWS COLUMNS' ? (a: Cell, b: Cell) => o(a).c - o(b).c || o(a).r - o(b).r
          : (a: Cell, b: Cell) => o(a).r - o(b).r || o(a).c - o(b).c;
    return cells.sort(cmp);
  }

  /** Optional axis / blanks / reset arguments of window functions. */
  private opts(args: Node[], env: Env): { axis: string; reset: number | QueryItem } {
    let axis = this.defaultAxis(env.c), reset: number | QueryItem = 0;
    for (const a of args) {
      if (a.k === 'call' && a.fn === 'BLANK' && !a.args.length) continue;
      if (a.k === 'tbl' && AXES.has(a.name.toUpperCase())) { axis = a.name.toUpperCase().replace('ROWPAGES', '').trim() || axis; continue; }
      if (a.k === 'tbl' && BLANKS.has(a.name.toUpperCase())) continue;
      if (a.k === 'tbl' && RESET.has(a.name.toUpperCase())) { reset = RESET.get(a.name.toUpperCase())!; continue; }
      if (a.k === 'num') { reset = Number(a.v); continue; }
      if (a.k === 'neg' && a.a.k === 'num') { reset = -Number(a.a.v); continue; }
      if (a.k === 'col') { const it = this.refs.get(a.col.toLowerCase()); if (it && !it.measure) { reset = it; continue; } }
      throw new DaxError('Argomento non valido: usare un asse (ROWS, COLUMNS), KEEP/SKIP o un valore di reimpostazione (HIGHESTPARENT, LOWESTPARENT, NONE, intero, colonna)');
    }
    return { axis, reset };
  }

  /** Level one step (or all steps) up / down along an axis. */
  private moved(c: Cell, axisArg: Node | undefined, dir: 'up' | 'down', all: boolean, steps = 1): Level {
    const axis = axisArg?.k === 'tbl' && AXES.has(axisArg.name.toUpperCase()) ? axisArg.name.toUpperCase() : this.defaultAxis(c);
    let rk = [...c.L.rk], ck = [...c.L.ck];
    const go = (list: number[], n: number) => {
      if (dir === 'up') return all ? [] : list.slice(0, Math.max(0, list.length - steps));
      return all ? Array.from({ length: n }, (_, i) => i) : Array.from({ length: Math.min(n, list.length + steps) }, (_, i) => i);
    };
    if (axis.includes('ROWS')) rk = go(rk, this.rowDims.length);
    if (axis.includes('COLUMNS')) ck = go(ck, this.colDims.length);
    return this.level(rk, ck);
  }

  /* ------------------------------ evaluation ------------------------------ */

  private ref(name: string, env: Env): V {
    const k = name.toLowerCase();
    if (this.calcs.has(k)) return this.value(name, env.c.L, env.c.i);
    const it = this.refs.get(k);
    if (!it) throw new DaxError(`Campo non presente nell'oggetto visivo: [${name}]`);
    const x = env.c.L.rows[env.c.i]?.[it.alias];
    return x === undefined ? null : x;
  }

  private cells(n: Node, env: Env): Cell[] {
    if (n.k === 'var') { const v = env.vars.get(n.name); if (Array.isArray(v)) return v; }
    if (n.k === 'call' && n.fn === 'RANGE') {
      const A = n.args;
      const size = num(this.scalar(A[0], env)) ?? 1;
      const incl = A[1] && !(A[1].k === 'call' && A[1].fn === 'BLANK') ? !!this.scalar(A[1], env) : true;
      const { axis, reset } = this.opts(A.slice(2), env);
      const s = this.seq(env.c, axis, reset);
      const at = s.findIndex((x) => x.i === env.c.i);
      // Negative step: rows before the current one; positive: rows after it.
      return size < 0 ? s.slice(Math.max(0, at + size), incl ? at + 1 : at) : s.slice(incl ? at : at + 1, at + size + 1);
    }
    if (n.k === 'tbl' && n.name.toUpperCase() === 'ROWS') return this.seq(env.c, 'ROWS', 0);
    throw new DaxError('Atteso RANGE(…) o una variabile di tabella');
  }

  private scalar(n: Node, env: Env): V {
    const v = this.ev(n, env);
    if (Array.isArray(v)) throw new DaxError('Una tabella è stata fornita dove era previsto un singolo valore');
    return v;
  }

  private ev(n: Node, env: Env): V | Cell[] {
    switch (n.k) {
      case 'num': return Number(n.v);
      case 'str': return n.v;
      case 'bool': return n.v;
      case 'col':
        if (n.table) throw new DaxError(`I calcoli visivi possono usare solo i campi dell'oggetto visivo: ${n.table}[${n.col}]`);
        return this.ref(n.col, env);
      case 'var': {
        if (!env.vars.has(n.name)) throw new DaxError(`Variabile non definita: ${n.name}`);
        return env.vars.get(n.name)!;
      }
      case 'let': {
        const vars = new Map(env.vars);
        const e = { ...env, vars };
        for (const [name, v] of n.vars) vars.set(name.toUpperCase(), v.k === 'call' && v.fn === 'RANGE' ? this.cells(v, e) : this.ev(v, e));
        return this.ev(n.body, e);
      }
      case 'neg': { const x = num(this.scalar(n.a, env)); return x === null ? null : -x; }
      case 'bin': return this.bin(n.op, n.a, n.b, env);
      case 'tbl': return n.name;
      case 'list': throw new DaxError('Costruttore di tabella non supportato nei calcoli visivi');
      case 'call': return this.call(n, env);
    }
  }

  private bin(op: string, an: Node, bn: Node, env: Env): V {
    const a = this.scalar(an, env), b = this.scalar(bn, env);
    const x = num(a), y = num(b);
    switch (op) {
      case '+': return x === null && y === null ? null : (x ?? 0) + (y ?? 0);
      case '-': return x === null && y === null ? null : (x ?? 0) - (y ?? 0);
      case '*': return x === null || y === null ? null : x * y;
      case '/': return x === null || y === null || y === 0 ? null : x / y;
      case '^': return x === null || y === null ? null : x ** y;
      case '&': return `${a ?? ''}${b ?? ''}`;
      case '&&': return !!a && !!b;
      case '||': return !!a || !!b;
      case 'IN': throw new DaxError('IN non è supportato nei calcoli visivi');
    }
    const ca = typeof a === 'string' || typeof b === 'string' ? (a ?? '') : (x ?? 0);
    const cb = typeof a === 'string' || typeof b === 'string' ? (b ?? '') : (y ?? 0);
    switch (op) {
      case '=': return ca === cb;
      case '==': return a === b;
      case '<>': return ca !== cb;
      case '<': return ca < cb;
      case '>': return ca > cb;
      case '<=': return ca <= cb;
      case '>=': return ca >= cb;
    }
    throw new DaxError(`Operatore non supportato: ${op}`);
  }

  private agg(fn: string, arg: Node | undefined, env: Env): V {
    const set = env.set ?? [env.c];
    if (fn === 'COUNTROWS') return set.length || null;
    if (!arg) throw new DaxError(`${fn} richiede un argomento`);
    const vals = set.map((c) => num(this.scalar(arg, { ...env, c, set: undefined }))).filter((x): x is number => x !== null);
    if (!vals.length) return null;
    switch (fn) {
      case 'SUM': return vals.reduce((s, x) => s + x, 0);
      case 'AVERAGE': return vals.reduce((s, x) => s + x, 0) / vals.length;
      case 'MIN': return Math.min(...vals);
      case 'MAX': return Math.max(...vals);
      default: return vals.length; // COUNT, COUNTA
    }
  }

  private call(n: Extract<Node, { k: 'call' }>, env: Env): V {
    const A = n.args;
    const s = (i: number) => this.scalar(A[i], env);
    const opt = (i: number) => A[i] !== undefined && !(A[i].k === 'call' && (A[i] as any).fn === 'BLANK' && !(A[i] as any).args.length);
    const at = (c: Cell, e: Node) => this.scalar(e, { ...env, c, set: undefined });
    switch (n.fn) {
      case 'RUNNINGSUM': {
        const { axis, reset } = this.opts(A.slice(1), env);
        const sq = this.seq(env.c, axis, reset);
        const k = sq.findIndex((x) => x.i === env.c.i);
        let sum: number | null = null;
        for (const c of sq.slice(0, k + 1)) { const v = num(at(c, A[0])); if (v !== null) sum = (sum ?? 0) + v; }
        return sum;
      }
      case 'MOVINGAVERAGE': {
        const size = Math.max(1, num(s(1)) ?? 1);
        const incl = opt(2) ? !!s(2) : true;
        const { axis, reset } = this.opts(A.slice(3), env);
        const sq = this.seq(env.c, axis, reset);
        const k = sq.findIndex((x) => x.i === env.c.i);
        const win = incl ? sq.slice(Math.max(0, k - size + 1), k + 1) : sq.slice(Math.max(0, k - size), k);
        const vals = win.map((c) => num(at(c, A[0]))).filter((x): x is number => x !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      }
      case 'PREVIOUS': case 'NEXT': {
        const steps = opt(1) ? num(s(1)) ?? 1 : 1;
        const { axis, reset } = this.opts(A.slice(2), env);
        const sq = this.seq(env.c, axis, reset);
        const k = sq.findIndex((x) => x.i === env.c.i) + (n.fn === 'PREVIOUS' ? -steps : steps);
        return k >= 0 && k < sq.length ? at(sq[k], A[0]) : null;
      }
      case 'FIRST': case 'LAST': {
        const { axis, reset } = this.opts(A.slice(1), env);
        const sq = this.seq(env.c, axis, reset);
        const c = n.fn === 'FIRST' ? sq[0] : sq[sq.length - 1];
        return c ? at(c, A[0]) : null;
      }
      case 'COLLAPSE': case 'COLLAPSEALL': {
        const steps = A[1]?.k === 'num' ? Number(A[1].v) : 1;
        const L = this.moved(env.c, A[1]?.k === 'num' ? A[2] : A[1], 'up', n.fn === 'COLLAPSEALL', steps);
        const c = this.match(env.c, L)[0];
        return c ? at(c, A[0]) : null;
      }
      case 'EXPAND': case 'EXPANDALL': {
        const steps = A[1]?.k === 'num' ? Number(A[1].v) : 1;
        const L = this.moved(env.c, A[1]?.k === 'num' ? A[2] : A[1], 'down', n.fn === 'EXPANDALL', steps);
        const set = this.match(env.c, L);
        return set.length ? this.scalar(A[0], { ...env, c: set[0], set }) : null;
      }
      case 'ISATLEVEL': {
        if (A[0]?.k !== 'col') throw new DaxError('ISATLEVEL richiede un campo dell\'oggetto visivo');
        const it = this.refs.get(A[0].col.toLowerCase());
        const r = this.rowDims.indexOf(it!), c = this.colDims.indexOf(it!);
        return (r >= 0 && env.c.L.rk.includes(r)) || (c >= 0 && env.c.L.ck.includes(c));
      }
      case 'LOOKUP': case 'LOOKUPWITHTOTALS': {
        const want = new Map<QueryItem, string>();
        for (let i = 1; i + 1 < A.length; i += 2) {
          const a = A[i];
          const it = a.k === 'col' ? this.refs.get(a.col.toLowerCase()) : undefined;
          if (!it || it.measure) throw new DaxError(`${n.fn}: atteso un campo di raggruppamento dell'oggetto visivo, seguito dal valore`);
          want.set(it, keyOf(s(i + 1)));
        }
        let L = env.c.L;
        if (n.fn === 'LOOKUPWITHTOTALS') {
          const rk = this.rowDims.map((_d, i) => i).filter((i) => want.has(this.rowDims[i]));
          const ck = this.colDims.map((_d, i) => i).filter((i) => want.has(this.colDims[i]));
          L = this.level(rk, ck);
        }
        const c = this.match(env.c, L, (d) => want.get(d))[0];
        return c ? at(c, A[0]) : null;
      }
      case 'SUMX': case 'AVERAGEX': case 'MINX': case 'MAXX': case 'COUNTX': {
        const set = this.cells(A[0], env);
        const vals = set.map((c) => num(at(c, A[1]))).filter((x): x is number => x !== null);
        if (!vals.length) return null;
        if (n.fn === 'SUMX') return vals.reduce((a, b) => a + b, 0);
        if (n.fn === 'AVERAGEX') return vals.reduce((a, b) => a + b, 0) / vals.length;
        if (n.fn === 'MINX') return Math.min(...vals);
        if (n.fn === 'MAXX') return Math.max(...vals);
        return vals.length;
      }
      case 'SUM': case 'AVERAGE': case 'COUNT': case 'COUNTA': case 'COUNTROWS': return this.agg(n.fn, A[0], env);
      case 'MIN': case 'MAX':
        if (A.length === 2) { const x = num(s(0)), y = num(s(1)); return x === null ? y : y === null ? x : n.fn === 'MIN' ? Math.min(x, y) : Math.max(x, y); }
        return this.agg(n.fn, A[0], env);
      case 'IF': case 'IF.EAGER': return s(0) ? s(1) : opt(2) ? s(2) : null;
      case 'SWITCH': {
        const v = s(0);
        let i = 1;
        for (; i + 1 < A.length; i += 2) { const w = s(i); if (A[0].k === 'bool' && A[0].v ? !!w : keyOf(w) === keyOf(v)) return s(i + 1); }
        return i < A.length ? s(i) : null;
      }
      case 'DIVIDE': { const x = num(s(0)), y = num(s(1)); return x === null || y === null || y === 0 ? (opt(2) ? s(2) : null) : x / y; }
      case 'BLANK': return null;
      case 'ISBLANK': return s(0) === null;
      case 'COALESCE': { for (let i = 0; i < A.length; i++) { const v = s(i); if (v !== null) return v; } return null; }
      case 'AND': return !!s(0) && !!s(1);
      case 'OR': return !!s(0) || !!s(1);
      case 'NOT': return !s(0);
      case 'TRUE': return true;
      case 'FALSE': return false;
      case 'ABS': { const x = num(s(0)); return x === null ? null : Math.abs(x); }
      case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
        const x = num(s(0)); if (x === null) return null;
        const p = 10 ** (opt(1) ? num(s(1)) ?? 0 : 0);
        return n.fn === 'ROUND' ? Math.round(x * p) / p : n.fn === 'ROUNDUP' ? Math.sign(x) * Math.ceil(Math.abs(x) * p) / p : Math.trunc(x * p) / p;
      }
      case 'INT': { const x = num(s(0)); return x === null ? null : Math.floor(x); }
      case 'SQRT': { const x = num(s(0)); return x === null ? null : Math.sqrt(x); }
      case 'POWER': { const x = num(s(0)), y = num(s(1)); return x === null || y === null ? null : x ** y; }
      case 'EXP': { const x = num(s(0)); return x === null ? null : Math.exp(x); }
      case 'LN': { const x = num(s(0)); return x === null ? null : Math.log(x); }
      case 'LOG10': { const x = num(s(0)); return x === null ? null : Math.log10(x); }
      case 'SIGN': { const x = num(s(0)); return x === null ? null : Math.sign(x); }
      case 'MOD': { const x = num(s(0)), y = num(s(1)); return x === null || y === null || !y ? null : x - y * Math.floor(x / y); }
      case 'CONCATENATE': return `${s(0) ?? ''}${s(1) ?? ''}`;
      case 'FORMAT': { const v = s(0); return v === null ? null : fmtWith(v, String(s(1) ?? '')); }
      case 'LEN': { const v = s(0); return v === null ? null : String(v).length; }
      case 'UPPER': { const v = s(0); return v === null ? null : String(v).toUpperCase(); }
      case 'LOWER': { const v = s(0); return v === null ? null : String(v).toLowerCase(); }
      case 'VALUE': return num(s(0));
    }
    throw new DaxError(`Funzione non supportata nei calcoli visivi: ${n.fn}`);
  }
}

/** Names visual calculations use for the fields of a visual (as shown in the field wells). */
export function fieldRefs(items: QueryItem[]): Map<string, QueryItem> {
  const m = new Map<string, QueryItem>();
  for (const i of items) {
    if (i.well === CF_WELL) continue;
    const label = refLabel(i.field).toLowerCase();
    if (!m.has(label)) m.set(label, i);
    if (!m.has(i.field.column.toLowerCase())) m.set(i.field.column.toLowerCase(), i);
  }
  return m;
}

/** Power BI visual calculation templates (Modelli). `{f}` = the first value field of the visual. */
export const CALC_TEMPLATES: { label: string; name: string; text: string; format?: string }[] = [
  { label: 'Somma parziale', name: 'Somma parziale', text: 'RUNNINGSUM([{f}])' },
  { label: 'Media mobile', name: 'Media mobile', text: 'MOVINGAVERAGE([{f}], 3)' },
  { label: "Percentuale dell'elemento padre", name: "% dell'elemento padre", text: 'DIVIDE([{f}], COLLAPSE([{f}], ROWS))', format: '0.00%' },
  { label: 'Percentuale del totale complessivo', name: '% del totale complessivo', text: 'DIVIDE([{f}], COLLAPSEALL([{f}], ROWS))', format: '0.00%' },
  { label: 'Media degli elementi figlio', name: 'Media degli elementi figlio', text: 'EXPAND(AVERAGE([{f}]), ROWS)' },
  { label: 'Rispetto al precedente', name: 'Rispetto al precedente', text: '[{f}] - PREVIOUS([{f}])' },
  { label: 'Rispetto al successivo', name: 'Rispetto al successivo', text: '[{f}] - NEXT([{f}])' },
  { label: 'Rispetto al primo', name: 'Rispetto al primo', text: '[{f}] - FIRST([{f}])' },
  { label: "Rispetto all'ultimo", name: "Rispetto all'ultimo", text: '[{f}] - LAST([{f}])' },
];

export const TOTAL_LABEL: Record<import('../types').CustomTotal, string> = { sum: 'Somma', avg: 'Media', min: 'Minimo', max: 'Massimo', count: 'Conteggio', first: 'Primo', last: 'Ultimo', none: 'Nessuno' };

/** Totali personalizzati: total rows recomputed from the cells they sum up (table and matrix). */
export function customTotals(v: Visual, items: QueryItem[], d: { rows: Record<string, any>[]; totals?: Record<string, any>[]; colTotals?: Record<string, any>[]; rowTotals?: Record<string, any>[] }) {
  const custom = items.filter((i) => i.measure && i.field.total);
  if (!custom.length || (v.type !== 'table' && v.type !== 'matrix')) return d;
  const { rows: rd, cols: cd } = axesOf(v, items);
  const key = (r: Record<string, any>, dims: QueryItem[]) => dims.map((x) => keyOf(r[x.alias])).join('\u0001');
  const agg = (t: string, xs: unknown[]): unknown => {
    const ns = xs.map((x) => (x === null || x === undefined ? null : Number(x))).filter((x): x is number => x !== null && Number.isFinite(x));
    switch (t) {
      case 'sum': return ns.length ? ns.reduce((a, b) => a + b, 0) : null;
      case 'avg': return ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : null;
      case 'min': return ns.length ? Math.min(...ns) : null;
      case 'max': return ns.length ? Math.max(...ns) : null;
      case 'count': return ns.length || null;
      case 'first': return xs[0] ?? null;
      case 'last': return xs[xs.length - 1] ?? null;
      default: return null;
    }
  };
  const out = { ...d, totals: d.totals?.map((r) => ({ ...r })), colTotals: d.colTotals?.map((r) => ({ ...r })), rowTotals: d.rowTotals?.map((r) => ({ ...r })) };
  for (const it of custom) {
    const t = it.field.total!;
    for (const r of out.totals ?? []) r[it.alias] = agg(t, d.rows.map((x) => x[it.alias]));
    for (const r of out.colTotals ?? []) { const k = key(r, cd); r[it.alias] = agg(t, d.rows.filter((x) => key(x, cd) === k).map((x) => x[it.alias])); }
    for (const r of out.rowTotals ?? []) { const k = key(r, rd); r[it.alias] = agg(t, d.rows.filter((x) => key(x, rd) === k).map((x) => x[it.alias])); }
    for (const r of [...(out.totals ?? []), ...(out.colTotals ?? []), ...(out.rowTotals ?? [])]) delete r[it.alias + '__f'];
  }
  return out;
}
