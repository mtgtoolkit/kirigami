'use strict';

/**
 * pdf.js — plan and make the print-ready PDF (spec §9.8).
 *
 * planPdf(deps, options)     → PdfPlan: layout (aliases resolved through the engine introspection),
 *                              card counts, back, every blocking error / warning / notice (with the
 *                              fix/action contract shared with views/pdf.js), sheets, cutting
 *                              template, memory/disk/time estimates, automatic chunking, upscale
 *                              estimate, output naming and the equivalent command line. No side effects.
 * startPdfJob(deps, options) → re-plans (rejects when the plan is not ok), checks that the output file
 *                              is not locked, then runs a 'pdf' job: optional upscale step, staging of
 *                              the chosen images under game/.stage/<jobId>/ (hard links), one
 *                              create_pdf.py run per chunk, lossless merge, safe rename, cleanup.
 *
 * Engine facts this module relies on (spec §1, verified in utilities.generate_pdf):
 * - create_pdf orders cards as natsorted(single-sided fronts) + natsorted(double-sided rel paths)
 *   (natsort 8.4 default algorithm on the OS-native relative path strings); sheets take
 *   `cardsPerPage - skipped` cards each; "Image N: <file>" is printed per card; the label printed on a
 *   sheet is `label: <label>, sheet: <n>, template: <name>` with n restarting at 1 per run.
 * - Unique backs pair with fronts by relative path without extension; the app stages each unique back
 *   under the SAME relative name (and extension) as its staged front, so the engine never needs its
 *   glob() fallback (which breaks on '[', ']', '*', '?' and on several extensions).
 * - The common back folder must contain 0 or 1 image (2+ makes the engine wait for keyboard input):
 *   the app always passes a staged back folder.
 *
 * No require('electron'): everything comes through `deps` (spec §12). Services written in parallel
 * (cards.js, upscayl.js) are loaded lazily and every call to them is guarded.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const util = require('./util');
const scan = require('./scan');
const { userError, friendlyError } = require('./errors');

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** settings.pdf.options keys (spec §4) = the create_pdf options the app manages. */
const PDF_OPTION_KEYS = Object.freeze([
  'card_size', 'paper_size', 'registration', 'registration_orientation', 'specialty', 'only_fronts', 'fit',
  'fit_backs', 'crop', 'crop_backs', 'extend_edges', 'extend_edges_backs', 'extend_corners',
  'extend_corners_backs', 'extend_bleed', 'extend_bleed_backs', 'ppi', 'quality', 'load_offset', 'label',
  'show_outline', 'borderless', 'output_images',
]);

/** Same defaults as settings.DEFAULT_SETTINGS.pdf.options (used when settings are incomplete). */
const DEFAULT_PDF_OPTIONS = Object.freeze({
  card_size: 'standard', paper_size: 'a4', registration: '4', registration_orientation: null, specialty: null,
  only_fronts: true, fit: 'stretch', fit_backs: null, crop: null, crop_backs: null, extend_edges: '0.5mm',
  extend_edges_backs: null, extend_corners: '2mm', extend_corners_backs: null, extend_bleed: null,
  extend_bleed_backs: null, ppi: 1440, quality: 100, load_offset: false, label: null, show_outline: false,
  borderless: false, output_images: false,
});

const BOOLEAN_OPTIONS = new Set(['only_fronts', 'load_offset', 'show_outline', 'borderless', 'output_images']);
/** Options that always need a value: null/'' falls back to the default. */
const REQUIRED_OPTIONS = new Set(['card_size', 'paper_size', 'registration', 'fit', 'ppi', 'quality']);

/** Length options: 'crop' → mm | in | bare number = PERCENT; 'extend' → mm | in | bare number = PIXELS at 300 PPI. */
const LENGTH_OPTIONS = Object.freeze({
  crop: 'crop',
  crop_backs: 'crop',
  extend_edges: 'extend',
  extend_edges_backs: 'extend',
  extend_corners: 'extend',
  extend_corners_backs: 'extend',
  extend_bleed: 'extend',
  extend_bleed_backs: 'extend',
});

/** Plain-language option names (spec §8.4 copy rules). */
const OPTION_LABELS = Object.freeze({
  crop: 'Trim image edges',
  crop_backs: 'Trim image edges (backs)',
  extend_edges: 'Trim thin edge lines',
  extend_edges_backs: 'Trim thin edge lines (backs)',
  extend_corners: 'Fill rounded corners',
  extend_corners_backs: 'Fill rounded corners (backs)',
  extend_bleed: 'Extra outer bleed',
  extend_bleed_backs: 'Extra outer bleed (backs)',
  fit: 'Image shape',
  fit_backs: 'Image shape (backs)',
  card_size: 'Card size',
  paper_size: 'Paper',
  registration: 'Registration marks',
  registration_orientation: 'Registration mark orientation',
  ppi: 'Print resolution',
  quality: 'JPEG quality',
  label: 'Text printed on each sheet',
});

/** create_pdf options always written to the command line (even when equal to the engine default). */
const ALWAYS_EMITTED = new Set(['registration', 'ppi', 'quality']);

const MIN_PPI = 1;
const MAX_PPI = 2400;
const LOW_PPI_WARNING = 150;
const LOW_QUALITY_WARNING = 50;
const MAX_LABEL_CHARS = 40;
const CROP_WARNING_PERCENT = 15;
const MEMORY_ERROR_FRACTION = 0.85;
const MEMORY_WARNING_FRACTION = 0.5;
const MAX_BUDGET_PERCENT = 85;
const MIN_BUDGET_PERCENT = 0.01;
/** Pages kept in memory by create_pdf besides the finished pages (spec §1: measured ≈ (pages + 6) × page). */
const EXTRA_PAGE_BUFFERS = 6;
const LOAD_OFFSET_FACTOR = 1.5;
/**
 * Output size ≈ raw page bytes × factor(ppi). Pages are JPEG quality 100 (4:4:4) of up-sampled card
 * pictures, which compress better the higher the PPI. Measured on A4 pages of typical card images:
 * 0.28 at 300 PPI, 0.16 at 600, 0.088–0.128 at 1440 (spec: 0.09) → 0.28 × (ppi / 300)^-0.6, on the
 * safe side because the estimate also guards the free disk space check.
 */
const PDF_BYTES_FACTOR_300 = 0.28;
const PDF_BYTES_EXPONENT = -0.6;
/** PNG pages (lossless) measured ≈ 0.25 of raw at 300 PPI: a little above the JPEG curve. */
const PNG_BYTES_RATIO = 1.1;
const DISK_MARGIN = 1.2;
const DISK_MARGIN_CHUNKED = 2.2; // parts + merged copy exist at the same time
/** Python start-up per create_pdf run (seconds; measured 0.9–1.6 s), added to time estimates. */
const RUN_OVERHEAD_SEC = 1.5;
const AUTO_OPEN_MAX_BYTES = 300 * 1024 * 1024;
const UPSCALE_BYTES_PER_IMAGE_4X = 15 * 1024 * 1024;
const LOW_RES_PPI = 150;
const ASPECT_TOLERANCE = 0.08;
const RENAME_RETRIES = 10;
const FACE_SUFFIX = ' (back face)';
const PPI_CANDIDATES = Object.freeze([1200, 1000, 900, 800, 720, 600, 500, 450, 400, 360, 300, 250, 200, 150, 100, 72]);
const MACHINE_REGISTRATION = Object.freeze({
  cameo5alpha: ['4', '3'], cameo5: ['3'], cameo4: ['3'], portrait: ['3'], other: ['3'],
});
const MACHINE_LABELS = Object.freeze({
  cameo5alpha: 'Cameo 5 Alpha', cameo5: 'Cameo 5', cameo4: 'Cameo 4', portrait: 'Portrait', other: 'machine',
});
const PORTRAIT_PAPERS = new Set(['letter', 'a4']);
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const IMAGE_LINE_RE = /^Image (\d+): (.*)$/;
const PAGE_FILE_RE = /^page(\d+)\.png$/i;
/** utilities.generate_pdf: OSError(f'Failed to load front image "{path}": …') (also back / double-sided). */
const FAILED_IMAGE_RE = /Failed to load (front|back|double-sided) image "([^"]*)"/;
const KIND_PHRASES = Object.freeze({ front: 'card fronts', double_sided: 'unique backs', back: 'common back' });

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function lazyService(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`./${name}`);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`${name}`)) return null;
    throw err;
  }
}

/** A sibling service: `deps.seams[name]` (tests, same convention as python-env) or ./<name>.js. */
function service(deps, name) {
  const seams = deps && deps.seams && typeof deps.seams === 'object' ? deps.seams : null;
  if (seams && seams[name]) return seams[name];
  return lazyService(name);
}

function logger(deps) {
  const l = deps && deps.logger;
  const noop = () => {};
  return {
    info: l && typeof l.info === 'function' ? l.info.bind(l) : noop,
    warn: l && typeof l.warn === 'function' ? l.warn.bind(l) : noop,
  };
}

function settingsOf(deps) {
  try {
    const s = deps && deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : null;
    return isObj(s) ? s : {};
  } catch {
    return {};
  }
}

