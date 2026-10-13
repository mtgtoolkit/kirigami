'use strict';

/**
 * engine-updater.js — keeps the Silhouette Card Maker engine up to date while Kirigami runs.
 *
 * Where engines live: the installer ships one in resources/engine (build/engine in development); newer
 * ones are assembled in <dataDir>/engines/<commit>/ (the engine files plus .engine-manifest.json, exactly
 * what scripts/fetch-engine.mjs builds), next to the updater's bookkeeping in <dataDir>/engines/state.json.
 * engine-state.js holds every decision taken here as pure, unit-tested functions.
 *
 * 1. Startup (init, before the workspace is prepared): the engine in use is the newest of the bundled
 *    engine and the downloaded one recorded as active, when that folder still matches its manifest (a
 *    cutting template or calibration sheet saved over by the program the user opened it with aside).
 *    deps.getEngineDir() returns it from then on, so every deps.getPaths() call sees it and a later switch
 *    applies to the next operation without a restart.
 * 2. Checking (start): about a minute after startup, then every hour, and on "Check now". A check is one
 *    git `ls-refs` request, which uses no GitHub API quota; nothing more happens when the branch still
 *    points at the engine in use, at a rejected commit or at one already known not to be newer.
 * 3. Preparing (in the background, without locks; nothing in use is touched): the commit's date (one API
 *    call) and, when it is newer, its file list (one more). Files whose git blob SHA-1 did not change are
 *    copied from the engine in use and verified, the others are downloaded and verified, the manifest is
 *    written, and `<commit>.partial` is renamed to `<commit>` only once complete.
 * 4. Activating (needs the app idle): a job of kind 'engine' starts as soon as no other job runs, so it
 *    never interrupts the user's work (a job started meanwhile gets the usual "please wait"). Under the
 *    exclusive Python lock it points the app at the new engine, refreshes the workspace copy, installs the
 *    new requirements when they changed and the components were set up (python-env refreshForEngine),
 *    makes a test PDF, reads the options the window shows (helper introspect), clears every cache
 *    derived from the engine, records the switch and tells the window ('engine:changed'). Components that were not working only get the new files (Setup installs the
 *    rest). On any failure the previous engine is put back (its files, and its requirements when others
 *    were installed), the commit is rejected unless the failure was circumstantial (no network, the app
 *    quitting…), and a warning is shown.
 * 5. Rollback: "Roll back" returns to the previous engine through the same job and rejects the commit it
 *    leaves, so the next automatic check does not reinstall it. Going back to a download older than the
 *    bundled engine sticks across restarts until an engine newer than the one left arrives (engine-state
 *    chooseActiveEngine and updateBaseline).
 *
 * Off in linked mode (SCM_ENGINE_DIR), in tests (SCM_E2E) and with SCM_ENGINE_UPDATES=0. The setting
 * `updates.engineAuto: false` only stops the automatic checks: "Check now" still works.
 * No Electron: the fetch implementation (Electron's net.fetch in the app) and the timers are injected.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const engineFiles = require('./engine-files');
const { createEngineRemote, DEFAULT_ENGINE_REPOSITORY, DEFAULT_ENGINE_REF } = require('./engine-remote');
const engineState = require('./engine-state');
const { userError } = require('./errors');
const { validIntrospection } = require('./helper');
const util = require('./util');

const STATE_FILE = 'state.json';
const PARALLEL_DOWNLOADS = 4;
/** Pause after another job ends before the engine job takes the slot (room for the user's next click). */
const IDLE_GRACE_MS = 3000;
const ACTIVATION_TITLES = Object.freeze({
  update: 'Updating the card maker engine',
  rollback: 'Rolling back the card maker engine',
  restore: 'Putting the previous card maker components back',
});
const ACTIVATION_STEPS = Object.freeze([
  { id: 'files', label: 'Card maker files' },
  { id: 'components', label: 'Card maker components' },
]);
const DISABLED_MESSAGES = Object.freeze({
  linked: 'Kirigami is linked to a card maker engine folder (SCM_ENGINE_DIR), so it does not update the engine.',
  test: 'Card maker engine updates are off while testing.',
  env: 'Card maker engine updates are turned off on this computer (SCM_ENGINE_UPDATES=0).',
});
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// ---------------------------------------------------------------------------------------------
// File helpers (also used by prepareEngine, which is exported)
// ---------------------------------------------------------------------------------------------

function cancelledError() {
  return Object.assign(new Error('Cancelled'), { name: 'CancelledError', code: 'CANCELLED' });
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) throw cancelledError();
}

/** Run `fn` over items with at most `limit` in flight; rejects with the first error. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  let failed = null;
  async function worker() {
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        failed = failed || err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failed) throw failed;
  return results;
}

/** Rename a folder, retrying while Windows (an antivirus scan, the indexer) briefly holds a file in it. */
async function renameWithRetry(from, to, attempts = 10) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (attempt >= attempts - 1 || !RENAME_RETRY_CODES.has(err && err.code)) throw err;
      await util.sleep(100 * (attempt + 1));
    }
  }
}

/** File content when its git blob SHA-1 is the expected one, else null (missing, modified). */
async function readVerified(file, blob) {
  try {
    const data = await fsp.readFile(file);
    return engineFiles.gitBlobSha1(data) === blob ? data : null;
  } catch {
    return null;
  }
}

