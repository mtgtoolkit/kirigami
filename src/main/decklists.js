'use strict';

/**
 * decklists.js — the saved deck lists in `<workspace>/game/decklist` (spec §6, §9.6).
 *
 * - Lists are stored as UTF-8 without BOM with LF line ends, because every plugin reads its deck
 *   file with `open(path, 'r')` (a BOM silently drops the first card; with PYTHONUTF8=1 other
 *   encodings fail or garble names).
 * - Reading accepts what people really have: UTF-8 (with or without BOM), UTF-16 LE/BE (with BOM,
 *   or recognizable without), UTF-32 with BOM, else Windows-1252 (old Notepad / Excel exports).
 * - Names: forbidden Windows characters and control characters removed, trailing dots/spaces
 *   trimmed, reserved device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9 — with any extension)
 *   rejected, at most 100 characters.
 * - Writing never silently replaces a different list (keep-both rule: "my-deck (2).txt").
 * - Removing moves the file to the app's "Recently removed" trash (restorable for 14 days).
 * - Mutations refuse with `BUSY: …` while a job that changes files runs.
 *
 * No Electron: everything comes through `deps` (getPaths, jobs, logger).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('./util');
const { userError, MESSAGES } = require('./errors');
const { assertNotMutating, busyError } = require('./locks');
const { isJunkName, isIgnoredName } = require('./scan');

/** Largest deck list the app reads (a 100-card list is about 3 KB; CSV cube exports ~1 MB). */
const MAX_DECK_BYTES = 10 * 1024 * 1024;
const MAX_NAME_LENGTH = 100;
/** File extensions kept as-is when naming a list (anything else gets ".txt" appended). */
const DECK_EXTENSIONS = new Set(['txt', 'ydk', 'ydke', 'xml', 'csv', 'json', 'dek', 'dck', 'cod', 'o8d', 'mwdeck', 'md', 'list']);

// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS_RE = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const RESERVED_RE = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.[^.]*)*$/i;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

/**
 * Make a deck list name safe: removes `<>:"/\|?*` and control characters, trims spaces and
 * leading dots, removes trailing dots/spaces, limits to 100 characters. Reserved Windows device
 * names (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an extension) are REJECTED.
 * @param {string} name
 * @returns {string} the safe name, or '' when nothing usable remains or the name is reserved
 */
function sanitizeDeckName(name) {
  let s = String(name === undefined || name === null ? '' : name).normalize('NFC');
  s = s.replace(/[\t\r\n]+/g, ' ').replace(FORBIDDEN_CHARS_RE, '').replace(/\s+/g, ' ');
  s = s.replace(/^[\s.]+/, '').replace(/[\s.]+$/, '');
  if (s.length > MAX_NAME_LENGTH) {
    s = s.slice(0, MAX_NAME_LENGTH);
    const last = s.charCodeAt(s.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) s = s.slice(0, -1);
    s = s.replace(/[\s.]+$/, '');
  }
  if (!s) return '';
  const stem = s.split('.')[0].trim();
  if (RESERVED_RE.test(s) || RESERVED_RE.test(stem)) return '';
  return s;
}

/**
 * Normalize line ends to LF and drop a leading BOM.
 * @param {string} text
 * @returns {string}
 */
function normalizeDeckText(text) {
  return String(text === undefined || text === null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}

function decodeUtf32(bytes, littleEndian) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let out = '';
  for (let i = 0; i + 3 < bytes.length; i += 4) {
    const cp = view.getUint32(i, littleEndian);
    if (cp > 0x10ffff) throw userError(MESSAGES.BAD_ENCODING, { code: 'BAD_ENCODING', details: 'Invalid UTF-32 code point' });
    out += String.fromCodePoint(cp);
  }
  return out;
}

