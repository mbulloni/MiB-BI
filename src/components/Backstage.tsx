import { useState } from 'react';
import { useStore } from '../store';
import { Icon } from './icons';

export function Backstage() {
  const s = useStore();
  const [tab, setTab] = useState<'home' | 'getdata' | 'options'>('home');
  if (!s.fileMenu) return null;
  const close = () => { setTab('home'); s.set({ fileMenu: false }); };
  // Same sources as Home › Ottieni dati.
  const go = (fn: () => void) => () => { close(); fn(); };
  const sources: [string, string, () => void][] = [
    ['excel', 'Cartella di lavoro di Excel', () => s.openNavigator('excel')],
    ['docs', 'Testo/CSV', () => s.openNavigator('csv')],
    ['docs', 'JSON', () => s.openNavigator('json')],
    ['sql', 'Parquet', () => s.openNavigator('parquet')],
    ['sql', 'Database SQL Server', () => s.set({ dbDialog: 'sqlserver' })],
    ['sql', 'Database SQL di Azure', () => s.set({ dbDialog: 'azuresql' })],
    ['sql', 'Database Oracle', () => s.set({ dbDialog: 'oracle' })],
    ['sql', 'Altri database (MySQL, PostgreSQL, Snowflake, BigQuery, Databricks, ClickHouse, MongoDB, Access…)', () => s.set({ dbDialog: true })],
    ['getData', 'Web', () => s.set({ sourceDialog: 'web' })],
    ['getData', 'Feed OData', () => s.set({ sourceDialog: 'odata' })],
    ['getData', 'Cartella', () => s.set({ sourceDialog: 'folder' })],
    ['getData', 'Cartella SharePoint', () => s.set({ sourceDialog: 'sharepoint' })],
    ['getData', 'Elenco SharePoint Online', () => s.set({ sourceDialog: 'splist' })],
    ['publish', 'Power BI (report e modelli semantici)', () => s.set({ serviceDialog: true })],
    ['enterData', 'Immetti dati', () => s.set({ enterData: true })],
    ['sample', 'Dati di esempio', () => s.loadSample()],
    ['getData', 'Altro…', () => s.openNavigator('any')],
  ];
  return (
    <div className="backstage">
      <nav>
        <button className="back" onClick={close}>← </button>
        <button onClick={() => s.newReport()}>Nuovo</button>
        <button onClick={() => { close(); s.open(); }}>Apri report</button>
        <button onClick={() => s.save()}>Salva</button>
        <button onClick={() => s.save(true)}>Salva con nome</button>
        <button className={tab === 'getdata' ? 'active' : ''} onClick={() => setTab('getdata')}>Ottieni dati</button>
        <button onClick={async () => { const f = await window.api.openFile('powerbi'); if (f) s.importPowerBI(f.path); }}>Importa da Power BI (.pbix, .pbit, .pbip)</button>
        <button onClick={() => s.exportPbix()} disabled={!s.tables.length}>Salva come file Power BI (.pbix)</button>
        <button onClick={() => s.exportPbit()} disabled={!s.tables.length}>Esporta modello Power BI (.pbit)</button>
        <button onClick={() => s.exportPbip()} disabled={!s.tables.length}>Salva come progetto Power BI (.pbip)</button>
        <button onClick={() => s.exportPdf()} disabled={!s.report.pages.some((p) => p.visuals.length)}>Esporta in PDF</button>
        <button onClick={() => s.exportPptx()} disabled={!s.report.pages.some((p) => p.visuals.length)}>Esporta in PowerPoint</button>
        <button onClick={() => s.set({ publishDialog: true, fileMenu: false })}>Pubblica</button>
        <div style={{ flex: 1 }} />
        <button className={tab === 'options' ? 'active' : ''} onClick={() => setTab('options')}>Opzioni e impostazioni</button>
        <button onClick={() => window.api.win.close()}>Esci</button>
      </nav>
      {tab === 'getdata' && (
        <main>
          <h1>Ottieni dati</h1>
          <div className="bs-list">
            {sources.map(([icon, label, fn]) => <button key={label} onClick={go(fn)}><Icon name={icon} size={28} />{label}</button>)}
          </div>
        </main>
      )}
      {tab === 'options' && (
        <main>
          <h1>Opzioni e impostazioni</h1>
          <div className="bs-list">
            <button onClick={go(() => s.set({ optionsDialog: true }))}><Icon name="gear" size={28} /><span><b>Opzioni</b><br />Opzioni per caricamento dati, script Python e R, domande e risposte e il file corrente.</span></button>
            <button onClick={go(() => s.openPowerQuery())}><Icon name="getData" size={28} /><span><b>Impostazioni origine dati</b><br />Gestire le credenziali e le autorizzazioni delle origini dati (dall'Editor di Power Query).</span></button>
          </div>
        </main>
      )}
      {tab === 'home' && <main>
        <h1>Buongiorno</h1>
        <div className="tiles">
          <button className="tile" onClick={() => s.newReport()}><Icon name="newPage" size={36} />Report vuoto</button>
          <button className="tile" onClick={() => { close(); s.open(); }}><Icon name="docs" size={36} />Apri report</button>
          <button className="tile" onClick={() => s.loadSample()}><Icon name="sample" size={36} />Dati di esempio</button>
          <button className="tile" onClick={() => s.openNavigator('any')}><Icon name="getData" size={36} />Ottieni dati</button>
          <button className="tile" onClick={async () => { const f = await window.api.openFile('powerbi'); if (f) s.importPowerBI(f.path); }}><Icon name="sample" size={36} />Apri file Power BI</button>
        </div>
      </main>}
    </div>
  );
}
