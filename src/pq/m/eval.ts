// Power Query M evaluator. Synchronous and lazy (let bindings, record fields) like the M engine.
// Data access goes through a Host: when a source is not cached yet the evaluator throws NeedData, the driver
// (runM) fetches it asynchronously and evaluates again — evaluation is deterministic, so reruns are cheap.
import type { Node, TypeNode } from './parse';
import { parseM } from './parse';
import {
  DAY, ErrorCell, Lazy, MBinary, MDate, MDateTime, MDateTimeZone, MDuration, MError, MFunction, MList, MRecord, MTable, MTime, MType,
  TYPE, compare, conforms, equals, err, force, kindName, type Param,
} from './values';

/** Thrown when the evaluation needs data that is not loaded yet. */
export class NeedData {
  constructor(public key: string, public fetch: () => Promise<unknown>) {}
}

export interface Host {
  /** Cached result of `fetch` for `key`; throws NeedData the first time. */
  request<T>(key: string, fetch: () => Promise<T>): T;
  /** Other queries and parameters of the report, by name (undefined = unknown). */
  resolve(name: string): unknown | undefined;
}

export class Env {
  constructor(private vars: Map<string, unknown>, private parent: Env | null, public host: Host) {}
  lookup(name: string): unknown {
    for (let e: Env | null = this; e; e = e.parent) if (e.vars.has(name)) return force(e.vars.get(name));
    const r = this.host.resolve(name);
    if (r !== undefined) return force(r);
    throw err(`Il nome '${name}' non è riconosciuto. Verificare che sia stato digitato correttamente.`);
  }
  has(name: string): boolean {
    for (let e: Env | null = this; e; e = e.parent) if (e.vars.has(name)) return true;
    return this.host.resolve(name) !== undefined;
  }
  child(vars: Map<string, unknown>) { return new Env(vars, this, this.host); }
}

const isNum = (v: unknown): v is number => typeof v === 'number';
const cannot = (op: string, a: unknown, b?: unknown) =>
  err(`Impossibile applicare l'operatore ${op} ai tipi ${kindName(a)}${b === undefined ? '' : ` e ${kindName(b)}`}.`);

/* ------------------------------- operators ------------------------------- */

