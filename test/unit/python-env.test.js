'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const env = require('../../src/main/python-env');

const REQUIREMENTS = [
  'click==8.4.2',
  'cloudscraper==1.2.71',
  'ezdxf==1.4.4',
  'filetype==1.2.0',
  'matplotlib==3.11.1',
  'pyautogui==0.9.54',
  'pywinauto==0.6.9',
  'pypdfium2==5.12.1',
  'split-image==2.0.5',
  '',
].join('\n');

const OK_CHECK = { ok: true, python: '3.12.15', pythonOk: true, executable: 'X:\\venv\\Scripts\\python.exe', modules: { click: '8.4.2' }, missing: [], mismatched: [] };
const MISSING_CHECK = { ok: false, python: '3.12.15', pythonOk: true, executable: 'X:\\venv\\Scripts\\python.exe', modules: { click: null }, missing: ['click', 'PIL'], mismatched: [] };

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'CancelledError';
  }
}

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-pyenv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

/** A minimal "healthy" venv on disk: interpreter + pyvenv.cfg. */
function makeVenvFiles(venvDir) {
  write(path.join(venvDir, 'Scripts', 'python.exe'), 'python');
  write(path.join(venvDir, 'pyvenv.cfg'), ['home = C:\\base', 'version_info = 3.12.15', ''].join('\n'));
}

/**
 * Builds deps for python-env with an external workspace, a fake helper and fake jobs/locks.
 * `scenario` controls what the fake helper and the fake ctx.spawn do. The workspace is also the
 * engine folder, like a development build linked to an engine checkout (`engineMode` 'linked').
 */
function makeEnv(t, { isDev = false, engineMode = isDev ? 'linked' : 'managed', appOwned = !isDev, bundledUv = true, pythonPath = null, settings = {}, scenario = {} } = {}) {
  const root = tmpDir(t);
  const ws = path.join(root, 'workspace');
  write(path.join(ws, 'create_pdf.py'), 'create');
  write(path.join(ws, 'requirements.txt'), REQUIREMENTS);
  const dataDir = path.join(root, 'data');
  const venvDir = path.join(dataDir, 'venv');
  const venvPython = path.join(venvDir, 'Scripts', 'python.exe');
  const uvPath = path.join(root, 'build', 'uv', 'uv.exe');
  if (bundledUv) write(uvPath, 'fake uv');
  const state = { installed: !!scenario.installed, settings: { pythonPath: null, venvDir: null, workspaceDir: null, ...settings } };
  const helperCalls = [];
  const settingsUpdates = [];
  const paths = () => ({
    isDev,
    engineMode,
    engineSourceDir: ws,
    workspaceDir: ws,
    dataDir,
    venvDir,
    pythonPath: state.settings.pythonPath || pythonPath || venvPython,
    appOwnedVenv: appOwned,
    uvPythonDir: path.join(dataDir, 'python'),
    uvCacheDir: path.join(dataDir, 'uv-cache'),
    scmCacheDir: path.join(dataDir, 'scm-cache'),
    bundledUv: uvPath,
    helperScript: path.join(root, 'scm_helper.py'),
    stageRoot: path.join(ws, 'game', '.stage'),
  });
  const helper = {
    invalidated: 0,
    invalidate() {
      helper.invalidated += 1;
    },
    async run(sub, args, opts = {}) {
      helperCalls.push({ sub, args, opts });
      if (scenario.helperError && scenario.helperError(sub)) throw scenario.helperError(sub);
      const python = paths().pythonPath;
      if (sub === 'env-check') {
        if (!fs.existsSync(python)) throw Object.assign(new Error('The card maker components are not installed yet.'), { code: 'NOT_INSTALLED' });
        if (scenario.envCheck) return scenario.envCheck(state);
        return state.installed ? OK_CHECK : MISSING_CHECK;
      }
      if (sub === 'smoke-test') {
        const tmp = args[args.indexOf('--tmp') + 1];
        write(path.join(tmp, 'smoke.pdf'), 'pdf');
        return { ok: true, seconds: 0.42, pages: 1 };
      }
      throw new Error(`unexpected helper command ${sub}`);
    },
  };
  const locks = {
    exclusive: 0,
    shared: 0,
    async withPythonExclusive(fn) {
      locks.exclusive += 1;
      return fn();
    },
    async withPythonShared(fn) {
      locks.shared += 1;
      return fn();
    },
  };
  const ctx = {
    jobId: 'job-1',
    signal: new AbortController().signal,
    cancelled: false,
    logs: [],
    steps: [],
    progressEvents: [],
    spawns: [],
    log(line, stream = 'info') {
      ctx.logs.push([stream, String(line)]);
    },
    progress(p) {
      ctx.progressEvents.push(p);
    },
    step(id, status, label) {
      ctx.steps.push([id, status, label]);
    },
    warn() {},
    throwIfCancelled() {
      if (ctx.cancelled) throw new CancelledError();
    },
    pythonEnv(extra) {
      return { BASE: '1', ...extra };
    },
    async spawn(cmd, args, opts = {}) {
      ctx.spawns.push({ cmd, args, opts });
      if (scenario.spawn) return scenario.spawn(cmd, args, opts, { state, paths: paths(), venvPython });
      // default: uv venv / python -m venv create the interpreter, installs mark packages installed
      if (args[0] === 'venv' || args.includes('venv')) makeVenvFiles(venvDir);
      if (args.includes('install')) state.installed = true;
      if (opts.onLine && args[0] === 'pip') {
        opts.onLine('Resolved 2 packages in 1.2s');
        opts.onLine(' + click==8.4.2');
        opts.onLine(' + pillow==12.3.0');
        opts.onLine('Installed 2 packages in 40ms');
      }
      return { code: 0 };
    },
  };
  const jobs = {
    started: [],
    activeJob: null,
    active: () => jobs.activeJob,
    start(kind, meta, executor) {
      const record = { kind, meta, promise: Promise.resolve().then(() => executor(ctx)) };
      record.promise.catch(() => {});
      jobs.started.push(record);
      return 'job-1';
    },
  };
  const deps = {
    getPaths: paths,
    settings: {
      get: () => ({ ...state.settings }),
      update: (patch, opts) => {
        settingsUpdates.push({ patch, opts });
        Object.assign(state.settings, patch);
      },
    },
    helper,
    locks,
    jobs,
    logger: { warn() {}, info() {}, error() {} },
    seams: {
      upscayl: { getUpscaylStatus: async () => ({ found: true, binPath: 'U:\\upscayl-bin.exe', models: [], gpus: null, error: null }) },
      registry: { findSilhouetteStudio: async () => ({ found: true, path: 'S:\\Silhouette Studio.exe', version: '5.0' }) },
    },
  };
  return { root, ws, dataDir, venvDir, venvPython, uvPath, deps, ctx, jobs, locks, helper, helperCalls, state, settingsUpdates };
}

