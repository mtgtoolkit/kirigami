#!/usr/bin/env node
'use strict';

/**
 * Integration checks for scm_helper.py + helper.js + workspace.js + python-env.js + registry.js
 * against the REAL engine and the repository's Python, without Electron.
 *
 * Safety: the engine code is copied into a TEMP managed workspace with ensureWorkspace(); the
 * repository's game/, data/ and venv are only read (never written). Bytecode writing is disabled.
 *
 * Usage (from electron-app/):
 *   node test/integration/helper.int.js                     # helper commands + registry
 *   node test/integration/helper.int.js --with-setup        # + real uv setup job in temp dirs
 *   node test/integration/helper.int.js --write-fixture     # + regenerate test/fixtures/introspection.json
 * Options: --uv <path to uv.exe> (default: build/uv/uv(.exe), then uv on PATH), --python <python>,
 *          --keep (keep the temp folder), --tmp <dir> (parent folder for temp data).
 */

const assert = require('node:assert/strict');
const child_process = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHelper, fallbackPythonEnv } = require('../../src/main/helper');
const workspace = require('../../src/main/workspace');
const pythonEnv = require('../../src/main/python-env');
const registry = require('../../src/main/registry');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENGINE = path.resolve(APP_DIR, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const exe = (name) => (process.platform === 'win32' ? `${name}.exe` : name);
const REPO_PYTHON = option('--python', process.env.SCM_INT_PYTHON || path.join(ENGINE, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe('python')));
const TMP_PARENT = option('--tmp', os.tmpdir());

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
    console.log(`FAIL  ${name} (${ms} ms)\n      ${String(err.stack || err).split('\n').slice(0, 6).join('\n      ')}`);
    if (err.details) console.log(`      details: ${String(err.details).split('\n').slice(-8).join('\n      ')}`);
  }
}

function makeLocks() {
  let exclusive = false;
  let shared = 0;
  return {
    async withPythonShared(fn) {
      if (exclusive) throw new Error('Setting up the card maker components…');
      shared += 1;
      try {
        return await fn();
      } finally {
        shared -= 1;
      }
    },
    async withPythonExclusive(fn) {
      exclusive = true;
      try {
        return await fn();
      } finally {
        exclusive = false;
      }
    },
    pythonBusy: () => exclusive || shared > 0,
  };
}

