// DuckDB engine: plays the role of VertiPaq. One in-memory database per session.
const path = require('path');
const { DuckDBInstance } = require('@duckdb/node-api');

let conn = null;
let instance = null;

async function instanceOf() {
  if (!instance) instance = await DuckDBInstance.create(':memory:');
  return instance;
}

async function connection() {
  if (!conn) {
    conn = await (await instanceOf()).connect();
    // Nested DAX measures compile to deeply nested SQL.
    await conn.run('SET max_expression_depth TO 20000');
  }
  return conn;
}

const qi = (name) => '"' + String(name).replace(/"/g, '""') + '"';
const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";

function kindOf(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') return 'csv';
  if (ext === '.json' || ext === '.ndjson' || ext === '.jsonl') return 'json';
  if (ext === '.parquet') return 'parquet';
  if (ext === '.xlsx') return 'excel';
  throw new Error('Formato file non supportato: ' + ext);
}

async function sourceExpr(file, sheet) {
  const kind = kindOf(file);
  if (kind === 'csv') return `read_csv_auto(${ql(file)})`;
  if (kind === 'json') return `read_json_auto(${ql(file)})`;
  if (kind === 'parquet') return `read_parquet(${ql(file)})`;
  const c = await connection();
  await c.run('INSTALL excel; LOAD excel;');
  return sheet ? `read_xlsx(${ql(file)}, sheet = ${ql(sheet)})` : `read_xlsx(${ql(file)})`;
}

/** Result reader (column names/types + rows) for callers that need the DuckDB types (M interpreter). */
async function raw(sql) {
  const c = await connection();
  return c.runAndReadAll(sql);
}
async function run(sql) {
  const c = await connection();
  await c.run(sql);
}

async function query(sql) {
  const c = await connection();
  const reader = await c.runAndReadAll(sql);
  return { columns: reader.columnNames(), rows: reader.getRowObjectsJson() };
}

// Visualizza come ruolo (RLS): the restricted tables are copied to schema "rls" and report queries run
// on a second connection whose search_path puts rls before main (DAX ALL() cannot remove the filter).
let roleConn = null;
let roleOn = false;

let roleChain = Promise.resolve();

/** Serialized: a role change and the re-apply after a data reload must not interleave their DROP/CREATE. */
function setRole(tables) {
  const run = roleChain.then(() => applyRole(tables));
  roleChain = run.catch(() => {});
  return run;
}

async function applyRole(tables) {
  const c = await connection();
  roleOn = false;
  await c.run('DROP SCHEMA IF EXISTS rls CASCADE');
  if (!Array.isArray(tables) || !tables.length) return;
  try {
    await c.run('CREATE SCHEMA rls');
    for (const t of tables) {
      await c.run(`CREATE TABLE rls.${qi(t.table)} AS SELECT r.* FROM main.${qi(t.table)} r WHERE ${t.where}`);
    }
    if (!roleConn) {
      roleConn = await (await instanceOf()).connect();
      await roleConn.run('SET max_expression_depth TO 20000');
    }
    await roleConn.run("SET search_path = 'rls,main'");
    roleOn = true;
  } catch (e) {
    // Never leave a half-built role active: queries go back to the full data.
    await c.run('DROP SCHEMA IF EXISTS rls CASCADE').catch(() => {});
    throw e;
  }
}

async function queryAs(sql) {
  if (!roleOn || !roleConn) return query(sql);
  const reader = await roleConn.runAndReadAll(sql);
  return { columns: reader.columnNames(), rows: reader.getRowObjectsJson() };
}

async function preview(file, sheet) {
  const expr = await sourceExpr(file, sheet);
  return query(`SELECT * FROM ${expr} LIMIT 50`);
}

async function describe(table) {
  const res = await query(`DESCRIBE ${qi(table)}`);
  const count = await query(`SELECT COUNT(*) AS n FROM ${qi(table)}`);
  return {
    name: table,
    rowCount: Number(count.rows[0].n),
    columns: res.rows.map((r) => ({ name: r.column_name, type: r.column_type })),
  };
}

async function importFile(file, tableName, sheet) {
  const expr = await sourceExpr(file, sheet);
  const c = await connection();
  await c.run(`CREATE OR REPLACE TABLE ${qi(tableName)} AS SELECT * FROM ${expr}`);
  return describe(tableName);
}

// Power Query result (SQL compiled by src/pq/compile.ts) materialised as a model table.
async function materialize(tableName, sql) {
  const c = await connection();
  await c.run(`CREATE OR REPLACE TABLE ${qi(tableName)} AS ${sql}`);
  return describe(tableName);
}

// Calculated column: rebuilds the table with the column appended (row order kept).
async function addCalcColumn(table, column, expr, replace) {
  const c = await connection();
  const tmp = '__mibbi_calc';
  await c.run(`CREATE OR REPLACE TABLE ${qi(tmp)} AS SELECT r.*${replace ? ` EXCLUDE (${qi(column)})` : ''}, (${expr}) AS ${qi(column)} FROM ${qi(table)} r ORDER BY r.rowid`);
  await c.run(`DROP TABLE ${qi(table)}`);
  await c.run(`ALTER TABLE ${qi(tmp)} RENAME TO ${qi(table)}`);
  return describe(table);
}

async function dropColumn(table, column) {
  const c = await connection();
  await c.run(`ALTER TABLE ${qi(table)} DROP COLUMN ${qi(column)}`);
  return describe(table);
}

async function exportParquet(table, file) {
  const c = await connection();
  await c.run(`COPY (SELECT * FROM ${qi(table)}) TO ${ql(file)} (FORMAT parquet, COMPRESSION zstd)`);
}

async function dropTable(name) {
  const c = await connection();
  await c.run(`DROP TABLE IF EXISTS ${qi(name)}`);
}

// Empty typed table: schema-only imports (.pbit whose sources are not reachable).
const TOM_TYPES = { int64: 'BIGINT', double: 'DOUBLE', decimal: 'DOUBLE', boolean: 'BOOLEAN', dateTime: 'TIMESTAMP', string: 'VARCHAR' };
async function createEmpty(table, columns) {
  const c = await connection();
  const cols = columns.map((x) => `${qi(x.name)} ${TOM_TYPES[x.dataType] || 'VARCHAR'}`).join(', ');
  await c.run(`CREATE OR REPLACE TABLE ${qi(table)} (${cols || '"_" VARCHAR'})`);
  return describe(table);
}

/** Immetti dati: the typed values as a VALUES table (text columns). */
function inlineExpr(inline) {
  const cols = inline.columns.map((c) => '"' + String(c).replace(/"/g, '""') + '"');
  const val = (v) => (v === null || v === undefined || v === '' ? 'NULL::VARCHAR' : ql(v));
  if (!inline.rows.length) return `(SELECT ${cols.map((c) => `NULL::VARCHAR AS ${c}`).join(', ')} WHERE false)`;
  return `(SELECT * FROM (VALUES ${inline.rows.map((r) => `(${inline.columns.map((_, i) => val(r[i])).join(', ')})`).join(', ')}) AS t(${cols.join(', ')}))`;
}

module.exports = { raw, run, query, queryAs, setRole, preview, importFile, materialize, sourceExpr, inlineExpr, addCalcColumn, dropColumn, describe, exportParquet, dropTable, createEmpty, kindOf };
