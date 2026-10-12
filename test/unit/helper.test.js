'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createHelper, SUBCOMMANDS, fallbackPythonEnv } = require('../../src/main/helper');

/**
 * Fake scm_helper: node runs this file with the same argv the real helper gets.
 * Behaviour is selected with `--mode <name>` (passed through helper.run args).
 */
const FAKE_HELPER = String.raw`
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const argv = process.argv.slice(2);
const sub = argv[0];
const all = (name) => argv.reduce((acc, a, i) => (a === name ? acc.concat([argv[i + 1]]) : acc), []);
const one = (name) => all(name)[0];
const out = one('--out');
const mode = one('--mode') || process.env.FAKE_MODE || 'ok';
const write = (obj) => fs.writeFileSync(out, JSON.stringify(obj));
const counter = process.env.FAKE_COUNTER;
if (counter) fs.appendFileSync(counter, sub + '\n');
switch (mode) {
  case 'ok': {
    const list = one('--list') ? JSON.parse(fs.readFileSync(one('--list'), 'utf8')) : null;
    process.stdout.write('engine noise on stdout\n');
    process.stderr.write('log line 1\r\nlog line 2 é\n');
    write({ ok: true, sub, argv, cwd: process.cwd(), list, listFile: one('--list') || null,
      env: { PYTHONUTF8: process.env.PYTHONUTF8, MPLBACKEND: process.env.MPLBACKEND, FAKE_MARK: process.env.FAKE_MARK || null, PYTHONPATH: process.env.PYTHONPATH || null } });
    break;
  }
  case 'introspect': {
    write({ commands: { create_pdf: { params: [{ name: 'ppi' }] }, offset_pdf: { params: [] } }, plugins: [{ id: 'mtg', params: [] }],
      layouts: { combos: [{ key: 'a4|standard|default' }], specialty: [] }, engineRoot: one('--engine-root'), stamp: Date.now() + Math.random() });
    break;
  }
  case 'incomplete':
    write({ commands: {} });
    break;
  case 'error':
    process.stderr.write('Traceback (most recent call last):\n  File "x.py", line 1\nValueError: bad value\n');
    write({ error: 'ValueError: bad value', type: 'ValueError', message: 'bad value', traceback: 'Traceback (most recent call last):\nValueError: bad value\n' });
    process.exit(1);
    break;
  case 'crash':
    process.stderr.write('Traceback (most recent call last):\n  File "utilities.py", line 9, in generate_pdf\nMemoryError\n');
    process.exit(1);
    break;
  case 'badjson':
    fs.writeFileSync(out, 'not json');
    break;
  case 'exit0-noout':
    break;
  case 'hang':
    setInterval(() => {}, 1000);
    break;
  case 'hang-tree': {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    fs.writeFileSync(one('--pidfile'), String(child.pid));
    setInterval(() => {}, 1000);
    break;
  }
  default:
    process.exit(3);
}
`;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-helper-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function setup(t, { overrides = {}, locks = null, workspace = true } = {}) {
  const root = tmpDir(t);
  const ws = path.join(root, 'workspace');
  if (workspace) {
    for (const rel of ['create_pdf.py', 'offset_pdf.py', 'utilities.py', 'page_manager.py', 'assets/layouts.json', 'plugins/mtg/fetch.py', 'plugins/mtg/deck_formats.py']) {
      fs.mkdirSync(path.dirname(path.join(ws, rel)), { recursive: true });
      fs.writeFileSync(path.join(ws, rel), rel);
    }
  }
  const engine = path.join(root, 'engine');
  fs.mkdirSync(path.join(engine, 'cutting_templates'), { recursive: true });
  const helperScript = path.join(root, 'fake_helper.js');
  fs.writeFileSync(helperScript, FAKE_HELPER);
  const counter = path.join(root, 'counter.txt');
  const paths = {
    pythonPath: process.execPath,
    helperScript,
    workspaceDir: ws,
    engineSourceDir: engine,
    scmCacheDir: path.join(root, 'scm-cache'),
  };
  const warnings = [];
  const deps = {
    getPaths: () => ({ ...paths }),
    locks,
    logger: { warn: (m) => warnings.push(m), info() {}, error() {} },
  };
  const envCalls = [];
  const helper = createHelper(() => deps, {
    pythonEnv: (base, extra, cacheDir) => {
      envCalls.push({ extra, cacheDir });
      return { ...fallbackPythonEnv(base, extra, cacheDir), FAKE_MARK: 'yes', FAKE_COUNTER: counter };
    },
    checkEnv: async () => ({ ready: true }),
    ...overrides,
  });
  const runs = () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').filter(Boolean) : []);
  return { root, ws, engine, paths, deps, helper, envCalls, runs, warnings };
}

