/**
 * Renderer entry point (spec §8.1 / §8.2).
 *
 * Boot: theme → bridge check → sidebar + activity bar → app info + settings → event subscriptions →
 * env status + job re-sync (jobs.active()/history(), so a reload mid-job keeps showing it) →
 * introspection (only when the env is ready) + cards summary → router (default route logic).
 *
 * Keeps the store (core/store.js) in sync with the main process: `settings:changed`, `jobs:event`,
 * `cards:changed` and `app:notice` events.
 *
 * View context (`ctx`): `{ api, store, ui, format, refresh, navigate, params, signal, onCleanup,
 * subscribe }` where `refresh = { settings(), env({ refresh }), cards(), introspection({ force }), jobs() }`.
 *
 * @module main
 */

import { api, hasBridge, renderBridgeMissing } from './core/api.js';
import { createStore, reduceJobEvent, jobFromSummary, normalizeWarnings } from './core/store.js';
import * as router from './core/router.js';
import * as ui from './core/ui.js';
import * as format from './core/format.js';
import { mountActivityBar } from './components/activity.js';
import { iconMarkup } from './core/icons.js';

const { h, icon } = ui;

/**
 * Docs links verified against the engine's hugo/content (tutorial/, tutorial/troubleshooting.md,
 * tutorial/supplies.md). `updates` is Kirigami's own releases page (APP_REPO_URL in js/data/help.js).
 */
const HELP_FALLBACK = Object.freeze({
  tutorial: 'https://alan-cha.github.io/silhouette-card-maker/tutorial/',
  troubleshooting: 'https://alan-cha.github.io/silhouette-card-maker/tutorial/troubleshooting/',
  supplies: 'https://alan-cha.github.io/silhouette-card-maker/tutorial/supplies/',
  discord: 'https://discord.gg/jhsKmAgbXc',
  website: 'https://alan-cha.github.io/silhouette-card-maker',
  updates: 'https://github.com/mtgtoolkit/kirigami/releases',
});

/** Views (lazy). `step` = number shown in the sidebar circle. */
const VIEW_DEFS = [
  { id: 'setup', title: 'Setup', icon: 'package', load: () => import('./views/setup.js') },
  { id: 'fetch', title: 'Get cards', icon: 'download', step: 1, load: () => import('./views/fetch.js') },
  { id: 'cards', title: 'Your cards', icon: 'images', step: 2, load: () => import('./views/cards.js') },
  { id: 'upscale', title: 'Upscale', icon: 'sparkles', step: 3, load: () => import('./views/upscale.js') },
  { id: 'pdf', title: 'Make PDF', icon: 'file-pdf', step: 4, load: () => import('./views/pdf.js') },
  { id: 'print', title: 'Print & cut', icon: 'scissors', step: 5, load: () => import('./views/print.js') },
  { id: 'offset', title: 'Printer alignment', icon: 'crosshair', load: () => import('./views/offset.js') },
  { id: 'settings', title: 'Settings', icon: 'settings', load: () => import('./views/settings.js') },
];
const KITCHEN_DEF = { id: 'kitchen', title: 'UI kitchen', icon: 'grid', hidden: true, load: () => import('./views/kitchen.js') };

const NAV_GROUPS = [
  { label: 'Make proxies', items: ['fetch', 'cards', 'upscale', 'pdf', 'print'] },
  { label: 'One-time setup', items: ['offset', 'settings'] },
];

/** Job kind → sidebar item that shows a busy indicator. */
const JOB_ROUTE = { fetch: 'fetch', samples: 'cards', upscale: 'upscale', preview: 'upscale', probe: 'upscale', pdf: 'pdf', offset: 'offset', calibration: 'offset', setup: 'settings' };

const store = createStore({
  settings: null,
  env: null,
  introspection: null,
  introspectionStatus: { state: 'idle', error: null },
  cards: { summary: null, version: 0, error: null },
  job: null,
  jobs: [],
  appInfo: null,
  lastResults: {},
  route: null,
});

/* ------------------------------------------------------------------------------------------------
 * Theme
 * ---------------------------------------------------------------------------------------------- */

/** Sidebar theme toggle (created in renderSidebarFooter). @type {HTMLButtonElement|null} */
let themeButton = null;
const darkQuery = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
let themePref = 'system';

