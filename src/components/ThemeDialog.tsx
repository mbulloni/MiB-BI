// Visualizza › Temi › Personalizza tema corrente: edits the report theme (Power BI theme JSON) like Power BI's dialog:
// Nome e colori, Testo, Oggetti visivi, Pagina, Riquadro filtri. Every key the dialog does not know is kept.
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { SENTIMENT_DEFAULTS, TEXT_DEFAULTS, THEMES, setThemeStyle, themeStyle, type TextClass } from '../themes';
import { PALETTE } from '../format';
import type { Theme } from '../types';
import { Icon } from './icons';
import { Toggle } from './Menu';

type Tab = 'colors' | 'text' | 'visuals' | 'page' | 'filters';
const FONTS = ['Segoe UI', 'Segoe UI Semibold', 'Segoe UI Bold', 'Segoe UI Light', 'DIN', 'Arial', 'Calibri', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Courier New', 'Ubuntu Sans'];
const TEXT: [TextClass, string, string][] = [
  ['label', 'Generale', 'Etichette, assi, legende, valori di tabelle e matrici'],
  ['title', 'Titolo', 'Titoli degli oggetti visivi e degli assi'],
  ['callout', 'Schede e indicatori KPI', 'Valori di schede e KPI'],
  ['header', 'Intestazioni delle schede', 'Intestazioni di colonna e titoli delle schede a più righe'],
];
const solid = (c: string) => ({ solid: { color: c } });

function Color({ label, value, onChange, placeholder }: { label: string; value: string | undefined; onChange: (c: string | undefined) => void; placeholder?: string }) {
  const shown = value ?? placeholder ?? '#FFFFFF';
  return (
    <label className="th-color">
      <span>{label}</span>
      <input type="color" value={/^#[0-9a-f]{6}$/i.test(shown) ? shown : '#FFFFFF'} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <input type="text" value={value ?? ''} placeholder={placeholder} spellCheck={false}
        onChange={(e) => { const x = e.target.value.trim(); onChange(x ? x : undefined); }} />
    </label>
  );
}

const Num = ({ label, value, onChange, min = 0, max = 100, placeholder }: { label: string; value: number | undefined; onChange: (n: number | undefined) => void; min?: number; max?: number; placeholder?: number }) => (
  <label className="th-num"><span>{label}</span>
    <input type="number" min={min} max={max} value={value ?? ''} placeholder={placeholder !== undefined ? String(placeholder) : undefined} onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))} />
  </label>
);

const Section = ({ title, children }: { title: string; children: ReactNode }) => <><h3>{title}</h3><div className="th-grid">{children}</div></>;

