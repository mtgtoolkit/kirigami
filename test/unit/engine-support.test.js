'use strict';

// test/support/engine.js decides which engine every test runs against; a wrong order would silently test
// another engine, so the order itself is tested here with temporary folders.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveTestEngine } = require('../support/engine');

function makeEngine(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'create_pdf.py'), 'print("create")');
  return dir;
}

test('resolveTestEngine: SCM_TEST_ENGINE_DIR, SCM_ENGINE_DIR, .engine-src, then build/engine', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-engine-support-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);

  const none = resolveTestEngine({}, repo);
  assert.equal(none.dir, null);
  assert.match(none.problem, /npm run engine:checkout/);

  const built = makeEngine(path.join(repo, 'build', 'engine'));
  assert.deepEqual(resolveTestEngine({}, repo), { dir: built, source: 'build/engine', problem: null });

  const checkout = makeEngine(path.join(repo, '.engine-src'));
  assert.deepEqual(resolveTestEngine({}, repo), { dir: checkout, source: '.engine-src', problem: null });

  const linked = makeEngine(path.join(root, 'linked'));
  assert.deepEqual(resolveTestEngine({ SCM_ENGINE_DIR: linked }, repo), { dir: linked, source: 'SCM_ENGINE_DIR', problem: null });

  const forTests = makeEngine(path.join(root, 'tests'));
  assert.deepEqual(resolveTestEngine({ SCM_TEST_ENGINE_DIR: forTests, SCM_ENGINE_DIR: linked }, repo), { dir: forTests, source: 'SCM_TEST_ENGINE_DIR', problem: null });

  // A variable that is set wins even when wrong: the mistake is reported, no other engine is used.
  const typo = resolveTestEngine({ SCM_TEST_ENGINE_DIR: path.join(root, 'typo') }, repo);
  assert.equal(typo.source, 'SCM_TEST_ENGINE_DIR');
  assert.match(typo.problem, /typo.*has no create_pdf\.py/);
  assert.equal(resolveTestEngine({ SCM_ENGINE_DIR: '   ' }, repo).source, '.engine-src', 'blank variables are ignored');
});
