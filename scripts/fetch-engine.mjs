#!/usr/bin/env node
// Build build/engine/ from the Silhouette Card Maker commit pinned in engine.lock.json, for packaging and
// for `npm start` (the repository holds no engine code: the installer ships resources/engine from here).
//
// build/engine = the engine files (src/main/engine-files.js decides which) + .engine-manifest.json, which
// records the commit and every file's size, SHA-1 and git blob SHA-1. Every file is downloaded from
// raw.githubusercontent.com at the pinned commit and checked against the blob SHA-1 listed in that commit's
// tree, so the commit SHA in engine.lock.json is the only thing to trust. Downloads are kept in a
// content-addressed cache (build/.engine-cache, or SCM_ENGINE_CACHE to share one between worktrees), so a
// rebuild, or a newer commit that changes a few files, only downloads what is new.
//
//   node scripts/fetch-engine.mjs                  make build/engine match engine.lock.json (no-op when it does)
//   node scripts/fetch-engine.mjs --update         pin the latest commit of the locked branch, then build
//   node scripts/fetch-engine.mjs --update --ref <branch>   same, following another branch
//   node scripts/fetch-engine.mjs --check          exit 1 when build/engine is missing or does not match (offline)
//   node scripts/fetch-engine.mjs --force          rebuild build/engine even when it matches
//   node scripts/fetch-engine.mjs --prestart       what `npm start` needs: nothing when SCM_ENGINE_DIR links an
//                                                  engine; otherwise build/engine, keeping the previous copy
//                                                  (with a warning) when GitHub cannot be reached
//   node scripts/fetch-engine.mjs --verify <dir>   check a packaged engine folder (e.g. dist/win-unpacked/resources/engine)
//
// GitHub budget: the file list costs one REST API call per commit (cached), --update one more; the REST API
// allows 60 calls per hour per IP address without a token. Set GITHUB_TOKEN or GH_TOKEN to lift that limit
// (CI does). Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1.

import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const engineFiles = require('../src/main/engine-files.js');
const { createEngineRemote, DEFAULT_ENGINE_REPOSITORY, DEFAULT_ENGINE_REF } = require('../src/main/engine-remote.js');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const LOCK_FILE = path.join(APP_DIR, 'engine.lock.json');
const BUILD_DIR = path.join(APP_DIR, 'build');
const OUT_DIR = path.join(BUILD_DIR, 'engine');
const CACHE_DIR = process.env.SCM_ENGINE_CACHE ? path.resolve(process.env.SCM_ENGINE_CACHE) : path.join(BUILD_DIR, '.engine-cache');
const PARALLEL_DOWNLOADS = 8;
/** Failures that mean "GitHub could not be reached right now" (tolerated by --prestart). */
const OFFLINE_CODES = new Set(['NETWORK', 'RATE_LIMITED', 'HTTP_ERROR', 'BAD_RESPONSE']);

