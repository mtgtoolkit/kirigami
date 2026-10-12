'use strict';

// src/main/app-updater.js wired to a fake electron-updater (an EventEmitter with the methods the
// module uses), fake timers and fake app deps: schedule, check → download → ready, install gating
// and the quit hand-over, rehearsal and disabled modes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAppUpdater } = require('../../src/main/app-updater');
const { CHECK_INTERVAL_MS, FIRST_CHECK_DELAY_MS, RETRY_AFTER_FAILURE_MS } = require('../../src/main/app-update-state');

const flush = () => new Promise((resolve) => { setImmediate(resolve); });

class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.checkResults = [];
    this.download = null; // (updater) => Promise
    this.installError = null;
  }

  async checkForUpdates() {
    this.calls.push('check');
    const next = this.checkResults.shift();
    if (next instanceof Error) throw next;
    return next === undefined ? { isUpdateAvailable: false, updateInfo: { version: '1.0.0' } } : next;
  }

  downloadUpdate() {
    this.calls.push('download');
    return this.download ? this.download(this) : Promise.resolve([]);
  }

  quitAndInstall(isSilent, isForceRunAfter) {
    this.calls.push(['quitAndInstall', isSilent, isForceRunAfter]);
    if (this.installError) this.emit('error', this.installError);
  }
}

const available = (version, notes = '<p>New things</p>') => ({
  isUpdateAvailable: true,
  updateInfo: { version, releaseNotes: notes, tag: `v${version}`, files: [] },
});

/** Simulates electron-updater's download: progress events, then 'update-downloaded'. */
const downloadsFine = (version) => async (u) => {
  u.emit('download-progress', { percent: 10, transferred: 10, total: 100, bytesPerSecond: 5 });
  u.emit('download-progress', { percent: 60, transferred: 60, total: 100, bytesPerSecond: 5 });
  u.emit('update-downloaded', { version, releaseNotes: '<p>New things</p>', downloadedFile: 'C:\\cache\\Kirigami-Setup.exe' });
  return ['C:\\cache\\Kirigami-Setup.exe'];
};

function setup(t, { packaged = true, isTest = false, env = {}, argv = ['Kirigami.exe'], settingsValue = { updates: { appCheck: true } } } = {}) {
  const updater = new FakeUpdater();
  let loads = 0;
  const timers = [];
  let clock = Date.parse('2026-10-12T12:00:00Z');
  const emitted = [];
  const logs = [];
  const order = [];
  const settingsListeners = new Set();
  const shutdownHooks = [];
  let activeJob = null;
  const settings = {
    value: settingsValue,
    get: () => settings.value,
    onChange: (cb) => { settingsListeners.add(cb); return () => settingsListeners.delete(cb); },
    flush: async () => { order.push('settings.flush'); },
  };
  const logger = {};
  for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (...args) => logs.push([level, ...args]);
  const deps = {
    app: { isPackaged: packaged, getVersion: () => '1.0.0' },
    settings,
    jobs: { active: () => activeJob },
    logger,
    isTest,
    ready: Promise.resolve({ ok: true }),
    emit: (channel, payload) => { emitted.push([channel, payload]); return true; },
    addShutdownHook: (fn) => { shutdownHooks.push(fn); return () => {}; },
  };
  const appUpdater = createAppUpdater(deps, {
    env,
    argv,
    loadUpdater: () => { loads += 1; return updater; },
    now: () => clock,
    setTimeout: (fn, delay) => { const handle = { fn, delay, cleared: false, unref() {} }; timers.push(handle); return handle; },
    clearTimeout: (handle) => { if (handle) handle.cleared = true; },
  });
  const orig = updater.quitAndInstall.bind(updater);
  updater.quitAndInstall = (...args) => { order.push('quitAndInstall'); orig(...args); };
  t.after(() => appUpdater.stop());
  return {
    appUpdater, updater, deps, settings, emitted, logs, order, shutdownHooks,
    get loads() { return loads; },
    pendingTimers: () => timers.filter((h) => !h.cleared && !h.fired),
    async fire() {
      const pending = timers.filter((h) => !h.cleared && !h.fired);
      assert.equal(pending.length, 1, 'exactly one pending timer');
      const handle = pending[0];
      handle.fired = true;
      clock += handle.delay;
      handle.fn();
      for (let i = 0; i < 5; i += 1) await flush();
      return handle.delay;
    },
    advance(ms) { clock += ms; },
    setJob(job) { activeJob = job; },
    changeSettings(value) {
      settings.value = value;
      for (const cb of settingsListeners) cb(value, { changedKeys: ['updates'] });
    },
    states: () => emitted.filter(([ch]) => ch === 'updates:changed').map(([, s]) => s),
  };
}

