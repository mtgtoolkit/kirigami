'use strict';

/**
 * image-meta.js — dependency-free image sniffing and header parsing (pure; unit-tested).
 *
 * sniffImageType() mirrors the engine's own filter exactly: utilities.get_image_file_paths keeps a
 * file when `filetype.guess_mime()` (filetype 1.2.0, first 8192 bytes, matchers tried in its
 * order) returns one of utilities.valid_mimetypes. Matching the same order matters: e.g. a file
 * starting with "BM" is a BMP for the engine, a TIFF header with "CR" at offset 8 is a Canon RAW
 * (not valid), and an HEIC brand wins over AVIF when both are listed.
 *
 * readImageSize() reports the size create_pdf actually lays out, i.e. AFTER Pillow's
 * ImageOps.exif_transpose(): EXIF orientations 5–8 swap width/height (JPEG/PNG/WebP EXIF, PNG
 * "Raw profile type exif", XMP tiff:Orientation fallback, TIFF tag 274, AVIF irot). The stored
 * pixel size is returned as rawWidth/rawHeight.
 */

const fsp = require('node:fs/promises');
const zlib = require('node:zlib');

/** filetype reads at most this many bytes to identify a file. */
const HEAD_BYTES = 8192;
/** Never read more than this for one metadata box/segment/chunk. */
const MAX_META_BYTES = 1024 * 1024;
const EMPTY = new Uint8Array(0);

/** A frozen Set that also answers `includes()` like an array. */
class ImageTypeSet extends Set {
  constructor(values) {
    super(values);
    this._frozen = true;
  }

  /** @param {unknown} value */
  includes(value) { return this.has(value); }

  add(value) {
    if (this._frozen) throw new TypeError('VALID_TYPES is read-only');
    return super.add(value);
  }

  delete() { throw new TypeError('VALID_TYPES is read-only'); }

  clear() { throw new TypeError('VALID_TYPES is read-only'); }
}

