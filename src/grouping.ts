// Gruppi e intervalli (Data pane › Nuovo gruppo): the DAX of the calculated column that implements a grouping.
import type { Grouping } from './types';

const tq = (t: string) => `'${t.replace(/'/g, "''")}'`;
const cq = (c: string) => `[${c.replace(/]/g, ']]')}]`;
const str = (v: string) => `"${v.replace(/"/g, '""')}"`;

/** `numeric`: the grouped column is a number (values written as numbers, not text). */
export function groupingDax(g: Grouping, numeric: boolean): string {
  const c = `${tq(g.table)}${cq(g.column)}`;
  if (g.kind === 'bin') {
    const n = g.bin?.size || 1;
    if (g.bin?.unit === 'year') return `IF(ISBLANK(${c}), BLANK(), DATE(INT(YEAR(${c}) / ${n}) * ${n}, 1, 1))`;
    if (g.bin?.unit === 'month') return `IF(ISBLANK(${c}), BLANK(), DATE(YEAR(${c}), INT((MONTH(${c}) - 1) / ${n}) * ${n} + 1, 1))`;
    return `IF(ISBLANK(${c}), BLANK(), INT(${c} / ${n}) * ${n})`;
  }
  const lit = (v: string) => (numeric && /^-?\d+(\.\d+)?$/.test(v) ? v : str(v));
  const conds = (g.groups ?? []).filter((x) => x.values.length).map((x) => {
    const vals = x.values.filter((v): v is string => v !== null);
    const parts = [vals.length ? `${c} IN {${vals.map(lit).join(', ')}}` : '', x.values.includes(null) ? `ISBLANK(${c})` : ''].filter(Boolean);
    return `${parts.join(' || ')}, ${str(x.name)}`;
  });
  // Ungrouped values: the "Altro" group, or each value as itself (as text, like Power BI).
  const rest = g.other !== undefined ? str(g.other) : numeric ? `FORMAT(${c}, "General Number")` : c;
  return conds.length ? `SWITCH(TRUE(),\n    ${conds.join(',\n    ')},\n    ${rest})` : rest;
}
