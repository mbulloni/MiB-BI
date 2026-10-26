import { applyTmdl } from './tmdlApply';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';
import { setLocale } from './format';
import { globalOptions } from './options';
import { initAppTheme } from './appTheme';

import { setUiLang } from './i18n';
import { api } from './api';

setLocale(globalOptions().locale ?? 'it-IT');
initAppTheme();

createRoot(document.getElementById('root')!).render(<App />);
if (globalOptions().uiLang === 'en') { setUiLang('en'); api.win.setLang('en'); }

// Exposed for scripted smoke tests (see MIBBI_SCRIPT in electron/main.cjs).
import { useStore } from './store';
(window as any).__mibbi = useStore;
import { buildVisualQuery } from './query';
(window as any).__mibbiQuery = buildVisualQuery;
import { compileQuery } from './pq/compile';
import { inlineFromM, mToQuery, mToSteps } from './pq/mparse';
import { mToSql } from './pq/mexpr';
import { queryM } from './pbix/pbit';
import { TPL as QM_TPL } from './components/QuickMeasure';
(window as any).__mibbiQM = QM_TPL;
(window as any).__mibbiPQ = { compileQuery, mToSql, queryM, mToSteps, mToQuery, inlineFromM };
import * as dax from './dax';
(window as any).__mibbiDax = dax;
import { runVisualQuery, runVisualWithCalcs } from './visuals/useVisualData';
(window as any).__mibbiRun = runVisualQuery;
(window as any).__mibbiCalc = runVisualWithCalcs;
import { filterSql, relativePeriod, slicerSpec, underlyingQuery } from './query';
import { interactionOf } from './visuals/interactions';
(window as any).__mibbiQ = { filterSql, relativePeriod, slicerSpec, underlyingQuery, interactionOf };
import { buildLayout, parseLayout } from './pbix/layout';
(window as any).__mibbiLayout = { buildLayout, parseLayout };
(window as any).__mibbiLang = setUiLang;
import { evaluateM } from './pq/m/host';
(window as any).__mibbiM = { evaluateM };
(window as any).__mibbiTmdl = { applyTmdl };
