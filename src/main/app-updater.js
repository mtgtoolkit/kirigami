'use strict';

/**
 * Kirigami's own updates, from the app's GitHub releases (mtgtoolkit/kirigami), through
 * electron-updater. The decisions (mode, state transitions, schedule, install gating, error wording)
 * live in `app-update-state.js`; this module wires them to electron-updater and the app.
 *
 * Behaviour (installed app only, see app-update-state.js for the modes):
 * - Checks about 10 s after startup, then every 4 hours while the app runs, unless the
 *   `updates.appCheck` setting is off; "Check now" always works. A check reads GitHub's public
 *   releases feed (no API quota). Draft releases are invisible to it until they are published.
 * - A newer version is downloaded in the background right away (electron-updater verifies its
 *   sha512 from `latest.yml`; differential downloads use the published .blockmap files).
 * - electron-updater has no working request timeout under Electron, so this module bounds both
 *   steps itself: a check fails after `CHECK_TIMEOUT_MS` without an answer, and a download that
 *   receives nothing for `DOWNLOAD_STALL_MS` is cancelled. Both then count as failures (retried
 *   after 30 minutes) instead of leaving "Checking…" or "Downloading…" on screen forever and
 *   blocking every later check.
 * - When it is ready, the window offers "Restart to update" (toast + Settings). The update is also
 *   installed silently the next time the app quits normally (`autoInstallOnAppQuit`).
 * - "Restart to update" is refused while a task runs. Otherwise settings are saved first, then
 *   `quitAndInstall(true, true)` starts the one-click installer silently with "run the app
 *   afterwards" and asks the app to quit. That quit goes through main.js's `before-quit` →
 *   `shutdown()` like any other (watchers stopped, shutdown hooks run); the installer waits for the
 *   app to exit (and ends it after a few seconds), so nothing slow may run in between, which is why
 *   a running task blocks the restart instead of being stopped. If a task slips in anyway,
 *   `isInstalling()` tells shutdown() to stop it without asking (the installer closes the app
 *   whatever the answer). electron-updater's own quit handler then sees that the installer already
 *   runs and does nothing more.
 *
 * Every state change is pushed to the window on `updates:changed`; the window also pulls it with
 * `updates:state` (pushes sent before it subscribed are lost). electron-updater is required lazily,
 * only when a check runs, so copies that never update (from source, unpacked test builds, tests)
 * never load it. Its log lines go to the app log with an `[updates]` prefix.
 */

const fs = require('node:fs');
const path = require('node:path');
const S = require('./app-update-state');
const { userError } = require('./errors');

/** Download progress pushed to the window at most this often. */
const PROGRESS_EMIT_MS = 500;
/**
 * Lines electron-updater logs as errors although nothing is broken: the echo of every failure it
 * reports (its own 'error' listener, `Error: <stack>`, even for "no release published yet"), which
 * this module handles and words itself, and a differential download it replaces with a full one.
 */
const HANDLED_ERROR_LINES = /^(Error: |Cannot download differentially, fallback to full download)/;

/** electron-updater's shared instance (created on first access). */
function loadElectronUpdater() {
  // eslint-disable-next-line global-require
  return require('electron-updater').autoUpdater;
}

/** A token that stops an electron-updater download (every request of the download watches it). */
function newCancellationToken() {
  // eslint-disable-next-line global-require
  return new (require('electron-updater').CancellationToken)();
}

/**
 * Whether electron-builder wrote the update feed settings next to the app (NSIS installer builds
 * only; `npm run pack` builds have none).
 * @returns {boolean}
 */
function hasUpdateConfig() {
  try {
    return !!process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
  } catch {
    return false;
  }
}

