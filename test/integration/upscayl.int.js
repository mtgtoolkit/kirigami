#!/usr/bin/env node
'use strict';

/**
 * Integration checks for src/main/upscayl.js against the REAL Upscayl install, the repository's
 * Python (scm_helper.py prepare-upscale / validate-images / introspect) and the real JobManager,
 * settings store, locks, helper and hash cache — without Electron.
 *
 * Safety: everything happens in a TEMP folder (its name contains a space and non-ASCII letters on
 * purpose): engine code copied (root *.py, requirements.txt, assets/, plugins/) and test images
 * copied from <repo>/test/images (plus an EXIF-orientation-6 JPEG and a CMYK JPEG made with Pillow).
 * The repository's game/, data/ and venv are only read. A temporary fake upscayl-bin.exe (compiled
 * with the .NET Framework csc.exe) simulates GPU failures (black images, "vkQueueSubmit failed").
 *
 * Usage (from electron-app/):
 *   node test/integration/upscayl.int.js [--bin <upscayl-bin>] [--python <python>] [--tmp <parent dir>]
 *                                         [--expect-gpus N] [--keep] [--verbose]
 * Defaults: --bin D:\Tools\Upscaly\Upscayl\resources\bin\upscayl-bin.exe (or SCM_INT_UPSCAYL_BIN),
 *           --python <repo>/venv/Scripts/python.exe, --tmp os.tmpdir(), --expect-gpus 2 (this PC).
 */

const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENGINE = path.resolve(APP_DIR, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const VERBOSE = flag('--verbose') || !!process.env.SCM_INT_VERBOSE;
const IS_WIN = process.platform === 'win32';
const REPO_PYTHON = option('--python', process.env.SCM_INT_PYTHON || path.join(ENGINE, 'venv', IS_WIN ? 'Scripts' : 'bin', IS_WIN ? 'python.exe' : 'python'));
const UPSCAYL_BIN = option('--bin', process.env.SCM_INT_UPSCAYL_BIN || 'D:\\Tools\\Upscaly\\Upscayl\\resources\\bin\\upscayl-bin.exe');
const TMP_PARENT = option('--tmp', os.tmpdir());
const EXPECT_GPUS = Number(option('--expect-gpus', process.env.SCM_INT_EXPECT_GPUS || '2'));
const TEST_IMAGES = path.join(ENGINE, 'test', 'images');

const { getPaths } = require('../../src/main/paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');
const { createLocks } = require('../../src/main/locks');
const { createHelper } = require('../../src/main/helper');
const { createHashCache, scanImages } = require('../../src/main/scan');
const { decodePath } = require('../../src/main/img-url');
const upscayl = require('../../src/main/upscayl');

let failures = 0;
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, note });
    console.log(`PASS  ${name} (${ms} ms)${note ? ` - ${note}` : ''}`);
  } catch (err) {
    failures += 1;
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, note: err.message });
    console.log(`FAIL  ${name} (${ms} ms)\n      ${String(err.stack || err).split('\n').slice(0, 8).join('\n      ')}`);
    if (err.details) console.log(`      details: ${String(err.details).split('\n').slice(-10).join('\n      ')}`);
  }
}

