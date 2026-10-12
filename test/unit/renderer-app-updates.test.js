'use strict';

// The window side of Kirigami's own updates (src/renderer/js/components/app-updates.js): what
// Settings > Updates says for every state the main process can send (states built with the real
// reducer from src/main/app-update-state.js, so both sides keep the same shape), stale pushes being
// dropped, and the "What's new" link after an update. The module is an ES module, loaded with import().

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const S = require('../../src/main/app-update-state');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer', 'js');
const load = (rel) => import(pathToFileURL(path.join(RENDERER, rel)).href);

const NOW = Date.parse('2026-10-12T12:00:00Z');
const AT = new Date(NOW - 60 * 1000).toISOString();

function stateFrom(events, { mode = 'auto', reason = null, autoCheck = true } = {}) {
  let s = S.initialUpdateState({ mode, reason, currentVersion: '1.0.0', autoCheck });
  for (const event of events) s = S.reduceUpdateState(s, event);
  return s;
}

const found = (version) => S.releaseInfo({ version, releaseNotes: '<p>Better cutting</p>' });

test('Settings > Updates describes every state the main process sends', async () => {
  const { describeAppUpdate } = await load('components/app-updates.js');
  const describe = (s) => describeAppUpdate(s, { now: NOW });

  assert.equal(describe(null).title, 'Update status unavailable');

  const never = describe(stateFrom([]));
  assert.equal(never.status, 'pending');
  assert.equal(never.title, 'Not checked yet');
  assert.match(never.message, /every 4 hours/);
  assert.match(describe(stateFrom([], { autoCheck: false })).message, /Automatic checks are off\. Click Check now/);

  assert.deepEqual(describe(stateFrom([{ type: 'check-started' }])), {
    status: 'running',
    title: 'Checking for updates…',
    message: 'Asking GitHub for the newest Kirigami release.',
  });

  const upToDate = describe(stateFrom([{ type: 'check-finished', at: AT, update: null }]));
  assert.equal(upToDate.status, 'ok');
  assert.equal(upToDate.title, 'Kirigami is up to date');
  assert.match(upToDate.message, /^You have version 1\.0\.0 \(checked today at .+\)\.$/);

  const downloading = stateFrom([
    { type: 'check-finished', at: AT, update: found('1.1.0') },
    { type: 'download-progress', percent: 50, transferred: 50 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 1 },
  ]);
  assert.deepEqual(describe(downloading), {
    status: 'running',
    title: 'Downloading Kirigami 1.1.0…',
    message: 'In the background; you can keep working · 50 MB of 100 MB.',
  });

  const ready = describe(stateFrom([{ type: 'check-finished', at: AT, update: found('1.1.0') }, { type: 'downloaded', update: found('1.1.0') }]));
  assert.equal(ready.status, 'info');
  assert.equal(ready.title, 'Kirigami 1.1.0 is ready to install');
  assert.equal(ready.message, 'Restart Kirigami to finish. Otherwise it is installed the next time you close the app.');
  const rehearsed = describe(stateFrom([{ type: 'check-finished', at: AT, update: found('1.1.0') }, { type: 'downloaded' }], { mode: 'rehearsal' }));
  assert.match(rehearsed.message, /Rehearsal from source: it is never installed/);

  const offline = describe(stateFrom([{ type: 'check-failed', at: AT, error: 'Could not reach GitHub.' }]));
  assert.deepEqual(offline, { status: 'warning', title: 'Could not check for updates', message: 'Could not reach GitHub.' });
  const damaged = describe(stateFrom([{ type: 'check-finished', at: AT, update: found('1.1.0') }, { type: 'download-failed', error: 'The download was damaged.' }]));
  assert.equal(damaged.title, 'Kirigami 1.1.0 could not be downloaded');
  assert.equal(damaged.message, 'The download was damaged.');

  for (const reason of ['source', 'test', 'env']) {
    const off = describe(stateFrom([], { mode: 'disabled', reason }));
    assert.equal(off.status, 'optional');
    assert.equal(off.message, S.DISABLED_MESSAGES[reason], 'the reason worded by the main process');
  }
});

test('a state that arrives late never replaces a newer one', async () => {
  const { acceptAppUpdate } = await load('components/app-updates.js');
  const { createStore } = await load('core/store.js');
  const store = createStore({ appUpdate: null });
  assert.equal(acceptAppUpdate(store, null), false);
  assert.equal(acceptAppUpdate(store, { revision: 3, phase: 'downloading' }), true);
  assert.equal(acceptAppUpdate(store, { revision: 2, phase: 'idle' }), false, 'older pull answer dropped');
  assert.equal(store.get('appUpdate').phase, 'downloading');
  assert.equal(acceptAppUpdate(store, { revision: 3, phase: 'downloading', progress: { percent: 5 } }), true, 'same revision: the newest copy wins');
  assert.equal(acceptAppUpdate(store, { revision: 4, phase: 'ready' }), true);
  assert.equal(store.get('appUpdate').phase, 'ready');
});

test('"What\'s new" after an update opens that version\'s release page', async () => {
  const { updatedReleaseUrl } = await load('components/app-updates.js');
  const state = S.initialUpdateState({ mode: 'auto', currentVersion: '1.2.0', updatedTo: '1.2.0' });
  assert.equal(updatedReleaseUrl(state), 'https://github.com/mtgtoolkit/kirigami/releases/tag/v1.2.0');
  assert.equal(updatedReleaseUrl({ updatedTo: '1.2.0/../../x' }), S.RELEASES_URL, 'odd versions are not put in a URL');
  assert.equal(updatedReleaseUrl(null), S.RELEASES_URL, 'the fallback matches the main process');
});
