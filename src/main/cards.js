'use strict';

/**
 * cards.js — the card images in `<workspace>/game/{front,back,double_sided}` (spec §6, §9.5, §13.1).
 *
 * - Listing: images as the engine sees them (scan.js), with SHA-1 hashes from the shared cache
 *   (deps.hashCache), `scm-img://` URLs, unique-back partners and "upscaled" flags.
 * - Partners: a unique back (double_sided) belongs to the front with the SAME relative path without
 *   extension, exact case (that is how create_pdf pairs them). Duplicating, removing, renaming and
 *   fixing collisions on a front does the same to its partner (same new stem).
 * - Removal never deletes: files move to `game/.trash/<YYYYMMDD-HHMMSS>-<reason>-<n>/<kind>/<rel>`
 *   with a `batch.json` ({ reason, at, items }), restorable for 14 days ("Recently removed").
 * - Warnings (exact case, whole folder tree, like the engine): stem_collision, unsupported_file,
 *   ds_without_front, multiple_backs.
 * - Common back: settings.cards.back = { mode: 'auto'|'file'|'none', file } resolved to 0 or 1 file.
 * - Test cards: the 'samples' job draws numbered test cards (scm_helper make-test-cards) at the
 *   current card size, so beginners can try a first print and cut.
 * - Folder watcher: one 'cards:changed' event per second at most, paused during jobs that change
 *   files (main.js pauses/resumes it), re-armed with backoff after errors.
 * - Every user-facing mutation refuses with `BUSY: wait until "<title>" finishes` while a job that
 *   changes files runs (locks.assertNotMutating, plus the test-card job).
 *
 * No Electron: everything comes through `deps` (getPaths, settings, jobs, locks, helper, hashCache,
 * emit, openPath, watcher, logger).
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('./util');
const scan = require('./scan');
const { toFileUrl } = require('./img-url');
const { sniffImageType, VALID_TYPES } = require('./image-meta');
const { userError } = require('./errors');
const locks = require('./locks');

/** Card image folders. */
const CARD_KINDS = Object.freeze(['front', 'back', 'double_sided']);
/** Folders whose files can go to the trash. */
const TRASH_KINDS = Object.freeze(['front', 'back', 'double_sided', 'decklist']);
const ADD_KINDS = Object.freeze(['front', 'back']);
const OPEN_KINDS = Object.freeze(['front', 'back', 'double_sided', 'decklist', 'output']);
const BACK_MODES = Object.freeze(['auto', 'file', 'none']);
const TRASH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const EMPTY_BATCH_GRACE_MS = 60 * 60 * 1000;
const BATCH_FILE = 'batch.json';
const MAX_ADD_FILES = 5000;
const MAX_COPIES = 100;
const SAMPLE_COUNT = 9;
const SAMPLE_PPI = 300;

/** Plain-language names of trash reasons (trashList().label). */
const REASON_LABELS = Object.freeze({
  removed: 'Removed cards',
  cleared: 'Removed all cards',
  'before-download': 'Cards set aside before a download',
  'incomplete-download': 'Unfinished download',
  'before-samples': 'Cards set aside for the test cards',
  replaced: 'Replaced unique back',
  decklist: 'Deleted deck list',
});
const KIND_LABELS = Object.freeze({ front: 'Fronts', back: 'Common back', double_sided: 'Unique backs', decklist: 'Deck lists' });

