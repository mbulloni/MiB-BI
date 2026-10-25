// Prospettive (Modellazione › Prospettive): named subsets of the model's tables and fields. The Data pane shows the
// fields of the chosen perspective; exported as TMSL perspectives / TMDL perspectives/<name>.tmdl.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { Icon } from './icons';

type P = { name: string; fields: string[] };

export function PerspectivesDialog() {
  const s = useStore();
  const open = s.perspectivesDialog;
  const [list, setList] = useState<P[]>([]);
  const [sel, setSel] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (open) { setList((s.report.perspectives ?? []).map((p) => ({ ...p, fields: [...p.fields] }))); setSel(0); setErr(null); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  if (!open) return null;
  const close = () => s.set({ perspectivesDialog: false });
  const cur = list[sel];
  // Fields of each table: columns, measures, hierarchies (as in the Data pane).
  const tables = [...new Set([...s.tables.map((t) => t.name), ...s.report.measures.map((m) => m.table)])].map((name) => ({
    name,
    fields: [
      ...s.report.measures.filter((m) => m.table === name).map((m) => ({ name: m.name, kind: 'measure' })),
      ...(s.tables.find((t) => t.name === name)?.columns ?? []).map((c) => ({ name: c.name, kind: 'column' })),
      ...(s.report.hierarchies ?? []).filter((h) => h.table === name).map((h) => ({ name: h.name, kind: 'hierarchy' })),
    ],
  }));
  const key = (t: string, f: string) => `${t}\u0001${f}`;
  const update = (fields: string[]) => setList(list.map((p, i) => (i === sel ? { ...p, fields } : p)));
  const toggle = (k: string, on: boolean) => update(on ? [...new Set([...cur.fields, k])] : cur.fields.filter((x) => x !== k));
  const toggleTable = (t: { name: string; fields: { name: string }[] }, on: boolean) => {
    const ks = t.fields.map((f) => key(t.name, f.name));
    update(on ? [...new Set([...cur.fields, ...ks])] : cur.fields.filter((x) => !ks.includes(x)));
  };
  const add = () => {
    let n = 1;
    while (list.some((p) => p.name === `Prospettiva ${n}`)) n++;
    setList([...list, { name: `Prospettiva ${n}`, fields: [] }]);
    setSel(list.length);
  };
  const ok = () => {
    const names = list.map((p) => p.name.trim());
    if (names.some((n) => !n)) return setErr('Ogni prospettiva deve avere un nome.');
    if (new Set(names.map((n) => n.toLowerCase())).size !== names.length) return setErr('I nomi delle prospettive devono essere univoci.');
    s.setPerspectives(list.map((p) => ({ name: p.name.trim(), fields: p.fields })));
    close();
  };

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="dialog persp-dlg">
        <div className="dh"><h2>Prospettive</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db persp-body">
          <div className="persp-list">
            {list.map((p, i) => (
              <div key={i} className={'persp-item' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)}>
                {i === sel ? <input type="text" value={p.name} autoFocus onChange={(e) => setList(list.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} /> : <span>{p.name}</span>}
                <span className="hint">{p.fields.length}</span>
              </div>
            ))}
            <div className="qna-row">
              <button className="btn" onClick={add}><Icon name="plus" size={12} /> Nuova</button>
              <button className="btn" disabled={!cur} onClick={() => { setList(list.filter((_, i) => i !== sel)); setSel(Math.max(0, sel - 1)); }}><Icon name="trash" size={12} /> Elimina</button>
            </div>
          </div>
          <div className="persp-tree">
            {!cur ? <p className="pq-note">Una prospettiva mostra solo una parte del modello: nel riquadro Dati si sceglie quale prospettiva usare. Fare clic su <b>Nuova</b> per crearne una.</p>
              : tables.map((t) => {
                const n = t.fields.filter((f) => cur.fields.includes(key(t.name, f.name))).length;
                return (
                  <details key={t.name} open={n > 0 && n < t.fields.length}>
                    <summary>
                      <input type="checkbox" checked={n > 0 && n === t.fields.length} ref={(el) => { if (el) el.indeterminate = n > 0 && n < t.fields.length; }}
                        onChange={(e) => toggleTable(t, e.target.checked)} onClick={(e) => e.stopPropagation()} />
                      <Icon name="tableSmall" size={13} /> {t.name}
                    </summary>
                    {t.fields.map((f) => (
                      <label key={f.name} className="persp-field">
                        <input type="checkbox" checked={cur.fields.includes(key(t.name, f.name))} onChange={(e) => toggle(key(t.name, f.name), e.target.checked)} />
                        <Icon name={f.kind === 'measure' ? 'calc' : f.kind === 'hierarchy' ? 'hierarchy' : 'tableSmall'} size={12} /> {f.name}
                      </label>
                    ))}
                  </details>
                );
              })}
          </div>
        </div>
        {err && <div className="daxbar-err" style={{ margin: '0 16px' }}><Icon name="warning" size={14} />{err}</div>}
        <div className="df">
          <button className="btn primary" onClick={ok}>OK</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
