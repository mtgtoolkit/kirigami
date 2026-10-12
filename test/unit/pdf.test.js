'use strict';

/**
 * pdf.js unit tests: argv/display builders, natsort/ordering/chunking (checked against Python
 * natsort 8.4 output), resources math, option parsing, layout resolution, plan scenarios (temp
 * workspace + test/fixtures/introspection.json + a fake helper) and the full job pipeline with the
 * real JobManager and a fake create_pdf.py executed by Node (no Python needed).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const pdf = require('../../src/main/pdf');
const util = require('../../src/main/util');
const { getPaths } = require('../../src/main/paths');
const { DEFAULT_SETTINGS, deepMerge } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');
const FIXTURE = require('../fixtures/introspection.json');

const APP_DIR = path.resolve(__dirname, '..', '..');
const SPEC = FIXTURE.commands.create_pdf.params;
const B = String.fromCharCode(92);
const GB = 1024 ** 3;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

function png(width, height) {
  return util.encodePng(width, height, new Uint8Array(width * height * 4).fill(180));
}

function mkTmp(t, prefix = 'scm-pdf-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  });
  return dir;
}

/** Fixture introspection whose templateFile paths point to real temp files (machine independent). */
function makeIntrospection(root) {
  const data = JSON.parse(JSON.stringify(FIXTURE));
  const tplDir = path.join(root, 'engine', 'cutting_templates');
  fs.mkdirSync(tplDir, { recursive: true });
  for (const layout of [...data.layouts.combos, ...data.layouts.specialty]) {
    if (layout.templateFile) {
      const file = path.join(tplDir, `${layout.template}.studio3`);
      fs.writeFileSync(file, 'studio3');
      layout.templateFile = file;
    }
  }
  return data;
}

const FAKE_CREATE_PDF = String.raw`
const fs = require('fs');
const path = require('path');
const args = Object.create(null);
const skips = [];
const flags = [];
for (const a of process.argv.slice(2)) {
  const m = /^--([^=]+)=([\s\S]*)$/.exec(a);
  if (m) { if (m[1] === 'skip') skips.push(Number(m[2])); else args[m[1]] = m[2]; }
  else if (a.startsWith('--')) flags.push(a.slice(2));
}
function walk(dir, base) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? base + path.sep + e.name : e.name;
    if (e.isDirectory()) out = out.concat(walk(path.join(dir, e.name), rel)); else out.push(rel);
  }
  return out;
}
const fronts = walk(args.front_dir_path, '');
const ds = walk(args.double_sided_dir_path, '');
const backs = fs.readdirSync(args.back_dir_path);
const dsContent = {};
for (const rel of ds) dsContent[rel] = fs.readFileSync(path.join(args.double_sided_dir_path, rel)).subarray(0, 4).toString('hex');
fs.appendFileSync(path.join(process.cwd(), 'fake-runs.jsonl'), JSON.stringify({ argv: process.argv.slice(2), args, skips, flags, fronts, ds, backs, dsContent }) + '\n');
const sleep = Number(process.env.FAKE_SLEEP || 0);
if (sleep) { const end = Date.now() + sleep; while (Date.now() < end) {} }
const lineDelay = Number(process.env.FAKE_LINE_DELAY || 0);
fronts.forEach((f, i) => {
  console.log('Image ' + (i + 1) + ': ' + f);
  if (lineDelay) { const end = Date.now() + lineDelay; while (Date.now() < end) {} }
});
if (process.env.FAKE_FAIL === 'image') {
  const bad = path.join(args.front_dir_path, fronts[fronts.length - 1]);
  console.error('Traceback (most recent call last):');
  console.error('  File "utilities.py", line 1385, in generate_pdf');
  console.error("PIL.UnidentifiedImageError: cannot identify image file '" + bad + "'");
  console.error('');
  console.error('The above exception was the direct cause of the following exception:');
  console.error('');
  console.error('Traceback (most recent call last):');
  console.error('  File "create_pdf.py", line 119, in <module>');
  console.error('OSError: Failed to load front image "' + bad + '": cannot identify image file \'' + bad + "'");
  process.exit(1);
}
if (process.env.FAKE_FAIL) {
  console.error('Traceback (most recent call last):');
  console.error('  File "create_pdf.py", line 1, in <module>');
  console.error('MemoryError');
  process.exit(1);
}
if (flags.includes('load_offset') && process.env.FAKE_NO_OFFSET) console.log('Offset cannot be applied');
const perPage = Number(process.env.FAKE_PER_PAGE || 8) - skips.length;
const sheets = Math.ceil(fronts.length / perPage);
const pages = sheets * (flags.includes('only_fronts') ? 1 : 2);
if (flags.includes('output_images')) {
  for (let i = 1; i <= pages; i++) fs.writeFileSync(path.join(args.output_path, 'page' + i + '.png'), 'png ' + i + ' ' + fronts.join(','));
  console.log('Generated images: ' + args.output_path);
} else {
  fs.writeFileSync(args.output_path, '%PDF-1.4 fake pages=' + pages + ' cards=' + fronts.length);
  console.log('Generated PDF: ' + args.output_path);
}
`;

