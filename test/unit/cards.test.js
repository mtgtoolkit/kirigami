'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cards = require('../../src/main/cards');
const util = require('../../src/main/util');
const scan = require('../../src/main/scan');
const { decodePath } = require('../../src/main/img-url');
const { deepMerge, cloneValue, DEFAULT_SETTINGS } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');
const { createLocks } = require('../../src/main/locks');

const INTROSPECTION = require('../fixtures/introspection.json');
const JPEG = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'images', 'jpeg_baseline.jpg'));
const HEIC = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'images', 'heic_header.heic'));
const MUTATING = ['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration'];

function png(w = 4, h = 6, seed = 1) {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < rgba.length; i += 4) rgba.set([(seed * 53) % 256, (seed * 97) % 256, (seed * 29) % 256, 255], i);
  return util.encodePng(w, h, rgba);
}

function sha1(buf) {
  return crypto.createHash('sha1').update(buf).digest('hex');
}

function tmpDir(t, prefix = 'scm-cards-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function makeEnv(t, { settings = {}, jobs } = {}) {
  const root = tmpDir(t);
  const ws = path.join(root, 'ws');
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output']) fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  const state = { settings: deepMerge(DEFAULT_SETTINGS, settings), busy: null, openError: '' };
  const emitted = [];
  const opened = [];
  const deps = {
    getPaths: () => ({
      workspaceDir: ws,
      gameDir: (kind) => path.join(ws, 'game', kind),
      trashRoot: path.join(ws, 'game', '.trash'),
      outputDir: path.join(root, 'Documents', 'Silhouette Card Maker'),
      scmCacheDir: path.join(root, 'cache'),
      pythonPath: process.execPath,
      helperScript: path.join(root, 'scm_helper.py'),
    }),
    settings: {
      get: () => cloneValue(state.settings),
      update: (patch) => {
        state.settings = deepMerge(state.settings, patch);
        return cloneValue(state.settings);
      },
    },
    jobs: jobs || {
      isMutating: () => !!state.busy && MUTATING.includes(state.busy.kind),
      active: () => state.busy,
    },
    locks: createLocks(),
    emit: (channel, payload) => emitted.push({ channel, payload }),
    hashCache: scan.createHashCache(null),
    openPath: async (p) => {
      opened.push(p);
      return state.openError;
    },
    logger: { info() {}, warn() {}, error() {} },
  };
  const dir = (kind) => path.join(ws, 'game', kind);
  return { root, ws, deps, state, emitted, opened, dir };
}

const exists = (p) => fs.existsSync(p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------------------------
// Listing, warnings, summary
// ---------------------------------------------------------------------------------------------

test('listCards returns CardImages with partners, URLs, hashes and sizes; others and warnings', async (t) => {
  const { deps, dir } = makeEnv(t);
  const aBytes = png(4, 6, 1);
  write(path.join(dir('front'), 'a.png'), aBytes);
  write(path.join(dir('front'), 'c.jpg'), JPEG);
  write(path.join(dir('front'), 'sub', 'b.png'), png(5, 7, 2));
  write(path.join(dir('front'), 'notes.txt'), 'hello');
  write(path.join(dir('front'), 'README.md'), 'placeholder');
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  write(path.join(dir('double_sided'), 'orphan.png'), png(4, 6, 3));

  const list = await cards.listCards(deps, 'front');
  assert.equal(list.kind, 'front');
  assert.equal(list.dir, dir('front'));
  assert.deepEqual(list.images.map((i) => i.rel), ['a.png', 'c.jpg', 'sub/b.png']);
  const a = list.images[0];
  assert.deepEqual(
    { name: a.name, stem: a.stem, relNoExt: a.relNoExt, ext: a.ext, type: a.type, width: a.width, height: a.height, partner: a.partner, upscaled: a.upscaled },
    { name: 'a.png', stem: 'a', relNoExt: 'a', ext: 'png', type: 'png', width: 4, height: 6, partner: 'a.jpg', upscaled: false },
  );
  assert.equal(a.abs, path.join(dir('front'), 'a.png'));
  assert.equal(a.size, aBytes.length);
  assert.equal(a.hash, sha1(aBytes));
  assert.match(a.url, /^scm-img:\/\/file\/[A-Za-z0-9_-]+\?v=\d+$/);
  assert.equal(decodePath(a.url.slice('scm-img://file/'.length).split('?')[0]), a.abs);
  assert.equal(list.images[1].partner, null);
  assert.equal(list.images[2].relNoExt, 'sub/b');
  assert.deepEqual(list.others.map((o) => o.rel), ['notes.txt']);
  assert.equal(list.others[0].reason, 'Not an image the card maker can use');
  assert.deepEqual(list.warnings.map((w) => w.code), ['unsupported_file']);
  assert.deepEqual(list.warnings[0].files, ['notes.txt']);

  const ds = await cards.listCards(deps, 'double_sided');
  assert.deepEqual(ds.images.map((i) => [i.rel, i.partner]), [['a.jpg', 'a.png'], ['orphan.png', null]]);
  const orphan = ds.warnings.find((w) => w.code === 'ds_without_front');
  assert.deepEqual(orphan.files, ['orphan.png']);
  assert.match(orphan.message, /has no front with the same name/);
});

test('stem collisions are reported per exact-case stem across the whole tree', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'x', 'dup.png'), png(4, 6, 1));
  write(path.join(dir('front'), 'y', 'dup.jpg'), JPEG);
  write(path.join(dir('front'), 'z', 'Dup.png'), png(4, 6, 2));
  write(path.join(dir('front'), 'one.png'), png(4, 6, 3));
  const list = await cards.listCards(deps, 'front');
  const w = list.warnings.filter((x) => x.code === 'stem_collision');
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].files, ['x/dup.png', 'y/dup.jpg']);
  assert.equal(w[0].message, 'Two images share the name "dup" (x/dup.png and y/dup.jpg); only one would be printed.');
  const s = await cards.summary(deps);
  assert.equal(s.warnings.filter((x) => x.code === 'stem_collision').length, 1);
});

