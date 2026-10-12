'use strict';

/**
 * offset.js unit tests: reading/writing the alignment file with the engine's (pydantic 2.13) rules,
 * calibration sheet lookup (bundled / workspace / generated, aliases, extra layouts), and the three
 * jobs (generate, shifted sheet, apply to a PDF) with the real JobManager running fake engine scripts
 * through Node (no Python needed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const offset = require('../../src/main/offset');
const { getPaths } = require('../../src/main/paths');
const { DEFAULT_SETTINGS, deepMerge } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');

const APP_DIR = path.resolve(__dirname, '..', '..');
const GB = 1024 ** 3;

const LAYOUTS = {
  ppi: 300,
  paper_sizes: {
    letter: { width: '11in', height: '8.5in', aliases: ['ansi_a'] },
    legal: { width: '14in', height: '8.5in' },
    a4: { width: '297mm', height: '210mm' },
  },
};

// Fake generate_calibration.py (run by Node): one sheet per paper of <script dir>/assets, written
// relative to the working folder like the real script.
const FAKE_GENERATE = String.raw`
const fs = require('fs');
const path = require('path');
const root = __dirname;
const sizes = Object.keys(JSON.parse(fs.readFileSync(path.join(root, 'assets', 'layouts.json'), 'utf8')).paper_sizes);
const extraDir = path.join(root, 'assets', 'extra_layouts');
if (fs.existsSync(extraDir)) for (const n of fs.readdirSync(extraDir).sort()) sizes.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(extraDir, n), 'utf8')).paper_sizes || {}));
fs.appendFileSync(path.join(root, 'calls.jsonl'), JSON.stringify({ script: 'generate', cwd: process.cwd(), argv: process.argv.slice(2) }) + '\n');
if (process.env.FAKE_GENERATE_FAIL) { console.error('Traceback (most recent call last):'); console.error('MemoryError'); process.exit(1); }
for (const s of sizes) {
  if (process.env.FAKE_GENERATE_SKIP === s) continue;
  fs.writeFileSync(path.join('calibration', s + '-calibration.pdf'), '%PDF calibration ' + s);
  console.log('Calibration PDF: ' + path.join('calibration', s + '-calibration.pdf'));
}
`;

// Fake offset_pdf.py (run by Node).
const FAKE_OFFSET = String.raw`
const fs = require('fs');
const path = require('path');
const args = {};
for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=([\s\S]*)$/.exec(a); if (m) args[m[1]] = m[2]; }
fs.appendFileSync(path.join(__dirname, 'calls.jsonl'), JSON.stringify({ script: 'offset', cwd: process.cwd(), argv: process.argv.slice(2), args, dataInCwd: fs.existsSync(path.join(process.cwd(), 'data', 'offset_data.json')) }) + '\n');
console.log('Using x offset: ' + args.x_offset + ', y offset: ' + args.y_offset + ', angle offset: ' + args.angle);
if (!fs.existsSync(args.pdf_path)) { console.log('Cannot offset nonexistent PDF: ' + args.pdf_path); process.exit(0); }
const pages = Number(process.env.FAKE_PAGES || 2);
for (let i = 1; i <= pages; i++) console.log('Page ' + i);
if (!process.env.FAKE_NO_OUTPUT) fs.writeFileSync(args.output_pdf_path, '%PDF offset x=' + args.x_offset + ' y=' + args.y_offset + ' a=' + args.angle + ' ppi=' + args.ppi);
console.log('Offset PDF: ' + args.output_pdf_path);
`;

function mkTmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-offset-'));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });
  return dir;
}

function withEnv(t, vars) {
  const old = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  t.after(() => {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/**
 * Temp workspace (= engine folder) with fake scripts; `bundled` papers get a calibration sheet in
 * the engine's calibration folder.
 */
