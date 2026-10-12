'use strict';

/**
 * engine-files.js — which files of the Silhouette Card Maker engine Kirigami ships and runs, and the
 * manifest that describes one exact copy of them. Pure helpers plus small file readers; no Electron,
 * no network (scripts/*.mjs load it with createRequire).
 *
 * One definition is shared by everything that handles engine files, so they can never disagree:
 * - scripts/fetch-engine.mjs builds build/engine (shipped as resources/engine) from the commit pinned in
 *   engine.lock.json;
 * - the runtime engine updater assembles newer engines the same way in <dataDir>/engines/<commit>;
 * - workspace.js copies the Python part of the set into a managed workspace and fingerprints the manifest
 *   bytes, so a different commit refreshes that copy.
 *
 * The file set: root *.py, requirements.txt, LICENSE.md, assets/**, plugins/**, calibration/** and
 * cutting_templates/**, without __pycache__ folders, *.pyc files, the generated DXF folders (any dxf folder
 * inside cutting_templates), the user's own layouts (assets/extra_layouts/*.json) and the .DS_Store and
 * .gitkeep placeholders.
 *
 * Manifest (<engineDir>/.engine-manifest.json, format 2):
 *   { format, engineVersion, source: { repository, ref, commit, committedAt }, fileCount, totalBytes,
 *     files: [{ path, size, sha1, blob }] }
 * `sha1` is the SHA-1 of the file bytes; `blob` is the git blob SHA-1 (sha1 of "blob <size>\0" + bytes),
 * the value GitHub lists in the commit's tree. That makes the commit SHA the integrity anchor: every file
 * can be checked against the commit it claims to come from. The text is deterministic (sorted paths, fixed
 * key order, no timestamps), so one commit always gives the same manifest bytes and the same fingerprint.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fsp = fs.promises;

const MANIFEST_NAME = '.engine-manifest.json';
const MANIFEST_FORMAT = 2;
/** Top-level folders of the engine that are shipped (everything inside, minus the exclusions). */
const ENGINE_DIRS = Object.freeze(['assets', 'plugins', 'calibration', 'cutting_templates']);
/** Root files shipped besides the *.py scripts. */
const ENGINE_ROOT_FILES = Object.freeze(['requirements.txt', 'LICENSE.md']);
/** Files without which the app cannot work (a build or a download missing one of them is rejected). */
const REQUIRED_ENGINE_FILES = Object.freeze(['create_pdf.py', 'offset_pdf.py', 'utilities.py', 'requirements.txt', 'assets/layouts.json']);
/** Names never shipped wherever they appear (builder-util skipped the placeholders too). */
const SKIPPED_NAMES = new Set(['.DS_Store', '.gitkeep']);
/** Folders never entered when listing a local engine folder. */
const SKIPPED_DIRS = new Set(['__pycache__', '.git']);

const SHA_RE = /^[0-9a-f]{40}$/;
const REPOSITORY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REF_RE = /^(?:HEAD|refs\/[A-Za-z0-9._/-]+)$/;
const MAX_PATH_LENGTH = 400;

function manifestError(message) {
  return Object.assign(new Error(message), { code: 'ENGINE_MANIFEST_INVALID' });
}

/**
 * SHA-1 (hex) of a buffer.
 * @param {Buffer|Uint8Array|string} data
 * @returns {string}
 */
function sha1Hex(data) {
  return crypto.createHash('sha1').update(data).digest('hex');
}

/**
 * Git blob SHA-1 of file content: sha1("blob <byte length>\0" + bytes), as listed in git trees.
 * @param {Buffer|Uint8Array} data
 * @returns {string}
 */
function gitBlobSha1(data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  return crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** @param {unknown} value @returns {boolean} a full lowercase 40-hex SHA-1 */
function isSha(value) {
  return typeof value === 'string' && SHA_RE.test(value);
}

/** @param {unknown} value @returns {boolean} a GitHub repository name such as 'owner/name' */
function isRepository(value) {
  return typeof value === 'string' && REPOSITORY_RE.test(value);
}

/**
 * A relative POSIX path that stays inside its folder on every platform: no backslash, no empty, '.' or
 * '..' segment, no drive letter or stream (':'), no control characters. Guards every path that comes from
 * the network or from a manifest before it is joined to a folder.
 * @param {unknown} rel
 * @returns {boolean}
 */
function isSafeRelativePath(rel) {
  if (typeof rel !== 'string' || rel === '' || rel.length > MAX_PATH_LENGTH) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\\:\u0000-\u001f\u007f]/.test(rel)) return false;
  return rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/**
 * Is this engine-relative path part of the shipped engine?
 * @param {string} rel POSIX path relative to the engine root (e.g. 'plugins/mtg/fetch.py')
 * @returns {boolean}
 */
