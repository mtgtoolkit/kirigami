'use strict';

/**
 * Unit tests for src/main/upscayl.js: pure planner / argument builder / parsers / detection order,
 * plus the whole runUpscale pipeline and the job starters against FAKES (a fake upscayl-bin behind
 * ctx.spawn, a fake scm_helper that decodes the PNGs this file writes, a fake job manager).
 * The real Upscayl + Python path is covered by test/integration/upscayl.int.js.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const util = require('../../src/main/util');
const { getPaths } = require('../../src/main/paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');
const { createHashCache } = require('../../src/main/scan');
const { decodePath } = require('../../src/main/img-url');
const up = require('../../src/main/upscayl');

const APP_DIR = path.resolve(__dirname, '..', '..');
const BIN_NAME = process.platform === 'win32' ? 'upscayl-bin.exe' : 'upscayl-bin';
const CARD_W_IN = 63 / 25.4;

// Real upscayl-bin stderr captured on this machine (French locale: ',' decimal separator, CRLF).
const REAL_STDERR = [
  '[0 NVIDIA GeForce RTX 4080 SUPER]  queueC=2[8]  queueG=0[16]  queueT=1[2]',
  '[0 NVIDIA GeForce RTX 4080 SUPER]  bugsbn1=0  bugbilz=153  bugcopc=0  bugihfa=0',
  '[0 NVIDIA GeForce RTX 4080 SUPER]  fp16-p/s/a=1/1/1  int8-p/s/a=1/1/1',
  '[0 NVIDIA GeForce RTX 4080 SUPER]  subgroup=32  basic=1  vote=1  ballot=1  shuffle=1',
  '[1 AMD Radeon(TM) Graphics]  queueC=1[2]  queueG=0[1]  queueT=2[1]',
  '[1 AMD Radeon(TM) Graphics]  bugsbn1=0  bugbilz=0  bugcopc=0  bugihfa=0',
  '[1 AMD Radeon(TM) Graphics]  fp16-p/s/a=1/1/1  int8-p/s/a=1/1/1',
  '[1 AMD Radeon(TM) Graphics]  subgroup=64  basic=1  vote=1  ballot=1  shuffle=1',
  '0,00%',
  '4,17%',
  '45,83%',
  '95,83%',
  '\u{1F3DE}\uFE0F Resizing image according to output scale',
  '\u{1F3DE}\uFE0F Resized image from 734x1024 to 2936x4096',
  '100.00',
  '',
  '\u{1F64C} Upscayled Successfully!',
].join('\r\n') + '\r\n';

// ---------------------------------------------------------------------------------------------
// Tiny PNG helpers (the encoder is util.encodePng: RGBA, filter 0 — the decoder handles exactly that)
// ---------------------------------------------------------------------------------------------

function makeImage(width, height, pixel) {
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return { width, height, rgba };
}

function pngBytes(img) {
  return util.encodePng(img.width, img.height, img.rgba);
}

function writePng(file, img) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, pngBytes(img));
}

const pattern = (seed) => (x, y) => [(x * 7 + seed * 31) % 256, (y * 5 + seed * 17) % 256, ((x + y) * 3 + seed * 11) % 256];

function decodePng(buf) {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error('cannot identify image file');
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 6) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height || !idat.length) throw new Error('truncated PNG');
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) raw.copy(rgba, y * stride, y * (stride + 1) + 1, (y + 1) * (stride + 1));
  return { width, height, rgba };
}

function grayStats(img) {
  let sum = 0;
  let sq = 0;
  const n = img.width * img.height;
  for (let i = 0; i < n; i += 1) {
    const v = 0.299 * img.rgba[i * 4] + 0.587 * img.rgba[i * 4 + 1] + 0.114 * img.rgba[i * 4 + 2];
    sum += v;
    sq += v * v;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

function scaleImage(img, s, black) {
  const w = img.width * s;
  const h = img.height * s;
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const d = (y * w + x) * 4;
      const src = (Math.floor(y / s) * img.width + Math.floor(x / s)) * 4;
      for (let c = 0; c < 3; c += 1) rgba[d + c] = black ? 0 : img.rgba[src + c];
      rgba[d + 3] = 255;
    }
  }
  return { width: w, height: h, rgba };
}

function cancelledError() {
  const e = new Error('Cancelled');
  e.name = 'CancelledError';
  e.code = 'CANCELLED';
  return e;
}

// ---------------------------------------------------------------------------------------------
// Fakes: scm_helper, upscayl-bin (behind ctx.spawn), job context, job manager
// ---------------------------------------------------------------------------------------------

/** Fake scm_helper: prepare-upscale / validate-images with the same rules as the Python helper. */
function makeFakeHelper() {
  const helper = {
    calls: [],
    async run(sub, args, opts = {}) {
      helper.calls.push({ sub, items: opts.list && opts.list.items });
      if (opts.signal && opts.signal.aborted) throw cancelledError();
      if (sub === 'prepare-upscale') {
        return {
          results: opts.list.items.map(({ src, dest }) => {
            try {
              const img = decodePng(fs.readFileSync(src));
              fs.mkdirSync(path.dirname(dest), { recursive: true });
              fs.writeFileSync(dest, pngBytes(img));
              const st = grayStats(img);
              return { src, dest, ok: true, width: img.width, height: img.height, sniffed: 'png', mean: st.mean, std: st.std, error: null };
            } catch (err) {
              return { src, dest, ok: false, width: null, height: null, sniffed: null, mean: null, std: null, error: err.message };
            }
          }),
        };
      }
      if (sub === 'validate-images') {
        return {
          results: opts.list.items.map((it) => {
            if (!fs.existsSync(it.path)) return { path: it.path, ok: false, reason: 'file not found' };
            let img;
            try {
              img = decodePng(fs.readFileSync(it.path));
            } catch (err) {
              return { path: it.path, ok: false, reason: `unreadable: ${err.message}` };
            }
            const st = grayStats(img);
            const reasons = [];
            if (Math.abs(img.width - it.expectWidth) > 2) reasons.push(`width ${img.width} instead of ${it.expectWidth}`);
            if (Math.abs(img.height - it.expectHeight) > 2) reasons.push(`height ${img.height} instead of ${it.expectHeight}`);
            if (st.std < 0.5 && it.refStd >= 2) reasons.push('blank image');
            if (Math.abs(st.mean - it.refMean) > 40) reasons.push(`brightness ${st.mean.toFixed(1)} instead of about ${it.refMean.toFixed(1)}`);
            return { path: it.path, ok: !reasons.length, width: img.width, height: img.height, mean: st.mean, std: st.std, reason: reasons.join('; ') || null };
          }),
        };
      }
      throw new Error(`unexpected helper command ${sub}`);
    },
    async introspect() {
      throw Object.assign(new Error('NOT_READY: not in unit tests'), { code: 'NOT_READY' });
    },
  };
  return helper;
}

const GPU_LINES = REAL_STDERR.split('\r\n').filter((l) => l.startsWith('['));

function parseArgs(args) {
  const a = {};
  for (let i = 0; i < args.length; i += 1) {
    const flag = args[i];
    if (flag === '-x') {
      a.x = true;
      continue;
    }
    if (/^-[a-z]$/.test(flag)) {
      a[flag.slice(1)] = args[i + 1];
      i += 1;
    }
  }
  return a;
}

/**
 * Fake upscayl-bin. Modes: ok | black (silent black images) | vk (black + "vkQueueSubmit failed")
 * | flaky (first image of each folder run black, single images fine) | nostart | modelerr.
 */
function makeFakeUpscayl(state) {
  return async (cmd, args, opts = {}) => {
    const a = parseArgs(args);
    const call = { cmd, args, a, dir: fs.existsSync(a.i) && fs.statSync(a.i).isDirectory() };
    state.calls.push(call);
    if (state.beforeSpawn) await state.beforeSpawn(call, state.calls.length);
    if (state.mode === 'nostart') {
      throw Object.assign(new Error('Windows or your antivirus blocked Upscayl.'), { code: 'START_BLOCKED', friendly: true });
    }
    const emit = (l) => { if (opts.onLine) opts.onLine(l, 'stderr'); };
    const tail = [];
    for (const l of (state.gpuLines || GPU_LINES)) emit(l);
    const jobsList = call.dir
      ? fs.readdirSync(a.i).filter((n) => n.endsWith('.png')).sort().map((n) => [path.join(a.i, n), path.join(a.o, n.replace(/\.png$/, `.${a.f}`))])
      : [[a.i, a.o]];
    if (call.dir) fs.mkdirSync(a.o, { recursive: true });
    let k = 0;
    for (const [src, dest] of jobsList) {
      if (state.mode === 'modelerr') {
        const line = '\u{1F6A8} Error: Failed to open models/upscayl-standard-4x.param';
        emit(line);
        tail.push(line);
        continue;
      }
      const black = state.mode === 'black' || state.mode === 'vk' || (state.mode === 'flaky' && call.dir && k === 0);
      const img = decodePng(fs.readFileSync(src));
      const out = scaleImage(img, Number(a.s), black);
      fs.writeFileSync(dest, pngBytes(out));
      if (state.mode === 'vk') {
        emit('vkQueueSubmit failed -4');
        tail.push('vkQueueSubmit failed -4');
      }
      for (const l of ['0,00%', '50,00%', '100.00', '\u{1F64C} Upscayled Successfully!']) emit(l);
      k += 1;
    }
    return { code: state.mode === 'modelerr' ? 4294967295 : 0, signal: null, stdoutTail: [], stderrTail: tail, durationMs: 4, pid: 4242 };
  };
}

