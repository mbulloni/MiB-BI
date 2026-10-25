import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api';
import type { CrossFilter, RelativeSlicer, Visual } from '../types';
import type { VisualData } from './useVisualData';
import { fieldLabel, fmtAuto, fmtFull, fmtPct, fmtWith, locale, PALETTE } from '../format';
import { fieldKind, NULL_KEY, relativePeriod, type QueryItem } from '../query';
import { useStore } from '../store';
import { cellFormat, cfInput, fieldKey, rangeOf, type Range } from './condfmt';
import { font, pt, sp, units } from './pbistyle';
import { THEME } from '../themes';

const cell = (v: unknown, measure: boolean) => (measure ? fmtFull(v) : v === null || v === undefined ? '' : String(v));
const toKey = (v: string | null) => (v === null ? NULL_KEY : v);

/** Table/matrix look from the Power BI objects (column/row headers, values with banding, totals, grid). */
function tableVars(v: Visual): CSSProperties {
  const g = (o: string, p: string) => sp(v, o, p);
  const vars: Record<string, string | undefined> = {
    // Theme text classes: values = label, column headers = header.
    '--t-size': (pt(g('values', 'fontSize') ?? g('grid', 'textSize')) ?? THEME.textSet.label.size)?.toString(),
    '--t-font': font(g('values', 'fontFamily')) ?? THEME.textSet.label.font,
    '--th-bg': g('columnHeaders', 'backColor'), '--th-fg': g('columnHeaders', 'fontColor') ?? THEME.textSet.header.color,
    '--th-size': (pt(g('columnHeaders', 'fontSize')) ?? THEME.textSet.header.size)?.toString(), '--th-font': font(g('columnHeaders', 'fontFamily')) ?? THEME.textSet.header.font,
    '--td-bg1': g('values', 'backColorPrimary') ?? g('values', 'backColor'), '--td-fg1': g('values', 'fontColorPrimary') ?? g('values', 'fontColor') ?? THEME.textSet.label.color,
    '--td-bg2': g('values', 'backColorSecondary') ?? g('values', 'backColorPrimary') ?? g('values', 'backColor'),
    '--td-fg2': g('values', 'fontColorSecondary') ?? g('values', 'fontColorPrimary') ?? g('values', 'fontColor') ?? THEME.textSet.label.color,
    '--rh-bg': g('rowHeaders', 'backColor'), '--rh-fg': g('rowHeaders', 'fontColor'),
    '--tot-bg': g('total', 'backColor') ?? g('subTotals', 'backColor'), '--tot-fg': g('total', 'fontColor') ?? g('subTotals', 'fontColor'),
    '--td-pad': typeof g('grid', 'rowPadding') === 'number' ? g('grid', 'rowPadding') + 'px' : undefined,
    '--grid-h': g('grid', 'gridHorizontal') ? `${g('grid', 'gridHorizontalWeight') ?? 1}px solid ${g('grid', 'gridHorizontalColor') ?? '#E1DFDD'}` : undefined,
    '--grid-v': g('grid', 'gridVertical') ? `${g('grid', 'gridVerticalWeight') ?? 1}px solid ${g('grid', 'gridVerticalColor') ?? '#E1DFDD'}` : undefined,
  };
  for (const k of ['--t-size', '--th-size']) if (vars[k]) vars[k] += 'px';
  return Object.fromEntries(Object.entries(vars).filter(([, x]) => x !== undefined)) as CSSProperties;
}

/** Column of the row holding the value that drives `it`'s formatting (itself, or its "In base al campo" field). */
function driverAlias(v: Visual, it: QueryItem, cfItems: QueryItem[]): string {
  const input = v.format.cf?.[fieldKey(it.field)]?.input;
  if (!input) return it.alias;
  const k = fieldKey(cfInput(input));
  return cfItems.find((c) => fieldKey(c.field) === k)?.alias ?? it.alias;
}

