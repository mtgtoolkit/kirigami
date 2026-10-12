'use strict';

// Pure logic of Kirigami's own updates (src/main/app-update-state.js): mode selection, version
// comparison, release information, state transitions, schedule, install gating and error wording.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../../src/main/app-update-state');

const at = (iso) => new Date(iso).toISOString();
const release = (version, extra = {}) => ({ version, releaseName: null, releaseDate: null, notes: '', url: S.releaseUrl(version), ...extra });

function stateAt(phase, patch = {}) {
  return { ...S.initialUpdateState({ mode: 'auto', currentVersion: '1.0.0' }), phase, ...patch };
}

// ---------------------------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------------------------

test('only an installed copy updates itself; tests and SCM_APP_UPDATES=0 turn it off', () => {
  assert.deepEqual(S.updateMode({ packaged: true }), { mode: 'auto', reason: null });
  assert.deepEqual(S.updateMode({ packaged: false }), { mode: 'disabled', reason: 'source' });
  assert.deepEqual(S.updateMode({ packaged: true, isTest: true }), { mode: 'disabled', reason: 'test' });
  for (const value of ['0', 'off', 'FALSE', ' no ']) {
    assert.deepEqual(S.updateMode({ packaged: true, env: { SCM_APP_UPDATES: value } }), { mode: 'disabled', reason: 'env' }, value);
  }
  assert.deepEqual(S.updateMode({ packaged: true, env: { SCM_APP_UPDATES: '1' } }), { mode: 'auto', reason: null });
  // The rehearsal only exists when running from source, and never in a test run.
  assert.deepEqual(S.updateMode({ packaged: false, env: { SCM_APP_UPDATES: 'dev' } }), { mode: 'rehearsal', reason: null });
  assert.deepEqual(S.updateMode({ packaged: true, env: { SCM_APP_UPDATES: 'dev' } }), { mode: 'auto', reason: null });
  assert.deepEqual(S.updateMode({ packaged: false, isTest: true, env: { SCM_APP_UPDATES: 'dev' } }), { mode: 'disabled', reason: 'test' });
  assert.deepEqual(S.updateMode({ packaged: false, env: { SCM_APP_UPDATES: '0' } }), { mode: 'disabled', reason: 'env' });
  // An unpacked test build (npm run pack) has no resources/app-update.yml: nothing to check against.
  assert.deepEqual(S.updateMode({ packaged: true, updateConfig: false }), { mode: 'disabled', reason: 'unpacked' });
  assert.deepEqual(S.updateMode({ packaged: true, updateConfig: true }), { mode: 'auto', reason: null });
  assert.deepEqual(S.updateMode({ packaged: false, updateConfig: false, env: { SCM_APP_UPDATES: 'dev' } }), { mode: 'rehearsal', reason: null }, 'the rehearsal reads dev-app-update.yml instead');
  assert.deepEqual(S.updateMode({ packaged: true, updateConfig: false, isTest: true }), { mode: 'disabled', reason: 'test' });
});

test('the installer\'s --updated flag is recognized', () => {
  assert.equal(S.launchedByUpdater(['Kirigami.exe', '--updated']), true);
  assert.equal(S.launchedByUpdater(['Kirigami.exe']), false);
  assert.equal(S.launchedByUpdater(undefined), false);
});

test('the repository matches package.json build.publish (the feed the installed app reads)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.build.publish, { provider: 'github', owner: S.APP_REPOSITORY.owner, repo: S.APP_REPOSITORY.repo, releaseType: 'draft' });
  assert.equal(S.RELEASES_URL, `${pkg.homepage}/releases`);
  assert.equal(pkg.build.win.verifyUpdateCodeSignature, false, 'unsigned builds: a publisher check would refuse every update');
  assert.equal(pkg.dependencies['electron-updater'], '6.8.10', 'exact version, aligned with electron-builder');
});

// ---------------------------------------------------------------------------------------------
// Versions
// ---------------------------------------------------------------------------------------------

