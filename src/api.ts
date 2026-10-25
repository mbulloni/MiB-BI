import type { QueryResult, ColumnMeta, TableMeta, DbConnection, CustomVisualPkg } from './types';
import type { PbitPart } from './pbix/pbit';

/** Output of electron/pbix/read_pbix.py */
export interface PowerBIModel {
  file: string;
  kind: 'pbix' | 'pbit' | 'pbip' | 'live';
  tables: { name: string; parquet: string | null; rows: number; m: string | null; columns?: { name: string; dataType: string }[]; sortBy?: Record<string, string>; dataCategory?: Record<string, string>; dax?: string; calcColumns?: { name: string; expression: string }[] }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; cardinality: string; crossFilter: 'single' | 'both'; active: boolean; securityBoth?: boolean }[];
  measures: { table: string; name: string; expression: string; formatString?: string }[];
  layout: string | null;
  /** Enhanced report format (PBIR): JSON files under Report/definition/. */
  pbir?: Record<string, string>;
  resources: Record<string, string>;
  customVisuals?: CustomVisualPkg[];
  sensitivity?: { id: string; name: string; tenant?: string };
  /** Power Query parameters (expressions with IsParameterQuery=true). */
  parameters?: { name: string; expression: string; description?: string }[];
  /** User hierarchies (level name + column), display folders, date tables (table → key column), calculation groups, roles. */
  model?: {
    hierarchies: { table: string; name: string; levels: { name: string; column: string }[] }[];
    folders: { table: string; name: string; folder: string }[];
    dateTables: Record<string, string>;
    calcGroups: { table: string; column: string; precedence: number; items: { name: string; expression: string; formatString?: string }[] }[];
    functions?: import('./types').DaxFunction[];
    calendars?: import('./types').CalendarDef[];
    cultures?: import('./types').Culture[];
    roles: { name: string; filters: { table: string; expression: string }[] }[];
  };
  warnings: string[];
}
export type WebCredKind = 'basic' | 'apikey' | 'header' | 'oauth';
export interface WebCredInfo { prefix: string; kind: WebCredKind; user?: string; name?: string; persistent: boolean; }
export interface ClaudeStatus { configured: boolean; fromEnv: boolean; model: string; models: string[]; persistent: boolean; }
/** Visual described by a Q&A answer (local rules or Claude). */
export interface QnaSpec {
  answerable: boolean;
  visual: string;
  fields: { well: string; table: string; column: string; agg: string }[];
  filters: { table: string; column: string; values: string[] }[];
  topN: number | null;
  sortAscending: boolean | null;
  title: string;
  restatement: string;
}
export interface PbiProfile { id: string; name: string; tenant: string; account: string | null; }
export interface PbiStatus { /** MiB-BI ships an app registration: sign-in works without configuring one. */ builtin?: boolean; profileId: string | null; profileName: string; clientId: string; tenant: string; account: string | null; lastWorkspace: string | null; persistent: boolean; profiles: PbiProfile[]; }
export interface PbiWorkspace { id: string; name: string; dedicated: boolean; readOnly?: boolean; }
export interface PbiResult { datasetId: string; reportId: string | null; webUrl: string | null; warnings: string[]; }
type TableInfo = { name: string; rowCount: number; columns: ColumnMeta[] };

