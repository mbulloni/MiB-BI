// Sicurezza a livello di oggetto (OLS): roles hide whole tables ("Table") or columns ("Table\u0001Column"). While
// viewing as roles (Visualizza come) the hidden objects leave the Data pane, and visuals that use them — directly or
// through a measure — show an error instead of data, like Power BI.
import type { FieldRef, Measure, RoleDef } from './types';

let hidden: Set<string> | null = null;
/** Objects hidden for the roles being viewed (null = no OLS in effect); kept in sync by store.setViewAs. */
export const olsHidden = () => hidden;
export const setOls = (h: Set<string> | null) => { hidden = h && h.size ? h : null; };

/** With several roles an object stays hidden only when every role hides it (permissions add up). */
export function olsFor(roles: RoleDef[]): Set<string> | null {
  if (!roles.length) return null;
  const sets = roles.map((r) => new Set(r.hidden ?? []));
  return new Set([...sets[0]].filter((k) => sets.every((s) => s.has(k))));
}

export const isHiddenObject = (h: Set<string> | null, table: string, column?: string) =>
  !!h && (h.has(table) || (column !== undefined && h.has(`${table}\u0001${column}`)));

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Does DAX text reference the hidden table or column (Table[..], 'Table'[..], or [Column] inside its own table)? */
function daxUses(expr: string, home: string, key: string): boolean {
  const [t, c] = key.split('\u0001');
  const tbl = `(?:'${esc(t.replace(/'/g, "''"))}'|${/^[A-Za-z_]\w*$/.test(t) ? esc(t) : '(?!)'})`;
  if (c === undefined) return new RegExp(`${tbl}\\s*(\\[|\\b)`, 'i').test(expr);
  const col = `\\[${esc(c.replace(/]/g, ']]'))}\\]`;
  return new RegExp(`${tbl}\\s*${col}`, 'i').test(expr) || (home.toLowerCase() === t.toLowerCase() && new RegExp(`(^|[^\\w'\\]])${col}`, 'i').test(expr));
}

/** First hidden object a field depends on (measures followed through the measures they reference), or null. */
export function olsBlock(f: FieldRef, measures: Measure[], h: Set<string> | null = hidden, seen = new Set<string>()): string | null {
  if (!h || !f.table) return null;
  if (f.agg !== 'measure') return isHiddenObject(h, f.table, f.column) ? (h.has(f.table) ? f.table : `${f.table}[${f.column}]`) : null;
  const m = measures.find((x) => x.name === f.column);
  if (!m || seen.has(m.name)) return null;
  seen.add(m.name);
  if (h.has(m.table)) return m.table;
  for (const k of h) if (daxUses(m.expression, m.table, k)) return k.replace('\u0001', '[') + (k.includes('\u0001') ? ']' : '');
  for (const r of m.expression.matchAll(/\[([^\]]+)\]/g)) {
    const dep = measures.find((x) => x.name === r[1]);
    if (dep) { const b = olsBlock({ table: dep.table, column: dep.name, agg: 'measure' }, measures, h, seen); if (b) return b; }
  }
  return null;
}
