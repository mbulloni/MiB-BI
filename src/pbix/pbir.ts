/**
 * Power BI enhanced report format (PBIR) → legacy Report/Layout JSON, so parseLayout() reads both.
 * PBIR keeps one JSON file per page (pages/<id>/page.json) and per visual
 * (pages/<id>/visuals/<id>/visual.json); field expressions already use SourceRef.Entity.
 * Bookmarks: bookmarks/bookmarks.json (order, groups) + bookmarks/<name>.bookmark.json (same state as legacy).
 */

type Files = Record<string, string>;

const parse = (s: string | undefined) => { try { return s ? JSON.parse(s) : undefined; } catch { return undefined; } };

/** queryState { Role: { projections: [{ field, queryRef, active }] } } → legacy projections + prototypeQuery. */
function convertQuery(query: any) {
  const projections: Record<string, { queryRef: string; active?: boolean; hidden?: boolean; nativeQueryRef?: string; format?: string }[]> = {};
  const select: any[] = [];
  const seen = new Set<string>();
  for (const [role, st] of Object.entries<any>(query?.queryState ?? {})) {
    for (const p of st?.projections ?? []) {
      const ref = p.queryRef ?? p.nativeQueryRef ?? JSON.stringify(p.field);
      (projections[role] ??= []).push({ queryRef: ref, ...(p.active ? { active: true } : {}), ...(p.hidden ? { hidden: true } : {}), ...(p.nativeQueryRef ? { nativeQueryRef: p.nativeQueryRef } : {}), ...(p.format ? { format: p.format } : {}) });
      if (!seen.has(ref) && p.field) { seen.add(ref); select.push({ ...p.field, Name: ref }); }
    }
  }
  const sort = query?.sortDefinition?.sort?.[0];
  return {
    projections,
    prototypeQuery: {
      Version: 2, From: [], Select: select,
      ...(sort?.field ? { OrderBy: [{ Direction: /asc/i.test(sort.direction ?? '') ? 1 : 2, Expression: sort.field }] } : {}),
    },
  };
}

/** PBIR bookmarks → legacy config.bookmarks (groups hold their bookmarks in `children`). */
function bookmarksOf(files: Files): any[] {
  const one = (name: string) => { const b = parse(files[`bookmarks/${name}.bookmark.json`]); if (!b) return null; const { $schema: _s, ...rest } = b; return rest; };
  const meta = parse(files['bookmarks/bookmarks.json']);
  const out: any[] = [];
  const used = new Set<string>();
  for (const it of meta?.items ?? []) {
    if (Array.isArray(it.children)) {
      const children = it.children.map((n: string) => { used.add(n); return one(n); }).filter(Boolean);
      out.push({ name: it.name, displayName: it.displayName ?? it.name, children });
    } else if (it.name) { used.add(it.name); const b = one(it.name); if (b) out.push(b); }
  }
  // Bookmark files not listed in bookmarks.json are kept too.
  for (const k of Object.keys(files)) {
    const m = /^bookmarks\/(.+)\.bookmark\.json$/.exec(k);
    if (m && !used.has(m[1])) { const b = one(m[1]); if (b) out.push(b); }
  }
  return out;
}