async function runSetup(e, options) {
  const jobId = env.startSetupJob(e.deps, options);
  assert.equal(jobId, 'job-1');
  const record = e.jobs.started[e.jobs.started.length - 1];
  return { record, result: await record.promise };
}

function fakePythonSpawn(output, code = 0) {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setTimeout(() => {
      child.stdout.end(output);
      child.stderr.end();
      child.emit('close', code);
    }, 1);
    return child;
  };
  return { spawnImpl, calls };
}

// ------------------------------------------------------------------------------------------

test('buildRuntimeRequirements drops maintainer-only tools and keeps pins', () => {
  const text = '\uFEFFclick==8.4.2\r\nEZDXF==1.4.4\r\n# a comment\r\nsplit_image==2.0.5\r\nSplit.Image>=1\r\npillow==12.3.0 ; python_version >= "3.10"\r\n--index-url https://example.invalid\r\npyautogui\r\npywinauto==0.6.9\r\n\r\n\r\n';
  assert.equal(env.buildRuntimeRequirements(text), 'click==8.4.2\n# a comment\npillow==12.3.0 ; python_version >= "3.10"\n--index-url https://example.invalid\n');
  assert.equal(env.buildRuntimeRequirements(REQUIREMENTS), 'click==8.4.2\ncloudscraper==1.2.71\nfiletype==1.2.0\nmatplotlib==3.11.1\npypdfium2==5.12.1\n');
});

test('requirementName normalizes names and ignores non-requirements', () => {
  assert.equal(env.requirementName('Split_Image==2'), 'split-image');
  assert.equal(env.requirementName('  mtg_parser==0.0.1a55'), 'mtg-parser');
  assert.equal(env.requirementName('pillow[avif]>=12'), 'pillow');
  assert.equal(env.requirementName('# comment'), null);
  assert.equal(env.requirementName('-r other.txt'), null);
  assert.equal(env.requirementName(''), null);
});

test('runtimeRequirementsFile writes scm-cache/requirements-runtime.txt only when it changes', async (t) => {
  const e = makeEnv(t);
  const file = await env.runtimeRequirementsFile(e.deps);
  assert.equal(file, path.join(e.dataDir, 'scm-cache', 'requirements-runtime.txt'));
  assert.equal(fs.readFileSync(file, 'utf8'), env.buildRuntimeRequirements(REQUIREMENTS));
  const past = new Date(Date.now() - 60000);
  fs.utimesSync(file, past, past);
  await env.runtimeRequirementsFile(e.deps);
  assert.equal(Math.round(fs.statSync(file).mtimeMs), Math.round(past.getTime()), 'unchanged content is not rewritten');
  write(path.join(e.ws, 'requirements.txt'), 'click==9.0\n');
  await env.runtimeRequirementsFile(e.deps);
  assert.equal(fs.readFileSync(file, 'utf8'), 'click==9.0\n');
  fs.rmSync(path.join(e.ws, 'requirements.txt'));
  await assert.rejects(env.runtimeRequirementsFile(e.deps), { code: 'REQUIREMENTS_MISSING' });
});

