#!/usr/bin/env node
// Check a Windows build in dist/ before it reaches anyone: run it after `electron-builder --win` (CI does on
// every push, and the release workflow does before it pushes the version tag). Each check stands for a way
// the installer can be broken while electron-builder still reports success:
//
//   - The installer package.json names (build.nsis.artifactName: Kirigami-Setup-<version>.exe), its .blockmap
//     and latest.yml exist, and latest.yml names that installer, its version and its real SHA-512. latest.yml
//     is the update feed installed copies read; electron-updater refuses a download whose SHA-512 differs, so
//     a feed that does not match its installer blocks every update.
//   - resources/app-update.yml points at the GitHub repository the releases are published to. Without it, or
//     pointing elsewhere, installed copies never see an update. electron-builder writes it for the NSIS
//     target only, never for `--dir` builds, which is why CI builds the real installer.
//   - resources/engine has its .engine-manifest.json and is exactly the Silhouette Card Maker commit pinned
//     in engine.lock.json, every file checked against its git blob SHA-1 (scripts/fetch-engine.mjs --verify).
//   - resources/bin/uv.exe is byte for byte the uv.exe `npm run fetch-uv` verified against its pin, and its
//     license travels with it.
//   - src/python/scm_helper.py is unpacked next to app.asar: Python cannot read files inside the archive.
//   - Every runtime dependency in package.json is inside app.asar. electron-builder works out which modules
//     to copy by itself, and when its npm lookup finds nothing it falls back to walking node_modules; a
//     missing electron-updater would leave installed copies unable to receive the update that fixes it.
//
//   node scripts/check-package.mjs                            check dist/ (the build of package.json's version)
//   node scripts/check-package.mjs --dist <dir>               check another electron-builder output folder
//   node scripts/check-package.mjs --repository <owner/name>  where the releases go (default: package.json
//                                                             `repository`; the release workflow passes its own)

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { MANIFEST_NAME } = require('../src/main/engine-files.js');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
/** electron-builder's NSIS default, used when package.json sets no artifactName. */
const DEFAULT_ARTIFACT_NAME = '${productName} Setup ${version}.${ext}';
/** Asset names GitHub keeps as they are; it renames anything else on upload. */
const GITHUB_SAFE_NAME = /^[0-9A-Za-z._-]+$/;
/** Inside resources/: the helper the app runs with the card maker's Python (package.json asarUnpack). */
const PYTHON_HELPER = ['app.asar.unpacked', 'src', 'python', 'scm_helper.py'];

const log = (msg) => console.log(`[check-package] ${msg}`);
const rel = (p) => path.relative(APP_DIR, p) || '.';
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;

function usage() {
  return [
    'Usage: node scripts/check-package.mjs [--dist <dir>] [--repository <owner/name>]',
    'Checks an `electron-builder --win` build: installer, blockmap and update feed, app-update.yml, the bundled',
    'engine (against engine.lock.json), uv.exe, the unpacked Python helper and the runtime dependencies in app.asar.',
    '  --dist <dir>               electron-builder output folder (default: package.json build.directories.output, else dist)',
    '  --repository <owner/name>  GitHub repository the releases are published to (default: package.json repository)',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { dist: null, repository: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--dist' || a === '--repository') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${a} needs a value\n${usage()}`);
      args[a.slice(2)] = value;
    } else throw new Error(`unknown option ${a}\n${usage()}`);
  }
  return args;
}

/**
 * Top-level `key: value` scalars of a flat YAML file such as electron-builder's latest.yml and
 * app-update.yml. Nested lines, list items, comments and keys without a value are skipped; one level of
 * quotes is removed. Enough for those generated files, not a YAML parser.
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function readYamlScalars(text) {
  const values = {};
  for (const line of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const match = /^([A-Za-z_][\w.-]*):[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (!match || match[2].startsWith('#')) continue;
    let value = match[2];
    if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    } else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    }
    values[match[1]] = value;
  }
  return values;
}

/**
 * "owner/name" of a GitHub repository: from package.json `repository` (a string or `{ url }`; https, git+https,
 * ssh or scp-like URL, or the `github:owner/name` shorthand) or from an "owner/name" string.
 * @param {string|{url?:string}|null|undefined} value
 * @returns {string|null}
 */
export function githubSlug(value) {
  const text = String(value && typeof value === 'object' ? value.url || '' : value || '').trim();
  const fromUrl = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(text);
  if (fromUrl) return `${fromUrl[1]}/${fromUrl[2]}`;
  const short = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(text);
  return short ? `${short[1]}/${short[2]}` : null;
}

/**
 * The installer's file name for this package.json: build.nsis.artifactName (else build.win.artifactName,
 * build.artifactName, electron-builder's default) with ${productName}, ${version} and ${ext} expanded.
 * Throws for any other macro, and for a name GitHub would change on upload: the local file, the release
 * asset and the name in latest.yml must be one and the same.
 * @param {object} pkg parsed package.json
 * @returns {string}
 */