/**
 * Apply 'light' | 'dark' | 'system' to <html data-theme>.
 * @param {string|undefined} pref
 */
function applyTheme(pref) {
  themePref = pref === 'light' || pref === 'dark' ? pref : 'system';
  const resolved = themePref === 'system' ? (darkQuery && !darkQuery.matches ? 'light' : 'dark') : themePref;
  const root = document.documentElement;
  root.dataset.theme = resolved;
  root.dataset.themePref = themePref;
  root.style.colorScheme = resolved;
  updateThemeButton();
}
darkQuery?.addEventListener('change', () => {
  if (themePref === 'system') applyTheme('system');
});
applyTheme('system');

/* ------------------------------------------------------------------------------------------------
 * Data refreshers (also exposed to views as ctx.refresh)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Resolve after `ms` with undefined if `promise` is slower (never rejects).
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|undefined>}
 */
function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise).catch(() => undefined),
    new Promise((resolve) => { setTimeout(() => resolve(undefined), ms); }),
  ]);
}

async function refreshSettings() {
  const settings = await api.settings.get();
  store.set('settings', settings);
  applyTheme(settings?.theme);
  return settings;
}

/**
 * @param {{ refresh?: boolean }} [options]
 */
async function refreshEnv({ refresh = false } = {}) {
  try {
    const env = await api.env.status({ refresh });
    store.set('env', env);
    if (env?.ready && !store.get('introspection') && store.get('introspectionStatus')?.state !== 'loading') {
      refreshIntrospection();
    }
    return env;
  } catch (err) {
    const env = { ready: false, error: format.errorMessage(err) };
    store.set('env', env);
    return env;
  }
}

let introspectionPromise = null;
/**
 * @param {{ force?: boolean }} [options]
 */
function refreshIntrospection({ force = false } = {}) {
  if (!store.get('env')?.ready) return Promise.resolve(store.get('introspection'));
  if (introspectionPromise && !force) return introspectionPromise;
  store.set('introspectionStatus', { state: 'loading', error: null });
  const p = api.engine.introspect({ force })
    .then((data) => {
      store.set('introspection', data || null);
      store.set('introspectionStatus', { state: 'ready', error: null });
      return data;
    }, (err) => {
      store.set('introspectionStatus', { state: 'error', error: format.errorMessage(err) });
      return store.get('introspection');
    })
    .finally(() => {
      if (introspectionPromise === p) introspectionPromise = null;
    });
  introspectionPromise = p;
  return p;
}

let cardsInFlight = null;
let cardsQueued = false;
function refreshCards() {
  if (cardsInFlight) {
    cardsQueued = true;
    return cardsInFlight;
  }
  cardsInFlight = (async () => {
    try {
      const summary = await api.cards.summary();
      store.update('cards', (c) => ({ summary, version: (c?.version || 0) + 1, error: null }));
    } catch (err) {
      store.update('cards', (c) => ({ summary: c?.summary ?? null, version: (c?.version || 0) + 1, error: format.errorMessage(err) }));
    }
  })().finally(() => {
    cardsInFlight = null;
    if (cardsQueued) {
      cardsQueued = false;
      refreshCards();
    }
  });
  return cardsInFlight;
}

async function refreshHistory() {
  try {
    const list = await api.jobs.history();
    if (Array.isArray(list)) store.set('jobs', list);
  } catch {
    /* keep the old history */
  }
}

