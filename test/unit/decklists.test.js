'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const decklists = require('../../src/main/decklists');
const cards = require('../../src/main/cards');

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-decks-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDeps(t, { busy = null } = {}) {
  const ws = path.join(tmpDir(t), 'ws');
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output']) fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  const state = { busy };
  const deps = {
    getPaths: () => ({
      workspaceDir: ws,
      gameDir: (kind) => path.join(ws, 'game', kind),
      trashRoot: path.join(ws, 'game', '.trash'),
      outputDir: path.join(ws, 'game', 'output'),
    }),
    settings: { get: () => ({ cards: { back: { mode: 'auto', file: null } } }), update() {} },
    jobs: {
      isMutating: () => !!state.busy && ['setup', 'fetch', 'upscale', 'pdf', 'offset', 'calibration'].includes(state.busy.kind),
      active: () => state.busy,
    },
    emit() {},
  };
  return { deps, ws, dir: path.join(ws, 'game', 'decklist'), state };
}

test('sanitizeDeckName strips forbidden characters and rejects reserved names', () => {
  assert.equal(decklists.sanitizeDeckName('My <deck>: "v2"/final?*'), 'My deck v2final');
  assert.equal(decklists.sanitizeDeckName('  ..hidden deck...  '), 'hidden deck');
  assert.equal(decklists.sanitizeDeckName('tab\there\u0001'), 'tab here');
  assert.equal(decklists.sanitizeDeckName('Æther Vial deck'), 'Æther Vial deck');
  for (const reserved of ['CON', 'con', 'PRN.txt', 'aux.deck.txt', 'NUL', 'COM1', 'com9.ydk', 'LPT1', 'lpt9.txt', 'con .txt']) {
    assert.equal(decklists.sanitizeDeckName(reserved), '', reserved);
  }
  for (const ok of ['CONSOLE', 'com10', 'contest', 'Auxiliary deck', 'COM']) assert.equal(decklists.sanitizeDeckName(ok), ok);
  assert.equal(decklists.sanitizeDeckName(''), '');
  assert.equal(decklists.sanitizeDeckName(null), '');
  assert.equal(decklists.sanitizeDeckName('???'), '');
  const long = decklists.sanitizeDeckName('x'.repeat(150));
  assert.equal(long.length, 100);
  assert.equal(decklists.sanitizeDeckName(`${'a'.repeat(99)}. b`), 'a'.repeat(99), 'no trailing dot after truncation');
  assert.equal(decklists.sanitizeDeckName('éclair'), 'éclair', 'NFC');
});

test('deckFileName adds .txt unless the name already has a deck-list extension', () => {
  assert.equal(decklists.deckFileName('my-deck'), 'my-deck.txt');
  assert.equal(decklists.deckFileName('my-deck.txt'), 'my-deck.txt');
  assert.equal(decklists.deckFileName('main.ydk'), 'main.ydk');
  assert.equal(decklists.deckFileName('order.XML'), 'order.XML');
  assert.equal(decklists.deckFileName('v1.2 final'), 'v1.2 final.txt');
  assert.equal(decklists.deckFileName('deck.dec'), 'deck.dec.txt');
  assert.equal(decklists.deckFileName('deck.dec', { keepExtension: true }), 'deck.dec');
  assert.equal(decklists.deckFileName('CON'), '');
  assert.equal(decklists.deckFileName('.txt'), 'txt.txt');
});

test('decodeDeckBytes handles BOMs, UTF-16 without BOM, Windows-1252 and line ends', () => {
  const text = '4 Æther Vial\r\n2 Jötun Grunt\r1 Lim-Dûl\n';
  const expected = '4 Æther Vial\n2 Jötun Grunt\n1 Lim-Dûl\n';
  const utf8 = Buffer.from(text, 'utf8');
  assert.equal(decklists.decodeDeckBytes(utf8), expected);
  assert.equal(decklists.decodeDeckBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), utf8])), expected);
  const le = Buffer.from(text, 'utf16le');
  assert.equal(decklists.decodeDeckBytes(Buffer.concat([Buffer.from([0xff, 0xfe]), le])), expected);
  assert.equal(decklists.decodeDeckBytes(le), expected, 'UTF-16 LE without BOM');
  const be = Buffer.from(le);
  be.swap16();
  assert.equal(decklists.decodeDeckBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), expected);
  assert.equal(decklists.decodeDeckBytes(be), expected, 'UTF-16 BE without BOM');
  const utf32 = Buffer.alloc(4 + [...text].length * 4);
  utf32.set([0xff, 0xfe, 0, 0]);
  [...text].forEach((ch, i) => utf32.writeUInt32LE(ch.codePointAt(0), 4 + i * 4));
  assert.equal(decklists.decodeDeckBytes(utf32), expected, 'UTF-32 LE with BOM');
  const cp1252 = Buffer.from([0x34, 0x20, 0xc6, 0x74, 0x68, 0x65, 0x72, 0x0d, 0x0a, 0x31, 0x20, 0x93, 0x51, 0x94]); // 4 Æther\r\n1 “Q”
  assert.equal(decklists.decodeDeckBytes(cp1252), '4 Æther\n1 “Q”');
  assert.equal(decklists.decodeDeckBytes(new Uint8Array(0)), '');
  assert.equal(decklists.decodeDeckBytes(utf8.buffer.slice(utf8.byteOffset, utf8.byteOffset + utf8.length)), expected, 'ArrayBuffer');
  assert.throws(() => decklists.decodeDeckBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x01])), (err) => err.code === 'BAD_ENCODING' && /plain text/.test(err.message));
  assert.throws(() => decklists.decodeDeckBytes(42), TypeError);
});