test('summary: counts, common back status, warnings and trash size', async (t) => {
  const { deps, dir, state } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('front'), 'b.png'), png(4, 6, 2));
  write(path.join(dir('double_sided'), 'a.png'), png(4, 6, 3));
  let s = await cards.summary(deps);
  assert.equal(s.front, 2);
  assert.equal(s.double_sided, 1);
  assert.equal(s.backCount, 0);
  assert.deepEqual(s.counts, { front: 2, back: 0, double_sided: 1 });
  assert.deepEqual(s.backs, []);
  assert.deepEqual(s.back, { mode: 'auto', file: null, effective: null, problem: null });
  assert.deepEqual(s.warnings, []);
  assert.equal(s.trashBatches, 0);

  write(path.join(dir('back'), 'blue.png'), png(4, 6, 4));
  s = await cards.summary(deps);
  assert.deepEqual(s.back, { mode: 'auto', file: null, effective: 'blue.png', problem: null });

  write(path.join(dir('back'), 'red.png'), png(4, 6, 5));
  s = await cards.summary(deps);
  assert.deepEqual(s.backs, ['blue.png', 'red.png']);
  assert.equal(s.back.problem, 'choose');
  assert.deepEqual(s.warnings.map((w) => w.code), ['multiple_backs']);

  const after = await cards.setBack(deps, { mode: 'file', file: 'red.png' });
  assert.deepEqual(after.back, { mode: 'file', file: 'red.png', effective: 'red.png', problem: null });
  assert.deepEqual(state.settings.cards.back, { mode: 'file', file: 'red.png' });
  assert.deepEqual(after.warnings, []);

  fs.rmSync(path.join(dir('back'), 'red.png'));
  s = await cards.summary(deps);
  assert.deepEqual(s.back, { mode: 'file', file: 'red.png', effective: null, problem: 'missing' });
  const resolved = await cards.resolveBack(deps);
  assert.equal(resolved.problem, 'missing');
  assert.equal(resolved.abs, null);

  await cards.setBack(deps, { mode: 'none' });
  s = await cards.summary(deps);
  assert.deepEqual(s.back, { mode: 'none', file: null, effective: null, problem: null });
  await cards.removeCards(deps, 'front', ['b.png']);
  assert.equal((await cards.summary(deps)).trashBatches, 1);
});

