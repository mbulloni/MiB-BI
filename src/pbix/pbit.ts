/**
 * Export to a Power BI template (.pbit): the official text-based package Power BI Desktop
 * produces with File → Export → Power BI template. It carries model schema (TOM JSON),
 * Power Query (M) per table, relationships, DAX measures and the report layout; Power BI
 * reloads the data from the sources when the template is opened.
 */
import { locale, monthNames, quarterPrefix } from '../format';
import { levelName, type ColumnMeta, type Report, type TableMeta } from '../types';
import { appendSteps, mName, mStr, mText } from '../pq/m';
import { buildLayout, DATE_HIERARCHY } from './layout';
import { layoutToPbir } from './pbir';
import { tmslToTmdl } from './tmdl';

export interface PbitPart { path: string; utf16?: string; utf8bom?: string; utf8?: string; dataUrl?: string; }

/** Custom visuals used by the report, as Power BI stores them: CustomVisuals/<guid>/package.json + resources/<guid>.pbiviz.json. */
function customVisualFiles(report: Report): { path: string; text: string }[] {
  const used = new Set(report.pages.flatMap((p) => p.visuals.filter((v) => v.type === 'custom').map((v) => v.custom)));
  return (report.customVisuals ?? []).filter((p) => used.has(p.guid)).flatMap((p) => {
    const res = `resources/${p.guid}.pbiviz.json`;
    const pkg = p.package ?? {
      version: p.pbiviz?.visual?.version ?? '1.0.0', author: p.pbiviz?.author ?? {},
      resources: [{ resourceId: 'rId0', sourceType: 5, file: res }], visual: p.pbiviz?.visual ?? { guid: p.guid }, metadata: { pbivizjson: { resourceId: 'rId0' } },
    };
    return [{ path: `CustomVisuals/${p.guid}/package.json`, text: JSON.stringify(pkg) }, { path: `CustomVisuals/${p.guid}/${res}`, text: JSON.stringify(p.pbiviz) }];
  });
}

function tomType(duck: string): { dataType: string; m: string } {
  const t = duck.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(t)) return { dataType: 'int64', m: 'Int64.Type' };
  if (/^(FLOAT|REAL|DOUBLE)$/.test(t)) return { dataType: 'double', m: 'type number' };
  if (t.startsWith('DECIMAL')) return { dataType: 'decimal', m: 'Currency.Type' };
  if (t === 'BOOLEAN') return { dataType: 'boolean', m: 'type logical' };
  if (t === 'DATE') return { dataType: 'dateTime', m: 'type date' };
  if (t.startsWith('TIMESTAMP')) return { dataType: 'dateTime', m: 'type datetime' };
  return { dataType: 'string', m: 'type text' };
}

/** M of a database source as Power BI Desktop writes it (connector function, navigation or native query). */
export function dbSourceM(d: NonNullable<TableMeta['source']['db']>): string {
  const host = d.host || 'localhost';
  const server = mStr(d.port ? `${host}${d.kind === 'sqlserver' ? ',' : ':'}${d.port}` : host);
  const q = d.query ? mStr(d.query) : null;
  const nav3 = (db: string, schema: string, table: string) => `{[Name=${mStr(db)},Kind="Database"]}[Data]{[Name=${mStr(schema)},Kind="Schema"]}[Data]{[Name=${mStr(table)},Kind="Table"]}[Data]`;
  const item = `{[Schema=${mStr(d.schema)},Item=${mStr(d.table)}]}[Data]`;
  switch (d.kind) {
    case 'sqlserver': return `Sql.Database(${server}, ${mStr(d.database ?? '')}${q ? `, [Query=${q}]` : ''})${q ? '' : item}`;
    case 'oracle': return q ? `Oracle.Database(${mStr(host)}, [Query=${q}])` : `Oracle.Database(${mStr(host)}, [HierarchicalNavigation=true]){[Schema=${mStr(d.schema)}]}[Data]{[Name=${mStr(d.table)}]}[Data]`;
    case 'mysql': return `MySQL.Database(${server}, ${mStr(d.database ?? '')}, [ReturnSingleDatabase=true${q ? `, Query=${q}` : ''}])${q ? '' : item}`;
    case 'postgres':
      if (d.variant === 'redshift') return q ? `Value.NativeQuery(AmazonRedshift.Database(${server}, ${mStr(d.database ?? '')}), ${q}, null, [EnableFolding=true])` : `AmazonRedshift.Database(${server}, ${mStr(d.database ?? '')}){[Name=${mStr(d.schema)}]}[Data]{[Name=${mStr(d.table)}]}[Data]`;
      return `PostgreSQL.Database(${server}, ${mStr(d.database ?? '')}${q ? `, [Query=${q}]` : ''})${q ? '' : item}`;
    case 'snowflake': {
      const src = `Snowflake.Databases(${mStr(/\./.test(host) ? host : `${host}.snowflakecomputing.com`)}, ${mStr(d.warehouse ?? '')}${d.role ? `, [Role=${mStr(d.role)}]` : ''})`;
      return q ? `Value.NativeQuery(${src}{[Name=${mStr(d.database ?? '')}]}[Data], ${q}, null, [EnableFolding=true])` : `${src}${nav3(d.database ?? '', d.schema, d.table)}`;
    }
    case 'bigquery': return q ? `Value.NativeQuery(GoogleBigQuery.Database(){[Name=${mStr(d.database ?? '')}]}[Data], ${q}, null, [EnableFolding=true])`
      : `GoogleBigQuery.Database(){[Name=${mStr(d.database ?? '')}]}[Data]{[Name=${mStr(d.schema)},Kind="Schema"]}[Data]{[Name=${mStr(d.table)},Kind="Table"]}[Data]`;
    case 'databricks': {
      const src = `Databricks.Catalogs(${mStr(host)}, ${mStr(d.httpPath ?? '')}, [Catalog=null, Database=null, EnableAutomaticProxyDiscovery=null])`;
      return q ? `Value.NativeQuery(${src}{[Name=${mStr(d.database || 'hive_metastore')},Kind="Database"]}[Data], ${q}, null, [EnableFolding=true])` : `${src}${nav3(d.database || 'hive_metastore', d.schema, d.table)}`;
    }
    case 'access': return `Access.Database(File.Contents(${mStr(d.file ?? '')}), [CreateNavigationProperties=true]){[Schema="",Item=${mStr(d.table)}]}[Data]`;
    case 'clickhouse': return `Odbc.Query(${mStr(`driver={ClickHouse ODBC Driver (Unicode)};url=${d.encrypt ? 'https' : 'http'}://${host}:${d.port || 8123};database=${d.database || 'default'}`)}, ${q ?? mStr(`SELECT * FROM \`${d.schema}\`.\`${d.table}\``)})`;
    case 'kusto': return q ? `AzureDataExplorer.Contents(${mStr(host)}, ${mStr(d.database ?? '')}, ${q}, [])` : `AzureDataExplorer.Contents(${mStr(host)}, ${mStr(d.database ?? '')}, ${mStr(d.table)}, [])`;
    case 'dataverse': return `CommonDataService.Database(${mStr(host.replace(/^https?:\/\//, ''))}){[Schema="dbo",Item=${mStr(d.table)}]}[Data]`;
    case 'odbc': return q ? `Odbc.Query(${mStr(/=/.test(host) ? host : `dsn=${host}`)}, ${q})` : `Odbc.DataSource(${mStr(/=/.test(host) ? host : `dsn=${host}`)}, [HierarchicalNavigation=true])${d.schema ? `{[Name=${mStr(d.schema)},Kind="Schema"]}[Data]` : ''}{[Name=${mStr(d.table)},Kind="Table"]}[Data]`;
    case 'mongodb': return `Odbc.Query(${mStr(`dsn=MongoDB;database=${d.database ?? ''}`)}, ${mStr(`SELECT * FROM ${d.table}`)})`;
    default: return `Odbc.DataSource(${mStr(`driver={SQLite3 ODBC Driver};database=${d.file}`)}, [HierarchicalNavigation=true]){[Name=${mStr(d.table)},Kind="Table"]}[Data]`;
  }
}

