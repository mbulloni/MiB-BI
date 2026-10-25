// Modellazione › Traduzioni: model translations (TOM cultures) like Power BI's Translations Builder:
// one column per language, one row per table, column, measure and hierarchy; caption, description or display folder.
// "Traduci con Claude" fills the empty cells of a language with Claude (Opzioni › Domande e risposte key).
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api';
import type { Culture } from '../types';
import { Icon } from './icons';

export const CULTURES: [string, string][] = [
  ['en-US', 'Inglese (Stati Uniti)'], ['en-GB', 'Inglese (Regno Unito)'], ['it-IT', 'Italiano (Italia)'], ['de-DE', 'Tedesco (Germania)'],
  ['fr-FR', 'Francese (Francia)'], ['es-ES', 'Spagnolo (Spagna)'], ['pt-BR', 'Portoghese (Brasile)'], ['pt-PT', 'Portoghese (Portogallo)'],
  ['nl-NL', 'Olandese (Paesi Bassi)'], ['pl-PL', 'Polacco (Polonia)'], ['sv-SE', 'Svedese (Svezia)'], ['da-DK', 'Danese (Danimarca)'],
  ['nb-NO', 'Norvegese (Norvegia)'], ['fi-FI', 'Finlandese (Finlandia)'], ['cs-CZ', 'Ceco (Repubblica Ceca)'], ['tr-TR', 'Turco (Turchia)'],
  ['ru-RU', 'Russo (Russia)'], ['ja-JP', 'Giapponese (Giappone)'], ['zh-CN', 'Cinese (semplificato)'], ['ko-KR', 'Coreano (Corea)'],
];
export const cultureName = (c: string) => CULTURES.find(([k]) => k === c)?.[1] ?? c;

type Prop = 'captions' | 'descriptions' | 'folders';
const PROPS: [Prop, string][] = [['captions', 'Nome visualizzato'], ['descriptions', 'Descrizione'], ['folders', 'Cartella di visualizzazione']];
interface Row { key: string; kind: 'Tabella' | 'Colonna' | 'Misura' | 'Gerarchia'; table: string; name: string; folder?: string }

