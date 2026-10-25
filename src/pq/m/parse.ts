// Power Query M parser: the full expression language (let, if, each, functions, try/otherwise/catch, error,
// records, lists with ranges, field/item access with ?, projections, type expressions, meta, @ scoping,
// #date/#table/… intrinsics, comments) → AST evaluated by src/pq/m/eval.ts.
import { MError } from './values';

export type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'lit'; v: null | boolean }
  | { k: 'id'; name: string; at?: boolean }
  | { k: 'let'; binds: [string, Node][]; body: Node }
  | { k: 'if'; c: Node; t: Node; e: Node }
  | { k: 'fn'; params: { name: string; optional: boolean; type?: Node }[]; ret?: Node; body: Node }
  | { k: 'each'; body: Node }
  | { k: 'call'; f: Node; args: Node[] }
  | { k: 'list'; items: (Node | { range: [Node, Node] })[] }
  | { k: 'record'; fields: [string, Node][] }
  | { k: 'field'; e: Node | null; name: string; opt: boolean }
  | { k: 'proj'; e: Node | null; names: string[]; opt: boolean }
  | { k: 'item'; e: Node; i: Node; opt: boolean }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'un'; op: string; a: Node }
  | { k: 'try'; e: Node; otherwise?: Node; catcher?: Node }
  | { k: 'error'; e: Node }
  | { k: 'type'; t: TypeNode }
  | { k: 'notimpl' };

export type TypeNode =
  | { t: 'prim'; name: string; nullable?: boolean }
  | { t: 'list'; item: TypeNode; nullable?: boolean }
  | { t: 'record'; fields: { name: string; type: TypeNode; optional: boolean }[]; open: boolean; nullable?: boolean }
  | { t: 'table'; columns: { name: string; type: TypeNode }[]; nullable?: boolean }
  | { t: 'function'; nullable?: boolean }
  | { t: 'expr'; e: Node; nullable?: boolean };

type Tok = { t: 'num' | 'str' | 'id' | 'qid' | 'op' | 'kw' | 'hash' | 'eof'; v: string; pos: number };

const KEYWORDS = new Set(['and', 'as', 'each', 'else', 'error', 'false', 'if', 'in', 'is', 'let', 'meta', 'not', 'null', 'or', 'otherwise', 'section', 'shared', 'then', 'true', 'try', 'type', 'catch']);
const OPS = ['...', '..', '=>', '<=', '>=', '<>', '??', '=', '<', '>', '+', '-', '*', '/', '&', '(', ')', '[', ']', '{', '}', ',', ';', '?', '@', '!'];

export class MSyntaxError extends MError {
  constructor(message: string, public pos: number) { super('Expression.SyntaxError', message); }
}

/** Text literal body: "" → ", #(cr) #(lf) #(tab) #(#) #(0041) escapes (comma-separated lists allowed). */
function unescapeText(s: string): string {
  const one = (t: string) => (t === 'cr' ? '\r' : t === 'lf' ? '\n' : t === 'tab' ? '\t' : t === '#' ? '#'
    : /^[0-9a-fA-F]{4}$|^[0-9a-fA-F]{8}$/.test(t) ? String.fromCodePoint(parseInt(t, 16)) : null);
  return s.replace(/""/g, '"').replace(/#\(([^)]*)\)/g, (m, inner: string) => {
    const parts = inner.split(',').map((x) => one(x.trim()));
    return parts.every((x) => x !== null) ? parts.join('') : m;
  });
}