/** UTF-16 without BOM: most code units of plain text have a zero high byte. */
function guessBomlessUtf16(bytes) {
  const n = Math.min(bytes.length - (bytes.length % 2), 4096);
  if (n < 4) return null;
  let zeroEven = 0;
  let zeroOdd = 0;
  for (let i = 0; i < n; i += 1) {
    if (bytes[i] === 0) {
      if (i % 2 === 0) zeroEven += 1;
      else zeroOdd += 1;
    }
  }
  const pairs = n / 2;
  if (zeroOdd >= pairs * 0.4 && zeroEven <= pairs * 0.05) return 'utf-16le';
  if (zeroEven >= pairs * 0.4 && zeroOdd <= pairs * 0.05) return 'utf-16be';
  return null;
}

/**
 * Decode the bytes of a deck list file into text (BOM removed, line ends normalized to LF).
 * Order: UTF-32/UTF-8/UTF-16 BOM → BOM-less UTF-16 → strict UTF-8 → Windows-1252.
 * @param {Uint8Array|Buffer|ArrayBuffer} buf
 * @returns {string}
 * @throws {Error} code 'BAD_ENCODING' when the bytes are not text (binary file)
 */
function decodeDeckBytes(buf) {
  let bytes;
  if (buf instanceof Uint8Array) bytes = buf;
  else if (buf instanceof ArrayBuffer) bytes = new Uint8Array(buf);
  else if (ArrayBuffer.isView(buf)) bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  else if (typeof buf === 'string') return normalizeDeckText(buf);
  else throw new TypeError('decodeDeckBytes: expected bytes');

  let text;
  const b = bytes;
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xfe && b[2] === 0 && b[3] === 0) {
    text = decodeUtf32(b.subarray(4), true);
  } else if (b.length >= 4 && b[0] === 0 && b[1] === 0 && b[2] === 0xfe && b[3] === 0xff) {
    text = decodeUtf32(b.subarray(4), false);
  } else if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    text = new TextDecoder('utf-8', { fatal: false }).decode(b.subarray(3));
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    text = new TextDecoder('utf-16le').decode(b.subarray(2));
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    text = new TextDecoder('utf-16be').decode(b.subarray(2));
  } else {
    const utf16 = guessBomlessUtf16(b);
    if (utf16) {
      text = new TextDecoder(utf16).decode(b);
    } else {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(b);
      } catch {
        text = new TextDecoder('windows-1252').decode(b);
      }
    }
  }
  if (text.includes('\u0000')) {
    throw userError(MESSAGES.BAD_ENCODING, { code: 'BAD_ENCODING', details: 'The file contains NUL bytes (binary data).' });
  }
  return normalizeDeckText(text);
}

/**
 * True when the bytes are already stored the way plugins need them (UTF-8, no BOM, LF only).
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
function isCanonicalDeckBytes(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return false;
  if (bytes.includes(0x0d)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  return guessBomlessUtf16(bytes) === null && !bytes.includes(0);
}

/**
 * File name for a list: the sanitized name, with ".txt" appended unless it already ends with a
 * deck-list extension (.txt, .ydk, .xml, .csv, .json, …) — or, with `keepExtension`, any short
 * extension (a chosen file keeps its own, e.g. ".dec").
 * @param {string} name
 * @param {{ keepExtension?: boolean }} [options]
 * @returns {string} '' when the name can't be used
 */
function deckFileName(name, { keepExtension = false } = {}) {
  const safe = sanitizeDeckName(name);
  if (!safe) return '';
  const ext = path.extname(safe).slice(1).toLowerCase();
  const keep = ext && safe.length > ext.length + 1 && (DECK_EXTENSIONS.has(ext) || (keepExtension && /^[a-z0-9]{1,8}$/.test(ext)));
  if (keep) return safe;
  const withTxt = `${safe}.txt`;
  return withTxt.length > MAX_NAME_LENGTH + 4 ? `${safe.slice(0, MAX_NAME_LENGTH - 4).replace(/[\s.]+$/, '')}.txt` : withTxt;
}

// ---------------------------------------------------------------------------------------------
// Service functions
// ---------------------------------------------------------------------------------------------

