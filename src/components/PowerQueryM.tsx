// Power Query editor parts for M queries: Invoca (custom functions), Dipendenze query, Gruppi di query.
import { useMemo, useState } from 'react';
import type { PQParam } from '../types';
import type { PQQuery, PQState } from '../store';
import { dependencies } from '../pq/steps';
import { MFunction } from '../pq/m/values';
import { mStr } from '../pq/m';
import { Icon } from './icons';

/** Queries in the order of the queries pane, by group ('' = no group first). */
export function groupedQueries(pq: PQState): [string, PQQuery[]][] {
  const groups = new Map<string, PQQuery[]>([['', []]]);
  for (const q of pq.queries) {
    const g = pq.groups?.[q.name] ?? '';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(q);
  }
  return [...groups.entries()].filter(([g, l]) => g === '' || l.length).sort((a, b) => (a[0] === '' ? -1 : b[0] === '' ? 1 : a[0].localeCompare(b[0])));
}

const TYPE_HINT: Record<string, string> = { number: 'numero', text: 'testo', date: 'data (#date(2024, 1, 31))', logical: 'true / false', any: 'valore M' };

/** Enter parameters + Invoca for a query whose value is a function (like Power Query). */
export function InvokePanel({ fn, name, onInvoke }: { fn: MFunction; name: string; onInvoke: (args: string[]) => void }) {
  const [vals, setVals] = useState<string[]>(() => fn.params.map(() => ''));
  /** Typed text → M literal: numbers and M expressions as written, other text quoted. */
  const literal = (v: string, kind?: string) => {
    const t = v.trim();
    if (!t) return 'null';
    if (kind === 'number' || kind === 'logical' || /^(#|\(|\{|\[|-?\d+([.,]\d+)?$|true$|false$|null$)/.test(t)) return t.replace(/^(-?\d+),(\d+)$/, '$1.$2');
    return mStr(v);
  };
  return (
    <div className="pq-invoke">
      <h3>Immetti parametri</h3>
      <p className="pq-note">{name} è una funzione: inserire i parametri e scegliere <b>Invoca</b> per creare una query con il risultato.</p>
      {fn.params.map((p, i) => (
        <label key={p.name} className="pq-field">
          {p.name}{p.optional ? ' (facoltativo)' : ''}{p.type ? ` · ${TYPE_HINT[p.type.kind] ?? p.type.kind}` : ''}
          <input type="text" value={vals[i]} onChange={(e) => setVals(vals.map((x, k) => (k === i ? e.target.value : x)))} />
        </label>
      ))}
      <div className="qna-row">
        <button className="btn primary" disabled={fn.params.some((p, i) => !p.optional && !vals[i].trim())}
          onClick={() => onInvoke(fn.params.map((p, i) => literal(vals[i], p.type?.kind)).filter((x, i, a) => !(x === 'null' && a.slice(i).every((y) => y === 'null'))))}>Invoca</button>
        <button className="btn" onClick={() => setVals(fn.params.map(() => ''))}>Cancella</button>
      </div>
    </div>
  );
}

/** Origin of a query that reads data directly (leaf of the dependency graph). */
function originOf(q: PQQuery): string | null {
  const s = q.source;
  if (s.mcode !== undefined) {
    const m = /(File\.Contents|Web\.Contents|Folder\.Files|Folder\.Contents|OData\.Feed|Sql\.Database|PostgreSQL\.Database|MySQL\.Database|Oracle\.Database|SharePoint\.\w+)\s*\(\s*"((?:[^"]|"")*)"/.exec(s.mcode);
    return m ? `${m[1]}: ${m[2].replace(/""/g, '"').split('/').pop()}` : null;
  }
  if (s.ref) return null;
  if (s.db) return `${s.db.kind}: ${s.db.table || s.db.database || s.db.host || ''}`;
  if (s.web) return `Web: ${s.web.url}`;
  if (s.odata) return `OData: ${s.odata.url}`;
  if (s.folder) return `Cartella: ${s.folder.path.split('/').pop()}`;
  if (s.sharepoint) return `SharePoint: ${s.sharepoint.site}`;
  if (s.inline) return 'Immetti dati';
  if (s.path) return `File: ${s.path.split('/').pop()}`;
  return null;
}

