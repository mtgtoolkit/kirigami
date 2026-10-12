'use strict';

/**
 * fetch.js — "Get cards": runs a game plugin (plugins/<id>/fetch.py) to download card images into
 * game/front (and game/double_sided) — spec §6 `fetch.start`, §9.6, §13.3.
 *
 * Flow (job kind 'fetch'):
 *  1. Before the job: validate the game and list format against the engine description
 *     (introspection) and the app's catalog, check the deck source and the options.
 *  2. Deck source → what the plugin gets:
 *     - text:  saved as game/decklist/<deck name>.txt (UTF-8, no BOM, LF; keep-both rule)
 *     - saved: that file (rewritten in place only when it has a BOM, CR line ends or isn't UTF-8)
 *     - file:  decoded (BOM / UTF-16 / Windows-1252) and copied to game/decklist (the original is
 *              never modified)
 *     - url / text_inline: the trimmed text (Elestrals: the 24-character deck ID is picked out)
 *  3. "Start fresh" (clearBeforeFetch): current fronts + unique backs go to the trash first and
 *     come back automatically when the download fails, is cancelled or adds no image.
 *  4. Plugin run: `<python> plugins/<id>/fetch.py --name=value … -- <deck> <format>` with
 *     cwd = workspace and the app's Python environment; progress = new/replaced images (polled every
 *     second) + the card the plugin is working on ("Card 12: Lightning Bolt").
 *  5. Result: counts, failed cards with plain reasons, unrecognized lines, warnings; or a
 *     plain-language failure. On success settings.fetch.lastFetched is updated.
 * MTG deck links from Deckstats, TappedOut, MTGGoldfish, MTGJSON or TCGplayer have no exact
 * printings: "Ignore exact printings" (ignore_set_and_collector_number) is turned on with a notice.
 *
 * No Electron: everything comes through `deps` (getPaths, settings, jobs, locks, helper, logger).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const util = require('./util');
const { userError, friendlyError, parsePythonError } = require('./errors');
const { createFetchOutputParser, cardLabel } = require('./fetch-parse');
const decklists = require('./decklists');
const cards = require('./cards');
const scan = require('./scan');
const locks = require('./locks');

const SOURCE_KINDS = Object.freeze(['text', 'saved', 'file', 'url', 'text_inline']);
const FILE_SOURCES = Object.freeze(['text', 'saved', 'file']);
const PLUGIN_ID_RE = /^[A-Za-z0-9_]+$/;
const PLUGIN_SCRIPT_RE = /^plugins\/[A-Za-z0-9_]+\/fetch\.py$/;
/** Codes picked out of a pasted text when the catalog can't say how (spec §9.6: Elestrals deck IDs). */
const BUILTIN_INLINE_EXTRACT = Object.freeze({ elestrals: /[0-9a-fA-F]{24}/ });
const POLL_MS = 1000;
const MAX_INLINE_CHARS = 20000;
const MAX_KEPT_STDOUT = 20000;
const STDERR_TAIL = 200;

/** MTG deck sites whose links carry no exact printings (spec §13.3). */
const MTG_NO_PRINTING_SITES = Object.freeze({
  'deckstats.net': 'Deckstats',
  'tappedout.net': 'TappedOut',
  'mtggoldfish.com': 'MTGGoldfish',
  'mtgjson.com': 'MTGJSON',
  'tcgplayer.com': 'TCGplayer',
});

const DECK_ERROR_MESSAGES = Object.freeze({
  DECK_URL_UNRECOGNIZED: "This link isn't from a deck website this game supports. Check the address, or export the deck as text and paste it instead.",
  DECK_URL_PRIVATE: "The deck couldn't be read from that link. It may be private or deleted, or the link may be incomplete.",
  DECK_URL_INVALID: "This isn't a valid deck link for this game. Copy the whole address from your browser's address bar.",
});

// ---------------------------------------------------------------------------------------------
// Catalog (renderer data module, pure ES module: loaded with require(esm); optional)
// ---------------------------------------------------------------------------------------------

let catalogModule;

/** @returns {object|null} the catalog module, or null when it can't be loaded */
function loadCatalog() {
  if (catalogModule !== undefined) return catalogModule;
  try {
    // eslint-disable-next-line global-require
    catalogModule = require(path.join(__dirname, '..', 'renderer', 'js', 'data', 'catalog.js'));
    if (!catalogModule || typeof catalogModule.getPlugin !== 'function') catalogModule = null;
  } catch {
    catalogModule = null;
  }
  return catalogModule;
}

function catalogInfo(pluginId, formatId) {
  const catalog = loadCatalog();
  const plugin = catalog ? catalog.getPlugin(pluginId) : null;
  const format = catalog && plugin ? catalog.getFormat(pluginId, formatId) : null;
  return {
    plugin,
    format,
    displayName: (plugin && plugin.displayName) || humanize(pluginId),
    formatLabel: (format && format.label) || humanize(formatId),
    inputKind: format ? format.inputKind : null,
  };
}