test('isCanonicalDeckBytes is true only for UTF-8 without BOM and without CR', () => {
  assert.equal(decklists.isCanonicalDeckBytes(Buffer.from('1 Sol Ring\n2 Island\n')), true);
  assert.equal(decklists.isCanonicalDeckBytes(Buffer.from('\uFEFF1 Sol Ring\n')), false);
  assert.equal(decklists.isCanonicalDeckBytes(Buffer.from('1 Sol Ring\r\n')), false);
  assert.equal(decklists.isCanonicalDeckBytes(Buffer.from([0x31, 0x20, 0xc6, 0x0a])), false, 'cp1252 byte');
  assert.equal(decklists.isCanonicalDeckBytes(Buffer.from('1 Sol Ring\n', 'utf16le')), false);
});

test('listDecklists skips placeholders, folders and temporary files, in natural order', async (t) => {
  const { deps, dir } = makeDeps(t);
  for (const name of ['deck 10.txt', 'deck 2.txt', 'README.md', 'EMPTY.md', '.gitkeep', 'x.txt.123.4.tmp', 'Thumbs.db', 'main.ydk']) {
    fs.writeFileSync(path.join(dir, name), 'abc');
  }
  fs.mkdirSync(path.join(dir, 'folder'));
  const list = await decklists.listDecklists(deps);
  assert.deepEqual(list.map((d) => d.name), ['deck 2.txt', 'deck 10.txt', 'main.ydk']);
  assert.equal(list[0].size, 3);
  assert.ok(Number.isInteger(list[0].mtime) && list[0].mtime > 0);
  fs.rmSync(dir, { recursive: true });
  assert.deepEqual(await decklists.listDecklists(deps), [], 'missing folder');
});

