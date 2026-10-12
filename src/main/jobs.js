'use strict';

/**
 * jobs.js — runs long tasks ("jobs") one at a time and streams their progress to the UI
 * (spec §5.1). No Electron: the process launcher is injected (spawnImpl) so it is unit-testable.
 *
 * - One job at a time: start() throws Error('BUSY: <title of the running job>').
 * - Events on 'event': started / step / progress (≤ 10 per second) / log (batched, ≤ one event
 *   per 100 ms) / finished.
 * - ctx.spawn(): UTF-8 decoding across chunk boundaries, \r\n | \n | \r line splitting with a
 *   partial-line carry, 4 KB line cap, 64 KB flush of a line that never ends, pure-progress lines
 *   ("45%", "45,83%", "100.00") passed to onLine but not logged; non-zero exit → JobProcessError
 *   with stdout/stderr tails and the parsed Python error.
 * - Cancellation kills the whole process tree (Windows: absolute taskkill.exe /T /F; POSIX:
 *   process group SIGTERM, SIGKILL after 3 s) and ends the job as 'cancelled', never 'failed'.
 * - Logs: one file per job in <logsDir>/jobs (newest 50 kept), in-memory tail of 5000 lines.
 */

const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { parsePythonError, friendlyError, userError, programLabel } = require('./errors');

/** All job kinds (spec §5.1). */
const JOB_KINDS = Object.freeze(['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration', 'preview', 'probe', 'samples']);
/** Kinds that change files the user sees (card/decklist mutations are refused while they run). */
const MUTATING_KINDS = Object.freeze(['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration']);

const DEFAULT_TITLES = Object.freeze({
  setup: 'Setting up the card maker components',
  fetch: 'Downloading cards',
  upscale: 'Upscaling images',
  pdf: 'Making the PDF',
  offset: 'Applying printer alignment',
  calibration: 'Making the calibration sheet',
  preview: 'Upscaling a preview',
  probe: 'Detecting graphics cards',
  samples: 'Loading sample cards',
});

const LIMITS = Object.freeze({
  lineChars: 4096, // cap of one logged line
  partialChars: 65536, // flush a line that never ends after this many characters
  progressIntervalMs: 100, // ≤ 10 progress events per second
  logBatchMs: 100, // ≤ one log event per 100 ms
  logBatchMaxLines: 1000, // lines per log event (older ones stay in the file)
  tailLines: 5000, // in-memory log per job
  history: 30,
  keepLogFiles: 50,
  errorTailLines: 30, // JobProcessError stdout/stderr tails
  parseTailLines: 200, // stderr kept to find the Python traceback
  closeAfterExitMs: 2000, // stop waiting for stdio after the process exited (grandchild holding pipes)
  maxWarnings: 100,
});

const LOG_STREAMS = new Set(['stdout', 'stderr', 'info', 'warn', 'error']);
const STEP_STATUSES = new Set(['pending', 'running', 'done', 'skipped', 'failed', 'cancelled']);
const STEP_ALIASES = Object.freeze({
  active: 'running', started: 'running', succeeded: 'done', success: 'done', complete: 'done',
  completed: 'done', ok: 'done', error: 'failed', canceled: 'cancelled',
});
const PROGRESS_ONLY_RE = /^\s*\d+(?:[.,]\d+)?%?\s*$/;
const NEWLINE_RE = /\r\n|\n|\r/g;

// ---------------------------------------------------------------- errors

/** Thrown inside a job when the user cancelled it; the job ends with status 'cancelled'. */
class CancelledError extends Error {
  constructor(message = 'Cancelled') {
    super(message);
    this.name = 'CancelledError';
    this.code = 'CANCELLED';
  }
}

/**
 * A spawned program exited with a non-zero code (and allowNonZero was false).
 * `code` is the exit code (number, or null when killed by a signal) — as in the spec.
 */
class JobProcessError extends Error {
  /**
   * @param {{ code: number|null, signal: string|null, stderrTail: string[], stdoutTail: string[],
   *   pythonError: {type: string|null, message: string, raw: string}|null, command: string, program?: string }} info
   */
  constructor({ code, signal, stderrTail, stdoutTail, pythonError, command, program }) {
    const who = program || 'The program';
    super(signal ? `${who} was stopped (${signal})` : `${who} exited with code ${code}`);
    this.name = 'JobProcessError';
    this.code = code;
    this.exitCode = code;
    this.signal = signal || null;
    this.stderrTail = stderrTail || [];
    this.stdoutTail = stdoutTail || [];
    this.pythonError = pythonError || null;
    this.command = command || '';
    this.program = program || '';
  }
}

// ---------------------------------------------------------------- pure helpers

