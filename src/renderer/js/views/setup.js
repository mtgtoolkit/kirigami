/**
 * Setup view (`#/setup`, spec §8.4 "Setup", §13.3).
 *
 * Three steps plus a finish screen:
 *  1. Welcome: what the app does, what you need, the project's Purpose notice with a required
 *     "I understand" checkbox (settings.welcomeAccepted).
 *  2. Checklist: card maker data folder, card maker components (install / repair with a live log
 *     of the setup job, repair in the app's own location, another Python, install into that Python),
 *     Upscayl (optional: found / locate / download) and Silhouette Studio (informational).
 *  3. Your equipment: paper (preselected from the OS country) and cutting machine; writes
 *     settings.equipment + pdf.options.paper_size + pdf.options.registration (§4 mapping, with the
 *     3-corner alternative for the Cameo 5 Alpha).
 *  Finish: settings.setupComplete = true, then "Get cards" or "Try with sample cards" (+ first-cut tip).
 *
 * Route params: `#/setup?step=welcome|checklist|equipment` opens a step directly (when allowed).
 *
 * The named exports are helpers shared with the Settings and Get cards views (components status,
 * Python switching, Upscayl location, the equipment editor, the live setup-job monitor and small
 * DOM utilities). They never touch the DOM at import time.
 *
 * @module views/setup
 */

import * as ui from '../core/ui.js';
import { nextStep } from '../components/next-step.js';
import {
  MACHINES, PAPER_SIZES, getMachine, getPaperSize, registrationForMachine, studioMachineFor,
  defaultPaperForCountry, REGISTRATION_HELP,
} from '../data/option-docs.js';
import { EXTERNAL_LINKS, getHelpLink } from '../data/help.js';

const { h, icon } = ui;

/** Setup step ids, in order. */
const STEPS = ['welcome', 'checklist', 'equipment'];

/** Tip shown when setup is finished (spec §8.4). */
const FIRST_CUT_TIP = 'Make your first sheet on plain card stock to find your cutting settings and check registration before printing a real deck.';

/** Purpose notice (paraphrase of the README "Purpose" section). */
const PURPOSE_TEXT = 'Silhouette Card Maker helps you make your own card games and proxies with a Silhouette cutting machine. '
  + 'Proxies are only for casual play and playtesting, and they must be easy to tell apart from real cards. '
  + 'Never use them as counterfeits to deceive people or to play in sanctioned tournaments, '
  + 'and only sell cards if you hold the full copyright.';

/* ------------------------------------------------------------------------------------------------
 * Small shared utilities (also used by the Settings and Get cards views)
 * ---------------------------------------------------------------------------------------------- */

/**
 * True while a job is running (store key `job`).
 * @param {object|null|undefined} job
 * @returns {boolean}
 */
export function isJobRunning(job) {
  return !!job && job.status === 'running';
}

/**
 * Plain sentence explaining why an action is unavailable while a job runs, or null when idle.
 * @param {object|null|undefined} job
 * @returns {string|null}
 */
export function busyMessage(job) {
  if (!isJobRunning(job)) return null;
  return `Please wait until “${job.title || 'the current task'}” finishes.`;
}

/**
 * Element used as a layout slot that does not create its own box (its children take part in the
 * parent's flex/grid layout, so an empty slot adds no gap).
 * @param {string} [name] data-slot name (debugging / tests)
 * @returns {HTMLDivElement}
 */
export function slot(name) {
  return h('div', { style: { display: 'contents' }, dataset: { slot: name || null } });
}

/**
 * Focus the best focusable element inside `el` (selected tab, checked radio, then the first control).
 * @param {Element|null} el
 */
