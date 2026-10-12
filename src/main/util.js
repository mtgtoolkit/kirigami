'use strict';

/**
 * Shared main-process helpers (no Electron imports — unit-tested under plain Node).
 *
 * Conventions:
 * - Path helpers use the HOST platform's `path` module (win32 on Windows), so comparisons are
 *   case-insensitive on Windows (path.win32.relative ignores case).
 * - `ensureDir`, `readJson`, `uniqueStemPath`, `sha1Text`, `encodePng` are synchronous (safe to `await`).
 * - Everything that touches many bytes or retries (writers, copies, moves, hashing, disk space) is async.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** fs error codes worth retrying on Windows (antivirus / indexer / viewer briefly holding a file). */
const RETRYABLE_FS_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const IS_WIN = process.platform === 'win32';

/** Windows device names (reserved with or without an extension). Includes the superscript-digit variants. */
const RESERVED_WINDOWS_RE = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:[ .].*)?$/i;

// ---------------------------------------------------------------------------------------------
// Small generic helpers
// ---------------------------------------------------------------------------------------------

/**
 * Resolve after `ms` milliseconds.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));
}

/**
 * Block the current thread for `ms` milliseconds (main process only; used by sync flush paths).
 * @param {number} ms
 */
function sleepSync(ms) {
  const wait = Math.max(0, ms | 0);
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    const end = Date.now() + wait;
    while (Date.now() < end) { /* busy wait fallback */ }
  }
}

/**
 * True for plain objects (`{}` / `Object.create(null)`), false for arrays, null, class instances.
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ---------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------

/**
 * Normalize a path for comparisons: resolved, and lower-cased on Windows.
 * @param {string} p
 * @returns {string}
 */
function comparablePath(p) {
  const resolved = path.resolve(String(p));
  return IS_WIN ? resolved.toLowerCase() : resolved;
}

/**
 * True when two paths point to the same location (case-insensitive on Windows).
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  return comparablePath(a) === comparablePath(b);
}

/**
 * True when `child` is `parent` itself or lies inside it (lexical check, case-insensitive on Windows,
 * different drives are never inside each other). Symlinks are not resolved.
 * @param {string} parent
 * @param {string} child
 * @returns {boolean}
 */
