'use strict';

/**
 * upscayl.js — optional AI upscaling of card images with the user's OWN Upscayl install (spec §9.7).
 *
 * Upscayl is AGPL software: it is never bundled, only detected (env SCM_UPSCAYL_BIN → settings →
 * Windows registry → common install folders → PATH) and run as a separate program.
 *
 * Pipeline (runUpscale, also called inside the PDF job):
 *   scan sources → plan (pure: smart scale, 89 MP cap, cache keys, de-duplication, name checks) →
 *   then, chunk by chunk (≤ CHUNK_SIZE unique images of one output format and scale):
 *     normalize with Pillow (helper `prepare-upscale`: EXIF rotation + RGB → PNG, because Upscayl
 *     ignores EXIF, mangles CMYK and turns transparency yellow) → one dir-mode Upscayl run per
 *     (output format, scale) → validate every output (helper `validate-images`: size, blank,
 *     brightness — Upscayl can silently write black images on some GPUs) → retry failures one by
 *     one (circuit breaker after 3 consecutive GPU failures) → hardlink the results to
 *     game/upscaled/<kind>/<relNoExt>.<ext> and record them in the manifest
 *   → originals for what failed (copied, never cached) → prune stale files → final manifest.
 * Finished chunks are kept when the job is cancelled; the staging folder is always removed.
 *
 * The manifest (`<upscaledRoot>/manifest.json`, written with util.createJsonWriter) maps every
 * upscaled file to the cache key it was made with:
 *   { version: 2, entries: { "<kind>/<relNoExt>.<ext>": { key, hash, src, kind, scale, at } } }
 *   key = `${sha1}|${model}|${modelsDirUsed}|s${scale}|${outExt}|c${compression}|tta${0|1}`
 *   (compression is normalized to 0 unless the output is WebP; images whose size could not be read
 *   from their header get a `|u…` suffix with the smart-scale inputs, so their cache stays exact).
 *
 * No Electron here: everything comes through `deps` (getPaths, settings, jobs, helper, hashCache,
 * logger, emit, watcher, addShutdownHook). Optional test seams: `deps.seams = { env, platform,
 * registry, isFile, homedir }`.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const util = require('./util');
const { userError } = require('./errors');
const { busyError } = require('./locks');
const { toFileUrl } = require('./img-url');
const { scanDir } = require('./scan');
const { readImageSize } = require('./image-meta');
const registryModule = require('./registry');

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

/** Card folders that can be upscaled (sub-folders of game/upscaled/). */
const UPSCALE_KINDS = Object.freeze(['front', 'back', 'double_sided']);
/** Output scales Upscayl supports. */
const SCALES = Object.freeze([2, 3, 4]);
/** Pillow refuses images above ~179 MP and warns above ~89.5 MP: upscaled images stay below this. */
const MAX_UPSCALED_PIXELS = 89000000;
/** Output formats Upscayl writes. */
const OUT_FORMATS = Object.freeze(['png', 'jpg', 'webp']);
/** Upscayl's built-in models (id → display name), in Upscayl's own order. */
const BUILTIN_MODELS = Object.freeze({
  'upscayl-standard-4x': 'Upscayl Standard',
  'upscayl-lite-4x': 'Upscayl Lite',
  'high-fidelity-4x': 'High Fidelity',
  'remacri-4x': 'Remacri',
  'ultramix-balanced-4x': 'Ultramix Balanced',
  'ultrasharp-4x': 'Ultrasharp',
  'digital-art-4x': 'Digital Art',
});
/** Models Upscayl labels "Non-Commercial". */
const NON_COMMERCIAL_MODELS = Object.freeze(['remacri-4x', 'ultramix-balanced-4x', 'ultrasharp-4x']);
/** Replacement order when the configured model is missing (then: any available model). */
const MODEL_FALLBACK_ORDER = Object.freeze(['upscayl-standard-4x', 'high-fidelity-4x', 'digital-art-4x']);
/** stderr text of a GPU (Vulkan) failure. */
const VK_FAILURE_RE = /vk\w+ failed|invalid gpu|vkCreateInstance/i;
/** GPU enumeration line printed by upscayl-bin at start: `[0 NVIDIA GeForce RTX 4080 SUPER]  queueC=…`. */
const GPU_LINE_RE = /^\[(\d+) ([^\]]+)\]/;
/** Progress line: `45,83%` (OS decimal separator). */
const PERCENT_RE = /(\d+(?:[.,]\d+)?)%/;
/** Final progress line without a percent sign: `100.00`. */
const BARE_PROGRESS_RE = /^\s*(\d{1,3}[.,]\d+)\s*$/;
/** An upscayl-bin error line ("🚨 Error: Failed to open …", "… failed"). */
const ERROR_LINE_RE = /\b(error|failed)\b/i;
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_VERSION = 2;
const STAGING_DIR = '.staging';
/** Models-folder segment of a cache key when the folder is not known yet (see settingsKeyFn). */
const ANY_MODELS_DIR = '*';
/** Unique images per chunk (one helper call each for preparing and checking). */
const CHUNK_SIZE = 24;
/** Rough output size per upscaled pixel, by format (PNG of a 2980×4160 card ≈ 15 MB). */
const BYTES_PER_PIXEL = Object.freeze({ png: 1.2, jpg: 0.35, webp: 0.25 });
const DEFAULT_CARD_WIDTH_MM = 63;
const DEFAULT_CARD_HEIGHT_MM = 88;
const DEFAULT_SEC_PER_IMAGE = 3;
/** Stop retrying after this many consecutive systematic failures (GPU errors, same error text). */
const RETRY_BREAKER = 3;
/** Preview files kept in scmCacheDir/preview (2 per preview). */
const PREVIEW_KEEP_FILES = 12;
const PREVIEW_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const PROBE_TIMEOUT_MS = 60000;
/** Time budgets for upscayl-bin (TTA is about 8× slower). */
const BATCH_BASE_TIMEOUT_MS = 120000;
const PER_IMAGE_TIMEOUT_MS = 180000;
const PER_IMAGE_TIMEOUT_TTA_MS = 600000;
const SINGLE_TIMEOUT_MS = 300000;
const SINGLE_TIMEOUT_TTA_MS = 900000;
/** Steps shown by the "Upscale now" job. */
const UPSCALE_STEPS = Object.freeze([
  { id: 'scan', label: 'Find card images' },
  { id: 'upscale', label: 'Upscale with Upscayl' },
  { id: 'save', label: 'Save upscaled images' },
]);

const CASE_INSENSITIVE_FS = process.platform !== 'linux';

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function posNum(value) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null;
}