function walkPosix(dir, base = '') {
  let out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out = out.concat(walkPosix(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

/**
 * A temp workspace + deps. `files` = { 'front/a.png': [w, h] | Buffer | string }.
 * @returns {{ root, ws, deps, settings: () => object, setSettings(patch), runs: () => object[], helperCalls: object[], opened: string[] }}
 */
function setup(t, { files = {}, settings: patch = {}, totalMemBytes = 64 * GB, helper, seams, introspect } = {}) {
  const root = mkTmp(t);
  const ws = path.join(root, 'ws');
  for (const k of ['front', 'back', 'double_sided', 'decklist', 'output', 'upscaled']) fs.mkdirSync(path.join(ws, 'game', k), { recursive: true });
  fs.mkdirSync(path.join(ws, 'data'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'create_pdf.py'), FAKE_CREATE_PDF);
  for (const [rel, spec] of Object.entries(files)) {
    const abs = path.join(ws, 'game', ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Array.isArray(spec) ? png(spec[0], spec[1]) : spec);
  }
  const intro = makeIntrospection(root);
  let current = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), {
    pythonPath: process.execPath,
    upscayl: { enabled: false },
    pdf: { options: { ppi: 300 }, openWhenDone: false },
  });
  current = deepMerge(current, patch);
  const helperCalls = [];
  const opened = [];
  const deps = {
    getPaths: () => getPaths({
      isPackaged: false,
      appDir: APP_DIR,
      userData: path.join(root, 'userdata'),
      platform: process.platform,
      env: { SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: path.join(root, 'data') },
      settings: current,
    }),
    settings: {
      get: () => current,
      update: (p) => {
        current = deepMerge(current, p);
        return current;
      },
    },
    helper: helper || {
      introspect: introspect || (async () => intro),
      run: async (sub, args, opts) => {
        helperCalls.push({ sub, args, opts });
        if (sub === 'list-images') {
          const dir = path.resolve(ws, args[args.indexOf('--dir') + 1]);
          return { files: walkPosix(dir).filter((f) => !f.endsWith('.txt')) };
        }
        if (sub === 'merge-pdfs') {
          const out = args[args.indexOf('--output') + 1];
          const inputs = args.slice(args.indexOf('--inputs') + 1);
          let pages = 0;
          const parts = [];
          for (const input of inputs) {
            const text = fs.readFileSync(input, 'utf8');
            pages += Number(/pages=(\d+)/.exec(text)[1]);
            parts.push(text);
          }
          fs.writeFileSync(out, `%PDF merged pages=${pages}\n${parts.join('\n')}`);
          return { ok: true, pages };
        }
        throw new Error(`unexpected helper call ${sub}`);
      },
    },
    hashCache: null,
    totalMemBytes,
    freeDiskBytes: async () => 500 * GB,
    noAutoOpen: false,
    openPath: async (p) => {
      opened.push(p);
      return '';
    },
    emit: () => {},
    seams: seams || {},
    logger: { info() {}, warn() {}, error() {} },
  };
  return {
    root,
    ws,
    deps,
    intro,
    helperCalls,
    opened,
    settings: () => current,
    runs: () => {
      const file = path.join(ws, 'fake-runs.jsonl');
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
  };
}

function codes(list) {
  return list.map((e) => e.code);
}

function fronts(n, prefix = 'card', size = [63, 88]) {
  const out = {};
  for (let i = 1; i <= n; i += 1) out[`front/${prefix} ${i}.png`] = size;
  return out;
}

// ---------------------------------------------------------------------------------------------
// buildCreatePdfArgv / buildDisplayCommand
// ---------------------------------------------------------------------------------------------

const DIRS = { front: 'game/.stage/j1/c0/front', back: 'game/.stage/j1/back', double_sided: 'game/.stage/j1/c0/double_sided' };

function baseOpts(extra = {}) {
  return { ...pdf.DEFAULT_PDF_OPTIONS, ppi: 300, ...extra };
}

test('argv: --name=value in ParamSpec order, flags only when true, --version skipped', () => {
  const argv = pdf.buildCreatePdfArgv(SPEC, baseOpts({ show_outline: true }), DIRS, 'C:\\out\\deck.pdf');
  assert.equal(argv[0], 'create_pdf.py');
  assert.deepEqual(argv.slice(1, 5), [
    '--front_dir_path=game/.stage/j1/c0/front',
    '--back_dir_path=game/.stage/j1/back',
    '--double_sided_dir_path=game/.stage/j1/c0/double_sided',
    '--output_path=C:\\out\\deck.pdf',
  ]);
  assert.ok(argv.includes('--only_fronts'));
  assert.ok(argv.includes('--show_outline'));
  assert.ok(!argv.includes('--borderless'));
  assert.ok(!argv.includes('--output_images'));
  assert.ok(!argv.some((a) => a.startsWith('--version')));
  assert.ok(!argv.some((a) => /^--(label|fit_backs|crop|specialty|registration_orientation)=/.test(a)), 'null values are omitted');
  // order follows the ParamSpec list
  const names = argv.slice(1).map((a) => a.replace(/^--/, '').split('=')[0]);
  const specOrder = SPEC.map((p) => p.name);
  const idx = names.map((n) => specOrder.indexOf(n));
  assert.deepEqual(idx, idx.slice().sort((a, b) => a - b));
});

test('argv: the first user\'s command is reproduced by the default settings', () => {
  const argv = pdf.buildCreatePdfArgv(SPEC, { ...pdf.DEFAULT_PDF_OPTIONS }, DIRS, 'out.pdf');
  for (const expected of ['--paper_size=a4', '--ppi=1440', '--only_fronts', '--registration=4', '--extend_corners=2mm', '--extend_edges=0.5mm']) {
    assert.ok(argv.includes(expected), `${expected} in ${argv.join(' ')}`);
  }
});

test('argv: skip as repeated --skip=N; registration/ppi/quality always emitted', () => {
  const argv = pdf.buildCreatePdfArgv(SPEC, baseOpts({ registration: null, quality: null }), DIRS, 'o.pdf', { skip: [0, 4] });
  assert.deepEqual(argv.filter((a) => a.startsWith('--skip')), ['--skip=0', '--skip=4']);
  assert.ok(argv.includes('--registration=3'), 'falls back to the engine default');
  assert.ok(argv.includes('--quality=100'));
  assert.ok(argv.includes('--ppi=300'));
});

test('argv: never --load_offset with fronts only', () => {
  const frontsOnly = pdf.buildCreatePdfArgv(SPEC, baseOpts({ load_offset: true, only_fronts: true }), DIRS, 'o.pdf');
  assert.ok(!frontsOnly.includes('--load_offset'));
  const both = pdf.buildCreatePdfArgv(SPEC, baseOpts({ load_offset: true, only_fronts: false }), DIRS, 'o.pdf');
  assert.ok(both.includes('--load_offset'));
  assert.ok(!both.includes('--only_fronts'));
});

test('argv: label part suffix when chunked', () => {
  const withLabel = pdf.buildCreatePdfArgv(SPEC, baseOpts({ label: 'My deck' }), DIRS, 'o.pdf', { part: { index: 2, count: 3 } });
  assert.ok(withLabel.includes('--label=My deck (part 2/3)'));
  const noLabel = pdf.buildCreatePdfArgv(SPEC, baseOpts(), DIRS, 'o.pdf', { part: { index: 1, count: 2 } });
  assert.ok(noLabel.includes('--label=part 1/2'));
  const single = pdf.buildCreatePdfArgv(SPEC, baseOpts({ label: 'My deck' }), DIRS, 'o.pdf', { part: { index: 1, count: 1 } });
  assert.ok(single.includes('--label=My deck'));
  const none = pdf.buildCreatePdfArgv(SPEC, baseOpts(), DIRS, 'o.pdf', { part: { index: 1, count: 1 } });
  assert.ok(!none.some((a) => a.startsWith('--label')));
});

test('argv: only options known to the engine are written; values may start with "-"', () => {
  const argv = pdf.buildCreatePdfArgv(SPEC, baseOpts({ unknown_thing: 'x', label: '-x--y' }), DIRS, 'o.pdf');
  assert.ok(!argv.some((a) => a.includes('unknown_thing')));
  assert.ok(argv.includes('--label=-x--y'));
  assert.throws(() => pdf.buildCreatePdfArgv([], baseOpts(), DIRS, 'o.pdf'), TypeError);
  assert.deepEqual(pdf.buildCreatePdfArgv({ params: SPEC }, baseOpts(), DIRS, 'o.pdf'), pdf.buildCreatePdfArgv(SPEC, baseOpts(), DIRS, 'o.pdf'));
});

test('display command: python create_pdf.py with quoted arguments', () => {
  const text = pdf.buildDisplayCommand(SPEC, baseOpts({ label: 'My deck' }), { front: 'game/front', back: 'game/back', double_sided: 'game/double_sided' }, 'C:\\My Cards\\deck.pdf');
  assert.ok(text.startsWith('python create_pdf.py --front_dir_path=game/front '));
  assert.ok(text.includes('"--output_path=C:\\My Cards\\deck.pdf"'));
  assert.ok(text.includes('"--label=My deck"'));
  assert.ok(text.includes(' --only_fronts '));
});

// ---------------------------------------------------------------------------------------------
// natsort / ordering / chunking
// ---------------------------------------------------------------------------------------------

// Generated with Python natsort 8.4.0 (natsorted) on the engine's venv; '${B}' = backslash.
const NATSORT_INPUT = [
  `card10.png`, `card2.png`, `card1.png`, `Card3.png`, `card 4.png`, `card_5.png`, `x.png`, `x2.png`,
  `x (back face).png`, `x (2).png`, `a1.png`, `a001b.png`, `Zebra.png`, `apple.png`, `\u00c9clair.png`,
  `eclair.png`, `ecl.png`, `f.png`, `10.png`, `9.png`, `1Card1.png`, `1Card10.png`, `1Card2.png`,
  `sub${B}a.png`, `sub a.png`, `sub-a.png`, `sub_a.png`, `subA.png`, `sub${B}b${B}c.png`, `subB.png`,
  `\u{1f600}.png`, `\uffff.png`, `\u00dcn\u00efc\u00f6d\u00e9 3.png`, `\u00dcn\u00efc\u00f6d\u00e9 20.png`, `\u00e4.png`,
  `b.png`, `card 1.png`, `card  1.png`, `card1 .png`, `card.png`, `card.b.png`, `12345678901234567890123.png`,
  `12345678901234567890124.png`, `\u0663.png`, `4.png`, `\uff12.png`, `e\u0301a.png`, `\u00e9b.png`, `x\u00b2.png`,
  `x3.png`, `x1.png`, `Lightning Bolt.png`, `lightning bolt 2.png`, `Island (3).png`, `Island (10).png`,
  `Island.png`, `deck A${B}1.png`, `deck A${B}10.png`, `deck A${B}2.png`, `deck B${B}1 back.png`, `deckA.png`,
  `deck AB.png`, `y1\u00b2.png`, `y12.png`, `y11.png`, `deck A${B}x (back face).png`, `deck A${B}x.png`,
];
const NATSORT_EXPECTED = [
  `1Card1.png`, `1Card2.png`, `1Card10.png`, `\uff12.png`, `\u0663.png`, `4.png`, `9.png`, `10.png`,
  `12345678901234567890123.png`, `12345678901234567890124.png`, `Card3.png`, `\u00c9clair.png`, `Island (3).png`,
  `Island (10).png`, `Island.png`, `Lightning Bolt.png`, `\u00dcn\u00efc\u00f6d\u00e9 3.png`, `\u00dcn\u00efc\u00f6d\u00e9 20.png`,
  `Zebra.png`, `a1.png`, `a001b.png`, `apple.png`, `\u00e4.png`, `b.png`, `card1 .png`, `card1.png`, `card2.png`,
  `card10.png`, `card 1.png`, `card 4.png`, `card  1.png`, `card.b.png`, `card.png`, `card_5.png`, `deck AB.png`,
  `deck A${B}1.png`, `deck A${B}2.png`, `deck A${B}10.png`, `deck A${B}x (back face).png`, `deck A${B}x.png`,
  `deck B${B}1 back.png`, `deckA.png`, `ecl.png`, `eclair.png`, `e\u0301a.png`, `\u00e9b.png`, `f.png`,
  `lightning bolt 2.png`, `sub a.png`, `sub-a.png`, `subA.png`, `subB.png`, `sub${B}a.png`, `sub${B}b${B}c.png`,
  `sub_a.png`, `x1.png`, `x2.png`, `x\u00b2.png`, `x3.png`, `x (2).png`, `x (back face).png`, `x.png`,
  `y1\u00b2.png`, `y11.png`, `y12.png`, `\uffff.png`, `\u{1f600}.png`,
];

test('natsort comparator matches Python natsort 8.4 (NFD, Unicode digits, code point order)', () => {
  assert.equal(NATSORT_INPUT.length, NATSORT_EXPECTED.length);
  const sorted = NATSORT_INPUT.slice().sort(pdf.compareNatsort);
  assert.deepEqual(sorted, NATSORT_EXPECTED);
  // reversed input gives the same result (no dependence on input order for distinct keys)
  assert.deepEqual(NATSORT_INPUT.slice().reverse().sort(pdf.compareNatsort), NATSORT_EXPECTED);
});

test('natsortKey splits text and numbers like natsort', () => {
  assert.deepEqual(pdf.natsortKey('card10.png'), ['card', 10n, '.png']);
  assert.deepEqual(pdf.natsortKey('10.png'), ['', 10n, '.png']);
  assert.deepEqual(pdf.natsortKey('x\u00b23'), ['x', 2n, '', 3n]);
  assert.deepEqual(pdf.natsortKey('\u0663'), ['', 3n]);
  assert.equal(pdf.compareNatsort('a01.png', 'a1.png') !== 0, true, 'equal keys still get a deterministic order');
});

test('orderLikeCreatePdf: single-sided fronts first, then unique backs, natsort on native paths', () => {
  const frontsList = ['b10.png', 'b2.png', 'a.png', 'pair 2.png', 'pair 10.png', 'deck A/1.png', 'deck AB.png'];
  const ds = ['pair 10.png', 'pair 2.png'];
  const order = pdf.orderLikeCreatePdf(frontsList, ds, { sep: '/' });
  assert.deepEqual(order, ['a.png', 'b2.png', 'b10.png', 'deck A/1.png', 'deck AB.png', 'pair 2.png', 'pair 10.png']);
  // Windows: Python sees "deck A\1.png", and "\" sorts after "B"
  const win = pdf.orderLikeCreatePdf(frontsList, ds, { sep: '\\' });
  assert.deepEqual(win.slice(3, 5), ['deck AB.png', 'deck A/1.png']);
  // objects are returned unchanged; DS stems remove same-stem fronts from the single-sided group
  const objs = [{ rel: 'x.png', id: 1 }, { rel: 'y.png', id: 2 }];
  const res = pdf.orderLikeCreatePdf(objs, [objs[0]], { sep: '/' });
  assert.deepEqual(res.map((o) => o.id), [2, 1]);
});

test('chunkCards splits by cards per chunk', () => {
  assert.deepEqual(pdf.chunkCards([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(pdf.chunkCards([1, 2, 3], 10), [[1, 2, 3]]);
  assert.deepEqual(pdf.chunkCards([], 4), []);
  assert.deepEqual(pdf.chunkCards([1, 2], 0), [[1, 2]]);
});

// ---------------------------------------------------------------------------------------------
// resources
// ---------------------------------------------------------------------------------------------

test('resources: A4 page at 1440 PPI is about 601 MB; peak = (pages + 6) x page', () => {
  const r = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, sheets: 13, pagesPerSheet: 1, memoryBudgetPercent: 50, totalMemBytes: 64 * GB });
  assert.equal(r.pageWidthPx, 16833);
  assert.equal(r.pageHeightPx, 11904);
  assert.equal(r.pageBytes, 16833 * 11904 * 3);
  assert.ok(Math.abs(r.pageBytes / 1e6 - 601) < 1);
  assert.equal(r.peakBytes, (13 + 6) * r.pageBytes);
  assert.equal(r.chunks, 1);
  assert.equal(r.pdfBytesEst, Math.round(13 * r.pageBytes * pdf.outputBytesFactor(1440)));
});

test('output size factor: measured JPEG ratios (0.28 at 300 PPI, 0.16 at 600, 0.088–0.128 at 1440)', () => {
  assert.ok(Math.abs(pdf.outputBytesFactor(300) - 0.28) < 1e-9);
  const f600 = pdf.outputBytesFactor(600);
  assert.ok(f600 >= 0.16 && f600 < 0.2, `600 PPI: ${f600}`);
  const f1440 = pdf.outputBytesFactor(1440);
  assert.ok(f1440 >= 0.09 && f1440 <= 0.13, `1440 PPI: ${f1440} (spec: 0.09)`);
  assert.ok(pdf.outputBytesFactor(300, true) > pdf.outputBytesFactor(300));
  assert.ok(pdf.outputBytesFactor(1) <= 0.6 && pdf.outputBytesFactor(100000) >= 0.04, 'clamped');
});

test('resources: chunk size is the largest K whose peak fits the budget', () => {
  const page = 16833 * 11904 * 3;
  const total = 32 * GB;
  const r = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, sheets: 25, pagesPerSheet: 2, memoryBudgetPercent: 50, totalMemBytes: total });
  const budget = Math.floor(total * 0.5);
  const k = r.sheetsPerChunk;
  assert.ok((k * 2 + 6) * page <= budget, 'K fits');
  assert.ok(((k + 1) * 2 + 6) * page > budget, 'K + 1 does not fit');
  assert.equal(r.chunks, Math.ceil(25 / k));
  assert.equal(r.peakBytes, (k * 2 + 6) * page);
  assert.equal(r.overLimit, false);
  // alignment copies every 2nd page: factor 1.5
  const off = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, sheets: 25, pagesPerSheet: 2, loadOffset: true, memoryBudgetPercent: 50, totalMemBytes: total });
  assert.ok(off.sheetsPerChunk <= k);
  assert.equal(off.peakBytes, (off.sheetsPerChunk * 2 * 1.5 + 6) * page);
});