test('resolveBack / resolveBackFrom', async (t) => {
  const { deps, dir } = makeEnv(t);
  const imgs = [{ rel: 'a.png', abs: '/x/a.png' }, { rel: 'sub/B.png', abs: '/x/sub/B.png' }];
  assert.deepEqual(cards.resolveBackFrom({ mode: 'auto', file: null }, []), { mode: 'auto', file: null, abs: null, problem: null, effective: null, configuredFile: null });
  assert.equal(cards.resolveBackFrom({ mode: 'auto', file: null }, imgs).problem, 'choose');
  assert.equal(cards.resolveBackFrom({ mode: 'auto', file: null }, imgs.slice(0, 1)).abs, '/x/a.png');
  assert.equal(cards.resolveBackFrom({ mode: 'file', file: 'sub/B.png' }, imgs).effective, 'sub/B.png');
  assert.equal(cards.resolveBackFrom({ mode: 'file', file: 'gone.png' }, imgs).problem, 'missing');
  assert.equal(cards.resolveBackFrom({ mode: 'none', file: 'a.png' }, imgs).abs, null);
  write(path.join(dir('back'), 'only.png'), png());
  const r = await cards.resolveBack(deps);
  assert.equal(r.abs, path.join(dir('back'), 'only.png'));
  assert.equal(r.file, 'only.png');
  await assert.rejects(cards.setBack(deps, { mode: 'file', file: 'nope.png' }), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(cards.setBack(deps, { mode: 'weird' }), (err) => err.code === 'INVALID_ARGUMENT');
  await assert.rejects(cards.setBack(deps, { mode: 'file' }), (err) => err.code === 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------------------------
// Adding, duplicating, renaming
// ---------------------------------------------------------------------------------------------

test('addCards copies images with unique, safe names and reports what was skipped', async (t) => {
  const { deps, dir, root, state, emitted } = makeEnv(t);
  const src = path.join(root, 'incoming');
  write(path.join(src, 'My [card]*.png'.replace('*', '')), png(4, 6, 1));
  write(path.join(src, 'photo.jpeg'), JPEG);
  write(path.join(src, 'noext'), png(4, 6, 2));
  write(path.join(src, 'notes.txt'), 'x');
  write(path.join(src, 'phone.heic'), HEIC);
  write(path.join(src, 'folder', 'f1.png'), png(4, 6, 3));
  write(path.join(src, 'folder', 'deep', 'f2.png'), png(4, 6, 4));
  write(path.join(dir('front'), 'sub', 'photo.png'), png(4, 6, 5)); // stem taken deeper in the tree

  const r = await cards.addCards(deps, 'front', [
    path.join(src, 'My [card].png'), path.join(src, 'photo.jpeg'), path.join(src, 'noext'), path.join(src, 'notes.txt'),
    path.join(src, 'phone.heic'), '', path.join(src, 'missing.png'), path.join(src, 'folder'),
  ]);
  assert.deepEqual(r.added, ['My card.png', 'photo (2).jpeg', 'noext.png', 'f2.png', 'f1.png'].sort((x, y) => (r.added.indexOf(x) - r.added.indexOf(y))));
  assert.ok(r.added.includes('My card.png'));
  assert.ok(r.added.includes('photo (2).jpeg'), 'unique across the whole tree');
  assert.ok(r.added.includes('noext.png'), 'extension from the image type');
  assert.ok(r.added.includes('f1.png') && r.added.includes('f2.png'), 'folders are expanded');
  const reasons = Object.fromEntries(r.skipped.map((s) => [path.basename(s.path) || '(empty)', s.reason]));
  assert.equal(reasons['notes.txt'], 'Not an image the card maker can use');
  assert.match(reasons['phone.heic'], /HEIC photos are not supported/);
  assert.equal(reasons['(empty)'], 'Save the image to your computer first');
  assert.equal(reasons['missing.png'], 'File not found');
  assert.deepEqual(fs.readFileSync(path.join(dir('front'), 'My card.png')), png(4, 6, 1));
  assert.ok(exists(path.join(src, 'My [card].png')), 'the original is never moved');

  const again = await cards.addCards(deps, 'front', [path.join(src, 'My [card].png')]);
  assert.deepEqual(again.added, ['My card (2).png']);
  assert.ok(emitted.some((e) => e.channel === 'cards:changed' && e.payload.reason === 'add'));

  const back = await cards.addCards(deps, 'back', [path.join(src, 'folder', 'f1.png')]);
  assert.deepEqual(back.added, ['f1.png']);
  assert.deepEqual(state.settings.cards.back, { mode: 'file', file: 'f1.png' }, 'a single added back is selected');
  await assert.rejects(cards.addCards(deps, 'double_sided', []), (err) => err.code === 'INVALID_ARGUMENT');
});

test('duplicateCard copies a front and its unique back with the same new name', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  write(path.join(dir('front'), 'sub', 'b.png'), png(4, 6, 2));
  write(path.join(dir('double_sided'), 'a (2).png'), png(4, 6, 9)); // stem taken in the partner folder

  const r = await cards.duplicateCard(deps, 'front', 'a.png', 2);
  assert.deepEqual(r, { added: ['a (3).png', 'a (4).png'], partners: ['a (3).jpg', 'a (4).jpg'] });
  assert.deepEqual(fs.readFileSync(path.join(dir('double_sided'), 'a (3).jpg')), JPEG);
  const nested = await cards.duplicateCard(deps, 'front', 'sub/b.png');
  assert.deepEqual(nested, { added: ['sub/b (2).png'], partners: [] });
  const dsOnly = await cards.duplicateCard(deps, 'double_sided', 'a.jpg');
  assert.deepEqual(dsOnly.added, ['a (5).jpg']);
  await assert.rejects(cards.duplicateCard(deps, 'front', 'nope.png'), (err) => err.code === 'NOT_FOUND');
  const list = await cards.listCards(deps, 'front');
  assert.equal(list.images.find((i) => i.rel === 'a (3).png').partner, 'a (3).jpg');
});

test('fixCollisions renames all but the first of each stem group, with partners', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'x', 'dup.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'x', 'dup.png'), png(4, 6, 2));
  write(path.join(dir('front'), 'y', 'dup.png'), png(4, 6, 3));
  write(path.join(dir('double_sided'), 'y', 'dup.jpg'), JPEG);
  // same folder, two extensions sharing one unique back: the back stays with the first
  write(path.join(dir('front'), 'k.jpg'), JPEG);
  write(path.join(dir('front'), 'k.png'), png(4, 6, 4));
  write(path.join(dir('double_sided'), 'k.png'), png(4, 6, 5));

  const r = await cards.fixCollisions(deps, 'front');
  // groups in natural order of their first file: "k.jpg" < "x/dup.png"
  assert.deepEqual(r.renamed, [
    { kind: 'front', from: 'k.png', to: 'k (2).png' },
    { kind: 'front', from: 'y/dup.png', to: 'y/dup (2).png' },
    { kind: 'double_sided', from: 'y/dup.jpg', to: 'y/dup (2).jpg', partner: true },
  ]);
  const s = await cards.summary(deps);
  assert.deepEqual(s.warnings.filter((w) => w.code === 'stem_collision'), []);
  const ds = await cards.listCards(deps, 'double_sided');
  assert.deepEqual(ds.images.map((i) => [i.rel, i.partner]), [['k.png', 'k.jpg'], ['x/dup.png', 'x/dup.png'], ['y/dup (2).jpg', 'y/dup (2).png']]);
  assert.deepEqual((await cards.fixCollisions(deps, 'front')).renamed, []);
});

test('fixCollisions on unique backs also fixes the fronts (and the other way round)', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('double_sided'), 'p', 'z.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'q', 'z.png'), png(4, 6, 2));
  write(path.join(dir('front'), 'p', 'z.png'), png(4, 6, 3));
  write(path.join(dir('front'), 'q', 'z.jpg'), JPEG);
  const r = await cards.fixCollisions(deps, 'double_sided');
  assert.deepEqual(r.renamed, [
    { kind: 'double_sided', from: 'q/z.png', to: 'q/z (2).png' },
    { kind: 'front', from: 'q/z.jpg', to: 'q/z (2).jpg', partner: true },
  ]);
});

// ---------------------------------------------------------------------------------------------
// Removing, trash, restore
// ---------------------------------------------------------------------------------------------

test('removeCards moves a front and its unique back to one trash batch; restore puts both back', async (t) => {
  const { deps, dir, ws } = makeEnv(t);
  write(path.join(dir('front'), 'sub', 'a.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'sub', 'a.jpg'), JPEG);
  write(path.join(dir('front'), 'b.png'), png(4, 6, 2));
  const r = await cards.removeCards(deps, 'front', ['sub/a.png', 'missing.png']);
  assert.equal(r.removed, 2);
  assert.match(r.batchId, /^\d{8}-\d{6}-removed-1$/);
  assert.deepEqual(r.failed, []);
  assert.equal(exists(path.join(dir('front'), 'sub')), false, 'empty folders are removed');
  const batchDir = path.join(ws, 'game', '.trash', r.batchId);
  const batch = JSON.parse(fs.readFileSync(path.join(batchDir, 'batch.json'), 'utf8'));
  assert.equal(batch.reason, 'removed');
  assert.ok(!Number.isNaN(Date.parse(batch.at)));
  assert.deepEqual(batch.items, [{ kind: 'front', rel: 'sub/a.png' }, { kind: 'double_sided', rel: 'sub/a.jpg' }]);
  assert.ok(exists(path.join(batchDir, 'front', 'sub', 'a.png')));
  assert.ok(exists(path.join(batchDir, 'double_sided', 'sub', 'a.jpg')));

  const list = await cards.trashList(deps);
  assert.equal(list.length, 1);
  assert.deepEqual({ ...list[0], at: undefined }, {
    batchId: r.batchId, reason: 'removed', label: 'Removed cards', at: undefined, count: 2, kinds: ['front', 'double_sided'],
    counts: { front: 1, double_sided: 1 }, files: ['sub/a.png', 'sub/a.jpg'],
  });

  const restored = await cards.restoreBatch(deps, r.batchId);
  assert.deepEqual(restored, { restored: 2, renamed: [], failed: [], kinds: ['front', 'double_sided'] });
  assert.ok(exists(path.join(dir('front'), 'sub', 'a.png')));
  assert.ok(exists(path.join(dir('double_sided'), 'sub', 'a.jpg')));
  assert.equal(exists(batchDir), false);
  assert.deepEqual(await cards.trashList(deps), []);
  await assert.rejects(cards.restoreBatch(deps, r.batchId), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(cards.restoreBatch(deps, '../x'), (err) => err.code === 'INVALID_ARGUMENT');
});

test('removing one of two fronts that share a unique back keeps the back', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 's.jpg'), JPEG);
  write(path.join(dir('front'), 's.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 's.png'), png(4, 6, 2));
  const r = await cards.removeCards(deps, 'front', ['s.png']);
  assert.equal(r.removed, 1);
  assert.ok(exists(path.join(dir('double_sided'), 's.png')));
});

test('restore conflicts get " (restored)" and pairs keep the same new name', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  const { batchId } = await cards.removeCards(deps, 'front', ['a.png']);
  write(path.join(dir('front'), 'a.webp'), png(4, 6, 2)); // same name, other extension
  const r = await cards.restoreBatch(deps, batchId);
  assert.deepEqual(r.renamed, [
    { kind: 'front', from: 'a.png', to: 'a (restored).png' },
    { kind: 'double_sided', from: 'a.jpg', to: 'a (restored).jpg' },
  ]);
  const ds = await cards.listCards(deps, 'double_sided');
  assert.deepEqual(ds.images.map((i) => [i.rel, i.partner]), [['a (restored).jpg', 'a (restored).png']]);
});

test('removing the chosen common back resets to automatic; restoring it chooses it again', async (t) => {
  const { deps, dir, state } = makeEnv(t);
  write(path.join(dir('back'), 'one.png'), png(4, 6, 1));
  write(path.join(dir('back'), 'two.png'), png(4, 6, 2));
  await cards.setBack(deps, { mode: 'file', file: 'two.png' });
  const r = await cards.removeCards(deps, 'back', ['two.png']);
  assert.deepEqual(state.settings.cards.back, { mode: 'auto', file: null });
  assert.equal((await cards.summary(deps)).back.effective, 'one.png');
  await cards.restoreBatch(deps, r.batchId);
  assert.deepEqual(state.settings.cards.back, { mode: 'file', file: 'two.png' });
});

test('clearCards moves every file (also unusable ones) and can include unique backs', async (t) => {
  const { deps, dir, ws } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('front'), 'deep', 'b.png'), png(4, 6, 2));
  write(path.join(dir('front'), 'notes.txt'), 'x');
  write(path.join(dir('front'), 'README.md'), 'placeholder');
  write(path.join(dir('double_sided'), 'a.png'), png(4, 6, 3));
  const r = await cards.clearCards(deps, 'front', { includePartners: true });
  assert.equal(r.removed, 4);
  assert.match(r.batchId, /-cleared-1$/);
  assert.deepEqual(fs.readdirSync(dir('front')), ['README.md']);
  assert.deepEqual(fs.readdirSync(dir('double_sided')), []);
  assert.equal((await cards.trashList(deps))[0].label, 'Removed all cards');
  const none = await cards.clearCards(deps, 'front');
  assert.deepEqual(none, { removed: 0, batchId: null, failed: [] });
  assert.equal(fs.readdirSync(path.join(ws, 'game', '.trash')).length, 1, 'no empty batch folder');
});

