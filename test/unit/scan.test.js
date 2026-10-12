'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  scanDir, scanImages, createHashCache, sha1File, nameParts, isJunkName, isIgnoredName, compareNatural,
} = require('../../src/main/scan');

const IMAGES = path.join(__dirname, '..', 'fixtures', 'images');
const isWin = process.platform === 'win32';

let tmpRoot;
test.before(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'scm-scan-test-'));
});
test.after(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true });
});

let treeCounter = 0;
async function makeTree(files) {
  treeCounter += 1;
  const root = path.join(tmpRoot, `tree${treeCounter}`);
  for (const [rel, source] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    if (source && source.fixture) await fsp.copyFile(path.join(IMAGES, source.fixture), abs);
    else await fsp.writeFile(abs, source == null ? '' : source);
  }
  return root;
}

const sha1 = (abs) => crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');

test('nameParts follows Python pathlib (stem/suffix)', () => {
  assert.deepEqual(nameParts('a.png'), { stem: 'a', ext: 'png', suffix: '.png' });
  assert.deepEqual(nameParts('Card.PNG'), { stem: 'Card', ext: 'png', suffix: '.PNG' });
  assert.deepEqual(nameParts('a.tar.gz'), { stem: 'a.tar', ext: 'gz', suffix: '.gz' });
  assert.deepEqual(nameParts('.png'), { stem: '.png', ext: '', suffix: '' });
  assert.deepEqual(nameParts('a.'), { stem: 'a.', ext: '', suffix: '' });
  assert.deepEqual(nameParts('x..png'), { stem: 'x.', ext: 'png', suffix: '.png' });
  assert.deepEqual(nameParts('noext'), { stem: 'noext', ext: '', suffix: '' });
  assert.deepEqual(nameParts(''), { stem: '', ext: '', suffix: '' });
});

test('junk and placeholder names', () => {
  for (const n of ['.DS_Store', 'Thumbs.db', 'THUMBS.DB', 'desktop.ini', 'Desktop.ini', 'Icon\r', '._Card 1.png']) assert.equal(isJunkName(n), true, n);
  for (const n of ['Icon', '.hidden.png', 'thumbs.db.png', '_card.png']) assert.equal(isJunkName(n), false, n);
  for (const n of ['README.md', 'readme.md', 'EMPTY.md', '.gitkeep']) assert.equal(isIgnoredName(n), true, n);
  for (const n of ['README.txt', 'notes.md']) assert.equal(isIgnoredName(n), false, n);
});

test('compareNatural', () => {
  const list = ['Card 10.png', 'card 1.png', 'Card 2.png', 'b/a.png', 'a.png'];
  assert.deepEqual(list.slice().sort(compareNatural), ['a.png', 'b/a.png', 'card 1.png', 'Card 2.png', 'Card 10.png']);
  assert.ok(compareNatural('A.png', 'a.png') !== 0, 'deterministic tie-break');
});