function setup(t, { bundled = ['a4', 'letter'], scripts = true, settings: patch = {}, totalMemBytes = 64 * GB, helper } = {}) {
  const root = mkTmp(t);
  const ws = path.join(root, 'ws');
  const engine = path.join(root, 'engine');
  for (const dir of [ws, engine]) {
    fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'assets', 'layouts.json'), JSON.stringify(LAYOUTS));
  }
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.mkdirSync(path.join(engine, 'calibration'), { recursive: true });
  for (const p of bundled) fs.writeFileSync(path.join(engine, 'calibration', `${p}-calibration.pdf`), `%PDF bundled ${p}`);
  if (scripts) {
    fs.writeFileSync(path.join(ws, 'generate_calibration.py'), FAKE_GENERATE);
    fs.writeFileSync(path.join(ws, 'offset_pdf.py'), FAKE_OFFSET);
  }
  let current = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), { pythonPath: process.execPath });
  current = deepMerge(current, patch);
  const helperCalls = [];
  const deps = {
    getPaths: () => {
      const p = getPaths({
        isPackaged: false,
        appDir: APP_DIR,
        userData: path.join(root, 'userdata'),
        platform: process.platform,
        env: { SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: path.join(root, 'data') },
        settings: current,
      });
      return Object.freeze({ ...p, engineSourceDir: engine, calibrationDir: path.join(engine, 'calibration'), cuttingTemplatesDir: path.join(engine, 'cutting_templates') });
    },
    settings: {
      get: () => current,
      update: (patchValue) => {
        current = deepMerge(current, patchValue);
        return current;
      },
    },
    helper: helper || {
      run: async (sub, args) => {
        helperCalls.push({ sub, args });
        if (sub === 'pdf-info') return { pages: 4, widthIn: 11.6917, heightIn: 8.2667, ppi: 300, bytes: 1234 };
        throw new Error(`unexpected helper call ${sub}`);
      },
    },
    totalMemBytes,
    logger: { info() {}, warn() {}, error() {} },
    emit: () => {},
  };
  const calls = () => {
    const file = path.join(ws, 'calls.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { root, ws, engine, deps, helperCalls, calls, settings: () => current, paths: () => deps.getPaths() };
}

function attachJobs(t, env) {
  const jobs = new JobManager({ logsDir: null, scmCacheDir: path.join(env.root, 'data', 'scm-cache'), cancelGraceMs: 10000 });
  env.deps.jobs = jobs;
  t.after(() => jobs.dispose());
  return jobs;
}

async function finished(jobs, startPromise) {
  const { jobId } = await startPromise;
  return jobs.whenFinished(jobId);
}

// ---------------------------------------------------------------------------------------------
// readOffset / writeOffset / resetOffset
// ---------------------------------------------------------------------------------------------

test('readOffset: missing file → null; valid values', async (t) => {
  const env = setup(t);
  assert.equal(await offset.readOffset(env.deps), null);
  fs.writeFileSync(env.paths().dataPath, JSON.stringify({ x_offset: 12, y_offset: -3, angle_offset: 0.25 }, null, 4));
  assert.deepEqual(await offset.readOffset(env.deps), { x_offset: 12, y_offset: -3, angle_offset: 0.25, valid: true, error: null });
  fs.writeFileSync(env.paths().dataPath, '{"x_offset": 1, "y_offset": 2}');
  assert.equal((await offset.readOffset(env.deps)).angle_offset, 0, 'angle defaults to 0 like the engine');
});

test('readOffset mirrors the engine\'s pydantic rules (what would crash or be skipped is invalid)', async (t) => {
  const env = setup(t);
  const read = async (text) => {
    fs.writeFileSync(env.paths().dataPath, text);
    return offset.readOffset(env.deps);
  };
  // accepted by pydantic 2.13 (lax mode)
  for (const [text, x, y] of [
    ['{"x_offset": 12.0, "y_offset": -3.0}', 12, -3],
    ['{"x_offset": "12", "y_offset": " 7 "}', 12, 7],
    ['{"x_offset": "12.0", "y_offset": "1_000"}', 12, 1000],
    ['{"x_offset": true, "y_offset": false}', 1, 0],
    ['{"x_offset": 1e3, "y_offset": "+5"}', 1000, 5],
  ]) {
    const r = await read(text);
    assert.equal(r.valid, true, text);
    assert.deepEqual([r.x_offset, r.y_offset], [x, y], text);
  }
  // rejected (pydantic ValidationError → the engine crashes) or non-finite angles
  for (const text of [
    '{"x_offset": 12.5, "y_offset": 0}',
    '{"x_offset": null, "y_offset": 0}',
    '{"x_offset": "1e3", "y_offset": 0}',
    '{"x_offset": "12.", "y_offset": 0}',
    '{"x_offset": "0x10", "y_offset": 0}',
    '{"y_offset": 2}',
    '{"x_offset": 1, "y_offset": 2, "angle_offset": null}',
    '{"x_offset": 1, "y_offset": 2, "angle_offset": "nan"}',
    '{"x_offset": 1, "y_offset": 2, "angle_offset": "1,5"}',
  ]) {
    const r = await read(text);
    assert.equal(r.valid, false, text);
    assert.ok(r.error && !/x_offset|pydantic/.test(r.error), `plain message for ${text}: ${r.error}`);
  }
  assert.equal((await read('{"x_offset": 1, "y_offset": 2, "angle_offset": " 1.5 "}')).angle_offset, 1.5);
  // broken JSON, a list, a BOM (Python's json.load refuses it: the engine would print without the alignment)
  assert.deepEqual(await read('{"x_offset": 1,'), { x_offset: null, y_offset: null, angle_offset: null, valid: false, error: 'The saved printer alignment file is damaged.' });
  assert.equal((await read('[1, 2]')).valid, false);
  const bom = await read('﻿{"x_offset": 4, "y_offset": 5}');
  assert.equal(bom.valid, false);
  assert.deepEqual([bom.x_offset, bom.y_offset], [4, 5], 'values are still shown so they can be saved again');
  assert.match(bom.error, /Save your alignment again/);
  // a folder where the file should be
  fs.rmSync(env.paths().dataPath, { force: true });
  fs.mkdirSync(env.paths().dataPath);
  const unreadable = await offset.readOffset(env.deps);
  assert.equal(unreadable.valid, false);
});

test('coerceInt / coerceFloat edge cases', () => {
  assert.equal(offset.coerceInt(-0), 0);
  assert.ok(Object.is(offset.coerceInt('-0'), 0));
  assert.equal(offset.coerceInt('1__0'), null);
  assert.equal(offset.coerceInt('١٢'), null, 'ASCII digits only');
  assert.equal(offset.coerceFloat('1e-3'), 0.001);
  assert.equal(offset.coerceFloat('.5'), 0.5);
  assert.equal(offset.coerceFloat('5.'), 5);
  assert.equal(offset.coerceFloat('Infinity'), null);
  assert.equal(offset.coerceFloat(Number.NaN), null);
});

test('writeOffset: whole pixels, rounded angle, engine format, switches "Apply my printer alignment" on', async (t) => {
  const env = setup(t);
  const saved = await offset.writeOffset(env.deps, { x_offset: 20.4, y_offset: '-19,6', angle_offset: 0.123456 });
  assert.deepEqual(saved, { x_offset: 20, y_offset: -20, angle_offset: 0.1235, valid: true, error: null });
  const text = fs.readFileSync(env.paths().dataPath, 'utf8');
  assert.equal(text, '{\n    "x_offset": 20,\n    "y_offset": -20,\n    "angle_offset": 0.1235\n}\n');
  assert.equal(env.settings().pdf.options.load_offset, true);
  assert.equal(text.charCodeAt(0), 0x7b, 'no BOM');
});

test('writeOffset: zero keeps the setting, invalid values are refused, reset writes 0, 0, 0', async (t) => {
  const env = setup(t);
  await offset.writeOffset(env.deps, { x_offset: 0, y_offset: 0 });
  assert.equal(env.settings().pdf.options.load_offset, false, 'a zero alignment does not switch the option on');
  await assert.rejects(offset.writeOffset(env.deps, { x_offset: 'abc', y_offset: 0 }), (err) => err.code === 'INVALID_OFFSET' && /numbers/.test(err.message));
  await assert.rejects(offset.writeOffset(env.deps, { x_offset: 1, y_offset: Number.NaN }), { code: 'INVALID_OFFSET' });
  await assert.rejects(offset.writeOffset(env.deps, { x_offset: 1e9, y_offset: 0 }), { code: 'INVALID_OFFSET' });
  await assert.rejects(offset.writeOffset(env.deps, { x_offset: 1, y_offset: 0, angle_offset: 400 }), { code: 'INVALID_OFFSET' });
  fs.writeFileSync(env.paths().dataPath, '{"x_offset": 1.5}');
  const reset = await offset.resetOffset(env.deps);
  assert.deepEqual(reset, { x_offset: 0, y_offset: 0, angle_offset: 0, valid: true, error: null });
});

// ---------------------------------------------------------------------------------------------
// calibration sheets
// ---------------------------------------------------------------------------------------------

test('calibrationFor: bundled, aliases, workspace sheet, generated, unknown paper', async (t) => {
  const env = setup(t, { bundled: ['a4', 'letter'] });
  const a4 = await offset.calibrationFor(env.deps, 'A4');
  assert.deepEqual(a4, { path: path.join(env.engine, 'calibration', 'a4-calibration.pdf'), canGenerate: true, generated: false, paper: 'a4' });
  assert.equal((await offset.calibrationFor(env.deps, 'ansi_a')).paper, 'letter');
  const legal = await offset.calibrationFor(env.deps, 'legal');
  assert.deepEqual(legal, { path: null, canGenerate: true, generated: false, paper: 'legal' });
  // an external workspace may ship its own calibration folder
  fs.mkdirSync(path.join(env.ws, 'calibration'), { recursive: true });
  fs.writeFileSync(path.join(env.ws, 'calibration', 'legal-calibration.pdf'), '%PDF ws');
  assert.equal((await offset.calibrationFor(env.deps, 'legal')).path, path.join(env.ws, 'calibration', 'legal-calibration.pdf'));
  fs.rmSync(path.join(env.ws, 'calibration'), { recursive: true });
  // generated earlier
  const gen = path.join(env.paths().scmCacheDir, 'calibration', 'calibration', 'legal-calibration.pdf');
  fs.mkdirSync(path.dirname(gen), { recursive: true });
  fs.writeFileSync(gen, '%PDF gen');
  assert.deepEqual(await offset.calibrationFor(env.deps, 'legal'), { path: gen, canGenerate: true, generated: true, paper: 'legal' });
  const unknown = await offset.calibrationFor(env.deps, 'tabloid_xl');
  assert.equal(unknown.paper, null);
  assert.equal(unknown.canGenerate, false);
  assert.match(unknown.error, /Unknown paper size/);
});

test('calibration engine: the workspace scripts and extra layouts win, else the bundled engine', async (t) => {
  const env = setup(t);
  fs.mkdirSync(path.join(env.ws, 'assets', 'extra_layouts'), { recursive: true });
  fs.writeFileSync(path.join(env.ws, 'assets', 'extra_layouts', 'mine.json'), JSON.stringify({ paper_sizes: { b4: { width: '353mm', height: '250mm', aliases: ['jis_b4'] } } }));
  let engine = await offset.calibrationEngine(env.paths());
  assert.equal(engine.script, path.join(env.ws, 'generate_calibration.py'));
  assert.deepEqual(engine.names, ['letter', 'legal', 'a4', 'b4']);
  assert.equal((await offset.calibrationFor(env.deps, 'jis_b4')).paper, 'b4');
  // no script in the workspace → the bundled engine's script
  fs.rmSync(path.join(env.ws, 'generate_calibration.py'));
  fs.writeFileSync(path.join(env.engine, 'generate_calibration.py'), FAKE_GENERATE);
  engine = await offset.calibrationEngine(env.paths());
  assert.equal(engine.script, path.join(env.engine, 'generate_calibration.py'));
  // no script anywhere → can't generate, bundled sheets still found
  fs.rmSync(path.join(env.engine, 'generate_calibration.py'));
  const a4 = await offset.calibrationFor(env.deps, 'a4');
  assert.equal(a4.canGenerate, false);
  assert.ok(a4.path);
  assert.equal(offset.paperLabel('arch_b'), 'Arch B');
  assert.equal(offset.paperLabel('a4'), 'A4');
  assert.equal(offset.paperLabel('letter'), 'Letter');
});

test('generate job: runs the script in <scmCacheDir>/calibration and returns the paper\'s sheet', async (t) => {
  withEnv(t, { FAKE_GENERATE_FAIL: undefined, FAKE_GENERATE_SKIP: undefined });
  const env = setup(t);
  const jobs = attachJobs(t, env);
  const events = [];
  jobs.on('event', (e) => events.push(e));
  const done = await finished(jobs, offset.startGenerateCalibrationJob(env.deps, 'LEGAL'));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const outDir = path.join(env.paths().scmCacheDir, 'calibration');
  assert.deepEqual(done.result, { path: path.join(outDir, 'calibration', 'legal-calibration.pdf'), paper: 'legal' });
  assert.equal(done.title, 'Making the Legal calibration sheet');
  const [call] = env.calls();
  // a per-job folder inside <scmCacheDir>/calibration (finished sheets are moved out of it)
  assert.equal(path.dirname(path.resolve(call.cwd)), path.resolve(outDir), 'never writes into the engine folder');
  assert.ok(!fs.existsSync(call.cwd), 'the per-job folder is removed');
  assert.ok(events.some((e) => e.type === 'progress' && e.jobId === done.jobId));
  assert.equal((await offset.calibrationFor(env.deps, 'legal')).generated, true);
  assert.deepEqual(fs.readdirSync(path.join(outDir, 'calibration')).sort(), ['a4-calibration.pdf', 'legal-calibration.pdf', 'letter-calibration.pdf']);
});

test('generate job: refusals (unknown paper, missing script, busy) and failures in plain words', async (t) => {
  withEnv(t, { FAKE_GENERATE_FAIL: undefined, FAKE_GENERATE_SKIP: 'legal' });
  const env = setup(t);
  const jobs = attachJobs(t, env);
  await assert.rejects(offset.startGenerateCalibrationJob(env.deps, 'nope'), { code: 'UNKNOWN_PAPER' });
  let done = await finished(jobs, offset.startGenerateCalibrationJob(env.deps, 'legal'));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'NO_OUTPUT');
  assert.equal(done.error.message, 'The calibration sheet for Legal paper could not be made.');
  process.env.FAKE_GENERATE_FAIL = '1';
  done = await finished(jobs, offset.startGenerateCalibrationJob(env.deps, 'legal'));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'OUT_OF_MEMORY');
  const busy = setup(t);
  busy.deps.jobs = { active: () => ({ title: 'Making proxies.pdf' }), start: () => { throw new Error('no'); } };
  await assert.rejects(offset.startGenerateCalibrationJob(busy.deps, 'legal'), /^Error: BUSY: wait until "Making proxies\.pdf" finishes$/);
  const noScript = setup(t, { scripts: false });
  attachJobs(t, noScript);
  await assert.rejects(offset.startGenerateCalibrationJob(noScript.deps, 'legal'), { code: 'ENGINE_MISSING' });
  const noPython = setup(t, { settings: { pythonPath: path.join(env.root, 'missing', 'python.exe') } });
  attachJobs(t, noPython);
  await assert.rejects(offset.startGenerateCalibrationJob(noPython.deps, 'legal'), { code: 'NOT_INSTALLED' });
});