export function add(a: any, b: any): any {
  if (a === null || b === null) return null;
  if (isNum(a) && isNum(b)) return a + b;
  if (a instanceof MDuration && b instanceof MDuration) return new MDuration(a.ms + b.ms);
  if (b instanceof MDuration) {
    if (a instanceof MDate) return new MDate(a.days + Math.floor(b.ms / DAY));
    if (a instanceof MDateTime) return new MDateTime(a.ms + b.ms);
    if (a instanceof MDateTimeZone) return new MDateTimeZone(a.ms + b.ms, a.offset);
    if (a instanceof MTime) return new MTime((((a.ms + b.ms) % DAY) + DAY) % DAY);
  }
  if (a instanceof MDuration) return add(b, a);
  // date + time = datetime
  if (a instanceof MDate && b instanceof MTime) return new MDateTime(a.days * DAY + b.ms);
  throw cannot('+', a, b);
}
export function sub(a: any, b: any): any {
  if (a === null || b === null) return null;
  if (isNum(a) && isNum(b)) return a - b;
  if (b instanceof MDuration) return add(a, new MDuration(-b.ms));
  if (a instanceof MDate && b instanceof MDate) return new MDuration((a.days - b.days) * DAY);
  if (a instanceof MDateTime && b instanceof MDateTime) return new MDuration(a.ms - b.ms);
  if (a instanceof MDateTimeZone && b instanceof MDateTimeZone) return new MDuration(a.utc - b.utc);
  if (a instanceof MTime && b instanceof MTime) return new MDuration(a.ms - b.ms);
  throw cannot('-', a, b);
}
export function mul(a: any, b: any): any {
  if (a === null || b === null) return null;
  if (isNum(a) && isNum(b)) return a * b;
  if (a instanceof MDuration && isNum(b)) return new MDuration(a.ms * b);
  if (isNum(a) && b instanceof MDuration) return new MDuration(a * b.ms);
  throw cannot('*', a, b);
}
export function div(a: any, b: any): any {
  if (a === null || b === null) return null;
  if (isNum(a) && isNum(b)) return a / b;
  if (a instanceof MDuration && isNum(b)) return new MDuration(a.ms / b);
  if (a instanceof MDuration && b instanceof MDuration) return a.ms / b.ms;
  throw cannot('/', a, b);
}
export function concat(a: any, b: any): any {
  if (a === null || b === null) return null;
  if (typeof a === 'string' && typeof b === 'string') return a + b;
  if (a instanceof MList && b instanceof MList) return new MList([...a.items, ...b.items]);
  if (a instanceof MRecord && b instanceof MRecord) {
    const names = [...a.names], vals = [...a.vals];
    b.names.forEach((n, i) => { const j = names.indexOf(n); if (j >= 0) vals[j] = b.vals[i]; else { names.push(n); vals.push(b.vals[i]); } });
    return new MRecord(names, vals);
  }
  if (a instanceof MTable && b instanceof MTable) return appendTables([a, b]);
  if (a instanceof MDate && b instanceof MTime) return new MDateTime(a.days * DAY + b.ms);
  throw cannot('&', a, b);
}
export function appendTables(ts: MTable[]): MTable {
  const cols: string[] = [];
  for (const t of ts) for (const c of t.columns) if (!cols.includes(c)) cols.push(c);
  const rows: unknown[][] = [];
  for (const t of ts) {
    const idx = cols.map((c) => t.columns.indexOf(c));
    for (const r of t.rows) rows.push(idx.map((i) => (i < 0 ? null : r[i])));
  }
  // Column types kept when every table agrees.
  const types = cols.map((c) => { const ty = ts.map((t) => t.typeOf(t.columns.indexOf(c))); return ty.every((x) => x && x.kind === ty[0]?.kind) ? ty[0] : undefined; });
  return new MTable(cols, rows, types);
}

/* ------------------------------- types ------------------------------- */

const PRIM: Record<string, MType> = {
  any: TYPE.any, anynonnull: TYPE.anynonnull, none: TYPE.none, null: TYPE.null, logical: TYPE.logical, number: TYPE.number, text: TYPE.text,
  date: TYPE.date, datetime: TYPE.datetime, datetimezone: TYPE.datetimezone, time: TYPE.time, duration: TYPE.duration, binary: TYPE.binary,
  list: TYPE.list, record: TYPE.record, table: TYPE.table, function: TYPE.function, type: TYPE.type, action: new MType('action'),
};
function evalType(t: TypeNode, env: Env): MType {
  let r: MType;
  switch (t.t) {
    case 'prim': r = PRIM[t.name] ?? TYPE.any; break;
    case 'list': r = new MType('list', false, undefined, evalType(t.item, env)); break;
    case 'record': r = new MType('record', false, undefined, undefined, t.fields.map((f) => ({ name: f.name, type: evalType(f.type, env), optional: f.optional })), t.open); break;
    case 'table': r = new MType('table', false, undefined, undefined, undefined, false, t.columns.map((c) => ({ name: c.name, type: evalType(c.type, env) }))); break;
    case 'function': r = TYPE.function; break;
    case 'expr': { const v = evaluate(t.e, env); if (!(v instanceof MType)) throw err('Atteso un tipo.'); r = v; break; }
  }
  return t.nullable ? Object.assign(Object.create(Object.getPrototypeOf(r)), r, { nullable: true }) : r;
}

/* ------------------------------- evaluation ------------------------------- */

