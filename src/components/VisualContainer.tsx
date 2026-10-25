import { NO_CALCS } from '../visuals/visualCalc';
import { useMemo, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ExtraFilters } from '../visuals/filterContext';
import { PageBackground } from './ReportView';
import { isHiddenVisual, pageSize } from '../store';
import { font, withAlpha } from '../visuals/pbistyle';
import { Rnd } from 'react-rnd';
import type { FieldRef, Filter, Visual } from '../types';
import { THEME } from '../themes';
import { useStore } from '../store';
import { useVisualData } from '../visuals/useVisualData';
import { ChartVisual, type PointEvents } from '../visuals/ChartVisual';
import { ButtonVisual, NavigatorVisual, ShapeVisual } from '../visuals/Shapes';
import { MapVisual } from '../visuals/MapVisual';
import { ScriptVisual } from '../visuals/Script';
import { QnaVisual } from '../qna/QnaVisual';
import { DecompositionTreeVisual, KeyInfluencersVisual, SmartNarrativeVisual } from '../visuals/AiVisuals';
import { CardVisual, KpiVisual, MatrixVisual, MultiRowCardVisual, SlicerVisual, TableVisual, TextboxVisual } from '../visuals/Others';
import { isChart, visualDef } from '../visuals/catalog';
import { caption, fieldLabel } from '../format';
import { NULL_KEY } from '../query';
import { Icon, VisualIcon } from './icons';
import { Menu } from './Menu';
import { CustomVisual } from '../visuals/custom/CustomVisual';
import { interactionChoices, interactionOf, isSource, isTarget } from '../visuals/interactions';
import type { Interaction } from '../types';

export const FIELD_MIME = 'application/x-mib-bi-field';

/** Container look: background (with transparency), border. */
export function boxStyle(v: Visual): CSSProperties {
  const f = v.format;
  // White and unset values follow the theme (visualStyles *.*.background / border).
  const bg = f.background === 'transparent' ? 'transparent' : f.background.toUpperCase() === '#FFFFFF' ? withAlpha(THEME.visualBg, f.bgTransparency ?? THEME.visualBgTransparency) : withAlpha(f.background, f.bgTransparency);
  const border = f.border ?? THEME.border;
  return {
    background: bg,
    border: border ? `1px solid ${f.borderColor ?? THEME.borderColor}` : undefined,
    borderRadius: border || f.borderRadius ? f.borderRadius ?? (f.border === undefined ? THEME.borderRadius : 4) : 0,
    overflow: f.borderRadius ? 'hidden' : undefined,
  };
}

/** Fields of the visual's drill hierarchy (axis/legend/location with more than one field). */
export function hierarchyOf(v: Visual): FieldRef[] {
  const w = visualDef(v.type, v.custom).wells.find((x) => x.hierarchy);
  return w ? v.fields[w.key] ?? [] : [];
}

/** Drill buttons of the visual header (Power BI: up, drill mode, next level, expand all). */
function DrillButtons({ v }: { v: Visual }) {
  const s = useStore();
  const hier = hierarchyOf(v);
  if (hier.length < 2) return null;
  const d = v.drill ?? { level: 0, path: [] };
  const lvl = Math.min(d.level, hier.length - 1);
  const up = lvl > 0;
  const down = lvl < hier.length - 1;
  const set = (drill: Visual['drill']) => { s.updateVisual(v.id, { drill }); if (s.crossFilter?.visualId === v.id) s.setCross(null); };
  return <>
    <button title="Drill-up" disabled={!up} onClick={() => set({ ...d, level: lvl - 1, path: d.path.slice(0, lvl - 1), expand: false })}>↑</button>
    <button title={d.mode ? 'Disattiva drill-down' : 'Attiva drill-down (clic su un dato per esplorarlo)'} className={d.mode ? 'on' : ''} onClick={() => set({ ...d, mode: !d.mode })}>↓</button>
    <button title="Vai al livello successivo della gerarchia" disabled={!down} onClick={() => set({ ...d, level: lvl + 1, expand: false, path: d.path.slice(0, lvl) })}>⇊</button>
    <button title="Espandi tutto di un livello nella gerarchia" disabled={!down} onClick={() => set({ ...d, level: lvl + 1, expand: true, path: [] })}>⑂</button>
  </>;
}

