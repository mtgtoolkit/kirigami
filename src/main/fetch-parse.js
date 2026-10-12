'use strict';

/**
 * fetch-parse.js — understands what a game plugin printed while downloading card images
 * (PURE: no I/O, no Electron; unit-tested on real captured outputs in test/fixtures/plugin-output).
 *
 * What the plugins print on stdout (exit code 0 in all these cases):
 *   Index: 3, quantity: 2, set code: MH2, collector number: 244, name: Arid Mesa   <- a card starts
 *   Error: 404 Client Error: Not Found for url: …        <- the current card failed (no card name)
 *   Skipping: "Sideboard"                                <- a line that is not a card (headers, blanks)
 *   Errors: [('1 Lightnig Boltt', HTTPError(…))]         <- final Python repr (ignored: already counted)
 *   <deck path> is not a valid file.                     <- the deck file is missing (fatal)
 * Plugin specific shapes that are handled as well:
 *   KeyForge: "N card(s) did not work:" / "N deck(s) did not work:" followed by "  - name (error)"
 *     (a repeat of the Error lines, not counted twice); deck-level "Error: …" lines come before
 *     any card.
 *   MTG links: "URL not recognized by any supported site: …", "Error while fetching deck from URL: …",
 *     "Failed to parse deck from URL: …"; MPCFill orders: "Slot N: <front> / <back>".
 *   Arkham: the Index line is printed only after the card was looked up, so a lookup failure shows
 *     as an Error without its Index line (detected through index gaps / a second error).
 *   Bushiroad / LotR headers ("Game:", "Deck:", "Scenario:", "Fellowship:") are informational.
 *   Yu-Gi-Oh!: one saved image path per copy (no Index lines).
 * Other stdout lines containing "warning" or "not found" become warnings. stderr is only logged
 * (tracebacks are handled from the exit code by errors.friendlyError).
 */

const { humanizeFlags } = require('./errors');

/** Field names the plugins print on their Index lines (longest first where one is a prefix). */
const KNOWN_FIELDS = Object.freeze([
  'set code', 'collector number', 'card name', 'card stub', 'serial code', 'card code', 'card number', 'card id',
  'qr code', 'quantity', 'category', 'variant', 'pitch', 'title', 'name', 'code', 'set', 'url',
]);
/** Fields used as the display name when there is no `name` field, in order of preference. */
const NAME_FALLBACK_FIELDS = Object.freeze(['card name', 'card code', 'card number', 'code', 'card id', 'qr code', 'card stub', 'title']);

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FIELD_RE_SOURCE = `, (${KNOWN_FIELDS.map(escapeRe).join('|')}): `;

const INDEX_RE = /^Index:\s*(\d+)\s*(?:,\s*(.*))?$/;
const SLOT_RE = /^Slot (\d+):\s*(.*)$/;
const ERROR_RE = /^Error:(?:\s(.*)|)$/;
const SKIPPING_PREFIX = 'Skipping: ';
const ERRORS_REPR_RE = /^Errors:\s*[[(]/;
const NOT_VALID_FILE_RE = /^(.+) is not a valid file\.?$/;
const NOT_VALID_LINK_RE = /^(.+) is not a valid .*?(?:URL|link|deck ID)\.?$/i;
const URL_UNRECOGNIZED_RE = /^URL not recognized by any supported site:\s*(.*)$/;
const URL_FETCH_FAILED_RE = /^Error while fetching deck from URL:\s*(.*)$/;
const URL_PARSE_FAILED_RE = /^Failed to parse deck from URL:\s*(.*)$/;
const SUMMARY_HEADER_RE = /^\d+ (?:card|deck)\(s\) did not work:\s*$/;
const SUMMARY_ITEM_RE = /^\s+- /;
const HEADER_RE = /^\s*(?:Game|Deck|Scenario|Fellowship):\s/;
const SAVED_IMAGE_RE = /[\\/]game[\\/](front|double_sided)[\\/](?:.*[\\/])?([^\\/]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|avif|jp2))\s*$/i;
const RATE_WAIT_RE = /rate limit.*?waiting (\d+) seconds/i;
const WARNING_HINT_RE = /\bwarning\b|\bnot found\b/i;

const MAX_RAW = 2000;
const MAX_LIST = 2000;

/**
 * Split the text after "Index: N, " into the known fields.
 * @param {string} rest e.g. "quantity: 2, set code: MH2, collector number: 244, name: Arid Mesa"
 * @returns {Record<string, string>} lower-case field names -> values
 */
function splitFields(rest) {
  const fields = {};
  const text = `, ${rest}`;
  const re = new RegExp(FIELD_RE_SOURCE, 'gi');
  const marks = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    marks.push({ key: m[1].toLowerCase(), start: m.index, valueStart: m.index + m[0].length });
    re.lastIndex = m.index + m[0].length;
  }
  for (let i = 0; i < marks.length; i += 1) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length;
    const key = marks[i].key;
    if (!(key in fields)) fields[key] = text.slice(marks[i].valueStart, end).trim();
  }
  return fields;
}

