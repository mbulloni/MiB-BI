// Data access for the Power Query M interpreter (src/pq/m): typed DuckDB results, file bytes, folder listings,
// web downloads (stored credentials, cached in remote-cache), Excel sheet names, and loading a result table.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { app } = require('electron');
const db = require('./db.cjs');
const webcred = require('./webcred.cjs');

const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
const ql = (s) => "'" + String(s).replace(/'/g, "''") + "'";

/** SQL result with column types; values as JSON (BIGINT/DECIMAL as text, dates ISO, INTERVAL objects). */
async function sql(query, limit) {
  const r = await db.raw(limit ? `SELECT * FROM (${query}) LIMIT ${Number(limit)}` : query);
  return { columns: r.columnNames().map((name, i) => ({ name, type: String(r.columnTypes()[i]) })), rows: r.getRowsJson() };
}

/** First bytes of a file (CSV column count sniffing). */
function head(p, bytes) {
  const fd = fs.openSync(p, 'r');
  try { const b = Buffer.alloc(bytes); const n = fs.readSync(fd, b, 0, bytes, 0); return b.subarray(0, n); } finally { fs.closeSync(fd); }
}

function file(p) {
  if (!fs.existsSync(p)) throw new Error(`DataSource.NotFound: file non trovato: ${p}`);
  return fs.readFileSync(p);
}

/** Folder.Files (recursive) / Folder.Contents: one entry per file with dates and attributes. */
function folder(dir, recursive) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`DataSource.NotFound: cartella non trovata: ${dir}`);
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.statSync(p);
      if (st.isDirectory()) { if (recursive) walk(p); else out.push({ name: f, path: p, folder: d + path.sep, dir: true, size: 0, atime: st.atimeMs, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs, hidden: f.startsWith('.') }); continue; }
      out.push({ name: f, path: p, folder: d + path.sep, ext: path.extname(f).toLowerCase(), size: st.size, atime: st.atimeMs, mtime: st.mtimeMs, ctime: st.birthtimeMs || st.ctimeMs, hidden: f.startsWith('.') });
    }
  };
  walk(dir);
  return out;
}

const cacheDir = () => { const d = path.join(app.getPath('userData'), 'remote-cache'); fs.mkdirSync(d, { recursive: true }); return d; };
/** Web.Contents: GET (or POST with Content) with Query/Headers/RelativePath, stored credentials; returns the cached file. */
async function web(url, opts = {}) {
  const u = new URL(opts.RelativePath ? new URL(opts.RelativePath, url.endsWith('/') ? url : url + '/').toString() : url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Web.Contents: sono supportati solo indirizzi http:// e https://.');
  for (const [k, v] of Object.entries(opts.Query ?? {})) u.searchParams.append(k, String(v));
  const key = crypto.createHash('sha1').update(JSON.stringify([u.toString(), opts.Headers ?? {}, opts.Content ?? null])).digest('hex').slice(0, 16);
  const target = path.join(cacheDir(), `m-${key}`);
  if (fs.existsSync(target) && Date.now() - fs.statSync(target).mtimeMs < 10 * 60 * 1000) return { path: target, contentType: fs.existsSync(target + '.type') ? fs.readFileSync(target + '.type', 'utf8') : '' };
  const req = await webcred.apply(u.toString(), { 'User-Agent': 'MiB-BI', ...(opts.Headers ?? {}) });
  const r = await fetch(req.url, { method: opts.Content != null ? 'POST' : 'GET', headers: req.headers, body: opts.Content != null ? Buffer.from(opts.Content) : undefined, redirect: 'follow' });
  if (r.status === 401 || r.status === 403) throw new Error(`WEB_AUTH: il server richiede l'autenticazione (${r.status}) per ${u}. Impostarla in Trasforma dati › Impostazioni origine dati.`);
  if (!r.ok && !(opts.ManualStatusHandling ?? []).includes(r.status)) throw new Error(`DataSource.Error: Web.Contents: il server ha risposto ${r.status} ${r.statusText} per ${u}`);
  fs.writeFileSync(target, Buffer.from(await r.arrayBuffer()));
  const type = r.headers.get('content-type') ?? '';
  fs.writeFileSync(target + '.type', type);
  return { path: target, contentType: type };
}

/** Sheet (and defined table) names of an .xlsx file, in workbook order. */
async function xlsxSheets(p) {
  const zip = await JSZip.loadAsync(fs.readFileSync(p));
  const wb = await zip.file('xl/workbook.xml')?.async('string');
  if (!wb) throw new Error('DataFormat.Error: il file non è una cartella di lavoro di Excel (.xlsx).');
  const sheets = [...wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*?(?:\bstate="([^"]*)")?[^>]*\/>/g)].map((m) => ({ name: m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), hidden: !!m[2] && m[2] !== 'visible' }));
  return sheets;
}

const DUCK = { text: 'VARCHAR', number: 'DOUBLE', int: 'BIGINT', logical: 'BOOLEAN', date: 'DATE', datetime: 'TIMESTAMP', datetimezone: 'TIMESTAMPTZ', time: 'TIME' };
/** Loads an M result as model table: rows of JSON values, columns { name, kind } (kind = key of DUCK). */
async function load(table, columns, rows) {
  const tmp = path.join(os.tmpdir(), `mibbi-m-${process.pid}-${crypto.randomUUID()}.ndjson`);
  try {
    const fd = fs.openSync(tmp, 'w');
    let buf = '';
    for (const r of rows) {
      const o = {};
      columns.forEach((c, i) => { o['c' + i] = r[i] ?? null; });
      buf += JSON.stringify(o) + '\n';
      if (buf.length > 1 << 20) { fs.writeSync(fd, buf); buf = ''; }
    }
    fs.writeSync(fd, buf);
    fs.closeSync(fd);
    const spec = columns.map((c, i) => `${ql('c' + i)}: ${ql(DUCK[c.kind] ?? 'VARCHAR')}`).join(', ');
    const select = columns.map((c, i) => `${qi('c' + i)} AS ${qi(c.name)}`).join(', ') || `NULL AS "_"`;
    const from = rows.length ? `read_json(${ql(tmp)}, format = 'newline_delimited', columns = {${spec || "'_': 'VARCHAR'"}})` : `(SELECT ${columns.map((c, i) => `NULL::${DUCK[c.kind] ?? 'VARCHAR'} AS ${qi('c' + i)}`).join(', ') || 'NULL AS "_"'} WHERE false)`;
    await db.run(`CREATE OR REPLACE TABLE ${qi(table)} AS SELECT ${select} FROM ${from}`);
    return db.describe(table);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { sql, head, file, folder, web, xlsxSheets, load };