export function installerFileName(pkg) {
  const build = (pkg && pkg.build) || {};
  const pattern = (build.nsis && build.nsis.artifactName) || (build.win && build.win.artifactName) || build.artifactName || DEFAULT_ARTIFACT_NAME;
  const values = { productName: pkg.productName || pkg.name, version: pkg.version, ext: 'exe' };
  const name = pattern.replace(/\$\{([^}]*)\}/g, (macro, key) => {
    if (!Object.hasOwn(values, key) || !values[key]) throw new Error(`artifactName "${pattern}" uses ${macro}, which this check cannot expand`);
    return values[key];
  });
  if (!GITHUB_SAFE_NAME.test(name)) {
    throw new Error(`the installer would be named "${name}", which GitHub renames on upload: make build.nsis.artifactName produce letters, digits, ".", "-" and "_" only`);
  }
  return name;
}

/**
 * Whether electron-builder writes a .blockmap next to the installer (it does unless nsis.differentialPackage
 * is false); the blockmap lets installed copies download only the changed parts of an update.
 * @param {object} pkg parsed package.json
 * @returns {boolean}
 */
export function expectsBlockmap(pkg) {
  const nsis = (pkg && pkg.build && pkg.build.nsis) || {};
  return nsis.differentialPackage !== false;
}

/**
 * What is wrong with latest.yml (the update feed) for this installer; empty when nothing is.
 * @param {Record<string,string>} feed readYamlScalars(latest.yml)
 * @param {{version:string, installer:string, sha512:string}} expected the build's version, installer file
 *   name and the installer's SHA-512 (base64, as electron-builder writes it)
 * @returns {string[]}
 */
export function feedProblems(feed, expected) {
  const problems = [];
  if (feed.version !== expected.version) problems.push(`it announces version ${feed.version || '(none)'}, not ${expected.version}`);
  if (feed.path !== expected.installer) problems.push(`it points at ${feed.path || '(nothing)'}, not ${expected.installer}`);
  if (feed.sha512 !== expected.sha512) {
    problems.push(`its SHA-512 is not the one of ${expected.installer}: installed copies would refuse the download`);
  }
  return problems;
}

/**
 * What is wrong with resources/app-update.yml (where installed copies look for updates); empty when nothing is.
 * @param {Record<string,string>} config readYamlScalars(app-update.yml)
 * @param {string} slug "owner/name" of the repository the releases are published to
 * @returns {string[]}
 */
export function updateConfigProblems(config, slug) {
  const problems = [];
  if (config.provider !== 'github') problems.push(`it uses the update provider "${config.provider || '(none)'}", not github`);
  const target = config.owner && config.repo ? `${config.owner}/${config.repo}` : '(no repository)';
  if (target.toLowerCase() !== String(slug).toLowerCase()) problems.push(`installed copies would look for updates in ${target}, but releases are published to ${slug}`);
  return problems;
}

/**
 * Runtime dependencies (package.json `dependencies`) whose package.json is not inside app.asar.
 * @param {object} pkg parsed package.json
 * @param {string[]} entries app.asar entries as @electron/asar lists them ('\node_modules\x\package.json' on
 *   Windows, '/node_modules/x/package.json' elsewhere)
 * @returns {string[]} names of the missing dependencies, in package.json order
 */
export function missingDependencies(pkg, entries) {
  const packaged = new Set(entries.map((entry) => `/${String(entry).split('\\').join('/').replace(/^\/+/, '')}`));
  return Object.keys((pkg && pkg.dependencies) || {}).filter((name) => !packaged.has(`/node_modules/${name}/package.json`));
}

/** Entries of an asar archive, read with electron-builder's own @electron/asar. */
function listAsar(file) {
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    throw new Error('@electron/asar, which comes with electron-builder, is not installed: run "npm ci"');
  }
  return asar.listPackage(file);
}

/** Streamed hash of a file in the given encoding. */
async function hashFile(file, algorithm, encoding) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest(encoding);
}

