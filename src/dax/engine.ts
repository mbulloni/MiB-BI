/**
 * DAX → SQL compiler built on an explicit filter context.
 *
 * A filter context is a list of filters, each a SQL predicate on the rows of one table
 * (a column filter fixes some columns, a table filter fixes whole rows). An aggregation
 * over table T becomes a correlated subquery on T whose WHERE clause applies every filter:
 * filters on T directly, filters on other tables through semi-joins along the active
 * relationships that let them reach T (one → many, or both ways with "Entrambe").
 *
 * CALCULATE builds a new context: context transition turns row contexts into filters,
 * ALL/REMOVEFILTERS drop filters, filter arguments replace filters on the same columns
 * (unless KEEPFILTERS). Table filters follow DAX "expanded tables": a filter on a fact
 * table also filters the dimensions it points to. Iterators (SUMX, FILTER, RANKX…) become
 * subqueries with a row alias; measures referenced inside them trigger context transition.
 */
import type { CalcGroup, CalendarDef, DaxFunction, Measure, Relationship, TableMeta, TimeUnit } from '../types';
import { edgesFrom, filterSql, type Edge } from '../query';
import { dayNames, isDate, isNumeric, monthNames } from '../format';
import { DaxError, parse, parseFunction, parseQuery, type Node, type UdfDef } from './parse';
import { DAX_FUNCTIONS } from './functions';

const DAX_FUNCTION_NAMES = new Set(DAX_FUNCTIONS.map((f) => f.name));

export { DaxError };

/** `dateTables`: tables marked as date table (table → date column); `calcGroups`: calculation groups;
 *  `user`: USERPRINCIPALNAME() (Visualizza come › Altro utente). */
export interface Model { tables: TableMeta[]; rels: Relationship[]; measures: Measure[]; dateTables?: Record<string, string>; calcGroups?: CalcGroup[]; user?: string;
  functions?: DaxFunction[]; calendars?: CalendarDef[]; aggregations?: import('../types').AggTable[]; }

