'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const engineFiles = require('../../src/main/engine-files');
const engineState = require('../../src/main/engine-state');
const { createEngineUpdater, prepareEngine, STATE_FILE } = require('../../src/main/engine-updater');
const { JobManager } = require('../../src/main/jobs');
const { DEFAULT_SETTINGS } = require('../../src/main/settings');
const { createLocks } = require('../../src/main/locks');

const REPO = 'Alan-Cha/silhouette-card-maker';
const REF = 'refs/heads/main';
const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

// ---------------------------------------------------------------------------------------------
// Fixtures: three commits of a tiny engine, served by a fake GitHub
// ---------------------------------------------------------------------------------------------

const BASE_FILES = Object.freeze({
  'create_pdf.py': '@click.version_option("3.0.0")\nprint("create")\n',
  'offset_pdf.py': 'print("offset")\n',
  'utilities.py': 'print("utilities")\n',
  'requirements.txt': 'click==8.4.2\n',
  'LICENSE.md': 'MIT\n',
  'assets/layouts.json': '{"paper_sizes": {}}\n',
  'plugins/mtg/fetch.py': 'print("mtg")\n',
  'cutting_templates/a4/standard.studio3': 'studio template',
  'calibration/a4-calibration.pdf': '%PDF-1.4 calibration',
  'README.md': '# not shipped\n',
  'hugo/content/guide.md': 'not shipped either',
});

const COMMITS = Object.freeze({
  // the engine bundled with the app
  bundled: { sha: '1'.repeat(40), committedAt: '2026-10-01T10:00:00Z', message: 'Bundled engine', files: BASE_FILES },
  // upstream moved on: one module changed, one plugin added, one calibration sheet removed
  next: {
    sha: '2'.repeat(40),
    committedAt: '2026-10-05T10:00:00Z',
    message: 'Add Lorcana\n\nAnd fix the utilities.',
    files: (() => {
      const files = { ...BASE_FILES, 'utilities.py': 'print("utilities v2")\n', 'plugins/lorcana/fetch.py': 'print("lorcana")\n' };
      delete files['calibration/a4-calibration.pdf'];
      return files;
    })(),
  },
  // an old commit (upstream force-pushed back in time)
  older: { sha: '0'.repeat(40), committedAt: '2026-09-01T10:00:00Z', message: 'Old', files: { ...BASE_FILES, 'offset_pdf.py': 'print("old offset")\n' } },
});

const sourceOf = (c) => ({ repository: REPO, ref: REF, commit: c.sha, committedAt: c.committedAt });
const engineOnly = (files) => Object.entries(files).filter(([p]) => engineFiles.isEngineFile(p));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-engupd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function treeOf(files) {
  const entries = [];
  const dirs = new Set();
  for (const [p, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    entries.push({ path: p, mode: '100644', type: 'blob', sha: engineFiles.gitBlobSha1(data), size: data.length });
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  for (const d of dirs) entries.push({ path: d, mode: '040000', type: 'tree', sha: 'f'.repeat(40) });
  return entries;
}

/** Write an engine folder (engine files + manifest), like fetch-engine or the updater would. */
function writeEngine(dir, commit) {
  const files = [];
  for (const [p, content] of engineOnly(commit.files)) {
    const data = Buffer.from(content);
    fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
    fs.writeFileSync(path.join(dir, p), data);
    files.push({ path: p, size: data.length, sha1: engineFiles.sha1Hex(data), blob: engineFiles.gitBlobSha1(data) });
  }
  const manifest = engineFiles.buildManifest({ source: sourceOf(commit), engineVersion: '3.0.0', files });
  fs.writeFileSync(path.join(dir, engineFiles.MANIFEST_NAME), engineFiles.serializeManifest(manifest));
  return manifest;
}

function fakeRemote(head = COMMITS.next.sha) {
  const bySha = new Map(Object.values(COMMITS).map((c) => [c.sha, c]));
  const remote = {
    head,
    calls: [],
    fail: {}, // method -> error to throw
    async lsRemote(repo, ref) {
      remote.calls.push(['lsRemote', repo, ref]);
      if (remote.fail.lsRemote) throw remote.fail.lsRemote;
      return { commit: remote.head, ref };
    },
    async getCommit(repo, sha) {
      remote.calls.push(['getCommit', sha]);
      if (remote.fail.getCommit) throw remote.fail.getCommit;
      const c = bySha.get(sha);
      return { commit: sha, committedAt: c.committedAt, message: c.message };
    },
    async getTree(repo, sha) {
      remote.calls.push(['getTree', sha]);
      if (remote.fail.getTree) throw remote.fail.getTree;
      return { commit: sha, entries: treeOf(bySha.get(sha).files) };
    },
    async downloadFile(repo, sha, p, blob) {
      remote.calls.push(['download', p]);
      if (remote.fail.download && remote.fail.download(p)) throw Object.assign(new Error(`could not download ${p}`), { code: 'NETWORK' });
      const data = Buffer.from(bySha.get(sha).files[p]);
      assert.equal(engineFiles.gitBlobSha1(data), blob, `blob of ${p}`);
      return data;
    },
  };
  remote.downloads = () => remote.calls.filter((c) => c[0] === 'download').map((c) => c[1]).sort();
  return remote;
}

function fakeTimers() {
  const list = [];
  return {
    list,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false, fired: false };
      list.push(timer);
      return timer;
    },
    clearTimer: (timer) => {
      if (timer) timer.cancelled = true;
    },
    live: () => list.filter((x) => !x.cancelled && !x.fired),
    fire(timer) {
      timer.fired = true;
      timer.fn();
    },
  };
}

