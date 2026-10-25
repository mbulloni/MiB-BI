import { useEffect, useRef } from 'react';
import * as echarts from 'echarts';
import type { CrossFilter, Visual } from '../types';
import type { VisualData } from './useVisualData';
import { fieldLabel, fmtAuto, fmtFull, fmtPct, PALETTE, locale } from '../format';
import { NULL_KEY, type QueryItem } from '../query';
import { useStore } from '../store';
import { cfInput, fieldKey, rangeOf, ruleValue, scaleColor } from './condfmt';
import { font, pointColors, pt, queryRef, sp, units } from './pbistyle';
import { applyAnalytics } from './analytics';
import { THEME } from '../themes';
import { tr } from '../i18n';

/** ECharts axis label/title/grid settings from the visual's categoryAxis/valueAxis objects. */
function axisLook(v: Visual, obj: 'categoryAxis' | 'valueAxis') {
  const col = sp(v, obj, 'labelColor'), size = pt(sp(v, obj, 'fontSize')), fam = font(sp(v, obj, 'fontFamily'));
  return {
    show: sp(v, obj, 'show') !== false,
    label: { ...(col ? { color: col } : {}), ...(size ? { fontSize: size } : {}), ...(fam ? { fontFamily: fam } : {}) },
    title: sp(v, obj, 'showAxisTitle') !== false,
    titleStyle: { ...(sp(v, obj, 'titleColor') ? { color: sp(v, obj, 'titleColor') } : {}), ...(pt(sp(v, obj, 'titleFontSize')) ? { fontSize: pt(sp(v, obj, 'titleFontSize')) } : {}) },
    grid: sp(v, obj, 'gridlineShow'),
    gridColor: sp(v, obj, 'gridlineColor') as string | undefined,
    units: sp(v, obj, 'labelDisplayUnits'),
    precision: sp(v, obj, 'labelPrecision'),
  };
}

/** Legend placement and text from the legend object (Top, TopCenter, Bottom, Left, Right, …). */
function legendLook(v: Visual, fallback: string) {
  const pos = String(sp(v, 'legend', 'position') ?? fallback).toLowerCase();
  const side = pos.startsWith('bottom') ? 'bottom' : pos.startsWith('left') ? 'left' : pos.startsWith('right') ? 'right' : 'top';
  const center = pos.endsWith('center');
  const col = sp(v, 'legend', 'labelColor'), size = pt(sp(v, 'legend', 'fontSize'));
  return {
    side,
    cfg: {
      ...(side === 'top' ? { top: 0, left: center ? 'center' : 0 } : side === 'bottom' ? { bottom: 0, left: center ? 'center' : 0 } : side === 'left' ? { left: 0, top: 'middle', orient: 'vertical' as const } : { right: 0, top: 'middle', orient: 'vertical' as const }),
      textStyle: { color: col ?? THEME.axis.color, fontSize: size ?? THEME.axis.size },
    },
  };
}

/** Data labels: color/size/units from the labels object. */
function labelLook(v: Visual) {
  return { color: sp(v, 'labels', 'color') as string | undefined, size: pt(sp(v, 'labels', 'fontSize')), units: sp(v, 'labels', 'labelDisplayUnits'), precision: sp(v, 'labels', 'labelPrecision') };
}

/** The default single-series color follows the theme's first color. */
const main = (c: string) => (c.toUpperCase() === '#118DFF' ? PALETTE[0] : c);

const catLabel = (c: string | null) => (c === null ? tr('(Vuoto)') : c);

/** Continuous ("Continuo") category axis: a single date column without hierarchy (default, like Power BI)
 *  or a numeric one when the axis type is set to continuous. Returns the axis kind, or null for categorical. */
export function continuousAxis(v: Visual, items: QueryItem[]): 'time' | 'value' | null {
  const cats = items.filter((i) => i.well === 'category');
  if (cats.length !== 1 || cats[0].field.agg !== 'none' || cats[0].field.datePart || v.drill?.expand) return null;
  const f = cats[0].field;
  const type = useStore.getState().tables.find((t) => t.name === f.table)?.columns.find((c) => c.name === f.column)?.type.toUpperCase() ?? '';
  const pref = v.format.axisType ?? (sp(v, 'categoryAxis', 'axisType') === 'Categorical' ? 'categorical' : sp(v, 'categoryAxis', 'axisType') === 'Scalar' ? 'continuous' : undefined);
  if (/^(DATE|TIMESTAMP)/.test(type)) return pref === 'categorical' ? null : 'time';
  if (/INT|DOUBLE|DECIMAL|FLOAT|REAL|NUMERIC|HUGEINT/.test(type)) return pref === 'continuous' ? 'value' : null;
  return null;
}

