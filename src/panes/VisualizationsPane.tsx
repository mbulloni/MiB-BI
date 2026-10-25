import { NO_CALCS, TOTAL_LABEL } from '../visuals/visualCalc';
import { useState, type ReactNode } from 'react';
import { useStore, defaultFormat } from '../store';
import { uid } from '../format';
import type { Agg, AnalyticsLine, Visual, VisualFormat } from '../types';
import { analyticsKinds, KIND_LABEL, supportsAnalytics } from '../visuals/analytics';
import { VISUALS, visualDef, isChart, customName, customPkg } from '../visuals/catalog';
import { dataViewObjects, persist } from '../visuals/custom/objects';
import type { CustomVisualPkg } from '../types';
import { AGG_LABEL, fieldLabel, isNumeric } from '../format';
import { Icon, VisualIcon } from '../components/icons';
import { Menu, Toggle } from '../components/Menu';
import { FIELD_MIME } from '../components/VisualContainer';
import { DEFAULT_CF, fieldKey, ICON_SET } from '../visuals/condfmt';
import { sp } from '../visuals/pbistyle';
import { THEME } from '../themes';
import { fieldKind } from '../query';
import { bname, sname } from '../pbix/layout';
import type { CfRule, ColorScale, CondFormat, FieldRef, Page } from '../types';

function ColorPick({ label, value, onChange }: { label: string; value: string; onChange: (c: string) => void }) {
  return (
    <label className="fmt-row"><span>{label}</span>
      <span className="colorpick"><input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />{value.toUpperCase()}</span>
    </label>
  );
}

function ScaleEditor({ scale, onChange }: { scale: ColorScale; onChange: (s: ColorScale) => void }) {
  const numIn = (label: string, k: 'minValue' | 'midValue' | 'maxValue') => (
    <label className="fmt-row"><span>{label}</span>
      <input type="number" placeholder="Automatico" value={scale[k] ?? ''} onChange={(e) => onChange({ ...scale, [k]: e.target.value === '' ? undefined : +e.target.value })} /></label>
  );
  return <>
    <ColorPick label="Valore minimo" value={scale.min} onChange={(min) => onChange({ ...scale, min })} />
    {numIn('Valore minimo (numero)', 'minValue')}
    <div className="fmt-row inline"><span>Aggiungi colore centrale</span><Toggle on={!!scale.mid} onChange={(b) => onChange({ ...scale, mid: b ? '#FFEB84' : undefined, ...(b ? {} : { midValue: undefined }) })} /></div>
    {scale.mid && <ColorPick label="Valore centrale" value={scale.mid} onChange={(mid) => onChange({ ...scale, mid })} />}
    {scale.mid && numIn('Valore centrale (numero)', 'midValue')}
    <ColorPick label="Valore massimo" value={scale.max} onChange={(max) => onChange({ ...scale, max })} />
    {numIn('Valore massimo (numero)', 'maxValue')}
  </>;
}

