'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const {
  JobManager, CancelledError, JobProcessError, splitLines, isProgressOnlyLine, pythonEnv, JOB_KINDS, MUTATING_KINDS, LIMITS,
} = require('../../src/main/jobs');
const { MESSAGES } = require('../../src/main/errors');
const { TEST_PYTHON, pythonSkip } = require('../support/engine');

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const NODE = process.execPath;

let tmpRoot;
test.before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scm-jobs-test-'));
});
test.after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

function script(name, source) {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, source);
  return file;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let managerCount = 0;
function newManager(options = {}) {
  managerCount += 1;
  const logsDir = path.join(tmpRoot, `logs${managerCount}`);
  const jm = new JobManager({ logsDir, scmCacheDir: path.join(tmpRoot, 'scm-cache'), ...options });
  const events = [];
  jm.on('event', (evt) => events.push({ ...evt, receivedAt: Date.now() }));
  return { jm, events, logsDir };
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let ok = false;
    try {
      ok = await predicate();
    } catch {
      ok = false; // e.g. a log file that is not created yet
    }
    if (ok) return;
    await delay(25);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function killQuietly(pid) {
  try { process.kill(pid); } catch { /* already gone */ }
}

/** Fake child_process.spawn for deterministic tests. */
function fakeSpawn({ emitSpawn = true } = {}) {
  const calls = [];
  function spawnImpl(cmd, args, options) {
    const child = new EventEmitter();
    child.pid = 4242 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kills = [];
    child.kill = (signal) => { child.kills.push(signal === undefined ? 'default' : signal); return true; };
    child.exitCode = null;
    child.signalCode = null;
    child.finish = async (code = 0, signal = null, { close = true } = {}) => {
      child.exitCode = code;
      child.signalCode = signal;
      const ended = Promise.all([once(child.stdout, 'end'), once(child.stderr, 'end')]);
      child.stdout.end();
      child.stderr.end();
      child.emit('exit', code, signal);
      if (close) {
        await ended;
        child.emit('close', code, signal);
      }
    };
    calls.push({ cmd, args, options, child });
    if (emitSpawn) process.nextTick(() => child.emit('spawn'));
    return child;
  }
  return { spawnImpl, calls };
}

// ------------------------------------------------------------------ pure helpers

test('splitLines: \\r\\n, \\n and lone \\r separators with a partial-line carry', () => {
  const s = {};
  assert.deepEqual(splitLines(s, 'a\r\nb\nc\rd'), ['a', 'b', 'c']);
  assert.equal(s.carry, 'd');
  assert.deepEqual(splitLines(s, 'ef'), []);
  assert.deepEqual(splitLines(s, 'g\n'), ['defg']);
  assert.deepEqual(splitLines(s, null), []);
  const t = {};
  assert.deepEqual(splitLines(t, 'tail without newline'), []);
  assert.deepEqual(splitLines(t, undefined), ['tail without newline']);
  assert.deepEqual(splitLines({}, 'a\n\nb\n'), ['a', '', 'b']);
  assert.deepEqual(splitLines({}, 'a\r\r\nb\n'), ['a', '', 'b']);
  assert.deepEqual(splitLines({}, ''), []);
});

test('splitLines: CR at a chunk end + LF at the next chunk start is ONE line break (and is delivered immediately)', () => {
  const s = {};
  assert.deepEqual(splitLines(s, 'progress 10%\r'), ['progress 10%']);
  assert.equal(s.skipLF, true);
  assert.deepEqual(splitLines(s, '\nnext\n'), ['next']);
  const u = {};
  assert.deepEqual(splitLines(u, 'x\r'), ['x']);
  assert.deepEqual(splitLines(u, '\n'), []);
  assert.deepEqual(splitLines(u, 'y\n'), ['y']);
  const v = {};
  assert.deepEqual(splitLines(v, 'a\r'), ['a']);
  assert.deepEqual(splitLines(v, 'b\r'), ['b'], 'a lone CR followed by text is a break, not a CRLF');
});

test('splitLines: byte-at-a-time input', () => {
  const s = {};
  const out = [];
  for (const ch of 'ab\r\ncd\re\n\nf') out.push(...splitLines(s, ch));
  out.push(...splitLines(s, null));
  assert.deepEqual(out, ['ab', 'cd', 'e', '', 'f']);
});

test('splitLines: a partial line over 64 KB is flushed', () => {
  const s = {};
  assert.deepEqual(splitLines(s, 'x'.repeat(LIMITS.partialChars)), []);
  const lines = splitLines(s, 'yy');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].length, LIMITS.partialChars + 2);
  assert.equal(s.carry, '');
  const custom = { maxPartial: 5 };
  assert.deepEqual(splitLines(custom, 'abcdef'), ['abcdef']);
  assert.throws(() => splitLines(null, 'x'), TypeError);
});

test('isProgressOnlyLine', () => {
  for (const l of ['45%', ' 45,83% ', '100.00', '7', '12.5 ', '0%']) assert.equal(isProgressOnlyLine(l), true, l);
  for (const l of ['', ' ', 'abc 45%', '45 %', 'Image 1: x.png', '45%%', '[0 NVIDIA]', '1,2,3']) assert.equal(isProgressOnlyLine(l), false, l);
});