function isInside(parent, child) {
  if (typeof parent !== 'string' || typeof child !== 'string' || !parent || !child) return false;
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false; // other drive / UNC share on Windows
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * Resolve a RELATIVE path (POSIX or Windows separators) inside `root` and return the absolute path.
 * Throws a TypeError when `rel` is empty, absolute, has a drive letter (`C:` / `C:\` / `C:foo`), is a
 * UNC / device path (`\\server`, `//server`, `\\?\`), contains a `..` (or dots/spaces-only) segment,
 * control characters, a `:` on Windows (alternate data streams), a reserved Windows device name, or
 * would resolve to `root` itself or outside it.
 * @param {string} root absolute directory
 * @param {string} rel relative path
 * @returns {string} absolute path strictly inside root
 */
function resolveInside(root, rel) {
  if (typeof root !== 'string' || !root) throw new TypeError('resolveInside: root must be a non-empty string');
  const fail = (why) => {
    const err = new TypeError(`Invalid file path "${String(rel).slice(0, 200)}": ${why}`);
    err.code = 'INVALID_PATH';
    return err;
  };
  if (typeof rel !== 'string') throw fail('not a string');
  if (rel.length === 0) throw fail('empty');
  if (rel.length > 4096) throw fail('too long');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(rel)) throw fail('control characters');
  if (/^[\\/]/.test(rel)) throw fail('absolute, UNC or device paths are not allowed');
  if (/^[a-zA-Z]:/.test(rel)) throw fail('drive letters are not allowed');
  if (path.win32.isAbsolute(rel) || path.posix.isAbsolute(rel)) throw fail('absolute paths are not allowed');
  if (IS_WIN && rel.includes(':')) throw fail('":" is not allowed');
  const segments = rel.split(/[\\/]+/).filter((s) => s !== '');
  if (segments.length === 0) throw fail('empty');
  for (const seg of segments) {
    if (/^[. ]+$/.test(seg)) throw fail('"." and ".." segments are not allowed');
    if (IS_WIN && isReservedWindowsName(seg)) throw fail(`"${seg}" is a reserved Windows name`);
  }
  const base = path.resolve(root);
  const abs = path.resolve(base, ...segments);
  if (!isInside(base, abs) || samePath(base, abs)) throw fail('outside of its folder');
  return abs;
}

/**
 * Convert backslashes to forward slashes.
 * @param {string} p
 * @returns {string}
 */
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/**
 * Create a directory (and parents) if missing. Synchronous; returns the directory (safe to `await`).
 * @param {string} dir
 * @returns {string}
 */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Display form of `abs`: POSIX path relative to `root` when inside it, else `abs` unchanged.
 * @param {string} root
 * @param {string} abs
 * @returns {string}
 */
function relForDisplay(root, abs) {
  if (typeof abs !== 'string' || !abs) return '';
  if (typeof root === 'string' && root && isInside(root, abs) && !samePath(root, abs)) {
    return toPosix(path.relative(path.resolve(root), path.resolve(abs)));
  }
  return abs;
}

// ---------------------------------------------------------------------------------------------
// JSON files
// ---------------------------------------------------------------------------------------------

/**
 * Read and parse a JSON file synchronously (UTF-8, BOM tolerated). Returns `fallback` when the
 * file is missing, unreadable or not valid JSON. Safe to `await`.
 * @template T
 * @param {string} file
 * @param {T} [fallback=null]
 * @returns {any|T}
 */
function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

let tmpCounter = 0;

function tmpNameFor(file) {
  tmpCounter = (tmpCounter + 1) % 1e9;
  return `${file}.${process.pid}.${tmpCounter}.tmp`;
}

function retryDelay(attempt, baseMs) {
  return Math.min(baseMs * (attempt + 1), baseMs * 10);
}

/**
 * Atomically replace `file` with `data`: write a unique temp file next to it
 * (`<file>.<pid>.<n>.tmp`), fsync, rename over the target. The rename is retried on
 * EPERM/EACCES/EBUSY (default 10 retries, 50 → 500 ms); as a last resort the target is written in
 * place. The temp file is always removed.
 * @param {string} file
 * @param {string|Uint8Array} data
 * @param {{ retries?: number, retryDelayMs?: number, fs?: object }} [opts] `fs` = injectable fs.promises-like API (tests)
 * @returns {Promise<void>}
 */
async function atomicWriteFile(file, data, opts = {}) {
  const fsx = opts.fs || fsp;
  const retries = Number.isInteger(opts.retries) ? opts.retries : 10;
  const baseMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 50;
  await fsx.mkdir(path.dirname(file), { recursive: true });
  const tmp = tmpNameFor(file);
  let tmpWritten = false;
  try {
    let handle;
    try {
      handle = await fsx.open(tmp, 'w');
      await handle.writeFile(data);
      try {
        await handle.sync();
      } catch {
        /* fsync unsupported on some file systems: the rename is still atomic */
      }
      tmpWritten = true;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  } catch {
    tmpWritten = false; // could not create the temp file: fall through to the in-place write
  }

  if (tmpWritten) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsx.rename(tmp, file);
        return;
      } catch (err) {
        if (!RETRYABLE_FS_CODES.has(err && err.code) || attempt >= retries) break;
        await sleep(retryDelay(attempt, baseMs));
      }
    }
  }

  // Last resort: write in place (not atomic, but better than losing the data).
  try {
    await fsx.writeFile(file, data);
  } finally {
    await fsx.unlink(tmp).catch(() => {});
  }
}

/**
 * Synchronous variant of {@link atomicWriteFile} (used when the process is about to exit).
 * @param {string} file
 * @param {string|Uint8Array} data
 * @param {{ retries?: number, retryDelayMs?: number }} [opts]
 */
