// Title bar "Cerca": commands, pages, visuals to insert, fields and measures (like Power BI's search box).
import { useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { VISUALS } from '../visuals/catalog';
import { Icon, VisualIcon } from './icons';
import { locale } from '../format';

interface Item { group: string; label: string; hint?: string; run: () => void; icon?: React.ReactNode; }

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function CommandSearch() {
  const s = useStore();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const items = useMemo<Item[]>(() => {
    const st = useStore.getState;
    const panes = (k: keyof typeof s.panes) => () => st().set({ view: 'report', panes: { ...st().panes, [k]: true } });
    const cmds: Item[] = [
      ['Salva', () => st().save()], ['Salva con nome', () => st().save(true)], ['Apri', () => st().open()],
      ['Trasforma dati (Power Query)', () => st().openPowerQuery()], ['Aggiorna', () => st().refresh()],
      ['Nuova misura', () => st().startDax('measure')], ['Nuova colonna', () => st().startDax('column', st().tables[0]?.name)], ['Nuova tabella', () => st().startDax('table')],
      ['Nuovo parametro: intervallo numerico', () => st().set({ paramDialog: 'numeric' })], ['Nuovo parametro: campi', () => st().set({ paramDialog: 'fields' })],
      ['Gestisci relazioni', () => st().set({ relManage: true })], ['Nuova pagina', () => st().addPage()],
      ['Pubblica', () => st().set({ publishDialog: true })], ['Accedi a Power BI', () => st().set({ publishDialog: true })],
      ['Salva come file Power BI (.pbix)', () => st().exportPbix()], ['Esporta modello Power BI (.pbit)', () => st().exportPbit()], ['Esporta progetto Power BI (.pbip)', () => st().exportPbip()], ['Esporta PDF', () => st().exportPdf()],
      ['Dati di esempio', () => st().loadSample()], ['Database SQL Server', () => st().set({ dbDialog: 'sqlserver' })], ['Database Oracle', () => st().set({ dbDialog: 'oracle' })], ['Altri database', () => st().set({ dbDialog: true })],
      ['Riquadro Segnalibri', panes('bookmarks')], ['Riquadro Selezione', panes('selection')], ['Riquadro Filtri', panes('filters')],
      ['Riquadro Visualizzazioni', panes('viz')], ['Riquadro Dati', panes('data')],
      ['Aggiungi segnalibro', () => { st().addBookmark(); st().set({ panes: { ...st().panes, bookmarks: true } }); }],
      ['Vista report', () => st().setView('report')], ['Vista tabella', () => st().setView('data')], ['Vista modello', () => st().setView('model')], ['Vista query DAX', () => st().setView('dax')], ['Vista TMDL', () => st().setView('tmdl')],
    ].map(([label, run]) => ({ group: 'Comandi', label: label as string, run: run as () => void }));
    const visuals: Item[] = VISUALS.map((d) => ({ group: 'Inserisci oggetto visivo', label: d.name, icon: <VisualIcon type={d.type} size={16} />, run: () => { st().setView('report'); st().addVisual(d.type); } }));
    const pages: Item[] = s.report.pages.map((p) => ({ group: 'Pagine', label: p.name, hint: p.hidden ? 'nascosta' : undefined, run: () => st().set({ view: 'report', activePageId: p.id }) }));
    const fields: Item[] = [
      ...s.report.measures.map((m) => ({ group: 'Misure', label: m.name, hint: m.table, run: () => st().startDax('measure', m.table, m.name) })),
      ...s.tables.flatMap((t) => [
        { group: 'Tabelle', label: t.name, hint: `${t.rowCount.toLocaleString(locale())} righe`, run: () => st().set({ view: 'data', dataViewTable: t.name }) },
        ...t.columns.map((c) => ({ group: 'Colonne', label: c.name, hint: t.name, run: () => st().set({ view: 'data', dataViewTable: t.name }) })),
      ]),
    ];
    return [...cmds, ...visuals, ...pages, ...fields];
  }, [s.report.pages, s.report.measures, s.tables]);

  const words = norm(q).split(/\s+/).filter(Boolean);
  const hits = words.length ? items.filter((it) => words.every((w) => norm(`${it.label} ${it.hint ?? ''} ${it.group}`).includes(w))).slice(0, 14) : [];
  const run = (it: Item) => { setQ(''); setOpen(false); input.current?.blur(); it.run(); };
  let lastGroup = '';

  return (
    <div className="search" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Icon name="search" size={14} />
      <input ref={input} placeholder="Cerca" value={q} onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); setHi(0); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, hits.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)); }
          if (e.key === 'Enter' && hits[hi]) run(hits[hi]);
          if (e.key === 'Escape') { setQ(''); setOpen(false); input.current?.blur(); }
        }} />
      {open && q && (
        <div className="search-pop">
          {!hits.length && <div className="search-empty">Nessun risultato per «{q}»</div>}
          {hits.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="search-grp" key={'g' + i}>{it.group}</div> : null;
            lastGroup = it.group;
            return [head, (
              <button key={i} className={'search-item' + (i === hi ? ' hi' : '')} onMouseEnter={() => setHi(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => run(it)}>
                {it.icon ?? <span style={{ width: 16 }} />}<span className="lbl">{it.label}</span>{it.hint && <span className="hint">{it.hint}</span>}
              </button>
            )];
          })}
        </div>
      )}
    </div>
  );
}
