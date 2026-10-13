'use strict';

/**
 * engine-state.js — the decisions of the runtime engine updater as pure functions: which engine to use
 * at startup, what a check should do with the commit GitHub reports, how state.json changes after an
 * update, a rollback or a failure, when to check next, and which downloaded engines can be deleted.
 * No I/O, no Electron and no clock (`now` is always passed in), so every rule is unit-tested;
 * engine-updater.js does the file system, network and job work around them.
 *
 * Vocabulary
 * - engine record: one usable copy of the engine, `{ dir, origin, source, engineVersion, manifest }` where
 *   origin is 'bundled' (shipped with the app), 'downloaded' (<dataDir>/engines/<commit>) or 'linked'
 *   (SCM_ENGINE_DIR), and source is the manifest's `{ repository, ref, commit, committedAt }`.
 * - state.json (<dataDir>/engines/state.json, format 1). It lives outside the settings on purpose:
 *   "Reset all settings" must never switch engines.
 *     {
 *       format: 1,
 *       active:   { commit, committedAt, subject, rolledBackFrom? } | null   downloaded engine to use (null = bundled)
 *       previous: { commit, committedAt, subject, origin } | null      what "Roll back" returns to
 *       rejected: { <commit>: { reason, code, at } }                   never installed again automatically
 *       lastCheck: { at, ok, remoteCommit, remoteCommittedAt, error: { code, message, resetAt } | null } | null
 *     }
 *   `remoteCommittedAt` remembers the date of a commit found not to be newer than the engine in use, so the
 *   next hourly checks of that same commit cost no GitHub API call.
 *   `active.rolledBackFrom` ({ commit, committedAt }, only present when set) records that the user rolled
 *   back to that downloaded engine, and which engine they left (see the ordering rule).
 *
 * Ordering rule: engines are compared by commit date (`committedAt`). A downloaded engine is only used
 * when it comes from the same repository as the bundled one and is strictly newer, so installing a newer
 * Kirigami (which bundles a newer engine) always wins over an older download. One exception keeps "Roll
 * back" true to its word: a download the user rolled back to stays in use even when the bundled engine is
 * newer, until an engine newer than the one they left arrives (with a Kirigami update, or from GitHub).
 * Without it, going back to an older download after a Kirigami update would quietly be undone at the next
 * start, and its folder deleted.
 */

const STATE_FORMAT = 1;
/** First check after startup (the window is up and the workspace ready by then). */
const FIRST_CHECK_DELAY_MS = 60 * 1000;
/** Time between two checks while the app is running. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** First retry after a failed check; doubles with every failure in a row, up to CHECK_INTERVAL_MS. */
const RETRY_BASE_MS = 5 * 60 * 1000;
/** Extra wait after GitHub's rate-limit reset time, and the shortest wait after a limit. */
const RATE_LIMIT_MARGIN_MS = 30 * 1000;
const MIN_RETRY_MS = 60 * 1000;
/** Rejected commits remembered (the newest ones). */
const MAX_REJECTED = 20;
const MAX_TEXT = 500;

/** Rejection code of a commit the user rolled back from (a manual check does not retry it). */
const ROLLED_BACK = 'ROLLED_BACK';

/**
 * Failures that say nothing about the engine itself (no network, disk full, a file locked by an
 * antivirus, the app quitting, a Python that does not start, a workspace folder that is gone or
 * read-only…): the update is undone and simply tried again at a later check.
 * Any other failure (requirements that cannot be installed, a smoke test that fails…) rejects the commit.
 */
const TRANSIENT_CODES = Object.freeze([
  'CANCELLED', 'NETWORK', 'DISK_FULL', 'ACCESS_DENIED', 'WORKSPACE_WRITE_FAILED', 'TIMEOUT', 'BUSY',
  'PYTHON_SETUP', 'PYTHON_BUSY', 'START_FAILED', 'START_BLOCKED', 'RATE_LIMITED', 'HTTP_ERROR', 'BAD_RESPONSE',
  // the computer, not the engine (reported by helper.js, workspace.js and python-env.js)
  'BLOCKED', 'PYTHON_START_FAILED', 'NOT_INSTALLED', 'HELPER_MISSING', 'UV_MISSING', 'FILE_LOCKED',
  'WORKSPACE_INVALID', 'WORKSPACE_NOT_WRITABLE', 'ENGINE_NOT_FOUND',
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const PARTIAL_RE = /^([0-9a-f]{40})\.partial(?:-[\w.-]+)?$/;

function isSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

function isIsoDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));
}

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {string|null|undefined} sha @returns {string} the 7-character form used in messages */
function shortCommit(sha) {
  return typeof sha === 'string' ? sha.slice(0, 7) : '';
}

