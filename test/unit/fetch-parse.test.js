'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseFetchOutput, mapFetchReason, mapDeckReason, createFetchOutputParser, parseIndexLine, cardLabel,
} = require('../../src/main/fetch-parse');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'plugin-output');
const NOT_FOUND = 'not found: check spelling or set code';

/** Read a captured run: `[stdout] line` / `[stderr] line` entries (header lines start with '#'). */
function fixture(name) {
  const text = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
  const header = {};
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const h = /^# (\w+): (.*)$/.exec(raw);
    if (h) {
      header[h[1]] = h[2];
      continue;
    }
    const m = /^\[(stdout|stderr)\] ?(.*)$/.exec(raw);
    if (m) lines.push({ stream: m[1], line: m[2] });
  }
  return { header, lines };
}

test('fixtures index lists every captured run', () => {
  const index = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8'));
  for (const name of Object.keys(index)) {
    assert.ok(fs.existsSync(path.join(FIXTURES, `${name}.txt`)), `${name}.txt exists`);
    assert.equal(typeof index[name].exitCode, 'number');
  }
  assert.ok(Object.keys(index).length >= 10);
});

test('MTG Arena list: headers and blank lines are skipped, the misspelled card fails, the Errors repr is ignored', () => {
  const { header, lines } = fixture('mtg_mtga_mixed');
  assert.equal(header.exit, '0');
  const r = parseFetchOutput(lines);
  assert.deepEqual(r.cards.map((c) => [c.index, c.name, c.quantity]), [
    [1, 'Lightning Bolt', 2], [2, 'Sol Ring', 1], [3, 'Delver of Secrets', 1], [4, 'Lightnig Boltt', 1], [5, 'Counterspell', 1],
  ]);
  assert.equal(r.failedCards.length, 1);
  assert.deepEqual({ ...r.failedCards[0], raw: undefined }, { index: 4, name: 'Lightnig Boltt', quantity: 1, reason: NOT_FOUND, raw: undefined });
  assert.match(r.failedCards[0].raw, /^400 Client Error: Bad Request/);
  assert.deepEqual(r.ignoredLines, ['Deck', 'Sideboard']);
  assert.equal(r.stats.skippedLines, 3, 'the blank line is counted but not listed');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.deckErrors, []);
  assert.equal(r.fatal, null);
  assert.equal(r.totalQuantity, 6);
  assert.equal(r.failedQuantity, 1);
  assert.equal(r.everyLineSkipped, false);
  assert.deepEqual(r.lastCard, { index: 5, name: 'Counterspell' });
});

test('a UTF-8 BOM makes the plugin skip the first card; the BOM is not shown', () => {
  const r = parseFetchOutput(fixture('mtg_bom').lines);
  assert.deepEqual(r.ignoredLines, ['1 Sol Ring']);
  assert.deepEqual(r.cards.map((c) => c.name), ['Lightning Bolt']);
});

test('missing deck file is fatal (exit code 0)', () => {
  const { header, lines } = fixture('mtg_missing_file');
  assert.equal(header.exit, '0');
  const r = parseFetchOutput(lines);
  assert.equal(r.fatal.code, 'DECK_FILE_MISSING');
  assert.equal(r.fatal.path, 'game/decklist/does-not-exist.txt');
  assert.equal(r.cards.length, 0);
  assert.equal(r.everyLineSkipped, false);
});

test('stderr (tracebacks, Python warnings) never becomes cards or warnings', () => {
  const { header, lines } = fixture('mtg_bad_json');
  assert.equal(header.exit, '1');
  assert.ok(lines.some((l) => l.stream === 'stderr' && /JSONDecodeError/.test(l.line)));
  const r = parseFetchOutput(lines);
  assert.equal(r.cards.length, 0);
  assert.deepEqual(r.warnings, []);
  assert.ok(r.stats.stderrLines > 10);
  const malformed = parseFetchOutput(fixture('yugioh_ydke_malformed').lines);
  assert.equal(malformed.cards.length, 0);
  assert.deepEqual(malformed.warnings, []);
});

test('KeyForge card summary ("N card(s) did not work:") is not counted twice', () => {
  const r = parseFetchOutput(fixture('keyforge_archon_mixed').lines);
  assert.equal(r.cards.length, 3);
  assert.deepEqual(r.failedCards.map((f) => [f.index, f.name, f.quantity, f.reason]), [[3, 'Zzqx Not A Real Card', 1, NOT_FOUND]]);
  assert.deepEqual(r.warnings, [], 'the "  - name (… not found …)" summary lines are not warnings');
  assert.equal(r.totalQuantity, 4);
});

