'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const s = require('../../src/main/engine-state');

const REPO = 'Alan-Cha/silhouette-card-maker';
const REF = 'refs/heads/main';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const D = 'd'.repeat(40);
const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

const source = (commit, committedAt, repository = REPO) => ({ repository, ref: REF, commit, committedAt });
const engine = (origin, commit, committedAt, extra = {}) => ({
  dir: `X:\\engines\\${commit}`, origin, source: source(commit, committedAt), engineVersion: '3.0.0', manifest: null, subject: null, ...extra,
});

test('normalizeState: an unknown format or garbage gives an empty state', () => {
  for (const raw of [null, 42, 'x', [], {}, { format: 2, active: { commit: A } }]) {
    assert.deepEqual(s.normalizeState(raw), s.emptyState(), JSON.stringify(raw));
  }
});

test('normalizeState keeps valid fields and drops damaged ones', () => {
  const raw = {
    format: 1,
    active: { commit: A, committedAt: '2026-10-01T10:00:00Z', subject: '  Fix the A4 layout  ', extra: 'dropped' },
    previous: { commit: B, committedAt: '2026-09-01T10:00:00Z', origin: 'bundled' },
    rejected: {
      [C]: { reason: 'smoke test failed', code: 'SMOKE', at: NOW },
      'not-a-sha': { reason: 'x', at: NOW },
      [D]: { reason: 'no date' },
    },
    lastCheck: { at: NOW, ok: true, remoteCommit: A, remoteCommittedAt: 'garbage', error: { code: 'X' } },
  };
  assert.deepEqual(s.normalizeState(raw), {
    format: 1,
    active: { commit: A, committedAt: '2026-10-01T10:00:00Z', subject: 'Fix the A4 layout' },
    previous: { commit: B, committedAt: '2026-09-01T10:00:00Z', subject: null, origin: 'bundled' },
    rejected: { [C]: { reason: 'smoke test failed', code: 'SMOKE', at: NOW } },
    lastCheck: { at: NOW, ok: true, remoteCommit: A, remoteCommittedAt: null, error: null },
  });
  const damaged = s.normalizeState({ format: 1, active: { commit: 'ABC', committedAt: '2026-10-01T10:00:00Z' }, previous: { commit: B, committedAt: '2026-09-01T10:00:00Z', origin: 'elsewhere' }, lastCheck: { ok: true } });
  assert.equal(damaged.active, null);
  assert.equal(damaged.previous, null, 'previous needs a known origin');
  assert.equal(damaged.lastCheck, null, 'a check without a time is dropped');
  const failed = s.normalizeState({ format: 1, lastCheck: { at: NOW, ok: false, error: { code: 'RATE_LIMITED', message: 'limited', resetAt: NOW + 1000 } } });
  assert.deepEqual(failed.lastCheck.error, { code: 'RATE_LIMITED', message: 'limited', resetAt: NOW + 1000 });
  const noError = s.normalizeState({ format: 1, lastCheck: { at: NOW, ok: false } });
  assert.equal(noError.lastCheck.error.message, 'The check did not work.', 'a failed check always carries an error');
});

test('normalizeState keeps only the newest rejections; serializeState round-trips', () => {
  const rejected = {};
  for (let i = 0; i < s.MAX_REJECTED + 5; i++) rejected[i.toString(16).padStart(40, '0')] = { reason: `r${i}`, at: NOW + i };
  const state = s.normalizeState({ format: 1, rejected });
  const kept = Object.keys(state.rejected);
  assert.equal(kept.length, s.MAX_REJECTED);
  assert.ok(!kept.includes('0'.repeat(40)), 'the oldest ones are dropped');
  assert.ok(kept.includes((s.MAX_REJECTED + 4).toString(16).padStart(40, '0')));
  const text = s.serializeState(state);
  assert.ok(text.endsWith('}\n'));
  assert.deepEqual(s.normalizeState(JSON.parse(text)), state);
});

