import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api';
import { useStore, type FilterScope } from '../store';
import type { Filter } from '../types';
import { NULL_KEY, qi } from '../query';
import { Icon } from '../components/icons';
import { FIELD_MIME } from '../components/VisualContainer';
import { fontStack, THEME } from '../themes';
import { withAlpha } from '../visuals/pbistyle';

function FilterCard({ f, scope, removable }: { f: Filter; scope: FilterScope; removable: boolean }) {
  const s = useStore();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<{ v: string | null; n: number }[] | null>(null);
  const [q, setQ] = useState('');

  useEffect(() => {
    if (!open) return;
    api.queryAs(`SELECT CAST(${qi(f.column)} AS VARCHAR) AS v, COUNT(*) AS n FROM ${qi(f.table)} GROUP BY 1 ORDER BY 1 NULLS LAST LIMIT 2000`)
      .then((r) => setValues(r.rows.map((x) => ({ v: x.v, n: Number(x.n) }))))
      .catch(() => setValues([]));
  }, [open, f.table, f.column, s.dataVersion]);

  const sel = new Set(f.values);
  const set = (vals: string[]) => s.updateFilter(scope, f.id, vals, { table: f.table, column: f.column });
  const summary = f.values.length ? 'è ' + f.values.map((x) => (x === NULL_KEY ? '(Vuoto)' : x)).join(', ') : 'è (Tutto)';
  const shown = (values ?? []).filter((x) => !q || (x.v ?? '(vuoto)').toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="filtercard" style={(f.values.length ? THEME.filterPane.cardApplied : THEME.filterPane.cardAvailable) ? { background: f.values.length ? THEME.filterPane.cardApplied : THEME.filterPane.cardAvailable } : undefined}>
      <div className="fhead" onClick={() => setOpen(!open)}>
        <span className="nm" title={`${f.table}[${f.column}]`}>{f.column}</span>
        {f.values.length > 0 && <button title="Cancella filtro" onClick={(e) => { e.stopPropagation(); set([]); }}><Icon name="filter" size={12} /></button>}
        {removable && <button title="Rimuovi filtro" onClick={(e) => { e.stopPropagation(); s.removeFilter(scope, f.id); }}><Icon name="close" size={12} /></button>}
        <button><Icon name={open ? 'chevronUp' : 'chevronDown'} size={12} /></button>
      </div>
      {!open && <div className="fsub">{summary}</div>}
      {open && (
        <div className="fbody">
          <div style={{ color: 'var(--text2)', margin: '6px 0' }}>Tipo di filtro: <b>Filtro di base</b></div>
          <input type="search" placeholder="Cerca" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: '100%' }} />
          <div className="list">
            <label><input type="checkbox" checked={sel.size === 0} onChange={() => set([])} />Seleziona tutto</label>
            {values === null && <div style={{ color: 'var(--text3)' }}>Caricamento…</div>}
            {shown.map(({ v, n }) => {
              const k = v ?? NULL_KEY;
              return (
                <label key={k}>
                  <input type="checkbox" checked={sel.has(k)} onChange={() => set(sel.has(k) ? f.values.filter((x) => x !== k) : [...f.values, k])} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{v ?? '(Vuoto)'}</span>
                  <span style={{ color: 'var(--text3)' }}>{n}</span>
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function Section({ title, scope, filters, auto = [] }: { title: string; scope: FilterScope; filters: Filter[]; auto?: Filter[] }) {
  const addFilter = useStore((s) => s.addFilter);
  const [over, setOver] = useState(false);
  return (
    <div className="section">
      <h4>{title}</h4>
      {auto.map((f) => <FilterCard key={f.id} f={f} scope={scope} removable={false} />)}
      {filters.map((f) => <FilterCard key={f.id} f={f} scope={scope} removable />)}
      <div
        className={'dropzone' + (over ? ' over' : '')}
        onDragOver={(e) => { if (e.dataTransfer.types.includes(FIELD_MIME)) { e.preventDefault(); setOver(true); } }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const raw = e.dataTransfer.getData(FIELD_MIME);
          if (!raw) return;
          const { measure, ...f } = JSON.parse(raw);
          if (!measure) addFilter(scope, f);
        }}
      >Aggiungi campi dati qui</div>
    </div>
  );
}

export function FiltersPane() {
  const s = useStore();
  if (!s.panes.filters) return null;
  const page = s.page();
  const v = page.visuals.find((x) => x.id === s.selectedVisualId);

  // Every field used by the selected visual gets an implicit filter card, like Power BI.
  const explicit = v?.filters ?? [];
  const auto: Filter[] = [];
  if (v) {
    for (const f of Object.values(v.fields).flat()) {
      if (f.agg === 'measure' || f.agg === 'visualCalc') continue;
      if (explicit.some((x) => x.table === f.table && x.column === f.column) || auto.some((x) => x.table === f.table && x.column === f.column)) continue;
      auto.push({ id: `auto-${v.id}-${f.table}-${f.column}`, table: f.table, column: f.column, values: [] });
    }
  }

  return (
    <div className={'pane filters-pane' + (filterPaneStyle() ? ' themed' : '')} style={filterPaneStyle()}>
      <div className="pane-head">
        <h3>Filtri</h3>
        <div className="tools">
          <button title="Comprimi" onClick={() => s.set({ panes: { ...s.panes, filters: false } })}><Icon name="collapseRight" /></button>
        </div>
      </div>
      <div className="pane-search"><Icon name="search" size={14} /><input type="search" placeholder="Cerca" /></div>
      <div className="pane-body">
        {v && v.type !== 'textbox' && <Section title="Filtri per questo oggetto visivo" scope="visual" filters={explicit} auto={auto} />}
        <Section title="Filtri in questa pagina" scope="page" filters={page.filters} />
        <Section title="Filtri in tutte le pagine" scope="report" filters={s.report.reportFilters} />
      </div>
    </div>
  );
}

export function CollapsedPane({ title, onOpen }: { title: string; onOpen: () => void }) {
  return (
    <div className="pane collapsed" onClick={onOpen} title={`Espandi ${title}`}>
      <Icon name="collapseLeft" />
      <span className="vtitle">{title}</span>
    </div>
  );
}

/** Riquadro filtri colors from the report theme (outspacePane); none = the app chrome. */
function filterPaneStyle(): CSSProperties | undefined {
  const p = THEME.filterPane;
  if (!p.background && !p.foreground && !p.font) return undefined;
  return { ...(p.background ? { background: withAlpha(p.background, p.transparency) } : {}), ...(p.foreground ? { color: p.foreground } : {}), ...(p.font ? { fontFamily: fontStack(p.font) } : {}) };
}
