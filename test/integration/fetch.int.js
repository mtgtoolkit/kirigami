#!/usr/bin/env node
'use strict';

/**
 * Integration checks for fetch.js + fetch-parse.js + decklists.js + cards.js (and the helper's
 * make-test-cards) against the REAL engine plugins, the engine's Python and the card websites.
 * No Electron: deps are built from the real modules (paths.getPaths linked to the engine with
 * SCM_ENGINE_DIR, plus SCM_WORKSPACE_DIR / SCM_DATA_DIR; settings store in a temp userData,
 * JobManager, locks, helper, hash cache). The engine and the Python come from test/support/engine.js
 * (normally .engine-src and .engine-src/venv: npm run engine:checkout -- --venv).
 *
 * Safety: ensureWorkspace() copies the engine code (root *.py, requirements.txt, assets/,
 * plugins/) into a TEMP managed workspace; plugins write to <temp workspace>/game/… because they
 * derive their folders from their own location. The engine's game/, data/ and venv are only
 * read (the venv's Python runs the plugins; bytecode writing is disabled).
 * Network access is required (Scryfall, YGOPRODeck).
 *
 * Usage (from the repository root):
 *   node test/integration/fetch.int.js [--python <exe>] [--keep] [--tmp <dir>] [--skip-cancel]
 * --python defaults to SCM_TEST_PYTHON, else <engine>/venv.
 * Set SCM_INT_VERBOSE=1 to print the job logs.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { getPaths, venvPython } = require('../../src/main/paths');
const { createSettingsStore, DEFAULT_SETTINGS } = require('../../src/main/settings');
const { JobManager } = require('../../src/main/jobs');
const { createLocks } = require('../../src/main/locks');
const { createHelper } = require('../../src/main/helper');
const { createHashCache } = require('../../src/main/scan');
const { readImageSize } = require('../../src/main/image-meta');
const workspace = require('../../src/main/workspace');
const cards = require('../../src/main/cards');
const decklists = require('../../src/main/decklists');
const fetch = require('../../src/main/fetch');
const { REPO_DIR: APP_DIR, ENGINE_DIR: ENGINE, TEST_PYTHON, engineSkip } = require('../support/engine');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DEFAULT_PYTHON = ENGINE ? venvPython(path.join(ENGINE, 'venv')) : null;
const PYTHON = option('--python', TEST_PYTHON) ? path.resolve(option('--python', TEST_PYTHON)) : null;
const TMP_PARENT = option('--tmp', os.tmpdir());
const VERBOSE = !!process.env.SCM_INT_VERBOSE;
const NOT_FOUND = 'not found: check spelling or set code';

let failures = 0;
const results = [];

async function check(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ name, ok: true, ms, note });
    console.log(`PASS  ${name} (${ms} ms)${note ? ` - ${note}` : ''}`);
  } catch (err) {
    failures += 1;
    const ms = Date.now() - started;
    results.push({ name, ok: false, ms, note: err.message });
    console.log(`FAIL  ${name} (${ms} ms)\n      ${String(err.stack || err).split('\n').slice(0, 8).join('\n      ')}`);
    if (err.details) console.log(`      details: ${String(err.details).split('\n').slice(-10).join('\n      ')}`);
  }
}

const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => !/^(README|EMPTY)\.md$/i.test(n)).sort() : []);

function makeDeps(tmp) {
  const userData = path.join(tmp, 'userData');
  const dataDir = path.join(tmp, 'data');
  const ws = path.join(tmp, 'workspace');
  fs.mkdirSync(userData, { recursive: true });
  const settings = createSettingsStore(path.join(userData, 'settings.json'), DEFAULT_SETTINGS, { debounceMs: 50 });
  // Linked mode (SCM_ENGINE_DIR) uses <engine>/venv by default; another interpreter is set like "Use a different Python".
  if (PYTHON.toLowerCase() !== path.resolve(DEFAULT_PYTHON).toLowerCase()) settings.update({ pythonPath: PYTHON }, { internal: true });
  const base = {
    isPackaged: false,
    appDir: APP_DIR,
    userData,
    appData: tmp,
    documents: path.join(tmp, 'Documents'),
    localAppData: null,
    platform: process.platform,
    env: { SCM_ENGINE_DIR: ENGINE, SCM_WORKSPACE_DIR: ws, SCM_DATA_DIR: dataDir },
  };
  const emitted = [];
  const logLine = (level) => (...a) => {
    if (VERBOSE || level === 'error') console.log(`      [${level}] ${a.map((x) => (x instanceof Error ? x.message : String(x))).join(' ')}`);
  };
  const deps = {
    app: { getVersion: () => 'integration', isPackaged: false },
    settings,
    getPaths: () => getPaths({ ...base, settings: settings.get() }),
    logger: { info: logLine('info'), warn: logLine('warn'), error: logLine('error') },
    emit: (channel, payload) => emitted.push({ channel, payload }),
    isTest: true,
    noAutoOpen: true,
    openPath: async () => '',
    showItemInFolder: () => {},
    watcher: null,
  };
  const p = deps.getPaths();
  deps.jobs = new JobManager({ logsDir: p.logsDir, scmCacheDir: p.scmCacheDir });
  deps.locks = createLocks();
  deps.helper = createHelper(() => deps);
  deps.hashCache = createHashCache(path.join(p.scmCacheDir, 'hashes.json'));
  deps.jobs.on('event', (evt) => {
    if (!VERBOSE) return;
    if (evt.type === 'log') for (const l of evt.lines) console.log(`      | ${l.stream === 'stderr' ? '[stderr] ' : ''}${l.line}`);
    else if (evt.type === 'progress' && evt.label) console.log(`      ~ ${evt.label}`);
  });
  return { deps, emitted, ws, dataDir, userData };
}

/** Start a job and wait for it; returns the finished summary + duration. */
async function runJob(deps, startPromise) {
  const t0 = Date.now();
  const started = await startPromise;
  const jobId = typeof started === 'string' ? started : started.jobId;
  const done = await deps.jobs.whenFinished(jobId);
  done.wallMs = Date.now() - t0;
  return done;
}

