/**
 * Make PDF view (`#/pdf`, spec §8.4 "Make PDF", §9.8 PdfPlan, §13.3).
 *
 * Layout (ui.twoColumn):
 * - Main column: paper and card size (+ recommendation from the last download), cutting machine
 *   (changeable inline), sides, print resolution (presets annotated with client-side estimates),
 *   upscaling, "More options" (every remaining create_pdf option), output name/folder and the
 *   Create PDF button. Presets live in the page header.
 * - Sticky right column: the live plan from `scm.pdf.plan(options)`: summary, problems with
 *   one-click fixes, warnings, notices with actions, the sheet preview (click a slot to leave it
 *   empty), the cutting template and the equivalent command.
 *
 * Data flow: an option edit updates the local copy at once, persists to settings.pdf.options
 * (settings.update, optimistic) and re-plans after a 250 ms debounce; stale plan responses are
 * ignored. Skip indices are never options: they live in settings.pdf.skipByLayout[layoutKey].
 *
 * The plan fix/action contract (shared with src/main/pdf.js):
 * - errors[].fix: fixCollisions{kind} | chooseBack | resetOffset | lowerPpi{ppi} | ackNoTemplate |
 *   ignoreMemoryLimit | openCards{tab}
 * - notices[]/warnings[].action: keepBoth{fileName} | setLoadOffset{value} |
 *   applyRecommended{options} | openAlignment | openUpscale
 *
 * The page never goes blank: without a plan (service missing, components not ready) the form,
 * the sheet preview and the template still work from the introspection data.
 *
 * @module views/pdf
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { pagePreview, slotNearBottomLeftMark } from '../components/page-preview.js';
import { nextStep } from '../components/next-step.js';
import {
  CREATE_PDF_OPTIONS, CARD_SIZES, PAPER_SIZES, PPI_PRESETS, MACHINES, SKIP_HELP,
  getMachine, getCardSize, getPaperSize, resolveCardSize, resolvePaperSize,
  registrationForMachine, registrationFitsMachine, studioMachineFor,
} from '../data/option-docs.js';
import { getPlugin, getRecommendedPdf, getRecommendedPdfNote } from '../data/catalog.js';
import { EXTERNAL_LINKS } from '../data/help.js';

const { h, icon } = ui;

/* ------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/**
 * "My usual settings": the default create_pdf options (spec §4). They reproduce
 * `create_pdf.py --paper_size a4 --ppi 1440 --only_fronts --registration 4 --extend_corners 2mm --extend_edges 0.5mm`.
 */
export const USUAL_OPTIONS = Object.freeze({
  card_size: 'standard', paper_size: 'a4', registration: '4', registration_orientation: null, specialty: null,
  only_fronts: true, fit: 'stretch', fit_backs: null, crop: null, crop_backs: null,
  extend_edges: '0.5mm', extend_edges_backs: null, extend_corners: '2mm', extend_corners_backs: null,
  extend_bleed: null, extend_bleed_backs: null, ppi: 1440, quality: 100, load_offset: false,
  label: null, show_outline: false, borderless: false, output_images: false,
});

/** Every settings.pdf.options key, in the spec order. */
export const OPTION_KEYS = Object.freeze(Object.keys(USUAL_OPTIONS));

const USUAL_PRESET_NAME = 'My usual settings';
const MEMORY_BLOCK_RATIO = 0.85;
const MEMORY_HEAVY_RATIO = 0.5;
/** Spec §9.8: each JPEG page of the PDF is about 9 % of its raw bitmap; PNG pages about 30 %. */
const PDF_BYTES_FACTOR = 0.09;
const PNG_BYTES_FACTOR = 0.3;
/** Above 85 % of the computer's memory a PDF is refused anyway, so the budget never goes higher. */
const MAX_BUDGET_PERCENT = 85;
const MIN_BUDGET_PERCENT = 10;
const PLAN_DEBOUNCE_MS = 250;
const TEXT_WRITE_DELAY_MS = 350;
const TIGHT_UNSUPPORTED_PAPERS = ['a3', 'arch_b'];
const FORBIDDEN_PRESET_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
// eslint-disable-next-line no-control-regex
const INVALID_FILE_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;
const FOCUSABLE = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Remembered while the app runs (survives leaving and re-opening the page). */
const session = {
  moreOpen: false,
  machineEditing: false,
  dismissedRecommendation: new Set(),
  dismissedResults: new Set(),
  /** layout keys for which "I have my own cutting template" was ticked */
  ackNoTemplate: new Set(),
  /** `${layoutKey}|${ppi}` for which "Create anyway" was ticked */
  ignoreMemory: null,
};

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Loose equality for option values: null, undefined and '' are the same "not set".
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameValue(a, b) {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (na === nb) return true;
  try {
    return JSON.stringify(na) === JSON.stringify(nb);
  } catch {
    return false;
  }
}

/**
 * Complete create_pdf options from settings.pdf.options: unknown keys dropped, missing keys get the
 * spec defaults, card/paper aliases resolved to canonical names, registration as '3'/'4' text.
 * @param {Record<string, unknown>|null|undefined} raw
 * @returns {Record<string, any>}
 */
export function normalizeOptions(raw) {
  const out = { ...USUAL_OPTIONS };
  if (raw && typeof raw === 'object') {
    for (const key of OPTION_KEYS) {
      if (raw[key] !== undefined) out[key] = raw[key];
    }
  }
  if (typeof out.card_size === 'string') out.card_size = resolveCardSize(out.card_size) || out.card_size;
  if (typeof out.paper_size === 'string') out.paper_size = resolvePaperSize(out.paper_size) || out.paper_size;
  if (out.registration === 3 || out.registration === 4) out.registration = String(out.registration);
  if (typeof out.ppi === 'string' && /^\d+$/.test(out.ppi.trim())) out.ppi = Number(out.ppi.trim());
  for (const flag of ['only_fronts', 'load_offset', 'show_outline', 'borderless', 'output_images']) out[flag] = !!out[flag];
  return out;
}

/**
 * True when two option sets are equal for every create_pdf key.
 * @param {Record<string, any>} a
 * @param {Record<string, any>} b
 * @returns {boolean}
 */
export function sameOptions(a, b) {
  return OPTION_KEYS.every((key) => sameValue(a?.[key], b?.[key]));
}

/**
 * Layout key used by settings.pdf.skipByLayout (spec §4): `paper|card|default|borderless` or
 * `specialty:<name>`.
 * @param {Record<string, any>} o normalized options
 * @returns {string}
 */
export function layoutKeyFor(o) {
  if (o && o.specialty) return `specialty:${o.specialty}`;
  return `${o?.paper_size}|${o?.card_size}|${o?.borderless ? 'borderless' : 'default'}`;
}

/**
 * The introspection Layout for the options (spec §7), or null.
 * @param {any} introspection
 * @param {Record<string, any>} o normalized options
 * @returns {any}
 */
export function findLayout(introspection, o) {
  const layouts = introspection && introspection.layouts;
  if (!layouts || !o) return null;
  const key = layoutKeyFor(o);
  const list = o.specialty ? layouts.specialty : layouts.combos;
  return (Array.isArray(list) ? list : []).find((l) => l && l.key === key) || null;
}

/**
 * Size of one rendered PDF page in pixels at `ppi` (as-built note: the real landscape page bitmap
 * is `pageWidthPx300 × pageHeightPx300` at 300 PPI, scaled with floor()).
 * @param {any} layout
 * @param {number} ppi
 * @returns {{ width: number, height: number }|null}
 */
export function pagePixels(layout, ppi) {
  if (!layout || !Number.isFinite(ppi) || ppi <= 0) return null;
  let w300 = Number(layout.pageWidthPx300);
  let h300 = Number(layout.pageHeightPx300);
  if (!(w300 > 0 && h300 > 0)) {
    const a = Number(layout.paperWidthMm);
    const b = Number(layout.paperHeightMm);
    if (!(a > 0 && b > 0)) return null;
    w300 = Math.floor((Math.max(a, b) / 25.4) * 300);
    h300 = Math.floor((Math.min(a, b) / 25.4) * 300);
  }
  return { width: Math.floor((w300 * ppi) / 300), height: Math.floor((h300 * ppi) / 300) };
}

/**
 * Memory, file size and chunking estimate for one PDF (spec §1 measurements, §9.8 step 8):
 * peak(n) = (n × (1.5 with alignment on fronts+backs, else 1) + 6) × pageBytes; the PDF is made in
 * parts when the whole document would exceed the memory budget.
 *
 * @param {{ layout: any, ppi: number, sheets?: number, pagesPerSheet?: 1|2, loadOffset?: boolean,
 *           totalMemBytes?: number|null, budgetPercent?: number, isImages?: boolean }} input
 *           `isImages` = PNG pages instead of a PDF (bigger files).
 * @returns {{ pageBytes: number, peakBytes: number, chunks: number, sheetsPerChunk: number,
 *             pdfPages: number, pdfBytesEst: number, blocked: boolean, heavy: boolean }|null}
 */
export function estimateResources({
  layout, ppi, sheets = 1, pagesPerSheet = 1, loadOffset = false, totalMemBytes = null, budgetPercent = 50, isImages = false,
}) {
  const px = pagePixels(layout, ppi);
  if (!px) return null;
  const pageBytes = px.width * px.height * 3;
  const pps = pagesPerSheet === 2 ? 2 : 1;
  const nSheets = Math.max(1, Math.floor(Number(sheets)) || 1);
  const pdfPages = nSheets * pps;
  const factor = loadOffset ? 1.5 : 1;
  const peakFor = (pages) => (pages * factor + 6) * pageBytes;
  const total = Number(totalMemBytes) > 0 ? Number(totalMemBytes) : null;
  const pct = Math.min(Math.max(Number(budgetPercent) || 50, 1), MAX_BUDGET_PERCENT);
  const budget = total ? (pct / 100) * total : Infinity;
  let chunks = 1;
  let sheetsPerChunk = nSheets;
  let peakBytes = peakFor(pdfPages);
  if (peakBytes > budget) {
    const k = Math.floor((budget / pageBytes - 6) / (factor * pps));
    sheetsPerChunk = Math.max(1, Math.min(nSheets, k));
    chunks = Math.ceil(nSheets / sheetsPerChunk);
    peakBytes = peakFor(sheetsPerChunk * pps);
  }
  const minimum = peakFor(pps);
  return {
    pageBytes,
    peakBytes,
    chunks,
    sheetsPerChunk,
    pdfPages,
    pdfBytesEst: pdfPages * pageBytes * (isImages ? PNG_BYTES_FACTOR : PDF_BYTES_FACTOR),
    blocked: total ? minimum > MEMORY_BLOCK_RATIO * total : false,
    heavy: total ? peakBytes > MEMORY_HEAVY_RATIO * total : false,
  };
}

/**
 * File name without a trailing ".pdf" (the service adds it).
 * @param {unknown} name
 * @returns {string}
 */
export function stripPdfExtension(name) {
  return String(name ?? '').trim().replace(/\.pdf$/i, '').trim();
}

/**
 * Skip indices cleaned like the plan does (integers, unique, sorted, < per page).
 * @param {unknown} list
 * @param {number|null} [perPage]
 * @returns {number[]}
 */
export function cleanSkip(list, perPage) {
  if (!Array.isArray(list)) return [];
  const max = Number.isInteger(perPage) && perPage > 0 ? perPage : Infinity;
  return [...new Set(list.filter((i) => Number.isInteger(i) && i >= 0 && i < max))].sort((a, b) => a - b);
}

/**
 * "2mm" → "2 mm", "0.125in" → "0.125 in"; bare numbers get `bareUnit`.
 * @param {unknown} value
 * @param {string} [bareUnit]
 * @returns {string}
 */
export function lengthText(value, bareUnit = '') {
  const s = String(value ?? '').trim();
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(mm|in)$/i.exec(s);
  if (m) return `${m[1]} ${m[2].toLowerCase()}`;
  if (/^(\d+(?:\.\d+)?|\.\d+)$/.test(s)) return bareUnit === '%' ? `${s}%` : `${s}${bareUnit ? ` ${bareUnit}` : ''}`;
  return s;
}

/**
 * Plain-language clause for applying one recommended option ("use Japanese size (59 x 86 mm)").
 * @param {string} key
 * @param {unknown} value
 * @returns {string}
 */
export function recommendationClause(key, value) {
  const off = value === null || value === undefined || value === '';
  switch (key) {
    case 'card_size': {
      const info = getCardSize(String(value));
      return info ? `use ${info.label} size (${info.dimensions})` : `use the ${value} card size`;
    }
    case 'paper_size': {
      const info = getPaperSize(String(value));
      return `print on ${info ? info.shortLabel : value} paper`;
    }
    case 'crop':
      return off ? 'turn off trimming of the picture edges' : `trim ${lengthText(value, '%')} from the picture edges`;
    case 'extend_corners':
      return off ? 'turn off filling of rounded corners' : `fill rounded corners (${lengthText(value, 'px')})`;
    case 'extend_edges':
      return off ? 'turn off trimming of thin edge lines' : `trim thin edge lines (${lengthText(value, 'px')})`;
    default: {
      const doc = CREATE_PDF_OPTIONS[key];
      const label = doc ? doc.label.toLowerCase() : key.replace(/_/g, ' ');
      if (typeof value === 'boolean') return `${value ? 'turn on' : 'turn off'} “${label}”`;
      return off ? `turn off “${label}”` : `set “${label}” to ${value}`;
    }
  }
}

/**
 * Join clauses: "a", "a and b", "a, b and c" (first letter capitalized, question mark added).
 * @param {string[]} clauses
 * @returns {string}
 */
