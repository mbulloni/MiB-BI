const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
app.commandLine.appendSwitch('no-sandbox');
// Fixed name: settings folder ~/.config/mib-bi and the safeStorage key, the same for the AppImage and `npm start`.
app.setName('mib-bi');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const JSZip = require('jszip');
const db = require('./db.cjs');
const pbip = require('./pbip.cjs');
const connect = require('./connect.cjs');
const powerbi = require('./powerbi.cjs');
const claude = require('./claude.cjs');
const scripts = require('./scripts.cjs');
const remote = require('./remote.cjs');
const { ensureSample, ensureDims } = require('./sample.cjs');


let win;

function createWindow() {
  win = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 650,
    frame: false,
    backgroundColor: (() => { try { return CHROME_BG[JSON.parse(fs.readFileSync(uiThemeFile(), 'utf8')).theme] ?? '#ffffff'; } catch { return '#ffffff'; } })(),
    title: 'MiB-BI',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  if (process.env.VITE_DEV) win.loadURL('http://localhost:5173');
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  if (process.env.MIBBI_SHOT) screenshotMode(process.env.MIBBI_SHOT, process.env.MIBBI_SCRIPT);
  // `mib-bi report.mibx` / double click on a report file: open it once the UI is ready.
  const arg = process.argv.slice(1).find((a) => /\.(mibx|pbix|pbit|pbip)$/i.test(a) && fs.existsSync(a));
  if (arg) win.webContents.once('did-finish-load', () => setTimeout(() => win.webContents.send('file:openArg', path.resolve(arg)), 300));
  win.on('maximize', () => win.webContents.send('win:state', true));
  win.on('unmaximize', () => win.webContents.send('win:state', false));
}

// Wraps handlers so errors reach the renderer as { error } instead of rejecting.
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: await fn(...args) };
    } catch (err) {
      return { error: err.message || String(err) };
    }
  });
}