export function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === '﻿') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new MSyntaxError('Commento non terminato', i); i = e + 2; continue; }
    const start = i;
    if (c === '"') {
      i++;
      let s = '';
      for (;;) {
        if (i >= src.length) throw new MSyntaxError('Testo non terminato', start);
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '""'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      out.push({ t: 'str', v: unescapeText(s), pos: start });
      continue;
    }
    if (c === '#' && src[i + 1] === '"') {
      i += 2;
      let s = '';
      for (;;) {
        if (i >= src.length) throw new MSyntaxError('Identificatore non terminato', start);
        if (src[i] === '"') { if (src[i + 1] === '"') { s += '""'; i += 2; continue; } i++; break; }
        s += src[i++];
      }
      out.push({ t: 'qid', v: unescapeText(s), pos: start });
      continue;
    }
    if (c === '#') {
      const m = /^#[A-Za-z]+/.exec(src.slice(i));
      if (m) { out.push({ t: 'hash', v: m[0], pos: start }); i += m[0].length; continue; }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+|(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)/.exec(src.slice(i))!;
      out.push({ t: 'num', v: m[0], pos: start });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      // Identifiers may contain dots between parts: Table.AddColumn, Number.Type.
      const m = /^[A-Za-z_À-￿][A-Za-z0-9_À-￿]*(?:\.[A-Za-z_À-￿][A-Za-z0-9_À-￿]*)*/.exec(src.slice(i))!;
      const w = m[0];
      out.push({ t: KEYWORDS.has(w) ? 'kw' : 'id', v: w, pos: start });
      i += w.length;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new MSyntaxError(`Carattere non valido: ${c}`, i);
    out.push({ t: 'op', v: op, pos: start });
    i += op.length;
  }
  out.push({ t: 'eof', v: '', pos: src.length });
  return out;
}

const PRIM_TYPES = new Set(['any', 'anynonnull', 'binary', 'date', 'datetime', 'datetimezone', 'duration', 'function', 'list', 'logical', 'none', 'null', 'number', 'record', 'table', 'text', 'time', 'type', 'action']);