function posInt(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

function isCancelled(err) {
  return !!err && (err.name === 'CancelledError' || err.code === 'CANCELLED');
}

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDirSync(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(p) {
  try {
    return (await fsp.stat(p)).isFile();
  } catch {
    return false;
  }
}

function fileMtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function exeName(platform) {
  return platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin';
}

/** Comparable form of a folder for cache keys (resolved; lower-case on Windows). */
function dirKey(dir) {
  if (!dir) return '';
  if (dir === ANY_MODELS_DIR) return ANY_MODELS_DIR;
  const resolved = path.resolve(String(dir));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function fold(s) {
  return CASE_INSENSITIVE_FS ? String(s).toLowerCase() : String(s);
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function quoteList(names) {
  const q = names.map((n) => `"${n}"`);
  return q.length <= 2 ? q.join(' and ') : `${q.slice(0, -1).join(', ')} and ${q[q.length - 1]}`;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * Friendly name of a model id (built-in display name, else a tidied file name).
 * @param {string} id
 * @returns {string}
 */
function modelDisplayName(id) {
  if (hasOwn(BUILTIN_MODELS, id)) return BUILTIN_MODELS[id];
  const text = String(id || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || 'Unnamed model';
}

function logTo(deps, level, message) {
  try {
    const logger = deps && deps.logger;
    if (logger && typeof logger[level] === 'function') logger[level](`[upscayl] ${message}`);
  } catch { /* logging never breaks a run */ }
}

function lazy(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(name);
  } catch (err) {
    return { __loadError: err };
  }
}

function seams(deps) {
  return (deps && deps.seams && typeof deps.seams === 'object') ? deps.seams : {};
}

function platformOf(deps) {
  return seams(deps).platform || process.platform;
}

function settingsOf(deps) {
  const s = deps && deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : {};
  return s && typeof s === 'object' ? s : {};
}

function stemOfRelNoExt(relNoExt) {
  const s = String(relNoExt);
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

function relNoExtOf(rel) {
  const s = String(rel);
  const slash = s.lastIndexOf('/');
  const name = s.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // Python pathlib: a suffix only when the last dot is neither the first nor the last character.
  return dot > 0 && dot < name.length - 1 ? s.slice(0, slash + 1 + dot) : s;
}

/** Tell the window that card flags changed (through the watcher's throttle when it runs). */
function notifyCardsChanged(deps, payload) {
  const w = deps && deps.watcher;
  if (w && typeof w.notify === 'function') {
    try {
      w.notify(payload);
      return;
    } catch { /* fall back to a direct event */ }
  }
  if (deps && typeof deps.emit === 'function') {
    try {
      deps.emit('cards:changed', payload);
    } catch { /* window gone */ }
  }
}

// ---------------------------------------------------------------------------------------------
// Pure parsing / argument helpers
// ---------------------------------------------------------------------------------------------

/**
 * Native scale of a model from its id: the first `<digit>x` (`upscayl-standard-4x`, `4x_NMKD-Siax`),
 * else the first `x<digit>` (`realesr-animevideov3-x2`, `RealESRGAN_General_x4_v3`), else 4.
 * The Windows upscayl-bin does not detect it itself, so it is passed as `-z`.
 * @param {string} id
 * @returns {number} 1–9
 */
function modelScaleFromName(id) {
  const s = String(id || '');
  const m = /(\d)x/i.exec(s) || /x(\d)/i.exec(s);
  const n = m ? Number(m[1]) : 4;
  return n >= 1 && n <= 9 ? n : 4;
}

/**
 * GPUs listed in upscayl-bin's stderr (`[0 NVIDIA GeForce RTX 4080 SUPER]  queueC=2[8] …`),
 * de-duplicated by id and sorted.
 * @param {string|string[]} text stderr text or lines
 * @returns {{ id: number, name: string }[]}
 */
function parseGpuLines(text) {
  const parts = Array.isArray(text) ? text : [text];
  const byId = new Map();
  for (const part of parts) {
    if (part === null || part === undefined) continue;
    for (const raw of String(part).split(/\r\n|\n|\r/)) {
      const m = GPU_LINE_RE.exec(raw.trimStart());
      if (!m) continue;
      const id = Number(m[1]);
      const name = m[2].trim();
      if (name && Number.isSafeInteger(id) && !byId.has(id)) byId.set(id, { id, name });
    }
  }
  return [...byId.values()].sort((a, b) => a.id - b.id);
}

/**
 * Progress percentage of an upscayl-bin output line: `45,83%` / `50.00%` (any decimal separator)
 * or the final bare `100.00`. Values outside 0–100 are ignored.
 * @param {string} line
 * @returns {number|null}
 */
function parsePercent(line) {
  const s = String(line === null || line === undefined ? '' : line);
  const m = PERCENT_RE.exec(s) || BARE_PROGRESS_RE.exec(s);
  if (!m) return null;
  const value = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 100) return null;
  return value;
}

/**
 * Normalize an output format: 'png' | 'jpg' | 'webp' (accepts 'jpeg'); null when unknown.
 * @param {string} format
 * @returns {'png'|'jpg'|'webp'|null}
 */
function normalizeOutExt(format) {
  const f = String(format || '').trim().toLowerCase().replace(/^\./, '');
  if (f === 'jpeg') return 'jpg';
  return OUT_FORMATS.includes(f) ? f : null;
}

/**
 * Output extension for a source image (spec §9.7): format 'same' keeps PNG/JPEG/WebP and turns
 * everything else (GIF, BMP, TIFF, AVIF, JPEG 2000) into PNG; an explicit format wins.
 * @param {string} format 'same'|'png'|'jpg'|'webp'
 * @param {string|null} type sniffed source type ('png', 'jpeg', …)
 * @returns {'png'|'jpg'|'webp'}
 */
function outExtFor(format, type) {
  const explicit = normalizeOutExt(format);
  if (explicit) return explicit;
  if (type === 'png') return 'png';
  if (type === 'jpeg') return 'jpg';
  if (type === 'webp') return 'webp';
  return 'png';
}

function normalizeGpuId(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim().toLowerCase();
  if (!s || s === 'auto') return null;
  return /^\d{1,2}(,\d{1,2}){0,7}$/.test(s) ? s : null;
}

function normalizeThreads(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  return /^\d{1,3}:\d{1,3}(,\d{1,3}){0,7}:\d{1,3}$/.test(s) ? s : null;
}

function normalizeTile(value) {
  if (typeof value === 'number') return Number.isInteger(value) && value >= 32 && value <= 16384 ? String(value) : null;
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (/^\d{1,5}$/.test(s)) return normalizeTile(Number(s));
  if (/^\d{1,5}(,\d{1,5}){1,7}$/.test(s) && s.split(',').every((t) => Number(t) === 0 || Number(t) >= 32) && s.split(',').some((t) => Number(t) >= 32)) return s;
  return null;
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * upscayl-bin arguments (spec §9.7):
 * `-i in -o out -m <modelsDir> -n <model> -z <modelScale> -s <scale> -f <fmt> [-c compression (WebP
 * only)] [-t tile (> 0)] [-g gpu (not auto)] [-j threads (if set)] [-x (TTA)]`.
 * Input and output must both be folders (batch) or both files (single image; the format then
 * follows the output extension).
 * @param {{ input: string, output: string, modelsDir: string, model: string, modelScale?: number,
 *   scale?: number, format?: string, compression?: number, tileSize?: number|string,
 *   gpuId?: string|number, threads?: string, tta?: boolean }} o
 * @returns {string[]}
 */
function buildUpscaylArgs(o = {}) {
  for (const key of ['input', 'output', 'modelsDir', 'model']) {
    if (typeof o[key] !== 'string' || !o[key]) throw new TypeError(`buildUpscaylArgs: ${key} is required`);
  }
  const scale = SCALES.includes(Number(o.scale)) ? Number(o.scale) : 4;
  const ms = Number(o.modelScale);
  const modelScale = Number.isInteger(ms) && ms >= 1 && ms <= 9 ? ms : 4;
  const format = normalizeOutExt(o.format) || 'png';
  const args = ['-i', o.input, '-o', o.output, '-m', o.modelsDir, '-n', o.model, '-z', String(modelScale), '-s', String(scale), '-f', format];
  if (format === 'webp') args.push('-c', String(clampInt(o.compression, 0, 100, 0)));
  const tile = normalizeTile(o.tileSize);
  if (tile) args.push('-t', tile);
  const gpu = normalizeGpuId(o.gpuId);
  if (gpu !== null) args.push('-g', gpu);
  const threads = normalizeThreads(o.threads);
  if (threads) args.push('-j', threads);
  if (o.tta === true) args.push('-x');
  return args;
}

// ---------------------------------------------------------------------------------------------
// Settings normalization, scale choice, keys (pure)
// ---------------------------------------------------------------------------------------------

/**
 * Validated copy of settings.upscayl (accepts the full settings object too).
 * @param {object} raw
 * @returns {{ enabled: boolean, model: string, scale: number, smartScale: boolean, format: string,
 *   compression: number, gpuId: string|null, tileSize: string|null, tta: boolean, threads: string|null,
 *   secPerImage: number, targets: { front: boolean, back: boolean, double_sided: boolean } }}
 */
function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' && raw.upscayl && typeof raw.upscayl === 'object' ? raw.upscayl : (raw || {});
  const fmt = String(s.format || 'same').toLowerCase();
  const targets = s.targets && typeof s.targets === 'object' ? s.targets : {};
  return {
    enabled: s.enabled !== false,
    model: str(s.model) || 'upscayl-standard-4x',
    scale: SCALES.includes(Number(s.scale)) ? Number(s.scale) : 4,
    smartScale: s.smartScale !== false,
    format: fmt === 'same' ? 'same' : (normalizeOutExt(fmt) || 'same'),
    compression: clampInt(s.compression, 0, 100, 0),
    gpuId: normalizeGpuId(s.gpuId),
    tileSize: normalizeTile(s.tileSize),
    tta: s.tta === true,
    threads: normalizeThreads(s.threads),
    secPerImage: posNum(s.secPerImage) || DEFAULT_SEC_PER_IMAGE,
    targets: {
      front: targets.front !== false,
      back: targets.back !== false,
      double_sided: targets.double_sided !== false,
    },
  };
}

/**
 * Decide whether an image needs upscaling and by how much (spec §9.7).
 * - effective PPI = width / card width (unknown width → needs the maximum scale);
 * - smart scale: already sharp (effPpi ≥ target) → 'sharp'; else the smallest s ∈ {2,3,4}, s ≤ max,
 *   with effPpi × s ≥ target, else max; not smart: max;
 * - then s is lowered while width × height × s² > 89 MP (min 2; still too big → 'sharp').
 * @param {{ width?: number|null, height?: number|null, cardWidthIn: number, targetPpi: number,
 *   maxScale: number, smart: boolean, maxPixels?: number }} o
 * @returns {{ action: 'sharp'|'upscale', scale: number, effPpi: number|null, reason: null|'sharp'|'too_large' }}
 */
function chooseScale(o) {
  const w = posInt(o.width);
  const h = posInt(o.height);
  const maxScale = SCALES.includes(Number(o.maxScale)) ? Number(o.maxScale) : 4;
  const maxPixels = posNum(o.maxPixels) || MAX_UPSCALED_PIXELS;
  const target = posNum(o.targetPpi) || 300;
  const cardW = posNum(o.cardWidthIn) || DEFAULT_CARD_WIDTH_MM / 25.4;
  const effPpi = w ? w / cardW : null;
  if (o.smart && effPpi !== null && effPpi >= target) return { action: 'sharp', scale: 1, effPpi, reason: 'sharp' };
  let scale = maxScale;
  if (o.smart && effPpi !== null) scale = SCALES.find((s) => s <= maxScale && effPpi * s >= target) || maxScale;
  if (w && h) {
    const capped = capScale(scale, w, h, maxPixels);
    if (capped === null) return { action: 'sharp', scale: 1, effPpi, reason: 'too_large' };
    scale = capped;
  }
  return { action: 'upscale', scale, effPpi, reason: null };
}

/**
 * Lower `scale` (minimum 2) until width × height × scale² ≤ maxPixels; null when even 2× is too big.
 * @param {number} scale
 * @param {number} w
 * @param {number} h
 * @param {number} [maxPixels]
 * @returns {number|null}
 */
function capScale(scale, w, h, maxPixels = MAX_UPSCALED_PIXELS) {
  let s = scale;
  while (s > 2 && w * h * s * s > maxPixels) s -= 1;
  return w * h * s * s > maxPixels ? null : s;
}

/**
 * Cache key of one upscaled image (spec §9.7) + an optional context suffix.
 * @param {{ hash: string, model: string, modelsDirUsed: string, scale: number, outExt: string,
 *   compression?: number, tta?: boolean, context?: string|null }} o
 * @returns {string}
 */
function makeKey(o) {
  const compression = o.outExt === 'webp' ? clampInt(o.compression, 0, 100, 0) : 0;
  const base = `${o.hash}|${o.model}|${o.modelsDirUsed || ''}|s${o.scale}|${o.outExt}|c${compression}|tta${o.tta ? 1 : 0}`;
  return o.context ? `${base}|${o.context}` : base;
}

/**
 * Compare a manifest key with a planned key. A planned key whose models-folder segment is the
 * wildcard `*` (Upscayl not detected yet) matches any folder.
 * @param {string} entryKey
 * @param {string} planned
 * @returns {boolean}
 */
function keyMatches(entryKey, planned) {
  if (typeof entryKey !== 'string' || typeof planned !== 'string' || !entryKey || !planned) return false;
  const marker = `|${ANY_MODELS_DIR}|`;
  const at = planned.indexOf(marker);
  if (at < 0) return entryKey === planned;
  const prefix = planned.slice(0, at + 1);
  const suffix = planned.slice(at + marker.length - 1);
  return entryKey.length > prefix.length + suffix.length && entryKey.startsWith(prefix) && entryKey.endsWith(suffix);
}

function toStringSet(value) {
  if (!value) return null;
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return null;
}

/**
 * Plan one item without looking at the cache (shared by planUpscale and the key functions).
 * @returns {{ action: 'sharp'|'upscale'|'skipped', scale: number, effPpi: number|null, reason: string|null,
 *   outExt: string, destRel: string, key: string|null, compression: number, dimsKnown: boolean }}
 */
function planOne(item, p) {
  const outExt = outExtFor(p.settings.format, item.type);
  const compression = outExt === 'webp' ? p.settings.compression : 0;
  const destRel = `${item.kind}/${item.relNoExt}.${outExt}`;
  const dimsKnown = !!(posInt(item.width) && posInt(item.height));
  if (!item.hash) {
    return { action: 'skipped', scale: 1, effPpi: null, reason: 'unreadable', outExt, destRel, key: null, compression, dimsKnown };
  }
  const choice = chooseScale({
    width: item.width,
    height: item.height,
    cardWidthIn: p.cardWidthIn,
    targetPpi: p.targetPpi,
    maxScale: p.settings.scale,
    smart: p.settings.smartScale,
    maxPixels: p.maxPixels,
  });
  if (choice.action === 'sharp') return { ...choice, outExt, destRel, key: null, compression, dimsKnown };
  // Size unknown from the header: the real scale is chosen after normalization, from the inputs below.
  const context = dimsKnown ? null : (p.settings.smartScale ? `u1p${p.targetPpi}w${Math.round(p.cardWidthIn * 10000)}` : 'u0');
  const key = makeKey({
    hash: item.hash, model: p.model, modelsDirUsed: p.modelsDirUsed, scale: choice.scale, outExt, compression, tta: p.settings.tta, context,
  });
  return { ...choice, outExt, destRel, key, compression, dimsKnown };
}

function planParams(input) {
  const settings = normalizeSettings(input.settings);
  let model = str(input.model);
  let modelsDirUsed = str(input.modelsDirUsed) ? dirKey(input.modelsDirUsed) : null;
  if ((!model || !modelsDirUsed) && input.status && Array.isArray(input.status.models)) {
    const eff = resolveModel(input.status, model || settings.model);
    if (eff) {
      if (!model) model = eff.id;
      if (!modelsDirUsed && eff.dir) modelsDirUsed = dirKey(eff.dir);
    }
  }
  return {
    settings,
    model: model || settings.model,
    modelsDirUsed: modelsDirUsed || ANY_MODELS_DIR,
    targetPpi: posNum(input.targetPpi) || 300,
    cardWidthIn: posNum(input.cardWidthIn) || DEFAULT_CARD_WIDTH_MM / 25.4,
    maxPixels: posNum(input.maxPixels) || MAX_UPSCALED_PIXELS,
  };
}

/**
 * @typedef {object} PlanItem
 * @property {string} kind 'front' | 'back' | 'double_sided'
 * @property {string} rel posix path inside the kind folder
 * @property {string} relNoExt
 * @property {string} abs
 * @property {string} name
 * @property {string|null} hash sha1 of the source
 * @property {string|null} type sniffed type
 * @property {number|null} width upright pixel width (after EXIF rotation)
 * @property {number|null} height
 * @property {'sharp'|'cached'|'upscale'|'skipped'} action
 * @property {number} scale 2|3|4 (1 when not upscaled)
 * @property {number|null} effPpi
 * @property {string|null} reason why it is sharp/skipped ('sharp', 'too_large', 'name_collision', 'unreadable')
 * @property {'png'|'jpg'|'webp'} outExt
 * @property {string} destRel `${kind}/${relNoExt}.${outExt}` inside game/upscaled
 * @property {string|null} key cache key (null for sharp/skipped)
 * @property {boolean} dimsKnown the header size was readable
 */

/**
 * @typedef {object} UniqueGroup
 * @property {string} id the cache key shared by the group
 * @property {string} key
 * @property {string} hash
 * @property {number} scale planned scale
 * @property {string} outExt
 * @property {number} compression
 * @property {boolean} dimsKnown
 * @property {string} src first source file (absolute)
 * @property {string|null} type
 * @property {number|null} width
 * @property {number|null} height
 * @property {PlanItem[]} items identical images sharing this upscale
 */

/**
 * Plan an upscale run (PURE, spec §9.7).
 *
 * @param {object} input
 * @param {Array<{ kind: string, rel: string, relNoExt?: string, abs: string, hash: string|null, type: string|null,
 *   width: number|null, height: number|null, name?: string, ext?: string }>} input.items sources (ScanItem + kind)
 * @param {object} input.settings settings.upscayl (or the full settings)
 * @param {number} input.targetPpi print resolution (pdf.options.ppi)
 * @param {number} input.cardWidthIn card width in inches (layout)
 * @param {{ entries: object }} [input.manifest] current manifest (loadManifest)
 * @param {Set<string>|string[]} [input.existingFiles] files present under game/upscaled ('front/a.png');
 *   omitted = trust the manifest
 * @param {string} [input.model] effective model id (default: from `status`, else settings.model)
 * @param {string} [input.modelsDirUsed] folder of that model; when omitted (and no `status`) cache keys
 *   are compared without it
 * @param {object} [input.status] UpscaylStatus (used to derive model/modelsDirUsed when not given)
 * @param {string[]} [input.kinds] kinds processed in this run (stale files are only listed for them)
 * @param {boolean} [input.caseInsensitive] file names compared case-insensitively (default: not Linux)
 * @returns {{ ok: boolean, errors: Array<{ code: 'name_collision'|'stem_collision', kind: string, files: string[], message: string }>,
 *   items: PlanItem[], cached: PlanItem[], sharp: PlanItem[], skipped: PlanItem[], toUpscale: PlanItem[],
 *   unique: UniqueGroup[], stale: string[], counts: { total: number, cached: number, sharp: number, skipped: number,
 *   upscale: number, unique: number, stale: number }, secEst: number, bytesEst: number, model: string,
 *   modelsDirUsed: string, tta: boolean, targetPpi: number, cardWidthIn: number }}
 */
function planUpscale(input = {}) {
  const raw = Array.isArray(input.items) ? input.items : [];
  const items = raw.filter((it) => it && typeof it.rel === 'string' && it.rel && UPSCALE_KINDS.includes(it.kind));
  const p = planParams(input);
  const caseInsensitive = input.caseInsensitive === undefined ? CASE_INSENSITIVE_FS : !!input.caseInsensitive;
  const f = (s) => (caseInsensitive ? String(s).toLowerCase() : String(s));
  const entries = input.manifest && input.manifest.entries && typeof input.manifest.entries === 'object' ? input.manifest.entries : {};
  const existingExact = toStringSet(input.existingFiles);
  const existing = existingExact ? new Set([...existingExact].map(f)) : null;
  const kinds = Array.isArray(input.kinds) && input.kinds.length
    ? input.kinds.filter((k) => UPSCALE_KINDS.includes(k))
    : [...new Set(items.map((it) => it.kind))];

  const base = items.map((it) => {
    const relNoExt = typeof it.relNoExt === 'string' && it.relNoExt ? it.relNoExt : relNoExtOf(it.rel);
    return {
      kind: it.kind,
      rel: it.rel,
      relNoExt,
      abs: it.abs,
      name: it.name || it.rel.split('/').pop(),
      ext: it.ext || '',
      hash: it.hash || null,
      type: it.type || null,
      width: posInt(it.width),
      height: posInt(it.height),
    };
  });

  // Name checks: two sources may not end up in the same upscaled file (a.png + a.jpg → a.png), and
  // the card maker keys cards by their exact-case name without extension (whole folder tree).
  const errors = [];
  const colliding = new Set();
  const byDest = new Map();
  const byStem = new Map();
  for (const b of base) {
    const dk = f(`${b.kind}/${b.relNoExt}.${outExtFor(p.settings.format, b.type)}`);
    if (!byDest.has(dk)) byDest.set(dk, []);
    byDest.get(dk).push(b);
    const sk = `${b.kind}\u0000${stemOfRelNoExt(b.relNoExt)}`;
    if (!byStem.has(sk)) byStem.set(sk, []);
    byStem.get(sk).push(b);
  }
  for (const list of byDest.values()) {
    if (list.length < 2) continue;
    for (const b of list) colliding.add(b);
    const names = list.map((b) => b.rel);
    errors.push({
      code: 'name_collision',
      kind: list[0].kind,
      files: names,
      message: `${quoteList(names)} would get the same upscaled file name, so they were not upscaled. Rename one of them (Your cards → Fix names automatically).`,
    });
  }
  for (const list of byStem.values()) {
    if (list.length < 2 || list.every((b) => colliding.has(b))) continue;
    for (const b of list) colliding.add(b);
    const names = list.map((b) => b.rel);
    errors.push({
      code: 'stem_collision',
      kind: list[0].kind,
      files: names,
      message: `${quoteList(names)} share the name "${stemOfRelNoExt(list[0].relNoExt)}" (only one of them would be printed), so they were not upscaled. Fix the names first (Your cards → Fix names automatically).`,
    });
  }

  const planned = base.map((b) => {
    const one = planOne(b, p);
    if (colliding.has(b)) return { ...b, ...one, action: 'skipped', reason: 'name_collision', key: null };
    if (one.action !== 'upscale') return { ...b, ...one };
    const entry = hasOwn(entries, one.destRel) ? entries[one.destRel] : null;
    const present = existing ? existing.has(f(one.destRel)) : true;
    const cached = !!(entry && present && keyMatches(entry.key, one.key));
    return { ...b, ...one, action: cached ? 'cached' : 'upscale' };
  });

  // Identical images (same cache key = same bytes, model, scale, format) are upscaled once.
  const groups = new Map();
  for (const it of planned) {
    if (it.action !== 'upscale') continue;
    let g = groups.get(it.key);
    if (!g) {
      g = {
        id: it.key,
        key: it.key,
        hash: it.hash,
        scale: it.scale,
        outExt: it.outExt,
        compression: it.compression,
        dimsKnown: it.dimsKnown,
        src: it.abs,
        type: it.type,
        width: it.width,
        height: it.height,
        items: [],
      };
      groups.set(it.key, g);
    }
    g.items.push(it);
  }
  const unique = [...groups.values()];

  const current = new Set(planned.filter((it) => it.action === 'cached' || it.action === 'upscale').map((it) => f(it.destRel)));
  const stale = existingExact
    ? [...existingExact].filter((rel) => kinds.includes(rel.split('/')[0]) && !current.has(f(rel))).sort()
    : [];

  let bytesEst = 0;
  for (const g of unique) {
    const bpp = BYTES_PER_PIXEL[g.outExt] || BYTES_PER_PIXEL.png;
    bytesEst += g.width && g.height ? g.width * g.height * g.scale * g.scale * bpp : 15e6 * (g.scale / 4) ** 2;
  }
  const by = (action) => planned.filter((it) => it.action === action);
  const cachedList = by('cached');
  const sharpList = by('sharp');
  const skippedList = by('skipped');
  const toUpscale = by('upscale');
  return {
    ok: errors.length === 0,
    errors,
    items: planned,
    cached: cachedList,
    sharp: sharpList,
    skipped: skippedList,
    toUpscale,
    unique,
    stale,
    counts: {
      total: planned.length,
      cached: cachedList.length,
      sharp: sharpList.length,
      skipped: skippedList.length,
      upscale: toUpscale.length,
      unique: unique.length,
      stale: stale.length,
    },
    secEst: Math.round(unique.length * p.settings.secPerImage),
    bytesEst: Math.round(bytesEst),
    model: p.model,
    modelsDirUsed: p.modelsDirUsed,
    tta: p.settings.tta,
    targetPpi: p.targetPpi,
    cardWidthIn: p.cardWidthIn,
  };
}

/**
 * Split unique groups into chunks of ≤ size, each with ONE output format and planned scale (so a
 * chunk is usually a single dir-mode Upscayl run).
 * @param {UniqueGroup[]} groups
 * @param {number} [size]
 * @returns {UniqueGroup[][]}
 */
function chunkGroups(groups, size = CHUNK_SIZE) {
  const n = Math.max(1, Math.floor(size) || CHUNK_SIZE);
  const byBatch = new Map();
  for (const g of groups) {
    const k = `${g.outExt}|${g.scale}`;
    if (!byBatch.has(k)) byBatch.set(k, []);
    byBatch.get(k).push(g);
  }
  const chunks = [];
  for (const list of byBatch.values()) {
    for (let i = 0; i < list.length; i += n) chunks.push(list.slice(i, i + n));
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

/**
 * Models in Upscayl's models folder and in the custom models folder: `<id>.param` + `<id>.bin`
 * pairs (case-insensitive extensions on Windows/macOS). Built-in folder entries win over a custom
 * model with the same id. Built-in ids come first (Upscayl's order), then the others by name.
 * @param {string|null} modelsDir
 * @param {string|null} [customDir]
 * @param {{ platform?: string }} [opts]
 * @returns {Array<{ id: string, name: string, description: string, scale: number, custom: boolean,
 *   nonCommercial: boolean, dir: string, bytes: number|null }>}
 */
function listModels(modelsDir, customDir, opts = {}) {
  const platform = (opts && opts.platform) || process.platform;
  const ci = platform === 'win32' || platform === 'darwin';
  const out = [];
  const seen = new Set();
  const order = Object.keys(BUILTIN_MODELS);
  const addFrom = (dir, custom) => {
    if (!dir) return;
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    const params = new Map();
    const bins = new Map();
    for (const name of names) {
      const m = /^(.+)\.(param|bin)$/i.exec(name);
      if (!m) continue;
      if (!ci && m[2] !== m[2].toLowerCase()) continue;
      const k = ci ? m[1].toLowerCase() : m[1];
      (m[2].toLowerCase() === 'param' ? params : bins).set(k, { id: m[1], name });
    }
    const found = [];
    for (const [k, param] of params) {
      const bin = bins.get(k);
      if (!bin || seen.has(k)) continue;
      // upscayl-bin builds "<dir>/<id>.param" in a 256-character buffer.
      if (path.join(dir, `${param.id}.param`).length >= 255) continue;
      seen.add(k);
      let bytes = null;
      try {
        bytes = fs.statSync(path.join(dir, bin.name)).size;
      } catch { /* unreadable: still listed */ }
      found.push({
        id: param.id,
        name: modelDisplayName(param.id),
        description: '',
        scale: modelScaleFromName(param.id),
        custom,
        nonCommercial: !custom && NON_COMMERCIAL_MODELS.includes(param.id),
        dir: path.resolve(dir),
        bytes,
      });
    }
    found.sort((a, b) => {
      const ia = !custom && order.includes(a.id) ? order.indexOf(a.id) : Infinity;
      const ib = !custom && order.includes(b.id) ? order.indexOf(b.id) : Infinity;
      if (ia !== ib) return ia - ib;
      return util.naturalCompare(a.id.toLowerCase(), b.id.toLowerCase());
    });
    out.push(...found);
  };
  addFrom(modelsDir, false);
  addFrom(customDir, true);
  return out;
}

/**
 * Effective model (spec §9.7): the configured one when available, else the first available of
 * upscayl-standard-4x, high-fidelity-4x, digital-art-4x, else any model (with a warning).
 * @param {{ models: Array<{ id: string, custom?: boolean }> }} status
 * @param {string} configured
 * @returns {(object & { warning: string|null })|null}
 */
function resolveModel(status, configured) {
  const models = status && Array.isArray(status.models) ? status.models : [];
  if (!models.length) return null;
  const want = str(configured);
  const exact = want ? models.find((m) => m.id === want) : null;
  if (exact) return { ...exact, warning: null };
  let pick = null;
  for (const id of MODEL_FALLBACK_ORDER) {
    pick = models.find((m) => m.id === id && !m.custom) || null;
    if (pick) break;
  }
  if (!pick) pick = models[0];
  return {
    ...pick,
    warning: want
      ? `The upscaling model "${modelDisplayName(want)}" isn't available, so "${modelDisplayName(pick.id)}" was used instead. You can choose another model in Upscale.`
      : null,
  };
}

function smallestModel(models) {
  const list = (models || []).filter((m) => !m.custom);
  const pool = list.length ? list : (models || []);
  if (!pool.length) return null;
  const lite = pool.find((m) => m.id === 'upscayl-lite-4x');
  if (lite) return lite;
  return pool.slice().sort((a, b) => (a.bytes ?? Infinity) - (b.bytes ?? Infinity))[0];
}

// ---------------------------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------------------------

function cleanQuoted(value) {
  const s = str(value);
  return s ? s.replace(/^"+|"+$/g, '').trim() || null : null;
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function versionFromEntry(entry) {
  const v = str(entry && entry.DisplayVersion);
  if (v) return v;
  const m = /Upscayl\s+v?(\d+(?:\.\d+)*)/i.exec(String((entry && entry.DisplayName) || ''));
  return m ? m[1] : null;
}

/** Install folders an Uninstall entry points to: InstallLocation, else the folder of DisplayIcon. */
function registryRoots(entry, platform) {
  const p = pathApi(platform);
  const roots = [];
  const loc = cleanQuoted(entry && entry.InstallLocation);
  if (loc) roots.push(loc);
  const exe = registryModule.exePathFromDisplayIcon(entry && entry.DisplayIcon);
  if (exe) roots.push(p.dirname(exe));
  return roots;
}

function binFromRoot(root, platform) {
  const p = pathApi(platform);
  if (platform === 'darwin' && /\.app$/i.test(root)) return p.join(root, 'Contents', 'Resources', 'bin', exeName(platform));
  return p.join(root, 'resources', 'bin', exeName(platform));
}

function rootFromBin(bin, platform) {
  const p = pathApi(platform);
  const binDir = p.dirname(bin);
  const resources = p.dirname(binDir);
  if (p.basename(binDir).toLowerCase() === 'bin' && p.basename(resources).toLowerCase() === 'resources') {
    const root = p.dirname(resources);
    if (platform === 'darwin' && p.basename(root) === 'Contents') return p.dirname(root);
    return root;
  }
  return null;
}

function sameDir(a, b, platform) {
  if (!a || !b) return false;
  const p = pathApi(platform);
  const ra = p.resolve(a);
  const rb = p.resolve(b);
  return platform === 'win32' || platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function envValue(env, name, platform) {
  if (!env) return null;
  if (platform !== 'win32') return str(env[name]);
  if (hasOwn(env, name)) return str(env[name]);
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key ? str(env[key]) : null;
}

function commonBinCandidates(env, platform, homedir) {
  const p = pathApi(platform);
  if (platform === 'win32') {
    const roots = [];
    const add = (base, ...rest) => {
      if (base) roots.push(p.join(base, ...rest));
    };
    add(envValue(env, 'LOCALAPPDATA', platform), 'Programs', 'Upscayl');
    add(envValue(env, 'ProgramFiles', platform), 'Upscayl');
    add(envValue(env, 'ProgramW6432', platform), 'Upscayl');
    add(envValue(env, 'ProgramFiles(x86)', platform), 'Upscayl');
    add(envValue(env, 'USERPROFILE', platform) || homedir, 'scoop', 'apps', 'upscayl', 'current');
    add(envValue(env, 'SCOOP', platform), 'apps', 'upscayl', 'current');
    add(envValue(env, 'ProgramData', platform), 'scoop', 'apps', 'upscayl', 'current');
    const seen = new Set();
    return roots.filter((r) => {
      const k = r.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).map((r) => binFromRoot(r, platform));
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Upscayl.app/Contents/Resources/bin/upscayl-bin',
      homedir ? p.join(homedir, 'Applications', 'Upscayl.app', 'Contents', 'Resources', 'bin', 'upscayl-bin') : null,
    ].filter(Boolean);
  }
  return [
    '/opt/Upscayl/resources/bin/upscayl-bin',
    '/usr/share/upscayl/bin/upscayl-bin',
    '/var/lib/flatpak/app/org.upscayl.Upscayl/current/active/files/upscayl/resources/bin/upscayl-bin',
    homedir ? p.join(homedir, '.local', 'share', 'flatpak', 'app', 'org.upscayl.Upscayl', 'current', 'active', 'files', 'upscayl', 'resources', 'bin', 'upscayl-bin') : null,
    '/snap/upscayl/current/opt/Upscayl/resources/bin/upscayl-bin',
  ].filter(Boolean);
}

/**
 * Find upscayl-bin (spec §9.7 order): env SCM_UPSCAYL_BIN (authoritative: when set but missing,
 * detection stops with an error) → settings.upscayl.binPath → Windows registry (InstallLocation,
 * else the folder of DisplayIcon — Upscayl's installer leaves InstallLocation empty) → common
 * install folders → PATH. Pure apart from the injected `isFile` / `queryRegistry`.
 *
 * @param {object} input
 * @param {object} [input.env] environment variables
 * @param {object} [input.upscayl] settings.upscayl
 * @param {string} [input.platform]
 * @param {() => Promise<Array<{ DisplayName: string, DisplayVersion?: string, DisplayIcon?: string, InstallLocation?: string }>>} [input.queryRegistry]
 * @param {(p: string) => boolean} [input.isFile]
 * @param {string} [input.homedir]
 * @returns {Promise<{ found: boolean, binPath: string|null, source: 'env'|'settings'|'registry'|'common'|'path'|null,
 *   root: string|null, version: string|null, error: string|null, tried: string[] }>}
 */
async function detectUpscaylBinary(input = {}) {
  const env = input.env || {};
  const up = input.upscayl || {};
  const platform = input.platform || process.platform;
  const fileExists = typeof input.isFile === 'function' ? input.isFile : isFileSync;
  const queryRegistry = typeof input.queryRegistry === 'function' ? input.queryRegistry : async () => [];
  const homedir = input.homedir !== undefined ? input.homedir : os.homedir();
  const p = pathApi(platform);
  const tried = [];
  let registryEntries = null;

  const entries = async () => {
    if (registryEntries === null) {
      try {
        const list = platform === 'win32' ? await queryRegistry() : [];
        registryEntries = (Array.isArray(list) ? list : list ? [list] : [])
          .filter((e) => e && typeof e.DisplayName === 'string' && /upscayl/i.test(e.DisplayName))
          .sort((a, b) => compareVersions(versionFromEntry(b), versionFromEntry(a)));
      } catch {
        registryEntries = [];
      }
    }
    return registryEntries;
  };
  const check = (candidate, source, extra = {}) => {
    if (!candidate) return null;
    const abs = p.resolve(candidate);
    tried.push(abs);
    let ok = false;
    try {
      ok = !!fileExists(abs);
    } catch {
      ok = false;
    }
    return ok ? { binPath: abs, source, ...extra } : null;
  };
  const finish = async (hit) => {
    const root = rootFromBin(hit.binPath, platform);
    let version = hit.version !== undefined ? hit.version : null;
    if (version === null && root && platform === 'win32') {
      for (const e of await entries()) {
        if (registryRoots(e, platform).some((r) => sameDir(r, root, platform))) {
          version = versionFromEntry(e);
          break;
        }
      }
    }
    return { found: true, binPath: hit.binPath, source: hit.source, root, version, error: null, tried };
  };
  const notFound = (error) => ({ found: false, binPath: null, source: null, root: null, version: null, error, tried });

  const envBin = cleanQuoted(envValue(env, 'SCM_UPSCAYL_BIN', platform));
  if (envBin) {
    const hit = check(envBin, 'env');
    if (hit) return finish(hit);
    return notFound(`SCM_UPSCAYL_BIN points to "${envBin}", which doesn't exist.`);
  }
  const configured = cleanQuoted(up.binPath);
  if (configured) {
    const hit = check(configured, 'settings');
    if (hit) return finish(hit);
  }
  if (platform === 'win32') {
    for (const e of await entries()) {
      for (const root of registryRoots(e, platform)) {
        const hit = check(binFromRoot(root, platform), 'registry', { version: versionFromEntry(e) });
        if (hit) return finish(hit);
      }
    }
  }
  for (const candidate of commonBinCandidates(env, platform, homedir)) {
    const hit = check(candidate, 'common');
    if (hit) return finish(hit);
  }
  const pathVar = envValue(env, 'PATH', platform) || '';
  for (const piece of pathVar.split(platform === 'win32' ? ';' : ':')) {
    const dir = piece.trim().replace(/^"+|"+$/g, '');
    if (!dir) continue;
    const hit = check(p.join(dir, exeName(platform)), 'path');
    if (hit) return finish(hit);
  }
  return notFound(configured ? `Upscayl is no longer at "${configured}". Choose its new location, or reinstall it.` : null);
}

// Per-deps detection cache (the registry lookup is the slow part).
const detectionStates = new WeakMap();

function detectionState(deps) {
  let st = detectionStates.get(deps);
  if (!st) {
    st = { key: null, result: null, inflight: null };
    detectionStates.set(deps, st);
  }
  return st;
}

async function detectForDeps(deps, refresh) {
  const sm = seams(deps);
  const env = sm.env || process.env;
  const platform = platformOf(deps);
  const up = settingsOf(deps).upscayl || {};
  const key = JSON.stringify([envValue(env, 'SCM_UPSCAYL_BIN', platform) || '', up.binPath || '', platform]);
  const st = detectionState(deps);
  if (!refresh && st.key === key) {
    if (st.result && (!st.result.found || (sm.isFile || isFileSync)(st.result.binPath))) return st.result;
    if (st.inflight) return st.inflight;
  }
  let registry = sm.registry || null;
  if (!registry || typeof registry.queryUninstall !== 'function') registry = registryModule;
  const promise = detectUpscaylBinary({
    env,
    upscayl: up,
    platform,
    isFile: sm.isFile,
    homedir: sm.homedir,
    queryRegistry: () => registry.queryUninstall('Upscayl*', { refresh: !!refresh, timeoutMs: 10000, logger: deps.logger }),
  });
  st.key = key;
  st.result = null;
  st.inflight = promise;
  try {
    const result = await promise;
    if (st.inflight === promise) st.result = result;
    return result;
  } finally {
    if (st.inflight === promise) st.inflight = null;
  }
}

function forgetDetection(deps) {
  detectionStates.delete(deps);
}

/** python-env caches the whole environment status, including the Upscayl part: drop it. */
function invalidateEnvStatus(deps) {
  try {
    const mod = lazy('./python-env');
    if (mod && typeof mod.invalidateEnvCache === 'function') mod.invalidateEnvCache(deps);
  } catch { /* best effort */ }
}

/**
 * @typedef {object} UpscaylStatus
 * @property {boolean} found upscayl-bin was found
 * @property {string|null} binPath
 * @property {string|null} modelsDir settings.upscayl.modelsDir or <bin>/../models
 * @property {string|null} customModelsDir
 * @property {string|null} version from the registry (DisplayVersion / DisplayName)
 * @property {'env'|'settings'|'registry'|'common'|'path'|null} source
 * @property {Array<{ id: string, name: string, description: string, scale: number, custom: boolean,
 *   nonCommercial: boolean, dir: string, bytes: number|null }>} models
 * @property {Array<{ id: number, name: string }>|null} gpus detected GPUs (null = not detected for this binary)
 * @property {string|null} error plain-language problem (null when fine or simply not installed)
 * @property {boolean} ready found and at least one model
 * @property {string|null} effectiveModel model that will actually be used
 * @property {string|null} configuredModel settings.upscayl.model
 * @property {string|null} modelWarning set when the configured model is missing
 * @property {string|null} root install folder
 * @property {string|null} gpusDetectedFor binary the cached GPU list belongs to
 * @property {string} checkedAt ISO time
 */

/**
 * Upscayl status (spec §6 UpscaylStatus + extras). The binary detection is cached per deps for the
 * session (`refresh: true` re-detects, including the registry); models and GPUs are re-read each call.
 * @param {object} deps
 * @param {{ refresh?: boolean }} [opts]
 * @returns {Promise<UpscaylStatus>}
 */
async function getUpscaylStatus(deps, opts = {}) {
  const refresh = !!(opts && opts.refresh);
  const up = settingsOf(deps).upscayl || {};
  const customDir = str(up.customModelsDir) ? path.resolve(up.customModelsDir) : null;
  const base = {
    found: false,
    binPath: null,
    modelsDir: null,
    customModelsDir: customDir,
    version: null,
    source: null,
    models: [],
    gpus: null,
    error: null,
    ready: false,
    effectiveModel: null,
    configuredModel: str(up.model),
    modelWarning: null,
    root: null,
    gpusDetectedFor: str(up.gpusDetectedFor),
    checkedAt: new Date().toISOString(),
  };
  let d;
  try {
    d = await detectForDeps(deps, refresh);
  } catch (err) {
    logTo(deps, 'warn', `detection failed: ${err && err.message}`);
    return { ...base, error: 'Upscayl could not be detected.' };
  }
  if (!d || !d.found) return { ...base, error: d ? d.error : null };
  const platform = platformOf(deps);
  const modelsDir = str(up.modelsDir) ? path.resolve(up.modelsDir) : path.resolve(path.dirname(d.binPath), '..', 'models');
  const models = listModels(modelsDir, customDir, { platform });
  const detectedFor = str(up.gpusDetectedFor);
  const gpus = Array.isArray(up.gpus) && detectedFor && util.samePath(detectedFor, d.binPath)
    ? up.gpus.filter((g) => g && Number.isInteger(g.id) && typeof g.name === 'string').map((g) => ({ id: g.id, name: g.name }))
    : null;
  let error = null;
  if (!models.length) {
    error = `Upscayl was found, but its AI models are missing (looked in "${modelsDir}"). Reinstall Upscayl, or choose a custom models folder.`;
  } else if (customDir && !isDirSync(customDir)) {
    error = `The custom models folder "${customDir}" no longer exists; only Upscayl's own models are available.`;
  }
  const eff = resolveModel({ models }, up.model);
  return {
    ...base,
    found: true,
    binPath: d.binPath,
    modelsDir,
    version: d.version || null,
    source: d.source,
    root: d.root,
    models,
    gpus,
    error,
    ready: models.length > 0,
    effectiveModel: eff ? eff.id : null,
    modelWarning: eff ? eff.warning : null,
  };
}

function findBinaryNear(abs, platform) {
  const p = pathApi(platform);
  const name = exeName(platform);
  const candidates = [];
  if (isFileSync(abs)) {
    const base = p.basename(abs).toLowerCase();
    if (base === name.toLowerCase() || base === 'upscayl-bin') candidates.push(abs);
    // Upscayl.exe (the app itself), or any file inside the install folder
    candidates.push(p.join(p.dirname(abs), 'resources', 'bin', name), p.join(p.dirname(abs), 'bin', name), p.join(p.dirname(abs), name));
  } else {
    candidates.push(
      p.join(abs, 'resources', 'bin', name),
      p.join(abs, 'Contents', 'Resources', 'bin', name),
      p.join(abs, 'bin', name),
      p.join(abs, name),
      p.join(abs, 'Upscayl', 'resources', 'bin', name),
    );
  }
  return candidates.find((c) => isFileSync(c)) || null;
}

/**
 * "Locate…": remember where Upscayl is (protected setting, written with `internal: true`).
 * Accepts upscayl-bin itself, Upscayl.exe, the install folder, its resources or bin folder, or the
 * macOS .app. `null` forgets the location (automatic detection again).
 * @param {object} deps
 * @param {string|null} p absolute path
 * @returns {Promise<UpscaylStatus>}
 */
async function locateUpscayl(deps, p) {
  const platform = platformOf(deps);
  const current = settingsOf(deps).upscayl || {};
  if (p === null || p === undefined || p === '') {
    deps.settings.update({ upscayl: { binPath: null, modelsDir: null } }, { internal: true });
    forgetDetection(deps);
    invalidateEnvStatus(deps);
    return getUpscaylStatus(deps, { refresh: true });
  }
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new TypeError('locateUpscayl: an absolute path is required');
  const abs = path.resolve(p);
  const bin = findBinaryNear(abs, platform);
  if (!bin) {
    throw userError("Upscayl wasn't found there. Choose the folder where Upscayl is installed (it contains Upscayl.exe), or Upscayl.exe itself.", {
      code: 'UPSCAYL_NOT_FOUND',
      details: `Looked around ${abs}`,
    });
  }
  const changed = !(current.binPath && util.samePath(current.binPath, bin));
  const patch = { binPath: bin, modelsDir: null };
  if (changed) Object.assign(patch, { gpus: null, gpusDetectedFor: null });
  deps.settings.update({ upscayl: patch }, { internal: true });
  forgetDetection(deps);
  invalidateEnvStatus(deps);
  logTo(deps, 'info', `Upscayl located at ${bin}`);
  return getUpscaylStatus(deps, { refresh: true });
}

/**
 * Choose (or with `null` forget) a folder of custom NCNN models (`<id>.param` + `<id>.bin`).
 * upscayl-bin only accepts model folders whose path contains the word "models" (lower case).
 * @param {object} deps
 * @param {string|null} dir absolute folder
 * @returns {Promise<UpscaylStatus>}
 */
async function setCustomModelsDir(deps, dir) {
  if (dir === null || dir === undefined || dir === '') {
    deps.settings.update({ upscayl: { customModelsDir: null } }, { internal: true });
    invalidateEnvStatus(deps);
    return getUpscaylStatus(deps, {});
  }
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('setCustomModelsDir: an absolute folder is required');
  const abs = path.resolve(dir);
  if (!isDirSync(abs)) throw userError(`"${abs}" is not a folder.`, { code: 'NOT_A_FOLDER' });
  if (!abs.includes('models')) {
    throw userError('Upscayl only accepts a models folder whose path contains the word "models" in lower case (for example a folder named "models" or "my-models"). Rename the folder and try again.', { code: 'BAD_MODELS_FOLDER' });
  }
  const found = listModels(abs, null, { platform: platformOf(deps) });
  if (!found.length) {
    throw userError('No Upscayl models were found in this folder. A model is a pair of files with the same name: <name>.param and <name>.bin (a folder path that is too long can also hide them).', { code: 'NO_MODELS' });
  }
  deps.settings.update({ upscayl: { customModelsDir: abs } }, { internal: true });
  invalidateEnvStatus(deps);
  logTo(deps, 'info', `custom models folder set to ${abs} (${found.length} models)`);
  return getUpscaylStatus(deps, {});
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

const manifestCache = new Map(); // manifest file -> { data, mtimeMs }
const manifestWriters = new Map(); // manifest file -> util.createJsonWriter()

function emptyManifest() {
  return { version: MANIFEST_VERSION, entries: {} };
}

function sanitizeManifest(raw) {
  const out = emptyManifest();
  if (!raw || typeof raw !== 'object' || !raw.entries || typeof raw.entries !== 'object') return out;
  for (const [destRel, e] of Object.entries(raw.entries)) {
    if (!e || typeof e !== 'object' || typeof e.key !== 'string' || typeof destRel !== 'string') continue;
    const kind = destRel.split('/')[0];
    if (!UPSCALE_KINDS.includes(kind)) continue;
    out.entries[destRel] = {
      key: e.key,
      hash: typeof e.hash === 'string' ? e.hash : null,
      src: typeof e.src === 'string' ? e.src : null,
      kind: typeof e.kind === 'string' ? e.kind : kind,
      scale: Number.isFinite(e.scale) ? e.scale : null,
      at: typeof e.at === 'string' ? e.at : null,
    };
  }
  return out;
}

function manifestPath(deps) {
  return path.join(deps.getPaths().upscaledRoot, MANIFEST_FILE);
}

/** Current manifest data (read from disk when it changed; never mutate the returned object). */
function readManifestData(deps) {
  const file = manifestPath(deps);
  const cached = manifestCache.get(file);
  const writer = manifestWriters.get(file);
  if (cached && writer && writer.pending()) return cached.data; // our own write in flight: memory is the truth
  const mtime = fileMtime(file);
  if (cached && mtime !== null && cached.mtimeMs === mtime) return cached.data;
  const data = sanitizeManifest(util.readJson(file, null));
  manifestCache.set(file, { data, mtimeMs: mtime });
  return data;
}

/** Replace the manifest (atomic write through the shared JSON writer; resolves once on disk). */
async function writeManifestData(deps, data) {
  const file = manifestPath(deps);
  manifestCache.set(file, { data, mtimeMs: null });
  let writer = manifestWriters.get(file);
  if (!writer) {
    writer = util.createJsonWriter(file, { debounceMs: 50, onError: (err) => logTo(deps, 'warn', `manifest write failed: ${err && err.message}`) });
    manifestWriters.set(file, writer);
    if (typeof deps.addShutdownHook === 'function') {
      const w = writer;
      deps.addShutdownHook(() => w.flush());
    }
  }
  writer.write(data);
  await writer.flush();
  const entry = manifestCache.get(file);
  if (entry && entry.data === data) entry.mtimeMs = fileMtime(file);
}

/**
 * The upscale manifest with only the entries whose upscaled file still exists (synchronous; safe
 * to `await`). Shape: `{ version: 2, entries: { [destRel]: { key, hash, src, kind, scale, at } } }`.
 * @param {object} deps
 * @returns {{ version: number, entries: Record<string, { key: string, hash: string|null, src: string|null,
 *   kind: string, scale: number|null, at: string|null }> }}
 */
function loadManifest(deps) {
  const data = readManifestData(deps);
  const root = deps.getPaths().upscaledRoot;
  const entries = {};
  for (const [destRel, e] of Object.entries(data.entries)) {
    let abs;
    try {
      abs = util.resolveInside(root, destRel);
    } catch {
      continue;
    }
    if (isFileSync(abs)) entries[destRel] = { ...e };
  }
  return { version: MANIFEST_VERSION, entries };
}

const manifestIndexes = new WeakMap();

function manifestIndex(manifest) {
  let idx = manifestIndexes.get(manifest);
  if (!idx) {
    idx = new Map();
    for (const [destRel, e] of Object.entries(manifest.entries)) {
      if (!e || typeof e !== 'object' || typeof e.src !== 'string') continue;
      const k = `${e.kind || destRel.split('/')[0]}\u0000${e.src}`;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ destRel, entry: e });
    }
    manifestIndexes.set(manifest, idx);
  }
  return idx;
}

/**
 * True when an up-to-date upscaled copy exists for a card (CardImage.upscaled, spec §9.5).
 *
 * Usage (cards.js):
 * ```js
 * const manifest = upscayl.loadManifest(deps);    // sync (await is harmless)
 * const keyFn = upscayl.settingsKeyFn(deps);      // sync; or: await upscayl.createKeyFn(deps)
 * image.upscaled = upscayl.isCardUpscaled(manifest, keyFn, { ...scanItem, kind });
 * ```
 * `keyFn(item)` returns the cache key the current settings would produce (null = the card is
 * already sharp / cannot be upscaled → false). Without a keyFn, a manifest entry for (kind, rel)
 * with the same source hash counts as upscaled.
 *
 * @param {{ entries: object }} manifest from loadManifest()
 * @param {((item: object) => string|null)|null} keyFn from settingsKeyFn() / createKeyFn()
 * @param {{ kind?: string, rel: string, hash?: string|null, width?: number|null, height?: number|null,
 *   type?: string|null, relNoExt?: string }} item card (CardImage/ScanItem) + kind
 * @param {string} [kind] kind, when the item has none
 * @returns {boolean}
 */
function isCardUpscaled(manifest, keyFn, item, kind) {
  if (!manifest || typeof manifest !== 'object' || !manifest.entries || typeof manifest.entries !== 'object') return false;
  if (!item || typeof item !== 'object' || typeof item.rel !== 'string') return false;
  const k = item.kind || kind;
  if (!k) return false;
  const candidates = manifestIndex(manifest).get(`${k}\u0000${item.rel}`);
  if (!candidates || !candidates.length) return false;
  if (typeof keyFn === 'function') {
    let expected;
    try {
      expected = keyFn(item.kind ? item : { ...item, kind: k });
    } catch {
      return false;
    }
    return typeof expected === 'string' && candidates.some((c) => keyMatches(c.entry.key, expected));
  }
  return candidates.some((c) => !item.hash || c.entry.hash === item.hash);
}

// ---------------------------------------------------------------------------------------------
// Card dimensions, kinds and back resolution
// ---------------------------------------------------------------------------------------------

function findLayout(intro, o) {
  const layouts = intro && intro.layouts;
  if (!layouts) return null;
  if (o.specialty) {
    const name = String(o.specialty);
    return (layouts.specialty || []).find((s) => s && (s.name === name || s.key === name || s.key === `specialty:${name}`)) || null;
  }
  const aliases = layouts.aliases || {};
  const card = (aliases.card && aliases.card[o.card_size]) || o.card_size;
  const paper = (aliases.paper && aliases.paper[o.paper_size]) || o.paper_size;
  const variant = o.borderless ? 'borderless' : 'default';
  const combos = Array.isArray(layouts.combos) ? layouts.combos : [];
  return combos.find((c) => c && c.key === `${paper}|${card}|${variant}`)
    || combos.find((c) => c && c.paper === paper && c.card === card)
    || null;
}

function findCardSize(intro, name) {
  const layouts = intro && intro.layouts;
  if (!layouts || !Array.isArray(layouts.cardSizes)) return null;
  const aliases = (layouts.aliases && layouts.aliases.card) || {};
  const canonical = aliases[name] || name;
  return layouts.cardSizes.find((c) => c && c.name === canonical) || null;
}

function dimsFromIntrospection(intro, o) {
  const layout = intro ? findLayout(intro, o) : null;
  if (layout && posNum(layout.cardWidthMm)) {
    return { widthIn: layout.cardWidthMm / 25.4, heightIn: posNum(layout.cardHeightMm) ? layout.cardHeightMm / 25.4 : null, source: 'layout', layoutKey: layout.key || null };
  }
  const size = intro ? findCardSize(intro, o.card_size) : null;
  if (size && posNum(size.widthMm)) {
    return { widthIn: size.widthMm / 25.4, heightIn: posNum(size.heightMm) ? size.heightMm / 25.4 : null, source: 'card-size', layoutKey: null };
  }
  return null;
}

const DEFAULT_DIMS = Object.freeze({ widthIn: DEFAULT_CARD_WIDTH_MM / 25.4, heightIn: DEFAULT_CARD_HEIGHT_MM / 25.4, source: 'default', layoutKey: null });
const cardDimsMemo = new Map(); // workspace|card|paper|borderless|specialty -> dims (last introspection result)
let introspectionFileMemo = { file: null, mtimeMs: null, data: null };

function cardDimsKey(deps, o) {
  let ws = '';
  try {
    ws = deps.getPaths().workspaceDir;
  } catch { /* no paths */ }
  return JSON.stringify([ws, o.card_size || null, o.paper_size || null, !!o.borderless, o.specialty || null]);
}

/**
 * Card size (inches) of the current PDF layout: introspection layout (alias-resolved, specialty
 * aware), else the card size table, else the standard 63 × 88 mm card.
 * @param {object} deps
 * @param {object} [pdfOptions] settings.pdf.options-like object
 * @returns {Promise<{ widthIn: number, heightIn: number|null, source: 'layout'|'card-size'|'default', layoutKey: string|null }>}
 */
async function cardDimsFor(deps, pdfOptions) {
  const o = pdfOptions && typeof pdfOptions === 'object' ? pdfOptions : {};
  let intro = null;
  if (deps.helper && typeof deps.helper.introspect === 'function') {
    try {
      intro = await deps.helper.introspect({});
    } catch (err) {
      logTo(deps, 'info', `card size from defaults (introspection unavailable: ${err && err.message})`);
    }
  }
  const dims = dimsFromIntrospection(intro, o);
  if (dims) {
    cardDimsMemo.set(cardDimsKey(deps, o), dims);
    return dims;
  }
  return { ...DEFAULT_DIMS };
}

/** Synchronous card size: last cardDimsFor() result, else the helper's introspection cache file, else 63 mm. */
function cardDimsSync(deps, o) {
  const memo = cardDimsMemo.get(cardDimsKey(deps, o));
  if (memo) return memo;
  try {
    const file = path.join(deps.getPaths().scmCacheDir, 'introspection.json');
    const mtime = fileMtime(file);
    if (mtime === null) return DEFAULT_DIMS;
    if (introspectionFileMemo.file !== file || introspectionFileMemo.mtimeMs !== mtime) {
      const cached = util.readJson(file, null);
      introspectionFileMemo = { file, mtimeMs: mtime, data: cached && cached.data && cached.data.layouts ? cached.data : null };
    }
    return dimsFromIntrospection(introspectionFileMemo.data, o) || DEFAULT_DIMS;
  } catch {
    return DEFAULT_DIMS;
  }
}

function clampPpi(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 2400 ? n : 300;
}

function normalizeKinds(kinds) {
  if (kinds === undefined || kinds === null) return ['front'];
  const list = Array.isArray(kinds) ? kinds : [kinds];
  return UPSCALE_KINDS.filter((k) => list.includes(k));
}

function normalizeTargets(targets) {
  const t = targets && typeof targets === 'object' ? targets : {};
  return { front: t.front === true, back: t.back === true, double_sided: t.double_sided === true };
}

async function resolveBackLocal(deps) {
  const s = settingsOf(deps);
  const back = (s.cards && s.cards.back) || { mode: 'auto' };
  const dir = deps.getPaths().gameDir('back');
  if (back.mode === 'none') return null;
  if (back.mode === 'file') {
    if (!str(back.file)) return null;
    try {
      const abs = util.resolveInside(dir, back.file);
      return isFileSync(abs) ? { abs, rel: util.toPosix(back.file) } : null;
    } catch {
      return null;
    }
  }
  const res = await scanDir(dir, { hash: false, sizes: false });
  return res.images.length === 1 ? { abs: res.images[0].abs, rel: res.images[0].rel } : null;
}

/** The common back image to upscale: cards.resolveBack when available, else the §9.5 rules. */
async function resolveBackSafe(deps) {
  const cards = lazy('./cards');
  if (cards && typeof cards.resolveBack === 'function') {
    try {
      const r = await cards.resolveBack(deps);
      if (!r || typeof r !== 'object') return null;
      const dir = deps.getPaths().gameDir('back');
      if (typeof r.abs === 'string' && r.abs && isFileSync(r.abs)) {
        return { abs: r.abs, rel: util.isInside(dir, r.abs) ? util.toPosix(path.relative(dir, r.abs)) : null };
      }
      if (typeof r.file === 'string' && r.file) {
        try {
          const abs = util.resolveInside(dir, r.file);
          if (isFileSync(abs)) return { abs, rel: util.toPosix(r.file) };
        } catch { /* invalid */ }
      }
      return null;
    } catch (err) {
      logTo(deps, 'warn', `cards.resolveBack failed (${err && err.message}); using the default back rules`);
    }
  }
  return resolveBackLocal(deps);
}

/**
 * Kinds to upscale for "Upscale now" (spec §9.7): from the targets; the common back only when a
 * back image is resolved.
 * @param {object} deps
 * @param {{ front?: boolean, back?: boolean, double_sided?: boolean }} targets
 * @returns {Promise<{ kinds: string[], backFile: string|null }>}
 */
async function kindsFromTargets(deps, targets) {
  const t = normalizeTargets(targets);
  const kinds = [];
  let backFile = null;
  if (t.front) kinds.push('front');
  if (t.back) {
    const back = await resolveBackSafe(deps);
    if (back && back.abs) {
      kinds.push('back');
      backFile = back.abs;
    }
  }
  if (t.double_sided) kinds.push('double_sided');
  return { kinds, backFile };
}

/**
 * Sources for the given kinds (ScanItem + kind), with sha1 hashes (deps.hashCache).
 * `incomplete` (optional Set) receives the kinds whose scan was incomplete (read errors, truncated),
 * so their upscaled copies are not pruned as stale.
 */
async function collectItems(deps, kinds, onlyBackFile, log, incomplete) {
  const paths = deps.getPaths();
  const items = [];
  for (const kind of kinds) {
    const dir = paths.gameDir(kind);
    let res;
    try {
      res = await scanDir(dir, { hash: true, hashCache: deps.hashCache || undefined });
    } catch (err) {
      if (log) log(`Could not read the ${kind} images: ${err && err.message}`, 'warn');
      if (incomplete) incomplete.add(kind);
      continue;
    }
    if (incomplete && ((res.errors && res.errors.length) || res.truncated)) incomplete.add(kind);
    if (log && res.errors && res.errors.length) log(`Some ${kind} files could not be read: ${res.errors.slice(0, 5).map((e) => e.rel).join(', ')}`, 'warn');
    let images = res.images;
    if (kind === 'back') {
      let wantRel = null;
      if (typeof onlyBackFile === 'string' && onlyBackFile) {
        if (path.isAbsolute(onlyBackFile)) {
          if (util.isInside(dir, onlyBackFile)) wantRel = util.toPosix(path.relative(dir, onlyBackFile));
        } else {
          wantRel = util.toPosix(onlyBackFile);
        }
      } else {
        const back = await resolveBackSafe(deps);
        wantRel = back ? back.rel : null;
      }
      images = wantRel ? images.filter((img) => img.rel === wantRel || fold(img.rel) === fold(wantRel)).slice(0, 1) : [];
    }
    for (const img of images) {
      items.push({
        kind,
        rel: img.rel,
        relNoExt: img.relNoExt,
        abs: img.abs,
        name: img.name,
        ext: img.ext,
        hash: img.hash || null,
        type: img.type,
        width: img.width,
        height: img.height,
        size: img.size,
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------------------------

async function listFilesRecursive(dir) {
  const out = [];
  const walk = async (abs, rel) => {
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childAbs, childRel);
      else if (e.isFile() || e.isSymbolicLink()) out.push({ rel: childRel, abs: childAbs });
    }
  };
  await walk(dir, '');
  return out;
}

/** Files under game/upscaled/<kind> for the given kinds, as 'kind/rel' (posix). */
async function listUpscaledFiles(upscaledRoot, kinds) {
  const out = [];
  for (const kind of kinds) {
    for (const f of await listFilesRecursive(path.join(upscaledRoot, kind))) out.push(`${kind}/${f.rel}`);
  }
  return out;
}

async function removeEmptyDirs(dir, keepSelf) {
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name), false);
  }
  if (keepSelf) return;
  try {
    if ((await fsp.readdir(dir)).length === 0) await fsp.rmdir(dir);
  } catch { /* in use or not empty */ }
}

/** Delete files of the processed kinds that are not in `keep` (folded 'kind/rel'); returns the count. */
async function pruneStale(upscaledRoot, kinds, keep) {
  let removed = 0;
  for (const kind of kinds) {
    const kindDir = path.join(upscaledRoot, kind);
    for (const f of await listFilesRecursive(kindDir)) {
      if (keep.has(fold(`${kind}/${f.rel}`))) continue;
      try {
        await fsp.rm(f.abs, { force: true, maxRetries: 3, retryDelay: 100 });
        removed += 1;
      } catch { /* locked: removed next time */ }
    }
    await removeEmptyDirs(kindDir, true);
  }
  return removed;
}

async function dirStats(dir, { skipTopLevel = [] } = {}) {
  let files = 0;
  let bytes = 0;
  const skip = new Set(skipTopLevel.map(fold));
  const walk = async (abs, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (depth === 0 && skip.has(fold(e.name))) continue;
      const child = path.join(abs, e.name);
      if (e.isDirectory()) {
        await walk(child, depth + 1);
      } else {
        try {
          const st = await fsp.stat(child);
          if (st.isFile()) {
            files += 1;
            bytes += st.size;
          }
        } catch { /* vanished */ }
      }
    }
  };
  await walk(dir, 0);
  return { files, bytes };
}

async function removeStaging(upscaledRoot, stagingDir) {
  await fsp.rm(stagingDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  const parent = path.join(upscaledRoot, STAGING_DIR);
  try {
    if ((await fsp.readdir(parent)).length === 0) await fsp.rmdir(parent);
  } catch { /* other job leftovers or missing */ }
}

/**
 * Put `src` at `dest` (hardlink, fallback copy; `link: false` always copies). The destination is
 * removed first with retries (an image viewer or the antivirus may hold it briefly).
 */
async function placeFile(src, dest, { link = true } = {}) {
  await fsp.rm(dest, { force: true, maxRetries: 5, retryDelay: 100 });
  return util.copyOrLink(src, dest, { link });
}

// ---------------------------------------------------------------------------------------------
// Running upscayl-bin and the helper
// ---------------------------------------------------------------------------------------------

/**
 * Run upscayl-bin once inside a job. Never throws for Upscayl failures (only for cancellation).
 * @returns {Promise<{ ok: boolean, code: number|null, vkFailure: boolean, errorLine: string|null,
 *   stderrTail: string[], timedOut: boolean, startFailed: boolean, message?: string, durationMs: number }>}
 */
async function runUpscayl(ctx, binPath, args, { timeoutMs, onLine } = {}) {
  let vk = false;
  let errorLine = null;
  const started = Date.now();
  try {
    const res = await ctx.spawn(binPath, args, {
      cwd: path.dirname(binPath),
      allowNonZero: true,
      timeoutMs,
      name: 'Upscayl',
      onLine: (line, stream) => {
        if (VK_FAILURE_RE.test(line)) vk = true;
        if (!errorLine && ERROR_LINE_RE.test(line)) errorLine = line.replace(/^[^\w[(]+/u, '').trim().slice(0, 300);
        if (onLine) onLine(line, stream);
      },
    });
    const code = typeof res.code === 'number' ? res.code : null;
    const stderrTail = Array.isArray(res.stderrTail) ? res.stderrTail : [];
    if (!vk && stderrTail.some((l) => VK_FAILURE_RE.test(l))) vk = true;
    return { ok: code === 0 && !vk, code, vkFailure: vk, errorLine, stderrTail, timedOut: false, startFailed: false, durationMs: Date.now() - started };
  } catch (err) {
    if (isCancelled(err)) throw err;
    const base = { ok: false, code: null, vkFailure: vk, errorLine, stderrTail: [], message: (err && err.message) || 'Upscayl failed.', durationMs: Date.now() - started };
    if (err && err.code === 'TIMEOUT') return { ...base, timedOut: true, startFailed: false };
    if (err && (err.code === 'START_FAILED' || err.code === 'START_BLOCKED')) return { ...base, timedOut: false, startFailed: true };
    return { ...base, timedOut: false, startFailed: false };
  }
}

function describeRunFailure(res, outputExists) {
  if (res.startFailed) return res.message || 'Upscayl could not start';
  if (res.timedOut) return 'Upscayl took too long';
  if (res.vkFailure) return `graphics card error${res.errorLine ? ` (${res.errorLine})` : ''}`;
  if (res.code !== 0) return `Upscayl stopped with code ${res.code}${res.errorLine ? ` (${res.errorLine})` : ''}`;
  if (!outputExists) return `Upscayl wrote no image${res.errorLine ? ` (${res.errorLine})` : ''}`;
  return 'unknown problem';
}

function helperLogger(ctx) {
  return (line) => {
    if (typeof line === 'string' && line.trim()) ctx.log(line, 'stderr');
  };
}

/** helper prepare-upscale for a list of { id, src, dest }. Returns Map(id → result). Throws only on cancel. */
async function helperPrepare(ctx, deps, list) {
  const out = new Map();
  if (!list.length) return out;
  ctx.throwIfCancelled();
  let res;
  try {
    res = await deps.helper.run('prepare-upscale', [], {
      list: { items: list.map((c) => ({ src: c.src, dest: c.dest })) },
      signal: ctx.signal,
      timeoutMs: 60000 + list.length * 20000,
      onLine: helperLogger(ctx),
    });
  } catch (err) {
    if (isCancelled(err) || ctx.cancelled) throw isCancelled(err) ? err : cancelledFrom(err);
    ctx.log(`Could not prepare images for upscaling: ${err && err.message}`, 'warn');
    if (err && err.details) ctx.log(String(err.details), 'warn');
    for (const c of list) out.set(c.id, { ok: false, error: (err && err.message) || 'helper failed' });
    return out;
  }
  const results = Array.isArray(res && res.results) ? res.results : [];
  list.forEach((c, j) => {
    const r = results[j];
    out.set(c.id, r && typeof r === 'object' ? r : { ok: false, error: 'no result' });
  });
  return out;
}

/** helper validate-images for groups with outPath/normWidth/normHeight/scale/refMean/refStd. Map(id → verdict). */
async function helperValidate(ctx, deps, groups) {
  const out = new Map();
  if (!groups.length) return out;
  ctx.throwIfCancelled();
  let res;
  try {
    res = await deps.helper.run('validate-images', [], {
      list: {
        items: groups.map((g) => ({
          path: g.outPath,
          expectWidth: g.normWidth * g.runScale,
          expectHeight: g.normHeight * g.runScale,
          refMean: g.refMean,
          refStd: g.refStd,
        })),
      },
      signal: ctx.signal,
      timeoutMs: 60000 + groups.length * 30000,
      onLine: helperLogger(ctx),
    });
  } catch (err) {
    if (isCancelled(err) || ctx.cancelled) throw isCancelled(err) ? err : cancelledFrom(err);
    ctx.log(`Could not check the upscaled images: ${err && err.message}`, 'warn');
    if (err && err.details) ctx.log(String(err.details), 'warn');
    for (const g of groups) out.set(g.id, { ok: false, reason: 'could not be checked' });
    return out;
  }
  const results = Array.isArray(res && res.results) ? res.results : [];
  groups.forEach((g, j) => {
    const r = results[j];
    out.set(g.id, r && r.ok === true
      ? { ok: true, width: r.width, height: r.height }
      : { ok: false, reason: (r && r.reason) || 'could not be checked' });
  });
  return out;
}

function cancelledFrom(err) {
  const e = new Error('Cancelled');
  e.name = 'CancelledError';
  e.code = 'CANCELLED';
  e.cause = err;
  return e;
}

function effectiveGpu(up, status, ctx) {
  const gpu = up.gpuId;
  if (gpu === null) return null;
  if (Array.isArray(status.gpus) && status.gpus.length) {
    const ids = gpu.split(',').map(Number);
    if (!ids.every((id) => status.gpus.some((g) => g.id === id))) {
      if (ctx) ctx.warn(`The selected graphics card (#${gpu}) wasn't found, so Upscayl chose one automatically. Pick another card in Upscale.`);
      return null;
    }
  }
  return gpu;
}

/**
 * Progress of the upscaling phase: `percent` = finished unique images (+ the running one) / total.
 * Phases that are not upscaling keep the percentage and only change the label.
 */
function createProgress(ctx, total) {
  let done = 0;
  let lastPercent = 0;
  const emit = (finishedExtra, fraction, label) => {
    const current = Math.min(total, done + finishedExtra);
    const partial = current < total ? Math.min(0.99, Math.max(0, fraction || 0)) : 0;
    const percent = total > 0 ? Math.min(100, ((current + partial) / total) * 100) : null;
    if (percent !== null) lastPercent = Math.max(lastPercent, percent);
    ctx.progress({ percent: total > 0 ? lastPercent : null, current, total, label });
  };
  return {
    total,
    get done() { return done; },
    finish(n) {
      done = Math.min(total, done + n);
      emit(0, 0, `Upscaled ${done} of ${plural(total, 'image', 'images')}`);
    },
    upscaling(finishedInBatch, fraction) {
      const shown = Math.min(total, done + finishedInBatch + 1);
      emit(finishedInBatch, fraction, `Upscaling ${shown} of ${plural(total, 'image', 'images')}`);
    },
    label(text) {
      ctx.progress({ percent: total > 0 ? lastPercent : null, current: done, total, label: text });
    },
  };
}

/** One dir-mode upscayl-bin run with progress from the output folder (polled) and % lines. */
async function runBatch(ctx, binPath, args, { outDir, outExt, count, progress, timeoutMs }) {
  let finished = 0;
  let fraction = 0;
  let polling = false;
  const ext = `.${outExt}`;
  progress.upscaling(0, 0);
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    fsp.readdir(outDir)
      .then((names) => {
        const n = Math.min(count, names.filter((name) => name.toLowerCase().endsWith(ext)).length);
        if (n !== finished) {
          finished = n;
          fraction = 0;
          progress.upscaling(finished, 0);
        }
      })
      .catch(() => {})
      .finally(() => { polling = false; });
  }, 500);
  try {
    return await runUpscayl(ctx, binPath, args, {
      timeoutMs,
      onLine: (line) => {
        const pct = parsePercent(line);
        if (pct !== null && finished < count) {
          // With several images in flight the % lines interleave: only move forward.
          const next = pct / 100;
          if (next > fraction) {
            fraction = next;
            progress.upscaling(finished, fraction);
          }
        }
      },
    });
  } finally {
    clearInterval(timer);
  }
}

function inPath(chunkDir, g, scale) {
  return path.join(chunkDir, `in_${g.outExt}_s${scale}`, `${g.fileId}.png`);
}

function outPath(chunkDir, g, scale) {
  return path.join(chunkDir, `out_${g.outExt}_s${scale}`, `${g.fileId}.${g.outExt}`);
}

/**
 * Normalize, upscale (dir mode), validate and retry one chunk of unique images.
 * Sets `env.outcomes` for every group of the chunk:
 * `{ ok: true, outPath, scale, retried? }` | `{ ok: false, stage: 'prepare'|'upscayl', reason }` | `{ sharp: true }`.
 */
async function processChunk(ctx, deps, env, chunk, chunkDir) {
  const { up, model, status, progress, stats, outcomes } = env;

  // 1. Normalize (EXIF rotation, RGB, PNG) into in_<ext>_s<planned scale>/<id>.png
  progress.label(`Preparing ${plural(chunk.length, 'image', 'images')} for Upscayl…`);
  const prepared = await helperPrepare(ctx, deps, chunk.map((g) => ({ id: g.id, src: g.src, dest: inPath(chunkDir, g, g.scale) })));
  const runnable = [];
  for (const g of chunk) {
    const r = prepared.get(g.id);
    if (!r || !r.ok || !posInt(r.width) || !posInt(r.height)) {
      outcomes.set(g.id, { ok: false, stage: 'prepare', reason: (r && r.error) || 'could not be opened' });
      continue;
    }
    g.normWidth = r.width;
    g.normHeight = r.height;
    g.refMean = r.mean;
    g.refStd = r.std;
    // Known header size: keep the planned scale (only the pixel cap may lower it). Unknown size: choose now.
    let scale;
    if (g.dimsKnown) {
      scale = capScale(g.scale, r.width, r.height);
    } else {
      const choice = chooseScale({ width: r.width, height: r.height, cardWidthIn: env.cardWidthIn, targetPpi: env.targetPpi, maxScale: up.scale, smart: up.smartScale });
      scale = choice.action === 'upscale' ? choice.scale : null;
    }
    if (scale === null) {
      outcomes.set(g.id, { ok: false, sharp: true, reason: 'sharp' });
      await fsp.rm(inPath(chunkDir, g, g.scale), { force: true }).catch(() => {});
      continue;
    }
    if (scale !== g.scale) await util.moveFile(inPath(chunkDir, g, g.scale), inPath(chunkDir, g, scale));
    g.runScale = scale;
    g.outPath = outPath(chunkDir, g, scale);
    runnable.push(g);
  }
  ctx.throwIfCancelled();
  if (!runnable.length) return;
  stats.attempted += runnable.length;

  // 2. One dir-mode run per (output format, scale)
  const gpuId = env.gpuId;
  const common = {
    modelsDir: model.dir, model: model.id, modelScale: model.scale, compression: up.compression,
    tileSize: up.tileSize, gpuId, threads: up.threads, tta: up.tta,
  };
  const batches = new Map();
  for (const g of runnable) {
    const k = `${g.outExt}|${g.runScale}`;
    if (!batches.has(k)) batches.set(k, []);
    batches.get(k).push(g);
  }
  let finishedBefore = 0;
  for (const list of batches.values()) {
    ctx.throwIfCancelled();
    const { outExt, runScale } = list[0];
    const inDir = path.dirname(inPath(chunkDir, list[0], runScale));
    const outDir = path.dirname(list[0].outPath);
    await fsp.mkdir(outDir, { recursive: true });
    const args = buildUpscaylArgs({ ...common, input: inDir, output: outDir, scale: runScale, format: outExt });
    const perImage = up.tta ? PER_IMAGE_TIMEOUT_TTA_MS : PER_IMAGE_TIMEOUT_MS;
    const batchProgress = {
      upscaling: (finished, fraction) => progress.upscaling(finishedBefore + finished, fraction),
    };
    const res = await runBatch(ctx, status.binPath, args, {
      outDir, outExt, count: list.length, progress: batchProgress, timeoutMs: BATCH_BASE_TIMEOUT_MS + perImage * list.length,
    });
    finishedBefore += list.length;
    if (res.vkFailure) stats.vkSeen = true;
    if (res.startFailed) {
      stats.startFailed = true;
      env.tripped = true;
      env.trippedReason = res.message || 'Could not start Upscayl.';
      ctx.warn(`${env.trippedReason.replace(/\.$/, '')}, so your original images are used.`);
      for (const g of runnable) if (!outcomes.has(g.id)) outcomes.set(g.id, { ok: false, stage: 'upscayl', reason: env.trippedReason });
      return;
    }
    stats.dirModeMs += res.durationMs;
    stats.dirModeImages += list.length;
    if (res.timedOut) ctx.log('Upscayl took too long on a batch; unfinished images are tried again one at a time.', 'warn');
    else if (res.code !== 0) ctx.log(`Upscayl stopped with code ${res.code}${res.errorLine ? ` (${res.errorLine})` : ''}; failed images are tried again one at a time.`, 'warn');
  }

  // 3. Validate every output
  progress.label('Checking the upscaled images…');
  const present = [];
  const failed = [];
  for (const g of runnable) {
    if (await isFile(g.outPath)) present.push(g);
    else failed.push({ g, reason: 'Upscayl wrote no image' });
  }
  const verdicts = await helperValidate(ctx, deps, present);
  for (const g of present) {
    const v = verdicts.get(g.id);
    if (v && v.ok) outcomes.set(g.id, { ok: true, outPath: g.outPath, scale: g.runScale });
    else failed.push({ g, reason: (v && v.reason) || 'could not be checked' });
  }
  stats.firstPassFailures += failed.length;

  // 4. Retry failures one at a time (circuit breaker on systematic failures)
  const toCheck = [];
  if (failed.length && !env.tripped) ctx.log(`${plural(failed.length, 'image needs', 'images need')} another try, one at a time.`, 'warn');
  for (let i = 0; i < failed.length; i += 1) {
    const { g, reason } = failed[i];
    ctx.throwIfCancelled();
    if (env.tripped) {
      outcomes.set(g.id, { ok: false, stage: 'upscayl', reason: `not tried again (${env.trippedReason || 'repeated errors'})` });
      continue;
    }
    stats.retried += 1;
    ctx.log(`Retrying ${g.items[0].name} alone (${reason}).`);
    progress.label(`Trying again: ${g.items[0].name}`);
    await fsp.rm(g.outPath, { force: true }).catch(() => {});
    const res = await runUpscayl(ctx, status.binPath, buildUpscaylArgs({
      ...common, input: inPath(chunkDir, g, g.runScale), output: g.outPath, scale: g.runScale, format: g.outExt,
    }), { timeoutMs: up.tta ? SINGLE_TIMEOUT_TTA_MS : SINGLE_TIMEOUT_MS });
    if (res.vkFailure) stats.vkSeen = true;
    const exists = !res.startFailed && await isFile(g.outPath);
    if (res.startFailed || res.timedOut || res.code !== 0 || !exists || res.vkFailure) {
      const why = describeRunFailure(res, exists);
      ctx.log(`Upscayl could not upscale ${g.items[0].name}: ${why}.`, 'warn');
      outcomes.set(g.id, { ok: false, stage: 'upscayl', reason: why });
      // Systematic = GPU errors, the same error text again and again, or Upscayl not starting.
      const signature = res.vkFailure ? 'vk' : res.startFailed ? 'start' : (res.errorLine || null);
      if (signature && signature === env.lastFailureSignature) env.consecutiveFailures += 1;
      else env.consecutiveFailures = signature ? 1 : 0;
      env.lastFailureSignature = signature;
      if (res.startFailed) stats.startFailed = true;
      if (res.startFailed || env.consecutiveFailures >= RETRY_BREAKER) {
        env.tripped = true;
        env.trippedReason = res.startFailed ? (res.message || 'Upscayl could not start') : res.vkFailure ? 'graphics card errors' : 'the same error again and again';
        ctx.warn(res.startFailed
          ? `${(res.message || 'Could not start Upscayl.').replace(/\.$/, '')}, so the remaining images were not upscaled.`
          : res.vkFailure
            ? "Upscayl couldn't use your graphics card, so the remaining images were not upscaled. Try another graphics card or model in Upscale, or update your graphics driver."
            : `Upscayl failed again and again (${why}), so the remaining images were not upscaled.`);
      }
    } else {
      env.consecutiveFailures = 0;
      env.lastFailureSignature = null;
      toCheck.push(g);
    }
  }
  if (toCheck.length) {
    progress.label('Checking the retried images…');
    const second = await helperValidate(ctx, deps, toCheck);
    for (const g of toCheck) {
      const v = second.get(g.id);
      outcomes.set(g.id, v && v.ok
        ? { ok: true, outPath: g.outPath, scale: g.runScale, retried: true }
        : { ok: false, stage: 'upscayl', reason: (v && v.reason) || 'could not be checked' });
    }
  }
}

/**
 * Hardlink the validated outputs of a chunk into game/upscaled and record them in `entries`.
 * Never throws (a file that cannot be placed falls back to its original later).
 * Returns the number of files placed.
 */
async function distributeChunk(ctx, env, chunk) {
  const { outcomes, entries, upscaledRoot, placed } = env;
  const at = new Date().toISOString();
  let n = 0;
  for (const g of chunk) {
    const oc = outcomes.get(g.id);
    if (!oc || !oc.ok) continue;
    let anyPlaced = false;
    for (const it of g.items) {
      try {
        const dest = util.resolveInside(upscaledRoot, it.destRel);
        await placeFile(oc.outPath, dest);
        entries[it.destRel] = { key: it.key, hash: it.hash, src: it.rel, kind: it.kind, scale: oc.scale, at };
        placed.set(it, dest);
        anyPlaced = true;
        n += 1;
      } catch (err) {
        ctx.log(`Could not save the upscaled copy of ${it.name}: ${err && err.message}`, 'warn');
      }
    }
    if (!anyPlaced) outcomes.set(g.id, { ok: false, stage: 'save', reason: 'could not be saved' });
  }
  return n;
}

function fallbackWarnings(ctx, names) {
  if (!names.length) return;
  if (names.length <= 5) {
    for (const name of names) ctx.warn(`Could not upscale ${name}; the original image will be used.`);
    return;
  }
  const shown = names.slice(0, 3).join(', ');
  ctx.warn(`Could not upscale ${names.length} images (${shown} and ${names.length - 3} more); the original images will be used.`);
}

function emptyResult(kinds, targetPpi) {
  const files = {};
  for (const k of kinds) files[k] = {};
  return {
    total: 0,
    unique: 0,
    upscaled: 0,
    cached: 0,
    sharp: 0,
    fallbacks: 0,
    skipped: 0,
    uniqueUpscaled: 0,
    uniqueFailed: 0,
    unreadable: 0,
    retried: 0,
    staleRemoved: 0,
    durationMs: 0,
    kinds: kinds.slice(),
    targetPpi,
    model: null,
    disabledUpscaling: false,
    secPerImage: null,
    files,
  };
}

/**
 * @typedef {object} UpscaleResult
 * @property {number} total source images looked at
 * @property {number} unique unique images that needed Upscayl (identical copies count once)
 * @property {number} upscaled images newly upscaled (copies included)
 * @property {number} cached images whose upscaled copy was already up to date
 * @property {number} sharp images already sharp enough (or too large): the original is used
 * @property {number} fallbacks images that could not be upscaled: the original bytes are used
 * @property {number} skipped images not upscaled (Upscayl missing, name collision, unreadable)
 * @property {number} uniqueUpscaled unique images upscaled successfully
 * @property {number} uniqueFailed unique images Upscayl failed on (after retries)
 * @property {number} unreadable unique images Pillow could not open (not sent to Upscayl)
 * @property {number} retried unique images retried one by one
 * @property {number} staleRemoved outdated files deleted from game/upscaled
 * @property {number} durationMs
 * @property {string[]} kinds
 * @property {number} targetPpi
 * @property {string|null} model model used
 * @property {boolean} disabledUpscaling upscaling was switched off (too many failures)
 * @property {number|null} secPerImage new moving average (seconds per image)
 * @property {Record<string, Record<string, string>>} files kind → rel → absolute file the PDF must use
 */

/**
 * Upscale the card images of `kinds` (spec §9.7 steps 1–9). Callable inside any job (the PDF job
 * uses `files`). Upscayl problems never throw: failing images fall back to their originals (with
 * warnings); only cancellation (CancelledError) and unexpected programming/file-system errors do.
 * Chunks finished before a cancellation stay upscaled and recorded in the manifest.
 *
 * @param {object} ctx job context (jobs.js)
 * @param {object} deps
 * @param {object} [opts]
 * @param {string[]} [opts.kinds=['front']] subset of front/back/double_sided
 * @param {number} [opts.targetPpi] print resolution (default settings.pdf.options.ppi)
 * @param {number} [opts.cardWidthIn] card width in inches (default: current layout)
 * @param {string} [opts.onlyBackFile] common back to upscale (absolute, or rel inside game/back);
 *   default: the resolved back (cards.resolveBack)
 * @param {boolean} [opts.reportSteps=false] report scan/upscale/save steps (own job only)
 * @param {number} [opts.chunkSize] unique images per chunk (default 24)
 * @returns {Promise<UpscaleResult>}
 */
async function runUpscale(ctx, deps, opts = {}) {
  if (!ctx || typeof ctx.spawn !== 'function') throw new TypeError('runUpscale: a job context is required');
  const o = opts || {};
  const started = Date.now();
  const paths = deps.getPaths();
  const all = settingsOf(deps);
  const pdfOptions = (all.pdf && all.pdf.options) || {};
  const up = normalizeSettings(all.upscayl);
  const kinds = normalizeKinds(o.kinds);
  const step = o.reportSteps ? (id, status, label) => ctx.step(id, status, label) : () => {};
  const targetPpi = clampPpi(o.targetPpi !== undefined && o.targetPpi !== null ? o.targetPpi : pdfOptions.ppi);
  const cardWidthIn = posNum(o.cardWidthIn) || (await cardDimsFor(deps, pdfOptions)).widthIn;
  const result = emptyResult(kinds, targetPpi);
  const log = (line, stream) => ctx.log(line, stream);

  // 1. Sources
  step('scan', 'running');
  ctx.progress({ percent: null, label: 'Looking at your card images…' });
  const incompleteKinds = new Set();
  const items = await collectItems(deps, kinds, o.onlyBackFile, log, incompleteKinds);
  // A kind whose folder could not be fully read keeps its upscaled copies (they are not stale).
  const pruneKinds = kinds.filter((k) => !incompleteKinds.has(k));
  result.total = items.length;
  step('scan', 'done');
  ctx.throwIfCancelled();

  const status = await getUpscaylStatus(deps, {});
  const model = status.found ? resolveModel(status, up.model) : null;
  if (!status.found || !model) {
    if (items.length) {
      ctx.warn(status.found
        ? "Upscaling was skipped because Upscayl's AI models are missing; your original images are used."
        : 'Upscaling was skipped because Upscayl was not found; your original images are used.');
    }
    for (const it of items) result.files[it.kind][it.rel] = it.abs;
    result.skipped = items.length;
    result.durationMs = Date.now() - started;
    return result;
  }
  if (model.warning && items.length) ctx.warn(model.warning);
  result.model = model.id;

  // 2. Plan
  const manifest = readManifestData(deps);
  const existing = await listUpscaledFiles(paths.upscaledRoot, kinds);
  const plan = planUpscale({
    items, settings: up, model: model.id, modelsDirUsed: dirKey(model.dir), targetPpi, cardWidthIn,
    manifest, existingFiles: existing, kinds,
  });
  for (const e of plan.errors) ctx.warn(e.message);
  result.unique = plan.unique.length;
  ctx.log(`Upscale plan at ${targetPpi} PPI with ${model.id}: ${plan.counts.total} images, ${plan.counts.cached} already upscaled, ${plan.counts.sharp} sharp enough, ${plan.counts.upscale} to upscale (${plan.counts.unique} unique).`);

  // 3–7. Chunk by chunk: normalize → Upscayl → validate → retries → place + record.
  const stagingDir = path.join(paths.upscaledRoot, STAGING_DIR, String(ctx.jobId));
  const stats = {
    attempted: 0, retried: 0, firstPassFailures: 0, vkSeen: false, startFailed: false, dirModeMs: 0, dirModeImages: 0,
  };
  const env = {
    up,
    model,
    status,
    plan,
    targetPpi,
    cardWidthIn,
    upscaledRoot: paths.upscaledRoot,
    stats,
    outcomes: new Map(),
    entries: { ...manifest.entries },
    placed: new Map(),
    tripped: false,
    trippedReason: null,
    consecutiveFailures: 0,
    lastFailureSignature: null,
    gpuId: null,
    progress: createProgress(ctx, plan.unique.length),
  };
  const usedIds = new Set();
  plan.unique.forEach((g, i) => {
    const h = /^[0-9a-f]{40}$/i.test(String(g.hash)) ? String(g.hash).toLowerCase().slice(0, 16) : `img${i}`;
    let id = h;
    for (let n = 2; usedIds.has(id); n += 1) id = `${h}-${n}`;
    usedIds.add(id);
    g.fileId = id;
  });

  try {
    if (plan.unique.length) {
      step('upscale', 'running');
      env.gpuId = effectiveGpu(up, status, ctx);
      const chunks = chunkGroups(plan.unique, o.chunkSize);
      for (let i = 0; i < chunks.length; i += 1) {
        ctx.throwIfCancelled();
        const chunk = chunks[i];
        if (env.tripped) {
          for (const g of chunk) env.outcomes.set(g.id, { ok: false, stage: 'upscayl', reason: `not tried (${env.trippedReason || 'repeated errors'})` });
          stats.attempted += chunk.length;
          env.progress.finish(chunk.length);
          continue;
        }
        const chunkDir = path.join(stagingDir, `c${i}`);
        let chunkError = null;
        try {
          await processChunk(ctx, deps, env, chunk, chunkDir);
        } catch (err) {
          chunkError = err; // usually a cancellation: still keep what was already checked
        }
        try {
          if (await distributeChunk(ctx, env, chunk)) {
            await writeManifestData(deps, { version: MANIFEST_VERSION, entries: { ...env.entries } });
          }
        } finally {
          await fsp.rm(chunkDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
        }
        if (chunkError) throw chunkError;
        env.progress.finish(chunk.length);
      }
      step('upscale', 'done');
    }
    ctx.throwIfCancelled();

    // Originals for what failed (copied, never cached), the files map, stale files, final manifest.
    step('save', 'running');
    ctx.progress({ percent: null, label: 'Saving upscaled images…' });
    const keep = new Set();
    const dropEntries = new Set();
    const failedNames = [];
    const groupOf = new Map();
    for (const g of plan.unique) for (const it of g.items) groupOf.set(it, g);
    for (const it of plan.items) {
      const files = result.files[it.kind] || (result.files[it.kind] = {});
      if (it.action === 'sharp') {
        files[it.rel] = it.abs;
        result.sharp += 1;
        continue;
      }
      if (it.action === 'skipped') {
        files[it.rel] = it.abs;
        result.skipped += 1;
        continue;
      }
      if (it.action === 'cached') {
        files[it.rel] = util.resolveInside(paths.upscaledRoot, it.destRel);
        keep.add(fold(it.destRel));
        result.cached += 1;
        continue;
      }
      const g = groupOf.get(it);
      const oc = g ? env.outcomes.get(g.id) : null;
      if (oc && oc.sharp) {
        files[it.rel] = it.abs;
        result.sharp += 1;
        continue;
      }
      if (env.placed.has(it)) {
        files[it.rel] = env.placed.get(it);
        keep.add(fold(it.destRel));
        result.upscaled += 1;
        continue;
      }
      // Fallback: a COPY of the original bytes next to the upscaled images (never cached).
      dropEntries.add(it.destRel);
      const fbRel = `${it.kind}/${it.rel}`;
      try {
        const dest = util.resolveInside(paths.upscaledRoot, fbRel);
        await placeFile(it.abs, dest, { link: false });
        files[it.rel] = dest;
        keep.add(fold(fbRel));
        dropEntries.add(fbRel);
      } catch (err) {
        ctx.log(`Could not copy ${it.name} next to the upscaled images (${err && err.message}); the original is used directly.`, 'warn');
        files[it.rel] = it.abs;
      }
      if (oc && oc.reason) ctx.log(`${it.name}: ${oc.reason}`, 'warn');
      result.fallbacks += 1;
      failedNames.push(it.name);
    }
    fallbackWarnings(ctx, failedNames);
    result.staleRemoved = await pruneStale(paths.upscaledRoot, pruneKinds, keep);
    const entries = { ...env.entries };
    for (const destRel of Object.keys(entries)) {
      if (pruneKinds.includes(destRel.split('/')[0]) && !keep.has(fold(destRel))) delete entries[destRel];
    }
    for (const destRel of dropEntries) delete entries[destRel];
    try {
      await writeManifestData(deps, { version: MANIFEST_VERSION, entries });
    } catch (err) {
      ctx.log(`Could not save the list of upscaled images: ${err && err.message}`, 'warn');
    }
    step('save', 'done');
  } finally {
    await removeStaging(paths.upscaledRoot, stagingDir);
  }

  const outcomeList = plan.unique.map((g) => env.outcomes.get(g.id) || {});
  result.uniqueUpscaled = outcomeList.filter((oc) => oc.ok).length;
  result.uniqueFailed = outcomeList.filter((oc) => !oc.ok && (oc.stage === 'upscayl' || oc.stage === 'save')).length;
  result.unreadable = outcomeList.filter((oc) => oc.stage === 'prepare').length;
  result.retried = stats.retried;

  // 8. Too many failures → switch automatic upscaling off (the user can switch it back on).
  const failedAttempts = result.uniqueFailed;
  if (stats.attempted > 0 && failedAttempts > 0) {
    const ratio = failedAttempts / stats.attempted;
    const severe = stats.attempted >= 2 ? ratio >= 0.5 : (stats.vkSeen || env.tripped || stats.startFailed);
    if (severe) {
      if (up.enabled) {
        try {
          deps.settings.update({ upscayl: { enabled: false } });
          result.disabledUpscaling = true;
        } catch (err) {
          logTo(deps, 'warn', `could not switch upscaling off: ${err && err.message}`);
        }
      }
      const inPdf = ctx.kind === 'pdf';
      let why;
      if (stats.startFailed) why = 'Upscayl could not be started (Windows or your antivirus may be blocking it)';
      else if (stats.vkSeen) why = "your graphics card couldn't run Upscayl";
      else why = 'Upscayl failed on most images';
      ctx.warn(inPdf
        ? `Upscaling was turned off because ${why}; your PDF used the original images.`
        : `Upscaling was turned off because ${why}. Make PDF will use your original images; you can turn upscaling back on in Upscale.`);
    }
  }

  // 9. Seconds per image (moving average of the dir-mode runs).
  if (stats.dirModeImages > 0 && stats.dirModeMs > 0 && !stats.startFailed && stats.firstPassFailures / stats.dirModeImages < 0.5) {
    const measured = stats.dirModeMs / 1000 / stats.dirModeImages;
    const next = round2(Math.min(600, Math.max(0.05, up.secPerImage * 0.7 + measured * 0.3)));
    try {
      deps.settings.update({ upscayl: { secPerImage: next } });
      result.secPerImage = next;
    } catch (err) {
      logTo(deps, 'warn', `could not save the upscale speed: ${err && err.message}`);
    }
  }
  result.durationMs = Date.now() - started;
  ctx.log(`Upscaling finished in ${(result.durationMs / 1000).toFixed(1)} s: ${result.upscaled} upscaled, ${result.cached} already done, ${result.sharp} sharp enough, ${result.fallbacks} originals used, ${result.skipped} skipped.`);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Estimates, cache info, key helpers
// ---------------------------------------------------------------------------------------------

/**
 * Dry-run plan for the current cards and settings (no Upscayl run): counts and estimates.
 * The shape extends PdfPlan.upscale `{ enabled, available, needed, cached, sharp, secEst, bytesEst }`.
 * @param {object} deps
 * @param {object} [opts]
 * @param {string[]} [opts.kinds] default: from `targets` (else settings.upscayl.targets; back only when resolved)
 * @param {{ front?: boolean, back?: boolean, double_sided?: boolean }} [opts.targets]
 * @param {string} [opts.onlyBackFile]
 * @param {number} [opts.targetPpi] default settings.pdf.options.ppi
 * @param {number} [opts.cardWidthIn] default: current layout
 * @returns {Promise<{ enabled: boolean, available: boolean, total: number, needed: number|null, unique: number|null,
 *   cached: number, sharp: number, skipped: number, upToDate: number, secEst: number, bytesEst: number,
 *   model: string|null, kinds: string[], targetPpi: number, errors: object[] }>}
 */
async function estimateUpscale(deps, opts = {}) {
  const o = opts || {};
  const all = settingsOf(deps);
  const pdfOptions = (all.pdf && all.pdf.options) || {};
  const up = normalizeSettings(all.upscayl);
  let kinds = o.kinds ? normalizeKinds(o.kinds) : null;
  let backFile = o.onlyBackFile || null;
  if (!kinds) {
    const r = await kindsFromTargets(deps, o.targets || up.targets);
    kinds = r.kinds;
    backFile = r.backFile;
  }
  const targetPpi = clampPpi(o.targetPpi !== undefined && o.targetPpi !== null ? o.targetPpi : pdfOptions.ppi);
  const cardWidthIn = posNum(o.cardWidthIn) || (await cardDimsFor(deps, pdfOptions)).widthIn;
  const items = await collectItems(deps, kinds, backFile, null);
  const status = await getUpscaylStatus(deps, {});
  const model = status.found ? resolveModel(status, up.model) : null;
  const base = {
    enabled: up.enabled, available: false, total: items.length, needed: null, unique: null, cached: 0, sharp: 0, skipped: 0,
    upToDate: 0, secEst: 0, bytesEst: 0, model: null, kinds, targetPpi, errors: [],
  };
  if (!status.found || !model) return base;
  const existing = await listUpscaledFiles(deps.getPaths().upscaledRoot, kinds);
  const plan = planUpscale({
    items, settings: up, model: model.id, modelsDirUsed: dirKey(model.dir), targetPpi, cardWidthIn,
    manifest: readManifestData(deps), existingFiles: existing, kinds,
  });
  return {
    ...base,
    available: true,
    needed: plan.counts.upscale,
    unique: plan.counts.unique,
    cached: plan.counts.cached,
    sharp: plan.counts.sharp,
    skipped: plan.counts.skipped,
    upToDate: plan.counts.cached + plan.counts.sharp,
    secEst: plan.secEst,
    bytesEst: plan.bytesEst,
    model: model.id,
    errors: plan.errors,
  };
}

/**
 * Upscaled-cache summary for the Upscale view / Settings → Storage (spec §6
 * `{ files, bytes, upToDate, total }` + extras). `files`/`bytes` = what is on disk in game/upscaled;
 * `total` = card images in the upscale targets, `upToDate` = those needing no work (already
 * upscaled or already sharp), `needed` = images still to upscale, `unique` = Upscayl runs needed.
 * @param {object} deps
 * @returns {Promise<{ files: number, bytes: number, upToDate: number, total: number, needed: number|null,
 *   unique: number|null, cached: number, sharp: number, secEst: number, bytesEst: number, available: boolean,
 *   enabled: boolean, kinds: string[], targetPpi: number|null }>}
 */
async function cacheInfo(deps) {
  const paths = deps.getPaths();
  const disk = await dirStats(paths.upscaledRoot, { skipTopLevel: [MANIFEST_FILE, STAGING_DIR] });
  let est = null;
  try {
    est = await estimateUpscale(deps, {});
  } catch (err) {
    logTo(deps, 'warn', `cache estimate failed: ${err && err.message}`);
  }
  return {
    files: disk.files,
    bytes: disk.bytes,
    upToDate: est ? est.upToDate : 0,
    total: est ? est.total : 0,
    needed: est ? est.needed : null,
    unique: est ? est.unique : null,
    cached: est ? est.cached : 0,
    sharp: est ? est.sharp : 0,
    secEst: est ? est.secEst : 0,
    bytesEst: est ? est.bytesEst : 0,
    available: est ? est.available : false,
    enabled: est ? est.enabled : normalizeSettings(settingsOf(deps).upscayl).enabled,
    kinds: est ? est.kinds : [],
    targetPpi: est ? est.targetPpi : null,
  };
}

function keyFnFrom(p) {
  return (item) => {
    if (!item || typeof item.rel !== 'string' || !item.kind) return null;
    const relNoExt = typeof item.relNoExt === 'string' && item.relNoExt ? item.relNoExt : relNoExtOf(item.rel);
    const one = planOne({ ...item, relNoExt, hash: item.hash || null, width: posInt(item.width), height: posInt(item.height) }, p);
    return one.action === 'upscale' ? one.key : null;
  };
}

/**
 * SYNCHRONOUS key function for isCardUpscaled() (what cards.js uses): the cache key the CURRENT
 * settings would give a card, or null when it would not be upscaled. Built from what is already
 * known without waiting — the cached Upscayl detection of this session (models are re-listed), the
 * card size of the last layout lookup (or the helper's introspection cache file), the print
 * resolution in settings. When Upscayl has not been detected yet, the key's models folder is a
 * wildcard, the configured model is assumed, and a background detection is started.
 * @param {object} deps
 * @returns {(item: { kind: string, rel: string, relNoExt?: string, hash: string|null, type: string|null,
 *   width: number|null, height: number|null }) => string|null}
 */
function settingsKeyFn(deps) {
  const all = settingsOf(deps);
  const pdfOptions = (all.pdf && all.pdf.options) || {};
  const up = normalizeSettings(all.upscayl);
  let model = up.model;
  let modelsDirUsed = ANY_MODELS_DIR;
  const detected = detectionStates.get(deps);
  if (detected && detected.result) {
    if (!detected.result.found) return () => null;
    const raw = all.upscayl || {};
    const modelsDir = str(raw.modelsDir) ? path.resolve(raw.modelsDir) : path.resolve(path.dirname(detected.result.binPath), '..', 'models');
    const customDir = str(raw.customModelsDir) ? path.resolve(raw.customModelsDir) : null;
    const eff = resolveModel({ models: listModels(modelsDir, customDir, { platform: platformOf(deps) }) }, up.model);
    if (!eff) return () => null;
    model = eff.id;
    modelsDirUsed = dirKey(eff.dir);
  } else if (!detected || !detected.inflight) {
    detectForDeps(deps, false).catch(() => {});
  }
  return keyFnFrom({
    settings: up,
    model,
    modelsDirUsed,
    targetPpi: clampPpi(pdfOptions.ppi),
    cardWidthIn: cardDimsSync(deps, pdfOptions).widthIn,
    maxPixels: MAX_UPSCALED_PIXELS,
  });
}

/**
 * Key function for isCardUpscaled(): the cache key the CURRENT settings (model, scale, format,
 * print resolution, card size) would give a card, or null when it would not be upscaled.
 * Async (waits for the Upscayl status and the layout); see settingsKeyFn() for the sync variant.
 * @param {object} deps
 * @param {{ targetPpi?: number, cardWidthIn?: number }} [opts]
 * @returns {Promise<(item: { kind: string, rel: string, relNoExt?: string, hash: string|null, type: string|null,
 *   width: number|null, height: number|null }) => string|null>}
 */
async function createKeyFn(deps, opts = {}) {
  const o = opts || {};
  const all = settingsOf(deps);
  const pdfOptions = (all.pdf && all.pdf.options) || {};
  const up = normalizeSettings(all.upscayl);
  let status;
  try {
    status = await getUpscaylStatus(deps, {});
  } catch {
    return () => null;
  }
  const model = status.found ? resolveModel(status, up.model) : null;
  if (!model) return () => null;
  return keyFnFrom({
    settings: up,
    model: model.id,
    modelsDirUsed: dirKey(model.dir),
    targetPpi: clampPpi(o.targetPpi !== undefined && o.targetPpi !== null ? o.targetPpi : pdfOptions.ppi),
    cardWidthIn: posNum(o.cardWidthIn) || (await cardDimsFor(deps, pdfOptions)).widthIn,
    maxPixels: MAX_UPSCALED_PIXELS,
  });
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

function requireJobs(deps) {
  if (!deps || !deps.jobs || typeof deps.jobs.start !== 'function') throw new Error('The task manager is not available.');
  const active = typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw busyError(active.title);
}

async function assertUsable(deps) {
  const status = await getUpscaylStatus(deps, {});
  if (!status.found) {
    throw userError(status.error || "Upscayl isn't installed. Install it from upscayl.org (free), or choose where it is with Locate.", { code: 'UPSCAYL_NOT_FOUND' });
  }
  if (!status.models.length) throw userError(status.error || "Upscayl's AI models are missing. Reinstall Upscayl.", { code: 'UPSCAYL_NO_MODELS' });
  return status;
}

function nothingToUpscaleMessage(targets) {
  const names = [];
  if (targets.front) names.push('fronts');
  if (targets.back) names.push('common back');
  if (targets.double_sided) names.push('unique backs');
  if (targets.back && !targets.front && !targets.double_sided) {
    return 'There is nothing to upscale: no common back image is chosen. Add or choose one in Your cards.';
  }
  return `There are no card images to upscale (${names.join(', ')}). Add some cards first.`;
}

/**
 * "Upscale now" (job kind 'upscale'): kinds from `targets` (default settings.upscayl.targets; the
 * common back only when one is resolved), target PPI = pdf.options.ppi, card width from the current
 * layout. The job result is the UpscaleResult without the `files` map. The job fails (with the
 * warnings kept) when no image could be upscaled at all, or when there are no card images.
 * @param {object} deps
 * @param {{ targets?: { front?: boolean, back?: boolean, double_sided?: boolean } }} [opts]
 * @returns {Promise<string>} jobId
 */
async function startUpscaleJob(deps, opts = {}) {
  requireJobs(deps);
  await assertUsable(deps);
  const all = settingsOf(deps);
  const targets = normalizeTargets(opts && opts.targets ? opts.targets : normalizeSettings(all.upscayl).targets);
  if (!targets.front && !targets.back && !targets.double_sided) {
    throw userError('Choose at least one kind of image to upscale (fronts, common back or unique backs).', { code: 'NO_TARGETS' });
  }
  return deps.jobs.start('upscale', { title: 'Upscaling images', steps: UPSCALE_STEPS.map((s) => ({ ...s })) }, async (ctx) => {
    const { kinds, backFile } = await kindsFromTargets(deps, targets);
    const settings = settingsOf(deps);
    const pdfOptions = (settings.pdf && settings.pdf.options) || {};
    const dims = await cardDimsFor(deps, pdfOptions);
    const result = await runUpscale(ctx, deps, {
      kinds, targetPpi: pdfOptions.ppi, cardWidthIn: dims.widthIn, onlyBackFile: backFile, reportSteps: true,
    });
    if (result.total === 0) throw userError(nothingToUpscaleMessage(targets), { code: 'NOTHING_TO_UPSCALE' });
    if (result.uniqueUpscaled === 0 && result.uniqueFailed > 0) {
      throw userError(`Upscayl couldn't upscale your images (${plural(result.uniqueFailed, 'image', 'images')} failed). Your original images will be used. See the details for what went wrong.`, { code: 'UPSCAYL_FAILED' });
    }
    const { files, ...summary } = result;
    void files;
    return summary;
  });
}

/**
 * "Detect GPUs" (job kind 'probe'): a tiny single-image upscale (32×32 PNG made with
 * util.encodePng, smallest model, scale 2, 60 s timeout); the GPU list from stderr is cached in
 * settings (upscayl.gpus, upscayl.gpusDetectedFor = binPath).
 * Result `{ gpus: [{ id, name }], works: boolean, model, durationMs }`.
 * @param {object} deps
 * @returns {Promise<string>} jobId
 */
async function startGpuProbeJob(deps) {
  requireJobs(deps);
  await assertUsable(deps);
  return deps.jobs.start('probe', { title: 'Detecting graphics cards' }, async (ctx) => {
    const started = Date.now();
    const status = await assertUsable(deps);
    const model = smallestModel(status.models);
    const paths = deps.getPaths();
    const tmp = paths.tmpDir || path.join(paths.scmCacheDir, 'tmp');
    await fsp.mkdir(tmp, { recursive: true });
    const input = path.join(tmp, `probe-${ctx.jobId}.png`);
    const output = path.join(tmp, `probe-${ctx.jobId}-out.png`);
    const size = 32;
    const rgba = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const i = (y * size + x) * 4;
        rgba[i] = x * 8;
        rgba[i + 1] = y * 8;
        rgba[i + 2] = ((x + y) % 2) * 255;
        rgba[i + 3] = 255;
      }
    }
    await fsp.writeFile(input, util.encodePng(size, size, rgba));
    const lines = [];
    try {
      ctx.progress({ percent: null, label: 'Asking Upscayl about your graphics cards…' });
      const res = await runUpscayl(ctx, status.binPath, buildUpscaylArgs({
        input, output, modelsDir: model.dir, model: model.id, modelScale: model.scale, scale: 2, format: 'png',
      }), { timeoutMs: PROBE_TIMEOUT_MS, onLine: (line) => { if (lines.length < 500) lines.push(line); } });
      if (res.startFailed) {
        throw userError(`${(res.message || 'Could not start Upscayl.').replace(/\.$/, '')}.`, { code: 'UPSCAYL_START_FAILED', details: lines.slice(-30).join('\n') });
      }
      const gpus = parseGpuLines(lines);
      let works = false;
      if (res.code === 0 && !res.vkFailure && await isFile(output)) {
        const dims = await readImageSize(output);
        works = !!(dims && dims.width === size * 2 && dims.height === size * 2);
      }
      deps.settings.update({ upscayl: { gpus, gpusDetectedFor: status.binPath } });
      invalidateEnvStatus(deps);
      if (!gpus.length) {
        throw userError("Upscayl didn't find a graphics card it can use (it needs Vulkan). Upscaling may not work on this computer; updating the graphics driver often helps.", {
          code: 'NO_GPU', details: lines.slice(-30).join('\n'),
        });
      }
      ctx.log(`Graphics cards: ${gpus.map((g) => `#${g.id} ${g.name}`).join(', ')}`);
      if (!works) {
        ctx.warn(`Upscayl found your graphics card${gpus.length > 1 ? 's' : ''}, but a quick test upscale failed (${describeRunFailure(res, await isFile(output))}). Upscaling may not work; try another graphics card, or update your graphics driver.`);
      }
      return { gpus, works, model: model.id, durationMs: Date.now() - started };
    } finally {
      await fsp.rm(input, { force: true }).catch(() => {});
      await fsp.rm(output, { force: true }).catch(() => {});
    }
  });
}

async function prunePreviews(dir) {
  let names;
  try {
    names = await fsp.readdir(dir);
  } catch {
    return;
  }
  const files = [];
  for (const name of names) {
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) files.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const now = Date.now();
  for (let i = 0; i < files.length; i += 1) {
    if (i >= PREVIEW_KEEP_FILES || now - files[i].mtimeMs > PREVIEW_MAX_AGE_MS) {
      await fsp.rm(path.join(dir, files[i].name), { force: true }).catch(() => {});
    }
  }
}

/**
 * "Try on one card" (job kind 'preview'): normalize → single-image upscale with the current model
 * and the scale Make PDF would use (2× when the card is already sharp) →
 * `scmCacheDir/preview/<jobId>.png` (+ `<jobId>-before.png`, the normalized original, so both
 * images line up; protocol.js serves that folder). Result: `{ before, after }` scm-img URLs,
 * `beforeSize`/`afterSize` `{ width, height, bytes }`, ready-made `beforeCaption`/`afterCaption`,
 * `scale`, `model`, `alreadySharp`, `effPpi`, `targetPpi`, `seconds`, `kind`, `rel`, `name`.
 * @param {object} deps
 * @param {{ kind: string, rel: string }} opts
 * @returns {Promise<string>} jobId
 */
async function startPreviewJob(deps, opts = {}) {
  const kind = opts && opts.kind;
  const rel = opts && opts.rel;
  if (!UPSCALE_KINDS.includes(kind)) throw new TypeError('startPreviewJob: unknown kind');
  requireJobs(deps);
  const paths = deps.getPaths();
  const abs = util.resolveInside(paths.gameDir(kind), rel);
  if (!isFileSync(abs)) throw userError(`Could not find ${rel}.`, { code: 'NOT_FOUND' });
  await assertUsable(deps);
  return deps.jobs.start('preview', { title: 'Upscaling a preview' }, async (ctx) => {
    const started = Date.now();
    const status = await assertUsable(deps);
    const all = settingsOf(deps);
    const up = normalizeSettings(all.upscayl);
    const pdfOptions = (all.pdf && all.pdf.options) || {};
    const model = resolveModel(status, up.model);
    if (model.warning) ctx.warn(model.warning);
    const name = path.basename(abs);
    const previewDir = paths.previewDir || path.join(paths.scmCacheDir, 'preview');
    await fsp.mkdir(previewDir, { recursive: true });
    await prunePreviews(previewDir);
    const before = path.join(previewDir, `${ctx.jobId}-before.png`);
    const after = path.join(previewDir, `${ctx.jobId}.png`);
    let keep = false;
    try {
      ctx.progress({ percent: null, label: 'Preparing the image…' });
      const prepared = await helperPrepare(ctx, deps, [{ id: 'one', src: abs, dest: before }]);
      const r = prepared.get('one');
      if (!r || !r.ok || !posInt(r.width) || !posInt(r.height)) {
        throw userError(`${name} could not be opened, so it can't be upscaled.`, { code: 'BAD_IMAGE', details: (r && r.error) || '' });
      }
      const targetPpi = clampPpi(pdfOptions.ppi);
      const cardWidthIn = (await cardDimsFor(deps, pdfOptions)).widthIn;
      const choice = chooseScale({ width: r.width, height: r.height, cardWidthIn, targetPpi, maxScale: up.scale, smart: up.smartScale });
      const scale = choice.action === 'upscale' ? choice.scale : capScale(2, r.width, r.height);
      if (scale === null) {
        throw userError(`${name} is already very large (${r.width} × ${r.height} px); it doesn't need upscaling.`, { code: 'TOO_LARGE' });
      }
      const alreadySharp = choice.action === 'sharp';
      ctx.progress({ percent: 0, label: `Upscaling ${name} (${scale}×)…` });
      const res = await runUpscayl(ctx, status.binPath, buildUpscaylArgs({
        input: before, output: after, modelsDir: model.dir, model: model.id, modelScale: model.scale, scale, format: 'png',
        tileSize: up.tileSize, gpuId: effectiveGpu(up, status, ctx), threads: up.threads, tta: up.tta,
      }), {
        timeoutMs: up.tta ? SINGLE_TIMEOUT_TTA_MS : SINGLE_TIMEOUT_MS,
        onLine: (line) => {
          const pct = parsePercent(line);
          if (pct !== null) ctx.progress({ percent: pct, label: `Upscaling ${name} (${scale}×)…` });
        },
      });
      const exists = !res.startFailed && await isFile(after);
      let valid = null;
      if (res.ok && exists) {
        ctx.progress({ percent: null, label: 'Checking the result…' });
        const g = { id: 'one', outPath: after, normWidth: r.width, normHeight: r.height, runScale: scale, refMean: r.mean, refStd: r.std };
        valid = (await helperValidate(ctx, deps, [g])).get('one');
      }
      if (!valid || !valid.ok) {
        let message;
        if (res.startFailed) message = `${(res.message || 'Could not start Upscayl.').replace(/\.$/, '')}.`;
        else if (res.timedOut) message = 'Upscayl took too long and was stopped. Try a smaller tile size or another model.';
        else if (res.vkFailure || (valid && /blank|brightness/.test(valid.reason || ''))) message = "Upscayl couldn't use your graphics card for this image. Try another graphics card or model in Upscale, or update your graphics driver.";
        else message = `Upscayl couldn't upscale ${name} (${describeRunFailure(res, exists)}${valid && valid.reason ? `; ${valid.reason}` : ''}).`;
        throw userError(message, { code: 'UPSCAYL_FAILED', details: res.stderrTail.join('\n') });
      }
      const [stB, stA] = await Promise.all([fsp.stat(before), fsp.stat(after)]);
      const width = valid.width || r.width * scale;
      const height = valid.height || r.height * scale;
      keep = true;
      return {
        before: toFileUrl(before, stB.mtimeMs),
        after: toFileUrl(after, stA.mtimeMs),
        beforeSize: { width: r.width, height: r.height, bytes: stB.size },
        afterSize: { width, height, bytes: stA.size },
        beforeBytes: stB.size,
        afterBytes: stA.size,
        beforeCaption: `${r.width} × ${r.height} px · ${formatBytes(stB.size)}`,
        afterCaption: `${width} × ${height} px · ${formatBytes(stA.size)}`,
        scale,
        model: model.id,
        alreadySharp,
        effPpi: choice.effPpi === null ? null : Math.round(choice.effPpi),
        targetPpi,
        seconds: round2((Date.now() - started) / 1000),
        kind,
        rel,
        name,
      };
    } finally {
      if (!keep) {
        await fsp.rm(before, { force: true }).catch(() => {});
        await fsp.rm(after, { force: true }).catch(() => {});
      }
    }
  });
}

/**
 * Delete everything in game/upscaled (spec §9.7). Refuses while any job runs (BUSY).
 * @param {object} deps
 * @returns {Promise<{ removed: number, bytes: number }>} removed = upscaled image files deleted
 */
async function clearCache(deps) {
  const active = deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw busyError(active.title);
  const paths = deps.getPaths();
  const file = manifestPath(deps);
  const writer = manifestWriters.get(file);
  if (writer) await writer.flush();
  const stats = await dirStats(paths.upscaledRoot, { skipTopLevel: [MANIFEST_FILE, STAGING_DIR] });
  await util.removeDirContents(paths.upscaledRoot);
  await fsp.mkdir(paths.upscaledRoot, { recursive: true }).catch(() => {});
  manifestCache.delete(file);
  logTo(deps, 'info', `cleared the upscaled images (${stats.files} files, ${formatBytes(stats.bytes)})`);
  notifyCardsChanged(deps, { reason: 'upscale-cache' });
  return { removed: stats.files, bytes: stats.bytes };
}

module.exports = {
  // §12 contract
  getUpscaylStatus,
  locateUpscayl,
  setCustomModelsDir,
  startGpuProbeJob,
  listModels,
  planUpscale,
  buildUpscaylArgs,
  parseGpuLines,
  parsePercent,
  loadManifest,
  isCardUpscaled,
  runUpscale,
  startUpscaleJob,
  startPreviewJob,
  cacheInfo,
  clearCache,
  // extras
  settingsKeyFn,
  createKeyFn,
  estimateUpscale,
  cardDimsFor,
  kindsFromTargets,
  detectUpscaylBinary,
  resolveModel,
  chooseScale,
  capScale,
  chunkGroups,
  makeKey,
  keyMatches,
  outExtFor,
  normalizeSettings,
  modelScaleFromName,
  modelDisplayName,
  UPSCALE_KINDS,
  MAX_UPSCALED_PIXELS,
  BUILTIN_MODELS,
  NON_COMMERCIAL_MODELS,
  MODEL_FALLBACK_ORDER,
  VK_FAILURE_RE,
  MANIFEST_FILE,
  UPSCALE_STEPS,
  CHUNK_SIZE,
};