/**
 * Is this engine file a document the user opens with another program? Cutting templates (Silhouette
 * Studio) and calibration sheets (a PDF viewer) are read from the engine folder itself, so such a program
 * may save over one, or leave a file next to it. That changes nothing the engine runs.
 * @param {string} rel POSIX path relative to the engine root
 * @returns {boolean}
 */
function isUserDocument(rel) {
  return rel.startsWith('cutting_templates/') || rel.startsWith('calibration/');
}

/**
 * Read an engine folder through its manifest.
 * @param {string} dir
 * @param {'bundled'|'downloaded'|'linked'} origin
 * @param {{expectCommit?: string|null, verify?: false|'shallow'|'deep', allowEditedDocuments?: boolean}} [options]
 *   verify the files against the manifest: sizes only ('shallow', fast enough for startup) or git blob
 *   SHA-1 too ('deep'). allowEditedDocuments: a modified or added file among the user's documents
 *   (isUserDocument) does not make the engine unusable: for the engine to use, not for a fresh download.
 * @returns {Promise<{record: object|null, problem: string|null}>}
 */
async function readEngineDir(dir, origin, { expectCommit = null, verify = false, allowEditedDocuments = false } = {}) {
  let manifest;
  try {
    manifest = await engineFiles.readManifest(dir);
  } catch (err) {
    return { record: null, problem: `its manifest is unreadable (${err.message})` };
  }
  if (!manifest) return { record: null, problem: 'it has no manifest' };
  if (expectCommit && manifest.source.commit !== expectCommit) {
    return { record: null, problem: `its manifest names commit ${manifest.source.commit}, not ${expectCommit}` };
  }
  if (verify) {
    const check = await engineFiles.verifyEngineDir(dir, manifest, { deep: verify === 'deep' });
    const matters = (p) => !(allowEditedDocuments && isUserDocument(p));
    const changed = check.changed.filter(matters);
    const extra = check.extra.filter(matters);
    if (check.missing.length || changed.length || extra.length) {
      const first = [...check.missing.map((p) => `missing ${p}`), ...changed.map((p) => `modified ${p}`), ...extra.map((p) => `unexpected ${p}`)];
      return { record: null, problem: `its files do not match its manifest (${first.slice(0, 3).join(', ')}${first.length > 3 ? ', …' : ''})` };
    }
  }
  return { record: { dir, origin, source: manifest.source, engineVersion: manifest.engineVersion, manifest, subject: null }, problem: null };
}

/**
 * Assemble one commit of the engine in `<enginesDir>/<commit>` (step 3 of the module doc). A complete
 * folder left by an earlier run is reused after a full check. Exported for the tests and for checking the
 * updater against GitHub.
 * @param {object} options
 * @param {{getTree: Function, downloadFile: Function}} options.remote engine-remote client
 * @param {{repository:string, ref:string, commit:string, committedAt:string}} options.source
 * @param {string} options.enginesDir
 * @param {{dir: string, manifest: object}|null} [options.base] engine whose unchanged files are copied
 * @param {AbortSignal|null} [options.signal]
 * @param {(line: string) => void} [options.log]
 * @param {number} [options.parallel=4] files handled at the same time
 * @returns {Promise<{dir: string, manifest: object, reused: boolean,
 *   stats: {files: number, copied: number, downloaded: number, downloadedBytes: number, removed: number}}>}
 */
async function prepareEngine({ remote, source, enginesDir, base = null, signal = null, log = () => {}, parallel = PARALLEL_DOWNLOADS }) {
  const clean = engineFiles.validateEngineSource(source);
  const { commit } = clean;
  const short = engineState.shortCommit(commit);
  const finalDir = path.join(enginesDir, commit);
  const existing = await readEngineDir(finalDir, 'downloaded', { expectCommit: commit, verify: 'deep' });
  if (existing.record && engineFiles.sameSource(existing.record.source, clean)) {
    log(`${short} is already downloaded (${existing.record.manifest.fileCount} files)`);
    return { dir: finalDir, manifest: existing.record.manifest, reused: true, stats: { files: existing.record.manifest.fileCount, copied: 0, downloaded: 0, downloadedBytes: 0, removed: 0 } };
  }
  await fsp.rm(finalDir, { recursive: true, force: true, maxRetries: 3 });
  throwIfAborted(signal);

  const { entries } = await remote.getTree(clean.repository, commit);
  const wanted = engineFiles.engineEntriesFromTree(entries);
  const missing = engineFiles.missingRequiredFiles(wanted.map((e) => e.path));
  if (missing.length) {
    throw userError(`The newest card maker engine (${short}) is incomplete, so Kirigami did not install it.`, {
      code: 'ENGINE_INVALID',
      details: `${clean.repository}@${commit}: ${missing.join(', ')} missing`,
    });
  }
  const plan = engineFiles.diffEngineFiles(base && base.manifest ? base.manifest.files : [], wanted);
  const reusable = new Set(plan.unchanged.map((e) => e.path));
  log(`${short}: ${wanted.length} files, ${plan.unchanged.length} unchanged, ${plan.download.length} to download, ${plan.removed.length} removed`);

  await fsp.mkdir(enginesDir, { recursive: true });
  const staging = path.join(enginesDir, `${commit}.partial`);
  await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3 });
  await fsp.mkdir(staging, { recursive: true });
  const stats = { files: wanted.length, copied: 0, downloaded: 0, downloadedBytes: 0, removed: plan.removed.length };
  try {
    const files = await mapLimit(wanted, parallel, async (entry) => {
      throwIfAborted(signal);
      let data = reusable.has(entry.path) ? await readVerified(path.join(base.dir, ...entry.path.split('/')), entry.blob) : null;
      if (data) {
        stats.copied += 1;
      } else {
        data = await remote.downloadFile(clean.repository, commit, entry.path, entry.blob);
        stats.downloaded += 1;
        stats.downloadedBytes += data.length;
      }
      const dest = path.join(staging, ...entry.path.split('/'));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, data);
      return { path: entry.path, size: data.length, sha1: engineFiles.sha1Hex(data), blob: entry.blob };
    });
    const engineVersion = engineFiles.readEngineVersion(await fsp.readFile(path.join(staging, 'create_pdf.py'), 'utf8'));
    const manifest = engineFiles.buildManifest({ source: clean, engineVersion, files });
    await fsp.writeFile(path.join(staging, engineFiles.MANIFEST_NAME), engineFiles.serializeManifest(manifest));
    const check = await engineFiles.verifyEngineDir(staging, manifest, { deep: false });
    if (!check.ok) {
      throw userError('The downloaded card maker engine is incomplete. Kirigami will try again later.', {
        code: 'ENGINE_INTEGRITY',
        details: `${staging}: ${JSON.stringify(check)}`,
      });
    }
    throwIfAborted(signal);
    await renameWithRetry(staging, finalDir);
    log(`${short} ready: ${stats.copied} files copied, ${stats.downloaded} downloaded (${stats.downloadedBytes} bytes)`);
    return { dir: finalDir, manifest, reused: false, stats };
  } catch (err) {
    await fsp.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    throw err;
  }
}