test('resources: 85% error and 50% warning thresholds for one sheet', () => {
  const page = 16833 * 11904 * 3; // ~601 MB
  const small = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, sheets: 3, pagesPerSheet: 2, memoryBudgetPercent: 50, totalMemBytes: 4 * GB });
  assert.equal(small.sheetsPerChunk, 1);
  assert.equal(small.peakBytes, 8 * page);
  assert.equal(small.overLimit, true, '4.8 GB > 85% of 4 GB');
  const mid = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, sheets: 3, pagesPerSheet: 2, memoryBudgetPercent: 50, totalMemBytes: 8 * GB });
  assert.equal(mid.overLimit, false);
  assert.equal(mid.highMemory, true, '4.8 GB > 50% of 8 GB');
  // the budget is capped at 85%
  const capped = pdf.computeResources({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 300, sheets: 1, pagesPerSheet: 1, memoryBudgetPercent: 99, totalMemBytes: 8 * GB });
  assert.equal(capped.budgetBytes, Math.floor(8 * GB * 0.85));
});

test('suggestLowerPpi picks the highest nice PPI that fits', () => {
  const ppi = pdf.suggestLowerPpi({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 1440, pagesPerSheet: 2, limitBytes: 2 * GB });
  assert.ok(ppi && ppi < 1440);
  const ratio = ppi / 300;
  const bytes = Math.floor(3507 * ratio) * Math.floor(2480 * ratio) * 3;
  assert.ok((2 + 6) * bytes <= 2 * GB);
  assert.equal(pdf.suggestLowerPpi({ pageWidthPx300: 3507, pageHeightPx300: 2480, ppi: 300, pagesPerSheet: 2, limitBytes: 1 }), null);
});

test('estimateDuration scales seconds per card by (ppi / lastPpi)^2', () => {
  assert.equal(pdf.estimateDuration({ secPerCard: null, lastPpi: 300, ppi: 300, totalCards: 10, chunks: 1 }), null);
  // 10 cards × 1 s × (600/300)² + 1.5 s Python start-up per run
  assert.equal(pdf.estimateDuration({ secPerCard: 1, lastPpi: 300, ppi: 600, totalCards: 10, chunks: 1 }), 42);
  assert.equal(pdf.estimateDuration({ secPerCard: 1, lastPpi: null, ppi: 600, totalCards: 10, chunks: 2 }), 13);
});

// ---------------------------------------------------------------------------------------------
// options / layout
// ---------------------------------------------------------------------------------------------

test('parseLength: units, percent vs pixels, normalization and invalid input', () => {
  assert.deepEqual(pdf.parseLength('3mm', 'crop'), { ok: true, value: '3mm', amount: 3, unit: 'mm' });
  assert.deepEqual(pdf.parseLength(' 0.125 IN ', 'crop'), { ok: true, value: '0.125in', amount: 0.125, unit: 'in' });
  assert.deepEqual(pdf.parseLength('5', 'crop'), { ok: true, value: '5', amount: 5, unit: '%' });
  assert.deepEqual(pdf.parseLength('5%', 'crop'), { ok: true, value: '5', amount: 5, unit: '%' });
  assert.deepEqual(pdf.parseLength('6', 'extend'), { ok: true, value: '6', amount: 6, unit: 'px' });
  assert.deepEqual(pdf.parseLength('6px', 'extend'), { ok: true, value: '6', amount: 6, unit: 'px' });
  assert.deepEqual(pdf.parseLength('.5mm', 'extend'), { ok: true, value: '.5mm', amount: 0.5, unit: 'mm' });
  assert.deepEqual(pdf.parseLength(null, 'extend'), { ok: true, value: null });
  assert.deepEqual(pdf.parseLength('  ', 'extend'), { ok: true, value: null });
  assert.equal(pdf.parseLength('-3mm', 'crop').reason, 'negative');
  assert.equal(pdf.parseLength('3,5mm', 'crop').reason, 'comma');
  assert.equal(pdf.parseLength('3cm', 'crop').reason, 'format');
  assert.equal(pdf.parseLength('5%', 'extend').ok, false, '% is only for crop');
  assert.equal(pdf.lengthToPx300(pdf.parseLength('2mm', 'extend')), 23);
  assert.equal(pdf.lengthToPx300(pdf.parseLength('0.1in', 'extend')), 30);
  assert.equal(pdf.lengthToPx300(pdf.parseLength('6.9', 'extend')), 6);
  const [px, py] = pdf.cropPercent(pdf.parseLength('3mm', 'crop'), 744, 1039);
  assert.ok(Math.abs(px - (2 * (3 / 25.4)) / (744 / 300) * 100) < 1e-9);
  assert.ok(py < px);
  assert.deepEqual(pdf.cropPercent(pdf.parseLength('7', 'crop'), 744, 1039), [7, 7]);
});

