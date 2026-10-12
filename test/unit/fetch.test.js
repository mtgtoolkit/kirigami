'use strict';

/**
 * fetch.js: plugin command line, request validation, outcome rules and the whole download job.
 * The job tests run a FAKE plugin (JavaScript saved as plugins/<id>/fetch.py, started with Node as
 * the "Python") through the real JobManager, so the deck-source handling, "Start fresh" with its
 * automatic restore, progress, results and failures are exercised end to end without Python or
 * network access. The parser itself is covered by fetch-parse.test.js on real captured outputs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const fetch = require('../../src/main/fetch');
const cards = require('../../src/main/cards');
const scan = require('../../src/main/scan');
const { JobManager } = require('../../src/main/jobs');
const { createLocks } = require('../../src/main/locks');
const { deepMerge, cloneValue, DEFAULT_SETTINGS } = require('../../src/main/settings');
const catalog = require('../../src/renderer/js/data/catalog.js');
const INTROSPECTION = require('../fixtures/introspection.json');

const UTIL_PATH = path.resolve(__dirname, '..', '..', 'src', 'main', 'util.js');
const MTG = INTROSPECTION.plugins.find((p) => p.id === 'mtg');
const NOT_FOUND = 'not found: check spelling or set code';
const MTGA_LABEL = catalog.getFormat('mtg', 'mtga').label;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------
// Fake plugin: prints like the real plugins (Index / Error / Skipping / Errors / "is not a valid
// file.") and writes PNGs into game/front (+ game/double_sided for "DFC …" cards).
//   "<n> <name>"  a card (n copies)     "<n> Bad …" fails with a 404
//   "1 CRASH"     ValueError traceback, exit 1 ("1 CRASH RUNTIME": RuntimeError)
//   "1 HANG"      never finishes        links / codes behave like the list "1 Linked Card"
//   the code "ffffffffffffffffffffffff" crashes with a KeyError (unreadable deck)
// Env: FAKE_PLUGIN_RECORD=<file> (argv, cwd, env as JSON), FAKE_PLUGIN_MISSING=1.
// ---------------------------------------------------------------------------------------------

const FAKE_PLUGIN = `'use strict';
const fs = require('fs');
const path = require('path');
const { encodePng } = require(${JSON.stringify(UTIL_PATH)});
const args = process.argv.slice(2);
const sep = args.indexOf('--');
const options = sep >= 0 ? args.slice(0, sep) : [];
const [deck, format] = sep >= 0 ? args.slice(sep + 1) : args;
if (process.env.FAKE_PLUGIN_RECORD) {
  fs.writeFileSync(process.env.FAKE_PLUGIN_RECORD, JSON.stringify({
    args, options, deck, format, cwd: process.cwd(),
    env: { PYTHONUTF8: process.env.PYTHONUTF8, PYTHONHASHSEED: process.env.PYTHONHASHSEED, PYTHONIOENCODING: process.env.PYTHONIOENCODING, MPLBACKEND: process.env.MPLBACKEND },
  }));
}
const png = (seed) => encodePng(4, 6, new Uint8Array(4 * 6 * 4).fill(seed % 256));
const isLink = /^(https?:|ydke:)/.test(deck) || /^[0-9a-f]{24}$/i.test(deck);
if (process.env.FAKE_PLUGIN_MISSING || (!isLink && !fs.existsSync(deck))) {
  console.log(deck + ' is not a valid file.');
  process.exit(0);
}
if (/^f{24}$/.test(deck)) {
  console.error('Traceback (most recent call last):');
  console.error('KeyError: ' + "'data'");
  process.exit(1);
}
const text = isLink ? '1 Linked Card' : fs.readFileSync(deck, 'utf8');
const front = path.join('game', 'front');
const ds = path.join('game', 'double_sided');
fs.mkdirSync(front, { recursive: true });
(async () => {
  let index = 0;
  const errors = [];
  for (const line of text.split('\\n')) {
    const m = /^(\\d+) (.+)$/.exec(line);
    if (!m) {
      console.log('Skipping: "' + line + '"');
      continue;
    }
    index += 1;
    const quantity = Number(m[1]);
    const name = m[2].trim();
    console.log('Index: ' + index + ', quantity: ' + quantity + ', name: ' + name);
    if (name.startsWith('CRASH')) {
      console.error('Traceback (most recent call last):');
      console.error('  File "plugins/mtg/fetch.py", line 1, in <module>');
      console.error((name === 'CRASH RUNTIME' ? 'RuntimeError' : 'ValueError') + ': broken on purpose');
      process.exit(1);
    }
    if (name === 'HANG') await new Promise(() => { setInterval(() => {}, 1000); });
    if (name.startsWith('Bad ')) {
      console.log('Error: 404 Client Error: Not Found for url: https://api.example.test/cards/named?exact=' + encodeURIComponent(name));
      errors.push("('" + line + "', HTTPError('404 Client Error'))");
      continue;
    }
    const safe = name.replace(/[^A-Za-z0-9 ]/g, '');
    for (let i = 1; i <= quantity; i += 1) fs.writeFileSync(path.join(front, index + safe + i + '.png'), png(index * 10 + i));
    if (name.startsWith('DFC ')) {
      fs.mkdirSync(ds, { recursive: true });
      fs.writeFileSync(path.join(ds, index + safe + '1.png'), png(200 + index));
    }
  }
  if (errors.length) console.log('Errors: [' + errors.join(', ') + ']');
})();
`;

function tmpDir(t, prefix = 'scm-fetch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

function pngBytes(seed = 1) {
  // eslint-disable-next-line global-require
  return require(UTIL_PATH).encodePng(4, 6, new Uint8Array(4 * 6 * 4).fill(seed));
}

function makeEnv(t, { settings = {}, plugins = ['mtg', 'elestrals', 'yugioh'], introspection = INTROSPECTION } = {}) {
  const root = tmpDir(t);
  const ws = path.join(root, 'ws');
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output']) fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  for (const id of plugins) {
    fs.mkdirSync(path.join(ws, 'plugins', id), { recursive: true });
    fs.writeFileSync(path.join(ws, 'plugins', id, 'fetch.py'), FAKE_PLUGIN);
  }
  const state = { settings: deepMerge(DEFAULT_SETTINGS, settings) };
  const jobs = new JobManager({ logsDir: null, scmCacheDir: path.join(root, 'cache') });
  const events = [];
  jobs.on('event', (evt) => events.push(evt));
  const deps = {
    getPaths: () => ({
      workspaceDir: ws,
      gameDir: (kind) => path.join(ws, 'game', kind),
      trashRoot: path.join(ws, 'game', '.trash'),
      outputDir: path.join(ws, 'game', 'output'),
      scmCacheDir: path.join(root, 'cache'),
      pythonPath: process.execPath,
    }),
    settings: {
      get: () => cloneValue(state.settings),
      update: (patch) => {
        state.settings = deepMerge(state.settings, patch);
        return cloneValue(state.settings);
      },
    },
    jobs,
    locks: createLocks(),
    helper: { introspect: async () => introspection },
    emit: () => {},
    hashCache: scan.createHashCache(null),
    logger: { info() {}, warn() {}, error() {} },
  };
  const dir = (kind) => path.join(ws, 'game', kind);
  const record = path.join(root, 'record.json');
  const readRecord = () => JSON.parse(fs.readFileSync(record, 'utf8'));
  return { root, ws, deps, state, jobs, events, dir, record, readRecord };
}

/** Run a fetch job to the end (FAKE_PLUGIN_RECORD set for the run). */
async function runJob(env, req) {
  process.env.FAKE_PLUGIN_RECORD = env.record;
  try {
    const jobId = await fetch.startFetchJob(env.deps, req);
    assert.equal(typeof jobId, 'string');
    return await env.jobs.whenFinished(jobId);
  } finally {
    delete process.env.FAKE_PLUGIN_RECORD;
  }
}

