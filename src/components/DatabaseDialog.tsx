import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import type { DbConnection, DbKind } from '../types';
import { Icon } from './icons';

/** Connectors of Ottieni dati › Database. `kind` = driver, `variant` = Power BI connector sharing that driver. */
export interface Connector { id: string; label: string; kind: DbKind; variant?: string; port: string; group: string; }
export const CONNECTORS: Connector[] = [
  { id: 'sqlserver', label: 'Database SQL Server', kind: 'sqlserver', port: '1433', group: 'Database' },
  { id: 'azuresql', label: 'Database SQL di Azure', kind: 'sqlserver', variant: 'azuresql', port: '1433', group: 'Azure' },
  { id: 'synapse', label: 'Azure Synapse Analytics (SQL DW)', kind: 'sqlserver', variant: 'synapse', port: '1433', group: 'Azure' },
  { id: 'fabric', label: 'Endpoint SQL di Microsoft Fabric / Warehouse', kind: 'sqlserver', variant: 'fabric', port: '1433', group: 'Azure' },
  { id: 'oracle', label: 'Database Oracle', kind: 'oracle', port: '1521', group: 'Database' },
  { id: 'mysql', label: 'Database MySQL', kind: 'mysql', port: '3306', group: 'Database' },
  { id: 'mariadb', label: 'MariaDB', kind: 'mysql', variant: 'mariadb', port: '3306', group: 'Database' },
  { id: 'azurepg', label: 'Database di Azure per PostgreSQL', kind: 'postgres', variant: 'azurepg', port: '5432', group: 'Azure' },
  { id: 'azuremysql', label: 'Database di Azure per MySQL', kind: 'mysql', variant: 'azuremysql', port: '3306', group: 'Azure' },
  { id: 'postgres', label: 'Database PostgreSQL', kind: 'postgres', port: '5432', group: 'Database' },
  { id: 'redshift', label: 'Amazon Redshift', kind: 'postgres', variant: 'redshift', port: '5439', group: 'Database' },
  { id: 'sqlite', label: 'Database SQLite (file)', kind: 'sqlite', port: '', group: 'Database' },
  { id: 'access', label: 'Database di Access (.accdb, .mdb)', kind: 'access', port: '', group: 'Database' },
  { id: 'snowflake', label: 'Snowflake', kind: 'snowflake', port: '', group: 'Database' },
  { id: 'bigquery', label: 'Google BigQuery', kind: 'bigquery', port: '', group: 'Database' },
  { id: 'databricks', label: 'Azure Databricks / Databricks', kind: 'databricks', port: '', group: 'Azure' },
  { id: 'kusto', label: 'Azure Data Explorer (Kusto)', kind: 'kusto', port: '', group: 'Azure' },
  { id: 'dataverse', label: 'Dataverse (Power Platform, Dynamics 365)', kind: 'dataverse', port: '', group: 'Azure' },
  { id: 'clickhouse', label: 'ClickHouse', kind: 'clickhouse', port: '8123', group: 'Database' },
  { id: 'polaris', label: 'Apache Polaris (catalogo Iceberg)', kind: 'iceberg', variant: 'polaris', port: '', group: 'Altro' },
  { id: 'iceberg', label: 'Catalogo Apache Iceberg REST (Nessie, Lakekeeper, Gravitino…)', kind: 'iceberg', port: '', group: 'Altro' },
  { id: 'mongodb', label: 'MongoDB', kind: 'mongodb', port: '27017', group: 'Altro' },
  { id: 'odbc', label: 'ODBC (SAP HANA, Db2, Teradata, Informix, Vertica…)', kind: 'odbc', port: '', group: 'Altro' },
];

const AUTHS: Record<string, [string, string][]> = {
  sqlserver: [['sql', 'Database (nome utente e password)'], ['windows', 'Windows (dominio, NTLM)'], ['token', 'Account Microsoft (accesso di MiB-BI)'], ['entra', 'Microsoft Entra ID (utente e password)']],
  snowflake: [['sql', 'Snowflake (nome utente e password)'], ['keypair', 'Coppia di chiavi (chiave privata)'], ['browser', 'Microsoft Entra ID / SSO (browser)']],
  bigquery: [['key', 'Chiave dell\'account di servizio (JSON)'], ['adc', 'Credenziali predefinite dell\'applicazione (gcloud)']],
};

