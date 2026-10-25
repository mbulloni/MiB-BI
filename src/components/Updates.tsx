// New releases on GitHub (as in MiB-SQL): quiet check at startup (at most every 12 hours, a skipped version
// stays silent), a strip under the ribbon when a newer release exists, and a dialog with the release notes
// that downloads and installs it (AppImage replaced in place, .deb through apt) and restarts MiB-BI.
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { locale } from '../format';
import { useStore } from '../store';
import { Icon } from './icons';

const KEY = 'mib-bi.updates';
interface Prefs { auto: boolean; last: number; skip: string | null }
export function updatePrefs(): Prefs {
  try { return { auto: true, last: 0, skip: null, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { auto: true, last: 0, skip: null }; }
}
export function setUpdatePrefs(p: Partial<Prefs>) {
  try { localStorage.setItem(KEY, JSON.stringify({ ...updatePrefs(), ...p })); } catch { /* storage unavailable */ }
}

/** Checks for a newer release; quiet = startup check (respects the interval and the skipped version). */
export async function checkUpdates(quiet: boolean) {
  const p = updatePrefs();
  if (quiet && (!p.auto || Date.now() - p.last < 12 * 3600 * 1000)) return null;
  const set = useStore.getState().set;
  try {
    const info = await api.update.check();
    setUpdatePrefs({ last: Date.now() });
    if (info.newer && (!quiet || p.skip !== info.latest)) set({ update: info });
    if (!quiet) set({ update: info, updateDialog: true, updateError: null });
    return info;
  } catch (e) {
    if (!quiet) set({ update: null, updateDialog: true, updateError: (e as Error).message });
    return null;
  }
}

/** Release notes (GitHub Markdown) as plain blocks: headings, bullets, code and paragraphs. */
function notesView(md: string) {
  const out: ReactNode[] = [];
  let code: string[] | null = null;
  md.replace(/\r/g, '').split('\n').forEach((line, i) => {
    if (line.startsWith('```')) { if (code) { out.push(<pre key={i}>{code.join('\n')}</pre>); code = null; } else code = []; return; }
    if (code) { code.push(line); return; }
    const plain = line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (/^#{1,6}\s/.test(line)) out.push(<b key={i} className="rn-h">{plain.replace(/^#+\s*/, '')}</b>);
    else if (/^\s*[-*]\s/.test(line)) out.push(<div key={i} className="rn-li">• {plain.replace(/^\s*[-*]\s/, '')}</div>);
    else if (line.trim()) out.push(<p key={i}>{plain}</p>);
  });
  return out.length ? out : '—';
}

/** Strip under the ribbon when a newer release exists. */
export function UpdateBanner() {
  const s = useStore();
  const u = s.update;
  if (!u?.newer || s.updateDialog || s.readMode) return null;
  return (
    <div className="update-banner">
      <Icon name="info" size={16} />
      <b>È disponibile MiB-BI {u.latest}</b>
      <span className="muted">(installata {u.current})</span>
      <span style={{ flex: 1 }} />
      <button className="btn primary" onClick={() => s.set({ updateDialog: true })}>Novità e aggiornamento…</button>
      <button className="btn" onClick={() => s.set({ update: null })}>Più tardi</button>
      <button className="btn" onClick={() => { setUpdatePrefs({ skip: u.latest }); s.set({ update: null }); }}>Salta questa versione</button>
    </div>
  );
}

/** Release notes, download progress, restart. */
export function UpdateDialog() {
  const s = useStore();
  const u = s.update;
  const [st, setSt] = useState<{ busy?: boolean; error?: string; done?: boolean; bytes?: number; total?: number; installing?: boolean; note?: string }>({});
  const [auto, setAuto] = useState(updatePrefs().auto);
  useEffect(() => api.update.onProgress((p) => {
    if (p.phase === 'install') setSt((x) => ({ ...x, installing: true }));
    else setSt((x) => ({ ...x, bytes: Number(p.bytes), total: Number(p.total) }));
  }), []);
  useEffect(() => { if (s.updateDialog) setSt({}); }, [s.updateDialog]);
  if (!s.updateDialog) return null;
  const close = () => s.set({ updateDialog: false, updateError: null });
  const install = async () => {
    setSt({ busy: true });
    try {
      const r = await api.update.install();
      if (r.done) setSt({ done: true });
      else if (r.reason === 'installer') setSt({ note: `Installazione automatica non riuscita: si è aperto il programma di installazione del sistema con il file ${r.file ?? ''}.` });
      else if (r.reason === 'manual') setSt({ note: 'Questa copia non è un AppImage né un pacchetto .deb: si è aperta la pagina della release per scaricarla.' });
      else setSt({ note: 'Nessun aggiornamento da installare.' });
    } catch (e) { setSt({ error: (e as Error).message }); }
  };
  const restart = async (save: boolean) => {
    // Saving can be canceled in the dialog: the report must be clean before restarting.
    if (save) { await s.save(); if (useStore.getState().dirty) return; }
    api.update.restart();
  };
  const pct = st.total ? Math.round(((st.bytes ?? 0) / st.total) * 100) : 0;
  const mb = (n?: number) => ((n ?? 0) / 1e6).toLocaleString(locale(), { maximumFractionDigits: 1 });
  const busy = st.busy && !st.done && !st.error && !st.note;
  return (
    <div className="modal-bg">
      <div className="dialog update-dlg">
        <div className="dh"><h2>{u?.newer ? `Aggiornamento a MiB-BI ${u.latest}` : 'Aggiornamenti'}</h2><button onClick={close} disabled={busy}><Icon name="close" /></button></div>
        <div className="db">
          {s.updateError && <div className="upd-status err">{s.updateError}</div>}
          {u && !u.newer && <div className="upd-status ok">Hai già l'ultima versione ({u.current}).</div>}
          {u?.newer && <>
            <p className="upd-note">Versione installata {u.current} · nuova {u.latest}{u.published ? ` · ${new Date(u.published).toLocaleDateString(locale())}` : ''}</p>
            <h3>Novità</h3>
            <div className="release-notes">{notesView(u.notes)}</div>
            <p className="upd-note">{u.mode === 'appimage' ? `Verrà scaricato ${u.asset?.name ?? ''} (${mb(u.asset?.size)} MB) e sostituito l'AppImage in uso; poi MiB-BI si riavvia.`
              : u.mode === 'deb' ? `Verrà scaricato ${u.asset?.name ?? ''} (${mb(u.asset?.size)} MB) e installato con apt: il sistema chiede la password di amministratore.`
                : 'Copia non installata da AppImage o .deb: verrà aperta la pagina della release.'}</p>
          </>}
          {st.busy && !st.done && !st.error && <div className="upd-progress"><span>{st.installing ? 'Installazione…' : `Download ${mb(st.bytes)} / ${mb(st.total)} MB`}</span><progress max={100} value={st.installing ? 100 : pct} /></div>}
          {st.done && <div className="upd-status ok">Aggiornamento installato: riavvia MiB-BI per usare la nuova versione.{s.dirty ? ' Il report ha modifiche non salvate.' : ''}</div>}
          {st.note && <div className="upd-status ok">{st.note}</div>}
          {st.error && <div className="upd-status err">{st.error}</div>}
          <label className="upd-auto"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); setUpdatePrefs({ auto: e.target.checked }); }} /> Controlla gli aggiornamenti all'avvio (GitHub, nessun dato inviato)</label>
        </div>
        <div className="df">
          {u?.url && <button className="btn" onClick={() => api.openExternal(u.url)}>Pagina della release</button>}
          <span style={{ flex: 1 }} />
          <button className="btn" onClick={close} disabled={busy}>Chiudi</button>
          {u?.newer && !st.done && <button className="btn primary" disabled={busy} onClick={install}>Aggiorna ora</button>}
          {st.done && s.dirty && <button className="btn" onClick={() => restart(false)}>Riavvia senza salvare</button>}
          {st.done && <button className="btn primary" onClick={() => restart(s.dirty)}>{s.dirty ? 'Salva e riavvia' : 'Riavvia ora'}</button>}
        </div>
      </div>
    </div>
  );
}