/** Cell with the visual's conditional formatting for that field (`src` = the row the cell comes from). */
function decorated(v: Visual, it: QueryItem, ranges: Map<string, Range | null>, src: Record<string, any>, cfItems: QueryItem[], text: string, key: string, bold = false) {
  const { style, icon } = cellFormat(v.format.cf?.[fieldKey(it.field)], ranges.get(it.alias) ?? null, src[driverAlias(v, it, cfItems)]);
  return (
    <td key={key} className={it.measure ? 'num' : ''} style={{ ...(bold ? { fontWeight: 600 } : {}), ...style }}>
      {icon && <span style={{ color: icon.color, marginRight: 4, fontSize: 10 }}>{icon.ch}</span>}{text}
    </td>
  );
}
const rangesFor = (v: Visual, items: QueryItem[], rows: Record<string, any>[], cfItems: QueryItem[]) =>
  new Map(items.filter((i) => v.format.cf?.[fieldKey(i.field)]).map((i) => { const a = driverAlias(v, i, cfItems); return [i.alias, rangeOf(rows.map((r) => r[a]))]; }));

/** Number with the visual's display units/precision (Power BI labels), else MiB-BI's automatic format. */
export function fmtStyled(data: VisualData, alias: string, x: unknown, unit: unknown, precision: unknown, row?: Record<string, any>): string {
  if (typeof x !== 'number') return x === null || x === undefined ? '(Vuoto)' : String(x);
  const dyn = dynFmt(row, alias);
  if (dyn !== undefined) return fmtWith(x, dyn);
  if (data.percent.has(alias)) return fmtPct(x);
  return units(x, unit, precision) ?? (typeof precision === 'number' ? x.toLocaleString(locale(), { minimumFractionDigits: precision, maximumFractionDigits: precision }) : fmtAuto(x));
}

/** Format string a calculation item chose for this cell (column `<alias>__f`), if any. */
const dynFmt = (row: Record<string, any> | undefined, alias: string): string | undefined => {
  const f = row?.[alias + '__f'];
  return typeof f === 'string' && f.trim() ? f : undefined;
};
/** Measure cell text: dynamic format string, else percent / full number. */
const measureText = (data: VisualData, alias: string, row: Record<string, any> | undefined, full = true) => {
  const x = row?.[alias];
  const dyn = dynFmt(row, alias);
  if (dyn !== undefined && typeof x === 'number') return fmtWith(x, dyn);
  return data.percent.has(alias) ? fmtPct(x) : full ? fmtFull(x) : fmtAuto(x);
};

/** Columns with data category "URL immagine" / "URL Web": image or link instead of text (like Power BI). */
function useRichCells(items: QueryItem[]) {
  const tables = useStore((s) => s.tables);
  const kind = new Map(items.filter((i) => !i.measure).map((i) => [i.alias, tables.find((t) => t.name === i.field.table)?.dataCategory?.[i.field.column]]));
  return (it: QueryItem, text: string, big = false): ReactNode => {
    const k = kind.get(it.alias);
    if (!text || !/^(https?:|data:image\/)/i.test(text)) return text;
    if (k === 'ImageUrl') return <img src={text} alt="" style={big ? { maxHeight: '100%', maxWidth: '100%', objectFit: 'contain' } : { maxHeight: 40, maxWidth: 120, verticalAlign: 'middle' }} />;
    if (k === 'WebUrl') return <a href={text} onClick={(e) => { e.preventDefault(); e.stopPropagation(); api.openExternal(text).catch(() => {}); }}>{text}</a>;
    return text;
  };
}

export function CardVisual({ v, data }: { v: Visual; data: VisualData }) {
  const m = data.items[0];
  const rich = useRichCells(data.items);
  const val = m ? data.rows[0]?.[m.alias] : undefined;
  const showCat = sp(v, 'categoryLabels', 'show') !== false;
  return (
    <div className="card-v">
      <div className="val" style={{ color: sp(v, 'labels', 'color') ?? THEME.textSet.callout.color, fontSize: pt(sp(v, 'labels', 'fontSize')) ?? THEME.textSet.callout.size, fontFamily: font(sp(v, 'labels', 'fontFamily')) ?? THEME.textSet.callout.font, fontWeight: THEME.textSet.callout.weight }}>
        {m ? rich(m, fmtStyled(data, m.alias, val, sp(v, 'labels', 'labelDisplayUnits'), sp(v, 'labels', 'labelPrecision'), data.rows[0]), true) : ''}
      </div>
      {m && showCat && <div className="cap" style={{ color: sp(v, 'categoryLabels', 'color') ?? THEME.textSet.label.color, fontSize: pt(sp(v, 'categoryLabels', 'fontSize')) ?? THEME.textSet.label.size, fontFamily: font(sp(v, 'categoryLabels', 'fontFamily')) ?? THEME.textSet.label.font }}>{fieldLabel(m.field)}</div>}
    </div>
  );
}