/** Polaris grants a principal its roles through this scope (default of its quickstart and of Spark/PyIceberg setups). */
const POLARIS_SCOPE = 'PRINCIPAL_ROLE:ALL';
const qi = (s: string) => '"' + s.replace(/"/g, '""') + '"';
const TOKEN_HINT = 'Usa l\'account Microsoft con cui si accede in MiB-BI (Pubblica / Accedi): l\'app registrata deve avere l\'autorizzazione delegata Azure SQL Database › user_impersonation.';

/** Ottieni dati › Database: connector form (with Opzioni avanzate › Istruzione SQL), then a navigator over the tables. */
export function DatabaseDialog() {
  const s = useStore();
  const open = s.dbDialog;
  const [cid, setCid] = useState('sqlserver');
  const conn0 = CONNECTORS.find((c) => c.id === cid)!;
  const kind = conn0.kind;
  const [form, setForm] = useState({ host: 'localhost', port: '', database: '', user: '', password: '', file: '', remember: true, auth: 'sql', domain: '',
    encrypt: true, trustCert: false, warehouse: '', role: '', httpPath: '', authDb: '', scope: '', tokenUri: '', query: '', advanced: false, mode: 'import' as 'import' | 'directQuery' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conn, setConn] = useState<{ c: DbConnection; alias: string | null; tables: { schema: string; table: string; rows: number | null; view?: boolean }[]; stored: boolean } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<{ columns: string[]; rows: any[] } | null>(null);

  useEffect(() => {
    if (!open) return;
    setConn(null); setError(null); setPicked(new Set()); setFocus(null);
    if (typeof open === 'string' && CONNECTORS.some((c) => c.id === open)) { setCid(open); setForm((f) => ({ ...f, auth: open === 'bigquery' ? 'key' : open === 'fabric' ? 'token' : 'sql', encrypt: true, ...(CONNECTORS.find((c) => c.id === open)!.kind === 'iceberg' && f.host === 'localhost' ? { host: '' } : {}) })); }
    if (typeof open === 'string' && open.startsWith('{')) {
      // Origini recenti: a saved connection (never its password)
      const c = JSON.parse(open) as DbConnection;
      const target = CONNECTORS.find((x) => x.kind === c.kind && (x.variant ?? undefined) === (c.variant ?? undefined)) ?? CONNECTORS.find((x) => x.kind === c.kind);
      if (target) setCid(target.id);
      setForm((f) => ({ ...f, host: c.host ?? '', port: c.port ?? '', database: c.database ?? '', user: c.user ?? '', file: c.file ?? '', auth: c.auth ?? 'sql',
        domain: c.domain ?? '', encrypt: c.encrypt !== false, trustCert: !!c.trustCert, warehouse: c.warehouse ?? '', role: c.role ?? '', httpPath: c.httpPath ?? '', authDb: c.authDb ?? '', scope: c.scope ?? '', tokenUri: c.tokenUri ?? '', password: '' }));
    }
  }, [open]);
  useEffect(() => {
    if (!conn || !focus) { setPreview(null); return; }
    setPreview(null);
    const [schema, table] = focus.split('\u0001');
    const src = conn.c.query && table === QUERY ? { ...conn.c, schema: '', table } : { ...conn.c, query: undefined, schema, table };
    (conn.alias && !conn.c.query ? api.query(`SELECT * FROM ${qi(conn.alias)}.${qi(schema)}.${qi(table)} LIMIT 50`) : api.dbPreview(src, 50))
      .then(setPreview).catch((e) => setPreview({ columns: ['Errore'], rows: [{ Errore: e.message }] }));
  }, [conn, focus]);
  const grouped = useMemo(() => ['Database', 'Azure', 'Altro'].map((g) => [g, CONNECTORS.filter((c) => c.group === g)] as const), []);
  if (!open) return null;

  const close = () => s.set({ dbDialog: false });
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const fileKind = kind === 'sqlite' || kind === 'access';
  const connection = (): DbConnection => {
    if (fileKind) return { kind, file: form.file };
    const base: DbConnection = { kind, ...(conn0.variant ? { variant: conn0.variant } : {}), host: form.host.trim() || 'localhost', port: form.port.trim() || undefined,
      database: form.database.trim() || undefined, user: form.user.trim() || undefined };
    if (kind === 'sqlserver') Object.assign(base, { auth: form.auth, ...(form.auth === 'windows' ? { domain: form.domain.trim() } : {}), encrypt: form.encrypt, trustCert: form.trustCert });
    if (kind === 'snowflake') Object.assign(base, { auth: form.auth, warehouse: form.warehouse.trim() || undefined, role: form.role.trim() || undefined });
    if (kind === 'databricks') Object.assign(base, { httpPath: form.httpPath.trim(), user: undefined });
    if (kind === 'bigquery') Object.assign(base, { auth: form.auth, file: form.auth === 'key' ? form.file : undefined, host: form.host.trim() === 'localhost' ? undefined : form.host.trim() || undefined, user: undefined });
    if (kind === 'mongodb') Object.assign(base, { authDb: form.authDb.trim() || undefined });
    if (kind === 'clickhouse') Object.assign(base, { encrypt: form.encrypt });
    if (kind === 'iceberg') Object.assign(base, { host: form.host.trim(), port: undefined, scope: form.scope.trim() || (conn0.variant === 'polaris' ? POLARIS_SCOPE : undefined), tokenUri: form.tokenUri.trim() || undefined });
    if (form.advanced && form.query.trim()) base.query = form.query.trim();
    return base;
  };
  const needsSecret = !fileKind && !['bigquery', 'kusto', 'dataverse'].includes(kind) && !(kind === 'sqlserver' && form.auth === 'token') && !(kind === 'snowflake' && form.auth === 'browser');
  const sqlCapable = !['mongodb', 'access', 'sqlite', 'dataverse', 'iceberg'].includes(kind);

  const doConnect = async () => {
    setBusy(true); setError(null);
    try {
      const c = connection();
      const r = await api.dbConnect(c, needsSecret ? form.password : null, form.remember);
      if (c.query) {
        setConn({ c, ...r, alias: r.alias, tables: [{ schema: '', table: QUERY, rows: null }] });
        setPicked(new Set([`\u0001${QUERY}`])); setFocus(`\u0001${QUERY}`);
      } else {
        if (!r.tables.length) throw new Error('Connessione riuscita, ma il database non contiene tabelle visibili.');
        setConn({ c, ...r });
      }
      setForm({ ...form, password: '' });
    } catch (e: any) {
      setError(e.message.split('\n')[0]);
    } finally { setBusy(false); }
  };

  const key = (t: { schema: string; table: string }) => `${t.schema}\u0001${t.table}`;
  const load = (transform: boolean) => {
    const picks = conn!.tables.filter((t) => picked.has(key(t)));
    s.loadDbTables(conn!.c, picks, transform, form.mode);
  };
  const where = (c: DbConnection) => (fileKind ? c.file?.split('/').pop() : `${c.host}${c.database ? ' / ' + c.database : ''}`);
  const browse = async (k: string, field: 'file') => { const p = await api.openDataDialog(k); if (p) set({ [field]: p }); };

  return (
    <div className="modal-bg">
      <div className="dialog" style={{ width: conn ? 'min(1100px, 92vw)' : 600, height: conn ? '78vh' : undefined }}>
        <div className="dh"><h2>{conn ? 'Strumento di navigazione' : conn0.label}</h2><button onClick={close}><Icon name="close" /></button></div>
        {!conn ? (
          <div className="db pq-db" style={{ maxHeight: '72vh', overflow: 'auto' }}>
            <label className="pq-field">Connettore
              <select value={cid} onChange={(e) => { const id = e.target.value; setCid(id); set({ port: '', auth: id === 'bigquery' ? 'key' : id === 'fabric' ? 'token' : 'sql', ...(CONNECTORS.find((c) => c.id === id)?.kind === 'iceberg' && form.host === 'localhost' ? { host: '' } : {}) }); }}>
                {grouped.map(([g, list]) => <optgroup key={g} label={g}>{list.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</optgroup>)}
              </select>
            </label>
            {fileKind && (
              <label className="pq-field">File
                <div className="pq-row">
                  <input type="text" value={form.file} onChange={(e) => set({ file: e.target.value })} placeholder={kind === 'access' ? '/percorso/database.accdb' : '/percorso/database.sqlite'} />
                  <button className="btn" style={{ minWidth: 0 }} onClick={() => browse(kind, 'file')}>Sfoglia…</button>
                </div>
              </label>
            )}
            {!fileKind && <>
              <div className="pq-row" style={{ alignItems: 'flex-start' }}>
                <label className="pq-field" style={{ flex: 3 }}>{kind === 'snowflake' ? 'Server (account.snowflakecomputing.com)' : kind === 'databricks' ? 'Nome host del server' : kind === 'bigquery' ? 'Endpoint (facoltativo, es. emulatore)' : kind === 'oracle' ? 'Server (host:porta/servizio)' : kind === 'mongodb' ? 'Server o stringa di connessione' : kind === 'odbc' ? 'Nome origine dati (DSN) o stringa di connessione' : kind === 'kusto' ? 'Cluster' : kind === 'dataverse' ? 'URL dell\'ambiente' : kind === 'iceberg' ? 'URI del catalogo REST' : 'Server'}
                  <input type="text" value={kind === 'bigquery' && form.host === 'localhost' ? '' : form.host} onChange={(e) => set({ host: e.target.value })} placeholder={kind === 'iceberg' ? (conn0.variant === 'polaris' ? 'https://polaris.azienda.it/api/catalog' : 'https://catalogo.azienda.it/iceberg') : kind === 'kusto' ? 'https://cluster.westeurope.kusto.windows.net' : kind === 'dataverse' ? 'https://organizzazione.crm4.dynamics.com' : conn0.variant === 'azuresql' ? 'server.database.windows.net' : conn0.variant === 'fabric' ? 'xxxx.datawarehouse.fabric.microsoft.com' : kind === 'sqlserver' ? 'server\\istanza' : ''} />
                </label>
                {conn0.port && kind !== 'oracle' && <label className="pq-field" style={{ flex: 1 }}>Porta<input type="text" value={form.port} placeholder={conn0.port} onChange={(e) => set({ port: e.target.value })} /></label>}
              </div>
              {kind === 'databricks' && <label className="pq-field">Percorso HTTP<input type="text" value={form.httpPath} onChange={(e) => set({ httpPath: e.target.value })} placeholder="/sql/1.0/warehouses/…" /></label>}
              {kind === 'snowflake' && <label className="pq-field">Warehouse<input type="text" value={form.warehouse} onChange={(e) => set({ warehouse: e.target.value })} /></label>}
              {kind === 'odbc' && <div className="pq-note">Esempi: <code>DSN=Vendite</code> oppure <code>Driver={'{'}HDBODBC{'}'};ServerNode=host:30015</code>. Richiede unixODBC e il driver ODBC del database installati nel sistema (<code>odbcinst -q -d</code> li elenca).</div>}
              {(kind === 'kusto' || kind === 'dataverse') && <div className="pq-note">{TOKEN_HINT.replace('Azure SQL Database › user_impersonation', kind === 'kusto' ? 'Azure Data Explorer › user_impersonation' : 'Dynamics CRM › user_impersonation')}</div>}
              {kind !== 'oracle' && kind !== 'odbc' && kind !== 'dataverse' && <label className="pq-field">{kind === 'bigquery' ? 'ID progetto' : kind === 'databricks' ? 'Catalogo (facoltativo)' : kind === 'iceberg' ? (conn0.variant === 'polaris' ? 'Warehouse (nome del catalogo Polaris)' : 'Warehouse') : 'Database (facoltativo)'}<input type="text" value={form.database} onChange={(e) => set({ database: e.target.value })} /></label>}
              {kind === 'iceberg' && <div className="pq-note">{conn0.variant === 'polaris' ? 'Le tabelle Iceberg vengono lette con DuckDB: i file (S3, ADLS, GCS) con le credenziali temporanee fornite da Polaris. ID e segreto client sono le credenziali OAuth2 del principal Polaris.'
                : 'Le tabelle Iceberg vengono lette con DuckDB: i file (S3, ADLS, GCS) con le credenziali temporanee fornite dal catalogo. ID e segreto client (OAuth2) vanno lasciati vuoti se il catalogo non richiede autenticazione.'}</div>}
              {kind === 'oracle' && <div className="pq-note">Esempi: <code>db.azienda.it:1521/ORCLPDB1</code> oppure una descrizione TNS completa.</div>}
              {AUTHS[kind] && (
                <label className="pq-field">Autenticazione
                  <select value={form.auth} onChange={(e) => set({ auth: e.target.value })}>{AUTHS[kind].map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
                </label>
              )}
              {kind === 'sqlserver' && form.auth === 'token' && <div className="pq-note">{TOKEN_HINT}</div>}
              {kind === 'sqlserver' && form.auth === 'windows' && <label className="pq-field">Dominio<input type="text" value={form.domain} onChange={(e) => set({ domain: e.target.value })} placeholder="AZIENDA" /></label>}
              {kind === 'bigquery' && form.auth === 'key' && (
                <label className="pq-field">File di chiave JSON
                  <div className="pq-row"><input type="text" value={form.file} onChange={(e) => set({ file: e.target.value })} /><button className="btn" style={{ minWidth: 0 }} onClick={() => browse('key', 'file')}>Sfoglia…</button></div>
                </label>
              )}
              {needsSecret && (
                <div className="pq-row" style={{ alignItems: 'flex-start' }}>
                  {kind !== 'databricks' && <label className="pq-field" style={{ flex: 1 }}>{kind === 'iceberg' ? 'ID client' : 'Nome utente'}<input type="text" value={form.user} onChange={(e) => set({ user: e.target.value })} /></label>}
                  <label className="pq-field" style={{ flex: 1 }}>{kind === 'databricks' ? 'Token di accesso personale' : kind === 'iceberg' ? 'Segreto client' : kind === 'snowflake' && form.auth === 'keypair' ? 'Chiave privata (PEM)' : 'Password'}
                    {kind === 'snowflake' && form.auth === 'keypair'
                      ? <textarea rows={3} value={form.password} onChange={(e) => set({ password: e.target.value })} />
                      : <input type="password" value={form.password} onChange={(e) => set({ password: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && doConnect()} />}
                  </label>
                </div>
              )}
              {kind === 'snowflake' && form.auth !== 'sql' && <label className="pq-field">Nome utente<input type="text" value={form.user} onChange={(e) => set({ user: e.target.value })} /></label>}
              {kind === 'iceberg' && (
                <div className="pq-row" style={{ alignItems: 'flex-start' }}>
                  <label className="pq-field" style={{ flex: 1 }}>Ambito OAuth2<input type="text" value={form.scope} placeholder={conn0.variant === 'polaris' ? POLARIS_SCOPE : 'facoltativo'} onChange={(e) => set({ scope: e.target.value })} /></label>
                  <label className="pq-field" style={{ flex: 2 }}>URI del token OAuth2<input type="text" value={form.tokenUri} placeholder={(form.host.trim().replace(/\/+$/, '') || 'URI del catalogo') + '/v1/oauth/tokens'} onChange={(e) => set({ tokenUri: e.target.value })} /></label>
                </div>
              )}
              {kind === 'mongodb' && <label className="pq-field">Database di autenticazione<input type="text" value={form.authDb} placeholder="admin" onChange={(e) => set({ authDb: e.target.value })} /></label>}
              {(kind === 'sqlserver' || kind === 'clickhouse') && (
                <div className="pq-row" style={{ gap: 16 }}>
                  <label className="pq-check"><input type="checkbox" checked={form.encrypt} onChange={(e) => set({ encrypt: e.target.checked })} />{kind === 'clickhouse' ? 'HTTPS' : 'Crittografa la connessione'}</label>
                  {kind === 'sqlserver' && <label className="pq-check"><input type="checkbox" checked={form.trustCert} onChange={(e) => set({ trustCert: e.target.checked })} />Considera attendibile il certificato del server</label>}
                </div>
              )}
              {needsSecret && <label className="pq-check"><input type="checkbox" checked={form.remember} onChange={(e) => set({ remember: e.target.checked })} />Ricorda le credenziali (cifrate nel portachiavi di sistema, mai salvate nel report)</label>}
              {sqlCapable && (
                <details open={form.advanced} onToggle={(e) => set({ advanced: (e.target as HTMLDetailsElement).open })}>
                  <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 12 }}>Opzioni avanzate</summary>
                  <label className="pq-field" style={{ marginTop: 6 }}>Istruzione SQL (facoltativa, richiede un database)
                    <textarea rows={5} value={form.query} onChange={(e) => set({ query: e.target.value })} placeholder="SELECT …" style={{ fontFamily: 'monospace' }} />
                  </label>
                </details>
              )}
            </>}
            <div className="pq-field">Modalità Connettività dati
              <div className="pq-row" style={{ gap: 16 }}>
                <label className="pq-check"><input type="radio" name="dq-mode" checked={form.mode === 'import'} onChange={() => set({ mode: 'import' })} />Importa</label>
                <label className="pq-check"><input type="radio" name="dq-mode" checked={form.mode === 'directQuery'} onChange={() => set({ mode: 'directQuery' })} />DirectQuery</label>
              </div>
              <span className="hint">{form.mode === 'import' ? 'I dati vengono copiati nel modello e aggiornati con Aggiorna.'
                : ['mysql', 'postgres', 'sqlite', 'iceberg'].includes(kind) ? 'I dati restano nel database: ogni oggetto visivo lo interroga al momento (vista DuckDB sul database collegato).'
                : 'Ogni oggetto visivo legge i dati dal risultato della query; l\'aggiornamento automatico della pagina e Aggiorna rieseguono la query sul database.'}
                {['mysql', 'postgres', 'sqlite', 'iceberg'].includes(kind) ? ' Al primo uso DuckDB scarica l\'estensione del connettore.' : ''}</span>
            </div>
            {error && <div className="pq-err" style={{ userSelect: 'text' }}>{error}</div>}
          </div>
        ) : (
          <div className="db">
            <div className="nav-left" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input type="search" placeholder="Cerca" value={q} onChange={(e) => setQ(e.target.value)} />
              <div className="item"><Icon name="sql" size={16} box={32} /><b>{where(conn.c)}</b> [{conn.tables.length}]</div>
              <div style={{ overflow: 'auto', flex: 1 }}>
                {conn.tables.filter((t) => !q || t.table.toLowerCase().includes(q.toLowerCase())).map((t) => (
                  <div key={key(t)} className={'item' + (focus === key(t) ? ' sel' : '')} style={{ paddingLeft: 14, cursor: 'pointer' }} onClick={() => setFocus(key(t))}>
                    <input type="checkbox" checked={picked.has(key(t))} onClick={(e) => e.stopPropagation()} onChange={() => { const n = new Set(picked); n.has(key(t)) ? n.delete(key(t)) : n.add(key(t)); setPicked(n); setFocus(key(t)); }} />
                    <Icon name="tableSmall" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`${t.schema}.${t.table}`}>{t.schema && !['public', 'dbo', 'main'].includes(t.schema) && kind !== 'mysql' ? `${t.schema}.` : ''}{t.table}{t.view ? ' (vista)' : ''}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="nav-right">
              <div className="ttl">{focus ? focus.split('\u0001')[1] : 'Selezionare una tabella per l\'anteprima'}</div>
              <div className="grid-wrap">
                {focus && !preview && <div className="pq-note" style={{ padding: 12 }}>Caricamento dell'anteprima…</div>}
                {preview && (
                  <table>
                    <thead><tr>{preview.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>{preview.rows.map((r, i) => <tr key={i}>{preview.columns.map((c) => <td key={c}>{r[c] === null || r[c] === undefined ? '' : String(r[c])}</td>)}</tr>)}</tbody>
                  </table>
                )}
              </div>
              <div className="nav-note">{needsSecret ? (conn.stored ? 'Credenziali memorizzate nel portachiavi di sistema.' : 'Portachiavi non disponibile: le credenziali restano valide solo per questa sessione.') + ' ' : ''}Anteprima: prime 50 righe.</div>
            </div>
          </div>
        )}
        <div className="df">
          {!conn ? <>
            <button className="btn primary" disabled={busy || (fileKind ? !form.file : kind === 'bigquery' ? !form.database || (form.auth === 'key' && !form.file) : kind === 'iceberg' ? !form.host.trim() || !form.database.trim() : !form.host || (kind === 'databricks' && !form.httpPath))} onClick={doConnect}>{busy ? 'Connessione…' : 'Connetti'}</button>
            <button className="btn" onClick={close}>Annulla</button>
          </> : <>
            <button className="btn primary" disabled={!picked.size} onClick={() => load(false)}>Carica</button>
            <button className="btn" disabled={!picked.size} onClick={() => load(true)}>Trasforma dati</button>
            <button className="btn" onClick={() => setConn(null)}>Indietro</button>
            <button className="btn" onClick={close}>Annulla</button>
          </>}
        </div>
      </div>
    </div>
  );
}

/** Navigator item of a native SQL statement (Power BI names it "Query1"). */
const QUERY = 'Query1';
