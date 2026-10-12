'use strict';

/**
 * print.js unit tests: the Print & cut data (Silhouette Studio detection through a registry seam,
 * last PDF, cutting template of the current settings) and opening a template (copied to
 * <outputDir>/templates first; "not installed" in plain words when nothing can open it).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const print = require('../../src/main/print');
const { getPaths } = require('../../src/main/paths');
const { DEFAULT_SETTINGS, deepMerge } = require('../../src/main/settings');
const FIXTURE = require('../fixtures/introspection.json');

const APP_DIR = path.resolve(__dirname, '..', '..');

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-print-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });
  return dir;
}

function setup(t, { settings: patch = {}, studio = { found: true, path: 'C:\\Studio\\Silhouette Studio.exe', version: '5.0.523' }, introspect, openPath } = {}) {
  const root = mkTmp(t);
  const ws = path.join(root, 'ws');
  const engine = path.join(root, 'engine');
  const tplDir = path.join(engine, 'cutting_templates');
  fs.mkdirSync(tplDir, { recursive: true });
  fs.mkdirSync(path.join(ws, 'game', 'output'), { recursive: true });
  const intro = JSON.parse(JSON.stringify(FIXTURE));
  for (const layout of [...intro.layouts.combos, ...intro.layouts.specialty]) {
    if (layout.templateFile) {
      const file = path.join(tplDir, `${layout.template}.studio3`);
      fs.writeFileSync(file, `studio3 ${layout.template}`);
      layout.templateFile = file;
    }
  }
  let current = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), patch);
  const opened = [];
  const warnings = [];
  const deps = {
    getPaths: () => getPaths({
      isPackaged: false,
      appDir: APP_DIR,
      userData: path.join(root, 'userdata'),
      platform: process.platform,
      env: { SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: path.join(root, 'data') },
      settings: current,
    }),
    settings: { get: () => current, update: (p) => { current = deepMerge(current, p); return current; } },
    helper: { introspect: introspect || (async () => intro) },
    seams: { registry: { findSilhouetteStudio: async () => studio } },
    openPath: openPath || (async (p) => { opened.push(p); return ''; }),
    logger: { info() {}, warn: (...a) => warnings.push(a.join(' ')), error() {} },
  };
  return { root, ws, tplDir, deps, opened, warnings, intro };
}

test('printInfo: Silhouette Studio, last PDF (with existence) and the template of the current settings', async (t) => {
  const env = setup(t);
  const pdfFile = path.join(env.ws, 'game', 'output', 'deck.pdf');
  fs.writeFileSync(pdfFile, '%PDF-1.4 hello');
  env.deps.settings.update({ pdf: { lastPdf: { path: pdfFile, ppi: 1440, loadOffset: false, pages: 2, at: '2026-10-03T10:00:00.000Z', onlyFronts: true } } });
  const info = await print.printInfo(env.deps);
  assert.deepEqual(info.silhouetteStudio, { found: true, path: 'C:\\Studio\\Silhouette Studio.exe', version: '5.0.523' });
  assert.equal(info.lastPdf.path, pdfFile);
  assert.equal(info.lastPdf.exists, true);
  assert.equal(info.lastPdf.sizeBytes, fs.statSync(pdfFile).size);
  assert.equal(info.lastPdf.ppi, 1440);
  assert.deepEqual(info.template, { name: 'a4-standard-v5', file: path.join(env.tplDir, 'a4-standard-v5.studio3') });
  assert.equal(info.paperSize, 'a4');
  assert.equal(info.cardSize, 'standard');
  assert.equal(info.cardDims, '63 x 88 mm');
  assert.equal(info.registration, '4');
  assert.equal(info.onlyFronts, true);
  assert.equal(info.error, null);
  assert.doesNotThrow(() => structuredClone(info), 'serializable for IPC');
  // the last PDF was deleted / moved
  fs.rmSync(pdfFile);
  const later = await print.printInfo(env.deps);
  assert.equal(later.lastPdf.exists, false);
});

test('printInfo: aliases, borderless and specialty layouts; no template → file null', async (t) => {
  const env = setup(t, { settings: { pdf: { options: { paper_size: 'ANSI_A', card_size: 'euro_poker', borderless: true } } } });
  let info = await print.printInfo(env.deps);
  const expected = env.intro.layouts.combos.find((c) => c.key === 'letter|standard|borderless').template;
  assert.deepEqual(info.template, { name: expected, file: path.join(env.tplDir, `${expected}.studio3`) });
  assert.equal(info.paperSize, 'letter');
  assert.equal(info.borderless, true);
  env.deps.settings.update({ pdf: { options: { borderless: false, specialty: 'a4-commander' } } });
  info = await print.printInfo(env.deps);
  assert.deepEqual(info.template, { name: 'a4-commander-v1', file: null });
  assert.equal(info.specialty, 'a4-commander');
  assert.equal(info.lastPdf, null);
});

test('printInfo: still answers when the components or the registry are unavailable', async (t) => {
  const env = setup(t, {
    introspect: async () => { throw Object.assign(new Error("NOT_READY: the card maker components aren't ready yet."), { code: 'NOT_READY' }); },
    studio: { found: false, path: null, version: null },
  });
  env.deps.seams.registry = { findSilhouetteStudio: async () => { throw new Error('PowerShell missing'); } };
  const info = await print.printInfo(env.deps);
  assert.deepEqual(info.silhouetteStudio, { found: false, path: null, version: null });
  assert.deepEqual(info.template, { name: null, file: null });
  assert.match(info.error, /aren't ready yet/);
});

test('openTemplate: copies to <outputDir>/templates (overwriting) and opens the copy', async (t) => {
  const env = setup(t);
  const src = path.join(env.tplDir, 'a4-standard-v5.studio3');
  const res = await print.openTemplate(env.deps, src);
  const dest = path.join(env.ws, 'game', 'output', 'templates', 'a4-standard-v5.studio3');
  assert.deepEqual(res, { opened: true, copiedTo: dest, error: null });
  assert.deepEqual(env.opened, [dest], 'the copy is opened, never the original');
  fs.writeFileSync(dest, 'edited in Studio');
  await print.openTemplate(env.deps, src);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'studio3 a4-standard-v5', 'an older copy is replaced');
});

test('openTemplate: a copy locked by Silhouette Studio is opened as it is', async (t) => {
  const env = setup(t);
  const src = path.join(env.tplDir, 'a4-standard-v5.studio3');
  const dest = path.join(env.ws, 'game', 'output', 'templates', 'a4-standard-v5.studio3');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'open in Studio');
  fs.chmodSync(dest, 0o444); // stands in for a file another program keeps open
  t.after(() => { try { fs.chmodSync(dest, 0o666); } catch { /* ignore */ } });
  const res = await print.openTemplate(env.deps, src);
  if (process.platform === 'win32' || (process.getuid && process.getuid() !== 0)) {
    assert.deepEqual(res, { opened: true, copiedTo: dest, error: null });
    assert.equal(fs.readFileSync(dest, 'utf8'), 'open in Studio');
  }
});

