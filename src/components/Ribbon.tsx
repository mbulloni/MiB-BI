import { NO_CALCS } from '../visuals/visualCalc';
import { useEffect, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { bname } from '../pbix/layout';
import { Icon, VisualIcon } from './icons';
import { Menu } from './Menu';
import { VISUALS } from '../visuals/catalog';
import { THEMES } from '../themes';
import { cultureName } from './TranslationsDialog';
import { checkUpdates } from './Updates';
import type { SensitivityLabel, Theme } from '../types';
import { api } from '../api';

function ThemeSwatch({ t, active, onClick, label }: { t: Theme; active: boolean; onClick: () => void; label?: boolean }) {
  return (
    <button className={'theme-swatch' + (active ? ' active' : '')} title={t.name} onClick={onClick}>
      <span className="sw" style={{ background: t.background ?? '#fff' }}>
        <b style={{ color: t.foreground ?? '#252423' }}>Aa</b>
        <span className="bars">{t.dataColors.slice(0, 4).map((c, i) => <i key={i} style={{ background: c }} />)}</span>
      </span>
      {label && <span className="nm">{t.name}</span>}
    </button>
  );
}

type Tab = 'home' | 'insert' | 'modeling' | 'view' | 'optimize' | 'help' | 'format' | 'table';
const TABS: [Tab, string][] = [['home', 'Home'], ['insert', 'Inserisci'], ['modeling', 'Modellazione'], ['view', 'Visualizza'], ['optimize', 'Ottimizza'], ['help', 'Guida']];

export function Group({ label, children }: { label: string; children: ReactNode }) {
  return <div className="rgroup"><div className="items">{children}</div><div className="label">{label}</div></div>;
}

export function Big({ icon, label, onClick, disabled, dropdown, title }: { icon: string; label: ReactNode; onClick?: (e: React.MouseEvent) => void; disabled?: boolean; dropdown?: boolean; title?: string }) {
  return (
    <button className="rbtn-l" onClick={onClick} disabled={disabled} title={title}>
      <Icon name={icon} size={32} />
      <span className="lbl"><span>{label}{dropdown && <span className="chev"><Icon name="chevronDown" size={10} /></span>}</span></span>
    </button>
  );
}

export function Small({ icon, label, onClick, disabled }: { icon: string; label: string; onClick?: () => void; disabled?: boolean }) {
  return <button className="rbtn-s" onClick={onClick} disabled={disabled}><Icon name={icon} size={16} />{label}</button>;
}

type MenuState = { kind: string; x: number; y: number } | null;

export function Ribbon() {
  const s = useStore();
  const [tab, setTab] = useState<Tab>('home');
  const [menu, setMenu] = useState<MenuState>(null);
  const report = s.view === 'report';
  const sel = s.selectedVisualId;
  const openMenu = (kind: string) => (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu({ kind, x: r.left, y: r.bottom + 2 });
  };
  const close = () => setMenu(null);
  const selVisual = sel ? s.page().visuals.find((v) => v.id === sel) : undefined;
  // The contextual Formato tab goes away with the selection.
  useEffect(() => { if (tab === 'format' && !selVisual && !s.editInteractions) setTab('home'); }, [tab, selVisual, s.editInteractions]);
  // Nuovo calcolo visivo: on the selected visual (not slicers, scripts, AI or custom visuals).
  const calcOk = !!selVisual && report && !NO_CALCS.has(selVisual.type) && Object.values(selVisual.fields).some((l) => l.length);
  const calcVisual = <Big icon="visualCalc" label={<>Nuovo calcolo<br />visivo</>} disabled={!calcOk} onClick={() => selVisual && s.startVisualCalc(selVisual.id)}
    title={calcOk ? 'Calcolo DAX sui dati mostrati nell\'oggetto visivo (somma parziale, media mobile, % del totale…)' : 'Selezionare un oggetto visivo con dei campi'} />;
  // Strumenti tabella: contextual tab of the table shown in the Table view.
  const toolTable = s.view === 'data' ? s.tables.find((t) => t.name === s.dataViewTable) : undefined;
  useEffect(() => { if (tab === 'table' && !toolTable) setTab('home'); }, [tab, toolTable]);

  const copy = () => selVisual && s.set({ clipboard: JSON.parse(JSON.stringify(selVisual)) });
  const cut = () => { if (selVisual) { copy(); s.removeVisual(selVisual.id); } };
  const paste = () => {
    const c = s.clipboard;
    if (!c) return;
    const id = s.addVisual(c.type, { x: c.x + 20, y: c.y + 20 });
    const past = useStore.getState().past;
    s.updateVisual(id, { fields: c.fields, format: c.format, w: c.w, h: c.h, text: c.text, slicerValues: c.slicerValues });
    useStore.setState({ past }); // collapse into a single undo step with the add
  };

  const dataGroup = (
    <Group label="Dati">
      <Big icon="getData" label={<>Ottieni<br />dati</>} dropdown onClick={openMenu('getdata')} />
      <Big icon="excel" label={<>Cartella di<br />lavoro di Excel</>} onClick={() => s.openNavigator('excel')} />
      <Big icon="sql" label={<>SQL<br />Server</>} onClick={() => s.set({ dbDialog: 'sqlserver' })} title="Database SQL Server / SQL di Azure" />
      <Big icon="enterData" label={<>Immetti<br />dati</>} onClick={() => s.set({ enterData: true })} />
      <Big icon="recent" label={<>Origini<br />recenti</>} dropdown onClick={openMenu('recent')} />
    </Group>
  );

  return (
    <div className="ribbon">
      <div className="ribbon-tabs">
        <button className="file" onClick={() => s.set({ fileMenu: true })}>File</button>
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
        {/* Contextual tab of the selected visual, like Power BI's Formato. */}
        {report && (selVisual || s.editInteractions) && <button className={'ctx' + (tab === 'format' ? ' active' : '')} onClick={() => setTab('format')}>Formato</button>}
        {toolTable && <button className={'ctx' + (tab === 'table' ? ' active' : '')} onClick={() => setTab('table')}>Strumenti tabella</button>}
      </div>
      <div className="ribbon-body">
        {tab === 'home' && <>
          <Group label="Appunti">
            <Big icon="paste" label="Incolla" onClick={paste} disabled={!s.clipboard || !report} />
            <div className="rcol">
              <Small icon="cut" label="Taglia" onClick={cut} disabled={!selVisual} />
              <Small icon="copy" label="Copia" onClick={copy} disabled={!selVisual} />
              <Small icon="painter" label={s.formatPainter ? 'Copia formato (attivo)' : 'Copia formato'} disabled={!selVisual && !s.formatPainter}
                onClick={() => s.set({ formatPainter: s.formatPainter ? null : selVisual ? { from: selVisual.id, type: selVisual.type, format: structuredClone(selVisual.format), style: selVisual.style ? structuredClone(selVisual.style) : undefined } : null })} />
            </div>
          </Group>
          {dataGroup}
          <Group label="Query">
            <Big icon="transform" label={<>Trasforma<br />dati</>} onClick={() => s.openPowerQuery(s.dataViewTable ?? undefined)} title="Apre l'editor di Power Query" />
            <Big icon="refresh" label="Aggiorna" onClick={() => s.refresh()} disabled={!s.tables.length} />
          </Group>
          <Group label="Inserisci">
            <Big icon="newVisual" label={<>Nuovo oggetto<br />visivo</>} onClick={() => s.addVisual('clusteredColumn')} disabled={!report} />
            <Big icon="textBox" label={<>Casella di<br />testo</>} onClick={() => s.addVisual('textbox')} disabled={!report} />
            <Big icon="moreVisuals" label={<>Altri oggetti<br />visivi</>} dropdown onClick={openMenu('visuals')} disabled={!report} />
          </Group>
          {s.view === 'model' && (
            <Group label="Relazioni">
              <Big icon="relationships" label={<>Gestisci<br />relazioni</>} onClick={() => s.set({ relManage: true })} disabled={!s.tables.length} />
            </Group>
          )}
          <Group label="Parametri">
            <Big icon="newTable" label={<>Nuovo<br />parametro</>} dropdown onClick={openMenu('params')} disabled={!s.tables.length} />
          </Group>
          <Group label="Calcoli">
            {calcVisual}
            <Big icon="measure" label={<>Nuova<br />misura</>} onClick={() => s.startDax('measure')} disabled={!s.tables.length} />
            <Big icon="quickMeasure" label={<>Misura<br />rapida</>} onClick={() => s.set({ quickMeasure: true })} disabled={!s.tables.length} />
          </Group>
          <Group label="Riservatezza"><Big icon="sensitivity" label="Riservatezza" dropdown onClick={openMenu('sensitivity')} /></Group>
          <Group label="Condividi"><Big icon="publish" label="Pubblica" onClick={() => s.set({ publishDialog: true })} /></Group>
        </>}

        {tab === 'insert' && <>
          <Group label="Pagine"><Big icon="newPage" label={<>Nuova<br />pagina</>} dropdown onClick={openMenu('newpage')} disabled={!report} /></Group>
          <Group label="Oggetti visivi">
            <Big icon="newVisual" label={<>Nuovo oggetto<br />visivo</>} onClick={() => s.addVisual('clusteredColumn')} disabled={!report} />
            <Big icon="moreVisuals" label={<>Altri oggetti<br />visivi</>} dropdown onClick={openMenu('visuals')} disabled={!report} />
          </Group>
          <Group label="Elementi">
            <Big icon="textBox" label={<>Casella di<br />testo</>} onClick={() => s.addVisual('textbox')} disabled={!report} />
            <Big icon="newVisual" label="Scheda" onClick={() => s.addVisual('card')} disabled={!report} />
            <Big icon="newTable" label="Tabella" onClick={() => s.addVisual('table')} disabled={!report} />
            <Big icon="newVisual" label="Pulsanti" dropdown onClick={openMenu('buttons')} disabled={!report} />
          </Group>
        </>}

        {tab === 'modeling' && <>
          <Group label="Relazioni">
            <Big icon="relationships" label={<>Gestisci<br />relazioni</>} onClick={() => s.set({ relManage: true })} disabled={!s.tables.length} />
            <Big icon="refresh" label={<>Rilevamento<br />automatico</>} disabled={s.tables.length < 2} onClick={async () => {
              const n = await s.detectRelationships();
              s.notify(n ? `Rilevate ${n} nuove relazioni.` : 'Nessuna nuova relazione rilevata.');
            }} />
          </Group>
          <Group label="Calcoli">
            {calcVisual}
            <Big icon="measure" label={<>Nuova<br />misura</>} onClick={() => s.startDax('measure')} disabled={!s.tables.length} />
            <Big icon="quickMeasure" label={<>Misura<br />rapida</>} onClick={() => s.set({ quickMeasure: true })} disabled={!s.tables.length} />
            <Big icon="newColumn" label={<>Nuova<br />colonna</>} onClick={() => s.startDax('column', s.tables.find((t) => t.name === s.dataViewTable)?.name ?? s.tables[0]?.name)} disabled={!s.tables.length} />
            <Big icon="newTable" label={<>Nuova<br />tabella</>} onClick={() => s.startDax('table')} />
            <Big icon="calcGroup" label={<>Gruppo di<br />calcolo</>} onClick={() => void s.createCalcGroup()} disabled={!s.report.measures.length} title={s.report.measures.length ? undefined : 'Serve almeno una misura esplicita'} />
            <Big icon="measure" label={<>Nuova<br />funzione</>} onClick={() => s.startDax('function')} disabled={!s.tables.length} title="Funzione DAX definita dall'utente, riutilizzabile in misure, colonne e altre funzioni" />
          </Group>
          <Group label="Calendari">
            <Big icon="calendar" label={<>Opzioni<br />calendario</>} disabled={!s.tables.length} onClick={() => s.set({ calendarDialog: s.dataViewTable ?? s.tables.find((t) => t.columns.some((c) => /^(DATE|TIMESTAMP)/i.test(c.type)))?.name ?? s.tables[0].name })}
              title="Calendari per la time intelligence basata su calendario (anni fiscali, settimane, 4-4-5…)" />
          </Group>
          <Group label="Traduzioni">
            <Big icon="translate" label="Traduzioni" onClick={() => s.set({ translationsDialog: true })} disabled={!s.tables.length}
              title="Nomi di tabelle, colonne e misure in altre lingue (culture del modello)" />
          </Group>
          <Group label="Sicurezza">
            <Big icon="shield" label={<>Gestisci<br />ruoli</>} onClick={() => s.set({ rolesDialog: true })} disabled={!s.tables.length} />
            <Big icon="user" label={<>Visualizza<br />come</>} onClick={() => s.set({ viewAsDialog: true })} disabled={!s.tables.length} />
          </Group>
          <Group label="Dati"><Big icon="refresh" label="Aggiorna" onClick={() => s.refresh()} disabled={!s.tables.length} /></Group>
        </>}

        {tab === 'view' && <>
          <Group label="Temi">
            <div className="theme-strip">
              {THEMES.slice(0, 4).map((t) => <ThemeSwatch key={t.name} t={t} active={(s.report.theme?.name ?? 'Predefinito') === t.name} onClick={() => s.setTheme(t.name === 'Predefinito' ? undefined : t)} />)}
            </div>
            <Big icon="themes" label="Temi" dropdown onClick={openMenu('themes')} />
          </Group>
          <Group label="Lettura">
            <Big icon="pageView" label={<>Modalità<br />lettura</>} onClick={() => s.set({ readMode: true, view: 'report', selectedVisualId: null })} disabled={!report} />
          </Group>
          <Group label="Lingua">
            <div className="rb-lang">
              <span>Lingua del report</span>
              <select value={s.previewCulture ?? ''} onChange={(e) => s.set({ previewCulture: e.target.value || null })} title="Mostra il report con le traduzioni del modello in questa lingua"
                disabled={!s.report.cultures?.length}>
                <option value="">Nomi del modello</option>
                {(s.report.cultures ?? []).map((c) => <option key={c.name} value={c.name}>{cultureName(c.name)}</option>)}
              </select>
              <button className="link" onClick={() => s.set({ translationsDialog: true })} disabled={!s.tables.length}>Traduzioni…</button>
            </div>
          </Group>
          <Group label="Ridimensiona">
            <Big icon="pageView" label={<>Visualizzazione<br />pagina</>} dropdown onClick={openMenu('pageview')} disabled={!report} />
            <Big icon="mobile" label={<>Layout<br />per dispositivi mobili</>} onClick={() => s.set({ mobileLayout: !s.mobileLayout, view: 'report', selectedVisualId: null })} disabled={!report} />
          </Group>
          <Group label="Opzioni di pagina">
            <div className="rcol">
              <label className="rcheck"><input type="checkbox" checked={s.gridlines} onChange={(e) => s.set({ gridlines: e.target.checked })} />Griglia</label>
              <label className="rcheck"><input type="checkbox" checked={s.snapToGrid} onChange={(e) => s.set({ snapToGrid: e.target.checked })} />Allinea alla griglia</label>
            </div>
          </Group>
          <Group label="Mostra riquadri">
            <div className="rcol">
              {([['filters', 'Filtri'], ['viz', 'Visualizzazioni'], ['data', 'Dati'], ['bookmarks', 'Segnalibri'], ['selection', 'Selezione'], ['sync', 'Sincronizza filtri dei dati']] as const).map(([k, l]) => (
                <label key={k} className="rcheck"><input type="checkbox" checked={!!s.panes[k]} onChange={(e) => s.set({ panes: { ...s.panes, [k]: e.target.checked } })} />{l}</label>
              ))}
            </div>
          </Group>
        </>}

        {tab === 'table' && toolTable && <>
          <Group label="Struttura">
            <div className="rcol" style={{ justifyContent: 'center' }}><span className="hint">Nome</span><b>{toolTable.name}</b></div>
          </Group>
          <Group label="Calendari">
            <Big icon="calendar" label={<>Contrassegna come<br />tabella delle date</>} onClick={() => s.set({ propsTarget: { table: toolTable.name } })} />
            <Big icon="calendar" label={<>Opzioni<br />calendario</>} onClick={() => s.set({ calendarDialog: toolTable.name })} />
          </Group>
          <Group label="Relazioni">
            <Big icon="relationships" label={<>Gestisci<br />relazioni</>} onClick={() => s.set({ relManage: true })} />
          </Group>
          <Group label="Calcoli">
            <Big icon="measure" label={<>Nuova<br />misura</>} onClick={() => s.startDax('measure', toolTable.name)} />
            <Big icon="quickMeasure" label={<>Misura<br />rapida</>} onClick={() => s.set({ quickMeasure: true })} />
            <Big icon="newColumn" label={<>Nuova<br />colonna</>} onClick={() => s.startDax('column', toolTable.name)} />
            <Big icon="newTable" label={<>Nuova<br />tabella</>} onClick={() => s.startDax('table')} />
          </Group>
        </>}

        {tab === 'format' && <>
          <Group label="Interazioni">
            <Big icon="interactions" label={<>Modifica<br />interazioni</>} onClick={() => s.set({ editInteractions: !s.editInteractions, crossFilter: null })}
              title={s.editInteractions ? 'Termina la modifica delle interazioni' : "Scegliere come un oggetto visivo selezionato filtra o evidenzia gli altri oggetti visivi della pagina"} />
          </Group>
          <Group label="Filtri dei dati">
            <Big icon="syncSlicers" label={<>Sincronizza<br />filtri dei dati</>} onClick={() => s.set({ panes: { ...s.panes, sync: !s.panes.sync } })} />
          </Group>
        </>}

        {tab === 'optimize' && <>
          <Group label="Query"><Big icon="pause" label={s.paused ? <>Riprendi<br />oggetti visivi</> : <>Sospendi<br />oggetti visivi</>} onClick={() => s.set({ paused: !s.paused })} /></Group>
          <Group label="Prestazioni"><Big icon="analyzer" label={<>Analizzatore<br />prestazioni</>} onClick={() => s.set({ panes: { ...s.panes, perf: !s.panes.perf }, view: 'report' })} /></Group>
          <Group label="Dati"><Big icon="refresh" label={<>Aggiorna<br />oggetti visivi</>} onClick={() => s.set({ dataVersion: s.dataVersion + 1, pauseTick: s.pauseTick + 1 })} /></Group>
        </>}

        {tab === 'help' && <>
          <Group label="Guida">
            <Big icon="info" label="Informazioni" onClick={() => s.set({ aboutDialog: true })} />
            <Big icon="docs" label="Documentazione" onClick={() => s.notify('Leggere README.md nella cartella del progetto.')} />
            <Big icon="refresh" label={<>Controlla<br />aggiornamenti</>} onClick={() => checkUpdates(false)} title="Cerca una nuova versione di MiB-BI su GitHub" />
          </Group>
        </>}
      </div>

      {menu?.kind === 'getdata' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          <div className="hdr">Origini dati comuni</div>
          <button onClick={() => { close(); s.openNavigator('excel'); }}><Icon name="excel" size={18} />Cartella di lavoro di Excel</button>
          <button onClick={() => { close(); s.openNavigator('csv'); }}><Icon name="docs" size={18} />Testo/CSV</button>
          <button onClick={() => { close(); s.openNavigator('json'); }}><Icon name="docs" size={18} />JSON</button>
          <button onClick={() => { close(); s.openNavigator('parquet'); }}><Icon name="sql" size={18} />Parquet</button>
          <button onClick={() => { close(); s.set({ dbDialog: 'sqlserver' }); }}><Icon name="sql" size={18} />Database SQL Server</button>
          <button onClick={() => { close(); s.set({ dbDialog: 'azuresql' }); }}><Icon name="sql" size={18} />Database SQL di Azure</button>
          <button onClick={() => { close(); s.set({ dbDialog: 'oracle' }); }}><Icon name="sql" size={18} />Database Oracle</button>
          <button onClick={() => { close(); s.set({ dbDialog: true }); }}><Icon name="sql" size={18} />Altri database (MySQL, PostgreSQL, Snowflake, BigQuery, Databricks…)</button>
          <button onClick={() => { close(); s.set({ sourceDialog: 'web' }); }}><Icon name="getData" size={18} />Web</button>
          <button onClick={() => { close(); s.set({ sourceDialog: 'odata' }); }}><Icon name="getData" size={18} />Feed OData</button>
          <button onClick={() => { close(); s.set({ sourceDialog: 'folder' }); }}><Icon name="getData" size={18} />Cartella</button>
          <button onClick={() => { close(); s.set({ sourceDialog: 'sharepoint' }); }}><Icon name="getData" size={18} />Cartella SharePoint</button>
          <button onClick={() => { close(); s.set({ sourceDialog: 'splist' }); }}><Icon name="getData" size={18} />Elenco SharePoint Online</button>
          <button onClick={() => { close(); s.set({ serviceDialog: true }); }}><Icon name="publish" size={18} />Power BI (report e modelli semantici)</button>
          <hr />
          <button onClick={() => { close(); s.loadSample(); }}><Icon name="sample" size={18} />Dati di esempio (Financials)</button>
          <button onClick={() => { close(); s.openNavigator('any'); }}>Altro…</button>
        </Menu>
      )}
      {menu?.kind === 'visuals' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          {VISUALS.map((v) => <button key={v.type} onClick={() => { close(); s.addVisual(v.type); }}><VisualIcon type={v.type} />{v.name}</button>)}
        </Menu>
      )}
      {menu?.kind === 'themes' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          <div className="hdr">Questo report</div>
          <div className="theme-grid">
            {THEMES.map((t) => <ThemeSwatch key={t.name} t={t} label active={(s.report.theme?.name ?? 'Predefinito') === t.name} onClick={() => { close(); s.setTheme(t.name === 'Predefinito' ? undefined : t); }} />)}
            {s.report.theme && !THEMES.some((t) => t.name === s.report.theme!.name) && <ThemeSwatch t={s.report.theme} label active onClick={close} />}
          </div>
          <hr />
          <button onClick={() => { close(); s.set({ themeDialog: true }); }}>Personalizza tema corrente</button>
          <button onClick={() => { close(); s.importTheme(); }}>Sfoglia temi…</button>
          <button onClick={() => { close(); s.exportTheme(); }}>Salva tema corrente</button>
        </Menu>
      )}
      {menu?.kind === 'newpage' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          <button onClick={() => { close(); s.addPage(); }}>Pagina vuota</button>
          <button onClick={() => { close(); s.duplicatePage(s.activePageId); }}>Duplica pagina</button>
        </Menu>
      )}
      {menu?.kind === 'buttons' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          {([['Indietro', 'Back', 'back'], ['Segnalibro', 'Bookmark', 'bookmark'], ['Q&A', 'QnA', 'qna'], ['Drill-through', 'Drillthrough', 'blank'], ['Applica tutti i filtri dei dati', 'ApplyAllSlicers', 'blank'], ['Cancella tutti i filtri dei dati', 'ClearAllSlicers', 'reset'], ['Vuoto', '', 'blank']] as const).map(([label, action, icon]) => (
            <button key={label} onClick={() => {
              close();
              const id = s.addVisual('button');
              const L = (x: string) => ({ expr: { Literal: { Value: x } } });
              const wide = action === 'ApplyAllSlicers' || action === 'ClearAllSlicers' || action === 'Drillthrough';
              s.updateVisual(id, { w: wide ? 200 : 120, h: 40, style: {
                pbiType: 'actionButton',
                objects: { icon: [{ properties: { shapeType: L(`'${icon}'`) } }], text: [{ properties: { show: L(icon === 'blank' || wide ? 'true' : 'false'), text: L(`'${label}'`) } }], outline: [{ properties: { show: L('true') } }] },
                vcObjects: action ? { visualLink: [{ properties: { show: L('true'), type: L(`'${action}'`), ...(action === 'Bookmark' && s.report.bookmarks?.[0] ? { bookmark: L(`'${bname(s.report.bookmarks[0])}'`) } : {}) } }] } : {},
              } });
            }}>{label}</button>
          ))}
          <hr />
          <button onClick={() => { close(); const id = s.addVisual('pageNavigator'); s.updateVisual(id, { w: 500, h: 44 }); }}>Navigatore pagine</button>
          <button onClick={() => { close(); const id = s.addVisual('bookmarkNavigator'); s.updateVisual(id, { w: 500, h: 44 }); }}>Navigatore segnalibri</button>
        </Menu>
      )}
      {menu?.kind === 'sensitivity' && <SensitivityMenu x={menu.x} y={menu.y} onClose={close} />}
      {menu?.kind === 'recent' && <RecentMenu x={menu.x} y={menu.y} onClose={close} />}
      {menu?.kind === 'params' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          <button onClick={() => { close(); s.set({ paramDialog: 'numeric' }); }}>Intervallo numerico</button>
          <button onClick={() => { close(); s.set({ paramDialog: 'fields' }); }}>Campi</button>
        </Menu>
      )}
      {menu?.kind === 'pageview' && (
        <Menu x={menu.x} y={menu.y} onClose={close}>
          <button onClick={() => { close(); s.set({ zoom: 'fit' }); }}>Adatta alla pagina</button>
          <button onClick={() => { close(); s.set({ zoom: 1 }); }}>Dimensioni effettive</button>
        </Menu>
      )}
    </div>
  );
}


