'use strict';

/**
 * Electron main process entry (spec §9.12): userData, single instance, privileged scheme, settings,
 * logger, jobs, locks, helper, image protocol, IPC, window, security guards, job side effects
 * (power-save blocker, taskbar progress, notifications), quit-with-running-job flow, crash handling.
 *
 * Service modules written separately (jobs, locks, helper, workspace, cards, …) are loaded lazily
 * and every optional startup step is guarded: the window always opens, and a missing piece only
 * disables the features that need it.
 */

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { fileURLToPath } = require('node:url');
const electron = require('electron');

const {
  app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Notification, powerSaveBlocker, session, Menu,
  nativeTheme, screen,
} = electron;

const { getPaths } = require('./paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('./settings');
const { createLogger } = require('./logger');
const { registerPrivilegedSchemes, registerImageProtocol } = require('./protocol');
const { registerIpc } = require('./ipc');
const util = require('./util');

const APP_ID = 'com.mtgtoolkit.kirigami'; // must equal build.appId in package.json (shortcuts, notifications)
const PRODUCT_NAME = 'Kirigami';
const INDEX_HTML = path.join(__dirname, '..', 'renderer', 'index.html');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const MUTATING_JOB_KINDS = new Set(['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration']);
const CARD_CHANGING_JOB_KINDS = new Set(['fetch', 'samples', 'upscale']);
const LONG_JOB_MS = 30000;

const isTest = !!process.env.SCM_E2E;
const noAutoOpen = !!process.env.SCM_NO_AUTO_OPEN;

/** @type {Electron.BrowserWindow|null} */
let mainWindow = null;
let logger = null;
let settings = null;
let quitting = false;
let readyToQuit = false;
let powerBlockerId = null;
let lastProgressAt = 0;
let crashTimes = [];
let pendingNotice = null;
let lastErrorDialogAt = 0;
let loadErrorShown = false;
let expectedRendererCrash = false;
const runningJobs = new Map(); // jobId -> { title, kind, startedAt }
const shutdownHooks = new Set();
const liveNotifications = new Set();

// ---------------------------------------------------------------------------------------------
// Early logging (before the logger exists) and helpers
// ---------------------------------------------------------------------------------------------

function log(level, ...args) {
  try {
    if (logger) logger[level](...args);
    // eslint-disable-next-line no-console
    else (level === 'error' ? console.error : console.log)(`[${level}]`, ...args);
  } catch { /* never throw from logging */ }
}

/**
 * require('./<name>.js') or null when the module is missing / fails to load (logged).
 * @param {string} name
 * @returns {object|null}
 */
function optionalRequire(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`./${name}.js`);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND' && String(err.message).includes(`${name}.js`)) {
      log('warn', `Module ${name}.js is not available; features that need it are disabled.`);
    } else {
      log('error', `Module ${name}.js failed to load:`, err);
    }
    return null;
  }
}

function isAppUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('file:')) return false;
  try {
    const u = new URL(url);
    u.hash = '';
    u.search = '';
    return util.samePath(fileURLToPath(u), INDEX_HTML);
  } catch {
    return false;
  }
}

function isWebUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) && url.length <= 2081;
}

function liveWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function focusMainWindow() {
  const win = liveWindow();
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

// ---------------------------------------------------------------------------------------------
// deps (spec §12) — filled in during startup
// ---------------------------------------------------------------------------------------------

/**
 * Send an event to the renderer (jobs:event, settings:changed, cards:changed, app:notice).
 * @param {string} channel
 * @param {any} payload
 * @returns {boolean} sent
 */
function emit(channel, payload) {
  const win = liveWindow();
  if (!win) return false;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed()) return false;
  try {
    wc.send(channel, payload);
    return true;
  } catch (err) {
    log('warn', `Could not send "${channel}" to the window:`, err);
    return false;
  }
}

/**
 * Open a file/folder with the default app. Resolves '' on success or an error message (never
 * rejects). Honors SCM_NO_AUTO_OPEN (does nothing, reports success).
 * @param {string} p
 * @returns {Promise<string>}
 */
