'use strict';

/**
 * `scm-img://` URLs for showing local card images in the sandboxed renderer (PURE, no Electron).
 *
 * Format: `scm-img://file/<base64url(UTF-8 absolute path)>?v=<mtimeMs>`.
 * The path lives in the URL PATH (standard-scheme hosts are lower-cased); base64url only uses
 * `[A-Za-z0-9_-]`, so spaces, `#`, `%`, `?` and non-ASCII characters survive unchanged.
 */

const path = require('node:path');

const SCHEME = 'scm-img';
const HOST = 'file';

/** Extensions served without sniffing (lower-case, with dot). */
const IMAGE_EXTENSIONS = Object.freeze(new Set([
  '.png', '.apng', '.jpg', '.jpeg', '.jpe', '.jfif', '.pjpeg', '.pjp', '.gif', '.webp', '.bmp', '.dib',
  '.tif', '.tiff', '.avif', '.jp2', '.j2k', '.jpf', '.jpx', '.jpm', '.ico', '.heic', '.heif',
]));

/**
 * Encode an absolute path as base64url (UTF-8, no padding).
 * @param {string} abs
 * @returns {string}
 */
function encodePath(abs) {
  if (typeof abs !== 'string' || abs === '') throw new TypeError('encodePath: path must be a non-empty string');
  return Buffer.from(abs, 'utf8').toString('base64url');
}

/**
 * Decode a value produced by {@link encodePath}. Throws a TypeError for anything that is not
 * canonical base64url of valid UTF-8 without NUL characters.
 * @param {string} s
 * @returns {string}
 */
function decodePath(s) {
  if (typeof s !== 'string' || s === '' || s.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(s)) {
    throw new TypeError('decodePath: invalid encoded path');
  }
  const decoded = Buffer.from(s, 'base64url').toString('utf8');
  if (decoded === '' || decoded.includes('\u0000') || Buffer.from(decoded, 'utf8').toString('base64url') !== s) {
    throw new TypeError('decodePath: invalid encoded path');
  }
  return decoded;
}

/**
 * Build the renderer URL of a local image.
 * @param {string} abs absolute path
 * @param {number} [mtimeMs] cache-buster (file modification time); omitted when not finite
 * @returns {string} `scm-img://file/<b64>?v=<mtime>`
 */
function toFileUrl(abs, mtimeMs) {
  const base = `${SCHEME}://${HOST}/${encodePath(abs)}`;
  return Number.isFinite(mtimeMs) ? `${base}?v=${Math.round(mtimeMs)}` : base;
}

/**
 * True for UNC (`\\server\share`, `//server/share`) and device (`\\?\`, `\\.\`) paths.
 * @param {string} p
 * @returns {boolean}
 */
function isUncOrDevicePath(p) {
  return typeof p === 'string' && /^[\\/]{2}/.test(p);
}

/**
 * Parse a `scm-img://file/<b64>` URL into an absolute, normalized path (host platform).
 * Throws a TypeError for another scheme/host, invalid encodings, relative paths, drive-relative
 * paths (`C:foo`), UNC/device paths and alternate data streams.
 * @param {string} url
 * @param {string} [platform=process.platform]
 * @returns {string}
 */
function parseImageUrl(url, platform = process.platform) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError('Invalid image URL');
  }
  // Chromium lower-cases hosts of standard schemes; Node's URL keeps them as written.
  if (u.protocol !== `${SCHEME}:` || u.hostname.toLowerCase() !== HOST) throw new TypeError('Invalid image URL');
  const encoded = u.pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  const raw = decodePath(encoded);
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (isUncOrDevicePath(raw)) throw new TypeError('Network and device paths are not allowed');
  if (!p.isAbsolute(raw) || (platform === 'win32' && !/^[a-zA-Z]:[\\/]/.test(raw))) {
    throw new TypeError('Image paths must be absolute');
  }
  if (platform === 'win32' && raw.indexOf(':', 2) !== -1) throw new TypeError('Invalid image path');
  const resolved = p.resolve(raw);
  if (isUncOrDevicePath(resolved)) throw new TypeError('Network and device paths are not allowed');
  return resolved;
}

/**
 * True when the file name has a known image extension (case-insensitive).
 * @param {string} p
 * @returns {boolean}
 */
function isImageExtension(p) {
  return typeof p === 'string' && IMAGE_EXTENSIONS.has(path.extname(p).toLowerCase());
}

/**
 * Identify an image from its first bytes (used for files whose extension is not an image one).
 * @param {Uint8Array} buf at least 16 bytes for reliable results
 * @returns {string|null} MIME type or null
 */
function sniffImageMime(buf) {
  if (!(buf instanceof Uint8Array) || buf.length < 4) return null;
  const b = buf;
  const ascii = (start, end) => String.fromCharCode(...b.subarray(start, Math.min(end, b.length)));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) return 'image/tiff';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp' && /^(avif|avis)$/.test(ascii(8, 12))) return 'image/avif';
  if (b.length >= 12 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0c && ascii(4, 8) === 'jP  ') return 'image/jp2';
  return null;
}

module.exports = {
  SCHEME,
  HOST,
  IMAGE_EXTENSIONS,
  encodePath,
  decodePath,
  toFileUrl,
  parseImageUrl,
  isUncOrDevicePath,
  isImageExtension,
  sniffImageMime,
};