/** Job context like jobs.js's (closures, no `this`). */
function makeCtx(spawn, { kind = 'upscale', jobId = 'job1' } = {}) {
  const ac = new AbortController();
  const rec = { logs: [], progress: [], steps: [], warnings: [] };
  const ctx = {
    jobId,
    kind,
    signal: ac.signal,
    get cancelled() { return ac.signal.aborted; },
    log: (line, stream = 'info') => { rec.logs.push({ line: String(line), stream }); },
    progress: (p) => { rec.progress.push(p); },
    step: (id, status) => { rec.steps.push(`${id}:${status}`); },
    warn: (msg) => { const t = String(msg); if (!rec.warnings.includes(t)) rec.warnings.push(t); },
    throwIfCancelled: () => { if (ac.signal.aborted) throw cancelledError(); },
    spawn: (cmd, args, opts) => (ac.signal.aborted ? Promise.reject(cancelledError()) : spawn(cmd, args, opts)),
  };
  return { ctx, rec, cancel: () => ac.abort() };
}

/** Fake JobManager: runs the executor with a fake ctx; whenFinished(id) → summary. */
function makeFakeJobs(spawn) {
  const jobs = new Map();
  let active = null;
  let n = 0;
  return {
    started: [],
    active: () => active,
    isMutating: () => !!active,
    start(kind, opts, executor) {
      if (active) throw Object.assign(new Error(`BUSY: ${active.title}`), { code: 'BUSY' });
      n += 1;
      const id = `fakejob${n}`;
      const { ctx, rec } = makeCtx(spawn, { kind, jobId: id });
      active = { jobId: id, kind, title: opts.title };
      this.started.push({ id, kind, opts });
      const promise = Promise.resolve().then(() => executor(ctx)).then(
        (result) => ({ status: 'succeeded', result, error: null, rec }),
        (err) => ({ status: err && err.code === 'CANCELLED' ? 'cancelled' : 'failed', result: null, error: err, rec }),
      ).then((summary) => {
        active = null;
        return { ...summary, warnings: rec.warnings };
      });
      jobs.set(id, promise);
      return id;
    },
    whenFinished: (id) => jobs.get(id),
  };
}

/**
 * Temp workspace + userData + fake Upscayl install, deps built from the real paths / settings /
 * scan modules.
 */
function makeEnv(t, { mode = 'ok', models = ['upscayl-standard-4x', 'upscayl-lite-4x'], settings: patch = {}, bin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-upscayl-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const ws = path.join(root, 'ws');
  for (const k of ['front', 'back', 'double_sided', 'upscaled']) fs.mkdirSync(path.join(ws, 'game', k), { recursive: true });
  const userData = path.join(root, 'userData');
  const dataDir = path.join(root, 'data');
  const installRoot = path.join(root, 'Upscayl');
  const binPath = path.join(installRoot, 'resources', 'bin', BIN_NAME);
  const modelsDir = path.join(installRoot, 'resources', 'models');
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  if (bin) fs.writeFileSync(binPath, 'fake');
  for (const id of models) {
    fs.writeFileSync(path.join(modelsDir, `${id}.param`), 'p');
    fs.writeFileSync(path.join(modelsDir, `${id}.bin`), 'b'.repeat(id.includes('lite') ? 10 : 100));
  }
  const settings = createSettingsStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 5, onError: () => {} });
  settings.update({ pdf: { options: { ppi: 300 } }, ...patch });
  const state = { mode, calls: [], beforeSpawn: null };
  const spawn = makeFakeUpscayl(state);
  const emitted = [];
  const deps = {
    settings,
    getPaths: () => getPaths({
      isPackaged: false, appDir: APP_DIR, userData, env: { SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: dataDir }, settings: settings.get(), platform: process.platform,
    }),
    helper: makeFakeHelper(),
    hashCache: createHashCache(null),
    logger: { info() {}, warn() {}, error() {} },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    addShutdownHook: () => () => {},
    seams: { env: { SCM_UPSCAYL_BIN: binPath }, platform: process.platform, registry: { queryUninstall: async () => [] } },
  };
  deps.jobs = makeFakeJobs(spawn);
  const paths = deps.getPaths();
  return {
    root, ws, deps, state, spawn, settings, emitted, binPath, modelsDir, paths,
    front: (rel) => path.join(ws, 'game', 'front', ...rel.split('/')),
    kindFile: (kind, rel) => path.join(ws, 'game', kind, ...rel.split('/')),
    upscaled: (rel) => path.join(paths.upscaledRoot, ...rel.split('/')),
    manifest: () => JSON.parse(fs.readFileSync(path.join(paths.upscaledRoot, 'manifest.json'), 'utf8')),
    run: async (opts) => {
      const { ctx, rec, cancel } = makeCtx(spawn);
      const result = await up.runUpscale(ctx, deps, { targetPpi: 300, cardWidthIn: CARD_W_IN, ...opts });
      return { result, rec, cancel };
    },
  };
}

function dims(file) {
  const img = decodePng(fs.readFileSync(file));
  return [img.width, img.height];
}

// ---------------------------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------------------------

test('parseGpuLines reads both GPUs from real upscayl-bin stderr (deduplicated, sorted)', () => {
  const expected = [{ id: 0, name: 'NVIDIA GeForce RTX 4080 SUPER' }, { id: 1, name: 'AMD Radeon(TM) Graphics' }];
  assert.deepEqual(up.parseGpuLines(REAL_STDERR), expected);
  assert.deepEqual(up.parseGpuLines(REAL_STDERR.split('\r\n').reverse()), expected);
  assert.deepEqual(up.parseGpuLines(['  [2 Intel(R) Arc(TM) A770 Graphics]  queueC=1[1]']), [{ id: 2, name: 'Intel(R) Arc(TM) A770 Graphics' }]);
  assert.deepEqual(up.parseGpuLines(''), []);
  assert.deepEqual(up.parseGpuLines(null), []);
  assert.deepEqual(up.parseGpuLines(['100.00', '45,83%', '[x not a gpu]']), []);
});

test('parsePercent understands the locale decimal comma, the final bare 100.00 and ignores other lines', () => {
  const lines = REAL_STDERR.split('\r\n');
  const values = lines.map((l) => up.parsePercent(l)).filter((v) => v !== null);
  assert.deepEqual(values, [0, 4.17, 45.83, 95.83, 100]);
  assert.equal(up.parsePercent('50.00%'), 50);
  assert.equal(up.parsePercent(' 12,5% '), 12.5);
  assert.equal(up.parsePercent('100%'), 100);
  assert.equal(up.parsePercent('150%'), null);
  assert.equal(up.parsePercent('\u{1F3DE}\uFE0F Resized image from 734x1024 to 2936x4096'), null);
  assert.equal(up.parsePercent(GPU_LINES[0]), null);
  assert.equal(up.parsePercent(''), null);
  assert.equal(up.parsePercent(undefined), null);
});

test('the GPU failure pattern matches Vulkan errors only', () => {
  for (const l of ['vkQueueSubmit failed -4', 'vkCreateInstance failed -9', 'vkAllocateMemory failed', 'invalid gpu device']) assert.ok(up.VK_FAILURE_RE.test(l), l);
  for (const l of ['\u{1F64C} Upscayled Successfully!', '45,83%', GPU_LINES[0]]) assert.ok(!up.VK_FAILURE_RE.test(l), l);
});

test('model scale comes from <digit>x, else x<digit>, else 4', () => {
  const cases = {
    'upscayl-standard-4x': 4,
    'digital-art-4x': 4,
    '4x_NMKD-Siax_200k': 4,
    '2x-AniScale': 2,
    'realesr-animevideov3-x2': 2,
    'realesr-animevideov3-x3': 3,
    RealESRGAN_General_x4_v3: 4,
    '4xLSDIR': 4,
    plainmodel: 4,
    '': 4,
  };
  for (const [id, scale] of Object.entries(cases)) assert.equal(up.modelScaleFromName(id), scale, id);
});

// ---------------------------------------------------------------------------------------------
// Argument builder
// ---------------------------------------------------------------------------------------------

test('buildUpscaylArgs: base order matches the spec', () => {
  assert.deepEqual(up.buildUpscaylArgs({ input: 'in', output: 'out', modelsDir: 'M', model: 'upscayl-standard-4x' }),
    ['-i', 'in', '-o', 'out', '-m', 'M', '-n', 'upscayl-standard-4x', '-z', '4', '-s', '4', '-f', 'png']);
  assert.deepEqual(up.buildUpscaylArgs({ input: 'a.png', output: 'b.jpg', modelsDir: 'M', model: 'm-x2', modelScale: 2, scale: 3, format: 'jpeg' }),
    ['-i', 'a.png', '-o', 'b.jpg', '-m', 'M', '-n', 'm-x2', '-z', '2', '-s', '3', '-f', 'jpg']);
});

test('buildUpscaylArgs: optional flags in order, only when they apply', () => {
  assert.deepEqual(up.buildUpscaylArgs({
    input: 'i', output: 'o', modelsDir: 'M', model: 'n', format: 'webp', compression: 80, tileSize: 128, gpuId: '1', threads: '1:2:2', tta: true,
  }), ['-i', 'i', '-o', 'o', '-m', 'M', '-n', 'n', '-z', '4', '-s', '4', '-f', 'webp', '-c', '80', '-t', '128', '-g', '1', '-j', '1:2:2', '-x']);
  const base = { input: 'i', output: 'o', modelsDir: 'M', model: 'n' };
  const tail = (o) => up.buildUpscaylArgs({ ...base, ...o }).slice(14);
  assert.deepEqual(tail({ format: 'png', compression: 80 }), [], 'compression only for WebP');
  assert.deepEqual(tail({ format: 'webp' }), ['-c', '0']);
  assert.deepEqual(tail({ format: 'webp', compression: 250 }), ['-c', '100']);
  assert.deepEqual(tail({ gpuId: 'auto' }), []);
  assert.deepEqual(tail({ gpuId: 0 }), ['-g', '0']);
  assert.deepEqual(tail({ gpuId: '0,1' }), ['-g', '0,1']);
  assert.deepEqual(tail({ gpuId: 'nvidia' }), []);
  assert.deepEqual(tail({ tileSize: 0 }), []);
  assert.deepEqual(tail({ tileSize: 16 }), [], 'tiles below 32 are refused by upscayl-bin');
  assert.deepEqual(tail({ tileSize: '256' }), ['-t', '256']);
  assert.deepEqual(tail({ threads: '' }), []);
  assert.deepEqual(tail({ threads: 'abc' }), []);
  assert.deepEqual(tail({ threads: '1:2,2:2' }), ['-j', '1:2,2:2']);
  assert.deepEqual(tail({ tta: 'yes' }), [], 'only a real true enables TTA');
  assert.deepEqual(up.buildUpscaylArgs({ ...base, scale: 5, modelScale: 0, format: 'gif' }).slice(8, 14), ['-z', '4', '-s', '4', '-f', 'png']);
  assert.throws(() => up.buildUpscaylArgs({ input: 'i', output: 'o', modelsDir: 'M' }), TypeError);
});