export function pbirToLayout(files: Files): string {
  const report = parse(files['report.json']) ?? {};
  const pagesMeta = parse(files['pages/pages.json']) ?? {};
  const pageIds = new Set<string>();
  for (const k of Object.keys(files)) {
    const m = /^pages\/([^/]+)\/page\.json$/.exec(k);
    if (m) pageIds.add(m[1]);
  }
  const order: string[] = (pagesMeta.pageOrder ?? []).filter((id: string) => pageIds.has(id));
  for (const id of pageIds) if (!order.includes(id)) order.push(id);

  const sections = order.map((id, ordinal) => {
    const page = parse(files[`pages/${id}/page.json`]) ?? {};
    const visualContainers = Object.keys(files)
      .filter((k) => k.startsWith(`pages/${id}/visuals/`) && k.endsWith('/visual.json'))
      .map((k) => parse(files[k]))
      .filter((v) => v?.visual || v?.visualGroup)
      // Folder order is arbitrary: keep the keyboard order (tabOrder), as in the legacy layout.
      .sort((a, b) => (a.position?.tabOrder ?? a.position?.z ?? 0) - (b.position?.tabOrder ?? b.position?.z ?? 0))
      .map((v) => {
        const pos = v.position ?? {};
        const pos0 = { x: pos.x ?? 0, y: pos.y ?? 0, z: pos.z ?? 0, width: pos.width ?? 200, height: pos.height ?? 150 };
        const parent = v.parentGroupName ? { parentGroupName: v.parentGroupName } : {};
        // Groups (Selection pane) and hidden visuals are kept: bookmarks show/hide them.
        if (!v.visual) {
          return { ...pos0, config: JSON.stringify({ name: v.name, ...parent, singleVisualGroup: { displayName: v.visualGroup.displayName ?? v.name, groupMode: 0, ...(v.isHidden ? { isHidden: true } : {}) } }), filters: '[]' };
        }
        const q = convertQuery(v.visual.query);
        // Mobile layout: visuals/<id>/mobile.json { position } → legacy layouts entry id 1.
        const mob = parse(files[`pages/${id}/visuals/${v.name}/mobile.json`])?.position;
        return {
          ...pos0,
          config: JSON.stringify({
            name: v.name,
            layouts: [{ id: 0, position: pos0 }, ...(mob ? [{ id: 1, position: mob }] : [])],
            ...parent,
            singleVisual: {
              visualType: v.visual.visualType,
              ...q,
              objects: v.visual.objects ?? {},
              vcObjects: v.visual.visualContainerObjects ?? {},
              ...(v.visual.syncGroup ? { syncGroup: v.visual.syncGroup } : {}),
              ...(v.isHidden ? { display: { mode: 'hidden' } } : {}),
            },
          }),
          filters: JSON.stringify(v.filterConfig?.filters ?? []),
        };
      });
    return {
      name: id, displayName: page.displayName ?? id, ordinal, width: page.width ?? 1280, height: page.height ?? 720,
      config: JSON.stringify({
        objects: page.objects ?? {}, ...(page.visibility === 'HiddenInViewMode' ? { visibility: 1 } : {}),
        ...(page.type === 'Tooltip' ? { type: 1 } : {}),
        // visualInteractions [{source, target, type: DataFilter|HighlightFilter|NoFilter}] = legacy relationships.
        ...(Array.isArray(page.visualInteractions) ? { relationships: page.visualInteractions } : {}),
        // Drill-through page: PBIR pageBinding has the legacy shape (parameters with fieldExpr).
        ...(page.pageBinding ? { pageBinding: { ...page.pageBinding, type: page.pageBinding.type === 'Drillthrough' || page.pageBinding.type === 0 ? 'Drillthrough' : page.pageBinding.type } } : {}),
      }),
      filters: JSON.stringify(page.filterConfig?.filters ?? []),
      visualContainers,
    };
  });
  const custom = report.themeCollection?.customTheme?.name;
  return JSON.stringify({
    sections,
    config: JSON.stringify({ themeCollection: custom ? { customTheme: { name: custom } } : {}, bookmarks: bookmarksOf(files) }),
    filters: JSON.stringify(report.filterConfig?.filters ?? []),
  });
}

/* ------------------------------- writer ------------------------------- */

const SCHEMA = 'https://developer.microsoft.com/json-schemas/fabric/item/report/definition/';
const V = { report: '3.2.0', page: '2.1.0', visual: '2.7.0', mobile: '2.4.0', pages: '1.1.0', bookmark: '2.1.0', bookmarks: '1.0.0', version: '1.0.0' };
const schema = (kind: string, v: string) => `${SCHEMA}${kind}/${v}/schema.json`;
const HOW_CREATED = ['Auto', 'User', 'Drill', 'Include', 'Exclude', 'Drillthrough'];
const INTERACTION = ['Default', 'DataFilter', 'HighlightFilter', 'NoFilter'];
const DISPLAY = ['DeprecatedDynamic', 'FitToPage', 'FitToWidth', 'ActualSize', 'ActualSizeTopLeft'];
/** Theme versions the custom theme was written for (PBIR ThemeVersion). */
const THEME_VERSION = { visual: '2.3.0', report: '3.0.0', page: '2.3.0' };
/** PBIR object names: word characters and hyphens only. */
export const pbirName = (s: string) => s.replace(/[^\w-]/g, '_').slice(0, 50) || 'x';

/** SourceRef.Source aliases of a legacy query → SourceRef.Entity (PBIR fields carry the entity). */
function entityRefs(x: any, from: Record<string, string>): any {
  if (Array.isArray(x)) return x.map((y) => entityRefs(y, from));
  if (!x || typeof x !== 'object') return x;
  if (x.SourceRef?.Source !== undefined && from[x.SourceRef.Source]) return { SourceRef: { Entity: from[x.SourceRef.Source] } };
  return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, entityRefs(v, from)]));
}