test('markerFile: in the venv, or in scm-cache for a custom Python', () => {
  const paths = { venvDir: 'C:\\data\\venv', scmCacheDir: 'C:\\data\\scm-cache' };
  assert.equal(env.markerFile(paths, { pythonPath: null }), path.join('C:\\data\\venv', '.scm-requirements.sha1'));
  const custom = env.markerFile(paths, { pythonPath: 'C:\\Python312\\python.exe' });
  assert.equal(path.dirname(custom), 'C:\\data\\scm-cache');
  assert.match(path.basename(custom), /^custom-python-[0-9a-f]{12}\.scm-requirements\.sha1$/);
});

test('parsePythonVersion', () => {
  assert.deepEqual(env.parsePythonVersion('Python 3.12.3\n'), { major: 3, minor: 12, patch: 3, text: '3.12.3' });
  assert.deepEqual(env.parsePythonVersion('noise\nPython 3.13\n'), { major: 3, minor: 13, patch: 0, text: '3.13' });
  assert.equal(env.parsePythonVersion('Python was not found; run without arguments to install from the Microsoft Store'), null);
  assert.equal(env.parsePythonVersion('v24.19.0'), null);
  assert.equal(env.parsePythonVersion(undefined), null);
});

test('uvEnvVars: spec variables, system certs on Windows, copy mode across drives', () => {
  const same = env.uvEnvVars({ uvPythonDir: 'C:\\d\\python', uvCacheDir: 'C:\\d\\uv-cache', venvDir: 'C:\\d\\venv' }, { platform: 'win32' });
  assert.deepEqual(same, {
    UV_PYTHON_INSTALL_DIR: 'C:\\d\\python',
    UV_CACHE_DIR: 'C:\\d\\uv-cache',
    UV_NO_PROGRESS: '1',
    UV_MANAGED_PYTHON: '1',
    UV_NO_CONFIG: '1',
    UV_PYTHON_DOWNLOADS: 'automatic',
    UV_SYSTEM_CERTS: '1',
  });
  const cross = env.uvEnvVars({ uvPythonDir: 'C:\\d\\python', uvCacheDir: 'C:\\d\\uv-cache', venvDir: 'D:\\venv' }, { platform: 'win32' });
  assert.equal(cross.UV_LINK_MODE, 'copy');
  const posix = env.uvEnvVars({ uvPythonDir: os.tmpdir(), uvCacheDir: os.tmpdir(), venvDir: os.tmpdir() }, { platform: 'linux' });
  assert.equal(posix.UV_SYSTEM_CERTS, undefined);
  assert.equal(posix.UV_LINK_MODE, undefined);
});

test('findUv: bundled first; PATH only in development', (t) => {
  const root = tmpDir(t);
  const bundled = path.join(root, 'bundled', 'uv.exe');
  const onPath = path.join(root, 'onpath', 'uv.exe');
  write(onPath);
  const deps = (isDev, withBundled) => ({ getPaths: () => ({ isDev, bundledUv: withBundled ? bundled : path.join(root, 'none', 'uv.exe') }) });
  const searchEnv = { PATH: `${path.join(root, 'empty')};"${path.join(root, 'onpath')}"` };
  assert.deepEqual(env.findUv(deps(true, false), { env: searchEnv, platform: 'win32' }), { available: true, path: onPath, source: 'path' });
  assert.deepEqual(env.findUv(deps(false, false), { env: searchEnv, platform: 'win32' }), { available: false, path: null, source: null });
  write(bundled);
  assert.deepEqual(env.findUv(deps(false, true), { env: searchEnv, platform: 'win32' }), { available: true, path: bundled, source: 'bundled' });
  assert.deepEqual(env.findUv(deps(true, true), { env: searchEnv, platform: 'win32' }), { available: true, path: bundled, source: 'bundled' });
});

test('setupProgressLabel maps uv and pip lines', () => {
  assert.equal(env.setupProgressLabel('Downloading cpython-3.12.15-windows-x86_64-none (download) (21.0MiB)'), 'Downloading Python 3.12.15...');
  assert.equal(env.setupProgressLabel('Using CPython 3.12.15'), 'Using Python 3.12.15');
  assert.equal(env.setupProgressLabel('Creating virtual environment at: venv'), 'Creating the Python environment...');
  assert.equal(env.setupProgressLabel('Resolved 44 packages in 6.99s'), 'Found 44 components');
  assert.equal(env.setupProgressLabel('Downloading numpy (11.9MiB)'), 'Downloading numpy...');
  assert.equal(env.setupProgressLabel(' Downloaded numpy'), 'Downloaded numpy');
  assert.equal(env.setupProgressLabel('Installed 44 packages in 1.63s'), 'Installed 44 components');
  assert.equal(env.setupProgressLabel('Audited 11 packages in 5ms'), 'Components already installed');
  assert.equal(env.setupProgressLabel('Collecting click==8.4.2'), 'Downloading click==8.4.2...');
  assert.equal(env.setupProgressLabel('Successfully installed click-8.4.2'), 'Components installed');
  assert.equal(env.setupProgressLabel(' + click==8.4.2'), null);
});

