import { useEffect, useMemo, useState, type MouseEvent as RMouseEvent } from 'react';
import { api } from '../api';
import { useStore, type PQState } from '../store';
import type { ColumnMeta, DbSource, FilterOp, NewStep, PQType, Step, TransformFn } from '../types';
import { compileQuery, qi } from '../pq/compile';
import { dependencies, pqTypeOf, renameQueryRef, stepNames, TYPE_LABEL } from '../pq/steps';
import { exprToStep, mToQuery } from '../pq/mparse';
import { learn } from '../pq/examples';
import { DataSourceSettings, ParamsDialog } from './SourceDialogs';
import { stepM } from '../pq/m';
import { queryM } from '../pbix/pbit';
import { Icon } from './icons';
import { Menu } from './Menu';
import { Big, Group, Small } from './Ribbon';
import { FILTER_OPS, PQDialog, srcExpr, vtypeOf, type DialogState, type Preview } from './PowerQueryDialogs';
import { locale } from '../format';

type Tab = 'home' | 'transform' | 'add' | 'view';
const TABS: [Tab, string][] = [['home', 'Home'], ['transform', 'Trasforma'], ['add', 'Aggiungi colonna'], ['view', 'Visualizza']];
type MenuState = { kind: string; x: number; y: number; col?: string; query?: string } | null;

const PQ_TYPES: PQType[] = ['decimal', 'int', 'datetime', 'date', 'text', 'bool'];

/** DuckDB errors rephrased like Power Query's Expression.Error / DataSource.Error banners. */
function friendlyError(msg: string): string {
  const col = /Referenced column "?([^"\n]+?)"? not found/.exec(msg) ?? /Column "?([^"\n]+?)"? (?:not found|does not exist)/i.exec(msg)
    ?? /does not have a column named "([^"]+)"/.exec(msg);
  if (col) return `Expression.Error: impossibile trovare la colonna "${col[1]}" della tabella.`;
  if (/No files found|IO Error|does not exist/i.test(msg)) return `DataSource.Error: ${msg.split('\n')[0]}`;
  return msg.split('\n')[0];
}

function TypeGlyph({ c }: { c: ColumnMeta }) {
  const t = pqTypeOf(c.type);
  if (t === 'date' || t === 'datetime') return <Icon name="calendar" size={13} />;
  return <span className="pq-tyg">{t === 'text' ? 'ABC' : t === 'int' ? '123' : t === 'decimal' ? '1.2' : '✓✗'}</span>;
}

const fmtCell = (v: any, c: ColumnMeta) => {
  if (v === null || v === undefined) return 'null';
  const t = pqTypeOf(c.type);
  if (t === 'int' || t === 'decimal') {
    const n = Number(v);
    return Number.isFinite(n) ? n.toLocaleString(locale(), { useGrouping: false, maximumFractionDigits: 10 }) : String(v);
  }
  if (t === 'bool') return v ? 'TRUE' : 'FALSE';
  return String(v);
};

export function PowerQueryEditor() {
  const open = useStore((s) => !!s.pq);
  return open ? <Editor /> : null;
}

