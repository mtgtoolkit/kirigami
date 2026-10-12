'use strict';

/**
 * Workspace = the folder every Python child runs in (cwd). It holds the engine code
 * (create_pdf.py, utilities.py, plugins/, assets/...) plus the user's data in game/ and data/.
 *
 * Modes
 * - dev:      development build using the repository itself (workspace === engine source).
 * - external: a folder that already contains create_pdf.py and is not ours (no marker file,
 *             or a git checkout). Used as-is: engine files are never written.
 * - managed:  the default packaged workspace, a folder with our marker, or an empty folder.
 *             Engine files are copied from the engine source and refreshed whenever the engine
 *             manifest changes (marker `.scm-engine.json`).
 *
 * game/ and data/ are NEVER modified by the engine refresh.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fsp = fs.promises;

/** Sub-folders of `<workspace>/game` that are always created. */
const GAME_KINDS = Object.freeze(['front', 'back', 'double_sided', 'decklist', 'output', 'upscaled']);
/** Image kinds the user manages in the app (a subset of GAME_KINDS). */
const CARD_KINDS = Object.freeze(['front', 'back', 'double_sided']);

const ENGINE_MARKER = '.scm-engine.json';
const MANIFEST_NAME = '.engine-manifest.json';
const TRASH_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const PARTIAL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const JUNK_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini', 'icon\r']);
const ROOT_ENGINE_FILES = ['requirements.txt', 'LICENSE.md'];

const locks = new Map();

/** A user-facing error (errors.friendlyError passes `friendly: true` errors through unchanged). */
function workspaceError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, friendly: true, details: '' }, extra);
}

