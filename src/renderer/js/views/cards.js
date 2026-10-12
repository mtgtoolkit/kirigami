/**
 * "Your cards" view (`#/cards`, spec §8.4 "Your cards", §13.3).
 *
 * Lets the user review the card images before making the PDF:
 * - tabs Fronts | Common back (all cards) | Unique backs (double-faced cards); `params.tab`
 *   ('front' | 'back' | 'double_sided') selects the initial tab;
 * - a grid of lazily loaded full-file images (CardImage.url), sized by settings.ui.thumbSize and
 *   grouped by content hash (settings.ui.groupIdentical) with a ×N badge;
 * - per-card badges: low resolution (effective PPI = width px / card width in), shape mismatch with
 *   "Image shape: Stretch", Upscaled, Unique back;
 * - tile actions View / +1 copy / −1 copy / Remove (moved to Recently removed, toast with Undo);
 * - toolbar: Add images…, drag & drop, Open folder, Remove all, Group identical, thumbnail size;
 * - callouts for name collisions (one-click "Fix names automatically"), unique backs without a
 *   front, unsupported files and an unchosen common back;
 * - the common back picker, the unique back pairs, and the "Recently removed" panel.
 *
 * Every mutation is disabled while a job runs (the main process refuses them anyway). Lists are
 * fetched again whenever the store's `cards.version` changes.
 *
 * Besides the view (default export) this module exports pure helpers (unit-tested) and
 * {@link openCardPicker}, which the Upscale view reuses for "Try on one card".
 *
 * @module views/cards
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { nextStep } from '../components/next-step.js';
import { getCardSize, resolveCardSize, describeCardSize } from '../data/option-docs.js';

const { h, icon } = ui;

/* ------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** Card folders shown by this view, in tab order. */
export const CARD_KINDS = Object.freeze(['front', 'back', 'double_sided']);

/** Tab labels (spec §8.4 copy rules). */
export const TAB_LABELS = Object.freeze({
  front: 'Fronts',
  back: 'Common back (all cards)',
  double_sided: 'Unique backs (double-faced cards)',
});

/** Below this effective resolution a card "may print blurry" (warning badge). */
export const LOW_RES_WARN_PPI = 150;
/** Below this effective resolution a card gets an informational "Low resolution" badge. */
export const LOW_RES_INFO_PPI = 250;
/** Shape difference (fraction) above which a stretched image is flagged. */
export const ASPECT_TOLERANCE = 0.08;

/** Extensions offered by the "Add images" dialogs (every type the card maker can read). */
export const IMAGE_EXTENSIONS = Object.freeze(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'avif', 'jp2', 'j2k', 'jpf', 'jpx']);

const IMAGE_FILTERS = [
  { name: 'Card images', extensions: [...IMAGE_EXTENSIONS] },
  { name: 'All files', extensions: ['*'] },
];

const THUMB_MIN = 90;
const THUMB_MAX = 280;
const THUMB_DEFAULT = 150;
/** Groups rendered at first; more are appended while scrolling (big decks stay responsive). */
const PAGE_SIZE = 120;
/** Trash batches listed before "Show all". */
const TRASH_PREVIEW = 4;

/** The app's copy is English: dates use English words whatever the system language. */
const DATE_LOCALE = 'en-US';

/** Short folder names for "Recently removed" rows. */
const TRASH_KIND_WORDS = Object.freeze({ front: 'fronts', back: 'common backs', double_sided: 'unique backs', decklist: 'deck lists' });

const KIND_WORDS = Object.freeze({
  front: { one: 'front image', many: 'front images', folder: 'fronts folder' },
  back: { one: 'back image', many: 'back images', folder: 'common backs folder' },
  double_sided: { one: 'unique back', many: 'unique backs', folder: 'unique backs folder' },
  decklist: { one: 'deck list', many: 'deck lists', folder: 'deck lists folder' },
});

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for unit tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Normalize a `params.tab` value to a card kind.
 * @param {unknown} value e.g. 'back', 'double_sided', 'unique', 'fronts'
 * @returns {'front'|'back'|'double_sided'}
 */
export function normalizeTab(value) {
  const v = String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (['back', 'backs', 'common', 'common_back', 'common_backs'].includes(v)) return 'back';
  if (['double_sided', 'doublesided', 'ds', 'unique', 'unique_back', 'unique_backs', 'double', 'partners', 'pairs'].includes(v)) return 'double_sided';
  return 'front';
}

/**
 * Python `Path(name).stem` (the engine pairs and de-duplicates files by stem).
 * @param {string} name file name without folders
 * @returns {string}
 */
export function pythonStem(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf('.');
  return i > 0 && i < s.length - 1 ? s.slice(0, i) : s;
}

/**
 * Last path segment of a POSIX relative path.
 * @param {string} rel
 * @returns {string}
 */
export function baseName(rel) {
  const s = String(rel ?? '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * Size of the cards the PDF will print, from the current PDF settings: the specialty layout's card
 * when one is chosen, else the card size (aliases resolved) from introspection, else the built-in
 * card size table.
 *
 * @param {object|null|undefined} settings
 * @param {object|null|undefined} introspection
 * @returns {{ name: string, widthMm: number, heightMm: number, label: string, specialty: string|null }}
 */
export function cardDimensions(settings, introspection) {
  const opts = settings?.pdf?.options || {};
  const layouts = introspection?.layouts || null;
  if (opts.specialty) {
    const name = String(opts.specialty);
    const sp = (layouts?.specialty || []).find((l) => l && (l.name === name || l.specialty === name || l.key === `specialty:${name}`));
    if (sp && Number(sp.cardWidthMm) > 0 && Number(sp.cardHeightMm) > 0) {
      const w = Number(sp.cardWidthMm);
      const hgt = Number(sp.cardHeightMm);
      return { name, widthMm: w, heightMm: hgt, label: `mini cards of the specialty layout (${trimMm(w)} x ${trimMm(hgt)} mm)`, specialty: name };
    }
  }
  const raw = String(opts.card_size || 'standard');
  const aliasMap = layouts?.aliases?.card && typeof layouts.aliases.card === 'object' ? layouts.aliases.card : {};
  const name = (Object.prototype.hasOwnProperty.call(aliasMap, raw) ? aliasMap[raw] : null) || resolveCardSize(raw) || raw;
  const known = getCardSize(name);
  const fromIntro = (layouts?.cardSizes || []).find((c) => c && c.name === name);
  if (fromIntro && Number(fromIntro.widthMm) > 0 && Number(fromIntro.heightMm) > 0) {
    const w = Number(fromIntro.widthMm);
    const hgt = Number(fromIntro.heightMm);
    return { name, widthMm: w, heightMm: hgt, label: known ? describeCardSize(name) : `${name} (${trimMm(w)} x ${trimMm(hgt)} mm)`, specialty: null };
  }
  if (known) return { name: known.name, widthMm: known.widthMm, heightMm: known.heightMm, label: describeCardSize(known.name), specialty: null };
  return { name: 'standard', widthMm: 63, heightMm: 88, label: describeCardSize('standard') || 'Standard (63 x 88 mm)', specialty: null };
}

/**
 * @param {number} mm
 * @returns {string}
 */
function trimMm(mm) {
  return String(Number(Number(mm).toFixed(1)));
}

/**
 * Effective print resolution of an image: pixels across the card width ÷ card width in inches.
 * @param {number|null|undefined} widthPx
 * @param {number|null|undefined} cardWidthMm
 * @returns {number|null} null when either value is unknown
 */
export function effectivePpi(widthPx, cardWidthMm) {
  const w = Number(widthPx);
  const mm = Number(cardWidthMm);
  if (!Number.isFinite(w) || !Number.isFinite(mm) || w <= 0 || mm <= 0) return null;
  return w / (mm / 25.4);
}

/**
 * How an image will print at the current card size (spec §8.4 per-card badges).
 *
 * @param {{ width?: number|null, height?: number|null }} image
 * @param {{ widthMm: number, heightMm: number }} dims
 * @param {string|null} [fit] 'stretch' (default) or 'crop'
 * @returns {{ ppi: number|null, resolution: 'ok'|'info'|'warning'|null, aspectOff: number|null, stretched: boolean, cropped: boolean, wider: boolean|null }}
 *   `aspectOff` = how much the picture's shape differs from the card's (0.12 = 12 %);
 *   `stretched` = it differs by more than 8 % and the image shape is Stretch.
 */
export function imageQuality(image, dims, fit = 'stretch') {
  const ppi = effectivePpi(image?.width, dims?.widthMm);
  let resolution = null;
  if (ppi !== null) resolution = ppi < LOW_RES_WARN_PPI ? 'warning' : ppi < LOW_RES_INFO_PPI ? 'info' : 'ok';
  let aspectOff = null;
  let wider = null;
  const w = Number(image?.width);
  const hgt = Number(image?.height);
  if (w > 0 && hgt > 0 && Number(dims?.widthMm) > 0 && Number(dims?.heightMm) > 0) {
    const ratio = w / hgt;
    const card = Number(dims.widthMm) / Number(dims.heightMm);
    aspectOff = Math.max(ratio / card, card / ratio) - 1;
    wider = ratio > card;
  }
  const off = aspectOff !== null && aspectOff > ASPECT_TOLERANCE;
  return { ppi, resolution, aspectOff, stretched: off && fit !== 'crop', cropped: off && fit === 'crop', wider };
}

/** Stems of copies made by the app: "Card (2)", "Card (restored)", "Card (restored 2)". */
const COPY_SUFFIX = / \((?:\d+|restored(?: \d+)?)\)$/;

/**
 * The image that stands for a group of identical copies: the original rather than a numbered copy
 * ("Island.png", not "Island (2).png" which sorts first), then the shortest name, then the first.
 * @template {{ rel: string, name?: string, stem?: string }} T
 * @param {T[]} images non-empty
 * @returns {T}
 */
export function groupRepresentative(images) {
  let best = images[0];
  let bestKey = null;
  images.forEach((img, i) => {
    const name = String(img.name || baseName(img.rel));
    const stem = String(img.stem || pythonStem(name));
    const key = [COPY_SUFFIX.test(stem) ? 1 : 0, name.length, i];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = img;
      bestKey = key;
    }
  });
  return best;
}

/**
 * Group identical images (same content hash, and the same unique back for fronts) so a deck with
 * 4 copies of a card shows one tile with "×4". Order follows the first copy of each group.
 * `main` is the copy shown for the group (see {@link groupRepresentative}); `spare` is the copy
 * removed by "−1" (the last one in natural order that is not `main`).
 *
 * @template {{ rel: string, hash?: string|null }} T
 * @param {T[]} images
 * @param {{ enabled?: boolean, partnerKey?: (img: T) => string }} [options]
 * @returns {Array<{ key: string, images: T[], first: T, last: T, main: T, spare: T, count: number }>}
 */
export function groupImages(images, { enabled = true, partnerKey } = {}) {
  const groups = [];
  const byKey = new Map();
  for (const img of Array.isArray(images) ? images : []) {
    if (!img || typeof img.rel !== 'string') continue;
    let key = null;
    if (enabled && typeof img.hash === 'string' && img.hash) {
      const pk = typeof partnerKey === 'function' ? String(partnerKey(img) || '') : '';
      key = `hash:${img.hash}|${pk}`;
    }
    if (key && byKey.has(key)) {
      byKey.get(key).images.push(img);
      continue;
    }
    const group = { key: key || `rel:${img.rel}`, images: [img] };
    if (key) byKey.set(key, group);
    groups.push(group);
  }
  return groups.map((g) => {
    const main = groupRepresentative(g.images);
    const rest = g.images.filter((img) => img !== main);
    return {
      key: g.key,
      images: g.images,
      first: g.images[0],
      last: g.images[g.images.length - 1],
      main,
      spare: rest.length ? rest[rest.length - 1] : main,
      count: g.images.length,
    };
  });
}

/**
 * A one-image "group" (for code paths that show a single image like a group).
 * @template T
 * @param {T & { rel: string }} img
 * @returns {{ key: string, images: T[], first: T, last: T, main: T, spare: T, count: number }}
 */
function singleGroup(img) {
  return { key: `rel:${img.rel}`, images: [img], first: img, last: img, main: img, spare: img, count: 1 };
}

/**
 * Group files whose names have the same stem (exact case), e.g. `Island.png` + `Island.jpg` or
 * `a/1.png` + `b/1.png` — the engine would print only one of them.
 * @param {string[]} files relative paths
 * @returns {Array<{ stem: string, files: string[] }>} only stems used more than once, in first-seen order
 */
export function collisionGroups(files) {
  const map = new Map();
  for (const rel of Array.isArray(files) ? files : []) {
    if (typeof rel !== 'string' || !rel) continue;
    const stem = pythonStem(baseName(rel));
    if (!map.has(stem)) map.set(stem, []);
    const list = map.get(stem);
    if (!list.includes(rel)) list.push(rel);
  }
  return [...map.entries()].filter(([, list]) => list.length > 1).map(([stem, list]) => ({ stem, files: list }));
}

/** Titles of the trash reasons recorded by the main process (cards.js / fetch.js / decklists.js). */
const TRASH_REASON_LABELS = Object.freeze({
  cleared: 'Removed all cards',
  'before-download': 'Cards set aside before a download',
  'incomplete-download': 'Images from an unfinished download',
  'before-samples': 'Cards set aside for the sample cards',
  replaced: 'Replaced unique back',
  decklist: 'Deleted deck list',
});

/**
 * Plain-language title of a "Recently removed" batch.
 * @param {string|null|undefined} reason batch reason recorded by the main process
 * @param {number} [count] number of files in the batch
 * @param {string|null} [serviceLabel] the `label` the service sent (used for reasons this view does not know)
 * @returns {string}
 */
export function trashReasonLabel(reason, count = 0, serviceLabel = null) {
  const r = String(reason ?? '').trim().toLowerCase();
  if (r === '' || r === 'removed') return count === 1 ? 'Removed image' : 'Removed images';
  if (Object.prototype.hasOwnProperty.call(TRASH_REASON_LABELS, r)) return TRASH_REASON_LABELS[r];
  if (typeof serviceLabel === 'string' && serviceLabel.trim()) return serviceLabel.trim();
  if (/incomplete|unfinished|partial/.test(r)) return TRASH_REASON_LABELS['incomplete-download'];
  if (/before[-_ ]?(download|fetch)|fetch|download/.test(r)) return TRASH_REASON_LABELS['before-download'];
  if (/sample|test/.test(r)) return TRASH_REASON_LABELS['before-samples'];
  if (/clear|remove[-_ ]?all|^all$/.test(r)) return TRASH_REASON_LABELS.cleared;
  if (/partner|unique|double|replace/.test(r)) return TRASH_REASON_LABELS.replaced;
  if (/deck/.test(r)) return TRASH_REASON_LABELS.decklist;
  return count === 1 ? 'Removed image' : 'Removed images';
}

/**
 * Shorten a name for titles and messages ("A very long card name…").
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function shortName(text, max = 60) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}

/**
 * Kinds of a trash batch as a list of kind names (`kinds` may be an array or a `{ kind: count }` map).
 * @param {unknown} kinds
 * @returns {string[]}
 */
export function trashKinds(kinds) {
  if (Array.isArray(kinds)) return kinds.map(String).filter(Boolean);
  if (kinds && typeof kinds === 'object') return Object.keys(kinds).filter((k) => kinds[k]);
  if (typeof kinds === 'string' && kinds) return [kinds];
  return [];
}

/**
 * Count from a service result that may be a number or a list (`{ removed: 3 }` / `{ removed: [...] }`).
 * @param {unknown} value
 * @returns {number}
 */
export function countOf(value) {
  if (Array.isArray(value)) return value.length;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Defensive CardList normalization (spec §6).
 * @param {unknown} raw
 * @param {string} kind
 * @returns {{ kind: string, dir: string|null, images: any[], others: any[], warnings: any[] }}
 */
export function normalizeCardList(raw, kind) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    kind: typeof r.kind === 'string' ? r.kind : kind,
    dir: typeof r.dir === 'string' ? r.dir : null,
    images: Array.isArray(r.images) ? r.images.filter((i) => i && typeof i.rel === 'string') : [],
    others: Array.isArray(r.others) ? r.others.filter((o) => o && typeof o.rel === 'string') : [],
    warnings: Array.isArray(r.warnings) ? r.warnings.filter((w) => w && typeof w === 'object') : [],
  };
}