function humanize(id) {
  const s = String(id || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// ---------------------------------------------------------------------------------------------
// Pure helpers: argv, hosts, outcome
// ---------------------------------------------------------------------------------------------

function longFlag(param) {
  const flags = Array.isArray(param.flags) ? param.flags : [];
  return flags.find((f) => typeof f === 'string' && f.startsWith('--')) || `--${param.name}`;
}

function optionLabel(param) {
  return String(param.name || 'option').replace(/_/g, ' ');
}

function invalidOption(param, value) {
  return userError(`"${String(value).slice(0, 60)}" is not a valid value for the option "${optionLabel(param)}".`, { code: 'INVALID_OPTION' });
}

/** Validate one value for an option and return the string to pass. */
function checkValue(param, value) {
  const s = String(value);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(s)) throw invalidOption(param, s.replace(/[\r\n]+/g, ' '));
  if (param.type === 'choice' && Array.isArray(param.choices) && param.choices.length) {
    const exact = param.choices.find((c) => String(c) === s);
    if (exact !== undefined) return String(exact);
    if (param.caseSensitive === false) {
      const ci = param.choices.find((c) => String(c).toLowerCase() === s.toLowerCase());
      if (ci !== undefined) return String(ci);
    }
    throw invalidOption(param, s);
  }
  if (param.type === 'int' || param.type === 'int_range') {
    if (!/^[+-]?\d+$/.test(s.trim())) throw invalidOption(param, s);
    const n = Number(s);
    if ((Number.isFinite(param.min) && n < param.min) || (Number.isFinite(param.max) && n > param.max)) throw invalidOption(param, s);
    return String(n);
  }
  if (param.type === 'float' || param.type === 'float_range') {
    const n = Number(s.trim().replace(',', '.'));
    if (!Number.isFinite(n)) throw invalidOption(param, s);
    if ((Number.isFinite(param.min) && n < param.min) || (Number.isFinite(param.max) && n > param.max)) throw invalidOption(param, s);
    return String(n);
  }
  return s;
}

function isOn(value) {
  return value === true || value === 1 || value === 'true';
}

function isOff(value) {
  return value === false || value === 0 || value === 'false';
}

/**
 * Plugin command line (spec §9.6), pure:
 * `['plugins/<id>/fetch.py', ...options as --name=value, '--', deckPath, format]`.
 * Options: only names the plugin declares (introspection ParamSpec), in declaration order;
 * multiple → repeated in order; flags → `--flag` when true (the secondary `--no-…` flag when a
 * true-by-default flag is turned off); null / '' / default-equal values are omitted.
 * The `--` keeps a deck path or code starting with "-" from being read as an option.
 * @param {{ id: string, file?: string, params: object[] }} pluginSpec introspection plugin entry
 * @param {{ format: string, options?: Record<string, any> }} req
 * @param {string} deckPath cwd-relative POSIX deck file path, or the link / code
 * @returns {string[]}
 * @throws {Error} code INVALID_OPTION for values a choice/int/float option does not accept
 */
function buildFetchArgv(pluginSpec, req, deckPath) {
  if (!pluginSpec || typeof pluginSpec.id !== 'string' || !PLUGIN_ID_RE.test(pluginSpec.id)) throw new TypeError('buildFetchArgv: pluginSpec.id is required');
  if (!req || typeof req.format !== 'string' || !req.format) throw new TypeError('buildFetchArgv: req.format is required');
  if (typeof deckPath !== 'string' || !deckPath) throw new TypeError('buildFetchArgv: deckPath is required');
  // The script is always the cwd-relative plugins/<id>/fetch.py of the workspace.
  const declared = typeof pluginSpec.file === 'string' ? util.toPosix(pluginSpec.file) : '';
  const script = PLUGIN_SCRIPT_RE.test(declared) ? declared : `plugins/${pluginSpec.id}/fetch.py`;
  const options = req.options && typeof req.options === 'object' && !Array.isArray(req.options) ? req.options : {};
  const opts = [];
  for (const param of Array.isArray(pluginSpec.params) ? pluginSpec.params : []) {
    if (!param || param.kind !== 'option' || param.exposeValue === false || typeof param.name !== 'string') continue;
    if (!Object.prototype.hasOwnProperty.call(options, param.name)) continue;
    const value = options[param.name];
    const flag = longFlag(param);
    if (param.isFlag || param.type === 'bool') {
      if (isOn(value) && param.default !== true) {
        opts.push(flag);
      } else if (isOff(value) && param.default === true) {
        const secondary = (Array.isArray(param.secondaryFlags) ? param.secondaryFlags : []).find((f) => typeof f === 'string' && f.startsWith('--'));
        if (secondary) opts.push(secondary);
      }
      continue;
    }
    if (param.multiple) {
      const list = (Array.isArray(value) ? value : [value])
        .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
        .map((v) => String(v).trim())
        .filter(Boolean)
        .map((v) => checkValue(param, v));
      const def = Array.isArray(param.default) ? param.default.map((v) => String(v)) : [];
      if (!list.length || (list.length === def.length && list.every((v, i) => v === def[i]))) continue;
      for (const v of list) opts.push(`${flag}=${v}`);
      continue;
    }
    if (value === null || value === undefined || typeof value === 'object') continue;
    const s = typeof value === 'string' ? value.trim() : String(value);
    if (s === '') continue;
    const v = checkValue(param, s); // canonical form (choice spelling, normalized number)
    if (param.default !== null && param.default !== undefined && typeof param.default !== 'object' && String(param.default) === v) continue;
    opts.push(`${flag}=${v}`);
  }
  return [script, ...opts, '--', deckPath, req.format];
}

/**
 * The MTG deck site (display name) whose links lack exact printings, or null.
 * @param {string} plugin
 * @param {string} format
 * @param {string} link
 * @returns {string|null}
 */
function mtgSiteWithoutPrintings(plugin, format, link) {
  if (plugin !== 'mtg' || format !== 'url' || typeof link !== 'string') return null;
  let host;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(link.trim()) ? link.trim() : `https://${link.trim()}`).hostname.toLowerCase();
  } catch {
    return null;
  }
  for (const [domain, name] of Object.entries(MTG_NO_PRINTING_SITES)) {
    if (host === domain || host.endsWith(`.${domain}`)) return name;
  }
  return null;
}

