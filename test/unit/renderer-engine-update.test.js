'use strict';

// Renderer side of the card maker engine updates: the job kind 'engine' is known to the activity bar and the
// sidebar, and the Settings section describes every state of scm.engine.updateStatus(). The renderer modules
// are ES modules (loaded with dynamic import()); the sidebar routes live in js/main.js, which runs the app on
// import, so its JOB_ROUTE literal is read as text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { JOB_KINDS } = require('../../src/main/jobs');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer', 'js');
const load = (rel) => import(pathToFileURL(path.join(RENDERER, rel)).href);

const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);
const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const NEXT = '0123456789abcdef0123456789abcdef01234567';

function status(overrides = {}) {
  return {
    mode: 'managed',
    disabled: null,
    auto: true,
    phase: 'idle',
    engine: { origin: 'bundled', engineVersion: '3.0.0', commit: SHA, shortCommit: SHA.slice(0, 7), committedAt: '2026-10-01T10:00:00Z' },
    bundled: null,
    previous: null,
    canRollback: false,
    pending: null,
    lastCheck: { at: NOW - 60000, ok: true, remoteCommit: SHA, remoteCommittedAt: null, error: null, upToDate: true, rejection: null },
    nextCheckAt: null,
    jobId: null,
    ...overrides,
  };
}

test('every job kind has an activity label, an icon and a sidebar item', async () => {
  const { JOB_KIND_LABELS, JOB_KIND_ICONS } = await load('components/activity.js');
  const { iconMarkup } = await load('core/icons.js');
  const mainText = fs.readFileSync(path.join(RENDERER, 'main.js'), 'utf8');
  const literal = /const JOB_ROUTE = \{([^}]*)\}/.exec(mainText);
  assert.ok(literal, 'JOB_ROUTE literal present in js/main.js');
  const routes = Object.fromEntries([...literal[1].matchAll(/(\w+): '([\w-]+)'/g)].map((m) => [m[1], m[2]]));
  for (const kind of JOB_KINDS) {
    assert.ok(JOB_KIND_LABELS[kind], `label for ${kind}`);
    assert.ok(iconMarkup(JOB_KIND_ICONS[kind]), `icon for ${kind}`);
    assert.ok(routes[kind], `sidebar item for ${kind}`);
  }
  assert.equal(JOB_KIND_LABELS.engine, 'Card maker engine update');
  assert.equal(routes.engine, 'settings');
});

test('engineUpdateSummary: unknown status, up to date, never checked', async () => {
  const { engineUpdateSummary } = await load('views/settings.js');
  const unknown = engineUpdateSummary(null, { now: NOW });
  assert.equal(unknown.tone, 'pending');
  assert.equal(unknown.canCheck, false);

  const ok = engineUpdateSummary(status(), { now: NOW });
  assert.equal(ok.tone, 'ok');
  assert.equal(ok.title, 'Silhouette Card Maker 3.0.0');
  assert.equal(ok.message, 'You have the newest version.');
  assert.deepEqual(ok.rows.map((r) => r[0]), ['Version', 'Source', 'Last check']);
  assert.match(ok.rows[0][1], /^3\.0\.0 \(commit abcdef0, .+\)$/);
  assert.equal(ok.rows[1][1], 'Included with Kirigami');
  assert.equal(ok.canCheck, true);
  assert.equal(ok.canRollback, false);

  const downloaded = engineUpdateSummary(status({ engine: { ...status().engine, origin: 'downloaded' } }), { now: NOW });
  assert.equal(downloaded.rows[1][1], 'Downloaded by Kirigami');

  const never = engineUpdateSummary(status({ lastCheck: null }), { now: NOW });
  assert.equal(never.tone, 'info');
  assert.match(never.message, /every hour/);
  assert.equal(never.rows[2][1], 'Not yet');
  assert.match(engineUpdateSummary(status({ lastCheck: null, auto: false }), { now: NOW }).message, /Automatic updates are off/);
});