test('scanDir: recursive like os.walk, dot-files included, junk/placeholders skipped, natural order', async () => {
  const files = {
    'Card 10.png': { fixture: 'png_rgb.png' },
    'Card 2.png': { fixture: 'png_rgb.png' },
    'card 1.jpg': { fixture: 'jpeg_exif_orient6.jpg' },
    '.hidden.png': { fixture: 'png_rgba.png' },
    '.sub/inner.webp': { fixture: 'webp_lossless.webp' },
    'nested/deep/x.gif': { fixture: 'gif_static.gif' },
    'a.b.png': { fixture: 'png_palette.png' },
    '.png': { fixture: 'png_rgb.png' },
    'noext': { fixture: 'bmp_24.bmp' },
    'notes.txt': 'just text\n',
    'fake.png': { fixture: 'text_as_png.png' },
    'photo.heic': { fixture: 'heic_header.heic' },
    'empty.png': '',
    'README.md': '# readme',
    'EMPTY.md': '',
    '.gitkeep': '',
    'nested/README.md': 'x',
    '.DS_Store': 'junk',
    'Thumbs.db': 'junk',
    'desktop.ini': '[.ShellClassInfo]',
    '._Card 2.png': { fixture: 'png_rgb.png' },
    'nested/THUMBS.DB': 'junk',
  };
  const root = await makeTree(files);
  const { images, others, errors, truncated } = await scanDir(root);
  assert.equal(truncated, false);
  assert.deepEqual(errors, []);

  const rels = images.map((i) => i.rel);
  assert.deepEqual(rels.slice().sort(), [
    '.hidden.png', '.png', '.sub/inner.webp', 'a.b.png', 'Card 10.png', 'card 1.jpg', 'Card 2.png', 'nested/deep/x.gif', 'noext',
  ].sort());
  assert.deepEqual(rels.slice().sort(compareNatural), rels, 'natural order');
  assert.ok(rels.indexOf('card 1.jpg') < rels.indexOf('Card 2.png') && rels.indexOf('Card 2.png') < rels.indexOf('Card 10.png'));

  assert.deepEqual(others.map((o) => [o.rel, o.type]), [['empty.png', null], ['fake.png', null], ['notes.txt', null], ['photo.heic', 'heic']]);

  const gif = images.find((i) => i.rel === 'nested/deep/x.gif');
  const gifAbs = path.join(root, 'nested', 'deep', 'x.gif');
  const st = await fsp.stat(gifAbs);
  assert.deepEqual(gif, {
    rel: 'nested/deep/x.gif',
    relNoExt: 'nested/deep/x',
    abs: gifAbs,
    name: 'x.gif',
    stem: 'x',
    ext: 'gif',
    type: 'gif',
    size: st.size,
    mtimeMs: st.mtimeMs,
    width: 30,
    height: 20,
    orientation: 1,
    hash: null,
  });
  const jpg = images.find((i) => i.rel === 'card 1.jpg');
  assert.deepEqual([jpg.width, jpg.height, jpg.orientation], [40, 60, 6], 'size after EXIF orientation');
  const dotFile = images.find((i) => i.rel === '.png');
  assert.deepEqual([dotFile.stem, dotFile.ext, dotFile.relNoExt], ['.png', '', '.png']);
  const multiDot = images.find((i) => i.rel === 'a.b.png');
  assert.deepEqual([multiDot.stem, multiDot.relNoExt], ['a.b', 'a.b']);
  const sniffedOnly = images.find((i) => i.rel === 'noext');
  assert.deepEqual([sniffedOnly.type, sniffedOnly.ext], ['bmp', '']);
  const inner = images.find((i) => i.rel === '.sub/inner.webp');
  assert.equal(inner.relNoExt, '.sub/inner');

  assert.deepEqual((await scanImages(root)).map((i) => i.rel), rels);
});

test('scanDir options: sizes:false, hash:true, maxFiles', async () => {
  const root = await makeTree({
    'a.png': { fixture: 'png_rgb.png' },
    'b.jpg': { fixture: 'jpeg_baseline.jpg' },
    'c.webp': { fixture: 'webp_alpha.webp' },
    'd.txt': 'x',
  });
  const noSizes = await scanDir(root, { sizes: false });
  assert.deepEqual(noSizes.images.map((i) => [i.rel, i.type, i.width, i.height]), [['a.png', 'png', null, null], ['b.jpg', 'jpeg', null, null], ['c.webp', 'webp', null, null]]);

  const hashed = await scanDir(root, { hash: true });
  for (const img of hashed.images) assert.equal(img.hash, sha1(img.abs), img.rel);
  assert.equal(hashed.others[0].hash, null, 'others are not hashed');

  const limited = await scanDir(root, { maxFiles: 2 });
  assert.equal(limited.truncated, true);
  assert.equal(limited.images.length + limited.others.length, 2);
});

test('scanDir on a missing folder, a file, and invalid input', async () => {
  assert.deepEqual(await scanDir(path.join(tmpRoot, 'does-not-exist')), { images: [], others: [], errors: [], truncated: false });
  const root = await makeTree({ 'file.png': { fixture: 'png_rgb.png' } });
  assert.deepEqual(await scanDir(path.join(root, 'file.png')), { images: [], others: [], errors: [], truncated: false });
  await assert.rejects(scanDir(''), TypeError);
  await assert.rejects(scanDir(null), TypeError);
});