const IT_MONTH = { format: (d: Date) => new Intl.DateTimeFormat(locale(), { month: 'short' }).format(d) };
const IT_DAY = { format: (d: Date) => new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short' }).format(d) };
/** Time-axis tick label in Italian, coarser as the visible span grows (anno › mese › giorno). */
function timeTick(span: number) {
  return (t: number) => {
    const d = new Date(t);
    if (span > 3 * 365 * 864e5) return String(d.getFullYear());
    if (span > 90 * 864e5) return d.getMonth() === 0 ? String(d.getFullYear()) : IT_MONTH.format(d).replace('.', '');
    return IT_DAY.format(d).replace('.', '');
  };
}
const toTime = (c: string | null) => (c === null ? NaN : Date.parse(c.length <= 10 ? c + 'T00:00:00' : c.replace(' ', 'T')));

interface Built { option: echarts.EChartsCoreOption; categories: (string | null)[]; }

function uniq(vals: (string | null)[]) {
  const seen = new Set<string | null>();
  const out: (string | null)[] = [];
  for (const v of vals) if (!seen.has(v)) { seen.add(v); out.push(v); }
  return out;
}

function cartesian(v: Visual, d: VisualData, selected: string | null | undefined, width: number): Built {
  const f = v.format;
  const horizontal = ['stackedBar', 'clusteredBar', 'stackedBar100'].includes(v.type);
  const stacked = ['stackedBar', 'stackedColumn', 'stackedBar100', 'stackedColumn100', 'stackedArea', 'lineStackedColumn'].includes(v.type);
  const pct = v.type.endsWith('100');
  const kind = v.type === 'line' || v.type.includes('Area') || v.type === 'area' ? 'line' : 'bar';
  const area = v.type === 'area' || v.type === 'stackedArea';

  const cat = d.items.find((i) => i.well === 'category');
  // "Expand all" levels: one combined category per row ("2014 Trim 1").
  const catItems = d.items.filter((i) => i.well === 'category');
  const ck = (r: Record<string, any>): string | null => (catItems.length > 1 ? catItems.map((c) => r[c.alias] ?? tr('(Vuoto)')).join(' ') : r[cat!.alias]);
  const leg = d.items.find((i) => i.well === 'legend');
  const vals = d.items.filter((i) => i.well === 'values');
  const categories = cat ? uniq(d.rows.map((r) => ck(r))) : [null];
  const catIndex = new Map(categories.map((c, i) => [c, i]));

  type S = { name: string; data: (number | null)[] };
  let series: S[];
  if (leg && vals[0]) {
    const legends = uniq(d.rows.map((r) => r[leg.alias]));
    series = legends.map((l) => ({ name: catLabel(l), data: categories.map(() => null as number | null) }));
    const li = new Map(legends.map((l, i) => [l, i]));
    for (const r of d.rows) series[li.get(r[leg.alias])!].data[cat ? catIndex.get(ck(r))! : 0] = r[vals[0].alias];
  } else {
    series = vals.map((m) => ({ name: fieldLabel(m.field), data: categories.map(() => null as number | null) }));
    for (const r of d.rows) vals.forEach((m, k) => (series[k].data[cat ? catIndex.get(ck(r))! : 0] = r[m.alias]));
  }
  // Combo charts: line measures on a secondary axis, one value per category.
  const lineItems = d.items.filter((i) => i.well === 'lineValues');
  const lines: S[] = lineItems.map((m) => ({ name: fieldLabel(m.field), data: categories.map(() => null as number | null) }));
  for (const r of (leg && d.rowTotals) || d.rows) {
    const i = cat ? catIndex.get(ck(r)) : 0;
    if (i !== undefined) lineItems.forEach((m, k) => (lines[k].data[i] = r[m.alias]));
  }
  // Cross-highlight (bars only): the same series computed with the other visual's selection.
  const hl: (number | null)[][] | null = d.highlight && kind === 'bar' ? series.map(() => categories.map(() => null as number | null)) : null;
  if (hl && d.highlight) {
    if (leg && vals[0]) {
      const li = new Map(series.map((x, i) => [x.name, i]));
      for (const r of d.highlight) { const k = li.get(catLabel(r[leg.alias])); const i = cat ? catIndex.get(ck(r)) : 0; if (k !== undefined && i !== undefined) hl[k][i] = r[vals[0].alias]; }
    } else {
      for (const r of d.highlight) { const i = cat ? catIndex.get(ck(r)) : 0; if (i !== undefined) vals.forEach((m, k) => (hl[k][i] = r[m.alias])); }
    }
  }
  if (pct) {
    const tot = categories.map((_, i) => series.reduce((a, s) => a + Math.abs(s.data[i] ?? 0), 0));
    const norm = (xs: (number | null)[]) => xs.map((x, i) => (x === null || !tot[i] ? x : (x / tot[i]) * 100));
    if (hl) hl.forEach((h, k) => (hl[k] = norm(h)));
    series.forEach((s) => (s.data = norm(s.data)));
  }

  const axisLine = { show: false };
  const ca = axisLook(v, 'categoryAxis'), va = axisLook(v, 'valueAxis'), lb = labelLook(v);
  const pc = pointColors(v);
  const fmtVal = (x: number, digits?: number) => units(x, va.units, va.precision) ?? fmtAuto(x, digits);
  const fmtLbl = (x: number) => units(x, lb.units, lb.precision) ?? fmtAuto(x);
  // Like Power BI: rotate category labels when they no longer fit side by side.
  const slot = (width - 60) / Math.max(1, categories.length);
  const rotated = !horizontal && Math.max(1, ...categories.map((c) => catLabel(c).length)) * 6.2 > slot;
  const catAxis = {
    type: 'category' as const,
    data: categories.map(catLabel),
    show: (horizontal ? f.yAxisShow : f.xAxisShow) && ca.show,
    inverse: horizontal,
    axisTick: { show: false },
    axisLine: { show: !horizontal, lineStyle: { color: '#C8C6C4' } },
    axisLabel: {
      color: THEME.axis.color, fontSize: THEME.axis.size, hideOverlap: true, overflow: 'truncate' as const,
      ...(horizontal ? { width: 90 } : rotated ? { rotate: 45, interval: 0, width: 90 } : { width: Math.max(30, slot) }),
      ...ca.label,
    },
    name: cat && ca.title ? cat.field.column : '',
    nameLocation: 'middle' as const,
    nameGap: horizontal ? 0 : rotated ? 62 : 28,
    nameTextStyle: { color: THEME.dataLabel.color, fontSize: THEME.axis.size, ...ca.titleStyle },
    boundaryGap: kind === 'bar',
  };
  if (horizontal) Object.assign(catAxis, { name: '' });
  // Continuous axis: points placed by date/number instead of one slot (and one label) per value.
  const cont = continuousAxis(v, d.items);
  const xs = cont ? categories.map((c) => (cont === 'time' ? toTime(c) : c === null ? NaN : Number(c))) : [];
  if (cont) {
    const finite = xs.filter(Number.isFinite);
    const span = finite.length ? Math.max(...finite) - Math.min(...finite) : 0;
    Object.assign(catAxis, {
      type: cont, data: undefined, scale: cont === 'value', boundaryGap: kind === 'bar' ? ['2%', '2%'] : false,
      axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, hideOverlap: true, ...(cont === 'time' ? { formatter: timeTick(span) } : { formatter: (x: number) => fmtAuto(x) }), ...ca.label },
      splitLine: { show: false }, nameGap: 28,
    });
  }
  const at = (i: number, y: number | null) => (cont ? [xs[i], y] : y);
  const yOf = (p: any) => (Array.isArray(p.value) ? p.value[1] : p.value);
  const asPct = vals.length > 0 && d.percent.has(vals[0].alias) && !pct;
  const valAxis = {
    type: 'value' as const,
    show: (horizontal ? f.xAxisShow : f.yAxisShow) && va.show,
    max: pct ? 100 : undefined,
    axisLine,
    splitLine: { show: va.grid ?? f.gridlines, lineStyle: { color: va.gridColor ?? '#E1DFDD', type: 'dotted' as const } },
    axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, formatter: (x: number) => (pct ? x + '%' : asPct ? fmtPct(x) : fmtVal(x, 0)), ...va.label },
    name: !va.title || horizontal || leg || vals.length > 1 || d.items.some((i) => i.well === 'lineValues') ? '' : vals[0] ? fieldLabel(vals[0].field) : '',
    nameLocation: 'middle' as const,
    // Wider labels (theme or axis font size) push the axis title out.
    nameGap: Math.round(44 * ((va.label as { fontSize?: number }).fontSize ?? THEME.axis.size) / 11),
    nameTextStyle: { color: THEME.dataLabel.color, fontSize: THEME.axis.size, ...va.titleStyle },
  };

  const lineAxis = { ...valAxis, name: '', position: 'right' as const, splitLine: { show: false },
    axisLabel: { ...valAxis.axisLabel, formatter: (x: number) => fmtAuto(x, 0) } };
  const showLegend = f.legendShow && (series.length + lines.length > 1 || !!leg);
  const lg = legendLook(v, f.legendPos);
  const legendCfg = showLegend ? {
    show: true, type: 'scroll' as const, icon: 'circle', itemWidth: 8, itemHeight: 8,
    ...lg.cfg,
    ...(leg ? { formatter: undefined, data: [...series, ...lines].map((s) => s.name) } : {}),
  } : { show: false };

  const singleColor = series.length === 1 && !leg && !lines.length;
  // "Colori dati" › fx gradient: each bar colored by its value.
  const grad = singleColor && f.colorScale ? f.colorScale : undefined;
  const gradRange = grad ? rangeOf(series[0].data) : null;
  // "In base al campo": each category colored by another field's value (gradient or rules).
  const cr = singleColor ? f.colorRule : undefined;
  const crItem = cr ? d.cfItems.find((c) => fieldKey(c.field) === fieldKey(cfInput(cr.field))) : undefined;
  const drv: (number | null)[] = categories.map(() => null);
  if (crItem) for (const r of d.rows) { const i = cat ? catIndex.get(ck(r)) : 0; const x = r[crItem.alias]; if (i !== undefined) drv[i] = x === null || x === undefined ? null : Number(x); }
  const drvRange = crItem ? rangeOf(drv) : null;
  const ruleColor = (i: number): string | undefined => {
    if (!cr || !crItem) return undefined;
    const x = drv[i];
    return ruleValue(cr.rules, x) ?? (cr.scale && drvRange && x !== null ? scaleColor(cr.scale, drvRange, x) : undefined);
  };
  const colors = singleColor ? [main(f.color)] : series.map((s, k) => pc.byValue.get(leg ? s.name : '') ?? pc.byRef.get(vals[k] ? queryRef(vals[k].field) : '') ?? PALETTE[k % PALETTE.length]);
  const pointStyle = (i: number, x: number | null) => ({
    ...(singleColor && pc.byValue.has(categories[i] ?? '') ? { color: pc.byValue.get(categories[i] ?? '') } : {}),
    ...(grad && gradRange && x !== null ? { color: scaleColor(grad, gradRange, x) } : {}),
    ...(ruleColor(i) ? { color: ruleColor(i) } : {}),
  });
  const valText = (x: number) => (pct ? fmtFull(x) + '%' : asPct ? fmtPct(x) : fmtFull(x));
  const option: echarts.EChartsCoreOption = {
    textStyle: { fontFamily: THEME.text.label.font },
    animationDuration: 300,
    legend: hl && legendCfg.show ? { ...legendCfg, data: [...series, ...lines].map((s) => s.name) } : legendCfg,
    grid: {
      left: horizontal ? 8 : 28, right: 16, bottom: horizontal ? 8 : 30,
      top: showLegend && lg.side === 'top' ? 28 : 12, containLabel: true,
      ...(showLegend && lg.side === 'bottom' ? { bottom: horizontal ? 30 : 54 } : {}),
    },
    tooltip: {
      trigger: 'axis', axisPointer: { type: kind === 'bar' ? 'shadow' : 'line' }, confine: true,
      valueFormatter: valText,
      // Highlighted: "selected / total" per series, the faded remainders are not listed.
      ...(hl ? { formatter: (ps: any[]) => [ps[0]?.axisValueLabel ?? '', ...ps.filter((p) => !String(p.seriesId).endsWith('|r')).map((p) => {
        const k = Number(String(p.seriesId).slice(1).split('|')[0]);
        const h = hl[k]?.[p.dataIndex], t = series[k]?.data[p.dataIndex];
        return Number.isFinite(k) && k < series.length ? `${p.marker}${p.seriesName}: <b>${h === null || h === undefined ? '—' : valText(h)}</b> / ${t === null || t === undefined ? '—' : valText(t)}` : `${p.marker}${p.seriesName}: <b>${valText(yOf(p))}</b>`;
      })].join('<br/>') } : {}),
    },
    color: colors.concat(PALETTE),
    xAxis: horizontal ? valAxis : catAxis,
    yAxis: horizontal ? catAxis : lines.length ? [valAxis, lineAxis] : valAxis,
    series: [...series.map((s, k) => ({
      id: `s${k}|h`,
      name: s.name,
      ...(hl ? { itemStyle: { color: colors[k % colors.length] } } : {}),
      type: kind,
      stack: stacked ? 'total' : hl ? `hl${k}` : undefined,
      barMaxWidth: 60,
      barGap: '8%',
      symbol: kind === 'line' ? 'none' : undefined,
      smooth: false,
      lineStyle: kind === 'line' ? { width: 2.5 } : undefined,
      areaStyle: area ? { opacity: stacked ? 0.85 : 0.4 } : undefined,
      emphasis: { focus: 'none' },
      label: { show: f.dataLabels, position: stacked ? 'inside' : horizontal ? 'right' : 'top', fontSize: lb.size ?? THEME.dataLabel.size, color: lb.color ?? (stacked ? '#fff' : THEME.dataLabel.color), formatter: (p: any) => (yOf(p) === null ? '' : pct ? fmtAuto(yOf(p), 1) + '%' : asPct ? fmtPct(yOf(p)) : fmtLbl(yOf(p))) },
      ...(cont && kind === 'bar' ? { barMaxWidth: Math.max(2, Math.min(60, ((width - 80) / Math.max(1, categories.length)) * 0.8 / (stacked ? 1 : series.length))) } : {}),
      data: s.data.map((x, i) => ({
        value: at(i, hl ? hl[k][i] : x),
        itemStyle: {
          ...pointStyle(i, x),
          ...(selected !== undefined && categories[i] !== selected ? { opacity: 0.35 } : {}),
        },
      })),
      z: k,
    })), ...(hl ? series.map((s, k) => ({
      // Remainder of each bar (total − highlighted), faded, stacked on the highlighted part.
      id: `s${k}|r`, name: s.name, type: 'bar', stack: stacked ? 'total' : `hl${k}`, barMaxWidth: 60, barGap: '8%', emphasis: { focus: 'none' },
      itemStyle: { color: colors[k % colors.length], opacity: 0.35 }, label: { show: false }, z: k,
      data: s.data.map((x, i) => ({ value: at(i, x === null ? null : x - (hl[k][i] ?? 0)), itemStyle: { ...pointStyle(i, x), opacity: 0.35 } })),
    })) : []), ...lines.map((s, k) => ({
      name: s.name, type: 'line', yAxisIndex: 1, symbol: 'circle', symbolSize: 6, lineStyle: { width: 2.5 },
      color: PALETTE[(series.length + k) % PALETTE.length], z: 50 + k,
      label: { show: f.dataLabels, position: 'top', fontSize: THEME.dataLabel.size, color: THEME.dataLabel.color, formatter: (p: any) => (yOf(p) === null ? '' : fmtAuto(yOf(p))) },
      data: s.data.map((x, i) => at(i, x)),
    }))],
  };
  return { option, categories };
}

