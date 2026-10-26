// Vista TMDL › Applica: a `createOrReplace` script (parsed by main, electron/pbip.cjs#parseTmdl) applied to the model.
// `table X` replaces the table's measures, calculated columns and hierarchies with the script's; `ref table X` only
// adds or replaces the objects it lists. Also relationships, roles (RLS + OLS), perspectives, expressions
// (parameters / queries), functions and refresh policies. Imported columns and partitions come from Power Query and
// are not created here; their properties (description, display folder, data category, sort by) are applied.
import { useStore } from './store';
import { paramFromM } from './pq/params';
import { daxShow } from './dax/separators';
import type { Cardinality, Hierarchy, PolicyUnit, Relationship, RoleDef } from './types';

export interface TmdlNode { kind: string; name?: string; refKind?: string; value?: string; description?: string; props: Record<string, string>; children: TmdlNode[] }

const unq = (v: string | undefined) => (v && /^'.*'$/.test(v) ? v.slice(1, -1).replace(/''/g, "'") : v ?? '');
/** "Table.Column" / "'My table'.Column" → [table, column]. */
function splitRef(r: string): [string, string] {
  const m = /^('(?:[^']|'')*'|[^.]+)\.(.+)$/.exec(r.trim());
  return m ? [unq(m[1]), unq(m[2])] : [unq(r.trim()), ''];
}

