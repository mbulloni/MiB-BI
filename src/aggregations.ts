// Gestisci aggregazioni (Power BI user-defined aggregations): an aggregation table answers queries on its detail
// table when every field and filter on the detail table maps to it (GroupBy columns; Sum/Min/Max/Count of detail
// columns) and the other tables in the query are reachable from the aggregation table through its own relationships.
// The visual is rewritten field by field onto the aggregation table; otherwise the detail table is queried.
import type { AggSummarization, AggTable, CrossFilter, FieldRef, Filter, Relationship, Visual } from './types';

export const AGG_LABEL: Record<AggSummarization, string> = {
  groupBy: 'Raggruppa per', sum: 'Somma', count: 'Conteggio', min: 'Minimo', max: 'Massimo', countRows: 'Conteggio righe tabella',
};

/** Tables a table reaches along many → one relationships (the filter direction from a fact to its dimensions). */
function reachable(table: string, rels: Relationship[]): Set<string> {
  const out = new Set([table]);
  const todo = [table];
  while (todo.length) {
    const t = todo.pop()!;
    for (const r of rels) if (r.active && r.fromTable === t && !out.has(r.toTable)) { out.add(r.toTable); todo.push(r.toTable); }
  }
  return out;
}

/** Rewritten field → the detail field it replaces (query items keep the original). */
export const aggOrigin = new WeakMap<FieldRef, FieldRef>();

const groupCol = (a: AggTable, column: string) => Object.entries(a.columns).find(([, m]) => m.summarization === 'groupBy' && m.column === column)?.[0];

/** A field of the visual on the aggregation table, or null when the aggregation cannot answer it. */
function mapField(a: AggTable, f: FieldRef): FieldRef | null {
  if (f.table !== a.detail) return f;
  const of = (s: AggSummarization) => Object.entries(a.columns).find(([, m]) => m.summarization === s && m.column === f.column)?.[0];
  let col: string | undefined, agg = f.agg;
  switch (f.agg) {
    case 'none': col = groupCol(a, f.column); break;
    // Distinct values of a GroupBy column are those of the detail column.
    case 'countd': col = groupCol(a, f.column); break;
    case 'sum': col = of('sum'); break;
    case 'min': col = of('min') ?? groupCol(a, f.column); break;
    case 'max': col = of('max') ?? groupCol(a, f.column); break;
    case 'count': col = of('count'); agg = 'sum'; break;
    default: return null;
  }
  if (!col) return null;
  const r: FieldRef = { ...f, table: a.table, column: col, agg };
  aggOrigin.set(r, f);
  return r;
}

const mapFilter = <T extends { table: string; column: string }>(a: AggTable, f: T): T | null => {
  if (f.table !== a.detail) return f;
  const col = groupCol(a, f.column);
  return col ? { ...f, table: a.table, column: col } : null;
};

export interface AggRewrite { v: Visual; filters: Filter[]; visuals: Visual[]; cross: CrossFilter | null; table: string }

/** First aggregation (highest precedence) that answers the visual, as the rewritten query inputs. */
export function rewriteForAggregations(aggs: AggTable[], tables: string[], rels: Relationship[], v: Visual, filters: Filter[], visuals: Visual[], cross: CrossFilter | null): AggRewrite | null {
  const fields = Object.values(v.fields).flat().filter((f) => f.agg !== 'visualCalc');
  if (fields.some((f) => f.agg === 'measure')) return null; // DAX measures read the detail table
  for (const a of [...aggs].sort((x, y) => (y.precedence ?? 0) - (x.precedence ?? 0))) {
    if (!tables.includes(a.table) || !tables.includes(a.detail)) continue;
    if (!fields.some((f) => f.table === a.detail)) continue;
    try {
      const need = (x: FieldRef | null) => { if (!x) throw 0; return x; };
      const nf = (x: Filter) => { if (!x.values.length) return x; const m = mapFilter(a, x); if (!m) throw 0; return m; };
      const out: Record<string, FieldRef[]> = {};
      for (const [w, list] of Object.entries(v.fields)) out[w] = list.map((f) => (f.agg === 'visualCalc' ? f : need(mapField(a, f))));
      const nv: Visual = { ...v, fields: out, ...(v.filters ? { filters: v.filters.map(nf) } : {}) };
      const nfilters = filters.map(nf);
      const nvisuals = visuals.map((s) => {
        if (s.id === v.id) return s;
        let r = s;
        const c = s.type === 'slicer' ? s.fields.category?.[0] : undefined;
        const active = !!(s.slicerValues?.length || s.slicerRange || s.slicerText?.trim() || s.slicerRelative);
        if (c && c.table === a.detail && active) r = { ...r, fields: { ...r.fields, category: [need(mapFilter(a, c)), ...r.fields.category.slice(1)] } };
        if (s.jsonFilters) for (const x of Object.values<any>(s.jsonFilters)) for (const f of x?.resolved ?? []) if (f.table === a.detail && f.values?.length) throw 0;
        return r;
      });
      const ncross = cross && cross.visualId !== v.id ? (mapFilter(a, cross) ?? (() => { throw 0; })()) : cross;
      // Every other table of the query must be reached from the aggregation table.
      const used = new Set([...Object.values(out).flat(), ...nfilters.filter((f) => f.values.length), ...(nv.filters ?? []).filter((f) => f.values.length)].map((f) => f.table).filter(Boolean));
      if (ncross && ncross.visualId !== v.id) used.add(ncross.table);
      for (const s of nvisuals) if (s.id !== v.id && s.type === 'slicer' && s.fields.category?.[0] && (s.slicerValues?.length || s.slicerRange || s.slicerText?.trim() || s.slicerRelative)) used.add(s.fields.category[0].table);
      if (used.has(a.detail)) continue;
      const reach = reachable(a.table, rels);
      if ([...used].some((t) => !reach.has(t))) continue;
      return { v: nv, filters: nfilters, visuals: nvisuals, cross: ncross, table: a.table };
    } catch { /* this aggregation does not cover the query */ }
  }
  return null;
}