function fakeSettings(updates = {}) {
  let value = { updates: { appCheck: true, engineAuto: true, ...updates } };
  const listeners = new Set();
  const store = {
    get: () => JSON.parse(JSON.stringify(value)),
    update(patch) {
      value = { ...value, ...patch, updates: { ...value.updates, ...(patch.updates || {}) } };
      for (const cb of listeners) cb(store.get(), { changedKeys: Object.keys(patch) });
      return store.get();
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  return store;
}

/**
 * A managed app with the `bundled` commit as its bundled engine, a fake GitHub whose branch points at
 * `head`, the real JobManager and locks, and fake workspace / python-env / upscayl modules.
 */
function makeApp(t, { head, envReady = true, refresh = null, workspaceFail = null, settings = fakeSettings(), env = {}, isTest = false, linked = false, state = null, remote = fakeRemote(head) } = {}) {
  const root = tmpDir(t);
  const bundledDir = path.join(root, 'resources', 'engine');
  writeEngine(bundledDir, COMMITS.bundled);
  const dataDir = path.join(root, 'data');
  const enginesDir = path.join(dataDir, 'engines');
  const scmCacheDir = path.join(dataDir, 'scm-cache');
  fs.mkdirSync(enginesDir, { recursive: true });
  if (state) fs.writeFileSync(path.join(enginesDir, STATE_FILE), JSON.stringify(state));
  const linkedDir = path.join(root, 'checkout');
  const calls = { workspace: [], workspaceLocked: [], refresh: [], envChecks: 0, envInvalidated: 0, cardDims: 0 };
  const events = [];
  const timers = fakeTimers();
  let clock = NOW;
  const deps = {
    getEngineDir: () => undefined,
    getPaths: () => ({
      engineMode: linked ? 'linked' : 'managed',
      engineSourceDir: linked ? linkedDir : deps.getEngineDir() || bundledDir,
      bundledEngineDir: bundledDir,
      enginesDir,
      scmCacheDir,
      calibrationCacheDir: path.join(scmCacheDir, 'calibration'),
      workspaceDir: path.join(root, 'workspace'),
    }),
    settings,
    jobs: new JobManager({ logsDir: null }),
    locks: createLocks(),
    helper: { invalidated: 0, invalidate() { deps.helper.invalidated += 1; } },
    emit: (channel, payload) => events.push({ channel, payload, pythonBusy: deps.locks.pythonBusy() }),
    logger: { info() {}, warn() {}, error() {} },
    isTest,
  };
  const modules = {
    workspace: {
      async ensureWorkspace(d, log) {
        const engineDir = d.getPaths().engineSourceDir;
        calls.workspace.push(engineDir);
        calls.workspaceLocked.push(d.locks.state().exclusive);
        log(`copied from ${engineDir}`);
        if (workspaceFail && calls.workspace.length === 1) throw workspaceFail;
        return { ok: true, updated: true };
      },
    },
    'python-env': {
      async checkEnv() {
        calls.envChecks += 1;
        return { ready: envReady };
      },
      async refreshForEngine(ctx, d, options = {}) {
        calls.refresh.push({ engineDir: d.getPaths().engineSourceDir, options });
        if (refresh) return refresh(options, calls.refresh.length, ctx);
        return { state: 'unchanged', python: '3.12.15', seconds: 1 };
      },
      invalidateEnvCache: () => { calls.envInvalidated += 1; },
    },
    upscayl: { invalidateCardDims: () => { calls.cardDims += 1; } },
  };
  const updater = createEngineUpdater(deps, {
    env,
    now: () => clock,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    createRemote: () => remote,
    modules,
    idleGraceMs: 0,
  });
  const readState = () => JSON.parse(fs.readFileSync(path.join(enginesDir, STATE_FILE), 'utf8'));
  const changes = () => events.filter((e) => e.channel === 'engine:changed' && e.payload.change).map((e) => e.payload.change);
  const notices = () => events.filter((e) => e.channel === 'app:notice').map((e) => e.payload);
  return {
    root, bundledDir, dataDir, enginesDir, scmCacheDir, deps, updater, remote, timers, calls, events, settings, readState, changes, notices,
    advance: (ms) => { clock += ms; },
    now: () => clock,
  };
}

/** Run a check and wait for the activation job it starts (if any). */
async function checkAndActivate(app, options = { manual: false }) {
  const status = await app.updater.checkNow(options);
  if (status.jobId) await app.deps.jobs.whenFinished(status.jobId);
  await app.updater.idle();
  return status;
}

// ---------------------------------------------------------------------------------------------
// prepareEngine
// ---------------------------------------------------------------------------------------------

test('prepareEngine copies unchanged files from the engine in use and downloads only the changed ones', async (t) => {
  const root = tmpDir(t);
  const baseDir = path.join(root, 'base');
  const baseManifest = writeEngine(baseDir, COMMITS.bundled);
  const enginesDir = path.join(root, 'engines');
  const remote = fakeRemote();
  const lines = [];
  const result = await prepareEngine({ remote, source: sourceOf(COMMITS.next), enginesDir, base: { dir: baseDir, manifest: baseManifest }, log: (l) => lines.push(l) });

  assert.equal(result.dir, path.join(enginesDir, COMMITS.next.sha));
  assert.equal(result.reused, false);
  assert.deepEqual(remote.downloads(), ['plugins/lorcana/fetch.py', 'utilities.py']);
  assert.deepEqual(result.stats, { files: 9, copied: 7, downloaded: 2, downloadedBytes: result.stats.downloadedBytes, removed: 1 });
  assert.ok(result.stats.downloadedBytes > 0);
  // identical to what fetch-engine writes for that commit
  const expected = writeEngine(path.join(root, 'expected'), COMMITS.next);
  assert.equal(fs.readFileSync(path.join(result.dir, engineFiles.MANIFEST_NAME), 'utf8'), engineFiles.serializeManifest(expected));
  assert.equal((await engineFiles.verifyEngineDir(result.dir, expected, { deep: true })).ok, true);
  assert.ok(!fs.existsSync(path.join(result.dir, 'README.md')), 'non-engine files are not shipped');
  assert.deepEqual(fs.readdirSync(enginesDir), [COMMITS.next.sha], 'no staging folder left');
  assert.ok(lines.some((l) => /7 unchanged, 2 to download, 1 removed/.test(l)));

  // a second call reuses the complete folder without asking GitHub
  remote.calls.length = 0;
  const again = await prepareEngine({ remote, source: sourceOf(COMMITS.next), enginesDir, base: { dir: baseDir, manifest: baseManifest } });
  assert.equal(again.reused, true);
  assert.deepEqual(remote.calls, []);
});

test('prepareEngine downloads a base file that was modified on disk, and everything without a base', async (t) => {
  const root = tmpDir(t);
  const baseDir = path.join(root, 'base');
  const baseManifest = writeEngine(baseDir, COMMITS.bundled);
  fs.writeFileSync(path.join(baseDir, 'offset_pdf.py'), 'tampered\n');
  const remote = fakeRemote();
  const result = await prepareEngine({ remote, source: sourceOf(COMMITS.next), enginesDir: path.join(root, 'engines'), base: { dir: baseDir, manifest: baseManifest } });
  assert.deepEqual(remote.downloads(), ['offset_pdf.py', 'plugins/lorcana/fetch.py', 'utilities.py']);
  assert.equal(fs.readFileSync(path.join(result.dir, 'offset_pdf.py'), 'utf8'), BASE_FILES['offset_pdf.py']);

  const fresh = fakeRemote();
  const full = await prepareEngine({ remote: fresh, source: sourceOf(COMMITS.next), enginesDir: path.join(root, 'engines2') });
  assert.equal(full.stats.downloaded, 9);
  assert.equal(full.stats.copied, 0);
});

test('prepareEngine leaves nothing behind when a download fails, the commit is incomplete or it is cancelled', async (t) => {
  const root = tmpDir(t);
  const enginesDir = path.join(root, 'engines');
  const failing = fakeRemote();
  failing.fail.download = (p) => p === 'utilities.py';
  await assert.rejects(prepareEngine({ remote: failing, source: sourceOf(COMMITS.next), enginesDir }), { code: 'NETWORK' });
  assert.deepEqual(fs.readdirSync(enginesDir), []);

  const incomplete = fakeRemote();
  incomplete.getTree = async () => ({ entries: treeOf({ 'create_pdf.py': 'x', 'README.md': 'y' }) });
  await assert.rejects(prepareEngine({ remote: incomplete, source: sourceOf(COMMITS.next), enginesDir }), (err) => {
    assert.equal(err.code, 'ENGINE_INVALID');
    assert.match(err.details, /offset_pdf\.py/);
    return true;
  });
  assert.deepEqual(fs.readdirSync(enginesDir), []);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(prepareEngine({ remote: fakeRemote(), source: sourceOf(COMMITS.next), enginesDir, signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(fs.readdirSync(enginesDir), []);
});

// ---------------------------------------------------------------------------------------------
// Startup: which engine is used
// ---------------------------------------------------------------------------------------------

test('init uses the bundled engine when nothing newer was downloaded', async (t) => {
  const app = makeApp(t);
  const status = await app.updater.init();
  assert.equal(status.mode, 'managed');
  assert.equal(status.engine.origin, 'bundled');
  assert.equal(status.engine.commit, COMMITS.bundled.sha);
  assert.equal(status.engine.engineVersion, '3.0.0');
  assert.equal(app.deps.getEngineDir(), undefined, 'getPaths falls back to the bundled engine');
  assert.equal(status.canRollback, false);
});

test('init uses a newer downloaded engine, and falls back when its folder is damaged or older', async (t) => {
  const active = { commit: COMMITS.next.sha, committedAt: COMMITS.next.committedAt, subject: 'Add Lorcana' };
  const previous = { commit: COMMITS.bundled.sha, committedAt: COMMITS.bundled.committedAt, subject: null, origin: 'bundled' };
  const app = makeApp(t, { state: { format: 1, active, previous, rejected: {} } });
  writeEngine(path.join(app.enginesDir, COMMITS.next.sha), COMMITS.next);
  const status = await app.updater.init();
  assert.equal(status.engine.origin, 'downloaded');
  assert.equal(status.engine.subject, 'Add Lorcana');
  assert.equal(app.deps.getEngineDir(), path.join(app.enginesDir, COMMITS.next.sha));
  assert.equal(app.deps.getPaths().engineSourceDir, path.join(app.enginesDir, COMMITS.next.sha), 'every getPaths() call sees it');
  assert.equal(status.canRollback, true);
  assert.equal(status.previous.origin, 'bundled');

  const damaged = makeApp(t, { state: { format: 1, active, previous, rejected: {} } });
  writeEngine(path.join(damaged.enginesDir, COMMITS.next.sha), COMMITS.next);
  fs.rmSync(path.join(damaged.enginesDir, COMMITS.next.sha, 'utilities.py'));
  const fallback = await damaged.updater.init();
  assert.equal(fallback.engine.origin, 'bundled');
  assert.equal(damaged.readState().active, null, 'the damaged engine is forgotten');
  assert.equal(damaged.readState().previous, null, 'nothing to roll back to from the bundled engine itself');

  const older = makeApp(t, { state: { format: 1, active: { commit: COMMITS.older.sha, committedAt: COMMITS.older.committedAt }, rejected: {} } });
  writeEngine(path.join(older.enginesDir, COMMITS.older.sha), COMMITS.older);
  assert.equal((await older.updater.init()).engine.origin, 'bundled', 'a newer app bundles a newer engine');
  assert.equal(older.readState().active, null);
});

test('linked mode: the checkout is used as is and updates are off', async (t) => {
  const app = makeApp(t, { linked: true });
  const status = await app.updater.init();
  assert.equal(status.mode, 'linked');
  assert.equal(status.disabled, 'linked');
  assert.equal(status.engine.origin, 'linked');
  app.updater.start();
  assert.deepEqual(app.timers.live(), []);
  await assert.rejects(app.updater.checkNow(), { code: 'ENGINE_UPDATES_OFF' });
  await assert.rejects(app.updater.rollback(), { code: 'ENGINE_UPDATES_OFF' });
  assert.deepEqual(app.remote.calls, []);
});

// ---------------------------------------------------------------------------------------------
// Checking, preparing, activating
// ---------------------------------------------------------------------------------------------

test('a check a minute after startup finds, prepares and activates a newer engine', async (t) => {
  const app = makeApp(t);
  await app.updater.init();
  fs.mkdirSync(path.join(app.scmCacheDir, 'calibration', 'calibration'), { recursive: true });
  fs.writeFileSync(path.join(app.scmCacheDir, 'introspection.json'), '{}');
  app.updater.start();
  const [first] = app.timers.live();
  assert.equal(first.ms, engineState.FIRST_CHECK_DELAY_MS);
  assert.equal(app.updater.status().nextCheckAt, NOW + engineState.FIRST_CHECK_DELAY_MS);

  app.timers.fire(first);
  await app.updater.idle();
  const status = app.updater.status();
  assert.ok(status.jobId, 'the activation job started right away (the app is idle)');
  const job = app.deps.jobs.active();
  assert.equal(job.kind, 'engine');
  assert.equal(job.title, 'Updating the card maker engine');
  const summary = await app.deps.jobs.whenFinished(status.jobId);
  assert.equal(summary.status, 'succeeded', JSON.stringify(summary.error));

  const newDir = path.join(app.enginesDir, COMMITS.next.sha);
  assert.equal(app.deps.getEngineDir(), newDir);
  assert.deepEqual(app.calls.workspace, [newDir], 'the workspace copy is refreshed from the new engine');
  assert.deepEqual(app.calls.workspaceLocked, [true], 'no Python program runs while the files are replaced');
  assert.equal(app.calls.refresh.length, 1);
  assert.equal(app.calls.refresh[0].engineDir, newDir);
  assert.equal(app.calls.refresh[0].options.smokeTest, true);
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote', 'getCommit', 'getTree', 'download', 'download']);
  assert.deepEqual(app.remote.downloads(), ['plugins/lorcana/fetch.py', 'utilities.py']);
  // caches derived from the engine are gone
  assert.equal(app.deps.helper.invalidated, 1);
  assert.equal(app.calls.envInvalidated, 1);
  assert.equal(app.calls.cardDims, 1);
  assert.ok(!fs.existsSync(path.join(app.scmCacheDir, 'introspection.json')));
  assert.ok(!fs.existsSync(path.join(app.scmCacheDir, 'calibration', 'calibration')), 'utilities.py changed: generated sheets are made again');

  const saved = app.readState();
  assert.deepEqual(saved.active, { commit: COMMITS.next.sha, committedAt: COMMITS.next.committedAt, subject: 'Add Lorcana' });
  assert.deepEqual(saved.previous, { commit: COMMITS.bundled.sha, committedAt: COMMITS.bundled.committedAt, subject: null, origin: 'bundled' });
  assert.equal(saved.lastCheck.ok, true);
  assert.equal(saved.lastCheck.remoteCommit, COMMITS.next.sha);
  const [change] = app.changes();
  assert.equal(change.kind, 'updated');
  assert.equal(change.subject, 'Add Lorcana');
  assert.equal(change.from.commit, COMMITS.bundled.sha);
  assert.equal(change.to.commit, COMMITS.next.sha);
  const changed = app.events.find((e) => e.channel === 'engine:changed' && e.payload.change);
  assert.equal(changed.pythonBusy, false, 'told once the Python lock is free, so the window can refresh right away');
  assert.equal(changed.payload.status.phase, 'idle');
  assert.equal(changed.payload.status.engine.commit, COMMITS.next.sha);
  const after = app.updater.status();
  assert.equal(after.phase, 'idle');
  assert.equal(after.engine.origin, 'downloaded');
  assert.equal(after.canRollback, true);
  assert.equal(after.lastCheck.upToDate, true);
  assert.equal(app.timers.live().length, 1);
  assert.equal(app.timers.live()[0].ms, engineState.CHECK_INTERVAL_MS, 'next check in an hour');

  // the next check costs one ls-refs request and changes nothing
  app.remote.calls.length = 0;
  await checkAndActivate(app);
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote']);
  assert.equal(app.changes().length, 1);
});

test('the activation waits for the running job to finish and never interrupts it', async (t) => {
  const app = makeApp(t);
  await app.updater.init();
  app.updater.start();
  let release;
  const userJob = app.deps.jobs.start('pdf', { title: 'Making the PDF' }, () => new Promise((resolve) => { release = resolve; }));
  const status = await app.updater.checkNow({ manual: false });
  assert.equal(status.jobId, null);
  assert.equal(status.phase, 'waiting');
  assert.equal(status.pending.commit, COMMITS.next.sha);
  assert.equal(app.deps.jobs.active().jobId, userJob);
  assert.equal(app.deps.getEngineDir(), undefined, 'nothing switched while the PDF is made');

  release();
  await app.deps.jobs.whenFinished(userJob);
  const grace = app.timers.live().find((x) => x.ms === 0);
  assert.ok(grace, 'the updater tries again once the job finished');
  app.timers.fire(grace);
  const engineJob = app.deps.jobs.active();
  assert.equal(engineJob.kind, 'engine');
  await app.deps.jobs.whenFinished(engineJob.jobId);
  assert.equal(app.deps.getEngineDir(), path.join(app.enginesDir, COMMITS.next.sha));
});

test('components that are not working only get the new files', async (t) => {
  const app = makeApp(t, { envReady: false });
  await app.updater.init();
  await checkAndActivate(app);
  assert.equal(app.calls.refresh.length, 0, 'Setup installs the components later');
  assert.equal(app.deps.getEngineDir(), path.join(app.enginesDir, COMMITS.next.sha));
  assert.equal(app.changes()[0].kind, 'updated');
  const job = app.deps.jobs.history()[0];
  assert.equal(job.status, 'succeeded');
  assert.deepEqual(job.result.components, 'not-set-up');
});

test('a failed activation restores the previous engine and rejects the commit; "Check now" retries it', async (t) => {
  let failNext = true;
  const app = makeApp(t, {
    refresh: (options) => {
      if (options.force) return { state: 'installed' };
      if (failNext) {
        options.onInstall();
        throw Object.assign(new Error('The test PDF could not be made.'), { code: 'SMOKE_FAILED' });
      }
      return { state: 'installed' };
    },
  });
  await app.updater.init();
  await checkAndActivate(app);

  const job = app.deps.jobs.history()[0];
  assert.equal(job.kind, 'engine');
  assert.equal(job.status, 'failed');
  assert.match(job.error.message, /did not work, so the previous one was put back: The test PDF could not be made\./);
  assert.equal(app.deps.getEngineDir(), undefined, 'back on the bundled engine');
  const newDir = path.join(app.enginesDir, COMMITS.next.sha);
  assert.deepEqual(app.calls.workspace, [newDir, app.bundledDir], 'the previous files are copied back');
  assert.deepEqual(app.calls.refresh.map((c) => [c.engineDir, !!c.options.force, c.options.smokeTest]), [[newDir, false, true], [app.bundledDir, true, false]],
    'the previous requirements are installed again');
  const saved = app.readState();
  assert.equal(saved.active, null);
  assert.equal(saved.rejected[COMMITS.next.sha].code, 'SMOKE_FAILED');
  assert.match(saved.rejected[COMMITS.next.sha].reason, /test PDF/);
  const [notice] = app.notices();
  assert.equal(notice.variant, 'warning');
  assert.equal(notice.title, 'The card maker engine update was undone');
  assert.equal(app.changes().length, 0);
  assert.equal(app.updater.status().lastCheck.rejection.code, 'SMOKE_FAILED');

  // automatic checks leave a rejected commit alone (no API call)
  app.remote.calls.length = 0;
  await checkAndActivate(app);
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote']);

  // the user fixed something and asks again: the prepared folder is reused and it works now
  failNext = false;
  app.remote.calls.length = 0;
  await checkAndActivate(app, { manual: true });
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote', 'getCommit'], 'the downloaded folder was kept');
  assert.equal(app.deps.getEngineDir(), newDir);
  assert.equal(app.readState().rejected[COMMITS.next.sha], undefined);
});

test('a circumstantial failure is undone without rejecting the commit', async (t) => {
  const app = makeApp(t, { workspaceFail: Object.assign(new Error('Could not copy the card maker files: EBUSY'), { code: 'WORKSPACE_WRITE_FAILED' }) });
  await app.updater.init();
  await checkAndActivate(app);
  assert.equal(app.deps.jobs.history()[0].status, 'failed');
  assert.equal(app.deps.getEngineDir(), undefined);
  assert.deepEqual(app.readState().rejected, {});
  assert.match(app.notices()[0].message, /will try again later/);
  assert.equal(app.calls.refresh.length, 0, 'nothing was installed, nothing to put back');
});

test('rollback returns to the previous engine, rejects the commit it leaves and removes its folder', async (t) => {
  const app = makeApp(t);
  await app.updater.init();
  await checkAndActivate(app);
  const newDir = path.join(app.enginesDir, COMMITS.next.sha);
  assert.equal(app.deps.getEngineDir(), newDir);

  const status = await app.updater.rollback();
  assert.ok(status.jobId);
  assert.equal(app.deps.jobs.active().title, 'Rolling back the card maker engine');
  await app.deps.jobs.whenFinished(status.jobId);
  await app.updater.idle();
  assert.equal(app.deps.getEngineDir(), undefined);
  assert.equal(app.calls.workspace[app.calls.workspace.length - 1], app.bundledDir);
  const saved = app.readState();
  assert.equal(saved.active, null);
  assert.equal(saved.previous, null);
  assert.equal(saved.rejected[COMMITS.next.sha].code, engineState.ROLLED_BACK);
  assert.equal(app.changes()[1].kind, 'rolledBack');
  assert.ok(!fs.existsSync(newDir), 'the folder rolled back from is cleaned up');
  assert.equal(app.updater.status().canRollback, false);
  await assert.rejects(app.updater.rollback(), { code: 'NO_ROLLBACK' });

  // even "Check now" does not reinstall the version the user rolled back from
  app.remote.calls.length = 0;
  await checkAndActivate(app, { manual: true });
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote']);
  assert.equal(app.deps.getEngineDir(), undefined);
});

test('a commit that is not newer than the engine in use is never downloaded, and asked about once', async (t) => {
  const app = makeApp(t, { head: COMMITS.older.sha });
  await app.updater.init();
  await checkAndActivate(app);
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote', 'getCommit']);
  assert.equal(app.readState().lastCheck.remoteCommittedAt, COMMITS.older.committedAt);
  app.remote.calls.length = 0;
  await checkAndActivate(app);
  assert.deepEqual(app.remote.calls.map((c) => c[0]), ['lsRemote'], 'no API call the second time');
  assert.equal(app.deps.jobs.history().length, 0);
});

test('rate limiting: the next check waits until GitHub resets the limit, also after a restart', async (t) => {
  const resetAt = NOW + 40 * 60 * 1000;
  const remote = fakeRemote();
  remote.fail.getCommit = Object.assign(new Error('GitHub is limiting requests'), { code: 'RATE_LIMITED', resetAt });
  const app = makeApp(t, { remote });
  await app.updater.init();
  app.updater.start();
  await app.updater.checkNow({ manual: false });
  const status = app.updater.status();
  assert.equal(status.lastCheck.ok, false);
  assert.deepEqual(status.lastCheck.error, { code: 'RATE_LIMITED', message: 'GitHub is limiting requests', resetAt });
  assert.equal(status.lastCheck.remoteCommit, COMMITS.next.sha);
  const [next] = app.timers.live();
  assert.equal(next.ms, resetAt - NOW + engineState.RATE_LIMIT_MARGIN_MS);

  const restarted = createEngineUpdater(app.deps, { createRemote: () => remote, setTimer: app.timers.setTimer, clearTimer: app.timers.clearTimer, now: () => NOW + 60000, modules: {} });
  await restarted.init();
  next.cancelled = true;
  restarted.start();
  assert.equal(app.timers.live()[0].ms, resetAt - (NOW + 60000) + engineState.RATE_LIMIT_MARGIN_MS);
  restarted.stop();
});

test('network failures back off: 5, 10, 20 minutes…', async (t) => {
  const remote = fakeRemote();
  remote.fail.lsRemote = Object.assign(new Error('offline'), { code: 'NETWORK' });
  const app = makeApp(t, { remote });
  await app.updater.init();
  app.updater.start();
  const delays = [];
  for (let i = 0; i < 3; i++) {
    await app.updater.checkNow({ manual: false });
    delays.push(app.timers.live()[0].ms);
  }
  assert.deepEqual(delays, [5, 10, 20].map((m) => m * 60000));
  remote.fail.lsRemote = null;
  await checkAndActivate(app);
  assert.equal(app.timers.live()[0].ms, engineState.CHECK_INTERVAL_MS, 'back to hourly after a success');
});

test('updates off: tests and SCM_ENGINE_UPDATES=0 never check; the setting only stops automatic checks', async (t) => {
  for (const options of [{ isTest: true }, { env: { SCM_ENGINE_UPDATES: '0' } }]) {
    const app = makeApp(t, options);
    await app.updater.init();
    app.updater.start();
    assert.deepEqual(app.timers.live(), []);
    await assert.rejects(app.updater.checkNow(), { code: 'ENGINE_UPDATES_OFF' });
    assert.deepEqual(app.remote.calls, []);
  }

  const settings = fakeSettings({ engineAuto: false });
  const app = makeApp(t, { settings });
  await app.updater.init();
  app.updater.start();
  assert.deepEqual(app.timers.live(), [], 'no automatic check');
  assert.equal(app.updater.status().auto, false);
  settings.update({ updates: { engineAuto: true } });
  assert.equal(app.timers.live()[0].ms, engineState.FIRST_CHECK_DELAY_MS, 'turning it on schedules a check');
  settings.update({ updates: { engineAuto: false } });
  assert.deepEqual(app.timers.live(), []);
  await checkAndActivate(app, { manual: true });
  assert.equal(app.deps.getEngineDir(), path.join(app.enginesDir, COMMITS.next.sha), '"Check now" still updates');
});

test('turning automatic updates off drops an automatic update still waiting for the app to be idle', async (t) => {
  const settings = fakeSettings();
  const app = makeApp(t, { settings });
  await app.updater.init();
  app.updater.start();
  let release;
  const userJob = app.deps.jobs.start('pdf', {}, () => new Promise((resolve) => { release = resolve; }));
  await app.updater.checkNow({ manual: false });
  assert.equal(app.updater.status().phase, 'waiting');
  settings.update({ updates: { engineAuto: false } });
  assert.equal(app.updater.status().pending, null);
  release();
  await app.deps.jobs.whenFinished(userJob);
  for (const timer of app.timers.live()) app.timers.fire(timer);
  assert.equal(app.deps.jobs.active(), null);
  assert.equal(app.deps.getEngineDir(), undefined);
});

test('start removes engine folders nothing refers to and staging leftovers', async (t) => {
  const active = { commit: COMMITS.next.sha, committedAt: COMMITS.next.committedAt, subject: null };
  const app = makeApp(t, { state: { format: 1, active, previous: null, rejected: {} } });
  writeEngine(path.join(app.enginesDir, COMMITS.next.sha), COMMITS.next);
  writeEngine(path.join(app.enginesDir, COMMITS.older.sha), COMMITS.older);
  fs.mkdirSync(path.join(app.enginesDir, `${'9'.repeat(40)}.partial`));
  fs.writeFileSync(path.join(app.enginesDir, 'notes.txt'), 'keep me');
  await app.updater.init();
  app.updater.start();
  await app.updater.idle();
  assert.deepEqual(fs.readdirSync(app.enginesDir).sort(), [COMMITS.next.sha, 'notes.txt', STATE_FILE].sort());
});

test('quitting during the switch puts the previous engine back and keeps the new one for later', async (t) => {
  const app = makeApp(t, {
    refresh: (options, n, ctx) => {
      options.onInstall();
      return new Promise((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(Object.assign(new Error('Cancelled'), { name: 'CancelledError', code: 'CANCELLED' })));
      });
    },
  });
  await app.updater.init();
  const status = await app.updater.checkNow({ manual: false });
  while (app.calls.refresh.length === 0) await new Promise((resolve) => setImmediate(resolve));
  app.deps.jobs.cancel(status.jobId);
  const summary = await app.deps.jobs.whenFinished(status.jobId);
  await app.updater.idle();

  assert.equal(summary.status, 'cancelled');
  const newDir = path.join(app.enginesDir, COMMITS.next.sha);
  assert.equal(app.deps.getEngineDir(), undefined, 'back on the bundled engine');
  assert.deepEqual(app.calls.workspace, [newDir, app.bundledDir]);
  assert.equal(app.calls.refresh.length, 1, 'no reinstall while the app closes');
  const saved = app.readState();
  assert.equal(saved.active, null);
  assert.deepEqual(saved.rejected, {}, 'quitting says nothing about the engine');
  assert.deepEqual(app.notices(), []);
  assert.ok(fs.existsSync(newDir), 'the prepared engine stays for the next start');
});

test('a rollback asked during a task waits for it, and no check runs until it is done', async (t) => {
  const app = makeApp(t);
  await app.updater.init();
  app.updater.start();
  await checkAndActivate(app);
  let release;
  const userJob = app.deps.jobs.start('pdf', {}, () => new Promise((resolve) => { release = resolve; }));
  const status = await app.updater.rollback();
  assert.equal(status.phase, 'waiting');
  assert.equal(status.pending.kind, 'rollback');
  assert.equal(status.pending.origin, 'bundled');
  assert.equal(status.canRollback, false);
  app.remote.calls.length = 0;
  await app.updater.checkNow({ manual: true });
  assert.deepEqual(app.remote.calls, [], 'going back comes first');

  release();
  await app.deps.jobs.whenFinished(userJob);
  app.timers.fire(app.timers.live().find((x) => x.ms === 0));
  const job = app.deps.jobs.active();
  assert.equal(job.kind, 'engine');
  assert.equal(job.title, 'Rolling back the card maker engine');
  await app.deps.jobs.whenFinished(job.jobId);
  assert.equal(app.deps.getEngineDir(), undefined);
  assert.equal(app.changes().pop().kind, 'rolledBack');
});

test('automatic engine updates are on by default', () => {
  assert.equal(DEFAULT_SETTINGS.updates.engineAuto, true);
});

test('a cleanup queued during a download keeps the engine being prepared', async (t) => {
  const remote = fakeRemote();
  let unblock;
  const blocked = new Promise((resolve) => { unblock = resolve; });
  let downloading = false;
  const download = remote.downloadFile;
  remote.downloadFile = async (...args) => {
    downloading = true;
    await blocked;
    return download(...args);
  };
  const app = makeApp(t, { remote });
  await app.updater.init();
  const pending = app.updater.checkNow({ manual: false });
  while (!downloading) await new Promise((resolve) => setImmediate(resolve));
  app.updater.start(); // queues a cleanup behind the download
  unblock();
  const status = await pending;
  await app.deps.jobs.whenFinished(status.jobId);
  await app.updater.idle();
  assert.equal(app.deps.jobs.history()[0].status, 'succeeded');
  assert.equal(app.deps.getEngineDir(), path.join(app.enginesDir, COMMITS.next.sha));
  assert.ok(fs.existsSync(path.join(app.enginesDir, COMMITS.next.sha)));
});

test('stop cancels a check in progress and the timers', async (t) => {
  const remote = fakeRemote();
  let unblock;
  remote.lsRemote = (repo, ref) => new Promise((resolve) => { unblock = () => resolve({ commit: COMMITS.next.sha, ref }); });
  const app = makeApp(t, { remote });
  await app.updater.init();
  app.updater.start();
  const pending = app.updater.checkNow({ manual: false });
  await new Promise((resolve) => setImmediate(resolve));
  app.updater.stop();
  unblock();
  await pending;
  assert.deepEqual(app.timers.live(), []);
  assert.equal(app.deps.jobs.active(), null);
  assert.deepEqual(fs.readdirSync(app.enginesDir), []);
});