test('pythonEnv: cleans Python/venv/uv/engine variables and sets the UTF-8/Agg settings (spec §5.1)', () => {
  const base = {
    PATH: 'C:\\bin', HOME: 'h', PYTHONPATH: 'x', PYTHONHOME: 'y', PYTHONSTARTUP: 'z', VIRTUAL_ENV: 'v', CONDA_PREFIX: 'c',
    UV_CACHE_DIR: 'u', UV_PYTHON: 'p', SCM_EXTRA_LAYOUTS: 'l', SCM_CUTTING_TEMPLATES_DIR: 't', SCM_DATA_DIR: 'keep', EMPTY: undefined,
  };
  const frozen = JSON.stringify(base);
  const env = pythonEnv(base, { UV_CACHE_DIR: 'mine', EXTRA: 1, HOME: null }, path.join('C:', 'cache'), { platform: 'linux' });
  assert.equal(JSON.stringify(base), frozen, 'base env not modified');
  assert.deepEqual(env, {
    PATH: 'C:\\bin',
    SCM_DATA_DIR: 'keep',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8:backslashreplace',
    PYTHONHASHSEED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: path.join('C:', 'cache', 'mpl'),
    UV_CACHE_DIR: 'mine',
    EXTRA: '1',
  });
  assert.equal('MPLCONFIGDIR' in pythonEnv(base, {}, null, { platform: 'linux' }), false);
});

test('pythonEnv: Windows names are case-insensitive, POSIX names are not', () => {
  const win = pythonEnv({ Path: 'C:\\Windows', PythonPath: 'x', Virtual_Env: 'v', uv_index_url: 'u', mplbackend: 'TkAgg' }, { PATH: 'C:\\venv;C:\\Windows' }, null, { platform: 'win32' });
  assert.deepEqual(Object.keys(win).filter((k) => k.toUpperCase() === 'PATH'), ['PATH']);
  assert.equal(win.PATH, 'C:\\venv;C:\\Windows');
  assert.equal(Object.keys(win).some((k) => /^(pythonpath|virtual_env|uv_index_url)$/i.test(k)), false);
  assert.deepEqual(Object.keys(win).filter((k) => k.toUpperCase() === 'MPLBACKEND'), ['MPLBACKEND']);
  const posix = pythonEnv({ Path: 'a', pythonish: 'keep', PYTHONPATH: 'drop' }, { PATH: 'b' }, null, { platform: 'linux' });
  assert.deepEqual([posix.Path, posix.PATH, posix.pythonish, posix.PYTHONPATH], ['a', 'b', 'keep', undefined]);
});

// ------------------------------------------------------------------ manager basics

test('start: validation, started event, result, history, BUSY rejection', async () => {
  const { jm, events } = newManager();
  assert.deepEqual(JOB_KINDS, ['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration', 'preview', 'probe', 'samples', 'engine']);
  assert.throws(() => jm.start('nope', {}, async () => {}), TypeError);
  assert.throws(() => jm.start('pdf', {}, 'not a function'), TypeError);

  const gate = deferred();
  const id = jm.start('pdf', { title: 'First job', steps: [{ id: 'render', label: 'Render' }] }, () => gate.promise);
  assert.match(id, /^[0-9a-f]{8}$/);
  const started = events.find((e) => e.type === 'started');
  assert.equal(started.jobId, id);
  assert.equal(started.kind, 'pdf');
  assert.equal(started.title, 'First job');
  assert.deepEqual(started.steps, [{ id: 'render', label: 'Render', status: 'pending' }]);
  assert.equal(typeof started.startedAt, 'number');
  assert.equal(jm.active().jobId, id);
  assert.equal(jm.active().status, 'running');

  assert.throws(() => jm.start('fetch', { title: 'Second' }, async () => {}), (err) => {
    assert.equal(err.message, 'BUSY: First job');
    assert.equal(err.code, 'BUSY');
    return true;
  });

  gate.resolve({ pdfPath: 'x.pdf' });
  const summary = await jm.whenFinished(id);
  assert.equal(summary.status, 'succeeded');
  assert.deepEqual(summary.result, { pdfPath: 'x.pdf' });
  const finished = events.find((e) => e.type === 'finished');
  assert.deepEqual(
    { ...finished, endedAt: 0, durationMs: 0, receivedAt: 0 },
    { type: 'finished', jobId: id, kind: 'pdf', status: 'succeeded', result: { pdfPath: 'x.pdf' }, error: null, warnings: [], endedAt: 0, durationMs: 0, receivedAt: 0 },
  );
  assert.ok(finished.durationMs >= 0 && finished.endedAt >= started.startedAt);
  assert.equal(jm.active(), null);
  assert.equal(jm.history()[0].jobId, id);

  const id2 = jm.start('fetch', {}, async () => undefined);
  assert.equal(jm.active().title, 'Downloading cards', 'default title per kind');
  assert.equal((await jm.whenFinished(id2)).result, null);
  assert.deepEqual(jm.history().map((h) => h.jobId), [id2, id]);
  assert.equal(await jm.whenFinished('unknown'), null);
});

test('isMutating: true only while a mutating kind runs', async () => {
  const { jm } = newManager();
  assert.equal(jm.isMutating(), false);
  for (const kind of JOB_KINDS) {
    const gate = deferred();
    const id = jm.start(kind, { title: kind }, () => gate.promise);
    assert.equal(jm.isMutating(), MUTATING_KINDS.includes(kind), kind);
    gate.resolve();
    await jm.whenFinished(id);
    assert.equal(jm.isMutating(), false);
  }
  assert.deepEqual([...MUTATING_KINDS].sort(), ['calibration', 'fetch', 'offset', 'pdf', 'setup', 'upscale']);
});