export function invoke(f: unknown, args: unknown[]): any {
  f = force(f);
  if (!(f instanceof MFunction)) throw err(`Impossibile chiamare un valore di tipo ${kindName(f)} come funzione.`);
  if (args.length < f.required || args.length > f.arity) {
    throw err(`Al numero di argomenti forniti per la funzione ${f.name ? `'${f.name}' ` : ''}non corrisponde il numero previsto (${f.required}${f.arity !== f.required ? `-${f.arity}` : ''}), ricevuti ${args.length}.`);
  }
  return force(f.call(args));
}

function fieldOf(v: any, name: string, opt: boolean): any {
  v = force(v);
  if (v instanceof MRecord) { if (!v.has(name)) { if (opt) return null; throw err(`Il campo '${name}' del record non è stato trovato.`, 'Expression.Error', MRecord.from({ Field: name })); } return v.get(name); }
  if (v instanceof MTable) {
    const i = v.columns.indexOf(name);
    if (i < 0) { if (opt) return null; v.col(name); }
    return new MList(v.rows.map((r) => r[i]));
  }
  if (v === null && opt) return null;
  throw err(`Impossibile accedere al campo '${name}' di un valore di tipo ${kindName(v)}.`);
}

function itemOf(v: any, key: any, opt: boolean): any {
  v = force(v); key = force(key);
  if (v instanceof MList) {
    if (typeof key !== 'number') throw err('L\'indice di un elenco deve essere un numero.');
    if (key < 0 || key >= v.length) { if (opt) return null; throw err('Nell\'enumerazione non c\'erano elementi sufficienti per completare l\'operazione.', 'Expression.Error'); }
    return v.at(key);
  }
  if (v instanceof MTable) {
    if (typeof key === 'number') {
      if (key < 0 || key >= v.rows.length) { if (opt) return null; throw err('Nell\'enumerazione non c\'erano elementi sufficienti per completare l\'operazione.'); }
      return v.row(key);
    }
    if (key instanceof MRecord) {
      // Row lookup: the single row whose fields equal the key record (navigation tables: {[Name="Sheet1"]}).
      const idx = key.names.map((n) => v.col(n));
      const hits = v.rows.filter((r) => idx.every((j, k) => equals(r[j], key.get(key.names[k]))));
      if (hits.length === 1) return new MRecord(v.columns, hits[0]);
      if (opt && hits.length === 0) return null;
      throw err(hits.length ? 'La chiave corrisponde a più righe della tabella.' : 'La chiave non corrisponde ad alcuna riga della tabella.', 'Expression.Error', key);
    }
  }
  if (v === null && opt) return null;
  throw err(`Impossibile accedere all'elemento di un valore di tipo ${kindName(v)}.`);
}

function project(v: any, names: string[], opt: boolean): any {
  v = force(v);
  if (v instanceof MRecord) return new MRecord(names, names.map((n) => (v.has(n) ? v.vals[v.names.indexOf(n)] : opt ? null : (() => { throw err(`Il campo '${n}' del record non è stato trovato.`); })())));
  if (v instanceof MTable) {
    const idx = names.map((n) => (v.columns.includes(n) ? v.columns.indexOf(n) : opt ? -1 : v.col(n)));
    return new MTable(names, v.rows.map((r) => idx.map((i) => (i < 0 ? null : r[i]))), idx.map((i) => (i < 0 ? undefined : v.typeOf(i))));
  }
  throw err('Proiezione non valida.');
}

const truthy = (v: unknown, op: string): boolean => {
  if (typeof v !== 'boolean') throw err(`Impossibile convertire il valore ${v === null ? 'null' : kindName(v)} nel tipo Logical (operatore ${op}).`);
  return v;
};