/** Default labels (Microsoft Purview default label set) when the organization's labels are not loaded. */
const DEFAULT_LABELS: SensitivityLabel[] = [
  { name: 'Personale', color: '#0078D4' }, { name: 'Pubblico', color: '#107C10' }, { name: 'Generale', color: '#605E5C' },
  { name: 'Riservato', color: '#E66C37' }, { name: 'Altamente riservato', color: '#A4262C' },
];

/** Home › Riservatezza: the report's sensitivity label. */
function SensitivityMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const s = useStore();
  const [org, setOrg] = useState<SensitivityLabel[] | null>(null);
  const cur = s.report.sensitivity;
  const pick = (l?: SensitivityLabel) => { s.mut((r) => { if (l) r.sensitivity = l; else delete r.sensitivity; }); onClose(); };
  const load = async () => {
    try { setOrg(await api.sensitivityLabels()); } catch (e: any) { s.notify(e.message, 10000); }
  };
  const item = (l: SensitivityLabel) => (
    <button key={(l.id ?? '') + l.name} title={l.description} onClick={() => pick(l)}>
      <span style={{ width: 12 }}>{cur?.name === l.name && cur?.id === l.id ? '✓' : ''}</span>
      <span className="sens-dot" style={{ background: l.color ?? '#605E5C' }} />{l.name}
    </button>
  );
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <div className="hdr">Etichetta di riservatezza</div>
      <button onClick={() => pick(undefined)}><span style={{ width: 12 }}>{cur ? '' : '✓'}</span>(Nessuna)</button>
      {(org ?? DEFAULT_LABELS).map(item)}
      <hr />
      {org ? <div className="hdr">Etichette dell'organizzazione (Microsoft Purview)</div>
        : <button onClick={load}>Carica le etichette dell'organizzazione…</button>}
    </Menu>
  );
}

/** Home › Origini recenti: data files loaded before, reopened in the Navigator. */
function RecentMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const s = useStore();
  const [list, setList] = useState<string[] | null>(null);
  useEffect(() => { api.recentSources().then(setList).catch(() => setList([])); }, []);
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <div className="hdr">Origini recenti</div>
      {list && !list.length && <div className="side-empty" style={{ padding: '4px 12px' }}>Nessuna origine recente.</div>}
      {(list ?? []).map((p) => {
        if (p.startsWith('db:')) {
          const c = JSON.parse(p.slice(3));
          const where = c.file ? c.file.split('/').pop() : `${c.host ?? ''}${c.database ? ' / ' + c.database : ''}`;
          return <button key={p} title={where} onClick={() => { onClose(); s.set({ dbDialog: p.slice(3) }); }}><Icon name="sql" size={16} />{where}<span className="menu-sub">{c.variant ?? c.kind}</span></button>;
        }
        return <button key={p} title={p} onClick={() => { onClose(); s.openNavigator('any', p); }}><Icon name="getData" size={16} />{p.split('/').pop()}<span className="menu-sub">{p.replace(/\/[^/]+$/, '')}</span></button>;
      })}
    </Menu>
  );
}