// ---------------------------------------------------------------------------------------------
// Scale choice and planner
// ---------------------------------------------------------------------------------------------

const scaleOf = (o) => up.chooseScale({ cardWidthIn: CARD_W_IN, maxScale: 4, smart: true, ...o });

test('smart scale: 745 px card → 4× at 1440 PPI, 2× at 600 PPI, already sharp at 300 PPI', () => {
  assert.deepEqual(pick(scaleOf({ width: 745, height: 1040, targetPpi: 1440 })), { action: 'upscale', scale: 4 });
  assert.deepEqual(pick(scaleOf({ width: 745, height: 1040, targetPpi: 600 })), { action: 'upscale', scale: 2 });
  assert.deepEqual(pick(scaleOf({ width: 745, height: 1040, targetPpi: 300 })), { action: 'sharp', scale: 1 });
  assert.equal(Math.round(scaleOf({ width: 745, height: 1040, targetPpi: 300 }).effPpi), 300);
  assert.deepEqual(pick(scaleOf({ width: 733, height: 1024, targetPpi: 600 })), { action: 'upscale', scale: 3 });
  assert.deepEqual(pick(scaleOf({ width: 469, height: 656, targetPpi: 600 })), { action: 'upscale', scale: 4 });
  assert.deepEqual(pick(scaleOf({ width: 469, height: 656, targetPpi: 600, maxScale: 3 })), { action: 'upscale', scale: 3 }, 'never above the max scale');
  assert.deepEqual(pick(scaleOf({ width: 469, height: 656, targetPpi: 300 })), { action: 'upscale', scale: 2 });
  assert.deepEqual(pick(scaleOf({ width: 745, height: 1040, targetPpi: 300, smart: false })), { action: 'upscale', scale: 4 }, 'not smart: always the max');
  assert.deepEqual(pick(scaleOf({ width: 745, height: 1040, targetPpi: 300, smart: false, maxScale: 2 })), { action: 'upscale', scale: 2 });
  assert.deepEqual(pick(scaleOf({ width: null, height: null, targetPpi: 300 })), { action: 'upscale', scale: 4 }, 'unknown size: max scale');
});

function pick(c) {
  return { action: c.action, scale: c.scale };
}

test('the 89 MP cap lowers the scale (minimum 2×), else the original is used', () => {
  assert.equal(up.MAX_UPSCALED_PIXELS, 89000000);
  // 2500 × 3500 × 4² = 140 MP → 3× = 78.75 MP
  assert.deepEqual(pick(scaleOf({ width: 2500, height: 3500, targetPpi: 2400, smart: false })), { action: 'upscale', scale: 3 });
  // 4000 × 5600 × 2² = 89.6 MP → too big even at 2×
  const big = scaleOf({ width: 4000, height: 5600, targetPpi: 2400, smart: false });
  assert.deepEqual(pick(big), { action: 'sharp', scale: 1 });
  assert.equal(big.reason, 'too_large');
  assert.equal(up.capScale(4, 2500, 3500), 3);
  assert.equal(up.capScale(4, 745, 1040), 4);
  assert.equal(up.capScale(3, 4000, 5600), null);
});

function item(kind, rel, hash, { width = 400, height = 560, type = 'png' } = {}) {
  const relNoExt = rel.replace(/\.[^./]+$/, '');
  return { kind, rel, relNoExt, abs: `/cards/${kind}/${rel}`, name: rel.split('/').pop(), hash, type, width, height };
}

const H = (c) => c.repeat(40);
const STATUS = { models: [{ id: 'upscayl-standard-4x', dir: path.resolve('/up/resources/models'), custom: false }, { id: 'upscayl-lite-4x', dir: path.resolve('/up/resources/models'), custom: false }] };

