#!/usr/bin/env node
'use strict';

/**
 * Integration checks for pdf.js + offset.js + print.js with the REAL modules (JobManager, locks,
 * helper, settings store, hash cache) and the REAL engine (create_pdf.py, offset_pdf.py,
 * generate_calibration.py) run by its Python — no Electron. The engine and the Python come from
 * test/support/engine.js (normally .engine-src and .engine-src/venv: npm run engine:checkout -- --venv).
 *
 * Safety: the engine code (root *.py, requirements.txt, assets/, plugins/, cutting_templates/,
 * calibration/) is COPIED into a temp folder that becomes the workspace AND the engine source
 * folder; settings/userData/data folders are temp folders too. The engine's game/, data/ and
 * venv are only read (never written). Test images come from <engine>/test/images.
 *
 * Usage (from the repository root):
 *   node test/integration/pdf.int.js [--only 1,2,5] [--keep] [--tmp <parent dir>] [--python <exe>]
 *                                    [--with-upscayl [--upscayl <upscayl-bin path>]] [--with-1440]
 * Checks:
 *   1 fronts only, 300 PPI, one PDF          2 forced chunking (tiny memory budget) + lossless merge
 *   3 fronts + backs (2 common backs, mode 'file') + a unique back
 *   4 back faces as extra cards (fronts only)  5 PNG pages instead of a PDF
 *   6 locked output: pre-flight refusal and "(2)" fallback while the final file is locked
 *   7 offset job on the PDF of check 3        8 generate the Legal calibration sheet
 *   9 shifted calibration sheet              10 print info + open template (no app is opened)
 *  11 (opt-in, --with-upscayl) upscale step inside the PDF job with the user's Upscayl (GPU)
 *  12 (opt-in, --with-1440) the first user's default settings at 1440 PPI (≈ 4 GB of memory)
 */

const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pdf = require('../../src/main/pdf');
const offset = require('../../src/main/offset');
const print = require('../../src/main/print');
const { getPaths } = require('../../src/main/paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');
const { createLocks } = require('../../src/main/locks');
const { createHelper } = require('../../src/main/helper');
const { createHashCache } = require('../../src/main/scan');
const { REPO_DIR: APP_DIR, ENGINE_DIR: ENGINE, TEST_PYTHON, engineSkip } = require('../support/engine');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const REPO_PYTHON = option('--python', TEST_PYTHON);
const TMP_PARENT = option('--tmp', os.tmpdir());
const ONLY = option('--only', '') ? new Set(option('--only', '').split(',').map((s) => s.trim()).filter(Boolean)) : null;
const VERBOSE = flag('--verbose') || !!process.env.SCM_INT_VERBOSE;
const TEST_IMAGES = ENGINE ? path.join(ENGINE, 'test', 'images') : null;

// ---------------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------------

const results = [];
let failures = 0;

async function check(id, name, fn) {
  if (ONLY && !ONLY.has(String(id))) return;
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ id, name, ok: true, ms, note });
    console.log(`PASS  ${id}. ${name} (${(ms / 1000).toFixed(1)} s)${note ? ` - ${note}` : ''}`);
  } catch (err) {
    failures += 1;
    const ms = Date.now() - started;
    results.push({ id, name, ok: false, ms, note: err && err.message });
    console.log(`FAIL  ${id}. ${name} (${(ms / 1000).toFixed(1)} s)\n      ${String((err && err.stack) || err).split('\n').slice(0, 8).join('\n      ')}`);
    if (err && err.details) console.log(`      details: ${String(err.details).split('\n').slice(-12).join('\n      ')}`);
  }
}

function copyTree(src, dest, filter = () => true) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      const s = path.join(src, name);
      if (!filter(s, name)) continue;
      copyTree(s, path.join(dest, name), filter);
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

const skipJunk = (abs, name) => name !== '__pycache__' && !name.endsWith('.pyc') && name !== 'dxf';

function makeWorkspace(ws) {
  fs.mkdirSync(ws, { recursive: true });
  for (const name of fs.readdirSync(ENGINE)) {
    if (/\.py$/i.test(name) || name === 'requirements.txt' || name === 'LICENSE.md') fs.copyFileSync(path.join(ENGINE, name), path.join(ws, name));
  }
  for (const dir of ['assets', 'plugins', 'cutting_templates', 'calibration']) copyTree(path.join(ENGINE, dir), path.join(ws, dir), skipJunk);
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output', 'upscaled']) fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
}

