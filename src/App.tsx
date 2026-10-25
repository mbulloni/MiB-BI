import { useCallback, useEffect, useState } from 'react';
import { useStore, pageSize, isHiddenVisual } from './store';
import { TitleBar } from './components/TitleBar';
import { Ribbon } from './components/Ribbon';
import { Backstage } from './components/Backstage';
import { PageBackground, ReportView, StatusBar } from './components/ReportView';
import { DataView } from './components/DataView';
import { ModelView } from './components/ModelView';
import { ManageRelationships, RelationshipEditor } from './components/Relationships';
import { Navigator } from './components/Navigator';
import { PowerQueryEditor } from './components/PowerQuery';
import { DaxBar } from './components/DaxBar';
import { DatabaseDialog } from './components/DatabaseDialog';
import { PublishDialog } from './components/PublishDialog';
import { QnaExplorer } from './qna/QnaExplorer';
import { OptionsDialog } from './components/OptionsDialog';
import { ThemeDialog } from './components/ThemeDialog';
import { checkUpdates, UpdateBanner, UpdateDialog } from './components/Updates';
import { TranslationsDialog } from './components/TranslationsDialog';
import { AggregationsDialog } from './components/AggregationsDialog';
import { IncrementalDialog } from './components/IncrementalDialog';
import { PerspectivesDialog } from './components/PerspectivesDialog';
import { GroupDialog } from './components/GroupDialog';
import { ModelProperties } from './components/ModelProperties';
import { ServiceDialog } from './components/ServiceDialog';
import { RolesDialog, ViewAsBar, ViewAsDialog } from './components/RolesDialog';
import { CalendarDialog } from './components/CalendarDialog';
import { ScriptEditor } from './visuals/Script';
import { ParameterDialog } from './components/ParameterDialog';
import { SourceDialog } from './components/SourceDialogs';
import { DaxQueryView } from './components/DaxQueryView';
import { QuickMeasureDialog } from './components/QuickMeasure';
import { MobileLayoutView } from './components/MobileLayout';
import { EnterDataDialog } from './components/EnterData';
import { VisualStatic } from './components/VisualContainer';
import { THEME } from './themes';
import { Icon } from './components/icons';
import { FiltersPane, CollapsedPane } from './panes/FiltersPane';
import { VisualizationsPane } from './panes/VisualizationsPane';
import { BookmarksPane, SelectionPane } from './panes/SelectionPane';
import { DataPane } from './panes/DataPane';
import { PerformancePane } from './panes/PerformancePane';
import { SyncPane } from './panes/SyncPane';
import { ExportDataDialog } from './components/ExportDataDialog';
import { AboutDialog } from './components/AboutDialog';
import type { View } from './types';

const VIEWS: [View, string, string][] = [
  ['report', 'report', 'Vista report'],
  ['data', 'tableView', 'Vista tabella'],
  ['model', 'model', 'Vista modello'],
  ['dax', 'dax', 'Vista query DAX'],
];

/** Quiet check for a newer release a few seconds after startup. */
function useUpdateCheck() {
  useEffect(() => { const t = setTimeout(() => { void checkUpdates(true); }, 4000); return () => clearTimeout(t); }, []);
}

function useShortcuts() {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;
      const ctrl = e.ctrlKey || e.metaKey;
      if (s.pq) return;
      if (s.readMode) { if (e.key === 'Escape') s.set({ readMode: false }); return; }
      if (s.formatPainter && e.key === 'Escape') { s.set({ formatPainter: null }); return; }
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); s.save(e.shiftKey); return; }
      if (ctrl && e.key.toLowerCase() === 'o') { e.preventDefault(); s.open(); return; }
      if (typing) return;
      if (s.relEditor || s.relManage) return;
      if (s.view === 'model' && s.selectedRelId && e.key === 'Delete') { s.deleteRelationship(s.selectedRelId); return; }
      if (ctrl && e.key.toLowerCase() === 'z') { e.preventDefault(); s.undo(); }
      else if (ctrl && e.key.toLowerCase() === 'y') { e.preventDefault(); s.redo(); }
      else if (s.view === 'report' && s.selectedVisualId) {
        const v = s.page().visuals.find((x) => x.id === s.selectedVisualId);
        if (!v) return;
        if (e.key === 'Delete') s.removeVisual(v.id);
        else if (ctrl && e.key.toLowerCase() === 'c') s.set({ clipboard: JSON.parse(JSON.stringify(v)) });
        else if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); s.duplicateVisual(v.id); }
        else if (e.key === 'Escape') s.selectVisual(null);
        else if (e.key.startsWith('Arrow')) {
          e.preventDefault();
          const d = e.shiftKey ? 10 : 1;
          const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
          const dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
          s.updateVisual(v.id, { x: Math.max(0, v.x + dx), y: Math.max(0, v.y + dy) });
        }
      }
      if (ctrl && e.key.toLowerCase() === 'v' && s.clipboard && s.view === 'report') {
        const c = s.clipboard;
        const id = s.addVisual(c.type, { x: c.x + 20, y: c.y + 20 });
        const past = useStore.getState().past;
        s.updateVisual(id, { fields: c.fields, format: c.format, w: c.w, h: c.h, text: c.text, slicerValues: c.slicerValues, filters: c.filters });
        useStore.setState({ past });
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
}