test('planUpscale de-duplicates identical images (also across kinds) and counts everything', () => {
  const plan = up.planUpscale({
    items: [
      item('front', 'a.png', H('a')),
      item('front', 'sub/a copy.png', H('a')),
      item('front', 'b.png', H('b')),
      item('double_sided', 'z.png', H('a')),
      item('front', 'sharp.png', H('c'), { width: 800, height: 1120 }),
      item('front', 'nohash.png', null),
    ],
    settings: { scale: 4, smartScale: true, secPerImage: 2.5 },
    targetPpi: 300,
    cardWidthIn: CARD_W_IN,
    status: STATUS,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.unique.length, 2);
  const g = plan.unique.find((x) => x.hash === H('a'));
  assert.deepEqual(g.items.map((i) => `${i.kind}/${i.rel}`), ['front/a.png', 'front/sub/a copy.png', 'double_sided/z.png']);
  assert.equal(g.scale, 2);
  assert.deepEqual(plan.counts, { total: 6, cached: 0, sharp: 1, skipped: 1, upscale: 4, unique: 2, stale: 0 });
  assert.equal(plan.items.find((i) => i.rel === 'nohash.png').reason, 'unreadable');
  assert.equal(plan.items.find((i) => i.rel === 'sharp.png').key, null);
  assert.equal(plan.secEst, 5);
  assert.ok(plan.bytesEst > 0);
  assert.equal(plan.model, 'upscayl-standard-4x');
  const dir = path.resolve('/up/resources/models');
  assert.equal(plan.modelsDirUsed, process.platform === 'win32' ? dir.toLowerCase() : dir, 'model folder from the status, comparable form');
  assert.ok(g.key.includes(`|${plan.modelsDirUsed}|`));
});

test('planUpscale: cached only when the manifest key matches AND the file exists; stale files listed for processed kinds', () => {
  const base = { settings: { scale: 4 }, targetPpi: 300, cardWidthIn: CARD_W_IN, status: STATUS };
  const items = [item('front', 'a.png', H('a')), item('front', 'b.png', H('b')), item('front', 'c.png', H('c'))];
  const first = up.planUpscale({ ...base, items });
  const keyOf = (rel) => first.items.find((i) => i.rel === rel).key;
  const manifest = {
    entries: {
      'front/a.png': { key: keyOf('a.png'), src: 'a.png', kind: 'front' },
      'front/b.png': { key: keyOf('b.png').replace('upscayl-standard-4x', 'upscayl-lite-4x'), src: 'b.png', kind: 'front' },
      'front/c.png': { key: keyOf('c.png'), src: 'c.png', kind: 'front' },
    },
  };
  const plan = up.planUpscale({
    ...base, items, manifest, existingFiles: new Set(['front/a.png', 'front/b.png', 'front/old.png', 'double_sided/x.png']), kinds: ['front'],
  });
  const action = (rel) => plan.items.find((i) => i.rel === rel).action;
  assert.equal(action('a.png'), 'cached');
  assert.equal(action('b.png'), 'upscale', 'other model → not cached');
  assert.equal(action('c.png'), 'upscale', 'file missing → not cached');
  assert.deepEqual(plan.stale, ['front/old.png'], 'other kinds are never stale');
  assert.equal(plan.counts.cached, 1);
  // Without existingFiles the manifest is trusted.
  assert.equal(up.planUpscale({ ...base, items, manifest }).items.find((i) => i.rel === 'c.png').action, 'cached');
  // A different print resolution changes the planned scale → the key → not cached.
  const at600 = up.planUpscale({ ...base, targetPpi: 600, items, manifest, existingFiles: ['front/a.png'] });
  assert.equal(at600.items.find((i) => i.rel === 'a.png').action, 'upscale');
});

test('planUpscale: output format "same" keeps PNG/JPEG/WebP, the rest becomes PNG; explicit formats win', () => {
  const items = [
    item('front', 'p.png', H('1'), { type: 'png' }),
    item('front', 'j.jpeg', H('2'), { type: 'jpeg' }),
    item('front', 'w.webp', H('3'), { type: 'webp' }),
    item('front', 'g.gif', H('4'), { type: 'gif' }),
    item('front', 'b.bmp', H('5'), { type: 'bmp' }),
    item('front', 't.tif', H('6'), { type: 'tiff' }),
  ];
  const base = { items, targetPpi: 300, cardWidthIn: CARD_W_IN, status: STATUS };
  const same = up.planUpscale({ ...base, settings: { format: 'same' } });
  assert.deepEqual(same.items.map((i) => i.destRel), ['front/p.png', 'front/j.jpg', 'front/w.webp', 'front/g.png', 'front/b.png', 'front/t.png']);
  const jpg = up.planUpscale({ ...base, settings: { format: 'jpg' } });
  assert.ok(jpg.items.every((i) => i.outExt === 'jpg'));
  assert.deepEqual(up.planUpscale({ ...base, settings: { format: 'jpeg' } }).items.map((i) => i.outExt), Array(6).fill('jpg'));
  const webp = up.planUpscale({ ...base, settings: { format: 'webp', compression: 80 } });
  assert.match(webp.items[0].key, /\|webp\|c80\|tta0$/);
  assert.match(up.planUpscale({ ...base, settings: { format: 'png', compression: 80 } }).items[0].key, /\|png\|c0\|tta0$/, 'compression only counts for WebP');
  assert.match(up.planUpscale({ ...base, settings: { tta: true } }).items[0].key, /\|tta1$/);
});

test('planUpscale: name clashes are reported and skipped (same upscaled file / same card name)', () => {
  const base = { targetPpi: 300, cardWidthIn: CARD_W_IN, status: STATUS, caseInsensitive: true };
  const sameFile = up.planUpscale({ ...base, settings: { format: 'png' }, items: [item('front', 'a.png', H('1')), item('front', 'a.jpg', H('2'), { type: 'jpeg' }), item('front', 'b.png', H('3'))] });
  assert.equal(sameFile.ok, false);
  assert.deepEqual(sameFile.errors.map((e) => [e.code, e.files]), [['name_collision', ['a.png', 'a.jpg']]]);
  assert.match(sameFile.errors[0].message, /^"a\.png" and "a\.jpg" would get the same upscaled file name/);
  assert.deepEqual(sameFile.skipped.map((i) => i.rel), ['a.png', 'a.jpg']);
  assert.equal(sameFile.unique.length, 1);
  const sameStem = up.planUpscale({ ...base, settings: { format: 'same' }, items: [item('front', 'x/a.png', H('1')), item('front', 'y/a.png', H('2')), item('front', 'a.jpg', H('3'), { type: 'jpeg' })] });
  assert.deepEqual(sameStem.errors.map((e) => e.code), ['stem_collision']);
  assert.match(sameStem.errors[0].message, /share the name "a"/);
  assert.equal(sameStem.unique.length, 0);
  const caseOnly = up.planUpscale({ ...base, settings: { format: 'png' }, items: [item('front', 'A.png', H('1')), item('front', 'a.jpg', H('2'), { type: 'jpeg' })] });
  assert.deepEqual(caseOnly.errors.map((e) => e.code), ['name_collision'], 'same file on a case-insensitive disk');
  const otherKinds = up.planUpscale({ ...base, settings: { format: 'png' }, items: [item('front', 'a.png', H('1')), item('double_sided', 'a.png', H('2'))] });
  assert.equal(otherKinds.ok, true, 'fronts and unique backs live in different folders');
});

test('planUpscale: images whose size is unknown get a context suffix so their cache stays exact', () => {
  const base = { settings: { scale: 4 }, cardWidthIn: CARD_W_IN, status: STATUS };
  const known = up.planUpscale({ ...base, targetPpi: 300, items: [item('front', 'k.png', H('1'))] }).items[0];
  assert.match(known.key, /\|tta0$/, 'no suffix when the size is known');
  const u300 = up.planUpscale({ ...base, targetPpi: 300, items: [item('front', 'u.png', H('1'), { width: null, height: null })] }).items[0];
  const u600 = up.planUpscale({ ...base, targetPpi: 600, items: [item('front', 'u.png', H('1'), { width: null, height: null })] }).items[0];
  assert.equal(u300.scale, 4);
  assert.match(u300.key, /\|tta0\|u1p300w\d+$/);
  assert.notEqual(u300.key, u600.key);
  const notSmart = up.planUpscale({ ...base, settings: { smartScale: false }, targetPpi: 300, items: [item('front', 'u.png', H('1'), { width: null, height: null })] }).items[0];
  assert.match(notSmart.key, /\|u0$/);
});

test('keys: wildcard models folder (Upscayl not detected yet) matches any folder', () => {
  const plan = up.planUpscale({ items: [item('front', 'a.png', H('a'))], settings: {}, targetPpi: 300, cardWidthIn: CARD_W_IN });
  const key = plan.items[0].key;
  assert.match(key, /\|upscayl-standard-4x\|\*\|s2\|png\|c0\|tta0$/);
  assert.equal(up.keyMatches(`${H('a')}|upscayl-standard-4x|c:\\up\\models|s2|png|c0|tta0`, key), true);
  assert.equal(up.keyMatches(`${H('a')}|upscayl-standard-4x|c:\\up\\models|s4|png|c0|tta0`, key), false);
  assert.equal(up.keyMatches(`${H('a')}|upscayl-lite-4x|c:\\up\\models|s2|png|c0|tta0`, key), false);
  assert.equal(up.keyMatches(`${H('b')}|upscayl-standard-4x|c:\\up\\models|s2|png|c0|tta0`, key), false);
  assert.equal(up.keyMatches('a|b|c', 'a|b|c'), true);
  assert.equal(up.keyMatches('a|b|c', 'a|b|d'), false);
  assert.equal(up.keyMatches(null, 'x'), false);
  assert.equal(up.makeKey({ hash: 'h', model: 'm', modelsDirUsed: 'd', scale: 3, outExt: 'webp', compression: 55, tta: false }), 'h|m|d|s3|webp|c55|tta0');
});

test('chunkGroups keeps one output format and scale per chunk', () => {
  const groups = [];
  for (let i = 0; i < 30; i += 1) groups.push({ id: `p${i}`, outExt: 'png', scale: 4 });
  for (let i = 0; i < 5; i += 1) groups.push({ id: `j${i}`, outExt: 'jpg', scale: 4 });
  groups.splice(3, 0, { id: 's2a', outExt: 'png', scale: 2 }, { id: 's2b', outExt: 'png', scale: 2 });
  const chunks = up.chunkGroups(groups, 24);
  assert.deepEqual(chunks.map((c) => c.length), [24, 6, 2, 5]);
  for (const c of chunks) assert.equal(new Set(c.map((g) => `${g.outExt}|${g.scale}`)).size, 1);
  assert.equal(up.chunkGroups([], 24).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

test('resolveModel: configured model, else standard → high-fidelity → digital-art → any (with a warning)', () => {
  const m = (ids, custom = false) => ({ models: ids.map((id) => ({ id, custom })) });
  assert.equal(up.resolveModel(m(['upscayl-lite-4x', 'upscayl-standard-4x']), 'upscayl-lite-4x').id, 'upscayl-lite-4x');
  assert.equal(up.resolveModel(m(['upscayl-lite-4x', 'upscayl-standard-4x']), 'upscayl-lite-4x').warning, null);
  const fb = up.resolveModel(m(['upscayl-lite-4x', 'upscayl-standard-4x']), 'gone-4x');
  assert.equal(fb.id, 'upscayl-standard-4x');
  assert.match(fb.warning, /"gone 4x" isn't available, so "Upscayl Standard" was used instead/);
  assert.equal(up.resolveModel(m(['digital-art-4x', 'high-fidelity-4x']), 'x').id, 'high-fidelity-4x');
  assert.equal(up.resolveModel(m(['ultrasharp-4x', 'digital-art-4x']), 'x').id, 'digital-art-4x');
  assert.equal(up.resolveModel(m(['ultrasharp-4x']), 'x').id, 'ultrasharp-4x');
  assert.equal(up.resolveModel({ models: [{ id: 'upscayl-standard-4x', custom: true }, { id: 'digital-art-4x' }] }, 'x').id, 'digital-art-4x', 'a custom model never replaces a built-in one');
  assert.equal(up.resolveModel(m([]), 'x'), null);
});

test('listModels: .param + .bin pairs, built-ins first, Non-Commercial flags, custom models with their scale', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-upscayl-models-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const models = path.join(root, 'resources', 'models');
  const custom = path.join(root, 'my-models');
  fs.mkdirSync(models, { recursive: true });
  fs.mkdirSync(custom, { recursive: true });
  const pair = (dir, id) => {
    fs.writeFileSync(path.join(dir, `${id}.param`), 'p');
    fs.writeFileSync(path.join(dir, `${id}.bin`), 'bin!');
  };
  for (const id of ['remacri-4x', 'upscayl-standard-4x', 'zeta-custom-in-builtin', 'ultrasharp-4x']) pair(models, id);
  fs.writeFileSync(path.join(models, 'orphan.param'), 'p');
  fs.writeFileSync(path.join(models, 'readme.txt'), 'x');
  for (const id of ['realesr-animevideov3-x2', 'remacri-4x', '4x_NMKD-Siax_200k']) pair(custom, id);
  const list = up.listModels(models, custom, { platform: process.platform });
  assert.deepEqual(list.map((x) => `${x.id}${x.custom ? '*' : ''}`), [
    'upscayl-standard-4x', 'remacri-4x', 'ultrasharp-4x', 'zeta-custom-in-builtin', '4x_NMKD-Siax_200k*', 'realesr-animevideov3-x2*',
  ]);
  const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  assert.equal(byId['remacri-4x'].nonCommercial, true);
  assert.equal(byId['remacri-4x'].custom, false, 'the built-in copy wins');
  assert.equal(byId['upscayl-standard-4x'].nonCommercial, false);
  assert.equal(byId['upscayl-standard-4x'].name, 'Upscayl Standard');
  assert.equal(byId['realesr-animevideov3-x2'].scale, 2);
  assert.equal(byId['realesr-animevideov3-x2'].nonCommercial, false);
  assert.equal(byId['upscayl-standard-4x'].dir, path.resolve(models));
  assert.equal(byId['upscayl-standard-4x'].bytes, 4);
  assert.deepEqual(up.listModels(path.join(root, 'missing'), null), []);
});

// ---------------------------------------------------------------------------------------------
// Detection order
// ---------------------------------------------------------------------------------------------

const WIN_REG = [{ DisplayName: 'Upscayl 2.15.0', DisplayVersion: '2.15.0', DisplayIcon: 'D:\\Tools\\Upscaly\\Upscayl\\Upscayl.exe,0', InstallLocation: null }];
const winBin = (root) => path.win32.join(root, 'resources', 'bin', 'upscayl-bin.exe');

function detect(files, extra = {}) {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return up.detectUpscaylBinary({
    platform: 'win32',
    env: {},
    upscayl: {},
    homedir: 'C:\\Users\\me',
    isFile: (p) => set.has(p.toLowerCase()),
    queryRegistry: async () => [],
    ...extra,
  });
}

test('detection: SCM_UPSCAYL_BIN wins and is authoritative', async () => {
  const env = { SCM_UPSCAYL_BIN: 'E:\\fake\\upscayl-bin.exe' };
  const hit = await detect(['E:\\fake\\upscayl-bin.exe', 'C:\\set\\upscayl-bin.exe'], { env, upscayl: { binPath: 'C:\\set\\upscayl-bin.exe' }, queryRegistry: async () => WIN_REG });
  assert.equal(hit.found, true);
  assert.equal(hit.source, 'env');
  assert.equal(hit.binPath, 'E:\\fake\\upscayl-bin.exe');
  const miss = await detect([winBin('D:\\Tools\\Upscaly\\Upscayl')], { env, queryRegistry: async () => WIN_REG });
  assert.equal(miss.found, false, 'a missing override does not fall back to other places');
  assert.match(miss.error, /SCM_UPSCAYL_BIN points to/);
  const quoted = await detect(['E:\\fake\\upscayl-bin.exe'], { env: { scm_upscayl_bin: '"E:\\fake\\upscayl-bin.exe"' } });
  assert.equal(quoted.source, 'env', 'Windows variable names are case-insensitive; quotes are removed');
});

test('detection: settings, then the registry (InstallLocation empty → folder of DisplayIcon)', async () => {
  const settingsHit = await detect(['C:\\set\\upscayl-bin.exe', winBin('D:\\Tools\\Upscaly\\Upscayl')], { upscayl: { binPath: 'C:\\set\\upscayl-bin.exe' }, queryRegistry: async () => WIN_REG });
  assert.equal(settingsHit.source, 'settings');
  const reg = await detect([winBin('D:\\Tools\\Upscaly\\Upscayl')], { upscayl: { binPath: 'C:\\moved\\upscayl-bin.exe' }, queryRegistry: async () => WIN_REG });
  assert.deepEqual([reg.found, reg.source, reg.binPath, reg.root, reg.version], [true, 'registry', winBin('D:\\Tools\\Upscaly\\Upscayl'), 'D:\\Tools\\Upscaly\\Upscayl', '2.15.0']);
  assert.equal(reg.tried[0], 'C:\\moved\\upscayl-bin.exe', 'the saved location was tried first');
  const loc = await detect([winBin('E:\\Apps\\Upscayl')], {
    queryRegistry: async () => [{ DisplayName: 'Upscayl', DisplayVersion: null, DisplayIcon: '"D:\\Elsewhere\\Upscayl.exe",0', InstallLocation: '"E:\\Apps\\Upscayl"' }],
  });
  assert.equal(loc.binPath, winBin('E:\\Apps\\Upscayl'), 'InstallLocation first when present');
  const byName = await detect([winBin('D:\\Tools\\Upscaly\\Upscayl')], { queryRegistry: async () => [{ ...WIN_REG[0], DisplayVersion: null, DisplayName: 'Upscayl 2.14.1' }] });
  assert.equal(byName.version, '2.14.1', 'version from DisplayName when DisplayVersion is missing');
  const newest = await detect([winBin('C:\\Old'), winBin('C:\\New')], {
    queryRegistry: async () => [
      { DisplayName: 'Upscayl 2.9.0', DisplayVersion: '2.9.0', DisplayIcon: 'C:\\Old\\Upscayl.exe,0' },
      { DisplayName: 'Upscayl 2.15.0', DisplayVersion: '2.15.0', DisplayIcon: 'C:\\New\\Upscayl.exe,0' },
    ],
  });
  assert.equal(newest.binPath, winBin('C:\\New'), 'the newest registered version first');
});

test('detection: common folders, then PATH; version still looked up in the registry', async () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows;C:\\tools\\up' };
  const common = await detect([winBin('C:\\Program Files\\Upscayl')], {
    env,
    queryRegistry: async () => [{ DisplayName: 'Upscayl 2.15.0', DisplayVersion: '2.15.0', DisplayIcon: 'C:\\Program Files\\Upscayl\\Upscayl.exe,0' }],
  });
  assert.equal(common.source, 'registry', 'the registry already points there');
  const commonOnly = await detect([winBin('C:\\Users\\me\\AppData\\Local\\Programs\\Upscayl')], { env });
  assert.deepEqual([commonOnly.source, commonOnly.binPath], ['common', winBin('C:\\Users\\me\\AppData\\Local\\Programs\\Upscayl')]);
  const scoop = await detect([winBin('C:\\Users\\me\\scoop\\apps\\upscayl\\current')], { env: {} });
  assert.equal(scoop.source, 'common', 'scoop under the home folder');
  const onPath = await detect(['C:\\tools\\up\\upscayl-bin.exe'], { env });
  assert.deepEqual([onPath.source, onPath.binPath, onPath.root], ['path', 'C:\\tools\\up\\upscayl-bin.exe', null]);
  const none = await detect([], { env });
  assert.deepEqual([none.found, none.error], [false, null]);
  assert.deepEqual(none.tried.slice(0, 2), [winBin('C:\\Users\\me\\AppData\\Local\\Programs\\Upscayl'), winBin('C:\\Program Files\\Upscayl')]);
  assert.deepEqual(none.tried.slice(-2), ['C:\\Windows\\upscayl-bin.exe', 'C:\\tools\\up\\upscayl-bin.exe']);
  const gone = await detect([], { env, upscayl: { binPath: 'C:\\moved\\upscayl-bin.exe' } });
  assert.match(gone.error, /no longer at "C:\\moved\\upscayl-bin\.exe"/);
});

test('detection: the registry is never asked off Windows; macOS and Linux install folders', async () => {
  let asked = false;
  const mac = await up.detectUpscaylBinary({
    platform: 'darwin', env: {}, homedir: '/Users/me', isFile: (p) => p === '/Applications/Upscayl.app/Contents/Resources/bin/upscayl-bin', queryRegistry: async () => { asked = true; return WIN_REG; },
  });
  assert.deepEqual([mac.found, mac.source, mac.root], [true, 'common', '/Applications/Upscayl.app']);
  const linux = await up.detectUpscaylBinary({ platform: 'linux', env: { PATH: '/usr/bin' }, homedir: '/home/me', isFile: (p) => p === '/usr/share/upscayl/bin/upscayl-bin' });
  assert.deepEqual([linux.source, linux.binPath], ['common', '/usr/share/upscayl/bin/upscayl-bin']);
  const linuxPath = await up.detectUpscaylBinary({ platform: 'linux', env: { PATH: '/opt/x:/usr/local/bin' }, homedir: '/home/me', isFile: (p) => p === '/usr/local/bin/upscayl-bin' });
  assert.equal(linuxPath.source, 'path');
  assert.equal(asked, false);
});

// ---------------------------------------------------------------------------------------------
// Status, locate, custom models (temp folders + real settings store)
// ---------------------------------------------------------------------------------------------

test('getUpscaylStatus: models, models folder, cached GPUs only for the same binary, model fallback', async (t) => {
  const env = makeEnv(t, { models: ['upscayl-lite-4x', 'remacri-4x', 'digital-art-4x'] });
  const st = await up.getUpscaylStatus(env.deps, {});
  assert.equal(st.found, true);
  assert.equal(st.source, 'env');
  assert.equal(st.binPath, path.resolve(env.binPath));
  assert.equal(st.modelsDir, path.resolve(env.modelsDir));
  assert.deepEqual(st.models.map((m) => [m.id, m.nonCommercial, m.custom, m.scale]), [
    ['upscayl-lite-4x', false, false, 4], ['remacri-4x', true, false, 4], ['digital-art-4x', false, false, 4],
  ]);
  assert.equal(st.gpus, null);
  assert.equal(st.effectiveModel, 'digital-art-4x', 'standard and high-fidelity are missing');
  assert.match(st.modelWarning, /Upscayl Standard/);
  assert.equal(st.ready, true);
  env.settings.update({ upscayl: { gpus: [{ id: 0, name: 'GPU A' }], gpusDetectedFor: env.binPath } });
  assert.deepEqual((await up.getUpscaylStatus(env.deps, {})).gpus, [{ id: 0, name: 'GPU A' }]);
  env.settings.update({ upscayl: { gpusDetectedFor: path.join(env.root, 'other', BIN_NAME) } });
  assert.equal((await up.getUpscaylStatus(env.deps, {})).gpus, null, 'GPUs of another Upscayl are not shown');
  env.settings.update({ upscayl: { customModelsDir: path.join(env.root, 'gone-models') } }, { internal: true });
  assert.match((await up.getUpscaylStatus(env.deps, {})).error, /no longer exists/);
});

test('getUpscaylStatus: not installed, or installed without models', async (t) => {
  const missing = makeEnv(t, { bin: false });
  const st = await up.getUpscaylStatus(missing.deps, {});
  assert.deepEqual([st.found, st.binPath, st.models], [false, null, []]);
  assert.match(st.error, /SCM_UPSCAYL_BIN/);
  const noModels = makeEnv(t, { models: [] });
  const st2 = await up.getUpscaylStatus(noModels.deps, {});
  assert.deepEqual([st2.found, st2.ready], [true, false]);
  assert.match(st2.error, /AI models are missing/);
});

test('locateUpscayl accepts Upscayl.exe, the install folder or the binary; null forgets it', async (t) => {
  const env = makeEnv(t);
  env.deps.seams = { platform: process.platform, env: {}, registry: { queryUninstall: async () => [] }, isFile: undefined };
  const installRoot = path.join(env.root, 'Upscayl');
  fs.writeFileSync(path.join(installRoot, 'Upscayl.exe'), 'app');
  env.settings.update({ upscayl: { gpus: [{ id: 0, name: 'Old' }], gpusDetectedFor: 'C:\\old\\bin.exe' } });
  for (const target of [path.join(installRoot, 'Upscayl.exe'), installRoot, env.binPath, path.join(installRoot, 'resources')]) {
    const st = await up.locateUpscayl(env.deps, target);
    assert.equal(st.found, true, target);
    assert.equal(st.source, 'settings');
    assert.equal(path.resolve(st.binPath), path.resolve(env.binPath));
  }
  assert.equal(env.settings.get().upscayl.binPath, path.resolve(env.binPath));
  assert.equal(env.settings.get().upscayl.gpus, null, 'GPU list reset for a new binary');
  await assert.rejects(up.locateUpscayl(env.deps, path.join(env.root, 'ws')), (err) => err.code === 'UPSCAYL_NOT_FOUND' && /wasn't found there/.test(err.message));
  await up.locateUpscayl(env.deps, null);
  assert.equal(env.settings.get().upscayl.binPath, null);
});

test('setCustomModelsDir: path must contain "models" (lower case) and hold model pairs', async (t) => {
  const env = makeEnv(t);
  const bad = path.join(env.root, 'mymods');
  const upper = path.join(env.root, 'Models');
  const empty = path.join(env.root, 'empty', 'models');
  const good = path.join(env.root, 'extra', 'models');
  for (const d of [bad, upper, empty, good]) fs.mkdirSync(d, { recursive: true });
  for (const d of [bad, upper, good]) {
    fs.writeFileSync(path.join(d, '4x_custom.param'), 'p');
    fs.writeFileSync(path.join(d, '4x_custom.bin'), 'b');
  }
  await assert.rejects(up.setCustomModelsDir(env.deps, bad), (err) => err.code === 'BAD_MODELS_FOLDER');
  await assert.rejects(up.setCustomModelsDir(env.deps, upper), (err) => err.code === 'BAD_MODELS_FOLDER', 'upscayl-bin refuses "Models"');
  await assert.rejects(up.setCustomModelsDir(env.deps, empty), (err) => err.code === 'NO_MODELS');
  await assert.rejects(up.setCustomModelsDir(env.deps, path.join(env.root, 'nope', 'models')), (err) => err.code === 'NOT_A_FOLDER');
  const st = await up.setCustomModelsDir(env.deps, good);
  assert.equal(st.customModelsDir, path.resolve(good));
  assert.deepEqual(st.models.filter((m) => m.custom).map((m) => m.id), ['4x_custom']);
  assert.equal((await up.setCustomModelsDir(env.deps, null)).customModelsDir, null);
});

// ---------------------------------------------------------------------------------------------
// runUpscale end to end with fakes
// ---------------------------------------------------------------------------------------------

function copyFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

/** Small cards: 40 px wide = 16 PPI on a 63 mm card, so 300 PPI always asks for 4×. */
function seedCards(env) {
  writePng(env.front('a.png'), makeImage(40, 56, pattern(1)));
  copyFile(env.front('a.png'), env.front('sub/a copy.png')); // identical bytes
  writePng(env.front('b.png'), makeImage(30, 42, pattern(2)));
  writePng(env.front('c.jpg'), makeImage(36, 50, pattern(3))); // PNG bytes named .jpg: sniffed as png
  writePng(env.kindFile('back', 'back.png'), makeImage(40, 56, pattern(4)));
  copyFile(env.front('b.png'), env.kindFile('double_sided', 'b.png')); // same as a front
}

test('runUpscale: upscales once per identical image, hardlinks the copies, writes the manifest, cleans staging', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  const { result, rec } = await env.run({ kinds: ['front', 'back', 'double_sided'], onlyBackFile: 'back.png' });
  assert.deepEqual(rec.warnings, []);
  assert.deepEqual(
    [result.total, result.unique, result.upscaled, result.cached, result.sharp, result.fallbacks, result.skipped],
    [6, 4, 6, 0, 0, 0, 0],
  );
  assert.equal(result.uniqueUpscaled, 4);
  assert.equal(result.model, 'upscayl-standard-4x');
  // One dir-mode run (every group is png/4×) in one chunk; helper: one prepare + one validate.
  assert.equal(env.state.calls.length, 1);
  assert.equal(env.state.calls[0].dir, true);
  assert.deepEqual(env.deps.helper.calls.map((c) => [c.sub, c.items.length]), [['prepare-upscale', 4], ['validate-images', 4]]);
  const { a } = env.state.calls[0];
  assert.deepEqual([a.n, a.z, a.s, a.f, a.m], ['upscayl-standard-4x', '4', '4', 'png', path.resolve(env.modelsDir)]);
  // Outputs: normalized size × 4, next to each other in game/upscaled/<kind>/.
  assert.deepEqual(dims(env.upscaled('front/a.png')), [160, 224]);
  assert.deepEqual(dims(env.upscaled('front/b.png')), [120, 168]);
  assert.deepEqual(dims(env.upscaled('front/c.png')), [144, 200], 'format "same": sniffed PNG → .png');
  assert.deepEqual(dims(env.upscaled('back/back.png')), [160, 224]);
  assert.equal(fs.statSync(env.upscaled('front/a.png')).ino, fs.statSync(env.upscaled('front/sub/a copy.png')).ino, 'identical copies share one file');
  assert.equal(fs.statSync(env.upscaled('front/b.png')).ino, fs.statSync(env.upscaled('double_sided/b.png')).ino, 'also across kinds');
  // files map: every source → the file the PDF must use.
  assert.deepEqual(Object.keys(result.files).sort(), ['back', 'double_sided', 'front']);
  assert.equal(result.files.front['sub/a copy.png'], env.upscaled('front/sub/a copy.png'));
  assert.equal(result.files.back['back.png'], env.upscaled('back/back.png'));
  // Manifest.
  const m = env.manifest();
  assert.equal(m.version, 2);
  assert.deepEqual(Object.keys(m.entries).sort(), ['back/back.png', 'double_sided/b.png', 'front/a.png', 'front/b.png', 'front/c.png', 'front/sub/a copy.png']);
  const e = m.entries['front/c.png'];
  assert.deepEqual([e.src, e.kind, e.scale], ['c.jpg', 'front', 4]);
  assert.match(e.key, /^[0-9a-f]{40}\|upscayl-standard-4x\|.+\|s4\|png\|c0\|tta0$/);
  assert.ok(!fs.existsSync(path.join(env.paths.upscaledRoot, '.staging')), 'staging removed');
  // Progress went up to 100% with plain labels; secPerImage moved.
  const percents = rec.progress.map((p) => p.percent).filter((p) => typeof p === 'number');
  assert.equal(Math.max(...percents), 100);
  assert.ok(rec.progress.some((p) => /^Upscaling \d of 4 images$/.test(p.label || '')));
  assert.equal(typeof result.secPerImage, 'number');
  assert.equal(env.settings.get().upscayl.secPerImage, result.secPerImage);
});

test('runUpscale: a second run is fully cached; settings changes re-upscale and prune old files', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  await env.run({ kinds: ['front'] });
  const calls = env.state.calls.length;
  const again = await env.run({ kinds: ['front'] });
  assert.equal(env.state.calls.length, calls, 'Upscayl not started again');
  assert.deepEqual([again.result.cached, again.result.upscaled, again.result.unique], [4, 0, 0]);
  assert.equal(again.result.files.front['a.png'], env.upscaled('front/a.png'));
  // Switch to JPG: everything again, the old PNGs are pruned.
  env.settings.update({ upscayl: { format: 'jpg' } });
  const jpg = await env.run({ kinds: ['front'] });
  assert.deepEqual([jpg.result.upscaled, jpg.result.unique, jpg.result.staleRemoved], [4, 3, 4]);
  assert.ok(fs.existsSync(env.upscaled('front/a.jpg')));
  assert.ok(!fs.existsSync(env.upscaled('front/a.png')));
  assert.deepEqual(Object.keys(env.manifest().entries).sort(), ['front/a.jpg', 'front/b.jpg', 'front/c.jpg', 'front/sub/a copy.jpg']);
  // Another model: re-upscaled with the new model name in the keys.
  env.settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
  const lite = await env.run({ kinds: ['front'] });
  assert.equal(lite.result.upscaled, 4);
  assert.ok(Object.values(env.manifest().entries).every((x) => x.key.includes('|upscayl-lite-4x|')));
});

test('runUpscale: smart scale per image; sharp images use the original and lose their old copy', async (t) => {
  const env = makeEnv(t);
  writePng(env.front('small.png'), makeImage(20, 28, pattern(5))); // 8 PPI
  writePng(env.front('medium.png'), makeImage(40, 56, pattern(6))); // 16 PPI
  // At 40 PPI: small needs 8×4=32 < 40 → 4×, medium needs 16×3=48 ≥ 40 → 3×.
  const r40 = await env.run({ kinds: ['front'], targetPpi: 40 });
  assert.deepEqual(dims(env.upscaled('front/small.png')), [80, 112]);
  assert.deepEqual(dims(env.upscaled('front/medium.png')), [120, 168]);
  assert.equal(r40.result.unique, 2);
  assert.equal(env.state.calls.length, 2, 'one run per scale');
  // At 15 PPI medium (16 PPI) is already sharp: original used, upscaled copy pruned.
  const r15 = await env.run({ kinds: ['front'], targetPpi: 15 });
  assert.equal(r15.result.sharp, 1);
  assert.equal(r15.result.files.front['medium.png'], env.front('medium.png'));
  assert.ok(!fs.existsSync(env.upscaled('front/medium.png')));
  assert.deepEqual(dims(env.upscaled('front/small.png')), [40, 56], 'small: 8×2 = 16 ≥ 15 → 2×');
  assert.deepEqual(Object.keys(env.manifest().entries), ['front/small.png']);
});

test('runUpscale: GPU failures → one retry each until the circuit breaker, originals copied (not cached), upscaling turned off', async (t) => {
  const env = makeEnv(t, { mode: 'vk' });
  for (let i = 1; i <= 5; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42 + i, pattern(i)));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.deepEqual([result.unique, result.uniqueUpscaled, result.uniqueFailed, result.fallbacks, result.retried], [5, 0, 5, 5, 3]);
  assert.equal(env.state.calls.filter((c) => !c.dir).length, 3, 'stops after 3 consecutive GPU failures');
  assert.ok(rec.warnings.some((w) => /couldn't use your graphics card, so the remaining images were not upscaled/.test(w)), rec.warnings.join(' | '));
  assert.ok(rec.warnings.some((w) => w === 'Could not upscale card1.png; the original image will be used.'));
  assert.ok(rec.warnings.some((w) => /^Upscaling was turned off because your graphics card couldn't run Upscayl\. Make PDF will use your original images/.test(w)));
  assert.equal(result.disabledUpscaling, true);
  assert.equal(env.settings.get().upscayl.enabled, false);
  for (let i = 1; i <= 5; i += 1) {
    const out = result.files.front[`card${i}.png`];
    assert.equal(out, env.upscaled(`front/card${i}.png`));
    assert.deepEqual(fs.readFileSync(out), fs.readFileSync(env.front(`card${i}.png`)), 'original bytes');
    assert.notEqual(fs.statSync(out).ino, fs.statSync(env.front(`card${i}.png`)).ino, 'a copy, never a link to the original');
  }
  assert.deepEqual(env.manifest().entries, {}, 'fallbacks are never cached');
  // Next run tries again (nothing cached) — the PDF job wording.
  const pdf = makeCtx(env.spawn, { kind: 'pdf' });
  await up.runUpscale(pdf.ctx, env.deps, { kinds: ['front'], targetPpi: 300, cardWidthIn: CARD_W_IN });
  assert.ok(pdf.rec.warnings.some((w) => /^Upscaling was turned off because your graphics card couldn't run Upscayl; your PDF used the original images\.$/.test(w)), pdf.rec.warnings.join(' | '));
});

test('runUpscale: silent black images are caught by the check; every image is retried', async (t) => {
  const env = makeEnv(t, { mode: 'black' });
  for (let i = 1; i <= 4; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42, pattern(i)));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.equal(env.state.calls.filter((c) => !c.dir).length, 4, 'no breaker without error text');
  assert.equal(result.fallbacks, 4);
  assert.ok(rec.logs.some((l) => /blank image/.test(l.line)), 'the reason is logged');
  assert.ok(rec.warnings.some((w) => /^Upscaling was turned off because Upscayl failed on most images/.test(w)), rec.warnings.join(' | '));
});

test('runUpscale: a flaky folder run is fixed by single retries and then cached', async (t) => {
  const env = makeEnv(t, { mode: 'flaky' });
  for (let i = 1; i <= 3; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42, pattern(i)));
  writePng(env.front('other.png'), makeImage(60, 84, pattern(9))); // 24 PPI → 4× at 300... same batch
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.deepEqual([result.uniqueUpscaled, result.fallbacks, result.retried], [4, 0, 1]);
  assert.equal(result.disabledUpscaling, false);
  assert.deepEqual(rec.warnings, []);
  assert.equal(Object.keys(env.manifest().entries).length, 4);
  assert.equal(env.settings.get().upscayl.enabled, true);
});

test('runUpscale: the same error again and again also stops the retries', async (t) => {
  const env = makeEnv(t, { mode: 'modelerr' });
  for (let i = 1; i <= 5; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42, pattern(i)));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.equal(env.state.calls.filter((c) => !c.dir).length, 3);
  assert.equal(result.fallbacks, 5);
  assert.ok(rec.warnings.some((w) => /^Upscayl failed again and again \(Upscayl stopped with code 4294967295 \(Error: Failed to open/.test(w)), rec.warnings.join(' | '));
});

test('runUpscale: Upscayl blocked from starting → originals, clear warnings, nothing retried', async (t) => {
  const env = makeEnv(t, { mode: 'nostart' });
  for (let i = 1; i <= 3; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42, pattern(i)));
  const { result, rec } = await env.run({ kinds: ['front'], chunkSize: 1 });
  assert.equal(env.state.calls.length, 1, 'later chunks are not tried');
  assert.deepEqual([result.fallbacks, result.uniqueFailed, result.retried], [3, 3, 0]);
  assert.ok(rec.warnings.includes('Windows or your antivirus blocked Upscayl, so your original images are used.'), rec.warnings.join(' | '));
  assert.ok(rec.warnings.some((w) => /could not be started \(Windows or your antivirus may be blocking it\)/.test(w)));
});

test('runUpscale: images Pillow cannot open fall back without counting as GPU failures', async (t) => {
  const env = makeEnv(t);
  writePng(env.front('good.png'), makeImage(40, 56, pattern(1)));
  fs.writeFileSync(env.front('broken.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('garbage')]));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.equal(result.unreadable, 1);
  assert.equal(result.uniqueUpscaled, 1);
  assert.equal(result.fallbacks, 1);
  assert.equal(result.disabledUpscaling, false);
  assert.ok(rec.warnings.includes('Could not upscale broken.png; the original image will be used.'));
});

test('runUpscale: name clashes are skipped with a warning and use their originals', async (t) => {
  const env = makeEnv(t);
  writePng(env.front('a.png'), makeImage(40, 56, pattern(1)));
  writePng(env.front('a.jpg'), makeImage(40, 56, pattern(2))); // sniffed PNG → same upscaled file
  writePng(env.front('ok.png'), makeImage(40, 56, pattern(3)));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.equal(result.skipped, 2);
  assert.equal(result.upscaled, 1);
  assert.equal(result.files.front['a.png'], env.front('a.png'));
  assert.ok(rec.warnings.some((w) => /would get the same upscaled file name/.test(w)));
});

test('runUpscale: cancelling keeps finished chunks (manifest included), removes staging, prunes nothing', async (t) => {
  const env = makeEnv(t);
  for (let i = 1; i <= 3; i += 1) writePng(env.front(`card${i}.png`), makeImage(30 + i, 42, pattern(i)));
  fs.mkdirSync(path.join(env.paths.upscaledRoot, 'front'), { recursive: true });
  fs.writeFileSync(env.upscaled('front/stale.png'), 'old');
  const { ctx, cancel } = makeCtx(env.spawn);
  env.state.beforeSpawn = async (call, n) => {
    if (n === 2) {
      cancel();
      throw cancelledError();
    }
  };
  await assert.rejects(up.runUpscale(ctx, env.deps, { kinds: ['front'], targetPpi: 300, cardWidthIn: CARD_W_IN, chunkSize: 1 }), (err) => err.code === 'CANCELLED');
  const entries = Object.keys(env.manifest().entries);
  assert.equal(entries.length, 1, 'the first chunk is kept');
  assert.ok(fs.existsSync(env.upscaled(entries[0])));
  assert.ok(!fs.existsSync(path.join(env.paths.upscaledRoot, '.staging')));
  assert.ok(fs.existsSync(env.upscaled('front/stale.png')), 'no pruning on cancel');
  // The next run picks up where it stopped.
  env.state.beforeSpawn = null;
  const next = await env.run({ kinds: ['front'], chunkSize: 1 });
  assert.deepEqual([next.result.cached, next.result.upscaled], [1, 2]);
  assert.ok(!fs.existsSync(env.upscaled('front/stale.png')));
});

test('runUpscale: Upscayl missing → every original, one warning', async (t) => {
  const env = makeEnv(t, { bin: false });
  writePng(env.front('a.png'), makeImage(40, 56, pattern(1)));
  const { result, rec } = await env.run({ kinds: ['front'] });
  assert.deepEqual([result.skipped, result.upscaled], [1, 0]);
  assert.equal(result.files.front['a.png'], env.front('a.png'));
  assert.deepEqual(rec.warnings, ['Upscaling was skipped because Upscayl was not found; your original images are used.']);
});

test('runUpscale: the selected graphics card is passed; an unknown one falls back to automatic', async (t) => {
  const env = makeEnv(t, { settings: { upscayl: { gpuId: '1', tileSize: 256, tta: false, threads: '1:2:2', format: 'webp', compression: 70 } } });
  writePng(env.front('a.png'), makeImage(40, 56, pattern(1)));
  env.settings.update({ upscayl: { gpus: [{ id: 0, name: 'A' }, { id: 1, name: 'B' }], gpusDetectedFor: env.binPath } });
  await env.run({ kinds: ['front'] });
  const { a } = env.state.calls[0];
  assert.deepEqual([a.g, a.t, a.j, a.f, a.c], ['1', '256', '1:2:2', 'webp', '70']);
  env.settings.update({ upscayl: { gpuId: '3', format: 'png' } });
  const { rec } = await env.run({ kinds: ['front'] });
  assert.equal(env.state.calls[1].a.g, undefined);
  assert.ok(rec.warnings.some((w) => /graphics card \(#3\) wasn't found/.test(w)));
});

// ---------------------------------------------------------------------------------------------
// Manifest helpers used by cards.js
// ---------------------------------------------------------------------------------------------

test('loadManifest + isCardUpscaled + settingsKeyFn agree with a run (cards.js usage)', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  await env.run({ kinds: ['front'] });
  await up.getUpscaylStatus(env.deps, {}); // detection cached, like after the app's env check
  const manifest = up.loadManifest(env.deps);
  const keyFn = up.settingsKeyFn(env.deps);
  const asyncKeyFn = await up.createKeyFn(env.deps, { targetPpi: 300, cardWidthIn: CARD_W_IN });
  const { scanDir } = require('../../src/main/scan');
  const images = (await scanDir(path.join(env.ws, 'game', 'front'), { hash: true, hashCache: env.deps.hashCache })).images;
  assert.equal(images.length, 4);
  for (const img of images) {
    const card = { ...img, kind: 'front' };
    assert.equal(up.isCardUpscaled(manifest, keyFn, card), true, img.rel);
    assert.equal(keyFn(card), asyncKeyFn(card), 'sync and async keys agree');
    assert.equal(up.isCardUpscaled(manifest, null, card), true, 'no keyFn: hash match');
    assert.equal(up.isCardUpscaled(manifest, keyFn, img, 'front'), true, 'kind as 4th argument');
  }
  assert.equal(up.isCardUpscaled(manifest, keyFn, { ...images[0], kind: 'double_sided' }), false);
  assert.equal(up.isCardUpscaled(manifest, () => null, { ...images[0], kind: 'front' }), false);
  assert.equal(up.isCardUpscaled(manifest, keyFn, { ...images[0], kind: 'front', hash: H('f') }), false, 'changed image');
  env.settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
  assert.equal(up.isCardUpscaled(manifest, up.settingsKeyFn(env.deps), { ...images[0], kind: 'front' }), false, 'other model');
  env.settings.update({ upscayl: { model: 'upscayl-standard-4x' }, pdf: { options: { ppi: 600 } } });
  assert.equal(up.isCardUpscaled(manifest, up.settingsKeyFn(env.deps), { ...images[0], kind: 'front' }), true, '16 PPI needs 4× at 600 PPI too');
  // A deleted upscaled file disappears from loadManifest.
  fs.rmSync(env.upscaled('front/a.png'));
  assert.equal(up.loadManifest(env.deps).entries['front/a.png'], undefined);
  assert.equal(up.isCardUpscaled({ entries: {} }, keyFn, { ...images[0], kind: 'front' }), false);
  assert.equal(up.isCardUpscaled(null, keyFn, images[0]), false);
});

test('settingsKeyFn before detection uses a wildcard models folder (and starts detection)', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  await env.run({ kinds: ['front'] });
  const fresh = { ...env.deps }; // a new deps object = no cached detection
  const keyFn = up.settingsKeyFn(fresh);
  const img = { kind: 'front', rel: 'b.png', relNoExt: 'b', hash: (await require('../../src/main/scan').scanDir(path.join(env.ws, 'game', 'front'), { hash: true })).images.find((i) => i.rel === 'b.png').hash, type: 'png', width: 30, height: 42 };
  assert.match(keyFn(img), /\|\*\|s4\|png\|c0\|tta0$/);
  assert.equal(up.isCardUpscaled(up.loadManifest(fresh), keyFn, img), true);
});

// ---------------------------------------------------------------------------------------------
// Jobs, cache info, clear
// ---------------------------------------------------------------------------------------------

test('startUpscaleJob: targets → kinds, result without the files map, plain errors', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  const id = await up.startUpscaleJob(env.deps, { targets: { front: true, back: false, double_sided: true } });
  const summary = await env.deps.jobs.whenFinished(id);
  assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
  assert.equal(summary.result.files, undefined);
  assert.deepEqual(summary.result.kinds, ['front', 'double_sided']);
  assert.equal(summary.result.upscaled, 5);
  assert.deepEqual(summary.rec.steps, ['scan:running', 'scan:done', 'upscale:running', 'upscale:done', 'save:running', 'save:done']);
  assert.deepEqual(env.deps.jobs.started[0].opts.steps.map((s) => s.id), ['scan', 'upscale', 'save']);
  await assert.rejects(up.startUpscaleJob(env.deps, { targets: { front: false, back: false, double_sided: false } }), (e) => e.code === 'NO_TARGETS');
  // Only the common back targeted, but none chosen (two backs, mode auto).
  writePng(env.kindFile('back', 'back2.png'), makeImage(40, 56, pattern(8)));
  const backOnly = await env.deps.jobs.whenFinished(await up.startUpscaleJob(env.deps, { targets: { back: true } }));
  assert.equal(backOnly.status, 'failed');
  assert.equal(backOnly.error.code, 'NOTHING_TO_UPSCALE');
  assert.match(backOnly.error.message, /no common back image is chosen/);
});

test('startUpscaleJob: refuses when busy or when Upscayl is missing; fails clearly when every image failed', async (t) => {
  const env = makeEnv(t);
  writePng(env.front('a.png'), makeImage(40, 56, pattern(1)));
  const hold = env.deps.jobs.start('preview', { title: 'Holding' }, () => new Promise(() => {}));
  void hold;
  await assert.rejects(up.startUpscaleJob(env.deps, { targets: { front: true } }), /^Error: BUSY: wait until "Holding" finishes$/);
  const missing = makeEnv(t, { bin: false });
  await assert.rejects(up.startUpscaleJob(missing.deps, { targets: { front: true } }), (e) => e.code === 'UPSCAYL_NOT_FOUND' && e.friendly === true);
  const broken = makeEnv(t, { mode: 'vk' });
  writePng(broken.front('a.png'), makeImage(40, 56, pattern(1)));
  const summary = await broken.deps.jobs.whenFinished(await up.startUpscaleJob(broken.deps, { targets: { front: true } }));
  assert.equal(summary.status, 'failed');
  assert.equal(summary.error.code, 'UPSCAYL_FAILED');
  assert.match(summary.error.message, /^Upscayl couldn't upscale your images \(1 image failed\)/);
  assert.ok(summary.warnings.some((w) => /Could not upscale a\.png/.test(w)));
});

test('startGpuProbeJob: lists the GPUs, checks the test image, caches them in settings', async (t) => {
  const env = makeEnv(t, { models: ['upscayl-standard-4x', 'upscayl-lite-4x'] });
  const summary = await env.deps.jobs.whenFinished(await up.startGpuProbeJob(env.deps));
  assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
  assert.deepEqual(summary.result.gpus, [{ id: 0, name: 'NVIDIA GeForce RTX 4080 SUPER' }, { id: 1, name: 'AMD Radeon(TM) Graphics' }]);
  assert.equal(summary.result.works, true);
  assert.equal(summary.result.model, 'upscayl-lite-4x', 'the smallest model');
  const { a } = env.state.calls[0];
  assert.equal(a.s, '2');
  assert.ok(!fs.existsSync(a.i) && !fs.existsSync(a.o), 'probe files removed');
  assert.deepEqual(env.settings.get().upscayl.gpus, summary.result.gpus);
  assert.deepEqual((await up.getUpscaylStatus(env.deps, {})).gpus, summary.result.gpus);
  env.state.gpuLines = [];
  const none = await env.deps.jobs.whenFinished(await up.startGpuProbeJob(env.deps));
  assert.equal(none.status, 'failed');
  assert.equal(none.error.code, 'NO_GPU');
  env.state.mode = 'nostart';
  const blocked = await env.deps.jobs.whenFinished(await up.startGpuProbeJob(env.deps));
  assert.equal(blocked.error.code, 'UPSCAYL_START_FAILED');
  assert.equal(blocked.error.message, 'Windows or your antivirus blocked Upscayl.');
});

test('startPreviewJob: before/after scm-img URLs in the preview folder, sizes and captions', async (t) => {
  const env = makeEnv(t);
  writePng(env.front('sub/card.png'), makeImage(40, 56, pattern(1)));
  const summary = await env.deps.jobs.whenFinished(await up.startPreviewJob(env.deps, { kind: 'front', rel: 'sub/card.png' }));
  assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
  const r = summary.result;
  const before = decodePath(new URL(r.before).pathname.slice(1));
  const after = decodePath(new URL(r.after).pathname.slice(1));
  assert.ok(util.isInside(env.paths.previewDir, before) && util.isInside(env.paths.previewDir, after));
  assert.deepEqual(dims(after), [160, 224]);
  assert.deepEqual(r.beforeSize.width, 40);
  assert.deepEqual([r.afterSize.width, r.afterSize.height, r.scale, r.alreadySharp, r.name], [160, 224, 4, false, 'card.png']);
  assert.match(r.afterCaption, /^160 × 224 px · [\d.]+ KB$/);
  // Already sharp at this print resolution → still a 2× preview.
  env.settings.update({ pdf: { options: { ppi: 10 } } });
  const sharp = await env.deps.jobs.whenFinished(await up.startPreviewJob(env.deps, { kind: 'front', rel: 'sub/card.png' }));
  assert.deepEqual([sharp.result.scale, sharp.result.alreadySharp], [2, true]);
  await assert.rejects(up.startPreviewJob(env.deps, { kind: 'front', rel: 'missing.png' }), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(up.startPreviewJob(env.deps, { kind: 'nope', rel: 'a.png' }), TypeError);
  await assert.rejects(up.startPreviewJob(env.deps, { kind: 'front', rel: '../x.png' }), /Invalid file path/);
  env.state.mode = 'vk';
  const failed = await env.deps.jobs.whenFinished(await up.startPreviewJob(env.deps, { kind: 'front', rel: 'sub/card.png' }));
  assert.equal(failed.error.code, 'UPSCAYL_FAILED');
  assert.match(failed.error.message, /couldn't use your graphics card/);
});

test('cacheInfo and clearCache (BUSY while a job runs)', async (t) => {
  const env = makeEnv(t);
  seedCards(env);
  env.settings.update({ upscayl: { targets: { front: true, back: false, double_sided: false } } });
  const before = await up.cacheInfo(env.deps);
  assert.deepEqual([before.files, before.total, before.upToDate, before.needed, before.unique, before.available], [0, 4, 0, 4, 3, true]);
  await env.run({ kinds: ['front'] });
  const info = await up.cacheInfo(env.deps);
  assert.deepEqual([info.files, info.total, info.upToDate, info.needed], [4, 4, 4, 0]);
  assert.ok(info.bytes > 0);
  const hold = env.deps.jobs.start('probe', { title: 'Detecting graphics cards' }, () => new Promise(() => {}));
  void hold;
  await assert.rejects(up.clearCache(env.deps), /^Error: BUSY: wait until "Detecting graphics cards" finishes$/);
  const free = makeEnv(t);
  seedCards(free);
  await free.run({ kinds: ['front', 'double_sided'] });
  const res = await up.clearCache(free.deps);
  assert.deepEqual([res.removed, res.bytes > 0], [5, true]);
  assert.deepEqual(fs.readdirSync(free.paths.upscaledRoot), []);
  assert.ok(free.emitted.some((e) => e.channel === 'cards:changed' && e.payload.reason === 'upscale-cache'));
  assert.deepEqual(up.loadManifest(free.deps).entries, {});
});