handle('app:version', () => app.getVersion());
handle('db:query', (sql) => db.query(sql));
handle('db:queryAs', (sql) => db.queryAs(sql));
handle('db:setRole', (tables) => db.setRole(tables));
handle('db:preview', (file, sheet) => db.preview(file, sheet));
handle('db:import', (file, table, sheet) => db.importFile(file, table, sheet));
handle('db:materialize', (table, sql) => db.materialize(table, sql));
handle('db:sourceExpr', (source) => (source.inline ? db.inlineExpr(source.inline) : source.db ? connect.sourceExpr(source) : source.web || source.odata || source.folder || source.sharepoint ? remote.sourceExpr(source) : db.sourceExpr(source.path, source.sheet)));
handle('remote:clearCache', () => { remote.clearCache(); connect.clearCache(); });
const webcred = require('./webcred.cjs');
handle('webcred:list', () => webcred.list());
handle('webcred:set', (prefix, cred) => webcred.set(prefix, cred));
handle('webcred:remove', (prefix) => webcred.remove(prefix));
handle('sharepoint:lists', (site) => require('./sharepoint.cjs').lists(site));
handle('pbi:labels', () => powerbi.labels());
// Origini recenti: data files used to load tables (most recent first, existing files only).
const recentFile = () => path.join(app.getPath('userData'), 'recent-sources.json');
const readRecent = () => { try { return JSON.parse(fs.readFileSync(recentFile(), 'utf8')); } catch { return []; } };
// entries: file paths, or 'db:' + connection JSON (no secrets) for database sources
handle('recent:list', () => readRecent().filter((p) => p.startsWith('db:') || fs.existsSync(p)).slice(0, 10));
handle('recent:add', (p) => { fs.writeFileSync(recentFile(), JSON.stringify([p, ...readRecent().filter((x) => x !== p)].slice(0, 20))); });
handle('file:openDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('db:connect', (c, password, remember) => connect.connect(c, password, remember));
handle('db:sourcePreview', (c, limit) => connect.preview(c, limit));
handle('db:savedCredentials', () => connect.savedKeys());
handle('db:forgetCredential', (key) => connect.forgetKey(key));
handle('db:forget', (c) => connect.forget(c));

// Power BI service (electron/powerbi.cjs): progress lines go to the renderer as 'pbi:progress'.
handle('claude:status', () => claude.status());
handle('claude:configure', (key, model) => claude.configure(key, model));
handle('claude:ask', (question, schema) => claude.ask(question, schema));
handle('claude:translate', (items, culture) => claude.translate(items, culture));
handle('script:run', (lang, script, csv, w, h) => scripts.run(lang, script, csv, w, h));
handle('script:paths', (p) => (p ? scripts.setPaths(p) : scripts.paths()));
handle('pbi:status', () => powerbi.status());
handle('pbi:configure', (clientId, tenant, name) => powerbi.configure(clientId, tenant, name));
handle('pbi:addProfile', (clientId, tenant, name) => powerbi.addProfile(clientId, tenant, name));
handle('pbi:selectProfile', (id) => powerbi.selectProfile(id));
handle('pbi:removeProfile', () => powerbi.removeProfile());
handle('pbi:signOut', () => powerbi.signOut());
handle('pbi:loginStart', (email) => powerbi.loginStart(typeof email === 'string' ? email : undefined));
handle('pbi:loginBrowser', (email) => powerbi.loginBrowser(typeof email === 'string' ? email : undefined));
handle('pbi:loginBrowserCancel', () => powerbi.loginBrowserCancel());
handle('pbi:loginWait', () => powerbi.loginWait());
handle('pbi:loginCancel', () => powerbi.loginCancel());
handle('pbi:workspaces', () => powerbi.workspaces());
handle('pbi:items', (ws) => powerbi.serviceItems(typeof ws === 'string' ? ws : ''));
handle('pbi:downloadReport', (ws, id, name) => powerbi.downloadReport(String(ws ?? ''), String(id), String(name ?? 'report'), (msg, frac) => win.webContents.send('pbi:progress', msg, frac ?? null)));
handle('pbi:datasetModel', (ws, id, name) => powerbi.datasetModel(String(ws ?? ''), String(id), String(name ?? 'modello'), (msg, frac) => win.webContents.send('pbi:progress', msg, frac ?? null)));
handle('pbi:publish', (mode, spec) => {
  const progress = (msg, frac) => win.webContents.send('pbi:progress', msg, frac ?? null);
  return mode === 'fabric' ? powerbi.publishFabric(spec, progress) : powerbi.publishPush(spec, progress);
});
handle('shell:open', (url) => {
  if (!/^https:\/\//.test(url)) throw new Error('URL non valido');
  return shell.openExternal(url);
});

// "Vai a Power BI": the Power BI service (app.powerbi.com) in a plain child window with its own
// persistent session, so the user signs in with the Microsoft portal and browses the service as in a
// browser. It is an isolated web view (no preload, no node, no MiB-BI bridge): MiB-BI neither reads its
// cookies nor reuses its token — publishing goes through MiB-BI's own registered Entra app, not this session.
let portalWin;
handle('pbi:openPortal', (url) => {
  const target = typeof url === 'string' && /^https:\/\/(app|msit)\.powerbi\.com\//.test(url) ? url : 'https://app.powerbi.com/home?experience=power-bi';
  if (portalWin && !portalWin.isDestroyed()) { portalWin.loadURL(target); portalWin.focus(); return true; }
  portalWin = new BrowserWindow({
    width: 1280, height: 820, parent: win, title: 'Power BI',
    backgroundColor: '#ffffff', autoHideMenuBar: true,
    webPreferences: { partition: 'persist:powerbi-portal', contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  portalWin.on('closed', () => { portalWin = undefined; });
  // Microsoft login / consent pages that open in a popup stay inside this isolated window.
  portalWin.webContents.setWindowOpenHandler(({ url: u }) => (/^https:\/\//.test(u) ? { action: 'allow' } : { action: 'deny' }));
  portalWin.loadURL(target);
  return true;
});
handle('db:calcColumn', (table, column, expr, replace) => db.addCalcColumn(table, column, expr, replace));
handle('db:dropColumn', (table, column) => db.dropColumn(table, column));
handle('db:drop', (table) => db.dropTable(table));
handle('db:createEmpty', (table, columns) => db.createEmpty(table, columns));
handle('data:sample', () => {
  const dir = app.getPath('userData');
  return { financials: ensureSample(dir), ...ensureDims(dir) };
});

const FILTERS = {
  csv: [{ name: 'Testo/CSV', extensions: ['csv', 'txt', 'tsv'] }],
  excel: [{ name: 'Cartella di lavoro di Excel', extensions: ['xlsx'] }],
  json: [{ name: 'JSON', extensions: ['json', 'ndjson', 'jsonl'] }],
  xml: [{ name: 'XML', extensions: ['xml'] }],
  parquet: [{ name: 'Parquet', extensions: ['parquet'] }],
  sqlite: [{ name: 'Database SQLite', extensions: ['sqlite', 'sqlite3', 'db'] }],
  access: [{ name: 'Database di Access', extensions: ['accdb', 'mdb'] }],
  key: [{ name: 'Chiave (JSON, PEM, P8)', extensions: ['json', 'pem', 'p8', 'key'] }],
  any: [{ name: 'Tutti i file di dati', extensions: ['csv', 'txt', 'tsv', 'xlsx', 'json', 'ndjson', 'jsonl', 'parquet'] }],
  mibx: [{ name: 'File MiB-BI', extensions: ['mibx'] }],
  report: [{ name: 'Report (MiB-BI, Power BI)', extensions: ['mibx', 'pbix', 'pbit', 'pbip'] }, { name: 'File MiB-BI', extensions: ['mibx'] }, { name: 'File Power BI', extensions: ['pbix', 'pbit', 'pbip'] }],
  powerbi: [{ name: 'File Power BI', extensions: ['pbix', 'pbit', 'pbip'] }],
  pbip: [{ name: 'Progetto di Power BI', extensions: ['pbip'] }],
  pbit: [{ name: 'Modello di Power BI', extensions: ['pbit'] }],
  pbix: [{ name: 'File di Power BI', extensions: ['pbix'] }],
  theme: [{ name: 'File di tema JSON', extensions: ['json'] }],
  pdf: [{ name: 'PDF', extensions: ['pdf'] }],
  pptx: [{ name: 'Presentazione di PowerPoint', extensions: ['pptx'] }],
  pbiviz: [{ name: 'Oggetto visivo di Power BI', extensions: ['pbiviz'] }],
};

// Interface language (Opzioni › Lingua dell'applicazione): file dialog filter names follow it.
const FILTER_EN = {
  'Testo/CSV': 'Text/CSV', 'Cartella di lavoro di Excel': 'Excel workbook', 'Database SQLite': 'SQLite database', 'Database di Access': 'Access database',
  'Chiave (JSON, PEM, P8)': 'Key (JSON, PEM, P8)', 'Tutti i file di dati': 'All data files', 'File MiB-BI': 'MiB-BI file', 'Report (MiB-BI, Power BI)': 'Report (MiB-BI, Power BI)',
  'File Power BI': 'Power BI file', 'Progetto di Power BI': 'Power BI project', 'Modello di Power BI': 'Power BI template', 'File di Power BI': 'Power BI file',
  'File di tema JSON': 'JSON theme file', 'Presentazione di PowerPoint': 'PowerPoint presentation', 'Oggetto visivo di Power BI': 'Power BI visual',
};
for (const list of Object.values(FILTERS)) for (const f of list) f.it = f.name;
ipcMain.on('ui:lang', (_e, lang) => {
  for (const list of Object.values(FILTERS)) for (const f of list) f.name = lang === 'en' ? FILTER_EN[f.it] ?? f.it : f.it;
});

// Custom visual (.pbiviz = zip with package.json + resources/<guid>.pbiviz.json). MIBBI_PBIVIZ_PATH skips the dialog.
handle('cv:import', async () => {
  const file = process.env.MIBBI_PBIVIZ_PATH
    || await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS.pbiviz }).then((r) => (r.canceled ? null : r.filePaths[0]));
  if (!file) return null;
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const json = async (name) => JSON.parse((await zip.file(name).async('string')).replace(/^\uFEFF/, ''));
  const res = Object.keys(zip.files).find((n) => /^resources\/[^/]+\.pbiviz\.json$/.test(n));
  if (!res) throw new Error('Il file non contiene un oggetto visivo di Power BI (resources/*.pbiviz.json).');
  const pbiviz = await json(res);
  const guid = pbiviz.visual?.guid;
  if (!guid || !pbiviz.content?.js) throw new Error("Pacchetto .pbiviz non valido: mancano guid o codice dell'oggetto visivo.");
  return { guid, pbiviz, ...(zip.file('package.json') ? { package: await json('package.json') } : {}) };
});

handle('dialog:openData', async (kind) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.any });
  return r.canceled ? null : r.filePaths[0];
});

// .mibx: a zip with report.json and one Parquet file per table (data embedded like a .pbix).
// `embed` lists the tables to export; plain JSON files (older versions) still open.
handle('file:save', async (content, existingPath, embed) => {
  let target = existingPath;
  if (!target) {
    const r = await dialog.showSaveDialog(win, { defaultPath: 'Report.mibx', filters: FILTERS.mibx });
    if (r.canceled) return null;
    target = r.filePath.endsWith('.mibx') ? r.filePath : r.filePath + '.mibx';
  }
  if (!embed) { fs.writeFileSync(target, content); return target; }
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'mib-bi-'));
  try {
    const zip = new JSZip();
    zip.file('report.json', content);
    for (const e of embed) {
      const file = path.join(tmp, path.basename(e.file));
      await db.exportParquet(e.table, file);
      zip.file(e.file, fs.readFileSync(file));
    }
    const out = target + '.tmp';
    fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' }));
    fs.renameSync(out, target);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return target;
});

// Small text files (themes): open/save with a dialog.
handle('file:readText', async (kind) => {
  const r = process.env.MIBBI_OPEN_PATH ? { canceled: false, filePaths: [process.env.MIBBI_OPEN_PATH] }
    : await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.any });
  if (r.canceled) return null;
  return { path: r.filePaths[0], content: fs.readFileSync(r.filePaths[0], 'utf8') };
});
handle('file:saveText', async (content, defaultPath, kind) => {
  const r = process.env.MIBBI_SAVE_PATH ? { canceled: false, filePath: process.env.MIBBI_SAVE_PATH }
    : await dialog.showSaveDialog(win, { defaultPath, filters: FILTERS[kind] || FILTERS.any });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, content);
  return r.filePath;
});