test('setPartnerBack copies to double_sided/<front relNoExt>.<ext>; the old back goes to the trash', async (t) => {
  const { deps, dir, root } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('front'), 'sub', 'b.jpg'), JPEG);
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  const newBack = write(path.join(root, 'in', 'New Back.PNG'), png(4, 6, 7));
  const r = await cards.setPartnerBack(deps, 'a.png', newBack);
  assert.equal(r.rel, 'a.png');
  assert.match(r.replacedBatchId, /-replaced-1$/);
  assert.deepEqual(fs.readdirSync(dir('double_sided')), ['a.png']);
  assert.deepEqual(fs.readFileSync(path.join(dir('double_sided'), 'a.png')), png(4, 6, 7));
  assert.ok(exists(newBack), 'the chosen file is copied, not moved');
  const nested = await cards.setPartnerBack(deps, 'sub/b.jpg', newBack);
  assert.deepEqual(nested, { rel: 'sub/b.png', replacedBatchId: null });
  const same = await cards.setPartnerBack(deps, 'a.png', path.join(dir('double_sided'), 'a.png'));
  assert.deepEqual(same, { rel: 'a.png', replacedBatchId: null });
  const txt = write(path.join(root, 'in', 'x.txt'), 'nope');
  await assert.rejects(cards.setPartnerBack(deps, 'a.png', txt), (err) => err.code === 'NOT_AN_IMAGE');
  await assert.rejects(cards.setPartnerBack(deps, 'gone.png', newBack), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(cards.setPartnerBack(deps, 'a.png', path.join(root, 'nope.png')), (err) => err.code === 'NOT_FOUND');
  assert.equal(fs.readdirSync(dir('double_sided')).filter((n) => n.endsWith('.tmp')).length, 0);
});

