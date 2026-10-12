'use strict';

// scripts/check-package.mjs is what stands between a build and a release: CI and the release workflow run
// it on every installer. These tests pin down the pure parts (reading electron-builder's YAML, the installer
// name, the feed and update-config checks); the file checks themselves run in CI on a real build.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'check-package.mjs')).href;
const PACKAGE = require('../../package.json');

/** latest.yml as electron-builder 26.17.0 writes it for Kirigami 1.0.0. */
const LATEST_YML = [
  'version: 1.0.0',
  'files:',
  '  - url: Kirigami-Setup-1.0.0.exe',
  '    sha512: yENTvN/JRTE7I/GczolKIrETE+/xw7jpRmZzdXWkn8PuM/0/hyKsxP0cspFAbHz+smDBtyN3Jdj9jmY9a+KE9Q==',
  '    size: 158444861',
  'path: Kirigami-Setup-1.0.0.exe',
  'sha512: yENTvN/JRTE7I/GczolKIrETE+/xw7jpRmZzdXWkn8PuM/0/hyKsxP0cspFAbHz+smDBtyN3Jdj9jmY9a+KE9Q==',
  "releaseDate: '2026-10-12T19:52:38.578Z'",
  '',
].join('\n');

/** resources/app-update.yml of that build. */
const APP_UPDATE_YML = 'owner: mtgtoolkit\nrepo: kirigami\nprovider: github\nreleaseType: draft\nupdaterCacheDirName: kirigami-updater\n';

const load = () => import(SCRIPT);

test('readYamlScalars: top-level values of latest.yml and app-update.yml, quotes removed, nested lines skipped', async () => {
  const { readYamlScalars } = await load();
  const feed = readYamlScalars(LATEST_YML);
  assert.deepEqual(feed, {
    version: '1.0.0',
    path: 'Kirigami-Setup-1.0.0.exe',
    sha512: 'yENTvN/JRTE7I/GczolKIrETE+/xw7jpRmZzdXWkn8PuM/0/hyKsxP0cspFAbHz+smDBtyN3Jdj9jmY9a+KE9Q==',
    releaseDate: '2026-10-12T19:52:38.578Z',
  });
  assert.deepEqual(readYamlScalars(APP_UPDATE_YML.replace(/\n/g, '\r\n')), {
    owner: 'mtgtoolkit',
    repo: 'kirigami',
    provider: 'github',
    releaseType: 'draft',
    updaterCacheDirName: 'kirigami-updater',
  });
  assert.deepEqual(readYamlScalars('﻿a: "x \\"y\\""\nb: \'it\'\'s\'\nc: # comment\n# d: no\n  e: nested\n'), { a: 'x "y"', b: "it's" });
  assert.deepEqual(readYamlScalars(''), {});
});

test('githubSlug: package.json repository forms and owner/name strings', async () => {
  const { githubSlug } = await load();
  assert.equal(githubSlug({ type: 'git', url: 'https://github.com/mtgtoolkit/kirigami.git' }), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('git+https://github.com/mtgtoolkit/kirigami.git'), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('git@github.com:mtgtoolkit/kirigami.git'), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('https://github.com/mtgtoolkit/kirigami/'), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('github:mtgtoolkit/kirigami'), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('mtgtoolkit/kirigami'), 'mtgtoolkit/kirigami');
  assert.equal(githubSlug('https://gitlab.com/mtgtoolkit/kirigami'), null);
  assert.equal(githubSlug('kirigami'), null);
  assert.equal(githubSlug(undefined), null);
  assert.equal(githubSlug({}), null);
});

test('installerFileName: Kirigami-Setup-<version>.exe from package.json, the name the release and latest.yml use', async () => {
  const { installerFileName } = await load();
  assert.equal(installerFileName(PACKAGE), `Kirigami-Setup-${PACKAGE.version}.exe`);
  const pkg = (build) => ({ name: 'kirigami', productName: 'Kirigami', version: '1.2.3', build });
  assert.equal(installerFileName(pkg({ win: { artifactName: '${productName}_${version}.${ext}' } })), 'Kirigami_1.2.3.exe');
  assert.equal(installerFileName(pkg({ artifactName: '${productName}-${version}.${ext}' })), 'Kirigami-1.2.3.exe');
  // electron-builder's default has spaces, which GitHub turns into dashes: the names would no longer match.
  assert.throws(() => installerFileName(pkg({})), /GitHub renames on upload/);
  assert.throws(() => installerFileName(pkg({ nsis: { artifactName: '${productName}-${arch}.${ext}' } })), /\$\{arch\}/);
  assert.throws(() => installerFileName({ ...pkg({ nsis: { artifactName: '${productName}-${version}.${ext}' } }), version: '' }), /\$\{version\}/);
});

