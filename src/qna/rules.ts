// "Domande e risposte" without a service: a small rule-based parser (Italian and English) that maps a
// question onto fields, measures, values, aggregations, grouping, top N and visual type.
// It produces the same QnaSpec as the Claude path (electron/claude.cjs), turned into a visual by toVisual().
import type { QnaSpec } from '../api';
import type { Agg, FieldRef, Measure, TableMeta, Visual, VisualType } from '../types';
import { isNumeric, uid, refLabel } from '../format';
import { api } from '../api';
import { defaultFormat } from '../store';
import { visualDef } from '../visuals/catalog';

export const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Common business words, Italian ↔ English, so "vendite per paese" finds Sales and Country.
const SYN: [string[], string[]][] = [
  [['vendite', 'vendita', 'venduto', 'fatturato'], ['sales', 'revenue', 'amount', 'net sales']],
  [['ricavi', 'ricavo', 'entrate'], ['revenue', 'sales', 'income']],
  [['profitto', 'profitti', 'utile', 'utili', 'margine', 'guadagno'], ['profit', 'margin']],
  [['paese', 'paesi', 'nazione', 'nazioni', 'stato estero'], ['country', 'countries', 'nation']],
  [['prodotto', 'prodotti', 'articolo', 'articoli'], ['product', 'products', 'item']],
  [['anno', 'anni'], ['year', 'years']],
  [['mese', 'mesi'], ['month', 'month name', 'months']],
  [['trimestre', 'trimestri'], ['quarter']],
  [['data', 'date', 'giorno', 'giorni'], ['date', 'day']],
  [['quantita', 'pezzi', 'unita', 'unita vendute'], ['quantity', 'units', 'units sold', 'qty']],
  [['prezzo', 'prezzi'], ['price', 'sale price', 'unit price']],
  [['cliente', 'clienti'], ['customer', 'customers', 'client']],
  [['regione', 'regioni'], ['region', 'regions']],
  [['citta', 'comune', 'comuni'], ['city', 'cities', 'town']],
  [['categoria', 'categorie'], ['category', 'categories']],
  [['segmento', 'segmenti'], ['segment', 'segments']],
  [['sconto', 'sconti'], ['discount', 'discounts', 'discount band']],
  [['costo', 'costi'], ['cost', 'costs', 'cogs']],
  [['ordine', 'ordini'], ['order', 'orders']],
  [['negozio', 'negozi', 'punto vendita'], ['store', 'stores', 'shop']],
  [['genere', 'sesso'], ['gender', 'sex']],
  [['eta'], ['age']],
  [['dipendente', 'dipendenti'], ['employee', 'employees']],
  [['resi', 'reso', 'restituzioni'], ['returns', 'return']],
];
const synonyms = (name: string): string[] => {
  const n = norm(name);
  const out = new Set([n]);
  for (const [it, en] of SYN) {
    if (en.includes(n)) it.forEach((x) => out.add(x));
    if (it.includes(n)) en.forEach((x) => out.add(x));
  }
  // Rough plural/singular forms.
  if (n.endsWith('s')) out.add(n.slice(0, -1)); else out.add(n + 's');
  return [...out];
};

type Kind = 'measure' | 'num' | 'text' | 'date';
interface FieldEntry { table: string; column: string; kind: Kind; }
interface ValueEntry { table: string; column: string; value: string; }
export interface QnaIndex { names: Map<string, FieldEntry[]>; values: Map<string, ValueEntry[]>; fields: FieldEntry[]; maxWords: number; }

