// Interface language (Opzioni › Impostazioni internazionali › Lingua dell'applicazione).
// The UI is written in Italian; English comes from a dictionary keyed by the Italian text (src/i18n/en.json:
// exact strings + patterns where {} stands for a dynamic part). Instead of wrapping every string, the rendered
// DOM is translated: text nodes and the title/placeholder/aria-label attributes, kept in sync with a
// MutationObserver. Two-line labels ("Nuova<br />misura") are looked up as one phrase. Text the user types
// (inputs, textareas, editable boxes) and code views are never touched. Canvas text (charts) goes through tr().
import EN from './i18n/en.json';

export type UiLang = 'it' | 'en';
let LANG: UiLang = 'it';
export const uiLang = () => LANG;

const DICT = EN as unknown as { exact: Record<string, string>; patterns: [string, string][] };
const exact = new Map<string, string>(Object.entries(DICT.exact));
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = DICT.patterns.map(([it, en]) => ({
  re: new RegExp('^' + esc(it).split('\\{\\}').join('([\\s\\S]+?)') + '$'),
  en,
}));

/** English for an Italian UI string (whitespace kept); the string itself when unknown or in Italian mode. */
export function tr(s: string): string {
  if (LANG === 'it' || !s) return s;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s)!;
  const core = m[2];
  if (!core) return s;
  let out = exact.get(core);
  if (out === undefined && core.length < 400) {
    for (const p of patterns) {
      const g = p.re.exec(core);
      if (!g) continue;
      let i = 1;
      // Dynamic parts can be UI words themselves ("Calendario {}: {}"): translate them too.
      out = p.en.replace(/\{\}/g, () => tr(g[i++] ?? ''));
      break;
    }
  }
  return out === undefined ? s : m[1] + out + m[3];
}

/** Connective words used when building titles ("Somma di Vendite per Paese e Anno"). */
export const words = () => (LANG === 'en' ? { by: 'by', and: 'and' } : { by: 'per', and: 'e' });

/* ------------------------------- DOM translation ------------------------------- */

const ATTRS = ['title', 'placeholder', 'aria-label'] as const;
const SKIP = 'textarea, script, style, pre, code, [contenteditable="true"], [data-no-i18n], .monaco-editor';
/** Original (Italian) text of the nodes and attributes we translated, and what we wrote. */
const origText = new WeakMap<Text, { it: string; en: string }>();
const origAttr = new WeakMap<Element, Record<string, { it: string; en: string }>>();
let observer: MutationObserver | null = null;

const skipped = (n: Node) => {
  const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
  return !el || !!el.closest(SKIP);
};

/** Two-line labels: the text nodes of an element that holds text and <br> (plus text-less icons, like a dropdown chevron). */
function splitLabel(t: Text): Text[] | null {
  const p = t.parentElement;
  if (!p || !p.querySelector(':scope > br')) return null;
  const nodes = [...p.childNodes];
  if (!nodes.every((c) => c.nodeType === Node.TEXT_NODE || (c as Element).tagName === 'BR' || !(c as Element).textContent?.trim())) return null;
  // Lines we emptied (one-word translation) still belong to the label.
  return nodes.filter((c): c is Text => c.nodeType === Node.TEXT_NODE && (!!c.nodeValue?.trim() || origText.has(c as Text)));
}

/** Safety net: a node rewritten over and over (a layout that flips between languages) is left alone. */
const writes = new WeakMap<Node, number>();
let resetQueued = false;
function tooMany(n: Node) {
  const c = (writes.get(n) ?? 0) + 1;
  writes.set(n, c);
  if (!resetQueued) { resetQueued = true; setTimeout(() => { resetQueued = false; touched.forEach((x) => writes.delete(x)); touched.clear(); }, 1000); }
  touched.add(n);
  return c > 20;
}
const touched = new Set<Node>();

function setText(t: Text, en: string, it: string) {
  origText.set(t, { it, en });
  if (t.nodeValue !== en && !tooMany(t)) t.nodeValue = en;
}

function translateText(t: Text) {
  const cur = t.nodeValue ?? '';
  const known = origText.get(t);
  // React rewrote the node since we translated it: start again from its new (Italian) value.
  const it = known && known.en === cur ? known.it : cur;
  if (LANG === 'it') { if (known && known.en === cur && cur !== it) t.nodeValue = it; origText.delete(t); return; }
  // Same Italian word, different English in this place (data-en on the element).
  const own = t.parentElement?.getAttribute('data-en');
  if (own) { setText(t, own, it); return; }
  const parts = splitLabel(t);
  if (parts && parts.length > 1 && parts.includes(t)) {
    // The whole label is one phrase; its lines are rewritten together.
    const its = parts.map((x) => { const k = origText.get(x); return k && k.en === x.nodeValue ? k.it : x.nodeValue ?? ''; });
    const en = exact.get(its.map((x) => x.trim()).join(' '));
    if (!en) { parts.forEach((x, k) => setText(x, tr(its[k]), its[k])); return; }
    const w = en.split(' ');
    const cut = Math.ceil(w.length / 2);
    const lines = parts.length === 2 ? [w.slice(0, cut).join(' '), w.slice(cut).join(' ')] : [en, ...parts.slice(1).map(() => '')];
    parts.forEach((x, k) => setText(x, lines[k] || '', its[k]));
    return;
  }
  const en = tr(it);
  if (en !== it || known) setText(t, en, it);
}

function translateAttrs(el: Element) {
  let rec = origAttr.get(el);
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (cur === null) continue;
    const known = rec?.[a];
    const it = known && known.en === cur ? known.it : cur;
    if (LANG === 'it') { if (known && known.en === cur) el.setAttribute(a, it); if (rec) delete rec[a]; continue; }
    const en = tr(it);
    if (en === it && !known) continue;
    rec ??= {};
    rec[a] = { it, en };
    origAttr.set(el, rec);
    if (cur !== en) el.setAttribute(a, en);
  }
}

function walk(root: Node) {
  if (skipped(root)) return;
  if (root.nodeType === Node.TEXT_NODE) { translateText(root as Text); return; }
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  translateAttrs(root as Element);
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) translateText(n as Text); else translateAttrs(n as Element);
  }
}

/** Sets the interface language and (re)translates the page; the observer keeps new content translated. */
export function setUiLang(lang: UiLang) {
  LANG = lang;
  document.documentElement.lang = lang;
  if (!observer) {
    observer = new MutationObserver((list) => {
      if (LANG === 'it') return;
      for (const m of list) {
        if (m.type === 'characterData') { if (!skipped(m.target)) translateText(m.target as Text); }
        else if (m.type === 'attributes') { if (!skipped(m.target)) translateAttrs(m.target as Element); }
        else m.addedNodes.forEach(walk);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] });
  }
  walk(document.body);
}