test('scanDir: links to files are followed, links to folders are not, dangling links are "others"', async (t) => {
  const root = await makeTree({ 'real/a.png': { fixture: 'png_rgb.png' }, 'other/b.png': { fixture: 'png_rgb.png' } });
  const scanRoot = path.join(root, 'real');
  try {
    await fsp.symlink(path.join(root, 'other', 'b.png'), path.join(scanRoot, 'link.png'), 'file');
    await fsp.symlink(path.join(root, 'other'), path.join(scanRoot, 'dirlink'), isWin ? 'junction' : 'dir');
    await fsp.symlink(path.join(root, 'nowhere.png'), path.join(scanRoot, 'dangling.png'), 'file');
  } catch (err) {
    if (err.code === 'EPERM' || err.code === 'EACCES') {
      t.skip('creating symbolic links needs Developer Mode or admin rights on this machine');
      return;
    }
    throw err;
  }
  const { images, others } = await scanDir(scanRoot);
  assert.deepEqual(images.map((i) => i.rel), ['a.png', 'link.png']);
  assert.equal(images[1].type, 'png');
  assert.deepEqual(others.map((o) => [o.rel, o.broken, typeof o.error]), [['dangling.png', true, 'string']]);
});

test('hash cache: persisted, reused without re-reading, keyed by abs|size|mtimeMs', async () => {
  const root = await makeTree({ 'a.png': { fixture: 'png_rgb.png' }, 'b.png': { fixture: 'png_rgba.png' } });
  // Whole-millisecond mtimes so they can be restored exactly after tampering below.
  const pinned = new Date('2020-01-01T00:00:00.000Z');
  for (const n of ['a.png', 'b.png']) await fsp.utimes(path.join(root, n), pinned, pinned);
  const cacheFile = path.join(root, 'cache', 'hashes.json');
  const cache = createHashCache(cacheFile, { debounceMs: 10 });
  const first = await scanDir(root, { hash: true, hashCache: cache });
  assert.equal(cache.size, 2);
  await cache.flush();
  const saved = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.entries.length, 2);
  for (const [key, digest] of saved.entries) {
    assert.match(key, /\|\d+\|[\d.]+$/);
    assert.match(digest, /^[0-9a-f]{40}$/);
  }

  // Change a's bytes but keep its size and mtime: a NEW cache (loaded from disk) must return the
  // old hash, which proves the file was not read again.
  const aAbs = path.join(root, 'a.png');
  const st = await fsp.stat(aAbs);
  const original = await fsp.readFile(aAbs);
  const tampered = Buffer.from(original);
  tampered[tampered.length - 1] ^= 0xFF;
  await fsp.writeFile(aAbs, tampered);
  await fsp.utimes(aAbs, pinned, pinned);
  const st2 = await fsp.stat(aAbs);
  assert.deepEqual([st2.size, st2.mtimeMs], [st.size, st.mtimeMs], 'same size and mtime after tampering');
  const reloaded = createHashCache(cacheFile);
  const firstA = first.images.find((i) => i.rel === 'a.png').hash;
  assert.equal(await reloaded.hashFile(aAbs), firstA, 'served from the persisted cache');
  assert.notEqual(sha1(aAbs), firstA);
  // A new mtime invalidates the entry.
  const later = new Date(st.mtimeMs + 5000);
  await fsp.utimes(aAbs, later, later);
  assert.equal(await reloaded.hashFile(aAbs), sha1(aAbs));
  await reloaded.flush();
});

test('hash cache: LRU bound, concurrent requests share one read, clear()', async () => {
  const root = await makeTree({
    '1.png': { fixture: 'png_rgb.png' }, '2.png': { fixture: 'png_rgba.png' }, '3.png': { fixture: 'png_palette.png' },
  });
  const cacheFile = path.join(root, 'hashes.json');
  const cache = createHashCache(cacheFile, { maxEntries: 2, debounceMs: 5 });
  const abs = (n) => path.join(root, `${n}.png`);
  const [x, y] = await Promise.all([cache.hashFile(abs(1)), cache.hashFile(abs(1))]);
  assert.equal(x, y);
  assert.equal(x, await sha1File(abs(1)));
  await cache.hashFile(abs(2));
  await cache.hashFile(abs(1)); // touch 1 -> 2 becomes least recently used
  await cache.hashFile(abs(3));
  assert.equal(cache.size, 2);
  await cache.flush();
  const keys = JSON.parse(await fsp.readFile(cacheFile, 'utf8')).entries.map(([k]) => path.basename(k.split('|')[0]));
  assert.deepEqual(keys, ['1.png', '3.png']);

  cache.clear();
  assert.equal(cache.size, 0);
  await cache.flush();
  assert.deepEqual(JSON.parse(await fsp.readFile(cacheFile, 'utf8')), { version: 1, entries: [] });
});