/** "archidekt-8497473" from a deck link (for the PDF file name). */
function deckNameFromLink(link, fallback) {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(link) ? link : `https://${link}`);
    const labels = u.hostname.replace(/^www\./i, '').split('.');
    const site = labels.length > 1 ? labels[labels.length - 2] : labels[0];
    const segments = u.pathname.split('/').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    }).filter(Boolean);
    const last = segments.length ? segments[segments.length - 1].replace(/\.json$/i, '') : '';
    const raw = last ? `${site}-${last.length > 40 ? last.slice(0, 40) : last}` : site;
    return decklists.sanitizeDeckName(raw.replace(/[^\p{L}\p{N} _.-]+/gu, '-').replace(/-{2,}/g, '-')) || fallback;
  } catch {
    return fallback;
  }
}

function firstReasonSentence(failedCards) {
  const reasons = [...new Set(failedCards.map((f) => f.reason))];
  if (reasons.length === 1 && reasons[0] === 'no internet connection') {
    return 'No internet connection: check your connection and try again.';
  }
  if (reasons.length === 1 && reasons[0] === 'site busy, try again later') {
    return 'The card website is busy. Wait a minute and try again.';
  }
  const first = failedCards[0];
  const who = first.name ? `"${first.name}"` : cardLabel(first);
  return `Every card failed (for example ${who}: ${first.reason}).`;
}

/**
 * Decide whether a finished plugin run succeeded (spec §9.6), pure.
 * @param {{ exitCode: number|null, parsed: object, added: number, formatLabel: string }} input
 * @returns {{ ok: boolean, code: string|null, message: string|null }}
 *   code PROCESS_FAILED means "use friendlyError on the process failure"
 */
function decideFetchOutcome({ exitCode, parsed, added, formatLabel }) {
  if (exitCode !== 0) return { ok: false, code: 'PROCESS_FAILED', message: null };
  if (parsed.fatal && parsed.fatal.code === 'DECK_FILE_MISSING') {
    return { ok: false, code: 'DECK_FILE_MISSING', message: 'The deck list file could not be found.' };
  }
  if (added > 0) return { ok: true, code: null, message: null };
  if (parsed.everyLineSkipped) {
    return { ok: false, code: 'NO_CARDS_RECOGNIZED', message: `None of your lines were recognized. Is the list format right? (selected: ${formatLabel})` };
  }
  if (parsed.deckErrors.length) {
    const d = parsed.deckErrors[0];
    const explain = DECK_ERROR_MESSAGES[d.code]
      || (d.reason === 'no internet connection'
        ? "Couldn't reach the deck website. Check your internet connection and try again."
        : `The deck couldn't be downloaded (${d.reason}).`);
    return { ok: false, code: d.code === 'DECK_ERROR' ? 'DECK_FAILED' : d.code, message: `No images were downloaded. ${explain}` };
  }
  if (parsed.failedCards.length) {
    return { ok: false, code: 'ALL_CARDS_FAILED', message: `No images were downloaded. ${firstReasonSentence(parsed.failedCards)}` };
  }
  if (!parsed.cards.length && !parsed.ignoredLines.length && !parsed.savedFiles.length) {
    return { ok: false, code: 'NO_IMAGES', message: 'No images were downloaded. The card downloader found no cards in your list.' };
  }
  return { ok: false, code: 'NO_IMAGES', message: 'No images were downloaded.' };
}

// ---------------------------------------------------------------------------------------------
// Request validation (before the job starts)
// ---------------------------------------------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value : '';
}

/**
 * Check the request shape and the deck source against the plugin, format and catalog.
 * @returns {Promise<object>} normalized request + plugin spec + catalog info
 */
