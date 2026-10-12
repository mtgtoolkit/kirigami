'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const util = require('../../src/main/util');

const IS_WIN = process.platform === 'win32';

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-util-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('resolveInside rejects traversal, absolute, drive, UNC and device paths', () => {
  const root = path.join(os.tmpdir(), 'scm-root', 'game', 'front');
  const bad = [
    '', '.', './', '..', '../x.png', 'a/../../x.png', 'a/../b.png', 'a\\..\\..\\x.png', '...', '. .', 'a/./b.png',
    '/etc/passwd', '\\Windows\\win.ini', 'C:\\Windows\\win.ini', 'c:/x.png', 'C:x.png', 'z:',
    '\\\\server\\share\\x.png', '//server/share/x.png', '\\\\?\\C:\\x.png', '\\\\.\\pipe\\x', 'a\u0000b.png', 'a\nb.png',
  ];
  if (IS_WIN) bad.push('a.png:stream', 'CON', 'sub/nul.png', 'COM1.jpg');
  for (const rel of bad) {
    assert.throws(() => util.resolveInside(root, rel), (err) => err instanceof TypeError, `should reject ${JSON.stringify(rel)}`);
  }
  for (const value of [null, undefined, 42, {}, ['a']]) {
    assert.throws(() => util.resolveInside(root, value), TypeError);
  }
  assert.throws(() => util.resolveInside('', 'a.png'), TypeError);
});

test('resolveInside accepts normal relative paths (both separators, unicode, # and spaces)', () => {
  const root = path.join(os.tmpdir(), 'scm-root', 'game', 'front');
  const cases = {
    'a.png': ['a.png'],
    'sub/a.png': ['sub', 'a.png'],
    'sub\\deeper\\a.png': ['sub', 'deeper', 'a.png'],
    'a..b.png': ['a..b.png'],
    '.hidden.png': ['.hidden.png'],
    'dossier é ü/carte #1 (copie).png': ['dossier é ü', 'carte #1 (copie).png'],
    'x//y.png': ['x', 'y.png'],
  };
  for (const [rel, parts] of Object.entries(cases)) {
    if (!IS_WIN && rel.includes('\\')) continue;
    assert.equal(util.resolveInside(root, rel), path.join(root, ...parts), rel);
  }
});

test('isInside / samePath', () => {
  const root = path.resolve(os.tmpdir(), 'scm-root');
  assert.equal(util.isInside(root, root), true);
  assert.equal(util.isInside(root, path.join(root, 'a', 'b.png')), true);
  assert.equal(util.isInside(root, path.join(root, '..foo')), true, 'a child named "..foo" is inside');
  assert.equal(util.isInside(root, `${root}2`), false, 'sibling sharing a prefix');
  assert.equal(util.isInside(root, path.dirname(root)), false);
  assert.equal(util.isInside(root, path.join(root, '..', 'x')), false);
  assert.equal(util.isInside('', root), false);
  assert.equal(util.isInside(root, null), false);
  if (IS_WIN) {
    assert.equal(util.isInside('C:\\Root', 'c:\\root\\File.png'), true, 'case-insensitive on Windows');
    assert.equal(util.isInside('C:\\Root', 'D:\\Root\\x'), false, 'different drive');
    assert.equal(util.samePath('C:\\A\\b', 'c:/a/B'), true);
  }
  assert.equal(util.samePath(root, path.join(root, 'x', '..')), true);
  assert.equal(util.samePath(root, ''), false);
});

test('toPosix / relForDisplay', () => {
  assert.equal(util.toPosix('a\\b\\c.png'), 'a/b/c.png');
  const root = path.resolve(os.tmpdir(), 'ws');
  assert.equal(util.relForDisplay(root, path.join(root, 'game', 'front')), 'game/front');
  const outside = path.resolve(os.tmpdir(), 'elsewhere', 'x.pdf');
  assert.equal(util.relForDisplay(root, outside), outside);
  assert.equal(util.relForDisplay(root, root), root);
});