function sha1(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

function samePath(a, b) {
  if (!a || !b) return false;
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' || process.platform === 'darwin' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function isInsidePath(parent, child) {
  if (!parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function isFile(p) {
  const st = await statSafe(p);
  return !!st && st.isFile();
}

async function readJsonSafe(file) {
  try {
    return JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

function withLock(key, fn) {
  const k = process.platform === 'win32' ? key.toLowerCase() : key;
  const previous = locks.get(k) || Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(k, tail);
  tail.then(() => {
    if (locks.get(k) === tail) locks.delete(k);
  });
  return run;
}

function warn(deps, message) {
  try {
    if (deps && deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn(message);
  } catch {
    /* logging must never throw */
  }
}

function appVersion(deps) {
  try {
    if (deps && deps.app && typeof deps.app.getVersion === 'function') return deps.app.getVersion();
  } catch {
    /* ignore */
  }
  return null;
}

function skipEngineEntry(rel, name, isDir) {
  if (name === '__pycache__' || name === '.git') return true;
  if (!isDir && /\.py[co]$/i.test(name)) return true;
  // The user's own extra layouts are never shipped (they would collide on merge).
  if (!isDir && /^assets\/extra_layouts\/[^/]+\.json$/i.test(rel)) return true;
  return false;
}

async function walkFiles(root, relBase, out) {
  let entries;
  try {
    entries = await fsp.readdir(path.join(root, relBase), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    if (skipEngineEntry(rel, entry.name, entry.isDirectory())) continue;
    if (entry.isDirectory()) await walkFiles(root, rel, out);
    else if (entry.isFile()) out.push(rel);
  }
}

/**
 * Files a managed workspace receives from the engine source (same selection as the
 * packaging filter): root *.py, requirements.txt, LICENSE.md, assets/**, plugins/**,
 * without __pycache__/*.pyc and without assets/extra_layouts/*.json.
 * @param {string} engineDir
 * @returns {Promise<string[]>} sorted POSIX relative paths
 */
async function listEngineFiles(engineDir) {
  const files = [];
  let entries = [];
  try {
    entries = await fsp.readdir(engineDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isFile() && (/\.py$/i.test(entry.name) || ROOT_ENGINE_FILES.includes(entry.name))) files.push(entry.name);
  }
  await walkFiles(engineDir, 'assets', files);
  await walkFiles(engineDir, 'plugins', files);
  return files.sort();
}

/**
 * Fingerprint of the engine source: sha1 of `<engine>/.engine-manifest.json` when it
 * exists (packaged builds), otherwise sha1 of (path, size, mtime) of every engine file
 * (development builds, so edits to the repo refresh managed workspaces).
 * @param {string} engineDir
 * @returns {Promise<{sha1:string, source:'manifest'|'computed', files?:number}>}
 */
async function engineManifestSha1(engineDir) {
  try {
    const buf = await fsp.readFile(path.join(engineDir, MANIFEST_NAME));
    return { sha1: sha1(buf), source: 'manifest' };
  } catch {
    const files = await listEngineFiles(engineDir);
    const lines = [];
    for (const rel of files) {
      const st = await statSafe(path.join(engineDir, rel));
      if (st) lines.push(`${rel}\t${st.size}\t${Math.round(st.mtimeMs)}`);
    }
    return { sha1: sha1(lines.join('\n')), source: 'computed', files: files.length };
  }
}

function defaultManagedDir(paths) {
  return paths && paths.dataDir ? path.join(paths.dataDir, 'workspace') : null;
}

/**
 * Decide how a workspace folder is used (pure inspection, no writes).
 * @param {object} paths getPaths() result (workspaceDir, engineSourceDir, isDev, dataDir)
 * @returns {Promise<{mode:'dev'|'external'|'managed'|'invalid', error?:string}>}
 */
async function classifyWorkspace(paths) {
  const ws = path.resolve(paths.workspaceDir);
  if (samePath(ws, paths.engineSourceDir)) return { mode: paths.isDev ? 'dev' : 'external' };
  const st = await statSafe(ws);
  if (!st) return { mode: 'managed' };
  if (!st.isDirectory()) return { mode: 'invalid', error: `${ws} is a file, not a folder.` };
  const hasEngine = await isFile(path.join(ws, 'create_pdf.py'));
  const hasMarker = await isFile(path.join(ws, ENGINE_MARKER));
  const hasGit = !!(await statSafe(path.join(ws, '.git')));
  if (hasEngine && (hasGit || !hasMarker)) return { mode: 'external' };
  if (hasMarker) return { mode: 'managed' };
  if (samePath(ws, defaultManagedDir(paths))) return { mode: 'managed' };
  let names = [];
  try {
    names = (await fsp.readdir(ws)).filter((n) => !JUNK_NAMES.has(n.toLowerCase()) && !n.startsWith('._'));
  } catch (err) {
    return { mode: 'invalid', error: `Cannot open ${ws}: ${err.message}` };
  }
  if (names.every((n) => n === 'game' || n === 'data')) return { mode: 'managed' };
  return {
    mode: 'invalid',
    error: "This folder isn't empty and doesn't contain the card maker files. Choose an empty folder or an existing card maker folder.",
  };
}

async function markerIsCurrent(ws, sha) {
  const marker = await readJsonSafe(path.join(ws, ENGINE_MARKER));
  return !!(
    marker &&
    marker.manifestSha1 === sha &&
    marker.state !== 'updating' &&
    (await isFile(path.join(ws, 'create_pdf.py'))) &&
    (await isFile(path.join(ws, 'utilities.py')))
  );
}

async function refreshEngineFiles(deps, ws, engineDir, sha, log) {
  const version = appVersion(deps);
  log('Updating the card maker files...');
  await fsp.mkdir(ws, { recursive: true });
  // Provisional marker first: an interrupted copy is then retried (never mistaken for "external").
  await writeJsonAtomic(path.join(ws, ENGINE_MARKER), { manifestSha1: null, state: 'updating', appVersion: version, at: new Date().toISOString() });

  const entries = await fsp.readdir(ws, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile() && (/\.py$/i.test(entry.name) || ROOT_ENGINE_FILES.includes(entry.name))) {
      await fsp.rm(path.join(ws, entry.name), { force: true });
    }
  }
  await fsp.rm(path.join(ws, 'plugins'), { recursive: true, force: true, maxRetries: 3 });
  const assetsDir = path.join(ws, 'assets');
  const assets = await fsp.readdir(assetsDir, { withFileTypes: true }).catch(() => []);
  for (const entry of assets) {
    if (entry.name === 'extra_layouts') continue; // the user's own layouts stay
    await fsp.rm(path.join(assetsDir, entry.name), { recursive: true, force: true, maxRetries: 3 });
  }

  const files = await listEngineFiles(engineDir);
  for (const rel of files) {
    const dest = path.join(ws, ...rel.split('/'));
    if (rel.startsWith('assets/extra_layouts/') && (await statSafe(dest))) continue;
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    await fsp.copyFile(path.join(engineDir, ...rel.split('/')), dest);
  }
  await writeJsonAtomic(path.join(ws, ENGINE_MARKER), { manifestSha1: sha, appVersion: version, at: new Date().toISOString(), files: files.length });
  log(`Card maker files updated (${files.length} files).`);
  return files.length;
}

async function ensureGameDirs(ws) {
  for (const kind of GAME_KINDS) await fsp.mkdir(path.join(ws, 'game', kind), { recursive: true });
}

/**
 * Make sure the workspace can run the engine.
 * - dev / external: create_pdf.py must exist (engine files are never written).
 * - managed: copy/refresh engine files when the engine fingerprint differs from the marker.
 * Always creates game/{front,back,double_sided,decklist,output,upscaled}. Never touches
 * the contents of game/ or data/.
 *
 * @param {object} deps app deps (getPaths, app?, logger?)
 * @param {(line:string)=>void} [log] progress lines (e.g. a job's ctx.log)
 * @returns {Promise<{ok:true, path:string, mode:string, external:boolean, updated:boolean, manifestSha1:string|null}>}
 */
async function ensureWorkspace(deps, log) {
  const say = typeof log === 'function' ? log : () => {};
  const paths = deps.getPaths();
  const ws = path.resolve(paths.workspaceDir);
  return withLock(ws, async () => {
    const cls = await classifyWorkspace(paths);
    if (cls.mode === 'invalid') throw workspaceError(cls.error, 'WORKSPACE_INVALID', { path: ws });
    let updated = false;
    let manifestSha1 = null;
    if (cls.mode === 'managed') {
      const engineDir = path.resolve(paths.engineSourceDir);
      if (!(await isFile(path.join(engineDir, 'create_pdf.py')))) {
        throw workspaceError(`Card maker files not found at ${engineDir}. Please reinstall Kirigami.`, 'ENGINE_NOT_FOUND', { path: engineDir });
      }
      manifestSha1 = (await engineManifestSha1(engineDir)).sha1;
      if (!(await markerIsCurrent(ws, manifestSha1))) {
        try {
          await refreshEngineFiles(deps, ws, engineDir, manifestSha1, say);
        } catch (err) {
          throw workspaceError(`Could not copy the card maker files to ${ws}: ${err.message}`, err.code === 'ENOSPC' ? 'DISK_FULL' : 'WORKSPACE_WRITE_FAILED', { path: ws, cause: err });
        }
        updated = true;
      }
    } else if (!(await isFile(path.join(ws, 'create_pdf.py')))) {
      throw workspaceError(`Card maker files not found at ${ws}`, 'ENGINE_NOT_FOUND', { path: ws });
    }
    try {
      await ensureGameDirs(ws);
    } catch (err) {
      throw workspaceError(`Could not create the card folders in ${ws}: ${err.message}`, 'WORKSPACE_WRITE_FAILED', { path: ws, cause: err });
    }
    return { ok: true, path: ws, mode: cls.mode, external: cls.mode === 'external', updated, manifestSha1 };
  });
}

/**
 * Read-only workspace status (used by the environment check; never writes).
 * @param {object} deps
 * @returns {Promise<{ok:boolean, path:string, mode:string, external:boolean, needsUpdate:boolean, error:string|null}>}
 */
async function inspectWorkspace(deps) {
  const paths = deps.getPaths();
  const ws = path.resolve(paths.workspaceDir);
  const cls = await classifyWorkspace(paths);
  const base = { ok: false, path: ws, mode: cls.mode, external: cls.mode === 'external', needsUpdate: false, error: null };
  if (cls.mode === 'invalid') return { ...base, error: cls.error };
  if (cls.mode !== 'managed') {
    const ok = await isFile(path.join(ws, 'create_pdf.py'));
    return { ...base, ok, error: ok ? null : `Card maker files not found at ${ws}` };
  }
  const engineDir = path.resolve(paths.engineSourceDir);
  if (!(await isFile(path.join(engineDir, 'create_pdf.py')))) {
    return { ...base, error: `Card maker files not found at ${engineDir}. Please reinstall Kirigami.` };
  }
  const { sha1: sha } = await engineManifestSha1(engineDir);
  if (await markerIsCurrent(ws, sha)) return { ...base, ok: true };
  const exists = !!(await statSafe(ws));
  return {
    ...base,
    needsUpdate: true,
    error: exists ? 'The card maker files in the data folder need to be updated.' : 'The card maker data folder has not been set up yet.',
  };
}

function resourcesRoots(deps, paths) {
  const roots = [];
  if (process.resourcesPath && !paths.isDev) roots.push(process.resourcesPath);
  if (!paths.isDev && paths.engineSourceDir) roots.push(path.dirname(path.resolve(paths.engineSourceDir)));
  if (deps && deps.app && deps.app.isPackaged && process.execPath) roots.push(path.dirname(process.execPath));
  return roots;
}

async function validateWorkspaceTarget(deps, dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('setWorkspace: dir must be a folder path or null');
  if (!path.isAbsolute(dir)) throw workspaceError('Choose a complete folder path.', 'WORKSPACE_INVALID');
  const target = path.resolve(dir);
  if (path.parse(target).root === target) throw workspaceError('Choose a folder, not a whole drive.', 'WORKSPACE_INVALID');
  const paths = deps.getPaths();
  for (const root of resourcesRoots(deps, paths)) {
    if (isInsidePath(root, target)) throw workspaceError("This folder belongs to the app's installation. Choose another folder.", 'WORKSPACE_INVALID');
  }
  for (const appDir of [paths.venvDir, paths.uvPythonDir, paths.uvCacheDir, paths.scmCacheDir, paths.binDir]) {
    if (appDir && isInsidePath(appDir, target)) throw workspaceError('This folder is used by the app itself. Choose another folder.', 'WORKSPACE_INVALID');
  }
  try {
    await fsp.mkdir(target, { recursive: true });
    const probe = path.join(target, `.scm-write-test-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
    await fsp.writeFile(probe, 'ok');
    await fsp.rm(probe, { force: true });
  } catch (err) {
    throw workspaceError(`This folder can't be written to (${err.code || err.message}). Choose another folder.`, 'WORKSPACE_NOT_WRITABLE', { cause: err });
  }
  const cls = await classifyWorkspace({ ...paths, workspaceDir: target });
  if (cls.mode === 'invalid') throw workspaceError(cls.error, 'WORKSPACE_INVALID');
  return target;
}

async function afterWorkspaceChange(deps) {
  const paths = deps.getPaths();
  try {
    if (deps.helper && typeof deps.helper.invalidate === 'function') deps.helper.invalidate();
  } catch (err) {
    warn(deps, `Could not reset the introspection cache: ${err.message}`);
  }
  for (const name of ['introspection.json', 'hashes.json']) {
    await fsp.rm(path.join(paths.scmCacheDir, name), { force: true }).catch(() => {});
  }
  try {
    if (deps.hashCache && typeof deps.hashCache.clear === 'function') deps.hashCache.clear();
  } catch (err) {
    warn(deps, `Could not reset the hash cache: ${err.message}`);
  }
  try {
    const pythonEnv = require('./python-env');
    if (typeof pythonEnv.invalidateEnvCache === 'function') pythonEnv.invalidateEnvCache(deps);
  } catch (err) {
    warn(deps, `Could not reset the environment cache: ${err.message}`);
  }
  try {
    if (typeof deps.restartWatchers === 'function') {
      await deps.restartWatchers();
    } else if (deps.watcher && typeof deps.watcher.stop === 'function') {
      deps.watcher.stop();
      deps.watcher = require('./cards').startWatching(deps);
    }
  } catch (err) {
    warn(deps, `Could not restart the card folder watchers: ${err.message}`);
  }
  if (typeof deps.emit === 'function') {
    try {
      deps.emit('settings:changed', deps.settings.get());
      deps.emit('cards:changed', { reason: 'workspace' });
    } catch (err) {
      warn(deps, `Could not notify the window: ${err.message}`);
    }
  }
}

/**
 * Switch the workspace (null = default). Refuses while a job runs; the folder must be
 * writable, outside the app installation, and either empty, ours, or an existing card
 * maker folder. On failure the previous setting is restored. Then caches are cleared,
 * watchers restarted, and settings:changed + cards:changed emitted.
 *
 * @param {object} deps
 * @param {string|null} dir absolute folder path, or null for the default location
 * @returns {Promise<object>} the refreshed environment status (python-env checkEnv)
 */
async function setWorkspace(deps, dir) {
  const active = deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw workspaceError(`BUSY: wait until "${active.title || active.kind || 'the current task'}" finishes`, 'BUSY');
  const previous = deps.settings.get().workspaceDir ?? null;
  const target = dir === null || dir === undefined || dir === '' ? null : await validateWorkspaceTarget(deps, dir);
  deps.settings.update({ workspaceDir: target }, { internal: true });
  try {
    await ensureWorkspace(deps);
  } catch (err) {
    deps.settings.update({ workspaceDir: previous }, { internal: true });
    throw err;
  }
  await afterWorkspaceChange(deps);
  const { checkEnv } = require('./python-env');
  return checkEnv(deps, { refresh: true });
}

function timestampFromName(name) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}

async function batchTime(dir, name) {
  const batch = await readJsonSafe(path.join(dir, 'batch.json'));
  if (batch && batch.at !== undefined) {
    const t = typeof batch.at === 'number' ? batch.at : Date.parse(batch.at);
    if (Number.isFinite(t)) return t;
  }
  const fromName = timestampFromName(name);
  if (fromName !== null) return fromName;
  const st = await statSafe(dir);
  return st ? st.mtimeMs : null;
}

async function removeEntries(dir, filter) {
  let removed = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (filter && !(await filter(entry, full))) continue;
    try {
      await fsp.rm(full, { recursive: true, force: true, maxRetries: 3 });
      removed += 1;
    } catch {
      /* in use: try again next start */
    }
  }
  return removed;
}

async function olderThan(full, maxAgeMs, now) {
  const st = await statSafe(full);
  return !!st && now - st.mtimeMs > maxAgeMs;
}

/**
 * Startup housekeeping (skipped while a job runs; never throws):
 * - leftovers in game/.stage/
 * - trash batches older than 14 days
 * - `*.partial-*` files/folders older than 1 day in the output folder
 * - stale helper temp files (scm-cache/tmp, > 1 day) and upscale staging leftovers
 * @param {object} deps
 * @param {{now?: number}} [options]
 * @returns {Promise<{skipped:boolean, stageRemoved:number, trashPruned:number, partialsRemoved:number, tmpRemoved:number, stagingRemoved:number}>}
 */
async function startupCleanup(deps, { now = Date.now() } = {}) {
  const summary = { skipped: false, stageRemoved: 0, trashPruned: 0, partialsRemoved: 0, tmpRemoved: 0, stagingRemoved: 0 };
  try {
    if (deps.jobs && typeof deps.jobs.active === 'function' && deps.jobs.active()) return { ...summary, skipped: true };
    const paths = deps.getPaths();
    if (paths.stageRoot) {
      summary.stageRemoved = await removeEntries(paths.stageRoot);
      await fsp.rmdir(paths.stageRoot).catch(() => {});
    }
    if (paths.trashRoot) {
      summary.trashPruned = await removeEntries(paths.trashRoot, async (entry, full) => {
        if (!entry.isDirectory()) return false;
        const t = await batchTime(full, entry.name);
        return t !== null && now - t > TRASH_MAX_AGE_MS;
      });
    }
    if (paths.outputDir) {
      summary.partialsRemoved = await removeEntries(paths.outputDir, async (entry, full) =>
        entry.name.includes('.partial-') && olderThan(full, PARTIAL_MAX_AGE_MS, now));
    }
    if (paths.scmCacheDir) {
      summary.tmpRemoved = await removeEntries(path.join(paths.scmCacheDir, 'tmp'), async (_entry, full) => olderThan(full, TMP_MAX_AGE_MS, now));
    }
    if (paths.upscaledRoot) {
      const staging = path.join(paths.upscaledRoot, '.staging');
      summary.stagingRemoved = await removeEntries(staging);
      await fsp.rmdir(staging).catch(() => {});
    }
  } catch (err) {
    warn(deps, `Startup cleanup failed: ${err.message}`);
  }
  return summary;
}

module.exports = {
  ensureWorkspace,
  setWorkspace,
  startupCleanup,
  inspectWorkspace,
  classifyWorkspace,
  listEngineFiles,
  engineManifestSha1,
  GAME_KINDS,
  CARD_KINDS,
  ENGINE_MARKER,
};