const fmtItem = (data: VisualData, it: QueryItem, x: unknown) =>
  typeof x === 'number' ? (data.percent.has(it.alias) ? fmtPct(x) : fmtAuto(x)) : x === null || x === undefined ? '(Vuoto)' : String(x);

/** Multi-row card: one block per row; text fields as heading, numbers as value + caption. */
export function MultiRowCardVisual({ v, data, cross, onSelect }: { v: Visual; data: VisualData; cross: CrossFilter | null; onSelect: (c: string | null) => void }) {
  const dims = data.items.filter((i) => !i.measure);
  const vals = data.items.filter((i) => i.measure);
  const first = dims[0];
  const selected = cross?.visualId === v.id ? cross.value : undefined;
  const bar = sp(v, 'card', 'barShow') !== false;
  const barColor = sp(v, 'card', 'barColor');
  const ts = (obj: string, k: 'callout' | 'label' | 'header') => ({ color: sp(v, obj, 'color') ?? THEME.textSet[k].color, fontSize: pt(sp(v, obj, 'fontSize')) ?? THEME.textSet[k].size, fontFamily: font(sp(v, obj, 'fontFamily')) ?? THEME.textSet[k].font });
  const valStyle = ts('dataLabels', 'callout'), capStyle = ts('categoryLabels', 'label'), headStyle = ts('cardTitle', 'header');
  const showCap = sp(v, 'categoryLabels', 'show') !== false;
  const rich = useRichCells(data.items);
  return (
    <div className="mrc">
      {data.rows.map((r, k) => (
        <div key={k} className={'mrc-row' + (selected !== undefined && first && selected !== toKey(r[first.alias]) ? ' dim' : '')} style={{ borderLeftColor: bar ? barColor : 'transparent' }} onClick={() => first && onSelect(r[first.alias])}>
          {dims.length > 0 && <div className="mrc-head" style={headStyle}>{dims.map((d, i) => <span key={d.alias}>{i ? ' · ' : ''}{rich(d, fmtItem(data, d, r[d.alias]))}</span>)}</div>}
          <div className="mrc-vals">{vals.map((m) => (
            <div key={m.alias}><div className="val" style={valStyle}>{fmtStyled(data, m.alias, r[m.alias], sp(v, 'dataLabels', 'labelDisplayUnits'), sp(v, 'dataLabels', 'labelPrecision'), r)}</div>{showCap && <div className="cap" style={capStyle}>{fieldLabel(m.field)}</div>}</div>
          ))}</div>
        </div>
      ))}
    </div>
  );
}

/** KPI: indicator (last point of the trend axis), goal and distance, trend area colored by status. */
export function KpiVisual({ data }: { data: VisualData }) {
  const val = data.items.find((i) => i.well === 'values');
  const trend = data.items.find((i) => i.well === 'trend');
  const goal = data.items.find((i) => i.well === 'target');
  const rows = data.rows.filter((r) => !val || r[val.alias] !== null);
  const last = rows[rows.length - 1];
  const x = val && last ? Number(last[val.alias]) : null;
  const g = goal && last && last[goal.alias] !== null ? Number(last[goal.alias]) : null;
  const ok = x === null || g === null || x >= g;
  const color = g === null ? PALETTE[0] : ok ? THEME.good : THEME.bad;
  const pts = trend && val ? rows.map((r) => Number(r[val.alias])) : [];
  let path = '';
  if (pts.length > 1) {
    const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
    const xy = pts.map((p, i) => `${(i / (pts.length - 1)) * 100},${40 - ((p - lo) / span) * 36}`);
    path = `M0,40 L${xy.join(' L')} L100,40 Z`;
  }
  const dist = x !== null && g ? ((x - g) / Math.abs(g)) * 100 : null;
  return (
    <div className="kpi-v">
      {path && <svg className="kpi-trend" viewBox="0 0 100 40" preserveAspectRatio="none"><path d={path} fill={color} opacity={0.25} /></svg>}
      <div className="val" style={{ color: g === null ? undefined : color }}>{x === null ? '(Vuoto)' : val && fmtItem(data, val, x)}{g !== null && <span className="kpi-mark">{ok ? ' ✓' : ' !'}</span>}</div>
      {g !== null && goal && <div className="cap">Obiettivo: {fmtItem(data, goal, g)}{dist !== null && <span style={{ color }}> ({dist >= 0 ? '+' : ''}{dist.toLocaleString(locale(), { maximumFractionDigits: 2 })}%)</span>}</div>}
    </div>
  );
}