test('isReservedWindowsName', () => {
  for (const name of ['CON', 'con', 'Con.txt', 'PRN', 'AUX.png', 'NUL', 'nul.tar.gz', 'COM1', 'com9.jpg', 'COM0', 'LPT1', 'LPT9.png',
    'COM\u00b9', 'LPT\u00b3.txt', 'CONIN$', 'conout$', 'NUL .txt']) {
    assert.equal(util.isReservedWindowsName(name), true, name);
  }
  for (const name of ['CONSOLE', 'COM10', 'LPT', 'com', 'xcon', 'nul_', 'AUXILIARY.txt', 'my CON.txt', '', null]) {
    assert.equal(util.isReservedWindowsName(name), false, String(name));
  }
});

test('sanitizeFileName strips invalid characters, trailing dots/spaces, reserved names, and truncates', () => {
  assert.equal(util.sanitizeFileName('My <deck>: "v2" / final?*|'), 'My deck v2  final');
  assert.equal(util.sanitizeFileName('  leading and trailing. . . '), 'leading and trailing');
  assert.equal(util.sanitizeFileName('a\u0000b\u001fc\u007fd'), 'abcd');
  assert.equal(util.sanitizeFileName('CON'), 'CON_');
  assert.equal(util.sanitizeFileName('nul.txt'), 'nul_.txt');
  assert.equal(util.sanitizeFileName('com1.pdf'), 'com1_.pdf');
  assert.equal(util.sanitizeFileName('..'), '');
  assert.equal(util.sanitizeFileName('...', { fallback: 'proxies' }), 'proxies');
  assert.equal(util.sanitizeFileName(null, { fallback: 'proxies' }), 'proxies');
  assert.equal(util.sanitizeFileName('card [alt] *1*', { stripGlob: true }), 'card alt 1');
  assert.equal(util.sanitizeFileName('card [alt]'), 'card [alt]');
  assert.equal(util.sanitizeFileName('x'.repeat(150)).length, 100);
  assert.equal(util.sanitizeFileName('abc', { maxLen: 2 }), 'ab');
  assert.equal(util.sanitizeFileName('ab. cd', { maxLen: 3 }), 'ab', 'trailing dot/space removed after truncation');
  const emoji = `${'a'.repeat(9)}\u{1F600}`; // 9 + 2 UTF-16 units
  assert.equal(util.sanitizeFileName(emoji, { maxLen: 10 }), 'a'.repeat(9), 'never splits a surrogate pair');
  assert.equal(util.sanitizeFileName('e\u0301te\u0301'), '\u00e9t\u00e9', 'NFC normalized');
  assert.equal(util.sanitizeFileName('Lightning Bolt (M10) #146.png'), 'Lightning Bolt (M10) #146.png');
});

test('uniqueStemPath avoids existing files and taken stems (case-insensitive), continues (n) suffixes', (t) => {
  const dir = tmpDir(t);
  fs.writeFileSync(path.join(dir, 'a.png'), 'x');
  fs.writeFileSync(path.join(dir, 'card (2).jpg'), 'x');
  assert.equal(util.uniqueStemPath(dir, 'b', '.png'), path.join(dir, 'b.png'));
  assert.equal(util.uniqueStemPath(dir, 'a', '.jpg'), path.join(dir, 'a (2).jpg'), 'same stem, other extension is taken');
  assert.equal(util.uniqueStemPath(dir, 'A', 'png'), path.join(dir, 'A (2).png'), 'case-insensitive, ext without dot');
  assert.equal(util.uniqueStemPath(dir, 'card (2)', '.png'), path.join(dir, 'card (3).png'));
  assert.equal(util.uniqueStemPath(dir, 'noext', ''), path.join(dir, 'noext'));

  const taken = new Set(['x', 'X (2)']);
  assert.equal(util.uniqueStemPath(dir, 'x', '.png', taken), path.join(dir, 'x (3).png'));
  assert.ok(taken.has('x (3)'), 'chosen stem is added to the set');
  assert.equal(util.uniqueStemPath(dir, 'x', '.png', taken), path.join(dir, 'x (4).png'));
  // with an explicit set, the folder is still checked for the exact target file
  assert.equal(util.uniqueStemPath(dir, 'a', '.png', new Set()), path.join(dir, 'a (2).png'));
  assert.equal(util.uniqueStemPath(path.join(dir, 'missing'), 'z', '.png'), path.join(dir, 'missing', 'z.png'));
});

