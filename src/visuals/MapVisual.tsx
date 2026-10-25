// Map (bubbles) and filled map, on the bundled offline layers (no Bing/Azure Maps).
import { useEffect, useRef, useState } from 'react';
import * as echarts from 'echarts';
import type { CrossFilter, Visual } from '../types';
import type { VisualData } from './useVisualData';
import { fieldLabel, fmtAuto, fmtFull, PALETTE } from '../format';
import { NULL_KEY } from '../query';
import { useStore } from '../store';
import { geocode, LAYER_LABEL, loadLayer, type Geocoded, type PolyLayer } from '../geo/geocode';
import { sp } from './pbistyle';
import { scaleColor } from './condfmt';
import { THEME } from '../themes';

const registered = new Set<string>();

// Web Mercator, like the Bing base map (latitudes clamped).
const MERCATOR = {
  project: ([x, y]: number[]) => [(x / 180) * Math.PI, -Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, y)) * Math.PI) / 360))],
  unproject: ([x, y]: number[]) => [(x * 180) / Math.PI, (2 * Math.atan(Math.exp(-y)) - Math.PI / 2) * (180 / Math.PI)],
};

async function register(name: PolyLayer) {
  const l = await loadLayer(name);
  if (!registered.has(name)) { echarts.registerMap(name, l.fc as any); registered.add(name); }
  return l;
}

/** Bounding box of points with padding, as ECharts geo.boundingCoords ([[west, north], [east, south]]). */
function bounds(points: [number, number][]): [[number, number], [number, number]] | undefined {
  if (!points.length) return undefined;
  let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
  for (const [x, y] of points) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const px = Math.max(1, (e - w) * 0.15), py = Math.max(0.7, (n - s) * 0.15);
  return [[Math.max(-180, w - px), Math.min(84, n + py)], [Math.min(180, e + px), Math.max(-80, s - py)]];
}

/** Base map under bubbles: the most detailed layer that contains all points. */
function baseFor(g: Geocoded, points: [number, number][]): PolyLayer {
  if (g.layer !== 'cities' && g.layer !== 'postal' && g.layer !== 'world' && g.layer !== 'it-municipalities') return g.layer;
  const inItaly = points.length > 0 && points.every(([x, y]) => x > 6 && x < 19 && y > 35.4 && y < 47.2);
  if (inItaly) return 'it-regions';
  const inUS = points.length > 0 && points.every(([x, y]) => x > -170 && x < -60 && y > 18 && y < 72);
  return inUS ? 'us-states' : 'world';
}