/**
 * Split decoded text into complete lines (pure, incremental). Separators: \r\n, \n or a lone \r.
 * A \r at the very end of a chunk ends the line immediately; a \n starting the next chunk is then
 * swallowed (it completes the \r\n). A partial line longer than 64 KB is returned as a line.
 *
 * @param {{ carry?: string, skipLF?: boolean, maxPartial?: number }} state mutable state; pass `{}`
 *   for a new stream and keep passing the same object
 * @param {string|null|undefined} chunk decoded text; null/undefined = end of stream (returns the
 *   remaining partial line, if any)
 * @returns {string[]} complete lines without terminators
 */
function splitLines(state, chunk) {
  if (!state || typeof state !== 'object') throw new TypeError('splitLines: state must be an object');
  if (typeof state.carry !== 'string') state.carry = '';
  const lines = [];
  if (chunk === null || chunk === undefined) {
    if (state.carry) lines.push(state.carry);
    state.carry = '';
    state.skipLF = false;
    return lines;
  }
  let text = String(chunk);
  if (!text) return lines;
  if (state.skipLF) {
    state.skipLF = false;
    if (text.charCodeAt(0) === 10) text = text.slice(1);
    if (!text) return lines;
  }
  let start = 0;
  let first = true;
  NEWLINE_RE.lastIndex = 0;
  let m;
  while ((m = NEWLINE_RE.exec(text)) !== null) {
    const piece = text.slice(start, m.index);
    lines.push(first ? state.carry + piece : piece);
    first = false;
    start = m.index + m[0].length;
    if (m[0] === '\r' && start === text.length) state.skipLF = true;
  }
  const rest = text.slice(start);
  state.carry = first ? state.carry + rest : rest;
  const max = Number.isFinite(state.maxPartial) && state.maxPartial > 0 ? state.maxPartial : LIMITS.partialChars;
  if (state.carry.length > max) {
    lines.push(state.carry);
    state.carry = '';
  }
  return lines;
}

/**
 * True for lines that only carry a percentage/number ("45%", " 45,83% ", "100.00"): passed to
 * onLine (progress parsing) but kept out of the log.
 * @param {string} line
 * @returns {boolean}
 */
function isProgressOnlyLine(line) {
  return PROGRESS_ONLY_RE.test(String(line));
}

/**
 * Environment for Python children (spec §5.1): the base environment minus every PYTHON* variable,
 * VIRTUAL_ENV, CONDA_PREFIX, UV_*, SCM_EXTRA_LAYOUTS, SCM_CUTTING_TEMPLATES_DIR (and the macOS
 * __PYVENV_LAUNCHER__), plus PYTHONUNBUFFERED=1, PYTHONUTF8=1,
 * PYTHONIOENCODING=utf-8:backslashreplace, PYTHONHASHSEED=0, PYTHONDONTWRITEBYTECODE=1,
 * MPLBACKEND=Agg, MPLCONFIGDIR=<scmCacheDir>/mpl, then `extra` (null/undefined values delete).
 * On Windows variable names are matched case-insensitively (as Windows does), so `extra.PATH`
 * replaces an inherited `Path` instead of duplicating it.
 *
 * @param {Record<string, string|undefined>} [baseEnv=process.env]
 * @param {Record<string, string|number|null|undefined>} [extra]
 * @param {string|null} [scmCacheDir] MPLCONFIGDIR is set only when given
 * @param {{ platform?: string }} [options]
 * @returns {Record<string, string>} a new object (baseEnv is not modified)
 */
function pythonEnv(baseEnv = process.env, extra = {}, scmCacheDir = null, options = {}) {
  const platform = (options && options.platform) || process.platform;
  const ci = platform === 'win32';
  const norm = (k) => (ci ? k.toUpperCase() : k);
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value === undefined || value === null) continue;
    const k = norm(key);
    const upper = key.toUpperCase();
    const dropPython = ci ? upper.startsWith('PYTHON') : key.startsWith('PYTHON');
    if (dropPython || k === norm('VIRTUAL_ENV') || k === norm('CONDA_PREFIX') || k === norm('__PYVENV_LAUNCHER__')
      || (ci ? upper.startsWith('UV_') : key.startsWith('UV_'))
      || k === norm('SCM_EXTRA_LAYOUTS') || k === norm('SCM_CUTTING_TEMPLATES_DIR')) continue;
    env[key] = String(value);
  }
  const remove = (key) => {
    for (const existing of Object.keys(env)) if (norm(existing) === norm(key)) delete env[existing];
  };
  const set = (key, value) => {
    remove(key);
    env[key] = String(value);
  };
  set('PYTHONUNBUFFERED', '1');
  set('PYTHONUTF8', '1');
  set('PYTHONIOENCODING', 'utf-8:backslashreplace');
  set('PYTHONHASHSEED', '0');
  set('PYTHONDONTWRITEBYTECODE', '1');
  set('MPLBACKEND', 'Agg');
  if (scmCacheDir) set('MPLCONFIGDIR', path.join(String(scmCacheDir), 'mpl'));
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null) remove(key);
    else set(key, value);
  }
  return env;
}