export function TranslationsDialog() {
  const s = useStore();
  const [draft, setDraft] = useState<Culture[]>([]);
  const [prop, setProp] = useState<Prop>('captions');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { if (s.translationsDialog) { setDraft(structuredClone(s.report.cultures ?? [])); setMsg(null); } }, [s.translationsDialog]);
  const rows = useMemo<Row[]>(() => {
    const r = s.report;
    const names = [...new Set([...s.tables.filter((t) => !t.fieldParam).map((t) => t.name), ...r.measures.map((m) => m.table)])];
    return names.flatMap((t) => [
      { key: t, kind: 'Tabella' as const, table: t, name: t },
      ...(s.tables.find((x) => x.name === t)?.columns ?? []).map((c) => ({ key: `${t}\u0001${c.name}`, kind: 'Colonna' as const, table: t, name: c.name })),
      ...r.measures.filter((m) => m.table === t).map((m) => ({ key: `${t}\u0001${m.name}`, kind: 'Misura' as const, table: t, name: m.name })),
      ...(r.hierarchies ?? []).filter((h) => h.table === t).map((h) => ({ key: `${t}\u0001${h.name}`, kind: 'Gerarchia' as const, table: t, name: h.name })),
    ].map((x) => ({ ...x, folder: r.displayFolders?.[x.key] })));
  }, [s.tables, s.report]);
  if (!s.translationsDialog) return null;
  const close = () => s.set({ translationsDialog: false });
  const shown = rows.filter((r) => !q || (r.name + ' ' + r.table).toLowerCase().includes(q.toLowerCase())
    || draft.some((c) => (c[prop]?.[r.key] ?? '').toLowerCase().includes(q.toLowerCase())));
  const set = (culture: string, key: string, value: string) => setDraft((d) => d.map((c) => {
    if (c.name !== culture) return c;
    const map = { ...(c[prop] ?? {}) };
    if (value) map[key] = value; else delete map[key];
    return { ...c, [prop]: map };
  }));
  const add = (name: string) => { if (name && !draft.some((c) => c.name === name)) setDraft([...draft, { name, captions: {} }]); };
  const remove = (name: string) => setDraft(draft.filter((c) => c.name !== name));
  const auto = async (culture: string) => {
    const c = draft.find((x) => x.name === culture)!;
    const base = (r: Row) => (prop === 'folders' ? r.folder ?? '' : prop === 'descriptions' ? '' : r.name);
    const todo = rows.filter((r) => base(r) && !c[prop]?.[r.key]);
    if (!todo.length) { setMsg(`Nessun valore da tradurre in ${cultureName(culture)}.`); return; }
    setBusy(culture); setMsg(null);
    try {
      const out: Record<string, string> = {};
      for (let i = 0; i < todo.length; i += 150) {
        const part = todo.slice(i, i + 150);
        const hint = (r: Row) => (r.kind === 'Tabella' ? 'table' : `${r.kind === 'Colonna' ? 'column' : r.kind === 'Misura' ? 'measure' : 'hierarchy'} of table ${r.table}`) + (prop === 'folders' ? ', display folder' : '');
        Object.assign(out, await api.claude.translate(part.map((r, k) => ({ id: String(i + k), name: base(r), hint: hint(r) })), culture));
      }
      setDraft((d) => d.map((x) => (x.name !== culture ? x : { ...x, [prop]: { ...(x[prop] ?? {}), ...Object.fromEntries(Object.entries(out).map(([id, text]) => [todo[Number(id)]?.key, text]).filter(([k]) => k)) } })));
      setMsg(`${Object.keys(out).length} valori tradotti in ${cultureName(culture)} con Claude: controllarli prima di applicare.`);
    } catch (e: any) { setMsg(e.message); } finally { setBusy(null); }
  };
  const apply = () => {
    const clean = draft.map((c) => {
      const out: Culture = { name: c.name, captions: c.captions ?? {} };
      if (c.descriptions && Object.keys(c.descriptions).length) out.descriptions = c.descriptions;
      if (c.folders && Object.keys(c.folders).length) out.folders = c.folders;
      return out;
    });
    s.mut((r) => { if (clean.length) r.cultures = clean; else delete r.cultures; });
    if (s.previewCulture && !clean.some((c) => c.name === s.previewCulture)) s.set({ previewCulture: null });
    close();
    s.notify(clean.length ? `Traduzioni salvate per ${clean.length} ${clean.length === 1 ? 'lingua' : 'lingue'}: vengono scritte nei file .pbix, .pbit e .pbip.` : 'Traduzioni rimosse.');
  };
  return (
    <div className="modal-bg">
      <div className="dialog tr-dlg">
        <div className="dh"><h2>Traduzioni del modello</h2><button onClick={close}><Icon name="close" /></button></div>
        <p className="tr-hint">Le traduzioni cambiano i nomi di tabelle, colonne, misure e gerarchie che vede chi apre il report nel servizio Power BI con un'altra lingua. Con Visualizza › Lingua puoi vedere il report tradotto anche qui.</p>
        <div className="tr-bar">
          <select value="" onChange={(e) => add(e.target.value)} title="Aggiungi una lingua">
            <option value="">Aggiungi lingua…</option>
            {CULTURES.filter(([k]) => !draft.some((c) => c.name === k)).map(([k, l]) => <option key={k} value={k}>{l} – {k}</option>)}
          </select>
          <select value={prop} onChange={(e) => setProp(e.target.value as Prop)} title="Proprietà da tradurre">
            {PROPS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <span className="tr-search"><Icon name="search" size={13} /><input type="search" placeholder="Cerca" value={q} onChange={(e) => setQ(e.target.value)} /></span>
        </div>
        <div className="tr-grid">
          <table>
            <thead>
              <tr>
                <th>Tipo</th><th>Oggetto</th><th>{prop === 'folders' ? 'Cartella predefinita' : prop === 'descriptions' ? 'Descrizione predefinita' : 'Nome predefinito'}</th>
                {draft.map((c) => (
                  <th key={c.name} className="tr-lang">
                    <span title={cultureName(c.name)}>{c.name}</span>
                    <button className="btn" disabled={!!busy} title="Traduce con Claude i valori ancora vuoti di questa lingua" onClick={() => auto(c.name)}>{busy === c.name ? 'Traduzione…' : 'Traduci con Claude'}</button>
                    <button title="Rimuovi lingua" onClick={() => remove(c.name)}><Icon name="close" size={12} /></button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.key} className={r.kind === 'Tabella' ? 'tr-table' : ''}>
                  <td className="tr-kind">{r.kind}</td>
                  <td>{r.kind === 'Tabella' ? r.name : `${r.table}[${r.name}]`}</td>
                  <td className="tr-base">{prop === 'captions' ? r.name : prop === 'folders' ? r.folder ?? '' : ''}</td>
                  {draft.map((c) => <td key={c.name}><input type="text" value={c[prop]?.[r.key] ?? ''} onChange={(e) => set(c.name, r.key, e.target.value)} /></td>)}
                </tr>
              ))}
            </tbody>
          </table>
          {!draft.length && <div className="tr-empty">Nessuna lingua: sceglierne una da «Aggiungi lingua…».</div>}
          {!rows.length && <div className="tr-empty">Il modello non contiene tabelle.</div>}
        </div>
        {msg && <div className="tr-msg">{msg}</div>}
        <div className="df">
          <button className="btn primary" onClick={apply}>Applica</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
