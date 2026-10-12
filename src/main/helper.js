'use strict';

/**
 * Runs src/python/scm_helper.py with the card maker's Python.
 *
 *   python scm_helper.py <sub> --root <workspace> --out <tmp json> [--list <tmp json>] [...args]
 *
 * - cwd = workspace (falls back to scm-cache/tmp while the workspace does not exist yet),
 *   env = jobs.pythonEnv(), stdin ignored, window hidden.
 * - The result is read from the --out JSON file (stdout is never parsed), which is deleted.
 * - A timeout or an AbortSignal kills the whole process tree.
 * - Every run takes the shared Python lock (setup holds the exclusive one) unless
 *   `{ lock: false }` is passed by code that already holds the exclusive lock.
 * - Failures reject with a friendly Error `{ message, code, details, sub, exitCode, pythonError }`.
 *
 * introspect() caches its result in scm-cache/introspection.json, keyed by the workspace,
 * Python, engine root and the mtime+size of every engine file that shapes the result.
 * It only runs once the environment is ready (else it rejects with 'NOT_READY: ...').
 */

const child_process = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const fsp = fs.promises;

const SUBCOMMANDS = Object.freeze([
  'introspect',
  'env-check',
  'smoke-test',
  'prepare-upscale',
  'validate-images',
  'list-images',
  'merge-pdfs',
  'pdf-info',
]);
const DEFAULT_TIMEOUT_MS = 120000;
const TAIL_LINES = 200;
const MAX_LINE = 4096;
const CACHE_VERSION = 1;
const INTROSPECTION_KEY_FILES = ['create_pdf.py', 'offset_pdf.py', 'utilities.py', 'page_manager.py', 'assets/layouts.json'];

/** A user-facing error (errors.friendlyError passes `friendly: true` errors through unchanged). */
function makeError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, friendly: true, details: '' }, extra);
}

function sha1(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

async function statSafe(p) {
  if (!p) return null;
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function quoteArg(arg) {
  const s = String(arg);
  return /^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}

/** Last-N line collector with UTF-8 decoding, partial-line carry and a 4 KB line cap. */
function createLineCollector(max, onLine) {
  const decoder = new StringDecoder('utf8');
  const lines = [];
  let carry = '';
  const push = (line) => {
    const text = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
    lines.push(text);
    if (lines.length > max) lines.shift();
    if (onLine) {
      try {
        onLine(text);
      } catch {
        /* a listener must not break the run */
      }
    }
  };
  return {
    write(chunk) {
      const parts = (carry + decoder.write(chunk)).split(/\r\n|\n|\r/);
      carry = parts.pop();
      if (carry.length > 64 * 1024) {
        push(carry);
        carry = '';
      }
      for (const part of parts) push(part);
    },
    flush() {
      const rest = carry + decoder.end();
      carry = '';
      if (rest) push(rest);
    },
    lines: () => lines.slice(),
  };
}

/** Same environment rules as jobs.pythonEnv (used only if jobs.js cannot be loaded). */
function fallbackPythonEnv(baseEnv, extra, scmCacheDir) {
  const env = {};
  const keep = new Set(Object.keys(extra || {}));
  for (const [key, value] of Object.entries(baseEnv || {})) {
    const upper = key.toUpperCase();
    if (keep.has(key)) continue;
    if (upper.startsWith('PYTHON') || upper.startsWith('UV_')) continue;
    if (['VIRTUAL_ENV', 'CONDA_PREFIX', 'SCM_EXTRA_LAYOUTS', 'SCM_CUTTING_TEMPLATES_DIR'].includes(upper)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8:backslashreplace',
    PYTHONHASHSEED: '0',
    PYTHONDONTWRITEBYTECODE: '1',
    MPLBACKEND: 'Agg',
  });
  if (scmCacheDir) env.MPLCONFIGDIR = path.join(scmCacheDir, 'mpl');
  return Object.assign(env, extra || {});
}

function fallbackParsePythonError(lines) {
  const list = (lines || []).map((l) => String(l).trimEnd()).filter(Boolean);
  const re = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt))(?::\s*(.*))?$/;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = re.exec(list[i]);
    if (m) return { type: m[1], message: m[2] || '', raw: list[i] };
  }
  return list.length ? { type: null, message: list[list.length - 1], raw: list[list.length - 1] } : null;
}