test('expectsBlockmap: unless differential packages are turned off', async () => {
  const { expectsBlockmap } = await load();
  assert.equal(expectsBlockmap(PACKAGE), PACKAGE.build.nsis.differentialPackage !== false);
  assert.equal(expectsBlockmap({ build: { nsis: {} } }), true);
  assert.equal(expectsBlockmap({}), true);
  assert.equal(expectsBlockmap({ build: { nsis: { differentialPackage: false } } }), false);
});

test('feedProblems: version, installer name and SHA-512 must all match the build', async () => {
  const { feedProblems, readYamlScalars } = await load();
  const feed = readYamlScalars(LATEST_YML);
  const expected = { version: '1.0.0', installer: 'Kirigami-Setup-1.0.0.exe', sha512: feed.sha512 };
  assert.deepEqual(feedProblems(feed, expected), []);

  const stale = feedProblems(feed, { version: '1.0.1', installer: 'Kirigami-Setup-1.0.1.exe', sha512: 'other' });
  assert.equal(stale.length, 3);
  assert.match(stale[0], /announces version 1\.0\.0, not 1\.0\.1/);
  assert.match(stale[1], /points at Kirigami-Setup-1\.0\.0\.exe, not Kirigami-Setup-1\.0\.1\.exe/);
  assert.match(stale[2], /refuse the download/);
  assert.equal(feedProblems({}, expected).length, 3);
});

test('updateConfigProblems: the github provider and the repository the releases go to', async () => {
  const { updateConfigProblems, readYamlScalars } = await load();
  const config = readYamlScalars(APP_UPDATE_YML);
  assert.deepEqual(updateConfigProblems(config, 'mtgtoolkit/kirigami'), []);
  assert.deepEqual(updateConfigProblems(config, 'MTGToolkit/Kirigami'), [], 'GitHub names are case-insensitive');

  const elsewhere = updateConfigProblems(config, 'someone/kirigami');
  assert.equal(elsewhere.length, 1);
  assert.match(elsewhere[0], /look for updates in mtgtoolkit\/kirigami, but releases are published to someone\/kirigami/);

  const generic = updateConfigProblems({ provider: 'generic', url: 'https://example.com' }, 'mtgtoolkit/kirigami');
  assert.equal(generic.length, 2);
  assert.match(generic[0], /provider "generic", not github/);
  assert.match(generic[1], /\(no repository\)/);
});

test('missingDependencies: each runtime dependency needs its package.json inside app.asar', async () => {
  const { missingDependencies } = await load();
  const pkg = { dependencies: { 'electron-updater': '6.8.10', '@scope/lib': '1.0.0' } };
  // @electron/asar lists entries with the platform's separator and a leading one.
  const windows = ['\\node_modules', '\\node_modules\\electron-updater', '\\node_modules\\electron-updater\\package.json',
    '\\node_modules\\@scope\\lib\\package.json', '\\src\\main\\main.js'];
  assert.deepEqual(missingDependencies(pkg, windows), []);
  assert.deepEqual(missingDependencies(pkg, ['/node_modules/electron-updater/package.json', 'node_modules/@scope/lib/package.json']), []);

  // A folder without its package.json, or the dependency nested under another one, does not count.
  assert.deepEqual(missingDependencies(pkg, ['\\node_modules\\electron-updater', '\\node_modules\\x\\node_modules\\@scope\\lib\\package.json']),
    ['electron-updater', '@scope/lib']);
  assert.deepEqual(missingDependencies({ dependencies: {} }, []), []);
  assert.deepEqual(missingDependencies({}, []), []);
});