test('crc32 matches the standard check value and zlib', () => {
  assert.equal(util.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(util.crc32(Buffer.alloc(0)), 0);
  if (typeof zlib.crc32 === 'function') {
    const buf = crypto.randomBytes(4096);
    assert.equal(util.crc32(buf), zlib.crc32(buf));
  }
});

function parsePng(buf) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    const crc = buf.readUInt32BE(off + 8 + len);
    assert.equal(crc, util.crc32(buf.subarray(off + 4, off + 8 + len)), `CRC of ${type}`);
    if (typeof zlib.crc32 === 'function') assert.equal(crc, zlib.crc32(buf.subarray(off + 4, off + 8 + len)));
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.equal(off, buf.length, 'no trailing bytes');
  return chunks;
}

test('encodePng output decodes: signature, IHDR, CRCs, pixels', () => {
  const width = 5;
  const height = 3;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i += 1) rgba[i] = (i * 37) & 0xff;
  const png = util.encodePng(width, height, rgba);
  const chunks = parsePng(png);
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  assert.equal(ihdr.readUInt32BE(0), width);
  assert.equal(ihdr.readUInt32BE(4), height);
  assert.deepEqual([...ihdr.subarray(8)], [8, 6, 0, 0, 0], 'bit depth 8, RGBA, deflate, filter 0, no interlace');
  const raw = zlib.inflateSync(chunks[1].data);
  assert.equal(raw.length, height * (width * 4 + 1));
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    assert.equal(raw[rowStart], 0, 'filter type None');
    assert.deepEqual([...raw.subarray(rowStart + 1, rowStart + 1 + width * 4)], [...rgba.subarray(y * width * 4, (y + 1) * width * 4)]);
  }
  assert.equal(chunks[2].data.length, 0);

  // a 32x32 probe image (used for GPU detection) from a Buffer slice with an offset
  const big = Buffer.alloc(32 * 32 * 4 + 7, 200);
  const probe = util.encodePng(32, 32, big.subarray(7));
  assert.equal(parsePng(probe)[0].data.readUInt32BE(0), 32);

  assert.throws(() => util.encodePng(0, 1, new Uint8Array(0)), RangeError);
  assert.throws(() => util.encodePng(2, 2, new Uint8Array(3)), RangeError);
  assert.throws(() => util.encodePng(1.5, 1, new Uint8Array(4)), RangeError);
});

test('naturalCompare sorts numbers by value and is deterministic', () => {
  const list = ['card 10.png', 'card 2.png', 'card 1.png', 'Card 2.png', 'card 02.png', 'b', 'a'];
  const sorted = [...list].sort(util.naturalCompare);
  assert.deepEqual(sorted.slice(0, 2), ['a', 'b']);
  const nums = ['x10', 'x9', 'x100', 'x1'].sort(util.naturalCompare);
  assert.deepEqual(nums, ['x1', 'x9', 'x10', 'x100']);
  assert.deepEqual([...list].reverse().sort(util.naturalCompare), sorted, 'stable total order');
  assert.ok(util.naturalCompare('a', 'A') !== 0, 'case variants are distinct');
  assert.equal(util.naturalCompare('same', 'same'), 0);
});

test('timestampId / quoteForDisplay', () => {
  assert.equal(util.timestampId(new Date(2026, 0, 2, 3, 4, 5)), '20260102-030405');
  assert.match(util.timestampId(), /^\d{8}-\d{6}$/);
  assert.equal(util.quoteForDisplay('--ppi=300'), '--ppi=300');
  assert.equal(util.quoteForDisplay('game/front'), 'game/front');
  assert.equal(util.quoteForDisplay('--label=My deck'), '"--label=My deck"');
  assert.equal(util.quoteForDisplay('say "hi"'), '"say \\"hi\\""');
  assert.equal(util.quoteForDisplay('C:\\My Folder\\'), '"C:\\My Folder\\\\"');
  assert.equal(util.quoteForDisplay(''), '""');
});

test('readJson / ensureDir / sha1', async (t) => {
  const dir = tmpDir(t);
  const nested = path.join(dir, 'a', 'b');
  assert.equal(util.ensureDir(nested), nested);
  assert.ok(fs.statSync(nested).isDirectory());
  assert.deepEqual(util.readJson(path.join(dir, 'missing.json'), { d: 1 }), { d: 1 });
  fs.writeFileSync(path.join(dir, 'bom.json'), '\ufeff{"x":1}');
  assert.deepEqual(util.readJson(path.join(dir, 'bom.json')), { x: 1 });
  fs.writeFileSync(path.join(dir, 'bad.json'), '{x');
  assert.equal(util.readJson(path.join(dir, 'bad.json')), null);
  const file = path.join(dir, 'h.txt');
  fs.writeFileSync(file, 'hello wörld');
  const expected = crypto.createHash('sha1').update('hello wörld', 'utf8').digest('hex');
  assert.equal(await util.sha1File(file), expected);
  assert.equal(util.sha1Text('hello wörld'), expected);
  assert.equal(util.sha1Text(Buffer.from('hello wörld')), expected);
});