const listFiles = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const mtga = (text, extra = {}) => ({ plugin: 'mtg', format: 'mtga', source: { kind: 'text', text, deckName: 'My Deck' }, options: {}, ...extra });

// ---------------------------------------------------------------------------------------------
// buildFetchArgv (pure)
// ---------------------------------------------------------------------------------------------

test('buildFetchArgv: plugin script, options as --name=value before "--", then the deck and the format', () => {
  assert.deepEqual(fetch.buildFetchArgv(MTG, { format: 'mtga' }, 'game/decklist/x.txt'), ['plugins/mtg/fetch.py', '--', 'game/decklist/x.txt', 'mtga']);
  const argv = fetch.buildFetchArgv(MTG, {
    format: 'mtga',
    options: {
      tokens: true,
      prefer_set: ['LEA', ' 2ed ', '', null],
      prefer_lang: ['FR'],
      ignore_set_and_collector_number: false,
      prefer_older_sets: 'true',
      prefer_showcase: 0,
      ignore_set: null,
      unknown_option: 'x',
      deck_path: 'evil',
    },
  }, 'game/decklist/my deck.txt');
  // declaration order of the plugin, not the order of the request object
  assert.deepEqual(argv, [
    'plugins/mtg/fetch.py', '--prefer_older_sets', '--prefer_set=LEA', '--prefer_set=2ed', '--prefer_lang=fr', '--tokens',
    '--', 'game/decklist/my deck.txt', 'mtga',
  ]);
  // a deck path or code starting with "-" can never be read as an option
  assert.deepEqual(fetch.buildFetchArgv(MTG, { format: 'mtga' }, '-weird.txt').slice(-3), ['--', '-weird.txt', 'mtga']);
});