test('steps: explicit updates, dynamic steps, automatic completion on success and failure', async () => {
  const { jm, events } = newManager();
  const id = jm.start('pdf', { title: 'Steps', steps: [{ id: 'prepare', label: 'Prepare' }, 'render', { id: 'merge', label: 'Merge parts' }] }, async (ctx) => {
    ctx.step('prepare', 'running');
    ctx.step('prepare', 'done');
    ctx.step('render', 'running', 'Render part 1/2');
    ctx.step('extra', 'running', 'Extra step');
    return 1;
  });
  const summary = await jm.whenFinished(id);
  assert.deepEqual(summary.steps, [
    { id: 'prepare', label: 'Prepare', status: 'done' },
    { id: 'render', label: 'Render part 1/2', status: 'done' },
    { id: 'merge', label: 'Merge parts', status: 'skipped' },
    { id: 'extra', label: 'Extra step', status: 'done' },
  ]);
  const stepEvents = events.filter((e) => e.type === 'step').map((e) => `${e.stepId}:${e.status}`);
  // Automatic completion runs in step-list order, before 'finished'.
  assert.deepEqual(stepEvents, ['prepare:running', 'prepare:done', 'render:running', 'extra:running', 'render:done', 'merge:skipped', 'extra:done']);
  const finishedAt = events.findIndex((e) => e.type === 'finished');
  assert.ok(events.findLastIndex((e) => e.type === 'step') < finishedAt);

  const id2 = jm.start('pdf', { steps: ['a', 'b'] }, async (ctx) => {
    ctx.step('a', 'running');
    throw new Error('Render failed for a reason the app explains.');
  });
  const failed = await jm.whenFinished(id2);
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.steps.map((s) => s.status), ['failed', 'pending']);
  assert.deepEqual(failed.error, { message: 'Render failed for a reason the app explains.', details: failed.error.details, code: 'UNKNOWN' });
  assert.match(failed.error.details, /Render failed/);
});

test('warnings are de-duplicated and logged; errors from the executor are made friendly', async () => {
  const { jm, events } = newManager();
  const id = jm.start('pdf', {}, async (ctx) => {
    ctx.warn('Offset cannot be applied');
    ctx.warn('Offset cannot be applied');
    ctx.warn('  ');
    ctx.warn('No back image provided');
    return 'ok';
  });
  const s = await jm.whenFinished(id);
  assert.deepEqual(s.warnings, ['Offset cannot be applied', 'No back image provided']);
  assert.deepEqual(events.find((e) => e.type === 'finished').warnings, s.warnings);
  const logLines = events.filter((e) => e.type === 'log').flatMap((e) => e.lines);
  assert.ok(logLines.some((l) => l.stream === 'warn' && l.line === 'Warning: Offset cannot be applied'));

  const { userError } = require('../../src/main/errors');
  const id2 = jm.start('fetch', {}, async () => { throw userError('The deck list file could not be found', { code: 'DECK_FILE_MISSING' }); });
  const s2 = await jm.whenFinished(id2);
  assert.deepEqual([s2.status, s2.error.code, s2.error.message], ['failed', 'DECK_FILE_MISSING', 'The deck list file could not be found']);
  assert.equal(s2.result, null);
});

test('a throwing event listener never breaks a job', async () => {
  const { jm } = newManager();
  jm.on('event', () => { throw new Error('listener bug'); });
  const id = jm.start('preview', {}, async (ctx) => { ctx.log('hello'); return 5; });
  assert.equal((await jm.whenFinished(id)).result, 5);
});