export function ThemeDialog() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>('colors');
  const [t, setT] = useState<Theme>(() => structuredClone(s.report.theme ?? THEMES[0]));
  const [more, setMore] = useState(false);
  useEffect(() => { if (s.themeDialog) { setT(structuredClone(s.report.theme ?? { ...THEMES[0], dataColors: [...THEMES[0].dataColors] })); setTab('colors'); } }, [s.themeDialog]);
  if (!s.themeDialog) return null;
  const close = () => s.set({ themeDialog: false });
  const set = (patch: Partial<Theme>) => setT((x) => Object.fromEntries(Object.entries({ ...x, ...patch }).filter(([, v]) => v !== undefined)) as Theme);
  const style = (type: string, obj: string, props: Record<string, unknown>, id?: string) => setT((x) => setThemeStyle(x, type, obj, props, id));
  const get = (type: string, obj: string, prop: string, id?: string) => themeStyle(t, type, obj, prop, id);
  const text = (k: TextClass, patch: Record<string, unknown>) => setT((x) => {
    const cur = { ...(x.textClasses?.[k] ?? {}), ...patch };
    for (const key of Object.keys(cur)) if (cur[key] === undefined) delete cur[key];
    const tc = { ...(x.textClasses ?? {}), [k]: cur };
    if (!Object.keys(cur).length) delete tc[k];
    return { ...x, textClasses: Object.keys(tc).length ? tc : undefined } as Theme;
  });
  const colors = t.dataColors.length >= 8 ? t.dataColors : [...t.dataColors, ...PALETTE.slice(t.dataColors.length, 8)];
  const nav = (id: Tab, label: string) => <button className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>;
  return (
    <div className="modal-bg">
      <div className="dialog options-dlg theme-dlg">
        <div className="dh"><h2>Personalizza tema</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="options-body">
          <nav>
            {nav('colors', 'Nome e colori')}
            {nav('text', 'Testo')}
            {nav('visuals', 'Oggetti visivi')}
            {nav('page', 'Pagina')}
            {nav('filters', 'Riquadro filtri')}
          </nav>
          <main>
            {tab === 'colors' && <>
              <label className="pq-field">Nome<input type="text" value={t.name} onChange={(e) => set({ name: e.target.value })} /></label>
              <h3>Colori del tema</h3>
              <div className="th-swatches">
                {(more ? colors : colors.slice(0, 8)).map((c, i) => (
                  <label key={i} title={`Colore ${i + 1}`}>
                    <input type="color" value={/^#[0-9a-f]{6}$/i.test(c) ? c : '#000000'} onChange={(e) => { const d = [...colors]; d[i] = e.target.value.toUpperCase(); set({ dataColors: d }); }} />
                    <span>{i + 1}</span>
                  </label>
                ))}
                {more && <button className="btn" title="Aggiungi colore" onClick={() => set({ dataColors: [...colors, PALETTE[colors.length % PALETTE.length]] })}>+</button>}
                {more && colors.length > 8 && <button className="btn" title="Rimuovi l'ultimo colore" onClick={() => set({ dataColors: colors.slice(0, -1) })}>−</button>}
              </div>
              <button className="link" onClick={() => setMore(!more)}>{more ? 'Mostra meno' : 'Mostra altri'}</button>
              <Section title="Colori di sentiment">
                <Color label="Positivo" value={t.good} placeholder={SENTIMENT_DEFAULTS.good} onChange={(c) => set({ good: c })} />
                <Color label="Neutro" value={t.neutral} placeholder={SENTIMENT_DEFAULTS.neutral} onChange={(c) => set({ neutral: c })} />
                <Color label="Negativo" value={t.bad} placeholder={SENTIMENT_DEFAULTS.bad} onChange={(c) => set({ bad: c })} />
              </Section>
              <Section title="Colori divergenti">
                <Color label="Massimo" value={t.maximum} placeholder={SENTIMENT_DEFAULTS.maximum} onChange={(c) => set({ maximum: c })} />
                <Color label="Centro" value={t.center} placeholder={SENTIMENT_DEFAULTS.center} onChange={(c) => set({ center: c })} />
                <Color label="Minimo" value={t.minimum} placeholder={SENTIMENT_DEFAULTS.minimum} onChange={(c) => set({ minimum: c })} />
              </Section>
              <Section title="Colori strutturali">
                <Color label="Elementi di primo livello (testo)" value={t.foreground} placeholder="#252423" onChange={(c) => set({ foreground: c })} />
                <Color label="Sfondo" value={t.background} placeholder="#FFFFFF" onChange={(c) => set({ background: c })} />
                <Color label="Elementi delle tabelle" value={t.tableAccent} placeholder="#118DFF" onChange={(c) => set({ tableAccent: c })} />
              </Section>
            </>}
            {tab === 'text' && TEXT.map(([k, label, hint]) => (
              <div key={k}>
                <h3>{label}</h3>
                <p>{hint}</p>
                <div className="th-grid">
                  <label className="th-num"><span>Carattere</span>
                    <select value={t.textClasses?.[k]?.fontFace ?? ''} onChange={(e) => text(k, { fontFace: e.target.value || undefined })}>
                      <option value="">{TEXT_DEFAULTS[k].fontFace} (predefinito)</option>
                      {FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: f }}>{f}</option>)}
                    </select></label>
                  <Num label="Dimensione (pt)" min={6} max={72} value={t.textClasses?.[k]?.fontSize} placeholder={TEXT_DEFAULTS[k].fontSize} onChange={(n) => text(k, { fontSize: n })} />
                  <Color label="Colore" value={t.textClasses?.[k]?.color} placeholder={t.foreground ?? TEXT_DEFAULTS[k].color} onChange={(c) => text(k, { color: c })} />
                </div>
              </div>
            ))}
            {tab === 'visuals' && <>
              <Section title="Sfondo">
                <Color label="Colore" value={get('*', 'background', 'color')} placeholder={t.background ?? '#FFFFFF'} onChange={(c) => style('*', 'background', { show: c ? true : undefined, color: c ? solid(c) : undefined })} />
                <Num label="Trasparenza (%)" value={get('*', 'background', 'transparency')} placeholder={0} onChange={(n) => style('*', 'background', { transparency: n })} />
              </Section>
              <Section title="Bordo">
                <div className="fmt-row inline"><span>Bordo</span><Toggle on={!!get('*', 'border', 'show')} onChange={(b) => style('*', 'border', { show: b || undefined })} /></div>
                <Color label="Colore" value={get('*', 'border', 'color')} placeholder="#C8C6C4" onChange={(c) => style('*', 'border', { color: c ? solid(c) : undefined })} />
                <Num label="Angoli arrotondati (px)" max={40} value={get('*', 'border', 'radius')} placeholder={0} onChange={(n) => style('*', 'border', { radius: n })} />
              </Section>
              <Section title="Intestazione">
                <Color label="Sfondo" value={get('*', 'visualHeader', 'background')} placeholder="#FFFFFF" onChange={(c) => style('*', 'visualHeader', { background: c ? solid(c) : undefined })} />
                <Color label="Icone" value={get('*', 'visualHeader', 'foreground')} placeholder="#252423" onChange={(c) => style('*', 'visualHeader', { foreground: c ? solid(c) : undefined })} />
              </Section>
              <Section title="Descrizione comando">
                <Color label="Sfondo" value={get('*', 'visualTooltip', 'background')} placeholder="#FFFFFF" onChange={(c) => style('*', 'visualTooltip', { background: c ? solid(c) : undefined })} />
                <Color label="Testo etichetta" value={get('*', 'visualTooltip', 'titleFontColor')} placeholder="#605E5C" onChange={(c) => style('*', 'visualTooltip', { titleFontColor: c ? solid(c) : undefined })} />
                <Color label="Testo valore" value={get('*', 'visualTooltip', 'valueFontColor')} placeholder="#252423" onChange={(c) => style('*', 'visualTooltip', { valueFontColor: c ? solid(c) : undefined })} />
              </Section>
            </>}
            {tab === 'page' && <>
              <Section title="Sfondo della pagina">
                <Color label="Colore" value={get('page', 'background', 'color')} placeholder={t.background ?? '#FFFFFF'} onChange={(c) => style('page', 'background', { color: c ? solid(c) : undefined })} />
                <Num label="Trasparenza (%)" value={get('page', 'background', 'transparency')} placeholder={0} onChange={(n) => style('page', 'background', { transparency: n })} />
              </Section>
              <Section title="Sfondo dell'area di disegno">
                <Color label="Colore" value={get('page', 'outspace', 'color')} placeholder="#EAEAEA" onChange={(c) => style('page', 'outspace', { color: c ? solid(c) : undefined })} />
              </Section>
            </>}
            {tab === 'filters' && <>
              <Section title="Riquadro filtri">
                <Color label="Colore di sfondo" value={get('*', 'outspacePane', 'backgroundColor')} placeholder="#FFFFFF" onChange={(c) => style('*', 'outspacePane', { backgroundColor: c ? solid(c) : undefined })} />
                <Num label="Trasparenza (%)" value={get('*', 'outspacePane', 'transparency')} placeholder={0} onChange={(n) => style('*', 'outspacePane', { transparency: n })} />
                <Color label="Colore del testo" value={get('*', 'outspacePane', 'foregroundColor')} placeholder="#252423" onChange={(c) => style('*', 'outspacePane', { foregroundColor: c ? solid(c) : undefined })} />
                <label className="th-num"><span>Carattere</span>
                  <select value={get('*', 'outspacePane', 'fontFamily') ?? ''} onChange={(e) => style('*', 'outspacePane', { fontFamily: e.target.value || undefined })}>
                    <option value="">Predefinito</option>
                    {FONTS.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select></label>
              </Section>
              <Section title="Schede filtro">
                <Color label="Sfondo filtri applicati" value={get('*', 'filterCard', 'backgroundColor', 'Applied')} placeholder="#F3F2F1" onChange={(c) => style('*', 'filterCard', { backgroundColor: c ? solid(c) : undefined }, 'Applied')} />
                <Color label="Sfondo filtri disponibili" value={get('*', 'filterCard', 'backgroundColor', 'Available')} placeholder="#FFFFFF" onChange={(c) => style('*', 'filterCard', { backgroundColor: c ? solid(c) : undefined }, 'Available')} />
              </Section>
            </>}
          </main>
        </div>
        <div className="df">
          <button className="btn" onClick={() => setT(structuredClone(THEMES.find((x) => x.name === t.name) ?? { ...THEMES[0], name: t.name, dataColors: [...THEMES[0].dataColors] }))}>Ripristina impostazioni predefinite</button>
          <span style={{ flex: 1 }} />
          <button className="btn primary" disabled={!t.name.trim() || !t.dataColors.length} onClick={() => { s.setTheme({ ...t, name: t.name.trim() }); close(); s.notify(`Tema "${t.name.trim()}" applicato al report.`); }}>Applica</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