/**
 * "745 × 1040 px" (or null when unknown).
 * @param {{ width?: number|null, height?: number|null }} img
 * @returns {string|null}
 */
export function pixelSize(img) {
  const w = Number(img?.width);
  const hgt = Number(img?.height);
  return w > 0 && hgt > 0 ? `${format.formatNumber(w)} × ${format.formatNumber(hgt)} px` : null;
}

/* ------------------------------------------------------------------------------------------------
 * Shared DOM helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} kind
 * @param {number} n
 * @returns {string}
 */
function kindWord(kind, n) {
  const w = KIND_WORDS[kind] || { one: 'image', many: 'images' };
  return `${format.formatNumber(n)} ${n === 1 ? w.one : w.many}`;
}

/**
 * Card-shaped image tile with the card's aspect ratio and the PDF's image shape applied.
 * @param {object} options imageTile options
 * @param {{ widthMm: number, heightMm: number }} dims
 * @param {string} [fit]
 * @returns {HTMLElement}
 */
function cardTile(options, dims, fit) {
  const tile = ui.imageTile(options);
  const frame = tile.querySelector('.img-tile-frame');
  if (frame && dims?.widthMm > 0 && dims?.heightMm > 0) frame.style.aspectRatio = `${dims.widthMm} / ${dims.heightMm}`;
  const img = tile.querySelector('.img-tile-media img');
  if (img) img.style.objectFit = fit === 'crop' ? 'cover' : 'fill';
  const count = tile.querySelector('.img-tile-count');
  if (frame && count && tile.querySelector('.img-tile-actions')) {
    // The hover actions sit where the "×N" badge is: fade the badge out while they are shown.
    count.style.transition = 'opacity 120ms ease';
    const sync = () => {
      count.style.opacity = frame.matches(':hover') || frame.contains(document.activeElement) ? '0' : '';
    };
    frame.addEventListener('pointerenter', () => { count.style.opacity = '0'; });
    frame.addEventListener('pointerleave', () => setTimeout(sync, 0));
    frame.addEventListener('focusin', () => { count.style.opacity = '0'; });
    frame.addEventListener('focusout', () => setTimeout(sync, 0));
  }
  return tile;
}

/**
 * Let the user pick one card image in a modal grid (used by "Set back for a card…" and by the
 * Upscale view's "Try on one card").
 *
 * @param {object} options
 * @param {Array<object>} options.images CardImage list
 * @param {string} [options.title]
 * @param {unknown} [options.message] explanation shown above the grid
 * @param {(img: object) => (string|null)} [options.badgeFor] optional badge text per image
 * @param {boolean} [options.unique] show identical images (same hash) only once
 * @param {{ widthMm: number, heightMm: number }} [options.dims] card shape for the tiles
 * @returns {Promise<object|null>} the chosen image, or null when cancelled
 */