function atomicWriteFileSync(file, data, opts = {}) {
  const retries = Number.isInteger(opts.retries) ? opts.retries : 10;
  const baseMs = Number.isFinite(opts.retryDelayMs) ? opts.retryDelayMs : 50;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tmpNameFor(file);
  let tmpWritten = false;
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, data);
      try { fs.fsyncSync(fd); } catch { /* unsupported */ }
      tmpWritten = true;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    tmpWritten = false;
  }
  if (tmpWritten) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (err) {
        if (!RETRYABLE_FS_CODES.has(err && err.code) || attempt >= retries) break;
        sleepSync(retryDelay(attempt, baseMs));
      }
    }
  }
  try {
    fs.writeFileSync(file, data);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/**
 * Remove `<file>.<pid>.<n>.tmp` leftovers (older than a minute) from crashed writes. Fire and forget.
 * @param {string} file
 */
function removeStaleTmpFiles(file) {
  const dir = path.dirname(file);
  const base = path.basename(file).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${base}\\.\\d+\\.\\d+\\.tmp$`);
  fsp.readdir(dir).then(async (names) => {
    for (const name of names) {
      if (!re.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        if (Date.now() - st.mtimeMs > 60000) await fsp.unlink(full);
      } catch { /* ignore */ }
    }
  }).catch(() => {});
}

/**
 * Debounced, single-queue JSON file writer. `write(obj)` records the latest state and schedules a
 * write (trailing debounce, with a max wait so a constant stream of writes still lands on disk);
 * at most one write is in flight and the newest state always wins. Write errors never throw to the
 * caller (in-memory state stays the truth): they are reported to `onError`.
 * The object is serialized when the write actually happens (latest state semantics).
 *
 * @param {string} file
 * @param {{ debounceMs?: number, maxWaitMs?: number, space?: number, onError?: (err: Error) => void,
 *           retries?: number, retryDelayMs?: number, fs?: object }} [opts]
 * @returns {{ write(obj: any): void, flush(): Promise<void>, flushSync(): void, pending(): boolean, file: string }}
 */
function createJsonWriter(file, opts = {}) {
  const debounceMs = Number.isFinite(opts.debounceMs) ? Math.max(0, opts.debounceMs) : 300;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) ? Math.max(debounceMs, opts.maxWaitMs) : Math.max(1000, debounceMs * 5);
  const space = opts.space === undefined ? 2 : opts.space;
  const onError = typeof opts.onError === 'function' ? opts.onError : (err) => {
    // eslint-disable-next-line no-console
    console.error(`[json-writer] ${file}:`, err);
  };
  const writeOpts = { fs: opts.fs, retries: opts.retries, retryDelayMs: opts.retryDelayMs };
  if (!opts.fs && opts.cleanupStale !== false) removeStaleTmpFiles(file);

  let latest;
  let hasData = false;
  let dirty = false;
  let firstDirtyAt = 0;
  let timer = null;
  let inFlight = null;
  let waiters = [];

  const serialize = (obj) => `${JSON.stringify(obj, null, space)}\n`;

  function report(err) {
    try { onError(err); } catch { /* never throw from the writer */ }
  }

  function settleIfIdle() {
    if (inFlight || dirty) return;
    const list = waiters;
    waiters = [];
    for (const resolve of list) resolve();
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, Math.min(debounceMs, firstDirtyAt + maxWaitMs - Date.now()));
    timer = setTimeout(() => {
      timer = null;
      pump();
    }, wait);
  }

  function pump() {
    if (inFlight) return;
    if (!dirty) {
      settleIfIdle();
      return;
    }
    dirty = false;
    let data;
    try {
      data = serialize(latest);
    } catch (err) {
      report(err);
      settleIfIdle();
      return;
    }
    inFlight = atomicWriteFile(file, data, writeOpts)
      .catch(report)
      .finally(() => {
        inFlight = null;
        if (dirty) {
          if (waiters.length) {
            // someone is waiting in flush(): write right away
            if (timer) { clearTimeout(timer); timer = null; }
            pump();
          } else if (!timer) {
            pump();
          }
        } else {
          settleIfIdle();
        }
      });
  }

  return {
    file,
    /** Record the latest state and schedule a debounced write. */
    write(obj) {
      latest = obj;
      hasData = true;
      if (!dirty) {
        dirty = true;
        firstDirtyAt = Date.now();
      }
      schedule();
    },
    /** Write pending data now; resolves when everything recorded so far is on disk (never rejects). */
    flush() {
      if (timer) { clearTimeout(timer); timer = null; }
      const done = new Promise((resolve) => { waiters.push(resolve); });
      pump();
      settleIfIdle();
      return done;
    },
    /** Synchronously write the latest state if anything is pending (process exit paths). */
    flushSync() {
      if (timer) { clearTimeout(timer); timer = null; }
      if (!hasData || (!dirty && !inFlight)) return;
      try {
        atomicWriteFileSync(file, serialize(latest), writeOpts);
        // An async write still in flight carries OLDER data and may land after this one: stay
        // dirty so the writer rewrites the latest state once it completes.
        if (!inFlight) dirty = false;
      } catch (err) {
        report(err);
      }
    },
    /** True while a write is scheduled or in flight. */
    pending() {
      return dirty || !!inFlight;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------------------------

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hardlink `src` to `dest` (fallback: copy). Creates parent folders and replaces an existing
 * destination file.
 * @param {string} src
 * @param {string} dest
 * @param {{ link?: boolean }} [opts]
 * @returns {Promise<'link'|'copy'|'same'>}
 */
async function copyOrLink(src, dest, { link = true } = {}) {
  // samePath: case-insensitive on Windows (otherwise rm(dest) below would delete the source).
  if (path.resolve(src) === path.resolve(dest) || samePath(src, dest)) return 'same';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  await fsp.rm(dest, { force: true });
  if (link) {
    try {
      await fsp.link(src, dest);
      return 'link';
    } catch (err) {
      if (err && err.code === 'ENOENT' && !(await pathExists(src))) throw err;
      // EXDEV / EPERM / ENOTSUP / FAT32 …: copy instead
    }
  }
  await fsp.copyFile(src, dest);
  return 'copy';
}

/**
 * Move a file or folder. Renames (retrying briefly on EPERM/EACCES/EBUSY); falls back to copy +
 * delete across volumes (and, for files, when the rename keeps failing). Like `rename`, an existing
 * destination FILE is replaced. If the source cannot be deleted after copying a file, the copy is
 * removed again and the error is thrown (never leaves two copies).
 * @param {string} src
 * @param {string} dest
 * @returns {Promise<'rename'|'copy'|'same'>}
 */
async function moveFile(src, dest) {
  if (path.resolve(src) === path.resolve(dest)) return 'same';
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  let lastErr;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(src, dest);
      return 'rename';
    } catch (err) {
      lastErr = err;
      if (RETRYABLE_FS_CODES.has(err && err.code) && attempt < 4) {
        await sleep(100 * (attempt + 1));
        continue;
      }
      break;
    }
  }
  const code = lastErr && lastErr.code;
  if (code !== 'EXDEV' && !RETRYABLE_FS_CODES.has(code)) throw lastErr;
  // Case-only rename on Windows: src and dest are the same file, so copy + unlink would delete it.
  if (samePath(src, dest)) throw lastErr;
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    if (code !== 'EXDEV') throw lastErr;
    await fsp.cp(src, dest, { recursive: true, force: true, errorOnExist: false });
    await fsp.rm(src, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return 'copy';
  }
  await fsp.copyFile(src, dest);
  try {
    await fsp.unlink(src);
  } catch (err) {
    await fsp.rm(dest, { force: true }).catch(() => {});
    throw err;
  }
  return 'copy';
}

/**
 * Delete everything inside `dir` except the entries selected by `keep`. Missing dir → 0.
 * @param {string} dir
 * @param {{ keep?: string[]|Set<string>|((name: string) => boolean) }} [opts] names (case-insensitive on Windows) or predicate
 * @returns {Promise<number>} number of entries removed
 */
async function removeDirContents(dir, { keep } = {}) {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return 0;
    throw err;
  }
  let keepFn = () => false;
  if (typeof keep === 'function') keepFn = keep;
  else if (keep && typeof keep[Symbol.iterator] === 'function') {
    const names = new Set(Array.from(keep, (n) => (IS_WIN ? String(n).toLowerCase() : String(n))));
    keepFn = (name) => names.has(IS_WIN ? name.toLowerCase() : name);
  }
  let removed = 0;
  for (const name of entries) {
    if (keepFn(name)) continue;
    await fsp.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/**
 * True for Windows reserved device names (CON, PRN, AUX, NUL, COM0-9, LPT0-9, COM¹²³, LPT¹²³,
 * CONIN$, CONOUT$), with or without an extension (e.g. `nul.txt`, `COM1.png`). Case-insensitive.
 * @param {string} name file name (not a path)
 * @returns {boolean}
 */
function isReservedWindowsName(name) {
  return typeof name === 'string' && RESERVED_WINDOWS_RE.test(name);
}

function truncateCodePoints(str, maxLen) {
  if (str.length <= maxLen) return str;
  let out = str.slice(0, maxLen);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1); // don't split a surrogate pair
  return out;
}

/**
 * Make a string safe to use as a single file name on Windows/macOS/Linux:
 * NFC-normalized; strips `<>:"/\|?*` and control characters (and `[]` with `stripGlob`); trims
 * leading spaces and trailing dots/spaces; truncates to `maxLen` UTF-16 units (never splitting a
 * surrogate pair); reserved Windows device names get a `_` appended to their stem (`CON` → `CON_`,
 * `nul.txt` → `nul_.txt`). Returns `fallback` (default '') when nothing usable remains.
 * @param {string} name
 * @param {{ maxLen?: number, fallback?: string, stripGlob?: boolean }} [opts]
 * @returns {string}
 */
function sanitizeFileName(name, { maxLen = 100, fallback = '', stripGlob = false } = {}) {
  let s = String(name === undefined || name === null ? '' : name).normalize('NFC');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '');
  if (stripGlob) s = s.replace(/[[\]]/g, '');
  s = s.replace(/^\s+/, '').replace(/[. ]+$/, '');
  const limit = Math.max(1, Math.floor(Number(maxLen) || 100));
  s = truncateCodePoints(s, limit).replace(/[. ]+$/, '');
  if (s && isReservedWindowsName(s)) {
    const dot = s.indexOf('.');
    s = dot === -1 ? `${s}_` : `${s.slice(0, dot)}_${s.slice(dot)}`;
    if (s.length > limit) s = truncateCodePoints(s, limit).replace(/[. ]+$/, '');
  }
  return s || fallback;
}

/**
 * Find a free `<stem><ext>` in `dir`. A stem is taken when it is in `takenStemsSet` (compared
 * exactly and case-insensitively) or when `<dir>/<stem><ext>` exists. Without a set, the stems of
 * the files directly in `dir` are used. Tries `stem`, then `stem (2)`, `stem (3)`, … (an existing
 * ` (n)` suffix is continued: `card (2)` → `card (3)`). The chosen stem is added to the set.
 * @param {string} dir
 * @param {string} stem
 * @param {string} ext with or without the leading dot ('' allowed)
 * @param {Set<string>} [takenStemsSet]
 * @returns {string} absolute path
 */
function uniqueStemPath(dir, stem, ext, takenStemsSet) {
  const extension = !ext ? '' : String(ext).startsWith('.') ? String(ext) : `.${ext}`;
  let taken = takenStemsSet;
  if (!(taken instanceof Set)) {
    taken = new Set();
    try {
      for (const name of fs.readdirSync(dir)) taken.add(path.parse(name).name);
    } catch { /* missing dir: nothing taken */ }
  }
  const lowerTaken = new Set(Array.from(taken, (s) => String(s).toLowerCase()));
  const isFree = (candidate) => !taken.has(candidate) && !lowerTaken.has(candidate.toLowerCase())
    && !fs.existsSync(path.join(dir, candidate + extension));

  const original = String(stem);
  if (isFree(original)) {
    taken.add(original);
    return path.join(dir, original + extension);
  }
  const m = /^(.*\S) \((\d{1,6})\)$/.exec(original);
  const base = m ? m[1] : original;
  let n = m ? Number(m[2]) + 1 : 2;
  for (let i = 0; i < 100000; i += 1, n += 1) {
    const candidate = `${base} (${n})`;
    if (isFree(candidate)) {
      taken.add(candidate);
      return path.join(dir, candidate + extension);
    }
  }
  throw new Error(`Could not find a free file name for "${original}${extension}"`);
}

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'variant' });