test('chooseActiveEngine: the newest of the bundled and the downloaded engine; ties go to the bundled one', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const newer = engine('downloaded', B, '2026-10-05T10:00:00Z');
  const older = engine('downloaded', C, '2026-09-01T10:00:00Z');
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: null }), bundled);
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: newer }), newer);
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: older }), bundled, 'a newer app bundles a newer engine');
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: engine('downloaded', A, '2026-10-01T10:00:00Z') }), bundled, 'same commit: the bundled copy');
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: engine('downloaded', D, '2026-10-01T10:00:00Z') }), bundled, 'same date: not strictly newer');
  const otherRepo = { ...newer, source: source(B, '2026-10-05T10:00:00Z', 'someone/fork') };
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: otherRepo }), bundled, 'another repository is never preferred');
  assert.equal(s.chooseActiveEngine({ bundled: null, downloaded: newer }), newer, 'no bundled engine (development without fetch-engine)');
  assert.equal(s.chooseActiveEngine({ bundled: { ...bundled, source: null }, downloaded: newer }), newer);
  assert.equal(s.chooseActiveEngine({ bundled: null, downloaded: null }), null);
});

test('chooseActiveEngine keeps a download the user rolled back to until an engine newer than the one they left', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const older = engine('downloaded', C, '2026-09-01T10:00:00Z');
  const left = { commit: B, committedAt: '2026-10-05T10:00:00Z' };
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: older, rolledBackFrom: left }), older, 'the bundled engine is older than the one left');
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: older, rolledBackFrom: { commit: A, committedAt: '2026-10-01T10:00:00Z' } }), older, 'rolled back from the bundled engine itself');
  const newerApp = engine('bundled', D, '2026-10-09T10:00:00Z');
  assert.equal(s.chooseActiveEngine({ bundled: newerApp, downloaded: older, rolledBackFrom: left }), newerApp, 'a newer app bundles an engine newer than the one left');
  const otherRepo = { ...older, source: source(C, '2026-09-01T10:00:00Z', 'someone/fork') };
  assert.equal(s.chooseActiveEngine({ bundled, downloaded: otherRepo, rolledBackFrom: left }), bundled, 'another repository is never preferred');
});

test('reconcileState forgets an active engine that lost and a previous one that is gone', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const active = { commit: B, committedAt: '2026-09-01T10:00:00Z', subject: 'old' };
  const base = { ...s.emptyState(), active, previous: { commit: C, committedAt: '2026-08-01T10:00:00Z', subject: null, origin: 'downloaded' } };

  const lost = s.reconcileState(base, { inUse: bundled, bundled, previousAvailable: true });
  assert.equal(lost.changed, true);
  assert.equal(lost.state.active, null);
  assert.deepEqual(lost.state.previous, base.previous, 'an available previous engine stays');

  const gone = s.reconcileState(base, { inUse: engine('downloaded', B, '2026-09-01T10:00:00Z'), bundled, previousAvailable: false });
  assert.equal(gone.state.previous, null);
  assert.deepEqual(gone.state.active, active);

  const bundledPrevious = { ...s.emptyState(), active, previous: { commit: D, committedAt: '2026-08-01T10:00:00Z', subject: null, origin: 'bundled' } };
  const replaced = s.reconcileState(bundledPrevious, { inUse: engine('downloaded', B, '2026-09-01T10:00:00Z'), bundled, previousAvailable: true });
  assert.equal(replaced.state.previous, null, 'the app now bundles another commit than the one recorded');

  const self = { ...s.emptyState(), previous: { commit: A, committedAt: '2026-10-01T10:00:00Z', subject: null, origin: 'bundled' } };
  assert.equal(s.reconcileState(self, { inUse: bundled, bundled, previousAvailable: true }).state.previous, null, 'never roll back to the engine in use');

  const steady = { ...s.emptyState(), active, previous: { commit: A, committedAt: '2026-10-01T10:00:00Z', subject: null, origin: 'bundled' } };
  const same = s.reconcileState(steady, { inUse: engine('downloaded', B, '2026-09-01T10:00:00Z'), bundled, previousAvailable: true });
  assert.equal(same.changed, false);
  assert.equal(same.state, steady, 'unchanged state is returned as is (no write)');
});

test('updatesDisabledReason: linked mode, tests, SCM_ENGINE_UPDATES=0', () => {
  assert.equal(s.updatesDisabledReason({ engineMode: 'managed' }), null);
  assert.equal(s.updatesDisabledReason({ engineMode: 'linked', isTest: true }), 'linked');
  assert.equal(s.updatesDisabledReason({ engineMode: 'managed', isTest: true, env: { SCM_ENGINE_UPDATES: '0' } }), 'test');
  for (const value of ['0', 'false', 'OFF', ' no ']) {
    assert.equal(s.updatesDisabledReason({ engineMode: 'managed', env: { SCM_ENGINE_UPDATES: value } }), 'env', value);
  }
  for (const value of ['1', 'true', '', undefined]) {
    assert.equal(s.updatesDisabledReason({ engineMode: 'managed', env: { SCM_ENGINE_UPDATES: value } }), null, String(value));
  }
});