test('removePartnerBack moves the unique back to the trash', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  const r = await cards.removePartnerBack(deps, 'a.png');
  assert.equal(r.removed, 1);
  assert.match(r.batchId, /-removed-1$/);
  assert.equal(exists(path.join(dir('double_sided'), 'a.jpg')), false);
  assert.deepEqual(await cards.removePartnerBack(deps, 'a.png'), { batchId: null, removed: 0 });
});

test('trash: newest first, rebuilt without batch.json, pruned after 14 days, emptied', async (t) => {
  const { deps, dir, ws } = makeEnv(t);
  const trash = path.join(ws, 'game', '.trash');
  write(path.join(trash, '20200101-101010-removed-1', 'front', 'old.png'), png());
  write(path.join(trash, '20200101-101010-removed-1', 'batch.json'), JSON.stringify({ reason: 'removed', at: '2020-01-01T10:10:10.000Z', items: [{ kind: 'front', rel: 'old.png' }] }));
  const recent = new Date(Date.now() - 60 * 1000);
  const id = `${util.timestampId(recent)}-cleared-1`;
  write(path.join(trash, id, 'front', 'x', 'kept.png'), png());
  write(path.join(trash, id, 'double_sided', 'kept.png'), png());
  write(path.join(dir('front'), 'new.png'), png(4, 6, 3));
  const { batchId } = await cards.removeCards(deps, 'front', ['new.png']);
  const list = await cards.trashList(deps);
  assert.deepEqual(list.map((b) => b.batchId), [batchId, id], 'old batch pruned, newest first');
  assert.equal(list[1].reason, 'cleared', 'reason from the folder name');
  assert.deepEqual(list[1].counts, { front: 1, double_sided: 1 });
  assert.equal(exists(path.join(trash, '20200101-101010-removed-1')), false);
  const restored = await cards.restoreBatch(deps, id);
  assert.equal(restored.restored, 2);
  assert.ok(exists(path.join(dir('front'), 'x', 'kept.png')));

  write(path.join(dir('front'), 'z.png'), png(4, 6, 4));
  await cards.removeCards(deps, 'front', ['z.png']);
  const emptied = await cards.emptyTrash(deps);
  assert.deepEqual(emptied, { removed: 2, batches: 2 });
  assert.deepEqual(await cards.trashList(deps), []);
  assert.equal(await cards.pruneTrash(deps), 0);
});

test('moveToTrash (no BUSY check) for any trash kind; nothing to move gives null', async (t) => {
  const { deps, dir, state } = makeEnv(t);
  write(path.join(dir('decklist'), 'deck.txt'), '1 Sol Ring');
  state.busy = { kind: 'fetch', title: 'Downloading cards' };
  const id = await cards.moveToTrash(deps, [{ kind: 'decklist', rel: 'deck.txt' }], 'Before Download!');
  assert.match(id, /-before-download-1$/);
  assert.equal(await cards.moveToTrash(deps, [{ kind: 'front', rel: 'none.png' }], 'removed'), null);
  assert.equal(await cards.moveToTrash(deps, [], 'removed'), null);
  await assert.rejects(cards.moveToTrash(deps, [{ kind: 'front', rel: '../escape.png' }], 'removed'), (err) => err.code === 'INVALID_PATH');
});

test('every user-facing mutation refuses while a job that changes files runs', async (t) => {
  const { deps, dir, root, state } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png());
  for (const busy of [{ kind: 'pdf', title: 'Making the PDF' }, { kind: 'samples', title: 'Making test cards' }]) {
    state.busy = busy;
    const isBusy = (err) => err.code === 'BUSY' && err.message === `BUSY: wait until "${busy.title}" finishes`;
    await assert.rejects(cards.addCards(deps, 'front', [path.join(root, 'x.png')]), isBusy);
    await assert.rejects(cards.removeCards(deps, 'front', ['a.png']), isBusy);
    await assert.rejects(cards.clearCards(deps, 'front'), isBusy);
    await assert.rejects(cards.duplicateCard(deps, 'front', 'a.png'), isBusy);
    await assert.rejects(cards.fixCollisions(deps, 'front'), isBusy);
    await assert.rejects(cards.setBack(deps, { mode: 'none' }), isBusy);
    await assert.rejects(cards.setPartnerBack(deps, 'a.png', path.join(root, 'x.png')), isBusy);
    await assert.rejects(cards.removePartnerBack(deps, 'a.png'), isBusy);
    await assert.rejects(cards.restoreBatch(deps, 'x'), isBusy);
    await assert.rejects(cards.emptyTrash(deps), isBusy);
  }
  state.busy = { kind: 'preview', title: 'Upscaling a preview' };
  assert.equal((await cards.duplicateCard(deps, 'front', 'a.png')).added.length, 1, 'read-only jobs do not block');
  assert.equal((await cards.listCards(deps, 'front')).images.length, 2, 'listing is always allowed');
});

