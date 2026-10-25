// Helpers shared by the M standard library modules: registration, argument checks, comparers, culture.
import { invoke } from '../eval';
import {
  ErrorCell, MBinary, MDate, MDateTime, MDateTimeZone, MDuration, MError, MFunction, MList, MRecord, MTable, MTime, MType,
  compare, equals, err, force, kindName,
} from '../values';
import { locale } from '../../../format';

export type Lib = Map<string, unknown>;

/** Registers a library function. Parameter names ending in "?" are optional (missing → null). */
export function def(lib: Lib, name: string, params: string[], impl: (...args: any[]) => any) {
  lib.set(name, new MFunction(params.map((p) => ({ name: p.replace(/\?$/, ''), optional: p.endsWith('?') })), (args) => {
    const a = args.map(force);
    while (a.length < params.length) a.push(null);
    return impl(...a);
  }, name));
}

/** Value of a table cell / list item: lazy values forced, error cells raised. */
export const cell = (v: unknown): any => { const x = force(v); if (x instanceof ErrorCell) throw x.error; return x; };

const typeErr = (v: unknown, want: string) => err(`Impossibile convertire il valore ${v === null ? 'null' : `di tipo ${kindName(v)}`} nel tipo ${want}.`);
export const num = (v: unknown): number => { if (typeof v === 'number') return v; throw typeErr(v, 'Number'); };
export const numN = (v: unknown): number | null => (v === null ? null : num(v));
export const text = (v: unknown): string => { if (typeof v === 'string') return v; throw typeErr(v, 'Text'); };
export const textN = (v: unknown): string | null => (v === null ? null : text(v));
export const bool = (v: unknown): boolean => { if (typeof v === 'boolean') return v; throw typeErr(v, 'Logical'); };
export const list = (v: unknown): MList => { if (v instanceof MList) return v; throw typeErr(v, 'List'); };
export const items = (v: unknown): any[] => list(v).items.map(cell);
export const rec = (v: unknown): MRecord => { if (v instanceof MRecord) return v; throw typeErr(v, 'Record'); };
export const table = (v: unknown): MTable => { if (v instanceof MTable) return v; throw typeErr(v, 'Table'); };
export const fn = (v: unknown): MFunction => { if (v instanceof MFunction) return v; throw typeErr(v, 'Function'); };
export const bin = (v: unknown): MBinary => { if (v instanceof MBinary) return v; throw typeErr(v, 'Binary'); };
export const typ = (v: unknown): MType => { if (v instanceof MType) return v; throw typeErr(v, 'Type'); };
export const call = (f: unknown, ...args: unknown[]) => invoke(f, args);
/** A list of texts or a single text (column arguments). */
export const names = (v: unknown): string[] => (typeof v === 'string' ? [v] : items(v).map(text));
export const opt = (r: unknown, field: string, dflt: any = null): any => (r instanceof MRecord && r.has(field) ? r.get(field) : dflt);

export const MList_ = (a: unknown[]) => new MList(a);
export const R = (o: Record<string, unknown>) => MRecord.from(o);

/** Culture argument (text or [Culture=…] options) → BCP 47; default = Opzioni › Impostazioni internazionali. */
export function culture(v: unknown): string {
  if (typeof v === 'string' && v) return v;
  if (v instanceof MRecord && v.has('Culture') && typeof v.get('Culture') === 'string') return v.get('Culture');
  return locale();
}

/* ------------------------------- comparers ------------------------------- */

/** Comparer.Ordinal / OrdinalIgnoreCase / FromCulture: functions (x, y) => -1/0/1 tagged with their kind. */
export const ORDINAL = Object.assign(new MFunction([{ name: 'x' }, { name: 'y' }], (a) => compare(force(a[0]), force(a[1])), 'Comparer.Ordinal'), { ignoreCase: false });
export const ORDINAL_IC = Object.assign(new MFunction([{ name: 'x' }, { name: 'y' }], (a) => compare(force(a[0]), force(a[1]), true), 'Comparer.OrdinalIgnoreCase'), { ignoreCase: true });

/** Equality under an optional equation criteria (comparer function or null). */
export function eqWith(criteria: unknown): (a: unknown, b: unknown) => boolean {
  if (criteria === null || criteria === undefined) return equals;
  if (criteria === ORDINAL_IC) return (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : equals(a, b));
  if (criteria instanceof MFunction) {
    if (criteria.arity === 2) return (a, b) => { const r = invoke(criteria, [a, b]); return r === true || r === 0; };
    return (a, b) => equals(invoke(criteria, [a]), invoke(criteria, [b]));
  }
  if (criteria instanceof MList) return eqWith(criteria.at(1) ?? criteria.at(0));
  return equals;
}
/** Key for hashing under criteria (ignore case lower-cases texts). */
export function keyWith(criteria: unknown): (v: unknown) => string {
  const ic = criteria === ORDINAL_IC;
  return (v) => hashKey(v, ic);
}
export function hashKey(v: unknown, ic = false): string {
  v = force(v);
  if (v === null) return 'n';
  if (typeof v === 'string') return 's' + (ic ? v.toLowerCase() : v);
  if (typeof v === 'number') return 'd' + v;
  if (typeof v === 'boolean') return 'b' + v;
  if (v instanceof MDate) return 'D' + v.days;
  if (v instanceof MDateTime) return 'T' + v.ms;
  if (v instanceof MDateTimeZone) return 'Z' + v.utc;
  if (v instanceof MTime) return 't' + v.ms;
  if (v instanceof MDuration) return 'u' + v.ms;
  if (v instanceof MList) return 'L[' + v.items.map((x) => hashKey(x, ic)).join(',') + ']';
  if (v instanceof MRecord) return 'R{' + v.names.map((n) => n + ':' + hashKey(v.get(n), ic)).join(',') + '}';
  return 'o' + String(v);
}

/** Sort comparison from List.Sort/Table.Sort criteria: Order.Ascending/Descending, a key function, a comparer, or {key, order}. */
export function sorter(criteria: unknown): (a: unknown, b: unknown) => number {
  if (criteria === null || criteria === undefined) return (a, b) => compare(a, b);
  if (typeof criteria === 'number') return criteria === 1 ? (a, b) => compare(b, a) : (a, b) => compare(a, b);
  if (criteria instanceof MFunction) {
    if (criteria.arity === 2) return (a, b) => num(invoke(criteria, [a, b]));
    return (a, b) => compare(invoke(criteria, [a]), invoke(criteria, [b]));
  }
  if (criteria instanceof MList) {
    const parts = criteria.values();
    if (parts.length === 2 && typeof parts[1] === 'number' && !(parts[0] instanceof MList)) {
      const base = sorter(parts[0]);
      return parts[1] === 1 ? (a, b) => base(b, a) : base;
    }
    const fs = parts.map(sorter);
    return (a, b) => { for (const f of fs) { const c = f(a, b); if (c) return c; } return 0; };
  }
  return (a, b) => compare(a, b);
}

export { MError, err, force, equals, compare, kindName };