function pieLike(v: Visual, d: VisualData, selected: string | null | undefined): Built {
  const f = v.format;
  const cat = d.items.find((i) => i.well === 'category');
  const val = d.items.find((i) => i.well === 'values');
  const categories = cat ? d.rows.map((r) => r[cat.alias]) : [null];
  const pc = pointColors(v);
  const lb = labelLook(v);
  // Cross-highlight: slices without highlighted value are faded; the tooltip shows "selected / total".
  const hv = d.highlight && cat && val ? new Map(d.highlight.map((r) => [r[cat.alias], r[val.alias] as number | null])) : null;
  const data = d.rows.map((r, i) => {
    const own = pc.byValue.get(categories[i] ?? '');
    const h = hv?.get(categories[i]);
    const faded = (selected !== undefined && categories[i] !== selected) || (hv && !h);
    return {
      name: catLabel(cat ? r[cat.alias] : null),
      value: val ? r[val.alias] : 0,
      idx: i,
      ...(hv ? { hl: h ?? null } : {}),
      itemStyle: { ...(own ? { color: own } : {}), ...(faded ? { opacity: 0.35 } : {}) },
    };
  });
  const lg = legendLook(v, f.legendPos);
  const legend = f.legendShow ? { show: true, type: 'scroll' as const, icon: 'circle', itemWidth: 8, itemHeight: 8, ...lg.cfg } : { show: false };
  const base = { color: PALETTE, textStyle: { fontFamily: THEME.text.label.font }, legend, animationDuration: 300, tooltip: { trigger: 'item', confine: true, valueFormatter: fmtFull,
    ...(hv ? { formatter: (p: any) => `${p.marker}${p.name}: <b>${p.data?.hl === null || p.data?.hl === undefined ? '—' : fmtFull(p.data.hl)}</b> / ${fmtFull(p.value)}` } : {}) } };

  if (v.type === 'treemap') {
    return {
      categories,
      option: {
        ...base, legend: { show: false },
        series: [{ type: 'treemap', roam: false, nodeClick: false, breadcrumb: { show: false }, width: '100%', height: '100%', top: 0, left: 0,
          itemStyle: { borderColor: '#fff', borderWidth: 1, gapWidth: 1 },
          label: { show: f.dataLabels, fontSize: THEME.axis.size, formatter: '{b}' },
          data: data.map((x, i) => ({ ...x, itemStyle: { color: PALETTE[i % PALETTE.length], ...x.itemStyle } })) }],
      },
    };
  }
  if (v.type === 'funnel') {
    return {
      categories,
      option: {
        ...base, legend: { show: false },
        series: [{ type: 'funnel', sort: 'descending', left: '18%', width: '64%', top: 8, bottom: 8, gap: 2,
          label: { show: true, position: 'left', color: THEME.axis.color, fontSize: THEME.axis.size, formatter: '{b}' },
          labelLine: { show: false },
          itemStyle: { color: main(f.color), borderWidth: 0 },
          data: f.dataLabels ? data.map((x) => ({ ...x, label: { show: true } })) : data }],
      },
    };
  }
  return {
    categories,
    option: {
      ...base,
      series: [{
        type: 'pie', radius: v.type === 'donut' ? ['45%', '72%'] : [0, '72%'],
        center: [f.legendShow && lg.side === 'right' ? '42%' : f.legendShow && lg.side === 'left' ? '58%' : '50%', f.legendShow && lg.side === 'top' ? '55%' : f.legendShow && lg.side === 'bottom' ? '45%' : '50%'],
        avoidLabelOverlap: true, itemStyle: { borderColor: '#fff', borderWidth: 1 },
        label: { show: f.dataLabels, color: lb.color ?? THEME.axis.color, fontSize: lb.size ?? THEME.axis.size, formatter: (p: any) => `${units(p.value, lb.units, lb.precision) ?? fmtAuto(p.value)} (${p.percent.toLocaleString(locale(), { maximumFractionDigits: 2 })}%)` },
        data,
      }],
    },
  };
}

