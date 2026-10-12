'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const PRELOAD = path.join(__dirname, '..', '..', 'src', 'preload', 'preload.js');
const IPC = path.join(__dirname, '..', '..', 'src', 'main', 'ipc.js');

/** The §6 contract: every `window.scm` method maps to exactly one `<ns>:<method>` channel. */
const EXPECTED_CHANNELS = [
  'app:info',
  'updates:state', 'updates:check', 'updates:install',
  'settings:get', 'settings:update', 'settings:reset',
  'env:status', 'env:setup', 'env:usePython', 'env:useAppVenv', 'env:setWorkspace',
  'engine:introspect', 'engine:updateStatus', 'engine:checkUpdate', 'engine:rollback',
  'decklists:list', 'decklists:read', 'decklists:write', 'decklists:remove',
  'cards:list', 'cards:summary', 'cards:add', 'cards:remove', 'cards:clear', 'cards:duplicate', 'cards:fixCollisions',
  'cards:setBack', 'cards:setPartnerBack', 'cards:removePartnerBack', 'cards:trashList', 'cards:restore', 'cards:emptyTrash',
  'cards:loadSamples', 'cards:openFolder',
  'fetch:start',
  'upscayl:status', 'upscayl:locate', 'upscayl:setCustomModelsDir', 'upscayl:detectGpus', 'upscayl:start', 'upscayl:preview',
  'upscayl:cacheInfo', 'upscayl:clearCache',
  'pdf:plan', 'pdf:start',
  'offset:get', 'offset:save', 'offset:reset', 'offset:calibration', 'offset:generateCalibration', 'offset:shiftedCalibration',
  'offset:apply', 'offset:pdfInfo',
  'print:info', 'print:openTemplate',
  'jobs:active', 'jobs:history', 'jobs:cancel', 'jobs:log',
  'shell:openPath', 'shell:showItemInFolder', 'shell:openExternal',
  'dialog:openFiles', 'dialog:openFile', 'dialog:openFolder', 'dialog:saveFile',
];
const EVENT_CHANNELS = ['jobs:event', 'settings:changed', 'cards:changed', 'app:notice', 'engine:changed', 'updates:changed'];