async function openPath(p) {
  if (noAutoOpen) {
    log('info', `[no-auto-open] would open ${p}`);
    return '';
  }
  try {
    return await shell.openPath(p);
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

/**
 * Reveal a file in Explorer/Finder (honors SCM_NO_AUTO_OPEN).
 * @param {string} p
 */
function showItemInFolder(p) {
  if (noAutoOpen) {
    log('info', `[no-auto-open] would show ${p}`);
    return;
  }
  try {
    shell.showItemInFolder(p);
  } catch (err) {
    log('warn', 'showItemInFolder failed:', err);
  }
}

/**
 * Open an http(s) URL in the default browser (honors SCM_NO_AUTO_OPEN). Never rejects.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function openExternal(url) {
  if (!isWebUrl(url)) {
    log('warn', `Refused to open a non-web link: ${String(url).slice(0, 200)}`);
    return false;
  }
  if (noAutoOpen) {
    log('info', `[no-auto-open] would open ${url}`);
    return true;
  }
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    log('warn', 'openExternal failed:', err);
    return false;
  }
}

/** The card-folder watcher handle lives in deps.watcher (other modules may replace it). */
function currentWatcher() {
  const w = deps.watcher;
  return w && typeof w === 'object' ? w : null;
}

function stopWatchers() {
  const current = currentWatcher();
  deps.watcher = null;
  if (current && typeof current.stop === 'function') {
    try {
      current.stop();
    } catch (err) {
      log('warn', 'Stopping the card folder watchers failed:', err);
    }
  }
}

function startWatchers() {
  stopWatchers();
  const cards = optionalRequire('cards');
  if (!cards || typeof cards.startWatching !== 'function') return null;
  try {
    deps.watcher = cards.startWatching(deps) || null;
    const w = currentWatcher();
    const busy = deps.jobs && typeof deps.jobs.isMutating === 'function' && deps.jobs.isMutating();
    if (busy && w && typeof w.pause === 'function') w.pause();
  } catch (err) {
    deps.watcher = null;
    log('warn', 'Could not watch the card folders:', err);
  }
  return currentWatcher();
}

/** @type {object} */
const deps = {
  app,
  electron: { shell, dialog, nativeImage, Notification, powerSaveBlocker },
  getPaths: null,
  /**
   * The active engine folder fed to getPaths() on every call (undefined = the engine bundled with the
   * app). Read again each time, so replacing this function (the engine updater does) switches every
   * later operation to another engine without a restart.
   * @returns {string|undefined}
   */
  getEngineDir: () => undefined,
  settings: null,
  jobs: null,
  locks: null,
  logger: null,
  helper: null,
  emit,
  isTest,
  noAutoOpen,
  openPath,
  showItemInFolder,
  // extras (documented in the build report)
  openExternal,
  getMainWindow: () => liveWindow(),
  ready: Promise.resolve({ ok: false }),
  watcher: null,
  hashCache: null,
  restartWatchers: () => startWatchers(),
  stopWatchers: () => stopWatchers(),
  /** Register an async function to run (max 3 s) before quitting, e.g. flushing a JSON writer. */
  addShutdownHook(fn) {
    if (typeof fn === 'function') shutdownHooks.add(fn);
    return () => shutdownHooks.delete(fn);
  },
};

// Test hook (main process only, never reachable from the renderer): lets Playwright's
// electronApp.evaluate() inspect state or start fake jobs. Enabled by SCM_E2E or SCM_TEST_HOOKS.
if (isTest || process.env.SCM_TEST_HOOKS) globalThis.__scmTest = { deps };

// ---------------------------------------------------------------------------------------------
// 1. userData  2. AppUserModelId + single instance  3. privileged scheme (all before ready)
// ---------------------------------------------------------------------------------------------

function configureUserData() {
  try {
    if (process.env.SCM_USER_DATA_DIR) {
      const dir = path.resolve(process.env.SCM_USER_DATA_DIR);
      fs.mkdirSync(dir, { recursive: true });
      app.setPath('userData', dir);
    } else if (!app.isPackaged) {
      const dir = path.join(app.getPath('appData'), `${PRODUCT_NAME} (dev)`);
      fs.mkdirSync(dir, { recursive: true });
      app.setPath('userData', dir);
    }
  } catch (err) {
    log('error', 'Could not set the user data folder:', err);
  }
}

configureUserData();
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);

const gotLock = process.env.SCM_DISABLE_SINGLE_INSTANCE ? true : app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  registerPrivilegedSchemes();
  boot();
}