export function App() {
  const s = useStore();
  const [fit, setFit] = useState(1);
  const onFit = useCallback((n: number) => setFit(n), []);
  useShortcuts();
  useUpdateCheck();

  return (
    <div className={'app' + (s.formatPainter ? ' painting' : '')}>
      <TitleBar />
      {s.readMode ? (
        <div className="readbar"><b>Modalità lettura</b><span>I pulsanti e i navigatori rispondono al clic. Esc per tornare alla modifica.</span>
          <button className="btn" onClick={() => s.set({ readMode: false })}>Modifica</button></div>
      ) : <><Ribbon /><DaxBar /></>}
      <UpdateBanner />
      <ViewAsBar />
      <div className={'main' + (s.readMode ? ' reading' : '')}>
        {!s.readMode && <div className="rail">
          {VIEWS.map(([k, icon, label]) => (
            <button key={k} title={label} className={s.view === k ? 'active' : ''} onClick={() => s.setView(k)}><Icon name={icon} size={22} /></button>
          ))}
        </div>}
        <div className="workspace">
          {s.view === 'report' && (s.mobileLayout && !s.readMode ? <MobileLayoutView /> : <ReportView onFit={onFit} />)}
          {s.view === 'data' && <DataView />}
          {s.view === 'model' && <ModelView />}
          {s.view === 'dax' && <DaxQueryView />}
          {s.view === 'report' && !s.readMode && s.panes.perf && <PerformancePane />}
          {s.view === 'report' && !s.readMode && s.panes.sync && <SyncPane />}
          {s.view === 'report' && !s.readMode && s.panes.bookmarks && <BookmarksPane />}
          {s.view === 'report' && !s.readMode && s.panes.selection && <SelectionPane />}
          {s.view === 'report' && (s.panes.filters ? <FiltersPane /> : <CollapsedPane title="Filtri" onOpen={() => s.set({ panes: { ...s.panes, filters: true } })} />)}
          {s.view === 'report' && !s.readMode && (s.panes.viz ? <VisualizationsPane /> : <CollapsedPane title="Visualizzazioni" onOpen={() => s.set({ panes: { ...s.panes, viz: true } })} />)}
          {!s.readMode && (s.panes.data ? <DataPane /> : <CollapsedPane title="Dati" onOpen={() => s.set({ panes: { ...s.panes, data: true } })} />)}
        </div>
      </div>
      <StatusBar fitScale={fit} />
      <Backstage />
      <ExportDataDialog />
      <AboutDialog />
      <Navigator />
      <DatabaseDialog />
      <PublishDialog />
      <QnaExplorer />
      <OptionsDialog />
      <ThemeDialog />
      <UpdateDialog />
      <TranslationsDialog />
      <AggregationsDialog />
      <IncrementalDialog />
      <PerspectivesDialog />
      <GroupDialog />
      <ModelProperties />
      <ServiceDialog />
      <RolesDialog />
      <CalendarDialog />
      <ViewAsDialog />
      <ScriptEditor />
      <ParameterDialog />
      <SourceDialog />
      <QuickMeasureDialog />
      <EnterDataDialog />
      {s.printing && (
        <div className={'print-root' + (s.printing === 'pptx' ? ' pptx-shot' : '')}>
          {s.report.pages.map((p) => (
            <div key={p.id} className="print-page" style={{ backgroundColor: THEME.background, position: 'relative', width: pageSize(p).w, height: pageSize(p).h }}>
              <PageBackground p={p} />
              {p.visuals.filter((v) => !isHiddenVisual(p, v)).map((v) => <VisualStatic key={v.id} v={v} />)}
            </div>
          ))}
        </div>
      )}
      <PowerQueryEditor />
      <ManageRelationships />
      <RelationshipEditor />
      {s.toast && <div className="toast" onClick={() => s.set({ toast: null })}>{s.toast}</div>}
      {s.busy && <div className="busy"><div className="box"><div className="spinner" />{s.busy}</div></div>}
    </div>
  );
}
