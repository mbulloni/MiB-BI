/**
 * Power BI report layout (Report/Layout JSON, legacy format) ↔ MiB-BI report.
 * Reference: sections[] → visualContainers[] whose `config` is a JSON string holding
 * singleVisual { visualType, projections, prototypeQuery, objects, vcObjects }.
 */
import { levelName, type Agg, type Bookmark, type FieldRef, type Filter, type Hierarchy, type Page, type TableMeta, type Theme, type Visual, type VisualFormat, type VisualGroup, type VisualType, type Interaction, type RelativeSlicer } from '../types';
import { parseTheme, THEME, themeJson } from '../themes';
import { defaultFormat, PAGE_H, PAGE_W } from '../store';
import { customPkg, isChart as isChartType, visualDef } from '../visuals/catalog';
import { NULL_KEY, relativePeriod, type RangeCond } from '../query';
import { INTERACTION_IN, INTERACTION_OUT, interactionKey } from '../visuals/interactions';
import { refLabel, uid } from '../format';
import { decode, pt } from '../visuals/pbistyle';
import { basicJsonFilter } from '../visuals/custom/objects';
import { exportCondFormat, importCondFormat } from './condfmt';
import { exportAnalytics, importAnalytics } from './analytics';
import { fieldKey } from '../visuals/condfmt';

/** Auto date/time hierarchy written by pbit.ts#buildModelSchema (LocalDateTable_*): hierarchy and level names. */
export const DATE_HIERARCHY = 'Date Hierarchy';
export const DATE_LEVEL: Record<'year' | 'quarter' | 'month' | 'day', string> = { year: 'Year', quarter: 'Quarter', month: 'Month', day: 'Day' };
/** Date hierarchy level of a column (source = alias in From, or an entity). */
const levelExpr = (src: any, column: string, part: keyof typeof DATE_LEVEL) => ({
  HierarchyLevel: { Expression: { Hierarchy: { Expression: { PropertyVariationSource: { Expression: src, Name: 'Variation', Property: column } }, Hierarchy: DATE_HIERARCHY } }, Level: DATE_LEVEL[part] },
});

/** Visible value range per visual and field key, measured before an export (default icon thresholds). */
let CF_RANGES = new Map<string, Map<string, { min: number; max: number }>>();
export const setCfExportRanges = (r: typeof CF_RANGES) => { CF_RANGES = r; };

/* ------------------------------- mappings ------------------------------- */

const TYPE_IN: Record<string, VisualType> = {
  clusteredColumnChart: 'clusteredColumn', columnChart: 'stackedColumn', hundredPercentStackedColumnChart: 'stackedColumn100',
  clusteredBarChart: 'clusteredBar', barChart: 'stackedBar', hundredPercentStackedBarChart: 'stackedBar100',
  lineChart: 'line', areaChart: 'area', stackedAreaChart: 'stackedArea',
  lineClusteredColumnComboChart: 'lineClusteredColumn', lineStackedColumnComboChart: 'lineStackedColumn',
  ribbonChart: 'ribbon', waterfallChart: 'waterfall',
  pieChart: 'pie', donutChart: 'donut', treemap: 'treemap', funnel: 'funnel', scatterChart: 'scatter', gauge: 'gauge',
  card: 'card', cardVisual: 'card', multiRowCard: 'multiRowCard', kpi: 'kpi',
  tableEx: 'table', table: 'table', pivotTable: 'matrix', slicer: 'slicer', advancedSlicerVisual: 'slicer', listSlicer: 'slicer', textSlicer: 'slicer',
  textbox: 'textbox', image: 'image', actionButton: 'button', basicShape: 'shape', shape: 'shape',
  map: 'map', azureMap: 'map', filledMap: 'filledMap', shapeMap: 'filledMap',
  decompositionTreeVisual: 'decompositionTree', keyDriversVisual: 'keyInfluencers', smartNarrativeVisual: 'smartNarrative',
  pythonVisual: 'pythonVisual', scriptVisual: 'rVisual', qnaVisual: 'qna',
  pageNavigator: 'pageNavigator', bookmarkNavigator: 'bookmarkNavigator',
};
/** Decorative/navigation objects that carry no data: not imported. */
const SKIP = new Set(['lineShape']);

const TYPE_OUT: Partial<Record<VisualType, string>> = {
  stackedBar: 'barChart', stackedColumn: 'columnChart', clusteredBar: 'clusteredBarChart', clusteredColumn: 'clusteredColumnChart',
  stackedBar100: 'hundredPercentStackedBarChart', stackedColumn100: 'hundredPercentStackedColumnChart',
  line: 'lineChart', area: 'areaChart', stackedArea: 'stackedAreaChart', pie: 'pieChart', donut: 'donutChart',
  treemap: 'treemap', funnel: 'funnel', scatter: 'scatterChart', gauge: 'gauge', card: 'card', table: 'tableEx',
  lineClusteredColumn: 'lineClusteredColumnComboChart', lineStackedColumn: 'lineStackedColumnComboChart', ribbon: 'ribbonChart',
  waterfall: 'waterfallChart', multiRowCard: 'multiRowCard', kpi: 'kpi',
  matrix: 'pivotTable', slicer: 'slicer', textbox: 'textbox', image: 'image', button: 'actionButton', shape: 'basicShape', map: 'map', filledMap: 'filledMap',
  decompositionTree: 'decompositionTreeVisual', keyInfluencers: 'keyDriversVisual', smartNarrative: 'smartNarrativeVisual',
  pythonVisual: 'pythonVisual', rVisual: 'scriptVisual', qna: 'qnaVisual',
  pageNavigator: 'pageNavigator', bookmarkNavigator: 'bookmarkNavigator',
};

/** Power BI projection role → MiB-BI well, per MiB-BI visual type. */
function roleMap(t: VisualType): Record<string, string> {
  switch (t) {
    case 'pie': case 'donut': case 'funnel': return { Category: 'category', Y: 'values', Values: 'values' };
    case 'treemap': return { Group: 'category', Category: 'category', Values: 'values', Y: 'values' };
    case 'scatter': return { Category: 'details', Details: 'details', X: 'x', Y: 'y', Series: 'legend' };
    case 'gauge': return { Y: 'values', TargetValue: 'target' };
    case 'card': return { Values: 'values', Indicator: 'values', Data: 'values' };
    case 'multiRowCard': return { Values: 'values' };
    case 'kpi': return { Indicator: 'values', TrendLine: 'trend', Goal: 'target' };
    case 'waterfall': return { Category: 'category', Y: 'values' };
    case 'pythonVisual': case 'rVisual': return { Values: 'values' };
    case 'decompositionTree': return { Analyze: 'values', ExplainBy: 'explain' };
    case 'keyInfluencers': return { Target: 'target', ExplainBy: 'explain' };
    case 'map': return { Category: 'category', Series: 'legend', Y: 'lat', X: 'lon', Size: 'values' };
    case 'filledMap': return { Category: 'category', Series: 'legend', Gradient: 'values', Y: 'values' };
    case 'lineClusteredColumn': case 'lineStackedColumn': return { Category: 'category', Y: 'values', Y2: 'lineValues', Series: 'legend' };
    case 'table': return { Values: 'columns' };
    case 'matrix': return { Rows: 'rows', Columns: 'columns', Values: 'values' };
    case 'slicer': return { Values: 'category' };
    default: return { Category: 'category', Y: 'values', Y2: 'values', Series: 'legend' };
  }
}

const AGG_IN: Record<number, Agg> = { 0: 'sum', 1: 'avg', 2: 'countd', 3: 'min', 4: 'max', 5: 'count', 6: 'median', 7: 'stdev', 8: 'var' };
const AGG_OUT: Partial<Record<Agg, [number, string]>> = { sum: [0, 'Sum'], avg: [1, 'Avg'], countd: [2, 'CountNonNull'], min: [3, 'Min'], max: [4, 'Max'], count: [5, 'Count'], median: [6, 'Median'], stdev: [7, 'StandardDeviation'], var: [8, 'Variance'] };

/* -------------------------------- helpers ------------------------------- */