/**
 * Natural sort comparator (numbers compared by value: "card 2" < "card 10"), deterministic across
 * machines (fixed 'en' collation, ties broken by code-unit order).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function naturalCompare(a, b) {
  const sa = String(a);
  const sb = String(b);
  const c = naturalCollator.compare(sa, sb);
  if (c !== 0) return c;
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Quote one command-line argument for DISPLAY (copy/paste into a terminal). Plain arguments are
 * returned unchanged; others are wrapped in double quotes with Windows-style escaping.
 * @param {string} arg
 * @returns {string}
 */
function quoteForDisplay(arg) {
  const s = String(arg === undefined || arg === null ? '' : arg);
  if (s === '') return '""';
  if (/^[A-Za-z0-9_\-+=.,/:@%\\]+$/.test(s)) return s;
  const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------------------------
// Hashing, disk, time
// ---------------------------------------------------------------------------------------------

/**
 * SHA-1 (hex) of a file, streamed.
 * @param {string} abs
 * @returns {Promise<string>}
 */
function sha1File(abs) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1');
    const stream = fs.createReadStream(abs, { highWaterMark: 1 << 20 });
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * SHA-1 (hex) of a string (UTF-8) or bytes.
 * @param {string|Uint8Array} s
 * @returns {string}
 */
function sha1Text(s) {
  const hash = crypto.createHash('sha1');
  if (s instanceof Uint8Array) hash.update(s);
  else hash.update(String(s === undefined || s === null ? '' : s), 'utf8');
  return hash.digest('hex');
}

/**
 * Free bytes available to the user on the volume holding `dir` (walks up to the nearest existing
 * parent). Resolves null when unknown.
 * @param {string} dir
 * @returns {Promise<number|null>}
 */
async function freeDiskBytes(dir) {
  if (typeof dir !== 'string' || !dir) return null;
  let current = path.resolve(dir);
  for (let i = 0; i < 128; i += 1) {
    try {
      const st = await fsp.statfs(current);
      return Number(st.bavail) * Number(st.bsize);
    } catch (err) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) return null;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
  return null;
}

/**
 * Local-time id `YYYYMMDD-HHMMSS` (job logs, trash batches).
 * @param {Date} [date]
 * @returns {string}
 */
function timestampId(date = new Date()) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
}