test('KeyForge deck-level error (before any card) is a deck error, not a failed card', () => {
  const r = parseFetchOutput(fixture('keyforge_bad_deck_url').lines);
  assert.deepEqual(r.failedCards, []);
  assert.equal(r.deckErrors.length, 1);
  assert.equal(r.deckErrors[0].code, 'DECK_ERROR');
  assert.equal(r.deckErrors[0].reason, 'the deck was not found: check the link and that the deck is public');
  assert.deepEqual(r.warnings, []);
});

test('MTG deck link: Index lines with set codes; names containing commas are kept whole', () => {
  const r = parseFetchOutput(fixture('mtg_url_archidekt').lines);
  assert.equal(r.cards.length, 17);
  assert.deepEqual(r.cards[0], { index: 1, name: 'Thelon of Havenwood', quantity: 1 });
  assert.equal(r.cards[16].name, 'Westvale Abbey // Ormendahl, Profane Prince');
  assert.equal(r.failedCards.length, 0);
});

test('MTG deck link failures: unrecognized site and unreadable deck', () => {
  const unrec = parseFetchOutput(fixture('mtg_url_unrecognized').lines);
  assert.equal(unrec.deckErrors[0].code, 'DECK_URL_UNRECOGNIZED');
  assert.equal(unrec.deckErrors[0].url, 'https://example.com/decks/12345');
  const priv = parseFetchOutput(fixture('mtg_url_missing_deck').lines);
  assert.equal(priv.deckErrors[0].code, 'DECK_URL_PRIVATE');
  assert.equal(priv.cards.length, 0);
});

test('Yu-Gi-Oh! prints saved image paths (no Index lines)', () => {
  const parser = createFetchOutputParser();
  for (const l of fixture('yugioh_ydke').lines) parser.push(l);
  const r = parser.result();
  assert.deepEqual(r.savedFiles, ['89631139_1.jpg', '89631139_2.jpg', '46986414_1.jpg']);
  assert.equal(r.cards.length, 0);
  assert.equal(parser.progressLabel(), 'Saved 46986414_1.jpg');
  assert.equal(r.totalQuantity, null);
});

test('options run: a single card', () => {
  const r = parseFetchOutput(fixture('mtg_options').lines);
  assert.deepEqual(r.cards, [{ index: 1, name: 'Sol Ring', quantity: 1 }]);
});

test('Index line fields of every plugin', () => {
  const cases = [
    ['Index: 3, quantity: 2, set code: MH2, collector number: 244, name: Arid Mesa', 3, 2, 'Arid Mesa'],
    ['Index: 1, quantity: 1, name: Ecto-Charge', 1, 1, 'Ecto-Charge'],
    ['Index: 2, quantity: 3, name: Molten Destruction, card stub: molten-destruction', 2, 3, 'Molten Destruction'],
    ['Index: 4, quantity: 3, name: Rufus, serial code: 20-040L, category: Forward', 4, 3, 'Rufus'],
    ['Index: 5, quantity: 1, name: Blood Splattered Vest, pitch: red', 5, 1, 'Blood Splattered Vest'],
    ['Index: 6, quantity: 4, name: Magic Broom - Illuminary Keeper, variant: enchanted', 6, 4, 'Magic Broom - Illuminary Keeper'],
    ['Index: 7, quantity: 2, name: Gandalf, code: 01073', 7, 2, 'Gandalf'],
    ['Index: 8, quantity: 3, name: Hedge Fund, set: core, url: https://netrunnerdb.com/en/card/30001', 8, 3, 'Hedge Fund'],
    ['Index: 9, quantity: 3, name: Charcadet, set: SSP, card number: 32', 9, 3, 'Charcadet'],
    ['Index: 10, quantity: 1, card ID: SOR_017, name: Han Solo, title: Audacious Smuggler', 10, 1, 'Han Solo | Audacious Smuggler'],
    ['Index: 11, quantity: 1, QR code: ALT_COREKS_B_OR_01_C', 11, 1, 'ALT_COREKS_B_OR_01_C'],
    ['Index: 12, quantity: 4, card name: Sable Remnant', 12, 4, 'Sable Remnant'],
    ['Index: 13, quantity: 4, card code: BT11-005, name: Koromon', 13, 4, 'Koromon'],
    ['Index: 14, quantity: 4, card number: GD01-008, name: Guntank', 14, 4, 'Guntank'],
    ['Index: 15, quantity: 1, code: 01006, name: Roland\'s .38 Special', 15, 1, 'Roland\'s .38 Special'],
    ['Index: 16, quantity: 1, card code: OP12-001', 16, 1, 'OP12-001'],
    ['Index: 17, quantity: 2', 17, 2, null],
  ];
  for (const [line, index, quantity, name] of cases) {
    const card = parseIndexLine(line);
    assert.ok(card, line);
    assert.equal(card.index, index, line);
    assert.equal(card.quantity, quantity, line);
    assert.equal(card.name, name, line);
  }
  assert.equal(parseIndexLine('Indexing: 3'), null);
  assert.equal(parseIndexLine('Skipping: "Index: 1"'), null);
  assert.equal(parseIndexLine('Index: 2, quantity: 1, set code: m21, name: Alrund, God of the Cosmos // Hakka, Whispering Raven').name,
    'Alrund, God of the Cosmos // Hakka, Whispering Raven');
});