test('history keeps the newest 30 jobs; getLog formats the in-memory tail', async () => {
  const { jm } = newManager();
  let lastId;
  for (let i = 0; i < 32; i += 1) {
    lastId = jm.start('probe', { title: `job ${i}` }, async (ctx) => { ctx.log(`working on ${i}`); ctx.log('err line', 'stderr'); return i; });
    await jm.whenFinished(lastId);
  }
  const history = jm.history();
  assert.equal(history.length, 30);
  assert.equal(history[0].title, 'job 31');
  assert.equal(history[29].title, 'job 2');
  const log = jm.getLog(lastId);
  assert.match(log, /^# job 31 \(probe, job [0-9a-f]{8}\) started /);
  assert.match(log, /\n\d\d:\d\d:\d\d\.\d{3} working on 31\n/);
  assert.match(log, /\n\d\d:\d\d:\d\d\.\d{3} \[stderr\] err line\n/);
  assert.equal(jm.getLog('nope'), '');
});

test('log files: one per job, named <YYYYMMDD-HHMMSS>-<kind>-<id>.log, newest 50 kept at startup', async () => {
  const { jm, logsDir } = newManager();
  const id = jm.start('pdf', { title: 'Logged' }, async (ctx) => { ctx.log('café 日本'); ctx.log('oops', 'stderr'); return 1; });
  const s = await jm.whenFinished(id);
  assert.ok(s.logFile);
  assert.match(path.basename(s.logFile), new RegExp(`^\\d{8}-\\d{6}-pdf-${id}\\.log$`));
  assert.equal(path.dirname(s.logFile), path.join(logsDir, 'jobs'));
  await waitFor(() => fs.readFileSync(s.logFile, 'utf8').includes('Finished'), 3000, 'log file flush');
  const text = fs.readFileSync(s.logFile, 'utf8');
  assert.match(text, /^# Kirigami job [0-9a-f]{8} \(pdf\) "Logged" started /);
  assert.match(text, /café 日本/);
  assert.match(text, /\[stderr\] oops/);

  const pruneDir = path.join(tmpRoot, 'prune-logs');
  await fsp.mkdir(path.join(pruneDir, 'jobs'), { recursive: true });
  const names = [];
  for (let i = 0; i < 60; i += 1) {
    const name = `20200101-0000${String(i).padStart(2, '0')}-pdf-${String(i).padStart(8, '0')}.log`;
    names.push(name);
    await fsp.writeFile(path.join(pruneDir, 'jobs', name), 'x');
  }
  await fsp.writeFile(path.join(pruneDir, 'jobs', 'notes.txt'), 'not a log');
  const pruner = new JobManager({ logsDir: pruneDir });
  await pruner.ready;
  const left = (await fsp.readdir(path.join(pruneDir, 'jobs'))).sort();
  assert.deepEqual(left, [...names.slice(10), 'notes.txt'].sort());
});

test('without logsDir no files are written', async () => {
  const jm = new JobManager({});
  const id = jm.start('preview', {}, async (ctx) => { ctx.log('memory only'); return 1; });
  const s = await jm.whenFinished(id);
  assert.equal(s.logFile, null);
  assert.match(jm.getLog(id), /memory only/);
});

test('progress: normalized values', async () => {
  const { jm, events } = newManager();
  const id = jm.start('preview', {}, async (ctx) => {
    ctx.progress({ current: 1, total: 4, label: 'Card 1' });
    await delay(130);
    ctx.progress({ percent: 150 });
    await delay(130);
    ctx.progress({ percent: null, current: 3, total: 4, label: 'x'.repeat(400) });
    await delay(130);
    ctx.progress();
    return 1;
  });
  await jm.whenFinished(id);
  const p = events.filter((e) => e.type === 'progress').map(({ percent, current, total, label }) => ({ percent, current, total, label }));
  assert.deepEqual(p, [
    { percent: 25, current: 1, total: 4, label: 'Card 1' },
    { percent: 100, current: null, total: null, label: null },
    { percent: null, current: 3, total: 4, label: 'x'.repeat(300) },
    { percent: null, current: null, total: null, label: null },
  ]);
  assert.deepEqual(jm.history()[0].progress, p[3]);
});

test('progress events are throttled to at most 10 per second and the last value is always delivered', async () => {
  const { jm, events } = newManager();
  const id = jm.start('upscale', {}, async (ctx) => {
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 520) {
      i += 1;
      ctx.progress({ current: i, total: 1000000, label: `Upscaling ${i}` });
      if (i % 25 === 0) await new Promise((resolve) => { setImmediate(resolve); });
    }
    return i;
  });
  const s = await jm.whenFinished(id);
  const progress = events.filter((e) => e.type === 'progress');
  assert.ok(s.result > 100, 'many progress calls were made');
  assert.ok(progress.length >= 3 && progress.length <= 8, `got ${progress.length} progress events for ${s.result} calls`);
  for (let k = 1; k < progress.length - 1; k += 1) {
    const gap = progress[k].receivedAt - progress[k - 1].receivedAt;
    assert.ok(gap >= 90, `progress events ${k - 1}->${k} only ${gap} ms apart`);
  }
  const last = progress[progress.length - 1];
  assert.equal(last.current, s.result);
  assert.equal(last.label, `Upscaling ${s.result}`);
  const finishedIndex = events.findIndex((e) => e.type === 'finished');
  assert.ok(events.indexOf(last) < finishedIndex, 'last progress before finished');
});

test('log events are batched (at most one per 100 ms) and no line is lost', async (t) => {
  // Simulated clock (setTimeout and Date): the gaps measured below depend on the batching alone, not on
  // how busy the machine is (on a loaded machine real timers fire late and made this test flaky).
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const { jm, events } = newManager();
  const id = jm.start('preview', {}, async (ctx) => {
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < 650) {
      ctx.log(`line ${n}`);
      n += 1;
      await delay(4);
    }
    return n;
  });
  let finished = false;
  const done = jm.whenFinished(id).then((summary) => { finished = true; return summary; });
  for (let i = 0; !finished && i < 1000; i += 1) {
    await new Promise((resolve) => { setImmediate(resolve); }); // the job runs up to its next delay(4)
    t.mock.timers.tick(4);
  }
  assert.ok(finished, 'the job finished within 4 simulated seconds');
  const s = await done;
  const logs = events.filter((e) => e.type === 'log');
  assert.ok(logs.length >= 4 && logs.length <= 9, `${logs.length} log events for ${s.result} lines`);
  for (let k = 1; k < logs.length - 1; k += 1) {
    const gap = logs[k].receivedAt - logs[k - 1].receivedAt;
    assert.ok(gap >= LIMITS.logBatchMs, `log events ${k - 1}->${k} only ${gap} ms apart`);
  }
  const delivered = logs.flatMap((e) => e.lines).map((l) => l.line).filter((l) => l.startsWith('line '));
  assert.deepEqual(delivered, Array.from({ length: s.result }, (_, i) => `line ${i}`));
  for (const l of logs.flatMap((e) => e.lines)) {
    assert.equal(typeof l.ts, 'number');
    assert.ok(['stdout', 'stderr', 'info', 'warn', 'error'].includes(l.stream));
  }
});

test('a burst of lines is capped per event; the rest stays in the log file/tail', async () => {
  const { jm, events } = newManager();
  const id = jm.start('preview', {}, async (ctx) => {
    for (let i = 0; i < 2500; i += 1) ctx.log(`burst ${i}`);
    return 1;
  });
  await jm.whenFinished(id);
  const logs = events.filter((e) => e.type === 'log');
  for (const e of logs) assert.ok(e.lines.length <= LIMITS.logBatchMaxLines + 1);
  const lines = logs.flatMap((e) => e.lines.map((l) => l.line));
  assert.ok(lines.includes('burst 2499'));
  assert.ok(lines.some((l) => /^… \d+ earlier lines are only in the log file$/.test(l)));
  assert.match(jm.getLog(id), /burst 0\n/);
});

// ------------------------------------------------------------------ cancellation without processes

