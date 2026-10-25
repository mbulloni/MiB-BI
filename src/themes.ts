/** Report themes: Power BI theme JSON (colors, textClasses, visualStyles), resolved into THEME for the renderers. */
import type { Theme, ThemeText } from './types';
import { PALETTE } from './format';
import { STYLE_THEME, decode } from './visuals/pbistyle';

const DEFAULT_COLORS = [...PALETTE];

export const THEMES: Theme[] = [
  { name: 'Predefinito', dataColors: DEFAULT_COLORS },
  { name: 'Classico', dataColors: ['#01B8AA', '#374649', '#FD625E', '#F2C80F', '#5F6B6D', '#8AD4EB', '#FE9666', '#A66999', '#3599B8', '#DFBFBF'] },
  { name: 'Innovazione', dataColors: ['#E8D166', '#E12F21', '#D88445', '#8E56C2', '#4B4BB0', '#48A6C8', '#53BF9B', '#A6BC5A', '#C93F7C', '#7A7A7A'], background: '#FCFCFC' },
  { name: 'Frontiera', dataColors: ['#936846', '#4A6971', '#A9C7BD', '#C5A572', '#7F2B26', '#C27B7B', '#6A6A9E', '#9DB5B6', '#BB8C5D', '#565656'] },
  { name: 'Tramonto', dataColors: ['#B3456E', '#E05C74', '#F88E73', '#F3BD7E', '#C1D592', '#8BC6A6', '#55A7AB', '#428593', '#8D5584', '#D07A8F'] },
  { name: 'Elettrico', dataColors: ['#D4B60A', '#3BBFC7', '#F29F05', '#F2385A', '#7D57C2', '#51BD69', '#2D6FE0', '#E14FA0', '#8C8C8C', '#24A3A3'] },
  { name: 'Tempesta', dataColors: ['#26457D', '#4D7CB5', '#7BA7D6', '#A4C8EA', '#5F6A75', '#8E99A4', '#C0C7CE', '#3F8FA3', '#68B5BF', '#B4DCE0'], background: '#F7F9FC' },
  { name: 'Sicuro per daltonici', dataColors: ['#074650', '#009292', '#FE6DB6', '#FEB5DA', '#480091', '#B66DFF', '#B5DAFE', '#6DB6FF', '#914800', '#23FD23'] },
  {
    name: 'Notte', dataColors: ['#3AA0FF', '#FF8A3D', '#B66DFF', '#FFD23F', '#2EC4B6', '#FF5D8F', '#9CCC65', '#64B5F6', '#F06292', '#BDBDBD'],
    background: '#252526', foreground: '#F3F2F1', tableAccent: '#3AA0FF',
    textClasses: { label: { color: '#E1DFDD' }, title: { color: '#F3F2F1' }, callout: { color: '#FFFFFF' }, header: { color: '#F3F2F1' } },
    visualStyles: { page: { '*': { background: [{ color: { solid: { color: '#1B1A19' } }, transparency: 0 }], outspace: [{ color: { solid: { color: '#11100F' } } }] } } },
  },
];

/** Power BI defaults (CY24SU10): text classes in pt, sentiment and divergent colors. */
export const TEXT_DEFAULTS: Record<TextClass, Required<Pick<ThemeText, 'fontFace' | 'fontSize' | 'color'>>> = {
  label: { fontFace: 'Segoe UI', fontSize: 9, color: '#252423' },
  title: { fontFace: 'Segoe UI Semibold', fontSize: 12, color: '#252423' },
  callout: { fontFace: 'DIN', fontSize: 45, color: '#252423' },
  header: { fontFace: 'Segoe UI Semibold', fontSize: 12, color: '#252423' },
};
export type TextClass = 'label' | 'title' | 'callout' | 'header';
export const SENTIMENT_DEFAULTS = { good: '#1AAB40', neutral: '#D9B300', bad: '#D64554', maximum: '#118DFF', center: '#D9B300', minimum: '#DEEFFF' };

