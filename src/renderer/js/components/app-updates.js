/**
 * Kirigami's own updates in the window: the status shown in Settings > Updates, the toasts, and the
 * two actions (check now, restart to update).
 *
 * The main process does the work (src/main/app-updater.js): it checks GitHub every few hours,
 * downloads a new version in the background and pushes its state on `updates:changed`. The store
 * key `appUpdate` holds the newest copy; `acceptAppUpdate()` drops an older copy that arrives late
 * (every state carries a `revision` that only grows). `describeAppUpdate()` is pure (unit-tested).
 *
 * @module components/app-updates
 */

import * as ui from '../core/ui.js';
import { formatBytes, formatDate } from '../core/format.js';

/** Same as RELEASES_URL in src/main/app-update-state.js (the state normally carries it). */
const RELEASES_URL = 'https://github.com/mtgtoolkit/kirigami/releases';

/**
 * Store a state pushed or returned by the main process, unless the store already has a newer one.
 * @param {{ get(key: string): any, set(key: string, value: any): any }} store
 * @param {unknown} next
 * @returns {boolean} stored
 */
export function acceptAppUpdate(store, next) {
  if (!next || typeof next !== 'object') return false;
  const current = store.get('appUpdate');
  if (current && Number(next.revision) < Number(current.revision)) return false;
  store.set('appUpdate', next);
  return true;
}

/**
 * The release page of the version this copy was just updated to (falls back to all releases).
 * @param {object} state
 * @returns {string}
 */
export function updatedReleaseUrl(state) {
  const base = state?.releasesUrl || RELEASES_URL;
  return state?.updatedTo && /^[\w.+-]+$/.test(state.updatedTo) ? `${base}/tag/v${state.updatedTo}` : base;
}

/**
 * Describe the update state for a status row. Pure.
 * @param {object|null|undefined} state `scm.updates.state()`
 * @param {{ now?: number }} [options] `now` for date wording (tests)
 * @returns {{ status: 'ok'|'running'|'info'|'warning'|'pending'|'optional', title: string, message: string }}
 */
export function describeAppUpdate(state, { now = Date.now() } = {}) {
  if (!state) return { status: 'pending', title: 'Update status unavailable', message: 'Kirigami could not read its update status.' };
  const when = (iso) => formatDate(iso, { now });
  const version = state.available?.version;
  const rehearsal = state.mode === 'rehearsal' ? ' (Rehearsal from source: it is never installed.)' : '';
  if (state.mode === 'disabled') {
    // The main process words the reason (running from source, tests, SCM_APP_UPDATES=0).
    return {
      status: 'optional',
      title: 'Automatic updates are off in this copy',
      message: state.disabledMessage || 'Download the newest installer from the releases page.',
    };
  }
  if (state.phase === 'ready') {
    return {
      status: 'info',
      title: `Kirigami ${version} is ready to install`,
      message: `Restart Kirigami to finish. Otherwise it is installed the next time you close the app.${rehearsal}`,
    };
  }
  if (state.phase === 'downloading') {
    const p = state.progress || {};
    const amount = p.total > 0 ? ` · ${formatBytes(p.transferred)} of ${formatBytes(p.total)}` : '';
    return {
      status: 'running',
      title: `Downloading Kirigami ${version}…`,
      message: `In the background; you can keep working${amount}.`,
    };
  }
  if (state.checking) return { status: 'running', title: 'Checking for updates…', message: 'Asking GitHub for the newest Kirigami release.' };
  if (state.phase === 'error') {
    return {
      status: 'warning',
      title: version ? `Kirigami ${version} could not be downloaded` : 'Could not check for updates',
      message: state.error || 'Something went wrong.',
    };
  }
  if (state.phase === 'up-to-date') {
    return {
      status: 'ok',
      title: 'Kirigami is up to date',
      message: `You have version ${state.currentVersion}${state.lastCheck?.at ? ` (checked ${when(state.lastCheck.at)})` : ''}.`,
    };
  }
  return {
    status: 'pending',
    title: 'Not checked yet',
    message: state.autoCheck
      ? 'Kirigami checks a few seconds after it starts, then every 4 hours while it is open.'
      : 'Automatic checks are off. Click Check now to look for a new version.',
  };
}

/**
 * Quit and install the downloaded update (the app restarts by itself). Shows why when it can't.
 * @param {{ api: object }} ctx
 */
export async function restartToUpdate({ api }) {
  try {
    await api.updates.install();
  } catch (err) {
    ui.showError(err, { title: "Couldn't restart to update" });
  }
}

/**
 * Persistent toast offering to restart for a downloaded update.
 * @param {{ api: object }} ctx
 * @param {object} state
 * @returns {{ close: () => void }}
 */
export function showReadyToast(ctx, state) {
  const version = state.available?.version || '';
  const rehearsal = state.mode === 'rehearsal';
  return ui.toast({
    variant: 'accent',
    title: `Kirigami ${version} is ready`,
    message: rehearsal
      ? 'Rehearsal from source: the update was downloaded but is never installed.'
      : 'Restart now to finish updating, or it is installed when you close Kirigami.',
    actions: rehearsal ? [] : [{ label: 'Restart to update', icon: 'refresh', variant: 'primary', onClick: () => restartToUpdate(ctx) }],
    timeout: 0,
  });
}

/**
 * "Check now": ask the main process to check, store the result and say what happened.
 * @param {{ api: object, store: object }} ctx
 * @returns {Promise<object|null>} the state after the check, or null when it was refused
 */
export async function checkForAppUpdates(ctx) {
  let state;
  try {
    state = await ctx.api.updates.check();
  } catch (err) {
    ui.showError(err, { title: 'Could not check for updates' });
    return null;
  }
  acceptAppUpdate(ctx.store, state);
  const version = state?.available?.version;
  if (state?.phase === 'error') {
    ui.toast({ variant: 'warning', title: version ? `Kirigami ${version} could not be downloaded` : 'Could not check for updates', message: state.error, timeout: 8000 });
  } else if (state?.phase === 'up-to-date') {
    ui.toast({ variant: 'success', title: 'Kirigami is up to date', message: `You have version ${state.currentVersion}.` });
  } else if (state?.phase === 'downloading') {
    ui.toast({ variant: 'info', title: `Kirigami ${version} is available`, message: 'It is downloading in the background. You can keep working; Kirigami tells you when it is ready.' });
  }
  // 'ready' is announced by the shell's ready toast and shown in Settings.
  return state || null;
}