function channelsIn(text, fnName) {
  const re = new RegExp(`\\b${fnName}\\(\\s*'([a-z]+:[A-Za-z]+)'`, 'g');
  return [...text.matchAll(re)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------
// 1. Text parity
// ---------------------------------------------------------------------------------------------

test('channel strings in preload.js and ipc.js are the same set (= the §6 contract)', () => {
  const preloadChannels = channelsIn(fs.readFileSync(PRELOAD, 'utf8'), 'invoke');
  const ipcChannels = channelsIn(fs.readFileSync(IPC, 'utf8'), 'handle');
  assert.equal(new Set(ipcChannels).size, ipcChannels.length, 'no channel registered twice in ipc.js');
  assert.equal(new Set(preloadChannels).size, preloadChannels.length, 'no channel used twice in preload.js');
  assert.deepEqual([...new Set(preloadChannels)].sort(), [...new Set(ipcChannels)].sort());
  assert.deepEqual([...new Set(ipcChannels)].sort(), [...EXPECTED_CHANNELS].sort());
});

test('preload subscribes to exactly the event channels', () => {
  const text = fs.readFileSync(PRELOAD, 'utf8');
  const listed = /const EVENT_CHANNELS = \[([^\]]*)\]/.exec(text);
  assert.ok(listed, 'EVENT_CHANNELS literal present');
  const names = [...listed[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), [...EVENT_CHANNELS].sort());
  assert.deepEqual([...require('../../src/main/ipc').EVENT_CHANNELS].sort(), [...EVENT_CHANNELS].sort());
  for (const ch of EVENT_CHANNELS) {
    assert.ok(text.includes(`subscribe('${ch}'`), `a subscription method exists for ${ch}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. preload.js behavior (sandbox without Buffer / timers / process: only require('electron'))
// ---------------------------------------------------------------------------------------------

function loadPreload({ invokeImpl } = {}) {
  const invocations = [];
  const onHandlers = new Map();
  let exposed = null;
  const electron = {
    contextBridge: {
      exposeInMainWorld: (key, api) => { exposed = { key, api }; },
    },
    ipcRenderer: {
      invoke: (channel, ...args) => {
        invocations.push({ channel, args });
        return (invokeImpl || (async () => ({ ok: true, channel })))(channel, ...args);
      },
      on: (channel, fn) => {
        if (!onHandlers.has(channel)) onHandlers.set(channel, []);
        onHandlers.get(channel).push(fn);
      },
    },
    webUtils: {
      getPathForFile: (file) => {
        if (!file || file.kind !== 'file') throw new TypeError('Expected a File');
        return file.path;
      },
    },
  };
  const consoleErrors = [];
  const sandbox = {
    require: (name) => {
      if (name !== 'electron') throw new Error(`module not found: ${name}`);
      return electron;
    },
    console: { error: (...a) => consoleErrors.push(a), log() {}, warn() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(PRELOAD, 'utf8'), sandbox, { filename: 'preload.js' });
  return {
    api: exposed && exposed.api, key: exposed && exposed.key, invocations, onHandlers, consoleErrors,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('preload exposes window.scm, registers one listener per event channel, uses no Node globals', () => {
  const { api, key, onHandlers } = loadPreload();
  assert.equal(key, 'scm');
  assert.ok(api && typeof api === 'object');
  assert.deepEqual([...onHandlers.keys()].sort(), [...EVENT_CHANNELS].sort());
  for (const ch of EVENT_CHANNELS) assert.equal(onHandlers.get(ch).length, 1, `one ipcRenderer.on for ${ch}`);
  const text = fs.readFileSync(PRELOAD, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  for (const forbidden of ['Buffer', 'setImmediate', 'setTimeout', 'setInterval', "require('events')", "require('timers')"]) {
    assert.equal(text.includes(forbidden), false, `preload must not use ${forbidden}`);
  }
});

test('every API method invokes its channel with the given arguments', async () => {
  const { api, invocations } = loadPreload();
  const SKIP = new Set(['onNotice', 'onChanged', 'onEvent', 'pathForFile']);
  const called = [];
  for (const [ns, group] of Object.entries(api)) {
    if (typeof group !== 'object') continue;
    for (const [method, fn] of Object.entries(group)) {
      if (SKIP.has(method)) continue;
      await fn('A1', 'A2', { a3: true });
      const last = invocations[invocations.length - 1];
      assert.equal(last.channel, `${ns}:${method}`, `scm.${ns}.${method}`);
      called.push(last.channel);
    }
  }
  assert.deepEqual(called.sort(), [...EXPECTED_CHANNELS].sort());

  invocations.length = 0;
  await api.cards.add('front', ['C:\\cards\\a.png']);
  await api.cards.duplicate('front', 'a.png');
  await api.decklists.write('deck', 'text');
  await api.env.usePython();
  // JSON round trip: values created inside the vm sandbox have that realm's prototypes
  assert.deepEqual(JSON.parse(JSON.stringify(invocations.map((i) => [i.channel, i.args]))), [
    ['cards:add', ['front', ['C:\\cards\\a.png']]],
    ['cards:duplicate', ['front', 'a.png', 1]],
    ['decklists:write', ['deck', 'text', { keepBoth: true }]],
    ['env:usePython', [null]],
  ]);
});

test('events fan out to all callbacks with the payload only; unsubscribe works; errors are contained', () => {
  const { api, onHandlers, consoleErrors } = loadPreload();
  const fire = (ch, payload) => onHandlers.get(ch)[0]({ sender: 'ipc-event-object' }, payload);
  const a = [];
  const b = [];
  const offA = api.jobs.onEvent((...args) => a.push(args));
  api.jobs.onEvent((...args) => b.push(args));
  api.jobs.onEvent(() => { throw new Error('listener bug'); });
  fire('jobs:event', { type: 'progress', percent: 10 });
  assert.deepEqual(a, [[{ type: 'progress', percent: 10 }]]);
  assert.deepEqual(b, [[{ type: 'progress', percent: 10 }]]);
  assert.equal(consoleErrors.length, 1);
  offA();
  offA(); // idempotent
  fire('jobs:event', { type: 'log' });
  assert.equal(a.length, 1);
  assert.equal(b.length, 2);

  const s = [];
  const offS = api.settings.onChanged((x) => s.push(x));
  fire('settings:changed', { theme: 'dark' });
  fire('cards:changed', { reason: 'x' }); // other channel: not delivered to settings listeners
  assert.deepEqual(s, [{ theme: 'dark' }]);
  offS();
  const c = [];
  api.on('cards:changed', (x) => c.push(x));
  fire('cards:changed', 1);
  assert.deepEqual(c, [1]);
  assert.throws(() => api.on('settings:update', () => {}));
  assert.throws(() => api.cards.onChanged('not a function'));
});

test('app:notice events received before the first subscriber are delivered to it', async () => {
  const { api, onHandlers } = loadPreload();
  const fire = (payload) => onHandlers.get('app:notice')[0]({}, payload);
  fire({ title: 'one' });
  fire({ title: 'two' });
  const got = [];
  api.app.onNotice((n) => got.push(n.title));
  await tick();
  assert.deepEqual(got, ['one', 'two']);
  fire({ title: 'three' });
  assert.deepEqual(got, ['one', 'two', 'three']);
  // jobs events are not buffered
  onHandlers.get('jobs:event')[0]({}, { type: 'log' });
  const jobs = [];
  api.jobs.onEvent((e) => jobs.push(e));
  await tick();
  assert.deepEqual(jobs, []);
});

test('Electron\'s "Error invoking remote method" prefix is stripped (BUSY: stays recognizable)', async () => {
  const messages = {
    'cards:add': "Error invoking remote method 'cards:add': Error: BUSY: wait until \"Downloading cards\" finishes",
    'cards:list': "Error invoking remote method 'cards:list': TypeError: kind must be one of: front, back, double_sided",
    'engine:introspect': "Error invoking remote method 'engine:introspect': Error: NOT_READY",
    'pdf:plan': 'plain failure',
  };
  const { api } = loadPreload({
    invokeImpl: async (channel) => { throw new Error(messages[channel]); },
  });
  await assert.rejects(api.cards.add('front', []), (err) => err.message === 'BUSY: wait until "Downloading cards" finishes');
  await assert.rejects(api.cards.list('x'), (err) => err.message === 'kind must be one of: front, back, double_sided');
  await assert.rejects(api.engine.introspect(), (err) => err.message === 'NOT_READY');
  await assert.rejects(api.pdf.plan({}), (err) => err.message === 'plain failure');

  const sync = loadPreload({ invokeImpl: () => { throw new Error("Error invoking remote method 'x': Error: An object could not be cloned."); } });
  await assert.rejects(sync.api.pdf.plan({}), (err) => err.message === 'An object could not be cloned.');
});

test('files.pathForFile uses webUtils and returns \'\' when there is no file on disk', () => {
  const { api } = loadPreload();
  assert.equal(api.files.pathForFile({ kind: 'file', path: 'C:\\Users\\me\\a b #1.png' }), 'C:\\Users\\me\\a b #1.png');
  assert.equal(api.files.pathForFile({ kind: 'file', path: '' }), '');
  assert.equal(api.files.pathForFile({ kind: 'blob' }), '');
  assert.equal(api.files.pathForFile(null), '');
});

// ---------------------------------------------------------------------------------------------
// 3. ipc.js wrapper behavior (fake ipcMain / window / services; no Electron)
// ---------------------------------------------------------------------------------------------

const { registerIpc } = require('../../src/main/ipc');
const { getPaths } = require('../../src/main/paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');

function setupIpc(t, { services = {}, jobs = null, depsExtra = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const appDir = path.join(root, 'app'); // dev build: the bundled engine would be <app>/build/engine
  const workspace = path.join(root, 'ws');
  const userData = path.join(root, 'ud');
  for (const d of [appDir, path.join(workspace, 'game', 'front'), path.join(workspace, 'game', 'decklist'), userData]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const indexHtmlPath = path.join(appDir, 'src', 'renderer', 'index.html');
  const settings = createSettingsStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 5 });
  const silent = { info() {}, warn() {}, error() {} };
  const opened = [];
  const external = [];
  const deps = {
    app: {
      isPackaged: false,
      getVersion: () => '1.2.3',
      getLocale: () => 'fr-FR',
      getLocaleCountryCode: () => 'FR',
      getPath: (name) => (name === 'userData' ? userData : root),
    },
    getPaths: () => getPaths({
      isPackaged: false,
      appDir,
      userData,
      documents: root,
      localAppData: path.join(root, 'local'),
      platform: process.platform,
      env: { SCM_WORKSPACE_DIR: workspace, SCM_DATA_DIR: path.join(root, 'data') },
      settings: settings.get(),
    }),
    settings,
    jobs,
    logger: silent,
    helper: null,
    noAutoOpen: false,
    openPath: async (p) => { opened.push(p); return ''; },
    showItemInFolder: () => {},
    openExternal: async (url) => { external.push(url); return true; },
    ...depsExtra,
  };
  const handlers = new Map();
  const ipcMain = {
    handle: (channel, fn) => {
      if (handlers.has(channel)) throw new Error(`second handler for ${channel}`);
      handlers.set(channel, fn);
    },
    removeHandler: (channel) => handlers.delete(channel),
  };
  const mainFrame = { url: `${pathToFileURL(indexHtmlPath).href}#/cards`, parent: null, detached: false };
  let destroyed = false;
  const win = { isDestroyed: () => destroyed, webContents: { id: 7, mainFrame } };
  const dialogCalls = [];
  let nextDialogResult = { canceled: true, filePaths: [] };
  const dialog = {
    showOpenDialog: async (...args) => { dialogCalls.push(args); return nextDialogResult; },
    showSaveDialog: async (...args) => { dialogCalls.push(args); return nextDialogResult; },
  };
  const loadService = (name) => {
    if (services[name]) return services[name];
    const err = new Error(`Part of the app is missing (${name}.js). Please reinstall Kirigami.`);
    err.code = 'SERVICE_UNAVAILABLE';
    throw err;
  };
  const result = registerIpc(ipcMain, deps, {
    dialog, shell: null, getMainWindow: () => win, indexHtmlPath, loadService,
  });
  const trusted = { sender: { id: 7 }, senderFrame: mainFrame };
  const invoke = (channel, ...args) => handlers.get(channel)(trusted, ...args);
  return {
    root, workspace, deps, handlers, invoke, result, win, mainFrame, opened, external, dialogCalls, settings,
    setDialogResult: (r) => { nextDialogResult = r; },
    destroyWindow: () => { destroyed = true; },
  };
}

test('ipc.js registers exactly the contract channels', (t) => {
  const { handlers, result } = setupIpc(t);
  assert.deepEqual([...handlers.keys()].sort(), [...EXPECTED_CHANNELS].sort());
  assert.deepEqual([...result.channels].sort(), [...EXPECTED_CHANNELS].sort());
});

test('requests from anything but the main window\'s top frame showing index.html are refused', async (t) => {
  const ctx = setupIpc(t);
  const handler = ctx.handlers.get('app:info');
  const goodUrl = ctx.mainFrame.url;
  const refused = (event) => assert.rejects(handler(event), /did not come from the app window/);
  await refused({ sender: { id: 8 }, senderFrame: ctx.mainFrame });
  await refused({ sender: { id: 7 }, senderFrame: { url: goodUrl, parent: ctx.mainFrame, detached: false } });
  await refused({ sender: { id: 7 }, senderFrame: { url: 'https://evil.example/index.html', parent: null } });
  await refused({ sender: { id: 7 }, senderFrame: { url: pathToFileURL(path.join(ctx.root, 'other.html')).href, parent: null } });
  await refused({ sender: { id: 7 }, senderFrame: { url: goodUrl, parent: null, detached: true } });
  await refused({ sender: { id: 7 }, senderFrame: null });
  await refused({});
  const info = await handler({ sender: { id: 7 }, senderFrame: { url: `${goodUrl}?x=1`, parent: null } });
  assert.equal(info.version, '1.2.3');
  assert.equal(info.country, 'FR');
  assert.equal(info.paths.workspace, ctx.workspace);
  ctx.destroyWindow();
  await refused({ sender: { id: 7 }, senderFrame: ctx.mainFrame });
});

test('a missing service module gives a clear error and the rest keeps working', async (t) => {
  const ctx = setupIpc(t);
  await assert.rejects(ctx.invoke('cards:summary'), /Part of the app is missing \(cards\.js\)/);
  await assert.rejects(ctx.invoke('pdf:plan', {}), /missing \(pdf\.js\)/);
  assert.equal((await ctx.invoke('settings:get')).theme, 'system');
  assert.equal(await ctx.invoke('jobs:active'), null, 'no job manager → no active job');
  assert.deepEqual(await ctx.invoke('jobs:history'), []);
  const status = await ctx.invoke('env:status', { refresh: true });
  assert.equal(status.ready, false);
  assert.match(status.python.error, /python-env\.js/);
  assert.equal(status.upscayl.found, false);
  assert.ok('found' in status.silhouetteStudio);
});

test('a service module without the expected function is reported as missing', async (t) => {
  const ctx = setupIpc(t, { services: { cards: { somethingElse() {} } } });
  await assert.rejects(ctx.invoke('cards:summary'), /missing \(cards\.summary\)/);
});

test('arguments are validated (kinds, relative paths, absolute paths, URLs)', async (t) => {
  const calls = [];
  const cards = new Proxy({}, { get: (_o, fn) => (...args) => { calls.push([fn, ...args.slice(1)]); return { ok: true }; } });
  const ctx = setupIpc(t, { services: { cards } });
  const bad = [
    ['cards:list', 'evil'],
    ['cards:list', '../front'],
    ['cards:add', 'double_sided', [path.join(ctx.root, 'a.png')]],
    ['cards:add', 'front', ['relative.png']],
    ['cards:add', 'front', 'not-a-list'],
    ['cards:remove', 'front', ['../escape.png']],
    ['cards:remove', 'front', [path.join(ctx.root, 'abs.png')]],
    ['cards:remove', 'front', ['']],
    ['cards:duplicate', 'front', 'a.png', 0],
    ['cards:duplicate', 'front', 'a.png', 1000],
    ['cards:setBack', { mode: 'sometimes' }],
    ['cards:setBack', { mode: 'file', file: '../x.png' }],
    ['cards:restore', '../batch'],
    ['cards:clear', 'front', { includePartners: 'yes' }],
    ['shell:openExternal', 'file:///C:/Windows/notepad.exe'],
    ['shell:openExternal', 'javascript:alert(1)'],
    ['shell:openExternal', 'not a url'],
    ['decklists:read', '../secret.txt'],
    ['decklists:read', 'sub/deck.txt'],
    ['jobs:cancel', '../x'],
    ['settings:update', 'theme=dark'],
    ['env:setWorkspace', 'relative\\folder'],
  ];
  for (const [channel, ...args] of bad) {
    await assert.rejects(ctx.invoke(channel, ...args), Error, `${channel} ${JSON.stringify(args)}`);
  }
  assert.deepEqual(calls, [], 'no service was called with invalid input');

  await ctx.invoke('cards:remove', 'front', ['a.png', 'sub/b é #1.png']);
  await ctx.invoke('cards:duplicate', 'double_sided', 'x.png');
  await ctx.invoke('cards:add', 'front', ['', path.join(ctx.root, 'new.png')]);
  await ctx.invoke('cards:setBack', { mode: 'file', file: 'back.png' });
  await ctx.invoke('cards:clear', 'front');
  assert.deepEqual(calls, [
    ['removeCards', 'front', ['a.png', 'sub/b é #1.png']],
    ['duplicateCard', 'double_sided', 'x.png', 1],
    ['addCards', 'front', ['', path.join(ctx.root, 'new.png')]],
    ['setBack', { mode: 'file', file: 'back.png' }],
    ['clearCards', 'front', { includePartners: false }],
  ]);
  assert.equal(await ctx.invoke('shell:openExternal', 'https://upscayl.org'), true);
  assert.deepEqual(ctx.external, ['https://upscayl.org/']);
});

test('services get deps first; job starters always answer { jobId }', async (t) => {
  let received = null;
  const ctx = setupIpc(t, {
    services: {
      fetch: { startFetchJob: (deps, req) => { received = { deps, req }; return 'job-42'; } },
      pdf: { startPdfJob: () => ({ jobId: 'job-7' }), planPdf: (deps, o) => ({ ok: true, echo: o }) },
    },
  });
  const req = {
    plugin: 'mtg', format: 'mtga', source: { kind: 'text', text: '4 Island', deckName: 'my-deck' }, options: {}, clearBeforeFetch: true,
  };
  assert.deepEqual(await ctx.invoke('fetch:start', req), { jobId: 'job-42' });
  assert.equal(received.deps, ctx.deps);
  assert.deepEqual(received.req, req);
  assert.deepEqual(await ctx.invoke('pdf:start', { ppi: 300 }), { jobId: 'job-7' });
  assert.deepEqual(await ctx.invoke('pdf:plan', { ppi: 300 }), { ok: true, echo: { ppi: 300 } });
  await assert.rejects(ctx.invoke('fetch:start', { ...req, plugin: 'mtg/../x' }), /Unknown game/);
  await assert.rejects(ctx.invoke('fetch:start', { ...req, source: { kind: 'shell' } }), /source kind/);
});

test('BUSY while a mutating job runs; NOT_READY before the components are ready', async (t) => {
  const jobs = {
    isMutating: () => true,
    active: () => ({ jobId: 'j1', kind: 'fetch', title: 'Downloading cards' }),
    history: () => [],
    on() {},
  };
  let envReady = false;
  const introspectCalls = [];
  const ctx = setupIpc(t, {
    jobs,
    services: {
      cards: { removeCards: () => ({ removed: 1 }), listCards: () => ({ images: [] }) },
      'python-env': { checkEnv: () => ({ ready: envReady, workspace: { ok: true }, python: { ok: envReady } }) },
    },
    depsExtra: { helper: { introspect: (o) => { introspectCalls.push(o); return { engineVersion: 'x' }; } } },
  });
  await assert.rejects(ctx.invoke('cards:remove', 'front', ['a.png']), (err) => err.message === 'BUSY: wait until "Downloading cards" finishes');
  await assert.rejects(ctx.invoke('settings:reset'), /^Error: BUSY:/);
  assert.deepEqual(await ctx.invoke('cards:list', 'front'), { images: [] }, 'reads still work');
  await assert.rejects(ctx.invoke('engine:introspect', {}), (err) => err.message === 'NOT_READY');
  envReady = true;
  assert.deepEqual(await ctx.invoke('engine:introspect', { force: true }), { engineVersion: 'x' });
  assert.deepEqual(introspectCalls, [{ force: true }]);
});

test('engine update channels call the engine updater after startup, and say when it is missing', async (t) => {
  const calls = [];
  const engineUpdater = {
    status: () => { calls.push('status'); return { phase: 'idle' }; },
    checkNow: (o) => { calls.push(['checkNow', o]); return { phase: 'checking' }; },
    rollback: () => { calls.push('rollback'); return { phase: 'waiting' }; },
  };
  let ready;
  const ctx = setupIpc(t, { depsExtra: { engineUpdater, ready: new Promise((resolve) => { ready = resolve; }) } });
  const pending = ctx.invoke('engine:updateStatus');
  await tick();
  assert.deepEqual(calls, [], 'waits for the startup tasks (the engine is chosen there)');
  ready({ ok: true });
  assert.deepEqual(await pending, { phase: 'idle' });
  assert.deepEqual(await ctx.invoke('engine:checkUpdate', 'ignored'), { phase: 'checking' });
  assert.deepEqual(await ctx.invoke('engine:rollback'), { phase: 'waiting' });
  assert.deepEqual(calls, ['status', ['checkNow', { manual: true }], 'rollback']);

  const missing = setupIpc(t);
  for (const channel of ['engine:updateStatus', 'engine:checkUpdate', 'engine:rollback']) {
    await assert.rejects(missing.invoke(channel), /Part of the app is missing \(engine-updater\.js\)/, channel);
  }
});

test('env:status aggregates python-env, Upscayl and Silhouette Studio; one failure does not break the rest', async (t) => {
  const ctx = setupIpc(t, {
    services: {
      'python-env': { checkEnv: (deps, o) => ({ ready: true, refreshed: o.refresh, workspace: { ok: true }, python: { ok: true }, uv: { available: true } }) },
      upscayl: { getUpscaylStatus: () => { throw new Error('registry timeout'); } },
      registry: {
        queryUninstall: async (pattern) => {
          assert.equal(pattern, 'Silhouette Studio*');
          return [{ DisplayName: 'Silhouette Studio', DisplayVersion: '5.0.081', DisplayIcon: '"C:\\Nowhere\\Silhouette Studio.exe",0', InstallLocation: '' }];
        },
      },
    },
  });
  const st = await ctx.invoke('env:status', { refresh: true });
  assert.equal(st.ready, true);
  assert.equal(st.refreshed, true);
  assert.equal(st.upscayl.found, false);
  assert.equal(st.upscayl.error, 'registry timeout');
  assert.deepEqual(st.upscayl.models, []);
  assert.deepEqual(st.silhouetteStudio, { found: true, path: 'C:\\Nowhere\\Silhouette Studio.exe', version: '5.0.081' });
});

test('settings: protected keys refused from the renderer; raw fs errors become friendly messages', async (t) => {
  const ctx = setupIpc(t, {
    services: {
      decklists: {
        readDecklist: () => {
          const err = new Error("ENOENT: no such file or directory, open 'C:\\x\\deck.txt'");
          err.code = 'ENOENT';
          err.syscall = 'open';
          err.path = 'C:\\x\\deck.txt';
          throw err;
        },
      },
    },
  });
  await assert.rejects(ctx.invoke('settings:update', { workspaceDir: 'C:\\evil' }), /can only be changed/);
  await assert.rejects(ctx.invoke('settings:update', { ui: null }), /must be an object/);
  const s = await ctx.invoke('settings:update', { theme: 'dark' });
  assert.equal(s.theme, 'dark');
  await assert.rejects(ctx.invoke('decklists:read', 'deck.txt'), (err) => err.message === 'Could not find "C:\\x\\deck.txt".');
});

test('settings:reset restores defaults and drops cached environment results when the Python changes', async (t) => {
  let envInvalidated = 0;
  let helperInvalidated = 0;
  const ctx = setupIpc(t, {
    services: { 'python-env': { invalidateEnvCache: () => { envInvalidated += 1; } } },
    depsExtra: { helper: { invalidate: () => { helperInvalidated += 1; } } },
  });
  ctx.settings.update({ theme: 'dark' });
  const reset1 = await ctx.invoke('settings:reset');
  assert.equal(reset1.theme, 'system');
  assert.deepEqual([envInvalidated, helperInvalidated], [0, 0], 'same Python: caches kept');
  ctx.settings.update({ pythonPath: path.join(ctx.root, 'py', 'python.exe') }, { internal: true });
  const reset2 = await ctx.invoke('settings:reset');
  assert.equal(reset2.pythonPath, null);
  assert.deepEqual([envInvalidated, helperInvalidated], [1, 1]);
});

test('shell:openPath allowlist: managed folders + allowed extensions, any folder, outputs of finished jobs', async (t) => {
  const listeners = [];
  const jobs = { isMutating: () => false, active: () => null, on: (ev, fn) => listeners.push(fn) };
  const ctx = setupIpc(t, { jobs });
  const pdf = path.join(ctx.workspace, 'game', 'output', 'deck.pdf');
  fs.mkdirSync(path.dirname(pdf), { recursive: true });
  fs.writeFileSync(pdf, '%PDF');
  const exe = path.join(ctx.workspace, 'game', 'output', 'evil.exe');
  fs.writeFileSync(exe, 'MZ');
  const outsidePdf = path.join(ctx.root, 'elsewhere', 'other.pdf');
  fs.mkdirSync(path.dirname(outsidePdf), { recursive: true });
  fs.writeFileSync(outsidePdf, '%PDF');

  assert.equal(await ctx.invoke('shell:openPath', pdf), true);
  assert.equal(await ctx.invoke('shell:openPath', path.dirname(outsidePdf)), true, 'folders anywhere');
  await assert.rejects(ctx.invoke('shell:openPath', exe), /doesn't open \.exe files/);
  await assert.rejects(ctx.invoke('shell:openPath', outsidePdf), /only opens files from its own folders/);
  await assert.rejects(ctx.invoke('shell:openPath', path.join(ctx.root, 'missing.pdf')), /Could not find/);
  await assert.rejects(ctx.invoke('shell:openPath', 'relative.pdf'), /full path/);

  for (const fn of listeners) fn({ type: 'finished', jobId: 'j9', result: { pdfPath: outsidePdf } });
  assert.equal(await ctx.invoke('shell:openPath', outsidePdf), true, 'last job output is allowed');
  assert.deepEqual(ctx.opened, [pdf, path.dirname(outsidePdf), outsidePdf]);

  ctx.deps.openPath = async () => 'No application is associated with the specified file';
  await assert.rejects(ctx.invoke('shell:openPath', pdf), /could not open "deck\.pdf": No application/);
});

test('dialogs validate options, remember the last folder per purpose and return paths', async (t) => {
  const ctx = setupIpc(t);
  const chosenDir = path.join(ctx.root, 'downloads');
  fs.mkdirSync(chosenDir, { recursive: true });
  const chosen = path.join(chosenDir, 'deck.txt');
  ctx.setDialogResult({ canceled: false, filePaths: [chosen] });
  const result = await ctx.invoke('dialog:openFile', { purpose: 'decklist', title: 'Choose a list', filters: [{ name: 'Text', extensions: ['.txt', 'dek'] }] });
  assert.equal(result, chosen);
  const [win, options] = ctx.dialogCalls[0];
  assert.equal(win, ctx.win, 'modal to the main window');
  assert.deepEqual(options.filters, [{ name: 'Text', extensions: ['txt', 'dek'] }]);
  assert.ok(options.properties.includes('openFile'));
  assert.equal(ctx.settings.get().ui.lastDirs.decklist, chosenDir);

  ctx.setDialogResult({ canceled: true, filePaths: [] });
  assert.equal(await ctx.invoke('dialog:openFile', { purpose: 'decklist' }), null);
  assert.equal(ctx.dialogCalls[1][1].defaultPath, chosenDir, 'starts in the remembered folder');
  assert.deepEqual(await ctx.invoke('dialog:openFiles', { purpose: 'images' }), []);

  ctx.setDialogResult({ canceled: false, filePath: path.join(chosenDir, 'out.pdf') });
  assert.equal(await ctx.invoke('dialog:saveFile', { purpose: 'pdf', defaultName: 'my:deck?.pdf' }), path.join(chosenDir, 'out.pdf'));
  assert.equal(path.basename(ctx.dialogCalls[3][1].defaultPath), 'mydeck.pdf', 'default name sanitized');

  await assert.rejects(ctx.invoke('dialog:openFile', { purpose: '__proto__' }), /purpose/);
  await assert.rejects(ctx.invoke('dialog:openFile', { filters: [{ name: 'x', extensions: ['p/ng'] }] }), /filters/);
});

test('updates:* forward to the app updater; a missing updater is reported, not a crash', async (t) => {
  const calls = [];
  const appUpdater = {
    state: () => ({ mode: 'auto', phase: 'idle' }),
    check: async (o) => { calls.push(['check', o]); return { mode: 'auto', phase: 'up-to-date' }; },
    install: async () => { calls.push(['install']); throw Object.assign(new Error('BUSY: wait until "Making the PDF" finishes, then restart to update'), { code: 'BUSY' }); },
  };
  const ctx = setupIpc(t, { depsExtra: { appUpdater } });
  assert.deepEqual(await ctx.invoke('updates:state'), { mode: 'auto', phase: 'idle' });
  assert.deepEqual(await ctx.invoke('updates:check', 'ignored'), { mode: 'auto', phase: 'up-to-date' });
  await assert.rejects(ctx.invoke('updates:install'), (err) => err.message === 'BUSY: wait until "Making the PDF" finishes, then restart to update');
  assert.deepEqual(calls, [['check', { manual: true }], ['install']], 'a check from the window is always manual');

  const bare = setupIpc(t);
  await assert.rejects(bare.invoke('updates:state'), /Part of the app is missing \(app-updater\.js\)/);
});
