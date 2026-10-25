// Date.*, DateTime.*, DateTimeZone.*, Time.*, Duration.* and #date/#datetime/#time/#duration/#datetimezone.
import { DAY, MDate, MDateTime, MDateTimeZone, MDuration, MList, MRecord, MTime } from '../values';
import { type Lib, culture, def, err, num, numN, text, textN } from './core';

const pad = (n: number, w = 2) => String(Math.trunc(Math.abs(n))).padStart(w, '0');
const monthName = (m: number, c: string, style: 'long' | 'short') => new Intl.DateTimeFormat(c, { month: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2000, m - 1, 1)));
const dayName = (dow: number, c: string, style: 'long' | 'short') => new Intl.DateTimeFormat(c, { weekday: style, timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + dow)));

/** Parts of a date/time value (wall clock). */
function parts(v: unknown): { y: number; mo: number; d: number; h: number; mi: number; s: number; ms: number; dow: number; off?: number } {
  let ms: number, off: number | undefined;
  if (v instanceof MDate) ms = v.days * DAY;
  else if (v instanceof MDateTime) ms = v.ms;
  else if (v instanceof MDateTimeZone) { ms = v.ms; off = v.offset; }
  else if (v instanceof MTime) ms = v.ms;
  else throw err('Atteso un valore data/ora.');
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), dow: d.getUTCDay(), off };
}