function scatter(v: Visual, d: VisualData, selected: string | null | undefined): Built {
  const f = v.format;
  const det = d.items.find((i) => i.well === 'details');
  const x = d.items.find((i) => i.well === 'x');
  const y = d.items.find((i) => i.well === 'y');
  const leg = d.items.find((i) => i.well === 'legend');
  const categories = det ? d.rows.map((r) => r[det.alias]) : [null];
  // Cross-highlight: points not in the highlighted rows are faded.
  const hset = d.highlight && det ? new Set(d.highlight.filter((r) => (x ? r[x.alias] !== null : true) || (y ? r[y.alias] !== null : true)).map((r) => r[det.alias])) : null;
  const groups = leg ? uniq(d.rows.map((r) => r[leg.alias])) : [null];
  const axis = (it: QueryItem | undefined, show: boolean) => ({
    type: 'value', show, scale: true, name: it ? fieldLabel(it.field) : '', nameLocation: 'middle', nameGap: 30,
    nameTextStyle: { color: THEME.dataLabel.color, fontSize: THEME.axis.size },
    splitLine: { show: f.gridlines, lineStyle: { color: '#E1DFDD', type: 'dotted' } },
    axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, formatter: (n: number) => fmtAuto(n, 0) },
  });
  return {
    categories,
    option: {
      color: PALETTE, textStyle: { fontFamily: THEME.text.label.font }, animationDuration: 300,
      legend: { show: f.legendShow && !!leg, top: 0, icon: 'circle', itemWidth: 8, itemHeight: 8 },
      grid: { left: 30, right: 16, top: leg ? 28 : 12, bottom: 30, containLabel: true },
      tooltip: { trigger: 'item', confine: true, formatter: (p: any) => `${p.data.name}<br/>${x ? fieldLabel(x.field) : ''}: <b>${fmtFull(p.data.value[0])}</b><br/>${y ? fieldLabel(y.field) : ''}: <b>${fmtFull(p.data.value[1])}</b>` },
      xAxis: axis(x, f.xAxisShow),
      yAxis: axis(y, f.yAxisShow),
      series: groups.map((g) => ({
        type: 'scatter', name: catLabel(g), symbolSize: 10,
        itemStyle: groups.length === 1 ? { color: main(f.color) } : undefined,
        data: d.rows.map((r, i) => ({ r, i })).filter(({ r }) => !leg || r[leg.alias] === g).map(({ r, i }) => ({
          name: catLabel(det ? r[det.alias] : null), value: [x ? r[x.alias] : 0, y ? r[y.alias] : 0], idx: i,
          itemStyle: (selected !== undefined && categories[i] !== selected) || (hset && !hset.has(categories[i])) ? { opacity: 0.25 } : undefined,
        })),
      })),
    },
  };
}