test('planCheck: up to date, rejected (manual retries failures, never rollbacks), known not newer, new', () => {
  const inUse = engine('bundled', A, '2026-10-01T10:00:00Z');
  const empty = s.emptyState();
  assert.deepEqual(s.planCheck({ remoteCommit: A, inUse, state: empty }), { action: 'none', reason: 'up-to-date' });
  assert.deepEqual(s.planCheck({ remoteCommit: B, inUse, state: empty }), { action: 'prepare', reason: 'new' });
  assert.deepEqual(s.planCheck({ remoteCommit: B, inUse: null, state: empty }), { action: 'prepare', reason: 'new' });

  const failed = s.recordRejection(empty, B, { reason: 'smoke test failed', code: 'SMOKE_FAILED', at: NOW });
  assert.equal(s.planCheck({ remoteCommit: B, inUse, state: failed }).reason, 'rejected');
  assert.equal(s.planCheck({ remoteCommit: B, inUse, state: failed, manual: true }).action, 'prepare', '"Check now" tries a failed commit again');
  const rolledBack = s.recordRejection(empty, B, { reason: 'You rolled back', code: s.ROLLED_BACK, at: NOW });
  assert.equal(s.planCheck({ remoteCommit: B, inUse, state: rolledBack, manual: true }).reason, 'rejected');

  const older = s.recordCheck(empty, { at: NOW, ok: true, remoteCommit: B, remoteCommittedAt: '2026-09-01T10:00:00Z' });
  assert.deepEqual(s.planCheck({ remoteCommit: B, inUse, state: older }), { action: 'none', reason: 'not-newer' });
  assert.equal(s.planCheck({ remoteCommit: C, inUse, state: older }).action, 'prepare', 'another commit is looked at');
  const newer = s.recordCheck(empty, { at: NOW, ok: true, remoteCommit: B, remoteCommittedAt: '2026-10-09T10:00:00Z' });
  assert.equal(s.planCheck({ remoteCommit: B, inUse, state: newer }).action, 'prepare');

  // rolled back to a download older than the bundled engine: a commit has to beat the bundled engine
  const pinned = engine('downloaded', C, '2026-09-01T10:00:00Z');
  const between = s.recordCheck(empty, { at: NOW, ok: true, remoteCommit: B, remoteCommittedAt: '2026-09-15T10:00:00Z' });
  assert.deepEqual(s.planCheck({ remoteCommit: B, inUse: pinned, bundled: inUse, state: between }), { action: 'none', reason: 'not-newer' });
  assert.equal(s.updateBaseline({ inUse: pinned, bundled: inUse }), inUse.source);
  assert.equal(s.updateBaseline({ inUse, bundled: pinned }), inUse.source, 'otherwise the engine in use');
});

test('isTransientFailure: circumstances are retried, engine problems are rejected', () => {
  for (const code of ['CANCELLED', 'NETWORK', 'DISK_FULL', 'ACCESS_DENIED', 'WORKSPACE_WRITE_FAILED', 'TIMEOUT', 'PYTHON_SETUP',
    'BLOCKED', 'PYTHON_START_FAILED', 'NOT_INSTALLED', 'HELPER_MISSING', 'UV_MISSING', 'FILE_LOCKED', 'WORKSPACE_INVALID', 'WORKSPACE_NOT_WRITABLE', 'ENGINE_NOT_FOUND']) {
    assert.equal(s.isTransientFailure({ code }), true, code);
  }
  assert.equal(s.isTransientFailure(Object.assign(new Error('x'), { name: 'CancelledError' })), true);
  for (const code of ['SETUP_FAILED', 'MISSING_PACKAGES', 'SMOKE_FAILED', 'CUSTOM_PYTHON_MISSING_PACKAGES', undefined]) {
    assert.equal(s.isTransientFailure({ code }), false, String(code));
  }
  assert.equal(s.isTransientFailure(null), false);
});