/** Power Query expression of the source ("Origine" + header/type steps); keeps the original M of Power BI tables. */
function sourceM(t: Pick<TableMeta, 'source'>, columns: ColumnMeta[]): string {
  if (t.source.m) return t.source.m;
  if (t.source.ref) return `let\n    Origine = ${mName(t.source.ref)}\nin\n    Origine`;
  const d = t.source.db;
  if (d) return `let\n    Origine = ${dbSourceM(d)}\nin\n    Origine`;
  const p = t.source.path;
  const types = `{${columns.map((c) => `{${mStr(c.name)}, ${tomType(c.type).m}}`).join(', ')}}`;
  const typed = (prev: string) => columns.length
    ? `    #"Modificato tipo" = Table.TransformColumnTypes(${prev}, ${types}, "en-US")\nin\n    #"Modificato tipo"`
    : `    Fine = ${prev}\nin\n    Fine`;
  if (t.source.inline) {
    const { columns: cs, rows } = t.source.inline;
    return `let\n    Origine = #table({${cs.map(mStr).join(', ')}}, {${rows.map((r) => `{${cs.map((_, i) => (r[i] === null || r[i] === undefined || r[i] === '' ? 'null' : mStr(r[i]!))).join(', ')}}`).join(', ')}})\nin\n    Origine`;
  }
  if (t.source.odata) return `let\n    Origine = OData.Feed(${mText(t.source.odata.url)}, null, [Implementation="2.0"])\nin\n    Origine`;
  const sp = t.source.sharepoint;
  if (sp?.list) return `let\n    Origine = SharePoint.Tables(${mText(sp.site)}, [ApiVersion = 15]),\n    Elenco = Origine{[Title=${mText(sp.list)}]}[Items]\nin\n    Elenco`;
  if (sp) {
    // Like Power BI's "Combina file" over SharePoint.Files: filter by extension (and folder), read each Content.
    const e = (sp.ext ?? 'csv').replace(/^\./, '').toLowerCase();
    const read = e === 'parquet' ? 'Parquet.Document([Content])' : e === 'json' ? 'Table.FromRecords(Json.Document([Content]))'
      : 'Table.PromoteHeaders(Csv.Document([Content], [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]), [PromoteAllScalars=true])';
    const data = columns.filter((c) => c.name !== 'Source.Name').map((c) => c.name);
    const cond = `Text.Lower([Extension]) = ${mStr('.' + e)}${sp.folder ? ` and Text.Contains([Folder Path], ${mText(sp.folder)})` : ''}`;
    return `let\n    Origine = SharePoint.Files(${mText(sp.site)}, [ApiVersion = 15]),\n    #"Righe filtrate" = Table.SelectRows(Origine, each ${cond}),\n` +
      `    #"Contenuto letto" = Table.AddColumn(#"Righe filtrate", "Dati", each ${read}),\n` +
      `    #"Altre colonne rimosse" = Table.SelectColumns(#"Contenuto letto", {"Name", "Dati"}),\n` +
      `    #"Colonna espansa" = Table.ExpandTableColumn(#"Altre colonne rimosse", "Dati", {${data.map(mStr).join(', ')}}),\n` +
      `    #"Colonne rinominate" = Table.RenameColumns(#"Colonna espansa", {{"Name", "Source.Name"}}),\n${typed('#"Colonne rinominate"')}`;
  }
  if (t.source.folder) {
    const f = t.source.folder, e = f.ext.replace(/^\./, '').toLowerCase();
    const read = e === 'parquet' ? 'Parquet.Document([Content])' : e === 'json' ? 'Table.FromRecords(Json.Document([Content]))'
      : 'Table.PromoteHeaders(Csv.Document([Content], [Delimiter=",", Encoding=65001, QuoteStyle=QuoteStyle.Csv]), [PromoteAllScalars=true])';
    const data = columns.filter((c) => c.name !== 'Source.Name').map((c) => c.name);
    return `let\n    Origine = Folder.Files(${mText(f.path)}),\n    #"Righe filtrate" = Table.SelectRows(Origine, each Text.Lower([Extension]) = ${mStr('.' + e)}),\n` +
      `    #"Contenuto letto" = Table.AddColumn(#"Righe filtrate", "Dati", each ${read}),\n` +
      `    #"Altre colonne rimosse" = Table.SelectColumns(#"Contenuto letto", {"Name", "Dati"}),\n` +
      `    #"Colonna espansa" = Table.ExpandTableColumn(#"Altre colonne rimosse", "Dati", {${data.map(mStr).join(', ')}}),\n` +
      `    #"Colonne rinominate" = Table.RenameColumns(#"Colonna espansa", {{"Name", "Source.Name"}}),\n${typed('#"Colonne rinominate"')}`;
  }
  // Web.Contents for web files, File.Contents otherwise; parameters become M identifiers.
  const where = t.source.web ? t.source.web.url : p;
  const ext = (t.source.web?.format ?? where.split('?')[0].split('.').pop() ?? '').toLowerCase();
  const contents = t.source.web ? `Web.Contents(${mText(where)})` : `File.Contents(${mText(p)})`;
  if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    return `let\n    Origine = Csv.Document(${contents}, [Delimiter="${ext === 'tsv' ? '#(tab)' : ','}", Encoding=65001, QuoteStyle=QuoteStyle.Csv]),\n` +
      `    #"Intestazioni alzate di livello" = Table.PromoteHeaders(Origine, [PromoteAllScalars=true]),\n${typed('#"Intestazioni alzate di livello"')}`;
  }
  if (ext === 'xlsx') {
    const item = t.source.sheet ? `{[Item=${mStr(t.source.sheet)},Kind="Sheet"]}[Data]` : '{0}[Data]';
    return `let\n    Origine = Excel.Workbook(${contents}, null, true),\n    Foglio = Origine${item},\n` +
      `    #"Intestazioni alzate di livello" = Table.PromoteHeaders(Foglio, [PromoteAllScalars=true]),\n${typed('#"Intestazioni alzate di livello"')}`;
  }
  if (ext === 'parquet') return `let\n    Origine = Parquet.Document(${contents})\nin\n    Origine`;
  if (ext === 'json') return `let\n    Origine = Table.FromRecords(Json.Document(${contents})),\n${typed('Origine')}`;
  return `let\n    Origine = Csv.Document(${contents})\nin\n    Origine`;
}

