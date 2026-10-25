import { VisualCalcEditor } from './VisualCalcEditor';
import { VisualDataTable } from './ExportDataDialog';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { THEME } from '../themes';
import { useStore, pageSize, isHiddenVisual } from '../store';
import type { CSSProperties } from 'react';
import type { Page } from '../types';

/** Canvas background (color + image, with Power BI transparency) as a layer under the visuals. */
export function PageBackground({ p }: { p: Page }) {
  const t = p.backgroundTransparency ?? 0;
  if (!p.background && !p.backgroundColor) return null;
  const style: CSSProperties = {
    position: 'absolute', inset: 0, pointerEvents: 'none', opacity: (100 - t) / 100,
    backgroundColor: p.backgroundColor,
    ...(p.background ? {
      backgroundImage: `url(${p.background})`, backgroundRepeat: 'no-repeat',
      backgroundSize: p.backgroundFit === 'Fill' ? 'cover' : p.backgroundFit === 'Normal' ? 'auto' : '100% 100%',
      backgroundPosition: p.backgroundFit === 'Normal' ? 'left top' : 'center',
    } : {}),
  };
  return <div style={style} />;
}
import { VisualContainer, VisualBody, VisualStatic, FIELD_MIME, autoTitle } from './VisualContainer';
import { Icon } from './icons';
import { Menu } from './Menu';
import { locale } from '../format';

function EmptyState() {
  const s = useStore();
  return (
    <div className="page-empty">
      <h2>Aggiungere dati al report</h2>
      <p>Dopo il caricamento, i dati verranno visualizzati nel riquadro <b>Dati</b>.</p>
      <div className="srcs">
        <button className="src" onClick={() => s.openNavigator('excel')}><Icon name="excel" size={36} />Importa dati da Excel</button>
        <button className="src" onClick={() => s.openNavigator('csv')}><Icon name="docs" size={36} />Importa dati da Testo/CSV</button>
        <button className="src" onClick={() => s.openNavigator('parquet')}><Icon name="sql" size={36} />Importa dati da Parquet</button>
        <button className="src" onClick={() => s.loadSample()}><Icon name="sample" size={36} />Usa dati di esempio</button>
      </div>
      <span className="link" onClick={() => s.openNavigator('any')}>Ottieni dati da un'altra origine →</span>
    </div>
  );
}

function PageTabs() {
  const s = useStore();
  const [editing, setEditing] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  return (
    <div className="pagetabs">
      {s.report.pages.filter((p) => !s.readMode || (!p.hidden && !p.tooltip)).map((p) => (
        <div
          key={p.id}
          className={'pagetab' + (p.id === s.activePageId ? ' active' : '') + (p.hidden ? ' hidden-page' : '')}
          title={p.hidden ? 'Pagina nascosta' : undefined}
          onClick={() => s.setActivePage(p.id)}
          onDoubleClick={() => !s.readMode && setEditing(p.id)}
          onContextMenu={(e) => { e.preventDefault(); if (!s.readMode) setMenu({ id: p.id, x: e.clientX, y: e.clientY - 150 }); }}
        >
          {editing === p.id ? (
            <input type="text" autoFocus defaultValue={p.name}
              onBlur={(e) => { s.renamePage(p.id, e.target.value); setEditing(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(null); }} />
          ) : p.name}
        </div>
      ))}
      {!s.readMode && <button className="add" title="Nuova pagina" onClick={() => s.addPage()}><Icon name="plus" /></button>}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => { setEditing(menu.id); setMenu(null); }}>Rinomina pagina</button>
          <button onClick={() => { s.duplicatePage(menu.id); setMenu(null); }}>Duplica pagina</button>
          <button disabled={s.report.pages.length <= 1} onClick={() => { s.deletePage(menu.id); setMenu(null); }}>Elimina pagina</button>
        </Menu>
      )}
    </div>
  );
}

/** Like Power BI: "Modalità di archiviazione: Mista" when the model has DirectQuery tables (click = model view). */
function StorageStatus() {
  const s = useStore();
  const modes = new Set(s.tables.filter((t) => !t.source.dax).map((t) => t.storageMode ?? 'import'));
  if (!modes.has('directQuery') && !modes.has('dual')) return null;
  const label = modes.size === 1 && modes.has('directQuery') ? 'DirectQuery' : 'Mista';
  const page = s.page();
  return (
    <span className="storage-status" title="Le tabelle DirectQuery vengono lette dall'origine a ogni query. Fare clic per aprire la vista modello e modificare la modalità di archiviazione nelle proprietà della tabella."
      onClick={() => s.set({ view: 'model' })}>
      Modalità di archiviazione: <b>{label}</b>
      {page.autoRefresh && s.view === 'report' && <> · aggiornamento ogni {page.autoRefresh.seconds % 60 === 0 && page.autoRefresh.seconds >= 60 ? `${page.autoRefresh.seconds / 60} min` : `${page.autoRefresh.seconds} s`}{s.dqTick ? ` (ultimo ${new Date(s.dqTick).toLocaleTimeString(locale())})` : ''}</>}
    </span>
  );
}

