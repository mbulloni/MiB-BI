// Runs M queries of the report: other queries resolve to their own M code (evaluated in the same run) or to the
// loaded model table, Power Query parameters to their values. A query result becomes rows for DuckDB (api.m.load),
// typed by the M column types: columns without a type load as text, like Power BI.
import type { PQParam } from '../../types';
import { locale } from '../../format';
import { Env, evaluate, runM, type Host } from './eval';
import { parseM, type Node } from './parse';
import { ErrorCell, Lazy, MDate, MDateTime, MDateTimeZone, MDuration, MError, MList, MRecord, MTable, MTime, MType, force, show } from './values';
import { library } from './lib';
import { sqlTable } from './lib/sources';
import { toText } from './lib/text';

export interface MQuerySource {
  /** Queries defined by M code (engine queries, functions, connection-only queries). */
  code: Map<string, string>;
  /** Model tables that are loaded in DuckDB (calculated tables…). */
  tables: Set<string>;
  /** Queries compiled to SQL (applied steps): SELECT text, computed on first use. */
  sql?: Map<string, () => Promise<string>>;
  params: PQParam[];
}

const DAY = 86400000;
function paramValue(p: PQParam): unknown {
  if (p.type === 'number') return Number(p.value);
  if (p.type === 'date') { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.value); if (m) return MDate.of(+m[1], +m[2], +m[3]); }
  if (p.type === 'datetime') { const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(p.value); if (m) return new MDateTime(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0))); }
  return p.value;
}

/** Resolver for names that are not in the library: queries and parameters. */
function resolver(src: MQuerySource) {
  const asts = new Map<string, Node>();
  return (name: string, host: Host): unknown | undefined => {
    const p = src.params.find((x) => x.name === name);
    if (p) return paramValue(p);
    const code = src.code.get(name);
    if (code !== undefined) {
      let ast = asts.get(name);
      if (!ast) { try { ast = parseM(code); } catch (e) { throw new MError('Expression.Error', `Query '${name}': ${(e as Error).message}`); } asts.set(name, ast); }
      const a = ast;
      return new Lazy(() => evaluate(a, new Env(new Map(), null, host)));
    }
    const sql = src.sql?.get(name);
    if (sql) return new Lazy(() => sqlTable(host.request('pqsql:' + name, sql)));
    if (src.tables.has(name)) return new Lazy(() => sqlTable(`SELECT * FROM "${name.replace(/"/g, '""')}"`));
    return undefined;
  };
}

/** Evaluates any M expression (preview of a step, Invoca…). */
export async function evaluateM(code: string, src: MQuerySource, cache?: Map<string, unknown>) {
  return runM(code, { lib: library(), resolve: resolver(src), cache }, (v) => materialize(force(v)));
}

export type LoadKind = 'text' | 'number' | 'int' | 'logical' | 'date' | 'datetime' | 'datetimezone' | 'time';
export interface Materialized {
  /** What the query returns: a table, or another value shown as text (function, record, list, scalar). */
  kind: 'table' | 'function' | 'record' | 'list' | 'value';
  columns: { name: string; kind: LoadKind }[];
  rows: unknown[][];
  /** Cells with errors per column (loaded as null). */
  errors: number[];
  /** First error message per column, for the preview. */
  errorText: (string | null)[];
  /** Plain value for scalars / function signature text. */
  text?: string;
  /** The value itself (functions: parameters for Invoca). */
  value?: unknown;
}

