/**
 * TMSL (model.bim JSON, as built by pbit.ts#buildModelSchema) → TMDL folder (Power BI project "definition/").
 * One file per table, role and culture; database.tmdl, model.tmdl, relationships.tmdl, expressions.tmdl
 * and functions.tmdl at the root. Tabs for indentation, multi-line expressions one level deeper than the
 * object's properties, descriptions as /// comments, collection order kept with "ref" lines in model.tmdl.
 * electron/pbip.cjs#parseTmdl reads the result back.
 */

type Obj = Record<string, any>;

/** Object names and references: quoted when they contain . = : ' or whitespace (TMDL rule), or start with a quote. */
export const tmdlName = (s: string) => (s && !/[.=:'\s]|^"/.test(s) ? s : `'${s.replace(/'/g, "''")}'`);

/** Text property values: double quotes when the value has quotes or leading/trailing spaces. */
const text = (v: string) => (/^\s|\s$|"|^$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

const tabs = (n: number) => '\t'.repeat(n);
const lines = (e: unknown) => (Array.isArray(e) ? e.join('\n') : String(e ?? '')).replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, ''));

/** "= expression" after a declaration or property: same line when single-line, else on lines two tabs
 *  deeper than the declaration/property line (as Power BI Desktop writes them). */
function expr(e: unknown, depth: number): string {
  const ls = lines(e);
  while (ls.length > 1 && !ls[ls.length - 1]) ls.pop();
  while (ls.length > 1 && !ls[0]) ls.shift();
  if (ls.length === 1) return ` = ${ls[0]}`;
  return ' =\n' + ls.map((l) => (l ? tabs(depth) + l : '')).join('\n');
}

function description(d: unknown, depth: number): string {
  if (!d) return '';
  return lines(d).map((l) => `${tabs(depth)}/// ${l}`).join('\n') + '\n';
}

/** Property line (`key: value`, bare key for true). Objects/arrays are handled by the callers. */
function prop(key: string, v: unknown, depth: number): string {
  if (v === undefined || v === null || typeof v === 'object') return '';
  if (v === true) return `${tabs(depth)}${key}\n`;
  return `${tabs(depth)}${key}: ${typeof v === 'string' ? text(v) : String(v)}\n`;
}

const annotations = (o: Obj, depth: number) =>
  (o.annotations ?? []).map((a: Obj) => `\n${tabs(depth)}annotation ${tmdlName(a.name)}${expr(a.value, depth + 2)}\n`).join('');

/** Properties written by the generic loop: everything but children, expressions and special keys. */
function props(o: Obj, depth: number, skip: string[]): string {
  return Object.entries(o).filter(([k]) => !skip.includes(k) && k !== 'name' && k !== 'description' && k !== 'annotations')
    .map(([k, v]) => prop(k, v, depth)).join('');
}

const ref = (t: string, c: string) => `${tmdlName(t)}.${tmdlName(c)}`;

function column(c: Obj, d: number): string {
  const calculated = c.type === 'calculated';
  let s = description(c.description, d) + `${tabs(d)}column ${tmdlName(c.name)}${calculated ? expr(c.expression, d + 2) : ''}\n`;
  s += props(c, d + 1, ['type', 'expression', 'variations', 'sortByColumn']);
  if (c.sortByColumn) s += `${tabs(d + 1)}sortByColumn: ${tmdlName(c.sortByColumn)}\n`;
  for (const v of c.variations ?? []) {
    s += `\n${tabs(d + 1)}variation ${tmdlName(v.name)}\n`;
    if (v.isDefault) s += `${tabs(d + 2)}isDefault\n`;
    if (v.relationship) s += `${tabs(d + 2)}relationship: ${v.relationship}\n`;
    if (v.defaultHierarchy) s += `${tabs(d + 2)}defaultHierarchy: ${ref(v.defaultHierarchy.table, v.defaultHierarchy.hierarchy)}\n`;
  }
  if (c.alternateOf) {
    s += `\n${tabs(d + 1)}alternateOf\n${tabs(d + 2)}summarization: ${c.alternateOf.summarization}\n`;
    if (c.alternateOf.baseColumn) s += `${tabs(d + 2)}baseColumn: ${ref(c.alternateOf.baseColumn.table, c.alternateOf.baseColumn.column)}\n`;
    if (c.alternateOf.baseTable) s += `${tabs(d + 2)}baseTable: ${tmdlName(c.alternateOf.baseTable)}\n`;
  }
  return s + annotations(c, d + 1);
}

function measure(m: Obj, d: number): string {
  let s = description(m.description, d) + `${tabs(d)}measure ${tmdlName(m.name)}${expr(m.expression, d + 2)}\n`;
  s += props(m, d + 1, ['expression', 'formatStringDefinition']);
  if (m.formatStringDefinition) s += `\n${tabs(d + 1)}formatStringDefinition${expr(m.formatStringDefinition.expression, d + 3)}\n`;
  return s + annotations(m, d + 1);
}

function partition(p: Obj, d: number): string {
  const src = p.source ?? {};
  let s = `${tabs(d)}partition ${tmdlName(p.name)} = ${src.type ?? 'm'}\n`;
  if (p.mode) s += `${tabs(d + 1)}mode: ${p.mode}\n`;
  if (p.queryGroup) s += `${tabs(d + 1)}queryGroup: ${tmdlName(p.queryGroup)}\n`;
  if (src.expression !== undefined) s += `${tabs(d + 1)}source${expr(src.expression, d + 3)}\n`;
  return s + annotations(p, d + 1);
}

function hierarchy(h: Obj, d: number): string {
  let s = description(h.description, d) + `${tabs(d)}hierarchy ${tmdlName(h.name)}\n` + props(h, d + 1, ['levels']);
  for (const l of [...(h.levels ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
    s += `\n${tabs(d + 1)}level ${tmdlName(l.name)}\n` + props(l, d + 2, ['ordinal', 'column']) + `${tabs(d + 2)}column: ${tmdlName(l.column)}\n`;
  }
  return s + annotations(h, d + 1);
}

function calendar(c: Obj, d: number): string {
  let s = description(c.description, d) + `${tabs(d)}calendar ${tmdlName(c.name)}\n` + props(c, d + 1, ['calendarColumnGroups']);
  for (const g of c.calendarColumnGroups ?? []) {
    if (g.timeUnit && g.timeUnit !== 'unknown') {
      s += `\n${tabs(d + 1)}calendarColumnGroup = ${g.timeUnit}\n${tabs(d + 2)}primaryColumn: ${tmdlName(g.primaryColumn)}\n`;
      for (const a of g.associatedColumns ?? []) s += `${tabs(d + 2)}associatedColumn: ${tmdlName(a)}\n`;
    } else {
      s += `\n${tabs(d + 1)}calendarColumnGroup\n`;
      for (const a of g.columns ?? []) s += `${tabs(d + 2)}column: ${tmdlName(a)}\n`;
    }
  }
  return s;
}

function table(t: Obj): string {
  let s = description(t.description, 0) + `table ${tmdlName(t.name)}\n`;
  s += props(t, 1, ['columns', 'measures', 'partitions', 'hierarchies', 'calendars', 'calculationGroup', 'refreshPolicy']);
  if (t.calculationGroup) {
    const g = t.calculationGroup;
    s += `\n\tcalculationGroup\n` + props(g, 2, ['calculationItems']);
    for (const it of [...(g.calculationItems ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0))) {
      s += `\n` + description(it.description, 2) + `\t\tcalculationItem ${tmdlName(it.name)}${expr(it.expression, 4)}\n`;
      if (it.formatStringDefinition) s += `\n\t\t\tformatStringDefinition${expr(it.formatStringDefinition.expression, 5)}\n`;
    }
  }
  for (const m of t.measures ?? []) s += '\n' + measure(m, 1);
  for (const c of t.columns ?? []) s += '\n' + column(c, 1);
  for (const h of t.hierarchies ?? []) s += '\n' + hierarchy(h, 1);
  for (const c of t.calendars ?? []) s += '\n' + calendar(c, 1);
  for (const p of t.partitions ?? []) s += '\n' + partition(p, 1);
  if (t.refreshPolicy) {
    const r = t.refreshPolicy;
    s += '\n\trefreshPolicy\n' + props(r, 2, ['sourceExpression', 'pollingExpression']);
    if (r.sourceExpression) s += `\t\tsourceExpression${expr(r.sourceExpression, 4)}\n`;
    if (r.pollingExpression) s += `\n\t\tpollingExpression${expr(r.pollingExpression, 4)}\n`;
  }
  return s + annotations(t, 1);
}

function relationship(r: Obj): string {
  let s = `relationship ${tmdlName(r.name)}\n`;
  s += props(r, 1, ['fromTable', 'fromColumn', 'toTable', 'toColumn']);
  return s + `\tfromColumn: ${ref(r.fromTable, r.fromColumn)}\n\ttoColumn: ${ref(r.toTable, r.toColumn)}\n` + annotations(r, 1);
}

function role(r: Obj): string {
  let s = description(r.description, 0) + `role ${tmdlName(r.name)}\n` + props(r, 1, ['tablePermissions', 'members']);
  for (const p of r.tablePermissions ?? []) {
    s += `\n\ttablePermission ${tmdlName(p.name)}${p.filterExpression ? expr(p.filterExpression, 3) : ''}\n`;
    if (p.metadataPermission) s += `\t\tmetadataPermission: ${p.metadataPermission}\n`;
    for (const c of p.columnPermissions ?? []) s += `\n\t\tcolumnPermission ${tmdlName(c.name)}\n\t\t\tmetadataPermission: ${c.metadataPermission}\n`;
  }
  return s + annotations(r, 1);
}

/** cultures/<name>.tmdl: cultureInfo › translations › model › table › column/measure/hierarchy (caption, description, displayFolder). */
function culture(c: Obj): string {
  const tr = (o: Obj, d: number) =>
    (o.translatedCaption ? `${tabs(d)}caption: ${text(o.translatedCaption)}\n` : '') +
    (o.translatedDescription ? `${tabs(d)}description: ${text(o.translatedDescription)}\n` : '') +
    (o.translatedDisplayFolder ? `${tabs(d)}displayFolder: ${text(o.translatedDisplayFolder)}\n` : '');
  const m = c.translations?.model ?? {};
  let s = `cultureInfo ${tmdlName(c.name)}\n\n\ttranslations\n\n\t\tmodel ${tmdlName(m.name ?? 'Model')}\n` + tr(m, 3);
  for (const t of m.tables ?? []) {
    s += `\n\t\t\ttable ${tmdlName(t.name)}\n` + tr(t, 4);
    for (const kind of ['column', 'measure', 'hierarchy'] as const) {
      for (const x of t[kind === 'hierarchy' ? 'hierarchies' : kind + 's'] ?? []) {
        s += `\n\t\t\t\t${kind} ${tmdlName(x.name)}\n` + tr(x, 5);
        for (const l of x.levels ?? []) s += `\n\t\t\t\t\tlevel ${tmdlName(l.name)}\n` + tr(l, 6);
      }
    }
  }
  return s;
}

/** perspectives/<name>.tmdl: perspectiveTable › perspectiveColumn / perspectiveMeasure / perspectiveHierarchy. */
function perspective(p: Obj): string {
  let s = description(p.description, 0) + `perspective ${tmdlName(p.name)}\n`;
  for (const t of p.perspectiveTables ?? []) {
    s += `\n\tperspectiveTable ${tmdlName(t.name)}\n`;
    for (const [k, list] of [['perspectiveColumn', t.perspectiveColumns], ['perspectiveMeasure', t.perspectiveMeasures], ['perspectiveHierarchy', t.perspectiveHierarchies]] as const) {
      for (const x of list ?? []) s += `\t\t${k} ${tmdlName(x.name)}\n`;
    }
  }
  return s;
}

/** File name of a table/role/culture: the object name with characters invalid in file names replaced. */
const fileName = (n: string) => n.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');

/** TMSL database → { "database.tmdl": text, "tables/X.tmdl": text, … } (paths inside definition/). */
export function tmslToTmdl(db: Obj): Record<string, string> {
  const model: Obj = db.model ?? {};
  const out: Record<string, string> = {};
  out['database.tmdl'] = `database\n\tcompatibilityLevel: ${db.compatibilityLevel ?? 1550}\n\tcompatibilityMode: powerBI\n`;

  let m = `model Model\n` + props(model, 1, ['tables', 'relationships', 'expressions', 'roles', 'cultures', 'functions', 'dataAccessOptions', 'perspectives', 'dataSources', 'queryGroups']);
  if (model.dataAccessOptions) m += '\tdataAccessOptions\n' + Object.entries(model.dataAccessOptions).map(([k, v]) => prop(k, v, 2)).join('');
  m += annotations(model, 0);
  for (const g of model.queryGroups ?? []) m += `\nqueryGroup ${tmdlName(g.folder)}\n`;
  const refs = (kind: string, list: Obj[] | undefined) => (list && list.length > 1 ? '\n' + list.map((x) => `ref ${kind} ${tmdlName(x.name)}\n`).join('') : '');
  m += refs('table', model.tables) + refs('perspective', model.perspectives) + refs('role', model.roles) + refs('cultureInfo', model.cultures);
  out['model.tmdl'] = m;

  for (const t of model.tables ?? []) out[`tables/${fileName(t.name)}.tmdl`] = table(t);
  if (model.relationships?.length) out['relationships.tmdl'] = model.relationships.map(relationship).join('\n');
  if (model.expressions?.length) {
    out['expressions.tmdl'] = model.expressions.map((e: Obj) =>
      description(e.description, 0) + `expression ${tmdlName(e.name)}${expr(e.expression, 2)}\n` + props(e, 1, ['expression', 'kind']) + annotations(e, 1)).join('\n');
  }
  if (model.functions?.length) {
    out['functions.tmdl'] = model.functions.map((f: Obj) =>
      description(f.description, 0) + `function ${tmdlName(f.name)}${expr(f.expression, 2)}\n` + props(f, 1, ['expression']) + annotations(f, 1)).join('\n');
  }
  for (const p of model.perspectives ?? []) out[`perspectives/${fileName(p.name)}.tmdl`] = perspective(p);
  for (const r of model.roles ?? []) out[`roles/${fileName(r.name)}.tmdl`] = role(r);
  for (const c of model.cultures ?? []) out[`cultures/${fileName(c.name)}.tmdl`] = culture(c);
  return out;
}
