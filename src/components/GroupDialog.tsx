// Gruppi (Data pane › column menu › Nuovo gruppo / Modifica gruppi): values grouped in a list, or bins of numbers and
// dates. The result is a DAX calculated column (grouping.ts) whose definition is kept in Report.groupings.
import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { isDate, isNumeric } from '../format';
import { qi } from '../query';
import type { Grouping } from '../types';
import { Icon } from './icons';

const show = (v: string | null) => (v === null ? '(Vuoto)' : v);

export function GroupDialog() {
  const s = useStore();
  const open = s.groupDialog;
  const [g, setG] = useState<Grouping | null>(null);
  const [values, setValues] = useState<(string | null)[]>([]);
  const [pick, setPick] = useState<Set<string | null>>(new Set());
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const t = open ? s.tables.find((x) => x.name === open.table) : undefined;
  const existing = open?.name ? s.report.groupings?.find((x) => x.table === open.table && x.name === open.name) : undefined;
  const column = existing?.column ?? open?.column ?? '';
  const col = t?.columns.find((c) => c.name === column);
  const numeric = isNumeric(col), date = isDate(col);

  useEffect(() => {
    if (!open || !t) return;
    setErr(null);
    setPick(new Set());
    setG(existing ? structuredClone(existing) : {
      table: open.table, column, name: `${column} (${numeric || date ? 'intervalli' : 'gruppi'})`,
      kind: numeric || date ? 'bin' : 'list', groups: [], ...(numeric ? { bin: { size: 10 } } : date ? { bin: { size: 1, unit: 'year' as const } } : {}),
    });
    api.query(`SELECT DISTINCT CAST(${qi(column)} AS VARCHAR) AS v FROM ${qi(open.table)} ORDER BY 1 NULLS FIRST LIMIT 2000`)
      .then((r) => setValues(r.rows.map((x) => x.v ?? null))).catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open || !g || !t) return null;
  const close = () => s.set({ groupDialog: null });
  const grouped = new Set((g.groups ?? []).flatMap((x) => x.values));
  const free = values.filter((v) => !grouped.has(v));
  const upd = (p: Partial<Grouping>) => { setG({ ...g, ...p }); setErr(null); };

  const makeGroup = () => {
    const vals = free.filter((v) => pick.has(v));
    if (!vals.length) return;
    const name = vals.length === 1 ? show(vals[0]) : vals.slice(0, 2).map(show).join(' e ') + (vals.length > 2 ? ` e altri ${vals.length - 2}` : '');
    upd({ groups: [...(g.groups ?? []), { name, values: vals }] });
    setPick(new Set());
  };
  const ok = async () => {
    if (!g.name.trim()) return setErr('Specificare un nome per il gruppo.');
    if (g.kind === 'bin' && !(Number(g.bin?.size) > 0)) return setErr('La dimensione dell\'intervallo deve essere maggiore di zero.');
    if (g.kind === 'list' && !(g.groups ?? []).length) return setErr('Selezionare uno o più valori e fare clic su Gruppo.');
    setBusy(true);
    const e = await s.saveGrouping({ ...g, name: g.name.trim() }, existing?.name);
    setBusy(false);
    if (e) setErr(e); else close();
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog group-dlg">
        <div className="dh"><h2>{existing ? 'Modifica gruppi' : 'Gruppi'}</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db" style={{ flexDirection: 'column', gap: 10, overflow: 'auto' }}>
          <div className="pq-row" style={{ gap: 12 }}>
            <label className="pq-field" style={{ flex: 1 }}>Nome<input type="text" value={g.name} onChange={(e) => upd({ name: e.target.value })} /></label>
            <div className="pq-field" style={{ flex: 1 }}>Campo<span style={{ fontWeight: 400 }}>{t.name}[{column}]</span></div>
            <label className="pq-field">Tipo di gruppo
              <select value={g.kind} onChange={(e) => upd({ kind: e.target.value as Grouping['kind'], ...(e.target.value === 'bin' && !g.bin ? { bin: date ? { size: 1, unit: 'year' } : { size: 10 } } : {}) })}>
                <option value="list">Elenco</option>
                <option value="bin" disabled={!numeric && !date}>Intervallo</option>
              </select>
            </label>
          </div>
          {g.kind === 'bin' ? (
            <div className="pq-row" style={{ gap: 12 }}>
              <label className="pq-field">Dimensioni intervallo
                <input type="number" min={0} step="any" value={g.bin?.size ?? 1} onChange={(e) => upd({ bin: { ...g.bin, size: +e.target.value } })} />
              </label>
              {date && <label className="pq-field">Unità
                <select value={g.bin?.unit ?? 'year'} onChange={(e) => upd({ bin: { size: g.bin?.size ?? 1, unit: e.target.value as 'year' | 'month' } })}>
                  <option value="year">Anni</option><option value="month">Mesi</option>
                </select>
              </label>}
              <p className="pq-note" style={{ flex: 1 }}>Ogni valore viene sostituito dall'inizio del suo intervallo ({numeric ? `es. con 10: 0, 10, 20…` : 'es. 1 anno: 01/01 di ogni anno'}).</p>
            </div>
          ) : (
            <div className="group-lists">
              <div className="group-col">
                <b>Valori non raggruppati</b>
                <div className="group-box">
                  {free.map((v) => (
                    <label key={String(v)} className="chk"><input type="checkbox" checked={pick.has(v)} onChange={(e) => { const n = new Set(pick); if (e.target.checked) n.add(v); else n.delete(v); setPick(n); }} />{show(v)}</label>
                  ))}
                </div>
                <button className="btn" disabled={!free.some((v) => pick.has(v))} onClick={makeGroup}>Gruppo</button>
              </div>
              <div className="group-col">
                <b>Gruppi e membri</b>
                <div className="group-box">
                  {(g.groups ?? []).map((x, i) => (
                    <div key={i} className="group-item">
                      <div className="qna-row">
                        <input type="text" value={x.name} onChange={(e) => upd({ groups: g.groups!.map((y, k) => (k === i ? { ...y, name: e.target.value } : y)) })} />
                        <button title="Separa gruppo" onClick={() => upd({ groups: g.groups!.filter((_, k) => k !== i) })}><Icon name="close" size={12} /></button>
                      </div>
                      <span className="hint">{x.values.map(show).join(', ')}</span>
                    </div>
                  ))}
                  {!(g.groups ?? []).length && <span className="hint">Selezionare valori a sinistra e fare clic su Gruppo.</span>}
                </div>
                <label className="chk"><input type="checkbox" checked={g.other !== undefined} onChange={(e) => upd({ other: e.target.checked ? 'Altro' : undefined })} />Includi gruppo Altro</label>
                {g.other !== undefined && <input type="text" value={g.other} onChange={(e) => upd({ other: e.target.value })} />}
              </div>
            </div>
          )}
          {err && <div className="daxbar-err"><Icon name="warning" size={14} />{err}</div>}
        </div>
        <div className="df">
          <button className="btn primary" disabled={busy} onClick={() => void ok()}>OK</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
