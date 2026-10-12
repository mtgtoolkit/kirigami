'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ef = require('../../src/main/engine-files');

const COMMIT = '0da09b729814aa5aafde024b5a6059624fa87951';
const SOURCE = Object.freeze({
  repository: 'Alan-Cha/silhouette-card-maker',
  ref: 'refs/heads/main',
  commit: COMMIT,
  committedAt: '2026-10-12T15:55:38Z',
});

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-engine-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A manifest file entry for some content. */
function entry(p, content) {
  const data = Buffer.from(content);
  return { path: p, size: data.length, sha1: ef.sha1Hex(data), blob: ef.gitBlobSha1(data) };
}

const REQUIRED = ['create_pdf.py', 'offset_pdf.py', 'utilities.py', 'requirements.txt', 'assets/layouts.json'];
const requiredEntries = () => REQUIRED.map((p) => entry(p, `content of ${p}`));

test('isEngineFile: the shipped selection (root scripts, engine folders) and its exclusions', () => {
  for (const rel of [
    'create_pdf.py', 'clean_up.py', 'requirements.txt', 'LICENSE.md',
    'assets/layouts.json', 'assets/arial.ttf', 'assets/extra_layouts/README.md', 'assets/extra_layouts/nested/x.json',
    'plugins/mtg/fetch.py', 'plugins/mtg/deck_formats.py', 'calibration/a4-calibration.pdf',
    'cutting_templates/a4-standard-v5.studio3', 'cutting_templates/borderless/letter-bridge-v1.studio3',
    'cutting_templates/dxf', 'plugins/name with spaces/x.json',
  ]) assert.equal(ef.isEngineFile(rel), true, rel);
  for (const rel of [
    'README.md', 'pyproject.toml', 'AGENTS.md', '.gitignore', 'game/front/card.png', 'examples/ZERO SUMZ/a.png',
    'test/images/1_mtg.png', 'hugo/hugo.yaml', '.github/workflows/test.yaml', 'sub/create_pdf.py', 'Create_PDF.PY',
    'plugins/mtg/__pycache__/fetch.cpython-312.pyc', 'plugins/mtg/stale.pyc', 'plugins/mtg/old.pyo',
    'cutting_templates/a4/dxf/a4.dxf', 'cutting_templates/dxf/letter.dxf', 'assets/extra_layouts/mine.json',
    'assets/extra_layouts/MINE.JSON', 'assets/.DS_Store', 'assets/extra_layouts/.gitkeep', 'plugins/.git/config',
  ]) assert.equal(ef.isEngineFile(rel), false, rel);
});

test('isSafeRelativePath rejects anything that could leave the folder', () => {
  for (const rel of ['a.py', 'plugins/mtg/fetch.py', 'examples/ZERO SUMZ/a b.png', 'a..b/c']) assert.equal(ef.isSafeRelativePath(rel), true, rel);
  for (const rel of ['', '/abs.py', '../x.py', 'a/../b', './x.py', 'a/./b', 'a//b', 'a/', 'a\\b.py', 'C:x.py', 'x.py\u0000', 'a\nb', 42, null, 'a'.repeat(401)]) {
    assert.equal(ef.isSafeRelativePath(rel), false, JSON.stringify(rel));
    assert.equal(ef.isEngineFile(rel), false, JSON.stringify(rel));
  }
});