function testImages() {
  return fs.readdirSync(TEST_IMAGES).filter((n) => /\.(png|jpe?g|webp)$/i.test(n)).sort();
}

function clearKind(ws, kind) {
  const dir = path.join(ws, 'game', kind);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

/** Put the test images (optionally `copies` renamed duplicates) into game/front. */
function loadFronts(ws, { count = null, copies = 0 } = {}) {
  clearKind(ws, 'front');
  const names = testImages();
  const out = [];
  const list = count ? names.slice(0, count) : names;
  for (const name of list) {
    fs.copyFileSync(path.join(TEST_IMAGES, name), path.join(ws, 'game', 'front', name));
    out.push(name);
  }
  for (let i = 0; i < copies; i += 1) {
    const src = names[i % names.length];
    const ext = path.extname(src);
    const name = `copy ${i + 1} of ${path.basename(src, ext)}${ext}`;
    fs.copyFileSync(path.join(TEST_IMAGES, src), path.join(ws, 'game', 'front', name));
    out.push(name);
  }
  return out;
}

function lockFile(file, seconds = 60) {
  // PowerShell holds the file open with FileShare.None (no other program may open or replace it).
  const script = "$f=[System.IO.File]::Open($env:SCM_LOCK_PATH,'OpenOrCreate','ReadWrite','None');[Console]::Out.WriteLine('LOCKED');[Console]::Out.Flush();Start-Sleep -Seconds ([int]$env:SCM_LOCK_SECONDS);$f.Close()";
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = child_process.spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SCM_LOCK_PATH: file, SCM_LOCK_SECONDS: String(seconds) }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ready = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.includes('LOCKED')) resolve();
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`the file locker exited early (${code})`)));
  });
  return {
    ready,
    release: () => new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(); return; }
      child.once('exit', () => resolve());
      try {
        child_process.spawnSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      } catch { child.kill(); }
    }),
  };
}