async function prepareRequest(deps, req) {
  if (!req || typeof req !== 'object') throw userError('Choose a game and a list first.', { code: 'INVALID_ARGUMENT' });
  const pluginId = str(req.plugin).trim();
  if (!PLUGIN_ID_RE.test(pluginId)) throw userError('Choose a game first.', { code: 'INVALID_ARGUMENT' });
  const formatIn = str(req.format).trim();
  if (!formatIn) throw userError('Choose the list format first.', { code: 'INVALID_ARGUMENT' });
  const source = req.source && typeof req.source === 'object' ? req.source : {};
  const sourceKind = SOURCE_KINDS.includes(source.kind) ? source.kind : null;
  if (!sourceKind) throw userError('Choose where your deck list comes from.', { code: 'INVALID_ARGUMENT' });
  const options = req.options && typeof req.options === 'object' && !Array.isArray(req.options) ? { ...req.options } : {};

  if (!deps.helper || typeof deps.helper.introspect !== 'function') {
    throw userError('Part of the app is missing (helper). Please reinstall Silhouette Card Maker.', { code: 'SERVICE_UNAVAILABLE' });
  }
  const intro = await deps.helper.introspect({});
  const spec = intro && Array.isArray(intro.plugins) ? intro.plugins.find((p) => p && p.id === pluginId) : null;
  const info0 = catalogInfo(pluginId, formatIn);
  if (!spec) throw userError(`${info0.displayName} isn't available in this version of the card maker.`, { code: 'UNKNOWN_PLUGIN' });
  if (spec.error) {
    throw userError(`The card downloader for ${info0.displayName} could not start. Open Settings and choose Repair components.`, { code: 'PLUGIN_BROKEN', details: String(spec.error) });
  }
  const formatParam = (spec.params || []).find((p) => p && p.kind === 'argument' && p.name === 'format');
  let format = formatIn;
  if (formatParam && Array.isArray(formatParam.choices) && formatParam.choices.length) {
    const exact = formatParam.choices.find((c) => c === formatIn);
    const ci = formatParam.caseSensitive === false ? formatParam.choices.find((c) => String(c).toLowerCase() === formatIn.toLowerCase()) : undefined;
    format = exact !== undefined ? exact : ci;
    if (format === undefined) throw userError(`"${formatIn}" is not a list format ${info0.displayName} understands.`, { code: 'UNKNOWN_FORMAT' });
  }
  const info = catalogInfo(pluginId, format);

  // Catalog options: lowercase set codes etc.
  if (info.plugin && Array.isArray(info.plugin.options)) {
    for (const opt of info.plugin.options) {
      if (opt.lowercase && Object.prototype.hasOwnProperty.call(options, opt.name)) {
        const v = options[opt.name];
        options[opt.name] = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toLowerCase() : x)) : typeof v === 'string' ? v.toLowerCase() : v;
      }
    }
  }

  // Source vs. input kind.
  const linkLike = info.inputKind === 'url' || info.inputKind === 'text_inline';
  const fileLike = info.inputKind === 'file' || (!info.inputKind && FILE_SOURCES.includes(sourceKind));
  const out = {
    plugin: pluginId,
    format,
    spec,
    info,
    options,
    clearBeforeFetch: req.clearBeforeFetch === true,
    source: { kind: sourceKind },
  };
  if (linkLike || (!fileLike && !info.inputKind)) {
    if (sourceKind === 'saved' || sourceKind === 'file') {
      throw userError(`${info.formatLabel} needs ${info.inputKind === 'url' ? 'a link' : 'a code'}: paste it instead of choosing a file.`, { code: 'WRONG_SOURCE' });
    }
    let value = (sourceKind === 'text' ? str(source.text) : str(source.url) || str(source.text)).trim();
    if (!value) throw userError(info.inputKind === 'text_inline' ? 'Paste the deck code first.' : 'Paste the deck link first.', { code: 'EMPTY_LIST' });
    if (value.length > MAX_INLINE_CHARS) throw userError('This is too long to be a deck link or code.', { code: 'INVALID_ARGUMENT' });
    if (/[\r\n]/.test(value)) throw userError('Paste only one link or code (a single line).', { code: 'INVALID_ARGUMENT' });
    const f = info.format;
    if (f && f.pattern) {
      let re = null;
      try {
        re = new RegExp(f.pattern);
      } catch {
        re = null; // a broken pattern never blocks the user
      }
      if (re) {
        const m = re.exec(value);
        if (!m) {
          throw userError(
            info.inputKind === 'url'
              ? `This doesn't look like a ${info.formatLabel.toLowerCase()} for ${info.displayName}. Check that you copied the whole address.`
              : `This doesn't look like a ${info.formatLabel.toLowerCase()}. Check that you copied the whole code.`,
            { code: 'BAD_LINK' },
          );
        }
        if (f.extract && info.inputKind === 'text_inline') value = m[0];
      }
    } else if (BUILTIN_INLINE_EXTRACT[pluginId] && (info.inputKind === 'text_inline' || sourceKind === 'text_inline')) {
      // No catalog entry: still pick the deck ID out of a pasted link ("when present").
      const m = BUILTIN_INLINE_EXTRACT[pluginId].exec(value);
      if (m) value = m[0];
    }
    out.source.value = value;
    const isLink = info.inputKind === 'url' || (!info.inputKind && sourceKind === 'url');
    out.deckName = decklists.sanitizeDeckName(str(source.deckName))
      || (isLink ? deckNameFromLink(value, `${pluginId}-deck`) : (pluginId === 'elestrals' ? `elestrals-${value.slice(0, 8)}` : `${pluginId}-deck`));
    out.siteWithoutPrintings = mtgSiteWithoutPrintings(pluginId, format, value);
  } else {
    if (sourceKind === 'url' || sourceKind === 'text_inline') {
      throw userError(`${info.formatLabel} is a deck list: paste the list or choose its file.`, { code: 'WRONG_SOURCE' });
    }
    if (sourceKind === 'text') {
      const text = str(source.text);
      if (!text.trim()) throw userError('Paste your deck list first.', { code: 'EMPTY_LIST' });
      const rawName = str(source.deckName).trim();
      const name = decklists.sanitizeDeckName(rawName);
      if (rawName && !name) throw userError(`"${rawName.slice(0, 60)}" can't be used as a list name on Windows. Choose another name.`, { code: 'BAD_NAME' });
      out.source.text = text;
      out.deckName = (name || 'my-deck').replace(/\.txt$/i, '') || 'my-deck';
    } else if (sourceKind === 'saved') {
      const savedName = str(source.savedName);
      if (!savedName || /[\\/]/.test(savedName)) throw userError('Choose a saved list first.', { code: 'INVALID_ARGUMENT' });
      const abs = util.resolveInside(decklists.decklistDir(deps), savedName);
      let st = null;
      try {
        st = await fsp.stat(abs);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) throw userError(`The saved list "${savedName}" no longer exists.`, { code: 'NOT_FOUND' });
      if (st.size === 0) throw userError(`The saved list "${savedName}" is empty.`, { code: 'EMPTY_LIST' });
      out.source.savedName = savedName;
      out.source.abs = abs;
      out.deckName = path.parse(savedName).name || 'my-deck';
    } else {
      const filePath = str(source.filePath);
      if (!filePath || !path.isAbsolute(filePath)) throw userError('Choose your deck list file first.', { code: 'INVALID_ARGUMENT' });
      let st = null;
      try {
        st = await fsp.stat(filePath);
      } catch {
        st = null;
      }
      if (!st || !st.isFile()) throw userError(`The file "${path.basename(filePath)}" could not be found.`, { code: 'NOT_FOUND' });
      if (st.size === 0) throw userError(`The file "${path.basename(filePath)}" is empty.`, { code: 'EMPTY_LIST' });
      if (st.size > decklists.MAX_DECK_BYTES) throw userError(`"${path.basename(filePath)}" is too big to be a deck list.`, { code: 'DECK_TOO_BIG' });
      out.source.filePath = path.resolve(filePath);
      out.deckName = decklists.sanitizeDeckName(path.parse(filePath).name) || 'my-deck';
    }
  }
  if (out.siteWithoutPrintings && out.options.ignore_set_and_collector_number !== true) {
    out.options.ignore_set_and_collector_number = true;
    out.notice = `${out.siteWithoutPrintings} links don't include exact printings, so "Ignore exact printings" was turned on for this download.`;
  }
  // Validate the options now (throws INVALID_OPTION) so a bad value never starts a job.
  buildFetchArgv(spec, { format, options: out.options }, 'deck.txt');
  return out;
}

