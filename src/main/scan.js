'use strict';

/**
 * scan.js — list the images in a card folder the way the engine sees them (pure fs.promises;
 * unit-tested; no Electron).
 *
 * - Recursive like Python's os.walk(): dot-files and dot-folders are included (the engine reads
 *   them); symbolic links / junctions to folders are not followed; links to files are.
 * - Junk files (.DS_Store, Thumbs.db, desktop.ini, "Icon\r", "._*") and the placeholders
 *   README.md / EMPTY.md / .gitkeep are skipped entirely (neither images nor others).
 * - A file is an image when image-meta.sniffImageType() — an exact port of the engine's filetype
 *   check — returns one of VALID_TYPES; everything else is listed in `others`.
 * - stem / relNoExt follow Python's pathlib (Path('a.png').stem === 'a', Path('.png').stem ===
 *   '.png', Path('a.').stem === 'a.'), because the engine pairs and de-duplicates files by stem.
 * - Optional SHA-1 hashes, cached in memory and persisted (createHashCache) by abs|size|mtimeMs.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { probeImage } = require('./image-meta');

const JUNK_NAMES_LOWER = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
const IGNORED_NAMES_LOWER = new Set(['readme.md', 'empty.md', '.gitkeep']);
const DEFAULT_MAX_FILES = 50000;
const DEFAULT_CONCURRENCY = 16;
const MAX_DEPTH = 64;
const HASH_CHUNK = 256 * 1024;
const RETRYABLE_WRITE_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * Natural order ("card 2" < "card 10"), deterministic tie-break on code units.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareNatural(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * True for OS clutter files the engine deletes itself (utilities.EXTRANEOUS_FILES + "._*").
 * @param {string} name file name
 * @returns {boolean}
 */
function isJunkName(name) {
  return name === 'Icon\r' || name.startsWith('._') || JUNK_NAMES_LOWER.has(name.toLowerCase());
}

/**
 * True for the placeholder files shipped in the engine's game/ folders.
 * @param {string} name file name
 * @returns {boolean}
 */
function isIgnoredName(name) {
  return IGNORED_NAMES_LOWER.has(name.toLowerCase());
}

/**
 * Split a file name like Python 3.12 pathlib: suffix only when the last dot is neither the first
 * nor the last character.
 * @param {string} name file name (no directory)
 * @returns {{ stem: string, ext: string, suffix: string }} ext = lowercase suffix without the dot
 */
function nameParts(name) {
  const i = name.lastIndexOf('.');
  if (i > 0 && i < name.length - 1) {
    const suffix = name.slice(i);
    return { stem: name.slice(0, i), ext: suffix.slice(1).toLowerCase(), suffix };
  }
  return { stem: name, ext: '', suffix: '' };
}

/**
 * SHA-1 (hex) of a file, streamed through a FileHandle.
 * @param {string} abs absolute path
 * @returns {Promise<string>}
 */
