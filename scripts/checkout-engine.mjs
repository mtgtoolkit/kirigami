#!/usr/bin/env node
// Check out the Silhouette Card Maker commit pinned in engine.lock.json into .engine-src/ (git-ignored),
// for the tests that need more of the engine than the app ships: the catalog tests compare the app's game
// and option data with the plugins, click options, README and Hugo documentation, and the integration and
// end-to-end tests use the engine's test images. test/support/engine.js finds it there.
//
// Kept small and fast: a partial clone (no file contents until needed), a sparse checkout of only the
// folders the tests read, and the exact locked commit (detached HEAD). About 80 MB, a few seconds.
//
//   node scripts/checkout-engine.mjs          create .engine-src, or move it to the locked commit
//   node scripts/checkout-engine.mjs --venv   also create .engine-src/venv with the engine's requirements
//                                             (uses build/uv/uv.exe from "npm run fetch-uv", or uv on PATH)
//
// The tests use .engine-src/venv as their Python unless SCM_TEST_PYTHON points at another one.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const engineFiles = require('../src/main/engine-files.js');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const LOCK_FILE = path.join(APP_DIR, 'engine.lock.json');
const TARGET = path.join(APP_DIR, '.engine-src');
/** Cone-mode sparse folders (root files and the files directly inside hugo/ and test/ come along). */
const SPARSE_DIRS = Object.freeze(['assets', 'plugins', 'calibration', 'cutting_templates', 'hugo/content', 'test/images']);
const IS_WIN = process.platform === 'win32';
const VENV_PYTHON_VERSION = '3.12';

const log = (msg) => console.log(`[engine-checkout] ${msg}`);

/** Run a command; returns trimmed stdout, throws with its output when it fails. */
function run(cmd, args, { cwd = APP_DIR, allowFailure = false, inherit = false } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) {
    if (allowFailure) return null;
    throw new Error(result.error.code === 'ENOENT' ? `${cmd} was not found on PATH` : `${cmd}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    if (allowFailure) return null;
    const output = `${result.stderr || ''}${result.stdout || ''}`.trim();
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})${output ? `:\n  ${output.split('\n').join('\n  ')}` : ''}`);
  }
  return (result.stdout || '').trim();
}

const git = (args, options = {}) => run('git', ['-C', TARGET, ...args], options);

function readLock() {
  let text;
  try {
    text = fs.readFileSync(LOCK_FILE, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') throw new Error('engine.lock.json is missing: run "npm run fetch-engine -- --update" first');
    throw err;
  }
  return engineFiles.parseEngineLock(text);
}

function sameUrl(a, b) {
  const norm = (u) => String(u || '').trim().replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
  return norm(a) === norm(b);
}

function checkout(lock) {
  const url = `https://github.com/${lock.repository}.git`;
  const short = lock.commit.slice(0, 7);
  if (!fs.existsSync(path.join(TARGET, '.git'))) {
    if (fs.existsSync(TARGET) && fs.readdirSync(TARGET).length > 0) {
      throw new Error(`${TARGET} exists but is not a git checkout: delete it and run again`);
    }
    log(`cloning ${lock.repository} (partial clone: commits and folder lists only)`);
    run('git', ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--no-tags', url, TARGET]);
  } else {
    const origin = git(['config', '--get', 'remote.origin.url'], { allowFailure: true });
    if (!sameUrl(origin, url)) {
      throw new Error(`${TARGET} is a checkout of ${origin || 'an unknown repository'}, not ${url}: delete it and run again`);
    }
  }

  git(['sparse-checkout', 'set', '--cone', ...SPARSE_DIRS]);
  // A fresh --no-checkout clone has HEAD on the branch but no files yet; ours is always a detached HEAD.
  const detached = git(['symbolic-ref', '--quiet', 'HEAD'], { allowFailure: true }) === null;
  const head = detached ? git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFailure: true }) : null;
  if (head === lock.commit) {
    log(`.engine-src already at ${short} (${lock.committedAt})`);
  } else {
    if (git(['cat-file', '-e', `${lock.commit}^{commit}`], { allowFailure: true }) === null) {
      log(`fetching ${short} from ${lock.repository}`);
      git(['fetch', '--quiet', '--filter=blob:none', '--no-tags', 'origin', lock.commit]);
    }
    log(`checking out ${short}${head ? ` (was ${head.slice(0, 7)})` : ''}: ${SPARSE_DIRS.join(', ')} and the root files`);
    git(['-c', 'advice.detachedHead=false', 'checkout', '--quiet', '--detach', lock.commit]);
  }
  const missing = engineFiles.REQUIRED_ENGINE_FILES.filter((rel) => !fs.existsSync(path.join(TARGET, ...rel.split('/'))));
  if (missing.length) throw new Error(`the checkout is incomplete (${missing.join(', ')} missing)`);
  log(`.engine-src ready: ${lock.repository}@${short} (${lock.committedAt})`);
}

/** The uv to use: the pinned build/uv/uv.exe (npm run fetch-uv), else uv on PATH. */
function findUv() {
  const bundled = path.join(APP_DIR, 'build', 'uv', IS_WIN ? 'uv.exe' : 'uv');
  if (fs.existsSync(bundled)) return bundled;
  if (run('uv', ['--version'], { allowFailure: true }) !== null) return 'uv';
  throw new Error('uv was not found: run "npm run fetch-uv" (Windows) or install uv, then run again');
}

function makeVenv() {
  const uv = findUv();
  const venv = path.join(TARGET, 'venv');
  const python = IS_WIN ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  if (!fs.existsSync(python)) {
    log(`creating ${path.relative(APP_DIR, venv)} (Python ${VENV_PYTHON_VERSION}, with ${uv === 'uv' ? 'uv from PATH' : path.relative(APP_DIR, uv)})`);
    run(uv, ['venv', venv, '--python', VENV_PYTHON_VERSION, '--no-project', '--no-config'], { inherit: true });
  }
  log('installing the engine requirements (requirements.txt)');
  run(uv, ['pip', 'install', '--python', python, '--no-config', '-r', path.join(TARGET, 'requirements.txt')], { inherit: true });
  log(`Python for the tests: ${python}`);
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node scripts/checkout-engine.mjs [--venv]\n'
      + 'Checks out the engine commit pinned in engine.lock.json into .engine-src/ (partial, sparse clone) for the tests.\n'
      + '  --venv   also create .engine-src/venv with the engine requirements (needs uv: npm run fetch-uv)');
    return;
  }
  for (const a of args) if (a !== '--venv') throw new Error(`unknown option ${a} (see --help)`);
  checkout(readLock());
  if (args.has('--venv')) makeVenv();
}

try {
  main();
} catch (err) {
  console.error(`[engine-checkout] ERROR: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
}
