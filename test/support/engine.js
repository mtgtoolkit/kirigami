'use strict';

/**
 * Where the tests find the real Silhouette Card Maker engine and a Python to run it. The repository holds
 * no engine code, so every test, integration check and fixture generator resolves it here, in one place.
 *
 * ENGINE_DIR, first match:
 *   1. SCM_TEST_ENGINE_DIR   an engine folder for the tests only
 *   2. SCM_ENGINE_DIR        the engine the app is linked to (README "Development")
 *   3. <repo>/.engine-src    sparse checkout of the locked commit, with docs and test images: npm run engine:checkout
 *   4. <repo>/build/engine   only the files the app ships (no README, Hugo docs or test images): npm run fetch-engine
 * A variable that is set wins even when its folder is wrong, so a typo is reported instead of quietly
 * testing another engine.
 *
 * Tests ask `engineSkip(...relativePaths)`: false when the engine has those paths, else the reason to skip
 * (node:test's `skip` option and Playwright's test.skip() take it as is).
 *
 * TEST_PYTHON: SCM_TEST_PYTHON, else <ENGINE_DIR>/venv (`npm run engine:checkout -- --venv` creates it).
 */

const fs = require('node:fs');
const path = require('node:path');
const { venvPython } = require('../../src/main/paths');

const REPO_DIR = path.resolve(__dirname, '..', '..');
const CHECKOUT_HINT = 'run "npm run engine:checkout" (or set SCM_TEST_ENGINE_DIR)';

/**
 * Resolve the engine folder (exported for its own unit test).
 * @param {object} [env=process.env]
 * @param {string} [repoDir=REPO_DIR]
 * @returns {{dir:string|null, source:string|null, problem:string|null}}
 */
function resolveTestEngine(env = process.env, repoDir = REPO_DIR) {
  for (const name of ['SCM_TEST_ENGINE_DIR', 'SCM_ENGINE_DIR']) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (!value) continue;
    const dir = path.resolve(value);
    const ok = fs.existsSync(path.join(dir, 'create_pdf.py'));
    return { dir, source: name, problem: ok ? null : `${name}=${dir} has no create_pdf.py` };
  }
  for (const rel of ['.engine-src', path.join('build', 'engine')]) {
    const dir = path.join(repoDir, rel);
    if (fs.existsSync(path.join(dir, 'create_pdf.py'))) return { dir, source: rel.split(path.sep).join('/'), problem: null };
  }
  return { dir: null, source: null, problem: `no Silhouette Card Maker engine found: ${CHECKOUT_HINT}` };
}

const resolved = resolveTestEngine();
/** Absolute engine folder, or null when there is none. */
const ENGINE_DIR = resolved.problem ? null : resolved.dir;
/** Which rule found it ('SCM_TEST_ENGINE_DIR', 'SCM_ENGINE_DIR', '.engine-src', 'build/engine') or null. */
const ENGINE_SOURCE = resolved.source;

/**
 * false when the engine is present with every given relative path (default: create_pdf.py and plugins/),
 * else a skip reason naming what is missing and how to get it.
 * @param {...string} rels POSIX paths relative to the engine root
 * @returns {false|string}
 */
function engineSkip(...rels) {
  if (!ENGINE_DIR) return resolved.problem;
  const wanted = rels.length ? rels : ['create_pdf.py', 'plugins'];
  const missing = wanted.filter((rel) => !fs.existsSync(path.join(ENGINE_DIR, ...rel.split('/'))));
  if (!missing.length) return false;
  return `the engine at ${ENGINE_DIR} (${ENGINE_SOURCE}) has no ${missing.join(', ')}: ${CHECKOUT_HINT}`;
}

/**
 * Path inside the engine (throws when there is no engine: guard with engineSkip() first).
 * @param {...string} parts
 * @returns {string}
 */
function enginePath(...parts) {
  if (!ENGINE_DIR) throw new Error(resolved.problem);
  return path.join(ENGINE_DIR, ...parts);
}

const pythonFromEnv = typeof process.env.SCM_TEST_PYTHON === 'string' && process.env.SCM_TEST_PYTHON.trim();
/** Python with the engine's requirements installed: SCM_TEST_PYTHON, else <ENGINE_DIR>/venv; null without either. */
const TEST_PYTHON = pythonFromEnv ? path.resolve(pythonFromEnv) : ENGINE_DIR ? venvPython(path.join(ENGINE_DIR, 'venv')) : null;

/**
 * false when TEST_PYTHON exists, else a skip reason.
 * @returns {false|string}
 */
function pythonSkip() {
  if (TEST_PYTHON && fs.existsSync(TEST_PYTHON)) return false;
  if (pythonFromEnv) return `SCM_TEST_PYTHON=${TEST_PYTHON} does not exist`;
  return `no test Python: run "npm run engine:checkout -- --venv" or set SCM_TEST_PYTHON${TEST_PYTHON ? ` (looked for ${TEST_PYTHON})` : ''}`;
}

module.exports = {
  REPO_DIR,
  ENGINE_DIR,
  ENGINE_SOURCE,
  TEST_PYTHON,
  engineSkip,
  enginePath,
  pythonSkip,
  resolveTestEngine,
};
