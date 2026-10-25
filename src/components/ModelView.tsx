import { useRef, useState } from 'react';
import { useStore } from '../store';
import type { Relationship } from '../types';
import { isDate, isNumeric } from '../format';
import { Icon } from './icons';
import { Menu } from './Menu';
import { emptyDraft } from './Relationships';

const W = 210, HEAD = 36, ROW = 24, MAX_BODY = 300;
type Pt = { x: number; y: number };
type Box = { x: number; y: number; w: number; h: number };

const cardHeight = (cols: number) => HEAD + Math.min(cols * ROW + 8, MAX_BODY);

/** Connection points on the facing sides of two cards plus bezier control points. */
function geometry(a: Box, b: Box) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  let p1: Pt, p2: Pt, c1: Pt, c2: Pt;
  if (b.x > a.x + a.w + 20 || a.x > b.x + b.w + 20) {
    const right = bc.x > ac.x;
    p1 = { x: right ? a.x + a.w : a.x, y: ac.y };
    p2 = { x: right ? b.x : b.x + b.w, y: bc.y };
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2) * (right ? 1 : -1);
    c1 = { x: p1.x + dx, y: p1.y }; c2 = { x: p2.x - dx, y: p2.y };
  } else {
    const down = bc.y > ac.y;
    p1 = { x: ac.x, y: down ? a.y + a.h : a.y };
    p2 = { x: bc.x, y: down ? b.y : b.y + b.h };
    const dy = Math.max(40, Math.abs(p2.y - p1.y) / 2) * (down ? 1 : -1);
    c1 = { x: p1.x, y: p1.y + dy }; c2 = { x: p2.x, y: p2.y - dy };
  }
  const bez = (t: number) => {
    const u = 1 - t;
    return {
      x: u * u * u * p1.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p2.x,
      y: u * u * u * p1.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p2.y,
    };
  };
  return { p1, p2, d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, bez };
}

/** Small filled triangle at `at` pointing from `from` towards `to` (filter direction). */
function arrow(at: Pt, from: Pt, to: Pt) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  const pt = (r: number, da: number) => `${at.x + r * Math.cos(a + da)},${at.y + r * Math.sin(a + da)}`;
  return `${pt(7, 0)} ${pt(6, 2.5)} ${pt(6, -2.5)}`;
}

function RelLine({ r, a, b, selected, onSelect, onEdit, onMenu }: {
  r: Relationship; a: Box; b: Box; selected: boolean;
  onSelect: () => void; onEdit: () => void; onMenu: (e: React.MouseEvent) => void;
}) {
  const g = geometry(a, b);
  const m = g.bez(0.5), m1 = g.bez(0.44), m2 = g.bez(0.56);
  const nearFrom = g.bez(0.08), nearTo = g.bez(0.92);
  const fromSym = r.cardinality === 'oneToOne' ? '1' : '*';
  const toSym = r.cardinality === 'manyToMany' ? '*' : '1';
  const color = selected ? '#118DFF' : 'currentColor'; // .rel color follows the UI theme
  const both = r.crossFilter === 'both' || r.cardinality === 'oneToOne';
  return (
    <g className="rel" onMouseDown={(e) => { e.stopPropagation(); onSelect(); }} onDoubleClick={onEdit} onContextMenu={onMenu}>
      <path d={g.d} stroke="transparent" strokeWidth={14} fill="none" style={{ cursor: 'pointer' }} />
      <path d={g.d} stroke={color} strokeWidth={selected ? 2.2 : 1.4} fill="none" strokeDasharray={r.active ? undefined : '6 4'} />
      <circle cx={g.p1.x} cy={g.p1.y} r={3} fill={color} />
      <circle cx={g.p2.x} cy={g.p2.y} r={3} fill={color} />
      <text x={nearFrom.x} y={nearFrom.y - 6} textAnchor="middle" fontSize={14} fontWeight={600} fill={color}>{fromSym}</text>
      <text x={nearTo.x} y={nearTo.y - 6} textAnchor="middle" fontSize={14} fontWeight={600} fill={color}>{toSym}</text>
      {/* filters flow from the one side (to) towards the many side (from) */}
      {both ? <>
        <polygon points={arrow(m1, m, g.p1)} fill={color} />
        <polygon points={arrow(m2, m, g.p2)} fill={color} />
      </> : <polygon points={arrow(m, g.p2, g.p1)} fill={color} />}
    </g>
  );
}