test('readDecklist decodes any encoding; bad names and missing lists give plain errors', async (t) => {
  const { deps, dir } = makeDeps(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1 Sol Ring\r\n', 'utf16le')]));
  assert.equal(await decklists.readDecklist(deps, 'a.txt'), '1 Sol Ring\n');
  await assert.rejects(decklists.readDecklist(deps, 'nope.txt'), (err) => err.code === 'NOT_FOUND' && /no longer exists/.test(err.message));
  await assert.rejects(decklists.readDecklist(deps, '../x.txt'), (err) => err.code === 'BAD_NAME');
  await assert.rejects(decklists.readDecklist(deps, 'sub/x.txt'), (err) => err.code === 'BAD_NAME');
});

test('writeDecklist: UTF-8 without BOM and LF; identical content reused; keep-both; overwrite', async (t) => {
  const { deps, dir } = makeDeps(t);
  const first = await decklists.writeDecklist(deps, 'My Deck', '\uFEFF1 Sol Ring\r\n2 Island\r\n', { keepBoth: true });
  assert.equal(first.name, 'My Deck.txt');
  assert.equal(first.path, path.join(dir, 'My Deck.txt'));
  assert.deepEqual(fs.readFileSync(first.path), Buffer.from('1 Sol Ring\n2 Island\n', 'utf8'));
  const same = await decklists.writeDecklist(deps, 'My Deck', '1 Sol Ring\n2 Island\n');
  assert.equal(same.name, 'My Deck.txt');
  assert.equal(same.unchanged, true);
  const other = await decklists.writeDecklist(deps, 'My Deck.txt', '4 Forest\n');
  assert.equal(other.name, 'My Deck (2).txt');
  assert.equal(fs.readFileSync(path.join(dir, 'My Deck.txt'), 'utf8'), '1 Sol Ring\n2 Island\n', 'the first list is kept');
  const third = await decklists.writeDecklist(deps, 'My Deck', '5 Swamp\n');
  assert.equal(third.name, 'My Deck (3).txt');
  const over = await decklists.writeDecklist(deps, 'My Deck', '1 Mountain\n', { keepBoth: false });
  assert.equal(over.name, 'My Deck.txt');
  assert.equal(fs.readFileSync(over.path, 'utf8'), '1 Mountain\n');
  await assert.rejects(decklists.writeDecklist(deps, 'NUL.txt', 'x'), (err) => err.code === 'BAD_NAME' && /can't be used/.test(err.message));
  await assert.rejects(decklists.writeDecklist(deps, '  ', 'x'), (err) => err.code === 'BAD_NAME' && /Choose a name/.test(err.message));
});

test('writeDecklist never replaces an unreadable existing file', async (t) => {
  const { deps, dir } = makeDeps(t);
  fs.writeFileSync(path.join(dir, 'bin.txt'), Buffer.from([0, 1, 2, 3, 0, 0, 7]));
  const r = await decklists.writeDecklist(deps, 'bin', 'text', { keepBoth: false });
  assert.equal(r.name, 'bin (2).txt');
  assert.deepEqual([...fs.readFileSync(path.join(dir, 'bin.txt'))], [0, 1, 2, 3, 0, 0, 7]);
});

test('mutations refuse while a job that changes files runs', async (t) => {
  const { deps, dir, state } = makeDeps(t);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
  state.busy = { kind: 'pdf', title: 'Making the PDF' };
  await assert.rejects(decklists.writeDecklist(deps, 'b', 'x'), /^Error: BUSY: wait until "Making the PDF" finishes$/);
  await assert.rejects(decklists.removeDecklist(deps, 'a.txt'), (err) => err.code === 'BUSY');
  state.busy = { kind: 'samples', title: 'Making test cards' };
  await assert.rejects(decklists.writeDecklist(deps, 'b', 'x'), (err) => err.code === 'BUSY');
  state.busy = { kind: 'preview', title: 'Upscaling a preview' };
  assert.equal((await decklists.writeDecklist(deps, 'b', 'x')).name, 'b.txt', 'non-mutating jobs do not block');
  assert.deepEqual((await decklists.listDecklists(deps)).map((d) => d.name), ['a.txt', 'b.txt']);
});

test('removeDecklist moves the list to the trash; it can be restored', async (t) => {
  const { deps, dir, ws } = makeDeps(t);
  fs.writeFileSync(path.join(dir, 'gone.txt'), '1 Sol Ring\n');
  const { batchId } = await decklists.removeDecklist(deps, 'gone.txt');
  assert.match(batchId, /^\d{8}-\d{6}-decklist-1$/);
  assert.equal(fs.existsSync(path.join(dir, 'gone.txt')), false);
  assert.equal(fs.readFileSync(path.join(ws, 'game', '.trash', batchId, 'decklist', 'gone.txt'), 'utf8'), '1 Sol Ring\n');
  const batch = JSON.parse(fs.readFileSync(path.join(ws, 'game', '.trash', batchId, 'batch.json'), 'utf8'));
  assert.equal(batch.reason, 'decklist');
  assert.deepEqual(batch.items, [{ kind: 'decklist', rel: 'gone.txt' }]);
  const list = await cards.trashList(deps);
  assert.equal(list[0].label, 'Deleted deck list');
  assert.deepEqual(list[0].kinds, ['decklist']);
  fs.writeFileSync(path.join(dir, 'gone.txt'), 'new list\n');
  const restored = await cards.restoreBatch(deps, batchId);
  assert.equal(restored.restored, 1);
  assert.deepEqual(restored.renamed, [{ kind: 'decklist', from: 'gone.txt', to: 'gone (restored).txt' }]);
  assert.equal(fs.readFileSync(path.join(dir, 'gone (restored).txt'), 'utf8'), '1 Sol Ring\n');
  assert.equal(fs.readFileSync(path.join(dir, 'gone.txt'), 'utf8'), 'new list\n');
  await assert.rejects(decklists.removeDecklist(deps, 'nope.txt'), (err) => err.code === 'NOT_FOUND');
});

test('normalizeDeckFileInPlace rewrites only lists the plugins would misread', async (t) => {
  const { dir } = makeDeps(t);
  const bom = path.join(dir, 'bom.txt');
  fs.writeFileSync(bom, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1 Sol Ring\r\n')]));
  assert.equal(await decklists.normalizeDeckFileInPlace(bom), true);
  assert.deepEqual(fs.readFileSync(bom), Buffer.from('1 Sol Ring\n'));
  const clean = path.join(dir, 'clean.txt');
  fs.writeFileSync(clean, '1 Island\n');
  const before = fs.statSync(clean).mtimeMs;
  assert.equal(await decklists.normalizeDeckFileInPlace(clean), false);
  assert.equal(fs.statSync(clean).mtimeMs, before);
});

test('writeDecklist keeps the exact name of an existing list with an unknown extension', async (t) => {
  const { deps, dir } = makeDeps(t);
  fs.writeFileSync(path.join(dir, 'cube.dec'), '1 Island\n');
  const r = await decklists.writeDecklist(deps, 'cube.dec', '2 Island\r\n', { keepBoth: false });
  assert.equal(r.name, 'cube.dec');
  assert.equal(fs.readFileSync(path.join(dir, 'cube.dec'), 'utf8'), '2 Island\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['cube.dec']);
  // a NEW name with an unknown extension still becomes a .txt list
  const fresh = await decklists.writeDecklist(deps, 'Jund v1.5', '1 Forest\n');
  assert.equal(fresh.name, 'Jund v1.5.txt');
});