const qi = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const ql = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const eqi = (a: string | undefined, b: string | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

type Pred = (alias: string) => string;
/** cols === null: whole-row (table) filter. `tag` tells visual grouping filters from the rest (ALLSELECTED, ISINSCOPE). */
interface Filt { table: string; cols: string[] | null; pred: Pred; tag: 'outer' | 'group' | 'calc'; }
interface FCtx { filters: Filt[]; rels: Relationship[]; }
/** Output column of a table expression; `table`/`col` = lineage to a model column. */
interface OutCol { name: string; table?: string; col?: string; }
/** Table expression: SQL plus columns; `base` = rows of a model table, exposed with `__rowid`. */
interface TV { sql: string; cols: OutCol[]; base?: string; }
interface RowCtx { alias: string; t: TV; rowid?: string; }
type Val = { s: string } | { t: TV };
interface Env { fc: FCtx; rows: RowCtx[]; vars: Map<string, Val>; home: string; }

/** A time-intelligence result as a filter: `pred` on rows of `table`; `cols` = the calendar columns it replaces (calendars). */
interface TiFilter { table: string; col?: string; cols?: string[]; pred: Pred; overrides: (f: Filt) => boolean; }

type Mod =
  | { kind: 'remove'; match: (f: Filt) => boolean }
  | { kind: 'set'; filters: Filt[]; overrides: (f: Filt) => boolean; keep?: boolean }
  | { kind: 'rel'; apply: (rels: Relationship[]) => Relationship[] };

const TABLE_FNS = new Set([
  'FILTER', 'ALL', 'ALLNOBLANKROW', 'ALLSELECTED', 'ALLEXCEPT', 'VALUES', 'DISTINCT', 'CALCULATETABLE', 'RELATEDTABLE', 'TOPN',
  'ADDCOLUMNS', 'SELECTCOLUMNS', 'SUMMARIZE', 'SUMMARIZECOLUMNS', 'CALENDAR', 'CALENDARAUTO', 'GENERATESERIES', 'UNION', 'CROSSJOIN',
  'EXCEPT', 'INTERSECT', 'ROW', 'TREATAS', 'DATESYTD', 'DATESQTD', 'DATESMTD', 'SAMEPERIODLASTYEAR', 'DATEADD', 'PARALLELPERIOD',
  'PREVIOUSDAY', 'PREVIOUSMONTH', 'PREVIOUSQUARTER', 'PREVIOUSYEAR', 'NEXTDAY', 'NEXTMONTH', 'NEXTQUARTER', 'NEXTYEAR', 'DATESBETWEEN', 'DATESINPERIOD',
  'DATESWTD', 'PREVIOUSWEEK', 'NEXTWEEK', 'TABLEOF',
]);
/** Time-intelligence functions that return a set of dates (usable as CALCULATE filters). */
const TI_FNS = new Set(['DATESYTD', 'DATESQTD', 'DATESMTD', 'SAMEPERIODLASTYEAR', 'DATEADD', 'PARALLELPERIOD', 'PREVIOUSDAY', 'PREVIOUSMONTH',
  'PREVIOUSQUARTER', 'PREVIOUSYEAR', 'NEXTDAY', 'NEXTMONTH', 'NEXTQUARTER', 'NEXTYEAR', 'DATESBETWEEN', 'DATESINPERIOD',
  'FIRSTDATE', 'LASTDATE', 'STARTOFMONTH', 'STARTOFQUARTER', 'STARTOFYEAR', 'ENDOFMONTH', 'ENDOFQUARTER', 'ENDOFYEAR',
  'DATESWTD', 'PREVIOUSWEEK', 'NEXTWEEK', 'STARTOFWEEK', 'ENDOFWEEK']);
/** Week-based functions: only with a calendar. */
const WEEK_FNS = new Set(['DATESWTD', 'PREVIOUSWEEK', 'NEXTWEEK', 'STARTOFWEEK', 'ENDOFWEEK']);
/** UDF scalar subtypes converted on the way in (CONVERT type names). */
const CAST_SUB: Record<string, string> = { INT64: 'INTEGER', DOUBLE: 'DOUBLE', DECIMAL: 'CURRENCY', STRING: 'STRING', BOOLEAN: 'BOOLEAN', DATETIME: 'DATETIME' };
/** Complete calendar categories and the category sets that identify them (Power BI "period uniqueness"); `*` = another complete category. */
const CAL_KEYS: Record<string, string[][]> = {
  year: [['year']],
  semester: [['semester'], ['year', 'semesterOfYear']],
  quarter: [['quarter'], ['year', 'quarterOfYear'], ['semester*', 'quarterOfSemester']],
  month: [['month'], ['year', 'monthOfYear'], ['quarter*', 'monthOfQuarter'], ['semester*', 'monthOfSemester']],
  week: [['week'], ['year', 'weekOfYear'], ['month*', 'weekOfMonth'], ['quarter*', 'weekOfQuarter'], ['semester*', 'weekOfSemester']],
  date: [['date'], ['year', 'dayOfYear'], ['month*', 'dayOfMonth'], ['week*', 'dayOfWeek'], ['quarter*', 'dayOfQuarter'], ['semester*', 'dayOfSemester']],
};
const CAL_UNIT_IT: Record<string, string> = { year: 'Anno', semester: 'Semestre', quarter: 'Trimestre', month: 'Mese', week: 'Settimana', date: 'Data' };
const TYPES: Record<string, string[]> = {
  string: ['VARCHAR'],
  int: ['TINYINT', 'SMALLINT', 'INTEGER', 'BIGINT', 'HUGEINT', 'UTINYINT', 'USMALLINT', 'UINTEGER', 'UBIGINT'],
  double: ['FLOAT', 'DOUBLE'],
  decimal: ['DECIMAL'],
  bool: ['BOOLEAN'],
  date: ['DATE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE', 'TIMESTAMP_NS', 'TIMESTAMP_MS', 'TIMESTAMP_S'],
};
const CMP: Record<string, string> = { '=': '=', '==': '=', '<>': '<>', '<': '<', '>': '>', '<=': '<=', '>=': '>=' };
const sqlList = (xs: string[]) => `[${xs.map(ql).join(', ')}]`;
const blank = (n?: Node) => !n || (n.k === 'call' && n.fn === 'BLANK' && !n.args.length);

class Compiler {
  private n = 0;
  private stack: string[] = [];
  /** Measure values already computed under a filter context, shared instead of re-inlined. */
  private frames: { fc: FCtx; binds: { key: string; alias: string; sql: string }[] }[] = [];
  private parsed = new Map<string, Node>();
  /** Measures defined by a DAX query (DEFINE MEASURE), shadowing the model's. */
  defined = new Map<string, { table: string; name: string; node: Node }>();
  /** "group|measure" being transformed: that measure is not transformed again by that group (no infinite recursion). */
  private applying = new Set<string>();
  /** SELECTEDMEASURE() of the calculation items being compiled (innermost last). */
  private selected: { name: string; sql: (env: Env) => string }[] = [];
  /** User-defined functions by upper-case name: the model's, then DEFINE FUNCTION of a DAX query. */
  udfs = new Map<string, { name: string; def: () => UdfDef; checked?: boolean }>();

  constructor(public m: Model) {
    for (const f of m.functions ?? []) {
      let d: UdfDef | undefined;
      this.udfs.set(f.name.toUpperCase(), {
        name: f.name,
        def: () => {
          try { return d ??= parseFunction(f.expression); }
          catch (e) { throw e instanceof DaxError ? new DaxError(`Funzione ${f.name}: ${e.message}`) : e; }
        },
      });
    }
  }

  A(p = 'a') { return `${p}${++this.n}`; }

  /**
   * Evaluates SQL expressions once and passes their values to `fn` (a derived table instead of
   * repeating them): DAX code like IF([M] > 0, [M]) would otherwise duplicate [M]'s subqueries.
   */
  once(exprs: string[], fn: (refs: string[]) => string): string {
    const simple = (e: string) => /^(-?[\d.]+|'(?:[^']|'')*'|NULL|TRUE|FALSE|[A-Za-z_]\w*\.("(?:[^"]|"")*"|\w+))$/.test(e);
    if (exprs.every(simple)) return fn(exprs);
    const b = this.A('b');
    return `(SELECT ${fn(exprs.map((_e, i) => `${b}.x${i}`))} FROM (SELECT ${exprs.map((e, i) => `${e} AS x${i}`).join(', ')}) ${b})`;
  }

  /** Compiles `fn` with a sharing frame for filter context `fc`, then binds the shared values. */
  framed(fc: FCtx, fn: () => string): string {
    const frame = { fc, binds: [] as { key: string; alias: string; sql: string }[] };
    this.frames.push(frame);
    let body: string;
    try { body = fn(); } finally { this.frames.pop(); }
    if (!frame.binds.length) return body;
    return `(SELECT ${body} FROM ${frame.binds.map((b) => `(SELECT ${b.sql} AS x) ${b.alias}`).join(', ')})`;
  }

  /* ------------------------------ model lookup ------------------------------ */

  table(name: string): TableMeta {
    const t = this.m.tables.find((x) => eqi(x.name, name));
    if (!t) throw new DaxError(`Tabella non trovata: '${name}'`);
    return t;
  }

  /** Resolves 'T'[c] (or bare [c]: home table first, then the only table with that column). */
  col(n: { table?: string; col: string }, env: Env): { table: string; col: string; type: string } {
    if (n.table) {
      const t = this.table(n.table);
      const c = t.columns.find((x) => eqi(x.name, n.col));
      if (!c) throw new DaxError(`Colonna non trovata: '${t.name}'[${n.col}]`);
      return { table: t.name, col: c.name, type: c.type };
    }
    const home = this.m.tables.find((x) => eqi(x.name, env.home));
    const hc = home?.columns.find((x) => eqi(x.name, n.col));
    if (hc) return { table: home!.name, col: hc.name, type: hc.type };
    const hits = this.m.tables.flatMap((t) => t.columns.filter((c) => eqi(c.name, n.col)).map((c) => ({ table: t.name, col: c.name, type: c.type })));
    if (hits.length === 1) return hits[0];
    throw new DaxError(hits.length ? `Colonna [${n.col}] ambigua: specificare la tabella ('Tabella'[${n.col}])` : `Colonna o misura non trovata: [${n.col}]`);
  }

  measure(name: string): { table: string; name: string; node: () => Node } | undefined {
    const d = this.defined.get(name.toLowerCase());
    if (d) return { table: d.table, name: d.name, node: () => d.node };
    const m = this.m.measures.find((x) => eqi(x.name, name));
    if (!m) return undefined;
    return {
      table: m.table, name: m.name,
      node: () => {
        let p = this.parsed.get(m.name);
        if (!p) { p = parse(m.expression); this.parsed.set(m.name, p); }
        return p;
      },
    };
  }

  /* --------------------------- user-defined functions --------------------------- */

  /**
   * A call of a user-defined function rewritten as the function body: EXPR parameters (references,
   * `expr`) become the argument expressions, evaluated where the body uses them; VAL parameters are
   * bound once, in the caller's context, like VARs. Local VARs get unique names (no capture).
   */
  expandUdf(n: Extract<Node, { k: 'call' }>): Node | null {
    const u = this.udfs.get(n.fn);
    if (!u) return null;
    const def = u.def();
    if (!u.checked) { this.noRecursion(n.fn, []); u.checked = true; }
    if (n.args.length > def.params.length) throw new DaxError(`${u.name}: troppi argomenti (al massimo ${def.params.length})`);
    const pre = `__F${++this.n}_`;
    const subst = new Map<string, Node>();
    const vals: [string, Node][] = [];
    def.params.forEach((p, i) => {
      let a: Node | undefined = n.args[i];
      if ((!a || blank(a)) && p.def) a = p.def;
      if (!a) throw new DaxError(`${u.name}: manca l'argomento ${p.name}`);
      if (p.mode === 'expr') { subst.set(p.name, a); return; }
      const conv = p.subtype && CAST_SUB[p.subtype];
      vals.push([pre + p.name, conv ? { k: 'call', fn: 'CONVERT', args: [a, { k: 'tbl', name: conv }] } : a]);
      subst.set(p.name, { k: 'var', name: pre + p.name });
    });
    const locals = new Set<string>();
    const collect = (x: Node) => {
      if (x.k === 'let') { x.vars.forEach(([nm, v]) => { locals.add(nm.toUpperCase()); collect(v); }); collect(x.body); }
      else if (x.k === 'call') x.args.forEach(collect);
      else if (x.k === 'bin') { collect(x.a); collect(x.b); }
      else if (x.k === 'neg') collect(x.a);
      else if (x.k === 'list') x.rows.forEach((r) => r.forEach(collect));
    };
    collect(def.body);
    const go = (x: Node): Node => {
      switch (x.k) {
        case 'var': return subst.get(x.name) ?? (locals.has(x.name) ? { k: 'var', name: pre + x.name } : x);
        case 'let': return { k: 'let', vars: x.vars.map(([nm, v]) => [pre + nm.toUpperCase(), go(v)] as [string, Node]), body: go(x.body) };
        case 'call': return { ...x, args: x.args.map(go) };
        case 'bin': return { ...x, a: go(x.a), b: go(x.b) };
        case 'neg': return { ...x, a: go(x.a) };
        case 'list': return { ...x, rows: x.rows.map((r) => r.map(go)) };
        default: return x;
      }
    };
    const body = go(def.body);
    return vals.length ? { k: 'let', vars: vals, body } : body;
  }

  /** Power BI rejects recursion and mutual recursion between user-defined functions. */
  private noRecursion(name: string, path: string[]) {
    const label = (x: string) => this.udfs.get(x)?.name ?? x;
    if (path.includes(name)) throw new DaxError(`La ricorsione tra funzioni non è supportata: ${[...path, name].map(label).join(' → ')}`);
    const d = this.udfs.get(name)?.def();
    if (!d) return;
    const calls = new Set<string>();
    const walk = (x: Node) => {
      if (x.k === 'call') { if (this.udfs.has(x.fn)) calls.add(x.fn); x.args.forEach(walk); }
      else if (x.k === 'bin') { walk(x.a); walk(x.b); }
      else if (x.k === 'neg') walk(x.a);
      else if (x.k === 'let') { x.vars.forEach(([, v]) => walk(v)); walk(x.body); }
      else if (x.k === 'list') x.rows.forEach((r) => r.forEach(walk));
    };
    walk(d.body);
    d.params.forEach((p) => p.def && walk(p.def));
    for (const c of calls) this.noRecursion(c, [...path, name]);
  }

  /** TRUE when the (non-blank) value has one of the DuckDB types of `kind` (ISSTRING, ISINT64…). */
  private typeIs(x: string, ...kinds: (keyof typeof TYPES)[]): string {
    return this.once([x], ([v]) => `(${v} IS NOT NULL AND regexp_replace(typeof(${v}), '\\(.*$', '') IN (${kinds.flatMap((k) => TYPES[k]).map(ql).join(', ')}))`);
  }

  /* --------------------------- relationships/graph --------------------------- */

  /** Shortest chain of relationships along which a filter on `to` reaches `from`. */
  path(rels: Relationship[], from: string, to: string): Edge[] | null {
    if (from === to) return [];
    const prev = new Map<string, { node: string; edge: Edge }>();
    const seen = new Set([from]);
    const queue = [from];
    while (queue.length) {
      const t = queue.shift()!;
      for (const e of edgesFrom(rels, t)) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        prev.set(e.to, { node: t, edge: e });
        if (e.to === to) {
          const out: Edge[] = [];
          for (let n = to; n !== from; n = prev.get(n)!.node) out.unshift(prev.get(n)!.edge);
          return out;
        }
        queue.push(e.to);
      }
    }
    return null;
  }

  /** DAX expanded table: T plus the tables reachable many → one (and 1:1), with the path to each. */
  expanded(rels: Relationship[], T: string): Map<string, Edge[]> {
    const out = new Map<string, Edge[]>([[T, []]]);
    const queue = [T];
    while (queue.length) {
      const t = queue.shift()!;
      for (const r of rels) {
        if (!r.active) continue;
        let e: Edge | null = null;
        if (r.fromTable === t && r.cardinality !== 'manyToMany') e = { to: r.toTable, parentCol: r.fromColumn, childCol: r.toColumn, fanout: false };
        else if (r.toTable === t && r.cardinality === 'oneToOne') e = { to: r.fromTable, parentCol: r.toColumn, childCol: r.fromColumn, fanout: false };
        if (e && !out.has(e.to)) { out.set(e.to, [...out.get(t)!, e]); queue.push(e.to); }
      }
    }
    return out;
  }

  /** `alias` row of `path[0]`'s source passes when the chain reaches a row of the last table satisfying `p`. */
  semi(path: Edge[], alias: string, p: Pred): string {
    const [e, ...rest] = path;
    const b = this.A('s');
    return `${alias}.${qi(e.parentCol)} IN (SELECT ${b}.${qi(e.childCol)} FROM ${qi(e.to)} ${b} WHERE ${rest.length ? this.semi(rest, b, p) : p(b)})`;
  }

  /** Reverse of semi: rows of the last table of `path` (starting at T) related to rows of T satisfying `p`. */
  private rsemi(T: string, path: Edge[], alias: string, p: Pred): string {
    if (!path.length) return p(alias);
    const last = path[path.length - 1];
    const prev = path.length > 1 ? path[path.length - 2].to : T;
    const y = this.A('s');
    return `${alias}.${qi(last.childCol)} IN (SELECT ${y}.${qi(last.parentCol)} FROM ${qi(prev)} ${y} WHERE ${this.rsemi(T, path.slice(0, -1), y, p)})`;
  }

  /** WHERE clause applying a filter context to rows of `table` (alias `a`). */
  preds(table: string, a: string, fc: FCtx): string {
    const byTable = new Map<string, Filt[]>();
    for (const f of fc.filters) byTable.set(f.table, [...(byTable.get(f.table) ?? []), f]);
    const parts: string[] = [];
    for (const [F, fs] of byTable) {
      const p: Pred = (al) => fs.map((f) => f.pred(al)).join(' AND ');
      if (F === table) parts.push(p(a));
      else {
        const path = this.path(fc.rels, table, F);
        if (path) parts.push(this.semi(path, a, p));
      }
    }
    return parts.join(' AND ');
  }

  rowsOf(table: string, fc: FCtx | null): TV {
    const t = this.table(table);
    const a = this.A();
    const w = fc ? this.preds(t.name, a, fc) : '';
    return {
      sql: `SELECT ${a}.*, ${a}.rowid AS __rowid FROM ${qi(t.name)} ${a}${w ? ` WHERE ${w}` : ''}`,
      cols: t.columns.map((c) => ({ name: c.name, table: t.name, col: c.name })),
      base: t.name,
    };
  }

  /** Filters for "these rows of T" (table filter) plus the dimensions they imply (expanded table). */
  tableFilters(rels: Relationship[], T: string, p: Pred): { filters: Filt[]; overrides: (f: Filt) => boolean } {
    const exp = this.expanded(rels, T);
    const filters: Filt[] = [{ table: T, cols: null, pred: p, tag: 'calc' }];
    for (const [D, path] of exp) if (D !== T) filters.push({ table: D, cols: null, pred: (d) => this.rsemi(T, path, d, p), tag: 'calc' });
    return { filters, overrides: (f) => exp.has(f.table) };
  }

  /* --------------------------------- CALCULATE -------------------------------- */

  transition(fc: FCtx, rows: RowCtx[]): FCtx {
    let filters = [...fc.filters];
    for (const r of rows) {
      if (r.t.base && r.rowid) {
        const tf = this.tableFilters(fc.rels, r.t.base, (z) => `${z}.rowid = ${r.rowid}`);
        filters = [...filters.filter((f) => !tf.overrides(f)), ...tf.filters];
      } else {
        for (const c of r.t.cols) {
          if (!c.table || !c.col) continue;
          filters = filters.filter((f) => !(f.table === c.table && f.cols?.includes(c.col!)));
          filters.push({ table: c.table, cols: [c.col], pred: (a) => `${a}.${qi(c.col!)} IS NOT DISTINCT FROM ${r.alias}.${qi(c.name)}`, tag: 'calc' });
        }
      }
    }
    return { ...fc, filters };
  }

  calculate(env: Env, args: Node[], transition = true): Env {
    const mods = args.filter((a) => !blank(a)).map((a) => this.filterMod(a, env));
    let fc: FCtx = { filters: [...env.fc.filters], rels: env.fc.rels };
    if (transition && env.rows.length) fc = this.transition(fc, env.rows);
    for (const m of mods) if (m.kind === 'rel') fc.rels = m.apply(fc.rels);
    for (const m of mods) if (m.kind === 'remove') fc.filters = fc.filters.filter((f) => !m.match(f));
    for (const m of mods) {
      if (m.kind !== 'set') continue;
      if (!m.keep) fc.filters = fc.filters.filter((f) => !m.overrides(f));
      fc.filters.push(...m.filters);
    }
    // After context transition the row contexts are no longer active.
    return { ...env, fc, rows: [] };
  }

  private colArgs(args: Node[], env: Env) {
    return args.map((a) => {
      if (a.k !== 'col') throw new DaxError('Argomento atteso: un riferimento a colonna');
      return this.col(a, env);
    });
  }

  /** A CALCULATE / CALCULATETABLE filter argument. */
  filterMod(n: Node, env: Env): Mod {
    if (n.k === 'call' && this.udfs.has(n.fn)) return this.filterMod(this.expandUdf(n)!, env);
    if (n.k === 'call') {
      const A = n.args;
      switch (n.fn) {
        case 'KEEPFILTERS': {
          const m = this.filterMod(A[0], env);
          return m.kind === 'set' ? { ...m, keep: true } : m;
        }
        case 'ALL': case 'REMOVEFILTERS': case 'ALLNOBLANKROW': {
          if (!A.length || blank(A[0])) return { kind: 'remove', match: () => true };
          if (A[0].k === 'tbl') {
            const exp = this.expanded(env.fc.rels, this.table(A[0].name).name);
            return { kind: 'remove', match: (f) => exp.has(f.table) };
          }
          const cols = this.colArgs(A, env);
          return { kind: 'remove', match: (f) => cols.some((c) => f.table === c.table && !!f.cols?.includes(c.col)) };
        }
        case 'ALLSELECTED': {
          if (!A.length || blank(A[0])) return { kind: 'remove', match: (f) => f.tag === 'group' };
          if (A[0].k === 'tbl') {
            const exp = this.expanded(env.fc.rels, this.table(A[0].name).name);
            return { kind: 'remove', match: (f) => f.tag === 'group' && exp.has(f.table) };
          }
          const cols = this.colArgs(A, env);
          return { kind: 'remove', match: (f) => f.tag === 'group' && cols.some((c) => f.table === c.table && !!f.cols?.includes(c.col)) };
        }
        case 'ALLEXCEPT': {
          if (A[0]?.k !== 'tbl') throw new DaxError('ALLEXCEPT: il primo argomento deve essere una tabella');
          const exp = this.expanded(env.fc.rels, this.table(A[0].name).name);
          const keep = this.colArgs(A.slice(1), env);
          return { kind: 'remove', match: (f) => exp.has(f.table) && !(f.cols && f.cols.every((c) => keep.some((k) => k.table === f.table && k.col === c))) };
        }
        case 'USERELATIONSHIP': case 'CROSSFILTER': {
          const [c1, c2] = this.colArgs(A.slice(0, 2), env);
          const dir = n.fn === 'CROSSFILTER' ? (A[2]?.k === 'tbl' ? A[2].name.toUpperCase() : A[2]?.k === 'num' ? ['NONE', 'ONEWAY', 'BOTH'][+A[2].v] : 'BOTH') : '';
          const same = (r: Relationship) => (r.fromTable === c1.table && r.fromColumn === c1.col && r.toTable === c2.table && r.toColumn === c2.col)
            || (r.fromTable === c2.table && r.fromColumn === c2.col && r.toTable === c1.table && r.toColumn === c1.col);
          if (!this.m.rels.some(same)) throw new DaxError(`${n.fn}: nessuna relazione tra ${c1.table}[${c1.col}] e ${c2.table}[${c2.col}]`);
          const pair = (r: Relationship) => (r.fromTable === c1.table && r.toTable === c2.table) || (r.fromTable === c2.table && r.toTable === c1.table);
          return {
            kind: 'rel',
            apply: (rels) => rels.map((r) => {
              if (n.fn === 'USERELATIONSHIP') return same(r) ? { ...r, active: true } : pair(r) ? { ...r, active: false } : r;
              if (!same(r)) return r;
              if (dir === 'NONE') return { ...r, active: false };
              return { ...r, crossFilter: dir === 'BOTH' ? 'both' : 'single' };
            }),
          };
        }
      }
      if (TI_FNS.has(n.fn)) {
        const ti = this.ti(n, env);
        return { kind: 'set', filters: [{ table: ti.table, cols: ti.cols ?? [ti.col!], pred: ti.pred, tag: 'calc' }], overrides: ti.overrides };
      }
    }
    if (this.isBool(n)) return this.boolMod(n, env);
    if (this.isTable(n, env)) return this.tableMod(this.tv(n, env), env);
    throw new DaxError('Argomento di filtro non valido: usare una condizione (es. T[Col] = "x") o una tabella (FILTER, ALL, VALUES…)');
  }

  private isBool(n: Node): boolean {
    if (n.k === 'let') return this.isBool(n.body);
    if (n.k === 'bin') return n.op in CMP || n.op === 'IN' || n.op === '&&' || n.op === '||';
    if (n.k === 'call') return ['NOT', 'AND', 'OR', 'ISBLANK', 'CONTAINSSTRING', 'CONTAINSSTRINGEXACT'].includes(n.fn);
    return n.k === 'bool';
  }

  /** Boolean filter = FILTER(ALL(columns used), condition): replaces filters on those columns. */
  private boolMod(n: Node, env: Env): Mod {
    const used = new Map<string, { table: string; col: string }>();
    const walk = (x: Node) => {
      if (x.k === 'col' && !this.measure(x.col)) { const c = this.col(x, env); used.set(`${c.table}\u0001${c.col}`, c); }
      if (x.k === 'call' && (x.fn === 'CALCULATE' || TABLE_FNS.has(x.fn) || ['SUM', 'MAX', 'MIN', 'AVERAGE', 'COUNT', 'COUNTROWS', 'DISTINCTCOUNT', 'SELECTEDVALUE'].includes(x.fn) || x.fn.endsWith('X'))) return;
      if (x.k === 'call') x.args.forEach(walk);
      if (x.k === 'bin') { walk(x.a); walk(x.b); }
      if (x.k === 'neg') walk(x.a);
      if (x.k === 'let') { x.vars.forEach(([, v]) => walk(v)); walk(x.body); }
    };
    walk(n);
    const cols = [...used.values()];
    const tables = [...new Set(cols.map((c) => c.table))];
    if (tables.length !== 1) throw new DaxError(tables.length ? 'Una condizione di filtro può usare colonne di una sola tabella' : 'La condizione di filtro non usa nessuna colonna');
    const T = tables[0];
    const ph = '\u0002';
    const tv: TV = { sql: '', cols: cols.map((c) => ({ name: c.col, table: T, col: c.col })) };
    const sql = this.scalar(n, { ...env, rows: [...env.rows, { alias: ph, t: tv }] });
    return {
      kind: 'set',
      filters: [{ table: T, cols: cols.map((c) => c.col), pred: (a) => `coalesce(${sql.split(ph).join(a)}, false)`, tag: 'calc' }],
      overrides: (f) => f.table === T && !!f.cols?.some((c) => cols.some((k) => k.col === c)),
    };
  }

  private tableMod(tv: TV, env: Env): Mod {
    if (tv.base) {
      const sql = tv.sql;
      const tf = this.tableFilters(env.fc.rels, tv.base, (z) => { const v = this.A('v'); return `${z}.rowid IN (SELECT ${v}.__rowid FROM (${sql}) ${v})`; });
      return { kind: 'set', filters: tf.filters, overrides: tf.overrides };
    }
    const byTable = new Map<string, OutCol[]>();
    for (const c of tv.cols) if (c.table && c.col) byTable.set(c.table, [...(byTable.get(c.table) ?? []), c]);
    if (!byTable.size) throw new DaxError('La tabella usata come filtro non ha colonne collegate al modello (usare TREATAS)');
    const filters: Filt[] = [...byTable].map(([T, cs]) => ({
      table: T, cols: cs.map((c) => c.col!), tag: 'calc',
      pred: (a) => {
        const v = this.A('v');
        return `EXISTS (SELECT 1 FROM (${tv.sql}) ${v} WHERE ${cs.map((c) => `${v}.${qi(c.name)} IS NOT DISTINCT FROM ${a}.${qi(c.col!)}`).join(' AND ')})`;
      },
    }));
    return { kind: 'set', filters, overrides: (f) => filters.some((x) => x.table === f.table && !!f.cols?.some((c) => x.cols!.includes(c))) };
  }

  /* ----------------------------- time intelligence ----------------------------- */

  private unit(n: Node | undefined): 'year' | 'quarter' | 'month' | 'day' {
    const u = n && (n.k === 'tbl' || n.k === 'var') ? n.name.toUpperCase() : '';
    if (u === 'YEAR' || u === 'QUARTER' || u === 'MONTH' || u === 'DAY') return u.toLowerCase() as any;
    throw new DaxError('Intervallo non valido: usare YEAR, QUARTER, MONTH o DAY');
  }

  private shift(x: string, n: string, u: string) {
    const f = u === 'year' ? `to_years(CAST(${n} AS INTEGER))` : u === 'quarter' ? `to_months(CAST(3 * (${n}) AS INTEGER))` : u === 'month' ? `to_months(CAST(${n} AS INTEGER))` : `to_days(CAST(${n} AS INTEGER))`;
    return `CAST(${x} + ${f} AS DATE)`;
  }

  /** A time-intelligence function as a predicate on the date column (dates of the whole column). */
  ti(n: Extract<Node, { k: 'call' }>, env: Env): TiFilter {
    const A = n.args;
    const cal = A[0]?.k === 'tbl' ? this.calendar(A[0].name) : undefined;
    if (cal) return this.calendarTi(n, cal, env);
    if (A[0]?.k === 'tbl' && !this.m.tables.some((t) => eqi(t.name, (A[0] as { name: string }).name))) throw new DaxError(`Calendario non trovato: '${A[0].name}'`);
    if (WEEK_FNS.has(n.fn)) throw new DaxError(`${n.fn} richiede un calendario (Strumenti tabella › Opzioni calendario) con la categoria Settimana`);
    if (A[0]?.k !== 'col') throw new DaxError(`${n.fn}: il primo argomento deve essere una colonna di date`);
    const c = this.col(A[0], env);
    const T = c.table, d = c.col;
    const D = (a: string) => `CAST(${a}.${qi(d)} AS DATE)`;
    const vis = (agg: 'MIN' | 'MAX') => {
      const a = this.A();
      const w = this.preds(T, a, env.fc);
      return `(SELECT ${agg}(${D(a)}) FROM ${qi(T)} ${a}${w ? ` WHERE ${w}` : ''})`;
    };
    const visSet = (shiftN: string, u: string) => {
      const a = this.A();
      const w = this.preds(T, a, env.fc);
      return `SELECT ${this.shift(D(a), shiftN, u)} FROM ${qi(T)} ${a}${w ? ` WHERE ${w}` : ''}`;
    };
    const tr = (u: string, x: string) => `CAST(date_trunc('${u}', ${x}) AS DATE)`;
    const range = (lo: string, hi: string, hiIncl = false): Pred => (a) => `(${D(a)} >= ${lo} AND ${D(a)} ${hiIncl ? '<=' : '<'} ${hi})`;
    const prev = (u: string, base: string): Pred => range(this.shift(tr(u, base), '-1', u), tr(u, base));
    const next = (u: string, base: string): Pred => range(this.shift(tr(u, base), '1', u), this.shift(tr(u, base), '2', u));
    let pred: Pred;
    switch (n.fn) {
      case 'DATESYTD': case 'DATESQTD': case 'DATESMTD': {
        const u = n.fn === 'DATESYTD' ? 'year' : n.fn === 'DATESQTD' ? 'quarter' : 'month';
        const mx = vis('MAX');
        pred = range(tr(u, mx), mx, true);
        break;
      }
      case 'SAMEPERIODLASTYEAR': { const s = visSet('-1', 'year'); pred = (a) => `${D(a)} IN (${s})`; break; }
      case 'DATEADD': { const s = visSet(this.scalar(A[1], env), this.unit(A[2])); pred = (a) => `${D(a)} IN (${s})`; break; }
      case 'PARALLELPERIOD': {
        const u = this.unit(A[2]), k = this.scalar(A[1], env);
        pred = range(tr(u, this.shift(vis('MIN'), k, u)), this.shift(tr(u, this.shift(vis('MAX'), k, u)), '1', u));
        break;
      }
      case 'PREVIOUSDAY': pred = prev('day', vis('MIN')); break;
      case 'PREVIOUSMONTH': pred = prev('month', vis('MIN')); break;
      case 'PREVIOUSQUARTER': pred = prev('quarter', vis('MIN')); break;
      case 'PREVIOUSYEAR': pred = prev('year', vis('MAX')); break;
      case 'NEXTDAY': pred = next('day', vis('MAX')); break;
      case 'NEXTMONTH': pred = next('month', vis('MAX')); break;
      case 'NEXTQUARTER': pred = next('quarter', vis('MAX')); break;
      case 'NEXTYEAR': pred = next('year', vis('MIN')); break;
      case 'DATESBETWEEN': {
        const lo = blank(A[1]) ? null : `CAST(${this.scalar(A[1], env)} AS DATE)`;
        const hi = blank(A[2]) ? null : `CAST(${this.scalar(A[2], env)} AS DATE)`;
        pred = (a) => [lo ? `${D(a)} >= ${lo}` : '', hi ? `${D(a)} <= ${hi}` : ''].filter(Boolean).join(' AND ') || 'TRUE';
        break;
      }
      case 'DATESINPERIOD': {
        const s = `CAST(${this.scalar(A[1], env)} AS DATE)`, k = this.scalar(A[2], env), u = this.unit(A[3]);
        pred = (a) => `(CASE WHEN ${k} < 0 THEN ${D(a)} > ${this.shift(s, k, u)} AND ${D(a)} <= ${s} ELSE ${D(a)} >= ${s} AND ${D(a)} < ${this.shift(s, k, u)} END)`;
        break;
      }
      case 'FIRSTDATE': { const v = vis('MIN'); pred = (a) => `${D(a)} = ${v}`; break; }
      case 'LASTDATE': { const v = vis('MAX'); pred = (a) => `${D(a)} = ${v}`; break; }
      case 'STARTOFMONTH': case 'STARTOFQUARTER': case 'STARTOFYEAR': {
        const v = tr(n.fn.slice(7).toLowerCase(), vis('MIN'));
        pred = (a) => `${D(a)} = ${v}`;
        break;
      }
      case 'ENDOFMONTH': case 'ENDOFQUARTER': case 'ENDOFYEAR': {
        const u = n.fn.slice(5).toLowerCase();
        const v = `CAST(${this.shift(tr(u, vis('MAX')), '1', u)} - INTERVAL 1 DAY AS DATE)`;
        pred = (a) => `${D(a)} = ${v}`;
        break;
      }
      default: throw new DaxError(`Funzione non supportata: ${n.fn}`);
    }
    // Like a table marked as date table: the new date filter replaces filters on the date
    // column and on its calendar attributes (year, month…), or on the whole calendar table.
    const meta = this.table(T);
    const marked = Object.keys(this.m.dateTables ?? {}).some((x) => eqi(x, T));
    const calendar = marked || /calend|date|data|tempo|time/i.test(T);
    const dateish = (col: string) => col === d || isDate(meta.columns.find((x) => x.name === col))
      || /(year|anno|quarter|trimestre|qtr|month|mese|week|settimana|day|giorno|period|periodo)/i.test(col);
    return { table: T, col: d, pred, overrides: (f) => f.table === T && (calendar || !!f.cols?.every(dateish)) };
  }

  calendar(name: string): CalendarDef | undefined {
    return this.m.calendars?.find((c) => eqi(c.name, name));
  }

  /**
   * Calendar-based time intelligence. Rows of the calendar's table are indexed per category: `f` orders
   * the finest category present (Date, else Week, Month…), `o_<u>` numbers the periods of category u in
   * time order (by their first `f`), `p_<u>` is the position of a row's `f` inside its period, `n_<u>`
   * the period length. Functions select rows by period number and position, like Power BI, which makes
   * no assumption on the calendar (fiscal, 4-4-5, 13 months, sparse dates).
   */
  private calendarTi(n: Extract<Node, { k: 'call' }>, cal: CalendarDef, env: Env): TiFilter {
    const A = n.args;
    const t = this.table(cal.table);
    const T = t.name;
    const prim = (u: string) => cal.groups.find((g) => g.unit === u)?.primary;
    const key = (u: string) => calendarKey(cal, u);
    const need = (u: string): string[] => {
      const k = key(u);
      if (!k) throw new DaxError(`${n.fn}: il calendario '${cal.name}' non ha la categoria ${CAL_UNIT_IT[u]} (o le categorie che la identificano)`);
      return k;
    };
    const fineUnit = ['date', 'week', 'month', 'quarter', 'semester', 'year'].find((u) => key(u));
    if (!fineUnit) throw new DaxError(`${n.fn}: il calendario '${cal.name}' non ha categorie complete (Anno, Trimestre, Mese, Settimana o Data)`);
    const dateCol = prim('date');
    const ord = (c: string) => `a.${qi(t.sortBy?.[c] ?? c)}`;
    // Columns whose filters the result replaces: every tagged column (time-related too, except for the lateral DATEADD / SAMEPERIODLASTYEAR).
    const lateral = n.fn === 'DATEADD' || n.fn === 'SAMEPERIODLASTYEAR';
    const clear = new Set<string>();
    for (const g of cal.groups) {
      if (!g.unit && lateral) continue;
      for (const c of [g.primary, ...(g.associated ?? [])]) if (c) { clear.add(c); if (t.sortBy?.[c]) clear.add(t.sortBy[c]); }
    }
    const units = new Set<string>();
    const idx = () => {
      const us = [...units];
      const ks = us.map((u) => need(u));
      const l1 = `SELECT a.rowid AS __rid${dateCol ? `, CAST(a.${qi(dateCol)} AS DATE) AS __d` : ''}, dense_rank() OVER (ORDER BY ${need(fineUnit).map(ord).join(', ')}) AS f${ks.map((k, i) => `${k.map((c, j) => `, a.${qi(c)} AS k${i}_${j}`).join('')}`).join('')} FROM ${qi(T)} a`;
      const l2 = `SELECT *${ks.map((k, i) => `, MIN(f) OVER (PARTITION BY ${k.map((_c, j) => `k${i}_${j}`).join(', ')}) AS m${i}`).join('')} FROM (${l1})`;
      const l3 = `SELECT *${us.map((u, i) => `, dense_rank() OVER (ORDER BY m${i}) AS o_${u}`).join('')} FROM (${l2})`;
      const l4 = `SELECT *${us.map((u) => `, dense_rank() OVER (PARTITION BY o_${u} ORDER BY f) AS p_${u}`).join('')} FROM (${l3})`;
      return `SELECT *${us.map((u) => `, MAX(p_${u}) OVER (PARTITION BY o_${u}) AS n_${u}`).join('')} FROM (${l4})`;
    };
    const vw = (() => { const a = this.A(); const w = this.preds(T, a, env.fc); return (x: string) => `${x ? `${x}.` : ''}__rid IN (SELECT ${a}.rowid FROM ${qi(T)} ${a}${w ? ` WHERE ${w}` : ''})`; })();
    const calUnit = (x: Node | undefined): string => {
      const u = x && (x.k === 'tbl' || x.k === 'var') ? x.name.toUpperCase() : '';
      const m: Record<string, string> = { YEAR: 'year', SEMESTER: 'semester', QUARTER: 'quarter', MONTH: 'month', WEEK: 'week', DAY: 'date' };
      if (!m[u]) throw new DaxError('Intervallo non valido: usare YEAR, QUARTER, MONTH, WEEK o DAY');
      return m[u];
    };
    // Rows of the index matching `cond` (alias i) → predicate on the calendar table.
    const rows = (cond: (i: string, I: string) => string): Pred => {
      const I = idx();
      return (a) => { const i = this.A('i'); return `${a}.rowid IN (SELECT ${i}.__rid FROM (${I}) ${i} WHERE ${cond(i, I)})`; };
    };
    const visAgg = (I: string, e: (j: string) => string) => { const j = this.A('j'); return `(SELECT ${e(j)} FROM (${I}) ${j} WHERE ${vw(j)})`; };
    let pred: Pred;
    const fnUnit = (fn: string) => (/YEAR$|YTD$/.test(fn) ? 'year' : /QUARTER$|QTD$/.test(fn) ? 'quarter' : /MONTH$|MTD$/.test(fn) ? 'month' : /WEEK$|WTD$/.test(fn) ? 'week' : 'date');
    switch (n.fn) {
      case 'DATESYTD': case 'DATESQTD': case 'DATESMTD': case 'DATESWTD': {
        const u = fnUnit(n.fn); units.add(u);
        pred = rows((i, I) => `${i}.o_${u} = ${visAgg(I, (j) => `arg_max(${j}.o_${u}, ${j}.f)`)} AND ${i}.f <= ${visAgg(I, (j) => `MAX(${j}.f)`)}`);
        break;
      }
      case 'PARALLELPERIOD': {
        const u = calUnit(A[2]); units.add(u);
        const k = this.scalar(A[1], env);
        pred = rows((i, I) => `${i}.o_${u} IN ${visAgg(I, (j) => `${j}.o_${u} + (${k})`).replace(/^\(SELECT /, '(SELECT DISTINCT ')}`);
        break;
      }
      case 'PREVIOUSYEAR': case 'PREVIOUSQUARTER': case 'PREVIOUSMONTH': case 'PREVIOUSWEEK': case 'PREVIOUSDAY':
      case 'NEXTYEAR': case 'NEXTQUARTER': case 'NEXTMONTH': case 'NEXTWEEK': case 'NEXTDAY': {
        const u = fnUnit(n.fn.replace(/DAY$/, 'DATE')); units.add(u);
        const prev = n.fn.startsWith('PREVIOUS');
        // Like the classic functions: PREVIOUSYEAR starts from the last visible date, NEXTYEAR from the first.
        const fromLast = prev === (u === 'year');
        pred = rows((i, I) => `${i}.o_${u} = ${visAgg(I, (j) => `${fromLast ? 'MAX' : 'MIN'}(${j}.o_${u}) ${prev ? '- 1' : '+ 1'}`)}`);
        break;
      }
      case 'FIRSTDATE': case 'LASTDATE':
        pred = rows((i, I) => `${i}.f = ${visAgg(I, (j) => `${n.fn === 'FIRSTDATE' ? 'MIN' : 'MAX'}(${j}.f)`)}`);
        break;
      case 'STARTOFYEAR': case 'STARTOFQUARTER': case 'STARTOFMONTH': case 'STARTOFWEEK': {
        const u = fnUnit(n.fn); units.add(u);
        pred = rows((i, I) => `${i}.o_${u} = ${visAgg(I, (j) => `MIN(${j}.o_${u})`)} AND ${i}.p_${u} = 1`);
        break;
      }
      case 'ENDOFYEAR': case 'ENDOFQUARTER': case 'ENDOFMONTH': case 'ENDOFWEEK': {
        const u = fnUnit(n.fn); units.add(u);
        pred = rows((i, I) => `${i}.o_${u} = ${visAgg(I, (j) => `MAX(${j}.o_${u})`)} AND ${i}.p_${u} = ${i}.n_${u}`);
        break;
      }
      case 'SAMEPERIODLASTYEAR': case 'DATEADD': {
        const u = n.fn === 'DATEADD' ? calUnit(A[2]) : 'year'; units.add(u);
        const k = n.fn === 'DATEADD' ? this.scalar(A[1], env) : '-1';
        const word = (x: Node | undefined) => (x && (x.k === 'tbl' || x.k === 'var' || x.k === 'str') ? (x.k === 'str' ? x.v : x.name).toUpperCase() : '');
        const ext = word(A[3]) || 'PRECISE', trunc = word(A[4]) || 'ANCHORED';
        // A whole source period maps to the whole target period; a partial one keeps the positions (anchored to the end
        // of a shorter period, or dropped with BLANK). EXTENDED/ENDALIGNED decide what the last position of a period becomes.
        pred = rows((i, I) => {
          const v = this.A('v'), j = this.A('j');
          // Visible rows with their period, position and whether their period is entirely visible.
          const vr = `SELECT ${j}.o_${u} AS o, ${j}.p_${u} AS p, ${j}.n_${u} AS n, MAX(${j}.r) OVER (PARTITION BY ${j}.o_${u}) = ${j}.n_${u} AS whole FROM (SELECT *, dense_rank() OVER (PARTITION BY o_${u} ORDER BY f) AS r FROM (${I}) WHERE ${vw('')}) ${j}`;
          const target = trunc === 'BLANK' ? `${i}.p_${u} = ${v}.p` : `${i}.p_${u} = LEAST(${v}.p, ${i}.n_${u})`;
          const last = `${v}.p = ${v}.n`;
          const extra = ext === 'EXTENDED' ? ` OR (${last} AND ${i}.p_${u} >= LEAST(${v}.p, ${i}.n_${u}))` : ext === 'ENDALIGNED' ? ` OR (${last} AND ${i}.p_${u} = ${i}.n_${u})` : '';
          const tgt = ext === 'ENDALIGNED' ? `(NOT (${last}) AND ${target})` : target;
          return `EXISTS (SELECT 1 FROM (${vr}) ${v} WHERE ${i}.o_${u} = ${v}.o + (${k}) AND (${v}.whole OR ${tgt}${extra}))`;
        });
        break;
      }
      case 'DATESINPERIOD': {
        if (!dateCol) throw new DaxError(`${n.fn}: il calendario '${cal.name}' non ha la categoria Data`);
        const u = calUnit(A[3]); units.add(u);
        const start = `CAST(${this.scalar(A[1], env)} AS DATE)`, k = this.scalar(A[2], env);
        pred = rows((i, I) => {
          const sa = this.A('s'), b = this.A('b');
          const sf = `(SELECT ${sa}.f FROM (${I}) ${sa} WHERE ${sa}.__d = ${start} LIMIT 1)`;
          const bound = `(SELECT ${b}.f FROM (${I}) ${b}, (${I}) ${sa} WHERE ${sa}.__d = ${start} AND ${b}.o_${u} = ${sa}.o_${u} + (${k}) AND ${b}.p_${u} = LEAST(${sa}.p_${u}, ${b}.n_${u}) LIMIT 1)`;
          return `(CASE WHEN (${k}) < 0 THEN ${i}.f > coalesce(${bound}, 0) AND ${i}.f <= ${sf} ELSE ${i}.f >= ${sf} AND ${i}.f < coalesce(${bound}, 9223372036854775807) END)`;
        });
        break;
      }
      case 'DATESBETWEEN': {
        if (!dateCol) throw new DaxError(`${n.fn}: il calendario '${cal.name}' non ha la categoria Data`);
        const lo = blank(A[1]) ? null : `CAST(${this.scalar(A[1], env)} AS DATE)`;
        const hi = blank(A[2]) ? null : `CAST(${this.scalar(A[2], env)} AS DATE)`;
        pred = (a) => [lo ? `CAST(${a}.${qi(dateCol)} AS DATE) >= ${lo}` : '', hi ? `CAST(${a}.${qi(dateCol)} AS DATE) <= ${hi}` : ''].filter(Boolean).join(' AND ') || 'TRUE';
        break;
      }
      default: throw new DaxError(`${n.fn} non accetta un calendario`);
    }
    return { table: T, col: dateCol, cols: [...clear], pred, overrides: (f) => f.table === T && (!f.cols || f.cols.every((c) => clear.has(c))) };
  }

  /* ------------------------------ table expressions ----------------------------- */

  isTable(n: Node, env: Env): boolean {
    if (n.k === 'tbl') return !this.unitName(n.name);
    if (n.k === 'list') return true;
    if (n.k === 'var') return 't' in (env.vars.get(n.name) ?? { s: '' });
    if (n.k === 'let') return this.isTable(n.body, { ...env, vars: new Map([...env.vars, ...n.vars.map(([k, v]) => [k.toUpperCase(), this.isTable(v, env) ? { t: { sql: '', cols: [] } } : { s: '' }] as [string, Val])]) });
    if (n.k === 'call' && this.udfs.has(n.fn)) return this.isTable(this.expandUdf(n)!, env);
    return n.k === 'call' && TABLE_FNS.has(n.fn);
  }

  private unitName(s: string) { return /^(YEAR|QUARTER|MONTH|WEEK|DAY|ASC|DESC|INTEGER|DOUBLE|STRING|BOOLEAN|CURRENCY|DATETIME)$/i.test(s) && !this.m.tables.some((t) => eqi(t.name, s)); }

  private proj(tv: TV, alias: string) { return tv.cols.map((c) => `${alias}.${qi(c.name)}`).join(', '); }

  /** Distinct output names (duplicates become 'T'[c]). */
  private uniqueCols(cols: OutCol[]): OutCol[] {
    const seen = new Set<string>();
    return cols.map((c) => {
      let name = c.name;
      if (seen.has(name.toLowerCase()) && c.table) name = `${c.table}[${c.name}]`;
      let i = 2;
      while (seen.has(name.toLowerCase())) name = `${c.name}${i++}`;
      seen.add(name.toLowerCase());
      return { ...c, name };
    });
  }

  tv(n: Node, env: Env): TV {
    switch (n.k) {
      case 'tbl': return this.rowsOf(n.name, env.fc);
      case 'var': {
        const v = env.vars.get(n.name);
        if (!v || !('t' in v)) throw new DaxError(`La variabile ${n.name} non è una tabella`);
        return v.t;
      }
      case 'let': return this.tv(n.body, this.bind(n, env));
      case 'list': {
        const width = Math.max(...n.rows.map((r) => r.length));
        const names = width === 1 ? ['Value'] : Array.from({ length: width }, (_, i) => `Value${i + 1}`);
        const rows = n.rows.map((r) => `(${names.map((_x, i) => (r[i] ? this.scalar(r[i], env) : 'NULL')).join(', ')})`);
        return { sql: `SELECT * FROM (VALUES ${rows.join(', ')}) ${this.A('l')}(${names.map(qi).join(', ')})`, cols: names.map((x) => ({ name: x })) };
      }
      case 'call': return this.tableCall(n, env);
    }
    throw new DaxError('Espressione di tabella attesa');
  }

  private tableCall(n: Extract<Node, { k: 'call' }>, env: Env): TV {
    const A = n.args;
    const iterRow = (tv: TV): RowCtx => { const r = this.A('r'); return { alias: r, t: tv, rowid: tv.base ? `${r}.__rowid` : undefined }; };
    const withRow = (row: RowCtx): Env => ({ ...env, rows: [...env.rows, row] });
    switch (n.fn) {
      case 'FILTER': {
        const tv = this.tv(A[0], env);
        const r = iterRow(tv);
        const cond = this.scalar(A[1], withRow(r));
        return { ...tv, sql: `SELECT ${r.alias}.* FROM (${tv.sql}) ${r.alias} WHERE coalesce(${cond}, false)` };
      }
      case 'ALL': case 'ALLNOBLANKROW': {
        if (!A.length || blank(A[0])) throw new DaxError('ALL() senza argomenti è valido solo come filtro di CALCULATE');
        if (A[0].k === 'tbl') return this.rowsOf(A[0].name, null);
        return this.distinctCols(this.colArgs(A, env), null);
      }
      case 'ALLSELECTED': {
        const fc = this.calculate(env, [n], false).fc;
        if (A[0]?.k === 'tbl') return this.rowsOf(A[0].name, fc);
        if (!A.length || blank(A[0])) throw new DaxError('ALLSELECTED() senza argomenti è valido solo come filtro');
        return this.distinctCols(this.colArgs(A, env), fc);
      }
      case 'ALLEXCEPT': {
        const fc = this.calculate(env, [n], false).fc;
        return this.rowsOf((A[0] as { name: string }).name, fc);
      }
      case 'VALUES': case 'DISTINCT': {
        if (A[0]?.k === 'tbl') return this.rowsOf(A[0].name, env.fc);
        if (A[0]?.k === 'col') return this.distinctCols(this.colArgs([A[0]], env), env.fc);
        const tv = this.tv(A[0], env);
        const v = this.A('v');
        return { sql: `SELECT DISTINCT ${this.proj(tv, v)} FROM (${tv.sql}) ${v}`, cols: tv.cols };
      }
      case 'CALCULATETABLE': return this.tv(A[0], this.calculate(env, A.slice(1)));
      // As an iterator's table (quick measures: AVERAGEX(KEEPFILTERS(VALUES(c)), …)) KEEPFILTERS is the table itself.
      case 'KEEPFILTERS': return this.tv(A[0], env);
      case 'RELATEDTABLE': {
        if (A[0]?.k !== 'tbl') throw new DaxError('RELATEDTABLE richiede una tabella');
        return this.rowsOf(A[0].name, this.calculate(env, []).fc);
      }
      case 'TOPN': {
        const k = this.scalar(A[0], env);
        const tv = this.tv(A[1], env);
        const r = iterRow(tv);
        const order: string[] = [];
        for (let i = 2; i < A.length; i += 2) {
          const dirN = A[i + 1];
          const asc = dirN && ((dirN.k === 'tbl' && dirN.name.toUpperCase() === 'ASC') || (dirN.k === 'num' && dirN.v === '1'));
          order.push(`${this.scalar(A[i], withRow(r))} ${asc ? 'ASC' : 'DESC'} NULLS LAST`);
        }
        return { ...tv, sql: `SELECT ${r.alias}.* FROM (${tv.sql}) ${r.alias}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${k}` };
      }
      case 'ADDCOLUMNS': {
        const tv = this.tv(A[0], env);
        const r = iterRow(tv);
        const extra = this.namedExprs(A.slice(1), withRow(r));
        return { ...tv, sql: `SELECT ${r.alias}.*${extra.map(([nm, e]) => `, ${e} AS ${qi(nm)}`).join('')} FROM (${tv.sql}) ${r.alias}`, cols: [...tv.cols, ...extra.map(([nm]) => ({ name: nm }))] };
      }
      case 'SELECTCOLUMNS': {
        const tv = this.tv(A[0], env);
        const r = iterRow(tv);
        const cols: OutCol[] = [];
        const sel: string[] = [];
        for (let i = 1; i < A.length; i++) {
          const a = A[i];
          let name: string, e: Node;
          if (a.k === 'str') { name = a.v; e = A[++i]; } else if (a.k === 'col') { name = a.col; e = a; } else throw new DaxError('SELECTCOLUMNS: atteso "Nome", espressione');
          const lin = e.k === 'col' && !this.measure(e.col) ? this.lineage(e, r, env) : undefined;
          sel.push(`${this.scalar(e, withRow(r))} AS ${qi(name)}`);
          cols.push({ name, ...lin });
        }
        return { sql: `SELECT ${sel.join(', ')} FROM (${tv.sql}) ${r.alias}`, cols };
      }
      case 'SUMMARIZE': return this.summarize(A, env);
      case 'SUMMARIZECOLUMNS': return this.summarizeColumns(A, env);
      case 'ROW': {
        const extra = this.namedExprs(A, env);
        return { sql: `SELECT ${extra.map(([nm, e]) => `${e} AS ${qi(nm)}`).join(', ')}`, cols: extra.map(([nm]) => ({ name: nm })) };
      }
      case 'CALENDAR': {
        const s = this.scalar(A[0], env), e = this.scalar(A[1], env);
        const x = this.A('c');
        return { sql: `SELECT CAST(${x}.d AS DATE) AS "Date" FROM range(CAST(${s} AS TIMESTAMP), CAST(${e} AS TIMESTAMP) + INTERVAL 1 DAY, INTERVAL 1 DAY) ${x}(d)`, cols: [{ name: 'Date' }] };
      }
      case 'CALENDARAUTO': {
        const dates = this.m.tables.flatMap((t) => t.columns.filter((c) => isDate(c)).map((c) => ({ t: t.name, c: c.name })));
        if (!dates.length) throw new DaxError('CALENDARAUTO: nessuna colonna di date nel modello');
        const mn = `LEAST(${dates.map((d) => `(SELECT MIN(CAST(${qi(d.c)} AS DATE)) FROM ${qi(d.t)})`).join(', ')})`;
        const mx = `GREATEST(${dates.map((d) => `(SELECT MAX(CAST(${qi(d.c)} AS DATE)) FROM ${qi(d.t)})`).join(', ')})`;
        const x = this.A('c');
        return { sql: `SELECT CAST(${x}.d AS DATE) AS "Date" FROM range(CAST(date_trunc('year', ${mn}) AS TIMESTAMP), CAST(date_trunc('year', ${mx}) AS TIMESTAMP) + INTERVAL 1 YEAR, INTERVAL 1 DAY) ${x}(d)`, cols: [{ name: 'Date' }] };
      }
      case 'GENERATESERIES': {
        const x = this.A('g');
        // Integer counter: DuckDB's generate_series has no DOUBLE version (0, 0.05 … 0.5). Arguments are constants.
        const [a, b, st] = [this.scalar(A[0], env), this.scalar(A[1], env), A[2] ? this.scalar(A[2], env) : '1'];
        return {
          sql: `SELECT CASE WHEN ${a} = floor(${a}) AND ${st} = floor(${st}) THEN CAST(${a} + ${x}.i * ${st} AS BIGINT) ELSE round(${a} + ${x}.i * ${st}, 10) END AS "Value" FROM range(0, CAST(floor((${b} - (${a})) / (${st}) + 1e-9) AS BIGINT) + 1) ${x}(i)`,
          cols: [{ name: 'Value' }],
        };
      }
      case 'UNION': case 'EXCEPT': case 'INTERSECT': {
        const tvs = A.map((a) => this.tv(a, env));
        const op = n.fn === 'UNION' ? 'UNION ALL' : n.fn;
        const parts = tvs.map((t) => { const v = this.A('v'); return `SELECT ${this.proj(t, v)} FROM (${t.sql}) ${v}`; });
        return { sql: `SELECT * FROM (${parts.join(` ${op} `)})`, cols: tvs[0].cols };
      }
      case 'CROSSJOIN': {
        const tvs = A.map((a) => this.tv(a, env));
        const al = tvs.map(() => this.A('x'));
        const cols = this.uniqueCols(tvs.flatMap((t) => t.cols));
        let i = 0;
        const sel = tvs.flatMap((t, j) => t.cols.map((c) => `${al[j]}.${qi(c.name)} AS ${qi(cols[i++].name)}`));
        return { sql: `SELECT ${sel.join(', ')} FROM ${tvs.map((t, j) => `(${t.sql}) ${al[j]}`).join(' CROSS JOIN ')}`, cols };
      }
      case 'TREATAS': {
        const tv = this.tv(A[0], env);
        const targets = this.colArgs(A.slice(1), env);
        if (targets.length !== tv.cols.length) throw new DaxError('TREATAS: il numero di colonne non corrisponde');
        return { sql: tv.sql, cols: tv.cols.map((c, i) => ({ name: c.name, table: targets[i].table, col: targets[i].col })) };
      }
      case 'TABLEOF': {
        const a = A[0];
        if (a?.k === 'tbl') return this.rowsOf(this.calendar(a.name)?.table ?? a.name, env.fc);
        if (a?.k !== 'col') throw new DaxError('TABLEOF: atteso un riferimento a colonna, misura, tabella o calendario');
        const m = !a.table ? this.measure(a.col) : undefined;
        return this.rowsOf(m ? m.table : this.col(a, env).table, env.fc);
      }
    }
    const udf = this.expandUdf(n);
    if (udf) return this.tv(udf, env);
    if (TI_FNS.has(n.fn)) {
      const ti = this.ti(n, env);
      const a = this.A();
      if (ti.cols) {
        const t = this.table(ti.table);
        return { sql: `SELECT ${a}.*, ${a}.rowid AS __rowid FROM ${qi(t.name)} ${a} WHERE ${ti.pred(a)}`, cols: t.columns.map((c) => ({ name: c.name, table: t.name, col: c.name })), base: t.name };
      }
      const c = ti.col!;
      return { sql: `SELECT DISTINCT ${a}.${qi(c)} FROM ${qi(ti.table)} ${a} WHERE ${ti.pred(a)}`, cols: [{ name: c, table: ti.table, col: c }] };
    }
    throw new DaxError(`${n.fn} non restituisce una tabella`);
  }

  private distinctCols(cols: { table: string; col: string }[], fc: FCtx | null): TV {
    const tables = [...new Set(cols.map((c) => c.table))];
    if (tables.length !== 1) throw new DaxError('Le colonne devono appartenere alla stessa tabella');
    const a = this.A();
    const w = fc ? this.preds(tables[0], a, fc) : '';
    return {
      sql: `SELECT DISTINCT ${cols.map((c) => `${a}.${qi(c.col)} AS ${qi(c.col)}`).join(', ')} FROM ${qi(tables[0])} ${a}${w ? ` WHERE ${w}` : ''}`,
      cols: cols.map((c) => ({ name: c.col, table: c.table, col: c.col })),
    };
  }

  /** Lineage of a column reference evaluated over row `r`. */
  private lineage(n: Extract<Node, { k: 'col' }>, r: RowCtx, env: Env): { table: string; col: string } | undefined {
    const hit = r.t.cols.find((c) => (n.table ? eqi(c.table, n.table) && eqi(c.col, n.col) : eqi(c.name, n.col)));
    if (hit?.table) return { table: hit.table, col: hit.col! };
    try { const c = this.col(n, env); return { table: c.table, col: c.col }; } catch { return undefined; }
  }

  private namedExprs(args: Node[], env: Env): [string, string][] {
    const out: [string, string][] = [];
    for (let i = 0; i < args.length; i += 2) {
      const nm = args[i];
      if (nm?.k !== 'str') throw new DaxError('Atteso il nome della colonna tra virgolette, es. "Totale"');
      if (!args[i + 1]) throw new DaxError(`Manca l'espressione per "${nm.v}"`);
      out.push([nm.v, this.scalar(args[i + 1], env)]);
    }
    return out;
  }

  private summarize(A: Node[], env: Env): TV {
    const tv = this.tv(A[0], env);
    const r: RowCtx = { alias: this.A('r'), t: tv, rowid: tv.base ? '' : undefined };
    let i = 1;
    const groups: { sql: string; col: OutCol }[] = [];
    for (; i < A.length && A[i].k === 'col'; i++) {
      const n = A[i] as Extract<Node, { k: 'col' }>;
      const inRow = tv.cols.find((c) => (n.table ? eqi(c.table, n.table) && eqi(c.col, n.col) : eqi(c.name, n.col)));
      if (inRow) groups.push({ sql: `${r.alias}.${qi(inRow.name)}`, col: { name: inRow.col ?? inRow.name, table: inRow.table, col: inRow.col } });
      else {
        if (!tv.base) throw new DaxError(`SUMMARIZE: colonna ${n.col} non presente nella tabella`);
        const c = this.col(n, env);
        groups.push({ sql: this.related(tv.base, r.alias, c.table, c.col, env), col: { name: c.col, table: c.table, col: c.col } });
      }
    }
    const cols = this.uniqueCols(groups.map((g) => g.col));
    const gsql = `SELECT DISTINCT ${groups.map((g, j) => `${g.sql} AS ${qi(cols[j].name)}`).join(', ')} FROM (${tv.sql}) ${r.alias}`;
    if (i >= A.length) return { sql: gsql, cols };
    const gtv: TV = { sql: gsql, cols };
    const g = this.A('g');
    // Extension columns are evaluated in the filter context of each group (context transition).
    const genv = this.calculate({ ...env, rows: [...env.rows, { alias: g, t: gtv }] }, []);
    const extra = this.namedExprs(A.slice(i), genv);
    return { sql: `SELECT ${g}.*${extra.map(([nm, e]) => `, ${e} AS ${qi(nm)}`).join('')} FROM (${gsql}) ${g}`, cols: [...cols, ...extra.map(([nm]) => ({ name: nm }))] };
  }

  /** SUMMARIZECOLUMNS: the query Power BI visuals send. Group-by columns, filter tables, then "Name", expr pairs. */
  summarizeColumns(A: Node[], env: Env, groupTag: Filt['tag'] = 'group'): TV {
    const groupCols: { table: string; col: string }[] = [];
    const filterArgs: Node[] = [];
    let i = 0;
    for (; i < A.length && A[i].k !== 'str'; i++) {
      const a = A[i];
      if (a.k === 'col') groupCols.push(this.col(a, env));
      else filterArgs.push(a);
    }
    const fenv = this.calculate(env, filterArgs, false);
    const byTable = new Map<string, string[]>();
    for (const c of groupCols) byTable.set(c.table, [...new Set([...(byTable.get(c.table) ?? []), c.col])]);
    const cols = this.uniqueCols([...byTable].flatMap(([t, cs]) => cs.map((c) => ({ name: c, table: t, col: c }))));
    let gsql = 'SELECT 1 AS __one';
    if (byTable.size) {
      const parts = [...byTable].map(([t, cs]) => {
        const a = this.A();
        const w = this.preds(t, a, fenv.fc);
        const x = this.A('x');
        return { x, sql: `(SELECT DISTINCT ${cs.map((c) => `${a}.${qi(c)} AS ${qi(c)}`).join(', ')} FROM ${qi(t)} ${a}${w ? ` WHERE ${w}` : ''}) ${x}`, t, cs };
      });
      let k = 0;
      const sel = parts.flatMap((p) => p.cs.map((c) => `${p.x}.${qi(c)} AS ${qi(cols[k++].name)}`));
      gsql = `SELECT ${sel.join(', ')} FROM ${parts.map((p) => p.sql).join(' CROSS JOIN ')}`;
    }
    if (i >= A.length) return { sql: gsql, cols };
    const g = this.A('g');
    const genv: Env = {
      ...fenv,
      fc: {
        rels: fenv.fc.rels,
        filters: [
          ...fenv.fc.filters.filter((f) => !cols.some((c) => f.table === c.table && f.cols?.includes(c.col!))),
          ...cols.map((c): Filt => ({ table: c.table!, cols: [c.col!], tag: groupTag, pred: (a) => `${a}.${qi(c.col!)} IS NOT DISTINCT FROM ${g}.${qi(c.name)}` })),
        ],
      },
    };
    const extra = this.namedExprs(A.slice(i), genv);
    const sql = `SELECT ${cols.length ? `${g}.*` : ''}${cols.length ? ', ' : ''}${extra.map(([nm, e]) => `${e} AS ${qi(nm)}`).join(', ')} FROM (${gsql}) ${g}`;
    const b = this.A('b');
    // Like Power BI, rows where every expression is blank are dropped.
    return {
      sql: cols.length ? `SELECT * FROM (${sql}) ${b} WHERE NOT (${extra.map(([nm]) => `${b}.${qi(nm)} IS NULL`).join(' AND ')})` : sql,
      cols: [...cols, ...extra.map(([nm]) => ({ name: nm }))],
    };
  }

  /** RELATED: follow many → one relationships from a row of `from` (alias `r`) to `table`[col]. */
  related(from: string, r: string, table: string, col: string, env: Env): string {
    const path = this.expanded(env.fc.rels, from).get(table);
    if (!path) throw new DaxError(`RELATED: nessuna relazione molti-a-uno da '${from}' a '${table}'`);
    if (!path.length) return `${r}.${qi(col)}`;
    let key = `${r}.${qi(path[0].parentCol)}`;
    for (let i = 0; i < path.length; i++) {
      const e = path[i];
      const z = this.A('z');
      const want = i === path.length - 1 ? col : path[i + 1].parentCol;
      key = `(SELECT ${z}.${qi(want)} FROM ${qi(e.to)} ${z} WHERE ${z}.${qi(e.childCol)} = ${key} LIMIT 1)`;
    }
    return key;
  }

  /* ---------------------------------- scalars ---------------------------------- */

  bind(n: Extract<Node, { k: 'let' }>, env: Env): Env {
    const vars = new Map(env.vars);
    let e: Env = { ...env, vars };
    for (const [name, v] of n.vars) {
      vars.set(name.toUpperCase(), this.isTable(v, e) ? { t: this.tv(v, e) } : { s: this.scalar(v, e) });
      e = { ...e, vars };
    }
    return e;
  }

  rowRef(n: { table?: string; col: string }, env: Env, skip = 0): string | null {
    const rows = env.rows.slice(0, env.rows.length - skip);
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      const c = r.t.cols.find((x) => (n.table
        ? (eqi(x.table, n.table) && eqi(x.col, n.col)) || eqi(x.name, `${n.table}[${n.col}]`)
        : eqi(x.name, n.col) || (!x.table && eqi(x.name, `[${n.col}]`))))
        ?? (n.table ? undefined : r.t.cols.find((x) => eqi(x.col, n.col)));
      if (c) return `${r.alias}.${qi(c.name)}`;
    }
    return null;
  }

  measureRef(name: string, env: Env): string {
    const m = this.measure(name)!;
    // Calculation groups filtered in this context (slicer, axis, CALCULATE) transform the measure.
    // Like Power BI, also measures referenced inside other measures and items (sideways), but a measure
    // is not transformed again by a group already transforming it.
    if (this.m.calcGroups?.length) {
      const fc = env.rows.length ? this.calculate(env, []).fc : env.fc;
      const groups = this.m.calcGroups.filter((g) => !this.applying.has(`${g.table.toLowerCase()}|${m.name.toLowerCase()}`) && fc.filters.some((f) => eqi(f.table, g.table))).sort((a, b) => b.precedence - a.precedence);
      if (groups.length) return this.applyCalc(m.name, groups, { fc, rows: [], vars: new Map(), home: m.table });
    }
    if (this.stack.includes(m.name.toLowerCase())) throw new DaxError(`Riferimento circolare: ${[...this.stack, m.name].join(' → ')}`);
    const shared = !env.rows.length ? this.frames.find((f) => f.fc === env.fc) : undefined;
    const hit = shared?.binds.find((b) => b.key === m.name);
    if (hit) return `${hit.alias}.x`;
    const fc = env.rows.length ? this.calculate(env, []).fc : env.fc;
    this.stack.push(m.name.toLowerCase());
    try {
      const sql = this.framed(fc, () => `(${this.scalar(m.node(), { fc, rows: [], vars: new Map(), home: m.table })})`);
      if (!shared) return sql;
      const alias = this.A('m');
      shared.binds.push({ key: m.name, alias, sql });
      return `${alias}.x`;
    } catch (e) {
      if (e instanceof DaxError && this.stack.length > 1 && !e.message.startsWith('[')) throw new DaxError(`[${m.name}]: ${e.message}`);
      throw e;
    } finally {
      this.stack.pop();
    }
  }

  /**
   * Measure `name` under calculation groups (highest precedence outermost): the item selected in the
   * context replaces the measure, its SELECTEDMEASURE() being the measure under the remaining groups.
   * No single item selected → the measure itself.
   */
  private applyCalc(name: string, groups: CalcGroup[], env: Env): string {
    const [g, ...rest] = groups;
    const key = `${g.table.toLowerCase()}|${name.toLowerCase()}`;
    this.applying.add(key);
    try { return this.calcCase(name, g, rest, env); } finally { this.applying.delete(key); }
  }

  private calcCase(name: string, g: CalcGroup, rest: CalcGroup[], env: Env): string {
    const inner = (e: Env): string => (rest.length ? this.applyCalc(name, rest, e) : this.measureRef(name, e));
    const t = this.table(g.table);
    const a = this.A();
    const w = this.preds(t.name, a, env.fc);
    const x = `${a}.${qi(g.column)}`;
    const sel = `(SELECT CASE WHEN COUNT(DISTINCT ${x}) = 1 THEN MIN(${x}) END FROM ${qi(t.name)} ${a}${w ? ` WHERE ${w}` : ''})`;
    const branches = g.items.map((it) => {
      this.selected.push({ name, sql: inner });
      try { return `WHEN ${ql(it.name)} THEN ${this.scalar(parse(it.expression), env)}`; }
      catch (e) { throw e instanceof DaxError ? new DaxError(`Elemento di calcolo "${it.name}": ${e.message}`) : e; }
      finally { this.selected.pop(); }
    });
    return `(CASE ${sel} ${branches.join(' ')} ELSE ${inner(env)} END)`;
  }

  /** Format string of measure `name` in this context: the selected item's formatStringDefinition, else the measure's. */
  formatRef(name: string, env: Env): string {
    const m = this.measure(name)!;
    const own = ql(this.m.measures.find((x) => eqi(x.name, m.name))?.formatString ?? '');
    const g = (this.m.calcGroups ?? []).filter((x) => x.items.some((i) => i.formatString?.trim()) && env.fc.filters.some((f) => eqi(f.table, x.table))).sort((a, b) => b.precedence - a.precedence)[0];
    if (!g) return own;
    const t = this.table(g.table);
    const a = this.A();
    const w = this.preds(t.name, a, env.fc);
    const x = `${a}.${qi(g.column)}`;
    const sel = `(SELECT CASE WHEN COUNT(DISTINCT ${x}) = 1 THEN MIN(${x}) END FROM ${qi(t.name)} ${a}${w ? ` WHERE ${w}` : ''})`;
    // SELECTEDMEASURE() in a format string = the measure value (transformed by the other groups, not by this one).
    const key = `${g.table.toLowerCase()}|${m.name.toLowerCase()}`;
    this.selected.push({ name: m.name, sql: (e) => this.measureRef(m.name, e) });
    this.applying.add(key);
    try {
      const branches = g.items.filter((i) => i.formatString?.trim()).map((i) => `WHEN ${ql(i.name)} THEN CAST(${this.scalar(parse(i.formatString!), env)} AS VARCHAR)`);
      return `(CASE ${sel} ${branches.join(' ')} ELSE ${own} END)`;
    } finally { this.selected.pop(); this.applying.delete(key); }
  }

  /** WHERE predicate on row alias `alias` of `table` for a DAX boolean row expression (RLS filter). */
  rowFilter(table: string, expression: string, alias: string): string {
    const t = this.table(table);
    const env = emptyEnv(this.m, t.name);
    env.rows = [{ alias, t: { sql: '', cols: t.columns.map((x) => ({ name: x.name, table: t.name, col: x.name })), base: t.name }, rowid: `${alias}.rowid` }];
    return `coalesce(${this.scalar(parse(expression), env)}, FALSE)`;
  }

  private aggCol(fn: string, arg: Node | undefined, env: Env): string {
    if (arg?.k !== 'col') throw new DaxError(`${fn} richiede un riferimento a colonna`);
    const c = this.col(arg, env);
    const a = this.A();
    const w = this.preds(c.table, a, env.fc);
    const x = `${a}.${qi(c.col)}`;
    const num = isNumeric({ name: c.col, type: c.type });
    let e: string;
    switch (fn) {
      case 'SUM': e = `CAST(SUM(${x}) AS DOUBLE)`; break;
      case 'AVERAGE': case 'AVERAGEA': e = `CAST(AVG(${x}) AS DOUBLE)`; break;
      case 'MEDIAN': e = `CAST(MEDIAN(${x}) AS DOUBLE)`; break;
      case 'MIN': case 'MINA': e = num ? `CAST(MIN(${x}) AS DOUBLE)` : `MIN(${x})`; break;
      case 'MAX': case 'MAXA': e = num ? `CAST(MAX(${x}) AS DOUBLE)` : `MAX(${x})`; break;
      case 'COUNT': case 'COUNTA': e = `CAST(NULLIF(COUNT(${x}), 0) AS DOUBLE)`; break;
      case 'COUNTBLANK': e = `CAST(NULLIF(COUNT(*) FILTER (WHERE ${x} IS NULL), 0) AS DOUBLE)`; break;
      // DAX counts BLANK as a distinct value.
      case 'DISTINCTCOUNT': e = `CAST(NULLIF(COUNT(DISTINCT ${x}) + CASE WHEN COUNT(*) > COUNT(${x}) THEN 1 ELSE 0 END, 0) AS DOUBLE)`; break;
      case 'DISTINCTCOUNTNOBLANK': e = `CAST(NULLIF(COUNT(DISTINCT ${x}), 0) AS DOUBLE)`; break;
      default: throw new DaxError(fn);
    }
    return `(SELECT ${e} FROM ${qi(c.table)} ${a}${w ? ` WHERE ${w}` : ''})`;
  }

  private iterate(fn: string, A: Node[], env: Env): string {
    const tv = this.tv(A[0], env);
    const r = this.A('r');
    const inner = this.scalar(A[1], { ...env, rows: [...env.rows, { alias: r, t: tv, rowid: tv.base ? `${r}.__rowid` : undefined }] });
    const agg: Record<string, string> = {
      SUMX: `CAST(SUM(${inner}) AS DOUBLE)`, AVERAGEX: `CAST(AVG(${inner}) AS DOUBLE)`, MINX: `MIN(${inner})`, MAXX: `MAX(${inner})`,
      COUNTX: `CAST(NULLIF(COUNT(${inner}), 0) AS DOUBLE)`, COUNTAX: `CAST(NULLIF(COUNT(${inner}), 0) AS DOUBLE)`, PRODUCTX: `CAST(PRODUCT(${inner}) AS DOUBLE)`,
    };
    return `(SELECT ${agg[fn]} FROM (${tv.sql}) ${r})`;
  }

  /** Column of the first table argument for scalar functions taking a column (SELECTEDVALUE…). */
  private colQuery(arg: Node | undefined, env: Env, select: (x: string) => string): string {
    if (arg?.k !== 'col') throw new DaxError('Argomento atteso: un riferimento a colonna');
    const c = this.col(arg, env);
    const a = this.A();
    const w = this.preds(c.table, a, env.fc);
    return `(SELECT ${select(`${a}.${qi(c.col)}`)} FROM ${qi(c.table)} ${a}${w ? ` WHERE ${w}` : ''})`;
  }

  private filtered(arg: Node | undefined, env: Env, mode: 'direct' | 'cross' | 'scope'): string {
    if (arg?.k === 'tbl') {
      const T = this.table(arg.name).name;
      const hit = env.fc.filters.some((f) => (mode === 'cross' ? !!this.path(env.fc.rels, T, f.table) : f.table === T));
      return hit ? 'TRUE' : 'FALSE';
    }
    if (arg?.k !== 'col') throw new DaxError('Argomento atteso: una colonna o una tabella');
    const c = this.col(arg, env);
    const hit = env.fc.filters.some((f) => {
      if (mode === 'scope') return f.tag === 'group' && f.table === c.table && !!f.cols?.includes(c.col);
      if (f.table === c.table && (f.cols === null || f.cols.includes(c.col))) return true;
      return mode === 'cross' && f.table !== c.table && !!this.path(env.fc.rels, c.table, f.table);
    });
    return hit ? 'TRUE' : 'FALSE';
  }

  private format(v: string, fmt: Node | undefined): string {
    if (fmt?.k !== 'str') return `CAST(${v} AS VARCHAR)`;
    const f = fmt.v;
    const named: Record<string, string> = { 'General Number': '0.##########', Percent: '0.00%', Fixed: '0.00', Standard: '#,0.00', Currency: '€ #,0.00' };
    const nf = named[f] ?? f;
    if (/^[^yYdDhHsS]*[0#][0#.,%]*[^yYdDhHsS]*$/.test(nf) && !/m/i.test(nf.replace(/[€$]/g, ''))) {
      const pct = nf.includes('%');
      const dec = (/[.]([0#]+)/.exec(nf)?.[1].length) ?? 0;
      const group = /[#0],[#0]/.test(nf);
      const prefix = /^[^0#]*/.exec(nf)![0].replace(/%/g, '');
      const suffix = /[^0#.,]*$/.exec(nf)![0];
      const x = pct ? `(${v}) * 100` : v;
      // Italian separators: thousands ".", decimals ",".
      const body = `translate(format('{:${group ? ',' : ''}.${dec}f}', CAST(${x} AS DOUBLE)), ',.', '.,')`;
      return `CASE WHEN ${v} IS NULL THEN NULL ELSE concat(${ql(prefix)}, ${body}, ${ql(suffix)}) END`;
    }
    const parts: string[] = [];
    const re = /(yyyy|yy|mmmm|mmm|mm|m|dddd|ddd|dd|d|hh|h|nn|ss|"[^"]*"|\\.|.)/gi;
    const d = `CAST(${v} AS TIMESTAMP)`;
    for (const t of f.match(re) ?? []) {
      const l = t.toLowerCase();
      if (l === 'yyyy') parts.push(`strftime(${d}, '%Y')`);
      else if (l === 'yy') parts.push(`strftime(${d}, '%y')`);
      else if (l === 'mmmm') parts.push(`${sqlList(monthNames())}[month(${d})]`);
      else if (l === 'mmm') parts.push(`${sqlList(monthNames(true))}[month(${d})]`);
      else if (l === 'mm') parts.push(`strftime(${d}, '%m')`);
      else if (l === 'm') parts.push(`CAST(month(${d}) AS VARCHAR)`);
      else if (l === 'dddd') parts.push(`${sqlList(dayNames())}[dayofweek(${d}) + 1]`);
      else if (l === 'ddd') parts.push(`${sqlList(dayNames(true))}[dayofweek(${d}) + 1]`);
      else if (l === 'dd') parts.push(`strftime(${d}, '%d')`);
      else if (l === 'd') parts.push(`CAST(day(${d}) AS VARCHAR)`);
      else if (l === 'hh' || l === 'h') parts.push(`strftime(${d}, '%H')`);
      else if (l === 'nn') parts.push(`strftime(${d}, '%M')`);
      else if (l === 'ss') parts.push(`strftime(${d}, '%S')`);
      else if (t.startsWith('"')) parts.push(ql(t.slice(1, -1)));
      else if (t.startsWith('\\')) parts.push(ql(t.slice(1)));
      else parts.push(ql(t));
    }
    return `CASE WHEN ${v} IS NULL THEN NULL ELSE concat(${parts.join(', ')}) END`;
  }

  scalar(n: Node, env: Env): string {
    switch (n.k) {
      case 'num': return n.v.includes('.') || /e/i.test(n.v) ? `CAST(${n.v} AS DOUBLE)` : n.v;
      case 'str': return ql(n.v);
      case 'bool': return n.v ? 'TRUE' : 'FALSE';
      case 'var': {
        const v = env.vars.get(n.name);
        if (!v) throw new DaxError(`Variabile non definita: ${n.name}`);
        if ('t' in v) return this.tableAsScalar(v.t);
        return v.s;
      }
      case 'let': {
        const vars = new Map(env.vars);
        const wraps: { a: string; sql: string }[] = [];
        let e: Env = { ...env, vars };
        for (const [name, v] of n.vars) {
          if (this.isTable(v, e)) vars.set(name.toUpperCase(), { t: this.tv(v, e) });
          else {
            const a = this.A('v');
            wraps.push({ a, sql: this.scalar(v, e) });
            vars.set(name.toUpperCase(), { s: `${a}.x` });
          }
          e = { ...e, vars };
        }
        // Each VAR is evaluated once, where it is defined (nested derived tables).
        return wraps.reduceRight((acc, w) => `(SELECT ${acc} FROM (SELECT ${w.sql} AS x) ${w.a})`, this.scalar(n.body, e));
      }
      case 'col': {
        const row = this.rowRef(n, env);
        if (row) return row;
        if (!n.table || this.m.measures.some((m) => eqi(m.name, n.col) && eqi(m.table, n.table))) {
          if (this.measure(n.col)) return this.measureRef(n.col, env);
        }
        const c = this.col(n, env);
        throw new DaxError(`Impossibile determinare un singolo valore per la colonna '${c.table}'[${c.col}]. Usare un'aggregazione (SUM, MIN, MAX…) o un iteratore.`);
      }
      case 'tbl':
        if (this.unitName(n.name)) return ql(n.name.toUpperCase());
        return this.tableAsScalar(this.tv(n, env));
      case 'list': return this.tableAsScalar(this.tv(n, env));
      case 'neg': return `(-${this.scalar(n.a, env)})`;
      case 'bin': return this.binary(n, env);
      case 'call': return this.call(n, env);
    }
  }

  /** A one-column table used as a value (DAX converts it, or errors on several rows). */
  private tableAsScalar(tv: TV): string {
    const v = this.A('v');
    const c = `${v}.${qi(tv.cols[0].name)}`;
    return `(SELECT CASE WHEN COUNT(*) <= 1 THEN MIN(${c}) ELSE error('Una tabella di più valori è stata fornita dove era previsto un singolo valore.') END FROM (${tv.sql}) ${v})`;
  }

  private binary(n: Extract<Node, { k: 'bin' }>, env: Env): string {
    if (n.op === 'IN') {
      const a = this.scalar(n.a, env);
      if (n.b.k === 'list' && n.b.rows.every((r) => r.length === 1)) return `(${a} IN (${n.b.rows.map((r) => this.scalar(r[0], env)).join(', ')}))`;
      const tv = this.tv(n.b, env);
      const v = this.A('v');
      return `(${a} IN (SELECT ${v}.${qi(tv.cols[0].name)} FROM (${tv.sql}) ${v}))`;
    }
    const a = this.scalar(n.a, env), b = this.scalar(n.b, env);
    switch (n.op) {
      // DAX: BLANK + x = x, BLANK + BLANK = BLANK.
      case '+': return this.once([a, b], ([x, y]) => `CASE WHEN ${x} IS NULL THEN ${y} WHEN ${y} IS NULL THEN ${x} ELSE ${x} + ${y} END`);
      case '-': return this.once([a, b], ([x, y]) => `CASE WHEN ${y} IS NULL THEN ${x} WHEN ${x} IS NULL THEN -${y} ELSE ${x} - ${y} END`);
      case '*': return `(${a} * ${b})`;
      case '/': return `(${a} / NULLIF(${b}, 0))`;
      case '^': return `power(${a}, ${b})`;
      case '&': return `concat(${a}, ${b})`;
      case '&&': return `(${a} AND ${b})`;
      case '||': return `(${a} OR ${b})`;
    }
    if (CMP[n.op]) {
      if (b === 'NULL' || a === 'NULL') {
        const v = b === 'NULL' ? a : b;
        // DAX: BLANK = 0 and BLANK = "" are true.
        if (n.op === '=') return this.once([v], ([x]) => `(${x} IS NULL OR CAST(${x} AS VARCHAR) IN ('0', ''))`);
        if (n.op === '==') return `(${v} IS NULL)`;
        if (n.op === '<>') return this.once([v], ([x]) => `(${x} IS NOT NULL AND CAST(${x} AS VARCHAR) NOT IN ('0', ''))`);
      }
      return `(${a} ${CMP[n.op]} ${b})`;
    }
    throw new DaxError(`Operatore non supportato: ${n.op}`);
  }

  private call(n: Extract<Node, { k: 'call' }>, env: Env): string {
    const A = n.args;
    const s = (i: number) => this.scalar(A[i], env);
    const opt = (i: number, d: string) => (blank(A[i]) ? d : s(i));
    switch (n.fn) {
      case 'SUM': case 'AVERAGE': case 'AVERAGEA': case 'MEDIAN': case 'COUNT': case 'COUNTA': case 'COUNTBLANK': case 'DISTINCTCOUNT': case 'DISTINCTCOUNTNOBLANK':
        return this.aggCol(n.fn, A[0], env);
      case 'MIN': case 'MAX': case 'MINA': case 'MAXA':
        if (A.length === 2) return `${n.fn.startsWith('MIN') ? 'LEAST' : 'GREATEST'}(${s(0)}, ${s(1)})`;
        return this.aggCol(n.fn, A[0], env);
      case 'SUMX': case 'AVERAGEX': case 'MINX': case 'MAXX': case 'COUNTX': case 'COUNTAX': case 'PRODUCTX':
        return this.iterate(n.fn, A, env);
      case 'COUNTROWS': {
        const tv = A.length ? this.tv(A[0], env) : this.rowsOf(env.home, env.fc);
        const v = this.A('v');
        return `(SELECT CAST(NULLIF(COUNT(*), 0) AS DOUBLE) FROM (${tv.sql}) ${v})`;
      }
      case 'ISEMPTY': { const tv = this.tv(A[0], env); return `(NOT EXISTS (${tv.sql}))`; }
      case 'CONCATENATEX': {
        const tv = this.tv(A[0], env);
        const r = this.A('r');
        const renv = { ...env, rows: [...env.rows, { alias: r, t: tv, rowid: tv.base ? `${r}.__rowid` : undefined }] };
        const inner = this.scalar(A[1], renv);
        const delim = A[2] && !blank(A[2]) ? s(2) : "''";
        const order = A[3] ? ` ORDER BY ${this.scalar(A[3], renv)}${A[4]?.k === 'tbl' && A[4].name.toUpperCase() === 'DESC' ? ' DESC' : ''}` : '';
        return `(SELECT string_agg(CAST(${inner} AS VARCHAR), ${delim}${order}) FROM (${tv.sql}) ${r})`;
      }
      case 'RANKX': {
        const tv = this.tv(A[0], env);
        const r = this.A('r');
        const inner = this.scalar(A[1], { ...env, rows: [...env.rows, { alias: r, t: tv, rowid: tv.base ? `${r}.__rowid` : undefined }] });
        const cur = blank(A[2]) ? this.scalar(A[1], env) : s(2);
        const asc = A[3] && ((A[3].k === 'tbl' && A[3].name.toUpperCase() === 'ASC') || (A[3].k === 'num' && A[3].v === '1'));
        const dense = A[4]?.k === 'tbl' && A[4].name.toUpperCase() === 'DENSE';
        const cv = this.A('k');
        const cmp = `coalesce(${inner}, 0) ${asc ? '<' : '>'} coalesce(${cv}.x, 0)`;
        return `(SELECT CAST(1 + ${dense ? `COUNT(DISTINCT ${inner}) FILTER (WHERE ${cmp})` : `COUNT(*) FILTER (WHERE ${cmp})`} AS DOUBLE) FROM (${tv.sql}) ${r}, (SELECT ${cur} AS x) ${cv})`;
      }
      case 'CALCULATE': {
        if (!A[0]) throw new DaxError('CALCULATE senza espressione');
        const cenv = this.calculate(env, A.slice(1));
        return this.framed(cenv.fc, () => this.scalar(A[0], cenv));
      }
      case 'TOTALYTD': case 'TOTALQTD': case 'TOTALMTD': case 'TOTALWTD': {
        const dates: Node = { k: 'call', fn: n.fn.replace('TOTAL', 'DATES'), args: [A[1]] };
        return this.scalar(A[0], this.calculate(env, [dates, ...(A[2] && !blank(A[2]) && A[2].k !== 'str' ? [A[2]] : [])]));
      }
      case 'FIRSTDATE': case 'LASTDATE': case 'STARTOFMONTH': case 'STARTOFQUARTER': case 'STARTOFYEAR': case 'ENDOFMONTH': case 'ENDOFQUARTER': case 'ENDOFYEAR':
      case 'STARTOFWEEK': case 'ENDOFWEEK': {
        const ti = this.ti(n, env);
        if (!ti.col) throw new DaxError(`${n.fn}: il calendario non ha la categoria Data`);
        const a = this.A();
        return `(SELECT MIN(${a}.${qi(ti.col)}) FROM ${qi(ti.table)} ${a} WHERE ${ti.pred(a)})`;
      }
      case 'SELECTEDVALUE': return this.colQuery(A[0], env, (x) => `CASE WHEN COUNT(DISTINCT ${x}) = 1 AND COUNT(*) = COUNT(${x}) THEN MIN(${x}) ELSE ${opt(1, 'NULL')} END`);
      case 'SWITCH': {
        const isTrue = A[0]?.k === 'bool' && A[0].v;
        const pairs: string[] = [];
        let i = 1;
        for (; i + 1 < A.length; i += 2) pairs.push(`WHEN ${s(i)} THEN ${s(i + 1)}`);
        const els = i < A.length ? ` ELSE ${s(i)}` : '';
        return isTrue ? `(CASE ${pairs.join(' ')}${els} END)` : this.once([s(0)], ([x]) => `(CASE ${x} ${pairs.join(' ')}${els} END)`);
      }
      case 'HASONEVALUE': return this.colQuery(A[0], env, (x) => `COUNT(DISTINCT ${x}) = 1`);
      case 'HASONEFILTER': return `(${this.filtered(A[0], env, 'direct')} AND ${this.colQuery(A[0], env, (x) => `COUNT(DISTINCT ${x}) = 1`)})`;
      case 'ISFILTERED': return this.filtered(A[0], env, 'direct');
      case 'ISCROSSFILTERED': return this.filtered(A[0], env, 'cross');
      case 'ISINSCOPE': return this.filtered(A[0], env, 'scope');
      case 'RELATED': {
        if (A[0]?.k !== 'col') throw new DaxError('RELATED richiede una colonna');
        const c = this.col(A[0], env);
        const row = [...env.rows].reverse().find((r) => r.t.base);
        if (!row) throw new DaxError('RELATED può essere usata solo in un contesto di riga (colonna calcolata o iteratore)');
        return this.related(row.t.base!, row.alias, c.table, c.col, env);
      }
      case 'EARLIER': case 'EARLIEST': {
        if (A[0]?.k !== 'col') throw new DaxError(`${n.fn} richiede una colonna`);
        const skip = n.fn === 'EARLIEST' ? env.rows.length - 1 : blank(A[1]) ? 1 : Number((A[1] as { v: string }).v);
        const ref = this.rowRef(A[0], env, skip);
        if (!ref) throw new DaxError(`${n.fn}: nessun contesto di riga esterno`);
        return ref;
      }
      case 'LOOKUPVALUE': {
        if (A[0]?.k !== 'col') throw new DaxError('LOOKUPVALUE: il primo argomento deve essere una colonna');
        const res = this.col(A[0], env);
        const a = this.A();
        const conds: string[] = [];
        for (let i = 1; i + 1 < A.length; i += 2) {
          if (A[i].k !== 'col') throw new DaxError('LOOKUPVALUE: atteso colonna di ricerca, valore');
          const sc = this.col(A[i] as Extract<Node, { k: 'col' }>, env);
          if (sc.table !== res.table) throw new DaxError('LOOKUPVALUE: le colonne di ricerca devono essere della stessa tabella del risultato');
          conds.push(`${a}.${qi(sc.col)} = ${s(i + 1)}`);
        }
        return `(SELECT CASE WHEN COUNT(DISTINCT ${a}.${qi(res.col)}) <= 1 THEN MIN(${a}.${qi(res.col)}) ELSE error('LOOKUPVALUE: più valori trovati') END FROM ${qi(res.table)} ${a} WHERE ${conds.join(' AND ') || 'TRUE'})`;
      }
      case 'VALUES': case 'DISTINCT': return this.tableAsScalar(this.tv(n, env));
      case 'DIVIDE': return this.once([s(0), s(1)], ([x, y]) => `CASE WHEN ${y} IS NULL OR ${y} = 0 THEN ${opt(2, 'NULL')} ELSE ${x} / ${y} END`);
      case 'IF': case 'IF.EAGER': return `(CASE WHEN ${s(0)} THEN ${s(1)} ELSE ${opt(2, 'NULL')} END)`;
      case 'IFERROR': return `coalesce(TRY(${s(0)}), ${s(1)})`;
      case 'ISERROR': return `(TRY(${s(0)}) IS NULL)`;
      case 'BLANK': return 'NULL';
      case 'ISBLANK': return `(${s(0)} IS NULL)`;
      case 'COALESCE': return `coalesce(${A.map((_x, i) => s(i)).join(', ')})`;
      case 'AND': return `(${s(0)} AND ${s(1)})`;
      case 'OR': return `(${s(0)} OR ${s(1)})`;
      case 'NOT': return `(NOT ${s(0)})`;
      case 'TRUE': return 'TRUE';
      case 'FALSE': return 'FALSE';
      // math
      case 'ABS': return `abs(${s(0)})`;
      case 'ROUND': return `round(${s(0)}, ${opt(1, '0')})`;
      case 'ROUNDUP': { const d = opt(1, '0'); return this.once([s(0)], ([x]) => `(sign(${x}) * ceil(abs(${x}) * power(10, ${d})) / power(10, ${d}))`); }
      case 'ROUNDDOWN': case 'TRUNC': { const d = opt(1, '0'); return `(trunc(${s(0)} * power(10, ${d})) / power(10, ${d}))`; }
      case 'INT': return `floor(${s(0)})`;
      case 'MOD': return this.once([s(0), s(1)], ([x, y]) => `(${x} - ${y} * floor(${x} / ${y}))`);
      case 'QUOTIENT': return `trunc(${s(0)} / ${s(1)})`;
      case 'POWER': return `power(${s(0)}, ${s(1)})`;
      case 'SQRT': return `sqrt(${s(0)})`;
      case 'EXP': return `exp(${s(0)})`;
      case 'LN': return `ln(${s(0)})`;
      case 'LOG': return `(ln(${s(0)}) / ln(${opt(1, '10')}))`;
      case 'LOG10': return `log10(${s(0)})`;
      case 'SIGN': return `sign(${s(0)})`;
      case 'CEILING': return this.once([s(0), opt(1, '1')], ([x, y]) => `(ceil(${x} / ${y}) * ${y})`);
      case 'FLOOR': return this.once([s(0), opt(1, '1')], ([x, y]) => `(floor(${x} / ${y}) * ${y})`);
      case 'PI': return 'pi()';
      case 'RAND': return 'random()';
      case 'RANDBETWEEN': return `(${s(0)} + floor(random() * (${s(1)} - ${s(0)} + 1)))`;
      // NAMEOF('Table'[Column]) / NAMEOF([Measure]): the fully qualified name, as text (field parameters).
      case 'NAMEOF': {
        const a = A[0];
        if (a?.k === 'tbl') { const c = this.calendar(a.name); return ql(c ? `'${c.name}'` : `'${this.table(a.name).name}'`); }
        const name = a?.k !== 'col' ? null : !a.table && this.m.measures.some((m: Measure) => m.name === a.col) ? `[${a.col}]` : `'${a.table ?? env.home}'[${a.col}]`;
        if (!name) throw new DaxError('NAMEOF: atteso un riferimento a colonna o misura');
        return `'${name.replace(/'/g, "''")}'`;
      }
      case 'CONVERT': {
        const t = A[1]?.k === 'tbl' ? A[1].name.toUpperCase() : '';
        const map: Record<string, string> = { INTEGER: 'BIGINT', DOUBLE: 'DOUBLE', CURRENCY: 'DOUBLE', STRING: 'VARCHAR', BOOLEAN: 'BOOLEAN', DATETIME: 'TIMESTAMP' };
        if (!map[t]) throw new DaxError('CONVERT: tipo non supportato');
        return `TRY_CAST(${s(0)} AS ${map[t]})`;
      }
      // text
      case 'CONCATENATE': return `concat(${s(0)}, ${s(1)})`;
      case 'LEFT': return `left(CAST(${s(0)} AS VARCHAR), ${opt(1, '1')})`;
      case 'RIGHT': return `right(CAST(${s(0)} AS VARCHAR), ${opt(1, '1')})`;
      case 'MID': return `substr(CAST(${s(0)} AS VARCHAR), ${s(1)}, ${s(2)})`;
      case 'LEN': return `length(CAST(${s(0)} AS VARCHAR))`;
      case 'UPPER': return `upper(${s(0)})`;
      case 'LOWER': return `lower(${s(0)})`;
      case 'TRIM': return `trim(regexp_replace(${s(0)}, '\\s+', ' ', 'g'))`;
      case 'SUBSTITUTE': return `replace(${s(0)}, ${s(1)}, ${s(2)})`;
      case 'REPLACE': return this.once([s(0), s(1)], ([t, p]) => `concat(left(${t}, ${p} - 1), ${s(3)}, substr(${t}, ${p} + ${s(2)}))`);
      case 'SEARCH': case 'FIND': {
        const pos = n.fn === 'SEARCH' ? `instr(lower(${s(1)}), lower(${s(0)}))` : `instr(${s(1)}, ${s(0)})`;
        return this.once([pos], ([p]) => `(CASE WHEN ${p} > 0 THEN ${p} ELSE ${A[3] ? s(3) : `error('${n.fn}: testo non trovato')`} END)`);
      }
      case 'REPT': return `repeat(${s(0)}, CAST(${s(1)} AS INTEGER))`;
      case 'VALUE': return `TRY_CAST(${s(0)} AS DOUBLE)`;
      case 'EXACT': return `(${s(0)} = ${s(1)})`;
      case 'CONTAINSSTRING': return `contains(lower(${s(0)}), lower(${s(1)}))`;
      case 'CONTAINSSTRINGEXACT': return `contains(${s(0)}, ${s(1)})`;
      case 'UNICHAR': return `chr(CAST(${s(0)} AS INTEGER))`;
      case 'FORMAT': return this.once([s(0)], ([x]) => this.format(x, A[1]));
      case 'FIXED': return this.once([s(0)], ([x]) => this.format(x, { k: 'str', v: `#,0.${'0'.repeat(Number((A[1] as any)?.v ?? 2))}` }));
      // dates
      case 'DATE': return `make_date(CAST(${s(0)} AS BIGINT), CAST(${s(1)} AS BIGINT), CAST(${s(2)} AS BIGINT))`;
      case 'DATEVALUE': return `TRY_CAST(${s(0)} AS DATE)`;
      case 'TODAY': return 'current_date';
      case 'NOW': case 'UTCNOW': return 'CAST(now() AS TIMESTAMP)';
      case 'YEAR': return `year(${s(0)})`;
      case 'MONTH': return `month(${s(0)})`;
      case 'DAY': return `day(${s(0)})`;
      case 'QUARTER': return `quarter(${s(0)})`;
      case 'HOUR': return `hour(${s(0)})`;
      case 'MINUTE': return `minute(${s(0)})`;
      case 'WEEKDAY': {
        const t = opt(1, '1');
        return `(CASE ${t} WHEN 2 THEN isodow(${s(0)}) WHEN 3 THEN isodow(${s(0)}) - 1 ELSE dayofweek(${s(0)}) + 1 END)`;
      }
      case 'WEEKNUM': return `CAST(strftime(CAST(${s(0)} AS DATE), '%U') AS INTEGER) + 1`;
      case 'EOMONTH': return `last_day(CAST(${s(0)} AS DATE) + to_months(CAST(${s(1)} AS INTEGER)))`;
      case 'EDATE': return `CAST(CAST(${s(0)} AS DATE) + to_months(CAST(${s(1)} AS INTEGER)) AS DATE)`;
      case 'DATEDIFF': return `date_diff('${this.unit(A[2])}', CAST(${s(0)} AS TIMESTAMP), CAST(${s(1)} AS TIMESTAMP))`;
      case 'USERNAME': case 'USERPRINCIPALNAME': return ql(this.m.user ?? 'utente@mib-bi');
      case 'SELECTEDMEASURE': {
        const top = this.selected[this.selected.length - 1];
        if (!top) throw new DaxError('SELECTEDMEASURE si può usare solo negli elementi di calcolo');
        // The measure is compiled outside the item that references it (its own SELECTEDMEASURE is the next one out).
        const saved = this.selected.pop()!;
        try { return top.sql(env.rows.length ? this.calculate(env, []) : env); } finally { this.selected.push(saved); }
      }
      case 'SELECTEDMEASURENAME': {
        const top = this.selected[this.selected.length - 1];
        return top ? ql(top.name) : 'NULL';
      }
      case 'ISSELECTEDMEASURE': {
        const top = this.selected[this.selected.length - 1];
        return top && A.some((x) => x.k === 'col' && !x.table && eqi(x.col, top.name)) ? 'TRUE' : 'FALSE';
      }
      case 'SELECTEDMEASUREFORMATSTRING': {
        const top = this.selected[this.selected.length - 1];
        return ql((top && this.m.measures.find((x) => eqi(x.name, top.name))?.formatString) ?? '');
      }
    }
    switch (n.fn) {
      case 'ISSTRING': case 'ISTEXT': return this.typeIs(s(0), 'string');
      case 'ISNUMBER': case 'ISNUMERIC': return this.typeIs(s(0), 'int', 'double', 'decimal');
      case 'ISINT64': case 'ISINTEGER': return this.typeIs(s(0), 'int');
      case 'ISDOUBLE': return this.typeIs(s(0), 'double');
      case 'ISDECIMAL': case 'ISCURRENCY': return this.typeIs(s(0), 'decimal');
      case 'ISBOOLEAN': case 'ISLOGICAL': return this.typeIs(s(0), 'bool');
      case 'ISDATETIME': return this.typeIs(s(0), 'date');
      case 'ISNONTEXT': return `(NOT ${this.typeIs(s(0), 'string')})`;
    }
    const udf = this.expandUdf(n);
    if (udf) return this.scalar(udf, env);
    if (TABLE_FNS.has(n.fn)) return this.tableAsScalar(this.tv(n, env));
    throw new DaxError(`Funzione DAX non supportata: ${n.fn}`);
  }
}

/** Columns that identify the periods of complete category `unit` in a calendar (its primary column, or a
 *  combination such as Year + Month of Year), or null when the calendar cannot identify them. */
export function calendarKey(cal: CalendarDef, unit: string, seen: string[] = []): string[] | null {
  if (seen.includes(unit)) return null;
  const prim = (u: string) => cal.groups.find((g) => g.unit === u)?.primary;
  for (const combo of CAL_KEYS[unit] ?? []) {
    const parts: string[] = [];
    let ok = true;
    for (const c of combo) {
      const sub = c.endsWith('*') ? calendarKey(cal, c.slice(0, -1), [...seen, unit]) : prim(c) ? [prim(c)!] : null;
      if (!sub) { ok = false; break; }
      parts.push(...sub.filter((x) => !parts.includes(x)));
    }
    if (ok) return parts;
  }
  return null;
}

/* --------------------------------- public API --------------------------------- */

/** `expr` wraps the column (date hierarchy level, e.g. YEAR(col)). */
export interface FilterIn { table: string; column: string; values: string[]; expr?: (col: string) => string; range?: import('../query').RangeCond; contains?: string; textMode?: import('../query').TextMode; }
export interface GroupIn { table: string; column: string; ref: string; expr?: (col: string) => string; }

const emptyEnv = (model: Model, home: string): Env => ({ fc: { filters: [], rels: model.rels }, rows: [], vars: new Map(), home });

/** SQL of a measure evaluated under visual filters and the current group (`ref` = SQL of the group value). */
export function measureSql(model: Model, name: string, home: string, outer: FilterIn[], groups: GroupIn[]): string {
  const c = new Compiler(model);
  const m = model.measures.find((x) => x.name === name && x.table === home) ?? model.measures.find((x) => x.name === name);
  if (!m) throw new DaxError(`Misura non trovata: [${name}]`);
  const env = emptyEnv(model, m.table);
  env.fc.filters = [
    ...outer.map((f): Filt => ({ table: f.table, cols: [f.column], pred: (a) => filterSql((f.expr ?? ((x) => x))(`${a}.${qi(f.column)}`), f.values, f), tag: 'outer' })),
    ...groups.map((g): Filt => ({ table: g.table, cols: [g.column], pred: (a) => `${(g.expr ?? ((x) => x))(`${a}.${qi(g.column)}`)} IS NOT DISTINCT FROM ${g.ref}`, tag: 'group' })),
  ];
  try {
    return c.measureRef(m.name, env);
  } catch (e) {
    if (e instanceof DaxError) throw new DaxError(`Misura [${m.name}]: ${e.message.replace(/^\[[^\]]+\]: /, '')}`);
    throw e;
  }
}

/** Dynamic format string of a measure (calculation items with formatStringDefinition), or null when it is fixed. */
export function measureFormatSql(model: Model, name: string, home: string, outer: FilterIn[], groups: GroupIn[]): string | null {
  if (!model.calcGroups?.some((g) => g.items.some((i) => i.formatString?.trim()))) return null;
  const c = new Compiler(model);
  const m = model.measures.find((x) => x.name === name && x.table === home) ?? model.measures.find((x) => x.name === name);
  if (!m) return null;
  const env = emptyEnv(model, m.table);
  env.fc.filters = [
    ...outer.map((f): Filt => ({ table: f.table, cols: [f.column], pred: (a) => filterSql((f.expr ?? ((x) => x))(`${a}.${qi(f.column)}`), f.values, f), tag: 'outer' })),
    ...groups.map((g): Filt => ({ table: g.table, cols: [g.column], pred: (a) => `${(g.expr ?? ((x) => x))(`${a}.${qi(g.column)}`)} IS NOT DISTINCT FROM ${g.ref}`, tag: 'group' })),
  ];
  try { return c.formatRef(m.name, env); } catch { return null; }
}

/** Error message for a measure that cannot be compiled, or null. */
export function checkMeasure(model: Model, m: Measure): string | null {
  try { measureSql({ ...model, measures: model.measures.some((x) => x.name === m.name) ? model.measures : [...model.measures, m] }, m.name, m.table, [], []); return null; }
  catch (e) { return (e as Error).message; }
}

/** Calculated column: expression evaluated in the row context of `table` (alias `r`, real rowid). */
export function calcColumnSql(model: Model, table: string, expression: string, alias = 'r'): string {
  const c = new Compiler(model);
  const t = c.table(table);
  const env = emptyEnv(model, t.name);
  env.rows = [{ alias, t: { sql: '', cols: t.columns.map((x) => ({ name: x.name, table: t.name, col: x.name })), base: t.name }, rowid: `${alias}.rowid` }];
  return c.scalar(parse(expression), env);
}

/** Calculated table: a SELECT with plain output column names. */
export function calcTableSql(model: Model, expression: string): string {
  const c = new Compiler(model);
  const node = parse(expression);
  const env = emptyEnv(model, model.tables[0]?.name ?? '');
  if (!c.isTable(node, env)) throw new DaxError("L'espressione di una tabella calcolata deve restituire una tabella");
  const tv = c.tv(node, env);
  const v = c.A('v');
  const seen = new Set<string>();
  const sel = tv.cols.map((col) => {
    let nm = col.name, i = 2;
    while (seen.has(nm.toLowerCase())) nm = `${col.name}${i++}`;
    seen.add(nm.toLowerCase());
    return `${v}.${qi(col.name)} AS ${qi(nm)}`;
  });
  return `SELECT ${sel.join(', ')} FROM (${tv.sql}) ${v}`;
}

export interface DaxQueryResult { sql: string; columns: { name: string; display: string }[]; }

/** DAX query view: DEFINE … EVALUATE … ORDER BY …  → one SQL statement per EVALUATE. */
export function daxQuerySql(model: Model, text: string): DaxQueryResult[] {
  const q = parseQuery(text);
  const c = new Compiler(model);
  const env = emptyEnv(model, model.tables[0]?.name ?? '');
  for (const d of q.defines) {
    if (d.kind === 'measure') {
      const table = d.table ?? model.tables[0]?.name ?? '';
      c.defined.set(d.name.toLowerCase(), { table, name: d.name, node: d.expr });
    } else if (d.kind === 'function') {
      const fn = d.fn!;
      c.udfs.set(d.name.toUpperCase(), { name: d.name, def: () => fn });
    } else if (d.kind === 'var') {
      env.vars.set(d.name, c.isTable(d.expr, env) ? { t: c.tv(d.expr, env) } : { s: c.scalar(d.expr, env) });
    } else throw new DaxError(`DEFINE ${d.kind.toUpperCase()} non è supportato: usare MEASURE o VAR`);
  }
  return q.evaluates.map((ev) => {
    if (!c.isTable(ev.expr, env)) throw new DaxError("EVALUATE richiede un'espressione di tabella (es. EVALUATE { [Misura] } o EVALUATE 'Tabella')");
    const tv = c.tv(ev.expr, env);
    const r = c.A('r');
    const renv: Env = { ...env, rows: [{ alias: r, t: tv, rowid: tv.base ? `${r}.__rowid` : undefined }] };
    const order = ev.order.map((o) => `${c.scalar(o.expr, renv)} ${o.desc ? 'DESC' : 'ASC'} NULLS ${o.desc ? 'LAST' : 'FIRST'}`);
    const cols = tv.cols.map((col, i) => ({ name: `c${i}`, display: col.table && col.col ? `${col.table}[${col.col}]` : `[${col.name}]` }));
    const sel = tv.cols.map((col, i) => `${r}.${qi(col.name)} AS c${i}`);
    return { sql: `SELECT ${sel.join(', ')} FROM (${tv.sql}) ${r}${order.length ? ` ORDER BY ${order.join(', ')}` : ''}`, columns: cols };
  });
}

/**
 * Row-level security: WHERE clause (row alias `r`) of every table a role restricts. A table's rows pass its
 * own filter and the filters of the tables that reach it along relationships (one → many, like Power BI's
 * single-direction security filters).
 */
export function rlsWhere(model: Model, filters: { table: string; expression: string }[]): { table: string; where: string }[] {
  const c = new Compiler(model);
  const own = new Map<string, string>();
  for (const f of filters) {
    if (!f.expression.trim()) continue;
    const t = c.table(f.table);
    own.set(t.name, f.expression);
  }
  // Security filters flow one → many, and many → one only with "Applica filtro di sicurezza in entrambe le direzioni".
  const rels = model.rels.map((r) => ({ ...r, crossFilter: r.securityBoth && r.crossFilter === 'both' ? 'both' as const : 'single' as const }));
  const out: { table: string; where: string }[] = [];
  for (const t of model.tables) {
    const parts: string[] = [];
    for (const [F, expr] of own) {
      if (F === t.name) { parts.push(c.rowFilter(F, expr, 'r')); continue; }
      const path = c.path(rels, t.name, F);
      if (path?.length) parts.push(c.semi(path, 'r', (a) => c.rowFilter(F, expr, a)));
    }
    if (parts.length) out.push({ table: t.name, where: parts.join(' AND ') });
  }
  return out;
}

/** `node` with every call of a user-defined function replaced by the function body (visual calculations). */
export function expandUdfCalls(model: Model, node: Node): Node {
  const c = new Compiler(model);
  const go = (x: Node, depth: number): Node => {
    if (depth > 64) throw new DaxError('Troppi livelli di funzioni annidate');
    switch (x.k) {
      case 'call': { const e = c.expandUdf(x); return e ? go(e, depth + 1) : { ...x, args: x.args.map((a) => go(a, depth)) }; }
      case 'bin': return { ...x, a: go(x.a, depth), b: go(x.b, depth) };
      case 'neg': return { ...x, a: go(x.a, depth) };
      case 'let': return { ...x, vars: x.vars.map(([n, v]) => [n, go(v, depth)] as [string, Node]), body: go(x.body, depth) };
      case 'list': return { ...x, rows: x.rows.map((r) => r.map((y) => go(y, depth))) };
      default: return x;
    }
  };
  return go(node, 0);
}

/** Error of a user-defined function (syntax, recursion, body that does not compile with blank arguments), or null. */
export function checkFunction(model: Model, f: DaxFunction): string | null {
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(f.name)) return 'Nome non valido: solo lettere, cifre, _ e punti (es. Vendite.Margine)';
  if (DAX_FUNCTION_NAMES.has(f.name.toUpperCase())) return `${f.name} è il nome di una funzione DAX predefinita`;
  try {
    const c = new Compiler({ ...model, functions: [...(model.functions ?? []).filter((x) => !eqi(x.name, f.name)), f] });
    const u = c.udfs.get(f.name.toUpperCase())!;
    const def = u.def();
    const call: Node = { k: 'call', fn: f.name.toUpperCase(), args: def.params.map((p) => (p.type === 'ref' ? { k: 'call', fn: 'BLANK', args: [] } : p.def ?? { k: 'call', fn: 'BLANK', args: [] })) };
    // Reference parameters need a real model object: only syntax and recursion are checked for them.
    if (def.params.some((p) => p.mode === 'expr' && !p.def)) { c.expandUdf(call as Extract<Node, { k: 'call' }>); return null; }
    const env = emptyEnv(model, model.tables[0]?.name ?? '');
    const body = c.expandUdf(call as Extract<Node, { k: 'call' }>)!;
    if (c.isTable(body, env)) c.tv(body, env); else c.scalar(body, env);
    return null;
  } catch (e) { return (e as Error).message; }
}

/** Error of a calculation item expression (SELECTEDMEASURE() = each measure of the model), or null. */
export function checkCalcItem(model: Model, expression: string): string | null {
  try {
    const c = new Compiler({ ...model, calcGroups: [] });
    const env = emptyEnv(model, model.tables[0]?.name ?? '');
    (c as any).selected.push({ name: model.measures[0]?.name ?? '', sql: () => 'NULL' });
    c.scalar(parse(expression), env);
    return null;
  } catch (e) { return (e as Error).message; }
}
