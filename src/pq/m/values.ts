// Power Query M values: the JS representation used by the interpreter (src/pq/m/eval.ts).
//   null, logical (boolean), number (number), text (string),
//   date/datetime/datetimezone/time/duration (classes below), binary (MBinary), list (MList),
//   record (MRecord, lazy fields), table (MTable), function (MFunction), type (MType).
// Errors are thrown as MError; a table cell that failed holds an ErrorCell (raised when read).

export class MError extends Error {
  constructor(public reason: string, message: string, public detail: unknown = null) { super(message); }
  record(): MRecord { return MRecord.from({ Reason: this.reason, Message: this.message, Detail: this.detail }); }
}
export const err = (message: string, reason = 'Expression.Error', detail: unknown = null) => new MError(reason, message, detail);

/** A value computed on first use (let bindings, record fields, table cells of lazy tables). */
export class Lazy {
  private state: 0 | 1 | 2 = 0; // 0 = not evaluated, 1 = evaluating, 2 = done
  private v: unknown;
  private e: unknown;
  constructor(private f: () => unknown) {}
  get(): unknown {
    if (this.state === 2) { if (this.e) throw this.e; return this.v; }
    if (this.state === 1) throw err('Riferimento circolare.', 'Expression.Error');
    this.state = 1;
    try { this.v = this.f(); } catch (e) { this.e = e; }
    this.state = 2;
    this.f = undefined as never;
    if (this.e) throw this.e;
    return this.v;
  }
}
export const force = (v: unknown): any => (v instanceof Lazy ? v.get() : v);

/** A cell whose computation failed: the table survives, reading the cell raises the error. */
export class ErrorCell { constructor(public error: MError) {} }

/* --------------------------------- date/time --------------------------------- */