export function evaluate(n: Node, env: Env): any {
  switch (n.k) {
    case 'num': return n.v;
    case 'str': return n.v;
    case 'lit': return n.v;
    case 'id': return env.lookup(n.name);
    case 'let': {
      const vars = new Map<string, unknown>();
      const inner = env.child(vars);
      for (const [name, e] of n.binds) vars.set(name, new Lazy(() => evaluate(e, inner)));
      return evaluate(n.body, inner);
    }
    case 'if': {
      const c = force(evaluate(n.c, env));
      return truthy(c, 'if') ? evaluate(n.t, env) : evaluate(n.e, env);
    }
    case 'each': return new MFunction([{ name: '_' }], (args) => evaluate(n.body, env.child(new Map([['_', args[0]]]))));
    case 'fn': {
      const params: Param[] = n.params.map((p) => ({ name: p.name, optional: p.optional, type: p.type ? evaluate(p.type, env) : undefined }));
      return new MFunction(params, (args) => {
        const vars = new Map<string, unknown>();
        params.forEach((p, i) => vars.set(p.name, i < args.length ? args[i] : null));
        return evaluate(n.body, env.child(vars));
      });
    }
    case 'call': {
      const f = evaluate(n.f, env);
      return invoke(f, n.args.map((a) => new Lazy(() => evaluate(a, env))).map((l) => l.get()));
    }
    case 'list': {
      const out: unknown[] = [];
      for (const it of n.items) {
        if ('range' in it) {
          const a = force(evaluate(it.range[0], env)), b = force(evaluate(it.range[1], env));
          if (typeof a !== 'number' || typeof b !== 'number') throw err('Gli estremi di un intervallo devono essere numeri.');
          for (let x = a; x <= b; x++) out.push(x);
        } else out.push(new Lazy(() => evaluate(it, env)));
      }
      return new MList(out);
    }
    case 'record': {
      const vars = new Map<string, unknown>();
      const inner = env.child(vars);
      const vals = n.fields.map(([name, e]) => { const l = new Lazy(() => evaluate(e, inner)); vars.set(name, l); return l; });
      return new MRecord(n.fields.map((f) => f[0]), vals);
    }
    case 'field': return fieldOf(n.e ? evaluate(n.e, env) : env.lookup('_'), n.name, n.opt);
    case 'proj': return project(n.e ? evaluate(n.e, env) : env.lookup('_'), n.names, n.opt);
    case 'item': return itemOf(evaluate(n.e, env), evaluate(n.i, env), n.opt);
    case 'un': {
      const a = force(evaluate(n.a, env));
      if (n.op === 'not') return a === null ? null : !truthy(a, 'not');
      if (a === null) return null;
      if (n.op === '-') { if (isNum(a)) return -a; if (a instanceof MDuration) return new MDuration(-a.ms); throw cannot('-', a); }
      if (isNum(a) || a instanceof MDuration) return a;
      throw cannot('+', a);
    }
    case 'bin': return binary(n.op, n.a, n.b, env);
    case 'try': {
      try {
        const v = force(evaluate(n.e, env));
        return n.otherwise || n.catcher ? v : MRecord.from({ HasError: false, Value: v });
      } catch (e) {
        if (!(e instanceof MError)) throw e;
        if (n.otherwise) return evaluate(n.otherwise, env);
        if (n.catcher) { const f = force(evaluate(n.catcher, env)) as MFunction; return invoke(f, f.arity ? [e.record()] : []); }
        return MRecord.from({ HasError: true, Error: e.record() });
      }
    }
    case 'error': {
      const v = force(evaluate(n.e, env));
      if (typeof v === 'string') throw err(v);
      if (v instanceof MRecord) throw new MError(v.has('Reason') ? String(v.get('Reason') ?? 'Expression.Error') : 'Expression.Error', v.has('Message') ? String(v.get('Message') ?? '') : '', v.has('Detail') ? v.get('Detail') : null);
      throw err('Errore');
    }
    case 'type': return evalType(n.t, env);
    case 'notimpl': throw new MError('Expression.Error', 'Non implementato.');
  }
}

