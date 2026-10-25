// Value.*, Type.*, type constants, Splitter.*, Combiner.*, Comparer.*, Replacer.*, enumerations,
// Error.*, Function.*, Diagnostics.*, Json.*, Lines.*, Binary.*, BinaryFormat (partial), Uri.*, Expression.*.
import { parseM } from '../parse';
import { Env, add, concat, div, evaluate, invoke, mul, sub } from '../eval';
import { MBinary, MError, MFunction, MList, MRecord, MTable, MType, TYPE, compare, conforms, equals, force, typeOfValue } from '../values';
import { type Lib, ORDINAL, ORDINAL_IC, bin, call, cell, culture, def, err, fn, items, names, num, numN, opt, rec, text, textN, typ } from './core';
import { toText } from './text';
import { fromRecords } from './table';
import { convertTo } from './convert';

const L = (a: unknown[]) => new MList(a);

/* ------------------------------- JSON ------------------------------- */

export function jsonToM(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return L(v.map(jsonToM));
  if (typeof v === 'object') return MRecord.from(Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonToM(x)])));
  return v;
}
function mToJson(v: unknown): unknown {
  v = force(v);
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof MList) return v.values().map(mToJson);
  if (v instanceof MRecord) return Object.fromEntries(v.names.map((n) => [n, mToJson(v.get(n))]));
  if (v instanceof MTable) return v.rows.map((r) => Object.fromEntries(v.columns.map((c, i) => [c, mToJson(cell(r[i]))])));
  return String(v);
}
const decode = (b: MBinary | string) => (typeof b === 'string' ? b : new TextDecoder(b.bytes[0] === 0xff && b.bytes[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(b.bytes).replace(/^﻿/, ''));

/* ------------------------------- splitters ------------------------------- */

const splitter = (f: (s: string) => string[]) => new MFunction([{ name: 'line' }], (a) => { const s = force(a[0]); return s === null ? L([null]) : L(f(text(s))); });
const QUOTE_CSV = 1;
/** Split honoring "quoted" parts (QuoteStyle.Csv). */
function splitQuoted(s: string, d: string): string[] {
  const out: string[] = []; let cur = '', q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') { q = true; continue; }
    if (s.startsWith(d, i)) { out.push(cur); cur = ''; i += d.length - 1; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

export function register(lib: Lib) {
  /* ---- type constants ---- */
  const types: Record<string, MType> = {
    Any: TYPE.any, None: TYPE.none, Null: TYPE.null, Logical: TYPE.logical, Number: TYPE.number, Text: TYPE.text, Date: TYPE.date, DateTime: TYPE.datetime,
    DateTimeZone: TYPE.datetimezone, Time: TYPE.time, Duration: TYPE.duration, Binary: TYPE.binary, List: TYPE.list, Record: TYPE.record, Table: TYPE.table,
    Function: TYPE.function, Type: TYPE.type, Int64: TYPE.int64, Int32: TYPE.int32, Int16: TYPE.int16, Int8: TYPE.int8, Byte: TYPE.byte, Double: TYPE.double,
    Single: TYPE.single, Decimal: TYPE.decimal, Currency: TYPE.currency, Percentage: TYPE.percentage, Character: TYPE.character, Guid: TYPE.guid, Uri: TYPE.uri,
    Password: TYPE.text, WebMethod: TYPE.text, Action: new MType('action'),
  };
  for (const [k, v] of Object.entries(types)) lib.set(`${k}.Type`, v);
  lib.set('Logical.Type', TYPE.logical);

  /* ---- enumerations ---- */
  const enums: Record<string, Record<string, number>> = {
    Order: { Ascending: 0, Descending: 1 }, JoinKind: { Inner: 0, LeftOuter: 1, RightOuter: 2, FullOuter: 3, LeftAnti: 4, RightAnti: 5, LeftSemi: 6, RightSemi: 7 },
    JoinAlgorithm: { Dynamic: 0, PairwiseHash: 1, SortMerge: 2, LeftHash: 3, RightHash: 4, LeftIndex: 5, RightIndex: 6 },
    GroupKind: { Local: 0, Global: 1 }, MissingField: { Error: 0, Ignore: 1, UseNull: 2 }, Occurrence: { First: 0, Last: 1, All: 2, Optional: 0, Required: 1, Repeating: 2 },
    QuoteStyle: { None: 0, Csv: 1 }, ExtraValues: { List: 0, Error: 1, Ignore: 2 }, RoundingMode: { Up: 0, Down: 1, AwayFromZero: 2, TowardZero: 3, ToEven: 4 },
    RelativePosition: { FromStart: 0, FromEnd: 1 }, TextEncoding: { Utf8: 65001, Utf16: 1200, Ascii: 20127, Unicode: 1200, BigEndianUnicode: 1201, Windows: 1252 },
    CsvStyle: { QuoteAfterDelimiter: 0, QuoteAlways: 1 }, PercentileMode: { ExcelInc: 1, ExcelExc: 2, SqlDisc: 3, SqlCont: 4 },
    Precision: { Double: 0, Decimal: 1 }, LimitClauseKind: { None: 0, Top: 1, Limit: 2, LimitOffset: 3, AnsiSql2008: 4 },
  };
  for (const [ns, vals] of Object.entries(enums)) for (const [k, v] of Object.entries(vals)) lib.set(`${ns}.${k}`, v);

  /* ---- comparers / replacers ---- */
  lib.set('Comparer.Ordinal', ORDINAL);
  lib.set('Comparer.OrdinalIgnoreCase', ORDINAL_IC);
  def(lib, 'Comparer.FromCulture', ['culture', 'ignoreCase?'], (_c, ic) => (ic === true ? ORDINAL_IC : ORDINAL));
  def(lib, 'Comparer.Equals', ['comparer', 'x', 'y'], (c, x, y) => num(call(c, x, y)) === 0);
  def(lib, 'Replacer.ReplaceText', ['text', 'old', 'new'], (s, o, n) => (s === null ? null : typeof s !== 'string' ? s : text(o) === '' ? s : s.split(text(o)).join(textN(n) ?? '')));
  def(lib, 'Replacer.ReplaceValue', ['value', 'old', 'new'], (v, o, n) => (equals(v, o) ? n : v));

  /* ---- splitters ---- */
  def(lib, 'Splitter.SplitTextByDelimiter', ['delimiter', 'quoteStyle?'], (d, q) => splitter((s) => (q === QUOTE_CSV ? splitQuoted(s, text(d)) : s.split(text(d)))));
  def(lib, 'Splitter.SplitTextByAnyDelimiter', ['delimiters', 'quoteStyle?', 'startAtEnd?'], (ds) => { const set = names(ds); return splitter((s) => { const out: string[] = []; let cur = ''; for (let i = 0; i < s.length; i++) { const hit = set.find((d) => s.startsWith(d, i)); if (hit) { out.push(cur); cur = ''; i += hit.length - 1; } else cur += s[i]; } out.push(cur); return out; }); });
  def(lib, 'Splitter.SplitTextByEachDelimiter', ['delimiters', 'quoteStyle?', 'startAtEnd?'], (ds, _q, end) => { const dl = names(ds); return splitter((s) => {
    const out: string[] = []; let rest = s;
    if (end === true) { const parts: string[] = []; for (const d of [...dl].reverse()) { const i = rest.lastIndexOf(d); if (i < 0) break; parts.unshift(rest.slice(i + d.length)); rest = rest.slice(0, i); } return [rest, ...parts]; }
    for (const d of dl) { const i = rest.indexOf(d); if (i < 0) break; out.push(rest.slice(0, i)); rest = rest.slice(i + d.length); }
    out.push(rest); return out;
  }); });
  def(lib, 'Splitter.SplitTextByLengths', ['lengths', 'startAtEnd?'], (ls) => { const lens = items(ls).map(num); return splitter((s) => { const out: string[] = []; let i = 0; for (const n of lens) { out.push(s.slice(i, i + n)); i += n; } return out; }); });
  def(lib, 'Splitter.SplitTextByPositions', ['positions', 'startAtEnd?'], (ps) => { const pos = items(ps).map(num); return splitter((s) => pos.map((p, k) => s.slice(p, k + 1 < pos.length ? pos[k + 1] : undefined))); });
  def(lib, 'Splitter.SplitTextByRepeatedLengths', ['length', 'startAtEnd?'], (n) => splitter((s) => { const out: string[] = []; for (let i = 0; i < s.length; i += num(n)) out.push(s.slice(i, i + num(n))); return out.length ? out : ['']; }));
  def(lib, 'Splitter.SplitTextByWhitespace', ['quoteStyle?'], () => splitter((s) => s.split(/\s+/).filter((x) => x)));
  def(lib, 'Splitter.SplitTextByCharacterTransition', ['before', 'after'], (b, a) => {
    const test = (spec: unknown) => (spec instanceof MFunction ? (c: string) => call(spec, c) === true : ((set) => (c: string) => set.has(c))(new Set(items(spec).map(text))));
    const tb = test(b), ta = test(a);
    return splitter((s) => { const out: string[] = []; let cur = ''; const cs = [...s]; cs.forEach((c, i) => { if (i > 0 && tb(cs[i - 1]) && ta(c)) { out.push(cur); cur = ''; } cur += c; }); out.push(cur); return out; });
  });
  def(lib, 'Splitter.SplitByNothing', [], () => new MFunction([{ name: 'v' }], (a) => L([force(a[0])])));

  /* ---- combiners ---- */
  const combiner = (f: (a: string[]) => string) => new MFunction([{ name: 'texts' }], (a) => f(items(a[0]).map((x) => (x === null ? '' : String(toText(x, culture(null)))))));
  def(lib, 'Combiner.CombineTextByDelimiter', ['delimiter', 'quoteStyle?'], (d, q) => combiner((a) => a.map((x) => (q === QUOTE_CSV && /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x)).join(text(d))));
  def(lib, 'Combiner.CombineTextByEachDelimiter', ['delimiters', 'quoteStyle?'], (ds) => { const dl = names(ds); return combiner((a) => a.map((x, i) => x + (i < a.length - 1 ? dl[i] ?? '' : '')).join('')); });
  def(lib, 'Combiner.CombineTextByLengths', ['lengths', 'template?'], (ls) => { const lens = items(ls).map(num); return combiner((a) => a.map((x, i) => x.padEnd(lens[i] ?? 0).slice(0, lens[i] ?? x.length)).join('')); });
  def(lib, 'Combiner.CombineTextByPositions', ['positions', 'template?'], (ps) => { const pos = items(ps).map(num); return combiner((a) => { let s = ''; a.forEach((x, i) => { s = s.padEnd(pos[i] ?? s.length); s = s.slice(0, pos[i] ?? s.length) + x; }); return s; }); });
  def(lib, 'Combiner.CombineTextByRanges', ['ranges', 'template?'], (rs) => combiner((a) => { let s = ''; items(rs).forEach((r, i) => { const [p, n] = items(r).map(num); s = s.padEnd(p); s = s.slice(0, p) + (a[i] ?? '').slice(0, n); }); return s; }));

  /* ---- Value ---- */
  const V = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Value.' + n, p, f);
  V('Type', ['value'], (v) => typeOfValue(v));
  V('Is', ['value', 'type'], (v, t) => conforms(v, typ(t)));
  V('As', ['value', 'type'], (v, t) => { if (!conforms(v, typ(t))) throw err(`Impossibile convertire il valore nel tipo ${typ(t).kind}.`); return v; });
  V('Equals', ['value1', 'value2', 'precision?'], (a, b) => equals(a, b));
  V('NullableEquals', ['value1', 'value2', 'precision?'], (a, b) => (a === null || b === null ? null : equals(a, b)));
  V('Compare', ['value1', 'value2', 'precision?'], (a, b) => compare(a, b));
  V('Add', ['value1', 'value2', 'precision?'], (a, b) => add(a, b));
  V('Subtract', ['value1', 'value2', 'precision?'], (a, b) => sub(a, b));
  V('Multiply', ['value1', 'value2', 'precision?'], (a, b) => mul(a, b));
  V('Divide', ['value1', 'value2', 'precision?'], (a, b) => div(a, b));
  V('ReplaceType', ['value', 'type'], (v, t) => {
    const ty = typ(t);
    if (v instanceof MTable && ty.columns) return new MTable(ty.columns.length === v.columns.length ? ty.columns.map((c) => c.name) : v.columns, v.rows, ty.columns.map((c) => c.type));
    return v;
  });
  V('Metadata', ['value'], () => MRecord.from({}));
  V('RemoveMetadata', ['value', 'metaValue?'], (v) => v);
  V('ReplaceMetadata', ['value', 'metaValue'], (v) => v);
  V('FromText', ['text', 'culture?'], (s, c) => {
    if (s === null) return null;
    const t = text(s).trim();
    for (const ty of [TYPE.number, TYPE.datetime, TYPE.date, TYPE.logical]) { try { return convertTo(t, ty, culture(c)); } catch { /* next */ } }
    return text(s);
  });
  V('Optimize', ['value'], (v) => v);
  V('Firewall', ['key'], () => null);
  V('Alternates', ['alternates'], (a) => a);
  V('Lineage', ['value'], () => null);
  V('Expression', ['value'], () => null);
  V('NativeQuery', ['target', 'query', 'parameters?', 'options?'], () => { throw err('Value.NativeQuery: usare Opzioni avanzate › Istruzione SQL della connessione al database.', 'Expression.Error'); });

  /* ---- Type ---- */
  const Ty = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Type.' + n, p, f);
  Ty('Is', ['type1', 'type2'], (a, b) => typ(b).kind === 'any' || typ(a).kind === typ(b).kind);
  Ty('IsNullable', ['type'], (t) => typ(t).nullable || typ(t).kind === 'any' || typ(t).kind === 'null');
  Ty('NonNullable', ['type'], (t) => Object.assign(Object.create(Object.getPrototypeOf(typ(t))), typ(t), { nullable: false }));
  Ty('ListItem', ['type'], (t) => typ(t).item ?? TYPE.any);
  Ty('TableRow', ['table'], (t) => new MType('record', false, undefined, undefined, (typ(t).columns ?? []).map((c) => ({ name: c.name, type: c.type }))));
  Ty('TableColumn', ['tableType', 'column'], (t, c) => typ(t).columns?.find((x) => x.name === text(c))?.type ?? TYPE.any);
  Ty('RecordFields', ['type'], (t) => MRecord.from(Object.fromEntries((typ(t).fields ?? []).map((f) => [f.name, MRecord.from({ Type: f.type, Optional: !!f.optional })]))));
  Ty('ForRecord', ['fields', 'open'], (f, o) => new MType('record', false, undefined, undefined, rec(f).names.map((n) => ({ name: n, type: rec(rec(f).get(n)).get('Type'), optional: rec(rec(f).get(n)).get('Optional') === true })), o === true));
  Ty('ForList', ['type'], (t) => new MType('list', false, undefined, typ(t)));
  Ty('ForFunction', ['signature', 'min'], () => TYPE.function);
  Ty('FunctionParameters', ['type'], () => MRecord.from({}));
  Ty('FunctionRequiredParameters', ['type'], () => 0);
  Ty('FunctionReturn', ['type'], () => TYPE.any);
  Ty('TableSchema', ['tableType'], (t) => new MTable(['Name', 'Position', 'TypeName', 'Kind'], (typ(t).columns ?? []).map((c, i) => [c.name, i, `${c.type.kind}`, c.type.kind])));
  Ty('TableKeys', ['tableType'], () => L([]));
  Ty('AddTableKey', ['table', 'columns', 'isPrimary'], (t) => t);
  Ty('ReplaceTableKeys', ['tableType', 'keys'], (t) => t);
  Ty('ClosedRecord', ['type'], (t) => t);
  Ty('OpenRecord', ['type'], (t) => t);
  Ty('Union', ['types'], () => TYPE.any);
  Ty('Facets', ['type'], () => MRecord.from({}));
  Ty('ReplaceFacets', ['type', 'facets'], (t) => t);

  /* ---- Error / Function / Diagnostics / Expression ---- */
  def(lib, 'Error.Record', ['reason', 'message?', 'detail?', 'parameters?'], (r, m, d) => MRecord.from({ Reason: r, Message: m, Detail: d }));
  def(lib, 'Function.Invoke', ['function', 'args'], (f, a) => invoke(f, items(a)));
  def(lib, 'Function.InvokeAfter', ['function', 'delay'], (f) => invoke(f, []));
  def(lib, 'Function.IsDataSource', ['function'], () => false);
  def(lib, 'Function.From', ['functionType', 'function'], (_t, f) => new MFunction([{ name: 'args' }], (a) => invoke(f, [L((a as unknown[]).map(force))])));
  def(lib, 'Function.ScalarVector', ['scalarFunctionType', 'vectorFunction'], (_t, f) => f);
  def(lib, 'Diagnostics.Trace', ['traceLevel', 'message', 'value', 'delayed?'], (_l, _m, v, d) => (d === true ? call(v) : v));
  def(lib, 'Diagnostics.ActivityId', [], () => crypto.randomUUID());
  for (const k of ['Critical', 'Error', 'Warning', 'Information', 'Verbose']) lib.set(`TraceLevel.${k}`, 0);
  def(lib, 'Expression.Evaluate', ['document', 'environment?'], (doc, envR) => {
    const vars = new Map<string, unknown>();
    if (envR instanceof MRecord) envR.names.forEach((n, i) => vars.set(n, envR.vals[i]));
    const host = { request: () => { throw err('Expression.Evaluate non può accedere alle origini dati.'); }, resolve: (n: string) => lib.get(n) };
    return evaluate(parseM(text(doc)), new Env(vars, null, host as never));
  });
  def(lib, 'Expression.Constant', ['value'], (v) => (typeof v === 'string' ? JSON.stringify(v).replace(/\\"/g, '""') : String(toText(v, 'en-US'))));
  def(lib, 'Expression.Identifier', ['name'], (n) => (/^[A-Za-z_][\w.]*$/.test(text(n)) ? text(n) : `#"${text(n).replace(/"/g, '""')}"`));
  lib.set('#shared', new MRecord([], []));
  lib.set('#sections', new MRecord([], []));

  /* ---- Json / Lines / Binary / Text ---- */
  def(lib, 'Json.Document', ['jsonText', 'encoding?'], (s) => { try { return jsonToM(JSON.parse(decode(s))); } catch (e) { if (e instanceof MError) throw e; throw err('JSON non valido: ' + (e as Error).message, 'DataFormat.Error'); } });
  def(lib, 'Json.FromValue', ['value', 'encoding?'], (v) => new MBinary(new TextEncoder().encode(JSON.stringify(mToJson(v)))));
  def(lib, 'Lines.FromBinary', ['binary', 'quoteStyle?', 'includeLineSeparators?', 'encoding?'], (b) => L(decode(bin(b)).split(/\r\n|\n|\r/).filter((x, i, a) => i < a.length - 1 || x !== '')));
  def(lib, 'Lines.FromText', ['text', 'quoteStyle?', 'includeLineSeparators?'], (s) => L(text(s).split(/\r\n|\n|\r/)));
  def(lib, 'Lines.ToText', ['lines', 'lineSeparator?'], (l, sep) => items(l).map(String).join(sep === null ? '\r\n' : text(sep)) + (sep === null ? '\r\n' : text(sep)));
  def(lib, 'Lines.ToBinary', ['lines', 'lineSeparator?', 'encoding?', 'includeByteOrderMark?'], (l, sep) => new MBinary(new TextEncoder().encode(items(l).map(String).join(sep === null ? '\r\n' : text(sep)))));
  def(lib, 'Text.FromBinary', ['binary', 'encoding?'], (b) => (b === null ? null : decode(bin(b))));
  def(lib, 'Text.ToBinary', ['text', 'encoding?', 'includeByteOrderMark?'], (s) => (s === null ? null : new MBinary(new TextEncoder().encode(text(s)))));
  // BinaryEncoding.Base64 = 0, Hex = 1
  lib.set('BinaryEncoding.Base64', 0); lib.set('BinaryEncoding.Hex', 1);
  def(lib, 'Binary.FromText', ['text', 'encoding?'], (s, e) => (s === null ? null : new MBinary(e === 1 ? Uint8Array.from(text(s).match(/../g) ?? [], (h) => parseInt(h, 16)) : Uint8Array.from(atob(text(s)), (c) => c.charCodeAt(0)))));
  def(lib, 'Binary.ToText', ['binary', 'encoding?'], (b, e) => (b === null ? null : e === 1 ? [...bin(b).bytes].map((x) => x.toString(16).padStart(2, '0')).join('') : btoa(String.fromCharCode(...bin(b).bytes))));
  def(lib, 'Binary.From', ['value', 'encoding?'], (v) => (v === null ? null : v instanceof MBinary ? v : new MBinary(Uint8Array.from(atob(text(v)), (c) => c.charCodeAt(0)))));
  def(lib, 'Binary.Length', ['binary'], (b) => (b === null ? null : bin(b).bytes.length));
  def(lib, 'Binary.Buffer', ['binary'], (b) => b);
  def(lib, 'Binary.Range', ['binary', 'offset', 'count?'], (b, o, n) => new MBinary(bin(b).bytes.slice(num(o), n === null ? undefined : num(o) + num(n))));
  def(lib, 'Binary.Combine', ['binaries'], (bs) => { const parts = items(bs).map((b) => bin(b).bytes); const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let i = 0; for (const p of parts) { out.set(p, i); i += p.length; } return new MBinary(out); });
  def(lib, 'Binary.ToList', ['binary'], (b) => L([...bin(b).bytes]));
  def(lib, 'Binary.FromList', ['list'], (l) => new MBinary(Uint8Array.from(items(l).map(num))));
  def(lib, 'Binary.InferContentType', ['source'], (b) => {
    const s = decode(bin(b)).slice(0, 2000);
    const type = s.trimStart().startsWith('{') || s.trimStart().startsWith('[') ? 'application/json' : s.trimStart().startsWith('<') ? 'application/xml' : 'text/csv';
    return MRecord.from({ 'Content.Type': type });
  });

  /* ---- Uri ---- */
  def(lib, 'Uri.Combine', ['baseUri', 'relativeUri'], (b, r) => new URL(text(r), text(b)).toString());
  def(lib, 'Uri.EscapeDataString', ['data'], (s) => encodeURIComponent(text(s)));
  def(lib, 'Uri.BuildQueryString', ['query'], (q) => rec(q).names.map((n) => `${encodeURIComponent(n)}=${encodeURIComponent(String(rec(q).get(n)))}`).join('&'));
  def(lib, 'Uri.Parts', ['absoluteUri'], (u) => { const x = new URL(text(u)); return MRecord.from({ Scheme: x.protocol.replace(':', ''), Host: x.hostname, Port: Number(x.port || (x.protocol === 'https:' ? 443 : 80)), Path: x.pathname, Query: MRecord.from(Object.fromEntries(x.searchParams)), Fragment: x.hash.replace('#', ''), UserName: x.username, Password: x.password }); });

  /* ---- Record.FromTable / Table helpers that need records ---- */
  def(lib, 'Table.FromRecordsList', ['records'], (r) => fromRecords(items(r).map(rec)));

  void fn; void numN; void opt; void concat;
}
