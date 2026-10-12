/**
 * Get cards view (`#/fetch`, spec §8.4 "Get cards", §9.6, §13.3).
 *
 * - Game picker: searchable tiles from the catalog ∪ the introspected plugins. Plugins that are
 *   broken upstream (catalog `status: 'broken'`), missing from this engine version or failing to
 *   load are flagged and cannot be selected.
 * - Deck list: format select (description, "How to get this list", "Insert example", warnings) and
 *   a source that follows the format's input kind:
 *     file        → "Paste list" (+ deck name) | "Saved lists" (inline edit + save) | "Choose a file…"
 *     url         → web address checked against the format's pattern
 *     text_inline → one-line code (Elestrals: the 24-character id is picked out of a pasted link)
 * - Plugin options from the catalog (casual ones visible, advanced under "More options"); plugins
 *   unknown to the catalog fall back to their introspected parameters.
 * - Every choice is remembered in settings.fetch.
 * - "Start fresh", the Download button, live progress from the store's `job`, and a result card
 *   (store `lastResults.fetch`) with failed cards (Copy names / Edit list), unrecognized lines,
 *   "Put back the previous cards" and the recommended PDF settings with Apply.
 *
 * Pure helpers (request building, result summaries, PDF recommendation differences) are exported
 * for tests.
 *
 * @module views/fetch
 */

import * as ui from '../core/ui.js';
import { nextStep } from '../components/next-step.js';
import {
  PLUGINS, getPlugin, getDefaultFormat, getRecommendedPdf, getRecommendedPdfNote, getOptionsForFormat,
  matchesFormatPattern, normalizeInlineValue, searchPlugins,
} from '../data/catalog.js';
import { describeCardSize, getOptionDoc, resolveCardSize } from '../data/option-docs.js';
import {
  slot, swap, fk, isJobRunning, busyMessage, openLink, openFolder, saveSettings, frameThrottle, createLogView,
} from './setup.js';

const { h, icon } = ui;

/** Per-session memory shared by every mount of this view (not persisted). */
const SESSION = {
  /** `${plugin}|${format}` → value typed in a link / code field this session. */
  inlineByFormat: new Map(),
  /** jobId → { plugin, format, deckName, mode } of downloads started from this view. */
  requests: new Map(),
  /** Result cards the user dismissed (job ids). */
  dismissed: new Set(),
  /** previousBatchId → number of cards put back. */
  restored: new Map(),
  /** `${plugin}|${format}` → optional deck name typed for a link / code this session. */
  linkNames: new Map(),
};

/** Short badges for the game tiles. */
const GAME_CODES = Object.freeze({
  mtg: 'MTG', yugioh: 'YGO', pokemon: 'PKM', lorcana: 'LOR', one_piece: 'OP', digimon: 'DCG', flesh_and_blood: 'FAB',
  star_wars_unlimited: 'SWU', riftbound: 'RB', gundam: 'GCG', netrunner: 'NR', altered: 'ALT', ashes_reborn: 'ASH',
  bushiroad: 'BSR', echoes_of_astra: 'EOA', elestrals: 'ELE', final_fantasy: 'FF', grand_archive: 'GA', keyforge: 'KF',
  lotr_lcg: 'LotR', arkham_horror_lcg: 'AH', sorcery_contested_realm: 'SCR',
});

/** MTG deck sites whose links carry no exact printings (spec §13.3 fetch notes). */
const MTG_NO_PRINTING_HOSTS = /(^|\.)(deckstats\.net|tappedout\.net|mtggoldfish\.com|mtgjson\.com|tcgplayer\.com)$/i;

const SOURCE_MODES = ['text', 'saved', 'file'];
const RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Title-case an identifier: `star_wars_unlimited` → "Star Wars Unlimited".
 * @param {string} id
 * @returns {string}
 */