function binary(op: string, an: Node, bn: Node, env: Env): any {
  if (op === 'and') { const a = force(evaluate(an, env)); if (a === false) return false; const b = force(evaluate(bn, env)); if (a === null) return b === false ? false : null; return b === null ? null : truthy(a, 'and') && truthy(b, 'and'); }
  if (op === 'or') { const a = force(evaluate(an, env)); if (a === true) return true; const b = force(evaluate(bn, env)); if (a === null) return b === true ? true : null; return b === null ? null : truthy(a, 'or') || truthy(b, 'or'); }
  if (op === '??') { const a = force(evaluate(an, env)); return a !== null ? a : evaluate(bn, env); }
  const a = force(evaluate(an, env)), b = force(evaluate(bn, env));
  switch (op) {
    case '+': return add(a, b);
    case '-': return sub(a, b);
    case '*': return mul(a, b);
    case '/': return div(a, b);
    case '&': return concat(a, b);
    case '=': return equals(a, b);
    case '<>': return !equals(a, b);
    case '<': case '>': case '<=': case '>=': {
      if (a === null || b === null) return null;
      if (kindName(a) !== kindName(b)) throw err(`Impossibile confrontare valori di tipo ${kindName(a)} e ${kindName(b)} (operatore ${op}).`);
      const c = compare(a, b);
      return op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    }
    case 'is': return conforms(a, b as MType);
    case 'as': if (!conforms(a, b as MType)) throw err(`Impossibile convertire il valore ${a === null ? 'null' : kindName(a)} nel tipo ${(b as MType).kind}.`); return a;
    case 'meta': return a; // metadata is not tracked (parameter queries carry IsParameterQuery only as a marker)
  }
  throw err(`Operatore non supportato: ${op}`);
}

/* ------------------------------- driver ------------------------------- */

export interface RunOptions {
  /** Standard library (src/pq/m/lib), by name. */
  lib: Map<string, unknown>;
  /** Other queries / parameters, by name; a function so references are evaluated lazily. */
  resolve: (name: string, host: Host) => unknown | undefined;
  /** Cache shared between runs (and between queries of the same refresh). */
  cache?: Map<string, unknown>;
  /** Maximum data loads before giving up (a loop would mean a bug). */
  maxLoads?: number;
}

/** Host of the evaluation in progress (library data sources read it; evaluation is synchronous). */
let CURRENT: Host | null = null;
export const currentHost = (): Host => { if (!CURRENT) throw err('Nessuna valutazione in corso.'); return CURRENT; };

/** Evaluates M source text (or an AST), loading data as needed. `finalize` turns the value into what the caller needs
 *  (e.g. plain rows of a table) inside the same run, so lazy cells can still ask for data. */
export async function runM<R = any>(src: string | Node, opts: RunOptions, finalize: (v: any) => R = (v) => force(v)): Promise<R> {
  const ast = typeof src === 'string' ? parseM(src) : src;
  const cache = opts.cache ?? new Map<string, unknown>();
  for (let n = 0; n < (opts.maxLoads ?? 500); n++) {
    const host: Host = {
      request<T>(key: string, fetch: () => Promise<T>): T {
        if (cache.has(key)) { const v = cache.get(key); if (v instanceof Error) throw v; return v as T; }
        throw new NeedData(key, fetch);
      },
      resolve: (name) => (opts.lib.has(name) ? opts.lib.get(name) : opts.resolve(name, host)),
    };
    const prev = CURRENT;
    CURRENT = host;
    let need: NeedData | null = null;
    try {
      return finalize(evaluate(ast, new Env(new Map(), null, host)));
    } catch (e) {
      if (!(e instanceof NeedData)) throw e;
      need = e;
    } finally {
      CURRENT = prev;
    }
    try { cache.set(need.key, await need.fetch()); } catch (x) { cache.set(need.key, x instanceof MError ? x : new MError('DataSource.Error', (x as Error).message)); }
  }
  throw err('Troppi caricamenti di dati durante la valutazione.');
}

export { ErrorCell };