function tmpLeftovers(paths) {
  const dir = path.join(paths.scmCacheDir, 'tmp');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith('helper-')) : [];
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('SUBCOMMANDS lists every helper command', () => {
  assert.deepEqual([...SUBCOMMANDS], ['introspect', 'env-check', 'smoke-test', 'prepare-upscale', 'validate-images', 'list-images', 'merge-pdfs', 'pdf-info']);
});

test('run passes --root/--out, uses the workspace cwd and pythonEnv, returns the JSON and cleans up', async (t) => {
  const { helper, ws, paths, envCalls } = setup(t);
  const lines = [];
  const result = await helper.run('pdf-info', ['--pdf', 'x.pdf'], { onLine: (line, stream) => lines.push([stream, line]) });
  assert.equal(result.ok, true);
  assert.equal(result.sub, 'pdf-info');
  assert.deepEqual(result.argv.slice(0, 3), ['pdf-info', '--root', ws]);
  assert.equal(result.argv[3], '--out');
  assert.ok(result.argv[4].startsWith(path.join(paths.scmCacheDir, 'tmp')));
  assert.deepEqual(result.argv.slice(5), ['--pdf', 'x.pdf']);
  assert.equal(path.resolve(result.cwd).toLowerCase(), path.resolve(ws).toLowerCase());
  assert.equal(result.env.PYTHONUTF8, '1');
  assert.equal(result.env.MPLBACKEND, 'Agg');
  assert.equal(result.env.FAKE_MARK, 'yes');
  assert.equal(envCalls[0].cacheDir, paths.scmCacheDir);
  assert.deepEqual(lines.filter(([s]) => s === 'stderr').map(([, l]) => l), ['log line 1', 'log line 2 é']);
  assert.deepEqual(lines.filter(([s]) => s === 'stdout').map(([, l]) => l), ['engine noise on stdout']);
  assert.deepEqual(tmpLeftovers(paths), [], 'result file deleted');
  assert.ok(fs.existsSync(path.join(paths.scmCacheDir, 'mpl')));
});

test('run writes the list option to a temp file passed as --list and deletes it', async (t) => {
  const { helper, paths } = setup(t);
  const items = [{ src: 'a é.png', dest: 'b.png' }];
  const result = await helper.run('prepare-upscale', [], { list: { items } });
  assert.deepEqual(result.list, { items });
  assert.ok(result.listFile.startsWith(path.join(paths.scmCacheDir, 'tmp')));
  assert.ok(!fs.existsSync(result.listFile));
  assert.deepEqual(tmpLeftovers(paths), []);
});

test('a caller-provided --root wins and extra --out (merge-pdfs output) comes after ours', async (t) => {
  const { helper } = setup(t);
  const result = await helper.run('merge-pdfs', ['--root', 'C:\\custom', '--output', 'm.pdf', '--inputs', 'a.pdf', 'b.pdf']);
  assert.equal(result.argv.filter((a) => a === '--root').length, 1);
  assert.equal(result.argv[result.argv.indexOf('--root') + 1], 'C:\\custom');
  assert.equal(result.argv[1], '--out', 'our --out is the first --out');
});

test('cwd falls back to scm-cache/tmp while the workspace does not exist', async (t) => {
  const { helper, paths } = setup(t, { workspace: false });
  const result = await helper.run('env-check', ['--requirements', 'r.txt']);
  assert.equal(path.resolve(result.cwd).toLowerCase(), path.join(paths.scmCacheDir, 'tmp').toLowerCase());
});

test('a helper error JSON becomes a friendly error with the Python error attached', async (t) => {
  const seen = [];
  const { helper, paths } = setup(t, {
    overrides: {
      friendlyError: ({ err, kind, context }) => {
        seen.push({ err, kind, context });
        return { message: `Friendly ${err.pythonError.type}`, code: 'BAD_VALUE', details: 'raw details' };
      },
    },
  });
  await assert.rejects(helper.run('list-images', ['--mode', 'error']), (err) => {
    assert.equal(err.message, 'Friendly ValueError');
    assert.equal(err.code, 'BAD_VALUE');
    assert.equal(err.details, 'raw details');
    assert.equal(err.sub, 'list-images');
    assert.equal(err.exitCode, 1);
    assert.deepEqual(err.pythonError, { type: 'ValueError', message: 'bad value', raw: 'ValueError: bad value' });
    return true;
  });
  assert.equal(seen[0].kind, 'helper');
  assert.deepEqual(seen[0].context, { sub: 'list-images' });
  assert.equal(seen[0].err.code, 1, 'process error carries the exit code like JobProcessError');
  assert.ok(Array.isArray(seen[0].err.stderrTail));
  assert.ok(seen[0].err.command.includes('list-images'));
  assert.deepEqual(tmpLeftovers(paths), []);
});