test('copyOrLink / moveFile / removeDirContents', async (t) => {
  const dir = tmpDir(t);
  const src = path.join(dir, 'src', 'carte #1 é.png');
  fs.mkdirSync(path.dirname(src), { recursive: true });
  fs.writeFileSync(src, 'PNGDATA');

  const dest = path.join(dir, 'stage', 'c0', 'front', 'carte #1 é.png');
  const mode = await util.copyOrLink(src, dest);
  assert.ok(mode === 'link' || mode === 'copy');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'PNGDATA');
  fs.writeFileSync(path.join(dir, 'other.png'), 'OTHER');
  assert.equal(await util.copyOrLink(path.join(dir, 'other.png'), dest, { link: false }), 'copy', 'replaces an existing destination');
  assert.equal(fs.readFileSync(dest, 'utf8'), 'OTHER');
  assert.equal(await util.copyOrLink(src, src), 'same');
  await assert.rejects(util.copyOrLink(path.join(dir, 'nope.png'), path.join(dir, 'x.png')), { code: 'ENOENT' });

  const moved = path.join(dir, 'trash', 'batch-1', 'front', 'carte #1 é.png');
  assert.equal(await util.moveFile(src, moved), 'rename');
  assert.equal(fs.existsSync(src), false);
  assert.equal(fs.readFileSync(moved, 'utf8'), 'PNGDATA');
  assert.equal(await util.moveFile(moved, moved), 'same');
  await assert.rejects(util.moveFile(path.join(dir, 'nope.png'), path.join(dir, 'y.png')), { code: 'ENOENT' });

  const box = path.join(dir, 'box');
  fs.mkdirSync(path.join(box, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(box, 'README.md'), 'keep');
  fs.writeFileSync(path.join(box, 'a.png'), 'x');
  fs.writeFileSync(path.join(box, 'sub', 'b.png'), 'x');
  // keep-names are case-insensitive on Windows
  assert.equal(await util.removeDirContents(box, { keep: [IS_WIN ? 'readme.md' : 'README.md'] }), 2);
  assert.deepEqual(fs.readdirSync(box), ['README.md']);
  assert.equal(await util.removeDirContents(box, { keep: (name) => name === 'nothing' }), 1);
  assert.deepEqual(fs.readdirSync(box), []);
  assert.equal(await util.removeDirContents(path.join(dir, 'missing')), 0);
});

test('freeDiskBytes walks up to an existing folder', async (t) => {
  const dir = tmpDir(t);
  const free = await util.freeDiskBytes(dir);
  assert.ok(Number.isFinite(free) && free > 0, `free=${free}`);
  const deep = await util.freeDiskBytes(path.join(dir, 'does', 'not', 'exist'));
  assert.ok(Number.isFinite(deep) && deep > 0);
  assert.equal(await util.freeDiskBytes(''), null);
});

test('createJsonWriter: flush with nothing pending resolves; pending() reflects state', async (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'cache.json');
  const w = util.createJsonWriter(file, { debounceMs: 20 });
  await w.flush();
  assert.equal(fs.existsSync(file), false);
  w.write({ entries: { a: 1 } });
  assert.equal(w.pending(), true);
  await w.flush();
  assert.equal(w.pending(), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { entries: { a: 1 } });
  // latest-state semantics: the object is serialized when written
  const state = { n: 1 };
  w.write(state);
  state.n = 2;
  await w.flush();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { n: 2 });
  // serialization errors are reported, not thrown
  const errors = [];
  const w2 = util.createJsonWriter(path.join(dir, 'c2.json'), { debounceMs: 0, onError: (e) => errors.push(e) });
  const circular = {};
  circular.self = circular;
  w2.write(circular);
  await w2.flush();
  assert.equal(errors.length, 1);
});
