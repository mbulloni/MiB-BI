// Modellazione › Sicurezza: Gestisci ruoli (row-level security, a DAX row filter per table) and
// Visualizza come (report seen through one or more roles, optionally as another user).
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { rlsWhere } from '../dax';
import type { RoleDef } from '../types';
import { Icon } from './icons';
import { DaxInput } from './DaxInput';
import { daxShow, daxStore } from '../dax/separators';

export function RolesDialog() {
  const s = useStore();
  const [roles, setRoles] = useState<RoleDef[]>([]);
  const [sel, setSel] = useState(0);
  const [table, setTable] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (!s.rolesDialog) return;
    setRoles(structuredClone(s.report.roles ?? []));
    setSel(0);
    setTable(s.tables[0]?.name ?? '');
    setMsg(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.rolesDialog]);
  if (!s.rolesDialog) return null;
  const close = () => s.set({ rolesDialog: false });
  const role = roles[sel];
  const expr = role?.filters.find((f) => f.table === table)?.expression ?? '';
  const upd = (fn: (r: RoleDef[]) => void) => { const next = structuredClone(roles); fn(next); setRoles(next); setMsg(null); };
  const setExpr = (text: string) => upd((r) => {
    const fs = r[sel].filters;
    const f = fs.find((x) => x.table === table);
    if (f) f.expression = text; else fs.push({ table, expression: text });
    r[sel].filters = fs.filter((x) => x.expression.trim() || x.table === table);
  });
  const check = (rs: RoleDef[]): string | null => {
    for (const r of rs) {
      if (!r.name.trim()) return 'Ogni ruolo deve avere un nome.';
      if (rs.filter((x) => x.name.trim().toLowerCase() === r.name.trim().toLowerCase()).length > 1) return `Nome di ruolo duplicato: ${r.name}.`;
      for (const f of r.filters.filter((x) => x.expression.trim())) {
        try { rlsWhere(s.model(), [f]); } catch (e: any) { return `Ruolo ${r.name}, tabella ${f.table}: ${e.message.split('\n')[0]}`; }
      }
    }
    return null;
  };
  const verify = () => {
    if (!role) return;
    const f = role.filters.find((x) => x.table === table && x.expression.trim());
    if (!f) { setMsg({ ok: true, text: 'Nessun filtro: il ruolo vede tutte le righe della tabella.' }); return; }
    try { rlsWhere(s.model(), [f]); setMsg({ ok: true, text: 'Nessun errore di sintassi rilevato.' }); }
    catch (e: any) { setMsg({ ok: false, text: e.message.split('\n')[0] }); }
  };
  const save = () => {
    const clean = roles.map((r) => ({ name: r.name.trim(), filters: r.filters.filter((f) => f.expression.trim()), ...(r.hidden?.length ? { hidden: r.hidden } : {}) }));
    const err = check(clean);
    if (err) { setMsg({ ok: false, text: err }); return; }
    void s.saveRoles(clean);
  };
  const hid = (k: string) => !!role?.hidden?.includes(k);
  const setHidden = (k: string, on: boolean) => upd((r) => {
    const h = new Set(r[sel].hidden ?? []);
    if (on) h.add(k); else h.delete(k);
    if (h.size) r[sel].hidden = [...h]; else delete r[sel].hidden;
  });
  const cols = s.tables.find((t) => t.name === table)?.columns ?? [];
  const newRole = () => upd((r) => {
    let n = 'Nuovo ruolo', i = 2;
    while (r.some((x) => x.name === n)) n = `Nuovo ruolo ${i++}`;
    r.push({ name: n, filters: [] });
    setSel(r.length - 1);
  });

  return (
    <div className="modal-bg">
      <div className="dialog roles-dlg">
        <div className="dh"><h2>Gestisci ruoli di sicurezza</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db">
          <div className="roles-col">
            <div className="roles-hd">Ruoli <button className="btn-mini" onClick={newRole}><Icon name="plus" size={12} />Nuovo</button></div>
            <div className="roles-list">
              {roles.map((r, i) => (
                <div key={i} className={'roles-item' + (i === sel ? ' active' : '')} onClick={() => { setSel(i); setMsg(null); }}>
                  {i === sel ? <input autoFocus={false} value={r.name} onChange={(e) => upd((x) => { x[i].name = e.target.value; })} /> : <span>{r.name}</span>}
                  <button title="Elimina ruolo" onClick={(e) => { e.stopPropagation(); upd((x) => { x.splice(i, 1); }); setSel(Math.max(0, i - 1)); }}><Icon name="trash" size={12} /></button>
                </div>
              ))}
              {!roles.length && <div className="hint" style={{ padding: 8 }}>Nessun ruolo. Fare clic su Nuovo.</div>}
            </div>
          </div>
          <div className="roles-col">
            <div className="roles-hd">Seleziona tabelle</div>
            <div className="roles-list">
              {s.tables.filter((t) => !s.report.calcGroups?.some((g) => g.table === t.name)).map((t) => (
                <div key={t.name} className={'roles-item' + (t.name === table ? ' active' : '')} onClick={() => { setTable(t.name); setMsg(null); }}>
                  <Icon name={role?.hidden?.some((k) => k === t.name || k.startsWith(t.name + '\u0001')) ? 'eyeOff' : role?.filters.some((f) => f.table === t.name && f.expression.trim()) ? 'filter' : 'tableSmall'} size={14} /><span>{t.name}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="roles-col wide">
            <div className="roles-hd">Filtra dati {role && table ? <>— {table}</> : null}</div>
            {role && table ? <>
              <span className="hint">Espressione DAX valutata riga per riga: le righe per cui è TRUE sono visibili ai membri del ruolo (es. <code>[Country] = "Italy"</code> o <code>[Email] = USERPRINCIPALNAME()</code>). Il filtro si propaga alle tabelle collegate dal lato uno al lato molti.</span>
              <DaxInput className="roles-dax" value={daxShow(expr)} onChange={(t) => setExpr(daxStore(t))} home={table} rows={7} placeholder={`[Colonna] = "valore"`} />
              <div><button className="btn" onClick={verify}>✓ Verifica DAX</button></div>
              <div className="roles-hd" style={{ marginTop: 10 }}>Sicurezza a livello di oggetto</div>
              <label className="pq-row" style={{ gap: 8, alignItems: 'center' }}>Autorizzazione tabella
                <select value={hid(table) ? 'none' : 'read'} onChange={(e) => setHidden(table, e.target.value === 'none')}>
                  <option value="read">Lettura</option><option value="none">Nessuno (tabella nascosta)</option>
                </select>
              </label>
              {!hid(table) && (
                <div className="ols-cols">
                  {cols.map((c) => (
                    <label key={c.name} className="chk"><input type="checkbox" checked={hid(table + '\u0001' + c.name)} onChange={(e) => setHidden(table + '\u0001' + c.name, e.target.checked)} />Nascondi {c.name}</label>
                  ))}
                </div>
              )}
              <span className="hint">I membri del ruolo non vedono gli oggetti nascosti: gli oggetti visivi che li usano, anche tramite una misura, mostrano un errore.</span>
            </> : <span className="hint">Creare o selezionare un ruolo.</span>}
            {msg && <div className={msg.ok ? 'roles-ok' : 'daxbar-err'}><Icon name={msg.ok ? 'info' : 'warning'} size={14} />{msg.text}</div>}
          </div>
        </div>
        <div className="df">
          <button className="btn primary" onClick={save}>Salva</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}

export function ViewAsDialog() {
  const s = useStore();
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState(false);
  const [user, setUser] = useState('');
  useEffect(() => {
    if (!s.viewAsDialog) return;
    setPicked(s.viewAs?.roles ?? []);
    setOther(!!s.viewAs?.user);
    setUser(s.viewAs?.user ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.viewAsDialog]);
  if (!s.viewAsDialog) return null;
  const close = () => s.set({ viewAsDialog: false });
  const roles = s.report.roles ?? [];
  const flip = (n: string) => setPicked(picked.includes(n) ? picked.filter((x) => x !== n) : [...picked, n]);
  return (
    <div className="modal-bg">
      <div className="dialog viewas-dlg">
        <div className="dh"><h2>Visualizza come ruoli</h2><button onClick={close}><Icon name="close" /></button></div>
        <div className="db" style={{ flexDirection: 'column', gap: 6 }}>
          <label className="chk"><input type="checkbox" checked={!picked.length && !other} onChange={() => { setPicked([]); setOther(false); }} />Nessuno</label>
          <label className="chk"><input type="checkbox" checked={other} onChange={(e) => setOther(e.target.checked)} />Altro utente</label>
          {other && <input type="text" style={{ marginLeft: 24 }} placeholder="utente@contoso.com" value={user} onChange={(e) => setUser(e.target.value)} />}
          {roles.map((r) => <label key={r.name} className="chk"><input type="checkbox" checked={picked.includes(r.name)} onChange={() => flip(r.name)} />{r.name}</label>)}
          {!roles.length && <span className="hint">Nessun ruolo definito: usare Gestisci ruoli.</span>}
          <span className="hint">Con più ruoli selezionati una riga è visibile se almeno un ruolo la consente. USERPRINCIPALNAME() restituisce l'utente indicato.</span>
        </div>
        <div className="df">
          <button className="btn primary" onClick={() => void s.setViewAs(picked.length || (other && user.trim()) ? { roles: picked, ...(other && user.trim() ? { user: user.trim() } : {}) } : null)}>OK</button>
          <button className="btn" onClick={close}>Annulla</button>
        </div>
      </div>
    </div>
  );
}

/** Yellow bar shown while viewing the report as roles (Power BI "Visualizzazione come …"). */
export function ViewAsBar() {
  const s = useStore();
  if (!s.viewAs) return null;
  const who = [...s.viewAs.roles, ...(s.viewAs.user ? [s.viewAs.user] : [])].join(', ');
  return (
    <div className="viewas-bar">
      <Icon name="shield" size={14} /><span>Visualizzazione come: <b>{who}</b></span>
      <button className="btn-mini" onClick={() => s.set({ viewAsDialog: true })}>Modifica</button>
      <button className="btn-mini" onClick={() => void s.setViewAs(null)}>Interrompi visualizzazione</button>
    </div>
  );
}
