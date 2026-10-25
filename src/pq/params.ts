// Power Query parameters: #[Nome] in source paths/URLs and filter values is replaced by the
// parameter's current value (kept in sync with Report.pqParams by the store).
import type { PQParam, TableMeta } from '../types';

let params: PQParam[] = [];
export const setParams = (list: PQParam[] | undefined) => { params = list ?? []; };
export const PARAM_RE = /#\[([^\]]+)\]/g;

/** Runs `fn` with some parameters set to other values (incremental refresh partitions: RangeStart/RangeEnd). */
export async function withParams<T>(over: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = params;
  params = params.map((p) => (p.name in over ? { ...p, value: over[p.name] } : p));
  try { return await fn(); } finally { params = saved; }
}

export function resolveText(s: string): string {
  return s.replace(PARAM_RE, (_m, name: string) => {
    const p = params.find((x) => x.name === name.trim());
    if (!p) throw new Error(`Expression.Error: il parametro "${name}" non esiste (Gestisci parametri).`);
    return p.value;
  });
}

export function resolveSource(source: TableMeta['source']): TableMeta['source'] {
  if (!/#\[/.test(JSON.stringify(source))) return source;
  return {
    ...source,
    path: resolveText(source.path),
    ...(source.web ? { web: { ...source.web, url: resolveText(source.web.url) } } : {}),
    ...(source.odata ? { odata: { url: resolveText(source.odata.url) } } : {}),
    ...(source.folder ? { folder: { ...source.folder, path: resolveText(source.folder.path) } } : {}),
    ...(source.sharepoint ? { sharepoint: { ...source.sharepoint, site: resolveText(source.sharepoint.site), ...(source.sharepoint.folder ? { folder: resolveText(source.sharepoint.folder) } : {}), ...(source.sharepoint.list ? { list: resolveText(source.sharepoint.list) } : {}) } } : {}),
  };
}

/** Power BI parameter query (`"x" meta [IsParameterQuery=true, Type="Text", …]`) → MiB-BI parameter. */
export function paramFromM(name: string, expression: string, description?: string): PQParam {
  const body = expression.replace(/\s+meta\s*\[[\s\S]*\]\s*$/, '').trim();
  const str = /^"((?:[^"]|"")*)"$/.exec(body);
  const date = /^#date(?:time)?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(body);
  const dt = /^#datetime\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(body);
  const p2 = (x: string) => x.padStart(2, '0');
  const base = { name, ...(description ? { description } : {}) };
  if (str) return { ...base, type: 'text', value: str[1].replace(/""/g, '"') };
  if (dt) return { ...base, type: 'datetime', value: `${dt[1]}-${p2(dt[2])}-${p2(dt[3])} ${p2(dt[4])}:${p2(dt[5])}:${p2(dt[6])}` };
  if (date) return { ...base, type: 'date', value: `${date[1]}-${p2(date[2])}-${p2(date[3])}` };
  if (/^-?\d+(\.\d+)?$/.test(body)) return { ...base, type: 'number', value: body };
  return { ...base, type: 'text', value: body };
}

/** Replaces parameter references (Nome / #"Nome") outside string literals by their value as M text,
 *  then folds "a" & "b" concatenations — so a .pbit source like File.Contents(Cartella & "dati.csv") can be located. */
export function inlineParamsInM(m: string, list: PQParam[]): string {
  if (!list.length) return m;
  const lit = (v: string) => '"' + v.replace(/"/g, '""') + '"';
  let out = '';
  for (let i = 0; i < m.length;) {
    if (m[i] === '"') { const j = m.indexOf('"', i + 1); let k = j; while (k >= 0 && m[k + 1] === '"') k = m.indexOf('"', k + 2); out += m.slice(i, k + 1); i = k + 1; continue; }
    const q = /^#"((?:[^"]|"")*)"/.exec(m.slice(i));
    const w = /^[A-Za-z_][\w.]*/.exec(m.slice(i));
    const name = q ? q[1].replace(/""/g, '"') : w?.[0];
    const p = name ? list.find((x) => x.name === name) : undefined;
    if (p && (q || !/[\w.]/.test(m[i - 1] ?? ''))) { out += lit(p.value); i += (q ?? w)![0].length; continue; }
    if (w) { out += w[0]; i += w[0].length; continue; }
    out += m[i++];
  }
  // "a" & "b" → "ab"
  let prev;
  do { prev = out; out = out.replace(/"((?:[^"]|"")*)"\s*&\s*"((?:[^"]|"")*)"/g, '"$1$2"'); } while (out !== prev);
  return out;
}
