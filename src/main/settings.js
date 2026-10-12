'use strict';

/**
 * Settings store (`userData/settings.json`), spec §4.
 *
 * - In-memory state is the truth; `update()` is synchronous and never fails because of a transient
 *   disk error (writes are debounced and retried by util.createJsonWriter).
 * - Deep merge: objects merge, arrays/primitives replace, `null` sets null, `undefined` is ignored.
 * - Protected keys can only be changed with `{ internal: true }` (validated main-process APIs).
 * - Settings that are objects in the defaults (ui, pdf.options, …) must stay objects.
 * - A corrupt file is renamed to `settings.json.bak` and defaults are used.
 */

const fs = require('node:fs');
const { createJsonWriter, isPlainObject, sleepSync, RETRYABLE_FS_CODES } = require('./util');

/** Keys (dotted paths) the renderer may not change directly. */
const PROTECTED_KEYS = Object.freeze([
  'workspaceDir',
  'venvDir',
  'pythonPath',
  'upscayl.binPath',
  'upscayl.modelsDir',
  'upscayl.customModelsDir',
]);

/** Keys never merged (prototype pollution guard). */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

/** Default settings (exact, spec §4). Deep-frozen: clone before modifying. */
const DEFAULT_SETTINGS = deepFreeze({
  version: 2,
  setupComplete: false,
  welcomeAccepted: false,
  workspaceDir: null,
  venvDir: null,
  pythonPath: null,
  outputDir: null,
  theme: 'system',
  equipment: { machine: null, paper: null },
  ui: {
    advancedMode: false,
    groupIdentical: true,
    thumbSize: 150,
    lastDirs: { images: null, decklist: null, python: null, upscayl: null, output: null, pdf: null },
  },
  fetch: {
    plugin: 'mtg',
    formatByPlugin: { mtg: 'mtga' },
    optionsByPlugin: {},
    clearBeforeFetch: true,
    source: { kind: 'text', deckName: 'my-deck', text: '', filePath: null, savedName: null, url: '' },
    lastFetched: null,
  },
  cards: { back: { mode: 'auto', file: null } },
  upscayl: {
    binPath: null,
    modelsDir: null,
    customModelsDir: null,
    enabled: true,
    askedOnce: false,
    model: 'upscayl-standard-4x',
    scale: 4,
    smartScale: true,
    format: 'same',
    compression: 0,
    gpuId: 'auto',
    tileSize: 0,
    tta: false,
    threads: '',
    targets: { front: true, back: true, double_sided: true },
    gpus: null,
    gpusDetectedFor: null,
    secPerImage: 3,
  },
  pdf: {
    options: {
      card_size: 'standard',
      paper_size: 'a4',
      registration: '4',
      registration_orientation: null,
      specialty: null,
      only_fronts: true,
      fit: 'stretch',
      fit_backs: null,
      crop: null,
      crop_backs: null,
      extend_edges: '0.5mm',
      extend_edges_backs: null,
      extend_corners: '2mm',
      extend_corners_backs: null,
      extend_bleed: null,
      extend_bleed_backs: null,
      ppi: 1440,
      quality: 100,
      load_offset: false,
      label: null,
      show_outline: false,
      borderless: false,
      output_images: false,
    },
    skipByLayout: {},
    printBackFaces: true,
    fileName: null,
    openWhenDone: true,
    presets: {},
    memoryBudgetPercent: 50,
    lastPdf: null,
    secPerCard: null,
  },
  offset: { ppi: null },
  updates: { appCheck: true, engineAuto: true },
});

/**
 * Deep clone of a JSON-like value. Drops `undefined` object members and prototype-pollution keys;
 * non-finite numbers become null; other objects (Date, …) go through JSON.
 * @param {any} value
 * @returns {any}
 */
function cloneValue(value) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      return Number.isFinite(value) ? value : null;
    case 'bigint':
      return Number(value);
    case 'undefined':
      return undefined;
    case 'object':
      break;
    default:
      throw new TypeError(`Settings cannot store a ${typeof value}`);
  }
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : cloneValue(item)));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key) || value[key] === undefined) continue;
      out[key] = cloneValue(value[key]);
    }
    return out;
  }
  return JSON.parse(JSON.stringify(value));
}

