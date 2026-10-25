import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { recordPerf, useStore } from '../store';
import { useExtraFilters } from './filterContext';
import { buildVisualQuery, CF_WELL, modelExtras, type QueryItem } from '../query';
import type { Visual } from '../types';
import { interactionOf, scopedVisuals } from './interactions';
import { axesOf, CalcEngine, customTotals, fieldRefs, isCalc, levelKey, levelSets, levelsNeeded, levelVisual, same, stripCalcs, type CalcDef, type Level } from './visualCalc';
import { DaxError, parse, type Model } from '../dax';

export interface VisualData {
  loading: boolean;
  error?: string;
  empty: boolean;
  items: QueryItem[];
  /** Hidden items driving conditional formatting (CF_WELL), values in `rows`. */
  cfItems: QueryItem[];
  rows: Record<string, any>[];
  totals?: Record<string, any>[];
  colTotals?: Record<string, any>[];
  rowTotals?: Record<string, any>[];
  /** aliases of measures formatted as percentages in Power BI */
  percent: Set<string>;
  /** Visual queries paused and the visual's query changed since: shown data is not current. */
  stale?: boolean;
  /** Cross-highlight: rows of the same query with the other visual's selection applied (the base rows stay unfiltered). */
  highlight?: Record<string, any>[];
  /** Every item of the visual matrix, hidden fields included (visual calculations edit mode). */
  allItems: QueryItem[];
}

type Result = { items: QueryItem[]; rows: Record<string, any>[]; totals?: Record<string, any>[]; colTotals?: Record<string, any>[]; rowTotals?: Record<string, any>[] };

/**
 * Adds the visual calculations of `v` to a query result: one item per calculation at its place in the
 * wells, values computed on the visual matrix (and on its total rows). `run` queries the visual at
 * another level (fewer grouping fields) for COLLAPSE / EXPAND / LOOKUPWITHTOTALS.
 */
export async function withCalcs(v: Visual, base: Visual, d: Result, model: Model, run: (vis: Visual) => Promise<{ items: QueryItem[]; rows: Record<string, any>[] } | null>): Promise<Result> {
  const items: QueryItem[] = [];
  const defs: CalcDef[] = [];
  const pool = [...d.items];
  for (const [w, list] of Object.entries(v.fields)) {
    for (const f of list) {
      if (isCalc(f)) {
        const it: QueryItem = { alias: `vc${defs.length}`, field: f, well: w, measure: true, ...(f.format ? { fmt: true } : {}) };
        items.push(it);
        defs.push({ name: f.column, alias: it.alias, expression: f.calc ?? '' });
        continue;
      }
      const k = pool.findIndex((i) => i.well === w && same(i.field, f));
      if (k >= 0) items.push(...pool.splice(k, 1));
    }
  }
  items.push(...pool);
  const { rows: rd, cols: cd } = axesOf(v, d.items);
  const allR = rd.map((_x, i) => i), allC = cd.map((_x, i) => i);
  const copy = (rs?: Record<string, any>[]) => rs?.map((r) => ({ ...r }));
  const out: Result = { items, rows: copy(d.rows)!, totals: copy(d.totals), colTotals: copy(d.colTotals), rowTotals: copy(d.rowTotals) };
  const levels = new Map<string, Level>();
  const put = (rk: number[], ck: number[], rows?: Record<string, any>[]) => { if (rows?.length && !levels.has(levelKey(rk, ck))) levels.set(levelKey(rk, ck), { rk, ck, rows }); };
  put(allR, allC, out.rows);
  put([], [], out.totals);
  if (cd.length) put(allR, [], out.rowTotals);
  if (rd.length) put([], allC, out.colTotals);
  let nodes;
  try { nodes = defs.map((x) => parse(x.expression)); } catch (e) { throw new DaxError(`Calcolo visivo: ${(e as Error).message}`); }
  for (const [rk, ck] of levelSets(rd.length, cd.length, levelsNeeded(nodes))) {
    if (levels.has(levelKey(rk, ck))) continue;
    const r = await run(levelVisual(base, d.items, [...rk.map((i) => rd[i]), ...ck.map((i) => cd[i])]));
    if (!r) continue;
    const map = r.items.map((li) => [li.alias, d.items.find((b) => b.well === li.well && same(b.field, li.field))?.alias] as const).filter((x): x is readonly [string, string] => !!x[1]);
    put(rk, ck, r.rows.map((row) => Object.fromEntries(map.map(([la, ba]) => [ba, row[la]]))));
  }
  const eng = new CalcEngine(defs, fieldRefs(items), rd, cd, levels, model);
  for (const L of levels.values()) {
    for (const def of defs) {
      const f = items.find((i) => i.alias === def.alias)!.field.format;
      L.rows.forEach((row, i) => { row[def.alias] = eng.value(def.name, L, i); if (f) row[def.alias + '__f'] = f; });
    }
  }
  return out;
}