function capLine(line) {
  const s = String(line);
  if (s.length <= LIMITS.lineChars) return s;
  let cut = LIMITS.lineChars;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xD800 && c <= 0xDBFF) cut -= 1; // keep surrogate pairs intact
  return `${s.slice(0, cut)} … [${s.length - cut} more characters]`;
}

function quoteArg(arg) {
  const s = String(arg).replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\t/g, '\\t');
  if (s && !/[\s"'`$&|<>^%!;()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function formatCommand(cmd, args) {
  return [cmd, ...args].map(quoteArg).join(' ');
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

function clock(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function timestampId(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  return `${min} min ${pad(totalSec % 60)} s`;
}

function formatLogLine(entry) {
  const tag = entry.stream === 'stdout' || entry.stream === 'info' ? '' : `[${entry.stream}] `;
  return `${clock(entry.ts)} ${tag}${entry.line}`;
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  const out = [];
  const seen = new Set();
  for (const s of steps) {
    const id = typeof s === 'string' ? s : s && s.id != null ? String(s.id) : null;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof s === 'object' && s && s.label != null ? String(s.label) : id;
    out.push({ id, label, status: 'pending' });
  }
  return out;
}

function normalizeProgress(p) {
  const input = p && typeof p === 'object' ? p : {};
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const current = num(input.current);
  const total = num(input.total);
  let percent;
  if (input.percent === undefined) {
    percent = current !== null && total !== null && total > 0 ? (current / total) * 100 : null;
  } else {
    percent = num(input.percent);
  }
  if (percent !== null) percent = Math.round(Math.min(100, Math.max(0, percent)) * 100) / 100;
  const label = input.label == null ? null : String(input.label).slice(0, 300);
  return { percent, current, total, label };
}

function isCancelledError(err) {
  return !!err && (err instanceof CancelledError || err.name === 'CancelledError' || err.code === 'CANCELLED');
}

/** Small bounded line buffer. */
class LineTail {
  constructor(max) {
    this.max = max;
    this.items = [];
  }

  push(item) {
    this.items.push(item);
    if (this.items.length > this.max + Math.max(16, this.max >> 3)) this.items.splice(0, this.items.length - this.max);
  }

  toArray() {
    return this.items.length > this.max ? this.items.slice(-this.max) : this.items.slice();
  }
}

function summarize(job) {
  return {
    jobId: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    steps: job.steps.map((s) => ({ ...s })),
    progress: job.progress ? { ...job.progress } : null,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    durationMs: job.endedAt ? job.endedAt - job.startedAt : null,
    result: job.result,
    error: job.error,
    warnings: job.warnings.slice(),
    logFile: job.logFile,
    cancelRequested: job.cancelRequested,
  };
}

// ---------------------------------------------------------------- JobManager

/**
 * Runs one job at a time. Emits 'event' with the payloads of spec §5.1.
 *
 * @example
 *   const jobs = new JobManager({ logsDir, scmCacheDir });
 *   jobs.on('event', (evt) => win.webContents.send('jobs:event', evt));
 *   const jobId = jobs.start('pdf', { title: 'Making the PDF', steps: [{ id: 'render', label: 'Render' }] },
 *     async (ctx) => { ctx.step('render', 'running'); await ctx.spawn(py, args, { cwd, env: ctx.pythonEnv() }); return { ok: true }; });
 */
class JobManager extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string|null} [options.logsDir] job logs go to <logsDir>/jobs (null = no log files)
   * @param {typeof childProcess.spawn} [options.spawnImpl=child_process.spawn]
   * @param {string} [options.platform=process.platform]
   * @param {string} [options.systemRoot=process.env.SystemRoot] for the absolute taskkill.exe path
   * @param {string|(() => string)|null} [options.scmCacheDir] used by ctx.pythonEnv() for
   *   MPLCONFIGDIR (falls back to <os temp>/kirigami when missing)
   * @param {Record<string,string>|null} [options.baseEnv] base for ctx.pythonEnv() (default process.env)
   * @param {number} [options.killGraceMs=3000] POSIX SIGTERM → SIGKILL delay (Windows: extra wait
   *   before TerminateProcess fallback after taskkill)
   * @param {number} [options.cancelGraceMs=15000] if the executor has not settled this long after
   *   cancel(), the job is finished as 'cancelled' anyway (the app never stays stuck "busy")
   * @param {number} [options.keepLogFiles=50]
   */
  constructor(options = {}) {
    super();
    const {
      logsDir = null, spawnImpl = childProcess.spawn, platform = process.platform,
      systemRoot = process.env.SystemRoot, scmCacheDir = null, baseEnv = null,
      killGraceMs = 3000, cancelGraceMs = 15000, keepLogFiles = LIMITS.keepLogFiles,
    } = options || {};
    if (typeof spawnImpl !== 'function') throw new TypeError('JobManager: spawnImpl must be a function');
    this.logsDir = logsDir || null;
    this.jobLogDir = this.logsDir ? path.join(this.logsDir, 'jobs') : null;
    this.spawnImpl = spawnImpl;
    this.platform = platform;
    this.systemRoot = systemRoot || process.env.SYSTEMROOT || process.env.windir || 'C:\\Windows';
    this.killGraceMs = killGraceMs;
    this.cancelGraceMs = cancelGraceMs;
    this.keepLogFiles = keepLogFiles;
    this._scmCacheDir = scmCacheDir;
    this._baseEnv = baseEnv;
    this._active = null;
    this._history = [];
    this.setMaxListeners(50);
    /** Resolves once old log files have been pruned (startup). Never rejects. */
    this.ready = this._pruneLogs();
  }

  /**
   * Start a job. The executor runs on a later tick; start() returns synchronously.
   * @param {string} kind one of JOB_KINDS
   * @param {{ title?: string, steps?: Array<{id: string, label?: string}|string> }} opts
   * @param {(ctx: object) => any} executor async function receiving the job context; its return
   *   value becomes the job result
   * @returns {string} jobId
   * @throws {Error} `BUSY: <title of the running job>` (code 'BUSY') while another job runs
   */
  start(kind, opts, executor) {
    if (!JOB_KINDS.includes(kind)) throw new TypeError(`Unknown job kind "${kind}"`);
    if (typeof executor !== 'function') throw new TypeError('start: executor must be a function');
    if (this._active) {
      const err = new Error(`BUSY: ${this._active.title}`);
      err.code = 'BUSY';
      err.activeJobId = this._active.id;
      throw err;
    }
    const o = opts && typeof opts === 'object' ? opts : {};
    const title = (typeof o.title === 'string' && o.title.trim() ? o.title.trim() : DEFAULT_TITLES[kind]).slice(0, 200);
    const job = {
      id: this._newId(),
      kind,
      title,
      steps: normalizeSteps(o.steps),
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      result: null,
      error: null,
      warnings: [],
      progress: null,
      tail: [],
      logFile: null,
      stream: null,
      pendingLines: [],
      droppedLines: 0,
      logTimer: null,
      progressTimer: null,
      pendingProgress: null,
      lastProgressEmit: 0,
      children: new Set(),
      cancelRequested: false,
      abort: new AbortController(),
      finished: false,
      waiters: [],
      watchdog: null,
      ctx: null,
    };
    this._active = job;
    this._openLog(job);
    job.ctx = this._makeCtx(job);
    this._emit({
      type: 'started', jobId: job.id, kind, title, steps: job.steps.map((s) => ({ ...s })), startedAt: job.startedAt,
    });
    Promise.resolve().then(() => this._run(job, executor)).catch(() => {});
    return job.id;
  }

  /**
   * Request cancellation of the running job: aborts ctx.signal and kills its process trees.
   * Calling it again re-sends the kill.
   * @param {string} jobId
   * @returns {boolean} false when that job is not running
   */
  cancel(jobId) {
    const job = this._active;
    if (!job || job.id !== jobId || job.finished) return false;
    if (!job.cancelRequested) {
      job.cancelRequested = true;
      this._log(job, 'Stopping…', 'warn');
      try {
        job.abort.abort(new CancelledError());
      } catch {
        // an abort listener threw: ignore, the job is still cancelled
      }
      if (this.cancelGraceMs > 0) {
        job.watchdog = setTimeout(() => {
          if (job.finished) return;
          this._log(job, 'The task did not stop in time; it was marked as cancelled.', 'warn');
          this._finish(job, 'cancelled', null, null);
        }, this.cancelGraceMs);
      }
    }
    for (const rec of job.children) this._killTree(rec);
    return true;
  }

  /** @returns {object|null} summary of the running job */
  active() {
    return this._active ? summarize(this._active) : null;
  }

  /** @returns {object[]} finished jobs, newest first (≤ 30) */
  history() {
    return this._history.map(summarize);
  }

  /**
   * The in-memory log of a job (running or in history), one formatted line per entry
   * ("HH:MM:SS.mmm [stderr] text"); '' for unknown jobs.
   * @param {string} jobId
   * @returns {string}
   */
  getLog(jobId) {
    const job = this._find(jobId);
    if (!job) return '';
    const head = `# ${job.title} (${job.kind}, job ${job.id}) started ${new Date(job.startedAt).toLocaleString()}`;
    const lines = job.tail.length > LIMITS.tailLines ? job.tail.slice(-LIMITS.tailLines) : job.tail;
    return [head, ...lines.map(formatLogLine)].join('\n');
  }

  /** @returns {boolean} true while a setup/fetch/upscale/pdf/offset/calibration job runs */
  isMutating() {
    return !!this._active && !this._active.finished && MUTATING_KINDS.includes(this._active.kind);
  }

  /**
   * Resolve with the job summary once it has finished (immediately if it already has).
   * @param {string} jobId
   * @returns {Promise<object|null>} null for unknown jobs
   */
  whenFinished(jobId) {
    const job = this._find(jobId);
    if (!job) return Promise.resolve(null);
    if (job.finished) return Promise.resolve(summarize(job));
    return new Promise((resolve) => { job.waiters.push(resolve); });
  }

  /** Cancel the running job (if any); for app shutdown (then await whenFinished(id)). */
  dispose() {
    if (this._active) this.cancel(this._active.id);
  }

  // ------------------------------------------------------------ internals

  _newId() {
    for (;;) {
      const id = crypto.randomBytes(4).toString('hex');
      if (!this._find(id)) return id;
    }
  }

  _find(jobId) {
    if (this._active && this._active.id === jobId) return this._active;
    return this._history.find((j) => j.id === jobId) || null;
  }

  _scmCacheDirValue() {
    const v = typeof this._scmCacheDir === 'function' ? this._scmCacheDir() : this._scmCacheDir;
    return v || path.join(os.tmpdir(), 'kirigami');
  }

  _emit(evt) {
    try {
      this.emit('event', evt);
    } catch {
      // a listener threw: never let it break the job
    }
  }

  _makeCtx(job) {
    const mgr = this;
    return Object.freeze({
      jobId: job.id,
      kind: job.kind,
      signal: job.abort.signal,
      get cancelled() { return job.cancelRequested; },
      log: (line, stream = 'info') => mgr._log(job, line, stream),
      progress: (p) => mgr._progress(job, p),
      step: (id, status, label) => mgr._step(job, id, status, label),
      warn: (msg) => mgr._warn(job, msg),
      throwIfCancelled: () => {
        if (job.cancelRequested || job.finished) throw new CancelledError();
      },
      spawn: (cmd, args, opts) => mgr._spawn(job, cmd, args, opts),
      pythonEnv: (extra) => pythonEnv(mgr._baseEnv || process.env, extra, mgr._scmCacheDirValue(), { platform: mgr.platform }),
    });
  }

  async _run(job, executor) {
    let result = null;
    let status;
    let error = null;
    try {
      const value = await executor(job.ctx);
      result = value === undefined ? null : value;
      status = 'succeeded';
      if (job.cancelRequested) this._log(job, 'The task finished before it could be stopped.', 'info');
    } catch (err) {
      if (job.cancelRequested || isCancelledError(err)) {
        status = 'cancelled';
        this._log(job, 'Cancelled.', 'warn');
      } else {
        status = 'failed';
        try {
          error = friendlyError({ err, kind: job.kind });
        } catch {
          error = { message: 'Something went wrong.', details: String(err && (err.stack || err.message) || err), code: 'UNKNOWN' };
        }
        this._log(job, error.message, 'error');
        if (error.details) this._writeFileText(job, `--- details ---\n${error.details}\n---------------`);
      }
    }
    this._finish(job, status, result, error);
  }

  _finish(job, status, result, error) {
    if (job.finished) return;
    if (job.watchdog) clearTimeout(job.watchdog);
    for (const rec of job.children) this._killTree(rec); // processes the executor forgot to await
    for (const s of job.steps) {
      let next = null;
      if (s.status === 'running') next = status === 'succeeded' ? 'done' : status;
      else if (s.status === 'pending' && status === 'succeeded') next = 'skipped';
      if (next) {
        s.status = next;
        this._emit({ type: 'step', jobId: job.id, stepId: s.id, status: next, label: s.label });
      }
    }
    this._flushProgress(job);
    job.endedAt = Date.now();
    const durationMs = job.endedAt - job.startedAt;
    this._log(job, `Finished (${status}) in ${formatDuration(durationMs)}.`, status === 'failed' ? 'error' : 'info');
    job.finished = true;
    job.status = status;
    job.result = status === 'succeeded' ? result : null;
    job.error = status === 'failed' ? error : null;
    this._flushLog(job);
    this._closeLog(job);
    if (this._active === job) this._active = null;
    this._history.unshift(job);
    if (this._history.length > LIMITS.history) this._history.length = LIMITS.history;
    this._emit({
      type: 'finished',
      jobId: job.id,
      kind: job.kind,
      status,
      result: job.result,
      error: job.error,
      warnings: job.warnings.slice(),
      endedAt: job.endedAt,
      durationMs,
    });
    for (const resolve of job.waiters.splice(0)) resolve(summarize(job));
    this._pruneLogs();
  }

  // ---- logging

  _log(job, text, stream = 'info') {
    if (job.finished) return;
    const s = LOG_STREAMS.has(stream) ? stream : 'info';
    const parts = String(text == null ? '' : text).split(/\r\n|\n|\r/);
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    const ts = Date.now();
    for (const part of parts) this._appendLine(job, { stream: s, line: capLine(part), ts });
  }

  _appendLine(job, entry) {
    if (job.finished) return;
    job.tail.push(entry);
    if (job.tail.length > LIMITS.tailLines + 500) job.tail.splice(0, job.tail.length - LIMITS.tailLines);
    if (job.stream) {
      try {
        job.stream.write(`${formatLogLine(entry)}\n`);
      } catch {
        job.stream = null;
      }
    }
    job.pendingLines.push(entry);
    if (job.pendingLines.length > LIMITS.logBatchMaxLines * 2) {
      const drop = job.pendingLines.length - LIMITS.logBatchMaxLines;
      job.pendingLines.splice(0, drop);
      job.droppedLines += drop;
    }
    if (!job.logTimer) {
      job.logTimer = setTimeout(() => this._flushLog(job), LIMITS.logBatchMs);
    }
  }

  _flushLog(job) {
    if (job.logTimer) {
      clearTimeout(job.logTimer);
      job.logTimer = null;
    }
    if (!job.pendingLines.length) return;
    let lines = job.pendingLines.splice(0);
    if (lines.length > LIMITS.logBatchMaxLines) {
      job.droppedLines += lines.length - LIMITS.logBatchMaxLines;
      lines = lines.slice(-LIMITS.logBatchMaxLines);
    }
    if (job.droppedLines) {
      lines.unshift({ stream: 'info', line: `… ${job.droppedLines} earlier lines are only in the log file`, ts: lines[0].ts });
      job.droppedLines = 0;
    }
    this._emit({ type: 'log', jobId: job.id, lines });
  }

  _writeFileText(job, text) {
    if (!job.stream) return;
    try {
      job.stream.write(`${text}\n`);
    } catch {
      job.stream = null;
    }
  }

  _openLog(job) {
    if (!this.jobLogDir) return;
    try {
      fs.mkdirSync(this.jobLogDir, { recursive: true });
      const file = path.join(this.jobLogDir, `${timestampId(new Date(job.startedAt))}-${job.kind}-${job.id}.log`);
      const stream = fs.createWriteStream(file, { flags: 'a', encoding: 'utf8' });
      stream.on('error', () => {
        if (job.stream === stream) job.stream = null;
      });
      job.stream = stream;
      job.logFile = file;
      stream.write(`# Kirigami job ${job.id} (${job.kind}) "${job.title}" started ${new Date(job.startedAt).toISOString()}\n`);
    } catch {
      job.stream = null;
      job.logFile = null;
    }
  }

  _closeLog(job) {
    const stream = job.stream;
    job.stream = null;
    if (stream) {
      try {
        stream.end();
      } catch {
        // already closed
      }
    }
  }

  /** Keep the newest `keepLogFiles` job logs. Never rejects. */
  async _pruneLogs() {
    if (!this.jobLogDir) return;
    try {
      await fsp.mkdir(this.jobLogDir, { recursive: true });
      const names = (await fsp.readdir(this.jobLogDir)).filter((n) => n.toLowerCase().endsWith('.log')).sort().reverse();
      const activeFile = this._active && this._active.logFile ? path.basename(this._active.logFile) : null;
      const keep = Math.max(1, this.keepLogFiles);
      const victims = names.slice(keep).filter((n) => n !== activeFile);
      await Promise.all(victims.map((n) => fsp.unlink(path.join(this.jobLogDir, n)).catch(() => {})));
    } catch {
      // logs folder unavailable: nothing to prune
    }
  }

  // ---- progress / steps / warnings

  _progress(job, p) {
    if (job.finished) return;
    const prog = normalizeProgress(p);
    job.progress = prog;
    job.pendingProgress = prog;
    if (job.progressTimer) return;
    const wait = LIMITS.progressIntervalMs - (Date.now() - job.lastProgressEmit);
    if (wait <= 0) {
      this._emitProgress(job);
    } else {
      job.progressTimer = setTimeout(() => {
        job.progressTimer = null;
        this._emitProgress(job);
      }, wait);
    }
  }

  _emitProgress(job) {
    const prog = job.pendingProgress;
    if (!prog) return;
    job.pendingProgress = null;
    job.lastProgressEmit = Date.now();
    this._emit({ type: 'progress', jobId: job.id, ...prog });
  }

  _flushProgress(job) {
    if (job.progressTimer) {
      clearTimeout(job.progressTimer);
      job.progressTimer = null;
    }
    this._emitProgress(job);
  }

  _step(job, id, status, label) {
    if (job.finished || id == null) return;
    const sid = String(id);
    const raw = String(status == null ? 'running' : status);
    const st = STEP_ALIASES[raw] || raw;
    let step = job.steps.find((s) => s.id === sid);
    if (!step) {
      step = { id: sid, label: label != null ? String(label) : sid, status: 'pending' };
      job.steps.push(step);
    }
    if (label != null) step.label = String(label);
    step.status = STEP_STATUSES.has(st) ? st : raw;
    if (st === 'running') this._log(job, `Step: ${step.label}`, 'info');
    else if (st === 'failed') this._log(job, `Step failed: ${step.label}`, 'error');
    this._emit({ type: 'step', jobId: job.id, stepId: sid, status: step.status, label: step.label });
  }

  _warn(job, msg) {
    if (job.finished) return;
    const text = String(msg == null ? '' : msg).trim();
    if (!text) return;
    if (!job.warnings.includes(text) && job.warnings.length < LIMITS.maxWarnings) job.warnings.push(text);
    this._log(job, `Warning: ${text}`, 'warn');
  }

  // ---- processes

  _killTree(rec) {
    if (rec.exited) return;
    const { child } = rec;
    const pid = child && child.pid;
    if (!pid) {
      try { child.kill(); } catch { /* not running */ }
      return;
    }
    if (this.platform === 'win32') {
      const taskkill = path.join(this.systemRoot, 'System32', 'taskkill.exe');
      let killer = null;
      try {
        killer = this.spawnImpl(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      } catch {
        killer = null;
      }
      if (killer && typeof killer.on === 'function') {
        killer.on('error', () => {
          if (!rec.exited) { try { child.kill(); } catch { /* gone */ } }
        });
      } else {
        try { child.kill(); } catch { /* gone */ }
      }
      if (!rec.forceTimer) {
        rec.forceTimer = setTimeout(() => {
          if (!rec.exited) { try { child.kill(); } catch { /* gone */ } }
        }, this.killGraceMs + 2000);
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* gone */ }
      }
      if (!rec.forceTimer) {
        rec.forceTimer = setTimeout(() => {
          if (rec.exited) return;
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            try { child.kill('SIGKILL'); } catch { /* gone */ }
          }
        }, this.killGraceMs);
      }
    }
  }

  _spawnError(job, err, name, command) {
    const code = err && err.code;
    const reason = err && err.message ? err.message : String(err);
    this._log(job, `Could not start ${name}: ${reason}`, 'error');
    const details = `Command: ${command}\n${reason}`;
    if (code === 'EPERM' || code === 'EACCES') {
      return userError(`Windows or your antivirus blocked ${name}.`, { code: 'START_BLOCKED', details, cause: err });
    }
    return userError(`Could not start ${name}.`, { code: 'START_FAILED', details, cause: err });
  }

  /**
   * ctx.spawn implementation.
   * @returns {Promise<{ code: number|null, signal: string|null, stdoutTail: string[], stderrTail: string[], durationMs: number, pid: number|null }>}
   */
  async _spawn(job, cmd, args = [], opts = {}) {
    if (job.finished || job.cancelRequested) throw new CancelledError();
    if (typeof cmd !== 'string' || !cmd.trim()) throw new TypeError('spawn: cmd must be a non-empty string');
    if (!Array.isArray(args)) throw new TypeError('spawn: args must be an array');
    const o = opts && typeof opts === 'object' ? opts : {};
    const argv = args.map((a) => String(a));
    const name = typeof o.name === 'string' && o.name ? o.name : programLabel(cmd);
    const command = formatCommand(cmd, argv);
    if (o.cwd != null) {
      let isDir = false;
      try {
        isDir = (await fsp.stat(o.cwd)).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) {
        throw userError(`Could not start ${name}: the folder "${o.cwd}" does not exist.`, { code: 'START_FAILED', details: `Command: ${command}` });
      }
      if (job.finished || job.cancelRequested) throw new CancelledError();
    }
    this._log(job, `> ${command}${o.cwd ? `   (in ${o.cwd})` : ''}`, 'info');

    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      let child;
      try {
        child = this.spawnImpl(cmd, argv, {
          cwd: o.cwd,
          env: o.env,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: this.platform !== 'win32',
        });
      } catch (err) {
        reject(this._spawnError(job, err, name, command));
        return;
      }
      const rec = { child, exited: false, forceTimer: null };
      job.children.add(rec);
      const stdoutTail = new LineTail(LIMITS.errorTailLines);
      const stderrTail = new LineTail(LIMITS.parseTailLines);
      let settled = false;
      let spawned = false;
      let timedOut = false;
      let timeoutTimer = null;
      let closeTimer = null;
      let onLineFailed = false;

      const settle = (fn) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (closeTimer) clearTimeout(closeTimer);
        if (rec.forceTimer) clearTimeout(rec.forceTimer);
        job.children.delete(rec);
        fn();
      };

      const handleLine = (raw, stream) => {
        const line = capLine(raw);
        if (!isProgressOnlyLine(line)) {
          this._appendLine(job, { stream, line, ts: Date.now() });
          (stream === 'stderr' ? stderrTail : stdoutTail).push(line);
        }
        if (typeof o.onLine === 'function') {
          const reportOnce = (err) => {
            if (onLineFailed) return;
            onLineFailed = true;
            this._log(job, `Internal error while reading the output: ${err && err.message}`, 'error');
          };
          try {
            const ret = o.onLine(line, stream);
            if (ret && typeof ret.then === 'function') ret.then(undefined, reportOnce);
          } catch (err) {
            reportOnce(err);
          }
        }
      };

      const attach = (readable, stream) => {
        if (!readable) return;
        const decoder = new StringDecoder('utf8');
        const state = { carry: '', skipLF: false };
        readable.on('data', (chunk) => {
          for (const line of splitLines(state, decoder.write(chunk))) handleLine(line, stream);
        });
        readable.on('end', () => {
          const rest = decoder.end();
          const lines = rest ? splitLines(state, rest) : [];
          for (const line of lines.concat(splitLines(state, null))) handleLine(line, stream);
        });
        readable.on('error', () => {});
      };
      attach(child.stdout, 'stdout');
      attach(child.stderr, 'stderr');

      const onClose = (code, signal) => {
        rec.exited = true;
        if (settled) return;
        const durationMs = Date.now() - startedAt;
        this._log(job, `Process ended (exit code ${code === null || code === undefined ? '-' : code}${signal ? `, signal ${signal}` : ''}) after ${formatDuration(durationMs)}.`, 'info');
        if (job.cancelRequested || job.finished) {
          settle(() => reject(new CancelledError()));
          return;
        }
        if (timedOut) {
          settle(() => reject(userError(
            `${name.charAt(0).toUpperCase()}${name.slice(1)} took too long (more than ${formatDuration(o.timeoutMs)}) and was stopped.`,
            { code: 'TIMEOUT', details: `Command: ${command}` },
          )));
          return;
        }
        const stderrLines = stderrTail.toArray();
        const out = {
          code: code === undefined ? null : code,
          signal: signal || null,
          stdoutTail: stdoutTail.toArray(),
          stderrTail: stderrLines.slice(-LIMITS.errorTailLines),
          durationMs,
          pid: child.pid || null,
        };
        if (out.code !== 0 && !o.allowNonZero) {
          settle(() => reject(new JobProcessError({
            code: out.code,
            signal: out.signal,
            stderrTail: out.stderrTail,
            stdoutTail: out.stdoutTail,
            pythonError: parsePythonError(stderrLines),
            command,
            program: name,
          })));
          return;
        }
        settle(() => resolve(out));
      };

      child.once('spawn', () => { spawned = true; });
      child.on('error', (err) => {
        if (spawned || settled) {
          this._log(job, `Process error: ${err && err.message}`, 'error');
          return;
        }
        rec.exited = true;
        settle(() => reject(this._spawnError(job, err, name, command)));
      });
      child.once('exit', (code, signal) => {
        rec.exited = true;
        if (rec.forceTimer) clearTimeout(rec.forceTimer);
        if (settled) return;
        closeTimer = setTimeout(() => {
          // stdout/stderr still open after exit: a grandchild inherited them. Stop waiting.
          try { if (child.stdout) child.stdout.destroy(); } catch { /* ignore */ }
          try { if (child.stderr) child.stderr.destroy(); } catch { /* ignore */ }
          onClose(code, signal);
        }, LIMITS.closeAfterExitMs);
      });
      child.once('close', (code, signal) => onClose(code, signal));

      if (Number.isFinite(o.timeoutMs) && o.timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          timedOut = true;
          this._log(job, `${name} is taking too long; stopping it.`, 'warn');
          this._killTree(rec);
        }, o.timeoutMs);
      }
    });
  }
}

module.exports = {
  JobManager,
  CancelledError,
  JobProcessError,
  splitLines,
  isProgressOnlyLine,
  pythonEnv,
  JOB_KINDS,
  MUTATING_KINDS,
  LIMITS,
  formatCommand,
  timestampId,
};