// ---------------------------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------------------------

function boot() {
  try {
    logger = createLogger(path.join(app.getPath('userData'), 'logs'), {
      mirrorToConsole: !app.isPackaged || !!process.env.SCM_LOG_CONSOLE,
    });
    deps.logger = logger;
  } catch (err) {
    log('error', 'Could not create the log file:', err);
  }
  log('info', `${PRODUCT_NAME} ${app.getVersion()} starting (electron ${process.versions.electron}, ${process.platform} ${os.release()}, packaged=${app.isPackaged})`);

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', (reason) => log('error', 'Unhandled promise rejection:', reason));
  process.on('exit', () => {
    try { if (settings) settings.flushSync(); } catch { /* exiting */ }
  });

  app.on('second-instance', () => focusMainWindow());
  app.on('web-contents-created', (_event, contents) => guardWebContents(contents));
  app.on('child-process-gone', (_event, details) => log('warn', 'A helper process of the window stopped:', details));
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app.on('activate', () => {
    if (app.isReady() && settings && !liveWindow()) createWindow();
  });
  app.on('before-quit', (event) => {
    if (readyToQuit) return;
    event.preventDefault();
    void shutdown();
  });

  app.whenReady().then(startup).catch((err) => fatalStartupError(err));
}

function electronValues() {
  let documents;
  try {
    documents = app.getPath('documents');
  } catch {
    documents = path.join(os.homedir(), 'Documents');
  }
  return {
    isPackaged: app.isPackaged,
    appDir: app.getAppPath(),
    resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'),
    appData: app.getPath('appData'),
    documents,
    localAppData: process.env.LOCALAPPDATA || null,
    platform: process.platform,
    env: process.env,
  };
}