// Esporta dati (visual menu): summarized / underlying rows as .xlsx or .csv.
handle('file:exportData', async (name, columns, rows, format) => {
  const { buildXlsx, buildCsv } = require('./xlsx.cjs');
  const ext = format === 'csv' ? 'csv' : 'xlsx';
  const r = process.env.MIBBI_SAVE_PATH ? { canceled: false, filePath: process.env.MIBBI_SAVE_PATH }
    : await dialog.showSaveDialog(win, { defaultPath: `${String(name || 'data').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`, filters: ext === 'csv' ? [{ name: 'File CSV', extensions: ['csv'] }] : FILTERS.excel });
  if (r.canceled) return null;
  fs.writeFileSync(r.filePath, ext === 'csv' ? buildCsv(columns, rows) : await buildXlsx(name, columns, rows));
  return r.filePath;
});

handle('file:open', async (kind) => {
  // MIBBI_OPEN_PATH (scripted tests) skips the dialog.
  const r = process.env.MIBBI_OPEN_PATH ? { canceled: false, filePaths: [process.env.MIBBI_OPEN_PATH] }
    : await dialog.showOpenDialog(win, { properties: ['openFile'], filters: FILTERS[kind] || FILTERS.report });
  if (r.canceled) return null;
  return readReport(r.filePaths[0]);
});
handle('file:openAt', (file) => readReport(file));

