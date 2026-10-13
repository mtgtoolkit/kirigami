'use strict';

/**
 * The decisions behind Kirigami's own updates, as pure functions (no Electron, no electron-updater),
 * so they can be unit-tested with `node --test`. `app-updater.js` wires them to electron-updater.
 *
 * - Mode: only an installed copy updates itself (`auto`). A copy running from source, an automated
 *   test run (`SCM_E2E`) or `SCM_APP_UPDATES=0` never touches the network for app updates
 *   (`disabled`). So does an unpacked test build (`npm run pack`): electron-builder writes
 *   `resources/app-update.yml` only for the NSIS installer, and installing an update would not
 *   replace that folder anyway. `SCM_APP_UPDATES=dev` in a copy running from source is a rehearsal:
 *   it checks and downloads from `dev-app-update.yml` like the installed app, but never installs.
 * - State: one plain object (sent to the window as is) moved forward by `reduceUpdateState()`, so
 *   every transition (checking, downloading, ready, failed) is a tested table instead of flags spread
 *   over event handlers. A newer version found while another one is ready replaces it; the same
 *   version found again keeps the ready state (a periodic check must not make the button flicker).
 * - Schedule: the first check comes a few seconds after the app is ready, then every 4 hours while
 *   it runs; after a failure (offline laptop) it tries again after 30 minutes instead of 4 hours. A
 *   check that gets no answer, or a download that stops receiving data, counts as such a failure
 *   after a few minutes instead of blocking every later check.
 * - Install gating: "Restart to update" is refused while a task runs. electron-updater launches the
 *   installer *before* asking the app to quit, so letting the quit be cancelled ("Keep working") would
 *   leave an installer killing a busy app; refusing up front is the only safe order.
 * - Errors: electron-updater's messages are technical (and some embed a whole XML feed), so they are
 *   turned into one plain sentence. "No release published yet" is not an error: there is simply
 *   nothing newer.
 */

/** Kirigami's GitHub repository; must match package.json build.publish (asserted by a unit test). */
const APP_REPOSITORY = Object.freeze({ owner: 'mtgtoolkit', repo: 'kirigami' });
const RELEASES_URL = `https://github.com/${APP_REPOSITORY.owner}/${APP_REPOSITORY.repo}/releases`;

const UPDATE_MODES = Object.freeze(['disabled', 'rehearsal', 'auto']);
/** Where the update stands. `checking` is a separate flag: a check can run while an update is ready. */
const UPDATE_PHASES = Object.freeze(['idle', 'up-to-date', 'downloading', 'ready', 'error']);

const FIRST_CHECK_DELAY_MS = 10 * 1000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 30 * 60 * 1000;
/**
 * electron-updater's requests have no working timeout under Electron (its timer waits for a
 * 'socket' event that Electron's net module never sends), so a stalled connection would leave a
 * check or a download running forever. A check (three small requests) that takes longer than this
 * has failed; a download that received nothing for this long is stopped. Either way the next try
 * comes after the usual retry delay.
 */
const CHECK_TIMEOUT_MS = 2 * 60 * 1000;
const DOWNLOAD_STALL_MS = 5 * 60 * 1000;

/** Release notes kept in the state (they travel to the window with every change). */
const MAX_NOTES_CHARS = 4000;
/** Technical detail kept in a fallback error sentence. */
const MAX_DETAIL_CHARS = 200;

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Sentences for the failures this module's caller detects itself (electron-updater's own errors go through `updateErrorMessage()`). */
const UPDATE_MESSAGES = Object.freeze({
  checkTimeout: 'GitHub did not answer in time. Kirigami tries again later.',
  downloadStalled: `The download stopped: nothing arrived from GitHub for ${DOWNLOAD_STALL_MS / 60000} minutes. Kirigami tries again later.`,
});

