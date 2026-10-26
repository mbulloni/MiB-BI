// Vista TMDL (left rail): model objects scripted as TMDL (`createOrReplace`) in editor tabs, edited and applied to the
// model (tmdlApply.ts), like Power BI Desktop's TMDL view. Scripts come from the TMSL that the exports use
// (pbit.ts#buildModelSchema), so what is shown is what a .pbip would contain.
import { useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { buildModelSchema } from '../pbix/pbit';
import { tmdlScript, type TmdlTarget } from '../pbix/tmdl';
import { applyTmdl } from '../tmdlApply';
import { Icon } from './icons';

type Tab = { name: string; text: string };
let saved: { tabs: Tab[]; cur: number } = { tabs: [{ name: 'Script 1', text: '' }], cur: 0 };

export function TmdlView() {
  const s = useStore();
  const [tabs, setTabs] = useState<Tab[]>(saved.tabs);
  const [cur, setCur] = useState(saved.cur);
  const [out, setOut] = useState<{ done: string[]; errors: string[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set(['Tabelle']));
  const ta = useRef<HTMLTextAreaElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  saved = { tabs, cur };
  const db = useMemo(() => buildModelSchema(s.report, s.tables), [s.report, s.tables]);
  const text = tabs[cur]?.text ?? '';
  const setText = (t: string) => setTabs(tabs.map((x, i) => (i === cur ? { ...x, text: t } : x)));
  const script = (target: TmdlTarget) => {
    const t = tmdlScript(db, target);
    if (!t) return;
    // Power BI: dropping an object opens its script; into an empty tab, or a new tab.
    if (!text.trim()) setText(t);
    else { setTabs([...tabs, { name: `Script ${tabs.length + 1}`, text: t }]); setCur(tabs.length); }
    setOut(null);
  };
  const apply = async () => {
    setBusy(true);
    try {
      const tree = await api.tmdlParse(text);
      setOut(await applyTmdl(tree));
    } catch (e: any) {
      setOut({ done: [], errors: [e.message.split('\n')[0]] });
    } finally { setBusy(false); }
  };
  const model = db.model as any;
  const groups: [string, { label: string; target: TmdlTarget; children?: { label: string; target: TmdlTarget }[] }[]][] = [
    ['Tabelle', (model.tables ?? []).filter((t: any) => !/^(LocalDateTable_|DateTableTemplate_)/.test(t.name)).map((t: any) => ({
      label: t.name, target: { kind: 'table', name: t.name } as TmdlTarget,
      children: [
        ...(t.measures ?? []).map((m: any) => ({ label: '∑ ' + m.name, target: { kind: 'measure', table: t.name, name: m.name } as TmdlTarget })),
        ...(t.columns ?? []).filter((c: any) => !c.isHidden || c.type === 'calculated').map((c: any) => ({ label: c.name, target: { kind: 'column', table: t.name, name: c.name } as TmdlTarget })),
        ...(t.hierarchies ?? []).map((h: any) => ({ label: '⋮ ' + h.name, target: { kind: 'hierarchy', table: t.name, name: h.name } as TmdlTarget })),
      ],
    }))],
    ['Relazioni', (model.relationships ?? []).filter((r: any) => !/^(LocalDateTable_|DateTableTemplate_)/.test(r.toTable)).map((r: any) => ({ label: `${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}]`, target: { kind: 'relationship', name: r.name } as TmdlTarget }))],
    ['Ruoli', (model.roles ?? []).map((r: any) => ({ label: r.name, target: { kind: 'role', name: r.name } as TmdlTarget }))],
    ['Prospettive', (model.perspectives ?? []).map((p: any) => ({ label: p.name, target: { kind: 'perspective', name: p.name } as TmdlTarget }))],
    ['Espressioni', (model.expressions ?? []).map((e: any) => ({ label: e.name, target: { kind: 'expression', name: e.name } as TmdlTarget }))],
    ['Funzioni', (model.functions ?? []).map((f: any) => ({ label: f.name, target: { kind: 'function', name: f.name } as TmdlTarget }))],
    ['Culture', (model.cultures ?? []).map((c: any) => ({ label: c.name, target: { kind: 'cultureInfo', name: c.name } as TmdlTarget }))],
  ];
  const flip = (k: string) => { const n = new Set(open); if (n.has(k)) n.delete(k); else n.add(k); setOpen(n); };
  const lines = text.split('\n').length;

  return (
    <div className="tmdlview">
      <div className="tmdl-tree">
        <div className="tmdl-tree-hd">Modello semantico<button className="btn-mini" title="Script dell'intero modello" onClick={() => script({ kind: 'model' })}>Script</button></div>
        {groups.map(([g, items]) => (
          <div key={g}>
            <div className="tnode" onClick={() => flip(g)}><Icon name={open.has(g) ? 'chevronDown' : 'chevronRight'} size={12} /><b>{g}</b><span className="hint">{items.length}</span></div>
            {open.has(g) && items.map((it) => (
              <div key={it.label}>
                <div className="tnode field" style={{ paddingLeft: 18 }} title="Doppio clic: script TMDL" onDoubleClick={() => script(it.target)}>
                  {it.children?.length ? <span onClick={(e) => { e.stopPropagation(); flip(g + '\u0001' + it.label); }}><Icon name={open.has(g + '\u0001' + it.label) ? 'chevronDown' : 'chevronRight'} size={12} /></span> : null}
                  <span className="nm">{it.label}</span>
                  <button className="tmdl-go" title="Script TMDL" onClick={(e) => { e.stopPropagation(); script(it.target); }}><Icon name="advancedEditor" size={13} box={32} /></button>
                </div>
                {open.has(g + '\u0001' + it.label) && it.children?.map((c) => (
                  <div key={c.label} className="tnode field" style={{ paddingLeft: 40 }} onDoubleClick={() => script(c.target)}>
                    <span className="nm">{c.label}</span>
                    <button className="tmdl-go" title="Script TMDL" onClick={() => script(c.target)}><Icon name="advancedEditor" size={13} box={32} /></button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="tmdl-main">
        <div className="daxview-bar">
          <button className="btn primary" onClick={() => void apply()} disabled={busy || !text.trim()}><Icon name="closeApply" size={14} box={32} />Applica</button>
          <button className="btn" onClick={() => script({ kind: 'model' })}>Script del modello</button>
          <span className="hint">Fare clic su ⟨script⟩ accanto a un oggetto (o doppio clic) per generarne lo script; modificarlo e scegliere Applica.</span>
        </div>
        <div className="daxview-tabs tmdl-tabs">
          {tabs.map((t, i) => (
            <button key={i} className={i === cur ? 'active' : ''} onClick={() => { setCur(i); setOut(null); }}>
              {t.name}
              {tabs.length > 1 && <span className="x" onClick={(e) => { e.stopPropagation(); const n = tabs.filter((_, k) => k !== i); setTabs(n); setCur(Math.min(cur, n.length - 1)); }}>×</span>}
            </button>
          ))}
          <button title="Nuova scheda" onClick={() => { setTabs([...tabs, { name: `Script ${tabs.length + 1}`, text: '' }]); setCur(tabs.length); setOut(null); }}>+</button>
        </div>
        <div className="daxview-editor">
          <div className="gutter" ref={gutter}>{Array.from({ length: lines }, (_, i) => <div key={i}>{i + 1}</div>)}</div>
          <textarea ref={ta} className="tmdl-text" spellCheck={false} value={text} data-no-i18n
            placeholder={'createOrReplace\n\n\tref table Vendite\n\n\t\tmeasure \'Totale vendite\' = SUM(Vendite[Importo])\n\t\t\tformatString: #,0.00'}
            onChange={(e) => setText(e.target.value)}
            onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault();
                const el = e.currentTarget, a = el.selectionStart;
                setText(text.slice(0, a) + '\t' + text.slice(el.selectionEnd));
                requestAnimationFrame(() => el.setSelectionRange(a + 1, a + 1));
              }
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void apply(); }
            }} />
        </div>
        <div className="tmdl-out">
          <div className="daxview-tabs"><button className="active">Output</button></div>
          {!out && <div className="pq-empty">Applica esegue lo script sul modello: <code>table</code> sostituisce misure, colonne calcolate e gerarchie della tabella; <code>ref table</code> aggiunge o modifica solo gli oggetti elencati.</div>}
          {out && (
            <div className="tmdl-log">
              {out.errors.map((e, i) => <div key={'e' + i} className="err"><Icon name="warning" size={13} />{e}</div>)}
              {out.done.length > 0 && <div className="ok">Applicato: {out.done.join(', ')}.</div>}
              {!out.errors.length && !out.done.length && <div>Nessun oggetto nello script.</div>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