/**
 * First line of a commit message (what the "engine updated" toast shows), or null.
 * @param {string|null|undefined} message
 * @returns {string|null}
 */
function commitSubject(message) {
  return text(String(message || '').split(/\r?\n/)[0], 200);
}

/** @returns {{format:number, active:null, previous:null, rejected:object, lastCheck:null}} */
function emptyState() {
  return { format: STATE_FORMAT, active: null, previous: null, rejected: {}, lastCheck: null };
}

function normalizeCommitRef(value, { withOrigin = false, withRollback = false } = {}) {
  if (!value || typeof value !== 'object' || !isSha(value.commit) || !isIsoDate(value.committedAt)) return null;
  const ref = { commit: value.commit, committedAt: value.committedAt, subject: text(value.subject, 200) };
  const left = withRollback ? value.rolledBackFrom : null;
  if (left && typeof left === 'object' && isSha(left.commit) && isIsoDate(left.committedAt)) {
    ref.rolledBackFrom = { commit: left.commit, committedAt: left.committedAt };
  }
  if (!withOrigin) return ref;
  if (value.origin !== 'bundled' && value.origin !== 'downloaded') return null;
  return { ...ref, origin: value.origin };
}

function normalizeRejected(value) {
  const entries = [];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [commit, entry] of Object.entries(value)) {
      if (!isSha(commit) || !entry || typeof entry !== 'object') continue;
      const at = finiteOrNull(entry.at);
      if (at === null) continue;
      entries.push([commit, { reason: text(entry.reason) || 'This version did not work.', code: text(entry.code, 60), at }]);
    }
  }
  entries.sort((a, b) => b[1].at - a[1].at);
  return Object.fromEntries(entries.slice(0, MAX_REJECTED));
}

function normalizeError(value) {
  if (!value || typeof value !== 'object') return null;
  return { code: text(value.code, 60), message: text(value.message) || 'The check did not work.', resetAt: finiteOrNull(value.resetAt) };
}

function normalizeLastCheck(value) {
  if (!value || typeof value !== 'object') return null;
  const at = finiteOrNull(value.at);
  if (at === null) return null;
  const ok = value.ok === true;
  return {
    at,
    ok,
    remoteCommit: isSha(value.remoteCommit) ? value.remoteCommit : null,
    remoteCommittedAt: isIsoDate(value.remoteCommittedAt) ? value.remoteCommittedAt : null,
    error: ok ? null : normalizeError(value.error) || { code: null, message: 'The check did not work.', resetAt: null },
  };
}

/**
 * A clean state from whatever state.json contained (an unknown format or damaged fields are dropped,
 * never trusted).
 * @param {unknown} raw parsed JSON
 * @returns {object}
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.format !== STATE_FORMAT) return emptyState();
  return {
    format: STATE_FORMAT,
    active: normalizeCommitRef(raw.active, { withRollback: true }),
    previous: normalizeCommitRef(raw.previous, { withOrigin: true }),
    rejected: normalizeRejected(raw.rejected),
    lastCheck: normalizeLastCheck(raw.lastCheck),
  };
}

/**
 * state.json text (2-space JSON, trailing newline).
 * @param {object} state
 * @returns {string}
 */
function serializeState(state) {
  return `${JSON.stringify(normalizeState(state), null, 2)}\n`;
}

function sameRepository(a, b) {
  return !!(a && b && String(a.repository).toLowerCase() === String(b.repository).toLowerCase());
}

/**
 * Is `candidate` strictly newer than `current` (commit dates)? Anything is newer than an unknown engine.
 * @param {{committedAt:string}|null|undefined} candidate
 * @param {{committedAt:string}|null|undefined} current
 * @returns {boolean}
 */
function isNewer(candidate, current) {
  if (!candidate || !isIsoDate(candidate.committedAt)) return false;
  if (!current || !isIsoDate(current.committedAt)) return true;
  return Date.parse(candidate.committedAt) > Date.parse(current.committedAt);
}

/**
 * The engine to use at startup: the newest of the bundled engine and the downloaded one recorded as active
 * (the caller passes it only when its folder and manifest checked out). Same commit ⇒ the bundled copy;
 * another repository, an older or an equally old download ⇒ the bundled engine, except a download the
 * user rolled back to, which stays as long as the bundled engine is not newer than the engine they left.
 * @param {{bundled: object|null, downloaded: object|null, rolledBackFrom?: {committedAt: string}|null}} input
 *   engine records, and state.active.rolledBackFrom
 * @returns {object|null}
 */