test('normalizeOptions: request > settings > defaults; required options fall back to defaults', () => {
  const settings = deepMerge(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), {
    pdf: { options: { ppi: 600, card_size: 'Japanese', label: 'old' }, fileName: 'saved', printBackFaces: false },
    upscayl: { enabled: false },
  });
  const { opts, extra } = pdf.normalizeOptions(settings, { label: '  Hello\nworld ', ppi: '300', registration: 3, fit: '', crop: 5 });
  assert.equal(opts.ppi, 300);
  assert.equal(opts.card_size, 'japanese');
  assert.equal(opts.label, 'Hello world');
  assert.equal(opts.registration, '3');
  assert.equal(opts.fit, 'stretch', 'empty required option → default');
  assert.equal(opts.crop, '5');
  assert.equal(extra.fileName, 'saved');
  assert.equal(extra.printBackFaces, false);
  assert.equal(extra.upscale, false);
  assert.equal(extra.ackNoTemplate, false);
  const r2 = pdf.normalizeOptions(settings, { fileName: '', upscale: true, outputDir: ' C:\\x ' });
  assert.equal(r2.extra.fileName, null, 'empty name → derived');
  assert.equal(r2.extra.upscale, true);
  assert.equal(r2.extra.outputDir, 'C:\\x');
});

test('resolveLayout: aliases (case-insensitive), specialty, borderless rules', () => {
  const r = pdf.resolveLayout(FIXTURE, { card_size: 'EURO_POKER', paper_size: 'ansi_a', borderless: false, specialty: null });
  assert.equal(r.cardSize, 'standard');
  assert.equal(r.paperSize, 'letter');
  assert.equal(r.layoutKey, 'letter|standard|default');
  assert.equal(r.errors.length, 0);
  const sp = pdf.resolveLayout(FIXTURE, { card_size: 'standard', paper_size: 'a4', specialty: 'A4-Commander', borderless: false });
  assert.equal(sp.layoutKey, 'specialty:a4-commander');
  assert.equal(sp.layout.cardsPerPage, 100);
  const both = pdf.resolveLayout(FIXTURE, { card_size: 'standard', paper_size: 'a4', specialty: 'a4-commander', borderless: true });
  assert.deepEqual(codes(both.errors), ['BORDERLESS_SPECIALTY']);
  for (const paper of ['a3', 'arch_b']) {
    const b = pdf.resolveLayout(FIXTURE, { card_size: 'standard', paper_size: paper, borderless: true, specialty: null });
    assert.ok(codes(b.errors).includes('BORDERLESS_UNSUPPORTED'), paper);
  }
  const unknown = pdf.resolveLayout(FIXTURE, { card_size: 'huge', paper_size: 'a4', borderless: false, specialty: null });
  assert.deepEqual(codes(unknown.errors), ['UNKNOWN_CARD_SIZE']);
  assert.equal(unknown.layout, null);
  const noSpec = pdf.resolveLayout(FIXTURE, { card_size: 'standard', paper_size: 'a4', specialty: 'nope', borderless: false });
  assert.ok(codes(noSpec.errors).includes('UNKNOWN_SPECIALTY'));
});

test('findStemCollisions is exact-case over the whole tree', () => {
  const groups = pdf.findStemCollisions([{ rel: 'a.png', stem: 'a' }, { rel: 'x/a.jpg', stem: 'a' }, { rel: 'A.png', stem: 'A' }, { rel: 'b.png', stem: 'b' }]);
  assert.deepEqual(groups, [{ stem: 'a', files: ['a.png', 'x/a.jpg'] }]);
});

test('summarizeUpscalePlan reads upscayl.planUpscale counts and falls back to item lists', () => {
  const real = { counts: { total: 5, cached: 1, sharp: 2, skipped: 0, upscale: 2, unique: 1 }, secEst: 7, bytesEst: 999, unique: [{ scale: 2 }] };
  assert.deepEqual(pdf.summarizeUpscalePlan(real, 5, 3), { needed: 2, unique: 1, cached: 1, sharp: 2, skipped: 0, secEst: 7, bytesEst: 999 });
  const lists = { items: [{ action: 'sharp' }, { action: 'cached' }, { action: 'upscale', scale: 4 }, { action: 'upscale', scale: 2 }], unique: [{ scale: 4 }, { scale: 2 }] };
  const s = pdf.summarizeUpscalePlan(lists, 4, 3);
  assert.equal(s.needed, 2);
  assert.equal(s.unique, 2);
  assert.equal(s.sharp, 1);
  assert.equal(s.cached, 1);
  assert.equal(s.secEst, 6);
  assert.equal(s.bytesEst, Math.round(15 * 1024 * 1024 * (1 + 0.25)));
});

// ---------------------------------------------------------------------------------------------
// planPdf scenarios
// ---------------------------------------------------------------------------------------------

test('plan: counting fronts only (± back faces) and fronts and backs', async (t) => {
  const env = setup(t, { files: { ...fronts(10), 'double_sided/card 3.png': [63, 88], 'back/back.png': [63, 88] } });
  let plan = await pdf.planPdf(env.deps, { only_fronts: true, printBackFaces: true });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.cards, { fronts: 10, uniqueBacks: 1, faces: 1, total: 11, singles: 10, pairs: 0 });
  assert.equal(plan.perPage, 8);
  assert.equal(plan.sheets, 2);
  assert.equal(plan.pdfPages, 2);
  assert.equal(plan.lastSheetEmpty, 5);
  assert.equal(plan.cardsOnLastSheet, 3);
  assert.ok(codes(plan.notices).includes('BACK_FACES'));
  plan = await pdf.planPdf(env.deps, { only_fronts: true, printBackFaces: false });
  assert.equal(plan.cards.total, 10);
  assert.ok(codes(plan.notices).includes('DS_IGNORED'));
  plan = await pdf.planPdf(env.deps, { only_fronts: false });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.deepEqual(plan.cards, { fronts: 10, uniqueBacks: 1, faces: 0, total: 10, singles: 9, pairs: 1 });
  assert.equal(plan.pdfPages, 4);
  assert.deepEqual(plan.back, { mode: 'auto', file: 'back.png' });
  assert.doesNotThrow(() => structuredClone(plan), 'plan is serializable for IPC');
  assert.equal(JSON.parse(JSON.stringify(plan)).ok, true);
});

test('plan: no fronts and stem collisions are blocking errors with fixes', async (t) => {
  const empty = setup(t);
  let plan = await pdf.planPdf(empty.deps, {});
  assert.equal(plan.ok, false);
  assert.deepEqual(plan.errors.find((e) => e.code === 'NO_FRONTS').fix, { type: 'openCards', tab: 'front' });
  const env = setup(t, {
    files: { 'front/a.png': [63, 88], 'front/sub/a.jpg': [63, 88], 'front/b.png': [63, 88], 'double_sided/c.png': [63, 88], 'double_sided/x/c.png': [63, 88] },
  });
  plan = await pdf.planPdf(env.deps, { only_fronts: true, printBackFaces: true });
  const fixes = plan.errors.filter((e) => e.code === 'STEM_COLLISION').map((e) => e.fix);
  assert.deepEqual(fixes, [{ type: 'fixCollisions', kind: 'front' }, { type: 'fixCollisions', kind: 'double_sided' }]);
  assert.match(plan.errors[0].message, /share the name "a"/);
  // unique backs that are not printed don't block
  plan = await pdf.planPdf(env.deps, { only_fronts: true, printBackFaces: false });
  assert.deepEqual(plan.errors.map((e) => e.fix && e.fix.kind), ['front']);
});

test('plan: unique back without a matching front blocks fronts and backs', async (t) => {
  const env = setup(t, { files: { 'front/a.png': [63, 88], 'front/deck/b.png': [63, 88], 'double_sided/b.png': [63, 88], 'double_sided/deck/b.jpg': [63, 88] } });
  const plan = await pdf.planPdf(env.deps, { only_fronts: false });
  const err = plan.errors.find((e) => e.code === 'DS_WITHOUT_FRONT');
  assert.ok(err, JSON.stringify(plan.errors));
  assert.deepEqual(err.fix, { type: 'openCards', tab: 'double_sided' });
  assert.match(err.message, /"b\.png"/);
  assert.equal(plan.cards.pairs, 1);
});