class Parser {
  i = 0;
  constructor(private toks: Tok[], private src: string) {}
  get cur() { return this.toks[this.i]; }
  peek(n = 1) { return this.toks[this.i + n]; }
  is(v: string, t?: Tok['t']) { const c = this.cur; return c.v === v && (t ? c.t === t : c.t === 'op' || c.t === 'kw'); }
  eat(v: string) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v: string) {
    if (!this.eat(v)) throw new MSyntaxError(`Atteso "${v}"${this.cur.t === 'eof' ? ' alla fine dell\'espressione' : `, trovato "${this.cur.v}"`}`, this.cur.pos);
  }
  /** Identifier for let/record names and field access: regular, quoted, keywords and generalized (spaces) names. */
  name(): string {
    const c = this.cur;
    if (c.t === 'id' || c.t === 'qid' || c.t === 'kw') { this.i++; return c.v; }
    throw new MSyntaxError(`Atteso un nome, trovato "${c.v}"`, c.pos);
  }
  /** Generalized identifier inside [ ]: words separated by spaces, up to ] , or =. */
  genName(stop: string[]): string {
    const c = this.cur;
    if (c.t === 'qid') { this.i++; return c.v; }
    const start = c.pos;
    let end = start;
    while (this.cur.t !== 'eof' && !(this.cur.t === 'op' && stop.includes(this.cur.v))) { const t = this.cur; end = t.pos + this.tokLen(t); this.i++; }
    const name = this.src.slice(start, end).trim();
    if (!name) throw new MSyntaxError('Nome di campo mancante', start);
    return name;
  }
  tokLen(t: Tok) {
    if (t.t === 'str') { let j = t.pos + 1; for (;;) { if (this.src[j] === '"') { if (this.src[j + 1] === '"') { j += 2; continue; } return j + 1 - t.pos; } j++; } }
    if (t.t === 'qid') { let j = t.pos + 2; for (;;) { if (this.src[j] === '"') { if (this.src[j + 1] === '"') { j += 2; continue; } return j + 1 - t.pos; } j++; } }
    return t.v.length;
  }

  expression(): Node {
    const c = this.cur;
    if (c.t === 'kw') {
      if (c.v === 'let') return this.letExpr();
      if (c.v === 'if') { this.i++; const cond = this.expression(); this.expect('then'); const t = this.expression(); this.expect('else'); return { k: 'if', c: cond, t, e: this.expression() }; }
      if (c.v === 'each') { this.i++; return { k: 'each', body: this.expression() }; }
      if (c.v === 'error') { this.i++; return { k: 'error', e: this.expression() }; }
      if (c.v === 'try') {
        this.i++;
        const e = this.expression();
        if (this.eat('otherwise')) return { k: 'try', e, otherwise: this.expression() };
        if (this.eat('catch')) return { k: 'try', e, catcher: this.expression() };
        return { k: 'try', e };
      }
    }
    if (this.is('(') && this.looksLikeFunction()) return this.functionExpr();
    return this.logicalOr();
  }

  /** ( ) => …, (x) => …, (x as number, optional y) as text => … */
  looksLikeFunction(): boolean {
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === 'op' && t.v === '(') depth++;
      else if (t.t === 'op' && t.v === ')') { depth--; if (depth === 0) { const n = this.toks[j + 1]; return (n.t === 'op' && n.v === '=>') || (n.t === 'kw' && n.v === 'as'); } }
      else if (t.t === 'eof') return false;
    }
    return false;
  }
  functionExpr(): Node {
    this.expect('(');
    const params: { name: string; optional: boolean; type?: Node }[] = [];
    while (!this.is(')')) {
      const optional = this.cur.t === 'id' && this.cur.v === 'optional' && (this.peek().t === 'id' || this.peek().t === 'qid') ? (this.i++, true) : false;
      const name = this.name();
      let type: Node | undefined;
      if (this.eat('as')) type = { k: 'type', t: this.primaryType(true) };
      params.push({ name, optional, type });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    let ret: Node | undefined;
    if (this.eat('as')) ret = { k: 'type', t: this.primaryType(true) };
    this.expect('=>');
    return { k: 'fn', params, ret, body: this.expression() };
  }
  letExpr(): Node {
    this.expect('let');
    const binds: [string, Node][] = [];
    while (!this.is('in')) {
      const name = this.name();
      this.expect('=');
      binds.push([name, this.expression()]);
      if (!this.eat(',')) break;
    }
    this.expect('in');
    return { k: 'let', binds, body: this.expression() };
  }

  logicalOr(): Node { let a = this.logicalAnd(); while (this.eat('or')) a = { k: 'bin', op: 'or', a, b: this.logicalAnd() }; return a; }
  logicalAnd(): Node { let a = this.isExpr(); while (this.eat('and')) a = { k: 'bin', op: 'and', a, b: this.isExpr() }; return a; }
  isExpr(): Node { let a = this.asExpr(); while (this.eat('is')) a = { k: 'bin', op: 'is', a, b: { k: 'type', t: this.primaryType(true) } }; return a; }
  asExpr(): Node { let a = this.equality(); while (this.eat('as')) a = { k: 'bin', op: 'as', a, b: { k: 'type', t: this.primaryType(true) } }; return a; }
  equality(): Node {
    let a = this.relational();
    for (;;) { const op = ['=', '<>'].find((o) => this.is(o)); if (!op) return a; this.i++; a = { k: 'bin', op, a, b: this.relational() }; }
  }
  relational(): Node {
    let a = this.coalesce();
    for (;;) { const op = ['<=', '>=', '<', '>'].find((o) => this.is(o)); if (!op) return a; this.i++; a = { k: 'bin', op, a, b: this.coalesce() }; }
  }
  coalesce(): Node { let a = this.additive(); while (this.eat('??')) a = { k: 'bin', op: '??', a, b: this.additive() }; return a; }
  additive(): Node {
    let a = this.multiplicative();
    for (;;) { const op = ['+', '-', '&'].find((o) => this.is(o)); if (!op) return a; this.i++; a = { k: 'bin', op, a, b: this.multiplicative() }; }
  }
  multiplicative(): Node {
    let a = this.metadata();
    for (;;) { const op = ['*', '/'].find((o) => this.is(o)); if (!op) return a; this.i++; a = { k: 'bin', op, a, b: this.metadata() }; }
  }
  metadata(): Node { let a = this.unary(); while (this.eat('meta')) a = { k: 'bin', op: 'meta', a, b: this.unary() }; return a; }
  unary(): Node {
    if (this.eat('-')) return { k: 'un', op: '-', a: this.unary() };
    if (this.eat('+')) return { k: 'un', op: '+', a: this.unary() };
    if (this.eat('not')) return { k: 'un', op: 'not', a: this.unary() };
    if (this.is('type') && this.cur.t === 'kw') { this.i++; return { k: 'type', t: this.primaryType(false) }; }
    return this.postfix(this.primary());
  }
  postfix(e: Node): Node {
    for (;;) {
      if (this.is('(')) { this.i++; const args: Node[] = []; while (!this.is(')')) { args.push(this.expression()); if (!this.eat(',')) break; } this.expect(')'); e = { k: 'call', f: e, args }; continue; }
      if (this.is('{')) { this.i++; const i = this.expression(); this.expect('}'); const opt = this.eat('?'); e = { k: 'item', e, i, opt }; continue; }
      if (this.is('[')) { e = this.fieldAccess(e); continue; }
      return e;
    }
  }
  /** [Field], [Field]?, [[A],[B]] projection. */
  fieldAccess(e: Node | null): Node {
    this.expect('[');
    if (this.is('[')) {
      const names: string[] = [];
      while (this.eat('[')) { names.push(this.genName([']'])); this.expect(']'); if (!this.eat(',')) break; }
      this.expect(']');
      return { k: 'proj', e, names, opt: this.eat('?') };
    }
    const name = this.genName([']']);
    this.expect(']');
    return { k: 'field', e, name, opt: this.eat('?') };
  }
  primary(): Node {
    const c = this.cur;
    switch (c.t) {
      case 'num': this.i++; return { k: 'num', v: c.v.startsWith('0x') || c.v.startsWith('0X') ? parseInt(c.v, 16) : Number(c.v) };
      case 'str': this.i++; return { k: 'str', v: c.v };
      case 'qid': this.i++; return { k: 'id', name: c.v };
      case 'id': this.i++; return { k: 'id', name: c.v };
      case 'hash': this.i++; return { k: 'id', name: c.v };
      case 'kw':
        if (c.v === 'null') { this.i++; return { k: 'lit', v: null }; }
        if (c.v === 'true' || c.v === 'false') { this.i++; return { k: 'lit', v: c.v === 'true' }; }
        if (['let', 'if', 'each', 'try', 'error'].includes(c.v)) return this.expression();
        break;
      case 'op':
        if (c.v === '(') {
          if (this.looksLikeFunction()) return this.functionExpr();
          this.i++; const e = this.expression(); this.expect(')'); return e;
        }
        if (c.v === '{') return this.listExpr();
        if (c.v === '[') return this.recordOrField();
        if (c.v === '@') { this.i++; const n = this.name(); return { k: 'id', name: n, at: true }; }
        if (c.v === '...') { this.i++; return { k: 'notimpl' }; }
        break;
    }
    throw new MSyntaxError(c.t === 'eof' ? 'Espressione incompleta' : `Simbolo inatteso: "${c.v}"`, c.pos);
  }
  listExpr(): Node {
    this.expect('{');
    const items: (Node | { range: [Node, Node] })[] = [];
    while (!this.is('}')) {
      const a = this.expression();
      if (this.eat('..')) items.push({ range: [a, this.expression()] }); else items.push(a);
      if (!this.eat(',')) break;
    }
    this.expect('}');
    return { k: 'list', items };
  }
  /** [a = 1, b = 2] is a record, [Field] an implicit field access on _ (inside each). */
  recordOrField(): Node {
    // Look ahead for "=" at depth 1 before the closing bracket.
    let depth = 0;
    for (let j = this.i; j < this.toks.length; j++) {
      const t = this.toks[j];
      if (t.t === 'op' && (t.v === '[' || t.v === '(' || t.v === '{')) depth++;
      else if (t.t === 'op' && (t.v === ']' || t.v === ')' || t.v === '}')) { depth--; if (depth === 0) break; }
      else if (depth === 1 && t.t === 'op' && t.v === '=') return this.recordExpr();
      else if (t.t === 'eof') break;
    }
    if (this.peek().t === 'op' && this.peek().v === ']') { this.i += 2; return { k: 'record', fields: [] }; }
    return this.fieldAccess(null);
  }
  recordExpr(): Node {
    this.expect('[');
    const fields: [string, Node][] = [];
    while (!this.is(']')) {
      const name = this.genName(['=']);
      this.expect('=');
      fields.push([name, this.expression()]);
      if (!this.eat(',')) break;
    }
    this.expect(']');
    return { k: 'record', fields };
  }

  /** Type expressions: primitive names, nullable, {item}, [record], table [..], function (..) as .., or a parenthesized expression. */
  primaryType(allowNullable: boolean): TypeNode {
    if (this.cur.t === 'id' && this.cur.v === 'nullable') { this.i++; const t = this.primaryType(true); return { ...t, nullable: true }; }
    const c = this.cur;
    if ((c.t === 'id' || c.t === 'kw') && PRIM_TYPES.has(c.v)) {
      if (c.v === 'table' && this.peek().t === 'op' && this.peek().v === '[') { this.i++; return this.tableType(); }
      if (c.v === 'function' && this.peek().t === 'op' && this.peek().v === '(') {
        this.i++;
        let depth = 0;
        do { if (this.is('(')) depth++; if (this.is(')')) depth--; this.i++; } while (depth > 0 && this.cur.t !== 'eof');
        if (this.eat('as')) this.primaryType(true);
        return { t: 'function' };
      }
      this.i++;
      return { t: 'prim', name: c.v };
    }
    if (this.is('{')) { this.i++; const item = this.primaryType(true); this.expect('}'); return { t: 'list', item }; }
    if (this.is('[')) return this.recordType();
    if (c.t === 'kw' && c.v === 'type') { this.i++; return this.primaryType(allowNullable); }
    // Any other expression evaluating to a type (Int64.Type, (type text)).
    return { t: 'expr', e: this.postfix(this.primary()) };
  }
  recordType(): TypeNode {
    this.expect('[');
    const fields: { name: string; type: TypeNode; optional: boolean }[] = [];
    let open = false;
    while (!this.is(']')) {
      if (this.eat('...')) { open = true; break; }
      const optional = this.cur.t === 'id' && this.cur.v === 'optional' && this.peek().t !== 'op' ? (this.i++, true) : false;
      const name = this.genName(['=', ',', ']']);
      const type: TypeNode = this.eat('=') ? this.primaryType(true) : { t: 'prim', name: 'any' };
      fields.push({ name, type, optional });
      if (!this.eat(',')) break;
    }
    this.expect(']');
    return { t: 'record', fields, open };
  }
  tableType(): TypeNode {
    const r = this.recordType() as Extract<TypeNode, { t: 'record' }>;
    return { t: 'table', columns: r.fields.map((f) => ({ name: f.name, type: f.type })) };
  }
}