/** Re-sync the active job and history from the main process (after boot or a renderer reload). */
async function resyncJobs() {
  const [activeRes] = await Promise.allSettled([api.jobs.active(), refreshHistory()]);
  if (activeRes.status !== 'fulfilled') return;
  const summary = activeRes.value;
  const current = store.get('job');
  if (summary) {
    const jobId = String(summary.jobId ?? summary.id);
    let logText = '';
    try {
      const text = await api.jobs.log(jobId);
      if (typeof text === 'string') logText = text;
    } catch {
      /* log not available */
    }
    const synced = jobFromSummary(summary, logText);
    if (!synced) return;
    const latest = store.get('job');
    if (latest && latest.jobId === synced.jobId && !latest.needsSync && latest.logTotal > synced.logTotal) {
      store.set('job', { ...latest, title: synced.title, steps: synced.steps.length ? synced.steps : latest.steps });
    } else if (latest && latest.jobId === synced.jobId && latest.status !== 'running') {
      // Finished while we were syncing: keep the finished state, adopt the title/steps.
      store.set('job', { ...latest, title: synced.title, steps: synced.steps.length ? synced.steps : latest.steps, needsSync: false });
    } else {
      store.set('job', { ...synced, progress: latest?.jobId === synced.jobId && latest.progress ? latest.progress : synced.progress });
    }
  } else if (current && (current.status === 'running' || current.needsSync)) {
    const hist = (store.get('jobs') || []).find((j) => String(j.jobId ?? j.id) === current.jobId);
    if (current.status === 'running') {
      // The job we were showing is no longer active: show its final state from history if known.
      const finished = hist ? jobFromSummary(hist) : null;
      store.set('job', finished ? { ...finished, logLines: current.logLines, logTotal: current.logTotal } : null);
    } else {
      // Finished placeholder (created from events after a reload): adopt the real title/steps.
      store.set('job', {
        ...current,
        title: hist?.title || current.title,
        steps: Array.isArray(hist?.steps) && hist.steps.length ? jobFromSummary(hist).steps : current.steps,
        startedAt: current.startedAt ?? hist?.startedAt ?? null,
        needsSync: false,
      });
    }
  }
}

const refresh = Object.freeze({
  settings: refreshSettings,
  env: refreshEnv,
  cards: refreshCards,
  introspection: refreshIntrospection,
  jobs: resyncJobs,
});

/* ------------------------------------------------------------------------------------------------
 * Events from the main process
 * ---------------------------------------------------------------------------------------------- */

let jobSyncTimer = null;

/**
 * @param {object} evt jobs:event payload (spec §5.1)
 */
function onJobEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  const prev = store.get('job');
  const next = reduceJobEvent(prev, evt);
  if (next !== prev) store.set('job', next);
  if (next?.needsSync && !jobSyncTimer) {
    jobSyncTimer = setTimeout(() => {
      jobSyncTimer = null;
      resyncJobs();
    }, 250);
  }
  if (evt.type === 'finished') onJobFinished(next, evt);
}

/**
 * Side effects when a job ends: remember its result, refresh history and dependent data.
 * @param {object|null} job
 * @param {object} evt
 */
function onJobFinished(job, evt) {
  const kind = evt.kind ?? job?.kind ?? 'unknown';
  store.update('lastResults', (r) => ({
    ...(r || {}),
    [kind]: {
      jobId: String(evt.jobId),
      kind,
      title: job?.title ?? null,
      status: evt.status,
      result: evt.result ?? null,
      error: evt.error ?? null,
      warnings: normalizeWarnings(evt.warnings),
      at: Number.isFinite(evt.endedAt) ? evt.endedAt : Date.now(),
      durationMs: Number.isFinite(evt.durationMs) ? evt.durationMs : null,
    },
  }));
  refreshHistory();
  if (kind === 'setup') {
    // The main process keys its introspection cache on python + engine files, so a plain refresh
    // (deduplicated with the one refreshEnv may start) picks up a repaired environment.
    refreshEnv({ refresh: true }).then((env) => {
      if (env?.ready) refreshIntrospection();
    });
    refreshCards();
  } else if (['fetch', 'samples', 'pdf', 'upscale', 'offset'].includes(kind)) {
    refreshCards();
  } else if (kind === 'probe') {
    refreshEnv();
  }
}

function subscribeEvents() {
  api.jobs.onEvent(onJobEvent);
  api.settings.onChanged((payload) => {
    if (payload && typeof payload === 'object' && 'ui' in payload && 'pdf' in payload) {
      store.set('settings', payload);
      applyTheme(payload.theme);
    } else {
      refreshSettings().catch(() => {});
    }
  });
  api.cards.onChanged(() => {
    refreshCards();
  });
  api.app.onNotice((payload) => {
    if (!payload) return;
    const n = typeof payload === 'string' ? { message: payload } : payload;
    const level = String(n.variant || n.level || n.type || 'info');
    const variant = { error: 'danger', warn: 'warning' }[level] || (['info', 'success', 'warning', 'danger'].includes(level) ? level : 'info');
    ui.toast({ variant, title: n.title || 'Kirigami', message: n.message, timeout: n.timeout ?? 8000 });
  });
}

