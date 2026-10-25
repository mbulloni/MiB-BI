// Value conversion to a type (Table.TransformColumnTypes, Value.As with conversion, column types of loaded tables).
import { MDate, MDateTime, MDateTimeZone, MDuration, MTime, MType, err } from '../values';
import { toNumber, toText } from './text';
import { fromText } from './datetime';

const round0 = (x: number) => { const f = Math.floor(x), d = x - f; return Math.abs(d - 0.5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(x); };

export function convertTo(v: unknown, t: MType, cult: string): unknown {
  if (v === null) return null;
  switch (t.kind) {
    case 'any': case 'anynonnull': return v;
    case 'text': return toText(v, cult);
    case 'number': {
      const n = toNumber(v, cult);
      if (n === null) return null;
      if (t.facet && /^(Int64|Int32|Int16|Int8|Byte)$/.test(t.facet)) return round0(n);
      if (t.facet === 'Currency') return Math.round(n * 10000) / 10000;
      return n;
    }
    case 'logical': {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'string') { const s = v.trim().toLowerCase(); if (s === 'true') return true; if (s === 'false') return false; }
      throw err(`Impossibile convertire il valore "${String(v)}" nel tipo Logical.`, 'DataFormat.Error', v);
    }
    case 'date': case 'datetime': case 'datetimezone': case 'time': {
      if (typeof v === 'string') return fromText(v, t.kind, cult);
      if (typeof v === 'number') {
        const ms = Math.round((v - 25569) * 86400000);
        return t.kind === 'date' ? new MDate(Math.floor(ms / 86400000)) : t.kind === 'time' ? new MTime(Math.round((v % 1) * 86400000)) : t.kind === 'datetime' ? new MDateTime(ms) : new MDateTimeZone(ms, 0);
      }
      const ms = v instanceof MDate ? v.days * 86400000 : v instanceof MDateTime ? v.ms : v instanceof MDateTimeZone ? v.ms : null;
      if (t.kind === 'time') { if (v instanceof MTime) return v; if (ms !== null) return new MTime(((ms % 86400000) + 86400000) % 86400000); }
      if (ms === null) throw err(`Impossibile convertire il valore nel tipo ${t.kind}.`, 'DataFormat.Error');
      if (t.kind === 'date') return new MDate(Math.floor(ms / 86400000));
      if (t.kind === 'datetime') return new MDateTime(ms);
      return v instanceof MDateTimeZone ? v : new MDateTimeZone(ms, 0);
    }
    case 'duration': {
      if (v instanceof MDuration) return v;
      if (typeof v === 'number') return new MDuration(v * 86400000);
      if (typeof v === 'string') {
        const m = /^\s*(-)?(?:(\d+)[.:])?(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(v);
        if (m) { const ms = ((Number(m[2] ?? 0) * 24 + Number(m[3])) * 60 + Number(m[4])) * 60000 + Number(m[5] ?? 0) * 1000; return new MDuration(m[1] ? -ms : ms); }
      }
      throw err('Impossibile convertire il valore nel tipo Duration.', 'DataFormat.Error', v);
    }
    default: return v;
  }
}