async function startup() {
  const base = electronValues();

  // Folders that do not depend on settings (nor on the engine).
  const initial = getPaths({ ...base, engineDir: deps.getEngineDir(), settings: {} });
  for (const dir of [initial.dataDir, initial.scmCacheDir, initial.logsDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log('error', `Could not create ${dir}:`, err);
    }
  }

  // Settings
  settings = createSettingsStore(path.join(base.userData, 'settings.json'), DEFAULT_SETTINGS, {
    onError: (err) => log('warn', '[settings]', err),
  });
  deps.settings = settings;
  deps.getPaths = () => getPaths({ ...base, engineDir: deps.getEngineDir(), settings: settings.get() });
  applyTheme(settings.get().theme);
  settings.onChange((next, meta) => {
    emit('settings:changed', next);
    if (!meta || !Array.isArray(meta.changedKeys) || meta.changedKeys.includes('theme')) applyTheme(next.theme);
  });
  if (settings.loadStatus === 'corrupt') {
    pendingNotice = {
      variant: 'warning',
      title: 'Your settings were reset',
      message: `The settings file was damaged, so default settings are used. A copy of the damaged file was kept: ${settings.backupPath}`,
    };
  }
  try {
    const p = deps.getPaths();
    log('info', `Paths: engine=${p.engineSourceDir} (${p.engineMode}) workspace=${p.workspaceDir} data=${p.dataDir} python=${p.pythonPath} output=${p.outputDir}`);
  } catch (err) {
    log('error', 'Could not compute the app folders:', err);
  }

  // Jobs, locks, helper (optional modules)
  const jobsModule = optionalRequire('jobs');
  if (jobsModule && typeof jobsModule.JobManager === 'function') {
    try {
      deps.jobs = new jobsModule.JobManager({ logsDir: initial.logsDir, scmCacheDir: initial.scmCacheDir });
      if (typeof deps.jobs.on === 'function') deps.jobs.on('event', onJobEvent);
    } catch (err) {
      deps.jobs = null;
      log('error', 'Could not start the task manager:', err);
    }
  }
  const locksModule = optionalRequire('locks');
  if (locksModule && typeof locksModule.createLocks === 'function') {
    try {
      deps.locks = locksModule.createLocks();
    } catch (err) {
      log('error', 'Could not create the locks:', err);
    }
  }
  const helperModule = optionalRequire('helper');
  if (helperModule && typeof helperModule.createHelper === 'function') {
    try {
      deps.helper = helperModule.createHelper(() => deps);
    } catch (err) {
      log('error', 'Could not create the Python helper:', err);
    }
  }
  // Shared image hash cache (<scmCacheDir>/hashes.json), flushed on quit.
  const scanModule = optionalRequire('scan');
  if (scanModule && typeof scanModule.createHashCache === 'function') {
    try {
      deps.hashCache = scanModule.createHashCache(path.join(initial.scmCacheDir, 'hashes.json'));
      if (deps.hashCache && typeof deps.hashCache.flush === 'function') deps.addShutdownHook(() => deps.hashCache && deps.hashCache.flush());
    } catch (err) {
      deps.hashCache = null;
      log('warn', 'Could not create the image hash cache:', err);
    }
  }

  // Protocol, IPC, session guards, menu, window
  try {
    registerImageProtocol(deps);
  } catch (err) {
    log('error', 'Could not register the image protocol:', err);
  }
  registerIpc(ipcMain, deps, {
    dialog,
    shell,
    webUtils: electron.webUtils,
    BrowserWindow,
    getMainWindow: () => liveWindow(),
    indexHtmlPath: INDEX_HTML,
  });
  configureSession(session.defaultSession);
  buildMenu();
  createWindow();

  // Startup tasks: workspace → cleanup → watchers (IPC handlers wait for this promise).
  deps.ready = runStartupTasks();
}

async function runStartupTasks() {
  const workspace = optionalRequire('workspace');
  if (!workspace || typeof workspace.ensureWorkspace !== 'function') return { ok: false, error: 'workspace module unavailable' };
  try {
    await workspace.ensureWorkspace(deps, makeTaskLog('workspace'));
  } catch (err) {
    log('warn', 'The card maker data folder is not ready yet (Setup will show it):', err);
    return { ok: false, error: err && err.message };
  }
  const active = deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (!active && typeof workspace.startupCleanup === 'function') {
    try {
      await workspace.startupCleanup(deps);
    } catch (err) {
      log('warn', 'Startup cleanup failed:', err);
    }
  }
  startWatchers();
  return { ok: true };
}

/** A log function (line, stream) that also has info/warn/error methods. */
function makeTaskLog(prefix) {
  const fn = (line, stream = 'info') => log(stream === 'stderr' || stream === 'error' ? 'warn' : 'info', `[${prefix}] ${line}`);
  fn.info = (...a) => log('info', `[${prefix}]`, ...a);
  fn.warn = (...a) => log('warn', `[${prefix}]`, ...a);
  fn.error = (...a) => log('error', `[${prefix}]`, ...a);
  return fn;
}

function fatalStartupError(err) {
  log('error', 'Startup failed:', err);
  try {
    dialog.showErrorBox(`${PRODUCT_NAME} could not start`, `${err && err.message ? err.message : err}\n\nDetails: ${logger ? logger.file : 'see the console'}`);
  } catch { /* no UI available */ }
  readyToQuit = true;
  app.exit(1);
}

// ---------------------------------------------------------------------------------------------
// Theme, session, menu, window
// ---------------------------------------------------------------------------------------------

function applyTheme(theme) {
  const value = theme === 'light' || theme === 'dark' ? theme : 'system';
  try {
    if (nativeTheme.themeSource !== value) nativeTheme.themeSource = value;
    const win = liveWindow();
    if (win) win.setBackgroundColor(backgroundFor(value));
  } catch (err) {
    log('warn', 'Could not apply the theme:', err);
  }
}