test('versions compare numerically, with the v prefix optional and pre-releases older', () => {
  assert.equal(S.compareVersions('0.10.0', '0.9.0'), 1, 'not a string comparison');
  assert.equal(S.compareVersions('v1.2.3', '1.2.3'), 0);
  assert.equal(S.compareVersions('1.2', '1.2.0'), 0, 'missing segments count as 0');
  assert.equal(S.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(S.compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(S.compareVersions('1.2.0-beta.1', '1.2.0'), -1);
  assert.equal(S.compareVersions('1.2.0', '1.2.0-rc.1'), 1);
  assert.equal(S.compareVersions('1.2.0-beta.2', '1.2.0-beta.10'), -1, 'numeric pre-release identifiers');
  assert.equal(S.compareVersions('1.2.0-beta', '1.2.0-alpha'), 1);
  assert.equal(S.compareVersions('1.2.0-alpha', '1.2.0-alpha.1'), -1);
  assert.equal(S.compareVersions('1.2.0-1', '1.2.0-alpha'), -1, 'numbers sort before words');
  assert.equal(S.compareVersions('1.2.0+build.5', '1.2.0'), 0, 'build metadata is ignored');
  for (const junk of ['', 'latest', '1..2', '1.2.x', null, undefined, 12]) {
    assert.equal(S.compareVersions(junk, '1.0.0'), null, String(junk));
  }
  assert.equal(S.isNewerVersion('1.0.1', '1.0.0'), true);
  assert.equal(S.isNewerVersion('1.0.0', '1.0.0'), false);
  assert.equal(S.isNewerVersion('0.9.9', '1.0.0'), false);
  assert.equal(S.isNewerVersion('nonsense', '1.0.0'), false, 'a malformed release never triggers an update');
});

// ---------------------------------------------------------------------------------------------
// Release information
// ---------------------------------------------------------------------------------------------

test('release notes from the GitHub feed become plain text', () => {
  const html = '<h2>What&#39;s new</h2>\n<ul>\n<li>Faster &amp; <strong>safer</strong> downloads</li>\n<li>Fix &lt;tags&gt; &#x2764;</li>\n</ul>\n<p>Thanks!</p><script>alert(1)</script>';
  const text = S.notesToText(html);
  // A list is single-spaced, also right under a heading; a script ends up as inert text (shown with textContent).
  assert.equal(text, "What's new\n• Faster & safer downloads\n• Fix <tags> ❤\n\nThanks!\nalert(1)");
  assert.ok(!/[<>]\w/.test(text.replace('<tags>', '')), 'no markup left');
  assert.equal(S.notesToText('a &amp;lt; b'), 'a &lt; b', 'ampersand decoded last, once');
  assert.equal(S.notesToText('bad &#99999999; code'), 'bad &#99999999; code', 'invalid code points are kept as written');
  assert.equal(S.notesToText(null), '');
});

test('releaseInfo keeps what the window shows, with a link to the release page', () => {
  const info = S.releaseInfo({
    version: '1.2.0', tag: 'v1.2.0', releaseName: ' Kirigami 1.2.0 ', releaseDate: '2026-10-01T10:00:00.000Z',
    releaseNotes: '<p>Hello</p>', files: [{ url: 'Kirigami-Setup-1.2.0.exe', sha512: 'x' }], path: 'x', sha512: 'y',
  });
  assert.deepEqual(info, {
    version: '1.2.0',
    releaseName: 'Kirigami 1.2.0',
    releaseDate: '2026-10-01T10:00:00.000Z',
    notes: 'Hello',
    url: 'https://github.com/mtgtoolkit/kirigami/releases/tag/v1.2.0',
  });
  const multi = S.releaseInfo({ version: '1.3.0', releaseNotes: [{ version: '1.3.0', note: '<p>B</p>' }, { version: '1.2.0', note: '<p>A</p>' }] });
  assert.equal(multi.notes, 'Version 1.3.0\nB\n\nVersion 1.2.0\nA');
  assert.equal(multi.url, 'https://github.com/mtgtoolkit/kirigami/releases/tag/v1.3.0', 'tag derived from the version');
  assert.equal(S.releaseInfo({ version: '1.4.0', releaseNotes: 'x'.repeat(5000) }).notes.length, 4001, 'long notes are cut');
  assert.equal(S.releaseInfo({ version: 'not a version' }), null);
  assert.equal(S.releaseInfo(null), null);
  assert.equal(S.releaseUrl('1.0.0', '../../evil'), 'https://github.com/mtgtoolkit/kirigami/releases/tag/v1.0.0', 'odd tags are not trusted');
  assert.equal(S.releaseUrl('junk'), S.RELEASES_URL);
});

// ---------------------------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------------------------

test('initial state', () => {
  const s = S.initialUpdateState({ mode: 'auto', currentVersion: '1.0.0', updatedTo: '1.0.0' });
  assert.equal(s.phase, 'idle');
  assert.equal(s.checking, false);
  assert.equal(s.autoCheck, true);
  assert.equal(s.updatedTo, '1.0.0');
  assert.equal(s.disabledReason, null);
  assert.equal(s.disabledMessage, null);
  assert.equal(s.revision, 0);
  const off = S.initialUpdateState({ mode: 'disabled', reason: 'test', currentVersion: '1.0.0', autoCheck: false });
  assert.equal(off.disabledReason, 'test');
  assert.equal(off.disabledMessage, 'Updates are off while automated tests run.');
  assert.equal(off.autoCheck, false);
  for (const reason of ['source', 'test', 'env', 'unpacked']) {
    assert.equal(S.initialUpdateState({ mode: 'disabled', reason, currentVersion: '1.0.0' }).disabledMessage, S.DISABLED_MESSAGES[reason]);
  }
  const weird = S.initialUpdateState({ mode: 'weird', reason: 'nope', currentVersion: '1.0.0' });
  assert.equal(weird.mode, 'disabled');
  assert.equal(weird.disabledReason, 'source', 'an unknown mode or reason reads as "running from source"');
  assert.match(weird.disabledMessage, /runs from source/);
  assert.ok(S.UPDATE_PHASES.includes(s.phase));
});

test('check → newer version → downloading → progress → ready', () => {
  let s = S.initialUpdateState({ mode: 'auto', currentVersion: '1.0.0' });
  s = S.reduceUpdateState(s, { type: 'check-started' });
  assert.equal(s.checking, true);
  assert.equal(S.reduceUpdateState(s, { type: 'check-started' }), s, 'no change, same object');
  s = S.reduceUpdateState(s, { type: 'check-finished', at: at('2026-10-12T10:00:00Z'), update: release('1.1.0') });
  assert.equal(s.checking, false);
  assert.equal(s.phase, 'downloading');
  assert.equal(s.available.version, '1.1.0');
  assert.deepEqual(s.lastCheck, { at: '2026-10-12T10:00:00.000Z', ok: true, error: null });
  assert.deepEqual(s.progress, { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 });
  s = S.reduceUpdateState(s, { type: 'download-progress', percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: -3 });
  assert.deepEqual(s.progress, { percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 0 }, 'bad numbers become 0');
  s = S.reduceUpdateState(s, { type: 'downloaded', update: release('1.1.0', { notes: 'Notes' }) });
  assert.equal(s.phase, 'ready');
  assert.equal(s.progress, null);
  assert.equal(s.available.notes, 'Notes');
  assert.equal(S.reduceUpdateState(s, { type: 'download-progress', percent: 99 }), s, 'late progress is ignored once ready');
});

test('nothing newer → up to date; an older or equal release never starts a download', () => {
  const base = S.initialUpdateState({ mode: 'auto', currentVersion: '1.0.0' });
  for (const update of [null, release('1.0.0'), release('0.9.0')]) {
    const s = S.reduceUpdateState({ ...base, checking: true }, { type: 'check-finished', at: at('2026-10-12T10:00:00Z'), update });
    assert.equal(s.phase, 'up-to-date');
    assert.equal(s.available, null);
  }
  const fromError = S.reduceUpdateState(stateAt('error', { error: 'offline', available: release('1.1.0') }), { type: 'check-finished', at: at('2026-10-12T10:00:00Z'), update: null });
  assert.equal(fromError.phase, 'up-to-date');
  assert.equal(fromError.error, null);
  assert.equal(fromError.available, null);
});

test('periodic checks keep a ready update; a newer release replaces it', () => {
  const ready = stateAt('ready', { available: release('1.1.0', { notes: 'old notes' }) });
  const t = at('2026-10-12T14:00:00Z');
  const again = S.reduceUpdateState({ ...ready, checking: true }, { type: 'check-finished', at: t, update: release('1.1.0', { notes: 'new notes' }) });
  assert.equal(again.phase, 'ready', 'the same version found again stays ready (no flicker, no new download)');
  assert.equal(again.available.notes, 'new notes');
  assert.equal(again.lastCheck.at, t);
  const nothing = S.reduceUpdateState(ready, { type: 'check-finished', at: t, update: null });
  assert.equal(nothing.phase, 'ready', 'the downloaded update is still newer than this copy');
  const older = S.reduceUpdateState(ready, { type: 'check-finished', at: t, update: release('1.0.5') });
  assert.equal(older.phase, 'ready');
  assert.equal(older.available.version, '1.1.0');
  const newer = S.reduceUpdateState(ready, { type: 'check-finished', at: t, update: release('1.2.0') });
  assert.equal(newer.phase, 'downloading');
  assert.equal(newer.available.version, '1.2.0');
  const downloading = S.reduceUpdateState(stateAt('downloading', { available: release('1.1.0'), progress: { percent: 50 } }), { type: 'check-finished', at: t, update: release('1.1.0') });
  assert.equal(downloading.phase, 'downloading');
  assert.deepEqual(downloading.progress, { percent: 50 }, 'progress kept');
});

test('failures: a failed check shows an error unless an update is in hand; a failed download can be retried', () => {
  const t = at('2026-10-12T10:00:00Z');
  const failed = S.reduceUpdateState({ ...stateAt('up-to-date'), checking: true }, { type: 'check-failed', at: t, error: 'Could not reach GitHub.' });
  assert.equal(failed.phase, 'error');
  assert.equal(failed.error, 'Could not reach GitHub.');
  assert.deepEqual(failed.lastCheck, { at: t, ok: false, error: 'Could not reach GitHub.' });
  assert.equal(failed.checking, false);
  for (const phase of ['downloading', 'ready']) {
    const s = S.reduceUpdateState({ ...stateAt(phase, { available: release('1.1.0') }), checking: true }, { type: 'check-failed', at: t, error: 'offline' });
    assert.equal(s.phase, phase, `${phase} kept`);
    assert.equal(s.lastCheck.ok, false);
    assert.equal(s.checking, false);
  }
  const downloadFailed = S.reduceUpdateState(stateAt('downloading', { available: release('1.1.0'), progress: { percent: 10 } }), { type: 'download-failed', error: 'Disk full.' });
  assert.equal(downloadFailed.phase, 'error');
  assert.equal(downloadFailed.available.version, '1.1.0', 'kept so the window can say which version failed');
  assert.equal(downloadFailed.progress, null);
  assert.equal(S.reduceUpdateState(stateAt('ready'), { type: 'download-failed', error: 'x' }).phase, 'ready', 'only a running download can fail');
  const retry = S.reduceUpdateState(downloadFailed, { type: 'check-finished', at: t, update: release('1.1.0') });
  assert.equal(retry.phase, 'downloading', 'the next check downloads it again');
  const installFailed = S.reduceUpdateState(stateAt('ready', { available: release('1.1.0') }), { type: 'install-failed', error: 'No installer.' });
  assert.equal(installFailed.phase, 'error');
  assert.equal(installFailed.error, 'No installer.');
});

test('downloaded needs a version newer than this copy; settings and schedule events', () => {
  assert.equal(S.reduceUpdateState(stateAt('downloading'), { type: 'downloaded', update: null }).phase, 'downloading', 'nothing known: ignored');
  assert.equal(S.reduceUpdateState(stateAt('downloading'), { type: 'downloaded', update: release('1.0.0') }).phase, 'downloading');
  const fromAvailable = S.reduceUpdateState(stateAt('downloading', { available: release('1.1.0') }), { type: 'downloaded' });
  assert.equal(fromAvailable.phase, 'ready', 'falls back to the version being downloaded');
  const s = stateAt('idle');
  assert.equal(S.reduceUpdateState(s, { type: 'auto-check', enabled: true }), s);
  assert.equal(S.reduceUpdateState(s, { type: 'auto-check', enabled: false }).autoCheck, false);
  const scheduled = S.reduceUpdateState(s, { type: 'scheduled', at: '2026-10-12T14:00:00.000Z' });
  assert.equal(scheduled.nextCheckAt, '2026-10-12T14:00:00.000Z');
  assert.equal(S.reduceUpdateState(scheduled, { type: 'scheduled', at: '2026-10-12T14:00:00.000Z' }), scheduled);
  assert.equal(S.reduceUpdateState(scheduled, { type: 'scheduled', at: null }).nextCheckAt, null);
  assert.equal(S.reduceUpdateState(s, { type: 'unknown' }), s);
  assert.equal(S.reduceUpdateState(s, null), s);
});

// ---------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------

test('schedule: 10 s after start, every 4 hours, 30 minutes after a failure, nothing when off', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const H = 60 * 60 * 1000;
  assert.equal(S.FIRST_CHECK_DELAY_MS, 10000);
  assert.equal(S.CHECK_INTERVAL_MS, 4 * H);
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: null }), 10000);
  assert.equal(S.planNextCheck({ autoCheck: false, now, lastCheck: null }), null);
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: { at: ago(H), ok: true } }), 3 * H, 'counted from the last check');
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: { at: ago(10 * H), ok: true } }), 10000, 'overdue: soon, not immediately');
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: { at: ago(10 * 60000), ok: false } }), 20 * 60000, 'retry 30 min after a failure');
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: { at: new Date(now + 5 * H).toISOString(), ok: true } }), 4 * H, 'clock moved back: at most one interval');
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: { at: 'garbage', ok: true } }), 10000);
  assert.equal(S.planNextCheck({ autoCheck: true, now, lastCheck: null, firstDelayMs: 5 }), 5);
});