test('explainFailure classifies network, disk, access and generic failures', () => {
  const mk = (tail) => Object.assign(new Error('Process exited with code 2'), { stderrTail: tail, command: 'uv pip install' });
  assert.equal(env.explainFailure(mk(['error: Failed to fetch: `https://pypi.org/simple/click/`', '  Caused by: dns error: No such host is known. (os error 11001)']), 'x').code, 'NETWORK');
  assert.equal(env.explainFailure(mk(['error: failed to write: There is not enough space on the disk. (os error 112)']), 'x').code, 'DISK_FULL');
  assert.equal(env.explainFailure(mk(['error: Access is denied. (os error 5)']), 'x').code, 'ACCESS_DENIED');
  const generic = env.explainFailure(mk(['error: No solution found when resolving dependencies']), 'install the card maker components');
  assert.equal(generic.code, 'SETUP_FAILED');
  assert.equal(generic.message, 'Could not install the card maker components.');
  assert.match(generic.details, /No solution found/);
  assert.match(generic.details, /uv pip install/);
});

// ------------------------------------------------------------------------------------------
// checkEnv

test('checkEnv: not installed yet', async (t) => {
  const e = makeEnv(t);
  const status = await env.checkEnv(e.deps);
  assert.equal(status.ready, false);
  assert.equal(status.workspace.ok, true);
  assert.equal(status.workspace.mode, 'external');
  assert.equal(status.python.ok, false);
  assert.equal(status.python.code, 'NOT_INSTALLED');
  assert.equal(status.python.source, 'venv');
  assert.equal(status.python.appOwned, true);
  assert.deepEqual(status.uv, { available: true, path: e.uvPath, source: 'bundled' });
  assert.equal(status.upscayl.found, true);
  assert.equal(status.silhouetteStudio.found, true);
  assert.equal(e.helperCalls.length, 0, 'no helper run without a Python');
});

test('checkEnv: dev venv is ready without a marker; result is cached until refresh', async (t) => {
  const e = makeEnv(t, { isDev: true, scenario: { installed: true } });
  makeVenvFiles(e.venvDir);
  const status = await env.checkEnv(e.deps);
  assert.equal(status.ready, true);
  assert.equal(status.python.ok, true);
  assert.equal(status.python.packagesOk, true);
  assert.equal(status.python.upToDate, false);
  assert.equal(status.python.version, '3.12.15');
  assert.equal(e.helperCalls.length, 1);
  assert.equal(e.helperCalls[0].sub, 'env-check');
  assert.equal(e.helperCalls[0].args[0], '--requirements');
  assert.equal(e.helperCalls[0].opts.timeoutMs, 60000);
  assert.equal(await env.checkEnv(e.deps), status, 'cached');
  assert.equal(e.helperCalls.length, 1);
  await env.checkEnv(e.deps, { refresh: true });
  assert.equal(e.helperCalls.length, 2);
  env.invalidateEnvCache(e.deps);
  await env.checkEnv(e.deps);
  assert.equal(e.helperCalls.length, 3);
});

test('checkEnv: the app-owned venv needs the current requirements marker', async (t) => {
  const e = makeEnv(t, { scenario: { installed: true } });
  makeVenvFiles(e.venvDir);
  const stale = await env.checkEnv(e.deps);
  assert.equal(stale.ready, false);
  assert.equal(stale.python.code, 'NEEDS_UPDATE');
  const reqFile = await env.runtimeRequirementsFile(e.deps);
  write(path.join(e.venvDir, '.scm-requirements.sha1'), `${sha1(fs.readFileSync(reqFile))}\n`);
  const fresh = await env.checkEnv(e.deps, { refresh: true });
  assert.equal(fresh.ready, true);
  assert.equal(fresh.python.upToDate, true);
  assert.equal(fresh.python.error, null);
});

test('checkEnv: missing packages, concurrent calls deduplicated, busy while setup runs', async (t) => {
  const e = makeEnv(t, { isDev: true });
  makeVenvFiles(e.venvDir);
  const [a, b] = await Promise.all([env.checkEnv(e.deps), env.checkEnv(e.deps)]);
  assert.equal(a, b);
  assert.equal(e.helperCalls.length, 1);
  assert.equal(a.ready, false);
  assert.equal(a.python.code, 'MISSING_PACKAGES');
  assert.deepEqual(a.python.missing, ['click', 'PIL']);

  e.helper.run = async () => {
    throw Object.assign(new Error('Setting up the card maker components…'), { code: 'PYTHON_BUSY' });
  };
  const busy = await env.checkEnv(e.deps, { refresh: true });
  assert.equal(busy.busy, true);
  assert.equal(busy.python.code, 'MISSING_PACKAGES', 'previous status returned');
  env.invalidateEnvCache(e.deps);
  const busyNoCache = await env.checkEnv(e.deps, { refresh: true });
  assert.equal(busyNoCache.busy, true);
  assert.equal(busyNoCache.ready, false);
  assert.equal(busyNoCache.python.code, 'PYTHON_BUSY');
});