/** Image types the engine reads (spec §9.4). 'heic' is detected but NOT valid. */
const VALID_TYPES = Object.freeze(new ImageTypeSet(['png', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif', 'jpx']));

/** Types readImageSize() can measure. */
const SIZED_TYPES = new Set(['png', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'avif', 'jpx']);

/** HEIF-family brands (only used to label not-supported photos as 'heic'). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs']);

// ---------------------------------------------------------------- byte helpers

function toBytes(buf) {
  if (buf == null) return EMPTY;
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  if (ArrayBuffer.isView(buf)) return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  throw new TypeError('expected a Buffer, Uint8Array or ArrayBuffer');
}

function eqAscii(b, off, str) {
  if (off < 0 || off + str.length > b.length) return false;
  for (let i = 0; i < str.length; i += 1) if (b[off + i] !== str.charCodeAt(i)) return false;
  return true;
}

function ascii(b, off, len) {
  let s = '';
  const end = Math.min(b.length, off + len);
  for (let i = off; i < end; i += 1) s += String.fromCharCode(b[i]);
  return s;
}

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const i32le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);

function u64be(b, o) {
  const hi = u32be(b, o);
  const lo = u32be(b, o + 4);
  return hi * 2 ** 32 + lo;
}

// ---------------------------------------------------------------- sniffing

/** filetype's IsoBmff._is_isobmff + _get_ftyp. */
function isoBmffBrands(b) {
  if (b.length < 16 || !eqAscii(b, 4, 'ftyp')) return null;
  const ftypLen = u32be(b, 0);
  if (b.length < ftypLen) return null;
  const major = ascii(b, 8, 4);
  const compat = [];
  for (let i = 16; i < ftypLen; i += 4) compat.push(ascii(b, i, 4));
  return { major, compat };
}

const isHeicBrand = ({ major, compat }) => major === 'heic' || ((major === 'mif1' || major === 'msf1') && compat.includes('heic'));
const isAvifBrand = ({ major, compat }) => major === 'avif' || ((major === 'mif1' || major === 'msf1') && compat.includes('avif'));
const isHeifFamily = ({ major, compat }) => HEIF_BRANDS.has(major)
  || ((major === 'mif1' || major === 'msf1') && compat.some((c) => HEIF_BRANDS.has(c)));

/**
 * Identify an image from its first bytes (only the first 8192 are considered), exactly like the
 * engine's filetype check.
 * @param {Uint8Array|ArrayBuffer|ArrayBufferView} buf file head
 * @returns {'png'|'jpeg'|'gif'|'webp'|'bmp'|'tiff'|'avif'|'jpx'|'heic'|null} null = not an image
 *   the engine reads (or not an image at all); 'heic' = HEIC/HEIF photo (NOT in VALID_TYPES).
 */
function sniffImageType(buf) {
  let b = toBytes(buf);
  if (b.length > HEAD_BYTES) b = b.subarray(0, HEAD_BYTES);
  const len = b.length;
  // filetype.types.IMAGE order: Dwg, Xcf, Jpeg, Jpx, Apng, Png, Gif, Webp, Tiff, Cr2, Bmp, Jxr, Psd, Ico, Heic, Dcm, Avif
  if (eqAscii(b, 0, 'AC10')) return null; // DWG
  if (eqAscii(b, 0, 'gimp xcf v')) return null; // XCF
  if (len > 2 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (len > 50 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0C && eqAscii(b, 16, 'ftypjp2 ')) return 'jpx';
  if (len > 3 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png'; // also APNG
  if (len > 2 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  if (len > 13 && eqAscii(b, 0, 'RIFF') && eqAscii(b, 8, 'WEBPVP')) return 'webp';
  const tiffHeader = len > 9 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A && b[3] === 0x00)
    || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A));
  if (tiffHeader) return b[8] === 0x43 && b[9] === 0x52 ? null /* Canon CR2 */ : 'tiff';
  if (len > 1 && b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
  if (len > 2 && b[0] === 0x49 && b[1] === 0x49 && b[2] === 0xBC) return null; // JPEG XR
  if (len > 3 && eqAscii(b, 0, '8BPS')) return null; // PSD
  if (len > 3 && b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return null; // ICO
  const brands = isoBmffBrands(b);
  if (brands && isHeicBrand(brands)) return 'heic';
  if (len > 132 && eqAscii(b, 128, 'DICM')) return null; // DICOM
  if (brands && isAvifBrand(brands)) return 'avif';
  if (brands && isHeifFamily(brands)) return 'heic'; // filetype says "unknown"; invalid either way
  return null;
}

// ---------------------------------------------------------------- byte sources

/** Random access over a file (or an in-memory buffer) with the first bytes cached. */
class ByteSource {
  constructor(head, size, readAt) {
    this.head = head;
    this.size = size;
    this.readAt = readAt;
  }

  async read(pos, len) {
    if (!(pos >= 0) || !(len > 0) || pos >= this.size) return EMPTY;
    const want = Math.min(len, this.size - pos);
    if (pos + want <= this.head.length || !this.readAt) {
      return this.head.subarray(Math.min(pos, this.head.length), Math.min(pos + want, this.head.length));
    }
    return this.readAt(pos, want);
  }
}

function bufferSource(buf) {
  const b = toBytes(buf);
  return new ByteSource(b, b.length, null);
}

async function openFileSource(abs) {
  const fh = await fsp.open(abs, 'r');
  try {
    const stat = await fh.stat();
    const headLen = Math.min(HEAD_BYTES, stat.size);
    const head = Buffer.alloc(headLen);
    let got = 0;
    while (got < headLen) {
      const { bytesRead } = await fh.read(head, got, headLen - got, got);
      if (!bytesRead) break;
      got += bytesRead;
    }
    const readAt = async (pos, len) => {
      const out = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(out, 0, len, pos);
      return out.subarray(0, bytesRead);
    };
    return { fh, stat, src: new ByteSource(head.subarray(0, got), stat.size, readAt) };
  } catch (err) {
    await fh.close().catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------- orientation helpers

/**
 * Orientation tag of IFD0 in a TIFF/EXIF structure (Pillow's Exif.load strips any number of
 * leading "Exif\0\0"). Returns undefined when the tag is absent, else its integer value.
 */
function tiffOrientation(data) {
  let b = toBytes(data);
  while (b.length >= 6 && eqAscii(b, 0, 'Exif') && b[4] === 0 && b[5] === 0) b = b.subarray(6);
  if (b.length < 8) return undefined;
  let le;
  if (b[0] === 0x49 && b[1] === 0x49) le = true;
  else if (b[0] === 0x4D && b[1] === 0x4D) le = false;
  else return undefined;
  const r16 = (o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (o) => (le ? u32le(b, o) : u32be(b, o));
  if (r16(2) !== 42) return undefined;
  const ifd = r32(4);
  if (ifd + 2 > b.length) return undefined;
  const count = r16(ifd);
  for (let i = 0; i < count; i += 1) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > b.length) break;
    if (r16(e) !== 0x0112) continue;
    return readIfdInt(b, e, le);
  }
  return undefined;
}

function readIfdInt(b, entry, le) {
  const type = le ? u16le(b, entry + 2) : u16be(b, entry + 2);
  const v = entry + 8;
  switch (type) {
    case 1: case 7: return b[v]; // BYTE / UNDEFINED
    case 3: return le ? u16le(b, v) : u16be(b, v); // SHORT
    case 4: return le ? u32le(b, v) : u32be(b, v); // LONG
    case 6: return (b[v] << 24) >> 24; // SBYTE
    case 8: { const x = le ? u16le(b, v) : u16be(b, v); return (x << 16) >> 16; } // SSHORT
    case 9: return le ? i32le(b, v) : u32be(b, v) | 0; // SLONG
    default: return undefined;
  }
}

const XMP_ORIENTATION_RE = /tiff:Orientation(="|>)([0-9])/;

function xmpOrientation(text) {
  if (!text) return undefined;
  const m = XMP_ORIENTATION_RE.exec(text);
  return m ? Number(m[2]) : undefined;
}

function latin1(b) {
  return Buffer.from(b.buffer, b.byteOffset, b.byteLength).toString('latin1');
}

function inflateLimited(b) {
  try {
    return toBytes(zlib.inflateSync(Buffer.from(b.buffer, b.byteOffset, b.byteLength), { maxOutputLength: MAX_META_BYTES }));
  } catch {
    return null;
  }
}

/** Pillow: exif orientation if the tag is present, else the XMP tiff:Orientation, else 1. */
function resolveOrientation(exifValue, xmpValue) {
  if (exifValue !== undefined) return exifValue;
  if (xmpValue !== undefined) return xmpValue;
  return 1;
}

function result(width, height, orientation, swapForOrientation = true) {
  if (!(width > 0) || !(height > 0)) return null;
  const o = Number.isInteger(orientation) ? orientation : 1;
  const swap = swapForOrientation && o >= 5 && o <= 8;
  return {
    width: swap ? height : width,
    height: swap ? width : height,
    rawWidth: width,
    rawHeight: height,
    orientation: o >= 1 && o <= 8 ? o : 1,
  };
}

// ---------------------------------------------------------------- PNG

async function readPng(src) {
  const h = src.head;
  if (h.length < 24 || !(h[0] === 0x89 && eqAscii(h, 1, 'PNG\r\n\x1a\n')) || !eqAscii(h, 12, 'IHDR')) return null;
  const width = u32be(h, 16);
  const height = u32be(h, 20);
  let exifData = null;
  let rawProfile = null;
  let xmp;
  let pos = 8;
  for (let guard = 0; guard < 512 && pos + 8 <= src.size; guard += 1) {
    const hdr = await src.read(pos, 8);
    if (hdr.length < 8) break;
    const len = u32be(hdr, 0);
    const type = ascii(hdr, 4, 4);
    if (type === 'IDAT' || type === 'IEND') break; // metadata after IDAT is not looked at (rare)
    if (len <= MAX_META_BYTES && (type === 'eXIf' || type === 'tEXt' || type === 'zTXt' || type === 'iTXt')) {
      const data = await src.read(pos + 8, len);
      if (data.length === len) {
        if (type === 'eXIf') {
          exifData = data;
        } else {
          const nul = data.indexOf(0);
          if (nul > 0) {
            const key = ascii(data, 0, nul);
            let value = null;
            if (type === 'tEXt') {
              value = data.subarray(nul + 1);
            } else if (type === 'zTXt') {
              value = data[nul + 1] === 0 ? inflateLimited(data.subarray(nul + 2)) : null;
            } else if (key === 'XML:com.adobe.xmp' || key === 'Raw profile type exif') {
              // iTXt: keyword\0 flag method lang\0 translated\0 text
              const flag = data[nul + 1];
              let p = nul + 3;
              const langEnd = data.indexOf(0, p);
              if (langEnd >= 0) {
                const tkEnd = data.indexOf(0, langEnd + 1);
                if (tkEnd >= 0) {
                  p = tkEnd + 1;
                  value = flag === 1 ? inflateLimited(data.subarray(p)) : data.subarray(p);
                }
              }
            }
            if (value) {
              if (key === 'Raw profile type exif') rawProfile = latin1(value);
              else if (key === 'XML:com.adobe.xmp') xmp = latin1(value);
              else if (key === 'exif' && type === 'tEXt') exifData = value;
            }
          }
        }
      }
    }
    pos += 12 + len;
  }
  let exifValue;
  if (exifData) {
    exifValue = tiffOrientation(exifData);
  } else if (rawProfile) {
    const hex = rawProfile.split('\n').slice(3).join('').replace(/\s+/g, '');
    if (/^(?:[0-9a-fA-F]{2})+$/.test(hex)) exifValue = tiffOrientation(Buffer.from(hex, 'hex'));
  }
  return result(width, height, resolveOrientation(exifValue, xmpOrientation(xmp)));
}

// ---------------------------------------------------------------- JPEG

const SOF_MARKERS = new Set([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF]);
const XMP_APP1_ID = 'http://ns.adobe.com/xap/1.0/\0';

async function readJpeg(src) {
  let pos = 2;
  let width = 0;
  let height = 0;
  let exifValue;
  let exifSeen = false;
  let xmp;
  let junk = 0;
  for (let guard = 0; guard < 4096 && pos + 2 <= src.size; guard += 1) {
    let b = await src.read(pos, 2);
    if (b.length < 2) break;
    if (b[0] !== 0xFF) {
      // Like Pillow, skip stray bytes between segments (bounded).
      const win = await src.read(pos, 4096);
      const next = win.indexOf(0xFF, 1);
      const skip = next > 0 ? next : win.length;
      junk += skip;
      if (!skip || junk > 65536) break;
      pos += skip;
      continue;
    }
    let marker = b[1];
    while (marker === 0xFF) { // fill bytes
      pos += 1;
      b = await src.read(pos, 2);
      if (b.length < 2) return result(width, height, resolveOrientation(exifValue, xmpOrientation(xmp)));
      marker = b[1];
    }
    pos += 2;
    if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) continue; // standalone
    if (marker === 0xD9 || marker === 0xDA) break; // EOI / start of scan
    const lb = await src.read(pos, 2);
    if (lb.length < 2) break;
    const segLen = u16be(lb, 0);
    if (segLen < 2) break;
    if (SOF_MARKERS.has(marker)) {
      const s = await src.read(pos + 2, 5);
      if (s.length < 5) break;
      height = u16be(s, 1);
      width = u16be(s, 3);
    } else if (marker === 0xE1) {
      const data = await src.read(pos + 2, segLen - 2);
      if (!exifSeen && data.length >= 6 && eqAscii(data, 0, 'Exif') && data[4] === 0 && data[5] === 0) {
        exifSeen = true; // Pillow takes IFD0 from the first Exif segment
        exifValue = tiffOrientation(data);
      } else if (eqAscii(data, 0, XMP_APP1_ID)) {
        xmp = latin1(data.subarray(XMP_APP1_ID.length));
      }
    }
    pos += segLen;
  }
  return result(width, height, resolveOrientation(exifValue, xmpOrientation(xmp)));
}

// ---------------------------------------------------------------- GIF / BMP

function readGif(src) {
  const h = src.head;
  if (h.length < 10 || !(eqAscii(h, 0, 'GIF87a') || eqAscii(h, 0, 'GIF89a'))) return null;
  return result(u16le(h, 6), u16le(h, 8), 1, false);
}

function readBmp(src) {
  const h = src.head;
  if (h.length < 26 || !eqAscii(h, 0, 'BM')) return null;
  const headerSize = u32le(h, 14);
  let width;
  let height;
  if (headerSize === 12) {
    width = u16le(h, 18);
    height = u16le(h, 20);
  } else if ([40, 52, 56, 64, 108, 124].includes(headerSize)) {
    width = i32le(h, 18);
    height = Math.abs(i32le(h, 22));
  } else {
    return null; // Pillow: "Unsupported BMP header type"
  }
  if (width * height > 2 ** 31) return null;
  return result(width, height, 1, false);
}

// ---------------------------------------------------------------- WebP

async function readWebp(src) {
  const h = src.head;
  if (h.length < 30 || !eqAscii(h, 0, 'RIFF') || !eqAscii(h, 8, 'WEBP')) return null;
  const fourcc = ascii(h, 12, 4);
  if (fourcc === 'VP8 ') {
    if (!(h[23] === 0x9D && h[24] === 0x01 && h[25] === 0x2A)) return null;
    return result(u16le(h, 26) & 0x3FFF, u16le(h, 28) & 0x3FFF, 1, false);
  }
  if (fourcc === 'VP8L') {
    if (h[20] !== 0x2F) return null;
    const bits = u32le(h, 21);
    return result((bits & 0x3FFF) + 1, ((bits >>> 14) & 0x3FFF) + 1, 1, false);
  }
  if (fourcc !== 'VP8X') return null;
  const width = u24le(h, 24) + 1;
  const height = u24le(h, 27) + 1;
  let exifValue;
  let xmp;
  let pos = 12;
  const riffEnd = Math.min(src.size, u32le(h, 4) + 8);
  for (let guard = 0; guard < 256 && pos + 8 <= riffEnd; guard += 1) {
    const hdr = await src.read(pos, 8);
    if (hdr.length < 8) break;
    const id = ascii(hdr, 0, 4);
    const size = u32le(hdr, 4);
    if ((id === 'EXIF' || id === 'XMP ') && size <= MAX_META_BYTES) {
      const data = await src.read(pos + 8, size);
      if (data.length === size) {
        if (id === 'EXIF' && exifValue === undefined) exifValue = tiffOrientation(data);
        if (id === 'XMP ') xmp = latin1(data);
      }
    }
    pos += 8 + size + (size & 1);
  }
  return result(width, height, resolveOrientation(exifValue, xmpOrientation(xmp)));
}

// ---------------------------------------------------------------- TIFF

async function readTiff(src) {
  const h = src.head;
  if (h.length < 8) return null;
  const le = h[0] === 0x49;
  const r16 = (b, o) => (le ? u16le(b, o) : u16be(b, o));
  const r32 = (b, o) => (le ? u32le(b, o) : u32be(b, o));
  const ifd = r32(h, 4);
  const countBuf = await src.read(ifd, 2);
  if (countBuf.length < 2) return null;
  const count = r16(countBuf, 0);
  if (!count || count > 4096) return null;
  const entries = await src.read(ifd + 2, count * 12);
  let width = 0;
  let height = 0;
  let orientation;
  for (let i = 0; i + 12 <= entries.length; i += 12) {
    const tag = r16(entries, i);
    if (tag === 256) width = readIfdInt(entries, i, le) || 0;
    else if (tag === 257) height = readIfdInt(entries, i, le) || 0;
    else if (tag === 274) orientation = readIfdInt(entries, i, le);
  }
  return result(width, height, orientation === undefined ? 1 : orientation);
}

// ---------------------------------------------------------------- ISO-BMFF (AVIF) / JP2

function listBoxes(b, start, end) {
  const boxes = [];
  let pos = start;
  while (pos + 8 <= end && boxes.length < 4096) {
    let size = u32be(b, pos);
    const type = ascii(b, pos + 4, 4);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) break;
      size = u64be(b, pos + 8);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) break;
    boxes.push({ type, start: pos, data: pos + header, end: pos + size });
    pos += size;
  }
  return boxes;
}

async function findTopLevelBox(src, wanted) {
  let pos = 0;
  for (let guard = 0; guard < 256 && pos + 8 <= src.size; guard += 1) {
    const hdr = await src.read(pos, 16);
    if (hdr.length < 8) return null;
    let size = u32be(hdr, 0);
    const type = ascii(hdr, 4, 4);
    let header = 8;
    if (size === 1) {
      if (hdr.length < 16) return null;
      size = u64be(hdr, 8);
      header = 16;
    } else if (size === 0) {
      size = src.size - pos;
    }
    if (size < header) return null;
    if (type === wanted) {
      if (size > MAX_META_BYTES) return null;
      const box = await src.read(pos, size);
      return box.length === size ? { box, header } : null;
    }
    pos += size;
  }
  return null;
}

async function readAvif(src) {
  const found = await findTopLevelBox(src, 'meta');
  if (!found) return null;
  const { box, header } = found;
  const children = listBoxes(box, header + 4, box.length); // meta is a FullBox
  let primary = null;
  let ipco = null;
  let ipma = null;
  for (const c of children) {
    if (c.type === 'pitm') primary = box[c.data] === 0 ? u16be(box, c.data + 4) : u32be(box, c.data + 4);
    if (c.type === 'iprp') {
      for (const p of listBoxes(box, c.data, c.end)) {
        if (p.type === 'ipco') ipco = p;
        if (p.type === 'ipma') ipma = p;
      }
    }
  }
  if (!ipco) return null;
  const props = listBoxes(box, ipco.data, ipco.end);
  const ispeOf = (p) => (p && p.type === 'ispe' && p.data + 12 <= p.end
    ? { width: u32be(box, p.data + 4), height: u32be(box, p.data + 8) } : null);

  let ispe = null;
  let angle = 0;
  if (primary !== null && ipma) {
    const version = box[ipma.data];
    const flags = (box[ipma.data + 1] << 16) | (box[ipma.data + 2] << 8) | box[ipma.data + 3];
    let p = ipma.data + 4;
    const entryCount = u32be(box, p);
    p += 4;
    for (let e = 0; e < entryCount && p < ipma.end; e += 1) {
      const itemId = version < 1 ? u16be(box, p) : u32be(box, p);
      p += version < 1 ? 2 : 4;
      const n = box[p];
      p += 1;
      const indices = [];
      for (let k = 0; k < n; k += 1) {
        if (flags & 1) { indices.push(u16be(box, p) & 0x7FFF); p += 2; } else { indices.push(box[p] & 0x7F); p += 1; }
      }
      if (itemId === primary) {
        for (const idx of indices) {
          const prop = props[idx - 1];
          if (!prop) continue;
          if (prop.type === 'ispe' && !ispe) ispe = ispeOf(prop);
          if (prop.type === 'irot') angle = box[prop.data] & 3;
        }
        break;
      }
    }
  }
  if (!ispe) {
    // Best effort: the largest ispe in the container.
    for (const p of props) {
      const s = ispeOf(p);
      if (s && (!ispe || s.width * s.height > ispe.width * ispe.height)) ispe = s;
    }
  }
  if (!ispe) return null;
  // Pillow maps irot/imir to an EXIF orientation; a 90/270 degree rotation swaps the size.
  return result(ispe.width, ispe.height, angle === 1 || angle === 3 ? 6 : 1);
}

async function readJpx(src) {
  const found = await findTopLevelBox(src, 'jp2h');
  if (!found) return null;
  const { box, header } = found;
  for (const c of listBoxes(box, header, box.length)) {
    if (c.type === 'ihdr' && c.data + 8 <= c.end) {
      return result(u32be(box, c.data + 4), u32be(box, c.data), 1, false);
    }
  }
  return null;
}

// ---------------------------------------------------------------- public API

const READERS = { png: readPng, jpeg: readJpeg, gif: readGif, bmp: readBmp, webp: readWebp, tiff: readTiff, avif: readAvif, jpx: readJpx };

async function measure(src, type) {
  const reader = READERS[type];
  if (!reader) return null;
  try {
    const r = await reader(src);
    return r ? { ...r, type } : null;
  } catch {
    return null; // corrupt data never throws
  }
}

/**
 * Read the pixel size of an image from its header (no decoding).
 *
 * @param {string|Uint8Array|ArrayBuffer|ArrayBufferView} input absolute file path, or the file bytes
 * @returns {Promise<{ width: number, height: number, rawWidth: number, rawHeight: number,
 *   orientation: number, type: string }|null>} width/height = size after EXIF orientation (what
 *   create_pdf lays out); rawWidth/rawHeight = stored size; orientation = EXIF value 1–8 (1 when
 *   absent). null when the type is not measurable (heic, unknown), the header is damaged, or the
 *   file cannot be read.
 */
async function readImageSize(input) {
  if (typeof input !== 'string') {
    const src = bufferSource(input);
    return measure(src, sniffImageType(src.head));
  }
  let opened;
  try {
    opened = await openFileSource(input);
  } catch {
    return null;
  }
  try {
    return await measure(opened.src, sniffImageType(opened.src.head));
  } finally {
    await opened.fh.close().catch(() => {});
  }
}

/**
 * Open a file once: sniff its type and (optionally) measure it. Used by scan.js.
 * File-system errors (ENOENT, EACCES, EBUSY …) are thrown; damaged headers just give null sizes.
 * @param {string} abs absolute path
 * @param {{ sizes?: boolean }} [opts]
 * @returns {Promise<{ type: string|null, valid: boolean, size: number, mtimeMs: number,
 *   width: number|null, height: number|null, orientation: number|null }>}
 */
async function probeImage(abs, { sizes = true } = {}) {
  const { fh, stat, src } = await openFileSource(abs);
  try {
    const type = sniffImageType(src.head);
    const valid = VALID_TYPES.has(type);
    const out = { type, valid, size: stat.size, mtimeMs: stat.mtimeMs, width: null, height: null, orientation: null };
    if (sizes && valid && SIZED_TYPES.has(type)) {
      const m = await measure(src, type);
      if (m) {
        out.width = m.width;
        out.height = m.height;
        out.orientation = m.orientation;
      }
    }
    return out;
  } finally {
    await fh.close().catch(() => {});
  }
}

module.exports = {
  sniffImageType,
  readImageSize,
  probeImage,
  VALID_TYPES,
  HEAD_BYTES,
};
