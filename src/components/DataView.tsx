import { useEffect, useState } from 'react';
import { api } from '../api';
import { useStore } from '../store';
import { isNumeric, fmtFull } from '../format';
import { qi } from '../query';
import { Icon } from './icons';
import { Menu } from './Menu';

/** Power BI data categories (Strumenti colonna › Categoria dati), Italian labels. */
export const DATA_CATEGORIES: [string, string][] = [
  ['', 'Non categorizzato'], ['Address', 'Indirizzo'], ['Place', 'Luogo'], ['City', 'Città'], ['County', 'Contea'],
  ['StateOrProvince', 'Stato o provincia'], ['PostalCode', 'CAP'], ['Country', 'Paese/area geografica'], ['Continent', 'Continente'],
  ['Latitude', 'Latitudine'], ['Longitude', 'Longitudine'], ['WebUrl', 'URL Web'], ['ImageUrl', 'URL immagine'], ['Barcode', 'Codice a barre'],
];

export function DataView() {
  const s = useStore();
  const t = s.tables.find((x) => x.name === s.dataViewTable) ?? s.tables[0];
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [sort, setSort] = useState<{ col: string; dir: 'ASC' | 'DESC' } | null>(null);
  const [selCol, setSelCol] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; col: string } | null>(null);

  useEffect(() => { setSort(null); setSelCol(null); }, [t?.name]);
  useEffect(() => {
    if (!t) return;
    const order = sort ? ` ORDER BY ${qi(sort.col)} ${sort.dir} NULLS LAST` : '';
    api.queryAs(`SELECT * FROM ${qi(t.name)}${order} LIMIT 2000`).then((r) => setRows(r.rows)).catch((e) => s.notify(e.message));
  }, [t?.name, sort, s.dataVersion]);

  if (!t) return <div className="placeholder-view"><Icon name="tableView" size={48} /><h2>Nessun dato</h2><span>Caricare dati per visualizzarli in questa vista.</span></div>;
  const col = selCol ? t.columns.find((c) => c.name === selCol) : undefined;

  return (
    <div className="dataview">
      {col && (
        <div className="coltools">
          <b>Strumenti colonna</b>
          <label>Categoria dati
            <select value={t.dataCategory?.[col.name] ?? ''} onChange={(e) => s.setColumnProps(t.name, col.name, { dataCategory: e.target.value || null })}>
              {DATA_CATEGORIES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <label>Ordina per colonna
            <select value={t.sortBy?.[col.name] ?? ''} onChange={(e) => s.setColumnProps(t.name, col.name, { sortBy: e.target.value && e.target.value !== col.name ? e.target.value : null })}>
              <option value="">{col.name}</option>
              {t.columns.filter((c) => c.name !== col.name).map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
          </label>
          <button className="btn" onClick={() => s.set({ groupDialog: s.report.groupings?.some((g) => g.table === t.name && g.name === col.name) ? { table: t.name, column: col.name, name: col.name } : { table: t.name, column: col.name } })}>
            <Icon name="tableSmall" size={13} /> Gruppi dati
          </button>
        </div>
      )}
      <div className="formulabar">
        <Icon name="close" size={12} /><span style={{ color: 'var(--text3)' }}>✓</span><span className="fx">fx</span>
        <span>{col ? `${col.name}  ·  Tipo di dati: ${col.type}` : ''}</span>
      </div>
      <div className="grid-wrap">
        <table>
          <thead><tr>{t.columns.map((c) => (
            <th key={c.name} className={selCol === c.name ? 'sel' : ''} onClick={() => setSelCol(c.name)}>
              <div className="h">
                <span>{c.name}</span>
                <span onClick={(e) => { e.stopPropagation(); setMenu({ x: e.clientX, y: e.clientY, col: c.name }); }}>
                  <Icon name={sort?.col === c.name ? (sort.dir === 'ASC' ? 'chevronUp' : 'chevronDown') : 'chevronDown'} size={11} />
                </span>
              </div>
            </th>
          ))}</tr></thead>
          <tbody>{rows.map((r, i) => (
            <tr key={i}>{t.columns.map((c) => {
              const v = r[c.name];
              const num = isNumeric(c);
              return <td key={c.name} className={(num ? 'num' : '') + (selCol === c.name ? ' sel' : '') + (v === null ? ' null' : '')}>{v === null ? '' : num ? fmtFull(v) : String(v)}</td>;
            })}</tr>
          ))}</tbody>
        </table>
      </div>
      {menu && (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button onClick={() => { setSort({ col: menu.col, dir: 'ASC' }); setMenu(null); }}>Ordinamento crescente</button>
          <button onClick={() => { setSort({ col: menu.col, dir: 'DESC' }); setMenu(null); }}>Ordinamento decrescente</button>
          <button onClick={() => { setSort(null); setMenu(null); }}>Cancella ordinamento</button>
        </Menu>
      )}
    </div>
  );
}