function backgroundFor(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#17181c' : '#f6f7f9';
}

function configureSession(ses) {
  try {
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    ses.setPermissionCheckHandler((_wc, permission) => permission === 'clipboard-sanitized-write');
    ses.on('will-download', (event) => {
      event.preventDefault();
      log('warn', 'Blocked a download from the window.');
    });
  } catch (err) {
    log('error', 'Could not configure the session guards:', err);
  }
}

function guardWebContents(contents) {
  contents.on('will-navigate', (event, legacyUrl) => {
    const url = (event && event.url) || legacyUrl;
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isWebUrl(url)) void openExternal(url);
    else log('warn', `Blocked navigation to ${String(url).slice(0, 200)}`);
  });
  contents.on('will-redirect', (event, legacyUrl) => {
    const url = (event && event.url) || legacyUrl;
    if (!isAppUrl(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void openExternal(url);
    return { action: 'deny' };
  });
}

function navigateRenderer(hash) {
  const win = liveWindow();
  if (win) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)}`).catch(() => {});
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' }, { role: 'editMenu' });
  if (!app.isPackaged) {
    template.push({
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { label: 'UI kitchen', click: () => navigateRenderer('#/kitchen') },
      ],
    });
  }
  try {
    Menu.setApplicationMenu(template.length ? Menu.buildFromTemplate(template) : null);
  } catch (err) {
    log('warn', 'Could not build the menu:', err);
  }
}

function windowSize() {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return { width: Math.min(1280, Math.max(1024, width)), height: Math.min(860, Math.max(700, height)) };
  } catch {
    return { width: 1280, height: 860 };
  }
}

function windowIcon() {
  const candidate = path.join(app.getAppPath(), 'build', 'icon.png');
  return !app.isPackaged && fs.existsSync(candidate) ? candidate : undefined;
}

function showLoadError(win, description) {
  if (loadErrorShown || win.isDestroyed()) return;
  loadErrorShown = true;
  const exists = fs.existsSync(INDEX_HTML);
  log('error', `The app window could not load ${INDEX_HTML} (${description}; file ${exists ? 'exists' : 'is missing'})`);
  const html = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${PRODUCT_NAME}</title>
<body style="font-family:'Segoe UI',system-ui,sans-serif;padding:40px;color:#222;background:#f6f7f9">
<h2>${PRODUCT_NAME} could not show its window</h2>
<p>Some of the app's files are missing or damaged. Please reinstall ${PRODUCT_NAME}.</p>
<p style="color:#666;font-size:13px">Technical details were saved in the log file.</p></body>`;
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => {});
  if (!win.isVisible()) win.show();
}