function Editor() {
  const s = useStore();
  const pq = s.pq!;
  const q = pq.queries.find((x) => x.name === pq.selected) ?? pq.queries[0];
  const [dbEdit, setDbEdit] = useState(false);
  const upto = q ? pq.step ?? q.steps.length : 0;
  const names = useMemo(() => stepNames(q?.steps ?? []), [q?.steps]);

  const [tab, setTab] = useState<Tab>('home');
  const [sel, setSel] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [opts, setOpts] = useState({ formula: true, quality: true, sql: false, distribution: false, profile: false });
  const [menu, setMenu] = useState<MenuState>(null);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [qName, setQName] = useState(q?.name ?? '');
  useEffect(() => setQName(q?.name ?? ''), [q?.name]);

  const defsKey = JSON.stringify(pq.queries.map((x) => [x.name, x.source, x.steps]));
  useEffect(() => {
    if (!q) { setPreview(null); return; }
    let dead = false;
    setLoading(true);
    (async () => {
      try {
        const sql = await compileQuery(q, pq.queries, { upto, srcExpr });
        const d = await api.query(`DESCRIBE SELECT * FROM (${sql})`);
        const r = await api.query(`SELECT * FROM (${sql}) LIMIT 1000`);
        if (dead) return;
        setPreview({ columns: d.rows.map((x) => ({ name: x.column_name, type: x.column_type })), rows: r.rows, sql, at: new Date(), upto, query: q.name });
        setError(null);
      } catch (e: any) {
        if (!dead) setError(friendlyError(e.message));
      } finally {
        if (!dead) setLoading(false);
      }
    })();
    return () => { dead = true; };
  }, [defsKey, pq.selected, upto, reload]);

  const cols = error ? [] : preview?.columns ?? [];
  useEffect(() => setSel((x) => x.filter((c) => cols.some((k) => k.name === c))), [preview, error]);

  const quality = useMemo(() => {
    const rows = preview?.rows ?? [];
    return new Map(cols.map((c) => {
      const empty = rows.filter((r) => r[c.name] === null || r[c.name] === '').length;
      return [c.name, rows.length ? empty / rows.length : 0];
    }));
  }, [preview]);

  // Column distribution/profile (first 1000 rows, like Power BI's default).
  const dist = useMemo(() => {
    if (!opts.distribution && !opts.profile) return new Map<string, { counts: [string, number][]; distinct: number; unique: number }>();
    const rows = preview?.rows ?? [];
    return new Map(cols.map((c) => {
      const m = new Map<string, number>();
      for (const r of rows) { const k = r[c.name] === null ? '(null)' : String(r[c.name]); m.set(k, (m.get(k) ?? 0) + 1); }
      const counts = [...m.entries()].sort((a, b) => b[1] - a[1]);
      return [c.name, { counts, distinct: m.size, unique: counts.filter(([, n]) => n === 1).length }];
    }));
  }, [preview, opts.distribution, opts.profile]);
  const profileCol = opts.profile ? cols.find((c) => c.name === sel[0]) ?? cols[0] : undefined;
  const stats = useMemo(() => {
    if (!profileCol) return null;
    const vals = (preview?.rows ?? []).map((r) => r[profileCol.name]);
    const nonNull = vals.filter((v) => v !== null && v !== '');
    const nums = nonNull.map(Number).filter((x) => Number.isFinite(x));
    const numeric = vtypeOf(profileCol) === 'number' && nums.length > 0;
    const avg = numeric ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
    const sd = numeric && nums.length > 1 ? Math.sqrt(nums.reduce((a, b) => a + (b - avg) ** 2, 0) / (nums.length - 1)) : 0;
    const d = dist.get(profileCol.name);
    const sorted = [...nonNull].map(String).sort((a, b) => (numeric ? Number(a) - Number(b) : a.localeCompare(b, 'it')));
    return {
      rows: [
        ['Conteggio', vals.length], ['Errore', 0], ['Vuoto', vals.filter((v) => v === '').length], ['Null', vals.filter((v) => v === null).length],
        ['Distinti', d?.distinct ?? 0], ['Univoci', d?.unique ?? 0],
        ...(numeric ? [['Min', Math.min(...nums)], ['Max', Math.max(...nums)], ['Media', avg], ['Deviazione standard', sd], ['Zero', nums.filter((x) => x === 0).length]]
          : [['Min', sorted[0] ?? ''], ['Max', sorted[sorted.length - 1] ?? '']]),
      ] as [string, string | number][],
      top: (d?.counts ?? []).slice(0, 20),
    };
  }, [profileCol, preview, dist]);

  // ---- step helpers -------------------------------------------------------
  // Editing an applied step: the preview shows the step's input, OK replaces the step (same id).
  const [editing, setEditing] = useState<{ index: number; dialog: DialogState; back: number | null } | null>(null);
  const add = (st: NewStep) => {
    if (!editing) { s.pqAddStep(st); return; }
    const i = editing.index;
    s.pqSet((x) => { const qq = x.queries.find((y) => y.name === x.selected)!; qq.steps[i] = { ...st, id: qq.steps[i].id } as Step; });
  };
  const dialogFor = (st: Step): DialogState | null => {
    switch (st.kind) {
      case 'keepTop': case 'keepBottom': case 'removeTop': case 'removeBottom': return { kind: 'rows', step: st.kind };
      case 'filterRows': return ['in', 'notIn', 'blank', 'notBlank'].includes(st.op) ? null : { kind: 'filter', col: st.column, op: st.op };
      case 'replaceValues': return { kind: 'replace', cols: st.columns };
      case 'splitColumn': return { kind: 'split', col: st.column };
      case 'pivot': return { kind: 'pivot', col: st.column };
      case 'groupBy': return { kind: 'group', cols: st.keys };
      case 'customColumn': return { kind: 'custom' };
      case 'conditionalColumn': return { kind: 'conditional' };
      case 'merge': return { kind: 'merge' };
      case 'append': return { kind: 'append' };
      case 'selectColumns': return { kind: 'choose' };
      case 'transform': return st.fn === 'round' ? { kind: 'round', cols: st.columns } : null;
      default: return null;
    }
  };
  const editStep = (i: number) => {
    const d = q && dialogFor(q.steps[i]);
    if (!d) return;
    const back = pq.step;
    s.pqSet((x) => { x.step = i; });
    setEditing({ index: i, dialog: d, back });
  };
  const closeDialog = () => {
    setDialog(null);
    if (editing) { const back = editing.back; s.pqSet((x) => { x.step = back; }); setEditing(null); }
  };
  // Open the edit dialog once the preview shows the step's input.
  useEffect(() => {
    if (editing && !dialog && preview?.upto === editing.index && preview.query === q?.name) setDialog(editing.dialog);
  }, [editing, preview]);
  const promoteHeaders = () => {
    const first = preview?.rows[0];
    if (!first) return;
    const used = new Set<string>();
    const renames: [string, string][] = cols.map((c, i) => {
      let n = String(first[c.name] ?? '').trim() || `Column${i + 1}`;
      for (let k = 2; used.has(n); k++) n = `${String(first[c.name] ?? '').trim() || 'Column'}_${k}`;
      used.add(n);
      return [c.name, n];
    });
    add({ kind: 'promoteHeaders', renames: renames.filter(([a, b]) => a !== b) });
    // Like Power BI, a "Modificato tipo" step follows, with types detected from the remaining rows.
    const rest = (preview?.rows ?? []).slice(1);
    const detected: [string, PQType][] = [];
    for (const [orig, name] of renames) {
      const vals = rest.map((r) => r[orig]).filter((v) => v !== null && v !== '').map(String);
      if (!vals.length) continue;
      const t: PQType | null = vals.every((v) => /^-?\d+$/.test(v)) ? 'int' : vals.every((v) => /^-?\d+([.,]\d+)?$/.test(v)) ? 'decimal'
        : vals.every((v) => /^\d{4}-\d{2}-\d{2}$/.test(v)) ? 'date' : null;
      if (t) detected.push([name, t]);
    }
    if (detected.length) add({ kind: 'changeType', columns: detected });
  };
  const target = (col?: string) => (col && !sel.includes(col) ? [col] : sel.length ? sel : col ? [col] : []);
  const need = (cs: string[]) => {
    if (!cs.length) s.notify('Selezionare prima una o più colonne facendo clic sulle intestazioni.');
    return cs.length > 0;
  };
  const uniqueCol = (base: string) => {
    let n = base, i = 1;
    while (cols.some((c) => c.name === n)) n = `${base}.${i++}`;
    return n;
  };
  const act = {
    removeCols: (cs: string[]) => need(cs) && add({ kind: 'removeColumns', columns: cs }),
    removeOther: (cs: string[]) => need(cs) && add({ kind: 'selectColumns', columns: cols.map((c) => c.name).filter((c) => cs.includes(c)) }),
    changeType: (cs: string[], t: PQType) => need(cs) && add({ kind: 'changeType', columns: cs.map((c) => [c, t]) }),
    sort: (c: string | undefined, d: 'asc' | 'desc') => c && add({ kind: 'sort', by: [[c, d]] }),
    transform: (cs: string[], fn: TransformFn) => need(cs) && add({ kind: 'transform', columns: cs, fn }),
    fill: (cs: string[], kind: 'fillDown' | 'fillUp') => need(cs) && add({ kind, columns: cs }),
    unpivot: (cs: string[], other: boolean) => {
      if (!need(cs)) return;
      const un = cols.filter((c) => other !== cs.includes(c.name));
      add({ kind: 'unpivot', columns: cs, other, cast: new Set(un.map((c) => c.type)).size > 1 });
    },
    removeDup: (cs: string[]) => add({ kind: 'removeDuplicates', columns: cs.length ? cs : cols.map((c) => c.name) }),
    index: (start: number) => add({ kind: 'indexColumn', name: uniqueCol('Indice'), start }),
    duplicate: (c?: string) => c && add({ kind: 'duplicateColumn', column: c, name: uniqueCol(`${c} - Copia`) }),
    rename: (from: string, to: string) => {
      to = to.trim();
      if (!to || to === from) return;
      if (cols.some((c) => c.name === to)) { s.notify(`Esiste già una colonna denominata "${to}".`); return; }
      add({ kind: 'renameColumns', renames: [[from, to]] });
      setSel([to]);
    },
    filterValues: (col: string, values: (string | null)[], unchecked: (string | null)[], partial: boolean) => {
      const vt = vtypeOf(cols.find((c) => c.name === col));
      // A truncated value list can only exclude what was unchecked.
      if (partial || unchecked.length < values.length) add({ kind: 'filterRows', column: col, op: 'notIn', values: unchecked, vtype: vt });
      else add({ kind: 'filterRows', column: col, op: 'in', values, vtype: vt });
    },
  };
  const one = (cs: string[]) => (cs.length === 1 ? cs[0] : (need(cs) && s.notify('Selezionare una sola colonna.'), undefined));

  // ---- queries --------------------------------------------------------------
  const selectQuery = (name: string) => s.pqSet((st) => { st.selected = name; st.step = null; });
  const uniqueQuery = (base: string) => {
    let n = base, i = 2;
    while (pq.queries.some((x) => x.name === n) || s.tables.some((t) => t.name === n)) n = `${base} (${i++})`;
    return n;
  };
  const renameQuery = (to: string) => {
    to = to.trim();
    if (!q || to === q.name) return;
    if (!to || pq.queries.some((x) => x.name === to)) { s.notify(to ? `Esiste già una query denominata "${to}".` : 'Il nome non può essere vuoto.'); setQName(q.name); return; }
    const from = q.name;
    s.pqSet((st) => {
      st.queries.forEach((x) => renameQueryRef(x, from, to));
      st.queries.find((x) => x.name === from)!.name = to;
      st.selected = to;
    });
  };
  const duplicateQuery = (name: string, reference: boolean) => {
    const src = pq.queries.find((x) => x.name === name)!;
    const n = uniqueQuery(src.name);
    s.pqSet((st) => {
      st.queries.push(reference
        ? { name: n, orig: null, source: { path: '', ref: src.name }, steps: [] }
        : { name: n, orig: null, source: JSON.parse(JSON.stringify(src.source)), steps: JSON.parse(JSON.stringify(src.steps)) });
      st.selected = n; st.step = null;
    });
  };
  const deleteQuery = (name: string) => {
    const users = pq.queries.filter((x) => x.name !== name && dependencies(x).includes(name)).map((x) => x.name);
    if (users.length) { s.notify(`Impossibile eliminare "${name}": è usata da ${users.join(', ')}.`); return; }
    s.pqSet((st) => {
      const gone = st.queries.find((x) => x.name === name)!;
      if (gone.orig) st.deleted.push(gone.orig);
      st.queries = st.queries.filter((x) => x.name !== name);
      if (st.selected === name) { st.selected = st.queries[0]?.name ?? ''; st.step = null; }
    });
  };

  // ---- steps ----------------------------------------------------------------
  const selectStep = (n: number) => s.pqSet((st) => { const len = st.queries.find((x) => x.name === st.selected)!.steps.length; st.step = n >= len ? null : n; });
  const deleteStep = (i: number) => s.pqSet((st: PQState) => {
    const qq = st.queries.find((x) => x.name === st.selected)!;
    qq.steps.splice(i, 1);
    if (st.step !== null && st.step > i) st.step--;
    if (st.step !== null && st.step >= qq.steps.length) st.step = null;
  });

  const formula = useMemo(() => {
    if (!q) return '';
    if (upto === 0) {
      const m = queryM({ source: q.source, steps: [] }, []);
      return /Origine\s*=\s*([\s\S]*?)(,\n|\nin\n)/.exec(m)?.[1] ?? m;
    }
    const i = upto - 1;
    const prev = i === 0 ? 'Origine' : names[i - 1][names[i - 1].length - 1];
    return stepM(q.steps[i], prev, names[i]).join('\n');
  }, [q, upto, names]);

  const srcColsOf = () => {
    const t = s.tables.find((x) => x.name === q?.orig);
    return q?.source.m ? [] : t ? (t.steps?.length ? t.sourceColumns ?? [] : t.columns) : [];
  };
  const fullM = () => queryM({ source: q!.source, steps: q!.steps }, srcColsOf());

  /** Header names of "Usa la prima riga come intestazione" steps written in M: read from the data. */
  const resolveHeaders = async (steps: NewStep[]): Promise<NewStep[]> => {
    const out = [...steps];
    for (let k = 0; k < out.length; k++) {
      if (out[k].kind !== 'promoteHeaders') continue;
      const sql = await compileQuery({ ...q!, steps: out.map((x, i) => ({ ...x, id: 'r' + i }) as Step) }, pq.queries, { upto: k, srcExpr });
      const d = await api.query(`DESCRIBE SELECT * FROM (${sql})`);
      const r = await api.query(`SELECT * FROM (${sql}) LIMIT 1`);
      const used = new Set<string>();
      const renames: [string, string][] = d.rows.map((c: any, i: number) => {
        const v = String(r.rows[0]?.[c.column_name] ?? '').trim() || `Column${i + 1}`;
        let n = v; for (let j = 2; used.has(n); j++) n = `${v}_${j}`;
        used.add(n);
        return [c.column_name, n];
      });
      out[k] = { kind: 'promoteHeaders', renames: renames.filter(([a, b]) => a !== b) };
    }
    return out;
  };
  /** Advanced editor / formula bar → steps (ids kept where the step kind is unchanged). */
  const replaceSteps = (steps: NewStep[]) => s.pqSet((x) => {
    const qq = x.queries.find((y) => y.name === x.selected)!;
    qq.steps = steps.map((st, i) => ({ ...st, id: qq.steps[i]?.kind === st.kind ? qq.steps[i].id : Math.random().toString(36).slice(2, 10) }) as Step);
    x.step = null;
  });
  const saveM = async (text: string): Promise<string | null> => {
    try {
      const base = queryM({ source: q!.source, steps: [] }, srcColsOf());
      const r = mToQuery(text, base, q!.source);
      // Edited source (path, sheet, URL, server…): the query reloads from it.
      if (JSON.stringify(r.source) !== JSON.stringify(q!.source)) s.pqSet((x) => { x.queries.find((y) => y.name === x.selected)!.source = r.source; });
      replaceSteps(await resolveHeaders(r.steps));
      return null;
    } catch (e: any) { return e.message; }
  };
  // Colonna da esempi: examples typed in the first rows, the transformation that matches them.
  const [ex, setEx] = useState<{ name: string; cols: string[]; examples: Map<number, string> } | null>(null);
  const exCand = useMemo(() => {
    if (!ex || !preview) return null;
    return learn(preview.rows, cols.filter((c) => !ex.cols.length || ex.cols.includes(c.name)), ex.examples);
  }, [ex, preview]);
  const startExamples = (selected: boolean) => setEx({ name: uniqueCol('Personalizzato'), cols: selected ? sel : [], examples: new Map() });
  const okExamples = () => {
    if (!ex || !exCand) return;
    add({ kind: 'customColumn', name: ex.name.trim() || uniqueCol('Personalizzato'), formula: exCand.formula });
    setEx(null);
  };
  const [paramsOpen, setParamsOpen] = useState(false);
  const [dsOpen, setDsOpen] = useState(false);
  const [fxText, setFxText] = useState<string | null>(null);
  const [fxErr, setFxErr] = useState<string | null>(null);
  useEffect(() => { setFxText(null); setFxErr(null); }, [upto, q?.name]);
  const saveFormula = async () => {
    if (fxText === null || !q || upto === 0) { setFxText(null); return; }
    try {
      const r = exprToStep(fxText.trim().replace(/^=\s*/, ''));
      if ('nested' in r) throw new Error('Per le query unite modificare il passaggio con l\'ingranaggio o dall\'Editor avanzato.');
      const steps: NewStep[] = q.steps.map((x) => x as NewStep);
      steps[upto - 1] = r;
      const resolved = await resolveHeaders(steps);
      replaceSteps(resolved);
      s.pqSet((x) => { x.step = upto >= resolved.length ? null : upto; });
      setFxText(null); setFxErr(null);
    } catch (e: any) { setFxErr(e.message); }
  };

  const dirty = useMemo(() => {
    if (pq.deleted.length) return true;
    const key = (x: { source: unknown; steps?: Step[] }) => JSON.stringify([x.source, x.steps ?? []]);
    return pq.queries.length !== s.tables.length - pq.deleted.length || pq.queries.some((x) => {
      const t = s.tables.find((tt) => tt.name === x.orig);
      return !t || x.name !== x.orig || key(t) !== key(x);
    });
  }, [pq, s.tables]);

  const close = () => (dirty ? setConfirm(true) : s.set({ pq: null }));

  // ---- menus ----------------------------------------------------------------
  const openMenu = (kind: string, col?: string) => (e: RMouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const atPointer = e.type === 'contextmenu';
    setMenu({ kind, col, x: atPointer ? e.clientX : r.left, y: atPointer ? e.clientY : r.bottom + 2 });
  };
  const m = (fn: () => void) => () => { setMenu(null); fn(); };
  const clickCol = (e: RMouseEvent, c: string) => {
    if (e.ctrlKey || e.metaKey) setSel(sel.includes(c) ? sel.filter((x) => x !== c) : [...sel, c]);
    else if (e.shiftKey && sel.length) {
      const names = cols.map((x) => x.name);
      const a = names.indexOf(sel[sel.length - 1]), b = names.indexOf(c);
      setSel(names.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else setSel([c]);
  };
  const T = target();
  const firstSel = T[0];
  const firstMeta = cols.find((c) => c.name === firstSel);

  const typeItems = (cs: string[]) => PQ_TYPES.map((t) => (
    <button key={t} onClick={m(() => act.changeType(cs, t))}>{TYPE_LABEL[t]}</button>
  ));

  const noQuery = !q;
  const noCols = !cols.length;

  return (
    <div className="pq">
      <div className="pq-title">
        <div className="appicon"><Icon name="transform" size={18} box={32} /></div>
        <span>{q ? `${q.name} - ` : ''}Editor di Power Query</span>
        <div style={{ flex: 1 }} />
        <button className="pq-winclose" title="Chiudi" onClick={close}><Icon name="close" /></button>
      </div>

      <div className="ribbon">
        <div className="ribbon-tabs">
          <button className="file" onClick={() => s.pqApply()}>File</button>
          {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
        </div>
        <div className="ribbon-body">
          {tab === 'home' && <>
            <Group label="Chiudi"><Big icon="closeApply" label={<>Chiudi e<br />applica</>} onClick={() => s.pqApply()} /></Group>
            <Group label="Nuova query">
              <Big icon="getData" label={<>Nuova<br />origine</>} dropdown onClick={openMenu('newsource')} />
            </Group>
            <Group label="Parametri">
              <Big icon="newTable" label={<>Gestisci<br />parametri</>} onClick={() => setParamsOpen(true)} />
              <Big icon="getData" label={<>Impostazioni<br />origine dati</>} onClick={() => setDsOpen(true)} />
            </Group>
            <Group label="Query">
              <Big icon="refresh" label={<>Aggiorna<br />anteprima</>} onClick={async () => { await api.clearRemoteCache(); setReload(reload + 1); }} disabled={noQuery} />
              <div className="rcol">
                <Small icon="docs" label="Editor avanzato" onClick={() => setDialog({ kind: 'advanced', m: fullM(), name: q!.name })} disabled={noQuery} />
                <Small icon="copy" label="Duplica" onClick={() => duplicateQuery(q!.name, false)} disabled={noQuery} />
                <Small icon="tableSmall" label="Riferimento" onClick={() => duplicateQuery(q!.name, true)} disabled={noQuery} />
              </div>
            </Group>
            <Group label="Gestisci colonne">
              <Big icon="chooseColumns" label={<>Scegli<br />colonne</>} onClick={() => setDialog({ kind: 'choose' })} disabled={noCols} />
              <Big icon="removeColumns" label={<>Rimuovi<br />colonne</>} dropdown onClick={openMenu('removecols')} disabled={noCols} />
            </Group>
            <Group label="Riduci righe">
              <Big icon="keepRows" label={<>Mantieni<br />righe</>} dropdown onClick={openMenu('keeprows')} disabled={noCols} />
              <Big icon="removeRows" label={<>Rimuovi<br />righe</>} dropdown onClick={openMenu('removerows')} disabled={noCols} />
            </Group>
            <Group label="Ordina">
              <div className="rcol">
                <Small icon="sortAsc" label="Crescente" onClick={() => act.sort(one(T), 'asc')} disabled={noCols} />
                <Small icon="sortDesc" label="Decrescente" onClick={() => act.sort(one(T), 'desc')} disabled={noCols} />
              </div>
            </Group>
            <Group label="Trasforma">
              <Big icon="splitColumn" label={<>Dividi<br />colonna</>} onClick={() => { const c = one(T); if (c) setDialog({ kind: 'split', col: c }); }} disabled={noCols} />
              <Big icon="groupBy" label={<>Raggruppa<br />per</>} onClick={() => setDialog({ kind: 'group', cols: T })} disabled={noCols} />
              <div className="rcol">
                <Small icon="keepRows" label="Usa la prima riga come intestazione" onClick={promoteHeaders} disabled={noCols} />
                <button className="rbtn-s" onClick={openMenu('type')} disabled={noCols}><Icon name="calc" size={16} />Tipo di dati: {firstMeta ? TYPE_LABEL[pqTypeOf(firstMeta.type)] : '—'}<Icon name="chevronDown" size={10} /></button>
                <Small icon="painter" label="Sostituisci valori" onClick={() => need(T) && setDialog({ kind: 'replace', cols: T })} disabled={noCols} />
              </div>
            </Group>
            <Group label="Combina">
              <div className="rcol">
                <Small icon="relationships" label="Unisci query" onClick={() => setDialog({ kind: 'merge' })} disabled={noCols || pq.queries.length < 2} />
                <Small icon="newTable" label="Accoda query" onClick={() => setDialog({ kind: 'append' })} disabled={noCols || pq.queries.length < 2} />
              </div>
            </Group>
          </>}

          {tab === 'transform' && <>
            <Group label="Tabella">
              <Big icon="groupBy" label={<>Raggruppa<br />per</>} onClick={() => setDialog({ kind: 'group', cols: T })} disabled={noCols} />
              <Big icon="keepRows" label={<>Usa la prima riga<br />come intestazione</>} onClick={promoteHeaders} disabled={noCols} />
              <Big icon="removeRows" label={<>Rimuovi<br />duplicati</>} onClick={() => act.removeDup(T)} disabled={noCols} />
            </Group>
            <Group label="Qualsiasi colonna">
              <Big icon="dataType" label={<>Tipo di<br />dati</>} dropdown onClick={openMenu('type')} disabled={noCols} />
              <Big icon="rename" label="Rinomina" onClick={() => { const c = one(T); if (c) setRenaming(c); }} disabled={noCols} />
              <Big icon="replaceValues" label={<>Sostituisci<br />valori</>} onClick={() => need(T) && setDialog({ kind: 'replace', cols: T })} disabled={noCols} />
              <Big icon="fillDown" label="Riempi" dropdown onClick={openMenu('fill')} disabled={noCols} />
              <Big icon="unpivot" label={<>Trasforma colonne<br />in valori</>} dropdown onClick={openMenu('unpivot')} disabled={noCols} />
              <Big icon="unpivot" label={<>Colonna<br />pivot</>} onClick={() => { const c = one(T); if (c) setDialog({ kind: 'pivot', col: c }); }} disabled={noCols} />
            </Group>
            <Group label="Colonna di testo">
              <Big icon="splitColumn" label={<>Dividi<br />colonna</>} onClick={() => { const c = one(T); if (c) setDialog({ kind: 'split', col: c }); }} disabled={noCols} />
              <Big icon="formatText" label="Formato" dropdown onClick={openMenu('format')} disabled={noCols} />
            </Group>
            <Group label="Colonna numerica">
              <Big icon="round" label="Arrotondamento" onClick={() => need(T) && setDialog({ kind: 'round', cols: T })} disabled={noCols} />
              <Big icon="calc" label={<>Valore<br />assoluto</>} onClick={() => act.transform(T, 'abs')} disabled={noCols} />
            </Group>
            <Group label="Colonna data">
              <Big icon="calendarBig" label="Data" dropdown onClick={openMenu('date')} disabled={noCols} />
            </Group>
          </>}

          {tab === 'add' && <>
            <Group label="Generale">
              <Big icon="customColumn" label={<>Colonna<br />personalizzata</>} onClick={() => setDialog({ kind: 'custom' })} disabled={noCols} />
              <Big icon="customColumn" label={<>Colonna<br />condizionale</>} onClick={() => setDialog({ kind: 'conditional' })} disabled={noCols} />
              <Big icon="customColumn" label={<>Colonna da<br />esempi</>} dropdown onClick={openMenu('examples')} disabled={noCols} />
              <Big icon="indexColumn" label={<>Colonna<br />indice</>} dropdown onClick={openMenu('index')} disabled={noCols} />
              <Big icon="duplicateColumn" label={<>Duplica<br />colonna</>} onClick={() => act.duplicate(one(T))} disabled={noCols} />
            </Group>
          </>}

          {tab === 'view' && <>
            <Group label="Layout">
              <div className="rcol">
                <label className="rcheck"><input type="checkbox" checked={opts.formula} onChange={(e) => setOpts({ ...opts, formula: e.target.checked })} />Barra della formula</label>
              </div>
            </Group>
            <Group label="Anteprima dati">
              <div className="rcol">
                <label className="rcheck"><input type="checkbox" checked={opts.quality} onChange={(e) => setOpts({ ...opts, quality: e.target.checked })} />Qualità colonna</label>
                <label className="rcheck"><input type="checkbox" checked={opts.distribution} onChange={(e) => setOpts({ ...opts, distribution: e.target.checked })} />Distribuzione colonne</label>
                <label className="rcheck"><input type="checkbox" checked={opts.profile} onChange={(e) => setOpts({ ...opts, profile: e.target.checked })} />Profilo colonna</label>
                <label className="rcheck"><input type="checkbox" checked={opts.sql} onChange={(e) => setOpts({ ...opts, sql: e.target.checked })} />SQL generato (DuckDB)</label>
              </div>
            </Group>
            <Group label="Avanzate">
              <Big icon="advancedEditor" label={<>Editor<br />avanzato</>} onClick={() => setDialog({ kind: 'advanced', m: fullM(), name: q!.name })} disabled={noQuery} />
            </Group>
          </>}
        </div>
      </div>

      <div className="pq-body">
        <div className="pq-queries">
          <div className="pq-ph">Query [{pq.queries.length + (s.report.pqParams?.length ?? 0)}]</div>
          {(s.report.pqParams ?? []).map((p) => (
            <div key={'p:' + p.name} className="pq-q pq-param" title={`Parametro (${p.type}) = ${p.value}`} onClick={() => setParamsOpen(true)}>
              <span className="pq-param-ic">P</span><span className="nm">{p.name}</span><span className="pq-new">{p.value}</span>
            </div>
          ))}
          {pq.queries.map((x) => (
            <div key={x.name} className={'pq-q' + (x.name === q?.name ? ' sel' : '')} onClick={() => selectQuery(x.name)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ kind: 'query', query: x.name, x: e.clientX, y: e.clientY }); }}>
              <Icon name="tableSmall" />
              <span className="nm">{x.name}</span>
              {!x.orig && <span className="pq-new" title="Nuova query: verrà caricata con Chiudi e applica">nuova</span>}
            </div>
          ))}
        </div>

        <div className="pq-center">
          {opts.formula && (
            <div className="formulabar pq-fx">
              <Icon name="close" size={12} /><span style={{ color: 'var(--text3)' }}>✓</span><span className="fx">fx</span>
              {upto > 0 && q?.steps[upto - 1]?.kind !== 'merge'
                ? <input className="pq-fx-input" spellCheck={false} value={fxText ?? formula} title="Modificare la formula e premere Invio"
                    onChange={(e) => { setFxText(e.target.value); setFxErr(null); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveFormula(); if (e.key === 'Escape') { setFxText(null); setFxErr(null); } }} />
                : <code title={formula}>= {formula}</code>}
              {fxErr && <span className="pq-fx-err" title={fxErr}>⚠ {fxErr}</span>}
            </div>
          )}
          {opts.sql && preview && <pre className="pq-sql">{preview.sql}</pre>}
          {ex && (
            <div className="pq-ex-bar">
              <b>Aggiungi colonna da esempi</b>
              <span className="pq-ex-desc">{!ex.examples.size ? 'Immettere i valori di esempio nella nuova colonna a destra.' : exCand ? <>Trasformazione: {exCand.label} · <code>{exCand.formula}</code></> : 'Nessuna trasformazione trovata per questi esempi: aggiungerne altri o cambiarli.'}</span>
              <button className="btn primary" disabled={!exCand} onClick={okExamples}>OK</button>
              <button className="btn" onClick={() => setEx(null)}>Annulla</button>
            </div>
          )}
          <div className="grid-wrap pq-grid">
            {noQuery && <div className="pq-empty">Nessuna query. Usare <b>Nuova origine</b>.</div>}
            {error && <div className="pq-error"><Icon name="warning" size={18} /><div><b>{error.split(':')[0]}</b><div>{error.includes(':') ? error.slice(error.indexOf(':') + 1).trim() : ''}</div></div></div>}
            {!error && preview && (
              <table>
                <thead>
                  <tr>
                    <th className="pq-rn" />
                    {cols.map((c) => (
                      <th key={c.name} className={sel.includes(c.name) ? 'sel' : ''} onClick={(e) => clickCol(e, c.name)}
                        onDoubleClick={() => setRenaming(c.name)} onContextMenu={(e) => { if (!sel.includes(c.name)) setSel([c.name]); openMenu('column', c.name)(e); }}>
                        <div className="h">
                          <button className="pq-ty" title={`Tipo: ${TYPE_LABEL[pqTypeOf(c.type)]} (${c.type})`} onClick={openMenu('typecol', c.name)}><TypeGlyph c={c} /></button>
                          {renaming === c.name
                            ? <input type="text" autoFocus defaultValue={c.name} onClick={(e) => e.stopPropagation()}
                              onBlur={(e) => { act.rename(c.name, e.target.value); setRenaming(null); }}
                              onKeyDown={(e) => { const t = e.target as HTMLInputElement; if (e.key === 'Enter') t.blur(); if (e.key === 'Escape') { t.value = c.name; t.blur(); } }} />
                            : <span className="nm">{c.name}</span>}
                          <button className="pq-dd" onClick={openMenu('filter', c.name)}><Icon name="chevronDown" size={10} /></button>
                        </div>
                        {opts.distribution && dist.get(c.name) && (() => {
                          const d = dist.get(c.name)!;
                          const top = d.counts.slice(0, 12), max = top[0]?.[1] ?? 1;
                          return (
                            <div className="pq-dist" title={`${d.distinct} distinti, ${d.unique} univoci`}>
                              <div className="bars">{top.map(([k, n]) => <i key={k} style={{ height: `${(n / max) * 100}%` }} title={`${k}: ${n}`} />)}</div>
                              <span className="cnt">{d.distinct} distinti, {d.unique} univoci</span>
                            </div>
                          );
                        })()}
                        {opts.quality && (
                          <div className="pq-quality" title={`Valido ${Math.round((1 - quality.get(c.name)!) * 100)}% · Errore 0% · Vuoto ${Math.round(quality.get(c.name)! * 100)}%`}>
                            <i style={{ width: `${(1 - quality.get(c.name)!) * 100}%` }} />
                          </div>
                        )}
                      </th>
                    ))}
                    {ex && <th className="pq-ex-h"><input type="text" value={ex.name} onChange={(e) => setEx({ ...ex, name: e.target.value })} title="Nome della nuova colonna" /></th>}
                  </tr>
                </thead>
                <tbody>{preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="pq-rn">{i + 1}</td>
                    {cols.map((c) => {
                      const v = r[c.name];
                      const num = vtypeOf(c) === 'number';
                      return <td key={c.name} className={(num ? 'num' : '') + (sel.includes(c.name) ? ' sel' : '') + (v === null ? ' pq-null' : '')}>{fmtCell(v, c)}</td>;
                    })}
                    {ex && (
                      <td className="pq-ex-c">
                        {i < 30
                          ? <input type="text" value={ex.examples.get(i) ?? ''} placeholder={exCand?.fn(r) ?? ''}
                              onChange={(e) => { const m = new Map(ex.examples); if (e.target.value) m.set(i, e.target.value); else m.delete(i); setEx({ ...ex, examples: m }); }} />
                          : <span className="pq-ex-pred">{exCand?.fn(r) ?? ''}</span>}
                      </td>
                    )}
                  </tr>
                ))}</tbody>
              </table>
            )}
            {loading && <div className="pq-loading"><div className="spinner" /></div>}
          </div>
          {stats && profileCol && (
            <div className="pq-profile">
              <div>
                <h4>Statistiche colonna · {profileCol.name}</h4>
                <table><tbody>{stats.rows.map(([k, v]) => <tr key={k}><td>{k}</td><td>{typeof v === 'number' ? v.toLocaleString(locale(), { maximumFractionDigits: 4 }) : v}</td></tr>)}</tbody></table>
              </div>
              <div className="vd">
                <h4>Distribuzione valori</h4>
                {stats.top.map(([k, n]) => <div key={k}><span title={k}>{k}</span><b style={{ width: `${(n / (stats.top[0]?.[1] || 1)) * 100}%` }} /><span>{n}</span></div>)}
              </div>
            </div>
          )}
        </div>

        <div className="pq-settings">
          <div className="pq-ph">Impostazioni query</div>
          <div className="pq-sec">PROPRIETÀ</div>
          <label className="pq-field">Nome
            <input type="text" value={qName} disabled={noQuery} onChange={(e) => setQName(e.target.value)}
              onBlur={() => renameQuery(qName)} onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          </label>
          <div className="pq-sec">PASSAGGI APPLICATI</div>
          {q && (
            <div className="pq-steps">
              <div className={'pq-step' + (upto === 0 ? ' sel' : '')} onClick={() => selectStep(0)}>
                {q.source.db && <button className="pq-gear" title="Modifica origine" onClick={(e) => { e.stopPropagation(); setDbEdit(true); }}>⚙</button>}
                <span className="nm">Origine</span>
              </div>
              {q.steps.map((st, i) => (
                <div key={st.id} className={'pq-step' + (upto === i + 1 ? ' sel' : '') + (upto < i + 1 ? ' after' : '')} onClick={() => selectStep(i + 1)}>
                  <button className="pq-del" title="Elimina passaggio" onClick={(e) => { e.stopPropagation(); deleteStep(i); }}><Icon name="close" size={11} /></button>
                  {dialogFor(st) && <button className="pq-gear" title="Modifica impostazioni" onClick={(e) => { e.stopPropagation(); editStep(i); }}>⚙</button>}
                  <span className="nm" title={names[i].join(' → ')}>{names[i][0]}</span>
                </div>
              ))}
            </div>
          )}
          {q && pq.step !== null && <div className="pq-note" style={{ padding: '8px 12px' }}>Il nuovo passaggio verrà inserito dopo quello selezionato.</div>}
        </div>
      </div>

      <div className="pq-status">
        <span>{error ? 'ERRORE' : `${cols.length} COLONNE, ${preview?.rows.length ?? 0}${(preview?.rows.length ?? 0) >= 1000 ? '+' : ''} RIGHE`}</span>
        <span>Profilatura colonne basata sulle prime 1000 righe</span>
        <span style={{ flex: 1 }} />
        {preview && <span>ANTEPRIMA SCARICATA ALLE {preview.at.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>}
      </div>

      {menu?.kind === 'newsource' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <div className="hdr">Origini dati comuni</div>
          <button onClick={m(() => s.pqNewSource('excel'))}><Icon name="excel" size={18} />Cartella di lavoro di Excel</button>
          <button onClick={m(() => s.pqNewSource('csv'))}><Icon name="docs" size={18} />Testo/CSV</button>
          <button onClick={m(() => s.pqNewSource('json'))}><Icon name="docs" size={18} />JSON</button>
          <button onClick={m(() => s.pqNewSource('parquet'))}><Icon name="sql" size={18} />Parquet</button>
          <button onClick={m(() => s.set({ sourceDialog: 'web' }))}><Icon name="getData" size={18} />Web</button>
          <button onClick={m(() => s.set({ sourceDialog: 'odata' }))}><Icon name="getData" size={18} />Feed OData</button>
          <button onClick={m(() => s.set({ sourceDialog: 'folder' }))}><Icon name="getData" size={18} />Cartella</button>
          <button onClick={m(() => s.set({ sourceDialog: 'sharepoint' }))}><Icon name="getData" size={18} />Cartella SharePoint</button>
          <button onClick={m(() => s.set({ sourceDialog: 'splist' }))}><Icon name="getData" size={18} />Elenco SharePoint Online</button>
        </Menu>
      )}
      {menu?.kind === 'removecols' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.removeCols(T))}>Rimuovi colonne</button>
          <button onClick={m(() => act.removeOther(T))}>Rimuovi altre colonne</button>
        </Menu>
      )}
      {menu?.kind === 'keeprows' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => setDialog({ kind: 'rows', step: 'keepTop' }))}>Mantieni prime righe</button>
          <button onClick={m(() => setDialog({ kind: 'rows', step: 'keepBottom' }))}>Mantieni ultime righe</button>
        </Menu>
      )}
      {menu?.kind === 'removerows' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => setDialog({ kind: 'rows', step: 'removeTop' }))}>Rimuovi prime righe</button>
          <button onClick={m(() => setDialog({ kind: 'rows', step: 'removeBottom' }))}>Rimuovi ultime righe</button>
          <button onClick={m(() => act.removeDup(T))}>Rimuovi duplicati</button>
          <button onClick={m(() => { const c = one(T); if (c) add({ kind: 'filterRows', column: c, op: 'notBlank' }); })}>Rimuovi righe vuote (colonna selezionata)</button>
        </Menu>
      )}
      {(menu?.kind === 'type' || menu?.kind === 'typecol') && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>{typeItems(menu.kind === 'typecol' ? target(menu.col) : T)}</Menu>
      )}
      {menu?.kind === 'fill' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.fill(T, 'fillDown'))}>Verso il basso</button>
          <button onClick={m(() => act.fill(T, 'fillUp'))}>Verso l'alto</button>
        </Menu>
      )}
      {menu?.kind === 'unpivot' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.unpivot(T, false))}>Trasforma colonne in valori</button>
          <button onClick={m(() => act.unpivot(T, true))}>Trasforma altre colonne in valori</button>
        </Menu>
      )}
      {menu?.kind === 'format' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.transform(T, 'lower'))}>minuscolo</button>
          <button onClick={m(() => act.transform(T, 'upper'))}>MAIUSCOLO</button>
          <button onClick={m(() => act.transform(T, 'proper'))}>Iniziali Maiuscole</button>
          <button data-en="Trim" onClick={m(() => act.transform(T, 'trim'))}>Taglia</button>
          <button onClick={m(() => act.transform(T, 'length'))}>Lunghezza</button>
        </Menu>
      )}
      {menu?.kind === 'date' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.transform(T, 'year'))}>Anno</button>
          <button onClick={m(() => act.transform(T, 'quarter'))}>Trimestre</button>
          <button onClick={m(() => act.transform(T, 'month'))}>Mese</button>
          <button onClick={m(() => act.transform(T, 'day'))}>Giorno</button>
        </Menu>
      )}
      {menu?.kind === 'examples' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => startExamples(false))}>Da tutte le colonne</button>
          <button disabled={!sel.length} onClick={m(() => startExamples(true))}>Dalla selezione</button>
        </Menu>
      )}
      {menu?.kind === 'index' && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => act.index(0))}>Da 0</button>
          <button onClick={m(() => act.index(1))}>Da 1</button>
        </Menu>
      )}
      {menu?.kind === 'column' && menu.col && (() => {
        const cs = target(menu.col);
        return (
          <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
            <button onClick={m(() => act.removeCols(cs))}><Icon name="trash" />Rimuovi{cs.length > 1 ? ` colonne (${cs.length})` : ''}</button>
            <button onClick={m(() => act.removeOther(cs))}>Rimuovi altre colonne</button>
            <button disabled={cs.length > 1} onClick={m(() => act.duplicate(menu.col))}>Duplica colonna</button>
            <hr />
            <button onClick={m(() => act.removeDup(cs))}>Rimuovi duplicati</button>
            <button onClick={m(() => setDialog({ kind: 'replace', cols: cs }))}>Sostituisci valori…</button>
            <button onClick={m(() => act.fill(cs, 'fillDown'))}>Riempi verso il basso</button>
            <button onClick={m(() => setDialog({ kind: 'group', cols: cs }))}>Raggruppa per…</button>
            <button onClick={m(() => act.unpivot(cs, false))}>Trasforma colonne in valori</button>
            <button onClick={m(() => act.unpivot(cs, true))}>Trasforma altre colonne in valori</button>
            <hr />
            <button disabled={cs.length > 1} onClick={m(() => setDialog({ kind: 'split', col: menu.col! }))}>Dividi colonna…</button>
            <button disabled={cs.length > 1} onClick={m(() => setRenaming(menu.col!))}>Rinomina…</button>
          </Menu>
        );
      })()}
      {menu?.kind === 'filter' && menu.col && preview && (
        <FilterMenu x={menu.x} y={menu.y} col={menu.col} meta={cols.find((c) => c.name === menu.col)!} sql={preview.sql}
          onClose={() => setMenu(null)}
          onSort={(d) => { setMenu(null); act.sort(menu.col, d); }}
          onRemoveEmpty={() => { setMenu(null); add({ kind: 'filterRows', column: menu.col!, op: 'notBlank' }); }}
          onOp={(op) => { setMenu(null); setDialog({ kind: 'filter', col: menu.col!, op }); }}
          onValues={(vals, unchecked, partial) => { setMenu(null); act.filterValues(menu.col!, vals, unchecked, partial); }} />
      )}
      {menu?.kind === 'query' && menu.query && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={m(() => duplicateQuery(menu.query!, false))}><Icon name="copy" />Duplica</button>
          <button onClick={m(() => duplicateQuery(menu.query!, true))}>Riferimento</button>
          <hr />
          <button onClick={m(() => deleteQuery(menu.query!))}><Icon name="trash" />Elimina</button>
        </Menu>
      )}

      {paramsOpen && <ParamsDialog onClose={() => { setParamsOpen(false); setReload((x) => x + 1); }} />}
      {dbEdit && q?.source.db && <DbSourceDialog source={q.source.db} onClose={() => setDbEdit(false)} onSave={(db) => {
        s.pqSet((x) => { x.queries.find((y) => y.name === x.selected)!.source = { ...x.queries.find((y) => y.name === x.selected)!.source, db }; });
        setDbEdit(false); api.clearRemoteCache().catch(() => {}); setReload((x) => x + 1);
      }} />}
      {dsOpen && <DataSourceSettings onClose={() => { setDsOpen(false); api.clearRemoteCache().catch(() => {}); setReload((x) => x + 1); }} />}
      {dialog && <PQDialog dialog={dialog} close={closeDialog} add={add} preview={error ? null : preview} pq={pq} notify={s.notify} init={editing ? q?.steps[editing.index] : undefined} saveM={saveM} />}

      {confirm && (
        <div className="modal-bg pq-modal">
          <div className="dialog" style={{ width: 460 }}>
            <div className="dh"><h2>Power Query Editor</h2><button onClick={() => setConfirm(false)}><Icon name="close" /></button></div>
            <div className="db pq-db">Applicare le modifiche in sospeso alle query?</div>
            <div className="df">
              <button className="btn primary" onClick={() => { setConfirm(false); s.pqApply(); }}>Applica</button>
              <button className="btn" onClick={() => { setConfirm(false); s.set({ pq: null }); }}>Ignora</button>
              <button className="btn" onClick={() => setConfirm(false)}>Annulla</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Column header drop-down: sort, text/number filters and the value checklist (like Power Query's AutoFilter). */
function FilterMenu({ x, y, col, meta, sql, onClose, onSort, onRemoveEmpty, onOp, onValues }: {
  x: number; y: number; col: string; meta: ColumnMeta; sql: string; onClose: () => void;
  onSort: (d: 'asc' | 'desc') => void; onRemoveEmpty: () => void; onOp: (op: FilterOp) => void;
  onValues: (values: (string | null)[], unchecked: (string | null)[], partial: boolean) => void;
}) {
  const [values, setValues] = useState<(string | null)[] | null>(null);
  const [checked, setChecked] = useState<Set<string | null>>(new Set());
  const [q, setQ] = useState('');
  const [sub, setSub] = useState(false);
  const vt = vtypeOf(meta);
  useEffect(() => {
    api.query(`SELECT DISTINCT CAST(${qi(col)} AS VARCHAR) AS v FROM (${sql}) ORDER BY 1 NULLS FIRST LIMIT 1001`).then((r) => {
      const v = r.rows.map((x) => x.v as string | null);
      setValues(v);
      setChecked(new Set(v.slice(0, 1000)));
    }).catch(() => setValues([]));
  }, [col, sql]);
  const shown = (values ?? []).filter((v) => !q || (v ?? 'null').toLowerCase().includes(q.toLowerCase()));
  const all = values !== null && values.slice(0, 1000).every((v) => checked.has(v));
  const truncated = (values?.length ?? 0) > 1000;
  const label = vt === 'text' ? 'Filtri per testo' : vt === 'number' ? 'Filtri per numero' : 'Filtri per data';
  const ops = vt === 'text' ? FILTER_OPS.text : FILTER_OPS.number;
  return (
    <Menu x={x} y={y} onClose={onClose}>
      <button onClick={() => onSort('asc')}><Icon name="sortAsc" />Ordinamento crescente</button>
      <button onClick={() => onSort('desc')}><Icon name="sortDesc" />Ordinamento decrescente</button>
      <hr />
      <button onClick={onRemoveEmpty}>Rimuovi vuoti</button>
      <button onClick={() => setSub(!sub)}>{label}<span style={{ flex: 1 }} /><Icon name={sub ? 'chevronDown' : 'chevronRight'} size={10} /></button>
      {sub && ops.map(([k, l]) => <button key={k} style={{ paddingLeft: 28 }} onClick={() => onOp(k)}>{l}…</button>)}
      <div className="pq-fm">
        <input type="search" placeholder="Cerca" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="pq-checklist">
          {values === null ? <div className="pq-note">Caricamento…</div> : <>
            <label><input type="checkbox" checked={all} onChange={() => setChecked(all ? new Set() : new Set(values.slice(0, 1000)))} />(Seleziona tutto)</label>
            {shown.slice(0, 1000).map((v) => (
              <label key={v ?? '\u0000null'}><input type="checkbox" checked={checked.has(v)} onChange={() => { const n = new Set(checked); n.has(v) ? n.delete(v) : n.add(v); setChecked(n); }} />
                {v === null ? <i>(null)</i> : v === '' ? <i>(vuoto)</i> : v}</label>
            ))}
          </>}
        </div>
        {truncated && <div className="pq-note"><Icon name="warning" size={12} /> L'elenco potrebbe essere incompleto.</div>}
        <div className="pq-fm-btns">
          <button className="btn primary" disabled={!checked.size || all} onClick={() => {
            const list = values!.slice(0, 1000);
            onValues(list.filter((v) => checked.has(v)), list.filter((v) => !checked.has(v)), truncated);
          }}>OK</button>
          <button className="btn" onClick={onClose}>Annulla</button>
        </div>
      </div>
    </Menu>
  );
}

/** Gear of the Origine step of a database query: server, port, database and native SQL statement (like Power BI). */
function DbSourceDialog({ source, onClose, onSave }: { source: DbSource; onClose: () => void; onSave: (db: DbSource) => void }) {
  const [f, setF] = useState({ host: source.host ?? '', port: source.port ?? '', database: source.database ?? '', query: source.query ?? '', file: source.file ?? '' });
  const fileKind = source.kind === 'sqlite' || source.kind === 'access';
  const sql = !['mongodb', 'access', 'sqlite', 'dataverse'].includes(source.kind);
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog" style={{ width: 'min(560px, 94vw)' }}>
        <div className="dh"><h2>Origine</h2><button onClick={onClose}><Icon name="close" /></button></div>
        <div className="db pq-db">
          {fileKind ? <label className="pq-field">File<input type="text" value={f.file} onChange={(e) => setF({ ...f, file: e.target.value })} /></label> : <>
            <div className="pq-row" style={{ alignItems: 'flex-start' }}>
              <label className="pq-field" style={{ flex: 3 }}>Server<input type="text" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></label>
              <label className="pq-field" style={{ flex: 1 }}>Porta<input type="text" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} /></label>
            </div>
            <label className="pq-field">Database<input type="text" value={f.database} onChange={(e) => setF({ ...f, database: e.target.value })} /></label>
            {sql && <label className="pq-field">Istruzione SQL (vuota = tabella {source.schema ? `${source.schema}.` : ''}{source.table})<textarea rows={6} value={f.query} onChange={(e) => setF({ ...f, query: e.target.value })} style={{ fontFamily: 'monospace' }} /></label>}
          </>}
          <div className="pq-note">Le credenziali restano quelle salvate per il server (Impostazioni origine dati).</div>
        </div>
        <div className="df">
          <button className="btn primary" onClick={() => onSave({ ...source, ...(fileKind ? { file: f.file } : { host: f.host.trim(), port: f.port.trim() || undefined, database: f.database.trim() || undefined, query: f.query.trim() || undefined }) })}>OK</button>
          <button className="btn" onClick={onClose}>Annulla</button>
        </div>
      </div>
    </div>
  );
}
