// Power BI Project (.pbip): a folder-based, text-only format (no data).
//   X.pbip                       → { artifacts: [{ report: { path: "X.Report" } }] }
//   X.Report/definition.pbir     → { datasetReference: { byPath: { path: "../X.SemanticModel" } } }
//   X.Report/report.json         → legacy Report/Layout JSON   (or)
//   X.Report/definition/…        → PBIR: report.json, pages/<id>/page.json, pages/<id>/visuals/<id>/visual.json
//   X.SemanticModel/model.bim    → TMSL JSON (same as DataModelSchema)   (or)
//   X.SemanticModel/definition/  → TMDL text files (model.tmdl, relationships.tmdl, tables/*.tmdl)
// read() returns the same structure as electron/pbix/read_pbix.py (model.json).
const fs = require('fs');
const path = require('path');

const SKIP_TABLE = /^(LocalDateTable_|DateTableTemplate_)/;
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const joinExpr = (e) => (Array.isArray(e) ? e.join('\n') : e ?? '');

/* ------------------------------- TMSL (JSON) ------------------------------- */

function fromTmsl(schema, out) {
  const model = schema.model ?? {};
  for (const t of model.tables ?? []) {
    if (SKIP_TABLE.test(t.name)) continue;
    let m = null, dax = null;
    for (const p of t.partitions ?? []) {
      const src = p.source ?? {};
      if (src.expression === undefined) continue;
      if (src.type === 'calculated') dax = joinExpr(src.expression); else m = joinExpr(src.expression);
    }
    pushTable(out, t.name, m, dax, t.columns ?? [], t.measures ?? [], (c) => c.type);
  }
  for (const r of model.relationships ?? []) pushRel(out, r);
  pushParams(out, (model.expressions ?? []).map((e) => ({ name: e.name, expression: joinExpr(e.expression), description: e.description })));
  const mx = extras(out);
  pushQueries(mx, (model.expressions ?? []).map((e) => ({ name: e.name, code: joinExpr(e.expression), group: e.queryGroup, kind: e.kind })), (model.tables ?? []).map((t) => ({ name: t.name, group: (t.partitions ?? []).find((p) => p.queryGroup)?.queryGroup })));
  for (const t of model.tables ?? []) {
    for (const h of t.hierarchies ?? []) {
      mx.hierarchies.push({ table: t.name, name: h.name, levels: [...(h.levels ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).map((l) => ({ name: l.name, column: l.column })) });
      if (h.displayFolder) mx.folders.push({ table: t.name, name: h.name, folder: h.displayFolder });
    }
    for (const c of [...(t.columns ?? []), ...(t.measures ?? [])]) if (c.displayFolder) mx.folders.push({ table: t.name, name: c.name, folder: c.displayFolder });
    const key = (t.columns ?? []).find((c) => c.isKey === true);
    if (t.dataCategory === 'Time' && key) mx.dateTables[t.name] = key.name;
    if (t.calculationGroup) {
      const col = (t.columns ?? []).find((c) => c.name !== 'Ordinal' && c.type !== 'rowNumber')?.name ?? 'Name';
      mx.calcGroups.push({
        table: t.name, column: col, precedence: Number(t.calculationGroup.precedence ?? 0),
        items: [...(t.calculationGroup.calculationItems ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0)).map((i) => ({
          name: i.name, expression: joinExpr(i.expression), ...(i.formatStringDefinition ? { formatString: joinExpr(i.formatStringDefinition.expression) } : {}),
        })),
      });
    }
  }
  for (const f of model.functions ?? []) mx.functions.push({ name: f.name, expression: joinExpr(f.expression), ...(f.description ? { description: joinExpr(f.description) } : {}) });
  for (const t of model.tables ?? []) {
    for (const c of t.calendars ?? []) {
      mx.calendars.push({
        name: c.name, table: t.name, ...(c.description ? { description: joinExpr(c.description) } : {}),
        groups: (c.calendarColumnGroups ?? []).map((g) => (g.timeUnit && g.timeUnit !== 'unknown'
          ? { unit: g.timeUnit[0].toLowerCase() + g.timeUnit.slice(1), primary: g.primaryColumn, ...(g.associatedColumns?.length ? { associated: g.associatedColumns } : {}) }
          : { unit: null, associated: [...(g.columns ?? [])] })),
      });
    }
  }
  for (const r of model.roles ?? []) mx.roles.push({ name: r.name, filters: (r.tablePermissions ?? []).filter((p) => joinExpr(p.filterExpression).trim()).map((p) => ({ table: p.name, expression: joinExpr(p.filterExpression) })) });
  for (const c of model.cultures ?? []) {
    const tables = (c.translations?.model?.tables ?? []).map((t) => ({
      name: t.name, caption: t.translatedCaption, description: t.translatedDescription, folder: t.translatedDisplayFolder,
      items: [...(t.columns ?? []), ...(t.measures ?? []), ...(t.hierarchies ?? [])].map((x) => ({ name: x.name, caption: x.translatedCaption, description: x.translatedDescription, folder: x.translatedDisplayFolder })),
    }));
    pushCulture(mx, c.name, tables);
  }
}

/** Culture → { name, captions, descriptions, folders } keyed "Table" / "Table\u0001Field" (MiB-BI Report.cultures). */
function pushCulture(mx, name, tables) {
  const c = { name, captions: {}, descriptions: {}, folders: {} };
  const put = (key, x) => {
    if (x.caption) c.captions[key] = x.caption;
    if (x.description) c.descriptions[key] = x.description;
    if (x.folder) c.folders[key] = x.folder;
  };
  for (const t of tables) { put(t.name, t); for (const x of t.items) put(`${t.name}\u0001${x.name}`, x); }
  for (const k of ['descriptions', 'folders']) if (!Object.keys(c[k]).length) delete c[k];
  mx.cultures.push(c);
}

/** Connection-only queries (shared M expressions that are not parameters) and query groups. */
function pushQueries(mx, exprs, tables) {
  for (const e of exprs) {
    if ((e.kind ?? 'm') === 'm' && !/IsParameterQuery\s*=\s*true/i.test(e.code ?? '')) mx.queries.push({ name: e.name, code: e.code });
    if (e.group) mx.groups[e.name] = unquote(e.group);
  }
  for (const t of tables) if (t.group) mx.groups[t.name] = unquote(t.group);
}

/** Model properties besides tables/relationships/measures (same shape as read_pbix.py). */
function extras(out) {
  out.model ??= { hierarchies: [], folders: [], dateTables: {}, calcGroups: [], roles: [], functions: [], calendars: [], cultures: [], queries: [], groups: {} };
  return out.model;
}

function pushTable(out, name, m, dax, columns, measures, kindOf) {
  const real = columns.filter((c) => kindOf(c) !== 'rowNumber' && !String(c.name).startsWith('RowNumber-'));
  const allHidden = real.length > 0 && real.every((c) => c.isHidden === true || c.isHidden === 'true');
  const measureTable = measures.length > 0 && (allHidden || real.length === 0) && !dax;
  if (!measureTable) {
    out.tables.push({
      name, parquet: null, rows: 0, m,
      columns: real.filter((c) => kindOf(c) !== 'calculated').map((c) => ({ name: c.name, dataType: c.dataType ?? 'string' })),
      sortBy: Object.fromEntries(real.filter((c) => c.sortByColumn).map((c) => [c.name, c.sortByColumn])),
      dataCategory: Object.fromEntries(real.filter((c) => c.dataCategory && !['Uncategorized', 'Regular'].includes(String(c.dataCategory))).map((c) => [c.name, String(c.dataCategory)])),
      ...(dax ? { dax } : {}),
      ...(real.some((c) => kindOf(c) === 'calculated') ? { calcColumns: real.filter((c) => kindOf(c) === 'calculated').map((c) => ({ name: c.name, expression: joinExpr(c.expression) })) } : {}),
    });
  }
  for (const ms of measures) out.measures.push({ table: name, name: ms.name, expression: joinExpr(ms.expression), formatString: ms.formatString ?? '' });
}

/** Power Query parameters: shared expressions flagged IsParameterQuery. */
function pushParams(out, exprs) {
  out.parameters = (out.parameters ?? []).concat(exprs.filter((e) => /IsParameterQuery\s*=\s*true/i.test(e.expression ?? '')));
}

function pushRel(out, r) {
  const fc = r.fromCardinality ?? 'many', tc = r.toCardinality ?? 'one';
  out.relationships.push({
    fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn,
    cardinality: fc === 'one' && tc === 'one' ? 'oneToOne' : tc === 'many' ? 'manyToMany' : 'manyToOne',
    crossFilter: r.crossFilteringBehavior === 'bothDirections' ? 'both' : 'single',
    active: r.isActive !== false && r.isActive !== 'false',
    securityBoth: r.securityFilteringBehavior === 'bothDirections',
  });
}

/* ------------------------------- TMDL (text) ------------------------------- */

/** Name at the start of `s`: 'quoted ''name''' or a bare token. Returns [name, rest]. */
function takeName(s) {
  s = s.trimStart();
  if (s.startsWith("'")) {
    let i = 1, name = '';
    while (i < s.length) {
      if (s[i] === "'") { if (s[i + 1] === "'") { name += "'"; i += 2; continue; } i++; break; }
      name += s[i++];
    }
    return [name, s.slice(i)];
  }
  const m = /^[^\s=:.]+/.exec(s);
  return [m ? m[0] : '', s.slice(m ? m[0].length : 0)];
}

/** "Table.Column" with optional quotes on each part. */
function tableColumn(s) {
  const [t, rest] = takeName(s);
  const [c] = takeName(rest.replace(/^\./, ''));
  return [t, c];
}

const indentOf = (line) => /^\t*/.exec(line)[0].length + Math.floor(/^\t*( *)/.exec(line)[1].length / 4);

/**
 * Parses TMDL into objects { kind, name, value (text after "="), props: {k: v}, children: [] }.
 * Multi-line values: lines indented deeper than the declaration's properties, or ``` fenced blocks.
 */
function parseTmdl(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const root = { kind: 'root', children: [], props: {}, indent: -1 };
  const stack = [root];
  let i = 0;
  let doc = [];
  const block = (start, baseIndent, firstLine) => {
    // Collect an expression that continues on the following, deeper-indented lines.
    const out = [];
    let j = start;
    if (firstLine.trim().startsWith('```')) {
      const after = firstLine.trim().slice(3);
      if (after) out.push(after);
      while (j < lines.length && !lines[j].trim().startsWith('```')) out.push(lines[j++]);
      return [dedent(out), j + 1];
    }
    if (firstLine.trim()) out.push(firstLine.trim());
    while (j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > baseIndent + 1)) out.push(lines[j++]);
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return [dedent(out), j];
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    i++;
    if (t.startsWith('///')) { doc.push(t.slice(3).replace(/^ /, '')); continue; }
    if (!t || t.startsWith('//')) { if (t) doc = []; continue; }
    const ind = indentOf(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= ind) stack.pop();
    const parent = stack[stack.length - 1];
    const kw = /^(table|column|measure|partition|relationship|hierarchy|level|annotation|expression|model|database|role|tablePermission|culture|calculationGroup|calculationItem|perspective|dataSource|ref|cultureInfo|linguisticMetadata|variation|changedProperty|extendedProperty|queryGroup|function|calendar|calendarColumnGroup)\b(?!\s*:)\s*(.*)$/.exec(t);
    if (kw) {
      const [name, rest] = takeName(kw[2]);
      const obj = { kind: kw[1], name, props: {}, children: [], indent: ind, ...(doc.length ? { description: doc.join('\n') } : {}) };
      doc = [];
      const eq = /^\s*=\s*(.*)$/.exec(rest);
      if (eq) {
        const [value, next] = block(i, ind, eq[1]);
        obj.value = value;
        i = next;
      }
      parent.children.push(obj);
      stack.push(obj);
      continue;
    }
    doc = [];
    const prop = /^([A-Za-z][\w]*)\s*(:|=)\s*(.*)$/.exec(t);
    if (prop) {
      if (prop[2] === '=') {
        const [value, next] = block(i, ind, prop[3]);
        parent.props[prop[1]] = value;
        i = next;
      } else {
        // Text values may be double-quoted ("" escapes a quote).
        const v = prop[3].trim().replace(/^"([\s\S]*)"$/, (_m, x) => x.replace(/""/g, '"'));
        parent.props[prop[1]] = v;
        // Repeated properties (calendar associatedColumn / column) keep every value.
        (parent.multi ??= {})[prop[1]] = [...(parent.multi[prop[1]] ?? []), v];
      }
      continue;
    }
    if (/^[A-Za-z]\w*$/.test(t)) parent.props[t] = 'true'; // flags like "isHidden"
  }
  return root;
}