test('plan: common back problems (choose / missing / none)', async (t) => {
  const env = setup(t, { files: { 'front/a.png': [63, 88], 'back/one.png': [63, 88], 'back/two.png': [63, 88] } });
  let plan = await pdf.planPdf(env.deps, { only_fronts: false });
  assert.deepEqual(plan.errors.find((e) => e.code === 'BACK_CHOOSE').fix, { type: 'chooseBack' });
  env.deps.settings.update({ cards: { back: { mode: 'file', file: 'gone.png' } } });
  plan = await pdf.planPdf(env.deps, { only_fronts: false });
  const missing = plan.errors.find((e) => e.code === 'BACK_MISSING');
  assert.deepEqual(missing.fix, { type: 'chooseBack' });
  assert.match(missing.message, /gone\.png/);
  env.deps.settings.update({ cards: { back: { mode: 'file', file: 'two.png' } } });
  plan = await pdf.planPdf(env.deps, { only_fronts: false });
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.back, { mode: 'file', file: 'two.png' });
  assert.equal(plan.displayEquivalent, false, 'only the chosen back is staged');
  env.deps.settings.update({ cards: { back: { mode: 'none', file: null } } });
  plan = await pdf.planPdf(env.deps, { only_fronts: false });
  assert.ok(codes(plan.notices).includes('NO_BACK'));
  // fronts only never needs a back
  env.deps.settings.update({ cards: { back: { mode: 'auto', file: null } } });
  plan = await pdf.planPdf(env.deps, { only_fronts: true });
  assert.equal(plan.ok, true);
});

test('plan: invalid lengths and limits', async (t) => {
  const env = setup(t, { files: fronts(2) });
  let plan = await pdf.planPdf(env.deps, { crop: '3 cm', extend_edges: '-1mm', extend_bleed: '0,5mm' });
  const lengthErrors = plan.errors.filter((e) => e.code === 'INVALID_LENGTH').map((e) => e.message);
  assert.equal(lengthErrors.length, 3);
  assert.ok(lengthErrors.some((m) => /"Trim image edges"/.test(m)));
  assert.ok(lengthErrors.some((m) => /negative/.test(m)));
  assert.ok(lengthErrors.some((m) => /dot/.test(m)));
  assert.ok(lengthErrors.every((m) => !/--/.test(m)), 'no raw flags in messages');
  plan = await pdf.planPdf(env.deps, { crop: '40mm' });
  assert.ok(codes(plan.errors).includes('CROP_TOO_LARGE'));
  plan = await pdf.planPdf(env.deps, { crop: '20' });
  assert.ok(codes(plan.warnings).includes('CROP_LARGE'));
  assert.equal(plan.ok, true);
  plan = await pdf.planPdf(env.deps, { extend_edges: '40mm' });
  assert.ok(codes(plan.errors).includes('EXTEND_TOO_LARGE'));
  plan = await pdf.planPdf(env.deps, { ppi: 0 });
  assert.ok(codes(plan.errors).includes('INVALID_PPI'));
  plan = await pdf.planPdf(env.deps, { ppi: 3000 });
  assert.ok(codes(plan.errors).includes('INVALID_PPI'));
  plan = await pdf.planPdf(env.deps, { ppi: 100 });
  assert.ok(codes(plan.warnings).includes('LOW_PPI'));
  plan = await pdf.planPdf(env.deps, { quality: 101 });
  assert.ok(codes(plan.errors).includes('INVALID_QUALITY'));
  plan = await pdf.planPdf(env.deps, { label: 'x'.repeat(41), show_outline: true });
  assert.ok(codes(plan.warnings).includes('LABEL_LONG'));
  assert.ok(codes(plan.warnings).includes('SHOW_OUTLINE'));
});

test('plan: borderless + specialty and borderless on A3 / Arch B are errors', async (t) => {
  const env = setup(t, { files: fronts(2) });
  let plan = await pdf.planPdf(env.deps, { borderless: true, specialty: 'a4-commander' });
  assert.ok(codes(plan.errors).includes('BORDERLESS_SPECIALTY'));
  plan = await pdf.planPdf(env.deps, { borderless: true, paper_size: 'a3' });
  assert.ok(codes(plan.errors).includes('BORDERLESS_UNSUPPORTED'));
  plan = await pdf.planPdf(env.deps, { borderless: true, paper_size: 'arch_b' });
  assert.ok(codes(plan.errors).includes('BORDERLESS_UNSUPPORTED'));
  plan = await pdf.planPdf(env.deps, { borderless: true, paper_size: 'letter' });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.equal(plan.layoutKey, 'letter|standard|borderless');
  assert.equal(plan.perPage, 9);
});

test('plan: skip from settings.skipByLayout (dedupe, ignored, all slots)', async (t) => {
  const env = setup(t, { files: fronts(13), settings: { pdf: { skipByLayout: { 'a4|standard|default': [4, 4, 0, 99, -1, 'x'] } } } });
  let plan = await pdf.planPdf(env.deps, {});
  assert.deepEqual(plan.skip, [0, 4]);
  assert.ok(codes(plan.warnings).includes('SKIP_IGNORED'));
  assert.equal(plan.effectivePerSheet, 6);
  assert.equal(plan.sheets, 3);
  assert.equal(plan.lastSheetEmpty, 5);
  assert.ok(plan.display.includes('--skip=0 --skip=4'));
  env.deps.settings.update({ pdf: { skipByLayout: { 'a4|standard|default': [0, 1, 2, 3, 4, 5, 6, 7] } } });
  plan = await pdf.planPdf(env.deps, {});
  assert.ok(codes(plan.errors).includes('SKIP_ALL'));
  // another layout has its own list
  plan = await pdf.planPdf(env.deps, { paper_size: 'letter' });
  assert.deepEqual(plan.skip, []);
});

test('plan: missing cutting template needs "I have my own cutting template"', async (t) => {
  const env = setup(t, { files: fronts(3) });
  let plan = await pdf.planPdf(env.deps, { specialty: 'a4-commander' });
  const err = plan.errors.find((e) => e.code === 'NO_TEMPLATE');
  assert.deepEqual(err.fix, { type: 'ackNoTemplate' });
  assert.equal(plan.requires.ackNoTemplate, true);
  assert.deepEqual(plan.template, { name: 'a4-commander-v1', file: null });
  assert.ok(!/--card_size|--paper_size/.test(plan.display), 'specialty overrides card and paper size');
  assert.ok(plan.display.includes('--specialty=a4-commander'));
  plan = await pdf.planPdf(env.deps, { specialty: 'a4-commander', ackNoTemplate: true });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.ok(codes(plan.warnings).includes('NO_TEMPLATE'));
  plan = await pdf.planPdf(env.deps, {});
  assert.equal(plan.requires.ackNoTemplate, false);
  assert.ok(plan.template.file && fs.existsSync(plan.template.file));
});

test('plan: printer alignment rules', async (t) => {
  const env = setup(t, { files: { 'front/a.png': [63, 88], 'back/b.png': [63, 88] } });
  const dataFile = path.join(env.ws, 'data', 'offset_data.json');
  let plan = await pdf.planPdf(env.deps, { only_fronts: true, load_offset: true });
  assert.ok(codes(plan.notices).includes('LOAD_OFFSET_FRONTS_ONLY'));
  assert.ok(!plan.display.includes('--load_offset'));
  plan = await pdf.planPdf(env.deps, { only_fronts: false, load_offset: true });
  assert.deepEqual(plan.errors.find((e) => e.code === 'OFFSET_MISSING').fix, { type: 'resetOffset' });
  assert.ok(plan.notices.some((n) => n.action && n.action.type === 'openAlignment'));
  fs.writeFileSync(dataFile, '﻿{"x_offset": 1, "y_offset": 2}');
  plan = await pdf.planPdf(env.deps, { only_fronts: false, load_offset: true });
  assert.ok(codes(plan.errors).includes('OFFSET_INVALID'), 'a BOM makes the engine skip the alignment silently');
  fs.writeFileSync(dataFile, '{"x_offset": 1.5, "y_offset": 2}');
  plan = await pdf.planPdf(env.deps, { only_fronts: false, load_offset: true });
  assert.deepEqual(plan.errors.find((e) => e.code === 'OFFSET_INVALID').fix, { type: 'resetOffset' });
  fs.writeFileSync(dataFile, '{"x_offset": 12, "y_offset": -3, "angle_offset": 0.2}');
  plan = await pdf.planPdf(env.deps, { only_fronts: false, load_offset: true });
  assert.equal(plan.ok, true, JSON.stringify(plan.errors));
  assert.ok(plan.display.includes('--load_offset'));
  plan = await pdf.planPdf(env.deps, { only_fronts: false, load_offset: false });
  assert.deepEqual(plan.notices.find((n) => n.code === 'OFFSET_NOT_APPLIED').action, { type: 'setLoadOffset', value: true });
});

test('plan: memory limit error with a lower PPI fix, chunking notice, "Create anyway"', async (t) => {
  const env = setup(t, { files: fronts(20), totalMemBytes: 4 * GB });
  let plan = await pdf.planPdf(env.deps, { ppi: 1440 });
  const err = plan.errors.find((e) => e.code === 'OUT_OF_MEMORY');
  assert.ok(err, JSON.stringify(plan.errors));
  assert.equal(err.fix.type, 'lowerPpi');
  assert.ok(err.fix.ppi < 1440);
  assert.ok(err.message.includes(`${err.fix.ppi} PPI`));
  assert.equal(plan.requires.ignoreMemoryLimit, true);
  plan = await pdf.planPdf(env.deps, { ppi: 1440, ignoreMemoryLimit: true });
  assert.ok(!codes(plan.errors).includes('OUT_OF_MEMORY'));
  assert.ok(codes(plan.warnings).includes('MEMORY_IGNORED'));
  plan = await pdf.planPdf(env.deps, { ppi: err.fix.ppi });
  assert.ok(!codes(plan.errors).includes('OUT_OF_MEMORY'), JSON.stringify(plan.errors));
  // tiny budget → parts
  env.deps.settings.update({ pdf: { memoryBudgetPercent: 1 } });
  plan = await pdf.planPdf(env.deps, { ppi: 300 });
  assert.ok(plan.resources.chunks > 1, JSON.stringify(plan.resources));
  assert.ok(codes(plan.notices).includes('CHUNKED'));
  assert.equal(plan.displayEquivalent, false);
  assert.match(plan.displayNote, /parts/);
});