let pending = 0;
/** Visual queries still running (PDF export waits for 0). */
export const pendingQueries = () => pending;

/** Builds the SQL for a visual from its wells + all filters in scope, and runs it on DuckDB. */
export function useVisualData(v: Visual): VisualData {
  const tables = useStore((s) => s.tables);
  const report = useStore((s) => s.report);
  const pageId = useStore((s) => s.activePageId);
  const cross = useStore((s) => s.crossFilter);
  const dataVersion = useStore((s) => s.dataVersion);
  const extra = useExtraFilters();
  const viewAs = useStore((s) => s.viewAs);
  const paused = useStore((s) => s.paused);
  const pauseTick = useStore((s) => s.pauseTick);
  // Sospendi oggetti visivi: after the first load, queries wait for Aggiorna (pauseTick) or resume.
  const ran = useRef<{ tick: number } | null>(null);
  // The visual's own page (PDF export renders every page at once).
  const page = report.pages.find((p) => p.visuals.some((x) => x.id === v.id)) ?? report.pages.find((p) => p.id === pageId) ?? report.pages[0];

  // Modifica interazioni: the selection in another visual filters, highlights or leaves this visual alone.
  const mode = cross && cross.visualId !== v.id ? interactionOf(report, page, cross.visualId, v) : 'filter';
  // Visual calculations are computed on the query result, not by the query.
  const calcKey = JSON.stringify(Object.values(v.fields).flat().filter((f) => isCalc(f) || f.hidden || f.total));
  const base = useMemo(() => (calcKey !== '[]' ? stripCalcs(v) : v), [v, calcKey]);
  const [q, hq] = useMemo(() => {
    const build = (c: typeof cross) => buildVisualQuery(base, tables, report.relationships, [...report.reportFilters, ...page.filters, ...extra], scopedVisuals(page, v), c, report.measures, modelExtras(report, viewAs?.user));
    return [build(mode === 'filter' ? cross : null), mode === 'highlight' ? build(cross) : null];
  }, [base, tables, report.relationships, report.reportFilters, page.filters, page.visuals, page.interactions, cross, mode, report.measures, extra, report.dateTables, report.calcGroups, report.functions, report.calendars, viewAs, report.aggregations]);
  const hsql = hq && 'sql' in hq ? hq.sql : null;
  const key = (q && 'sql' in q ? [q.sql, q.totalsSql, q.colTotalsSql, q.rowTotalsSql].join('|') : JSON.stringify(q)) + '|' + (hsql ?? '') + '|' + calcKey;
  const [state, setState] = useState<Omit<VisualData, 'percent' | 'cfItems' | 'allItems'>>({ loading: false, empty: true, items: [], rows: [] });
  const percent = useMemo(() => new Set(state.items.filter((i) => (i.field.agg === 'measure'
    && report.measures.find((m) => m.name === i.field.column)?.formatString?.includes('%')) || (isCalc(i.field) && i.field.format?.includes('%'))).map((i) => i.alias)), [state.items, report.measures]);

  useEffect(() => {
    if (paused && ran.current && ran.current.tick === pauseTick) { setState((s0) => ({ ...s0, stale: true })); return; }
    ran.current = { tick: pauseTick };
    if (!q) { setState({ loading: false, empty: true, items: [], rows: [] }); return; }
    if ('error' in q) { setState({ loading: false, empty: false, error: q.error, items: [], rows: [] }); return; }
    let live = true;
    setState((s) => ({ ...s, loading: true }));
    pending++;
    const t0 = performance.now();
    Promise.all([
      api.queryAs(q.sql),
      q.totalsSql ? api.queryAs(q.totalsSql) : Promise.resolve(null),
      q.colTotalsSql ? api.queryAs(q.colTotalsSql) : Promise.resolve(null),
      q.rowTotalsSql ? api.queryAs(q.rowTotalsSql) : Promise.resolve(null),
      hsql ? api.queryAs(hsql) : Promise.resolve(null),
    ]).then(async ([res, tot, ctot, rtot, hl]) => {
      if (!live) return;
      let out: Result = { items: q.items, rows: res.rows, totals: tot?.rows, colTotals: ctot?.rows, rowTotals: rtot?.rows };
      if (calcKey !== '[]') {
        const st = useStore.getState();
        const pg = st.report.pages.find((p) => p.visuals.some((x) => x.id === v.id)) ?? page;
        out = await withCalcs(v, base, out, st.model(), async (vis) => {
          const lq = buildVisualQuery(vis, st.tables, st.report.relationships, [...st.report.reportFilters, ...pg.filters, ...extra], scopedVisuals(pg, v), mode === 'filter' ? cross : null, st.report.measures, modelExtras(st.report, st.viewAs?.user));
          return lq && 'sql' in lq ? { items: lq.items, rows: (await api.queryAs(lq.sql)).rows } : null;
        });
        if (!live) return;
      }
      out = { ...out, ...customTotals(v, out.items, out) };
      const t1 = performance.now();
      setState({ loading: false, empty: false, ...out, ...(hl ? { highlight: hl.rows } : {}) });
      // Rendering time: until the browser has painted the new data.
      requestAnimationFrame(() => setTimeout(() => recordPerf({ visualId: v.id, at: Date.now(), queryMs: t1 - t0, renderMs: performance.now() - t1, rows: res.rows.length, sql: q.sql, ...(storageOf(q) ? { storage: storageOf(q) } : {}) })));
    }).catch((e) => {
      if (live) recordPerf({ visualId: v.id, at: Date.now(), queryMs: performance.now() - t0, renderMs: 0, rows: 0, sql: q.sql, error: e.message });
      if (live) setState({ loading: false, empty: false, error: e.message, items: q.items, rows: [] });
    }).finally(() => { pending--; });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, dataVersion, paused, pauseTick]);

  const allItems = useMemo(() => state.items.filter((i) => i.well !== CF_WELL), [state.items]);
  const items = useMemo(() => allItems.filter((i) => !i.field.hidden), [allItems]);
  const cfItems = useMemo(() => state.items.filter((i) => i.well === CF_WELL), [state.items]);
  return { ...state, items, allItems, cfItems, percent };
}

