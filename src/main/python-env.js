'use strict';

/**
 * "Card maker components" = the Python environment that runs the engine.
 *
 * - runtimeRequirementsFile(): engine requirements.txt minus maintainer-only tools
 *   (ezdxf, pyautogui, pywinauto, split-image), pins kept -> scm-cache/requirements-runtime.txt
 * - checkEnv(): cached status { ready, workspace, python, uv, upscayl, silhouetteStudio }
 * - startSetupJob(): job 'setup' with steps workspace -> python -> packages -> verify, run under
 *   the exclusive Python lock. Packaged builds use the bundled uv only; development builds use
 *   uv (bundled or on PATH) or fall back to `python -m venv` + pip.
 * - usePython(): switch to a user-chosen python.exe (or back to the default venv).
 *
 * `--clear` is only ever passed to `uv venv` for the app-owned venv (`<dataDir>/venv` with a
 * managed engine, see paths.js) when it is unhealthy. The venv of a linked engine checkout and
 * custom environments are never cleared.
 */

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { ensureWorkspace, inspectWorkspace } = require('./workspace');

const fsp = fs.promises;

const MAINTAINER_ONLY_DISTS = new Set(['ezdxf', 'pyautogui', 'pywinauto', 'split-image']);
const ENV_CHECK_TIMEOUT_MS = 60000;
const SMOKE_TIMEOUT_MS = 180000;
const VERSION_PROBE_TIMEOUT_MS = 15000;
const VENV_TIMEOUT_MS = 15 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 30 * 60 * 1000;
const MIN_PYTHON = Object.freeze([3, 10]);
const VENV_MIN_PYTHON = Object.freeze([3, 12]);
const VENV_PYTHON_REQUEST = '3.12';
const MARKER_NAME = '.scm-requirements.sha1';

const SETUP_STEPS = Object.freeze([
  { id: 'workspace', label: 'Card maker data folder' },
  { id: 'python', label: 'Python' },
  { id: 'packages', label: 'Card maker components' },
  { id: 'verify', label: 'Final check' },
]);

/** deps -> { cache: {key, status}|null, inflight: {key, promise}|null } */
const states = new WeakMap();

function stateFor(deps) {
  let state = states.get(deps);
  if (!state) {
    state = { cache: null, inflight: null };
    states.set(deps, state);
  }
  return state;
}

/** A user-facing error (errors.friendlyError passes `friendly: true` errors through unchanged). */
function setupError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, friendly: true, details: '' }, extra);
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

async function statSafe(p) {
  if (!p) return null;
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function isFileSync(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function warn(deps, message) {
  try {
    if (deps && deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn(message);
  } catch {
    /* ignore */
  }
}

function activeJob(deps) {
  try {
    return deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  } catch {
    return null;
  }
}

function pythonEnvFn() {
  try {
    const fn = require('./jobs').pythonEnv;
    if (typeof fn === 'function') return fn;
  } catch {
    /* fall back */
  }
  return require('./helper').fallbackPythonEnv;
}

// ------------------------------------------------------------------------------------------
// Requirements
// ------------------------------------------------------------------------------------------

/**
 * Normalized distribution name of a requirements.txt line (PEP 503), or null for comments,
 * blank lines and option lines (-r, -e, --index-url ...).
 * @param {string} line
 * @returns {string|null}
 */
function requirementName(line) {
  const text = String(line).trim();
  if (!text || text.startsWith('#') || text.startsWith('-')) return null;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(text);
  return m ? m[1].toLowerCase().replace(/[-_.]+/g, '-') : null;
}

/**
 * Runtime subset of the engine's requirements.txt (maintainer-only tools removed, pins kept).
 * @param {string} text requirements.txt content
 * @returns {string} normalized text ending with a single newline
 */
function buildRuntimeRequirements(text) {
  const lines = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/);
  const kept = lines.filter((line) => !MAINTAINER_ONLY_DISTS.has(requirementName(line))).map((line) => line.trimEnd());
  while (kept.length && kept[kept.length - 1] === '') kept.pop();
  return `${kept.join('\n')}\n`;
}

/**
 * Write (only when changed) and return `<scmCacheDir>/requirements-runtime.txt`, derived from
 * the workspace requirements.txt (falls back to the engine source's).
 * @param {object} deps
 * @returns {Promise<string>} absolute path
 */
async function runtimeRequirementsFile(deps) {
  const paths = deps.getPaths();
  let text = null;
  for (const candidate of [path.join(paths.workspaceDir, 'requirements.txt'), path.join(paths.engineSourceDir, 'requirements.txt')]) {
    try {
      text = await fsp.readFile(candidate, 'utf8');
      break;
    } catch {
      /* next */
    }
  }
  if (text === null) {
    throw setupError('The card maker files are incomplete (requirements.txt is missing). Please reinstall Kirigami.', 'REQUIREMENTS_MISSING');
  }
  const runtime = buildRuntimeRequirements(text);
  const file = path.join(paths.scmCacheDir, 'requirements-runtime.txt');
  const existing = await fsp.readFile(file, 'utf8').catch(() => null);
  if (existing !== runtime) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, runtime, 'utf8');
    try {
      await fsp.rename(tmp, file);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      if ((await fsp.readFile(file, 'utf8').catch(() => null)) !== runtime) throw err;
    }
  }
  return file;
}