test('hashes: content SHA-1 and git blob SHA-1 (the value git trees list)', () => {
  assert.equal(ef.sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(ef.gitBlobSha1(Buffer.alloc(0)), 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'); // git hash-object /dev/null
  assert.equal(ef.gitBlobSha1(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(ef.gitBlobSha1(new Uint8Array([104, 101, 108, 108, 111, 10])), 'ce013625030ba8dba906f756967f9e9ca394464a');
  assert.equal(ef.isSha(COMMIT), true);
  assert.equal(ef.isSha(COMMIT.toUpperCase()), false);
  assert.equal(ef.isSha(COMMIT.slice(0, 7)), false);
});

test('normalizeRef: branch names become refs/heads/…, full refs are kept, bad refs are refused', () => {
  assert.equal(ef.normalizeRef('main'), 'refs/heads/main');
  assert.equal(ef.normalizeRef(' feature/x '), 'refs/heads/feature/x');
  assert.equal(ef.normalizeRef('refs/tags/v3.0.0'), 'refs/tags/v3.0.0');
  assert.equal(ef.normalizeRef('HEAD'), 'HEAD');
  for (const bad of ['', '   ', 'a b', 'refs/heads/../x', 'refs/heads/', 'main..x/..', 'x;rm', null]) {
    assert.throws(() => ef.normalizeRef(bad), TypeError, String(bad));
  }
});

test('engine.lock.json: parse, validate and serialize with a fixed key order', () => {
  const text = ef.serializeEngineLock({ committedAt: SOURCE.committedAt, commit: COMMIT, ref: SOURCE.ref, repository: SOURCE.repository, extra: 1 });
  assert.equal(text, `{\n  "repository": "Alan-Cha/silhouette-card-maker",\n  "ref": "refs/heads/main",\n  "commit": "${COMMIT}",\n  "committedAt": "2026-10-12T15:55:38Z"\n}\n`);
  assert.deepEqual(ef.parseEngineLock(text), SOURCE);
  assert.deepEqual(ef.parseEngineLock(`﻿${text.replace(/\n/g, '\r\n')}`), SOURCE, 'BOM and CRLF (git autocrlf) are fine');
  const bad = (patch) => JSON.stringify({ ...SOURCE, ...patch });
  for (const [what, json] of [
    ['not JSON', '{'],
    ['an array', '[]'],
    ['repository', bad({ repository: 'no-slash' })],
    ['ref', bad({ ref: 'main' })],
    ['commit', bad({ commit: COMMIT.slice(0, 7) })],
    ['commit', bad({ commit: COMMIT.toUpperCase() })],
    ['committedAt', bad({ committedAt: 'yesterday' })],
    ['committedAt', bad({ committedAt: '2026-13-45T99:00:00Z' })],
  ]) {
    assert.throws(() => ef.parseEngineLock(json), (err) => err.code === 'ENGINE_MANIFEST_INVALID', what);
  }
  assert.equal(ef.sameSource(SOURCE, { repository: 'alan-cha/Silhouette-Card-Maker', commit: COMMIT }), true);
  assert.equal(ef.sameSource(SOURCE, { ...SOURCE, commit: 'f'.repeat(40) }), false);
  assert.equal(ef.sameSource(SOURCE, null), false);
});

test('readEngineVersion reads create_pdf.py\'s click version option', () => {
  assert.equal(ef.readEngineVersion('@click.version_option("3.0.0")\ndef cli(): pass'), '3.0.0');
  assert.equal(ef.readEngineVersion(Buffer.from("@click.version_option( '3.1.0b2' , prog_name='x')")), '3.1.0b2');
  assert.equal(ef.readEngineVersion('def cli(): pass'), null);
  assert.equal(ef.readEngineVersion(null), null);
});

test('buildManifest: sorted files, totals, fixed key order; the text is the same whatever the input order', () => {
  const files = [entry('plugins/mtg/fetch.py', 'fetch'), ...requiredEntries(), entry('LICENSE.md', 'MIT')];
  const m = ef.buildManifest({ source: SOURCE, engineVersion: '3.0.0', files });
  assert.deepEqual(Object.keys(m), ['format', 'engineVersion', 'source', 'fileCount', 'totalBytes', 'files']);
  assert.equal(m.format, 2);
  assert.deepEqual(m.source, SOURCE);
  assert.equal(m.fileCount, 7);
  assert.equal(m.totalBytes, files.reduce((sum, f) => sum + f.size, 0));
  assert.deepEqual(m.files.map((f) => f.path), ['LICENSE.md', 'assets/layouts.json', 'create_pdf.py', 'offset_pdf.py', 'plugins/mtg/fetch.py', 'requirements.txt', 'utilities.py']);
  assert.deepEqual(Object.keys(m.files[0]), ['path', 'size', 'sha1', 'blob']);
  const text = ef.serializeManifest(m);
  assert.equal(ef.serializeManifest(ef.buildManifest({ source: SOURCE, engineVersion: '3.0.0', files: [...files].reverse() })), text);
  assert.ok(text.endsWith('}\n') && !/\r/.test(text));
  assert.deepEqual(ef.parseManifest(text), m);
  assert.equal(ef.buildManifest({ source: SOURCE, files: requiredEntries() }).engineVersion, null);
});

test('validateManifest refuses inconsistent or unsafe manifests', () => {
  const good = ef.buildManifest({ source: SOURCE, engineVersion: '3.0.0', files: requiredEntries() });
  const variants = {
    'format 1': { ...good, format: 1 },
    'empty version': { ...good, engineVersion: '' },
    'bad source': { ...good, source: { ...SOURCE, commit: 'x' } },
    'no files': { ...good, files: [], fileCount: 0, totalBytes: 0 },
    'unsorted': { ...good, files: [...good.files].reverse() },
    'duplicate': { ...good, files: [good.files[0], ...good.files], fileCount: 6, totalBytes: good.totalBytes + good.files[0].size },
    'fileCount': { ...good, fileCount: 4 },
    'totalBytes': { ...good, totalBytes: 1 },
    'unsafe path': { ...good, files: [{ ...good.files[0], path: '../evil.py' }, ...good.files.slice(1)] },
    'negative size': { ...good, files: [{ ...good.files[0], size: -1 }, ...good.files.slice(1)] },
    'bad blob': { ...good, files: [{ ...good.files[0], blob: 'nope' }, ...good.files.slice(1)] },
    'missing required file': { ...good, files: good.files.slice(1), fileCount: 4, totalBytes: good.totalBytes - good.files[0].size },
  };
  for (const [what, value] of Object.entries(variants)) {
    assert.throws(() => ef.validateManifest(value), (err) => err.code === 'ENGINE_MANIFEST_INVALID', what);
  }
  assert.throws(() => ef.parseManifest('not json'), (err) => err.code === 'ENGINE_MANIFEST_INVALID');
  assert.throws(() => ef.buildManifest({ source: SOURCE, files: null }), TypeError);
});

test('engineEntriesFromTree keeps regular engine blobs only, sorted by path', () => {
  const sha = (c) => c.repeat(40);
  const entries = ef.engineEntriesFromTree([
    { path: 'utilities.py', mode: '100644', type: 'blob', sha: sha('a'), size: 10 },
    { path: 'plugins', mode: '040000', type: 'tree', sha: sha('b') },
    { path: 'hugo/themes/hextra', mode: '160000', type: 'commit', sha: sha('c') },
    { path: 'plugins/link.py', mode: '120000', type: 'blob', sha: sha('d'), size: 8 },
    { path: 'README.md', mode: '100644', type: 'blob', sha: sha('e'), size: 5 },
    { path: 'create_pdf.py', mode: '100755', type: 'blob', sha: sha('f'), size: 0 },
    { path: 'cutting_templates/a4/dxf/a.dxf', mode: '100644', type: 'blob', sha: sha('1'), size: 3 },
  ]);
  assert.deepEqual(entries, [
    { path: 'create_pdf.py', size: 0, blob: sha('f') },
    { path: 'utilities.py', size: 10, blob: sha('a') },
  ]);
  assert.throws(() => ef.engineEntriesFromTree([{ path: 'create_pdf.py', type: 'blob', sha: sha('a') }]), (err) => err.code === 'ENGINE_MANIFEST_INVALID');
  assert.throws(() => ef.engineEntriesFromTree(null), TypeError);
});

test('diffEngineFiles: reuse identical blobs, download new or changed ones, list removals', () => {
  const current = [{ path: 'a.py', blob: '1'.repeat(40) }, { path: 'b.py', blob: '2'.repeat(40) }, { path: 'gone.py', blob: '3'.repeat(40) }];
  const next = [
    { path: 'a.py', size: 1, blob: '1'.repeat(40) },
    { path: 'b.py', size: 1, blob: '9'.repeat(40) },
    { path: 'new.py', size: 1, blob: '4'.repeat(40) },
  ];
  const diff = ef.diffEngineFiles(current, next);
  assert.deepEqual(diff.unchanged.map((e) => e.path), ['a.py']);
  assert.deepEqual(diff.download.map((e) => e.path), ['b.py', 'new.py']);
  assert.deepEqual(diff.removed, ['gone.py']);
  assert.deepEqual(ef.diffEngineFiles(null, next).download.length, 3);
});

test('collectEngineFiles, hashFile, readManifest and verifyEngineDir on a real folder', async (t) => {
  const dir = tmpDir(t);
  const contents = {
    'create_pdf.py': '@click.version_option("3.0.0")',
    'offset_pdf.py': 'offset',
    'utilities.py': 'utils',
    'requirements.txt': 'click==8.4.2\n',
    'assets/layouts.json': '{}',
    'plugins/mtg/fetch.py': 'fetch',
    'cutting_templates/a4-standard-v5.studio3': 'tpl',
  };
  for (const [rel, text] of Object.entries(contents)) write(path.join(dir, ...rel.split('/')), text);
  write(path.join(dir, 'README.md'), 'not shipped');
  write(path.join(dir, 'plugins', 'mtg', '__pycache__', 'fetch.cpython-312.pyc'), 'pyc');
  write(path.join(dir, 'cutting_templates', 'a4', 'dxf', 'a4.dxf'), 'dxf');
  write(path.join(dir, 'game', 'front', 'card.png'), 'png');

  const rels = await ef.collectEngineFiles(dir);
  assert.deepEqual(rels, Object.keys(contents).sort());
  assert.deepEqual(await ef.collectEngineFiles(path.join(dir, 'missing')), []);

  assert.equal(await ef.readManifest(dir), null, 'no manifest yet');
  const files = [];
  for (const rel of rels) files.push({ path: rel, ...(await ef.hashFile(path.join(dir, ...rel.split('/')))) });
  assert.deepEqual(files.find((f) => f.path === 'offset_pdf.py'), entry('offset_pdf.py', 'offset'));
  const manifest = ef.buildManifest({ source: SOURCE, engineVersion: '3.0.0', files });
  // A copy holds exactly the listed files (plus the manifest).
  const copy = path.join(dir, 'copy');
  for (const rel of rels) write(path.join(copy, ...rel.split('/')), contents[rel]);
  write(path.join(copy, ef.MANIFEST_NAME), ef.serializeManifest(manifest));
  assert.deepEqual(await ef.readManifest(copy), manifest);
  assert.deepEqual(await ef.verifyEngineDir(copy, manifest), { ok: true, missing: [], changed: [], extra: [] });

  write(path.join(copy, 'utilities.py'), 'UTILS'); // same size, other content
  assert.equal((await ef.verifyEngineDir(copy, manifest, { deep: false })).ok, true, 'a size check cannot see it');
  assert.deepEqual((await ef.verifyEngineDir(copy, manifest)).changed, ['utilities.py']);
  fs.rmSync(path.join(copy, 'offset_pdf.py'));
  write(path.join(copy, 'plugins', 'stray.txt'), 'x');
  const check = await ef.verifyEngineDir(copy, manifest);
  assert.deepEqual(check, { ok: false, missing: ['offset_pdf.py'], changed: ['utilities.py'], extra: ['plugins/stray.txt'] });

  write(path.join(copy, ef.MANIFEST_NAME), '{"format":2}');
  await assert.rejects(ef.readManifest(copy), (err) => err.code === 'ENGINE_MANIFEST_INVALID');
});

test('constants are frozen and the required files are part of the selection', () => {
  for (const list of [ef.ENGINE_DIRS, ef.ENGINE_ROOT_FILES, ef.REQUIRED_ENGINE_FILES]) assert.ok(Object.isFrozen(list));
  for (const rel of ef.REQUIRED_ENGINE_FILES) assert.equal(ef.isEngineFile(rel), true, rel);
  assert.deepEqual(ef.missingRequiredFiles(['create_pdf.py', 'utilities.py']), ['offset_pdf.py', 'requirements.txt', 'assets/layouts.json']);
  assert.equal(ef.MANIFEST_NAME, '.engine-manifest.json');
});