const log = (msg) => console.log(`[fetch-engine] ${msg}`);
const rel = (p) => path.relative(APP_DIR, p) || '.';
const short = (sha) => String(sha).slice(0, 7);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function usage() {
  return [
    'Usage: node scripts/fetch-engine.mjs [--update [--ref <branch>]] [--check] [--force] [--prestart] [--verify <dir>]',
    'Builds build/engine/ from the Silhouette Card Maker commit pinned in engine.lock.json.',
    '  --update        pin the latest commit of the locked branch (or --ref), then build',
    '  --check         exit 1 when build/engine is missing or does not match the lock (no network, no writes)',
    '  --force         rebuild even when build/engine already matches',
    '  --prestart      for `npm start`: skip when SCM_ENGINE_DIR is set; keep a previous build when offline',
    '  --verify <dir>  check an engine folder against its own manifest and the lock (e.g. a packaged build)',
    'Environment: GITHUB_TOKEN / GH_TOKEN (REST rate limit), SCM_ENGINE_CACHE (download cache folder).',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { update: false, ref: null, check: false, force: false, prestart: false, verify: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--update') args.update = true;
    else if (a === '--check') args.check = true;
    else if (a === '--force') args.force = true;
    else if (a === '--prestart') args.prestart = true;
    else if (a === '--ref' || a === '--verify') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${a} needs a value\n${usage()}`);
      args[a.slice(2)] = value;
    } else throw new Error(`unknown option ${a}\n${usage()}`);
  }
  if (args.ref && !args.update) throw new Error('--ref only makes sense with --update');
  return args;
}

function remote() {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  return createEngineRemote({ fetch, token });
}

/** Message plus technical details (userError keeps them apart). */
function describeError(err) {
  if (!err) return 'unknown error';
  const details = err.details ? `\n  ${String(err.details).split('\n').join('\n  ')}` : '';
  const hint = err.code === 'RATE_LIMITED' ? '\n  Set GITHUB_TOKEN (or GH_TOKEN) to a GitHub token to avoid the limit.'
    : err.code === 'NETWORK' ? '\n  Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1.' : '';
  return `${err.message || err}${details}${hint}`;
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file atomically (temp file in the same folder, then rename). `shared`: a content-addressed cache
 * file that another process (a second worktree sharing the cache) may be writing at the same moment.
 */
async function writeAtomic(file, data, { shared = false } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.writeFile(tmp, data);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    // Same name = same content in the cache: whoever renamed first wrote what we wanted.
    if (shared && err && (err.code === 'EPERM' || err.code === 'EEXIST' || err.code === 'EBUSY') && await exists(file)) return;
    throw err;
  }
}

async function readLock() {
  let text;
  try {
    text = await fs.readFile(LOCK_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
  return engineFiles.parseEngineLock(text);
}

/** Pin the latest commit of the branch in engine.lock.json (ls-refs, plus one REST call when it moved). */
async function updateLock(current, refArg) {
  const repository = current ? current.repository : DEFAULT_ENGINE_REPOSITORY;
  const ref = engineFiles.normalizeRef(refArg || (current ? current.ref : DEFAULT_ENGINE_REF));
  const client = remote();
  const { commit } = await client.lsRemote(repository, ref);
  if (current && current.commit === commit && current.ref === ref) {
    log(`engine.lock.json already pins the latest ${repository} ${ref}: ${short(commit)} (${current.committedAt})`);
    return current;
  }
  const info = await client.getCommit(repository, commit);
  const next = { repository, ref, commit, committedAt: info.committedAt };
  await writeAtomic(LOCK_FILE, engineFiles.serializeEngineLock(next));
  const subject = info.message.split(/\r?\n/)[0];
  log(`engine.lock.json: ${current ? short(current.commit) : '(new)'} -> ${short(commit)} (${info.committedAt}) "${subject}"`);
  return next;
}

// ---------------------------------------------------------------------------------------------
// Download cache: <cache>/blobs/<ab>/<git blob sha1> (content-addressed, verified on every read) and
// <cache>/trees/<owner>__<name>@<commit>.json (a commit's file list never changes)
// ---------------------------------------------------------------------------------------------

const blobFile = (blob) => path.join(CACHE_DIR, 'blobs', blob.slice(0, 2), blob);
const treeFile = (repository, commit) => path.join(CACHE_DIR, 'trees', `${repository.replace('/', '__')}@${commit}.json`);

async function readCachedTree(lock) {
  try {
    const data = JSON.parse(await fs.readFile(treeFile(lock.repository, lock.commit), 'utf8'));
    return data && data.commit === lock.commit && Array.isArray(data.entries) ? data.entries : null;
  } catch {
    return null;
  }
}

/** The commit's file list: from the cache, else one REST call (then cached: a commit's tree never changes). */
async function loadTree(lock) {
  const cached = await readCachedTree(lock);
  if (cached) return cached;
  log(`listing the files of ${lock.repository}@${short(lock.commit)} (1 GitHub API call)`);
  const tree = await remote().getTree(lock.repository, lock.commit);
  await writeAtomic(treeFile(lock.repository, lock.commit), `${JSON.stringify({ repository: lock.repository, commit: lock.commit, entries: tree.entries })}\n`, { shared: true });
  return tree.entries;
}

/** A verified copy of one blob: from the cache, else downloaded (and cached). */
async function blobContent(client, lock, entry, stats) {
  const file = blobFile(entry.blob);
  try {
    const data = await fs.readFile(file);
    if (engineFiles.gitBlobSha1(data) === entry.blob) {
      stats.cached += 1;
      return data;
    }
    await fs.rm(file, { force: true }); // damaged cache entry: download it again
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  const data = await client.downloadFile(lock.repository, lock.commit, entry.path, entry.blob);
  await writeAtomic(file, data, { shared: true });
  stats.downloaded += 1;
  stats.downloadedBytes += data.length;
  return data;
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failed) throw failed;
  return results;
}

// ---------------------------------------------------------------------------------------------
// build/engine
// ---------------------------------------------------------------------------------------------

/**
 * Does build/engine match the lock? Offline: compares the manifest's commit with the lock, the files on
 * disk with the manifest (git blob SHA-1 of every file, and no stray file), and the file selection with the
 * cached tree when there is one (so a change of the engine file filter triggers a rebuild).
 * @returns {Promise<{status:'current'|'missing'|'stale', reason:string, manifest:object|null}>}
 */
async function inspectBuild(lock, dir = OUT_DIR) {
  let manifest;
  try {
    manifest = await engineFiles.readManifest(dir);
  } catch (err) {
    return { status: 'stale', reason: `its manifest is unreadable (${err.message})`, manifest: null };
  }
  if (!manifest) return { status: 'missing', reason: `${rel(dir)} has no engine yet`, manifest: null };
  if (!engineFiles.sameSource(manifest.source, lock)) {
    return { status: 'stale', reason: `it holds ${manifest.source.repository}@${short(manifest.source.commit)} but engine.lock.json pins ${lock.repository}@${short(lock.commit)}`, manifest };
  }
  const outsideFilter = manifest.files.filter((f) => !engineFiles.isEngineFile(f.path));
  if (outsideFilter.length) return { status: 'stale', reason: `it contains files that are no longer shipped (${outsideFilter[0].path})`, manifest };
  const cachedTree = await readCachedTree(lock);
  if (cachedTree) {
    const expected = engineFiles.engineEntriesFromTree(cachedTree);
    const listed = new Map(manifest.files.map((f) => [f.path, f.blob]));
    if (expected.length !== listed.size || expected.some((e) => listed.get(e.path) !== e.blob)) {
      return { status: 'stale', reason: 'the selection of engine files changed', manifest };
    }
  }
  const check = await engineFiles.verifyEngineDir(dir, manifest, { deep: true });
  if (!check.ok) {
    const first = [...check.missing.map((p) => `missing ${p}`), ...check.changed.map((p) => `modified ${p}`), ...check.extra.map((p) => `unexpected ${p}`)];
    return { status: 'stale', reason: `its files do not match its manifest (${first.slice(0, 3).join(', ')}${first.length > 3 ? ', ...' : ''})`, manifest };
  }
  return { status: 'current', reason: '', manifest };
}

/** Remove staging folders left behind by an interrupted run. */
async function removeLeftovers() {
  let names = [];
  try {
    names = await fs.readdir(BUILD_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    if (/^engine\.(partial|old)-\d+$/.test(name)) await fs.rm(path.join(BUILD_DIR, name), { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Replace build/engine with the staged folder (rename the old one away first; restore it on failure). */
async function swapInto(staging) {
  const old = `${OUT_DIR}.old-${process.pid}`;
  const hadOld = await exists(OUT_DIR);
  try {
    if (hadOld) await fs.rename(OUT_DIR, old);
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
      throw new Error(`${rel(OUT_DIR)} is in use (a running app, an editor or an antivirus scan?). Close it and run again.`);
    }
    throw err;
  }
  try {
    await fs.rename(staging, OUT_DIR);
  } catch (err) {
    if (hadOld) await fs.rename(old, OUT_DIR).catch(() => {});
    throw err;
  }
  if (hadOld) await fs.rm(old, { recursive: true, force: true, maxRetries: 3 });
}

async function buildEngine(lock) {
  const entries = engineFiles.engineEntriesFromTree(await loadTree(lock));
  const missing = engineFiles.missingRequiredFiles(entries.map((e) => e.path));
  if (missing.length) throw new Error(`${lock.repository}@${short(lock.commit)} does not look like Silhouette Card Maker: ${missing.join(', ')} missing`);
  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  log(`${entries.length} engine files, ${mb(totalBytes)} (cache: ${CACHE_DIR})`);

  await removeLeftovers();
  const staging = `${OUT_DIR}.partial-${process.pid}`;
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging, { recursive: true });
  const client = remote();
  const stats = { cached: 0, downloaded: 0, downloadedBytes: 0 };
  const progress = process.stdout.isTTY;
  let done = 0;
  try {
    const files = await mapLimit(entries, PARALLEL_DOWNLOADS, async (entry) => {
      const data = await blobContent(client, lock, entry, stats);
      const dest = path.join(staging, ...entry.path.split('/'));
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, data);
      done += 1;
      if (progress) process.stdout.write(`[fetch-engine]   ${done}/${entries.length} files\r`);
      return { path: entry.path, size: data.length, sha1: engineFiles.sha1Hex(data), blob: entry.blob };
    });
    if (progress) process.stdout.write(`${' '.repeat(60)}\r`);
    const engineVersion = engineFiles.readEngineVersion(await fs.readFile(path.join(staging, 'create_pdf.py'), 'utf8'));
    const manifest = engineFiles.buildManifest({ source: lock, engineVersion, files });
    await fs.writeFile(path.join(staging, engineFiles.MANIFEST_NAME), engineFiles.serializeManifest(manifest));
    const check = await engineFiles.verifyEngineDir(staging, manifest, { deep: false });
    if (!check.ok) throw new Error(`the staged engine does not match its manifest: ${JSON.stringify(check)}`);
    await swapInto(staging);
    log(`downloaded ${stats.downloaded} files (${mb(stats.downloadedBytes)}), ${stats.cached} from the cache`);
    log(`${rel(OUT_DIR)} ready: Silhouette Card Maker ${engineVersion || '(unknown version)'} at ${short(lock.commit)} (${lock.committedAt}), ${manifest.fileCount} files, ${mb(manifest.totalBytes)}`);
    return manifest;
  } finally {
    await fs.rm(staging, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

/** --verify <dir>: an engine folder (e.g. a packaged one) holds exactly what its manifest lists, at the locked commit. */
async function verifyFolder(dir, lock) {
  const target = path.resolve(dir);
  const state = await inspectBuild(lock, target);
  if (state.status !== 'current') throw new Error(`${target}: ${state.reason}`);
  log(`${target} matches engine.lock.json: ${state.manifest.fileCount} files at ${short(lock.commit)}, every git blob SHA-1 verified`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (args.prestart && process.env.SCM_ENGINE_DIR) {
    log(`SCM_ENGINE_DIR is set: the app uses the engine in ${process.env.SCM_ENGINE_DIR}; build/engine is not needed`);
    return;
  }

  let lock = await readLock();
  if (args.update) lock = await updateLock(lock, args.ref);
  if (!lock) throw new Error('engine.lock.json is missing: run "npm run fetch-engine -- --update" to pin the latest engine');

  if (args.verify) {
    await verifyFolder(args.verify, lock);
    return;
  }

  const state = await inspectBuild(lock);
  if (args.check) {
    if (state.status === 'current') {
      log(`${rel(OUT_DIR)} matches engine.lock.json (${lock.repository}@${short(lock.commit)}, ${state.manifest.fileCount} files)`);
    } else {
      log(`${rel(OUT_DIR)} is ${state.status === 'missing' ? 'missing' : 'out of date'}: ${state.reason}. Run "npm run fetch-engine".`);
      process.exitCode = 1;
    }
    return;
  }
  if (state.status === 'current' && !args.force) {
    log(`${rel(OUT_DIR)} already matches engine.lock.json (${lock.repository}@${short(lock.commit)}, ${state.manifest.fileCount} files)`);
    return;
  }
  if (state.status !== 'missing') log(`rebuilding ${rel(OUT_DIR)}: ${args.force && state.status === 'current' ? '--force' : state.reason}`);

  try {
    await buildEngine(lock);
  } catch (err) {
    if (args.prestart && state.status !== 'missing' && err && OFFLINE_CODES.has(err.code)) {
      log(`WARNING: could not update ${rel(OUT_DIR)}, starting with the engine already there.\n  ${describeError(err).split('\n').join('\n  ')}`);
      return;
    }
    throw err;
  }
}

main().catch((err) => {
  console.error(`[fetch-engine] ERROR: ${describeError(err)}`);
  process.exitCode = 1;
});