export function joinAsQuestion(clauses) {
  const list = clauses.filter(Boolean);
  if (!list.length) return '';
  const text = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}?`;
}

/**
 * Recommended PDF settings for the last downloaded deck that differ from the current options.
 * @param {any} settings
 * @param {Record<string, any>} o normalized options
 * @returns {{ id: string, plugin: any, diffs: Array<[string, any]>, note: string }|null}
 */
export function recommendationFor(settings, o) {
  const lf = settings && settings.fetch && settings.fetch.lastFetched;
  if (!lf || typeof lf.plugin !== 'string') return null;
  const plugin = getPlugin(lf.plugin);
  if (!plugin) return null;
  const rec = getRecommendedPdf(lf.plugin, lf.format || null);
  const diffs = Object.entries(rec)
    .filter(([key]) => OPTION_KEYS.includes(key) && !(key === 'card_size' && o.specialty))
    .filter(([key, value]) => !sameValue(o[key], value));
  if (!diffs.length) return null;
  return {
    id: `${lf.plugin}|${lf.format || ''}|${lf.at || ''}|${JSON.stringify(diffs)}`,
    plugin,
    diffs,
    note: getRecommendedPdfNote(lf.plugin, lf.format || null),
  };
}

/**
 * One-line description of an option set for the presets list.
 * @param {Record<string, any>} options
 * @returns {string}
 */
export function describeOptions(options) {
  const o = normalizeOptions(options);
  const paper = getPaperSize(o.paper_size);
  const card = getCardSize(o.card_size);
  const parts = [
    o.specialty ? specialtyLabel(o.specialty) : `${paper ? paper.shortLabel : o.paper_size} · ${card ? card.label : o.card_size}`,
    `${o.ppi} PPI`,
    o.only_fronts ? 'fronts only' : 'fronts and backs',
    `${o.registration === '4' ? '4' : '3'}-corner marks`,
  ];
  if (o.borderless) parts.push('tight layout');
  return parts.join(' · ');
}

/**
 * @param {string} name
 * @returns {string}
 */
function specialtyLabel(name) {
  const doc = CREATE_PDF_OPTIONS.specialty;
  const i = doc.choices.indexOf(name);
  return i >= 0 ? doc.choiceLabels[i] : String(name);
}

/**
 * Saved presets (null entries = deleted) sorted by name.
 * @param {any} settings
 * @returns {Array<{ name: string, options: Record<string, any>, at: number|null }>}
 */
export function listPresets(settings) {
  const raw = settings && settings.pdf && settings.pdf.presets;
  if (!raw || typeof raw !== 'object') return [];
  return Object.entries(raw)
    .filter(([name, value]) => name && value && typeof value === 'object')
    .map(([name, value]) => ({
      name,
      options: value.options && typeof value.options === 'object' ? value.options : value,
      at: Number.isFinite(value.at) ? value.at : null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

/**
 * File/folder name of a path (both separators).
 * @param {unknown} p
 * @returns {string}
 */
export function baseName(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Folder of a path.
 * @param {unknown} p
 * @returns {string}
 */
export function dirName(p) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * Date text for the (English) UI: "today at 2:32 PM", "Thursday at 4:20 PM"… Uses the computer's
 * English variant when it has one (en-GB → 24-hour clock), else en-US, so weekday names are never
 * in another language than the rest of the sentence.
 * @param {unknown} value Date, epoch ms or ISO string
 * @param {unknown} [appLocale] app.info().locale, e.g. 'fr-FR' or 'en-GB'
 * @returns {string}
 */
export function dateText(value, appLocale) {
  const locale = typeof appLocale === 'string' && /^en(?:-|$)/i.test(appLocale) ? appLocale : 'en-US';
  return format.formatDate(value, { locale });
}

/**
 * Short form of a long path for display: the last `segments` parts after an ellipsis
 * (`C:\Users\me\Documents\Cards` → `…\Documents\Cards`). Short paths are returned unchanged.
 * @param {unknown} p
 * @param {number} [segments]
 * @returns {string}
 */
export function shortPath(p, segments = 2) {
  const s = String(p ?? '').replace(/[\\/]+$/, '');
  const sep = s.includes('\\') ? '\\' : '/';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= segments + 1) return s;
  return `…${sep}${parts.slice(-segments).join(sep)}`;
}

/**
 * Small deep merge for optimistic local settings (objects merge, everything else replaces).
 * @param {any} a
 * @param {any} b
 * @returns {any}
 */
function mergeDeep(a, b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return b;
  const out = a && typeof a === 'object' && !Array.isArray(a) ? { ...a } : {};
  for (const [k, v] of Object.entries(b)) {
    if (v === undefined || FORBIDDEN_PRESET_NAMES.has(k)) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? mergeDeep(out[k], v) : v;
  }
  return out;
}

/**
 * Remember the focused control (by its `data-fk` holder) so it can be focused again after a part
 * of the page is re-rendered.
 * @param {Element} root
 * @returns {{ fk: string, start: number|null, end: number|null }|null}
 */
function captureFocus(root) {
  const active = document.activeElement;
  if (!active || !root || !root.contains(active)) return null;
  const holder = active.closest('[data-fk]');
  if (!holder || !root.contains(holder)) return null;
  let start = null;
  let end = null;
  try {
    if (typeof active.selectionStart === 'number') {
      start = active.selectionStart;
      end = active.selectionEnd;
    }
  } catch {
    /* inputs without selection support */
  }
  return { fk: holder.dataset.fk, start, end };
}

/**
 * @param {Element} root
 * @param {{ fk: string, start: number|null, end: number|null }|null} saved
 */
function restoreFocus(root, saved) {
  if (!saved || !root) return;
  const holder = [...root.querySelectorAll('[data-fk]')].find((el) => el.dataset.fk === saved.fk);
  if (!holder) return;
  const target = holder.matches(FOCUSABLE) ? holder : (holder.querySelector('input:checked:not([disabled])') || holder.querySelector(FOCUSABLE));
  if (!target) return;
  try {
    target.focus({ preventScroll: true });
    if (saved.start !== null && typeof target.setSelectionRange === 'function') target.setSelectionRange(saved.start, saved.end);
  } catch {
    /* ignore */
  }
}

const UNDEFINED_KEY = '\u0000undefined';

/**
 * Stable text key for a slot's dependencies. Unlike plain `JSON.stringify`, `undefined` stays
 * distinct from `null` (e.g. "still loading" vs "nothing saved"), so such changes re-render.
 * @param {unknown} value
 * @returns {string|null} null when the value can't be serialized (the slot then always re-renders)
 */
export function slotKey(value) {
  try {
    return JSON.stringify(value === undefined ? UNDEFINED_KEY : value, (_k, v) => (v === undefined ? UNDEFINED_KEY : v));
  } catch {
    return null;
  }
}

/**
 * A re-renderable part of the page: `render()` runs again only when `deps()` changes (or on force).
 * The container uses `display: contents` so its children join the parent's flex layout; the
 * focused control (marked with a `data-fk` holder, see {@link fkWrap}) gets its focus back.
 * @param {() => unknown} deps
 * @param {() => unknown} render
 * @returns {{ el: HTMLElement, refresh(force?: boolean): void }}
 */
export function createSlot(deps, render) {
  const el = h('div', { style: { display: 'contents' } });
  let lastKey;
  return {
    el,
    refresh(force = false) {
      let key = null;
      try {
        key = slotKey(deps());
      } catch {
        key = null;
      }
      if (!force && key !== null && key === lastKey) return;
      lastKey = key;
      const saved = captureFocus(el);
      let content;
      try {
        content = render();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[views] could not render part of the page', err);
        content = ui.callout({ variant: 'danger', compact: true, message: 'This part of the page could not be shown. Try leaving the page and coming back.' });
      }
      ui.mountInto(el, content);
      restoreFocus(el, saved);
    },
  };
}

/**
 * Holder that lets a control get its focus back after a re-render (see {@link createSlot}).
 * @param {string} fk unique key within the page
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function fkWrap(fk, ...children) {
  return h('div', { dataset: { fk } }, children);
}

/* ------------------------------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------------------------- */

export default {
  id: 'pdf',
  title: 'Make PDF',
  icon: 'file-pdf',

  /**
   * @param {HTMLElement} container
   * @param {any} ctx view context (spec §13.3)
   * @returns {() => void}
   */
  mount(container, ctx) {
    const { api, store } = ctx;
    const navigate = (id, params) => ctx.navigate(id, params);

    let settings = store.get('settings') || null;
    let opts = normalizeOptions(settings?.pdf?.options);
    let ppiMode = PPI_PRESETS.some((p) => p.value === opts.ppi) ? 'preset' : 'custom';

    /** @type {any} */
    let plan = null;
    /** @type {{ message: string, code: string|null }|null} */
    let planError = null;
    let planInFlight = false;
    let planSlow = false;
    let planSeq = 0;
    let planTimer = null;
    let planSlowTimer = null;
    /** @type {Promise<void>|null} */
    let planPromise = null;

    /** undefined = not loaded yet; null = no alignment saved */
    let offsetInfo;
    /** @type {{ url: string, name: string }|null} */
    let backImage = null;
    let backImageKey = '';
    let disposed = false;
    /** The side column is shown below the options (narrow window): problems are far down the page. */
    let stacked = false;
    /** @type {ResizeObserver|null} */
    let resizeObserver = null;

    /** @type {Array<{ refresh(force?: boolean): void }>} */
    let slots = [];
    /** @type {Record<string, any>} */
    let refs = {};
    /** @type {HTMLElement|null} */
    let preview = null;

    const writeTimers = new Map();
    let writesInFlight = 0;

    /* ------------------------------ settings writes ------------------------------ */

    const pendingWrites = () => writesInFlight + writeTimers.size;

    function sendWrite(patch) {
      writesInFlight += 1;
      return Promise.resolve()
        .then(() => api.settings.update(patch))
        .catch((err) => {
          if (!disposed) ui.showError(err, { title: 'Could not save this setting' });
        })
        .finally(() => {
          writesInFlight -= 1;
          if (!disposed && pendingWrites() === 0) {
            const latest = store.get('settings');
            if (latest) applyIncomingSettings(latest);
          }
        });
    }

    /**
     * Persist a settings patch: applied to the local copy at once, sent now or after `delay` ms
     * (one pending write per `key`).
     * @param {object} patch
     * @param {{ key?: string, delay?: number }} [options]
     */
    function updateSettings(patch, { key, delay = 0 } = {}) {
      settings = mergeDeep(settings || {}, patch);
      if (key) {
        const prev = writeTimers.get(key);
        if (prev) clearTimeout(prev.timer);
        writeTimers.delete(key);
      }
      if (key && delay > 0) {
        const entry = { patch, timer: null };
        entry.timer = setTimeout(() => {
          if (writeTimers.get(key) === entry) writeTimers.delete(key);
          sendWrite(patch);
        }, delay);
        writeTimers.set(key, entry);
        return Promise.resolve();
      }
      return sendWrite(patch);
    }

    function flushWrites() {
      const entries = [...writeTimers.values()];
      writeTimers.clear();
      return Promise.all(entries.map((e) => {
        clearTimeout(e.timer);
        return sendWrite(e.patch);
      }));
    }

    function planInputsKey(s) {
      if (!s) return '';
      const p = s.pdf || {};
      return JSON.stringify([p.printBackFaces, p.fileName, p.skipByLayout, p.memoryBudgetPercent, s.outputDir,
        s.upscayl, s.cards, s.equipment, s.fetch && s.fetch.lastFetched, p.lastPdf]);
    }

    function applyIncomingSettings(next) {
      if (!next || disposed) return;
      const prev = settings;
      settings = next;
      const incoming = normalizeOptions(next.pdf?.options);
      const external = !sameOptions(incoming, opts);
      if (external) {
        const sidesChanged = incoming.only_fronts !== opts.only_fronts;
        opts = incoming;
        ppiMode = PPI_PRESETS.some((p) => p.value === opts.ppi) ? 'preset' : 'custom';
        rebuild();
        if (sidesChanged) loadBackImage();
      } else {
        refresh();
      }
      if (external || planInputsKey(prev) !== planInputsKey(next)) schedulePlan();
    }

    /**
     * Change one create_pdf option (local first, then persisted and re-planned).
     * @param {string} key
     * @param {unknown} value
     * @param {{ textual?: boolean }} [options] textual = typed values (debounced write)
     */
    function setOption(key, value, { textual = false } = {}) {
      if (sameValue(opts[key], value)) return;
      opts = { ...opts, [key]: value };
      updateSettings({ pdf: { options: { [key]: value } } }, { key: `opt:${key}`, delay: textual ? TEXT_WRITE_DELAY_MS : 0 });
      refresh();
      schedulePlan();
    }

    function setOptions(patch) {
      const changed = Object.entries(patch).filter(([k, v]) => !sameValue(opts[k], v));
      if (!changed.length) return;
      opts = { ...opts, ...Object.fromEntries(changed) };
      if ('ppi' in patch) ppiMode = PPI_PRESETS.some((p) => p.value === opts.ppi) ? 'preset' : 'custom';
      for (const [k] of changed) {
        const prev = writeTimers.get(`opt:${k}`);
        if (prev) {
          clearTimeout(prev.timer);
          writeTimers.delete(`opt:${k}`);
        }
      }
      updateSettings({ pdf: { options: Object.fromEntries(changed) } });
      rebuild();
      schedulePlan(0);
      if (changed.some(([k]) => k === 'only_fronts')) loadBackImage();
    }

    function setPpi(value) {
      ppiMode = PPI_PRESETS.some((p) => p.value === value) ? 'preset' : 'custom';
      setOption('ppi', value);
      refresh();
    }

    /* ------------------------------ derived state ------------------------------ */

    const introspection = () => store.get('introspection') || null;
    const summary = () => store.get('cards')?.summary || null;
    const env = () => store.get('env') || null;
    const job = () => store.get('job') || null;
    const runningJob = () => {
      const j = job();
      return j && j.status === 'running' ? j : null;
    };
    const pdfJobRunning = () => runningJob()?.kind === 'pdf';
    const totalMem = () => plan?.resources?.totalMemBytes || store.get('appInfo')?.totalMemBytes || null;
    const budgetPercent = () => {
      const v = Number(settings?.pdf?.memoryBudgetPercent);
      return Number.isFinite(v) && v > 0 ? Math.min(v, MAX_BUDGET_PERCENT) : 50;
    };
    const upscaylFound = () => !!env()?.upscayl?.found;
    const upscaleWanted = () => upscaylFound() && settings?.upscayl?.enabled !== false;
    const currentLayout = () => plan?.layout || findLayout(introspection(), opts);
    const currentLayoutKey = () => plan?.layoutKey || layoutKeyFor(opts);
    const perPage = () => {
      const p = plan?.perPage ?? currentLayout()?.cardsPerPage;
      return Number.isInteger(p) && p > 0 ? p : null;
    };
    const currentSkip = () => cleanSkip(settings?.pdf?.skipByLayout?.[currentLayoutKey()], perPage());
    const ackNoTemplate = () => session.ackNoTemplate.has(currentLayoutKey());
    const ignoreMemory = () => session.ignoreMemory === `${currentLayoutKey()}|${opts.ppi}`;
    const machine = () => getMachine(settings?.equipment?.machine || null);
    const validOffset = () => (offsetInfo && offsetInfo.valid !== false && Number.isFinite(Number(offsetInfo.x_offset)) ? offsetInfo : null);
    const offsetNonZero = () => {
      const o = validOffset();
      return !!o && (Number(o.x_offset) !== 0 || Number(o.y_offset) !== 0 || Number(o.angle_offset || 0) !== 0);
    };

    function buildRequest(extra = {}) {
      const fileName = stripPdfExtension(settings?.pdf?.fileName || '');
      return {
        ...opts,
        upscale: upscaleWanted(),
        fileName: fileName || null,
        outputDir: settings?.outputDir || null,
        ackNoTemplate: ackNoTemplate(),
        ignoreMemoryLimit: ignoreMemory(),
        printBackFaces: settings?.pdf?.printBackFaces !== false,
        ...extra,
      };
    }

    /* ------------------------------ planning ------------------------------ */

    function schedulePlan(delay = PLAN_DEBOUNCE_MS) {
      if (disposed) return;
      clearTimeout(planTimer);
      planTimer = setTimeout(() => {
        planTimer = null;
        runPlan();
      }, delay);
    }

    function runPlan() {
      if (disposed) return Promise.resolve();
      clearTimeout(planTimer);
      planTimer = null;
      const seq = ++planSeq;
      planInFlight = true;
      clearTimeout(planSlowTimer);
      planSlowTimer = setTimeout(() => {
        if (seq === planSeq && planInFlight) {
          planSlow = true;
          refresh();
        }
      }, 350);
      const p = (async () => {
        try {
          const result = await api.pdf.plan(buildRequest());
          if (disposed || seq !== planSeq) return;
          plan = result && typeof result === 'object' ? result : null;
          planError = plan ? null : { message: 'The card maker returned no plan.', code: null };
        } catch (err) {
          if (disposed || seq !== planSeq) return;
          planError = { message: api.errorMessage(err), code: api.errorCode(err) };
        } finally {
          if (!disposed && seq === planSeq) {
            planInFlight = false;
            planSlow = false;
            clearTimeout(planSlowTimer);
            refresh();
          }
        }
      })();
      planPromise = p;
      return p;
    }

    /** Make sure the plan reflects the latest options (used before creating the PDF). */
    async function freshPlan() {
      if (planTimer || planInFlight) {
        if (planTimer) await runPlan();
        else if (planPromise) await planPromise;
        // `disposed`: after unmount runPlan never clears planInFlight, and awaiting the settled
        // promise again would spin forever in microtasks (frozen window).
        while (!disposed && planInFlight && planPromise) await planPromise;
      }
    }

    /* ------------------------------ data loading ------------------------------ */

    async function loadOffset() {
      try {
        const v = await api.offset.get();
        if (disposed) return;
        offsetInfo = v && typeof v === 'object' ? v : null;
      } catch {
        if (disposed) return;
        offsetInfo = { valid: false, error: 'unavailable', unavailable: true };
      }
      refresh();
    }

    async function loadBackImage() {
      const s = summary();
      const effective = s?.back?.effective || null;
      const key = `${effective}|${store.get('cards')?.version || 0}`;
      if (!effective || opts.only_fronts) {
        backImage = null;
        // Not loaded: switching to "Fronts and backs" later must fetch the thumbnail.
        backImageKey = '';
        return;
      }
      if (key === backImageKey) return;
      backImageKey = key;
      try {
        const list = await api.cards.list('back');
        if (disposed || key !== backImageKey) return; // a newer load (or "Fronts only") took over
        const images = Array.isArray(list?.images) ? list.images : [];
        const img = images.find((i) => i && (i.rel === effective || i.name === effective)) || null;
        backImage = img && img.url ? { url: img.url, name: img.name || effective } : null;
      } catch {
        if (disposed || key !== backImageKey) return;
        backImage = null;
      }
      refresh();
    }

    /* ------------------------------ actions ------------------------------ */

    async function fixCollisions(kind) {
      const res = await api.cards.fixCollisions(kind);
      const n = Array.isArray(res?.renamed) ? res.renamed.length : 0;
      ui.toast({
        variant: 'success',
        title: n ? `Renamed ${format.pluralize(n, 'image')}` : 'Names are already unique',
        message: n ? 'Every card now has its own file name, so all of them will be printed.' : undefined,
      });
      await ctx.refresh?.cards?.();
      schedulePlan(0);
    }

    /**
     * Write 0, 0, 0 as the printer alignment (plan fix 'resetOffset').
     * @param {{ confirm?: boolean }} [options] confirm first (a saved, damaged alignment is replaced)
     */
    async function resetOffset({ confirm = true } = {}) {
      if (confirm) {
        const ok = await ui.confirmDialog({
          title: 'Reset your printer alignment?',
          message: 'The saved alignment goes back to 0, 0, 0 (no correction). You can measure it again in Printer alignment.',
          confirmLabel: 'Reset alignment',
        });
        if (!ok) return;
      }
      await api.offset.reset();
      ui.toast({ variant: 'success', title: confirm ? 'Printer alignment reset to 0, 0, 0' : 'Using no correction (0, 0, 0) for now' });
      await loadOffset();
      schedulePlan(0);
    }

    function setAckNoTemplate(on) {
      const key = currentLayoutKey();
      if (on) session.ackNoTemplate.add(key);
      else session.ackNoTemplate.delete(key);
      refresh();
      schedulePlan(0);
    }

    function setIgnoreMemory(on) {
      session.ignoreMemory = on ? `${currentLayoutKey()}|${opts.ppi}` : null;
      refresh();
      schedulePlan(0);
    }

    function writeSkip(list) {
      const key = currentLayoutKey();
      updateSettings({ pdf: { skipByLayout: { [key]: cleanSkip(list, perPage()) } } });
      refresh();
      schedulePlan(150);
    }

    function toggleSkip(index) {
      const current = currentSkip();
      writeSkip(current.includes(index) ? current.filter((i) => i !== index) : [...current, index]);
    }

    function setFileName(value) {
      if (INVALID_FILE_CHARS.test(value)) {
        updateRefs(); // shows the error; nothing is saved until the name is valid
        return;
      }
      const name = stripPdfExtension(value);
      updateSettings({ pdf: { fileName: name || null } }, { key: 'fileName', delay: TEXT_WRITE_DELAY_MS });
      updateRefs();
      schedulePlan(TEXT_WRITE_DELAY_MS);
    }

    async function chooseFolder() {
      const dir = await api.dialog.openFolder({ purpose: 'output', title: 'Choose where to save your PDFs' });
      if (!dir) return;
      await updateSettings({ outputDir: dir });
      updateRefs();
      schedulePlan(0);
    }

    async function resetFolder() {
      await updateSettings({ outputDir: null });
      updateRefs();
      schedulePlan(0);
    }

    async function openFolder() {
      const dir = plan?.output?.dir || settings?.outputDir || store.get('appInfo')?.paths?.output;
      if (!dir) return;
      await api.shell.openPath(dir);
    }

    function setUpscale(on) {
      updateSettings({ upscayl: on ? { enabled: true, askedOnce: true } : { enabled: false } });
      refresh();
      schedulePlan(0);
    }

    async function openTemplate(file) {
      const res = await api.print.openTemplate(file);
      if (res && res.opened === false) {
        ui.toast({
          variant: 'warning',
          title: 'The cutting template could not be opened',
          message: res.error || "Silhouette Studio doesn't seem to be installed.",
          actions: [{ label: EXTERNAL_LINKS.silhouetteStudio.label, onClick: () => api.shell.openExternal(EXTERNAL_LINKS.silhouetteStudio.url) }],
          timeout: 10000,
        });
        return;
      }
      ui.toast({
        variant: 'success',
        title: 'Opening the cutting template',
        message: res?.copiedTo ? `A copy was saved in ${dirName(res.copiedTo)}.` : 'It opens in Silhouette Studio.',
      });
    }

    async function createPdf() {
      const running = runningJob();
      if (running) {
        ui.toast({ variant: 'info', title: `Please wait until “${running.title || 'the current task'}” finishes.` });
        return;
      }
      await flushWrites();
      await freshPlan();
      if (disposed) return;
      if (!plan || !plan.ok) {
        ui.toast({
          variant: 'warning',
          title: plan ? 'Fix the problems first' : 'Your settings could not be checked',
          message: plan ? `${format.pluralize((plan.errors || []).length, 'problem')} must be fixed before the PDF can be made.` : (planError?.message || undefined),
        });
        return;
      }
      let upscale = upscaleWanted();
      const up = plan.upscale;
      if (upscale && !settings?.upscayl?.askedOnce && up && Number(up.needed) > 0) {
        const time = Number(up.secEst) > 0 ? format.formatDuration(up.secEst * 1000, { approximate: true }) : null;
        const ok = await ui.confirmDialog({
          title: 'Upscayl found. Upscale for sharper prints?',
          message: `${format.pluralize(Number(up.needed), 'picture')} would be enlarged before they are placed${time ? `: ${time} the first time` : ''}. The results are kept, so the next PDFs are quicker.`,
          confirmLabel: 'Upscale',
          cancelLabel: 'Use the original pictures',
        });
        if (disposed) return;
        updateSettings({ upscayl: ok ? { askedOnce: true } : { askedOnce: true, enabled: false } });
        if (!ok) upscale = false;
      }
      await api.pdf.start(buildRequest({ upscale }));
      refresh();
    }

    /* ------------------------------ presets ------------------------------ */

    function applyPreset(name, options) {
      const next = normalizeOptions({ ...USUAL_OPTIONS, ...(options || {}) });
      setOptions(next);
      ui.toast({ variant: 'success', title: `Applied “${name}”` });
    }

    function openPresets() {
      const body = h('div.stack', { style: { '--gap': '16px' } });
      let nameInput = null;
      let nameField = null;
      let dialog = null;

      const savePreset = async () => {
        const name = String(nameInput?.value || '').trim().replace(/\s+/g, ' ');
        if (!name) {
          nameField.setError('Type a name for the preset.');
          return;
        }
        if (name.length > 60) {
          nameField.setError('Keep the name under 60 characters.');
          return;
        }
        if (FORBIDDEN_PRESET_NAMES.has(name) || name.toLowerCase() === USUAL_PRESET_NAME.toLowerCase()) {
          nameField.setError('This name is reserved. Choose another one.');
          return;
        }
        const exists = listPresets(settings).some((p) => p.name === name);
        if (exists) {
          const ok = await ui.confirmDialog({ title: `Replace “${name}”?`, message: 'The preset will remember the options currently on this page instead.', confirmLabel: 'Replace' });
          if (!ok) return;
        }
        await updateSettings({ pdf: { presets: { [name]: { options: { ...opts }, at: Date.now() } } } });
        ui.toast({ variant: 'success', title: `Saved “${name}”` });
        renderBody();
      };

      const deletePreset = async (name) => {
        const ok = await ui.confirmDialog({ title: `Delete “${name}”?`, message: 'Your current options stay as they are.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        await updateSettings({ pdf: { presets: { [name]: null } } });
        renderBody();
      };

      const row = (name, options, builtIn) => ui.card({
        variant: 'flat',
        title: h('span.row', { style: { '--gap': '8px' } }, h('span', name), builtIn ? ui.badge('Built in', 'neutral') : null,
          sameOptions(normalizeOptions(options), opts) ? ui.badge('Current', 'success', { icon: 'check' }) : null),
        subtitle: describeOptions(options),
        actions: [
          ui.button({ label: 'Apply', size: 'sm', variant: 'primary', onClick: () => { dialog?.close(); applyPreset(name, options); } }),
          builtIn ? null : ui.button({ icon: 'trash', size: 'sm', variant: 'ghost', title: `Delete “${name}”`, onClick: () => deletePreset(name) }),
        ],
      });

      function renderBody() {
        nameInput = ui.textInput({ placeholder: 'For example: Yu-Gi-Oh! test prints', maxLength: 80, onEnter: () => savePreset(), ariaLabel: 'Preset name' });
        nameField = ui.field({
          label: 'Save the current options as a preset',
          hint: 'Presets remember every option on this page, not your cards, file name or folder.',
          control: ui.row({ wrap: false, gap: 8 }, h('div', { style: { flex: '1', minWidth: '0' } }, nameInput),
            ui.button({ label: 'Save', icon: 'save', onClick: savePreset })),
        });
        nameInput.style.width = '100%';
        const list = listPresets(settings);
        ui.mountInto(body,
          h('div.stack', { style: { '--gap': '8px' } },
            row(USUAL_PRESET_NAME, USUAL_OPTIONS, true),
            list.map((p) => row(p.name, p.options, false))),
          ui.divider(),
          nameField);
      }

      renderBody();
      dialog = ui.modal({ title: 'Presets', content: body, actions: [{ label: 'Close' }] });
    }

    /* ------------------------------ command modal ------------------------------ */

    function openCommand() {
      if (!plan || !plan.display) return;
      const note = plan.displayEquivalent === false
        ? (plan.displayNote || 'The app runs this on a prepared copy of your images, so it is not exactly the same command.')
        : null;
      ui.modal({
        title: 'Equivalent command',
        wide: true,
        content: h('div.stack', { style: { '--gap': '12px' } },
          h('p.small.muted', 'This is the card maker command your settings correspond to. You never need to type it: the app runs it for you. It is useful when you ask for help.'),
          h('pre.mono.small', {
            style: {
              margin: '0', padding: '12px 14px', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', background: 'var(--input-bg)',
              border: '1px solid var(--border)', borderRadius: '8px', maxHeight: '40vh', overflow: 'auto',
            },
          }, plan.display),
          note && ui.callout({ variant: 'info', compact: true, message: note })),
        actions: [
          { label: 'Close' },
          {
            label: 'Copy',
            icon: 'copy',
            variant: 'primary',
            onClick: async () => {
              const ok = await ui.copyText(plan.display);
              ui.toast({ variant: ok ? 'success' : 'warning', title: ok ? 'Command copied' : 'Could not copy the command', timeout: 2500 });
              return false;
            },
          },
        ],
      });
    }

    /* ------------------------------ main column parts ------------------------------ */

    function renderResult() {
      const r = store.get('lastResults')?.pdf;
      if (!r || session.dismissedResults.has(r.jobId)) return null;
      if (runningJob()?.kind === 'pdf') return null; // a new PDF is being made: the progress card shows

      const dismiss = ui.button({
        icon: 'x', size: 'sm', variant: 'ghost', title: 'Dismiss',
        onClick: () => {
          session.dismissedResults.add(r.jobId);
          refresh();
        },
      });
      if (r.status === 'failed') {
        const actions = [];
        if (r.error?.code === 'OUT_OF_MEMORY') {
          const lower = [...PPI_PRESETS].reverse().find((p) => p.value < opts.ppi);
          if (lower) actions.push({ label: `Use ${lower.value} PPI`, icon: 'gauge', variant: 'primary', onClick: () => setPpi(lower.value) });
        }
        actions.push({ label: 'Try again', icon: 'refresh', onClick: () => createPdf() });
        return h('div', { dataset: { fk: 'result' } }, ui.callout({
          variant: 'danger',
          title: 'The PDF could not be made',
          message: r.error?.message || 'Open Details in the bar at the bottom to see what happened.',
          actions,
          onDismiss: () => {
            session.dismissedResults.add(r.jobId);
            refresh();
          },
        }));
      }
      if (r.status !== 'succeeded') return null;
      const res = r.result && typeof r.result === 'object' ? r.result : {};
      const outPath = res.pdfPath || res.outputPath || res.imagesDir || res.outputDir || null;
      const isImages = typeof res.isImages === 'boolean'
        ? res.isImages
        : !!(res.imagesDir || res.outputDir) || !!(outPath && !/\.pdf$/i.test(outPath));
      const rows = [];
      if (outPath) rows.push(['Saved in', h('span', { title: dirName(outPath) }, shortPath(dirName(outPath), 1))]);
      if (Number.isFinite(res.sizeBytes)) rows.push(['Size', format.formatBytes(res.sizeBytes)]);
      if (Number.isFinite(res.pages)) {
        rows.push(['Pages', Number.isFinite(res.sheets) && res.sheets !== res.pages
          ? `${format.pluralize(res.pages, 'page')} (${format.pluralize(res.sheets, 'sheet')})`
          : format.pluralize(res.pages, 'page')]);
      }
      const duration = Number.isFinite(res.durationMs) ? res.durationMs : r.durationMs;
      if (Number.isFinite(duration)) rows.push(['Made in', format.formatDuration(duration)]);
      if (Number(res.chunks) > 1) rows.push(['Parts', `Made in ${res.chunks} parts and joined automatically`]);
      const up = res.upscaled;
      if (typeof up === 'number' && up > 0) rows.push(['Upscaled', format.pluralize(up, 'picture')]);
      else if (up && typeof up === 'object' && (Number(up.upscaled) > 0 || Number(up.cached) > 0)) {
        const parts = [];
        if (Number(up.upscaled) > 0) parts.push(`${format.pluralize(Number(up.upscaled), 'picture')} upscaled`);
        if (Number(up.cached) > 0) parts.push(`${format.formatNumber(Number(up.cached))} reused from earlier`);
        if (Number(up.fallbacks) > 0) parts.push(`${format.formatNumber(Number(up.fallbacks))} kept as they were`);
        rows.push(['Upscaling', parts.join(' · ')]);
      }
      const warnings = (r.warnings && r.warnings.length ? r.warnings : (Array.isArray(res.warnings) ? res.warnings : []))
        .map((w) => (typeof w === 'string' ? w : w?.message)).filter(Boolean);
      return h('div', { dataset: { fk: 'result' } }, ui.card({
        variant: 'success',
        icon: 'file-check',
        title: isImages ? 'Your PNG pages are ready' : 'Your PDF is ready',
        subtitle: outPath ? baseName(outPath) : undefined,
        actions: [dismiss],
        children: [
          rows.length ? ui.kv(rows) : null,
          warnings.length ? ui.callout({
            variant: 'warning',
            compact: true,
            title: format.pluralize(warnings.length, 'thing') + ' to know',
            message: h('ul.prose.small', { style: { margin: '0', paddingLeft: '18px' } }, warnings.map((w) => h('li', w))),
          }) : null,
          outPath ? ui.row({ gap: 8 },
            fkWrap('result-open', ui.button({ label: isImages ? 'Open folder' : 'Open PDF', icon: isImages ? 'folder-open' : 'file-pdf', variant: 'primary', onClick: () => api.shell.openPath(outPath) })),
            isImages ? null : fkWrap('result-show', ui.button({ label: 'Show in folder', icon: 'folder-open', onClick: () => api.shell.showItemInFolder(outPath) }))) : null,
          h('div', fkWrap('result-next', ui.button({ label: 'Next: Print & cut', iconRight: 'arrow-right', variant: 'link', size: 'sm', onClick: () => navigate('print') }))),
        ],
      }));
    }

    function renderRecommendation() {
      const rec = recommendationFor(settings, opts);
      if (!rec || session.dismissedRecommendation.has(rec.id)) return null;
      const clauses = rec.diffs.map(([key, value]) => recommendationClause(key, value));
      return h('div', { dataset: { fk: 'recommendation' } }, ui.callout({
        variant: 'accent',
        icon: 'sparkles',
        title: `Your cards come from ${rec.plugin.displayName}`,
        message: h('span', joinAsQuestion(clauses), rec.note ? h('span.muted', ` ${rec.note}`) : null),
        actions: [
          { label: 'Apply', variant: 'primary', onClick: () => setOptions(Object.fromEntries(rec.diffs)) },
          { label: 'Not now', variant: 'ghost', onClick: () => { session.dismissedRecommendation.add(rec.id); refresh(); } },
        ],
      }));
    }

    function paperOptions() {
      return PAPER_SIZES.map((p) => ({ value: p.name, label: p.label, description: `${p.region}. Needs a ${p.mat} cutting mat.` }));
    }

    function cardOptions() {
      const intro = introspection();
      const combos = intro?.layouts?.combos;
      const hasCombo = (card) => !Array.isArray(combos) || !combos.length
        || combos.some((l) => l && l.paper === opts.paper_size && l.card === card && l.variant === 'default');
      const known = new Set(CARD_SIZES.map((c) => c.name));
      const mk = (c) => ({ value: c.name, label: `${c.label} (${c.dimensions})`, description: hasCombo(c.name) ? c.games : `Not available on ${getPaperSize(opts.paper_size)?.shortLabel || 'this paper'}.`, disabled: !hasCombo(c.name) && c.name !== opts.card_size });
      const extra = (Array.isArray(intro?.layouts?.cardSizes) ? intro.layouts.cardSizes : [])
        .filter((c) => c && typeof c.name === 'string' && !known.has(c.name))
        .map((c) => ({
          value: c.name,
          label: `${c.name.replace(/_/g, ' ').replace(/^\w/, (x) => x.toUpperCase())} (${format.formatNumber(c.widthMm)} x ${format.formatNumber(c.heightMm)} mm)`,
          description: 'A card size added to your card maker.',
          disabled: !hasCombo(c.name) && c.name !== opts.card_size,
        }));
      return [
        { group: 'Common sizes', options: CARD_SIZES.filter((c) => c.common).map(mk) },
        { group: 'Other sizes', options: [...CARD_SIZES.filter((c) => !c.common).map(mk), ...extra] },
      ];
    }

    function renderPaperExtras() {
      const out = [];
      if (opts.specialty) {
        out.push(ui.callout({
          variant: 'info',
          compact: true,
          message: `${specialtyLabel(opts.specialty)} is selected under More options. It replaces the paper and card size.`,
          actions: [{ label: 'Turn it off', onClick: () => setOption('specialty', null) }],
        }));
      }
      const m = machine();
      if (m && Array.isArray(m.supportedPapers) && !m.supportedPapers.includes(opts.paper_size) && m.paperWarning) {
        out.push(ui.callout({ variant: 'warning', compact: true, message: m.paperWarning }));
      }
      return out;
    }

    function renderMachine() {
      const m = machine();
      const reg = opts.registration === '4' ? '4' : '3';
      const marks = reg === '4' ? '4-corner marks' : '3-corner marks';
      if (session.machineEditing) {
        const id = settings?.equipment?.machine || null;
        const machineSelect = ui.select({
          value: id,
          placeholder: 'Choose your cutting machine…',
          options: MACHINES.map((x) => ({ value: x.id, label: x.label, description: x.description })),
          onChange: (value) => {
            updateSettings({ equipment: { machine: value } });
            setOption('registration', registrationForMachine(value));
            refresh(true);
          },
        });
        const parts = [ui.field({ label: 'Cutting machine', control: fkWrap('machine-select', machineSelect) })];
        if (m && m.alternative) {
          parts.push(ui.field({
            label: 'Registration marks',
            hint: reg === m.alternative.registration ? `Then select “${m.alternative.studioMachine}” as the machine in Silhouette Studio.` : `Select “${m.studioMachine}” as the machine in Silhouette Studio.`,
            control: fkWrap('machine-marks', ui.segmented({
              value: reg,
              options: [
                { value: m.registration, label: m.registration === '4' ? '4-corner marks' : '3-corner marks' },
                { value: m.alternative.registration, label: `${m.alternative.registration}-corner marks (often more reliable)` },
              ],
              onChange: (value) => setOption('registration', value),
            })),
          }));
        }
        parts.push(ui.row({ justify: 'end' }, ui.button({ label: 'Done', size: 'sm', onClick: () => { session.machineEditing = false; refresh(true); } })));
        return h('div.stack', { style: { '--gap': '12px' } }, parts);
      }
      const fits = registrationFitsMachine(m ? m.id : null, reg);
      return h('div.stack', { style: { '--gap': '10px' } },
        ui.row({ gap: 12, wrap: false },
          h('div.stack', { style: { '--gap': '2px', flex: '1', minWidth: '0' } },
            h('div.strong', m ? `${m.label}  →  ${marks}` : `No cutting machine chosen · ${marks}`),
            h('div.small.muted', m
              ? `Select “${studioMachineFor(m.id, reg)}” as the machine in Silhouette Studio.`
              : 'Tell the app which Silhouette you use, so the marks match it.')),
          fkWrap('machine-change', ui.button({ label: m ? 'Change' : 'Choose', size: 'sm', icon: 'pencil', onClick: () => { session.machineEditing = true; refresh(true); } }))),
        !fits && m ? ui.callout({
          variant: 'warning',
          compact: true,
          message: `Your ${m.label} can't read ${marks}.`,
          actions: [{ label: `Use ${m.registration}-corner marks`, onClick: () => setOption('registration', m.registration) }],
        }) : null);
    }

    function renderSidesExtras() {
      const s = summary();
      const ds = Number(s?.double_sided) || 0;
      if (opts.only_fronts) {
        if (ds > 0) {
          return fkWrap('backfaces', ui.toggle({
            checked: settings?.pdf?.printBackFaces !== false,
            label: `Also print the ${format.pluralize(ds, 'back face')} as separate cards`,
            description: 'Your double-faced cards then come out as two cards each (front and back), to cut out separately.',
            onChange: (v) => {
              updateSettings({ pdf: { printBackFaces: v } });
              refresh();
              schedulePlan(0);
            },
          }));
        }
        return h('p.small.muted', 'Only the card fronts are printed. Choose “Fronts and backs” to print a back on every card (needs a printer that prints both sides of card stock).');
      }
      const back = s?.back || null;
      const parts = [];
      let backLine;
      if (back && back.problem === 'choose') {
        backLine = ui.callout({ variant: 'warning', compact: true, title: 'Choose a common back', message: 'You have several back images. Pick the one to print behind your cards.', actions: [{ label: 'Choose a back', icon: 'image', onClick: () => navigate('cards', { tab: 'back' }) }] });
      } else if (back && back.problem === 'missing') {
        backLine = ui.callout({ variant: 'warning', compact: true, title: 'The chosen back image is missing', message: 'Choose another common back.', actions: [{ label: 'Choose a back', icon: 'image', onClick: () => navigate('cards', { tab: 'back' }) }] });
      } else {
        const name = back?.effective || null;
        backLine = ui.row({ gap: 12, wrap: false },
          backImage && name ? h('img', { src: backImage.url, alt: '', loading: 'lazy', decoding: 'async', draggable: false, style: { width: '40px', height: '56px', objectFit: 'cover', borderRadius: '4px', border: '1px solid var(--border)', flex: 'none' } })
            : h('span', { style: { width: '40px', height: '56px', borderRadius: '4px', border: '1px dashed var(--border-strong)', display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--faint)' } }, icon('image', { size: 16 })),
          h('div.stack', { style: { '--gap': '2px', flex: '1', minWidth: '0' } },
            h('div.strong', 'Common back (all cards)'),
            h('div.small.muted.truncate', { title: name || '' }, name || 'None: the back of single-sided cards stays blank white')),
          fkWrap('back-change', ui.button({ label: 'Change', size: 'sm', onClick: () => navigate('cards', { tab: 'back' }) })));
      }
      parts.push(backLine);
      if (ds > 0) parts.push(h('p.small.muted', `${format.pluralize(ds, 'double-faced card')} ${ds === 1 ? 'prints its' : 'print their'} own back (Unique backs).`));
      const o = validOffset();
      if (offsetInfo && offsetInfo.valid === false && !offsetInfo.unavailable) {
        parts.push(ui.callout({ variant: 'warning', compact: true, message: "Your saved printer alignment can't be read.", actions: [{ label: 'Printer alignment', onClick: () => navigate('offset') }] }));
      } else if (o && offsetNonZero()) {
        const values = `X ${o.x_offset}, Y ${o.y_offset}${Number(o.angle_offset) ? `, ${o.angle_offset}°` : ''}`;
        parts.push(ui.callout({
          variant: opts.load_offset ? 'success' : 'info',
          compact: true,
          title: opts.load_offset ? 'Your printer alignment is applied' : 'Your printer alignment is saved but not used',
          message: `Backs are shifted by ${values} so they line up with the fronts. Print two-sided with “Flip on long edge”.`,
          actions: opts.load_offset ? [{ label: 'Adjust', variant: 'ghost', onClick: () => navigate('offset') }] : [{ label: 'Use it', variant: 'primary', onClick: () => setOption('load_offset', true) }],
        }));
      } else if (offsetInfo !== undefined) {
        parts.push(ui.callout({
          variant: 'info',
          compact: true,
          title: 'Two-sided printing',
          message: 'Needs a printer that can print two-sided on card stock, and a one-time Printer alignment so fronts and backs line up.',
          actions: [{ label: 'Set up', icon: 'crosshair', onClick: () => navigate('offset') }],
        }));
      }
      return parts;
    }

    function estimateInput() {
      const layout = currentLayout();
      if (!layout) return null;
      const sheets = Number(plan?.sheets) > 0 ? Number(plan.sheets) : 1;
      return {
        layout,
        sheets,
        pagesPerSheet: opts.only_fronts ? 1 : 2,
        loadOffset: !!opts.load_offset && !opts.only_fronts,
        totalMemBytes: totalMem(),
        budgetPercent: budgetPercent(),
        isImages: !!opts.output_images,
      };
    }

    function estimateTime(ppi) {
      const base = Number(plan?.resources?.durationSecEst);
      if (!(base > 0) || !(opts.ppi > 0)) return null;
      return base * (ppi / opts.ppi) ** 2;
    }

    function estimateText(e, ppi) {
      const time = estimateTime(ppi);
      return [
        `≈ ${format.formatBytes(e.pdfBytesEst)} ${opts.output_images ? 'of images' : 'PDF'}`,
        `${format.formatBytes(e.peakBytes)} memory`,
        time ? format.formatDuration(time * 1000, { approximate: true }) : null,
      ].filter(Boolean).join(' · ');
    }

    function estimateBadge(e) {
      if (e.blocked) return { text: 'Too much memory', variant: 'danger' };
      if (e.chunks > 1) return { text: `In ${e.chunks} parts`, variant: 'info' };
      if (e.heavy) return { text: 'Heavy', variant: 'warning' };
      return null;
    }

    function renderResolution() {
      const input = estimateInput();
      const options = PPI_PRESETS.map((p) => {
        const e = input ? estimateResources({ ...input, ppi: p.value }) : null;
        return {
          value: p.value,
          label: p.label,
          description: h('span', h('span.strong', `${format.formatNumber(p.value)} PPI`), ` · ${e ? estimateText(e, p.value) : p.description}`),
          badge: e ? estimateBadge(e) : null,
        };
      });
      options.push({ value: 'custom', label: 'Custom', description: 'Any whole number from 1 to 2400 PPI.' });
      const selectedPreset = PPI_PRESETS.find((p) => p.value === opts.ppi && ppiMode === 'preset');
      const cards = ui.radioCards({
        options,
        value: ppiMode === 'custom' ? 'custom' : opts.ppi,
        compact: true,
        ariaLabel: 'Print resolution',
        onChange: (value) => {
          if (value === 'custom') {
            ppiMode = 'custom';
            refresh();
            setTimeout(() => refs.customPpi?.input?.focus(), 0);
            return;
          }
          ppiMode = 'preset';
          setOption('ppi', value);
        },
      });
      const parts = [fkWrap('ppi', cards)];
      if (ppiMode === 'custom') {
        const customInput = ui.numberInput({
          value: opts.ppi,
          min: 1,
          max: 2400,
          integer: true,
          suffix: 'PPI',
          width: 150,
          ariaLabel: 'Custom print resolution',
          onChange: (v) => {
            if (v === null) return;
            setOption('ppi', v, { textual: true });
            updateRefs();
          },
        });
        refs.customPpi = customInput;
        refs.customHint = h('div.small.muted');
        parts.push(ui.field({ label: 'Custom resolution', control: fkWrap('ppi-custom', customInput) }), refs.customHint);
      } else {
        refs.customPpi = null;
        refs.customHint = null;
        if (selectedPreset) parts.push(h('p.small.muted', selectedPreset.description));
      }
      return parts;
    }

    function updateCustomHint() {
      if (!refs.customHint) return;
      const input = estimateInput();
      const e = input && Number.isInteger(opts.ppi) && opts.ppi > 0 ? estimateResources({ ...input, ppi: opts.ppi }) : null;
      refs.customHint.textContent = e ? `${estimateText(e, opts.ppi)}${e.chunks > 1 ? ` · made in ${e.chunks} parts` : ''}${e.blocked ? ' · too much memory for this computer' : ''}` : '';
    }

    function renderUpscale() {
      const up = env()?.upscayl;
      const found = !!up?.found;
      const on = upscaleWanted();
      const parts = [fkWrap('upscale', ui.toggle({
        checked: on,
        disabled: !found,
        label: 'Upscale for sharper prints',
        description: found
          ? 'Upscayl enlarges low-resolution pictures before they are placed, only as much as this print resolution needs. Results are kept for next time.'
          : 'Needs Upscayl, a free app that makes low-resolution pictures sharper (optional).',
        onChange: (v) => setUpscale(v),
      }))];
      if (!found) {
        parts.push(ui.row({ gap: 8 },
          ui.button({ label: EXTERNAL_LINKS.upscayl.label, icon: 'external-link', size: 'sm', onClick: () => api.shell.openExternal(EXTERNAL_LINKS.upscayl.url) }),
          ui.button({ label: 'Already installed? Locate it', size: 'sm', variant: 'ghost', onClick: () => navigate('upscale') })));
        return parts;
      }
      const u = plan?.upscale;
      if (on && u) {
        const needed = Number(u.needed) || 0;
        const cached = Number(u.cached) || 0;
        const sharp = Number(u.sharp) || 0;
        const bits = [];
        if (needed > 0) {
          bits.push(`${format.pluralize(needed, 'picture')} will be upscaled`);
          if (Number(u.secEst) > 0) bits.push(format.formatDuration(u.secEst * 1000, { approximate: true }));
          if (Number(u.bytesEst) > 0) bits.push(`about ${format.formatBytes(u.bytesEst)}`);
        } else {
          bits.push('No picture needs upscaling right now');
        }
        if (cached > 0) bits.push(`${format.formatNumber(cached)} ready from earlier`);
        if (sharp > 0) bits.push(`${format.formatNumber(sharp)} already sharp enough`);
        parts.push(h('p.small.muted', bits.join(' · ')));
        if (u.reason) parts.push(ui.callout({ variant: 'warning', compact: true, message: String(u.reason) }));
      }
      parts.push(ui.row({ gap: 8 }, ui.button({ label: 'Upscale settings', variant: 'link', size: 'sm', iconRight: 'arrow-right', onClick: () => navigate('upscale') })));
      return parts;
    }

    function lengthField(key) {
      const doc = CREATE_PDF_OPTIONS[key];
      return ui.field({
        label: doc.label,
        help: `${doc.help} ${doc.recommended}`,
        control: fkWrap(`opt-${key}`, ui.lengthInput({
          value: opts[key],
          units: doc.units || ['mm', 'in'],
          placeholder: 'Off',
          ariaLabel: doc.label,
          onChange: (v) => setOption(key, v, { textual: true }),
        })),
      });
    }

    function choiceSelect(key, { includeNull = true } = {}) {
      const doc = CREATE_PDF_OPTIONS[key];
      const options = [];
      if (includeNull && doc.nullLabel) options.push({ value: null, label: doc.nullLabel });
      doc.choices.forEach((c, i) => options.push({ value: c, label: doc.choiceLabels?.[i] || c, description: doc.choiceDescriptions?.[i] }));
      return ui.select({ value: opts[key] ?? null, options, ariaLabel: doc.label, onChange: (v) => setOption(key, v) });
    }

    function groupTitle(text, description) {
      return h('div.stack', { style: { '--gap': '2px' } }, h('div.strong', text), description ? h('div.small.muted', description) : null);
    }

    function renderMoreOptions() {
      const doc = CREATE_PDF_OPTIONS;
      // Image fixes
      const fitSeg = ui.segmented({
        value: opts.fit || 'stretch',
        options: doc.fit.choices.map((c, i) => ({ value: c, label: doc.fit.choiceLabels[i] })),
        onChange: (v) => setOption('fit', v),
        ariaLabel: doc.fit.label,
      });
      const imageFixes = ui.card({
        title: 'Image fixes',
        subtitle: 'Fix rounded corners, thin borders, extra bleed and picture shape.',
        icon: 'wand',
        children: ui.grid({ min: 230, gap: 16 },
          lengthField('extend_corners'),
          lengthField('extend_edges'),
          lengthField('crop'),
          lengthField('extend_bleed'),
          ui.field({ label: 'Image shape', help: doc.fit.help, hint: doc.fit.choiceDescriptions[Math.max(0, doc.fit.choices.indexOf(opts.fit || 'stretch'))], control: fkWrap('opt-fit', fitSeg) })),
      });

      // Back side
      refs.loadOffsetToggle = ui.toggle({
        checked: !!opts.load_offset,
        disabled: !!opts.only_fronts,
        label: doc.load_offset.label,
        description: opts.only_fronts ? 'Only used with “Fronts and backs”.' : 'Shifts the back pages by the correction measured in Printer alignment.',
        onChange: (v) => setOption('load_offset', v),
      });
      const backSide = ui.card({
        title: 'Back side',
        subtitle: 'Used with “Fronts and backs”: the same fixes for the common back image, and your printer alignment.',
        icon: 'layers',
        children: [
          ui.grid({ min: 230, gap: 16 },
            ui.field({ label: doc.fit_backs.label, help: doc.fit_backs.help, control: fkWrap('opt-fit_backs', choiceSelect('fit_backs')) }),
            lengthField('extend_corners_backs'),
            lengthField('extend_edges_backs'),
            lengthField('crop_backs'),
            lengthField('extend_bleed_backs')),
          fkWrap('opt-load_offset', refs.loadOffsetToggle),
        ],
      });

      // Sheet layout
      const tightBlocked = TIGHT_UNSUPPORTED_PAPERS.includes(opts.paper_size) || !!opts.specialty;
      refs.borderlessToggle = ui.toggle({
        checked: !!opts.borderless,
        disabled: tightBlocked && !opts.borderless,
        label: doc.borderless.label,
        description: tightBlocked
          ? (opts.specialty ? 'Not available with a specialty layout.' : 'Not available on A3 or Arch B yet.')
          : doc.borderless.warning,
        onChange: (v) => setOption('borderless', v),
      });
      refs.outlineToggle = ui.toggle({
        checked: !!opts.show_outline,
        label: 'Show cut lines',
        description: opts.show_outline ? doc.show_outline.warning : 'Draws a thin line where each card is cut, to check that art and text are not too close to the edge.',
        onChange: (v) => setOption('show_outline', v),
      });
      const labelInput = ui.textInput({
        value: opts.label || '',
        placeholder: 'For example: deck name',
        maxLength: 120,
        ariaLabel: doc.label.label,
        onInput: (v) => setOption('label', v.trim() ? v : null, { textual: true }),
      });
      labelInput.style.width = '100%';
      const sheet = ui.card({
        title: 'Sheet layout',
        subtitle: 'Tight layout, specialty layouts and the text printed on each sheet.',
        icon: 'grid',
        children: [
          fkWrap('opt-borderless', refs.borderlessToggle),
          ui.grid({ min: 230, gap: 16 },
            ui.field({ label: doc.specialty.label, help: doc.specialty.help, hint: opts.specialty ? doc.specialty.warning : '100 mini cards per sheet; no cutting template included.', control: fkWrap('opt-specialty', choiceSelect('specialty')) }),
            ui.field({ label: doc.label.label, help: doc.label.help, hint: 'Printed along the edge of each front page.', control: fkWrap('opt-label', labelInput) })),
          fkWrap('opt-show_outline', refs.outlineToggle),
        ],
      });

      // Registration marks
      const m = machine();
      const reg = opts.registration === '4' ? '4' : '3';
      const regCards = ui.radioCards({
        value: reg,
        columns: 2,
        compact: true,
        ariaLabel: 'Registration marks',
        options: doc.registration.choices.map((c, i) => ({ value: c, label: doc.registration.choiceLabels[i], description: doc.registration.choiceDescriptions[i] })),
        onChange: (v) => setOption('registration', v),
      });
      const regWarn = m && !registrationFitsMachine(m.id, reg)
        ? ui.callout({ variant: 'warning', compact: true, message: `Your ${m.label} can't read ${reg}-corner marks.`, actions: [{ label: `Use ${m.registration}-corner marks`, onClick: () => setOption('registration', m.registration) }] })
        : null;
      const registration = ui.card({
        title: 'Registration marks',
        subtitle: 'The corner marks your machine scans before cutting.',
        icon: 'scan',
        children: [
          fkWrap('opt-registration', regCards),
          regWarn,
          ui.field({
            label: doc.registration_orientation.label,
            help: doc.registration_orientation.help,
            hint: opts.registration_orientation ? doc.registration_orientation.warning : null,
            control: fkWrap('opt-registration_orientation', choiceSelect('registration_orientation')),
          }),
        ],
      });

      // Quality and output
      const qualityInput = ui.numberInput({
        value: opts.quality,
        min: 0,
        max: 100,
        integer: true,
        width: 120,
        ariaLabel: doc.quality.label,
        onChange: (v) => {
          if (v !== null) setOption('quality', v, { textual: true });
        },
      });
      const total = totalMem();
      const budgetField = ui.field({
        label: 'Memory the PDF may use',
        help: 'Big PDFs at high resolution need a lot of memory. When a PDF would need more than this share of your computer\'s memory, the app makes it in parts and joins them automatically (same result).',
        hint: total ? `Up to ${format.formatBytes((total * budgetPercent()) / 100)} of your ${format.formatBytes(total)}.` : null,
        control: fkWrap('opt-memory', ui.numberInput({
          value: budgetPercent(),
          min: MIN_BUDGET_PERCENT,
          max: MAX_BUDGET_PERCENT,
          integer: true,
          suffix: '%',
          width: 120,
          ariaLabel: 'Memory the PDF may use (percent)',
          onChange: (v) => {
            if (v === null || v < MIN_BUDGET_PERCENT || v > MAX_BUDGET_PERCENT) return;
            updateSettings({ pdf: { memoryBudgetPercent: v } }, { key: 'memory', delay: TEXT_WRITE_DELAY_MS });
            if (total) budgetField.setHint(`Up to ${format.formatBytes((total * v) / 100)} of your ${format.formatBytes(total)}.`);
            refresh();
            schedulePlan(TEXT_WRITE_DELAY_MS);
          },
        })),
      });
      refs.imagesToggle = ui.toggle({
        checked: !!opts.output_images,
        label: doc.output_images.label,
        description: 'Saves every page as a picture (page1.png, page2.png…) in a folder, for example to check the layout.',
        onChange: (v) => setOption('output_images', v),
      });
      const output = ui.card({
        title: 'Quality and output',
        icon: 'gauge',
        children: [
          ui.grid({ min: 230, gap: 16 },
            ui.field({ label: doc.quality.label, help: doc.quality.help, hint: '100 keeps the best quality.', control: fkWrap('opt-quality', qualityInput) }),
            budgetField),
          fkWrap('opt-output_images', refs.imagesToggle),
        ],
      });

      return [imageFixes, backSide, sheet, registration, output];
    }

    /**
     * The one "Create PDF" button (in the sticky summary card, so it stays in view) with a short
     * line explaining why it is disabled.
     * @returns {HTMLElement}
     */
    function renderCreate() {
      const running = runningJob();
      const pdfRunning = running?.kind === 'pdf';
      const errors = Array.isArray(plan?.errors) ? plan.errors : [];
      let status = null;
      if (pdfRunning) {
        status = h('span.small.muted', 'Making your PDF… You can keep using the app.');
      } else if (running) {
        status = h('span.small.muted', `Wait until “${running.title || 'the current task'}” finishes.`);
      } else if (!plan && !planError) {
        status = h('span.small.muted.row', { style: { '--gap': '8px' } }, ui.spinner(14), 'Checking your settings…');
      } else if (planError && !plan) {
        status = h('span.small.text-danger', "Your settings can't be checked right now.");
      } else if (!plan.ok) {
        const n = errors.length;
        status = h('span.small.text-danger.strong', n > 1 ? `Fix the ${n} problems below first.` : 'Fix the problem below first.');
      }
      const label = opts.output_images ? 'Create PNG pages' : 'Create PDF';
      const btn = ui.button({
        label,
        icon: opts.output_images ? 'images' : 'file-pdf',
        variant: 'primary',
        size: 'lg',
        block: true,
        disabled: !plan || !plan.ok || !!running,
        loading: pdfRunning,
        onClick: createPdf,
      });
      return h('div.stack', { style: { '--gap': '8px' } }, fkWrap('create', btn), status ? h('div.center', status) : null);
    }

    function renderNextStep() {
      const r = store.get('lastResults')?.pdf;
      const s = summary();
      if (r && r.status === 'succeeded') {
        return nextStep({ text: 'Your PDF is ready', detail: 'Print it at actual size, then cut it with your Silhouette.', actionLabel: 'Print & cut', icon: 'printer', tone: 'neutral', onAction: () => navigate('print') });
      }
      const fronts = Number(s?.front) || 0;
      if (!fronts) {
        return nextStep({ text: 'No cards yet', detail: 'Download a deck or add your own images first.', actionLabel: 'Get cards', icon: 'download', tone: 'warning', onAction: () => navigate('fetch') });
      }
      return nextStep({ text: 'Next: print and cut', detail: 'After making the PDF, follow the checklist to print and cut your sheets.', actionLabel: 'Print & cut', icon: 'printer', tone: 'neutral', onAction: () => navigate('print') });
    }

    /* ------------------------------ right column parts ------------------------------ */

    function renderProgress() {
      const j = runningJob();
      refs.progress = null;
      if (!j || j.kind !== 'pdf') return null;
      const bar = ui.progressBar({ percent: null, label: '' });
      refs.progress = bar;
      const stopBtn = ui.button({
        label: 'Stop',
        icon: 'stop',
        size: 'sm',
        onClick: async () => {
          const ok = await ui.confirmDialog({ title: 'Stop making the PDF?', message: 'Nothing is saved. You can start again any time.', confirmLabel: 'Stop', danger: true });
          if (ok) await api.jobs.cancel(j.jobId);
        },
      });
      const el = ui.card({ variant: 'accent', icon: 'file-pdf', title: 'Making your PDF…', actions: [stopBtn], children: [bar] });
      updateProgress();
      return el;
    }

    function updateProgress() {
      const j = runningJob();
      if (!refs.progress || !j) return;
      const steps = Array.isArray(j.steps) ? j.steps : [];
      const step = steps.find((s) => s.status === 'running' || s.status === 'active');
      const label = [step?.label, j.progress?.label].filter(Boolean).join(' · ') || 'Working…';
      refs.progress.update(Number.isFinite(j.progress?.percent) ? j.progress.percent : null, label);
    }

    /**
     * Narrow window (side column below the options): a short line at the top says the PDF can't
     * be made yet and jumps to the list of problems.
     * @returns {HTMLElement|null}
     */
    function renderStackedStatus() {
      if (!stacked || !plan || plan.ok || runningJob()?.kind === 'pdf') return null;
      const n = (plan.errors || []).length;
      return h('div', { dataset: { fk: 'stacked-status' } }, ui.callout({
        variant: 'danger',
        compact: true,
        message: n > 1 ? `${n} problems must be fixed before the PDF can be made.` : 'A problem must be fixed before the PDF can be made.',
        actions: [{
          label: n > 1 ? 'Show the problems' : 'Show the problem',
          icon: 'arrow-down',
          onClick: () => {
            const target = refs.problems?.firstElementChild;
            if (!target) return;
            target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            const focusable = target.querySelector('button:not([disabled]), input:not([disabled])');
            if (focusable) focusable.focus({ preventScroll: true });
          },
        }],
      }));
    }

    /** True while the "Your PDF is ready" card of the last PDF job is on screen. */
    function successShown() {
      const r = store.get('lastResults')?.pdf;
      return !!r && r.status === 'succeeded' && !session.dismissedResults.has(r.jobId) && runningJob()?.kind !== 'pdf';
    }

    /** Summary card title ("Next PDF" below a "Your PDF is ready" card, so the two don't read the same). */
    function summaryTitle() {
      return successShown() ? 'Next PDF' : 'Your PDF';
    }

    function statusBadge() {
      if (planError && !plan) return ui.badge("Can't check", 'warning', { icon: 'alert-triangle' });
      if (!plan) return ui.badge('Checking…', 'neutral');
      if (planSlow) return ui.badge('Updating…', 'neutral');
      if (plan.ok) return ui.badge('Ready', 'success', { icon: 'check' });
      return ui.badge(`${format.pluralize((plan.errors || []).length || 1, 'problem')}`, 'danger', { icon: 'alert-circle' });
    }

    function renderSummary() {
      if (!plan) {
        if (planError) {
          const actions = [{ label: 'Try again', icon: 'refresh', onClick: () => runPlan() }];
          if (planError.code === 'NOT_READY') actions.unshift({ label: 'Open setup', variant: 'primary', onClick: () => navigate('setup') });
          return ui.card({
            title: summaryTitle(),
            icon: 'file-pdf',
            actions: [statusBadge()],
            children: [
              ui.callout({ variant: 'warning', compact: true, title: "Your settings can't be checked right now", message: planError.message, actions }),
              renderCreate(),
            ],
          });
        }
        return ui.card({ title: summaryTitle(), icon: 'file-pdf', actions: [statusBadge()], children: [ui.skeleton({ lines: 4 }), renderCreate()] });
      }
      const cards = plan.cards || {};
      const total = Number(cards.total) || 0;
      const fronts = Number(cards.fronts) || 0;
      const faces = Number(cards.faces) || 0;
      const skip = Array.isArray(plan.skip) ? plan.skip : [];
      const res = plan.resources || {};
      const cardHint = faces > 0 ? `${format.formatNumber(fronts)} fronts + ${format.formatNumber(faces)} back faces`
        : (Number(cards.uniqueBacks) > 0 && !opts.only_fronts ? `${format.formatNumber(cards.uniqueBacks)} with their own back` : (total === 1 ? 'card' : 'cards'));
      const perSheet = Number.isFinite(plan.effectivePerSheet) ? plan.effectivePerSheet : plan.perPage;
      // 2 columns in the side column, 4 when the page is narrow and the summary spans the full width.
      const stats = ui.grid({ min: 136, gap: 8 },
        ui.stat({ label: 'Cards', value: format.formatNumber(total), hint: cardHint, icon: 'layers' }),
        ui.stat({ label: 'Sheets', value: Number.isFinite(plan.sheets) ? format.formatNumber(plan.sheets) : '—', hint: Number.isFinite(plan.pdfPages) ? format.pluralize(plan.pdfPages, 'PDF page') : null, icon: 'file' }),
        ui.stat({ label: 'Per sheet', value: Number.isFinite(perSheet) ? format.formatNumber(perSheet) : '—', hint: skip.length ? `${format.pluralize(skip.length, 'slot')} left empty` : (plan.perPage ? `${plan.perPage} slots` : null), icon: 'grid' }),
        Number(res.chunks) > 1
          ? ui.stat({ label: 'Parts', value: format.formatNumber(res.chunks), hint: 'joined automatically', icon: 'layers', variant: 'accent' })
          : ui.stat({ label: 'PDF size', value: Number(res.pdfBytesEst) > 0 ? `≈ ${format.formatBytes(res.pdfBytesEst)}` : '—', hint: 'estimate', icon: 'hard-drive' }));
      const layout = plan.layout || currentLayout();
      const paper = getPaperSize(layout?.paper || opts.paper_size);
      const card = getCardSize(layout?.card || opts.card_size);
      const rows = [
        ['Layout', opts.specialty ? specialtyLabel(opts.specialty) : `${paper ? paper.shortLabel : opts.paper_size} · ${card ? `${card.label} (${card.dimensions})` : opts.card_size}${opts.borderless ? ' · tight' : ''}`],
        ['Resolution', `${format.formatNumber(opts.ppi)} PPI`],
      ];
      if (Number(res.peakBytes) > 0) {
        const t = Number(res.totalMemBytes) || totalMem();
        rows.push(['Memory', `≈ ${format.formatBytes(res.peakBytes)}${t ? ` of ${format.formatBytes(t)}` : ''}`]);
      }
      if (Number(res.durationSecEst) > 0) rows.push(['Time', format.formatDuration(res.durationSecEst * 1000, { approximate: true })]);
      if (plan.output?.fileName || plan.output?.path) {
        const name = plan.output.isImages ? `${stripPdfExtension(plan.output.fileName || baseName(plan.output.path))} (folder)` : (plan.output.fileName || baseName(plan.output.path));
        rows.push(['Saved as', h('span.mono.small', { title: plan.output.path || '' }, name)]);
      }
      return ui.card({ title: summaryTitle(), icon: 'file-pdf', actions: [statusBadge()], children: [stats, ui.kv(rows), renderCreate()] });
    }

    /**
     * Buttons / required checkboxes for a plan error's `fix` (contract shared with src/main/pdf.js).
     * @param {any} fix
     * @param {any} [error] the plan error (its code refines the wording)
     * @returns {Node[]}
     */
    function fixControls(fix, error) {
      if (!fix || typeof fix !== 'object') return [];
      switch (fix.type) {
        case 'fixCollisions':
          return [ui.button({ label: 'Fix names automatically', icon: 'wand', size: 'sm', variant: 'primary', onClick: () => fixCollisions(fix.kind === 'double_sided' ? 'double_sided' : 'front') })];
        case 'chooseBack':
          return [ui.button({ label: 'Choose a back', icon: 'image', size: 'sm', variant: 'primary', onClick: () => navigate('cards', { tab: 'back' }) })];
        case 'openCards': {
          const tab = ['front', 'back', 'double_sided'].includes(fix.tab) ? fix.tab : 'front';
          const out = [];
          if (tab === 'front' && !(Number(summary()?.front) > 0)) {
            out.push(ui.button({ label: 'Get cards', icon: 'download', size: 'sm', variant: 'primary', onClick: () => navigate('fetch') }));
          }
          const label = { front: 'Open your cards', back: 'Open the common back', double_sided: 'Open unique backs' }[tab];
          out.push(ui.button({ label, icon: 'images', size: 'sm', onClick: () => navigate('cards', { tab }) }));
          return out;
        }
        case 'resetOffset': {
          // Nothing saved yet: 0, 0, 0 is a harmless start. A damaged file is replaced after a confirmation.
          const nothingSaved = error?.code === 'OFFSET_MISSING' || offsetInfo === null;
          return [
            ui.button({ label: 'Printer alignment', icon: 'crosshair', size: 'sm', variant: nothingSaved ? 'primary' : 'secondary', onClick: () => navigate('offset') }),
            ui.button({
              label: nothingSaved ? 'Use 0, 0, 0 for now' : 'Reset to 0, 0, 0',
              icon: nothingSaved ? undefined : 'rotate-ccw',
              size: 'sm',
              variant: nothingSaved ? 'ghost' : 'secondary',
              onClick: () => resetOffset({ confirm: !nothingSaved }),
            }),
          ];
        }
        case 'lowerPpi':
          return Number.isInteger(fix.ppi) && fix.ppi > 0
            ? [ui.button({ label: `Use ${format.formatNumber(fix.ppi)} PPI`, icon: 'gauge', size: 'sm', variant: 'primary', onClick: () => setPpi(fix.ppi) })]
            : [];
        case 'ackNoTemplate':
          return [fkWrap('ack-template', ui.checkbox({ checked: ackNoTemplate(), label: 'I have my own cutting template', onChange: setAckNoTemplate }))];
        case 'ignoreMemoryLimit':
          return [fkWrap('ack-memory', ui.checkbox({ checked: ignoreMemory(), label: 'Create anyway (other programs may become very slow)', onChange: setIgnoreMemory }))];
        default:
          return [];
      }
    }

    function renderProblems() {
      if (!plan) return null;
      const errors = (Array.isArray(plan.errors) ? plan.errors : []).filter((e) => e && e.message);
      // "Create anyway" must always have a checkbox when the plan requires it, even if the service
      // reports the memory problem with a "lower the resolution" fix only.
      const memoryNeedsAck = !!plan.requires?.ignoreMemoryLimit && !errors.some((e) => e.fix?.type === 'ignoreMemoryLimit');
      let ackPlaced = false;
      const out = errors.map((e, i) => {
        const actions = fixControls(e.fix, e);
        if (!e.fix && e.code === 'NOT_READY') {
          actions.push(ui.button({ label: 'Open setup', icon: 'package', size: 'sm', variant: 'primary', onClick: () => navigate('setup') }));
        } else if (!e.fix && e.code === 'INTROSPECTION_FAILED') {
          actions.push(ui.button({
            label: 'Try again',
            icon: 'refresh',
            size: 'sm',
            onClick: async () => {
              await ctx.refresh?.introspection?.({ force: true });
              await runPlan();
            },
          }));
        }
        if (memoryNeedsAck && !ackPlaced && (e.code === 'OUT_OF_MEMORY' || e.fix?.type === 'lowerPpi')) {
          actions.push(...fixControls({ type: 'ignoreMemoryLimit' }));
          ackPlaced = true;
        }
        return h('div', { dataset: { fk: `error-${i}` } }, ui.callout({ variant: 'danger', compact: true, message: e.message, actions }));
      });
      // Already-ticked confirmations stay visible so they can be unticked.
      if (memoryNeedsAck && !ackPlaced) {
        out.push(h('div', { dataset: { fk: 'ack-memory-box' } }, ui.callout({
          variant: ignoreMemory() ? 'warning' : 'danger',
          compact: true,
          message: 'This PDF needs more memory than your computer can spare. Lower the print resolution, or confirm to create it anyway.',
          actions: fixControls({ type: 'ignoreMemoryLimit' }),
        })));
      }
      return out;
    }

    function actionControl(action) {
      if (!action || typeof action !== 'object') return [];
      switch (action.type) {
        case 'keepBoth':
          return action.fileName ? [ui.button({
            label: 'Keep both',
            size: 'sm',
            onClick: () => {
              updateSettings({ pdf: { fileName: stripPdfExtension(action.fileName) || null } });
              updateRefs(true);
              schedulePlan(0);
            },
          })] : [];
        case 'setLoadOffset':
          return [ui.button({ label: action.value === false ? 'Turn it off' : 'Use my alignment', size: 'sm', variant: 'primary', onClick: () => setOption('load_offset', action.value !== false) })];
        case 'applyRecommended':
          return action.options && typeof action.options === 'object'
            ? [ui.button({ label: 'Apply', size: 'sm', variant: 'primary', onClick: () => setOptions(normalizeOptions({ ...opts, ...action.options })) })]
            : [];
        case 'openAlignment':
          return [ui.button({ label: 'Printer alignment', size: 'sm', icon: 'crosshair', onClick: () => navigate('offset') })];
        case 'openUpscale':
          return [ui.button({ label: 'Upscale settings', size: 'sm', icon: 'sparkles', onClick: () => navigate('upscale') })];
        default:
          return [];
      }
    }

    function renderNotes() {
      if (!plan) return null;
      const errors = Array.isArray(plan.errors) ? plan.errors : [];
      const hasTemplateError = errors.some((e) => e?.fix?.type === 'ackNoTemplate');
      const errorTexts = new Set(errors.map((e) => e?.message).filter(Boolean));
      // Problems the main column already shows next to the setting, with a fix button.
      const rec = recommendationFor(settings, opts);
      const recKeys = new Set(rec ? rec.diffs.map(([key]) => key) : []);
      const m = machine();
      const machineCalloutShown = !!m && !registrationFitsMachine(m.id, opts.registration === '4' ? '4' : '3');
      const paperCalloutShown = !!m && Array.isArray(m.supportedPapers) && !m.supportedPapers.includes(opts.paper_size) && !!m.paperWarning;
      const warnings = (Array.isArray(plan.warnings) ? plan.warnings : [])
        .filter((w) => w && w.message && !errorTexts.has(w.message))
        .filter((w) => !(hasTemplateError && /template/i.test(w.message)))
        .filter((w) => !(machineCalloutShown && w.code === 'REGISTRATION_MACHINE'))
        .filter((w) => !(paperCalloutShown && w.code === 'PAPER_MACHINE'));
      const duplicateRecommendation = (n) => n.action?.type === 'applyRecommended' && recKeys.size > 0
        && n.action.options && typeof n.action.options === 'object'
        && Object.keys(n.action.options).every((key) => recKeys.has(key));
      const notices = (Array.isArray(plan.notices) ? plan.notices : [])
        .filter((n) => n && n.message && !duplicateRecommendation(n));
      return [
        ...warnings.map((w, i) => h('div', { dataset: { fk: `warning-${i}` } }, ui.callout({ variant: 'warning', compact: true, message: w.message, actions: actionControl(w.action) }))),
        ...notices.map((n, i) => h('div', { dataset: { fk: `notice-${i}` } }, ui.callout({ variant: 'info', compact: true, message: n.message, actions: actionControl(n.action) }))),
      ];
    }

    function previewLayout() {
      const layout = currentLayout();
      if (!layout) return null;
      return opts.registration_orientation ? { ...layout, registrationOrientation: opts.registration_orientation } : layout;
    }

    function cardsOnLastSheet() {
      if (!plan || !(Number(plan.sheets) > 0)) return null;
      const per = Number.isFinite(plan.effectivePerSheet) ? plan.effectivePerSheet : null;
      const empty = Number(plan.lastSheetEmpty);
      if (!Number.isFinite(per) || !Number.isFinite(empty)) return null;
      return Math.max(0, per - empty);
    }

    function updatePreview() {
      if (!preview) return;
      preview.update({
        layout: previewLayout(),
        skip: currentSkip(),
        registration: opts.registration === '4' ? '4' : '3',
        cardsOnLastSheet: cardsOnLastSheet(),
      });
    }

    function renderPreviewExtras() {
      const layout = currentLayout();
      if (!layout) {
        return h('p.small.muted', 'The preview appears when the card maker options are loaded.');
      }
      const skip = currentSkip();
      const parts = [h('p.small.muted', SKIP_HELP)];
      const slot = slotNearBottomLeftMark(layout);
      if (opts.registration !== '4' && slot >= 0 && !skip.includes(slot) && skip.length + 1 < (perPage() || Infinity)) {
        parts.push(ui.button({
          label: 'Leave the slot next to the bottom-left mark empty',
          icon: 'scan',
          size: 'sm',
          onClick: () => writeSkip([...skip, slot]),
        }));
      }
      if (skip.length) {
        parts.push(ui.row({ gap: 8 },
          h('span.small', `Left empty: ${skip.map((i) => `slot ${i + 1}`).join(', ')}`),
          ui.button({ label: 'Use all slots', size: 'sm', variant: 'link', onClick: () => writeSkip([]) })));
      }
      const empty = Number(plan?.lastSheetEmpty);
      if (plan && Number(plan.cards?.total) > 0 && Number.isFinite(empty) && empty > 0) {
        parts.push(ui.callout({
          variant: 'neutral',
          compact: true,
          icon: 'info',
          message: `The last sheet has ${format.pluralize(empty, 'empty slot')}: you can add ${empty === 1 ? '1 more card' : `${empty} more cards`} at no extra paper cost.`,
        }));
      }
      return parts;
    }

    function renderTemplate() {
      const layout = currentLayout();
      const template = plan?.template || (layout ? { name: layout.template || null, file: layout.templateFile || null } : null);
      if (!template) return null;
      const children = [];
      if (template.file) {
        children.push(h('div.mono.small.truncate', { title: template.file }, `${template.name || baseName(template.file).replace(/\.studio3$/i, '')}.studio3`));
        children.push(ui.row({ gap: 8 },
          ui.button({ label: 'Open template', icon: 'scissors', size: 'sm', variant: 'primary', onClick: () => openTemplate(template.file) }),
          ui.button({ label: 'Show file', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => api.shell.showItemInFolder(template.file) })));
        children.push(h('p.small.muted', 'The template name is also printed along the edge of every sheet.'));
      } else {
        children.push(h('p.small', template.name
          ? `No ready-made cutting template (“${template.name}”) is included for this combination.`
          : 'No ready-made cutting template for this combination.'));
        const ackShownInProblems = (plan?.errors || []).some((e) => e?.fix?.type === 'ackNoTemplate');
        if (!ackShownInProblems && (plan?.requires?.ackNoTemplate || ackNoTemplate())) {
          children.push(fkWrap('ack-template-2', ui.checkbox({ checked: ackNoTemplate(), label: 'I have my own cutting template', onChange: setAckNoTemplate })));
        }
      }
      return ui.card({ title: 'Cutting template', icon: 'scissors', children });
    }

    function renderCommand() {
      if (!plan || !plan.display) return null;
      return ui.row({ justify: 'center' }, ui.button({ label: 'Show the equivalent command', icon: 'terminal', size: 'sm', variant: 'ghost', onClick: openCommand }));
    }

    /* ------------------------------ imperative updates ------------------------------ */

    function updateRefs(force = false) {
      if (refs.cardSelect) {
        const key = JSON.stringify([opts.paper_size, opts.card_size, !!introspection()]);
        if (force || key !== refs.cardKey) {
          refs.cardKey = key;
          refs.cardSelect.setOptions(cardOptions(), opts.card_size);
        }
        refs.cardSelect.setDisabled(!!opts.specialty);
        refs.paperSelect.setDisabled(!!opts.specialty);
      }
      if (refs.nameInput) {
        const derived = stripPdfExtension(plan?.output?.fileName || '') || 'proxies';
        const explicit = stripPdfExtension(settings?.pdf?.fileName || '');
        refs.nameInput.placeholder = derived;
        if (force && document.activeElement !== refs.nameInput) refs.nameInput.value = explicit;
        refs.nameField.setError(INVALID_FILE_CHARS.test(refs.nameInput.value) ? 'A file name cannot contain < > : " / \\ | ? *' : null);
        const deck = settings?.fetch?.lastFetched?.deckName;
        refs.nameField.setHint(explicit ? null : (deck ? 'Named after your last downloaded deck. Type a name to choose your own.' : 'Type a name, or keep the suggested one.'));
        refs.useDeckName.hidden = !explicit;
        const label = opts.output_images ? 'Folder name' : 'File name';
        if (refs.nameLabel && refs.nameLabel.textContent !== label) refs.nameLabel.textContent = label;
        refs.nameSuffix.hidden = !!opts.output_images;
      }
      if (refs.folderText) {
        const dir = plan?.output?.dir || settings?.outputDir || store.get('appInfo')?.paths?.output || '';
        refs.folderText.textContent = dir ? shortPath(dir, 3) : 'Default folder';
        refs.folderText.title = dir;
        refs.folderReset.hidden = !settings?.outputDir;
      }
      if (refs.openWhenDone) refs.openWhenDone.setChecked(settings?.pdf?.openWhenDone !== false);
      if (refs.loadOffsetToggle) {
        refs.loadOffsetToggle.setDisabled(!!opts.only_fronts);
        refs.loadOffsetToggle.setChecked(!!opts.load_offset);
        const desc = refs.loadOffsetToggle.querySelector('.toggle-desc');
        if (desc) desc.textContent = opts.only_fronts ? 'Only used with “Fronts and backs”.' : 'Shifts the back pages by the correction measured in Printer alignment.';
      }
      if (refs.borderlessToggle) {
        const blocked = TIGHT_UNSUPPORTED_PAPERS.includes(opts.paper_size) || !!opts.specialty;
        refs.borderlessToggle.setDisabled(blocked && !opts.borderless);
        refs.borderlessToggle.setChecked(!!opts.borderless);
        const desc = refs.borderlessToggle.querySelector('.toggle-desc');
        if (desc) {
          desc.textContent = blocked
            ? (opts.specialty ? 'Not available with a specialty layout.' : 'Not available on A3 or Arch B yet.')
            : CREATE_PDF_OPTIONS.borderless.warning;
        }
      }
      if (refs.outlineToggle) {
        const desc = refs.outlineToggle.querySelector('.toggle-desc');
        if (desc) desc.textContent = opts.show_outline ? CREATE_PDF_OPTIONS.show_outline.warning : 'Draws a thin line where each card is cut, to check that art and text are not too close to the edge.';
      }
      if (refs.sidesSeg) refs.sidesSeg.setValue(opts.only_fronts ? 'fronts' : 'both');
      updateCustomHint();
      updateProgress();
      updatePreview();
    }

    function refresh(force = false) {
      if (disposed) return;
      for (const s of slots) s.refresh(force);
      updateRefs();
    }

    /* ------------------------------ build ------------------------------ */

    function build() {
      slots = [];
      refs = {};
      const slot = (deps, render) => {
        const s = createSlot(deps, render);
        slots.push(s);
        return s.el;
      };
      const planKey = () => (plan ? [plan.ok, plan.errors, plan.warnings, plan.notices, plan.requires, plan.layoutKey, plan.template, plan.output] : planError);

      // Main column ------------------------------------------------------------------------------
      refs.paperSelect = ui.select({ value: opts.paper_size, options: paperOptions(), onChange: (v) => setOption('paper_size', v), ariaLabel: 'Paper size' });
      refs.cardSelect = ui.select({ value: opts.card_size, options: cardOptions(), onChange: (v) => setOption('card_size', v), ariaLabel: 'Card size' });
      refs.cardKey = JSON.stringify([opts.paper_size, opts.card_size, !!introspection()]);
      const sizeCard = ui.card({
        title: 'Paper and card size',
        icon: 'file',
        children: [
          ui.grid({ min: 240, gap: 16 },
            ui.field({ label: 'Paper', help: CREATE_PDF_OPTIONS.paper_size.help, control: fkWrap('paper', refs.paperSelect) }),
            ui.field({ label: 'Card size', help: CREATE_PDF_OPTIONS.card_size.help, control: fkWrap('card', refs.cardSelect) })),
          slot(() => [opts.specialty, opts.paper_size, settings?.equipment?.machine], renderPaperExtras),
        ],
      });

      const machineCard = ui.card({
        title: 'Cutting machine',
        icon: 'scissors',
        children: slot(() => [settings?.equipment?.machine, opts.registration, session.machineEditing], renderMachine),
      });

      refs.sidesSeg = ui.segmented({
        value: opts.only_fronts ? 'fronts' : 'both',
        options: [{ value: 'fronts', label: 'Fronts only' }, { value: 'both', label: 'Fronts and backs' }],
        ariaLabel: 'Sides',
        onChange: (v) => {
          setOption('only_fronts', v === 'fronts');
          loadBackImage();
        },
      });
      const sidesCard = ui.card({
        title: 'Sides',
        icon: 'layers',
        children: [
          fkWrap('sides', refs.sidesSeg),
          slot(() => [opts.only_fronts, opts.load_offset, settings?.pdf?.printBackFaces, summary()?.double_sided, summary()?.back, offsetInfo, backImage?.url], renderSidesExtras),
        ],
      });

      const resolutionCard = ui.card({
        title: 'Print resolution',
        icon: 'gauge',
        actions: [ui.helpTip(CREATE_PDF_OPTIONS.ppi.help)],
        children: slot(() => {
          const input = estimateInput();
          return [ppiMode, ppiMode === 'preset' ? opts.ppi : 'custom', input && [input.layout?.key, input.sheets, input.pagesPerSheet, input.loadOffset, input.totalMemBytes, input.budgetPercent, input.isImages], plan?.resources?.durationSecEst];
        }, renderResolution),
      });

      const upscaleCard = ui.card({
        title: 'Upscaling',
        icon: 'sparkles',
        children: slot(() => [env()?.upscayl?.found, settings?.upscayl?.enabled, plan?.upscale], renderUpscale),
      });

      const more = ui.section({
        title: 'More options',
        description: 'Image fixes, back side, sheet layout, registration marks, quality and output.',
        icon: 'sliders',
        collapsible: true,
        collapsed: !session.moreOpen,
        onToggle: (collapsed) => { session.moreOpen = !collapsed; },
        children: slot(() => [opts.only_fronts, opts.paper_size, opts.specialty, opts.fit, opts.registration, opts.registration_orientation, settings?.equipment?.machine, opts.show_outline, opts.output_images, opts.load_offset, opts.borderless, !!totalMem()], renderMoreOptions),
      });

      // Output
      refs.nameInput = ui.textInput({ value: stripPdfExtension(settings?.pdf?.fileName || ''), placeholder: 'proxies', maxLength: 120, ariaLabel: 'File name', onInput: (v) => setFileName(v) });
      refs.nameInput.style.width = '100%';
      refs.nameSuffix = h('span.muted.mono', '.pdf');
      refs.useDeckName = ui.button({
        label: 'Use the deck name',
        size: 'sm',
        variant: 'link',
        onClick: () => {
          refs.nameInput.value = '';
          updateSettings({ pdf: { fileName: null } }, { key: 'fileName' });
          updateRefs();
          schedulePlan(0);
        },
      });
      refs.nameField = ui.field({
        label: 'File name',
        control: ui.row({ gap: 8, wrap: false }, h('div', { style: { flex: '1', minWidth: '0' } }, fkWrap('filename', refs.nameInput)), refs.nameSuffix, refs.useDeckName),
      });
      refs.nameLabel = refs.nameField.querySelector('.field-label');
      refs.folderText = h('span.small.truncate', { style: { flex: '1', minWidth: '0' } });
      refs.folderReset = ui.button({ label: 'Default', size: 'sm', variant: 'ghost', title: 'Save in the default folder again', onClick: resetFolder });
      const folderField = ui.field({
        label: 'Folder',
        control: ui.row({ gap: 8, wrap: false },
          h('span', { style: { color: 'var(--muted)', display: 'inline-flex' } }, icon('folder', { size: 16 })),
          refs.folderText,
          ui.button({ label: 'Change…', size: 'sm', onClick: chooseFolder }),
          ui.button({ icon: 'folder-open', size: 'sm', variant: 'ghost', title: 'Open the folder', onClick: openFolder }),
          refs.folderReset),
      });
      refs.openWhenDone = ui.toggle({
        checked: settings?.pdf?.openWhenDone !== false,
        label: 'Open the PDF when it is ready',
        description: 'Skipped for very big files (over 300 MB).',
        onChange: (v) => updateSettings({ pdf: { openWhenDone: v } }),
      });
      const outputCard = ui.card({
        title: 'Save',
        icon: 'save',
        children: [refs.nameField, folderField, fkWrap('open-when-done', refs.openWhenDone)],
      });

      const problemsSlot = createSlot(() => [planKey(), ackNoTemplate(), ignoreMemory(), summary()?.front], renderProblems);
      slots.push(problemsSlot);
      refs.problems = problemsSlot.el;

      const mainCol = [
        slot(() => [stacked, plan?.ok, (plan?.errors || []).length, runningJob()?.kind === 'pdf'], renderStackedStatus),
        slot(() => [settings?.fetch?.lastFetched, opts.card_size, opts.crop, opts.extend_corners, opts.extend_edges, opts.specialty, [...session.dismissedRecommendation].length], renderRecommendation),
        sizeCard,
        machineCard,
        sidesCard,
        resolutionCard,
        upscaleCard,
        more,
        outputCard,
      ];

      // Right column ------------------------------------------------------------------------------
      preview = pagePreview({
        layout: previewLayout(),
        skip: currentSkip(),
        registration: opts.registration === '4' ? '4' : '3',
        cardsOnLastSheet: cardsOnLastSheet(),
        onToggleSkip: toggleSkip,
      });
      const previewCard = ui.card({
        title: 'Sheet preview',
        icon: 'grid',
        children: [h('div', { style: { width: '100%', maxWidth: '560px', margin: '0 auto' } }, preview), slot(() => [currentLayoutKey(), !!currentLayout(), opts.registration, currentSkip(), plan?.lastSheetEmpty, plan?.cards?.total, perPage()], renderPreviewExtras)],
      });
      // The progress card, then the result card, appear where the Create button is.
      const asideCol = [
        slot(() => [runningJob()?.jobId, runningJob()?.kind], renderProgress),
        slot(() => [store.get('lastResults')?.pdf?.jobId, store.get('lastResults')?.pdf?.status, [...session.dismissedResults].join(','), runningJob()?.kind === 'pdf'], renderResult),
        slot(() => [plan && [plan.ok, plan.cards, plan.sheets, plan.pdfPages, plan.perPage, plan.effectivePerSheet, plan.skip, plan.resources, plan.output, plan.layoutKey, (plan.errors || []).length], planError, planSlow, opts.ppi, opts.only_fronts, opts.output_images, opts.specialty, opts.borderless, runningJob()?.jobId, runningJob()?.kind, successShown()], renderSummary),
        problemsSlot.el,
        slot(() => [planKey(), settings?.fetch?.lastFetched, opts.card_size, opts.crop, opts.extend_corners, opts.extend_edges, opts.registration, opts.paper_size, settings?.equipment?.machine], renderNotes),
        previewCard,
        slot(() => [plan?.template, plan?.requires, plan?.errors, ackNoTemplate(), currentLayoutKey()], renderTemplate),
        slot(() => [plan?.display, plan?.displayEquivalent], renderCommand),
      ];

      const twoCol = ui.twoColumn({ main: mainCol, aside: asideCol, asideWidth: 340 });

      const header = ui.pageHeader({
        title: 'Make PDF',
        subtitle: 'Lay out your cards on printable sheets, with the corner marks your cutting machine needs.',
        icon: 'file-pdf',
        step: 4,
        actions: [ui.button({ label: 'Presets', icon: 'star', onClick: openPresets })],
      });

      ui.mountInto(container, header, twoCol, slot(() => [store.get('lastResults')?.pdf?.status, summary()?.front > 0], renderNextStep));

      if (resizeObserver) resizeObserver.disconnect();
      resizeObserver = null;
      const mainEl = twoCol.querySelector('.two-col-main');
      const asideEl = twoCol.querySelector('.two-col-aside');
      if (typeof ResizeObserver === 'function' && mainEl && asideEl) {
        resizeObserver = new ResizeObserver(() => {
          const now = asideEl.getBoundingClientRect().top > mainEl.getBoundingClientRect().top + 40;
          if (now === stacked) return;
          stacked = now;
          // Re-render outside the observer callback (no "ResizeObserver loop" errors).
          requestAnimationFrame(() => refresh());
        });
        resizeObserver.observe(twoCol);
      }
    }

    function rebuild() {
      if (disposed) return;
      const scroller = document.getElementById('main');
      const top = scroller ? scroller.scrollTop : 0;
      const saved = captureFocus(container);
      build();
      refresh(true);
      updateRefs(true);
      if (scroller) scroller.scrollTop = top;
      restoreFocus(container, saved);
    }

    /* ------------------------------ subscriptions ------------------------------ */

    ctx.subscribe('settings', (next) => {
      if (!next || disposed) return;
      if (pendingWrites() > 0) return; // our optimistic copy is newer; re-synced when writes settle
      applyIncomingSettings(next);
    });
    ctx.subscribe('cards', () => {
      refresh();
      loadBackImage();
      schedulePlan();
    });
    ctx.subscribe('env', () => {
      refresh();
      schedulePlan();
    });
    ctx.subscribe('introspection', () => {
      updateRefs(true);
      refresh();
      if (!plan) schedulePlan(0);
    });
    let lastJobKey = '';
    ctx.subscribe('job', () => {
      const j = runningJob();
      const key = j ? `${j.jobId}|${j.kind}` : '';
      if (key !== lastJobKey) {
        lastJobKey = key;
        refresh();
      } else {
        updateProgress();
      }
    });
    ctx.subscribe('lastResults', (next, prev) => {
      refresh();
      if (next?.pdf?.jobId !== prev?.pdf?.jobId || next?.offset?.jobId !== prev?.offset?.jobId) schedulePlan(0);
    });

    /* ------------------------------ start ------------------------------ */

    session.machineEditing = false;
    build();
    refresh(true);
    updateRefs(true);
    runPlan();
    loadOffset();
    loadBackImage();

    return () => {
      disposed = true;
      clearTimeout(planTimer);
      clearTimeout(planSlowTimer);
      if (resizeObserver) resizeObserver.disconnect();
      // Persist typed values that were still waiting for their debounce.
      const entries = [...writeTimers.values()];
      writeTimers.clear();
      for (const e of entries) {
        clearTimeout(e.timer);
        Promise.resolve().then(() => api.settings.update(e.patch)).catch(() => {});
      }
    };
  },
};