/** Legacy filter → PBIR FilterContainer (expression → field, numeric howCreated → name). */
function pbirFilter(f: any) {
  const howCreated = typeof f.howCreated === 'number' ? HOW_CREATED[f.howCreated] : f.howCreated;
  return {
    name: f.name ?? hex20(),
    ...(f.displayName ? { displayName: f.displayName } : {}),
    ...(f.ordinal !== undefined ? { ordinal: f.ordinal } : {}),
    ...(f.expression ?? f.field ? { field: f.expression ?? f.field } : {}),
    ...(f.type ? { type: f.type } : {}),
    ...(f.filter ? { filter: f.filter } : {}),
    ...(howCreated ? { howCreated } : {}),
    ...(f.isHiddenInViewMode ? { isHiddenInViewMode: true } : {}),
    ...(f.isLockedInViewMode ? { isLockedInViewMode: true } : {}),
    ...(f.objects ? { objects: f.objects } : {}),
  };
}
const filterConfig = (raw: unknown) => {
  const list = typeof raw === 'string' ? parse(raw) : raw;
  return Array.isArray(list) && list.length ? { filterConfig: { filters: list.map(pbirFilter) } } : {};
};
const hex20 = () => Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');

/** Legacy singleVisual (projections + prototypeQuery) → PBIR visual configuration. */
function pbirVisual(sv: any) {
  const pq = sv.prototypeQuery ?? {};
  const from: Record<string, string> = Object.fromEntries((pq.From ?? []).map((f: any) => [f.Name, f.Entity]));
  const byName = new Map<string, any>((pq.Select ?? []).map((s: any) => [s.Name, s]));
  const queryState: Record<string, any> = {};
  for (const [role, list] of Object.entries<any[]>(sv.projections ?? {})) {
    const projections = (list ?? []).map((p) => {
      const sel = byName.get(p.queryRef);
      if (!sel) return null;
      const { Name: _n, ...expr } = sel;
      return {
        field: entityRefs(expr, from), queryRef: p.queryRef,
        ...(p.nativeQueryRef ? { nativeQueryRef: p.nativeQueryRef } : {}),
        ...(p.displayName ? { displayName: p.displayName } : {}),
        ...(p.format ? { format: p.format } : {}),
        ...(p.active ? { active: true } : {}),
        ...(p.hidden ? { hidden: true } : {}),
      };
    }).filter(Boolean);
    if (projections.length) queryState[role] = { projections };
  }
  const sort = (pq.OrderBy ?? []).map((o: any) => ({ field: entityRefs(o.Expression, from), direction: o.Direction === 1 ? 'Ascending' : 'Descending' }));
  return {
    visualType: sv.visualType,
    ...(Object.keys(queryState).length || sort.length ? { query: { queryState, ...(sort.length ? { sortDefinition: { sort, isDefaultSort: false } } : {}) } } : {}),
    ...(sv.objects && Object.keys(sv.objects).length ? { objects: sv.objects } : {}),
    ...(sv.vcObjects && Object.keys(sv.vcObjects).length ? { visualContainerObjects: sv.vcObjects } : {}),
    ...(sv.syncGroup ? { syncGroup: sv.syncGroup } : {}),
    ...(sv.drillFilterOtherVisuals !== undefined ? { drillFilterOtherVisuals: !!sv.drillFilterOtherVisuals } : {}),
  };
}

/** Legacy bookmark → PBIR bookmark file content. */
function pbirBookmark(b: any) {
  return { $schema: schema('bookmark', V.bookmark), displayName: b.displayName ?? b.name, name: b.name, ...(b.options ? { options: b.options } : {}), explorationState: b.explorationState ?? {} };
}

/**
 * Legacy Report/Layout JSON → PBIR files (paths relative to the report folder's `definition/`).
 * `themeName` = the custom theme among the RegisteredResources.
 */