function describeFailure(done) {
  return done.error ? `${done.error.code}: ${done.error.message}\n${done.error.details || ''}` : JSON.stringify(done.warnings);
}

async function main() {
  const noEngine = engineSkip();
  assert.ok(!noEngine, noEngine);
  console.log(`Engine: ${ENGINE}`);
  console.log(`Python: ${PYTHON}`);
  assert.ok(PYTHON && fs.existsSync(PYTHON), `Python not found: ${PYTHON} (use --python <exe> or SCM_TEST_PYTHON)`);
  fs.mkdirSync(TMP_PARENT, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(TMP_PARENT, 'scm-fetch-int-'));
  console.log(`Temp:   ${tmp}`);
  const engineGame = path.join(ENGINE, 'game', 'front');
  const engineBefore = listFiles(engineGame).join('|');
  const { deps, ws } = makeDeps(tmp);
  const dir = (kind) => path.join(ws, 'game', kind);

  try {
    await check('temp managed workspace: engine code copied, game folders created', async () => {
      const r = await workspace.ensureWorkspace(deps, () => {});
      assert.equal(r.mode, 'managed');
      assert.equal(path.resolve(deps.getPaths().workspaceDir), path.resolve(ws));
      for (const rel of ['create_pdf.py', 'utilities.py', 'plugins/mtg/fetch.py', 'plugins/yugioh/fetch.py', 'assets/arial.ttf']) assert.ok(fs.existsSync(path.join(ws, rel)), rel);
      for (const kind of ['front', 'back', 'double_sided', 'decklist']) assert.ok(fs.existsSync(dir(kind)), kind);
      return ws;
    });

    let intro;
    await check('engine description (introspection) for plugin validation', async () => {
      intro = await deps.helper.introspect({});
      assert.ok(intro.plugins.find((p) => p.id === 'mtg' && !p.error));
      return `${intro.plugins.length} plugins`;
    });

    let first;
    await check('real MTG download: MTG Arena list with 3 real cards, a misspelled card, headers and a blank line', async () => {
      const text = 'Deck\n1 Lightning Bolt\n1 Sol Ring\n1 Llanowar Elves\n\nSideboard\n1 Lightnig Boltt\n';
      first = await runJob(deps, fetch.startFetchJob(deps, {
        plugin: 'mtg', format: 'mtga', source: { kind: 'text', text, deckName: 'mylands' }, options: {}, clearBeforeFetch: false,
      }));
      assert.equal(first.status, 'succeeded', describeFailure(first));
      const r = first.result;
      assert.equal(r.added, 3);
      assert.equal(r.front, 3);
      assert.equal(r.double_sided, 0);
      assert.equal(r.deckPath, 'game/decklist/mylands.txt');
      assert.equal(fs.readFileSync(path.join(dir('decklist'), 'mylands.txt'), 'utf8'), text);
      assert.equal(r.failedCards.length, 1, JSON.stringify(r.failedCards));
      assert.deepEqual({ name: r.failedCards[0].name, quantity: r.failedCards[0].quantity, reason: r.failedCards[0].reason }, { name: 'Lightnig Boltt', quantity: 1, reason: NOT_FOUND });
      assert.deepEqual(r.ignoredLines, ['Deck', 'Sideboard']);
      assert.equal(r.previousBatchId, null);
      const files = listFiles(dir('front'));
      assert.equal(files.length, 3, files.join(', '));
      const squeezed = files.map((f) => f.replace(/\s+/g, '').toLowerCase());
      for (const name of ['lightningbolt', 'solring', 'llanowarelves']) assert.ok(squeezed.some((f) => f.includes(name)), `${name} in ${files.join(', ')}`);
      const lf = deps.settings.get().fetch.lastFetched;
      assert.deepEqual([lf.plugin, lf.format, lf.deckName, lf.added], ['mtg', 'mtga', 'mylands', 3]);
      return `${first.wallMs} ms; files: ${files.join(', ')}`;
    });

    await check('the downloaded cards are listed with hashes, sizes and image URLs', async () => {
      const list = await cards.listCards(deps, 'front');
      assert.equal(list.images.length, 3);
      for (const img of list.images) {
        assert.match(img.hash, /^[0-9a-f]{40}$/);
        assert.match(img.url, /^scm-img:\/\/file\/[A-Za-z0-9_-]+\?v=\d+$/);
        assert.ok(img.width > 400 && img.height > 500, `${img.rel}: ${img.width}x${img.height}`);
        assert.equal(img.partner, null);
        assert.equal(img.upscaled, false);
      }
      const s = await cards.summary(deps);
      assert.equal(s.front, 3);
      assert.deepEqual(s.warnings, []);
      return list.images.map((i) => `${i.name} ${i.width}x${i.height}`).join('; ');
    });

    await check('"Start fresh" + a run where every card fails: the previous cards are put back', async () => {
      const before = listFiles(dir('front'));
      const done = await runJob(deps, fetch.startFetchJob(deps, {
        plugin: 'mtg', format: 'mtga', source: { kind: 'text', text: '1 Zzqx Notacard Qqq\n1 Blorbo The Unprintable\n', deckName: 'bad-list' }, options: {}, clearBeforeFetch: true,
      }));
      assert.equal(done.status, 'failed', 'the run must fail');
      assert.equal(done.error.code, 'ALL_CARDS_FAILED', describeFailure(done));
      assert.match(done.error.message, /^No images were downloaded\. Every card failed \(for example "Zzqx Notacard Qqq": not found: check spelling or set code\)\.$/);
      assert.ok(done.warnings.includes('Your previous cards were put back.'), JSON.stringify(done.warnings));
      assert.deepEqual(listFiles(dir('front')), before);
      assert.deepEqual(await cards.trashList(deps), [], 'the set-aside batch was restored and removed');
      return `${done.wallMs} ms; "${done.error.message}"`;
    });

    await check('"Start fresh" + a plugin crash (broken Scryfall JSON): plain message, previous cards put back', async () => {
      const before = listFiles(dir('front'));
      const done = await runJob(deps, fetch.startFetchJob(deps, {
        plugin: 'mtg', format: 'scryfall_json', source: { kind: 'text', text: '{"entries": [not json', deckName: 'broken' }, options: {}, clearBeforeFetch: true,
      }));
      assert.equal(done.status, 'failed');
      assert.equal(done.error.code, 'LIST_UNREADABLE', describeFailure(done));
      assert.match(done.error.message, /^The card downloader couldn't read your list as ".+"\. Check that this is the right list format/);
      assert.doesNotMatch(done.error.message, /Traceback|File "|JSONDecodeError/, 'no Python details in the message');
      assert.match(done.error.details, /JSONDecodeError/);
      assert.ok(done.warnings.includes('Your previous cards were put back.'), JSON.stringify(done.warnings));
      assert.deepEqual(listFiles(dir('front')), before);
      return `${done.error.code}: "${done.error.message}"`;
    });

    if (!flag('--skip-cancel')) {
      await check('"Start fresh" + cancelling a real download: Python is stopped and the previous cards come back', async () => {
        const before = listFiles(dir('front'));
        const text = ['Forest', 'Island', 'Swamp', 'Mountain', 'Plains', 'Opt', 'Shock', 'Duress', 'Negate', 'Divination', 'Ponder', 'Preordain']
          .map((n) => `1 ${n}`).join('\n');
        const startedAt = Date.now();
        const jobId = await fetch.startFetchJob(deps, {
          plugin: 'mtg', format: 'mtga', source: { kind: 'text', text, deckName: 'to-cancel' }, options: {}, clearBeforeFetch: true,
        });
        let seen = false;
        const onEvent = (evt) => {
          if (evt.jobId === jobId && evt.type === 'progress' && /^Card \d+: /.test(evt.label || '')) seen = true;
        };
        deps.jobs.on('event', onEvent);
        for (let i = 0; i < 600 && !seen; i += 1) await new Promise((r) => setTimeout(r, 50));
        deps.jobs.off('event', onEvent);
        assert.ok(seen, 'the download started');
        assert.ok(deps.jobs.cancel(jobId));
        const done = await deps.jobs.whenFinished(jobId);
        assert.equal(done.status, 'cancelled', describeFailure(done));
        assert.ok(done.warnings.includes('Your previous cards were put back.'), JSON.stringify(done.warnings));
        assert.deepEqual(listFiles(dir('front')), before);
        const trash = await cards.trashList(deps);
        assert.ok(trash.every((b) => b.reason === 'incomplete-download'), JSON.stringify(trash.map((b) => b.reason)));
        await cards.emptyTrash(deps);
        return `${Date.now() - startedAt} ms until cancelled (${trash.length ? `${trash[0].count} partial image(s) moved to the trash` : 'no partial image'})`;
      });
    }

    await check('"Start fresh" + a successful download: previous cards restorable from the trash', async () => {
      const before = listFiles(dir('front'));
      const done = await runJob(deps, fetch.startFetchJob(deps, {
        plugin: 'mtg', format: 'mtga', source: { kind: 'text', text: '1 Island\n', deckName: 'island' }, options: {}, clearBeforeFetch: true,
      }));
      assert.equal(done.status, 'succeeded', describeFailure(done));
      assert.match(done.result.previousBatchId, /-before-download-1$/);
      assert.equal(listFiles(dir('front')).length, 1);
      const restored = await cards.restoreBatch(deps, done.result.previousBatchId);
      assert.equal(restored.restored, before.length);
      assert.equal(listFiles(dir('front')).length, before.length + 1);
      return `${done.wallMs} ms`;
    });

    await check('real Yu-Gi-Oh! download from an inline YDKE code (no deck file)', async () => {
      const code = 'ydke://o6lXBaOpVwWu9MwC!!!';
      const done = await runJob(deps, fetch.startFetchJob(deps, {
        plugin: 'yugioh', format: 'ydke', source: { kind: 'text_inline', text: code, url: code }, options: {}, clearBeforeFetch: true,
      }));
      assert.equal(done.status, 'succeeded', describeFailure(done));
      assert.equal(done.result.added, 3);
      assert.equal(done.result.deckPath, code);
      assert.equal(listFiles(dir('front')).length, 3);
      return `${done.wallMs} ms`;
    });

    await check('decklists: list, read, write (keep both), remove to the trash and restore', async () => {
      const lists = await decklists.listDecklists(deps);
      const names = lists.map((l) => l.name);
      assert.ok(names.includes('mylands.txt'), names.join(', '));
      assert.match(await decklists.readDecklist(deps, 'mylands.txt'), /^Deck\n1 Lightning Bolt\n/);
      const w = await decklists.writeDecklist(deps, 'mylands', '1 Forest\n', { keepBoth: true });
      assert.equal(w.name, 'mylands (2).txt');
      const { batchId } = await decklists.removeDecklist(deps, 'mylands (2).txt');
      assert.ok(batchId);
      await cards.restoreBatch(deps, batchId);
      assert.ok(fs.existsSync(path.join(dir('decklist'), 'mylands (2).txt')));
      return `${lists.length} saved lists`;
    });

    await check('test cards job ("Try sample cards"): 9 numbered cards at the card size (300 PPI) + a test back', async () => {
      deps.settings.update({ pdf: { options: { card_size: 'standard' } }, cards: { back: { mode: 'none', file: null } } });
      const done = await runJob(deps, Promise.resolve(cards.startSamplesJob(deps, { replace: true })));
      assert.equal(done.status, 'succeeded', describeFailure(done));
      const r = done.result;
      assert.equal(r.added, 9);
      assert.deepEqual([r.cardSize, r.widthPx, r.heightPx], ['standard', 744, 1039]);
      assert.match(r.previousBatchId, /-before-samples-1$/);
      const fronts = listFiles(dir('front'));
      assert.deepEqual(fronts, Array.from({ length: 9 }, (_, i) => `Test card 0${i + 1}.png`));
      assert.deepEqual(listFiles(dir('back')), ['Test back.png']);
      const size = await readImageSize(path.join(dir('front'), 'Test card 05.png'));
      assert.deepEqual([size.width, size.height], [744, 1039]);
      const backSize = await readImageSize(path.join(dir('back'), 'Test back.png'));
      assert.deepEqual([backSize.width, backSize.height], [744, 1039]);
      assert.deepEqual(deps.settings.get().cards.back, { mode: 'auto', file: null });
      const s = await cards.summary(deps);
      assert.equal(s.front, 9);
      assert.deepEqual(s.back, { mode: 'auto', file: null, effective: 'Test back.png', problem: null });
      const trash = await cards.trashList(deps);
      assert.equal(trash[0].reason, 'before-samples');
      return `${done.wallMs} ms`;
    });

    await check('test cards follow the card size (Japanese, 59 x 86 mm) and keep an existing back', async () => {
      deps.settings.update({ pdf: { options: { card_size: 'japanese' } } });
      const done = await runJob(deps, Promise.resolve(cards.startSamplesJob(deps, { replace: false })));
      assert.equal(done.status, 'succeeded', describeFailure(done));
      assert.deepEqual([done.result.cardSize, done.result.widthPx, done.result.heightPx, done.result.back], ['japanese', 697, 1016, null]);
      assert.equal(listFiles(dir('front')).length, 18);
      assert.deepEqual(listFiles(dir('back')), ['Test back.png']);
      const size = await readImageSize(path.join(dir('front'), done.result.front[0]));
      assert.deepEqual([size.width, size.height], [697, 1016]);
      return `${done.wallMs} ms; first: ${done.result.front[0]}`;
    });

    await check("the engine's own game/ folder was not touched", async () => {
      assert.equal(listFiles(engineGame).join('|'), engineBefore);
    });
  } finally {
    try {
      await deps.settings.flush();
      await deps.hashCache.flush();
    } catch { /* ignore */ }
    if (flag('--keep')) {
      console.log(`Kept: ${tmp}`);
    } else {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }

  const total = results.reduce((n, r) => n + r.ms, 0);
  console.log(`\n${results.length - failures}/${results.length} passed in ${(total / 1000).toFixed(1)} s`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