/**
 * `<workspace>/game/decklist`.
 * @param {object} deps
 * @returns {string}
 */
function decklistDir(deps) {
  const p = deps.getPaths();
  return typeof p.gameDir === 'function' ? p.gameDir('decklist') : path.join(p.workspaceDir, 'game', 'decklist');
}

function assertCanChange(deps) {
  assertNotMutating(deps.jobs);
  const active = deps.jobs && typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active && active.kind === 'samples') throw busyError(active.title);
}

/** A user-facing "bad name" error. */
function badName(name) {
  const shown = String(name ?? '').trim().slice(0, 60);
  return userError(
    shown
      ? `"${shown}" can't be used as a list name on Windows. Choose another name.`
      : 'Choose a name for this list.',
    { code: 'BAD_NAME' },
  );
}

/**
 * Resolve an existing list name inside the decklist folder (plain file names only).
 * @returns {string} absolute path
 */
function listPath(deps, name) {
  if (typeof name !== 'string' || !name || /[\\/]/.test(name)) throw userError('This list name is not valid.', { code: 'BAD_NAME' });
  return util.resolveInside(decklistDir(deps), name);
}

async function isRegularFile(file) {
  try {
    return (await fsp.stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Read a deck list file (at most MAX_DECK_BYTES).
 * @param {string} file absolute path
 * @returns {Promise<Buffer>}
 * @throws {Error} ENOENT when missing; userError NOT_A_FILE (folder) or DECK_TOO_BIG
 */
async function readBytesLimited(file) {
  const st = await fsp.stat(file);
  if (!st.isFile()) throw userError(`${path.basename(file)} is a folder, not a deck list.`, { code: 'NOT_A_FILE' });
  if (st.size > MAX_DECK_BYTES) {
    throw userError(`${path.basename(file)} is too big to be a deck list (${Math.round(st.size / 1048576)} MB).`, { code: 'DECK_TOO_BIG' });
  }
  return fsp.readFile(file);
}

/**
 * Saved lists, in natural name order. Placeholders (README.md, EMPTY.md, .gitkeep), OS junk,
 * temporary files and folders are skipped.
 * @param {object} deps
 * @returns {Promise<Array<{ name: string, size: number, mtime: number }>>} mtime in ms since epoch
 */
async function listDecklists(deps) {
  const dir = decklistDir(deps);
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return [];
    throw err;
  }
  const out = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (isJunkName(name) || isIgnoredName(name) || /\.tmp$/i.test(name) || name.startsWith('.~')) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, size: st.size, mtime: Math.round(st.mtimeMs) });
    } catch {
      /* removed meanwhile */
    }
  }
  out.sort((a, b) => util.naturalCompare(a.name, b.name));
  return out;
}

/**
 * Read a saved list as text (any common encoding; LF line ends).
 * @param {object} deps
 * @param {string} name file name in game/decklist
 * @returns {Promise<string>}
 */
async function readDecklist(deps, name) {
  const file = listPath(deps, name);
  let bytes;
  try {
    bytes = await readBytesLimited(file);
  } catch (err) {
    if (err && err.code === 'ENOENT') throw userError(`The list "${name}" no longer exists.`, { code: 'NOT_FOUND' });
    throw err;
  }
  return decodeDeckBytes(bytes);
}

/**
 * Save a list (UTF-8, no BOM, LF). With keepBoth (default), an existing list with DIFFERENT
 * content is kept and the new one is saved as "<name> (2).txt"; identical content reuses the file.
 * @param {object} deps
 * @param {string} name list name (sanitized; ".txt" added when it has no deck-list extension,
 *   unless a saved list with exactly this name exists, e.g. "deck.dec")
 * @param {string} text list content
 * @param {{ keepBoth?: boolean }} [options] keepBoth=false replaces a list with the same name
 * @returns {Promise<{ name: string, path: string, unchanged?: boolean }>}
 */
