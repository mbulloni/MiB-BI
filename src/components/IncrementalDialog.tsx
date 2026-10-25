// Aggiornamento incrementale e dati in tempo reale (Data pane › table menu, Modellazione › Aggiornamento incrementale):
// the policy of a table (Report.refreshPolicies, exported as TMSL refreshPolicy) and a simulation of the service
// refresh at a chosen date (store.simulateIncremental) that shows the partitions and changes the loaded data.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { isDate, locale } from '../format';
import { UNIT_LABEL, partitions, policyWindow } from '../incremental';
import type { PolicyUnit, RefreshPolicy } from '../types';
import { Icon } from './icons';

const UNITS: PolicyUnit[] = ['day', 'month', 'quarter', 'year'];
const p2 = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}`;

export function IncrementalDialog() {
  const s = useStore();
  const open = s.incrementalDialog;
  const [table, setTable] = useState('');
  const [on, setOn] = useState(false);
  const [p, setP] = useState<RefreshPolicy | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [when, setWhen] = useState(localInput(new Date()));
  const [sim, setSim] = useState<Awaited<ReturnType<typeof s.simulateIncremental>> | null>(null);

  const load = (name: string) => {
    const t = s.tables.find((x) => x.name === name);
    const cur = s.report.refreshPolicies?.find((x) => x.table === name);
    const col = cur?.column ?? t?.columns.find((c) => isDate(c))?.name ?? '';
    setTable(name);
    setOn(!!cur);
    setP(cur ?? { table: name, column: col, archive: { n: 5, unit: 'year' }, incremental: { n: 10, unit: 'day' } });
    setErr(null);
    setSim(null);
  };
  useEffect(() => { if (open) load(open); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  if (!open || !p) return null;
  const close = () => s.set({ incrementalDialog: null });
  const t = s.tables.find((x) => x.name === table);
  const dateCols = t?.columns.filter((c) => isDate(c)) ?? [];
  const params = s.report.pqParams ?? [];
  const hasParams = ['RangeStart', 'RangeEnd'].every((n) => params.some((x) => x.name === n && x.type === 'datetime'));
  const uses = (q: string) => (t?.source.mcode ?? '').includes(q) || JSON.stringify(t?.steps ?? []).includes(`#[${q}]`);
  const filtered = hasParams && uses('RangeStart') && uses('RangeEnd');
  const upd = (x: Partial<RefreshPolicy>) => { setP({ ...p, ...x }); setSim(null); };
  const unit = (u: PolicyUnit, n: number) => UNIT_LABEL[u][n === 1 ? 0 : 1];
  const w = policyWindow(p, new Date(when));
  const fmt = (d: Date) => d.toLocaleDateString(locale());

  const apply = () => {
    if (!on) { s.setRefreshPolicy(table, null); close(); return; }
    if (!p.column) return setErr('Scegliere la colonna di data usata dal filtro.');
    if (!(p.archive.n >= 1 && p.incremental.n >= 1)) return setErr('I periodi devono essere almeno 1.');
    s.setRefreshPolicy(table, p);
    close();
  };
  const simulate = async () => {
    s.setRefreshPolicy(table, p);
    setSim(await s.simulateIncremental(table, new Date(when)));
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog inc-dlg">
        <div className="dh"><h2>Aggiornamento incrementale e dati in tempo reale</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db" style={{ flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          <label className="pq-field">Tabella
            <select value={table} onChange={(e) => load(e.target.value)}>
              {s.tables.filter((x) => !x.source.dax && x.storageMode !== 'directQuery').map((x) => <option key={x.name}>{x.name}</option>)}
            </select>
          </label>
          <div className={'inc-step' + (filtered ? ' ok' : '')}>
            <b>1. Impostare i parametri RangeStart e RangeEnd</b>
            {filtered ? <span>La query filtra la tabella con RangeStart e RangeEnd (Data/ora).</span>
              : <>
                <span>Power BI richiede due parametri Data/ora, RangeStart e RangeEnd, e un filtro sulla colonna di data della query (≥ RangeStart, &lt; RangeEnd).</span>
                <div className="qna-row">
                  <select value={p.column} onChange={(e) => upd({ column: e.target.value })}>{dateCols.map((c) => <option key={c.name}>{c.name}</option>)}</select>
                  <button className="btn" disabled={!p.column} onClick={async () => { const e = await s.addRangeFilter(table, p.column); setErr(e); }}>Crea parametri e filtro</button>
                </div>
              </>}
          </div>
          <div className="inc-step">
            <b>2. Scegliere la tabella e impostare i criteri</b>
            <label className="pq-check"><input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />Aggiorna in modo incrementale questa tabella</label>
            {on && <>
              <label className="pq-field">Colonna di data
                <select value={p.column} onChange={(e) => upd({ column: e.target.value })}>{dateCols.map((c) => <option key={c.name}>{c.name}</option>)}</select>
              </label>
              <div className="inc-row">Archivia dati a partire da
                <input type="number" min={1} value={p.archive.n} onChange={(e) => upd({ archive: { ...p.archive, n: Math.max(1, +e.target.value) } })} />
                <select value={p.archive.unit} onChange={(e) => upd({ archive: { ...p.archive, unit: e.target.value as PolicyUnit } })}>{UNITS.map((u) => <option key={u} value={u}>{unit(u, p.archive.n)}</option>)}</select>
                prima della data di aggiornamento</div>
              <div className="inc-row">Aggiorna in modo incrementale i dati a partire da
                <input type="number" min={1} value={p.incremental.n} onChange={(e) => upd({ incremental: { ...p.incremental, n: Math.max(1, +e.target.value) } })} />
                <select value={p.incremental.unit} onChange={(e) => upd({ incremental: { ...p.incremental, unit: e.target.value as PolicyUnit } })}>{UNITS.map((u) => <option key={u} value={u}>{unit(u, p.incremental.n)}</option>)}</select>
                prima della data di aggiornamento</div>
              <b style={{ marginTop: 6 }}>Facoltativo</b>
              <label className="pq-check"><input type="checkbox" checked={!!p.realTime} onChange={(e) => upd({ realTime: e.target.checked || undefined })} />Ottieni i dati più recenti in tempo reale con DirectQuery (solo Premium)</label>
              <label className="pq-check"><input type="checkbox" checked={!!p.completeOnly} disabled={!!p.realTime} onChange={(e) => upd({ completeOnly: e.target.checked || undefined })} />Aggiorna solo {UNIT_LABEL[p.incremental.unit][1]} completi</label>
              <label className="pq-check"><input type="checkbox" checked={!!p.detectChanges} onChange={(e) => upd({ detectChanges: e.target.checked ? (dateCols.find((c) => c.name !== p.column) ?? dateCols[0])?.name : undefined })} />Rileva modifiche dei dati</label>
              {p.detectChanges && <label className="pq-field">Colonna da controllare (data dell'ultima modifica)
                <select value={p.detectChanges} onChange={(e) => upd({ detectChanges: e.target.value })}>{dateCols.map((c) => <option key={c.name}>{c.name}</option>)}</select>
              </label>}
            </>}
          </div>
          {on && (
            <div className="inc-step">
              <b>3. Esaminare e applicare</b>
              <div className="inc-timeline">
                <span className="arch" style={{ flex: 3 }}>Archiviati: {fmt(w.archiveStart)} – {fmt(w.incStart)}</span>
                <span className="inc" style={{ flex: 2 }}>Aggiornati: {fmt(w.incStart)} – {fmt(new Date(w.end.getTime() - 1))}</span>
                {p.realTime && <span className="rt" style={{ flex: 1 }}>DirectQuery</span>}
              </div>
              <span className="hint">Power BI Desktop carica solo le righe tra RangeStart e RangeEnd; le partizioni vengono create dal servizio al primo aggiornamento dopo la pubblicazione ({partitions(p, new Date(when)).length} partizioni).</span>
              <div className="qna-row" style={{ marginTop: 6 }}>
                <span>Simula l'aggiornamento del servizio alla data</span>
                <input type="datetime-local" value={when} onChange={(e) => { setWhen(e.target.value); setSim(null); }} />
                <button className="btn" disabled={!p.column} onClick={() => void simulate()}>Simula aggiornamento</button>
              </div>
              {sim && 'error' in sim && <div className="daxbar-err"><Icon name="warning" size={14} />{sim.error}</div>}
              {sim && 'parts' in sim && (
                <table className="agg-grid">
                  <thead><tr><th>Partizione</th><th>Intervallo</th><th>Righe</th><th>Stato</th></tr></thead>
                  <tbody>{sim.parts.map((x) => (
                    <tr key={x.kind + x.name} className={'inc-' + x.kind}><td>{x.name}</td><td>{fmt(x.start)} – {fmt(new Date(x.end.getTime() - 1))}</td><td>{x.kind === 'realtime' ? '' : x.rows.toLocaleString(locale())}</td><td>{x.state}</td></tr>
                  ))}</tbody>
                  {sim.dropped > 0 && <tfoot><tr><td colSpan={4}>{sim.dropped.toLocaleString(locale())} righe fuori dalla finestra eliminate.</td></tr></tfoot>}
                </table>
              )}
            </div>
          )}
          {err && <div className="daxbar-err"><Icon name="warning" size={14} />{err}</div>}
        </div>
        <div className="df">
          <button className="btn primary" onClick={apply}>Applica</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
