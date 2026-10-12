'use strict';

// Parity tests: test/fixtures/images/expected.json records what the ENGINE's libraries say about
// every fixture (filetype.guess_mime for validity, Pillow size before/after exif_transpose).
// Regenerate with: <venv python> test/fixtures/images/generate.py

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { sniffImageType, readImageSize, probeImage, VALID_TYPES, HEAD_BYTES } = require('../../src/main/image-meta');

const DIR = path.join(__dirname, '..', 'fixtures', 'images');
const EXPECTED = JSON.parse(fs.readFileSync(path.join(DIR, 'expected.json'), 'utf8'));

test('fixtures are tiny and the manifest is complete', () => {
  assert.ok(EXPECTED.files.length >= 35);
  for (const e of EXPECTED.files) {
    const st = fs.statSync(path.join(DIR, e.file));
    assert.equal(st.size, e.bytes, e.file);
    assert.ok(st.size < 10 * 1024, `${e.file} must stay under 10 KB`);
  }
});

test('VALID_TYPES is exactly the engine set and is read-only', () => {
  assert.deepEqual([...VALID_TYPES].sort(), ['avif', 'bmp', 'gif', 'jpeg', 'jpx', 'png', 'tiff', 'webp']);
  assert.equal(VALID_TYPES.has('png'), true);
  assert.equal(VALID_TYPES.includes('jpeg'), true);
  assert.equal(VALID_TYPES.has('heic'), false);
  assert.equal(VALID_TYPES.includes(null), false);
  assert.throws(() => VALID_TYPES.add('heic'), TypeError);
  assert.throws(() => VALID_TYPES.delete('png'), TypeError);
  assert.throws(() => VALID_TYPES.clear(), TypeError);
  assert.equal(VALID_TYPES.size, 8);
  assert.equal(HEAD_BYTES, 8192);
});

for (const e of EXPECTED.files) {
  test(`sniff + size parity with filetype/Pillow: ${e.file}`, async () => {
    const abs = path.join(DIR, e.file);
    const bytes = fs.readFileSync(abs);
    const type = sniffImageType(bytes.subarray(0, HEAD_BYTES));
    // Validity must match the engine exactly; for valid files the type must match too.
    assert.equal(VALID_TYPES.has(type), e.valid, `validity of ${e.file} (sniffed ${type}, filetype ${e.mime})`);
    if (e.valid) assert.equal(type, e.type);
    if (e.mime === 'image/heic') assert.equal(type, 'heic');

    const size = await readImageSize(abs);
    const fromBuffer = await readImageSize(bytes);
    assert.deepEqual(fromBuffer, size, 'file and buffer reads agree');
    if (e.valid && e.pillow.ok) {
      assert.ok(size, `${e.file} should be measurable`);
      assert.equal(size.type, e.type);
      // Size AFTER exif_transpose = what create_pdf lays out.
      assert.deepEqual([size.width, size.height], [e.pillow.width, e.pillow.height], `${e.file} oriented size`);
      // Pillow's TIFF plugin already reports the rotated size as the "raw" size; other formats
      // report the stored size.
      if (e.type !== 'tiff') assert.deepEqual([size.rawWidth, size.rawHeight], [e.pillow.rawWidth, e.pillow.rawHeight]);
      assert.ok(size.orientation >= 1 && size.orientation <= 8);
    } else {
      assert.equal(size, null, `${e.file}: no size when the engine cannot read it`);
    }
  });
}

for (const b of EXPECTED.buffers) {
  test(`sniff parity on crafted header: ${b.name}`, () => {
    const type = sniffImageType(Buffer.from(b.hex, 'hex'));
    assert.equal(VALID_TYPES.has(type), b.valid, `${b.name}: sniffed ${type}, filetype ${b.mime}`);
    if (b.valid) assert.equal(type, b.type);
    if (b.mime === 'image/heic') assert.equal(type, 'heic');
  });
}

test('HEIF-family brands that filetype does not name are labelled heic (still not valid)', () => {
  const heix = EXPECTED.buffers.find((b) => b.name === 'heix_major');
  assert.equal(heix.mime, null);
  assert.equal(sniffImageType(Buffer.from(heix.hex, 'hex')), 'heic');
  const avis = EXPECTED.buffers.find((b) => b.name === 'avis_major');
  assert.equal(sniffImageType(Buffer.from(avis.hex, 'hex')), null, 'animated AVIF (avis) is not read by the engine');
});

test('sniffImageType only looks at the first 8192 bytes and accepts any byte view', () => {
  const late = Buffer.concat([Buffer.alloc(HEAD_BYTES), Buffer.from([0x89, 0x50, 0x4E, 0x47])]);
  assert.equal(sniffImageType(late), null);
  const png = fs.readFileSync(path.join(DIR, 'png_rgb.png'));
  const ab = png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength);
  assert.equal(sniffImageType(ab), 'png');
  assert.equal(sniffImageType(new Uint8Array(ab)), 'png');
  assert.equal(sniffImageType(new DataView(ab)), 'png');
  assert.equal(sniffImageType(null), null);
  assert.throws(() => sniffImageType('PNG'), TypeError);
});