function createWindow() {
  const { width, height } = windowSize();
  const theme = settings ? settings.get().theme : 'system';
  const win = new BrowserWindow({
    width,
    height,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    title: PRODUCT_NAME,
    backgroundColor: backgroundFor(theme),
    icon: windowIcon(),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      webviewTag: false,
      navigateOnDragDrop: false,
    },
  });
  mainWindow = win;

  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, 10000);
  win.once('ready-to-show', () => {
    clearTimeout(showTimer);
    if (!win.isDestroyed()) win.show();
  });
  win.on('closed', () => {
    clearTimeout(showTimer);
    if (mainWindow === win) mainWindow = null;
  });
  win.on('focus', () => {
    try { win.flashFrame(false); } catch { /* ignore */ }
  });

  win.on('close', (event) => {
    if (readyToQuit) return;
    const active = activeJob();
    if (!active) return; // normal close → window-all-closed → app.quit() → before-quit → shutdown()
    event.preventDefault();
    void shutdown();
  });

  // Windows log-off / shutdown: before-quit is not emitted; save what we can synchronously.
  win.on('session-end', () => {
    log('warn', 'Windows session is ending.');
    try { if (settings) settings.flushSync(); } catch { /* ignore */ }
    const active = activeJob();
    if (active) {
      try { deps.jobs.cancel(active.jobId); } catch { /* ignore */ }
    }
  });

  const wc = win.webContents;
  wc.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3 /* aborted */) return;
    if (validatedURL && validatedURL.startsWith('data:')) return;
    showLoadError(win, `${errorCode} ${errorDescription}`);
  });
  wc.on('did-finish-load', () => {
    if (pendingNotice && isAppUrl(wc.getURL())) {
      emit('app:notice', pendingNotice);
      pendingNotice = null;
    }
  });
  wc.on('render-process-gone', (_event, details) => onRendererGone(win, details));
  wc.on('preload-error', (_event, preloadPath, error) => log('error', `Preload failed (${preloadPath}):`, error));
  wc.on('console-message', (details) => {
    // Keep renderer errors in the app log (helps support); Electron 44 passes a details object.
    try {
      const level = details && details.level;
      if (level === 'error') log('warn', `[renderer] ${details.message} (${details.sourceId || ''}:${details.lineNumber || ''})`);
    } catch { /* ignore */ }
  });

  let unresponsiveAbort = null;
  win.on('unresponsive', async () => {
    log('warn', 'The window stopped responding.');
    if (isTest || unresponsiveAbort || win.isDestroyed()) return;
    unresponsiveAbort = new AbortController();
    try {
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: PRODUCT_NAME,
        message: 'The window is not responding.',
        detail: 'You can wait, or reload the window. Running tasks continue in the background.',
        buttons: ['Reload the window', 'Wait'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        signal: unresponsiveAbort.signal,
      });
      if (response === 0 && !win.isDestroyed()) {
        pendingNotice = { variant: 'warning', title: 'The window was reloaded', message: 'The window stopped responding and was reloaded. Running tasks were not affected.' };
        expectedRendererCrash = true; // render-process-gone must not reload a second time
        win.webContents.forcefullyCrashRenderer();
        win.webContents.reload();
      }
    } catch (err) {
      log('warn', 'Unresponsive dialog failed:', err);
    } finally {
      unresponsiveAbort = null;
    }
  });
  win.on('responsive', () => {
    if (unresponsiveAbort) unresponsiveAbort.abort();
  });

  win.loadFile(INDEX_HTML).catch((err) => {
    // did-fail-load normally handled it already (showing the error page aborts this load).
    if (loadErrorShown) return;
    log('error', 'Loading the window failed:', err);
    showLoadError(win, err && err.message ? err.message : String(err));
  });
  return win;
}

function onRendererGone(win, details) {
  log('error', 'The window process stopped:', details);
  if (expectedRendererCrash) {
    expectedRendererCrash = false;
    return;
  }
  if (quitting || readyToQuit || win.isDestroyed()) return;
  if (details && details.reason === 'clean-exit') return;
  const now = Date.now();
  crashTimes = crashTimes.filter((t) => now - t < 60000);
  crashTimes.push(now);
  if (crashTimes.length > 3) {
    log('error', 'The window keeps crashing; not reloading automatically.');
    if (!isTest) {
      dialog.showMessageBox(win, {
        type: 'error',
        title: PRODUCT_NAME,
        message: 'The window keeps stopping unexpectedly.',
        detail: `Please restart ${PRODUCT_NAME}. Details were saved in the log file:\n${logger ? logger.file : ''}`,
        buttons: ['Reload anyway', 'Close'],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        if (response === 0 && !win.isDestroyed()) win.webContents.reload();
      }).catch(() => {});
    }
    return;
  }
  pendingNotice = pendingNotice || {
    variant: 'warning',
    title: 'The window was reloaded',
    message: 'The window stopped unexpectedly and was reloaded. Running tasks were not affected.',
  };
  try {
    win.webContents.reload();
  } catch (err) {
    log('error', 'Could not reload the window:', err);
  }
}

