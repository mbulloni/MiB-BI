import type { Agg, ColumnMeta, FieldRef } from './types';

const NUMERIC = /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL.*)$/i;
export const isNumeric = (c?: ColumnMeta) => !!c && NUMERIC.test(c.type);
export const isDate = (c?: ColumnMeta) => !!c && /^(DATE|TIMESTAMP.*|TIME)$/i.test(c.type);

export const AGG_LABEL: Record<Agg, string> = {
  sum: 'Somma', avg: 'Media', min: 'Minimo', max: 'Massimo',
  count: 'Conteggio', countd: 'Conteggio (distinto)', median: 'Mediana', stdev: 'Deviazione standard', var: 'Varianza',
  none: 'Non riepilogare', measure: 'Misura', visualCalc: 'Calcolo visivo',
};

export const AGG_PREFIX: Record<Agg, string> = {
  sum: 'Somma di', avg: 'Media di', min: 'Minimo di', max: 'Massimo di',
  count: 'Conteggio di', countd: 'Conteggio di', median: 'Mediana di', stdev: 'Deviazione standard di', var: 'Varianza di', none: '', measure: '', visualCalc: '',
};

/** Name of a field inside its visual, untranslated: the name visual calculations and nativeQueryRef use. */
export function refLabel(f: FieldRef): string {
  if (f.datePart) return { year: 'Anno', quarter: 'Trimestre', month: 'Mese', day: 'Giorno' }[f.datePart];
  return f.agg === 'none' || f.agg === 'measure' || f.agg === 'visualCalc' ? f.column : `${AGG_PREFIX[f.agg]} ${f.column}`;
}

/** Traduzioni del modello in anteprima: captions of the selected culture ("Table" / "Table\u0001Field"). */
let CAPTIONS: Record<string, string> = {};
export function setCaptions(c: Record<string, string> | undefined) { CAPTIONS = c ?? {}; }
/** Display name of a table or of a field of `table` (translated when a culture is previewed). */
export const caption = (table: string, name?: string) => (name === undefined ? CAPTIONS[table] ?? table : CAPTIONS[`${table}\u0001${name}`] ?? name);

/** Name of a field as shown to the reader (titles, axes, headers): refLabel with the model translation. */
export function fieldLabel(f: FieldRef): string {
  if (f.datePart || f.agg === 'visualCalc' || !CAPTIONS[`${f.table}\u0001${f.column}`]) return refLabel(f);
  const name = caption(f.table, f.column);
  return f.agg === 'none' || f.agg === 'measure' ? name : `${AGG_PREFIX[f.agg]} ${name}`;
}

/** Impostazioni internazionali (Opzioni): locale of numbers and dates shown in visuals. */
let LOCALE = 'it-IT';
export const locale = () => LOCALE;
export function setLocale(l: string) { LOCALE = l || 'it-IT'; }
/** Month names (January = 0) and weekday names (Sunday = 0) in the current locale, lower case like Power BI Italian. */
export const monthNames = (short = false) => Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat(LOCALE, { month: short ? 'short' : 'long', timeZone: 'UTC' }).format(Date.UTC(2020, m, 1)).replace('.', ''));
export const dayNames = (short = false) => Array.from({ length: 7 }, (_, d) => new Intl.DateTimeFormat(LOCALE, { weekday: short ? 'short' : 'long', timeZone: 'UTC' }).format(Date.UTC(2020, 2, 1 + d)).replace('.', ''));
/** Quarter label prefix of the date hierarchy ("Trim 1" in Italian, "Qtr 1" in English). */
export const quarterPrefix = () => (LOCALE.startsWith('it') ? 'Trim ' : LOCALE.startsWith('de') ? 'Quartal ' : LOCALE.startsWith('fr') ? 'Trim. ' : LOCALE.startsWith('es') ? 'Trim. ' : 'Qtr ');

const nf = (d: number) => new Intl.NumberFormat(LOCALE, { maximumFractionDigits: d, minimumFractionDigits: 0, useGrouping: 'always' });