async function readReport(file) {
  if (/\.(pbix|pbit|pbip)$/i.test(file)) return { path: file, powerbi: true };
  const buf = fs.readFileSync(file);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) return { path: file, content: buf.toString('utf8') };
  // Embedded data: unpack the Parquet files next to each other in the user cache.
  const stat = fs.statSync(file);
  const key = crypto.createHash('sha1').update(file + stat.mtimeMs + stat.size).digest('hex').slice(0, 16);
  const dir = path.join(app.getPath('userData'), 'mibx-data', key);
  const zip = await JSZip.loadAsync(buf);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || name === 'report.json' || name.includes('..')) continue;
    const dest = path.join(dir, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (!fs.existsSync(dest)) fs.writeFileSync(dest, await entry.async('nodebuffer'));
  }
  return { path: file, content: await zip.file('report.json').async('string'), dataDir: dir };
}

// ---- Power BI files -------------------------------------------------------

/** Python with pbixray: MIBBI_PYTHON, the project's .venv-pbix, ~/.config/mib-bi/pbix-venv (installed app), or python3. */
function pythonBin() {
  if (process.env.MIBBI_PYTHON) return process.env.MIBBI_PYTHON;
  for (const venv of [path.join(__dirname, '..', '.venv-pbix', 'bin', 'python'), path.join(app.getPath('userData'), 'pbix-venv', 'bin', 'python')]) {
    if (fs.existsSync(venv)) return venv;
  }
  return 'python3';
}
const SETUP_PBIX = app.isPackaged
  ? 'python3 -m venv ~/.config/mib-bi/pbix-venv && ~/.config/mib-bi/pbix-venv/bin/pip install pbixray pyarrow'
  : 'npm run setup:pbix (nella cartella del progetto)';