interface Api {
  query(sql: string): Promise<QueryResult>;
  /** Report queries: under Visualizza come ruolo they see only the role's rows. */
  queryAs(sql: string): Promise<QueryResult>;
  /** Restricted tables of the roles viewed as (null = stop viewing as a role). */
  setRole(tables: { table: string; where: string }[] | null): Promise<void>;
  preview(file: string, sheet?: string): Promise<QueryResult>;
  importFile(file: string, table: string, sheet?: string): Promise<TableInfo>;
  dropTable(table: string): Promise<void>;
  materialize(table: string, sql: string): Promise<TableInfo>;
  sourceExpr(source: TableMeta['source']): Promise<string>;
  clearRemoteCache(): Promise<void>;
  openDir(): Promise<string | null>;
  dbConnect(c: DbConnection, password: string | null, remember: boolean): Promise<{ alias: string | null; tables: { schema: string; table: string; rows: number | null; view?: boolean }[]; stored: boolean }>;
  /** First rows of a database table or native statement (navigator preview). */
  dbPreview(source: import('./types').DbSource, limit?: number): Promise<{ columns: string[]; rows: any[] }>;
  /** Saved database credential keys (kind://user@host:port/db…), never the secrets. */
  dbCredentials(): Promise<string[]>;
  dbForget(key: string): Promise<void>;
  dbForget(c: DbConnection): Promise<void>;
  addCalcColumn(table: string, column: string, expr: string, replace: boolean): Promise<TableInfo>;
  dropColumn(table: string, column: string): Promise<TableInfo>;
  sampleData(): Promise<{ financials: string; products: string; countries: string }>;
  openDataDialog(kind: string): Promise<string | null>;
  saveFile(content: string, path?: string | null, embed?: { table: string; file: string }[]): Promise<string | null>;
  openFile(kind?: 'report' | 'mibx' | 'powerbi'): Promise<{ path: string; content?: string; powerbi?: boolean; dataDir?: string } | null>;
  readPowerBI(file: string): Promise<PowerBIModel>;
  openAt(file: string): Promise<{ path: string; content?: string; powerbi?: boolean; dataDir?: string } | null>;
  onOpenArg(cb: (file: string) => void): void;
  readText(kind: string): Promise<{ path: string; content: string } | null>;
  saveText(content: string, defaultPath: string, kind: string): Promise<string | null>;
  savePbit(parts: PbitPart[], suggested?: string): Promise<string | null>;
  savePbix(parts: PbitPart[], schema: unknown, extra: { monthNames: string[]; quarterPrefix: string }, suggested?: string, target?: string): Promise<string | null>;
  printPdf(suggested?: string): Promise<string | null>;
  appVersion(): Promise<string>;
  exportData(name: string, columns: { name: string; kind: 'number' | 'date' | 'text' }[], rows: unknown[][], format: 'xlsx' | 'csv'): Promise<string | null>;
  savePbip(parts: { path: string; text?: string; dataUrl?: string }[], suggested?: string): Promise<string | null>;
  claude: {
    status(): Promise<ClaudeStatus>;
    configure(key: string | null, model?: string): Promise<ClaudeStatus>;
    ask(question: string, schema: string): Promise<{ spec: QnaSpec; model: string; usage: { input: number; output: number } }>;
    /** Traduzioni del modello: captions for one culture, keyed by item id. */
    translate(items: { id: string; name: string; hint: string }[], culture: string): Promise<Record<string, string>>;
  };
  /** Python/R visual: runs the script on the CSV dataset, returns a PNG data URL. */
  runScript(lang: 'python' | 'r', script: string, csv: string, width: number, height: number): Promise<string>;
  /** Opzioni › interpreters for Python/R visuals (no argument = read). */
  scriptPaths(p?: { python?: string; r?: string }): Promise<{ python?: string; r?: string }>;
  pbi: {
    status(): Promise<PbiStatus>;
    configure(clientId: string, tenant: string, name: string): Promise<PbiStatus>;
    addProfile(clientId: string, tenant: string, name: string): Promise<PbiStatus>;
    selectProfile(id: string): Promise<PbiStatus>;
    removeProfile(): Promise<PbiStatus>;
    signOut(): Promise<void>;
    /** Device code sign-in; `email` picks the tenant from its domain. */
    loginStart(email?: string): Promise<{ userCode: string; verificationUri: string; message: string }>;
    /** Sign-in in the system browser (authorization code + PKCE, loopback redirect). */
    loginBrowser(email?: string): Promise<PbiStatus>;
    loginBrowserCancel(): Promise<void>;
    /** Ottieni dati › Power BI: reports and semantic models of a workspace ('' = personal). */
    items(ws: string): Promise<{ reports: { id: string; name: string; datasetId: string | null }[]; datasets: { id: string; name: string; owner: string | null }[] }>;
    /** Report downloaded as .pbix (local path). */
    downloadReport(ws: string, id: string, name: string): Promise<string>;
    /** Semantic model read with DAX queries (same shape as readPowerBI). */
    datasetModel(ws: string, id: string, name: string): Promise<PowerBIModel>;
    loginWait(): Promise<PbiStatus>;
    loginCancel(): Promise<void>;
    workspaces(): Promise<PbiWorkspace[]>;
    publish(mode: 'push' | 'fabric', spec: unknown): Promise<PbiResult>;
    onProgress(cb: (msg: string, frac: number | null) => void): () => void;
  };
  openExternal(url: string): Promise<void>;
  /** Apre il servizio Power BI (app.powerbi.com) in una finestra con sessione isolata. */
  openPbiPortal(url?: string): Promise<void>;
  /** Importa un oggetto visivo da un file (.pbiviz). */
  importPbiviz(): Promise<CustomVisualPkg | null>;
  /** Web/OData/SharePoint credentials per URL prefix (secrets stay in the main process). */
  webcred: {
    list(): Promise<WebCredInfo[]>;
    set(prefix: string, cred: { kind: WebCredKind; user?: string; name?: string; secret?: string }): Promise<boolean>;
    remove(prefix: string): Promise<void>;
  };
  /** Sensitivity labels of the organization (Microsoft Graph, Microsoft account of Pubblica). */
  sensitivityLabels(): Promise<{ id: string; name: string; color?: string; description?: string; tenant: string }[]>;
  /** Origini recenti (data files). */
  recentSources(): Promise<string[]>;
  addRecentSource(path: string): Promise<void>;
  /** Lists of a SharePoint Online site (Microsoft account). */
  sharepointLists(site: string): Promise<string[]>;
  createEmptyTable(table: string, columns: { name: string; dataType: string }[]): Promise<TableInfo>;
  win: {
    minimize(): void;
    maximize(): void;
    close(): void;
    setTitle(t: string): void;
    setTheme(t: 'light' | 'dark'): void;
    /** Interface language: native dialog texts. */
    setLang(l: 'it' | 'en'): void;
    onState(cb: (max: boolean) => void): () => void;
  };
}

declare global {
  interface Window { api: Api; }
}

export const api = window.api;