function gauge(v: Visual, d: VisualData): Built {
  const val = d.items.find((i) => i.well === 'values');
  const tgt = d.items.find((i) => i.well === 'target');
  const value = val ? d.rows[0]?.[val.alias] ?? 0 : 0;
  const target = tgt ? d.rows[0]?.[tgt.alias] : undefined;
  const max = target ? Math.max(target, value) * 1.25 : value * 2 || 1;
  return {
    categories: [],
    option: {
      textStyle: { fontFamily: THEME.text.label.font },
      series: [{
        type: 'gauge', startAngle: 180, endAngle: 0, min: 0, max, center: ['50%', '72%'], radius: '95%',
        progress: { show: true, width: 36, itemStyle: { color: main(v.format.color) } },
        axisLine: { lineStyle: { width: 36, color: [[1, '#E6E6E6']] } },
        pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
        axisLabel: { show: true, distance: -20, color: THEME.axis.color, fontSize: 10, formatter: (n: number) => (n === 0 || Math.abs(n - max) < 1e-9 ? fmtAuto(n) : '') },
        anchor: { show: false },
        detail: { valueAnimation: true, offsetCenter: [0, '-12%'], fontSize: 22, color: THEME.dataLabel.color, formatter: (n: number) => fmtAuto(n) },
        markLine: undefined,
        data: [{ value }],
      }, ...(target !== undefined ? [{
        type: 'gauge', startAngle: 180, endAngle: 0, min: 0, max, center: ['50%', '72%'], radius: '95%',
        axisLine: { show: false }, axisTick: { show: false }, axisLabel: { show: false }, splitLine: { show: false }, detail: { show: false },
        pointer: { show: true, length: 40, width: 3, offsetCenter: [0, '-78%'], itemStyle: { color: THEME.dataLabel.color } },
        data: [{ value: target }],
      }] : [])],
    },
  };
}