test('Arkham: a lookup failure has no Index line; index gaps put the error on the missing card', () => {
  const r = parseFetchOutput([
    'Index: 1, quantity: 1, code: 01006, name: Roland\'s .38 Special',
    'Error: 404 Client Error: Not Found for url: https://arkhamdb.com/api/public/card/99999.json',
    'Index: 3, quantity: 2, code: 01016, name: Cover Up',
  ]);
  assert.deepEqual(r.failedCards.map((f) => [f.index, f.name, f.quantity]), [[2, null, null]]);
  assert.equal(r.failedCards[0].reason, NOT_FOUND);
  // card 1 failing after its Index line AND card 2 failing before its line
  const both = parseFetchOutput([
    'Index: 1, quantity: 1, name: A',
    'Error: 500 Server Error: Internal Server Error for url: https://x/a.png',
    'Error: 404 Client Error: Not Found for url: https://x/card/2',
    'Index: 3, quantity: 1, name: C',
  ]);
  assert.deepEqual(both.failedCards.map((f) => [f.index, f.name]), [[1, 'A'], [2, null]]);
  assert.equal(both.failedCards[0].reason, 'the card website had a problem, try again later');
  // two missing cards in a row
  const two = parseFetchOutput(['Index: 1, quantity: 1, name: A', 'Error: x1', 'Error: x2', 'Index: 4, quantity: 1, name: D']);
  assert.deepEqual(two.failedCards.map((f) => f.index), [2, 3]);
  assert.equal(two.failedQuantity, 2, 'unknown quantities count as one copy');
});

test('a second error without a new Index line belongs to the next card', () => {
  const r = parseFetchOutput(['Index: 7, quantity: 2, name: X', 'Error: boom', 'Error: 404 Not Found']);
  assert.deepEqual(r.failedCards.map((f) => [f.index, f.name, f.quantity]), [[7, 'X', 2], [8, null, null]]);
});

test('multi-line error messages continue the previous Error line', () => {
  const r = parseFetchOutput([
    'Index: 1, quantity: 1, name: A',
    'Error: Something odd happened',
    '  while reading the card: 404 not found here',
    'Index: 2, quantity: 1, name: B',
  ]);
  assert.equal(r.failedCards.length, 1);
  assert.match(r.failedCards[0].raw, /Something odd happened\n {0}while reading the card/);
  assert.equal(r.failedCards[0].reason, NOT_FOUND);
  assert.deepEqual(r.warnings, []);
});

test('Skipping lines split by a stray carriage return keep only the content', () => {
  const parser = createFetchOutputParser();
  parser.push('Skipping: "Deck');
  parser.push('"');
  parser.push('Skipping: ""');
  parser.push('Skipping: "  Sideboard (15)  "');
  const r = parser.result();
  assert.deepEqual(r.ignoredLines, ['Deck', 'Sideboard (15)']);
  assert.equal(r.everyLineSkipped, true);
});