test('a copy running from source never loads electron-updater and refuses manual checks', async (t) => {
  const ctx = setup(t, { packaged: false });
  ctx.appUpdater.start();
  await flush();
  const state = ctx.appUpdater.state();
  assert.equal(state.mode, 'disabled');
  assert.equal(state.disabledReason, 'source');
  assert.equal(ctx.pendingTimers().length, 0, 'no automatic checks');
  await assert.rejects(ctx.appUpdater.check({ manual: true }), (err) => err.code === 'UPDATES_DISABLED' && /runs from source/.test(err.message));
  assert.equal((await ctx.appUpdater.check()).mode, 'disabled', 'an automatic check quietly does nothing');
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'UPDATES_DISABLED');
  assert.equal(ctx.loads, 0);
  assert.equal(ctx.shutdownHooks.length, 0);
  assert.match(ctx.logs[0].join(' '), /\[updates\] Mode disabled \(source\)/);

  const tested = setup(t, { packaged: true, isTest: true });
  assert.equal(tested.appUpdater.state().disabledReason, 'test');
  const off = setup(t, { packaged: true, env: { SCM_APP_UPDATES: '0' } });
  await assert.rejects(off.appUpdater.check({ manual: true }), /SCM_APP_UPDATES=0/);
});

test('installed copy: first check 10 s after ready, background download, ready to install, next check in 4 h', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = downloadsFine('1.1.0');
  ctx.appUpdater.start();
  assert.equal(ctx.pendingTimers().length, 0, 'waits for the startup tasks');
  await flush();
  assert.equal(ctx.pendingTimers()[0].delay, FIRST_CHECK_DELAY_MS);
  assert.equal(ctx.appUpdater.state().nextCheckAt, '2026-10-12T12:00:10.000Z');
  assert.equal(ctx.loads, 0, 'electron-updater is loaded only when a check runs');

  await ctx.fire();
  assert.equal(ctx.loads, 1);
  assert.equal(ctx.updater.autoDownload, false);
  assert.equal(ctx.updater.autoInstallOnAppQuit, true, 'installs on the next normal quit');
  assert.equal(ctx.updater.disableWebInstaller, true);
  assert.equal(ctx.updater.forceDevUpdateConfig, undefined);
  ctx.updater.logger.info('Checking for update');
  assert.deepEqual(ctx.logs.at(-1), ['info', '[updates]', 'Checking for update']);
  assert.deepEqual(ctx.updater.calls, ['check', 'download']);

  const state = ctx.appUpdater.state();
  assert.equal(state.phase, 'ready');
  assert.equal(state.available.version, '1.1.0');
  assert.equal(state.available.notes, 'New things');
  assert.equal(state.available.url, 'https://github.com/mtgtoolkit/kirigami/releases/tag/v1.1.0');
  assert.equal(state.lastCheck.ok, true);
  const phases = ctx.states().map((s) => `${s.phase}${s.checking ? '+checking' : ''}`);
  assert.deepEqual(phases.filter((p, i) => p !== phases[i - 1]), ['idle', 'idle+checking', 'downloading', 'ready'], 'every step reached the window');
  assert.equal(ctx.states().filter((s) => s.phase === 'downloading' && s.progress.percent === 60).length, 0, 'progress is throttled (two events within 500 ms)');
  assert.equal(ctx.pendingTimers()[0].delay, CHECK_INTERVAL_MS);
  const revisions = ctx.states().map((st) => st.revision);
  assert.ok(revisions.every((r, i) => i === 0 || r > revisions[i - 1]), 'every push has a higher revision');

  // The periodic check finds the same version: no second download, no flicker.
  ctx.updater.checkResults.push(available('1.1.0'));
  const before = ctx.states().length;
  await ctx.fire();
  assert.deepEqual(ctx.updater.calls, ['check', 'download', 'check']);
  assert.ok(ctx.states().slice(before).every((s) => s.phase === 'ready'));
});