function isEngineFile(rel) {
  if (!isSafeRelativePath(rel)) return false;
  const segments = rel.split('/');
  const name = segments[segments.length - 1];
  if (segments.some((s) => SKIPPED_DIRS.has(s)) || SKIPPED_NAMES.has(name) || /\.py[co]$/i.test(name)) return false;
  if (segments.length === 1) return /\.py$/.test(name) || ENGINE_ROOT_FILES.includes(name);
  const top = segments[0];
  if (!ENGINE_DIRS.includes(top)) return false;
  // Generated DXF files are maintainer artefacts (the .studio3 templates are what users open).
  if (top === 'cutting_templates' && segments.slice(1, -1).includes('dxf')) return false;
  // The user's own layouts live in a managed workspace and must never be overwritten by ours.
  if (top === 'assets' && segments.length === 3 && segments[1] === 'extra_layouts' && /\.json$/i.test(name)) return false;
  return true;
}

/**
 * Required files missing from a list of engine paths.
 * @param {Iterable<string>} paths
 * @returns {string[]}
 */
function missingRequiredFiles(paths) {
  const have = new Set(paths);
  return REQUIRED_ENGINE_FILES.filter((rel) => !have.has(rel));
}

/** Byte-wise path order (stable across platforms and locales). */
function comparePaths(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Normalize a branch name or ref: 'main' → 'refs/heads/main'; 'refs/…' and 'HEAD' are kept.
 * @param {string} ref
 * @returns {string}
 */
function normalizeRef(ref) {
  const value = typeof ref === 'string' ? ref.trim() : '';
  const full = value === 'HEAD' || value.startsWith('refs/') ? value : `refs/heads/${value}`;
  if (!value || !REF_RE.test(full) || full.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    throw new TypeError(`Invalid git ref "${ref}"`);
  }
  return full;
}

/**
 * Validate an engine source ({ repository, ref, commit, committedAt }): the content of engine.lock.json
 * and of a manifest's `source`. Returns a clean copy with a fixed key order.
 * @param {unknown} value
 * @param {string} [what='engine source'] used in error messages
 * @returns {{repository:string, ref:string, commit:string, committedAt:string}}
 */
function validateEngineSource(value, what = 'engine source') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw manifestError(`${what} must be an object`);
  const { repository, ref, commit, committedAt } = value;
  if (!isRepository(repository)) throw manifestError(`${what}: repository must look like "owner/name"`);
  if (typeof ref !== 'string' || !REF_RE.test(ref)) throw manifestError(`${what}: ref must be a full git ref such as "refs/heads/main"`);
  if (!isSha(commit)) throw manifestError(`${what}: commit must be a 40-character lowercase SHA-1`);
  if (typeof committedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(committedAt) || Number.isNaN(Date.parse(committedAt))) {
    throw manifestError(`${what}: committedAt must be an ISO-8601 date`);
  }
  return { repository, ref, commit, committedAt };
}

/**
 * Same repository and commit (the ref and date are descriptive only).
 * @param {{repository:string, commit:string}|null|undefined} a
 * @param {{repository:string, commit:string}|null|undefined} b
 * @returns {boolean}
 */
function sameSource(a, b) {
  return !!(a && b && a.commit === b.commit && String(a.repository).toLowerCase() === String(b.repository).toLowerCase());
}

/**
 * engine.lock.json text: the source with a fixed key order and a trailing newline.
 * @param {object} lock
 * @returns {string}
 */
function serializeEngineLock(lock) {
  return `${JSON.stringify(validateEngineSource(lock, 'engine.lock.json'), null, 2)}\n`;
}

/**
 * Parse and validate engine.lock.json text.
 * @param {string} text
 * @returns {{repository:string, ref:string, commit:string, committedAt:string}}
 */
function parseEngineLock(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    throw manifestError(`engine.lock.json is not valid JSON: ${err.message}`);
  }
  return validateEngineSource(data, 'engine.lock.json');
}

/**
 * Engine version from create_pdf.py's `@click.version_option("x.y.z")`, or null.
 * @param {string|Buffer|null|undefined} createPdfSource
 * @returns {string|null}
 */
