'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createSettingsStore, DEFAULT_SETTINGS, PROTECTED_KEYS, deepMerge,
} = require('../../src/main/settings');
const { createJsonWriter, atomicWriteFile } = require('../../src/main/util');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** fs.promises-like wrapper that counts operations and can fail/delay renames. */
function instrumentedFs({ renameFailures = 0, failCode = 'EPERM', alwaysFail = false, renameDelayMs = 0 } = {}) {
  const stats = { opens: 0, renameAttempts: 0, renames: 0, inPlace: 0, active: 0, maxActive: 0 };
  let failuresLeft = renameFailures;
  const end = () => { stats.active -= 1; };
  return {
    stats,
    api: {
      mkdir: (...a) => fsp.mkdir(...a),
      open: async (p, flags) => {
        stats.opens += 1;
        stats.active += 1;
        stats.maxActive = Math.max(stats.maxActive, stats.active);
        return fsp.open(p, flags);
      },
      rename: async (a, b) => {
        stats.renameAttempts += 1;
        if (renameDelayMs) await sleep(renameDelayMs);
        if (alwaysFail || failuresLeft > 0) {
          failuresLeft -= 1;
          const err = new Error(`${failCode}: simulated`);
          err.code = failCode;
          throw err;
        }
        await fsp.rename(a, b);
        stats.renames += 1;
        end();
      },
      writeFile: async (p, data) => {
        stats.inPlace += 1;
        await fsp.writeFile(p, data);
        end();
      },
      unlink: (p) => fsp.unlink(p),
    },
  };
}

test('defaults when the file is missing; get() returns a deep copy; defaults are frozen', (t) => {
  const dir = tmpDir(t);
  const store = createSettingsStore(path.join(dir, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 10 });
  assert.equal(store.loadStatus, 'missing');
  const s = store.get();
  assert.deepEqual(s, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  s.pdf.options.ppi = 1;
  s.ui.lastDirs.images = 'X';
  assert.equal(store.get().pdf.options.ppi, 1440);
  assert.equal(store.get().ui.lastDirs.images, null);
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  assert.ok(Object.isFrozen(DEFAULT_SETTINGS.pdf.options));
  assert.deepEqual([...PROTECTED_KEYS].sort(), ['pythonPath', 'upscayl.binPath', 'upscayl.customModelsDir', 'upscayl.modelsDir', 'venvDir', 'workspaceDir']);
});

test('deep merge: objects merge, arrays/primitives replace, null sets null, undefined is ignored', async (t) => {
  const dir = tmpDir(t);
  const store = createSettingsStore(path.join(dir, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 10 });
  const after = store.update({ pdf: { options: { ppi: 600 } } });
  assert.equal(after.pdf.options.ppi, 600);
  assert.equal(after.pdf.options.paper_size, 'a4');
  assert.equal(after.pdf.memoryBudgetPercent, 50);

  store.update({ pdf: { skipByLayout: { 'a4|standard|default': [0, 1, 2] } } });
  store.update({ pdf: { skipByLayout: { 'a4|standard|default': [5] } } });
  assert.deepEqual(store.get().pdf.skipByLayout, { 'a4|standard|default': [5] });

  store.update({ outputDir: 'D:\\Out', pdf: { options: { label: 'x' } } });
  store.update({ outputDir: null, pdf: { options: { label: null, crop: undefined } } });
  const s = store.get();
  assert.equal(s.outputDir, null);
  assert.equal(s.pdf.options.label, null);
  assert.equal(s.pdf.options.crop, null);

  // the patch object is not aliased into the state
  const patch = { fetch: { lastFetched: { plugin: 'mtg', added: 3 } } };
  store.update(patch);
  patch.fetch.lastFetched.added = 99;
  assert.equal(store.get().fetch.lastFetched.added, 3);
  await store.flush();
});

test('deepMerge() never mutates inputs, shares nothing and skips prototype-pollution keys', () => {
  const a = { x: { y: [1, 2], z: 1 }, keep: true };
  const b = JSON.parse('{"x":{"y":[3]},"__proto__":{"polluted":true},"constructor":{"prototype":{"bad":1}}}');
  const out = deepMerge(a, b);
  assert.deepEqual(out, { x: { y: [3], z: 1 }, keep: true });
  assert.deepEqual(a, { x: { y: [1, 2], z: 1 }, keep: true });
  out.x.z = 5;
  assert.equal(a.x.z, 1);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(out), Object.prototype);
  assert.equal(out.polluted, undefined);
});