// ---------------------------------------------------------------------------------------------
// File snapshots (what the plugin added or replaced)
// ---------------------------------------------------------------------------------------------

/**
 * Files under a card folder with a `size:mtimeMs` signature (junk, placeholders and *.tmp skipped),
 * to tell which images a plugin added or replaced. Never throws (unreadable folders are skipped).
 * @param {string} root
 * @returns {Promise<Map<string, string>>} posix rel -> signature
 */
async function snapshotDir(root) {
  const out = new Map();
  const walk = async (absDir, rel, depth) => {
    let entries;
    try {
      entries = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        if (depth < 32) await walk(abs, childRel, depth + 1);
        continue;
      }
      if (scan.isJunkName(entry.name) || scan.isIgnoredName(entry.name) || /\.tmp$/i.test(entry.name)) continue;
      try {
        const st = await fsp.stat(abs);
        if (st.isFile()) out.set(childRel, `${st.size}:${st.mtimeMs}`);
      } catch {
        /* being written */
      }
    }
  };
  await walk(root, '', 0);
  return out;
}

/**
 * Files that are new or changed between two snapshots (snapshotDir).
 * @param {Map<string, string>} before
 * @param {Map<string, string>} after
 * @returns {string[]} posix rels
 */
function changedRels(before, after) {
  const out = [];
  for (const [rel, sig] of after) if (before.get(rel) !== sig) out.push(rel);
  return out;
}

// ---------------------------------------------------------------------------------------------
// The job
// ---------------------------------------------------------------------------------------------

/**
 * Start downloading cards (spec §6 `fetch.start`). Validation happens first (errors reject this
 * call); the download itself runs as job 'fetch'.
 * @param {object} deps
 * @param {{ plugin: string, format: string, source: { kind: 'text'|'saved'|'file'|'url'|'text_inline',
 *   text?: string, deckName?: string, savedName?: string, filePath?: string, url?: string },
 *   options?: Record<string, any>, clearBeforeFetch?: boolean }} req
 * @returns {Promise<string>} jobId
 */
