// Text.*, Character.*, Number.*, Logical.*, Int64/Double/Decimal/Currency/Percentage.From, number/date formatting.
import { MDate, MDateTime, MDateTimeZone, MDuration, MList, MTime, TYPE } from '../values';
import { type Lib, bool, call, cell, culture, def, err, items, num, numN, text, textN } from './core';
import { fromText as dateFromText, toText as dateToText } from './datetime';

/* ------------------------------- number formatting ------------------------------- */

const nf = (c: string, o: Intl.NumberFormatOptions) => new Intl.NumberFormat(c, o);
/** .NET standard (N2, F0, P1, C, D5, E3, X, G, R) and custom (#,0.00) numeric format strings. */
export function formatNumber(n: number, format: string | null, cult: string): string {
  if (!format) return numberToText(n, cult);
  const m = /^([CcDdEeFfGgNnPpRrXx])(\d{0,2})$/.exec(format);
  if (m) {
    const k = m[1].toUpperCase(), p = m[2] === '' ? undefined : Number(m[2]);
    switch (k) {
      case 'N': return nf(cult, { minimumFractionDigits: p ?? 2, maximumFractionDigits: p ?? 2 }).format(n);
      case 'F': return nf(cult, { minimumFractionDigits: p ?? 2, maximumFractionDigits: p ?? 2, useGrouping: false }).format(n);
      case 'P': return nf(cult, { style: 'percent', minimumFractionDigits: p ?? 2, maximumFractionDigits: p ?? 2 }).format(n);
      case 'C': return nf(cult, { style: 'currency', currency: cult.startsWith('en-US') ? 'USD' : cult.startsWith('en-GB') ? 'GBP' : 'EUR', minimumFractionDigits: p ?? 2, maximumFractionDigits: p ?? 2 }).format(n);
      case 'D': { const s = String(Math.trunc(Math.abs(n))).padStart(p ?? 0, '0'); return (n < 0 ? '-' : '') + s; }
      case 'E': { const s = n.toExponential(p ?? 6).replace(/e([+-])(\d)$/, 'e$10$2').replace(/e([+-])(\d\d)$/, 'e$10$2'); return m[1] === 'E' ? s.toUpperCase() : s; }
      case 'X': { const s = Math.trunc(n).toString(16).padStart(p ?? 0, '0'); return m[1] === 'X' ? s.toUpperCase() : s; }
      default: return numberToText(n, cult);
    }
  }
  return customNumber(n, format, cult);
}
function numberToText(n: number, cult: string) {
  if (!isFinite(n)) return isNaN(n) ? 'NaN' : n > 0 ? '∞' : '-∞';
  return nf(cult, { maximumFractionDigits: 15, useGrouping: false }).format(n);
}
/** Custom numeric formats: 0, #, grouping ",", decimals, %, literal text in quotes, sections ";". */
function customNumber(n: number, format: string, cult: string): string {
  const sections = format.split(';');
  let f = sections[0];
  if (n < 0 && sections[1]) { f = sections[1]; n = -n; } else if (n === 0 && sections[2]) f = sections[2];
  const pct = f.includes('%');
  if (pct) n *= 100;
  const lit = /"[^"]*"|'[^']*'|\\./g;
  const core = f.replace(lit, '').replace(/[^0#.,]/g, '');
  const [ip, dp = ''] = core.split('.');
  const decimals = dp.replace(/[^0#]/g, '').length, minDec = dp.replace(/[^0]/g, '').length;
  const s = nf(cult, { minimumFractionDigits: minDec, maximumFractionDigits: decimals, useGrouping: ip.includes(','), minimumIntegerDigits: Math.max(1, ip.replace(/[^0]/g, '').length) }).format(Math.abs(n));
  const sign = n < 0 && !sections[1] ? '-' : '';
  let done = false;
  return sign + f.replace(/("[^"]*"|'[^']*'|\\.)|[0#.,]+/g, (m, l) => {
    if (l) return l.startsWith('\\') ? l.slice(1) : l.slice(1, -1);
    if (done) return '';
    done = true;
    return s;
  });
}

/** Number.FromText: culture separators, %, scientific notation, hex. */
export function numberFromText(s: string, cult: string): number {
  const t = s.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return parseInt(t, 16);
  const parts = new Intl.NumberFormat(cult).formatToParts(12345.6);
  const group = parts.find((p) => p.type === 'group')?.value ?? ',', dec = parts.find((p) => p.type === 'decimal')?.value ?? '.';
  let x = t.replace(/[\s  ]/g, '');
  const pct = x.endsWith('%');
  if (pct) x = x.slice(0, -1);
  x = x.split(group === '.' ? '.' : group).join(group === dec ? group : '');
  if (dec !== '.') x = x.replace(dec, '.');
  x = x.replace(/^\((.*)\)$/, '-$1');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(x)) throw err(`Impossibile convertire "${s}" nel tipo Number.`, 'DataFormat.Error', s);
  return pct ? Number(x) / 100 : Number(x);
}

/** Any value → number (Number.From). */
export function toNumber(v: unknown, cult: string): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string') return numberFromText(v, cult);
  if (v instanceof MDate) return v.days + 25569;
  if (v instanceof MDateTime) return v.ms / 86400000 + 25569;
  if (v instanceof MDateTimeZone) return v.utc / 86400000 + 25569;
  if (v instanceof MTime) return v.ms / 86400000;
  if (v instanceof MDuration) return v.ms / 86400000;
  throw err('Impossibile convertire il valore nel tipo Number.');
}