test('protected keys are rejected unless internal', (t) => {
  const dir = tmpDir(t);
  const store = createSettingsStore(path.join(dir, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 10 });
  for (const patch of [
    { workspaceDir: 'C:\\evil' },
    { venvDir: 'C:\\evil' },
    { pythonPath: 'C:\\evil\\python.exe' },
    { upscayl: { binPath: 'C:\\evil.exe' } },
    { upscayl: { modelsDir: 'C:\\m' } },
    { upscayl: { customModelsDir: 'C:\\m' } },
  ]) {
    assert.throws(() => store.update(patch), (err) => err.code === 'PROTECTED_SETTING' && Array.isArray(err.keys));
  }
  // mixed patch: nothing is applied
  assert.throws(() => store.update({ theme: 'dark', workspaceDir: 'C:\\x' }), { code: 'PROTECTED_SETTING' });
  assert.equal(store.get().theme, 'system');
  // unchanged protected values are fine (e.g. a full settings object sent back)
  assert.doesNotThrow(() => store.update({ workspaceDir: null, upscayl: { binPath: null, enabled: false } }));
  assert.equal(store.get().upscayl.enabled, false);
  // internal updates may change them
  store.update({ workspaceDir: 'D:\\Cards', upscayl: { binPath: 'D:\\Tools\\upscayl-bin.exe' } }, { internal: true });
  assert.equal(store.get().workspaceDir, 'D:\\Cards');
  assert.equal(store.get().upscayl.binPath, 'D:\\Tools\\upscayl-bin.exe');
  assert.throws(() => store.update({ workspaceDir: null }), { code: 'PROTECTED_SETTING' });
});

test('object settings must stay objects; version cannot be changed', (t) => {
  const dir = tmpDir(t);
  const store = createSettingsStore(path.join(dir, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 10 });
  assert.throws(() => store.update({ ui: null }), { code: 'INVALID_SETTING' });
  assert.throws(() => store.update({ pdf: { options: 5 } }), { code: 'INVALID_SETTING' });
  assert.throws(() => store.update({ pdf: { presets: [] } }), { code: 'INVALID_SETTING' });
  assert.throws(() => store.update('theme'), TypeError);
  assert.throws(() => store.update([{ theme: 'dark' }]), TypeError);
  assert.equal(store.get().ui.thumbSize, 150);
  store.update({ version: 99, theme: 'dark' });
  assert.equal(store.get().version, 2);
  assert.equal(store.get().theme, 'dark');
});

test('onChange fires once per effective change, with changed keys; unsubscribe works', (t) => {
  const dir = tmpDir(t);
  const store = createSettingsStore(path.join(dir, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 10, onError: () => {} });
  const calls = [];
  const off = store.onChange((s, meta) => calls.push({ theme: s.theme, meta }));
  store.onChange(() => { throw new Error('listener bug'); }); // must not break updates
  store.update({ theme: 'dark' });
  store.update({ theme: 'dark' }); // no-op
  store.update({ ui: { thumbSize: 200 } });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].theme, 'dark');
  assert.deepEqual(calls[0].meta.changedKeys, ['theme']);
  assert.equal(calls[0].meta.internal, false);
  assert.deepEqual(calls[1].meta.changedKeys, ['ui']);
  off();
  store.update({ theme: 'light' });
  assert.equal(calls.length, 2);
});

test('writes are debounced and coalesced; flush() writes immediately', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const fake = instrumentedFs();
  const writer = createJsonWriter(file, { debounceMs: 60, fs: fake.api });
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { writer });
  store.update({ theme: 'dark' });
  store.update({ ui: { thumbSize: 180 } });
  store.update({ ui: { thumbSize: 190 } });
  await sleep(15);
  assert.equal(fs.existsSync(file), false, 'nothing written before the debounce delay');
  await sleep(200);
  assert.equal(fake.stats.opens, 1, 'three quick updates → one write');
  assert.equal(readJsonFile(file).ui.thumbSize, 190);

  store.update({ theme: 'light' });
  await store.flush();
  assert.equal(readJsonFile(file).theme, 'light');
  assert.equal(fake.stats.opens, 2);
  const leftovers = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('a constant stream of updates still lands on disk (max wait)', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = createSettingsStore(file, DEFAULT_SETTINGS, {
    writer: createJsonWriter(file, { debounceMs: 50, maxWaitMs: 150 }),
  });
  const start = Date.now();
  let i = 0;
  while (Date.now() - start < 400) {
    store.update({ ui: { thumbSize: 100 + (i += 1) } });
    await sleep(20);
  }
  assert.ok(fs.existsSync(file), 'written while updates keep coming');
  await store.flush();
  assert.equal(readJsonFile(file).ui.thumbSize, 100 + i);
});

test('concurrent updates: one write in flight at a time and the latest state wins', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const fake = instrumentedFs({ renameDelayMs: 25 });
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { writer: createJsonWriter(file, { debounceMs: 0, fs: fake.api }) });
  for (let n = 1; n <= 60; n += 1) {
    store.update({ ui: { thumbSize: n } });
    if (n % 7 === 0) await sleep(10); // let some writes start while updates continue
  }
  await store.flush();
  assert.equal(fake.stats.maxActive, 1, 'never two writes at once');
  assert.ok(fake.stats.opens < 60, `writes were coalesced (${fake.stats.opens})`);
  assert.equal(readJsonFile(file).ui.thumbSize, 60);
  assert.equal(store.get().ui.thumbSize, 60);
});