/** Why this copy does not update itself, per `updateMode()` reason (shown in Settings > Updates). */
const DISABLED_MESSAGES = Object.freeze({
  source: 'This copy runs from source code, so it does not update itself. Installed copies of Kirigami do.',
  test: 'Updates are off while automated tests run.',
  env: 'Updates are turned off on this computer (SCM_APP_UPDATES=0).',
  unpacked: 'This test build was not made by the Kirigami installer, so it does not update itself. Installed copies of Kirigami do.',
});

// ---------------------------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------------------------

/**
 * Decide whether this copy of the app updates itself.
 * @param {{ packaged: boolean, updateConfig?: boolean, isTest?: boolean, env?: Record<string, string|undefined> }} input
 *   updateConfig: `resources/app-update.yml` exists (installer builds only)
 * @returns {{ mode: 'disabled'|'rehearsal'|'auto', reason: 'test'|'env'|'source'|'unpacked'|null }}
 */
function updateMode({ packaged, updateConfig = true, isTest = false, env = {} } = {}) {
  const flag = String((env && env.SCM_APP_UPDATES) || '').trim().toLowerCase();
  if (isTest) return { mode: 'disabled', reason: 'test' };
  if (OFF_VALUES.has(flag)) return { mode: 'disabled', reason: 'env' };
  if (!packaged) return flag === 'dev' ? { mode: 'rehearsal', reason: null } : { mode: 'disabled', reason: 'source' };
  if (!updateConfig) return { mode: 'disabled', reason: 'unpacked' };
  return { mode: 'auto', reason: null };
}

/**
 * True when the NSIS installer started this process after an update (it passes `--updated`).
 * @param {string[]} argv
 * @returns {boolean}
 */
function launchedByUpdater(argv) {
  return Array.isArray(argv) && argv.includes('--updated');
}

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

/**
 * Parse `1.2.3`, `v1.2.3` or `1.2.3-beta.1` (build metadata after `+` is ignored, as in semver).
 * @param {unknown} raw
 * @returns {{ numbers: number[], pre: Array<number|string> }|null} null when it is not a version
 */
function parseVersion(raw) {
  if (typeof raw !== 'string') return null;
  const match = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/i.exec(raw.trim());
  if (!match) return null;
  const numbers = match[1].split('.').map(Number);
  if (numbers.some((n) => !Number.isSafeInteger(n))) return null;
  const pre = match[2] ? match[2].split('.').map((id) => (/^\d+$/.test(id) ? Number(id) : id)) : [];
  return { numbers, pre };
}

/**
 * Compare two versions numerically, segment by segment (`0.10.0` is newer than `0.9.0`, which a
 * string comparison gets backwards); a pre-release is older than its release (semver rules).
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1|null} null when either is not a version
 */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  const length = Math.max(x.numbers.length, y.numbers.length);
  for (let i = 0; i < length; i += 1) {
    const left = x.numbers[i] || 0;
    const right = y.numbers[i] || 0;
    if (left !== right) return left > right ? 1 : -1;
  }
  if (!x.pre.length || !y.pre.length) {
    if (x.pre.length === y.pre.length) return 0;
    return x.pre.length ? -1 : 1;
  }
  const count = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < count; i += 1) {
    const left = x.pre[i];
    const right = y.pre[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const leftNumber = typeof left === 'number';
    const rightNumber = typeof right === 'number';
    if (leftNumber && rightNumber) return left > right ? 1 : -1;
    if (leftNumber !== rightNumber) return leftNumber ? -1 : 1;
    return left > right ? 1 : -1;
  }
  return 0;
}

/**
 * Whether `candidate` is a later version than `current`. Anything unparseable is never newer, so a
 * malformed release can never trigger an update.
 * @param {string} candidate
 * @param {string} current
 * @returns {boolean}
 */
function isNewerVersion(candidate, current) {
  return compareVersions(candidate, current) === 1;
}

// ---------------------------------------------------------------------------------------------
// Release information
// ---------------------------------------------------------------------------------------------