/** Value with a Power BI / Excel number format string ("#,0.00", "0.0%", "€ #,0", sections "pos;neg;zero"). */
export function fmtWith(v: unknown, format: string | undefined): string {
  if (v === null || v === undefined || v === '') return '(Vuoto)';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const f = (format ?? '').trim();
  if (!f || /^(general|g)$/i.test(f)) return fmtFull(n);
  if (/^percent$/i.test(f)) return fmtWith(n, '0.00%');
  // Sections outside quotes.
  const sections: string[] = [];
  let cur = '', q = false;
  for (const ch of f) { if (ch === '"') q = !q; if (ch === ';' && !q) { sections.push(cur); cur = ''; } else cur += ch; }
  sections.push(cur);
  let sec = sections[0], x = n;
  if (n < 0 && sections[1] !== undefined) { sec = sections[1]; x = -n; } else if (n === 0 && sections[2] !== undefined) sec = sections[2];
  // Literal text (quoted, escaped, or any char that is not a placeholder) before and after the number.
  const parts: { lit: boolean; t: string }[] = [];
  for (let i = 0; i < sec.length; i++) {
    const ch = sec[i];
    if (ch === '"') { const j = sec.indexOf('"', i + 1); parts.push({ lit: true, t: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j; }
    else if (ch === '\\') { parts.push({ lit: true, t: sec[i + 1] ?? '' }); i++; }
    else parts.push({ lit: !/[0#,.%]/.test(ch), t: ch });
  }
  const first = parts.findIndex((p) => !p.lit && /[0#]/.test(p.t));
  if (first < 0) return parts.map((p) => p.t).join('');
  let last = first;
  parts.forEach((p, i) => { if (!p.lit && /[0#.,]/.test(p.t)) last = i; });
  const body = parts.slice(first, last + 1).filter((p) => !p.lit).map((p) => p.t).join('');
  const pct = parts.some((p) => !p.lit && p.t === '%');
  const [int, dec = ''] = body.split('.');
  const minF = (dec.match(/0/g) ?? []).length, maxF = (dec.match(/[0#]/g) ?? []).length;
  const scale = /,+$/.exec(int)?.[0].length ?? 0;
  const value = (pct ? x * 100 : x) / 1000 ** scale;
  const num = new Intl.NumberFormat(LOCALE, { minimumFractionDigits: minF, maximumFractionDigits: maxF, useGrouping: int.replace(/,+$/, '').includes(',') ? 'always' : false, minimumIntegerDigits: Math.max(1, (int.match(/0/g) ?? []).length) }).format(value);
  const text = (from: number, to: number) => parts.slice(from, to).map((p) => (!p.lit && p.t === '%' ? '%' : p.lit ? p.t : '')).join('');
  return text(0, first) + num + text(last + 1, parts.length);
}

/** Power BI "Auto" display units: K, Mln, Mld. */
export function fmtAuto(v: unknown, digits = 2): string {
  if (v === null || v === undefined || v === '') return '(Vuoto)';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const a = Math.abs(n);
  if (a >= 1e9) return nf(digits).format(n / 1e9) + ' Mld';
  if (a >= 1e6) return nf(digits).format(n / 1e6) + ' Mln';
  if (a >= 1e3) return nf(digits).format(n / 1e3) + ' K';
  return nf(digits).format(n);
}

/** Percentage for measures whose Power BI format string contains "%". */
export function fmtPct(v: unknown): string {
  if (v === null || v === undefined || v === '') return '(Vuoto)';
  const n = Number(v);
  return Number.isFinite(n) ? nf(1).format(n * 100) + '%' : String(v);
}

/** Full number, used in tables and tooltips. */
export function fmtFull(v: unknown): string {
  if (v === null || v === undefined || v === '') return '';
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  return nf(Number.isInteger(n) ? 0 : 2).format(n);
}

/** Power BI default theme palette. */
export const PALETTE = ['#118DFF', '#12239E', '#E66C37', '#6B007B', '#E044A7', '#744EC2', '#D9B300', '#D64550',
  '#197278', '#1AAB40', '#15C6F4', '#4092FF', '#FFA058', '#BE5DC9', '#F472D0', '#B5A1FF'];

export const uid = () => Math.random().toString(36).slice(2, 10);