const json = (s: unknown) => { try { return typeof s === 'string' ? JSON.parse(s) : s ?? {}; } catch { return {}; } };
const lit = (o: any): string | undefined => o?.expr?.Literal?.Value;
const litBool = (o: any): boolean | undefined => { const v = lit(o); return v === undefined ? undefined : v === 'true'; };
const litText = (o: any): string | undefined => { const v = lit(o); return v === undefined ? undefined : v.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'"); };
const prop = (objs: any, name: string) => objs?.[name]?.[0]?.properties ?? {};

type FromMap = Record<string, string>;

/** Semantic-query expression → FieldRef (Column, Aggregation, Measure, HierarchyLevel). */
function exprToField(e: any, from: FromMap): FieldRef | null {
  const entity = (x: any) => from[x?.SourceRef?.Source] ?? x?.SourceRef?.Entity;
  // Visual calculation: DAX on the visual matrix, stored in the visual.
  if (e?.NativeVisualCalculation) return { table: '', column: e.NativeVisualCalculation.Name, agg: 'visualCalc', calc: e.NativeVisualCalculation.Expression ?? '' };
  if (e?.Column) return { table: entity(e.Column.Expression), column: e.Column.Property, agg: 'none' };
  if (e?.Measure) return { table: entity(e.Measure.Expression), column: e.Measure.Property, agg: 'measure' };
  if (e?.Aggregation) {
    const inner = exprToField(e.Aggregation.Expression, from);
    return inner ? { ...inner, agg: AGG_IN[e.Aggregation.Function] ?? 'sum' } : null;
  }
  if (e?.HierarchyLevel) {
    const h = e.HierarchyLevel.Expression?.Hierarchy;
    const pvs = h?.Expression?.PropertyVariationSource;
    // Auto date hierarchy (Date → Year/Quarter/Month/Day): the date column at that level.
    if (pvs) {
      const part = ({ Year: 'year', Anno: 'year', Quarter: 'quarter', Trimestre: 'quarter', Month: 'month', Mese: 'month', Day: 'day', Giorno: 'day' } as const)[e.HierarchyLevel.Level as string];
      return { table: entity(pvs.Expression), column: pvs.Property, agg: 'none', ...(part ? { datePart: part } : {}) };
    }
    // User hierarchy: the level's column (level names may differ from column names).
    const table = entity(h?.Expression);
    return { table, column: levelColumns.get(`${table}\u0001${h?.Hierarchy}\u0001${e.HierarchyLevel.Level}`) ?? e.HierarchyLevel.Level, agg: 'none', ...(h?.Hierarchy ? { hierarchy: h.Hierarchy } : {}) };
  }
  return null;
}

let levelColumns = new Map<string, string>();
/** Before parseLayout: columns of the model's user hierarchy levels. */
export function setHierarchyLevels(hs: { table: string; name: string; levels: { name: string; column: string }[] }[]) {
  levelColumns = new Map(hs.flatMap((h) => h.levels.map((l) => [`${h.table}\u0001${h.name}\u0001${l.name}`, l.column] as [string, string])));
}

/** Literal from a filter ("'abc'", "12L", "1.5D", "datetime'…'", "null") → MiB-BI filter value. */
function literalValue(v: string, dateOnly: boolean): string {
  if (v === 'null') return NULL_KEY;
  let m = /^'(.*)'$/s.exec(v);
  if (m) return m[1].replace(/''/g, "'");
  m = /^datetime'(.*)'$/.exec(v);
  if (m) return dateOnly ? m[1].slice(0, 10) : m[1].replace('T', ' ').replace(/\.0+$/, '');
  m = /^(-?[\d.]+(?:E[+-]?\d+)?)[LDM]$/i.exec(v);
  if (m) return String(Number(m[1]));
  return v;
}

/** Categorical "In" filter (page/report/visual filters, slicer selections). */
function parseCondition(f: any, tables: TableMeta[]): Filter | null {
  const from: FromMap = Object.fromEntries((f?.From ?? []).map((x: any) => [x.Name, x.Entity]));
  const cond = f?.Where?.[0]?.Condition?.In;
  if (!cond || cond.Expressions?.length !== 1) return null;
  const field = exprToField(cond.Expressions[0], from);
  if (!field || field.agg !== 'none') return null;
  const meta = tables.find((t) => t.name === field.table)?.columns.find((c) => c.name === field.column);
  if (!meta) return null;
  const values = (cond.Values ?? []).map((row: any[]) => literalValue(row[0]?.Literal?.Value ?? 'null', meta.type === 'DATE' && !field.datePart));
  return { id: uid(), table: field.table, column: field.column, values, ...(field.datePart ? { datePart: field.datePart } : {}) };
}

function parseFilters(raw: unknown, tables: TableMeta[]): Filter[] {
  const list = json(raw);
  if (!Array.isArray(list)) return [];
  return list.map((f) => parseCondition(f.filter, tables)).filter((x): x is Filter => !!x && x.values.length > 0);
}

/* -------------------------------- import -------------------------------- */

export interface LayoutImport { pages: Page[]; reportFilters: Filter[]; skipped: Record<string, number>; bookmarks: Bookmark[]; filterByDefault?: boolean; }

export function parseLayout(layoutJson: string, tables: TableMeta[], measureNames: Set<string>, resources: Record<string, string>): LayoutImport {
  const layout = JSON.parse(layoutJson);
  const skipped: Record<string, number> = {};
  const known = (f: FieldRef) => (f.agg === 'measure' ? measureNames.has(f.column) : tables.some((t) => t.name === f.table && t.columns.some((c) => c.name === f.column)));

  const sections = [...(layout.sections ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  const pages: Page[] = sections.map((sec: any, si: number) => {
    // Pages keep their Power BI size (16:9, 4:3, tooltip, custom): no rescaling.
    const scale = 1;
    const secCfg = json(sec.config);
    const bgProps = prop(secCfg.objects, 'background');
    const bgName = bgProps?.image?.image?.url?.expr?.ResourcePackageItem?.ItemName;
    const bgFit = decode(bgProps?.image?.image?.scaling);
    const bgColor = decode(bgProps.color);
    const bgTransp = decode(bgProps.transparency);
    const outspace = prop(secCfg.objects, 'outspace');
    const wallColor = decode(outspace.color);
    const refresh = prop(secCfg.objects, 'pageRefresh');
    const refreshMs = decode(refresh.duration);
    const refreshOn = decode(refresh.show) !== false && typeof refreshMs === 'number' && refreshMs > 0;
    // Older files keep geometry only in config.layouts[0].position.
    const geom = (c: any) => {
      const p = json(c.config).layouts?.[0]?.position ?? {};
      return { x: c.x ?? p.x ?? 0, y: c.y ?? p.y ?? 0, z: c.z ?? p.z ?? 0, width: c.width ?? p.width ?? 200, height: c.height ?? p.height ?? 150 };
    };
    const containers = [...(sec.visualContainers ?? [])];
    const zs = containers.map((c: any) => geom(c).z).sort((a: number, b: number) => a - b);
    const visuals: Visual[] = [];
    const groups: (VisualGroup & { parentName?: string })[] = [];
    const groupOf = new Map<Visual, string>();
    // Mobile layout: config.layouts entry with id 1 (id 0 = report layout).
    const mobile: NonNullable<Page['mobile']> = {};

    for (const raw of containers) {
      const vc = { ...raw, ...geom(raw) };
      const cfg = json(vc.config);
      const sv = cfg.singleVisual;
      if (!sv) {
        const g = cfg.singleVisualGroup;
        if (g) groups.push({ id: uid(), name: g.displayName || 'Gruppo', pbiName: cfg.name, ...(g.isHidden ? { hidden: true } : {}), parentName: cfg.parentGroupName });
        continue;
      }
      const pbiType: string = sv.visualType;
      if (SKIP.has(pbiType)) continue;
      // Custom visuals embedded in the file (Report/CustomVisuals) are run by visuals/CustomVisual.tsx.
      let type: VisualType = TYPE_IN[pbiType] ?? (customPkg(pbiType) ? 'custom' : 'unsupported');
      const custom = type === 'custom' ? pbiType : undefined;
      if (type === 'unsupported') skipped[pbiType] = (skipped[pbiType] ?? 0) + 1;

      const from: FromMap = Object.fromEntries((sv.prototypeQuery?.From ?? []).map((x: any) => [x.Name, x.Entity]));
      const byRef: Record<string, FieldRef> = {};
      for (const sel of sv.prototypeQuery?.Select ?? []) {
        const f = exprToField(sel, from);
        if (f) byRef[sel.Name] = f;
      }

      const def = visualDef(type, custom);
      // Custom visuals: projection roles are the package's dataRoles, used as well keys.
      const roles = custom ? Object.fromEntries(def.wells.map((w) => [w.key, w.key])) : roleMap(type);
      const fields: Record<string, FieldRef[]> = {};
      const nativeRefs = new Map<string, FieldRef>();
      for (const [role, projs] of Object.entries<any[]>(sv.projections ?? {})) {
        const well = roles[role];
        const w = def.wells.find((x) => x.key === well);
        if (!w) continue;
        let refs = projs;
        // Drill hierarchies list every level; keep the active one in single-field wells.
        if (w.max === 1 && refs.length > 1) refs = [refs.find((p) => p.active) ?? refs[0]];
        for (const p of refs) {
          const f0 = byRef[p.queryRef];
          if (!f0 || (f0.agg !== 'visualCalc' && !known(f0))) continue;
          const f: FieldRef = { ...f0, ...(p.hidden ? { hidden: true } : {}), ...(f0.agg === 'visualCalc' && p.format ? { format: p.format } : {}),
            ...(f0.agg === 'visualCalc' && p.nativeQueryRef ? { column: p.nativeQueryRef } : {}) };
          if (p.nativeQueryRef) nativeRefs.set(p.nativeQueryRef.toLowerCase(), f);
          const list = (fields[well] ??= []);
          if (w.max && list.length >= w.max) continue;
          if (!list.some((x) => x.table === f.table && x.column === f.column && x.agg === f.agg && x.datePart === f.datePart)) {
            list.push(type === 'table' || custom || f.agg === 'visualCalc' ? f : f.agg === 'none' && w.measure ? { ...f, agg: 'count' } : f);
          }
        }
      }
      // Visual calculations name the fields by their native reference ("Sum of Sales"): use MiB-BI's names.
      for (const f of Object.values(fields).flat()) {
        if (f.agg !== 'visualCalc' || !f.calc) continue;
        f.calc = f.calc.replace(/(?<!['\w\]])\[((?:[^\]]|\]\])+)\]/g, (m, n: string) => {
          const t = nativeRefs.get(n.replace(/\]\]/g, ']').toLowerCase());
          return t ? `[${refLabel(t).replace(/]/g, ']]')}]` : m;
        });
      }

      const format = defaultFormat(type);
      const title = prop(sv.vcObjects, 'title');
      const titleText = litText(title.text);
      const titleShow = litBool(title.show);
      if (titleText) format.titleText = titleText;
      if (titleShow !== undefined) format.titleShow = titleShow;
      const legend = litBool(prop(sv.objects, 'legend').show);
      if (legend !== undefined) format.legendShow = legend;
      const labels = litBool(prop(sv.objects, 'labels').show);
      if (labels !== undefined) format.dataLabels = labels;
      const color = litText(prop(sv.objects, 'dataPoint').fill?.solid?.color);
      if (color && /^#[0-9a-f]{6}$/i.test(color)) format.color = color.toUpperCase();
      const bg = prop(sv.vcObjects, 'background');
      const bgc = decode(bg.color), bgt = decode(bg.transparency);
      if (typeof bgc === 'string' && /^#[0-9a-f]{6}$/i.test(bgc)) format.background = bgc.toUpperCase();
      if (typeof bgt === 'number') format.bgTransparency = bgt;
      if (litBool(bg.show) === false || bgt === 100) format.background = 'transparent';
      const tp = prop(sv.vcObjects, 'title');
      const tc = decode(tp.fontColor), tb = decode(tp.background), ta = decode(tp.alignment), tf = decode(tp.fontFamily), ts = decode(tp.fontSize), tbold = decode(tp.bold);
      if (typeof tc === 'string') format.titleColor = tc;
      if (typeof tb === 'string') format.titleBg = tb;
      if (ta === 'left' || ta === 'center' || ta === 'right') format.titleAlign = ta;
      if (typeof tf === 'string') format.titleFont = tf;
      if (typeof ts === 'number') format.titleSize = pt(ts)!;
      if (typeof tbold === 'boolean') format.titleBold = tbold;
      // Report-page tooltip: section name for now, turned into the page id once all pages are read.
      const tsec = decode(prop(sv.vcObjects, 'visualTooltip').section);
      if (typeof tsec === 'string' && tsec) format.tooltipPage = tsec;
      const bd = prop(sv.vcObjects, 'border');
      if (decode(bd.show) === true) {
        format.border = true;
        const c = decode(bd.color);
        if (typeof c === 'string') format.borderColor = c;
        const r = decode(bd.radius);
        if (typeof r === 'number') format.borderRadius = r;
      }
      if (type === 'slicer') importSlicerFormat(pbiType, sv.objects, format);
      importCondFormat(sv.objects, byRef, Object.values(fields).flat(), format, (e) => exprToField(e, from), isChartType(type) || type === 'filledMap' || type === 'map');
      if (isChartType(type)) { const al = importAnalytics(sv.objects, byRef); if (al.length) format.analytics = al; }
      const axisType = litText(prop(sv.objects, 'categoryAxis').axisType);
      if (axisType === 'Scalar') format.axisType = 'continuous'; else if (axisType === 'Categorical') format.axisType = 'categorical';

      // Explicit sort (OrderBy) → index into MiB-BI's item order (wells in catalog order).
      const ob = sv.prototypeQuery?.OrderBy?.[0];
      if (ob) {
        const f = exprToField(ob.Expression, from);
        const flat = def.wells.flatMap((w) => fields[w.key] ?? []);
        const idx = f ? flat.findIndex((x) => x.table === f.table && x.column === f.column && x.agg === f.agg) : -1;
        if (idx >= 0) { format.sortBy = idx; format.sortDir = ob.Direction === 1 ? 'asc' : 'desc'; }
      }

      const v: Visual = {
        id: uid(), type,
        x: Math.round(vc.x * scale), y: Math.round(vc.y * scale),
        w: Math.max(20, Math.round(vc.width * scale)), h: Math.max(20, Math.round(vc.height * scale)),
        z: zs.indexOf(vc.z ?? 0) + 1,
        fields, format,
        filters: parseFilters(vc.filters, tables),
        style: { pbiType, ...(sv.objects ? { objects: sv.objects } : {}), ...(sv.vcObjects ? { vcObjects: sv.vcObjects } : {}) },
        ...(cfg.name ? { pbiName: cfg.name } : {}),
        ...(custom ? { custom } : {}),
        // Hidden visuals stay in the report (Selection pane, bookmarks), just not drawn.
        ...(sv.display?.mode === 'hidden' ? { hidden: true } : {}),
      };
      if (cfg.parentGroupName) groupOf.set(v, cfg.parentGroupName);
      const mob = (cfg.layouts ?? []).find((l: any) => l?.id === 1)?.position;
      if (mob) mobile[v.id] = { x: Math.round(mob.x ?? 0), y: Math.round(mob.y ?? 0), w: Math.max(20, Math.round(mob.width ?? 100)), h: Math.max(20, Math.round(mob.height ?? 100)) };
      if (type === 'unsupported') { v.text = pbiType; v.style!.raw = sv; }
      if (type === 'keyInfluencers') {
        const kd = prop(sv.objects, 'keyDrivers');
        const tv = decode(kd.targetValue);
        // targetValue is a literal holding a literal ('''Male''' → 'Male' → Male).
        if (typeof tv === 'string') v.ki = { target: tv.replace(/^'(.*)'$/s, '$1').replace(/''/g, "'") };
        if (decode(kd.numericTargetSelectedKind) === 1) v.ki = { ...v.ki, dir: 'down' };
      }
      if (type === 'textbox') {
        const paras = prop(sv.objects, 'general').paragraphs ?? [];
        v.text = (Array.isArray(paras) ? paras : []).map((p: any) => (p.textRuns ?? []).map((r: any) => r.value ?? '').join('')).join('\n');
      }
      if (type === 'image') {
        const name = prop(sv.objects, 'general').imageUrl?.expr?.ResourcePackageItem?.ItemName;
        v.image = name ? resources[name] : undefined;
        if (!v.image) continue;
      }
      if (type === 'slicer') {
        const sel = parseCondition(prop(sv.objects, 'general').filter?.filter, tables);
        if (sel) v.slicerValues = sel.values;
        importSlicerState(v, sv.objects);
      }
      if (sv.syncGroup?.groupName) v.syncGroup = { name: sv.syncGroup.groupName, ...(sv.syncGroup.fieldChanges === false ? { fieldChanges: false } : {}), ...(sv.syncGroup.filterChanges === false ? { filterChanges: false } : {}) };
      if (custom) {
        // Selections of custom slicers: filter-typed properties hold a semantic-query filter.
        for (const [obj, d] of Object.entries<any>(customPkg(custom)!.pbiviz?.capabilities?.objects ?? {})) {
          for (const [pn, pd] of Object.entries<any>(d.properties ?? {})) {
            if (!pd?.type?.filter) continue;
            const f = parseCondition(prop(sv.objects, obj)[pn]?.filter, tables);
            const col = f && tables.find((t) => t.name === f.table)?.columns.find((c) => c.name === f.column);
            if (f) (v.jsonFilters ??= {})[`${obj}.${pn}`] = { filter: basicJsonFilter(f, col ?? undefined), resolved: [f] };
          }
        }
      }
      visuals.push(v);
    }
    return {
      id: uid(),
      name: sec.displayName || `Pagina ${si + 1}`,
      visuals: (() => {
        const byName = new Map(groups.map((g) => [g.pbiName, g.id]));
        for (const [v, name] of groupOf) { const id = byName.get(name); if (id) v.group = id; }
        return visuals;
      })(),
      ...(groups.length ? { groups: groups.map(({ parentName, ...g }) => ({ ...g, ...(parentName && groups.some((x) => x.pbiName === parentName) ? { parent: groups.find((x) => x.pbiName === parentName)!.id } : {}) })) } : {}),
      filters: parseFilters(sec.filters, tables),
      ...(Object.keys(mobile).length ? { mobile } : {}),
      background: bgName ? resources[bgName] : undefined,
      ...(sec.width && sec.height && (sec.width !== PAGE_W || sec.height !== PAGE_H) ? { width: sec.width, height: sec.height } : {}),
      ...(typeof bgColor === 'string' ? { backgroundColor: bgColor } : {}),
      ...(typeof bgTransp === 'number' ? { backgroundTransparency: bgTransp } : {}),
      ...(bgFit === 'Fit' || bgFit === 'Fill' || bgFit === 'Normal' ? { backgroundFit: bgFit } : {}),
      ...(typeof wallColor === 'string' ? { wallpaper: wallColor } : {}),
      ...(refreshOn ? { autoRefresh: { seconds: Math.max(1, Math.round((refreshMs as number) / 1000)) } } : {}),
      ...(secCfg.visibility === 1 ? { hidden: true } : {}),
      ...(sec.name ? { pbiName: sec.name } : {}),
      ...(secCfg.type === 1 ? { tooltip: true } : {}),
      ...(() => {
        // Modifica interazioni: section config relationships [{source, target, type}] between visual names.
        const byName = new Map(visuals.filter((v) => v.pbiName).map((v) => [v.pbiName!, v.id]));
        const out: Record<string, Interaction> = {};
        for (const r of Array.isArray(secCfg.relationships) ? secCfg.relationships : []) {
          const a = byName.get(r?.source), b = byName.get(r?.target), m = INTERACTION_IN[r?.type];
          if (a && b && m) out[interactionKey(a, b)] = m;
        }
        return Object.keys(out).length ? { interactions: out } : {};
      })(),
      ...(() => {
        const pb = secCfg.pageBinding ?? sec.pageBinding;
        if (pb?.type !== 'Drillthrough' && pb?.type !== 0) return {};
        const fields = (pb.parameters ?? []).map((x: any) => exprToField(x.fieldExpr, {})).filter((f: FieldRef | null): f is FieldRef => !!f)
          .map((f: FieldRef) => ({ table: f.table, column: f.column, ...(f.datePart ? { datePart: f.datePart } : {}) }));
        return fields.length ? { drillthrough: { fields, ...(pb.acceptsFilterContext === 1 || secCfg.keepAllFilters ? { keepAll: true } : {}) } } : {};
      })(),
    };
  });
  for (const p of pages) for (const v of p.visuals) {
    if (v.format.tooltipPage) { const t = pages.find((x) => x.pbiName === v.format.tooltipPage); if (t) v.format.tooltipPage = t.id; else delete v.format.tooltipPage; }
  }
  return {
    pages: pages.length ? pages : [{ id: uid(), name: 'Pagina 1', visuals: [], filters: [] }],
    reportFilters: parseFilters(layout.filters, tables), skipped,
    bookmarks: parseBookmarks(json(layout.config).bookmarks, pages, tables),
    ...(json(layout.config).settings?.defaultFilterActionIsDataFilter ? { filterByDefault: true } : {}),
  };
}

/** Bookmarks of Report/Layout config (with bookmark groups) → MiB-BI bookmarks. */
function parseBookmarks(list: unknown, pages: Page[], tables: TableMeta[]): Bookmark[] {
  if (!Array.isArray(list)) return [];
  const out: Bookmark[] = [];
  const add = (b: any, group?: string) => {
    if (Array.isArray(b?.children)) { for (const c of b.children) add(c, b.displayName); return; }
    const es = b?.explorationState ?? {};
    const page = pages.find((p) => p.pbiName === es.activeSection);
    // Visual names are only unique within a page (copied pages reuse them).
    const visual = new Map<string, Visual>((page?.visuals ?? []).filter((v) => v.pbiName).map((v) => [v.pbiName!, v]));
    const o = b?.options ?? {};
    const sec = es.sections?.[es.activeSection] ?? {};
    const targets = o.applyOnlyToTargetVisuals && Array.isArray(o.targetVisualNames) ? o.targetVisualNames.map((n: string) => visual.get(n)?.id).filter(Boolean) : undefined;
    const hidden: string[] = [], slicers: Record<string, string[]> = {};
    for (const [name, st] of Object.entries<any>(sec.visualContainers ?? {})) {
      const v = visual.get(name);
      if (!v || (targets && !targets.includes(v.id))) continue;
      if (st?.singleVisual?.display?.mode === 'hidden') hidden.push(v.id);
      const f = st?.singleVisual?.objects?.merge?.general?.[0]?.properties?.filter?.filter;
      if (v.type === 'slicer' && f) { const c = parseCondition(f, tables); slicers[v.id] = c?.values ?? []; }
    }
    const hiddenGroups = Object.entries<any>(sec.visualContainerGroups ?? {}).filter(([, g]) => g?.isHidden)
      .map(([name]) => page?.groups?.find((g) => g.pbiName === name)?.id).filter((x): x is string => !!x);
    const byExpr = (x: any) => (Array.isArray(x?.byExpr) ? x.byExpr.map((f: any) => parseCondition(f.filter, tables)).filter((f: Filter | null): f is Filter => !!f) : undefined);
    out.push({
      id: uid(), name: b?.displayName || 'Segnalibro', pbiName: b?.name, ...(group ? { group } : {}), ...(page ? { page: page.id } : {}),
      applyData: !o.suppressData, applyDisplay: !o.suppressDisplay, applyPage: !o.suppressActiveSection,
      ...(targets ? { targets } : {}),
      state: { hidden, hiddenGroups, reportFilters: byExpr(es.filters), pageFilters: byExpr(sec.filters), slicers },
    });
  };
  for (const b of list) add(b);
  return out;
}

/* -------------------------------- export -------------------------------- */

const L = (v: string) => ({ expr: { Literal: { Value: v } } });
const Ls = (s: string) => L(`'${s.replace(/'/g, "''")}'`);

/** Mobile layout position of a visual (layouts entry with id 1). */
const mobileLayout = (p: Page, v: Visual) => {
  const g = p.mobile?.[v.id];
  return g ? [{ id: 1, position: { x: g.x, y: g.y, z: v.z * 1000, width: g.w, height: g.h } }] : [];
};

/** Filters on a date level target the level of the automatic date hierarchy (when exported with date tables). */
let DATE_HIER = true;
/** Tables marked as date table: their date columns have no automatic date hierarchy in the model. */
let NO_VAR = new Set<string>();
/** User hierarchies of the model by "table\u0001hierarchy" (a field exports as HierarchyLevel only if its column is still a level). */
let USER_HIER = new Map<string, Hierarchy>();
const dh = (f: { table: string }) => DATE_HIER && !NO_VAR.has(f.table);
function filterJson(f: Filter, name: string) {
  const level = f.datePart && dh(f) ? f.datePart : undefined;
  const lit = (v: string) => (v === NULL_KEY ? 'null' : level === 'year' || level === 'day' ? `${Number(v)}L` : `'${v.replace(/'/g, "''")}'`);
  const values = f.values.map((v) => [{ Literal: { Value: lit(v) } }]);
  const col = (src: any) => (level ? levelExpr(src, f.column, level) : { Column: { Expression: src, Property: f.column } });
  return {
    name,
    expression: col({ SourceRef: { Entity: f.table } }),
    filter: {
      Version: 2,
      From: [{ Name: 't', Entity: f.table, Type: 0 }],
      Where: [{ Condition: { In: { Expressions: [col({ SourceRef: { Source: 't' } })], Values: values } } }],
    },
    type: 'Categorical',
    howCreated: 1,
  };
}

const hex = () => Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** MiB-BI report → Report/Layout JSON + image resources to package. */
/** Custom theme referenced by a Report/Layout (themeCollection.customTheme → RegisteredResources). */
export function themeFromLayout(layoutJson: string, resources: Record<string, string>): Theme | undefined {
  try {
    const cfg = JSON.parse(JSON.parse(layoutJson).config ?? '{}');
    const name: string | undefined = cfg.themeCollection?.customTheme?.name;
    const url = name ? resources[name] : undefined;
    if (!url) return undefined;
    const text = decodeURIComponent(escape(atob(url.split(',')[1])));
    return parseTheme(text, name!.replace(/\.json$/i, ''));
  } catch {
    return undefined;
  }
}

/** Stable Power BI names, so bookmarks and buttons keep pointing at the same pages and visuals. */
const vname = (v: Visual) => v.pbiName ?? (v.id + '00000000000000000000').slice(0, 20);
export const sname = (p: Page) => p.pbiName ?? 'ReportSection' + p.id;
/** Bookmark name in the file (target of bookmark buttons). */
export const bname = (b: { id: string; pbiName?: string }) => b.pbiName ?? 'Bookmark' + b.id;
const gname = (g: VisualGroup) => g.pbiName ?? ('g' + g.id + '0000000000000000000').slice(0, 20);

/** MiB-BI bookmarks → Report/Layout config.bookmarks (explorationState). */
function bookmarksJson(bookmarks: Bookmark[], pages: Page[]) {
  const one = (b: Bookmark) => {
    const page = pages.find((p) => p.id === b.page) ?? pages[0];
    const visualContainers: Record<string, unknown> = {};
    for (const v of page.visuals) {
      if (b.targets && !b.targets.includes(v.id)) continue;
      const sv: any = {};
      if (b.state.hidden.includes(v.id)) sv.display = { mode: 'hidden' };
      if (v.type === 'slicer' && b.state.slicers?.[v.id]?.length && v.fields.category?.[0]) {
        const f = v.fields.category[0];
        sv.objects = { merge: { general: [{ properties: { filter: { filter: filterJson({ id: '', table: f.table, column: f.column, values: b.state.slicers[v.id] }, '').filter } } }] } };
      }
      visualContainers[vname(v)] = { singleVisual: sv };
    }
    const visualContainerGroups = Object.fromEntries((page.groups ?? []).map((g) => [gname(g), { isHidden: b.state.hiddenGroups.includes(g.id) }]));
    const byExpr = (fs?: Filter[]) => ({ byExpr: (fs ?? []).filter((f) => f.values.length).map((f) => filterJson(f, hex())) });
    return {
      displayName: b.name, name: bname(b),
      explorationState: {
        version: '1.3', activeSection: sname(page), filters: byExpr(b.state.reportFilters),
        sections: { [sname(page)]: { visualContainers, visualContainerGroups, filters: byExpr(b.state.pageFilters) } },
      },
      options: {
        ...(b.applyData ? {} : { suppressData: true }), ...(b.applyDisplay ? {} : { suppressDisplay: true }), ...(b.applyPage ? {} : { suppressActiveSection: true }),
        ...(b.targets ? { targetVisualNames: page.visuals.filter((v) => b.targets!.includes(v.id)).map(vname), applyOnlyToTargetVisuals: true } : {}),
      },
    };
  };
  // Consecutive bookmarks of the same group become a bookmark group.
  const out: any[] = [];
  for (const b of bookmarks) {
    const last = out[out.length - 1];
    if (b.group && last?.children && last.displayName === b.group) last.children.push(one(b));
    else if (b.group) out.push({ displayName: b.group, name: 'Bookmark' + hex(), children: [one(b)] });
    else out.push(one(b));
  }
  return out;
}

/** `dateHierarchies`: date levels as HierarchyLevel of the automatic date tables (false: plain date column). */
export function buildLayout(pages: Page[], reportFilters: Filter[], theme?: Theme, bookmarks: Bookmark[] = [], opts: { dateHierarchies?: boolean; dateTables?: string[]; hierarchies?: Hierarchy[]; filterByDefault?: boolean } = {}): { layout: string; resources: Record<string, string> } {
  DATE_HIER = opts.dateHierarchies !== false;
  NO_VAR = new Set(opts.dateTables ?? []);
  USER_HIER = new Map((opts.hierarchies ?? []).map((h) => [`${h.table}\u0001${h.name}`, h]));
  const resources: Record<string, string> = {};
  const addResource = (dataUrl: string) => {
    const m = /^data:image\/(\w+)/.exec(dataUrl);
    const name = `image${Object.keys(resources).length + 1}${hex().slice(0, 8)}.${m?.[1] === 'jpeg' ? 'jpg' : m?.[1] ?? 'png'}`;
    resources[name] = dataUrl;
    return name;
  };

  const sections = pages.map((p, i) => {
    const containers = p.visuals.filter((v) => v.type !== 'unsupported' || v.style?.raw).map((v, vi) => {
      if (v.type === 'unsupported') {
        // Not rendered by MiB-BI (custom visuals, Q&A…): written back unchanged at its current position.
        const config = { name: vname(v), layouts: [{ id: 0, position: { x: v.x, y: v.y, z: v.z * 1000, width: v.w, height: v.h, tabOrder: vi * 1000 } }, ...mobileLayout(p, v)], singleVisual: v.hidden ? { ...(v.style!.raw as object), display: { mode: 'hidden' } } : v.style!.raw, ...(v.group ? { parentGroupName: gname(p.groups!.find((g) => g.id === v.group)!) } : {}) };
        return { x: v.x, y: v.y, z: v.z * 1000, width: v.w, height: v.h, config: JSON.stringify(config), filters: '[]' };
      }
      const def = visualDef(v.type, v.custom);
      const roles = v.type === 'custom' ? def.wells.map((w) => [w.key, w.key]) : Object.entries(roleMap(v.type));
      const entities = [...new Set(Object.values(v.fields).flat().filter((f) => f.agg !== 'visualCalc').map((f) => f.table))];
      const alias: Record<string, string> = {};
      entities.forEach((e, ei) => (alias[e] = (e[0] ?? 't').toLowerCase().replace(/[^a-z]/, 't') + (ei || '')));
      const select: any[] = [];
      const nameByKey = new Map<string, string>();
      const projections: Record<string, { queryRef: string; active?: boolean; hidden?: boolean; nativeQueryRef?: string; format?: string }[]> = {};
      for (const w of def.wells) {
        const role = roles.find(([, well]) => well === w.key)?.[0];
        if (!role) continue;
        // Date hierarchy levels go out as the plain date column (the .pbit model has no auto date tables).
        // Without date tables, date hierarchy levels go out once as the plain date column.
        const seenDate = new Set<string>();
        for (const f of (v.fields[w.key] ?? []).filter((x) => !x.datePart || dh(x) || (!seenDate.has(x.table + '.' + x.column) && seenDate.add(x.table + '.' + x.column)))) {
          const src = { SourceRef: { Source: alias[f.table] } };
          let expr: any, name: string;
          if (f.agg === 'visualCalc') { expr = { NativeVisualCalculation: { Language: 'dax', Expression: f.calc ?? '', Name: f.column } }; name = f.column; }
          else if (f.agg === 'measure') { expr = { Measure: { Expression: src, Property: f.column } }; name = `${f.table}.${f.column}`; }
          else if (f.agg === 'none' && f.datePart && dh(f)) { expr = levelExpr(src, f.column, f.datePart); name = `${f.table}.${f.column}.Variation.${DATE_HIERARCHY}.${DATE_LEVEL[f.datePart]}`; }
          else if (f.agg === 'none' && !f.datePart && f.hierarchy && USER_HIER.get(`${f.table}\u0001${f.hierarchy}`)?.levels.includes(f.column)) {
            // Level of a user hierarchy (Power BI keeps the hierarchy in the visual, not the plain column).
            const level = levelName(USER_HIER.get(`${f.table}\u0001${f.hierarchy}`)!, f.column);
            expr = { HierarchyLevel: { Expression: { Hierarchy: { Expression: src, Hierarchy: f.hierarchy } }, Level: level } };
            name = `${f.table}.${f.hierarchy}.${level}`;
          }
          else if (f.agg === 'none') { expr = { Column: { Expression: src, Property: f.column } }; name = `${f.table}.${f.column}`; }
          else {
            const [fn, label] = AGG_OUT[f.agg]!;
            expr = { Aggregation: { Expression: { Column: { Expression: src, Property: f.column } }, Function: fn } };
            name = `${label}(${f.table}.${f.column})`;
          }
          if (!select.some((s) => s.Name === name)) select.push({ ...expr, Name: name });
          nameByKey.set(fieldKey(f), name);
          // Drill hierarchy: only the current level is active (Power BI's drill state); single fields are active.
          const list = v.fields[w.key] ?? [];
          const active = list.length < 2 || !w.hierarchy || (f.datePart && !dh(f)) || list.indexOf(f) === Math.min(v.drill?.level ?? 0, list.length - 1);
          // nativeQueryRef: the name visual calculations use for the field.
          (projections[role] ??= []).push({ queryRef: name, nativeQueryRef: refLabel(f), ...((role === 'Category' || role === 'Rows') && active ? { active: true } : {}),
            ...(f.hidden ? { hidden: true } : {}), ...(f.agg === 'visualCalc' && f.format ? { format: f.format } : {}) });
        }
      }
      // Imported formatting is kept; MiB-BI's own settings overwrite their properties.
      const objects: any = structuredClone(v.style?.objects ?? {});
      const vcObjects: any = structuredClone(v.style?.vcObjects ?? {});
      const put = (objs: any, obj: string, props: Record<string, unknown>) => {
        const list: any[] = (objs[obj] ??= []);
        let e = list.find((x) => !x.selector);
        if (!e) { e = { properties: {} }; list.unshift(e); }
        e.properties = { ...(e.properties ?? {}), ...props };
      };
      const color = (c: string) => ({ solid: { color: Ls(c) } });
      const fm = v.format;
      put(vcObjects, 'title', {
        show: L(String(fm.titleShow)), ...(fm.titleText ? { text: Ls(fm.titleText) } : {}),
        ...(fm.titleColor ? { fontColor: color(fm.titleColor) } : {}), ...(fm.titleAlign ? { alignment: Ls(fm.titleAlign) } : {}),
        ...(fm.titleFont ? { fontFamily: Ls(fm.titleFont) } : {}), ...(fm.titleBg ? { background: color(fm.titleBg) } : {}),
        ...(fm.titleBold !== undefined ? { bold: L(String(fm.titleBold)) } : {}), fontSize: L(`${Math.round(fm.titleSize * 0.75 * 10) / 10}D`),
      });
      const tp = fm.tooltipPage ? pages.find((x) => x.id === fm.tooltipPage) : undefined;
      if (tp) put(vcObjects, 'visualTooltip', { show: L('true'), section: Ls(sname(tp)) });
      else if (vcObjects.visualTooltip) for (const e of vcObjects.visualTooltip) delete e.properties?.section;
      if (fm.background === 'transparent') put(vcObjects, 'background', { show: L('false') });
      else put(vcObjects, 'background', { show: L('true'), color: color(fm.background), transparency: L(`${fm.bgTransparency ?? 0}D`) });
      if (fm.border) put(vcObjects, 'border', { show: L('true'), ...(fm.borderColor ? { color: color(fm.borderColor) } : {}), ...(fm.borderRadius !== undefined ? { radius: L(`${fm.borderRadius}D`) } : {}) });
      else if (vcObjects.border || (fm.border === false && THEME.border)) put(vcObjects, 'border', { show: L('false') });
      if (isChartType(v.type)) {
        put(objects, 'legend', { show: L(String(fm.legendShow)) });
        put(objects, 'labels', { show: L(String(fm.dataLabels)) });
        if (fm.color && fm.color !== '#118DFF') put(objects, 'dataPoint', { fill: color(fm.color) });
        if (fm.axisType) put(objects, 'categoryAxis', { axisType: Ls(fm.axisType === 'continuous' ? 'Scalar' : 'Categorical') });
      }
      if ((v.type === 'pythonVisual' || v.type === 'rVisual') && v.script !== undefined) put(objects, 'script', { source: Ls(v.script), provider: Ls(v.type === 'rVisual' ? 'R' : 'Python') });
      if (v.type === 'qna' && v.qna?.question) put(objects, 'hiddenProperties', { savedUtterance: Ls(v.qna.question) });
      if (v.type === 'textbox') {
        const same = (objects.general?.[0]?.properties?.paragraphs ?? []).map((p: any) => (p.textRuns ?? []).map((r: any) => r.value ?? '').join('')).join('\n') === (v.text ?? '');
        if (!same) put(objects, 'general', { paragraphs: (v.text ?? '').split('\n').map((t) => ({ textRuns: [{ value: t }] })) });
      }
      if (v.type === 'image' && v.image) {
        put(objects, 'general', { imageUrl: { expr: { ResourcePackageItem: { PackageName: 'RegisteredResources', PackageType: 1, ItemName: addResource(v.image) } } } });
      }
      if (v.type === 'slicer') exportSlicer(v, objects, put);
      if (v.type === 'custom') {
        for (const [key, x] of Object.entries<any>(v.jsonFilters ?? {})) {
          const [obj, pn] = key.split('.');
          const f: Filter | undefined = x?.resolved?.[0];
          if (obj && pn && f?.values.length) put(objects, obj, { [pn]: { filter: filterJson(f, '').filter } });
        }
      }
      exportCondFormat(v, objects, (f) => nameByKey.get(fieldKey(f)), (a) => AGG_OUT[a]?.[0], isChartType(v.type) || v.type === 'filledMap' || v.type === 'map', CF_RANGES.get(v.id));
      if (isChartType(v.type)) exportAnalytics(v.format.analytics, objects, (k) => nameByKey.get(k));
      const flat = def.wells.flatMap((w) => v.fields[w.key] ?? []);
      const sortField = v.format.sortBy !== undefined ? flat[v.format.sortBy] : undefined;
      const sortSel = sortField ? select.find((s) => (s.Column ?? s.Measure ?? s.Aggregation?.Expression?.Column)?.Property === sortField.column) : undefined;
      const parent = v.group ? p.groups?.find((g) => g.id === v.group) : undefined;
      const config = {
        name: vname(v),
        layouts: [{ id: 0, position: { x: v.x, y: v.y, z: v.z * 1000, width: v.w, height: v.h, tabOrder: vi * 1000 } }, ...mobileLayout(p, v)],
        ...(parent ? { parentGroupName: gname(parent) } : {}),
        singleVisual: {
          ...(v.hidden ? { display: { mode: 'hidden' } } : {}),
          // Same Power BI type as imported when it maps to this MiB-BI type (cardVisual, advancedSlicerVisual, shape…).
          visualType: v.type === 'custom' ? v.custom : v.type === 'slicer' ? slicerType(v) : v.style?.pbiType && TYPE_IN[v.style.pbiType] === v.type ? v.style.pbiType : TYPE_OUT[v.type],
          projections,
          prototypeQuery: {
            Version: 2,
            From: entities.map((e) => ({ Name: alias[e], Entity: e, Type: 0 })),
            Select: select,
            ...(sortSel ? { OrderBy: [{ Direction: v.format.sortDir === 'asc' ? 1 : 2, Expression: Object.fromEntries(Object.entries(sortSel).filter(([k]) => k !== 'Name')) }] } : {}),
          },
          drillFilterOtherVisuals: true,
          ...(v.syncGroup ? { syncGroup: { groupName: v.syncGroup.name, fieldChanges: v.syncGroup.fieldChanges !== false, filterChanges: v.syncGroup.filterChanges !== false } } : {}),
          objects,
          vcObjects,
        },
      };
      return {
        x: v.x, y: v.y, z: v.z * 1000, width: v.w, height: v.h,
        config: JSON.stringify(config),
        filters: JSON.stringify((v.filters ?? []).filter((f) => f.values.length).map((f) => filterJson(f, hex()))),
      };
    });
    const secConfig: any = { objects: {} };
    const bgProps: any = {};
    if (p.background) bgProps.image = { image: { name: L("'background'"), url: { expr: { ResourcePackageItem: { PackageName: 'RegisteredResources', PackageType: 1, ItemName: addResource(p.background) } } }, scaling: Ls(p.backgroundFit ?? 'Fit') } };
    if (p.backgroundColor) bgProps.color = { solid: { color: Ls(p.backgroundColor) } };
    if (p.backgroundTransparency !== undefined) bgProps.transparency = L(`${p.backgroundTransparency}D`);
    if (Object.keys(bgProps).length) secConfig.objects.background = [{ properties: bgProps }];
    if (p.wallpaper) secConfig.objects.outspace = [{ properties: { color: { solid: { color: Ls(p.wallpaper) } } } }];
    // Aggiornamento automatico pagina (fixed interval; duration in milliseconds).
    if (p.autoRefresh) secConfig.objects.pageRefresh = [{ properties: { show: L('true'), duration: L(`${p.autoRefresh.seconds * 1000}D`) } }];
    if (p.hidden) secConfig.visibility = 1;
    const rels = Object.entries(p.interactions ?? {}).map(([k, m]) => {
      const [a, b] = k.split('>').map((id) => p.visuals.find((x) => x.id === id));
      return a && b ? { source: vname(a), target: vname(b), type: INTERACTION_OUT[m] } : null;
    }).filter(Boolean);
    if (rels.length) secConfig.relationships = rels;
    if (p.tooltip) secConfig.type = 1;
    const dtFilters: any[] = [];
    if (p.drillthrough?.fields.length) {
      secConfig.pageBinding = {
        name: 'Pod' + hex().slice(0, 8), type: 'Drillthrough', ...(p.drillthrough.keepAll ? { acceptsFilterContext: 1 } : {}),
        parameters: p.drillthrough.fields.map((f, i) => {
          dtFilters.push({ name: `DrillFilter${i}`, expression: { Column: { Expression: { SourceRef: { Entity: f.table } }, Property: f.column } }, type: 'Categorical', howCreated: 5 });
          return { name: `Param_DrillFilter${i}`, boundFilter: `DrillFilter${i}`, fieldExpr: { Column: { Expression: { SourceRef: { Entity: f.table } }, Property: f.column } } };
        }),
      };
    }
    return {
      name: sname(p), displayName: p.name, ordinal: i, displayOption: 1, width: p.width ?? PAGE_W, height: p.height ?? PAGE_H,
      config: JSON.stringify(secConfig),
      filters: JSON.stringify([...p.filters.filter((f) => f.values.length && !f.drillthrough).map((f) => filterJson(f, hex())), ...dtFilters]),
      // Groups are containers too (singleVisualGroup), placed around their members.
      visualContainers: [...containers, ...(p.groups ?? []).map((g, gi) => {
        const members = p.visuals.filter((v) => v.group === g.id);
        const x = members.length ? Math.min(...members.map((v) => v.x)) : 0, y = members.length ? Math.min(...members.map((v) => v.y)) : 0;
        const w = members.length ? Math.max(...members.map((v) => v.x + v.w)) - x : 1, h = members.length ? Math.max(...members.map((v) => v.y + v.h)) - y : 1;
        const parent = g.parent ? p.groups!.find((q) => q.id === g.parent) : undefined;
        const config = { name: gname(g), layouts: [{ id: 0, position: { x, y, z: 0, width: w, height: h, tabOrder: (containers.length + gi) * 1000 } }], singleVisualGroup: { displayName: g.name, groupMode: 0, ...(g.hidden ? { isHidden: true } : {}) }, ...(parent ? { parentGroupName: gname(parent) } : {}) };
        return { x, y, z: 0, width: w, height: h, config: JSON.stringify(config), filters: '[]' };
      })],
    };
  });

  let themeName: string | undefined;
  if (theme) {
    themeName = `${theme.name.replace(/[^\w -]/g, '_')}${Date.now().toString(36)}.json`;
    resources[themeName] = 'data:application/json;base64,' + btoa(unescape(encodeURIComponent(themeJson(theme))));
  }
  const layout = {
    id: 0,
    resourcePackages: Object.keys(resources).length ? [{
      // 202 = custom theme, 100 = image.
      resourcePackage: { name: 'RegisteredResources', type: 1, items: Object.keys(resources).map((n) => ({ type: n === themeName ? 202 : 100, path: n, name: n })), disabled: false },
    }] : [],
    sections,
    config: JSON.stringify({ version: '5.43', themeCollection: themeName ? { customTheme: { name: themeName, version: '5.43', type: 2 } } : {}, activeSectionIndex: 0, defaultDrillFilterOtherVisuals: true, linguisticSchemaSyncVersion: 0, settings: { useNewFilterPaneExperience: true, allowChangeFilterTypes: true, ...(opts.filterByDefault ? { defaultFilterActionIsDataFilter: true } : {}) }, objects: {}, ...(bookmarks.length ? { bookmarks: bookmarksJson(bookmarks, pages) } : {}) }),
    filters: JSON.stringify(reportFilters.filter((f) => f.values.length).map((f) => filterJson(f, hex()))),
    layoutOptimization: 0,
  };
  return { layout: JSON.stringify(layout), resources };
}

/* ------------------------------- slicers -------------------------------- */

const REL_PERIOD_IN: Record<string, [RelativeSlicer['unit'], boolean]> = {
  Days: ['days', false], Weeks: ['weeks', false], 'Calendar Weeks': ['weeks', true], Months: ['months', false],
  'Calendar Months': ['months', true], Years: ['years', false], 'Calendar Years': ['years', true], Minutes: ['minutes', false], Hours: ['hours', false],
};
const TEXT_MODE: Record<string, NonNullable<VisualFormat['slicerTextMode']>> = {
  Filter_Contains_All: 'contains', Filter_Contains_Any: 'contains', Filter_Does_Not_Contain_Any: 'notContains', Filter_Starts_With_Any: 'startsWith',
  Filter_Does_Not_Start_With_Any: 'notStartsWith', Filter_Is_Any: 'is', Filter_Is_Not_Any: 'isNot',
};

/** Slicer style and selection settings (data.mode, general.orientation/selfFilterEnabled, selection.*). */
function importSlicerFormat(pbiType: string, objects: any, format: VisualFormat) {
  const data = prop(objects, 'data'), gen = prop(objects, 'general'), sel = prop(objects, 'selection');
  const mode = litText(data.mode);
  if (pbiType === 'advancedSlicerVisual') format.slicerStyle = 'tile';
  else if (pbiType === 'textSlicer') {
    format.slicerStyle = 'text';
    const m = TEXT_MODE[litText(prop(objects, 'dropdown').filterMode) ?? ''];
    if (m && m !== 'contains') format.slicerTextMode = m;
  } else if (pbiType === 'listSlicer') format.slicerStyle = litBool(data.dropdownMode) ? 'dropdown' : 'list';
  else if (mode === 'Dropdown') format.slicerStyle = 'dropdown';
  else if (mode === 'HorizontalList' || (mode !== 'VerticalList' && decode(gen.orientation) === 1)) format.slicerStyle = 'tile';
  else if (mode === 'Between' || mode === 'RelativeDatePicker') format.slicerStyle = 'between';
  else if (mode === 'Before') format.slicerStyle = 'before';
  else if (mode === 'After') format.slicerStyle = 'after';
  else if (mode === 'Relative') format.slicerStyle = 'relativeDate';
  else if (mode === 'RelativeTime') format.slicerStyle = 'relativeTime';
  else if (mode === 'Single') format.slicerStyle = 'slider';
  if (litBool(sel.singleSelect) || litBool(sel.strictSingleSelect)) format.slicerSingle = true;
  // Power BI shows "Seleziona tutto" only when enabled.
  if (pbiType !== 'textSlicer') { if (litBool(sel.selectAllCheckboxEnabled) !== true) format.slicerSelectAll = false; }
  if (litBool(gen.selfFilterEnabled)) format.slicerSearch = true;
}

/** Range bounds and relative period kept in the slicer's data object. */
function importSlicerState(v: Visual, objects: any) {
  const data = prop(objects, 'data');
  const style = v.format.slicerStyle;
  if (style === 'between' || style === 'before' || style === 'after') {
    const d = (x: any) => { const t = lit(x); const m = t && /^datetime'(.*)'$/.exec(t); return m ? m[1].slice(0, 10) : undefined; };
    const n = (x: any) => { const t = decode(x); return typeof t === 'number' ? String(t) : undefined; };
    const min = d(data.startDate) ?? n(data.numericStart), max = d(data.endDate) ?? n(data.numericEnd);
    if (min || max) v.slicerRange = { ...(min ? { min } : {}), ...(max ? { max } : {}) };
  }
  if (style === 'text') {
    // Contains / StartsWith / Comparison Equal, optionally under Not.
    let c = prop(objects, 'general').filter?.filter?.Where?.[0]?.Condition;
    const neg = !!c?.Not;
    if (neg) c = c.Not.Expression;
    const kind = c?.Contains ? 'contains' : c?.StartsWith ? 'startsWith' : c?.Comparison?.ComparisonKind === 0 ? 'is' : null;
    const val = litText({ expr: (c?.Contains ?? c?.StartsWith ?? c?.Comparison)?.Right });
    if (kind && val) {
      v.slicerText = val;
      const m = (neg ? { contains: 'notContains', startsWith: 'notStartsWith', is: 'isNot' } as const : { contains: 'contains', startsWith: 'startsWith', is: 'is' } as const)[kind];
      if (m !== 'contains') v.format.slicerTextMode = m; else delete v.format.slicerTextMode;
    }
  }
  if (style === 'relativeDate' || style === 'relativeTime') {
    const range = litText(data.relativeRange);
    const per = REL_PERIOD_IN[litText(style === 'relativeTime' ? data.relativeTimePeriod : data.relativePeriod) ?? ''];
    if (range && per) {
      const today = litBool(prop(objects, 'dateRange').includeToday);
      v.slicerRelative = { anchor: range === 'This' ? 'this' : range === 'Next' ? 'next' : 'last', n: Number(decode(data.relativeDuration)) || 1, unit: per[0],
        ...(per[1] ? { calendar: true } : {}), ...(today === false ? { includeToday: false } : {}) };
    }
  }
}

/** Comparison filter of a range slicer (Power BI advanced filter: ComparisonKind 2 = ≥, 4 = ≤, 3 = <). */
function rangeFilterJson(f: { table: string; column: string }, r: RangeCond) {
  const col = { Column: { Expression: { SourceRef: { Source: 't' } }, Property: f.column } };
  const val = (x: string) => ({ Literal: { Value: r.kind === 'number' ? `${Number(x)}D` : `datetime'${x.length <= 10 ? x + 'T00:00:00' : x.replace(' ', 'T')}'` } });
  const conds = [
    ...(r.min ? [{ Comparison: { ComparisonKind: 2, Left: col, Right: val(r.min) } }] : []),
    ...(r.max ? [{ Comparison: { ComparisonKind: r.maxExclusive ? 3 : 4, Left: col, Right: val(r.max) } }] : []),
  ];
  const cond = conds.length === 2 ? { And: { Left: conds[0], Right: conds[1] } } : conds[0];
  return { Version: 2, From: [{ Name: 't', Entity: f.table, Type: 0 }], Where: [{ Condition: cond }] };
}

const REL_PERIOD_OUT = (r: RelativeSlicer) => (r.unit === 'minutes' ? 'Minutes' : r.unit === 'hours' ? 'Hours' : (r.calendar ? 'Calendar ' : '') + r.unit[0].toUpperCase() + r.unit.slice(1));

/** Power BI slicer visual for the style: textSlicer for text, the imported new slicers while their style fits, else the classic slicer. */
function slicerType(v: Visual): string {
  const st = v.format.slicerStyle, pbi = v.style?.pbiType;
  if (st === 'text') return 'textSlicer';
  if (pbi === 'listSlicer' && (st === 'list' || st === 'dropdown')) return pbi;
  if (pbi === 'advancedSlicerVisual' && st === 'tile') return pbi;
  return 'slicer';
}

function exportSlicer(v: Visual, objects: any, put: (objs: any, obj: string, props: Record<string, unknown>) => void) {
  const f = v.fields.category?.[0];
  const st = v.format.slicerStyle;
  const pbi = slicerType(v);
  const MODE: Record<string, string> = { list: 'Basic', dropdown: 'Dropdown', tile: 'Basic', between: 'Between', before: 'Before', after: 'After', relativeDate: 'Relative', relativeTime: 'RelativeTime', slider: 'Single', text: 'Basic' };
  if (pbi === 'listSlicer') put(objects, 'data', { dropdownMode: L(String(st === 'dropdown')) });
  else if (pbi !== 'advancedSlicerVisual' && pbi !== 'textSlicer') {
    put(objects, 'data', { mode: Ls(MODE[st] ?? 'Basic') });
    put(objects, 'general', { orientation: L(st === 'tile' ? '1D' : '0D') });
  }
  if (pbi === 'textSlicer') {
    const m = Object.entries(TEXT_MODE).find(([k, x]) => x === (v.format.slicerTextMode ?? 'contains') && k !== 'Filter_Contains_All')?.[0];
    if (m) put(objects, 'dropdown', { filterMode: Ls(m) });
  }
  if (pbi !== 'textSlicer') {
    put(objects, 'selection', { singleSelect: L(String(!!v.format.slicerSingle)), selectAllCheckboxEnabled: L(String(v.format.slicerSelectAll !== false)) });
    put(objects, 'general', { selfFilterEnabled: L(String(!!v.format.slicerSearch)) });
  }
  const clear = () => { if (objects.general) for (const e of objects.general) delete e.properties?.filter; };
  if (!f) { clear(); return; }
  if ((st === 'between' || st === 'before' || st === 'after') && v.slicerRange) {
    const num = !/^\d{4}-\d{2}-\d{2}/.test(v.slicerRange.min ?? v.slicerRange.max ?? '');
    const r = v.slicerRange;
    const min = st === 'before' ? undefined : r.min, max = st === 'after' ? undefined : r.max;
    const dt = (x?: string) => (x ? L(`datetime'${x.slice(0, 10)}T00:00:00'`) : undefined);
    put(objects, 'data', num
      ? { ...(min ? { numericStart: L(`${Number(min)}D`) } : {}), ...(max ? { numericEnd: L(`${Number(max)}D`) } : {}) }
      : { ...(min ? { startDate: dt(min) } : {}), ...(max ? { endDate: dt(max) } : {}) });
    if (min || max) put(objects, 'general', { filter: { filter: rangeFilterJson(f, { min, max, kind: num ? 'number' : 'date' }) } });
    else clear();
    return;
  }
  if ((st === 'relativeDate' || st === 'relativeTime') && v.slicerRelative) {
    const r = v.slicerRelative;
    put(objects, 'data', { relativeRange: Ls(r.anchor === 'this' ? 'This' : r.anchor === 'next' ? 'Next' : 'Last'), relativeDuration: L(`${r.n}D`),
      [st === 'relativeTime' ? 'relativeTimePeriod' : 'relativePeriod']: Ls(REL_PERIOD_OUT(r)) });
    put(objects, 'dateRange', { includeToday: L(String(r.includeToday !== false)) });
    // The period is computed now (Power BI recomputes it from the settings above when the report opens).
    const p = relativePeriod(r);
    const ts = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
    put(objects, 'general', { filter: { filter: rangeFilterJson(f, { min: ts(p.start), max: ts(p.end), kind: 'datetime', maxExclusive: true }) } });
    return;
  }
  if (st === 'text') {
    const t = v.slicerText?.trim();
    if (!t) { clear(); return; }
    const m = v.format.slicerTextMode ?? 'contains';
    const col = { Column: { Expression: { SourceRef: { Source: 't' } }, Property: f.column } };
    const right = { Literal: { Value: `'${t.replace(/'/g, "''")}'` } };
    const pos = m === 'is' || m === 'isNot' ? { Comparison: { ComparisonKind: 0, Left: col, Right: right } } : m === 'startsWith' || m === 'notStartsWith' ? { StartsWith: { Left: col, Right: right } } : { Contains: { Left: col, Right: right } };
    const cond = m === 'notContains' || m === 'notStartsWith' || m === 'isNot' ? { Not: { Expression: pos } } : pos;
    put(objects, 'general', { filter: { filter: { Version: 2, From: [{ Name: 't', Entity: f.table, Type: 0 }], Where: [{ Condition: cond }] } } });
    return;
  }
  if (v.slicerValues?.length && ['list', 'dropdown', 'tile', 'slider'].includes(st)) put(objects, 'general', { filter: { filter: filterJson({ id: '', table: f.table, column: f.column, values: v.slicerValues }, '').filter } });
  else clear();
}