function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} bytes`;
}

function formatDate(ms) {
  if (!Number.isFinite(ms)) return 'earlier';
  try {
    return new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ms).toISOString();
  }
}

function listNames(rels, max = 3) {
  const names = rels.slice(0, max).map((r) => `"${String(r).split('/').pop()}"`);
  const more = rels.length > max ? ` and ${rels.length - max} more` : '';
  return `${names.join(', ')}${more}`;
}

function titleCase(name) {
  return String(name).replace(/_/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function stemOf(rel) {
  const name = String(rel).split(/[\\/]/).pop();
  return scan.nameParts(name).stem;
}

function relNoExtOf(rel) {
  const parts = String(rel).split('/');
  const name = parts.pop();
  const { stem } = scan.nameParts(name);
  return parts.length ? `${parts.join('/')}/${stem}` : stem;
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

/** Identifier of the volume holding `dir` (nearest existing parent); null when unknown. */
async function volumeKey(dir) {
  let current = path.resolve(dir);
  for (let i = 0; i < 128; i += 1) {
    const st = await statSafe(current);
    if (st) return `${st.dev}`;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// natsort (Python natsort 8.4 default algorithm) — the order create_pdf uses
// ---------------------------------------------------------------------------------------------

/** natsort's "digits without a decimal value" (superscripts, circled digits, …) with their digit values. */
const NON_DECIMAL_DIGITS = new Map([
  [0xb2, 2], [0xb3, 3], [0xb9, 1], [0x19da, 1], [0x2070, 0], [0x24ea, 0], [0x24ff, 0], [0x1f100, 0], [0x1f101, 0],
  ...[0x2074, 0x2075, 0x2076, 0x2077, 0x2078, 0x2079].map((cp, i) => [cp, i + 4]),
  ...Array.from({ length: 10 }, (_, i) => [0x2080 + i, i]),
  ...Array.from({ length: 9 }, (_, i) => [0x1369 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x2460 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x2474 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x2488 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x24f5 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x2776 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x2780 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x278a + i, i + 1]),
  ...Array.from({ length: 4 }, (_, i) => [0x10a40 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x10e60 + i, i + 1]),
  ...Array.from({ length: 9 }, (_, i) => [0x11052 + i, i + 1]),
  ...Array.from({ length: 10 }, (_, i) => [0x1f101 + i, i === 0 ? 0 : i - 1]),
]);
const NON_DECIMAL_CLASS = Array.from(NON_DECIMAL_DIGITS.keys())
  .map((cp) => `\\u{${cp.toString(16)}}`)
  .join('');
const NATSORT_SPLIT_RE = new RegExp(`(\\p{Nd}+|[${NON_DECIMAL_CLASS}])`, 'u');
const ND_RE = /^\p{Nd}$/u;
const ND_RUN_RE = /^\p{Nd}+$/u;

/** Decimal value of one Unicode decimal digit (runs of Nd code points start at a zero digit). */
function decimalDigitValue(cp) {
  if (cp >= 0x30 && cp <= 0x39) return cp - 0x30;
  let start = cp;
  while (start > 0 && ND_RE.test(String.fromCodePoint(start - 1))) start -= 1;
  return (cp - start) % 10;
}

function digitsToBigInt(text) {
  if (/^[0-9]+$/.test(text)) return BigInt(text);
  let value = 0n;
  for (const ch of text) value = value * 10n + BigInt(decimalDigitValue(ch.codePointAt(0)));
  return value;
}

/**
 * natsort key of a string: NFD-normalized, split into text and numbers (Unicode decimal digit runs
 * and single non-decimal digits), '' inserted before a leading number and between adjacent numbers.
 * @param {string} s
 * @returns {Array<string|bigint>}
 */
function natsortKey(s) {
  const parts = String(s).normalize('NFD').split(NATSORT_SPLIT_RE).filter((p) => p !== '');
  const key = [];
  let prevNumber = false;
  for (const part of parts) {
    let value;
    if (ND_RUN_RE.test(part)) value = digitsToBigInt(part);
    else if ([...part].length === 1 && NON_DECIMAL_DIGITS.has(part.codePointAt(0))) value = BigInt(NON_DECIMAL_DIGITS.get(part.codePointAt(0)));
    if (value !== undefined) {
      if (key.length === 0 || prevNumber) key.push('');
      key.push(value);
      prevNumber = true;
    } else {
      key.push(part);
      prevNumber = false;
    }
  }
  return key;
}

/** Python str comparison (by code point). */
function compareCodePoints(a, b) {
  if (a === b) return 0;
  const la = a.length;
  const lb = b.length;
  let i = 0;
  let j = 0;
  while (i < la && j < lb) {
    const ca = a.codePointAt(i);
    const cb = b.codePointAt(j);
    if (ca !== cb) return ca < cb ? -1 : 1;
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < la) return 1;
  if (j < lb) return -1;
  return 0;
}

function compareKeys(ka, kb) {
  const n = Math.min(ka.length, kb.length);
  for (let i = 0; i < n; i += 1) {
    const a = ka[i];
    const b = kb[i];
    if (typeof a === 'bigint' && typeof b === 'bigint') {
      if (a !== b) return a < b ? -1 : 1;
    } else if (typeof a === 'string' && typeof b === 'string') {
      const c = compareCodePoints(a, b);
      if (c) return c;
    } else {
      // never happens with natsort keys (types alternate); keep a total order anyway
      return typeof a === 'string' ? -1 : 1;
    }
  }
  return ka.length === kb.length ? 0 : ka.length < kb.length ? -1 : 1;
}

/**
 * Comparator equivalent to Python `natsorted` (natsort 8.4, default algorithm). Equal keys (e.g.
 * "a01" / "a1") are ordered by code point so the result is deterministic (Python keeps them in set
 * iteration order, which JavaScript cannot reproduce).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNatsort(a, b) {
  return compareKeys(natsortKey(a), natsortKey(b)) || compareCodePoints(String(a), String(b));
}

function relOf(x) {
  return typeof x === 'string' ? x : x && typeof x.rel === 'string' ? x.rel : null;
}

/**
 * Order cards exactly like create_pdf: natsort of the single-sided fronts (fronts whose stem is not a
 * unique-back stem), then natsort of the unique backs' relative paths. Keys use the OS-native relative
 * path (Python's os.path.relpath), so pass `sep` = path.sep of the machine that runs the engine.
 * Elements may be strings (POSIX relative paths) or objects with a `rel` property; they are returned
 * unchanged. Duplicate stems among fronts keep only their first occurrence (the engine keeps one).
 * @template T
 * @param {Array<T>} fronts
 * @param {Iterable<T>} dsSet unique backs (staged under the same relative names as their fronts)
 * @param {{ sep?: string }} [opts]
 * @returns {T[]} single-sided fronts first, then the unique backs
 */
function orderLikeCreatePdf(fronts, dsSet, { sep = path.sep } = {}) {
  const native = (rel) => (sep === '/' ? rel : rel.split('/').join(sep));
  const ds = Array.from(dsSet || []).filter((x) => relOf(x));
  const dsStems = new Set(ds.map((x) => stemOf(relOf(x))));
  const seen = new Set();
  const singles = [];
  for (const f of Array.from(fronts || [])) {
    const rel = relOf(f);
    if (!rel) continue;
    const stem = stemOf(rel);
    if (dsStems.has(stem) || seen.has(stem)) continue;
    seen.add(stem);
    singles.push(f);
  }
  const sortNat = (list) => list
    .map((x) => ({ x, native: native(relOf(x)) }))
    .sort((a, b) => compareNatsort(a.native, b.native))
    .map((e) => e.x);
  return [...sortNat(singles), ...sortNat(ds)];
}

/**
 * Split an ordered card list into chunks of `perChunk` cards (the last one may be smaller).
 * @template T
 * @param {T[]} orderedCards
 * @param {number} perChunk cards per chunk (sheetsPerChunk × cards per sheet)
 * @returns {T[][]}
 */
function chunkCards(orderedCards, perChunk) {
  const list = Array.from(orderedCards || []);
  const size = Math.max(1, Math.floor(Number(perChunk)) || list.length || 1);
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Option parsing / validation (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Parse a length option like the engine (utilities.parse_crop_string / parse_dimension_string).
 * Lenient on input (spaces, upper case, a trailing '%' for crop or 'px' for extend options) and
 * returns the normalized engine string.
 * @param {unknown} value
 * @param {'crop'|'extend'} kind crop: bare number = percent removed in total; extend: bare number = pixels at 300 PPI
 * @returns {{ ok: true, value: string|null, amount?: number, unit?: 'mm'|'in'|'%'|'px' } | { ok: false, reason: string }}
 */
function parseLength(value, kind) {
  if (value === null || value === undefined) return { ok: true, value: null };
  let s = String(value).trim().toLowerCase();
  if (s === '') return { ok: true, value: null };
  s = s.replace(/\s+/g, '');
  if (kind === 'crop' && s.endsWith('%')) s = s.slice(0, -1);
  if (kind === 'extend' && s.endsWith('px')) s = s.slice(0, -2);
  if (s.startsWith('-')) return { ok: false, reason: 'negative' };
  if (/^\d*,\d*(mm|in)?$/.test(s) && /\d/.test(s)) return { ok: false, reason: 'comma' };
  const m = /^((?:\d+\.\d*|\.\d+|\d+))(mm|in)?$/.exec(s);
  if (!m) return { ok: false, reason: 'format' };
  const amount = Number(m[1]);
  if (!Number.isFinite(amount)) return { ok: false, reason: 'format' };
  const unit = m[2] || (kind === 'crop' ? '%' : 'px');
  return { ok: true, value: `${m[1]}${m[2] || ''}`, amount, unit };
}

/** Pixels at 300 PPI of a parsed extend_* length (utilities.parse_dimension_string at layout ppi 300). */
function lengthToPx300(parsed) {
  if (!parsed || !parsed.ok || parsed.value === null) return 0;
  if (parsed.unit === 'mm') return Math.floor((parsed.amount / 25.4) * 300);
  if (parsed.unit === 'in') return Math.floor(parsed.amount * 300);
  return Math.trunc(parsed.amount);
}

/** Percent of the picture removed in total [x, y] for a parsed crop length (utilities.convertInToCrop). */
function cropPercent(parsed, cardWidthPx, cardHeightPx) {
  if (!parsed || !parsed.ok || parsed.value === null) return [0, 0];
  if (parsed.unit === '%') return [parsed.amount, parsed.amount];
  const inches = parsed.unit === 'mm' ? parsed.amount / 25.4 : parsed.amount;
  const w = (cardWidthPx || 1) / 300;
  const h = (cardHeightPx || 1) / 300;
  return [((2 * inches) / w) * 100, ((2 * inches) / h) * 100];
}

function lengthHint(kind) {
  return kind === 'crop'
    ? 'Use a length like 3mm or 0.125in, or a percentage like 5.'
    : 'Use a length like 2mm or 0.1in, or a number of pixels like 6.';
}

function lengthErrorMessage(key, kind, reason) {
  const label = OPTION_LABELS[key] || key;
  if (reason === 'comma') return `"${label}" uses a comma: write the decimal with a dot (for example 0.5mm).`;
  if (reason === 'negative') return `"${label}" can't be negative. ${lengthHint(kind)}`;
  return `"${label}" isn't a length the card maker understands. ${lengthHint(kind)}`;
}

function toIntOrNaN(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && /^\s*[-+]?\d+\s*$/.test(value)) return Number(value.trim());
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return NaN;
}

/**
 * Merge settings.pdf.options with the request (request wins) and normalize types.
 * @param {object} settings full settings
 * @param {object} request options from the renderer (settings.pdf.options keys + extras)
 * @returns {{ opts: object, extra: { upscale: boolean, fileName: string|null, outputDir: string|null,
 *   ackNoTemplate: boolean, ignoreMemoryLimit: boolean, printBackFaces: boolean } }}
 */
function normalizeOptions(settings, request) {
  const s = isObj(settings) ? settings : {};
  const pdf = isObj(s.pdf) ? s.pdf : {};
  const saved = isObj(pdf.options) ? pdf.options : {};
  const req = isObj(request) ? request : {};
  const opts = {};
  for (const key of PDF_OPTION_KEYS) {
    let v = DEFAULT_PDF_OPTIONS[key];
    if (Object.prototype.hasOwnProperty.call(saved, key) && saved[key] !== undefined) v = saved[key];
    if (Object.prototype.hasOwnProperty.call(req, key) && req[key] !== undefined) v = req[key];
    if (REQUIRED_OPTIONS.has(key) && (v === null || v === '' || (typeof v === 'string' && !v.trim()))) v = DEFAULT_PDF_OPTIONS[key];
    if (BOOLEAN_OPTIONS.has(key)) {
      v = v === true || v === 'true';
    } else if (key === 'ppi' || key === 'quality') {
      v = toIntOrNaN(v);
    } else if (v === null || v === undefined) {
      v = null;
    } else {
      if (typeof v !== 'string') v = typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
      if (v !== null) {
        v = key === 'label' ? v.replace(/[\r\n\t]+/g, ' ').trim() : v.trim();
        if (v === '') v = null;
        else if (key !== 'label' && !LENGTH_OPTIONS[key]) v = v.toLowerCase();
      }
    }
    opts[key] = v;
  }
  const upscayl = isObj(s.upscayl) ? s.upscayl : {};
  const pick = (key, fallback) => (Object.prototype.hasOwnProperty.call(req, key) && req[key] !== undefined && req[key] !== null ? req[key] : fallback);
  const fileNameRaw = pick('fileName', pdf.fileName);
  const outputDirRaw = pick('outputDir', null);
  const extra = {
    upscale: pick('upscale', upscayl.enabled !== false) === true,
    fileName: typeof fileNameRaw === 'string' && fileNameRaw.trim() ? fileNameRaw.trim() : null,
    outputDir: typeof outputDirRaw === 'string' && outputDirRaw.trim() ? outputDirRaw.trim() : null,
    ackNoTemplate: req.ackNoTemplate === true,
    ignoreMemoryLimit: req.ignoreMemoryLimit === true,
    printBackFaces: pick('printBackFaces', pdf.printBackFaces !== false) === true,
  };
  return { opts, extra };
}

function resolveSizeName(value, entries, aliasMap) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  const list = Array.isArray(entries) ? entries : [];
  const exact = list.find((e) => e && typeof e.name === 'string' && e.name.toLowerCase() === v);
  if (exact) return exact.name;
  for (const [alias, canonical] of Object.entries(isObj(aliasMap) ? aliasMap : {})) {
    if (alias.toLowerCase() === v) return canonical;
  }
  for (const e of list) {
    if (e && Array.isArray(e.aliases) && e.aliases.some((a) => String(a).toLowerCase() === v)) return e.name;
  }
  return null;
}

/**
 * Resolve the layout for the options (aliases → canonical names; specialty; borderless variant).
 * @param {object} introspection helper.introspect() result
 * @param {object} opts normalized options
 * @returns {{ layout: object|null, layoutKey: string|null, cardSize: string|null, paperSize: string|null,
 *   variant: string|null, errors: Array<{code: string, message: string}> }}
 */
function resolveLayout(introspection, opts) {
  const L = introspection && isObj(introspection.layouts) ? introspection.layouts : {};
  const aliases = isObj(L.aliases) ? L.aliases : {};
  const combos = Array.isArray(L.combos) ? L.combos : [];
  const specialties = Array.isArray(L.specialty) ? L.specialty : [];
  const errors = [];
  const out = { layout: null, layoutKey: null, cardSize: null, paperSize: null, variant: null, errors };

  if (opts.specialty) {
    const wanted = String(opts.specialty).toLowerCase();
    const layout = specialties.find((s) => s && String(s.name || s.specialty || '').toLowerCase() === wanted) || null;
    if (opts.borderless) {
      errors.push({ code: 'BORDERLESS_SPECIALTY', message: 'Tight layout can\'t be combined with a specialty layout. Turn one of them off.' });
    }
    if (!layout) {
      errors.push({ code: 'UNKNOWN_SPECIALTY', message: `The specialty layout "${opts.specialty}" doesn't exist in this version of the card maker.` });
      return out;
    }
    out.layout = layout;
    out.layoutKey = layout.key || `specialty:${layout.name}`;
    out.paperSize = layout.paper || null;
    out.cardSize = layout.card || null;
    if (layout.error) errors.push({ code: 'LAYOUT_ERROR', message: 'This specialty layout can\'t be used with this version of the card maker.' });
    return out;
  }

  const card = resolveSizeName(opts.card_size, L.cardSizes, aliases.card);
  const paper = resolveSizeName(opts.paper_size, L.paperSizes, aliases.paper);
  out.cardSize = card;
  out.paperSize = paper;
  if (!card) errors.push({ code: 'UNKNOWN_CARD_SIZE', message: `Unknown card size "${opts.card_size || ''}". Choose a card size from the list.` });
  if (!paper) errors.push({ code: 'UNKNOWN_PAPER_SIZE', message: `Unknown paper size "${opts.paper_size || ''}". Choose a paper from the list.` });
  if (!card || !paper) return out;
  const variant = opts.borderless ? 'borderless' : 'default';
  out.variant = variant;
  if (opts.borderless && (paper === 'a3' || paper === 'arch_b')) {
    errors.push({ code: 'BORDERLESS_UNSUPPORTED', message: 'Tight layout is not supported on A3 / Arch B yet. Turn off Tight layout or choose another paper.' });
  }
  const key = `${paper}|${card}|${variant}`;
  const layout = combos.find((c) => c && c.key === key)
    || combos.find((c) => c && c.paper === paper && c.card === card && (c.variant || 'default') === variant)
    || null;
  if (!layout) {
    errors.push({ code: 'NO_LAYOUT', message: 'This card size has no layout for this paper. Choose another paper or card size.' });
    return out;
  }
  out.layout = layout;
  out.layoutKey = layout.key || key;
  if (layout.error) errors.push({ code: 'LAYOUT_ERROR', message: 'This card size doesn\'t fit on this paper. Choose a bigger paper.' });
  return out;
}

/**
 * Exact-case stem collisions over a whole folder tree (the engine keys files by Path.stem).
 * @param {Array<{rel: string, stem: string}>} images
 * @returns {Array<{ stem: string, files: string[] }>}
 */
function findStemCollisions(images) {
  const groups = new Map();
  for (const img of images || []) {
    const stem = img.stem !== undefined ? img.stem : stemOf(img.rel);
    if (!groups.has(stem)) groups.set(stem, []);
    groups.get(stem).push(img.rel);
  }
  return Array.from(groups, ([stem, files]) => ({ stem, files })).filter((g) => g.files.length > 1);
}

function collisionMessage(groups, kindLabel) {
  const first = groups[0];
  const shown = first.files.slice(0, 3).map((f) => f.split('/').pop()).join(' and ');
  if (groups.length === 1) {
    return `Two ${kindLabel} share the name "${first.stem}" (${shown}): only one of them would be printed.`;
  }
  return `${groups.length} names are used by more than one of your ${kindLabel} (for example "${first.stem}": ${shown}): only one of each would be printed.`;
}

/**
 * Peak memory, budget, chunking and output size (spec §9.8 step 8; pure).
 * @param {object} input
 * @param {number} input.pageWidthPx300 landscape page bitmap width at 300 PPI (layout.pageWidthPx300)
 * @param {number} input.pageHeightPx300
 * @param {number} input.ppi
 * @param {number} input.sheets
 * @param {number} input.pagesPerSheet 1 (fronts only) or 2
 * @param {boolean} [input.loadOffset] alignment applied (fronts and backs): every 2nd page is copied
 * @param {number} [input.memoryBudgetPercent=50] clamped to 0.01–85
 * @param {number} input.totalMemBytes
 * @param {boolean} [input.isImages] PNG pages instead of a PDF
 * @returns {{ pageWidthPx: number, pageHeightPx: number, pageBytes: number, peakBytes: number,
 *   singleSheetPeakBytes: number, budgetBytes: number, totalMemBytes: number, chunks: number,
 *   sheetsPerChunk: number, pdfPages: number, pdfBytesEst: number, memoryFraction: number,
 *   overLimit: boolean, highMemory: boolean }}
 */
