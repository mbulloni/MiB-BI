// Ottimizza › Analizzatore prestazioni: per visual, the duration of its query (DuckDB SQL generated from the
// visual and its DAX measures) and of its rendering, recorded while "Avvia registrazione" is on.
import { useState } from 'react';
import { useStore, type PerfEntry } from '../store';
import { PaneShell } from './SelectionPane';
import { autoTitle } from '../components/VisualContainer';
import { visualDef } from '../visuals/catalog';
import { locale } from '../format';

const ms = (x: number) => Math.round(x).toLocaleString(locale());

export function PerformancePane() {
  const s = useStore();
  const [open, setOpen] = useState<number | null>(null);
  const { recording, entries } = s.perf;
  const visualName = (id: string) => {
    for (const p of s.report.pages) {
      const v = p.visuals.find((x) => x.id === id);
      if (v) return { name: v.format.titleText || autoTitle(v) || visualDef(v.type, v.custom).name, page: p.name };
    }
    return { name: '(oggetto visivo eliminato)', page: '' };
  };
  const copy = (text: string) => navigator.clipboard.writeText(text).then(() => s.notify('Copiato negli Appunti.')).catch(() => s.notify('Copia non riuscita.'));
  const exportAll = () => copy(JSON.stringify(entries.map((e) => ({ visual: visualName(e.visualId).name, page: visualName(e.visualId).page, start: new Date(e.at).toISOString(), queryMs: Math.round(e.queryMs), renderMs: Math.round(e.renderMs), rows: e.rows, ...(e.storage ? { storage: e.storage } : {}), query: e.sql, ...(e.error ? { error: e.error } : {}) })), null, 2));
  const sorted = [...entries].reverse();
  const max = Math.max(1, ...entries.map((e) => e.queryMs + e.renderMs));
  return (
    <PaneShell title="Analizzatore prestazioni" onClose={() => s.set({ panes: { ...s.panes, perf: false } })}>
      <div className="sel-tools perf-tools">
        <button className="btn" onClick={() => s.set({ perf: { ...s.perf, recording: !recording } })}>{recording ? 'Arresta' : 'Avvia registrazione'}</button>
        <button className="btn" disabled={!recording} onClick={() => s.set({ dataVersion: s.dataVersion + 1, pauseTick: s.pauseTick + 1 })}>Aggiorna oggetti visivi</button>
        <button className="btn" disabled={!entries.length} onClick={() => s.set({ perf: { ...s.perf, entries: [] } })}>Cancella</button>
        <button className="btn" disabled={!entries.length} onClick={exportAll}>Esporta</button>
      </div>
      {!entries.length && <div className="side-empty">{recording ? 'Interagire con il report o fare clic su Aggiorna oggetti visivi.' : 'Avviare la registrazione per misurare le query e il rendering degli oggetti visivi.'}</div>}
      <div className="perf-list">
        {sorted.map((e: PerfEntry) => {
          const n = visualName(e.visualId);
          const total = e.queryMs + e.renderMs;
          return (
            <div key={e.id} className={'perf-row' + (e.error ? ' err' : '')}>
              <div className="perf-head" onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="nm" title={n.page}>{open === e.id ? '▾' : '▸'} {n.name}</span><b>{ms(total)}</b>
              </div>
              <div className="perf-bar"><span className="q" style={{ width: `${(e.queryMs / max) * 100}%` }} /><span className="r" style={{ width: `${(e.renderMs / max) * 100}%` }} /></div>
              {open === e.id && (
                <div className="perf-detail">
                  <div><span>Query</span><b>{ms(e.queryMs)}</b></div>
                  <div><span>Visualizzazione oggetto visivo</span><b>{ms(e.renderMs)}</b></div>
                  <div><span>Righe</span><b>{e.rows.toLocaleString(locale())}</b></div>
                  {e.storage && <div><span>Origine dati</span><b>{e.storage}</b></div>}
                  {e.error && <div className="perf-error">{e.error}</div>}
                  <button className="link" onClick={() => copy(e.sql)}>Copia query</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="perf-legend"><span className="q" />Query <span className="r" />Visualizzazione · durate in millisecondi</div>
    </PaneShell>
  );
}