/** Font stack for a theme font face (Segoe UI is missing on Linux: fall back to similar fonts). */
export const fontStack = (face?: string) => `'${(face ?? 'Segoe UI').replace(/'/g, '')}', 'Segoe UI', 'Selawik', 'Ubuntu Sans', sans-serif`;
const fontWeight = (face?: string) => (/semibold/i.test(face ?? '') ? 600 : /bold/i.test(face ?? '') ? 700 : undefined);

interface TextStyle { font: string; weight?: number; size: number; color: string }

/** Values the renderers read: page and visual look, text classes (px), sentiment/divergent colors, filter pane. */
export const THEME = {
  /** Page canvas. */
  background: '#FFFFFF',
  /** Area outside the page (Sfondo area di disegno). */
  outspace: undefined as string | undefined,
  pageTransparency: 0,
  visualBg: '#FFFFFF',
  visualBgTransparency: 0,
  border: false,
  borderColor: '#C8C6C4',
  borderRadius: 0,
  text: {} as Record<TextClass, TextStyle>,
  /** Only what the theme sets (foreground counts as color): renderers keep their own defaults otherwise. */
  textSet: {} as Record<TextClass, Partial<TextStyle>>,
  /** Chart axes/legends and data labels (Power BI greys unless the theme sets label color/size). */
  axis: { color: '#605E5C', size: 11 },
  dataLabel: { color: '#252423', size: 10 },
  ...SENTIMENT_DEFAULTS,
  /** visualTooltip / visualHeader colors (undefined = defaults). */
  tooltip: {} as { background?: string; title?: string; value?: string },
  header: {} as { background?: string; foreground?: string },
  /** Riquadro filtri (outspacePane / filterCard): undefined = app chrome colors. */
  filterPane: {} as { background?: string; foreground?: string; transparency?: number; cardApplied?: string; cardAvailable?: string; font?: string },
};

/** visualStyles[type]['*'][obj][0][prop] (falling back to '*'), decoded (colors as #RRGGBB). */
export function themeStyle(t: Theme | undefined, type: string, obj: string, prop: string, id?: string): any {
  const vs = t?.visualStyles;
  if (!vs) return undefined;
  for (const k of [type, '*']) {
    const list = vs[k]?.['*']?.[obj];
    const e = id ? list?.find((x: any) => x.$id === id) : list?.[0];
    const v = e?.[prop];
    if (v !== undefined) return decode(v);
  }
  return undefined;
}

/** Writes visualStyles[type]['*'][obj] properties (undefined removes one; empty objects are dropped). */
export function setThemeStyle(t: Theme, type: string, obj: string, props: Record<string, unknown>, id?: string): Theme {
  const vs = structuredClone(t.visualStyles ?? {});
  const list: any[] = ((vs[type] ??= {})['*'] ??= {})[obj] ??= [];
  let e = id ? list.find((x) => x.$id === id) : list.find((x) => !x.$id);
  if (!e) { e = id ? { $id: id } : {}; list.push(e); }
  for (const [k, v] of Object.entries(props)) if (v === undefined) delete e[k]; else e[k] = v;
  if (Object.keys(e).filter((k) => k !== '$id').length === 0) list.splice(list.indexOf(e), 1);
  if (!list.length) delete vs[type]['*'][obj];
  if (!Object.keys(vs[type]['*']).length) delete vs[type];
  return { ...t, visualStyles: Object.keys(vs).length ? vs : undefined };
}