/**
 * Parse one "Index: …" line.
 * @param {string} line
 * @returns {{ index: number, quantity: number|null, name: string|null, fields: Record<string,string> }|null}
 */
function parseIndexLine(line) {
  const m = INDEX_RE.exec(String(line).trim());
  if (!m) return null;
  const rest = m[2] || '';
  const fields = splitFields(rest);
  let name = fields.name || null;
  if (name && fields.title) name = `${name} | ${fields.title}`;
  if (!name) {
    for (const key of NAME_FALLBACK_FIELDS) {
      if (fields[key]) {
        name = fields[key];
        break;
      }
    }
  }
  if (!name && rest.includes('name: ')) name = rest.slice(rest.lastIndexOf('name: ') + 6).trim() || null;
  const q = Number.parseInt(fields.quantity, 10);
  return { index: Number(m[1]), quantity: Number.isFinite(q) ? q : null, name, fields };
}

/**
 * "Card 12: Lightning Bolt" (or "Card 12" without a name).
 * @param {{ index?: number|null, name?: string|null }|null} card
 * @returns {string}
 */
function cardLabel(card) {
  if (!card) return '';
  const idx = Number.isFinite(card.index) ? `Card ${card.index}` : 'A card';
  return card.name ? `${idx}: ${card.name}` : idx;
}

/**
 * Remove web addresses from an error text (requests prints "… for url: https://…" and
 * "Max retries exceeded with url: /path?q=…"), so numbers inside them (a card id "429", a "404"
 * in a search query) are never mistaken for HTTP status codes and messages stay short.
 * @param {string} text
 * @returns {string}
 */
