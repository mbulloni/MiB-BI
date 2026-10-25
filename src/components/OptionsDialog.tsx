// File › Opzioni e impostazioni › Opzioni: GLOBALE (this user) and FILE CORRENTE (saved in the report).
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { api, type ClaudeStatus } from '../api';
import { globalOptions, setGlobalOptions } from '../options';
import { Icon } from './icons';
import { Toggle } from './Menu';
import { fmtWith, setLocale } from '../format';

const LOCALES: [string, string][] = [['it-IT', 'Italiano (Italia)'], ['it-CH', 'Italiano (Svizzera)'], ['en-US', 'Inglese (Stati Uniti)'], ['en-GB', 'Inglese (Regno Unito)'], ['de-DE', 'Tedesco (Germania)'], ['fr-FR', 'Francese (Francia)'], ['es-ES', 'Spagnolo (Spagna)'], ['pt-BR', 'Portoghese (Brasile)']];
import { DataSourceSettings } from './SourceDialogs';
import { setAppTheme, useAppTheme } from '../appTheme';
import { setUiLang } from '../i18n';

type Section = 'theme' | 'pbip' | 'load' | 'intl' | 'python' | 'r' | 'qna' | 'fileLoad' | 'reportSettings';

export function OptionsDialog() {
  const s = useStore();
  const [sec, setSec] = useState<Section>('load');
  const theme = useAppTheme();
  const [opts, setOpts] = useState(globalOptions);
  const [paths, setPaths] = useState<{ python?: string; r?: string }>({});
  const [claude, setClaude] = useState<ClaudeStatus | null>(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [ds, setDs] = useState(false);
  useEffect(() => {
    if (!s.optionsDialog) return;
    setOpts(globalOptions());
    api.scriptPaths().then(setPaths).catch(() => {});
    api.claude.status().then(setClaude).catch(() => {});
  }, [s.optionsDialog]);
  if (!s.optionsDialog) return null;
  const close = () => s.set({ optionsDialog: false });
  const nav = (id: Section, label: string) => <button className={sec === id ? 'active' : ''} onClick={() => { setSec(id); setMsg(null); }}>{label}</button>;
  const savePaths = async () => { setPaths(await api.scriptPaths(paths)); setMsg('Percorsi salvati.'); };
  const autoDate = s.report.options?.autoDateTime !== false;
  return (
    <div className="modal-bg">
      <div className="dialog options-dlg">
        <div className="dh"><h2>Opzioni</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="options-body">
          <nav>
            <div className="hdr">GLOBALE</div>
            {nav('load', 'Caricamento dati')}
            {nav('theme', 'Tema')}
            {nav('intl', 'Impostazioni internazionali')}
            {nav('pbip', 'Progetti di Power BI')}
            {nav('python', 'Scripting Python')}
            {nav('r', 'Scripting R')}
            {nav('qna', 'Domande e risposte')}
            <button onClick={() => setDs(true)}>Impostazioni origine dati…</button>
            <div className="hdr">FILE CORRENTE</div>
            {nav('fileLoad', 'Caricamento dati')}
            {nav('reportSettings', 'Impostazioni report')}
          </nav>
          <main>
            {sec === 'load' && <>
              <h3>Rilevamento relazioni</h3>
              <div className="fmt-row inline"><span>Rileva automaticamente le nuove relazioni dopo il caricamento dei dati</span>
                <Toggle on={opts.autoRelationships} onChange={(b) => setOpts(setGlobalOptions({ autoRelationships: b }))} /></div>
            </>}
            {sec === 'pbip' && <>
              <h3>Salvataggio dei progetti (.pbip)</h3>
              <div className="fmt-row inline"><span>Salva i report nel formato avanzato PBIR (un file JSON per pagina, oggetto visivo e segnalibro)</span>
                <Toggle on={opts.pbir !== false} onChange={(b) => setOpts(setGlobalOptions({ pbir: b }))} /></div>
              <div className="fmt-row inline"><span>Salva il modello semantico in TMDL (un file di testo per tabella, ruolo e lingua)</span>
                <Toggle on={opts.tmdl !== false} onChange={(b) => setOpts(setGlobalOptions({ tmdl: b }))} /></div>
              <p>PBIR e TMDL sono i formati predefiniti di Power BI Desktop: si leggono bene nei diff di git e si possono modificare con un editor di testo. Disattivati, il progetto usa i vecchi report.json e model.bim (PBIR-Legacy e TMSL).</p>
            </>}
            {sec === 'intl' && <>
              <h3>Lingua dell'applicazione</h3>
              <label className="pq-field">Interfaccia di MiB-BI: menu, barra multifunzione, riquadri e finestre. Il contenuto del report (titoli scritti, dati) non cambia.
                <select value={opts.uiLang ?? 'it'} onChange={(e) => { const l = e.target.value as 'it' | 'en'; setOpts(setGlobalOptions({ uiLang: l })); setUiLang(l); api.win.setLang(l); s.set({ dataVersion: s.dataVersion + 1 }); }}>
                  <option value="it">Italiano</option>
                  <option value="en">English</option>
                </select></label>
              <h3>Impostazioni internazionali</h3>
              <label className="pq-field">Formato di numeri e date (oggetti visivi, nomi dei mesi della gerarchia date, cultura del modello esportato)
                <select value={opts.locale ?? 'it-IT'} onChange={(e) => { setOpts(setGlobalOptions({ locale: e.target.value })); setLocale(e.target.value); s.set({ dataVersion: s.dataVersion + 1 }); }}>
                  {LOCALES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select></label>
              <p>Esempio: {fmtWith(1234567.891, '#,0.00')} · {new Date(2026, 9, 20).toLocaleDateString(opts.locale ?? 'it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}. I filtri già impostati su mesi o trimestri usano i nomi della lingua in cui sono stati creati.</p>
              <h3>Separatori DAX</h3>
              <div className="fmt-row inline"><span>Usa separatori locali (<code>;</code> tra gli argomenti, <code>,</code> per i decimali), come Power BI in italiano</span>
                <Toggle on={!!opts.daxLocalSeparators} onChange={(b) => setOpts(setGlobalOptions({ daxLocalSeparators: b }))} /></div>
              <p>Le espressioni vengono salvate sempre con i separatori standard (<code>,</code> e <code>.</code>), quindi i file restano compatibili con Power BI in qualsiasi lingua.</p>
            </>}
            {sec === 'python' && <>
              <h3>Opzioni script Python</h3>
              <p>Interprete usato dagli oggetti visivi Python (serve pandas e matplotlib). Vuoto = rilevamento automatico (.venv-pbix, ambiente di MiB-BI, python3).</p>
              <label className="pq-field">Directory home di Python rilevata / eseguibile
                <input type="text" value={paths.python ?? ''} placeholder="/usr/bin/python3" onChange={(e) => setPaths({ ...paths, python: e.target.value })} /></label>
              <div className="qna-row"><button className="btn primary" onClick={savePaths}>Salva</button></div>
            </>}
            {sec === 'r' && <>
              <h3>Opzioni script R</h3>
              <p>Eseguibile Rscript usato dagli oggetti visivi R. Vuoto = Rscript nel PATH (es. sudo apt install r-base).</p>
              <label className="pq-field">Rscript
                <input type="text" value={paths.r ?? ''} placeholder="Rscript" onChange={(e) => setPaths({ ...paths, r: e.target.value })} /></label>
              <div className="qna-row"><button className="btn primary" onClick={savePaths}>Salva</button></div>
            </>}
            {sec === 'qna' && claude && <>
              <h3>Domande e risposte</h3>
              <p>Claude interpreta domande libere. Riceve solo lo schema del modello (tabelle, colonne, misure e alcuni valori di esempio), mai le righe dei dati. Ogni domanda è una richiesta a pagamento all'API di Anthropic.</p>
              <label className="pq-field">Chiave API
                <input type="password" value={key} placeholder={claude.configured ? (claude.fromEnv ? 'da ANTHROPIC_API_KEY' : 'salvata (lasciare vuoto per mantenerla)') : 'sk-ant-…'} onChange={(e) => setKey(e.target.value)} /></label>
              <label className="pq-field">Modello
                <select value={claude.model} onChange={async (e) => setClaude(await api.claude.configure(null, e.target.value))}>{claude.models.map((m) => <option key={m}>{m}</option>)}</select></label>
              <div className="qna-row">
                <button className="btn primary" onClick={async () => { try { setClaude(await api.claude.configure(key || null, claude.model)); setKey(''); setMsg('Impostazioni salvate.'); } catch (e: any) { setMsg(e.message); } }}>Salva</button>
                {claude.configured && !claude.fromEnv && <button className="btn" onClick={async () => setClaude(await api.claude.configure(''))}>Rimuovi chiave</button>}
              </div>
            </>}
            {sec === 'fileLoad' && <>
              <h3>Business intelligence</h3>
              <div className="fmt-row inline"><span>Data/ora automatica</span>
                <Toggle on={autoDate} onChange={(b) => s.mut((r) => { r.options = { ...r.options, autoDateTime: b ? undefined : false }; if (!Object.values(r.options).some((x) => x !== undefined)) delete r.options; })} /></div>
              <p>Crea automaticamente le tabelle date (LocalDateTable) e le gerarchie Anno › Trimestre › Mese › Giorno per le colonne data quando il report viene esportato in .pbit/.pbip o pubblicato.</p>
            </>}
            {sec === 'theme' && <>
              <h3>Tema dell'applicazione</h3>
              <p>Il tema scuro riduce l'affaticamento della vista. Cambia barra multifunzione, riquadri, finestre e viste
                Tabella, Modello e Power Query; la pagina del report mantiene il proprio tema (Visualizza › Temi).</p>
              {([['light', 'Chiaro'], ['dark', 'Scuro'], ['system', 'Usa impostazione di sistema']] as const).map(([k, l]) => (
                <label key={k} className="opt-radio"><input type="radio" name="apptheme" checked={theme === k} onChange={() => setAppTheme(k)} />{l}</label>
              ))}
            </>}
            {sec === 'reportSettings' && <>
              <h3>Interazioni oggetto visivo</h3>
              <div className="fmt-row inline"><span>Modifica l'interazione predefinita degli oggetti visivi da evidenziazione incrociata a filtro incrociato</span>
                <Toggle on={!!s.report.options?.filterByDefault} onChange={(b) => s.mut((r) => { r.options = { ...r.options, filterByDefault: b || undefined }; if (!Object.values(r.options).some((x) => x !== undefined)) delete r.options; })} /></div>
              <p>Le interazioni impostate con Formato › Modifica interazioni restano invariate.</p>
            </>}
            {msg && <div style={{ marginTop: 8, color: 'var(--text2)' }}>{msg}</div>}
          </main>
        </div>
        <div className="df"><button className="btn primary" onClick={close}>OK</button></div>
      </div>
      {ds && <DataSourceSettings onClose={() => { setDs(false); api.clearRemoteCache().catch(() => {}); }} />}
    </div>
  );
}