test('recordActivation: the new engine becomes active, the old one the rollback target', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const first = engine('downloaded', B, '2026-10-05T10:00:00Z', { subject: 'Add Riftbound' });
  const second = engine('downloaded', C, '2026-10-09T10:00:00Z', { subject: 'Fix Lorcana' });
  const rejectedB = s.recordRejection(s.emptyState(), B, { reason: 'once failed', at: NOW });

  const one = s.recordActivation(rejectedB, { from: bundled, to: first });
  assert.deepEqual(one.active, { commit: B, committedAt: '2026-10-05T10:00:00Z', subject: 'Add Riftbound' });
  assert.deepEqual(one.previous, { commit: A, committedAt: '2026-10-01T10:00:00Z', subject: null, origin: 'bundled' });
  assert.deepEqual(one.rejected, {}, 'a commit that now works is no longer rejected');

  const two = s.recordActivation(one, { from: first, to: second });
  assert.equal(two.active.commit, C);
  assert.deepEqual(two.previous, { commit: B, committedAt: '2026-10-05T10:00:00Z', subject: 'Add Riftbound', origin: 'downloaded' });

  const back = s.recordActivation(two, { from: second, to: bundled });
  assert.equal(back.active, null, 'the bundled engine is the default, not recorded as active');
  assert.equal(back.previous.commit, C);

  assert.equal(s.recordActivation(one, { from: first, to: first }).previous, null);
  assert.equal(s.recordActivation(one, { from: engine('linked', D, '2026-10-01T10:00:00Z'), to: second }).previous, null);
});

test('recordRollback rejects the commit left behind and leaves nothing to roll back to', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const first = engine('downloaded', B, '2026-10-05T10:00:00Z');
  const second = engine('downloaded', C, '2026-10-09T10:00:00Z');
  const updated = s.recordActivation(s.recordActivation(s.emptyState(), { from: bundled, to: first }), { from: first, to: second });

  const toFirst = s.recordRollback(updated, { from: second, to: first, at: NOW });
  assert.equal(toFirst.active.commit, B);
  assert.equal(toFirst.previous, null);
  assert.deepEqual(toFirst.rejected[C], { reason: 'You rolled back from this version.', code: s.ROLLED_BACK, at: NOW });

  assert.deepEqual(toFirst.active.rolledBackFrom, { commit: C, committedAt: '2026-10-09T10:00:00Z' }, 'the engine left is remembered');
  assert.deepEqual(s.normalizeState(JSON.parse(s.serializeState(toFirst))).active, toFirst.active, 'and survives a restart');
  assert.equal(s.recordActivation(toFirst, { from: first, to: second }).active.rolledBackFrom, undefined, 'an update ends it');

  const toBundled = s.recordRollback(s.recordActivation(s.emptyState(), { from: bundled, to: first }), { from: first, to: bundled, at: NOW });
  assert.equal(toBundled.active, null);
  assert.equal(toBundled.rejected[B].code, s.ROLLED_BACK);
});

test('rollbackTarget: only an engine that is still there and is not the one in use', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const first = engine('downloaded', B, '2026-10-05T10:00:00Z');
  const state = s.recordActivation(s.emptyState(), { from: bundled, to: first });
  assert.deepEqual(s.rollbackTarget(state, { inUse: first, bundled }), state.previous);
  assert.equal(s.rollbackTarget(state, { inUse: bundled, bundled }), null, 'already back on it');
  assert.equal(s.rollbackTarget(state, { inUse: first, bundled: engine('bundled', D, '2026-10-02T10:00:00Z') }), null, 'the app bundles another commit now');
  assert.equal(s.rollbackTarget(s.emptyState(), { inUse: first, bundled }), null);
});

test('initialCheckDelay: a minute after startup, later while a rate limit lasts', () => {
  assert.equal(s.initialCheckDelay({ now: NOW, state: s.emptyState() }), s.FIRST_CHECK_DELAY_MS);
  const limited = (resetAt) => s.recordCheck(s.emptyState(), { at: NOW - 1000, ok: false, error: { code: 'RATE_LIMITED', message: 'x', resetAt } });
  assert.equal(s.initialCheckDelay({ now: NOW, state: limited(NOW + 20 * 60000) }), 20 * 60000 + s.RATE_LIMIT_MARGIN_MS);
  assert.equal(s.initialCheckDelay({ now: NOW, state: limited(NOW + 1000) }), s.FIRST_CHECK_DELAY_MS, 'never sooner than the usual first check');
  assert.equal(s.initialCheckDelay({ now: NOW, state: limited(NOW - 1000) }), s.FIRST_CHECK_DELAY_MS, 'a limit that already reset');
});