export function VisualTitle({ v, title }: { v: Visual; title: string }) {
  const f = v.format;
  if (!f.titleShow || !title) return null;
  return (
    // Unset title properties follow the theme's "title" text class (14 px = the default size).
    <div className="vc-title" style={{
      fontSize: f.titleSize === 14 ? THEME.text.title.size : f.titleSize, color: f.titleColor ?? THEME.text.title.color, textAlign: f.titleAlign,
      fontFamily: f.titleFont ? font(f.titleFont) : THEME.text.title.font,
      fontWeight: f.titleBold ? 700 : f.titleBold === false ? 400 : THEME.text.title.weight, background: f.titleBg,
    }}>{title}</div>
  );
}

export function autoTitle(v: Visual): string {
  const f = v.fields;
  const lbl = (k: string) => (f[k] ?? []).map(fieldLabel);
  if (v.type === 'slicer') return lbl('category')[0] ?? '';
  if (v.type === 'scatter') {
    const parts = [...lbl('x'), ...lbl('y')];
    return parts.length ? `${parts.join(' e ')}${f.details?.length ? ' per ' + caption(f.details[0].table, f.details[0].column) : ''}` : '';
  }
  if (v.type === 'gauge') return lbl('values')[0] ?? '';
  if (v.type === 'kpi') return [...lbl('values'), ...lbl('target')].join(' e ');
  const values = [...lbl('values'), ...lbl('lineValues')];
  // Date hierarchy levels are named by level ("per Anno, Trimestre, Mese e Giorno"), like Power BI.
  const dims = [...new Set([...(f.category ?? []), ...(f.rows ?? []), ...(f.legend ?? []), ...(f.columns ?? [])].map((x) => (x.datePart ? fieldLabel(x) : caption(x.table, x.column))))];
  const list = (xs: string[]) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}` : xs[0] ?? '');
  if (!values.length) return dims.join(', ');
  return dims.length ? `${values.join(' e ')} per ${list(dims)}` : values.join(' e ');
}

export function VisualBody({ v, selected }: { v: Visual; selected: boolean }) {
  const data = useVisualData(v);
  const cross = useStore((s) => s.crossFilter);
  const setCross = useStore((s) => s.setCross);
  const updateVisual = useStore((s) => s.updateVisual);
  const drillThrough = useStore((s) => s.drillThrough);
  const pages = useStore((s) => s.report.pages);
  const [ctx, setCtx] = useState<{ cat: string | null; x: number; y: number } | null>(null);
  const [hover, setHover] = useState<{ cat: string | null; x: number; y: number } | null>(null);
  const def = visualDef(v.type, v.custom);
  const catWell = def.category;

  const hier = hierarchyOf(v);
  const lvl = Math.min(v.drill?.level ?? 0, Math.max(0, hier.length - 1));
  const onSelect = (category: string | null) => {
    // Drill mode: clicking a data point goes one level down into it.
    if (v.drill?.mode && hier.length > 1 && lvl < hier.length - 1 && !v.drill.expand) {
      updateVisual(v.id, { drill: { ...v.drill, level: lvl + 1, path: [...(v.drill.path ?? []).slice(0, lvl), category] } });
      return;
    }
    if (v.drill?.expand && hier.length > 1) return; // combined labels: no single value to filter on
    const field = hier.length > 1 ? hier[lvl] : catWell ? v.fields[catWell]?.[0] : data.items.find((i) => !i.measure)?.field;
    if (!field) return;
    const value = category === null ? NULL_KEY : category;
    if (cross?.visualId === v.id && cross.value === value) setCross(null);
    else setCross({ visualId: v.id, table: field.table, column: field.column, value, ...(field.datePart ? { datePart: field.datePart } : {}) });
  };

  const point = hier.length > 1 ? hier[lvl] : catWell ? v.fields[catWell]?.[0] : undefined;
  const drillPages = pages.filter((p) => p.drillthrough?.fields.some((f) => point && f.table === point.table && f.column === point.column && f.datePart === point.datePart));
  const events: PointEvents = {
    onContext: (cat, x, y) => { if (point && drillPages.length) setCtx({ cat, x, y }); },
    onHover: v.format.tooltipPage ? (cat, x, y) => setHover(cat === undefined ? null : { cat, x, y }) : undefined,
  };
  const overlays = <>
    {ctx && point && (
      <Menu x={ctx.x} y={ctx.y} onClose={() => setCtx(null)}>
        <div className="hdr">Drill-through</div>
        {drillPages.map((p) => <button key={p.id} onClick={() => { setCtx(null); drillThrough(p.id, [{ table: point.table, column: point.column, datePart: point.datePart, value: ctx.cat }]); }}>{p.name}</button>)}
      </Menu>
    )}
    {hover && point && v.format.tooltipPage && <TooltipPage pageId={v.format.tooltipPage} filter={{ id: 'tt', table: point.table, column: point.column, datePart: point.datePart, values: [hover.cat === null ? NULL_KEY : hover.cat] }} x={hover.x} y={hover.y} />}
  </>;

  if (v.type === 'textbox') return <TextboxVisual v={v} selected={selected} />;
  if (v.type === 'button') return <ButtonVisual v={v} />;
  if (v.type === 'shape') return <ShapeVisual v={v} />;
  if (v.type === 'pageNavigator' || v.type === 'bookmarkNavigator') return <NavigatorVisual v={v} />;
  if (v.type === 'image') return <img src={v.image} alt="" draggable={false} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain' }} />;
  if (v.type === 'unsupported') return <div className="vc-error"><b>Oggetto visivo non supportato</b><span>{v.text}</span></div>;
  if (v.type === 'decompositionTree') return <DecompositionTreeVisual v={v} />;
  if (v.type === 'keyInfluencers') return <KeyInfluencersVisual v={v} />;
  if (v.type === 'smartNarrative') return <SmartNarrativeVisual v={v} selected={selected} />;
  if (v.type === 'qna') return <QnaVisual v={v} selected={selected} />;
  // Custom visuals draw even without fields (empty dataViews), like Power BI.
  if (v.type === 'custom') return <CustomVisual v={v} data={data} />;
  if (data.empty) return <div className="vc-placeholder"><VisualIcon type={v.type} size={Math.min(120, v.h * 0.45)} /></div>;
  if (data.error) return <div className="vc-error"><b>Impossibile visualizzare l'oggetto visivo.</b><span>{data.error}</span></div>;
  if (v.type === 'card') return <CardVisual v={v} data={data} />;
  if (v.type === 'kpi') return <KpiVisual data={data} />;
  if (v.type === 'multiRowCard') return <MultiRowCardVisual v={v} data={data} cross={cross} onSelect={onSelect} />;
  if (v.type === 'table') return <TableVisual v={v} data={data} cross={cross} onSelect={onSelect} />;
  if (v.type === 'matrix') return <MatrixVisual v={v} data={data} cross={cross} onSelect={onSelect} />;
  if (v.type === 'slicer') return <SlicerVisual v={v} data={data} />;
  if (v.type === 'pythonVisual' || v.type === 'rVisual') return <ScriptVisual v={v} data={data} />;
  if (v.type === 'map' || v.type === 'filledMap') return <MapVisual v={v} data={data} cross={cross} onSelect={onSelect} />;
  return <><ChartVisual v={v} data={data} cross={cross} onSelect={onSelect} events={events} />{overlays}</>;
}

/** Report page shown as a tooltip, filtered on the hovered data point. */
function TooltipPage({ pageId, filter, x, y }: { pageId: string; filter: Filter; x: number; y: number }) {
  const page = useStore((s) => s.report.pages.find((p) => p.id === pageId));
  const filters = useMemo(() => [filter], [filter.table, filter.column, filter.values[0], filter.datePart]);
  if (!page) return null;
  const { w, h } = pageSize(page);
  const scale = Math.min(1, 320 / w, 400 / h);
  const left = Math.min(x + 14, window.innerWidth - w * scale - 8), top = Math.min(y + 14, window.innerHeight - h * scale - 8);
  return createPortal(
    <div className="tt-page" style={{ left, top, width: w * scale, height: h * scale }}>
      <div style={{ width: w, height: h, transform: `scale(${scale})`, transformOrigin: '0 0', position: 'relative', background: THEME.background }}>
        <PageBackground p={page} />
        <ExtraFilters.Provider value={filters}>
          {page.visuals.filter((v) => !isHiddenVisual(page, v)).map((v) => <VisualStatic key={v.id} v={v} />)}
        </ExtraFilters.Provider>
      </div>
    </div>,
    document.body,
  );
}

/** Visual at its page position without editing chrome: PDF export, tooltip pages and (read) Modalità lettura. */
export function VisualStatic({ v, read }: { v: Visual; read?: boolean }) {
  const title = v.format.titleText || autoTitle(v);
  return (
    <div className={'vc-inner print-vc' + (read ? ' read-vc' : '')} style={{ left: v.x, top: v.y, width: v.w, height: v.h, zIndex: v.z, ...boxStyle(v) }}>
      <VisualTitle v={v} title={title} />
      <div className="vc-body"><VisualBody v={v} selected={false} /></div>
    </div>
  );
}

/** Visuals with a data query (Esporta dati, Mostra come tabella). */
export const hasData = (v: Visual) => !['textbox', 'image', 'shape', 'button', 'pageNavigator', 'bookmarkNavigator', 'unsupported', 'qna', 'smartNarrative', 'decompositionTree', 'keyInfluencers'].includes(v.type) && Object.values(v.fields).some((f) => f.length);

const INTERACTION_UI: Record<Interaction, [string, string]> = { filter: ['interFilter', 'Filtro'], highlight: ['interHighlight', 'Evidenzia'], none: ['interNone', 'Nessuna'] };

/** Modifica interazioni: how the selected visual's selections reach this one (Filtro / Evidenzia / Nessuna). */
function InteractionIcons({ v }: { v: Visual }) {
  const s = useStore();
  const page = s.page();
  const src = page.visuals.find((x) => x.id === s.selectedVisualId);
  if (!s.editInteractions || !src || src.id === v.id || !isSource(src) || !isTarget(v)) return null;
  const cur = interactionOf(s.report, page, src.id, v);
  return (
    <div className="vc-inter" onMouseDown={(e) => e.stopPropagation()}>
      {interactionChoices(src, v).map((m) => (
        <button key={m} className={cur === m ? 'on' : ''} title={INTERACTION_UI[m][1]} onClick={() => s.setInteraction(src.id, v.id, m)}><Icon name={INTERACTION_UI[m][0]} size={16} /></button>
      ))}
    </div>
  );
}

/** `geom`/`onGeom`: another layout of the visual (mobile layout) instead of its page position. */
export function VisualContainer({ v, scale, geom, onGeom }: { v: Visual; scale: number; geom?: { x: number; y: number; w: number; h: number }; onGeom?: (g: { x: number; y: number; w: number; h: number }) => void }) {
  const s = useStore();
  const selected = s.selectedVisualId === v.id;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState(false);
  const title = v.format.titleText || autoTitle(v);
  const def = visualDef(v.type, v.custom);
  const allFields = def.wells.flatMap((w) => (v.fields[w.key] ?? []).map((f) => ({ f, w })));

  return (
    <Rnd
      className={'vc' + (selected ? ' selected' : '') + (s.multiSel.includes(v.id) ? ' multisel' : '') + (over ? ' drop-target' : '')}
      size={{ width: geom?.w ?? v.w, height: geom?.h ?? v.h }}
      position={{ x: geom?.x ?? v.x, y: geom?.y ?? v.y }}
      scale={scale}
      bounds="parent"
      minWidth={60}
      minHeight={40}
      dragGrid={s.snapToGrid ? [16, 16] : [1, 1]}
      resizeGrid={s.snapToGrid ? [16, 16] : [1, 1]}
      cancel=".tbl, .qna-bar, .qna-settings, .slicer-v, .textbox-v[contenteditable=true], .vc-header, .vc-inter"
      style={{ zIndex: selected ? 1000 : v.z }}
      enableResizing={selected}
      resizeHandleClasses={selected ? { topLeft: 'rnd-handle', topRight: 'rnd-handle', bottomLeft: 'rnd-handle', bottomRight: 'rnd-handle', top: 'rnd-handle', bottom: 'rnd-handle', left: 'rnd-handle', right: 'rnd-handle' } : undefined}
      resizeHandleStyles={{ top: { left: '50%', marginLeft: -4, top: -5 }, bottom: { left: '50%', marginLeft: -4, bottom: -5 }, left: { top: '50%', marginTop: -4, left: -5 }, right: { top: '50%', marginTop: -4, right: -5 }, topLeft: { left: -5, top: -5 }, topRight: { right: -5, top: -5 }, bottomLeft: { left: -5, bottom: -5 }, bottomRight: { right: -5, bottom: -5 } }}
      onMouseDown={(e: MouseEvent) => {
        e.stopPropagation();
        if (s.formatPainter) { s.applyFormatPainter(v.id); return; }
        // Ctrl+click: multiple selection (on buttons Ctrl+click runs the action instead, like Power BI).
        if ((e.ctrlKey || e.metaKey) && v.type !== 'button') {
          const cur = new Set(s.multiSel.length ? s.multiSel : s.selectedVisualId ? [s.selectedVisualId] : []);
          if (cur.has(v.id)) cur.delete(v.id); else cur.add(v.id);
          s.set({ multiSel: [...cur] });
          if (!selected) s.selectVisual(v.id);
          return;
        }
        if (s.multiSel.length) s.set({ multiSel: [] });
        if (!selected) s.selectVisual(v.id);
      }}
      onDragStart={() => document.body.classList.add('mib-bi-dragging')}
      onResizeStart={() => document.body.classList.add('mib-bi-dragging')}
      onDragStop={(_e, d) => {
        document.body.classList.remove('mib-bi-dragging');
        if (onGeom && geom) { if (d.x !== geom.x || d.y !== geom.y) onGeom({ ...geom, x: Math.round(d.x), y: Math.round(d.y) }); return; }
        if (d.x !== v.x || d.y !== v.y) s.updateVisual(v.id, { x: Math.round(d.x), y: Math.round(d.y) });
      }}
      onResizeStop={(_e, _dir, ref, _delta, pos) => {
        document.body.classList.remove('mib-bi-dragging');
        const g = { w: Math.round(ref.offsetWidth), h: Math.round(ref.offsetHeight), x: Math.round(pos.x), y: Math.round(pos.y) };
        if (onGeom) onGeom(g); else s.updateVisual(v.id, g);
      }}
    >
      <div
        className="vc-inner"
        style={boxStyle(v)}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(FIELD_MIME)) { e.preventDefault(); e.stopPropagation(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const raw = e.dataTransfer.getData(FIELD_MIME);
          if (!raw) return;
          e.preventDefault(); e.stopPropagation();
          s.addField(v.id, JSON.parse(raw));
          s.selectVisual(v.id);
        }}
        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <VisualTitle v={v} title={title} />
        <div className="vc-body"><VisualBody v={v} selected={selected} /></div>
      </div>
      <div className="vc-frame" />
      <InteractionIcons v={v} />
      <div className="vc-header" style={THEME.header.background || THEME.header.foreground ? { background: THEME.header.background, color: THEME.header.foreground } : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <DrillButtons v={v} />
        {isChart(v.type) || v.type === 'table' || v.type === 'matrix' ? (
          <button title="Modalità messa a fuoco" onClick={() => s.set({ focusId: v.id, focusTable: false })}><Icon name="focus" size={13} /></button>
        ) : null}
        <button title="Altre opzioni" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.right - 200, y: r.bottom + 2 }); }}><Icon name="more" size={14} /></button>
      </div>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {(v.type === 'pythonVisual' || v.type === 'rVisual') && <><button onClick={() => { setMenu(null); s.set({ scriptEditor: v.id }); }}>Editor di script</button><hr /></>}
          {allFields.length > 0 && v.type !== 'textbox' && v.type !== 'card' && v.type !== 'kpi' && v.type !== 'slicer' && v.type !== 'gauge' && <>
            <div className="hdr">Ordina asse</div>
            {allFields.map(({ f }, i) => (
              <button key={i} onClick={() => { setMenu(null); s.updateFormat(v.id, { sortBy: i, sortDir: v.format.sortBy === i && v.format.sortDir === 'desc' ? 'asc' : 'desc' }); }}>
                <span style={{ width: 12 }}>{v.format.sortBy === i ? '✓' : ''}</span>{fieldLabel(f)}
              </button>
            ))}
            <button onClick={() => { setMenu(null); s.updateFormat(v.id, { sortDir: 'desc' }); }}><span style={{ width: 12 }}>{v.format.sortDir !== 'asc' ? '✓' : ''}</span>Ordinamento decrescente</button>
            <button onClick={() => { setMenu(null); s.updateFormat(v.id, { sortDir: 'asc', sortBy: v.format.sortBy ?? 0 }); }}><span style={{ width: 12 }}>{v.format.sortDir === 'asc' ? '✓' : ''}</span>Ordinamento crescente</button>
            <hr />
          </>}
          {hasData(v) && <>
            <button onClick={() => { setMenu(null); s.set({ exportData: v.id }); }}>Esporta dati</button>
            <button onClick={() => { setMenu(null); s.set({ focusId: v.id, focusTable: true }); }}>Mostra come tabella</button>
            {!NO_CALCS.has(v.type) && <button onClick={() => { setMenu(null); s.startVisualCalc(v.id); }}>Nuovo calcolo visivo</button>}
            <hr />
          </>}
          <button onClick={() => { setMenu(null); s.duplicateVisual(v.id); }}>Duplica</button>
          <button onClick={() => { setMenu(null); s.set({ clipboard: JSON.parse(JSON.stringify(v)) }); }}>Copia</button>
          <button onClick={() => { setMenu(null); s.updateVisual(v.id, { z: Math.max(...s.page().visuals.map((x) => x.z)) + 1 }); }}>Porta in primo piano</button>
          <button onClick={() => { setMenu(null); s.updateVisual(v.id, { z: Math.min(...s.page().visuals.map((x) => x.z)) - 1 }); }}>Porta in secondo piano</button>
          <hr />
          <button onClick={() => { setMenu(null); s.removeVisual(v.id); }}><Icon name="trash" />Rimuovi</button>
        </Menu>
      )}
    </Rnd>
  );
}