function onUncaughtException(err) {
  log('error', 'Uncaught exception:', err);
  if (isTest || !app.isReady()) return;
  const now = Date.now();
  if (now - lastErrorDialogAt < 10000) return;
  lastErrorDialogAt = now;
  const win = liveWindow();
  const options = {
    type: 'error',
    title: PRODUCT_NAME,
    message: 'Something unexpected went wrong in the app.',
    detail: `${err && err.message ? err.message : err}\n\nYou can keep working. Details were saved in the log file:\n${logger ? logger.file : ''}`,
    buttons: ['OK'],
    noLink: true,
  };
  (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Job side effects (spec §9.12 step 6) and forwarding
// ---------------------------------------------------------------------------------------------

function activeJob() {
  try {
    return deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  } catch {
    return null;
  }
}

function setTaskbarProgress(value) {
  const win = liveWindow();
  if (!win) return;
  try {
    win.setProgressBar(value);
  } catch { /* unsupported platform */ }
}

function progressFraction(evt) {
  if (Number.isFinite(evt.percent)) return Math.min(1, Math.max(0, evt.percent / 100));
  if (Number.isFinite(evt.current) && Number.isFinite(evt.total) && evt.total > 0) return Math.min(1, Math.max(0, evt.current / evt.total));
  return 2; // indeterminate
}

function startPowerBlocker() {
  try {
    if (powerBlockerId === null || !powerSaveBlocker.isStarted(powerBlockerId)) {
      powerBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch (err) {
    log('warn', 'Could not prevent sleep during the task:', err);
  }
}

function stopPowerBlocker() {
  try {
    if (powerBlockerId !== null && powerSaveBlocker.isStarted(powerBlockerId)) powerSaveBlocker.stop(powerBlockerId);
  } catch { /* ignore */ }
  powerBlockerId = null;
}

function notifyJobFinished(evt, meta) {
  if (isTest || evt.status === 'cancelled') return;
  const startedAt = meta && meta.startedAt ? new Date(meta.startedAt).getTime() : NaN;
  const duration = Number.isFinite(evt.durationMs) ? evt.durationMs : (Number.isFinite(startedAt) ? Date.now() - startedAt : 0);
  if (duration < LONG_JOB_MS) return;
  const win = liveWindow();
  if (!win || win.isFocused()) return;
  const title = (meta && meta.title) || evt.title || 'Your task';
  const body = evt.status === 'succeeded' ? `${title}: done.` : `${title}: something went wrong. Open the app for details.`;
  try {
    if (Notification.isSupported()) {
      const notification = new Notification({ title: PRODUCT_NAME, body });
      liveNotifications.add(notification);
      const release = () => liveNotifications.delete(notification);
      notification.on('click', () => { release(); focusMainWindow(); });
      notification.on('close', release);
      notification.show();
      setTimeout(release, 5 * 60 * 1000).unref();
    }
  } catch (err) {
    log('warn', 'Could not show a notification:', err);
  }
  try {
    win.flashFrame(true);
  } catch { /* ignore */ }
}

function onJobEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  emit('jobs:event', evt);
  try {
    if (evt.type === 'started') {
      runningJobs.set(evt.jobId, { title: evt.title, kind: evt.kind, startedAt: evt.startedAt || Date.now() });
      startPowerBlocker();
      setTaskbarProgress(2);
      lastProgressAt = 0;
      const w = currentWatcher();
      if (MUTATING_JOB_KINDS.has(evt.kind) && w && typeof w.pause === 'function') w.pause();
    } else if (evt.type === 'progress') {
      const now = Date.now();
      if (now - lastProgressAt >= 250) {
        lastProgressAt = now;
        setTaskbarProgress(progressFraction(evt));
      }
    } else if (evt.type === 'finished') {
      const meta = runningJobs.get(evt.jobId);
      runningJobs.delete(evt.jobId);
      if (runningJobs.size === 0) {
        stopPowerBlocker();
        setTaskbarProgress(-1);
      }
      notifyJobFinished(evt, meta);
      const kind = evt.kind || (meta && meta.kind);
      const w = currentWatcher();
      if (w && typeof w.resume === 'function' && MUTATING_JOB_KINDS.has(kind)) w.resume();
      if (kind === 'setup' && evt.status === 'succeeded' && !w) startWatchers();
      // Without a watcher (cards module missing / watch failed) still tell the window to refresh.
      if (!currentWatcher() && CARD_CHANGING_JOB_KINDS.has(kind)) emit('cards:changed', { reason: 'job', jobId: evt.jobId, kind });
    }
  } catch (err) {
    log('warn', 'Job side effect failed:', err);
  }
}

// ---------------------------------------------------------------------------------------------
// Quit (spec §9.12 step 7)
// ---------------------------------------------------------------------------------------------

function waitForJobFinished(jobId, timeoutMs) {
  return new Promise((resolve) => {
    const jobs = deps.jobs;
    const isDone = () => {
      const active = activeJob();
      return !active || active.jobId !== jobId;
    };
    if (!jobs || isDone()) {
      resolve(true);
      return;
    }
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      if (typeof jobs.off === 'function') jobs.off('event', listener);
      else if (typeof jobs.removeListener === 'function') jobs.removeListener('event', listener);
      resolve(value);
    };
    const listener = (evt) => {
      if (evt && evt.type === 'finished' && evt.jobId === jobId) finish(true);
    };
    if (typeof jobs.on === 'function') jobs.on('event', listener);
    const poll = setInterval(() => { if (isDone()) finish(true); }, 200);
    const timer = setTimeout(() => finish(isDone()), timeoutMs);
  });
}

async function cleanupJobLeftovers(jobId) {
  if (typeof jobId !== 'string' || !/^[\w.-]+$/.test(jobId)) return;
  let p;
  try {
    p = deps.getPaths();
  } catch {
    return;
  }
  const targets = [path.join(p.stageRoot, jobId), path.join(p.upscaledRoot, '.staging', jobId)];
  for (const target of targets) {
    await fsp.rm(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  try {
    for (const name of await fsp.readdir(p.outputDir)) {
      if (name.startsWith('.') && name.includes(`.partial-${jobId}`)) {
        await fsp.rm(path.join(p.outputDir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
      }
    }
  } catch { /* output folder missing */ }
}

async function confirmStopJob(active) {
  const win = liveWindow();
  const options = {
    type: 'warning',
    title: PRODUCT_NAME,
    message: `Stop "${active.title || 'the current task'}" and quit?`,
    detail: 'The task is not finished. If you quit now it is stopped, and you can start it again later.',
    buttons: ['Stop and quit', 'Keep working'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  try {
    const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
    return response === 0;
  } catch (err) {
    log('warn', 'Quit confirmation failed:', err);
    return true;
  }
}

async function runShutdownHooks() {
  const tasks = [settings ? settings.flush() : Promise.resolve()];
  for (const hook of shutdownHooks) {
    tasks.push(Promise.resolve().then(hook).catch((err) => log('warn', 'Shutdown hook failed:', err)));
  }
  let timer;
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise((resolve) => { timer = setTimeout(resolve, 3000); }),
  ]);
  clearTimeout(timer);
}

/**
 * Quit sequence: confirm when a job runs (not in E2E), cancel it, wait for 'finished' (5 s, then
 * cancel again), remove its staging/partial files, flush settings and hooks, then quit. Re-entry safe.
 */
async function shutdown() {
  if (quitting || readyToQuit) return;
  quitting = true;
  try {
    const active = activeJob();
    if (active) {
      if (!isTest && !(await confirmStopJob(active))) {
        quitting = false;
        return;
      }
      log('info', `Quitting: stopping "${active.title}" (${active.jobId})`);
      try { deps.jobs.cancel(active.jobId); } catch (err) { log('warn', 'Cancel failed:', err); }
      let finished = await waitForJobFinished(active.jobId, 5000);
      if (!finished) {
        log('warn', 'The task did not stop within 5 s; stopping it again.');
        try { deps.jobs.cancel(active.jobId); } catch { /* ignore */ }
        finished = await waitForJobFinished(active.jobId, 2000);
      }
      await cleanupJobLeftovers(active.jobId);
    }
    stopWatchers();
    stopPowerBlocker();
    await runShutdownHooks();
  } catch (err) {
    log('error', 'Problem while quitting:', err);
  }
  log('info', 'Quitting.');
  readyToQuit = true;
  app.quit();
}
