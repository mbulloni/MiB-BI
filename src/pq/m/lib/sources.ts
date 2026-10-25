// Data sources of the M interpreter: File/Folder, Csv, Excel, Parquet, Xml, Web, OData, databases.
// Every access goes through the current Host (cached per refresh; the first call suspends the evaluation).
import { api } from '../../../api';
import type { DbConnection, DbKind } from '../../../types';
import { currentHost } from '../eval';
import { Lazy, MBinary, MDate, MDateTime, MDateTimeZone, MDuration, MList, MRecord, MTable, MTime, MType, TYPE, err } from '../values';
import { type Lib, bin, def, items, num, opt, rec, text, textN } from './core';

const ql = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const enc = (b: MBinary | string) => (typeof b === 'string' ? b : new TextDecoder(b.bytes[0] === 0xff && b.bytes[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(b.bytes).replace(/^﻿/, ''));

/* ------------------------------- DuckDB results → M ------------------------------- */

/** M type of a DuckDB column type. */
export function duckType(t: string): MType {
  const u = t.toUpperCase();
  if (/^(BIGINT|INTEGER|SMALLINT|TINYINT|HUGEINT|UBIGINT|UINTEGER|USMALLINT|UTINYINT)$/.test(u)) return TYPE.int64;
  if (/^(DOUBLE|FLOAT|REAL)$/.test(u)) return TYPE.number;
  if (u.startsWith('DECIMAL')) return TYPE.decimal;
  if (u === 'BOOLEAN') return TYPE.logical;
  if (u === 'DATE') return TYPE.date;
  if (u.startsWith('TIMESTAMP WITH') || u === 'TIMESTAMPTZ') return TYPE.datetimezone;
  if (u.startsWith('TIMESTAMP')) return TYPE.datetime;
  if (u.startsWith('TIME')) return TYPE.time;
  if (u === 'INTERVAL') return TYPE.duration;
  if (u === 'BLOB') return TYPE.binary;
  return TYPE.text;
}
const DAY = 86400000;
/** JSON value of a DuckDB cell → M value. */
export function duckValue(t: MType, v: unknown): unknown {
  if (v === null || v === undefined) return null;
  switch (t.kind) {
    case 'number': return Number(v);
    case 'logical': return v === true || v === 'true';
    case 'date': { const [y, m, d] = String(v).split('-').map(Number); return MDate.of(y, m, d); }
    case 'datetime': return new MDateTime(Date.parse(String(v).replace(' ', 'T') + 'Z'));
    case 'datetimezone': { const s = String(v); const ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')); const m = /([+-])(\d\d)(?::?(\d\d))?$/.exec(s); const off = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0)) : 0; return new MDateTimeZone(ms + off * 60000, off); }
    case 'time': { const [h, mi, s] = String(v).split(':').map(Number); return new MTime(((h * 60 + mi) * 60 + s) * 1000); }
    case 'duration': { const o = v as { months: number; days: number; micros: string }; return new MDuration((o.months * 30 + o.days) * DAY + Number(o.micros) / 1000); }
    case 'binary': return new MBinary(new TextEncoder().encode(String(v)));
    default: return typeof v === 'string' ? v : JSON.stringify(v);
  }
}
/** Runs SQL in DuckDB (through the host) and returns an M table with typed columns. */
export function sqlTable(sql: string, renameTo?: string[]): MTable {
  const r = currentHost().request('sql:' + sql, () => api.m.sql(sql));
  const types = r.columns.map((c) => duckType(c.type));
  const cols = renameTo ?? r.columns.map((c) => c.name);
  return new MTable(cols, r.rows.map((row) => row.map((v, i) => duckValue(types[i], v))), types);
}

/* ------------------------------- CSV ------------------------------- */

/** CSV text → rows of texts (QuoteStyle.Csv = quotes may contain delimiters and line breaks). */
function parseCsv(s: string, delim: string, quoted: boolean): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"' && quoted && cur === '') { q = true; continue; }
    if (s.startsWith(delim, i)) { row.push(cur); cur = ''; i += delim.length - 1; continue; }
    if (c === '\r' || c === '\n') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; continue; }
    cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

const ENCODINGS: Record<number, string> = { 65001: 'utf-8', 1200: 'utf-16', 1252: 'latin-1', 28591: 'latin-1', 20127: 'utf-8' };

function csvDocument(source: unknown, columns: unknown, delimiter: unknown, _extra: unknown, encoding: unknown): MTable {
  const o = columns instanceof MRecord ? columns : null;
  const delim = textN(o ? opt(o, 'Delimiter', ',') : delimiter ?? ',') ?? ',';
  const quoteStyle = o ? opt(o, 'QuoteStyle', 0) : 1;
  const ncols = o ? opt(o, 'Columns', null) : columns;
  const encode = o ? opt(o, 'Encoding', encoding ?? 65001) : encoding ?? 65001;
  const names: string[] | null = ncols === null ? null : typeof ncols === 'number' ? Array.from({ length: ncols }, (_, i) => `Column${i + 1}`) : ncols instanceof MList ? items(ncols).map(text) : ncols instanceof MType && ncols.columns ? ncols.columns.map((c) => c.name) : null;
  // Local files: DuckDB reads them (fast, any size), every column as text like Csv.Document.
  if (source instanceof MBinary && source.path) {
    const path = source.path();
    const sql = `SELECT * FROM read_csv(${ql(path)}, header = false, all_varchar = true, delim = ${ql(delim === '#(tab)' ? '\t' : delim)}, quote = ${ql(quoteStyle === 1 || quoteStyle === null ? '"' : '')}, escape = '"', null_padding = true, strict_mode = false, auto_detect = false, columns = ${duckColumnsSpec(path, delim, names, quoteStyle === 1 || quoteStyle === null)}, encoding = ${ql(ENCODINGS[num(encode)] ?? 'utf-8')}, nullstr = '\u0001')`;
    const t = sqlTable(sql);
    return new MTable(t.columns.map((_, i) => names?.[i] ?? `Column${i + 1}`), t.rows.map((r) => r.map((v) => v ?? '')));
  }
  const rows = parseCsv(source instanceof MBinary ? enc(source) : text(source), delim, quoteStyle === 1 || quoteStyle === null);
  const n = names?.length ?? Math.max(0, ...rows.map((r) => r.length));
  return new MTable(names ?? Array.from({ length: n }, (_, i) => `Column${i + 1}`), rows.map((r) => Array.from({ length: n }, (_, i) => r[i] ?? (i < r.length ? '' : null))));
}
/** Explicit read_csv columns (count sniffed from the first 256 KB when not given, quotes respected). */
function duckColumnsSpec(path: string, delim: string, names: string[] | null, quoted: boolean): string {
  let n = names?.length ?? 0;
  if (!n) {
    const head = currentHost().request(`head:${path}`, () => api.m.head(path, 262144));
    const text = new TextDecoder().decode(head);
    const rows = parseCsv(text.slice(0, text.lastIndexOf('\n') + 1 || text.length), delim, quoted);
    n = Math.max(1, ...rows.map((r) => r.length));
  }
  return '{' + Array.from({ length: n }, (_, i) => `'Column${i + 1}': 'VARCHAR'`).join(', ') + '}';
}

/* ------------------------------- XML ------------------------------- */

function xmlTables(src: unknown): MTable {
  const doc = new DOMParser().parseFromString(src instanceof MBinary ? enc(src) : text(src), 'application/xml');
  if (doc.querySelector('parsererror')) throw err('Documento XML non valido.', 'DataFormat.Error');
  return elementTable([doc.documentElement]);
}
/** Elements → table like Xml.Tables: attributes (Attribute:x) and simple children become columns, repeated/complex children nested tables. */
function elementTable(els: Element[]): MTable {
  const cols: string[] = [];
  const add = (c: string) => { if (!cols.includes(c)) cols.push(c); };
  const rows = els.map((el) => {
    const o: Record<string, unknown> = {};
    for (const a of [...el.attributes]) { add('Attribute:' + a.name); o['Attribute:' + a.name] = a.value; }
    const kids = [...el.children];
    const groups = new Map<string, Element[]>();
    for (const k of kids) { const g = groups.get(k.tagName); if (g) g.push(k); else groups.set(k.tagName, [k]); }
    for (const [tag, g] of groups) {
      add(tag);
      const simple = g.length === 1 && !g[0].children.length && !g[0].attributes.length;
      o[tag] = simple ? g[0].textContent : new Lazy(() => elementTable(g));
    }
    if (!kids.length && el.textContent?.trim()) { add('Element:Text'); o['Element:Text'] = el.textContent; }
    return o;
  });
  return new MTable(cols, rows.map((o) => cols.map((c) => (c in o ? o[c] : null))));
}
function xmlDocument(src: unknown): MTable {
  const doc = new DOMParser().parseFromString(src instanceof MBinary ? enc(src) : text(src), 'application/xml');
  if (doc.querySelector('parsererror')) throw err('Documento XML non valido.', 'DataFormat.Error');
  const node = (el: Element): unknown[] => [el.localName, el.namespaceURI ?? '', new Lazy(() => new MTable(['Name', 'Namespace', 'Value', 'Attributes'], [...el.children].map(node))), new MTable(['Name', 'Namespace', 'Value'], [...el.attributes].map((a) => [a.localName, a.namespaceURI ?? '', a.value]))];
  const root = doc.documentElement;
  const leaf = (el: Element): unknown[] => (el.children.length ? node(el) : [el.localName, el.namespaceURI ?? '', el.textContent, new MTable(['Name', 'Namespace', 'Value'], [...el.attributes].map((a) => [a.localName, a.namespaceURI ?? '', a.value]))]);
  void leaf;
  return new MTable(['Name', 'Namespace', 'Value', 'Attributes'], [node(root)]);
}

/* ------------------------------- databases ------------------------------- */

/** Navigation table of a database connection (Schema, Item, Kind, Data), or the result of a native Query. */
function database(c: DbConnection, options: unknown): MTable {
  const query = options instanceof MRecord && options.has('Query') ? textN(options.get('Query')) : null;
  if (query) return sourceTable({ ...c, schema: '', table: '', query });
  const list = currentHost().request('db:' + JSON.stringify(c), () => api.dbConnect(c, null, false).catch((e: Error) => {
    throw new Error(`DataSource.Error: ${e.message}. Collegarsi una volta da Ottieni dati › Database salvando le credenziali.`);
  }));
  return new MTable(['Name', 'Data', 'Schema', 'Item', 'Kind'], list.tables.map((t) => [t.table, new Lazy(() => sourceTable({ ...c, schema: t.schema, table: t.table })), t.schema, t.table, t.view ? 'View' : 'Table']));
}
function sourceTable(db: DbConnection & { schema: string; table: string; query?: string }): MTable {
  const expr = currentHost().request('dbexpr:' + JSON.stringify(db), () => api.sourceExpr({ path: '', db }));
  return sqlTable(`SELECT * FROM ${expr}`);
}

/* ------------------------------- registration ------------------------------- */

export function register(lib: Lib) {
  const host = () => currentHost();
  const fileBinary = (p: string) => new MBinary(() => host().request('file:' + p, () => api.m.file(p)), () => p);

  def(lib, 'File.Contents', ['path', 'options?'], (p) => fileBinary(text(p)));
  const folder = (recursive: boolean) => (p: unknown): MTable => {
    const list = host().request(`folder:${recursive}:${text(p)}`, () => api.m.folder(text(p), recursive));
    const toDT = (ms: number) => new MDateTime(ms - new Date(ms).getTimezoneOffset() * 60000);
    return new MTable(['Content', 'Name', 'Extension', 'Date accessed', 'Date modified', 'Date created', 'Attributes', 'Folder Path'], list.map((f) => [
      f.dir ? new Lazy(() => folder(false)(f.path)) : fileBinary(f.path),
      f.name, f.ext ?? '', toDT(f.atime), toDT(f.mtime), toDT(f.ctime),
      MRecord.from({ 'Content Type': '', Kind: f.dir ? 'Folder' : 'File', Size: f.size, ReadOnly: false, Hidden: f.hidden, Directory: !!f.dir }),
      f.folder,
    ]));
  };
  def(lib, 'Folder.Files', ['path', 'options?'], folder(true));
  def(lib, 'Folder.Contents', ['path', 'options?'], folder(false));
  def(lib, 'Csv.Document', ['source', 'columns?', 'delimiter?', 'extraValues?', 'encoding?'], csvDocument);
  def(lib, 'Excel.Workbook', ['workbook', 'useHeaders?', 'delayTypes?'], (wb, headers) => {
    const b = bin(wb);
    if (!b.path) throw err('Excel.Workbook: il contenuto deve provenire da un file o da un indirizzo web.', 'DataFormat.Error');
    const path = b.path();
    const sheets = host().request('xlsx:' + path, () => api.m.xlsxSheets(path));
    const data = (sheet: string) => new Lazy(() => {
      // Typed values with header names, then turned back into Column1..N with the header row first (useHeaders = false).
      const t = sqlTable(`SELECT * FROM read_xlsx(${ql(path)}, sheet = ${ql(sheet)}, header = true, ignore_errors = true)`);
      if (headers === true) return t;
      return new MTable(t.columns.map((_, i) => `Column${i + 1}`), [[...t.columns], ...t.rows]);
    });
    return new MTable(['Name', 'Data', 'Item', 'Kind', 'Hidden'], sheets.map((s) => [s.name, data(s.name), s.name, 'Sheet', s.hidden]));
  });
  def(lib, 'Excel.CurrentWorkbook', [], () => new MTable(['Name', 'Content'], []));
  def(lib, 'Parquet.Document', ['binary', 'options?'], (b) => { const p = bin(b).path; if (!p) throw err('Parquet.Document: serve un file.'); return sqlTable(`SELECT * FROM read_parquet(${ql(p())})`); });
  def(lib, 'Xml.Tables', ['contents', 'options?', 'encoding?'], (c) => xmlTables(c));
  def(lib, 'Xml.Document', ['contents', 'encoding?'], (c) => xmlDocument(c));
  def(lib, 'Web.Contents', ['url', 'options?'], (u, o) => {
    const opts: Record<string, unknown> = {};
    if (o instanceof MRecord) {
      for (const k of ['RelativePath', 'Content', 'Timeout', 'IsRetry']) if (o.has(k)) opts[k] = o.get(k) instanceof MBinary ? enc(o.get(k)) : o.get(k);
      if (o.has('Query')) opts.Query = Object.fromEntries(rec(o.get('Query')).names.map((n) => [n, String(rec(o.get('Query')).get(n))]));
      if (o.has('Headers')) opts.Headers = Object.fromEntries(rec(o.get('Headers')).names.map((n) => [n, String(rec(o.get('Headers')).get(n))]));
      if (o.has('ManualStatusHandling')) opts.ManualStatusHandling = items(o.get('ManualStatusHandling')).map(num);
    }
    const fetched = () => host().request(`web:${text(u)}|${JSON.stringify(opts)}`, () => api.m.web(text(u), opts));
    return new MBinary(() => host().request('file:' + fetched().path, () => api.m.file(fetched().path)), () => fetched().path);
  });
  def(lib, 'OData.Feed', ['serviceUri', 'headers?', 'options?'], (u) => {
    const expr = host().request('odata:' + text(u), () => api.sourceExpr({ path: '', odata: { url: text(u) } }));
    return sqlTable(`SELECT * FROM ${expr}`);
  });
  const dbFn = (name: string, kind: DbKind, args: (a: any[]) => Partial<DbConnection>) =>
    def(lib, name, ['server', 'database?', 'options?'], (...a: any[]) => database({ kind, ...args(a) } as DbConnection, a.find((x) => x instanceof MRecord)));
  dbFn('Sql.Database', 'sqlserver', ([s, d]) => ({ host: text(s), database: textN(d) ?? undefined }));
  dbFn('Sql.Databases', 'sqlserver', ([s]) => ({ host: text(s) }));
  dbFn('MySQL.Database', 'mysql', ([s, d]) => ({ host: text(s).split(':')[0], port: text(s).split(':')[1], database: textN(d) ?? undefined }));
  dbFn('PostgreSQL.Database', 'postgres', ([s, d]) => ({ host: text(s).split(':')[0], port: text(s).split(':')[1], database: textN(d) ?? undefined }));
  dbFn('Oracle.Database', 'oracle', ([s]) => ({ host: text(s) }));
  dbFn('Snowflake.Databases', 'snowflake', ([s, w]) => ({ host: text(s), warehouse: textN(w) ?? undefined }));
  dbFn('AmazonRedshift.Database', 'postgres', ([s, d]) => ({ host: text(s).split(':')[0], port: text(s).split(':')[1] ?? '5439', database: textN(d) ?? undefined, variant: 'redshift' }));
  def(lib, 'Odbc.DataSource', ['connectionString', 'options?'], (cs, o) => database({ kind: 'odbc', host: typeof cs === 'string' ? cs : rec(cs).names.map((n) => `${n}=${rec(cs).get(n)}`).join(';') } as DbConnection, o));
  def(lib, 'Odbc.Query', ['connectionString', 'query', 'options?'], (cs, q) => sourceTable({ kind: 'odbc', host: typeof cs === 'string' ? cs : rec(cs).names.map((n) => `${n}=${rec(cs).get(n)}`).join(';'), schema: '', table: '', query: text(q) } as never));
  def(lib, 'Pdf.Tables', ['pdf', 'options?'], () => { throw err('Pdf.Tables non è supportato da MiB-BI: esportare le tabelle del PDF in CSV o Excel.', 'Expression.Error'); });
  def(lib, 'Web.Page', ['html'], () => { throw err('Web.Page non è supportato da MiB-BI: usare un\'API che restituisce JSON o CSV.', 'Expression.Error'); });
  def(lib, 'Web.BrowserContents', ['url', 'options?'], () => { throw err('Web.BrowserContents non è supportato da MiB-BI.', 'Expression.Error'); });
}