/** "Regole": if value >= min and < max then color/icon (rows in order, first match wins). */
function RulesEditor({ rules, onChange, icons }: { rules: CfRule[]; onChange: (r: CfRule[]) => void; icons?: boolean }) {
  const set = (i: number, patch: Partial<CfRule>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const n = (x: string) => (x === '' ? undefined : +x);
  return <div className="cf-rules">
    {rules.map((r, i) => (
      <div key={i} className="cf-rule">
        {r.blank ? <span>Se il valore è vuoto</span> : <>
          <span>Se</span>
          <select value={r.minInc === false ? '>' : '>='} onChange={(e) => set(i, { minInc: e.target.value === '>=' })}><option value=">=">≥</option><option value=">">&gt;</option></select>
          <input type="number" placeholder="min" value={r.min ?? ''} onChange={(e) => set(i, { min: n(e.target.value) })} />
          <span>e</span>
          <select value={r.maxInc ? '<=' : '<'} onChange={(e) => set(i, { maxInc: e.target.value === '<=' })}><option value="<">&lt;</option><option value="<=">≤</option></select>
          <input type="number" placeholder="max" value={r.max ?? ''} onChange={(e) => set(i, { max: n(e.target.value) })} />
        </>}
        <span>allora</span>
        {icons
          ? <select value={r.value} onChange={(e) => set(i, { value: e.target.value })}>{Object.keys(ICON_SET).map((k) => <option key={k} value={k}>{ICON_SET[k].ch} {k}</option>)}</select>
          : <input type="color" value={r.value} onChange={(e) => set(i, { value: e.target.value.toUpperCase() })} />}
        <button title="Elimina regola" onClick={() => onChange(rules.filter((_, j) => j !== i))}><Icon name="close" size={11} /></button>
      </div>
    ))}
    <div style={{ display: 'flex', gap: 6 }}>
      <button className="btn" onClick={() => onChange([...rules, { min: 0, max: 100, value: icons ? 'CircleHigh' : '#1AAB40' }])}>+ Nuova regola</button>
      {!rules.some((r) => r.blank) && <button className="btn" onClick={() => onChange([...rules, { blank: true, value: icons ? 'CircleEmpty' : '#C8C6C4' }])}>+ Valori vuoti</button>}
    </div>
  </div>;
}

/** Numeric fields of the model usable as "In base al campo" (measures and summed numeric columns). */
function useInputFields(): { label: string; f: FieldRef }[] {
  const s = useStore();
  return [
    ...s.report.measures.map((m) => ({ label: `${m.table}[${m.name}]`, f: { table: m.table, column: m.name, agg: 'measure' as const } })),
    ...s.tables.flatMap((t) => t.columns.filter((c) => isNumeric(c)).map((c) => ({ label: `Somma di ${t.name}[${c.name}]`, f: { table: t.name, column: c.name, agg: 'sum' as const } }))),
  ];
}

function InputPick({ value, onChange, self, label }: { value?: FieldRef; onChange: (f?: FieldRef) => void; self?: string; label?: string }) {
  const opts = useInputFields();
  const cur = value ? opts.findIndex((o) => fieldKey(o.f) === fieldKey(value)) : -1;
  return <label className="fmt-row"><span>{label ?? 'In base al campo'}</span>
    <select value={cur} onChange={(e) => onChange(+e.target.value < 0 ? undefined : opts[+e.target.value].f)}>
      <option value={-1}>{self ?? '(campo stesso)'}</option>
      {opts.map((o, i) => <option key={i} value={i}>{o.label}</option>)}
    </select></label>;
}

/** Gradient or rules for one color (background / font / chart data colors). */
function ColorFormatEditor({ title, scale, rules, def, onChange }: {
  title: string; scale?: ColorScale; rules?: CfRule[]; def: ColorScale; onChange: (scale?: ColorScale, rules?: CfRule[]) => void;
}) {
  const on = !!scale || !!rules?.length;
  const style = rules?.length ? 'rules' : 'gradient';
  return <>
    <div className="fmt-row inline"><span>{title}</span><Toggle on={on} onChange={(b) => onChange(b ? def : undefined, undefined)} /></div>
    {on && <label className="fmt-row"><span>Stile formato</span>
      <select value={style} onChange={(e) => (e.target.value === 'rules' ? onChange(undefined, [{ max: 0, value: '#D64554' }, { min: 0, value: '#1AAB40' }]) : onChange(def, undefined))}>
        <option value="gradient">Sfumatura</option><option value="rules">Regole</option>
      </select></label>}
    {on && style === 'gradient' && scale && <ScaleEditor scale={scale} onChange={(sc) => onChange(sc, undefined)} />}
    {on && style === 'rules' && <RulesEditor rules={rules!} onChange={(r) => onChange(undefined, r.length ? r : undefined)} />}
  </>;
}

/** Table/matrix: conditional formatting per field (values, and columns when driven by another field). */
function CondFormatCard({ v }: { v: Visual }) {
  const s = useStore();
  const items = visualDef(v.type, v.custom).wells.flatMap((w) => v.fields[w.key] ?? []);
  const [sel, setSel] = useState(Math.max(0, items.findIndex((f) => f.agg !== 'none')));
  const f = items[Math.min(sel, items.length - 1)];
  if (!f) return <Card title="Formattazione condizionale"><div style={{ color: 'var(--text2)' }}>Aggiungere un campo.</div></Card>;
  const key = fieldKey(f);
  const cf: CondFormat = v.format.cf?.[key] ?? {};
  const set = (patch: Partial<CondFormat>) => {
    const next = { ...cf, ...patch };
    for (const k of Object.keys(next) as (keyof CondFormat)[]) if (next[k] === undefined || next[k] === false || (Array.isArray(next[k]) && !(next[k] as unknown[]).length)) delete next[k];
    if (Object.keys(next).length === 1 && next.input) delete next.input;
    const all = { ...(v.format.cf ?? {}) };
    if (Object.keys(next).length) all[key] = next; else delete all[key];
    s.updateFormat(v.id, { cf: all });
  };
  return (
    <Card title="Formattazione condizionale" defaultOpen={!!v.format.cf && Object.keys(v.format.cf).length > 0}>
      <label className="fmt-row"><span>Applica al campo</span>
        <select value={items.indexOf(f)} onChange={(e) => setSel(+e.target.value)}>
          {items.map((x, i) => <option key={i} value={i}>{fieldLabel(x)}</option>)}
        </select>
      </label>
      <InputPick value={cf.input} onChange={(input) => set({ input })} self={f.agg === 'none' ? '(scegliere un campo numerico)' : undefined} />
      <ColorFormatEditor title="Colore di sfondo" scale={cf.background} rules={cf.bgRules} def={DEFAULT_CF.background} onChange={(background, bgRules) => set({ background, bgRules })} />
      <ColorFormatEditor title="Colore carattere" scale={cf.font} rules={cf.fontRules} def={DEFAULT_CF.font} onChange={(font, fontRules) => set({ font, fontRules })} />
      <div className="fmt-row inline"><span>Barre dei dati</span><Toggle on={!!cf.bars} onChange={(b) => set({ bars: b ? DEFAULT_CF.bars : undefined })} /></div>
      {cf.bars && <>
        <ColorPick label="Barra positiva" value={cf.bars.positive} onChange={(positive) => set({ bars: { ...cf.bars!, positive } })} />
        <ColorPick label="Barra negativa" value={cf.bars.negative} onChange={(negative) => set({ bars: { ...cf.bars!, negative } })} />
      </>}
      <div className="fmt-row inline"><span>Icone</span><Toggle on={!!cf.icons} onChange={(b) => set({ icons: b || undefined, iconRules: undefined })} /></div>
      {cf.icons && <label className="fmt-row"><span>Stile icone</span>
        <select value={cf.iconRules?.length ? 'rules' : 'auto'} onChange={(e) => set({ iconRules: e.target.value === 'rules' ? [{ max: 0, value: 'TriangleLow' }, { min: 0, value: 'TriangleHigh' }] : undefined })}>
          <option value="auto">Automatico (terzi dell'intervallo)</option><option value="rules">Regole</option>
        </select></label>}
      {cf.icons && !!cf.iconRules?.length && <RulesEditor icons rules={cf.iconRules} onChange={(iconRules) => set({ iconRules })} />}
    </Card>
  );
}

function Wells({ v }: { v: Visual }) {
  const s = useStore();
  const def = visualDef(v.type, v.custom);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ well: string; idx: number; x: number; y: number } | null>(null);
  const colMeta = (t: string, c: string) => s.tables.find((x) => x.name === t)?.columns.find((x) => x.name === c);

  if (!def.wells.length) return null;
  const mf = menu ? v.fields[menu.well]?.[menu.idx] : undefined;
  const numeric = mf ? isNumeric(colMeta(mf.table, mf.column)) : false;
  const aggs: Agg[] = numeric ? ['sum', 'avg', 'min', 'max', 'countd', 'count', 'stdev', 'var', 'median', 'none'] : ['none', 'min', 'max', 'countd', 'count'];
  const wellIsMeasure = menu ? def.wells.find((w) => w.key === menu.well)?.measure : false;

  return (
    <div className="wells">
      {def.wells.map((w) => (
        <div
          key={w.key}
          className={'well' + (over === w.key ? ' over' : '')}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(FIELD_MIME)) { e.preventDefault(); setOver(w.key); } }}
          onDragLeave={() => setOver(null)}
          onDrop={(e) => { setOver(null); const raw = e.dataTransfer.getData(FIELD_MIME); if (raw) s.addField(v.id, JSON.parse(raw), w.key); }}
        >
          <div className="wl">{w.label}</div>
          {(v.fields[w.key] ?? []).map((f, i) => (
            <div className={'pill' + (f.hidden ? ' hidden-field' : '')} key={i} title={f.agg === 'visualCalc' ? `Calcolo visivo: ${f.column} = ${f.calc}` : `${f.table}[${f.column}]${f.hidden ? " (nascosto nell'oggetto visivo)" : ''}`}
              onDoubleClick={() => f.agg === 'visualCalc' && s.startVisualCalc(v.id, f.column)}>
              {f.agg === 'visualCalc' && <i className="fx-ico">fx</i>}
              {f.hidden && <Icon name="eyeOff" size={12} />}
              <span className="nm">{fieldLabel(f)}</span>
              <button title="Opzioni" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ well: w.key, idx: i, x: r.left - 160, y: r.bottom + 2 }); }}><Icon name="chevronDown" size={12} /></button>
              <button title="Rimuovi campo" onClick={() => s.removeField(v.id, w.key, i)}><Icon name="close" size={11} /></button>
            </div>
          ))}
          {(!w.max || (v.fields[w.key]?.length ?? 0) < w.max) && <div className={'add' + (over === w.key ? ' over' : '')}>Aggiungi campi dati qui</div>}
        </div>
      ))}
      {menu && mf && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => { s.removeField(v.id, menu.well, menu.idx); setMenu(null); }}>Rimuovi campo</button>
          {mf.agg === 'visualCalc' && <button onClick={() => { s.startVisualCalc(v.id, mf.column); setMenu(null); }}>Modifica calcolo</button>}
          {(mf.agg !== 'none' || v.type === 'table') && !NO_CALCS.has(v.type) && <button onClick={() => { s.toggleFieldHidden(v.id, menu.well, menu.idx); setMenu(null); }}>{mf.hidden ? "Mostra nell'oggetto visivo" : "Nascondi nell'oggetto visivo"}</button>}
          {mf.agg === 'none' && def.wells.find((w) => w.key === menu.well)?.hierarchy && /^(DATE|TIMESTAMP)/i.test(colMeta(mf.table, mf.column)?.type ?? '') && <>
            <hr />
            <button onClick={() => { s.setDateHierarchy(v.id, menu.well, menu.idx, false); setMenu(null); }}><span style={{ width: 12 }}>{mf.datePart ? '' : '✓'}</span>{mf.column}</button>
            <button onClick={() => { s.setDateHierarchy(v.id, menu.well, menu.idx, true); setMenu(null); }}><span style={{ width: 12 }}>{mf.datePart ? '✓' : ''}</span>Gerarchia date</button>
          </>}
          {(v.type === 'table' || v.type === 'matrix') && mf.agg !== 'none' && <>
            <hr />
            <div className="hdr">Totali personalizzati</div>
            {([undefined, 'sum', 'avg', 'min', 'max', 'count', 'first', 'last', 'none'] as const).map((t) => (
              <button key={t ?? 'default'} onClick={() => { s.setFieldTotal(v.id, menu.well, menu.idx, t); setMenu(null); }}>
                <span style={{ width: 12 }}>{mf.total === t ? '✓' : ''}</span>{t ? TOTAL_LABEL[t] : 'Predefinito'}
              </button>
            ))}
          </>}
          {mf.agg !== 'measure' && mf.agg !== 'visualCalc' && <hr />}
          {mf.agg !== 'measure' && mf.agg !== 'visualCalc' && aggs.filter((a) => !(wellIsMeasure && a === 'none' && v.type !== 'table')).map((a) => (
            <button key={a} onClick={() => { s.setFieldAgg(v.id, menu.well, menu.idx, a); setMenu(null); }}>
              <span style={{ width: 12 }}>{mf.agg === a ? '✓' : ''}</span>{AGG_LABEL[a]}
            </button>
          ))}
        </Menu>
      )}
    </div>
  );
}