test('cancel: ctx.signal aborts, status is cancelled (not failed), cancel() return values', async () => {
  const { jm, events } = newManager();
  let sawCancelled = null;
  const id = jm.start('fetch', {}, (ctx) => new Promise((resolve, reject) => {
    ctx.signal.addEventListener('abort', () => {
      sawCancelled = ctx.cancelled;
      reject(ctx.signal.reason);
    });
  }));
  assert.equal(jm.cancel('not-this-one'), false);
  await delay(10);
  assert.equal(jm.cancel(id), true);
  assert.equal(jm.cancel(id), true, 'cancelling again re-sends the kill');
  const s = await jm.whenFinished(id);
  assert.deepEqual([s.status, s.error, s.result], ['cancelled', null, null]);
  assert.equal(sawCancelled, true);
  assert.equal(events.find((e) => e.type === 'finished').status, 'cancelled');
  assert.equal(jm.cancel(id), false, 'finished jobs cannot be cancelled');
});

test('cancel: throwIfCancelled and spawn-after-cancel raise CancelledError', async () => {
  const { jm } = newManager();
  let spawnError = null;
  const id = jm.start('pdf', {}, async (ctx) => {
    for (;;) {
      if (ctx.cancelled) {
        try {
          await ctx.spawn(NODE, ['-e', '1']);
        } catch (err) {
          spawnError = err;
        }
      }
      ctx.throwIfCancelled();
      await delay(5);
    }
  });
  await delay(30);
  jm.cancel(id);
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'cancelled');
  assert.ok(spawnError instanceof CancelledError);
  assert.equal(spawnError.code, 'CANCELLED');
});

test('cancel: an executor that ignores cancellation is finished as cancelled after the grace period', async () => {
  const { jm } = newManager({ cancelGraceMs: 200 });
  const id = jm.start('pdf', {}, () => new Promise(() => {}));
  await delay(10);
  const t0 = Date.now();
  jm.cancel(id);
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'cancelled');
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(jm.active(), null);
  const id2 = jm.start('pdf', {}, async () => 'next job can run');
  assert.equal((await jm.whenFinished(id2)).result, 'next job can run');
});

// ------------------------------------------------------------------ real child processes

const MIXED_OUTPUT = `
const out = process.stdout;
const steps = [
  () => out.write('alpha\\r\\nbeta\\ngam'),
  () => out.write('ma\\rdelta\\r'),
  () => out.write('\\nepsilon\\n'),
  () => out.write(Buffer.from([0x63, 0x61, 0x66, 0xC3])),
  () => out.write(Buffer.concat([Buffer.from([0xA9]), Buffer.from(' \\u65e5\\u672c \\u{1F389}\\n', 'utf8')])),
  () => out.write('45%\\r 45,83% \\r100.00\\n'),
  () => { process.stderr.write('stderr line \\u00fc\\r\\n'); out.write('no newline at end'); },
];
let i = 0;
(function next() { if (i < steps.length) { steps[i++](); setTimeout(next, 30); } })();
`;

test('spawn: mixed \\r/\\n output, partial lines, split UTF-8, progress-only lines kept out of the log', async () => {
  const file = script('mixed.js', MIXED_OUTPUT);
  const { jm, events } = newManager();
  const seen = [];
  const id = jm.start('pdf', {}, async (ctx) => ctx.spawn(NODE, [file], {
    cwd: tmpRoot,
    onLine: (line, stream) => seen.push(`${stream}:${line}`),
  }));
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'succeeded', JSON.stringify(s.error));
  assert.deepEqual(seen.filter((l) => l.startsWith('stdout:')), [
    'stdout:alpha', 'stdout:beta', 'stdout:gamma', 'stdout:delta', 'stdout:epsilon', 'stdout:café 日本 🎉',
    'stdout:45%', 'stdout: 45,83% ', 'stdout:100.00', 'stdout:no newline at end',
  ]);
  assert.deepEqual(seen.filter((l) => l.startsWith('stderr:')), ['stderr:stderr line ü']);
  assert.equal(s.result.code, 0);
  assert.equal(s.result.signal, null);
  assert.deepEqual(s.result.stdoutTail, ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'café 日本 🎉', 'no newline at end']);
  assert.deepEqual(s.result.stderrTail, ['stderr line ü']);
  assert.equal(typeof s.result.pid, 'number');
  const logged = events.filter((e) => e.type === 'log').flatMap((e) => e.lines);
  assert.ok(logged.some((l) => l.stream === 'stdout' && l.line === 'café 日本 🎉'));
  assert.ok(logged.some((l) => l.stream === 'stderr' && l.line === 'stderr line ü'));
  assert.equal(logged.some((l) => isProgressOnlyLine(l.line)), false, 'pure progress lines are not logged');
  assert.ok(logged.some((l) => l.line.startsWith('> ') && l.line.includes('mixed.js')), 'the command is logged');
  assert.match(jm.getLog(id), /café 日本 🎉/);
});