export function MapVisual({ v, data, cross, onSelect }: { v: Visual; data: VisualData; cross: CrossFilter | null; onSelect: (c: string | null) => void }) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const cats = useRef<(string | null)[]>([]);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const [note, setNote] = useState<string | null>(null);
  const [postal, setPostal] = useState(false);
  const theme = useStore((s) => s.report.theme);

  useEffect(() => {
    const c = echarts.init(el.current!, undefined, { renderer: 'canvas' });
    chart.current = c;
    c.on('click', (p: any) => { const i = p.data?.idx; if (i !== undefined && i < cats.current.length) onSelectRef.current(cats.current[i]); });
    const ro = new ResizeObserver(() => c.resize());
    ro.observe(el.current!);
    return () => { ro.disconnect(); c.dispose(); };
  }, []);

  useEffect(() => {
    if (data.error || !chart.current) return;
    let live = true;
    (async () => {
      const f = v.format;
      const cat = data.items.find((i) => i.well === 'category');
      const leg = data.items.find((i) => i.well === 'legend');
      const lat = data.items.find((i) => i.well === 'lat');
      const lon = data.items.find((i) => i.well === 'lon');
      const val = data.items.find((i) => i.well === 'values');
      const filled = v.type === 'filledMap';
      const locs = cat ? data.rows.map((r) => r[cat.alias] as string) : [];
      // Power BI data category of the location column (imported from the model or set in Strumenti colonna).
      const category = cat ? useStore.getState().tables.find((t) => t.name === cat.field.table)?.dataCategory?.[cat.field.column] : undefined;
      const g = cat && !(lat && lon && !filled) ? await geocode(locs, cat.field.column, filled, category) : null;
      if (!live) return;
      const selected = cross && cross.visualId === v.id ? (cross.value === NULL_KEY ? null : cross.value) : undefined;
      const dim = (i: number) => selected !== undefined && cats.current[i] !== selected;
      cats.current = cat ? locs : [];
      const legends = leg ? [...new Set(data.rows.map((r) => r[leg.alias] as string | null))] : [null];
      const colorOf = (l: string | null) => (leg ? PALETTE[legends.indexOf(l) % PALETTE.length] : f.color.toUpperCase() === '#118DFF' ? PALETTE[0] : f.color);
      const fmt = (x: unknown) => (typeof x === 'number' ? fmtFull(x) : '');

      // Points (bubble map) or matched feature names (filled map).
      type Pt = { idx: number; coord: [number, number]; feature?: string; value: number | null; legend: string | null };
      const pts: Pt[] = [];
      data.rows.forEach((r, i) => {
        let coord: [number, number] | undefined;
        let feature: string | undefined;
        if (lat && lon && !filled && r[lat.alias] !== null && r[lon.alias] !== null) coord = [Number(r[lon.alias]), Number(r[lat.alias])];
        else if (g && cat) { const h = g.hits.get(r[cat.alias]); coord = h?.coord; feature = h?.feature; }
        if (coord && Number.isFinite(coord[0]) && Number.isFinite(coord[1])) pts.push({ idx: i, coord, feature, value: val ? Number(r[val.alias]) : null, legend: leg ? r[leg.alias] : null });
      });

      const layer: PolyLayer = filled ? ((g?.layer as PolyLayer) ?? 'world') : baseFor(g ?? { layer: 'cities', hits: new Map(), missing: [] }, pts.map((p) => p.coord));
      const lay = await register(layer);
      if (!live || !chart.current) return;
      setPostal(g?.layer === 'postal');
      const missing = g?.missing.length ?? 0;
      setNote(missing ? `${missing} ${missing === 1 ? 'posizione non trovata' : 'posizioni non trovate'} (${g!.missing.slice(0, 3).join(', ')}${missing > 3 ? '…' : ''}) · ${LAYER_LABEL[g!.layer]}` : null);

      const box = bounds(filled
        ? lay.fc.features.filter((x) => pts.some((p) => p.feature === x.properties.n)).map((x) => x.properties.c).concat(pts.map((p) => p.coord))
        : pts.map((p) => p.coord));
      const land = sp(v, 'mapStyles', 'mapTheme') === 'dark' ? '#3B3A39' : '#EDEBE9';
      const geo = {
        map: layer, roam: true, projection: MERCATOR, nameProperty: 'n',
        ...(box ? { boundingCoords: box } : {}),
        itemStyle: { areaColor: land, borderColor: '#FFFFFF', borderWidth: 0.6 },
        emphasis: { disabled: !filled, itemStyle: { areaColor: '#C8C6C4' }, label: { show: false } },
        select: { disabled: true }, label: { show: false }, silent: !filled,
        left: 0, right: 0, top: 0, bottom: 0,
      };
      const vals = pts.map((p) => p.value).filter((x): x is number => x !== null && Number.isFinite(x));
      const max = Math.max(1e-9, ...vals.map(Math.abs));
      let option: echarts.EChartsCoreOption;
      if (filled) {
        // Color saturation: gradient from light to the default color; legend: one color per value.
        // Colors go through geo.regions (a map series bound to a geo ignores per-item styles).
        const base = colorOf(null);
        const byFeature = new Map<string, Pt>();
        for (const p of pts) if (p.feature && !byFeature.has(p.feature)) byFeature.set(p.feature, p);
        const range = vals.length ? { min: Math.min(...vals), max: Math.max(...vals) } : null;
        const fill = (p: Pt) => (leg ? colorOf(p.legend) : val && range && p.value !== null ? scaleColor(v.format.colorScale ?? { min: '#DEEFFF', max: base }, range, p.value) : base);
        const regions = [...byFeature.values()].map((p) => ({
          name: p.feature, itemStyle: { areaColor: fill(p), opacity: dim(p.idx) ? 0.35 : 1 }, emphasis: { itemStyle: { areaColor: fill(p), opacity: 0.8 } },
        }));
        option = {
          textStyle: { fontFamily: THEME.text.label.font }, animation: false, geo: { ...geo, regions },
          tooltip: { trigger: 'item', confine: true, formatter: (p: any) => p.data ? `${p.name}${leg ? `<br/>${fieldLabel(leg.field)}: ${p.data.legend ?? '(Vuoto)'}` : ''}${val ? `<br/>${fieldLabel(val.field)}: <b>${fmt(p.value)}</b>` : ''}` : p.name },
          legend: { show: f.legendShow && !!leg, type: 'scroll', top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: THEME.axis.size, color: THEME.axis.color }, data: leg ? legends.map((l) => l ?? '(Vuoto)') : [] },
          series: [{
            type: 'map', geoIndex: 0, nameProperty: 'n', name: 'map',
            data: [...byFeature.values()].map((p) => ({ name: p.feature, value: p.value ?? 0, idx: p.idx, legend: p.legend })),
          }, ...(leg ? legends.map((l) => ({ type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, name: l ?? '(Vuoto)', color: colorOf(l), data: [] })) : [])],
        };
      } else if (leg && cat && !(lat && lon)) {
        // Location + legend: one pie per location (slices = legend values), sized by the location total.
        type Slice = { legend: string | null; value: number; idx: number };
        const byLoc = new Map<string, { coord: [number, number]; slices: Slice[]; idx: number; loc: string }>();
        for (const p of pts) {
          const loc = data.rows[p.idx][cat.alias] as string;
          const e = byLoc.get(loc) ?? { coord: p.coord, slices: [], idx: p.idx, loc };
          e.slices.push({ legend: p.legend, value: Math.abs(p.value ?? 1), idx: p.idx });
          byLoc.set(loc, e);
        }
        const locs = [...byLoc.values()];
        const tot = (e: { slices: Slice[] }) => e.slices.reduce((a, s) => a + s.value, 0);
        const maxTot = Math.max(1e-9, ...locs.map(tot));
        option = {
          textStyle: { fontFamily: THEME.text.label.font }, animation: false, geo,
          legend: { show: f.legendShow, type: 'scroll', top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: THEME.axis.size, color: THEME.axis.color }, backgroundColor: 'rgba(255,255,255,.8)', data: legends.map((l) => l ?? '(Vuoto)') },
          tooltip: { trigger: 'item', confine: true, formatter: (p: any) => { const e = locs[p.dataIndex]; return `<b>${e.loc}</b>` + e.slices.map((s) => `<br/>${s.legend ?? '(Vuoto)'}: ${fmt(s.value)}`).join(''); } },
          series: [{
            type: 'custom', coordinateSystem: 'geo', geoIndex: 0, name: 'pies',
            data: locs.map((e) => ({ value: e.coord, idx: e.idx })),
            renderItem: (params: any, api: any) => {
              const e = locs[params.dataIndex];
              const [x, y] = api.coord(e.coord);
              const r = (val ? 4 + 18 * Math.sqrt(tot(e) / maxTot) : 8);
              const sum = tot(e) || 1;
              let a = -Math.PI / 2;
              return {
                type: 'group', children: e.slices.map((s) => {
                  const b = a + (s.value / sum) * Math.PI * 2;
                  const sh = { type: 'sector', shape: { cx: x, cy: y, r, r0: 0, startAngle: a, endAngle: b }, style: { fill: colorOf(s.legend), stroke: '#FFFFFF', lineWidth: 0.6, opacity: dim(s.idx) ? 0.25 : 0.9 } };
                  a = b;
                  return sh;
                }),
              };
            },
          }, ...legends.map((l) => ({ type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, name: l ?? '(Vuoto)', color: colorOf(l), data: [] }))],
        };
      } else {
        option = {
          textStyle: { fontFamily: THEME.text.label.font }, animation: false, geo,
          legend: { show: f.legendShow && !!leg, type: 'scroll', top: 0, left: 0, icon: 'circle', itemWidth: 8, itemHeight: 8, textStyle: { fontSize: THEME.axis.size, color: THEME.axis.color }, backgroundColor: 'rgba(255,255,255,.8)' },
          tooltip: { trigger: 'item', confine: true, formatter: (p: any) => `${cat ? p.data.loc ?? '' : `${p.data.value[1]}, ${p.data.value[0]}`}${leg ? `<br/>${fieldLabel(leg.field)}: ${p.seriesName}` : ''}${val ? `<br/>${fieldLabel(val.field)}: <b>${fmt(p.data.v)}</b>` : ''}` },
          series: legends.map((l) => ({
            type: 'scatter', coordinateSystem: 'geo', geoIndex: 0, name: l ?? '(Vuoto)', color: colorOf(l),
            data: pts.filter((p) => p.legend === l).map((p) => ({
              value: p.coord, idx: p.idx, v: p.value, loc: cat ? data.rows[p.idx][cat.alias] : undefined,
              symbolSize: val && p.value !== null ? 6 + 30 * Math.sqrt(Math.abs(p.value) / max) : 9,
              itemStyle: { opacity: dim(p.idx) ? 0.2 : 0.75, borderColor: '#FFFFFF', borderWidth: 0.6 },
            })),
            label: { show: f.dataLabels, position: 'right', fontSize: THEME.dataLabel.size, color: THEME.dataLabel.color, formatter: (p: any) => (p.data.v !== null && p.data.v !== undefined ? fmtAuto(p.data.v) : p.data.loc ?? '') },
          })),
        };
      }
      chart.current.setOption(option, true);
    })().catch((e) => setNote('Mappa non disponibile: ' + e.message));
    return () => { live = false; };
  }, [v, data, cross, theme]);

  return (
    <>
      <div ref={el} style={{ position: 'absolute', inset: '0 4px 4px 4px' }} />
      <div className="map-credit">{note ? <span className="map-note">{note} · </span> : null}Natural Earth · US Census · ISTAT/openpolis CC BY 4.0{postal ? ' · GeoNames CC BY 4.0' : ''}</div>
    </>
  );
}