function Card({ title, toggle, children, defaultOpen = false }: { title: string; toggle?: [boolean, (b: boolean) => void]; children?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="fmt-card">
      <div className="fc-head" onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={12} />
        <span className="sp">{title}</span>
        {toggle && <span onClick={(e) => e.stopPropagation()}><Toggle on={toggle[0]} onChange={toggle[1]} /></span>}
      </div>
      {open && children && <div className="fc-body">{children}</div>}
    </div>
  );
}

/** Category of a chart that can use a continuous axis: a single date or number column (no hierarchy levels). */
function axisKind(v: Visual, tables: import('../types').TableMeta[]): 'date' | 'number' | null {
  const cats = v.fields.category ?? [];
  if (cats.length !== 1 || cats[0].agg !== 'none' || cats[0].datePart) return null;
  const t = tables.find((x) => x.name === cats[0].table)?.columns.find((c) => c.name === cats[0].column)?.type.toUpperCase() ?? '';
  return /^(DATE|TIMESTAMP)/.test(t) ? 'date' : /INT|DOUBLE|DECIMAL|FLOAT|REAL|NUMERIC/.test(t) ? 'number' : null;
}

/** Label of a capabilities entry (displayNameKey resolved through the package's string resources). */
function cvLabel(pkg: CustomVisualPkg, x: any, fallback: string): string {
  const res = pkg.pbiviz?.stringResources ?? {};
  const key = x?.displayNameKey;
  return (key && (res['it-IT']?.[key] ?? res['en-US']?.[key])) ?? x?.displayName ?? fallback;
}