/**
 * Release notes as plain text. GitHub's releases feed delivers HTML, which the window must never
 * inject; a Markdown/HTML library would be a runtime dependency for decoration. Structure first,
 * then tags, then entities (stripping tags first would lose the line breaks).
 * @param {unknown} html
 * @returns {string}
 */
function notesToText(html) {
  if (typeof html !== 'string' || !html) return '';
  const withBreaks = html
    .replace(/<\s*(br|hr)\s*\/?>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n• ')
    .replace(/<\s*\/\s*(p|div|h[1-6]|li|ul|ol|tr|pre|blockquote)\s*>/gi, '\n')
    .replace(/<\s*(p|div|h[1-6]|pre|blockquote)[^>]*>/gi, '\n');
  const decoded = withBreaks
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (whole, code) => codePoint(Number(code), whole))
    .replace(/&#x([0-9a-f]+);/gi, (whole, code) => codePoint(parseInt(code, 16), whole))
    // Ampersand last, or an escaped entity such as &amp;lt; would be decoded twice.
    .replace(/&amp;/gi, '&');
  return decoded
    // Each </li> ends a line and each <li> starts one: without this a list comes out double-spaced.
    .replace(/\n{2,}(?=• )/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line, index, all) => line.length > 0 || (index > 0 && all[index - 1].length > 0))
    .join('\n')
    .trim();
}

