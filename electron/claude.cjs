// "Domande e risposte" with Claude: turns a natural-language question into a visual spec (JSON),
// given the model schema (tables, columns, types, measures, a few sample values) - never the data rows.
// API key: Impostazioni (encrypted with safeStorage in userData/claude.json) or the SDK's own resolution
// (ANTHROPIC_API_KEY, ...). ANTHROPIC_BASE_URL redirects to a mock server in tests.
const fs = require('fs');
const path = require('path');
const { app, safeStorage } = require('electron');
const Anthropic = require('@anthropic-ai/sdk').default;

const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
const cfgFile = () => path.join(app.getPath('userData'), 'claude.json');
const load = () => { try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; } };
const save = (cfg) => fs.writeFileSync(cfgFile(), JSON.stringify(cfg, null, 2), { mode: 0o600 });

function apiKey() {
  const enc = load().key;
  if (enc && safeStorage.isEncryptionAvailable()) { try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); } catch { /* re-enter */ } }
  return process.env.ANTHROPIC_API_KEY || null;
}

function status() {
  const cfg = load();
  return { configured: !!apiKey(), fromEnv: !cfg.key && !!process.env.ANTHROPIC_API_KEY, model: MODELS.includes(cfg.model) ? cfg.model : MODELS[0], models: MODELS, persistent: safeStorage.isEncryptionAvailable() };
}

function configure(key, model) {
  const cfg = load();
  if (typeof key === 'string') {
    if (!key.trim()) delete cfg.key;
    else {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Portachiavi di sistema non disponibile: impostare la variabile ANTHROPIC_API_KEY.');
      cfg.key = safeStorage.encryptString(key.trim()).toString('base64');
    }
  }
  if (MODELS.includes(model)) cfg.model = model;
  save(cfg);
  return status();
}

const VISUALS = ['card', 'clusteredBar', 'clusteredColumn', 'stackedColumn', 'line', 'area', 'pie', 'donut', 'treemap', 'table', 'matrix', 'scatter', 'map', 'filledMap', 'funnel'];
const WELLS = ['category', 'values', 'legend', 'x', 'y', 'columns', 'rows', 'details'];
const AGGS = ['none', 'sum', 'avg', 'min', 'max', 'count', 'countd', 'median', 'measure'];

// Strict JSON schema of the answer (structured outputs).
const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answerable', 'visual', 'fields', 'filters', 'topN', 'sortAscending', 'title', 'restatement'],
  properties: {
    answerable: { type: 'boolean', description: 'false when the question cannot be answered with this model' },
    visual: { type: 'string', enum: VISUALS },
    fields: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['well', 'table', 'column', 'agg'],
        properties: { well: { type: 'string', enum: WELLS }, table: { type: 'string' }, column: { type: 'string' }, agg: { type: 'string', enum: AGGS } },
      },
    },
    filters: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['table', 'column', 'values'],
        properties: { table: { type: 'string' }, column: { type: 'string' }, values: { type: 'array', items: { type: 'string' } } },
      },
    },
    topN: { type: ['integer', 'null'] },
    sortAscending: { type: ['boolean', 'null'] },
    title: { type: 'string' },
    restatement: { type: 'string', description: 'the question as understood, in Italian, one short sentence' },
  },
};

const SYSTEM = `You translate questions about a Power BI-style data model into a visual specification for MiB-BI.
Use only tables, columns and measures that exist in the schema the user message gives, spelled exactly as written there.
Wells by visual: card: values (one field). clusteredBar/clusteredColumn/stackedColumn/line/area: category (one field), values (one or more measures), legend (optional, one field). pie/donut/treemap/funnel: category, values (one). table: columns (any fields, numeric ones aggregated). matrix: rows, columns (one), values. scatter: details, x, y. map/filledMap: category (a geographic column such as country, region, province or city), values (one).
agg: "measure" for model measures (table = the measure's home table, column = the measure name); otherwise how a column is summarized ("none" for grouping fields). Prefer existing measures over aggregating raw columns when they mean the same thing.
Filters keep only the listed values (use values exactly as they appear in the data; sample values are given for text columns). Use topN for "top 5", "i primi 10" and similar, with sortAscending true for "bottom"/"peggiori".
Choose the visual the way Power BI Q&A does: a single number → card; over time → line; by a geographic field → map; by a category → clusteredBar; several fields without a measure → table. Follow an explicitly requested visual type.
Set answerable to false (and leave fields empty) when the question is not about this data.`;

/** One structured-output request: `schema` constrains the JSON answer. Errors become Italian messages. */
async function structured(system, content, schema) {
  const st = status();
  const key = apiKey();
  if (!key) throw new Error('Configurare la chiave API di Anthropic (Opzioni › Domande e risposte).');
  const client = new Anthropic({ apiKey: key });
  let response;
  try {
    const haiku = st.model.startsWith('claude-haiku');
    response = await client.beta.messages.create({
      model: st.model,
      max_tokens: 16000,
      // Server-side fallback on a safety decline (not offered for Haiku 4.5, which also has no effort setting).
      ...(haiku ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
      // Short, well-specified tasks: low effort keeps answers fast and cheap.
      output_config: { ...(haiku ? {} : { effort: 'low' }), format: { type: 'json_schema', schema } },
      cache_control: { type: 'ephemeral' },
      system,
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new Error('Chiave API non valida.');
    if (e instanceof Anthropic.RateLimitError) throw new Error('Limite di richieste raggiunto: riprovare tra poco.');
    if (e instanceof Anthropic.APIConnectionError) throw new Error('Impossibile contattare Anthropic: verificare la connessione.');
    if (e instanceof Anthropic.APIError) throw new Error(`Errore dell'API Anthropic (${e.status ?? '?'}): ${e.message}`);
    throw e;
  }
  if (response.stop_reason === 'refusal') throw new Error('Claude ha rifiutato la richiesta.');
  if (response.stop_reason === 'max_tokens') throw new Error('Risposta di Claude incompleta.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let json;
  try { json = JSON.parse(text); } catch { throw new Error('Risposta di Claude non valida.'); }
  return { json, model: response.model, usage: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0 } };
}

async function ask(question, schemaText) {
  const { json, model, usage } = await structured(SYSTEM, `Data model schema:\n${schemaText}\n\nQuestion: ${question}`, SPEC_SCHEMA);
  return { spec: json, model, usage };
}

// Traduzioni del modello: display names of tables, columns, measures and hierarchies for one culture.
const TRANSLATE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['translations'],
  properties: {
    translations: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } },
    },
  },
};
const TRANSLATE_SYSTEM = `You translate the display names (captions) of objects in a Power BI semantic model into the target culture.
Names are business terms shown to report readers: translate their meaning, keep them short, keep acronyms, codes and product or company names unchanged, and use the capitalization conventions of the target language.
The hint after each name says what the object is (table, column of a table, measure, hierarchy) to disambiguate the meaning.
Return one translation for every id you receive, with the same id.`;

/** items: [{ id, name, hint }] → { [id]: translated name } for `culture` (BCP 47, e.g. en-US). */
async function translate(items, culture) {
  const lines = items.map((i) => `${i.id}\t${i.name}\t(${i.hint})`).join('\n');
  const { json } = await structured(TRANSLATE_SYSTEM, `Target culture: ${culture}\n\nid\tname\thint\n${lines}`, TRANSLATE_SCHEMA);
  return Object.fromEntries((json.translations ?? []).filter((t) => t && typeof t.id === 'string' && typeof t.text === 'string' && t.text.trim()).map((t) => [t.id, t.text.trim()]));
}

module.exports = { status, configure, ask, translate };