async function writeDecklist(deps, name, text, { keepBoth = true } = {}) {
  assertCanChange(deps);
  return saveDeckText(deps, name, text, { keepBoth });
}

/**
 * writeDecklist without the BUSY check (used inside the download job).
 * @param {object} deps
 * @param {string} name
 * @param {string} text
 * @param {{ keepBoth?: boolean, keepExtension?: boolean }} [options]
 * @returns {Promise<{ name: string, path: string, unchanged?: boolean }>}
 */
async function saveDeckText(deps, name, text, { keepBoth = true, keepExtension = false } = {}) {
  let fileName = deckFileName(name, { keepExtension });
  if (!fileName) throw badName(name);
  const dir = decklistDir(deps);
  if (!keepExtension) {
    // Saving an existing list whose extension the app doesn't know (e.g. "deck.dec" edited in
    // Saved lists): keep its exact name instead of creating "deck.dec.txt".
    const safe = sanitizeDeckName(name);
    if (safe && safe !== fileName && path.extname(safe) && (await isRegularFile(path.join(dir, safe)))) fileName = safe;
  }
  await fsp.mkdir(dir, { recursive: true });
  const content = normalizeDeckText(text);
  let target = path.join(dir, fileName);
  let existing = null;
  let existingBytes = null;
  try {
    existingBytes = await readBytesLimited(target);
    existing = decodeDeckBytes(existingBytes);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') existing = undefined; // unreadable existing file: never overwrite it silently
  }
  if (existing !== null) {
    if (existing === content) {
      // Same list, but stored with a BOM / CR line ends / another encoding: plugins would drop the
      // first card or fail, so store it the plugin-ready way (same content, same name).
      if (existingBytes && !isCanonicalDeckBytes(existingBytes)) await util.atomicWriteFile(target, Buffer.from(content, 'utf8'));
      return { name: fileName, path: target, unchanged: true };
    }
    if (keepBoth || existing === undefined) {
      const ext = path.extname(fileName);
      const stem = fileName.slice(0, fileName.length - ext.length);
      target = util.uniqueStemPath(dir, stem, ext);
    }
  }
  await util.atomicWriteFile(target, Buffer.from(content, 'utf8'));
  return { name: path.basename(target), path: target };
}

/**
 * Move a saved list to "Recently removed" (restorable from the trash for 14 days).
 * @param {object} deps
 * @param {string} name
 * @returns {Promise<{ batchId: string }>}
 */
async function removeDecklist(deps, name) {
  assertCanChange(deps);
  const file = listPath(deps, name);
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) throw userError(`"${name}" is not a deck list.`, { code: 'NOT_A_FILE' });
  } catch (err) {
    if (err && err.code === 'ENOENT') throw userError(`The list "${name}" no longer exists.`, { code: 'NOT_FOUND' });
    throw err;
  }
  // eslint-disable-next-line global-require
  const cards = require('./cards');
  const batchId = await cards.moveToTrash(deps, [{ kind: 'decklist', rel: name }], 'decklist');
  return { batchId };
}

/**
 * Make an existing saved list plugin-ready in place (only when it has a BOM, CR line ends or is
 * not UTF-8). Returns true when the file was rewritten.
 * @param {string} file absolute path
 * @returns {Promise<boolean>}
 */
async function normalizeDeckFileInPlace(file) {
  const bytes = await readBytesLimited(file);
  if (isCanonicalDeckBytes(bytes)) return false;
  const text = decodeDeckBytes(bytes);
  await util.atomicWriteFile(file, Buffer.from(text, 'utf8'));
  return true;
}

module.exports = {
  listDecklists,
  readDecklist,
  writeDecklist,
  removeDecklist,
  sanitizeDeckName,
  decodeDeckBytes,
  // extras (used by fetch.js and tests)
  normalizeDeckText,
  normalizeDeckFileInPlace,
  isCanonicalDeckBytes,
  deckFileName,
  saveDeckText,
  readBytesLimited,
  decklistDir,
  MAX_DECK_BYTES,
};
