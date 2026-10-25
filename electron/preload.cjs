const { contextBridge, ipcRenderer } = require('electron');

const call = async (channel, ...args) => {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r.error) throw new Error(r.error);
  return r.ok;
};

contextBridge.exposeInMainWorld('api', {
  query: (sql) => call('db:query', sql),
  queryAs: (sql) => call('db:queryAs', sql),
  setRole: (tables) => call('db:setRole', tables),
  preview: (file, sheet) => call('db:preview', file, sheet),
  importFile: (file, table, sheet) => call('db:import', file, table, sheet),
  dropTable: (table) => call('db:drop', table),
  materialize: (table, sql) => call('db:materialize', table, sql),
  sourceExpr: (source) => call('db:sourceExpr', source),
  clearRemoteCache: () => call('remote:clearCache'),
  openDir: () => call('file:openDir'),
  dbConnect: (c, password, remember) => call('db:connect', c, password, remember),
  dbPreview: (c, limit) => call('db:sourcePreview', c, limit),
  dbCredentials: () => call('db:savedCredentials'),
  dbForget: (key) => call('db:forgetCredential', key),
  dbForget: (c) => call('db:forget', c),
  addCalcColumn: (table, column, expr, replace) => call('db:calcColumn', table, column, expr, replace),
  dropColumn: (table, column) => call('db:dropColumn', table, column),
  sampleData: () => call('data:sample'),
  openDataDialog: (kind) => call('dialog:openData', kind),
  saveFile: (content, path, embed) => call('file:save', content, path, embed),
  openFile: (kind) => call('file:open', kind),
  openAt: (file) => call('file:openAt', file),
  onOpenArg: (cb) => ipcRenderer.on('file:openArg', (_e, file) => cb(file)),
  readText: (kind) => call('file:readText', kind),
  saveText: (content, defaultPath, kind) => call('file:saveText', content, defaultPath, kind),
  readPowerBI: (file) => call('pbix:read', file),
  savePbit: (parts, suggested) => call('pbit:save', parts, suggested),
  savePbix: (parts, schema, extra, suggested, target) => call('pbix:save', parts, schema, extra, suggested, target),
  printPdf: (suggested) => call('pdf:print', suggested),
  appVersion: () => call('app:version'),
  exportData: (name, columns, rows, format) => call('file:exportData', name, columns, rows, format),
  savePbip: (parts, suggested) => call('pbip:save', parts, suggested),
  claude: {
    status: () => call('claude:status'),
    configure: (key, model) => call('claude:configure', key, model),
    ask: (question, schema) => call('claude:ask', question, schema),
    translate: (items, culture) => call('claude:translate', items, culture),
  },
  runScript: (lang, script, csv, w, h) => call('script:run', lang, script, csv, w, h),
  scriptPaths: (p) => call('script:paths', p),
  pbi: {
    status: () => call('pbi:status'),
    configure: (clientId, tenant, name) => call('pbi:configure', clientId, tenant, name),
    addProfile: (clientId, tenant, name) => call('pbi:addProfile', clientId, tenant, name),
    selectProfile: (id) => call('pbi:selectProfile', id),
    removeProfile: () => call('pbi:removeProfile'),
    signOut: () => call('pbi:signOut'),
    loginStart: (email) => call('pbi:loginStart', email),
    loginBrowser: (email) => call('pbi:loginBrowser', email),
    loginBrowserCancel: () => call('pbi:loginBrowserCancel'),
    items: (ws) => call('pbi:items', ws),
    downloadReport: (ws, id, name) => call('pbi:downloadReport', ws, id, name),
    datasetModel: (ws, id, name) => call('pbi:datasetModel', ws, id, name),
    loginWait: () => call('pbi:loginWait'),
    loginCancel: () => call('pbi:loginCancel'),
    workspaces: () => call('pbi:workspaces'),
    publish: (mode, spec) => call('pbi:publish', mode, spec),
    onProgress: (cb) => {
      const listener = (_e, msg, frac) => cb(msg, frac);
      ipcRenderer.on('pbi:progress', listener);
      return () => ipcRenderer.removeListener('pbi:progress', listener);
    },
  },
  openExternal: (url) => call('shell:open', url),
  openPbiPortal: (url) => call('pbi:openPortal', url),
  importPbiviz: () => call('cv:import'),
  webcred: {
    list: () => call('webcred:list'),
    set: (prefix, cred) => call('webcred:set', prefix, cred),
    remove: (prefix) => call('webcred:remove', prefix),
  },
  sharepointLists: (site) => call('sharepoint:lists', site),
  sensitivityLabels: () => call('pbi:labels'),
  recentSources: () => call('recent:list'),
  addRecentSource: (p) => call('recent:add', p),
  createEmptyTable: (table, columns) => call('db:createEmpty', table, columns),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
    setTitle: (t) => ipcRenderer.send('win:title', t),
    setTheme: (t) => ipcRenderer.send('win:theme', t),
    setLang: (l) => ipcRenderer.send('ui:lang', l),
    onState: (cb) => {
      const listener = (_e, max) => cb(max);
      ipcRenderer.on('win:state', listener);
      return () => ipcRenderer.removeListener('win:state', listener);
    },
  },
});