/** Format pane of a custom visual, generated from its capabilities.objects (values in Visual.style.objects). */
function CustomFormatCards({ v }: { v: Visual }) {
  const s = useStore();
  const pkg = customPkg(v.custom);
  if (!pkg) return null;
  const caps = pkg.pbiviz?.capabilities?.objects ?? {};
  const current = dataViewObjects(v.style?.objects).plain;
  const set = (obj: string, prop: string, value: unknown) => s.updateVisual(v.id, {
    style: { ...v.style, objects: persist(v.style?.objects, { merge: [{ objectName: obj, selector: null, properties: { [prop]: value } }] }) },
  });
  const editor = (obj: string, prop: string, def: any) => {
    const t = def?.type ?? {};
    const cur = current[obj]?.[prop];
    const label = cvLabel(pkg, def, prop);
    if (t.bool) return <div key={prop} className="fmt-row inline"><span>{label}</span><Toggle on={!!cur} onChange={(b) => set(obj, prop, b)} /></div>;
    if (t.enumeration) {
      const opts: any[] = Array.isArray(t.enumeration) ? t.enumeration : t.enumeration.members?.() ?? [];
      return <label key={prop} className="fmt-row"><span>{label}</span>
        <select value={cur ?? ''} onChange={(e) => set(obj, prop, opts.find((o) => String(o.value) === e.target.value)?.value ?? e.target.value)}>
          {cur === undefined && <option value="">(predefinito)</option>}
          {opts.map((o) => <option key={String(o.value)} value={String(o.value)}>{cvLabel(pkg, o, String(o.value))}</option>)}
        </select></label>;
    }
    if (t.fill?.solid?.color) return <ColorPick key={prop} label={label} value={cur?.solid?.color ?? '#000000'} onChange={(c) => set(obj, prop, { solid: { color: c } })} />;
    if (t.numeric || t.integer || t.formatting?.fontSize) {
      return <label key={prop} className="fmt-row"><span>{label}</span>
        <input type="number" value={cur ?? ''} placeholder="(predefinito)" onChange={(e) => set(obj, prop, e.target.value === '' ? null : t.integer ? Math.round(+e.target.value) : +e.target.value)} /></label>;
    }
    if (t.formatting?.alignment) return <label key={prop} className="fmt-row"><span>{label}</span>
      <select value={cur ?? ''} onChange={(e) => set(obj, prop, e.target.value)}>
        <option value="">(predefinito)</option><option value="left">A sinistra</option><option value="center">Al centro</option><option value="right">A destra</option>
      </select></label>;
    if (t.text || t.formatting?.fontFamily) return <label key={prop} className="fmt-row"><span>{label}</span><input type="text" value={cur ?? ''} onChange={(e) => set(obj, prop, e.target.value)} /></label>;
    return null; // filters, images, data-bound properties: not editable here
  };
  const cards = Object.entries<any>(caps).map(([obj, def]) => {
    const props = Object.entries<any>(def.properties ?? {});
    const show = props.find(([k, p]) => k === 'show' && p.type?.bool);
    const rows = props.filter(([k]) => k !== 'show' || !show).map(([k, p]) => editor(obj, k, p)).filter(Boolean);
    if (!rows.length && !show) return null;
    return (
      <Card key={obj} title={cvLabel(pkg, def, obj)} toggle={show ? [current[obj]?.show !== false && (current[obj]?.show ?? true), (b) => set(obj, 'show', b)] : undefined}>
        {rows.length ? rows : undefined}
      </Card>
    );
  }).filter(Boolean);
  return <>{cards.length ? cards : <div style={{ color: 'var(--text2)', padding: '10px 0' }}>L'oggetto visivo non dichiara opzioni di formato.</div>}</>;
}

const ACTIONS: [string, string][] = [['Back', 'Indietro'], ['Bookmark', 'Segnalibro'], ['Drillthrough', 'Drill-through'], ['PageNavigation', 'Spostamento tra le pagine'], ['QnA', 'Q&A'], ['WebUrl', 'URL Web'], ['ApplyAllSlicers', 'Applica tutti i filtri dei dati'], ['ClearAllSlicers', 'Cancella tutti i filtri dei dati']];

/** Button "Azione" card: vcObjects.visualLink (type, destination, tooltip), stored as Power BI literals. */
function ActionCard({ v }: { v: Visual }) {
  const s = useStore();
  const get = (p: string) => sp(v, 'visualLink', p);
  const put = (patch: Record<string, string | boolean | undefined>) => {
    const vc = { ...(v.style?.vcObjects ?? {}) };
    const props = { ...(vc.visualLink?.find((e) => !e.selector)?.properties ?? {}) };
    for (const [k, x] of Object.entries(patch)) {
      if (x === undefined || x === '') delete props[k];
      else props[k] = { expr: { Literal: { Value: typeof x === 'boolean' ? String(x) : `'${x.replace(/'/g, "''")}'` } } };
    }
    vc.visualLink = [{ properties: props }];
    s.updateVisual(v.id, { style: { ...v.style, vcObjects: vc } });
  };
  const type = String(get('type') ?? '');
  const tip = get('tooltip');
  return (
    <Card title="Azione" toggle={[get('show') !== false && !!type, (b) => put({ show: b, ...(b && !type ? { type: 'Back' } : {}) })]} defaultOpen>
      <label className="fmt-row"><span>Tipo</span>
        <select value={type} onChange={(e) => put({ type: e.target.value, show: true })}>
          {!type && <option value="">(nessuna)</option>}
          {ACTIONS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select></label>
      {type === 'Bookmark' && <label className="fmt-row"><span>Segnalibro</span>
        <select value={String(get('bookmark') ?? '')} onChange={(e) => put({ bookmark: e.target.value })}>
          <option value="">Nessuno</option>
          {(s.report.bookmarks ?? []).map((b) => <option key={b.id} value={bname(b)}>{b.name}</option>)}
        </select></label>}
      {type === 'PageNavigation' && <label className="fmt-row"><span>Destinazione</span>
        <select value={String(get('navigationSection') ?? '')} onChange={(e) => put({ navigationSection: e.target.value })}>
          <option value="">Nessuna</option>
          {s.report.pages.map((p) => <option key={p.id} value={sname(p)}>{p.name}</option>)}
        </select></label>}
      {type === 'Drillthrough' && <>
        <label className="fmt-row"><span>Destinazione</span>
          <select value={String(get('drillthroughSection') ?? '')} onChange={(e) => put({ drillthroughSection: e.target.value })}>
            <option value="">Nessuna</option>
            {s.report.pages.filter((p) => p.drillthrough).map((p) => <option key={p.id} value={sname(p)}>{p.name}</option>)}
          </select></label>
        {!s.report.pages.some((p) => p.drillthrough) && <div style={{ color: 'var(--text2)', fontSize: 11 }}>Nessuna pagina con campi di drill-through.</div>}
      </>}
      {type === 'WebUrl' && <label className="fmt-row"><span>URL Web</span><input type="text" value={String(get('webUrl') ?? '')} placeholder="https://" onChange={(e) => put({ webUrl: e.target.value })} /></label>}
      <label className="fmt-row"><span>Descrizione comando</span><input type="text" value={typeof tip === 'string' ? tip : ''} placeholder="Automatica" onChange={(e) => put({ tooltip: e.target.value })} /></label>
    </Card>
  );
}

/** Riquadro Analisi: one card per line kind, "+ Aggiungi riga" like Power BI. */
function AnalyticsPane({ v }: { v: Visual }) {
  const s = useStore();
  const lines = v.format.analytics ?? [];
  const legend = !!v.fields.legend?.length;
  const measures = v.type === 'scatter' ? [] : [...(v.fields.values ?? []), ...(v.fields.lineValues ?? [])];
  const save = (next: AnalyticsLine[]) => s.updateFormat(v.id, { analytics: next.length ? next : undefined });
  const edit = (id: string, patch: Partial<AnalyticsLine>) => save(lines.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  return (
    <div>
      {analyticsKinds(v, legend).map((kind) => {
        const own = lines.filter((l) => l.kind === kind);
        const add = () => save([...lines, {
          id: uid(), kind, ...(kind === 'constant' || kind === 'xConstant' ? { value: 0 } : {}), ...(kind === 'percentile' ? { percentile: 50 } : {}),
          ...(measures[0] && kind !== 'constant' && kind !== 'trend' && kind !== 'forecast' ? { measure: fieldKey(measures[0]) } : {}),
          ...(kind === 'forecast' ? { forecastLength: 10, confidence: 95, style: 'solid' as const } : kind === 'errorBars' ? { errMode: 'percent' as const, errValue: 10, color: '#252423', style: 'solid' as const } : { color: '#252423', style: 'dashed' as const }),
        }]);
        return (
          <Card key={kind} title={KIND_LABEL[kind] + (own.length ? ` (${own.length})` : '')} defaultOpen={own.length > 0}>
            {own.map((l, i) => (
              <div key={l.id} className="an-line">
                <div className="fmt-row inline"><b>{l.name || `${KIND_LABEL[kind]} ${i + 1}`}</b>
                  <button title="Elimina" onClick={() => save(lines.filter((x) => x.id !== l.id))}><Icon name="trash" size={13} /></button></div>
                <label className="fmt-row"><span>Nome</span><input type="text" value={l.name ?? ''} placeholder={`${KIND_LABEL[kind]} ${i + 1}`} onChange={(e) => edit(l.id, { name: e.target.value || undefined })} /></label>
                {(kind === 'constant' || kind === 'xConstant') && <label className="fmt-row"><span>Valore</span><input type="number" value={l.value ?? 0} onChange={(e) => edit(l.id, { value: +e.target.value })} /></label>}
                {kind === 'percentile' && <label className="fmt-row"><span>Percentile</span><input type="number" min={0} max={100} value={l.percentile ?? 50} onChange={(e) => edit(l.id, { percentile: Math.min(100, Math.max(0, +e.target.value)) })} /></label>}
                {kind === 'forecast' && <>
                  <label className="fmt-row"><span>Lunghezza previsione (punti)</span><input type="number" min={1} max={500} value={l.forecastLength ?? 10} onChange={(e) => edit(l.id, { forecastLength: Math.max(1, +e.target.value) })} /></label>
                  <label className="fmt-row"><span>Ignora gli ultimi</span><input type="number" min={0} value={l.ignoreLast ?? 0} onChange={(e) => edit(l.id, { ignoreLast: Math.max(0, +e.target.value) || undefined })} /></label>
                  <label className="fmt-row"><span>Intervallo di confidenza</span>
                    <select value={l.confidence ?? 95} onChange={(e) => edit(l.id, { confidence: +e.target.value })}>{[75, 80, 85, 90, 95, 99].map((c) => <option key={c} value={c}>{c}%</option>)}</select></label>
                  <label className="fmt-row"><span>Stagionalità (punti, 0 = automatica)</span><input type="number" min={0} value={l.seasonality ?? 0} onChange={(e) => edit(l.id, { seasonality: Math.max(0, +e.target.value) || undefined })} /></label>
                  <div className="hint" style={{ fontSize: 11, color: 'var(--text2)' }}>Richiede un asse X continuo (data o numero) e una sola misura.</div>
                </>}
                {kind === 'errorBars' && <>
                  <label className="fmt-row"><span>Tipo</span>
                    <select value={l.errMode ?? 'percent'} onChange={(e) => edit(l.id, { errMode: e.target.value as AnalyticsLine['errMode'] })}>
                      <option value="field">Per campo (limiti superiore e inferiore)</option><option value="percent">Percentuale del valore</option><option value="stdev">Deviazione standard</option>
                    </select></label>
                  {l.errMode === 'field' ? <>
                    <InputPick label="Limite superiore" value={l.upper} self="(nessuno)" onChange={(f) => edit(l.id, { upper: f ?? undefined })} />
                    <InputPick label="Limite inferiore" value={l.lower} self="(nessuno)" onChange={(f) => edit(l.id, { lower: f ?? undefined })} />
                  </> : <label className="fmt-row"><span>{l.errMode === 'stdev' ? 'Numero di deviazioni standard' : 'Percentuale (±)'}</span>
                    <input type="number" min={0} step={l.errMode === 'stdev' ? 0.5 : 1} value={l.errValue ?? (l.errMode === 'stdev' ? 1 : 10)} onChange={(e) => edit(l.id, { errValue: Math.max(0, +e.target.value) })} /></label>}
                </>}
                {measures.length > 1 && kind !== 'constant' && kind !== 'trend' && kind !== 'forecast' && <label className="fmt-row"><span>Serie</span>
                  <select value={l.measure ?? fieldKey(measures[0])} onChange={(e) => edit(l.id, { measure: e.target.value })}>
                    {measures.map((m) => <option key={fieldKey(m)} value={fieldKey(m)}>{fieldLabel(m)}</option>)}
                  </select></label>}
                {v.type === 'scatter' && !['constant', 'xConstant', 'trend'].includes(kind) && <label className="fmt-row"><span>Misura</span>
                  <select value={l.axis ?? 'y'} onChange={(e) => edit(l.id, { axis: e.target.value as 'x' | 'y' })}><option value="y">Asse Y</option><option value="x">Asse X</option></select></label>}
                <ColorPick label="Colore" value={l.color ?? (kind === 'forecast' ? '#118DFF' : '#252423')} onChange={(color) => edit(l.id, { color })} />
                <label className="fmt-row"><span>Trasparenza (%)</span><input type="number" min={0} max={100} value={l.transparency ?? 0} onChange={(e) => edit(l.id, { transparency: +e.target.value })} /></label>
                <label className="fmt-row"><span>Stile</span>
                  <select value={l.style ?? 'dashed'} onChange={(e) => edit(l.id, { style: e.target.value as AnalyticsLine['style'] })}>
                    <option value="dashed">Tratteggiato</option><option value="solid">Continuo</option><option value="dotted">Punteggiato</option>
                  </select></label>
                <label className="fmt-row"><span>Larghezza</span><input type="number" min={1} max={10} value={l.width ?? 1.5} onChange={(e) => edit(l.id, { width: +e.target.value })} /></label>
                {!['trend', 'forecast', 'errorBars'].includes(kind) && <div className="fmt-row inline"><span>Etichetta dati</span><Toggle on={!!l.label} onChange={(b) => edit(l.id, { label: b || undefined })} /></div>}
                {!['trend', 'forecast', 'errorBars'].includes(kind) && <>
                  <label className="fmt-row"><span>Area ombreggiata</span>
                    <select value={l.shade ?? ''} onChange={(e) => edit(l.id, { shade: (e.target.value || undefined) as AnalyticsLine['shade'] })}>
                      <option value="">Nessuna</option><option value="before">Prima (sotto la linea)</option><option value="after">Dopo (sopra la linea)</option>
                    </select></label>
                  {l.shade && <>
                    <ColorPick label="Colore area" value={l.shadeColor ?? l.color ?? '#252423'} onChange={(shadeColor) => edit(l.id, { shadeColor })} />
                    <label className="fmt-row"><span>Trasparenza area (%)</span><input type="number" min={0} max={100} value={l.shadeTransparency ?? 80} onChange={(e) => edit(l.id, { shadeTransparency: +e.target.value })} /></label>
                  </>}
                </>}
                {kind === 'forecast' && <label className="fmt-row"><span>Trasparenza intervallo (%)</span><input type="number" min={0} max={100} value={l.shadeTransparency ?? 80} onChange={(e) => edit(l.id, { shadeTransparency: +e.target.value })} /></label>}
              </div>
            ))}
            <button className="an-add" onClick={add}><Icon name="plus" size={12} /> Aggiungi riga</button>
          </Card>
        );
      })}
    </div>
  );
}

function FormatPane({ v }: { v: Visual }) {
  const s = useStore();
  const [tab, setTab] = useState<'visual' | 'general'>('visual');
  const f = v.format;
  const up = (p: Partial<VisualFormat>) => s.updateFormat(v.id, p);
  const tg = (k: keyof VisualFormat): [boolean, (b: boolean) => void] => [f[k] as boolean, (b) => up({ [k]: b })];
  const chart = isChart(v.type);
  const cartesian = chart && !['pie', 'donut', 'treemap', 'funnel', 'gauge'].includes(v.type);
  const mapv = v.type === 'map' || v.type === 'filledMap';
  const hasLegend = ['pie', 'donut'].includes(v.type) || (cartesian && v.type !== 'scatter') || v.type === 'scatter' || mapv;

  return (
    <div>
      <div className="subtabs">
        <button className={tab === 'visual' ? 'active' : ''} onClick={() => setTab('visual')}>Oggetto visivo</button>
        <button className={tab === 'general' ? 'active' : ''} onClick={() => setTab('general')}>Generale</button>
      </div>
      {tab === 'visual' && <>
        {cartesian && <Card title="Asse X" toggle={tg('xAxisShow')}>
          {axisKind(v, s.tables) && <label className="fmt-row"><span>Tipo</span>
            <select value={f.axisType ?? (axisKind(v, s.tables) === 'date' ? 'continuous' : 'categorical')} onChange={(e) => up({ axisType: e.target.value as VisualFormat['axisType'] })}>
              <option value="continuous">Continuo</option><option value="categorical">Categorico</option>
            </select></label>}
        </Card>}
        {cartesian && <Card title="Asse Y" toggle={tg('yAxisShow')} />}
        {cartesian && <Card title="Linee griglia" toggle={tg('gridlines')} />}
        {hasLegend && (
          <Card title="Legenda" toggle={tg('legendShow')}>
            <label className="fmt-row"><span>Posizione</span>
              <select value={f.legendPos} onChange={(e) => up({ legendPos: e.target.value as VisualFormat['legendPos'] })}>
                <option value="top">In alto</option><option value="bottom">In basso</option><option value="left">A sinistra</option><option value="right">A destra</option>
              </select>
            </label>
          </Card>
        )}
        {(chart || v.type === 'map') && v.type !== 'gauge' && <Card title="Etichette dati" toggle={tg('dataLabels')} />}
        {(chart || v.type === 'gauge' || mapv) && !['pie', 'donut', 'treemap'].includes(v.type) && (
          <Card title="Colonne / Colori" defaultOpen>
            <label className="fmt-row"><span>Colore predefinito</span>
              <span className="colorpick"><input type="color" value={f.color} onChange={(e) => up({ color: e.target.value })} />{f.color.toUpperCase()}</span>
            </label>
            {(cartesian && v.type !== 'scatter' || v.type === 'filledMap') && <>
              <div className="fmt-row inline"><span>Formattazione condizionale (fx)</span><Toggle on={!!f.colorScale || !!f.colorRule} onChange={(b) => up({ colorScale: b ? { min: '#DEEFFF', max: '#0B5394' } : undefined, colorRule: undefined })} /></div>
              {(f.colorScale || f.colorRule) && v.type !== 'filledMap' && <InputPick value={f.colorRule?.field} self="(valore del grafico)"
                onChange={(field) => up(field ? { colorRule: { field, scale: f.colorRule?.scale ?? f.colorScale ?? { min: '#DEEFFF', max: '#0B5394' }, rules: f.colorRule?.rules }, colorScale: undefined } : { colorScale: f.colorRule?.scale ?? { min: '#DEEFFF', max: '#0B5394' }, colorRule: undefined })} />}
              {f.colorScale && <ScaleEditor scale={f.colorScale} onChange={(colorScale) => up({ colorScale })} />}
              {f.colorRule && <ColorFormatEditor title="Colore" scale={f.colorRule.scale} rules={f.colorRule.rules} def={{ min: '#DEEFFF', max: '#0B5394' }}
                onChange={(scale, rules) => up({ colorRule: scale || rules ? { field: f.colorRule!.field, scale, rules } : undefined })} />}
            </>}
          </Card>
        )}
        {(v.type === 'table' || v.type === 'matrix') && <CondFormatCard v={v} />}
        {v.type === 'custom' && <CustomFormatCards v={v} />}
        {(chart || mapv) && (
          <Card title="Descrizioni comando">
            <label className="fmt-row"><span>Tipo</span>
              <select value={f.tooltipPage ?? ''} onChange={(e) => up({ tooltipPage: e.target.value || undefined })}>
                <option value="">Predefinito</option>
                {s.report.pages.filter((p) => p.tooltip).map((p) => <option key={p.id} value={p.id}>Pagina del report: {p.name}</option>)}
              </select>
            </label>
            {!s.report.pages.some((p) => p.tooltip) && <div style={{ color: 'var(--text2)', fontSize: 11 }}>Nessuna pagina impostata come descrizione comando.</div>}
          </Card>
        )}
        {v.type === 'button' && <ActionCard v={v} />}
        {v.type === 'slicer' && (
          <Card title="Impostazioni filtro dei dati" defaultOpen>
            <SlicerSettings v={v} up={up} />
          </Card>
        )}
        {!chart && !mapv && !['slicer', 'table', 'matrix', 'custom', 'button'].includes(v.type) && <div style={{ color: 'var(--text2)', padding: '10px 0' }}>Nessuna opzione aggiuntiva per questo oggetto visivo.</div>}
      </>}
      {tab === 'general' && <>
        <Card title="Proprietà" defaultOpen>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            {(['x', 'y', 'w', 'h'] as const).map((k) => (
              <label key={k} className="fmt-row"><span>{{ x: 'Posizione X', y: 'Posizione Y', w: 'Larghezza', h: 'Altezza' }[k]}</span>
                <input type="number" value={v[k]} onChange={(e) => s.updateVisual(v.id, { [k]: Math.max(k === 'w' || k === 'h' ? 40 : 0, +e.target.value) })} style={{ width: '100%' }} />
              </label>
            ))}
          </div>
        </Card>
        <Card title="Titolo" toggle={tg('titleShow')} defaultOpen>
          <label className="fmt-row"><span>Testo</span><input type="text" value={f.titleText} placeholder="Automatico" onChange={(e) => up({ titleText: e.target.value })} /></label>
          <label className="fmt-row"><span>Dimensioni del testo</span><input type="number" min={8} max={40} value={f.titleSize} onChange={(e) => up({ titleSize: +e.target.value })} /></label>
        </Card>
        <Card title="Effetti">
          <label className="fmt-row"><span>Sfondo</span>
            <span className="colorpick"><input type="color" value={f.background} onChange={(e) => up({ background: e.target.value })} />{f.background.toUpperCase()}</span>
          </label>
          <div className="fmt-row inline"><span>Bordo oggetto visivo</span><Toggle on={f.border ?? THEME.border} onChange={(b) => up({ border: b })} /></div>
        </Card>
      </>}
    </div>
  );
}

/** Page settings (no visual selected): size, background, tooltip page, drill-through fields. */
function PageSettings() {
  const s = useStore();
  const p = s.page();
  const [over, setOver] = useState(false);
  const up = (fn: (pg: Page) => void) => s.mut((r) => { const pg = r.pages.find((x) => x.id === p.id); if (pg) fn(pg); });
  const w = p.width ?? 1280, h = p.height ?? 720;
  const kind = w === 1280 && h === 720 ? '16:9' : w === 960 && h === 720 ? '4:3' : w === 320 && h === 240 ? 'tooltip' : 'custom';
  const dt = p.drillthrough?.fields ?? [];
  return (
    <div>
      <div style={{ fontWeight: 600, margin: '8px 0' }}>Pagina «{p.name}»</div>
      <Card title="Impostazioni area di disegno" defaultOpen>
        <label className="fmt-row"><span>Tipo</span>
          <select value={kind} onChange={(e) => up((pg) => {
            const [nw, nh] = ({ '16:9': [1280, 720], '4:3': [960, 720], tooltip: [320, 240], custom: [w, h] } as Record<string, number[]>)[e.target.value];
            if (nw === 1280 && nh === 720) { delete pg.width; delete pg.height; } else { pg.width = nw; pg.height = nh; }
            if (e.target.value === 'tooltip') pg.tooltip = true;
          })}>
            <option value="16:9">16:9</option><option value="4:3">4:3</option><option value="tooltip">Descrizione comando (320 × 240)</option><option value="custom">Personalizzato</option>
          </select>
        </label>
        {kind === 'custom' && <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <label className="fmt-row"><span>Larghezza</span><input type="number" min={100} value={w} onChange={(e) => up((pg) => { pg.width = Math.max(100, +e.target.value); pg.height = h; })} /></label>
          <label className="fmt-row"><span>Altezza</span><input type="number" min={100} value={h} onChange={(e) => up((pg) => { pg.height = Math.max(100, +e.target.value); pg.width = w; })} /></label>
        </div>}
      </Card>
      <Card title="Sfondo area di disegno">
        <ColorPick label="Colore" value={p.backgroundColor ?? '#FFFFFF'} onChange={(c) => up((pg) => { pg.backgroundColor = c; })} />
        <label className="fmt-row"><span>Trasparenza (%)</span><input type="number" min={0} max={100} value={p.backgroundTransparency ?? 0} onChange={(e) => up((pg) => { pg.backgroundTransparency = Math.max(0, Math.min(100, +e.target.value)); })} /></label>
      </Card>
      <Card title="Informazioni pagina" defaultOpen>
        <div className="fmt-row inline"><span>Consenti l'uso come descrizione comando</span><Toggle on={!!p.tooltip} onChange={(b) => up((pg) => { pg.tooltip = b || undefined; })} /></div>
        <div className="fmt-row inline"><span>Nascondi pagina</span><Toggle on={!!p.hidden} onChange={(b) => up((pg) => { pg.hidden = b || undefined; })} /></div>
      </Card>
      <div className="wells">
        <div className={'well' + (over ? ' over' : '')}
          onDragOver={(e) => { if (e.dataTransfer.types.includes(FIELD_MIME)) { e.preventDefault(); setOver(true); } }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            setOver(false);
            const raw = e.dataTransfer.getData(FIELD_MIME);
            if (!raw) return;
            const f = JSON.parse(raw);
            if (f.measure) { s.notify('Il drill-through usa colonne, non misure.'); return; }
            up((pg) => {
              const first = !pg.drillthrough;
              const list = (pg.drillthrough ??= { fields: [] }).fields;
              if (!list.some((x) => x.table === f.table && x.column === f.column)) list.push({ table: f.table, column: f.column });
              // Like Power BI, a new drill-through page gets a Back button (Ctrl+click in edit mode).
              if (first && !pg.visuals.some((v) => v.type === 'button')) {
                const L = (x: string) => ({ expr: { Literal: { Value: x } } });
                pg.visuals.push({
                  id: uid(), type: 'button', x: 16, y: 16, w: 40, h: 40, z: Math.max(0, ...pg.visuals.map((v) => v.z)) + 1, fields: {}, format: defaultFormat('button'),
                  style: {
                    pbiType: 'actionButton',
                    objects: { icon: [{ properties: { shapeType: L("'back'"), lineColor: { solid: { color: L("'#252423'") } } } }], outline: [{ properties: { show: L('false') } }] },
                    vcObjects: { visualLink: [{ properties: { show: L('true'), type: L("'Back'"), tooltip: L("'Indietro'") } }] },
                  },
                });
              }
            });
          }}>
          <div className="wl">Drill-through</div>
          {dt.map((f, i) => (
            <div className="pill" key={i}><span className="nm">{f.column}</span>
              <button title="Rimuovi campo" onClick={() => up((pg) => { pg.drillthrough!.fields.splice(i, 1); if (!pg.drillthrough!.fields.length) delete pg.drillthrough; })}><Icon name="close" size={11} /></button></div>
          ))}
          <div className={'add' + (over ? ' over' : '')}>Aggiungi i campi di drill-through qui</div>
        </div>
        {dt.length > 0 && <div className="fmt-row inline"><span>Mantieni tutti i filtri</span><Toggle on={!!p.drillthrough?.keepAll} onChange={(b) => up((pg) => { pg.drillthrough!.keepAll = b || undefined; })} /></div>}
      </div>
    </div>
  );
}

/** Custom visuals of the report (Visualizations gallery), with "Importa un oggetto visivo da un file". */
function CustomGallery({ v }: { v?: Visual }) {
  const s = useStore();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const pkgs = s.report.customVisuals ?? [];
  return <>
    {pkgs.map((p) => (
      <button key={p.guid} title={customName(p)} className={v?.type === 'custom' && v.custom === p.guid ? 'active' : ''}
        onClick={() => (v && v.type !== 'textbox' ? s.changeVisualType(v.id, 'custom', p.guid) : s.addVisual('custom', undefined, p.guid))}>
        {p.pbiviz?.content?.iconBase64 ? <img src={p.pbiviz.content.iconBase64} alt="" width={20} height={20} /> : <VisualIcon type="custom" />}
      </button>
    ))}
    <button title="Altri oggetti visivi" onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); setMenu({ x: r.left - 200, y: r.bottom + 2 }); }}>…</button>
    {menu && (
      <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
        <button onClick={() => { setMenu(null); s.importCustomVisual(); }}>Importa un oggetto visivo da un file</button>
        {pkgs.length > 0 && <hr />}
        {pkgs.map((p) => <button key={p.guid} onClick={() => { setMenu(null); s.removeCustomVisual(p.guid); }}>Rimuovi «{customName(p)}»</button>)}
      </Menu>
    )}
  </>;
}