test('shifted calibration: explicit values, a scratch working folder (no saved alignment), old sheets pruned', async (t) => {
  withEnv(t, { FAKE_PAGES: 2, FAKE_NO_OUTPUT: undefined, FAKE_GENERATE_FAIL: undefined, FAKE_GENERATE_SKIP: undefined });
  const env = setup(t);
  fs.writeFileSync(env.paths().dataPath, '{"x_offset": 1.5}'); // damaged: must not matter
  const outDir = path.join(env.paths().scmCacheDir, 'calibration');
  fs.mkdirSync(outDir, { recursive: true });
  for (let i = 0; i < 12; i += 1) {
    const f = path.join(outDir, `a4-shifted-${i}_0_0.pdf`);
    fs.writeFileSync(f, 'old');
    fs.utimesSync(f, new Date(Date.now() - (20 - i) * 60000), new Date(Date.now() - (20 - i) * 60000));
  }
  const jobs = attachJobs(t, env);
  const done = await finished(jobs, offset.startShiftedCalibrationJob(env.deps, { paper: 'a4', x: 20, y: -20, angle: 0.25 }));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const expected = path.join(outDir, 'a4-shifted-20_-20_0.25.pdf');
  assert.deepEqual(done.result, { path: expected, paper: 'a4', x: 20, y: -20, angle: 0.25 });
  assert.match(fs.readFileSync(expected, 'utf8'), /x=20 y=-20 a=0\.25 ppi=300/);
  const call = env.calls().find((c) => c.script === 'offset');
  assert.equal(call.args.pdf_path, path.join(env.engine, 'calibration', 'a4-calibration.pdf'));
  assert.equal(call.dataInCwd, false, 'runs where no saved alignment can be auto-loaded');
  assert.ok(!path.resolve(call.cwd).startsWith(path.resolve(env.ws)), 'not in the workspace');
  assert.ok(call.argv.every((a) => /^--[a-z_]+=/.test(a)), '--name=value only (negative numbers are safe)');
  const left = fs.readdirSync(outDir).filter((n) => n.includes('-shifted-'));
  assert.equal(left.length, 10, `newest sheets kept: ${left.join(', ')}`);
  assert.ok(left.includes('a4-shifted-20_-20_0.25.pdf'));
  assert.ok(!left.includes('a4-shifted-0_0_0.pdf'), 'oldest removed');
  assert.ok(!fs.readdirSync(outDir).some((n) => n.includes('.partial-')));
});