test('header lines (Game:, Deck:, Scenario:, Fellowship:) are ignored', () => {
  const r = parseFetchOutput([
    'Game: Weiss Schwarz',
    'Deck: Not Found Lovers (ID: 337)',
    'Scenario: Passage Through Mirkwood (ID: 1, mode: normal)',
    'Fellowship: Warning Shots (ID: 7100)',
    '  Deck: Beginner',
    'Index: 1, quantity: 1, name: A',
  ]);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.cards.length, 1);
});

test('warnings: "Warning:" prefixes and "not found" lines, flags in plain words, de-duplicated', () => {
  const r = parseFetchOutput([
    'Warning: Hit rate limit 3 times for https://api.scryfall.com/cards/named, giving up after 30s wait',
    'Warning: Hit rate limit 3 times for https://api.scryfall.com/cards/named, giving up after 30s wait',
    'Language "jp" not found, using --prefer_lang fallback',
    'Found by flavor name: Godzilla, King of the Monsters',
    'Parsed 3 cards into 2 unique entries',
    '  Warning: No image data for slot 4 (Island)',
  ]);
  assert.deepEqual(r.warnings, [
    'Hit rate limit 3 times for https://api.scryfall.com/cards/named, giving up after 30s wait',
    'Language "jp" not found, using prefer lang fallback',
    'No image data for slot 4 (Island)',
  ]);
});

test('MPCFill slots act like cards; a slot without front is a warning', () => {
  const parser = createFetchOutputParser();
  parser.push('Prefetching 2 images with 8 workers...');
  parser.push('Slot 1: Aberrant Researcher / Perfected Form');
  parser.push('Warning: Slot 2 has no front image, skipping');
  parser.push('Slot 3: Island');
  const r = parser.result();
  assert.deepEqual(r.cards, [{ index: 1, name: 'Aberrant Researcher', quantity: 1 }, { index: 3, name: 'Island', quantity: 1 }]);
  assert.deepEqual(r.warnings, ['Slot 2 has no front image, skipping']);
  assert.equal(parser.progressLabel(), 'Card 3: Island');
});

test('deck link problems: invalid link, download failure with a network reason', () => {
  const invalid = parseFetchOutput(['"https://arkhamdb.com/x" is not a valid ArkhamDB deck URL.']);
  assert.equal(invalid.deckErrors[0].code, 'DECK_URL_INVALID');
  assert.equal(invalid.fatal, null);
  const failed = parseFetchOutput([
    "Error while fetching deck from URL: https://www.moxfield.com/decks/abc (HTTPSConnectionPool(host='api2.moxfield.com', port=443): Max retries exceeded with url: /v3/decks/all/abc (Caused by NameResolutionError(\"Failed to resolve 'api2.moxfield.com'\")))",
  ]);
  assert.equal(failed.deckErrors[0].code, 'DECK_URL_FAILED');
  assert.equal(failed.deckErrors[0].reason, 'no internet connection');
});

test('rate-limit waits show in the progress label, not as warnings', () => {
  const parser = createFetchOutputParser();
  parser.push('Index: 12, quantity: 1, name: Lightning Bolt');
  assert.equal(parser.progressLabel(), 'Card 12: Lightning Bolt');
  parser.push('Hit Scryfall rate limit (429), waiting 30 seconds before retry 1/3...');
  assert.equal(parser.progressLabel(), 'The card website is busy: waiting 30 seconds before trying again');
  parser.push('Index: 13, quantity: 1, name: Shock');
  assert.equal(parser.progressLabel(), 'Card 13: Shock');
  assert.deepEqual(parser.result().warnings, []);
});

test('every line skipped vs. nothing at all', () => {
  assert.equal(parseFetchOutput(['Skipping: "4 Lightning Bolt (abc) x"', 'Skipping: "Deck"']).everyLineSkipped, true);
  assert.equal(parseFetchOutput([]).everyLineSkipped, false);
  assert.equal(parseFetchOutput(['Skipping: ""']).everyLineSkipped, false, 'only blank lines');
  assert.equal(parseFetchOutput(['Skipping: "x"', 'Index: 1, quantity: 1, name: A']).everyLineSkipped, false);
});

test('plain strings are stdout; stderr entries are ignored; second argument sets the stream', () => {
  const parser = createFetchOutputParser();
  parser.push('Index: 1, quantity: 1, name: A');
  parser.push('Error: 404 Not Found', 'stderr');
  parser.push({ line: 'Warning: careful', stream: 'stderr' });
  const r = parser.result();
  assert.equal(r.failedCards.length, 0);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.stats.stderrLines, 2);
});