/** Waterfall: each category moves the running total up (green) or down (red); last bar = total. */
function waterfall(v: Visual, d: VisualData, selected: string | null | undefined): Built {
  const f = v.format;
  const cat = d.items.find((i) => i.well === 'category');
  const val = d.items.find((i) => i.well === 'values');
  const categories = cat ? d.rows.map((r) => r[cat.alias] as string | null) : [];
  type Step = { value: [number, number, number]; idx: number; v: number };
  const steps: Record<'up' | 'down' | 'total', Step[]> = { up: [], down: [], total: [] };
  let run = 0;
  d.rows.forEach((r, i) => {
    const x = val ? Number(r[val.alias] ?? 0) : 0;
    steps[x >= 0 ? 'up' : 'down'].push({ value: [i, run, run + x], idx: i, v: x });
    run += x;
  });
  steps.total.push({ value: [categories.length, 0, run], idx: categories.length, v: run });
  const bar = (color: string) => (params: any, api: any) => {
    const i = api.value(0);
    const a = api.coord([i, api.value(1)]), b = api.coord([i, api.value(2)]);
    const w = Math.min(60, api.size([1, 0])[0] * 0.6);
    const faded = selected !== undefined && i < categories.length && categories[i] !== selected;
    return { type: 'rect', shape: { x: a[0] - w / 2, y: Math.min(a[1], b[1]), width: w, height: Math.max(1, Math.abs(a[1] - b[1])) }, style: { fill: color, opacity: faded ? 0.35 : 1 } };
  };
  const series = ([['up', tr('Aumento'), THEME.good], ['down', tr('Riduzione'), THEME.bad], ['total', tr('Totale'), PALETTE[0]]] as const).map(([k, name, color]) => ({
    name, type: 'custom', color, renderItem: bar(color), encode: { x: 0, y: [1, 2] }, data: steps[k],
    label: { show: f.dataLabels, position: 'top', fontSize: THEME.dataLabel.size, color: THEME.dataLabel.color, formatter: (p: any) => fmtAuto(p.data.v) },
  }));
  return {
    categories,
    option: {
      textStyle: { fontFamily: THEME.text.label.font }, animationDuration: 300,
      legend: { show: f.legendShow, top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: THEME.axis.color, fontSize: THEME.axis.size } },
      grid: { left: 28, right: 16, bottom: 30, top: f.legendShow ? 28 : 12, containLabel: true },
      tooltip: { trigger: 'item', confine: true, formatter: (p: any) => `${p.data.idx < categories.length ? catLabel(categories[p.data.idx]) : tr('Totale')}<br/>${val ? fieldLabel(val.field) : ''}: <b>${fmtFull(p.data.v)}</b>` },
      xAxis: { type: 'category', show: f.xAxisShow, data: [...categories.map(catLabel), tr('Totale')], axisTick: { show: false }, axisLine: { lineStyle: { color: '#C8C6C4' } }, axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, hideOverlap: true } },
      yAxis: { type: 'value', show: f.yAxisShow, scale: false, splitLine: { show: f.gridlines, lineStyle: { color: '#E1DFDD', type: 'dotted' } }, axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, formatter: (x: number) => fmtAuto(x, 0) } },
      series,
    },
  };
}