test('openFolder opens the folder (creating it) and reports failures in plain words', async (t) => {
  const { deps, dir, opened, state } = makeEnv(t);
  assert.equal(await cards.openFolder(deps, 'front'), true);
  assert.equal(opened[0], dir('front'));
  const out = deps.getPaths().outputDir;
  assert.equal(exists(out), false);
  await cards.openFolder(deps, 'output');
  assert.equal(opened[1], out);
  assert.ok(exists(out));
  await cards.openFolder(deps, 'decklist');
  assert.equal(opened[2], dir('decklist'));
  state.openError = 'No application is associated';
  await assert.rejects(cards.openFolder(deps, 'back'), (err) => err.code === 'OPEN_FAILED' && /No application is associated/.test(err.message));
  await assert.rejects(cards.openFolder(deps, 'upscaled'), (err) => err.code === 'INVALID_ARGUMENT');
});

// ---------------------------------------------------------------------------------------------
// Watcher and notifications
// ---------------------------------------------------------------------------------------------

function fakeWatchFactory() {
  const watchers = [];
  const watch = (dir, opts, listener) => {
    const w = new EventEmitter();
    Object.assign(w, { dir, opts, listener, closed: false, close() { this.closed = true; } });
    watchers.push(w);
    return w;
  };
  return { watch, watchers };
}

test('startWatching throttles events, pauses during jobs and emits once on resume', async (t) => {
  const { deps, dir, emitted } = makeEnv(t);
  const { watch, watchers } = fakeWatchFactory();
  const w = cards.startWatching(deps, { watch, throttleMs: 60, maxBackoffMs: 30 });
  t.after(() => w.stop());
  assert.deepEqual(watchers.map((x) => x.dir), [dir('front'), dir('back'), dir('double_sided')]);
  assert.deepEqual(watchers[0].opts, { recursive: true, persistent: false });
  const events = () => emitted.filter((e) => e.channel === 'cards:changed').map((e) => e.payload);

  watchers[0].listener('change', 'a.png');
  assert.deepEqual(events(), [{ reason: 'watch', kinds: ['front'] }], 'leading emit');
  watchers[1].listener('rename', 'b.png');
  watchers[0].listener('rename', 'c.png');
  assert.equal(events().length, 1, 'throttled');
  await sleep(110);
  assert.deepEqual(events()[1], { reason: 'watch', kinds: ['back', 'front'] }, 'one trailing emit');

  w.pause();
  assert.equal(w.paused, true);
  watchers[2].listener('change', 'x.png');
  w.notify({ reason: 'remove', kinds: ['double_sided'] });
  await sleep(100);
  assert.equal(events().length, 2, 'nothing while paused');
  w.resume();
  assert.deepEqual(events()[2], { reason: 'job', kinds: ['double_sided'] });

  await sleep(80);
  w.notify({ reason: 'add', kinds: ['back'] });
  assert.deepEqual(events()[3], { reason: 'add', kinds: ['back'] });

  // a watcher error closes it and re-arms after a backoff
  const first = watchers[1];
  first.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
  assert.equal(first.closed, true);
  await sleep(150);
  assert.equal(watchers.length, 4);
  assert.equal(watchers[3].dir, dir('back'));
  assert.deepEqual(w.watching, ['front', 'back', 'double_sided']);
  assert.ok(events().some((e) => e.kinds.includes('back') && e.reason === 'watch'), 're-armed watcher reports possible changes');

  w.stop();
  const count = events().length;
  watchers[0].listener('change', 'late.png');
  w.notify({ reason: 'add' });
  await sleep(80);
  assert.equal(events().length, count, 'no events after stop');
  assert.ok(watchers.every((x) => x.closed || x === watchers[1]));
});

test('startWatching retries a folder that cannot be watched yet', async (t) => {
  const { deps } = makeEnv(t);
  let calls = 0;
  const watch = (d, opts, listener) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    const w = new EventEmitter();
    w.close = () => {};
    w.listener = listener;
    return w;
  };
  const w = cards.startWatching(deps, { watch, throttleMs: 10, maxBackoffMs: 20 });
  t.after(() => w.stop());
  await sleep(120);
  assert.ok(calls >= 4, `watch called ${calls} times`);
  assert.equal(w.watching.length, 3);
});

test('startWatching with the real fs.watch reports a new file', async (t) => {
  const { deps, dir, emitted } = makeEnv(t);
  const w = cards.startWatching(deps, { throttleMs: 50 });
  t.after(() => w.stop());
  await sleep(150);
  write(path.join(dir('front'), 'deep', 'new.png'), png());
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !emitted.some((e) => e.channel === 'cards:changed' && e.payload.kinds.includes('front'))) await sleep(50);
  assert.ok(emitted.some((e) => e.channel === 'cards:changed' && e.payload.kinds.includes('front')));
});