test('Restart to update waits for running tasks, saves settings first, then quitAndInstall(silent, run after)', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = downloadsFine('1.1.0');
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'UPDATE_NOT_READY');
  await ctx.appUpdater.check({ manual: true });
  await flush();
  assert.equal(ctx.appUpdater.state().phase, 'ready');

  ctx.setJob({ jobId: 'j1', title: 'Making the PDF' });
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'BUSY' && err.message === 'BUSY: wait until "Making the PDF" finishes, then restart to update');
  assert.deepEqual(ctx.order, [], 'nothing saved, nothing launched');

  // A task that starts while the settings are being saved also blocks it.
  ctx.setJob(null);
  ctx.settings.flush = async () => { ctx.order.push('settings.flush'); ctx.setJob({ jobId: 'j2', title: 'Downloading cards' }); };
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'BUSY');
  assert.deepEqual(ctx.order, ['settings.flush']);

  ctx.setJob(null);
  ctx.order.length = 0;
  ctx.settings.flush = async () => { ctx.order.push('settings.flush'); };
  assert.deepEqual(await ctx.appUpdater.install(), { ok: true, version: '1.1.0' });
  assert.deepEqual(ctx.order, ['settings.flush', 'quitAndInstall']);
  assert.deepEqual(ctx.updater.calls.at(-1), ['quitAndInstall', true, true]);
  assert.equal(ctx.updater.listenerCount('error'), 0, 'the temporary error listener is removed');
});

test('an installer that cannot start is reported and the app keeps running', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = downloadsFine('1.1.0');
  await ctx.appUpdater.check({ manual: true });
  await flush();
  ctx.updater.installError = new Error("No update filepath provided, can't quit and install");
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'UPDATE_INSTALL_FAILED' && /Could not start the update: No update filepath provided/.test(err.message));
  const state = ctx.appUpdater.state();
  assert.equal(state.phase, 'error');
  ctx.updater.checkResults.push(available('1.1.0'));
  await ctx.appUpdater.check({ manual: true });
  await flush();
  assert.equal(ctx.appUpdater.state().phase, 'ready', 'the next check gets it ready again');
});

test('rehearsal (SCM_APP_UPDATES=dev from source): checks and downloads from dev-app-update.yml, never installs', async (t) => {
  const ctx = setup(t, { packaged: false, env: { SCM_APP_UPDATES: 'dev' } });
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = downloadsFine('1.1.0');
  ctx.appUpdater.start();
  await flush();
  await ctx.fire();
  assert.equal(ctx.updater.forceDevUpdateConfig, true);
  assert.equal(ctx.updater.autoInstallOnAppQuit, false, 'quitting never runs the rehearsal file');
  assert.equal(ctx.appUpdater.state().mode, 'rehearsal');
  assert.equal(ctx.appUpdater.state().phase, 'ready');
  await assert.rejects(ctx.appUpdater.install(), (err) => err.code === 'UPDATE_REHEARSAL');
  assert.ok(!ctx.updater.calls.some((c) => Array.isArray(c) && c[0] === 'quitAndInstall'));
});

test('failed checks retry after 30 minutes; "no release yet" counts as up to date', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {}));
  ctx.appUpdater.start();
  await flush();
  await ctx.fire();
  let state = ctx.appUpdater.state();
  assert.equal(state.phase, 'error');
  assert.match(state.error, /Could not reach GitHub/);
  assert.equal(ctx.pendingTimers()[0].delay, RETRY_AFTER_FAILURE_MS);
  assert.ok(ctx.logs.some(([level, , text]) => level === 'warn' && /Automatic check failed: Could not reach GitHub/.test(text)));

  ctx.updater.checkResults.push(Object.assign(new Error('No published versions on GitHub'), { code: 'ERR_XML_MISSED_ELEMENT' }));
  await ctx.fire();
  state = ctx.appUpdater.state();
  assert.equal(state.phase, 'up-to-date');
  assert.equal(state.error, null);
  assert.equal(state.lastCheck.ok, true);
  assert.equal(ctx.pendingTimers()[0].delay, CHECK_INTERVAL_MS);
});

