/**
 * Hash router with lazily imported views (spec §8.3).
 *
 * Routes look like `#/pdf` or `#/pdf?tab=more`. Each registered view is imported on first visit;
 * a missing module, a module without `mount()`, or a `mount()` that throws/rejects renders an error
 * panel (never a blank app).
 *
 * View contract: `export default { id, title, icon, mount(container, ctx) -> unmount? }`, where
 * `ctx = { api, store, ui, navigate, format, params, signal, onCleanup, subscribe, refresh }`
 * (`api/store/ui/format/refresh` come from the shell's `getContext`; the router adds `params`,
 * `navigate`, `signal` (aborted on unmount), `onCleanup(fn)` and `subscribe(key, cb, opts)` (store
 * subscription removed automatically on unmount)). `mount` may be async and may return the unmount
 * function (or `{ unmount }`).
 *
 * @module core/router
 */

import { h, icon, button, copyText, toast } from './ui.js';

/**
 * @typedef {object} ViewDef
 * @property {string} id
 * @property {string} title
 * @property {string} [icon]
 * @property {() => Promise<any>} load dynamic import of the view module
 * @property {boolean} [hidden] not shown in navigation (informational)
 */

/** @type {Map<string, ViewDef & { module?: any }>} */
const views = new Map();

const config = {
  /** @type {HTMLElement|null} */
  container: null,
  /** @type {HTMLElement|null} element scrolled to top on navigation */
  scrollContainer: null,
  /** @type {() => object} */
  getContext: () => ({}),
  /** @type {() => string} */
  defaultRoute: () => (views.keys().next().value || ''),
  /** @type {((route: { id: string, params: Record<string, string>, view: ViewDef|null }) => void)|null} */
  onRouteChange: null,
  appTitle: 'Kirigami',
};

let started = false;
let navToken = 0;
/** @type {{ id: string, params: Record<string, string>, hash: string, cleanup: () => void }|null} */
let current = null;
let firstRender = true;

/**
 * Parse a location hash into a route id and params. Pure.
 * `'#/pdf?tab=more'` → `{ id: 'pdf', params: { tab: 'more' } }`; empty → `{ id: '', params: {} }`.
 * @param {string} hash
 * @returns {{ id: string, params: Record<string, string> }}
 */
export function parseHash(hash) {
  let s = String(hash || '');
  if (s.startsWith('#')) s = s.slice(1);
  if (s.startsWith('/')) s = s.slice(1);
  const q = s.indexOf('?');
  const path = (q === -1 ? s : s.slice(0, q)).replace(/\/+$/, '');
  const query = q === -1 ? '' : s.slice(q + 1);
  let id = path.split('/')[0] || '';
  try {
    id = decodeURIComponent(id);
  } catch {
    /* keep raw */
  }
  const params = {};
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) params[k] = v;
  }
  return { id, params };
}

/**
 * Build a hash for a route. Pure. null/undefined params are skipped.
 * @param {string} id
 * @param {Record<string, unknown>} [params]
 * @returns {string} e.g. `#/pdf?tab=more`
 */
export function buildHash(id, params) {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined) continue;
    search.append(k, String(v));
  }
  const qs = search.toString();
  return `#/${encodeURIComponent(String(id || ''))}${qs ? `?${qs}` : ''}`;
}

/**
 * Register a lazily loaded view.
 * @param {ViewDef} def
 */