function codePoint(n, fallback) {
  try {
    return Number.isInteger(n) && n > 0 ? String.fromCodePoint(n) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The GitHub release page of a version (tags are `v<version>`, as electron-builder publishes them).
 * @param {string} version
 * @param {string} [tag] the tag reported by the feed, when known
 * @returns {string}
 */
function releaseUrl(version, tag) {
  const safeTag = typeof tag === 'string' && /^[\w.+-]{1,100}$/.test(tag) ? tag : null;
  if (safeTag) return `${RELEASES_URL}/tag/${encodeURIComponent(safeTag)}`;
  return parseVersion(version) ? `${RELEASES_URL}/tag/v${version.trim().replace(/^v/i, '')}` : RELEASES_URL;
}

/**
 * The parts of electron-updater's UpdateInfo the window needs, as a small plain object.
 * @param {object|null|undefined} info UpdateInfo / UpdateDownloadedEvent
 * @returns {{ version: string, releaseName: string|null, releaseDate: string|null, notes: string, url: string }|null}
 */
function releaseInfo(info) {
  if (!info || typeof info !== 'object' || typeof info.version !== 'string' || !parseVersion(info.version)) return null;
  let notes = '';
  if (typeof info.releaseNotes === 'string') {
    notes = notesToText(info.releaseNotes);
  } else if (Array.isArray(info.releaseNotes)) {
    notes = info.releaseNotes
      .filter((entry) => entry && typeof entry.note === 'string')
      .map((entry) => `${entry.version ? `Version ${entry.version}\n` : ''}${notesToText(entry.note)}`)
      .join('\n\n');
  }
  if (notes.length > MAX_NOTES_CHARS) notes = `${notes.slice(0, MAX_NOTES_CHARS).trimEnd()}…`;
  const date = typeof info.releaseDate === 'string' && Number.isFinite(Date.parse(info.releaseDate))
    ? new Date(info.releaseDate).toISOString()
    : null;
  return {
    version: info.version.trim(),
    releaseName: typeof info.releaseName === 'string' && info.releaseName.trim() ? info.releaseName.trim().slice(0, 200) : null,
    releaseDate: date,
    notes,
    url: releaseUrl(info.version, info.tag),
  };
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/**
 * The state before anything happened.
 * @param {{ mode: string, reason?: string|null, currentVersion: string, autoCheck?: boolean, updatedTo?: string|null }} input
 * @returns {object}
 */
function initialUpdateState({ mode, reason = null, currentVersion, autoCheck = true, updatedTo = null }) {
  const known = UPDATE_MODES.includes(mode) ? mode : 'disabled';
  const disabledReason = known === 'disabled' ? (DISABLED_MESSAGES[reason] ? reason : 'source') : null;
  return {
    mode: known,
    disabledReason,
    /** The sentence Settings shows when this copy does not update itself (null otherwise). */
    disabledMessage: disabledReason ? DISABLED_MESSAGES[disabledReason] : null,
    currentVersion: String(currentVersion || '0.0.0'),
    /** The installer started this process after updating to this version (null otherwise). */
    updatedTo: updatedTo || null,
    autoCheck: autoCheck !== false,
    phase: 'idle',
    checking: false,
    /** The newer version found (downloading, ready, or failed to download). */
    available: null,
    progress: null,
    /** Last check, manual or automatic: { at: ISO date, ok: boolean, error: string|null }. */
    lastCheck: null,
    error: null,
    nextCheckAt: null,
    releasesUrl: RELEASES_URL,
    /** Increased by the updater on every change, so the window can drop an older copy that arrives late. */
    revision: 0,
  };
}

function finite(n) {
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Apply one event to the state. Returns the same object when nothing changes.
 *
 * Events: `check-started` { at }, `check-finished` { at, update: releaseInfo|null },
 * `check-failed` { at, error }, `download-progress` { percent, transferred, total, bytesPerSecond },
 * `downloaded` { update: releaseInfo }, `download-failed` { error }, `install-failed` { error },
 * `auto-check` { enabled }, `scheduled` { at: ISO date|null }.
 *
 * @param {object} state
 * @param {{ type: string, [key: string]: any }} event
 * @returns {object}
 */
function reduceUpdateState(state, event) {
  if (!state || !event || typeof event.type !== 'string') return state;
  const busyWithUpdate = state.phase === 'downloading' || state.phase === 'ready';
  switch (event.type) {
    case 'check-started':
      return state.checking ? state : { ...state, checking: true };

    case 'check-finished': {
      const base = { ...state, checking: false, lastCheck: { at: event.at, ok: true, error: null } };
      const update = event.update && isNewerVersion(event.update.version, state.currentVersion) ? event.update : null;
      if (!update) {
        // Nothing newer is published. An update already downloading or ready stays: it is still newer
        // than this copy (the release may just have been moved back to draft).
        if (busyWithUpdate) return base;
        return { ...base, phase: 'up-to-date', available: null, progress: null, error: null };
      }
      const same = state.available && compareVersions(update.version, state.available.version);
      if (busyWithUpdate && same !== null && same <= 0) {
        // The same version again (or an older one than the one in hand): keep going, refresh its notes.
        return same === 0 ? { ...base, available: { ...state.available, ...update } } : base;
      }
      return {
        ...base,
        phase: 'downloading',
        available: update,
        progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
        error: null,
      };
    }

    case 'check-failed': {
      const base = { ...state, checking: false, lastCheck: { at: event.at, ok: false, error: event.error || null } };
      // A failed check does not take away an update that is downloading or ready.
      if (busyWithUpdate) return base;
      return { ...base, phase: 'error', error: event.error || 'Could not check for updates.', progress: null };
    }

    case 'download-progress':
      if (state.phase !== 'downloading') return state;
      return {
        ...state,
        progress: {
          percent: Math.min(100, finite(event.percent)),
          transferred: finite(event.transferred),
          total: finite(event.total),
          bytesPerSecond: finite(event.bytesPerSecond),
        },
      };

    case 'downloaded': {
      const update = event.update || state.available;
      if (!update || !isNewerVersion(update.version, state.currentVersion)) return state;
      return { ...state, phase: 'ready', available: { ...(state.available || {}), ...update }, progress: null, error: null };
    }

    case 'download-failed':
      if (state.phase !== 'downloading') return state;
      return { ...state, phase: 'error', progress: null, error: event.error || 'The update could not be downloaded.' };

    case 'install-failed':
      return { ...state, phase: 'error', progress: null, error: event.error || 'The update could not be installed.' };

    case 'auto-check': {
      const enabled = event.enabled !== false;
      return enabled === state.autoCheck ? state : { ...state, autoCheck: enabled };
    }

    case 'scheduled': {
      const at = typeof event.at === 'string' ? event.at : null;
      return at === state.nextCheckAt ? state : { ...state, nextCheckAt: at };
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

/**
 * Milliseconds until the next automatic check, or null when automatic checks are off.
 * Counted from the last check of any kind (a manual "Check now" also resets the 4 hours).
 * @param {{ autoCheck: boolean, now: number, lastCheck?: { at: string, ok: boolean }|null,
 *   firstDelayMs?: number, intervalMs?: number, retryMs?: number }} input
 * @returns {number|null}
 */
function planNextCheck({
  autoCheck, now, lastCheck = null,
  firstDelayMs = FIRST_CHECK_DELAY_MS, intervalMs = CHECK_INTERVAL_MS, retryMs = RETRY_AFTER_FAILURE_MS,
}) {
  if (!autoCheck) return null;
  const last = lastCheck ? Date.parse(lastCheck.at) : NaN;
  if (!Number.isFinite(last)) return firstDelayMs;
  const wait = lastCheck.ok ? intervalMs : Math.min(retryMs, intervalMs);
  // Clamped both ways: never sooner than the first-check delay, never later than one full wait
  // (the clock may have been moved back since the last check).
  return Math.min(wait, Math.max(firstDelayMs, last + wait - now));
}

// ---------------------------------------------------------------------------------------------
// Install gating
// ---------------------------------------------------------------------------------------------

/**
 * Why "Restart to update" cannot run now, or null when it can.
 * @param {{ mode: string, phase: string, activeJob?: { title?: string }|null }} input
 * @returns {{ code: string, message: string }|null}
 */
function installBlocker({ mode, phase, activeJob = null }) {
  if (mode === 'disabled') {
    return { code: 'UPDATES_DISABLED', message: 'This copy of Kirigami does not update itself. Download the newest installer from the releases page.' };
  }
  if (mode === 'rehearsal') {
    return { code: 'UPDATE_REHEARSAL', message: 'This copy runs from source code (update rehearsal): the downloaded update is never installed.' };
  }
  if (phase !== 'ready') return { code: 'UPDATE_NOT_READY', message: 'No update is ready to install yet.' };
  if (activeJob) {
    const title = String(activeJob.title || 'the current task').replace(/"/g, "'");
    return { code: 'BUSY', message: `BUSY: wait until "${title}" finishes, then restart to update` };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

function errorText(err) {
  if (!err) return '';
  if (typeof err === 'string') return err;
  return `${err.code || ''} ${err.message || ''}`;
}

function httpStatus(err) {
  if (!err || typeof err !== 'object') return null;
  if (Number.isInteger(err.statusCode)) return err.statusCode;
  const fromCode = /^HTTP_ERROR_(\d{3})$/.exec(String(err.code || ''));
  if (fromCode) return Number(fromCode[1]);
  const fromMessage = /HttpError: (\d{3})\b/.exec(String(err.message || ''));
  return fromMessage ? Number(fromMessage[1]) : null;
}

const NETWORK_PATTERN = /net::ERR_|\b(ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|EPIPE)\b|socket hang up/;

/**
 * GitHub's answer to `releases/latest` when the repository has no published release, as
 * electron-updater words it: github.com redirects to the releases list, which answers 406 to the
 * JSON request (a GitHub Enterprise API answers 404).
 */
const NO_LATEST_RELEASE = /Unable to find latest version on GitHub\b.*please ensure a production release exists: HttpError: (404|406)\b/;

/**
 * True when the check failed only because no release is published yet: from the user's point of
 * view the app is up to date. What electron-updater's GitHub provider reports then:
 * - an empty releases feed (nothing published at all): `ERR_XML_MISSED_ELEMENT` "No published versions";
 * - a feed that only lists tags, drafts being prepared or pre-releases (the release workflow pushes
 *   the tag before the draft is published): `releases/latest` fails with 404/406, and the provider
 *   wraps that error in `ERR_UPDATER_INVALID_RELEASE_FEED` "Cannot parse releases feed: Error: Unable
 *   to find latest version on GitHub (...)". Only the first line counts: the rest is the feed itself.
 * @param {unknown} err
 * @returns {boolean}
 */
function isNoReleaseError(err) {
  if (!err || typeof err !== 'object') return false;
  const message = String(err.message || '');
  const firstLine = message.split(/\r?\n/)[0];
  if (NETWORK_PATTERN.test(`${err.code || ''} ${firstLine}`)) return false;
  if (err.code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') return true;
  if (err.code === 'ERR_XML_MISSED_ELEMENT' && /No published versions/i.test(message)) return true;
  return (err.code === 'ERR_UPDATER_INVALID_RELEASE_FEED' || err.code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')
    && NO_LATEST_RELEASE.test(firstLine);
}

/**
 * One plain sentence for a failed check, download or install.
 * @param {unknown} err
 * @param {'check'|'download'|'install'} [stage]
 * @returns {string}
 */
function updateErrorMessage(err, stage = 'check') {
  if (err && typeof err === 'object' && err.friendly && err.message) return String(err.message);
  const text = errorText(err);
  const code = err && typeof err === 'object' ? String(err.code || '') : '';
  const status = httpStatus(err);
  if (/net::ERR_(CERT|SSL)_/.test(text)) {
    return 'Could not open a secure connection to GitHub. A proxy or antivirus may be blocking it.';
  }
  if (NETWORK_PATTERN.test(text)) {
    return 'Could not reach GitHub. Check your internet connection; Kirigami tries again later.';
  }
  if (code === 'ERR_CHECKSUM_MISMATCH' || /checksum mismatch/i.test(text)) {
    return 'The downloaded update was damaged (its checksum did not match). It is downloaded again at the next check.';
  }
  if (code === 'ERR_UPDATER_INVALID_SIGNATURE') {
    return "The downloaded update is not signed by Kirigami's publisher, so it is not installed.";
  }
  if (code === 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND') {
    return 'The newest release has no update information yet. Kirigami tries again later.';
  }
  if (status === 403 || status === 429) return 'GitHub is limiting requests right now. Kirigami tries again later.';
  if (status && status >= 500) return `GitHub is not answering properly right now (error ${status}). Kirigami tries again later.`;
  if (/\bENOSPC\b/.test(text)) return 'Your disk is full. Free some space so the update can be downloaded.';
  if (/\b(EACCES|EPERM|EBUSY)\b/.test(text)) {
    return 'Windows blocked the update files. Your antivirus may be holding them; try again later.';
  }
  const lead = { check: 'Could not check for updates', download: 'Could not download the update', install: 'Could not start the update' }[stage]
    || 'Could not update Kirigami';
  const firstLine = String((err && typeof err === 'object' ? err.message : err) || '').split(/\r?\n/)[0].trim();
  if (!firstLine) return `${lead}.`;
  const detail = firstLine.length > MAX_DETAIL_CHARS ? `${firstLine.slice(0, MAX_DETAIL_CHARS)}…` : firstLine;
  return `${lead}: ${detail.replace(/[.\s]+$/, '')}.`;
}

module.exports = {
  APP_REPOSITORY,
  RELEASES_URL,
  UPDATE_MODES,
  UPDATE_PHASES,
  DISABLED_MESSAGES,
  UPDATE_MESSAGES,
  FIRST_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  CHECK_TIMEOUT_MS,
  DOWNLOAD_STALL_MS,
  updateMode,
  launchedByUpdater,
  parseVersion,
  compareVersions,
  isNewerVersion,
  notesToText,
  releaseUrl,
  releaseInfo,
  initialUpdateState,
  reduceUpdateState,
  planNextCheck,
  installBlocker,
  isNoReleaseError,
  updateErrorMessage,
};