function computeResources(input) {
  const {
    pageWidthPx300, pageHeightPx300, ppi, sheets, pagesPerSheet, loadOffset = false,
    memoryBudgetPercent = 50, totalMemBytes, isImages = false,
  } = input || {};
  const ratio = ppi / 300;
  const pageWidthPx = Math.max(0, Math.floor(pageWidthPx300 * ratio));
  const pageHeightPx = Math.max(0, Math.floor(pageHeightPx300 * ratio));
  const pageBytes = pageWidthPx * pageHeightPx * 3;
  const factor = loadOffset ? LOAD_OFFSET_FACTOR : 1;
  const pps = Math.max(1, pagesPerSheet || 1);
  const peak = (pages) => (pages * factor + EXTRA_PAGE_BUFFERS) * pageBytes;
  const pdfPages = Math.max(0, sheets || 0) * pps;
  const pct = Math.min(MAX_BUDGET_PERCENT, Math.max(MIN_BUDGET_PERCENT, Number.isFinite(memoryBudgetPercent) ? memoryBudgetPercent : 50));
  const total = Number.isFinite(totalMemBytes) && totalMemBytes > 0 ? totalMemBytes : 0;
  const budgetBytes = Math.floor((total * pct) / 100);
  let chunks = sheets > 0 ? 1 : 0;
  let sheetsPerChunk = Math.max(0, sheets || 0);
  if (sheets > 0 && pageBytes > 0 && peak(pdfPages) > budgetBytes) {
    const k = Math.floor((budgetBytes / pageBytes - EXTRA_PAGE_BUFFERS) / (factor * pps));
    sheetsPerChunk = Math.max(1, Math.min(sheets, Number.isFinite(k) ? k : 1));
    chunks = Math.ceil(sheets / sheetsPerChunk);
  }
  const peakBytes = sheets > 0 ? peak(Math.min(sheetsPerChunk, sheets) * pps) : 0;
  const singleSheetPeakBytes = peak(pps);
  const memoryFraction = total > 0 ? peakBytes / total : 0;
  const bytesFactor = outputBytesFactor(ppi, isImages);
  return {
    pageWidthPx,
    pageHeightPx,
    pageBytes,
    peakBytes,
    singleSheetPeakBytes,
    budgetBytes,
    totalMemBytes: total,
    chunks,
    sheetsPerChunk,
    pdfPages,
    pdfBytesEst: Math.round(pdfPages * pageBytes * bytesFactor),
    memoryFraction,
    overLimit: total > 0 && peakBytes > MEMORY_ERROR_FRACTION * total,
    highMemory: total > 0 && peakBytes > MEMORY_WARNING_FRACTION * total,
  };
}

/**
 * Compressed size / raw page bytes for the output (see PDF_BYTES_FACTOR_300).
 * @param {number} ppi
 * @param {boolean} [isImages] PNG pages instead of a PDF
 * @returns {number}
 */
function outputBytesFactor(ppi, isImages = false) {
  const p = Number.isFinite(ppi) && ppi > 0 ? ppi : 300;
  const jpeg = Math.min(0.6, Math.max(0.04, PDF_BYTES_FACTOR_300 * (p / 300) ** PDF_BYTES_EXPONENT));
  return isImages ? Math.min(0.8, jpeg * PNG_BYTES_RATIO) : jpeg;
}

/**
 * Highest "nice" PPI below `ppi` whose single-sheet peak fits in `limitBytes` (null when none).
 * @param {{ pageWidthPx300: number, pageHeightPx300: number, ppi: number, pagesPerSheet: number,
 *   loadOffset?: boolean, limitBytes: number }} input
 * @returns {number|null}
 */
function suggestLowerPpi({ pageWidthPx300, pageHeightPx300, ppi, pagesPerSheet, loadOffset = false, limitBytes }) {
  const factor = loadOffset ? LOAD_OFFSET_FACTOR : 1;
  for (const candidate of PPI_CANDIDATES) {
    if (candidate >= ppi) continue;
    const ratio = candidate / 300;
    const bytes = Math.floor(pageWidthPx300 * ratio) * Math.floor(pageHeightPx300 * ratio) * 3;
    if (((pagesPerSheet || 1) * factor + EXTRA_PAGE_BUFFERS) * bytes <= limitBytes) return candidate;
  }
  return null;
}

/**
 * Seconds a create_pdf run should take, from the last measured seconds per card (settings.pdf.secPerCard,
 * measured at settings.pdf.lastPdf.ppi) scaled by (ppi / lastPpi)². null when unknown.
 * @param {{ secPerCard: number|null, lastPpi: number|null, ppi: number, totalCards: number, chunks: number }} input
 * @returns {number|null}
 */
function estimateDuration({ secPerCard, lastPpi, ppi, totalCards, chunks }) {
  if (!Number.isFinite(secPerCard) || secPerCard <= 0 || !totalCards) return null;
  const scale = Number.isFinite(lastPpi) && lastPpi > 0 ? (ppi / lastPpi) ** 2 : 1;
  return Math.max(1, Math.round(totalCards * secPerCard * scale + RUN_OVERHEAD_SEC * Math.max(1, chunks || 1)));
}

/**
 * Label printed on each sheet of one create_pdf run. The engine numbers sheets from 1 in every run,
 * so parts of a chunked PDF get " (part i/n)" (or just "part i/n" without a user label).
 * @param {string|null} userLabel
 * @param {{ index: number, count: number }|undefined} part
 * @returns {string|null}
 */
function partLabel(userLabel, part) {
  const count = part && Number(part.count);
  if (count > 1) {
    const suffix = `part ${part.index}/${count}`;
    return userLabel ? `${userLabel} (${suffix})` : suffix;
  }
  return userLabel || null;
}

function longFlag(param) {
  const flags = Array.isArray(param.flags) ? param.flags : [];
  return flags.find((f) => typeof f === 'string' && f.startsWith('--')) || flags[0] || `--${param.name}`;
}

/**
 * create_pdf.py argument vector (pure, ParamSpec-driven, `--name=value` forms).
 * - Iterates the introspected params in their order; params with exposeValue:false (--version) and
 *   positional arguments are skipped; options unknown to the engine are never written.
 * - Folders/output come from `dirs` / `outputPath`; registration, ppi and quality are always written;
 *   other values only when not null/''; flags only when true; skip = one `--skip=N` per index;
 *   `--load_offset` never with fronts only; when `extra.part.count > 1` the label gets " (part i/n)"
 *   (or is "part i/n" when no label is set) because the engine restarts sheet numbers in every run.
 * @param {Array<object>|{params: Array<object>}} spec introspection.commands.create_pdf(.params)
 * @param {object} options normalized create_pdf options (canonical card/paper names, normalized lengths)
 * @param {{ front: string, back: string, double_sided: string }} dirs cwd-relative POSIX folders
 * @param {string} outputPath
 * @param {{ skip?: number[], part?: { index: number, count: number }, script?: string }} [extra]
 * @returns {string[]} ['create_pdf.py', ...arguments]
 */
function buildCreatePdfArgv(spec, options, dirs, outputPath, extra = {}) {
  const params = Array.isArray(spec) ? spec : spec && Array.isArray(spec.params) ? spec.params : [];
  if (!params.length) throw new TypeError('buildCreatePdfArgv: the create_pdf option list is required');
  const o = isObj(options) ? options : {};
  const x = isObj(extra) ? extra : {};
  const d = isObj(dirs) ? dirs : {};
  const onlyFronts = o.only_fronts === true;
  const skip = Array.isArray(x.skip) ? x.skip : Array.isArray(o.skip) ? o.skip : [];
  const argv = [x.script || 'create_pdf.py'];
  for (const p of params) {
    if (!p || typeof p.name !== 'string' || p.kind === 'argument' || p.exposeValue === false) continue;
    const flag = longFlag(p);
    let value;
    switch (p.name) {
      case 'front_dir_path': value = d.front; break;
      case 'back_dir_path': value = d.back; break;
      case 'double_sided_dir_path': value = d.double_sided; break;
      case 'output_path': value = outputPath; break;
      case 'skip': value = skip; break;
      case 'label': value = partLabel(o.label, x.part); break;
      case 'load_offset': value = o.load_offset === true && !onlyFronts; break;
      default: value = o[p.name];
    }
    if (p.isFlag || p.type === 'bool') {
      if (value === true) argv.push(flag);
      continue;
    }
    if (p.multiple) {
      for (const v of Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]) {
        if (v !== null && v !== undefined && v !== '') argv.push(`${flag}=${v}`);
      }
      continue;
    }
    if ((value === null || value === undefined || value === '') && ALWAYS_EMITTED.has(p.name)) value = p.default;
    if (value === null || value === undefined || value === '') continue;
    argv.push(`${flag}=${value}`);
  }
  return argv;
}

/**
 * The equivalent command line for display (`python create_pdf.py --name=value …`), quoted for copy/paste.
 * Same arguments as buildCreatePdfArgv.
 * @param {Array<object>|{params: Array<object>}} spec
 * @param {object} options
 * @param {{ front: string, back: string, double_sided: string }} dirs
 * @param {string} outputPath
 * @param {object} [extra]
 * @returns {string}
 */
function buildDisplayCommand(spec, options, dirs, outputPath, extra = {}) {
  const argv = buildCreatePdfArgv(spec, options, dirs, outputPath, extra);
  return ['python', ...argv].map((a) => util.quoteForDisplay(a)).join(' ');
}

// ---------------------------------------------------------------------------------------------
// Offset file (read here to avoid a hard dependency on offset.js)
// ---------------------------------------------------------------------------------------------