test('shifted calibration: generates the plain sheet first when the paper has none', async (t) => {
  withEnv(t, { FAKE_PAGES: 2, FAKE_NO_OUTPUT: undefined, FAKE_GENERATE_FAIL: undefined, FAKE_GENERATE_SKIP: undefined });
  const env = setup(t, { bundled: [] });
  const jobs = attachJobs(t, env);
  const done = await finished(jobs, offset.startShiftedCalibrationJob(env.deps, { paper: 'legal', x: 0, y: 20, angle: 0 }));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(done.steps.map((s) => [s.id, s.status]), [['generate', 'done'], ['shift', 'done']]);
  const call = env.calls().find((c) => c.script === 'offset');
  assert.equal(call.args.pdf_path, path.join(env.paths().scmCacheDir, 'calibration', 'calibration', 'legal-calibration.pdf'));
  await assert.rejects(offset.startShiftedCalibrationJob(env.deps, { paper: 'legal', x: Number.NaN, y: 0, angle: 0 }), { code: 'INVALID_OFFSET' });
});

// ---------------------------------------------------------------------------------------------
// pdfInfo / startOffsetJob
// ---------------------------------------------------------------------------------------------

test('pdfInfo: pages, resolution, size and a memory estimate; unreadable PDFs in plain words', async (t) => {
  const env = setup(t);
  const file = path.join(env.root, 'deck.pdf');
  fs.writeFileSync(file, '%PDF');
  const info = await offset.pdfInfo(env.deps, file);
  assert.equal(info.pages, 4);
  assert.equal(info.ppi, 300);
  assert.equal(info.estimatePpi, 300);
  assert.equal(info.peakBytes, offset.offsetPeakBytes({ pages: 4, widthIn: 11.6917, heightIn: 8.2667, ppi: 300 }));
  assert.equal(info.peakBytes, Math.round((1.5 * 4 + 2) * Math.ceil(11.6917 * 300) * Math.ceil(8.2667 * 300) * 3));
  assert.deepEqual(env.helperCalls[0], { sub: 'pdf-info', args: ['--pdf', file] });
  await assert.rejects(offset.pdfInfo(env.deps, path.join(env.root, 'missing.pdf')), { code: 'PDF_MISSING' });
  env.deps.helper = { run: async () => { throw Object.assign(new Error('Something went wrong: PdfiumError: Failed to load document'), { code: 'UNKNOWN', details: 'tb' }); } };
  await assert.rejects(offset.pdfInfo(env.deps, file), (err) => err.code === 'BAD_PDF' && err.message === '"deck.pdf" is not a PDF the app can read.');
  env.deps.helper = { run: async () => { throw Object.assign(new Error('The card maker components are not installed yet. Open Setup to install them.'), { code: 'NOT_INSTALLED' }); } };
  await assert.rejects(offset.pdfInfo(env.deps, file), { code: 'NOT_INSTALLED' });
  assert.equal(offset.offsetPeakBytes({ pages: 0, widthIn: 1, heightIn: 1, ppi: 300 }), null);
});