test('plan: disk space check', async (t) => {
  const env = setup(t, { files: fronts(8) });
  env.deps.freeDiskBytes = async () => 1000;
  const plan = await pdf.planPdf(env.deps, {});
  assert.ok(codes(plan.errors).includes('DISK_FULL'));
});

test('plan: output naming, replace notice with "Keep both", PNG pages folder', async (t) => {
  const env = setup(t, { files: fronts(2), settings: { fetch: { lastFetched: { plugin: 'mtg', format: 'mtga', deckName: 'My: Deck?', at: 'x', added: 2 } } } });
  let plan = await pdf.planPdf(env.deps, {});
  assert.equal(plan.output.fileName, 'My Deck.pdf');
  assert.equal(plan.output.exists, false);
  plan = await pdf.planPdf(env.deps, { fileName: 'proxies.PDF' });
  assert.equal(plan.output.fileName, 'proxies.pdf');
  const outDir = path.join(env.ws, 'game', 'output');
  fs.writeFileSync(path.join(outDir, 'proxies.pdf'), '%PDF old');
  plan = await pdf.planPdf(env.deps, { fileName: 'proxies' });
  assert.equal(plan.output.exists, true);
  assert.ok(Number.isFinite(plan.output.existingMtime));
  const replace = plan.notices.find((n) => n.code === 'WILL_REPLACE');
  assert.deepEqual(replace.action, { type: 'keepBoth', fileName: 'proxies (2).pdf' });
  assert.match(replace.message, /Will replace proxies\.pdf/);
  plan = await pdf.planPdf(env.deps, { fileName: 'proxies (2).pdf' });
  assert.equal(plan.output.exists, false);
  // PNG pages
  plan = await pdf.planPdf(env.deps, { fileName: 'pages', output_images: true });
  assert.equal(plan.output.isImages, true);
  assert.equal(plan.output.path, path.join(outDir, 'pages'));
  fs.mkdirSync(path.join(outDir, 'pages'));
  fs.writeFileSync(path.join(outDir, 'pages', 'page1.png'), 'x');
  plan = await pdf.planPdf(env.deps, { fileName: 'pages', output_images: true });
  assert.deepEqual(plan.notices.find((n) => n.code === 'WILL_REPLACE').action, { type: 'keepBoth', fileName: 'pages (2)' });
  // output folder inside the card folders is refused
  plan = await pdf.planPdf(env.deps, { outputDir: path.join(env.ws, 'game', 'front', 'out') });
  assert.ok(codes(plan.errors).includes('OUTPUT_IN_CARDS'));
  plan = await pdf.planPdf(env.deps, { outputDir: 'relative\\folder' });
  assert.ok(codes(plan.errors).includes('OUTPUT_DIR_INVALID'));
});

test('plan: equivalent command line uses the source folders', async (t) => {
  const env = setup(t, { files: fronts(3) });
  const plan = await pdf.planPdf(env.deps, {});
  assert.equal(plan.displayEquivalent, true);
  assert.equal(plan.displayNote, null);
  assert.ok(plan.display.startsWith('python create_pdf.py --front_dir_path=game/front --back_dir_path=game/back --double_sided_dir_path=game/double_sided'));
  assert.equal(plan.displayCwd, env.ws);
  const withDs = setup(t, { files: { ...fronts(2), 'double_sided/card 1.png': [63, 88] } });
  const faces = await pdf.planPdf(withDs.deps, { only_fronts: true, printBackFaces: true });
  assert.equal(faces.displayEquivalent, false);
  assert.match(faces.displayNote, /back faces/);
});

test('plan: recommended settings for the last downloaded game', async (t) => {
  const env = setup(t, { files: fronts(2), settings: { fetch: { lastFetched: { plugin: 'yugioh', format: 'ydk', deckName: 'deck', at: 'x', added: 2 } } } });
  let plan = await pdf.planPdf(env.deps, { card_size: 'standard' });
  const rec = plan.notices.find((n) => n.code === 'RECOMMENDED_SETTINGS');
  assert.ok(rec, JSON.stringify(plan.notices));
  assert.deepEqual(rec.action, { type: 'applyRecommended', options: { card_size: 'japanese' } });
  assert.match(rec.message, /Japanese size \(59 x 86 mm\)/);
  plan = await pdf.planPdf(env.deps, { card_size: 'japanese' });
  assert.ok(!codes(plan.notices).includes('RECOMMENDED_SETTINGS'));
});

test('plan: low resolution and stretched pictures hints', async (t) => {
  const env = setup(t, { files: { 'front/small.png': [63, 88], 'front/wide.png': [400, 200] } });
  const plan = await pdf.planPdf(env.deps, {});
  assert.deepEqual(plan.warnings.find((w) => w.code === 'LOW_RESOLUTION').action, { type: 'openUpscale' });
  const aspect = plan.warnings.find((w) => w.code === 'ASPECT_MISMATCH');
  assert.deepEqual(aspect.action, { type: 'applyRecommended', options: { fit: 'crop' } });
  assert.match(aspect.message, /^1 picture has/);
});

test('plan: upscale estimate through upscayl.planUpscale (seam)', async (t) => {
  const calls = [];
  const fake = {
    getUpscaylStatus: async () => ({ found: true, modelsDir: 'M', models: [] }),
    loadManifest: () => ({ version: 2, entries: {} }),
    planUpscale: (input) => {
      calls.push(input);
      return { counts: { total: input.items.length, cached: 0, sharp: 0, skipped: 0, upscale: input.items.length, unique: 1 }, secEst: 3, bytesEst: 1234, unique: [{ scale: 4 }] };
    },
  };
  const env = setup(t, { files: fronts(3), seams: { upscayl: fake } });
  let plan = await pdf.planPdf(env.deps, { upscale: true });
  assert.deepEqual(plan.upscale, { enabled: true, available: true, needed: 3, unique: 1, cached: 0, sharp: 0, secEst: 3, bytesEst: 1234 });
  assert.equal(calls[0].targetPpi, 300);
  assert.ok(Math.abs(calls[0].cardWidthIn - 63 / 25.4) < 1e-9);
  assert.ok(calls[0].items.every((i) => i.kind === 'front' && /^[0-9a-f]{40}$/.test(i.hash)), 'items are hashed');
  assert.equal(plan.displayEquivalent, false);
  plan = await pdf.planPdf(env.deps, { upscale: false });
  assert.equal(plan.upscale, null);
  const missing = setup(t, { files: fronts(1), seams: { upscayl: { getUpscaylStatus: async () => ({ found: false }) } } });
  plan = await pdf.planPdf(missing.deps, { upscale: true });
  assert.equal(plan.upscale.available, false);
  assert.match(plan.upscale.reason, /not installed/);
});

test('plan: not ready when the components are missing', async (t) => {
  const env = setup(t, {
    files: fronts(1),
    introspect: async () => {
      throw Object.assign(new Error("NOT_READY: the card maker components aren't ready yet."), { code: 'NOT_READY' });
    },
  });
  const plan = await pdf.planPdf(env.deps, {});
  assert.equal(plan.ok, false);
  assert.deepEqual(codes(plan.errors), ['NOT_READY']);
  assert.doesNotThrow(() => structuredClone(plan));
});

// ---------------------------------------------------------------------------------------------
// moveIntoPlace / lockedCode
// ---------------------------------------------------------------------------------------------

test('moveIntoPlace retries locked destinations then falls back to "<name> (2)"', async (t) => {
  const dir = mkTmp(t);
  const dest = path.join(dir, 'deck.pdf');
  fs.writeFileSync(dest, 'old');
  let calls = 0;
  const flaky = {
    rename: async (src, to) => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return fsp.rename(src, to);
    },
  };
  fs.writeFileSync(path.join(dir, 'a.partial'), 'new');
  const ok = await pdf.moveIntoPlace(path.join(dir, 'a.partial'), dest, { fsImpl: flaky, sleep: async () => {} });
  assert.deepEqual(ok, { path: dest, fallback: false });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'new');
  const locked = {
    rename: async (src, to) => {
      if (to === dest) throw Object.assign(new Error('perm'), { code: 'EPERM' });
      return fsp.rename(src, to);
    },
  };
  fs.writeFileSync(path.join(dir, 'b.partial'), 'newer');
  const fb = await pdf.moveIntoPlace(path.join(dir, 'b.partial'), dest, { fsImpl: locked, sleep: async () => {}, retries: 2 });
  assert.deepEqual(fb, { path: path.join(dir, 'deck (2).pdf'), fallback: true });
  assert.equal(fs.readFileSync(fb.path, 'utf8'), 'newer');
  const broken = { rename: async () => { throw Object.assign(new Error('nope'), { code: 'ENOENT' }); } };
  await assert.rejects(pdf.moveIntoPlace('x', dest, { fsImpl: broken, sleep: async () => {} }), /nope/);
});

