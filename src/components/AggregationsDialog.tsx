// Gestisci aggregazioni (Modellazione › Gestisci aggregazioni, or Data pane › table menu): for each column of the
// aggregation table, the summarization and the detail table/column it stands for. Saved in Report.aggregations;
// queries are rewritten by aggregations.ts#rewriteForAggregations.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { isNumeric } from '../format';
import { AGG_LABEL } from '../aggregations';
import type { AggSummarization, AggTable } from '../types';
import { Icon } from './icons';

type Row = { summarization: AggSummarization | ''; detail: string; column: string };

export function AggregationsDialog() {
  const s = useStore();
  const open = s.aggDialog;
  const [table, setTable] = useState('');
  const [prec, setPrec] = useState('0');
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [err, setErr] = useState<string | null>(null);

  const load = (name: string) => {
    const a = s.report.aggregations?.find((x) => x.table === name);
    const t = s.tables.find((x) => x.name === name);
    setTable(name);
    setPrec(String(a?.precedence ?? 0));
    setRows(Object.fromEntries((t?.columns ?? []).map((c) => {
      const m = a?.columns[c.name];
      return [c.name, { summarization: m?.summarization ?? '', detail: m ? a!.detail : '', column: m?.column ?? '' }];
    })));
    setErr(null);
  };
  useEffect(() => {
    if (!open) return;
    load(typeof open === 'string' ? open : s.report.aggregations?.[0]?.table ?? s.tables.find((t) => !t.source.dax && t.storageMode !== 'directQuery')?.name ?? s.tables[0]?.name ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const close = () => s.set({ aggDialog: null });
  const t = s.tables.find((x) => x.name === table);

  const save = () => {
    const used = Object.entries(rows).filter(([, r]) => r.summarization);
    if (!used.length) { s.setAggregation(table, null); close(); return; }
    const details = [...new Set(used.map(([, r]) => r.detail).filter(Boolean))];
    if (details.length !== 1) return setErr(details.length ? 'Tutte le colonne di una tabella di aggregazione devono fare riferimento alla stessa tabella dei dettagli.' : 'Scegliere la tabella dei dettagli.');
    const detail = details[0];
    if (detail === table) return setErr('La tabella dei dettagli deve essere diversa dalla tabella di aggregazione.');
    const dt = s.tables.find((x) => x.name === detail);
    for (const [col, r] of used) {
      if (r.summarization !== 'countRows' && !r.column) return setErr(`${col}: scegliere la colonna dei dettagli.`);
      const src = dt?.columns.find((c) => c.name === r.column), own = t?.columns.find((c) => c.name === col);
      if ((r.summarization === 'sum' || r.summarization === 'count' || r.summarization === 'countRows') && own && !isNumeric(own)) return setErr(`${col}: ${AGG_LABEL[r.summarization]} richiede una colonna numerica.`);
      if (r.summarization === 'sum' && src && !isNumeric(src)) return setErr(`${col}: la colonna dei dettagli ${r.column} non è numerica.`);
      if ((r.summarization === 'groupBy' || r.summarization === 'min' || r.summarization === 'max') && src && own && isNumeric(src) !== isNumeric(own)) return setErr(`${col}: il tipo di dati deve corrispondere a quello di ${detail}[${r.column}].`);
    }
    const dup = used.find(([c, r], i) => used.some(([c2, r2], j) => j !== i && c2 !== c && r.summarization !== 'countRows' && r2.summarization === r.summarization && r2.column === r.column));
    if (dup) return setErr(`${dup[0]}: la stessa colonna dei dettagli e lo stesso riepilogo sono già usati da un'altra colonna.`);
    const n = Number(prec);
    if (!Number.isInteger(n)) return setErr('La precedenza deve essere un numero intero.');
    const a: AggTable = { table, detail, ...(n ? { precedence: n } : {}), columns: Object.fromEntries(used.map(([c, r]) => [c, { summarization: r.summarization as AggSummarization, ...(r.summarization !== 'countRows' ? { column: r.column } : {}) }])) };
    s.setAggregation(table, a);
    close();
  };

  const set = (col: string, p: Partial<Row>) => setRows((x) => {
    const r = { ...x[col], ...p };
    // One detail table per aggregation table: the first choice becomes the default of the other rows.
    if (p.detail) for (const k of Object.keys(x)) if (k !== col && x[k].summarization && !x[k].detail) x[k] = { ...x[k], detail: p.detail };
    if (p.summarization && !r.detail) r.detail = Object.values(x).find((y) => y.detail)?.detail ?? '';
    if (p.summarization && !r.column) r.column = s.tables.find((y) => y.name === r.detail)?.columns.find((c) => c.name === col)?.name ?? '';
    return { ...x, [col]: r };
  });

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog agg-dlg">
        <div className="dh"><h2>Gestisci aggregazioni</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db" style={{ flexDirection: 'column', gap: 10, overflow: 'auto' }}>
          <div className="pq-row" style={{ gap: 16, alignItems: 'flex-end' }}>
            <label className="pq-field" style={{ flex: 1 }}>Tabella di aggregazione
              <select value={table} onChange={(e) => load(e.target.value)}>
                {s.tables.filter((x) => !x.source.dax || s.report.aggregations?.some((a) => a.table === x.name)).map((x) => <option key={x.name}>{x.name}</option>)}
              </select>
            </label>
            <label className="pq-field" style={{ width: 120 }}>Precedenza
              <input type="number" step={1} value={prec} onChange={(e) => setPrec(e.target.value)} />
            </label>
          </div>
          <table className="agg-grid">
            <thead><tr><th>Colonna di aggregazione</th><th>Riepilogo</th><th>Tabella dei dettagli</th><th>Colonna dei dettagli</th></tr></thead>
            <tbody>
              {(t?.columns ?? []).map((c) => {
                const r = rows[c.name] ?? { summarization: '', detail: '', column: '' };
                const dt = s.tables.find((x) => x.name === r.detail);
                return (
                  <tr key={c.name}>
                    <td>{c.name}<span className="hint"> {c.type}</span></td>
                    <td><select value={r.summarization} onChange={(e) => set(c.name, { summarization: e.target.value as AggSummarization | '' })}>
                      <option value="">(Nessuno)</option>
                      {(Object.keys(AGG_LABEL) as AggSummarization[]).map((k) => <option key={k} value={k}>{AGG_LABEL[k]}</option>)}
                    </select></td>
                    <td><select value={r.detail} disabled={!r.summarization} onChange={(e) => set(c.name, { detail: e.target.value, column: '' })}>
                      <option value="" />
                      {s.tables.filter((x) => x.name !== table).map((x) => <option key={x.name}>{x.name}</option>)}
                    </select></td>
                    <td><select value={r.column} disabled={!r.summarization || r.summarization === 'countRows' || !dt} onChange={(e) => set(c.name, { column: e.target.value })}>
                      <option value="" />
                      {dt?.columns.map((x) => <option key={x.name}>{x.name}</option>)}
                    </select></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="pq-note">Le query degli oggetti visivi che usano solo colonne <b>Raggruppa per</b> e somme, conteggi, minimi o massimi mappati
            (più le tabelle collegate alla tabella di aggregazione da relazioni) leggono la tabella di aggregazione invece della tabella dei dettagli.
            Le misure DAX e i filtri su colonne non mappate usano sempre i dettagli. Come in Power BI, la tabella di aggregazione viene nascosta.
            L'Analizzatore prestazioni mostra quale tabella ha risposto.</p>
          {err && <div className="daxbar-err"><Icon name="warning" size={14} />{err}</div>}
        </div>
        <div className="df">
          {s.report.aggregations?.some((a) => a.table === table) && <button className="btn" style={{ marginRight: 'auto' }} onClick={() => { s.setAggregation(table, null); close(); }}>Rimuovi aggregazioni</button>}
          <button className="btn primary" onClick={save} disabled={!t}>Applica tutto</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