async function startFetchJob(deps, req) {
  if (!deps.jobs || typeof deps.jobs.start !== 'function') throw userError('The task runner is not available.', { code: 'SERVICE_UNAVAILABLE' });
  const active = typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw locks.busyError(active.title);
  const request = await prepareRequest(deps, req);
  return deps.jobs.start('fetch', {
    title: `Downloading ${request.info.displayName} cards`,
    steps: [
      { id: 'prepare', label: 'Preparing your list' },
      { id: 'download', label: 'Downloading card images' },
      { id: 'finish', label: 'Checking the results' },
    ],
  }, (ctx) => runFetch(ctx, deps, request));
}

async function resolveDeckPath(ctx, deps, request) {
  const { source } = request;
  if (source.value !== undefined) return { deckPath: source.value, deckFile: null, savedName: null };
  const dir = decklists.decklistDir(deps);
  if (source.kind === 'text') {
    const saved = await decklists.saveDeckText(deps, request.deckName, source.text, { keepBoth: true });
    ctx.log(saved.unchanged ? `Using the saved list ${saved.name}.` : `Saved your list as ${saved.name}.`);
    return { deckPath: `game/decklist/${saved.name}`, deckFile: saved.path, savedName: saved.name };
  }
  if (source.kind === 'saved') {
    if (await decklists.normalizeDeckFileInPlace(source.abs)) ctx.log(`Converted ${source.savedName} to plain UTF-8 text so the card downloader reads every line.`);
    return { deckPath: `game/decklist/${source.savedName}`, deckFile: source.abs, savedName: source.savedName };
  }
  // file: never modify the original; a file already in game/decklist is used like a saved list
  if (util.samePath(path.dirname(path.resolve(source.filePath)), dir)) {
    const name = path.basename(source.filePath);
    if (await decklists.normalizeDeckFileInPlace(source.filePath)) ctx.log(`Converted ${name} to plain UTF-8 text.`);
    return { deckPath: `game/decklist/${name}`, deckFile: source.filePath, savedName: name };
  }
  const text = decklists.decodeDeckBytes(await decklists.readBytesLimited(source.filePath));
  if (!text.trim()) throw userError(`The file "${path.basename(source.filePath)}" is empty.`, { code: 'EMPTY_LIST' });
  const parsed = path.parse(source.filePath);
  const name = `${decklists.sanitizeDeckName(parsed.name) || 'my-deck'}${parsed.ext}`;
  const saved = await decklists.saveDeckText(deps, name, text, { keepBoth: true, keepExtension: true });
  ctx.log(`Copied ${path.basename(source.filePath)} to the saved lists as ${saved.name}.`);
  return { deckPath: `game/decklist/${saved.name}`, deckFile: saved.path, savedName: saved.name };
}

async function putBackPrevious(ctx, deps, previousBatchId, changed) {
  try {
    if (changed.length) {
      const r = await cards.trashItems(deps, changed, 'incomplete-download');
      if (r.batchId) ctx.log(`The images of the unfinished download were moved to "Recently removed" (${r.moved.length}).`);
    }
    await cards.restoreBatchInternal(deps, previousBatchId);
    ctx.warn('Your previous cards were put back.');
  } catch (err) {
    ctx.warn('Your previous cards could not be put back automatically. Restore them from "Recently removed" in Your cards.');
    const log = deps.logger;
    if (log && typeof log.warn === 'function') log.warn('[fetch] Restoring the previous cards failed:', err);
  }
}

/** "Start fresh": move the current fronts and unique backs to the trash. Returns the batch id (or null). */
async function setAsidePrevious(ctx, deps, p) {
  const items = [];
  for (const kind of ['front', 'double_sided']) {
    const s = await scan.scanDir(p.gameDir(kind), { sizes: false });
    for (const i of [...s.images, ...s.others]) items.push({ kind, rel: i.rel });
  }
  if (!items.length) return null;
  const r = await cards.trashItems(deps, items, 'before-download');
  if (r.failed.length) {
    if (r.batchId) await cards.restoreBatchInternal(deps, r.batchId).catch(() => {});
    throw userError(`Your current cards could not be set aside: ${r.failed.length} file(s) are open in another program. Close them, or turn off "Start fresh".`, {
      code: 'FILE_LOCKED',
      details: r.failed.map((f) => `${f.kind}/${f.rel}: ${f.error && f.error.message}`).join('\n'),
    });
  }
  ctx.log(`Your current cards were moved to "Recently removed" (${r.moved.length} files).`);
  return r.batchId;
}