test('a crash without a result file is parsed from stderr', async (t) => {
  const { helper } = setup(t, { overrides: { friendlyError: () => null } });
  await assert.rejects(helper.run('smoke-test', ['--mode', 'crash']), (err) => {
    assert.equal(err.pythonError.type, 'MemoryError');
    assert.equal(err.code, 'UNKNOWN');
    assert.match(err.message, /^Something went wrong/);
    assert.match(err.details, /MemoryError/);
    return true;
  });
});

test('unreadable or missing result files are failures even with exit code 0', async (t) => {
  const { helper } = setup(t, { overrides: { friendlyError: () => null } });
  await assert.rejects(helper.run('pdf-info', ['--mode', 'badjson']), (err) => /Unreadable result file/.test(err.details));
  await assert.rejects(helper.run('pdf-info', ['--mode', 'exit0-noout']), { code: 'UNKNOWN' });
});

test('timeout kills the whole process tree', async (t) => {
  const { helper, root, paths } = setup(t);
  const pidfile = path.join(root, 'grandchild.pid');
  const started = Date.now();
  await assert.rejects(helper.run('pdf-info', ['--mode', 'hang-tree', '--pidfile', pidfile], { timeoutMs: 1500 }), (err) => {
    assert.equal(err.code, 'TIMEOUT');
    assert.match(err.message, /took too long/);
    return true;
  });
  assert.ok(Date.now() - started < 10000);
  const grandchild = Number(fs.readFileSync(pidfile, 'utf8'));
  for (let i = 0; i < 50 && isAlive(grandchild); i += 1) await new Promise((r) => setTimeout(r, 100));
  assert.equal(isAlive(grandchild), false, 'grandchild was killed with the tree');
  assert.deepEqual(tmpLeftovers(paths), []);
});

test('an AbortSignal cancels the run', async (t) => {
  class CancelledError extends Error {
    constructor(message) {
      super(message);
      this.name = 'CancelledError';
    }
  }
  const { helper } = setup(t, { overrides: { CancelledError } });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  await assert.rejects(helper.run('pdf-info', ['--mode', 'hang'], { signal: controller.signal }), CancelledError);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(helper.run('pdf-info', [], { signal: aborted.signal }), CancelledError);
});

test('runs take the shared Python lock unless lock:false; lock refusals are tagged PYTHON_BUSY', async (t) => {
  let shared = 0;
  const locks = {
    withPythonShared: async (fn) => {
      shared += 1;
      return fn();
    },
  };
  const { helper } = setup(t, { locks });
  await helper.run('pdf-info');
  assert.equal(shared, 1);
  await helper.run('pdf-info', [], { lock: false });
  assert.equal(shared, 1);

  const refusing = { withPythonShared: async () => Promise.reject(new Error('Setting up the card maker components…')) };
  const busy = setup(t, { locks: refusing });
  await assert.rejects(busy.helper.run('pdf-info'), (err) => err.code === 'PYTHON_BUSY' && /Setting up/.test(err.message));
  assert.deepEqual(busy.runs(), [], 'nothing was spawned');
});

test('missing Python or helper script are reported before spawning', async (t) => {
  const a = setup(t);
  a.deps.getPaths = () => ({ ...a.paths, pythonPath: path.join(a.root, 'nope', 'python.exe') });
  await assert.rejects(a.helper.run('env-check'), { code: 'NOT_INSTALLED' });
  const b = setup(t);
  b.deps.getPaths = () => ({ ...b.paths, helperScript: path.join(b.root, 'missing.py') });
  await assert.rejects(b.helper.run('env-check'), { code: 'HELPER_MISSING' });
  const c = setup(t);
  await assert.rejects(c.helper.run('bogus'), TypeError);
  await assert.rejects(c.helper.run('env-check', [1]), TypeError);
});

test('a spawn failure (EACCES/ENOENT) gives a friendly message', async (t) => {
  const { helper } = setup(t, {
    overrides: {
      spawnImpl: () => {
        throw Object.assign(new Error('spawn EACCES'), { code: 'EACCES' });
      },
    },
  });
  await assert.rejects(helper.run('env-check'), (err) => err.code === 'BLOCKED' && /antivirus/.test(err.message));
});

test('introspect requires a ready environment', async (t) => {
  const { helper, runs } = setup(t, { overrides: { checkEnv: async () => ({ ready: false }) } });
  await assert.rejects(helper.introspect(), (err) => err.code === 'NOT_READY' && err.message.startsWith('NOT_READY'));
  assert.deepEqual(runs(), []);
});