/** Ribbon chart: stacked columns re-ranked per category (largest on top), joined by ribbons. */
function ribbon(v: Visual, d: VisualData, selected: string | null | undefined, width: number): Built {
  const leg = d.items.find((i) => i.well === 'legend');
  if (!leg) return cartesian({ ...v, type: 'stackedColumn' }, d, selected, width);
  const f = v.format;
  const cat = d.items.find((i) => i.well === 'category');
  const val = d.items.find((i) => i.well === 'values');
  const categories = cat ? uniq(d.rows.map((r) => r[cat.alias])) : [null];
  const legends = uniq(d.rows.map((r) => r[leg.alias]));
  const ci = new Map(categories.map((c, i) => [c, i]));
  const li = new Map(legends.map((l, i) => [l, i]));
  const value: number[][] = legends.map(() => categories.map(() => 0));
  for (const r of d.rows) value[li.get(r[leg.alias])!][cat ? ci.get(r[cat.alias])! : 0] = Math.max(0, Number(r[val?.alias ?? ''] ?? 0));
  // [y0, y1] of every (series, category): smallest at the bottom.
  const span: [number, number][][] = legends.map(() => []);
  categories.forEach((_, c) => {
    let y = 0;
    legends.map((_, s) => s).sort((a, b) => value[a][c] - value[b][c]).forEach((s) => { span[s][c] = [y, y + value[s][c]]; y += value[s][c]; });
  });
  const max = Math.max(1, ...categories.map((_, c) => legends.reduce((a, _, s) => a + value[s][c], 0)));
  return {
    categories,
    option: {
      color: PALETTE, textStyle: { fontFamily: THEME.text.label.font }, animationDuration: 300,
      legend: { show: f.legendShow, type: 'scroll', top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { color: THEME.axis.color, fontSize: THEME.axis.size } },
      grid: { left: 28, right: 16, bottom: 30, top: f.legendShow ? 28 : 12, containLabel: true },
      tooltip: { trigger: 'item', confine: true, formatter: (p: any) => `${catLabel(categories[p.data.idx])}<br/>${p.seriesName}: <b>${fmtFull(p.data.v)}</b>` },
      xAxis: { type: 'category', show: f.xAxisShow, data: categories.map(catLabel), axisTick: { show: false }, axisLine: { lineStyle: { color: '#C8C6C4' } }, axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, hideOverlap: true } },
      yAxis: { type: 'value', show: f.yAxisShow, max, splitLine: { show: f.gridlines, lineStyle: { color: '#E1DFDD', type: 'dotted' } }, axisLabel: { color: THEME.axis.color, fontSize: THEME.axis.size, formatter: (x: number) => fmtAuto(x, 0) } },
      series: legends.map((l, s) => ({
        name: catLabel(l), type: 'custom', encode: { x: 0, y: [1, 2] },
        data: categories.map((_, c) => ({ value: [c, ...span[s][c]], idx: c, v: value[s][c] })),
        renderItem: (params: any, api: any) => {
          const c = api.value(0);
          const band = api.size([1, 0])[0];
          const w = Math.min(60, band * 0.55);
          const p0 = api.coord([c, api.value(1)]), p1 = api.coord([c, api.value(2)]);
          const color = api.visual('color');
          const faded = selected !== undefined && categories[c] !== selected;
          const children: any[] = [{ type: 'rect', shape: { x: p0[0] - w / 2, y: p1[1], width: w, height: p0[1] - p1[1] }, style: { fill: color, opacity: faded ? 0.35 : 1 } }];
          const next = span[s][c + 1];
          if (next) {
            const q0 = api.coord([c + 1, next[0]]), q1 = api.coord([c + 1, next[1]]);
            children.push({ type: 'polygon', silent: true, shape: { points: [[p0[0] + w / 2, p1[1]], [q0[0] - w / 2, q1[1]], [q0[0] - w / 2, q0[1]], [p0[0] + w / 2, p0[1]]] }, style: { fill: color, opacity: 0.35 } });
          }
          return { type: 'group', children };
        },
        label: { show: f.dataLabels, position: 'inside', fontSize: 10, color: '#fff', formatter: (p: any) => (p.data.v ? fmtAuto(p.data.v) : '') },
      })),
    },
  };
}