const kindOf = (t: MType | undefined): LoadKind => {
  if (!t) return 'text';
  switch (t.kind) {
    case 'number': return t.facet && /^(Int64|Int32|Int16|Int8|Byte)$/.test(t.facet) ? 'int' : 'number';
    case 'logical': return 'logical';
    case 'date': return 'date';
    case 'datetime': return 'datetime';
    case 'datetimezone': return 'datetimezone';
    case 'time': return 'time';
    case 'duration': return 'number';
    default: return 'text';
  }
};
const p2 = (n: number) => String(n).padStart(2, '0');
/** M value → JSON value for DuckDB of the column kind. */
function cellValue(v: unknown, kind: LoadKind, cult: string): unknown {
  if (v === null || v === undefined) return null;
  switch (kind) {
    case 'number': case 'int':
      if (typeof v === 'number') return Number.isFinite(v) ? (kind === 'int' ? Math.round(v) : v) : null;
      if (v instanceof MDuration) return v.ms / DAY;
      if (typeof v === 'boolean') return v ? 1 : 0;
      return null;
    case 'logical': return typeof v === 'boolean' ? v : null;
    case 'date': return v instanceof MDate ? v.toString() : v instanceof MDateTime ? v.date.toString() : null;
    case 'datetime': return v instanceof MDateTime ? new Date(v.ms).toISOString().replace('T', ' ').replace('Z', '') : v instanceof MDate ? `${v} 00:00:00` : null;
    case 'datetimezone': return v instanceof MDateTimeZone ? new Date(v.utc).toISOString() : null;
    case 'time': return v instanceof MTime ? `${p2(v.h)}:${p2(v.mi)}:${p2(Math.floor(v.s))}` : null;
    default:
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean' || v instanceof MDate || v instanceof MDateTime || v instanceof MDateTimeZone || v instanceof MTime || v instanceof MDuration) return toText(v, cult);
      return show(v);
  }
}

/** Forces a value into loadable rows (inside the evaluation run, so lazy cells may still load data). */
export function materialize(v: unknown): Materialized {
  const cult = locale();
  if (v instanceof MTable) {
    const kinds = v.columns.map((_, i) => kindOf(v.typeOf(i)));
    const errors = v.columns.map(() => 0), errorText: (string | null)[] = v.columns.map(() => null);
    const rows = v.rows.map((r) => r.map((c, i) => {
      let x: unknown;
      try { x = force(c); } catch (e) { if (!(e instanceof MError)) throw e; x = new ErrorCell(e); }
      if (x instanceof ErrorCell) { errors[i]++; errorText[i] ??= x.error.message; return null; }
      return cellValue(x, kinds[i], cult);
    }));
    return { kind: 'table', columns: v.columns.map((name, i) => ({ name, kind: kinds[i] })), rows, errors, errorText };
  }
  const kind = v instanceof MRecord ? 'record' : v instanceof MList ? 'list' : v && typeof v === 'object' && 'call' in (v as object) ? 'function' : 'value';
  if (v instanceof MList) {
    const vals = v.values();
    return { kind, columns: [{ name: 'Value', kind: 'text' }], rows: vals.map((x) => [cellValue(x, 'text', cult)]), errors: [0], errorText: [null], value: v };
  }
  if (v instanceof MRecord) {
    return { kind, columns: [{ name: 'Name', kind: 'text' }, { name: 'Value', kind: 'text' }], rows: v.names.map((n, i) => [n, cellValue(force(v.vals[i]), 'text', cult)]), errors: [0, 0], errorText: [null, null], value: v };
  }
  const k: LoadKind = typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'logical' : v instanceof MDate ? 'date' : v instanceof MDateTime ? 'datetime' : 'text';
  return { kind, columns: [{ name: 'Value', kind: k }], rows: kind === 'function' ? [] : [[cellValue(v, k, cult)]], errors: [0], errorText: [null], text: show(v), value: v };
}

/** Evaluates a query's M code and returns loadable rows. */
export async function runQuery(name: string, src: MQuerySource, cache?: Map<string, unknown>): Promise<Materialized> {
  const code = src.code.get(name);
  if (code === undefined) throw new MError('Expression.Error', `Query '${name}' non trovata.`);
  return evaluateM(code, src, cache);
}

/** M query results materialized in DuckDB for SQL queries that reference them (preview in the editor). */
const temp = new Map<string, Promise<string>>();
export function mTempTable(code: string, src: MQuerySource): Promise<string> {
  let p = temp.get(code);
  if (!p) {
    p = (async () => {
      const r = await evaluateM(code, src);
      if (r.kind === 'function') throw new MError('Expression.Error', 'La query restituisce una funzione, non una tabella.');
      const name = '__m_' + Math.abs([...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36);
      const { api } = await import('../../api');
      await api.m.load(name, r.columns, r.rows);
      return `"${name}"`;
    })();
    p.catch(() => temp.delete(code));
    temp.set(code, p);
  }
  return p;
}
export const clearMTemp = () => temp.clear();