export function VisualizationsPane() {
  const s = useStore();
  if (!s.panes.viz) return null;
  const v = s.page().visuals.find((x) => x.id === s.selectedVisualId);
  return (
    <div className="pane">
      <div className="pane-head">
        <h3>Visualizzazioni</h3>
        <div className="tools"><button title="Comprimi" onClick={() => s.set({ panes: { ...s.panes, viz: false } })}><Icon name="collapseRight" /></button></div>
      </div>
      <div style={{ padding: '0 12px 4px', fontWeight: 600 }}>{s.vizTab === 'build' ? 'Compila oggetto visivo' : s.vizTab === 'analytics' ? 'Analisi' : 'Formato oggetto visivo'}</div>
      <div className="viz-tabs">
        <button className={s.vizTab === 'build' ? 'active' : ''} title="Aggiungi dati all'oggetto visivo" onClick={() => s.set({ vizTab: 'build' })}><Icon name="build" size={18} /></button>
        <button className={s.vizTab === 'format' ? 'active' : ''} title="Formato oggetto visivo" onClick={() => s.set({ vizTab: 'format' })}><Icon name="brush" size={18} /></button>
        <button className={s.vizTab === 'analytics' ? 'active' : ''} title="Aggiungi ulteriori analisi all'oggetto visivo" onClick={() => s.set({ vizTab: 'analytics' })}><Icon name="analytics" size={18} /></button>
      </div>
      <div className="pane-body">
        {s.vizTab === 'build' && <>
          <div className="viz-grid">
            {VISUALS.map((d) => (
              <button key={d.type} title={d.name} className={v?.type === d.type ? 'active' : ''}
                onClick={() => (v && v.type !== 'textbox' ? s.changeVisualType(v.id, d.type) : s.addVisual(d.type))}>
                <VisualIcon type={d.type} />
              </button>
            ))}
            <CustomGallery v={v} />
          </div>
          {v ? <Wells v={v} /> : <PageSettings />}
        </>}
        {s.vizTab === 'analytics' && (v && supportsAnalytics(v) ? <AnalyticsPane key={v.id} v={v} />
          : <div style={{ color: 'var(--text2)', paddingTop: 10 }}>{v ? 'Nessuna analisi disponibile per questo oggetto visivo.' : "Selezionare un oggetto visivo per aggiungere un'analisi."}</div>)}
        {s.vizTab === 'format' && (v ? <FormatPane key={v.id} v={v} /> : <div style={{ color: 'var(--text2)', paddingTop: 10 }}>Selezionare un oggetto visivo per formattarlo.</div>)}
      </div>
    </div>
  );
}

