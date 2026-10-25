// Applied steps of an M query = the bindings of its top-level let (Power Query shows them as steps):
// preview up to a step, replace or delete a step, append a step written as M.
import { letSteps, parseM } from './parse';
import { mName } from '../m';

export interface MSteps { steps: { name: string; start: number; end: number }[]; isLet: boolean }

export function mSteps(code: string): MSteps {
  try {
    const r = letSteps(code);
    if (r && r.steps.length) return { steps: r.steps, isLet: true };
  } catch { /* syntax error: one step */ }
  return { steps: [{ name: 'Origine', start: 0, end: code.length }], isLet: false };
}

/** Code evaluating to step k (null = the whole query). */
export function codeUpTo(code: string, k: number | null): string {
  const m = mSteps(code);
  if (k === null || !m.isLet || k >= m.steps.length - 1 && resultIsLast(code, m)) return code;
  const s = m.steps[k];
  return `${code.slice(0, s.end)}\nin\n    ${mName(s.name)}`;
}
function resultIsLast(code: string, m: MSteps): boolean {
  const tail = code.slice(m.steps[m.steps.length - 1].end).replace(/^\s*in\s*/, '').trim();
  return tail === mName(m.steps[m.steps.length - 1].name) || tail === m.steps[m.steps.length - 1].name;
}

/** Expression text of step k. */
export const stepExpr = (code: string, k: number) => { const s = mSteps(code).steps[k]; return s ? code.slice(s.start, s.end) : ''; };

/** Replaces the expression of step k (the new code is parsed to report syntax errors). */
export function replaceStep(code: string, k: number, expr: string): string {
  const s = mSteps(code).steps[k];
  const out = code.slice(0, s.start) + expr.trim() + code.slice(s.end);
  parseM(out);
  return out;
}

/** Removes step k; when it was the result, the previous step becomes the result. */
export function deleteStep(code: string, k: number): string {
  const m = mSteps(code);
  if (!m.isLet || m.steps.length < 2) return code;
  const steps = m.steps;
  const tail = code.slice(steps[steps.length - 1].end).replace(/^\s*in\s*/, '').trim();
  const kept = steps.filter((_, i) => i !== k);
  const result = tail === mName(steps[k].name) || tail === steps[k].name ? kept[Math.min(k, kept.length) - 1]?.name ?? kept[0].name : tail;
  const text = (i: number) => `    ${mName(steps[i].name)} = ${code.slice(steps[i].start, steps[i].end)}`;
  return `let\n${steps.map((_, i) => i).filter((i) => i !== k).map(text).join(',\n')}\nin\n    ${result === tail ? tail : mName(result)}`;
}

/** Appends a step `name = expr(prev)` after the result of the query; returns the new code and the step name. */
export function appendStep(code: string, label: string, expr: (prev: string) => string): string {
  const m = mSteps(code);
  const names = new Set(m.steps.map((s) => s.name));
  let name = label, i = 1;
  while (names.has(name)) name = `${label}${i++}`;
  if (!m.isLet) return `let\n    Origine = ${code.trim()},\n    ${mName(name)} = ${expr('Origine')}\nin\n    ${mName(name)}`;
  const tail = code.slice(m.steps[m.steps.length - 1].end).replace(/^\s*in\s*/, '').trim();
  const prev = /^(#"(?:[^"]|"")*"|[A-Za-z_][\w.]*)$/.test(tail) ? tail : null;
  const body = m.steps.map((s) => `    ${mName(s.name)} = ${code.slice(s.start, s.end)}`);
  if (!prev) body.push(`    Risultato = ${tail}`);
  const p = prev ?? 'Risultato';
  return `let\n${body.join(',\n')},\n    ${mName(name)} = ${expr(p)}\nin\n    ${mName(name)}`;
}