function chooseActiveEngine({ bundled = null, downloaded = null, rolledBackFrom = null } = {}) {
  if (!downloaded || !downloaded.source) return bundled;
  if (!bundled || !bundled.source) return downloaded;
  if (!sameRepository(bundled.source, downloaded.source)) return bundled;
  if (bundled.source.commit === downloaded.source.commit) return bundled;
  if (isNewer(downloaded.source, bundled.source)) return downloaded;
  return rolledBackFrom && !isNewer(bundled.source, rolledBackFrom) ? downloaded : bundled;
}

/**
 * What a newer commit has to beat: the engine in use, or the bundled engine when that one is newer (only
 * after a rollback to an older download). A commit between the two would lose to the bundled engine at
 * the next start, so it is not worth installing.
 * @param {{inUse: object|null, bundled?: object|null}} engines
 * @returns {{committedAt: string}|null} the source to compare with
 */
function updateBaseline({ inUse, bundled = null }) {
  const current = inUse && inUse.source ? inUse.source : null;
  const shipped = bundled && bundled.source ? bundled.source : null;
  if (current && shipped && sameRepository(shipped, current) && isNewer(shipped, current)) return shipped;
  return current;
}

/**
 * Bring state.json in line with the engine chosen at startup: an `active` that lost to the bundled engine
 * (a newer app was installed, or its folder was damaged) is forgotten, and a `previous` that can no longer
 * be returned to (gone, or the bundled engine it named was replaced) is dropped.
 * @param {object} state normalized
 * @param {{inUse: object|null, bundled: object|null, previousAvailable: boolean}} input
 * @returns {{state: object, changed: boolean}}
 */
function reconcileState(state, { inUse, bundled, previousAvailable }) {
  let { active, previous } = state;
  if (!inUse || inUse.origin !== 'downloaded') active = null;
  else if (!active || active.commit !== inUse.source.commit) {
    active = { commit: inUse.source.commit, committedAt: inUse.source.committedAt, subject: active && active.commit === inUse.source.commit ? active.subject : null };
  }
  if (previous) {
    const inUseCommit = inUse && inUse.source ? inUse.source.commit : null;
    const bundledCommit = bundled && bundled.source ? bundled.source.commit : null;
    if (!previousAvailable || previous.commit === inUseCommit || (previous.origin === 'bundled' && previous.commit !== bundledCommit)) previous = null;
  }
  const changed = JSON.stringify(active) !== JSON.stringify(state.active) || JSON.stringify(previous) !== JSON.stringify(state.previous);
  return { state: changed ? { ...state, active, previous } : state, changed };
}

/**
 * Why updates are off, or null when the updater may check. Linked mode (SCM_ENGINE_DIR) runs a checkout as
 * it is; tests (SCM_E2E) must not depend on GitHub; SCM_ENGINE_UPDATES=0 is the switch for everyone else.
 * The `updates.engineAuto` setting is not a reason: it only stops the automatic checks.
 * @param {{engineMode: string, isTest?: boolean, env?: object}} input
 * @returns {'linked'|'test'|'env'|null}
 */
function updatesDisabledReason({ engineMode, isTest = false, env = {} }) {
  if (engineMode === 'linked') return 'linked';
  if (isTest) return 'test';
  const flag = env && typeof env.SCM_ENGINE_UPDATES === 'string' ? env.SCM_ENGINE_UPDATES.trim().toLowerCase() : '';
  if (['0', 'false', 'off', 'no'].includes(flag)) return 'env';
  return null;
}

/**
 * What a check does with the commit at the tip of the followed branch (decided without any REST call):
 * - 'up-to-date': the engine in use is that commit;
 * - 'rejected': it failed before (or the user rolled back from it). A manual check retries failures, but
 *   never a commit the user rolled back from;
 * - 'not-newer': an earlier check found it is not newer than the engine in use (see updateBaseline);
 * - 'prepare': it is new: read its date, then download it if it is newer.
 * @param {{remoteCommit: string, inUse: object|null, bundled?: object|null, state: object, manual?: boolean}} input
 * @returns {{action: 'none'|'prepare', reason: 'up-to-date'|'rejected'|'not-newer'|'new'}}
 */
function planCheck({ remoteCommit, inUse, bundled = null, state, manual = false }) {
  const current = inUse && inUse.source ? inUse.source : null;
  if (current && current.commit === remoteCommit) return { action: 'none', reason: 'up-to-date' };
  const rejection = state.rejected[remoteCommit];
  if (rejection && (!manual || rejection.code === ROLLED_BACK)) return { action: 'none', reason: 'rejected' };
  const last = state.lastCheck;
  const baseline = updateBaseline({ inUse, bundled });
  if (last && last.remoteCommit === remoteCommit && last.remoteCommittedAt && baseline && !isNewer({ committedAt: last.remoteCommittedAt }, baseline)) {
    return { action: 'none', reason: 'not-newer' };
  }
  return { action: 'prepare', reason: 'new' };
}