// ---------------------------------------------------------------------------------------------
// Install gating
// ---------------------------------------------------------------------------------------------

test('Restart to update: only when ready, never while a task runs, never in a rehearsal', () => {
  assert.equal(S.installBlocker({ mode: 'auto', phase: 'ready', activeJob: null }), null);
  assert.equal(S.installBlocker({ mode: 'auto', phase: 'downloading' }).code, 'UPDATE_NOT_READY');
  assert.equal(S.installBlocker({ mode: 'auto', phase: 'error' }).code, 'UPDATE_NOT_READY');
  const busy = S.installBlocker({ mode: 'auto', phase: 'ready', activeJob: { title: 'Making the "big" PDF' } });
  assert.equal(busy.code, 'BUSY');
  assert.equal(busy.message, 'BUSY: wait until "Making the \'big\' PDF" finishes, then restart to update');
  assert.equal(S.installBlocker({ mode: 'auto', phase: 'ready', activeJob: {} }).message, 'BUSY: wait until "the current task" finishes, then restart to update');
  assert.equal(S.installBlocker({ mode: 'rehearsal', phase: 'ready' }).code, 'UPDATE_REHEARSAL');
  assert.equal(S.installBlocker({ mode: 'disabled', phase: 'ready' }).code, 'UPDATES_DISABLED');
  assert.equal(S.installBlocker({ mode: 'auto', phase: 'idle', activeJob: { title: 'x' } }).code, 'UPDATE_NOT_READY', 'not ready matters more than busy');
});

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