test('notifyChanged goes through the watcher when one runs, else emits directly', () => {
  const sent = [];
  const notified = [];
  cards.notifyChanged({ emit: (c, p) => sent.push([c, p]) }, { reason: 'add', kinds: ['front'] });
  assert.deepEqual(sent, [['cards:changed', { reason: 'add', kinds: ['front'] }]]);
  cards.notifyChanged({ emit: (c, p) => sent.push([c, p]), watcher: { notify: (p) => notified.push(p) } }, { reason: 'x' });
  assert.deepEqual(notified, [{ reason: 'x' }]);
  assert.equal(sent.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Test cards job
// ---------------------------------------------------------------------------------------------

/** A stand-in for `python scm_helper.py make-test-cards` (writes PNGs and the --out JSON). */
function writeFakeHelper(root) {
  const file = path.join(root, 'fake-helper.js');
  fs.writeFileSync(file, `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
const opt = (n) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : null; };
const out = opt('--out');
if (process.env.FAKE_HELPER_FAIL) {
  fs.writeFileSync(out, JSON.stringify({ error: 'HelperError: broken on purpose', type: 'HelperError', message: 'broken on purpose', traceback: 'Traceback (most recent call last):\\nHelperError: broken on purpose' }));
  process.stderr.write('HelperError: broken on purpose\\n');
  process.exit(1);
}
const png = Buffer.from(${JSON.stringify(png(3, 4, 9).toString('base64'))}, 'base64');
const dir = opt('--dir'); const backDir = opt('--back-dir');
fs.mkdirSync(dir, { recursive: true });
const files = [];
for (let i = 1; i <= Number(opt('--count')); i++) { const f = path.join(dir, 'Test card 0' + i + '.png'); fs.writeFileSync(f, png); files.push(f); }
let back = null;
if (backDir) { fs.mkdirSync(backDir, { recursive: true }); back = path.join(backDir, 'Test back.png'); fs.writeFileSync(back, png); }
fs.writeFileSync(out, JSON.stringify({ files, back, width: Number(opt('--width-px')), height: Number(opt('--height-px')), count: files.length, label: opt('--label'), args: a }));
`);
  return file;
}

function makeJobEnv(t, settings = {}) {
  const root0 = tmpDir(t, 'scm-samples-');
  const fakeHelper = writeFakeHelper(root0);
  const spawned = [];
  const jobs = new JobManager({
    logsDir: null,
    scmCacheDir: path.join(root0, 'cache'),
    spawnImpl: (cmd, args, opts) => {
      if (/taskkill/i.test(cmd)) return childProcess.spawn(cmd, args, opts);
      spawned.push({ cmd, args, cwd: opts.cwd });
      return childProcess.spawn(process.execPath, [fakeHelper, ...args.slice(1)], opts);
    },
  });
  const env = makeEnv(t, { settings, jobs });
  const basePaths = env.deps.getPaths;
  env.deps.getPaths = () => ({ ...basePaths(), helperScript: fakeHelper });
  env.deps.helper = { introspect: async () => INTROSPECTION };
  return { ...env, jobs, spawned };
}

test('startSamplesJob (replace) sets current cards aside and adds test cards at the current card size', async (t) => {
  const { deps, dir, jobs, spawned, state, ws } = makeJobEnv(t, { pdf: { options: { card_size: 'japanese' } } });
  write(path.join(dir('front'), 'mine.png'), png());
  write(path.join(dir('double_sided'), 'mine.png'), png(4, 6, 2));
  write(path.join(dir('back'), 'myback.png'), png(4, 6, 3));
  state.settings = deepMerge(state.settings, { cards: { back: { mode: 'file', file: 'myback.png' } } });
  const jobId = cards.startSamplesJob(deps, { replace: true });
  const done = await jobs.whenFinished(jobId);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const r = done.result;
  assert.equal(r.added, 9);
  assert.deepEqual(r.front, Array.from({ length: 9 }, (_, i) => `Test card 0${i + 1}.png`));
  assert.equal(r.back, 'Test back.png');
  assert.match(r.previousBatchId, /-before-samples-1$/);
  assert.deepEqual([r.cardSize, r.widthMm, r.heightMm, r.widthPx, r.heightPx], ['japanese', 59, 86, 697, 1016]);
  assert.deepEqual(fs.readdirSync(dir('front')).sort(), r.front);
  assert.deepEqual(fs.readdirSync(dir('double_sided')), []);
  assert.deepEqual(fs.readdirSync(dir('back')), ['Test back.png']);
  assert.deepEqual(state.settings.cards.back, { mode: 'auto', file: null });
  const args = spawned[0].args;
  assert.equal(args[1], 'make-test-cards');
  assert.equal(spawned[0].cwd, ws);
  assert.deepEqual(args.slice(args.indexOf('--width-px'), args.indexOf('--width-px') + 4), ['--width-px', '697', '--height-px', '1016']);
  assert.equal(args[args.indexOf('--label') + 1], 'Japanese · 59 x 86 mm');
  const trash = await cards.trashList(deps);
  assert.equal(trash[0].counts.front, 1);
  assert.equal(trash[0].counts.back, 1);
  // restoring the set-aside cards brings the chosen back setting along only if still automatic
  await cards.restoreBatch(deps, r.previousBatchId);
  assert.ok(exists(path.join(dir('front'), 'mine.png')));
});

test('startSamplesJob without replace keeps an existing common back and never overwrites names', async (t) => {
  const { deps, dir, jobs, state } = makeJobEnv(t);
  write(path.join(dir('front'), 'Test card 01.png'), png(4, 6, 5));
  write(path.join(dir('back'), 'myback.png'), png(4, 6, 3));
  const done = await jobs.whenFinished(cards.startSamplesJob(deps, {}));
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.back, null);
  assert.equal(done.result.previousBatchId, null);
  assert.equal(done.result.front[0], 'Test card 01 (2).png');
  assert.deepEqual(fs.readFileSync(path.join(dir('front'), 'Test card 01.png')), png(4, 6, 5));
  assert.deepEqual(fs.readdirSync(dir('back')), ['myback.png']);
  assert.deepEqual(state.settings.cards.back, { mode: 'auto', file: null });
  assert.deepEqual([done.result.cardSize, done.result.widthPx, done.result.heightPx], ['standard', 744, 1039]);
});

test('startSamplesJob failure puts the previous cards back', async (t) => {
  const { deps, dir, jobs } = makeJobEnv(t);
  write(path.join(dir('front'), 'mine.png'), png());
  process.env.FAKE_HELPER_FAIL = '1';
  t.after(() => { delete process.env.FAKE_HELPER_FAIL; });
  const done = await jobs.whenFinished(cards.startSamplesJob(deps, { replace: true }));
  delete process.env.FAKE_HELPER_FAIL;
  assert.equal(done.status, 'failed');
  assert.match(done.error.message, /broken on purpose/);
  assert.deepEqual(done.warnings, ['Your previous cards were put back.']);
  assert.deepEqual(fs.readdirSync(dir('front')), ['mine.png']);
  assert.deepEqual(await cards.trashList(deps), []);
});

test('startSamplesJob refuses while another job runs', async (t) => {
  const { deps, jobs } = makeJobEnv(t);
  const id = jobs.start('pdf', { title: 'Making the PDF' }, () => sleep(200));
  assert.throws(() => cards.startSamplesJob(deps, {}), /^Error: BUSY: Making the PDF$/);
  await jobs.whenFinished(id);
});

test('currentCardSize falls back to the built-in table when the engine description is unavailable', async (t) => {
  const { deps, state } = makeEnv(t, { settings: { pdf: { options: { card_size: 'mini_euro' } } } });
  deps.helper = { introspect: async () => { throw new Error('NOT_READY'); } };
  assert.deepEqual(await cards.currentCardSize(deps), { name: 'euro_mini', widthMm: 44, heightMm: 68 });
  state.settings.pdf.options.card_size = 'business';
  deps.helper = { introspect: async () => INTROSPECTION };
  assert.deepEqual(await cards.currentCardSize(deps), { name: 'business', widthMm: 88.9, heightMm: 50.8 });
  state.settings.pdf.options.card_size = 'no_such_size';
  assert.deepEqual(await cards.currentCardSize(deps), { name: 'standard', widthMm: 63, heightMm: 88 });
});

test('removeCards reports files that are no longer there instead of pretending to remove them', async (t) => {
  const { deps, dir, emitted } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png());
  await assert.rejects(cards.removeCards(deps, 'front', ['gone.png']), (err) => err.code === 'NOT_FOUND' && /This card is no longer in its folder/.test(err.message));
  await assert.rejects(cards.removeCards(deps, 'front', ['x.png', 'y.png']), (err) => err.code === 'NOT_FOUND' && /These cards are no longer in their folder/.test(err.message));
  // one of two still exists: it is removed, the missing one is ignored
  const r = await cards.removeCards(deps, 'front', ['gone.png', 'a.png']);
  assert.equal(r.removed, 1);
  assert.ok(r.batchId);
  assert.deepEqual(await cards.removeCards(deps, 'front', []), { removed: 0, batchId: null, failed: [] });
  assert.ok(emitted.some((e) => e.channel === 'cards:changed' && e.payload.reason === 'remove'));
});

test('startSamplesJob explains a missing helper script in plain words (nothing is set aside)', async (t) => {
  const { deps, dir, jobs } = makeJobEnv(t);
  write(path.join(dir('front'), 'mine.png'), png());
  const basePaths = deps.getPaths;
  deps.getPaths = () => ({ ...basePaths(), helperScript: path.join(os.tmpdir(), 'scm-no-such-dir', 'scm_helper.py') });
  const done = await jobs.whenFinished(cards.startSamplesJob(deps, { replace: true }));
  assert.equal(done.status, 'failed');
  assert.equal(done.error.code, 'HELPER_MISSING');
  assert.match(done.error.message, /Please reinstall the app/);
  assert.deepEqual(fs.readdirSync(dir('front')), ['mine.png']);
  assert.deepEqual(await cards.trashList(deps), []);
  assert.deepEqual(done.warnings, [], 'checked before anything was set aside');
});

test('restoring never creates two cards with the same name in different sub-folders', async (t) => {
  const { deps, dir } = makeEnv(t);
  write(path.join(dir('front'), 'a.png'), png(4, 6, 1));
  write(path.join(dir('double_sided'), 'a.jpg'), JPEG);
  const { batchId } = await cards.removeCards(deps, 'front', ['a.png']);
  write(path.join(dir('front'), 'sub', 'a.png'), png(4, 6, 2)); // added meanwhile, same name elsewhere
  const r = await cards.restoreBatch(deps, batchId);
  assert.equal(r.restored, 2);
  assert.deepEqual(r.renamed, [
    { kind: 'front', from: 'a.png', to: 'a (restored).png' },
    { kind: 'double_sided', from: 'a.jpg', to: 'a (restored).jpg' },
  ]);
  const s = await cards.summary(deps);
  assert.deepEqual(s.warnings.filter((w) => w.code === 'stem_collision'), []);
  const fronts = await cards.listCards(deps, 'front');
  assert.equal(fronts.images.find((i) => i.rel === 'a (restored).png').partner, 'a (restored).jpg');
});