export async function applyTmdl(root: TmdlNode): Promise<{ done: string[]; errors: string[] }> {
  const st = () => useStore.getState();
  const done: string[] = [], errors: string[] = [];
  if (!root.props.createOrReplace) errors.push('Lo script deve iniziare con createOrReplace (gli altri comandi TMDL non sono supportati).');
  // Measures and calculated columns go through the formula bar path (DAX checked, names unique, data recomputed).
  const saveDax = async (kind: 'measure' | 'column' | 'table', table: string, name: string, expr: string, original: string | null, formatString?: string) => {
    st().set({ daxEdit: { kind, table, original, text: daxShow(`${name} = ${expr}`), ...(formatString ? { formatString } : {}) } });
    const ok = await st().saveDax();
    if (!ok) { errors.push(`${table}[${name}]: ${st().daxEdit?.error ?? 'errore'}`); st().set({ daxEdit: null }); }
    return ok;
  };

  for (const n of root.children) {
    const kind = n.kind === 'ref' ? n.refKind : n.kind;
    const name = n.name ?? '';
    try {
      if (kind === 'table') {
        const partial = n.kind === 'ref';
        const t = st().tables.find((x) => x.name === name);
        const calcPart = n.children.find((c) => c.kind === 'partition' && (c.value ?? '').trim() === 'calculated');
        if (!t) {
          if (calcPart?.props.source) { if (await saveDax('table', name, name, calcPart.props.source, null)) done.push(`tabella calcolata ${name}`); }
          else if (n.children.some((c) => c.kind === 'column' && !c.value)) { errors.push(`${name}: le tabelle importate si creano con Ottieni dati / Power Query.`); continue; }
        } else if (calcPart?.props.source && t.source.dax !== calcPart.props.source) {
          if (await saveDax('table', name, name, calcPart.props.source, name)) done.push(`tabella calcolata ${name}`);
        }
        if (n.description !== undefined || !partial) st().setDescription(name, n.description ?? '');
        // Measures
        const measures = n.children.filter((c) => c.kind === 'measure');
        for (const m of measures) {
          const cur = st().report.measures.find((x) => x.name === m.name);
          if (cur && cur.table !== name) { errors.push(`Misura ${m.name}: esiste già nella tabella ${cur.table}.`); continue; }
          if (!cur || cur.expression !== m.value || (cur.formatString ?? '') !== (m.props.formatString ?? '')) {
            if (!(await saveDax('measure', name, m.name!, m.value ?? '', cur ? m.name! : null, m.props.formatString))) continue;
          }
          st().setDisplayFolder(name, m.name!, m.props.displayFolder ?? '');
          st().setDescription(`${name}\u0001${m.name}`, m.description ?? m.props.description ?? '');
          done.push(`misura ${m.name}`);
        }
        if (!partial) for (const m of st().report.measures.filter((x) => x.table === name && !measures.some((y) => y.name === x.name))) { st().deleteMeasure(m.name); done.push(`misura ${m.name} rimossa`); }
        // Columns
        const cols = n.children.filter((c) => c.kind === 'column');
        for (const c of cols) {
          const tt = st().tables.find((x) => x.name === name);
          const exists = tt?.columns.some((x) => x.name === c.name);
          if (c.value !== undefined && !st().tables.find((x) => x.name === name)?.source.dax) {
            const cur = tt?.calcColumns?.find((x) => x.name === c.name);
            if (!cur || cur.expression !== c.value) { if (!(await saveDax('column', name, c.name!, c.value, cur ? c.name! : null))) continue; }
          } else if (!exists) { errors.push(`${name}[${c.name}]: la colonna non esiste (le colonne importate vengono dalla query).`); continue; }
          st().setColumnProps(name, c.name!, { dataCategory: unq(c.props.dataCategory) || null, sortBy: unq(c.props.sortByColumn) || null });
          st().setDisplayFolder(name, c.name!, c.props.displayFolder ?? '');
          st().setDescription(`${name}\u0001${c.name}`, c.description ?? c.props.description ?? '');
          done.push(`colonna ${name}[${c.name}]`);
        }
        if (!partial) for (const c of st().tables.find((x) => x.name === name)?.calcColumns?.filter((x) => !cols.some((y) => y.name === x.name)) ?? []) { await st().deleteCalcColumn(name, c.name); done.push(`colonna ${name}[${c.name}] rimossa`); }
        // Hierarchies
        const hs = n.children.filter((c) => c.kind === 'hierarchy').map((h): Hierarchy => {
          const levels = h.children.filter((l) => l.kind === 'level');
          const names = Object.fromEntries(levels.filter((l) => l.name && unq(l.props.column) !== l.name).map((l) => [unq(l.props.column), l.name!]));
          return { table: name, name: h.name!, levels: levels.map((l) => unq(l.props.column)), ...(Object.keys(names).length ? { levelNames: names } : {}) };
        });
        if (hs.length || !partial) {
          st().mut((r) => {
            const keep = (r.hierarchies ?? []).filter((h) => h.table !== name || (partial && !hs.some((x) => x.name === h.name)));
            r.hierarchies = [...keep, ...hs];
            if (!r.hierarchies.length) delete r.hierarchies;
          });
          for (const h of hs) done.push(`gerarchia ${h.name}`);
        }
        // Incremental refresh policy
        const rp = n.children.find((c) => c.kind === 'refreshPolicy');
        if (rp) {
          const col = /\[([^\]]+)\]\s*>=?\s*RangeStart/.exec(rp.props.sourceExpression ?? '');
          const dc = [...(rp.props.pollingExpression ?? '').matchAll(/\[([^\]]+)\]/g)].pop();
          st().setRefreshPolicy(name, {
            table: name, column: col?.[1] ?? st().report.refreshPolicies?.find((p) => p.table === name)?.column ?? '',
            archive: { n: Number(rp.props.rollingWindowPeriods) || 1, unit: (rp.props.rollingWindowGranularity || 'year') as PolicyUnit },
            incremental: { n: Number(rp.props.incrementalPeriods) || 1, unit: (rp.props.incrementalGranularity || 'day') as PolicyUnit },
            ...(Number(rp.props.incrementalPeriodsOffset) < 0 ? { completeOnly: true } : {}),
            ...(rp.props.mode === 'hybrid' ? { realTime: true } : {}),
            ...(dc ? { detectChanges: dc[1] } : {}),
          });
          done.push(`aggiornamento incrementale ${name}`);
        } else if (!partial && st().report.refreshPolicies?.some((p) => p.table === name)) st().setRefreshPolicy(name, null);
      } else if (kind === 'relationship') {
        const [ft, fc] = splitRef(n.props.fromColumn ?? ''), [tt, tc] = splitRef(n.props.toColumn ?? '');
        const tables = st().tables;
        if (![[ft, fc], [tt, tc]].every(([t, c]) => tables.some((x) => x.name === t && x.columns.some((y) => y.name === c)))) { errors.push(`Relazione ${name}: colonne non trovate (${n.props.fromColumn} → ${n.props.toColumn}).`); continue; }
        const card: Cardinality = n.props.toCardinality === 'many' && n.props.fromCardinality !== 'one' ? 'manyToMany' : n.props.fromCardinality === 'one' ? 'oneToOne' : 'manyToOne';
        const rel: Omit<Relationship, 'id'> = { fromTable: ft, fromColumn: fc, toTable: tt, toColumn: tc, cardinality: card, crossFilter: n.props.crossFilteringBehavior === 'bothDirections' ? 'both' : 'single', active: n.props.isActive !== 'false',
          ...(n.props.securityFilteringBehavior === 'bothDirections' ? { securityBoth: true } : {}) };
        st().mut((r) => {
          const i = r.relationships.findIndex((x) => x.fromTable === ft && x.fromColumn === fc && x.toTable === tt && x.toColumn === tc);
          if (i >= 0) r.relationships[i] = { ...r.relationships[i], ...rel }; else r.relationships.push({ id: crypto.randomUUID(), ...rel });
        });
        done.push(`relazione ${ft}[${fc}] → ${tt}[${tc}]`);
      } else if (kind === 'role') {
        const perms = n.children.filter((c) => c.kind === 'tablePermission');
        const role: RoleDef = {
          name, filters: perms.filter((p) => (p.value ?? '').trim()).map((p) => ({ table: p.name!, expression: p.value! })),
        };
        const hidden = [...perms.filter((p) => p.props.metadataPermission === 'none').map((p) => p.name!), ...perms.flatMap((p) => p.children.filter((c) => c.kind === 'columnPermission' && c.props.metadataPermission === 'none').map((c) => `${p.name}\u0001${c.name}`))];
        if (hidden.length) role.hidden = hidden;
        await st().saveRoles([...(st().report.roles ?? []).filter((r) => r.name !== name), role]);
        done.push(`ruolo ${name}`);
      } else if (kind === 'perspective') {
        const fields = n.children.filter((t) => t.kind === 'perspectiveTable').flatMap((t) => t.children.map((x) => `${t.name}\u0001${x.name}`));
        st().setPerspectives([...(st().report.perspectives ?? []).filter((p) => p.name !== name), { name, fields }]);
        done.push(`prospettiva ${name}`);
      } else if (kind === 'expression') {
        const code = n.value ?? '';
        if (/IsParameterQuery\s*=\s*true/i.test(code)) {
          const p = paramFromM(name, code, n.description);
          st().mut((r) => { r.pqParams = [...(r.pqParams ?? []).filter((x) => x.name !== name), p]; });
          done.push(`parametro ${name}`);
        } else {
          st().mut((r) => { r.pqQueries = [...(r.pqQueries ?? []).filter((x) => x.name !== name), { name, code }]; });
          done.push(`query ${name}`);
        }
      } else if (kind === 'function') {
        st().mut((r) => { r.functions = [...(r.functions ?? []).filter((f) => f.name !== name), { name, expression: n.value ?? '', ...(n.description ? { description: n.description } : {}) }]; });
        done.push(`funzione ${name}`);
      } else if (kind) {
        errors.push(`${kind} ${name}: oggetto non supportato dalla Vista TMDL di MiB-BI.`);
      }
    } catch (e: any) {
      errors.push(`${kind} ${name}: ${e.message.split('\n')[0]}`);
    }
  }
  return { done, errors };
}