async function sha1File(abs) {
  const hash = crypto.createHash('sha1');
  const fh = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, HASH_CHUNK, null);
      if (!bytesRead) break;
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close().catch(() => {});
  }
  return hash.digest('hex');
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = [];
  const n = Math.max(1, Math.min(limit, items.length));
  for (let w = 0; w < n; w += 1) {
    workers.push((async () => {
      for (;;) {
        const i = next;
        next += 1;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

function makeItem(entry, info) {
  const { stem, ext } = nameParts(entry.name);
  const slash = entry.rel.lastIndexOf('/');
  return {
    rel: entry.rel,
    relNoExt: slash >= 0 ? `${entry.rel.slice(0, slash)}/${stem}` : stem,
    abs: entry.abs,
    name: entry.name,
    stem,
    ext,
    type: info.type ?? null,
    size: Number.isFinite(info.size) ? info.size : null,
    mtimeMs: Number.isFinite(info.mtimeMs) ? info.mtimeMs : null,
    width: info.width ?? null,
    height: info.height ?? null,
    orientation: info.orientation ?? null,
    hash: null,
  };
}

/**
 * @typedef {object} ScanItem
 * @property {string} rel posix path relative to the scanned folder ('sub/Card 1.png')
 * @property {string} relNoExt rel without the suffix ('sub/Card 1') — pairs fronts and unique backs
 * @property {string} abs absolute path
 * @property {string} name file name
 * @property {string} stem Python Path.stem
 * @property {string} ext lowercase extension WITHOUT the dot ('png'; '' when none)
 * @property {string|null} type sniffed type ('png', 'jpeg', … for images; 'heic' or null for others)
 * @property {number|null} size bytes
 * @property {number|null} mtimeMs
 * @property {number|null} width pixels after EXIF orientation (what create_pdf lays out); null if unknown
 * @property {number|null} height
 * @property {number|null} orientation EXIF orientation 1–8 (1 = none); null if unknown
 * @property {string|null} hash SHA-1 hex when `hash: true`
 * @property {string} [error] errno code when the file could not be read (others only)
 * @property {true} [broken] set on dangling symbolic links (others only)
 */

let defaultHashCache = null;

/**
 * Install the cache scanDir() uses when no `hashCache` option is given (main.js:
 * `setDefaultHashCache(createHashCache(path.join(scmCacheDir, 'hashes.json')))`). Until then a
 * memory-only cache is used.
 * @param {ReturnType<typeof createHashCache>|null} cache null = back to a fresh memory-only cache
 */
function setDefaultHashCache(cache) {
  defaultHashCache = cache || null;
}

/** @returns {ReturnType<typeof createHashCache>} the cache used by scanDir() by default */
function getDefaultHashCache() {
  if (!defaultHashCache) defaultHashCache = createHashCache(null);
  return defaultHashCache;
}

/**
 * Scan a folder recursively (spec §9.4).
 *
 * @param {string} dir folder to scan (missing folder → empty lists)
 * @param {{ hash?: boolean, sizes?: boolean, hashCache?: ReturnType<typeof createHashCache>|false,
 *   maxFiles?: number, concurrency?: number }} [opts]
 *   hashCache: omitted = the default cache (see setDefaultHashCache), false = no caching
 * @returns {Promise<{ images: ScanItem[], others: ScanItem[], errors: { rel: string, code: string, message: string }[], truncated: boolean }>}
 *   images/others in natural order of `rel`; `errors` lists unreadable folders/files; `truncated`
 *   is true when more than maxFiles files were found (the rest is ignored).
 */
async function scanDir(dir, opts = {}) {
  const {
    hash = false, sizes = true, hashCache: hashCacheOpt,
    maxFiles = DEFAULT_MAX_FILES, concurrency = DEFAULT_CONCURRENCY,
  } = opts || {};
  let hashCache = null;
  if (hash) {
    if (hashCacheOpt && typeof hashCacheOpt.hashFile === 'function') hashCache = hashCacheOpt;
    else if (hashCacheOpt === undefined || hashCacheOpt === null) hashCache = getDefaultHashCache();
  }
  if (typeof dir !== 'string' || !dir) throw new TypeError('scanDir: dir must be a non-empty string');
  const root = path.resolve(dir);
  const errors = [];
  const entries = [];
  let truncated = false;

  const stack = [{ abs: root, rel: '', depth: 0 }];
  while (stack.length && !truncated) {
    const { abs, rel, depth } = stack.pop();
    if (depth > MAX_DEPTH) {
      errors.push({ rel, code: 'ELOOP', message: `Folder nesting deeper than ${MAX_DEPTH} levels was not scanned` });
      continue;
    }
    let dirents;
    try {
      dirents = await fsp.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (rel === '' && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) break;
      errors.push({ rel: rel || '.', code: err.code || 'EIO', message: err.message });
      continue;
    }
    for (const d of dirents) {
      const name = d.name;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      if (d.isDirectory()) {
        stack.push({ abs: childAbs, rel: childRel, depth: depth + 1 });
        continue;
      }
      if (isJunkName(name) || isIgnoredName(name)) continue;
      if (d.isFile() || d.isSymbolicLink()) {
        if (entries.length >= maxFiles) { truncated = true; break; }
        entries.push({ abs: childAbs, rel: childRel, name, link: d.isSymbolicLink() });
      }
      // FIFOs, sockets and devices are never images: skipped.
    }
  }

  const results = await mapLimit(entries, concurrency, async (entry) => {
    if (entry.link) {
      let st;
      try {
        st = await fsp.stat(entry.abs);
      } catch (err) {
        return { image: false, item: { ...makeItem(entry, {}), broken: true, error: err.code || 'EIO' } };
      }
      if (!st.isFile()) return null; // link to a folder: not followed (os.walk followlinks=False)
    }
    let info;
    try {
      info = await probeImage(entry.abs, { sizes });
    } catch (err) {
      if (err.code === 'ENOENT') return null; // removed while scanning
      errors.push({ rel: entry.rel, code: err.code || 'EIO', message: err.message });
      return { image: false, item: { ...makeItem(entry, {}), error: err.code || 'EIO' } };
    }
    const item = makeItem(entry, info);
    if (!info.valid) return { image: false, item };
    if (hash) {
      try {
        item.hash = hashCache
          ? await hashCache.hashFile(entry.abs, { size: info.size, mtimeMs: info.mtimeMs })
          : await sha1File(entry.abs);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        errors.push({ rel: entry.rel, code: err.code || 'EIO', message: err.message });
      }
    }
    return { image: true, item };
  });

  const images = [];
  const others = [];
  for (const r of results) {
    if (!r) continue;
    (r.image ? images : others).push(r.item);
  }
  images.sort((a, b) => compareNatural(a.rel, b.rel));
  others.sort((a, b) => compareNatural(a.rel, b.rel));
  return { images, others, errors, truncated };
}

/**
 * Images only (see scanDir).
 * @param {string} dir
 * @param {Parameters<typeof scanDir>[1]} [opts]
 * @returns {Promise<ScanItem[]>}
 */
async function scanImages(dir, opts) {
  return (await scanDir(dir, opts)).images;
}

// ---------------------------------------------------------------- hash cache

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Minimal JSON writer: one write in flight, latest state wins, tmp file + rename with retries
 * (Windows antivirus/indexer locks), last resort write in place. Write failures are swallowed
 * (a cache is best effort). Same `{ write(obj), flush() }` shape as util.createJsonWriter.
 * @param {string} file
 * @returns {{ write(obj: unknown): void, flush(): Promise<void> }}
 */
function createAtomicJsonWriter(file) {
  let pending;
  let hasPending = false;
  let running = null;
  let seq = 0;

  async function writeOnce(obj) {
    const data = JSON.stringify(obj);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    seq += 1;
    const tmp = `${file}.${process.pid}.${seq}.tmp`;
    const fh = await fsp.open(tmp, 'w');
    try {
      await fh.writeFile(data, 'utf8');
      await fh.sync().catch(() => {});
    } finally {
      await fh.close();
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (err) {
        if (!RETRYABLE_WRITE_CODES.has(err.code)) {
          await fsp.unlink(tmp).catch(() => {});
          throw err;
        }
        if (attempt >= 9) {
          await fsp.unlink(tmp).catch(() => {});
          await fsp.writeFile(file, data, 'utf8');
          return;
        }
        await delay(Math.min(500, 50 * 2 ** attempt));
      }
    }
  }

  function write(obj) {
    pending = obj;
    hasPending = true;
    if (running) return;
    running = (async () => {
      try {
        while (hasPending) {
          const next = pending;
          hasPending = false;
          pending = undefined;
          try {
            await writeOnce(next);
          } catch {
            // best effort
          }
        }
      } finally {
        running = null;
      }
    })();
  }

  async function flush() {
    while (running) await running;
  }

  return { write, flush };
}

/**
 * Persistent SHA-1 cache keyed by `abs|size|mtimeMs`, LRU-bounded, stored as JSON
 * `{ version: 1, entries: [[key, sha1], …] }` (oldest first). Loads lazily, ignores a missing or
 * corrupt file, never caches a hash if the file changed while it was being read.
 *
 * @param {string|null} file JSON file (e.g. <scmCacheDir>/hashes.json); null = memory only
 * @param {{ maxEntries?: number, debounceMs?: number,
 *   writer?: { write(obj: unknown): void, flush?(): Promise<void> } }} [opts]
 *   writer: e.g. util.createJsonWriter(file); default: a built-in atomic writer
 * @returns {{ hashFile(abs: string, stat?: { size: number, mtimeMs: number }): Promise<string>,
 *   load(): Promise<void>, flush(): Promise<void>, clear(): void, readonly size: number }}
 */
function createHashCache(file, opts = {}) {
  const { maxEntries = 20000, debounceMs = 2000, writer = null } = opts || {};
  const entries = new Map();
  const inflight = new Map();
  const out = writer || (file ? createAtomicJsonWriter(file) : null);
  let loadPromise = null;
  let timer = null;
  let dirty = false;
  let generation = 0;

  function trim() {
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function load() {
    if (!loadPromise) {
      const gen = generation;
      loadPromise = (async () => {
        if (!file) return;
        let data;
        try {
          data = JSON.parse(await fsp.readFile(file, 'utf8'));
        } catch {
          return; // missing or corrupt: start empty (rewritten on the next change)
        }
        if (gen !== generation) return; // cleared while loading
        if (!data || data.version !== 1 || !Array.isArray(data.entries)) return;
        for (const e of data.entries) {
          if (Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && /^[0-9a-f]{40}$/.test(e[1])) {
            entries.delete(e[0]);
            entries.set(e[0], e[1]);
          }
        }
        trim();
      })();
    }
    return loadPromise;
  }

  function persistNow() {
    if (!dirty || !out) return;
    dirty = false;
    out.write({ version: 1, entries: Array.from(entries) });
  }

  function schedule() {
    dirty = true;
    if (timer || !out) return;
    timer = setTimeout(() => {
      timer = null;
      persistNow();
    }, debounceMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function hashFile(abs, stat) {
    const st = stat && Number.isFinite(stat.size) && Number.isFinite(stat.mtimeMs) ? stat : await fsp.stat(abs);
    const key = `${abs}|${st.size}|${st.mtimeMs}`;
    await load();
    const hit = entries.get(key);
    if (hit) {
      entries.delete(key);
      entries.set(key, hit); // most recently used
      return hit;
    }
    let p = inflight.get(key);
    if (!p) {
      const gen = generation;
      p = (async () => {
        const digest = await sha1File(abs);
        const after = await fsp.stat(abs).catch(() => null);
        if (after && after.size === st.size && after.mtimeMs === st.mtimeMs && gen === generation) {
          entries.set(key, digest);
          trim();
          schedule();
        }
        return digest;
      })().finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return p;
  }

  async function flush() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    persistNow();
    if (out && typeof out.flush === 'function') await out.flush();
  }

  function clear() {
    generation += 1;
    entries.clear();
    if (!loadPromise) loadPromise = Promise.resolve(); // never resurrect the old file
    schedule();
  }

  return {
    hashFile,
    load,
    flush,
    clear,
    get size() { return entries.size; },
  };
}

module.exports = {
  scanDir,
  scanImages,
  createHashCache,
  setDefaultHashCache,
  getDefaultHashCache,
  sha1File,
  nameParts,
  isJunkName,
  isIgnoredName,
  compareNatural,
};