test('damaged headers give null sizes instead of throwing', async () => {
  const png = fs.readFileSync(path.join(DIR, 'png_rgb.png'));
  const zeroDims = Buffer.from(png);
  zeroDims.writeUInt32BE(0, 16);
  assert.equal(await readImageSize(zeroDims), null);
  const badSig = Buffer.from(png);
  badSig[5] = 0x00; // still "png" for filetype (4-byte magic) but not openable by Pillow
  assert.equal(sniffImageType(badSig), 'png');
  assert.equal(await readImageSize(badSig), null);

  const jpeg = fs.readFileSync(path.join(DIR, 'jpeg_baseline.jpg'));
  assert.equal(await readImageSize(jpeg.subarray(0, 20)), null, 'JPEG cut before the SOF marker');
  assert.equal(await readImageSize(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x01])), null, 'bad segment length');

  const gif88 = Buffer.from('GIF88a\x10\x00\x10\x00', 'latin1');
  assert.equal(sniffImageType(gif88), 'gif');
  assert.equal(await readImageSize(gif88), null);

  const bmp = Buffer.alloc(30);
  bmp.write('BM', 0, 'latin1');
  bmp.writeUInt32LE(16, 14); // unsupported header size (Pillow refuses it)
  assert.equal(await readImageSize(bmp), null);

  const webp = fs.readFileSync(path.join(DIR, 'webp_lossy.webp'));
  const badVp8 = Buffer.from(webp);
  badVp8[23] = 0; // broken VP8 start code
  assert.equal(await readImageSize(badVp8), null);

  for (let n = 0; n < 64; n += 1) {
    // Random garbage after a valid magic must never throw.
    const junk = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.from(Array.from({ length: 200 }, (_, i) => (i * 37 + n * 11) & 0xFF))]);
    await readImageSize(junk);
  }
});

test('JPEG: size found beyond the first 8192 bytes (large comment before SOF)', async () => {
  const abs = path.join(DIR, 'jpeg_bigcomment.jpg');
  const bytes = fs.readFileSync(abs);
  const sof = bytes.indexOf(Buffer.from([0xFF, 0xC0]));
  assert.ok(sof > HEAD_BYTES, 'fixture really has its SOF after 8 KB');
  assert.deepEqual(await readImageSize(abs), { width: 32, height: 24, rawWidth: 32, rawHeight: 24, orientation: 1, type: 'jpeg' });
});

test('EXIF orientation swaps width/height like Pillow exif_transpose', async () => {
  assert.deepEqual(await readImageSize(path.join(DIR, 'jpeg_exif_orient6.jpg')),
    { width: 40, height: 60, rawWidth: 60, rawHeight: 40, orientation: 6, type: 'jpeg' });
  assert.deepEqual(await readImageSize(path.join(DIR, 'jpeg_exif_orient3.jpg')),
    { width: 60, height: 40, rawWidth: 60, rawHeight: 40, orientation: 3, type: 'jpeg' });
  assert.equal((await readImageSize(path.join(DIR, 'jpeg_xmp_orient8.jpg'))).orientation, 8);
  assert.equal((await readImageSize(path.join(DIR, 'png_rawprofile_ztxt.png'))).orientation, 5);
  assert.equal((await readImageSize(path.join(DIR, 'webp_exif_orient6.webp'))).orientation, 6);
  assert.equal((await readImageSize(path.join(DIR, 'avif_orient6.avif'))).width, 16);
});

test('readImageSize and probeImage on missing files', async () => {
  const missing = path.join(os.tmpdir(), `scm-missing-${process.pid}-${Date.now()}.png`);
  assert.equal(await readImageSize(missing), null);
  await assert.rejects(probeImage(missing), { code: 'ENOENT' });
});

test('probeImage: one open gives type, validity, file size, mtime and dimensions', async () => {
  const abs = path.join(DIR, 'jpeg_exif_orient6.jpg');
  const st = await fsp.stat(abs);
  const info = await probeImage(abs);
  assert.deepEqual(info, {
    type: 'jpeg', valid: true, size: st.size, mtimeMs: st.mtimeMs, width: 40, height: 60, orientation: 6,
  });
  const noSizes = await probeImage(abs, { sizes: false });
  assert.deepEqual([noSizes.width, noSizes.height, noSizes.orientation], [null, null, null]);
  const heic = await probeImage(path.join(DIR, 'heic_header.heic'));
  assert.deepEqual([heic.type, heic.valid, heic.width], ['heic', false, null]);
  const text = await probeImage(path.join(DIR, 'text_as_png.png'));
  assert.deepEqual([text.type, text.valid], [null, false]);
});
