// Proprietà of a model object (Data pane › Proprietà): display folder of a field, user hierarchy levels,
// "Contrassegna come tabella delle date", calculation group precedence and column name.
import { useEffect, useState } from 'react';
import { dqCapable, useStore } from '../store';
import type { StorageMode } from '../types';
import { isDate } from '../format';
import { levelName } from '../types';
import { Icon } from './icons';

export function ModelProperties() {
  const s = useStore();
  const tg = s.propsTarget;
  const [folder, setFolder] = useState('');
  const [name, setName] = useState('');
  const [dateCol, setDateCol] = useState('');
  const [prec, setPrec] = useState('0');
  const [mode, setMode] = useState<StorageMode>('import');
  const [desc, setDesc] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const key = tg ? tg.table + '\u0001' + (tg.hierarchy ?? tg.field ?? '') : '';
  const g = tg ? s.report.calcGroups?.find((x) => x.table === tg.table) : undefined;
  useEffect(() => {
    if (!tg) return;
    setFolder(s.report.displayFolders?.[key] ?? '');
    setDesc(s.report.descriptions?.[tg.hierarchy ?? tg.field ? key : tg.table] ?? '');
    setName(tg.hierarchy ?? g?.column ?? '');
    setDateCol(s.report.dateTables?.[tg.table] ?? '');
    setPrec(String(g?.precedence ?? 0));
    setMode(s.tables.find((x) => x.name === tg.table)?.storageMode ?? 'import');
    setErr(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (!tg) return null;
  const t = s.tables.find((x) => x.name === tg.table);
  const h = tg.hierarchy ? s.report.hierarchies?.find((x) => x.table === tg.table && x.name === tg.hierarchy) : undefined;
  const close = () => s.set({ propsTarget: null });
  const field = tg.field ?? tg.hierarchy;
  const title = h ? 'Gerarchia' : tg.field ? (s.report.measures.some((m) => m.name === tg.field) ? 'Misura' : 'Colonna') : g ? 'Gruppo di calcolo' : 'Tabella';

  const ok = async () => {
    setErr(null);
    const dkey = field ? `${tg.table}\u0001${h && name.trim() ? name.trim() : field}` : tg.table;
    if (desc.trim() !== (s.report.descriptions?.[dkey] ?? '')) s.setDescription(dkey, desc);
    if (field) {
      if (h && name.trim() && name.trim() !== h.name) {
        if (s.report.hierarchies?.some((x) => x.table === tg.table && x.name === name.trim()) || t?.columns.some((c) => c.name === name.trim())) { setErr(`Il nome "${name.trim()}" è già usato nella tabella.`); return; }
        s.updateHierarchy(tg.table, h.name, { name: name.trim() });
        s.setDisplayFolder(tg.table, name.trim(), folder);
      } else s.setDisplayFolder(tg.table, field, folder);
    } else if (g) {
      const n = Number(prec);
      if (!Number.isInteger(n) || n < 0) { setErr('La precedenza deve essere un numero intero ≥ 0.'); return; }
      if (s.report.calcGroups!.some((x) => x !== g && x.precedence === n)) { setErr('Un altro gruppo di calcolo ha già questa precedenza.'); return; }
      if (!name.trim() || (t?.columns.some((c) => c.name === name.trim() && c.name !== g.column)) || name.trim() === 'Ordinal') { setErr('Nome di colonna non valido.'); return; }
      s.setCalcGroup(tg.table, { precedence: n, column: name.trim() });
    } else if (t) {
      const cur = s.report.dateTables?.[tg.table] ?? '';
      if (dateCol !== cur) {
        const e = await s.setDateTable(tg.table, dateCol || null);
        if (e) { setErr(`Impossibile contrassegnare come tabella delle date: ${e}`); return; }
      }
      if (mode !== (t.storageMode ?? 'import')) { close(); await s.setStorageMode(tg.table, mode); return; }
    }
    close();
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog props-dlg">
        <div className="dh"><h2>Proprietà — {title}</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db" style={{ flexDirection: 'column', gap: 12, overflow: 'auto' }}>
          {field && <>
            {h ? <label className="pq-field">Nome<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
              : <div className="pq-field">Nome<span style={{ fontWeight: 400 }}>{tg.table}[{field}]</span></div>}
            <label className="pq-field">Cartella di visualizzazione
              <input type="text" value={folder} placeholder="Es. Vendite\Totali" onChange={(e) => setFolder(e.target.value)} />
              <span className="hint">Usare \ per le sottocartelle. Vuoto = nessuna cartella.</span>
            </label>
          </>}
          {!g || field ? (
            <label className="pq-field">Descrizione
              <textarea rows={3} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Testo mostrato al passaggio del mouse nel riquadro Dati e usato da Q&A" />
            </label>
          ) : null}
          {h && (
            <div className="pq-field">Livelli
              <div className="hier-levels">
                {h.levels.map((l, i) => (
                  <div key={l} className="hier-level">
                    <Icon name="hierarchy" size={13} />
                    <input className="hier-name" value={levelName(h, l)} title={`Livello sulla colonna ${l}`}
                      onChange={(e) => { const names = { ...(h.levelNames ?? {}) }; if (e.target.value && e.target.value !== l) names[l] = e.target.value; else delete names[l]; s.updateHierarchy(h.table, h.name, { levelNames: names }); }} />
                    {levelName(h, l) !== l && <span className="hint">{l}</span>}
                    <button title="Sposta su" disabled={i === 0} onClick={() => { const lv = [...h.levels]; [lv[i - 1], lv[i]] = [lv[i], lv[i - 1]]; s.updateHierarchy(h.table, h.name, { levels: lv }); }}><Icon name="chevronUp" size={12} /></button>
                    <button title="Sposta giù" disabled={i === h.levels.length - 1} onClick={() => { const lv = [...h.levels]; [lv[i + 1], lv[i]] = [lv[i], lv[i + 1]]; s.updateHierarchy(h.table, h.name, { levels: lv }); }}><Icon name="chevronDown" size={12} /></button>
                    <button title="Rimuovi" disabled={h.levels.length === 1} onClick={() => s.updateHierarchy(h.table, h.name, { levels: h.levels.filter((x) => x !== l) })}><Icon name="close" size={12} /></button>
                  </div>
                ))}
              </div>
              <select value="" onChange={(e) => { if (e.target.value) s.addHierarchyLevel(h.table, h.name, e.target.value); }}>
                <option value="">+ Aggiungi livello…</option>
                {t?.columns.filter((c) => !h.levels.includes(c.name)).map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
            </div>
          )}
          {!field && g && <>
            <label className="pq-field">Precedenza<input type="number" min={0} step={1} value={prec} onChange={(e) => setPrec(e.target.value)} />
              <span className="hint">Con più gruppi di calcolo, quello con precedenza maggiore viene applicato per primo (più esterno).</span></label>
            <label className="pq-field">Nome della colonna<input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
          </>}
          {!field && !g && t && !t.source.dax && (
            <div className="pq-field">Modalità di archiviazione
              <select value={mode} onChange={(e) => setMode(e.target.value as StorageMode)}>
                <option value="import">Importazione</option>
                <option value="directQuery" disabled={!dqCapable(t)}>DirectQuery</option>
                <option value="dual">Doppia</option>
              </select>
              <span className="hint">{mode === 'directQuery' ? 'I dati restano nell\'origine: ogni oggetto visivo li legge al momento della query (vista sul database).'
                : mode === 'dual' ? 'Tabella importata che Power BI può anche interrogare in DirectQuery insieme alle tabelle DirectQuery; in MiB-BI si comporta come Importazione.'
                : 'I dati vengono copiati nel modello e riletti con Aggiorna.'}{!dqCapable(t) ? ' DirectQuery è disponibile solo per le origini database.' : ''}</span>
            </div>
          )}
          {!field && !g && t && (
            <div className="pq-field">Contrassegna come tabella delle date
              <span className="hint">Le funzioni di Business Intelligence per le gerarchie temporali usano questa tabella; la colonna deve avere date univoche, senza valori vuoti e senza giorni mancanti.</span>
              <select value={dateCol} onChange={(e) => setDateCol(e.target.value)}>
                <option value="">(Non contrassegnata)</option>
                {t.columns.filter((c) => isDate(c)).map((c) => <option key={c.name}>{c.name}</option>)}
              </select>
              {!t.columns.some((c) => isDate(c)) && <span className="hint">La tabella non ha colonne di tipo data.</span>}
            </div>
          )}
          {err && <div className="daxbar-err"><Icon name="warning" size={14} />{err}</div>}
        </div>
        <div className="df">
          <button className="btn primary" onClick={() => void ok()}>OK</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