export function TableVisual({ v, data, cross, onSelect }: { v: Visual; data: VisualData; cross: CrossFilter | null; onSelect: (c: string | null) => void }) {
  const updateFormat = useStore((s) => s.updateFormat);
  const rich = useRichCells(data.items);
  const firstDim = data.items.find((i) => !i.measure);
  const selected = cross?.visualId === v.id ? cross.value : undefined;
  const sortClick = (idx: number) => {
    const same = v.format.sortBy === idx;
    updateFormat(v.id, { sortBy: idx, sortDir: same && v.format.sortDir === 'desc' ? 'asc' : 'desc' });
  };
  const tot = data.totals?.[0];
  const ranges = rangesFor(v, data.items, data.rows, data.cfItems);
  return (
    <div className="tbl" style={tableVars(v)}>
      <table>
        <thead><tr>{data.items.map((it, i) => (
          <th key={it.alias} className={it.measure ? 'num' : ''} onClick={() => sortClick(i)}>
            {fieldLabel(it.field)}{v.format.sortBy === i ? (v.format.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}
          </th>
        ))}</tr></thead>
        <tbody>{data.rows.map((r, k) => {
          const key = firstDim ? toKey(r[firstDim.alias]) : '';
          return (
            <tr key={k} className={selected !== undefined && selected === key ? 'sel' : ''} onClick={() => firstDim && onSelect(r[firstDim.alias])}>
              {data.items.map((it) => {
                const text = it.measure && (dynFmt(r, it.alias) || data.percent.has(it.alias)) ? measureText(data, it.alias, r) : cell(r[it.alias], it.measure);
                return v.format.cf?.[fieldKey(it.field)] ? decorated(v, it, ranges, r, data.cfItems, text, it.alias) : <td key={it.alias} className={it.measure ? 'num' : ''}>{it.measure ? text : rich(it, text)}</td>;
              })}
            </tr>
          );
        })}</tbody>
        {tot && <tfoot><tr>{data.items.map((it, i) => (
          <td key={it.alias} className={it.measure ? 'num' : ''}>{it.measure ? measureText(data, it.alias, tot) : i === 0 ? 'Totale' : ''}</td>
        ))}</tr></tfoot>}
      </table>
    </div>
  );
}

export function MatrixVisual({ v, data, cross, onSelect }: { v: Visual; data: VisualData; cross: CrossFilter | null; onSelect: (c: string | null) => void }) {
  const rows = data.items.filter((i) => i.well === 'rows');
  const col = data.items.find((i) => i.well === 'columns');
  const vals = data.items.filter((i) => i.well === 'values');
  const selected = cross?.visualId === v.id ? cross.value : undefined;

  if (!col) return <TableVisual v={v} data={{ ...data, items: [...rows, ...vals] }} cross={cross} onSelect={onSelect} />;

  const colValues: (string | null)[] = [];
  const rowKeys: string[] = [];
  const rowHead = new Map<string, Record<string, any>>();
  const cellMap = new Map<string, Record<string, any>>();
  for (const r of data.rows) {
    const rk = JSON.stringify(rows.map((d) => r[d.alias]));
    if (!rowHead.has(rk)) { rowHead.set(rk, r); rowKeys.push(rk); }
    if (!colValues.includes(r[col.alias])) colValues.push(r[col.alias]);
    cellMap.set(rk + '\u0001' + r[col.alias], r);
  }
  // Column order: the column-totals query is sorted by the engine (incl. "sort by column").
  const order = (data.colTotals ?? []).map((r) => r[col.alias]);
  colValues.sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return ia >= 0 && ib >= 0 ? ia - ib : (a ?? '').localeCompare(b ?? '', locale(), { numeric: true });
  });
  const rowTot = new Map((data.rowTotals ?? []).map((r) => [JSON.stringify(rows.map((d) => r[d.alias])), r]));
  const colTot = new Map((data.colTotals ?? []).map((r) => [r[col.alias], r]));
  const grand = data.totals?.[0];
  const span = Math.max(1, vals.length);
  const ranges = rangesFor(v, vals, data.rows, data.cfItems);
  // Conditional formatting applies to the value cells, not to totals (Power BI default).
  const valCells = (src: Record<string, any> | undefined, k: string, bold = false) =>
    (vals.length ? vals : [null]).map((m, i) => {
      const text = m && src ? measureText(data, m.alias, src) : '';
      return m && src && !bold && k !== 'g' && !k.startsWith('ct') ? decorated(v, m, ranges, src, data.cfItems, text, k + i)
        : <td key={k + i} className="num" style={bold ? { fontWeight: 600 } : undefined}>{text}</td>;
    });

  return (
    <div className="tbl" style={tableVars(v)}>
      <table>
        <thead>
          <tr>
            {rows.map((d) => <th key={d.alias} rowSpan={vals.length > 1 ? 2 : 1}>{d.field.column}</th>)}
            {colValues.map((c) => <th key={String(c)} colSpan={span} className="num">{c ?? '(Vuoto)'}</th>)}
            <th colSpan={span} className="num">Totale</th>
          </tr>
          {vals.length > 1 && <tr>{[...colValues, 'tot'].flatMap((c) => vals.map((m) => <th key={String(c) + m.alias} className="num" style={{ top: 22 }}>{fieldLabel(m.field)}</th>))}</tr>}
        </thead>
        <tbody>{rowKeys.map((rk) => {
          const h = rowHead.get(rk)!;
          const key = rows[0] ? toKey(h[rows[0].alias]) : '';
          return (
            <tr key={rk} className={selected !== undefined && selected === key ? 'sel' : ''} onClick={() => rows[0] && onSelect(h[rows[0].alias])}>
              {rows.map((d) => <td key={d.alias} className="rowhdr">{h[d.alias] ?? '(Vuoto)'}</td>)}
              {colValues.flatMap((c) => valCells(cellMap.get(rk + '\u0001' + c), String(c)))}
              {valCells(rowTot.get(rk), 'tot', true)}
            </tr>
          );
        })}</tbody>
        <tfoot><tr>
          {rows.map((d, i) => <td key={d.alias}>{i === 0 ? 'Totale' : ''}</td>)}
          {colValues.flatMap((c) => valCells(colTot.get(c), 'ct' + c))}
          {valCells(grand, 'g')}
        </tr></tfoot>
      </table>
    </div>
  );
}