handle('pbix:read', (file) => new Promise((resolve, reject) => {
  if (/\.pbip$/i.test(file)) { try { return resolve(pbip.read(file)); } catch (e) { return reject(new Error('Lettura del progetto Power BI non riuscita: ' + e.message)); } }
  const stat = fs.statSync(file);
  // Packaged app: Python cannot read inside app.asar (electron/pbix is unpacked by electron-builder).
  const script = path.join(__dirname, 'pbix', 'read_pbix.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  // The reader's own content is part of the key: a newer MiB-BI re-reads files it extracted before.
  const key = crypto.createHash('sha1').update(file + stat.mtimeMs + stat.size).update(fs.readFileSync(script)).digest('hex').slice(0, 16);
  const outdir = path.join(app.getPath('userData'), 'pbix-cache', key);
  const cached = path.join(outdir, 'model.json');
  if (fs.existsSync(cached)) return resolve(JSON.parse(fs.readFileSync(cached, 'utf8')));
  execFile(pythonBin(), [script, file, outdir], { maxBuffer: 1 << 26, timeout: 15 * 60 * 1000 }, (err, stdout, stderr) => {
    if (err) {
      const msg = String(stderr || err.message);
      if (msg.includes('PBIXRAY_MISSING')) {
        return reject(new Error(`Per leggere i file .pbix serve la libreria Python "pbixray". Eseguire in un terminale: ${SETUP_PBIX}`));
      }
      if (err.code === 'ENOENT') return reject(new Error('Python 3 non trovato. Installare python3 oppure impostare MIBBI_PYTHON.'));
      return reject(new Error('Lettura del file Power BI non riuscita: ' + msg.trim().split('\n').slice(-3).join(' ')));
    }
    resolve(JSON.parse(fs.readFileSync(cached, 'utf8')));
  });
}));

/** Zip of .pbit/.pbix parts (utf16 / utf8bom / utf8 / dataUrl / buffer; `stored` = no compression). */
async function zipParts(parts) {
  const zip = new JSZip();
  for (const p of parts) {
    // No folder entries: Power BI packages list files only.
    const opts = { createFolders: false, ...(p.stored ? { compression: 'STORE' } : {}) };
    if (p.utf16 !== undefined) zip.file(p.path, Buffer.from(p.utf16, 'utf16le'), opts);
    else if (p.utf8bom !== undefined) zip.file(p.path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(p.utf8bom, 'utf8')]), opts);
    else if (p.utf8 !== undefined) zip.file(p.path, Buffer.from(p.utf8, 'utf8'), opts);
    else if (p.dataUrl) zip.file(p.path, Buffer.from(p.dataUrl.split(',')[1], 'base64'), opts);
    else if (p.buffer) zip.file(p.path, p.buffer, opts);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

handle('pbit:save', async (parts, suggested) => {
  // MIBBI_PBIT_OUT (scripted tests) skips the save dialog.
  const r = process.env.MIBBI_PBIT_OUT ? { canceled: false, filePath: process.env.MIBBI_PBIT_OUT }
    : await dialog.showSaveDialog(win, { defaultPath: suggested || 'Report.pbit', filters: FILTERS.pbit });
  if (r.canceled) return null;
  const target = r.filePath.toLowerCase().endsWith('.pbit') ? r.filePath : r.filePath + '.pbit';
  fs.writeFileSync(target, await zipParts(parts));
  return target;
});

// .pbix with data: every model table is exported from DuckDB to Parquet, electron/pbix/write_pbix.py writes the
// DataModel (Analysis Services backup with VertiPaq storage) and it is zipped with the report parts.
handle('pbix:save', async (parts, schema, extra, suggested, target0) => {
  const r = target0 ? { canceled: false, filePath: target0 } : process.env.MIBBI_PBIX_OUT ? { canceled: false, filePath: process.env.MIBBI_PBIX_OUT }
    : await dialog.showSaveDialog(win, { defaultPath: suggested || 'Report.pbix', filters: FILTERS.pbix });
  if (r.canceled) return null;
  const target = r.filePath.toLowerCase().endsWith('.pbix') ? r.filePath : r.filePath + '.pbix';
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mib-bi-pbix-'));
  try {
    const existing = new Set((await db.query("SELECT table_name AS n FROM information_schema.tables WHERE table_schema = 'main'")).rows.map((x) => x.n));
    const tables = {};
    const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';
    for (const [i, t] of schema.model.tables.entries()) {
      if (!existing.has(t.name) || !t.columns?.length) continue;
      const file = path.join(dir, `${i}.parquet`);
      await db.query(`COPY (SELECT ${t.columns.map((c) => qi(c.name)).join(', ')} FROM ${qi(t.name)}) TO '${file.replace(/'/g, "''")}' (FORMAT parquet)`);
      tables[t.name] = file;
    }
    const out = path.join(dir, 'DataModel');
    const job = path.join(dir, 'job.json');
    fs.writeFileSync(job, JSON.stringify({ schema, tables, out, ...extra }));
    const script = path.join(__dirname, 'pbix', 'write_pbix.py').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    await new Promise((resolve, reject) => execFile(pythonBin(), [script, job], { maxBuffer: 1 << 26, timeout: 30 * 60 * 1000 }, (err, stdout, stderr) => {
      if (!err) return resolve();
      if (err.code === 'ENOENT') return reject(new Error('Python 3 non trovato. Installare python3 oppure impostare MIBBI_PYTHON.'));
      const msg = String(stderr || err.message);
      if (/No module named '?(pyarrow|pbixray)/.test(msg)) return reject(new Error(`Per salvare in .pbix serve l'ambiente Python di MiB-BI. Eseguire in un terminale: ${SETUP_PBIX}`));
      reject(new Error((msg.match(/ERRORE: (.*)/) || [null, msg.trim().split('\n').slice(-1)[0]])[1]));
    }));
    // Write next to the target and rename: an error never leaves a half-written .pbix in place of the old one.
    const partial = target + '.mib-bi-tmp';
    fs.writeFileSync(partial, await zipParts([...parts, { path: 'DataModel', buffer: fs.readFileSync(out), stored: true }]));
    fs.renameSync(partial, target);
    return target;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Power BI project: parts use __BASE__ for the project name chosen in the dialog.
handle('pbip:save', async (parts, suggested) => {
  const r = process.env.MIBBI_PBIP_OUT ? { canceled: false, filePath: process.env.MIBBI_PBIP_OUT }
    : await dialog.showSaveDialog(win, { defaultPath: suggested || 'Report.pbip', filters: FILTERS.pbip });
  if (r.canceled) return null;
  const target = r.filePath.toLowerCase().endsWith('.pbip') ? r.filePath : r.filePath + '.pbip';
  const base = path.basename(target, path.extname(target));
  const sub = (s) => s.split('__BASE__').join(base);
  return pbip.write(target, parts.map((p) => ({ ...p, path: sub(p.path), ...(p.text !== undefined ? { text: sub(p.text) } : {}) })));
});

// Power Query M interpreter: data access (src/pq/m/host.ts).
const mhost = require('./mhost.cjs');
handle('m:sql', (sql, limit) => mhost.sql(sql, limit));
handle('m:file', (p) => mhost.file(p));
handle('m:head', (p, n) => mhost.head(p, n));
handle('m:folder', (p, recursive) => mhost.folder(p, recursive));
handle('m:web', (url, opts) => mhost.web(url, opts));
handle('m:xlsxSheets', (p) => mhost.xlsxSheets(p));
handle('m:load', (table, columns, rows) => mhost.load(table, columns, rows));

// Updates from the GitHub releases (same as MiB-SQL): check, download + install (AppImage / .deb), restart.
const updates = require('./updates.cjs');
handle('update:check', () => updates.check());
handle('update:install', () => updates.install((p) => win.webContents.send('update:progress', p)));
handle('update:restart', () => updates.restart());

// PowerPoint export: the renderer shows one page at a time at the window's top-left corner, main captures it.
handle('win:capture', async (rect) => (await win.webContents.capturePage(rect)).toPNG().toString('base64'));
handle('pptx:save', async (slides, suggested) => {
  const r = process.env.MIBBI_PPTX_OUT ? { canceled: false, filePath: process.env.MIBBI_PPTX_OUT }
    : await dialog.showSaveDialog(win, { defaultPath: suggested || 'Report.pptx', filters: FILTERS.pptx });
  if (r.canceled) return null;
  const target = r.filePath.toLowerCase().endsWith('.pptx') ? r.filePath : r.filePath + '.pptx';
  fs.writeFileSync(target, await require('./pptx.cjs').build(slides, path.basename(target, '.pptx')));
  return target;
});

// PDF export: the renderer lays out every page (print CSS, 1280×720 each) and Chromium prints it.
handle('pdf:print', async (suggested) => {
  const r = process.env.MIBBI_PDF_OUT ? { canceled: false, filePath: process.env.MIBBI_PDF_OUT }
    : await dialog.showSaveDialog(win, { defaultPath: suggested || 'Report.pdf', filters: FILTERS.pdf });
  if (r.canceled) return null;
  const target = r.filePath.toLowerCase().endsWith('.pdf') ? r.filePath : r.filePath + '.pdf';
  const data = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 } });
  fs.writeFileSync(target, data);
  return target;
});

ipcMain.on('win:minimize', () => win.minimize());
ipcMain.on('win:maximize', () => (win.isMaximized() ? win.unmaximize() : win.maximize()));
ipcMain.on('win:close', () => win.close());
ipcMain.on('win:title', (_e, title) => win.setTitle(title));
// UI theme: window background (no white flash in dark mode), remembered for the next start.
const uiThemeFile = () => path.join(app.getPath('userData'), 'ui-theme.json');
const CHROME_BG = { light: '#F3F2F1', dark: '#1F1E1D' };
ipcMain.on('win:theme', (_e, theme) => {
  if (!CHROME_BG[theme]) return;
  win.setBackgroundColor(CHROME_BG[theme]);
  try { fs.writeFileSync(uiThemeFile(), JSON.stringify({ theme })); } catch { /* not essential */ }
});

// Dev aid: MIBBI_SHOT=out.png [MIBBI_SCRIPT=steps.js] runs a script in the page, captures it, exits.
function screenshotMode(out, scriptFile) {
  // Script progress: renderer console lines starting with STEP are echoed.
  win.webContents.on('console-message', (e) => { const m = e.message ?? ''; if (m.startsWith('STEP')) console.log(m); });
  win.webContents.once('did-finish-load', async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    await wait(1500);
    if (scriptFile) {
      try {
        const result = await win.webContents.executeJavaScript(fs.readFileSync(scriptFile, 'utf8'));
        if (result !== undefined) console.log('SCRIPT_RESULT ' + JSON.stringify(result));
      } catch (e) {
        console.error('script error', e);
      }
    }
    await wait(2500);
    fs.writeFileSync(out, (await win.webContents.capturePage()).toPNG());
    app.quit();
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