function mergeInto(target, src) {
  for (const key of Object.keys(src)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    const value = src[key];
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value);
    else target[key] = cloneValue(value);
  }
}

/**
 * Deep merge `b` into a deep copy of `a` (inputs are never mutated; the result shares nothing with
 * them). Plain objects merge recursively; arrays, primitives and `null` replace; `undefined` is
 * ignored; `__proto__` / `constructor` / `prototype` keys are skipped.
 * @param {object} a
 * @param {object} b
 * @returns {object}
 */
function deepMerge(a, b) {
  const out = isPlainObject(a) ? cloneValue(a) : {};
  if (isPlainObject(b)) mergeInto(out, b);
  return out;
}

/**
 * Structural equality for JSON-like values.
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const key of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !deepEqual(a[key], b[key])) return false;
  }
  return true;
}

function getAt(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split('.')) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Throw when a key that is an object in the defaults is no longer an object. */
function assertContainers(defaults, value, prefix) {
  for (const key of Object.keys(defaults)) {
    if (!isPlainObject(defaults[key])) continue;
    if (!isPlainObject(value[key])) {
      const err = new TypeError(`Setting "${prefix}${key}" must be an object`);
      err.code = 'INVALID_SETTING';
      throw err;
    }
    assertContainers(defaults[key], value[key], `${prefix}${key}.`);
  }
}

/** Replace keys that must be objects but are not (hand-edited file) with their defaults. */
function repairContainers(defaults, value, prefix, report) {
  for (const key of Object.keys(defaults)) {
    if (!isPlainObject(defaults[key])) continue;
    if (!isPlainObject(value[key])) {
      report(new Error(`Settings: "${prefix}${key}" was not an object; its defaults were restored`));
      value[key] = cloneValue(defaults[key]);
    } else {
      repairContainers(defaults[key], value[key], `${prefix}${key}.`, report);
    }
  }
}

function topLevelChanges(prev, next) {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  return [...keys].filter((k) => !deepEqual(prev[k], next[k]));
}

function loadSettingsFile(filePath, report) {
  let text;
  for (let attempt = 0; ; attempt += 1) {
    try {
      text = fs.readFileSync(filePath, 'utf8');
      break;
    } catch (err) {
      if (err && err.code === 'ENOENT') return { data: {}, status: 'missing', backupPath: null };
      if (RETRYABLE_FS_CODES.has(err && err.code) && attempt < 4) {
        sleepSync(50 * (attempt + 1));
        continue;
      }
      report(new Error(`Could not read the settings file (${err && err.message}); defaults are used for now`));
      return { data: {}, status: 'unreadable', backupPath: null };
    }
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    const parsed = JSON.parse(text);
    if (!isPlainObject(parsed)) throw new Error('the top-level value is not an object');
    return { data: parsed, status: 'ok', backupPath: null };
  } catch (err) {
    const backupPath = `${filePath}.bak`;
    try {
      fs.renameSync(filePath, backupPath);
    } catch {
      try { fs.copyFileSync(filePath, backupPath); } catch { /* keep going with defaults */ }
    }
    report(new Error(`The settings file was damaged (${err.message}); defaults are used. The damaged file was kept as ${backupPath}`));
    return { data: {}, status: 'corrupt', backupPath };
  }
}

/**
 * Create the settings store.
 *
 * @param {string} filePath absolute path of settings.json
 * @param {object} [defaults=DEFAULT_SETTINGS]
 * @param {{ writer?: { write(obj: any): void, flush(): Promise<void>, flushSync?(): void },
 *           onError?: (err: Error) => void, debounceMs?: number, retryDelayMs?: number }} [opts]
 * @returns {{
 *   get(): object,
 *   update(patch: object, options?: { internal?: boolean }): object,
 *   reset(): object,
 *   onChange(cb: (settings: object, meta: { patch: object|null, internal: boolean, reset: boolean, changedKeys: string[] }) => void): () => void,
 *   flush(): Promise<void>,
 *   flushSync(): void,
 *   file: string,
 *   loadStatus: 'missing'|'ok'|'corrupt'|'unreadable',
 *   backupPath: string|null,
 * }}
 *   `get()` returns a deep copy. `update()` returns the new settings (a copy) and throws
 *   `Error{code:'PROTECTED_SETTING', keys}` for protected keys without `internal`, or
 *   `TypeError{code:'INVALID_SETTING'}` when an object setting would stop being an object.
 */