function readEngineVersion(createPdfSource) {
  if (createPdfSource === null || createPdfSource === undefined) return null;
  const m = /version_option\(\s*["']([^"']+)["']/.exec(String(createPdfSource));
  return m ? m[1] : null;
}

function validateFileEntry(entry, index) {
  const where = `files[${index}]`;
  if (!entry || typeof entry !== 'object') throw manifestError(`${where} must be an object`);
  if (!isSafeRelativePath(entry.path)) throw manifestError(`${where}.path is not a safe relative path`);
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw manifestError(`${where}.size must be a whole number of bytes`);
  if (!isSha(entry.sha1)) throw manifestError(`${where}.sha1 must be a SHA-1`);
  if (!isSha(entry.blob)) throw manifestError(`${where}.blob must be a git blob SHA-1`);
  return { path: entry.path, size: entry.size, sha1: entry.sha1, blob: entry.blob };
}

/**
 * Build a manifest object (sorted files, totals, fixed key order) and validate it.
 * @param {{source:object, engineVersion?:string|null, files:Array<{path:string,size:number,sha1:string,blob:string}>}} input
 * @returns {object} manifest
 */
function buildManifest({ source, engineVersion = null, files }) {
  if (!Array.isArray(files)) throw new TypeError('buildManifest: files must be an array');
  const sorted = files.map(validateFileEntry).sort((a, b) => comparePaths(a.path, b.path));
  return validateManifest({
    format: MANIFEST_FORMAT,
    engineVersion: typeof engineVersion === 'string' && engineVersion ? engineVersion : null,
    source: validateEngineSource(source),
    fileCount: sorted.length,
    totalBytes: sorted.reduce((sum, f) => sum + f.size, 0),
    files: sorted,
  });
}

/**
 * Validate a parsed manifest: format 2, a valid source, unique sorted safe paths, consistent totals and
 * every required file. Returns a clean copy with a fixed key order (throws ENGINE_MANIFEST_INVALID).
 * @param {unknown} value
 * @returns {object}
 */
function validateManifest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw manifestError('the manifest must be a JSON object');
  if (value.format !== MANIFEST_FORMAT) throw manifestError(`unsupported manifest format ${JSON.stringify(value.format)} (expected ${MANIFEST_FORMAT})`);
  if (value.engineVersion !== null && (typeof value.engineVersion !== 'string' || !value.engineVersion)) {
    throw manifestError('engineVersion must be a string or null');
  }
  const source = validateEngineSource(value.source, 'manifest source');
  if (!Array.isArray(value.files) || value.files.length === 0) throw manifestError('the manifest lists no files');
  const files = value.files.map(validateFileEntry);
  for (let i = 1; i < files.length; i++) {
    if (comparePaths(files[i - 1].path, files[i].path) >= 0) throw manifestError(`files are not sorted or contain a duplicate near "${files[i].path}"`);
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  if (value.fileCount !== files.length) throw manifestError(`fileCount ${value.fileCount} does not match the ${files.length} files listed`);
  if (value.totalBytes !== totalBytes) throw manifestError(`totalBytes ${value.totalBytes} does not match the listed sizes (${totalBytes})`);
  const missing = missingRequiredFiles(files.map((f) => f.path));
  if (missing.length) throw manifestError(`required engine files are missing: ${missing.join(', ')}`);
  return { format: MANIFEST_FORMAT, engineVersion: value.engineVersion, source, fileCount: files.length, totalBytes, files };
}

/**
 * Manifest text: 2-space JSON with a trailing newline (deterministic for a given manifest).
 * @param {object} manifest
 * @returns {string}
 */
function serializeManifest(manifest) {
  return `${JSON.stringify(validateManifest(manifest), null, 2)}\n`;
}

/**
 * Parse and validate manifest text.
 * @param {string|Buffer} text
 * @returns {object}
 */
function parseManifest(text) {
  let data;
  try {
    data = JSON.parse(String(text).replace(/^﻿/, ''));
  } catch (err) {
    throw manifestError(`the manifest is not valid JSON: ${err.message}`);
  }
  return validateManifest(data);
}

/**
 * Read `<engineDir>/.engine-manifest.json`.
 * @param {string} engineDir
 * @returns {Promise<object|null>} the validated manifest, or null when there is none
 */
async function readManifest(engineDir) {
  let text;
  try {
    text = await fsp.readFile(path.join(engineDir, MANIFEST_NAME), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return parseManifest(text);
}

/**
 * The engine files of a git tree listing (GitHub's `git/trees/<sha>?recursive=1` entries): regular blobs
 * (no symbolic links, no submodules) whose path is an engine file, sorted by path.
 * @param {Array<{path:string, mode?:string, type:string, sha:string, size?:number}>} entries
 * @returns {Array<{path:string, size:number, blob:string}>}
 */
function engineEntriesFromTree(entries) {
  if (!Array.isArray(entries)) throw new TypeError('engineEntriesFromTree: entries must be an array');
  const out = [];
  for (const e of entries) {
    if (!e || e.type !== 'blob' || e.mode === '120000' || !isEngineFile(e.path)) continue;
    if (!isSha(e.sha) || !Number.isSafeInteger(e.size) || e.size < 0) throw manifestError(`tree entry "${e.path}" has no valid sha/size`);
    out.push({ path: e.path, size: e.size, blob: e.sha });
  }
  return out.sort((a, b) => comparePaths(a.path, b.path));
}

/**
 * Compare the files of an existing engine (manifest files) with the entries of another commit, by git
 * blob SHA-1: what can be reused as is, what must be downloaded, and what disappears.
 * @param {Array<{path:string, blob:string}>} currentFiles
 * @param {Array<{path:string, size:number, blob:string}>} nextEntries
 * @returns {{unchanged: object[], download: object[], removed: string[]}}
 */
function diffEngineFiles(currentFiles, nextEntries) {
  const current = new Map((currentFiles || []).map((f) => [f.path, f.blob]));
  const unchanged = [];
  const download = [];
  for (const entry of nextEntries) (current.get(entry.path) === entry.blob ? unchanged : download).push(entry);
  const next = new Set(nextEntries.map((e) => e.path));
  const removed = [...current.keys()].filter((p) => !next.has(p)).sort(comparePaths);
  return { unchanged, download, removed };
}

/**
 * Size, content SHA-1 and git blob SHA-1 of a file (engine files are small: read at once).
 * @param {string} file
 * @returns {Promise<{size:number, sha1:string, blob:string}>}
 */
async function hashFile(file) {
  const data = await fsp.readFile(file);
  return { size: data.length, sha1: sha1Hex(data), blob: gitBlobSha1(data) };
}

/**
 * Engine files present in a local folder (an engine checkout or a built engine), sorted POSIX paths.
 * Symbolic links are ignored (a shipped engine never contains any).
 * @param {string} engineDir
 * @returns {Promise<string[]>}
 */
async function collectEngineFiles(engineDir) {
  const files = [];
  async function walk(relDir) {
    let entries;
    try {
      entries = await fsp.readdir(relDir ? path.join(engineDir, ...relDir.split('/')) : engineDir, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        if (relDir || ENGINE_DIRS.includes(entry.name)) await walk(rel);
      } else if (entry.isFile() && isEngineFile(rel)) {
        files.push(rel);
      }
    }
  }
  await walk('');
  return files.sort(comparePaths);
}

/**
 * Check a folder against its manifest: every listed file present with the right size (and, with `deep`,
 * the right git blob SHA-1), and no unlisted engine file or stray entry next to them.
 * @param {string} engineDir
 * @param {object} manifest a validated manifest
 * @param {{deep?: boolean}} [options]
 * @returns {Promise<{ok:boolean, missing:string[], changed:string[], extra:string[]}>}
 */
async function verifyEngineDir(engineDir, manifest, { deep = true } = {}) {
  const missing = [];
  const changed = [];
  for (const f of manifest.files) {
    const abs = path.join(engineDir, ...f.path.split('/'));
    let st;
    try {
      st = await fsp.stat(abs);
    } catch {
      missing.push(f.path);
      continue;
    }
    if (!st.isFile() || st.size !== f.size) {
      changed.push(f.path);
    } else if (deep && (await hashFile(abs)).blob !== f.blob) {
      changed.push(f.path);
    }
  }
  const listed = new Set(manifest.files.map((f) => f.path));
  const extra = (await listAllFiles(engineDir)).filter((rel) => rel !== MANIFEST_NAME && !listed.has(rel));
  return { ok: missing.length === 0 && changed.length === 0 && extra.length === 0, missing, changed, extra };
}

/** Every file below a folder (POSIX paths), whatever its name: used to spot strays in a built engine. */
async function listAllFiles(root) {
  const out = [];
  async function walk(relDir) {
    let entries;
    try {
      entries = await fsp.readdir(relDir ? path.join(root, ...relDir.split('/')) : root, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(rel);
      else out.push(rel);
    }
  }
  await walk('');
  return out.sort(comparePaths);
}

module.exports = {
  MANIFEST_NAME,
  MANIFEST_FORMAT,
  ENGINE_DIRS,
  ENGINE_ROOT_FILES,
  REQUIRED_ENGINE_FILES,
  sha1Hex,
  gitBlobSha1,
  isSha,
  isRepository,
  isSafeRelativePath,
  isEngineFile,
  missingRequiredFiles,
  comparePaths,
  normalizeRef,
  validateEngineSource,
  sameSource,
  serializeEngineLock,
  parseEngineLock,
  readEngineVersion,
  buildManifest,
  validateManifest,
  serializeManifest,
  parseManifest,
  readManifest,
  engineEntriesFromTree,
  diffEngineFiles,
  hashFile,
  collectEngineFiles,
  verifyEngineDir,
};