export function openCardPicker({ images, title = 'Choose a card', message, badgeFor, unique = false, dims } = {}) {
  return new Promise((resolve) => {
    let chosen = null;
    let list = Array.isArray(images) ? images.filter((i) => i && typeof i.rel === 'string') : [];
    if (unique) list = groupImages(list, { enabled: true }).map((g) => g.main);
    const shape = dims && dims.widthMm > 0 ? dims : { widthMm: 63, heightMm: 88 };
    const limit = 240;
    const gridEl = h('div.thumb-grid', { style: { '--thumb-size': '104px' } });
    const countEl = h('div.small.muted');
    let dialog = null;
    const render = (query) => {
      const q = String(query || '').trim().toLowerCase();
      const matches = q ? list.filter((img) => String(img.name || img.rel).toLowerCase().includes(q)) : list;
      const shown = matches.slice(0, limit);
      ui.mountInto(gridEl, shown.map((img) => {
        const badgeText = typeof badgeFor === 'function' ? badgeFor(img) : null;
        return cardTile({
          src: img.url,
          alt: img.name || img.rel,
          title: img.name || baseName(img.rel),
          badges: badgeText ? [ui.badge(badgeText, 'neutral')] : [],
          fallbackText: String(img.ext || 'image').toUpperCase(),
          onOpen: () => {
            chosen = img;
            dialog?.close('picked');
          },
        }, shape, 'crop');
      }));
      if (!shown.length) gridEl.append(h('p.muted.small', q ? `No card name contains “${query}”.` : 'There are no cards to choose from.'));
      countEl.textContent = matches.length > limit
        ? `Showing ${format.formatNumber(limit)} of ${format.formatNumber(matches.length)} cards. Type part of a name to find others.`
        : '';
      countEl.hidden = !countEl.textContent;
    };
    const search = list.length > 12
      ? ui.textInput({ icon: 'search', type: 'search', placeholder: 'Search by name…', ariaLabel: 'Search cards by name', onInput: (v) => render(v) })
      : null;
    render('');
    dialog = ui.modal({
      title,
      wide: true,
      content: [
        message ? (typeof message === 'string' ? h('p', message) : message) : null,
        search,
        countEl,
        gridEl,
      ],
      actions: [{ label: 'Cancel', variant: 'secondary' }],
      onClose: () => resolve(chosen),
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {object|null} job store `job` entry
 * @returns {boolean}
 */
function isRunning(job) {
  return !!job && job.status === 'running';
}

export default {
  id: 'cards',
  title: 'Your cards',
  icon: 'images',

  /**
   * @param {HTMLElement} container
   * @param {object} ctx view context (spec §13.3)
   * @returns {() => void} unmount
   */
  mount(container, ctx) {
    const { api, store } = ctx;
    const refreshCards = () => (ctx.refresh && typeof ctx.refresh.cards === 'function' ? ctx.refresh.cards() : Promise.resolve());
    const navigate = (id, params) => ctx.navigate(id, params);
    const disposers = [];

    const state = {
      tab: normalizeTab(ctx.params?.tab),
      lists: { front: null, back: null, double_sided: null },
      errors: { front: null, back: null, double_sided: null },
      loading: true,
      loadedOnce: false,
      trash: [],
      trashError: null,
      trashExpanded: false,
      busy: isRunning(store.get('job')),
      visible: PAGE_SIZE,
    };

    /* ---------------- derived data ---------------- */

    const settings = () => store.get('settings') || {};
    const summary = () => store.get('cards')?.summary || null;
    const dims = () => cardDimensions(settings(), store.get('introspection'));
    const fitFor = (kind) => {
      const o = settings()?.pdf?.options || {};
      const front = o.fit === 'crop' ? 'crop' : 'stretch';
      if (kind === 'back') return o.fit_backs === 'crop' || o.fit_backs === 'stretch' ? o.fit_backs : front;
      return front;
    };
    const onlyFronts = () => settings()?.pdf?.options?.only_fronts !== false;
    const images = (kind) => state.lists[kind]?.images || [];

    /** Number of fronts that have a unique back. */
    const pairedCount = () => {
      const { backOf } = partnerMaps();
      return images('front').filter((f) => backOf(f)).length;
    };

    /** Front image → its unique back (DS image with the same relNoExt, exact case). */
    const partnerMaps = () => {
      const ds = images('double_sided');
      const fronts = images('front');
      const dsByRelNoExt = new Map(ds.map((d) => [d.relNoExt ?? d.rel.replace(/\.[^./]+$/, ''), d]));
      const dsByRel = new Map(ds.map((d) => [d.rel, d]));
      const frontByRelNoExt = new Map(fronts.map((f) => [f.relNoExt ?? f.rel.replace(/\.[^./]+$/, ''), f]));
      const frontByRel = new Map(fronts.map((f) => [f.rel, f]));
      return {
        backOf: (front) => (front.partner && dsByRel.get(front.partner)) || dsByRelNoExt.get(front.relNoExt) || null,
        frontOf: (back) => (back.partner && frontByRel.get(back.partner)) || frontByRelNoExt.get(back.relNoExt) || null,
      };
    };

    /* ---------------- skeleton ---------------- */

    const headerEl = ui.pageHeader({
      title: 'Your cards',
      step: 2,
      icon: 'images',
      subtitle: 'Check your card images before making the PDF. Add, copy or remove cards, and choose what is printed on the back.',
    });
    const problemsEl = h('div.stack', { style: { '--gap': '12px' }, attrs: { 'aria-live': 'polite' } });
    const tabsEl = ui.tabs({
      ariaLabel: 'Card images',
      active: state.tab,
      tabs: CARD_KINDS.map((k) => ({ id: k, label: TAB_LABELS[k], badge: null })),
      onChange: (id) => {
        state.tab = normalizeTab(id);
        state.visible = PAGE_SIZE;
        renderPanel();
      },
    });
    const panelEl = h('div.stack', { role: 'tabpanel', attrs: { 'aria-label': TAB_LABELS[state.tab] }, style: { '--gap': '16px' } });
    const trashEl = h('div');
    const footerEl = h('div');
    container.append(headerEl, problemsEl, h('div.stack', { style: { '--gap': '18px' } }, tabsEl, panelEl), trashEl, footerEl);

    /* ---------------- busy state ---------------- */

    /** Disable/enable every control that changes files. */
    const applyBusy = () => {
      for (const el of container.querySelectorAll('[data-mutation]')) {
        if ('disabled' in el) el.disabled = state.busy;
      }
    };

    /** Mark a button (or any control) as a file mutation (disabled while a job runs). */
    const mutation = (el) => {
      el.dataset.mutation = '1';
      if ('disabled' in el) el.disabled = state.busy || el.disabled;
      return el;
    };

    /* ---------------- loading ---------------- */

    let loadToken = 0;
    let reloadTimer = null;

    const load = async () => {
      const token = ++loadToken;
      const [lists, trash] = await Promise.all([
        Promise.allSettled(CARD_KINDS.map((k) => api.cards.list(k))),
        api.cards.trashList().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e })),
      ]);
      if (token !== loadToken || ctx.signal.aborted) return;
      CARD_KINDS.forEach((k, i) => {
        const r = lists[i];
        if (r.status === 'fulfilled') {
          state.lists[k] = normalizeCardList(r.value, k);
          state.errors[k] = null;
        } else {
          state.errors[k] = api.errorMessage(r.reason);
          if (!state.lists[k]) state.lists[k] = null;
        }
      });
      if (trash.ok) {
        state.trash = Array.isArray(trash.v) ? trash.v.filter((b) => b && b.batchId) : [];
        state.trashError = null;
      } else {
        state.trashError = api.errorMessage(trash.e);
      }
      const first = !state.loadedOnce;
      state.loading = false;
      state.loadedOnce = true;
      renderAll();
      if (first) {
        const section = String(ctx.params?.section || '').toLowerCase();
        if ((section === 'trash' || section === 'removed') && trashEl.firstChild) {
          // Opened to restore something (e.g. from Settings → Storage): show Recently removed.
          requestAnimationFrame(() => trashEl.scrollIntoView?.({ block: 'start' }));
        } else if (ctx.params?.tab && !problemsEl.hidden) {
          // Opened for a specific tab (e.g. "Choose a back" from Make PDF): bring it into view.
          requestAnimationFrame(() => tabsEl.scrollIntoView?.({ block: 'start' }));
        }
      }
    };

    const scheduleReload = (delay = 120) => {
      clearTimeout(reloadTimer);
      // An Undo toast can outlive the view: no reload timers after unmount.
      if (ctx.signal.aborted) return;
      reloadTimer = setTimeout(() => {
        load().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[cards] reload failed', err);
        });
      }, delay);
    };

    /** After a change: ask the shell for a new summary (bumps cards.version → lists reload). */
    const changed = () => {
      refreshCards();
      scheduleReload(60);
    };

    /* ---------------- toasts & errors ---------------- */

    const undoToast = (title, batchId, message) => {
      ui.toast({
        variant: 'success',
        title,
        message: message || (batchId ? 'You can restore it from Recently removed for 14 days.' : undefined),
        actions: batchId ? [{ label: 'Undo', icon: 'undo', onClick: () => restoreBatch(batchId, { quiet: false }) }] : [],
      });
    };

    const fail = (err, title) => ui.showError(err, { title });

    /* ---------------- mutations ---------------- */

    async function restoreBatch(batchId, { quiet = false } = {}) {
      try {
        const res = await api.cards.restore(batchId);
        const n = countOf(res?.restored);
        const renamed = Array.isArray(res?.renamed) ? res.renamed : [];
        const failed = Array.isArray(res?.failed) ? res.failed : [];
        if (!quiet || renamed.length || failed.length) {
          const notes = [];
          if (renamed.length) {
            const example = baseName(renamed[0].to || '');
            notes.push(`${renamed.length === 1 ? 'One image was' : `${format.formatNumber(renamed.length)} images were`} renamed because a file with the same name is already there${example ? ` (for example “${shortName(example, 50)}”)` : ''}.`);
          }
          if (failed.length) {
            const why = failed[0].reason ? `: ${String(failed[0].reason).replace(/\.$/, '')}` : '';
            notes.push(`${failed.length === 1 ? 'One file' : `${format.formatNumber(failed.length)} files`} could not be put back${why}. ${failed.length === 1 ? 'It stays' : 'They stay'} in Recently removed.`);
          }
          ui.toast({
            variant: failed.length ? 'warning' : 'success',
            title: n ? `Restored ${format.pluralize(n, 'image')}` : 'Nothing was restored',
            message: notes.join(' ') || undefined,
            timeout: notes.length ? 8000 : 3500,
          });
        }
      } catch (err) {
        fail(err, 'Could not restore the images');
      } finally {
        changed();
      }
    }

    async function removeRels(kind, rels, label) {
      try {
        const res = await api.cards.remove(kind, rels);
        undoToast(`Moved ${label} to Recently removed`, res?.batchId || null);
        const notMoved = Array.isArray(res?.failed) ? res.failed.length : 0;
        if (notMoved) {
          ui.toast({
            variant: 'warning',
            title: `${notMoved} file${notMoved === 1 ? '' : 's'} could not be removed`,
            message: 'Another program may be using them. Close it and try again.',
            timeout: 8000,
          });
        }
      } catch (err) {
        fail(err, 'Could not remove the image');
      } finally {
        changed();
      }
    }

    async function addCopy(group, kind) {
      try {
        await api.cards.duplicate(kind, group.main.rel, 1);
        ui.toast({ variant: 'success', title: `Added a copy of “${shortName(group.main.name || baseName(group.main.rel))}”`, timeout: 3000 });
      } catch (err) {
        fail(err, 'Could not add a copy');
      } finally {
        changed();
      }
    }

    function removeOneCopy(group, kind) {
      // The newest numbered copy goes, never the original the tile shows.
      const target = group.spare || group.last;
      return removeRels(kind, [target.rel], `one copy of “${shortName(group.main.name || baseName(group.main.rel))}”`);
    }

    function removeGroup(group, kind) {
      const name = shortName(group.main.name || baseName(group.main.rel));
      const withBack = kind === 'front' && partnerMaps().backOf(group.main) ? ' and its unique back' : '';
      const label = group.count > 1 ? `${group.count} copies of “${name}”${withBack ? ' and their unique backs' : ''}` : `“${name}”${withBack}`;
      return removeRels(kind, group.images.map((i) => i.rel), label);
    }

    async function addFiles(kind, paths) {
      const list = (paths || []).map((p) => (typeof p === 'string' ? p : ''));
      if (!list.length) return;
      if (list.every((p) => p === '')) {
        ui.toast({
          variant: 'warning',
          title: 'Save the image to your computer first',
          message: 'Pictures dragged straight from a web page cannot be added. Save them to a folder, then drag them from there.',
          timeout: 8000,
        });
        return;
      }
      try {
        const res = await api.cards.add(kind, list);
        const added = Array.isArray(res?.added) ? res.added : [];
        const skipped = Array.isArray(res?.skipped) ? res.skipped : [];
        if (added.length) {
          // Adding exactly one common back also selects it (done by the main process).
          const chosenNote = kind === 'back' && added.length === 1 ? 'It is now the back of your cards.' : null;
          ui.toast({
            variant: skipped.length ? 'warning' : 'success',
            title: `Added ${kindWord(kind, added.length)}`,
            message: [chosenNote, skipped.length ? skippedText(skipped) : null].filter(Boolean).join(' ') || undefined,
            timeout: skipped.length ? 9000 : 4000,
          });
        } else {
          ui.toast({ variant: 'warning', title: 'No images were added', message: skipped.length ? skippedText(skipped) : undefined, timeout: 9000 });
        }
        return res;
      } catch (err) {
        fail(err, 'Could not add the images');
        return null;
      } finally {
        changed();
      }
    }

    function skippedText(skipped) {
      const shown = skipped.slice(0, 3).map((s) => {
        const name = s.path ? baseName(String(s.path).replace(/\\/g, '/')) : 'An item';
        return `${name}: ${s.reason || 'not an image the card maker can use'}`;
      });
      const more = skipped.length > 3 ? ` (and ${skipped.length - 3} more)` : '';
      return `${shown.join('; ')}${more}.`;
    }

    async function chooseAndAdd(kind) {
      const paths = await api.dialog.openFiles({
        purpose: 'images',
        title: kind === 'back' ? 'Choose a back image' : 'Add card images',
        filters: IMAGE_FILTERS,
      });
      if (Array.isArray(paths) && paths.length) await addFiles(kind, paths);
    }

    async function openFolder(kind) {
      try {
        await api.cards.openFolder(kind);
      } catch (err) {
        fail(err, 'Could not open the folder');
      }
    }

    async function removeAll() {
      const n = images('front').length;
      const ds = images('double_sided').length;
      let includePartners = ds > 0;
      const content = h('div.stack', { style: { '--gap': '12px' } },
        h('p.confirm-message', `The ${kindWord('front', n)} move to Recently removed. You can restore them for 14 days.`),
        ds > 0 ? ui.checkbox({
          checked: true,
          label: `Also remove the ${kindWord('double_sided', ds)}`,
          description: 'Unique backs without their front would stop a two-sided PDF.',
          onChange: (v) => { includePartners = v; },
        }) : null);
      const ok = await ui.confirmDialog({ title: 'Remove all cards?', message: content, confirmLabel: 'Remove all', danger: true });
      if (!ok) return;
      try {
        const res = await api.cards.clear('front', { includePartners });
        const removed = countOf(res?.removed) || n;
        undoToast(`Moved ${format.pluralize(removed, 'image')} to Recently removed`, res?.batchId || null);
      } catch (err) {
        fail(err, 'Could not remove the cards');
      } finally {
        changed();
      }
    }

    async function fixNames(kind) {
      try {
        const res = await api.cards.fixCollisions(kind);
        const all = Array.isArray(res?.renamed) ? res.renamed.filter((r) => r && r.from && r.to) : [];
        // Unique backs renamed together with their front are reported with `partner: true`.
        const renamed = all.filter((r) => !r.partner);
        const partners = all.length - renamed.length;
        const examples = renamed.slice(0, 2).map((r) => `${shortName(baseName(r.from), 40)} → ${shortName(baseName(r.to), 40)}`).join(', ');
        ui.toast({
          variant: 'success',
          title: renamed.length ? `Renamed ${format.pluralize(renamed.length, 'image')}` : 'Names fixed',
          message: renamed.length
            ? `Every card now has its own name (${examples}${renamed.length > 2 ? ', …' : ''}).${partners ? ` Their unique backs were renamed too.` : ''}`
            : undefined,
          timeout: 6000,
        });
      } catch (err) {
        fail(err, 'Could not rename the images');
      } finally {
        changed();
      }
    }

    async function loadSamples() {
      const s = summary();
      const backCount = Number(s?.backCount ?? s?.counts?.back) || images('back').length;
      const dsCount = Number(s?.double_sided) || images('double_sided').length;
      const frontCount = Number(s?.front) || images('front').length;
      let replace = false;
      if (backCount > 0 || dsCount > 0 || frontCount > 0) {
        const what = [
          frontCount ? kindWord('front', frontCount) : null,
          backCount ? kindWord('back', backCount) : null,
          dsCount ? kindWord('double_sided', dsCount) : null,
        ].filter(Boolean).join(', ');
        const ok = await ui.confirmDialog({
          title: 'Use the sample cards?',
          message: `The sample cards are numbered test cards (with a test back) at your current card size. Your ${what} move to Recently removed first, so the test deck is complete. You can restore them for 14 days.`,
          confirmLabel: 'Use sample cards',
        });
        if (!ok) return;
        replace = true;
      }
      try {
        await api.cards.loadSamples({ replace });
        ui.toast({ variant: 'info', title: 'Making sample cards…', message: 'Numbered test cards appear here in a moment. Print them on plain paper first to check your cutting settings.', timeout: 5000 });
      } catch (err) {
        fail(err, 'Could not make the sample cards');
      }
    }

    async function setBackChoice(value) {
      try {
        if (value === '__none__') await api.cards.setBack({ mode: 'none', file: null });
        else await api.cards.setBack({ mode: 'file', file: value });
      } catch (err) {
        fail(err, 'Could not change the back');
      } finally {
        changed();
      }
    }

    async function setBackForCard(preselected) {
      const fronts = images('front');
      if (!fronts.length) {
        ui.toast({ variant: 'info', title: 'Add your fronts first', message: 'A unique back is printed behind a front image, so add the fronts first.' });
        return;
      }
      const { backOf } = partnerMaps();
      const front = preselected || await openCardPicker({
        images: fronts,
        title: 'Set back for a card',
        message: 'Choose the card that gets its own back (for example the other side of a double-faced card). Then choose the back image.',
        badgeFor: (img) => (backOf(img) ? 'Has a back' : null),
        dims: dims(),
      });
      if (!front || ctx.signal.aborted) return;
      const frontName = shortName(front.name || baseName(front.rel), 80);
      if (backOf(front)) {
        const ok = await ui.confirmDialog({
          title: 'Replace the unique back?',
          message: `“${frontName}” already has a unique back. The current one moves to Recently removed.`,
          confirmLabel: 'Choose a new back',
        });
        if (!ok) return;
      }
      const file = await api.dialog.openFile({ purpose: 'images', title: `Back image for “${frontName}”`, filters: IMAGE_FILTERS });
      if (!file || ctx.signal.aborted) return;
      try {
        await api.cards.setPartnerBack(front.rel, file);
        ui.toast({ variant: 'success', title: `Unique back set for “${frontName}”`, message: 'It is printed behind this card instead of the common back.', timeout: 4000 });
      } catch (err) {
        fail(err, 'Could not set the unique back');
      } finally {
        changed();
      }
    }

    async function removePartner(front) {
      try {
        const res = await api.cards.removePartnerBack(front.rel);
        undoToast(`Removed the unique back of “${shortName(front.name || baseName(front.rel))}”`, res?.batchId || null);
      } catch (err) {
        fail(err, 'Could not remove the unique back');
      } finally {
        changed();
      }
    }

    async function emptyTrash() {
      const batches = state.trash.length;
      const total = state.trash.reduce((n, b) => n + countOf(b.count), 0);
      const ok = await ui.confirmDialog({
        title: 'Delete the removed images for good?',
        message: `${format.pluralize(batches, 'group')}${total ? ` (${format.pluralize(total, 'image')})` : ''} will be deleted permanently. This cannot be undone.`,
        confirmLabel: 'Delete for good',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api.cards.emptyTrash();
        const n = countOf(res?.removed);
        ui.toast({ variant: 'success', title: n ? `Deleted ${format.pluralize(n, 'image')} for good` : 'Recently removed is empty', timeout: 3500 });
      } catch (err) {
        fail(err, 'Could not empty Recently removed');
      } finally {
        changed();
      }
    }

    /* ---------------- view modal ---------------- */

    function qualityRows(img, kind) {
      const d = dims();
      const fit = fitFor(kind);
      const q = imageQuality(img, d, fit);
      const rows = [];
      if (q.ppi !== null) {
        const ppi = Math.round(q.ppi);
        let verdict;
        let tone;
        if (q.resolution === 'warning') {
          verdict = 'may print blurry';
          tone = 'text-warning';
        } else if (q.resolution === 'info') {
          verdict = 'fine for casual play';
          tone = 'text-info';
        } else {
          verdict = 'sharp';
          tone = 'text-success';
        }
        rows.push(['Print sharpness', h('span', h('span', { class: ['strong', tone] }, `About ${format.formatNumber(ppi)} pixels per inch: ${verdict}`),
          h('span.small.muted', { style: { display: 'block' } }, `At ${d.label}.${q.resolution !== 'ok' && !img.upscaled ? ' Upscaling or a bigger image would make it sharper.' : ''}`))]);
      }
      if (q.aspectOff !== null) {
        const pct = Math.round(q.aspectOff * 100);
        let text;
        if (q.aspectOff <= ASPECT_TOLERANCE) text = pct <= 1 ? 'Matches the card shape' : `Close to the card shape (${pct}% off)`;
        else if (q.stretched) text = `About ${pct}% ${q.wider ? 'wider' : 'taller'} than the card: it will be stretched to fit (Image shape: Stretch).`;
        else text = `About ${pct}% ${q.wider ? 'wider' : 'taller'} than the card: its ${q.wider ? 'sides' : 'top and bottom'} will be cut off (Image shape: Crop).`;
        rows.push(['Shape', h('span', { class: q.aspectOff > ASPECT_TOLERANCE ? 'text-warning' : null }, text)]);
      }
      return rows;
    }

    /**
     * Large preview + details of one card (or group of identical copies).
     * @param {{ first: object, last: object, images: object[], count: number }} group
     * @param {string} kind
     * @param {{ side?: 'main'|'partner' }} [options] which side to show first when the card has a partner
     */
    function openViewModal(group, kind, { side = 'main' } = {}) {
      const img = group.main;
      const name = img.name || baseName(img.rel);
      const { backOf, frontOf } = partnerMaps();
      const partner = kind === 'front' ? backOf(img) : kind === 'double_sided' ? frontOf(img) : null;
      const sides = partner ? [{ id: 'main', img, label: kind === 'front' ? 'Front' : 'Unique back' }, { id: 'partner', img: partner, label: kind === 'front' ? 'Unique back' : 'Front' }] : null;
      const startSide = sides ? (sides.find((s) => s.id === side) || sides[0]) : { img };
      const pictureImg = h('img', {
        src: startSide.img.url,
        alt: startSide.img.name || baseName(startSide.img.rel),
        decoding: 'async',
        draggable: false,
        style: { width: '100%', maxHeight: 'min(62vh, 560px)', objectFit: 'contain', borderRadius: '10px', background: 'var(--surface-2)' },
      });
      pictureImg.addEventListener('error', () => {
        pictureImg.replaceWith(h('div.img-tile-fallback', { style: { position: 'static', minHeight: '240px', border: '1px dashed var(--border-strong)', borderRadius: '10px' } },
          icon('image', { size: 22 }), h('span', 'Preview unavailable')));
      }, { once: true });
      const picture = h('div.stack', { style: { '--gap': '10px' } },
        sides ? h('div.row', ui.segmented({
          size: 'sm',
          ariaLabel: 'Side',
          value: startSide.id,
          options: sides.map((s) => ({ value: s.id, label: s.label })),
          onChange: (v) => {
            const side = sides.find((s) => s.id === v) || sides[0];
            pictureImg.src = side.img.url;
            pictureImg.alt = side.img.name || baseName(side.img.rel);
          },
        })) : null,
        pictureImg);

      const sizeBits = [pixelSize(img), Number.isFinite(img.size) ? format.formatBytes(img.size) : null, img.type ? String(img.type).toUpperCase() : (img.ext ? String(img.ext).toUpperCase() : null)].filter(Boolean);
      const folder = img.rel.includes('/') ? img.rel.slice(0, img.rel.lastIndexOf('/')) : null;
      const rows = [
        ['File', h('span', h('span.strong', name), folder ? h('span.small.muted', { style: { display: 'block' } }, `In the folder “${folder}”`) : null)],
        group.count > 1 ? ['Copies', h('span', `${format.formatNumber(group.count)} identical copies`,
          h('span.small.muted', { style: { display: 'block' } }, [group.main, ...group.images.filter((i) => i !== group.main)].slice(0, 6).map((i) => shortName(i.name || baseName(i.rel), 50)).join(', ') + (group.count > 6 ? ', …' : '')))] : null,
        ['Image', sizeBits.length ? sizeBits.join(' · ') : 'Size unknown'],
        ...qualityRows(img, kind),
        img.upscaled ? ['Upscaled', h('span.text-accent', 'An upscaled copy is ready and will be used in the PDF.')] : null,
        kind === 'front' ? ['Unique back', partner ? (partner.name || baseName(partner.rel)) : 'None (the common back is used)'] : null,
        kind === 'double_sided' ? ['Front', partner ? (partner.name || baseName(partner.rel)) : h('span.text-warning', 'No matching front: this back cannot be printed.')] : null,
      ];

      let dialog = null;
      const act = (fn) => async () => {
        dialog?.close('action');
        await fn();
      };
      // Actions in three groups: copies, unique back, removal (each on its own line).
      const copyActions = [];
      if (kind === 'front') {
        copyActions.push(mutation(ui.button({ label: 'Add a copy', icon: 'plus', size: 'sm', onClick: act(() => addCopy(group, kind)) })));
      }
      if (group.count > 1) copyActions.push(mutation(ui.button({ label: 'Remove one copy', icon: 'minus', size: 'sm', onClick: act(() => removeOneCopy(group, kind)) })));
      const backActions = [];
      if (kind === 'front') {
        backActions.push(mutation(ui.button({ label: partner ? 'Replace unique back…' : 'Set unique back…', icon: 'layers', size: 'sm', onClick: act(() => setBackForCard(img)) })));
        if (partner) backActions.push(mutation(ui.button({ label: 'Remove unique back', icon: 'x', size: 'sm', variant: 'ghost', onClick: act(() => removePartner(img)) })));
      }
      let removeAction;
      if (kind === 'double_sided' && partner) {
        removeAction = mutation(ui.button({ label: 'Remove this unique back', icon: 'trash', size: 'sm', variant: 'danger', onClick: act(() => removePartner(partner)) }));
      } else {
        removeAction = mutation(ui.button({
          label: group.count > 1 ? `Remove all ${format.formatNumber(group.count)} copies` : 'Remove',
          icon: 'trash',
          size: 'sm',
          variant: 'danger',
          onClick: act(() => removeGroup(group, kind)),
        }));
      }
      let removeHint = 'You can restore it from Recently removed for 14 days.';
      if (kind === 'front' && partner) removeHint = group.count > 1 ? 'Their unique backs are removed too.' : 'Its unique back is removed too.';
      else if (group.count > 1) removeHint = 'You can restore them from Recently removed for 14 days.';

      const details = h('div.stack', { style: { '--gap': '16px' } },
        ui.kv(rows.filter(Boolean)),
        h('div.stack', { style: { '--gap': '10px' } },
          copyActions.length ? h('div.row', { style: { '--gap': '8px' } }, copyActions) : null,
          backActions.length ? h('div.row', { style: { '--gap': '8px' } }, backActions) : null,
          h('div.row', { style: { '--gap': '10px' } }, removeAction, h('span.tiny.faint', removeHint))));
      const content = h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 5fr) minmax(0, 6fr)', gap: '24px', alignItems: 'start' } }, picture, details);
      dialog = ui.modal({
        title: name,
        wide: true,
        content,
        actions: [
          { label: 'Open folder', icon: 'folder-open', variant: 'ghost', onClick: () => { openFolder(kind); return false; } },
          { label: 'Close', variant: 'primary' },
        ],
      });
    }

    /* ---------------- problems (callouts) ---------------- */

    /** Warnings from the three lists (tagged with their kind) plus summary warnings not covered. */
    function collectWarnings() {
      const out = [];
      const seen = new Set();
      const keyOf = (w) => `${w.code}|${(w.files || []).join('\n')}`;
      for (const kind of CARD_KINDS) {
        for (const w of state.lists[kind]?.warnings || []) {
          const item = { ...w, files: Array.isArray(w.files) ? w.files.map(String) : [], kind };
          seen.add(keyOf(item));
          out.push(item);
        }
      }
      for (const w of summary()?.warnings || []) {
        if (!w || typeof w !== 'object') continue;
        const files = Array.isArray(w.files) ? w.files.map(String) : [];
        if (seen.has(keyOf({ code: w.code, files }))) continue;
        let kind = typeof w.kind === 'string' ? w.kind : null;
        if (!kind) {
          if (w.code === 'ds_without_front') kind = 'double_sided';
          else if (w.code === 'multiple_backs') kind = 'back';
          else kind = CARD_KINDS.find((k) => files.some((f) => images(k).some((i) => i.rel === f))) || 'front';
        }
        out.push({ ...w, files, kind });
      }
      return out;
    }

    /** Title + message for a group of same-name files. */
    function collisionText(kind, warnings) {
      const files = warnings.flatMap((w) => w.files);
      const groups = collisionGroups(files);
      const noun = kind === 'double_sided' ? 'unique backs' : kind === 'back' ? 'back images' : 'images';
      if (groups.length === 1) {
        const g = groups[0];
        const list = g.files.map((f) => shortName(f, 60));
        const shown = list.length > 4 ? [...list.slice(0, 3), `${format.formatNumber(list.length - 3)} more`] : list;
        return {
          title: `${list.length === 2 ? 'Two' : format.formatNumber(list.length)} ${noun} share the name “${shortName(g.stem, 60)}”`,
          message: `${shown.join(list.length === 2 ? ' and ' : ', ')}: only one of them would be printed.`,
        };
      }
      if (groups.length > 1) {
        const examples = groups.slice(0, 2).map((g) => `“${shortName(g.stem, 40)}” (${g.files.slice(0, 3).map((f) => shortName(baseName(f), 40)).join(', ')}${g.files.length > 3 ? ', …' : ''})`).join(' and ');
        return {
          title: `${format.formatNumber(groups.length)} names are used by more than one of your ${noun}`,
          message: `For example ${examples}. Only one image per name would be printed.`,
        };
      }
      return {
        title: `Some ${noun} share the same name`,
        message: warnings.map((w) => w.message).filter(Boolean).join(' ') || 'Only one image per name would be printed.',
      };
    }

    /**
     * Problems found in the card folders, as data: `blocking` ones stop the PDF; the others are
     * informational.
     * @returns {Array<{ id: string, blocking: boolean, title: string, message: string, actions: HTMLElement[] }>}
     */
    function problemItems() {
      const warnings = collectWarnings();
      const byCode = (code) => warnings.filter((w) => w.code === code);
      const items = [];

      for (const kind of CARD_KINDS) {
        const list = byCode('stem_collision').filter((w) => w.kind === kind);
        if (!list.length) continue;
        items.push({
          id: `collision-${kind}`,
          blocking: true,
          ...collisionText(kind, list),
          actions: [mutation(ui.button({ label: 'Fix names automatically', icon: 'wand', size: 'sm', variant: 'primary', onClick: () => fixNames(kind) }))],
        });
      }

      const orphans = [...new Set(byCode('ds_without_front').flatMap((w) => w.files))];
      if (orphans.length) {
        // Two-sided PDFs refuse unique backs without a front; with fronts only they are just unpaired.
        const blocking = !onlyFronts();
        const names = `${orphans.slice(0, 3).map((f) => shortName(baseName(f), 48)).join(', ')}${orphans.length > 3 ? ', …' : ''}`;
        items.push({
          id: 'orphans',
          blocking,
          title: orphans.length === 1 ? 'A unique back has no matching front' : `${format.formatNumber(orphans.length)} unique backs have no matching front`,
          message: blocking
            ? `${names}. Each unique back needs a front with the same name.`
            : `${names}. Each unique back needs a front with the same name; a two-sided PDF can't be made until this is fixed.`,
          actions: [
            ui.button({ label: 'Show', size: 'sm', onClick: () => selectTab('double_sided') }),
            mutation(ui.button({ label: 'Move to Recently removed', icon: 'trash', size: 'sm', variant: 'ghost', onClick: () => removeRels('double_sided', orphans, kindWord('double_sided', orphans.length)) })),
          ],
        });
      }

      const s = summary();
      const backProblem = s?.back?.problem || (byCode('multiple_backs').length ? 'choose' : null);
      if (backProblem && !onlyFronts()) {
        const n = images('back').length || (s?.backs || []).length || Number(s?.backCount ?? s?.counts?.back) || 2;
        items.push({
          id: 'back',
          blocking: true,
          title: backProblem === 'missing' ? 'The back image you chose is missing' : 'Choose the back for your cards',
          message: backProblem === 'missing'
            ? `“${s?.back?.file || 'The chosen image'}” is no longer in the common backs folder.`
            : `You have ${kindWord('back', n)}: choose the one printed on the back of your cards.`,
          actions: [ui.button({ label: 'Choose a back', size: 'sm', variant: 'primary', onClick: () => selectTab('back') })],
        });
      }

      for (const kind of CARD_KINDS) {
        const list = byCode('unsupported_file').filter((w) => w.kind === kind);
        const others = state.lists[kind]?.others || [];
        // The service reports unsupported files as a warning; fall back to the raw `others` list.
        const files = [...new Set(list.length ? list.flatMap((w) => w.files) : others.map((o) => o.rel))];
        if (!files.length) continue;
        const heic = others.some((o) => o.type === 'heic' && files.includes(o.rel));
        items.push({
          id: `unsupported-${kind}`,
          blocking: false,
          title: files.length === 1 ? `1 file in the ${KIND_WORDS[kind].folder} can't be used` : `${format.formatNumber(files.length)} files in the ${KIND_WORDS[kind].folder} can't be used`,
          message: `${files.slice(0, 3).map((f) => shortName(baseName(f), 48)).join(', ')}${files.length > 3 ? ', …' : ''}: ${heic ? 'iPhone HEIC photos are not supported (convert them to JPG or PNG); ' : ''}${files.length === 1 ? 'it is not a card image, so it is ignored' : 'they are not card images, so they are ignored'}.`,
          actions: [ui.button({ label: 'Open folder', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => openFolder(kind) })],
        });
      }

      const stale = CARD_KINDS.filter((k) => state.errors[k] && state.lists[k]);
      if (stale.length) {
        items.push({
          id: 'stale',
          blocking: false,
          title: 'Your cards could not be read again',
          message: `${state.errors[stale[0]]} The list below may be out of date.`,
          actions: [ui.button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => load() })],
        });
      }
      return items;
    }

    /**
     * One row of the grouped problems callout: text on the left, actions on the right.
     * @param {{ title: string, message: string, actions: HTMLElement[] }} item
     * @param {boolean} first
     * @returns {HTMLElement}
     */
    function problemRow(item, first) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px 16px', padding: first ? '4px 0 0' : '10px 0 0',
          marginTop: first ? '0' : '10px', borderTop: first ? null : '1px solid var(--warning-border)',
        },
      },
      h('div', { style: { flex: '1 1 280px', minWidth: '0' } },
        h('div.strong', item.title),
        h('div.small', { style: { color: 'var(--text-2)' } }, item.message)),
      h('div.row', { style: { '--gap': '6px' } }, item.actions));
    }

    /**
     * Render the problems above the tabs: blocking ones grouped in one warning callout, the others
     * as compact notes.
     * @returns {number} how many problems would stop the PDF
     */
    function renderProblems() {
      const items = problemItems();
      const blocking = items.filter((i) => i.blocking);
      const notes = items.filter((i) => !i.blocking);
      const out = [];
      if (blocking.length === 1) {
        out.push(ui.callout({ variant: 'warning', title: blocking[0].title, message: blocking[0].message, actions: blocking[0].actions }));
      } else if (blocking.length > 1) {
        out.push(ui.callout({
          variant: 'warning',
          title: `${format.formatNumber(blocking.length)} things to fix before making the PDF`,
          message: h('div', blocking.map((item, i) => problemRow(item, i === 0))),
        }));
      }
      for (const item of notes) {
        // Compact note: text on the left, its action on the right.
        out.push(ui.callout({
          variant: item.id === 'stale' ? 'danger' : 'neutral',
          compact: true,
          message: h('div', { style: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '6px 16px' } },
            h('div', { style: { flex: '1 1 280px', minWidth: '0' } },
              h('div.strong', { style: { color: 'var(--text)' } }, item.title),
              h('div.small', item.message)),
            h('div.row', { style: { '--gap': '6px' } }, item.actions)),
        }));
      }
      ui.mountInto(problemsEl, out);
      problemsEl.hidden = out.length === 0;
      return blocking.length;
    }

    function selectTab(kind) {
      state.tab = normalizeTab(kind);
      tabsEl.setActive(state.tab);
      state.visible = PAGE_SIZE;
      renderPanel();
      tabsEl.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }

    /* ---------------- tab badges ---------------- */

    function renderTabBadges() {
      const s = summary();
      const front = state.lists.front ? images('front').length : Number(s?.front) || 0;
      const ds = state.lists.double_sided ? images('double_sided').length : Number(s?.double_sided) || 0;
      tabsEl.setBadge('front', front ? format.formatNumber(front) : null);
      tabsEl.setBadge('double_sided', ds ? format.formatNumber(ds) : null);
      const backProblem = s?.back?.problem && !onlyFronts();
      tabsEl.setBadge('back', backProblem ? '!' : null);
    }

    /* ---------------- panel ---------------- */

    function errorPanel(kind) {
      return ui.callout({
        variant: 'danger',
        title: 'Your cards could not be read',
        message: `${state.errors[kind] || 'Something went wrong.'} Your card images are safe; try again in a moment.`,
        actions: [ui.button({ label: 'Try again', icon: 'refresh', size: 'sm', variant: 'primary', onClick: () => load() })],
      });
    }

    function skeletonGrid(n = 8) {
      const d = dims();
      return h('div.thumb-grid', { style: { '--thumb-size': `${thumbSize()}px` }, attrs: { 'aria-hidden': 'true' } },
        Array.from({ length: n }, () => h('div.img-tile',
          h('div.img-tile-frame.skeleton', { style: { aspectRatio: `${d.widthMm} / ${d.heightMm}`, height: 'auto' } }),
          h('div.skeleton', { style: { width: '70%' } }))));
    }

    const thumbSize = () => {
      const n = Number(settings()?.ui?.thumbSize);
      return Number.isFinite(n) ? Math.min(THUMB_MAX, Math.max(THUMB_MIN, Math.round(n))) : THUMB_DEFAULT;
    };

    function renderPanel() {
      panelEl.setAttribute('aria-label', TAB_LABELS[state.tab]);
      // Keep keyboard focus on the same control when the panel is rebuilt (e.g. after a toggle).
      const active = document.activeElement;
      const focusKey = active && panelEl.contains(active) ? active.closest('[data-focus-key]')?.dataset.focusKey : null;
      if (state.tab === 'back') renderBackPanel();
      else if (state.tab === 'double_sided') renderPairsPanel();
      else renderFrontsPanel();
      applyBusy();
      if (focusKey) {
        const target = panelEl.querySelector(`[data-focus-key="${CSS.escape(focusKey)}"]`);
        const focusable = target?.matches('input, button, select, textarea') ? target : target?.querySelector('input, button, select, textarea');
        if (focusable && !focusable.disabled) focusable.focus({ preventScroll: true });
      }
    }

    /* ----- fronts ----- */

    let gridEl = null;
    let sentinel = null;
    let observer = null;
    /** @type {Map<string, { el: HTMLElement, sig: string }>} */
    let tileCache = new Map();

    function frontsToolbar(hasImages) {
      const s = settings();
      const groupToggle = ui.toggle({
        checked: s?.ui?.groupIdentical !== false,
        label: 'Group identical',
        onChange: (v) => {
          api.settings.update({ ui: { groupIdentical: v } }).catch((err) => fail(err, 'Could not save this choice'));
        },
      });
      const range = h('input', {
        type: 'range',
        min: THUMB_MIN,
        max: THUMB_MAX,
        step: 10,
        value: thumbSize(),
        attrs: { 'aria-label': 'Card size on screen' },
        style: { width: '120px', accentColor: 'var(--accent)', cursor: 'pointer' },
      });
      range.addEventListener('input', () => {
        if (gridEl) gridEl.style.setProperty('--thumb-size', `${range.value}px`);
      });
      range.addEventListener('change', () => {
        api.settings.update({ ui: { thumbSize: Number(range.value) } }).catch((err) => fail(err, 'Could not save the card size'));
      });
      const sizeControl = h('label.row', { style: { '--gap': '6px' }, title: 'Card size on screen', dataset: { focusKey: 'thumb-size' } },
        icon('image', { size: 14, class: 'muted' }), range, icon('image', { size: 20, class: 'muted' }));
      groupToggle.dataset.focusKey = 'group-identical';
      const addBtn = mutation(ui.button({ label: 'Add images…', icon: 'plus', variant: hasImages ? 'secondary' : 'primary', onClick: () => chooseAndAdd('front') }));
      addBtn.dataset.focusKey = 'add-images';
      const folderBtn = ui.button({ label: 'Open folder', icon: 'folder-open', onClick: () => openFolder('front') });
      folderBtn.dataset.focusKey = 'open-folder';
      return ui.row({ justify: 'between', gap: 12 },
        ui.row({ gap: 8 },
          addBtn,
          folderBtn,
          hasImages ? mutation(ui.button({ label: 'Remove all', icon: 'trash', variant: 'ghost', onClick: () => removeAll() })) : null),
        hasImages ? ui.row({ gap: 16 }, groupToggle, sizeControl) : null);
    }

    function frontsEmpty() {
      return ui.emptyState({
        icon: 'images',
        title: 'No cards yet',
        message: 'Download a deck from a card website, add your own images, or try the sample cards to see how it works. You can also drag images here.',
        actions: [
          ui.button({ label: 'Get cards', icon: 'download', variant: 'primary', onClick: () => navigate('fetch') }),
          mutation(ui.button({ label: 'Try sample cards', icon: 'layers', onClick: () => loadSamples() })),
          mutation(ui.button({ label: 'Add images…', icon: 'plus', variant: 'ghost', onClick: () => chooseAndAdd('front') })),
        ],
      });
    }

    function frontGroups() {
      const { backOf } = partnerMaps();
      return groupImages(images('front'), {
        enabled: settings()?.ui?.groupIdentical !== false,
        partnerKey: (img) => {
          const b = backOf(img);
          return b ? (b.hash || `rel:${b.rel}`) : '';
        },
      });
    }

    function tileSignature(group, kind, extra) {
      return JSON.stringify([
        group.images.map((i) => [i.rel, i.url, i.width, i.height, i.upscaled ? 1 : 0]),
        kind, extra,
      ]);
    }

    function buildFrontTile(group, kind, partner) {
      const img = group.main;
      const d = dims();
      const fit = fitFor(kind);
      const q = imageQuality(img, d, fit);
      const badges = [];
      if (img.upscaled) badges.push(ui.badge('Upscaled', 'accent', { icon: 'sparkles' }));
      else if (q.resolution === 'warning') badges.push(ui.badge('May print blurry', 'warning', { icon: 'alert-triangle' }));
      else if (q.resolution === 'info') badges.push(ui.badge('Low resolution', 'info'));
      if (q.stretched) badges.push(ui.badge('Will be stretched', 'warning'));
      if (partner) badges.push(ui.badge('Unique back', 'neutral', { icon: 'layers' }));
      const name = img.name || baseName(img.rel);
      const actions = [
        { icon: 'eye', title: 'View', onClick: () => openViewModal(group, kind) },
        { icon: 'plus', title: 'Add a copy', dataset: { mutation: '1' }, disabled: state.busy, onClick: () => addCopy(group, kind) },
        group.count > 1 ? { icon: 'minus', title: 'Remove one copy', dataset: { mutation: '1' }, disabled: state.busy, onClick: () => removeOneCopy(group, kind) } : null,
        { icon: 'trash', title: group.count > 1 ? `Remove all ${group.count} copies` : 'Remove', dataset: { mutation: '1' }, disabled: state.busy, onClick: () => removeGroup(group, kind) },
      ].filter(Boolean);
      return cardTile({
        src: img.url,
        alt: name,
        title: name,
        subtitle: pixelSize(img) || 'Size unknown',
        badges,
        count: group.count,
        actions,
        onOpen: () => openViewModal(group, kind),
        fallbackText: String(img.ext || 'image').toUpperCase(),
      }, d, fit);
    }

    function renderFrontsPanel() {
      const list = state.lists.front;
      teardownObserver();
      if (!list) {
        ui.mountInto(panelEl, state.errors.front ? errorPanel('front') : [frontsToolbar(false), skeletonGrid()]);
        gridEl = null;
        return;
      }
      if (!list.images.length) {
        ui.mountInto(panelEl, frontsToolbar(false), frontsEmpty());
        gridEl = null;
        tileCache = new Map();
        return;
      }
      const groups = frontGroups();
      const { backOf } = partnerMaps();
      const d = dims();
      const fit = fitFor('front');
      const extra = [d.widthMm, d.heightMm, fit];
      const nextCache = new Map();
      const shown = groups.slice(0, state.visible);
      const tiles = shown.map((g) => {
        const partner = backOf(g.main);
        const sig = tileSignature(g, 'front', [...extra, partner ? partner.rel : null]);
        const cached = tileCache.get(g.key);
        const el = cached && cached.sig === sig ? cached.el : buildFrontTile(g, 'front', partner);
        nextCache.set(g.key, { el, sig });
        return el;
      });
      tileCache = nextCache;
      gridEl = h('div.thumb-grid', { style: { '--thumb-size': `${thumbSize()}px` } }, tiles);
      const different = groups.length;
      const total = list.images.length;
      const paired = pairedCount();
      const countLine = h('p.small.muted', { style: { margin: '-4px 0 0' } },
        `${format.pluralize(total, 'card image')}`,
        different !== total ? ` · ${format.formatNumber(different)} different` : '',
        paired ? ` · ${format.formatNumber(paired)} with a unique back` : '');
      const rest = groups.length - shown.length;
      sentinel = rest > 0 ? h('div.row', { style: { justifyContent: 'center' } },
        ui.button({ label: `Show ${format.formatNumber(Math.min(rest, PAGE_SIZE))} more`, variant: 'ghost', onClick: () => showMore() })) : null;
      ui.mountInto(panelEl, frontsToolbar(true), countLine, gridEl, sentinel);
      if (sentinel && typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver((entries) => {
          if (entries.some((e) => e.isIntersecting)) showMore();
        }, { rootMargin: '600px 0px' });
        observer.observe(sentinel);
      }
    }

    function showMore() {
      state.visible += PAGE_SIZE;
      renderFrontsPanel();
      applyBusy();
    }

    function teardownObserver() {
      if (observer) observer.disconnect();
      observer = null;
    }
    disposers.push(teardownObserver);

    /* ----- common back ----- */

    function backPanelIntro() {
      const of = onlyFronts();
      return h('div.stack', { style: { '--gap': '10px' } },
        h('p.prose', 'This image is printed on the back of every card that has no unique back. It is only used when you print fronts and backs.'),
        of ? ui.callout({
          variant: 'neutral',
          compact: true,
          message: 'Your PDF is set to print fronts only, so no back is printed. You can change this in Make PDF.',
          actions: [ui.button({ label: 'Open Make PDF', size: 'sm', variant: 'ghost', iconRight: 'arrow-right', onClick: () => navigate('pdf') })],
        }) : null);
    }

    function backChoiceDescription(img, isAuto) {
      const d = dims();
      const q = imageQuality(img, d, fitFor('back'));
      const notes = [];
      if (q.resolution === 'warning') notes.push(h('span.text-warning', 'May print blurry'));
      else if (q.resolution === 'info') notes.push(h('span.text-info', 'Low resolution'));
      if (q.stretched) notes.push(h('span.text-warning', 'Will be stretched'));
      const thumb = h('img', {
        src: img.url,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        draggable: false,
        style: { height: '150px', width: 'auto', maxWidth: '100%', aspectRatio: `${d.widthMm} / ${d.heightMm}`, objectFit: fitFor('back') === 'crop' ? 'cover' : 'fill', borderRadius: '8px', border: '1px solid var(--border)', background: 'var(--surface-2)' },
      });
      thumb.addEventListener('error', () => { thumb.style.visibility = 'hidden'; }, { once: true });
      const name = img.name || baseName(img.rel);
      return h('span.stack', { style: { '--gap': '8px', marginTop: '6px' } },
        h('span.row', { style: { justifyContent: 'center' } }, thumb),
        h('span', [pixelSize(img), isAuto ? 'used automatically (it is the only back image)' : null].filter(Boolean).join(' · ')),
        notes.length ? h('span.row', { style: { '--gap': '8px' } }, notes) : null,
        h('span.row', { style: { '--gap': '4px' } },
          ui.button({ label: 'View', icon: 'eye', size: 'sm', variant: 'ghost', onClick: (ev) => { ev.preventDefault(); openViewModal(singleGroup(img), 'back'); } }),
          mutation(ui.button({ label: 'Remove', icon: 'trash', size: 'sm', variant: 'ghost', onClick: (ev) => { ev.preventDefault(); return removeRels('back', [img.rel], `“${shortName(name)}”`); } }))));
    }

    function renderBackPanel() {
      const list = state.lists.back;
      if (!list) {
        ui.mountInto(panelEl, backPanelIntro(), state.errors.back ? errorPanel('back') : ui.skeleton({ lines: 4 }));
        return;
      }
      const s = summary();
      const backs = list.images;
      const mode = s?.back?.mode || settings()?.cards?.back?.mode || 'auto';
      const file = s?.back?.file ?? settings()?.cards?.back?.file ?? null;
      const toolbar = ui.row({ gap: 8 },
        mutation(ui.button({ label: 'Add back image…', icon: 'plus', variant: backs.length ? 'secondary' : 'primary', onClick: () => chooseAndAdd('back') })),
        ui.button({ label: 'Open folder', icon: 'folder-open', onClick: () => openFolder('back') }));
      if (!backs.length) {
        ui.mountInto(panelEl, backPanelIntro(), toolbar, ui.emptyState({
          icon: 'layers',
          title: 'No common back image',
          message: 'Without one, the back of single-sided cards stays blank white. Add the card back of your game (for example the Magic or Pokémon card back) if you print two-sided.',
          actions: [mutation(ui.button({ label: 'Add back image…', icon: 'plus', variant: 'primary', onClick: () => chooseAndAdd('back') }))],
        }));
        return;
      }
      let value = null;
      if (mode === 'none') value = '__none__';
      else if (mode === 'file' && file && backs.some((b) => b.rel === file)) value = file;
      else if (mode === 'auto' && backs.length === 1) value = backs[0].rel;
      else if (mode === 'auto' && s?.back?.effective) value = (backs.find((b) => b.name === s.back.effective || b.rel === s.back.effective) || {}).rel || null;
      const isAuto = mode === 'auto' && backs.length === 1;
      const d = dims();
      const options = backs.map((img) => ({
        value: img.rel,
        label: img.name || baseName(img.rel),
        icon: 'image',
        badge: value === img.rel ? { text: 'Chosen', variant: 'success' } : undefined,
        description: backChoiceDescription(img, isAuto && value === img.rel),
      }));
      options.push({
        value: '__none__',
        label: 'No back',
        icon: 'ban',
        badge: value === '__none__' ? { text: 'Chosen', variant: 'success' } : undefined,
        description: h('span.stack', { style: { '--gap': '8px', marginTop: '6px' } },
          h('span.row', { style: { justifyContent: 'center' } },
            h('span', {
              attrs: { 'aria-hidden': 'true' },
              style: { display: 'block', height: '150px', aspectRatio: `${d.widthMm} / ${d.heightMm}`, borderRadius: '8px', background: '#ffffff', border: '1px dashed var(--border-strong)' },
            })),
          h('span', 'The back of single-sided cards stays blank white.')),
      });
      const problem = s?.back?.problem;
      const picker = ui.radioCards({
        ariaLabel: 'Common back image',
        value,
        options,
        disabled: state.busy,
        onChange: (v) => setBackChoice(v),
      });
      picker.querySelectorAll('input[type="radio"]').forEach((input) => mutation(input));
      ui.mountInto(panelEl,
        backPanelIntro(),
        problem ? ui.callout({
          variant: 'warning',
          compact: true,
          title: problem === 'missing' ? 'The back image you chose is missing' : 'Choose one back image',
          message: problem === 'missing'
            ? `“${file || 'It'}” is no longer in the folder. Choose another back below.`
            : `There are ${kindWord('back', backs.length)}. Pick the one printed on the back of your cards.`,
        }) : null,
        toolbar,
        picker);
    }

    /* ----- unique backs ----- */

    function renderPairsPanel() {
      const ds = state.lists.double_sided;
      const intro = h('div.stack', { style: { '--gap': '10px' } },
        h('p.prose', 'Unique backs are for double-faced cards: each one is printed behind the front with the same name, instead of the common back.'),
        onlyFronts() ? ui.callout({
          variant: 'neutral',
          compact: true,
          message: settings()?.pdf?.printBackFaces === false
            ? 'Your PDF is set to print fronts only and not to print back faces, so unique backs are left out.'
            : 'Your PDF is set to print fronts only: the back faces are printed as extra cards next to the fronts.',
        }) : null);
      const toolbar = ui.row({ gap: 8 },
        mutation(ui.button({ label: 'Set back for a card…', icon: 'layers', variant: ds && ds.images.length ? 'secondary' : 'primary', onClick: () => setBackForCard() })),
        ui.button({ label: 'Open folder', icon: 'folder-open', onClick: () => openFolder('double_sided') }));
      if (!ds) {
        ui.mountInto(panelEl, intro, state.errors.double_sided ? errorPanel('double_sided') : ui.skeleton({ lines: 4 }));
        return;
      }
      if (!ds.images.length) {
        ui.mountInto(panelEl, intro, toolbar, ui.emptyState({
          icon: 'layers',
          title: 'No unique backs',
          message: 'Most decks don\'t need any. Double-faced cards downloaded with Get cards appear here automatically.',
          actions: [mutation(ui.button({ label: 'Set back for a card…', icon: 'layers', variant: 'primary', onClick: () => setBackForCard() }))],
        }));
        return;
      }
      const { frontOf } = partnerMaps();
      const d = dims();
      const fit = fitFor('front');
      const cards = ds.images.map((back) => {
        const front = frontOf(back);
        const backName = back.name || baseName(back.rel);
        const owner = front || back;
        const ownerGroup = singleGroup(owner);
        const sideTile = (img, label) => (img
          ? cardTile({
            src: img.url,
            alt: `${label}: ${img.name || baseName(img.rel)}`,
            title: label,
            onOpen: () => openViewModal(ownerGroup, front ? 'front' : 'double_sided', { side: front && img === back ? 'partner' : 'main' }),
            fallbackText: String(img.ext || 'image').toUpperCase(),
          }, d, fit)
          : h('figure.img-tile',
            h('div.img-tile-frame', { style: { aspectRatio: `${d.widthMm} / ${d.heightMm}`, borderStyle: 'dashed', boxShadow: 'none' } },
              h('span.img-tile-fallback', icon('alert-triangle', { size: 20 }), h('span', 'No front'))),
            h('figcaption.img-tile-caption', h('span.img-tile-title', label))));
        const actions = front
          ? [
            mutation(ui.button({ icon: 'refresh', title: 'Replace the unique back', size: 'sm', variant: 'ghost', onClick: () => setBackForCard(front) })),
            mutation(ui.button({ icon: 'trash', title: 'Remove the unique back', size: 'sm', variant: 'ghost', onClick: () => removePartner(front) })),
          ]
          : [mutation(ui.button({ icon: 'trash', title: 'Remove this unique back', size: 'sm', variant: 'ghost', onClick: () => removeRels('double_sided', [back.rel], `“${shortName(backName)}”`) }))];
        return ui.card({
          title: h('span.truncate', { style: { display: 'block' }, title: back.rel }, front ? (front.name || baseName(front.rel)) : backName),
          subtitle: front ? null : h('span.text-warning', 'No front with this name'),
          actions,
          class: front ? null : 'card-warning',
          children: h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, sideTile(front, 'Front'), sideTile(back, 'Unique back')),
        });
      });
      ui.mountInto(panelEl, intro, toolbar, ui.grid({ min: 250, gap: 16 }, cards));
    }

    /* ---------------- recently removed ---------------- */

    function renderTrash() {
      const batches = state.trash || [];
      if (!batches.length) {
        ui.mountInto(trashEl, state.trashError ? ui.callout({ variant: 'neutral', compact: true, message: `Recently removed could not be read: ${state.trashError}` }) : null);
        return;
      }
      const sorted = [...batches].sort((a, b) => toTime(b.at) - toTime(a.at));
      const shown = state.trashExpanded ? sorted : sorted.slice(0, TRASH_PREVIEW);
      const rows = shown.map((b, i) => {
        const n = countOf(b.count);
        const kindList = trashKinds(b.kinds);
        const kinds = kindList.map((k) => TRASH_KIND_WORDS[k] || k).join(', ');
        const noun = kindList.length === 1 && kindList[0] === 'decklist' ? 'file' : 'image';
        const meta = [n ? format.pluralize(n, noun) : null, kinds || null, b.at ? format.formatDate(b.at, { locale: DATE_LOCALE }) : null].filter(Boolean).join(' · ');
        const files = Array.isArray(b.files) ? b.files.filter((f) => typeof f === 'string' && f) : [];
        const fileNames = files.map(baseName);
        let filesLine = null;
        if (fileNames.length) {
          const first = fileNames.slice(0, 3).map((f) => shortName(f, 40)).join(', ');
          const more = Math.max(n, fileNames.length) - Math.min(3, fileNames.length);
          filesLine = more > 0 ? `${first} and ${format.formatNumber(more)} more` : first;
        }
        const label = trashReasonLabel(b.reason, n, b.label);
        return h('div', { style: { padding: '10px 0', borderTop: i ? '1px solid var(--border)' : null } },
          ui.row({ justify: 'between', gap: 12, wrap: false },
            ui.row({ gap: 12, wrap: false, class: 'w-full' },
              h('span.card-icon', icon('history', { size: 16 })),
              h('div', { style: { minWidth: 0, flex: '1' }, title: fileNames.length ? fileNames.slice(0, 20).join('\n') : undefined },
                h('div.strong.truncate', label),
                h('div.small.muted.truncate', meta),
                filesLine ? h('div.tiny.faint.truncate', filesLine) : null)),
            mutation(ui.button({ label: 'Restore', icon: 'undo', size: 'sm', ariaLabel: `Restore: ${label}`, onClick: () => restoreBatch(b.batchId) }))));
      });
      const more = sorted.length > TRASH_PREVIEW
        ? ui.button({
          label: state.trashExpanded ? 'Show fewer' : `Show all ${format.formatNumber(sorted.length)}`,
          variant: 'link',
          size: 'sm',
          onClick: () => {
            state.trashExpanded = !state.trashExpanded;
            renderTrash();
            applyBusy();
          },
        })
        : null;
      ui.mountInto(trashEl, ui.section({
        title: 'Recently removed',
        description: 'Removed images are kept for 14 days, then deleted. Restore them any time before that.',
        icon: 'history',
        actions: [mutation(ui.button({ label: 'Empty all', icon: 'trash', size: 'sm', variant: 'ghost', onClick: () => emptyTrash() }))],
        children: ui.card({ children: [h('div', rows), more] }),
      }));
    }

    function toTime(v) {
      if (typeof v === 'number') return v;
      const t = Date.parse(v);
      return Number.isFinite(t) ? t : 0;
    }

    /* ---------------- next step ---------------- */

    function renderFooter(problemCount) {
      if (!state.lists.front && (state.errors.front || state.loading) && !summary()) {
        // Unknown (still loading, or the cards could not be read): no claim about the next step.
        ui.mountInto(footerEl, null);
        return;
      }
      const n = state.lists.front ? images('front').length : Number(summary()?.front) || 0;
      if (!n) {
        ui.mountInto(footerEl, nextStep({
          text: 'No cards yet',
          detail: 'Download a deck to get started, or add your own images above.',
          icon: 'download',
          tone: 'neutral',
          actionLabel: 'Get cards',
          onAction: () => navigate('fetch'),
        }));
        return;
      }
      const ds = pairedCount();
      const s = settings();
      const upscaleOn = s?.upscayl?.enabled !== false && store.get('env')?.upscayl?.found;
      ui.mountInto(footerEl, nextStep({
        text: problemCount ? `${format.pluralize(n, 'card')} · fix the problems above first` : `${format.pluralize(n, 'card')} ready`,
        detail: [
          ds ? `${format.formatNumber(ds)} with a unique back` : null,
          upscaleOn ? 'low-resolution images are upscaled automatically' : null,
        ].filter(Boolean).join(' · ') || 'Next, make the print-ready PDF.',
        tone: problemCount ? 'warning' : 'success',
        icon: problemCount ? 'alert-triangle' : 'check-circle',
        actionLabel: 'Make PDF',
        onAction: () => navigate('pdf'),
      }));
    }

    /* ---------------- render all ---------------- */

    function renderAll() {
      if (ctx.signal.aborted) return;
      const blocking = renderProblems();
      renderTabBadges();
      renderPanel();
      renderTrash();
      renderFooter(blocking);
      applyBusy();
    }

    /* ---------------- drag & drop ---------------- */

    let dragDepth = 0;
    let overlay = null;
    const hasFiles = (ev) => {
      const types = ev.dataTransfer?.types;
      return !!types && Array.from(types).includes('Files');
    };
    const dropKind = () => (state.tab === 'back' ? 'back' : state.tab === 'front' ? 'front' : null);
    const showOverlay = () => {
      if (overlay) return;
      const main = document.getElementById('main');
      const r = (main || container).getBoundingClientRect();
      const kind = dropKind();
      overlay = h('div', {
        attrs: { 'aria-hidden': 'true' },
        style: {
          position: 'fixed', left: `${r.left + 16}px`, top: `${r.top + 16}px`, width: `${Math.max(0, r.width - 32)}px`, height: `${Math.max(0, r.height - 32)}px`,
          zIndex: 50, pointerEvents: 'none', display: 'flex', borderRadius: '14px', background: 'color-mix(in srgb, var(--layer) 82%, transparent)', backdropFilter: 'blur(2px)',
        },
      }, h('div.empty', { style: { flex: '1', justifyContent: 'center', borderColor: 'var(--accent)', borderWidth: '2px' } },
        h('div.empty-icon', icon(kind ? 'download' : 'ban', { size: 28 })),
        h('h3.empty-title', kind === 'back' ? 'Drop to add common back images' : kind ? 'Drop to add card images' : 'Unique backs are added one by one'),
        h('p.empty-message', kind ? 'The files are copied; your originals are not changed.' : 'Use “Set back for a card…” to pick a front and its back.')));
      document.body.append(overlay);
    };
    const hideOverlay = () => {
      dragDepth = 0;
      overlay?.remove();
      overlay = null;
    };
    const onDragEnter = (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      dragDepth += 1;
      showOverlay();
    };
    const onDragOver = (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = dropKind() && !state.busy ? 'copy' : 'none';
    };
    const onDragLeave = (ev) => {
      if (!hasFiles(ev)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) hideOverlay();
    };
    const onDrop = async (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      hideOverlay();
      const kind = dropKind();
      if (!kind) {
        ui.toast({ variant: 'info', title: 'Use “Set back for a card…”', message: 'Unique backs are added one by one so each one gets the right front.' });
        return;
      }
      if (state.busy) {
        ui.toast({ variant: 'warning', title: 'Please wait', message: 'Images can be added when the current task finishes.' });
        return;
      }
      const files = Array.from(ev.dataTransfer?.files || []);
      if (!files.length) {
        ui.toast({ variant: 'warning', title: 'Save the image to your computer first', message: 'Pictures dragged straight from a web page cannot be added. Save them to a folder, then drag them from there.', timeout: 8000 });
        return;
      }
      const paths = await Promise.all(files.map((f) => Promise.resolve(api.files.pathForFile(f)).then((p) => (typeof p === 'string' ? p : ''), () => '')));
      await addFiles(kind, paths);
    };
    container.addEventListener('dragenter', onDragEnter);
    container.addEventListener('dragover', onDragOver);
    container.addEventListener('dragleave', onDragLeave);
    container.addEventListener('drop', onDrop);
    disposers.push(() => {
      container.removeEventListener('dragenter', onDragEnter);
      container.removeEventListener('dragover', onDragOver);
      container.removeEventListener('dragleave', onDragLeave);
      container.removeEventListener('drop', onDrop);
      hideOverlay();
    });
    // A drag that ends outside the window never fires dragleave on the container.
    const onWindowDragEnd = () => hideOverlay();
    window.addEventListener('dragend', onWindowDragEnd);
    window.addEventListener('drop', onWindowDragEnd);
    disposers.push(() => {
      window.removeEventListener('dragend', onWindowDragEnd);
      window.removeEventListener('drop', onWindowDragEnd);
    });

    /* ---------------- store subscriptions ---------------- */

    let lastVersion = store.get('cards')?.version ?? 0;
    ctx.subscribe('cards', (c) => {
      const v = c?.version ?? 0;
      if (v !== lastVersion) {
        lastVersion = v;
        scheduleReload(80);
      } else if (!state.loading) {
        renderAll();
      }
    });

    ctx.subscribe('job', (job) => {
      const busy = isRunning(job);
      if (busy !== state.busy) {
        state.busy = busy;
        if (state.tab === 'back') renderPanel();
        applyBusy();
      }
    });

    const viewSig = () => {
      const s = settings();
      const d = dims();
      const o = s?.pdf?.options || {};
      return JSON.stringify([s?.ui?.groupIdentical !== false, d.widthMm, d.heightMm, o.fit, o.fit_backs, o.only_fronts, s?.pdf?.printBackFaces,
        s?.cards?.back, s?.upscayl?.enabled, !!store.get('env')?.upscayl?.found]);
    };
    let lastViewSig = viewSig();
    let lastThumb = thumbSize();
    const onSettingsLike = () => {
      if (ctx.signal.aborted) return;
      const t = thumbSize();
      if (t !== lastThumb) {
        lastThumb = t;
        if (gridEl) gridEl.style.setProperty('--thumb-size', `${t}px`);
      }
      const sig = viewSig();
      if (sig !== lastViewSig) {
        lastViewSig = sig;
        if (!state.loading) renderAll();
      }
    };
    ctx.subscribe('settings', onSettingsLike);
    ctx.subscribe('introspection', onSettingsLike);
    ctx.subscribe('env', onSettingsLike);

    /* ---------------- first render ---------------- */

    renderAll();
    load().catch((err) => {
      state.loading = false;
      CARD_KINDS.forEach((k) => { state.errors[k] = api.errorMessage(err); });
      renderAll();
    });

    return () => {
      clearTimeout(reloadTimer);
      loadToken += 1;
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {
          /* keep cleaning */
        }
      }
    };
  },
};
