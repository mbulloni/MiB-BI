// Visual calculations edit mode (Power BI "Nuovo calcolo visivo"): the visual on top, the formula bar,
// and the visual matrix below with every field, hidden ones included (eye icon toggles visibility).
import { useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { refLabel, fmtFull, fmtWith } from '../format';
import { useVisualData } from '../visuals/useVisualData';
import { CALC_TEMPLATES, isCalc } from '../visuals/visualCalc';
import { VisualBody } from './VisualContainer';
import { DaxInput } from './DaxInput';
import { Icon } from './icons';
import { Menu } from './Menu';
import type { Visual } from '../types';

const FORMATS: [string, string][] = [['', 'Automatico'], ['#,0', 'Numero intero'], ['#,0.00', 'Numero decimale'], ['0.00%', 'Percentuale'], ['€ #,0.00', 'Valuta (€)']];

export function VisualCalcEditor() {
  const s = useStore();
  const ed = s.calcEdit!;
  const v = s.report.pages.flatMap((p) => p.visuals).find((x) => x.id === ed.visualId);
  const ref = useRef<HTMLTextAreaElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
  }, [ed.original]);
  if (!v) return null;
  const set = (patch: Partial<typeof ed>) => s.set({ calcEdit: { ...ed, ...patch, error: patch.error } });
  const close = () => s.set({ calcEdit: null });
  const calcs = Object.values(v.fields).flat().filter(isCalc);
  return (
    <div className="vc-edit">
      <div className="vc-edit-bar">
        <b>Calcoli visivi</b>
        <select value={ed.original ?? ''} onChange={(e) => (e.target.value ? s.startVisualCalc(v.id, e.target.value) : s.startVisualCalc(v.id))} title="Calcolo da modificare">
          {calcs.map((c) => <option key={c.column} value={c.column}>{c.column}</option>)}
          <option value="">Nuovo calcolo…</option>
        </select>
        <button className="btn" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left, y: r.bottom + 2 }); }}>Modelli<Icon name="chevronDown" size={10} /></button>
        <label>Formato <select value={ed.format ?? ''} onChange={(e) => set({ format: e.target.value || undefined })}>{FORMATS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={close}>← Torna al report</button>
      </div>
      <div className="daxbar-row vc-formula">
        <button title="Annulla" onClick={close}><Icon name="close" size={14} /></button>
        <button title="Conferma" className="ok" onClick={() => s.saveVisualCalc()}>✓</button>
        <DaxInput ref={ref} rows={Math.min(8, Math.max(1, ed.text.split('\n').length))} value={ed.text} home=""
          onChange={(text) => set({ text })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); s.saveVisualCalc(); }
            if (e.key === 'Escape') close();
          }} />
      </div>
      {ed.error && <div className="daxbar-err"><Icon name="warning" size={14} />{ed.error}</div>}
      {/* The visual keeps the report theme (light canvas), the rest follows the app theme. */}
      <div className="vc-edit-preview focus-view"><VisualBody v={v} selected={false} /></div>
      <div className="vc-edit-matrix"><VisualMatrix v={v} /></div>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          {CALC_TEMPLATES.map((t) => <button key={t.label} onClick={() => { s.startVisualCalc(v.id, undefined, t); setMenu(null); }}>{t.label}</button>)}
        </Menu>
      )}
    </div>
  );
}

/** The data of the visual as Power BI's visual matrix: every field, visual calculations included. */
function VisualMatrix({ v }: { v: Visual }) {
  const s = useStore();
  const data = useVisualData(v);
  if (data.error) return <div className="vc-error"><span>{data.error}</span></div>;
  const where = (alias: string) => {
    const it = data.allItems.find((i) => i.alias === alias)!;
    const list = v.fields[it.well] ?? [];
    return { well: it.well, idx: list.findIndex((f) => f.table === it.field.table && f.column === it.field.column && f.agg === it.field.agg) };
  };
  const cell = (x: unknown, alias: string) => {
    if (x === null || x === undefined) return '';
    const f = data.allItems.find((i) => i.alias === alias)?.field.format;
    return typeof x === 'number' ? (f ? fmtWith(x, f) : fmtFull(x)) : String(x);
  };
  return (
    <div className="tbl focus-tbl">
      <table>
        <thead><tr>{data.allItems.map((i) => {
          const w = where(i.alias);
          return (
            <th key={i.alias} className={(i.measure ? 'num' : '') + (i.field.hidden ? ' vc-hidden' : '')}>
              {isCalc(i.field) && <i className="fx-ico" style={{ marginRight: 4 }}>fx</i>}
              {refLabel(i.field)}
              {i.measure && w.idx >= 0 && (
                <button className="vc-eye" title={i.field.hidden ? "Mostra nell'oggetto visivo" : "Nascondi nell'oggetto visivo"} onClick={() => s.toggleFieldHidden(v.id, w.well, w.idx)}>
                  <Icon name={i.field.hidden ? 'eyeOff' : 'eye'} size={13} />
                </button>
              )}
              {isCalc(i.field) && <button className="vc-eye" title="Modifica calcolo" onClick={() => s.startVisualCalc(v.id, i.field.column)}><Icon name="calc" size={13} /></button>}
            </th>
          );
        })}</tr></thead>
        <tbody>
          {data.rows.slice(0, 2000).map((r, n) => <tr key={n}>{data.allItems.map((i) => <td key={i.alias} className={(i.measure ? 'num' : '') + (i.field.hidden ? ' vc-hidden' : '')}>{cell(r[i.alias], i.alias)}</td>)}</tr>)}
          {data.totals?.map((r, n) => <tr key={'t' + n} className="total">{data.allItems.map((i, k) => <td key={i.alias} className={i.measure ? 'num' : ''}>{k === 0 && !i.measure ? 'Totale' : i.measure ? cell(r[i.alias], i.alias) : ''}</td>)}</tr>)}
        </tbody>
      </table>
    </div>
  );
}
