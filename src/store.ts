import { create } from 'zustand';
import { globalOptions } from './options';
import { api, type UpdateInfo } from './api';
import type { Bookmark, CrossFilter, DbConnection, FieldRef, Filter, Interaction, NewStep, Page, PQParam, PQType, Relationship, Report, Step, Theme, TableMeta, View, Visual, VisualFormat, VisualType } from './types';
import { interactionKey } from './visuals/interactions';
import { propagateSync } from './visuals/sync';
import { refLabel, isNumeric, setCaptions, uid } from './format';
import { customName, setCustomVisuals, visualDef } from './visuals/catalog';
import { CF_WELL, connected, modelExtras, NULL_KEY, qi, ql } from './query';
import { daxShow, daxStore } from './dax/separators';
import { calcColumnSql, calcTableSql, checkCalcItem, checkFunction, checkMeasure, parse, parseQuery, rlsWhere, type Model } from './dax';
import { inlineParamsInM, paramFromM, resolveSource, setParams } from './pq/params';
import { inlineFromM } from './pq/mparse';
import { parseLayout, setCfExportRanges, setHierarchyLevels, themeFromLayout } from './pbix/layout';
import { runVisualQuery } from './visuals/useVisualData';
import { cfInput, fieldKey, rangeOf } from './visuals/condfmt';
import { sp } from './visuals/pbistyle';
import { pbirToLayout } from './pbix/pbir';
import { buildPbipParts, buildPbitParts, buildPbixParts, queryM } from './pbix/pbit';
import { pendingQueries } from './visuals/useVisualData';
import { applyTheme, parseTheme, themeJson, THEMES } from './themes';
import { compileQuery, type CompileOptions } from './pq/compile';
import { evaluateM, mTempTable, clearMTemp, type MQuerySource } from './pq/m/host';
import { dependencies, renameQueryRef, type QueryDef } from './pq/steps';

export const PAGE_W = 1280;
export const PAGE_H = 720;
/** Page size: Power BI pages keep their own (4:3, tooltip, custom). */
export const pageSize = (p: Page) => ({ w: p.width ?? PAGE_W, h: p.height ?? PAGE_H });

/** A visual is drawn unless it, or one of its groups, is hidden. */
export function isHiddenVisual(p: Page, v: Visual): boolean {
  if (v.hidden) return true;
  const seen = new Set<string>();
  for (let g = p.groups?.find((x) => x.id === v.group); g && !seen.has(g.id); g = p.groups?.find((x) => x.id === g!.parent)) {
    if (g.hidden) return true;
    seen.add(g.id);
  }
  return false;
}

export interface PerfEntry { id: number; visualId: string; at: number; queryMs: number; renderMs: number; rows: number; sql: string; error?: string }
let perfSeq = 0;
/** Analizzatore prestazioni: adds an entry while recording (called by useVisualData). */
export function recordPerf(e: Omit<PerfEntry, 'id'>) {
  const st = useStore.getState();
  if (!st.perf.recording) return;
  useStore.setState({ perf: { ...st.perf, entries: [...st.perf.entries, { ...e, id: ++perfSeq }].slice(-500) } });
}

export const defaultFormat = (type: VisualType): VisualFormat => ({
  titleShow: !['textbox', 'card', 'table', 'matrix', 'button', 'shape', 'image', 'multiRowCard', 'pageNavigator', 'bookmarkNavigator'].includes(type),
  titleText: '',
  titleSize: 14,
  legendShow: true,
  legendPos: 'top',
  dataLabels: type === 'pie' || type === 'donut' || type === 'treemap' || type === 'funnel',
  xAxisShow: true,
  yAxisShow: true,
  gridlines: true,
  color: '#118DFF',
  background: ['button', 'shape', 'image', 'pageNavigator', 'bookmarkNavigator'].includes(type) ? 'transparent' : '#FFFFFF',
  slicerStyle: 'list',
});

const newPage = (n: number): Page => ({ id: uid(), name: `Pagina ${n}`, visuals: [], filters: [] });
const emptyReport = (): Report => ({ pages: [newPage(1)], reportFilters: [], relationships: [], modelLayout: {}, measures: [] });

/** Field dragged/checked from the Data pane; `measure` marks a DAX measure. */
export type FieldDrop = Omit<FieldRef, 'agg'> & { measure?: boolean; /** user hierarchy: its level columns, in order */ levels?: string[]; plain?: boolean };

export interface RelEditor { draft: Relationship; isNew: boolean; }

/** True when every non-null value of table.column is distinct (candidate "one" side). */
export async function isUnique(table: string, column: string): Promise<boolean> {
  const r = await api.query(`SELECT COUNT(DISTINCT ${qi(column)}) = COUNT(*) AS u FROM ${qi(table)}`);
  return r.rows[0]?.u === true;
}

export type FilterScope = 'visual' | 'page' | 'report';

/** Query being edited in the Power Query editor; `orig` is the model table it came from (null = new). */
/** `load` false = connection-only query (Abilita caricamento off: functions, helper queries), kept in Report.pqQueries. */
export interface PQQuery { name: string; orig: string | null; source: TableMeta['source']; steps: Step[]; load?: boolean; }
/** `step` = number of applied steps shown (null = all, 0 = Origine). */
/** `groups`: query name → group path (Gruppi di query). */
export interface PQState { queries: PQQuery[]; selected: string; step: number | null; deleted: string[]; groups?: Record<string, string>; }

const srcExpr = (source: TableMeta['source']) => api.sourceExpr(resolveSource(source));

/** What the M interpreter can reach: M queries (loaded or connection-only), the SQL of the other queries, parameters. */
export function mSourceOf(defs: QueryDef[], extra: { name: string; code: string }[], params: PQParam[]): MQuerySource {
  const code = new Map<string, string>(extra.map((q) => [q.name, q.code]));
  const sql = new Map<string, () => Promise<string>>();
  const tables = new Set<string>();
  for (const d of defs) {
    if (d.source.mcode !== undefined) code.set(d.name, d.source.mcode);
    else if (d.source.dax) tables.add(d.name);
    else sql.set(d.name, () => compileQuery(d, defs, compileOpts(defs, extra, params)));
  }
  const src: MQuerySource = { code, sql, tables, params };
  return src;
}
/** Compile options: SQL queries that reference M queries read them from a DuckDB table filled by the interpreter. */
export function compileOpts(defs: QueryDef[], extra: { name: string; code: string }[], params: PQParam[]): CompileOptions {
  return { srcExpr, mTable: (_name, code) => mTempTable(code, mSourceOf(defs, extra, params)) };
}

/** Steps Power BI folds into the previous step of the same kind instead of adding a new one. */
/** The page holds an "Applica tutti i filtri dei dati" button: slicer changes wait for it. */
export function hasApplyAll(p: Page): boolean {
  return p.visuals.some((v) => v.type === 'button' && !isHiddenVisual(p, v) && sp(v, 'visualLink', 'type') === 'ApplyAllSlicers' && sp(v, 'visualLink', 'show') !== false);
}

function mergeStep(prev: Step, next: Step): boolean {
  if (prev.kind === 'renameColumns' && next.kind === 'renameColumns') {
    for (const [a, b] of next.renames) {
      const hit = prev.renames.find((r) => r[1] === a);
      if (hit) hit[1] = b; else prev.renames.push([a, b]);
    }
    prev.renames = prev.renames.filter(([a, b]) => a !== b);
    return true;
  }
  if (prev.kind === 'changeType' && next.kind === 'changeType') {
    for (const [c, t] of next.columns) {
      const hit = prev.columns.find((x) => x[0] === c);
      if (hit) hit[1] = t; else prev.columns.push([c, t]);
    }
    return true;
  }
  if (prev.kind === 'sort' && next.kind === 'sort') {
    for (const [c, d] of next.by) {
      const hit = prev.by.find((x) => x[0] === c);
      if (hit) hit[1] = d; else prev.by.push([c, d]);
    }
    return true;
  }
  return false;
}

const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Model translations follow a renamed object: `match(key)` → new key or null (keys "Table" / "Table\u0001Field"). */
function renameInCultures(r: Report, match: (key: string) => string | null) {
  for (const c of r.cultures ?? []) {
    for (const map of [c.captions, c.descriptions, c.folders]) {
      if (!map) continue;
      for (const k of Object.keys(map)) { const to = match(k); if (to !== null && to !== k) { map[to] = map[k]; delete map[k]; } }
    }
  }
}
const renameFieldInCultures = (r: Report, table: string, from: string, to: string) =>
  renameInCultures(r, (k) => (k === `${table}\u0001${from}` ? `${table}\u0001${to}` : null));

/** Renames a table everywhere the report refers to it (fields, filters, relationships, measures). */
function renameTableInReport(r: Report, from: string, to: string) {
  const walk = (o: any) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const k of ['table', 'fromTable', 'toTable']) if (o[k] === from) o[k] = to;
    Object.values(o).forEach(walk);
  };
  walk(r.pages); walk(r.reportFilters); walk(r.relationships); walk(r.measures); walk(r.hierarchies); walk(r.calcGroups); walk(r.roles); walk(r.calendars);
  if (r.modelLayout[from]) { r.modelLayout[to] = r.modelLayout[from]; delete r.modelLayout[from]; }
  renameInCultures(r, (k) => (k === from ? to : k.startsWith(from + '\u0001') ? to + k.slice(from.length) : null));
  if (r.dateTables?.[from]) { r.dateTables[to] = r.dateTables[from]; delete r.dateTables[from]; }
  for (const k of Object.keys(r.displayFolders ?? {})) {
    if (k.startsWith(from + '\u0001')) { r.displayFolders![to + k.slice(from.length)] = r.displayFolders![k]; delete r.displayFolders![k]; }
  }
  const quoted = (n: string) => `'${n.replace(/'/g, "''")}'`;
  const bare = /^[A-Za-z_]\w*$/.test(from) ? new RegExp(`(^|[^\\w'\\]])${reEscape(from)}\\[`, 'g') : null;
  const target = /^[A-Za-z_]\w*$/.test(to) ? to : quoted(to);
  for (const m of [...r.measures, ...(r.functions ?? [])]) {
    m.expression = m.expression.split(quoted(from) + '[').join(target + '[');
    if (bare) m.expression = m.expression.replace(bare, (_x, pre) => `${pre}${target}[`);
  }
}

/** Renames 'Table'[old] / Table[old] in every DAX expression of the report (measures, calculation items, role filters). */
function renameColumnInDax(r: Report, table: string, from: string, to: string) {
  const quoted = `'${table.replace(/'/g, "''")}'`;
  const col = (n: string) => `[${n.replace(/]/g, ']]')}]`;
  const bare = /^[A-Za-z_]\w*$/.test(table) ? new RegExp(`(^|[^\\w'\\]])${reEscape(table)}${reEscape(col(from))}`, 'gi') : null;
  const fix = (e: string) => {
    let x = e.split(quoted + col(from)).join(quoted + col(to));
    if (bare) x = x.replace(bare, (_m, pre) => `${pre}${table}${col(to)}`);
    return x;
  };
  for (const m of [...r.measures, ...(r.functions ?? [])]) m.expression = fix(m.expression);
  renameFieldInCultures(r, table, from, to);
  for (const c of r.calendars ?? []) if (c.table === table) for (const g of c.groups) {
    if (g.primary === from) g.primary = to;
    g.associated = g.associated?.map((x) => (x === from ? to : x));
  }
  for (const g of r.calcGroups ?? []) for (const i of g.items) { i.expression = fix(i.expression); if (i.formatString) i.formatString = fix(i.formatString); }
  for (const role of r.roles ?? []) for (const f of role.filters) f.expression = fix(f.expression);
}

/** Formula bar edit of a measure, calculated column or calculated table. */
export interface DaxEdit { kind: 'measure' | 'column' | 'table' | 'calcItem' | 'function'; table: string; original: string | null; text: string; formatString?: string; error?: string; }

const DAX_KIND = { measure: 'Misura', column: 'Colonna', table: 'Tabella', calcItem: 'Elemento di calcolo', function: 'Funzione' } as const;

/** "Name = expression" → parts; names may be written as [Name] or 'Name'. */
function splitDax(text: string): { name: string; expr: string } | null {
  const m = /^\s*([^=]+?)\s*=([\s\S]*)$/.exec(text);
  if (!m) return null;
  const name = m[1].trim().replace(/^\[(.*)\]$/, '$1').replace(/^'(.*)'$/, '$1').trim();
  return name ? { name, expr: m[2].trim() } : null;
}

export interface Navigator { path: string; tableName: string; preview: { columns: string[]; rows: any[] } | null; error?: string; loading: boolean; }

interface State {
  tables: TableMeta[];
  report: Report;
  activePageId: string;
  view: View;
  selectedVisualId: string | null;
  crossFilter: CrossFilter | null;
  panes: { filters: boolean; viz: boolean; data: boolean; selection: boolean; bookmarks: boolean; perf?: boolean; sync?: boolean };
  /** Analizzatore prestazioni: recording on, and one entry per visual query (ms). */
  perf: { recording: boolean; entries: PerfEntry[] };
  /** Visuals selected together (Ctrl+click), e.g. to group them. */
  multiSel: string[];
  vizTab: 'build' | 'format' | 'analytics';
  dataVersion: number;
  filePath: string | null;
  dirty: boolean;
  past: Report[];
  future: Report[];
  navigator: Navigator | null;
  zoom: number | 'fit';
  toast: string | null;
  dataViewTable: string | null;
  fileMenu: boolean;
  gridlines: boolean;
  /** Modalità lettura: no editing, buttons and navigators work with a plain click (like the Power BI service). */
  readMode: boolean;
  /** Copia formato: formatting picked from a visual, applied to the next visual clicked. */
  formatPainter: { from: string; type: VisualType; format: VisualFormat; style?: Visual['style'] } | null;
  applyFormatPainter: (targetId: string) => void;
  /** Ottimizza › Sospendi oggetti visivi: visual queries do not run until Aggiorna (pauseTick) or resume. */
  paused: boolean;
  pauseTick: number;
  /** Visualizza › Layout per dispositivi mobili (editing the phone layout of the page). */
  mobileLayout: boolean;
  /** Home › Immetti dati: dialog open, and creation of the table (typed like Power BI's automatic type detection). */
  enterData: boolean;
  createInlineTable: (name: string, columns: string[], rows: (string | null)[][]) => Promise<void>;
  /** Home › Misura rapida dialog. */
  quickMeasure: boolean;
  snapToGrid: boolean;
  busy: string | null;
  /** Python/R visuals run only after the user enables them in this session (like Power BI Desktop). */
  scriptsEnabled: boolean;
  /** Visual whose script is open in the script editor. */
  scriptEditor: string | null;
  /** Ottieni dati › Web / Feed OData / Cartella dialog. */
  sourceDialog: 'web' | 'odata' | 'folder' | 'sharepoint' | 'splist' | null;
  /** Nuovo parametro dialog. */
  paramDialog: 'numeric' | 'fields' | null;
  clipboard: Visual | null;
  focusId: string | null;
  /** Focus view as "Mostra come tabella": the visual with its data below. */
  focusTable: boolean;
  /** Guida › Informazioni. */
  aboutDialog: boolean;
  /** Esporta dati dialog for this visual. */
  exportData: string | null;
  /** Formato › Modifica interazioni: the selected visual's interactions are shown (and set) on the other visuals. */
  editInteractions: boolean;
  setInteraction: (source: string, target: string, mode: Interaction | null) => void;
  /** Sincronizza filtri dei dati: on page `pageId`, the synced copy of slicer `id` exists (sync) and is shown (visible). */
  syncSlicer: (id: string, pageId: string, state: { sync: boolean; visible: boolean }) => void;
  setSyncGroup: (id: string, patch: Partial<NonNullable<Visual['syncGroup']>>) => void;
  relManage: boolean;
  relEditor: RelEditor | null;
  selectedRelId: string | null;
  pq: PQState | null;
  daxEdit: DaxEdit | null;
  daxQueryText: string;