/* ------------------------------------------------------------------------------------------------
 * Default route
 * ---------------------------------------------------------------------------------------------- */

/**
 * `#/setup` until setup is complete and the components are ready; then Your cards when there are
 * fronts, otherwise Get cards (spec §8.1).
 * @returns {string}
 */
function defaultRoute() {
  const settings = store.get('settings');
  const env = store.get('env');
  if (!settings?.setupComplete || !env?.ready) return 'setup';
  const fronts = Number(store.get('cards')?.summary?.front) || 0;
  return fronts > 0 ? 'cards' : 'fetch';
}

/* ------------------------------------------------------------------------------------------------
 * Sidebar
 * ---------------------------------------------------------------------------------------------- */

/** @type {Map<string, { a: HTMLElement, badgeSlot: HTMLElement, hint: HTMLElement, busy: HTMLElement, last: string }>} */
const navRefs = new Map();

function renderNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;
  navRefs.clear();
  const defs = new Map(VIEW_DEFS.map((d) => [d.id, d]));
  nav.replaceChildren(...NAV_GROUPS.map((group, gi) => {
    const labelId = `nav-group-${gi}`;
    return h('div.nav-group',
      h('div.nav-group-label', { id: labelId }, group.label),
      h('ul.nav-list', { attrs: { 'aria-labelledby': labelId } }, group.items.map((id) => {
        const def = defs.get(id);
        const marker = def.step
          ? h('span.nav-step', { 'aria-hidden': 'true' }, String(def.step))
          : h('span.nav-glyph', { 'aria-hidden': 'true' }, icon(def.icon, { size: 16 }));
        const hint = h('span.nav-hint', { hidden: true });
        const badgeSlot = h('span.nav-badge-slot');
        const busy = h('span.nav-busy', { hidden: true, title: 'Working…' }, ui.spinner(14, { label: 'Working' }));
        const a = h('a.nav-item', { href: `#/${id}`, dataset: { route: id } },
          h('span.nav-indicator', { 'aria-hidden': 'true' }),
          marker,
          h('span.nav-text', h('span.nav-label', def.step ? h('span.sr-only', `Step ${def.step}: `) : null, def.title), hint),
          badgeSlot,
          busy);
        navRefs.set(id, { a, badgeSlot, hint, busy, last: '' });
        return h('li', a);
      })));
  }));
}

/** Update active state, badges, hints and busy indicators in place (no re-render). */
function updateNav() {
  const route = store.get('route')?.id;
  const settings = store.get('settings');
  const env = store.get('env');
  const summary = store.get('cards')?.summary;
  const job = store.get('job');
  const busyRoute = job && job.status === 'running' ? JOB_ROUTE[job.kind] : null;

  const computed = {
    cards: summary && Number(summary.front) > 0
      ? { badge: format.formatNumber(summary.front), variant: (summary.warnings || []).length ? 'warning' : 'neutral', title: (summary.warnings || []).length ? 'Some cards need attention' : `${summary.front} card images` }
      : null,
    upscale: (() => {
      const up = env?.upscayl;
      if (!up) return null;
      if (!up.found) return { hint: 'Not installed (optional)' };
      return settings?.upscayl?.enabled === false
        ? { badge: 'Off', variant: 'neutral', title: 'Upscaling is off' }
        : { badge: 'On', variant: 'success', title: 'Make PDF upscales automatically' };
    })(),
    offset: { hint: 'Two-sided only' },
    settings: env && settings?.setupComplete && !env.ready
      ? { badge: '!', variant: 'warning', title: 'Card maker components need attention' }
      : null,
  };

  for (const [id, ref] of navRefs) {
    const active = id === route;
    ref.a.classList.toggle('is-active', active);
    if (active) ref.a.setAttribute('aria-current', 'page');
    else ref.a.removeAttribute('aria-current');
    const info = computed[id] || null;
    const isBusy = busyRoute === id;
    const key = JSON.stringify([info, isBusy]);
    if (key === ref.last) continue;
    ref.last = key;
    ref.busy.hidden = !isBusy;
    ref.hint.hidden = !info?.hint;
    ref.hint.textContent = info?.hint || '';
    ui.mountInto(ref.badgeSlot, info?.badge && !isBusy ? ui.badge(info.badge, info.variant || 'neutral', { title: info.title }) : null);
    ref.a.title = info?.title || '';
  }
}