export function layoutToPbir(layoutJson: string, themeName?: string): Record<string, unknown> {
  const layout = JSON.parse(layoutJson);
  const config = parse(layout.config) ?? {};
  const out: Record<string, unknown> = {};
  out['version.json'] = { $schema: schema('versionMetadata', V.version), version: '2.0.0' };

  const pkgs = (layout.resourcePackages ?? []).map((r: any) => r.resourcePackage ?? r).filter((r: any) => r?.items?.length);
  const settings = config.settings ?? {};
  out['report.json'] = {
    $schema: schema('report', V.report),
    themeCollection: themeName ? { customTheme: { name: themeName, reportVersionAtImport: THEME_VERSION, type: 'RegisteredResources' } } : {},
    ...filterConfig(layout.filters),
    ...(config.objects && Object.keys(config.objects).length ? { objects: config.objects } : {}),
    ...(pkgs.length ? {
      resourcePackages: pkgs.map((r: any) => ({
        name: 'RegisteredResources', type: 'RegisteredResources',
        items: r.items.map((i: any) => ({ name: i.name, path: i.path, type: i.type === 202 || i.path === themeName ? 'CustomTheme' : 'Image' })),
      })),
    } : {}),
    settings: {
      allowChangeFilterTypes: settings.allowChangeFilterTypes !== false,
      ...(settings.defaultFilterActionIsDataFilter ? { defaultFilterActionIsDataFilter: true } : {}),
      ...(config.defaultDrillFilterOtherVisuals !== false ? { defaultDrillFilterOtherVisuals: true } : {}),
    },
  };

  const sections: any[] = [...(layout.sections ?? [])].sort((a, b) => (a.ordinal ?? 0) - (b.ordinal ?? 0));
  out['pages/pages.json'] = {
    $schema: schema('pagesMetadata', V.pages),
    pageOrder: sections.map((s) => pbirName(s.name)),
    ...(sections.length ? { activePageName: pbirName(sections[Math.min(config.activeSectionIndex ?? 0, sections.length - 1)].name) } : {}),
  };
  for (const s of sections) {
    const name = pbirName(s.name);
    const cfg = parse(s.config) ?? {};
    const pb = cfg.pageBinding;
    out[`pages/${name}/page.json`] = {
      $schema: schema('page', V.page),
      name, displayName: s.displayName ?? name,
      displayOption: typeof s.displayOption === 'number' ? DISPLAY[s.displayOption] ?? 'FitToPage' : s.displayOption ?? 'FitToPage',
      height: s.height ?? 720, width: s.width ?? 1280,
      ...filterConfig(s.filters),
      ...(pb ? {
        pageBinding: {
          name: pb.name, type: pb.type === 'Drillthrough' || pb.type === 0 ? 'Drillthrough' : pb.type === 1 || pb.type === 'Tooltip' ? 'Tooltip' : pb.type,
          ...(pb.parameters?.length ? { parameters: pb.parameters } : {}),
          ...(pb.acceptsFilterContext === 1 ? { acceptsFilterContext: 'Default' } : {}),
        },
      } : {}),
      ...(cfg.objects && Object.keys(cfg.objects).length ? { objects: cfg.objects } : {}),
      ...(cfg.type === 1 ? { type: 'Tooltip' } : pb?.type === 'Drillthrough' ? { type: 'Drillthrough' } : {}),
      ...(cfg.visibility === 1 ? { visibility: 'HiddenInViewMode' } : {}),
      ...(cfg.relationships?.length ? {
        visualInteractions: cfg.relationships.map((r: any) => ({ source: pbirName(r.source), target: pbirName(r.target), type: typeof r.type === 'number' ? INTERACTION[r.type] ?? 'Default' : r.type })),
      } : {}),
    };
    for (const c of s.visualContainers ?? []) {
      const vc = parse(c.config) ?? {};
      const vname = pbirName(vc.name ?? hex20());
      const lay = vc.layouts?.find((l: any) => l.id === 0)?.position;
      const position = { x: lay?.x ?? c.x ?? 0, y: lay?.y ?? c.y ?? 0, z: lay?.z ?? c.z ?? 0, height: lay?.height ?? c.height ?? 150, width: lay?.width ?? c.width ?? 200, ...(lay?.tabOrder !== undefined ? { tabOrder: lay.tabOrder } : {}) };
      const base = { $schema: schema('visualContainer', V.visual), name: vname, position, ...(vc.parentGroupName ? { parentGroupName: pbirName(vc.parentGroupName) } : {}) };
      if (vc.singleVisualGroup) {
        const g = vc.singleVisualGroup;
        out[`pages/${name}/visuals/${vname}/visual.json`] = { ...base, visualGroup: { displayName: g.displayName ?? vname, groupMode: 'ScaleMode' }, ...(g.isHidden ? { isHidden: true } : {}) };
        continue;
      }
      if (!vc.singleVisual) continue;
      out[`pages/${name}/visuals/${vname}/visual.json`] = {
        ...base,
        visual: pbirVisual(vc.singleVisual),
        ...filterConfig(c.filters),
        ...(vc.singleVisual.display?.mode === 'hidden' ? { isHidden: true } : {}),
      };
      const mob = vc.layouts?.find((l: any) => l.id === 1)?.position;
      if (mob) out[`pages/${name}/visuals/${vname}/mobile.json`] = { $schema: schema('visualContainerMobileState', V.mobile), position: mob };
    }
  }

  const bookmarks: any[] = config.bookmarks ?? [];
  if (bookmarks.length) {
    out['bookmarks/bookmarks.json'] = {
      $schema: schema('bookmarksMetadata', V.bookmarks),
      items: bookmarks.map((b) => (b.children ? { name: b.name, displayName: b.displayName ?? b.name, children: b.children.map((c: any) => c.name) } : { name: b.name })),
    };
    for (const b of bookmarks.flatMap((x) => x.children ?? [x])) out[`bookmarks/${pbirName(b.name)}.bookmark.json`] = pbirBookmark(b);
  }
  return out;
}