  model: () => Model;
  /** Visualizza come: roles (union of their rows) and USERPRINCIPALNAME() of "Altro utente". */
  viewAs: { roles: string[]; user?: string } | null;
  setViewAs: (v: { roles: string[]; user?: string } | null) => Promise<void>;
  rolesDialog: boolean;
  viewAsDialog: boolean;
  saveRoles: (roles: import('./types').RoleDef[]) => Promise<void>;
  /** Proprietà (Data pane / model view): field, hierarchy or table being edited. */
  propsTarget: { table: string; field?: string; hierarchy?: string } | null;
  setDisplayFolder: (table: string, field: string, folder: string) => void;
  createHierarchy: (table: string, column: string) => void;
  addHierarchyLevel: (table: string, hierarchy: string, column: string) => void;
  updateHierarchy: (table: string, name: string, patch: Partial<import('./types').Hierarchy>) => void;
  removeHierarchy: (table: string, name: string) => void;
  /** Contrassegna come tabella delle date (column null = unmark); returns an error message or null. */
  setDateTable: (table: string, column: string | null) => Promise<string | null>;
  createCalcGroup: () => Promise<void>;
  addCalcItem: (table: string) => void;
  removeCalcItem: (table: string, item: string) => void;
  moveCalcItem: (table: string, item: string, dir: 1 | -1) => void;
  setCalcGroup: (table: string, patch: Partial<import('./types').CalcGroup>) => void;
  /** Materializes calculation group tables whose items changed (after edits, undo, open). */
  syncCalcTables: () => Promise<void>;
  startDax: (kind: DaxEdit['kind'], table?: string, original?: string) => void;
  saveDax: () => Promise<boolean>;
  deleteMeasure: (name: string) => void;
  deleteFunction: (name: string) => void;
  /** Vista query DAX › Aggiorna il modello: saves the DEFINE MEASURE / DEFINE FUNCTION of a query. Returns an error or a summary. */
  updateModelFromQuery: (text: string) => { error?: string; done?: string };
  /** Opzioni calendario: the table whose calendars the dialog edits. */
  calendarDialog: string | null;
  setCalendars: (table: string, calendars: import('./types').CalendarDef[]) => void;
  deleteCalcColumn: (table: string, name: string) => Promise<void>;
  finalizeModel: () => Promise<void>;
  setTheme: (t: Theme | undefined) => void;
  /** All pages laid out for export: true = PDF (print), 'pptx' = PowerPoint (one page shown at a time and captured). */
  printing: boolean | 'pptx';
  exportPdf: () => Promise<void>;
  exportPptx: () => Promise<void>;
  importTheme: () => Promise<void>;
  exportTheme: () => Promise<void>;

  openPowerQuery: (focus?: string, extra?: PQQuery | PQQuery[]) => void;
  /** Ottieni dati › Database: true, or the id of the connector to open (CONNECTORS in DatabaseDialog). */
  dbDialog: boolean | string;
  publishDialog: boolean;
  /** Esplora Q&A (button action Q&A): question typed in a modal, answer not part of the report. */
  qnaExplorer: boolean;
  optionsDialog: boolean;
  /** Visualizza › Temi › Personalizza tema corrente. */
  themeDialog: boolean;
  /** Newer release on GitHub (components/Updates.tsx), its dialog and the error of a manual check. */
  update: UpdateInfo | null;
  updateDialog: boolean;
  updateError: string | null;
  /** Modellazione › Traduzioni. */
  translationsDialog: boolean;
  /** Language previewed in the report (model translations), null = the model's own names. Not saved. */
  previewCulture: string | null;
  /** Slicer change: deferred when the slicer's page has an "Applica tutti i filtri dei dati" button. */
  setSlicer: (id: string, values: string[]) => void;
  /** Page buttons Applica / Cancella tutti i filtri dei dati. */
  applyAllSlicers: (pageId: string) => void;
  clearAllSlicers: (pageId: string) => void;
  loadDbTables: (c: DbConnection, picks: { schema: string; table: string }[], transform: boolean) => Promise<void>;
  pqSet: (fn: (st: PQState) => void) => void;
  pqAddStep: (step: NewStep) => void;
  pqNewSource: (kind: string) => Promise<void>;
  pqApply: () => Promise<void>;
  transformNavigator: () => void;

  saveRelationship: (r: Relationship) => void;
  deleteRelationship: (id: string) => void;
  detectRelationships: (only?: string[]) => Promise<number>;
  setModelPos: (table: string, pos: { x: number; y: number }) => void;

  set: (p: Partial<State>) => void;
  mut: (fn: (r: Report) => void) => void;
  undo: () => void;
  redo: () => void;
  notify: (msg: string, ms?: number) => void;

  page: () => Page;
  setView: (v: View) => void;
  setActivePage: (id: string) => void;
  addPage: () => void;
  renamePage: (id: string, name: string) => void;
  deletePage: (id: string) => void;
  duplicatePage: (id: string) => void;

  addVisual: (type: VisualType, at?: { x: number; y: number }, custom?: string) => string;
  /** Visualizzazioni › … › Importa un oggetto visivo da un file (.pbiviz). */
  importCustomVisual: () => Promise<void>;
  removeCustomVisual: (guid: string) => void;
  // Selection pane and bookmarks
  setVisualHidden: (id: string, hidden: boolean) => void;
  setGroupHidden: (groupId: string, hidden: boolean) => void;
  groupVisuals: (ids: string[]) => void;
  ungroup: (groupId: string) => void;
  renameGroup: (groupId: string, name: string) => void;
  moveLayer: (id: string, dir: 1 | -1) => void;
  /** Modellazione › Nuovo parametro: numeric range (what-if) or fields. */
  createParameter: (p: { kind: 'numeric'; name: string; min: number; max: number; step: number; def: number; slicer: boolean } | { kind: 'fields'; name: string; fields: import('./types').ParamField[]; slicer: boolean }) => Promise<void>;
  /** Drill-through: go to `pageId` filtered on the source data point (values per field). */
  drillThrough: (pageId: string, values: { table: string; column: string; datePart?: import('./types').DatePart; value: string | null }[]) => void;
  addBookmark: () => void;
  updateBookmark: (id: string) => void;
  applyBookmark: (id: string) => void;
  setBookmark: (id: string, patch: Partial<Bookmark>) => void;
  removeBookmark: (id: string) => void;
  moveBookmark: (id: string, dir: 1 | -1) => void;
  updateVisual: (id: string, patch: Partial<Visual>, commit?: boolean) => void;
  updateFormat: (id: string, patch: Partial<VisualFormat>) => void;
  removeVisual: (id: string) => void;
  duplicateVisual: (id: string) => void;
  changeVisualType: (id: string, type: VisualType, custom?: string) => void;
  addField: (visualId: string | null, field: FieldDrop, well?: string, at?: { x: number; y: number }) => void;
  removeField: (visualId: string, well: string, idx: number) => void;
  /** Nascondi nell'oggetto visivo: the field stays in the visual matrix (visual calculations use it). */
  toggleFieldHidden: (visualId: string, well: string, idx: number) => void;
  setFieldTotal: (visualId: string, well: string, idx: number, total: import('./types').CustomTotal | undefined) => void;
  /** Calcoli visivi: edit mode of a visual calculation ("Nome = espressione"). */
  calcEdit: { visualId: string; original: string | null; text: string; format?: string; error?: string } | null;
  startVisualCalc: (visualId: string, original?: string, template?: { name: string; text: string; format?: string }) => void;
  saveVisualCalc: () => boolean;
  setFieldAgg: (visualId: string, well: string, idx: number, agg: FieldRef['agg']) => void;
  /** Strumenti colonna: data category and "Ordina per colonna" (null removes). */
  setColumnProps: (table: string, column: string, p: { dataCategory?: string | null; sortBy?: string | null }) => void;
  /** Date field in a hierarchy well: plain date ("Data") or automatic date hierarchy ("Gerarchia date"). */
  setDateHierarchy: (visualId: string, well: string, idx: number, on: boolean) => void;
  selectVisual: (id: string | null) => void;
  setCross: (c: CrossFilter | null) => void;

  addFilter: (scope: FilterScope, field: Omit<FieldRef, 'agg'>) => void;
  updateFilter: (scope: FilterScope, id: string, values: string[], field?: Omit<FieldRef, 'agg'>) => void;
  removeFilter: (scope: FilterScope, id: string) => void;

  openNavigator: (kind: string, path?: string) => Promise<void>;
  loadNavigator: () => Promise<void>;
  loadSample: () => Promise<void>;
  removeTable: (name: string) => Promise<void>;
  refresh: () => Promise<void>;

  newReport: () => Promise<void>;
  save: (as?: boolean) => Promise<void>;
  open: (file?: string) => Promise<void>;
  /** `model`: already read (semantic model from the Power BI service), `path` is then its display name. */
  importPowerBI: (path: string, model?: import('./api').PowerBIModel) => Promise<void>;
  /** Ottieni dati › Power BI (servizio) dialog. */
  serviceDialog: boolean;
  exportPbit: () => Promise<void>;
  /** `target` = write there without asking (Ctrl+S on a .pbix saved by MiB-BI). */
  exportPbix: (target?: string) => Promise<void>;
  exportPbip: () => Promise<void>;
  sourceName: string | null;
}

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
let calcSync: Promise<void> = Promise.resolve();
/** Tables materialized for calculation groups (dropped when their group goes away, e.g. undo). */
const calcTables = new Set<string>();

function tableNameFor(path: string, existing: TableMeta[]): string {
  const base = path.split('/').pop()!.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _-]/gu, '_') || 'Tabella';
  let name = base, i = 2;
  while (existing.some((t) => t.name === name)) name = `${base} (${i++})`;
  return name;
}