function updateThemeButton() {
  if (!themeButton) return;
  const labels = { system: 'System', light: 'Light', dark: 'Dark' };
  const icons = { system: 'monitor', light: 'sun', dark: 'moon' };
  const next = { system: 'light', light: 'dark', dark: 'system' }[themePref];
  ui.mountInto(themeButton, icon(icons[themePref], { size: 16 }));
  const text = `Theme: ${labels[themePref]} (switch to ${labels[next]})`;
  themeButton.title = text;
  themeButton.setAttribute('aria-label', text);
}

async function cycleTheme() {
  const next = { system: 'light', light: 'dark', dark: 'system' }[themePref];
  applyTheme(next);
  try {
    await api.settings.update({ theme: next });
  } catch (err) {
    ui.showError(err, { title: 'Could not save the theme' });
  }
}

let helpLinksPromise = null;

/**
 * Pull help URLs out of js/data/help.js whatever its export shape (objects, nested objects or
 * arrays of `{ id, url }`), falling back to the verified defaults.
 * @param {Record<string, any>} mod
 * @returns {Record<string, string>}
 */
function normalizeHelpModule(mod) {
  const flat = {};
  const isUrl = (v) => typeof v === 'string' && /^https?:\/\//i.test(v);
  const visit = (obj, depth) => {
    if (!obj || typeof obj !== 'object' || depth > 3) return;
    if (Array.isArray(obj)) {
      for (const item of obj) {
        if (item && typeof item === 'object' && isUrl(item.url || item.href)) {
          const k = item.id || item.key || item.name || item.label;
          if (k && !(k in flat)) flat[String(k)] = item.url || item.href;
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (isUrl(v)) {
        if (!(k in flat)) flat[k] = v;
      } else if (v && typeof v === 'object') {
        if (!Array.isArray(v) && isUrl(v.url || v.href)) {
          if (!(k in flat)) flat[k] = v.url || v.href;
        } else {
          visit(v, depth + 1);
        }
      }
    }
  };
  visit(mod, 0);
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z]/g, '');
  const byKey = new Map(Object.entries(flat).map(([k, v]) => [norm(k), v]));
  const aliases = {
    tutorial: ['tutorial', 'tutorialUrl', 'guide', 'gettingStarted'],
    troubleshooting: ['troubleshooting', 'troubleshootingUrl', 'troubleshoot'],
    supplies: ['supplies', 'supplyList', 'supplyListUrl', 'suppliesUrl', 'supply'],
    discord: ['discord', 'discordUrl', 'community'],
    website: ['website', 'websiteUrl', 'projectWebsite', 'projectSite', 'siteUrl', 'site', 'home', 'homepage', 'docs', 'documentation', 'project'],
    updates: ['updates', 'releases', 'releasesUrl', 'checkForUpdates', 'update', 'latestRelease'],
  };
  const out = {};
  for (const [key, list] of Object.entries(aliases)) {
    for (const a of list) {
      const v = byKey.get(norm(a));
      if (v) {
        out[key] = v;
        break;
      }
    }
  }
  return out;
}

/** Default Help menu (used when js/data/help.js is missing or has no helpMenuLinks()). */
const HELP_MENU_DEFAULT = [
  { id: 'tutorial', label: 'Tutorial', icon: 'book-open' },
  { id: 'troubleshooting', label: 'Troubleshooting', icon: 'life-buoy' },
  { id: 'supplies', label: 'Supply list', icon: 'shopping-cart' },
  { id: 'discord', label: 'Discord', icon: 'message-circle' },
  { id: 'website', label: 'Project website', icon: 'globe' },
  { id: 'updates', label: 'Check for updates', icon: 'arrow-up-circle' },
];

/**
 * Help menu entries: `helpMenuLinks()` from js/data/help.js when available, otherwise the defaults
 * with URLs pulled from whatever help.js exports (or the verified fallbacks).
 * @returns {Promise<Array<{ id: string, label: string, icon: string, url: string, description?: string }>>}
 */