/**
 * Create the app updater. Nothing happens until `start()`.
 *
 * @param {object} deps app deps: app (isPackaged, getVersion), settings, jobs, logger, emit, isTest,
 *   ready, addShutdownHook
 * @param {object} [options]
 * @param {Record<string, string|undefined>} [options.env] defaults to process.env
 * @param {string[]} [options.argv] defaults to process.argv
 * @param {() => object} [options.loadUpdater] returns electron-updater's `autoUpdater` (tests pass a fake)
 * @param {() => boolean} [options.hasUpdateConfig] whether resources/app-update.yml exists (packaged only)
 * @param {() => number} [options.now]
 * @param {typeof setTimeout} [options.setTimeout]
 * @param {typeof clearTimeout} [options.clearTimeout]
 * @returns {{ start(): void, stop(): void, state(): object, check(opts?: { manual?: boolean }): Promise<object>,
 *   install(): Promise<{ ok: true, version: string }>, isInstalling(): boolean }}
 */
function createAppUpdater(deps, options = {}) {
  const app = deps.app || {};
  const env = options.env || process.env;
  const argv = options.argv || process.argv;
  const loadUpdater = typeof options.loadUpdater === 'function' ? options.loadUpdater : loadElectronUpdater;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const setTimer = options.setTimeout || setTimeout;
  const clearTimer = options.clearTimeout || clearTimeout;
  const log = prefixedLogger(deps.logger);

  const currentVersion = safeCall(() => app.getVersion(), '0.0.0');
  const packaged = !!app.isPackaged;
  const updateConfig = packaged && safeCall(typeof options.hasUpdateConfig === 'function' ? options.hasUpdateConfig : hasUpdateConfig, false);
  const { mode, reason } = S.updateMode({ packaged, updateConfig, isTest: !!deps.isTest, env });
  let state = S.initialUpdateState({
    mode,
    reason,
    currentVersion,
    autoCheck: readAutoCheck(safeCall(() => deps.settings && deps.settings.get(), null)),
    updatedTo: S.launchedByUpdater(argv) ? currentVersion : null,
  });

  let updater = null;
  let checkPromise = null;
  let downloadPromise = null;
  /** The running download's stall watch: re-armed by every progress event, cancels the download when they stop. */
  let downloadWatch = null;
  let timer = null;
  let started = false;
  let stopped = false;
  /** True once the installer was launched by "Restart to update" (the app is about to be closed). */
  let installerLaunched = false;
  /** The "Restart to update" in progress or done (a failed one is cleared so it can be tried again). */
  let installPromise = null;
  /** The installer electron-updater downloaded (null when it did not say). */
  let downloadedFile = null;
  let lastProgressEmit = 0;
  let unsubscribeSettings = null;

  // ----- state ---------------------------------------------------------------------------------

  function snapshot() {
    return structuredClone(state);
  }

  function announce() {
    try {
      if (typeof deps.emit === 'function') deps.emit('updates:changed', snapshot());
    } catch (err) {
      log.warn('Could not tell the window about the update status:', err);
    }
  }

  function dispatch(event, { emit = true } = {}) {
    const next = S.reduceUpdateState(state, event);
    if (next !== state) {
      state = { ...next, revision: state.revision + 1 };
      if (emit) announce();
    }
    return state;
  }

  function activeJob() {
    return safeCall(() => (deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null), null);
  }

  // ----- electron-updater ----------------------------------------------------------------------

  function getUpdater() {
    if (updater) return updater;
    let instance;
    try {
      instance = loadUpdater();
    } catch (err) {
      throw userError('Part of the app is missing (electron-updater). Please reinstall Kirigami.', { code: 'SERVICE_UNAVAILABLE', cause: err });
    }
    if (!instance || typeof instance.checkForUpdates !== 'function' || typeof instance.on !== 'function') {
      throw userError('Part of the app is missing (electron-updater). Please reinstall Kirigami.', { code: 'SERVICE_UNAVAILABLE' });
    }
    instance.logger = {
      info: (message) => log.info(String(message)),
      warn: (message) => log.warn(String(message)),
      error: (message) => (HANDLED_ERROR_LINES.test(String(message)) ? log.warn(String(message)) : log.error(String(message))),
      debug: (message) => log.debug(String(message)),
    };
    // Downloads are started here (so their failures are handled), not by electron-updater itself.
    instance.autoDownload = false;
    // Install on a normal quit, but never in a rehearsal: the "installer" there is a test file.
    instance.autoInstallOnAppQuit = mode === 'auto';
    // Kirigami ships a full NSIS installer, never a web installer (also silences a warning).
    instance.disableWebInstaller = true;
    // The rehearsal reads <app>/dev-app-update.yml instead of resources/app-update.yml.
    if (mode === 'rehearsal') instance.forceDevUpdateConfig = true;
    // No 'error' listener here: electron-updater registers its own (it logs the stack through the
    // logger above), and check/download failures are handled where they are awaited.
    instance.on('download-progress', onProgress);
    instance.on('update-downloaded', onDownloaded);
    updater = instance;
    return updater;
  }

  function onProgress(progress) {
    if (downloadWatch) downloadWatch.touch();
    if (!progress || state.phase !== 'downloading') return;
    dispatch({ type: 'download-progress', ...progress }, { emit: false });
    const t = now();
    if (t - lastProgressEmit >= PROGRESS_EMIT_MS) {
      lastProgressEmit = t;
      announce();
    }
  }

  function onDownloaded(info) {
    const update = S.releaseInfo(info) || state.available;
    const before = state.phase;
    downloadedFile = info && typeof info.downloadedFile === 'string' ? info.downloadedFile : null;
    dispatch({ type: 'downloaded', update });
    if (before !== 'ready' && state.phase === 'ready') {
      log.info(`Version ${state.available.version} is downloaded and ready to install.`);
    }
  }

  // ----- check and download ----------------------------------------------------------------------

  /**
   * Ask GitHub whether a newer version exists; start downloading it when it does.
   * @param {{ manual?: boolean }} [opts] manual = "Check now" (refused with a reason when disabled)
   * @returns {Promise<object>} the state after the check
   */
  function check({ manual = false } = {}) {
    if (mode === 'disabled') {
      if (manual) return Promise.reject(userError(state.disabledMessage, { code: 'UPDATES_DISABLED' }));
      return Promise.resolve(snapshot());
    }
    if (stopped) return Promise.resolve(snapshot());
    if (!checkPromise) {
      checkPromise = runCheck(manual).finally(() => {
        checkPromise = null;
        schedule();
      });
    }
    return checkPromise;
  }

  async function runCheck(manual) {
    dispatch({ type: 'check-started' });
    let result;
    let timeout = null;
    try {
      const instance = getUpdater();
      result = await new Promise((resolve, reject) => {
        timeout = setTimer(() => {
          // electron-updater hands a check that is still running to every later call: forget this
          // one, so the next check sends new requests instead of waiting on the stalled ones.
          instance.checkForUpdatesPromise = null;
          reject(userError(S.UPDATE_MESSAGES.checkTimeout, { code: 'UPDATE_CHECK_TIMEOUT' }));
        }, S.CHECK_TIMEOUT_MS);
        if (timeout && typeof timeout.unref === 'function') timeout.unref();
        Promise.resolve().then(() => instance.checkForUpdates()).then(resolve, reject);
      });
      if (!result) throw new Error('the updater is not active in this copy of the app');
    } catch (err) {
      const at = new Date(now()).toISOString();
      if (S.isNoReleaseError(err)) {
        log.info('No Kirigami release is published yet: nothing to update.');
        dispatch({ type: 'check-finished', at, update: null });
      } else {
        dispatch({ type: 'check-failed', at, error: S.updateErrorMessage(err, 'check') });
        log.warn(`${manual ? 'Manual' : 'Automatic'} check failed: ${state.lastCheck.error}`);
      }
      return snapshot();
    } finally {
      if (timeout) clearTimer(timeout);
    }
    const update = result.isUpdateAvailable ? S.releaseInfo(result.updateInfo) : null;
    const inHand = state.phase === 'ready' && state.available ? state.available.version : null;
    dispatch({ type: 'check-finished', at: new Date(now()).toISOString(), update });
    if (!update) log.info(`Up to date (${currentVersion}).`);
    else if (update.version === inHand) log.info(`Version ${update.version} is still the newest; it is already downloaded.`);
    else log.info(`Version ${update.version} is available (this is ${currentVersion}).`);
    if (state.phase === 'downloading') startDownload();
    return snapshot();
  }

  function startDownload() {
    if (downloadPromise) return downloadPromise;
    lastProgressEmit = 0;
    const version = state.available && state.available.version;
    let stalled = false;
    downloadPromise = Promise.resolve()
      .then(() => {
        const instance = getUpdater();
        const token = newCancellationToken();
        downloadWatch = watchDownload(() => {
          stalled = true;
          token.cancel();
        });
        return instance.downloadUpdate(token);
      })
      .then(() => {
        // 'update-downloaded' normally moved the state already; this covers a missed event.
        if (state.phase === 'downloading') onDownloaded(null);
      }, (err) => {
        dispatch({ type: 'download-failed', error: stalled ? S.UPDATE_MESSAGES.downloadStalled : S.updateErrorMessage(err, 'download') });
        log.warn(`Downloading version ${version} failed: ${state.error}`);
        schedule(); // try again sooner than 4 hours (the check that found it was scheduled as a success)
      })
      .finally(() => {
        if (downloadWatch) downloadWatch.stop();
        downloadWatch = null;
        downloadPromise = null;
      });
    return downloadPromise;
  }

  /**
   * Call `onStall` once `touch()` was not called for `DOWNLOAD_STALL_MS` (armed at creation).
   * @param {() => void} onStall
   * @returns {{ touch(): void, stop(): void }}
   */
  function watchDownload(onStall) {
    let handle = null;
    const watch = {
      touch() {
        if (handle) clearTimer(handle);
        handle = setTimer(onStall, S.DOWNLOAD_STALL_MS);
        if (handle && typeof handle.unref === 'function') handle.unref();
      },
      stop() {
        if (handle) clearTimer(handle);
        handle = null;
      },
    };
    watch.touch();
    return watch;
  }

  // ----- schedule --------------------------------------------------------------------------------

  function schedule() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (!started || stopped || mode === 'disabled') return;
    // A failed download counts as a failed check: the next attempt comes after the short retry delay.
    const lastCheck = state.lastCheck && state.phase === 'error' ? { ...state.lastCheck, ok: false } : state.lastCheck;
    const delay = S.planNextCheck({ autoCheck: state.autoCheck, now: now(), lastCheck });
    if (delay === null) {
      dispatch({ type: 'scheduled', at: null });
      return;
    }
    timer = setTimer(onTimer, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
    dispatch({ type: 'scheduled', at: new Date(now() + delay).toISOString() });
  }

  function onTimer() {
    timer = null;
    if (stopped) return;
    if (checkPromise) return; // its end schedules the next one
    if (downloadPromise) {
      downloadPromise.finally(() => schedule());
      return;
    }
    check({ manual: false }).catch((err) => log.warn('Automatic check failed:', err));
  }

  function onSettingsChanged(next, meta) {
    if (meta && Array.isArray(meta.changedKeys) && !meta.changedKeys.includes('updates')) return;
    const enabled = readAutoCheck(next);
    if (enabled === state.autoCheck) return;
    dispatch({ type: 'auto-check', enabled });
    log.info(`Automatic checks ${enabled ? 'on' : 'off'}.`);
    schedule();
  }

  // ----- install ---------------------------------------------------------------------------------

  /**
   * Quit and install the downloaded update, then start the app again.
   * @returns {Promise<{ ok: true, version: string }>}
   */
  function install() {
    // A second click (the toast and Settings both offer it), even while the first one is saving the
    // settings, gets the first one's answer: calling quitAndInstall() again makes electron-updater
    // forget the first call, and its quit handler would start a second installer.
    if (!installPromise) {
      installPromise = runInstall().catch((err) => {
        installPromise = null;
        throw err;
      });
    }
    return installPromise;
  }

  async function runInstall() {
    const blocked = () => S.installBlocker({ mode, phase: state.phase, activeJob: activeJob() });
    let blocker = blocked();
    if (blocker) throw userError(blocker.message, { code: blocker.code });
    // The installer starts counting down as soon as it runs: save the settings before launching it.
    if (deps.settings && typeof deps.settings.flush === 'function') {
      try {
        await deps.settings.flush();
      } catch (err) {
        log.warn('Could not save the settings before updating:', err);
      }
    }
    blocker = blocked(); // a task may have started meanwhile
    if (blocker) throw userError(blocker.message, { code: blocker.code });

    const version = state.available.version;
    // An antivirus may have removed the installer (it is not code-signed). quitAndInstall() would then
    // close the app and install nothing, without any error: download it again instead.
    if (downloadedFile && !fs.existsSync(downloadedFile)) {
      log.warn(`The downloaded installer is gone (${downloadedFile}); downloading version ${version} again.`);
      downloadedFile = null;
      dispatch({ type: 'install-failed', error: S.UPDATE_MESSAGES.installerMissing });
      check().catch((err) => log.warn('Could not check for updates again:', err));
      throw userError(S.UPDATE_MESSAGES.installerMissing, { code: 'UPDATE_INSTALLER_MISSING' });
    }

    const instance = getUpdater();
    const failures = [];
    const onError = (err) => failures.push(err);
    instance.on('error', onError);
    try {
      log.info(`Restarting to install version ${version}.`);
      // Silent one-click install, then run the app again. electron-updater launches the installer,
      // then calls app.quit() on the next tick, which goes through main.js's before-quit/shutdown().
      instance.quitAndInstall(true, true);
    } catch (err) {
      failures.push(err);
    } finally {
      instance.removeListener('error', onError);
    }
    if (failures.length) {
      dispatch({ type: 'install-failed', error: S.updateErrorMessage(failures[0], 'install') });
      log.error(`The installer could not start: ${state.error}`, failures[0]);
      throw userError(state.error, { code: 'UPDATE_INSTALL_FAILED', cause: failures[0] });
    }
    installerLaunched = true;
    return { ok: true, version };
  }

  /**
   * True once "Restart to update" launched the installer. The installer closes the app within a
   * few seconds whatever happens, so main.js's shutdown() must not offer "Keep working" then.
   * @returns {boolean}
   */
  function isInstalling() {
    return installerLaunched;
  }

  // ----- lifecycle -------------------------------------------------------------------------------

  /** Start automatic checks once the app's startup tasks are done (no-op when disabled). */
  function start() {
    if (started) return;
    started = true;
    log.info(`Mode ${mode}${reason ? ` (${reason})` : ''}, version ${currentVersion}${state.updatedTo ? ', just updated' : ''}.`);
    if (mode === 'disabled') return;
    if (deps.settings && typeof deps.settings.onChange === 'function') {
      unsubscribeSettings = deps.settings.onChange(onSettingsChanged);
    }
    if (typeof deps.addShutdownHook === 'function') deps.addShutdownHook(stop);
    Promise.resolve(deps.ready).catch(() => {}).then(() => {
      if (!stopped) schedule();
    });
  }

  /** Stop the timer and the settings subscription (quitting). A download in progress is left alone. */
  function stop() {
    stopped = true;
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (typeof unsubscribeSettings === 'function') {
      try {
        unsubscribeSettings();
      } catch { /* quitting */ }
    }
    unsubscribeSettings = null;
  }

  return { start, stop, state: snapshot, check, install, isInstalling };
}

/**
 * `updates.appCheck` (default on).
 * @param {object|null} settings
 * @returns {boolean}
 */
function readAutoCheck(settings) {
  return !(settings && settings.updates && settings.updates.appCheck === false);
}

function prefixedLogger(logger) {
  const target = logger || {};
  const write = (level) => (...args) => {
    try {
      const fn = typeof target[level] === 'function' ? target[level] : target.info;
      if (typeof fn === 'function') fn.call(target, '[updates]', ...args);
    } catch { /* logging never breaks updates */ }
  };
  return { info: write('info'), warn: write('warn'), error: write('error'), debug: write('debug') };
}

function safeCall(fn, fallback) {
  try {
    const value = fn();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

module.exports = { createAppUpdater };