test('buildFetchArgv: defaults are omitted, true-by-default flags use their off switch, values are validated', () => {
  const spec = {
    id: 'demo',
    params: [
      { name: 'deck_path', kind: 'argument', flags: ['deck_path'] },
      { name: 'mode', kind: 'option', flags: ['-m', '--mode'], type: 'choice', choices: ['normal', 'easy'], default: 'normal', caseSensitive: false },
      { name: 'count', kind: 'option', flags: ['--count'], type: 'int', min: 1, max: 9, default: 3 },
      { name: 'ratio', kind: 'option', flags: ['--ratio'], type: 'float', default: null },
      { name: 'color', kind: 'option', flags: ['--color'], secondaryFlags: ['--no-color'], type: 'bool', isFlag: true, default: true },
      { name: 'version', kind: 'option', flags: ['--version'], type: 'bool', isFlag: true, exposeValue: false },
      { name: 'tags', kind: 'option', flags: ['--tag'], type: 'string', multiple: true, default: ['a'] },
    ],
  };
  const argv = (options) => fetch.buildFetchArgv(spec, { format: 'f', options }, 'd').slice(1, -3);
  assert.deepEqual(argv({ mode: 'NORMAL', count: '3', color: true, version: true, tags: ['a'] }), []);
  assert.deepEqual(argv({ mode: 'Easy', count: ' 05 ', ratio: '1,5', color: false, tags: ['b', 'c'] }), ['--mode=easy', '--count=5', '--ratio=1.5', '--no-color', '--tag=b', '--tag=c']);
  for (const bad of [{ mode: 'hard' }, { count: '0' }, { count: '2.5' }, { count: 'ten' }, { ratio: 'abc' }, { tags: ['x\ny'] }]) {
    assert.throws(() => argv(bad), (err) => err.code === 'INVALID_OPTION' && /is not a valid value for the option/.test(err.message) && !/--/.test(err.message), JSON.stringify(bad));
  }
});

test('buildFetchArgv: the script is always the workspace-relative plugins/<id>/fetch.py', () => {
  assert.equal(fetch.buildFetchArgv({ ...MTG, file: '../../evil.py' }, { format: 'mtga' }, 'd')[0], 'plugins/mtg/fetch.py');
  assert.equal(fetch.buildFetchArgv({ ...MTG, file: 'C:\\evil\\fetch.py' }, { format: 'mtga' }, 'd')[0], 'plugins/mtg/fetch.py');
  assert.equal(fetch.buildFetchArgv({ id: 'yugioh', params: [] }, { format: 'ydk' }, 'd')[0], 'plugins/yugioh/fetch.py');
  assert.throws(() => fetch.buildFetchArgv({ id: '../x', params: [] }, { format: 'f' }, 'd'), TypeError);
  assert.throws(() => fetch.buildFetchArgv(MTG, { format: '' }, 'd'), TypeError);
  assert.throws(() => fetch.buildFetchArgv(MTG, { format: 'mtga' }, ''), TypeError);
});

// ---------------------------------------------------------------------------------------------
// Hosts, deck names, outcome rules (pure)
// ---------------------------------------------------------------------------------------------

test('mtgSiteWithoutPrintings recognizes MTG deck links that carry no exact printings', () => {
  const site = (link, plugin = 'mtg', format = 'url') => fetch.mtgSiteWithoutPrintings(plugin, format, link);
  assert.equal(site('https://deckstats.net/decks/12345/67890-my-deck'), 'Deckstats');
  assert.equal(site('www.tappedout.net/mtg-decks/my-deck/'), 'TappedOut');
  assert.equal(site('https://www.mtggoldfish.com/deck/123456'), 'MTGGoldfish');
  assert.equal(site('https://mtgjson.com/api/v5/decks/Foo_Bar.json'), 'MTGJSON');
  assert.equal(site('https://www.tcgplayer.com/content/magic-the-gathering/deck/x/123'), 'TCGplayer');
  assert.equal(site('https://archidekt.com/decks/1'), null);
  assert.equal(site('https://evil-deckstats.net/decks/1/2-x'), null);
  assert.equal(site('https://deckstats.net/decks/1/2-x', 'lorcana'), null);
  assert.equal(site('https://deckstats.net/decks/1/2-x', 'mtg', 'deckstats'), null);
  assert.equal(site('not a link at all'), null);
  assert.equal(site(null), null);
});

test('deckNameFromLink gives a readable deck name for the PDF file name', () => {
  assert.equal(fetch.deckNameFromLink('https://archidekt.com/decks/8497473/my_deck', 'x'), 'archidekt-my_deck');
  assert.equal(fetch.deckNameFromLink('https://www.moxfield.com/decks/AbC-12', 'x'), 'moxfield-AbC-12');
  assert.equal(fetch.deckNameFromLink('https://mtgjson.com/api/v5/decks/Foo_Bar.json', 'x'), 'mtgjson-Foo_Bar');
  assert.equal(fetch.deckNameFromLink('archidekt.com/decks/1', 'x'), 'archidekt-1');
  assert.equal(fetch.deckNameFromLink('https://example.com/', 'x'), 'example');
  assert.equal(fetch.deckNameFromLink('http://[bad', 'fallback'), 'fallback');
});

