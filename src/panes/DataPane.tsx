import { useState, type ReactNode } from 'react';
import { isHiddenObject, olsHidden } from '../ols';
import { useStore } from '../store';
import { levelName, type TableMeta } from '../types';
import { isDate, isNumeric } from '../format';
import { Icon } from '../components/icons';
import { Menu } from '../components/Menu';
import { FIELD_MIME } from '../components/VisualContainer';
import { insertDax } from '../components/DaxQueryView';
import { daxShow } from '../dax/separators';

/** A Data pane entry of a table: measure, column or user hierarchy, with its display folder. */
interface Item { kind: 'measure' | 'column' | 'hierarchy'; name: string; folder: string; }
type MenuState = { x: number; y: number; table: string; column?: string; measure?: string; hierarchy?: string; level?: string; item?: string; fn?: string; functions?: boolean };

export function DataPane() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuState | null>(null);
  if (!s.panes.data) return null;

  const report = s.view === 'report';
  const v = report ? s.page().visuals.find((x) => x.id === s.selectedVisualId) : undefined;
  const used = new Set(v ? Object.values(v.fields).flat().map((f) => f.table + '\u0001' + f.column) : []);
  // Power BI "measure tables" hold only measures (no columns, no data): list them too.
  const measureOnly: TableMeta[] = [...new Set(s.report.measures.map((m) => m.table))]
    .filter((n) => !s.tables.some((t) => t.name === n))
    .map((name) => ({ name, rowCount: 0, columns: [], source: { path: '' } }));
  const isOpen = (k: string, def = false) => open[k] ?? (q !== '' || def);
  const toggle = (k: string, def = false) => setOpen({ ...open, [k]: !isOpen(k, def) });
  const folders = s.report.displayFolders ?? {};
  const hierarchies = s.report.hierarchies ?? [];
  const calcGroup = (t: string) => s.report.calcGroups?.find((g) => g.table === t);

  const daxRef = (table: string, column: string, measure: boolean) => (measure ? `[${column}]` : `'${table.replace(/'/g, "''")}'[${column}]`);
  const toggleField = (table: string, column: string, measure = false) => {
    if (s.view === 'dax') { insertDax(daxRef(table, column, measure)); return; }
    if (!report) return;
    const key = table + '\u0001' + column;
    if (v && used.has(key)) {
      for (const [well, list] of Object.entries(v.fields)) {
        const i = list.findIndex((f) => f.table === table && f.column === column);
        if (i >= 0) { s.removeField(v.id, well, i); return; }
      }
    } else s.addField(v && !['textbox', 'image', 'unsupported'].includes(v.type) ? v.id : null, { table, column, measure });
  };
  const target = () => (v && !['textbox', 'image', 'unsupported'].includes(v.type) ? v.id : null);
  const drag = (payload: object) => (e: React.DragEvent) => { e.dataTransfer.setData(FIELD_MIME, JSON.stringify(payload)); e.dataTransfer.effectAllowed = 'copy'; };
  const ctx = (m: Omit<MenuState, 'x' | 'y'>) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, ...m }); };

  const persp = s.report.perspectives?.find((p) => p.name === s.perspective);
  const ols = s.viewAs ? olsHidden() : null; // Visualizza come: objects hidden by object-level security
  const desc = (table: string, field: string) => s.report.descriptions?.[table + '\u0001' + field];
  const columnNode = (t: TableMeta, name: string, depth: number, level?: string, label?: string) => {
    const c = t.columns.find((x) => x.name === name);
    const checked = used.has(t.name + '\u0001' + name);
    return (
      <div key={(level ? 'l:' + level + ':' : 'c:') + name} className="tnode field" draggable={report} style={{ paddingLeft: 4 + depth * 14 }}
        onDragStart={drag({ table: t.name, column: name, ...(level ? { hierarchy: level } : {}) })}
        onClick={() => toggleField(t.name, name)}
        onContextMenu={ctx(level ? { table: t.name, hierarchy: level, level: name } : { table: t.name, column: name })}>
        {report && <input type="checkbox" checked={checked} readOnly />}
        <span className="ty">{t.calcColumns?.some((x) => x.name === name) ? <i className="fx-ico">fx</i> : isNumeric(c) ? <Icon name="sigma" size={13} /> : isDate(c) ? <Icon name="calendar" size={13} /> : null}</span>
        <span className="nm" title={(desc(t.name, name) ? desc(t.name, name) + '\n' : '') + (c ? `${name} (${c.type})` : name)}>{label ?? name}</span>
      </div>
    );
  };

  const itemNode = (t: TableMeta, it: Item, depth: number): ReactNode => {
    if (it.kind === 'measure') {
      const m = s.report.measures.find((x) => x.table === t.name && x.name === it.name)!;
      const checked = used.has(t.name + '\u0001' + m.name);
      return (
        <div key={'m:' + m.name} className="tnode field" draggable={report} style={{ paddingLeft: 4 + depth * 14 }}
          onDragStart={drag({ table: t.name, column: m.name, measure: true })}
          onClick={() => toggleField(t.name, m.name, true)}
          onDoubleClick={() => s.startDax('measure', m.table, m.name)}
          onContextMenu={ctx({ table: t.name, measure: m.name })}>
          {report && <input type="checkbox" checked={checked} readOnly />}
          <span className="ty"><Icon name="calc" size={13} /></span>
          <span className="nm" title={(desc(t.name, m.name) ? desc(t.name, m.name) + '\n' : '') + `${m.name} = ${m.expression}`}>{m.name}</span>
        </div>
      );
    }
    if (it.kind === 'column') return columnNode(t, it.name, depth);
    const h = hierarchies.find((x) => x.table === t.name && x.name === it.name)!;
    const k = `h\u0002${t.name}\u0002${h.name}`;
    const all = h.levels.every((l) => used.has(t.name + '\u0001' + l));
    return (
      <div key={'h:' + h.name}>
        <div className="tnode field" draggable={report} style={{ paddingLeft: 4 + depth * 14 }}
          onDragStart={drag({ table: t.name, column: h.levels[0], levels: h.levels, hierarchy: h.name })}
          onClick={() => { if (report && !all) s.addField(target(), { table: t.name, column: h.levels[0], levels: h.levels, hierarchy: h.name }); }}
          onContextMenu={ctx({ table: t.name, hierarchy: h.name })}>
          <span className="chev" onClick={(e) => { e.stopPropagation(); toggle(k); }}><Icon name={isOpen(k) ? 'chevronDown' : 'chevronRight'} size={12} /></span>
          {report && <input type="checkbox" checked={all} readOnly />}
          <span className="ty"><Icon name="hierarchy" size={13} /></span>
          <span className="nm" title={(desc(t.name, h.name) ? desc(t.name, h.name) + '\n' : '') + `${h.name}: ${h.levels.join(' › ')}`}>{h.name}</span>
        </div>
        {isOpen(k) && h.levels.map((l) => columnNode(t, l, depth + 1, h.name, levelName(h, l)))}
      </div>
    );
  };

  /** Items of one folder level: subfolders first, then measures, columns, hierarchies. */
  const folderTree = (t: TableMeta, items: Item[], depth: number, path: string): ReactNode[] => {
    const here = items.filter((i) => i.folder === path);
    const below = new Map<string, Item[]>();
    for (const i of items) {
      if (path && !i.folder.startsWith(path + '\\')) continue;
      if (i.folder === path) continue;
      const rest = path ? i.folder.slice(path.length + 1) : i.folder;
      const head = rest.split('\\')[0];
      below.set(head, [...(below.get(head) ?? []), i]);
    }
    const out: ReactNode[] = [];
    for (const [name, list] of [...below].sort((a, b) => a[0].localeCompare(b[0]))) {
      const full = path ? `${path}\\${name}` : name;
      const k = `f\u0002${t.name}\u0002${full}`;
      out.push(
        <div key={'f:' + full}>
          <div className="tnode field folder" style={{ paddingLeft: 4 + depth * 14 }} onClick={() => toggle(k)}>
            <span className="chev"><Icon name={isOpen(k) ? 'chevronDown' : 'chevronRight'} size={12} /></span>
            <span className="ty"><Icon name="folder" size={13} /></span>
            <span className="nm">{name}</span>
          </div>
          {isOpen(k) && folderTree(t, list, depth + 1, full)}
        </div>,
      );
    }
    for (const kind of ['measure', 'column', 'hierarchy'] as const) for (const i of here.filter((x) => x.kind === kind)) out.push(itemNode(t, i, depth));
    return out;
  };

  return (
    <div className="pane">
      <div className="pane-head">
        <h3>Dati</h3>
        <div className="tools"><button title="Comprimi" onClick={() => s.set({ panes: { ...s.panes, data: false } })}><Icon name="collapseRight" /></button></div>
      </div>
      <div className="pane-search"><Icon name="search" size={14} /><input type="search" placeholder="Cerca" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!!s.report.perspectives?.length && (
        <label className="data-persp">Prospettiva
          <select value={s.perspective ?? ''} onChange={(e) => s.set({ perspective: e.target.value || null })}>
            <option value="">(Intero modello)</option>
            {s.report.perspectives.map((p) => <option key={p.name}>{p.name}</option>)}
          </select>
        </label>
      )}
      <div className="pane-body tree">
        {!s.tables.length && <div style={{ color: 'var(--text2)', padding: '6px 4px' }}>Nessun dato caricato. Usare <b>Ottieni dati</b> nella barra multifunzione.</div>}
        {/* Aggregation tables are hidden in the report view, like Power BI. */}
        {[...s.tables.filter((t) => (!report || !s.report.aggregations?.some((a) => a.table === t.name)) && !isHiddenObject(ols, t.name)), ...measureOnly].map((t) => {
          const match = (n: string) => !isHiddenObject(ols, t.name, n) && (!persp || persp.fields.includes(t.name + '\u0001' + n)) && (!q || n.toLowerCase().includes(q.toLowerCase()) || t.name.toLowerCase().includes(q.toLowerCase()));
          const folderOf = (n: string) => folders[t.name + '\u0001' + n] ?? '';
          const g = calcGroup(t.name);
          const items: Item[] = [
            ...s.report.measures.filter((m) => m.table === t.name && match(m.name)).map((m): Item => ({ kind: 'measure', name: m.name, folder: folderOf(m.name) })),
            // The Ordinal column of a calculation group is hidden, like in Power BI.
            ...t.columns.filter((c) => match(c.name) && !(g && c.name === 'Ordinal')).map((c): Item => ({ kind: 'column', name: c.name, folder: folderOf(c.name) })),
            ...hierarchies.filter((h) => h.table === t.name && (match(h.name) || h.levels.some(match))).map((h): Item => ({ kind: 'hierarchy', name: h.name, folder: folderOf(h.name) })),
          ];
          const calcItems = g ? g.items.filter((i) => match(i.name)) : [];
          if ((q || persp) && !items.length && !calcItems.length) return null;
          const tk = 't\u0002' + t.name;
          const dateCol = s.report.dateTables?.[t.name];
          return (
            <div key={t.name}>
              <div className={'tnode table' + (!report && s.dataViewTable === t.name ? ' active' : '')}
                onClick={() => (report ? toggle(tk, s.tables.length === 1) : s.set({ dataViewTable: t.name }))}
                onContextMenu={ctx({ table: t.name })}>
                <span onClick={(e) => { e.stopPropagation(); toggle(tk, s.tables.length === 1); }}><Icon name={isOpen(tk, s.tables.length === 1) ? 'chevronDown' : 'chevronRight'} size={12} /></span>
                {g ? <Icon name="calcGroup" /> : t.source.dax ? <i className="fx-ico" title="Tabella calcolata">fx</i> : dateCol ? <Icon name="calendar" /> : <Icon name="tableSmall" />}
                <span className="nm" title={g ? `Gruppo di calcolo (precedenza ${g.precedence})` : t.source.dax ? `${t.name} = ${t.source.dax}` : (s.report.descriptions?.[t.name] ? s.report.descriptions[t.name] + '\n' : '') + (dateCol ? `${t.name} — tabella delle date (${dateCol})` : t.name)}>{t.name}</span>
                <button className="more" onClick={ctx({ table: t.name })}><Icon name="more" size={14} /></button>
              </div>
              {isOpen(tk, s.tables.length === 1) && (
                <div className="cols">
                  {folderTree(t, items, 0, '')}
                  {!report && (s.report.calendars ?? []).filter((c) => c.table === t.name && match(c.name)).map((c) => (
                    <div key={'cal:' + c.name} className="tnode field" onClick={() => (s.view === 'dax' ? insertDax(`'${c.name.replace(/'/g, "''")}'`) : s.set({ calendarDialog: t.name }))}
                      onDoubleClick={() => s.set({ calendarDialog: t.name })} onContextMenu={ctx({ table: t.name })}>
                      <span className="ty"><Icon name="calendar" size={13} /></span>
                      <span className="nm" title={`Calendario ${c.name}: ${c.groups.filter((x) => x.primary).map((x) => x.primary).join(', ')}`}><i>{c.name}</i></span>
                    </div>
                  ))}
                  {g && (
                    <div>
                      <div className="tnode field folder" onClick={() => toggle('ci\u0002' + t.name, true)}>
                        <span className="chev"><Icon name={isOpen('ci\u0002' + t.name, true) ? 'chevronDown' : 'chevronRight'} size={12} /></span>
                        <span className="nm"><i>Elementi di calcolo</i></span>
                      </div>
                      {isOpen('ci\u0002' + t.name, true) && calcItems.map((it) => (
                        <div key={'ci:' + it.name} className="tnode field" style={{ paddingLeft: 18 }}
                          onClick={() => s.startDax('calcItem', t.name, it.name)}
                          onContextMenu={ctx({ table: t.name, item: it.name })}>
                          <span className="ty"><i className="fx-ico">fx</i></span>
                          <span className="nm" title={`${it.name} = ${it.expression}`}>{it.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!report && s.tables.length > 0 && (!q || (s.report.functions ?? []).some((f) => f.name.toLowerCase().includes(q.toLowerCase()))) && (
          <div>
            <div className="tnode table" onClick={() => toggle('fns', true)} onContextMenu={ctx({ table: '', functions: true })}>
              <span><Icon name={isOpen('fns', true) ? 'chevronDown' : 'chevronRight'} size={12} /></span>
              <i className="fx-ico" title="Funzioni DAX definite dall'utente">ƒ</i>
              <span className="nm">Funzioni</span>
              <button className="more" onClick={ctx({ table: '', functions: true })}><Icon name="more" size={14} /></button>
            </div>
            {isOpen('fns', true) && (
              <div className="cols">
                {(s.report.functions ?? []).filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase())).map((f) => (
                  <div key={'fn:' + f.name} className="tnode field" style={{ paddingLeft: 4 }}
                    onClick={() => (s.view === 'dax' ? insertDax(`${f.name}(`) : s.startDax('function', undefined, f.name))}
                    onDoubleClick={() => s.startDax('function', undefined, f.name)}
                    onContextMenu={ctx({ table: '', fn: f.name })}>
                    <span className="ty"><i className="fx-ico">ƒ</i></span>
                    <span className="nm" title={`${f.description ? f.description + '\n' : ''}${f.name} = ${f.expression}`}>{f.name}</span>
                  </div>
                ))}
                {!s.report.functions?.length && <div className="tnode field" style={{ paddingLeft: 18, color: 'var(--text2)' }} onClick={() => s.startDax('function')}><i>Nuova funzione…</i></div>}
              </div>
            )}
          </div>
        )}
      </div>
      {menu && <DataMenu menu={menu} close={() => setMenu(null)} report={report} toggleOpen={(k) => { toggle(k); }} isOpen={isOpen} />}
    </div>
  );
}

function DataMenu({ menu, close, report, toggleOpen, isOpen }: { menu: MenuState; close: () => void; report: boolean; toggleOpen: (k: string) => void; isOpen: (k: string, def?: boolean) => boolean }) {
  const s = useStore();
  const t = s.tables.find((x) => x.name === menu.table);
  const g = s.report.calcGroups?.find((x) => x.table === menu.table);
  const hs = (s.report.hierarchies ?? []).filter((h) => h.table === menu.table);
  const run = (fn: () => void) => () => { fn(); close(); };
  const props = (p: Omit<NonNullable<typeof s.propsTarget>, 'table'>) => run(() => s.set({ propsTarget: { table: menu.table, ...p } }));
  let body: ReactNode;
  const fnQuery = (fn: string, define: boolean) => {
    const f = s.report.functions?.find((x) => x.name === fn);
    if (!f) return;
    const args = /^\s*\(([^)]*)\)/.exec(f.expression)?.[1].split(',').map((p) => p.trim()).filter((p) => p && !p.includes('=')).map((p) => /^\w+/.exec(p)?.[0] ?? p) ?? [];
    const head = define ? `DEFINE\n${f.description ? f.description.split('\n').map((l) => `    /// ${l}\n`).join('') : ''}    FUNCTION ${f.name} = ${f.expression}\n\n` : '';
    useStore.setState({ daxQueryText: daxShow(`${head}EVALUATE\n    { ${f.name}(${args.join(', ')}) }`) });
  };
  if (menu.functions) {
    body = <>
      <button onClick={run(() => s.startDax('function'))}><Icon name="calc" />Nuova funzione</button>
      {s.view === 'dax' && <button disabled={!s.report.functions?.length} onClick={run(() => useStore.setState({ daxQueryText: daxShow(`DEFINE\n${(s.report.functions ?? []).map((f) => `    FUNCTION ${f.name} = ${f.expression}`).join('\n\n')}\n\nEVALUATE\n    { 1 }`) }))}>Query rapide › Definisci tutte le funzioni del modello</button>}
    </>;
  } else if (menu.fn) {
    body = <>
      <button onClick={run(() => s.startDax('function', undefined, menu.fn))}><Icon name="calc" />Modifica funzione</button>
      {s.view === 'dax' && <>
        <button onClick={run(() => fnQuery(menu.fn!, false))}>Query rapide › Valuta</button>
        <button onClick={run(() => fnQuery(menu.fn!, true))}>Query rapide › Definisci e valuta</button>
      </>}
      <hr />
      <button onClick={run(() => s.deleteFunction(menu.fn!))}><Icon name="trash" />Elimina dal modello</button>
    </>;
  } else if (menu.item) {
    const i = g?.items.findIndex((x) => x.name === menu.item) ?? -1;
    body = <>
      <button onClick={run(() => s.startDax('calcItem', menu.table, menu.item))}><Icon name="calc" />Modifica elemento di calcolo</button>
      <button disabled={i <= 0} onClick={run(() => s.moveCalcItem(menu.table, menu.item!, -1))}>Sposta su</button>
      <button disabled={!g || i >= g.items.length - 1} onClick={run(() => s.moveCalcItem(menu.table, menu.item!, 1))}>Sposta giù</button>
      <hr />
      <button disabled={(g?.items.length ?? 0) <= 1} onClick={run(() => s.removeCalcItem(menu.table, menu.item!))}><Icon name="trash" />Elimina</button>
    </>;
  } else if (menu.level) {
    const h = hs.find((x) => x.name === menu.hierarchy);
    body = <>
      <button onClick={run(() => h && s.updateHierarchy(menu.table, h.name, { levels: h.levels.filter((l) => l !== menu.level) }))}><Icon name="trash" />Rimuovi dalla gerarchia</button>
      <button onClick={props({ hierarchy: menu.hierarchy })}>Proprietà gerarchia</button>
    </>;
  } else if (menu.hierarchy) {
    body = <>
      <button onClick={props({ hierarchy: menu.hierarchy })}><Icon name="gear" />Proprietà</button>
      <button onClick={run(() => s.removeHierarchy(menu.table, menu.hierarchy!))}><Icon name="trash" />Elimina gerarchia</button>
    </>;
  } else if (menu.measure) {
    body = <>
      <button onClick={run(() => s.startDax('measure', menu.table, menu.measure))}><Icon name="calc" />Modifica misura</button>
      <button onClick={props({ field: menu.measure })}><Icon name="gear" />Proprietà</button>
      <button onClick={run(() => s.deleteMeasure(menu.measure!))}><Icon name="trash" />Elimina misura</button>
    </>;
  } else if (menu.column) {
    body = <>
      {s.report.groupings?.some((g) => g.table === menu.table && g.name === menu.column)
        ? <button onClick={run(() => s.set({ groupDialog: { table: menu.table, column: menu.column!, name: menu.column } }))}><Icon name="tableSmall" />Modifica gruppi</button>
        : <button disabled={!t} onClick={run(() => s.set({ groupDialog: { table: menu.table, column: menu.column! } }))}><Icon name="tableSmall" />Nuovo gruppo</button>}
      {t?.calcColumns?.some((c) => c.name === menu.column) && <>
        <button onClick={run(() => s.startDax('column', menu.table, menu.column))}><Icon name="calc" />Modifica colonna calcolata</button>
        <button onClick={run(() => void s.deleteCalcColumn(menu.table, menu.column!))}><Icon name="trash" />Elimina colonna</button>
        <hr />
      </>}
      <button onClick={run(() => s.createHierarchy(menu.table, menu.column!))}><Icon name="hierarchy" />Crea gerarchia</button>
      {hs.filter((h) => !h.levels.includes(menu.column!)).map((h) => (
        <button key={h.name} onClick={run(() => s.addHierarchyLevel(menu.table, h.name, menu.column!))}>Aggiungi alla gerarchia › {h.name}</button>
      ))}
      <button onClick={props({ field: menu.column })}><Icon name="gear" />Proprietà</button>
      <hr />
      <button disabled={!report} onClick={run(() => s.addFilter('page', { table: menu.table, column: menu.column! }))}>Aggiungi a filtri › Livello di pagina</button>
      <button disabled={!report} onClick={run(() => s.addFilter('report', { table: menu.table, column: menu.column! }))}>Aggiungi a filtri › Livello di report</button>
      <button disabled={!report} onClick={run(() => { const id = s.addVisual('slicer'); s.addField(id, { table: menu.table, column: menu.column! }); })}>Crea filtro dei dati</button>
    </>;
  } else {
    const tk = 't\u0002' + menu.table;
    body = <>
      <button onClick={run(() => s.startDax('measure', menu.table))}><Icon name="calc" />Nuova misura</button>
      {g ? <button onClick={run(() => s.addCalcItem(menu.table))}><Icon name="calc" />Nuovo elemento di calcolo</button>
        : <button disabled={!t} onClick={run(() => s.startDax('column', menu.table))}><Icon name="calc" />Nuova colonna</button>}
      {t?.source.dax && <button onClick={run(() => s.startDax('table', menu.table, menu.table))}><Icon name="calc" />Modifica tabella calcolata</button>}
      <hr />
      {t && !g && <button onClick={props({})}><Icon name="calendar" />{s.report.dateTables?.[menu.table] ? 'Tabella delle date…' : 'Contrassegna come tabella delle date'}</button>}
      {t && !g && <button onClick={run(() => s.set({ calendarDialog: menu.table }))}><Icon name="calendar" />Opzioni calendario</button>}
      <button disabled={!t} onClick={props({})}><Icon name="gear" />Proprietà</button>
      <button disabled={!t || s.tables.length < 2} onClick={run(() => s.set({ aggDialog: menu.table }))}><Icon name="sigma" />Gestisci aggregazioni</button>
      <button disabled={!t || !!t.source.dax || t.storageMode === 'directQuery'} onClick={run(() => s.set({ incrementalDialog: menu.table }))}><Icon name="refresh" />Aggiornamento incrementale</button>
      <button onClick={run(() => s.set({ view: 'data', dataViewTable: menu.table }))}>Visualizza in vista tabella</button>
      <button onClick={run(() => toggleOpen(tk))}>{isOpen(tk) ? 'Comprimi' : 'Espandi'}</button>
      <button disabled={!t || !!t.source.dax || !!g} onClick={run(() => s.openPowerQuery(menu.table))}><Icon name="transform" size={16} box={32} />Modifica query</button>
      <button onClick={run(() => void s.refresh())}>Aggiorna dati</button>
      <hr />
      <button onClick={run(() => void s.removeTable(menu.table))}><Icon name="trash" />Elimina dal modello</button>
    </>;
  }
  return <Menu x={menu.x} y={menu.y} onClose={close}>{body}</Menu>;
}