const withCode = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra);

/**
 * The error electron-updater's real GitHub provider (and its real HTTP client) throws for a
 * github.com that answers like GitHub did for mtgtoolkit/kirigami with no published release
 * (checked with curl and with the provider against github.com): the releases feed has no entry,
 * and `releases/latest` redirects to the releases list, which answers 406 to a JSON request.
 * @param {{ feed: 'empty'|'tag', latest: 'redirect-406'|'404'|'reset'|'html' }} github
 * @returns {Promise<Error|null>} null when the provider found a version
 */
async function realProviderError({ feed, latest }) {
  const http = require('node:http');
  const { createRequire } = require('node:module');
  const updaterRequire = createRequire(require.resolve('electron-updater'));
  const { GitHubProvider } = updaterRequire('./providers/GitHubProvider');
  const { HttpExecutor } = updaterRequire('builder-util-runtime');
  const semver = updaterRequire('semver');
  const base = '/mtgtoolkit/kirigami/releases';
  const entry = '<entry><id>tag:github.com,2008:Repository/1/v1.0.1</id><updated>2026-10-12T21:00:00Z</updated>'
    + '<link rel="alternate" type="text/html" href="https://github.com/mtgtoolkit/kirigami/releases/tag/v1.0.1"/>'
    + '<title>v1.0.1</title><content type="html">&lt;p&gt;Kirigami 1.0.1&lt;/p&gt;</content></entry>';
  const atom = '<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xml:lang="en-US">\n'
    + '  <id>tag:github.com,2008:https://github.com/mtgtoolkit/kirigami/releases</id>\n'
    + '  <link type="text/html" rel="alternate" href="https://github.com/mtgtoolkit/kirigami/releases"/>\n'
    + '  <link type="application/atom+xml" rel="self" href="https://github.com/mtgtoolkit/kirigami/releases.atom"/>\n'
    + `  <title>Release notes from kirigami</title>\n  <updated>2026-10-12T22:03:29Z</updated>\n${feed === 'tag' ? entry : ''}</feed>\n`;
  const server = http.createServer((req, res) => {
    if (req.url === `${base}.atom`) {
      res.writeHead(200, { 'content-type': 'application/atom+xml; charset=utf-8' }).end(atom);
    } else if (req.url === `${base}/latest`) {
      if (latest === 'redirect-406') res.writeHead(302, { location: `https://github.com${base}` }).end();
      else if (latest === '404') res.writeHead(404, { 'content-type': 'application/json' }).end('{"message":"Not Found"}');
      else if (latest === 'html') res.writeHead(200, { 'content-type': 'text/html' }).end('<!DOCTYPE html><html></html>');
      else req.socket.destroy();
    } else if (req.url === base && /application\/json/.test(req.headers.accept || '')) {
      res.writeHead(406, { 'content-type': 'text/html; charset=utf-8' }).end('');
    } else {
      res.writeHead(500).end();
    }
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  // Every request for github.com goes to the local server instead (redirects included).
  class LocalGitHub extends HttpExecutor {
    createRequest(options, callback) {
      return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port }, callback);
    }
  }
  const updater = { allowPrerelease: false, currentVersion: semver.parse('1.0.0'), channel: null, fullChangelog: false };
  const provider = new GitHubProvider({ provider: 'github', owner: 'mtgtoolkit', repo: 'kirigami' }, updater,
    { executor: new LocalGitHub(), platform: 'win32', isUseMultipleRangeRequest: false });
  try {
    await provider.getLatestVersion();
    return null;
  } catch (err) {
    return err;
  } finally {
    server.close();
  }
}