/** Size of a regular file, or null when there is none. */
async function fileSize(file) {
  try {
    const stat = await fs.stat(file);
    return stat.isFile() ? stat.size : null;
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
}

/** --verify of fetch-engine.mjs, so "matches engine.lock.json" means the same thing everywhere. */
function verifyEngine(engineDir) {
  const result = spawnSync(process.execPath, [path.join(SCRIPT_DIR, 'fetch-engine.mjs'), '--verify', engineDir], {
    cwd: APP_DIR,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) return { ok: false, detail: result.error.message };
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim().replace(/^\[fetch-engine\]\s*(ERROR:\s*)?/gm, '');
  return { ok: result.status === 0, detail: output.split('\n').pop() || `exit code ${result.status}` };
}

/**
 * Run every check and report each one, so a single run lists everything that is wrong.
 * @returns {Promise<string[]>} the failures (empty when the build is good)
 */
async function checkBuild({ pkg, dist, slug }) {
  const failures = [];
  async function check(what, fn) {
    try {
      const result = await fn();
      if (Array.isArray(result) && result.length) failures.push(...result.map((problem) => `${what}: ${problem}`));
      else log(`ok   ${what}${typeof result === 'string' ? `: ${result}` : ''}`);
    } catch (err) {
      failures.push(`${what}: ${err && err.message ? err.message : err}`);
    }
  }
  const missing = (file) => [`${rel(file)} is missing`];

  const installer = installerFileName(pkg);
  const installerPath = path.join(dist, installer);
  const resources = path.join(dist, 'win-unpacked', 'resources');

  await check(installer, async () => {
    const size = await fileSize(installerPath);
    return size === null ? missing(installerPath) : mb(size);
  });
  if (expectsBlockmap(pkg)) {
    await check(`${installer}.blockmap`, async () => ((await fileSize(`${installerPath}.blockmap`)) === null ? missing(`${installerPath}.blockmap`) : []));
  }
  await check('latest.yml (the update feed)', async () => {
    const feedFile = path.join(dist, 'latest.yml');
    if ((await fileSize(feedFile)) === null) return missing(feedFile);
    if ((await fileSize(installerPath)) === null) return [`cannot be checked without ${installer}`];
    const feed = readYamlScalars(await fs.readFile(feedFile, 'utf8'));
    const problems = feedProblems(feed, { version: pkg.version, installer, sha512: await hashFile(installerPath, 'sha512', 'base64') });
    return problems.length ? problems : `version ${feed.version}, SHA-512 matches`;
  });
  await check('resources/app-update.yml (where installed copies look for updates)', async () => {
    const file = path.join(resources, 'app-update.yml');
    if ((await fileSize(file)) === null) return [`${rel(file)} is missing, so installed copies could never update (electron-builder writes it for NSIS builds only)`];
    const problems = updateConfigProblems(readYamlScalars(await fs.readFile(file, 'utf8')), slug);
    return problems.length ? problems : `github ${slug}`;
  });
  await check('resources/engine', async () => {
    const engineDir = path.join(resources, 'engine');
    const manifest = path.join(engineDir, MANIFEST_NAME);
    if ((await fileSize(manifest)) === null) {
      return [`${rel(manifest)} is missing: the app reads the engine's commit and file list from it (npm run fetch-engine writes it into build/engine)`];
    }
    const result = verifyEngine(engineDir);
    return result.ok ? result.detail.replace(/^.*? matches /, 'matches ') : [result.detail];
  });
  await check('resources/bin/uv.exe', async () => {
    const packaged = path.join(resources, 'bin', 'uv.exe');
    const verified = path.join(APP_DIR, 'build', 'uv', 'uv.exe');
    if ((await fileSize(packaged)) === null) return missing(packaged);
    if ((await fileSize(verified)) === null) return [`${rel(verified)} is missing: run "npm run fetch-uv" so the packaged copy can be compared with the verified one`];
    const problems = [];
    if (await hashFile(packaged, 'sha256', 'hex') !== await hashFile(verified, 'sha256', 'hex')) problems.push(`it differs from ${rel(verified)}, the copy fetch-uv verified`);
    if ((await fileSize(path.join(resources, 'bin', 'LICENSE-uv.txt'))) === null) problems.push('its license (LICENSE-uv.txt) is missing next to it');
    return problems.length ? problems : 'same as the verified build/uv/uv.exe, license included';
  });
  await check('src/python/scm_helper.py unpacked from app.asar', async () => {
    const file = path.join(resources, ...PYTHON_HELPER);
    return (await fileSize(file)) === null ? missing(file) : [];
  });
  await check('runtime dependencies in app.asar', async () => {
    const names = Object.keys(pkg.dependencies || {});
    if (!names.length) return 'none (package.json has no dependencies)';
    const archive = path.join(resources, 'app.asar');
    if ((await fileSize(archive)) === null) return missing(archive);
    const absent = missingDependencies(pkg, listAsar(archive));
    return absent.length ? absent.map((name) => `${name} is not packaged: the installed app would fail as soon as it loads it`) : names.join(', ');
  });
  return failures;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const pkg = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8'));
  const output = (pkg.build && pkg.build.directories && pkg.build.directories.output) || 'dist';
  const dist = path.resolve(APP_DIR, args.dist || output);
  const slug = githubSlug(args.repository || pkg.repository);
  if (!slug) {
    throw new Error(args.repository ? `--repository ${args.repository} is not "owner/name"` : 'package.json has no GitHub repository: pass --repository <owner/name>');
  }

  log(`checking ${rel(dist)}: ${pkg.productName || pkg.name} ${pkg.version}, releases published to ${slug}`);
  const failures = await checkBuild({ pkg, dist, slug });
  if (failures.length) {
    for (const failure of failures) console.error(`[check-package] FAIL ${failure}`);
    throw new Error(`${failures.length} problem${failures.length === 1 ? '' : 's'} found in ${rel(dist)}: do not ship this build`);
  }
  log('the build is complete');
}

/** True when node was started with this file (not when a test imports it). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(`[check-package] ERROR: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