test('hash cache: corrupt or foreign files are ignored; clear() before load does not resurrect entries', async () => {
  const root = await makeTree({ 'a.png': { fixture: 'png_rgb.png' } });
  const cacheFile = path.join(root, 'hashes.json');
  await fsp.writeFile(cacheFile, '{ not json');
  const cache = createHashCache(cacheFile, { debounceMs: 5 });
  assert.equal(await cache.hashFile(path.join(root, 'a.png')), sha1(path.join(root, 'a.png')));
  await cache.flush();
  assert.equal(JSON.parse(await fsp.readFile(cacheFile, 'utf8')).entries.length, 1);

  await fsp.writeFile(cacheFile, JSON.stringify({ version: 99, entries: [['x|1|1', 'a'.repeat(40)]] }));
  const foreign = createHashCache(cacheFile);
  await foreign.load();
  assert.equal(foreign.size, 0);

  await fsp.writeFile(cacheFile, JSON.stringify({ version: 1, entries: [['k|1|1', 'b'.repeat(40)], ['bad', 'not-a-hash'], 'junk'] }));
  const valid = createHashCache(cacheFile);
  await valid.load();
  assert.equal(valid.size, 1);

  const cleared = createHashCache(cacheFile, { debounceMs: 5 });
  cleared.clear();
  await cleared.load();
  assert.equal(cleared.size, 0);
  await cleared.flush();
  assert.deepEqual(JSON.parse(await fsp.readFile(cacheFile, 'utf8')).entries, []);
});

test('scanDir hashing uses the default cache unless told otherwise', async () => {
  const { setDefaultHashCache, getDefaultHashCache } = require('../../src/main/scan');
  const root = await makeTree({ 'a.png': { fixture: 'png_rgb.png' } });
  const calls = [];
  const spy = {
    hashFile: async (abs, stat) => { calls.push([abs, stat.size]); return 'f'.repeat(40); },
    load: async () => {}, flush: async () => {}, clear: () => {}, size: 0,
  };
  setDefaultHashCache(spy);
  try {
    assert.equal(getDefaultHashCache(), spy);
    const viaDefault = await scanDir(root, { hash: true });
    assert.equal(viaDefault.images[0].hash, 'f'.repeat(40));
    assert.equal(calls.length, 1);
    const uncached = await scanDir(root, { hash: true, hashCache: false });
    assert.equal(uncached.images[0].hash, sha1(path.join(root, 'a.png')));
    assert.equal(calls.length, 1, 'hashCache:false bypasses every cache');
    await scanDir(root, { hash: false });
    assert.equal(calls.length, 1, 'no hashing unless asked');
  } finally {
    setDefaultHashCache(null);
  }
  const fresh = getDefaultHashCache();
  assert.notEqual(fresh, spy);
  assert.equal((await scanDir(root, { hash: true })).images[0].hash, sha1(path.join(root, 'a.png')));
  assert.equal(fresh.size, 1);
});

test('hash cache: an injected writer receives the snapshot (util.createJsonWriter compatible)', async () => {
  const root = await makeTree({ 'a.png': { fixture: 'png_rgb.png' } });
  const writes = [];
  let flushed = 0;
  const writer = { write: (obj) => writes.push(obj), flush: async () => { flushed += 1; } };
  const cache = createHashCache(path.join(root, 'unused.json'), { writer, debounceMs: 60000 });
  await cache.hashFile(path.join(root, 'a.png'));
  assert.equal(writes.length, 0, 'debounced');
  await cache.flush();
  assert.equal(writes.length, 1);
  assert.equal(flushed, 1);
  assert.equal(writes[0].version, 1);
  assert.equal(writes[0].entries.length, 1);
  assert.equal(fs.existsSync(path.join(root, 'unused.json')), false, 'the injected writer is used instead of the built-in one');
  const memoryOnly = createHashCache(null);
  assert.match(await memoryOnly.hashFile(path.join(root, 'a.png')), /^[0-9a-f]{40}$/);
  await memoryOnly.flush();
});