const REL_UNITS: [RelativeSlicer['unit'], string][] = [['minutes', 'Minuti'], ['hours', 'Ore'], ['days', 'Giorni'], ['weeks', 'Settimane'], ['months', 'Mesi'], ['years', 'Anni']];

/** Bound of a range slicer as typed in an <input>: dates keep yyyy-mm-dd, numbers stay as text. */
const dayOf = (x: string | null | undefined) => (x ? x.slice(0, 10) : '');

/** Tra / Prima di / Dopo on numbers or dates: inputs + a two-thumb slider over the data range. */
function RangeSlicer({ v, values, kind }: { v: Visual; values: (string | null)[]; kind: 'number' | 'date' | 'datetime' }) {
  const updateVisual = useStore((s) => s.updateVisual);
  const style = v.format.slicerStyle;
  const num = kind === 'number';
  const pts = values.filter((x): x is string => x !== null).map((x) => (num ? Number(x) : Date.parse(dayOf(x) + 'T00:00:00'))).filter(Number.isFinite).sort((a, b) => a - b);
  if (!pts.length) return null;
  const lo = pts[0], hi = pts[pts.length - 1];
  const toStr = (n: number) => (num ? String(n) : dayOf(new Date(n - new Date(n).getTimezoneOffset() * 6e4).toISOString()));
  const toNum = (x?: string) => (x ? (num ? Number(x) : Date.parse(dayOf(x) + 'T00:00:00')) : NaN);
  const r = v.slicerRange ?? {};
  const a = Number.isFinite(toNum(r.min)) ? toNum(r.min) : lo, b = Number.isFinite(toNum(r.max)) ? toNum(r.max) : hi;
  const set = (patch: { min?: string; max?: string }) => {
    const next = { ...r, ...patch };
    for (const k of ['min', 'max'] as const) if (!next[k]) delete next[k];
    updateVisual(v.id, { slicerRange: Object.keys(next).length ? next : undefined });
  };
  const step = num ? (Number.isInteger(lo) && Number.isInteger(hi) ? 1 : (hi - lo) / 100 || 1) : 864e5;
  const showMin = style !== 'before', showMax = style !== 'after';
  const input = (k: 'min' | 'max', val: number) => (
    <input type={num ? 'number' : 'date'} value={r[k] ? (num ? r[k] : dayOf(r[k])) : num ? String(val) : toStr(val)} step={num ? 'any' : undefined}
      onMouseDown={(e) => e.stopPropagation()} onChange={(e) => set({ [k]: e.target.value })} />
  );
  return (
    <div className="slicer-v range-v">
      <div className="range-inputs">{showMin && input('min', a)}{showMin && showMax && <span>–</span>}{showMax && input('max', b)}</div>
      <div className="range-track" onMouseDown={(e) => e.stopPropagation()}>
        {showMin && <input type="range" min={lo} max={hi} step={step} value={a} onChange={(e) => set({ min: toStr(Math.min(+e.target.value, showMax ? b : hi)) })} />}
        {showMax && <input type="range" min={lo} max={hi} step={step} value={b} onChange={(e) => set({ max: toStr(Math.max(+e.target.value, showMin ? a : lo)) })} />}
      </div>
    </div>
  );
}