test('checkEnv: a failing env-check is reported, not thrown', async (t) => {
  const e = makeEnv(t, { isDev: true, scenario: { helperError: () => Object.assign(new Error('Could not start Python'), { code: 'PYTHON_START_FAILED' }) } });
  write(e.venvPython, 'python');
  const status = await env.checkEnv(e.deps);
  assert.equal(status.ready, false);
  assert.equal(status.python.code, 'PYTHON_START_FAILED');
  assert.equal(status.python.error, 'Could not start Python');
});

// ------------------------------------------------------------------------------------------
// usePython / useAppVenv

test('usePython validates the file and the version, then stores it (internal)', async (t) => {
  const e = makeEnv(t, { isDev: true });
  const exe = path.join(e.root, 'Python312', 'python.exe');
  write(exe, 'python');
  await assert.rejects(env.usePython(e.deps, 'python.exe', { platform: 'win32' }), { code: 'BAD_PYTHON' });
  await assert.rejects(env.usePython(e.deps, path.join(e.root, 'python3'), { platform: 'win32' }), { code: 'BAD_PYTHON' });
  await assert.rejects(env.usePython(e.deps, path.join(e.root, 'missing.exe'), { platform: 'win32' }), { code: 'BAD_PYTHON' });
  await assert.rejects(env.usePython(e.deps, exe, { platform: 'win32', spawnImpl: fakePythonSpawn('', 9009).spawnImpl }), { code: 'BAD_PYTHON' });
  await assert.rejects(env.usePython(e.deps, exe, { platform: 'win32', spawnImpl: fakePythonSpawn('Python 3.8.10\n').spawnImpl }), { code: 'PYTHON_TOO_OLD' });
  await assert.rejects(env.usePython(e.deps, 42), TypeError);
  assert.equal(e.settingsUpdates.length, 0);

  const fake = fakePythonSpawn('Python 3.12.3\r\n');
  const status = await env.usePython(e.deps, exe, { platform: 'win32', spawnImpl: fake.spawnImpl });
  assert.deepEqual(fake.calls[0], { cmd: path.resolve(exe), args: ['--version'] });
  assert.deepEqual(e.settingsUpdates[0], { patch: { pythonPath: path.resolve(exe) }, opts: { internal: true } });
  assert.equal(status.python.source, 'custom');
  assert.equal(status.python.path, path.resolve(exe));
  assert.equal(e.helper.invalidated, 1);

  await env.usePython(e.deps, null);
  assert.deepEqual(e.settingsUpdates[1], { patch: { pythonPath: null }, opts: { internal: true } });

  e.jobs.activeJob = { jobId: 'x', title: 'Downloading cards' };
  await assert.rejects(env.usePython(e.deps, exe), (err) => err.code === 'BUSY' && err.message === 'BUSY: wait until "Downloading cards" finishes');
});

test('useAppVenv points the venv at the data folder', async (t) => {
  const e = makeEnv(t, { isDev: true, settings: { pythonPath: 'C:\\Python\\python.exe' } });
  await env.useAppVenv(e.deps);
  assert.deepEqual(e.settingsUpdates[0], { patch: { pythonPath: null, venvDir: path.join(e.dataDir, 'venv') }, opts: { internal: true } });
});

test('useAppVenv clears the venv setting when the data folder is already the default (managed engine)', async (t) => {
  for (const isDev of [false, true]) {
    const e = makeEnv(t, { isDev, engineMode: 'managed', settings: { pythonPath: 'C:\\Python\\python.exe' } });
    await env.useAppVenv(e.deps);
    assert.deepEqual(e.settingsUpdates[0], { patch: { pythonPath: null, venvDir: null }, opts: { internal: true } }, `isDev=${isDev}`);
  }
});

// ------------------------------------------------------------------------------------------
// Setup job

test('setup skips straight to verify when everything is installed and up to date', async (t) => {
  const e = makeEnv(t, { scenario: { installed: true } });
  makeVenvFiles(e.venvDir);
  const reqFile = await env.runtimeRequirementsFile(e.deps);
  write(path.join(e.venvDir, '.scm-requirements.sha1'), sha1(fs.readFileSync(reqFile)));
  const { record, result } = await runSetup(e);
  assert.equal(record.kind, 'setup');
  assert.deepEqual(record.meta.steps.map((s) => s.id), ['workspace', 'python', 'packages', 'verify']);
  assert.equal(e.locks.exclusive, 1);
  assert.deepEqual(e.ctx.spawns, []);
  assert.deepEqual(e.ctx.steps.map(([id, status]) => `${id}:${status}`), ['workspace:running', 'workspace:done', 'python:running', 'python:skipped', 'packages:skipped', 'verify:running', 'verify:done']);
  assert.deepEqual(e.helperCalls.map((c) => c.sub), ['env-check', 'smoke-test'], 'the fresh check is reused for verify');
  for (const call of e.helperCalls) {
    assert.equal(call.opts.lock, false, 'setup already holds the exclusive lock');
    assert.equal(call.opts.signal, e.ctx.signal);
  }
  assert.equal(e.helperCalls[0].opts.timeoutMs, 60000);
  assert.equal(e.helperCalls[1].opts.timeoutMs, 180000);
  const smokeDir = e.helperCalls[1].args[1];
  assert.ok(smokeDir.startsWith(path.join(e.dataDir, 'scm-cache', 'tmp')));
  assert.ok(!fs.existsSync(smokeDir), 'smoke-test folder removed');
  assert.equal(result.ready, true);
  assert.equal(e.ctx.progressEvents[e.ctx.progressEvents.length - 1].percent, 100);
  assert.ok(fs.existsSync(path.join(e.ws, 'game', 'front')), 'workspace prepared');
});

