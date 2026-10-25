/**
 * Power Query steps → DuckDB SQL. Each applied step becomes a CTE over the previous one; a hidden
 * ordinal column `__r` carries the row order Power Query keeps implicitly (needed by keep/remove
 * top rows, fill down, index column…). Queries referenced by `ref`, merges and appends are inlined
 * as subqueries, so the editor's drafts always see each other's latest definition.
 */
import type { FilterOp, Step, TableMeta, ValueType } from '../types';
import { resolveText } from './params';
import { mToSql, properSql } from './mexpr';
import type { QueryDef } from './steps';

export const qi = (n: string) => '"' + n.replace(/"/g, '""') + '"';
export const ql = (s: string) => "'" + s.replace(/'/g, "''") + "'";
const R = '__r';

const SQL_TYPE = { text: 'VARCHAR', int: 'BIGINT', decimal: 'DOUBLE', date: 'DATE', datetime: 'TIMESTAMP', bool: 'BOOLEAN' } as const;

/** Parses "3,5" (Italian) and "3.5"; returns null when not a number. */
export function parseNumber(v: string): number | null {
  const s = v.trim().replace(/\s/g, '');
  const n = Number(/^-?\d+(,\d+)?$/.test(s) ? s.replace(',', '.') : s);
  return s !== '' && Number.isFinite(n) ? n : null;
}

export function sqlLiteral(v: string | null | undefined, vt: ValueType = 'text'): string {
  if (v === null || v === undefined) return 'NULL';
  if (vt === 'number') {
    const n = parseNumber(v);
    if (n === null) throw new Error(`Valore numerico non valido: "${v}"`);
    return String(n);
  }
  if (vt === 'bool') return /^(true|vero|1)$/i.test(v.trim()) ? 'TRUE' : 'FALSE';
  if (vt === 'date') return `TRY_CAST(${ql(v.trim())} AS DATE)`;
  if (vt === 'datetime') return `TRY_CAST(${ql(v.trim())} AS TIMESTAMP)`;
  return ql(v);
}

const list = (cols: string[]) => cols.map(qi).join(', ');
const txt = (c: string) => `CAST(${qi(c)} AS VARCHAR)`;

function filterCond(f: Extract<Step, { kind: 'filterRows' }>): string {
  // Parameter references (#[Nome]) in the value(s).
  const s = { ...f, value: f.value === undefined ? undefined : resolveText(f.value), values: f.values?.map((x) => (x === null ? null : resolveText(x))) };
  const c = qi(s.column);
  const v = () => sqlLiteral(s.value ?? '', s.vtype);
  const t = () => ql(s.value ?? '');
  const ops: Record<FilterOp, () => string> = {
    eq: () => `${c} = ${v()}`,
    ne: () => `${c} IS DISTINCT FROM ${v()}`,
    gt: () => `${c} > ${v()}`,
    ge: () => `${c} >= ${v()}`,
    lt: () => `${c} < ${v()}`,
    le: () => `${c} <= ${v()}`,
    contains: () => `coalesce(contains(${txt(s.column)}, ${t()}), false)`,
    notContains: () => `NOT coalesce(contains(${txt(s.column)}, ${t()}), false)`,
    startsWith: () => `coalesce(starts_with(${txt(s.column)}, ${t()}), false)`,
    endsWith: () => `coalesce(ends_with(${txt(s.column)}, ${t()}), false)`,
    blank: () => `(${c} IS NULL OR ${txt(s.column)} = '')`,
    notBlank: () => `(${c} IS NOT NULL AND ${txt(s.column)} <> '')`,
    in: () => {
      const vals = s.values ?? [];
      const some = vals.filter((x): x is string => x !== null);
      const parts = [some.length ? `${txt(s.column)} IN (${some.map(ql).join(', ')})` : '', vals.includes(null) ? `${c} IS NULL` : ''].filter(Boolean);
      return parts.length ? `(${parts.join(' OR ')})` : 'FALSE';
    },
    notIn: () => {
      const vals = s.values ?? [];
      const some = vals.filter((x): x is string => x !== null);
      const nulls = vals.includes(null) ? `${c} IS NOT NULL` : '';
      const rest = some.length ? `(${c} IS NULL OR ${txt(s.column)} NOT IN (${some.map(ql).join(', ')}))` : '';
      return [nulls, rest].filter(Boolean).join(' AND ') || 'TRUE';
    },
  };
  return ops[s.op]();
}

function transformSql(fn: Extract<Step, { kind: 'transform' }>['fn'], c: string, digits = 0): string {
  switch (fn) {
    case 'upper': return `upper(${c})`;
    case 'lower': return `lower(${c})`;
    case 'proper': return properSql(c);
    case 'trim': return `trim(${c})`;
    case 'length': return `length(CAST(${c} AS VARCHAR))`;
    case 'round': return `round(${c}, ${digits})`;
    case 'abs': return `abs(${c})`;
    case 'year': return `year(${c})`;
    case 'month': return `month(${c})`;
    case 'day': return `day(${c})`;
    case 'quarter': return `quarter(${c})`;
  }
}

const GROUP_SQL = {
  count: () => 'count(*)',
  countd: (c?: string) => (c ? `count(DISTINCT ${qi(c)})` : 'count(*)'),
  sum: (c?: string) => `sum(${qi(c!)})`,
  avg: (c?: string) => `avg(${qi(c!)})`,
  median: (c?: string) => `median(${qi(c!)})`,
  min: (c?: string) => `min(${qi(c!)})`,
  max: (c?: string) => `max(${qi(c!)})`,
};

/** SELECT producing step `s` from CTE `P`; `subs` holds the inlined SQL of referenced queries. */
function stepSql(s: Step, P: string, subs: Map<string, string>): string {
  switch (s.kind) {
    case 'removeColumns': return `SELECT * EXCLUDE (${list(s.columns)}) FROM ${P}`;
    case 'selectColumns': return `SELECT ${R}, ${list(s.columns)} FROM ${P}`;
    case 'renameColumns': return `SELECT * RENAME (${s.renames.map(([a, b]) => `${qi(a)} AS ${qi(b)}`).join(', ')}) FROM ${P}`;
    case 'changeType': return `SELECT * REPLACE (${s.columns.map(([c, t]) => `${t === 'text' ? 'CAST' : 'TRY_CAST'}(${qi(c)} AS ${SQL_TYPE[t]}) AS ${qi(c)}`).join(', ')}) FROM ${P}`;
    case 'filterRows': return `SELECT * FROM ${P} WHERE ${filterCond(s)}`;
    case 'sort': {
      // Power Query sorts nulls first ascending, last descending.
      const order = s.by.map(([c, d]) => `${qi(c)} ${d === 'asc' ? 'ASC NULLS FIRST' : 'DESC NULLS LAST'}`).join(', ');
      return `SELECT * REPLACE (row_number() OVER (ORDER BY ${order}, ${R}) AS ${R}) FROM ${P}`;
    }
    case 'removeDuplicates':
      // No columns: whole-row duplicates (first occurrence kept).
      if (!s.columns.length) return `SELECT * FROM ${P} WHERE ${R} IN (SELECT m FROM (SELECT min(${R}) AS m, COLUMNS(* EXCLUDE (${R})) FROM ${P} GROUP BY ALL))`;
      return `SELECT * FROM ${P} QUALIFY row_number() OVER (PARTITION BY ${list(s.columns)} ORDER BY ${R}) = 1`;
    case 'keepTop': return `SELECT * FROM ${P} ORDER BY ${R} LIMIT ${Math.max(0, Math.floor(s.n))}`;
    case 'keepBottom': return `SELECT * FROM ${P} QUALIFY row_number() OVER (ORDER BY ${R} DESC) <= ${Math.floor(s.n)}`;
    case 'removeTop': return `SELECT * FROM ${P} QUALIFY row_number() OVER (ORDER BY ${R}) > ${Math.floor(s.n)}`;
    case 'removeBottom': return `SELECT * FROM ${P} QUALIFY row_number() OVER (ORDER BY ${R} DESC) > ${Math.floor(s.n)}`;
    case 'replaceValues': {
      const repl = (c: string) => {
        if (s.vtype === 'text' && !s.whole) return s.find === '' ? qi(c) : `replace(${qi(c)}, ${ql(s.find)}, ${ql(s.replace)})`;
        return `CASE WHEN ${qi(c)} = ${sqlLiteral(s.find, s.vtype)} THEN ${sqlLiteral(s.replace, s.vtype)} ELSE ${qi(c)} END`;
      };
      return `SELECT * REPLACE (${s.columns.map((c) => `${repl(c)} AS ${qi(c)}`).join(', ')}) FROM ${P}`;
    }
    case 'transform': return `SELECT * REPLACE (${s.columns.map((c) => `${transformSql(s.fn, qi(c), s.digits)} AS ${qi(c)}`).join(', ')}) FROM ${P}`;
    case 'fillDown': return `SELECT * REPLACE (${s.columns.map((c) => `last_value(${qi(c)} IGNORE NULLS) OVER (ORDER BY ${R} ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS ${qi(c)}`).join(', ')}) FROM ${P}`;
    case 'fillUp': return `SELECT * REPLACE (${s.columns.map((c) => `first_value(${qi(c)} IGNORE NULLS) OVER (ORDER BY ${R} ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS ${qi(c)}`).join(', ')}) FROM ${P}`;
    case 'splitColumn': {
      const parts = Array.from({ length: Math.max(1, s.parts) }, (_, i) => `nullif(split_part(${txt(s.column)}, ${ql(s.delimiter)}, ${i + 1}), '') AS ${qi(`${s.column}.${i + 1}`)}`);
      return `SELECT * EXCLUDE (${qi(s.column)}), ${parts.join(', ')} FROM ${P}`;
    }
    case 'customColumn': return `SELECT *, (${mToSql(s.formula)}) AS ${qi(s.name)} FROM ${P}`;
    case 'conditionalColumn': {
      // Numeric result when every literal output is a number and no output is a column; text otherwise.
      const outs = [...s.rules.map((r) => [r.output, r.outputIsColumn] as const), [s.otherwise, s.otherwiseIsColumn] as const];
      const numeric = outs.every(([o, col]) => !col && (o.trim() === '' || parseNumber(o) !== null));
      const out = ([o, col]: readonly [string, boolean | undefined]) => (col ? `CAST(${qi(o)} AS VARCHAR)` : o.trim() === '' ? 'NULL' : numeric ? String(parseNumber(o)) : ql(o));
      const whens = s.rules.map((r, i) => `WHEN ${filterCond({ id: '', kind: 'filterRows', column: r.column, op: r.op, value: r.value, vtype: r.vtype })} THEN ${out(outs[i])}`);
      return `SELECT *, CASE ${whens.join(' ')} ELSE ${out(outs[outs.length - 1])} END AS ${qi(s.name)} FROM ${P}`;
    }
    case 'selectRows': return `SELECT * FROM ${P} WHERE coalesce((${mToSql(s.formula)}), false)`;
    case 'promoteHeaders': return `SELECT * ${s.renames.length ? `RENAME (${s.renames.map(([a, b]) => `${qi(a)} AS ${qi(b)}`).join(', ')}) ` : ''}FROM ${P} QUALIFY row_number() OVER (ORDER BY ${R}) > 1`;
    case 'indexColumn': return `SELECT *, row_number() OVER (ORDER BY ${R}) - 1 + ${Math.floor(s.start)} AS ${qi(s.name)} FROM ${P}`;
    case 'duplicateColumn': return `SELECT *, ${qi(s.column)} AS ${qi(s.name)} FROM ${P}`;
    case 'groupBy': {
      const aggs = s.aggs.map((a) => `${GROUP_SQL[a.op](a.column)} AS ${qi(a.name)}`);
      if (!s.keys.length) return `SELECT ${aggs.join(', ')}, 1 AS ${R} FROM ${P}`;
      return `SELECT ${list(s.keys)}, ${aggs.join(', ')}, row_number() OVER (ORDER BY min(${R})) AS ${R} FROM ${P} GROUP BY ${list(s.keys)}`;
    }
    case 'unpivot': {
      // `other`: s.columns are the columns to keep; otherwise the ones to unpivot.
      const keep = s.other ? s.columns : null;
      const on = keep ? `COLUMNS(* EXCLUDE (${list([R, ...keep])}))` : list(s.columns);
      const input = !s.cast ? P
        : keep ? `(SELECT ${list([R, ...keep])}, CAST(${on} AS VARCHAR) FROM ${P})`
          : `(SELECT * REPLACE (${s.columns.map((c) => `CAST(${qi(c)} AS VARCHAR) AS ${qi(c)}`).join(', ')}) FROM ${P})`;
      return `SELECT * REPLACE (row_number() OVER (ORDER BY ${R}) AS ${R}) FROM (UNPIVOT ${input} ON ${on} INTO NAME "Attributo" VALUE "Valore")`;
    }
    case 'pivot': {
      // Rows = the other columns (sorted, like Power Query's grouping); one column per value of s.column.
      const v = qi(s.value);
      const agg = { sum: `sum(${v})`, avg: `avg(${v})`, count: `count(${v})`, countd: `count(DISTINCT ${v})`, median: `median(${v})`, min: `min(${v})`, max: `max(${v})`, none: `first(${v})` }[s.agg];
      return `SELECT row_number() OVER () AS ${R}, * FROM (SELECT * FROM (PIVOT (SELECT * EXCLUDE (${R}) FROM ${P}) ON ${qi(s.column)} USING ${agg}) ORDER BY ALL)`;
    }
    case 'merge': {
      const right = `(${subs.get(s.table)})`;
      const on = s.left.map((l, i) => `l.${qi(l)} = r.${qi(s.right[i])}`).join(' AND ');
      if (s.join === 'leftAnti') {
        const nulls = s.expand.map((c) => `NULL AS ${qi(`${s.table}.${c}`)}`).join(', ');
        return `SELECT l.*${nulls ? ', ' + nulls : ''} FROM ${P} l ANTI JOIN ${right} r ON ${on}`;
      }
      const join = { left: 'LEFT JOIN', right: 'RIGHT JOIN', full: 'FULL JOIN', inner: 'JOIN' }[s.join];
      const cols = s.expand.map((c) => `, r.${qi(c)} AS ${qi(`${s.table}.${c}`)}`).join('');
      return `SELECT l.* REPLACE (row_number() OVER (ORDER BY l.${R} NULLS LAST) AS ${R})${cols} FROM ${P} l ${join} ${right} r ON ${on}`;
    }
    case 'append': {
      const parts = [`SELECT 0 AS __o, ${R} AS __i, * EXCLUDE (${R}) FROM ${P}`,
        ...s.tables.map((t, i) => `SELECT ${i + 1} AS __o, row_number() OVER () AS __i, * FROM (${subs.get(t)})`)];
      return `SELECT row_number() OVER (ORDER BY __o, __i) AS ${R}, * EXCLUDE (__o, __i) FROM (${parts.join(' UNION ALL BY NAME ')})`;
    }
  }
}

export interface CompileOptions {
  /** Number of steps to apply (preview of a selected step); default all. */
  upto?: number;
  /** read_csv_auto(...) etc. for a file source (main process, loads extensions). */
  srcExpr: (source: TableMeta['source']) => Promise<string>;
  /** Table holding the result of an M query (evaluated by the M interpreter); default = the loaded model table. */
  mTable?: (name: string, code: string) => Promise<string>;
}

/** Full SELECT for a query, resolving references among `all` queries. */
export async function compileQuery(q: QueryDef, all: QueryDef[], opts: CompileOptions, stack: string[] = []): Promise<string> {
  if (stack.includes(q.name)) throw new Error(`Riferimento circolare tra query: ${[...stack, q.name].join(' → ')}`);
  if (q.source.mcode !== undefined) return `SELECT * FROM ${opts.mTable ? await opts.mTable(q.name, q.source.mcode) : qi(q.name)}`;
  const sub = (name: string) => {
    const other = all.find((x) => x.name === name);
    if (!other) throw new Error(`La query "${name}" non esiste.`);
    return compileQuery(other, all, { srcExpr: opts.srcExpr, mTable: opts.mTable }, [...stack, q.name]);
  };
  const src = q.source.ref ? `(${await sub(q.source.ref)})` : await opts.srcExpr(q.source);
  const steps = (q.steps ?? []).slice(0, opts.upto ?? undefined);
  if (!steps.length) return `SELECT * FROM ${src}`;

  const subs = new Map<string, string>();
  for (const s of steps) {
    for (const t of s.kind === 'merge' ? [s.table] : s.kind === 'append' ? s.tables : []) {
      if (!subs.has(t)) subs.set(t, await sub(t));
    }
  }
  const ctes = [`s0 AS (SELECT row_number() OVER () AS ${R}, * FROM ${src})`];
  steps.forEach((s, i) => ctes.push(`s${i + 1} AS (${stepSql(s, `s${i}`, subs)})`));
  return `WITH ${ctes.join(',\n')}\nSELECT * EXCLUDE (${R}) FROM s${steps.length} ORDER BY ${R}`;
}