/** Full M of a query: source followed by its applied steps (Editor avanzato, .pbit partitions). */
export function queryM(t: Pick<TableMeta, 'source' | 'steps'>, sourceColumns: ColumnMeta[]): string {
  // M queries keep their own code.
  if (t.source.mcode !== undefined) return t.source.mcode;
  return appendSteps(sourceM(t, sourceColumns), t.steps ?? []);
}

const mExpression = (t: TableMeta) => queryM(t, t.steps?.length ? t.sourceColumns ?? [] : t.columns);


/** Hidden date table (template or LocalDateTable of one column), as Power BI Desktop writes it. */
function dateTable(name: string, expression: string, local: boolean) {
  const calc = (n: string, expr: string, dataType: string, category: string, template: string, extra: object = {}) => ({
    type: 'calculated', name: n, dataType, isHidden: true, isDataTypeInferred: true, expression: expr, lineageTag: crypto.randomUUID(),
    dataCategory: category, summarizeBy: 'none', ...(dataType === 'int64' ? { formatString: '0' } : {}), ...extra,
    annotations: [{ name: 'SummarizationSetBy', value: 'User' }, { name: 'TemplateId', value: template }],
  });
  return {
    name, isHidden: true, ...(local ? { showAsVariationsOnly: true } : { isPrivate: true }), lineageTag: crypto.randomUUID(),
    columns: [
      { type: 'calculatedTableColumn', name: 'Date', dataType: 'dateTime', isHidden: true, isNameInferred: true, isDataTypeInferred: true, sourceColumn: '[Date]', formatString: 'General Date', lineageTag: crypto.randomUUID(), dataCategory: 'PaddedDateTableDates', summarizeBy: 'none', annotations: [{ name: 'SummarizationSetBy', value: 'User' }] },
      calc('Year', 'YEAR([Date])', 'int64', 'Years', 'Year'),
      calc('MonthNo', 'MONTH([Date])', 'int64', 'MonthOfYear', 'MonthNumber'),
      calc('Month', 'FORMAT([Date], "MMMM")', 'string', 'Months', 'Month', { sortByColumn: 'MonthNo' }),
      calc('QuarterNo', 'INT(([MonthNo] + 2) / 3)', 'int64', 'QuarterOfYear', 'QuarterNumber'),
      // Labels as MiB-BI shows them (filters on levels compare these values): "Trim 1", month names of the model culture.
      calc('Quarter', `"${quarterPrefix()}" & [QuarterNo]`, 'string', 'Quarters', 'Quarter', { sortByColumn: 'QuarterNo' }),
      calc('Day', 'DAY([Date])', 'int64', 'DayOfMonth', 'Day'),
    ],
    partitions: [{ name: `${name}-${crypto.randomUUID()}`, mode: 'import', source: { type: 'calculated', expression } }],
    hierarchies: [{
      name: DATE_HIERARCHY, lineageTag: crypto.randomUUID(),
      levels: (['Year', 'Quarter', 'Month', 'Day'] as const).map((l, ordinal) => ({ name: l, ordinal, column: l, lineageTag: crypto.randomUUID() })),
      annotations: [{ name: 'TemplateId', value: 'DateHierarchy' }],
    }],
    annotations: [{ name: local ? '__PBI_LocalDateTable' : '__PBI_TemplateDateTable', value: 'true' }, { name: 'DefaultItem', value: 'DateHierarchy' }],
  };
}