test('introspect caches in memory and on disk, keyed by engine files', async (t) => {
  const { helper, paths, deps, runs, engine, ws } = setup(t);
  process.env.FAKE_MODE = 'introspect';
  t.after(() => delete process.env.FAKE_MODE);

  const first = await helper.introspect();
  assert.equal(first.engineRoot, path.resolve(engine));
  assert.deepEqual(runs(), ['introspect']);
  const cacheFile = path.join(paths.scmCacheDir, 'introspection.json');
  const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(cached.version, 1);
  assert.equal(cached.keyInfo.workspace, path.resolve(ws));
  assert.equal(cached.keyInfo.python, path.resolve(process.execPath));
  assert.ok(cached.keyInfo.files['create_pdf.py']);
  assert.ok(cached.keyInfo.files['plugins/mtg/fetch.py']);
  assert.ok(cached.keyInfo.files['plugins/mtg/deck_formats.py']);

  assert.equal(await helper.introspect(), first, 'memory cache');
  const fresh = createHelper(() => deps, { checkEnv: async () => ({ ready: true }), pythonEnv: (b, e, c) => ({ ...fallbackPythonEnv(b, e, c), FAKE_COUNTER: path.join(path.dirname(paths.helperScript), 'counter.txt') }) });
  const fromDisk = await fresh.introspect();
  assert.equal(fromDisk.stamp, first.stamp, 'disk cache');
  assert.equal(runs().length, 1);

  // Changing an engine file (size + mtime) changes the key.
  fs.writeFileSync(path.join(ws, 'utilities.py'), 'changed utilities content');
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(ws, 'utilities.py'), future, future);
  const second = await helper.introspect();
  assert.notEqual(second.stamp, first.stamp);
  assert.equal(runs().length, 2);

  // Adding extra layouts / templates changes the key too.
  fs.mkdirSync(path.join(ws, 'assets', 'extra_layouts'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'assets', 'extra_layouts', 'mine.json'), '{}');
  await helper.introspect();
  assert.equal(runs().length, 3);
  fs.writeFileSync(path.join(engine, 'cutting_templates', 'a4-standard-v5.studio3'), 'tpl');
  await helper.introspect();
  assert.equal(runs().length, 4);

  await helper.introspect({ force: true });
  assert.equal(runs().length, 5);
  helper.invalidate();
  await helper.introspect();
  assert.equal(runs().length, 5, 'after invalidate the (valid) disk cache is used');
});

test('concurrent introspect calls share one run', async (t) => {
  const { helper, runs } = setup(t);
  process.env.FAKE_MODE = 'introspect';
  t.after(() => delete process.env.FAKE_MODE);
  const results = await Promise.all([helper.introspect(), helper.introspect(), helper.introspect()]);
  assert.equal(runs().length, 1);
  assert.equal(results[0], results[1]);
});

test('an incomplete introspection result is rejected and not cached', async (t) => {
  const { helper, paths } = setup(t);
  process.env.FAKE_MODE = 'incomplete';
  t.after(() => delete process.env.FAKE_MODE);
  await assert.rejects(helper.introspect(), { code: 'INTROSPECTION_INVALID' });
  assert.ok(!fs.existsSync(path.join(paths.scmCacheDir, 'introspection.json')));
});

test('fallbackPythonEnv applies the spec rules', () => {
  const env = fallbackPythonEnv(
    { PATH: 'p', PYTHONPATH: 'x', PYTHONHOME: 'y', VIRTUAL_ENV: 'v', CONDA_PREFIX: 'c', UV_CACHE_DIR: 'u', SCM_EXTRA_LAYOUTS: 'e', SCM_CUTTING_TEMPLATES_DIR: 't', KEEP: 'k' },
    { UV_CACHE_DIR: 'mine' },
    'C:\\cache',
  );
  assert.equal(env.PATH, 'p');
  assert.equal(env.KEEP, 'k');
  for (const gone of ['PYTHONPATH', 'PYTHONHOME', 'VIRTUAL_ENV', 'CONDA_PREFIX', 'SCM_EXTRA_LAYOUTS', 'SCM_CUTTING_TEMPLATES_DIR']) assert.equal(env[gone], undefined, gone);
  assert.equal(env.UV_CACHE_DIR, 'mine');
  assert.equal(env.PYTHONUTF8, '1');
  assert.equal(env.PYTHONIOENCODING, 'utf-8:backslashreplace');
  assert.equal(env.PYTHONHASHSEED, '0');
  assert.equal(env.PYTHONDONTWRITEBYTECODE, '1');
  assert.equal(env.PYTHONUNBUFFERED, '1');
  assert.equal(env.MPLBACKEND, 'Agg');
  assert.equal(env.MPLCONFIGDIR, path.join('C:\\cache', 'mpl'));
});