test('Windows-style rename failures are retried, then written in place; update never throws', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');

  const flaky = instrumentedFs({ renameFailures: 3, failCode: 'EBUSY' });
  await atomicWriteFile(file, '{"a":1}\n', { fs: flaky.api, retryDelayMs: 1 });
  assert.equal(flaky.stats.renameAttempts, 4);
  assert.equal(flaky.stats.inPlace, 0);
  assert.deepEqual(readJsonFile(file), { a: 1 });

  const locked = instrumentedFs({ alwaysFail: true, failCode: 'EPERM' });
  await atomicWriteFile(file, '{"a":2}\n', { fs: locked.api, retryDelayMs: 1 });
  assert.equal(locked.stats.renameAttempts, 11, 'first try + 10 retries');
  assert.equal(locked.stats.inPlace, 1, 'last resort: write in place');
  assert.deepEqual(readJsonFile(file), { a: 2 });
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'temp file removed');

  const other = instrumentedFs({ alwaysFail: true, failCode: 'ENOENT' });
  await atomicWriteFile(file, '{"a":3}\n', { fs: other.api, retryDelayMs: 1 });
  assert.equal(other.stats.renameAttempts, 1, 'non-retryable errors are not retried');
  assert.deepEqual(readJsonFile(file), { a: 3 });

  // through the store: write errors are reported, never thrown
  const errors = [];
  const broken = {
    mkdir: async () => { const e = new Error('disk gone'); e.code = 'EIO'; throw e; },
  };
  const store = createSettingsStore(path.join(dir, 'other.json'), DEFAULT_SETTINGS, {
    writer: createJsonWriter(path.join(dir, 'other.json'), { debounceMs: 0, fs: broken, onError: (e) => errors.push(e) }),
  });
  assert.doesNotThrow(() => store.update({ theme: 'dark' }));
  await store.flush();
  assert.equal(store.get().theme, 'dark');
  assert.equal(errors.length, 1);
});

test('a corrupt file is renamed to .bak and defaults are used', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, '{ "theme": "dark", oops');
  const errors = [];
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10, onError: (e) => errors.push(e) });
  assert.equal(store.loadStatus, 'corrupt');
  assert.equal(store.backupPath, `${file}.bak`);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), '{ "theme": "dark", oops');
  assert.equal(fs.existsSync(file), false);
  assert.equal(store.get().theme, 'system');
  assert.equal(errors.length, 1);
  store.update({ theme: 'light' });
  await store.flush();
  assert.equal(readJsonFile(file).theme, 'light');

  for (const bad of ['', '[1,2]', '"text"', 'null']) {
    fs.writeFileSync(file, bad);
    const s = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10, onError: () => {} });
    assert.equal(s.loadStatus, 'corrupt', `content ${JSON.stringify(bad)}`);
    assert.equal(s.get().theme, 'system');
  }
});

test('loading: BOM tolerated, values kept, broken object settings repaired, old version migrated', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, `\ufeff${JSON.stringify({
    version: 1,
    theme: 'dark',
    ui: 'broken',
    pdf: { options: null, memoryBudgetPercent: 70 },
    custom: { kept: true },
  })}`);
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10, onError: () => {} });
  assert.equal(store.loadStatus, 'ok');
  const s = store.get();
  assert.equal(s.version, 2);
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.ui, JSON.parse(JSON.stringify(DEFAULT_SETTINGS.ui)));
  assert.equal(s.pdf.options.ppi, 1440);
  assert.equal(s.pdf.memoryBudgetPercent, 70);
  assert.deepEqual(s.custom, { kept: true });
  await store.flush();
  assert.equal(readJsonFile(file).version, 2, 'migrated file written');
});

test('reset() restores defaults (including protected keys) and notifies', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10 });
  store.update({ theme: 'dark' });
  store.update({ workspaceDir: 'D:\\W' }, { internal: true });
  let meta = null;
  store.onChange((_s, m) => { meta = m; });
  const s = store.reset();
  assert.equal(s.theme, 'system');
  assert.equal(s.workspaceDir, null);
  assert.equal(meta.reset, true);
  assert.ok(meta.changedKeys.includes('workspaceDir'));
  await store.flush();
  assert.equal(readJsonFile(file).theme, 'system');
});

test('flushSync() writes synchronously', (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const store = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10000 });
  store.update({ theme: 'dark' });
  assert.equal(fs.existsSync(file), false);
  store.flushSync();
  assert.equal(readJsonFile(file).theme, 'dark');
});

test('a persisted file is reloaded by a new store', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'settings.json');
  const a = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10 });
  a.update({ equipment: { machine: 'cameo5alpha', paper: 'letter' }, pdf: { presets: { mine: { ppi: 600 } } } });
  await a.flush();
  const b = createSettingsStore(file, DEFAULT_SETTINGS, { debounceMs: 10 });
  assert.deepEqual(b.get().equipment, { machine: 'cameo5alpha', paper: 'letter' });
  assert.deepEqual(b.get().pdf.presets, { mine: { ppi: 600 } });
});