/** Field names (with synonyms) and distinct values of text columns (≤ 2,000 per column) of the model. */
export async function buildIndex(tables: TableMeta[], measures: Measure[]): Promise<QnaIndex> {
  const names = new Map<string, FieldEntry[]>();
  const values = new Map<string, ValueEntry[]>();
  const fields: FieldEntry[] = [];
  let maxWords = 1;
  const addName = (k: string, e: FieldEntry) => { if (!k) return; maxWords = Math.max(maxWords, k.split(' ').length); (names.get(k) ?? names.set(k, []).get(k)!).push(e); };
  for (const m of measures) { const e: FieldEntry = { table: m.table, column: m.name, kind: 'measure' }; fields.push(e); synonyms(m.name).forEach((k) => addName(k, e)); }
  for (const t of tables) {
    for (const c of t.columns) {
      const kind: Kind = isNumeric(c) ? 'num' : /DATE|TIME/i.test(c.type) ? 'date' : 'text';
      const e: FieldEntry = { table: t.name, column: c.name, kind };
      fields.push(e);
      synonyms(c.name).forEach((k) => addName(k, e));
      const yearLike = kind === 'num' && /year|anno/i.test(c.name);
      if (kind !== 'text' && !yearLike) continue;
      try {
        const qi = (s: string) => '"' + s.replace(/"/g, '""') + '"';
        const r = await api.query(`SELECT DISTINCT CAST(${qi(c.name)} AS VARCHAR) AS v FROM ${qi(t.name)} WHERE ${qi(c.name)} IS NOT NULL LIMIT 2001`);
        if (r.rows.length > 2000) continue;
        for (const row of r.rows) {
          const k = norm(row.v);
          if (!k || k.length < 2) continue;
          maxWords = Math.max(maxWords, Math.min(6, k.split(' ').length));
          (values.get(k) ?? values.set(k, []).get(k)!).push({ table: t.name, column: c.name, value: String(row.v) });
        }
      } catch { /* column not queryable: names only */ }
    }
  }
  return { names, values, fields, maxWords };
}

const AGG_WORDS: [string[], Agg][] = [
  [['totale', 'totali', 'somma', 'sum', 'total'], 'sum'],
  [['media', 'medio', 'medi', 'average', 'avg', 'mean'], 'avg'],
  [['numero di', 'numero', 'quanti', 'quante', 'conteggio', 'count', 'how many', 'number of'], 'countd'],
  [['massimo', 'massima', 'max', 'maximum', 'piu alto', 'highest'], 'max'],
  [['minimo', 'minima', 'min', 'minimum', 'piu basso', 'lowest'], 'min'],
  [['mediana', 'median'], 'median'],
];
const GROUP_WORDS = ['per ogni', 'per', 'by', 'for each', 'per ciascun', 'per ciascuna', 'suddiviso per', 'divisi per', 'raggruppato per', 'grouped by'];
const VISUAL_WORDS: [string[], VisualType][] = [
  [['torta', 'pie'], 'pie'], [['anello', 'ciambella', 'donut'], 'donut'],
  [['linee', 'linea', 'line', 'andamento', 'trend', 'nel tempo', 'over time'], 'line'],
  [['barre', 'bar', 'bars'], 'clusteredBar'], [['istogramma', 'colonne', 'column', 'columns'], 'clusteredColumn'],
  [['tabella', 'table', 'elenco', 'lista', 'list'], 'table'], [['matrice', 'matrix'], 'matrix'],
  [['mappa colorata', 'filled map', 'coropletica'], 'filledMap'], [['mappa', 'map'], 'map'],
  [['dispersione', 'scatter'], 'scatter'], [['scheda', 'card'], 'card'],
  [['mappa ad albero', 'treemap'], 'treemap'], [['area'], 'area'], [['imbuto', 'funnel'], 'funnel'],
];
const TOP = ['primi', 'prime', 'top', 'migliori', 'maggiori'], BOTTOM = ['ultimi', 'ultime', 'peggiori', 'bottom', 'minori'];
const GEO = /\b(country|countries|paese|nazione|region|regione|city|citta|comune|provincia|province|state|stato|location|posizione)\b/;
const TIME = /\b(year|anno|month|mese|date|data|quarter|trimestre|day|giorno|week|settimana)\b/;

/** Parses a question into a visual spec using the model index. */
export function parse(question: string, idx: QnaIndex): QnaSpec {
  const words = norm(question).split(' ').filter(Boolean);
  const values: QnaSpec['fields'] = [];
  const dims: QnaSpec['fields'] = [];
  const filters = new Map<string, QnaSpec['filters'][number]>();
  let visual: VisualType | null = null;
  let pendingAgg: Agg | null = null;
  let group = false;
  let topN: number | null = null, asc: boolean | null = null;
  const phrase = (i: number, n: number) => words.slice(i, i + n).join(' ');
  const startsWith = (i: number, list: string[]) => list.map((w) => w.split(' ')).filter((p) => phrase(i, p.length) === p.join(' ')).sort((a, b) => b.length - a.length)[0]?.length ?? 0;

  for (let i = 0; i < words.length;) {
    // Visual type, aggregation, grouping, top N keywords.
    let n = 0;
    for (const [ws, t] of VISUAL_WORDS) { const k = startsWith(i, ws); if (k > n) { n = k; visual = t; } }
    if (n) { i += n; continue; }
    for (const [ws, a] of AGG_WORDS) { const k = startsWith(i, ws); if (k) { pendingAgg = a; n = k; break; } }
    if (n) { i += n; continue; }
    n = startsWith(i, GROUP_WORDS);
    if (n) { group = true; i += n; continue; }
    if ((TOP.includes(words[i]) || BOTTOM.includes(words[i])) && /^\d+$/.test(words[i + 1] ?? '')) { topN = +words[i + 1]; asc = BOTTOM.includes(words[i]); i += 2; continue; }
    // Longest field name, then longest value.
    let hit: { len: number; field?: FieldEntry; value?: ValueEntry[] } | null = null;
    for (let len = Math.min(idx.maxWords, words.length - i); len >= 1 && !hit; len--) {
      const p = phrase(i, len);
      const f = idx.names.get(p);
      if (f?.length) hit = { len, field: f.find((x) => x.kind === 'measure') ?? f[0] };
      else if (idx.values.get(p)?.length) hit = { len, value: idx.values.get(p) };
    }
    if (!hit) { i++; continue; }
    i += hit.len;
    if (hit.field) {
      const f = hit.field;
      if (f.kind === 'measure') values.push({ well: 'values', table: f.table, column: f.column, agg: 'measure' });
      // A number column is a value ("per profitto" ranks by it) unless it is a year or values exist already.
      else if (f.kind === 'num' && (!group || !values.length) && !/year|anno/i.test(f.column)) values.push({ well: 'values', table: f.table, column: f.column, agg: pendingAgg ?? 'sum' });
      else if (pendingAgg === 'countd' && !group) values.push({ well: 'values', table: f.table, column: f.column, agg: 'countd' });
      else if (!dims.some((d) => d.table === f.table && d.column === f.column)) dims.push({ well: 'category', table: f.table, column: f.column, agg: 'none' });
      pendingAgg = null; group = false;
    } else if (hit.value) {
      const v = hit.value[0];
      const key = `${v.table}\u0001${v.column}`;
      const cur = filters.get(key) ?? { table: v.table, column: v.column, values: [] };
      if (!cur.values.includes(v.value)) cur.values.push(v.value);
      filters.set(key, cur);
    }
  }
  if (!values.length && !dims.length) {
    return { answerable: false, visual: 'card', fields: [], filters: [], topN: null, sortAscending: null, title: '', restatement: 'Nessun campo del modello riconosciuto nella domanda.' };
  }
  // "Quanti X" with nothing else to count: count the rows of the first grouping table.
  if (!values.length && pendingAgg === 'countd' && dims.length) values.push({ ...dims.shift()!, well: 'values', agg: 'countd' });
  if (!visual) {
    const d = dims[0];
    visual = !d && values.length ? 'card' : !values.length ? 'table' : TIME.test(norm(d.column)) ? 'line' : GEO.test(norm(d.column)) ? 'map' : dims.length > 1 ? 'clusteredColumn' : 'clusteredBar';
  }
  const fields = arrange(visual, dims, values);
  const label = (f: QnaSpec['fields'][number]) => refLabel({ table: f.table, column: f.column, agg: f.agg as Agg });
  const title = [values.map(label).join(' e '), dims.length ? 'per ' + dims.map((d) => d.column).join(' e ') : ''].filter(Boolean).join(' ');
  const fl = [...filters.values()];
  const restatement = [title, fl.length ? 'filtrato su ' + fl.map((f) => `${f.column} = ${f.values.join(', ')}`).join('; ') : '', topN ? `${asc ? 'ultimi' : 'primi'} ${topN}` : ''].filter(Boolean).join(', ');
  return { answerable: true, visual, fields, filters: fl, topN, sortAscending: asc, title, restatement };
}

/** Puts dims/values into the wells of the chosen visual. */
function arrange(visual: VisualType, dims: QnaSpec['fields'], values: QnaSpec['fields']): QnaSpec['fields'] {
  if (visual === 'table') return [...dims, ...values].map((f) => ({ ...f, well: 'columns' }));
  if (visual === 'matrix') return [...dims.slice(0, 1).map((f) => ({ ...f, well: 'rows' })), ...dims.slice(1, 2).map((f) => ({ ...f, well: 'columns' })), ...values.map((f) => ({ ...f, well: 'values' }))];
  if (visual === 'card') return values.slice(0, 1);
  if (visual === 'scatter') return [...dims.slice(0, 1).map((f) => ({ ...f, well: 'details' })), ...values.slice(0, 2).map((f, i) => ({ ...f, well: i ? 'y' : 'x' }))];
  const one = ['pie', 'donut', 'treemap', 'funnel', 'map', 'filledMap'].includes(visual);
  return [...dims.slice(0, 1), ...(one ? [] : dims.slice(1, 2).map((f) => ({ ...f, well: 'legend' }))), ...(one ? values.slice(0, 1) : values)];
}

/** A spec (local or from Claude) as a MiB-BI visual; fields that do not exist in the model are dropped. */
export function toVisual(spec: QnaSpec, base: Pick<Visual, 'id' | 'x' | 'y' | 'w' | 'h' | 'z'>, tables: TableMeta[], measures: Measure[]): Visual {
  const type = (visualDef(spec.visual as VisualType).wells.length ? spec.visual : 'table') as VisualType;
  const wells = new Set(visualDef(type).wells.map((w) => w.key));
  const fields: Record<string, FieldRef[]> = {};
  for (const f of spec.fields) {
    let ref: FieldRef | null = null;
    if (f.agg === 'measure') { const m = measures.find((x) => x.name === f.column); if (m) ref = { table: m.table, column: m.name, agg: 'measure' }; }
    else if (tables.some((t) => t.name === f.table && t.columns.some((c) => c.name === f.column))) ref = { table: f.table, column: f.column, agg: f.agg as Agg };
    const well = wells.has(f.well) ? f.well : [...wells][0];
    if (ref && well) (fields[well] ??= []).push(ref);
  }
  const filters = spec.filters.filter((f) => tables.some((t) => t.name === f.table && t.columns.some((c) => c.name === f.column)))
    .map((f) => ({ id: uid(), table: f.table, column: f.column, values: f.values }));
  return {
    ...base, type, fields, filters, format: { ...defaultFormat(type), titleShow: false, titleText: spec.title },
    ...(spec.topN ? { topN: spec.topN, topAsc: !!spec.sortAscending } : {}),
  };
}

/** Example questions built from the model (shown under the empty Q&A box). */
export function suggestions(idx: QnaIndex): string[] {
  const value = idx.fields.find((f) => f.kind === 'measure') ?? idx.fields.find((f) => f.kind === 'num' && !/year|anno|id$/i.test(f.column));
  const dims = idx.fields.filter((f) => f.kind === 'text').slice(0, 2);
  const time = idx.fields.find((f) => TIME.test(norm(f.column)));
  const out: string[] = [];
  if (value && dims[0]) out.push(`${value.kind === 'measure' ? '' : 'totale '}${value.column} per ${dims[0].column}`);
  if (value && time) out.push(`${value.column} per ${time.column} come linee`);
  if (value && dims[1]) out.push(`primi 5 ${dims[1].column} per ${value.column}`);
  return out;
}

/** Model description sent to Claude: tables, columns with types, measures, sample values of text columns. */
export function schemaText(tables: TableMeta[], measures: Measure[], idx: QnaIndex): string {
  const samples = new Map<string, string[]>();
  for (const list of idx.values.values()) for (const v of list) {
    const k = `${v.table}\u0001${v.column}`;
    const s = samples.get(k) ?? samples.set(k, []).get(k)!;
    if (s.length < 12) s.push(v.value);
  }
  const lines: string[] = [];
  for (const t of tables) {
    lines.push(`Table "${t.name}" (${t.rowCount} rows):`);
    for (const c of t.columns) {
      const s = samples.get(`${t.name}\u0001${c.name}`);
      lines.push(`  - "${c.name}" ${c.type}${s?.length ? ` e.g. ${s.map((x) => JSON.stringify(x)).join(', ')}` : ''}`);
    }
  }
  if (measures.length) {
    lines.push('Measures:');
    for (const m of measures) lines.push(`  - "${m.name}" (home table "${m.table}") = ${m.expression.replace(/\s+/g, ' ').slice(0, 300)}`);
  }
  return lines.join('\n');
}