test('spawn: non-zero exit -> JobProcessError with tails and the parsed Python error; allowNonZero resolves', async () => {
  const file = script('exit3.js', `
process.stdout.write('Image 1: a.png\\n');
process.stderr.write('Traceback (most recent call last):\\n  File "fake.py", line 3, in render\\nMemoryError\\n');
process.exitCode = 3;
`);
  const { jm } = newManager();
  let caught = null;
  const id = jm.start('pdf', {}, async (ctx) => {
    const ok = await ctx.spawn(NODE, [file], { allowNonZero: true });
    assert.equal(ok.code, 3);
    try {
      await ctx.spawn(NODE, [file]);
    } catch (err) {
      caught = err;
      throw err;
    }
    return 'unreachable';
  });
  const s = await jm.whenFinished(id);
  assert.ok(caught instanceof JobProcessError);
  assert.equal(caught.code, 3);
  assert.equal(caught.exitCode, 3);
  assert.equal(caught.signal, null);
  assert.deepEqual(caught.stderrTail, ['Traceback (most recent call last):', '  File "fake.py", line 3, in render', 'MemoryError']);
  assert.deepEqual(caught.stdoutTail, ['Image 1: a.png']);
  assert.equal(caught.pythonError.type, 'MemoryError');
  assert.ok(caught.command.includes('exit3.js'));
  assert.equal(s.status, 'failed');
  assert.equal(s.error.code, 'OUT_OF_MEMORY');
  assert.equal(s.error.message, MESSAGES.OUT_OF_MEMORY);
  assert.match(s.error.details, /MemoryError/);
  assert.match(s.error.details, /Exit code: 3/);
});

test('spawn: a missing program or folder gives a friendly "Could not start" error', async () => {
  const { jm } = newManager();
  const errors = [];
  const id = jm.start('setup', {}, async (ctx) => {
    try {
      await ctx.spawn(path.join(tmpRoot, 'no-such-program.exe'), ['--version']);
    } catch (err) {
      errors.push(err);
    }
    try {
      await ctx.spawn(NODE, ['-e', '1'], { cwd: path.join(tmpRoot, 'missing-folder') });
    } catch (err) {
      errors.push(err);
    }
    await ctx.spawn(path.join(tmpRoot, 'no-such-program.exe'), [], { name: 'Upscayl' });
  });
  const s = await jm.whenFinished(id);
  assert.deepEqual([errors[0].code, errors[0].message], ['START_FAILED', 'Could not start no-such-program.']);
  assert.match(errors[0].details, /no-such-program\.exe/);
  assert.equal(errors[1].code, 'START_FAILED');
  assert.match(errors[1].message, /does not exist/);
  assert.deepEqual([s.status, s.error.code, s.error.message], ['failed', 'START_FAILED', 'Could not start Upscayl.']);
});

test('spawn: lines are capped at 4 KB and a never-ending line is flushed after 64 KB', async () => {
  const file = script('long.js', `
process.stdout.write('x'.repeat(10000) + '\\n' + 'y'.repeat(70000));
setTimeout(() => process.stdout.write('\\nend\\n'), 500);
`);
  const { jm } = newManager();
  const seen = [];
  const id = jm.start('preview', {}, (ctx) => ctx.spawn(NODE, [file], { onLine: (line) => seen.push({ line, at: Date.now() }) }));
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'succeeded');
  assert.equal(seen[0].line, `${'x'.repeat(4096)} … [5904 more characters]`);
  assert.match(seen[1].line, /^y{4096} … \[\d+ more characters\]$/);
  const end = seen.find((l) => l.line === 'end');
  assert.ok(end, 'the end line arrives');
  assert.ok(end.at - seen[1].at >= 300, 'the 64 KB partial line was flushed before the process wrote its newline');
  for (const l of jm.getLog(id).split('\n')) assert.ok(l.length < LIMITS.lineChars + 80);
});

test('spawn: timeout kills the process and fails with a friendly TIMEOUT error', async () => {
  const file = script('sleep.js', 'console.log("PID " + process.pid); setInterval(() => {}, 1000);');
  const { jm } = newManager();
  let pid = null;
  const id = jm.start('probe', {}, (ctx) => ctx.spawn(NODE, [file], {
    timeoutMs: 600,
    name: 'the test program',
    onLine: (line) => { const m = /^PID (\d+)/.exec(line); if (m) pid = Number(m[1]); },
  }));
  try {
    const s = await jm.whenFinished(id);
    assert.equal(s.status, 'failed');
    assert.equal(s.error.code, 'TIMEOUT');
    assert.match(s.error.message, /^The test program took too long \(more than 600 ms\) and was stopped\.$/);
    assert.ok(pid);
    await waitFor(() => !isAlive(pid), 10000, 'timed-out process to die');
  } finally {
    if (pid) killQuietly(pid);
  }
});

test('spawn: cancel kills the whole process tree (child AND grandchild) and ends as cancelled', async () => {
  const file = script('tree.js', `
const { spawn } = require('child_process');
const g = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
console.log('PIDS ' + process.pid + ' ' + g.pid);
setInterval(() => {}, 1000);
`);
  const { jm, events } = newManager();
  let pids = null;
  let spawnError = null;
  const id = jm.start('pdf', { title: 'Tree' }, async (ctx) => {
    try {
      await ctx.spawn(NODE, [file], {
        onLine: (line) => { const m = /^PIDS (\d+) (\d+)/.exec(line); if (m) pids = [Number(m[1]), Number(m[2])]; },
      });
    } catch (err) {
      spawnError = err;
      throw err;
    }
  });
  try {
    await waitFor(() => pids !== null, 10000, 'child and grandchild PIDs');
    assert.ok(isAlive(pids[0]) && isAlive(pids[1]), 'both processes run');
    assert.equal(jm.cancel(id), true);
    const s = await jm.whenFinished(id);
    assert.equal(s.status, 'cancelled');
    assert.equal(s.error, null);
    assert.ok(spawnError instanceof CancelledError, `spawn rejected with ${spawnError && spawnError.name}`);
    assert.equal(events.find((e) => e.type === 'finished').status, 'cancelled');
    await waitFor(() => !isAlive(pids[0]) && !isAlive(pids[1]), 10000, 'child and grandchild to be killed');
  } finally {
    if (pids) pids.forEach(killQuietly);
  }
});