test('openTemplate: no program to open .studio3 files → "Silhouette Studio doesn\'t seem to be installed"', async (t) => {
  const env = setup(t, { openPath: async () => 'There is no application associated with the given file name extension.' });
  const src = path.join(env.tplDir, 'a4-standard-v5.studio3');
  const res = await print.openTemplate(env.deps, src);
  assert.equal(res.opened, false);
  assert.equal(res.error, 'Silhouette Studio doesn\'t seem to be installed');
  assert.ok(res.copiedTo && fs.existsSync(res.copiedTo), 'the copy is still made (the user can open it later)');
  assert.ok(env.warnings.some((w) => /no application associated/.test(w)), 'the raw reason goes to the log');
});

test('openTemplate: missing or wrong files', async (t) => {
  const env = setup(t);
  const missing = await print.openTemplate(env.deps, path.join(env.tplDir, 'gone.studio3'));
  assert.equal(missing.opened, false);
  assert.match(missing.error, /missing/);
  await assert.rejects(print.openTemplate(env.deps, path.join(env.tplDir, 'x.pdf')), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(print.openTemplate(env.deps, 'relative.studio3'), { code: 'INVALID_ARGUMENT' });
  // the output folder can't be created (a file is in the way)
  const blocked = setup(t, { settings: {} });
  const out = path.join(blocked.root, 'out-file');
  fs.writeFileSync(out, 'x');
  blocked.deps.settings.update({ outputDir: out });
  const res = await print.openTemplate(blocked.deps, path.join(blocked.tplDir, 'a4-standard-v5.studio3'));
  assert.equal(res.opened, false);
  assert.equal(res.copiedTo, null);
  assert.match(res.error, /could not be copied/);
});
