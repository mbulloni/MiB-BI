// Database sources (Get Data › Database): MySQL/MariaDB, PostgreSQL, SQLite through DuckDB's
// scanner extensions (ATTACH … READ_ONLY); SQL Server, Oracle, Snowflake, BigQuery, Databricks, ClickHouse, MongoDB
// and Access through Node drivers (drivers.cjs) cached as Parquet. Passwords never go into reports: they are kept in
// <userData>/credentials.json, encrypted with Electron safeStorage (system keyring) when available,
// otherwise only for the current session — like Power BI's data source credentials.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, safeStorage } = require('electron');
const db = require('./db.cjs');
const { ADAPTERS, fetchToParquet, cacheKey } = require('./drivers.cjs');

const qi = (s) => '"' + String(s).replace(/"/g, '""') + '"';
const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const session = new Map();
const attached = new Map();

const credFile = () => path.join(app.getPath('userData'), 'credentials.json');

/** Identity of a connection (no password): also the key of its stored credentials. */
function keyOf(c) {
  if (c.kind === 'sqlite' || c.kind === 'access') return `${c.kind}://${c.file}`;
  if (c.kind === 'bigquery') return `bigquery://${c.database ?? ''}@${c.file ?? 'adc'}`;
  const extra = c.auth && c.auth !== 'sql' ? `;auth=${c.auth}${c.domain ? `;domain=${c.domain}` : ''}` : '';
  return `${c.kind}://${c.user ?? ''}@${c.host ?? 'localhost'}:${c.port ?? ''}/${c.database ?? ''}${c.httpPath ? c.httpPath : ''}${extra}`;
}

// ---- Node-driver sources ----
const handles = new Map();   // key -> driver handle (one per session)
const fetched = new Map();   // cache file -> true once loaded in this session
const cacheDir = () => { const d = path.join(app.getPath('userData'), 'db-cache'); fs.mkdirSync(d, { recursive: true }); return d; };

async function secretOf(c, password) {
  if (c.auth === 'token') return require('./powerbi.cjs').token('sql'); // Microsoft Entra: MiB-BI's own account
  if (c.auth === 'adc' || ['access', 'bigquery', 'kusto', 'dataverse'].includes(c.kind)) return undefined;
  const pw = password ?? passwordOf(c);
  if (pw === undefined && ((c.user && c.kind !== 'odbc') || c.kind === 'databricks')) {
    const err = new Error(`Credenziali mancanti per ${keyOf(c)}. Ricollegarsi da Ottieni dati › Database.`);
    err.code = 'NO_CREDENTIALS';
    throw err;
  }
  return pw;
}

async function driverHandle(c, password) {
  const key = keyOf(c);
  if (handles.has(key) && password === undefined) return handles.get(key);
  if (handles.has(key)) { await Promise.resolve(ADAPTERS[c.kind].close(handles.get(key))).catch(() => {}); handles.delete(key); }
  const h = await ADAPTERS[c.kind].open(c, await secretOf(c, password));
  handles.set(key, h);
  return h;
}

/** SQL of a source: its native statement (Istruzione SQL) or the whole table. */
const sourceSql = (c) => c.query || ADAPTERS[c.kind].select(c.schema, c.table);

/** First rows of a table or statement for the navigator / statement preview. */
async function preview(c, limit = 50) {
  if (!ADAPTERS[c.kind]) {
    const alias = await attach(c);
    const from = c.query ? nativeFrom(c, alias) : `${qi(alias)}.${qi(c.schema)}.${qi(c.table)}`;
    return db.query(`SELECT * FROM ${from} LIMIT ${limit}`);
  }
  const h = await driverHandle(c);
  const rows = [];
  let cols = [];
  const show = (v, type) => {
    if (v === null || v === undefined) return null;
    if (v instanceof Date) {
      const t = v.toISOString().replace('T', ' ').replace(/\.000Z$|Z$/, '');
      return type === 'DATE' ? t.slice(0, 10) : type === 'TIME' ? t.slice(11) : t;
    }
    if (Buffer.isBuffer(v)) return `<${v.length} byte>`;
    if (typeof v === 'number' && type === 'FLOAT') return Number(v.toPrecision(7));
    if (typeof v === 'object') return v.constructor?.name === 'Big' || typeof v.toFixed === 'function' ? v.toString() : JSON.stringify(v);
    return v;
  };
  await ADAPTERS[c.kind].query(h, sourceSql(c), limit, (cs) => { cols = cs; }, (r) => {
    rows.push(Object.fromEntries(cols.map((col, i) => [col.name, show(r[i], col.type)])));
  });
  return { columns: cols.map((x) => x.name), rows };
}

/** DuckDB pass-through of a native statement on an ATTACHed MySQL/PostgreSQL database. */
function nativeFrom(c, alias) {
  if (c.kind === 'postgres') return `postgres_query(${ql(alias)}, ${ql(c.query)})`;
  if (c.kind === 'mysql') return `mysql_query(${ql(alias)}, ${ql(c.query)})`;
  return `(${c.query})`;
}

function clearCache() {
  fetched.clear();
  fs.rmSync(path.join(app.getPath('userData'), 'db-cache'), { recursive: true, force: true });
}

function loadStore() {
  try { return JSON.parse(fs.readFileSync(credFile(), 'utf8')); } catch { return {}; }
}

function savePassword(c, password) {
  const key = keyOf(c);
  session.set(key, password);
  if (!safeStorage.isEncryptionAvailable()) return false;
  const store = loadStore();
  store[key] = safeStorage.encryptString(password).toString('base64');
  fs.writeFileSync(credFile(), JSON.stringify(store, null, 2), { mode: 0o600 });
  return true;
}

function passwordOf(c) {
  const key = keyOf(c);
  if (session.has(key)) return session.get(key);
  const enc = loadStore()[key];
  if (enc && safeStorage.isEncryptionAvailable()) {
    try { const p = safeStorage.decryptString(Buffer.from(enc, 'base64')); session.set(key, p); return p; } catch { /* re-ask */ }
  }
  return undefined;
}

function forget(c) {
  const key = keyOf(c);
  session.delete(key);
  const store = loadStore();
  if (key in store) { delete store[key]; fs.writeFileSync(credFile(), JSON.stringify(store, null, 2), { mode: 0o600 }); }
}

/** ATTACHes the database once per session; returns its DuckDB alias. */
async function attach(c, password) {
  const key = keyOf(c);
  if (attached.has(key)) return attached.get(key);
  const alias = 'src_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 10);
  let dsn, type;
  if (c.kind === 'sqlite') {
    if (!fs.existsSync(c.file)) throw new Error(`File SQLite non trovato: ${c.file}`);
    dsn = c.file; type = 'sqlite';
  } else {
    const pw = password ?? passwordOf(c);
    if (pw === undefined && c.user) {
      const err = new Error(`Credenziali mancanti per ${key}. Ricollegarsi da Ottieni dati › Database.`);
      err.code = 'NO_CREDENTIALS';
      throw err;
    }
    const parts = { host: c.host || 'localhost', port: c.port || undefined, user: c.user || undefined, password: pw, [c.kind === 'postgres' ? 'dbname' : 'database']: c.database || undefined };
    dsn = Object.entries(parts).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${String(v).includes(' ') ? `'${String(v).replace(/'/g, "\\'")}'` : v}`).join(' ');
    type = c.kind;
  }
  await db.query(`INSTALL ${type}; LOAD ${type};`);
  await db.query(`ATTACH ${ql(dsn)} AS ${qi(alias)} (TYPE ${type}, READ_ONLY)`);
  attached.set(key, alias);
  return alias;
}

/** Connects (validating credentials) and lists the user tables/views. */
async function connect(c, password, remember) {
  const key = keyOf(c);
  if (ADAPTERS[c.kind]) {
    const h = await driverHandle(c, password ?? undefined);
    if (password) { if (remember) savePassword(c, password); else session.set(key, password); }
    const tables = await ADAPTERS[c.kind].list(h);
    return { alias: null, tables: tables.map((t) => ({ schema: t.schema, table: t.table, rows: null, view: t.view })), stored: safeStorage.isEncryptionAvailable() };
  }
  if (attached.has(key)) { await db.query(`DETACH ${qi(attached.get(key))}`).catch(() => {}); attached.delete(key); }
  const alias = await attach(c, password ?? undefined);
  if (password) { if (remember) savePassword(c, password); else session.set(key, password); }
  const r = await db.query(`SELECT schema_name AS s, table_name AS t, estimated_size AS n FROM duckdb_tables() WHERE database_name = ${ql(alias)}
    UNION ALL SELECT schema_name, view_name, NULL FROM duckdb_views() WHERE database_name = ${ql(alias)} AND NOT internal ORDER BY 1, 2`);
  let rows = r.rows;
  if (!rows.length) {
    // Some scanners only expose information_schema.
    const s = await db.query(`SELECT table_schema AS s, table_name AS t, NULL AS n FROM information_schema.tables WHERE table_catalog = ${ql(alias)}
      AND table_schema NOT IN ('information_schema', 'pg_catalog', 'mysql', 'performance_schema', 'sys') ORDER BY 1, 2`);
    rows = s.rows;
  }
  if (c.kind === 'mysql' && c.database) rows = rows.filter((x) => x.s === c.database);
  return { alias, tables: rows.map((x) => ({ schema: x.s, table: x.t, rows: x.n === null ? null : Number(x.n) })), stored: safeStorage.isEncryptionAvailable() };
}

/** SQL of a database table source (used by the Power Query compiler). */
async function sourceExpr(source) {
  const c = source.db;
  if (ADAPTERS[c.kind]) {
    const sql = sourceSql(c);
    const file = path.join(cacheDir(), cacheKey(keyOf(c), sql) + '.parquet');
    if (!fetched.has(file) || !fs.existsSync(file)) {
      await fetchToParquet(ADAPTERS[c.kind], await driverHandle(c), sql, file, db);
      fetched.set(file, true);
    }
    return `read_parquet(${ql(file)})`;
  }
  const alias = await attach(c);
  if (c.query) return nativeFrom(c, alias);
  return `${qi(alias)}.${qi(c.schema)}.${qi(c.table)}`;
}

/** DirectQuery on a driver source: fetch the query again into the same cache file (the model view reads it). */
async function refetch(source) {
  const c = source.db;
  if (!c || !ADAPTERS[c.kind]) return false;
  const file = path.join(cacheDir(), cacheKey(keyOf(c), sourceSql(c)) + '.parquet');
  const tmp = file + '.new.parquet';
  await fetchToParquet(ADAPTERS[c.kind], await driverHandle(c), sourceSql(c), tmp, db);
  fs.renameSync(tmp, file);
  fetched.set(file, true);
  return true;
}

/** Saved database credentials (keys only, never the secrets) for Impostazioni origine dati. */
function savedKeys() { return Object.keys(loadStore()).sort(); }

/** Forget one saved key (and close its driver connection). */
function forgetKey(key) {
  session.delete(key);
  if (handles.has(key)) { handles.delete(key); }
  const store = loadStore();
  if (key in store) { delete store[key]; fs.writeFileSync(credFile(), JSON.stringify(store, null, 2), { mode: 0o600 }); }
}

module.exports = { connect, sourceExpr, refetch, forget, keyOf, preview, clearCache, savedKeys, forgetKey };