/** Impostazioni filtro dei dati: styles offered by the field type (Power BI: text = Elenco/Menu a discesa/Riquadro;
 *  numbers add Tra/Minore o uguale a/Maggiore o uguale a; dates add Tra/Prima di/Dopo/Data e Ora relativa). */
function SlicerSettings({ v, up }: { v: Visual; up: (p: Partial<VisualFormat>) => void }) {
  const tables = useStore((s) => s.tables);
  const f = v.format;
  const field = v.fields.category?.[0];
  const kind = field ? fieldKind(field, tables) : 'text';
  const styles: [VisualFormat['slicerStyle'], string][] = [['list', 'Elenco verticale'], ['dropdown', 'Elenco a discesa'], ['tile', 'Riquadro (pulsanti)']];
  if (kind === 'number') styles.push(['between', 'Tra'], ['before', 'Minore o uguale a'], ['after', 'Maggiore o uguale a']);
  if (kind === 'date' || kind === 'datetime') styles.push(['between', 'Tra'], ['before', 'Prima di'], ['after', 'Dopo'], ['relativeDate', 'Data relativa'], ['relativeTime', 'Ora relativa']);
  if (kind === 'text') styles.push(['text', 'Testo (contiene)']);
  if (f.slicerStyle === 'slider') styles.push(['slider', 'Valore singolo (cursore)']);
  if (!styles.some(([k]) => k === f.slicerStyle)) styles.push([f.slicerStyle, f.slicerStyle]);
  const values = ['list', 'dropdown', 'tile'].includes(f.slicerStyle);
  return <>
    <label className="fmt-row"><span>Stile</span>
      <select value={f.slicerStyle} onChange={(e) => up({ slicerStyle: e.target.value as VisualFormat['slicerStyle'] })}>
        {styles.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
      </select>
    </label>
    {values && <>
      <div className="fmt-row inline"><span>Selezione singola</span><Toggle on={!!f.slicerSingle} onChange={(b) => up({ slicerSingle: b || undefined })} /></div>
      {f.slicerStyle !== 'dropdown' && <div className="fmt-row inline"><span>Opzione "Seleziona tutto"</span><Toggle on={f.slicerSelectAll !== false} onChange={(b) => up({ slicerSelectAll: b ? undefined : false })} /></div>}
      {f.slicerStyle === 'tile' && <div className="fmt-row inline"><span>Selezione multipla senza CTRL</span><Toggle on={!!f.slicerMulti} onChange={(b) => up({ slicerMulti: b || undefined })} /></div>}
      <div className="fmt-row inline"><span>Casella di ricerca</span><Toggle on={!!f.slicerSearch} onChange={(b) => up({ slicerSearch: b || undefined })} /></div>
    </>}
  </>;
}
