// Opzioni › Globale: per-user settings kept in the renderer's localStorage (not in reports).
export interface GlobalOptions {
  /** Caricamento dati › Rileva automaticamente le nuove relazioni dopo il caricamento dei dati. */
  autoRelationships: boolean;
  /** Impostazioni internazionali › separatori DAX locali (";" tra gli argomenti, "," decimale) invece di quelli standard. */
  daxLocalSeparators?: boolean;
  /** Impostazioni internazionali › formato di numeri e date negli oggetti visivi (BCP 47, es. it-IT). */
  locale?: string;
  /** Tema dell'interfaccia: chiaro, scuro o come il sistema (il report mantiene il proprio tema). */
  appTheme?: 'light' | 'dark' | 'system';
  /** Lingua dell'applicazione (interfaccia): italiano o inglese. */
  uiLang?: 'it' | 'en';
  /** Progetti di Power BI (.pbip): report nel formato avanzato PBIR (cartella definition/) invece di report.json. */
  pbir?: boolean;
  /** Progetti di Power BI (.pbip): modello semantico in TMDL (cartella definition/) invece di model.bim. */
  tmdl?: boolean;
}

const KEY = 'mib-bi.options';
const DEFAULTS: GlobalOptions = { autoRelationships: true, locale: 'it-IT', pbir: true, tmdl: true };

export function globalOptions(): GlobalOptions {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { return { ...DEFAULTS }; }
}

export function setGlobalOptions(patch: Partial<GlobalOptions>): GlobalOptions {
  const next = { ...globalOptions(), ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  return next;
}