function dedent(lines) {
  const nonEmpty = lines.filter((l) => l.trim());
  const min = Math.min(...nonEmpty.map((l) => /^[\t ]*/.exec(l)[0].length), Infinity);
  return lines.map((l, k) => (k === 0 ? l.trim() : l.slice(Number.isFinite(min) ? min : 0))).join('\n').trim();
}

const unquote = (v) => (v && /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v);

function fromTmdl(dir, out) {
  const files = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (f.endsWith('.tmdl')) files.push(p); } };
  walk(dir);
  const objs = files.flatMap((f) => parseTmdl(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')).children);
  for (const t of objs.filter((o) => o.kind === 'table')) {
    if (SKIP_TABLE.test(t.name)) continue;
    let m = null, dax = null;
    for (const p of t.children.filter((c) => c.kind === 'partition')) {
      const kind = (p.value ?? '').trim();
      const src = p.props.source ?? '';
      if (kind === 'calculated') dax = src; else if (kind === 'm' || src) m = src;
    }
    const columns = t.children.filter((c) => c.kind === 'column').map((c) => ({
      name: c.name, dataType: c.props.dataType, isHidden: c.props.isHidden, sortByColumn: unquote(c.props.sortByColumn), dataCategory: unquote(c.props.dataCategory),
      type: c.value ? 'calculated' : undefined, expression: c.value,
    }));
    const measures = t.children.filter((c) => c.kind === 'measure').map((c) => ({ name: c.name, expression: c.value ?? '', formatString: c.props.formatString }));
    pushTable(out, t.name, m, dax, columns, measures, (c) => c.type);
  }
  pushParams(out, objs.filter((o) => o.kind === 'expression').map((e) => ({ name: e.name, expression: e.value ?? '', description: e.description ?? e.props.description })));
  const mx = extras(out);
  pushQueries(mx, objs.filter((o) => o.kind === 'expression').map((e) => ({ name: e.name, code: e.value ?? '', group: e.props.queryGroup })),
    objs.filter((o) => o.kind === 'table').map((t) => ({ name: t.name, group: t.children.find((c) => c.kind === 'partition' && c.props.queryGroup)?.props.queryGroup })));
  for (const t of objs.filter((o) => o.kind === 'table')) {
    for (const h of t.children.filter((c) => c.kind === 'hierarchy')) {
      mx.hierarchies.push({ table: t.name, name: h.name, levels: h.children.filter((l) => l.kind === 'level').map((l) => ({ name: l.name, column: unquote(l.props.column) ?? l.name })) });
      if (h.props.displayFolder) mx.folders.push({ table: t.name, name: h.name, folder: unquote(h.props.displayFolder) });
    }
    for (const c of t.children.filter((x) => x.kind === 'column' || x.kind === 'measure')) if (c.props.displayFolder) mx.folders.push({ table: t.name, name: c.name, folder: unquote(c.props.displayFolder) });
    const key = t.children.find((c) => c.kind === 'column' && c.props.isKey === 'true');
    if (unquote(t.props.dataCategory) === 'Time' && key) mx.dateTables[t.name] = key.name;
    for (const c of t.children.filter((x) => x.kind === 'calendar')) {
      mx.calendars.push({
        name: c.name, table: t.name, ...(c.description ? { description: c.description } : {}),
        groups: c.children.filter((g) => g.kind === 'calendarColumnGroup').map((g) => {
          const unit = (g.value ?? '').trim();
          const many = (k) => (g.multi?.[k] ?? []).map(unquote);
          return unit ? { unit, primary: unquote(g.props.primaryColumn), ...(many('associatedColumn').length ? { associated: many('associatedColumn') } : {}) } : { unit: null, associated: many('column') };
        }),
      });
    }
    const cg = t.children.find((c) => c.kind === 'calculationGroup');
    if (cg) {
      const col = t.children.find((c) => c.kind === 'column' && c.name !== 'Ordinal')?.name ?? 'Name';
      mx.calcGroups.push({
        table: t.name, column: col, precedence: Number(cg.props.precedence ?? 0),
        items: cg.children.filter((i) => i.kind === 'calculationItem').map((i) => ({ name: i.name, expression: i.value ?? '', ...(i.props.formatStringDefinition ? { formatString: i.props.formatStringDefinition } : {}) })),
      });
    }
  }
  for (const f of objs.filter((o) => o.kind === 'function')) mx.functions.push({ name: f.name, expression: f.value ?? '', ...(f.description ? { description: f.description } : {}) });
  for (const c of objs.filter((o) => o.kind === 'cultureInfo')) {
    const model = c.children.find((x) => x.kind === 'model');
    const tables = (model?.children ?? []).filter((t) => t.kind === 'table').map((t) => ({
      name: t.name, caption: unquote(t.props.caption), description: unquote(t.props.description), folder: unquote(t.props.displayFolder),
      items: t.children.filter((x) => ['column', 'measure', 'hierarchy'].includes(x.kind)).map((x) => ({ name: x.name, caption: unquote(x.props.caption), description: unquote(x.props.description), folder: unquote(x.props.displayFolder) })),
    }));
    pushCulture(mx, c.name, tables);
  }
  for (const r of objs.filter((o) => o.kind === 'role')) {
    mx.roles.push({ name: r.name, filters: r.children.filter((p) => p.kind === 'tablePermission' && (p.value ?? '').trim()).map((p) => ({ table: p.name, expression: p.value })) });
  }
  for (const r of objs.filter((o) => o.kind === 'relationship')) {
    const [ft, fc] = tableColumn(r.props.fromColumn ?? '');
    const [tt, tc] = tableColumn(r.props.toColumn ?? '');
    pushRel(out, { fromTable: ft, fromColumn: fc, toTable: tt, toColumn: tc, fromCardinality: r.props.fromCardinality, toCardinality: r.props.toCardinality, crossFilteringBehavior: r.props.crossFilteringBehavior, securityFilteringBehavior: r.props.securityFilteringBehavior, isActive: r.props.isActive });
  }
}

/* --------------------------------- reader --------------------------------- */

function mimeOf(f) {
  const ext = path.extname(f).toLowerCase();
  return { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.json': 'application/json' }[ext];
}

function read(file) {
  const base = path.dirname(file);
  const pbip = readJson(file);
  const out = { file, kind: 'pbip', tables: [], relationships: [], measures: [], layout: null, resources: {}, customVisuals: [], warnings: [] };
  const rel = pbip.artifacts?.find((a) => a.report)?.report?.path;
  if (!rel) throw new Error('Il file .pbip non indica la cartella del report');
  const reportDir = path.resolve(base, rel);
  const pbir = fs.existsSync(path.join(reportDir, 'definition.pbir')) ? readJson(path.join(reportDir, 'definition.pbir')) : {};
  const modelRel = pbir.datasetReference?.byPath?.path;
  if (!modelRel) out.warnings.push('Il report usa un modello remoto (byConnection): vengono importate solo le pagine.');

  // Report: PBIR folder or legacy report.json
  const defDir = path.join(reportDir, 'definition');
  if (fs.existsSync(defDir)) {
    out.pbir = {};
    const walk = (d) => {
      for (const f of fs.readdirSync(d)) {
        const p = path.join(d, f);
        if (fs.statSync(p).isDirectory()) walk(p);
        else if (f.endsWith('.json')) out.pbir[path.relative(defDir, p).split(path.sep).join('/')] = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
      }
    };
    walk(defDir);
  } else if (fs.existsSync(path.join(reportDir, 'report.json'))) {
    out.layout = fs.readFileSync(path.join(reportDir, 'report.json'), 'utf8').replace(/^﻿/, '');
  }
  const resDir = path.join(reportDir, 'StaticResources', 'RegisteredResources');
  if (fs.existsSync(resDir)) {
    for (const f of fs.readdirSync(resDir)) {
      const mime = mimeOf(f);
      const p = path.join(resDir, f);
      if (mime && fs.statSync(p).size <= 6 * 1024 * 1024) out.resources[f] = `data:${mime};base64,${fs.readFileSync(p).toString('base64')}`;
    }
  }

  // Custom visuals: CustomVisuals/<guid>/package.json + resources/<guid>.pbiviz.json
  const cvDir = path.join(reportDir, 'CustomVisuals');
  if (fs.existsSync(cvDir)) {
    for (const guid of fs.readdirSync(cvDir)) {
      const resDir = path.join(cvDir, guid, 'resources');
      const res = fs.existsSync(resDir) ? fs.readdirSync(resDir).find((f) => f.endsWith('.pbiviz.json')) : undefined;
      if (!res) continue;
      try {
        const pkgFile = path.join(cvDir, guid, 'package.json');
        out.customVisuals.push({ guid, pbiviz: readJson(path.join(resDir, res)), ...(fs.existsSync(pkgFile) ? { package: readJson(pkgFile) } : {}) });
      } catch { out.warnings.push(`Oggetto visivo personalizzato ${guid} non leggibile.`); }
    }
  }

  // Semantic model: model.bim (TMSL) or definition/*.tmdl
  if (modelRel) {
    const modelDir = path.resolve(reportDir, modelRel);
    if (fs.existsSync(path.join(modelDir, 'model.bim'))) fromTmsl(readJson(path.join(modelDir, 'model.bim')), out);
    else if (fs.existsSync(path.join(modelDir, 'definition'))) fromTmdl(path.join(modelDir, 'definition'), out);
    else out.warnings.push(`Modello semantico non trovato in ${modelDir}`);
    const names = new Set(out.tables.map((t) => t.name));
    out.relationships = out.relationships.filter((r) => names.has(r.fromTable) && names.has(r.toTable));
  }
  return out;
}

/* --------------------------------- writer --------------------------------- */

/** Writes a PBIP project next to `file` (X.pbip, X.Report/, X.SemanticModel/) from text/data-URL parts. */
function write(file, parts) {
  const base = path.dirname(file);
  // Saving over a project: drop the report/model definitions of either format, so no stale page,
  // visual or table survives (Power BI would load files that are no longer part of the report).
  const name = path.basename(file, path.extname(file));
  for (const p of [`${name}.Report/definition`, `${name}.Report/report.json`, `${name}.SemanticModel/definition`, `${name}.SemanticModel/model.bim`]) {
    fs.rmSync(path.join(base, p), { recursive: true, force: true });
  }
  for (const p of parts) {
    const dest = path.join(base, p.path);
    if (!dest.startsWith(base)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (p.text !== undefined) fs.writeFileSync(dest, p.text);
    else if (p.dataUrl) fs.writeFileSync(dest, Buffer.from(p.dataUrl.split(',')[1], 'base64'));
  }
  return file;
}

module.exports = { read, write, parseTmdl };