/** Data / Ora relativa: Ultimi | Questo | Prossimi, N, unità (calendario). */
function RelativeSlicerView({ v }: { v: Visual }) {
  const updateVisual = useStore((s) => s.updateVisual);
  const time = v.format.slicerStyle === 'relativeTime';
  const r: RelativeSlicer | undefined = v.slicerRelative;
  const cur = r ?? { anchor: 'last', n: 1, unit: time ? 'hours' : 'days' };
  const set = (patch: Partial<RelativeSlicer>) => updateVisual(v.id, { slicerRelative: { ...cur, ...patch } as RelativeSlicer });
  const units = REL_UNITS.filter(([u]) => (time ? u === 'minutes' || u === 'hours' : u !== 'minutes' && u !== 'hours'));
  const p = r ? relativePeriod(r) : null;
  const fmt = (d: Date) => d.toLocaleString(locale(), time ? { dateStyle: 'short', timeStyle: 'short' } : { dateStyle: 'short' });
  return (
    <div className="slicer-v rel-v" onMouseDown={(e) => e.stopPropagation()}>
      <div className="rel-row">
        <select value={r ? cur.anchor : ''} onChange={(e) => (e.target.value ? set({ anchor: e.target.value as RelativeSlicer['anchor'] }) : updateVisual(v.id, { slicerRelative: undefined }))}>
          {!r && <option value="">(Nessun filtro)</option>}
          <option value="last">Ultimi</option><option value="this">Questo</option><option value="next">Prossimi</option>
        </select>
        {cur.anchor !== 'this' && <input type="number" min={1} value={cur.n} onChange={(e) => set({ n: Math.max(1, +e.target.value || 1) })} />}
        <select value={cur.unit + (cur.calendar ? ':c' : '')} onChange={(e) => { const [u, c] = e.target.value.split(':'); set({ unit: u as RelativeSlicer['unit'], calendar: c === 'c' || undefined }); }}>
          {units.flatMap(([u, l]) => [<option key={u} value={u}>{l}</option>, ...(u !== 'days' && u !== 'minutes' && u !== 'hours' && cur.anchor !== 'this' ? [<option key={u + 'c'} value={u + ':c'}>{l} (calendario)</option>] : [])])}
        </select>
        {r && <button title="Cancella selezioni" onClick={() => updateVisual(v.id, { slicerRelative: undefined })}>✕</button>}
      </div>
      {p && <div className="rel-period">{fmt(p.start)} – {fmt(time ? p.end : new Date(p.end.getTime() - 1))}</div>}
    </div>
  );
}