function hostOf(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

/** Python errors that mean "the list / the deck could not be read" (not a network or setup problem). */
const READ_ERROR_TYPES = new Set(['JSONDecodeError', 'ParseError', 'ExpatError', 'KeyError', 'IndexError', 'ValueError', 'TypeError', 'AttributeError', 'StopIteration', 'Error']);

/**
 * Plain wording for a plugin crash while reading the list or the deck (errors.friendlyError has no
 * rule for these and would show the raw Python message), or null.
 * @param {object} request prepared request
 * @param {{ type: string|null }|null} pythonError
 * @returns {string|null}
 */
function readFailureMessage(request, pythonError) {
  const type = pythonError && typeof pythonError.type === 'string' ? pythonError.type.split('.').pop() : null;
  if (!type || !READ_ERROR_TYPES.has(type)) return null;
  const label = request.info.formatLabel;
  if (request.source.value !== undefined) {
    const what = request.info.inputKind === 'text_inline' ? 'code' : 'link';
    return `The card downloader couldn't read this deck (${label}). Check the ${what}; the deck website may also have changed.`;
  }
  return `The card downloader couldn't read your list as "${label}". Check that this is the right list format and that the whole list was copied.`;
}

/** The plain-language failure of a finished plugin run (spec §9.6). */
function outcomeError(outcome, { request, res, argv, stderrTail }) {
  let message = outcome.message;
  let code = outcome.code;
  let details = [
    `Command: python ${argv.join(' ')}`,
    `Exit code: ${res.code}`,
    ...(stderrTail.length ? ['', stderrTail.slice(-60).join('\n')] : []),
  ].join('\n');
  if (outcome.code === 'PROCESS_FAILED') {
    const { JobProcessError } = require('./jobs'); // eslint-disable-line global-require
    const err = new JobProcessError({
      code: res.code, signal: res.signal, stderrTail: stderrTail.slice(-30), stdoutTail: res.stdoutTail || [],
      pythonError: parsePythonError(stderrTail), command: `python ${argv.join(' ')}`, program: 'the card downloader',
    });
    const host = hostOf(request.source.value);
    const fe = friendlyError({ err, kind: 'fetch', context: host ? { host } : {} });
    message = fe.message;
    code = fe.code;
    details = fe.details || details;
    const readFailure = fe.code === 'UNKNOWN' ? readFailureMessage(request, err.pythonError) : null;
    if (readFailure) {
      message = readFailure;
      code = 'LIST_UNREADABLE';
    }
  }
  const plugin = request.info.plugin;
  if (plugin && plugin.status === 'broken' && plugin.statusMessage) message = `${message} (${request.info.displayName}: ${plugin.statusMessage})`;
  return userError(message, { code, details });
}

/** Downloaded files the card maker cannot read (e.g. an error page saved as .png); never throws. */
async function unusableDownloads(p, changed) {
  const bad = [];
  try {
    for (const kind of ['front', 'double_sided']) {
      const rels = new Set(changed.filter((c) => c.kind === kind).map((c) => c.rel));
      if (!rels.size) continue;
      const s = await scan.scanDir(p.gameDir(kind), { sizes: false });
      for (const o of s.others) if (rels.has(o.rel)) bad.push(o.rel);
    }
  } catch {
    /* best effort */
  }
  return bad;
}

async function countImages(dir) {
  try {
    return (await scan.scanDir(dir, { sizes: false })).images.length;
  } catch {
    return null;
  }
}

async function runFetch(ctx, deps, request) {
  const p = deps.getPaths();
  const frontDir = p.gameDir('front');
  const dsDir = p.gameDir('double_sided');
  const notices = request.notice ? [request.notice] : [];
  ctx.step('prepare', 'running');
  try {
    await fsp.access(p.pythonPath);
  } catch {
    throw userError('The card maker components are not installed yet. Open Setup to install them.', { code: 'NOT_INSTALLED' });
  }
  await fsp.mkdir(frontDir, { recursive: true });
  await fsp.mkdir(dsDir, { recursive: true });
  const deck = await resolveDeckPath(ctx, deps, request);
  if (request.notice) ctx.log(request.notice);
  ctx.throwIfCancelled();

  const previousBatchId = request.clearBeforeFetch ? await setAsidePrevious(ctx, deps, p) : null;
  // From here on, every failure (also a cancel or an unexpected error) puts the previous cards
  // back exactly once; a finished download (`kept`) is never undone.
  let before = null;
  let poll = null;
  let kept = false;
  const changedItems = async () => {
    if (!before) return [];
    const [f, d] = await Promise.all([snapshotDir(frontDir), snapshotDir(dsDir)]);
    return [
      ...changedRels(before.front, f).map((rel) => ({ kind: 'front', rel })),
      ...changedRels(before.double_sided, d).map((rel) => ({ kind: 'double_sided', rel })),
    ];
  };
  try {
    before = { front: await snapshotDir(frontDir), double_sided: await snapshotDir(dsDir) };
    ctx.step('prepare', 'done');

    const argv = buildFetchArgv(request.spec, { format: request.format, options: request.options }, deck.deckPath);
    const parser = createFetchOutputParser();
    const stderrTail = [];
    let stdoutKept = 0;
    let imagesSoFar = 0;
    const report = () => {
      const label = parser.progressLabel();
      const count = imagesSoFar > 0 ? `${imagesSoFar} image${imagesSoFar === 1 ? '' : 's'} so far` : '';
      ctx.progress({ percent: null, current: imagesSoFar, total: null, label: label && count ? `${label} (${count})` : label || count || 'Starting the card downloader' });
    };
    const onLine = (line, stream) => {
      if (stream === 'stderr') {
        stderrTail.push(line);
        if (stderrTail.length > STDERR_TAIL) stderrTail.shift();
        return;
      }
      if (stdoutKept < MAX_KEPT_STDOUT) {
        stdoutKept += 1;
        parser.push(line, 'stdout');
        if (/^(Index:|Slot \d|Hit .*rate limit)/.test(line) || /[\\/]game[\\/]/.test(line)) report();
      }
    };
    let polling = false;
    poll = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const [f, d] = await Promise.all([snapshotDir(frontDir), snapshotDir(dsDir)]);
        imagesSoFar = changedRels(before.front, f).length + changedRels(before.double_sided, d).length;
        report();
      } catch {
        /* next tick */
      } finally {
        polling = false;
      }
    }, POLL_MS);
    if (typeof poll.unref === 'function') poll.unref();

    ctx.step('download', 'running');
    report();
    const spawnIt = () => ctx.spawn(p.pythonPath, argv, {
      cwd: p.workspaceDir, env: ctx.pythonEnv(), onLine, allowNonZero: true, name: 'the card downloader',
    });
    const res = deps.locks && typeof deps.locks.withPythonShared === 'function' ? await deps.locks.withPythonShared(spawnIt) : await spawnIt();
    clearInterval(poll);
    poll = null;
    ctx.step('download', 'done');

    ctx.step('finish', 'running');
    const changed = await changedItems();
    const parsed = parser.result();
    // Files the card maker can't read (e.g. an error page saved as .png) are not "added images":
    // a download that produced only those must not count as a success (and, with "Start fresh",
    // must put the previous cards back).
    const bad = await unusableDownloads(p, changed);
    const outcome = decideFetchOutcome({ exitCode: res.code, parsed, added: changed.length - bad.length, formatLabel: request.info.formatLabel });
    if (!outcome.ok && outcome.code === 'NO_IMAGES' && bad.length) {
      outcome.message = `No usable images were downloaded: ${bad.length === 1 ? 'the downloaded file is' : `the ${bad.length} downloaded files are`} not ${bad.length === 1 ? 'an image' : 'images'} the card maker can use. The card website may have changed; try again later.`;
    }
    if (!outcome.ok) throw outcomeError(outcome, { request, res, argv, stderrTail });
    kept = true;

    const addedFront = changed.filter((c) => c.kind === 'front').length;
    const warnings = [...notices, ...parsed.warnings];
    if (bad.length) {
      warnings.push(`${bad.length} downloaded file${bad.length === 1 ? ' is' : 's are'} not ${bad.length === 1 ? 'an image' : 'images'} the card maker can use and will be ignored: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? '…' : ''}.`);
    }
    const totals = { front: await countImages(frontDir), double_sided: await countImages(dsDir) };
    const at = new Date().toISOString();
    try {
      deps.settings.update({ fetch: { lastFetched: { plugin: request.plugin, format: request.format, deckName: request.deckName, at, added: changed.length } } });
    } catch (err) {
      if (deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn('[fetch] Could not save lastFetched:', err);
    }
    ctx.step('finish', 'done');
    const cardsTotal = parsed.totalQuantity;
    ctx.log(`Downloaded ${changed.length} image(s)${parsed.failedCards.length ? `; ${parsed.failedCards.length} card(s) failed` : ''}${parsed.ignoredLines.length ? `; ${parsed.ignoredLines.length} line(s) not recognized` : ''}.`);
    return {
      added: changed.length,
      front: addedFront,
      double_sided: changed.length - addedFront,
      failedCards: parsed.failedCards,
      ignoredLines: parsed.ignoredLines,
      warnings,
      previousBatchId,
      deckPath: deck.deckPath,
      // extras
      deckFile: deck.deckFile,
      savedName: deck.savedName,
      deckName: request.deckName,
      plugin: request.plugin,
      format: request.format,
      formatLabel: request.info.formatLabel,
      gameName: request.info.displayName,
      cardsTotal,
      cardsFailed: parsed.failedQuantity,
      cardsOk: Number.isFinite(cardsTotal) ? Math.max(0, cardsTotal - parsed.failedQuantity) : null,
      totals,
      notices,
      at,
    };
  } catch (err) {
    if (poll) clearInterval(poll);
    if (!kept) {
      const changed = await changedItems().catch(() => []);
      if (previousBatchId) {
        await putBackPrevious(ctx, deps, previousBatchId, changed);
      } else if (changed.length) {
        ctx.warn(ctx.cancelled
          ? `${changed.length} image(s) were downloaded before you stopped. They are in Your cards (the last one may be incomplete).`
          : `${changed.length} image(s) were downloaded before the problem. They are in Your cards.`);
      }
      for (const n of notices) ctx.warn(n);
    }
    throw err;
  }
}

module.exports = {
  buildFetchArgv,
  startFetchJob,
  // extras (pure, unit-tested)
  decideFetchOutcome,
  mtgSiteWithoutPrintings,
  deckNameFromLink,
  prepareRequest,
  snapshotDir,
  changedRels,
  MTG_NO_PRINTING_SITES,
};