test('lockedCode reports write-protected files and ignores missing ones', async (t) => {
  const dir = mkTmp(t);
  assert.equal(await pdf.lockedCode(path.join(dir, 'missing.pdf')), null);
  const file = path.join(dir, 'ro.pdf');
  fs.writeFileSync(file, 'x');
  assert.equal(await pdf.lockedCode(file), null);
  fs.chmodSync(file, 0o444);
  t.after(() => { try { fs.chmodSync(file, 0o666); } catch { /* ignore */ } });
  if (process.platform === 'win32' || process.getuid?.() !== 0) {
    assert.ok(['EPERM', 'EACCES'].includes(await pdf.lockedCode(file)));
  }
});

// ---------------------------------------------------------------------------------------------
// startPdfJob (real JobManager, fake create_pdf.py run by Node)
// ---------------------------------------------------------------------------------------------

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

function attachJobs(t, env) {
  const jobs = new JobManager({ logsDir: null, scmCacheDir: path.join(env.root, 'data', 'scm-cache'), cancelGraceMs: 10000 });
  const events = [];
  jobs.on('event', (e) => events.push(e));
  env.deps.jobs = jobs;
  t.after(() => jobs.dispose());
  return { jobs, events };
}

function leftovers(env) {
  const out = path.join(env.ws, 'game', 'output');
  return {
    stage: fs.existsSync(path.join(env.ws, 'game', '.stage')) ? walkPosix(path.join(env.ws, 'game', '.stage')) : [],
    partials: fs.readdirSync(out).filter((n) => n.includes('.partial-')),
  };
}

test('job: fronts only → one run, staged copies, PDF saved, last PDF + auto-open', async (t) => {
  // 120 ms per "Image N:" line so the throttled (≤ 10/s) progress events carry the card labels
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined, FAKE_LINE_DELAY: 120 });
  const env = setup(t, { files: { ...fronts(10), 'back/back.png': [63, 88] }, settings: { pdf: { openWhenDone: true } } });
  const { jobs, events } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const result = done.result;
  const final = path.join(env.ws, 'game', 'output', 'proxies.pdf');
  assert.equal(result.pdfPath, final);
  assert.match(fs.readFileSync(final, 'utf8'), /pages=2 cards=10/);
  assert.equal(result.pages, 2);
  assert.equal(result.sheets, 2);
  assert.equal(result.chunks, 1);
  assert.equal(result.cards, 10);
  assert.equal(result.template.name, 'a4-standard-v5');
  const runs = env.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fronts.length, 10);
  assert.deepEqual(runs[0].backs, [], 'fronts only: empty staged back folder');
  assert.deepEqual(runs[0].ds, []);
  assert.ok(runs[0].flags.includes('only_fronts'));
  assert.ok(!runs[0].args.label);
  assert.match(runs[0].args.front_dir_path, new RegExp(`^game/\\.stage/${jobId}/c0/front$`));
  assert.ok(runs[0].argv.every((a) => a === 'create_pdf.py' || /^--[a-z_]+(=|$)/.test(a)), 'only --name=value arguments');
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
  const last = env.settings().pdf.lastPdf;
  assert.equal(last.path, final);
  assert.equal(last.ppi, 300);
  assert.equal(last.pages, 2);
  assert.equal(last.onlyFronts, true);
  assert.equal(last.loadOffset, false);
  // measured from the first "Image 1:" line to "Generated PDF:" (≈ 9 × 120 ms for 10 cards)
  const spc = env.settings().pdf.secPerCard;
  assert.ok(spc > 0.05 && spc < 1, `secPerCard ${spc}`);
  assert.deepEqual(env.opened, [final]);
  const progress = events.filter((e) => e.type === 'progress' && e.jobId === jobId);
  assert.ok(progress.some((p) => /Card \d+ of 10/.test(p.label || '')), 'progress from Image N lines');
  assert.ok(progress.some((p) => p.percent === null && /Saving the PDF/.test(p.label || '')));
  // the list-images sanity check ran once on the whole stage folder
  assert.deepEqual(env.helperCalls.map((c) => c.sub), ['list-images']);
});

test('job: chunked rendering keeps create_pdf order across parts and merges losslessly', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined });
  const files = {};
  for (let i = 1; i <= 20; i += 1) files[`front/c${i}.png`] = [63, 88];
  const env = setup(t, { files, totalMemBytes: 1e9, settings: { pdf: { memoryBudgetPercent: 20, options: { label: 'Deck' } } } });
  const plan = await pdf.planPdf(env.deps, {});
  assert.equal(plan.resources.sheetsPerChunk, 1);
  assert.equal(plan.resources.chunks, 3);
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const runs = env.runs();
  assert.equal(runs.length, 3);
  const expected = Array.from({ length: 20 }, (_, i) => `c${i + 1}.png`); // natsort order
  assert.deepEqual(runs.map((r) => r.fronts.slice().sort(pdf.compareNatsort)), [expected.slice(0, 8), expected.slice(8, 16), expected.slice(16)]);
  assert.deepEqual(runs.map((r) => r.args.label), ['Deck (part 1/3)', 'Deck (part 2/3)', 'Deck (part 3/3)']);
  const merge = env.helperCalls.find((c) => c.sub === 'merge-pdfs');
  const inputs = merge.args.slice(merge.args.indexOf('--inputs') + 1);
  assert.deepEqual(inputs.map((p) => path.basename(p)), [1, 2, 3].map((i) => `.proxies.partial-${jobId}-${i}.pdf`));
  assert.equal(done.result.pages, 3);
  assert.equal(done.result.chunks, 3);
  assert.match(fs.readFileSync(done.result.pdfPath, 'utf8'), /merged pages=3/);
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
});

test('job: fronts and backs stage unique backs under the front name and exactly one common back', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined, FAKE_NO_OFFSET: '1' });
  const env = setup(t, {
    files: {
      'front/a.png': [63, 88], 'front/sub/b.jpg': [63, 88], 'front/c.png': [63, 88],
      'double_sided/sub/b.png': [63, 88],
      'back/one.png': [63, 88], 'back/two.png': [63, 88],
    },
    settings: { cards: { back: { mode: 'file', file: 'two.png' } }, pdf: { skipByLayout: { 'a4|standard|default': [0] } } },
  });
  fs.writeFileSync(path.join(env.ws, 'data', 'offset_data.json'), '{"x_offset": 3, "y_offset": 4, "angle_offset": 0}');
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, { only_fronts: false, load_offset: true });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const [run] = env.runs();
  assert.deepEqual(run.backs, ['two.png']);
  assert.deepEqual(run.ds, [`sub${path.sep}b.jpg`], 'unique back staged under the front name (front extension)');
  assert.equal(run.dsContent[`sub${path.sep}b.jpg`], '89504e47', 'with the unique back PNG content');
  assert.deepEqual(run.skips, [0]);
  assert.ok(run.flags.includes('load_offset'));
  assert.ok(!run.flags.includes('only_fronts'));
  assert.equal(done.result.pages, 2);
  assert.ok(done.warnings.some((w) => /alignment could not be applied/.test(w)), 'stdout notice → warning');
  assert.ok(done.result.warnings.some((w) => /alignment could not be applied/.test(w)));
  assert.equal(env.settings().pdf.lastPdf.loadOffset, true);
});

test('job: faces mode prints unique backs as extra cards', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined });
  const env = setup(t, { files: { 'front/x.png': [63, 88], 'front/y.png': [63, 88], 'double_sided/x.jpg': [63, 88] } });
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, { only_fronts: true, printBackFaces: true });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const [run] = env.runs();
  assert.deepEqual(run.fronts.slice().sort(), ['x (back face).jpg', 'x.png', 'y.png']);
  assert.deepEqual(run.ds, []);
  assert.equal(done.result.cards, 3);
});

test('job: PNG pages are collected in their own folder, replacing older pages', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined });
  const files = {};
  for (let i = 1; i <= 12; i += 1) files[`front/p${i}.png`] = [63, 88];
  const env = setup(t, { files, totalMemBytes: 1e9, settings: { pdf: { memoryBudgetPercent: 20 } } });
  const folder = path.join(env.ws, 'game', 'output', 'pages');
  fs.mkdirSync(folder, { recursive: true });
  for (let i = 1; i <= 5; i += 1) fs.writeFileSync(path.join(folder, `page${i}.png`), 'old');
  fs.writeFileSync(path.join(folder, 'notes.txt'), 'keep me');
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, { output_images: true, fileName: 'pages' });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.equal(done.result.isImages, true);
  assert.equal(done.result.pdfPath, null);
  assert.equal(done.result.outputPath, folder);
  assert.equal(done.result.chunks, 2);
  const names = fs.readdirSync(folder).sort();
  assert.deepEqual(names, ['notes.txt', 'page1.png', 'page2.png']);
  assert.match(fs.readFileSync(path.join(folder, 'page2.png'), 'utf8'), /^png 1 /, 'page 2 = first page of part 2');
  assert.equal(env.settings().pdf.lastPdf, null, 'PNG pages are not a PDF to print');
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
});