function titleCase(id) {
  return String(id || '').split(/[_\s-]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Deck name as the app will save it: forbidden characters and trailing dots/spaces removed, max 100.
 * @param {string} name
 * @returns {string}
 */
export function cleanDeckName(name) {
  // eslint-disable-next-line no-control-regex
  return String(name ?? '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').replace(/[. ]+$/g, '').trim().slice(0, 100).replace(/[. ]+$/g, '');
}

/**
 * Plain-language problem with a deck name, or null when it is fine.
 * @param {string} name
 * @returns {string|null}
 */
export function deckNameProblem(name) {
  const raw = String(name ?? '').trim();
  if (!raw) return 'Give your deck a name.';
  const clean = cleanDeckName(raw);
  if (!clean) return 'Use letters or numbers in the deck name.';
  if (RESERVED_NAME.test(clean)) return 'Windows does not allow this name. Choose another deck name.';
  return null;
}

/**
 * File name without its folder and extension.
 * @param {string|null|undefined} p
 * @returns {string}
 */
function stemOf(p) {
  const base = String(p || '').split(/[\\/]/).pop() || '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * File name without its folder.
 * @param {string|null|undefined} p
 * @returns {string}
 */
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop() || '';
}

/**
 * True when an MTG deck link points to a site that doesn't give exact printings.
 * @param {string} url
 * @returns {boolean}
 */
export function linkNeedsIgnorePrintings(url) {
  const text = String(url || '').trim();
  if (!text) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return MTG_NO_PRINTING_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Friendly site name of a link (`https://www.tappedout.net/...` → "tappedout.net").
 * @param {string} url
 * @returns {string}
 */
function siteOf(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`);
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return 'this site';
  }
}

/**
 * Build a plugin entry for an introspected plugin the catalog doesn't know (generic labels).
 * @param {object} spec introspection plugin `{ id, params, error }`
 * @returns {object}
 */
function pluginFromSpec(spec) {
  const params = Array.isArray(spec.params) ? spec.params : [];
  const formatParam = params.find((p) => p && p.kind === 'argument' && p.name === 'format');
  const formats = (Array.isArray(formatParam?.choices) ? formatParam.choices : []).map((id) => ({
    id, label: titleCase(id), inputKind: 'file', fileExtensionHint: '.txt', fileExtensions: ['txt'],
    description: '', howToGet: '', example: '',
  }));
  const options = params
    .filter((p) => p && p.kind === 'option' && !p.hidden && p.exposeValue !== false && p.name !== 'help')
    .map((p) => {
      let kind = 'text';
      if (p.isFlag || p.type === 'bool') kind = 'flag';
      else if (p.type === 'choice') kind = p.multiple ? 'multi_choice' : 'choice';
      else if (p.multiple) kind = 'multi_text';
      return {
        name: p.name, kind, choices: Array.isArray(p.choices) ? p.choices : null, choiceLabels: null,
        default: kind === 'flag' ? false : (p.multiple ? [] : (p.default ?? null)),
        label: titleCase(p.name), help: typeof p.help === 'string' ? p.help : '', advanced: true,
      };
    });
  return {
    id: spec.id,
    displayName: titleCase(spec.id),
    shortDescription: 'Downloads the card pictures for your deck list.',
    keywords: [],
    imageSource: '',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: formats[0]?.id || null,
    recommendedPdf: {},
    docsUrl: null,
    formats,
    options,
    notes: [],
    fromSpec: true,
  };
}

/**
 * Games offered in the picker: the catalog plus introspected plugins, each with an `availability`
 * ('ok' | 'broken' | 'missing' | 'error') and a plain `reason`.
 * @param {object|null} introspection
 * @returns {object[]}
 */
export function mergePlugins(introspection) {
  const specs = Array.isArray(introspection?.plugins) ? introspection.plugins.filter((p) => p && typeof p.id === 'string') : null;
  const byId = new Map((specs || []).map((p) => [p.id, p]));
  const list = PLUGINS.map((p) => {
    const spec = byId.get(p.id) || null;
    let availability = 'ok';
    let reason = null;
    if (p.status === 'broken') {
      availability = 'broken';
      reason = p.statusMessage || 'This game is not working right now.';
    } else if (specs && !spec) {
      availability = 'missing';
      reason = 'This game is not included in your version of the card maker.';
    } else if (spec && spec.error) {
      availability = 'error';
      reason = "This game's downloader could not be loaded. Repairing the card maker components (Settings) may help.";
    }
    let formats = p.formats;
    const choices = spec?.params?.find?.((x) => x && x.kind === 'argument' && x.name === 'format')?.choices;
    if (Array.isArray(choices)) {
      const known = new Set(p.formats.map((f) => f.id));
      const extra = choices.filter((id) => !known.has(id)).map((id) => ({
        id, label: titleCase(id), inputKind: 'file', fileExtensionHint: '.txt', fileExtensions: ['txt'], description: '', howToGet: '', example: '',
      }));
      if (extra.length) formats = [...p.formats, ...extra];
    }
    return { ...p, formats, availability, reason };
  });
  for (const spec of specs || []) {
    if (getPlugin(spec.id)) continue;
    const p = pluginFromSpec(spec);
    if (!p.formats.length) continue;
    list.push({ ...p, availability: spec.error ? 'error' : 'ok', reason: spec.error ? "This game's downloader could not be loaded." : null });
  }
  return list;
}

/**
 * Options of a plugin for a format (catalog rules, or every option of a spec-only plugin).
 * @param {object} plugin merged plugin entry
 * @param {string|null} formatId
 * @returns {object[]}
 */
function optionsFor(plugin, formatId) {
  if (!plugin) return [];
  if (plugin.fromSpec) return plugin.options.slice();
  return getOptionsForFormat(plugin.id, formatId);
}

/**
 * The plugin `options` object for a fetch request: only values that differ from the defaults,
 * lists de-duplicated (lowercased when the option asks for it); MTG links from sites without exact
 * printings automatically get "Ignore exact printings".
 *
 * @param {object} plugin merged plugin entry
 * @param {object} format deck format
 * @param {Record<string, any>} values saved option values for this plugin
 * @param {string} [inlineValue] the link typed for url formats
 * @returns {Record<string, any>}
 */
export function buildPluginOptions(plugin, format, values = {}, inlineValue = '') {
  const out = {};
  const list = optionsFor(plugin, format?.id || null);
  for (const opt of list) {
    const v = values?.[opt.name];
    if (opt.kind === 'flag') {
      if (v === true) out[opt.name] = true;
    } else if (opt.kind === 'choice') {
      if (v !== undefined && v !== null && v !== '' && v !== opt.default && (!Array.isArray(opt.choices) || opt.choices.includes(v))) out[opt.name] = v;
    } else if (opt.kind === 'multi_choice' || opt.kind === 'multi_text') {
      const arr = (Array.isArray(v) ? v : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean)
        .map((x) => (opt.lowercase ? x.toLowerCase() : x))
        .filter((x) => opt.kind !== 'multi_choice' || !Array.isArray(opt.choices) || opt.choices.includes(x));
      const unique = [...new Set(arr)];
      if (unique.length) out[opt.name] = unique;
    } else if (typeof v === 'string' && v.trim()) {
      out[opt.name] = v.trim();
    }
  }
  if (plugin?.id === 'mtg' && format?.id === 'url' && linkNeedsIgnorePrintings(inlineValue)
    && list.some((o) => o.name === 'ignore_set_and_collector_number')) {
    out.ignore_set_and_collector_number = true;
  }
  return out;
}

/**
 * The `source` part of a fetch request (spec §6 / ipc.js SOURCE_KINDS).
 * @param {object} format deck format
 * @param {{ mode: string, text: string, deckName: string, linkName?: string, savedName: string|null, filePath: string|null, inline: string }} st
 *   `deckName` names pasted lists; `linkName` is the optional name typed for a link / code.
 * @returns {object}
 */
export function buildSource(format, st) {
  if (format?.inputKind === 'url' || format?.inputKind === 'text_inline') {
    const name = cleanDeckName(st.linkName ?? '');
    const extra = name ? { deckName: name } : {};
    if (format.inputKind === 'url') return { kind: 'url', url: String(st.inline || '').trim(), ...extra };
    // Codes go in `text`: the service reads `url || text`, and the IPC layer only accepts long
    // values (YDKE codes of big decks) in `text`.
    return { kind: 'text_inline', text: normalizeInlineValue(format, st.inline), ...extra };
  }
  if (st.mode === 'saved') return { kind: 'saved', savedName: st.savedName, deckName: cleanDeckName(stemOf(st.savedName)) || undefined };
  if (st.mode === 'file') return { kind: 'file', filePath: st.filePath, deckName: cleanDeckName(stemOf(st.filePath)) || undefined };
  return { kind: 'text', text: st.text, deckName: cleanDeckName(st.deckName) || 'my-deck' };
}

/**
 * Numbers for the result card.
 * @param {object|null} result fetch job result
 * @returns {{ cards: number, backs: number, failed: object[], failedQty: number, requested: number, ignored: string[] }}
 */
export function summarizeFetchResult(result) {
  const r = result && typeof result === 'object' ? result : {};
  const added = Number(r.added) || 0;
  const cards = Number.isFinite(Number(r.front)) && r.front !== null && r.front !== undefined ? Number(r.front) : added;
  const backs = Number(r.double_sided) || 0;
  const failed = Array.isArray(r.failedCards) ? r.failedCards.filter(Boolean) : [];
  const failedQty = failed.reduce((n, c) => n + Math.max(1, Number(c.quantity) || 1), 0);
  const ignored = Array.isArray(r.ignoredLines) ? r.ignoredLines.map((l) => String(l)).filter((l) => l.trim()) : [];
  return { cards, backs, failed, failedQty, requested: cards + failedQty, ignored };
}

/**
 * "4 Lightning Bolt" lines for the failed cards (to paste into another list or search).
 * @param {object[]} failed
 * @returns {string}
 */
export function failedNamesText(failed) {
  return (failed || [])
    .filter((c) => c && c.name)
    .map((c) => `${Math.max(1, Number(c.quantity) || 1)} ${c.name}`)
    .join('\n');
}

/**
 * Make PDF settings that differ from the recommendation for a plugin/format.
 * @param {string} pluginId
 * @param {string|null} formatId
 * @param {object} pdfOptions settings.pdf.options
 * @returns {{ rec: object, diffs: Array<[string, any]> }}
 */
export function pdfRecommendationDiff(pluginId, formatId, pdfOptions = {}) {
  const rec = getRecommendedPdf(pluginId, formatId);
  const norm = (v) => (v === undefined || v === '' ? null : v);
  const diffs = Object.entries(rec).filter(([k, v]) => {
    if (!getOptionDoc(k)) return false;
    if (k === 'card_size') return resolveCardSize(String(pdfOptions?.[k] ?? '')) !== resolveCardSize(String(v ?? ''));
    return String(norm(pdfOptions?.[k])) !== String(norm(v));
  });
  return { rec, diffs };
}

/**
 * Friendly "Label: value" text for a recommended PDF option.
 * @param {string} name
 * @param {any} value
 * @returns {string}
 */
export function describePdfOption(name, value) {
  const doc = getOptionDoc(name);
  const label = doc ? doc.label : 'Setting';
  if (name === 'card_size') return `${label}: ${describeCardSize(value)}`;
  if (value === null || value === undefined || value === '') return `${label}: off`;
  const s = String(value);
  const m = /^(\d+(?:\.\d+)?)(mm|in)$/.exec(s);
  if (m) return `${label}: ${m[1]} ${m[2]}`;
  if (/^\d+(?:\.\d+)?$/.test(s)) return `${label}: ${s}${name.startsWith('crop') ? '%' : ' px'}`;
  return `${label}: ${s}`;
}

/* ------------------------------------------------------------------------------------------------
 * Small DOM helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Game badge (short code on the brand gradient).
 * @param {object} p merged plugin entry
 * @param {number} [size]
 * @returns {HTMLElement}
 */
function gameAvatar(p, size = 32) {
  const code = GAME_CODES[p.id] || (p.displayName.match(/\b[A-Za-z0-9]/g) || ['?']).slice(0, 3).join('').toUpperCase();
  const ok = p.availability === 'ok';
  return h('span', {
    attrs: { 'aria-hidden': 'true' },
    style: {
      width: `${size}px`, height: `${size}px`, flex: 'none', display: 'grid', placeItems: 'center',
      borderRadius: size >= 40 ? 'var(--radius)' : 'var(--radius-sm)',
      background: ok ? 'linear-gradient(135deg, var(--accent-soft-2), var(--teal-soft))' : 'var(--surface-3)',
      color: ok ? 'var(--accent-text)' : 'var(--faint)', border: '1px solid var(--border)',
      fontWeight: 700, letterSpacing: '0.02em', fontSize: size >= 40 ? (code.length > 3 ? '12px' : '14px') : (code.length > 3 ? '9.5px' : '11px'),
    },
  }, code);
}

/**
 * Split "Bushiroad games (Vanguard, …)" into a tile label and a description.
 * @param {string} name
 * @returns {[string, string|null]}
 */
function splitName(name) {
  const m = /^(.*?)\s*\((.+)\)\s*$/.exec(String(name || ''));
  return m ? [m[1], m[2]] : [String(name || ''), null];
}

/**
 * First lines of an example, for a textarea placeholder.
 * @param {string} example
 * @returns {string}
 */
function placeholderFrom(example) {
  const lines = String(example || '').split('\n').filter((l) => l.trim()).slice(0, 4);
  return lines.length ? `For example:\n${lines.join('\n')}` : 'Paste your deck list here, one card per line.';
}

/* ------------------------------------------------------------------------------------------------
 * The view
 * ---------------------------------------------------------------------------------------------- */

export default {
  id: 'fetch',
  title: 'Get cards',
  icon: 'download',

  /**
   * @param {HTMLElement} container
   * @param {object} ctx
   */
  mount(container, ctx) {
    const { api, store, format } = ctx;
    let plugins = mergePlugins(store.get('introspection'));

    /* ---------- state ---------- */

    const s0 = store.get('settings')?.fetch || {};
    const src0 = s0.source || {};
    const st = {
      pluginId: null,
      formatId: null,
      mode: SOURCE_MODES.includes(src0.kind) ? src0.kind : 'text',
      text: typeof src0.text === 'string' ? src0.text : '',
      deckName: typeof src0.deckName === 'string' ? src0.deckName : 'my-deck',
      savedName: typeof src0.savedName === 'string' ? src0.savedName : null,
      filePath: typeof src0.filePath === 'string' ? src0.filePath : null,
      url: typeof src0.url === 'string' ? src0.url : '',
      inline: '',
      linkName: '',
      options: JSON.parse(JSON.stringify(s0.optionsByPlugin && typeof s0.optionsByPlugin === 'object' ? s0.optionsByPlugin : {})),
      /** Format chosen per game (this session + saved), so switching games never loses a choice. */
      formats: { ...(s0.formatByPlugin && typeof s0.formatByPlugin === 'object' ? s0.formatByPlugin : {}) },
      clearBeforeFetch: s0.clearBeforeFetch !== false,
      pickerOpen: !s0.lastFetched,
      query: '',
      touched: false,
      saved: { list: null, loading: false, error: null, editing: false, text: '', original: '', loadingText: false },
    };

    const plugin = () => plugins.find((p) => p.id === st.pluginId) || plugins[0];
    const fmt = () => {
      const p = plugin();
      return p.formats.find((f) => f.id === st.formatId) || p.formats[0] || null;
    };
    const formatFor = (p, savedId) => {
      if (!p) return null;
      if (!p.fromSpec) return getDefaultFormat(p.id, savedId) || p.formats[0]?.id || null;
      return (savedId && p.formats.some((f) => f.id === savedId)) ? savedId : (p.formats[0]?.id || null);
    };
    const inlineKey = () => `${st.pluginId}|${st.formatId}`;
    const initialInline = () => {
      const f = fmt();
      if (!f || f.inputKind === 'file') return '';
      if (SESSION.inlineByFormat.has(inlineKey())) return SESSION.inlineByFormat.get(inlineKey());
      return st.url && matchesFormatPattern(f, st.url) ? st.url : '';
    };

    {
      const wanted = typeof s0.plugin === 'string' ? s0.plugin : 'mtg';
      const p = plugins.find((x) => x.id === wanted && x.formats.length) || plugins.find((x) => x.id === 'mtg') || plugins[0];
      st.pluginId = p.id;
      st.formatId = formatFor(p, st.formats[p.id]);
      // The remembered link/code belongs to the remembered game and format: restore it as typed
      // (even when it is not valid yet) unless this session already has a value for the format.
      const f = fmt();
      st.inline = f && f.inputKind !== 'file' && !SESSION.inlineByFormat.has(inlineKey()) && p.id === wanted ? st.url : initialInline();
      st.linkName = SESSION.linkNames.get(inlineKey()) || '';
    }

    /* ---------- persistence ---------- */

    let persistTimer = null;
    function persistNow() {
      clearTimeout(persistTimer);
      persistTimer = null;
      const patch = {
        fetch: {
          plugin: st.pluginId,
          // Every game's choices (not only the current one): a quick switch to another game must
          // not drop a change still waiting to be saved.
          formatByPlugin: { ...st.formats, [st.pluginId]: st.formatId },
          optionsByPlugin: JSON.parse(JSON.stringify(st.options)),
          clearBeforeFetch: !!st.clearBeforeFetch,
          source: {
            kind: st.mode, deckName: st.deckName, text: st.text, filePath: st.filePath || null, savedName: st.savedName || null, url: st.url || '',
          },
        },
      };
      return api.settings.update(patch).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[fetch] could not remember the choices:', err);
      });
    }
    function persistSoon() {
      clearTimeout(persistTimer);
      persistTimer = setTimeout(() => persistNow(), 400);
    }
    ctx.onCleanup(() => {
      if (persistTimer) persistNow();
    });

    /* ---------- layout ---------- */

    const slots = {
      game: slot('game'),
      list: slot('list'),
      options: slot('options'),
      action: slot('action'),
      progress: slot('progress'),
      result: slot('result'),
      next: slot('next'),
    };
    container.append(
      ui.pageHeader({ title: 'Get cards', subtitle: 'Download the card pictures of your deck from the game’s card website.', icon: 'download', step: 1 }),
      ...Object.values(slots),
    );

    /** Live element references (replaced on re-render). */
    const refs = {
      tiles: null, search: null, sourceBody: null, textarea: null, inlineInput: null, inlineField: null, nameField: null,
      lineHint: null, downloadBtn: null, actionHint: null, freshBox: null, editorTa: null,
    };
    let lastPointerDown = 0;

    /* ---------- game section ---------- */

    function availabilityBadge(p) {
      if (p.availability === 'ok') return null;
      return ui.badge(p.availability === 'broken' ? 'Not working' : 'Not available', 'warning', { icon: 'alert-triangle' });
    }

    function renderTiles() {
      if (!refs.tiles) return;
      const list = searchPlugins(st.query, plugins);
      if (!list.length) {
        swap(refs.tiles, h('p.small.muted', { style: { padding: '8px 2px' } }, `No game matches “${st.query.trim()}”. Try another word, such as the game's short name.`));
        return;
      }
      const cards = fk(ui.radioCards({
        ariaLabel: 'Games',
        compact: true,
        value: st.pluginId,
        options: list.map((p) => {
          const [label, sub] = splitName(p.displayName);
          const off = p.availability !== 'ok';
          return {
            value: p.id,
            label,
            description: off ? (p.availability === 'broken' ? 'Not working right now.' : 'Not available.') : sub,
            icon: gameAvatar(p, 32),
            badge: off ? { text: p.availability === 'broken' ? 'Broken' : 'Unavailable', variant: 'warning' } : undefined,
            disabled: off,
          };
        }),
        onChange: (id) => selectPlugin(id, { close: Date.now() - lastPointerDown < 900 }),
      }), 'game-tiles');
      swap(refs.tiles, cards);
    }

    function renderGame() {
      const p = plugin();
      const docs = p.docsUrl || null;
      const head = h('div.row.row-nowrap', { style: { '--gap': '14px', alignItems: 'flex-start' } },
        gameAvatar(p, 44),
        h('div.stack', { style: { '--gap': '4px', flex: '1 1 auto' } },
          h('div.row', { style: { '--gap': '8px' } }, h('h3.card-title', p.displayName), availabilityBadge(p)),
          h('p.small.muted', p.shortDescription)),
        h('div.row', { style: { '--gap': '6px', flex: 'none' } },
          docs ? ui.button({ label: 'Learn more', icon: 'external-link', size: 'sm', variant: 'ghost', onClick: () => openLink(ctx, docs) }) : null,
          fk(ui.button({
            label: st.pickerOpen ? 'Done' : 'Change game',
            icon: st.pickerOpen ? 'check' : 'grid',
            size: 'sm',
            variant: st.pickerOpen ? 'primary' : 'secondary',
            attrs: { 'aria-expanded': String(st.pickerOpen) },
            onClick: () => togglePicker(),
          }), 'game-toggle')));
      const children = [head];
      if (p.availability !== 'ok') {
        children.push(ui.callout({ variant: 'danger', title: p.availability === 'broken' ? 'This game is not working right now' : 'This game is not available', message: p.reason }));
      }
      if (st.pickerOpen) {
        refs.search = ui.textInput({
          icon: 'search', type: 'search', value: st.query, ariaLabel: 'Search games', placeholder: `Search ${plugins.length} games…`,
          onInput: (v) => {
            st.query = v;
            renderTiles();
          },
        });
        refs.tiles = h('div');
        refs.tiles.addEventListener('pointerdown', () => { lastPointerDown = Date.now(); });
        children.push(ui.divider(), refs.search, refs.tiles);
      } else {
        refs.tiles = null;
        refs.search = null;
      }
      swap(slots.game, ui.section({
        title: 'Choose your game',
        icon: 'layers',
        children: ui.card({ children }),
      }));
      renderTiles();
    }

    function togglePicker() {
      st.pickerOpen = !st.pickerOpen;
      renderGame();
      if (st.pickerOpen) (refs.search?.input || refs.search)?.focus({ preventScroll: true });
    }

    function selectPlugin(id, { close = false } = {}) {
      if (id !== st.pluginId) {
        const p = plugins.find((x) => x.id === id);
        if (!p || p.availability !== 'ok') return;
        st.pluginId = id;
        st.formatId = formatFor(p, st.formats[id]);
        st.inline = initialInline();
        st.linkName = SESSION.linkNames.get(inlineKey()) || '';
        st.touched = false;
        persistSoon();
        renderList();
        renderOptions();
      }
      if (close) st.pickerOpen = false;
      renderGame();
      updateAction();
      if (close) slots.game.querySelector('[data-fk="game-toggle"]')?.focus({ preventScroll: true });
    }

    /* ---------- deck list section ---------- */

    function renderList() {
      const p = plugin();
      const f = fmt();
      if (!f) {
        swap(slots.list, ui.section({ title: 'Your deck list', icon: 'file-text', children: ui.callout({ variant: 'warning', message: 'This game has no deck list formats.' }) }));
        return;
      }
      const formatSelect = fk(ui.select({
        options: p.formats.map((x) => ({ value: x.id, label: x.label, description: x.description || undefined })),
        value: f.id,
        ariaLabel: 'List format',
        onChange: (v) => selectFormat(v),
      }), 'format');
      const how = f.howToGet
        ? ui.callout({
          variant: 'neutral',
          icon: 'help',
          title: 'How to get this list',
          message: f.howToGet,
          actions: f.example ? [{ label: 'Insert example', icon: 'file-text', onClick: () => insertExample() }] : null,
        })
        : null;
      const warn = f.warning ? ui.callout({ variant: 'warning', compact: true, message: f.warning }) : null;
      refs.sourceBody = slot('source');
      const intro = f.inputKind === 'file'
        ? h('div.row', fk(ui.segmented({
          ariaLabel: 'Where is your list?',
          value: st.mode,
          options: [
            { value: 'text', label: 'Paste list', icon: 'file-text' },
            { value: 'saved', label: 'Saved lists', icon: 'list' },
            { value: 'file', label: 'Choose a file', icon: 'folder-open' },
          ],
          onChange: (v) => {
            st.mode = v;
            st.touched = false;
            persistSoon();
            renderSourceBody();
            updateAction();
          },
        }), 'mode'))
        : null;
      swap(slots.list, ui.section({
        title: 'Your deck list',
        description: f.inputKind === 'file' ? 'Paste the list, pick one you used before, or choose a file.' : (f.inputKind === 'url' ? 'Paste the link of your deck.' : 'Paste the code of your deck.'),
        icon: 'file-text',
        children: ui.card({
          children: [
            ui.field({ label: 'List format', control: formatSelect }),
            how,
            warn,
            intro ? ui.divider() : null,
            intro,
            refs.sourceBody,
          ],
        }),
      }));
      renderSourceBody();
    }

    function selectFormat(id) {
      if (id === st.formatId) return;
      st.formatId = id;
      st.formats[st.pluginId] = id;
      st.inline = initialInline();
      st.linkName = SESSION.linkNames.get(inlineKey()) || '';
      st.touched = false;
      persistSoon();
      renderList();
      renderOptions();
      updateAction();
    }

    async function insertExample() {
      const f = fmt();
      if (!f?.example) return;
      if (f.inputKind === 'file') {
        if (st.mode !== 'text') {
          st.mode = 'text';
          renderList();
        } else if (st.text.trim() && st.text.trim() !== f.example.trim()) {
          const ok = await ui.confirmDialog({ title: 'Replace your list with the example?', message: 'The list you pasted will be replaced.', confirmLabel: 'Replace' });
          if (!ok) return;
        }
        st.text = f.example;
        if (refs.textarea) refs.textarea.value = st.text;
        updateLineHint();
        refs.textarea?.focus({ preventScroll: true });
      } else {
        st.inline = f.example;
        st.url = f.example;
        SESSION.inlineByFormat.set(inlineKey(), f.example);
        if (refs.inlineInput) refs.inlineInput.value = f.example;
        updateInlineHints();
        refs.inlineInput?.focus({ preventScroll: true });
      }
      persistSoon();
      updateAction();
    }

    function updateLineHint() {
      if (!refs.lineHint) return;
      const n = st.text.split(/\r\n|\n|\r/).filter((l) => l.trim()).length;
      refs.lineHint.textContent = n ? `${format.pluralize(n, 'line')}. Each card line becomes printed cards; headings and blank lines are skipped.` : 'One card per line, as exported by the website or app.';
    }

    function renderSourceBody() {
      if (!refs.sourceBody) return;
      const f = fmt();
      refs.textarea = null;
      refs.inlineInput = null;
      refs.inlineField = null;
      refs.nameField = null;
      refs.lineHint = null;
      refs.editorTa = null;
      if (!f) return;
      if (f.inputKind !== 'file') {
        swap(refs.sourceBody, renderInlineSource(f));
        updateInlineHints();
        return;
      }
      if (st.mode === 'saved') {
        swap(refs.sourceBody, renderSavedSource());
        loadSavedLists();
      } else if (st.mode === 'file') {
        swap(refs.sourceBody, renderFileSource(f));
      } else {
        swap(refs.sourceBody, renderPasteSource(f));
        updateLineHint();
      }
    }

    /**
     * Deck name field: required for pasted lists (persisted), optional for links / codes (kept for
     * this session per game and format, so a pasted list's name never sticks to another deck).
     * @param {{ optional?: boolean }} [o]
     */
    function deckNameField({ optional = false } = {}) {
      const current = optional ? st.linkName : st.deckName;
      const input = ui.textInput({
        value: current,
        placeholder: optional ? 'Name it (optional)' : 'my-deck',
        maxLength: 100,
        width: 320,
        ariaLabel: 'Deck name',
        onInput: (v) => {
          if (optional) {
            st.linkName = v;
            SESSION.linkNames.set(inlineKey(), v);
          } else {
            st.deckName = v;
            persistSoon();
          }
          refs.nameField?.setError(optional && !v.trim() ? null : deckNameProblem(v));
          updateAction();
        },
      });
      refs.nameField = ui.field({
        label: optional ? 'Deck name (optional)' : 'Deck name',
        hint: optional ? 'Used for your PDF file name.' : 'Used to name the saved list and your PDF.',
        control: input,
        error: optional && !current.trim() ? null : deckNameProblem(current),
      });
      return refs.nameField;
    }

    function renderPasteSource(f) {
      refs.textarea = ui.textArea({
        value: st.text,
        rows: 12,
        placeholder: placeholderFrom(f.example),
        ariaLabel: 'Deck list',
        onInput: (v) => {
          st.text = v;
          updateLineHint();
          persistSoon();
          updateAction();
        },
      });
      refs.lineHint = h('span');
      return h('div.stack', { style: { '--gap': '16px' } },
        fk(ui.field({ label: 'Deck list', hint: refs.lineHint, control: refs.textarea }), 'paste-list'),
        fk(deckNameField(), 'deck-name'));
    }

    function renderFileSource(f) {
      const exts = (f.fileExtensions || ['txt']).map((e) => `.${e}`).join(', ');
      const choose = async () => {
        const picked = await api.dialog.openFile({
          purpose: 'decklist',
          title: 'Choose your deck list',
          filters: [{ name: f.label.slice(0, 90), extensions: f.fileExtensions?.length ? f.fileExtensions : ['txt'] }, { name: 'All files', extensions: ['*'] }],
        });
        if (!picked) return;
        st.filePath = picked;
        persistSoon();
        renderSourceBody();
        updateAction();
      };
      if (!st.filePath) {
        return h('div.stack', { style: { '--gap': '10px' } },
          h('div.row', fk(ui.button({ label: 'Choose a file…', icon: 'folder-open', variant: 'primary', onClick: choose }), 'file-choose')),
          h('p.small.muted', `Usually ${exts}. The app makes a copy; your file is never changed.`));
      }
      return h('div.stack', { style: { '--gap': '10px' } },
        h('div.row.row-nowrap', { style: { '--gap': '12px', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--surface-2)' } },
          h('span.text-accent', icon('file-text', { size: 18 })),
          h('div.stack', { style: { '--gap': '2px', flex: '1 1 auto' } },
            h('span.strong.truncate', baseName(st.filePath)),
            h('span.tiny.muted.mono', { style: { overflowWrap: 'anywhere' } }, st.filePath)),
          fk(ui.button({ label: 'Choose another…', size: 'sm', onClick: choose }), 'file-choose')),
        h('p.small.muted', 'The app makes a copy; your file is never changed.'));
    }

    function updateInlineHints() {
      const f = fmt();
      if (!refs.inlineField || !f) return;
      const v = st.inline || '';
      const valid = matchesFormatPattern(f, v);
      refs.inlineField.setError(st.touched && v.trim() && !valid ? `This doesn't look like a ${f.label.replace(/\s*\(.*\)$/, '')}.${f.example ? ` Example: ${f.example}` : ''}` : null);
      const notes = [];
      if (f.extract && v.trim() && valid) {
        const n = normalizeInlineValue(f, v);
        if (n && n !== v.trim()) notes.push(`The app will use: ${n}`);
      }
      if (plugin().id === 'mtg' && f.id === 'url' && linkNeedsIgnorePrintings(v)) {
        notes.push(`Links from ${siteOf(v)} don't include exact printings, so “Ignore exact printings” is turned on for this download.`);
      }
      refs.inlineField.setHint(notes.join(' ') || (f.inputKind === 'url' ? 'Copy the address from your browser’s address bar.' : null));
    }

    function renderInlineSource(f) {
      const input = ui.textInput({
        value: st.inline,
        type: f.inputKind === 'url' ? 'url' : 'text',
        placeholder: f.example || '',
        ariaLabel: f.label,
        onInput: (v) => {
          st.inline = v;
          st.url = v;
          SESSION.inlineByFormat.set(inlineKey(), v);
          updateInlineHints();
          persistSoon();
          updateAction();
        },
        onChange: () => {
          st.touched = true;
          updateInlineHints();
        },
        onEnter: () => startDownload(),
      });
      refs.inlineInput = input;
      refs.inlineField = ui.field({ label: f.inputKind === 'url' ? 'Deck link' : f.label, control: input });
      return h('div.stack', { style: { '--gap': '16px' } }, fk(refs.inlineField, 'inline'), fk(deckNameField({ optional: true }), 'deck-name'));
    }

    /* ---------- saved lists ---------- */

    async function loadSavedLists(force = false) {
      const sv = st.saved;
      if (sv.loading || (sv.list && !force)) return;
      sv.loading = true;
      sv.error = null;
      if (!sv.list) renderSavedBodyIfVisible();
      try {
        const list = await api.decklists.list();
        if (ctx.signal.aborted) return;
        sv.list = (Array.isArray(list) ? list : [])
          .filter((x) => x && typeof x.name === 'string')
          .sort((a, b) => (Number(new Date(b.mtime)) || 0) - (Number(new Date(a.mtime)) || 0));
        if ((!st.savedName || !sv.list.some((x) => x.name === st.savedName)) && sv.list.length && !sv.editing) {
          if (!st.savedName) {
            st.savedName = sv.list[0].name;
            persistSoon();
          }
        }
      } catch (err) {
        if (ctx.signal.aborted) return;
        sv.error = api.errorMessage(err);
      } finally {
        sv.loading = false;
      }
      renderSavedBodyIfVisible();
      updateAction();
    }

    function renderSavedBodyIfVisible() {
      if (fmt()?.inputKind === 'file' && st.mode === 'saved' && refs.sourceBody) swap(refs.sourceBody, renderSavedSource());
    }

    async function openEditor() {
      const sv = st.saved;
      if (!st.savedName) return;
      sv.editing = true;
      sv.loadingText = true;
      renderSavedBodyIfVisible();
      try {
        const text = await api.decklists.read(st.savedName);
        if (ctx.signal.aborted) return;
        sv.text = typeof text === 'string' ? text : '';
        sv.original = sv.text;
      } catch (err) {
        sv.editing = false;
        ui.showError(err, { title: "Couldn't open this list" });
      } finally {
        sv.loadingText = false;
      }
      renderSavedBodyIfVisible();
      refs.editorTa?.focus({ preventScroll: true });
    }

    async function saveEditor({ quiet = false } = {}) {
      const sv = st.saved;
      if (!st.savedName) return false;
      try {
        const res = await api.decklists.write(st.savedName, sv.text, { keepBoth: false });
        sv.original = sv.text;
        if (res && typeof res.name === 'string' && res.name && res.name !== st.savedName) {
          st.savedName = res.name;
          persistSoon();
        }
        if (!quiet) ui.toast({ variant: 'success', title: 'List saved', timeout: 2500 });
        loadSavedLists(true);
        return true;
      } catch (err) {
        ui.showError(err, { title: "Couldn't save the list" });
        return false;
      }
    }

    function renderSavedSource() {
      const sv = st.saved;
      const busy = isJobRunning(store.get('job'));
      if (sv.loading && !sv.list) return ui.skeleton({ lines: 2 });
      if (sv.error) {
        return ui.callout({ variant: 'warning', title: "Couldn't load your saved lists", message: sv.error, actions: [{ label: 'Try again', icon: 'refresh', onClick: () => loadSavedLists(true) }] });
      }
      const list = sv.list || [];
      if (!list.length) {
        return h('div.stack', { style: { '--gap': '10px' } },
          h('p.small.muted', 'No saved lists yet. Lists you paste are saved automatically when you download.'),
          h('div.row', ui.button({ label: 'Paste a list', icon: 'file-text', size: 'sm', onClick: () => { st.mode = 'text'; persistSoon(); renderList(); updateAction(); } })));
      }
      const exists = list.some((x) => x.name === st.savedName);
      const picker = fk(ui.select({
        ariaLabel: 'Saved list',
        value: exists ? st.savedName : undefined,
        placeholder: 'Choose a saved list…',
        options: list.map((x) => ({
          value: x.name,
          label: x.name,
          description: [Number.isFinite(Number(x.size)) ? format.formatBytes(x.size) : null, x.mtime ? `changed ${format.formatDate(x.mtime)}` : null].filter(Boolean).join(' · ') || undefined,
        })),
        onChange: async (v) => {
          if (sv.editing && sv.text !== sv.original) {
            const ok = await ui.confirmDialog({ title: 'Discard your changes?', message: 'The changes to the open list are not saved.', confirmLabel: 'Discard' });
            if (!ok) {
              picker.setValue(st.savedName);
              return;
            }
          }
          st.savedName = v;
          sv.editing = false;
          persistSoon();
          renderSavedBodyIfVisible();
          updateAction();
        },
      }), 'saved-select');
      const parts = [ui.field({ label: 'Saved list', control: picker })];
      if (st.savedName && !exists) parts.push(ui.callout({ variant: 'warning', compact: true, message: `“${st.savedName}” is not in your saved lists anymore. Choose another one.` }));
      if (sv.editing) {
        if (sv.loadingText) {
          parts.push(ui.skeleton({ lines: 4 }));
        } else {
          const status = h('span.small.muted');
          const saveBtn = ui.button({ label: 'Save', icon: 'save', size: 'sm', variant: 'primary', disabled: busy || sv.text === sv.original, title: busy ? busyMessage(store.get('job')) : undefined, onClick: () => saveEditor() });
          const updateStatus = () => {
            const dirty = sv.text !== sv.original;
            status.textContent = dirty ? 'Unsaved changes. They are saved automatically when you download.' : 'No changes.';
            saveBtn.disabled = busy || !dirty;
          };
          refs.editorTa = ui.textArea({
            value: sv.text,
            rows: 12,
            ariaLabel: `Edit ${st.savedName}`,
            onInput: (v) => {
              sv.text = v;
              updateStatus();
            },
          });
          updateStatus();
          parts.push(
            fk(ui.field({ label: 'Edit the list', control: refs.editorTa }), 'saved-editor'),
            h('div.row', { style: { '--gap': '8px' } },
              saveBtn,
              ui.button({
                label: 'Close',
                size: 'sm',
                variant: 'ghost',
                onClick: async () => {
                  if (sv.text !== sv.original) {
                    const ok = await ui.confirmDialog({ title: 'Discard your changes?', message: 'The changes to this list are not saved.', confirmLabel: 'Discard' });
                    if (!ok) return;
                  }
                  sv.editing = false;
                  sv.text = sv.original;
                  renderSavedBodyIfVisible();
                },
              }),
              status),
          );
        }
      } else {
        parts.push(h('div.row', { style: { '--gap': '8px' } },
          fk(ui.button({ label: 'Edit list', icon: 'pencil', size: 'sm', disabled: !exists, onClick: () => openEditor() }), 'saved-edit'),
          ui.button({ label: 'Open folder', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => api.cards.openFolder('decklist').catch((err) => ui.showError(err, { title: 'Could not open the folder' })) }),
          ui.button({ label: 'Refresh', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => loadSavedLists(true) })));
      }
      return h('div.stack', { style: { '--gap': '14px' } }, parts);
    }

    /* ---------- options section ---------- */

    function optionValue(opt) {
      const saved = st.options[st.pluginId] || {};
      return Object.prototype.hasOwnProperty.call(saved, opt.name) ? saved[opt.name] : opt.default;
    }

    function setOptionValue(opt, value) {
      st.options[st.pluginId] = { ...(st.options[st.pluginId] || {}), [opt.name]: value };
      persistSoon();
    }

    function optionControl(opt) {
      const v = optionValue(opt);
      const labels = (i, c) => (Array.isArray(opt.choiceLabels) && opt.choiceLabels[i]) || c;
      switch (opt.kind) {
        case 'flag':
          return fk(ui.toggle({ checked: v === true, label: opt.label, description: opt.help || undefined, onChange: (on) => setOptionValue(opt, on) }), `opt-${opt.name}`);
        case 'choice':
          return fk(ui.field({
            label: opt.label,
            hint: opt.help || undefined,
            control: ui.select({
              options: (opt.choices || []).map((c, i) => ({ value: c, label: labels(i, c) })),
              value: v ?? opt.default,
              onChange: (val) => setOptionValue(opt, val),
            }),
          }), `opt-${opt.name}`);
        case 'multi_choice': {
          const current = (Array.isArray(v) ? v : []).map(String);
          const order = () => {
            const vals = (Array.isArray(optionValue(opt)) ? optionValue(opt) : []).map(String);
            if (vals.length < 2) return opt.help || null;
            const names = vals.map((x) => labels((opt.choices || []).indexOf(x), x));
            return `${opt.help ? `${opt.help} ` : ''}Order: ${names.join(', then ')}.`;
          };
          const fieldEl = ui.field({
            label: opt.label,
            hint: order() || undefined,
            control: ui.multiSelectChips({
              ariaLabel: opt.label,
              options: (opt.choices || []).map((c, i) => ({ value: c, label: labels(i, c) })),
              values: current,
              onChange: (vals) => {
                const prev = (Array.isArray(optionValue(opt)) ? optionValue(opt) : []).map(String);
                const set = new Set(vals.map(String));
                const next = [...prev.filter((x) => set.has(x)), ...vals.map(String).filter((x) => !prev.includes(x))];
                setOptionValue(opt, next);
                fieldEl.setHint(order());
              },
            }),
          });
          return fk(fieldEl, `opt-${opt.name}`);
        }
        case 'multi_text': {
          const chips = ui.chipsInput({
            values: (Array.isArray(v) ? v : []).map(String),
            placeholder: opt.placeholder || 'Type and press Enter',
            ariaLabel: opt.label,
            onChange: (vals) => {
              const norm = [...new Set(vals.map((x) => (opt.lowercase ? x.toLowerCase() : x).trim()).filter(Boolean))];
              setOptionValue(opt, norm);
              if (norm.join('\n') !== vals.join('\n')) chips.setValues(norm);
            },
          });
          return fk(ui.field({ label: opt.label, hint: opt.help || undefined, control: chips }), `opt-${opt.name}`);
        }
        default:
          return fk(ui.field({
            label: opt.label,
            hint: opt.help || undefined,
            control: ui.textInput({ value: typeof v === 'string' ? v : '', onInput: (val) => setOptionValue(opt, val) }),
          }), `opt-${opt.name}`);
      }
    }

    function renderOptions() {
      const p = plugin();
      const f = fmt();
      const list = optionsFor(p, f?.id || null);
      if (!list.length) {
        swap(slots.options);
        return;
      }
      const casual = list.filter((o) => !o.advanced);
      const advanced = list.filter((o) => o.advanced);
      const children = [];
      if (casual.length) children.push(h('div.stack', { style: { '--gap': '16px' } }, casual.map(optionControl)));
      if (advanced.length) {
        const open = !!store.get('settings')?.ui?.advancedMode;
        const more = ui.section({
          title: 'More options',
          description: casual.length ? null : 'Optional. The defaults work for most decks.',
          collapsible: true,
          collapsed: !open,
          children: h('div.stack', { style: { '--gap': '16px' } }, advanced.map(optionControl)),
        });
        if (casual.length) children.push(ui.divider());
        children.push(more);
      }
      swap(slots.options, ui.section({
        title: 'Download options',
        icon: 'sliders',
        children: ui.card({ children }),
      }));
    }

    /* ---------- validation + action ---------- */

    function blocker() {
      const job = store.get('job');
      if (isJobRunning(job)) return busyMessage(job);
      const env = store.get('env');
      if (!env?.ready) return 'Finish the one-time setup first (card maker components).';
      const p = plugin();
      if (p.availability !== 'ok') return p.reason || 'This game is not available.';
      if (!fmt()) return 'This game has no deck list formats.';
      return null;
    }

    function validate() {
      const f = fmt();
      if (!f) return { message: 'Choose a list format.', focus: null };
      if (f.inputKind === 'file') {
        if (st.mode === 'saved') {
          if (st.saved.loading && !st.saved.list) return { message: 'Loading your saved lists…', focus: null, soft: true };
          if (!st.savedName) return { message: 'Choose a saved list.', focus: 'saved-select' };
          if (st.saved.list && !st.saved.list.some((x) => x.name === st.savedName)) return { message: 'Choose one of your saved lists.', focus: 'saved-select' };
          return null;
        }
        if (st.mode === 'file') return st.filePath ? null : { message: 'Choose your deck list file.', focus: 'file-choose' };
        if (!st.text.trim()) return { message: 'Paste your deck list first.', focus: 'paste-list' };
        const nameProblem = deckNameProblem(st.deckName);
        return nameProblem ? { message: nameProblem, focus: 'deck-name' } : null;
      }
      const v = String(st.inline || '').trim();
      if (!v) return { message: f.inputKind === 'url' ? 'Paste the link of your deck first.' : `Enter the ${f.label.replace(/\s*\(.*\)$/, '')} first.`, focus: 'inline' };
      if (!matchesFormatPattern(f, v)) return { message: `This doesn't look like a ${f.label.replace(/\s*\(.*\)$/, '')}.`, focus: 'inline' };
      if (st.linkName.trim() && deckNameProblem(st.linkName)) return { message: deckNameProblem(st.linkName), focus: 'deck-name' };
      return null;
    }

    function freshText() {
      const summary = store.get('cards')?.summary || {};
      const n = Number(summary.front) || 0;
      const ds = Number(summary.double_sided) || 0;
      return n
        ? `Move the ${format.pluralize(n, 'card')} currently loaded${ds ? ` (and ${format.pluralize(ds, 'unique back')})` : ''} to Recently removed first. You can put them back.`
        : 'Move the cards currently loaded to Recently removed first (none right now).';
    }

    function renderAction() {
      refs.downloadBtn = ui.button({ label: 'Download cards', icon: 'download', variant: 'primary', size: 'lg', onClick: () => startDownload() });
      refs.actionHint = h('span.small');
      refs.freshBox = fk(ui.checkbox({
        checked: st.clearBeforeFetch,
        label: 'Start fresh',
        description: freshText(),
        onChange: (on) => {
          st.clearBeforeFetch = on;
          persistSoon();
        },
      }), 'fresh');
      swap(slots.action, ui.card({
        children: [
          refs.freshBox,
          h('div.row', { style: { '--gap': '16px' } }, refs.downloadBtn, refs.actionHint),
        ],
      }));
      updateAction();
    }

    function updateAction() {
      if (!refs.downloadBtn) return;
      const job = store.get('job');
      const fetchRunning = isJobRunning(job) && job.kind === 'fetch';
      const card = refs.downloadBtn.closest('.card');
      if (card) card.hidden = fetchRunning;
      const desc = refs.freshBox.querySelector('.check-desc');
      if (desc) desc.textContent = freshText();
      const block = blocker();
      const problem = block ? null : validate();
      refs.downloadBtn.disabled = !!block;
      refs.downloadBtn.title = block || '';
      const text = block || problem?.message || 'Downloads take about one second per card.';
      refs.actionHint.textContent = text;
      refs.actionHint.className = `small ${block ? 'text-warning' : (problem && !problem.soft ? 'muted' : 'faint')}`;
    }

    function focusProblem(problem) {
      if (!problem?.focus) return;
      const holder = container.querySelector(`[data-fk="${problem.focus}"]`);
      if (!holder) return;
      holder.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const target = holder.matches('input,textarea,select,button') ? holder : holder.querySelector('textarea, input, select, button');
      setTimeout(() => target?.focus({ preventScroll: true }), 250);
    }

    let starting = false;
    async function startDownload() {
      // Enter in the link field and the button both start a download: one at a time (the job's
      // "started" event, which disables them, arrives only after the request below).
      if (starting) return;
      const block = blocker();
      if (block) {
        ui.toast({ variant: 'warning', title: block });
        return;
      }
      st.touched = true;
      updateInlineHints();
      const problem = validate();
      if (problem) {
        if (refs.nameField && problem.focus === 'deck-name') refs.nameField.setError(problem.message);
        if (!problem.soft) ui.toast({ variant: 'warning', title: problem.message, timeout: 4000 });
        focusProblem(problem);
        return;
      }
      const f = fmt();
      const p = plugin();
      starting = true;
      try {
        if (f.inputKind === 'file' && st.mode === 'saved' && st.saved.editing && st.saved.text !== st.saved.original) {
          const ok = await saveEditor({ quiet: true });
          if (!ok) return;
        }
        await persistNow();
        await sendDownload(f, p);
      } finally {
        starting = false;
      }
    }

    async function sendDownload(f, p) {
      const request = {
        plugin: p.id,
        format: f.id,
        source: buildSource(f, st),
        options: buildPluginOptions(p, f, st.options[p.id] || {}, st.inline),
        clearBeforeFetch: !!st.clearBeforeFetch,
      };
      try {
        const res = await api.fetch.start(request);
        const jobId = res && res.jobId ? String(res.jobId) : null;
        if (jobId) {
          SESSION.requests.set(jobId, {
            plugin: p.id, format: f.id, deckName: request.source.deckName || null, mode: f.inputKind === 'file' ? st.mode : f.inputKind, startedHere: true,
          });
        }
      } catch (err) {
        ui.showError(err, { title: "Couldn't start the download" });
      }
    }

    /* ---------- progress ---------- */

    let progressRefs = null;
    let elapsedTimer = null;
    ctx.onCleanup(() => clearInterval(elapsedTimer));

    function updateProgress() {
      const job = store.get('job');
      const running = isJobRunning(job) && job.kind === 'fetch';
      if (!running) {
        if (progressRefs) {
          progressRefs = null;
          clearInterval(elapsedTimer);
          elapsedTimer = null;
          swap(slots.progress);
        }
        return;
      }
      if (!progressRefs || progressRefs.jobId !== job.jobId) {
        const bar = ui.progressBar({ percent: null, label: 'Starting the download…' });
        const counts = h('span.small.muted.tabular');
        const problems = h('span.small.text-warning', { hidden: true });
        const elapsed = h('span.small.faint.tabular');
        const logView = createLogView({ height: 180, label: 'Download log', emptyText: 'Waiting for the first card…' });
        const logBox = h('div', { hidden: true }, logView.el);
        const toggle = ui.button({
          label: 'Show details', icon: 'terminal', size: 'sm', variant: 'ghost',
          onClick: () => {
            logBox.hidden = !logBox.hidden;
            toggle.setLabel(logBox.hidden ? 'Show details' : 'Hide details');
            if (!logBox.hidden) {
              logView.update(store.get('job'));
              logView.scrollToEnd();
            }
          },
        });
        const stop = ui.button({
          label: 'Stop', icon: 'square', size: 'sm',
          onClick: async () => {
            const ok = await ui.confirmDialog({ title: 'Stop the download?', message: 'Pictures downloaded so far stay in Your cards.', confirmLabel: 'Stop', cancelLabel: 'Keep going' });
            if (!ok) return;
            try {
              await api.jobs.cancel(job.jobId);
            } catch (err) {
              ui.showError(err, { title: "Couldn't stop the download" });
            }
          },
        });
        const req = SESSION.requests.get(job.jobId);
        const p = (req && plugins.find((x) => x.id === req.plugin)) || null;
        progressRefs = { jobId: job.jobId, bar, counts, problems, elapsed, logView, logBox, errors: 0, seen: 0 };
        swap(slots.progress, ui.card({
          variant: 'accent',
          icon: 'download',
          title: job.title || 'Downloading cards',
          subtitle: p ? p.displayName : null,
          actions: [stop],
          children: [
            bar,
            h('div.row', { style: { '--gap': '16px' } }, counts, problems, h('span.spacer'), elapsed),
            h('div.row', toggle),
            logBox,
          ],
        }));
        clearInterval(elapsedTimer);
        elapsedTimer = setInterval(() => tickElapsed(), 1000);
        // A download that just started (e.g. with Enter in the link field) may begin off-screen.
        if (Number.isFinite(job.startedAt) && Date.now() - job.startedAt < 5000) {
          requestAnimationFrame(() => slots.progress.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
        }
      }
      const r = progressRefs;
      const prog = job.progress || {};
      // The service appends "(N images so far)" to its label; the count line below already says it.
      const label = String(prog.label || '')
        .replace(/\s*\(\d[\d,.]*\s+images?\s+so\s+far\)\s*$/i, '')
        .replace(/^\d[\d,.]*\s+images?\s+so\s+far$/i, '')
        .trim();
      r.bar.update(Number.isFinite(prog.percent) ? prog.percent : null, label || (Number.isFinite(prog.current) && prog.current > 0 ? 'Downloading card pictures…' : 'Starting the download…'));
      const current = Number.isFinite(prog.current) ? prog.current : null;
      r.counts.textContent = current === null ? 'Looking up your cards…' : `${format.pluralize(current, 'picture')} downloaded so far${Number.isFinite(prog.total) && prog.total ? ` of ${format.formatNumber(prog.total)}` : ''}`;
      const lines = Array.isArray(job.logLines) ? job.logLines : [];
      const total = Number.isFinite(job.logTotal) ? job.logTotal : lines.length;
      if (total > r.seen) {
        const fresh = lines.slice(-Math.min(total - r.seen, lines.length));
        r.errors += fresh.filter((l) => /^\s*Error:/.test(String(l?.line ?? ''))).length;
        r.seen = total;
      }
      r.problems.hidden = !r.errors;
      r.problems.textContent = r.errors ? `${format.pluralize(r.errors, 'card')} failed so far` : '';
      if (!r.logBox.hidden) r.logView.update(job);
      tickElapsed();
    }

    function tickElapsed() {
      const job = store.get('job');
      if (!progressRefs || !job || job.jobId !== progressRefs.jobId) return;
      const started = Number(job.startedAt) || null;
      progressRefs.elapsed.textContent = started ? `${format.formatClock(Date.now() - started)} elapsed` : '';
    }

    /* ---------- result ---------- */

    let resultKey = '';

    function requestInfo(r) {
      const req = SESSION.requests.get(r.jobId);
      if (req) return req;
      const lf = store.get('settings')?.fetch?.lastFetched;
      if (lf && r.status === 'succeeded') return { plugin: lf.plugin, format: lf.format, deckName: lf.deckName, mode: null };
      return null;
    }

    function renderResult(force = false) {
      const r = store.get('lastResults')?.fetch;
      const job = store.get('job');
      const fetchRunning = isJobRunning(job) && job.kind === 'fetch';
      const visible = r && !SESSION.dismissed.has(r.jobId) && !fetchRunning;
      const req = visible ? requestInfo(r) : null;
      const key = JSON.stringify(visible ? [r.jobId, r.status, req?.plugin, req?.format, store.get('settings')?.pdf?.options,
        r.result?.previousBatchId ? SESSION.restored.get(r.result.previousBatchId) ?? null : null] : null);
      if (!force && key === resultKey) return;
      resultKey = key;
      if (!visible) {
        swap(slots.result);
        return;
      }
      swap(slots.result, r.status === 'succeeded' ? successCard(r, req) : (r.status === 'cancelled' ? cancelledCard(r) : failedCard(r, req)));
      if (req?.startedHere && !req.revealed) {
        req.revealed = true;
        requestAnimationFrame(() => slots.result.firstElementChild?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
      }
    }

    function dismiss(r) {
      SESSION.dismissed.add(r.jobId);
      renderResult(true);
    }

    function warningsOf(r) {
      return [...new Set([...(r.warnings || []), ...((r.result && Array.isArray(r.result.warnings)) ? r.result.warnings : [])]
        .map((w) => (typeof w === 'string' ? w : (w && w.message) || '')).filter(Boolean))];
    }

    function subtitleFor(r, req) {
      const p = req ? plugins.find((x) => x.id === req.plugin) : null;
      const f = p && req?.format ? p.formats.find((x) => x.id === req.format) : null;
      const deck = (r.result && typeof r.result.deckName === 'string' && r.result.deckName) || req?.deckName || null;
      return [p?.displayName, f?.label, deck, r.at ? format.formatDate(r.at) : null].filter(Boolean).join(' · ') || null;
    }

    /**
     * Bring back the game, format and list source a download used (the user may have changed them
     * since), so "Edit list" opens the list that was actually downloaded.
     * @param {object} r store `lastResults.fetch`
     */
    function restoreRequestSource(r) {
      const req = requestInfo(r);
      if (!req) return;
      const p = plugins.find((x) => x.id === req.plugin && x.availability === 'ok');
      if (!p) return;
      if (req.plugin !== st.pluginId) selectPlugin(req.plugin);
      if (req.format && req.format !== st.formatId && p.formats.some((x) => x.id === req.format)) selectFormat(req.format);
      if (fmt()?.inputKind !== 'file') return;
      if (SOURCE_MODES.includes(req.mode) && req.mode !== st.mode) {
        st.mode = req.mode;
        st.touched = false;
        persistSoon();
        renderList();
        updateAction();
      }
      const usedList = r?.result?.savedName;
      if (st.mode === 'saved' && req.mode === 'saved' && usedList && usedList !== st.savedName) {
        st.savedName = usedList;
        st.saved.editing = false;
        persistSoon();
        renderSavedBodyIfVisible();
        updateAction();
      }
    }

    function editList(r) {
      restoreRequestSource(r);
      const f = fmt();
      if (f?.inputKind === 'file') {
        if (st.mode === 'saved') {
          openEditor();
          focusProblem({ focus: 'saved-select' });
          return;
        }
        if (st.mode === 'file') {
          // The download used a copy of the chosen file in the saved lists: edit that copy.
          const name = r?.result?.savedName || baseName(r?.result?.deckPath);
          if (name) {
            st.mode = 'saved';
            st.savedName = name;
            st.saved.list = null;
            st.saved.editing = false;
            persistSoon();
            renderList();
            updateAction();
            loadSavedLists(true).then(() => {
              if (!ctx.signal.aborted && st.mode === 'saved' && st.savedName === name) openEditor();
            });
            focusProblem({ focus: 'mode' });
            return;
          }
          ui.toast({
            variant: 'info',
            title: 'Fix the list in its file',
            message: 'Open the file in the program you exported it from (or in Notepad), save it, then choose it again. You can also paste the list instead.',
            timeout: 9000,
          });
          focusProblem({ focus: 'file-choose' });
          return;
        }
        focusProblem({ focus: 'paste-list' });
        return;
      }
      focusProblem({ focus: 'inline' });
    }

    function recommendationCallout(req) {
      if (!req?.plugin || !getPlugin(req.plugin)) return null;
      const { rec, diffs } = pdfRecommendationDiff(req.plugin, req.format || null, store.get('settings')?.pdf?.options || {});
      const p = getPlugin(req.plugin);
      if (!diffs.length) {
        return h('p.small.muted.row', { style: { '--gap': '6px' } }, h('span.text-success', icon('check-circle', { size: 14 })), `Make PDF already uses the recommended settings for ${p.displayName}.`);
      }
      return ui.callout({
        variant: 'info',
        icon: 'file-pdf',
        title: `Recommended PDF settings for ${p.displayName}`,
        message: h('div.stack', { style: { '--gap': '6px' } },
          h('div', diffs.map(([k, v]) => describePdfOption(k, v)).join(' · ')),
          getRecommendedPdfNote(req.plugin, req.format || null) ? h('div.small.muted', getRecommendedPdfNote(req.plugin, req.format || null)) : null),
        actions: [{
          label: 'Apply',
          variant: 'primary',
          icon: 'check',
          onClick: async () => {
            try {
              await saveSettings(ctx, { pdf: { options: { ...rec } } });
              ui.toast({ variant: 'success', title: 'Make PDF will use the recommended settings' });
            } catch (err) {
              ui.showError(err, { title: "Couldn't change the PDF settings" });
            }
          },
        }],
      });
    }

    function successCard(r, req) {
      const sum = summarizeFetchResult(r.result);
      const p = req ? plugins.find((x) => x.id === req.plugin) : null;
      const title = sum.failed.length
        ? `${format.formatNumber(sum.cards)} of ${format.pluralize(sum.requested, 'card')} downloaded`
        : `${format.pluralize(sum.cards, 'card')} downloaded`;
      const children = [];
      const stats = [ui.stat({ label: 'Cards', value: format.formatNumber(sum.cards), icon: 'layers' })];
      if (sum.backs) stats.push(ui.stat({ label: 'Unique backs', value: format.formatNumber(sum.backs), hint: 'backs of double-faced cards' }));
      if (sum.failed.length) stats.push(ui.stat({ label: 'Not downloaded', value: format.formatNumber(sum.failedQty), variant: 'warning' }));
      if (Number.isFinite(r.durationMs)) stats.push(ui.stat({ label: 'Time', value: format.formatDuration(r.durationMs), icon: 'clock' }));
      children.push(ui.grid({ min: 130, gap: 12 }, stats));

      if (sum.failed.length) {
        const rows = sum.failed.map((c) => h('div.row.row-nowrap', { style: { '--gap': '10px', alignItems: 'baseline', padding: '6px 0', borderBottom: '1px solid var(--border)' } },
          h('span.strong', { style: { flex: '1 1 auto', minWidth: 0, overflowWrap: 'anywhere' } }, c.name || (Number.isFinite(c.index) ? `Card ${c.index}` : 'A card'),
            Number(c.quantity) > 1 ? h('span.muted', ` ×${c.quantity}`) : null),
          h('span.small.muted', { style: { flex: '0 1 55%', textAlign: 'right', overflowWrap: 'anywhere' } }, c.reason || 'could not be downloaded')));
        children.push(ui.callout({
          variant: 'warning',
          title: `${format.pluralize(sum.failed.length, 'card line')} could not be downloaded`,
          message: h('div.stack', { style: { '--gap': '8px' } },
            h('div', { style: { maxHeight: '240px', overflowY: 'auto' } }, rows),
            h('div.small.muted', 'Check the spelling and set codes, then download again (turn off “Start fresh” to keep the cards you already have).')),
          actions: [
            { label: 'Copy names', icon: 'copy', onClick: async () => { const ok = await ui.copyText(failedNamesText(sum.failed)); ui.toast({ variant: ok ? 'success' : 'warning', title: ok ? 'Names copied' : "Couldn't copy the names", timeout: 2500 }); } },
            { label: 'Edit list', icon: 'pencil', onClick: () => editList(r) },
          ],
        }));
      }

      if (sum.ignored.length) {
        const boxId = ui.uid('ignored-lines');
        const box = h('div', { id: boxId, hidden: true },
          h('div.mono.small', { style: { maxHeight: '200px', overflowY: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '10px 12px', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: 'var(--input-bg)' } },
            sum.ignored.join('\n')));
        const toggle = ui.button({
          label: `${format.pluralize(sum.ignored.length, 'line was', 'lines were')} not recognized`,
          icon: 'chevron-right',
          variant: 'ghost',
          size: 'sm',
          attrs: { 'aria-expanded': 'false', 'aria-controls': boxId },
          onClick: () => {
            box.hidden = !box.hidden;
            toggle.setAttribute('aria-expanded', String(!box.hidden));
            const lead = toggle.querySelector('.btn-lead');
            if (lead) ui.mountInto(lead, icon(box.hidden ? 'chevron-right' : 'chevron-down', { size: 14 }));
          },
        });
        children.push(h('div.stack', { style: { '--gap': '8px' } },
          h('div.row', { style: { '--gap': '8px' } }, toggle, h('span.small.faint', 'Headings and section names are normal here. Card lines listed here mean the list format may be wrong.')),
          box));
      }

      const warnings = warningsOf(r);
      if (warnings.length) children.push(ui.callout({ variant: 'info', compact: true, message: warnings.length === 1 ? warnings[0] : h('ul.prose', { style: { margin: 0 } }, warnings.map((w) => h('li', w))) }));

      const batch = r.result?.previousBatchId;
      if (batch) {
        const restored = SESSION.restored.get(batch);
        children.push(restored !== undefined
          ? h('p.small.muted', `Your previous cards were put back${restored ? ` (${format.pluralize(restored, 'card')})` : ''}.`)
          : ui.callout({
            variant: 'neutral',
            icon: 'undo',
            compact: true,
            message: 'Your previous cards were moved to Recently removed before this download. Put them back to print them together with the new ones.',
            actions: [{
              label: 'Restore previous cards',
              icon: 'undo',
              onClick: async () => {
                try {
                  const res = await api.cards.restore(batch);
                  const n = Number(res?.restored) || 0;
                  SESSION.restored.set(batch, n);
                  ui.toast({ variant: 'success', title: n ? `${format.pluralize(n, 'card')} put back` : 'Previous cards put back' });
                  const notBack = Array.isArray(res?.failed) ? res.failed.length : 0;
                  if (notBack) {
                    ui.toast({
                      variant: 'warning',
                      title: `${format.pluralize(notBack, 'file')} could not be put back`,
                      message: 'They are still in Recently removed on the Cards page.',
                      timeout: 8000,
                    });
                  }
                  ctx.refresh.cards();
                  renderResult(true);
                } catch (err) {
                  ui.showError(err, { title: "Couldn't put the cards back" });
                }
              },
            }],
          }));
      }

      if (p?.backHint) children.push(ui.callout({ variant: 'neutral', icon: 'layers', compact: true, message: p.backHint }));
      const recommendation = recommendationCallout(req);
      if (recommendation) children.push(recommendation);

      return ui.card({
        variant: sum.failed.length ? 'warning' : 'success',
        icon: sum.failed.length ? 'alert-triangle' : 'check-circle',
        title,
        subtitle: subtitleFor(r, req),
        actions: [ui.button({ icon: 'x', title: 'Hide this result', variant: 'ghost', size: 'sm', onClick: () => dismiss(r) })],
        children,
      });
    }

    function failedCard(r, req) {
      const err = r.error || {};
      const warnings = warningsOf(r);
      // Only advice the error message itself doesn't already give.
      const tips = {
        BAD_ENCODING: 'Save the list as plain text (UTF-8) from the website or app, or copy and paste it instead.',
      };
      return ui.card({
        variant: 'danger',
        icon: 'alert-circle',
        title: "The download didn't work",
        subtitle: subtitleFor(r, req),
        children: [
          h('p.prose', err.message || 'Something went wrong while downloading your cards.'),
          tips[err.code] ? h('p.small.muted', tips[err.code]) : null,
          warnings.length ? ui.callout({ variant: 'info', compact: true, message: warnings.join(' ') }) : null,
          h('div.row', { style: { '--gap': '8px' } },
            ui.button({ label: 'Try again', icon: 'refresh', variant: 'primary', disabled: !!blocker(), title: blocker() || undefined, onClick: () => startDownload() }),
            ui.button({ label: 'Edit list', icon: 'pencil', onClick: () => editList(r) }),
            ['MISSING_PACKAGES', 'PLUGIN_BROKEN'].includes(err.code) ? ui.button({ label: 'Open Settings', icon: 'settings', onClick: () => ctx.navigate('settings') }) : null,
            err.code === 'NOT_INSTALLED' ? ui.button({ label: 'Open setup', icon: 'package', onClick: () => ctx.navigate('setup') }) : null,
            err.details ? ui.button({ label: 'Copy details', icon: 'copy', variant: 'ghost', title: 'Copy the technical details for a bug report', onClick: async () => { const ok = await ui.copyText(`${err.message || ''}\n\n${err.details}`); ui.toast({ variant: ok ? 'success' : 'warning', title: ok ? 'Details copied' : "Couldn't copy the details", timeout: 2500 }); } }) : null,
            ui.button({ label: 'Dismiss', variant: 'ghost', onClick: () => dismiss(r) })),
        ],
      });
    }

    function cancelledCard(r) {
      const warnings = warningsOf(r);
      return ui.card({
        variant: 'flat',
        icon: 'ban',
        title: 'Download stopped',
        subtitle: r.at ? format.formatDate(r.at) : null,
        children: [
          h('p.small.muted', warnings.length ? warnings.join(' ') : 'Pictures downloaded before you stopped stay in Your cards.'),
          h('div.row', { style: { '--gap': '8px' } },
            ui.button({ label: 'Download again', icon: 'download', variant: 'primary', disabled: !!blocker(), title: blocker() || undefined, onClick: () => startDownload() }),
            ui.button({ label: 'Dismiss', variant: 'ghost', onClick: () => dismiss(r) })),
        ],
      });
    }

    /* ---------- next step ---------- */

    let nextKey = '';
    function renderNext() {
      const n = Number(store.get('cards')?.summary?.front) || 0;
      const running = isJobRunning(store.get('job')) && store.get('job').kind === 'fetch';
      const key = JSON.stringify([n, running]);
      if (key === nextKey) return;
      nextKey = key;
      swap(slots.next, n
        ? nextStep({
          text: `${format.pluralize(n, 'card')} ready`,
          detail: 'Check them and choose a card back, then make your PDF.',
          actionLabel: 'Review your cards',
          onAction: () => ctx.navigate('cards'),
          secondary: { label: 'Make PDF', icon: 'file-pdf', onClick: () => ctx.navigate('pdf') },
        })
        : nextStep({
          text: 'No cards yet',
          detail: 'Download a deck above, or add your own pictures in Your cards.',
          tone: 'neutral',
          icon: 'images',
          actionLabel: 'Your cards',
          onAction: () => ctx.navigate('cards'),
        }));
    }

    /* ---------- subscriptions ---------- */

    let availabilityKey = JSON.stringify(plugins.map((p) => [p.id, p.availability]));
    ctx.subscribe('introspection', (intro) => {
      plugins = mergePlugins(intro);
      const key = JSON.stringify(plugins.map((p) => [p.id, p.availability]));
      if (key === availabilityKey) return;
      availabilityKey = key;
      if (!plugins.some((p) => p.id === st.pluginId)) {
        st.pluginId = plugins[0].id;
        st.formatId = formatFor(plugins[0], null);
        renderList();
        renderOptions();
      }
      renderGame();
      updateAction();
    });
    ctx.subscribe('env', () => updateAction());
    ctx.subscribe('cards', () => {
      updateAction();
      renderNext();
    });
    ctx.subscribe('settings', () => renderResult());
    ctx.subscribe('lastResults', (r, prev) => {
      if (r?.fetch !== prev?.fetch) {
        st.saved.list = null;
        if (fmt()?.inputKind === 'file' && st.mode === 'saved') loadSavedLists(true);
      }
      renderResult();
    });
    let lastRunning = null;
    ctx.subscribe('job', frameThrottle(() => {
      if (ctx.signal.aborted) return;
      updateProgress();
      const job = store.get('job');
      const runningKey = isJobRunning(job) ? `${job.jobId}|${job.kind}` : null;
      if (runningKey !== lastRunning) {
        lastRunning = runningKey;
        updateAction();
        renderResult();
        renderNext();
        if (st.mode === 'saved' && st.saved.editing) renderSavedBodyIfVisible();
      }
    }));

    /* ---------- first render ---------- */

    renderGame();
    renderList();
    renderOptions();
    renderAction();
    updateProgress();
    renderResult(true);
    renderNext();
    if (progressRefs) {
      // Coming back while a download runs: show its progress rather than the form.
      requestAnimationFrame(() => slots.progress.firstElementChild?.scrollIntoView({ block: 'center' }));
    }
  },
};
