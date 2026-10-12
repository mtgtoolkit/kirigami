/**
 * Thin wrapper around the preload bridge `window.scm` (spec §6).
 *
 * - Every bridge method is exposed under the same namespace/name (`api.cards.list('front')`) and
 *   returns a Promise. Rejections are normalized: `err.code` (e.g. 'BUSY', 'NOT_READY') is recovered
 *   from the message prefix (contextBridge keeps only `message`) and `err.userMessage` holds a
 *   plain-language sentence for the UI.
 * - `on*` subscription methods (`api.jobs.onEvent(cb)`, `api.settings.onChanged(cb)`,
 *   `api.cards.onChanged(cb)`, `api.app.onNotice(cb)` when present) fan out from ONE bridge
 *   subscription per channel and always return an unsubscribe function.
 * - When the bridge is missing (page opened in a plain browser) `api.available` is false, every
 *   method rejects with code NOT_IN_APP, and {@link renderBridgeMissing} shows a friendly panel.
 *
 * Helpers on the api object: `api.available`, `api.errorMessage(err)`, `api.errorCode(err)`,
 * `api.isBusy(err)`.
 *
 * @module core/api
 */

import { errorMessage, errorCode } from './format.js';
import { h, icon } from './ui.js';

/**
 * @returns {any} the bridge object or undefined
 */
function bridge() {
  return typeof window !== 'undefined' ? window.scm : undefined;
}

/**
 * True when running inside the desktop app (preload bridge present).
 * @returns {boolean}
 */
export function hasBridge() {
  const b = bridge();
  return !!b && typeof b === 'object';
}

/**
 * Normalize anything thrown by the bridge into an Error with `code` and `userMessage`.
 * @param {unknown} err
 * @returns {Error & { code?: string|null, userMessage?: string }}
 */
export function normalizeError(err) {
  let e;
  if (err instanceof Error) e = err;
  else if (err && typeof err === 'object' && typeof err.message === 'string') {
    e = new Error(err.message);
    if (typeof err.code === 'string') e.code = err.code;
    if (err.details !== undefined) e.details = err.details;
  } else e = new Error(typeof err === 'string' ? err : 'Unknown error');
  try {
    const code = errorCode(e);
    if (code && !e.code) e.code = code;
    e.userMessage = errorMessage(e);
  } catch {
    /* frozen error objects: keep as-is */
  }
  return e;
}

/**
 * True for "a job is running, try later" errors.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isBusyError(err) {
  return errorCode(err) === 'BUSY';
}

/** @type {Map<string, { callbacks: Set<Function>, attached: boolean }>} */
const fanouts = new Map();

/**
 * @param {string} key
 * @param {Function} bridgeSubscribe
 * @param {Function} cb
 * @returns {() => void}
 */
function subscribe(key, bridgeSubscribe, cb) {
  if (typeof cb !== 'function') throw new TypeError(`${key}: callback must be a function`);
  let entry = fanouts.get(key);
  if (!entry) {
    entry = { callbacks: new Set(), attached: false };
    fanouts.set(key, entry);
  }
  if (!entry.attached) {
    const target = entry;
    const dispatch = (payload) => {
      for (const fn of [...target.callbacks]) {
        try {
          fn(payload);
        } catch (err) {
          queueMicrotask(() => { throw err; });
        }
      }
    };
    try {
      bridgeSubscribe(dispatch);
      entry.attached = true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[api] could not subscribe to ${key}:`, err);
    }
  }
  entry.callbacks.add(cb);
  return () => {
    entry.callbacks.delete(cb);
  };
}

/**
 * @param {string} ns
 * @param {string} name
 * @param {Function} fn
 * @returns {Function}
 */
function wrapMethod(ns, name, fn) {
  if (/^on[A-Z]/.test(name)) {
    return (cb) => subscribe(`${ns}.${name}`, fn, cb);
  }
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      throw normalizeError(err);
    }
  };
}

const notInAppError = () => normalizeError(new Error('NOT_IN_APP: Run inside the desktop app'));

/**
 * Proxy used when the bridge (or a namespace) is missing: methods reject, subscriptions no-op.
 * @param {string} ns
 */
function missingNamespace(ns) {
  return new Proxy({}, {
    get(_target, name) {
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (/^on[A-Z]/.test(name)) return () => () => {};
      return async () => {
        const e = hasBridge()
          ? normalizeError(new Error(`The app does not provide ${ns}.${name}() (update or reinstall the app).`))
          : notInAppError();
        throw e;
      };
    },
  });
}

/**
 * Build the api object from the bridge present at import time.
 * @returns {Record<string, any>}
 */
function createApi() {
  const scm = bridge();
  const api = {
    available: !!scm,
    errorMessage,
    errorCode,
    isBusy: isBusyError,
  };
  if (scm && typeof scm === 'object') {
    for (const [ns, obj] of Object.entries(scm)) {
      if (obj && typeof obj === 'object') {
        const wrapped = {};
        for (const [name, fn] of Object.entries(obj)) {
          if (typeof fn === 'function') wrapped[name] = wrapMethod(ns, name, fn);
          else wrapped[name] = fn;
        }
        api[ns] = new Proxy(wrapped, {
          get(target, name) {
            if (name in target || typeof name !== 'string' || name === 'then') return target[name];
            return missingNamespace(ns)[name];
          },
        });
      } else if (typeof obj === 'function') {
        api[ns] = wrapMethod('scm', ns, obj);
      }
    }
  }
  return new Proxy(api, {
    get(target, name) {
      if (name in target || typeof name !== 'string' || name === 'then') return target[name];
      return missingNamespace(name);
    },
  });
}

/**
 * The app API (see module docs). Namespaces: app, updates, settings, env, engine, decklists, cards,
 * fetch, upscayl, pdf, offset, print, jobs, shell, dialog, files.
 */
export const api = createApi();

/**
 * Render the "Run inside the desktop app" panel (used when `window.scm` is missing).
 * @param {HTMLElement} container
 */
export function renderBridgeMissing(container) {
  if (!container) return;
  container.classList.add('bridge-missing-host');
  container.removeAttribute('aria-busy');
  container.replaceChildren(h('div.bridge-missing', { role: 'main' },
    h('div.bridge-missing-card',
      h('img.bridge-missing-logo', { src: 'assets/logo.svg', alt: '', width: 56, height: 56 }),
      h('h1', 'Run inside the desktop app'),
      h('p', 'This window is part of the Kirigami desktop app. It cannot work when opened directly in a web browser, because it needs the app to read your card images and make PDFs.'),
      h('ul.bridge-missing-list',
        h('li', icon('monitor', { size: 16 }), h('span', 'Start ', h('strong', 'Kirigami'), ' from the Start menu or the desktop shortcut.')),
        h('li', icon('terminal', { size: 16 }), h('span', 'Developers: run ', h('code', 'npm start'), ' in the Kirigami repository folder.'))))));
}