test('a failed download is reported; the next check downloads again', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = async () => { throw Object.assign(new Error('sha512 checksum mismatch, expected a, got b'), { code: 'ERR_CHECKSUM_MISMATCH' }); };
  const afterCheck = await ctx.appUpdater.check({ manual: true });
  assert.equal(afterCheck.phase, 'downloading', 'the check answers as soon as the download starts');
  await flush();
  const failed = ctx.appUpdater.state();
  assert.equal(failed.phase, 'error');
  assert.match(failed.error, /damaged/);
  ctx.updater.checkResults.push(available('1.1.0'));
  ctx.updater.download = downloadsFine('1.1.0');
  await ctx.appUpdater.check({ manual: true });
  await flush();
  assert.equal(ctx.appUpdater.state().phase, 'ready');
  assert.deepEqual(ctx.updater.calls, ['check', 'download', 'check', 'download']);
});

test('overlapping checks share one request; a check during a download does not start another download', async (t) => {
  const ctx = setup(t);
  let finishDownload;
  ctx.updater.checkResults.push(available('1.1.0'), available('1.1.0'));
  ctx.updater.download = (u) => new Promise((resolve) => {
    finishDownload = () => { u.emit('update-downloaded', { version: '1.1.0' }); resolve([]); };
  });
  const [a, b] = await Promise.all([ctx.appUpdater.check({ manual: true }), ctx.appUpdater.check({ manual: true })]);
  assert.deepEqual(a, b);
  assert.deepEqual(ctx.updater.calls, ['check', 'download']);
  await ctx.appUpdater.check({ manual: true });
  assert.deepEqual(ctx.updater.calls, ['check', 'download', 'check'], 'no second download');
  finishDownload();
  await flush();
  assert.equal(ctx.appUpdater.state().phase, 'ready');
});

test('the download is moved to ready even if electron-updater resolves without the event', async (t) => {
  const ctx = setup(t);
  ctx.updater.checkResults.push(available('1.2.0'));
  ctx.updater.download = async () => [];
  await ctx.appUpdater.check({ manual: true });
  await flush();
  assert.equal(ctx.appUpdater.state().phase, 'ready');
  assert.equal(ctx.appUpdater.state().available.version, '1.2.0');
});

test('turning automatic checks off stops the timer; on again schedules from the last check; stop() at quit', async (t) => {
  const ctx = setup(t);
  ctx.appUpdater.start();
  await flush();
  assert.equal(ctx.pendingTimers().length, 1);
  ctx.changeSettings({ updates: { appCheck: false } });
  assert.equal(ctx.pendingTimers().length, 0);
  assert.equal(ctx.appUpdater.state().autoCheck, false);
  assert.equal(ctx.appUpdater.state().nextCheckAt, null);
  assert.equal((await ctx.appUpdater.check({ manual: true })).phase, 'up-to-date', 'Check now still works');
  assert.equal(ctx.pendingTimers().length, 0, 'and does not restart automatic checks');
  ctx.advance(60 * 60 * 1000);
  ctx.changeSettings({ updates: { appCheck: true } });
  assert.equal(ctx.pendingTimers()[0].delay, 3 * 60 * 60 * 1000, '4 h after the manual check');
  assert.equal(ctx.shutdownHooks.length, 1);
  await ctx.shutdownHooks[0]();
  assert.equal(ctx.pendingTimers().length, 0, 'the shutdown hook stops the timer');
  ctx.changeSettings({ updates: { appCheck: false } });
  assert.equal(ctx.pendingTimers().length, 0);
});

test('automatic checks start off when the setting is off; the installer\'s --updated flag is reported', async (t) => {
  const ctx = setup(t, { settingsValue: { updates: { appCheck: false } }, argv: ['Kirigami.exe', '--updated'] });
  ctx.appUpdater.start();
  await flush();
  assert.equal(ctx.pendingTimers().length, 0);
  const state = ctx.appUpdater.state();
  assert.equal(state.autoCheck, false);
  assert.equal(state.updatedTo, '1.0.0');
  assert.match(ctx.logs[0].join(' '), /just updated/);
});

test('a missing electron-updater is a friendly check failure', async (t) => {
  const ctx = setup(t);
  const broken = createAppUpdater(ctx.deps, {
    env: {},
    argv: [],
    loadUpdater: () => { throw Object.assign(new Error("Cannot find module 'electron-updater'"), { code: 'MODULE_NOT_FOUND' }); },
    setTimeout: () => ({ unref() {} }),
    clearTimeout: () => {},
  });
  const state = await broken.check({ manual: true });
  assert.equal(state.phase, 'error');
  assert.equal(state.error, 'Part of the app is missing (electron-updater). Please reinstall Kirigami.');
});