export const useStore = create<State>((set, get) => {
  const init = emptyReport();

  const findVisual = (r: Report, id: string) => {
    for (const p of r.pages) {
      const v = p.visuals.find((x) => x.id === id);
      if (v) return v;
    }
    return undefined;
  };

  const filterList = (r: Report, scope: FilterScope): Filter[] | undefined => {
    if (scope === 'report') return r.reportFilters;
    const p = r.pages.find((x) => x.id === get().activePageId)!;
    if (scope === 'page') return p.filters;
    const v = p.visuals.find((x) => x.id === get().selectedVisualId);
    return v ? (v.filters ??= []) : undefined;
  };

  const columnOf = (f: Omit<FieldRef, 'agg'>) => get().tables.find((t) => t.name === f.table)?.columns.find((c) => c.name === f.column);

  /** Puts a field into the best-fitting well, mimicking Power BI's auto placement. */
  const placeField = (v: Visual, field: FieldDrop, wellKey?: string): string | undefined => {
    if (field.levels?.length) {
      // User hierarchy: every level in the well chosen for the first one (drill levels).
      const { levels, ...base } = field;
      let w = wellKey;
      for (const column of levels) w = placeField(v, { ...base, column, plain: true }, w) ?? w;
      return w;
    }
    const def = visualDef(v.type, v.custom);
    const { measure, levels: _l, plain, ...f } = field;
    const num = measure || isNumeric(columnOf(f));
    const hasRoom = (k: string) => {
      const w = def.wells.find((x) => x.key === k)!;
      return !w.max || (v.fields[k]?.length ?? 0) < w.max;
    };
    let well = wellKey ? def.wells.find((w) => w.key === wellKey) : undefined;
    // Latitude/Longitude data category (or column name) → the map's coordinate wells.
    const category = get().tables.find((t) => t.name === f.table)?.dataCategory?.[f.column];
    well ??= def.wells.find((w) => (category === 'Latitude' ? w.key === 'lat' : category === 'Longitude' ? w.key === 'lon' : false) && hasRoom(w.key));
    well ??= def.wells.find((w) => w.match?.test(f.column) && hasRoom(w.key));
    if (!well) {
      well = (num ? def.wells.find((w) => w.measure && hasRoom(w.key)) : undefined)
        ?? def.wells.find((w) => !w.measure && hasRoom(w.key))
        ?? def.wells.find((w) => hasRoom(w.key))
        ?? def.wells[0];
    }
    if (!well) return;
    const agg: FieldRef['agg'] = measure ? 'measure' : ['table', 'multiRowCard', 'pythonVisual', 'rVisual'].includes(v.type) ? (num ? 'sum' : 'none') : well.measure ? (num ? 'sum' : 'count') : 'none';
    // Models with calculation groups discourage implicit measures (Power BI: columns are never summarized).
    if (agg !== 'none' && agg !== 'measure' && get().report.calcGroups?.length) {
      if (well.measure) { implicitBlocked = true; return undefined; }
      const list = (v.fields[well.key] ??= []);
      if (!list.some((x) => x.table === f.table && x.column === f.column)) list.push({ ...f, agg: 'none' });
      return well.key;
    }
    const list = (v.fields[well.key] ??= []);
    if (list.some((x) => x.table === f.table && x.column === f.column && x.agg === agg && !x.datePart)) return well.key;
    if (well.max && list.length >= well.max) list.splice(well.max - 1);
    // A date on a hierarchy axis becomes the automatic date hierarchy, like Power BI.
    if (!plain && !get().report.dateTables?.[f.table] && well.hierarchy && agg === 'none' && /^(DATE|TIMESTAMP)/i.test(columnOf(f)?.type ?? '') && !list.some((x) => x.table === f.table && x.column === f.column)) {
      for (const datePart of ['year', 'quarter', 'month', 'day'] as const) list.push({ ...f, agg, datePart });
      return well.key;
    }
    list.push({ ...f, agg });
    return well.key;
  };

  let implicitBlocked = false;
  const nextPosition = (p: Page, w: number, h: number) => {
    const n = p.visuals.length;
    return { x: 20 + ((n * 30) % 400), y: 20 + ((n * 30) % 240), w, h };
  };

  const defaultSize = (type: VisualType) =>
    type === 'card' ? { w: 220, h: 120 } : type === 'kpi' ? { w: 280, h: 180 } : type === 'multiRowCard' ? { w: 300, h: 260 } : type === 'slicer' ? { w: 220, h: 260 } : type === 'textbox' ? { w: 300, h: 80 } : { w: 440, h: 300 };

  /** Runs a query (source + applied steps) and stores the result as model table `def.name`.
   *  `context` resolves references to other queries (defaults to the loaded tables). */
  const loadTable = async (def: QueryDef & { sortBy?: Record<string, string>; dataCategory?: Record<string, string>; calcColumns?: TableMeta['calcColumns'] }, context?: QueryDef[], extraM?: { name: string; code: string }[]) => {
    const all = context ?? get().tables;
    const extra = extraM ?? get().report.pqQueries ?? [];
    const params = get().report.pqParams ?? [];
    const opts = compileOpts(all, extra, params);
    let meta: Awaited<ReturnType<typeof api.materialize>>;
    if (def.source.mcode !== undefined) {
      // M query: evaluated by the interpreter, loaded as typed rows.
      const r = await evaluateM(def.source.mcode, mSourceOf(all, extra, params));
      if (r.kind === 'function') throw new Error('la query restituisce una funzione: disattivare Abilita caricamento (query solo connessione).');
      meta = await api.m.load(def.name, r.columns, r.rows);
      const errs = r.errors.reduce((a, b) => a + b, 0);
      if (errs) get().notify(`${def.name}: ${errs} ${errs === 1 ? 'valore con errore caricato' : 'valori con errore caricati'} come vuoti (${r.errorText.find((x) => x) ?? ''}).`, 9000);
    } else meta = await api.materialize(def.name, await compileQuery(def, all, opts));
    const steps = def.steps?.length ? def.steps : undefined;
    let sourceColumns: TableMeta['sourceColumns'];
    if (steps) {
      const d = await api.query(`DESCRIBE SELECT * FROM (${await compileQuery({ ...def, steps: [] }, all, opts)})`);
      sourceColumns = d.rows.map((r) => ({ name: r.column_name, type: r.column_type }));
    }
    const prev = get().tables.find((x) => x.name === def.name);
    const sortBy = def.sortBy ?? prev?.sortBy;
    const dataCategory = def.dataCategory ?? prev?.dataCategory;
    const calcColumns = def.calcColumns ?? prev?.calcColumns;
    const t: TableMeta = { ...meta, source: def.source, ...(steps ? { steps, sourceColumns } : {}), ...(sortBy ? { sortBy } : {}), ...(dataCategory && Object.keys(dataCategory).length ? { dataCategory } : {}), ...(calcColumns?.length ? { calcColumns } : {}) };
    set((s) => ({
      tables: prev ? s.tables.map((x) => (x.name === def.name ? t : x)) : [...s.tables, t],
      dataVersion: s.dataVersion + 1,
      dataViewTable: s.dataViewTable ?? def.name,
      dirty: true,
    }));
  };
  const importTable = (path: string, name: string, sheet?: string, m?: string) =>
    loadTable({ name, source: { path, sheet, ...(m ? { m } : {}) } });

  return {
    tables: [],
    report: init,
    activePageId: init.pages[0].id,
    view: 'report',
    selectedVisualId: null,
    crossFilter: null,
    panes: { filters: true, viz: true, data: true, selection: false, bookmarks: false },
    perf: { recording: false, entries: [] },
    multiSel: [],
    vizTab: 'build',
    dataVersion: 0,
    filePath: null,
    dirty: false,
    past: [],
    future: [],
    navigator: null,
    zoom: 'fit',
    toast: null,
    dataViewTable: null,
    fileMenu: false,
    gridlines: false,
    readMode: false,
    quickMeasure: false,
    enterData: false,
    createInlineTable: async (name, columns, rows) => {
      set({ busy: 'Creazione della tabella…' });
      try {
        // Numbers with a decimal comma are stored with a point; each column gets the narrowest type of its values.
        const num = /^-?\d+([.,]\d+)?$/;
        const types = columns.map((_, i) => {
          const vals = rows.map((r) => r[i]).filter((x): x is string => x !== null && x !== '');
          if (!vals.length) return 'text' as const;
          if (vals.every((x) => /^-?\d+$/.test(x))) return 'int' as const;
          if (vals.every((x) => num.test(x))) return 'decimal' as const;
          if (vals.every((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))) return 'date' as const;
          if (vals.every((x) => /^(true|false|vero|falso)$/i.test(x))) return 'bool' as const;
          return 'text' as const;
        });
        const clean = rows.map((r) => columns.map((_, i) => {
          const x = r[i] ?? null;
          if (x === null || x === '') return null;
          if (types[i] === 'decimal') return x.replace(',', '.');
          if (types[i] === 'bool') return /^(true|vero)$/i.test(x) ? 'true' : 'false';
          return x;
        }));
        const typed = columns.map((c, i) => [c, types[i]] as [string, typeof types[number]]).filter(([, t]) => t !== 'text');
        await loadTable({ name, source: { path: '', inline: { columns, rows: clean } }, steps: typed.length ? [{ id: uid(), kind: 'changeType', columns: typed }] : [] });
        set({ enterData: false, dataVersion: get().dataVersion + 1 });
      } catch (e: any) {
        get().notify('Creazione non riuscita: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },
    mobileLayout: false,
    paused: false,
    pauseTick: 0,
    formatPainter: null,
    applyFormatPainter: (targetId) => {
      const fp = get().formatPainter;
      if (!fp || fp.from === targetId) { set({ formatPainter: null }); return; }
      get().mut((r) => {
        const v = findVisual(r, targetId);
        if (!v) return;
        // The target keeps its title text, sort, conditional formatting (tied to its fields) and tooltip page.
        const { titleText, sortBy, sortDir, cf, tooltipPage } = v.format;
        v.format = { ...structuredClone(fp.format), titleText, sortBy, sortDir, cf, tooltipPage };
        const same = fp.type === v.type && (fp.type !== 'custom' || fp.style?.pbiType === v.style?.pbiType);
        v.style = { ...v.style, ...(fp.style?.vcObjects ? { vcObjects: structuredClone(fp.style.vcObjects) } : {}), ...(same && fp.style?.objects ? { objects: structuredClone(fp.style.objects) } : {}) };
      });
      set({ formatPainter: null });
    },
    snapToGrid: false,
    busy: null,
    scriptsEnabled: false,
    scriptEditor: null,
    paramDialog: null,
    sourceDialog: null,
    clipboard: null,
    focusId: null,
    focusTable: false,
    exportData: null,
    aboutDialog: false,
    editInteractions: false,
    setInteraction: (source, target, mode) => get().mut((r) => {
      const p = r.pages.find((x) => x.visuals.some((v) => v.id === source));
      if (!p) return;
      const all = { ...p.interactions };
      if (mode) all[interactionKey(source, target)] = mode; else delete all[interactionKey(source, target)];
      if (Object.keys(all).length) p.interactions = all; else delete p.interactions;
    }),
    syncSlicer: (id, pageId, st) => get().mut((r) => {
      const src = findVisual(r, id);
      const page = r.pages.find((p) => p.id === pageId);
      if (!src || !page) return;
      // A group is created on first use; members share its name across pages.
      if (!src.syncGroup) {
        const used = new Set(r.pages.flatMap((p) => p.visuals.map((v) => v.syncGroup?.name).filter(Boolean)));
        let name = src.fields.category?.[0]?.column ?? 'Filtro', i = 2;
        while (used.has(name)) name = `${src.fields.category?.[0]?.column ?? 'Filtro'}${i++}`;
        src.syncGroup = { name };
      }
      const group = src.syncGroup.name;
      const own = page.visuals.some((v) => v.id === id);
      const member = own ? src : page.visuals.find((v) => v.syncGroup?.name === group);
      if (!st.sync && !st.visible) {
        if (member && member.id !== id) page.visuals = page.visuals.filter((v) => v.id !== member.id);
        else if (member) member.hidden = true;
        return;
      }
      // Visible but not synced: the copy stays on the page, out of the group.
      if (!st.sync && member && member.id !== id) { delete member.syncGroup; delete member.hidden; return; }
      if (member) { if (st.visible) delete member.hidden; else member.hidden = true; return; }
      const z = Math.max(0, ...page.visuals.map((v) => v.z)) + 1;
      const copy: Visual = { ...structuredClone(src), id: uid(), z, ...(st.visible ? {} : { hidden: true }) };
      delete copy.pbiName; delete copy.group;
      page.visuals.push(copy);
    }),
    setSyncGroup: (id, patch) => get().mut((r) => {
      const v = findVisual(r, id);
      if (!v?.syncGroup) return;
      const old = v.syncGroup.name;
      // Renaming the group renames it on every member.
      for (const p of r.pages) for (const x of p.visuals) if (x.syncGroup?.name === old) x.syncGroup = { ...x.syncGroup, ...patch };
    }),
    sourceName: null,

    serviceDialog: false,
    importPowerBI: async (path, preloaded) => {
      set({ fileMenu: false, busy: 'Lettura del file Power BI…' });
      try {
        const model = preloaded ?? await api.readPowerBI(path);
        await get().newReport();
        set({ busy: `Caricamento di ${model.tables.length} tabelle…` });
        const failed: string[] = [];
        // Power Query parameters (Gestisci parametri): kept, and used to locate .pbit sources.
        const pqParams = (model.parameters ?? []).map((p) => paramFromM(p.name, p.expression, p.description));
        const mx = model.model;
        const calcNames = new Set((mx?.calcGroups ?? []).map((g) => g.table));
        // The M of every query, reachable by name from the others while the interpreter evaluates them.
        const allM = [...model.tables.filter((x) => x.m && !x.dax).map((x) => ({ name: x.name, code: x.m! })), ...(mx?.queries ?? [])];
        if (pqParams.length) set((s) => ({ report: { ...s.report, pqParams } }));
        for (const t of model.tables) {
          // Calculation group tables are rebuilt from their items (syncCalcTables).
          if (calcNames.has(t.name)) continue;
          try {
            if (t.dax) {
              // Calculated table: evaluated by finalizeModel() once the other tables are loaded.
              set((s) => ({ tables: [...s.tables, { name: t.name, rowCount: 0, columns: [], source: { path: '', dax: t.dax } }] }));
              continue;
            }
            if (t.parquet) { await importTable(t.parquet, t.name, undefined, t.m ?? undefined); continue; }
            // .pbit/.pbip: no data inside. The query's M runs on the interpreter (every step applied); if its sources
            // are not reachable, the local file it points at (parameters inlined), else an empty typed table.
            const mText = inlineParamsInM(t.m ?? '', pqParams);
            const src = /File\.Contents\("([^"]+)"\)/.exec(mText)?.[1];
            const sheet = /Item="([^"]+)",Kind="Sheet"/.exec(mText)?.[1];
            let ok = false;
            if (t.m) { try { await loadTable({ name: t.name, source: { path: '', mcode: t.m } }, [], allM); ok = true; } catch { /* fall through */ } }
            if (!ok && src) { try { await importTable(src, t.name, sheet, t.m ?? undefined); ok = true; } catch { /* fall through */ } }
            // Data typed in the M itself (Immetti dati): loaded as an inline table.
            const inline = !ok && t.m ? await inlineFromM(t.m) : null;
            if (inline) {
              const TYPE: Record<string, PQType> = { int64: 'int', double: 'decimal', decimal: 'decimal', boolean: 'bool' };
              const typed = (t.columns ?? []).flatMap((c): [string, PQType][] => {
                const i = inline.columns.indexOf(c.name);
                if (i < 0) return [];
                if (c.dataType === 'dateTime') return [[c.name, inline.rows.every((r) => !r[i] || /^\d{4}-\d{2}-\d{2}$/.test(r[i]!)) ? 'date' : 'datetime']];
                return TYPE[c.dataType] ? [[c.name, TYPE[c.dataType]]] : [];
              });
              try { await loadTable({ name: t.name, source: { path: '', inline }, steps: typed.length ? [{ id: uid(), kind: 'changeType', columns: typed }] : [] }); ok = true; } catch { /* empty table */ }
            }
            if (!ok) {
              const meta = await api.createEmptyTable(t.name, t.columns ?? []);
              set((s) => ({ tables: [...s.tables, { ...meta, source: { path: src ?? '', m: t.m ?? undefined } }] }));
              failed.push(t.name);
            }
          } catch {
            failed.push(t.name);
          }
        }
        const sortBy = new Map(model.tables.map((t) => [t.name, t.sortBy ?? {}]));
        const cats = new Map(model.tables.filter((t) => t.dataCategory && Object.keys(t.dataCategory).length).map((t) => [t.name, t.dataCategory!]));
        // Calculated columns of schema-only files (.pbit/.pbip) are computed here; .pbix data already has them.
        const calc = new Map(model.tables.filter((t) => !t.parquet && t.calcColumns?.length).map((t) => [t.name, t.calcColumns!]));
        set((s) => ({ tables: s.tables.map((t) => ({ ...t, sortBy: sortBy.get(t.name), ...(cats.has(t.name) ? { dataCategory: cats.get(t.name) } : {}), ...(calc.has(t.name) ? { calcColumns: calc.get(t.name) } : {}) })) }));
        const relationships: Relationship[] = model.relationships.map((r) => {
          const swap = r.cardinality === 'oneToMany';
          return {
            id: uid(),
            fromTable: swap ? r.toTable : r.fromTable, fromColumn: swap ? r.toColumn : r.fromColumn,
            toTable: swap ? r.fromTable : r.toTable, toColumn: swap ? r.fromColumn : r.toColumn,
            cardinality: r.cardinality === 'oneToOne' ? 'oneToOne' : r.cardinality === 'manyToMany' ? 'manyToMany' : 'manyToOne',
            crossFilter: r.crossFilter, active: r.active, ...(r.securityBoth ? { securityBoth: true } : {}),
          };
        });
        const measures = model.measures.map((m) => ({ table: m.table, name: m.name, expression: m.expression, formatString: m.formatString || undefined }));
        // Calculated tables/columns first: the layout may use their fields.
        if (get().tables.some((t) => t.source.dax || t.calcColumns?.length)) {
          set({ report: { ...emptyReport(), relationships, measures } });
          await get().finalizeModel();
        }
        // Hierarchies, display folders, date tables, calculation groups and roles.
        const known = (t: string) => get().tables.some((x) => x.name === t) || calcNames.has(t) || measures.some((m) => m.table === t);
        const extrasReport: Partial<Report> = {};
        const hs = (mx?.hierarchies ?? []).filter((h) => known(h.table) && h.levels.length).map((h) => {
          const names = Object.fromEntries(h.levels.filter((l) => l.name !== l.column).map((l) => [l.column, l.name]));
          return { table: h.table, name: h.name, levels: h.levels.map((l) => l.column), ...(Object.keys(names).length ? { levelNames: names } : {}) };
        });
        if (hs.length) extrasReport.hierarchies = hs;
        const folders = Object.fromEntries((mx?.folders ?? []).filter((f) => known(f.table)).map((f) => [f.table + '\u0001' + f.name, f.folder]));
        if (Object.keys(folders).length) extrasReport.displayFolders = folders;
        const dts = Object.fromEntries(Object.entries(mx?.dateTables ?? {}).filter(([t]) => known(t)));
        if (Object.keys(dts).length) extrasReport.dateTables = dts;
        if (mx?.calcGroups.length) extrasReport.calcGroups = mx.calcGroups.map((g) => ({ table: g.table, column: g.column, precedence: g.precedence, items: g.items.map((i) => ({ name: i.name, expression: i.expression, ...(i.formatString ? { formatString: i.formatString } : {}) })) }));
        const roles = (mx?.roles ?? []).map((r) => ({ name: r.name, filters: r.filters.filter((f) => known(f.table)) }));
        if (roles.length) extrasReport.roles = roles;
        if (mx?.functions?.length) extrasReport.functions = mx.functions;
        const cals = (mx?.calendars ?? []).filter((c) => known(c.table));
        if (cals.length) extrasReport.calendars = cals;
        const cultures = (mx?.cultures ?? []).filter((c) => Object.keys(c.captions ?? {}).length || Object.keys(c.descriptions ?? {}).length || Object.keys(c.folders ?? {}).length);
        if (cultures.length) extrasReport.cultures = cultures;
        if (mx?.queries?.length) extrasReport.pqQueries = mx.queries.map((q) => ({ name: q.name, code: q.code }));
        if (mx?.groups && Object.keys(mx.groups).length) extrasReport.pqGroups = mx.groups;
        if (extrasReport.calcGroups) {
          set({ report: { ...get().report, calcGroups: extrasReport.calcGroups } });
          await get().syncCalcTables();
        }
        setHierarchyLevels(mx?.hierarchies ?? []);
        const tables = get().tables;
        const layoutJson = model.layout ?? (model.pbir ? pbirToLayout(model.pbir) : null);
        setCustomVisuals(model.customVisuals);
        const parsed = layoutJson ? parseLayout(layoutJson, tables, new Set(measures.map((m) => m.name)), model.resources) : null;
        const pages = parsed?.pages ?? emptyReport().pages;
        const theme = layoutJson ? themeFromLayout(layoutJson, model.resources) : undefined;
        const report: Report = { pages, reportFilters: parsed?.reportFilters ?? [], relationships, modelLayout: {}, measures, ...(theme ? { theme } : {}), ...(parsed?.bookmarks.length ? { bookmarks: parsed.bookmarks } : {}), ...(model.customVisuals?.length ? { customVisuals: model.customVisuals } : {}), ...(pqParams.length ? { pqParams } : {}), ...(model.sensitivity ? { sensitivity: model.sensitivity } : {}), ...(parsed?.filterByDefault ? { options: { filterByDefault: true } } : {}), ...extrasReport };
        set({ report, activePageId: pages[0].id, past: [], future: [], dirty: false, filePath: null, sourceName: path.split('/').pop()!, view: 'report', dataVersion: get().dataVersion + 1 });

        const unsupportedDax = measures.filter((m) => checkMeasure({ tables, rels: relationships, measures, functions: extrasReport.functions, calendars: extrasReport.calendars, calcGroups: extrasReport.calcGroups }, m)).length;
        const notes = [
          `Importati: ${tables.length} tabelle, ${relationships.length} relazioni, ${measures.length} misure, ${pages.length} pagine.`,
          ...model.warnings,
          failed.length ? `Dati non disponibili per: ${failed.join(', ')} (${model.kind === 'pbip' ? 'progetto .pbip' : 'modello .pbit'}: il file non contiene dati e le origini non sono raggiungibili).` : '',
          unsupportedDax ? `${unsupportedDax} misure DAX usano funzioni non ancora supportate.` : '',
          parsed && Object.keys(parsed.skipped).length ? `Oggetti visivi non supportati: ${Object.entries(parsed.skipped).map(([k, n]) => `${k} (${n})`).join(', ')}.` : '',
        ].filter(Boolean);
        get().notify(notes.join(' '), 15000);
      } catch (e: any) {
        get().notify(e.message, 15000);
      } finally {
        set({ busy: null });
      }
    },
    exportPbit: async () => {
      set({ fileMenu: false });
      const { report, tables, filePath, sourceName } = get();
      const base = (filePath?.split('/').pop() ?? sourceName ?? 'Report').replace(/\.(mibx|pbix|pbit)$/i, '');
      try {
        await prepareCfExport();
        const out = await api.savePbit(buildPbitParts(report, tables), base + '.pbit');
        if (out) get().notify(`Esportato ${out.split('/').pop()}. Aprirlo in Power BI Desktop: i dati vengono ricaricati dalle origini (percorsi Linux da aggiornare in Trasforma dati › Impostazioni origine dati).`, 12000);
      } catch (e: any) {
        get().notify('Esportazione non riuscita: ' + e.message);
      }
    },
    exportPbix: async (target) => {
      set({ fileMenu: false });
      const { report, tables, filePath, sourceName } = get();
      const base = (filePath?.split('/').pop() ?? sourceName ?? 'Report').replace(/\.(mibx|pbix|pbit|pbip)$/i, '');
      set({ busy: 'Salvataggio del file Power BI…' });
      try {
        await prepareCfExport();
        const { parts, schema, extra } = buildPbixParts(report, tables);
        const out = await api.savePbix(parts, schema, extra, base + '.pbix', target);
        if (out) {
          set({ filePath: out, dirty: false });
          get().notify(`Salvato ${out.split('/').pop()}: report, modello e dati, apribile in Power BI Desktop.`, 9000);
        }
      } catch (e: any) {
        get().notify('Salvataggio del file .pbix non riuscito: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },
    exportPbip: async () => {
      set({ fileMenu: false });
      const { report, tables, filePath, sourceName } = get();
      const base = (filePath?.split('/').pop() ?? sourceName ?? 'Report').replace(/\.(mibx|pbix|pbit|pbip)$/i, '');
      try {
        await prepareCfExport();
        const o = globalOptions();
        const fmt = { pbir: o.pbir !== false, tmdl: o.tmdl !== false };
        const out = await api.savePbip(buildPbipParts(report, tables, fmt), base + '.pbip');
        if (out) get().notify(`Progetto salvato: ${out.split('/').pop()} con le cartelle .Report (${fmt.pbir ? 'PBIR' : 'report.json'}) e .SemanticModel (${fmt.tmdl ? 'TMDL' : 'model.bim'}), file di testo adatti a git.`, 9000);
      } catch (e: any) {
        get().notify('Salvataggio del progetto non riuscito: ' + e.message);
      }
    },
    relManage: false,
    relEditor: null,
    selectedRelId: null,
    pq: null,
    daxEdit: null,
    daxQueryText: '',

    printing: false,
    exportPptx: async () => {
      const { filePath, sourceName } = get();
      const base = (filePath?.split('/').pop() ?? sourceName ?? 'Report').replace(/\.(mibx|pbix|pbit|pbip)$/i, '');
      set({ fileMenu: false, crossFilter: null, printing: 'pptx', busy: 'Esportazione in PowerPoint…' });
      try {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await wait(400);
        for (let t = 0; t < 30000 && pendingQueries() > 0; t += 100) await wait(100);
        await wait(700); // chart animations
        set({ busy: null });
        await wait(150);
        const root = document.querySelector('.print-root') as HTMLElement;
        const els = [...root.querySelectorAll<HTMLElement>('.print-page')];
        const slides: { name: string; png: string; w: number; h: number }[] = [];
        for (const [i, el] of els.entries()) {
          // The page at the window's top-left corner, scaled down when the window is smaller.
          const w = el.offsetWidth, h = el.offsetHeight;
          const k = Math.min(1, window.innerWidth / w, window.innerHeight / h);
          root.style.transform = `translate(0px, ${-el.offsetTop * k}px) scale(${k})`;
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          await wait(60);
          slides.push({ name: get().report.pages[i]?.name ?? `Pagina ${i + 1}`, png: await api.capture({ x: 0, y: 0, width: Math.floor(w * k), height: Math.floor(h * k) }), w, h });
        }
        const out = await api.savePptx(slides, base + '.pptx');
        if (out) get().notify(`Esportato ${out.split('/').pop()} (${slides.length} ${slides.length === 1 ? 'diapositiva' : 'diapositive'}, una per pagina).`);
      } catch (e: any) {
        get().notify('Esportazione PowerPoint non riuscita: ' + e.message);
      } finally {
        set({ printing: false, busy: null });
      }
    },
    exportPdf: async () => {
      const { filePath, sourceName } = get();
      const base = (filePath?.split('/').pop() ?? sourceName ?? 'Report').replace(/\.(mibx|pbix|pbit|pbip)$/i, '');
      set({ fileMenu: false, crossFilter: null, printing: true, busy: 'Esportazione in PDF…' });
      try {
        const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
        await wait(400);
        for (let t = 0; t < 30000 && pendingQueries() > 0; t += 100) await wait(100);
        await wait(700); // chart animations
        const out = await api.printPdf(base + '.pdf');
        if (out) get().notify(`Esportato ${out.split('/').pop()} (${get().report.pages.length} ${get().report.pages.length === 1 ? 'pagina' : 'pagine'}).`);
      } catch (e: any) {
        get().notify('Esportazione PDF non riuscita: ' + e.message);
      } finally {
        set({ printing: false, busy: null });
      }
    },
    setTheme: (t) => get().mut((r) => { if (t) r.theme = t; else delete r.theme; }),
    importTheme: async () => {
      try {
        const f = await api.readText('theme');
        if (!f) return;
        const t = parseTheme(f.content, f.path.split('/').pop()!.replace(/\.json$/i, ''));
        get().setTheme(t);
        get().notify(`Tema "${t.name}" applicato.`);
      } catch (e: any) { get().notify('Tema non valido: ' + e.message); }
    },
    exportTheme: async () => {
      const t = get().report.theme ?? THEMES[0];
      const p = await api.saveText(themeJson(t), `${t.name}.json`, 'theme');
      if (p) get().notify(`Tema salvato in ${p.split('/').pop()}.`);
    },
    model: () => ({ tables: get().tables, rels: get().report.relationships, measures: get().report.measures, ...modelExtras(get().report, get().viewAs?.user) }),
    viewAs: null,
    rolesDialog: false,
    viewAsDialog: false,
    setViewAs: async (v) => {
      const roles = (get().report.roles ?? []).filter((r) => v?.roles.includes(r.name));
      try {
        if (!v) await api.setRole(null);
        else {
          // Several roles: a row is visible when any role allows it; a table a role does not restrict is not filtered.
          const model = { ...get().model(), user: v.user };
          const per = roles.map((r) => new Map(rlsWhere(model, r.filters).map((x) => [x.table, x.where])));
          const tables = get().tables.flatMap((t) => (per.length && per.every((m) => m.has(t.name)) ? [{ table: t.name, where: per.map((m) => `(${m.get(t.name)})`).join(' OR ') }] : []));
          await api.setRole(tables);
        }
        set((st) => ({ viewAs: v, viewAsDialog: false, crossFilter: null, dataVersion: st.dataVersion + 1 }));
      } catch (e: any) {
        get().notify('Visualizza come non riuscito: ' + e.message.split('\n')[0], 10000);
      }
    },
    saveRoles: async (roles) => {
      get().mut((r) => { if (roles.length) r.roles = roles; else delete r.roles; });
      set({ rolesDialog: false });
      const va = get().viewAs;
      if (va) await get().setViewAs({ ...va, roles: va.roles.filter((n) => roles.some((r) => r.name === n)) });
    },
    propsTarget: null,
    setDisplayFolder: (table, field, folder) => get().mut((r) => {
      const k = table + '\u0001' + field;
      const f = { ...(r.displayFolders ?? {}) };
      const clean = folder.split(/[\\/]/).map((x) => x.trim()).filter(Boolean).join('\\');
      if (clean) f[k] = clean; else delete f[k];
      if (Object.keys(f).length) r.displayFolders = f; else delete r.displayFolders;
    }),
    createHierarchy: (table, column) => {
      const hs = get().report.hierarchies ?? [];
      let name = `${column} Gerarchia`, i = 2;
      while (hs.some((h) => h.table === table && h.name === name)) name = `${column} Gerarchia ${i++}`;
      get().mut((r) => { (r.hierarchies ??= []).push({ table, name, levels: [column] }); });
      set({ propsTarget: { table, hierarchy: name } });
    },
    addHierarchyLevel: (table, hierarchy, column) => get().mut((r) => {
      const h = r.hierarchies?.find((x) => x.table === table && x.name === hierarchy);
      if (h && !h.levels.includes(column)) h.levels.push(column);
    }),
    updateHierarchy: (table, name, patch) => get().mut((r) => {
      const h = r.hierarchies?.find((x) => x.table === table && x.name === name);
      if (!h) return;
      if (patch.name && patch.name !== name) {
        // Visual fields that are levels of the hierarchy follow the rename.
        const walk = (o: any) => {
          if (!o || typeof o !== 'object') return;
          if (Array.isArray(o)) { o.forEach(walk); return; }
          if (o.table === table && o.hierarchy === name) o.hierarchy = patch.name;
          Object.values(o).forEach(walk);
        };
        walk(r.pages);
      }
      if (patch.name && patch.name !== name) renameFieldInCultures(r, table, name, patch.name);
      if (patch.name && patch.name !== name && r.displayFolders?.[table + '\u0001' + name]) {
        r.displayFolders[table + '\u0001' + patch.name] = r.displayFolders[table + '\u0001' + name];
        delete r.displayFolders[table + '\u0001' + name];
      }
      Object.assign(h, patch);
      // Fields of visuals on a column that is no longer a level become plain columns.
      const name2 = h.name;
      const unlink = (o: any) => {
        if (!o || typeof o !== 'object') return;
        if (Array.isArray(o)) { o.forEach(unlink); return; }
        if (o.table === table && o.hierarchy === name2 && typeof o.column === 'string' && !h.levels.includes(o.column)) delete o.hierarchy;
        Object.values(o).forEach(unlink);
      };
      unlink(r.pages);
      if (!h.levels.length) r.hierarchies = r.hierarchies!.filter((x) => x !== h);
    }),
    removeHierarchy: (table, name) => get().mut((r) => {
      r.hierarchies = r.hierarchies?.filter((x) => !(x.table === table && x.name === name));
      if (!r.hierarchies?.length) delete r.hierarchies;
    }),
    setDateTable: async (table, column) => {
      if (column) {
        // Power BI: the date column must be unique, without blanks; dates contiguous (no gaps).
        const c = qi(column);
        const q = await api.query(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn, COUNT(DISTINCT ${c}) AS d, CAST(date_diff('day', CAST(MIN(${c}) AS DATE), CAST(MAX(${c}) AS DATE)) + 1 AS BIGINT) AS span FROM ${qi(table)}`);
        const r = q.rows[0] ?? {};
        if (Number(r.nn) !== Number(r.n)) return 'La colonna contiene valori vuoti.';
        if (Number(r.d) !== Number(r.n)) return 'La colonna contiene valori duplicati.';
        if (Number(r.span) !== Number(r.d)) return 'Le date non sono contigue: mancano alcuni giorni nell\'intervallo.';
      }
      get().mut((r) => {
        const d = { ...(r.dateTables ?? {}) };
        if (column) d[table] = column; else delete d[table];
        if (Object.keys(d).length) r.dateTables = d; else delete r.dateTables;
      });
      set((st) => ({ dataVersion: st.dataVersion + 1 }));
      return null;
    },
    createCalcGroup: async () => {
      const taken = (n: string) => get().tables.some((t) => t.name.toLowerCase() === n.toLowerCase());
      let name = 'Gruppo di calcolo', i = 2;
      while (taken(name)) name = `Gruppo di calcolo ${i++}`;
      const precedence = Math.max(-1, ...(get().report.calcGroups ?? []).map((g) => g.precedence)) + 1;
      get().mut((r) => { (r.calcGroups ??= []).push({ table: name, column: 'Nome', precedence, items: [{ name: 'Elemento di calcolo', expression: 'SELECTEDMEASURE()' }] }); });
      await get().syncCalcTables();
      // Like Power BI: implicit measures are discouraged once a calculation group exists.
      get().notify('Creato il gruppo di calcolo. Usare misure esplicite: le aggregazioni implicite non vengono trasformate dagli elementi di calcolo.', 9000);
      get().startDax('calcItem', name, 'Elemento di calcolo');
    },
    addCalcItem: (table) => {
      const g = get().report.calcGroups?.find((x) => x.table === table);
      if (!g) return;
      let name = 'Elemento di calcolo', i = 2;
      while (g.items.some((x) => x.name === name)) name = `Elemento di calcolo ${i++}`;
      set({ daxEdit: { kind: 'calcItem', table, original: null, text: `${name} = SELECTEDMEASURE()` } });
    },
    removeCalcItem: (table, item) => {
      get().mut((r) => { const g = r.calcGroups?.find((x) => x.table === table); if (g) g.items = g.items.filter((x) => x.name !== item); });
      void get().syncCalcTables();
    },
    moveCalcItem: (table, item, dir) => {
      get().mut((r) => {
        const g = r.calcGroups?.find((x) => x.table === table);
        const i = g ? g.items.findIndex((x) => x.name === item) : -1;
        if (!g || i < 0 || i + dir < 0 || i + dir >= g.items.length) return;
        [g.items[i], g.items[i + dir]] = [g.items[i + dir], g.items[i]];
      });
      void get().syncCalcTables();
    },
    setCalcGroup: (table, patch) => {
      const g = get().report.calcGroups?.find((x) => x.table === table);
      if (!g) return;
      const old = g.column;
      // One undo step: fields, filters and slicers on the old column follow the rename.
      get().mut((r) => {
        if (patch.column && patch.column !== old) {
          const col = patch.column;
          const walk = (o: any) => {
            if (!o || typeof o !== 'object') return;
            if (Array.isArray(o)) { o.forEach(walk); return; }
            if (o.table === table && o.column === old) o.column = col;
            Object.values(o).forEach(walk);
          };
          walk(r.pages); walk(r.reportFilters); walk(r.bookmarks);
          renameColumnInDax(r, table, old, col);
        }
        Object.assign(r.calcGroups!.find((x) => x.table === table)!, patch);
      });
      void get().syncCalcTables();
    },
    // Serialized: the store subscription and the editing actions may both ask for a sync.
    syncCalcTables: () => (calcSync = calcSync.then(async () => {
      // Undo of "Gruppo di calcolo": its table (inline, sorted by Ordinal) goes away too.
      for (const name of [...calcTables].filter((n) => !get().report.calcGroups?.some((g) => g.table === n))) {
        calcTables.delete(name);
        if (!get().tables.some((x) => x.name === name)) continue;
        await api.dropTable(name);
        set((st) => ({ tables: st.tables.filter((x) => x.name !== name), dataVersion: st.dataVersion + 1 }));
      }
      for (const g of get().report.calcGroups ?? []) {
        calcTables.add(g.table);
        const t = get().tables.find((x) => x.name === g.table);
        const rows = g.items.map((it, i) => [it.name, String(i)]);
        const inline = t?.source.inline;
        if (inline && inline.columns[0] === g.column && JSON.stringify(inline.rows) === JSON.stringify(rows)) continue;
        try {
          await loadTable({ name: g.table, source: { path: '', inline: { columns: [g.column, 'Ordinal'], rows } }, steps: [{ id: uid(), kind: 'changeType', columns: [['Ordinal', 'int']] }], sortBy: { [g.column]: 'Ordinal' } });
        } catch (e: any) { get().notify(`Gruppo di calcolo ${g.table}: ${e.message}`); }
      }
    })),
    startDax: (kind, table, original) => {
      const { tables, report, dataViewTable } = get();
      const home = table ?? dataViewTable ?? tables[0]?.name ?? '';
      if (!home && kind !== 'table') { get().notify('Caricare prima dei dati.'); return; }
      let text: string, formatString: string | undefined;
      if (kind === 'function') {
        const f = original ? report.functions?.find((x) => x.name === original) : undefined;
        let name = 'Funzione', i = 2;
        while (!f && report.functions?.some((x) => x.name.toLowerCase() === name.toLowerCase())) name = `Funzione${i++}`;
        text = f ? `${f.name} = ${f.expression}` : `${name} = ( valore : NUMERIC ) =>\n    valore`;
      } else if (original && kind === 'measure') {
        const m = report.measures.find((x) => x.name === original)!;
        text = `${m.name} = ${m.expression}`;
        formatString = m.formatString;
      } else if (original && kind === 'calcItem') {
        text = `${original} = ${report.calcGroups?.find((g) => g.table === home)?.items.find((x) => x.name === original)?.expression ?? ''}`;
        formatString = report.calcGroups?.find((g) => g.table === home)?.items.find((x) => x.name === original)?.formatString;
      } else if (original && kind === 'column') {
        text = `${original} = ${tables.find((t) => t.name === home)?.calcColumns?.find((c) => c.name === original)?.expression ?? ''}`;
      } else if (original) {
        text = `${original} = ${tables.find((t) => t.name === original)?.source.dax ?? ''}`;
      } else {
        const taken = (n: string) => report.measures.some((m) => m.name === n) || tables.some((t) => t.name === n || t.columns.some((c) => c.name === n));
        let name: string = DAX_KIND[kind], i = 2;
        while (taken(name)) name = `${DAX_KIND[kind]} ${i++}`;
        text = `${name} = `;
      }
      set({ daxEdit: { kind, table: home, original: original ?? null, text: daxShow(text), formatString }, fileMenu: false });
    },
    saveDax: async () => {
      const ed = get().daxEdit;
      if (!ed) return false;
      const fail = (error: string) => { set({ daxEdit: { ...ed, error } }); return false; };
      const parts = splitDax(daxStore(ed.text));
      if (!parts) return fail('Sintassi: Nome = espressione');
      if (!parts.expr) return fail("Manca l'espressione dopo =");
      const { name, expr } = parts;
      const tables = get().tables;
      try {
        if (ed.kind === 'measure') {
          const others = get().report.measures.filter((m) => m.name !== ed.original);
          if (others.some((m) => m.name.toLowerCase() === name.toLowerCase())) return fail(`Esiste già una misura denominata "${name}".`);
          if (tables.some((t) => t.columns.some((c) => c.name.toLowerCase() === name.toLowerCase()))) return fail(`Il nome "${name}" è già usato da una colonna.`);
          const m = { table: ed.table, name, expression: expr, ...(ed.formatString ? { formatString: ed.formatString } : {}) };
          const err = checkMeasure({ ...get().model(), measures: [...others, m] }, m);
          if (err) return fail(err);
          const old = ed.original;
          get().mut((r) => {
            const i = r.measures.findIndex((x) => x.name === old);
            if (i >= 0) r.measures[i] = m; else r.measures.push(m);
            if (old && old !== name) {
              renameFieldInCultures(r, m.table, old, name);
              // Power BI updates references to a renamed measure.
              const re = new RegExp(`\\[${reEscape(old)}\\]`, 'gi');
              for (const x of r.measures) if (x !== m) x.expression = x.expression.replace(re, `[${name}]`);
              const walk = (o: any) => {
                if (!o || typeof o !== 'object') return;
                if (Array.isArray(o)) { o.forEach(walk); return; }
                if (o.agg === 'measure' && o.column === old) o.column = name;
                Object.values(o).forEach(walk);
              };
              walk(r.pages);
            }
          });
        } else if (ed.kind === 'function') {
          const others = (get().report.functions ?? []).filter((f) => f.name !== ed.original);
          if (others.some((f) => f.name.toLowerCase() === name.toLowerCase())) return fail(`Esiste già una funzione denominata "${name}".`);
          const prev = get().report.functions?.find((f) => f.name === ed.original);
          const f = { name, expression: expr, ...(prev?.description ? { description: prev.description } : {}) };
          const err = checkFunction({ ...get().model(), functions: [...others, f] }, f);
          if (err) return fail(err);
          const old = ed.original;
          get().mut((r) => {
            const list = (r.functions ??= []);
            const i = list.findIndex((x) => x.name === old);
            if (i >= 0) list[i] = f; else list.push(f);
            // Calls of a renamed function follow it (measures, calculation items, other functions).
            if (old && old !== name) {
              const re = new RegExp(`(^|[^\\w.'\\]])${reEscape(old)}(\\s*\\()`, 'gi');
              const fix = (e: string) => e.replace(re, (_m, a, b) => `${a}${name}${b}`);
              for (const m of r.measures) m.expression = fix(m.expression);
              for (const x of list) if (x !== f) x.expression = fix(x.expression);
              for (const g of r.calcGroups ?? []) for (const it of g.items) it.expression = fix(it.expression);
            }
          });
        } else if (ed.kind === 'calcItem') {
          const g = get().report.calcGroups?.find((x) => x.table === ed.table);
          if (!g) return fail('Gruppo di calcolo non trovato.');
          if (g.items.some((x) => x.name.toLowerCase() === name.toLowerCase() && x.name !== ed.original)) return fail(`Esiste già un elemento di calcolo "${name}".`);
          const err = checkCalcItem(get().model(), expr);
          if (err) return fail(err);
          const old = ed.original;
          get().mut((r) => {
            const gg = r.calcGroups!.find((x) => x.table === ed.table)!;
            const item = { name, expression: expr, ...(ed.formatString ? { formatString: ed.formatString } : {}) };
            const i = gg.items.findIndex((x) => x.name === old);
            if (i >= 0) gg.items[i] = item; else gg.items.push(item);
            if (old && old !== name) {
              // Slicer selections and filters on the renamed item follow it.
              const fix = (vals?: string[]) => vals?.forEach((v, k) => { if (v === old) vals[k] = name; });
              for (const p of r.pages) {
                for (const v of p.visuals) { if (v.fields.category?.[0]?.table === ed.table) fix(v.slicerValues); for (const f of v.filters ?? []) if (f.table === ed.table) fix(f.values); }
                for (const f of p.filters) if (f.table === ed.table) fix(f.values);
              }
              for (const f of r.reportFilters) if (f.table === ed.table) fix(f.values);
              // Bookmarks keep slicer selections and filters too.
              for (const b of r.bookmarks ?? []) {
                for (const f of [...(b.state.reportFilters ?? []), ...(b.state.pageFilters ?? [])]) if (f.table === ed.table) fix(f.values);
                for (const [vid, vals] of Object.entries(b.state.slicers ?? {})) {
                  const sv = r.pages.flatMap((p) => p.visuals).find((x) => x.id === vid);
                  if (sv?.fields.category?.[0]?.table === ed.table) fix(vals);
                }
              }
            }
          });
          await get().syncCalcTables();
        } else if (ed.kind === 'column') {
          const t = tables.find((x) => x.name === ed.table)!;
          if (t.columns.some((c) => c.name.toLowerCase() === name.toLowerCase() && c.name !== ed.original)) return fail(`La tabella contiene già una colonna "${name}".`);
          const sql = calcColumnSql(get().model(), t.name, expr);
          if (ed.original && ed.original !== name) await api.dropColumn(t.name, ed.original);
          const meta = await api.addCalcColumn(t.name, name, sql, ed.original === name);
          const calcColumns = [...(t.calcColumns ?? []).filter((c) => c.name !== ed.original), { name, expression: expr }];
          set((s) => ({ tables: s.tables.map((x) => (x.name === t.name ? { ...x, columns: meta.columns, rowCount: meta.rowCount, calcColumns } : x)), dirty: true }));
        } else {
          if (tables.some((t) => t.name.toLowerCase() === name.toLowerCase() && t.name !== ed.original)) return fail(`Esiste già una tabella denominata "${name}".`);
          const sql = calcTableSql(get().model(), expr);
          const prev = tables.find((t) => t.name === ed.original);
          if (ed.original && ed.original !== name) {
            await api.dropTable(ed.original);
            const from = ed.original;
            get().mut((r) => renameTableInReport(r, from, name));
          }
          const meta = await api.materialize(name, sql);
          const t: TableMeta = { ...meta, source: { path: '', dax: expr }, ...(prev?.calcColumns ? { calcColumns: prev.calcColumns } : {}) };
          set((s) => ({ tables: prev ? s.tables.map((x) => (x.name === prev.name ? t : x)) : [...s.tables, t], dirty: true }));
        }
      } catch (e: any) {
        return fail(e.message.split('\n')[0]);
      }
      set((s) => ({ daxEdit: null, dataVersion: s.dataVersion + 1 }));
      return true;
    },
    deleteFunction: (name) => get().mut((r) => {
      r.functions = r.functions?.filter((f) => f.name !== name);
      if (!r.functions?.length) delete r.functions;
    }),
    updateModelFromQuery: (text) => {
      let defs;
      try { defs = parseQuery(text).defines.filter((d) => d.kind === 'measure' || d.kind === 'function'); }
      catch (e: any) { return { error: e.message }; }
      if (!defs.length) return { error: 'La query non contiene DEFINE MEASURE o DEFINE FUNCTION da salvare nel modello.' };
      const { report, tables } = get();
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      let measures = [...report.measures], functions = [...(report.functions ?? [])];
      for (const d of defs) {
        if (d.kind === 'function') {
          const prev = functions.find((f) => same(f.name, d.name));
          const f = { name: d.name, expression: d.text, ...(d.description ?? prev?.description ? { description: d.description ?? prev!.description } : {}) };
          functions = [...functions.filter((x) => x !== prev), f];
        } else {
          const prev = measures.find((m) => same(m.name, d.name));
          const m = { table: d.table ?? prev?.table ?? tables[0]?.name ?? '', name: d.name, expression: d.text, ...(prev?.formatString ? { formatString: prev.formatString } : {}) };
          measures = prev ? measures.map((x) => (x === prev ? m : x)) : [...measures, m];
        }
      }
      const model = { ...get().model(), measures, functions };
      for (const d of defs) {
        const err = d.kind === 'function' ? checkFunction(model, functions.find((f) => same(f.name, d.name))!) : checkMeasure(model, measures.find((m) => same(m.name, d.name))!);
        if (err) return { error: `${d.kind === 'function' ? 'Funzione' : 'Misura'} ${d.name}: ${err}` };
      }
      get().mut((r) => { r.measures = measures; if (functions.length) r.functions = functions; else delete r.functions; });
      const nf = defs.filter((d) => d.kind === 'function').length, nm = defs.length - nf;
      return { done: [nm ? `${nm} ${nm === 1 ? 'misura' : 'misure'}` : '', nf ? `${nf} ${nf === 1 ? 'funzione' : 'funzioni'}` : ''].filter(Boolean).join(' e ') + ' salvate nel modello.' };
    },
    calendarDialog: null,
    setCalendars: (table, calendars) => get().mut((r) => {
      r.calendars = [...(r.calendars ?? []).filter((c) => c.table !== table), ...calendars];
      if (!r.calendars.length) delete r.calendars;
    }),
    deleteMeasure: (name) => get().mut((r) => {
      r.measures = r.measures.filter((m) => m.name !== name);
      for (const p of r.pages) for (const v of p.visuals) for (const k of Object.keys(v.fields)) v.fields[k] = v.fields[k].filter((f) => !(f.agg === 'measure' && f.column === name));
    }),
    deleteCalcColumn: async (table, name) => {
      try {
        const meta = await api.dropColumn(table, name);
        set((s) => ({ tables: s.tables.map((t) => (t.name === table ? { ...t, columns: meta.columns, calcColumns: t.calcColumns?.filter((c) => c.name !== name) } : t)), dataVersion: s.dataVersion + 1, dirty: true }));
      } catch (e: any) { get().notify(e.message); }
    },
    // Calculated tables, then calculated columns, after any data load (they read loaded data).
    finalizeModel: async () => {
      const errors: string[] = [];
      for (const t of get().tables.filter((x) => x.source.dax)) {
        try {
          const meta = await api.materialize(t.name, calcTableSql(get().model(), t.source.dax!));
          set((s) => ({ tables: s.tables.map((x) => (x.name === t.name ? { ...x, ...meta } : x)) }));
        } catch (e: any) { errors.push(`${t.name}: ${e.message.split('\n')[0]}`); }
      }
      for (const t of get().tables.filter((x) => x.calcColumns?.length)) {
        for (const cc of t.calcColumns!) {
          try {
            const cur = get().tables.find((x) => x.name === t.name)!;
            const meta = await api.addCalcColumn(t.name, cc.name, calcColumnSql(get().model(), t.name, cc.expression), cur.columns.some((c) => c.name === cc.name));
            set((s) => ({ tables: s.tables.map((x) => (x.name === t.name ? { ...x, columns: meta.columns, rowCount: meta.rowCount } : x)) }));
          } catch (e: any) { errors.push(`${t.name}[${cc.name}]: ${e.message.split('\n')[0]}`); }
        }
      }
      if (errors.length) get().notify('Calcolo DAX non riuscito — ' + errors.join(' · '), 12000);
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
      // Visualizza come: the role's copies of the tables follow the reloaded data.
      const va = get().viewAs;
      if (va) await get().setViewAs(va);
    },

    openPowerQuery: (focus, extra) => {
      const queries: PQQuery[] = get().tables.filter((t) => !t.source.dax).map((t) => ({ name: t.name, orig: t.name, source: clone(t.source), steps: clone(t.steps ?? []) }));
      // Connection-only queries (functions, helpers) are edited like the others.
      for (const q of get().report.pqQueries ?? []) queries.push({ name: q.name, orig: q.name, source: { path: '', mcode: q.code }, steps: [], load: false });
      const extras = extra ? (Array.isArray(extra) ? extra : [extra]) : [];
      queries.push(...extras);
      const selected = extras[0]?.name ?? focus ?? queries[0]?.name ?? '';
      set({ pq: { queries, selected, step: null, deleted: [], groups: { ...(get().report.pqGroups ?? {}) } }, fileMenu: false });
    },
    pqSet: (fn) => {
      const pq = get().pq;
      if (!pq) return;
      const next = clone(pq);
      fn(next);
      set({ pq: next });
    },
    pqAddStep: (raw) => get().pqSet((st) => {
      const q = st.queries.find((x) => x.name === st.selected);
      if (!q) return;
      const step = { ...raw, id: uid() } as Step;
      const pos = st.step ?? q.steps.length;
      if (pos > 0 && mergeStep(q.steps[pos - 1], step)) {
        if (q.steps[pos - 1].kind === 'renameColumns' && !(q.steps[pos - 1] as any).renames.length) q.steps.splice(pos - 1, 1);
        return;
      }
      q.steps.splice(pos, 0, step);
      st.step = pos + 1 >= q.steps.length ? null : pos + 1;
    }),
    pqNewSource: async (kind) => {
      const path = await api.openDataDialog(kind);
      const pq = get().pq;
      if (!path || !pq) return;
      const taken = [...get().tables, ...pq.queries] as { name: string }[];
      const name = tableNameFor(path, taken as TableMeta[]);
      get().pqSet((st) => { st.queries.push({ name, orig: null, source: { path }, steps: [] }); st.selected = name; st.step = null; });
    },
    dbDialog: false,
    publishDialog: false,
    qnaExplorer: false,
    optionsDialog: false,
    themeDialog: false,
    update: null,
    updateDialog: false,
    updateError: null,
    translationsDialog: false,
    previewCulture: null,
    setSlicer: (id, values) => {
      const page = get().report.pages.find((p) => p.visuals.some((v) => v.id === id));
      if (page && hasApplyAll(page)) get().updateVisual(id, { pendingSlicer: values }, false);
      else get().updateVisual(id, { slicerValues: values, pendingSlicer: undefined });
    },
    applyAllSlicers: (pageId) => get().mut((r) => {
      for (const v of r.pages.find((p) => p.id === pageId)?.visuals ?? []) {
        if (v.pendingSlicer) { v.slicerValues = v.pendingSlicer; delete v.pendingSlicer; }
      }
    }),
    clearAllSlicers: (pageId) => get().mut((r) => {
      for (const v of r.pages.find((p) => p.id === pageId)?.visuals ?? []) {
        if (v.type === 'slicer') { v.slicerValues = []; delete v.pendingSlicer; delete v.slicerRange; delete v.slicerText; delete v.slicerRelative; }
        if (v.jsonFilters) delete v.jsonFilters;
      }
    }),
    loadDbTables: async (c, picks, transform) => {
      const taken = new Set(get().tables.map((t) => t.name));
      const defs = picks.map((p) => {
        let name = p.table, i = 2;
        while (taken.has(name)) name = `${p.table} (${i++})`;
        taken.add(name);
        // a native SQL statement is one query (the navigator shows it as Query1); otherwise schema/table
        return { name, source: { path: '', db: c.query ? { ...c, schema: '', table: p.table } : { ...c, query: undefined, schema: p.schema, table: p.table } } };
      });
      set({ dbDialog: false });
      if (transform) { get().openPowerQuery(undefined, defs.map((d) => ({ ...d, orig: null, steps: [] }))); return; }
      set({ busy: `Caricamento di ${defs.length} ${defs.length === 1 ? 'tabella' : 'tabelle'} dal database…` });
      const failed: string[] = [];
      try {
        for (const d of defs) { try { await loadTable(d); } catch (e: any) { failed.push(`${d.name}: ${e.message.split('\n')[0]}`); } }
        const loaded = defs.map((d) => d.name).filter((n) => get().tables.some((t) => t.name === n));
        if (loaded.length) { const { query: _q, ...conn } = c; api.addRecentSource('db:' + JSON.stringify(conn)).catch(() => {}); }
        const n = loaded.length > 0 && globalOptions().autoRelationships ? await get().detectRelationships(loaded) : 0;
        get().notify([loaded.length === 1 ? 'Caricata 1 tabella.' : `Caricate ${loaded.length} tabelle.`, n ? `Rilevate ${n} relazioni.` : '', failed.length ? `Errori: ${failed.join(' · ')}` : ''].filter(Boolean).join(' '), failed.length ? 12000 : 6000);
      } finally {
        set({ busy: null });
      }
    },
    transformNavigator: () => {
      const nav = get().navigator;
      if (!nav) return;
      set({ navigator: null });
      get().openPowerQuery(undefined, { name: nav.tableName.trim(), orig: null, source: { path: nav.path }, steps: [] });
    },
    pqApply: async () => {
      const pq = get().pq;
      if (!pq) return;
      set({ busy: 'Applicazione delle modifiche alle query…' });
      const failed: string[] = [];
      clearMTemp();
      try {
        // Connection-only queries: stored as M code in the report, never loaded (a loaded query switched off is removed).
        const connOnly = pq.queries.filter((q) => q.load === false);
        const connM = connOnly.map((q) => ({ name: q.name, code: q.source.mcode ?? queryM({ source: q.source, steps: q.steps }, get().tables.find((t) => t.name === q.orig)?.sourceColumns ?? []) }));
        const wasLoaded = connOnly.filter((q) => q.orig && get().tables.some((t) => t.name === q.orig)).map((q) => q.orig!);
        const groups = Object.fromEntries(Object.entries(pq.groups ?? {}).filter(([n, g]) => g && pq.queries.some((q) => q.name === n)));
        get().mut((r) => { if (connM.length) r.pqQueries = connM; else delete r.pqQueries; if (Object.keys(groups).length) r.pqGroups = groups; else delete r.pqGroups; });
        for (const name of [...pq.deleted.filter((n) => get().tables.some((t) => t.name === n)), ...wasLoaded]) await get().removeTable(name);
        const loadable = pq.queries.filter((q) => q.load !== false);
        const before = get().tables;
        const key = (q: QueryDef) => JSON.stringify([q.source, q.steps ?? []]);
        const changed = new Set(loadable.filter((q) => {
          const t = before.find((x) => x.name === q.orig);
          return !t || q.orig !== q.name || key(t) !== key(q);
        }).map((q) => q.name));
        // References are inlined in the SQL, so dependents of a changed query reload too.
        for (let grew = true; grew;) {
          grew = false;
          for (const q of loadable) {
            if (!changed.has(q.name) && dependencies(q).some((d) => changed.has(d))) { changed.add(q.name); grew = true; }
          }
        }
        for (const q of loadable) {
          if (!q.orig || q.orig === q.name) continue;
          await api.dropTable(q.orig);
          const from = q.orig;
          get().mut((r) => renameTableInReport(r, from, q.name));
          set((s) => ({
            tables: s.tables.map((t) => (t.name === from ? { ...t, name: q.name } : t)),
            dataViewTable: s.dataViewTable === from ? q.name : s.dataViewTable,
          }));
        }
        // M queries reach connection-only queries by name, so a change there reloads the M queries that use them.
        for (const q of loadable) if (q.source.mcode !== undefined && dependencies(q).some((d) => connOnly.some((c) => c.name === d))) changed.add(q.name);
        for (const q of loadable) {
          if (!changed.has(q.name)) continue;
          try { await loadTable({ name: q.name, source: q.source, steps: q.steps }, loadable, connM); } catch (e: any) { failed.push(`${q.name}: ${e.message}`); }
        }
        const order = loadable.map((q) => q.name);
        const pos = (n: string) => (order.includes(n) ? order.indexOf(n) : order.length);
        set((s) => ({ tables: [...s.tables].sort((a, b) => pos(a.name) - pos(b.name)), dataVersion: s.dataVersion + 1 }));
        await get().finalizeModel();
        if (failed.length) { get().notify('Caricamento non riuscito — ' + failed.join(' · '), 15000); return; }
        set({ pq: null });
        const fresh = pq.queries.filter((q) => !q.orig).map((q) => q.name);
        if (fresh.length && globalOptions().autoRelationships) {
          const n = await get().detectRelationships(fresh);
          if (n) get().notify(`Rilevate automaticamente ${n} ${n === 1 ? 'relazione' : 'relazioni'}. Verificarle nella vista modello.`);
        }
      } catch (e: any) {
        get().notify('Applicazione non riuscita: ' + e.message, 12000);
      } finally {
        set({ busy: null });
      }
    },

    saveRelationship: (rel) => get().mut((r) => {
      const i = r.relationships.findIndex((x) => x.id === rel.id);
      if (i >= 0) r.relationships[i] = rel; else r.relationships.push(rel);
    }),
    deleteRelationship: (id) => {
      get().mut((r) => { r.relationships = r.relationships.filter((x) => x.id !== id); });
      if (get().selectedRelId === id) set({ selectedRelId: null });
    },
    // Power BI-style autodetect: same column name (case-insensitive), compatible type,
    // unique values on exactly one side (→ *:1) or both (→ 1:1). Ambiguous paths stay inactive.
    detectRelationships: async (only) => {
      const tables = get().tables;
      const found: Relationship[] = [];
      const rels = () => [...get().report.relationships, ...found];
      const related = (a: string, b: string) => rels().some((x) => (x.fromTable === a && x.toTable === b) || (x.fromTable === b && x.toTable === a));
      for (let i = 0; i < tables.length; i++) {
        for (let j = i + 1; j < tables.length; j++) {
          const a = tables[i], b = tables[j];
          if (only && !only.includes(a.name) && !only.includes(b.name)) continue;
          if (related(a.name, b.name)) continue;
          for (const ca of a.columns) {
            const cb = b.columns.find((c) => c.name.toLowerCase() === ca.name.toLowerCase());
            if (!cb || isNumeric(ca) !== isNumeric(cb) || related(a.name, b.name)) continue;
            const [ua, ub] = await Promise.all([isUnique(a.name, ca.name), isUnique(b.name, cb.name)]);
            if (!ua && !ub) continue;
            const [m, mc, o, oc] = ub ? [a.name, ca.name, b.name, cb.name] : [b.name, cb.name, a.name, ca.name];
            found.push({
              id: uid(), fromTable: m, fromColumn: mc, toTable: o, toColumn: oc,
              cardinality: ua && ub ? 'oneToOne' : 'manyToOne', crossFilter: ua && ub ? 'both' : 'single',
              active: !connected(rels(), m, o),
            });
          }
        }
      }
      if (found.length) get().mut((r) => r.relationships.push(...found));
      return found.length;
    },
    setModelPos: (table, pos) => get().mut((r) => { r.modelLayout[table] = pos; }),

    set: (p) => set(p),

    mut: (fn) => {
      const prev = clone(get().report);
      const next = clone(prev);
      fn(next);
      propagateSync(prev, next);
      set((s) => ({ report: next, past: [...s.past.slice(-49), prev], future: [], dirty: true }));
    },
    undo: () => {
      const { past, report, future } = get();
      if (!past.length) return;
      const prev = past[past.length - 1];
      set({ report: prev, past: past.slice(0, -1), future: [report, ...future], dirty: true });
      if (!prev.pages.some((p) => p.id === get().activePageId)) set({ activePageId: prev.pages[0].id });
    },
    redo: () => {
      const { past, report, future } = get();
      if (!future.length) return;
      set({ report: future[0], future: future.slice(1), past: [...past, report], dirty: true });
    },
    notify: (msg, ms = 6000) => {
      set({ toast: msg });
      setTimeout(() => get().toast === msg && set({ toast: null }), ms);
    },

    page: () => get().report.pages.find((p) => p.id === get().activePageId) ?? get().report.pages[0],
    setView: (view) => set({ view, fileMenu: false }),
    setActivePage: (id) => set({ activePageId: id, selectedVisualId: null, crossFilter: null }),
    addPage: () => {
      const p = newPage(get().report.pages.length + 1);
      while (get().report.pages.some((x) => x.name === p.name)) p.name += '+';
      get().mut((r) => r.pages.push(p));
      set({ activePageId: p.id, selectedVisualId: null, crossFilter: null });
    },
    renamePage: (id, name) => get().mut((r) => { const p = r.pages.find((x) => x.id === id); if (p && name.trim()) p.name = name.trim(); }),
    deletePage: (id) => {
      const pages = get().report.pages;
      if (pages.length <= 1) return;
      const idx = pages.findIndex((p) => p.id === id);
      get().mut((r) => { r.pages = r.pages.filter((p) => p.id !== id); });
      if (get().activePageId === id) set({ activePageId: get().report.pages[Math.max(0, idx - 1)].id });
    },
    duplicatePage: (id) => {
      const src = get().report.pages.find((p) => p.id === id);
      if (!src) return;
      const copy: Page = { ...clone(src), id: uid(), name: `Duplicato di ${src.name}` };
      copy.visuals.forEach((v) => (v.id = uid()));
      get().mut((r) => r.pages.splice(r.pages.findIndex((p) => p.id === id) + 1, 0, copy));
      set({ activePageId: copy.id });
    },

    setVisualHidden: (id, hidden) => get().mut((r) => { const v = findVisual(r, id); if (v) v.hidden = hidden || undefined; }),
    setGroupHidden: (groupId, hidden) => get().mut((r) => { for (const p of r.pages) { const g = p.groups?.find((x) => x.id === groupId); if (g) g.hidden = hidden || undefined; } }),
    groupVisuals: (ids) => {
      if (ids.length < 2) return;
      get().mut((r) => {
        const p = r.pages.find((x) => x.visuals.some((v) => v.id === ids[0]));
        if (!p) return;
        const g = { id: uid(), name: `Gruppo ${(p.groups?.length ?? 0) + 1}` };
        (p.groups ??= []).push(g);
        for (const v of p.visuals) if (ids.includes(v.id)) v.group = g.id;
      });
      set({ multiSel: [] });
    },
    ungroup: (groupId) => get().mut((r) => {
      for (const p of r.pages) {
        const g = p.groups?.find((x) => x.id === groupId);
        if (!g) continue;
        for (const v of p.visuals) if (v.group === groupId) v.group = g.parent;
        for (const x of p.groups!) if (x.parent === groupId) x.parent = g.parent;
        p.groups = p.groups!.filter((x) => x.id !== groupId);
      }
    }),
    renameGroup: (groupId, name) => get().mut((r) => { for (const p of r.pages) { const g = p.groups?.find((x) => x.id === groupId); if (g) g.name = name; } }),
    moveLayer: (id, dir) => get().mut((r) => {
      const p = r.pages.find((x) => x.visuals.some((v) => v.id === id));
      if (!p) return;
      const order = [...p.visuals].sort((a, b) => a.z - b.z);
      const i = order.findIndex((v) => v.id === id), j = i + dir;
      if (j < 0 || j >= order.length) return;
      [order[i], order[j]] = [order[j], order[i]];
      order.forEach((v, k) => (v.z = k + 1));
    }),
    createParameter: async (p) => {
      const name = p.name.trim();
      if (!name) throw new Error('Indicare un nome.');
      if (get().tables.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new Error(`Esiste già una tabella denominata "${name}".`);
      const q = (s: string) => s.replace(/"/g, '""');
      let expr: string;
      if (p.kind === 'numeric') {
        if (!(p.step > 0) || p.max < p.min) throw new Error('Intervallo non valido: minimo ≤ massimo e incremento > 0.');
        if ((p.max - p.min) / p.step > 100000) throw new Error('Troppi valori: aumentare l\'incremento.');
        expr = `SELECTCOLUMNS(GENERATESERIES(${p.min}, ${p.max}, ${p.step}), "${q(name)}", [Value])`;
      } else {
        if (!p.fields.length) throw new Error('Aggiungere almeno un campo.');
        const ref = (f: import('./types').ParamField) => (f.measure ? `[${f.column}]` : `'${f.table.replace(/'/g, "''")}'[${f.column}]`);
        expr = `SELECTCOLUMNS({ ${p.fields.map((f, i) => `("${q(f.label)}", NAMEOF(${ref(f)}), ${i})`).join(', ')} }, "${q(name)}", [Value1], "${q(name)} Campi", [Value2], "${q(name)} Ordine", [Value3])`;
      }
      const meta = await api.materialize(name, calcTableSql(get().model(), expr));
      const t: TableMeta = { ...meta, source: { path: '', dax: expr }, ...(p.kind === 'fields' ? { fieldParam: { column: name, fields: p.fields }, sortBy: { [name]: `${name} Ordine` } } : {}) };
      set((s) => ({ tables: [...s.tables, t], dirty: true }));
      get().mut((r) => {
        if (p.kind === 'numeric') r.measures.push({ table: name, name: `${name} Valore`, expression: `SELECTEDVALUE('${name.replace(/'/g, "''")}'[${name}], ${p.def})` });
        if (!p.slicer) return;
        const page = r.pages.find((x) => x.id === get().activePageId)!;
        const z = Math.max(0, ...page.visuals.map((v) => v.z)) + 1;
        page.visuals.push({
          id: uid(), type: 'slicer', x: 20, y: 20, w: 240, h: p.kind === 'numeric' ? 90 : 200, z,
          fields: { category: [{ table: name, column: name, agg: 'none' }] },
          format: { ...defaultFormat('slicer'), slicerStyle: p.kind === 'numeric' ? 'slider' : 'list' },
          ...(p.kind === 'numeric' ? { slicerValues: [String(p.def)] } : {}),
        });
      });
      set((s) => ({ dataVersion: s.dataVersion + 1 }));
    },
    drillThrough: (pageId, values) => {
      const source = get().page();
      get().mut((r) => {
        const p = r.pages.find((x) => x.id === pageId);
        if (!p?.drillthrough) return;
        const fields = p.drillthrough.fields;
        const own = values.filter((x) => fields.some((f) => f.table === x.table && f.column === x.column && f.datePart === x.datePart));
        p.filters = [
          ...p.filters.filter((f) => !f.drillthrough),
          // "Mantieni tutti i filtri": the source page filters come along too.
          ...(p.drillthrough.keepAll ? source.filters.filter((f) => f.values.length && !f.drillthrough).map((f) => ({ ...clone(f), id: uid(), drillthrough: true })) : []),
          ...own.map((x) => ({ id: uid(), table: x.table, column: x.column, values: [x.value === null ? NULL_KEY : x.value], drillthrough: true, ...(x.datePart ? { datePart: x.datePart } : {}) })),
        ];
      });
      set({ activePageId: pageId, selectedVisualId: null, crossFilter: null });
    },
    addBookmark: () => {
      const id = uid();
      get().mut((r) => {
        const n = (r.bookmarks?.length ?? 0) + 1;
        (r.bookmarks ??= []).push({ id, name: `Segnalibro ${n}`, applyData: true, applyDisplay: true, applyPage: true, page: get().activePageId, state: { hidden: [], hiddenGroups: [] } });
      });
      get().updateBookmark(id);
    },
    // Captures the current state of the bookmark's page (the active page) into it.
    updateBookmark: (id) => get().mut((r) => {
      const b = r.bookmarks?.find((x) => x.id === id);
      const p = r.pages.find((x) => x.id === get().activePageId);
      if (!b || !p) return;
      b.page = p.id;
      const scope = p.visuals.filter((v) => !b.targets || b.targets.includes(v.id));
      b.state = {
        hidden: scope.filter((v) => v.hidden).map((v) => v.id),
        hiddenGroups: (p.groups ?? []).filter((g) => g.hidden).map((g) => g.id),
        reportFilters: clone(r.reportFilters),
        pageFilters: clone(p.filters),
        slicers: Object.fromEntries(scope.filter((v) => v.type === 'slicer').map((v) => [v.id, [...(v.slicerValues ?? [])]])),
        slicerState: Object.fromEntries(scope.filter((v) => v.type === 'slicer' && (v.slicerRange || v.slicerText || v.slicerRelative))
          .map((v) => [v.id, { ...(v.slicerRange ? { range: { ...v.slicerRange } } : {}), ...(v.slicerText ? { text: v.slicerText } : {}), ...(v.slicerRelative ? { relative: { ...v.slicerRelative } } : {}) }])),
      };
    }),
    applyBookmark: (id) => {
      const b = get().report.bookmarks?.find((x) => x.id === id);
      if (!b) return;
      const target = b.applyPage && b.page && get().report.pages.some((p) => p.id === b.page) ? b.page : get().activePageId;
      get().mut((r) => {
        const p = r.pages.find((x) => x.id === target);
        if (!p) return;
        const scope = p.visuals.filter((v) => !b.targets || b.targets.includes(v.id));
        if (b.applyDisplay) {
          for (const v of scope) v.hidden = b.state.hidden.includes(v.id) || undefined;
          if (!b.targets) for (const g of p.groups ?? []) g.hidden = b.state.hiddenGroups.includes(g.id) || undefined;
        }
        if (b.applyData) {
          if (!b.targets && b.state.reportFilters) r.reportFilters = clone(b.state.reportFilters);
          if (!b.targets && b.state.pageFilters && p.id === b.page) p.filters = clone(b.state.pageFilters);
          for (const v of scope) if (v.type === 'slicer' && b.state.slicers?.[v.id]) {
            v.slicerValues = [...b.state.slicers[v.id]]; delete v.pendingSlicer;
            const st = b.state.slicerState?.[v.id];
            if (st?.range) v.slicerRange = { ...st.range }; else delete v.slicerRange;
            if (st?.text) v.slicerText = st.text; else delete v.slicerText;
            if (st?.relative) v.slicerRelative = { ...st.relative }; else delete v.slicerRelative;
          }
        }
      });
      set({ activePageId: target, selectedVisualId: null, ...(b.applyData ? { crossFilter: null } : {}) });
    },
    setBookmark: (id, patch) => get().mut((r) => { const b = r.bookmarks?.find((x) => x.id === id); if (b) Object.assign(b, patch); }),
    removeBookmark: (id) => get().mut((r) => { r.bookmarks = r.bookmarks?.filter((x) => x.id !== id); }),
    moveBookmark: (id, dir) => get().mut((r) => {
      const list = r.bookmarks ?? [];
      const i = list.findIndex((x) => x.id === id), j = i + dir;
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
    }),
    importCustomVisual: async () => {
      try {
        const pkg = await api.importPbiviz();
        if (!pkg) return;
        get().mut((r) => { r.customVisuals = [...(r.customVisuals ?? []).filter((p) => p.guid !== pkg.guid), pkg]; });
        get().notify(`Oggetto visivo «${customName(pkg)}» importato: si trova nel riquadro Visualizzazioni.`);
      } catch (e: any) {
        get().notify('Importazione non riuscita: ' + e.message, 10000);
      }
    },
    removeCustomVisual: (guid) => {
      const used = get().report.pages.some((p) => p.visuals.some((v) => v.custom === guid));
      if (used) { get().notify("L'oggetto visivo è usato nel report: eliminare prima gli oggetti visivi che lo usano."); return; }
      get().mut((r) => { r.customVisuals = r.customVisuals?.filter((p) => p.guid !== guid); });
    },
    addVisual: (type, at, custom) => {
      const id = uid();
      const page = get().page();
      const size = defaultSize(type);
      const pos = at ? { ...at, ...size } : nextPosition(page, size.w, size.h);
      const z = Math.max(0, ...page.visuals.map((v) => v.z)) + 1;
      get().mut((r) => {
        r.pages.find((p) => p.id === page.id)!.visuals.push({ id, type, ...pos, z, fields: {}, format: defaultFormat(type), text: type === 'textbox' ? '' : undefined, ...(custom ? { custom } : {}) });
      });
      set({ selectedVisualId: id, vizTab: 'build' });
      return id;
    },
    updateVisual: (id, patch, commit = true) => {
      if (commit) get().mut((r) => Object.assign(findVisual(r, id)!, patch));
      else {
        const r = clone(get().report);
        Object.assign(findVisual(r, id)!, patch);
        propagateSync(get().report, r);
        set({ report: r, dirty: true });
      }
    },
    updateFormat: (id, patch) => get().mut((r) => { const v = findVisual(r, id); if (v) v.format = { ...v.format, ...patch }; }),
    removeVisual: (id) => {
      get().mut((r) => r.pages.forEach((p) => {
        p.visuals = p.visuals.filter((v) => v.id !== id);
        if (p.interactions) for (const k of Object.keys(p.interactions)) if (k.split('>').includes(id)) delete p.interactions[k];
      }));
      set((s) => ({ selectedVisualId: s.selectedVisualId === id ? null : s.selectedVisualId, crossFilter: s.crossFilter?.visualId === id ? null : s.crossFilter }));
    },
    duplicateVisual: (id) => {
      const nid = uid();
      get().mut((r) => {
        for (const p of r.pages) {
          const v = p.visuals.find((x) => x.id === id);
          if (v) p.visuals.push({ ...clone(v), id: nid, x: v.x + 20, y: v.y + 20, z: Math.max(...p.visuals.map((q) => q.z)) + 1 });
        }
      });
      set({ selectedVisualId: nid });
    },
    changeVisualType: (id, type, custom) => get().mut((r) => {
      const v = findVisual(r, id);
      if (!v || (v.type === type && v.custom === custom)) return;
      const all = Object.values(v.fields).flat();
      v.type = type;
      if (custom) v.custom = custom; else delete v.custom;
      delete v.jsonFilters;
      v.fields = {};
      v.format = { ...defaultFormat(type), titleText: v.format.titleText, background: v.format.background, border: v.format.border };
      implicitBlocked = false;
      for (const f of all.filter((x) => x.agg !== 'visualCalc')) placeField(v, { table: f.table, column: f.column, measure: f.agg === 'measure' });
      // Visual calculations follow into the first value well of the new type.
      const calcs = all.filter((x) => x.agg === 'visualCalc');
      const vw = visualDef(type, custom).wells.find((w) => w.measure && w.key !== 'target')?.key ?? (type === 'table' ? 'columns' : undefined);
      if (calcs.length && vw) (v.fields[vw] ??= []).push(...calcs);
      if (implicitBlocked) setTimeout(() => get().notify('Il modello ha gruppi di calcolo: le colonne numeriche non vengono aggregate e sono state tolte dai valori. Usare misure esplicite.', 9000));
    }),
    addField: (visualId, field, well, at) => {
      let id = visualId;
      if (!id) {
        // Like Power BI: a geographic column (data category) dropped on the canvas makes a map.
        const geo = !field.measure && /^(Address|Place|City|County|StateOrProvince|PostalCode|Country|Continent|Latitude|Longitude)$/.test(get().tables.find((t) => t.name === field.table)?.dataCategory?.[field.column] ?? '');
        // With calculation groups numeric columns are not summarized: a table shows them (like Power BI).
        const type: VisualType = field.measure ? 'card' : geo ? 'map' : isNumeric(columnOf(field)) && !get().report.calcGroups?.length ? 'clusteredColumn' : 'table';
        id = get().addVisual(type, at);
        // Fold into the creation step so a single undo removes the new visual.
        const past = get().past;
        get().mut((r) => placeField(findVisual(r, id!)!, field, well));
        set({ past: past });
        return;
      }
      implicitBlocked = false;
      get().mut((r) => { const v = findVisual(r, id!); if (v) placeField(v, field, well); });
      if (implicitBlocked) get().notify('Il modello ha gruppi di calcolo: le colonne non vengono aggregate (misure implicite disattivate). Creare una misura esplicita, es. Totale = SUM(…).', 9000);
    },
    removeField: (visualId, well, idx) => get().mut((r) => { const v = findVisual(r, visualId); v?.fields[well]?.splice(idx, 1); }),
    toggleFieldHidden: (visualId, well, idx) => get().mut((r) => {
      const f = findVisual(r, visualId)?.fields[well]?.[idx];
      if (f) { if (f.hidden) delete f.hidden; else f.hidden = true; }
    }),
    setFieldTotal: (visualId, well, idx, total) => get().mut((r) => {
      const f = findVisual(r, visualId)?.fields[well]?.[idx];
      if (f) { if (total) f.total = total; else delete f.total; }
    }),
    calcEdit: null,
    startVisualCalc: (visualId, original, template) => {
      const v = get().report.pages.flatMap((p) => p.visuals).find((x) => x.id === visualId);
      if (!v) return;
      const fields = Object.values(v.fields).flat();
      const f = original ? fields.find((x) => x.agg === 'visualCalc' && x.column === original) : undefined;
      const first = fields.find((x) => x.agg !== 'none' && x.agg !== 'visualCalc');
      const taken = (n: string) => fields.some((x) => refLabel(x).toLowerCase() === n.toLowerCase() && x.column !== original);
      let name = template?.name ?? 'Calcolo', i = 2;
      const base = name;
      while (!f && taken(name)) name = `${base} ${i++}`;
      const body = template ? template.text.split('{f}').join(first ? refLabel(first) : 'Valore') : '';
      set({ calcEdit: { visualId, original: original ?? null, text: f ? `${f.column} = ${daxShow(f.calc ?? '')}` : `${name} = ${daxShow(body)}`, format: f ? f.format : template?.format }, focusId: null, selectedVisualId: visualId, view: 'report' });
    },
    saveVisualCalc: () => {
      const ed = get().calcEdit;
      if (!ed) return false;
      const fail = (error: string) => { set({ calcEdit: { ...ed, error } }); return false; };
      const parts = splitDax(daxStore(ed.text));
      if (!parts) return fail('Sintassi: Nome = espressione');
      if (!parts.expr) return fail("Manca l'espressione dopo =");
      try { parse(parts.expr); } catch (e: any) { return fail(e.message); }
      const v = get().report.pages.flatMap((p) => p.visuals).find((x) => x.id === ed.visualId);
      if (!v) return fail('Oggetto visivo non trovato.');
      const fields = Object.values(v.fields).flat();
      if (fields.some((x) => refLabel(x).toLowerCase() === parts.name.toLowerCase() && !(x.agg === 'visualCalc' && x.column === ed.original))) return fail(`L'oggetto visivo contiene già un campo denominato "${parts.name}".`);
      // References: fields of the visual (as named in the wells) and its other calculations, never itself.
      const names = new Set(fields.flatMap((x) => [refLabel(x).toLowerCase(), x.column.toLowerCase()]));
      for (const m of parts.expr.matchAll(/(?<!['\w\]])\[((?:[^\]]|\]\])+)\]/g)) {
        const n = m[1].replace(/\]\]/g, ']').toLowerCase();
        if (n === parts.name.toLowerCase()) return fail('Un calcolo visivo non può fare riferimento a se stesso.');
        if (!names.has(n)) return fail(`Campo non presente nell'oggetto visivo: [${m[1]}]. Aggiungere prima il campo all'oggetto visivo.`);
      }
      const calc: FieldRef = { table: '', column: parts.name, agg: 'visualCalc', calc: parts.expr, ...(ed.format ? { format: ed.format } : {}) };
      const def = visualDef(v.type, v.custom);
      const well = def.wells.find((w) => w.measure && (!w.max || (v.fields[w.key]?.length ?? 0) < w.max) && w.key !== 'target')?.key ?? (v.type === 'table' ? 'columns' : def.wells.find((w) => w.measure)?.key);
      if (!well) return fail('Questo oggetto visivo non supporta i calcoli visivi.');
      get().mut((r) => {
        const vv = findVisual(r, ed.visualId)!;
        for (const list of Object.values(vv.fields)) {
          const i = list.findIndex((x) => x.agg === 'visualCalc' && x.column === ed.original);
          if (i >= 0) { list[i] = { ...calc, ...(list[i].hidden ? { hidden: true } : {}) }; return; }
        }
        (vv.fields[well] ??= []).push(calc);
      });
      // A renamed calculation: references in the other calculations follow.
      if (ed.original && ed.original !== parts.name) {
        const from = ed.original;
        get().mut((r) => {
          const vv = findVisual(r, ed.visualId)!;
          for (const x of Object.values(vv.fields).flat()) if (x.agg === 'visualCalc' && x.calc) x.calc = x.calc.replace(new RegExp(`\\[${reEscape(from)}\\]`, 'gi'), `[${parts.name}]`);
        });
      }
      set({ calcEdit: { visualId: ed.visualId, original: parts.name, text: `${parts.name} = ${daxShow(parts.expr)}`, format: ed.format } });
      return true;
    },
    setFieldAgg: (visualId, well, idx, agg) => get().mut((r) => { const f = findVisual(r, visualId)?.fields[well]?.[idx]; if (f) f.agg = agg; }),
    setColumnProps: (table, column, p) => {
      set((s) => ({
        dirty: true, dataVersion: s.dataVersion + 1,
        tables: s.tables.map((t) => {
          if (t.name !== table) return t;
          const next = { ...t };
          for (const k of ['dataCategory', 'sortBy'] as const) {
            if (p[k] === undefined) continue;
            const m = { ...(t[k] ?? {}) };
            if (p[k]) m[column] = p[k]!; else delete m[column];
            if (Object.keys(m).length) next[k] = m; else delete next[k];
          }
          return next;
        }),
      }));
    },
    setDateHierarchy: (visualId, well, idx, on) => get().mut((r) => {
      const v = findVisual(r, visualId);
      const list = v?.fields[well];
      const f = list?.[idx];
      if (!v || !list || !f) return;
      const same = (x: FieldRef) => x.table === f.table && x.column === f.column && x.agg === 'none';
      const first = list.findIndex(same);
      const rest = list.filter((x) => !same(x));
      const base = { table: f.table, column: f.column, agg: 'none' as const };
      const repl: FieldRef[] = on ? (['year', 'quarter', 'month', 'day'] as const).map((datePart) => ({ ...base, datePart })) : [base];
      rest.splice(Math.min(first, rest.length), 0, ...repl);
      v.fields[well] = rest;
      delete v.drill;
    }),
    selectVisual: (id) => set({ selectedVisualId: id }),
    setCross: (c) => set({ crossFilter: c }),

    addFilter: (scope, field) => get().mut((r) => {
      const list = filterList(r, scope);
      if (list && !list.some((f) => f.table === field.table && f.column === field.column)) list.push({ id: uid(), ...field, values: [] });
    }),
    // `field` materialises the implicit per-field filter cards of a visual on first edit.
    updateFilter: (scope, id, values, field) => get().mut((r) => {
      const list = filterList(r, scope);
      if (!list) return;
      const f = list.find((x) => x.id === id);
      if (f) f.values = values;
      else if (field) list.push({ id, ...field, values });
    }),
    removeFilter: (scope, id) => get().mut((r) => {
      const list = filterList(r, scope);
      if (list) list.splice(0, list.length, ...list.filter((f) => f.id !== id));
    }),

    openNavigator: async (kind, chosen) => {
      set({ fileMenu: false });
      const path = chosen ?? await api.openDataDialog(kind);
      if (!path) return;
      set({ navigator: { path, tableName: tableNameFor(path, get().tables), preview: null, loading: true } });
      try {
        const preview = await api.preview(path);
        set((s) => ({ navigator: s.navigator && { ...s.navigator, preview, loading: false } }));
      } catch (e: any) {
        set((s) => ({ navigator: s.navigator && { ...s.navigator, error: e.message, loading: false } }));
      }
    },
    loadNavigator: async () => {
      const nav = get().navigator;
      if (!nav) return;
      set({ navigator: { ...nav, loading: true }, busy: 'Caricamento dei dati…' });
      try {
        await importTable(nav.path, nav.tableName);
        set({ navigator: null });
        api.addRecentSource(nav.path).catch(() => {});
        const n = globalOptions().autoRelationships ? await get().detectRelationships([nav.tableName]) : 0;
        if (n) get().notify(`Rilevate automaticamente ${n} ${n === 1 ? 'relazione' : 'relazioni'}. Verificarle nella vista modello.`);
      } catch (e: any) {
        set({ navigator: { ...nav, loading: false, error: e.message } });
      } finally {
        set({ busy: null });
      }
    },
    loadSample: async () => {
      set({ busy: 'Caricamento dei dati di esempio…', fileMenu: false });
      try {
        const p = await api.sampleData();
        await importTable(p.financials, 'financials');
        await importTable(p.products, 'products');
        await importTable(p.countries, 'countries');
        await get().detectRelationships(['financials', 'products', 'countries']);
      } catch (e: any) {
        get().notify('Errore: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },
    removeTable: async (name) => {
      await api.dropTable(name);
      get().mut((r) => {
        r.relationships = r.relationships.filter((x) => x.fromTable !== name && x.toTable !== name);
        delete r.modelLayout[name];
        if (r.hierarchies) r.hierarchies = r.hierarchies.filter((h) => h.table !== name);
        if (r.calcGroups) r.calcGroups = r.calcGroups.filter((g) => g.table !== name);
        if (r.dateTables) delete r.dateTables[name];
        if (r.calendars) r.calendars = r.calendars.filter((c) => c.table !== name);
        for (const k of Object.keys(r.displayFolders ?? {})) if (k.startsWith(name + '\u0001')) delete r.displayFolders![k];
        for (const role of r.roles ?? []) role.filters = role.filters.filter((f) => f.table !== name);
      });
      set((s) => ({ tables: s.tables.filter((t) => t.name !== name), dataVersion: s.dataVersion + 1, dataViewTable: s.dataViewTable === name ? null : s.dataViewTable, dirty: true }));
    },
    refresh: async () => {
      set({ busy: 'Aggiornamento in corso…' });
      try {
        await api.clearRemoteCache(); // Web/OData sources are downloaded again
        for (const t of get().tables) if (!t.source.dax) await loadTable(t);
        await get().finalizeModel();
      } catch (e: any) {
        get().notify('Aggiornamento non riuscito: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },

    newReport: async () => {
      if (get().viewAs) { await api.setRole(null); set({ viewAs: null }); }
      for (const t of get().tables) await api.dropTable(t.name);
      const r = emptyReport();
      set({ sourceName: null, tables: [], report: r, activePageId: r.pages[0].id, selectedVisualId: null, crossFilter: null, filePath: null, dirty: false, past: [], future: [], fileMenu: false, view: 'report', dataViewTable: null, dataVersion: get().dataVersion + 1 });
    },
    save: async (as = false) => {
      const { tables, report, filePath, sourceName } = get();
      // Power BI files stay Power BI files: a .pbix saved by MiB-BI is rewritten in place, an imported .pbix is
      // saved through the dialog (same name suggested) so the original is never replaced without asking.
      if (/\.pbix$/i.test(filePath ?? '')) return get().exportPbix(as ? undefined : filePath!);
      if (!filePath && /\.pbix$/i.test(sourceName ?? '')) return get().exportPbix();
      // Version 2: data embedded as Parquet (like a .pbix), sources and steps kept for refresh.
      const content = JSON.stringify({
        format: 'mibx', version: 2,
        tables: tables.map((t, i) => ({ name: t.name, source: t.source, steps: t.steps, sourceColumns: t.sourceColumns, sortBy: t.sortBy, ...(t.dataCategory ? { dataCategory: t.dataCategory } : {}), calcColumns: t.calcColumns, ...(t.fieldParam ? { fieldParam: t.fieldParam } : {}), data: `data/${i}.parquet` })),
        report,
      }, (k, v) => (k === 'pendingSlicer' ? undefined : v), 2); // unapplied slicer selections are not saved
      set({ busy: 'Salvataggio…' });
      try {
        const p = await api.saveFile(content, as ? null : filePath, tables.map((t, i) => ({ table: t.name, file: `data/${i}.parquet` })));
        if (p) set({ filePath: p, dirty: false, fileMenu: false });
      } catch (e: any) {
        get().notify('Salvataggio non riuscito: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },
    open: async (file) => {
      const f = file ? await api.openAt(file).catch((e) => { get().notify('Apertura non riuscita: ' + e.message); return null; }) : await api.openFile();
      if (!f) return;
      if (f.powerbi) return get().importPowerBI(f.path);
      try {
        const doc = JSON.parse(f.content!);
        if (doc.format !== 'mibx') throw new Error('file non valido');
        await get().newReport();
        set({ busy: 'Apertura del report…' });
        const failed: string[] = [];
        const defs = doc.tables as (QueryDef & { sortBy?: Record<string, string>; dataCategory?: Record<string, string>; calcColumns?: TableMeta['calcColumns']; sourceColumns?: TableMeta['sourceColumns']; fieldParam?: TableMeta['fieldParam']; data?: string })[];
        for (const t of defs) {
          if (f.dataDir && t.data) {
            // Embedded data: no access to the original sources needed (Aggiorna reloads from them).
            try {
              const meta = await api.materialize(t.name, `SELECT * FROM read_parquet(${ql(`${f.dataDir}/${t.data}`)})`);
              const { data: _d, ...def } = t;
              set((st) => ({ tables: [...st.tables, { ...meta, ...def } as TableMeta], dataVersion: st.dataVersion + 1 }));
              continue;
            } catch { /* fall back to the sources */ }
          }
          if (t.source.dax) { set((st) => ({ tables: [...st.tables, { name: t.name, rowCount: 0, columns: [], source: t.source, calcColumns: t.calcColumns, ...(t.sortBy ? { sortBy: t.sortBy } : {}), ...(t.dataCategory ? { dataCategory: t.dataCategory } : {}), ...(t.fieldParam ? { fieldParam: t.fieldParam } : {}) }] })); continue; }
          try { await loadTable(t, defs); } catch { failed.push(t.name); }
        }
        doc.report.relationships ??= [];
        doc.report.modelLayout ??= {};
        doc.report.measures ??= [];
        set({ report: doc.report, activePageId: doc.report.pages[0].id, filePath: f.path, dirty: false, past: [], future: [] });
        await get().finalizeModel();
        set({ dirty: false });
        if (failed.length) get().notify(`Impossibile ricaricare: ${failed.join(', ')}. Verificare il percorso dell'origine dati.`);
      } catch (e: any) {
        get().notify('Apertura non riuscita: ' + e.message);
      } finally {
        set({ busy: null });
      }
    },
  };
});

// Charts and backgrounds read the theme from shared state: keep it in sync with the report.
/** Before writing Power BI files: visible range of fields with default icons (thresholds become numbers). */
export async function prepareCfExport() {
  const ranges = new Map<string, Map<string, { min: number; max: number }>>();
  for (const p of useStore.getState().report.pages) for (const v of p.visuals) {
    const keys = Object.entries(v.format.cf ?? {}).filter(([, c]) => c.icons && !c.iconRules?.length);
    if (!keys.length) continue;
    try {
      const { items, rows } = await runVisualQuery(v);
      const m = new Map<string, { min: number; max: number }>();
      for (const [key, c] of keys) {
        const drv = c.input ? items.find((i) => i.well === CF_WELL && fieldKey(i.field) === fieldKey(cfInput(c.input!))) : items.find((i) => fieldKey(i.field) === key);
        const r = drv ? rangeOf(rows.map((x) => x[drv.alias])) : null;
        if (r) m.set(key, r);
      }
      ranges.set(v.id, m);
    } catch { /* visual with errors: icons exported without thresholds */ }
  }
  setCfExportRanges(ranges);
}

useStore.subscribe((s, prev) => { if (s.report.theme !== prev.report.theme) applyTheme(s.report.theme); });
useStore.subscribe((s, prev) => {
  if (s.report.cultures === prev.report.cultures && s.previewCulture === prev.previewCulture) return;
  setCaptions(s.previewCulture ? s.report.cultures?.find((c) => c.name === s.previewCulture)?.captions : undefined);
  // Visuals re-render with the translated titles, axes and headers.
  if (s.previewCulture !== prev.previewCulture) s.set({ dataVersion: s.dataVersion + 1 });
});
useStore.subscribe((s, prev) => { if (s.report.customVisuals !== prev.report.customVisuals) setCustomVisuals(s.report.customVisuals); });
// Calculation group tables follow their items (also after undo/redo).
useStore.subscribe((s, prev) => { if (s.report.calcGroups !== prev.report.calcGroups) void s.syncCalcTables(); });

// File passed on the command line (or opened from the file manager).
api.onOpenArg((file) => useStore.getState().open(file));

// Power Query parameters used by source/filter resolution.
setParams(useStore.getState().report.pqParams);
useStore.subscribe((st, prev) => { if (st.report.pqParams !== prev.report.pqParams) setParams(st.report.pqParams); });