/**
 * Is this activation failure about the circumstances (try again later) rather than the engine?
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransientFailure(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'CancelledError') return true;
  return typeof err.code === 'string' && TRANSIENT_CODES.includes(err.code);
}

function commitRef(record) {
  const source = record && record.source;
  if (!source || !isSha(source.commit)) return null;
  return { commit: source.commit, committedAt: source.committedAt, subject: text(record.subject, 200) };
}

/**
 * State after a check.
 * @param {object} state
 * @param {{at:number, ok:boolean, remoteCommit?:string|null, remoteCommittedAt?:string|null, error?:object|null}} check
 * @returns {object}
 */
function recordCheck(state, check) {
  return { ...state, lastCheck: normalizeLastCheck(check) };
}

/**
 * State after `to` was activated in place of `from` by an update: `to` becomes active (null when it is
 * the bundled engine), `from` the rollback target, and a former rejection of `to` is forgotten.
 * @param {object} state
 * @param {{from: object|null, to: object}} change engine records (+ optional subject)
 * @returns {object}
 */
function recordActivation(state, { from, to }) {
  const rejected = { ...state.rejected };
  const toRef = commitRef(to);
  if (toRef) delete rejected[toRef.commit];
  const fromRef = commitRef(from);
  const previous = fromRef && (!toRef || fromRef.commit !== toRef.commit) && (from.origin === 'bundled' || from.origin === 'downloaded')
    ? { ...fromRef, origin: from.origin }
    : null;
  return { ...state, active: to.origin === 'downloaded' ? toRef : null, previous, rejected };
}

/**
 * State after a commit failed to activate (or was rolled back by the user): it is not installed
 * automatically again. Only the newest MAX_REJECTED rejections are kept.
 * @param {object} state
 * @param {string} commit
 * @param {{reason:string, code?:string|null, at:number}} rejection
 * @returns {object}
 */
function recordRejection(state, commit, { reason, code = null, at }) {
  if (!isSha(commit)) return state;
  return { ...state, rejected: normalizeRejected({ ...state.rejected, [commit]: { reason, code, at } }) };
}

/**
 * State after "Roll back": `to` (the former previous) is in use again, there is nothing left to roll back
 * to, and the commit rolled back from is rejected so the next automatic check does not reinstall it. A
 * downloaded `to` remembers the engine left (`rolledBackFrom`), so the next start keeps it even when the
 * bundled engine is newer (see chooseActiveEngine).
 * @param {object} state
 * @param {{from: object, to: object, at: number}} change
 * @returns {object}
 */
function recordRollback(state, { from, to, at }) {
  const fromRef = commitRef(from);
  let active = to.origin === 'downloaded' ? commitRef(to) : null;
  if (active && fromRef && isIsoDate(fromRef.committedAt)) {
    active = { ...active, rolledBackFrom: { commit: fromRef.commit, committedAt: fromRef.committedAt } };
  }
  const next = { ...state, active, previous: null };
  return fromRef ? recordRejection(next, fromRef.commit, { reason: 'You rolled back from this version.', code: ROLLED_BACK, at }) : next;
}

/**
 * Where "Roll back" goes, or null when it is not possible: the previous engine, when it is not the one in
 * use and, for the bundled engine, when the app still bundles that same commit.
 * @param {object} state
 * @param {{inUse: object|null, bundled: object|null}} engines
 * @returns {{origin: 'bundled'|'downloaded', commit: string, committedAt: string, subject: string|null}|null}
 */
function rollbackTarget(state, { inUse, bundled }) {
  const previous = state.previous;
  if (!previous) return null;
  if (inUse && inUse.source && inUse.source.commit === previous.commit) return null;
  if (previous.origin === 'bundled' && !(bundled && bundled.source && bundled.source.commit === previous.commit)) return null;
  return previous;
}

/**
 * Delay before the first check of this run: FIRST_CHECK_DELAY_MS, or later when GitHub asked to wait
 * (a rate limit recorded by an earlier run that has not reset yet).
 * @param {{now:number, state:object}} input
 * @returns {number} milliseconds
 */