test('engineUpdateSummary: updates turned off, linked engine', async () => {
  const { engineUpdateSummary } = await load('views/settings.js');
  const linked = engineUpdateSummary(status({ mode: 'linked', disabled: 'linked', engine: { origin: 'linked', engineVersion: '3.0.0' } }), { now: NOW });
  assert.equal(linked.tone, 'info');
  assert.match(linked.message, /SCM_ENGINE_DIR/);
  assert.equal(linked.rows[1][1], 'A folder linked with SCM_ENGINE_DIR');
  assert.equal(linked.rows.length, 2, 'no "last check" when updates are off');
  assert.equal(linked.canCheck, false);
  const env = engineUpdateSummary(status({ disabled: 'env' }), { now: NOW });
  assert.match(env.message, /SCM_ENGINE_UPDATES=0/);
  assert.equal(env.canCheck, false);
});

test('engineUpdateSummary: checking, downloading, waiting for the current task, switching', async () => {
  const { engineUpdateSummary } = await load('views/settings.js');
  for (const phase of ['checking', 'downloading', 'activating']) {
    const s = engineUpdateSummary(status({ phase }), { now: NOW });
    assert.equal(s.tone, 'running', phase);
    assert.equal(s.canCheck, false, phase);
  }
  const waiting = engineUpdateSummary(status({ phase: 'waiting', pending: { kind: 'update', shortCommit: NEXT.slice(0, 7) } }), { now: NOW });
  assert.equal(waiting.tone, 'info');
  assert.match(waiting.message, /commit 0123456\) is ready.*as soon as the current task finishes/);
  assert.equal(waiting.canCheck, true);
  const goingBack = engineUpdateSummary(status({ phase: 'waiting', pending: { kind: 'rollback', shortCommit: SHA.slice(0, 7) } }), { now: NOW });
  assert.match(goingBack.message, /Going back to the previous version/);
  assert.equal(goingBack.canCheck, false);
});

test('engineUpdateSummary: failed check, rejected version, rolled back version', async () => {
  const { engineUpdateSummary } = await load('views/settings.js');
  const failed = engineUpdateSummary(status({ lastCheck: { at: NOW, ok: false, remoteCommit: null, error: { code: 'NETWORK', message: 'GitHub could not be reached.' }, upToDate: false, rejection: null } }), { now: NOW });
  assert.equal(failed.tone, 'warning');
  assert.equal(failed.message, 'The last check did not work: GitHub could not be reached.');
  assert.match(failed.rows[2][1], /\(did not work\)$/);

  const rejection = { reason: 'The test PDF could not be made.', code: 'SMOKE_FAILED', at: NOW };
  const rejected = engineUpdateSummary(status({ lastCheck: { at: NOW, ok: true, remoteCommit: NEXT, error: null, upToDate: false, rejection } }), { now: NOW });
  assert.equal(rejected.tone, 'warning');
  assert.equal(rejected.message, 'The newest version (commit 0123456) did not work, so Kirigami kept this one. The test PDF could not be made.');

  const rolledBack = engineUpdateSummary(status({ lastCheck: { at: NOW, ok: true, remoteCommit: NEXT, error: null, upToDate: false, rejection: { ...rejection, code: 'ROLLED_BACK' } } }), { now: NOW });
  assert.equal(rolledBack.tone, 'info');
  assert.match(rolledBack.message, /^You went back from the newest version \(commit 0123456\)/);
});

test('engineUpdateSummary: roll back to the bundled engine or to an earlier download', async () => {
  const { engineUpdateSummary } = await load('views/settings.js');
  const previous = { origin: 'bundled', commit: SHA, shortCommit: SHA.slice(0, 7), committedAt: '2026-10-01T10:00:00Z' };
  const engine = { origin: 'downloaded', engineVersion: '3.1.0', commit: NEXT, shortCommit: NEXT.slice(0, 7), committedAt: '2026-10-05T10:00:00Z' };
  const toBundled = engineUpdateSummary(status({ engine, previous, canRollback: true }), { now: NOW });
  assert.equal(toBundled.canRollback, true);
  assert.match(toBundled.rollbackTo, /^the version included with Kirigami \(commit abcdef0, .+\)$/);
  const toDownload = engineUpdateSummary(status({ engine, previous: { ...previous, origin: 'downloaded' }, canRollback: true }), { now: NOW });
  assert.match(toDownload.rollbackTo, /^the version you had before \(commit abcdef0/);
  assert.equal(engineUpdateSummary(status({ engine, previous, canRollback: false }), { now: NOW }).canRollback, false);
});