test('delayAfterCheck: hourly, until the rate limit resets, exponential backoff after failures', () => {
  assert.equal(s.delayAfterCheck({ now: NOW, ok: true }), s.CHECK_INTERVAL_MS);
  assert.equal(s.delayAfterCheck({ now: NOW, ok: false, error: { code: 'RATE_LIMITED', resetAt: NOW + 30 * 60000 }, failures: 1 }), 30 * 60000 + s.RATE_LIMIT_MARGIN_MS);
  assert.equal(s.delayAfterCheck({ now: NOW, ok: false, error: { code: 'RATE_LIMITED', resetAt: NOW - 5000 }, failures: 1 }), s.MIN_RETRY_MS);
  const backoff = [1, 2, 3, 4, 5, 6].map((failures) => s.delayAfterCheck({ now: NOW, ok: false, error: { code: 'NETWORK' }, failures }));
  assert.deepEqual(backoff, [5, 10, 20, 40, 60, 60].map((m) => m * 60000));
  assert.equal(s.delayAfterCheck({ now: NOW, ok: false, error: { code: 'RATE_LIMITED', resetAt: null }, failures: 2 }), 10 * 60000, 'a limit without a reset time backs off');
  assert.equal(s.delayAfterCheck({ now: NOW, ok: false, failures: 0 }), s.RETRY_BASE_MS);
  assert.equal(s.delayAfterCheck({ now: NOW, ok: false, failures: 1e9 }), s.CHECK_INTERVAL_MS);
});

test('enginesToKeep + planCleanup: unreferenced engine folders and stale staging folders go, nothing else', () => {
  const bundled = engine('bundled', A, '2026-10-01T10:00:00Z');
  const first = engine('downloaded', B, '2026-10-05T10:00:00Z');
  const second = engine('downloaded', C, '2026-10-09T10:00:00Z');
  const state = s.recordActivation(s.recordActivation(s.emptyState(), { from: bundled, to: first }), { from: first, to: second });
  const keep = s.enginesToKeep({ state, inUse: second, pending: engine('downloaded', D, '2026-10-10T10:00:00Z') });
  assert.deepEqual([...keep].sort(), [B, C, D]);
  const E = 'e'.repeat(40);
  const names = [A, B, C, D, E, `${E}.partial`, `${D}.partial`, `${A}.partial-123`, 'state.json', 'state.json.1.2.tmp', 'notes.txt', `${E}x`];
  assert.deepEqual(s.planCleanup(names, { keep, preparing: D }), [A, `${A}.partial-123`, E, `${E}.partial`].sort());
  assert.deepEqual(s.planCleanup(names, { keep, preparing: null }), [A, `${A}.partial-123`, `${D}.partial`, E, `${E}.partial`].sort());

  const found = s.recordCheck(s.emptyState(), { at: NOW, ok: true, remoteCommit: E });
  assert.ok(s.enginesToKeep({ state: found }).has(E), 'an update found by the last check survives a restart');
  const rejected = s.recordRejection(found, E, { reason: 'broken', at: NOW });
  assert.ok(!s.enginesToKeep({ state: rejected }).has(E));
});

test('calibrationAffected: root modules and assets matter, plugins and templates do not', () => {
  const files = [
    { path: 'generate_calibration.py', blob: A },
    { path: 'utilities.py', blob: A },
    { path: 'assets/layouts.json', blob: A },
    { path: 'plugins/mtg/fetch.py', blob: A },
    { path: 'cutting_templates/a4/x.studio3', blob: A },
  ];
  const change = (p) => files.map((f) => (f.path === p ? { ...f, blob: B } : f));
  assert.equal(s.calibrationAffected(files, files), false);
  assert.equal(s.calibrationAffected(files, change('plugins/mtg/fetch.py')), false);
  assert.equal(s.calibrationAffected(files, change('cutting_templates/a4/x.studio3')), false);
  assert.equal(s.calibrationAffected(files, change('utilities.py')), true);
  assert.equal(s.calibrationAffected(files, change('assets/layouts.json')), true);
  assert.equal(s.calibrationAffected(files, [...files, { path: 'size_convert.py', blob: C }]), true, 'a new module');
  assert.equal(s.calibrationAffected(null, files), true, 'unknown files: assume the worst');
});

test('shortCommit and commitSubject', () => {
  assert.equal(s.shortCommit(A), 'aaaaaaa');
  assert.equal(s.shortCommit(null), '');
  assert.equal(s.commitSubject('Fix the A4 layout\n\nLonger explanation'), 'Fix the A4 layout');
  assert.equal(s.commitSubject('  Windows line\r\nmore'), 'Windows line');
  assert.equal(s.commitSubject(''), null);
  assert.equal(s.commitSubject('x'.repeat(300)).length, 200);
});