/** Opzioni › File corrente › Data/ora automatica (on unless turned off). */
export const autoDateOn = (report: Report) => report.options?.autoDateTime !== false;

/** Date columns that get an automatic date hierarchy (all date/datetime columns, like Power BI's auto date/time). */
export const autoDateColumns = (tables: TableMeta[]) => tables.flatMap((t) => (t.fieldParam ? [] : t.columns.filter((c) => tomType(c.type).dataType === 'dateTime').map((c) => ({ table: t.name, column: c.name }))));

/** TMSL cultures: translations of tables and of their columns, measures and hierarchies. */
function culturesOf(report: Report, tables: TableMeta[]) {
  const names = [...new Set([...tables.map((t) => t.name), ...report.measures.map((m) => m.table)])];
  return (report.cultures ?? []).map((c) => {
    const tr = (key: string) => ({
      ...(c.captions[key] ? { translatedCaption: c.captions[key] } : {}),
      ...(c.descriptions?.[key] ? { translatedDescription: c.descriptions[key] } : {}),
      ...(c.folders?.[key] ? { translatedDisplayFolder: c.folders[key] } : {}),
    });
    const items = (table: string, list: string[]) => list.map((n) => ({ name: n, ...tr(`${table}\u0001${n}`) })).filter((x) => Object.keys(x).length > 1);
    const tbls = names.map((n) => {
      const t = tables.find((x) => x.name === n);
      const columns = items(n, t?.columns.map((x) => x.name) ?? []);
      const measures = items(n, report.measures.filter((m) => m.table === n).map((m) => m.name));
      const hierarchies = items(n, (report.hierarchies ?? []).filter((h) => h.table === n).map((h) => h.name));
      return { name: n, ...tr(n), ...(columns.length ? { columns } : {}), ...(measures.length ? { measures } : {}), ...(hierarchies.length ? { hierarchies } : {}) };
    }).filter((x) => Object.keys(x).length > 1);
    return { name: c.name, translations: { model: { name: 'Model', ...(tbls.length ? { tables: tbls } : {}) } } };
  });
}