test('packaged first run: uv creates the venv (no --clear) and installs the runtime requirements', async (t) => {
  const e = makeEnv(t);
  const { result } = await runSetup(e);
  assert.equal(e.ctx.spawns.length, 2);
  const [create, install] = e.ctx.spawns;
  assert.equal(create.cmd, e.uvPath);
  assert.deepEqual(create.args, ['venv', e.venvDir, '--python', '3.12', '--managed-python', '--no-project', '--no-config']);
  assert.equal(create.opts.cwd, path.dirname(e.venvDir));
  assert.equal(create.opts.env.BASE, '1', 'built from ctx.pythonEnv');
  assert.equal(create.opts.env.UV_PYTHON_INSTALL_DIR, path.join(e.dataDir, 'python'));
  assert.equal(create.opts.env.UV_CACHE_DIR, path.join(e.dataDir, 'uv-cache'));
  assert.equal(create.opts.env.UV_MANAGED_PYTHON, '1');
  assert.equal(create.opts.env.UV_NO_CONFIG, '1');
  assert.equal(create.opts.env.UV_NO_PROGRESS, '1');
  assert.equal(create.opts.env.UV_PYTHON_DOWNLOADS, 'automatic');
  const reqFile = path.join(e.dataDir, 'scm-cache', 'requirements-runtime.txt');
  assert.deepEqual(install.args, ['pip', 'install', '--python', e.venvPython, '--no-config', '-r', reqFile]);
  assert.equal(install.opts.cwd, path.dirname(e.venvDir));
  assert.ok(install.opts.timeoutMs >= 10 * 60 * 1000);
  assert.equal(fs.readFileSync(path.join(e.venvDir, '.scm-requirements.sha1'), 'utf8').trim(), sha1(fs.readFileSync(reqFile)));
  assert.equal(result.ready, true);
  assert.equal(result.python.upToDate, true);
  assert.deepEqual(e.helperCalls.map((c) => c.sub), ['env-check', 'env-check', 'smoke-test'], 'a fresh check after installing');
  assert.ok(e.ctx.progressEvents.some((p) => p.label === 'Found 2 components'));
  assert.ok(e.ctx.progressEvents.some((p) => p.label === 'Installed 2 components' && p.percent === 88));
  assert.deepEqual(e.ctx.steps.filter(([, s]) => s === 'done').map(([id]) => id), ['workspace', 'python', 'packages', 'verify']);
});

test('the app-owned venv is recreated with --clear when it is broken', async (t) => {
  const e = makeEnv(t);
  write(path.join(e.venvDir, 'pyvenv.cfg'), 'home = C:\\deleted\\python');
  await runSetup(e);
  assert.deepEqual(e.ctx.spawns[0].args.slice(-1), ['--clear'], 'a recognizable venv needs no --force');
});

test('a broken development venv is never cleared', async (t) => {
  const e = makeEnv(t, { isDev: true });
  write(path.join(e.venvDir, 'pyvenv.cfg'), 'home = C:\\deleted\\python');
  const jobId = env.startSetupJob(e.deps);
  assert.equal(jobId, 'job-1');
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'VENV_BROKEN' && /Repair it in the app's own location, or choose another Python/.test(err.message));
  assert.deepEqual(e.ctx.spawns, []);
  assert.ok(fs.existsSync(path.join(e.venvDir, 'pyvenv.cfg')));
});

test('packaged without the bundled uv asks for a reinstall', async (t) => {
  const e = makeEnv(t, { bundledUv: false });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, { code: 'UV_MISSING' });
});

test('development without uv: python -m venv from the first Python >= 3.12, then pip', async (t) => {
  const e = makeEnv(t, {
    isDev: true,
    bundledUv: false,
    scenario: {
      spawn: (cmd, args, opts, { state, venvPython }) => {
        if (args[args.length - 1] === '--version') {
          if (cmd === 'py' && args[0] === '-3.12') throw Object.assign(new Error('Could not start py'), { code: 'ENOENT' });
          if (cmd === 'py' && args[0] === '-3') opts.onLine('Python 3.11.9');
          if (cmd === 'python') opts.onLine('Python 3.12.3');
          return { code: 0 };
        }
        if (args.includes('venv')) makeVenvFiles(path.dirname(path.dirname(venvPython)));
        if (args.includes('pip')) state.installed = true;
        return { code: 0 };
      },
    },
  });
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(e.root, 'no-uv-here');
  t.after(() => {
    process.env.PATH = savedPath;
  });
  const { result } = await runSetup(e);
  const calls = e.ctx.spawns.map((s) => [s.cmd, ...s.args].join(' '));
  assert.deepEqual(calls.slice(0, 3), ['py -3.12 --version', 'py -3 --version', 'python --version']);
  assert.equal(calls[3], `python -m venv ${e.venvDir}`);
  assert.equal(calls[4], `${e.venvPython} -m pip install --disable-pip-version-check -r ${path.join(e.dataDir, 'scm-cache', 'requirements-runtime.txt')}`);
  assert.ok(e.ctx.spawns[0].opts.timeoutMs <= 15000);
  assert.equal(e.ctx.spawns[0].opts.allowNonZero, true);
  assert.equal(result.ready, true);
});