test('decideFetchOutcome follows the spec rules', () => {
  const parsed = (extra = {}) => ({ fatal: null, everyLineSkipped: false, deckErrors: [], failedCards: [], cards: [], ignoredLines: [], savedFiles: [], ...extra });
  const decide = (extra, added = 0, exitCode = 0) => fetch.decideFetchOutcome({ exitCode, parsed: parsed(extra), added, formatLabel: 'MTG Arena export' });
  assert.deepEqual(decide({}, 5, 1), { ok: false, code: 'PROCESS_FAILED', message: null });
  assert.deepEqual(decide({ fatal: { code: 'DECK_FILE_MISSING' } }), { ok: false, code: 'DECK_FILE_MISSING', message: 'The deck list file could not be found.' });
  assert.deepEqual(decide({ failedCards: [{ index: 1, name: 'X', reason: NOT_FOUND }] }, 3), { ok: true, code: null, message: null });
  assert.deepEqual(decide({ everyLineSkipped: true, ignoredLines: ['a'] }), {
    ok: false, code: 'NO_CARDS_RECOGNIZED', message: 'None of your lines were recognized. Is the list format right? (selected: MTG Arena export)',
  });
  const unrecognized = decide({ deckErrors: [{ code: 'DECK_URL_UNRECOGNIZED', reason: 'x' }] });
  assert.equal(unrecognized.code, 'DECK_URL_UNRECOGNIZED');
  assert.match(unrecognized.message, /^No images were downloaded\. This link isn't from a deck website/);
  const offline = decide({ deckErrors: [{ code: 'DECK_ERROR', reason: 'no internet connection' }] });
  assert.equal(offline.code, 'DECK_FAILED');
  assert.match(offline.message, /Check your internet connection/);
  const allFailed = decide({ failedCards: [{ index: 1, name: 'Lightnig Boltt', reason: NOT_FOUND }, { index: 2, name: 'Y', reason: NOT_FOUND }] });
  assert.equal(allFailed.code, 'ALL_CARDS_FAILED');
  assert.equal(allFailed.message, `No images were downloaded. Every card failed (for example "Lightnig Boltt": ${NOT_FOUND}).`);
  assert.match(decide({ failedCards: [{ index: 1, reason: 'no internet connection' }] }).message, /No internet connection/);
  assert.deepEqual(decide({}), { ok: false, code: 'NO_IMAGES', message: 'No images were downloaded. The card downloader found no cards in your list.' });
  assert.deepEqual(decide({ cards: [{ index: 1 }] }), { ok: false, code: 'NO_IMAGES', message: 'No images were downloaded.' });
});

// ---------------------------------------------------------------------------------------------
// prepareRequest (validation before any job starts)
// ---------------------------------------------------------------------------------------------

test('prepareRequest validates the game, the format, the source and the options', async (t) => {
  const env = makeEnv(t);
  const { deps, dir, root } = env;
  const reject = (req, code, re) => assert.rejects(fetch.prepareRequest(deps, req), (err) => {
    assert.equal(err.code, code, err.message);
    if (re) assert.match(err.message, re);
    assert.doesNotMatch(err.message, /--\w/, 'no raw flags in messages');
    return true;
  });
  await reject({ ...mtga('1 Island'), plugin: 'nope' }, 'UNKNOWN_PLUGIN', /isn't available/);
  await reject({ ...mtga('1 Island'), plugin: 'bad id!' }, 'INVALID_ARGUMENT');
  await reject({ ...mtga('1 Island'), format: 'cockatrice' }, 'UNKNOWN_FORMAT', /"cockatrice" is not a list format Magic: The Gathering understands/);
  await reject({ plugin: 'mtg', format: 'mtga' }, 'INVALID_ARGUMENT', /where your deck list comes from/);
  await reject(mtga('   \n '), 'EMPTY_LIST', /Paste your deck list first/);
  await reject({ ...mtga('1 Island'), source: { kind: 'text', text: '1 Island', deckName: 'CON' } }, 'BAD_NAME', /"CON" can't be used as a list name/);
  await reject({ ...mtga('x'), source: { kind: 'saved', savedName: 'missing.txt' } }, 'NOT_FOUND', /no longer exists/);
  fs.writeFileSync(path.join(dir('decklist'), 'empty.txt'), '');
  await reject({ ...mtga('x'), source: { kind: 'saved', savedName: 'empty.txt' } }, 'EMPTY_LIST');
  await reject({ ...mtga('x'), source: { kind: 'file', filePath: path.join(root, 'nope.txt') } }, 'NOT_FOUND', /could not be found/);
  await reject({ ...mtga('x'), source: { kind: 'file', filePath: 'relative.txt' } }, 'INVALID_ARGUMENT');
  await reject({ ...mtga('x'), source: { kind: 'url', url: 'https://archidekt.com/decks/1' } }, 'WRONG_SOURCE', /is a deck list/);
  await reject({ plugin: 'mtg', format: 'url', source: { kind: 'saved', savedName: 'empty.txt' } }, 'WRONG_SOURCE', /needs a link/);
  await reject({ plugin: 'mtg', format: 'url', source: { kind: 'url', url: 'https://example.com/decks/1' } }, 'BAD_LINK', /doesn't look like a deck link/);
  await reject({ plugin: 'mtg', format: 'url', source: { kind: 'url', url: '  ' } }, 'EMPTY_LIST', /Paste the deck link first/);
  await reject({ plugin: 'mtg', format: 'url', source: { kind: 'text', text: 'https://archidekt.com/decks/1\nhttps://archidekt.com/decks/2' } }, 'INVALID_ARGUMENT', /only one link/);
  await reject({ ...mtga('1 Island'), options: { prefer_lang: ['klingon'] } }, 'INVALID_OPTION', /"klingon" is not a valid value for the option "prefer lang"/);

  const ok = await fetch.prepareRequest(deps, { ...mtga('1 Island'), format: 'MTGA', options: { prefer_set: ['LEA', 'M21'], ignore_set: 'DOM' } });
  assert.equal(ok.format, 'mtga', 'format spelling from the engine');
  assert.deepEqual(ok.options, { prefer_set: ['lea', 'm21'], ignore_set: 'dom' }, 'set codes in lower case (catalog)');
  assert.equal(ok.deckName, 'My Deck');
  assert.equal(ok.info.formatLabel, MTGA_LABEL);
  assert.equal(ok.notice, undefined);

  const broken = makeEnv(t, { introspection: { ...INTROSPECTION, plugins: INTROSPECTION.plugins.map((p) => (p.id === 'mtg' ? { ...p, error: 'ImportError: no module named mtg_parser' } : p)) } });
  await assert.rejects(fetch.prepareRequest(broken.deps, mtga('1 Island')), (err) => err.code === 'PLUGIN_BROKEN' && /Repair components/.test(err.message) && /mtg_parser/.test(err.details));
});

test('prepareRequest picks deck codes out of pasted links and names link decks', async (t) => {
  const { deps } = makeEnv(t);
  const ele = await fetch.prepareRequest(deps, { plugin: 'elestrals', format: 'elestrals', source: { kind: 'text_inline', url: 'https://play.elestrals.com/decks/0123456789abcdef01234567?tab=list' } });
  assert.equal(ele.source.value, '0123456789abcdef01234567');
  assert.equal(ele.deckName, 'elestrals-01234567');
  const ydke = 'ydke://o6lXBaOpVwWu9MwC!!!';
  const ygo = await fetch.prepareRequest(deps, { plugin: 'yugioh', format: 'ydke', source: { kind: 'text_inline', text: `  ${ydke} ` } });
  assert.equal(ygo.source.value, ydke);
  assert.equal(ygo.deckName, 'yugioh-deck');
  await assert.rejects(fetch.prepareRequest(deps, { plugin: 'yugioh', format: 'ydke', source: { kind: 'text_inline', text: 'not a code' } }), (err) => err.code === 'BAD_LINK');
  const link = await fetch.prepareRequest(deps, { plugin: 'mtg', format: 'url', source: { kind: 'url', url: 'https://archidekt.com/decks/1' } });
  assert.equal(link.deckName, 'archidekt-1');
  assert.equal(link.notice, undefined);
  const named = await fetch.prepareRequest(deps, { plugin: 'mtg', format: 'url', source: { kind: 'url', url: 'https://archidekt.com/decks/1', deckName: 'Cube night' } });
  assert.equal(named.deckName, 'Cube night');

  // Deckstats & co. carry no exact printings: "Ignore exact printings" is turned on with a notice
  const ds = await fetch.prepareRequest(deps, { plugin: 'mtg', format: 'url', source: { kind: 'url', url: 'https://deckstats.net/decks/12345/67890-my-deck' } });
  assert.equal(ds.options.ignore_set_and_collector_number, true);
  assert.match(ds.notice, /^Deckstats links don't include exact printings, so "Ignore exact printings" was turned on/);
  const already = await fetch.prepareRequest(deps, { plugin: 'mtg', format: 'url', source: { kind: 'url', url: 'https://tappedout.net/mtg-decks/x/' }, options: { ignore_set_and_collector_number: true } });
  assert.equal(already.notice, undefined);
});

// ---------------------------------------------------------------------------------------------
// The download job (fake plugin)
// ---------------------------------------------------------------------------------------------

test('a download saves the pasted list, runs the plugin like the CLI and reports cards, failures and skipped lines', async (t) => {
  const env = makeEnv(t);
  const { dir, state, events, ws } = env;
  const done = await runJob(env, mtga('Deck\r\n2 Lightning Bolt\r\n1 Bad Cardname\r\n\r\n1 DFC Delver\r\n'));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  const r = done.result;
  assert.deepEqual(
    { added: r.added, front: r.front, double_sided: r.double_sided, deckPath: r.deckPath, previousBatchId: r.previousBatchId, cardsTotal: r.cardsTotal, cardsFailed: r.cardsFailed },
    { added: 4, front: 3, double_sided: 1, deckPath: 'game/decklist/My Deck.txt', previousBatchId: null, cardsTotal: 4, cardsFailed: 1 },
  );
  assert.deepEqual(r.failedCards.map(({ raw, ...rest }) => rest), [{ index: 2, name: 'Bad Cardname', quantity: 1, reason: NOT_FOUND }]);
  assert.deepEqual(r.ignoredLines, ['Deck']);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.totals, { front: 3, double_sided: 1 });
  // the list was saved as UTF-8 without BOM and with LF line ends
  assert.equal(fs.readFileSync(path.join(dir('decklist'), 'My Deck.txt'), 'utf8'), 'Deck\n2 Lightning Bolt\n1 Bad Cardname\n\n1 DFC Delver\n');
  assert.deepEqual(listFiles(dir('front')), ['1Lightning Bolt1.png', '1Lightning Bolt2.png', '3DFC Delver1.png']);
  assert.deepEqual(listFiles(dir('double_sided')), ['3DFC Delver1.png']);
  // command line, working folder and Python environment
  const rec = env.readRecord();
  assert.deepEqual(rec.args, ['--', 'game/decklist/My Deck.txt', 'mtga']);
  assert.equal(path.resolve(rec.cwd), path.resolve(ws));
  assert.deepEqual(rec.env, { PYTHONUTF8: '1', PYTHONHASHSEED: '0', PYTHONIOENCODING: 'utf-8:backslashreplace', MPLBACKEND: 'Agg' });
  // settings + live progress
  assert.deepEqual({ ...state.settings.fetch.lastFetched, at: undefined }, { plugin: 'mtg', format: 'mtga', deckName: 'My Deck', added: 4, at: undefined });
  assert.ok(events.some((e) => e.type === 'progress' && /^Card \d+: /.test(e.label || '')), 'progress shows the current card');
  const steps = events.filter((e) => e.type === 'step' && e.status === 'done').map((e) => e.stepId);
  assert.deepEqual(steps, ['prepare', 'download', 'finish']);

  // the same list again: the saved file is reused, nothing is overwritten
  const again = await runJob(env, mtga('Deck\n2 Lightning Bolt\n1 Bad Cardname\n\n1 DFC Delver\n'));
  assert.equal(again.status, 'succeeded');
  assert.equal(again.result.deckPath, 'game/decklist/My Deck.txt');
  assert.equal(again.result.added, 4, 'replaced files count as downloaded');
  // a different list with the same name is kept next to it
  const other = await runJob(env, mtga('1 Sol Ring\n'));
  assert.equal(other.result.deckPath, 'game/decklist/My Deck (2).txt');
});

test('"Start fresh" sets the current cards aside and keeps them restorable after a successful download', async (t) => {
  const env = makeEnv(t);
  const { deps, dir } = env;
  fs.writeFileSync(path.join(dir('front'), 'old.png'), pngBytes(7));
  fs.writeFileSync(path.join(dir('double_sided'), 'old.png'), pngBytes(8));
  const done = await runJob(env, mtga('1 Sol Ring\n', { clearBeforeFetch: true }));
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.match(done.result.previousBatchId, /^\d{8}-\d{6}-before-download-1$/);
  assert.deepEqual(listFiles(dir('front')), ['1Sol Ring1.png']);
  assert.deepEqual(listFiles(dir('double_sided')), []);
  const trash = await cards.trashList(deps);
  assert.equal(trash.length, 1);
  assert.deepEqual(trash[0].counts, { front: 1, double_sided: 1 });
  const restored = await cards.restoreBatch(deps, done.result.previousBatchId);
  assert.equal(restored.restored, 2);
  assert.deepEqual(listFiles(dir('front')), ['1Sol Ring1.png', 'old.png']);
});

test('"Start fresh" puts the previous cards back when the download fails, adds nothing or is cancelled', async (t) => {
  const env = makeEnv(t);
  const { deps, dir, jobs, events } = env;
  const seed = () => {
    for (const f of listFiles(dir('front'))) fs.rmSync(path.join(dir('front'), f));
    fs.writeFileSync(path.join(dir('front'), 'old.png'), pngBytes(7));
  };

  // 1. the plugin crashes after one card: images of the unfinished download go to the trash
  seed();
  const crashed = await runJob(env, mtga('1 Good Card\n1 CRASH\n', { clearBeforeFetch: true }));
  assert.equal(crashed.status, 'failed');
  assert.equal(crashed.error.code, 'LIST_UNREADABLE');
  assert.equal(crashed.error.message, `The card downloader couldn't read your list as "${MTGA_LABEL}". Check that this is the right list format and that the whole list was copied.`);
  assert.match(crashed.error.details, /Traceback/);
  assert.match(crashed.error.details, /ValueError: broken on purpose/);
  assert.ok(crashed.warnings.includes('Your previous cards were put back.'), JSON.stringify(crashed.warnings));
  assert.deepEqual(listFiles(dir('front')), ['old.png']);
  const trash = await cards.trashList(deps);
  assert.deepEqual(trash.map((b) => b.reason), ['incomplete-download']);
  assert.deepEqual(trash[0].files, ['1Good Card1.png']);

  // 2. no line recognized
  seed();
  const skipped = await runJob(env, mtga('Sideboard\nsome notes\n', { clearBeforeFetch: true }));
  assert.equal(skipped.status, 'failed');
  assert.equal(skipped.error.code, 'NO_CARDS_RECOGNIZED');
  assert.equal(skipped.error.message, `None of your lines were recognized. Is the list format right? (selected: ${MTGA_LABEL})`);
  assert.deepEqual(skipped.warnings, ['Your previous cards were put back.']);
  assert.deepEqual(listFiles(dir('front')), ['old.png']);

  // 3. every card failed
  seed();
  const allBad = await runJob(env, mtga('1 Bad One\n2 Bad Two\n', { clearBeforeFetch: true }));
  assert.equal(allBad.status, 'failed');
  assert.equal(allBad.error.code, 'ALL_CARDS_FAILED');
  assert.match(allBad.error.message, /^No images were downloaded\. Every card failed \(for example "Bad One": not found/);
  assert.deepEqual(listFiles(dir('front')), ['old.png']);

  // 4. cancelled while downloading
  seed();
  process.env.FAKE_PLUGIN_RECORD = env.record;
  const jobId = await fetch.startFetchJob(deps, mtga('1 Good Card\n1 HANG\n', { clearBeforeFetch: true }));
  delete process.env.FAKE_PLUGIN_RECORD;
  for (let i = 0; i < 200 && !events.some((e) => e.jobId === jobId && e.type === 'progress' && /HANG/.test(e.label || '')); i += 1) await sleep(50);
  assert.ok(jobs.cancel(jobId));
  const cancelled = await jobs.whenFinished(jobId);
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.warnings.includes('Your previous cards were put back.'), JSON.stringify(cancelled.warnings));
  assert.deepEqual(listFiles(dir('front')), ['old.png']);
});

test('a missing deck file and a crash without "Start fresh" give plain messages; earlier downloads are kept', async (t) => {
  const env = makeEnv(t);
  const { dir } = env;
  process.env.FAKE_PLUGIN_MISSING = '1';
  let missing;
  try {
    missing = await runJob(env, mtga('1 Island\n'));
  } finally {
    delete process.env.FAKE_PLUGIN_MISSING;
  }
  assert.equal(missing.status, 'failed');
  assert.deepEqual([missing.error.code, missing.error.message], ['DECK_FILE_MISSING', 'The deck list file could not be found.']);

  const crashed = await runJob(env, mtga('2 Good Card\n1 CRASH RUNTIME\n'));
  assert.equal(crashed.status, 'failed');
  assert.deepEqual([crashed.error.code, crashed.error.message], ['UNKNOWN', 'Something went wrong: RuntimeError: broken on purpose']);
  assert.deepEqual(crashed.warnings, ['2 image(s) were downloaded before the problem. They are in Your cards.']);
  assert.deepEqual(listFiles(dir('front')), ['1Good Card1.png', '1Good Card2.png']);

  // a deck the plugin can't read (e.g. the website answered something unexpected): plain wording
  const badCode = await runJob(env, { plugin: 'elestrals', format: 'elestrals', source: { kind: 'text_inline', url: 'f'.repeat(24) } });
  assert.equal(badCode.status, 'failed');
  assert.equal(badCode.error.code, 'LIST_UNREADABLE');
  assert.equal(badCode.error.message, `The card downloader couldn't read this deck (${catalog.getFormat('elestrals', 'elestrals').label}). Check the code; the deck website may also have changed.`);
  assert.match(badCode.error.details, /KeyError/);
});

test('chosen files are decoded into game/decklist (original untouched); saved lists are fixed only when needed', async (t) => {
  const env = makeEnv(t);
  const { dir, root } = env;
  // UTF-16 LE with BOM and CRLF (Windows Notepad "Unicode")
  const utf16 = path.join(root, 'Notepad deck.txt');
  const utf16Bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('1 Sol Ring\r\n1 Æther Vial\r\n', 'utf16le')]);
  fs.writeFileSync(utf16, utf16Bytes);
  const a = await runJob(env, { plugin: 'mtg', format: 'mtga', source: { kind: 'file', filePath: utf16 } });
  assert.equal(a.status, 'succeeded', JSON.stringify(a.error));
  assert.equal(a.result.deckPath, 'game/decklist/Notepad deck.txt');
  assert.equal(fs.readFileSync(path.join(dir('decklist'), 'Notepad deck.txt'), 'utf8'), '1 Sol Ring\n1 Æther Vial\n');
  assert.deepEqual(fs.readFileSync(utf16), utf16Bytes, 'the original file is never modified');
  assert.equal(a.result.added, 2);

  // Windows-1252 bytes (old exports) keep their own extension
  const cp1252 = path.join(root, 'Notepad deck.dek');
  fs.writeFileSync(cp1252, Buffer.from([0x31, 0x20, 0xc6, 0x74, 0x68, 0x65, 0x72, 0x0a])); // "1 Æther\n"
  const b = await runJob(env, { plugin: 'mtg', format: 'mtga', source: { kind: 'file', filePath: cp1252 } });
  assert.equal(b.status, 'succeeded', JSON.stringify(b.error));
  assert.equal(b.result.deckPath, 'game/decklist/Notepad deck.dek');
  assert.equal(fs.readFileSync(path.join(dir('decklist'), 'Notepad deck.dek'), 'utf8'), '1 Æther\n');
  assert.deepEqual(env.readRecord().args.slice(-2), ['game/decklist/Notepad deck.dek', 'mtga']);

  // the same file name with other content: keep both
  fs.writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('2 Island\r\n', 'utf16le')]));
  const b2 = await runJob(env, { plugin: 'mtg', format: 'mtga', source: { kind: 'file', filePath: utf16 } });
  assert.equal(b2.status, 'succeeded', JSON.stringify(b2.error));
  assert.equal(b2.result.deckPath, 'game/decklist/Notepad deck (2).txt');
  assert.equal(fs.readFileSync(path.join(dir('decklist'), 'Notepad deck.txt'), 'utf8'), '1 Sol Ring\n1 Æther Vial\n');

  // a saved list with a BOM is rewritten in place (the plugin would skip the first card)
  const saved = path.join(dir('decklist'), 'bom.txt');
  fs.writeFileSync(saved, Buffer.from('\uFEFF1 Island\r\n', 'utf8'));
  const c = await runJob(env, { plugin: 'mtg', format: 'mtga', source: { kind: 'saved', savedName: 'bom.txt' } });
  assert.equal(c.status, 'succeeded', JSON.stringify(c.error));
  assert.equal(c.result.deckPath, 'game/decklist/bom.txt');
  assert.deepEqual(fs.readFileSync(saved), Buffer.from('1 Island\n', 'utf8'));
  assert.equal(c.result.deckName, 'bom');
  // a clean saved list is left alone
  const clean = path.join(dir('decklist'), 'clean.txt');
  fs.writeFileSync(clean, '1 Forest\n');
  const mtime = fs.statSync(clean).mtimeMs;
  await sleep(20);
  const d = await runJob(env, { plugin: 'mtg', format: 'mtga', source: { kind: 'saved', savedName: 'clean.txt' } });
  assert.equal(d.status, 'succeeded');
  assert.equal(fs.statSync(clean).mtimeMs, mtime);
});