/** Filtro dei dati di testo: rows whose value contains the typed text (applied on Invio or after a pause). */
function TextSlicer({ v }: { v: Visual }) {
  const updateVisual = useStore((s) => s.updateVisual);
  const [draft, setDraft] = useState(v.slicerText ?? '');
  useEffect(() => setDraft(v.slicerText ?? ''), [v.slicerText]);
  useEffect(() => {
    if (draft === (v.slicerText ?? '')) return;
    const t = setTimeout(() => updateVisual(v.id, { slicerText: draft || undefined }), 600);
    return () => clearTimeout(t);
  }, [draft]);
  return (
    <div className="slicer-v text-v" onMouseDown={(e) => e.stopPropagation()}>
      <div className="text-box">
        <input type="text" value={draft} placeholder="Digitare il testo da cercare" onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') updateVisual(v.id, { slicerText: draft || undefined }); }} />
        {draft && <button title="Cancella" onClick={() => { setDraft(''); updateVisual(v.id, { slicerText: undefined }); }}>✕</button>}
      </div>
    </div>
  );
}

export function SlicerVisual({ v, data }: { v: Visual; data: VisualData }) {
  const setSlicer = useStore((s) => s.setSlicer);
  const tables = useStore((s) => s.tables);
  const [search, setSearch] = useState('');
  const it: QueryItem | undefined = data.items[0];
  const sel = new Set(v.pendingSlicer ?? v.slicerValues ?? []);
  const all = it ? data.rows.map((r) => r[it.alias] as string | null) : [];
  const q = search.trim().toLocaleLowerCase();
  const values = q ? all.filter((x) => (x ?? '(Vuoto)').toLocaleLowerCase().includes(q)) : all;
  const set = (vals: string[]) => setSlicer(v.id, vals);
  const single = !!v.format.slicerSingle;
  const toggle = (k: string, multi: boolean) => {
    if (single) set(sel.size === 1 && sel.has(k) ? [] : [k]);
    else if (multi || v.format.slicerStyle === 'tile' && v.format.slicerMulti) set(sel.has(k) ? [...sel].filter((x) => x !== k) : [...sel, k]);
    else set(sel.size === 1 && sel.has(k) ? [] : [k]);
  };
  if (!it) return null;
  const style = v.format.slicerStyle;
  const kind = fieldKind(it.field, tables);
  if (style === 'text') return <TextSlicer v={v} />;
  if (style === 'relativeDate' || style === 'relativeTime') return <RelativeSlicerView v={v} />;
  if ((style === 'between' || style === 'before' || style === 'after') && kind !== 'text') return <RangeSlicer v={v} values={all} kind={kind} />;
  if (style === 'slider') {
    // Single value on a numeric range (what-if parameters).
    const nums = all.filter((x): x is string => x !== null).map((x) => ({ x, n: Number(x) })).filter((x) => Number.isFinite(x.n)).sort((a, b) => a.n - b.n);
    const cur = sel.size === 1 ? nums.findIndex((x) => x.x === [...sel][0]) : -1;
    if (!nums.length) return null;
    return (
      <div className="slicer-v slider-v">
        <div className="slider-val">{cur >= 0 ? nums[cur].n.toLocaleString(locale()) : '(Tutti)'}</div>
        <input type="range" min={0} max={nums.length - 1} step={1} value={cur >= 0 ? cur : 0}
          onMouseDown={(e) => e.stopPropagation()} onChange={(e) => set([nums[+e.target.value].x])} />
        <div className="slider-ends"><span>{nums[0].n.toLocaleString(locale())}</span><span>{nums[nums.length - 1].n.toLocaleString(locale())}</span></div>
      </div>
    );
  }
  const searchBox = v.format.slicerSearch ? <input className="slicer-search" type="search" placeholder="Cerca" value={search} onChange={(e) => setSearch(e.target.value)} onMouseDown={(e) => e.stopPropagation()} /> : null;
  if (style === 'dropdown') {
    return (
      <div className="slicer-v">
        {searchBox}
        <select value={sel.size === 1 ? [...sel][0] : ''} onChange={(e) => set(e.target.value ? [e.target.value] : [])}>
          <option value="">Tutti</option>
          {values.map((x) => <option key={toKey(x)} value={toKey(x)}>{x ?? '(Vuoto)'}</option>)}
        </select>
      </div>
    );
  }
  if (style === 'tile') {
    // Riquadro / Filtro dei dati pulsante: one button per value, wrapping.
    return (
      <div className="slicer-v tile-v">
        {searchBox}
        <div className="tiles">
          {!single && v.format.slicerSelectAll !== false && <button className={sel.size === 0 ? 'on' : ''} onClick={() => set([])}>Seleziona tutto</button>}
          {values.map((x) => {
            const k = toKey(x);
            return <button key={k} className={sel.has(k) ? 'on' : ''} onClick={(e) => toggle(k, e.ctrlKey || e.metaKey)}>{x ?? '(Vuoto)'}</button>;
          })}
        </div>
      </div>
    );
  }
  return (
    <div className="slicer-v">
      {searchBox}
      {!single && v.format.slicerSelectAll !== false && <label><input type="checkbox" checked={sel.size === 0} onChange={() => set([])} />Seleziona tutto</label>}
      {values.map((x) => {
        const k = toKey(x);
        return (
          <label key={k} onClick={(e) => { e.preventDefault(); toggle(k, e.ctrlKey || e.metaKey); }}>
            <input type={single ? 'radio' : 'checkbox'} readOnly checked={sel.has(k)} />{x ?? '(Vuoto)'}
          </label>
        );
      })}
    </div>
  );
}