function loadHelpLinks() {
  if (!helpLinksPromise) {
    helpLinksPromise = import('./data/help.js')
      .catch(() => ({}))
      .then((mod) => {
        const links = { ...HELP_FALLBACK, ...normalizeHelpModule(mod) };
        let entries = null;
        if (typeof mod.helpMenuLinks === 'function') {
          try {
            const list = mod.helpMenuLinks();
            if (Array.isArray(list)) {
              entries = list.filter((e) => e && typeof e.url === 'string' && /^https?:\/\//i.test(e.url));
            }
          } catch {
            entries = null;
          }
        }
        if (!entries || !entries.length) {
          entries = HELP_MENU_DEFAULT.map((d) => ({ ...d, url: links[d.id] })).filter((e) => e.url);
        }
        return entries.map((e) => {
          const def = HELP_MENU_DEFAULT.find((d) => d.id === e.id);
          return {
            id: String(e.id || ''),
            label: String(e.label || def?.label || e.url),
            icon: iconMarkup(e.icon) ? e.icon : (def?.icon || 'external-link'),
            url: e.url,
            description: typeof e.description === 'string' ? e.description : undefined,
          };
        });
      });
  }
  return helpLinksPromise;
}

async function openExternal(url) {
  try {
    await api.shell.openExternal(url);
  } catch (err) {
    ui.showError(err, { title: 'Could not open the link' });
  }
}

function renderSidebarFooter() {
  const footer = document.getElementById('sidebar-footer');
  if (!footer) return;
  const helpBtn = h('button.sidebar-btn', { type: 'button', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } },
    icon('help', { size: 18 }), h('span.sidebar-btn-label', 'Help'), icon('chevron-up', { size: 14, class: 'sidebar-btn-chevron' }));
  let menu = null;
  helpBtn.addEventListener('click', async () => {
    if (menu) {
      menu.close();
      menu = null;
      return;
    }
    const entries = await loadHelpLinks();
    const version = store.get('appInfo')?.version;
    const items = [];
    for (const e of entries) {
      if ((e.id === 'discord' || e.id === 'updates') && items.length) items.push({ divider: true });
      items.push({
        label: e.label,
        icon: e.icon,
        title: e.description,
        hint: e.id === 'updates' && version ? `You have version ${version}` : undefined,
        external: true,
        onSelect: () => openExternal(e.url),
      });
    }
    menu = ui.popoverMenu({
      anchor: helpBtn,
      placement: 'top-start',
      label: 'Help',
      class: 'help-menu',
      onClose: () => { menu = null; },
      items,
    });
  });
  themeButton = h('button.sidebar-icon-btn', { type: 'button' });
  themeButton.addEventListener('click', cycleTheme);
  updateThemeButton();
  const info = store.get('appInfo');
  footer.replaceChildren(
    h('div.sidebar-footer-row', helpBtn, themeButton),
    info?.version ? h('div.sidebar-version', `Version ${info.version}${info.isDev ? ' · development' : ''}`) : null,
  );
}

/* ------------------------------------------------------------------------------------------------
 * Global banner (components not ready / options unreadable)
 * ---------------------------------------------------------------------------------------------- */

let bannerKey = '';
function updateBanner() {
  const root = document.getElementById('banner-root');
  if (!root) return;
  const env = store.get('env');
  const settings = store.get('settings');
  const route = store.get('route')?.id;
  const intro = store.get('introspectionStatus');
  const quietRoutes = ['setup', 'settings', 'kitchen'];
  let key = '';
  let content = null;
  if (env && settings && !env.ready && !quietRoutes.includes(route)) {
    key = `env|${settings.setupComplete ? 1 : 0}`;
    content = h('div.app-banner.is-warning', { role: 'status' },
      icon('alert-triangle', { size: 16 }),
      h('span.app-banner-text', settings.setupComplete
        ? 'The card maker components need attention before you can make cards.'
        : 'Finish the one-time setup to start making cards.'),
      ui.button({ label: settings.setupComplete ? 'Fix it' : 'Continue setup', size: 'sm', variant: 'primary', onClick: () => router.navigate('setup') }));
  } else if (env?.ready && intro?.state === 'error' && !quietRoutes.includes(route)) {
    key = `intro|${intro.error}`;
    content = h('div.app-banner.is-danger', { role: 'status' },
      icon('alert-circle', { size: 16 }),
      h('span.app-banner-text', `Could not read the card maker's options: ${intro.error || 'unknown error'}`),
      ui.button({ label: 'Try again', icon: 'refresh', size: 'sm', onClick: () => refreshIntrospection({ force: true }) }));
  }
  if (key === bannerKey) return;
  bannerKey = key;
  ui.mountInto(root, content);
}