/** `autoDates`: add the LocalDateTable/DateTableTemplate tables, variations and relationships (date hierarchies of the report). */
export function buildModelSchema(report: Report, tables: TableMeta[], autoDates = autoDateOn(report)) {
  const calcOf = (t: string) => report.calcGroups?.find((g) => g.table === t);
  // Tables marked as date table and calculation groups get no automatic date hierarchy (like Power BI).
  const dates = autoDates ? autoDateColumns(tables.filter((t) => !report.dateTables?.[t.name] && !calcOf(t.name))).map((d) => ({ ...d, local: `LocalDateTable_${crypto.randomUUID()}`, rel: crypto.randomUUID() })) : [];
  const folderOf = (t: string, f: string) => report.displayFolders?.[t + '\u0001' + f];
  const hierarchiesOf = (t: string) => (report.hierarchies ?? []).filter((h) => h.table === t).map((h) => ({
    name: h.name, lineageTag: crypto.randomUUID(), ...(folderOf(t, h.name) ? { displayFolder: folderOf(t, h.name) } : {}),
    levels: h.levels.map((c, ordinal) => ({ name: levelName(h, c), ordinal, column: c, lineageTag: crypto.randomUUID() })),
  }));
  /** Calendars (TOM Calendar › CalendarColumnGroup): a time unit with primary/associated columns, or time-related columns. */
  const calendarsOf = (t: string) => (report.calendars ?? []).filter((c) => c.table === t).map((c) => ({
    name: c.name, lineageTag: crypto.randomUUID(), ...(c.description ? { description: c.description } : {}),
    calendarColumnGroups: c.groups.map((g) => (g.unit
      ? { timeUnit: g.unit, primaryColumn: g.primary, ...(g.associated?.length ? { associatedColumns: g.associated } : {}) }
      : { columns: g.associated ?? [] })),
  }));
  const dateOf = (t: string, c: string) => dates.find((d) => d.table === t && d.column === c);
  const daxTable = (n: string) => `'${n.replace(/'/g, "''")}'`, daxCol = (n: string) => `[${n.replace(/]/g, ']]')}]`;
  const numeric = (t: string) => ['int64', 'double', 'decimal'].includes(t);
  // Power BI "measure tables": only measures, exported with one hidden placeholder column.
  const measureOnly = [...new Set(report.measures.map((m) => m.table))].filter((n) => !tables.some((t) => t.name === n));
  const measuresOf = (table: string) => report.measures.filter((m) => m.table === table).map((m) => ({
    name: m.name, expression: m.expression.split('\n'), lineageTag: crypto.randomUUID(),
    ...(m.formatString ? { formatString: m.formatString } : {}),
    ...(folderOf(table, m.name) ? { displayFolder: folderOf(table, m.name) } : {}),
  }));
  /** Calculation group table: Power BI rebuilds its rows from the items. */
  const calcTable = (t: TableMeta, g: NonNullable<ReturnType<typeof calcOf>>) => ({
    name: t.name, lineageTag: crypto.randomUUID(),
    calculationGroup: {
      precedence: g.precedence,
      calculationItems: g.items.map((it, ordinal) => ({ name: it.name, expression: it.expression.split('\n'), ordinal, ...(it.formatString ? { formatStringDefinition: { expression: it.formatString } } : {}) })),
    },
    columns: [
      { name: g.column, dataType: 'string', sourceColumn: 'Name', sortByColumn: 'Ordinal', summarizeBy: 'none', lineageTag: crypto.randomUUID(), ...(folderOf(t.name, g.column) ? { displayFolder: folderOf(t.name, g.column) } : {}) },
      { name: 'Ordinal', dataType: 'int64', sourceColumn: 'Ordinal', isHidden: true, formatString: '0', summarizeBy: 'sum', lineageTag: crypto.randomUUID() },
    ],
    partitions: [{ name: `Partizione-${crypto.randomUUID().slice(0, 8)}`, mode: 'import', source: { type: 'calculationGroup' } }],
    measures: measuresOf(t.name),
  });
  return {
    name: crypto.randomUUID(),
    // Calendars need compatibility level 1701, user-defined functions 1702.
    compatibilityLevel: report.functions?.length ? 1702 : report.calendars?.length ? 1701 : 1550,
    model: {
      culture: locale(),
      dataAccessOptions: { legacyRedirects: true, returnErrorValuesAsNull: true },
      defaultPowerBIDataSourceVersion: 'powerBI_V3',
      sourceQueryCulture: locale(),
      ...(report.calcGroups?.length ? { discourageImplicitMeasures: true } : {}),
      tables: tables.map((t): any => (calcOf(t.name) ? calcTable(t, calcOf(t.name)!) : {
        name: t.name,
        lineageTag: crypto.randomUUID(),
        ...(report.dateTables?.[t.name] ? { dataCategory: 'Time' } : {}),
        columns: t.columns.map((c) => {
          const tt = tomType(c.type);
          const calc = t.calcColumns?.find((x) => x.name === c.name);
          // Calculated columns keep their DAX; columns of a calculated table come from its expression.
          const kind = calc ? { type: 'calculated', isDataTypeInferred: true, expression: calc.expression.split('\n') }
            : t.source.dax ? { type: 'calculatedTableColumn', isNameInferred: true, isDataTypeInferred: true, sourceColumn: `[${c.name}]` }
              : { sourceColumn: c.name };
          return {
            name: c.name, dataType: tt.dataType, ...kind, lineageTag: crypto.randomUUID(),
            summarizeBy: numeric(tt.dataType) ? 'sum' : 'none',
            ...(tt.dataType === 'dateTime' ? { formatString: tt.m === 'type date' ? 'Short Date' : 'General Date' } : {}),
            ...(t.sortBy?.[c.name] ? { sortByColumn: t.sortBy[c.name] } : {}),
            ...(t.dataCategory?.[c.name] ? { dataCategory: t.dataCategory[c.name] } : {}),
            ...(report.dateTables?.[t.name] === c.name ? { isKey: true } : {}),
            ...(folderOf(t.name, c.name) ? { displayFolder: folderOf(t.name, c.name) } : {}),
            ...(dateOf(t.name, c.name) ? { variations: [{ name: 'Variation', relationship: dateOf(t.name, c.name)!.rel, defaultHierarchy: { table: dateOf(t.name, c.name)!.local, hierarchy: DATE_HIERARCHY }, isDefault: true }] } : {}),
            annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }, ...(dateOf(t.name, c.name) ? [{ name: 'UnderlyingDateTimeDataType', value: tomType(c.type).m === 'type date' ? 'Date' : 'DateTime' }] : [])],
          };
        }),
        partitions: [{
          name: `${t.name}-${crypto.randomUUID().slice(0, 8)}`, mode: 'import',
          ...(report.pqGroups?.[t.name] && !t.source.dax ? { queryGroup: report.pqGroups[t.name] } : {}),
          source: t.source.dax ? { type: 'calculated', expression: t.source.dax.split('\n') } : { type: 'm', expression: mExpression(t).split('\n') },
        }],
        measures: measuresOf(t.name),
        ...(hierarchiesOf(t.name).length ? { hierarchies: hierarchiesOf(t.name) } : {}),
        ...(calendarsOf(t.name).length ? { calendars: calendarsOf(t.name) } : {}),
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      })).concat(measureOnly.map((name) => ({
        name,
        lineageTag: crypto.randomUUID(),
        columns: [{ name: 'Colonna1', dataType: 'string', sourceColumn: 'Colonna1', lineageTag: crypto.randomUUID(), summarizeBy: 'none', isHidden: true, annotations: [{ name: 'SummarizationSetBy', value: 'Automatic' }] }] as any[],
        partitions: [{ name: `${name}-${crypto.randomUUID().slice(0, 8)}`, mode: 'import', source: { type: 'm', expression: ['let', '    Origine = Table.FromRows({}, type table [Colonna1 = text])', 'in', '    Origine'] } }],
        measures: measuresOf(name),
        annotations: [{ name: 'PBI_ResultType', value: 'Table' }],
      })) as any[]).concat(dates.length ? [dateTable(`DateTableTemplate_${crypto.randomUUID()}`, 'Calendar(Date(2015,1,1), Date(2015,1,1))', false)] : [])
        .concat(dates.map((d) => dateTable(d.local, `Calendar(Date(Year(MIN(${daxTable(d.table)}${daxCol(d.column)})), 1, 1), Date(Year(MAX(${daxTable(d.table)}${daxCol(d.column)})), 12, 31))`, true))),
      // Gruppi di query (folders of the queries pane).
      ...(Object.keys(report.pqGroups ?? {}).length ? { queryGroups: [...new Set(Object.values(report.pqGroups!))].map((folder) => ({ folder })) } : {}),
      // Power Query parameters (shared M expressions flagged as parameter queries) and connection-only queries.
      ...(report.pqParams?.length || report.pqQueries?.length ? {
        expressions: [...(report.pqQueries ?? []).map((q) => ({
          name: q.name, kind: 'm', expression: q.code.split('\n'), lineageTag: crypto.randomUUID(),
          ...(report.pqGroups?.[q.name] ? { queryGroup: report.pqGroups[q.name] } : {}),
          annotations: [{ name: 'PBI_ResultType', value: /^\s*\(/.test(q.code) ? 'Function' : 'Table' }],
        })), ...(report.pqParams ?? []).map((p) => {
          const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(p.value);
          const lit = p.type === 'number' ? (Number.isFinite(Number(p.value)) ? String(Number(p.value)) : '0') : p.type === 'date' && d ? `#date(${+d[1]}, ${+d[2]}, ${+d[3]})` : mStr(p.value);
          const type = p.type === 'number' ? 'Number' : p.type === 'date' ? 'Date' : 'Text';
          return { name: p.name, kind: 'm', expression: `${lit} meta [IsParameterQuery=true, Type="${type}", IsParameterQueryRequired=true]`, lineageTag: crypto.randomUUID(), ...(p.description ? { description: p.description } : {}) };
        })],
      } : {}),
      relationships: report.relationships.map((r) => ({
        name: crypto.randomUUID(),
        fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
        ...(r.active ? {} : { isActive: false }),
        ...(r.crossFilter === 'both' || r.cardinality === 'oneToOne' ? { crossFilteringBehavior: 'bothDirections' } : {}),
        ...(r.securityBoth ? { securityFilteringBehavior: 'bothDirections' } : {}),
        ...(r.cardinality === 'oneToOne' ? { fromCardinality: 'one' } : {}),
        ...(r.cardinality === 'manyToMany' ? { toCardinality: 'many' } : {}),
      })).concat(dates.map((d) => ({ name: d.rel, fromTable: d.table, fromColumn: d.column, toTable: d.local, toColumn: 'Date', joinOnDateBehavior: 'datePartOnly' }) as any)),
      // Funzioni DAX definite dall'utente.
      ...(report.functions?.length ? {
        functions: report.functions.map((f) => ({ name: f.name, expression: f.expression.split('\n'), lineageTag: crypto.randomUUID(), ...(f.description ? { description: f.description } : {}) })),
      } : {}),
      // Traduzioni del modello (one culture per language, translated captions/descriptions/display folders).
      ...(report.cultures?.length ? { cultures: culturesOf(report, tables) } : {}),
      // Sicurezza a livello di riga.
      ...(report.roles?.length ? {
        roles: report.roles.map((r) => ({
          name: r.name, modelPermission: 'read',
          tablePermissions: r.filters.filter((f) => f.expression.trim()).map((f) => ({ name: f.table, filterExpression: f.expression.split('\n') })),
        })),
      } : {}),
      annotations: [
        { name: 'PBI_QueryOrder', value: JSON.stringify(tables.filter((t) => !calcOf(t.name)).map((t) => t.name)) },
        { name: '__PBI_TimeIntelligenceEnabled', value: dates.length ? '1' : '0' },
      ],
    },
  };
}