function focusWithin(el) {
  if (!el) return;
  const selector = 'input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const target = el.matches?.(selector)
    ? el
    : (el.querySelector('[aria-selected="true"]:not([disabled])')
      || el.querySelector('input[type="radio"]:checked:not([disabled])')
      || el.querySelector(selector));
  try {
    target?.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

/**
 * Replace the children of `container`, keeping keyboard focus on the "same" control when it lived
 * inside: the nearest ancestor with `data-fk="<key>"` of the focused element is looked up again in
 * the new content.
 * @param {HTMLElement} container
 * @param {...unknown} children
 */
export function swap(container, ...children) {
  if (!container) return;
  const active = document.activeElement;
  let key = null;
  if (active && active !== document.body && container.contains(active)) {
    const holder = active.closest('[data-fk]');
    if (holder && container.contains(holder)) key = holder.getAttribute('data-fk');
  }
  ui.mountInto(container, ...children);
  if (key) {
    const target = [...container.querySelectorAll('[data-fk]')].find((el) => el.getAttribute('data-fk') === key);
    focusWithin(target || null);
  }
}

/**
 * Tag an element with a focus key (see {@link swap}) and return it.
 * @template {Element} T
 * @param {T} el
 * @param {string} key
 * @returns {T}
 */
export function fk(el, key) {
  if (el && typeof el.setAttribute === 'function') el.setAttribute('data-fk', key);
  return el;
}

/**
 * Run `fn` at most once per animation frame (falls back to a short timeout when hidden).
 * @param {() => void} fn
 * @returns {() => void}
 */
export function frameThrottle(fn) {
  let pending = false;
  return () => {
    if (pending) return;
    pending = true;
    const run = () => {
      pending = false;
      fn();
    };
    if (document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 50);
  };
}

/**
 * Open a web page in the user's browser, showing a toast on failure.
 * @param {object} ctx view context
 * @param {string} url
 */
export async function openLink(ctx, url) {
  if (!url) return;
  try {
    await ctx.api.shell.openExternal(url);
  } catch (err) {
    ui.showError(err, { title: 'Could not open the link' });
  }
}

/**
 * Open a folder or file with the system (Explorer), showing a friendly toast on failure.
 * @param {object} ctx view context
 * @param {string|null|undefined} target absolute path
 * @param {{ missingMessage?: string }} [options] message used when the folder does not exist yet
 */
export async function openFolder(ctx, target, { missingMessage } = {}) {
  if (!target) {
    ui.toast({ variant: 'warning', title: 'This folder is not available yet' });
    return;
  }
  try {
    await ctx.api.shell.openPath(target);
  } catch (err) {
    const msg = ctx.api.errorMessage(err);
    if (missingMessage && /^Could not find/i.test(msg)) ui.toast({ variant: 'info', title: 'Nothing here yet', message: missingMessage });
    else ui.showError(err, { title: 'Could not open the folder' });
  }
}

/**
 * Reload `scm.app.info()` into the store (paths change after folder / Python changes).
 * @param {object} ctx view context
 * @returns {Promise<object|null>}
 */
export async function refreshAppInfo(ctx) {
  try {
    const info = await ctx.api.app.info();
    if (info && typeof info === 'object') ctx.store.set('appInfo', info);
    return info || null;
  } catch {
    return ctx.store.get('appInfo') || null;
  }
}

/**
 * Apply a settings patch and push the result into the store right away (the `settings:changed`
 * event follows shortly and carries the same object).
 * @param {object} ctx view context
 * @param {object} patch
 * @returns {Promise<object|null>} new settings
 */
export async function saveSettings(ctx, patch) {
  const next = await ctx.api.settings.update(patch);
  if (next && typeof next === 'object' && 'ui' in next && 'pdf' in next) ctx.store.set('settings', next);
  return next || null;
}

/**
 * Settings-row markup (same look as the UI kit's status rows, with a neutral icon).
 * @param {{ icon: string, title: unknown, message?: unknown, detail?: unknown, actions?: unknown, tone?: 'muted'|'running'|'success'|'warning'|'danger'|'info' }} options
 * @returns {HTMLElement}
 */
export function infoRow({ icon: iconName, title, message, detail, actions, tone = 'muted' }) {
  const acts = (Array.isArray(actions) ? actions : [actions]).flat().filter(Boolean);
  return h('div.status-row',
    h('span', { class: ['status-icon', `status-${tone}`] }, icon(iconName, { size: 18 })),
    h('div.status-body',
      h('div.status-title', title),
      message ? h('div.status-message', message) : null,
      detail ? h('div.status-detail', detail) : null),
    acts.length ? h('div.status-actions', acts) : null);
}

/* ------------------------------------------------------------------------------------------------
 * Card maker components (Python environment)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Describe the "Card maker components" state for a status row.
 *
 * @param {object|null} env scm.env.status() result
 * @param {object|null} job store `job`
 * @returns {{ status: 'ok'|'warning'|'error'|'pending'|'running', message: string, detail: string|null,
 *   code: string|null, ready: boolean, installed: boolean, custom: boolean, primary: 'install'|'repair'|'appVenv'|'installCustom'|'choosePython'|null }}
 */
export function componentsSummary(env, job) {
  const py = (env && env.python) || {};
  const custom = py.source === 'custom';
  const base = { detail: null, code: py.code || null, ready: !!(env && env.ready), installed: false, custom, primary: null };
  if (isJobRunning(job) && job.kind === 'setup') {
    return { ...base, status: 'running', message: 'Setting up. This one-time download takes a few minutes.' };
  }
  if (!env) return { ...base, status: 'pending', message: 'Checking…' };
  if (env.busy || py.code === 'PYTHON_BUSY') return { ...base, status: 'running', message: 'The card maker components are being set up…' };
  const pathDetail = py.path ? `${custom ? 'Your Python' : 'Python'}: ${py.path}` : null;
  if (env.ready || (py.ok && py.packagesOk && !py.code)) {
    return {
      ...base,
      status: 'ok',
      installed: true,
      message: `Installed and working${py.version ? ` (Python ${py.version})` : ''}.`,
      detail: pathDetail,
    };
  }
  switch (py.code) {
    case 'NOT_INSTALLED':
      return custom
        ? { ...base, status: 'error', message: "The Python you chose can't be found anymore.", detail: pathDetail, primary: 'choosePython' }
        : { ...base, status: 'pending', message: 'Not installed yet. One-time download, a few minutes.', primary: 'install' };
    case 'NEEDS_UPDATE':
      return { ...base, status: 'warning', installed: true, message: 'An update of the components is needed (one-time download, a few minutes).', detail: pathDetail, primary: 'repair' };
    case 'MISSING_PACKAGES':
      return custom
        ? { ...base, status: 'warning', message: 'Your Python is missing some card maker components.', detail: pathDetail, primary: 'installCustom' }
        : { ...base, status: 'warning', message: 'Some card maker components are missing.', detail: pathDetail, primary: 'repair' };
    case 'VENV_BROKEN':
      return { ...base, status: 'error', message: 'The card maker components are damaged.', detail: pathDetail, primary: py.appOwned ? 'repair' : 'appVenv' };
    case 'PYTHON_TOO_OLD':
      return { ...base, status: 'error', message: py.error || 'This Python is too old. Python 3.12 or newer is needed.', detail: pathDetail, primary: custom ? 'choosePython' : 'repair' };
    default: {
      const workspaceProblem = env.workspace && env.workspace.ok === false;
      return {
        ...base,
        status: 'error',
        message: py.error || env.error || (workspaceProblem ? 'Waiting for the card maker data folder.' : 'The card maker components are not working.'),
        detail: pathDetail,
        primary: custom ? 'choosePython' : 'repair',
      };
    }
  }
}

/**
 * Start the setup / repair job (`scm.env.setup`). Errors are shown as a toast.
 * @param {object} ctx view context
 * @param {{ installIntoCustom?: boolean }} [options]
 * @returns {Promise<string|null>} job id
 */
export async function startSetup(ctx, options = {}) {
  try {
    const res = await ctx.api.env.setup(options.installIntoCustom ? { installIntoCustom: true } : {});
    return res && res.jobId ? String(res.jobId) : null;
  } catch (err) {
    ui.showError(err, { title: 'Could not start the setup' });
    return null;
  }
}

/**
 * After a Python / folder change: refresh the environment, app paths and engine options.
 * @param {object} ctx view context
 * @param {object|null} [status] fresh status returned by the service (used when complete)
 * @returns {Promise<void>}
 */
export async function afterEnvChange(ctx, status) {
  if (status && typeof status === 'object' && typeof status.ready === 'boolean' && status.python) {
    ctx.store.set('env', status);
  }
  await Promise.allSettled([ctx.refresh.env({ refresh: false }), refreshAppInfo(ctx)]);
  if (ctx.store.get('env')?.ready) ctx.refresh.introspection({ force: false });
}

/**
 * "Use another Python…": pick a python.exe and switch to it (`scm.env.usePython`).
 * @param {object} ctx view context
 * @returns {Promise<object|null>} new env status, or null when cancelled / failed
 */
export async function chooseOtherPython(ctx) {
  const isWin = (ctx.store.get('appInfo')?.platform || 'win32') === 'win32';
  const file = await ctx.api.dialog.openFile({
    purpose: 'python',
    title: isWin ? 'Choose python.exe' : 'Choose the python program',
    filters: isWin ? [{ name: 'Python (python.exe)', extensions: ['exe'] }] : undefined,
  });
  if (!file) return null;
  try {
    const status = await ctx.api.env.usePython(file);
    await afterEnvChange(ctx, status);
    const env = ctx.store.get('env');
    if (env?.ready) ui.toast({ variant: 'success', title: 'Using your Python', message: `Python ${env.python?.version || ''} is ready to make cards.`.replace('  ', ' ') });
    else if (env?.python?.code === 'MISSING_PACKAGES') ui.toast({ variant: 'warning', title: 'This Python needs the card maker components', message: 'Choose “Install components into this Python”, or pick another Python.', timeout: 8000 });
    return env || status;
  } catch (err) {
    ui.showError(err, { title: "This Python can't be used" });
    return null;
  }
}

/**
 * Go back to the default components (clears the custom Python: `scm.env.usePython(null)`).
 * @param {object} ctx view context
 * @returns {Promise<object|null>}
 */
export async function useDefaultPython(ctx) {
  try {
    const status = await ctx.api.env.usePython(null);
    await afterEnvChange(ctx, status);
    ui.toast({ variant: 'info', title: "Using the app's own components" });
    return ctx.store.get('env');
  } catch (err) {
    ui.showError(err, { title: "Couldn't switch back to the app's own components" });
    return null;
  }
}

/**
 * "Repair in the app's own location": switch to the app-owned environment, then install it.
 * @param {object} ctx view context
 * @returns {Promise<string|null>} job id of the setup job
 */
export async function repairInAppLocation(ctx) {
  try {
    const status = await ctx.api.env.useAppVenv();
    await afterEnvChange(ctx, status);
  } catch (err) {
    ui.showError(err, { title: "Couldn't switch to the app's own location" });
    return null;
  }
  return startSetup(ctx);
}

/**
 * Comparable form of a folder path (separators unified, no trailing separator, case-folded).
 * @param {string|null|undefined} p
 * @returns {string}
 */
function comparablePath(p) {
  return String(p || '').trim().replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * True when the components already use the app's own environment folder (`<data folder>/venv`),
 * so "Repair in the app's own location" cannot help any more.
 * @param {object} ctx view context
 * @returns {boolean}
 */
export function usesAppLocationVenv(ctx) {
  const venvDir = ctx.store.get('env')?.python?.venvDir;
  const data = ctx.store.get('appInfo')?.paths?.data;
  if (!venvDir || !data) return false;
  return comparablePath(venvDir) === `${comparablePath(data)}/venv`;
}

/**
 * Extra advice for a failed setup, when the error message alone would send the user in circles.
 * @param {object} ctx view context
 * @param {{ code?: string }|null} error job error
 * @returns {string|null}
 */
export function setupFailureHint(ctx, error) {
  if (error?.code === 'VENV_BROKEN' && usesAppLocationVenv(ctx)) {
    return "This is already the app's own location. Delete its \"venv\" folder (it only holds downloaded components; Show folder opens it) and click Try again, or choose another Python.";
  }
  return null;
}

/**
 * Message of a failed setup for a callout: the job's own message plus {@link setupFailureHint}.
 * @param {object} ctx view context
 * @param {{ message?: string, code?: string }|null} error job error
 * @returns {unknown} text or nodes
 */
export function failureMessage(ctx, error) {
  const text = error?.message || 'Something went wrong.';
  const hint = setupFailureHint(ctx, error);
  return hint ? h('div.stack', { style: { '--gap': '6px' } }, h('div', text), h('div', hint)) : text;
}

/**
 * Buttons that fix a failed setup job, chosen from its error code (python-env codes, §13.2).
 * @param {object} ctx view context
 * @param {{ code?: string }|null} error job error
 * @param {{ custom?: boolean }} [options]
 * @returns {HTMLButtonElement[]}
 */
export function setupFixButtons(ctx, error, { custom = false } = {}) {
  const busy = () => isJobRunning(ctx.store.get('job'));
  const b = (label, iconName, variant, fn) => ui.button({ label, icon: iconName, variant, size: 'sm', disabled: busy(), onClick: fn });
  const tryAgain = () => b('Try again', 'refresh', 'primary', () => startSetup(ctx));
  switch (error?.code) {
    case 'VENV_BROKEN':
      if (usesAppLocationVenv(ctx)) {
        // Repairing "in the app's own location" again would fail the same way.
        return [
          tryAgain(),
          b('Show folder', 'folder-open', 'secondary', () => openFolder(ctx, ctx.store.get('appInfo')?.paths?.data)),
          b('Use another Python…', 'folder-open', 'ghost', () => chooseOtherPython(ctx)),
        ];
      }
      return [
        b("Repair in the app's own location", 'wand', 'primary', () => repairInAppLocation(ctx)),
        b('Use another Python…', 'folder-open', 'secondary', () => chooseOtherPython(ctx)),
      ];
    case 'CUSTOM_PYTHON_MISSING_PACKAGES':
      return [
        b('Install components into this Python', 'download', 'primary', () => startSetup(ctx, { installIntoCustom: true })),
        b('Use another Python…', 'folder-open', 'secondary', () => chooseOtherPython(ctx)),
        b("Use the app's own components", 'undo', 'ghost', () => useDefaultPython(ctx)),
      ];
    case 'BAD_PYTHON':
    case 'PYTHON_TOO_OLD':
      return custom
        ? [b('Use another Python…', 'folder-open', 'primary', () => chooseOtherPython(ctx)), b("Use the app's own components", 'undo', 'secondary', () => useDefaultPython(ctx))]
        : [tryAgain(), b('Use another Python…', 'folder-open', 'secondary', () => chooseOtherPython(ctx))];
    default:
      return [tryAgain()];
  }
}

/**
 * Buttons for the "Card maker components" row (main action + a "More" menu with the advanced
 * choices: another Python, install into it, back to the app's own components, repair in the app's
 * own location).
 *
 * @param {object} ctx view context
 * @param {ReturnType<typeof componentsSummary>} summary
 * @param {{ showRepairWhenOk?: boolean, onPending?: (label: string|null) => void, menu?: boolean, primary?: boolean }} [options]
 *   `menu: false` returns only the main button (the caller shows the other choices itself);
 *   `primary: false` leaves the main button out (e.g. when a failure callout already offers it).
 * @returns {HTMLElement[]}
 */
export function componentsButtons(ctx, summary, {
  showRepairWhenOk = false, onPending, menu: withMenu = true, primary: withPrimary = true,
} = {}) {
  const job = ctx.store.get('job');
  const busy = isJobRunning(job);
  const env = ctx.store.get('env');
  const py = env?.python || {};
  const title = busy ? busyMessage(job) : undefined;
  const pending = async (label, fn) => {
    onPending?.(label);
    try {
      return await fn();
    } finally {
      onPending?.(null);
    }
  };
  const out = [];
  const main = {
    install: () => ui.button({ label: 'Install', icon: 'download', variant: 'primary', size: 'sm', disabled: busy, title, onClick: () => startSetup(ctx) }),
    repair: () => ui.button({ label: 'Repair', icon: 'wand', variant: 'primary', size: 'sm', disabled: busy, title, onClick: () => startSetup(ctx) }),
    appVenv: () => ui.button({ label: "Repair in the app's own location", icon: 'wand', variant: 'primary', size: 'sm', disabled: busy, title, onClick: () => repairInAppLocation(ctx) }),
    installCustom: () => ui.button({ label: 'Install components into this Python', icon: 'download', variant: 'primary', size: 'sm', disabled: busy, title, onClick: () => startSetup(ctx, { installIntoCustom: true }) }),
    choosePython: () => ui.button({ label: 'Use another Python…', icon: 'folder-open', variant: 'primary', size: 'sm', disabled: busy, title, onClick: () => pending('Checking the Python you chose…', () => chooseOtherPython(ctx)) }),
  };
  // Already in the app's own location: repairing "there" again is a plain repair.
  const primary = summary.primary === 'appVenv' && usesAppLocationVenv(ctx) ? 'repair' : summary.primary;
  if (summary.status !== 'running' && withPrimary) {
    if (primary && main[primary]) out.push(main[primary]());
    else if (summary.status === 'ok' && showRepairWhenOk) {
      out.push(ui.button({ label: summary.custom ? 'Check again' : 'Repair components', icon: summary.custom ? 'refresh' : 'wand', size: 'sm', disabled: busy, title, onClick: () => (summary.custom ? pending('Checking…', () => ctx.refresh.env({ refresh: true })) : startSetup(ctx)) }));
    }
  }
  // While the setup job runs every choice would be disabled: leave the menu out.
  if (!withMenu || summary.status === 'running') return out;
  const items = [{ heading: 'Advanced' }];
  if (summary.primary !== 'choosePython') {
    items.push({ label: 'Use another Python…', icon: 'folder-open', disabled: busy, onSelect: () => pending('Checking the Python you chose…', () => chooseOtherPython(ctx)) });
  }
  if (summary.custom && summary.primary !== 'installCustom' && !summary.installed) {
    items.push({ label: 'Install components into this Python', icon: 'download', disabled: busy, onSelect: () => startSetup(ctx, { installIntoCustom: true }) });
  }
  if (summary.custom) {
    items.push({ label: "Use the app's own components", icon: 'undo', disabled: busy, onSelect: () => pending('Switching back…', () => useDefaultPython(ctx)) });
  }
  if (!py.appOwned && primary !== 'appVenv' && summary.status !== 'ok' && !usesAppLocationVenv(ctx)) {
    items.push({ label: "Repair in the app's own location", icon: 'wand', disabled: busy, onSelect: () => repairInAppLocation(ctx) });
  }
  items.push({ label: 'Check again', icon: 'refresh', disabled: busy, onSelect: () => pending('Checking…', () => ctx.refresh.env({ refresh: true })) });
  const more = ui.button({ icon: 'more-horizontal', title: 'More choices', variant: 'ghost', size: 'sm', attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' } });
  let menu = null;
  more.addEventListener('click', () => {
    if (menu) {
      menu.close();
      menu = null;
      return;
    }
    menu = ui.popoverMenu({ anchor: more, items, placement: 'bottom-start', label: 'Card maker components', onClose: () => { menu = null; } });
  });
  out.push(more);
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Live setup-job monitor (progress, steps, log)
 * ---------------------------------------------------------------------------------------------- */

/**
 * CSS modifier for a log line.
 * @param {{ stream?: string, line?: string }} entry
 * @returns {string|null}
 */
function logTone(entry) {
  const stream = String(entry?.stream || 'info').toLowerCase();
  const text = String(entry?.line ?? '');
  if (stream === 'error' || /^\s*(Error:|Traceback \(most recent call last\))/.test(text)) return 'log-error';
  if (stream === 'warn' || stream === 'warning' || /^\s*(Warning|WARNING)\b/.test(text)) return 'log-warn';
  if (stream === 'stderr') return 'log-stderr';
  return null;
}

/**
 * A scrolling, monospace log box fed with the store's job log lines (appends only new lines,
 * follows the end unless the user scrolled up).
 *
 * @param {{ height?: number, label?: string, maxLines?: number, emptyText?: string }} [options]
 * @returns {{ el: HTMLElement, update(job: object|null): void, scrollToEnd(): void }}
 */
export function createLogView({ height = 200, label = 'Log', maxLines = 400, emptyText = 'Nothing to show yet.' } = {}) {
  const logEl = h('div.log', { role: 'log', tabIndex: 0, attrs: { 'aria-label': label, 'aria-live': 'off' } });
  const el = h('div', {
    style: {
      height: `${height}px`, display: 'flex', minHeight: '0', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
      background: 'var(--input-bg)', overflow: 'hidden',
    },
  }, logEl);
  let jobId = null;
  let total = 0;
  // Follow the end of the log unless the user scrolled up to read something.
  let follow = true;
  const toEnd = () => {
    logEl.scrollTop = logEl.scrollHeight;
  };
  logEl.addEventListener('scroll', () => {
    if (logEl.clientHeight) follow = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }, { passive: true });
  if (typeof ResizeObserver === 'function') {
    // Becoming visible (or attached) changes the box size: jump to the end then.
    new ResizeObserver(() => {
      if (follow && logEl.clientHeight) toEnd();
    }).observe(logEl);
  }
  const lineEl = (entry) => h('div', { class: ['log-line', logTone(entry)] }, String(entry?.line ?? '') || ' ');
  const trim = () => {
    while (logEl.childElementCount > maxLines) logEl.firstElementChild.remove();
  };
  function update(job) {
    const lines = Array.isArray(job?.logLines) ? job.logLines : [];
    const t = Number.isFinite(job?.logTotal) ? job.logTotal : lines.length;
    if (job && job.jobId !== jobId) follow = true;
    const atEnd = follow;
    if (!job || !lines.length) {
      if (jobId !== (job?.jobId ?? null) || total !== 0 || !logEl.firstChild) {
        logEl.replaceChildren(h('div.log-empty', emptyText));
      }
      jobId = job?.jobId ?? null;
      total = 0;
      return;
    }
    if (job.jobId !== jobId || t < total || !logEl.querySelector('.log-line')) {
      logEl.replaceChildren(...lines.slice(-maxLines).map(lineEl));
    } else if (t > total) {
      const fresh = lines.slice(-Math.min(t - total, lines.length));
      logEl.append(...fresh.map(lineEl));
      trim();
    }
    jobId = job.jobId;
    total = t;
    if (atEnd) toEnd();
  }
  return {
    el,
    update,
    scrollToEnd: () => {
      follow = true;
      toEnd();
      requestAnimationFrame(toEnd);
    },
  };
}

const STEP_LOOK = {
  done: { iconName: 'check-circle', cls: 'text-success' },
  skipped: { iconName: 'check-circle', cls: 'text-success' },
  failed: { iconName: 'x-circle', cls: 'text-danger' },
  cancelled: { iconName: 'ban', cls: 'faint' },
  pending: { iconName: 'circle', cls: 'faint' },
};

/**
 * Live panel for the setup job: step chips, progress bar and a collapsible log. Created once per
 * view and re-attached wherever it is needed; it updates itself from the store's `job` key.
 *
 * @param {object} ctx view context
 * @param {{ logOpen?: boolean, logHeight?: number }} [options] `logOpen`: show the log while running
 * @returns {{ el: HTMLElement, update(): void }}
 */
export function createSetupMonitor(ctx, { logOpen = true, logHeight = 170 } = {}) {
  const stepsEl = h('div.row', { style: { '--gap': '6px 16px' } });
  const bar = ui.progressBar({ percent: null, label: '' });
  const logView = createLogView({ height: logHeight, label: 'Installation log', emptyText: 'Waiting for the first messages…' });
  const logBox = h('div', { hidden: true }, logView.el);
  let userToggled = false;
  let showLog = false;
  const toggleBtn = ui.button({
    label: 'Show details', icon: 'terminal', variant: 'ghost', size: 'sm',
    onClick: () => {
      userToggled = true;
      showLog = !showLog;
      applyLog();
    },
  });
  const runningBox = h('div.stack', { style: { '--gap': '12px' } }, stepsEl, bar);
  const el = h('div.stack', { hidden: true, style: { '--gap': '10px', marginTop: '6px' } }, runningBox, h('div.row', toggleBtn), logBox);
  let stepsKey = '';
  let lastJobId = null;

  function applyLog() {
    logBox.hidden = !showLog;
    toggleBtn.setLabel(showLog ? 'Hide details' : 'Show details');
    if (showLog) logView.scrollToEnd();
  }

  function update() {
    if (ctx.signal?.aborted) return;
    const job = ctx.store.get('job');
    const relevant = job && job.kind === 'setup';
    el.hidden = !relevant;
    if (!relevant) return;
    if (job.jobId !== lastJobId) {
      lastJobId = job.jobId;
      userToggled = false;
    }
    const running = job.status === 'running';
    runningBox.hidden = !running;
    if (!userToggled) showLog = running ? logOpen : false;
    applyLog();
    if (running) {
      const p = job.progress || {};
      bar.update(Number.isFinite(p.percent) ? p.percent : null, p.label || 'Starting…');
      const key = JSON.stringify((job.steps || []).map((s) => [s.id, s.status, s.label]));
      if (key !== stepsKey) {
        stepsKey = key;
        stepsEl.replaceChildren(...(job.steps || []).map((s) => {
          const look = STEP_LOOK[s.status] || null;
          const mark = s.status === 'running' ? ui.spinner(14) : icon(look ? look.iconName : 'circle', { size: 14 });
          return h('span', { class: ['row', 'small', 'nowrap', s.status === 'running' ? 'strong' : (look ? look.cls : 'faint')], style: { '--gap': '6px' } }, mark, h('span', s.label || s.id));
        }));
      }
    }
    if (!logBox.hidden || job.jobId) logView.update(job);
  }

  const schedule = frameThrottle(update);
  ctx.subscribe('job', schedule);
  update();
  return { el, update };
}

/* ------------------------------------------------------------------------------------------------
 * Upscayl
 * ---------------------------------------------------------------------------------------------- */

/**
 * Put a fresh Upscayl status (returned by `scm.upscayl.*`) into the store's `env` right away, so the
 * page updates before the slower full environment check comes back.
 * @param {object} ctx view context
 * @param {object|null} status UpscaylStatus
 */
export function applyUpscaylStatus(ctx, status) {
  if (!status || typeof status !== 'object' || typeof status.found !== 'boolean') return;
  const env = ctx.store.get('env');
  if (env && typeof env === 'object') ctx.store.set('env', { ...env, upscayl: status });
}

/**
 * "Locate…" Upscayl: pick Upscayl.exe / upscayl-bin.exe (or the Upscayl folder) and validate it.
 * @param {object} ctx view context
 * @returns {Promise<object|null>} new Upscayl status
 */
export async function locateUpscayl(ctx) {
  const isWin = (ctx.store.get('appInfo')?.platform || 'win32') === 'win32';
  const file = await ctx.api.dialog.openFile({
    purpose: 'upscayl',
    title: 'Find Upscayl (Upscayl.exe or upscayl-bin.exe)',
    filters: isWin ? [{ name: 'Upscayl', extensions: ['exe'] }] : undefined,
  });
  if (!file) return null;
  try {
    const status = await ctx.api.upscayl.locate(file);
    applyUpscaylStatus(ctx, status);
    await ctx.refresh.env({ refresh: true });
    const up = ctx.store.get('env')?.upscayl || status;
    if (up && up.found) ui.toast({ variant: 'success', title: 'Upscayl found', message: up.version ? `Version ${up.version}.` : undefined });
    else ui.toast({ variant: 'warning', title: "That isn't a working Upscayl", message: (up && up.error) || 'Choose Upscayl.exe in the folder where Upscayl is installed.', timeout: 8000 });
    return up;
  } catch (err) {
    ui.showError(err, { title: "Couldn't use this Upscayl" });
    return null;
  }
}

/**
 * One-line description of the detected graphics cards.
 * @param {object|null} up Upscayl status
 * @returns {string|null}
 */
export function gpuText(up) {
  const gpus = Array.isArray(up?.gpus) ? up.gpus : null;
  if (!gpus || !gpus.length) return null;
  const names = [...new Set(gpus.map((g) => String(g.name || '').trim()).filter(Boolean))];
  return names.length ? `Graphics card${names.length > 1 ? 's' : ''}: ${names.join(', ')}` : null;
}

/* ------------------------------------------------------------------------------------------------
 * Equipment
 * ---------------------------------------------------------------------------------------------- */

/**
 * Settings patch for an equipment choice (spec §4 mapping): equipment + PDF paper + registration.
 * @param {{ paper: string, machine: string|null, registration?: '3'|'4' }} eq
 * @returns {object}
 */
export function equipmentPatch({ paper, machine, registration }) {
  const reg = machine === 'cameo5alpha' && (registration === '3' || registration === '4') ? registration : registrationForMachine(machine);
  return {
    equipment: { machine: machine || null, paper: paper || null },
    pdf: { options: { paper_size: paper, registration: reg } },
  };
}

/** Paper size of the default PDF options (settings.js DEFAULT_SETTINGS.pdf.options.paper_size). */
const DEFAULT_PDF_PAPER = 'a4';

/**
 * Current equipment from settings. Paper: the equipment choice; else a paper the user picked in
 * Make PDF (anything but the untouched default); else the OS-country default (spec §4).
 * @param {object|null} settings
 * @param {object|null} appInfo
 * @returns {{ paper: string, machine: string|null, registration: '3'|'4' }}
 */
export function equipmentFromSettings(settings, appInfo) {
  const eq = settings?.equipment || {};
  const chosen = eq.paper ? getPaperSize(eq.paper)?.name : null;
  const pdfPaper = getPaperSize(settings?.pdf?.options?.paper_size)?.name || null;
  const paper = chosen || (pdfPaper && pdfPaper !== DEFAULT_PDF_PAPER ? pdfPaper : null) || defaultPaperForCountry(appInfo?.country);
  const machine = getMachine(eq.machine) ? eq.machine : null;
  const current = String(settings?.pdf?.options?.registration ?? '');
  const registration = machine === 'cameo5alpha' ? (current === '3' ? '3' : '4') : registrationForMachine(machine);
  return { paper, machine, registration };
}

/**
 * Paper + cutting machine editor (Setup step 3 and Settings → Equipment).
 *
 * @param {{ value: { paper: string, machine: string|null, registration: '3'|'4' }, onChange: (next: object) => void, disabled?: boolean, compact?: boolean }} options
 * @returns {HTMLElement}
 */
export function equipmentEditor({ value, onChange, disabled = false, compact = false }) {
  const state = { ...value };
  const notes = h('div.stack', { style: { '--gap': '12px' } });
  const regSlot = slot('registration');
  const emit = () => onChange?.({ ...state });

  const paperSelect = fk(ui.select({
    options: PAPER_SIZES.map((p) => ({ value: p.name, label: p.label, description: `${p.region}. Cutting mat: ${p.mat}.` })),
    value: state.paper,
    width: 'min(440px, 100%)',
    disabled,
    onChange: (v) => {
      state.paper = v;
      renderNotes();
      emit();
    },
  }), 'eq-paper');

  const machineCards = fk(ui.radioCards({
    ariaLabel: 'Cutting machine',
    compact,
    disabled,
    value: state.machine,
    options: MACHINES.map((m) => ({ value: m.id, label: m.label, description: m.description, icon: m.id === 'other' ? 'help' : 'scissors' })),
    onChange: (v) => {
      state.machine = v;
      state.registration = registrationForMachine(v);
      renderRegistration();
      renderNotes();
      emit();
    },
  }), 'eq-machine');

  function renderRegistration() {
    if (state.machine !== 'cameo5alpha') {
      swap(regSlot);
      return;
    }
    const choice = fk(ui.radioCards({
      ariaLabel: 'Registration marks',
      compact: true,
      disabled,
      value: state.registration,
      options: [
        { value: '4', label: '4-corner marks', description: 'L shapes in all four corners. Select “Cameo 5 Alpha” in Silhouette Studio.', badge: { text: 'Default', variant: 'neutral' } },
        { value: '3', label: '3-corner marks', description: 'Often more reliable. Then select “Cameo 5” as the machine in Silhouette Studio.' },
      ],
      onChange: (v) => {
        state.registration = v;
        renderNotes();
        emit();
      },
    }), 'eq-registration');
    swap(regSlot, ui.field({
      label: 'Registration marks (the corner marks your machine scans before cutting)',
      help: `${REGISTRATION_HELP.summary} ${REGISTRATION_HELP.four}`,
      control: choice,
    }));
  }

  function renderNotes() {
    const out = [];
    const machine = getMachine(state.machine);
    const paper = getPaperSize(state.paper);
    if (machine && Array.isArray(machine.supportedPapers) && !machine.supportedPapers.includes(state.paper) && machine.paperWarning) {
      out.push(ui.callout({ variant: 'warning', compact: true, title: `${paper ? paper.shortLabel : 'This paper'} is too big for the Portrait`, message: `${machine.paperWarning} Choose Letter or A4, or another machine.` }));
    } else if (paper && paper.mat === '12 x 24 in') {
      out.push(ui.callout({ variant: 'info', compact: true, message: `${paper.shortLabel} needs a 12 x 24 in cutting mat and a printer that takes ${paper.shortLabel} card stock.` }));
    }
    if (machine) {
      const reg = machine.id === 'cameo5alpha' ? state.registration : machine.registration;
      const marks = reg === '4' ? '4-corner marks' : '3-corner marks (a black square and two L shapes)';
      out.push(h('p.small.muted', `Your PDFs will use ${marks}. In Silhouette Studio, select ${studioMachineFor(machine.id, reg)} as the machine.`));
    }
    swap(notes, ...out);
  }

  renderRegistration();
  renderNotes();
  return h('div.stack', { style: { '--gap': '20px' } },
    ui.field({ label: 'Paper', help: 'The paper you print your cards on. Letter and A4 fit the standard 12 x 12 in cutting mat.', control: paperSelect }),
    ui.field({ label: 'Cutting machine', required: true, control: machineCards }),
    regSlot,
    notes);
}

/* ------------------------------------------------------------------------------------------------
 * The view
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {object} settings
 * @param {object} env
 * @param {string} [requested]
 * @returns {string}
 */
function initialStep(settings, env, requested) {
  if (!settings?.welcomeAccepted) return 'welcome';
  if (requested === 'welcome') return 'welcome';
  if (requested === 'equipment' && env?.ready) return 'equipment';
  return 'checklist';
}

export default {
  id: 'setup',
  title: 'Setup',
  icon: 'package',

  /**
   * @param {HTMLElement} container
   * @param {object} ctx
   */
  mount(container, ctx) {
    const { store, api } = ctx;
    const view = {
      step: initialStep(store.get('settings'), store.get('env'), ctx.params?.step),
      equipment: equipmentFromSettings(store.get('settings'), store.get('appInfo')),
      samplesJobId: null,
      pending: null,
    };
    const monitor = createSetupMonitor(ctx, { logOpen: true });
    const headerSlot = slot('header');
    const stepperSlot = slot('stepper');
    const bodySlot = slot('body');
    container.append(headerSlot, stepperSlot, bodySlot);

    let checklistKey = '';
    let checklistSlot = null;
    let footerSlot = null;

    const settings = () => store.get('settings') || {};
    const env = () => store.get('env');

    /* ---------- header + stepper ---------- */

    function renderHeader() {
      const info = {
        welcome: ['Welcome to Silhouette Card Maker', 'Make print-and-cut card proxies with your Silhouette cutting machine. This one-time setup takes a few minutes.', 'sparkles'],
        checklist: ['Get the card maker ready', 'The app checks what is installed and downloads the card maker components it needs.', 'package'],
        equipment: ['Your equipment', 'Tell the app what you print on and what you cut with, so your sheets fit your machine.', 'scissors'],
        done: ["You're all set", 'Silhouette Card Maker is ready to make your cards.', 'check-circle'],
      }[view.step];
      const index = STEPS.indexOf(view.step);
      swap(headerSlot, ui.pageHeader({
        title: info[0],
        subtitle: info[1],
        icon: info[2],
        step: index >= 0 ? `One-time setup · Step ${index + 1} of ${STEPS.length}` : 'One-time setup',
      }));
    }

    function stepDone(id) {
      const s = settings();
      if (id === 'welcome') return !!s.welcomeAccepted;
      if (id === 'checklist') return !!env()?.ready;
      return !!s.setupComplete;
    }

    function renderStepper() {
      const s = settings();
      const ready = !!env()?.ready;
      const labels = { welcome: 'Welcome', checklist: 'Checklist', equipment: 'Your equipment' };
      swap(stepperSlot, fk(ui.tabs({
        ariaLabel: 'Setup steps',
        active: view.step === 'done' ? 'equipment' : view.step,
        tabs: STEPS.map((id, i) => ({
          id,
          label: `${i + 1}. ${labels[id]}`,
          icon: stepDone(id) ? 'check' : undefined,
          disabled: (id === 'checklist' && !s.welcomeAccepted) || (id === 'equipment' && (!s.welcomeAccepted || !ready)),
        })),
        onChange: (id) => goStep(id),
      }), 'stepper'));
    }

    /** After a step change: back to the top, keyboard / screen-reader focus on the new heading. */
    function showTop() {
      const main = document.getElementById('main');
      if (main) main.scrollTop = 0;
      const heading = headerSlot.querySelector('h1');
      const active = document.activeElement;
      // Keep focus on the step tabs when they were used to switch.
      if (!heading || (active && stepperSlot.contains(active))) return;
      if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
      try {
        heading.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }

    function goStep(id) {
      if (view.step === id) return;
      view.step = id;
      checklistKey = '';
      renderAll();
      showTop();
    }

    function renderAll() {
      renderHeader();
      renderStepper();
      if (view.step === 'welcome') swap(bodySlot, renderWelcome());
      else if (view.step === 'checklist') swap(bodySlot, renderChecklistStep());
      else if (view.step === 'equipment') swap(bodySlot, renderEquipmentStep());
      else swap(bodySlot, renderDone());
    }

    /* ---------- step 1: welcome ---------- */

    function renderWelcome() {
      const steps = [
        ['download', '1. Get cards', 'Download the pictures of your deck from the game’s card website.'],
        ['images', '2. Check cards', 'Review the pictures, add your own and choose a card back.'],
        ['file-pdf', '3. Make PDF', 'Lay the cards out on printable sheets with cutting marks.'],
        ['scissors', '4. Print & cut', 'Print the sheets; your Silhouette cuts the cards out.'],
      ];
      const need = [
        ['scissors', 'A Silhouette cutting machine (Cameo or Portrait) and the free Silhouette Studio software'],
        ['printer', 'A printer that prints on card stock'],
        ['layers', 'Card stock (thick printer paper)'],
        ['sparkles', 'Optional: a laminator, and the free Upscayl app for sharper pictures'],
      ];
      const supplies = getHelpLink('supplies');
      const tutorial = getHelpLink('tutorial');
      const accepted = !!settings().welcomeAccepted;
      const check = fk(ui.checkbox({
        checked: accepted,
        label: 'I understand',
        description: 'I will only make proxies for casual play and playtesting, clearly marked as proxies.',
        onChange: async (on) => {
          try {
            await saveSettings(ctx, { welcomeAccepted: on });
          } catch (err) {
            check.setChecked(!on);
            ui.showError(err, { title: 'Could not save your choice' });
          }
          renderStepper();
          updateFooter();
        },
      }), 'welcome-check');
      footerSlot = slot('footer');
      const view1 = [
        ui.section({
          title: 'How it works',
          icon: 'sparkles',
          children: ui.grid({ min: 150, gap: 12 }, steps.map(([ic, title, text]) => ui.card({ icon: ic, title, children: h('p.small.muted', text) }))),
        }),
        ui.section({
          title: 'What you need',
          icon: 'package',
          actions: [
            supplies && ui.button({ label: 'Supply list', icon: 'shopping-cart', variant: 'ghost', size: 'sm', onClick: () => openLink(ctx, supplies.url) }),
            tutorial && ui.button({ label: 'Tutorial', icon: 'book-open', variant: 'ghost', size: 'sm', onClick: () => openLink(ctx, tutorial.url) }),
          ].filter(Boolean),
          children: ui.card({
            children: h('div.stack', { style: { '--gap': '10px' } }, need.map(([ic, text]) => h('div.row.row-nowrap', { style: { '--gap': '12px', alignItems: 'flex-start' } },
              h('span.text-accent', { style: { paddingTop: '2px' } }, icon(ic, { size: 16 })), h('span', text)))),
          }),
        }),
        ui.section({
          title: 'Please read',
          icon: 'shield-check',
          children: ui.card({
            children: [
              h('p.prose', PURPOSE_TEXT),
              check,
            ],
          }),
        }),
        footerSlot,
      ];
      queueMicrotask(updateFooter);
      return view1;
    }

    /* ---------- step 2: checklist ---------- */

    function lastSetup() {
      const r = store.get('lastResults')?.setup;
      return r && typeof r === 'object' ? r : null;
    }

    function computeChecklistKey() {
      const e = env();
      const job = store.get('job');
      const last = lastSetup();
      return JSON.stringify([
        e ? [e.ready, e.busy, e.workspace, e.python, e.upscayl ? [e.upscayl.found, e.upscayl.version, e.upscayl.binPath, e.upscayl.gpus, e.upscayl.error] : null,
          e.silhouetteStudio ? [e.silhouetteStudio.found, e.silhouetteStudio.version, e.silhouetteStudio.path] : null] : null,
        job ? [job.jobId, job.kind, job.status] : null,
        last ? [last.jobId, last.status, last.error?.code, last.error?.message] : null,
        view.pending,
        settings().pythonPath || null,
      ]);
    }

    function renderChecklistStep() {
      checklistSlot = slot('checklist');
      footerSlot = slot('footer');
      checklistKey = '';
      queueMicrotask(updateChecklist);
      return [checklistSlot, footerSlot];
    }

    function updateChecklist(force = false) {
      if (view.step !== 'checklist' || !checklistSlot) return;
      const key = computeChecklistKey();
      if (!force && key === checklistKey) return;
      checklistKey = key;
      swap(checklistSlot, renderChecklistCard());
      updateFooter();
    }

    function renderChecklistCard() {
      const e = env();
      const job = store.get('job');
      const busy = isJobRunning(job);
      const ws = e?.workspace || null;
      const up = e?.upscayl || null;
      const studio = e?.silhouetteStudio || null;
      const summary = componentsSummary(e, job);
      const last = lastSetup();
      const rows = [];

      // 1. Card maker data folder
      if (!e) {
        rows.push(ui.statusRow({ status: 'pending', title: 'Card maker data folder', message: 'Checking…' }));
      } else if (ws?.ok) {
        rows.push(ui.statusRow({
          status: 'ok',
          title: 'Card maker data folder',
          message: ws.external ? 'Using the card maker folder on this computer.' : 'Ready.',
          detail: ws.path || null,
          actions: ws.path ? [ui.button({ label: 'Open', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => openFolder(ctx, ws.path) })] : null,
        }));
      } else if (ws?.needsUpdate) {
        rows.push(ui.statusRow({ status: 'pending', title: 'Card maker data folder', message: 'It will be prepared when the components are installed.', detail: ws.path || null }));
      } else {
        rows.push(ui.statusRow({ status: 'error', title: 'Card maker data folder', message: ws?.error || e?.error || 'The card maker files could not be found.', detail: ws?.path || null }));
      }

      // 2. Card maker components
      const pendingSummary = view.pending ? { ...summary, status: 'running', message: view.pending } : summary;
      const failure = last && last.status === 'failed' && !e?.ready && !busy && last.error ? last.error : null;
      const detailParts = [];
      if (pendingSummary.detail) detailParts.push(h('div', pendingSummary.detail));
      if (failure) {
        detailParts.push(ui.callout({
          variant: 'danger',
          compact: true,
          title: 'The setup did not finish',
          message: failureMessage(ctx, failure),
          actions: setupFixButtons(ctx, failure, { custom: summary.custom }),
          class: 'mt-8',
        }));
      }
      if (job && job.kind === 'setup') detailParts.push(monitor.el);
      rows.push(ui.statusRow({
        status: pendingSummary.status,
        title: 'Card maker components',
        message: pendingSummary.message,
        detail: detailParts.length ? h('div.stack', { style: { '--gap': '8px' } }, detailParts) : null,
        actions: componentsButtons(ctx, pendingSummary, { onPending: setPending, primary: !failure }),
      }));

      // 3. Upscayl (optional)
      if (up && up.found) {
        rows.push(ui.statusRow({
          status: 'ok',
          title: 'Upscayl (optional)',
          message: `Found${up.version ? ` (version ${up.version})` : ''}. Make PDF can use it to sharpen low-resolution pictures.`,
          detail: [up.binPath, gpuText(up)].filter(Boolean).join(' · ') || null,
          actions: [ui.button({ label: 'Change…', size: 'sm', variant: 'ghost', disabled: busy, title: busyMessage(job) || undefined, onClick: () => locateUpscayl(ctx) })],
        }));
      } else {
        rows.push(ui.statusRow({
          status: 'optional',
          title: 'Upscayl (optional)',
          message: 'Not installed. This free app makes low-resolution card pictures sharper when printed. You can add it later.',
          actions: [
            ui.button({ label: 'Download', icon: 'external-link', size: 'sm', onClick: () => openLink(ctx, EXTERNAL_LINKS.upscayl.url) }),
            ui.button({ label: 'Locate…', size: 'sm', disabled: busy, title: busyMessage(job) || 'Already installed? Show the app where it is.', onClick: () => locateUpscayl(ctx) }),
          ],
        }));
      }

      // 4. Silhouette Studio
      if (studio && studio.found) {
        rows.push(ui.statusRow({
          status: 'ok',
          title: 'Silhouette Studio',
          message: `Found${studio.version ? ` (version ${studio.version})` : ''}. You will use it to cut your sheets.`,
          detail: studio.path || null,
        }));
      } else {
        rows.push(ui.statusRow({
          status: 'info',
          title: 'Silhouette Studio',
          message: 'Not found on this computer. You need this free program from Silhouette America to cut your sheets (not to make the PDF).',
          actions: [ui.button({ label: 'Download', icon: 'external-link', size: 'sm', onClick: () => openLink(ctx, EXTERNAL_LINKS.silhouetteStudio.url) })],
        }));
      }

      return ui.card({
        title: 'Checklist',
        subtitle: e?.ready ? 'Everything the app needs is ready.' : 'The card maker components are required; the other items are optional.',
        icon: 'check-circle',
        actions: [ui.button({ label: 'Check again', icon: 'refresh', size: 'sm', variant: 'ghost', disabled: busy, title: busyMessage(job) || undefined, onClick: () => checkAgain() })],
        children: rows,
      });
    }

    function setPending(label) {
      view.pending = label;
      updateChecklist();
    }

    async function checkAgain() {
      setPending('Checking…');
      try {
        await ctx.refresh.env({ refresh: true });
      } finally {
        setPending(null);
      }
    }

    /* ---------- step 3: equipment ---------- */

    function renderEquipmentStep() {
      footerSlot = slot('footer');
      const editor = equipmentEditor({
        value: view.equipment,
        onChange: (next) => {
          view.equipment = next;
          updateFooter();
        },
      });
      queueMicrotask(updateFooter);
      return [
        ui.card({ children: editor }),
        footerSlot,
      ];
    }

    async function finishSetup() {
      const patch = equipmentPatch(view.equipment);
      patch.setupComplete = true;
      patch.welcomeAccepted = true;
      try {
        await saveSettings(ctx, patch);
      } catch (err) {
        ui.showError(err, { title: 'Could not save your equipment' });
        return;
      }
      view.step = 'done';
      renderAll();
      showTop();
    }

    /* ---------- finished ---------- */

    function renderDone() {
      const machine = getMachine(view.equipment.machine);
      const paper = getPaperSize(view.equipment.paper);
      const job = store.get('job');
      const busy = isJobRunning(job);
      const samplesRunning = busy && view.samplesJobId && job.jobId === view.samplesJobId;
      return [
        ui.card({
          variant: 'success',
          icon: 'check-circle',
          title: 'Setup complete',
          subtitle: [paper && paper.shortLabel, machine && machine.label].filter(Boolean).join(' · ') || null,
          children: [
            h('p.prose', 'Next, download the cards of a deck. Or try the app first with a few numbered test cards: they are perfect for a first test print and cut, before you print a real deck.'),
            h('div.row', { style: { '--gap': '10px' } },
              ui.button({
                label: samplesRunning ? 'Making test cards…' : 'Try with sample cards',
                icon: 'layers',
                loading: !!samplesRunning,
                disabled: busy && !samplesRunning,
                title: busy && !samplesRunning ? busyMessage(job) : undefined,
                onClick: () => trySamples(),
              })),
          ],
        }),
        ui.callout({ variant: 'accent', icon: 'scissors', title: 'Tip for your first cut', message: FIRST_CUT_TIP }),
        nextStep({
          text: 'Next: get the pictures of your cards',
          detail: 'You can change your equipment and folders later in Settings.',
          actionLabel: 'Get cards',
          icon: 'check-circle',
          onAction: () => ctx.navigate('fetch'),
        }),
      ];
    }

    async function trySamples() {
      try {
        const res = await api.cards.loadSamples({ replace: false });
        if (ctx.signal.aborted) return;
        view.samplesJobId = res && res.jobId ? String(res.jobId) : null;
        if (!view.samplesJobId) {
          ctx.navigate('cards');
          return;
        }
        // A very quick job may already be over by the time the call returns.
        if (!handleSamplesResult(store.get('lastResults')?.samples)) renderAll();
      } catch (err) {
        ui.showError(err, { title: "Couldn't make the sample cards" });
      }
    }

    /**
     * React to the end of the sample-cards job started from this page.
     * @param {object|null|undefined} r store `lastResults.samples`
     * @returns {boolean} true when the result belonged to that job
     */
    function handleSamplesResult(r) {
      if (!view.samplesJobId || !r || r.jobId !== view.samplesJobId) return false;
      view.samplesJobId = null;
      if (r.status === 'succeeded') {
        ctx.navigate('cards');
        return true;
      }
      if (r.status === 'failed') {
        ui.toast({ variant: 'danger', title: "Couldn't make the sample cards", message: r.error?.message || undefined, timeout: 8000 });
      }
      if (view.step === 'done') renderAll();
      return true;
    }

    /* ---------- footer (next step) ---------- */

    function updateFooter() {
      if (!footerSlot) return;
      const s = settings();
      const e = env();
      const job = store.get('job');
      if (view.step === 'welcome') {
        swap(footerSlot, nextStep({
          text: s.welcomeAccepted ? 'Thanks! Next, the app checks your computer.' : 'Please read the notice above and tick “I understand”.',
          tone: s.welcomeAccepted ? 'success' : 'neutral',
          icon: s.welcomeAccepted ? 'check-circle' : 'info',
          actionLabel: 'Continue',
          disabled: !s.welcomeAccepted,
          onAction: () => goStep('checklist'),
        }));
      } else if (view.step === 'checklist') {
        const running = isJobRunning(job) && job.kind === 'setup';
        let text;
        let detail;
        let tone;
        let iconName;
        if (e?.ready) {
          text = 'Everything is ready';
          detail = 'Next: choose your paper and cutting machine.';
          tone = 'success';
          iconName = 'check-circle';
        } else if (running) {
          text = 'Installing the card maker components…';
          detail = 'This takes a few minutes. You can leave this page; the setup keeps running.';
          tone = 'neutral';
          iconName = 'clock';
        } else {
          text = 'Install the card maker components to continue';
          detail = 'They are needed to download cards and make PDFs.';
          tone = 'warning';
          iconName = 'alert-triangle';
        }
        swap(footerSlot, nextStep({
          text, detail, tone, icon: iconName,
          actionLabel: 'Continue',
          disabled: !e?.ready,
          onAction: () => goStep('equipment'),
          secondary: { label: 'Back', icon: 'arrow-left', onClick: () => goStep('welcome') },
        }));
      } else if (view.step === 'equipment') {
        const chosen = !!getMachine(view.equipment.machine);
        swap(footerSlot, nextStep({
          text: chosen ? 'Ready to finish' : 'Choose your cutting machine to finish',
          detail: chosen ? 'You can change this later in Settings.' : 'Not sure? Choose “Other / not sure”: 3-corner marks work with every Silhouette.',
          tone: chosen ? 'success' : 'neutral',
          icon: chosen ? 'check-circle' : 'scissors',
          actionLabel: 'Finish setup',
          disabled: !chosen,
          onAction: () => finishSetup(),
          secondary: { label: 'Back', icon: 'arrow-left', onClick: () => goStep('checklist') },
        }));
      }
    }

    /* ---------- store subscriptions ---------- */

    ctx.subscribe('env', () => {
      renderStepper();
      updateChecklist();
    });
    ctx.subscribe('job', frameThrottle(() => {
      if (ctx.signal.aborted) return;
      updateChecklist();
      if (view.step === 'checklist') updateFooter();
      if (view.step === 'done' && view.samplesJobId) {
        const job = store.get('job');
        if (job && job.jobId === view.samplesJobId && !isJobRunning(job)) {
          // handled by lastResults below; re-render to drop the spinner
          renderAll();
        }
      }
    }));
    ctx.subscribe('lastResults', (results) => {
      updateChecklist();
      handleSamplesResult(results?.samples);
    });
    ctx.subscribe('settings', () => {
      renderStepper();
      if (view.step === 'welcome' || view.step === 'equipment') updateFooter();
    });

    renderAll();
  },
};