type Run = { value?: string; url?: string; textStyle?: Record<string, string> };
type Para = { textRuns?: Run[]; horizontalTextAlignment?: string };
const paraText = (ps: Para[]) => ps.map((p) => (p.textRuns ?? []).map((r) => r.value ?? '').join('')).join('\n');

/** Text box as formatted in Power BI (runs with size/color/weight/font, paragraph alignment). */
function RichText({ paras }: { paras: Para[] }) {
  return <>{paras.map((p, i) => (
    <div key={i} style={{ textAlign: (p.horizontalTextAlignment as CSSProperties['textAlign']) ?? undefined, minHeight: '1.2em', whiteSpace: 'pre-wrap' }}>
      {(p.textRuns ?? []).map((r, k) => {
        const t = r.textStyle ?? {};
        const size = /^([\d.]+)pt$/.exec(t.fontSize ?? '');
        const style: CSSProperties = {
          fontSize: size ? `${(+size[1] * 4) / 3}px` : t.fontSize, color: t.color, fontWeight: t.fontWeight as CSSProperties['fontWeight'],
          fontStyle: t.fontStyle as CSSProperties['fontStyle'], textDecoration: t.textDecoration, fontFamily: font(t.fontFamily),
        };
        return r.url ? <a key={k} href={r.url} style={style} onClick={(e) => { e.preventDefault(); api.openExternal(r.url!); }}>{r.value}</a> : <span key={k} style={style}>{r.value}</span>;
      })}
    </div>
  ))}</>;
}

export function TextboxVisual({ v, selected }: { v: Visual; selected: boolean }) {
  const updateVisual = useStore((s) => s.updateVisual);
  const ref = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);
  // Imported formatting is shown until the text is edited in MiB-BI (then it becomes plain text).
  const paras = v.style?.objects?.general?.find((e) => !e.selector)?.properties?.paragraphs as Para[] | undefined;
  const rich = Array.isArray(paras) && paraText(paras) === (v.text ?? '') ? paras : undefined;
  useEffect(() => { if (ref.current && !editing) ref.current.innerText = v.text ?? ''; }, [v.text, editing, rich]);
  useEffect(() => { if (!selected) setEditing(false); }, [selected]);
  if (rich && !editing) {
    return <div className="textbox-v" style={{ inset: 6 }} onDoubleClick={() => { setEditing(true); setTimeout(() => { if (ref.current) { ref.current.innerText = v.text ?? ''; ref.current.focus(); } }); }}><RichText paras={rich} /></div>;
  }
  return (
    <div
      ref={ref}
      className="textbox-v"
      style={{ inset: 6 }}
      contentEditable={editing}
      suppressContentEditableWarning
      onDoubleClick={() => { setEditing(true); setTimeout(() => ref.current?.focus()); }}
      onBlur={() => { setEditing(false); const t = ref.current?.innerText ?? ''; if (t !== (v.text ?? '')) updateVisual(v.id, { text: t }); }}
    />
  );
}