/** Any value → text (Text.From). */
export function toText(v: unknown, cult: string): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToText(v, cult);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v instanceof MDate || v instanceof MDateTime || v instanceof MDateTimeZone || v instanceof MTime || v instanceof MDuration) return dateToText(v, null, cult);
  throw err('Impossibile convertire il valore nel tipo Text.');
}

const round = (n: number, digits: number, mode: 'even' | 'away' | 'up' | 'down' | 'zero') => {
  const p = Math.pow(10, digits), x = n * p;
  let r: number;
  if (mode === 'up') r = Math.ceil(x - 1e-9);
  else if (mode === 'down') r = Math.floor(x + 1e-9);
  else if (mode === 'zero') r = Math.trunc(x);
  else {
    const f = Math.floor(x), diff = x - f;
    if (Math.abs(diff - 0.5) < 1e-9) r = mode === 'away' ? (x >= 0 ? f + 1 : f) : f % 2 === 0 ? f : f + 1;
    else r = Math.round(x);
    if (mode === 'away' && x < 0 && Math.abs(diff - 0.5) < 1e-9) r = f;
  }
  return r / p;
};

export function register(lib: Lib) {
  /* ---- Text ---- */
  const T = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Text.' + n, p, f);
  T('From', ['value', 'culture?'], (v, c) => toText(v, culture(c)));
  T('Length', ['text'], (s) => (s === null ? null : [...text(s)].length));
  T('Upper', ['text', 'culture?'], (s) => textN(s)?.toUpperCase() ?? null);
  T('Lower', ['text', 'culture?'], (s) => textN(s)?.toLowerCase() ?? null);
  T('Proper', ['text', 'culture?'], (s) => (s === null ? null : text(s).toLowerCase().replace(/(^|[^\p{L}\p{N}'])(\p{L})/gu, (_m, a, b) => a + b.toUpperCase())));
  const trimChars = (s: string, chars: unknown, start: boolean, end: boolean) => {
    const set = chars === null ? null : new Set(typeof chars === 'string' ? [chars] : items(chars).map(text));
    const isTrim = (c: string) => (set ? set.has(c) : /\s/.test(c));
    const a = [...s];
    let i = 0, j = a.length;
    if (start) while (i < j && isTrim(a[i])) i++;
    if (end) while (j > i && isTrim(a[j - 1])) j--;
    return a.slice(i, j).join('');
  };
  T('Trim', ['text', 'trim?'], (s, c) => (s === null ? null : trimChars(text(s), c, true, true)));
  T('TrimStart', ['text', 'trim?'], (s, c) => (s === null ? null : trimChars(text(s), c, true, false)));
  T('TrimEnd', ['text', 'trim?'], (s, c) => (s === null ? null : trimChars(text(s), c, false, true)));
  T('Clean', ['text'], (s) => (s === null ? null : text(s).replace(/[\u0000-\u001f\u007f-\u009f]/g, '')));
  T('Start', ['text', 'count'], (s, n) => (s === null ? null : [...text(s)].slice(0, num(n)).join('')));
  T('End', ['text', 'count'], (s, n) => (s === null ? null : (num(n) ? [...text(s)].slice(-num(n)).join('') : '')));
  T('Middle', ['text', 'start', 'count?'], (s, i, n) => (s === null ? null : [...text(s)].slice(num(i), n === null ? undefined : num(i) + num(n)).join('')));
  T('Range', ['text', 'offset', 'count?'], (s, i, n) => {
    if (s === null) return null;
    const a = [...text(s)];
    if (num(i) > a.length) throw err('L\'offset non rientra nei limiti del testo.');
    return a.slice(num(i), n === null ? undefined : num(i) + num(n)).join('');
  });
  T('At', ['text', 'index'], (s, i) => { const a = [...text(s)]; if (num(i) >= a.length) throw err('Indice fuori intervallo.'); return a[num(i)]; });
  const cmp = (c: unknown) => (c === lib.get('Comparer.OrdinalIgnoreCase') ? (x: string) => x.toLowerCase() : (x: string) => x);
  T('Contains', ['text', 'substring', 'comparer?'], (s, sub, c) => (s === null ? null : cmp(c)(text(s)).includes(cmp(c)(text(sub)))));
  T('StartsWith', ['text', 'substring', 'comparer?'], (s, sub, c) => (s === null ? null : cmp(c)(text(s)).startsWith(cmp(c)(text(sub)))));
  T('EndsWith', ['text', 'substring', 'comparer?'], (s, sub, c) => (s === null ? null : cmp(c)(text(s)).endsWith(cmp(c)(text(sub)))));
  T('Replace', ['text', 'old', 'new'], (s, a, b) => (s === null ? null : text(a) === '' ? text(s) : text(s).split(text(a)).join(text(b))));
  T('ReplaceRange', ['text', 'offset', 'count', 'newText'], (s, i, n, t) => { const a = [...text(s)]; a.splice(num(i), num(n), text(t)); return a.join(''); });
  T('Insert', ['text', 'offset', 'newText'], (s, i, t) => { const a = [...text(s)]; a.splice(num(i), 0, text(t)); return a.join(''); });
  T('Remove', ['text', 'removeChars'], (s, chars) => { if (s === null) return null; const set = new Set(typeof chars === 'string' ? [...chars] : items(chars).map(text)); return [...text(s)].filter((c) => !set.has(c)).join(''); });
  T('RemoveRange', ['text', 'offset', 'count?'], (s, i, n) => { const a = [...text(s)]; a.splice(num(i), n === null ? 1 : num(n)); return a.join(''); });
  T('Select', ['text', 'selectChars'], (s, chars) => { if (s === null) return null; const set = new Set(typeof chars === 'string' ? [...chars] : items(chars).map(text)); return [...text(s)].filter((c) => set.has(c)).join(''); });
  T('Split', ['text', 'separator'], (s, sep) => new MList(text(s).split(text(sep))));
  T('SplitAny', ['text', 'separators'], (s, seps) => { const set = new Set([...text(seps)]); const out: string[] = []; let cur = ''; for (const c of text(s)) { if (set.has(c)) { out.push(cur); cur = ''; } else cur += c; } out.push(cur); return new MList(out); });
  T('Combine', ['texts', 'separator?'], (l, sep) => items(l).filter((x) => x !== null).map((x) => toText(x, culture(null))).join(sep === null ? '' : text(sep)));
  T('PadStart', ['text', 'count', 'character?'], (s, n, c) => (s === null ? null : text(s).padStart(num(n), c === null ? ' ' : text(c))));
  T('PadEnd', ['text', 'count', 'character?'], (s, n, c) => (s === null ? null : text(s).padEnd(num(n), c === null ? ' ' : text(c))));
  T('Repeat', ['text', 'count'], (s, n) => (s === null ? null : text(s).repeat(num(n))));
  T('Reverse', ['text'], (s) => (s === null ? null : [...text(s)].reverse().join('')));
  T('ToList', ['text'], (s) => new MList([...text(s)]));
  T('NewGuid', [], () => crypto.randomUUID());
  // Occurrence.First = 0, Last = 1, All = 2
  T('PositionOf', ['text', 'substring', 'occurrence?', 'comparer?'], (s, sub, occ, c) => {
    const a = cmp(c)(text(s)), b = cmp(c)(text(sub));
    if (occ === 1) return a.lastIndexOf(b);
    if (occ === 2) { const out: number[] = []; let i = a.indexOf(b); while (i >= 0 && b) { out.push(i); i = a.indexOf(b, i + 1); } return new MList(out); }
    return a.indexOf(b);
  });
  T('PositionOfAny', ['text', 'characters', 'occurrence?'], (s, chars, occ) => {
    const set = new Set(items(chars).map(text)); const a = [...text(s)];
    const hits = a.map((c, i) => (set.has(c) ? i : -1)).filter((i) => i >= 0);
    return occ === 2 ? new MList(hits) : occ === 1 ? hits[hits.length - 1] ?? -1 : hits[0] ?? -1;
  });
  /** index = number (occurrence from the start) or {n, RelativePosition.FromEnd(1)}. */
  const delimIndex = (s: string, d: string, idx: unknown): number => {
    let n = 0, fromEnd = false;
    if (typeof idx === 'number') n = idx; else if (idx instanceof MList) { n = num(idx.at(0)); fromEnd = idx.at(1) === 1; }
    const pos: number[] = []; let i = s.indexOf(d); while (i >= 0 && d) { pos.push(i); i = s.indexOf(d, i + d.length); }
    if (fromEnd) pos.reverse();
    return pos[n] ?? -1;
  };
  T('BeforeDelimiter', ['text', 'delimiter', 'index?'], (s, d, idx) => { if (s === null) return null; const p = delimIndex(text(s), text(d), idx); return p < 0 ? text(s) : text(s).slice(0, p); });
  T('AfterDelimiter', ['text', 'delimiter', 'index?'], (s, d, idx) => { if (s === null) return null; const p = delimIndex(text(s), text(d), idx); return p < 0 ? '' : text(s).slice(p + text(d).length); });
  T('BetweenDelimiters', ['text', 'startDelimiter', 'endDelimiter', 'startIndex?', 'endIndex?'], (s, a, b, si, ei) => {
    if (s === null) return null;
    const p = delimIndex(text(s), text(a), si); if (p < 0) return '';
    const rest = text(s).slice(p + text(a).length);
    const q = delimIndex(rest, text(b), ei);
    return q < 0 ? rest : rest.slice(0, q);
  });
  T('Format', ['formatString', 'arguments', 'culture?'], (f, args) => text(f).replace(/#\{(\d+|[^}]+)\}/g, (_m, k) => {
    const v = args instanceof MList ? args.at(Number(k)) : (args as any).get(k);
    return v === null ? '' : String(toText(v, culture(null)));
  }));
  T('Contains', ['text', 'substring', 'comparer?'], (s, sub, c) => (s === null ? null : cmp(c)(text(s)).includes(cmp(c)(text(sub)))));
  T('InferNumberType', ['text', 'culture?'], () => TYPE.number);
  T('FromBinary', ['binary', 'encoding?'], (b) => (b === null ? null : new TextDecoder(b.bytes[0] === 0xff && b.bytes[1] === 0xfe ? 'utf-16le' : 'utf-8').decode(b.bytes)));
  T('ToBinary', ['text', 'encoding?', 'includeByteOrderMark?'], (s) => { const { MBinary } = require_values(); return new MBinary(new TextEncoder().encode(text(s))); });

  /* ---- Character ---- */
  def(lib, 'Character.FromNumber', ['number'], (n) => (n === null ? null : String.fromCodePoint(num(n))));
  def(lib, 'Character.ToNumber', ['character'], (c) => (c === null ? null : text(c).codePointAt(0)));

  /* ---- Number ---- */
  const N = (n: string, p: string[], f: (...a: any[]) => any) => def(lib, 'Number.' + n, p, f);
  N('From', ['value', 'culture?'], (v, c) => toNumber(v, culture(c)));
  N('FromText', ['text', 'culture?'], (s, c) => (s === null ? null : numberFromText(text(s), culture(c))));
  N('ToText', ['number', 'format?', 'culture?'], (n, f, c) => (n === null ? null : formatNumber(num(n), textN(f), culture(c))));
  const rnd = (mode: 'even' | 'away' | 'up' | 'down' | 'zero') => (n: unknown, d: unknown, m: unknown) => {
    if (n === null) return null;
    const md = m === null || m === undefined ? mode : (['up', 'down', 'away', 'zero', 'even'] as const)[num(m)] ?? mode;
    return round(num(n), d === null ? 0 : num(d), md);
  };
  N('Round', ['number', 'digits?', 'roundingMode?'], rnd('even'));
  N('RoundUp', ['number', 'digits?'], (n, d) => (n === null ? null : round(num(n), d === null ? 0 : num(d), 'up')));
  N('RoundDown', ['number', 'digits?'], (n, d) => (n === null ? null : round(num(n), d === null ? 0 : num(d), 'down')));
  N('RoundTowardZero', ['number', 'digits?'], (n, d) => (n === null ? null : round(num(n), d === null ? 0 : num(d), 'zero')));
  N('RoundAwayFromZero', ['number', 'digits?'], (n, d) => (n === null ? null : round(num(n), d === null ? 0 : num(d), 'away')));
  const unary = (name: string, f: (x: number) => number) => N(name, ['number'], (n) => (n === null ? null : f(num(n))));
  unary('Abs', Math.abs); unary('Sign', Math.sign); unary('Sqrt', Math.sqrt); unary('Exp', Math.exp); unary('Ln', Math.log); unary('Log10', Math.log10);
  unary('Sin', Math.sin); unary('Cos', Math.cos); unary('Tan', Math.tan); unary('Asin', Math.asin); unary('Acos', Math.acos); unary('Atan', Math.atan);
  unary('Sinh', Math.sinh); unary('Cosh', Math.cosh); unary('Tanh', Math.tanh); unary('Factorial', (x) => { let r = 1; for (let i = 2; i <= x; i++) r *= i; return r; });
  N('Log', ['number', 'base?'], (n, b) => (n === null ? null : b === null ? Math.log(num(n)) : Math.log(num(n)) / Math.log(num(b))));
  N('Power', ['number', 'power'], (a, b) => (a === null || b === null ? null : Math.pow(num(a), num(b))));
  N('Mod', ['number', 'divisor', 'precision?'], (a, b) => (a === null || b === null ? null : num(a) % num(b)));
  N('IntegerDivide', ['number1', 'number2', 'precision?'], (a, b) => (a === null || b === null ? null : Math.trunc(num(a) / num(b))));
  N('IsEven', ['number'], (n) => num(n) % 2 === 0);
  N('IsOdd', ['number'], (n) => Math.abs(num(n) % 2) === 1);
  N('IsNaN', ['number'], (n) => Number.isNaN(num(n)));
  N('Random', [], () => Math.random());
  N('RandomBetween', ['bottom', 'top'], (a, b) => num(a) + Math.random() * (num(b) - num(a)));
  N('Combinations', ['setSize', 'combinationSize'], (n, k) => { let r = 1; for (let i = 0; i < num(k); i++) r = (r * (num(n) - i)) / (i + 1); return Math.round(r); });
  N('Permutations', ['setSize', 'permutationSize'], (n, k) => { let r = 1; for (let i = 0; i < num(k); i++) r *= num(n) - i; return r; });
  N('Atan2', ['y', 'x'], (y, x) => Math.atan2(num(y), num(x)));
  N('BitwiseAnd', ['a', 'b'], (a, b) => num(a) & num(b));
  N('BitwiseOr', ['a', 'b'], (a, b) => num(a) | num(b));
  N('BitwiseXor', ['a', 'b'], (a, b) => num(a) ^ num(b));
  N('BitwiseNot', ['a'], (a) => ~num(a));
  N('BitwiseShiftLeft', ['a', 'b'], (a, b) => num(a) << num(b));
  N('BitwiseShiftRight', ['a', 'b'], (a, b) => num(a) >> num(b));
  lib.set('Number.PI', Math.PI); lib.set('Number.E', Math.E); lib.set('Number.Epsilon', Number.EPSILON);
  lib.set('Number.MaxValue', Number.MAX_VALUE); lib.set('Number.MinValue', -Number.MAX_VALUE);
  lib.set('Number.PositiveInfinity', Infinity); lib.set('Number.NegativeInfinity', -Infinity); lib.set('Number.NaN', NaN);
  lib.set('#infinity', Infinity); lib.set('#nan', NaN);
  const conv = (name: string, f: (x: number) => number) => def(lib, name + '.From', ['value', 'culture?', 'roundingMode?'], (v, c) => { const n = toNumber(v, culture(c)); return n === null ? null : f(n); });
  conv('Int64', (x) => round(x, 0, 'even')); conv('Int32', (x) => round(x, 0, 'even')); conv('Int16', (x) => round(x, 0, 'even')); conv('Int8', (x) => round(x, 0, 'even'));
  conv('Byte', (x) => round(x, 0, 'even')); conv('Double', (x) => x); conv('Single', (x) => Math.fround(x)); conv('Decimal', (x) => x);
  conv('Currency', (x) => round(x, 4, 'even')); conv('Percentage', (x) => x);

  /* ---- Logical ---- */
  def(lib, 'Logical.From', ['value'], (v) => (v === null ? null : typeof v === 'boolean' ? v : typeof v === 'number' ? v !== 0 : typeof v === 'string' ? logicalFromText(v) : (() => { throw err('Impossibile convertire il valore nel tipo Logical.'); })()));
  def(lib, 'Logical.FromText', ['text'], (s) => (s === null ? null : logicalFromText(text(s))));
  def(lib, 'Logical.ToText', ['logical'], (b) => (b === null ? null : bool(b) ? 'true' : 'false'));

  void cell; void call; void numN; void dateFromText;
}

function logicalFromText(s: string): boolean {
  const t = s.trim().toLowerCase();
  if (t === 'true') return true;
  if (t === 'false') return false;
  throw err(`Impossibile convertire "${s}" nel tipo Logical.`, 'DataFormat.Error');
}

import * as values from '../values';
const require_values = () => values;
export { MList };