/**
 * Where the "installed requirements" marker lives: `<venvDir>/.scm-requirements.sha1` for the
 * venv, or a per-interpreter file in scm-cache for a custom Python (never inside the user's Python).
 * @param {object} paths
 * @param {object} settings
 * @returns {string}
 */
function markerFile(paths, settings) {
  if (settings && settings.pythonPath) {
    const id = sha1(path.resolve(settings.pythonPath).toLowerCase()).slice(0, 12);
    return path.join(paths.scmCacheDir, `custom-python-${id}${MARKER_NAME}`);
  }
  return path.join(paths.venvDir, MARKER_NAME);
}

async function readMarker(file) {
  try {
    return (await fsp.readFile(file, 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

async function writeMarker(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${value}\n`, 'utf8');
}

// ------------------------------------------------------------------------------------------
// Python / uv discovery
// ------------------------------------------------------------------------------------------

/**
 * Parse `Python 3.12.3` (from `python --version`, stdout or stderr).
 * @param {string} text
 * @returns {{major:number, minor:number, patch:number, text:string}|null}
 */
function parsePythonVersion(text) {
  const m = /^Python (\d+)\.(\d+)(?:\.(\d+))?/m.exec(String(text || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: m[3] === undefined ? 0 : +m[3], text: `${m[1]}.${m[2]}${m[3] === undefined ? '' : `.${m[3]}`}` };
}

function versionAtLeast(version, [major, minor]) {
  if (!version) return false;
  return version.major > major || (version.major === major && version.minor >= minor);
}

/**
 * Locate uv: the bundled binary first; in development also `uv` on PATH.
 * @param {object} deps
 * @param {{env?: object, platform?: string}} [options]
 * @returns {{available:boolean, path:string|null, source:'bundled'|'path'|null}}
 */
function findUv(deps, { env = process.env, platform = process.platform } = {}) {
  const paths = deps.getPaths();
  if (paths.bundledUv && isFileSync(paths.bundledUv)) return { available: true, path: paths.bundledUv, source: 'bundled' };
  if (!paths.isDev) return { available: false, path: null, source: null };
  const exeName = platform === 'win32' ? 'uv.exe' : 'uv';
  const searchPath = env.PATH || env.Path || env.path || '';
  for (const raw of searchPath.split(platform === 'win32' ? ';' : ':')) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    if (isFileSync(candidate)) return { available: true, path: candidate, source: 'path' };
  }
  return { available: false, path: null, source: null };
}

function volumeOf(p, platform) {
  if (!p) return null;
  const resolved = path.resolve(p);
  if (platform === 'win32') return path.win32.parse(resolved).root.toLowerCase();
  let current = resolved;
  for (;;) {
    try {
      return fs.statSync(current).dev;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Environment variables for uv (merged into pythonEnv by the caller).
 * @param {object} paths
 * @param {{platform?: string}} [options]
 * @returns {Record<string,string>}
 */
function uvEnvVars(paths, { platform = process.platform } = {}) {
  const vars = {
    UV_PYTHON_INSTALL_DIR: paths.uvPythonDir,
    UV_CACHE_DIR: paths.uvCacheDir,
    UV_NO_PROGRESS: '1',
    UV_MANAGED_PYTHON: '1',
    UV_NO_CONFIG: '1',
    UV_PYTHON_DOWNLOADS: 'automatic',
  };
  if (platform === 'win32') vars.UV_SYSTEM_CERTS = '1';
  const cacheVolume = volumeOf(paths.uvCacheDir, platform);
  const venvVolume = volumeOf(paths.venvDir, platform);
  if (cacheVolume !== null && venvVolume !== null && cacheVolume !== venvVolume) vars.UV_LINK_MODE = 'copy';
  return vars;
}

/**
 * Short progress label for a uv / pip output line (null when the line is not interesting).
 * @param {string} line
 * @returns {string|null}
 */
function setupProgressLabel(line) {
  const s = String(line || '').trim();
  let m;
  if ((m = /^Downloading cpython-(\d+\.\d+(?:\.\d+)?)/i.exec(s))) return `Downloading Python ${m[1]}...`;
  if ((m = /^Using (?:CPython|Python) (\d+\.\d+(?:\.\d+)?)/i.exec(s))) return `Using Python ${m[1]}`;
  if (/^Creating virtual environment/i.test(s)) return 'Creating the Python environment...';
  if ((m = /^Resolved (\d+) packages?/i.exec(s))) return `Found ${m[1]} components`;
  if ((m = /^Prepared (\d+) packages?/i.exec(s))) return `Downloaded ${m[1]} components`;
  if ((m = /^Installed (\d+) packages?/i.exec(s))) return `Installed ${m[1]} components`;
  if (/^(?:Audited|Checked) \d+ packages?/i.test(s)) return 'Components already installed';
  if ((m = /^Downloading (\S+)/i.exec(s))) return `Downloading ${m[1]}...`;
  if ((m = /^Downloaded (\S+)/i.exec(s))) return `Downloaded ${m[1]}`;
  if ((m = /^Collecting (\S+)/i.exec(s))) return `Downloading ${m[1]}...`;
  if (/^Installing collected packages/i.test(s)) return 'Installing components...';
  if (/^Successfully installed/i.test(s)) return 'Components installed';
  return null;
}

function runCapture(cmd, args, { timeoutMs = VERSION_PROBE_TIMEOUT_MS, spawnImpl = child_process.spawn, env } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let child;
    let done = false;
    let timer = null;
    const finish = (result) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code: null, error: null, timedOut: false, ...result, output: Buffer.concat(chunks).toString('utf8') });
    };
    try {
      child = spawnImpl(cmd, args, { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ error });
      return;
    }
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* gone */
      }
      finish({ timedOut: true });
    }, timeoutMs);
    if (child.stdout) child.stdout.on('data', (c) => chunks.push(c));
    if (child.stderr) child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', (error) => finish({ error }));
    child.on('close', (code) => finish({ code }));
  });
}

async function probePythonVersion(exe, { spawnImpl, scmCacheDir } = {}) {
  const env = pythonEnvFn()(process.env, {}, scmCacheDir);
  const result = await runCapture(exe, ['--version'], { spawnImpl, env, timeoutMs: VERSION_PROBE_TIMEOUT_MS });
  if (result.code !== 0) return null;
  return parsePythonVersion(result.output);
}

// ------------------------------------------------------------------------------------------
// Status
// ------------------------------------------------------------------------------------------

function isBusyError(err) {
  return !!err && (err.pythonBusy === true || err.code === 'PYTHON_BUSY' || err.code === 'PYTHON_SETUP' || /^Setting up the card maker components/i.test(String(err.message || '')));
}

function samePathSync(a, b) {
  const norm = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? path.resolve(p).toLowerCase() : path.resolve(p));
  if (norm(a) === norm(b)) return true;
  try {
    return norm(fs.realpathSync.native(a)) === norm(fs.realpathSync.native(b));
  } catch {
    return false;
  }
}

/**
 * Why a venv is not usable even though its python.exe starts, or null when it is fine.
 * Without pyvenv.cfg the venv launcher silently runs the base interpreter (sys.prefix is
 * then the base Python, not the venv), so the env-check's prefix must point at the venv.
 * @param {object|null} check env-check result
 * @param {string} venvDir
 * @returns {Promise<string|null>}
 */
async function venvProblem(check, venvDir) {
  const cfg = await statSafe(path.join(venvDir, 'pyvenv.cfg'));
  if (!cfg || !cfg.isFile()) return 'pyvenv.cfg is missing';
  if (check && check.isVenv === false) return `Python runs outside the environment (${check.prefix || 'unknown prefix'})`;
  if (check && check.prefix && !samePathSync(check.prefix, venvDir)) return `Python belongs to another environment (${check.prefix})`;
  return null;
}

async function pythonStatus(deps, paths, settings, envCheck) {
  const source = settings && settings.pythonPath ? 'custom' : 'venv';
  const base = {
    ok: false,
    path: paths.pythonPath || null,
    executable: null,
    version: null,
    packagesOk: false,
    missing: [],
    outdated: [],
    upToDate: false,
    error: null,
    code: null,
    source,
    appOwned: !!paths.appOwnedVenv,
    venvDir: source === 'venv' ? paths.venvDir : null,
  };
  const st = await statSafe(paths.pythonPath);
  if (!st || !st.isFile()) {
    return {
      ...base,
      code: 'NOT_INSTALLED',
      error: source === 'custom' ? "The Python you chose can't be found anymore." : 'The card maker components are not installed yet.',
    };
  }
  let reqFile;
  try {
    reqFile = await runtimeRequirementsFile(deps);
  } catch (err) {
    return { ...base, code: err.code || 'REQUIREMENTS_MISSING', error: err.message };
  }
  let check = envCheck;
  if (!check) {
    try {
      check = await deps.helper.run('env-check', ['--requirements', reqFile], { timeoutMs: ENV_CHECK_TIMEOUT_MS });
    } catch (err) {
      if (isBusyError(err)) throw err;
      return { ...base, code: err.code || 'ENV_CHECK_FAILED', error: err.message || String(err) };
    }
  }
  const reqSha = sha1(await fsp.readFile(reqFile));
  const upToDate = (await readMarker(markerFile(paths, settings))) === reqSha;
  const missing = Array.isArray(check.missing) ? check.missing : [];
  const brokenVenv = source === 'venv' ? await venvProblem(check, paths.venvDir) : null;
  let error = null;
  let code = null;
  if (brokenVenv) {
    error = `The card maker components are damaged (${brokenVenv}). Open Settings and choose Repair components.`;
    code = 'VENV_BROKEN';
  } else if (check.pythonOk === false) {
    error = `Python ${check.python || ''} is too old. Python 3.12 or newer is needed.`.replace('  ', ' ');
    code = 'PYTHON_TOO_OLD';
  } else if (!check.ok) {
    error = `Some card maker components are missing (${missing.join(', ') || 'unknown'}).`;
    code = 'MISSING_PACKAGES';
  } else if (base.appOwned && !upToDate) {
    error = 'The card maker components need an update.';
    code = 'NEEDS_UPDATE';
  }
  return {
    ...base,
    ok: true,
    executable: check.executable || null,
    version: check.python || null,
    packagesOk: !!check.ok,
    missing,
    outdated: Array.isArray(check.mismatched) ? check.mismatched : [],
    upToDate,
    error,
    code,
  };
}

async function safeWorkspace(deps) {
  try {
    return await inspectWorkspace(deps);
  } catch (err) {
    const paths = deps.getPaths();
    return { ok: false, path: paths.workspaceDir, mode: 'invalid', external: false, needsUpdate: false, error: err.message };
  }
}

/** Optional injection point (tests): deps.seams = { upscayl, registry, spawnImpl }. */
function seam(deps, name, load) {
  const injected = deps && deps.seams && deps.seams[name];
  return injected || load();
}

async function safeUpscayl(deps, refresh) {
  const fallback = (error) => ({ found: false, binPath: null, modelsDir: null, customModelsDir: null, version: null, source: null, models: [], gpus: null, error });
  try {
    const mod = seam(deps, 'upscayl', () => require('./upscayl'));
    if (typeof mod.getUpscaylStatus !== 'function') return fallback('Upscayl detection is unavailable.');
    return (await mod.getUpscaylStatus(deps, { refresh })) || fallback(null);
  } catch (err) {
    warn(deps, `Upscayl detection failed: ${err.message}`);
    return fallback(err.message);
  }
}

async function safeSilhouette(deps, refresh) {
  try {
    return await seam(deps, 'registry', () => require('./registry')).findSilhouetteStudio({ refresh, logger: deps.logger });
  } catch (err) {
    warn(deps, `Silhouette Studio detection failed: ${err.message}`);
    return { found: false, path: null, version: null, name: null, installLocation: null };
  }
}

function safeUv(deps) {
  try {
    const uv = findUv(deps);
    return { available: uv.available, path: uv.path, source: uv.source };
  } catch {
    return { available: false, path: null, source: null };
  }
}

async function computeStatus(deps, { refresh = false, envCheck = null } = {}) {
  const paths = deps.getPaths();
  const settings = deps.settings.get();
  const [workspace, python, upscayl, silhouetteStudio] = await Promise.all([
    safeWorkspace(deps),
    pythonStatus(deps, paths, settings, envCheck),
    safeUpscayl(deps, refresh),
    safeSilhouette(deps, refresh),
  ]);
  const ready = !!(workspace.ok && python.ok && python.packagesOk && (!python.appOwned || python.upToDate) && !python.code);
  return { ready, busy: false, workspace, python, uv: safeUv(deps), upscayl, silhouetteStudio, checkedAt: new Date().toISOString() };
}

function statusKey(deps) {
  const paths = deps.getPaths();
  return JSON.stringify([paths.workspaceDir, paths.pythonPath, paths.venvDir]);
}

function storeStatus(deps, status) {
  stateFor(deps).cache = { key: statusKey(deps), status };
  return status;
}

/**
 * Environment status (cached; `{ refresh: true }` re-checks).
 * `ready` = workspace ok + Python runs + all runtime packages importable (+ for the app-owned
 * venv: installed with the current requirements). While the setup job holds the exclusive
 * Python lock, the previous status is returned with `busy: true`.
 *
 * @param {object} deps
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<{ready:boolean, busy:boolean, workspace:object, python:object, uv:object, upscayl:object, silhouetteStudio:object, checkedAt:string}>}
 */
async function checkEnv(deps, { refresh = false } = {}) {
  const state = stateFor(deps);
  const key = statusKey(deps);
  if (!refresh && state.cache && state.cache.key === key) return state.cache.status;
  if (state.inflight && state.inflight.key === key) return state.inflight.promise;
  const promise = (async () => {
    try {
      return storeStatus(deps, await computeStatus(deps, { refresh }));
    } catch (err) {
      if (!isBusyError(err)) throw err;
      const previous = state.cache && state.cache.key === key ? state.cache.status : null;
      if (previous) return { ...previous, busy: true };
      const paths = deps.getPaths();
      return {
        ready: false,
        busy: true,
        workspace: await safeWorkspace(deps),
        python: { ok: false, path: paths.pythonPath, executable: null, version: null, packagesOk: false, missing: [], outdated: [], upToDate: false, error: err.message, code: 'PYTHON_BUSY', source: deps.settings.get().pythonPath ? 'custom' : 'venv', appOwned: !!paths.appOwnedVenv, venvDir: paths.venvDir },
        uv: safeUv(deps),
        upscayl: await safeUpscayl(deps, false),
        silhouetteStudio: await safeSilhouette(deps, false),
        checkedAt: new Date().toISOString(),
      };
    }
  })();
  state.inflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (state.inflight && state.inflight.promise === promise) state.inflight = null;
  }
}

/** Forget the cached environment status (after workspace/Python changes). */
function invalidateEnvCache(deps) {
  const state = stateFor(deps);
  state.cache = null;
}

// ------------------------------------------------------------------------------------------
// Choosing a Python
// ------------------------------------------------------------------------------------------

/**
 * Use a specific python.exe (validated: absolute, existing, .exe on Windows, Python >= 3.10)
 * or null to go back to the default venv. Refused while a job runs.
 * @param {object} deps
 * @param {string|null} exe
 * @param {{platform?: string, spawnImpl?: Function}} [options] test seams
 * @returns {Promise<object>} refreshed checkEnv status
 */
async function usePython(deps, exe, { platform = process.platform, spawnImpl } = {}) {
  const active = activeJob(deps);
  if (active) throw setupError(`BUSY: wait until "${active.title || active.kind || 'the current task'}" finishes`, 'BUSY');
  if (exe === null || exe === undefined || exe === '') {
    deps.settings.update({ pythonPath: null }, { internal: true });
  } else {
    if (typeof exe !== 'string') throw new TypeError('usePython: expected a file path or null');
    if (!path.isAbsolute(exe)) throw setupError('Choose the python.exe file itself (a complete path).', 'BAD_PYTHON');
    const resolved = path.resolve(exe);
    if (platform === 'win32' && !/\.exe$/i.test(resolved)) throw setupError('Choose a python.exe file.', 'BAD_PYTHON');
    const st = await statSafe(resolved);
    if (!st || !st.isFile()) throw setupError("That file doesn't exist.", 'BAD_PYTHON');
    const version = await probePythonVersion(resolved, { spawnImpl, scmCacheDir: deps.getPaths().scmCacheDir });
    if (!version) throw setupError("That file doesn't look like a working Python.", 'BAD_PYTHON');
    if (!versionAtLeast(version, MIN_PYTHON)) throw setupError(`Python ${version.text} is too old. Choose Python 3.12 or newer.`, 'PYTHON_TOO_OLD');
    deps.settings.update({ pythonPath: resolved }, { internal: true });
  }
  invalidateEnvCache(deps);
  try {
    if (deps.helper && typeof deps.helper.invalidate === 'function') deps.helper.invalidate();
  } catch {
    /* ignore */
  }
  return checkEnv(deps, { refresh: true });
}

/**
 * "Repair in the app's own location": use `<dataDir>/venv` (no custom Python), then the caller
 * starts the setup job. Refused while a job runs.
 * @param {object} deps
 * @returns {Promise<object>} refreshed checkEnv status
 */
async function useAppVenv(deps) {
  const active = activeJob(deps);
  if (active) throw setupError(`BUSY: wait until "${active.title || active.kind || 'the current task'}" finishes`, 'BUSY');
  const paths = deps.getPaths();
  // Managed engine (packaged, and `npm start`): <dataDir>/venv IS the default location, so clear the
  // setting instead of pinning it (paths.appOwnedVenv requires venvDir unset; otherwise update checks
  // and --clear repairs stop). A linked engine defaults to its own venv, so the data folder is pinned.
  const venvDir = paths.engineMode === 'linked' ? path.join(paths.dataDir, 'venv') : null;
  deps.settings.update({ pythonPath: null, venvDir }, { internal: true });
  invalidateEnvCache(deps);
  try {
    if (deps.helper && typeof deps.helper.invalidate === 'function') deps.helper.invalidate();
  } catch {
    /* ignore */
  }
  return checkEnv(deps, { refresh: true });
}

// ------------------------------------------------------------------------------------------
// Setup job
// ------------------------------------------------------------------------------------------

function isCancelled(err, ctx) {
  return !!(err && (err.name === 'CancelledError' || err.code === 'CANCELLED' || err.cancelled)) || !!(ctx && ctx.cancelled);
}

/**
 * Turn a failed uv/pip/python process (JobProcessError-like: stderrTail, stdoutTail, command)
 * into a user-facing error: NETWORK, DISK_FULL, ACCESS_DENIED, START_FAILED or SETUP_FAILED.
 * @param {Error & {stderrTail?: string[], stdoutTail?: string[], command?: string}} err
 * @param {string} what what was being done, e.g. 'install the card maker components'
 * @returns {Error & {code: string, details: string, friendly: true}}
 */
function explainFailure(err, what) {
  const tail = [].concat(err && err.stderrTail ? err.stderrTail : [], err && err.stdoutTail ? err.stdoutTail : []).join('\n');
  const text = `${(err && err.message) || ''}\n${tail}`;
  let message;
  let code;
  if (/no space left|not enough space|os error 112\b|ENOSPC|disk (?:is )?full/i.test(text)) {
    message = 'Your disk is full. Free some space, then try again.';
    code = 'DISK_FULL';
  } else if (/dns error|failed to fetch|failed to download|error sending request|connection (?:refused|reset|aborted|closed)|could not connect|tcp connect|network is unreachable|timed out|os error 1100[14]\b|os error 10060\b|getaddrinfo|no such host|certificate|tls|ssl/i.test(text)) {
    message = "Couldn't download the card maker components. Check your internet connection (antivirus HTTPS scanning can also block it), then try again.";
    code = 'NETWORK';
  } else if (/access is denied|permission denied|os error 5\b|os error 32\b|EPERM|EACCES|being used by another process/i.test(text)) {
    message = 'Windows or your antivirus blocked the installation. Close programs that may be using these files, then try again.';
    code = 'ACCESS_DENIED';
  } else if (err && (err.code === 'ENOENT' || /could not start/i.test(err.message || ''))) {
    message = `Could not start the installer to ${what}.`;
    code = 'START_FAILED';
  } else {
    message = `Could not ${what}.`;
    code = 'SETUP_FAILED';
  }
  return setupError(message, code, {
    details: [err && err.message, tail, err && err.command].filter(Boolean).join('\n'),
    cause: err,
  });
}

function makeProgress(ctx) {
  let last = 0;
  return (percent, label) => {
    const value = percent === null ? null : Math.max(last, Math.min(100, Math.round(percent)));
    if (value !== null) last = value;
    try {
      ctx.progress({ percent: value, label });
    } catch {
      /* ignore */
    }
  };
}

async function spawnStep(ctx, cmd, args, { cwd, env, timeoutMs, what, onLine }) {
  try {
    return await ctx.spawn(cmd, args, { cwd, env, timeoutMs, onLine });
  } catch (err) {
    if (isCancelled(err, ctx)) throw err;
    throw explainFailure(err, what);
  }
}

function setupLineHandler(progress, from, to) {
  let total = 0;
  let done = 0;
  return (line) => {
    const text = String(line || '');
    const resolved = /^\s*Resolved (\d+) packages?/i.exec(text);
    if (resolved) total = Number(resolved[1]);
    if (/^\s*\+\s+\S/.test(text) || /^Collecting \S/i.test(text)) done += 1;
    const label = setupProgressLabel(text);
    if (label) {
      const percent = total > 0 ? from + ((to - from) * Math.min(done, total)) / total : null;
      progress(percent, label);
    }
  };
}

async function findSystemPython(ctx) {
  const candidates = [
    ['py', ['-3.12']],
    ['py', ['-3']],
    ['python', []],
    ['python3', []],
  ];
  for (const [cmd, args] of candidates) {
    const lines = [];
    try {
      await ctx.spawn(cmd, [...args, '--version'], {
        env: ctx.pythonEnv({}),
        allowNonZero: true,
        timeoutMs: VERSION_PROBE_TIMEOUT_MS,
        onLine: (line) => lines.push(String(line)),
      });
    } catch (err) {
      if (isCancelled(err, ctx)) throw err;
      continue;
    }
    const version = parsePythonVersion(lines.join('\n'));
    if (versionAtLeast(version, VENV_MIN_PYTHON)) {
      ctx.log(`Found Python ${version.text} (${[cmd, ...args].join(' ')})`);
      return { cmd, args, version };
    }
  }
  return null;
}

async function dirHasEntries(dir) {
  try {
    return (await fsp.readdir(dir)).length > 0;
  } catch {
    return false;
  }
}

async function createVenv(ctx, deps, paths, { clear, progress }) {
  const uv = findUv(deps);
  const parent = path.dirname(paths.venvDir);
  await fsp.mkdir(parent, { recursive: true });
  if (uv.available) {
    ctx.log(`Creating the Python environment with uv (${uv.path})${clear ? ', replacing the broken one' : ''}`);
    const args = ['venv', paths.venvDir, '--python', VENV_PYTHON_REQUEST, '--managed-python', '--no-project', '--no-config'];
    if (clear) {
      args.push('--clear');
      // uv refuses to clear a folder it does not recognize as a venv (no pyvenv.cfg) unless
      // --force is given. Only ever reached for the app-owned venv folder.
      const cfg = await statSafe(path.join(paths.venvDir, 'pyvenv.cfg'));
      if (!cfg || !cfg.isFile()) args.push('--force');
    }
    await spawnStep(ctx, uv.path, args, {
      cwd: parent,
      env: ctx.pythonEnv(uvEnvVars(paths)),
      timeoutMs: VENV_TIMEOUT_MS,
      what: 'create the Python environment',
      onLine: setupLineHandler(progress, 10, 28),
    });
    return 'uv';
  }
  if (!paths.isDev) {
    throw setupError('A required part of Kirigami is missing (uv). Please reinstall Kirigami.', 'UV_MISSING');
  }
  const base = await findSystemPython(ctx);
  if (!base) {
    throw setupError(
      'Python 3.12 or newer was not found on this computer. Install Python 3.12 from python.org (or run "npm run fetch-uv"), then try again.',
      'PYTHON_NOT_FOUND',
    );
  }
  progress(15, 'Creating the Python environment...');
  await spawnStep(ctx, base.cmd, [...base.args, '-m', 'venv', ...(clear ? ['--clear'] : []), paths.venvDir], {
    cwd: parent,
    env: ctx.pythonEnv({}),
    timeoutMs: VENV_TIMEOUT_MS,
    what: 'create the Python environment',
  });
  return 'venv';
}

async function installPackages(ctx, deps, paths, pythonExe, reqFile, { custom, progress }) {
  const uv = findUv(deps);
  const cwd = custom ? paths.scmCacheDir : path.dirname(paths.venvDir);
  await fsp.mkdir(cwd, { recursive: true });
  if (uv.available) {
    await spawnStep(ctx, uv.path, ['pip', 'install', '--python', pythonExe, '--no-config', '-r', reqFile], {
      cwd,
      env: ctx.pythonEnv(uvEnvVars(paths)),
      timeoutMs: INSTALL_TIMEOUT_MS,
      what: 'install the card maker components',
      onLine: setupLineHandler(progress, 30, 88),
    });
    return 'uv';
  }
  if (!paths.isDev && !custom) {
    throw setupError('A required part of Kirigami is missing (uv). Please reinstall Kirigami.', 'UV_MISSING');
  }
  const pipArgs = ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', reqFile];
  const options = { cwd, env: ctx.pythonEnv({}), timeoutMs: INSTALL_TIMEOUT_MS, what: 'install the card maker components', onLine: setupLineHandler(progress, 30, 88) };
  try {
    await spawnStep(ctx, pythonExe, pipArgs, options);
  } catch (err) {
    if (isCancelled(err, ctx) || !/No module named pip/i.test(`${err.details || ''}\n${err.message}`)) throw err;
    ctx.log('pip is missing from this Python; installing it first.');
    await spawnStep(ctx, pythonExe, ['-m', 'ensurepip', '--upgrade', '--default-pip'], { ...options, what: 'prepare the Python installer (pip)' });
    await spawnStep(ctx, pythonExe, pipArgs, options);
  }
  return 'pip';
}

async function runSetup(ctx, deps, { installIntoCustom }) {
  const startedAt = Date.now();
  const progress = makeProgress(ctx);

  // 1. Workspace
  ctx.step('workspace', 'running', 'Preparing the card maker data folder');
  progress(2, 'Preparing the card maker data folder...');
  const ws = await ensureWorkspace(deps, (line) => ctx.log(line));
  ctx.log(`Card maker data folder: ${ws.path}${ws.updated ? ' (card maker files updated)' : ''}`);
  ctx.step('workspace', 'done', 'Card maker data folder ready');
  ctx.throwIfCancelled();

  const paths = deps.getPaths();
  const settings = deps.settings.get();
  const custom = !!settings.pythonPath;
  const reqFile = await runtimeRequirementsFile(deps);
  const reqSha = sha1(await fsp.readFile(reqFile));
  const marker = markerFile(paths, settings);
  const helperRun = (sub, args, timeoutMs) =>
    deps.helper.run(sub, args, { timeoutMs, lock: false, signal: ctx.signal, onLine: (line) => ctx.log(line, 'stderr') });

  // 2. Python
  ctx.step('python', 'running', 'Checking Python');
  progress(5, 'Checking Python...');
  let check = null;
  let checkError = null;
  try {
    check = await helperRun('env-check', ['--requirements', reqFile], ENV_CHECK_TIMEOUT_MS);
  } catch (err) {
    if (isCancelled(err, ctx)) throw err;
    checkError = err;
    ctx.log(`Python check: ${err.message}`);
  }
  const upToDate = (await readMarker(marker)) === reqSha;
  const problem = !custom && check ? await venvProblem(check, paths.venvDir) : null;
  if (problem) ctx.log(`The Python environment is damaged: ${problem}`);
  let install = true;
  if (check && check.ok && upToDate && !problem) {
    ctx.log('The card maker components are already installed and up to date.');
    ctx.step('python', 'skipped', `Python ${check.python}`);
    ctx.step('packages', 'skipped', 'Already installed');
    install = false;
  } else if (custom) {
    if (!check) {
      throw setupError(
        checkError && checkError.code === 'NOT_INSTALLED'
          ? "The Python you chose can't be found anymore. Choose another Python, or go back to the app's own components."
          : "The Python you chose doesn't start. Choose another Python, or go back to the app's own components.",
        'BAD_PYTHON',
        { details: checkError ? checkError.details || checkError.message : null },
      );
    }
    if (check.pythonOk === false) throw setupError(`Python ${check.python} is too old. Choose Python 3.12 or newer.`, 'PYTHON_TOO_OLD');
    ctx.step('python', 'done', `Your Python ${check.python}`);
    if (!installIntoCustom) {
      if (!check.ok) {
        throw setupError(
          `This Python is missing some card maker components (${(check.missing || []).join(', ')}). Choose "Install components into this Python", or choose another Python.`,
          'CUSTOM_PYTHON_MISSING_PACKAGES',
          { missing: check.missing || [] },
        );
      }
      ctx.step('packages', 'skipped', 'Using the components already in your Python');
      install = false;
    }
  } else {
    const healthy = !!(check && check.pythonOk !== false && !problem);
    if (!check && checkError && checkError.code !== 'NOT_INSTALLED' && (await statSafe(paths.pythonPath))) {
      // The interpreter exists: if it starts, the failure is not the environment's fault
      // (helper missing, antivirus, timeout...) and recreating the venv would not help.
      const version = await probePythonVersion(paths.pythonPath, { scmCacheDir: paths.scmCacheDir, spawnImpl: deps.seams && deps.seams.spawnImpl });
      if (versionAtLeast(version, MIN_PYTHON)) {
        throw setupError(checkError.message, checkError.code || 'ENV_CHECK_FAILED', { details: checkError.details, cause: checkError });
      }
    }
    if (healthy) {
      ctx.step('python', 'done', `Python ${check.python}`);
    } else {
      const exists = await dirHasEntries(paths.venvDir);
      if (exists && !paths.appOwnedVenv) {
        throw setupError(
          `This Python environment is broken (${paths.venvDir}). Repair it in the app's own location, or choose another Python.`,
          'VENV_BROKEN',
          { details: problem || (check ? `Python ${check.python} is too old.` : 'The Python in this environment does not start.'), venvDir: paths.venvDir },
        );
      }
      progress(10, 'Creating the Python environment...');
      await createVenv(ctx, deps, paths, { clear: exists, progress });
      ctx.step('python', 'done', 'Python environment created');
    }
  }
  ctx.throwIfCancelled();

  // 3. Packages
  if (install) {
    ctx.step('packages', 'running', 'Downloading the card maker components (one-time download, a few minutes)');
    progress(30, 'Downloading the card maker components...');
    const tool = await installPackages(ctx, deps, paths, paths.pythonPath, reqFile, { custom, progress });
    ctx.log(`Card maker components installed with ${tool}.`);
    ctx.step('packages', 'done', 'Card maker components installed');
  }
  ctx.throwIfCancelled();

  // 4. Verify
  ctx.step('verify', 'running', 'Checking that everything works');
  progress(90, 'Checking that everything works...');
  // Nothing changed since the check above when nothing was installed: reuse it.
  const final = !install && check ? check : await helperRun('env-check', ['--requirements', reqFile], ENV_CHECK_TIMEOUT_MS);
  if (!final.ok) {
    throw setupError(
      final.pythonOk === false
        ? `Python ${final.python} is too old. Python 3.12 or newer is needed.`
        : `Some card maker components are still missing (${(final.missing || []).join(', ')}).`,
      final.pythonOk === false ? 'PYTHON_TOO_OLD' : 'MISSING_PACKAGES',
      { missing: final.missing || [] },
    );
  }
  const smokeDir = path.join(paths.scmCacheDir, 'tmp', `smoke-${ctx.jobId || 'job'}-${Date.now().toString(36)}`);
  let smoke;
  try {
    smoke = await helperRun('smoke-test', ['--tmp', smokeDir], SMOKE_TIMEOUT_MS);
  } finally {
    await fsp.rm(smokeDir, { recursive: true, force: true }).catch(() => {});
  }
  await writeMarker(marker, reqSha);
  ctx.log(`Test PDF made in ${smoke && smoke.seconds !== undefined ? smoke.seconds : '?'} s.`);
  ctx.step('verify', 'done', 'Everything works');
  invalidateEnvCache(deps);
  const status = storeStatus(deps, await computeStatus(deps, { refresh: false, envCheck: final }));
  progress(100, 'The card maker components are ready');
  ctx.log(`Setup finished in ${Math.round((Date.now() - startedAt) / 1000)} s.`);
  return status;
}

/**
 * Start the setup/repair job (kind 'setup'; steps workspace, python, packages, verify) under
 * the exclusive Python lock. Resolves to the job id; the job result is the new checkEnv status.
 * @param {object} deps
 * @param {{installIntoCustom?: boolean}} [options] installIntoCustom: the user clicked
 *   "Install components into this Python" (custom Python only).
 * @returns {string} jobId (jobs.start throws 'BUSY: ...' while another job runs)
 */
function startSetupJob(deps, options = {}) {
  const installIntoCustom = !!(options && options.installIntoCustom);
  return deps.jobs.start(
    'setup',
    { title: 'Setting up the card maker components', steps: SETUP_STEPS.map((s) => ({ ...s })) },
    (ctx) => deps.locks.withPythonExclusive(() => runSetup(ctx, deps, { installIntoCustom })),
  );
}

module.exports = {
  checkEnv,
  startSetupJob,
  usePython,
  useAppVenv,
  runtimeRequirementsFile,
  findUv,
  invalidateEnvCache,
  buildRuntimeRequirements,
  requirementName,
  markerFile,
  parsePythonVersion,
  uvEnvVars,
  setupProgressLabel,
  explainFailure,
  SETUP_STEPS,
  MAINTAINER_ONLY_DISTS,
};