/** Applies a theme to the shared palette and THEME (mutated in place: renderers import them). */
export function applyTheme(t?: Theme) {
  const colors = t?.dataColors?.length ? t.dataColors : DEFAULT_COLORS;
  PALETTE.splice(0, PALETTE.length, ...Array.from({ length: Math.max(16, colors.length) }, (_, i) => colors[i % colors.length]));
  STYLE_THEME.theme = t;
  const st = (type: string, obj: string, prop: string, id?: string) => themeStyle(t, type, obj, prop, id);
  THEME.background = st('page', 'background', 'color') ?? t?.background ?? '#FFFFFF';
  THEME.pageTransparency = st('page', 'background', 'transparency') ?? 0;
  THEME.outspace = st('page', 'outspace', 'color');
  THEME.visualBg = st('*', 'background', 'color') ?? t?.background ?? '#FFFFFF';
  THEME.visualBgTransparency = st('*', 'background', 'transparency') ?? 0;
  THEME.border = st('*', 'border', 'show') ?? false;
  THEME.borderColor = st('*', 'border', 'color') ?? '#C8C6C4';
  THEME.borderRadius = st('*', 'border', 'radius') ?? 0;
  for (const k of Object.keys(TEXT_DEFAULTS) as TextClass[]) {
    // foreground recolors every text class unless the class sets its own color.
    const c = { ...TEXT_DEFAULTS[k], ...(t?.foreground ? { color: t.foreground } : {}), ...(t?.textClasses?.[k] ?? {}) };
    const own = t?.textClasses?.[k];
    const color = own?.color ?? t?.foreground;
    THEME.textSet[k] = { ...(color ? { color } : {}), ...(own?.fontSize ? { size: Math.round(own.fontSize * 4 / 3 * 10) / 10 } : {}), ...(own?.fontFace ? { font: fontStack(own.fontFace), weight: fontWeight(own.fontFace) } : {}) };
    THEME.text[k] = { font: fontStack(c.fontFace), weight: fontWeight(c.fontFace), size: Math.round(c.fontSize * 4 / 3 * 10) / 10, color: c.color };
  }
  const lc = t?.textClasses?.label?.color ?? t?.foreground, ls = t?.textClasses?.label?.fontSize;
  THEME.axis = { color: lc ?? '#605E5C', size: ls ? Math.round(ls * 4 / 3) : 11 };
  THEME.dataLabel = { color: lc ?? '#252423', size: ls ? Math.round(ls * 4 / 3) - 1 : 10 };
  for (const k of Object.keys(SENTIMENT_DEFAULTS) as (keyof typeof SENTIMENT_DEFAULTS)[]) THEME[k] = (t?.[k] as string | undefined) ?? SENTIMENT_DEFAULTS[k];
  THEME.tooltip = { background: st('*', 'visualTooltip', 'background'), title: st('*', 'visualTooltip', 'titleFontColor'), value: st('*', 'visualTooltip', 'valueFontColor') };
  THEME.header = { background: st('*', 'visualHeader', 'background'), foreground: st('*', 'visualHeader', 'foreground') };
  THEME.filterPane = {
    background: st('*', 'outspacePane', 'backgroundColor'), foreground: st('*', 'outspacePane', 'foregroundColor'),
    transparency: st('*', 'outspacePane', 'transparency'), font: st('*', 'outspacePane', 'fontFamily'),
    cardApplied: st('*', 'filterCard', 'backgroundColor', 'Applied'), cardAvailable: st('*', 'filterCard', 'backgroundColor', 'Available'),
  };
}
applyTheme();

/** Validates an imported Power BI theme file; every key is kept (written back on export). */
export function parseTheme(json: string, fallbackName: string): Theme {
  const j = JSON.parse(json);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('il file non contiene un oggetto JSON');
  const hex = (x: unknown) => typeof x === 'string' && /^#[0-9a-f]{3,8}$/i.test(x);
  const dataColors = Array.isArray(j.dataColors) ? j.dataColors.filter(hex) : [];
  if (!dataColors.length) throw new Error('il file non contiene "dataColors"');
  return { ...j, name: typeof j.name === 'string' && j.name ? j.name : fallbackName, dataColors };
}

/** Power BI theme JSON for export / custom theme resource (name first, then every other key). */
export const themeJson = (t: Theme) => {
  const { name, dataColors, ...rest } = t;
  const clean = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  return JSON.stringify({ name, dataColors, ...clean }, null, 2);
};