/** Minimal job runner with the §5.1 ctx API (spawn with line splitting, timeouts, JobProcessError-like failures). */
function makeJobs(scmCacheDir, logPrefix) {
  let active = null;
  return {
    active: () => active,
    isMutating: () => !!active,
    start(kind, meta, executor) {
      if (active) throw new Error(`BUSY: ${active.title}`);
      const jobId = `int-${Date.now().toString(36)}`;
      const controller = new AbortController();
      const ctx = {
        jobId,
        signal: controller.signal,
        cancelled: false,
        log: (line, stream = 'info') => {
          if (process.env.SCM_INT_VERBOSE || stream === 'warn') console.log(`      ${logPrefix}[${stream}] ${line}`);
        },
        progress: ({ percent, label }) => {
          if (label && process.env.SCM_INT_VERBOSE) console.log(`      ${logPrefix}${percent === null || percent === undefined ? '...' : `${percent}%`} ${label}`);
        },
        step: (id, status, label) => console.log(`      ${logPrefix}step ${id}: ${status}${label ? ` (${label})` : ''}`),
        warn: (m) => console.log(`      ${logPrefix}warning: ${m}`),
        throwIfCancelled: () => {
          if (ctx.cancelled) throw Object.assign(new Error('Cancelled'), { name: 'CancelledError' });
        },
        pythonEnv: (extra) => fallbackPythonEnv(process.env, extra, scmCacheDir),
        spawn: (cmd, argv, { cwd, env, onLine, allowNonZero = false, timeoutMs } = {}) =>
          new Promise((resolve, reject) => {
            const tail = { stdout: [], stderr: [] };
            let child;
            try {
              child = child_process.spawn(cmd, argv, { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
            } catch (err) {
              reject(Object.assign(new Error(`Could not start ${path.basename(cmd)}`), { code: err.code }));
              return;
            }
            const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
            for (const stream of ['stdout', 'stderr']) {
              let carry = '';
              child[stream].on('data', (chunk) => {
                const parts = (carry + chunk.toString('utf8')).split(/\r\n|\n|\r/);
                carry = parts.pop();
                for (const line of parts) {
                  tail[stream].push(line);
                  if (tail[stream].length > 30) tail[stream].shift();
                  ctx.log(line, stream);
                  if (onLine) onLine(line, stream);
                }
              });
            }
            child.on('error', (err) => {
              if (timer) clearTimeout(timer);
              reject(Object.assign(new Error(`Could not start ${path.basename(cmd)}`), { code: err.code }));
            });
            child.on('close', (code, signal) => {
              if (timer) clearTimeout(timer);
              if (code !== 0 && !allowNonZero) {
                reject(Object.assign(new Error(`${path.basename(cmd)} exited with code ${code}`), { code, signal, stderrTail: tail.stderr, stdoutTail: tail.stdout, command: [cmd, ...argv].join(' ') }));
              } else resolve({ code, signal });
            });
          }),
      };
      active = { jobId, kind, title: meta.title };
      const promise = Promise.resolve()
        .then(() => executor(ctx))
        .finally(() => {
          active = null;
        });
      this.last = { jobId, promise };
      return jobId;
    },
  };
}

function makeDeps({ dataDir, workspaceDir, pythonPath, venvDir, isDev, appOwnedVenv, bundledUv, settings = {} }) {
  const state = { workspaceDir: null, venvDir: null, pythonPath: null, ...settings };
  const scmCacheDir = path.join(dataDir, 'scm-cache');
  const deps = {
    app: { getVersion: () => 'integration', isPackaged: !isDev },
    settings: { get: () => ({ ...state }), update: (patch) => Object.assign(state, patch) },
    logger: { info() {}, warn: (m) => process.env.SCM_INT_VERBOSE && console.log(`      warn: ${m}`), error: (m) => console.log(`      error: ${m}`) },
    emit() {},
    locks: makeLocks(),
    getPaths: () => ({
      isDev,
      engineSourceDir: ENGINE,
      dataDir,
      workspaceDir: state.workspaceDir || workspaceDir,
      venvDir: state.venvDir || venvDir,
      pythonPath: state.pythonPath || pythonPath,
      appOwnedVenv,
      uvPythonDir: path.join(dataDir, 'python'),
      uvCacheDir: path.join(dataDir, 'uv-cache'),
      binDir: path.join(dataDir, 'bin'),
      scmCacheDir,
      helperScript: path.join(APP_DIR, 'src', 'python', 'scm_helper.py'),
      bundledUv: bundledUv || path.join(APP_DIR, 'build', 'uv', exe('uv')),
      outputDir: path.join(dataDir, 'output'),
      stageRoot: path.join(state.workspaceDir || workspaceDir, 'game', '.stage'),
      trashRoot: path.join(state.workspaceDir || workspaceDir, 'game', '.trash'),
      upscaledRoot: path.join(state.workspaceDir || workspaceDir, 'game', 'upscaled'),
    }),
  };
  deps.jobs = makeJobs(scmCacheDir, '');
  deps.helper = createHelper(() => deps);
  return deps;
}

function runPython(python, argv, { cwd, env } = {}) {
  const r = child_process.spawnSync(python, argv, { cwd, env: env || fallbackPythonEnv(process.env, {}, null), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`python ${argv.join(' ')} failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}

const VERIFY_LAYOUTS_PY = String.raw`
import contextlib, io, json, os, sys
sys.dont_write_bytecode = True
root, intro_path, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
sys.path.insert(0, root)
with contextlib.redirect_stdout(io.StringIO()):
    import utilities, page_manager
from PIL import Image
calls = {}
real_layout = page_manager.generate_layout
def spy_layout(**kw):
    r = real_layout(**kw); calls['layout'] = (kw, r); return r
def spy_reg(paper_width, paper_height, inset, thickness, length, dpi, registration):
    calls['reg'] = dict(paper_width=paper_width, inset=inset, thickness=thickness, length=length)
    return Image.new('RGB', (8, 8), 'white')
page_manager.generate_layout = spy_layout
page_manager.generate_reg_mark = spy_reg
for d in ('front', 'back', 'double_sided'):
    os.makedirs(os.path.join(tmp, d), exist_ok=True)
intro = json.load(open(intro_path, encoding='utf-8'))
bad = []
layouts = intro['layouts']['combos'] + intro['layouts']['specialty']
for lay in layouts:
    calls.clear()
    with contextlib.redirect_stdout(io.StringIO()):
        utilities.generate_pdf(os.path.join(tmp, 'front'), os.path.join(tmp, 'back'), os.path.join(tmp, 'double_sided'),
            os.path.join(tmp, 'x.pdf'), False, lay['card'] or 'standard', lay['paper'] or 'letter', '3', True, 'stretch', None,
            None, None, None, None, None, None, None, None, 72, 100, [], False, None,
            specialty=lay['specialty'], borderless=lay['variant'] == 'borderless')
    kw, r = calls['layout']; reg = calls['reg']
    ok = (list(r.x_pos) == lay['xPos'] and list(r.y_pos) == lay['yPos']
          and (r.card_width_px, r.card_height_px, r.paper_width_px, r.paper_height_px) == (lay['cardWidthPx'], lay['cardHeightPx'], lay['paperWidthPx'], lay['paperHeightPx'])
          and kw['inset'] == lay['inset'] and kw['length'] == lay['exclusionLength'] and kw['orientation'].value == lay['orientation']
          and reg['inset'] == lay['inset'] and reg['thickness'] == lay['thickness'] and reg['length'] == lay['length']
          and reg['paper_width'] == (lay['paperHeight'] if lay['registrationOrientation'] == 'portrait' else lay['paperWidth']))
    if not ok:
        bad.append(lay['key'])
print(json.dumps({'checked': len(layouts), 'mismatches': bad}))
`;

async function main() {
  console.log(`Engine: ${ENGINE}`);
  console.log(`Python: ${REPO_PYTHON}`);
  assert.ok(fs.existsSync(REPO_PYTHON), `Python not found: ${REPO_PYTHON}`);
  const tmp = fs.mkdtempSync(path.join(TMP_PARENT, 'scm-int-'));
  console.log(`Temp:   ${tmp}`);
  const dataDir = path.join(tmp, 'data');
  const ws = path.join(dataDir, 'workspace');
  const deps = makeDeps({ dataDir, workspaceDir: ws, pythonPath: REPO_PYTHON, venvDir: path.dirname(path.dirname(REPO_PYTHON)), isDev: false, appOwnedVenv: false });
  const helper = deps.helper;
  let intro = null;

  await check('ensureWorkspace copies the real engine into a temp managed workspace', async () => {
    const r = await workspace.ensureWorkspace(deps);
    assert.equal(r.mode, 'managed');
    assert.equal(r.updated, true);
    for (const rel of ['create_pdf.py', 'utilities.py', 'page_manager.py', 'assets/layouts.json', 'plugins/mtg/fetch.py', 'requirements.txt']) {
      assert.ok(fs.existsSync(path.join(ws, rel)), rel);
    }
    assert.ok(!fs.existsSync(path.join(ws, 'cutting_templates')), 'templates stay in the engine source');
    for (const kind of workspace.GAME_KINDS) assert.ok(fs.existsSync(path.join(ws, 'game', kind)), kind);
    const again = await workspace.ensureWorkspace(deps);
    assert.equal(again.updated, false);
    return `${(await workspace.listEngineFiles(ENGINE)).length} engine files`;
  });

  await check('checkEnv with the repository venv (custom/dev style, read-only)', async () => {
    const status = await pythonEnv.checkEnv(deps, { refresh: true });
    assert.equal(status.workspace.ok, true, status.workspace.error);
    assert.equal(status.python.ok, true, status.python.error);
    assert.equal(status.python.packagesOk, true, `missing: ${status.python.missing}`);
    assert.equal(status.ready, true);
    return `python ${status.python.version}, upscayl found=${status.upscayl && status.upscayl.found}, silhouette found=${status.silhouetteStudio.found}`;
  });

  await check('introspect (real engine, temp workspace root, engine root for templates)', async () => {
    intro = await helper.introspect({ force: true });
    assert.equal(intro.plugins.length, 22);
    assert.equal(intro.plugins.filter((p) => p.params.length > 0 && !p.error).length, 22);
    assert.equal(intro.commands.create_pdf.params.length, 29);
    assert.equal(intro.commands.offset_pdf.params.length, 7);
    assert.equal(intro.engineVersion, '3.0.0');
    const { combos, specialty } = intro.layouts;
    assert.equal(combos.length, 228);
    assert.equal(specialty.length, 2);
    assert.equal(combos.filter((c) => c.error).length, 0);
    assert.equal(combos.filter((c) => c.orientation === 'portrait').length, 84);
    assert.equal(combos.filter((c) => !c.templateFile).length, 38);
    const a4 = combos.find((c) => c.key === 'a4|standard|default');
    assert.equal(a4.cardsPerPage, 8);
    assert.equal(a4.template, 'a4-standard-v5');
    assert.ok(path.isAbsolute(a4.templateFile) && fs.existsSync(a4.templateFile), a4.templateFile);
    assert.ok(a4.templateFile.toLowerCase().startsWith(ENGINE.toLowerCase()));
    const portrait = combos.find((c) => c.key === 'letter|bridge|borderless');
    assert.equal(portrait.orientation, 'portrait');
    assert.equal(portrait.cardsPerPage, 9);
    for (const s of specialty) {
      assert.equal(s.templateFile, null);
      assert.equal(s.cardsPerPage, 100);
      assert.ok(s.key.startsWith('specialty:'));
    }
    assert.deepEqual(intro.layouts.aliases.card, { mini_american: 'american_mini', photo: 'euro_business', mini_euro: 'euro_mini', euro_poker: 'standard' });
    assert.deepEqual(intro.layouts.aliases.paper, { ansi_a: 'letter', ansi_b: 'tabloid' });
    assert.equal(path.resolve(intro.root).toLowerCase(), path.resolve(ws).toLowerCase());
    return `${combos.length} combos + ${specialty.length} specialty; a4|standard|default = ${a4.cardsPerPage}/page`;
  });

  await check('introspect cache: second call is served from cache', async () => {
    const t0 = Date.now();
    const again = await helper.introspect();
    assert.equal(again, intro);
    const fresh = createHelper(() => deps);
    const fromDisk = await fresh.introspect();
    assert.equal(fromDisk.layouts.combos.length, 228);
    assert.ok(fs.existsSync(path.join(dataDir, 'scm-cache', 'introspection.json')));
    return `${Date.now() - t0} ms for memory + disk cache hits`;
  });

  await check('layout geometry equals utilities.generate_pdf for every combo', async () => {
    const script = path.join(tmp, 'verify_layouts.py');
    const introFile = path.join(tmp, 'intro.json');
    fs.writeFileSync(script, VERIFY_LAYOUTS_PY);
    fs.writeFileSync(introFile, JSON.stringify(intro));
    const out = JSON.parse(runPython(REPO_PYTHON, [script, ws, introFile, path.join(tmp, 'vl')], { cwd: ws, env: fallbackPythonEnv(process.env, {}, path.join(dataDir, 'scm-cache')) }).trim());
    assert.equal(out.checked, 230);
    assert.deepEqual(out.mismatches, []);
    return `${out.checked} layouts identical`;
  });

  let reqFile;
  await check('env-check with the generated runtime requirements', async () => {
    reqFile = await pythonEnv.runtimeRequirementsFile(deps);
    const text = fs.readFileSync(reqFile, 'utf8');
    for (const dist of ['ezdxf', 'pyautogui', 'pywinauto', 'split-image']) assert.ok(!text.includes(dist), dist);
    const r = await helper.run('env-check', ['--requirements', reqFile]);
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.ok('matplotlib' in r.modules && 'PIL' in r.modules && 'pypdfium2' in r.modules);
    return Object.entries(r.modules).map(([k, v]) => `${k}=${v}`).join(' ');
  });

  const smokeDir = path.join(tmp, 'smoke');
  await check('smoke-test renders a PDF at 72 ppi', async () => {
    const r = await helper.run('smoke-test', ['--tmp', smokeDir], { timeoutMs: 180000 });
    assert.equal(r.ok, true);
    assert.equal(r.pages, 1);
    assert.ok(fs.statSync(path.join(smokeDir, 'smoke.pdf')).size > 0);
    return `${r.seconds} s in Python`;
  });

  let prepared = [];
  await check('prepare-upscale normalizes the test images to PNG', async () => {
    const imagesDir = path.join(ENGINE, 'test', 'images');
    const names = fs.readdirSync(imagesDir).filter((n) => /\.(png|jpe?g|webp)$/i.test(n));
    const items = names.map((n) => ({ src: path.join(imagesDir, n), dest: path.join(tmp, 'prep', `${path.parse(n).name}.png`) }));
    items.push({ src: path.join(tmp, 'missing.png'), dest: path.join(tmp, 'prep', 'missing.png') });
    const r = await helper.run('prepare-upscale', [], { list: { items } });
    prepared = r.results.filter((x) => x.ok);
    assert.equal(prepared.length, names.length);
    assert.equal(r.results[r.results.length - 1].ok, false);
    for (const x of prepared) {
      assert.ok(fs.existsSync(x.dest));
      assert.ok(x.width > 0 && x.height > 0 && x.std > 2);
      assert.ok(['png', 'jpeg', 'webp'].includes(x.sniffed), x.sniffed);
    }
    return prepared.map((x) => `${path.basename(x.src)}:${x.sniffed}:${x.width}x${x.height}`).join(' ');
  });

  await check('validate-images accepts good images and rejects size/blank/brightness problems', async () => {
    const good = prepared[0];
    const items = [
      { path: good.dest, expectWidth: good.width, expectHeight: good.height, refMean: good.mean, refStd: good.std },
      { path: good.dest, expectWidth: good.width * 4, expectHeight: good.height * 4, refMean: good.mean, refStd: good.std },
      { path: good.dest, expectWidth: good.width, expectHeight: good.height, refMean: good.mean + 80, refStd: good.std },
      { path: path.join(tmp, 'nope.png') },
    ];
    const r = await helper.run('validate-images', [], { list: { items } });
    assert.deepEqual(r.results.map((x) => x.ok), [true, false, false, false]);
    return r.results.map((x) => x.reason || 'ok').join(' | ');
  });

  await check('list-images uses the engine rules (non-images ignored, nested folders, unicode)', async () => {
    const dir = path.join(tmp, 'list', 'front');
    fs.mkdirSync(path.join(dir, 'sub é'), { recursive: true });
    fs.copyFileSync(prepared[0].dest, path.join(dir, 'a.png'));
    fs.copyFileSync(prepared[1].dest, path.join(dir, 'sub é', 'b [1].png'));
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    const r = await helper.run('list-images', ['--dir', dir]);
    assert.deepEqual(r.files, ['a.png', 'sub é/b [1].png']);
    return `${r.count} files`;
  });

  const merged = path.join(tmp, 'merged.pdf');
  await check('merge-pdfs joins PDFs losslessly', async () => {
    const second = path.join(tmp, 'smoke2');
    await helper.run('smoke-test', ['--tmp', second], { timeoutMs: 180000 });
    const r = await helper.run('merge-pdfs', ['--output', merged, '--inputs', path.join(smokeDir, 'smoke.pdf'), path.join(second, 'smoke.pdf')]);
    assert.equal(r.ok, true);
    assert.equal(r.pages, 2);
    assert.ok(fs.statSync(merged).size > 0);
    return `${r.pages} pages, ${r.bytes} bytes in ${r.seconds} s`;
  });

  await check('pdf-info reads pages, size and PPI', async () => {
    const r = await helper.run('pdf-info', ['--pdf', merged]);
    assert.equal(r.pages, 2);
    assert.equal(r.widthIn, 11);
    assert.equal(r.heightIn, 8.5);
    assert.equal(r.ppi, 72);
    return JSON.stringify(r);
  });

  await check('helper errors are friendly (missing PDF)', async () => {
    await assert.rejects(helper.run('pdf-info', ['--pdf', path.join(tmp, 'missing.pdf')]), (err) => {
      assert.ok(err.message && !/Traceback/.test(err.message), err.message);
      assert.ok(err.pythonError && err.pythonError.type === 'HelperError', JSON.stringify(err.pythonError));
      return true;
    });
  });

  await check('registry: Upscayl and Silhouette Studio (one PowerShell call each, UTF-8 JSON)', async () => {
    if (process.platform !== 'win32') return 'skipped (not Windows)';
    registry.clearCache();
    const t0 = Date.now();
    const upscayl = await registry.queryUninstall('Upscayl*', { refresh: true });
    const ms = Date.now() - t0;
    const studio = await registry.findSilhouetteStudio({ refresh: true });
    const icon = upscayl[0] && registry.exePathFromDisplayIcon(upscayl[0].DisplayIcon);
    if (fs.existsSync('D:\\Tools\\Upscaly\\Upscayl\\Upscayl.exe')) {
      assert.ok(upscayl.length >= 1, 'Upscayl is installed on this machine');
      assert.equal(path.dirname(icon).toLowerCase(), 'd:\\tools\\upscaly\\upscayl');
    }
    return `Upscayl: ${JSON.stringify(upscayl)} (${ms} ms); Silhouette Studio: ${JSON.stringify(studio)}`;
  });

  if (flag('--write-fixture')) {
    await check('regenerate test/fixtures/introspection.json from the repository engine', async () => {
      const outFile = path.join(tmp, 'fixture.json');
      const env = fallbackPythonEnv(process.env, {}, path.join(dataDir, 'scm-cache'));
      runPython(REPO_PYTHON, [path.join(APP_DIR, 'src', 'python', 'scm_helper.py'), 'introspect', '--root', ENGINE, '--engine-root', ENGINE, '--out', outFile], { cwd: ENGINE, env });
      const data = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      assert.equal(data.layouts.combos.length, 228);
      fs.writeFileSync(path.join(APP_DIR, 'test', 'fixtures', 'introspection.json'), `${JSON.stringify(data, null, 1)}\n`);
      return 'written';
    });
  }

  if (flag('--with-setup')) await setupChecks(tmp);

  if (!flag('--keep')) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  else console.log(`Kept ${tmp}`);
  console.log(`\n${results.filter((r) => r.ok).length} passed, ${failures} failed`);
  process.exitCode = failures ? 1 : 0;
}

function findUvBinary() {
  const explicit = option('--uv', process.env.SCM_INT_UV);
  if (explicit) return explicit;
  const bundled = path.join(APP_DIR, 'build', 'uv', exe('uv'));
  if (fs.existsSync(bundled)) return bundled;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(dir, exe('uv'));
    if (dir && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

async function setupChecks(tmp) {
  const uv = findUvBinary();
  if (!uv) {
    await check('setup job with uv', async () => {
      throw new Error('uv not found: pass --uv <path> (or run npm run fetch-uv)');
    });
    return;
  }
  // A packaged-like layout: app-owned venv in a temp data folder, bundled uv, managed workspace.
  const dataDir = path.join(tmp, 'setup data é');
  const venvDir = path.join(dataDir, 'venv');
  const deps = makeDeps({
    dataDir,
    workspaceDir: path.join(dataDir, 'workspace'),
    pythonPath: path.join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin', exe('python')),
    venvDir,
    isDev: false,
    appOwnedVenv: true,
    bundledUv: uv,
  });
  console.log(`      uv: ${uv}`);
  // Prefer the app's real JobManager + locks (validates the ctx/lock/error contracts end to end).
  let realJobs = false;
  if (!flag('--minimal-jobs')) {
    try {
      const { JobManager } = require('../../src/main/jobs');
      const { createLocks } = require('../../src/main/locks');
      const manager = new JobManager({ logsDir: path.join(dataDir, 'logs'), scmCacheDir: path.join(dataDir, 'scm-cache') });
      manager.on('event', (evt) => {
        if (evt.type === 'step') console.log(`      step ${evt.stepId}: ${evt.status}${evt.label ? ` (${evt.label})` : ''}`);
        if (evt.type === 'log' && process.env.SCM_INT_VERBOSE) for (const l of evt.lines) console.log(`      [${l.stream}] ${l.line}`);
      });
      deps.jobs = manager;
      deps.locks = createLocks();
      realJobs = true;
    } catch (err) {
      console.log(`      (real JobManager unavailable: ${err.message}; using the minimal runner)`);
    }
  }
  console.log(`      job runner: ${realJobs ? 'src/main/jobs.js JobManager + locks.js' : 'minimal test runner'}`);
  const runJob = async () => {
    const jobId = pythonEnv.startSetupJob(deps);
    assert.ok(jobId);
    if (!realJobs) return deps.jobs.last.promise;
    const summary = await deps.jobs.whenFinished(jobId);
    if (summary.status !== 'succeeded') {
      throw Object.assign(new Error(`setup job ${summary.status}: ${summary.error && summary.error.message}`), { details: summary.error && summary.error.details, jobError: summary.error });
    }
    return summary.result;
  };

  await check('setup job (cold): uv downloads Python 3.12, creates the venv, installs, verifies', async () => {
    const before = await pythonEnv.checkEnv(deps, { refresh: true });
    assert.equal(before.ready, false);
    const status = await runJob();
    assert.equal(status.ready, true, JSON.stringify(status.python));
    assert.equal(status.python.upToDate, true);
    assert.ok(fs.existsSync(path.join(venvDir, '.scm-requirements.sha1')));
    assert.ok(/^3\.12\./.test(status.python.version), status.python.version);
    return `Python ${status.python.version}`;
  });

  await check('setup job (warm): everything up to date -> straight to verify', async () => {
    const status = await runJob();
    assert.equal(status.ready, true);
  });

  await check('setup job (repair): broken app-owned venv is recreated with --clear', async () => {
    fs.rmSync(path.join(venvDir, 'pyvenv.cfg'), { force: true });
    const status = await runJob();
    assert.equal(status.ready, true);
  });

  await check('setup job: introspection works with the new environment', async () => {
    const data = await deps.helper.introspect({ force: true });
    assert.equal(data.layouts.combos.length, 228);
    return `python ${data.python.version}`;
  });

  await check('setup job: a broken non-app-owned venv fails with the friendly VENV_BROKEN error', async () => {
    const devLike = makeDeps({
      dataDir: path.join(tmp, 'dev-like'),
      workspaceDir: path.join(tmp, 'dev-like', 'workspace'),
      pythonPath: path.join(tmp, 'dev-like', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe('python')),
      venvDir: path.join(tmp, 'dev-like', 'venv'),
      isDev: false,
      appOwnedVenv: false,
      bundledUv: uv,
    });
    fs.mkdirSync(path.join(tmp, 'dev-like', 'venv'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'dev-like', 'venv', 'pyvenv.cfg'), 'home = C:\\nowhere\n');
    if (realJobs) {
      devLike.jobs = new (require('../../src/main/jobs').JobManager)({ scmCacheDir: path.join(tmp, 'dev-like', 'scm-cache') });
      devLike.locks = require('../../src/main/locks').createLocks();
      const summary = await devLike.jobs.whenFinished(pythonEnv.startSetupJob(devLike));
      assert.equal(summary.status, 'failed');
      assert.equal(summary.error.code, 'VENV_BROKEN');
      assert.match(summary.error.message, /^This Python environment is broken/);
      return summary.error.message;
    }
    pythonEnv.startSetupJob(devLike);
    await assert.rejects(devLike.jobs.last.promise, { code: 'VENV_BROKEN' });
    return 'rejected with VENV_BROKEN';
  });
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