test('job: a failing create_pdf run is reported in plain words and cleaned up', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: '1', FAKE_SLEEP: undefined });
  const env = setup(t, { files: fronts(3) });
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'OUT_OF_MEMORY');
  assert.ok(!/Traceback/.test(done.error.message));
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
  assert.equal(env.settings().pdf.lastPdf, null);
});

test('job: cancel stops the run and removes temporary files', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: '4000' });
  const env = setup(t, { files: fronts(3) });
  const { jobs, events } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (events.some((e) => e.type === 'step' && e.stepId === 'render' && e.status === 'running')) {
        clearInterval(timer);
        resolve();
      }
    }, 20);
  });
  await new Promise((r) => setTimeout(r, 300));
  jobs.cancel(jobId);
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
  assert.ok(!fs.existsSync(path.join(env.ws, 'game', 'output', 'proxies.pdf')));
});

test('startPdfJob rejects invalid plans, busy apps and locked outputs (no job)', async (t) => {
  const empty = setup(t);
  attachJobs(t, empty);
  await assert.rejects(pdf.startPdfJob(empty.deps, {}), /no card fronts/i);
  const env = setup(t, { files: fronts(2) });
  env.deps.jobs = { active: () => ({ title: 'Downloading cards' }), start: () => { throw new Error('should not start'); } };
  await assert.rejects(pdf.startPdfJob(env.deps, {}), /^Error: BUSY: wait until "Downloading cards" finishes$/);
  const locked = setup(t, { files: fronts(2) });
  const { jobs } = attachJobs(t, locked);
  const final = path.join(locked.ws, 'game', 'output', 'proxies.pdf');
  fs.writeFileSync(final, '%PDF old');
  fs.chmodSync(final, 0o444); // read-only stands in for "open in another program"
  t.after(() => { try { fs.chmodSync(final, 0o666); } catch { /* ignore */ } });
  if (process.platform === 'win32' || (process.getuid && process.getuid() !== 0)) { // root ignores file modes
    await assert.rejects(pdf.startPdfJob(locked.deps, {}), /proxies\.pdf is open in another program/);
    assert.equal(jobs.active(), null);
    assert.equal(jobs.history().length, 0);
  }
});

test('job: list-images mismatch becomes a warning naming the skipped pictures', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined });
  const env = setup(t, { files: fronts(3) });
  const realRun = env.deps.helper.run;
  env.deps.helper.run = async (sub, args, opts) => {
    const res = await realRun(sub, args, opts);
    if (sub === 'list-images') res.files = res.files.filter((f) => !f.endsWith('card 2.png'));
    return res;
  };
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded');
  assert.ok(done.result.warnings.some((w) => /couldn't read 1 picture/.test(w) && /"card 2\.png"/.test(w)), JSON.stringify(done.result.warnings));
});

test('job: a damaged picture is named by its own file name, not the staged copy', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: 'image', FAKE_SLEEP: undefined, FAKE_LINE_DELAY: undefined });
  const env = setup(t, { files: { 'front/a.png': [63, 88], 'front/deck/z broken.png': [63, 88] } });
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, {});
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'BAD_IMAGE');
  assert.equal(done.error.message, 'The picture "deck/z broken.png" in your card fronts is damaged, not an image, or too large. Remove or replace it, then try again.');
  assert.ok(/UnidentifiedImageError/.test(done.error.details), 'technical details are kept for the log');
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
});

test('job: a picture deleted while the PDF is prepared is named in plain words', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined, FAKE_LINE_DELAY: undefined });
  const env = setup(t, { files: { 'front/a.png': [63, 88], 'front/sub/b.png': [63, 88] } });
  env.deps.seams.upscayl = {
    getUpscaylStatus: async () => ({ found: true, models: [] }),
    loadManifest: () => ({ version: 2, entries: {} }),
    planUpscale: (input) => ({ counts: { total: input.items.length, cached: 0, sharp: input.items.length, skipped: 0, upscale: 0, unique: 0 }, secEst: 0, bytesEst: 0 }),
    // runs between planning and staging: the user deletes a card meanwhile
    runUpscale: async () => {
      fs.rmSync(path.join(env.ws, 'game', 'front', 'sub', 'b.png'));
      return { total: 2, unique: 0, upscaled: 0, cached: 0, sharp: 2, fallbacks: 0, durationMs: 1, files: {} };
    },
  };
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, { upscale: true });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'CARD_MISSING');
  assert.equal(done.error.message, 'The picture "sub/b.png" in your card fronts was moved or deleted while the PDF was being prepared. Check your cards and try again.');
  assert.deepEqual(leftovers(env), { stage: [], partials: [] });
});

test('explainRenderFailure maps staged paths back to the user\'s pictures (and leaves other errors alone)', () => {
  const staged = new Map([
    ['c1/front/sub/x.png', { rel: 'sub/x.jpg', kind: 'front' }],
    ['c1/double_sided/sub/x.png', { rel: 'sub/x.png', kind: 'double_sided' }],
    ['back/b.png', { rel: 'b.png', kind: 'back' }],
  ]);
  const mk = (stderr, stdout = []) => Object.assign(new Error('The card maker exited with code 1'), {
    name: 'JobProcessError', code: 1, exitCode: 1, stderrTail: stderr, stdoutTail: stdout, command: 'python create_pdf.py',
  });
  const where = { staged, stageRel: 'game/.stage/j9', chunkIndex: 1 };
  const ds = pdf.explainRenderFailure(mk([
    'Traceback (most recent call last):',
    `OSError: Failed to load double-sided image "game\\.stage\\j9\\c1\\double_sided\\sub\\x.png": cannot identify image file`,
  ]), where);
  assert.equal(ds.code, 'BAD_IMAGE');
  assert.match(ds.message, /^The picture "sub\/x\.png" in your unique backs is damaged/);
  const back = pdf.explainRenderFailure(mk([
    'Traceback (most recent call last):',
    `OSError: Failed to load back image "C:/ws/game/.stage/j9/back/b.png": [Errno 13] Permission denied: 'b.png'`,
  ]), where);
  assert.equal(back.code, 'FILE_LOCKED');
  assert.match(back.message, /"b\.png" in your common back/);
  // no path in the error: the last "Image N:" line names the card
  const byLine = pdf.explainRenderFailure(mk(['Traceback (most recent call last):', 'PIL.Image.DecompressionBombError: Image size (200000000 pixels) exceeds limit'], ['Image 1: a.png', 'Image 2: sub\\x.png']), where);
  assert.equal(byLine.code, 'BAD_IMAGE');
  assert.match(byLine.message, /"sub\/x\.jpg" in your card fronts/);
  // other failures are returned unchanged (jobs.js words them)
  const oom = mk(['Traceback (most recent call last):', 'MemoryError']);
  assert.equal(pdf.explainRenderFailure(oom, where), oom);
  const friendly = Object.assign(new Error('x'), { friendly: true });
  assert.equal(pdf.explainRenderFailure(friendly, where), friendly);
  assert.equal(pdf.stagedSource(staged, 'game/.stage/j9', 'game/.stage/j10/back/b.png'), null, 'another job\'s folder is not matched');
});

test('job: upscale step uses the files map from upscayl.runUpscale (seam)', async (t) => {
  withEnv(t, { FAKE_PER_PAGE: 8, FAKE_FAIL: undefined, FAKE_SLEEP: undefined });
  const env = setup(t, { files: { 'front/a.jpg': [63, 88], 'front/b.png': [63, 88] } });
  const upDir = path.join(env.ws, 'game', 'upscaled', 'front');
  fs.mkdirSync(upDir, { recursive: true });
  fs.writeFileSync(path.join(upDir, 'a.png'), png(252, 352));
  const calls = [];
  env.deps.seams.upscayl = {
    getUpscaylStatus: async () => ({ found: true, models: [] }),
    loadManifest: () => ({ version: 2, entries: {} }),
    planUpscale: (input) => ({ counts: { total: input.items.length, cached: 0, sharp: 1, skipped: 0, upscale: 1, unique: 1 }, secEst: 3, bytesEst: 10 }),
    runUpscale: async (ctx, deps, opts) => {
      calls.push(opts);
      ctx.warn('Could not upscale b.png; the original image will be used.');
      return { total: 2, unique: 1, upscaled: 1, cached: 0, sharp: 0, fallbacks: 1, durationMs: 5, files: { front: { 'a.jpg': path.join(upDir, 'a.png') } } };
    },
  };
  const { jobs } = attachJobs(t, env);
  const { jobId } = await pdf.startPdfJob(env.deps, { upscale: true });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(calls[0].kinds, ['front']);
  assert.equal(calls[0].targetPpi, 300);
  const [run] = env.runs();
  assert.deepEqual(run.fronts.slice().sort(), ['a.png', 'b.png'], 'upscaled copy staged with its own extension');
  assert.deepEqual(done.result.upscaled, { total: 2, unique: 1, upscaled: 1, cached: 0, sharp: 0, fallbacks: 1, durationMs: 5 });
  assert.ok(done.result.warnings.some((w) => /Could not upscale b\.png/.test(w)), 'warnings raised while upscaling are kept');
});