test('offset job: <outputDir>/<name>_offset.pdf via a partial file, PDF resolution by default, last PDF updated', async (t) => {
  withEnv(t, { FAKE_PAGES: 4, FAKE_NO_OUTPUT: undefined });
  const env = setup(t);
  const outDir = env.paths().outputDir;
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(outDir, 'deck.pdf');
  fs.writeFileSync(src, '%PDF source');
  env.deps.settings.update({ pdf: { lastPdf: { path: src, ppi: 300, loadOffset: false, pages: 4, at: 'x', onlyFronts: false } } });
  const jobs = attachJobs(t, env);
  const done = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 12, y_offset: -7, angle_offset: 0.5, ppi: null }));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const out = path.join(outDir, 'deck_offset.pdf');
  assert.equal(done.result.pdfPath, out);
  assert.equal(done.result.ppi, 300, 'resolution read from the PDF');
  assert.equal(done.result.pages, 4);
  assert.match(fs.readFileSync(out, 'utf8'), /x=12 y=-7 a=0\.5 ppi=300/);
  assert.ok(!fs.readdirSync(outDir).some((n) => n.includes('.partial-')));
  const call = env.calls().find((c) => c.script === 'offset');
  assert.match(path.basename(call.args.output_pdf_path), /^\.deck_offset\.partial-[0-9a-f]+\.pdf$/);
  const last = env.settings().pdf.lastPdf;
  assert.equal(last.path, out);
  assert.equal(last.loadOffset, true);
  // explicit resolution and output file
  const custom = path.join(env.root, 'other', 'aligned.pdf');
  const done2 = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 1, y_offset: 1, angle_offset: 0, ppi: 150, outputPath: custom }));
  assert.equal(done2.status, 'succeeded', JSON.stringify(done2.error));
  assert.equal(done2.result.pdfPath, custom);
  assert.match(fs.readFileSync(custom, 'utf8'), /ppi=150/);
});