/** Power BI project (.pbip): report as PBIR (definition/ folder) or legacy report.json, model as TMDL
 *  (definition/ folder) or TMSL model.bim. Text files suited to git; `clean` = generated paths to remove first. */
export function buildPbipParts(report: Report, tables: TableMeta[], fmt: { pbir?: boolean; tmdl?: boolean } = { pbir: true, tmdl: true }): { path: string; text?: string; dataUrl?: string }[] {
  const { layout, resources } = buildLayout(report.pages, report.reportFilters, report.theme, report.bookmarks, { dateHierarchies: autoDateOn(report), dateTables: Object.keys(report.dateTables ?? {}), hierarchies: report.hierarchies, filterByDefault: report.options?.filterByDefault });
  const j = (o: unknown) => JSON.stringify(o, null, 2);
  const platform = (type: string) => ({
    $schema: 'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json',
    metadata: { type, displayName: '__BASE__' },
    config: { version: '2.0', logicalId: crypto.randomUUID() },
  });
  const themeName = Object.keys(resources).find((n) => n.endsWith('.json'));
  const reportParts = fmt.pbir
    ? Object.entries(layoutToPbir(layout, themeName)).map(([p, o]) => ({ path: `__BASE__.Report/definition/${p}`, text: j(o) }))
    : [{ path: '__BASE__.Report/report.json', text: j(JSON.parse(layout)) }];
  const model = buildModelSchema(report, tables);
  const modelParts = fmt.tmdl
    ? Object.entries(tmslToTmdl(model)).map(([p, t]) => ({ path: `__BASE__.SemanticModel/definition/${p}`, text: t }))
    : [{ path: '__BASE__.SemanticModel/model.bim', text: j(model) }];
  return [
    { path: '__BASE__.pbip', text: j({ version: '1.0', artifacts: [{ report: { path: '__BASE__.Report' } }], settings: { enableAutoRecovery: true } }) },
    { path: '__BASE__.Report/definition.pbir', text: j({ $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json', version: '4.0', datasetReference: { byPath: { path: '../__BASE__.SemanticModel' } } }) },
    ...reportParts,
    ...Object.entries(resources).map(([n, d]) => ({ path: `__BASE__.Report/StaticResources/RegisteredResources/${n}`, dataUrl: d })),
    ...customVisualFiles(report).map((f) => ({ path: `__BASE__.Report/${f.path}`, text: f.text })),
    { path: '__BASE__.SemanticModel/definition.pbism', text: j({ $schema: 'https://developer.microsoft.com/json-schemas/fabric/item/semanticModel/definitionProperties/1.0.0/schema.json', version: '4.0', settings: {} }) },
    ...modelParts,
    // Microsoft Fabric Git integration metadata.
    { path: '__BASE__.Report/.platform', text: j(platform('Report')) },
    { path: '__BASE__.SemanticModel/.platform', text: j(platform('SemanticModel')) },
    { path: '.gitignore', text: '**/.pbi/localSettings.json\n**/.pbi/cache.abf\n' },
  ];
}

/** Sensitivity label of the organization (Microsoft Purview) as Office custom properties, like Power BI Desktop. */
function labelParts(report: Report): PbitPart[] {
  const l = report.sensitivity;
  if (!l?.id || !l.tenant) return [];
  const esc = (x: string) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const props: [string, string][] = [['Enabled', 'true'], ['SetDate', new Date().toISOString().replace(/\.\d+Z$/, 'Z')], ['Method', 'Standard'], ['Name', l.name], ['SiteId', l.tenant], ['ActionId', crypto.randomUUID()], ['ContentBits', '0']];
  const xml = '<?xml version="1.0" encoding="utf-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    props.map(([k, v], i) => `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${i + 2}" name="MSIP_Label_${l.id}_${k}"><vt:lpwstr>${esc(v)}</vt:lpwstr></property>`).join('') + '</Properties>';
  return [{ path: 'docProps/custom.xml', utf8: xml }];
}

export function buildPbitParts(report: Report, tables: TableMeta[]): PbitPart[] {
  const { layout, resources } = buildLayout(report.pages, report.reportFilters, report.theme, report.bookmarks, { dateHierarchies: autoDateOn(report), dateTables: Object.keys(report.dateTables ?? {}), hierarchies: report.hierarchies, filterByDefault: report.options?.filterByDefault });
  const diagram = {
    version: '1.1.0',
    diagrams: [{
      ordinal: 0, scrollPosition: { x: 0, y: 0 },
      nodes: tables.map((t, i) => ({
        location: report.modelLayout[t.name] ?? { x: 40 + (i % 4) * 280, y: 40 + Math.floor(i / 4) * 380 },
        nodeIndex: t.name, size: { height: 300, width: 234 }, zIndex: i,
      })),
      name: 'Tutte le tabelle', zoomValue: 100, pinKeyFieldsToTop: false, showExtraHeaderInfo: false, hideKeyFieldsWhenCollapsed: false, tablesLocked: false,
    }],
    selectedDiagram: 'Tutte le tabelle', defaultDiagram: 'Tutte le tabelle',
  };
  const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="json" ContentType="" /><Default Extension="png" ContentType="" /><Default Extension="jpg" ContentType="" /><Default Extension="gif" ContentType="" />' +
    '<Override PartName="/Version" ContentType="" /><Override PartName="/DataModelSchema" ContentType="" /><Override PartName="/DiagramLayout" ContentType="" />' +
    '<Override PartName="/Report/Layout" ContentType="" /><Override PartName="/Settings" ContentType="application/json" /><Override PartName="/Metadata" ContentType="application/json" />' +
    (labelParts(report).length ? '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-officedocument.custom-properties+xml" />' : '') + '</Types>';
  return [
    ...labelParts(report),
    { path: 'Version', utf16: '1.28' },
    { path: '[Content_Types].xml', utf8bom: contentTypes },
    { path: 'DataModelSchema', utf16: JSON.stringify(buildModelSchema(report, tables)) },
    { path: 'DiagramLayout', utf16: JSON.stringify(diagram) },
    { path: 'Report/Layout', utf16: layout },
    { path: 'Settings', utf16: JSON.stringify({ Version: 4, ReportSettings: {}, QueriesSettings: { TypeDetectionEnabled: true, RelationshipImportEnabled: true, Version: '2.128.184.0' } }) },
    { path: 'Metadata', utf16: JSON.stringify({ Version: 5, AutoCreatedRelationships: [], CreatedFrom: 'Cloud', CreatedFromRelease: '2025.10' }) },
    ...Object.entries(resources).map(([n, d]) => ({ path: `Report/StaticResources/RegisteredResources/${n}`, dataUrl: d })),
    ...customVisualFiles(report).map((f) => ({ path: `Report/${f.path}`, utf8: f.text })),
  ];
}

/** .pbix with data: the .pbit parts without DataModelSchema (main replaces it with the DataModel written by
 *  electron/pbix/write_pbix.py from `schema` and the DuckDB tables). `extra` = what the auto date tables need. */
export function buildPbixParts(report: Report, tables: TableMeta[]) {
  const schema = buildModelSchema(report, tables);
  const parts = buildPbitParts(report, tables)
    .filter((p) => p.path !== 'DataModelSchema')
    .map((p) => (p.path === '[Content_Types].xml' ? { ...p, utf8bom: p.utf8bom!.replace('/DataModelSchema', '/DataModel') } : p));
  return { parts, schema, extra: { monthNames: monthNames(), quarterPrefix: quarterPrefix() } };
}

// ---------- Power BI service publishing (electron/powerbi.cjs) ----------

const PUSH_TYPES: Record<string, string> = { int64: 'Int64', double: 'Double', decimal: 'Double', boolean: 'Boolean', dateTime: 'DateTime', string: 'String' };

/** Push dataset definition (Power BI Pro): calculated columns and tables travel as plain data,
 *  measure-only tables get a hidden placeholder column, `rows` is used for limits and progress. */
export function buildPushSchema(report: Report, tables: TableMeta[]) {
  const warnings: string[] = [];
  const measuresOf = (table: string) => report.measures.filter((m) => m.table === table)
    .map((m) => ({ name: m.name, expression: m.expression, ...(m.formatString ? { formatString: m.formatString } : {}) }));
  const measureOnly = [...new Set(report.measures.map((m) => m.table))].filter((n) => !tables.some((t) => t.name === n));
  const calc = tables.filter((t) => t.calcColumns?.length || t.source.dax).map((t) => t.name);
  if (report.calcGroups?.length) warnings.push(`Gruppi di calcolo (${report.calcGroups.map((g) => g.table).join(', ')}) non supportati dai dataset push: pubblicati come tabelle semplici, senza trasformare le misure.`);
  if (report.roles?.length) warnings.push('Ruoli di sicurezza a livello di riga non supportati dai dataset push: omessi (usare la pubblicazione Fabric).');
  if (calc.length) warnings.push(`Colonne e tabelle calcolate pubblicate come valori fissi (${calc.join(', ')}): vengono ricalcolate a ogni nuova pubblicazione.`);
  const relationships = report.relationships.filter((r) => {
    if (!r.active) { warnings.push(`Relazione inattiva ${r.fromTable}[${r.fromColumn}] → ${r.toTable}[${r.toColumn}] non supportata dai dataset push: omessa.`); return false; }
    if (r.cardinality === 'manyToMany') { warnings.push(`Relazione molti-a-molti ${r.fromTable} → ${r.toTable} non supportata dai dataset push: omessa.`); return false; }
    return true;
  }).map((r) => ({
    name: r.id, fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
    crossFilteringBehavior: r.crossFilter === 'both' || r.cardinality === 'oneToOne' ? 'BothDirections' : 'OneDirection',
  }));
  const schema = {
    tables: [
      ...tables.map((t) => ({
        name: t.name,
        rows: t.rowCount,
        columns: t.columns.map((c) => {
          const tt = tomType(c.type);
          return {
            name: c.name, dataType: PUSH_TYPES[tt.dataType],
            ...(tt.dataType === 'dateTime' ? { formatString: tt.m === 'type date' ? 'dd/mm/yyyy' : 'dd/mm/yyyy hh:nn:ss' } : {}),
            ...(t.sortBy?.[c.name] ? { sortByColumn: t.sortBy[c.name] } : {}),
            ...(t.dataCategory?.[c.name] ? { dataCategory: t.dataCategory[c.name] } : {}),
            summarizeBy: ['int64', 'double', 'decimal'].includes(tt.dataType) ? 'sum' : 'none',
          };
        }),
        measures: measuresOf(t.name),
      })),
      ...measureOnly.map((name) => ({ name, rows: 0, virtual: true, columns: [{ name: 'Colonna1', dataType: 'String', isHidden: true }], measures: measuresOf(name) })),
    ],
    relationships,
  };
  return { schema, warnings };
}

/** Report part of a publication: report.json and images, paths relative to the report item. */
/** `full` = false for push datasets: no date tables nor user hierarchies in the model, plain columns in the report. */
export function buildReportParts(report: Report, full = true): { path: string; text?: string; dataUrl?: string }[] {
  const { layout, resources } = buildLayout(report.pages, report.reportFilters, report.theme, report.bookmarks, full ? { dateHierarchies: autoDateOn(report), dateTables: Object.keys(report.dateTables ?? {}), hierarchies: report.hierarchies } : { dateHierarchies: false });
  return [
    { path: 'report.json', text: layout },
    ...Object.entries(resources).map(([n, d]) => ({ path: `StaticResources/RegisteredResources/${n}`, dataUrl: d })),
    ...customVisualFiles(report).map((f) => ({ path: f.path, text: f.text })),
  ];
}

/** Thin report (.pbix without data model): layout + live connection to a dataset of the service.
 *  __DATASET_ID__ / __REPORT_ID__ / __WORKSPACE_ID__ are filled in once the dataset exists. */
export function buildThinPbixParts(report: Report): (PbitPart & { utf8?: string })[] {
  // Push datasets have no automatic date tables: date levels go out as the plain date column.
  const { layout, resources } = buildLayout(report.pages, report.reportFilters, report.theme, report.bookmarks, { dateHierarchies: false, filterByDefault: report.options?.filterByDefault });
  const contentTypes = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="json" ContentType="" /><Default Extension="png" ContentType="" /><Default Extension="jpg" ContentType="" /><Default Extension="gif" ContentType="" />' +
    '<Override PartName="/Version" ContentType="" /><Override PartName="/Connections" ContentType="" />' +
    '<Override PartName="/Report/Layout" ContentType="" /><Override PartName="/Settings" ContentType="" /><Override PartName="/Metadata" ContentType="" /></Types>';
  const connections = {
    Version: 3,
    Connections: [{
      Name: 'EntityDataSource',
      ConnectionString: 'Data Source=pbiazure://api.powerbi.com/;Initial Catalog=__DATASET_ID__;Integrated Security=ClaimsToken',
      ConnectionType: 'pbiServiceXmlaStyleLive',
      PbiServiceModelId: null,
      PbiModelVirtualServerName: 'sobe_wowvirtualserver',
      PbiModelDatabaseName: '__DATASET_ID__',
    }],
    RemoteArtifacts: [{ DatasetId: '__DATASET_ID__', ReportId: '__REPORT_ID__' }],
    OriginalWorkspaceObjectId: '__WORKSPACE_ID__',
  };
  return [
    { path: 'Version', utf16: '1.28' },
    { path: '[Content_Types].xml', utf8bom: contentTypes },
    { path: 'Connections', utf8: JSON.stringify(connections) },
    { path: 'Report/Layout', utf16: layout },
    { path: 'Settings', utf16: JSON.stringify({ Version: 4, ReportSettings: {}, QueriesSettings: { TypeDetectionEnabled: true, RelationshipImportEnabled: true, Version: '2.128.184.0' } }) },
    { path: 'Metadata', utf16: JSON.stringify({ Version: 5, AutoCreatedRelationships: [], CreatedFrom: 'Cloud', CreatedFromRelease: '2025.10' }) },
    ...Object.entries(resources).map(([n, d]) => ({ path: `Report/StaticResources/RegisteredResources/${n}`, dataUrl: d })),
    ...customVisualFiles(report).map((f) => ({ path: `Report/${f.path}`, utf8: f.text })),
  ];
}

/** Full semantic model for Fabric: TMSL plus the tables whose data is embedded in their M
 *  (all of them, or only the non-database ones when `keepDb`). Calculated objects keep their DAX. */
export function buildFabricModel(report: Report, tables: TableMeta[], keepDb: boolean) {
  const model = buildModelSchema(report, tables);
  const warnings: string[] = [];
  const embed = tables.filter((t) => !t.source.dax && !report.calcGroups?.some((g) => g.table === t.name) && !(keepDb && t.source.db && t.source.db.kind !== 'sqlite')).map((t) => ({
    table: t.name,
    columns: t.columns.filter((c) => !t.calcColumns?.some((x) => x.name === c.name)).map((c) => ({ name: c.name, m: tomType(c.type).m })),
  }));
  const kept = tables.filter((t) => keepDb && t.source.db && t.source.db.kind !== 'sqlite').map((t) => t.name);
  if (kept.length) warnings.push(`Tabelle collegate al database (${kept.join(', ')}): il servizio deve poter raggiungere il server, altrimenti serve un gateway dati locale.`);
  return { model, embed, warnings };
}