test('mapFetchReason covers the spec table and common HTTP cases', () => {
  const cases = [
    ['404 Client Error: Not Found for url: https://api.scryfall.com/cards/named?exact=Lightnig', NOT_FOUND],
    ['400 Client Error: Bad Request for url: https://api.scryfall.com/cards/search?q=x', NOT_FOUND],
    ['card not found on Archon Arcana: "Zzqx"', NOT_FOUND],
    ['429 Client Error: Too Many Requests for url: https://x', 'site busy, try again later'],
    ['Max retries (3) exceeded for Scryfall API: https://api.scryfall.com/cards/named?exact=Sol', 'site busy, try again later'],
    ["HTTPSConnectionPool(host='api.scryfall.com', port=443): Max retries exceeded with url: /cards/named (Caused by NameResolutionError(\"<urllib3.connection.HTTPSConnection object>: Failed to resolve 'api.scryfall.com' ([Errno 11001] getaddrinfo failed)\"))", 'no internet connection'],
    ["('Connection aborted.', RemoteDisconnected('Remote end closed connection without response'))", 'no internet connection'],
    ['HTTPSConnectionPool(host=\'x\', port=443): Read timed out. (read timeout=10)', 'no internet connection'],
    ['503 Server Error: Service Unavailable for url: https://x', 'the card website had a problem, try again later'],
    ['403 Client Error: Forbidden for url: https://x', 'the card website refused the download'],
    ['', "couldn't be downloaded (the card website gave no reason)"],
    ['Error: ', "couldn't be downloaded (the card website gave no reason)"],
  ];
  for (const [raw, expected] of cases) assert.equal(mapFetchReason(raw), expected, raw);
  assert.equal(mapFetchReason('KeyError: \'image_uris\''), "KeyError: 'image_uris'");
  assert.equal(mapFetchReason('Card not found for url: https://example.com/a/1'), NOT_FOUND, 'words still count');
  assert.equal(mapFetchReason('Not a valid card for url: https://example.com/a/404'), 'Not a valid card', 'a 404 inside a link is not a status');
  assert.equal(mapFetchReason('Unexpected value at https://example.com/cards/404'), 'Unexpected value at', 'status codes inside links are ignored');
  const long = mapFetchReason(`Weird failure ${'x'.repeat(300)}`);
  assert.ok(long.length <= 140 && long.endsWith('…'));
  assert.equal(mapFetchReason('Use --prefer_set instead'), 'Use prefer set instead');
});

test('mapDeckReason words problems with the deck itself', () => {
  assert.equal(mapDeckReason('404 Client Error: Not Found for url: https://x'), 'the deck was not found: check the link and that the deck is public');
  assert.equal(mapDeckReason('403 Client Error: Forbidden for url: https://x'), 'the deck website refused the download: the deck may be private');
  assert.equal(mapDeckReason("Max retries exceeded with url: /a (Caused by NameResolutionError('getaddrinfo failed'))"), 'no internet connection');
  assert.equal(mapDeckReason('could not find a deck ID in "abc"'), 'the deck was not found: check the link');
});

test('cardLabel', () => {
  assert.equal(cardLabel({ index: 12, name: 'Lightning Bolt' }), 'Card 12: Lightning Bolt');
  assert.equal(cardLabel({ index: 3, name: null }), 'Card 3');
  assert.equal(cardLabel({ index: null, name: 'X' }), 'A card: X');
  assert.equal(cardLabel(null), '');
});

test('numbers inside request paths are not read as HTTP status codes', () => {
  const dns = "HTTPSConnectionPool(host='api.scryfall.com', port=443): Max retries exceeded with url: /cards/named?fuzzy=429 (Caused by NameResolutionError(\"Failed to resolve 'api.scryfall.com'\"))";
  assert.equal(mapFetchReason(`Error: ${dns}`), 'no internet connection');
  const rate = "HTTPSConnectionPool(host='api.scryfall.com', port=443): Max retries exceeded with url: /cards/1 (Caused by ResponseError('too many 429 error responses'))";
  assert.equal(mapFetchReason(rate), 'site busy, try again later');
  assert.equal(mapFetchReason('500 Server Error: Internal Server Error for url: https://x.example/cards/404'), 'the card website had a problem, try again later');
});