test('offset job: refusals and failure detection', async (t) => {
  withEnv(t, { FAKE_PAGES: 2, FAKE_NO_OUTPUT: undefined });
  const env = setup(t, { totalMemBytes: 1 * GB });
  const outDir = env.paths().outputDir;
  fs.mkdirSync(outDir, { recursive: true });
  const src = path.join(outDir, 'big.pdf');
  fs.writeFileSync(src, '%PDF');
  const jobs = attachJobs(t, env);
  await assert.rejects(offset.startOffsetJob(env.deps, { pdfPath: path.join(outDir, 'missing.pdf'), x_offset: 0, y_offset: 0, angle_offset: 0, ppi: null }), { code: 'PDF_MISSING' });
  await assert.rejects(offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: 5000 }), { code: 'INVALID_PPI' });
  await assert.rejects(offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: null, outputPath: src }), { code: 'INVALID_ARGUMENT' });
  // 4 pages of A4 at 1440 PPI need far more than 85% of 1 GB
  let done = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: 1440 }));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'OUT_OF_MEMORY');
  assert.ok(!/--/.test(done.error.message));
  done = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: 1440, ignoreMemoryLimit: true }));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.ok(done.warnings.some((w) => /more than your computer can spare/.test(w)));
  // the script found no PDF (it prints a message and exits 0)
  fs.rmSync(path.join(outDir, 'big_offset.pdf'), { force: true });
  env.deps.helper = { run: async () => ({ pages: 2, widthIn: 11, heightIn: 8.5, ppi: 300 }) };
  const vanishing = path.join(outDir, 'vanishing.pdf');
  fs.writeFileSync(vanishing, '%PDF');
  const realRun = env.deps.helper.run;
  env.deps.helper.run = async (...a) => {
    const r = await realRun(...a);
    fs.rmSync(vanishing, { force: true }); // deleted while the job runs
    return r;
  };
  done = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: vanishing, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: null }));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'PDF_MISSING');
  // the script ended without writing the output
  process.env.FAKE_NO_OUTPUT = '1';
  env.deps.helper = { run: async () => ({ pages: 2, widthIn: 11, heightIn: 8.5, ppi: 300 }) };
  done = await finished(jobs, offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: null }));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'NO_OUTPUT');
  assert.ok(!fs.readdirSync(outDir).some((n) => n.includes('.partial-')));
  // locked output (read-only stands in for "open in another program")
  delete process.env.FAKE_NO_OUTPUT;
  const lockedOut = path.join(outDir, 'big_offset.pdf');
  fs.writeFileSync(lockedOut, 'old');
  fs.chmodSync(lockedOut, 0o444);
  t.after(() => { try { fs.chmodSync(lockedOut, 0o666); } catch { /* ignore */ } });
  if (process.platform === 'win32' || (process.getuid && process.getuid() !== 0)) { // root ignores file modes
    await assert.rejects(offset.startOffsetJob(env.deps, { pdfPath: src, x_offset: 0, y_offset: 0, angle_offset: 0, ppi: null }), (err) => err.code === 'OUTPUT_LOCKED' && /big_offset\.pdf is open in another program/.test(err.message));
  }
});