test('development without uv and without Python 3.12 explains what to install', async (t) => {
  const e = makeEnv(t, {
    isDev: true,
    bundledUv: false,
    scenario: {
      spawn: (cmd, args, opts) => {
        opts.onLine && opts.onLine('Python 3.9.1');
        return { code: 0 };
      },
    },
  });
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(e.root, 'no-uv-here');
  t.after(() => {
    process.env.PATH = savedPath;
  });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'PYTHON_NOT_FOUND' && /Python 3\.12/.test(err.message));
});

test('custom Python: missing components need the explicit install choice', async (t) => {
  const custom = path.join(os.tmpdir(), `scm-custom-${process.pid}-${Date.now()}`, 'python.exe');
  write(custom, 'python');
  t.after(() => fs.rmSync(path.dirname(custom), { recursive: true, force: true }));
  const e = makeEnv(t, { isDev: true, settings: { pythonPath: custom } });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'CUSTOM_PYTHON_MISSING_PACKAGES' && /Install components into this Python/.test(err.message));
  assert.deepEqual(e.ctx.spawns, []);

  const e2 = makeEnv(t, { isDev: true, settings: { pythonPath: custom } });
  const { result } = await runSetup(e2, { installIntoCustom: true });
  assert.equal(e2.ctx.spawns.length, 1);
  assert.deepEqual(e2.ctx.spawns[0].args.slice(0, 4), ['pip', 'install', '--python', custom]);
  assert.equal(e2.ctx.spawns[0].opts.cwd, path.join(e2.dataDir, 'scm-cache'));
  assert.equal(result.python.source, 'custom');
  assert.equal(result.ready, true);
  const marker = env.markerFile(e2.deps.getPaths(), e2.deps.settings.get());
  assert.ok(marker.startsWith(path.join(e2.dataDir, 'scm-cache')));
  assert.ok(fs.existsSync(marker));
  assert.ok(!fs.existsSync(path.join(path.dirname(custom), '.scm-requirements.sha1')), "nothing written into the user's Python");
});

test('custom Python with all components is verified without installing', async (t) => {
  const custom = path.join(os.tmpdir(), `scm-custom-ok-${process.pid}-${Date.now()}`, 'python.exe');
  write(custom, 'python');
  t.after(() => fs.rmSync(path.dirname(custom), { recursive: true, force: true }));
  const e = makeEnv(t, { isDev: true, settings: { pythonPath: custom }, scenario: { installed: true } });
  const { result } = await runSetup(e);
  assert.deepEqual(e.ctx.spawns, []);
  assert.ok(e.ctx.steps.some(([id, status]) => id === 'packages' && status === 'skipped'));
  assert.equal(result.ready, true);
});

test('setup fails clearly when components are still missing after the install', async (t) => {
  const e = makeEnv(t, { scenario: { envCheck: () => MISSING_CHECK } });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'MISSING_PACKAGES' && /click, PIL/.test(err.message));
  assert.ok(!fs.existsSync(path.join(e.venvDir, '.scm-requirements.sha1')), 'no marker after a failed verify');
});

test('an install failure is explained (network) and cancellation passes through', async (t) => {
  const e = makeEnv(t, {
    scenario: {
      spawn: (cmd, args, opts, { venvPython }) => {
        if (args[0] === 'venv') {
          makeVenvFiles(path.dirname(path.dirname(venvPython)));
          return { code: 0 };
        }
        throw Object.assign(new Error('uv exited with code 2'), {
          name: 'JobProcessError',
          stderrTail: ['error: Failed to fetch: `https://pypi.org/simple/click/`', '  Caused by: error sending request'],
        });
      },
    },
  });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'NETWORK' && /internet connection/.test(err.message) && /pypi\.org/.test(err.details));

  const c = makeEnv(t, {
    scenario: {
      spawn: () => {
        throw new CancelledError();
      },
    },
  });
  env.startSetupJob(c.deps);
  await assert.rejects(c.jobs.started[0].promise, CancelledError);
});