test('spawn: real venv Python (Windows launcher + interpreter) is killed as a tree and its traceback is parsed', { skip: pythonSkip() }, async () => {
  const { jm } = newManager();
  let pythonPid = null;
  const id = jm.start('pdf', {}, (ctx) => ctx.spawn(TEST_PYTHON, ['-c', 'import os, time; print(os.getpid(), flush=True); time.sleep(60)'], {
    cwd: tmpRoot,
    env: ctx.pythonEnv(),
    onLine: (line) => { if (/^\d+$/.test(line.trim())) pythonPid = Number(line.trim()); },
  }));
  try {
    await waitFor(() => pythonPid !== null, 20000, 'the Python interpreter PID');
    jm.cancel(id);
    assert.equal((await jm.whenFinished(id)).status, 'cancelled');
    await waitFor(() => !isAlive(pythonPid), 10000, 'the real interpreter (not just the venv launcher) to die');
  } finally {
    if (pythonPid) killQuietly(pythonPid);
  }

  const id2 = jm.start('pdf', {}, (ctx) => ctx.spawn(TEST_PYTHON, ['-c', 'print("Image 1: card.png"); raise MemoryError()'], { cwd: tmpRoot, env: ctx.pythonEnv() }));
  const s2 = await jm.whenFinished(id2);
  assert.equal(s2.status, 'failed');
  assert.equal(s2.error.code, 'OUT_OF_MEMORY');
});

test('ctx.pythonEnv uses scmCacheDir for MPLCONFIGDIR and merges extra values', async () => {
  const { jm } = newManager({ scmCacheDir: () => path.join(tmpRoot, 'dyn-cache') });
  const id = jm.start('preview', {}, async (ctx) => ctx.pythonEnv({ UV_CACHE_DIR: 'uv' }));
  const env = (await jm.whenFinished(id)).result;
  assert.equal(env.MPLCONFIGDIR, path.join(tmpRoot, 'dyn-cache', 'mpl'));
  assert.equal(env.UV_CACHE_DIR, 'uv');
  assert.equal(env.PYTHONUTF8, '1');
  const bare = new JobManager({});
  const id2 = bare.start('preview', {}, async (ctx) => ctx.pythonEnv());
  assert.equal((await bare.whenFinished(id2)).result.MPLCONFIGDIR, path.join(os.tmpdir(), 'kirigami', 'mpl'));
});

// ------------------------------------------------------------------ fake child processes (deterministic)

test('fake child: spawn options, UTF-8 split across chunks, CR LF split across chunks', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32' });
  const lines = [];
  const id = jm.start('preview', {}, (ctx) => ctx.spawn('C:\\py\\python.exe', ['-c', 'x', 7], { env: { A: '1' }, onLine: (l, s) => lines.push(`${s}:${l}`) }));
  await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
  const call = fake.calls[0];
  assert.equal(call.cmd, 'C:\\py\\python.exe');
  assert.deepEqual(call.args, ['-c', 'x', '7']);
  assert.deepEqual(call.options, {
    cwd: undefined, env: { A: '1' }, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  const { child } = call;
  child.stdout.write(Buffer.from([0x63, 0x61, 0x66, 0xC3]));
  await delay(5);
  child.stdout.write(Buffer.from([0xA9, 0x0D]));
  await delay(5);
  child.stdout.write(Buffer.from([0x0A, 0xF0, 0x9F]));
  await delay(5);
  child.stdout.write(Buffer.from([0x8E, 0x89, 0x0A]));
  child.stderr.write(Buffer.from('partial', 'utf8'));
  await delay(5);
  await child.finish(0);
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'succeeded');
  assert.deepEqual(lines, ['stdout:café', 'stdout:🎉', 'stderr:partial']);
});

test('fake child: POSIX cancel sends SIGTERM to the process group, then SIGKILL after the grace period', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'linux', killGraceMs: 80 });
  const kills = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid < 0) { kills.push([pid, signal, Date.now()]); return true; }
    return realKill.call(process, pid, signal);
  };
  try {
    const id = jm.start('pdf', {}, (ctx) => ctx.spawn('/usr/bin/python3', ['x.py']));
    await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
    assert.equal(fake.calls[0].options.detached, true, 'own process group on POSIX');
    await delay(5);
    jm.cancel(id);
    assert.deepEqual(kills.map(([pid, sig]) => [pid, sig]), [[-4242, 'SIGTERM']]);
    await waitFor(() => kills.length === 2, 2000, 'SIGKILL');
    assert.deepEqual(kills[1].slice(0, 2), [-4242, 'SIGKILL']);
    assert.ok(kills[1][2] - kills[0][2] >= 70);
    await fake.calls[0].child.finish(null, 'SIGKILL');
    assert.equal((await jm.whenFinished(id)).status, 'cancelled');
  } finally {
    process.kill = realKill;
  }
});

test('fake child: POSIX falls back to child.kill() when the process group cannot be signalled', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'darwin', killGraceMs: 30 });
  const realKill = process.kill;
  process.kill = (pid, signal) => {
    if (pid < 0) { const e = new Error('kill ESRCH'); e.code = 'ESRCH'; throw e; }
    return realKill.call(process, pid, signal);
  };
  try {
    const id = jm.start('pdf', {}, (ctx) => ctx.spawn('/usr/bin/python3', ['x.py']));
    await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
    await delay(5);
    jm.cancel(id);
    const { child } = fake.calls[0];
    assert.deepEqual(child.kills, ['SIGTERM']);
    await waitFor(() => child.kills.length === 2, 2000, 'SIGKILL fallback');
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    await child.finish(null, 'SIGKILL');
    assert.equal((await jm.whenFinished(id)).status, 'cancelled');
  } finally {
    process.kill = realKill;
  }
});