export function buildOption(v: Visual, d: VisualData, cross: CrossFilter | null, width = 400): Built {
  const selected = cross && cross.visualId === v.id ? (cross.value === NULL_KEY ? null : cross.value) : undefined;
  if (['pie', 'donut', 'treemap', 'funnel'].includes(v.type)) return pieLike(v, d, selected);
  if (v.type === 'gauge') return gauge(v, d);
  if (v.type === 'waterfall') return waterfall(v, d, selected);
  if (v.type === 'ribbon') return ribbon(v, d, selected, width);
  const built = v.type === 'scatter' ? scatter(v, d, selected) : cartesian(v, d, selected, width);
  applyAnalytics(v, d, built.option);
  return built;
}

/** Data point events for drill-through (right click) and report-page tooltips (hover). */
export interface PointEvents {
  onContext?: (category: string | null, x: number, y: number) => void;
  onHover?: (category: string | null | undefined, x: number, y: number) => void;
}

export function ChartVisual({ v, data, cross, onSelect, events }: {
  v: Visual; data: VisualData; cross: CrossFilter | null; onSelect: (category: string | null) => void; events?: PointEvents;
}) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const cats = useRef<(string | null)[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const evRef = useRef(events);
  evRef.current = events;

  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p: any) => {
      const idx = p.data?.idx ?? p.dataIndex;
      if (idx !== undefined && idx < cats.current.length) onSelectRef.current(cats.current[idx]);
    });
    const point = (p: any) => { const idx = p.data?.idx ?? p.dataIndex; return idx !== undefined && idx < cats.current.length ? cats.current[idx] : undefined; };
    c.on('contextmenu', (p: any) => {
      const cat = point(p);
      const ev = p.event?.event as MouseEvent | undefined;
      if (cat === undefined || !ev || !evRef.current?.onContext) return;
      ev.preventDefault(); ev.stopPropagation();
      evRef.current.onContext(cat, ev.clientX, ev.clientY);
    });
    c.on('mouseover', (p: any) => { const ev = p.event?.event as MouseEvent | undefined; if (ev) evRef.current?.onHover?.(point(p), ev.clientX, ev.clientY); });
    c.on('mouseout', () => evRef.current?.onHover?.(undefined, 0, 0));
    c.on('globalout', () => evRef.current?.onHover?.(undefined, 0, 0));
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); c.dispose(); };
  }, []);

  const theme = useStore((s) => s.report.theme);
  useEffect(() => {
    if (!chart.current || data.error) return;
    const { option, categories } = buildOption(v, data, cross, el.current?.clientWidth ?? 400);
    cats.current = categories;
    // A report-page tooltip replaces the default one.
    if (v.format.tooltipPage) (option as any).tooltip = { show: false };
    else if (THEME.tooltip.background || THEME.tooltip.value) {
      // Theme "Descrizione comando" colors.
      const tt = (option as any).tooltip ?? {};
      (option as any).tooltip = { ...tt, ...(THEME.tooltip.background ? { backgroundColor: THEME.tooltip.background, borderColor: THEME.tooltip.background } : {}), textStyle: { ...(tt.textStyle ?? {}), ...(THEME.tooltip.value ? { color: THEME.tooltip.value } : {}) } };
    }
    chart.current.setOption(option, true);
  }, [v, data, cross, theme]);

  return <div ref={el} style={{ position: 'absolute', inset: '0 4px 4px 4px' }} />;
}