/**
 * What the window shows about one engine (structured-clone safe, no manifest).
 * @param {object|null} record
 * @returns {object|null}
 */
function describeEngine(record) {
  if (!record) return null;
  const source = record.source || null;
  return {
    origin: record.origin,
    dir: record.dir || null,
    repository: source ? source.repository : null,
    ref: source ? source.ref : null,
    commit: source ? source.commit : null,
    shortCommit: source ? engineState.shortCommit(source.commit) : null,
    committedAt: source ? source.committedAt : null,
    engineVersion: record.engineVersion || null,
    subject: record.subject || null,
  };
}

// ---------------------------------------------------------------------------------------------
// The updater
// ---------------------------------------------------------------------------------------------

/**
 * Create the engine updater.
 * @param {object} deps app deps: getPaths, getEngineDir (replaced), settings, jobs, locks, helper, emit,
 *   logger, isTest
 * @param {object} [options]
 * @param {typeof fetch} [options.fetch] fetch implementation (Electron net.fetch in the app)
 * @param {object} [options.env=process.env] for SCM_ENGINE_UPDATES
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => any} [options.setTimer] default: an unref'd setTimeout
 * @param {(timer: any) => void} [options.clearTimer]
 * @param {(signal: AbortSignal) => object} [options.createRemote] engine-remote client factory (tests)
 * @param {object} [options.modules] test seams: { workspace, pythonEnv, upscayl }
 * @param {number} [options.idleGraceMs=3000]
 * @returns {{init: Function, start: Function, stop: Function, status: Function, checkNow: Function, rollback: Function}}
 */