export function ModelView() {
  const s = useStore();
  const wrap = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ table: string; x: number; y: number } | null>(null);
  const [link, setLink] = useState<{ table: string; column: string; from: Pt; to: Pt } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [colMenu, setColMenu] = useState<{ x: number; y: number; table: string; column: string } | null>(null);

  if (!s.tables.length) return <div className="placeholder-view"><Icon name="model" size={48} /><h2>Nessuna tabella</h2><span>Le tabelle caricate e le loro relazioni appariranno qui.</span></div>;

  const layout = s.report.modelLayout;
  const pos = (name: string, i: number): Pt =>
    drag?.table === name ? drag : layout[name] ?? { x: 40 + (i % 4) * 280, y: 40 + Math.floor(i / 4) * 380 };
  const boxes = new Map(s.tables.map((t, i) => [t.name, { ...pos(t.name, i), w: W, h: cardHeight(t.columns.length) }]));
  const sel = s.report.relationships.find((r) => r.id === s.selectedRelId);
  const hot = new Set(sel ? [`${sel.fromTable}\u0001${sel.fromColumn}`, `${sel.toTable}\u0001${sel.toColumn}`] : []);
  const width = Math.max(...[...boxes.values()].map((b) => b.x + b.w)) + 200;
  const height = Math.max(...[...boxes.values()].map((b) => b.y + b.h)) + 200;

  const local = (e: { clientX: number; clientY: number }): Pt => {
    const r = wrap.current!.getBoundingClientRect();
    return { x: e.clientX - r.left + wrap.current!.scrollLeft, y: e.clientY - r.top + wrap.current!.scrollTop };
  };

  const startMove = (name: string, i: number) => (e: React.MouseEvent) => {
    e.preventDefault();
    const start = pos(name, i), m0 = { x: e.clientX, y: e.clientY };
    let last = start;
    const move = (m: MouseEvent) => {
      last = { x: Math.max(0, start.x + m.clientX - m0.x), y: Math.max(0, start.y + m.clientY - m0.y) };
      setDrag({ table: name, ...last });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setDrag(null);
      if (last.x !== start.x || last.y !== start.y) s.setModelPos(name, last);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Drag a column onto a column of another table to create a relationship, like Power BI.
  const startLink = (table: string, column: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const p = local(e);
    setLink({ table, column, from: p, to: p });
    const move = (m: MouseEvent) => setLink((l) => l && { ...l, to: local(m) });
    const up = (m: MouseEvent) => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      setLink(null);
      const el = (m.target as HTMLElement).closest('[data-col]') as HTMLElement | null;
      if (!el) return;
      const [t2, c2] = [el.dataset.table!, el.dataset.col!];
      if (t2 !== table) s.set({ relEditor: { draft: emptyDraft(table, column, t2, c2), isNew: true } });
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  return (
    <div className="modelview" ref={wrap} onMouseDown={() => s.set({ selectedRelId: null })}>
      <div className="model-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button onClick={() => s.set({ relManage: true })}><Icon name="relationships" size={16} />Gestisci relazioni</button>
        <button onClick={() => s.set({ relEditor: { draft: emptyDraft(), isNew: true } })}><Icon name="plus" />Nuova relazione</button>
        <span className="hint">Trascinare una colonna su un'altra tabella per creare una relazione</span>
      </div>
      <svg className="model-lines" width={width} height={height}>
        {s.report.relationships.map((r) => {
          const a = boxes.get(r.fromTable), b = boxes.get(r.toTable);
          if (!a || !b) return null;
          return (
            <RelLine key={r.id} r={r} a={a} b={b} selected={r.id === s.selectedRelId}
              onSelect={() => s.set({ selectedRelId: r.id })}
              onEdit={() => s.set({ relEditor: { draft: r, isNew: false } })}
              onMenu={(e) => { e.preventDefault(); s.set({ selectedRelId: r.id }); setMenu({ x: e.clientX, y: e.clientY, id: r.id }); }} />
          );
        })}
        {link && <line x1={link.from.x} y1={link.from.y} x2={link.to.x} y2={link.to.y} stroke="#118DFF" strokeWidth={2} strokeDasharray="5 4" />}
      </svg>
      {s.tables.map((t, i) => {
        const b = boxes.get(t.name)!;
        const related = s.report.relationships.some((r) => r.fromTable === t.name || r.toTable === t.name);
        return (
          <div key={t.name} className={'mtable' + (drag?.table === t.name ? ' moving' : '')} style={{ left: b.x, top: b.y, width: W }} onMouseDown={(e) => e.stopPropagation()}>
            <div className="mt-h" onMouseDown={startMove(t.name, i)} style={{ borderTopColor: related ? '#118DFF' : '#A19F9D' }}
              onContextMenu={(e) => { e.preventDefault(); s.set({ propsTarget: { table: t.name } }); }} title="Clic destro: proprietà della tabella">
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
              {t.storageMode && <span className={'mt-mode ' + t.storageMode} title={t.storageMode === 'directQuery' ? 'Modalità di archiviazione: DirectQuery' : 'Modalità di archiviazione: Doppia'}>{t.storageMode === 'directQuery' ? 'DirectQuery' : 'Doppia'}</span>}
              <button className="mt-props" title="Proprietà della tabella (modalità di archiviazione, tabella delle date…)" onMouseDown={(e) => e.stopPropagation()} onClick={() => s.set({ propsTarget: { table: t.name } })}><Icon name="gear" size={12} /></button>
            </div>
            <div className="mt-b" style={{ maxHeight: MAX_BODY }}>
              {t.columns.map((c) => (
                <div key={c.name} data-table={t.name} data-col={c.name}
                  className={hot.has(`${t.name}\u0001${c.name}`) ? 'hot' : link && link.table !== t.name ? 'droppable' : ''}
                  onMouseDown={startLink(t.name, c.name)} title={`${c.name} (${c.type})`}
                  onContextMenu={(e) => { e.preventDefault(); setColMenu({ x: e.clientX, y: e.clientY, table: t.name, column: c.name }); }}>
                  <span style={{ width: 14, display: 'flex' }}>{isNumeric(c) ? <Icon name="sigma" size={12} /> : isDate(c) ? <Icon name="calendar" size={12} /> : null}</span>
                  {c.name}
                </div>
              ))}
              {s.report.measures.filter((m) => m.table === t.name).map((m) => (
                <div key={'m:' + m.name} className="mt-extra" title={`${m.name} = ${m.expression}`} onContextMenu={(e) => { e.preventDefault(); s.set({ propsTarget: { table: t.name, field: m.name } }); }}
                  onDoubleClick={() => s.startDax('measure', t.name, m.name)}>
                  <span style={{ width: 14, display: 'flex' }}><Icon name="calc" size={12} /></span>{m.name}
                </div>
              ))}
              {(s.report.hierarchies ?? []).filter((h) => h.table === t.name).map((h) => (
                <div key={'h:' + h.name} className="mt-extra" title={h.levels.join(' › ')} onContextMenu={(e) => { e.preventDefault(); s.set({ propsTarget: { table: t.name, hierarchy: h.name } }); }}
                  onDoubleClick={() => s.set({ propsTarget: { table: t.name, hierarchy: h.name } })}>
                  <span style={{ width: 14, display: 'flex' }}><Icon name="hierarchy" size={12} /></span>{h.name}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {colMenu && (
        <Menu x={colMenu.x} y={colMenu.y} onClose={() => setColMenu(null)}>
          <button onClick={() => { s.set({ propsTarget: { table: colMenu.table, field: colMenu.column } }); setColMenu(null); }}><Icon name="gear" />Proprietà</button>
          <button onClick={() => { s.createHierarchy(colMenu.table, colMenu.column); setColMenu(null); }}><Icon name="hierarchy" />Crea gerarchia</button>
          {(s.report.hierarchies ?? []).filter((h) => h.table === colMenu.table && !h.levels.includes(colMenu.column)).map((h) => (
            <button key={h.name} onClick={() => { s.addHierarchyLevel(colMenu.table, h.name, colMenu.column); setColMenu(null); }}>Aggiungi alla gerarchia › {h.name}</button>
          ))}
        </Menu>
      )}
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => { const r = s.report.relationships.find((x) => x.id === menu.id); if (r) s.set({ relEditor: { draft: r, isNew: false } }); setMenu(null); }}>Proprietà</button>
          <button onClick={() => { s.deleteRelationship(menu.id); setMenu(null); }}><Icon name="trash" />Elimina</button>
        </Menu>
      )}
    </div>
  );
}
