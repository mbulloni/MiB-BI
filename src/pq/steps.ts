/** Power Query applied steps: display names (as in Power BI's Italian UI) and query references. */
import type { PQType, Step, TableMeta, TransformFn } from '../types';
import { mIdentifiers } from './m/parse';
import { mName } from './m';

export type QueryDef = Pick<TableMeta, 'name' | 'source' | 'steps'>;

export const TYPE_LABEL: Record<PQType, string> = {
  text: 'Testo', int: 'Numero intero', decimal: 'Numero decimale', date: 'Data', datetime: 'Data/ora', bool: 'Vero/falso',
};

export const TRANSFORM_LABEL: Record<TransformFn, string> = {
  upper: 'Testo in maiuscolo', lower: 'Testo in minuscolo', proper: 'Testo con iniziali maiuscole', trim: 'Testo tagliato',
  length: 'Lunghezza calcolata', round: 'Arrotondato', abs: 'Valore assoluto calcolato',
  year: 'Anno estratto', month: 'Mese estratto', day: 'Giorno estratto', quarter: 'Trimestre estratto',
};

/** Base label of a step; Power BI appends 1, 2… to repeated names. */
export function stepLabel(s: Step): string {
  switch (s.kind) {
    case 'removeColumns': return 'Rimosse colonne';
    case 'selectColumns': return 'Rimosse altre colonne';
    case 'renameColumns': return 'Rinominate colonne';
    case 'changeType': return 'Modificato tipo';
    case 'filterRows': return 'Filtrate righe';
    case 'sort': return 'Ordinate righe';
    case 'removeDuplicates': return 'Rimossi duplicati';
    case 'keepTop': return 'Mantenute prime righe';
    case 'keepBottom': return 'Mantenute ultime righe';
    case 'removeTop': return 'Rimosse prime righe';
    case 'removeBottom': return 'Rimosse ultime righe';
    case 'replaceValues': return 'Valore sostituito';
    case 'transform': return TRANSFORM_LABEL[s.fn];
    case 'fillDown': return 'Riempito verso il basso';
    case 'fillUp': return "Riempito verso l'alto";
    case 'splitColumn': return 'Dividi colonna in base al delimitatore';
    case 'customColumn': return 'Aggiunta colonna personalizzata';
    case 'indexColumn': return 'Aggiunta colonna indice';
    case 'duplicateColumn': return 'Duplicata colonna';
    case 'groupBy': return 'Raggruppate righe';
    case 'pivot': return 'Colonna trasformata tramite Pivot';
    case 'unpivot': return s.other ? 'Trasformazione Unpivot di altre colonne eseguita' : 'Trasformazione Unpivot di colonne eseguita';
    case 'merge': return 'Query unite';
    case 'append': return 'Query accodate';
    case 'conditionalColumn': return 'Aggiunta colonna condizionale';
    case 'selectRows': return 'Filtrate righe';
    case 'promoteHeaders': return 'Intestazioni alzate di livello';
  }
}

/**
 * Unique step identifiers, "Origine" first. A merge yields two M steps (NestedJoin + Expand),
 * so each entry lists the names that step produces.
 */
export function stepNames(steps: Step[], reserved: string[] = ['Origine']): string[][] {
  const used = new Map<string, number>(reserved.map((n) => [n, 1]));
  const uniq = (base: string) => {
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    return n ? `${base}${n}` : base;
  };
  return steps.map((s) => (s.kind === 'merge' ? [uniq('Query unite'), uniq(`Espansa ${s.table}`)] : [uniq(stepLabel(s))]));
}

/** Other queries a query reads from (source reference, merges, appends). */
export function dependencies(q: QueryDef): string[] {
  const out = new Set<string>();
  // M queries: every identifier (callers keep the ones that are query names).
  if (q.source.mcode !== undefined) return [...new Set(mIdentifiers(q.source.mcode).map((x) => x.name))];
  if (q.source.ref) out.add(q.source.ref);
  for (const s of q.steps ?? []) {
    if (s.kind === 'merge') out.add(s.table);
    if (s.kind === 'append') s.tables.forEach((t) => out.add(t));
  }
  return [...out];
}

/** Rewrites references to a renamed query inside a query definition (in place). */
export function renameQueryRef(q: QueryDef, from: string, to: string) {
  if (q.source.mcode !== undefined) { q.source.mcode = renameInM(q.source.mcode, from, to); return; }
  if (q.source.ref === from) q.source.ref = to;
  for (const s of q.steps ?? []) {
    if (s.kind === 'merge' && s.table === from) s.table = to;
    if (s.kind === 'append') s.tables = s.tables.map((t) => (t === from ? to : t));
  }
}

/** Duck type → Power Query type (column header icons, defaults in Modifica tipo). */
export function pqTypeOf(duck: string): PQType {
  const t = duck.toUpperCase();
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT)$/.test(t)) return 'int';
  if (/^(FLOAT|REAL|DOUBLE)$/.test(t) || t.startsWith('DECIMAL')) return 'decimal';
  if (t === 'DATE') return 'date';
  if (t.startsWith('TIMESTAMP')) return 'datetime';
  if (t === 'BOOLEAN') return 'bool';
  return 'text';
}

/** Renames identifier references in M code (query renames). */
export function renameInM(code: string, from: string, to: string): string {
  const ids = mIdentifiers(code).filter((x) => x.name === from).reverse();
  let out = code;
  for (const x of ids) out = out.slice(0, x.start) + mName(to) + out.slice(x.end);
  return out;
}