test('fake child: Windows cancel runs the ABSOLUTE taskkill.exe /PID <pid> /T /F (fallback: child.kill)', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32', systemRoot: 'C:\\WinTest', killGraceMs: 10 });
  const id = jm.start('pdf', {}, (ctx) => ctx.spawn('C:\\venv\\Scripts\\python.exe', ['create_pdf.py']));
  await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
  await delay(5);
  jm.cancel(id);
  assert.equal(fake.calls.length, 2);
  const tk = fake.calls[1];
  assert.equal(tk.cmd, path.join('C:\\WinTest', 'System32', 'taskkill.exe'));
  assert.deepEqual(tk.args, ['/PID', '4242', '/T', '/F']);
  assert.equal(tk.options.windowsHide, true);
  assert.equal(tk.options.shell, false);
  // taskkill could not start -> TerminateProcess on the direct child as a fallback.
  tk.child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  assert.deepEqual(fake.calls[0].child.kills, ['default']);
  await fake.calls[0].child.finish(1);
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'cancelled');
});

test('fake child: spawn errors (ENOENT event, synchronous EPERM) are friendly', async () => {
  const fake = fakeSpawn({ emitSpawn: false });
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32' });
  const id = jm.start('setup', {}, (ctx) => ctx.spawn('C:\\py\\python.exe', []));
  await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
  fake.calls[0].child.emit('error', Object.assign(new Error('spawn C:\\py\\python.exe ENOENT'), { code: 'ENOENT', syscall: 'spawn C:\\py\\python.exe' }));
  fake.calls[0].child.emit('close', -4058, null);
  const s = await jm.whenFinished(id);
  assert.deepEqual([s.status, s.error.code, s.error.message], ['failed', 'START_FAILED', 'Could not start Python.']);

  const throwing = (cmd) => { throw Object.assign(new Error(`spawn ${cmd} EPERM`), { code: 'EPERM', syscall: 'spawn' }); };
  const { jm: jm2 } = newManager({ spawnImpl: throwing, platform: 'win32' });
  const id2 = jm2.start('upscale', {}, (ctx) => ctx.spawn('D:\\Tools\\Upscayl\\resources\\bin\\upscayl-bin.exe', []));
  const s2 = await jm2.whenFinished(id2);
  assert.deepEqual([s2.error.code, s2.error.message], ['START_BLOCKED', 'Windows or your antivirus blocked Upscayl.']);
});

test('fake child: stops waiting for stdio a while after exit (a grandchild kept the pipes open)', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32' });
  const id = jm.start('preview', {}, (ctx) => ctx.spawn('C:\\py\\python.exe', []));
  await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
  const { child } = fake.calls[0];
  child.stdout.write('done\n');
  await delay(5);
  child.emit('exit', 0, null); // no 'close': the pipes stay open
  const t0 = Date.now();
  const s = await jm.whenFinished(id);
  assert.equal(s.status, 'succeeded');
  assert.equal(s.result.code, 0);
  assert.deepEqual(s.result.stdoutTail, ['done']);
  assert.ok(Date.now() - t0 >= LIMITS.closeAfterExitMs - 100);
});

test('fake child: a throwing or rejecting onLine callback is reported once and never crashes the job', async () => {
  const fake = fakeSpawn();
  const { jm, events } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32' });
  let calls = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const id = jm.start('fetch', {}, (ctx) => ctx.spawn('C:\\py\\python.exe', [], {
      onLine: async () => { calls += 1; throw new Error('parser bug'); },
    }));
    await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
    fake.calls[0].child.stdout.write('one\ntwo\nthree\n');
    await delay(10);
    await fake.calls[0].child.finish(0);
    const s = await jm.whenFinished(id);
    await delay(20);
    assert.equal(s.status, 'succeeded');
    assert.equal(calls, 3);
    const internal = events.filter((e) => e.type === 'log').flatMap((e) => e.lines).filter((l) => l.line.startsWith('Internal error while reading the output'));
    assert.equal(internal.length, 1);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('fake child: JobProcessError carries the last 30 lines of each stream', async () => {
  const fake = fakeSpawn();
  const { jm } = newManager({ spawnImpl: fake.spawnImpl, platform: 'win32' });
  let err = null;
  const id = jm.start('fetch', {}, async (ctx) => {
    try {
      await ctx.spawn('C:\\py\\python.exe', ['plugins/mtg/fetch.py']);
    } catch (e) {
      err = e;
      throw e;
    }
  });
  await waitFor(() => fake.calls.length === 1, 2000, 'spawn');
  const { child } = fake.calls[0];
  for (let i = 0; i < 40; i += 1) child.stdout.write(`Index: ${i}, quantity: 1, name: Card ${i}\n`);
  child.stderr.write('Traceback (most recent call last):\n');
  for (let i = 0; i < 40; i += 1) child.stderr.write(`  File "f${i}.py", line ${i}, in x\n`);
  child.stderr.write("requests.exceptions.ConnectionError: HTTPSConnectionPool(host='api.scryfall.com', port=443): Max retries exceeded\n");
  await delay(10);
  await child.finish(1);
  const s = await jm.whenFinished(id);
  assert.equal(err.stdoutTail.length, 30);
  assert.equal(err.stdoutTail[29], 'Index: 39, quantity: 1, name: Card 39');
  assert.equal(err.stderrTail.length, 30);
  assert.equal(err.pythonError.type, 'requests.exceptions.ConnectionError', 'parsed from a longer stderr tail than the 30 kept');
  assert.equal(s.error.code, 'NETWORK');
  assert.match(s.error.message, /^Couldn't reach api\.scryfall\.com\./);
});