export function registerView(def) {
  if (!def || typeof def.id !== 'string' || !def.id) throw new TypeError('registerView: id is required');
  if (typeof def.load !== 'function') throw new TypeError(`registerView(${def.id}): load() is required`);
  views.set(def.id, { title: def.id, ...def });
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function hasView(id) {
  return views.has(id);
}

/**
 * All registered views in registration order.
 * @returns {ViewDef[]}
 */
export function listViews() {
  return [...views.values()];
}

/**
 * Configure the router (container, context factory, default route…). May be called before `start`.
 * @param {{ container?: HTMLElement, scrollContainer?: HTMLElement, getContext?: () => object, defaultRoute?: () => string, onRouteChange?: (route: object) => void, appTitle?: string }} options
 */
export function configureRouter(options = {}) {
  for (const key of Object.keys(config)) {
    if (options[key] !== undefined) config[key] = options[key];
  }
}

/**
 * Start listening to hash changes and render the current route (the default route when the hash
 * is empty).
 * @param {Parameters<typeof configureRouter>[0]} [options]
 */
export function start(options = {}) {
  configureRouter(options);
  if (!config.container) throw new Error('router.start: no container configured');
  if (!started) {
    window.addEventListener('hashchange', () => {
      handleRoute();
    });
    started = true;
  }
  handleRoute();
}

/**
 * Navigate to a view. Same route + params = no-op unless `force`.
 * @param {string} id
 * @param {Record<string, unknown>} [params]
 * @param {{ replace?: boolean, force?: boolean }} [options]
 */
export function navigate(id, params, { replace = false, force = false } = {}) {
  const hash = buildHash(id, params);
  if (location.hash === hash) {
    if (force) handleRoute({ force: true });
    return;
  }
  if (replace || !started) {
    history.replaceState(null, '', hash);
    if (started) handleRoute();
  } else {
    location.hash = hash;
  }
}

/**
 * Re-mount the current view (used by "Try again").
 */
export function reload() {
  handleRoute({ force: true });
}

/**
 * The current route.
 * @returns {{ id: string, params: Record<string, string>, title: string|null }|null}
 */
export function currentRoute() {
  if (!current) return null;
  const def = views.get(current.id);
  return { id: current.id, params: { ...current.params }, title: def ? def.title : null };
}

function unmountCurrent() {
  if (!current) return;
  const c = current;
  current = null;
  try {
    c.cleanup();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[router] Error while leaving "${c.id}":`, err);
  }
}

/**
 * @param {{ force?: boolean }} [options]
 */
async function handleRoute({ force = false } = {}) {
  let { id, params } = parseHash(location.hash);
  if (!id) {
    id = config.defaultRoute() || '';
    if (id) {
      history.replaceState(null, '', buildHash(id));
      params = {};
    }
  }
  const hash = buildHash(id, params);
  if (!force && current && current.hash === hash) return;

  const token = ++navToken;
  unmountCurrent();
  const def = views.get(id) || null;
  const container = config.container;
  const root = h('div', { class: 'view', dataset: { view: id || 'none' } });
  container.replaceChildren(root);
  if (!firstRender && config.scrollContainer) config.scrollContainer.scrollTop = 0;

  const controller = new AbortController();
  const cleanups = [];
  let unmountFn = null;
  current = {
    id,
    params,
    hash,
    cleanup: () => {
      controller.abort();
      if (typeof unmountFn === 'function') {
        try {
          unmountFn();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[router] unmount of "${id}" failed:`, err);
        }
      }
      for (const fn of cleanups.splice(0).reverse()) {
        try {
          fn();
        } catch {
          /* keep cleaning */
        }
      }
    },
  };

  document.title = def ? `${def.title} · ${config.appTitle}` : config.appTitle;
  if (typeof config.onRouteChange === 'function') {
    try {
      config.onRouteChange({ id, params: { ...params }, view: def });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[router] onRouteChange failed:', err);
    }
  }

  if (!def) {
    renderNotFound(root, id);
    firstRender = false;
    return;
  }

  const loadingTimer = setTimeout(() => {
    if (token === navToken && !root.firstChild) {
      root.append(h('div.view-loading', h('span.spinner', { style: { '--spinner-size': '22px' }, attrs: { 'aria-hidden': 'true' } }), h('span', 'Loading…')));
    }
  }, 150);

  try {
    let mod = def.module;
    if (!mod) {
      mod = await def.load();
      def.module = mod;
    }
    if (token !== navToken) return;
    const view = mod && (mod.default ?? mod);
    if (!view || typeof view.mount !== 'function') {
      throw new Error(`The page module "${id}" does not export a view with a mount() function.`);
    }
    clearTimeout(loadingTimer);
    root.replaceChildren();
    const base = config.getContext() || {};
    const store = base.store;
    const ctx = {
      ...base,
      params: { ...params },
      navigate,
      signal: controller.signal,
      onCleanup: (fn) => {
        if (typeof fn !== 'function') return;
        // Registered after the view was left (async mount still running): the cleanup list was
        // already drained, so run it right away instead of leaking it.
        if (controller.signal.aborted) {
          try {
            fn();
          } catch {
            /* ignore */
          }
          return;
        }
        cleanups.push(fn);
      },
      subscribe: (key, cb, opts) => {
        if (!store || typeof store.subscribe !== 'function' || controller.signal.aborted) return () => {};
        const off = store.subscribe(key, cb, opts);
        cleanups.push(off);
        return off;
      },
    };
    const ret = await view.mount(root, ctx);
    const fn = typeof ret === 'function' ? ret : (ret && typeof ret.unmount === 'function' ? () => ret.unmount() : null);
    if (token !== navToken || controller.signal.aborted) {
      // Navigated away while mounting: clean up immediately.
      if (fn) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    unmountFn = fn;
    if (!firstRender) moveFocusTo(root);
  } catch (err) {
    clearTimeout(loadingTimer);
    if (token !== navToken) return;
    // eslint-disable-next-line no-console
    console.error(`[router] Could not open "${id}":`, err);
    renderRouteError(root, { title: def.title, error: err, onRetry: () => handleRoute({ force: true }) });
  } finally {
    firstRender = false;
  }
}

