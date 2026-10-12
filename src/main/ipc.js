'use strict';

/**
 * IPC handlers behind `window.scm` (spec §6).
 *
 * Every handler:
 *  1. verifies the sender is the main window's top frame showing our index.html;
 *  2. validates argument types, kinds (allowlists) and relative paths (must stay inside their folder);
 *  3. calls the service function with the EXACT §12 name through a LAZY require, so the app still
 *     boots when a service module is missing (the handler then rejects with a clear message);
 *  4. converts errors to plain messages (Electron only forwards `message` to the renderer; raw fs
 *     errors get a friendly wording; `BUSY:` / `NOT_READY` prefixes are preserved).
 *
 * This module does not require('electron'): Electron objects are injected (unit-testable).
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const util = require('./util');

/** Events pushed from main to the renderer (webContents.send). */
const EVENT_CHANNELS = Object.freeze(['jobs:event', 'settings:changed', 'cards:changed', 'app:notice', 'engine:changed']);

const CARD_KINDS = Object.freeze(['front', 'back', 'double_sided']);
const ADD_KINDS = Object.freeze(['front', 'back']);
const FOLDER_KINDS = Object.freeze(['front', 'back', 'double_sided', 'decklist', 'output']);
const BACK_MODES = Object.freeze(['auto', 'file', 'none']);
const SOURCE_KINDS = Object.freeze(['text', 'saved', 'file', 'url', 'text_inline']);
const SOURCE_KEYS = Object.freeze(['kind', 'text', 'deckName', 'savedName', 'filePath', 'url']);
const OPENABLE_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'webp', 'studio3', 'txt', 'log', 'json']);
const FORBIDDEN_NAMES = new Set(['__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'toString', 'valueOf']);

const MAX_PAYLOAD_CHARS = 2000000;
const MAX_TEXT_CHARS = 5000000;
const MAX_PATHS = 10000;
const READY_WAIT_MS = 120000;
const MAX_ERROR_CHARS = 4000;

const FS_MESSAGES = {
  ENOENT: (p) => `Could not find ${p}.`,
  ENOTDIR: (p) => `Could not find the folder for ${p}.`,
  EISDIR: (p) => `${p} is a folder, not a file.`,
  EACCES: (p) => `Windows blocked access to ${p}. It may be open in another program, synced by OneDrive or protected by your antivirus.`,
  EPERM: (p) => `Windows blocked access to ${p}. It may be open in another program, synced by OneDrive or protected by your antivirus.`,
  EBUSY: (p) => `${p} is in use by another program. Close it and try again.`,
  ENOSPC: () => 'Your disk is full. Free some space and try again.',
  EROFS: (p) => `${p} is on a read-only drive.`,
  ENAMETOOLONG: () => 'A file name or folder path is too long. Use a shorter name or a folder closer to the drive root.',
  EMFILE: () => 'Too many files are open at once. Try again in a moment.',
  EXDEV: () => 'The file could not be moved to another drive.',
};

// ---------------------------------------------------------------------------------------------
// Validation helpers (throw TypeError with code INVALID_ARGUMENT)
// ---------------------------------------------------------------------------------------------

function invalid(message) {
  const err = new TypeError(message);
  err.code = 'INVALID_ARGUMENT';
  return err;
}

function str(value, name, { max = 4096, allowEmpty = false } = {}) {
  if (typeof value !== 'string') throw invalid(`${name} must be text`);
  if (!allowEmpty && value.length === 0) throw invalid(`${name} is required`);
  if (value.length > max) throw invalid(`${name} is too long`);
  return value;
}

function bool(value, name, def) {
  if (value === undefined || value === null) return def;
  if (typeof value !== 'boolean') throw invalid(`${name} must be true or false`);
  return value;
}

function int(value, name, { min, max, def } = {}) {
  if (value === undefined || value === null) {
    if (def !== undefined) return def;
    throw invalid(`${name} is required`);
  }
  if (!Number.isInteger(value) || value < min || value > max) throw invalid(`${name} must be a whole number from ${min} to ${max}`);
  return value;
}

function num(value, name, { min = -1e9, max = 1e9, def } = {}) {
  if (value === undefined || value === null || value === '') {
    if (def !== undefined) return def;
    throw invalid(`${name} is required`);
  }
  const n = typeof value === 'string' ? Number(value.trim().replace(',', '.')) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw invalid(`${name} must be a number`);
  return n;
}

function oneOf(value, name, list) {
  if (typeof value !== 'string' || !list.includes(value)) throw invalid(`${name} must be one of: ${list.join(', ')}`);
  return value;
}

function obj(value, name, { optional = false, maxChars = MAX_PAYLOAD_CHARS } = {}) {
  if (value === undefined || value === null) {
    if (optional) return {};
    throw invalid(`${name} is required`);
  }
  if (!util.isPlainObject(value)) throw invalid(`${name} must be an object`);
  let size;
  try {
    size = JSON.stringify(value).length;
  } catch {
    throw invalid(`${name} could not be read`);
  }
  if (size > maxChars) throw invalid(`${name} is too large`);
  return value;
}

function isDevicePath(p) {
  return /^[\\/]{2}[?.][\\/]/.test(p);
}

/** Absolute path (drive or UNC; device paths `\\?\` / `\\.\` refused). Returns the normalized path. */
function absPath(value, name, { allowNull = false } = {}) {
  if (value === undefined || value === null) {
    if (allowNull) return null;
    throw invalid(`${name} is required`);
  }
  str(value, name, { max: 32767 });
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) throw invalid(`${name} contains invalid characters`);
  if (!path.isAbsolute(value) || isDevicePath(value)) throw invalid(`${name} must be a full path`);
  if (process.platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(value) && !/^[\\/]{2}[^\\/?.]/.test(value)) {
    throw invalid(`${name} must be a full path`);
  }
  return path.resolve(value);
}

function withExt(abs, name, exts) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (!exts.includes(ext)) throw invalid(`${name} must be a .${exts.join(' / .')} file`);
  return abs;
}