// ---------------------------------------------------------------------------------------------
// PNG encoder (8-bit RGBA, no external dependencies)
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * CRC-32 (IEEE 802.3, as used by PNG/zip).
 * @param {Uint8Array} buf
 * @param {number} [crc=0] running value
 * @returns {number} unsigned 32-bit
 */
function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBuf.copy(out, 4);
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/**
 * Encode RGBA pixels as a PNG (color type 6, 8 bits, filter 0, zlib deflate).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgbaBuffer width*height*4 bytes, row-major
 * @returns {Buffer}
 */
function encodePng(width, height, rgbaBuffer) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new RangeError('encodePng: width and height must be positive integers');
  }
  if (!(rgbaBuffer instanceof Uint8Array) || rgbaBuffer.length !== width * height * 4) {
    throw new RangeError(`encodePng: expected ${width * height * 4} RGBA bytes`);
  }
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: None
    Buffer.from(rgbaBuffer.buffer, rgbaBuffer.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = {
  RETRYABLE_FS_CODES,
  sleep,
  sleepSync,
  isPlainObject,
  samePath,
  isInside,
  resolveInside,
  toPosix,
  ensureDir,
  readJson,
  createJsonWriter,
  atomicWriteFile,
  atomicWriteFileSync,
  copyOrLink,
  moveFile,
  removeDirContents,
  sanitizeFileName,
  isReservedWindowsName,
  uniqueStemPath,
  sha1File,
  sha1Text,
  quoteForDisplay,
  relForDisplay,
  crc32,
  encodePng,
  freeDiskBytes,
  timestampId,
  naturalCompare,
};