test('deck links: Deckstats turns on "Ignore exact printings" (with a notice); codes are passed as they are', async (t) => {
  const env = makeEnv(t);
  const link = 'https://deckstats.net/decks/12345/67890-my-deck';
  const done = await runJob(env, { plugin: 'mtg', format: 'url', source: { kind: 'url', url: ` ${link} ` }, options: {} });
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error));
  assert.deepEqual(env.readRecord().args, ['--ignore_set_and_collector_number', '--', link, 'url']);
  assert.equal(done.result.warnings.length, 1);
  assert.match(done.result.warnings[0], /^Deckstats links don't include exact printings/);
  assert.equal(done.result.deckPath, link);
  assert.equal(done.result.deckName, 'deckstats-67890-my-deck');
  assert.deepEqual(listFiles(env.dir('decklist')), [], 'links are not saved as lists');

  const code = '0123456789abcdef01234567';
  const ele = await runJob(env, { plugin: 'elestrals', format: 'elestrals', source: { kind: 'text_inline', url: `https://play.elestrals.com/decks/${code}` } });
  assert.equal(ele.status, 'succeeded', JSON.stringify(ele.error));
  assert.deepEqual(env.readRecord().args, ['--', code, 'elestrals']);
});

test('startFetchJob refuses while another job runs and rejects invalid requests before a job starts', async (t) => {
  const env = makeEnv(t);
  const { deps, jobs } = env;
  const id = jobs.start('pdf', { title: 'Making the PDF' }, () => sleep(300));
  await assert.rejects(fetch.startFetchJob(deps, mtga('1 Island\n')), (err) => err.code === 'BUSY' && err.message === 'BUSY: wait until "Making the PDF" finishes');
  await jobs.whenFinished(id);
  await assert.rejects(fetch.startFetchJob(deps, mtga('')), (err) => err.code === 'EMPTY_LIST');
  assert.deepEqual(jobs.history().map((h) => h.kind), ['pdf'], 'no download job was started');
  const noJobs = { ...deps, jobs: null };
  await assert.rejects(fetch.startFetchJob(noJobs, mtga('1 Island\n')), (err) => err.code === 'SERVICE_UNAVAILABLE');
});