/** Relative path that must resolve strictly inside `root`. Returned unchanged. */
function relPath(root, value, name) {
  str(value, name, { max: 4096 });
  util.resolveInside(root, value);
  return value;
}

function relList(root, value, name) {
  if (!Array.isArray(value)) throw invalid(`${name} must be a list`);
  if (value.length > MAX_PATHS) throw invalid(`${name} has too many entries`);
  return value.map((rel, i) => relPath(root, rel, `${name}[${i}]`));
}

/** A single file name (no folders), e.g. a decklist or a trash batch id. */
function fileName(value, name) {
  str(value, name, { max: 255 });
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f]/.test(value) || /^[. ]+$/.test(value)) throw invalid(`${name} is not a valid name`);
  if (process.platform === 'win32' && (/[<>:"|?*]/.test(value) || util.isReservedWindowsName(value))) {
    throw invalid(`${name} is not a valid name`);
  }
  return value;
}

function paperName(value) {
  str(value, 'paper', { max: 40 });
  if (!/^[a-z0-9_]+$/i.test(value)) throw invalid('Unknown paper size');
  return value;
}

function jobIdOf(value) {
  str(value, 'jobId', { max: 200 });
  if (!/^[\w.:-]+$/.test(value)) throw invalid('Invalid job id');
  return value;
}

function errMessage(err) {
  if (!err) return 'Unknown error';
  return typeof err.message === 'string' && err.message ? err.message : String(err);
}

function safeCall(fn, fallback) {
  try {
    const v = fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

function comparable(p) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/**
 * Default lazy loader for service modules (`./<name>.js`).
 * @param {string} name
 * @returns {object}
 */
function loadServiceDefault(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`./${name}.js`);
  } catch (err) {
    const missing = err && err.code === 'MODULE_NOT_FOUND';
    const e = new Error(missing
      ? `Part of the app is missing (${name}.js). Please reinstall Kirigami.`
      : `Part of the app could not start (${name}.js): ${errMessage(err)}`);
    e.code = 'SERVICE_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

function unavailable(what) {
  const e = new Error(`Part of the app is missing (${what}). Please reinstall Kirigami.`);
  e.code = 'SERVICE_UNAVAILABLE';
  return e;
}

/** `startXJob` services may return a jobId string or `{ jobId }`: always answer `{ jobId }`. */
function asJob(result) {
  if (typeof result === 'string') return { jobId: result };
  return result;
}

// ---------------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------------

/**
 * Register every `window.scm` IPC handler.
 *
 * @param {Electron.IpcMain} ipcMain
 * @param {object} deps app deps (spec §12): getPaths, settings, jobs, helper, logger, app, openPath,
 *   showItemInFolder, noAutoOpen, ready? (Promise of startup tasks), restartWatchers?, openExternal?
 * @param {object} options
 * @param {Electron.Dialog} options.dialog
 * @param {Electron.Shell} options.shell
 * @param {Electron.WebUtils} [options.webUtils] (unused in main; accepted for the documented signature)
 * @param {typeof Electron.BrowserWindow} [options.BrowserWindow]
 * @param {() => (Electron.BrowserWindow|null)} options.getMainWindow
 * @param {string} [options.indexHtmlPath] defaults to src/renderer/index.html
 * @param {(name: string) => object} [options.loadService] module loader (tests)
 * @returns {{ channels: string[], allowOpenPath(p: string): void, envStatus(opts?: { refresh?: boolean }): Promise<object> }}
 */
function registerIpc(ipcMain, deps, options = {}) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('registerIpc: ipcMain is required');
  if (!deps || typeof deps.getPaths !== 'function') throw new TypeError('registerIpc: deps.getPaths is required');
  const opts = options || {};
  const dialog = opts.dialog || null;
  const shell = opts.shell || null;
  const getMainWindow = typeof opts.getMainWindow === 'function' ? opts.getMainWindow : () => null;
  const indexHtmlPath = path.resolve(opts.indexHtmlPath || path.join(__dirname, '..', 'renderer', 'index.html'));
  const loadService = typeof opts.loadService === 'function' ? opts.loadService : loadServiceDefault;
  const noop = () => {};
  const log = deps.logger || { info: noop, warn: noop, error: noop };

  const channels = [];
  const openableOutputs = new Map(); // comparable path -> true (most recent last)
  let studioCache = null;

  // ----- infrastructure ----------------------------------------------------------------------

  function isOurIndexUrl(url) {
    if (typeof url !== 'string' || !url.startsWith('file:')) return false;
    try {
      const u = new URL(url);
      u.hash = '';
      u.search = '';
      return util.samePath(fileURLToPath(u), indexHtmlPath);
    } catch {
      return false;
    }
  }

  function assertTrustedSender(event) {
    const win = safeCall(getMainWindow, null);
    const frame = event && event.senderFrame;
    let ok = !!(win && !safeCall(() => win.isDestroyed(), true) && frame && !frame.detached);
    if (ok) {
      const wc = win.webContents;
      ok = !!(wc && event.sender && event.sender.id === wc.id) && !frame.parent && isOurIndexUrl(frame.url);
    }
    if (!ok) {
      const err = new Error('Request refused: it did not come from the app window.');
      err.code = 'UNTRUSTED_SENDER';
      throw err;
    }
  }

  function toRendererError(err, channel) {
    const e = err instanceof Error ? err : new Error(String(err));
    let message = errMessage(e);
    if (e.syscall && FS_MESSAGES[e.code]) {
      const target = e.path ? `"${e.path}"` : 'a file';
      message = FS_MESSAGES[e.code](target);
    }
    // Expected = user-facing outcomes (BUSY, NOT_READY, validation, app error codes such as
    // WORKSPACE_INVALID); logged as warnings. Anything else is logged with its stack.
    const expected = /^(BUSY:|NOT_READY)/.test(message)
      || (!e.syscall && typeof e.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.code));
    try {
      if (expected) log.warn(`[ipc] ${channel}: ${message}`);
      else log.error(`[ipc] ${channel} failed:`, e);
    } catch { /* logging never breaks a reply */ }
    if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS)}…`;
    return new Error(message);
  }

  function handle(channel, fn) {
    channels.push(channel);
    if (typeof ipcMain.removeHandler === 'function') ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        assertTrustedSender(event);
        return await fn(...args);
      } catch (err) {
        throw toRendererError(err, channel);
      }
    });
  }

  async function call(name, fnName, ...args) {
    const mod = loadService(name);
    if (!mod || typeof mod[fnName] !== 'function') throw unavailable(`${name}.${fnName}`);
    return mod[fnName](...args);
  }

  async function waitReady() {
    const ready = deps.ready;
    if (!ready || typeof ready.then !== 'function') return;
    let timer;
    await Promise.race([
      Promise.resolve(ready).catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, READY_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }

  function busyError(active) {
    return new Error(`BUSY: wait until "${(active && active.title) || 'the current task'}" finishes`);
  }

  function assertNotMutating() {
    const jobs = deps.jobs;
    if (jobs && typeof jobs.isMutating === 'function' && jobs.isMutating()) {
      throw busyError(safeCall(() => jobs.active(), null));
    }
  }

  function assertNoActiveJob() {
    const jobs = deps.jobs;
    const active = jobs && typeof jobs.active === 'function' ? safeCall(() => jobs.active(), null) : null;
    if (active) throw busyError(active);
  }

  function paths() {
    return deps.getPaths();
  }

  function settingsNow() {
    return deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : {};
  }

  function allowOpenPath(p) {
    if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return;
    const key = comparable(p);
    openableOutputs.delete(key);
    openableOutputs.set(key, true);
    while (openableOutputs.size > 100) openableOutputs.delete(openableOutputs.keys().next().value);
  }

  // Remember outputs of finished jobs so "Open" works even for files outside the managed folders.
  if (deps.jobs && typeof deps.jobs.on === 'function') {
    deps.jobs.on('event', (evt) => {
      try {
        if (!evt || evt.type !== 'finished' || !evt.result || typeof evt.result !== 'object') return;
        for (const value of Object.values(evt.result)) {
          if (typeof value === 'string' && path.isAbsolute(value)) allowOpenPath(value);
        }
      } catch { /* ignore */ }
    });
  }

  async function openPathImpl(abs) {
    if (typeof deps.openPath === 'function') return deps.openPath(abs);
    if (deps.noAutoOpen) return '';
    if (!shell) throw unavailable('shell');
    return shell.openPath(abs);
  }

  function isOpenableLocation(abs) {
    const p = paths();
    const roots = [p.workspaceDir, p.outputDir, p.logsDir, p.engineSourceDir, p.scmCacheDir].filter(Boolean);
    if (roots.some((root) => util.isInside(root, abs))) return true;
    const s = settingsNow();
    const last = s && s.pdf && s.pdf.lastPdf && s.pdf.lastPdf.path;
    if (typeof last === 'string' && last && util.samePath(last, abs)) return true;
    return openableOutputs.has(comparable(abs));
  }

  async function openPathChecked(value) {
    const abs = absPath(value, 'path');
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      throw new Error(`Could not find "${abs}".`);
    }
    if (!st.isDirectory()) {
      const ext = path.extname(abs).slice(1).toLowerCase();
      if (!OPENABLE_EXTENSIONS.has(ext)) throw new Error(`For your safety, the app doesn't open ${ext ? `.${ext}` : 'these'} files.`);
      if (!isOpenableLocation(abs)) throw new Error('For your safety, the app only opens files from its own folders.');
    }
    const result = await openPathImpl(abs);
    if (result) throw new Error(`Windows could not open "${path.basename(abs)}": ${result}`);
    return true;
  }

  function validateExternalUrl(value) {
    str(value, 'url', { max: 2081 });
    let u;
    try {
      u = new URL(value);
    } catch {
      throw invalid('This link is not valid');
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw invalid('Only web links (http/https) can be opened');
    return u.href;
  }

  // ----- env status --------------------------------------------------------------------------

  function fallbackEnv(err) {
    const p = safeCall(paths, null);
    const s = settingsNow();
    const message = errMessage(err);
    return {
      ready: false,
      workspace: { ok: false, path: p ? p.workspaceDir : null, error: message, external: false },
      python: {
        ok: false,
        path: p ? p.pythonPath : null,
        version: null,
        packagesOk: false,
        missing: [],
        error: message,
        source: s && s.pythonPath ? 'custom' : 'venv',
        appOwned: !!(p && p.appOwnedVenv),
      },
      uv: { available: false, path: null },
    };
  }

  async function envBase(refresh) {
    try {
      const st = await call('python-env', 'checkEnv', deps, { refresh: !!refresh });
      if (st && typeof st === 'object') return st;
      throw new Error('The components check returned nothing');
    } catch (err) {
      log.warn('[ipc] env check failed:', err);
      return fallbackEnv(err);
    }
  }

  async function upscaylStatusSafe(refresh) {
    try {
      const st = await call('upscayl', 'getUpscaylStatus', deps, { refresh: !!refresh });
      if (st && typeof st === 'object') return st;
      throw new Error('The Upscayl check returned nothing');
    } catch (err) {
      log.warn('[ipc] Upscayl status failed:', err);
      return {
        found: false, binPath: null, modelsDir: null, customModelsDir: null, version: null, source: null,
        models: [], gpus: null, error: errMessage(err),
      };
    }
  }

  function studioExeFrom(entry) {
    const icon = typeof entry.DisplayIcon === 'string' ? entry.DisplayIcon.trim() : '';
    const fromIcon = icon.replace(/,\s*-?\d+\s*$/, '').replace(/^"+|"+$/g, '').trim();
    if (fromIcon && /\.exe$/i.test(fromIcon) && fs.existsSync(fromIcon)) return fromIcon;
    const loc = typeof entry.InstallLocation === 'string' ? entry.InstallLocation.replace(/^"+|"+$/g, '').trim() : '';
    if (loc) {
      const exe = path.join(loc, 'Silhouette Studio.exe');
      return fs.existsSync(exe) ? exe : loc;
    }
    return fromIcon || null;
  }

  function commonStudioPaths() {
    if (process.platform === 'win32') {
      return [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramW6432]
        .filter(Boolean)
        .map((dir) => path.join(dir, 'Silhouette America', 'Silhouette Studio', 'Silhouette Studio.exe'));
    }
    if (process.platform === 'darwin') return ['/Applications/Silhouette Studio.app'];
    return [];
  }

  async function detectSilhouetteStudio(refresh) {
    if (studioCache && !refresh) return studioCache;
    let result = { found: false, path: null, version: null };
    try {
      const registry = loadService('registry');
      if (registry && typeof registry.findSilhouetteStudio === 'function') {
        const found = await registry.findSilhouetteStudio({ refresh: !!refresh, logger: deps.logger });
        if (found && typeof found === 'object') {
          studioCache = { ...found, found: !!found.found, path: found.path || null, version: found.version || null };
          return studioCache;
        }
      }
      const entries = await call('registry', 'queryUninstall', 'Silhouette Studio*', { timeoutMs: 10000 });
      const list = (Array.isArray(entries) ? entries : entries ? [entries] : [])
        .filter((e) => e && typeof e.DisplayName === 'string' && /silhouette studio/i.test(e.DisplayName));
      if (list.length) {
        const entry = list[0];
        result = {
          found: true,
          path: studioExeFrom(entry),
          version: typeof entry.DisplayVersion === 'string' && entry.DisplayVersion ? entry.DisplayVersion : null,
        };
      }
    } catch (err) {
      log.warn('[ipc] Silhouette Studio registry lookup failed:', err);
    }
    if (!result.found) {
      const guess = commonStudioPaths().find((p) => safeCall(() => fs.existsSync(p), false));
      if (guess) result = { found: true, path: guess, version: null };
    }
    studioCache = result;
    return result;
  }

  async function studioSafe(refresh) {
    try {
      return await detectSilhouetteStudio(refresh);
    } catch (err) {
      log.warn('[ipc] Silhouette Studio detection failed:', err);
      return { found: false, path: null, version: null };
    }
  }

  const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  /**
   * Complete a python-env status with the Upscayl and Silhouette Studio parts when it lacks them
   * (python-env's checkEnv normally includes both; each part is guarded separately).
   */
  async function completeStatus(base, refresh) {
    const [upscayl, silhouetteStudio] = await Promise.all([
      isObject(base.upscayl) ? base.upscayl : upscaylStatusSafe(refresh),
      isObject(base.silhouetteStudio) ? base.silhouetteStudio : studioSafe(refresh),
    ]);
    return { ...base, ready: !!base.ready, upscayl, silhouetteStudio };
  }

  /**
   * Aggregated environment status (python-env + Upscayl + Silhouette Studio); one failing part
   * never breaks the others.
   * @param {{ refresh?: boolean }} [o]
   */
  async function envStatus(o = {}) {
    const refresh = !!(o && o.refresh);
    return completeStatus(await envBase(refresh), refresh);
  }

  /** Use the status a service already returned (fresh checkEnv), else compute one. */
  async function statusAfter(result) {
    if (isObject(result) && typeof result.ready === 'boolean' && isObject(result.python)) return completeStatus(result, false);
    return envStatus({ refresh: true });
  }

  async function restartWatchersSafe() {
    try {
      if (typeof deps.restartWatchers === 'function') await deps.restartWatchers();
    } catch (err) {
      log.warn('[ipc] Could not restart the card folder watchers:', err);
    }
  }

  // ----- dialogs -----------------------------------------------------------------------------

  function liveWindow() {
    const win = safeCall(getMainWindow, null);
    return win && !safeCall(() => win.isDestroyed(), true) ? win : null;
  }

  function sanitizeFilters(filters) {
    if (filters === undefined || filters === null) return undefined;
    if (!Array.isArray(filters) || filters.length > 20) throw invalid('Invalid file filters');
    return filters.map((f, i) => {
      if (!util.isPlainObject(f)) throw invalid('Invalid file filters');
      const name = str(f.name, `filters[${i}].name`, { max: 100 });
      if (!Array.isArray(f.extensions) || f.extensions.length === 0 || f.extensions.length > 50) throw invalid('Invalid file filters');
      const extensions = f.extensions.map((e) => {
        const x = String(e).replace(/^\*?\./, '');
        if (!/^(\*|[A-Za-z0-9]{1,16})$/.test(x)) throw invalid('Invalid file filters');
        return x;
      });
      return { name, extensions };
    });
  }

  function dialogArgs(o) {
    const args = obj(o, 'options', { optional: true, maxChars: 20000 });
    const purpose = args.purpose === undefined || args.purpose === null ? 'general' : str(args.purpose, 'purpose', { max: 32 });
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(purpose) || FORBIDDEN_NAMES.has(purpose)) throw invalid('Invalid dialog purpose');
    const title = args.title === undefined || args.title === null ? undefined : str(args.title, 'title', { max: 200, allowEmpty: true });
    return { purpose, title, filters: sanitizeFilters(args.filters), args };
  }

  function existingDir(dir) {
    if (typeof dir !== 'string' || !dir) return null;
    return safeCall(() => (fs.statSync(dir).isDirectory() ? dir : null), null);
  }

  function defaultDirFor(purpose) {
    const s = settingsNow();
    const lastDirs = s && s.ui && util.isPlainObject(s.ui.lastDirs) ? s.ui.lastDirs : {};
    const last = Object.prototype.hasOwnProperty.call(lastDirs, purpose) ? lastDirs[purpose] : null;
    const remembered = existingDir(last);
    if (remembered) return remembered;
    const app = deps.app;
    const get = (name) => (app && typeof app.getPath === 'function' ? existingDir(safeCall(() => app.getPath(name), null)) : null);
    const p = safeCall(paths, null);
    switch (purpose) {
      case 'output':
      case 'pdf':
        return existingDir(p && p.outputDir) || get('documents') || os.homedir();
      case 'images':
        return get('pictures') || get('downloads') || os.homedir();
      case 'decklist':
        return get('downloads') || get('documents') || os.homedir();
      default:
        return get('documents') || os.homedir();
    }
  }

  function rememberDir(purpose, dir) {
    if (!dir || !deps.settings || typeof deps.settings.update !== 'function') return;
    try {
      deps.settings.update({ ui: { lastDirs: { [purpose]: dir } } }, { internal: true });
    } catch (err) {
      log.warn('[ipc] Could not remember the dialog folder:', err);
    }
  }

  async function showOpen(dialogOptions) {
    if (!dialog) throw unavailable('dialog');
    const win = liveWindow();
    return win ? dialog.showOpenDialog(win, dialogOptions) : dialog.showOpenDialog(dialogOptions);
  }

  async function showSave(dialogOptions) {
    if (!dialog) throw unavailable('dialog');
    const win = liveWindow();
    return win ? dialog.showSaveDialog(win, dialogOptions) : dialog.showSaveDialog(dialogOptions);
  }

  // ===========================================================================================
  // Handlers (one per §6 method). Channel strings are literals: test/unit/ipc-parity.test.js
  // compares them with preload.js.
  // ===========================================================================================

  // ----- app ---------------------------------------------------------------------------------
  handle('app:info', async () => {
    const p = paths();
    const app = deps.app || {};
    return {
      version: safeCall(() => app.getVersion(), '0.0.0'),
      isDev: !app.isPackaged,
      platform: process.platform,
      arch: process.arch,
      locale: safeCall(() => app.getLocale(), 'en-US'),
      country: safeCall(() => app.getLocaleCountryCode(), '') || '',
      totalMemBytes: os.totalmem(),
      versions: {
        electron: process.versions.electron || null,
        chrome: process.versions.chrome || null,
        node: process.versions.node || null,
      },
      paths: {
        workspace: p.workspaceDir,
        engine: p.engineSourceDir,
        userData: p.userData || safeCall(() => app.getPath('userData'), null),
        data: p.dataDir,
        venv: p.venvDir,
        python: p.pythonPath,
        output: p.outputDir,
        logs: p.logsDir,
        upscaledRoot: p.upscaledRoot,
        cuttingTemplates: p.cuttingTemplatesDir,
        calibration: p.calibrationDir,
      },
    };
  });

  // ----- settings ----------------------------------------------------------------------------
  handle('settings:get', async () => {
    if (!deps.settings) throw unavailable('settings');
    return deps.settings.get();
  });

  handle('settings:update', async (patch) => {
    if (!deps.settings) throw unavailable('settings');
    return deps.settings.update(obj(patch, 'settings'));
  });

  handle('settings:reset', async () => {
    if (!deps.settings) throw unavailable('settings');
    assertNoActiveJob();
    const snapshot = () => safeCall(() => { const p = paths(); return { ws: p.workspaceDir, py: p.pythonPath }; }, {});
    const beforePaths = snapshot();
    deps.settings.reset();
    const afterPaths = snapshot();
    if (beforePaths.py && afterPaths.py && !util.samePath(beforePaths.py, afterPaths.py)) {
      // the Python in use changed: drop cached environment / introspection results
      try {
        const pythonEnv = loadService('python-env');
        if (pythonEnv && typeof pythonEnv.invalidateEnvCache === 'function') pythonEnv.invalidateEnvCache(deps);
      } catch (err) {
        log.warn('[ipc] Could not reset the components status cache:', err);
      }
      try {
        if (deps.helper && typeof deps.helper.invalidate === 'function') deps.helper.invalidate();
      } catch (err) {
        log.warn('[ipc] Could not reset the introspection cache:', err);
      }
    }
    const before = beforePaths.ws;
    const after = afterPaths.ws;
    if (before && after && !util.samePath(before, after)) {
      try {
        // re-applies the default folder: ensures it, clears caches, restarts watchers, notifies
        await call('workspace', 'setWorkspace', deps, null);
      } catch (err) {
        log.warn('[ipc] Could not switch back to the default card maker data folder:', err);
        await restartWatchersSafe();
      }
    }
    return deps.settings.get();
  });

  // ----- env ---------------------------------------------------------------------------------
  handle('env:status', async (o) => {
    const args = obj(o, 'options', { optional: true });
    await waitReady();
    return envStatus({ refresh: bool(args.refresh, 'refresh', false) });
  });

  handle('env:setup', async (o) => {
    const args = obj(o, 'options', { optional: true });
    await waitReady();
    return asJob(await call('python-env', 'startSetupJob', deps, args));
  });

  handle('env:usePython', async (exePath) => {
    const exe = absPath(exePath, 'Python path', { allowNull: true });
    if (exe !== null) {
      if (process.platform === 'win32') withExt(exe, 'Python', ['exe']);
      if (!safeCall(() => fs.statSync(exe).isFile(), false)) throw new Error(`Could not find "${exe}".`);
    }
    await waitReady();
    assertNoActiveJob();
    return statusAfter(await call('python-env', 'usePython', deps, exe));
  });

  // "Repair in the app's own location": switch from a broken dev/custom Python to the app-owned venv.
  // The renderer then starts env:setup to create and fill it.
  handle('env:useAppVenv', async () => {
    await waitReady();
    assertNoActiveJob();
    return statusAfter(await call('python-env', 'useAppVenv', deps));
  });

  handle('env:setWorkspace', async (dirPath) => {
    const dir = absPath(dirPath, 'folder', { allowNull: true });
    await waitReady();
    assertNoActiveJob();
    // workspace.setWorkspace ensures the folder, clears caches, restarts watchers and notifies
    return statusAfter(await call('workspace', 'setWorkspace', deps, dir));
  });

  // ----- engine ------------------------------------------------------------------------------
  handle('engine:introspect', async (o) => {
    const args = obj(o, 'options', { optional: true });
    const force = bool(args.force, 'force', false);
    await waitReady();
    const st = await envBase(false);
    if (!st || !st.ready) throw new Error('NOT_READY');
    if (!deps.helper || typeof deps.helper.introspect !== 'function') throw unavailable('helper.js');
    return deps.helper.introspect({ force });
  });

  // Card maker engine updates (engine-updater.js); 'engine:changed' pushes the same status.
  function engineUpdater() {
    if (!deps.engineUpdater) throw unavailable('engine-updater.js');
    return deps.engineUpdater;
  }

  handle('engine:updateStatus', async () => {
    await waitReady();
    return engineUpdater().status();
  });

  handle('engine:checkUpdate', async () => {
    await waitReady();
    return engineUpdater().checkNow({ manual: true });
  });

  handle('engine:rollback', async () => {
    await waitReady();
    return engineUpdater().rollback();
  });

  // ----- decklists ---------------------------------------------------------------------------
  handle('decklists:list', async () => {
    await waitReady();
    return call('decklists', 'listDecklists', deps);
  });

  handle('decklists:read', async (name) => {
    fileName(name, 'list name');
    util.resolveInside(paths().gameDir('decklist'), name);
    await waitReady();
    return call('decklists', 'readDecklist', deps, name);
  });

  handle('decklists:write', async (name, text, o) => {
    str(name, 'list name', { max: 200 });
    str(text, 'list text', { allowEmpty: true, max: MAX_TEXT_CHARS });
    const args = obj(o, 'options', { optional: true });
    const keepBoth = bool(args.keepBoth, 'keepBoth', true);
    await waitReady();
    assertNotMutating();
    return call('decklists', 'writeDecklist', deps, name, text, { keepBoth });
  });

  handle('decklists:remove', async (name) => {
    fileName(name, 'list name');
    util.resolveInside(paths().gameDir('decklist'), name);
    await waitReady();
    assertNotMutating();
    return call('decklists', 'removeDecklist', deps, name);
  });

  // ----- cards -------------------------------------------------------------------------------
  handle('cards:list', async (kind) => {
    oneOf(kind, 'kind', CARD_KINDS);
    await waitReady();
    return call('cards', 'listCards', deps, kind);
  });

  handle('cards:summary', async () => {
    await waitReady();
    return call('cards', 'summary', deps);
  });

  handle('cards:add', async (kind, absPaths) => {
    oneOf(kind, 'kind', ADD_KINDS);
    if (!Array.isArray(absPaths)) throw invalid('files must be a list');
    if (absPaths.length > MAX_PATHS) throw invalid('Too many files at once');
    // '' = an item dragged from a browser (no file on disk): the service reports it per file.
    const list = absPaths.map((p, i) => (p === '' ? '' : absPath(p, `files[${i}]`)));
    await waitReady();
    assertNotMutating();
    return call('cards', 'addCards', deps, kind, list);
  });

  handle('cards:remove', async (kind, rels) => {
    oneOf(kind, 'kind', CARD_KINDS);
    const list = relList(paths().gameDir(kind), rels, 'cards');
    await waitReady();
    assertNotMutating();
    return call('cards', 'removeCards', deps, kind, list);
  });

  handle('cards:clear', async (kind, o) => {
    oneOf(kind, 'kind', CARD_KINDS);
    const args = obj(o, 'options', { optional: true });
    const includePartners = bool(args.includePartners, 'includePartners', false);
    await waitReady();
    assertNotMutating();
    return call('cards', 'clearCards', deps, kind, { includePartners });
  });

  handle('cards:duplicate', async (kind, rel, copies) => {
    oneOf(kind, 'kind', CARD_KINDS);
    relPath(paths().gameDir(kind), rel, 'card');
    const n = int(copies, 'copies', { min: 1, max: 100, def: 1 });
    await waitReady();
    assertNotMutating();
    return call('cards', 'duplicateCard', deps, kind, rel, n);
  });

  handle('cards:fixCollisions', async (kind) => {
    oneOf(kind, 'kind', CARD_KINDS);
    await waitReady();
    assertNotMutating();
    return call('cards', 'fixCollisions', deps, kind);
  });

  handle('cards:setBack', async (o) => {
    const args = obj(o, 'back');
    const mode = oneOf(args.mode, 'mode', BACK_MODES);
    const file = args.file === undefined || args.file === null ? null : relPath(paths().gameDir('back'), args.file, 'back image');
    if (mode === 'file' && !file) throw invalid('Choose a back image');
    await waitReady();
    assertNotMutating();
    return call('cards', 'setBack', deps, { mode, file });
  });

  handle('cards:setPartnerBack', async (frontRel, filePath) => {
    relPath(paths().gameDir('front'), frontRel, 'front card');
    const abs = absPath(filePath, 'back image');
    await waitReady();
    assertNotMutating();
    return call('cards', 'setPartnerBack', deps, frontRel, abs);
  });

  handle('cards:removePartnerBack', async (frontRel) => {
    relPath(paths().gameDir('front'), frontRel, 'front card');
    await waitReady();
    assertNotMutating();
    return call('cards', 'removePartnerBack', deps, frontRel);
  });

  handle('cards:trashList', async () => {
    await waitReady();
    return call('cards', 'trashList', deps);
  });

  handle('cards:restore', async (batchId) => {
    fileName(batchId, 'batch');
    await waitReady();
    assertNotMutating();
    return call('cards', 'restoreBatch', deps, batchId);
  });

  handle('cards:emptyTrash', async () => {
    await waitReady();
    assertNotMutating();
    return call('cards', 'emptyTrash', deps);
  });

  handle('cards:loadSamples', async (o) => {
    const args = obj(o, 'options', { optional: true });
    const replace = bool(args.replace, 'replace', false);
    await waitReady();
    return asJob(await call('cards', 'startSamplesJob', deps, { replace }));
  });

  handle('cards:openFolder', async (kind) => {
    oneOf(kind, 'kind', FOLDER_KINDS);
    await waitReady();
    const result = await call('cards', 'openFolder', deps, kind);
    return result === undefined ? true : result;
  });

  // ----- fetch -------------------------------------------------------------------------------
  handle('fetch:start', async (req) => {
    const r = obj(req, 'request');
    const plugin = str(r.plugin, 'game', { max: 64 });
    if (!/^[A-Za-z0-9_]+$/.test(plugin)) throw invalid('Unknown game');
    const format = str(r.format, 'list format', { max: 64 });
    if (!/^[\w.-]+$/.test(format)) throw invalid('Unknown list format');
    const src = obj(r.source, 'source');
    const source = { ...src, kind: oneOf(src.kind, 'source kind', SOURCE_KINDS) };
    for (const key of SOURCE_KEYS) {
      if (key === 'kind' || src[key] === undefined || src[key] === null) continue;
      if (key === 'filePath') source.filePath = absPath(src.filePath, 'list file');
      else if (key === 'savedName') source.savedName = fileName(src.savedName, 'saved list');
      else if (key === 'text') source.text = str(src.text, 'list text', { allowEmpty: true, max: MAX_TEXT_CHARS });
      else source[key] = str(src[key], key, { allowEmpty: true, max: 4096 });
    }
    const request = {
      ...r,
      plugin,
      format,
      source,
      options: obj(r.options, 'options', { optional: true }),
      clearBeforeFetch: bool(r.clearBeforeFetch, 'clearBeforeFetch', false),
    };
    await waitReady();
    return asJob(await call('fetch', 'startFetchJob', deps, request));
  });

  // ----- upscayl -----------------------------------------------------------------------------
  handle('upscayl:status', async (o) => {
    const args = obj(o, 'options', { optional: true });
    await waitReady();
    return call('upscayl', 'getUpscaylStatus', deps, { refresh: bool(args.refresh, 'refresh', false) });
  });

  handle('upscayl:locate', async (p) => {
    const target = absPath(p, 'Upscayl location', { allowNull: true });
    await waitReady();
    assertNotMutating();
    return call('upscayl', 'locateUpscayl', deps, target);
  });

  handle('upscayl:setCustomModelsDir', async (dir) => {
    const target = absPath(dir, 'models folder', { allowNull: true });
    await waitReady();
    assertNotMutating();
    return call('upscayl', 'setCustomModelsDir', deps, target);
  });

  handle('upscayl:detectGpus', async () => {
    await waitReady();
    return asJob(await call('upscayl', 'startGpuProbeJob', deps));
  });

  handle('upscayl:start', async (o) => {
    const args = obj(o, 'options', { optional: true });
    const request = { ...args };
    delete request.targets;
    if (args.targets !== undefined && args.targets !== null) {
      const t = obj(args.targets, 'targets');
      request.targets = {};
      for (const kind of CARD_KINDS) request.targets[kind] = bool(t[kind], `targets.${kind}`, false);
    }
    await waitReady();
    return asJob(await call('upscayl', 'startUpscaleJob', deps, request));
  });

  handle('upscayl:preview', async (o) => {
    const args = obj(o, 'card');
    const kind = oneOf(args.kind, 'kind', CARD_KINDS);
    const rel = relPath(paths().gameDir(kind), args.rel, 'card');
    await waitReady();
    return asJob(await call('upscayl', 'startPreviewJob', deps, { kind, rel }));
  });

  handle('upscayl:cacheInfo', async () => {
    await waitReady();
    return call('upscayl', 'cacheInfo', deps);
  });

  handle('upscayl:clearCache', async () => {
    await waitReady();
    assertNotMutating();
    return call('upscayl', 'clearCache', deps);
  });

  // ----- pdf ---------------------------------------------------------------------------------
  handle('pdf:plan', async (options) => {
    const o = obj(options, 'options', { optional: true });
    await waitReady();
    return call('pdf', 'planPdf', deps, o);
  });

  handle('pdf:start', async (options) => {
    const o = obj(options, 'options', { optional: true });
    await waitReady();
    return asJob(await call('pdf', 'startPdfJob', deps, o));
  });

  // ----- offset ------------------------------------------------------------------------------
  handle('offset:get', async () => {
    await waitReady();
    return call('offset', 'readOffset', deps);
  });

  handle('offset:save', async (v) => {
    const args = obj(v, 'offset');
    const value = {
      x_offset: num(args.x_offset, 'x offset', { min: -100000, max: 100000 }),
      y_offset: num(args.y_offset, 'y offset', { min: -100000, max: 100000 }),
      angle_offset: num(args.angle_offset, 'angle', { min: -360, max: 360, def: 0 }),
    };
    await waitReady();
    assertNotMutating();
    return call('offset', 'writeOffset', deps, value);
  });

  handle('offset:reset', async () => {
    await waitReady();
    assertNotMutating();
    return call('offset', 'resetOffset', deps);
  });

  handle('offset:calibration', async (paper) => {
    paperName(paper);
    await waitReady();
    return call('offset', 'calibrationFor', deps, paper);
  });

  handle('offset:generateCalibration', async (paper) => {
    paperName(paper);
    await waitReady();
    return asJob(await call('offset', 'startGenerateCalibrationJob', deps, paper));
  });

  handle('offset:shiftedCalibration', async (o) => {
    const args = obj(o, 'calibration');
    const request = {
      ...args,
      paper: paperName(args.paper),
      x: Math.round(num(args.x, 'x', { min: -100000, max: 100000, def: 0 })),
      y: Math.round(num(args.y, 'y', { min: -100000, max: 100000, def: 0 })),
      angle: num(args.angle, 'angle', { min: -360, max: 360, def: 0 }),
    };
    await waitReady();
    return asJob(await call('offset', 'startShiftedCalibrationJob', deps, request));
  });

  handle('offset:apply', async (o) => {
    const args = obj(o, 'request');
    const request = {
      ...args,
      pdfPath: withExt(absPath(args.pdfPath, 'PDF'), 'PDF', ['pdf']),
      x_offset: num(args.x_offset, 'x offset', { min: -100000, max: 100000, def: 0 }),
      y_offset: num(args.y_offset, 'y offset', { min: -100000, max: 100000, def: 0 }),
      angle_offset: num(args.angle_offset, 'angle', { min: -360, max: 360, def: 0 }),
      ppi: args.ppi === undefined || args.ppi === null ? null : int(args.ppi, 'ppi', { min: 1, max: 2400 }),
    };
    if (args.outputPath !== undefined && args.outputPath !== null) {
      request.outputPath = withExt(absPath(args.outputPath, 'output file'), 'output file', ['pdf']);
    } else {
      delete request.outputPath;
    }
    allowOpenPath(request.pdfPath);
    await waitReady();
    return asJob(await call('offset', 'startOffsetJob', deps, request));
  });

  handle('offset:pdfInfo', async (pdfPath) => {
    const abs = withExt(absPath(pdfPath, 'PDF'), 'PDF', ['pdf']);
    await waitReady();
    return call('offset', 'pdfInfo', deps, abs);
  });

  // ----- print -------------------------------------------------------------------------------
  handle('print:info', async () => {
    await waitReady();
    return call('print', 'printInfo', deps);
  });

  handle('print:openTemplate', async (templateFile) => {
    const abs = withExt(absPath(templateFile, 'template'), 'template', ['studio3']);
    const p = paths();
    if (!util.isInside(p.cuttingTemplatesDir, abs) && !util.isInside(p.scmCacheDir, abs)) {
      throw invalid('This cutting template is not one of the app\'s templates');
    }
    await waitReady();
    return call('print', 'openTemplate', deps, abs);
  });

  // ----- jobs --------------------------------------------------------------------------------
  handle('jobs:active', async () => (deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null));

  handle('jobs:history', async () => (deps.jobs && typeof deps.jobs.history === 'function' ? deps.jobs.history() : []));

  handle('jobs:cancel', async (jobId) => {
    jobIdOf(jobId);
    return deps.jobs && typeof deps.jobs.cancel === 'function' ? !!deps.jobs.cancel(jobId) : false;
  });

  handle('jobs:log', async (jobId) => {
    jobIdOf(jobId);
    return deps.jobs && typeof deps.jobs.getLog === 'function' ? deps.jobs.getLog(jobId) : '';
  });

  // ----- shell -------------------------------------------------------------------------------
  handle('shell:openPath', async (p) => openPathChecked(p));

  handle('shell:showItemInFolder', async (p) => {
    const abs = absPath(p, 'path');
    if (typeof deps.showItemInFolder === 'function') await deps.showItemInFolder(abs);
    else if (!deps.noAutoOpen) {
      if (!shell) throw unavailable('shell');
      shell.showItemInFolder(abs);
    }
    return true;
  });

  handle('shell:openExternal', async (url) => {
    const href = validateExternalUrl(url);
    if (typeof deps.openExternal === 'function') await deps.openExternal(href);
    else if (!deps.noAutoOpen) {
      if (!shell) throw unavailable('shell');
      await shell.openExternal(href);
    }
    return true;
  });

  // ----- dialog ------------------------------------------------------------------------------
  handle('dialog:openFiles', async (o) => {
    const { purpose, title, filters } = dialogArgs(o);
    const res = await showOpen({
      title, filters, defaultPath: defaultDirFor(purpose), properties: ['openFile', 'multiSelections', 'dontAddToRecent'],
    });
    if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) return [];
    rememberDir(purpose, path.dirname(res.filePaths[0]));
    res.filePaths.forEach(allowOpenPath);
    return res.filePaths;
  });

  handle('dialog:openFile', async (o) => {
    const { purpose, title, filters } = dialogArgs(o);
    const res = await showOpen({
      title, filters, defaultPath: defaultDirFor(purpose), properties: ['openFile', 'dontAddToRecent'],
    });
    if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) return null;
    const file = res.filePaths[0];
    rememberDir(purpose, path.dirname(file));
    allowOpenPath(file);
    return file;
  });

  handle('dialog:openFolder', async (o) => {
    const { purpose, title } = dialogArgs(o);
    const res = await showOpen({
      title, defaultPath: defaultDirFor(purpose), properties: ['openDirectory', 'createDirectory', 'dontAddToRecent'],
    });
    if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) return null;
    const dir = res.filePaths[0];
    rememberDir(purpose, dir);
    return dir;
  });

  handle('dialog:saveFile', async (o) => {
    const { purpose, title, filters, args } = dialogArgs(o);
    const defaultName = args.defaultName === undefined || args.defaultName === null
      ? ''
      : util.sanitizeFileName(str(args.defaultName, 'defaultName', { max: 255, allowEmpty: true }), { maxLen: 200 });
    const dir = defaultDirFor(purpose);
    const res = await showSave({
      title,
      filters,
      defaultPath: defaultName ? path.join(dir, defaultName) : dir,
      properties: ['createDirectory', 'showOverwriteConfirmation', 'dontAddToRecent'],
    });
    if (!res || res.canceled || typeof res.filePath !== 'string' || !res.filePath) return null;
    rememberDir(purpose, path.dirname(res.filePath));
    allowOpenPath(res.filePath);
    return res.filePath;
  });

  return { channels: channels.slice(), allowOpenPath, envStatus };
}

module.exports = { registerIpc, EVENT_CHANNELS, CARD_KINDS, OPENABLE_EXTENSIONS };