/* ------------------------------------------------------------------------------------------------
 * Boot
 * ---------------------------------------------------------------------------------------------- */

function setSplash(text) {
  const el = document.querySelector('.boot-splash-text');
  if (el) el.textContent = text;
}

/**
 * @param {unknown} err
 */
function renderBootError(err) {
  const viewRoot = document.getElementById('view-root');
  if (!viewRoot) return;
  document.getElementById('app')?.removeAttribute('aria-busy');
  ui.mountInto(viewRoot, h('div.view', h('div.route-error', { role: 'alert' },
    h('div.route-error-icon', icon('alert-triangle', { size: 28 })),
    h('h1.route-error-title', 'Kirigami could not start'),
    h('p.route-error-message', format.errorMessage(err)),
    h('div.route-error-actions', ui.button({ label: 'Try again', icon: 'refresh', variant: 'primary', onClick: () => location.reload() })))));
}

let lastRejectionToast = 0;
window.addEventListener('unhandledrejection', (ev) => {
  const now = Date.now();
  if (now - lastRejectionToast < 3000) return;
  lastRejectionToast = now;
  try {
    ui.toast({ variant: 'danger', title: 'Something went wrong', message: format.errorMessage(ev.reason), timeout: 8000 });
  } catch {
    /* ignore */
  }
});

async function boot() {
  const appEl = document.getElementById('app');
  if (!hasBridge()) {
    renderBridgeMissing(appEl || document.body);
    return;
  }

  renderNav();
  renderSidebarFooter();
  const activityEl = document.getElementById('activity');
  if (activityEl) {
    mountActivityBar(activityEl, { store, api, format, navigate: router.navigate });
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => {
        document.documentElement.style.setProperty('--activity-h', `${Math.round(activityEl.getBoundingClientRect().height)}px`);
      }).observe(activityEl);
    }
  }
  for (const key of ['route', 'cards', 'settings', 'env', 'job']) store.subscribe(key, updateNav);
  for (const key of ['route', 'env', 'settings', 'introspectionStatus']) store.subscribe(key, updateBanner);

  subscribeEvents();

  let appInfo;
  try {
    const [info, settings] = await Promise.all([api.app.info(), api.settings.get()]);
    appInfo = info || {};
    store.set('appInfo', appInfo);
    store.set('settings', settings);
    applyTheme(settings?.theme);
  } catch (err) {
    renderBootError(err);
    return;
  }
  document.documentElement.dataset.platform = String(appInfo.platform || '');
  renderSidebarFooter();

  for (const def of VIEW_DEFS) router.registerView(def);
  if (appInfo.isDev) {
    router.registerView(KITCHEN_DEF);
    window.__scm = { store, router, api };
  }

  const slowTimer = setTimeout(() => setSplash('Checking the card maker components…'), 1500);
  await Promise.allSettled([withTimeout(refreshEnv(), 20000), withTimeout(resyncJobs(), 8000)]);
  clearTimeout(slowTimer);
  const env = store.get('env');
  if (env?.ready) refreshIntrospection();
  if (store.get('settings')?.setupComplete && env?.ready) await withTimeout(refreshCards(), 6000);
  else refreshCards();

  appEl?.removeAttribute('aria-busy');
  router.start({
    container: document.getElementById('view-root'),
    scrollContainer: document.getElementById('main'),
    getContext: () => ({ api, store, ui, format, refresh }),
    defaultRoute,
    onRouteChange: (r) => store.set('route', { id: r.id, params: r.params }),
  });
  updateNav();
  updateBanner();
}

boot().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[main] boot failed', err);
  renderBootError(err);
});