function copyDir(src, dest, filter = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (!filter(s, e)) continue;
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function sha1(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

function python(code, input) {
  const r = child_process.spawnSync(REPO_PYTHON, ['-c', code], {
    input: input === undefined ? undefined : JSON.stringify(input),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr}`);
  return r.stdout.trim() ? JSON.parse(r.stdout) : null;
}

/** Upright size + mean brightness/RGB of images (what Pillow sees after exif_transpose + RGB). */
function measure(files) {
  return python(String.raw`
import json, sys
from PIL import Image, ImageOps, ImageStat
out = {}
for p in json.load(sys.stdin):
    with Image.open(p) as im:
        mode = im.mode
        img = ImageOps.exif_transpose(im).convert('RGB')
    thumb = img.copy(); thumb.thumbnail((256, 256))
    st = ImageStat.Stat(thumb)
    out[p] = {'w': img.width, 'h': img.height, 'mode': mode, 'mean': sum(st.mean) / 3, 'rgb': st.mean}
print(json.dumps(out))
`, files);
}

const FAKE_UPSCAYL_CS = String.raw`
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;

class FakeUpscayl {
  static int Main(string[] args) {
    string input = null, output = null, fmt = "png"; int scale = 4;
    for (int i = 0; i + 1 < args.Length; i++) {
      if (args[i] == "-i") input = args[++i];
      else if (args[i] == "-o") output = args[++i];
      else if (args[i] == "-s") scale = int.Parse(args[++i]);
      else if (args[i] == "-f") fmt = args[++i];
    }
    string mode = Environment.GetEnvironmentVariable("FAKE_UPSCAYL_MODE") ?? "vk";
    Console.Error.WriteLine("[0 Fake GPU One]  queueC=2[8]  queueG=0[16]  queueT=1[2]");
    Console.Error.WriteLine("[1 Fake GPU Two]  queueC=1[2]  queueG=0[1]  queueT=2[1]");
    if (Directory.Exists(input)) {
      Directory.CreateDirectory(output);
      string[] files = Directory.GetFiles(input);
      Array.Sort(files, StringComparer.Ordinal);
      for (int k = 0; k < files.Length; k++) {
        string ext = Path.GetExtension(files[k]).ToLowerInvariant();
        if (ext != ".png" && ext != ".jpg" && ext != ".webp") continue;
        bool bad = mode == "vk" || mode == "black" || (mode == "flaky" && k == 0);
        Write(files[k], Path.Combine(output, Path.GetFileNameWithoutExtension(files[k]) + "." + fmt), scale, bad, fmt);
        if (bad && mode != "black") Console.Error.WriteLine("vkQueueSubmit failed -4");
        Console.Error.WriteLine("0,00%");
        Console.Error.WriteLine("100.00");
        Console.Error.WriteLine("Upscayled Successfully!");
      }
    } else {
      string ext = Path.GetExtension(output).TrimStart('.').ToLowerInvariant();
      bool bad = mode == "vk" || mode == "black";
      Write(input, output, scale, bad, ext);
      if (mode == "vk") Console.Error.WriteLine("vkQueueSubmit failed -4");
      Console.Error.WriteLine("100.00");
    }
    return 0;
  }
  static void Write(string src, string dest, int scale, bool black, string fmt) {
    using (Image img = Image.FromFile(src)) {
      int w = img.Width * scale, h = img.Height * scale;
      using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format24bppRgb))
      using (Graphics g = Graphics.FromImage(bmp)) {
        if (black) g.Clear(Color.Black);
        else { g.InterpolationMode = InterpolationMode.HighQualityBilinear; g.DrawImage(img, 0, 0, w, h); }
        bmp.Save(dest, fmt == "jpg" ? ImageFormat.Jpeg : ImageFormat.Png);
      }
    }
  }
}
`;

function buildFakeUpscayl(root) {
  const csc = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(csc)) return null;
  // csc.exe and System.Drawing do not need the non-ASCII part of the temp path: keep the fake in a plain folder.
  const plainRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-fake-upscayl-'));
  const binDir = path.join(plainRoot, 'fake-upscayl', 'resources', 'bin');
  const modelsDir = path.join(plainRoot, 'fake-upscayl', 'resources', 'models');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(modelsDir, { recursive: true });
  for (const f of ['upscayl-lite-4x.param', 'upscayl-lite-4x.bin']) fs.writeFileSync(path.join(modelsDir, f), 'fake');
  const src = path.join(plainRoot, 'fake-upscayl', 'fake.cs');
  fs.writeFileSync(src, FAKE_UPSCAYL_CS);
  const exe = path.join(binDir, 'upscayl-bin.exe');
  const r = child_process.spawnSync(csc, ['/nologo', '/target:exe', `/out:${exe}`, '/r:System.Drawing.dll', src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error(`csc failed: ${r.stdout}${r.stderr}`);
  void root;
  return { exe, root: plainRoot };
}

function upscaylProcesses() {
  if (!IS_WIN) return 0;
  const ps = child_process.spawnSync('tasklist', ['/FI', 'IMAGENAME eq upscayl-bin.exe', '/NH'], { encoding: 'utf8', windowsHide: true });
  return ((ps.stdout || '').match(/upscayl-bin\.exe/gi) || []).length;
}

async function main() {
  assert.ok(fs.existsSync(REPO_PYTHON), `Python not found: ${REPO_PYTHON}`);
  assert.ok(fs.existsSync(UPSCAYL_BIN), `upscayl-bin not found: ${UPSCAYL_BIN}`);
  fs.mkdirSync(TMP_PARENT, { recursive: true });
  const root = fs.mkdtempSync(path.join(TMP_PARENT, 'scm-upscayl-int é ü-'));
  const userData = path.join(root, 'userData');
  const dataDir = path.join(root, 'data');
  const ws = path.join(root, 'ws');
  console.log(`temp: ${root}`);
  const busyBefore = upscaylProcesses();

  // ---- temp workspace: engine code + test images ------------------------------------------
  fs.mkdirSync(ws, { recursive: true });
  for (const name of fs.readdirSync(ENGINE)) {
    const full = path.join(ENGINE, name);
    if ((name.endsWith('.py') || name === 'requirements.txt') && fs.statSync(full).isFile()) fs.copyFileSync(full, path.join(ws, name));
  }
  const noCache = (s, e) => !(e.isDirectory() && e.name === '__pycache__') && !s.endsWith('.pyc');
  copyDir(path.join(ENGINE, 'assets'), path.join(ws, 'assets'), noCache);
  copyDir(path.join(ENGINE, 'plugins'), path.join(ws, 'plugins'), noCache);
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output', 'upscaled']) fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  const front = path.join(ws, 'game', 'front');
  const backDir = path.join(ws, 'game', 'back');
  fs.mkdirSync(path.join(front, 'sub'), { recursive: true });
  const copies = [
    ['1_mtg.png', '1_mtg.png'],
    ['1_mtg.png', 'sub/1_mtg copy.png'], // identical bytes: upscaled once, hardlinked twice
    ['2_cube.jpg', '2_cube.jpg'],
    ['3_pokemon.jpg', '3_pokemon.jpg'],
    ['4_lorcana.webp', '4_lorcana.webp'],
  ];
  for (const [src, dest] of copies) fs.copyFileSync(path.join(TEST_IMAGES, src), path.join(front, dest));
  fs.copyFileSync(path.join(TEST_IMAGES, '6_digimon.jpg'), path.join(backDir, 'back.jpg'));
  python(String.raw`
import json, sys
from PIL import Image
a = json.load(sys.stdin)
up = Image.open(a['exifSrc']).convert('RGB')
stored = up.rotate(90, expand=True)          # stored sideways ...
exif = Image.Exif(); exif[0x0112] = 6         # ... EXIF says "rotate 90 CW to display"
stored.save(a['exifDest'], 'JPEG', quality=92, exif=exif.tobytes())
Image.open(a['cmykSrc']).convert('CMYK').save(a['cmykDest'], 'JPEG', quality=92)
print('null')
`, {
    exifSrc: path.join(TEST_IMAGES, '5_one_piece.jpg'),
    exifDest: path.join(front, 'exif6.jpg'),
    cmykSrc: path.join(TEST_IMAGES, '8_fab.jpg'),
    cmykDest: path.join(front, 'cmyk.jpg'),
  });
  const FRONT_RELS = ['1_mtg.png', '2_cube.jpg', '3_pokemon.jpg', '4_lorcana.webp', 'cmyk.jpg', 'exif6.jpg', 'sub/1_mtg copy.png'];

  // ---- deps from real modules ---------------------------------------------------------------
  const settings = createSettingsStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 20 });
  settings.update({ pythonPath: REPO_PYTHON }, { internal: true });
  settings.update({ setupComplete: true, upscayl: { model: 'upscayl-lite-4x' }, pdf: { options: { ppi: 1440, paper_size: 'a4', card_size: 'standard' } } });
  const emitted = [];
  const hooks = [];
  const scmCacheDir = path.join(dataDir, 'scm-cache');
  const deps = {
    app: { getVersion: () => 'integration', isPackaged: false },
    settings,
    getPaths: () => getPaths({
      isPackaged: false, appDir: APP_DIR, userData, appData: root, documents: root, localAppData: null,
      platform: process.platform, env: { SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: dataDir }, settings: settings.get(),
    }),
    jobs: new JobManager({ logsDir: path.join(userData, 'logs'), scmCacheDir, cancelGraceMs: 30000 }),
    locks: createLocks(),
    logger: {
      info: (...m) => VERBOSE && console.log('      [info]', ...m),
      warn: (...m) => VERBOSE && console.log('      [warn]', ...m),
      error: (...m) => console.log('      [error]', ...m),
    },
    hashCache: createHashCache(path.join(scmCacheDir, 'hashes.json')),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    addShutdownHook: (fn) => hooks.push(fn),
  };
  deps.helper = createHelper(() => deps);
  if (VERBOSE) {
    deps.jobs.on('event', (evt) => {
      if (evt.type === 'log') for (const l of evt.lines) console.log(`      [${l.stream}] ${l.line}`);
      else if (evt.type === 'progress' && evt.label) console.log(`      progress ${evt.percent === null ? '…' : `${evt.percent}%`} ${evt.label}`);
    });
  }
  const paths = deps.getPaths();
  const upscaledFront = path.join(paths.upscaledRoot, 'front');
  const manifestFile = path.join(paths.upscaledRoot, 'manifest.json');
  const readManifest = () => JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const runJob = async (start) => {
    const jobId = await start();
    const id = typeof jobId === 'string' ? jobId : jobId.jobId;
    return deps.jobs.whenFinished(id);
  };
  /** Run runUpscale inside a raw job and return { summary, result } (the result keeps `files`). */
  const runDirect = async (opts, { kind = 'upscale', derive = false, onStart } = {}) => {
    let result = null;
    const jobId = deps.jobs.start(kind, { title: `Upscaling (${kind})` }, async (ctx) => {
      const warnings = [];
      // pdf.js passes a derived context (ctx is frozen): Object.create(ctx, { warn })
      const useCtx = derive ? Object.create(ctx, { warn: { value: (m) => { warnings.push(String(m)); ctx.warn(m); }, enumerable: true } }) : ctx;
      result = await upscayl.runUpscale(useCtx, deps, opts);
      return { ok: true, derivedWarnings: warnings };
    });
    if (onStart) onStart(jobId);
    const summary = await deps.jobs.whenFinished(jobId);
    return { summary, result, log: deps.jobs.getLog(jobId) };
  };
  const dirRuns = (log) => (log.match(/in_(png|jpg|webp)_s\d(?![\\/])/g) || []).length;
  const sources = FRONT_RELS.map((rel) => path.join(front, ...rel.split('/'))).concat(path.join(backDir, 'back.jpg'));
  const srcInfo = measure(sources);
  const realModelsDir = path.resolve(path.dirname(UPSCAYL_BIN), '..', 'models');
  const timings = {};

  await check('status: Upscayl found through the registry (InstallLocation empty → DisplayIcon)', async () => {
    const st = await upscayl.getUpscaylStatus(deps, { refresh: true });
    assert.equal(st.found, true, st.error || 'not found');
    assert.equal(path.resolve(st.binPath).toLowerCase(), path.resolve(UPSCAYL_BIN).toLowerCase());
    assert.equal(st.modelsDir.toLowerCase(), realModelsDir.toLowerCase());
    assert.equal(st.models.length, 7, st.models.map((m) => m.id).join(','));
    assert.deepEqual(st.models.filter((m) => m.nonCommercial).map((m) => m.id).sort(), ['remacri-4x', 'ultramix-balanced-4x', 'ultrasharp-4x']);
    assert.ok(st.models.every((m) => m.scale === 4 && !m.custom));
    assert.equal(st.effectiveModel, 'upscayl-lite-4x');
    assert.equal(st.gpus, null);
    return `source=${st.source} version=${st.version} bin=${st.binPath}`;
  });

  await check(`GPU probe job returns the ${EXPECT_GPUS} GPUs of this machine and caches them in settings`, async () => {
    const summary = await runJob(() => upscayl.startGpuProbeJob(deps));
    assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
    const { gpus, works } = summary.result;
    assert.equal(gpus.length, EXPECT_GPUS, JSON.stringify(gpus));
    assert.deepEqual(gpus.map((g) => g.id), [...Array(EXPECT_GPUS).keys()]);
    assert.equal(works, true);
    assert.deepEqual(settings.get().upscayl.gpus, gpus);
    const st = await upscayl.getUpscaylStatus(deps, {});
    assert.deepEqual(st.gpus, gpus);
    assert.equal(fs.readdirSync(paths.tmpDir).filter((n) => n.startsWith('probe-')).length, 0, 'probe files removed');
    timings.probeMs = summary.result.durationMs;
    return `${gpus.map((g) => `#${g.id} ${g.name}`).join(' | ')} in ${summary.result.durationMs} ms`;
  });

  await check('cacheInfo before any upscale', async () => {
    const info = await upscayl.cacheInfo(deps);
    assert.equal(info.files, 0);
    assert.equal(info.available, true);
    assert.equal(info.total, 8, JSON.stringify(info));
    assert.equal(info.needed, 8);
    assert.equal(info.unique, 7);
    assert.equal(info.upToDate, 0);
    return `needed=${info.needed} unique=${info.unique} secEst=${info.secEst}s bytesEst=${(info.bytesEst / 1e6).toFixed(0)}MB`;
  });

  let firstManifest = null;
  await check('Upscale now at 1440 PPI (fronts + common back): dedupe, EXIF upright, CMYK colors, manifest', async () => {
    const summary = await runJob(() => upscayl.startUpscaleJob(deps, { targets: { front: true, back: true, double_sided: false } }));
    assert.equal(summary.status, 'succeeded', summary.error && `${summary.error.message}\n${summary.error.details}`);
    const r = summary.result;
    assert.equal(r.files, undefined, 'the job result has no files map');
    assert.equal(r.total, 8);
    assert.equal(r.unique, 7, 'identical copies are upscaled once');
    assert.equal(r.upscaled, 8);
    assert.equal(r.fallbacks, 0, summary.warnings.join(' | '));
    assert.equal(r.cached, 0);
    assert.deepEqual(summary.warnings, []);
    const outs = {};
    for (const rel of FRONT_RELS) {
      const ext = rel.endsWith('.png') ? 'png' : rel.endsWith('.webp') ? 'webp' : 'jpg';
      outs[path.join(front, ...rel.split('/'))] = path.join(upscaledFront, ...rel.replace(/\.[^.]+$/, `.${ext}`).split('/'));
    }
    outs[path.join(backDir, 'back.jpg')] = path.join(paths.upscaledRoot, 'back', 'back.jpg');
    for (const out of Object.values(outs)) assert.ok(fs.existsSync(out), `missing ${out}`);
    const outInfo = measure(Object.values(outs));
    for (const [src, out] of Object.entries(outs)) {
      const s = srcInfo[src];
      const o = outInfo[out];
      assert.equal(o.w, s.w * 4, `${out} width ${o.w} vs ${s.w}×4`);
      assert.equal(o.h, s.h * 4, `${out} height ${o.h} vs ${s.h}×4`);
      assert.ok(Math.abs(o.mean - s.mean) < 12, `${out} brightness ${o.mean.toFixed(1)} vs ${s.mean.toFixed(1)}`);
    }
    const exifOut = outInfo[outs[path.join(front, 'exif6.jpg')]];
    assert.ok(exifOut.w < exifOut.h, 'EXIF-rotated card is upright (portrait)');
    assert.equal(exifOut.mode, 'RGB', 'and no longer depends on EXIF');
    const cmykSrc = srcInfo[path.join(front, 'cmyk.jpg')];
    const cmykOut = outInfo[outs[path.join(front, 'cmyk.jpg')]];
    assert.equal(cmykSrc.mode, 'CMYK');
    for (let c = 0; c < 3; c += 1) assert.ok(Math.abs(cmykOut.rgb[c] - cmykSrc.rgb[c]) < 15, `CMYK channel ${c}: ${cmykOut.rgb[c]} vs ${cmykSrc.rgb[c]}`);
    const a = fs.statSync(path.join(upscaledFront, '1_mtg.png'));
    const b = fs.statSync(path.join(upscaledFront, 'sub', '1_mtg copy.png'));
    assert.equal(a.ino, b.ino, 'duplicates are hardlinks of one output');
    firstManifest = readManifest();
    assert.equal(firstManifest.version, 2);
    assert.equal(Object.keys(firstManifest.entries).length, 8);
    const e = firstManifest.entries['front/exif6.jpg'];
    assert.equal(e.kind, 'front');
    assert.equal(e.src, 'exif6.jpg');
    assert.equal(e.scale, 4);
    assert.match(e.key, /^[0-9a-f]{40}\|upscayl-lite-4x\|.+\|s4\|jpg\|c0\|tta0$/);
    assert.ok(!fs.existsSync(path.join(paths.upscaledRoot, '.staging')), 'staging removed');
    assert.ok(typeof settings.get().upscayl.secPerImage === 'number');
    timings.liteRunMs = r.durationMs;
    return `${r.durationMs} ms for ${r.unique} unique (secPerImage now ${r.secPerImage})`;
  });

  await check('isCardUpscaled + settingsKeyFn/createKeyFn + loadManifest agree with the run (cards.js usage)', async () => {
    const manifest = upscayl.loadManifest(deps);
    const keyFn = await upscayl.createKeyFn(deps);
    const images = await scanImages(front, { hash: true, hashCache: deps.hashCache });
    assert.equal(images.length, 7);
    const syncKeyFn = upscayl.settingsKeyFn(deps);
    for (const img of images) {
      assert.equal(upscayl.isCardUpscaled(manifest, keyFn, { ...img, kind: 'front' }), true, img.rel);
      assert.equal(upscayl.isCardUpscaled(manifest, syncKeyFn, { ...img, kind: 'front' }), true, `${img.rel} (sync key)`);
      assert.equal(syncKeyFn({ ...img, kind: 'front' }), keyFn({ ...img, kind: 'front' }));
    }
    settings.update({ upscayl: { model: 'upscayl-standard-4x' } });
    const otherKeyFn = await upscayl.createKeyFn(deps);
    assert.equal(upscayl.isCardUpscaled(manifest, otherKeyFn, { ...images[0], kind: 'front' }), false, 'another model → not up to date');
    assert.equal(upscayl.isCardUpscaled(manifest, upscayl.settingsKeyFn(deps), { ...images[0], kind: 'front' }), false, 'another model → not up to date (sync)');
    settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
  });

  await check('second run is fully cached', async () => {
    const summary = await runJob(() => upscayl.startUpscaleJob(deps, { targets: { front: true, back: true, double_sided: false } }));
    assert.equal(summary.status, 'succeeded');
    assert.equal(summary.result.cached, 8);
    assert.equal(summary.result.upscaled, 0);
    assert.equal(summary.result.unique, 0);
    assert.deepEqual(readManifest(), firstManifest);
    timings.cachedRunMs = summary.result.durationMs;
    return `${summary.result.durationMs} ms`;
  });

  await check('600 PPI: smart scale picks 2×/3×/4× per image, stale 4× copies are replaced', async () => {
    settings.update({ pdf: { options: { ppi: 600 } } });
    const { summary, result } = await runDirect({ kinds: ['front'], targetPpi: 600, cardWidthIn: 63 / 25.4 });
    assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
    const outInfo = measure(Object.values(result.files.front));
    for (const [rel, out] of Object.entries(result.files.front)) {
      const s = srcInfo[path.join(front, ...rel.split('/'))];
      const ppi = s.w / (63 / 25.4);
      const expected = ppi * 2 >= 600 ? 2 : ppi * 3 >= 600 ? 3 : 4;
      assert.equal(outInfo[out].w, s.w * expected, `${rel}: ${outInfo[out].w} vs ${s.w}×${expected}`);
      assert.ok(out.startsWith(upscaledFront), out);
    }
    assert.equal(result.upscaled, 6, 'every card whose scale changed is upscaled again');
    assert.equal(result.cached, 1, '2_cube.jpg keeps 4× at 600 PPI: still cached');
    const scales = new Set(Object.values(readManifest().entries).filter((e) => e.kind === 'front').map((e) => e.scale));
    assert.ok(scales.size >= 2, `several scales in one run: ${[...scales]}`);
    assert.ok(readManifest().entries['back/back.jpg'], 'back entry untouched (kind not processed)');
    return `scales ${[...scales].join('/')} in ${result.durationMs} ms`;
  });

  await check('300 PPI: sharp cards use the original, their upscaled copies are pruned', async () => {
    const { summary, result } = await runDirect({ kinds: ['front'], targetPpi: 300 });
    assert.equal(summary.status, 'succeeded');
    const sharpRels = Object.entries(result.files.front).filter(([rel, abs]) => abs === path.join(front, ...rel.split('/'))).map(([rel]) => rel);
    assert.equal(result.sharp, sharpRels.length);
    assert.deepEqual(sharpRels.sort(), ['1_mtg.png', 'sub/1_mtg copy.png'], '745 px = 300.4 PPI: already sharp');
    assert.equal(result.upscaled, 5);
    for (const rel of sharpRels) {
      const ext = rel.endsWith('.png') ? 'png' : rel.endsWith('.webp') ? 'webp' : 'jpg';
      assert.ok(!fs.existsSync(path.join(upscaledFront, ...rel.replace(/\.[^.]+$/, `.${ext}`).split('/'))), `pruned ${rel}`);
    }
    settings.update({ pdf: { options: { ppi: 1440 } } });
    return `sharp=${result.sharp} upscaled=${result.upscaled} staleRemoved=${result.staleRemoved}`;
  });

  await check('inside a pdf job with a derived ctx (as pdf.js calls it): warnings reach the wrapper, files map for every card', async () => {
    settings.update({ upscayl: { model: 'no-such-model-4x' } });
    const { summary, result } = await runDirect({ kinds: ['front', 'back'], targetPpi: 1440, cardWidthIn: 63 / 25.4, onlyBackFile: 'back.jpg' }, { kind: 'pdf', derive: true });
    settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
    assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
    assert.equal(result.model, 'upscayl-standard-4x', 'missing model → Upscayl Standard');
    assert.ok(summary.result.derivedWarnings.some((w) => /isn't available, so "Upscayl Standard" was used instead/.test(w)), summary.result.derivedWarnings.join(' | '));
    assert.deepEqual(Object.keys(result.files.front).sort(), FRONT_RELS.slice().sort());
    assert.equal(result.files.back['back.jpg'], path.join(paths.upscaledRoot, 'back', 'back.jpg'));
    for (const abs of [...Object.values(result.files.front), ...Object.values(result.files.back)]) assert.ok(fs.existsSync(abs), abs);
    timings.standardRunMs = result.durationMs;
    timings.standardUnique = result.unique;
    return `${result.unique} unique with upscayl-standard-4x in ${result.durationMs} ms`;
  });

  await check('preview job returns scm-img URLs for the original and the upscaled image', async () => {
    const summary = await runJob(() => upscayl.startPreviewJob(deps, { kind: 'front', rel: 'exif6.jpg' }));
    assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
    const r = summary.result;
    assert.match(r.before, /^scm-img:\/\/file\/[A-Za-z0-9_-]+\?v=\d+$/);
    assert.match(r.after, /^scm-img:\/\/file\/[A-Za-z0-9_-]+\?v=\d+$/);
    const beforePath = decodePath(new URL(r.before).pathname.slice(1));
    const afterPath = decodePath(new URL(r.after).pathname.slice(1));
    assert.ok(beforePath.startsWith(paths.previewDir) && afterPath.startsWith(paths.previewDir));
    assert.ok(fs.existsSync(beforePath) && fs.existsSync(afterPath));
    const s = srcInfo[path.join(front, 'exif6.jpg')];
    assert.deepEqual([r.beforeSize.width, r.beforeSize.height], [s.w, s.h]);
    assert.deepEqual([r.afterSize.width, r.afterSize.height], [s.w * r.scale, s.h * r.scale]);
    assert.equal(r.scale, 4);
    assert.match(r.afterCaption, /^\d+ × \d+ px · [\d.]+ MB$/);
    timings.previewSec = r.seconds;
    return `${r.beforeCaption} → ${r.afterCaption} in ${r.seconds} s`;
  });

  await check('a model that is not installed falls back to an available one (with a warning)', async () => {
    settings.update({ upscayl: { model: 'no-such-model-4x', format: 'webp', compression: 60 } });
    const summary = await runJob(() => upscayl.startUpscaleJob(deps, { targets: { back: true } }));
    settings.update({ upscayl: { model: 'upscayl-lite-4x', format: 'same', compression: 0 } });
    assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
    assert.equal(summary.result.model, 'upscayl-standard-4x');
    assert.equal(summary.result.upscaled, 1);
    assert.ok(summary.warnings.some((w) => /isn't available/.test(w)), summary.warnings.join(' | '));
    const webp = path.join(paths.upscaledRoot, 'back', 'back.webp');
    assert.ok(fs.existsSync(webp), 'WebP output');
    assert.equal(fs.readFileSync(webp).toString('ascii', 8, 12), 'WEBP');
    return summary.warnings[0];
  });

  const fake = IS_WIN ? buildFakeUpscayl(root) : null;
  if (!fake) {
    console.log('SKIP  failure simulations (csc.exe not available)');
  } else {
    const withFake = async (mode, fn) => {
      process.env.SCM_UPSCAYL_BIN = fake.exe;
      process.env.FAKE_UPSCAYL_MODE = mode;
      settings.update({ upscayl: { enabled: true, gpus: null, gpusDetectedFor: null } });
      try {
        return await fn();
      } finally {
        delete process.env.SCM_UPSCAYL_BIN;
        delete process.env.FAKE_UPSCAYL_MODE;
      }
    };

    await check('fake GPU failure (black images + vkQueueSubmit failed): retries, circuit breaker, fallback, not cached, auto-off', () => withFake('vk', async () => {
      const st = await upscayl.getUpscaylStatus(deps, {});
      assert.equal(st.source, 'env');
      assert.equal(st.binPath, fake.exe);
      const { summary, result, log } = await runDirect({ kinds: ['front'], targetPpi: 1440 });
      assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
      assert.equal(result.unique, 6);
      assert.equal(result.uniqueUpscaled, 0);
      assert.equal(result.uniqueFailed, 6);
      assert.equal(result.fallbacks, 7);
      assert.equal(result.retried, 3);
      assert.equal((log.match(/Retrying /g) || []).length, 3, 'stops after 3 consecutive GPU failures');
      assert.ok(summary.warnings.some((w) => /couldn't use your graphics card, so the remaining images were not upscaled/.test(w)), summary.warnings.join(' | '));
      assert.ok(summary.warnings.some((w) => /^Could not upscale 7 images/.test(w)), summary.warnings.join(' | '));
      assert.ok(summary.warnings.some((w) => /Upscaling was turned off/.test(w)));
      assert.equal(result.disabledUpscaling, true);
      assert.equal(settings.get().upscayl.enabled, false);
      for (const [rel, abs] of Object.entries(result.files.front)) {
        assert.equal(sha1(abs), sha1(path.join(front, ...rel.split('/'))), `${rel}: the original bytes are used`);
      }
      const m = readManifest();
      assert.equal(Object.keys(m.entries).filter((k) => k.startsWith('front/')).length, 0, 'fallbacks are not cached');
      return `${result.durationMs} ms; ${dirRuns(log)} folder runs; warnings: ${summary.warnings.length}`;
    }));

    await check('fake silent failure (black images, no error text): every image retried, validation rejects all', () => withFake('black', async () => {
      const { summary, result, log } = await runDirect({ kinds: ['front'], targetPpi: 1440 });
      assert.equal(summary.status, 'succeeded');
      assert.equal(result.fallbacks, 7);
      assert.equal((log.match(/Retrying /g) || []).length, 6, 'no circuit breaker without GPU error text');
      assert.ok(/blank image/.test(log), 'the reason is in the log');
      assert.equal(result.disabledUpscaling, true);
    }));

    await check('fake flaky GPU (first image of every folder run black, fine alone): retries succeed and are cached', () => withFake('flaky', async () => {
      const { summary, result, log } = await runDirect({ kinds: ['front'], targetPpi: 1440 });
      assert.equal(summary.status, 'succeeded');
      const runs = dirRuns(log);
      assert.equal(runs, 3, 'png, jpg and webp outputs: one folder run each');
      assert.equal(result.uniqueUpscaled, 6);
      assert.equal(result.fallbacks, 0, summary.warnings.join(' | '));
      assert.equal(result.retried, runs);
      assert.equal((log.match(/Retrying /g) || []).length, runs);
      assert.equal(result.disabledUpscaling, false);
      assert.equal(settings.get().upscayl.enabled, true);
      assert.equal(Object.keys(readManifest().entries).filter((k) => k.startsWith('front/')).length, 7);
    }));

    await check('"Upscale now" fails clearly when every image failed (warnings kept)', () => withFake('vk', async () => {
      const summary = await runJob(() => upscayl.startUpscaleJob(deps, { targets: { back: true } }));
      assert.equal(summary.status, 'failed');
      assert.equal(summary.error.code, 'UPSCAYL_FAILED');
      assert.match(summary.error.message, /^Upscayl couldn't upscale your images/);
      assert.ok(summary.warnings.some((w) => /Could not upscale back\.jpg/.test(w)), summary.warnings.join(' | '));
      return summary.error.message;
    }));

    await check('GPU probe with the fake binary lists its two fake GPUs', () => withFake('flaky', async () => {
      const summary = await runJob(() => upscayl.startGpuProbeJob(deps));
      assert.equal(summary.status, 'succeeded', summary.error && summary.error.message);
      assert.deepEqual(summary.result.gpus, [{ id: 0, name: 'Fake GPU One' }, { id: 1, name: 'Fake GPU Two' }]);
    }));
    settings.update({ upscayl: { enabled: true, gpus: null, gpusDetectedFor: null } });
    await upscayl.getUpscaylStatus(deps, { refresh: true });
  }

  await check('cancelling while Upscayl runs: process tree stopped, staging removed, manifest untouched', async () => {
    settings.update({ upscayl: { model: 'upscayl-standard-4x' } });
    const before = fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : null;
    let cancelAt = 0;
    const jobId = await upscayl.startUpscaleJob(deps, { targets: { front: true } });
    const onEvt = (evt) => {
      if (evt.jobId !== jobId || evt.type !== 'log') return;
      if (evt.lines.some((l) => l.line.startsWith('> ') && /upscayl-bin/i.test(l.line))) {
        deps.jobs.off('event', onEvt);
        cancelAt = Date.now();
        setTimeout(() => deps.jobs.cancel(jobId), 300);
      }
    };
    deps.jobs.on('event', onEvt);
    const summary = await deps.jobs.whenFinished(jobId);
    deps.jobs.off('event', onEvt);
    settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
    assert.equal(summary.status, 'cancelled');
    assert.ok(cancelAt > 0, 'Upscayl was started');
    assert.ok(!fs.existsSync(path.join(paths.upscaledRoot, '.staging', jobId)), 'staging removed');
    assert.equal(fs.existsSync(manifestFile) ? fs.readFileSync(manifestFile, 'utf8') : null, before);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(upscaylProcesses(), busyBefore, 'no upscayl-bin process left');
    return `stopped ${summary.endedAt - cancelAt} ms after Upscayl started`;
  });

  await check('cancelling after some chunks keeps their upscaled images (resumed by the next run)', async () => {
    settings.update({ upscayl: { model: 'upscayl-standard-4x' } });
    let seen = 0;
    let jobRef = null;
    const onEvt = (evt) => {
      if (!jobRef || evt.jobId !== jobRef || evt.type !== 'log') return;
      for (const l of evt.lines) if (l.line.startsWith('> ') && /upscayl-bin/i.test(l.line)) seen += 1;
      if (seen >= 3) {
        deps.jobs.off('event', onEvt);
        deps.jobs.cancel(jobRef);
      }
    };
    deps.jobs.on('event', onEvt);
    const { summary } = await runDirect({ kinds: ['front'], targetPpi: 1440, chunkSize: 1 }, { onStart: (id) => { jobRef = id; } });
    deps.jobs.off('event', onEvt);
    assert.equal(summary.status, 'cancelled');
    const kept = Object.entries(readManifest().entries).filter(([k, e]) => k.startsWith('front/') && e.key.includes('|upscayl-standard-4x|'));
    assert.ok(kept.length >= 2, `kept ${kept.length}`);
    for (const [destRel] of kept) assert.ok(fs.existsSync(path.join(paths.upscaledRoot, ...destRel.split('/'))), destRel);
    assert.ok(!fs.existsSync(path.join(paths.upscaledRoot, '.staging')), 'staging removed');
    const next = await runDirect({ kinds: ['front'], targetPpi: 1440 });
    settings.update({ upscayl: { model: 'upscayl-lite-4x' } });
    assert.equal(next.summary.status, 'succeeded');
    assert.equal(next.result.cached, kept.length, 'finished chunks are reused');
    assert.equal(next.result.cached + next.result.upscaled, 7);
    return `kept ${kept.length} of 7 after cancelling; the next run upscaled ${next.result.upscaled}`;
  });

  await check('clearCache refuses while a job runs, then empties game/upscaled', async () => {
    const jobId = deps.jobs.start('preview', { title: 'Holding' }, (ctx) => new Promise((resolve) => ctx.signal.addEventListener('abort', resolve)));
    await assert.rejects(upscayl.clearCache(deps), /^Error: BUSY: wait until "Holding" finishes$/);
    deps.jobs.cancel(jobId);
    await deps.jobs.whenFinished(jobId);
    const info = await upscayl.cacheInfo(deps);
    assert.ok(info.files > 0);
    const res = await upscayl.clearCache(deps);
    assert.equal(res.removed, info.files, 'upscaled images (the manifest is not counted)');
    assert.deepEqual(fs.readdirSync(paths.upscaledRoot), []);
    assert.ok(emitted.some((e) => e.channel === 'cards:changed'));
    const after = await upscayl.cacheInfo(deps);
    assert.equal(after.files, 0);
    assert.equal(after.upToDate, after.sharp);
    return `removed ${res.removed} files (${(res.bytes / 1e6).toFixed(1)} MB)`;
  });

  for (const hook of hooks) await hook();
  await settings.flush();
  await deps.hashCache.flush();

  // The repository's own game/ must be untouched by all of this.
  await check('the repository game/ folder was not used', async () => {
    assert.ok(!fs.existsSync(path.join(ENGINE, 'game', 'upscaled', 'manifest.json')) || fs.statSync(path.join(ENGINE, 'game', 'upscaled', 'manifest.json')).mtimeMs < Date.now() - 3600 * 1000);
  });

  console.log(`\ntimings: ${JSON.stringify(timings)}`);
  if (!flag('--keep')) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    if (fake) fs.rmSync(fake.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } else {
    console.log(`kept: ${root}`);
  }
  console.log(`${results.length - failures}/${results.length} checks passed`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
