// Aggiornamento incrementale: the windows of a refresh policy at a refresh date, and the partitions the Power BI
// service would create (archive periods + incremental periods). MiB-BI simulates a service refresh on the loaded
// table (store.simulateIncremental): rows of archived periods are kept, the incremental periods are read again.
import type { PolicyUnit, RefreshPolicy } from './types';
import { appendStep } from './pq/m/edit';

export const UNIT_LABEL: Record<PolicyUnit, [string, string]> = { day: ['giorno', 'giorni'], month: ['mese', 'mesi'], quarter: ['trimestre', 'trimestri'], year: ['anno', 'anni'] };

export function unitStart(d: Date, unit: PolicyUnit): Date {
  switch (unit) {
    case 'day': return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    case 'month': return new Date(d.getFullYear(), d.getMonth(), 1);
    case 'quarter': return new Date(d.getFullYear(), d.getMonth() - (d.getMonth() % 3), 1);
    case 'year': return new Date(d.getFullYear(), 0, 1);
  }
}
export function addUnits(d: Date, unit: PolicyUnit, k: number): Date {
  switch (unit) {
    case 'day': return new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
    case 'month': return new Date(d.getFullYear(), d.getMonth() + k, 1);
    case 'quarter': return new Date(d.getFullYear(), d.getMonth() + 3 * k, 1);
    case 'year': return new Date(d.getFullYear() + k, 0, 1);
  }
}
const p2 = (n: number) => String(n).padStart(2, '0');
/** Local timestamp text for SQL and RangeStart/RangeEnd ("YYYY-MM-DD HH:MM:SS"). */
export const ts = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;

/** [archiveStart, incStart) is kept from earlier refreshes, [incStart, end) is read again. With "solo periodi completi"
 *  the current period is left out (end = its start); otherwise it is included up to its end. */
export function policyWindow(p: RefreshPolicy, now: Date) {
  const cur = unitStart(now, p.incremental.unit);
  const end = p.completeOnly ? cur : addUnits(cur, p.incremental.unit, 1);
  const incStart = addUnits(cur, p.incremental.unit, -p.incremental.n);
  const archiveStart = addUnits(unitStart(now, p.archive.unit), p.archive.unit, -p.archive.n);
  return { archiveStart: archiveStart < incStart ? archiveStart : incStart, incStart, end };
}

export interface PartitionInfo { name: string; start: Date; end: Date; kind: 'archive' | 'incremental' | 'realtime' }

/** Partitions of the service (simplified: archive periods in the archive unit), incremental periods, and the
 *  DirectQuery partition of a hybrid table. */
export function partitions(p: RefreshPolicy, now: Date): PartitionInfo[] {
  const w = policyWindow(p, now);
  const out: PartitionInfo[] = [];
  const label = (d: Date, u: PolicyUnit) => (u === 'year' ? `${d.getFullYear()}` : u === 'quarter' ? `${d.getFullYear()}Q${Math.floor(d.getMonth() / 3) + 1}` : u === 'month' ? `${d.getFullYear()}${p2(d.getMonth() + 1)}` : `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`);
  for (let d = w.archiveStart; d < w.incStart; d = addUnits(d, p.archive.unit, 1)) {
    // An archive period that overlaps the incremental window ends where the window starts.
    const next = addUnits(d, p.archive.unit, 1);
    out.push({ name: label(d, p.archive.unit), start: d, end: next > w.incStart ? w.incStart : next, kind: 'archive' });
  }
  for (let d = w.incStart; d < w.end; d = addUnits(d, p.incremental.unit, 1)) out.push({ name: label(d, p.incremental.unit), start: d, end: addUnits(d, p.incremental.unit, 1), kind: 'incremental' });
  if (p.realTime) out.push({ name: 'DirectQuery', start: w.end, end: addUnits(w.end, p.incremental.unit, 1), kind: 'realtime' });
  return out;
}

/** M of the polling expression for "Rileva modifiche dei dati": the query (already filtered by RangeStart/RangeEnd)
 *  followed by the maximum of the column, null replaced like Power BI. */
export function pollingM(sourceM: string, column: string): string {
  const c = column.replace(/]/g, ']]');
  const withMax = appendStep(sourceM, 'MaxValue', (prev) => `List.Max(${prev}[${c}])`);
  return appendStep(withMax, 'accountForNull', () => 'if MaxValue = null then #datetime(1901, 1, 1, 0, 0, 0) else MaxValue');
}