function initialCheckDelay({ now, state }) {
  const error = state.lastCheck && state.lastCheck.error;
  if (error && error.code === 'RATE_LIMITED' && error.resetAt && error.resetAt > now) {
    return Math.max(FIRST_CHECK_DELAY_MS, error.resetAt - now + RATE_LIMIT_MARGIN_MS);
  }
  return FIRST_CHECK_DELAY_MS;
}

/**
 * Delay before the next check: the regular interval after a success; until GitHub's reset time (plus a
 * margin) after a rate limit; otherwise a backoff that doubles with each failure in a row, starting at
 * RETRY_BASE_MS and never longer than the regular interval.
 * @param {{now:number, ok:boolean, error?:{code?:string|null, resetAt?:number|null}|null, failures?:number}} input
 * @returns {number} milliseconds
 */
function delayAfterCheck({ now, ok, error = null, failures = 1 }) {
  if (ok) return CHECK_INTERVAL_MS;
  if (error && error.code === 'RATE_LIMITED' && Number.isFinite(error.resetAt)) {
    return Math.max(MIN_RETRY_MS, error.resetAt - now + RATE_LIMIT_MARGIN_MS);
  }
  const n = Math.max(1, Math.floor(Number(failures) || 1));
  return Math.min(CHECK_INTERVAL_MS, RETRY_BASE_MS * 2 ** Math.min(n - 1, 16));
}

/**
 * Commits whose downloaded folders must stay: the engine in use, the recorded active and previous
 * engines, one prepared but not yet activated, and the commit the last check found (unless rejected), so
 * an update prepared just before the app closed is not downloaded again.
 * @param {{state: object, inUse?: object|null, pending?: object|null}} input
 * @returns {Set<string>}
 */
function enginesToKeep({ state, inUse = null, pending = null }) {
  const keep = new Set();
  const add = (commit) => { if (isSha(commit)) keep.add(commit); };
  if (inUse && inUse.origin === 'downloaded' && inUse.source) add(inUse.source.commit);
  if (state.active) add(state.active.commit);
  if (state.previous && state.previous.origin === 'downloaded') add(state.previous.commit);
  if (pending && pending.source) add(pending.source.commit);
  const found = state.lastCheck && state.lastCheck.remoteCommit;
  if (found && !state.rejected[found]) add(found);
  return keep;
}

/**
 * Entries of <dataDir>/engines to delete: engine folders (40-hex names) not kept, and staging folders
 * (`<commit>.partial…`) left by an interrupted download unless one is being written now. Anything else
 * (state.json, unknown files) is never touched.
 * @param {string[]} names entry names
 * @param {{keep: Set<string>, preparing?: string|null}} input
 * @returns {string[]}
 */
function planCleanup(names, { keep, preparing = null }) {
  return names.filter((name) => {
    if (isSha(name)) return !keep.has(name);
    const partial = PARTIAL_RE.exec(name);
    return !!partial && partial[1] !== preparing;
  }).sort();
}

/**
 * Do the generated calibration sheets (scm-cache/calibration) need to be made again with the new engine?
 * They come from generate_calibration.py, the root modules it imports and the layouts in assets/, so any
 * change there (compared by git blob SHA-1) invalidates them.
 * @param {Array<{path:string, blob:string}>|null|undefined} fromFiles manifest files of the old engine
 * @param {Array<{path:string, blob:string}>|null|undefined} toFiles manifest files of the new engine
 * @returns {boolean}
 */
function calibrationAffected(fromFiles, toFiles) {
  if (!Array.isArray(fromFiles) || !Array.isArray(toFiles)) return true;
  const relevant = (p) => (!p.includes('/') && p.endsWith('.py')) || p.startsWith('assets/');
  const pick = (files) => new Map(files.filter((f) => relevant(f.path)).map((f) => [f.path, f.blob]));
  const a = pick(fromFiles);
  const b = pick(toFiles);
  if (a.size !== b.size) return true;
  for (const [p, blob] of a) if (b.get(p) !== blob) return true;
  return false;
}

module.exports = {
  STATE_FORMAT,
  FIRST_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  RETRY_BASE_MS,
  RATE_LIMIT_MARGIN_MS,
  MIN_RETRY_MS,
  MAX_REJECTED,
  ROLLED_BACK,
  TRANSIENT_CODES,
  shortCommit,
  commitSubject,
  emptyState,
  normalizeState,
  serializeState,
  isNewer,
  chooseActiveEngine,
  updateBaseline,
  reconcileState,
  updatesDisabledReason,
  planCheck,
  isTransientFailure,
  recordCheck,
  recordActivation,
  recordRejection,
  recordRollback,
  rollbackTarget,
  initialCheckDelay,
  delayAfterCheck,
  enginesToKeep,
  planCleanup,
  calibrationAffected,
};