async function readOffsetSafe(deps) {
  try {
    const offset = lazyService('offset');
    if (offset && typeof offset.readOffset === 'function') return await offset.readOffset(deps);
  } catch {
    /* fall back below */
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Back resolution (cards.resolveBack when available, else spec §9.5 rules)
// ---------------------------------------------------------------------------------------------

function resolveBackFromScan(settings, backImages, backDir) {
  const back = isObj(settings.cards) && isObj(settings.cards.back) ? settings.cards.back : {};
  const mode = back.mode === 'file' || back.mode === 'none' ? back.mode : 'auto';
  if (mode === 'none') return { mode, file: null, abs: null, problem: null };
  if (mode === 'file') {
    const file = typeof back.file === 'string' && back.file ? util.toPosix(back.file) : null;
    const hit = file ? backImages.find((img) => img.rel === file) : null;
    if (hit) return { mode, file: hit.rel, abs: hit.abs, problem: null };
    let abs = null;
    if (file) {
      try {
        abs = util.resolveInside(backDir, file);
      } catch {
        abs = null;
      }
    }
    return { mode, file, abs: null, problem: 'missing', missingAbs: abs };
  }
  if (backImages.length === 1) return { mode, file: backImages[0].rel, abs: backImages[0].abs, problem: null };
  if (backImages.length === 0) return { mode, file: null, abs: null, problem: null };
  return { mode, file: null, abs: null, problem: 'choose' };
}

async function resolveBack(deps, settings, backImages, backDir) {
  try {
    const cards = service(deps, 'cards');
    if (cards && typeof cards.resolveBack === 'function') {
      const r = await cards.resolveBack(deps);
      if (isObj(r)) {
        let file = typeof r.file === 'string' && r.file ? util.toPosix(r.file) : null;
        let abs = typeof r.abs === 'string' && r.abs ? r.abs : null;
        if (!abs && file && !r.problem) {
          const hit = backImages.find((img) => img.rel === file);
          abs = hit ? hit.abs : null;
        }
        const problem = r.problem === 'choose' || r.problem === 'missing' ? r.problem : (file && !abs ? 'missing' : null);
        if (problem === 'missing' && !file && typeof r.configuredFile === 'string' && r.configuredFile) file = util.toPosix(r.configuredFile);
        return { mode: typeof r.mode === 'string' ? r.mode : 'auto', file, abs: problem ? null : abs, problem };
      }
    }
  } catch (err) {
    logger(deps).warn('[pdf] cards.resolveBack failed; using the built-in rules:', err);
  }
  return resolveBackFromScan(settings, backImages, backDir);
}

// ---------------------------------------------------------------------------------------------
// Recommended settings for the last downloaded game (catalog.js, shared with the renderer)
// ---------------------------------------------------------------------------------------------

let catalogPromise = null;

/**
 * The renderer's catalog (pure ES module without imports). Loaded from its source text as a data:
 * URL so it also works from inside app.asar (fs is asar-aware, Node's ESM file loader may not be);
 * falls back to a file: URL import. Resolves null when unavailable (the recommendation is skipped).
 * @returns {Promise<object|null>}
 */
function loadCatalog() {
  if (!catalogPromise) {
    const file = path.join(__dirname, '..', 'renderer', 'js', 'data', 'catalog.js');
    catalogPromise = (async () => {
      try {
        const source = await fsp.readFile(file, 'utf8');
        return await import(`data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`);
      } catch {
        return import(pathToFileURL(file).href);
      }
    })().catch(() => null);
  }
  return catalogPromise;
}

async function recommendationNotice(settings, opts, layoutInfo, introspection) {
  const last = isObj(settings.fetch) && isObj(settings.fetch.lastFetched) ? settings.fetch.lastFetched : null;
  if (!last || typeof last.plugin !== 'string') return null;
  const catalog = await loadCatalog();
  if (!catalog || typeof catalog.getRecommendedPdf !== 'function') return null;
  let rec;
  let plugin;
  try {
    rec = catalog.getRecommendedPdf(last.plugin, typeof last.format === 'string' ? last.format : null) || {};
    plugin = typeof catalog.getPlugin === 'function' ? catalog.getPlugin(last.plugin) : null;
  } catch {
    return null;
  }
  const changes = {};
  const phrases = [];
  const cardSizes = introspection && introspection.layouts && Array.isArray(introspection.layouts.cardSizes) ? introspection.layouts.cardSizes : [];
  for (const [key, value] of Object.entries(rec)) {
    if (!PDF_OPTION_KEYS.includes(key)) continue;
    if (key === 'card_size') {
      if (opts.specialty || typeof value !== 'string') continue;
      const wanted = resolveSizeName(value, cardSizes, introspection.layouts.aliases && introspection.layouts.aliases.card) || value;
      if (wanted === layoutInfo.cardSize) continue;
      const def = cardSizes.find((c) => c.name === wanted);
      const dims = def && Number.isFinite(def.widthMm) ? ` (${def.widthMm} x ${def.heightMm} mm)` : '';
      phrases.push(`use ${titleCase(wanted)} size${dims}`);
      changes.card_size = wanted;
      continue;
    }
    const current = opts[key] === undefined ? null : opts[key];
    const norm = (v) => (v === null || v === undefined || v === '' ? null : String(v).toLowerCase());
    if (norm(current) === norm(value)) continue;
    if (key === 'crop') phrases.push(value ? `trim ${value} from the image edges` : 'don\'t trim the image edges');
    else phrases.push(`set "${OPTION_LABELS[key] || key}" to ${value === null ? 'off' : value}`);
    changes[key] = value;
  }
  if (!phrases.length) return null;
  const name = plugin && plugin.name ? plugin.name : last.plugin;
  return {
    code: 'RECOMMENDED_SETTINGS',
    message: `Your cards come from ${name}: ${phrases.join(' and ')}?`,
    action: { type: 'applyRecommended', options: changes },
  };
}

// ---------------------------------------------------------------------------------------------
// Upscale estimate (upscayl.js, written separately — every call is guarded)
// ---------------------------------------------------------------------------------------------

async function listUpscaledFiles(upscaledRoot) {
  const set = new Set();
  try {
    const res = await scan.scanDir(upscaledRoot, { sizes: false, hash: false });
    for (const img of res.images) if (!img.rel.startsWith('.staging/')) set.add(img.rel);
  } catch {
    /* none */
  }
  return set;
}

function countBy(list, pred) {
  let n = 0;
  for (const x of list) if (pred(x)) n += 1;
  return n;
}

/**
 * Turn what upscayl.planUpscale returned into { needed, unique, cached, sharp, secEst, bytesEst }.
 * Uses `counts` / `secEst` / `bytesEst` (upscayl.js) and falls back to per-item lists (`items[]`
 * with `action` 'sharp' | 'cached' | 'upscale' | 'skipped', `unique` groups with a `scale`).
 * @param {object} res planUpscale result
 * @param {number} itemCount items given to planUpscale
 * @param {number} secPerImage seconds per Upscayl run (settings.upscayl.secPerImage)
 * @returns {{ needed: number, unique: number, cached: number, sharp: number, skipped: number, secEst: number, bytesEst: number }}
 */
function summarizeUpscalePlan(res, itemCount, secPerImage = 3) {
  const r = isObj(res) ? res : {};
  const list = Array.isArray(r.items) ? r.items : [];
  const counts = isObj(r.counts) ? r.counts : {};
  const fromCount = (key, fallback) => (Number.isFinite(counts[key]) ? counts[key] : fallback());
  const sharp = fromCount('sharp', () => (Array.isArray(r.sharp) ? r.sharp.length : countBy(list, (e) => e && e.action === 'sharp')));
  const cached = fromCount('cached', () => (Array.isArray(r.cached) ? r.cached.length : countBy(list, (e) => e && e.action === 'cached')));
  const skipped = fromCount('skipped', () => (Array.isArray(r.skipped) ? r.skipped.length : countBy(list, (e) => e && e.action === 'skipped')));
  const needed = fromCount('upscale', () => (Array.isArray(r.toUpscale) ? r.toUpscale.length
    : list.length ? countBy(list, (e) => e && e.action === 'upscale') : Math.max(0, itemCount - sharp - cached - skipped)));
  const groups = Array.isArray(r.unique) ? r.unique : null;
  const unique = fromCount('unique', () => (groups ? groups.length : needed));
  const secEst = Number.isFinite(r.secEst) ? r.secEst : Math.round(unique * secPerImage);
  let bytesEst = Number.isFinite(r.bytesEst) ? r.bytesEst : null;
  if (bytesEst === null) {
    const scales = (groups || []).map((g) => (g && Number.isFinite(g.scale) ? g.scale : 4));
    while (scales.length < unique) scales.push(4);
    bytesEst = Math.round(scales.reduce((sum, s) => sum + UPSCALE_BYTES_PER_IMAGE_4X * (s / 4) ** 2, 0));
  }
  return { needed, unique, cached, sharp, skipped, secEst, bytesEst };
}

/**
 * Is Upscayl usable? (upscayl.getUpscaylStatus is cached by upscayl.js.)
 * @param {object} deps
 * @returns {Promise<{ upscayl: object|null, status: object|null, reason: string|null }>}
 */
async function upscaylAvailability(deps) {
  const upscayl = service(deps, 'upscayl');
  if (!upscayl || typeof upscayl.getUpscaylStatus !== 'function') {
    return { upscayl: null, status: null, reason: 'Upscaling is not available in this version of the app.' };
  }
  try {
    const status = await upscayl.getUpscaylStatus(deps, { refresh: false });
    if (!status || !status.found) return { upscayl, status: status || null, reason: 'Upscayl is not installed.' };
    return { upscayl, status, reason: null };
  } catch (err) {
    return { upscayl, status: null, reason: `Upscayl could not be checked: ${err && err.message ? err.message : err}` };
  }
}

async function planUpscaleInfo(deps, ctx) {
  const { settings, paths, opts, extra, layout, scans, back, useDs } = ctx;
  const upscaylSettings = isObj(settings.upscayl) ? settings.upscayl : {};
  const base = { enabled: true, available: false, needed: 0, cached: 0, sharp: 0, secEst: 0, bytesEst: 0 };
  if (!extra.upscale) return null;
  const availability = ctx.availability || await upscaylAvailability(deps);
  if (availability.reason) return { ...base, reason: availability.reason };
  const { upscayl, status } = availability;
  const targets = isObj(upscaylSettings.targets) ? upscaylSettings.targets : { front: true, back: true, double_sided: true };
  const items = [];
  const push = (kind, img) => items.push({
    kind, rel: img.rel, relNoExt: img.relNoExt, abs: img.abs, hash: img.hash, type: img.type,
    width: img.width, height: img.height, size: img.size, mtimeMs: img.mtimeMs,
  });
  if (targets.front !== false) for (const img of scans.front.images) push('front', img);
  if (targets.double_sided !== false && useDs) for (const img of scans.ds.images) push('double_sided', img);
  if (targets.back !== false && !opts.only_fronts && back.abs) {
    const img = scans.back.images.find((i) => i.rel === back.file);
    if (img) push('back', img);
  }
  const cardWidthIn = layout && Number.isFinite(layout.cardWidthMm) ? layout.cardWidthMm / 25.4 : 2.5;
  const secPerImage = Number.isFinite(upscaylSettings.secPerImage) && upscaylSettings.secPerImage > 0 ? upscaylSettings.secPerImage : 3;
  if (!items.length) return { ...base, available: true, unique: 0 };
  let summary;
  try {
    if (typeof upscayl.planUpscale !== 'function') throw new Error('planUpscale is missing');
    const manifest = typeof upscayl.loadManifest === 'function' ? await upscayl.loadManifest(deps) : null;
    const existingFiles = await listUpscaledFiles(paths.upscaledRoot);
    const res = await upscayl.planUpscale({
      items,
      settings: upscaylSettings,
      targetPpi: opts.ppi,
      cardWidthIn,
      manifest,
      existingFiles,
      status,
      kinds: [...new Set(items.map((i) => i.kind))],
    });
    summary = summarizeUpscalePlan(res, items.length, secPerImage);
  } catch (err) {
    logger(deps).warn('[pdf] upscale estimate failed; using a simple estimate:', err);
    const maxScale = [2, 3, 4].includes(upscaylSettings.scale) ? upscaylSettings.scale : 4;
    const needing = items.filter((i) => !Number.isFinite(i.width) || i.width / cardWidthIn < opts.ppi);
    summary = {
      needed: needing.length,
      unique: needing.length,
      cached: 0,
      sharp: items.length - needing.length,
      skipped: 0,
      secEst: Math.round(needing.length * secPerImage),
      bytesEst: Math.round(needing.length * UPSCALE_BYTES_PER_IMAGE_4X * (maxScale / 4) ** 2),
    };
  }
  return {
    enabled: true,
    available: true,
    needed: summary.needed,
    unique: summary.unique,
    cached: summary.cached,
    sharp: summary.sharp,
    secEst: summary.secEst,
    bytesEst: summary.bytesEst,
  };
}

// ---------------------------------------------------------------------------------------------
// planPdf
// ---------------------------------------------------------------------------------------------

function emptyPlan() {
  return {
    ok: false,
    errors: [],
    warnings: [],
    notices: [],
    layout: null,
    layoutKey: null,
    cardSize: null,
    paperSize: null,
    skip: [],
    cards: { fronts: 0, uniqueBacks: 0, faces: 0, total: 0, singles: 0, pairs: 0 },
    perPage: 0,
    effectivePerSheet: 0,
    sheets: 0,
    pdfPages: 0,
    lastSheetEmpty: 0,
    cardsOnLastSheet: 0,
    onlyFronts: true,
    ppi: null,
    back: { mode: 'auto', file: null },
    output: { dir: null, fileName: null, stem: null, path: null, exists: false, existingMtime: null, isImages: false },
    template: { name: null, file: null },
    resources: {
      pageBytes: 0, peakBytes: 0, budgetBytes: 0, totalMemBytes: 0, chunks: 0, sheetsPerChunk: 0,
      pdfBytesEst: 0, freeDiskBytes: null, durationSecEst: null, pageWidthPx: 0, pageHeightPx: 0, memoryFraction: 0,
    },
    upscale: null,
    display: '',
    displayEquivalent: false,
    displayNote: null,
    displayCwd: null,
    requires: { ackNoTemplate: false, ignoreMemoryLimit: false },
    options: null,
  };
}

function totalMemoryOf(deps) {
  const seam = deps && deps.totalMemBytes;
  const v = typeof seam === 'function' ? seam() : seam;
  return Number.isFinite(v) && v > 0 ? v : os.totalmem();
}

async function freeDiskOf(deps, dir) {
  const seam = deps && deps.freeDiskBytes;
  if (typeof seam === 'function') {
    try {
      const v = await seam(dir);
      return Number.isFinite(v) ? v : null;
    } catch {
      return null;
    }
  }
  return util.freeDiskBytes(dir);
}

function cardDirsRel(paths, kind) {
  return util.toPosix(path.relative(paths.workspaceDir, paths.gameDir(kind))) || `game/${kind}`;
}

async function outputInfo(outputDir, stem, isImages) {
  if (isImages) {
    const folder = path.join(outputDir, stem);
    const st = await statSafe(folder);
    let pages = 0;
    let newest = null;
    if (st && st.isDirectory()) {
      try {
        for (const name of await fsp.readdir(folder)) {
          if (!PAGE_FILE_RE.test(name)) continue;
          pages += 1;
          const pst = await statSafe(path.join(folder, name));
          if (pst && (newest === null || pst.mtimeMs > newest)) newest = pst.mtimeMs;
        }
      } catch {
        /* unreadable */
      }
    }
    return {
      dir: outputDir, fileName: stem, stem, path: folder, exists: pages > 0, existingMtime: newest,
      isImages: true, existingPages: pages, isFolder: !!(st && st.isDirectory()), blockedByFile: !!(st && !st.isDirectory()),
    };
  }
  const file = path.join(outputDir, `${stem}.pdf`);
  const st = await statSafe(file);
  return {
    dir: outputDir, fileName: `${stem}.pdf`, stem, path: file, exists: !!st, existingMtime: st ? st.mtimeMs : null,
    isImages: false, existingPages: 0, isFolder: !!(st && st.isDirectory()), blockedByFile: false,
  };
}

function nextFreeName(outputDir, stem, isImages) {
  const target = util.uniqueStemPath(outputDir, stem, isImages ? '' : '.pdf');
  return path.basename(target);
}

/**
 * Plan a PDF (spec §9.8). No side effects. Never rejects for user-facing problems: they are returned
 * in `errors` (blocking, with an optional `fix`), `warnings` and `notices` (with an optional `action`).
 *
 * @param {object} deps app deps (getPaths, settings, helper, hashCache?, logger?; test seams:
 *   totalMemBytes, freeDiskBytes)
 * @param {object} [options] settings.pdf.options keys (override the saved ones) + { upscale, fileName,
 *   outputDir, ackNoTemplate, ignoreMemoryLimit, printBackFaces }
 * @returns {Promise<object>} PdfPlan
 */
async function planPdf(deps, options = {}) {
  const { plan } = await planInternal(deps, options);
  return plan;
}

async function planInternal(deps, options = {}) {
  const plan = emptyPlan();
  const internal = {};
  const settings = settingsOf(deps);
  const paths = deps.getPaths();
  const { opts, extra } = normalizeOptions(settings, options);
  const error = (code, message, fix) => plan.errors.push(fix ? { code, message, fix } : { code, message });
  const warning = (code, message, action) => plan.warnings.push(action ? { code, message, action } : { code, message });
  const notice = (code, message, action) => plan.notices.push(action ? { code, message, action } : { code, message });
  const finalize = () => {
    plan.ok = plan.errors.length === 0;
    plan.options = { ...opts, ...extra };
    return { plan, internal };
  };

  plan.onlyFronts = opts.only_fronts;
  plan.ppi = Number.isFinite(opts.ppi) ? opts.ppi : null;
  plan.displayCwd = paths.workspaceDir;
  internal.opts = opts;
  internal.extra = extra;
  internal.paths = paths;
  internal.settings = settings;

  // ---- introspection (layouts + create_pdf ParamSpecs) ----
  let introspection;
  try {
    if (!deps.helper || typeof deps.helper.introspect !== 'function') throw userError('Part of the app is missing (helper).', { code: 'SERVICE_UNAVAILABLE' });
    introspection = await deps.helper.introspect({});
  } catch (err) {
    const msg = err && err.message ? String(err.message) : '';
    if ((err && err.code === 'NOT_READY') || /^NOT_READY/.test(msg)) {
      error('NOT_READY', 'The card maker components aren\'t ready yet. Finish the setup first.');
    } else if (err && (err.code === 'PYTHON_SETUP' || err.pythonBusy)) {
      error('NOT_READY', 'The card maker components are being set up. Wait until that finishes.');
    } else {
      const reason = msg.replace(/^Something went wrong:\s*/i, '').replace(/[.…\s]+$/, '') || 'unknown problem';
      error('INTROSPECTION_FAILED', `The card maker could not describe its options: ${reason}.`);
    }
    return finalize();
  }
  internal.introspection = introspection;
  const createPdfSpec = introspection.commands && introspection.commands.create_pdf ? introspection.commands.create_pdf.params : null;
  internal.spec = createPdfSpec;

  // ---- 1. layout ----
  const layoutInfo = resolveLayout(introspection, opts);
  for (const e of layoutInfo.errors) error(e.code, e.message);
  const layout = layoutInfo.layout;
  plan.layout = layout;
  plan.layoutKey = layoutInfo.layoutKey;
  plan.cardSize = layoutInfo.cardSize;
  plan.paperSize = layoutInfo.paperSize;
  internal.layoutInfo = layoutInfo;
  const perPage = layout && Number.isInteger(layout.cardsPerPage) ? layout.cardsPerPage
    : layout && Array.isArray(layout.xPos) && Array.isArray(layout.yPos) ? layout.xPos.length * layout.yPos.length : 0;
  plan.perPage = perPage;

  // ---- 4 (early). option validation ----
  const cardW = layout ? layout.cardWidthPx : 744;
  const cardH = layout ? layout.cardHeightPx : 1039;
  const lengths = {};
  for (const [key, kind] of Object.entries(LENGTH_OPTIONS)) {
    const parsed = parseLength(opts[key], kind);
    if (!parsed.ok) {
      error('INVALID_LENGTH', lengthErrorMessage(key, kind, parsed.reason));
      lengths[key] = null;
      continue;
    }
    lengths[key] = parsed;
    opts[key] = parsed.value;
  }
  for (const key of ['crop', 'crop_backs']) {
    const parsed = lengths[key];
    if (!parsed || parsed.value === null) continue;
    const [px, py] = cropPercent(parsed, cardW, cardH);
    const worst = Math.max(px, py);
    if (worst >= 100) error('CROP_TOO_LARGE', `"${OPTION_LABELS[key]}" would remove the whole picture. Use a smaller value.`);
    else if (worst > CROP_WARNING_PERCENT) warning('CROP_LARGE', `"${OPTION_LABELS[key]}" removes about ${Math.round(worst)}% of each picture.`);
  }
  for (const key of ['extend_edges', 'extend_edges_backs']) {
    const parsed = lengths[key];
    if (!parsed || parsed.value === null) continue;
    if (2 * lengthToPx300(parsed) >= Math.min(cardW, cardH)) {
      error('EXTEND_TOO_LARGE', `"${OPTION_LABELS[key]}" is bigger than half of the card. Use a much smaller value (for example 0.5mm).`);
    }
  }
  if (!Number.isInteger(opts.ppi) || opts.ppi < MIN_PPI || opts.ppi > MAX_PPI) {
    error('INVALID_PPI', `Print resolution must be a whole number from ${MIN_PPI} to ${MAX_PPI}.`);
  } else if (opts.ppi < LOW_PPI_WARNING) {
    warning('LOW_PPI', `A print resolution below ${LOW_PPI_WARNING} PPI prints blurry cards.`);
  }
  if (!Number.isInteger(opts.quality) || opts.quality < 0 || opts.quality > 100) {
    error('INVALID_QUALITY', 'JPEG quality must be a whole number from 0 to 100.');
  } else if (opts.quality < LOW_QUALITY_WARNING) {
    warning('LOW_QUALITY', 'A JPEG quality below 50 adds visible blotches to the pictures.');
  }
  if (opts.registration !== '3' && opts.registration !== '4') error('INVALID_REGISTRATION', 'Registration marks must be 3 or 4 corners.');
  if (opts.registration_orientation !== null && !['portrait', 'landscape'].includes(opts.registration_orientation)) {
    error('INVALID_CHOICE', 'The registration mark orientation must be portrait or landscape.');
  }
  if (!['stretch', 'crop'].includes(opts.fit)) error('INVALID_CHOICE', 'Image shape must be Stretch or Crop.');
  if (opts.fit_backs !== null && !['stretch', 'crop'].includes(opts.fit_backs)) error('INVALID_CHOICE', 'Image shape (backs) must be Stretch or Crop.');
  if (opts.label && [...opts.label].length > MAX_LABEL_CHARS) {
    warning('LABEL_LONG', `The text printed on each sheet is long (more than ${MAX_LABEL_CHARS} characters) and may run into the corner marks.`);
  }
  if (opts.show_outline) warning('SHOW_OUTLINE', 'Cut lines will be printed on your cards ("Show cut lines" is on).');

  // equipment
  const machine = isObj(settings.equipment) && typeof settings.equipment.machine === 'string' ? settings.equipment.machine : null;
  if (machine && MACHINE_REGISTRATION[machine] && (opts.registration === '3' || opts.registration === '4')
    && !MACHINE_REGISTRATION[machine].includes(opts.registration)) {
    warning('REGISTRATION_MACHINE', machine === 'other'
      ? '4-corner marks only work on the Cameo 5 Alpha. Use 3-corner marks unless you have one.'
      : `4-corner marks only work on the Cameo 5 Alpha. Your ${MACHINE_LABELS[machine]} needs 3-corner marks.`);
  }
  if (layout && opts.registration_orientation && layout.registrationOrientation && opts.registration_orientation !== layout.registrationOrientation) {
    warning('REGISTRATION_ORIENTATION', 'The registration marks are turned compared to the cutting template: turn the page orientation in Silhouette Studio to match.');
  }
  if (machine === 'portrait' && layoutInfo.paperSize && !PORTRAIT_PAPERS.has(layoutInfo.paperSize)) {
    warning('PAPER_MACHINE', 'The Portrait only cuts sheets up to Letter or A4 size.');
  }

  // ---- 2. cards ----
  const useDsKinds = !opts.only_fronts || extra.printBackFaces;
  // upscale planning needs content hashes; skip hashing when Upscayl can't run anyway
  const availability = extra.upscale ? await upscaylAvailability(deps) : null;
  internal.availability = availability;
  const wantHash = !!(availability && !availability.reason);
  let scans;
  try {
    const scanOpts = { hash: wantHash, hashCache: deps.hashCache || undefined };
    const [front, ds, back] = await Promise.all([
      scan.scanDir(paths.gameDir('front'), scanOpts),
      scan.scanDir(paths.gameDir('double_sided'), scanOpts),
      scan.scanDir(paths.gameDir('back'), scanOpts),
    ]);
    scans = { front, ds, back };
  } catch (err) {
    error('SCAN_FAILED', `Your card folders could not be read: ${err && err.message ? err.message : err}`);
    return finalize();
  }
  internal.scans = scans;
  for (const [label, res] of [['fronts', scans.front], ['unique backs', scans.ds], ['common backs', scans.back]]) {
    if (res.truncated) warning('SCAN_TRUNCATED', `Your ${label} folder has too many files: only the first ${res.images.length + res.others.length} were checked.`);
  }
  const fronts = scans.front.images;
  const dsImages = scans.ds.images;
  const frontByRelNoExt = new Map(fronts.map((img) => [img.relNoExt, img]));
  const dsByRelNoExt = new Map(dsImages.map((img) => [img.relNoExt, img]));
  const pairs = fronts.filter((img) => dsByRelNoExt.has(img.relNoExt));
  const singles = opts.only_fronts ? fronts.length : fronts.length - pairs.length;
  const faces = opts.only_fronts && extra.printBackFaces ? dsImages.length : 0;
  const total = opts.only_fronts ? fronts.length + faces : fronts.length;
  plan.cards = {
    fronts: fronts.length, uniqueBacks: dsImages.length, faces, total, singles, pairs: opts.only_fronts ? 0 : pairs.length,
  };
  internal.useDs = useDsKinds && dsImages.length > 0;

  if (fronts.length === 0) error('NO_FRONTS', 'There are no card fronts yet. Add some cards first.', { type: 'openCards', tab: 'front' });
  const frontCollisions = findStemCollisions(fronts);
  if (frontCollisions.length) error('STEM_COLLISION', collisionMessage(frontCollisions, 'card fronts'), { type: 'fixCollisions', kind: 'front' });
  if (internal.useDs) {
    const dsCollisions = findStemCollisions(dsImages);
    if (dsCollisions.length) error('STEM_COLLISION', collisionMessage(dsCollisions, 'unique backs'), { type: 'fixCollisions', kind: 'double_sided' });
  }
  if (!opts.only_fronts) {
    const orphans = dsImages.filter((img) => !frontByRelNoExt.has(img.relNoExt));
    if (orphans.length) {
      error('DS_WITHOUT_FRONT', `${orphans.length === 1 ? 'A unique back has' : `${orphans.length} unique backs have`} no front with the same name: ${listNames(orphans.map((o) => o.rel))}.`,
        { type: 'openCards', tab: 'double_sided' });
    }
  } else if (dsImages.length) {
    if (extra.printBackFaces) notice('BACK_FACES', `The ${plural(dsImages.length, 'back face')} of your double-faced cards will be printed as extra cards.`);
    else notice('DS_IGNORED', `Your ${plural(dsImages.length, 'unique back')} won't be printed with "Fronts only".`);
  }
  const otherCount = scans.front.others.length + (internal.useDs ? scans.ds.others.length : 0);
  if (otherCount) warning('UNSUPPORTED_FILES', `${plural(otherCount, 'file')} in your card folders ${otherCount === 1 ? 'isn\'t a picture the card maker can read and is' : 'aren\'t pictures the card maker can read and are'} skipped.`);

  // ---- 3. back ----
  const back = await resolveBack(deps, settings, scans.back.images, paths.gameDir('back'));
  internal.back = back;
  plan.back = { mode: back.mode, file: back.file || null };
  if (!opts.only_fronts && singles > 0) {
    if (back.problem === 'choose') {
      error('BACK_CHOOSE', 'You have several common back images. Choose the one to print.', { type: 'chooseBack' });
    } else if (back.problem === 'missing') {
      error('BACK_MISSING', `The chosen back image${back.file ? ` "${back.file.split('/').pop()}"` : ''} is missing. Choose another back.`, { type: 'chooseBack' });
    } else if (!back.abs) {
      notice('NO_BACK', 'The back of single-sided cards will be blank white.');
    }
  }

  // ---- 4 (rest). printer alignment ----
  const offset = await readOffsetSafe(deps);
  internal.offset = offset;
  const offsetNonZero = !!(offset && offset.valid && (Number(offset.x_offset) || Number(offset.y_offset) || Number(offset.angle_offset)));
  if (opts.load_offset && opts.only_fronts) {
    notice('LOAD_OFFSET_FRONTS_ONLY', 'Printer alignment is only used for two-sided PDFs, so it is ignored with "Fronts only".');
  } else if (opts.load_offset && !opts.only_fronts) {
    if (!offset) {
      error('OFFSET_MISSING', 'No printer alignment is saved yet. Do the Printer alignment first, use 0, 0, 0 for now, or turn off "Apply my printer alignment".', { type: 'resetOffset' });
      notice('OFFSET_SETUP', 'Set up your printer alignment once for two-sided printing.', { type: 'openAlignment' });
    } else if (!offset.valid) {
      error('OFFSET_INVALID', 'Your saved printer alignment is damaged. Reset it to 0, 0, 0 (and redo the alignment), or turn off "Apply my printer alignment".', { type: 'resetOffset' });
    }
  } else if (!opts.load_offset && !opts.only_fronts && offsetNonZero) {
    notice('OFFSET_NOT_APPLIED', 'Your printer alignment is saved but not applied to this PDF.', { type: 'setLoadOffset', value: true });
  }
  const loadOffsetEffective = opts.load_offset && !opts.only_fronts;

  // ---- 5. skip ----
  const skipMap = isObj(settings.pdf) && isObj(settings.pdf.skipByLayout) ? settings.pdf.skipByLayout : {};
  const rawSkip = plan.layoutKey && Array.isArray(skipMap[plan.layoutKey]) ? skipMap[plan.layoutKey] : [];
  const cleanSkip = [];
  let ignoredSkip = 0;
  for (const v of rawSkip) {
    const n = typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v) : v;
    if (!Number.isInteger(n) || n < 0) continue;
    if (perPage && n >= perPage) {
      ignoredSkip += 1;
      continue;
    }
    if (!cleanSkip.includes(n)) cleanSkip.push(n);
  }
  cleanSkip.sort((a, b) => a - b);
  plan.skip = cleanSkip;
  if (ignoredSkip) warning('SKIP_IGNORED', `${plural(ignoredSkip, '"Leave slot empty" choice')} ${ignoredSkip === 1 ? 'doesn\'t' : 'don\'t'} exist on this layout and ${ignoredSkip === 1 ? 'is' : 'are'} ignored.`);
  if (perPage && cleanSkip.length >= perPage) error('SKIP_ALL', 'You can\'t leave every slot empty. Clear at least one "Leave slot empty" choice.');

  // ---- 6. sheets ----
  const effectivePerSheet = Math.max(0, perPage - cleanSkip.length);
  const pagesPerSheet = opts.only_fronts ? 1 : 2;
  const sheets = effectivePerSheet > 0 && total > 0 ? Math.ceil(total / effectivePerSheet) : 0;
  plan.effectivePerSheet = effectivePerSheet;
  plan.sheets = sheets;
  plan.pdfPages = sheets * pagesPerSheet;
  plan.lastSheetEmpty = sheets ? sheets * effectivePerSheet - total : 0;
  plan.cardsOnLastSheet = sheets ? total - (sheets - 1) * effectivePerSheet : 0;

  // ---- 7. template ----
  if (layout) {
    let file = typeof layout.templateFile === 'string' && layout.templateFile ? layout.templateFile : null;
    if (file && !(await statSafe(file))) file = null;
    plan.template = { name: layout.template || null, file };
    plan.requires.ackNoTemplate = !file;
    if (!file) {
      if (extra.ackNoTemplate) {
        warning('NO_TEMPLATE', 'There is no ready-made cutting template for this layout: you need your own.');
      } else {
        error('NO_TEMPLATE', `There is no ready-made cutting template for this layout${layout.template ? ` (${layout.template})` : ''}. Confirm that you have your own cutting template to continue.`, { type: 'ackNoTemplate' });
      }
    }
  }

  // ---- 10 (needed for disk). output ----
  const outputDir = extra.outputDir || paths.outputDir;
  let outputOk = true;
  if (!path.isAbsolute(outputDir)) {
    error('OUTPUT_DIR_INVALID', 'Choose a complete output folder (for example C:\\Users\\you\\Documents\\Cards).');
    outputOk = false;
  } else {
    const cardDirs = ['front', 'back', 'double_sided'].map((k) => paths.gameDir(k));
    if (cardDirs.some((d) => util.isInside(d, outputDir)) || util.isInside(paths.upscaledRoot, outputDir) || util.isInside(paths.stageRoot, outputDir)) {
      error('OUTPUT_IN_CARDS', 'The output folder is inside your card folders: the pages would be read as cards next time. Choose another output folder.');
      outputOk = false;
    }
  }
  const lastDeck = isObj(settings.fetch) && isObj(settings.fetch.lastFetched) ? settings.fetch.lastFetched.deckName : null;
  const rawName = extra.fileName || (typeof lastDeck === 'string' ? lastDeck : '') || 'proxies';
  const stem = util.sanitizeFileName(String(rawName).replace(/\.pdf$/i, ''), { maxLen: 100, fallback: '' }) || 'proxies';
  if (outputOk && opts.output_images) {
    // page images go into <outputDir>/<stem>: that folder must not be a card folder either (e.g. game/ + "front")
    const folder = path.join(outputDir, stem);
    const cardDirs = ['front', 'back', 'double_sided'].map((k) => paths.gameDir(k));
    if (cardDirs.some((d) => util.isInside(d, folder)) || util.isInside(paths.upscaledRoot, folder) || util.isInside(paths.stageRoot, folder)) {
      error('OUTPUT_IN_CARDS', `The page images would be saved in one of your card folders ("${stem}"): they would be read as cards next time. Choose another name or output folder.`);
      outputOk = false;
    }
  }
  if (outputOk) {
    const out = await outputInfo(outputDir, stem, opts.output_images);
    plan.output = {
      dir: out.dir, fileName: out.fileName, stem, path: out.path, exists: out.exists, existingMtime: out.existingMtime, isImages: out.isImages,
    };
    internal.output = out;
    if (opts.output_images) {
      if (out.blockedByFile) {
        error('OUTPUT_IS_FILE', `A file named "${stem}" is in the output folder. Choose another name for the page images.`);
      } else if (out.exists) {
        notice('WILL_REPLACE', `Will replace the ${plural(out.existingPages, 'page image')} in the folder "${stem}" (made ${formatDate(out.existingMtime)}).`,
          { type: 'keepBoth', fileName: nextFreeName(outputDir, stem, true) });
      }
    } else if (out.exists) {
      if (out.isFolder) error('OUTPUT_IS_FOLDER', `A folder named "${stem}.pdf" is in the output folder. Choose another file name.`);
      else notice('WILL_REPLACE', `Will replace ${stem}.pdf (made ${formatDate(out.existingMtime)}).`, { type: 'keepBoth', fileName: nextFreeName(outputDir, stem, false) });
    }
  } else {
    plan.output = { ...plan.output, dir: outputDir, stem, fileName: opts.output_images ? stem : `${stem}.pdf`, isImages: opts.output_images };
  }

  // ---- 9. upscale estimate ----
  try {
    plan.upscale = await planUpscaleInfo(deps, { settings, paths, opts, extra, layout, scans, back, useDs: internal.useDs, availability: internal.availability });
  } catch (err) {
    logger(deps).warn('[pdf] upscale estimate failed:', err);
    plan.upscale = extra.upscale ? { enabled: true, available: false, needed: 0, cached: 0, sharp: 0, secEst: 0, bytesEst: 0, reason: 'The upscale estimate failed.' } : null;
  }
  internal.upscaleRuns = !!(plan.upscale && plan.upscale.enabled && plan.upscale.available);

  // image quality hints (only when no upscaling will run)
  if (layout && Number.isFinite(layout.cardWidthMm) && Number.isFinite(layout.cardHeightMm)) {
    const cardWidthIn = layout.cardWidthMm / 25.4;
    const cardRatio = layout.cardWidthMm / layout.cardHeightMm;
    const printed = [...fronts, ...(internal.useDs ? dsImages : [])];
    if (!internal.upscaleRuns) {
      const lowRes = printed.filter((img) => Number.isFinite(img.width) && img.width / cardWidthIn < LOW_RES_PPI).length;
      if (lowRes) warning('LOW_RESOLUTION', `${plural(lowRes, 'picture')} ${lowRes === 1 ? 'is' : 'are'} low resolution and may print blurry.`, { type: 'openUpscale' });
    }
    if (opts.fit === 'stretch') {
      const stretched = printed.filter((img) => Number.isFinite(img.width) && Number.isFinite(img.height) && img.height > 0
        && Math.abs((img.width / img.height) / cardRatio - 1) > ASPECT_TOLERANCE).length;
      if (stretched) {
        warning('ASPECT_MISMATCH', `${plural(stretched, 'picture')} ${stretched === 1 ? 'has' : 'have'} a different shape than the card and will be stretched. Choose "Image shape: Crop" to keep the proportions.`,
          { type: 'applyRecommended', options: { fit: 'crop' } });
      }
    }
  }

  // ---- 8. resources ----
  if (layout && Number.isInteger(opts.ppi) && opts.ppi >= MIN_PPI && opts.ppi <= MAX_PPI) {
    const totalMem = totalMemoryOf(deps);
    const budgetPercent = isObj(settings.pdf) && Number.isFinite(settings.pdf.memoryBudgetPercent) ? settings.pdf.memoryBudgetPercent : 50;
    const res = computeResources({
      pageWidthPx300: Number.isFinite(layout.pageWidthPx300) ? layout.pageWidthPx300 : layout.paperWidthPx,
      pageHeightPx300: Number.isFinite(layout.pageHeightPx300) ? layout.pageHeightPx300 : layout.paperHeightPx,
      ppi: opts.ppi,
      sheets,
      pagesPerSheet,
      loadOffset: loadOffsetEffective,
      memoryBudgetPercent: budgetPercent,
      totalMemBytes: totalMem,
      isImages: opts.output_images,
    });
    const freeDisk = outputOk ? await freeDiskOf(deps, outputDir) : null;
    const lastPdf = isObj(settings.pdf) && isObj(settings.pdf.lastPdf) ? settings.pdf.lastPdf : null;
    plan.resources = {
      pageBytes: res.pageBytes,
      peakBytes: res.peakBytes,
      budgetBytes: res.budgetBytes,
      totalMemBytes: res.totalMemBytes,
      chunks: res.chunks,
      sheetsPerChunk: res.sheetsPerChunk,
      pdfBytesEst: res.pdfBytesEst,
      freeDiskBytes: freeDisk,
      durationSecEst: estimateDuration({
        secPerCard: isObj(settings.pdf) ? settings.pdf.secPerCard : null,
        lastPpi: lastPdf && Number.isFinite(lastPdf.ppi) ? lastPdf.ppi : null,
        ppi: opts.ppi,
        totalCards: total,
        chunks: res.chunks,
      }),
      pageWidthPx: res.pageWidthPx,
      pageHeightPx: res.pageHeightPx,
      memoryFraction: Math.round(res.memoryFraction * 1000) / 1000,
    };
    internal.resources = res;
    if (res.chunks > 1) notice('CHUNKED', `Will be made in ${res.chunks} parts and joined automatically to save memory.`);
    if (sheets > 0 && res.overLimit) {
      plan.requires.ignoreMemoryLimit = true;
      const lower = suggestLowerPpi({
        pageWidthPx300: layout.pageWidthPx300 || layout.paperWidthPx,
        pageHeightPx300: layout.pageHeightPx300 || layout.paperHeightPx,
        ppi: opts.ppi,
        pagesPerSheet,
        loadOffset: loadOffsetEffective,
        limitBytes: Math.max(res.budgetBytes, 1),
      }) || suggestLowerPpi({
        pageWidthPx300: layout.pageWidthPx300 || layout.paperWidthPx,
        pageHeightPx300: layout.pageHeightPx300 || layout.paperHeightPx,
        ppi: opts.ppi,
        pagesPerSheet,
        loadOffset: loadOffsetEffective,
        limitBytes: MEMORY_ERROR_FRACTION * res.totalMemBytes,
      });
      const need = formatBytes(res.peakBytes);
      if (extra.ignoreMemoryLimit) {
        warning('MEMORY_IGNORED', `Making this PDF needs about ${need} of memory, more than your computer can spare: it may fail or make your computer very slow.`);
      } else {
        error('OUT_OF_MEMORY', `Even one sheet at ${opts.ppi} PPI needs about ${need} of memory, more than your computer can spare.${lower ? ` Choose ${lower} PPI or lower.` : ' Choose a lower print resolution.'}`,
          lower ? { type: 'lowerPpi', ppi: lower } : { type: 'ignoreMemoryLimit' });
      }
    } else if (sheets > 0 && res.highMemory) {
      warning('MEMORY_HIGH', `Making this PDF needs about ${formatBytes(res.peakBytes)} of memory (${Math.round(res.memoryFraction * 100)}% of your computer's memory). Close other programs while it runs.`);
    }
    // disk space
    if (outputOk && Number.isFinite(freeDisk) && sheets > 0) {
      const upscaleBytes = internal.upscaleRuns ? plan.upscale.bytesEst || 0 : 0;
      const pdfNeed = res.pdfBytesEst * (res.chunks > 1 && !opts.output_images ? DISK_MARGIN_CHUNKED : DISK_MARGIN);
      const sameVolume = upscaleBytes > 0 && (await volumeKey(outputDir)) === (await volumeKey(paths.workspaceDir));
      const need = pdfNeed + (sameVolume ? upscaleBytes : 0);
      if (freeDisk < need) {
        error('DISK_FULL', `Not enough free disk space: this needs about ${formatBytes(need)} but only ${formatBytes(freeDisk)} is free. Free some space or choose another output folder.`);
      } else if (upscaleBytes > 0 && !sameVolume) {
        const wsFree = await freeDiskOf(deps, paths.workspaceDir);
        if (Number.isFinite(wsFree) && wsFree < upscaleBytes * DISK_MARGIN) {
          error('DISK_FULL', `Not enough free disk space for the upscaled pictures: they need about ${formatBytes(upscaleBytes)} but only ${formatBytes(wsFree)} is free.`);
        }
      }
    }
  }

  // ---- recommended settings for the last downloaded game ----
  try {
    const rec = await recommendationNotice(settings, opts, layoutInfo, introspection);
    if (rec) notice(rec.code, rec.message, rec.action);
  } catch (err) {
    logger(deps).warn('[pdf] could not read the recommended settings:', err);
  }

  // ---- 11. equivalent command line ----
  if (Array.isArray(createPdfSpec) && createPdfSpec.length) {
    try {
      const display = displayCommand({ paths, opts, extra, plan, layoutInfo, scans, back, internal, createPdfSpec });
      plan.display = display.text;
      plan.displayEquivalent = display.equivalent;
      plan.displayNote = display.note;
    } catch (err) {
      logger(deps).warn('[pdf] could not build the command line:', err);
    }
  }

  // ---- 12 ----
  return finalize();
}

/**
 * The layout and cutting template for the current settings (or `options`), without scanning cards:
 * the part of planPdf that Print & cut needs.
 * @param {object} deps
 * @param {object} [options] same as planPdf
 * @returns {Promise<{ name: string|null, file: string|null, layoutKey: string|null, paperSize: string|null,
 *   cardSize: string|null, layout: object|null, options: object, error: string|null }>}
 */
async function templateForOptions(deps, options = {}) {
  const settings = settingsOf(deps);
  const { opts } = normalizeOptions(settings, options);
  const out = { name: null, file: null, layoutKey: null, paperSize: null, cardSize: null, layout: null, options: opts, error: null };
  let introspection;
  try {
    introspection = await deps.helper.introspect({});
  } catch (err) {
    out.error = /^NOT_READY/.test(String(err && err.message)) || (err && err.code === 'NOT_READY')
      ? 'The card maker components aren\'t ready yet. Finish the setup first.'
      : 'The card maker could not describe its layouts.';
    return out;
  }
  const info = resolveLayout(introspection, opts);
  out.layoutKey = info.layoutKey;
  out.paperSize = info.paperSize;
  out.cardSize = info.cardSize;
  out.layout = info.layout;
  if (info.errors.length) out.error = info.errors[0].message;
  if (info.layout) {
    out.name = info.layout.template || null;
    const file = typeof info.layout.templateFile === 'string' && info.layout.templateFile ? info.layout.templateFile : null;
    out.file = file && (await statSafe(file)) ? file : null;
  }
  return out;
}

/** Canonical create_pdf option values used for the engine (aliases resolved, specialty overrides). */
function engineOptions(opts, layoutInfo) {
  const o = { ...opts };
  if (opts.specialty) {
    o.specialty = layoutInfo.layout ? layoutInfo.layout.name || layoutInfo.layout.specialty || opts.specialty : opts.specialty;
    o.card_size = null;
    o.paper_size = null;
  } else {
    o.card_size = layoutInfo.cardSize || opts.card_size;
    o.paper_size = layoutInfo.paperSize || opts.paper_size;
  }
  return o;
}

function displayCommand({ paths, opts, extra, plan, layoutInfo, scans, back, internal, createPdfSpec }) {
  const reasons = [];
  const dirs = {
    front: cardDirsRel(paths, 'front'),
    back: cardDirsRel(paths, 'back'),
    double_sided: cardDirsRel(paths, 'double_sided'),
  };
  // Upscaled copies (game/upscaled/<kind>) only exist after the run and may be mixed with originals
  // ('sharp' pictures, fallbacks): show the source folders and say so.
  if (internal.upscaleRuns) reasons.push('upscaled copies are used where your pictures need them');
  if (plan.resources.chunks > 1) reasons.push(`the PDF is made in ${plan.resources.chunks} parts and joined`);
  if (opts.only_fronts && scans.ds.images.length) {
    reasons.push(extra.printBackFaces ? 'the back faces are added as extra cards' : 'your unique backs are left out');
  }
  if (!opts.only_fronts) {
    const topLevel = scans.back.images.filter((img) => !img.rel.includes('/'));
    const engineWouldUse = topLevel.length === 1 ? topLevel[0].rel : null;
    if ((back.file || null) !== engineWouldUse || topLevel.length > 1) reasons.push('only your chosen common back is used');
  }
  if (opts.output_images) reasons.push('the page images are collected in their own folder');
  const outputPath = plan.output.path || path.join(paths.outputDir, `${plan.output.stem || 'proxies'}.pdf`);
  const text = buildDisplayCommand(createPdfSpec, engineOptions(opts, layoutInfo), dirs, outputPath, { skip: plan.skip });
  const equivalent = reasons.length === 0;
  const note = equivalent ? null : `The app runs this on a prepared copy of your images (${reasons.join('; ')}).`;
  return { text, equivalent, note };
}

// ---------------------------------------------------------------------------------------------
// startPdfJob
// ---------------------------------------------------------------------------------------------

/**
 * Open the file for writing to detect a lock held by another program (PDF viewer, OneDrive, …).
 * @param {string} file
 * @returns {Promise<string|null>} the error code (EBUSY/EPERM/EACCES) or null
 */
async function lockedCode(file) {
  let fh = null;
  try {
    fh = await fsp.open(file, 'r+');
    return null;
  } catch (err) {
    return err && RETRYABLE_RENAME_CODES.has(err.code) ? err.code : null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

/**
 * Rename with retries on Windows locks; when the destination stays locked, use the next free
 * "<stem> (2)<ext>" name instead.
 * @param {string} src
 * @param {string} dest
 * @param {{ retries?: number, fsImpl?: object, sleep?: (ms: number) => Promise<void> }} [opts]
 * @returns {Promise<{ path: string, fallback: boolean }>}
 */
async function moveIntoPlace(src, dest, { retries = RENAME_RETRIES, fsImpl = fsp, sleep = util.sleep } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fsImpl.rename(src, dest);
      return { path: dest, fallback: false };
    } catch (err) {
      lastErr = err;
      if (!err || !RETRYABLE_RENAME_CODES.has(err.code) || attempt >= retries) break;
      await sleep(Math.min(1000, 100 * (attempt + 1)));
    }
  }
  if (!lastErr || !RETRYABLE_RENAME_CODES.has(lastErr.code)) throw lastErr;
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  const alt = util.uniqueStemPath(path.dirname(dest), stem, ext);
  await fsImpl.rename(src, alt);
  return { path: alt, fallback: true };
}

function stagedName(rel, ext) {
  const noExt = relNoExtOf(rel);
  return ext ? `${noExt}.${ext}` : noExt;
}

function extOfPath(p) {
  return path.extname(p).slice(1);
}

function absInside(root, rel) {
  return path.join(root, ...rel.split('/'));
}

/**
 * Hard-link (fallback: copy) one picture into the stage folder, with a plain-language error when the
 * picture vanished or can't be read.
 * @param {string} src
 * @param {string} dest
 * @param {{ rel: string, kind: string }} source the user's picture (for messages)
 */
async function stageFile(src, dest, source) {
  try {
    await util.copyOrLink(src, dest);
  } catch (err) {
    const where = KIND_PHRASES[source.kind] || 'cards';
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      throw userError(`The picture "${source.rel}" in your ${where} was moved or deleted while the PDF was being prepared. Check your cards and try again.`, { code: 'CARD_MISSING', details: String(err.message), cause: err });
    }
    if (err && ['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
      throw userError(`Windows blocked reading the picture "${source.rel}" in your ${where} (it may be open in another program or blocked by your antivirus). Close it and try again.`, { code: 'FILE_LOCKED', details: String(err.message), cause: err });
    }
    if (err && err.code === 'ENOSPC') {
      throw userError('Your disk is full. Free up some space and try again.', { code: 'DISK_FULL', details: String(err.message), cause: err });
    }
    throw err;
  }
}

/**
 * Staged file (as printed by the engine: relative or absolute, any separators) → the user's own
 * picture. `staged` maps stage-relative POSIX paths ('c0/front/sub/x.png', 'back/b.png') to
 * `{ rel, kind }` (rel inside the card folder of `kind`).
 * @param {Map<string, { rel: string, kind: string }>} staged
 * @param {string} stageRel workspace-relative POSIX stage folder ('game/.stage/<jobId>')
 * @param {string} printed
 * @returns {{ rel: string, kind: string }|null}
 */
function stagedSource(staged, stageRel, printed) {
  const p = util.toPosix(String(printed || ''));
  const marker = `${stageRel}/`;
  const at = p.lastIndexOf(marker);
  if (at < 0) return null;
  return staged.get(p.slice(at + marker.length)) || null;
}

/**
 * Re-word a failed create_pdf run that names a picture: the engine prints the STAGED copy's path,
 * the user needs to know which of THEIR pictures is the problem. Other failures are returned unchanged
 * (jobs.js turns them into plain language).
 * @param {unknown} err rejection of ctx.spawn
 * @param {{ staged: Map<string, { rel: string, kind: string }>, stageRel: string, chunkIndex: number }} where
 * @returns {unknown} the error to throw
 */
function explainRenderFailure(err, { staged, stageRel, chunkIndex }) {
  if (!err || typeof err !== 'object' || err.friendly || err.name !== 'JobProcessError') return err;
  let info;
  try {
    info = friendlyError({ err, kind: 'pdf' });
  } catch {
    return err;
  }
  if (!info || (info.code !== 'BAD_IMAGE' && info.code !== 'FILE_LOCKED')) return err;
  const stderr = Array.isArray(err.stderrTail) ? err.stderrTail : [];
  const stdout = Array.isArray(err.stdoutTail) ? err.stdoutTail : [];
  let source = null;
  const failed = FAILED_IMAGE_RE.exec([...stderr, ...stdout].join('\n'));
  if (failed) source = stagedSource(staged, stageRel, failed[2]);
  if (!source) {
    // the last "Image N: <file>" line names the card being drawn (relative to the staged fronts)
    for (let i = stdout.length - 1; i >= 0 && !source; i -= 1) {
      const m = IMAGE_LINE_RE.exec(String(stdout[i]).trim());
      if (m) source = staged.get(`c${chunkIndex}/front/${util.toPosix(m[2])}`) || null;
    }
  }
  if (!source) return err;
  const where = KIND_PHRASES[source.kind] || 'cards';
  const message = info.code === 'BAD_IMAGE'
    ? `The picture "${source.rel}" in your ${where} is damaged, not an image, or too large. Remove or replace it, then try again.`
    : `Windows blocked reading the picture "${source.rel}" in your ${where} (it may be open in another program or blocked by your antivirus). Close it and try again.`;
  return userError(message, { code: info.code, details: info.details, cause: err });
}

/**
 * Start the 'pdf' job (spec §9.8). Rejects (no job) when the plan has errors, when another job runs,
 * or when the output file is open in another program.
 * @param {object} deps
 * @param {object} [options] same as planPdf
 * @returns {Promise<{ jobId: string }>}
 */
async function startPdfJob(deps, options = {}) {
  if (!deps || !deps.jobs || typeof deps.jobs.start !== 'function') throw userError('Part of the app is missing (jobs).', { code: 'SERVICE_UNAVAILABLE' });
  const active = typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw userError(`BUSY: wait until "${active.title || 'the current task'}" finishes`, { code: 'BUSY' });
  const { plan, internal } = await planInternal(deps, options);
  if (!plan.ok) {
    const first = plan.errors[0];
    throw userError(first ? first.message : 'The PDF can\'t be made with these settings.', { code: first ? first.code : 'PLAN_INVALID' });
  }
  if (!plan.output.isImages && plan.output.exists) {
    const code = await lockedCode(plan.output.path);
    if (code) {
      throw userError(`${plan.output.fileName} is open in another program (probably your PDF viewer). Close it, or use "Keep both".`, { code: 'OUTPUT_LOCKED' });
    }
  }
  const steps = [{ id: 'prepare', label: 'Prepare the cards' }];
  if (internal.upscaleRuns) steps.push({ id: 'upscale', label: 'Upscale pictures' });
  steps.push({ id: 'render', label: plan.resources.chunks > 1 ? `Make the pages (${plan.resources.chunks} parts)` : 'Make the pages' });
  if (plan.resources.chunks > 1 && !plan.output.isImages) steps.push({ id: 'merge', label: 'Join the parts' });
  steps.push({ id: 'finish', label: plan.output.isImages ? 'Save the page images' : 'Save the PDF' });
  const title = plan.output.isImages ? `Making page images "${plan.output.stem}"` : `Making ${plan.output.fileName}`;
  const jobId = deps.jobs.start('pdf', { title, steps }, (ctx) => runPdfJob(ctx, deps, plan, internal));
  return { jobId };
}

async function runPdfJob(ctx, deps, plan, internal) {
  const started = Date.now();
  const { paths, opts, extra, scans, back, layoutInfo, spec } = internal;
  const warnings = [];
  const warn = (msg) => {
    if (!warnings.includes(msg)) warnings.push(msg);
    ctx.warn(msg);
  };
  const stageDir = path.join(paths.stageRoot, ctx.jobId);
  const stageRel = util.toPosix(path.relative(paths.workspaceDir, stageDir));
  const outputDir = plan.output.dir;
  const stem = plan.output.stem;
  const partials = new Set();
  let upscaleSummary = null;
  const chunks = Math.max(1, plan.resources.chunks || 1);
  const perChunk = Math.max(1, plan.resources.sheetsPerChunk || plan.sheets || 1) * Math.max(1, plan.effectivePerSheet);
  const eOpts = engineOptions(opts, layoutInfo);
  const python = paths.pythonPath;

  ctx.log(`Plan: ${plural(plan.cards.total, 'card')} on ${plural(plan.sheets, 'sheet')} (${plural(plan.pdfPages, 'page')}) at ${opts.ppi} PPI, ${plural(chunks, 'part')}.`);
  /** list-images sanity check, run while the pages are made (resolves { listed } or { err }, never rejects). */
  let sanity = null;
  try {
    // ---------------- prepare ----------------
    ctx.step('prepare', 'running');
    if (!(await statSafe(path.join(paths.workspaceDir, 'create_pdf.py')))) {
      throw userError(`The card maker files were not found in ${paths.workspaceDir}. Open Settings and choose Repair components.`, { code: 'ENGINE_MISSING' });
    }
    if (!(await statSafe(python))) {
      throw userError('The card maker components are not installed yet. Open Setup to install them.', { code: 'NOT_INSTALLED' });
    }
    try {
      await fsp.mkdir(outputDir, { recursive: true });
    } catch (err) {
      throw userError(`The output folder "${outputDir}" could not be created. Choose another output folder.`, { code: 'OUTPUT_DIR_FAILED', details: String(err && err.message) });
    }
    ctx.throwIfCancelled();

    // ---------------- upscale ----------------
    let files = null;
    if (internal.upscaleRuns) {
      ctx.step('upscale', 'running');
      const upscayl = service(deps, 'upscayl');
      const targets = isObj(internal.settings.upscayl) && isObj(internal.settings.upscayl.targets) ? internal.settings.upscayl.targets : {};
      const kinds = [];
      if (targets.front !== false) kinds.push('front');
      if (targets.double_sided !== false && internal.useDs) kinds.push('double_sided');
      if (targets.back !== false && !opts.only_fronts && back.abs) kinds.push('back');
      if (!upscayl || typeof upscayl.runUpscale !== 'function') {
        warn('Upscaling is not available: your PDF uses the original pictures.');
        ctx.step('upscale', 'skipped');
      } else if (!kinds.length) {
        ctx.log('Nothing to upscale: every kind of card is switched off in the Upscale settings.');
        ctx.step('upscale', 'skipped');
      } else {
        try {
          // Warnings raised while upscaling also belong in this job's result.
          // (ctx is frozen: define the override as an own property of a derived object.)
          const upCtx = Object.create(ctx, { warn: { value: (m) => warn(String(m)), enumerable: true } });
          const res = await upscayl.runUpscale(upCtx, deps, {
            kinds,
            targetPpi: opts.ppi,
            cardWidthIn: layoutInfo.layout.cardWidthMm / 25.4,
            onlyBackFile: back.file || null,
          });
          upscaleSummary = isObj(res) ? {
            total: res.total, unique: res.unique, upscaled: res.upscaled, cached: res.cached, sharp: res.sharp,
            fallbacks: res.fallbacks, durationMs: res.durationMs,
          } : null;
          files = isObj(res) && isObj(res.files) ? res.files : null;
          ctx.step('upscale', 'done');
          try {
            if (typeof deps.emit === 'function') deps.emit('cards:changed', { reason: 'upscale', jobId: ctx.jobId, kind: 'pdf' });
          } catch { /* ignore */ }
        } catch (err) {
          if (ctx.cancelled || (err && (err.name === 'CancelledError' || err.code === 'CANCELLED'))) throw err;
          logger(deps).warn('[pdf] upscaling failed:', err);
          ctx.log(`Upscaling failed: ${err && err.message ? err.message : err}`, 'warn');
          warn('Upscaling failed, so your PDF uses the original pictures.');
          ctx.step('upscale', 'failed');
        }
      }
      ctx.throwIfCancelled();
    }
    const fileFor = (kind, img) => {
      const map = files && isObj(files[kind]) ? files[kind] : null;
      const chosen = map && typeof map[img.rel] === 'string' ? map[img.rel] : null;
      return chosen || img.abs;
    };

    // ---------------- staging ----------------
    ctx.progress({ percent: null, label: 'Preparing your cards…' });
    const dsByRelNoExt = new Map(scans.ds.images.map((img) => [img.relNoExt, img]));
    const cards = [];
    const takenStems = new Set(); // lower-case: a generated face name must not hit a front on a case-insensitive disk
    for (const img of scans.front.images) {
      const src = fileFor('front', img);
      const rel = stagedName(img.rel, extOfPath(src) || img.ext);
      const card = { rel, src, source: img.rel, kind: 'front', partner: null };
      if (!opts.only_fronts) {
        const ds = dsByRelNoExt.get(img.relNoExt);
        if (ds) card.partner = { src: fileFor('double_sided', ds), source: ds.rel };
      }
      cards.push(card);
      takenStems.add(stemOf(rel).toLowerCase());
    }
    if (opts.only_fronts && extra.printBackFaces) {
      for (const ds of scans.ds.images) {
        const src = fileFor('double_sided', ds);
        const ext = extOfPath(src) || ds.ext;
        const base = relNoExtOf(ds.rel);
        let candidate = `${base}${FACE_SUFFIX}`;
        for (let n = 2; takenStems.has(stemOf(candidate).toLowerCase()); n += 1) candidate = `${base} (back face ${n})`;
        takenStems.add(stemOf(candidate).toLowerCase());
        cards.push({ rel: ext ? `${candidate}.${ext}` : candidate, src, source: ds.rel, kind: 'face', partner: null });
      }
    }
    const ordered = orderLikeCreatePdf(cards, cards.filter((c) => c.partner));
    const groups = chunkCards(ordered, perChunk);
    if (groups.length !== chunks) ctx.log(`Note: ${groups.length} part(s) needed for ${ordered.length} cards (planned ${chunks}).`);
    await fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    const stageBack = path.join(stageDir, 'back');
    await fsp.mkdir(stageBack, { recursive: true });
    let backStaged = null;
    const expected = new Map(); // stage-relative POSIX path → { rel, kind } of the user's picture
    if (!opts.only_fronts && back.abs) {
      const backImg = scans.back.images.find((img) => img.rel === back.file);
      const src = backImg ? fileFor('back', backImg) : back.abs;
      const name = path.basename(src);
      const source = { rel: back.file, kind: 'back' };
      await stageFile(src, path.join(stageBack, name), source);
      backStaged = `back/${name}`;
      expected.set(backStaged, source);
    }
    for (let i = 0; i < groups.length; i += 1) {
      const frontDir = path.join(stageDir, `c${i}`, 'front');
      const dsDir = path.join(stageDir, `c${i}`, 'double_sided');
      await fsp.mkdir(frontDir, { recursive: true });
      await fsp.mkdir(dsDir, { recursive: true });
      for (const card of groups[i]) {
        ctx.throwIfCancelled();
        const frontSource = { rel: card.source, kind: card.kind === 'face' ? 'double_sided' : 'front' };
        await stageFile(card.src, absInside(frontDir, card.rel), frontSource);
        expected.set(`c${i}/front/${card.rel}`, frontSource);
        if (card.partner) {
          const dsSource = { rel: card.partner.source, kind: 'double_sided' };
          await stageFile(card.partner.src, absInside(dsDir, card.rel), dsSource);
          expected.set(`c${i}/double_sided/${card.rel}`, dsSource);
        }
      }
    }
    // Sanity check: what the engine itself will read from the staged folders. It runs in parallel with
    // the first create_pdf run (both only read), which saves one Python start-up per PDF.
    sanity = deps.helper && typeof deps.helper.run === 'function'
      ? deps.helper.run('list-images', ['--dir', stageRel], { timeoutMs: 120000, signal: ctx.signal })
        .then((listed) => ({ listed }), (err) => ({ err }))
      : Promise.resolve({ err: new Error('the helper is not available') });
    ctx.step('prepare', 'done');
    ctx.throwIfCancelled();

    // ---------------- render ----------------
    ctx.step('render', 'running');
    const total = ordered.length;
    const parts = [];
    let offsetWarned = false;
    let start = 0;
    let workMs = 0; // first "Image 1:" line → "Generated PDF:" line of every run (Python start-up excluded)
    for (let i = 0; i < groups.length; i += 1) {
      const count = groups.length;
      const group = groups[i];
      const partTag = count > 1 ? ` (part ${i + 1} of ${count})` : '';
      if (count > 1) ctx.step('render', 'running', `Make the pages (part ${i + 1} of ${count})`);
      const partialName = opts.output_images ? `.${stem}.partial-${ctx.jobId}-${i + 1}` : `.${stem}.partial-${ctx.jobId}-${i + 1}.pdf`;
      const partialPath = path.join(outputDir, partialName);
      partials.add(partialPath);
      await fsp.rm(partialPath, { recursive: true, force: true }).catch(() => {});
      if (opts.output_images) await fsp.mkdir(partialPath, { recursive: true });
      const argv = buildCreatePdfArgv(spec, eOpts, {
        front: `${stageRel}/c${i}/front`,
        back: `${stageRel}/back`,
        double_sided: `${stageRel}/c${i}/double_sided`,
      }, partialPath, { skip: plan.skip, part: { index: i + 1, count } });
      let generated = false;
      let noPages = false;
      let lastImage = 0;
      let firstImageAt = 0;
      let generatedAt = 0;
      const chunkStart = start;
      const onLine = (line, stream) => {
        if (stream !== 'stdout') return;
        const m = IMAGE_LINE_RE.exec(line);
        if (m) {
          if (!firstImageAt) firstImageAt = Date.now();
          lastImage = Number(m[1]);
          const current = Math.min(total, chunkStart + lastImage);
          if (lastImage >= group.length) {
            ctx.progress({ percent: null, current, total, label: count > 1 ? `Saving part ${i + 1} of ${count}…` : 'Saving the PDF…' });
          } else {
            ctx.progress({ current, total, label: `Card ${current} of ${total}${partTag}` });
          }
          return;
        }
        if (/^Generated (PDF|images):/.test(line)) {
          generated = true;
          generatedAt = Date.now();
        } else if (/^No pages were generated/.test(line)) noPages = true;
        else if (/^Offset cannot be applied/.test(line)) {
          if (!offsetWarned) warn('Your printer alignment could not be applied (the saved alignment is missing or damaged).');
          offsetWarned = true;
        } else if (/^Cannot get back image/.test(line)) warn('The common back image could not be read, so the backs of single-sided cards are blank.');
        else if (/^Ignoring skip indices/.test(line)) warn('Some "Leave slot empty" choices don\'t exist on this layout and were ignored.');
        else if (/^No back image provided/.test(line) && backStaged) warn('The common back image was not found, so the backs of single-sided cards are blank.');
      };
      ctx.progress({ current: chunkStart, total, label: `Card ${chunkStart + 1} of ${total}${partTag}` });
      const runStarted = Date.now();
      try {
        await ctx.spawn(python, argv, { cwd: paths.workspaceDir, env: ctx.pythonEnv(), onLine, name: 'the card maker' });
      } catch (err) {
        throw explainRenderFailure(err, { staged: expected, stageRel, chunkIndex: i });
      }
      workMs += Math.max(0, (generatedAt || Date.now()) - (firstImageAt || runStarted));
      ctx.throwIfCancelled();
      if (noPages || !generated) {
        throw userError(noPages
          ? 'No pages were made: the card maker found no pictures it could read.'
          : 'The card maker stopped without saving the pages. See the log for details.', { code: 'NO_OUTPUT' });
      }
      if (opts.output_images) {
        const names = (await fsp.readdir(partialPath).catch(() => [])).filter((n) => PAGE_FILE_RE.test(n));
        if (!names.length) throw userError('The card maker did not save any page images.', { code: 'NO_OUTPUT' });
        names.sort((a, b) => Number(PAGE_FILE_RE.exec(a)[1]) - Number(PAGE_FILE_RE.exec(b)[1]));
        parts.push({ path: partialPath, pages: names });
      } else {
        const st = await statSafe(partialPath);
        if (!st || !st.isFile() || st.size === 0) throw userError('The card maker did not save the PDF.', { code: 'NO_OUTPUT' });
        parts.push({ path: partialPath, size: st.size });
      }
      start += group.length;
    }
    ctx.step('render', 'done', plan.resources.chunks > 1 ? `Make the pages (${groups.length} parts)` : undefined);
    ctx.throwIfCancelled();

    const checked = await sanity;
    if (checked.listed) {
      const seen = new Set(Array.isArray(checked.listed.files) ? checked.listed.files : []);
      const missing = [];
      for (const [rel, source] of expected) if (!seen.has(rel)) missing.push(source.rel);
      if (missing.length) {
        warn(`The card maker couldn't read ${plural(missing.length, 'picture')}, so ${missing.length === 1 ? 'it is' : 'they are'} missing from the PDF: ${listNames(missing, 5)}.`);
      }
    } else if (!ctx.cancelled) {
      ctx.log(`Could not double-check the prepared pictures: ${checked.err && checked.err.message ? checked.err.message : checked.err}`, 'warn');
    }
    ctx.throwIfCancelled();

    // ---------------- merge / finish ----------------
    let finalPath;
    let sizeBytes = 0;
    let pages = plan.pdfPages;
    if (opts.output_images) {
      ctx.step('finish', 'running');
      ctx.progress({ percent: null, label: 'Saving the page images…' });
      const folder = plan.output.path;
      await fsp.mkdir(folder, { recursive: true });
      for (const name of await fsp.readdir(folder).catch(() => [])) {
        if (PAGE_FILE_RE.test(name)) await fsp.rm(path.join(folder, name), { force: true });
      }
      let index = 0;
      for (const part of parts) {
        for (const name of part.pages) {
          index += 1;
          const dest = path.join(folder, `page${index}.png`);
          await util.moveFile(path.join(part.path, name), dest);
          const st = await statSafe(dest);
          sizeBytes += st ? st.size : 0;
        }
      }
      pages = index;
      finalPath = folder;
      ctx.step('finish', 'done');
    } else {
      let source = parts[0].path;
      if (parts.length > 1) {
        ctx.step('merge', 'running');
        ctx.progress({ percent: null, label: `Joining ${parts.length} parts…` });
        const merged = path.join(outputDir, `.${stem}.partial-${ctx.jobId}.pdf`);
        partials.add(merged);
        const res = await deps.helper.run('merge-pdfs', ['--output', merged, '--inputs', ...parts.map((p) => p.path)], { timeoutMs: 30 * 60 * 1000, signal: ctx.signal });
        if (res && Number.isFinite(res.pages)) {
          pages = res.pages;
          if (res.pages !== plan.pdfPages) ctx.log(`The joined PDF has ${res.pages} pages (planned ${plan.pdfPages}).`, 'warn');
        }
        source = merged;
        ctx.step('merge', 'done');
        ctx.throwIfCancelled();
      }
      ctx.step('finish', 'running');
      ctx.progress({ percent: null, label: 'Saving the PDF…' });
      const moved = await moveIntoPlace(source, plan.output.path);
      finalPath = moved.path;
      if (moved.fallback) {
        warn(`${plan.output.fileName} is open in another program, so the new PDF was saved as ${path.basename(finalPath)}.`);
      }
      const st = await statSafe(finalPath);
      sizeBytes = st ? st.size : 0;
      ctx.step('finish', 'done');
    }

    // ---------------- result ----------------
    const durationMs = Date.now() - started;
    const result = {
      pdfPath: opts.output_images ? null : finalPath,
      outputPath: finalPath,
      isImages: !!opts.output_images,
      fileName: path.basename(finalPath),
      sizeBytes,
      pages,
      sheets: plan.sheets,
      cards: plan.cards.total,
      chunks: groups.length,
      template: plan.template,
      durationMs,
      upscaled: upscaleSummary,
      warnings: warnings.slice(),
      ppi: opts.ppi,
      onlyFronts: !!opts.only_fronts,
    };
    if (!opts.output_images) {
      try {
        const s = settingsOf(deps);
        const prev = isObj(s.pdf) ? s.pdf : {};
        const measured = total > 0 && workMs > 0 ? workMs / 1000 / total : null;
        const prevPpi = isObj(prev.lastPdf) && Number.isFinite(prev.lastPdf.ppi) ? prev.lastPdf.ppi : null;
        let secPerCard = Number.isFinite(measured) && measured > 0 ? measured : prev.secPerCard;
        if (Number.isFinite(measured) && measured > 0 && Number.isFinite(prev.secPerCard) && prev.secPerCard > 0) {
          const rescaled = prevPpi ? prev.secPerCard * (opts.ppi / prevPpi) ** 2 : prev.secPerCard;
          secPerCard = 0.5 * rescaled + 0.5 * measured;
        }
        deps.settings.update({
          pdf: {
            lastPdf: {
              path: finalPath,
              ppi: opts.ppi,
              loadOffset: !!(opts.load_offset && !opts.only_fronts),
              pages,
              at: new Date().toISOString(),
              onlyFronts: !!opts.only_fronts,
              template: plan.template && plan.template.name ? { name: plan.template.name, file: plan.template.file } : null,
              paperSize: plan.paperSize,
              cardSize: plan.cardSize,
              sizeBytes,
            },
            secPerCard: Number.isFinite(secPerCard) ? Math.round(secPerCard * 10000) / 10000 : null,
          },
        });
      } catch (err) {
        logger(deps).warn('[pdf] could not save the last PDF details:', err);
      }
    }
    const s = settingsOf(deps);
    const openWhenDone = !(isObj(s.pdf) && s.pdf.openWhenDone === false);
    if (openWhenDone && !deps.noAutoOpen && sizeBytes < AUTO_OPEN_MAX_BYTES && typeof deps.openPath === 'function') {
      try {
        const res = await deps.openPath(finalPath);
        if (res) ctx.log(`Could not open ${path.basename(finalPath)} automatically: ${res}`, 'warn');
      } catch (err) {
        ctx.log(`Could not open ${path.basename(finalPath)} automatically: ${err && err.message}`, 'warn');
      }
    }
    ctx.log(`Saved ${finalPath} (${formatBytes(sizeBytes)}, ${plural(pages, 'page')}).`);
    return result;
  } finally {
    // the sanity check reads the stage folder: let it end first (on cancel it is killed through ctx.signal)
    if (sanity) await sanity;
    await fsp.rm(stageDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch((err) => {
      ctx.log(`Could not remove the temporary folder ${stageDir}: ${err && err.message}`, 'warn');
    });
    await fsp.rmdir(paths.stageRoot).catch(() => {});
    for (const p of partials) await fsp.rm(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
    try {
      for (const name of await fsp.readdir(outputDir)) {
        if (name.startsWith('.') && name.includes(`.partial-${ctx.jobId}`)) {
          await fsp.rm(path.join(outputDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
        }
      }
    } catch { /* output folder missing */ }
  }
}

module.exports = {
  planPdf,
  startPdfJob,
  buildCreatePdfArgv,
  buildDisplayCommand,
  computeResources,
  chunkCards,
  orderLikeCreatePdf,
  // extras (tested / shared)
  templateForOptions,
  natsortKey,
  compareNatsort,
  parseLength,
  lengthToPx300,
  cropPercent,
  normalizeOptions,
  resolveLayout,
  findStemCollisions,
  suggestLowerPpi,
  outputBytesFactor,
  estimateDuration,
  summarizeUpscalePlan,
  moveIntoPlace,
  lockedCode,
  engineOptions,
  partLabel,
  explainRenderFailure,
  stagedSource,
  PDF_OPTION_KEYS,
  DEFAULT_PDF_OPTIONS,
  OPTION_LABELS,
};
