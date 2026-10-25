/** Power Query steps → M code (formula bar, Editor avanzato, .pbit export). */
import type { FilterOp, GroupOp, PQType, Step, TransformFn, ValueType } from '../types';
import { parseNumber } from './compile';
import { stepNames } from './steps';

export const mStr = (s: string) => '"' + s.replace(/"/g, '""') + '"';
export const mName = (s: string) => (/^[A-Za-z_][\w.]*$/.test(s) ? s : `#${mStr(s)}`);
const mList = (xs: string[]) => `{${xs.map(mStr).join(', ')}}`;
const mCol = (c: string) => (/^[A-Za-z_][\w ]*$/.test(c) && !c.endsWith(' ') ? `[${c}]` : `[#${mStr(c)}]`);

export const M_TYPE: Record<PQType, string> = {
  text: 'type text', int: 'Int64.Type', decimal: 'type number', date: 'type date', datetime: 'type datetime', bool: 'type logical',
};

/** Text with #[Parametro] references → M ("a" & Parametro & "b"). */
export function mText(s: string): string {
  const parts = s.split(/(#\[[^\]]+\])/).filter((x) => x !== '');
  if (!parts.length) return '""';
  return parts.map((x) => { const p = /^#\[([^\]]+)\]$/.exec(x); return p ? mName(p[1].trim()) : mStr(x); }).join(' & ');
}

export function mLiteral(v: string | null | undefined, vt: ValueType = 'text'): string {
  if (v === null || v === undefined) return 'null';
  const param = /^#\[([^\]]+)\]$/.exec(v.trim());
  if (param) return mName(param[1].trim());
  if (vt === 'number') return String(parseNumber(v) ?? v);
  if (vt === 'bool') return /^(true|vero|1)$/i.test(v.trim()) ? 'true' : 'false';
  const d = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(v.trim());
  if (d && vt === 'date') return `#date(${+d[1]}, ${+d[2]}, ${+d[3]})`;
  if (d && vt === 'datetime') return `#datetime(${+d[1]}, ${+d[2]}, ${+d[3]}, ${+(d[4] ?? 0)}, ${+(d[5] ?? 0)}, ${+(d[6] ?? 0)})`;
  return mStr(v);
}

function filterM(s: Extract<Step, { kind: 'filterRows' }>): string {
  const c = mCol(s.column);
  const v = mLiteral(s.value ?? '', s.vtype);
  const t = mText(s.value ?? '');
  const ops: Record<FilterOp, () => string> = {
    eq: () => `${c} = ${v}`, ne: () => `${c} <> ${v}`, gt: () => `${c} > ${v}`, ge: () => `${c} >= ${v}`, lt: () => `${c} < ${v}`, le: () => `${c} <= ${v}`,
    contains: () => `Text.Contains(${c}, ${t})`,
    notContains: () => `not Text.Contains(${c}, ${t})`,
    startsWith: () => `Text.StartsWith(${c}, ${t})`,
    endsWith: () => `Text.EndsWith(${c}, ${t})`,
    blank: () => `${c} = null or ${c} = ""`,
    notBlank: () => `${c} <> null and ${c} <> ""`,
    in: () => {
      const vals = s.values ?? [];
      return vals.length === 1 ? `${c} = ${mLiteral(vals[0], s.vtype)}` : `List.Contains({${vals.map((x) => mLiteral(x, s.vtype)).join(', ')}}, ${c})`;
    },
    notIn: () => {
      const vals = s.values ?? [];
      return vals.length === 1 ? `${c} <> ${mLiteral(vals[0], s.vtype)}` : `not List.Contains({${vals.map((x) => mLiteral(x, s.vtype)).join(', ')}}, ${c})`;
    },
  };
  return ops[s.op]();
}

const TRANSFORM_M: Record<TransformFn, [string, string]> = {
  upper: ['Text.Upper', 'type text'], lower: ['Text.Lower', 'type text'], proper: ['Text.Proper', 'type text'], trim: ['Text.Trim', 'type text'],
  length: ['Text.Length', 'Int64.Type'], round: ['', 'type number'], abs: ['Number.Abs', 'type number'],
  year: ['Date.Year', 'Int64.Type'], month: ['Date.Month', 'Int64.Type'], day: ['Date.Day', 'Int64.Type'], quarter: ['Date.QuarterOfYear', 'Int64.Type'],
};

const GROUP_M: Record<GroupOp, (c?: string) => [string, string]> = {
  count: () => ['Table.RowCount(_)', 'Int64.Type'],
  countd: (c) => [c ? `List.Count(List.Distinct(${mCol(c)}))` : 'Table.RowCount(Table.Distinct(_))', 'Int64.Type'],
  sum: (c) => [`List.Sum(${mCol(c!)})`, 'type number'],
  avg: (c) => [`List.Average(${mCol(c!)})`, 'type number'],
  median: (c) => [`List.Median(${mCol(c!)})`, 'type number'],
  min: (c) => [`List.Min(${mCol(c!)})`, 'type any'],
  max: (c) => [`List.Max(${mCol(c!)})`, 'type any'],
};

const JOIN_M = { left: 'JoinKind.LeftOuter', right: 'JoinKind.RightOuter', full: 'JoinKind.FullOuter', inner: 'JoinKind.Inner', leftAnti: 'JoinKind.LeftAnti' };

/** M expressions of one step (two for a merge), given the previous step's identifier. */
export function stepM(s: Step, prev: string, names: string[]): string[] {
  const p = mName(prev);
  switch (s.kind) {
    case 'removeColumns': return [`Table.RemoveColumns(${p}, ${mList(s.columns)})`];
    case 'selectColumns': return [`Table.SelectColumns(${p}, ${mList(s.columns)})`];
    case 'renameColumns': return [`Table.RenameColumns(${p}, {${s.renames.map(([a, b]) => `{${mStr(a)}, ${mStr(b)}}`).join(', ')}})`];
    // Explicit culture: text numbers and dates use "." and ISO forms, like the SQL engine (and Power BI in any locale).
    case 'changeType': return [`Table.TransformColumnTypes(${p}, {${s.columns.map(([c, t]) => `{${mStr(c)}, ${M_TYPE[t]}}`).join(', ')}}, "en-US")`];
    case 'filterRows': return [`Table.SelectRows(${p}, each ${filterM(s)})`];
    case 'sort': return [`Table.Sort(${p}, {${s.by.map(([c, d]) => `{${mStr(c)}, ${d === 'asc' ? 'Order.Ascending' : 'Order.Descending'}}`).join(', ')}})`];
    case 'removeDuplicates': return [s.columns.length ? `Table.Distinct(${p}, ${mList(s.columns)})` : `Table.Distinct(${p})`];
    case 'keepTop': return [`Table.FirstN(${p}, ${s.n})`];
    case 'keepBottom': return [`Table.LastN(${p}, ${s.n})`];
    case 'removeTop': return [`Table.Skip(${p}, ${s.n})`];
    case 'removeBottom': return [`Table.RemoveLastN(${p}, ${s.n})`];
    case 'replaceValues': {
      const text = s.vtype === 'text' && !s.whole;
      return [`Table.ReplaceValue(${p}, ${mLiteral(s.find, s.vtype)}, ${mLiteral(s.replace, s.vtype)}, ${text ? 'Replacer.ReplaceText' : 'Replacer.ReplaceValue'}, ${mList(s.columns)})`];
    }
    case 'transform': {
      const [fn, ty] = TRANSFORM_M[s.fn];
      const f = s.fn === 'round' ? `each Number.Round(_, ${s.digits ?? 0})` : fn;
      return [`Table.TransformColumns(${p}, {${s.columns.map((c) => `{${mStr(c)}, ${f}, ${ty}}`).join(', ')}})`];
    }
    case 'fillDown': return [`Table.FillDown(${p}, ${mList(s.columns)})`];
    case 'fillUp': return [`Table.FillUp(${p}, ${mList(s.columns)})`];
    case 'splitColumn': {
      const out = Array.from({ length: s.parts }, (_, i) => `${s.column}.${i + 1}`);
      return [`Table.SplitColumn(${p}, ${mStr(s.column)}, Splitter.SplitTextByDelimiter(${mStr(s.delimiter)}, QuoteStyle.Csv), ${mList(out)})`];
    }
    case 'customColumn': return [`Table.AddColumn(${p}, ${mStr(s.name)}, each ${s.formula})`];
    case 'indexColumn': return [`Table.AddIndexColumn(${p}, ${mStr(s.name)}, ${s.start}, 1, Int64.Type)`];
    case 'duplicateColumn': return [`Table.DuplicateColumn(${p}, ${mStr(s.column)}, ${mStr(s.name)})`];
    case 'groupBy': return [`Table.Group(${p}, ${mList(s.keys)}, {${s.aggs.map((a) => { const [e, t] = GROUP_M[a.op](a.column); return `{${mStr(a.name)}, each ${e}, ${t}}`; }).join(', ')}})`];
    case 'pivot': {
      const fn = { sum: 'List.Sum', avg: 'List.Average', count: 'List.Count', countd: 'each List.Count(List.Distinct(_))', median: 'List.Median', min: 'List.Min', max: 'List.Max', none: '' }[s.agg];
      return [`Table.Pivot(${p}, List.Distinct(${p}${mCol(s.column)}), ${mStr(s.column)}, ${mStr(s.value)}${fn ? ', ' + fn : ''})`];
    }
    case 'unpivot': return [`${s.other ? 'Table.UnpivotOtherColumns' : 'Table.Unpivot'}(${p}, ${mList(s.columns)}, "Attributo", "Valore")`];
    case 'merge': return [
      `Table.NestedJoin(${p}, ${mList(s.left)}, ${mName(s.table)}, ${mList(s.right)}, ${mStr(s.table)}, ${JOIN_M[s.join]})`,
      `Table.ExpandTableColumn(${mName(names[0])}, ${mStr(s.table)}, ${mList(s.expand)}, ${mList(s.expand.map((c) => `${s.table}.${c}`))})`,
    ];
    case 'append': return [`Table.Combine({${[p, ...s.tables.map(mName)].join(', ')}})`];
    case 'conditionalColumn': {
      const out = (o: string, col?: boolean) => (col ? mCol(o) : o.trim() === '' ? 'null' : parseNumber(o) !== null ? String(parseNumber(o)) : mStr(o));
      const ifs = s.rules.map((r) => `if ${filterM({ id: '', kind: 'filterRows', column: r.column, op: r.op, value: r.value, vtype: r.vtype })} then ${out(r.output, r.outputIsColumn)}`).join(' else ');
      return [`Table.AddColumn(${p}, ${mStr(s.name)}, each ${ifs} else ${out(s.otherwise, s.otherwiseIsColumn)})`];
    }
    case 'selectRows': return [`Table.SelectRows(${p}, each ${s.formula})`];
    case 'promoteHeaders': return [`Table.PromoteHeaders(${p}, [PromoteAllScalars=true])`];
  }
}

/** M lines (`Name = expr`) of the steps following `prev`, and the identifier of the last one. */
export function stepsToM(steps: Step[], prev = 'Origine', reserved = ['Origine']): { lines: [string, string][]; last: string } {
  const names = stepNames(steps, reserved);
  const lines: [string, string][] = [];
  let last = prev;
  steps.forEach((s, i) => {
    const exprs = stepM(s, last, names[i]);
    exprs.forEach((e, j) => lines.push([names[i][j], e]));
    last = names[i][names[i].length - 1];
  });
  return { lines, last };
}

/** Appends steps to a `let … in X` expression (the M of the source). */
export function appendSteps(baseM: string, steps: Step[]): string {
  if (!steps.length) return baseM;
  const m = /^\s*let\s+([\s\S]*?)\s*\bin\s+([\s\S]+?)\s*$/.exec(baseM);
  const body = m ? m[1].trimEnd() : `Origine = ${baseM.trim()}`;
  const prev = m ? m[2].trim().replace(/^#"(.*)"$/, '$1').replace(/""/g, '"') : 'Origine';
  const reserved = [...body.matchAll(/^\s*(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)\s*=/gm)].map((x) => x[1].replace(/^#"(.*)"$/, '$1').replace(/""/g, '"'));
  const { lines, last } = stepsToM(steps, prev, reserved.length ? reserved : ['Origine']);
  const indented = body.split('\n').map((l) => (l.startsWith('    ') ? l : '    ' + l.trimStart())).join('\n');
  return `let\n${indented},\n${lines.map(([n, e]) => `    ${mName(n)} = ${e}`).join(',\n')}\nin\n    ${mName(last)}`;
}