/** Parses a whole M document (an expression, possibly a let) into an AST. */
export function parseM(src: string): Node {
  const p = new Parser(lex(src), src);
  const e = p.expression();
  if (p.cur.t !== 'eof') throw new MSyntaxError(`Testo inatteso: "${p.cur.v}"`, p.cur.pos);
  return e;
}

/** Top-level let steps of a query (Passaggi applicati): name and source text of each binding. */
export function letSteps(src: string): { steps: { name: string; start: number; end: number }[]; result: string } | null {
  const toks = lex(src);
  const p = new Parser(toks, src);
  if (!(p.cur.t === 'kw' && p.cur.v === 'let')) return null;
  p.i++;
  const steps: { name: string; start: number; end: number }[] = [];
  while (!p.is('in')) {
    const name = p.name();
    p.expect('=');
    const start = p.cur.pos;
    p.expression();
    const last = toks[p.i - 1];
    steps.push({ name, start, end: last.pos + p.tokLen(last) });
    if (!p.eat(',')) break;
  }
  p.expect('in');
  const r = p.expression();
  void r;
  return { steps, result: src.slice(toks.find((t) => t.t === 'kw' && t.v === 'in' && t.pos >= (steps[steps.length - 1]?.end ?? 0))!.pos + 2).trim() };
}

/** Identifiers used in M code (regular and #"quoted"), with their positions: query dependencies and renames. */
export function mIdentifiers(src: string): { name: string; start: number; end: number; quoted: boolean }[] {
  let toks: Tok[];
  try { toks = lex(src); } catch { return []; }
  const out: { name: string; start: number; end: number; quoted: boolean }[] = [];
  const p = new Parser(toks, src);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'id' && t.t !== 'qid') continue;
    // Field names inside [ ] and record keys are not references.
    const prev = toks[i - 1], next = toks[i + 1];
    if (prev?.t === 'op' && (prev.v === '[' || prev.v === ',') && next?.t === 'op' && (next.v === ']' || next.v === '=') && insideBrackets(toks, i)) continue;
    out.push({ name: t.v, start: t.pos, end: t.pos + p.tokLen(t), quoted: t.t === 'qid' });
  }
  return out;
}
function insideBrackets(toks: Tok[], i: number): boolean {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const t = toks[j];
    if (t.t !== 'op') continue;
    if (t.v === ']' || t.v === ')' || t.v === '}') depth++;
    else if (t.v === '[' || t.v === '(' || t.v === '{') { if (depth === 0) return t.v === '['; depth--; }
  }
  return false;
}
