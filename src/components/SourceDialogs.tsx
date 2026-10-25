// Ottieni dati › Web / Feed OData / Cartella, and Power Query › Gestisci parametri.
import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../store';
import { api, type WebCredInfo, type WebCredKind } from '../api';
import { resolveText } from '../pq/params';
import type { PQParam, TableMeta } from '../types';
import { Icon } from './icons';

const TITLE = { web: 'Da Web', odata: 'Feed OData', folder: 'Cartella', sharepoint: 'Cartella SharePoint', splist: 'Elenchi SharePoint Online' } as const;

/** New Web/OData/Folder/SharePoint query, opened in the Power Query editor. */
export function SourceDialog() {
  const s = useStore();
  const kind = s.sourceDialog;
  const [url, setUrl] = useState('');
  const [format, setFormat] = useState('');
  const [ext, setExt] = useState('csv');
  const [name, setName] = useState('');
  const [folder, setFolder] = useState('');
  const [list, setList] = useState('');
  const [lists, setLists] = useState<string[] | null>(null);
  const [creds, setCreds] = useState(false);
  useEffect(() => { setUrl(''); setFormat(''); setName(''); setFolder(''); setList(''); setLists(null); setCreds(false); }, [kind]);
  if (!kind) return null;
  const params = s.report.pqParams ?? [];
  const sp = kind === 'sharepoint' || kind === 'splist';
  const close = () => s.set({ sourceDialog: null });
  const guess = () => {
    if (kind === 'splist') return (list || TITLE[kind]).replace(/[^\w àèéìòù.-]/gi, '_');
    const base = kind === 'folder' ? url.replace(/\/+$/, '').split('/').pop()
      : kind === 'sharepoint' ? (folder || url).replace(/\/+$/, '').split('/').pop()
        : (() => { try { return new URL(url.replace(/#\[[^\]]+\]/g, 'x')).pathname.split('/').filter(Boolean).pop()?.replace(/\.\w+$/, ''); } catch { return ''; } })();
    return (base || TITLE[kind]).replace(/[^\w àèéìòù.-]/gi, '_');
  };
  const ok = () => {
    const taken = new Set([...s.tables.map((t) => t.name), ...(s.pq?.queries.map((q) => q.name) ?? [])]);
    let n = name.trim() || guess(), i = 2;
    while (taken.has(n)) n = `${name.trim() || guess()} (${i++})`;
    const source: TableMeta['source'] = kind === 'web' ? { path: '', web: { url: url.trim(), ...(format ? { format: format as 'csv' } : {}) } }
      : kind === 'odata' ? { path: '', odata: { url: url.trim() } }
        : kind === 'sharepoint' ? { path: '', sharepoint: { site: url.trim(), ext, ...(folder.trim() ? { folder: folder.trim() } : {}) } }
          : kind === 'splist' ? { path: '', sharepoint: { site: url.trim(), list: list.trim() } }
            : { path: '', folder: { path: url.trim(), ext } };
    const q = { name: n, orig: null, source, steps: [] };
    close();
    if (s.pq) s.pqSet((st) => { st.queries.push(q); st.selected = n; st.step = null; });
    else s.openPowerQuery(undefined, q);
  };
  const loadLists = async () => {
    try { setLists(await api.sharepointLists(resolveText(url.trim()))); } catch (e: any) { s.notify(e.message, 10000); }
  };
  const valid = kind === 'folder' ? !!url.trim() : kind === 'splist' ? /^(https:\/\/|#\[)/i.test(url.trim()) && !!list.trim() : /^(https?:\/\/|#\[)/i.test(url.trim());
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog" style={{ width: 'min(620px, 94vw)' }}>
        <div className="dh"><h2>{TITLE[kind]}</h2><button onClick={close}><Icon name="close" /></button></div>
        {creds ? <div className="db"><CredentialForm prefix={(() => { try { return new URL(resolveText(url.trim())).origin; } catch { return undefined; } })()} onSaved={() => setCreds(false)} onCancel={() => setCreds(false)} /></div> : <>
        <div className="db pq-db">
          {kind === 'folder' ? (
            <label className="pq-field">Percorso cartella
              <span className="pq-row"><input type="text" autoFocus value={url} onChange={(e) => setUrl(e.target.value)} placeholder="/home/…/dati" style={{ flex: 1 }} />
                <button className="btn" onClick={async () => { const d = await api.openDir(); if (d) setUrl(d); }}>Sfoglia…</button></span>
            </label>
          ) : (
            <label className="pq-field">{sp ? 'URL del sito' : 'URL'}<input type="text" autoFocus value={url} onChange={(e) => setUrl(e.target.value)}
              placeholder={sp ? 'https://contoso.sharepoint.com/sites/Vendite' : kind === 'odata' ? 'https://services.odata.org/V4/Northwind/Northwind.svc/Customers' : 'https://…/dati.csv'} /></label>
          )}
          {kind === 'web' && (
            <label className="pq-field">Formato
              <select value={format} onChange={(e) => setFormat(e.target.value)}>
                <option value="">Automatico (estensione o tipo di contenuto)</option><option value="csv">Testo/CSV</option><option value="json">JSON</option><option value="parquet">Parquet</option><option value="xlsx">Excel</option>
              </select>
            </label>
          )}
          {kind === 'sharepoint' && (
            <label className="pq-field">Cartella (facoltativa)<input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Documenti condivisi/Dati" /></label>
          )}
          {kind === 'splist' && (
            <label className="pq-field">Elenco
              <span className="pq-row">
                <input type="text" list="sp-lists" value={list} onChange={(e) => setList(e.target.value)} placeholder="Clienti" style={{ flex: 1 }} />
                <datalist id="sp-lists">{(lists ?? []).map((l) => <option key={l} value={l} />)}</datalist>
                <button className="btn" disabled={!/^https:\/\//.test(resolveText(url.trim()))} onClick={loadLists}>Elenchi del sito</button>
              </span>
            </label>
          )}
          {(kind === 'folder' || kind === 'sharepoint') && (
            <label className="pq-field">Combina i file con estensione
              <select value={ext} onChange={(e) => setExt(e.target.value)}><option value="csv">.csv</option><option value="parquet">.parquet</option><option value="json">.json</option></select>
            </label>
          )}
          <label className="pq-field">Nome della query<input type="text" value={name} placeholder={valid ? guess() : ''} onChange={(e) => setName(e.target.value)} /></label>
          <div className="pq-note">
            {kind === 'folder' ? 'I file vengono uniti allineando le colonne per nome; la colonna Source.Name indica il file di provenienza.'
              : sp ? "SharePoint Online si legge con l'account Microsoft di Home › Pubblica (app Entra con permessi Microsoft Graph Sites.Read.All e Files.Read.All). I dati restano in cache 10 minuti."
                : 'I dati vengono scaricati da MiB-BI e conservati in cache per 10 minuti; Aggiorna li scarica di nuovo.'}
            {params.length > 0 && <> Parametri utilizzabili: {params.map((p) => <code key={p.name} style={{ marginRight: 6 }}>#[{p.name}]</code>)}.</>}
          </div>
        </div>
        <div className="df">
          {(kind === 'web' || kind === 'odata') && <button className="btn" style={{ marginRight: 'auto' }} disabled={!/^https?:\/\//.test(url.trim())} onClick={() => setCreds(true)}>Credenziali…</button>}
          <button className="btn primary" disabled={!valid} onClick={ok}>OK</button><button className="btn" onClick={close}>Annulla</button>
        </div>
        </>}
      </div>
    </div>
  );
}

/** Power Query › Gestisci parametri. */
export function ParamsDialog({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [list, setList] = useState<PQParam[]>(() => structuredClone(s.report.pqParams ?? []));
  const [sel, setSel] = useState(0);
  const p = list[sel];
  const set = (patch: Partial<PQParam>) => setList(list.map((x, i) => (i === sel ? { ...x, ...patch } : x)));
  const names = list.map((x) => x.name.trim());
  const bad = names.some((n) => !n || !/^[A-Za-z_][\w ]*$/.test(n)) || new Set(names).size !== names.length
    || list.some((x) => x.type === 'number' && !Number.isFinite(Number(x.value))) || list.some((x) => x.type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(x.value));
  const save = () => { s.mut((r) => { r.pqParams = list.map((x) => ({ ...x, name: x.name.trim() })); }); onClose(); };
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog" style={{ width: 'min(720px, 94vw)' }}>
        <div className="dh"><h2>Gestisci parametri</h2><button onClick={onClose}><Icon name="close" /></button></div>
        <div className="db pq-db">
          <div className="param-mgr">
            <div className="param-list">
              <button className="pq-link" onClick={() => { setList([...list, { name: `Parametro${list.length + 1}`, type: 'text', value: '' }]); setSel(list.length); }}>+ Nuovo</button>
              {list.map((x, i) => (
                <div key={i} className={'param-item' + (i === sel ? ' sel' : '')} onClick={() => setSel(i)}>
                  <span>{x.name || '(senza nome)'}</span>
                  <button title="Elimina" onClick={(e) => { e.stopPropagation(); setList(list.filter((_, j) => j !== i)); setSel(Math.max(0, sel - (i <= sel ? 1 : 0))); }}><Icon name="close" size={11} /></button>
                </div>
              ))}
            </div>
            {p ? (
              <div className="param-form">
                <label className="pq-field">Nome<input type="text" value={p.name} onChange={(e) => set({ name: e.target.value })} /></label>
                <label className="pq-field">Descrizione<input type="text" value={p.description ?? ''} onChange={(e) => set({ description: e.target.value || undefined })} /></label>
                <label className="pq-field">Tipo
                  <select value={p.type} onChange={(e) => set({ type: e.target.value as PQParam['type'] })}><option value="text">Testo</option><option value="number">Numero decimale</option><option value="date">Data</option><option value="datetime">Data/ora</option></select>
                </label>
                <label className="pq-field">Valore corrente<input type={p.type === 'date' ? 'date' : p.type === 'datetime' ? 'datetime-local' : 'text'} step={p.type === 'datetime' ? 1 : undefined} value={p.type === 'datetime' ? p.value.replace(' ', 'T') : p.value}
                  onChange={(e) => set({ value: p.type === 'datetime' ? (e.target.value.length === 16 ? e.target.value + ':00' : e.target.value).replace('T', ' ') : e.target.value })} /></label>
                <div className="pq-note">Usare <code>#[{p.name || 'Nome'}]</code> nel percorso o nell'URL di un'origine e nei valori di Filtra righe.</div>
              </div>
            ) : <div className="pq-note">Nessun parametro. Usare <b>Nuovo</b>.</div>}
          </div>
          {bad && <div className="pq-err">Nomi univoci (lettere, cifre, spazi, _), valori numerici o date (AAAA-MM-GG) validi.</div>}
        </div>
        <div className="df"><button className="btn primary" disabled={bad} onClick={save}>OK</button><button className="btn" onClick={onClose}>Annulla</button></div>
      </div>
    </div>
  );
}

const CRED_LABEL: Record<WebCredKind, string> = { basic: 'Di base', apikey: 'API Web', header: 'Intestazione HTTP', oauth: 'Account aziendale (Microsoft)' };

/** Origins of the web sources in use (suggested credential prefixes). */
function sourceOrigins(): string[] {
  const s = useStore.getState();
  const urls = [...s.tables, ...(s.pq?.queries ?? [])].flatMap((t) => [t.source.web?.url, t.source.odata?.url, t.source.sharepoint?.site]).filter((u): u is string => !!u);
  return [...new Set(urls.flatMap((u) => { try { return [new URL(resolveText(u)).origin]; } catch { return []; } }))];
}

/** Credentials form for one URL prefix (used by Impostazioni origine dati and the Web dialog). */
export function CredentialForm({ prefix: initPrefix, onSaved, onCancel }: { prefix?: string; onSaved: () => void; onCancel?: () => void }) {
  const s = useStore();
  const origins = useMemo(sourceOrigins, []);
  const [prefix, setPrefix] = useState(initPrefix ?? origins[0] ?? 'https://');
  const [kind, setKind] = useState<WebCredKind>('basic');
  const [user, setUser] = useState('');
  const [name, setName] = useState('');
  const [secret, setSecret] = useState('');
  const save = async () => {
    try {
      const persistent = await api.webcred.set(prefix.trim(), { kind, ...(user ? { user } : {}), ...(name ? { name } : {}), ...(secret ? { secret } : {}) });
      if (!persistent && kind !== 'oauth') s.notify('Credenziali valide solo per questa sessione: il portachiavi di sistema non è disponibile.');
      onSaved();
    } catch (e: any) { s.notify(e.message); }
  };
  return (
    <div className="pq-db">
      <label className="pq-field">Applica le credenziali a (URL o origine)
        <input type="text" list="cred-origins" value={prefix} onChange={(e) => setPrefix(e.target.value)} />
        <datalist id="cred-origins">{origins.map((o) => <option key={o} value={o} />)}</datalist>
      </label>
      <label className="pq-field">Tipo di autenticazione
        <select value={kind} onChange={(e) => setKind(e.target.value as WebCredKind)}>
          {(Object.keys(CRED_LABEL) as WebCredKind[]).map((k) => <option key={k} value={k}>{CRED_LABEL[k]}</option>)}
        </select>
      </label>
      {kind === 'basic' && <>
        <label className="pq-field">Nome utente<input type="text" value={user} onChange={(e) => setUser(e.target.value)} /></label>
        <label className="pq-field">Password<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      </>}
      {kind === 'apikey' && <>
        <label className="pq-field">Nome del parametro della chiave<input type="text" value={name} placeholder="api_key" onChange={(e) => setName(e.target.value)} /></label>
        <label className="pq-field">Chiave<input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
      </>}
      {kind === 'header' && <>
        <label className="pq-field">Intestazione<input type="text" value={name} placeholder="Authorization" onChange={(e) => setName(e.target.value)} /></label>
        <label className="pq-field">Valore<input type="password" value={secret} placeholder="Bearer …" onChange={(e) => setSecret(e.target.value)} /></label>
      </>}
      {kind === 'oauth' && <div className="pq-note">Usa l'account Microsoft con cui si accede in Home › Pubblica (stessa app Entra, permessi Microsoft Graph Sites.Read.All / Files.Read.All).</div>}
      <div className="pq-note">Le credenziali restano su questo computer (cifrate con il portachiavi di sistema) e non vengono salvate nel report.</div>
      <div className="df" style={{ padding: 0 }}>
        <button className="btn primary" disabled={!/^https?:\/\/[^/]+/.test(prefix.trim())} onClick={save}>Salva</button>
        {onCancel && <button className="btn" onClick={onCancel}>Annulla</button>}
      </div>
    </div>
  );
}

/** Trasforma dati › Impostazioni origine dati: saved Web/OData/SharePoint credentials. */
export function DataSourceSettings({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<WebCredInfo[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [dbKeys, setDbKeys] = useState<string[]>([]);
  const reload = () => { api.webcred.list().then(setList).catch(() => setList([])); api.dbCredentials().then(setDbKeys).catch(() => setDbKeys([])); };
  useEffect(() => { reload(); }, []);
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog" style={{ width: 'min(640px, 94vw)' }}>
        <div className="dh"><h2>Impostazioni origine dati</h2><button onClick={onClose}><Icon name="close" /></button></div>
        <div className="db pq-db">
          {editing === null ? <>
            <div className="pq-note">Credenziali delle origini Web, OData e SharePoint (le origini database si collegano da Ottieni dati › Database).</div>
            <div className="cred-list">
              {!list.length && <div className="side-empty">Nessuna credenziale salvata: le origini vengono lette in modo anonimo.</div>}
              {list.map((c) => (
                <div key={c.prefix} className="cred-row">
                  <div><b>{c.prefix}</b><span>{CRED_LABEL[c.kind]}{c.user ? ` · ${c.user}` : ''}{c.name ? ` · ${c.name}` : ''}{c.persistent || c.kind === 'oauth' ? '' : ' · solo questa sessione'}</span></div>
                  <button className="btn" onClick={() => setEditing(c.prefix)}>Modifica</button>
                  <button className="btn" onClick={async () => { await api.webcred.remove(c.prefix); reload(); }}>Cancella</button>
                </div>
              ))}
            </div>
            <button className="btn" onClick={() => setEditing('')}>Nuove credenziali…</button>
            {dbKeys.length > 0 && <>
              <div className="pq-note" style={{ marginTop: 12 }}>Database (password cifrate nel portachiavi di sistema):</div>
              <div className="cred-list">
                {dbKeys.map((k) => (
                  <div key={k} className="cred-row">
                    <div><b>{k.replace(/^(\w+):\/\//, '')}</b><span>{k.split(':')[0]}</span></div>
                    <button className="btn" onClick={async () => { await api.dbForget(k); reload(); }}>Cancella autorizzazioni</button>
                  </div>
                ))}
              </div>
            </>}
          </> : <CredentialForm prefix={editing || undefined} onSaved={() => { setEditing(null); reload(); }} onCancel={() => setEditing(null)} />}
        </div>
        {editing === null && <div className="df"><button className="btn primary" onClick={onClose}>Chiudi</button></div>}
      </div>
    </div>
  );
}