async function writeFileAtomic(file, data) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(tmp, file);
      return;
    } catch (err) {
      if (attempt >= 9 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
  }
}

/**
 * Create the helper runner.
 *
 * @param {() => object} getDeps returns the app deps (getPaths, locks, logger, ...). A deps
 *   object is accepted too.
 * @param {object} [overrides] test seams: { spawnImpl, platform, systemRoot, pythonEnv,
 *   friendlyError, parsePythonError, CancelledError, checkEnv }
 * @returns {{
 *   run: (sub: string, args?: string[], options?: {timeoutMs?: number, lock?: boolean, signal?: AbortSignal, onLine?: (line: string, stream: string) => void, list?: any}) => Promise<any>,
 *   introspect: (options?: {force?: boolean}) => Promise<object>,
 *   invalidate: () => void,
 *   introspectionKey: () => Promise<{key: string, info: object}>,
 *   SUBCOMMANDS: readonly string[],
 * }}
 */
function createHelper(getDeps, overrides = {}) {
  const resolveDeps = typeof getDeps === 'function' ? getDeps : () => getDeps;
  const impl = {
    spawnImpl: overrides.spawnImpl || child_process.spawn,
    platform: overrides.platform || process.platform,
    systemRoot: overrides.systemRoot || process.env.SystemRoot || process.env.windir || 'C:\\Windows',
  };
  let memo = null;
  let inflight = null;

  function optionalModule(name) {
    try {
      return require(name);
    } catch {
      return {};
    }
  }

  function pythonEnvFn() {
    if (overrides.pythonEnv) return overrides.pythonEnv;
    const fn = optionalModule('./jobs').pythonEnv;
    return typeof fn === 'function' ? fn : fallbackPythonEnv;
  }

  function errorsModule() {
    const mod = optionalModule('./errors');
    return {
      friendlyError: overrides.friendlyError || (typeof mod.friendlyError === 'function' ? mod.friendlyError : null),
      parsePythonError: overrides.parsePythonError || (typeof mod.parsePythonError === 'function' ? mod.parsePythonError : fallbackParsePythonError),
    };
  }

  function cancelledError() {
    const Ctor = overrides.CancelledError || optionalModule('./jobs').CancelledError;
    if (typeof Ctor === 'function') {
      try {
        return new Ctor('Cancelled');
      } catch {
        /* fall through */
      }
    }
    return Object.assign(new Error('Cancelled'), { name: 'CancelledError', code: 'CANCELLED', cancelled: true });
  }

  function log(level, message) {
    try {
      const logger = resolveDeps().logger;
      if (logger && typeof logger[level] === 'function') logger[level](message);
    } catch {
      /* ignore */
    }
  }

  function killTree(child) {
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const pid = child.pid;
    if (impl.platform === 'win32') {
      const taskkill = path.win32.join(impl.systemRoot, 'System32', 'taskkill.exe');
      try {
        const killer = impl.spawnImpl(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
        killer.on('error', () => {
          try {
            child.kill();
          } catch {
            /* gone */
          }
        });
      } catch {
        try {
          child.kill();
        } catch {
          /* gone */
        }
      }
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          child.kill('SIGTERM');
        } catch {
          /* gone */
        }
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }, 3000);
      if (timer.unref) timer.unref();
    }
  }

  function spawnAndWait(cmd, argv, { cwd, env, timeoutMs, signal, onLine }) {
    return new Promise((resolve) => {
      const stdout = createLineCollector(TAIL_LINES, onLine ? (line) => onLine(line, 'stdout') : null);
      const stderr = createLineCollector(TAIL_LINES, onLine ? (line) => onLine(line, 'stderr') : null);
      let child;
      let settled = false;
      let timedOut = false;
      let cancelled = false;
      let timer = null;
      const onAbort = () => {
        cancelled = true;
        killTree(child);
      };
      const finish = (extra) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        stdout.flush();
        stderr.flush();
        resolve({ code: null, signal: null, spawnError: null, ...extra, timedOut, cancelled, stdoutLines: stdout.lines(), stderrLines: stderr.lines() });
      };
      try {
        child = impl.spawnImpl(cmd, argv, {
          cwd,
          env,
          windowsHide: true,
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: impl.platform !== 'win32',
        });
      } catch (err) {
        finish({ spawnError: err });
        return;
      }
      if (child.stdout) child.stdout.on('data', (chunk) => stdout.write(chunk));
      if (child.stderr) child.stderr.on('data', (chunk) => stderr.write(chunk));
      child.on('error', (err) => {
        if (child.pid === undefined || err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EPERM') finish({ spawnError: err });
      });
      child.on('close', (code, sig) => finish({ code, signal: sig }));
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs);
      }
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async function readResult(file) {
    let text;
    try {
      text = await fsp.readFile(file, 'utf8');
    } catch {
      return { missing: true, data: null };
    }
    try {
      return { missing: false, data: JSON.parse(text.replace(/^\uFEFF/, '')) };
    } catch (err) {
      return { missing: false, data: null, parseError: err };
    }
  }

  function friendly(sub, python, argv, proc, result, timeoutMs) {
    const command = [python, ...argv].map(quoteArg).join(' ');
    const details = [];
    if (proc.spawnError) {
      const code = proc.spawnError.code;
      const blocked = code === 'EPERM' || code === 'EACCES';
      return makeError(
        blocked
          ? `Windows or your antivirus blocked the card maker's Python (${python}).`
          : `Could not start the card maker's Python (${python}). Open Settings and choose Repair components.`,
        blocked ? 'BLOCKED' : 'PYTHON_START_FAILED',
        { details: `${proc.spawnError.message}\n${command}`, sub, exitCode: null, pythonError: null, cause: proc.spawnError },
      );
    }
    if (proc.timedOut) {
      return makeError(
        `The card maker took too long to answer (more than ${Math.round(timeoutMs / 1000)} seconds) and was stopped.`,
        'TIMEOUT',
        { details: `${command}\n${proc.stderrLines.slice(-30).join('\n')}`, sub, exitCode: proc.code, pythonError: null },
      );
    }
    const data = result.data && typeof result.data === 'object' ? result.data : null;
    const { friendlyError, parsePythonError } = errorsModule();
    let pythonError = null;
    if (data && data.error) {
      pythonError = { type: data.type || null, message: data.message !== undefined ? String(data.message) : String(data.error), raw: String(data.error) };
    } else {
      try {
        pythonError = parsePythonError(proc.stderrLines);
      } catch {
        pythonError = fallbackParsePythonError(proc.stderrLines);
      }
    }
    if (data && data.traceback) details.push(String(data.traceback).trimEnd());
    else if (proc.stderrLines.length) details.push(proc.stderrLines.slice(-30).join('\n'));
    if (result.parseError) details.push(`Unreadable result file: ${result.parseError.message}`);
    details.push(command);
    const err = Object.assign(new Error(pythonError ? pythonError.raw : `scm_helper ${sub} exited with code ${proc.code}`), {
      name: 'HelperProcessError',
      code: proc.code,
      signal: proc.signal,
      stderrTail: proc.stderrLines.slice(-30),
      stdoutTail: proc.stdoutLines.slice(-30),
      pythonError,
      command,
    });
    let info = null;
    if (friendlyError) {
      try {
        info = friendlyError({ err, kind: 'helper', context: { sub } });
      } catch (e) {
        log('warn', `friendlyError failed: ${e.message}`);
      }
    }
    if (!info || !info.message) {
      const short = pythonError && pythonError.message ? pythonError.message : `the helper stopped with code ${proc.code}`;
      info = { message: `Something went wrong: ${short}`, code: 'UNKNOWN', details: null };
    }
    return makeError(info.message, info.code || 'UNKNOWN', {
      details: info.details || details.join('\n\n'),
      sub,
      exitCode: proc.code,
      pythonError,
      cause: err,
    });
  }

  async function execute(deps, sub, args, { timeoutMs, signal, onLine, list }) {
    const paths = deps.getPaths();
    const python = paths.pythonPath;
    const pythonStat = await statSafe(python);
    if (!pythonStat || !pythonStat.isFile()) {
      throw makeError('The card maker components are not installed yet. Open Setup to install them.', 'NOT_INSTALLED', { sub });
    }
    const helperStat = await statSafe(paths.helperScript);
    if (!helperStat || !helperStat.isFile()) {
      throw makeError('A part of Silhouette Card Maker is missing (scm_helper.py). Please reinstall the app.', 'HELPER_MISSING', { sub });
    }
    if (signal && signal.aborted) throw cancelledError();

    const tmpDir = path.join(paths.scmCacheDir, 'tmp');
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.mkdir(path.join(paths.scmCacheDir, 'mpl'), { recursive: true }).catch(() => {});
    const id = `${Date.now().toString(36)}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const outFile = path.join(tmpDir, `helper-${sub}-${id}.json`);
    const listFile = list === undefined ? null : path.join(tmpDir, `helper-${sub}-${id}.list.json`);
    try {
      if (listFile) await fsp.writeFile(listFile, JSON.stringify(list), 'utf8');
      const wsStat = await statSafe(paths.workspaceDir);
      const cwd = wsStat && wsStat.isDirectory() ? paths.workspaceDir : tmpDir;
      const hasRoot = args.some((a) => a === '--root' || a.startsWith('--root='));
      const argv = [
        paths.helperScript,
        sub,
        ...(hasRoot ? [] : ['--root', paths.workspaceDir]),
        '--out',
        outFile,
        ...(listFile ? ['--list', listFile] : []),
        ...args,
      ];
      const env = pythonEnvFn()(process.env, {}, paths.scmCacheDir);
      const proc = await spawnAndWait(python, argv, { cwd, env, timeoutMs, signal, onLine });
      if (proc.cancelled) throw cancelledError();
      const result = proc.spawnError ? { missing: true, data: null } : await readResult(outFile);
      if (!proc.spawnError && !proc.timedOut && proc.code === 0 && result.data && typeof result.data === 'object' && !result.data.error) {
        return result.data;
      }
      const error = friendly(sub, python, argv, proc, result, timeoutMs);
      log('warn', `scm_helper ${sub} failed: ${error.message}\n${error.details || ''}`);
      throw error;
    } finally {
      await fsp.rm(outFile, { force: true }).catch(() => {});
      if (listFile) await fsp.rm(listFile, { force: true }).catch(() => {});
    }
  }

  /**
   * Run one helper command and resolve with its JSON result.
   * @param {string} sub one of SUBCOMMANDS
   * @param {string[]} [args] extra arguments (e.g. ['--requirements', file]); `--root` and
   *   `--out` are added automatically (a caller-provided --root wins). For merge-pdfs pass
   *   ['--output', merged, '--inputs', a, b, ...].
   * @param {object} [options]
   * @param {number} [options.timeoutMs=120000] tree-kill after this delay (0 = none)
   * @param {boolean} [options.lock=true] take the shared Python lock (false only while
   *   already holding the exclusive lock, i.e. inside the setup job)
   * @param {AbortSignal} [options.signal] abort -> tree kill -> rejects with CancelledError
   * @param {(line: string, stream: 'stdout'|'stderr') => void} [options.onLine] live log lines
   * @param {any} [options.list] written to a temp JSON file passed as `--list <file>`
   * @returns {Promise<any>}
   */
  async function run(sub, args = [], options = {}) {
    if (!SUBCOMMANDS.includes(sub)) throw new TypeError(`Unknown helper command: ${sub}`);
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) throw new TypeError('helper.run: args must be an array of strings');
    const opts = options || {};
    const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs >= 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const exec = () => execute(resolveDeps(), sub, args, { timeoutMs, signal: opts.signal || null, onLine: opts.onLine || null, list: opts.list });
    const locks = resolveDeps().locks;
    if (opts.lock === false || !locks || typeof locks.withPythonShared !== 'function') return exec();
    let started = false;
    try {
      return await locks.withPythonShared(() => {
        started = true;
        return exec();
      });
    } catch (err) {
      if (!started && err && typeof err === 'object') {
        if (!err.code) err.code = 'PYTHON_BUSY';
        err.pythonBusy = true;
      }
      throw err;
    }
  }

  async function stamp(file) {
    const st = await statSafe(file);
    return st ? `${Math.round(st.mtimeMs)}:${st.size}` : 'missing';
  }

  async function listDir(dir) {
    try {
      return (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch {
      return [];
    }
  }

  async function templateListing(engineRoot) {
    const names = [];
    const walk = async (dir, rel) => {
      for (const entry of await listDir(dir)) {
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
        else if (/\.studio3$/i.test(entry.name)) names.push(childRel);
      }
    };
    await walk(path.join(engineRoot, 'cutting_templates'), '');
    return sha1(names.join('\n'));
  }

  /**
   * Cache key of the introspection result (see module doc).
   * @returns {Promise<{key: string, info: object}>}
   */
  async function introspectionKey() {
    const paths = resolveDeps().getPaths();
    const ws = path.resolve(paths.workspaceDir);
    const files = {};
    for (const rel of INTROSPECTION_KEY_FILES) files[rel] = await stamp(path.join(ws, rel));
    for (const entry of await listDir(path.join(ws, 'assets', 'extra_layouts'))) {
      if (entry.isFile() && /\.json$/i.test(entry.name)) files[`assets/extra_layouts/${entry.name}`] = await stamp(path.join(ws, 'assets', 'extra_layouts', entry.name));
    }
    for (const entry of await listDir(path.join(ws, 'plugins'))) {
      if (!entry.isDirectory()) continue;
      for (const name of ['fetch.py', 'deck_formats.py']) {
        files[`plugins/${entry.name}/${name}`] = await stamp(path.join(ws, 'plugins', entry.name, name));
      }
    }
    const info = {
      v: CACHE_VERSION,
      workspace: ws,
      python: path.resolve(paths.pythonPath || ''),
      pythonStamp: await stamp(paths.pythonPath),
      engineRoot: path.resolve(paths.engineSourceDir),
      helper: await stamp(paths.helperScript),
      templates: await templateListing(path.resolve(paths.engineSourceDir)),
      files,
    };
    return { key: sha1(JSON.stringify(info)), info };
  }

  function validIntrospection(data) {
    return !!(
      data &&
      data.commands &&
      data.commands.create_pdf &&
      Array.isArray(data.commands.create_pdf.params) &&
      Array.isArray(data.plugins) &&
      data.layouts &&
      Array.isArray(data.layouts.combos)
    );
  }

  async function envReady(deps) {
    const check = overrides.checkEnv || require('./python-env').checkEnv;
    const status = await check(deps, {});
    return !!(status && status.ready);
  }

  /**
   * Engine introspection (§7.1), cached on disk and in memory.
   * @param {{force?: boolean}} [options] force = ignore the cache
   * @returns {Promise<object>}
   */
  async function introspect({ force = false } = {}) {
    const deps = resolveDeps();
    if (!(await envReady(deps))) {
      throw makeError("NOT_READY: the card maker components aren't ready yet. Finish the setup first.", 'NOT_READY');
    }
    const paths = deps.getPaths();
    const cacheFile = path.join(paths.scmCacheDir, 'introspection.json');
    const { key, info } = await introspectionKey();
    if (!force) {
      if (memo && memo.key === key) return memo.data;
      try {
        const cached = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
        if (cached && cached.version === CACHE_VERSION && cached.key === key && validIntrospection(cached.data)) {
          memo = { key, data: cached.data };
          return cached.data;
        }
      } catch {
        /* no usable cache */
      }
    }
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = (async () => {
      const data = await run('introspect', ['--engine-root', path.resolve(paths.engineSourceDir)], { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!validIntrospection(data)) throw makeError('Something went wrong: the card maker returned an incomplete description of its options.', 'INTROSPECTION_INVALID');
      memo = { key, data };
      try {
        await writeFileAtomic(cacheFile, JSON.stringify({ version: CACHE_VERSION, key, keyInfo: info, at: new Date().toISOString(), data }));
      } catch (err) {
        log('warn', `Could not save the introspection cache: ${err.message}`);
      }
      return data;
    })();
    inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (inflight && inflight.promise === promise) inflight = null;
    }
  }

  /** Drop the in-memory introspection cache (the disk cache is keyed and self-validating). */
  function invalidate() {
    memo = null;
  }

  return { run, introspect, invalidate, introspectionKey, SUBCOMMANDS };
}

module.exports = { createHelper, SUBCOMMANDS, fallbackPythonEnv };
