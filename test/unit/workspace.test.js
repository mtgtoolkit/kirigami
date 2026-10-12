'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workspace = require('../../src/main/workspace');

function tmpDir(t, prefix = 'scm-ws-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A miniature engine source folder. */
function makeEngine(root) {
  write(path.join(root, 'create_pdf.py'), 'print("create")');
  write(path.join(root, 'utilities.py'), 'X = 1');
  write(path.join(root, 'offset_pdf.py'), 'print("offset")');
  write(path.join(root, 'requirements.txt'), 'click==8.4.2\n');
  write(path.join(root, 'LICENSE.md'), 'MIT');
  write(path.join(root, 'README.md'), 'not copied');
  write(path.join(root, 'pyproject.toml'), 'not copied');
  write(path.join(root, 'assets', 'layouts.json'), '{}');
  write(path.join(root, 'assets', 'arial.ttf'), 'font');
  write(path.join(root, 'assets', 'extra_layouts', 'README.md'), 'readme');
  write(path.join(root, 'assets', 'extra_layouts', 'dev-only.json'), '{}');
  write(path.join(root, 'plugins', 'mtg', 'fetch.py'), 'cli');
  write(path.join(root, 'plugins', 'mtg', 'deck_formats.py'), 'formats');
  write(path.join(root, 'plugins', 'mtg', '__pycache__', 'fetch.cpython-312.pyc'), 'pyc');
  write(path.join(root, 'plugins', 'mtg', 'stale.pyc'), 'pyc');
  write(path.join(root, 'calibration', 'a4-calibration.pdf'), 'pdf');
  write(path.join(root, 'cutting_templates', 'a4-standard-v5.studio3'), 'tpl');
  write(path.join(root, 'game', 'front', 'engine-card.png'), 'png');
  return root;
}

function makeDeps(t, { isDev = false, workspaceDir, engineDir, jobs = null, extra = {} } = {}) {
  const base = tmpDir(t, 'scm-data-');
  const dataDir = path.join(base, 'data');
  const engine = engineDir || makeEngine(path.join(base, 'resources', 'engine'));
  const settingsState = { workspaceDir: null, pythonPath: null, venvDir: null };
  const updates = [];
  const emitted = [];
  const deps = {
    app: { getVersion: () => '1.2.3', isPackaged: !isDev },
    settings: {
      get: () => ({ ...settingsState }),
      update: (patch, opts) => {
        updates.push({ patch, opts });
        Object.assign(settingsState, patch);
      },
    },
    jobs: jobs || { active: () => null },
    logger: { warn() {}, info() {}, error() {} },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    getPaths: () => {
      const ws = settingsState.workspaceDir || workspaceDir || path.join(dataDir, 'workspace');
      return {
        isDev,
        engineSourceDir: engine,
        dataDir,
        workspaceDir: ws,
        venvDir: path.join(dataDir, 'venv'),
        pythonPath: path.join(dataDir, 'venv', 'Scripts', 'python.exe'),
        appOwnedVenv: !isDev,
        uvPythonDir: path.join(dataDir, 'python'),
        uvCacheDir: path.join(dataDir, 'uv-cache'),
        binDir: path.join(dataDir, 'bin'),
        enginesDir: path.join(dataDir, 'engines'),
        scmCacheDir: path.join(dataDir, 'scm-cache'),
        outputDir: path.join(base, 'Documents', 'Kirigami'),
        stageRoot: path.join(ws, 'game', '.stage'),
        trashRoot: path.join(ws, 'game', '.trash'),
        upscaledRoot: path.join(ws, 'game', 'upscaled'),
        helperScript: path.join(base, 'helper.py'),
        bundledUv: path.join(base, 'uv.exe'),
      };
    },
    ...extra,
  };
  return { deps, base, dataDir, engine, updates, emitted, settingsState };
}

test('GAME_KINDS and CARD_KINDS', () => {
  assert.deepEqual([...workspace.GAME_KINDS], ['front', 'back', 'double_sided', 'decklist', 'output', 'upscaled']);
  assert.deepEqual([...workspace.CARD_KINDS], ['front', 'back', 'double_sided']);
  assert.ok(Object.isFrozen(workspace.GAME_KINDS));
});

test('listEngineFiles mirrors the packaging filter', async (t) => {
  const engine = makeEngine(path.join(tmpDir(t), 'engine'));
  const files = await workspace.listEngineFiles(engine);
  assert.deepEqual(files, [
    'LICENSE.md',
    'assets/arial.ttf',
    'assets/extra_layouts/README.md',
    'assets/layouts.json',
    'create_pdf.py',
    'offset_pdf.py',
    'plugins/mtg/deck_formats.py',
    'plugins/mtg/fetch.py',
    'requirements.txt',
    'utilities.py',
  ]);
});

test('engineManifestSha1 prefers .engine-manifest.json, else fingerprints the files', async (t) => {
  const engine = makeEngine(path.join(tmpDir(t), 'engine'));
  const computed = await workspace.engineManifestSha1(engine);
  assert.equal(computed.source, 'computed');
  assert.match(computed.sha1, /^[0-9a-f]{40}$/);
  assert.equal((await workspace.engineManifestSha1(engine)).sha1, computed.sha1, 'stable');
  write(path.join(engine, 'plugins', 'mtg', 'fetch.py'), 'changed content');
  assert.notEqual((await workspace.engineManifestSha1(engine)).sha1, computed.sha1, 'changes with the engine');
  write(path.join(engine, '.engine-manifest.json'), '{"files":[]}');
  const manifest = await workspace.engineManifestSha1(engine);
  assert.equal(manifest.source, 'manifest');
  assert.equal(manifest.sha1, require('node:crypto').createHash('sha1').update('{"files":[]}').digest('hex'));
});

test('classifyWorkspace covers dev, external, managed and invalid folders', async (t) => {
  const root = tmpDir(t);
  const engine = makeEngine(path.join(root, 'engine'));
  const dataDir = path.join(root, 'data');
  const p = (workspaceDir, isDev = false) => ({ workspaceDir, engineSourceDir: engine, isDev, dataDir });
  assert.equal((await workspace.classifyWorkspace(p(engine, true))).mode, 'dev');
  assert.equal((await workspace.classifyWorkspace(p(engine, false))).mode, 'external');

  const external = path.join(root, 'external');
  write(path.join(external, 'create_pdf.py'));
  assert.equal((await workspace.classifyWorkspace(p(external))).mode, 'external');

  const gitWithMarker = path.join(root, 'git');
  write(path.join(gitWithMarker, 'create_pdf.py'));
  write(path.join(gitWithMarker, workspace.ENGINE_MARKER), '{}');
  fs.mkdirSync(path.join(gitWithMarker, '.git'));
  assert.equal((await workspace.classifyWorkspace(p(gitWithMarker))).mode, 'external');

  const managed = path.join(root, 'managed');
  write(path.join(managed, 'create_pdf.py'));
  write(path.join(managed, workspace.ENGINE_MARKER), '{}');
  assert.equal((await workspace.classifyWorkspace(p(managed))).mode, 'managed');

  assert.equal((await workspace.classifyWorkspace(p(path.join(root, 'missing')))).mode, 'managed');
  const empty = path.join(root, 'empty');
  write(path.join(empty, 'desktop.ini'), 'junk');
  assert.equal((await workspace.classifyWorkspace(p(empty))).mode, 'managed');
  const onlyData = path.join(root, 'only-data');
  write(path.join(onlyData, 'game', 'front', 'a.png'));
  write(path.join(onlyData, 'data', 'offset_data.json'), '{}');
  assert.equal((await workspace.classifyWorkspace(p(onlyData))).mode, 'managed');
  const defaultWs = path.join(dataDir, 'workspace');
  write(path.join(defaultWs, 'leftover.txt'));
  assert.equal((await workspace.classifyWorkspace(p(defaultWs))).mode, 'managed', 'the default workspace is always managed');

  const unrelated = path.join(root, 'unrelated');
  write(path.join(unrelated, 'holiday.jpg'));
  const invalid = await workspace.classifyWorkspace(p(unrelated));
  assert.equal(invalid.mode, 'invalid');
  assert.match(invalid.error, /isn't empty/);
  const file = path.join(root, 'file.txt');
  write(file);
  assert.equal((await workspace.classifyWorkspace(p(file))).mode, 'invalid');
});

test('ensureWorkspace populates a managed workspace and never touches game/ or data/', async (t) => {
  const { deps, dataDir, engine } = makeDeps(t);
  const ws = path.join(dataDir, 'workspace');
  write(path.join(ws, 'game', 'front', 'my card.png'), 'mine');
  write(path.join(ws, 'data', 'offset_data.json'), '{"x_offset": 3}');
  const lines = [];
  const result = await workspace.ensureWorkspace(deps, (l) => lines.push(l));
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'managed');
  assert.equal(result.updated, true);
  assert.equal(result.external, false);
  assert.ok(lines.length > 0);
  for (const rel of await workspace.listEngineFiles(engine)) assert.ok(fs.existsSync(path.join(ws, rel)), rel);
  assert.ok(!fs.existsSync(path.join(ws, 'README.md')));
  assert.ok(!fs.existsSync(path.join(ws, 'calibration')));
  assert.ok(!fs.existsSync(path.join(ws, 'assets', 'extra_layouts', 'dev-only.json')));
  assert.ok(!fs.existsSync(path.join(ws, 'plugins', 'mtg', '__pycache__')));
  assert.ok(!fs.existsSync(path.join(ws, 'game', 'front', 'engine-card.png')), "the engine's game folder is not copied");
  for (const kind of workspace.GAME_KINDS) assert.ok(fs.statSync(path.join(ws, 'game', kind)).isDirectory(), kind);
  assert.equal(fs.readFileSync(path.join(ws, 'game', 'front', 'my card.png'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(ws, 'data', 'offset_data.json'), 'utf8'), '{"x_offset": 3}');
  const marker = JSON.parse(fs.readFileSync(path.join(ws, workspace.ENGINE_MARKER), 'utf8'));
  assert.equal(marker.manifestSha1, result.manifestSha1);
  assert.equal(marker.appVersion, '1.2.3');
  assert.ok(marker.at);

  const again = await workspace.ensureWorkspace(deps);
  assert.equal(again.updated, false, 'no copy when the marker is current');
});

test('ensureWorkspace refreshes engine files when the engine changes, keeping user extras', async (t) => {
  const { deps, dataDir, engine } = makeDeps(t);
  const ws = path.join(dataDir, 'workspace');
  await workspace.ensureWorkspace(deps);
  write(path.join(ws, 'old_script.py'), 'stale');
  write(path.join(ws, 'plugins', 'removed', 'fetch.py'), 'stale plugin');
  write(path.join(ws, 'assets', 'stale.json'), '{}');
  write(path.join(ws, 'assets', 'extra_layouts', 'mine.json'), '{"card_sizes": {}}');
  write(path.join(ws, 'game', 'back', 'back.png'), 'back');
  write(path.join(engine, 'create_pdf.py'), 'print("create v2")');
  write(path.join(engine, '.engine-manifest.json'), '{"v":2}');

  const result = await workspace.ensureWorkspace(deps);
  assert.equal(result.updated, true);
  assert.equal(fs.readFileSync(path.join(ws, 'create_pdf.py'), 'utf8'), 'print("create v2")');
  assert.ok(!fs.existsSync(path.join(ws, 'old_script.py')));
  assert.ok(!fs.existsSync(path.join(ws, 'plugins', 'removed')));
  assert.ok(!fs.existsSync(path.join(ws, 'assets', 'stale.json')));
  assert.equal(fs.readFileSync(path.join(ws, 'assets', 'extra_layouts', 'mine.json'), 'utf8'), '{"card_sizes": {}}');
  assert.equal(fs.readFileSync(path.join(ws, 'game', 'back', 'back.png'), 'utf8'), 'back');
});

test('an interrupted refresh (provisional marker) is retried', async (t) => {
  const { deps, dataDir } = makeDeps(t);
  const ws = path.join(dataDir, 'workspace');
  await workspace.ensureWorkspace(deps);
  const markerFile = path.join(ws, workspace.ENGINE_MARKER);
  write(markerFile, JSON.stringify({ manifestSha1: null, state: 'updating' }));
  fs.rmSync(path.join(ws, 'utilities.py'));
  assert.equal((await workspace.classifyWorkspace(deps.getPaths())).mode, 'managed');
  const result = await workspace.ensureWorkspace(deps);
  assert.equal(result.updated, true);
  assert.ok(fs.existsSync(path.join(ws, 'utilities.py')));
  assert.equal(JSON.parse(fs.readFileSync(markerFile, 'utf8')).state, undefined);
});

test('ensureWorkspace uses dev and external workspaces as-is', async (t) => {
  const root = tmpDir(t);
  const engine = makeEngine(path.join(root, 'engine'));
  const dev = makeDeps(t, { isDev: true, workspaceDir: engine, engineDir: engine });
  const devResult = await workspace.ensureWorkspace(dev.deps);
  assert.equal(devResult.mode, 'dev');
  assert.equal(devResult.updated, false);
  assert.ok(!fs.existsSync(path.join(engine, workspace.ENGINE_MARKER)), 'no marker written into the engine');
  assert.ok(fs.statSync(path.join(engine, 'game', 'upscaled')).isDirectory());

  const external = path.join(root, 'external');
  write(path.join(external, 'create_pdf.py'), 'custom');
  const ext = makeDeps(t, { workspaceDir: external, engineDir: engine });
  const extResult = await workspace.ensureWorkspace(ext.deps);
  assert.equal(extResult.mode, 'external');
  assert.equal(extResult.external, true);
  assert.equal(fs.readFileSync(path.join(external, 'create_pdf.py'), 'utf8'), 'custom');
  assert.ok(!fs.existsSync(path.join(external, 'utilities.py')), 'engine files are never written to external folders');
  assert.ok(!fs.existsSync(path.join(external, workspace.ENGINE_MARKER)));

  const brokenDev = path.join(root, 'broken-engine');
  fs.mkdirSync(brokenDev);
  const broken = makeDeps(t, { isDev: true, workspaceDir: brokenDev, engineDir: brokenDev });
  await assert.rejects(workspace.ensureWorkspace(broken.deps), (err) => err.code === 'ENGINE_NOT_FOUND' && /Card maker files not found at/.test(err.message));
});

test('ensureWorkspace rejects unrelated folders and a missing engine source', async (t) => {
  const root = tmpDir(t);
  const unrelated = path.join(root, 'photos');
  write(path.join(unrelated, 'a.jpg'));
  const { deps } = makeDeps(t, { workspaceDir: unrelated });
  await assert.rejects(workspace.ensureWorkspace(deps), { code: 'WORKSPACE_INVALID' });
  assert.ok(!fs.existsSync(path.join(unrelated, 'game')), 'nothing written');

  const noEngine = makeDeps(t, { engineDir: path.join(root, 'resources', 'no-engine') });
  await assert.rejects(workspace.ensureWorkspace(noEngine.deps), (err) => err.code === 'ENGINE_NOT_FOUND' && /Please reinstall Kirigami\.$/.test(err.message));
  // A development build without build/engine is told how to get it, not to reinstall.
  const devNoEngine = makeDeps(t, { isDev: true, engineDir: path.join(root, 'build', 'engine') });
  await assert.rejects(workspace.ensureWorkspace(devNoEngine.deps), (err) => err.code === 'ENGINE_NOT_FOUND' && /npm run fetch-engine/.test(err.message));
  assert.match((await workspace.inspectWorkspace(devNoEngine.deps)).error, /npm run fetch-engine/);
});

test('inspectWorkspace is read-only and reports readiness', async (t) => {
  const { deps, dataDir } = makeDeps(t);
  const ws = path.join(dataDir, 'workspace');
  const before = await workspace.inspectWorkspace(deps);
  assert.equal(before.ok, false);
  assert.equal(before.needsUpdate, true);
  assert.match(before.error, /not been set up/);
  assert.ok(!fs.existsSync(ws), 'inspect never writes');
  await workspace.ensureWorkspace(deps);
  const after = await workspace.inspectWorkspace(deps);
  assert.equal(after.ok, true);
  assert.equal(after.mode, 'managed');
  assert.equal(after.error, null);
});

test('concurrent ensureWorkspace calls are serialized', async (t) => {
  const { deps } = makeDeps(t);
  const results = await Promise.all([workspace.ensureWorkspace(deps), workspace.ensureWorkspace(deps), workspace.ensureWorkspace(deps)]);
  assert.equal(results.filter((r) => r.updated).length, 1);
});

test('setWorkspace refuses while a job runs and validates the folder', async (t) => {
  const busy = makeDeps(t, { jobs: { active: () => ({ jobId: 'j1', kind: 'pdf', title: 'Making PDF' }) } });
  await assert.rejects(workspace.setWorkspace(busy.deps, path.join(busy.base, 'x')), (err) => err.code === 'BUSY' && err.message === 'BUSY: wait until "Making PDF" finishes');

  const { deps, base, updates } = makeDeps(t);
  await assert.rejects(workspace.setWorkspace(deps, 'relative/folder'), { code: 'WORKSPACE_INVALID' });
  await assert.rejects(workspace.setWorkspace(deps, path.parse(base).root), { code: 'WORKSPACE_INVALID' });
  await assert.rejects(workspace.setWorkspace(deps, path.join(deps.getPaths().venvDir, 'inside')), { code: 'WORKSPACE_INVALID' });
  await assert.rejects(workspace.setWorkspace(deps, path.join(deps.getPaths().enginesDir, 'inside')), /used by the app itself/);
  const unrelated = path.join(base, 'photos');
  write(path.join(unrelated, 'a.jpg'));
  await assert.rejects(workspace.setWorkspace(deps, unrelated), { code: 'WORKSPACE_INVALID' });
  await assert.rejects(workspace.setWorkspace(deps, 42), TypeError);
  assert.equal(updates.length, 0, 'settings untouched on validation errors');
});

test('setWorkspace switches, clears caches, restarts watchers, emits events and returns the env status', async (t) => {
  let invalidated = 0;
  let restarted = 0;
  let envChecks = 0;
  const helper = {
    invalidate: () => {
      invalidated += 1;
    },
    run: async (sub) => {
      envChecks += 1;
      assert.equal(sub, 'env-check');
      return { ok: true, python: '3.12.3', pythonOk: true, executable: process.execPath, modules: {}, missing: [], mismatched: [] };
    },
  };
  const ctx = makeDeps(t, {
    extra: {
      helper,
      restartWatchers: async () => {
        restarted += 1;
      },
      seams: {
        upscayl: { getUpscaylStatus: async () => ({ found: false, models: [], gpus: null, error: null }) },
        registry: { findSilhouetteStudio: async () => ({ found: false, path: null, version: null }) },
      },
    },
  });
  const { deps, base, updates, emitted } = ctx;
  // pythonPath must exist for the env check: point the venv python at node itself.
  const realGetPaths = deps.getPaths;
  deps.getPaths = () => ({ ...realGetPaths(), pythonPath: process.execPath, appOwnedVenv: false });
  write(path.join(deps.getPaths().venvDir, 'pyvenv.cfg'), 'home = C:\\Python312\n');
  const cacheDir = deps.getPaths().scmCacheDir;
  write(path.join(cacheDir, 'introspection.json'), '{}');
  write(path.join(cacheDir, 'hashes.json'), '{}');

  const target = path.join(base, 'My Cards é');
  const status = await workspace.setWorkspace(deps, target);
  assert.deepEqual(updates[0], { patch: { workspaceDir: path.resolve(target) }, opts: { internal: true } });
  assert.ok(fs.existsSync(path.join(target, 'create_pdf.py')));
  assert.ok(fs.existsSync(path.join(target, workspace.ENGINE_MARKER)));
  assert.equal(invalidated, 1);
  assert.equal(restarted, 1);
  assert.ok(!fs.existsSync(path.join(cacheDir, 'introspection.json')));
  assert.ok(!fs.existsSync(path.join(cacheDir, 'hashes.json')));
  assert.deepEqual(emitted.map((e) => e.channel), ['settings:changed', 'cards:changed']);
  assert.equal(emitted[0].payload.workspaceDir, path.resolve(target));
  assert.equal(status.workspace.path, path.resolve(target));
  assert.equal(status.workspace.ok, true);
  assert.equal(status.ready, true);
  assert.equal(envChecks, 1);

  await workspace.setWorkspace(deps, null);
  assert.deepEqual(updates[1], { patch: { workspaceDir: null }, opts: { internal: true } });
});

test('setWorkspace restores the previous setting when the new workspace cannot be prepared', async (t) => {
  const root = tmpDir(t);
  const { deps, updates, settingsState } = makeDeps(t, { engineDir: path.join(root, 'resources', 'no-engine') });
  settingsState.workspaceDir = path.join(root, 'previous');
  await assert.rejects(workspace.setWorkspace(deps, path.join(root, 'new')), { code: 'ENGINE_NOT_FOUND' });
  assert.equal(settingsState.workspaceDir, path.join(root, 'previous'));
  assert.equal(updates.length, 2);
});

test('startupCleanup removes stage leftovers, old trash, old partials and stale temp files', async (t) => {
  const { deps } = makeDeps(t);
  await workspace.ensureWorkspace(deps);
  const paths = deps.getPaths();
  const now = Date.now();
  const day = 24 * 3600 * 1000;
  const old = (p, ageMs) => {
    const time = new Date(now - ageMs);
    fs.utimesSync(p, time, time);
  };
  write(path.join(paths.stageRoot, 'job1', 'c0', 'front', 'a.png'));
  const oldBatch = path.join(paths.trashRoot, '20990101-000000-remove-1');
  write(path.join(oldBatch, 'batch.json'), JSON.stringify({ reason: 'remove', at: new Date(now - 20 * day).toISOString(), items: [] }));
  const recentBatch = path.join(paths.trashRoot, '20000101-000000-remove-2');
  write(path.join(recentBatch, 'batch.json'), JSON.stringify({ reason: 'remove', at: new Date(now - 2 * day).toISOString(), items: [] }));
  const namedOld = path.join(paths.trashRoot, '20200101-120000-clear-3');
  write(path.join(namedOld, 'front', 'x.png'));
  const oldPartial = path.join(paths.outputDir, '.deck.partial-abc-1.pdf');
  write(oldPartial);
  old(oldPartial, 2 * day);
  const newPartial = path.join(paths.outputDir, '.deck.partial-def-1.pdf');
  write(newPartial);
  const oldPartialDir = path.join(paths.outputDir, '.deck.partial-abc-0');
  write(path.join(oldPartialDir, 'page1.png'));
  old(oldPartialDir, 3 * day);
  const finished = path.join(paths.outputDir, 'deck.pdf');
  write(finished);
  old(finished, 30 * day);
  const oldTmp = path.join(paths.scmCacheDir, 'tmp', 'helper-env-check-1.json');
  write(oldTmp);
  old(oldTmp, 2 * day);
  const newTmp = path.join(paths.scmCacheDir, 'tmp', 'helper-env-check-2.json');
  write(newTmp);
  write(path.join(paths.upscaledRoot, '.staging', 'job9', 'in.png'));
  write(path.join(paths.upscaledRoot, 'front', 'kept.png'));

  const summary = await workspace.startupCleanup(deps, { now });
  assert.deepEqual(summary, { skipped: false, stageRemoved: 1, trashPruned: 2, partialsRemoved: 2, tmpRemoved: 1, stagingRemoved: 1 });
  assert.ok(!fs.existsSync(paths.stageRoot));
  assert.ok(!fs.existsSync(oldBatch));
  assert.ok(!fs.existsSync(namedOld));
  assert.ok(fs.existsSync(recentBatch), 'batch.json "at" wins over the folder name');
  assert.ok(!fs.existsSync(oldPartial));
  assert.ok(!fs.existsSync(oldPartialDir));
  assert.ok(fs.existsSync(newPartial));
  assert.ok(fs.existsSync(finished));
  assert.ok(!fs.existsSync(oldTmp));
  assert.ok(fs.existsSync(newTmp));
  assert.ok(fs.existsSync(path.join(paths.upscaledRoot, 'front', 'kept.png')));
  assert.ok(fs.existsSync(path.join(paths.workspaceDir, 'game', 'front')));
});

test('startupCleanup does nothing while a job runs and tolerates missing folders', async (t) => {
  const busy = makeDeps(t, { jobs: { active: () => ({ jobId: 'j', title: 'x' }) } });
  await workspace.ensureWorkspace(busy.deps);
  const stage = path.join(busy.deps.getPaths().stageRoot, 'job', 'a.png');
  write(stage);
  const summary = await workspace.startupCleanup(busy.deps);
  assert.equal(summary.skipped, true);
  assert.ok(fs.existsSync(stage));

  const fresh = makeDeps(t);
  const result = await workspace.startupCleanup(fresh.deps);
  assert.deepEqual(result, { skipped: false, stageRemoved: 0, trashPruned: 0, partialsRemoved: 0, tmpRemoved: 0, stagingRemoved: 0 });
});