/** File extension for an image type when the source file has none. */
const TYPE_EXT = Object.freeze({ png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', bmp: 'bmp', tiff: 'tif', avif: 'avif', jpx: 'jp2' });

/** Card sizes (mm) used for test cards when the engine description is not available. */
const FALLBACK_CARD_SIZES = Object.freeze({
  standard: [63, 88], poker: [63.5, 88.9], bridge: [57.15, 88.9], american_mini: [41, 63], bridge_square: [57.15, 57.15],
  business: [88.9, 50.8], catan: [54, 80], credit: [85.725, 53.975], domino: [44.45, 88.9], domino_square: [44.45, 44.45],
  euro_business: [85, 55], euro_mini: [44, 68], japanese: [59, 86], jumbo: [88.9, 139.7], micro: [31.75, 44.45],
  mini: [44.45, 63.5], standard_double: [88, 126], tarot: [69.85, 120.65], '70mm_square': [70, 70],
});
const FALLBACK_CARD_ALIASES = Object.freeze({ euro_poker: 'standard', photo: 'euro_business', mini_american: 'american_mini', mini_euro: 'euro_mini' });

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

function noop() {}

function logger(deps) {
  const l = deps && deps.logger;
  return {
    info: l && typeof l.info === 'function' ? (...a) => { try { l.info(...a); } catch { /* ignore */ } } : noop,
    warn: l && typeof l.warn === 'function' ? (...a) => { try { l.warn(...a); } catch { /* ignore */ } } : noop,
  };
}

function kindDir(deps, kind) {
  const p = deps.getPaths();
  if (kind === 'output') return p.outputDir;
  return typeof p.gameDir === 'function' ? p.gameDir(kind) : path.join(p.workspaceDir, 'game', kind);
}

function trashRoot(deps) {
  const p = deps.getPaths();
  return p.trashRoot || path.join(p.workspaceDir, 'game', '.trash');
}

function assertKind(kind, allowed = CARD_KINDS) {
  if (!allowed.includes(kind)) throw userError(`Unknown card folder "${kind}".`, { code: 'INVALID_ARGUMENT' });
}

/**
 * Refuse card changes while a job that changes files runs (spec §5.2), and during the test-card
 * job (kind 'samples', not "mutating" for jobs.js but it writes card files).
 * @param {object} deps
 */
function assertCanMutate(deps) {
  locks.assertNotMutating(deps.jobs);
  const active = deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active && active.kind === 'samples') throw locks.busyError(active.title);
}

const posixDirname = (rel) => {
  const i = rel.lastIndexOf('/');
  return i >= 0 ? rel.slice(0, i) : '';
};
const joinRel = (dir, name) => (dir ? `${dir}/${name}` : name);

function groupBy(items, key) {
  const map = new Map();
  for (const item of items) {
    const k = item[key];
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

function quoteList(names, max = 5) {
  const shown = names.slice(0, max).map((n) => `"${n}"`);
  const more = names.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

/** Safe stem for files the app creates (no glob characters, which break the engine's pairing). */
function safeStem(stem, fallback = 'card') {
  return util.sanitizeFileName(stem, { maxLen: 120, fallback, stripGlob: true }).replace(/[*?]/g, '') || fallback;
}

/** "card (3)" -> { base: 'card', next: 4 }; "card" -> { base: 'card', next: 2 }. */
function stemCounter(stem) {
  const m = /^(.*\S) \((\d{1,6})\)$/.exec(stem);
  return m ? { base: m[1], next: Number(m[2]) + 1 } : { base: stem, next: 2 };
}

/**
 * Next free stem "<base> (n)": not in `taken` (case-insensitive) and no `<dir>/<stem>.<ext>` file
 * in any of `targets` ([{ dir, ext }]).
 */
function nextFreeStem(stem, takenLower, targets) {
  const { base, next } = stemCounter(stem);
  for (let n = next; n < next + 100000; n += 1) {
    const candidate = `${base} (${n})`;
    if (takenLower.has(candidate.toLowerCase())) continue;
    if (targets.some((t) => fs.existsSync(path.join(t.dir, t.ext ? `${candidate}.${t.ext}` : candidate)))) continue;
    return candidate;
  }
  throw new Error(`Could not find a free name for "${stem}"`);
}

function lockedFilesError(failed) {
  const names = failed.map((f) => path.posix.basename(f.rel));
  const first = failed[0] && failed[0].error;
  const code = first && first.code;
  const why = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
    ? 'They may be open in another program (an image viewer or editor) or blocked by your antivirus. Close them and try again.'
    : 'Try again.';
  return userError(`${plural(names.length, 'file', 'files')} could not be moved: ${quoteList(names)}. ${why}`, {
    code: 'FILE_LOCKED',
    details: failed.map((f) => `${f.kind}/${f.rel}: ${f.error && (f.error.stack || f.error.message)}`).join('\n'),
  });
}

/** Remove now-empty folders between `dir` (exclusive) and the kind root (exclusive). */
async function pruneEmptyParents(root, relDirs) {
  const dirs = [...new Set(relDirs.filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const relDir of dirs) {
    let current = relDir;
    while (current) {
      const abs = path.join(root, ...current.split('/'));
      try {
        await fsp.rmdir(abs); // only succeeds when empty
      } catch {
        break;
      }
      current = posixDirname(current);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

async function scanKind(deps, kind, { hash = false, sizes = true } = {}) {
  const opts = { hash, sizes };
  if (hash && deps.hashCache && typeof deps.hashCache.hashFile === 'function') opts.hashCache = deps.hashCache;
  return scan.scanDir(kindDir(deps, kind), opts);
}

/** Map relNoExt -> rel of the first image (natural order) with that relNoExt. */
function partnerMapOf(images) {
  const map = new Map();
  for (const img of images) if (!map.has(img.relNoExt)) map.set(img.relNoExt, img.rel);
  return map;
}

function otherReason(item) {
  if (item.type === 'heic') return 'HEIC photos are not supported: convert it to JPG or PNG first';
  if (item.broken) return 'This shortcut points to a file that no longer exists';
  if (item.error) return 'This file could not be read';
  return 'Not an image the card maker can use';
}

/**
 * Lazily load the upscale manifest checker (upscayl.js is optional). Any failure → never upscaled.
 * Calls upscayl.isCardUpscaled(manifest, keyFn, item) with keyFn from upscayl.settingsKeyFn(deps)
 * (or a similarly named factory) when exported, else null.
 * @returns {Promise<(item: object) => boolean>}
 */
async function makeUpscaledChecker(deps) {
  let up;
  try {
    // eslint-disable-next-line global-require
    up = require('./upscayl');
  } catch {
    return () => false;
  }
  if (!up || typeof up.isCardUpscaled !== 'function' || typeof up.loadManifest !== 'function') return () => false;
  let manifest;
  try {
    manifest = await up.loadManifest(deps);
  } catch (err) {
    logger(deps).warn('[cards] Could not read the upscale manifest:', err && err.message);
    return () => false;
  }
  if (!manifest) return () => false;
  let keyFn = null;
  for (const name of ['settingsKeyFn', 'keyFnFor', 'makeKeyFn', 'createKeyFn', 'upscaleKeyFn', 'manifestKeyFn']) {
    if (typeof up[name] !== 'function') continue;
    try {
      const fn = up[name](deps);
      if (typeof fn === 'function') {
        keyFn = fn;
        break;
      }
    } catch {
      /* try the next one */
    }
  }
  return (item) => {
    try {
      return !!up.isCardUpscaled(manifest, keyFn, item);
    } catch {
      return false;
    }
  };
}

/**
 * @typedef {object} CardImage
 * @property {string} rel posix path relative to the kind folder
 * @property {string} name file name
 * @property {string} stem Python Path.stem
 * @property {string} relNoExt rel without the extension (pairs fronts and unique backs)
 * @property {string} ext lower-case extension without the dot
 * @property {string|null} type sniffed image type
 * @property {string} abs absolute path
 * @property {number|null} size bytes
 * @property {number|null} mtimeMs
 * @property {number|null} width pixels after EXIF rotation
 * @property {number|null} height
 * @property {string|null} hash SHA-1
 * @property {string} url scm-img:// URL for the renderer
 * @property {string|null} partner rel of the partner (front <-> unique back), else null
 * @property {boolean} upscaled an up-to-date upscaled copy exists
 */

function toCardImage(kind, item, partners, isUpscaled) {
  const card = {
    rel: item.rel,
    name: item.name,
    stem: item.stem,
    relNoExt: item.relNoExt,
    ext: item.ext,
    type: item.type,
    abs: item.abs,
    size: item.size,
    mtimeMs: item.mtimeMs,
    width: item.width,
    height: item.height,
    hash: item.hash,
    url: toFileUrl(item.abs, item.mtimeMs),
    partner: partners ? partners.get(item.relNoExt) || null : null,
    upscaled: false,
  };
  card.upscaled = !!isUpscaled({
    kind, rel: item.rel, relNoExt: item.relNoExt, abs: item.abs, hash: item.hash, type: item.type, ext: item.ext,
    width: item.width, height: item.height, size: item.size, mtimeMs: item.mtimeMs,
  });
  return card;
}

// ---------------------------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ code: 'stem_collision'|'unsupported_file'|'ds_without_front'|'multiple_backs',
 *   message: string, files: string[], kind: string, stem?: string }} CardWarning
 */

function stemCollisionWarnings(kind, images) {
  const out = [];
  const groups = [...groupBy(images, 'stem')].filter(([, list]) => list.length > 1);
  const what = kind === 'double_sided' ? 'unique backs' : 'images';
  const effect = kind === 'double_sided' ? 'only one would be used' : 'only one would be printed';
  for (const [stem, list] of groups.slice(0, 50)) {
    const count = list.length === 2 ? 'Two' : String(list.length);
    out.push({
      code: 'stem_collision',
      kind,
      stem,
      message: `${count} ${what} share the name "${stem}" (${quoteList(list.map((i) => i.rel), 6).replace(/"/g, '')}); ${effect}.`,
      files: list.map((i) => i.rel),
    });
  }
  if (groups.length > 50) {
    const rest = groups.slice(50);
    out.push({
      code: 'stem_collision',
      kind,
      message: `${rest.length} more names are shared by several ${what}; ${effect} for each.`,
      files: rest.flatMap(([, list]) => list.map((i) => i.rel)),
    });
  }
  return out;
}

function unsupportedWarning(kind, others) {
  if (!others.length) return [];
  const names = others.map((o) => o.rel);
  const heic = others.some((o) => o.type === 'heic');
  const where = KIND_LABELS[kind] || kind;
  const base = names.length === 1
    ? `"${names[0]}" in ${where} is not an image the card maker can use, so it will be ignored.`
    : `${names.length} files in ${where} are not images the card maker can use and will be ignored: ${quoteList(names)}.`;
  return [{
    code: 'unsupported_file',
    kind,
    message: heic ? `${base} HEIC photos must be converted to JPG or PNG first.` : base,
    files: names,
  }];
}

function dsWithoutFrontWarning(dsImages, frontImages) {
  const fronts = new Set(frontImages.map((i) => i.relNoExt));
  const orphans = dsImages.filter((i) => !fronts.has(i.relNoExt));
  if (!orphans.length) return [];
  const names = orphans.map((i) => i.rel);
  return [{
    code: 'ds_without_front',
    kind: 'double_sided',
    message: names.length === 1
      ? `The unique back "${names[0]}" has no front with the same name. Each unique back needs a front image with the same name (the extension may differ).`
      : `${names.length} unique backs have no front with the same name: ${quoteList(names)}. Each unique back needs a front image with the same name (the extension may differ).`,
    files: names,
  }];
}

function multipleBacksWarning(back, backImages) {
  if (back.problem !== 'choose') return [];
  return [{
    code: 'multiple_backs',
    kind: 'back',
    message: `There are ${backImages.length} common back images and none is chosen. Choose the one to print on the back of every single-sided card.`,
    files: backImages.map((i) => i.rel),
  }];
}

// ---------------------------------------------------------------------------------------------
// Common back
// ---------------------------------------------------------------------------------------------

function backSetting(deps) {
  const s = deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : {};
  const b = (s && s.cards && s.cards.back) || {};
  return {
    mode: BACK_MODES.includes(b.mode) ? b.mode : 'auto',
    file: typeof b.file === 'string' && b.file ? b.file : null,
  };
}

function findByRel(images, rel) {
  if (!rel) return null;
  const exact = images.find((i) => i.rel === rel);
  if (exact) return exact;
  if (process.platform === 'win32') {
    const lower = rel.toLowerCase();
    return images.find((i) => i.rel.toLowerCase() === lower) || null;
  }
  return null;
}

/**
 * Resolve the common back from the setting and the images in game/back (pure).
 * @returns {{ mode: string, file: string|null, abs: string|null, problem: null|'choose'|'missing',
 *   effective: string|null, configuredFile: string|null }}
 *   file/effective = the back image that will be used (rel), configuredFile = settings value
 */
function resolveBackFrom(setting, backImages) {
  const { mode, file } = setting;
  if (mode === 'none') return { mode, file: null, abs: null, problem: null, effective: null, configuredFile: file };
  if (mode === 'file') {
    const hit = findByRel(backImages, file);
    if (!hit) return { mode, file: null, abs: null, problem: 'missing', effective: null, configuredFile: file };
    return { mode, file: hit.rel, abs: hit.abs, problem: null, effective: hit.rel, configuredFile: file };
  }
  if (backImages.length === 1) {
    return { mode: 'auto', file: backImages[0].rel, abs: backImages[0].abs, problem: null, effective: backImages[0].rel, configuredFile: null };
  }
  return { mode: 'auto', file: null, abs: null, problem: backImages.length > 1 ? 'choose' : null, effective: null, configuredFile: null };
}

/**
 * The common back to print (spec §9.5): mode 'file' → that file (problem 'missing' when it is
 * gone); 'none' → no back; 'auto' → the only image in game/back, none when the folder is empty,
 * problem 'choose' when there are several.
 * @param {object} deps
 * @returns {Promise<{ mode: string, file: string|null, abs: string|null, problem: null|'choose'|'missing', effective: string|null, configuredFile: string|null }>}
 */
async function resolveBack(deps) {
  const backs = await scanKind(deps, 'back', { sizes: false });
  return resolveBackFrom(backSetting(deps), backs.images);
}

function setBackSetting(deps, value) {
  deps.settings.update({ cards: { back: { mode: value.mode, file: value.file || null } } });
}

// ---------------------------------------------------------------------------------------------
// Change notifications and the folder watcher
// ---------------------------------------------------------------------------------------------

/**
 * Tell the window that cards changed. Goes through the watcher's throttle when it runs (so a
 * mutation and the file events it causes give at most one event per second).
 * @param {object} deps
 * @param {{ reason: string, kinds?: string[] }} payload
 */
function notifyChanged(deps, payload) {
  const w = deps.watcher;
  if (w && typeof w.notify === 'function') {
    try {
      w.notify(payload);
      return;
    } catch {
      /* fall back to a direct event */
    }
  }
  if (typeof deps.emit === 'function') {
    try {
      deps.emit('cards:changed', payload);
    } catch {
      /* window gone */
    }
  }
}

/**
 * Watch game/front, game/back and game/double_sided (recursive fs.watch) and emit
 * 'cards:changed' { reason: 'watch', kinds } at most once per second (leading + trailing).
 * main.js pauses it while a job that changes files runs; resume() always emits once
 * ({ reason: 'job' }). A watcher that errors is closed and re-armed with backoff (1 s → 60 s).
 * @param {object} deps
 * @param {{ throttleMs?: number, watch?: typeof fs.watch, maxBackoffMs?: number }} [options] test seams
 * @returns {{ stop(): void, pause(): void, resume(): void, notify(payload?: object): void, readonly paused: boolean, readonly watching: string[] }}
 */
function startWatching(deps, options = {}) {
  const throttleMs = Number.isFinite(options.throttleMs) ? options.throttleMs : 1000;
  const maxBackoffMs = Number.isFinite(options.maxBackoffMs) ? options.maxBackoffMs : 60000;
  const watchImpl = typeof options.watch === 'function' ? options.watch : fs.watch;
  const log = logger(deps);
  const dirs = {};
  for (const kind of CARD_KINDS) dirs[kind] = kindDir(deps, kind);

  const recs = new Map();
  let stopped = false;
  let paused = false;
  let lastEmit = 0;
  let trailing = null;
  const pendingKinds = new Set();
  let pendingReason = null;

  function emitNow(payload) {
    lastEmit = Date.now();
    if (typeof deps.emit === 'function') {
      try {
        deps.emit('cards:changed', payload);
      } catch {
        /* window gone */
      }
    }
  }

  function flush() {
    if (stopped || paused) return;
    const payload = { reason: pendingReason || 'watch', kinds: [...pendingKinds] };
    pendingKinds.clear();
    pendingReason = null;
    emitNow(payload);
  }

  function schedule(kinds, reason) {
    if (stopped) return;
    for (const k of kinds) if (k) pendingKinds.add(k);
    if (reason && (!pendingReason || pendingReason === 'watch')) pendingReason = reason;
    if (paused || trailing) return;
    const wait = lastEmit + throttleMs - Date.now();
    if (wait <= 0) {
      flush();
    } else {
      trailing = setTimeout(() => {
        trailing = null;
        flush();
      }, wait);
      if (typeof trailing.unref === 'function') trailing.unref();
    }
  }

  function arm(kind) {
    if (stopped) return;
    const rec = recs.get(kind) || { watcher: null, timer: null, attempt: 0, warned: false };
    recs.set(kind, rec);
    let watcher;
    try {
      watcher = watchImpl(dirs[kind], { recursive: true, persistent: false }, () => schedule([kind], 'watch'));
    } catch (err) {
      retry(kind, err);
      return;
    }
    rec.watcher = watcher;
    if (rec.attempt > 0) schedule([kind], 'watch'); // files may have changed while not watched
    const healthy = setTimeout(() => { rec.attempt = 0; rec.warned = false; }, 30000);
    if (typeof healthy.unref === 'function') healthy.unref();
    if (typeof watcher.on === 'function') {
      watcher.on('error', (err) => {
        clearTimeout(healthy);
        try { watcher.close(); } catch { /* already closed */ }
        if (rec.watcher === watcher) rec.watcher = null;
        retry(kind, err);
      });
    }
  }

  function retry(kind, err) {
    if (stopped) return;
    const rec = recs.get(kind);
    const delay = Math.min(maxBackoffMs, 1000 * 2 ** Math.min(rec.attempt, 16));
    rec.attempt += 1;
    if (!rec.warned) {
      rec.warned = true;
      log.warn(`[cards] Watching ${dirs[kind]} failed (${err && (err.code || err.message)}); retrying in ${Math.round(delay / 1000)} s.`);
    }
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(() => {
      rec.timer = null;
      arm(kind);
    }, delay);
    if (typeof rec.timer.unref === 'function') rec.timer.unref();
  }

  for (const kind of CARD_KINDS) arm(kind);

  return {
    stop() {
      stopped = true;
      if (trailing) clearTimeout(trailing);
      trailing = null;
      for (const rec of recs.values()) {
        if (rec.timer) clearTimeout(rec.timer);
        if (rec.watcher) {
          try { rec.watcher.close(); } catch { /* already closed */ }
        }
        rec.watcher = null;
      }
    },
    pause() {
      paused = true;
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
    },
    resume() {
      if (stopped) return;
      paused = false;
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
      const kinds = [...pendingKinds];
      pendingKinds.clear();
      pendingReason = null;
      emitNow({ reason: 'job', kinds });
    },
    notify(payload = {}) {
      const kinds = Array.isArray(payload.kinds) ? payload.kinds : payload.kind ? [payload.kind] : [];
      schedule(kinds, payload.reason || 'change');
    },
    get paused() {
      return paused;
    },
    get watching() {
      return CARD_KINDS.filter((k) => recs.get(k) && recs.get(k).watcher);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Listing and summary
// ---------------------------------------------------------------------------------------------

/**
 * Images of one folder (spec §6 CardList).
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'} kind
 * @returns {Promise<{ kind: string, dir: string, images: CardImage[], others: Array<{ rel: string, name: string, ext: string, type: string|null, reason: string }>, warnings: CardWarning[], truncated: boolean }>}
 */
async function listCards(deps, kind) {
  assertKind(kind);
  const dir = kindDir(deps, kind);
  const partnerKind = kind === 'front' ? 'double_sided' : kind === 'double_sided' ? 'front' : null;
  const [main, partner, isUpscaled] = await Promise.all([
    scanKind(deps, kind, { hash: true }),
    partnerKind ? scanKind(deps, partnerKind, { sizes: false }) : Promise.resolve(null),
    makeUpscaledChecker(deps),
  ]);
  const partners = partner ? partnerMapOf(partner.images) : null;
  const images = main.images.map((item) => toCardImage(kind, item, partners, isUpscaled));
  const warnings = [];
  if (kind !== 'back') warnings.push(...stemCollisionWarnings(kind, main.images));
  if (kind === 'double_sided') warnings.push(...dsWithoutFrontWarning(main.images, partner.images));
  if (kind === 'back') warnings.push(...multipleBacksWarning(resolveBackFrom(backSetting(deps), main.images), main.images));
  warnings.push(...unsupportedWarning(kind, main.others));
  return {
    kind,
    dir,
    images,
    others: main.others.map((o) => ({ rel: o.rel, name: o.name, ext: o.ext, type: o.type, reason: otherReason(o) })),
    warnings,
    truncated: !!main.truncated,
  };
}

/**
 * Counts, common back status, warnings and trash size (spec §6 Summary).
 * Note: the spec lists `back` twice (a count and an object); `back` is the object and the count is
 * in `backCount` / `counts.back` (also `backs.length`).
 * @param {object} deps
 * @returns {Promise<{ front: number, double_sided: number, backCount: number, counts: object,
 *   backs: string[], back: { mode: string, file: string|null, effective: string|null, problem: null|'choose'|'missing' },
 *   warnings: CardWarning[], trashBatches: number }>}
 */
async function summary(deps) {
  const [front, back, ds, batches] = await Promise.all([
    scanKind(deps, 'front', { sizes: false }),
    scanKind(deps, 'back', { sizes: false }),
    scanKind(deps, 'double_sided', { sizes: false }),
    listBatchDirs(trashRoot(deps)),
  ]);
  const setting = backSetting(deps);
  const resolved = resolveBackFrom(setting, back.images);
  const warnings = [
    ...stemCollisionWarnings('front', front.images),
    ...unsupportedWarning('front', front.others),
    ...stemCollisionWarnings('double_sided', ds.images),
    ...dsWithoutFrontWarning(ds.images, front.images),
    ...unsupportedWarning('double_sided', ds.others),
    ...multipleBacksWarning(resolved, back.images),
    ...unsupportedWarning('back', back.others),
  ];
  return {
    front: front.images.length,
    double_sided: ds.images.length,
    backCount: back.images.length,
    counts: { front: front.images.length, back: back.images.length, double_sided: ds.images.length },
    backs: back.images.map((i) => i.rel),
    back: { mode: setting.mode, file: setting.file, effective: resolved.effective, problem: resolved.problem },
    warnings,
    trashBatches: batches.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------------------------

function sanitizeReason(reason) {
  const r = String(reason || 'removed').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return r || 'removed';
}

async function reserveBatchDir(root, reason) {
  await fsp.mkdir(root, { recursive: true });
  const stamp = util.timestampId(new Date());
  for (let n = 1; n < 100000; n += 1) {
    const id = `${stamp}-${reason}-${n}`;
    try {
      await fsp.mkdir(path.join(root, id));
      return id;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
  }
  throw new Error('Could not create a trash folder');
}

function normalizeTrashItems(deps, items) {
  const out = [];
  const seen = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !TRASH_KINDS.includes(it.kind) || typeof it.rel !== 'string' || !it.rel) continue;
    const rel = util.toPosix(it.rel).replace(/^\/+/, '');
    util.resolveInside(kindDir(deps, it.kind), rel); // throws on escape
    const key = `${it.kind}|${process.platform === 'win32' ? rel.toLowerCase() : rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: it.kind, rel });
  }
  return out;
}

/**
 * Move files to a new trash batch (no BUSY check: also used inside jobs).
 * @param {object} deps
 * @param {Array<{ kind: string, rel: string }>} items
 * @param {string} reason slug (removed, cleared, before-download, …)
 * @param {{ meta?: object }} [options] extra batch.json fields (e.g. backSetting)
 * @returns {Promise<{ batchId: string|null, moved: Array<{kind: string, rel: string}>, failed: Array<{kind: string, rel: string, error: Error}> }>}
 */
async function trashItems(deps, items, reason, { meta } = {}) {
  const list = normalizeTrashItems(deps, items);
  if (!list.length) return { batchId: null, moved: [], failed: [] };
  const root = trashRoot(deps);
  const slug = sanitizeReason(reason);
  const batchId = await reserveBatchDir(root, slug);
  const batchDir = path.join(root, batchId);
  const moved = [];
  const failed = [];
  for (const it of list) {
    const src = util.resolveInside(kindDir(deps, it.kind), it.rel);
    const dest = path.join(batchDir, it.kind, ...it.rel.split('/'));
    try {
      await util.moveFile(src, dest);
      moved.push(it);
    } catch (err) {
      if (err && err.code === 'ENOENT') continue; // already gone
      failed.push({ ...it, error: err });
    }
  }
  if (!moved.length) {
    await fsp.rm(batchDir, { recursive: true, force: true }).catch(() => {});
    return { batchId: null, moved, failed };
  }
  const batch = { reason: slug, at: new Date().toISOString(), items: moved, ...(meta && typeof meta === 'object' ? meta : {}) };
  await util.atomicWriteFile(path.join(batchDir, BATCH_FILE), `${JSON.stringify(batch, null, 2)}\n`);
  for (const kind of TRASH_KINDS) {
    const relDirs = moved.filter((m) => m.kind === kind).map((m) => posixDirname(m.rel));
    if (relDirs.length && kind !== 'decklist') await pruneEmptyParents(kindDir(deps, kind), relDirs);
  }
  return { batchId, moved, failed };
}

/**
 * Move files to the trash (spec §12). No BUSY check (callers check; jobs use it too).
 * Throws when nothing could be moved because files are locked; partial failures are logged.
 * @param {object} deps
 * @param {Array<{ kind: 'front'|'back'|'double_sided'|'decklist', rel: string }>} items
 * @param {string} reason
 * @returns {Promise<string|null>} batchId (null when there was nothing to move)
 */
async function moveToTrash(deps, items, reason) {
  const r = await trashItems(deps, items, reason);
  if (r.failed.length) {
    if (!r.moved.length) throw lockedFilesError(r.failed);
    logger(deps).warn(`[cards] ${r.failed.length} file(s) could not be moved to the trash:`, r.failed.map((f) => `${f.kind}/${f.rel}`).join(', '));
  }
  return r.batchId;
}

async function walkFiles(dir, rel = '', out = [], depth = 0) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(dir, ...rel.split('/').filter(Boolean)), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (depth < 64) await walkFiles(dir, childRel, out, depth + 1);
    } else {
      out.push(childRel);
    }
  }
  return out;
}

async function listBatchDirs(root) {
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function timeFromBatchId(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Read batch.json, or rebuild the item list from the folder when it is missing/damaged. */
async function readBatch(root, batchId) {
  const dir = path.join(root, batchId);
  const data = util.readJson(path.join(dir, BATCH_FILE), null);
  const files = [];
  for (const kind of TRASH_KINDS) {
    for (const rel of await walkFiles(path.join(dir, kind))) files.push({ kind, rel });
  }
  const onDisk = new Set(files.map((f) => `${f.kind}|${f.rel}`));
  let items;
  if (data && Array.isArray(data.items)) {
    items = data.items.filter((i) => i && TRASH_KINDS.includes(i.kind) && typeof i.rel === 'string' && onDisk.has(`${i.kind}|${i.rel}`));
    const listed = new Set(items.map((i) => `${i.kind}|${i.rel}`));
    for (const f of files) if (!listed.has(`${f.kind}|${f.rel}`)) items.push(f); // files not in batch.json
  } else {
    items = files;
  }
  let at = data && data.at !== undefined ? (typeof data.at === 'number' ? data.at : Date.parse(data.at)) : NaN;
  if (!Number.isFinite(at)) at = timeFromBatchId(batchId);
  if (!Number.isFinite(at)) {
    try {
      at = (await fsp.stat(dir)).mtimeMs;
    } catch {
      at = Date.now();
    }
  }
  const reasonFromId = /^\d{8}-\d{6}-(.+)-\d+$/.exec(batchId);
  return {
    batchId,
    dir,
    reason: (data && typeof data.reason === 'string' && data.reason) || (reasonFromId ? reasonFromId[1] : 'removed'),
    at,
    items,
    backSetting: data && data.backSetting && typeof data.backSetting === 'object' ? data.backSetting : null,
    raw: data,
  };
}

/**
 * Delete trash batches older than 14 days (never throws).
 * @param {object} deps
 * @param {{ now?: number }} [options]
 * @returns {Promise<number>} batches deleted
 */
async function pruneTrash(deps, { now = Date.now() } = {}) {
  const root = trashRoot(deps);
  let removed = 0;
  for (const id of await listBatchDirs(root)) {
    try {
      const batch = await readBatch(root, id);
      // An empty batch is only tidied up once it is clearly abandoned: a batch that is being
      // filled right now (trashItems reserves the folder, then moves the files in) must never be
      // deleted under it, or the files moved in meanwhile would be lost.
      if (now - batch.at > TRASH_MAX_AGE_MS || (batch.items.length === 0 && now - batch.at > EMPTY_BATCH_GRACE_MS)) {
        await fsp.rm(batch.dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed += 1;
      }
    } catch (err) {
      logger(deps).warn(`[cards] Could not prune trash batch ${id}:`, err && err.message);
    }
  }
  return removed;
}

/**
 * "Recently removed" batches, newest first (expired ones are deleted first).
 * @param {object} deps
 * @returns {Promise<Array<{ batchId: string, reason: string, label: string, at: string, count: number, kinds: string[], counts: Record<string, number>, files: string[] }>>}
 */
async function trashList(deps) {
  await pruneTrash(deps);
  const root = trashRoot(deps);
  const out = [];
  for (const id of await listBatchDirs(root)) {
    try {
      const batch = await readBatch(root, id);
      if (!batch.items.length) continue;
      const counts = {};
      for (const it of batch.items) counts[it.kind] = (counts[it.kind] || 0) + 1;
      out.push({
        batchId: id,
        reason: batch.reason,
        label: REASON_LABELS[batch.reason] || 'Removed files',
        at: new Date(batch.at).toISOString(),
        count: batch.items.length,
        kinds: TRASH_KINDS.filter((k) => counts[k]),
        counts,
        files: batch.items.slice(0, 20).map((i) => i.rel),
      });
    } catch (err) {
      logger(deps).warn(`[cards] Could not read trash batch ${id}:`, err && err.message);
    }
  }
  out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.batchId < b.batchId ? 1 : -1));
  return out;
}

function assertBatchId(batchId) {
  if (typeof batchId !== 'string' || !batchId || /[\\/]/.test(batchId) || /^[. ]+$/.test(batchId) || batchId.length > 200) {
    throw userError('This batch of removed cards is not valid.', { code: 'INVALID_ARGUMENT' });
  }
}

/** "(restored)", "(restored 2)", … stems. */
function restoredStem(stem, n) {
  return n === 1 ? `${stem} (restored)` : `${stem} (restored ${n})`;
}

/**
 * Put a trash batch back (no BUSY check; used inside jobs too). A file whose place is taken (same
 * name, or for cards the same name with another extension or in another sub-folder, which the
 * engine would treat as one card) gets a " (restored)" suffix; a front and its unique back in the
 * same batch get the same new name so they stay paired.
 * @returns {Promise<{ restored: number, renamed: Array<{ kind: string, from: string, to: string }>, failed: Array<{ kind: string, rel: string, reason: string }>, kinds: string[] }>}
 */
async function restoreBatchInternal(deps, batchId) {
  assertBatchId(batchId);
  const root = trashRoot(deps);
  const dir = path.join(root, batchId);
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    st = null;
  }
  if (!st || !st.isDirectory()) throw userError('These removed cards are no longer in the trash (it is emptied after 14 days).', { code: 'NOT_FOUND' });
  const batch = await readBatch(root, batchId);

  // What exists now (for conflicts and unique names). Fronts and unique backs share names.
  const scans = {};
  if (batch.items.some((i) => i.kind === 'front' || i.kind === 'double_sided')) {
    scans.front = await scanKind(deps, 'front', { sizes: false });
    scans.double_sided = await scanKind(deps, 'double_sided', { sizes: false });
  }
  if (batch.items.some((i) => i.kind === 'back')) scans.back = await scanKind(deps, 'back', { sizes: false });
  const existingRelNoExt = {};
  const existingStems = {}; // exact-case stems of the card images (the engine keys cards by stem, whole tree)
  const takenLower = new Set();
  for (const [kind, s] of Object.entries(scans)) {
    existingRelNoExt[kind] = new Set([...s.images, ...s.others].map((i) => (process.platform === 'win32' ? i.relNoExt.toLowerCase() : i.relNoExt)));
    if (kind !== 'back') {
      existingStems[kind] = new Set(s.images.map((i) => i.stem));
      for (const i of [...s.images, ...s.others]) takenLower.add(i.stem.toLowerCase());
    }
  }
  const keyOf = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const relParts = (rel) => {
    const name = path.posix.basename(rel);
    const { stem, suffix } = scan.nameParts(name);
    return { dir: posixDirname(rel), stem, suffix };
  };

  // Plan destinations.
  const plan = new Map(); // item -> dest rel
  const pairGroups = groupBy(batch.items.filter((i) => i.kind === 'front' || i.kind === 'double_sided').map((i) => {
    const { dir: d, stem } = relParts(i.rel);
    return { ...i, group: joinRel(d, stem), item: i };
  }), 'group');
  for (const [, members] of pairGroups) {
    const first = relParts(members[0].rel);
    const conflict = (stem) => members.some((m) => {
      const { dir: d, suffix } = relParts(m.rel);
      const relNoExt = joinRel(d, stem);
      if (existingRelNoExt[m.kind] && existingRelNoExt[m.kind].has(keyOf(relNoExt))) return true;
      // the same name in another sub-folder would make the engine print only one of them
      if (existingStems[m.kind] && existingStems[m.kind].has(stem)) return true;
      return fs.existsSync(path.join(kindDir(deps, m.kind), ...joinRel(d, `${stem}${suffix}`).split('/')));
    });
    let stem = first.stem;
    if (conflict(stem)) {
      for (let n = 1; n < 100000; n += 1) {
        const candidate = restoredStem(first.stem, n);
        if (!takenLower.has(candidate.toLowerCase()) && !conflict(candidate)) {
          stem = candidate;
          break;
        }
      }
    }
    takenLower.add(stem.toLowerCase());
    for (const m of members) {
      const { dir: d, suffix } = relParts(m.rel);
      plan.set(m.item, joinRel(d, `${stem}${suffix}`));
      if (existingRelNoExt[m.kind]) existingRelNoExt[m.kind].add(keyOf(joinRel(d, stem)));
    }
    for (const m of members) if (existingStems[m.kind]) existingStems[m.kind].add(stem);
  }
  for (const it of batch.items) {
    if (plan.has(it)) continue;
    const { dir: d, stem, suffix } = relParts(it.rel);
    const exists = (s) => {
      if (it.kind === 'back' && existingRelNoExt.back && existingRelNoExt.back.has(keyOf(joinRel(d, s)))) return true;
      return fs.existsSync(path.join(kindDir(deps, it.kind), ...joinRel(d, `${s}${suffix}`).split('/')));
    };
    let finalStem = stem;
    for (let n = 1; exists(finalStem) && n < 100000; n += 1) finalStem = restoredStem(stem, n);
    plan.set(it, joinRel(d, `${finalStem}${suffix}`));
    if (it.kind === 'back' && existingRelNoExt.back) existingRelNoExt.back.add(keyOf(joinRel(d, finalStem)));
  }

  // Move.
  const restoredItems = [];
  const renamed = [];
  const failed = [];
  for (const it of batch.items) {
    const destRel = plan.get(it);
    const src = path.join(dir, it.kind, ...it.rel.split('/'));
    const dest = util.resolveInside(kindDir(deps, it.kind), destRel);
    try {
      if (fs.existsSync(dest)) throw Object.assign(new Error('A file with this name appeared meanwhile'), { code: 'EEXIST' });
      await util.moveFile(src, dest);
      restoredItems.push(it);
      if (destRel !== it.rel) renamed.push({ kind: it.kind, from: it.rel, to: destRel });
    } catch (err) {
      failed.push({ kind: it.kind, rel: it.rel, reason: err && err.code === 'EEXIST' ? 'A file with this name already exists' : (err && err.message) || 'Could not be moved', error: err });
    }
  }

  // Update or delete the batch.
  if (!failed.length) {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } else {
    const remaining = batch.items.filter((i) => !restoredItems.includes(i));
    const data = { ...(batch.raw && typeof batch.raw === 'object' ? batch.raw : {}), reason: batch.reason, at: new Date(batch.at).toISOString(), items: remaining };
    await util.atomicWriteFile(path.join(dir, BATCH_FILE), `${JSON.stringify(data, null, 2)}\n`).catch(() => {});
    for (const kind of TRASH_KINDS) await pruneEmptyParents(path.join(dir, kind), restoredItems.filter((m) => m.kind === kind).map((m) => posixDirname(m.rel)));
  }

  // Bring back the chosen common back when the removal had reset it.
  if (batch.backSetting && batch.backSetting.mode === 'file' && batch.backSetting.file) {
    const current = backSetting(deps);
    const restoredBack = restoredItems.find((i) => i.kind === 'back' && i.rel === batch.backSetting.file);
    if (restoredBack && current.mode === 'auto' && !current.file) {
      setBackSetting(deps, { mode: 'file', file: plan.get(restoredBack) });
    }
  }
  if (!restoredItems.length && failed.length) throw lockedFilesError(failed.map((f) => ({ ...f, error: f.error })));
  return {
    restored: restoredItems.length,
    renamed,
    failed: failed.map(({ kind, rel, reason }) => ({ kind, rel, reason })),
    kinds: [...new Set(restoredItems.map((i) => i.kind))],
  };
}

/**
 * Restore a "Recently removed" batch (spec §6).
 * @param {object} deps
 * @param {string} batchId
 * @returns {Promise<{ restored: number, renamed: Array<{ kind: string, from: string, to: string }>, failed: Array<{ kind: string, rel: string, reason: string }> }>}
 */
async function restoreBatch(deps, batchId) {
  assertCanMutate(deps);
  const result = await restoreBatchInternal(deps, batchId);
  notifyChanged(deps, { reason: 'restore', kinds: result.kinds });
  return result;
}

/**
 * Permanently delete every trash batch.
 * @param {object} deps
 * @returns {Promise<{ removed: number, batches: number }>} removed = files deleted
 */
async function emptyTrash(deps) {
  assertCanMutate(deps);
  const root = trashRoot(deps);
  let removed = 0;
  let batches = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return { removed: 0, batches: 0 };
  }
  const failures = [];
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    try {
      if (entry.isDirectory()) {
        const files = (await walkFiles(full)).filter((rel) => rel !== BATCH_FILE);
        await fsp.rm(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        removed += files.length;
        batches += 1;
      } else {
        await fsp.rm(full, { force: true });
      }
    } catch (err) {
      failures.push({ name: entry.name, error: err });
    }
  }
  if (failures.length && !batches) {
    throw userError('The trash could not be emptied. A file in it may be open in another program; close it and try again.', {
      code: 'FILE_LOCKED',
      details: failures.map((f) => `${f.name}: ${f.error && f.error.message}`).join('\n'),
    });
  }
  return { removed, batches };
}

// ---------------------------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------------------------

async function sniffFile(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return sniffImageType(buf.subarray(0, bytesRead));
  } finally {
    await fh.close().catch(() => {});
  }
}

/** Copy without ever overwriting: picks the next free stem on EEXIST. */
async function copyUnique(src, dir, stem, ext, takenLower, extraTargets = []) {
  let candidate = stem;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const free = !takenLower.has(candidate.toLowerCase())
      && !fs.existsSync(path.join(dir, ext ? `${candidate}.${ext}` : candidate))
      && !extraTargets.some((t) => fs.existsSync(path.join(t.dir, t.ext ? `${candidate}.${t.ext}` : candidate)));
    if (!free) {
      candidate = nextFreeStem(candidate, takenLower, [{ dir, ext }, ...extraTargets]);
      continue;
    }
    const dest = path.join(dir, ext ? `${candidate}.${ext}` : candidate);
    try {
      await fsp.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      takenLower.add(candidate.toLowerCase());
      return { dest, stem: candidate };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      takenLower.add(candidate.toLowerCase());
    }
  }
  throw new Error(`Could not find a free name for "${stem}"`);
}

async function expandSources(paths) {
  const files = [];
  const skipped = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (files.length >= MAX_ADD_FILES) {
      skipped.push({ path: p, reason: `Only ${MAX_ADD_FILES} images can be added at once` });
      continue;
    }
    if (typeof p !== 'string' || p === '') {
      skipped.push({ path: '', reason: 'Save the image to your computer first' });
      continue;
    }
    let st;
    try {
      st = await fsp.stat(p);
    } catch (err) {
      skipped.push({ path: p, reason: err && err.code === 'ENOENT' ? 'File not found' : 'This file could not be read' });
      continue;
    }
    if (st.isDirectory()) {
      const found = await scan.scanDir(p, { sizes: false, hash: false, maxFiles: MAX_ADD_FILES });
      for (const img of found.images) {
        if (files.length >= MAX_ADD_FILES) break;
        files.push({ abs: img.abs, type: img.type });
      }
      for (const other of found.others) skipped.push({ path: other.abs, reason: otherReason(other) });
      continue;
    }
    files.push({ abs: p, type: null });
  }
  return { files, skipped };
}

/**
 * Copy images into game/front or game/back (spec §9.5). Non-images are skipped with a reason;
 * folders are expanded; names are made unique across the whole folder tree (`card (2).png`) and
 * never contain `[ ] * ?`. Adding exactly one common back selects it.
 * @param {object} deps
 * @param {'front'|'back'} kind
 * @param {string[]} absPaths absolute paths ('' = an item dragged from a browser)
 * @returns {Promise<{ added: string[], skipped: Array<{ path: string, reason: string }> }>}
 */
async function addCards(deps, kind, absPaths) {
  assertKind(kind, ADD_KINDS);
  assertCanMutate(deps);
  const dir = kindDir(deps, kind);
  await fsp.mkdir(dir, { recursive: true });
  const existing = await scanKind(deps, kind, { sizes: false });
  const takenLower = new Set([...existing.images, ...existing.others].map((i) => i.stem.toLowerCase()));
  const { files, skipped } = await expandSources(absPaths);
  const added = [];
  const resolvedDir = path.resolve(dir);
  for (const file of files) {
    try {
      const type = file.type || (await sniffFile(file.abs));
      if (!VALID_TYPES.has(type)) {
        skipped.push({ path: file.abs, reason: otherReason({ type }) });
        continue;
      }
      const parts = scan.nameParts(path.basename(file.abs));
      const ext = (parts.ext || TYPE_EXT[type] || 'png').replace(/[^a-z0-9]/g, '') || TYPE_EXT[type] || 'png';
      const { dest } = await copyUnique(file.abs, resolvedDir, safeStem(parts.stem), ext, takenLower);
      added.push(util.toPosix(path.relative(resolvedDir, dest)));
    } catch (err) {
      skipped.push({ path: file.abs, reason: err && err.code === 'ENOSPC' ? 'Your disk is full' : 'This file could not be copied' });
      logger(deps).warn(`[cards] Could not add ${file.abs}:`, err && err.message);
    }
  }
  if (kind === 'back' && added.length === 1) setBackSetting(deps, { mode: 'file', file: added[0] });
  if (added.length) notifyChanged(deps, { reason: 'add', kinds: [kind] });
  return { added, skipped };
}

async function findImage(deps, kind, rel, { sizes = false } = {}) {
  const s = await scanKind(deps, kind, { sizes });
  const item = findByRel(s.images, rel);
  return { item, scan: s };
}

function notFound(what = 'This card') {
  const many = /^These\b/.test(what);
  return userError(many
    ? `${what} are no longer in their folder. They may have been moved or removed.`
    : `${what} is no longer in its folder. It may have been moved or removed.`, { code: 'NOT_FOUND' });
}

/**
 * Move cards to the trash (spec §6). Removing a front also removes its unique back, unless
 * another remaining front shares that back.
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'} kind
 * @param {string[]} rels
 * @returns {Promise<{ removed: number, batchId: string|null, failed: Array<{ kind: string, rel: string }> }>}
 */
async function removeCards(deps, kind, rels) {
  assertKind(kind);
  assertCanMutate(deps);
  const s = await scanKind(deps, kind, { sizes: false });
  const all = [...s.images, ...s.others];
  const wanted = [];
  const requested = Array.isArray(rels) ? rels : [];
  for (const rel of requested) {
    const hit = findByRel(all, util.toPosix(String(rel)));
    if (hit && !wanted.includes(hit)) wanted.push(hit);
  }
  if (requested.length && !wanted.length) throw notFound(requested.length === 1 ? 'This card' : 'These cards');
  const items = wanted.map((i) => ({ kind, rel: i.rel }));
  if (kind === 'front' && wanted.length) {
    const ds = await scanKind(deps, 'double_sided', { sizes: false });
    const removedRel = new Set(wanted.map((i) => i.rel));
    const remainingRelNoExt = new Set(s.images.filter((i) => !removedRel.has(i.rel)).map((i) => i.relNoExt));
    const removedRelNoExt = new Set(wanted.map((i) => i.relNoExt));
    for (const d of ds.images) {
      if (removedRelNoExt.has(d.relNoExt) && !remainingRelNoExt.has(d.relNoExt)) items.push({ kind: 'double_sided', rel: d.rel });
    }
  }
  let meta;
  const setting = backSetting(deps);
  const removesChosenBack = kind === 'back' && setting.mode === 'file' && wanted.some((i) => i.rel === setting.file);
  if (removesChosenBack) meta = { backSetting: setting };
  const r = await trashItems(deps, items, 'removed', { meta });
  if (r.failed.length && !r.moved.length) throw lockedFilesError(r.failed);
  if (removesChosenBack && r.moved.some((m) => m.kind === 'back' && m.rel === setting.file)) setBackSetting(deps, { mode: 'auto', file: null });
  if (r.moved.length) notifyChanged(deps, { reason: 'remove', kinds: [...new Set(r.moved.map((m) => m.kind))] });
  return { removed: r.moved.length, batchId: r.batchId, failed: r.failed.map(({ kind: k, rel }) => ({ kind: k, rel })) };
}

/**
 * Move every file of a folder to the trash (images and unusable files; README placeholders stay).
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'} kind
 * @param {{ includePartners?: boolean }} [options] front only: also clear the unique backs
 * @returns {Promise<{ removed: number, batchId: string|null, failed: Array<{ kind: string, rel: string }> }>}
 */
async function clearCards(deps, kind, { includePartners = false } = {}) {
  assertKind(kind);
  assertCanMutate(deps);
  const kinds = kind === 'front' && includePartners ? ['front', 'double_sided'] : [kind];
  const items = [];
  for (const k of kinds) {
    const s = await scanKind(deps, k, { sizes: false });
    for (const i of [...s.images, ...s.others]) items.push({ kind: k, rel: i.rel });
  }
  const setting = backSetting(deps);
  const meta = kind === 'back' && setting.mode === 'file' ? { backSetting: setting } : undefined;
  const r = await trashItems(deps, items, 'cleared', { meta });
  if (r.failed.length && !r.moved.length) throw lockedFilesError(r.failed);
  if (kind === 'back' && r.moved.length && setting.mode === 'file') setBackSetting(deps, { mode: 'auto', file: null });
  if (r.moved.length) notifyChanged(deps, { reason: 'clear', kinds });
  return { removed: r.moved.length, batchId: r.batchId, failed: r.failed.map(({ kind: k, rel }) => ({ kind: k, rel })) };
}

/**
 * Add copies of a card next to it ("Card (2).png", …). A front's unique back is copied with the
 * same new name so the copies stay double-sided.
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'} kind
 * @param {string} rel
 * @param {number} [copies=1] 1..100
 * @returns {Promise<{ added: string[], partners: string[] }>}
 */
async function duplicateCard(deps, kind, rel, copies = 1) {
  assertKind(kind);
  assertCanMutate(deps);
  const n = Math.max(1, Math.min(MAX_COPIES, Number.isInteger(copies) ? copies : 1));
  const { item, scan: mainScan } = await findImage(deps, kind, util.toPosix(String(rel)));
  if (!item) throw notFound();
  const dir = kindDir(deps, kind);
  const takenLower = new Set([...mainScan.images, ...mainScan.others].map((i) => i.stem.toLowerCase()));
  let partner = null;
  let dsDir = null;
  if (kind === 'front') {
    const ds = await scanKind(deps, 'double_sided', { sizes: false });
    partner = ds.images.find((d) => d.relNoExt === item.relNoExt) || null;
    for (const i of [...ds.images, ...ds.others]) takenLower.add(i.stem.toLowerCase());
    dsDir = kindDir(deps, 'double_sided');
  }
  const subdir = posixDirname(item.rel);
  const absSub = path.join(dir, ...subdir.split('/').filter(Boolean));
  const dsSub = dsDir ? path.join(dsDir, ...subdir.split('/').filter(Boolean)) : null;
  const added = [];
  const partners = [];
  let base = safeStem(item.stem);
  for (let k = 0; k < n; k += 1) {
    const targets = [{ dir: absSub, ext: item.ext }];
    if (partner) targets.push({ dir: dsSub, ext: partner.ext });
    const stem = nextFreeStem(base, takenLower, targets);
    const dest = path.join(absSub, item.ext ? `${stem}.${item.ext}` : stem);
    await fsp.copyFile(item.abs, dest, fs.constants.COPYFILE_EXCL);
    takenLower.add(stem.toLowerCase());
    added.push(joinRel(subdir, path.basename(dest)));
    if (partner) {
      const pDest = path.join(dsSub, partner.ext ? `${stem}.${partner.ext}` : stem);
      try {
        await fsp.mkdir(dsSub, { recursive: true });
        await fsp.copyFile(partner.abs, pDest, fs.constants.COPYFILE_EXCL);
        partners.push(joinRel(subdir, path.basename(pDest)));
      } catch (err) {
        await fsp.rm(dest, { force: true }).catch(() => {});
        added.pop();
        throw err;
      }
    }
    base = stem;
  }
  notifyChanged(deps, { reason: 'duplicate', kinds: partner ? [kind, 'double_sided'] : [kind] });
  return { added, partners };
}

async function renameFile(fromAbs, toAbs) {
  if (fs.existsSync(toAbs) && !util.samePath(fromAbs, toAbs)) {
    throw Object.assign(new Error(`${toAbs} already exists`), { code: 'EEXIST' });
  }
  await util.moveFile(fromAbs, toAbs);
}

/** One renaming pass over `kind` (with partners in `otherKind`). */
async function fixKindCollisions(deps, kind, otherKind) {
  const main = await scanKind(deps, kind, { sizes: false });
  const other = otherKind ? await scanKind(deps, otherKind, { sizes: false }) : { images: [], others: [] };
  const takenLower = new Set([...main.images, ...main.others, ...other.images, ...other.others].map((i) => i.stem.toLowerCase()));
  const mainByRelNoExt = groupBy(main.images, 'relNoExt');
  const otherByRelNoExt = groupBy(other.images, 'relNoExt');
  const dir = kindDir(deps, kind);
  const otherDir = otherKind ? kindDir(deps, otherKind) : null;
  const renamed = [];
  for (const [, list] of groupBy(main.images, 'stem')) {
    if (list.length < 2) continue;
    for (const item of list.slice(1)) {
      const subdir = posixDirname(item.rel);
      const absSub = path.join(dir, ...subdir.split('/').filter(Boolean));
      const sharedPartner = (mainByRelNoExt.get(item.relNoExt) || []).length > 1;
      const partners = sharedPartner ? [] : otherByRelNoExt.get(item.relNoExt) || [];
      const targets = [{ dir: absSub, ext: item.ext }];
      for (const p of partners) targets.push({ dir: path.join(otherDir, ...posixDirname(p.rel).split('/').filter(Boolean)), ext: p.ext });
      const stem = nextFreeStem(safeStem(item.stem), takenLower, targets);
      const newRel = joinRel(subdir, item.ext ? `${stem}.${item.ext}` : stem);
      await renameFile(item.abs, path.join(absSub, path.posix.basename(newRel)));
      takenLower.add(stem.toLowerCase());
      renamed.push({ kind, from: item.rel, to: newRel });
      for (const p of partners) {
        const pSub = posixDirname(p.rel);
        const pRel = joinRel(pSub, p.ext ? `${stem}.${p.ext}` : stem);
        try {
          await renameFile(p.abs, path.join(otherDir, ...pRel.split('/')));
          renamed.push({ kind: otherKind, from: p.rel, to: pRel, partner: true });
        } catch (err) {
          logger(deps).warn(`[cards] Could not rename the partner ${p.rel}:`, err && err.message);
        }
      }
    }
  }
  return renamed;
}

/**
 * Give every image a unique name (spec §9.5): for each group of images sharing an exact-case
 * stem anywhere in the folder tree, the first (natural order) keeps its name and the others become
 * "<stem> (2)", "<stem> (3)", … together with their partners. Fronts and unique backs are both
 * fixed (starting with `kind`) so the PDF can be made afterwards.
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'} kind
 * @returns {Promise<{ renamed: Array<{ kind: string, from: string, to: string, partner?: boolean }> }>}
 */
async function fixCollisions(deps, kind) {
  assertKind(kind);
  assertCanMutate(deps);
  const renamed = [];
  if (kind === 'back') {
    renamed.push(...await fixKindCollisions(deps, 'back', null));
  } else {
    const other = kind === 'front' ? 'double_sided' : 'front';
    renamed.push(...await fixKindCollisions(deps, kind, other));
    renamed.push(...await fixKindCollisions(deps, other, kind));
  }
  if (renamed.length) notifyChanged(deps, { reason: 'rename', kinds: [...new Set(renamed.map((r) => r.kind))] });
  return { renamed };
}

/**
 * Choose the common back (spec §6).
 * @param {object} deps
 * @param {{ mode: 'auto'|'file'|'none', file?: string|null }} value
 * @returns {Promise<object>} the new summary
 */
async function setBack(deps, value) {
  assertCanMutate(deps);
  const mode = value && BACK_MODES.includes(value.mode) ? value.mode : null;
  if (!mode) throw userError('Unknown common back choice.', { code: 'INVALID_ARGUMENT' });
  let file = null;
  if (mode === 'file') {
    const rel = value && typeof value.file === 'string' ? util.toPosix(value.file) : '';
    if (!rel) throw userError('Choose a back image.', { code: 'INVALID_ARGUMENT' });
    util.resolveInside(kindDir(deps, 'back'), rel);
    const { item } = await findImage(deps, 'back', rel);
    if (!item) throw userError('That back image is no longer in the Common back folder.', { code: 'NOT_FOUND' });
    file = item.rel;
  }
  setBackSetting(deps, { mode, file });
  notifyChanged(deps, { reason: 'back', kinds: ['back'] });
  return summary(deps);
}

/**
 * Give a front its own unique back: the image is copied to
 * `double_sided/<front relNoExt>.<ext>`; a previous unique back goes to the trash.
 * @param {object} deps
 * @param {string} frontRel
 * @param {string} absPath image to use
 * @returns {Promise<{ rel: string, replacedBatchId: string|null }>}
 */
async function setPartnerBack(deps, frontRel, absPath) {
  assertCanMutate(deps);
  const { item: front } = await findImage(deps, 'front', util.toPosix(String(frontRel)));
  if (!front) throw notFound('This front image');
  if (typeof absPath !== 'string' || !absPath) throw userError('Save the image to your computer first.', { code: 'NOT_A_FILE' });
  let st;
  try {
    st = await fsp.stat(absPath);
  } catch {
    throw userError('The chosen back image could not be found.', { code: 'NOT_FOUND' });
  }
  if (!st.isFile()) throw userError('Choose an image file, not a folder.', { code: 'NOT_A_FILE' });
  const type = await sniffFile(absPath);
  if (!VALID_TYPES.has(type)) throw userError(`${path.basename(absPath)}: ${otherReason({ type })}.`, { code: 'NOT_AN_IMAGE' });
  const dsDir = kindDir(deps, 'double_sided');
  const ds = await scanKind(deps, 'double_sided', { sizes: false });
  // Everything named like the front is in the way (also unreadable files with that name).
  const current = [...ds.images, ...ds.others].filter((d) => d.relNoExt === front.relNoExt);
  const same = current.find((d) => util.samePath(d.abs, absPath));
  if (same && current.length === 1) return { rel: same.rel, replacedBatchId: null };
  const srcExt = scan.nameParts(path.basename(absPath)).ext.replace(/[^a-z0-9]/g, '') || TYPE_EXT[type] || 'png';
  const destRel = `${front.relNoExt}.${srcExt}`;
  const dest = util.resolveInside(dsDir, destRel);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  // A file in the way that is not one of the backs being replaced (e.g. "X.png" for the front
  // "x.png" on Windows): refuse before anything is moved to the trash.
  if (fs.existsSync(dest) && !current.some((d) => util.samePath(d.abs, dest))) {
    throw lockedFilesError([{ kind: 'double_sided', rel: destRel, error: Object.assign(new Error('exists'), { code: 'EEXIST' }) }]);
  }
  // Copy first (the source may be one of the files about to be replaced), then swap.
  const tmp = path.join(path.dirname(dest), `.scm-partner-${process.pid}-${Date.now().toString(36)}.tmp`);
  await fsp.copyFile(absPath, tmp);
  let replacedBatchId = null;
  try {
    if (current.length) {
      const r = await trashItems(deps, current.map((d) => ({ kind: 'double_sided', rel: d.rel })), 'replaced');
      if (r.failed.length) {
        if (r.batchId) await restoreBatchInternal(deps, r.batchId).catch(() => {});
        throw lockedFilesError(r.failed);
      }
      replacedBatchId = r.batchId;
    }
    if (fs.existsSync(dest)) throw lockedFilesError([{ kind: 'double_sided', rel: destRel, error: Object.assign(new Error('exists'), { code: 'EEXIST' }) }]);
    await util.moveFile(tmp, dest);
  } finally {
    await fsp.rm(tmp, { force: true }).catch(() => {});
  }
  notifyChanged(deps, { reason: 'partner', kinds: ['double_sided'] });
  return { rel: destRel, replacedBatchId };
}

/**
 * Remove a front's unique back (to the trash).
 * @param {object} deps
 * @param {string} frontRel
 * @returns {Promise<{ batchId: string|null, removed: number }>}
 */
async function removePartnerBack(deps, frontRel) {
  assertCanMutate(deps);
  const rel = util.toPosix(String(frontRel));
  const { item: front } = await findImage(deps, 'front', rel);
  // The front may already be gone: its unique back is still found by the same relative path.
  const relNoExt = front ? front.relNoExt : joinRel(posixDirname(rel), scan.nameParts(path.posix.basename(rel)).stem);
  const ds = await scanKind(deps, 'double_sided', { sizes: false });
  const partners = ds.images.filter((d) => d.relNoExt === relNoExt);
  if (!partners.length) return { batchId: null, removed: 0 };
  const r = await trashItems(deps, partners.map((d) => ({ kind: 'double_sided', rel: d.rel })), 'removed');
  if (r.failed.length && !r.moved.length) throw lockedFilesError(r.failed);
  if (r.moved.length) notifyChanged(deps, { reason: 'remove', kinds: ['double_sided'] });
  return { batchId: r.batchId, removed: r.moved.length };
}

/**
 * Open a card folder (or the deck lists / PDF output folder) in Explorer.
 * @param {object} deps
 * @param {'front'|'back'|'double_sided'|'decklist'|'output'} kind
 * @returns {Promise<true>}
 */
async function openFolder(deps, kind) {
  assertKind(kind, OPEN_KINDS);
  const dir = kindDir(deps, kind);
  await fsp.mkdir(dir, { recursive: true });
  const open = typeof deps.openPath === 'function' ? deps.openPath : null;
  if (!open) throw userError('Opening folders is not available.', { code: 'SERVICE_UNAVAILABLE' });
  const err = await open(dir);
  if (err) throw userError(`Windows could not open the folder: ${err}`, { code: 'OPEN_FAILED', details: `${dir}\n${err}` });
  return true;
}

// ---------------------------------------------------------------------------------------------
// Test cards (job 'samples')
// ---------------------------------------------------------------------------------------------

function formatMm(n) {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/** The current card size in mm: introspection when available, else the built-in table. */
async function currentCardSize(deps) {
  const s = deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : {};
  const requested = (s && s.pdf && s.pdf.options && typeof s.pdf.options.card_size === 'string' && s.pdf.options.card_size) || 'standard';
  let sizes = null;
  let aliases = FALLBACK_CARD_ALIASES;
  try {
    if (deps.helper && typeof deps.helper.introspect === 'function') {
      const intro = await deps.helper.introspect({});
      if (intro && intro.layouts && Array.isArray(intro.layouts.cardSizes)) {
        sizes = intro.layouts.cardSizes;
        if (intro.layouts.aliases && intro.layouts.aliases.card) aliases = intro.layouts.aliases.card;
      }
    }
  } catch (err) {
    logger(deps).warn('[cards] Card sizes are not available from the card maker; using the built-in list:', err && err.message);
  }
  const name = aliases[requested] || requested;
  if (sizes) {
    const hit = sizes.find((c) => c.name === name) || sizes.find((c) => Array.isArray(c.aliases) && c.aliases.includes(requested));
    if (hit && Number.isFinite(hit.widthMm) && Number.isFinite(hit.heightMm) && hit.widthMm > 0 && hit.heightMm > 0) {
      return { name: hit.name, widthMm: hit.widthMm, heightMm: hit.heightMm };
    }
  }
  const mm = FALLBACK_CARD_SIZES[name] || FALLBACK_CARD_SIZES.standard;
  return { name: FALLBACK_CARD_SIZES[name] ? name : 'standard', widthMm: mm[0], heightMm: mm[1] };
}

function friendlySizeName(name) {
  return String(name).replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * Start the job that makes test cards (spec §13.1): ~9 numbered high-contrast cards at the
 * current card size (300 PPI) plus one "TEST BACK". With `replace`, the current fronts, unique
 * backs and common backs first go to the trash (put back automatically if the job fails). The
 * common back mode becomes 'auto'. Without `replace`, an existing common back is kept and no
 * test back is added.
 * @param {object} deps
 * @param {{ replace?: boolean }} [options]
 * @returns {string} jobId
 */
function startSamplesJob(deps, { replace = false } = {}) {
  if (!deps.jobs || typeof deps.jobs.start !== 'function') throw userError('The task runner is not available.', { code: 'SERVICE_UNAVAILABLE' });
  return deps.jobs.start('samples', {
    title: 'Making test cards',
    steps: [
      { id: 'prepare', label: replace ? 'Setting your current cards aside' : 'Preparing' },
      { id: 'generate', label: 'Drawing the test cards' },
      { id: 'copy', label: 'Adding them to your cards' },
    ],
  }, (ctx) => runSamples(ctx, deps, { replace: !!replace }));
}

async function assertHelperPresent(p) {
  try {
    await fsp.access(p.helperScript);
  } catch {
    throw userError('A part of Silhouette Card Maker is missing (scm_helper.py). Please reinstall the app.', { code: 'HELPER_MISSING', details: String(p.helperScript) });
  }
}

/**
 * Run an scm_helper.py subcommand inside a job (through ctx.spawn: logged, cancellable). Used for
 * make-test-cards, which helper.run() does not list. Resolves with the result JSON.
 */
async function runHelperInJob(ctx, deps, sub, args, { timeoutMs = 120000 } = {}) {
  const p = deps.getPaths();
  await assertHelperPresent(p);
  const outFile = path.join(p.scmCacheDir, 'tmp', `helper-${sub}-${ctx.jobId}-${Date.now().toString(36)}.json`);
  await fsp.mkdir(path.dirname(outFile), { recursive: true });
  const argv = [p.helperScript, sub, '--root', p.workspaceDir, '--out', outFile, ...args];
  const spawnIt = () => ctx.spawn(p.pythonPath, argv, {
    cwd: p.workspaceDir, env: ctx.pythonEnv(), allowNonZero: true, timeoutMs, name: 'the card maker',
  });
  try {
    const res = deps.locks && typeof deps.locks.withPythonShared === 'function' ? await deps.locks.withPythonShared(spawnIt) : await spawnIt();
    const data = util.readJson(outFile, null);
    if (res.code === 0 && data && !data.error) return data;
    const err = new Error(data && data.error ? String(data.error) : `The card maker stopped with code ${res.code}`);
    err.traceback = data && data.traceback ? String(data.traceback) : (res.stderrTail || []).join('\n');
    err.stderrTail = res.stderrTail;
    err.exitCode = res.code;
    throw err;
  } finally {
    await fsp.rm(outFile, { force: true }).catch(() => {});
  }
}

async function runSamples(ctx, deps, { replace }) {
  const p = deps.getPaths();
  ctx.step('prepare', 'running');
  try {
    await fsp.access(p.pythonPath);
  } catch {
    throw userError('The card maker components are not installed yet. Open Setup to install them.', { code: 'NOT_INSTALLED' });
  }
  await assertHelperPresent(p);
  const size = await currentCardSize(deps);
  const widthPx = Math.max(32, Math.round((size.widthMm / 25.4) * SAMPLE_PPI));
  const heightPx = Math.max(32, Math.round((size.heightMm / 25.4) * SAMPLE_PPI));
  ctx.throwIfCancelled();

  let previousBatchId = null;
  if (replace) {
    const items = [];
    for (const kind of CARD_KINDS) {
      const s = await scanKind(deps, kind, { sizes: false });
      for (const i of [...s.images, ...s.others]) items.push({ kind, rel: i.rel });
    }
    const r = await trashItems(deps, items, 'before-samples', { meta: { backSetting: backSetting(deps) } });
    if (r.failed.length) {
      if (r.batchId) await restoreBatchInternal(deps, r.batchId).catch(() => {});
      throw lockedFilesError(r.failed);
    }
    previousBatchId = r.batchId;
    if (previousBatchId) ctx.log(`Your current cards were set aside (${r.moved.length} files).`);
  }
  const hadBack = !replace && (await scanKind(deps, 'back', { sizes: false })).images.length > 0;
  ctx.step('prepare', 'done');

  const tmp = path.join(p.scmCacheDir, 'tmp', `samples-${ctx.jobId}`);
  const tmpFront = path.join(tmp, 'front');
  const tmpBack = path.join(tmp, 'back');
  const created = [];
  try {
    ctx.step('generate', 'running');
    ctx.progress({ percent: null, label: `Drawing ${SAMPLE_COUNT} test cards (${formatMm(size.widthMm)} x ${formatMm(size.heightMm)} mm)` });
    await fsp.rm(tmp, { recursive: true, force: true });
    await fsp.mkdir(tmpFront, { recursive: true });
    const label = `${friendlySizeName(size.name)} · ${formatMm(size.widthMm)} x ${formatMm(size.heightMm)} mm`;
    const args = ['--dir', tmpFront, '--count', String(SAMPLE_COUNT), '--width-px', String(widthPx), '--height-px', String(heightPx), '--label', label];
    if (!hadBack) args.push('--back-dir', tmpBack);
    const data = await runHelperInJob(ctx, deps, 'make-test-cards', args);
    ctx.step('generate', 'done');
    ctx.throwIfCancelled();

    ctx.step('copy', 'running');
    const frontDir = kindDir(deps, 'front');
    await fsp.mkdir(frontDir, { recursive: true });
    const fronts = await scanKind(deps, 'front', { sizes: false });
    const takenLower = new Set([...fronts.images, ...fronts.others].map((i) => i.stem.toLowerCase()));
    const ds = await scanKind(deps, 'double_sided', { sizes: false });
    for (const i of [...ds.images, ...ds.others]) takenLower.add(i.stem.toLowerCase()); // never pair with an orphan unique back
    const frontRels = [];
    const files = Array.isArray(data.files) ? data.files : [];
    for (let i = 0; i < files.length; i += 1) {
      const src = files[i];
      const stem = scan.nameParts(path.basename(src)).stem;
      const { dest } = await copyUnique(src, frontDir, stem, 'png', takenLower);
      created.push(dest);
      frontRels.push(util.toPosix(path.relative(frontDir, dest)));
      ctx.progress({ current: i + 1, total: files.length, label: `Adding test card ${i + 1} of ${files.length}` });
    }
    let backRel = null;
    if (!hadBack && data.back) {
      const backDir = kindDir(deps, 'back');
      await fsp.mkdir(backDir, { recursive: true });
      const backs = await scanKind(deps, 'back', { sizes: false });
      const backTaken = new Set([...backs.images, ...backs.others].map((b) => b.stem.toLowerCase()));
      const { dest } = await copyUnique(data.back, backDir, 'Test back', 'png', backTaken);
      created.push(dest);
      backRel = util.toPosix(path.relative(backDir, dest));
      setBackSetting(deps, { mode: 'auto', file: null });
    }
    ctx.step('copy', 'done');
    notifyChanged(deps, { reason: 'samples', kinds: backRel ? ['front', 'back'] : ['front'] });
    return {
      added: frontRels.length,
      front: frontRels,
      back: backRel,
      previousBatchId,
      cardSize: size.name,
      widthMm: size.widthMm,
      heightMm: size.heightMm,
      widthPx,
      heightPx,
    };
  } catch (err) {
    for (const file of created) await fsp.rm(file, { force: true }).catch(() => {});
    if (previousBatchId) {
      try {
        await restoreBatchInternal(deps, previousBatchId);
        ctx.warn('Your previous cards were put back.');
      } catch (restoreErr) {
        ctx.warn('Your previous cards could not be put back automatically. Restore them from "Recently removed" in Your cards.');
        logger(deps).warn('[cards] Restoring the previous cards failed:', restoreErr && restoreErr.message);
      }
    }
    throw err;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = {
  // spec §12
  listCards,
  summary,
  addCards,
  removeCards,
  clearCards,
  duplicateCard,
  fixCollisions,
  setBack,
  resolveBack,
  setPartnerBack,
  removePartnerBack,
  trashList,
  restoreBatch,
  emptyTrash,
  moveToTrash,
  startSamplesJob,
  openFolder,
  startWatching,
  // extras (fetch.js, decklists.js, tests)
  trashItems,
  restoreBatchInternal,
  pruneTrash,
  notifyChanged,
  assertCanMutate,
  resolveBackFrom,
  currentCardSize,
  CARD_KINDS,
  TRASH_KINDS,
  REASON_LABELS,
  TRASH_MAX_AGE_MS,
};