function runPython(code, args = []) {
  const file = path.join(os.tmpdir(), `scm-pdf-int-${process.pid}-${Date.now()}.py`);
  fs.writeFileSync(file, code);
  try {
    const res = child_process.spawnSync(REPO_PYTHON, [file, ...args], { encoding: 'utf8', windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1' } });
    if (res.status !== 0) throw new Error(`python failed: ${res.stderr}`);
    return JSON.parse(res.stdout.trim().split(/\r?\n/).pop());
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** Mean brightness (0–255) of each page, rendered small with pypdfium2. */
function pageBrightness(pdfPath) {
  return runPython([
    'import json, sys',
    'import pypdfium2 as pdfium',
    'from PIL import ImageStat',
    'doc = pdfium.PdfDocument(sys.argv[1])',
    'out = []',
    'for i in range(len(doc)):',
    '    img = doc[i].render(scale=0.1).to_pil().convert("L")',
    '    out.append(round(ImageStat.Stat(img).mean[0], 1))',
    'print(json.dumps(out))',
  ].join('\n'), [pdfPath]);
}

// ---------------------------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------------------------

async function main() {
  const noEngine = engineSkip('create_pdf.py', 'plugins', 'cutting_templates', 'calibration', 'test/images');
  if (noEngine) {
    console.log(`SKIP  ${noEngine}`);
    process.exit(0);
  }
  if (!REPO_PYTHON || !fs.existsSync(REPO_PYTHON)) {
    console.log(`SKIP  Python not found at ${REPO_PYTHON} (use --python <exe> or SCM_TEST_PYTHON)`);
    process.exit(0);
  }
  fs.mkdirSync(TMP_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP_PARENT, 'scm-pdf-int-'));
  const ws = path.join(root, 'ws');
  const userData = path.join(root, 'userdata');
  const dataDir = path.join(root, 'data');
  console.log(`temp folder: ${root}`);
  const setupStarted = Date.now();
  makeWorkspace(ws);
  fs.mkdirSync(userData, { recursive: true });
  console.log(`workspace copied in ${((Date.now() - setupStarted) / 1000).toFixed(1)} s`);

  const settings = createSettingsStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS, { onError: () => {} });
  settings.update({ pythonPath: REPO_PYTHON }, { internal: true });
  settings.update({
    setupComplete: true,
    equipment: { machine: 'cameo4', paper: 'a4' },
    upscayl: { enabled: false },
    pdf: { openWhenDone: false, options: { ppi: 300, registration: '3' } },
  });

  const env = { ...process.env, SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: dataDir };
  const basePaths = () => getPaths({
    isPackaged: false, appDir: APP_DIR, userData, appData: userData, documents: path.join(root, 'documents'),
    localAppData: null, platform: process.platform, env, settings: settings.get(),
  });
  const getPathsTemp = () => {
    const p = basePaths();
    // the temp copy is also the engine source (templates, calibration sheets, scripts)
    return Object.freeze({ ...p, engineSourceDir: ws, cuttingTemplatesDir: path.join(ws, 'cutting_templates'), calibrationDir: path.join(ws, 'calibration') });
  };
  const initial = getPathsTemp();
  fs.mkdirSync(initial.scmCacheDir, { recursive: true });
  const logLines = [];
  const logger = {
    info: (...a) => { if (VERBOSE) console.log('      [info]', ...a); },
    warn: (...a) => { logLines.push(a.join(' ')); if (VERBOSE) console.log('      [warn]', ...a); },
    error: (...a) => { logLines.push(a.join(' ')); console.log('      [error]', ...a); },
  };
  const opened = [];
  const deps = {
    getPaths: getPathsTemp,
    settings,
    jobs: new JobManager({ logsDir: initial.logsDir, scmCacheDir: initial.scmCacheDir }),
    locks: createLocks(),
    logger,
    helper: null,
    hashCache: createHashCache(path.join(initial.scmCacheDir, 'hashes.json')),
    emit: () => {},
    isTest: true,
    noAutoOpen: true,
    openPath: async (p) => { opened.push(p); return ''; },
    showItemInFolder: () => {},
  };
  deps.helper = createHelper(() => deps);
  deps.jobs.on('event', (e) => {
    if (!VERBOSE) return;
    if (e.type === 'step') console.log(`      step ${e.stepId}: ${e.status}${e.label ? ` (${e.label})` : ''}`);
    else if (e.type === 'log') for (const l of e.lines) console.log(`      [${l.stream}] ${l.line}`);
  });

  async function runJob(startPromise) {
    const { jobId } = await startPromise;
    const done = await deps.jobs.whenFinished(jobId);
    if (done.status !== 'succeeded') {
      const err = new Error(`job ${done.kind} ${done.status}: ${done.error ? done.error.message : ''}`);
      err.details = `${done.error && done.error.details ? done.error.details : ''}\n--- log ---\n${deps.jobs.getLog(jobId).split('\n').slice(-25).join('\n')}`;
      throw err;
    }
    return { ...done, log: deps.jobs.getLog(jobId) };
  }

  async function info(file) {
    return deps.helper.run('pdf-info', ['--pdf', file], { timeoutMs: 120000 });
  }

  function leftovers() {
    const out = initial.outputDir;
    const stage = path.join(ws, 'game', '.stage');
    return {
      stage: fs.existsSync(stage) ? fs.readdirSync(stage) : [],
      partials: fs.existsSync(out) ? fs.readdirSync(out).filter((n) => n.includes('.partial-')) : [],
    };
  }

  // warm-up: environment check + introspection (cached for the checks)
  await check(0, 'environment ready + introspection', async () => {
    const t0 = Date.now();
    const intro = await deps.helper.introspect({});
    assert.ok(intro.layouts.combos.length > 100);
    const a4 = intro.layouts.combos.find((c) => c.key === 'a4|standard|default');
    assert.ok(a4 && a4.templateFile && a4.templateFile.startsWith(ws), 'templates come from the temp copy');
    return `introspect ${Date.now() - t0} ms`;
  });

  let bothPdf = null;

  await check(1, 'fronts only, 300 PPI, one PDF', async () => {
    const names = loadFronts(ws);
    const plan = await pdf.planPdf(deps, { only_fronts: true, ppi: 300, fileName: 'fronts-only' });
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.equal(plan.cards.total, names.length);
    assert.equal(plan.resources.chunks, 1);
    assert.equal(plan.displayEquivalent, true, plan.displayNote || '');
    const done = await runJob(pdf.startPdfJob(deps, { only_fronts: true, ppi: 300, fileName: 'fronts-only' }));
    const res = done.result;
    assert.ok(fs.existsSync(res.pdfPath), 'PDF exists');
    assert.ok(/Generated PDF: /.test(done.log), '"Generated PDF" line seen');
    const pi = await info(res.pdfPath);
    assert.equal(pi.pages, plan.pdfPages);
    assert.equal(res.pages, plan.pdfPages);
    assert.equal(pi.ppi, 300);
    assert.equal(pi.imageWidthPx, plan.resources.pageWidthPx);
    assert.deepEqual(leftovers(), { stage: [], partials: [] });
    const last = settings.get().pdf.lastPdf;
    assert.equal(last.path, res.pdfPath);
    assert.ok(settings.get().pdf.secPerCard > 0, 'seconds per card measured');
    return `${plan.cards.total} cards, ${pi.pages} page(s), ${(res.sizeBytes / 1e6).toFixed(1)} MB, render ${res.durationMs} ms, secPerCard ${settings.get().pdf.secPerCard}`;
  });

  await check(2, 'forced chunking (tiny memory budget) + lossless merge at 600 PPI', async () => {
    const names = loadFronts(ws, { copies: 12 });
    settings.update({ pdf: { memoryBudgetPercent: 0.05 } });
    try {
      const req = { only_fronts: true, ppi: 600, fileName: 'chunked', label: 'Chunk test' };
      const plan = await pdf.planPdf(deps, req);
      assert.equal(plan.ok, true, JSON.stringify(plan.errors));
      assert.ok(plan.resources.chunks >= 2, `chunks ${plan.resources.chunks}`);
      assert.ok(plan.notices.some((n) => n.code === 'CHUNKED'));
      const done = await runJob(pdf.startPdfJob(deps, req));
      const res = done.result;
      assert.equal(res.chunks, plan.resources.chunks);
      const pi = await info(res.pdfPath);
      assert.equal(pi.pages, plan.pdfPages, 'page count after merge');
      assert.equal(pi.ppi, 600, 'page image resolution kept (no re-rasterization)');
      assert.equal(pi.imageWidthPx, plan.resources.pageWidthPx);
      assert.deepEqual(leftovers(), { stage: [], partials: [] });
      return `${names.length} cards in ${res.chunks} parts → ${pi.pages} pages, ${pi.imageWidthPx}×${pi.imageHeightPx} px, ${(res.sizeBytes / 1e6).toFixed(1)} MB, ${res.durationMs} ms`;
    } finally {
      settings.update({ pdf: { memoryBudgetPercent: 50 } });
    }
  });

  await check(3, 'fronts + backs: 2 common backs (mode file) + one unique back', async () => {
    const names = loadFronts(ws);
    clearKind(ws, 'back');
    clearKind(ws, 'double_sided');
    fs.copyFileSync(path.join(TEST_IMAGES, names[1]), path.join(ws, 'game', 'back', 'back one.jpg'));
    fs.copyFileSync(path.join(TEST_IMAGES, names[2]), path.join(ws, 'game', 'back', 'back two.jpg'));
    // a unique back for the first front, with a different extension (paired by name)
    const firstStem = path.basename(names[0], path.extname(names[0]));
    fs.copyFileSync(path.join(TEST_IMAGES, names[3]), path.join(ws, 'game', 'double_sided', `${firstStem}.webp`));
    settings.update({ cards: { back: { mode: 'auto', file: null } } });
    let plan = await pdf.planPdf(deps, { only_fronts: false, fileName: 'both' });
    assert.ok(plan.errors.some((e) => e.code === 'BACK_CHOOSE'), 'two backs need a choice');
    settings.update({ cards: { back: { mode: 'file', file: 'back two.jpg' } } });
    plan = await pdf.planPdf(deps, { only_fronts: false, fileName: 'both' });
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.equal(plan.pdfPages, plan.sheets * 2);
    assert.equal(plan.cards.pairs, 1);
    const done = await runJob(pdf.startPdfJob(deps, { only_fronts: false, fileName: 'both' }));
    const res = done.result;
    const pi = await info(res.pdfPath);
    assert.equal(pi.pages, plan.pdfPages);
    const light = pageBrightness(res.pdfPath);
    assert.ok(light.every((v) => v < 245), `every page has printed cards (brightness ${light.join(', ')})`);
    assert.ok(!res.warnings.some((w) => /back image/i.test(w)), JSON.stringify(res.warnings));
    bothPdf = res.pdfPath;
    return `${plan.cards.total} cards (${plan.cards.pairs} with a unique back) → ${pi.pages} pages, brightness ${light.join('/')}`;
  });

  await check(4, 'back faces printed as extra cards (fronts only)', async () => {
    const names = loadFronts(ws);
    clearKind(ws, 'double_sided');
    for (const name of names.slice(0, 2)) {
      fs.copyFileSync(path.join(TEST_IMAGES, names[7]), path.join(ws, 'game', 'double_sided', `${path.basename(name, path.extname(name))}.jpg`));
    }
    const req = { only_fronts: true, printBackFaces: true, fileName: 'faces' };
    const plan = await pdf.planPdf(deps, req);
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    assert.equal(plan.cards.faces, 2);
    assert.equal(plan.cards.total, names.length + 2);
    const done = await runJob(pdf.startPdfJob(deps, req));
    const pi = await info(done.result.pdfPath);
    assert.equal(pi.pages, plan.pdfPages);
    assert.equal(done.result.cards, names.length + 2);
    assert.ok(/\(back face\)/.test(done.log), 'back faces staged as extra fronts');
    clearKind(ws, 'double_sided');
    return `${plan.cards.total} cards → ${pi.pages} pages`;
  });

  await check(5, 'PNG pages instead of a PDF', async () => {
    loadFronts(ws, { copies: 4 });
    const req = { only_fronts: true, output_images: true, fileName: 'png pages' };
    const plan = await pdf.planPdf(deps, req);
    assert.equal(plan.ok, true, JSON.stringify(plan.errors));
    const done = await runJob(pdf.startPdfJob(deps, req));
    const folder = path.join(initial.outputDir, 'png pages');
    assert.equal(done.result.outputPath, folder);
    const pages = fs.readdirSync(folder).filter((n) => /^page\d+\.png$/.test(n)).sort();
    assert.equal(pages.length, plan.pdfPages);
    assert.deepEqual(pages, Array.from({ length: plan.pdfPages }, (_, i) => `page${i + 1}.png`));
    assert.ok(/Generated images: /.test(done.log));
    assert.deepEqual(leftovers(), { stage: [], partials: [] });
    return `${pages.length} PNG page(s) in ${folder}`;
  });

  await check(6, 'locked output: pre-flight refusal, then "(2)" fallback', async () => {
    loadFronts(ws);
    const final = path.join(initial.outputDir, 'locked.pdf');
    fs.writeFileSync(final, '%PDF-1.4 old');
    let lock = lockFile(final, 60);
    await lock.ready;
    let preflight = null;
    try {
      await pdf.startPdfJob(deps, { only_fronts: true, fileName: 'locked' });
    } catch (err) {
      preflight = err;
    } finally {
      await lock.release();
    }
    assert.ok(preflight, 'start refused');
    assert.equal(preflight.code, 'OUTPUT_LOCKED');
    assert.match(preflight.message, /locked\.pdf is open in another program/);
    assert.equal(deps.jobs.active(), null, 'no job started');
    // fallback: the file gets locked while the PDF is being made
    fs.rmSync(final, { force: true });
    const { jobId } = await pdf.startPdfJob(deps, { only_fronts: true, ppi: 600, fileName: 'locked' });
    lock = lockFile(final, 120);
    await lock.ready;
    const stillRunning = !!deps.jobs.active();
    let done;
    try {
      done = await deps.jobs.whenFinished(jobId);
    } finally {
      await lock.release();
    }
    assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
    if (!stillRunning) return 'inconclusive: the PDF was finished before the file could be locked';
    assert.equal(path.basename(done.result.pdfPath), 'locked (2).pdf');
    assert.ok(done.result.warnings.some((w) => /saved as locked \(2\)\.pdf/.test(w)), JSON.stringify(done.result.warnings));
    assert.deepEqual(leftovers(), { stage: [], partials: [] });
    return `saved as ${path.basename(done.result.pdfPath)} after ${done.durationMs} ms`;
  });

  await check(7, 'offset job on the fronts + backs PDF', async () => {
    if (!bothPdf) throw new Error('check 3 did not produce a PDF');
    const src = await info(bothPdf);
    const done = await runJob(offset.startOffsetJob(deps, { pdfPath: bothPdf, x_offset: 12, y_offset: -7, angle_offset: 0.5, ppi: null }));
    const res = done.result;
    assert.equal(path.basename(res.pdfPath), 'both_offset.pdf');
    const pi = await info(res.pdfPath);
    assert.equal(pi.pages, src.pages);
    assert.equal(res.ppi, src.ppi, 'renders at the PDF resolution');
    assert.ok(/Offset PDF: /.test(done.log));
    assert.deepEqual(leftovers(), { stage: [], partials: [] });
    return `${pi.pages} pages at ${res.ppi} PPI, ${(res.sizeBytes / 1e6).toFixed(1)} MB, ${res.durationMs} ms`;
  });

  await check(8, 'generate the Legal calibration sheet', async () => {
    const before = await offset.calibrationFor(deps, 'legal');
    assert.equal(before.path, null, 'no bundled Legal sheet');
    assert.equal(before.canGenerate, true);
    const done = await runJob(offset.startGenerateCalibrationJob(deps, 'legal'));
    assert.ok(fs.existsSync(done.result.path));
    assert.ok(done.result.path.startsWith(initial.scmCacheDir));
    const after = await offset.calibrationFor(deps, 'legal');
    assert.equal(after.path, done.result.path);
    const pi = await info(after.path);
    assert.equal(pi.pages, 2);
    assert.ok(Math.abs(pi.widthIn - 14) < 0.05 && Math.abs(pi.heightIn - 8.5) < 0.05, `${pi.widthIn} x ${pi.heightIn} in`);
    const a4 = await offset.calibrationFor(deps, 'a4');
    assert.ok(a4.path && a4.path.startsWith(path.join(ws, 'calibration')), 'bundled sheet preferred');
    return `${path.basename(after.path)} (${pi.widthIn} x ${pi.heightIn} in, ${pi.ppi} PPI)`;
  });

  await check(9, 'shifted calibration sheet', async () => {
    fs.writeFileSync(path.join(ws, 'data', 'offset_data.json'), '{"x_offset": 1.5, "y_offset": "oops"}'); // damaged on purpose
    const done = await runJob(offset.startShiftedCalibrationJob(deps, { paper: 'a4', x: 20, y: -20, angle: 0.25 }));
    const res = done.result;
    assert.ok(fs.existsSync(res.path));
    assert.equal(path.basename(res.path), 'a4-shifted-20_-20_0.25.pdf');
    const pi = await info(res.path);
    assert.equal(pi.pages, 2);
    assert.equal(pi.ppi, 300);
    const saved = await offset.readOffset(deps);
    assert.equal(saved.valid, false, 'the damaged file is reported, not used');
    const written = await offset.writeOffset(deps, { x_offset: 20.4, y_offset: -19.6, angle_offset: 0.25 });
    assert.deepEqual({ x: written.x_offset, y: written.y_offset, a: written.angle_offset, valid: written.valid }, { x: 20, y: -20, a: 0.25, valid: true });
    return `${path.basename(res.path)}, ${done.durationMs} ms`;
  });

  await check(10, 'print info + open template (copied, nothing opened for real)', async () => {
    const infoRes = await print.printInfo(deps);
    assert.ok(infoRes.template.name);
    assert.ok(infoRes.template.file && fs.existsSync(infoRes.template.file));
    assert.ok(infoRes.lastPdf && infoRes.lastPdf.path);
    const res = await print.openTemplate(deps, infoRes.template.file);
    assert.equal(res.opened, true);
    assert.equal(res.copiedTo, path.join(initial.outputDir, 'templates', path.basename(infoRes.template.file)));
    assert.ok(fs.existsSync(res.copiedTo));
    assert.equal(opened[opened.length - 1], res.copiedTo);
    return `template ${infoRes.template.name}; Silhouette Studio ${infoRes.silhouetteStudio.found ? `found (${infoRes.silhouetteStudio.version || '?'})` : 'not found'}`;
  });

  if (flag('--with-upscayl')) {
    await check(11, 'upscale step inside the PDF job (real Upscayl)', async () => {
      const bin = option('--upscayl', process.env.SCM_UPSCAYL_BIN || 'D:\\Tools\\Upscaly\\Upscayl\\resources\\bin\\upscayl-bin.exe');
      if (!fs.existsSync(bin)) return `skipped: Upscayl not found at ${bin}`;
      process.env.SCM_UPSCAYL_BIN = bin;
      clearKind(ws, 'front');
      clearKind(ws, 'double_sided');
      // two small pictures (469 and 600 px wide): far below 600 PPI on a 63 mm card
      const small = testImages().filter((n) => /cube|one_piece/.test(n));
      for (const n of small) fs.copyFileSync(path.join(TEST_IMAGES, n), path.join(ws, 'game', 'front', n));
      settings.update({ upscayl: { enabled: true, model: 'upscayl-standard-4x', scale: 4, smartScale: true, format: 'same' } });
      try {
        const req = { only_fronts: true, ppi: 600, upscale: true, fileName: 'upscaled' };
        const plan = await pdf.planPdf(deps, req);
        assert.equal(plan.ok, true, JSON.stringify(plan.errors));
        assert.ok(plan.upscale && plan.upscale.available, JSON.stringify(plan.upscale));
        assert.equal(plan.upscale.needed + plan.upscale.cached, small.length, JSON.stringify(plan.upscale));
        assert.equal(plan.displayEquivalent, false);
        const done = await runJob(pdf.startPdfJob(deps, req));
        const res = done.result;
        assert.ok(res.upscaled, 'upscale summary in the result');
        assert.equal(res.upscaled.upscaled + res.upscaled.cached + res.upscaled.fallbacks, small.length, JSON.stringify(res.upscaled));
        const up = fs.readdirSync(path.join(ws, 'game', 'upscaled', 'front'));
        assert.equal(up.length, small.length, up.join(', '));
        const pi = await info(res.pdfPath);
        assert.equal(pi.pages, plan.pdfPages);
        // second run: everything is cached
        const again = await pdf.planPdf(deps, req);
        assert.equal(again.upscale.needed, 0, JSON.stringify(again.upscale));
        assert.equal(again.upscale.cached, small.length);
        return `${res.upscaled.upscaled} upscaled, ${res.upscaled.fallbacks} fallbacks in ${res.upscaled.durationMs} ms; PDF ${res.durationMs} ms; warnings: ${res.warnings.length}`;
      } finally {
        settings.update({ upscayl: { enabled: false } });
      }
    });
  }

  if (flag('--with-1440')) {
    await check(12, 'the first user\'s defaults: A4, 1440 PPI, fronts only, 4 marks, 2mm corners, 0.5mm edges', async () => {
      loadFronts(ws);
      clearKind(ws, 'double_sided');
      const defaults = DEFAULT_SETTINGS.pdf.options;
      settings.update({ pdf: { options: { ...defaults } }, equipment: { machine: 'cameo5alpha', paper: 'a4' } });
      try {
        const plan = await pdf.planPdf(deps, { fileName: 'first-user' });
        assert.equal(plan.ok, true, JSON.stringify(plan.errors));
        for (const expected of ['--paper_size=a4', '--ppi=1440', '--only_fronts', '--registration=4', '--extend_corners=2mm', '--extend_edges=0.5mm']) {
          assert.ok(plan.display.includes(expected), `${expected} in ${plan.display}`);
        }
        assert.equal(plan.displayEquivalent, true, plan.displayNote || '');
        const done = await runJob(pdf.startPdfJob(deps, { fileName: 'first-user' }));
        const pi = await info(done.result.pdfPath);
        assert.equal(pi.ppi, 1440);
        assert.equal(pi.imageWidthPx, 16833);
        assert.equal(pi.imageHeightPx, 11904);
        return `${pi.pages} page, ${(done.result.sizeBytes / 1e6).toFixed(1)} MB (estimated ${(plan.resources.pdfBytesEst / 1e6).toFixed(1)} MB), peak estimate ${(plan.resources.peakBytes / 1e9).toFixed(1)} GB, ${done.result.durationMs} ms`;
      } finally {
        settings.update({ pdf: { options: { ppi: 300, registration: '3' } }, equipment: { machine: 'cameo4', paper: 'a4' } });
      }
    });
  }

  // ---- summary ----
  await settings.flush();
  await deps.hashCache.flush();
  deps.jobs.dispose();
  console.log('\nSummary');
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${String(r.id).padStart(2)}  ${(r.ms / 1000).toFixed(1).padStart(6)} s  ${r.name}`);
  console.log(`${results.length - failures}/${results.length} passed`);
  if (!flag('--keep')) {
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch((err) => console.log(`could not remove ${root}: ${err.message}`));
  } else {
    console.log(`kept: ${root}`);
  }
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