test('"no release published yet" means up to date, unless the network failed', async () => {
  // Nothing published at all: the feed is empty.
  const empty = await realProviderError({ feed: 'empty', latest: 'redirect-406' });
  assert.equal(empty.code, 'ERR_XML_MISSED_ELEMENT');
  assert.equal(S.isNoReleaseError(empty), true);
  // Only a tag, a pre-release or a draft being prepared (the release workflow pushes the tag first):
  // the feed lists it, but releases/latest has no published release to point at.
  const tagOnly = await realProviderError({ feed: 'tag', latest: 'redirect-406' });
  assert.equal(tagOnly.code, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  assert.match(tagOnly.message, /^Cannot parse releases feed: Error: Unable to find latest version on GitHub .*HttpError: 406 /);
  assert.equal(S.isNoReleaseError(tagOnly), true);
  const enterprise = await realProviderError({ feed: 'tag', latest: '404' });
  assert.equal(S.isNoReleaseError(enterprise), true, 'the same answer as a 404');
  // Not "no release": the connection failed, or GitHub answered something unexpected.
  const reset = await realProviderError({ feed: 'tag', latest: 'reset' });
  assert.equal(reset.code, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  assert.equal(S.isNoReleaseError(reset), false);
  assert.equal(S.updateErrorMessage(reset), 'Could not reach GitHub. Check your internet connection; Kirigami tries again later.');
  const html = await realProviderError({ feed: 'tag', latest: 'html' });
  assert.equal(S.isNoReleaseError(html), false);
  assert.match(S.updateErrorMessage(html), /^Could not check for updates: Cannot parse releases feed/);

  assert.equal(S.isNoReleaseError(withCode('No published versions on GitHub', 'ERR_UPDATER_NO_PUBLISHED_VERSIONS')), true, 'releases/latest answered nothing');
  assert.equal(S.isNoReleaseError(withCode('Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/mtgtoolkit/kirigami/releases/latest), please ensure a production release exists: Error: net::ERR_INTERNET_DISCONNECTED\n    at ...', 'ERR_UPDATER_INVALID_RELEASE_FEED')), false);
  assert.equal(S.isNoReleaseError(withCode('Cannot parse releases feed: Error: x,\nXML:\n<feed><entry><content>please ensure a production release exists: HttpError: 404 Unable to find latest version on GitHub</content></entry></feed>', 'ERR_UPDATER_INVALID_RELEASE_FEED')), false, 'the feed text itself never counts');
  assert.equal(S.isNoReleaseError(withCode('No element "link"', 'ERR_XML_MISSED_ELEMENT')), false);
  assert.equal(S.isNoReleaseError(new Error('boom')), false);
  assert.equal(S.isNoReleaseError(null), false);
});

test('update errors become one plain sentence', () => {
  const offline = 'Could not reach GitHub. Check your internet connection; Kirigami tries again later.';
  assert.equal(S.updateErrorMessage(new Error('net::ERR_INTERNET_DISCONNECTED')), offline);
  assert.equal(S.updateErrorMessage(withCode('getaddrinfo ENOTFOUND github.com', 'ENOTFOUND')), offline);
  assert.equal(S.updateErrorMessage(withCode('Unable to find latest version on GitHub (...): Error: net::ERR_NAME_NOT_RESOLVED', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND')), offline);
  assert.match(S.updateErrorMessage(new Error('net::ERR_CERT_AUTHORITY_INVALID')), /secure connection.*proxy or antivirus/);
  assert.match(S.updateErrorMessage(withCode('sha512 checksum mismatch, expected a, got b', 'ERR_CHECKSUM_MISMATCH'), 'download'), /damaged/);
  assert.match(S.updateErrorMessage(withCode('New version 1.1.0 is not signed by the application owner', 'ERR_UPDATER_INVALID_SIGNATURE'), 'download'), /not signed/);
  assert.match(S.updateErrorMessage(withCode('Cannot find latest.yml in the latest release artifacts', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND')), /no update information yet/);
  assert.match(S.updateErrorMessage(Object.assign(new Error('HTTP error: Forbidden'), { statusCode: 403, code: 'HTTP_ERROR_403' })), /limiting requests/);
  assert.match(S.updateErrorMessage(withCode('Bad Gateway', 'HTTP_ERROR_502')), /error 502/);
  assert.match(S.updateErrorMessage(withCode('ENOSPC: no space left on device, write', 'ENOSPC'), 'download'), /disk is full/);
  assert.match(S.updateErrorMessage(withCode('EPERM: operation not permitted, rename', 'EPERM'), 'download'), /Windows blocked/);
  const feed = withCode(`Cannot parse releases feed: Error: x,\nXML:\n<feed>${'x'.repeat(500)}</feed>`, 'ERR_UPDATER_INVALID_RELEASE_FEED');
  assert.equal(S.updateErrorMessage(feed), 'Could not check for updates: Cannot parse releases feed: Error: x,.');
  const long = S.updateErrorMessage(new Error('y'.repeat(400)), 'install');
  assert.ok(long.startsWith('Could not start the update: yyy') && long.length < 240, 'first line only, capped');
  assert.equal(S.updateErrorMessage(new Error('')), 'Could not check for updates.');
  assert.equal(S.updateErrorMessage(null, 'download'), 'Could not download the update.');
  const friendly = Object.assign(new Error('Part of the app is missing (electron-updater). Please reinstall Kirigami.'), { friendly: true });
  assert.equal(S.updateErrorMessage(friendly), friendly.message, 'already written for people');
});