test('a helper failure while the venv Python runs is reported instead of recreating the venv', async (t) => {
  const e = makeEnv(t, {
    scenario: { helperError: (sub) => (sub === 'env-check' ? Object.assign(new Error('Windows or your antivirus blocked Python'), { code: 'BLOCKED' }) : null) },
  });
  makeVenvFiles(e.venvDir);
  const probe = fakePythonSpawn('Python 3.12.15');
  e.deps.seams.spawnImpl = probe.spawnImpl;
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'BLOCKED' && /antivirus/.test(err.message));
  assert.deepEqual(probe.calls[0].args, ['--version']);
  assert.deepEqual(e.ctx.spawns, [], 'the venv was not recreated');
});

test('an app-owned venv whose Python does not start is recreated with --clear', async (t) => {
  let pythonBroken = true;
  const e = makeEnv(t, {
    scenario: {
      helperError: (sub) => (sub === 'env-check' && pythonBroken ? Object.assign(new Error('Could not start Python'), { code: 'PYTHON_START_FAILED' }) : null),
      spawn: (cmd, args, opts, { state, venvPython }) => {
        if (args[0] === 'venv') {
          makeVenvFiles(path.dirname(path.dirname(venvPython)));
          pythonBroken = false;
        }
        if (args.includes('install')) state.installed = true;
        return { code: 0 };
      },
    },
  });
  write(e.venvPython, 'python');
  const probe = fakePythonSpawn('', 103);
  e.deps.seams.spawnImpl = probe.spawnImpl;
  const { result } = await runSetup(e);
  assert.equal(probe.calls.length, 1, 'the interpreter was probed');
  assert.equal(e.ctx.spawns[0].args[0], 'venv');
  assert.ok(e.ctx.spawns[0].args.includes('--clear'));
  assert.equal(result.ready, true);
});

test('a venv whose Python runs outside it (pyvenv.cfg missing) is damaged: recreated if app-owned', async (t) => {
  const e = makeEnv(t, { scenario: { installed: true } });
  write(e.venvPython, 'python'); // interpreter present, pyvenv.cfg missing
  const status = await env.checkEnv(e.deps);
  assert.equal(status.ready, false);
  assert.equal(status.python.code, 'VENV_BROKEN');
  assert.match(status.python.error, /pyvenv\.cfg is missing/);
  const { result } = await runSetup(e);
  assert.deepEqual(e.ctx.spawns[0].args.slice(0, 2), ['venv', e.venvDir]);
  assert.deepEqual(e.ctx.spawns[0].args.slice(-2), ['--clear', '--force'], 'uv needs --force to clear a folder without pyvenv.cfg');
  assert.equal(result.ready, true);
});

test('a development venv reporting another prefix is refused, never cleared', async (t) => {
  const e = makeEnv(t, {
    isDev: true,
    scenario: { envCheck: () => ({ ...OK_CHECK, isVenv: false, prefix: 'C:\\Python312' }) },
  });
  makeVenvFiles(e.venvDir);
  const status = await env.checkEnv(e.deps);
  assert.equal(status.python.code, 'VENV_BROKEN');
  assert.match(status.python.error, /outside the environment/);
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'VENV_BROKEN' && /outside the environment/.test(err.details));
  assert.deepEqual(e.ctx.spawns, []);
});

test('env-check prefix equal to the venv folder is healthy (case-insensitive on Windows)', async (t) => {
  const e = makeEnv(t, { isDev: true, scenario: { envCheck: () => ({ ...OK_CHECK, isVenv: true, prefix: process.platform === 'win32' ? e2.venvDir.toUpperCase() : e2.venvDir }) } });
  const e2 = e;
  makeVenvFiles(e.venvDir);
  const status = await env.checkEnv(e.deps);
  assert.equal(status.python.code, null);
  assert.equal(status.ready, true);
});

test('an up-to-date marker does not hide a damaged venv (base Python with global packages)', async (t) => {
  const e = makeEnv(t, { scenario: { installed: true, envCheck: () => ({ ...OK_CHECK, isVenv: false, prefix: 'C:\\Python312' }) } });
  write(e.venvPython, 'python');
  const reqFile = await env.runtimeRequirementsFile(e.deps);
  write(path.join(e.venvDir, '.scm-requirements.sha1'), sha1(fs.readFileSync(reqFile)));
  env.startSetupJob(e.deps);
  await e.jobs.started[0].promise.catch(() => {});
  assert.ok(!e.ctx.steps.some(([id, status]) => id === 'python' && status === 'skipped'), 'not skipped');
  assert.equal(e.ctx.spawns[0].args[0], 'venv');
  assert.deepEqual(e.ctx.spawns[0].args.slice(-2), ['--clear', '--force']);
});

test('a custom Python that disappeared is reported as such', async (t) => {
  const e = makeEnv(t, { isDev: true, settings: { pythonPath: path.join(os.tmpdir(), 'scm-gone', 'python.exe') } });
  env.startSetupJob(e.deps);
  await assert.rejects(e.jobs.started[0].promise, (err) => err.code === 'BAD_PYTHON' && /can't be found anymore/.test(err.message));
});

test('startSetupJob propagates BUSY from jobs.start', (t) => {
  const e = makeEnv(t);
  e.jobs.start = () => {
    throw new Error('BUSY: Downloading cards');
  };
  assert.throws(() => env.startSetupJob(e.deps), /BUSY/);
});