function createSettingsStore(filePath, defaults = DEFAULT_SETTINGS, opts = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('createSettingsStore: filePath is required');
  const options = opts || {};
  const report = (err) => {
    try {
      if (typeof options.onError === 'function') options.onError(err);
      // eslint-disable-next-line no-console
      else console.error('[settings]', err && err.message ? err.message : err);
    } catch { /* never throw from error reporting */ }
  };
  const writer = options.writer || createJsonWriter(filePath, {
    debounceMs: Number.isFinite(options.debounceMs) ? options.debounceMs : 300,
    retryDelayMs: options.retryDelayMs,
    onError: report,
  });

  const base = deepMerge({}, isPlainObject(defaults) ? defaults : DEFAULT_SETTINGS);
  const loaded = loadSettingsFile(filePath, report);
  let state = deepMerge(base, loaded.data);
  repairContainers(base, state, '', report);
  if (base.version !== undefined) state.version = base.version;
  if (loaded.status === 'ok' && loaded.data.version !== state.version) writer.write(state);

  const listeners = new Set();

  function emitChange(meta) {
    if (listeners.size === 0) return;
    const snapshot = cloneValue(state);
    for (const cb of Array.from(listeners)) {
      try {
        cb(snapshot, meta);
      } catch (err) {
        report(err);
      }
    }
  }

  return {
    file: filePath,
    loadStatus: loaded.status,
    backupPath: loaded.backupPath,

    /** @returns {object} deep copy of the current settings */
    get() {
      return cloneValue(state);
    },

    update(patch, updateOptions = {}) {
      if (!isPlainObject(patch)) throw new TypeError('Settings update must be a plain object');
      const internal = !!(updateOptions && updateOptions.internal);
      const next = deepMerge(state, patch);
      assertContainers(base, next, '');
      if (state.version !== undefined) next.version = state.version;
      if (!internal) {
        const changed = PROTECTED_KEYS.filter((key) => !deepEqual(getAt(state, key), getAt(next, key)));
        if (changed.length) {
          const err = new Error(`These settings can only be changed from their own screen: ${changed.join(', ')}`);
          err.code = 'PROTECTED_SETTING';
          err.keys = changed;
          throw err;
        }
      }
      if (deepEqual(state, next)) return cloneValue(state);
      const changedKeys = topLevelChanges(state, next);
      state = next;
      writer.write(state);
      emitChange({ patch: cloneValue(patch), internal, reset: false, changedKeys });
      return cloneValue(state);
    },

    reset() {
      const next = deepMerge({}, base);
      if (deepEqual(state, next)) return cloneValue(state);
      const changedKeys = topLevelChanges(state, next);
      state = next;
      writer.write(state);
      emitChange({ patch: null, internal: true, reset: true, changedKeys });
      return cloneValue(state);
    },

    onChange(cb) {
      if (typeof cb !== 'function') throw new TypeError('onChange expects a function');
      listeners.add(cb);
      return () => listeners.delete(cb);
    },

    /** Write pending changes now (call before quitting). Never rejects. */
    flush() {
      return Promise.resolve(writer.flush()).catch(report);
    },

    /** Synchronous last-chance write (process exit / Windows session end). */
    flushSync() {
      try {
        if (typeof writer.flushSync === 'function') writer.flushSync();
      } catch (err) {
        report(err);
      }
    },
  };
}

module.exports = {
  createSettingsStore,
  DEFAULT_SETTINGS,
  PROTECTED_KEYS,
  deepMerge,
  deepEqual,
  cloneValue,
};