function stripUrls(text) {
  return text
    .replace(/\s*\bfor url:\s*\S+/gi, '')
    .replace(/(\bwith url:)\s*\S+/gi, '$1 …')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortRaw(text) {
  let s = humanizeFlags(stripUrls(text)).replace(/[\s:;,.(]+$/, '').trim();
  if (!s) s = text.trim();
  if (s.length > 140) s = `${s.slice(0, 139).trimEnd()}…`;
  return s;
}

/**
 * Plain-language reason for one failed card (spec §9.6 mapping, plus a few common HTTP cases).
 * @param {string} raw the text after "Error: " (or a whole error line)
 * @returns {string} e.g. "not found: check spelling or set code"
 */
function mapFetchReason(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/^Error:\s*/, '').trim();
  if (!text) return "couldn't be downloaded (the card website gave no reason)";
  const noUrls = stripUrls(text);
  if (/\b429\b|too many requests|rate[ -]?limit|max retries \(\d+\) exceeded for/i.test(noUrls)) return 'site busy, try again later';
  if (/getaddrinfo|NameResolution|Failed to resolve|Name or service not known|Temporary failure in name resolution|nodename nor servname|Max retries exceeded with url|ConnectionError|Connection (?:refused|reset|aborted)|actively refused|RemoteDisconnected|Remote end closed|timed out|ConnectTimeout|ReadTimeout|SSLError|CERTIFICATE_VERIFY_FAILED|certificate verify failed|Network is unreachable|No route to host/i.test(text)) {
    return 'no internet connection';
  }
  if (/\b404\b|\bnot found\b|\b400 Client Error\b|\bBad Request\b|does not exist|no such card|unknown card|could not find/i.test(noUrls)) {
    return 'not found: check spelling or set code';
  }
  if (/\b(?:500|502|503|504)\b|Service Unavailable|Bad Gateway|Internal Server Error|Gateway Time-?out/i.test(noUrls)) {
    return 'the card website had a problem, try again later';
  }
  if (/\b403\b|\bForbidden\b/i.test(noUrls)) return 'the card website refused the download';
  return shortRaw(text);
}

/**
 * Plain-language reason for a problem with the deck itself (a deck link or a deck ID).
 * @param {string} raw
 * @returns {string}
 */
function mapDeckReason(raw) {
  const text = String(raw === undefined || raw === null ? '' : raw).replace(/^Error:\s*/, '').trim();
  const noUrls = stripUrls(text);
  if (/\b404\b|\bnot found\b|does not exist/i.test(noUrls)) return 'the deck was not found: check the link and that the deck is public';
  if (/\b(?:401|403)\b|\bForbidden\b|\bUnauthorized\b/i.test(noUrls)) return 'the deck website refused the download: the deck may be private';
  const reason = mapFetchReason(text);
  return reason === 'not found: check spelling or set code' ? 'the deck was not found: check the link' : reason;
}

function cleanWarning(line) {
  let s = String(line).trim().replace(/^warning:\s*/i, '');
  s = humanizeFlags(s);
  if (s.length > 300) s = `${s.slice(0, 299).trimEnd()}…`;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function deckErrorFor(code, raw, extra = {}) {
  return { code, reason: mapDeckReason(raw), raw: String(raw).slice(0, MAX_RAW), ...extra };
}

/**
 * Incremental parser: feed lines as they arrive (live progress), read the result at the end.
 * @returns {{
 *   push(line: string|{line: string, stream?: string}, stream?: string): void,
 *   result(): FetchParseResult,
 *   readonly lastCard: { index: number, name: string|null }|null,
 *   progressLabel(): string,
 * }}
 */
function createFetchOutputParser() {
  const cards = [];
  const failedCards = [];
  const ignoredLines = [];
  const warnings = [];
  const deckErrors = [];
  const savedFiles = [];
  const stats = { lines: 0, stdoutLines: 0, stderrLines: 0, cardLines: 0, skippedLines: 0, errorLines: 0 };
  let current = null; // the card the plugin is working on
  let lastAssignedIndex = null; // highest index a failure or Index line referred to
  let errorsSinceIndex = []; // failures recorded since the last Index line (index-gap repair)
  let fatal = null;
  let inSummary = false;
  let continuation = null; // last failure entry that may continue on the next lines
  let pendingSkipQuote = false;
  let rateWaitSeconds = null;
  let lastActivity = null; // 'card' | 'saved' | 'rate'

  function addWarning(text) {
    const w = cleanWarning(text);
    if (w && !warnings.includes(w) && warnings.length < 200) warnings.push(w);
  }

  function recordFailure(entry) {
    if (failedCards.length < MAX_LIST) failedCards.push(entry);
    continuation = entry;
  }

  function onIndex(card) {
    // Index gap (e.g. Arkham prints the Index line only after a successful lookup): failures seen
    // since the previous Index line belong to the missing indices, newest last.
    if (current && Number.isFinite(card.index) && Number.isFinite(current.index) && card.index > current.index + 1 && errorsSinceIndex.length) {
      const missing = [];
      for (let i = current.index + 1; i < card.index; i += 1) missing.push(i);
      const reassign = errorsSinceIndex.slice(-missing.length);
      const offset = missing.length - reassign.length;
      reassign.forEach((entry, k) => {
        if (entry.index === current.index && entry === current.failure) {
          current.failed = false;
          current.failure = null;
        }
        entry.index = missing[offset + k];
        entry.name = null;
        entry.quantity = null;
      });
    }
    current = { ...card, failed: false, failure: null };
    if (cards.length < 100000) cards.push(card);
    lastAssignedIndex = card.index;
    errorsSinceIndex = [];
    continuation = null;
    lastActivity = 'card';
    rateWaitSeconds = null;
  }

  function onError(raw) {
    stats.errorLines += 1;
    if (!current) {
      // No card yet: a deck-level problem (e.g. KeyForge could not read a deck link).
      const entry = deckErrorFor('DECK_ERROR', raw);
      if (deckErrors.length < 100) deckErrors.push(entry);
      continuation = entry;
      return;
    }
    if (!current.failed) {
      const entry = { index: current.index, name: current.name, quantity: current.quantity, reason: mapFetchReason(raw), raw: String(raw).slice(0, MAX_RAW) };
      current.failed = true;
      current.failure = entry;
      recordFailure(entry);
      errorsSinceIndex.push(entry);
      return;
    }
    // A second error without a new Index line: a later card failed before printing its line.
    const index = Number.isFinite(lastAssignedIndex) ? lastAssignedIndex + 1 : null;
    if (index !== null) lastAssignedIndex = index;
    const entry = { index, name: null, quantity: null, reason: mapFetchReason(raw), raw: String(raw).slice(0, MAX_RAW) };
    recordFailure(entry);
    errorsSinceIndex.push(entry);
  }

  function onSkipping(rawLine) {
    stats.skippedLines += 1;
    let content = rawLine.slice(rawLine.indexOf(SKIPPING_PREFIX) + SKIPPING_PREFIX.length);
    if (content.startsWith('"')) content = content.slice(1);
    if (content.endsWith('"')) content = content.slice(0, -1);
    else pendingSkipQuote = true; // a "\r" inside the line split it: the closing quote comes alone
    content = content.replace(/[\uFEFF\r]/g, '').trim();
    if (content && ignoredLines.length < MAX_LIST) ignoredLines.push(content);
    continuation = null;
  }

  function push(entry, maybeStream) {
    const line = typeof entry === 'string' ? entry : entry && typeof entry.line === 'string' ? entry.line : String(entry ?? '');
    const stream = (entry && typeof entry === 'object' && entry.stream) || maybeStream || 'stdout';
    stats.lines += 1;
    if (stream === 'stderr') {
      stats.stderrLines += 1;
      return;
    }
    stats.stdoutLines += 1;
    const raw = line.replace(/\uFEFF/g, '');
    const t = raw.trim();

    if (pendingSkipQuote) {
      pendingSkipQuote = false;
      if (t === '"') return;
    }
    if (inSummary) {
      if (SUMMARY_ITEM_RE.test(raw)) return; // repeats an Error line already counted
      inSummary = false;
    }
    if (t === '') {
      continuation = null;
      return;
    }

    let m;
    const index = parseIndexLine(t);
    if (index) {
      stats.cardLines += 1;
      onIndex(index);
      return;
    }
    if ((m = ERROR_RE.exec(t))) {
      onError(m[1] || '');
      return;
    }
    if (t.startsWith('Skipping:')) {
      onSkipping(t.startsWith(SKIPPING_PREFIX) ? t : t.replace(/^Skipping:/, SKIPPING_PREFIX));
      return;
    }
    if (ERRORS_REPR_RE.test(t)) {
      continuation = null;
      return;
    }
    if (SUMMARY_HEADER_RE.test(t)) {
      inSummary = true;
      continuation = null;
      return;
    }
    if ((m = SLOT_RE.exec(t))) {
      const slash = m[2].indexOf(' / ');
      const name = (slash >= 0 ? m[2].slice(0, slash) : m[2]).trim() || null;
      stats.cardLines += 1;
      onIndex({ index: Number(m[1]), quantity: 1, name, fields: { name: name || '' } });
      return;
    }
    if ((m = URL_UNRECOGNIZED_RE.exec(t))) {
      deckErrors.push(deckErrorFor('DECK_URL_UNRECOGNIZED', t, { url: m[1] }));
      continuation = null;
      return;
    }
    if ((m = URL_FETCH_FAILED_RE.exec(t))) {
      deckErrors.push(deckErrorFor('DECK_URL_FAILED', m[1]));
      continuation = null;
      return;
    }
    if ((m = URL_PARSE_FAILED_RE.exec(t))) {
      deckErrors.push(deckErrorFor('DECK_URL_PRIVATE', m[1]));
      continuation = null;
      return;
    }
    if ((m = NOT_VALID_FILE_RE.exec(t))) {
      if (!fatal) fatal = { code: 'DECK_FILE_MISSING', message: 'The deck list file could not be found', raw: t, path: m[1] };
      continuation = null;
      return;
    }
    if (NOT_VALID_LINK_RE.test(t)) {
      deckErrors.push(deckErrorFor('DECK_URL_INVALID', t));
      continuation = null;
      return;
    }
    if (HEADER_RE.test(raw)) {
      continuation = null;
      return;
    }
    if ((m = SAVED_IMAGE_RE.exec(t))) {
      if (savedFiles.length < 100000) savedFiles.push(m[2]);
      lastActivity = 'saved';
      continuation = null;
      return;
    }
    if ((m = RATE_WAIT_RE.exec(t))) {
      rateWaitSeconds = Number(m[1]);
      lastActivity = 'rate';
      continuation = null;
      return;
    }
    if (continuation && !/^(?:Warning\b|\S+:\s)/.test(t)) {
      // A multi-line exception message continues the previous Error line.
      if (continuation.raw.length < MAX_RAW) {
        continuation.raw = `${continuation.raw}\n${t}`.slice(0, MAX_RAW);
        continuation.reason = continuation.code ? mapDeckReason(continuation.raw) : mapFetchReason(continuation.raw);
      }
      return;
    }
    continuation = null;
    if (WARNING_HINT_RE.test(t)) addWarning(t);
  }

  function result() {
    const quantities = cards.map((c) => c.quantity).filter((q) => Number.isFinite(q));
    const failedQuantity = failedCards.reduce((sum, f) => sum + (Number.isFinite(f.quantity) ? f.quantity : 1), 0);
    return {
      cards: cards.map((c) => ({ index: c.index, name: c.name, quantity: c.quantity })),
      failedCards: failedCards.map((f) => ({ index: f.index, name: f.name, quantity: f.quantity, reason: f.reason, raw: f.raw })),
      ignoredLines: ignoredLines.slice(),
      warnings: warnings.slice(),
      deckErrors: deckErrors.map((d) => ({ ...d })),
      fatal: fatal ? { ...fatal } : null,
      savedFiles: savedFiles.slice(),
      lastCard: current ? { index: current.index, name: current.name } : null,
      totalQuantity: quantities.length ? quantities.reduce((a, b) => a + b, 0) : null,
      failedQuantity,
      everyLineSkipped: cards.length === 0 && ignoredLines.length > 0 && !fatal && deckErrors.length === 0 && failedCards.length === 0,
      stats: { ...stats },
    };
  }

  function progressLabel() {
    if (lastActivity === 'rate' && rateWaitSeconds) return `The card website is busy: waiting ${rateWaitSeconds} seconds before trying again`;
    if (lastActivity === 'saved' && savedFiles.length) return `Saved ${savedFiles[savedFiles.length - 1]}`;
    return current ? cardLabel(current) : '';
  }

  return {
    push,
    result,
    progressLabel,
    get lastCard() {
      return current ? { index: current.index, name: current.name } : null;
    },
  };
}

/**
 * @typedef {object} FetchParseResult
 * @property {{ index: number, name: string|null, quantity: number|null }[]} cards every card the plugin started
 * @property {{ index: number|null, name: string|null, quantity: number|null, reason: string, raw: string }[]} failedCards
 * @property {string[]} ignoredLines non-empty lines the plugin did not recognize ("Skipping")
 * @property {string[]} warnings plain-language warnings
 * @property {{ code: string, reason: string, raw: string }[]} deckErrors problems with the deck itself
 *   (DECK_ERROR, DECK_URL_UNRECOGNIZED, DECK_URL_FAILED, DECK_URL_PRIVATE, DECK_URL_INVALID)
 * @property {{ code: 'DECK_FILE_MISSING', message: string, raw: string, path: string }|null} fatal
 * @property {string[]} savedFiles image names printed by plugins that list saved files (Yu-Gi-Oh!)
 * @property {{ index: number, name: string|null }|null} lastCard
 * @property {number|null} totalQuantity sum of the quantities of all started cards
 * @property {number} failedQuantity copies that failed (1 when the quantity is unknown)
 * @property {boolean} everyLineSkipped true when no card was recognized and some lines were skipped
 * @property {object} stats line counters
 */

/**
 * Parse a plugin's whole output (spec §9.6).
 * @param {Array<string|{ line: string, stream?: string }>} lines stdout lines (strings) or
 *   `{ line, stream }` entries; stderr entries are ignored
 * @returns {FetchParseResult}
 */
function parseFetchOutput(lines) {
  const parser = createFetchOutputParser();
  for (const entry of Array.isArray(lines) ? lines : []) parser.push(entry);
  return parser.result();
}

module.exports = {
  parseFetchOutput,
  mapFetchReason,
  mapDeckReason,
  createFetchOutputParser,
  parseIndexLine,
  cardLabel,
  KNOWN_FIELDS,
};