/** Visualizza › Dipendenze query: origins → queries → model, in columns by depth. */
export function DependencyView({ queries, params, selected, onClose }: { queries: PQQuery[]; params: PQParam[]; selected?: string; onClose: () => void }) {
  const [focus, setFocus] = useState<string | undefined>(selected);
  const graph = useMemo(() => {
    const names = new Set([...queries.map((q) => q.name), ...params.map((p) => p.name)]);
    const nodes = new Map<string, { id: string; label: string; kind: 'origin' | 'param' | 'query' | 'fn' | 'model'; deps: string[] }>();
    for (const p of params) nodes.set('p:' + p.name, { id: 'p:' + p.name, label: p.name, kind: 'param', deps: [] });
    for (const q of queries) {
      const deps = dependencies(q).filter((d) => names.has(d) && d !== q.name).map((d) => (params.some((p) => p.name === d) ? 'p:' + d : 'q:' + d));
      const o = originOf(q);
      if (o) { nodes.set('o:' + o, { id: 'o:' + o, label: o, kind: 'origin', deps: [] }); deps.push('o:' + o); }
      const isFn = q.source.mcode !== undefined && /^\s*\(/.test(q.source.mcode);
      nodes.set('q:' + q.name, { id: 'q:' + q.name, label: q.name, kind: isFn ? 'fn' : 'query', deps });
    }
    const model = queries.filter((q) => q.load !== false).map((q) => 'q:' + q.name);
    if (model.length) nodes.set('model', { id: 'model', label: 'Modello di dati', kind: 'model', deps: model });
    // Depth = longest path from the origins.
    const depth = new Map<string, number>();
    const d = (id: string, seen = new Set<string>()): number => {
      if (depth.has(id)) return depth.get(id)!;
      if (seen.has(id)) return 0;
      seen.add(id);
      const n = nodes.get(id);
      const v = n && n.deps.length ? 1 + Math.max(...n.deps.map((x) => d(x, seen))) : 0;
      depth.set(id, v);
      return v;
    };
    for (const id of nodes.keys()) d(id);
    const cols: string[][] = [];
    for (const [id, v] of depth) (cols[v] ??= []).push(id);
    return { nodes, cols: cols.map((c) => c ?? []) };
  }, [queries, params]);
  const W = 190, H = 46, GX = 70, GY = 18;
  const pos = new Map<string, { x: number; y: number }>();
  graph.cols.forEach((c, i) => c.forEach((id, j) => pos.set(id, { x: 20 + i * (W + GX), y: 20 + j * (H + GY) })));
  const width = 40 + graph.cols.length * (W + GX), height = 40 + Math.max(1, ...graph.cols.map((c) => c.length)) * (H + GY);
  // Highlight the focused node, its sources and its users.
  const related = new Set<string>();
  if (focus) {
    const up = (id: string) => { if (related.has(id)) return; related.add(id); graph.nodes.get(id)?.deps.forEach(up); };
    const down = (id: string) => { related.add(id); for (const n of graph.nodes.values()) if (n.deps.includes(id) && !related.has(n.id)) down(n.id); };
    up('q:' + focus); down('q:' + focus);
  }
  const ICON: Record<string, string> = { origin: '⛁', param: 'P', query: '▦', fn: 'fx', model: '◈' };
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog pq-deps">
        <div className="dh"><h2>Dipendenze query</h2><button onClick={onClose}><Icon name="close" /></button></div>
        <div className="pq-deps-body">
          <svg width={width} height={height}>
            {[...graph.nodes.values()].flatMap((n) => n.deps.map((dep) => {
              const a = pos.get(dep), b = pos.get(n.id);
              if (!a || !b) return null;
              const on = focus ? related.has(dep) && related.has(n.id) : true;
              return <path key={dep + '>' + n.id} d={`M${a.x + W},${a.y + H / 2} C${a.x + W + GX / 2},${a.y + H / 2} ${b.x - GX / 2},${b.y + H / 2} ${b.x},${b.y + H / 2}`}
                fill="none" stroke={on ? 'var(--accent, #118DFF)' : 'var(--line2)'} strokeWidth={on ? 1.6 : 1} markerEnd="url(#arr)" />;
            }))}
            <defs><marker id="arr" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="var(--text2)" /></marker></defs>
            {[...graph.nodes.values()].map((n) => {
              const p = pos.get(n.id)!;
              const dim = focus && !related.has(n.id);
              return (
                <g key={n.id} transform={`translate(${p.x},${p.y})`} opacity={dim ? 0.35 : 1} style={{ cursor: n.kind === 'query' || n.kind === 'fn' ? 'pointer' : 'default' }}
                  onClick={() => (n.kind === 'query' || n.kind === 'fn') && setFocus(n.id.slice(2) === focus ? undefined : n.id.slice(2))}>
                  <rect width={W} height={H} rx={4} fill="var(--bg)" stroke={n.id === 'q:' + focus ? 'var(--accent, #118DFF)' : 'var(--line)'} strokeWidth={n.id === 'q:' + focus ? 2 : 1} />
                  <rect width={6} height={H} rx={2} fill={n.kind === 'origin' ? '#8764B8' : n.kind === 'param' ? '#E66C37' : n.kind === 'model' ? '#107C41' : '#118DFF'} />
                  <text x={16} y={19} fontSize={12} fill="var(--text2)">{ICON[n.kind]}</text>
                  <text x={34} y={19} fontSize={12} fontWeight={600} fill="var(--text)">{n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label}</text>
                  <text x={34} y={36} fontSize={10.5} fill="var(--text2)">{n.kind === 'origin' ? 'Origine dati' : n.kind === 'param' ? 'Parametro' : n.kind === 'model' ? 'Tabelle caricate' : n.kind === 'fn' ? 'Funzione' : queries.find((q) => q.name === n.label)?.load === false ? 'Solo connessione' : 'Query'}</text>
                </g>
              );
            })}
          </svg>
        </div>
        <div className="df"><span className="pq-note" style={{ flex: 1 }}>Fare clic su una query per evidenziarne origini e dipendenti.</span><button className="btn primary" onClick={onClose}>Chiudi</button></div>
      </div>
    </div>
  );
}

/** Sposta nel gruppo: an existing group or a new one ("Origini/Vendite" for nested groups). */
export function GroupPrompt({ groups, onOk, onClose }: { groups: string[]; onOk: (g: string) => void; onClose: () => void }) {
  const [g, setG] = useState(groups[0] ?? 'Nuovo gruppo');
  return (
    <div className="modal-bg pq-modal">
      <div className="dialog" style={{ width: 420 }}>
        <div className="dh"><h2>Sposta nel gruppo</h2><button onClick={onClose}><Icon name="close" /></button></div>
        <div className="db pq-db">
          <label className="pq-field">Gruppo
            <input type="text" list="pq-groups" value={g} autoFocus onChange={(e) => setG(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onOk(g)} />
            <datalist id="pq-groups">{groups.map((x) => <option key={x} value={x} />)}</datalist>
          </label>
          <p className="pq-note">Scegliere un gruppo esistente o digitare il nome di un nuovo gruppo. Vuoto = nessun gruppo.</p>
        </div>
        <div className="df"><button className="btn primary" onClick={() => onOk(g)}>OK</button><button className="btn" onClick={onClose}>Annulla</button></div>
      </div>
    </div>
  );
}