/**
 * After a user navigation, move keyboard/screen-reader focus to the new page's heading (or the
 * scroll container) without scrolling, unless the view already focused something itself.
 * @param {HTMLElement} root
 */
function moveFocusTo(root) {
  const active = document.activeElement;
  if (active && active !== document.body && root.contains(active)) return;
  const heading = root.querySelector('h1');
  try {
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    } else if (config.scrollContainer) {
      config.scrollContainer.focus({ preventScroll: true });
    }
  } catch {
    /* ignore */
  }
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isModuleLoadError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(msg);
}

/**
 * Render the "page couldn't be opened" panel. Exported so other code (and the kitchen) can reuse it.
 * @param {HTMLElement} root
 * @param {{ title?: string, error: unknown, onRetry?: () => void }} info
 */
export function renderRouteError(root, { title, error, onRetry }) {
  const missing = isModuleLoadError(error);
  const details = [
    error && error.message ? error.message : String(error),
    error && error.stack ? `\n${error.stack}` : '',
  ].join('').trim();
  const fallbackId = config.defaultRoute();
  const fallback = views.get(fallbackId);
  root.replaceChildren(h('div.route-error', { role: 'alert' },
    h('div.route-error-icon', icon('alert-triangle', { size: 28 })),
    h('h1.route-error-title', "This page couldn't be opened"),
    h('p.route-error-message', missing
      ? `Part of the app needed for “${title || 'this page'}” is missing or damaged. Reinstalling Kirigami should fix it. Your cards and settings are safe.`
      : `Something went wrong while opening “${title || 'this page'}”. Your cards and settings are safe.`),
    h('div.route-error-actions',
      onRetry && button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: onRetry }),
      button({
        label: 'Copy details',
        icon: 'copy',
        onClick: async () => {
          const ok = await copyText(`${title || ''}\n${details}`);
          toast({ variant: ok ? 'success' : 'warning', title: ok ? 'Details copied' : 'Could not copy the details', timeout: 2500 });
        },
      }),
      fallback && fallback.id !== current?.id && button({ label: `Go to ${fallback.title}`, variant: 'ghost', iconRight: 'arrow-right', onClick: () => navigate(fallback.id) })),
    h('details.route-error-details', h('summary', 'Technical details'), h('pre.mono', details))));
}

/**
 * @param {HTMLElement} root
 * @param {string} id
 */
function renderNotFound(root, id) {
  const fallbackId = config.defaultRoute();
  const fallback = views.get(fallbackId);
  root.replaceChildren(h('div.route-error',
    h('div.route-error-icon.is-neutral', icon('search', { size: 28 })),
    h('h1.route-error-title', 'Page not found'),
    h('p.route-error-message', id ? `There is no page called “${id}”.` : 'There is nothing to show here yet.'),
    h('div.route-error-actions',
      fallback && button({ label: `Go to ${fallback.title}`, variant: 'primary', iconRight: 'arrow-right', onClick: () => navigate(fallback.id) }))));
}