function createEngineUpdater(deps, options = {}) {
  const {
    fetch: fetchImpl = null,
    env = process.env,
    now = Date.now,
    setTimer = (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (t && typeof t.unref === 'function') t.unref();
      return t;
    },
    clearTimer = (t) => clearTimeout(t),
    createRemote = (signal) => createEngineRemote({ fetch: fetchImpl, signal }),
    modules = {},
    idleGraceMs = IDLE_GRACE_MS,
  } = options;

  const moduleFor = (name) => modules[name] || require(`./${name}`); // lazy: these modules load python-env & co.

  let mode = null;
  let enginesDir = null;
  let bundled = null;
  let inUse = null;
  let state = engineState.emptyState();
  let phase = 'idle';
  let started = false;
  let stopped = false;
  let timer = null;
  let nextCheckAt = null;
  let graceTimer = null;
  let failures = 0;
  let checking = null;
  let checkAbort = null;
  let preparingCommit = null;
  let request = null; // { kind: 'update'|'rollback', target: engine record, manual }
  let activationJobId = null;
  let componentsToRestore = false; // the user stopped a switch while it installed components (see runRestore)
  let serial = Promise.resolve();
  let unsubscribeSettings = null;
  let jobsListener = null;

  function logAt(level, ...args) {
    try {
      const logger = deps.logger;
      if (logger && typeof logger[level] === 'function') logger[level]('[engine-updates]', ...args);
    } catch { /* logging never throws */ }
  }
  const log = { info: (...a) => logAt('info', ...a), warn: (...a) => logAt('warn', ...a), error: (...a) => logAt('error', ...a) };

  /** Disk work in <dataDir>/engines (preparing, cleaning up) runs one task at a time. */
  function runSerial(fn) {
    const run = serial.then(fn, fn);
    serial = run.catch(() => {});
    return run;
  }

  function disabledReason() {
    return engineState.updatesDisabledReason({ engineMode: mode, isTest: !!deps.isTest, env });
  }

  function autoEnabled() {
    try {
      const s = deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : null;
      return !(s && s.updates && s.updates.engineAuto === false);
    } catch {
      return true;
    }
  }

  function followed() {
    const source = (bundled && bundled.source) || (inUse && inUse.source);
    return source ? { repository: source.repository, ref: source.ref } : { repository: DEFAULT_ENGINE_REPOSITORY, ref: DEFAULT_ENGINE_REF };
  }

  function setInUse(record) {
    inUse = record;
    const dir = record && record.origin === 'downloaded' ? record.dir : undefined;
    deps.getEngineDir = () => dir;
  }

  async function saveState(next) {
    state = next;
    if (!enginesDir) return;
    try {
      await util.atomicWriteFile(path.join(enginesDir, STATE_FILE), engineState.serializeState(next));
    } catch (err) {
      log.warn('Could not save the engine update state:', err);
    }
  }

  async function readEngine(dir, origin, opts) {
    const { record, problem } = await readEngineDir(dir, origin, opts);
    if (problem && origin !== 'bundled') log.warn(`Not using the card maker engine in ${dir}: ${problem}`);
    else if (problem) log.warn(`The card maker engine bundled with the app (${dir}): ${problem}`);
    return record;
  }

  function status() {
    const reason = mode ? disabledReason() : null;
    const target = mode === 'managed' ? engineState.rollbackTarget(state, { inUse, bundled }) : null;
    const last = state.lastCheck;
    const rejection = last && last.remoteCommit ? state.rejected[last.remoteCommit] || null : null;
    return {
      mode,
      disabled: reason,
      auto: autoEnabled(),
      phase,
      engine: describeEngine(inUse),
      bundled: describeEngine(bundled),
      previous: target ? { ...target, shortCommit: engineState.shortCommit(target.commit) } : null,
      canRollback: !!target && !activationJobId && !(request && request.kind === 'rollback'),
      pending: request ? { kind: request.kind, ...describeEngine(request.target) } : null,
      lastCheck: last ? {
        ...last,
        upToDate: !!(last.ok && last.remoteCommit && inUse && inUse.source && last.remoteCommit === inUse.source.commit),
        rejection,
      } : null,
      nextCheckAt,
      jobId: activationJobId,
    };
  }

  function emit(channel, payload) {
    try {
      if (typeof deps.emit === 'function') deps.emit(channel, payload);
    } catch (err) {
      log.warn(`Could not send ${channel}:`, err);
    }
  }

  function emitStatus(change = null) {
    emit('engine:changed', { status: status(), change });
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    emitStatus();
  }

  // ----- startup ------------------------------------------------------------------------------

  /**
   * Choose the engine to use (step 1). Never throws: problems are logged and the bundled engine is used.
   * @returns {Promise<object>} status()
   */
  async function init() {
    const paths = deps.getPaths();
    mode = paths.engineMode === 'linked' ? 'linked' : 'managed';
    enginesDir = paths.enginesDir;
    bundled = await readEngine(paths.bundledEngineDir, 'bundled', {});
    if (mode === 'linked') {
      const { record } = await readEngineDir(paths.engineSourceDir, 'linked', {});
      setInUse(record || { dir: paths.engineSourceDir, origin: 'linked', source: null, engineVersion: null, manifest: null, subject: null });
      log.info(`Linked to the engine in ${paths.engineSourceDir}: engine updates are off.`);
      return status();
    }
    state = engineState.normalizeState(util.readJson(path.join(enginesDir, STATE_FILE), null));
    let downloaded = null;
    if (state.active) {
      downloaded = await readEngine(path.join(enginesDir, state.active.commit), 'downloaded', { expectCommit: state.active.commit, verify: 'shallow', allowEditedDocuments: true });
      if (downloaded) downloaded.subject = state.active.subject;
    }
    const rolledBackFrom = state.active ? state.active.rolledBackFrom || null : null;
    const chosen = engineState.chooseActiveEngine({ bundled, downloaded, rolledBackFrom })
      || { dir: paths.bundledEngineDir, origin: 'bundled', source: null, engineVersion: null, manifest: null, subject: null };
    let previousAvailable = false;
    if (state.previous) {
      previousAvailable = state.previous.origin === 'bundled'
        ? !!(bundled && bundled.source.commit === state.previous.commit)
        : !!(await readEngine(path.join(enginesDir, state.previous.commit), 'downloaded', { expectCommit: state.previous.commit, verify: 'shallow', allowEditedDocuments: true }));
    }
    const reconciled = engineState.reconcileState(state, { inUse: chosen, bundled, previousAvailable });
    if (reconciled.changed) await saveState(reconciled.state);
    setInUse(chosen);
    const d = describeEngine(chosen);
    log.info(`Using the ${chosen.origin} card maker engine ${d.engineVersion || ''} ${d.shortCommit || '(unknown commit)'} (${d.committedAt || 'unknown date'}) in ${chosen.dir}`);
    return status();
  }

  /**
   * Start checking (step 2) and listening for idle moments. Call once the startup tasks are done.
   */
  function start() {
    if (started || stopped || !mode) return;
    started = true;
    if (mode !== 'managed') return;
    jobsListener = (evt) => {
      if (evt && evt.type === 'finished' && (request || componentsToRestore)) scheduleTryActivate(idleGraceMs);
    };
    if (deps.jobs && typeof deps.jobs.on === 'function') deps.jobs.on('event', jobsListener);
    if (deps.settings && typeof deps.settings.onChange === 'function') {
      unsubscribeSettings = deps.settings.onChange((_next, meta) => {
        if (meta && Array.isArray(meta.changedKeys) && !meta.changedKeys.includes('updates')) return;
        onAutoChanged();
      });
    }
    void runSerial(cleanup);
    const reason = disabledReason();
    if (reason) {
      log.info(`Card maker engine updates are off (${reason}).`);
      return;
    }
    scheduleCheck(engineState.initialCheckDelay({ now: now(), state }));
  }

  /**
   * Stop timers and network requests (quitting). The quit flow calls this before it cancels a running
   * engine job, which is how that job tells the app closing apart from the user's Stop.
   */
  function stop() {
    stopped = true;
    clearTimer(timer);
    clearTimer(graceTimer);
    timer = null;
    graceTimer = null;
    nextCheckAt = null;
    request = null;
    if (checkAbort) checkAbort.abort();
    if (jobsListener && deps.jobs) {
      if (typeof deps.jobs.off === 'function') deps.jobs.off('event', jobsListener);
      else if (typeof deps.jobs.removeListener === 'function') deps.jobs.removeListener('event', jobsListener);
    }
    if (unsubscribeSettings) unsubscribeSettings();
  }

  function onAutoChanged() {
    if (stopped || disabledReason()) return;
    if (autoEnabled()) {
      if (!timer && !checking) scheduleCheck(engineState.FIRST_CHECK_DELAY_MS);
    } else {
      clearTimer(timer);
      timer = null;
      nextCheckAt = null;
      if (request && request.kind === 'update' && !request.manual) {
        log.info('Automatic engine updates were turned off: the prepared update is not installed.');
        request = null;
        setPhase('idle');
      }
    }
    emitStatus();
  }

  // ----- checking -----------------------------------------------------------------------------

  function scheduleCheck(ms) {
    clearTimer(timer);
    timer = null;
    nextCheckAt = null;
    if (stopped || disabledReason() || !autoEnabled()) return;
    nextCheckAt = now() + ms;
    timer = setTimer(() => {
      timer = null;
      nextCheckAt = null;
      checkNow({ manual: false }).catch((err) => log.warn('Automatic check failed:', err));
    }, ms);
  }

  /**
   * Arm the next automatic check unless one is armed or running. The timer forgets itself when it fires,
   * and only a finished check schedules the next one: a check skipped or cut short (the engine being
   * switched, a rollback waiting) would otherwise end the automatic checks for the rest of the session.
   */
  function keepChecking(ms = engineState.CHECK_INTERVAL_MS) {
    if (!timer && !checking) scheduleCheck(ms);
  }

  /**
   * Check for a newer engine now and prepare it (steps 2 and 3); the activation job follows on its own.
   * @param {{manual?: boolean}} [options] manual: asked by the user (retries a failed commit)
   * @returns {Promise<object>} status()
   */
  async function checkNow({ manual = true } = {}) {
    if (!mode) throw userError('Kirigami is still starting. Try again in a moment.', { code: 'NOT_READY' });
    const reason = disabledReason();
    if (reason) {
      if (manual) throw userError(DISABLED_MESSAGES[reason], { code: 'ENGINE_UPDATES_OFF' });
      return status();
    }
    if (stopped || activationJobId || (request && request.kind === 'rollback')) {
      keepChecking(); // the engine is being switched: look again later
      return status();
    }
    if (!checking) checking = runCheck({ manual }).finally(() => { checking = null; });
    await checking;
    return status();
  }

  async function runCheck({ manual }) {
    clearTimer(timer);
    timer = null;
    nextCheckAt = null;
    const controller = new AbortController();
    checkAbort = controller;
    const remote = createRemote(controller.signal);
    const { repository, ref } = followed();
    let remoteCommit = null;
    let outcome = null;
    let failure = null;
    setPhase('checking');
    try {
      ({ commit: remoteCommit } = await remote.lsRemote(repository, ref));
      outcome = await planAndPrepare(remote, { repository, ref, remoteCommit, manual, signal: controller.signal });
    } catch (err) {
      failure = err;
    } finally {
      if (checkAbort === controller) checkAbort = null;
    }
    try {
      if (!stopped) await recordCheckOutcome({ repository, ref, remoteCommit, outcome, failure, controller, manual });
    } finally {
      preparingCommit = null; // recorded in the state (or dropped) by now: the cleanup can judge it from there
    }
  }

  /** Record a finished check, schedule the next one and hand a prepared engine to the activation. */
  async function recordCheckOutcome({ repository, ref, remoteCommit, outcome, failure, controller, manual }) {
    const cancelled = !!(failure && (failure.code === 'CANCELLED' || controller.signal.aborted));
    if (failure && !cancelled) {
      failures += 1;
      const error = { code: failure.code || 'ERROR', message: failure.message || String(failure), resetAt: Number.isFinite(failure.resetAt) ? failure.resetAt : null };
      log.warn(`Check failed (${error.code}): ${error.message}${failure.details ? ` | ${String(failure.details).split('\n').join(' | ')}` : ''}`);
      await saveState(engineState.recordCheck(state, { at: now(), ok: false, remoteCommit, error }));
      scheduleCheck(engineState.delayAfterCheck({ now: now(), ok: false, error, failures }));
    } else {
      failures = 0;
      if (outcome) {
        await saveState(engineState.recordCheck(state, { at: now(), ok: true, remoteCommit, remoteCommittedAt: outcome.remoteCommittedAt }));
        log.info(`Checked ${repository} ${ref}: ${engineState.shortCommit(remoteCommit)} (${outcome.reason})`);
      }
      scheduleCheck(engineState.delayAfterCheck({ now: now(), ok: true }));
    }
    setPhase(request || activationJobId ? (activationJobId ? 'activating' : 'waiting') : 'idle');
    emitStatus();
    if (outcome && outcome.prepared) requestActivation({ kind: 'update', target: outcome.prepared, manual });
  }

  async function planAndPrepare(remote, { repository, ref, remoteCommit, manual, signal }) {
    const plan = engineState.planCheck({ remoteCommit, inUse, bundled, state, manual });
    if (plan.action === 'none') {
      return { reason: plan.reason, remoteCommittedAt: plan.reason === 'not-newer' ? state.lastCheck.remoteCommittedAt : null };
    }
    if (request && request.kind === 'update' && request.target.source.commit === remoteCommit) {
      return { reason: 'waiting', remoteCommittedAt: request.target.source.committedAt };
    }
    const info = await remote.getCommit(repository, remoteCommit);
    const source = { repository, ref, commit: remoteCommit, committedAt: info.committedAt };
    if (!engineState.isNewer(source, engineState.updateBaseline({ inUse, bundled }))) return { reason: 'not-newer', remoteCommittedAt: info.committedAt };
    setPhase('downloading');
    const base = inUse && inUse.manifest ? inUse : null;
    preparingCommit = remoteCommit; // kept by the cleanup until runCheck has recorded it
    const result = await runSerial(() => prepareEngine({ remote, source, enginesDir, base, signal, log: (line) => log.info(line) }));
    const prepared = {
      dir: result.dir,
      origin: 'downloaded',
      source: result.manifest.source,
      engineVersion: result.manifest.engineVersion,
      manifest: result.manifest,
      subject: engineState.commitSubject(info.message),
    };
    return { reason: 'new', remoteCommittedAt: info.committedAt, prepared };
  }

  // ----- activating ---------------------------------------------------------------------------

  function requestActivation(next) {
    if (stopped) return;
    if (request && request.kind === 'rollback' && next.kind === 'update') return; // the user's rollback wins
    request = next;
    if (!activationJobId) setPhase('waiting');
    tryActivate();
  }

  function scheduleTryActivate(ms) {
    clearTimer(graceTimer);
    graceTimer = setTimer(() => {
      graceTimer = null;
      tryActivate();
    }, ms);
  }

  function activeJob() {
    try {
      return deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
    } catch {
      return null;
    }
  }

  /**
   * Start the activation job when nothing else runs; otherwise the jobs listener calls this again.
   * Putting back the components of a stopped switch comes first: they must match the engine in use.
   */
  function tryActivate() {
    clearTimer(graceTimer);
    graceTimer = null;
    if ((!request && !componentsToRestore) || activationJobId || stopped) return;
    if (request && request.kind === 'update' && !request.manual && !autoEnabled()) {
      request = null;
      setPhase('idle');
      if (!componentsToRestore) return;
    }
    const jobs = deps.jobs;
    if (!jobs || typeof jobs.start !== 'function') {
      log.warn('The task manager is not available: the card maker engine cannot be switched.');
      return;
    }
    if (activeJob()) return;
    const current = componentsToRestore ? null : request;
    let jobId;
    try {
      jobId = current
        ? jobs.start('engine', { title: ACTIVATION_TITLES[current.kind], steps: ACTIVATION_STEPS.map((s) => ({ ...s })) },
          (ctx) => runActivation(ctx, current))
        : jobs.start('engine', { title: ACTIVATION_TITLES.restore, steps: ACTIVATION_STEPS.filter((s) => s.id === 'components').map((s) => ({ ...s })) },
          (ctx) => runRestore(ctx));
    } catch (err) {
      if (err && err.code === 'BUSY') return; // another job took the slot first: wait for it
      log.error('Could not start the engine job:', err);
      return;
    }
    if (current) request = null;
    else componentsToRestore = false;
    activationJobId = jobId;
    setPhase('activating');
  }

  function exclusive(fn) {
    return deps.locks && typeof deps.locks.withPythonExclusive === 'function' ? deps.locks.withPythonExclusive(fn) : fn();
  }

  /** An engine job is over: tell the window (the Python lock is released by now) and keep checking. */
  function activationEnded(change = null) {
    activationJobId = null;
    phase = request ? 'waiting' : 'idle';
    keepChecking();
    emitStatus(change);
  }

  /** Executor of the 'engine' job: switch to `target` (update or rollback), or put everything back. */
  async function runActivation(ctx, { kind, target }) {
    const from = inUse;
    let outcome = null;
    try {
      let wasReady = false;
      try {
        const envStatus = await moduleFor('python-env').checkEnv(deps, { refresh: true });
        wasReady = !!(envStatus && envStatus.ready);
      } catch (err) {
        ctx.log(`Could not check the card maker components: ${err.message}`, 'warn');
      }
      ctx.throwIfCancelled();
      outcome = await exclusive(() => switchEngine(ctx, { kind, from, to: target, wasReady }));
      return outcome.result;
    } finally {
      // Told only now, with the Python lock released, so the window can read the components and the
      // engine's options again as soon as it hears about the change.
      activationEnded(outcome ? outcome.change : null);
      if (outcome) void runSerial(cleanup);
    }
  }

  /**
   * Executor of the 'engine' job that follows a Stop clicked while a switch installed the new engine's
   * components: the stopped job can no longer run the installer, so the components of the engine in use
   * (the previous one, put back by restore) are installed again here, as after a failed update.
   */
  async function runRestore(ctx) {
    ctx.step('components', 'running', 'Putting the previous card maker components back');
    try {
      await exclusive(() => moduleFor('python-env').refreshForEngine(ctx, deps, { smokeTest: false, force: true }));
      ctx.step('components', 'done', 'The previous card maker components are back');
      return { engine: describeEngine(inUse), components: 'installed' };
    } catch (err) {
      const cancelled = !!(ctx.cancelled || (err && (err.code === 'CANCELLED' || err.name === 'CancelledError')));
      ctx.log(`The previous card maker components were not reinstalled${cancelled ? '' : `: ${err.message}`}. If something does not work, repair the components in Settings.`, cancelled ? 'warn' : 'error');
      throw err;
    } finally {
      activationEnded();
    }
  }

  /**
   * Point the app at `to` and check it works (inside the exclusive Python lock). On failure, `from` is
   * put back and the error is rethrown for the job.
   * @returns {Promise<{change: object, result: object}>}
   */
  async function switchEngine(ctx, { kind, from, to, wasReady }) {
    const workspace = moduleFor('workspace');
    const pythonEnv = moduleFor('python-env');
    const toInfo = describeEngine(to);
    ctx.log(`${kind === 'rollback' ? 'Going back to' : 'Switching to'} Silhouette Card Maker ${toInfo.engineVersion || ''} ${toInfo.shortCommit || ''} (${toInfo.committedAt || 'unknown date'}${to.subject ? `: ${to.subject}` : ''})`);
    let installStarted = false;
    let components = { state: 'not-set-up' };
    ctx.step('files', 'running', kind === 'rollback' ? 'Putting the previous card maker files back' : 'Switching to the new card maker files');
    setInUse(to);
    try {
      const ws = await workspace.ensureWorkspace(deps, (line) => ctx.log(line));
      ctx.step('files', 'done', ws && ws.updated ? 'Card maker files updated' : 'Card maker files ready');
      ctx.throwIfCancelled();
      if (wasReady) {
        ctx.step('components', 'running', 'Checking the card maker components');
        components = await pythonEnv.refreshForEngine(ctx, deps, { smokeTest: true, onInstall: () => { installStarted = true; } });
        await checkIntrospection(ctx);
        ctx.step('components', 'done', components.state === 'installed' ? 'Components updated, everything works' : 'Everything works');
      } else {
        ctx.log('The card maker components are not working yet: only the files were switched (Setup installs the components).');
        ctx.step('components', 'skipped', 'Set up later');
      }
    } catch (err) {
      await restore(ctx, { from, to, reinstall: installStarted });
      await afterFailure(ctx, { kind, to, err });
      throw failureError(kind, err);
    }
    await invalidateCaches(from, to);
    const next = kind === 'rollback'
      ? engineState.recordRollback(state, { from, to, at: now() })
      : engineState.recordActivation(state, { from, to });
    await saveState(next);
    const change = { kind: kind === 'rollback' ? 'rolledBack' : 'updated', from: describeEngine(from), to: describeEngine(to), subject: to.subject || null };
    log.info(`${change.kind === 'rolledBack' ? 'Rolled back' : 'Updated'} the card maker engine: ${change.from ? change.from.shortCommit : '?'} -> ${change.to.shortCommit} (components: ${components.state})`);
    return { change, result: { engine: change.to, previous: change.from, components: components.state } };
  }

  /**
   * Ask the engine now in use for the description of its options, as the window does right after the
   * switch. The test PDF does not import everything this does, so an engine that renamed something the
   * helper relies on would pass it and leave the app without its options. Runs inside the exclusive lock
   * (lock: false), with the same validity rule as helper.introspect.
   */
  async function checkIntrospection(ctx) {
    ctx.log('Reading the options of the card maker engine.');
    const data = await deps.helper.run('introspect', ['--engine-root', path.resolve(deps.getPaths().engineSourceDir)], {
      lock: false,
      signal: ctx.signal,
      onLine: (line) => ctx.log(line, 'stderr'),
    });
    if (!validIntrospection(data)) {
      throw userError('The card maker returned an incomplete description of its options.', { code: 'INTROSPECTION_INVALID' });
    }
  }

  async function restore(ctx, { from, to, reinstall }) {
    ctx.log('Putting the previous card maker engine back.', 'warn');
    setInUse(from);
    try {
      await moduleFor('workspace').ensureWorkspace(deps, (line) => ctx.log(line));
    } catch (err) {
      ctx.log(`Could not put the previous card maker files back: ${err.message}`, 'error');
    }
    if (reinstall) {
      if (ctx.cancelled && stopped) {
        ctx.log('The previous card maker components were not reinstalled because the app is closing. If something does not work, repair the components in Settings.', 'warn');
      } else if (ctx.cancelled) {
        // The user clicked Stop: this job can no longer run the installer, the next one does it.
        ctx.log('Stopped. The previous card maker components are put back right after.', 'warn');
        componentsToRestore = true;
      } else {
        try {
          await moduleFor('python-env').refreshForEngine(ctx, deps, { smokeTest: false, force: true });
        } catch (err) {
          ctx.log(`Could not reinstall the previous card maker components: ${err.message} Repair them in Settings if something does not work.`, 'error');
        }
      }
    }
    await invalidateCaches(to, from);
  }

  /** Remember why an update failed (unless it was circumstantial) and warn the user. */
  async function afterFailure(ctx, { kind, to, err }) {
    const cancelled = !!(ctx.cancelled || (err && (err.code === 'CANCELLED' || err.name === 'CancelledError')));
    if (cancelled) return;
    const message = err && err.message ? err.message : String(err);
    const transient = engineState.isTransientFailure(err);
    if (kind === 'update' && !transient && to.source) {
      await saveState(engineState.recordRejection(state, to.source.commit, { reason: message, code: err && err.code ? String(err.code) : null, at: now() }));
    }
    log.warn(`The engine ${kind} failed${transient ? ' (will try again later)' : ''}:`, err);
    emit('app:notice', {
      variant: 'warning',
      title: kind === 'rollback' ? 'The card maker engine could not be rolled back' : 'The card maker engine update was undone',
      message: kind === 'rollback'
        ? `The current engine is still in use. ${message}`
        : `The new version did not work, so Kirigami kept the one you had. ${message}${transient ? ' Kirigami will try again later.' : ''}`,
      timeout: 15000,
    });
  }

  function failureError(kind, err) {
    if (err && (err.code === 'CANCELLED' || err.name === 'CancelledError')) return err;
    const what = kind === 'rollback' ? 'Could not roll back the card maker engine' : 'The new card maker engine did not work, so the previous one was put back';
    return userError(`${what}: ${err && err.message ? err.message : err}`, {
      code: err && err.code ? String(err.code) : 'ENGINE_UPDATE_FAILED',
      details: err && (err.details || err.stack) ? String(err.details || err.stack) : '',
      cause: err,
    });
  }

  /** Forget everything derived from the engine (the helper's introspection, statuses, card sizes, sheets). */
  async function invalidateCaches(from, to) {
    let paths;
    try {
      paths = deps.getPaths();
    } catch (err) {
      log.warn('Could not compute the app folders:', err);
      return;
    }
    try {
      if (deps.helper && typeof deps.helper.invalidate === 'function') deps.helper.invalidate();
    } catch (err) {
      log.warn('Could not reset the introspection cache:', err);
    }
    await fsp.rm(path.join(paths.scmCacheDir, 'introspection.json'), { force: true }).catch(() => {});
    for (const [name, fn] of [['python-env', 'invalidateEnvCache'], ['upscayl', 'invalidateCardDims']]) {
      try {
        const mod = moduleFor(name);
        if (typeof mod[fn] === 'function') mod[fn](deps);
      } catch (err) {
        log.warn(`Could not reset a cache (${name}.${fn}):`, err);
      }
    }
    const fromFiles = from && from.manifest ? from.manifest.files : null;
    const toFiles = to && to.manifest ? to.manifest.files : null;
    if (engineState.calibrationAffected(fromFiles, toFiles)) {
      const generated = path.join(paths.calibrationCacheDir || path.join(paths.scmCacheDir, 'calibration'), 'calibration');
      await fsp.rm(generated, { recursive: true, force: true, maxRetries: 3 }).catch((err) => log.warn('Could not remove the generated calibration sheets:', err));
    }
  }

  // ----- rollback and cleanup -----------------------------------------------------------------

  /**
   * Go back to the previous engine (step 5) through the activation job.
   * @returns {Promise<object>} status()
   */
  async function rollback() {
    if (mode !== 'managed') throw userError(DISABLED_MESSAGES.linked, { code: 'ENGINE_UPDATES_OFF' });
    if (activationJobId) {
      const err = userError('BUSY: wait until the card maker engine update finishes', { code: 'BUSY' });
      throw err;
    }
    if (request && request.kind === 'rollback') return status();
    const target = engineState.rollbackTarget(state, { inUse, bundled });
    if (!target) throw userError('There is no earlier card maker engine to go back to.', { code: 'NO_ROLLBACK' });
    const record = target.origin === 'bundled'
      ? bundled
      : await readEngine(path.join(enginesDir, target.commit), 'downloaded', { expectCommit: target.commit, verify: 'deep', allowEditedDocuments: true });
    if (!record) throw userError('The earlier card maker engine is no longer on this computer, so Kirigami cannot go back to it.', { code: 'NO_ROLLBACK' });
    if (checkAbort) checkAbort.abort(); // the user wants to go back: stop a download in progress
    request = null;
    requestActivation({ kind: 'rollback', target: { ...record, subject: target.subject || record.subject }, manual: true });
    return status();
  }

  /** Delete downloaded engines nothing refers to and staging folders left by interrupted downloads. */
  async function cleanup() {
    if (!enginesDir || mode !== 'managed') return;
    let names;
    try {
      names = await fsp.readdir(enginesDir);
    } catch {
      return;
    }
    const keep = engineState.enginesToKeep({ state, inUse, pending: request ? request.target : null });
    if (preparingCommit) keep.add(preparingCommit);
    for (const name of engineState.planCleanup(names, { keep, preparing: preparingCommit })) {
      try {
        await fsp.rm(path.join(enginesDir, name), { recursive: true, force: true, maxRetries: 3 });
        log.info(`Removed the old card maker engine folder ${name}`);
      } catch (err) {
        log.warn(`Could not remove ${name} (will try again later):`, err);
      }
    }
  }

  return {
    init,
    start,
    stop,
    status,
    checkNow,
    rollback,
    /** Resolves once the running check and the queued disk work (preparing, cleaning up) are done. */
    async idle() {
      while (checking) await checking.catch(() => {});
      await serial;
    },
  };
}

module.exports = {
  createEngineUpdater,
  prepareEngine,
  readEngineDir,
  describeEngine,
  STATE_FILE,
  ACTIVATION_TITLES,
};