const DAY = 86400000;
/** Days since 1970-01-01 (UTC calendar, no time zone). */
export class MDate {
  constructor(public days: number) {}
  static of(y: number, m: number, d: number) { return new MDate(Math.floor(Date.UTC(y, m - 1, d) / DAY)); }
  get js() { return new Date(this.days * DAY); }
  get y() { return this.js.getUTCFullYear(); }
  get m() { return this.js.getUTCMonth() + 1; }
  get d() { return this.js.getUTCDate(); }
  toString() { return iso(this.js).slice(0, 10); }
}
/** Milliseconds since 1970-01-01 (wall clock, no time zone). */
export class MDateTime {
  constructor(public ms: number) {}
  static of(y: number, mo: number, d: number, h = 0, mi = 0, s = 0) { return new MDateTime(Date.UTC(y, mo - 1, d, h, mi, 0) + s * 1000); }
  get js() { return new Date(this.ms); }
  get date() { return new MDate(Math.floor(this.ms / DAY)); }
  get time() { return new MTime(((this.ms % DAY) + DAY) % DAY); }
  toString() { return iso(this.js).replace('T', ' ').replace(/\.000$/, '').replace('Z', ''); }
}
/** Wall clock + offset in minutes. */
export class MDateTimeZone {
  constructor(public ms: number, public offset: number) {}
  get utc() { return this.ms - this.offset * 60000; }
  toString() { const o = this.offset, s = o < 0 ? '-' : '+', a = Math.abs(o); return `${new MDateTime(this.ms)} ${s}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`; }
}
/** Milliseconds since midnight. */
export class MTime {
  constructor(public ms: number) {}
  static of(h: number, m: number, s: number) { return new MTime((h * 3600 + m * 60) * 1000 + s * 1000); }
  get h() { return Math.floor(this.ms / 3600000); }
  get mi() { return Math.floor(this.ms / 60000) % 60; }
  get s() { return (this.ms % 60000) / 1000; }
  toString() { return `${String(this.h).padStart(2, '0')}:${String(this.mi).padStart(2, '0')}:${String(Math.floor(this.s)).padStart(2, '0')}`; }
}
export class MDuration {
  constructor(public ms: number) {}
  static of(d: number, h: number, m: number, s: number) { return new MDuration(((d * 24 + h) * 60 + m) * 60000 + s * 1000); }
  toString() {
    const neg = this.ms < 0, a = Math.abs(this.ms);
    const d = Math.floor(a / DAY), rest = a % DAY;
    const h = Math.floor(rest / 3600000), m = Math.floor(rest / 60000) % 60, s = (rest % 60000) / 1000;
    return `${neg ? '-' : ''}${d}.${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  }
}
const iso = (d: Date) => (isNaN(d.getTime()) ? 'NaN' : d.toISOString());
export { DAY };

/* --------------------------------- binary --------------------------------- */

/** Binary value; `load` reads it on demand (File.Contents, Web.Contents). `path()` = a local file with the same bytes
 *  when there is one, so CSV/Excel/Parquet sources can be read natively by DuckDB. */
export class MBinary {
  private data?: Uint8Array;
  private load?: () => Uint8Array;
  constructor(init: Uint8Array | (() => Uint8Array), public path?: () => string) {
    if (init instanceof Uint8Array) this.data = init; else this.load = init;
  }
  get bytes(): Uint8Array { if (!this.data) this.data = this.load!(); return this.data; }
}

/* --------------------------------- list / record / table --------------------------------- */

export class MList {
  constructor(public items: unknown[]) {}
  get length() { return this.items.length; }
  at(i: number) { return force(this.items[i]); }
  values(): any[] { return this.items.map(force); }
}

export class MRecord {
  constructor(public names: string[], public vals: unknown[]) {}
  static from(o: Record<string, unknown>) { return new MRecord(Object.keys(o), Object.values(o)); }
  has(n: string) { return this.names.includes(n); }
  get(n: string): any {
    const i = this.names.indexOf(n);
    if (i < 0) throw err(`Il campo '${n}' del record non è stato trovato.`);
    const v = force(this.vals[i]);
    if (v instanceof ErrorCell) throw v.error;
    return v;
  }
  values(): any[] { return this.vals.map(force); }
}

export class MTable {
  /** rows[i][j] = value of column j (may be ErrorCell or Lazy). `types` = column types (TransformColumnTypes, #table). */
  constructor(public columns: string[], public rows: unknown[][], public types?: (MType | undefined)[]) {
    const seen = new Set<string>();
    for (const c of columns) { if (seen.has(c)) throw err(`Il nome della colonna '${c}' è duplicato.`); seen.add(c); }
  }
  col(name: string) {
    const i = this.columns.indexOf(name);
    if (i < 0) throw err(`Impossibile trovare la colonna '${name}' della tabella.`, 'Expression.Error', MRecord.from({ Column: name }));
    return i;
  }
  typeOf(i: number) { return this.types?.[i]; }
  row(i: number): MRecord { return new MRecord(this.columns, this.rows[i]); }
}

/* --------------------------------- functions / types --------------------------------- */

export interface Param { name: string; optional?: boolean; type?: MType }
export class MFunction {
  constructor(public params: Param[], public call: (args: unknown[]) => unknown, public name = '', public ret?: MType) {}
  get arity() { return this.params.length; }
  get required() { return this.params.filter((p) => !p.optional).length; }
}

export type TypeKind = 'any' | 'anynonnull' | 'none' | 'null' | 'logical' | 'number' | 'text' | 'date' | 'datetime' | 'datetimezone' | 'time' | 'duration'
  | 'binary' | 'list' | 'record' | 'table' | 'function' | 'type' | 'action';
export class MType {
  constructor(
    public kind: TypeKind,
    public nullable = false,
    /** number facets (Int64.Type, Currency.Type, Percentage.Type…) */
    public facet?: string,
    public item?: MType,
    public fields?: { name: string; type: MType; optional?: boolean }[],
    public open = false,
    public columns?: { name: string; type: MType }[],
  ) {}
  toString(): string {
    if (this.kind === 'table') return 'table';
    return (this.nullable && this.kind !== 'any' && this.kind !== 'null' ? 'nullable ' : '') + this.kind;
  }
}
export const T = (k: TypeKind, facet?: string) => new MType(k, false, facet);
export const TYPE = {
  any: T('any'), anynonnull: T('anynonnull'), none: T('none'), null: T('null'), logical: T('logical'), number: T('number'), text: T('text'),
  date: T('date'), datetime: T('datetime'), datetimezone: T('datetimezone'), time: T('time'), duration: T('duration'),
  binary: T('binary'), list: T('list'), record: T('record'), table: T('table'), function: T('function'), type: T('type'),
  int64: T('number', 'Int64'), int32: T('number', 'Int32'), int16: T('number', 'Int16'), int8: T('number', 'Int8'), byte: T('number', 'Byte'),
  double: T('number', 'Double'), single: T('number', 'Single'), decimal: T('number', 'Decimal'), currency: T('number', 'Currency'), percentage: T('number', 'Percentage'),
  character: T('text', 'Character'), guid: T('text', 'Guid'), uri: T('text', 'Uri'),
};

/* --------------------------------- helpers --------------------------------- */

export function typeOfValue(v: unknown): MType {
  v = force(v);
  if (v === null || v === undefined) return TYPE.null;
  if (typeof v === 'boolean') return TYPE.logical;
  if (typeof v === 'number') return TYPE.number;
  if (typeof v === 'string') return TYPE.text;
  if (v instanceof MDate) return TYPE.date;
  if (v instanceof MDateTime) return TYPE.datetime;
  if (v instanceof MDateTimeZone) return TYPE.datetimezone;
  if (v instanceof MTime) return TYPE.time;
  if (v instanceof MDuration) return TYPE.duration;
  if (v instanceof MBinary) return TYPE.binary;
  if (v instanceof MList) return TYPE.list;
  if (v instanceof MRecord) return TYPE.record;
  if (v instanceof MTable) return new MType('table', false, undefined, undefined, undefined, false, v.columns.map((c, i) => ({ name: c, type: v.typeOf(i) ?? TYPE.any })));
  if (v instanceof MFunction) return TYPE.function;
  if (v instanceof MType) return TYPE.type;
  return TYPE.any;
}

/** Value conforms to a type (the `is` operator; facets are not checked, like Power Query). */
export function conforms(v: unknown, t: MType): boolean {
  v = force(v);
  if (t.kind === 'any') return true;
  if (v === null) return t.nullable || t.kind === 'null';
  if (t.kind === 'anynonnull') return true;
  if (t.kind === 'null') return false;
  return typeOfValue(v).kind === t.kind;
}

export const kindName = (v: unknown) => typeOfValue(v).kind;

/** Equality as the = operator (deep for lists, records and tables; numbers by value; text ordinal). */
export function equals(a: unknown, b: unknown): boolean {
  a = force(a); b = force(b);
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a instanceof MDate && b instanceof MDate) return a.days === b.days;
  if (a instanceof MDateTime && b instanceof MDateTime) return a.ms === b.ms;
  if (a instanceof MDateTimeZone && b instanceof MDateTimeZone) return a.utc === b.utc;
  if (a instanceof MTime && b instanceof MTime) return a.ms === b.ms;
  if (a instanceof MDuration && b instanceof MDuration) return a.ms === b.ms;
  if (a instanceof MBinary && b instanceof MBinary) { const x = a.bytes, y = b.bytes; return x.length === y.length && x.every((c, i) => c === y[i]); }
  if (a instanceof MList && b instanceof MList) return a.length === b.length && a.items.every((x, i) => equals(x, b.items[i]));
  if (a instanceof MRecord && b instanceof MRecord) return a.names.length === b.names.length && a.names.every((n) => b.has(n) && equals(a.get(n), b.get(n)));
  if (a instanceof MTable && b instanceof MTable) {
    return a.columns.length === b.columns.length && a.rows.length === b.rows.length && a.columns.every((c) => b.columns.includes(c))
      && a.rows.every((r, i) => a.columns.every((c, j) => equals(r[j], b.rows[i][b.columns.indexOf(c)])));
  }
  return a === b;
}

/** -1/0/1 for ordered values (null first; different kinds by kind name), as Value.Compare. */
export function compare(a: unknown, b: unknown, ignoreCase = false): number {
  a = force(a); b = force(b);
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ka = kindName(a), kb = kindName(b);
  if (ka !== kb) return ka < kb ? -1 : 1;
  if (typeof a === 'string' && typeof b === 'string') {
    const x = ignoreCase ? a.toLowerCase() : a, y = ignoreCase ? b.toLowerCase() : b;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const n = (v: any) => (typeof v === 'number' ? v : typeof v === 'boolean' ? +v : v instanceof MDate ? v.days : v instanceof MDateTimeZone ? v.utc : v.ms ?? 0);
  const x = n(a), y = n(b);
  if (Number.isNaN(x) || Number.isNaN(y)) return Number.isNaN(x) ? (Number.isNaN(y) ? 0 : -1) : 1;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Display text of a value (previews, error messages). */
export function show(v: unknown): string {
  v = force(v);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e12) / 1e12);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof MList) return 'List';
  if (v instanceof MRecord) return 'Record';
  if (v instanceof MTable) return 'Table';
  if (v instanceof MFunction) return 'Function';
  if (v instanceof MType) return 'Type';
  if (v instanceof MBinary) return 'Binary';
  if (v instanceof ErrorCell) return 'Error';
  return String(v);
}