export function StatusBar({ fitScale }: { fitScale: number }) {
  const s = useStore();
  const idx = s.report.pages.findIndex((p) => p.id === s.activePageId) + 1;
  const pct = Math.round((s.zoom === 'fit' ? fitScale : s.zoom) * 100);
  const setPct = (n: number) => s.set({ zoom: Math.max(0.1, Math.min(4, n / 100)) });
  return (
    <div className="statusbar">
      {s.view === 'report' && <span>Pagina {idx} di {s.report.pages.length}</span>}
      {s.view === 'data' && s.dataViewTable && <span>TABELLA: {s.dataViewTable} ({s.tables.find((t) => t.name === s.dataViewTable)?.rowCount.toLocaleString(locale())} righe)</span>}
      {s.crossFilter && <span>Filtro incrociato attivo: {s.crossFilter.column} = {s.crossFilter.value === '__NULL__' ? '(Vuoto)' : s.crossFilter.value}</span>}
      <StorageStatus />
      {s.view === 'report' && (
        <div className="zoom">
          <button onClick={() => setPct(pct - 10)}>−</button>
          <input type="range" min={10} max={400} value={pct} onChange={(e) => setPct(+e.target.value)} />
          <button onClick={() => setPct(pct + 10)}>+</button>
          <span style={{ width: 36 }}>{pct}%</span>
          <button title="Adatta alla pagina" onClick={() => s.set({ zoom: 'fit' })}><Icon name="focus" size={13} /></button>
        </div>
      )}
    </div>
  );
}

export function ReportView({ onFit }: { onFit: (n: number) => void }) {
  const s = useStore();
  const page = s.page();
  const wrap = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  const size = pageSize(page);
  // Aggiornamento automatico pagina: DirectQuery tables are read again at the page's interval.
  const hasDq = s.tables.some((t) => t.storageMode === 'directQuery');
  useEffect(() => {
    if (!page.autoRefresh || !hasDq || s.paused) return;
    let running = false;
    const id = setInterval(() => { if (running) return; running = true; useStore.getState().dqRefresh().finally(() => { running = false; }); }, Math.max(1, page.autoRefresh.seconds) * 1000);
    return () => clearInterval(id);
  }, [page.id, page.autoRefresh?.seconds, hasDq, s.paused]);

  useLayoutEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const f = Math.min((el.clientWidth - 48) / size.w, (el.clientHeight - 48) / size.h);
      setFit(Math.max(0.1, f));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [size.w, size.h]);
  useEffect(() => onFit(fit), [fit, onFit]);

  const scale = s.zoom === 'fit' ? fit : s.zoom;
  const w = size.w * scale, h = size.h * scale;
  const cw = Math.max(w + 48, (wrap.current?.clientWidth ?? 0));
  const ch = Math.max(h + 48, (wrap.current?.clientHeight ?? 0));
  const focus = s.focusId ? page.visuals.find((v) => v.id === s.focusId) : undefined;

  return (
    <div className="center">
      {s.paused && (
        <div className="pausebar"><b>Oggetti visivi sospesi</b><span>Le modifiche non aggiornano gli oggetti visivi finché non si aggiorna.</span>
          <button className="btn" onClick={() => s.set({ pauseTick: s.pauseTick + 1 })}>Aggiorna</button>
          <button className="btn" onClick={() => s.set({ paused: false })}>Riprendi le query</button></div>
      )}
      <div className="canvas-wrap" ref={wrap} style={page.wallpaper ?? THEME.outspace ? { background: page.wallpaper ?? THEME.outspace } : undefined}>
        {s.calcEdit ? <VisualCalcEditor /> : focus ? (
          <div className="focus-view" style={{ position: 'absolute', inset: 16, background: 'var(--bg)', display: 'flex', flexDirection: 'column', boxShadow: '0 1.6px 3.6px rgba(0,0,0,.13)' }}>
            <div style={{ height: 36, display: 'flex', alignItems: 'center', padding: '0 12px', gap: 12 }}>
              <button className="btn" style={{ minWidth: 0 }} onClick={() => s.set({ focusId: null })}>← Torna al report</button>
              <span style={{ fontSize: 14 }}>{focus.format.titleText || autoTitle(focus)}</span>
              <span style={{ flex: 1 }} />
              <button className="btn" style={{ minWidth: 0 }} onClick={() => s.set({ focusTable: !s.focusTable })}>{s.focusTable ? 'Nascondi tabella' : 'Mostra come tabella'}</button>
              <button className="btn" style={{ minWidth: 0 }} onClick={() => s.set({ exportData: focus.id })}>Esporta dati</button>
            </div>
            <div style={{ flex: 1, position: 'relative', minHeight: 0 }}><VisualBody v={focus} selected={false} /></div>
            {s.focusTable && <div style={{ flex: 1, position: 'relative', minHeight: 0, borderTop: '1px solid var(--line)' }}><VisualDataTable v={focus} /></div>}
          </div>
        ) : (
          <div className="canvas-inner" style={{ width: cw, height: ch }}>
            <div
              className={'page' + (s.gridlines ? ' grid' : '')}
              style={{
                width: size.w, height: size.h, transform: `scale(${scale})`, left: (cw - w) / 2, top: (ch - h) / 2, backgroundColor: THEME.background,
              }}
              onMouseDown={() => { s.selectVisual(null); if (s.crossFilter) s.setCross(null); }}
              onDragOver={(e) => { if (!s.readMode && e.dataTransfer.types.includes(FIELD_MIME)) e.preventDefault(); }}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData(FIELD_MIME);
                if (!raw || s.readMode) return;
                e.preventDefault();
                const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                const x = Math.max(0, Math.min(size.w - 440, (e.clientX - r.left) / scale - 40));
                const y = Math.max(0, Math.min(size.h - 300, (e.clientY - r.top) / scale - 20));
                s.addField(null, JSON.parse(raw), undefined, { x: Math.round(x), y: Math.round(y) });
              }}
            >
              <PageBackground p={page} />
              {page.visuals.filter((v) => !isHiddenVisual(page, v)).map((v) => (s.readMode ? <VisualStatic key={v.id} v={v} read /> : <VisualContainer key={v.id} v={v} scale={scale} />))}
            </div>
            {!s.tables.length && !page.visuals.length && <EmptyState />}
          </div>
        )}
      </div>
      <PageTabs />
    </div>
  );
}