/** Runs an ad-hoc query shaped like visual `v` (its wells), on `v`'s page with every filter in scope,
 *  plus `extra` filters. Used by visuals that need several queries (decomposition tree, key influencers, narrative). */
/** Analizzatore prestazioni: aggregation table used, or DirectQuery tables read by the query. */
function storageOf(q: { sql: string; aggTable?: string }): string | undefined {
  if (q.aggTable) return `Aggregazione: ${q.aggTable}`;
  const dq = useStore.getState().tables.filter((t) => t.storageMode === 'directQuery' && q.sql.includes('"' + t.name.replace(/"/g, '""') + '"'));
  return dq.length ? `DirectQuery: ${dq.map((t) => t.name).join(', ')}` : undefined;
}

export async function runVisualQuery(v: Visual, extra: import('../types').Filter[] = []): Promise<{ items: import('../query').QueryItem[]; rows: Record<string, any>[]; aggTable?: string }> {
  const s = useStore.getState();
  const page = s.report.pages.find((p) => p.visuals.some((x) => x.id === v.id)) ?? s.page();
  const c = s.crossFilter && s.crossFilter.visualId !== v.id && interactionOf(s.report, page, s.crossFilter.visualId, v) !== 'filter' ? null : s.crossFilter;
  const q = buildVisualQuery({ ...stripCalcs(v), filters: [...(v.filters ?? []), ...extra] }, s.tables, s.report.relationships,
    [...s.report.reportFilters, ...page.filters], scopedVisuals(page, v), c, s.report.measures, modelExtras(s.report, s.viewAs?.user));
  if (!q) return { items: [], rows: [] };
  if ('error' in q) throw new Error(q.error);
  const res = await api.queryAs(q.sql);
  return { items: q.items, rows: res.rows, ...(q.aggTable ? { aggTable: q.aggTable } : {}) };
}

/** The data of visual `v` with its visual calculations and totals (scripted tests, `window.__mibbiCalc`). */
export async function runVisualWithCalcs(v: Visual): Promise<Result> {
  const s = useStore.getState();
  const page = s.report.pages.find((p) => p.visuals.some((x) => x.id === v.id)) ?? s.page();
  const base = stripCalcs(v);
  const build = (vis: Visual) => buildVisualQuery(vis, s.tables, s.report.relationships, [...s.report.reportFilters, ...page.filters], scopedVisuals(page, v), null, s.report.measures, modelExtras(s.report, s.viewAs?.user));
  const q = build(base);
  if (!q) return { items: [], rows: [] };
  if ('error' in q) throw new Error(q.error);
  const opt = async (sql?: string) => (sql ? (await api.queryAs(sql)).rows : undefined);
  const d: Result = { items: q.items, rows: (await api.queryAs(q.sql)).rows, totals: await opt(q.totalsSql), colTotals: await opt(q.colTotalsSql), rowTotals: await opt(q.rowTotalsSql) };
  const out = await withCalcs(v, base, d, s.model(), async (vis) => { const lq = build(vis); return lq && 'sql' in lq ? { items: lq.items, rows: (await api.queryAs(lq.sql)).rows } : null; });
  return { ...out, ...customTotals(v, out.items, out) };
}