/** .NET standard (d, D, t, T, g, G, s, o, u, M, Y) and custom (yyyy-MM-dd HH:mm:ss, dddd, MMMM, tt…) date formats. */
export function toText(v: unknown, format: string | null, cult: string): string {
  if (v instanceof MDuration) {
    if (format) return customDuration(v, format);
    return v.toString();
  }
  const p = parts(v);
  const isDate = v instanceof MDate, isTime = v instanceof MTime;
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, p.ms));
  const I = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(cult, { ...o, timeZone: 'UTC' }).format(dt);
  if (!format) {
    if (isDate) return I({ year: 'numeric', month: '2-digit', day: '2-digit' });
    if (isTime) return I({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const base = I({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
    return v instanceof MDateTimeZone ? `${base} ${offsetText(p.off!)}` : base;
  }
  if (format.length === 1) {
    switch (format) {
      case 'd': return I({ year: 'numeric', month: '2-digit', day: '2-digit' });
      case 'D': return I({ weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      case 't': return I({ hour: '2-digit', minute: '2-digit' });
      case 'T': return I({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
      case 'g': return I({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
      case 'G': return I({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).replace(',', '');
      case 'M': case 'm': return I({ month: 'long', day: 'numeric' });
      case 'Y': case 'y': return I({ month: 'long', year: 'numeric' });
      case 's': return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
      case 'u': return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}Z`;
      case 'o': case 'O': return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}.${pad(p.ms * 10000, 7)}${p.off !== undefined ? offsetText(p.off) : ''}`;
    }
  }
  return format.replace(/("[^"]*"|'[^']*'|\\.)|(yyyy|yyy|yy|y|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fffffff|ffffff|fffff|ffff|fff|ff|f|tt|t|zzz|zz|z|K|%)/g, (m, lit) => {
    if (lit) return lit.startsWith('\\') ? lit.slice(1) : lit.slice(1, -1);
    switch (m) {
      case 'yyyy': return pad(p.y, 4); case 'yyy': return pad(p.y, 3); case 'yy': return pad(p.y % 100); case 'y': return String(p.y % 100);
      case 'MMMM': return monthName(p.mo, cult, 'long'); case 'MMM': return monthName(p.mo, cult, 'short'); case 'MM': return pad(p.mo); case 'M': return String(p.mo);
      case 'dddd': return dayName(p.dow, cult, 'long'); case 'ddd': return dayName(p.dow, cult, 'short'); case 'dd': return pad(p.d); case 'd': return String(p.d);
      case 'HH': return pad(p.h); case 'H': return String(p.h);
      case 'hh': return pad(p.h % 12 || 12); case 'h': return String(p.h % 12 || 12);
      case 'mm': return pad(p.mi); case 'm': return String(p.mi);
      case 'ss': return pad(p.s); case 's': return String(p.s);
      case 'tt': return p.h < 12 ? 'AM' : 'PM'; case 't': return p.h < 12 ? 'A' : 'P';
      case 'zzz': case 'K': return p.off !== undefined ? offsetText(p.off) : ''; case 'zz': case 'z': return p.off !== undefined ? (p.off < 0 ? '-' : '+') + pad(Math.abs(p.off) / 60) : '';
      case '%': return '';
      default: if (m.startsWith('f')) return String(p.ms).padStart(3, '0').padEnd(m.length, '0').slice(0, m.length); return m;
    }
  });
}
const offsetText = (o: number) => `${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
function customDuration(d: MDuration, f: string) {
  const a = Math.abs(d.ms), days = Math.floor(a / DAY), h = Math.floor(a / 3600000) % 24, m = Math.floor(a / 60000) % 60, s = Math.floor(a / 1000) % 60;
  return f.replace(/\\(.)|dd?|hh?|mm?|ss?/g, (x, lit) => (lit ? lit : x[0] === 'd' ? (x.length === 2 ? pad(days) : String(days)) : x[0] === 'h' ? (x.length === 2 ? pad(h) : String(h)) : x[0] === 'm' ? (x.length === 2 ? pad(m) : String(m)) : x.length === 2 ? pad(s) : String(s)));
}

/** Date/time text in ISO, culture order (d/m/y or m/d/y), month names, optional time and offset. */
export function fromText(s: string, kind: 'date' | 'datetime' | 'datetimezone' | 'time', cult: string, format: string | null = null): any {
  const t = s.trim();
  if (format) return fromFormat(t, format, kind, cult);
  if (kind === 'time') {
    const m = /^(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(AM|PM)?$/i.exec(t);
    if (!m) throw bad(s, kind);
    let h = Number(m[1]); if (m[5]) { h %= 12; if (/pm/i.test(m[5])) h += 12; }
    return new MTime(((h * 60 + Number(m[2])) * 60 + Number(m[3] ?? 0)) * 1000 + Number(('0.' + (m[4] ?? '0'))) * 1000);
  }
  // ISO first.
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(t);
  let y: number, mo: number, d: number, h = 0, mi = 0, sec = 0, frac = 0, off: number | null = null;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    h = Number(m[4] ?? 0); mi = Number(m[5] ?? 0); sec = Number(m[6] ?? 0); frac = Number('0.' + (m[7] ?? '0'));
    if (m[8]) off = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)));
  } else {
    m = /^(\d{1,2})[/.\- ](\d{1,2}|[\p{L}.]+)[/.\- ](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/iu.exec(t);
    if (!m) {
      const n = /^(\p{L}+)[ .]+(\d{1,2}),?\s+(\d{4})$/u.exec(t);
      if (n) { mo = monthIndex(n[1], cult); d = Number(n[2]); y = Number(n[3]); }
      else throw bad(s, kind);
    } else {
      const monthFirst = /^en-US|^en-PH|^fil/.test(cult);
      const a = Number(m[1]), bTok = m[2], c = Number(m[3]);
      const b = /^\d+$/.test(bTok) ? Number(bTok) : monthIndex(bTok, cult);
      if (/^\d+$/.test(bTok) && monthFirst) { mo = a; d = b; } else { d = a; mo = b; }
      y = c < 100 ? (c < 30 ? 2000 + c : 1900 + c) : c;
      h = Number(m[4] ?? 0); mi = Number(m[5] ?? 0); sec = Number(m[6] ?? 0);
      if (m[7]) { h %= 12; if (/pm/i.test(m[7])) h += 12; }
      if (m[8]) off = m[8] === 'Z' ? 0 : (m[8][0] === '-' ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)));
    }
  }
  if (!(mo! >= 1 && mo! <= 12 && d! >= 1 && d! <= 31)) throw bad(s, kind);
  const ms = Date.UTC(y!, mo! - 1, d!, h, mi, sec) + Math.round(frac * 1000);
  if (new Date(ms).getUTCDate() !== d!) throw bad(s, kind);
  if (kind === 'date') return new MDate(Math.floor(ms / DAY));
  if (kind === 'datetime') return new MDateTime(ms);
  return new MDateTimeZone(ms, off ?? 0);
}
function monthIndex(name: string, cult: string): number {
  const n = name.replace(/\.$/, '').toLowerCase();
  for (const c of [cult, 'en-US']) for (let i = 1; i <= 12; i++) {
    const long = monthName(i, c, 'long').toLowerCase(), short = monthName(i, c, 'short').toLowerCase().replace(/\.$/, '');
    if (n === long || n === short || (n.length >= 3 && long.startsWith(n))) return i;
  }
  throw err(`Mese non riconosciuto: ${name}`, 'DataFormat.Error');
}
const bad = (s: string, kind: string) => err(`Impossibile analizzare l'input fornito come valore ${kind === 'date' ? 'Date' : kind === 'time' ? 'Time' : 'DateTime'}: "${s}".`, 'DataFormat.Error', s);

/** Parse with a custom .NET format (Date.FromText(text, [Format="dd/MM/yyyy"])). */
function fromFormat(s: string, f: string, kind: 'date' | 'datetime' | 'datetimezone' | 'time', cult: string): any {
  const groups: string[] = [];
  const re = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|tt|fff/g, (t) => {
    groups.push(t);
    return t.startsWith('MMM') ? '(\\p{L}+\\.?)' : t === 'tt' ? '(AM|PM)' : t === 'yyyy' ? '(\\d{4})' : t === 'fff' ? '(\\d{3})' : t.length === 2 ? '(\\d{2})' : '(\\d{1,2})';
  });
  const m = new RegExp('^' + re + '$', 'iu').exec(s);
  if (!m) throw bad(s, kind);
  let y = 1900, mo = 1, d = 1, h = 0, mi = 0, sec = 0, ms = 0, pm: boolean | null = null;
  groups.forEach((g, i) => {
    const v = m[i + 1];
    if (g.startsWith('y')) y = g === 'yy' ? 2000 + Number(v) : Number(v);
    else if (g.startsWith('MMM')) mo = monthIndex(v, cult);
    else if (g.startsWith('M')) mo = Number(v);
    else if (g.startsWith('d')) d = Number(v);
    else if (g.startsWith('H') || g.startsWith('h')) h = Number(v);
    else if (g.startsWith('m')) mi = Number(v);
    else if (g.startsWith('s')) sec = Number(v);
    else if (g === 'fff') ms = Number(v);
    else if (g === 'tt') pm = /pm/i.test(v);
  });
  if (pm !== null) { h %= 12; if (pm) h += 12; }
  if (kind === 'time') return new MTime(((h * 60 + mi) * 60 + sec) * 1000 + ms);
  const t = Date.UTC(y, mo - 1, d, h, mi, sec, ms);
  return kind === 'date' ? new MDate(Math.floor(t / DAY)) : kind === 'datetime' ? new MDateTime(t) : new MDateTimeZone(t, 0);
}

/** Any value → date/datetime (Date.From, DateTime.From): numbers as OLE dates, text parsed. */
function toDateTime(v: unknown, kind: 'date' | 'datetime' | 'datetimezone' | 'time', cult: string): any {
  if (v === null) return null;
  if (typeof v === 'string') return fromText(v, kind, cult);
  if (typeof v === 'number') {
    const ms = Math.round((v - 25569) * DAY);
    if (kind === 'date') return new MDate(Math.floor(ms / DAY));
    if (kind === 'time') return new MTime(Math.round((v % 1) * DAY));
    return kind === 'datetime' ? new MDateTime(ms) : new MDateTimeZone(ms, 0);
  }
  const ms = v instanceof MDate ? v.days * DAY : v instanceof MDateTime ? v.ms : v instanceof MDateTimeZone ? v.ms : null;
  if (kind === 'time') { if (v instanceof MTime) return v; if (ms !== null) return new MTime(((ms % DAY) + DAY) % DAY); }
  if (ms === null) throw err(`Impossibile convertire il valore nel tipo ${kind}.`);
  if (kind === 'date') return new MDate(Math.floor(ms / DAY));
  if (kind === 'datetime') return new MDateTime(ms);
  return v instanceof MDateTimeZone ? v : new MDateTimeZone(ms, -new Date().getTimezoneOffset());
}

const msOf = (v: unknown): number => (v instanceof MDate ? v.days * DAY : v instanceof MDateTime || v instanceof MDateTimeZone ? v.ms : (() => { throw err('Atteso un valore data/ora.'); })());
/** Same kind as `like`, at wall-clock ms. */
const like = (v: unknown, ms: number): any => (v instanceof MDate ? new MDate(Math.floor(ms / DAY)) : v instanceof MDateTimeZone ? new MDateTimeZone(ms, v.offset) : new MDateTime(ms));
const addMonths = (v: unknown, n: number) => {
  const p = parts(v), last = new Date(Date.UTC(p.y, p.mo - 1 + n + 1, 0)).getUTCDate();
  return like(v, Date.UTC(p.y, p.mo - 1 + n, Math.min(p.d, last), p.h, p.mi, p.s, p.ms));
};
/** Day.Sunday = 0 … Day.Saturday = 6; weeks start on Sunday unless firstDayOfWeek is given. */
const startOfWeek = (v: unknown, first: number | null) => { const p = parts(v); const back = (p.dow - (first ?? 0) + 7) % 7; return like(v, Date.UTC(p.y, p.mo - 1, p.d - back)); };

export function register(lib: Lib) {
  /* ---- intrinsics ---- */
  def(lib, '#date', ['year', 'month', 'day'], (y, m, d) => { const r = MDate.of(num(y), num(m), num(d)); if (r.d !== num(d)) throw err('Gli argomenti di #date non rappresentano una data valida.'); return r; });
  def(lib, '#datetime', ['year', 'month', 'day', 'hour', 'minute', 'second'], (y, mo, d, h, mi, s) => MDateTime.of(num(y), num(mo), num(d), num(h), num(mi), num(s)));
  def(lib, '#datetimezone', ['year', 'month', 'day', 'hour', 'minute', 'second', 'offsetHours', 'offsetMinutes'], (y, mo, d, h, mi, s, oh, om) => new MDateTimeZone(MDateTime.of(num(y), num(mo), num(d), num(h), num(mi), num(s)).ms, num(oh) * 60 + Math.sign(num(oh) || 1) * num(om)));
  def(lib, '#time', ['hour', 'minute', 'second'], (h, m, s) => MTime.of(num(h), num(m), num(s)));
  def(lib, '#duration', ['days', 'hours', 'minutes', 'seconds'], (d, h, m, s) => MDuration.of(num(d), num(h), num(m), num(s)));

  for (const [ns, kind] of [['Date', 'date'], ['DateTime', 'datetime'], ['DateTimeZone', 'datetimezone'], ['Time', 'time']] as const) {
    def(lib, `${ns}.From`, ['value', 'culture?'], (v, c) => toDateTime(v, kind, culture(c)));
    def(lib, `${ns}.FromText`, ['text', 'options?'], (s, o) => (s === null ? null : fromText(text(s), kind, culture(o), o instanceof MRecord && o.has('Format') ? textN(o.get('Format')) : null)));
    def(lib, `${ns}.ToText`, ['value', 'options?', 'culture?'], (v, o, c) => (v === null ? null : toText(v, typeof o === 'string' ? o : o instanceof MRecord && o.has('Format') ? textN(o.get('Format')) : null, culture(o instanceof MRecord ? o : c))));
    def(lib, `${ns}.ToRecord`, ['value'], (v) => { const p = parts(v); return kind === 'time' ? MRecord.from({ Hour: p.h, Minute: p.mi, Second: p.s + p.ms / 1000 }) : kind === 'date' ? MRecord.from({ Year: p.y, Month: p.mo, Day: p.d }) : MRecord.from({ Year: p.y, Month: p.mo, Day: p.d, Hour: p.h, Minute: p.mi, Second: p.s + p.ms / 1000 }); });
  }
  const D = (n: string, p: string[], f: (...a: any[]) => any) => { def(lib, 'Date.' + n, p, f); };
  const nul = (f: (v: any, ...r: any[]) => any) => (v: any, ...r: any[]) => (v === null ? null : f(v, ...r));
  D('Year', ['dateTime'], nul((v) => parts(v).y)); D('Month', ['dateTime'], nul((v) => parts(v).mo)); D('Day', ['dateTime'], nul((v) => parts(v).d));
  D('DayOfWeek', ['dateTime', 'firstDayOfWeek?'], nul((v, f) => (parts(v).dow - (f ?? 0) + 7) % 7));
  D('DayOfYear', ['dateTime'], nul((v) => { const p = parts(v); return Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / DAY) + 1; }));
  D('DayOfWeekName', ['date', 'culture?'], nul((v, c) => dayName(parts(v).dow, culture(c), 'long')));
  D('MonthName', ['date', 'culture?'], nul((v, c) => monthName(parts(v).mo, culture(c), 'long')));
  D('QuarterOfYear', ['dateTime'], nul((v) => Math.ceil(parts(v).mo / 3)));
  D('WeekOfYear', ['dateTime', 'firstDayOfWeek?'], nul((v, f) => { const p = parts(v); const jan1 = new Date(Date.UTC(p.y, 0, 1)).getUTCDay(); const doy = Math.round((Date.UTC(p.y, p.mo - 1, p.d) - Date.UTC(p.y, 0, 1)) / DAY); return Math.floor((doy + ((jan1 - (f ?? 0) + 7) % 7)) / 7) + 1; }));
  D('WeekOfMonth', ['dateTime', 'firstDayOfWeek?'], nul((v, f) => { const p = parts(v); const first = new Date(Date.UTC(p.y, p.mo - 1, 1)).getUTCDay(); return Math.floor((p.d - 1 + ((first - (f ?? 0) + 7) % 7)) / 7) + 1; }));
  D('DaysInMonth', ['dateTime'], nul((v) => { const p = parts(v); return new Date(Date.UTC(p.y, p.mo, 0)).getUTCDate(); }));
  D('IsLeapYear', ['dateTime'], nul((v) => { const y = parts(v).y; return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }));
  D('AddDays', ['dateTime', 'numberOfDays'], nul((v, n) => like(v, msOf(v) + num(n) * DAY)));
  D('AddWeeks', ['dateTime', 'numberOfWeeks'], nul((v, n) => like(v, msOf(v) + num(n) * 7 * DAY)));
  D('AddMonths', ['dateTime', 'numberOfMonths'], nul((v, n) => addMonths(v, num(n))));
  D('AddQuarters', ['dateTime', 'numberOfQuarters'], nul((v, n) => addMonths(v, num(n) * 3)));
  D('AddYears', ['dateTime', 'numberOfYears'], nul((v, n) => addMonths(v, num(n) * 12)));
  D('StartOfYear', ['dateTime'], nul((v) => like(v, Date.UTC(parts(v).y, 0, 1))));
  D('EndOfYear', ['dateTime'], nul((v) => (v instanceof MDate ? like(v, Date.UTC(parts(v).y, 11, 31)) : like(v, Date.UTC(parts(v).y + 1, 0, 1) - 1))));
  D('StartOfQuarter', ['dateTime'], nul((v) => { const p = parts(v); return like(v, Date.UTC(p.y, Math.floor((p.mo - 1) / 3) * 3, 1)); }));
  D('EndOfQuarter', ['dateTime'], nul((v) => { const p = parts(v); const e = Date.UTC(p.y, Math.floor((p.mo - 1) / 3) * 3 + 3, 1); return like(v, v instanceof MDate ? e - DAY : e - 1); }));
  D('StartOfMonth', ['dateTime'], nul((v) => { const p = parts(v); return like(v, Date.UTC(p.y, p.mo - 1, 1)); }));
  D('EndOfMonth', ['dateTime'], nul((v) => { const p = parts(v); const e = Date.UTC(p.y, p.mo, 1); return like(v, v instanceof MDate ? e - DAY : e - 1); }));
  D('StartOfWeek', ['dateTime', 'firstDayOfWeek?'], nul((v, f) => startOfWeek(v, f)));
  D('EndOfWeek', ['dateTime', 'firstDayOfWeek?'], nul((v, f) => { const s = startOfWeek(v, f); return like(v, msOf(s) + (v instanceof MDate ? 6 * DAY : 7 * DAY - 1)); }));
  D('StartOfDay', ['dateTime'], nul((v) => like(v, Math.floor(msOf(v) / DAY) * DAY)));
  D('EndOfDay', ['dateTime'], nul((v) => like(v, Math.floor(msOf(v) / DAY) * DAY + (v instanceof MDate ? 0 : DAY - 1))));
  const today = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()); };
  const rel = (name: string, unit: 'day' | 'week' | 'month' | 'quarter' | 'year', dir: -1 | 0 | 1) => {
    D(`IsIn${dir === 0 ? 'Current' : dir < 0 ? 'Previous' : 'Next'}${unit[0].toUpperCase() + unit.slice(1)}`, ['dateTime'], nul((v) => inPeriod(v, unit, dir, 1)));
    if (dir !== 0) D(`IsIn${dir < 0 ? 'Previous' : 'Next'}N${unit[0].toUpperCase() + unit.slice(1)}s`, ['dateTime', 'n'], nul((v, n) => inPeriod(v, unit, dir, num(n))));
    void name;
  };
  const inPeriod = (v: unknown, unit: string, dir: number, n: number) => {
    const t = new MDate(Math.floor(today() / DAY));
    const start = (x: any) => unit === 'day' ? x : unit === 'week' ? startOfWeek(x, 0) : unit === 'month' ? like(x, Date.UTC(parts(x).y, parts(x).mo - 1, 1)) : unit === 'quarter' ? like(x, Date.UTC(parts(x).y, Math.floor((parts(x).mo - 1) / 3) * 3, 1)) : like(x, Date.UTC(parts(x).y, 0, 1));
    const shift = (x: any, k: number) => unit === 'day' ? like(x, msOf(x) + k * DAY) : unit === 'week' ? like(x, msOf(x) + k * 7 * DAY) : addMonths(x, k * (unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12));
    const cur = start(t);
    const [a, b] = dir === 0 ? [cur, shift(cur, 1)] : dir < 0 ? [shift(cur, -n), cur] : [shift(cur, 1), shift(cur, n + 1)];
    const x = Math.floor(msOf(v) / DAY) * DAY;
    return x >= msOf(a) && x < msOf(b);
  };
  for (const u of ['day', 'week', 'month', 'quarter', 'year'] as const) for (const d of [-1, 0, 1] as const) rel('', u, d);
  D('IsInYearToDate', ['dateTime'], nul((v) => { const t = today(); const x = msOf(v); return x >= Date.UTC(new Date(t).getUTCFullYear(), 0, 1) && x <= t; }));
  D('Date', ['dateTime'], nul((v) => new MDate(Math.floor(msOf(v) / DAY))));
  D('ToText', ['date', 'options?', 'culture?'], (v, o, c) => (v === null ? null : toText(v, typeof o === 'string' ? o : o instanceof MRecord && o.has('Format') ? textN(o.get('Format')) : null, culture(o instanceof MRecord ? o : c))));
  def(lib, 'DateTime.Date', ['dateTime'], nul((v) => new MDate(Math.floor(msOf(v) / DAY))));
  def(lib, 'DateTime.Time', ['dateTime'], nul((v) => new MTime(((msOf(v) % DAY) + DAY) % DAY)));
  def(lib, 'DateTime.LocalNow', [], () => { const n = new Date(); return new MDateTime(n.getTime() - n.getTimezoneOffset() * 60000); });
  def(lib, 'DateTime.FixedLocalNow', [], () => { const n = new Date(); return new MDateTime(n.getTime() - n.getTimezoneOffset() * 60000); });
  def(lib, 'DateTimeZone.LocalNow', [], () => { const n = new Date(); return new MDateTimeZone(n.getTime() - n.getTimezoneOffset() * 60000, -n.getTimezoneOffset()); });
  def(lib, 'DateTimeZone.UtcNow', [], () => new MDateTimeZone(Date.now(), 0));
  def(lib, 'DateTimeZone.FixedUtcNow', [], () => new MDateTimeZone(Date.now(), 0));
  def(lib, 'DateTimeZone.ZoneHours', ['dateTimeZone'], nul((v) => Math.trunc(v.offset / 60)));
  def(lib, 'DateTimeZone.ZoneMinutes', ['dateTimeZone'], nul((v) => v.offset % 60));
  def(lib, 'DateTimeZone.RemoveZone', ['dateTimeZone'], nul((v) => new MDateTime(v.ms)));
  def(lib, 'DateTimeZone.SwitchZone', ['dateTimeZone', 'timezoneHours', 'timezoneMinutes?'], nul((v, h, m) => { const off = num(h) * 60 + (numN(m) ?? 0); return new MDateTimeZone(v.utc + off * 60000, off); }));
  def(lib, 'DateTimeZone.ToUtc', ['dateTimeZone'], nul((v) => new MDateTimeZone(v.utc, 0)));
  def(lib, 'DateTimeZone.ToLocal', ['dateTimeZone'], nul((v) => { const off = -new Date().getTimezoneOffset(); return new MDateTimeZone(v.utc + off * 60000, off); }));
  def(lib, 'DateTime.AddZone', ['dateTime', 'timezoneHours', 'timezoneMinutes?'], nul((v, h, m) => new MDateTimeZone(v.ms, num(h) * 60 + (numN(m) ?? 0))));
  def(lib, 'DateTime.ToRecord', ['dateTime'], nul((v) => { const p = parts(v); return MRecord.from({ Year: p.y, Month: p.mo, Day: p.d, Hour: p.h, Minute: p.mi, Second: p.s }); }));
  def(lib, 'DateTime.IsInCurrentHour', ['dateTime'], nul((v) => { const n = new Date(); return Math.floor(msOf(v) / 3600000) === Math.floor((n.getTime() - n.getTimezoneOffset() * 60000) / 3600000); }));
  def(lib, 'Time.Hour', ['dateTime'], nul((v) => parts(v).h));
  def(lib, 'Time.Minute', ['dateTime'], nul((v) => parts(v).mi));
  def(lib, 'Time.Second', ['dateTime'], nul((v) => parts(v).s + parts(v).ms / 1000));
  def(lib, 'Time.StartOfHour', ['dateTime'], nul((v) => (v instanceof MTime ? new MTime(Math.floor(v.ms / 3600000) * 3600000) : like(v, Math.floor(msOf(v) / 3600000) * 3600000))));
  def(lib, 'Time.EndOfHour', ['dateTime'], nul((v) => (v instanceof MTime ? new MTime(Math.floor(v.ms / 3600000) * 3600000 + 3599999) : like(v, Math.floor(msOf(v) / 3600000) * 3600000 + 3599999))));

  /* ---- Duration ---- */
  const dur = (v: any): MDuration => { if (v instanceof MDuration) return v; throw err('Atteso un valore Duration.'); };
  def(lib, 'Duration.From', ['value'], (v) => (v === null ? null : v instanceof MDuration ? v : typeof v === 'number' ? new MDuration(v * DAY) : typeof v === 'string' ? durationFromText(v) : (() => { throw err('Impossibile convertire il valore nel tipo Duration.'); })()));
  def(lib, 'Duration.FromText', ['text'], (s) => (s === null ? null : durationFromText(text(s))));
  def(lib, 'Duration.ToText', ['duration', 'format?'], (d, f) => (d === null ? null : toText(dur(d), textN(f), culture(null))));
  def(lib, 'Duration.Days', ['duration'], nul((d) => Math.trunc(dur(d).ms / DAY)));
  def(lib, 'Duration.Hours', ['duration'], nul((d) => Math.trunc(dur(d).ms / 3600000) % 24));
  def(lib, 'Duration.Minutes', ['duration'], nul((d) => Math.trunc(dur(d).ms / 60000) % 60));
  def(lib, 'Duration.Seconds', ['duration'], nul((d) => (dur(d).ms % 60000) / 1000));
  def(lib, 'Duration.TotalDays', ['duration'], nul((d) => dur(d).ms / DAY));
  def(lib, 'Duration.TotalHours', ['duration'], nul((d) => dur(d).ms / 3600000));
  def(lib, 'Duration.TotalMinutes', ['duration'], nul((d) => dur(d).ms / 60000));
  def(lib, 'Duration.TotalSeconds', ['duration'], nul((d) => dur(d).ms / 1000));
  def(lib, 'Duration.ToRecord', ['duration'], nul((d) => { const ms = dur(d).ms; return MRecord.from({ Days: Math.trunc(ms / DAY), Hours: Math.trunc(ms / 3600000) % 24, Minutes: Math.trunc(ms / 60000) % 60, Seconds: (ms % 60000) / 1000 }); }));

  /* ---- List.Dates & co ---- */
  def(lib, 'List.Dates', ['start', 'count', 'step'], (s, n, st) => new MList(Array.from({ length: num(n) }, (_, i) => like(s, msOf(s) + i * dur(st).ms))));
  def(lib, 'List.DateTimes', ['start', 'count', 'step'], (s, n, st) => new MList(Array.from({ length: num(n) }, (_, i) => like(s, msOf(s) + i * dur(st).ms))));
  def(lib, 'List.DateTimeZones', ['start', 'count', 'step'], (s, n, st) => new MList(Array.from({ length: num(n) }, (_, i) => like(s, msOf(s) + i * dur(st).ms))));
  def(lib, 'List.Times', ['start', 'count', 'step'], (s, n, st) => new MList(Array.from({ length: num(n) }, (_, i) => new MTime((((s as MTime).ms + i * dur(st).ms) % DAY + DAY) % DAY))));
  def(lib, 'List.Durations', ['start', 'count', 'step'], (s, n, st) => new MList(Array.from({ length: num(n) }, (_, i) => new MDuration(dur(s).ms + i * dur(st).ms))));

  // Day.* and enumerations
  ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].forEach((d, i) => lib.set('Day.' + d, i));
}

function durationFromText(s: string): MDuration {
  const m = /^\s*(-)?(?:(\d+)[.:])?(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*$/.exec(s);
  if (!m) throw err(`Impossibile convertire "${s}" nel tipo Duration.`, 'DataFormat.Error');
  const ms = ((Number(m[2] ?? 0) * 24 + Number(m[3])) * 60 + Number(m[4])) * 60000 + Number(m[5] ?? 0) * 1000 + Number('0.' + (m[6] ?? '0')) * 1000;
  return new MDuration(m[1] ? -ms : ms);
}
