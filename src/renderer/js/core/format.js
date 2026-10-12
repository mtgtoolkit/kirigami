/**
 * Pure formatting helpers shared by every renderer view.
 *
 * This module never touches the DOM or `window`, so Node unit tests can import it directly
 * (src/renderer/package.json declares `"type": "module"`).
 *
 * @module core/format
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
const DEFAULT_LOCALE = 'en-US';

/**
 * @param {unknown} value
 * @returns {number|null} a finite number, or null for null/undefined/''/NaN/Infinity.
 */
function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Format a byte count for humans using binary multiples and the familiar Windows labels
 * ("KB", "MB", "GB"): `0 B`, `512 B`, `1.5 KB`, `601 MB`, `4.2 GB`.
 * Values below 10 units get one decimal (trailing `.0` dropped), larger values none.
 *
 * @param {number|string|null|undefined} bytes
 * @param {{ decimals?: number }} [options] force a number of decimals for non-byte units.
 * @returns {string} '—' when the input is not a finite number.
 */
export function formatBytes(bytes, { decimals } = {}) {
  const n = toFiniteNumber(bytes);
  if (n === null) return '—';
  const sign = n < 0 ? '-' : '';
  let value = Math.abs(n);
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${sign}${Math.round(value)} B`;
  let digits = decimals ?? (value < 10 ? 1 : 0);
  let text = value.toFixed(digits);
  if (Number(text) >= 1024 && unit < BYTE_UNITS.length - 1) {
    // e.g. 1023.7 KB rounds to "1024 KB": promote to the next unit.
    value = Number(text) / 1024;
    unit += 1;
    digits = decimals ?? 1;
    text = value.toFixed(digits);
  }
  if (decimals === undefined && text.includes('.')) text = text.replace(/\.0+$/, '');
  return `${sign}${text} ${BYTE_UNITS[unit]}`;
}

/**
 * Format a duration in milliseconds.
 *
 * Exact style (default): `0.4 s`, `45 s`, `2 min 5 s`, `3 min`, `1 h 20 min`.
 * Approximate style (`{ approximate: true }`, for estimates): `less than a minute`, `about 3 min`,
 * `about 1 h 20 min`.
 *
 * @param {number|null|undefined} ms
 * @param {{ approximate?: boolean }} [options]
 * @returns {string} '—' for missing/negative/non-finite input.
 */
export function formatDuration(ms, { approximate = false } = {}) {
  const n = toFiniteNumber(ms);
  if (n === null || n < 0) return '—';
  if (approximate) {
    if (n < 45_000) return 'less than a minute';
    const totalMin = Math.round(n / 60_000);
    if (totalMin < 60) return `about ${totalMin} min`;
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return m ? `about ${h} h ${m} min` : `about ${h} h`;
  }
  if (n === 0) return '0 s';
  if (n < 950) return `${(n / 1000).toFixed(1)} s`;
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return `${totalSec} s`;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  return s ? `${m} min ${s} s` : `${m} min`;
}

/**
 * Stopwatch-style elapsed time with a stable width: `0:05`, `12:34`, `1:02:03`.
 *
 * @param {number|null|undefined} ms
 * @returns {string} '0:00' for missing/negative input.
 */
export function formatClock(ms) {
  const n = toFiniteNumber(ms);
  const totalSec = n === null || n < 0 ? 0 : Math.floor(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/**
 * Locale-aware number formatting with thousands separators (`1,234`, `12.5`).
 *
 * @param {number|string|null|undefined} value
 * @param {{ decimals?: number, maximumFractionDigits?: number, locale?: string }} [options]
 *   `decimals` fixes the number of fraction digits; otherwise up to `maximumFractionDigits` (default 2).
 * @returns {string} '—' when the input is not a finite number.
 */
export function formatNumber(value, { decimals, maximumFractionDigits = 2, locale = DEFAULT_LOCALE } = {}) {
  const n = toFiniteNumber(value);
  if (n === null) return '—';
  const opts = decimals !== undefined
    ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals }
    : { maximumFractionDigits };
  try {
    return new Intl.NumberFormat(locale, opts).format(n);
  } catch {
    return String(n);
  }
}

/**
 * Derive an English plural: card→cards, copy→copies, box→boxes, batch→batches.
 * @param {string} word
 * @returns {string}
 */
function autoPlural(word) {
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(word)) return `${word}es`;
  return `${word}s`;
}

/**
 * Pick the singular or plural form for a count: `pluralize(1, 'card')` → `1 card`,
 * `pluralize(3, 'copy')` → `3 copies`, `pluralize(2, 'card', { includeCount: false })` → `cards`.
 *
 * @param {number} count
 * @param {string} singular
 * @param {string|{ includeCount?: boolean }} [plural] explicit plural form (derived when omitted),
 *   or the options object.
 * @param {{ includeCount?: boolean }} [options]
 * @returns {string}
 */
export function pluralize(count, singular, plural, options) {
  let pluralForm = plural;
  let opts = options;
  if (plural && typeof plural === 'object') {
    opts = plural;
    pluralForm = undefined;
  }
  const { includeCount = true } = opts || {};
  const n = toFiniteNumber(count) ?? 0;
  const word = Math.abs(n) === 1 ? singular : (pluralForm || autoPlural(String(singular)));
  return includeCount ? `${formatNumber(n)} ${word}` : word;
}

/**
 * Quote one command-line argument for DISPLAY (the "Show command" panel). Safe tokens are left
 * as-is; anything else is wrapped in double quotes using the Windows argv escaping rules
 * (backslashes before a quote are doubled).
 *
 * @param {unknown} arg
 * @returns {string}
 */
export function quoteArg(arg) {
  const s = arg === null || arg === undefined ? '' : String(arg);
  if (s === '') return '""';
  if (/^[\w\-.,:/\\=@+%]+$/.test(s)) return s;
  const escaped = s
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * Escape text for safe interpolation into HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @param {unknown} value Date, epoch ms, or ISO string.
 * @returns {Date|null}
 */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Calendar date parts of `d` in `timeZone` (default: local).
 * @param {Date} d
 * @param {string|undefined} timeZone
 * @returns {{ y: number, m: number, day: number }}
 */
function calendarParts(d, timeZone) {
  if (!timeZone) return { y: d.getFullYear(), m: d.getMonth() + 1, day: d.getDate() };
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' })
    .formatToParts(d);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get('year'), m: get('month'), day: get('day') };
}

/**
 * Human date relative to "now": `today at 2:32 PM`, `yesterday at 9:10 AM`, `Monday at 4:00 PM`,
 * `Oct 3, 2:32 PM` (same year) or `Oct 3, 2025`.
 *
 * @param {Date|number|string|null|undefined} value
 * @param {{ now?: Date|number|string, locale?: string, timeZone?: string, absolute?: boolean, dateOnly?: boolean }} [options]
 *   `locale` defaults to the system locale; `absolute` disables the today/yesterday/weekday wording;
 *   `dateOnly` omits the time.
 * @returns {string} '—' for invalid input.
 */
export function formatDate(value, options = {}) {
  const d = toDate(value);
  if (!d) return '—';
  const { locale, timeZone, absolute = false, dateOnly = false } = options;
  const now = toDate(options.now ?? Date.now()) || new Date();
  const fmt = (o) => {
    try {
      return new Intl.DateTimeFormat(locale, { ...o, timeZone }).format(d);
    } catch {
      return new Intl.DateTimeFormat(DEFAULT_LOCALE, o).format(d);
    }
  };
  const time = fmt({ hour: 'numeric', minute: '2-digit' });
  const a = calendarParts(d, timeZone);
  const b = calendarParts(now, timeZone);
  const dayDiff = Math.round((Date.UTC(b.y, b.m - 1, b.day) - Date.UTC(a.y, a.m - 1, a.day)) / 86_400_000);
  if (!absolute) {
    if (dayDiff === 0) return dateOnly ? 'today' : `today at ${time}`;
    if (dayDiff === 1) return dateOnly ? 'yesterday' : `yesterday at ${time}`;
    if (dayDiff > 1 && dayDiff < 7) {
      const weekday = fmt({ weekday: 'long' });
      return dateOnly ? weekday : `${weekday} at ${time}`;
    }
  }
  const sameYear = a.y === b.y;
  const date = fmt(sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
  if (dateOnly) return date;
  return sameYear ? `${date}, ${time}` : date;
}

/**
 * Extract a stable error code from an error thrown by the preload bridge. Codes travel inside the
 * message because contextBridge only preserves `message` (e.g. `BUSY: wait until "Make PDF" finishes`,
 * `NOT_READY`).
 *
 * @param {unknown} err
 * @returns {string|null} e.g. 'BUSY', 'NOT_READY', 'OUT_OF_MEMORY', or null.
 */
export function errorCode(err) {
  if (!err) return null;
  if (typeof err === 'object' && typeof err.code === 'string' && /^[A-Z][A-Z0-9_]{2,}$/.test(err.code)) return err.code;
  const raw = stripErrorPrefixes(typeof err === 'string' ? err : String(err.message ?? ''));
  const m = /^([A-Z][A-Z0-9_]{2,})(?::|$)/.exec(raw.trim());
  return m ? m[1] : null;
}

/**
 * @param {string} msg
 * @returns {string}
 */
function stripErrorPrefixes(msg) {
  return String(msg)
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^(?:Uncaught\s+)?(?:Error|TypeError|RangeError):\s*/, '');
}

const CODE_MESSAGES = {
  NOT_READY: 'Finish setting up the card maker first (open the Setup page).',
  NOT_IN_APP: 'This only works inside the Kirigami desktop app.',
};

/**
 * Turn any thrown value (Error, friendly `{ message }` object, string) into one plain-language
 * sentence for the UI. Raw Electron prefixes and machine codes are removed; `BUSY:` becomes
 * "Please wait until … finishes.".
 *
 * @param {unknown} err
 * @param {string} [fallback]
 * @returns {string}
 */
export function errorMessage(err, fallback = 'Something went wrong.') {
  if (err === null || err === undefined || err === '') return fallback;
  if (typeof err === 'object' && typeof err.userMessage === 'string' && err.userMessage) return err.userMessage;
  let msg = typeof err === 'string' ? err : String(err.message ?? err ?? '');
  msg = stripErrorPrefixes(msg).trim();
  const code = errorCode(err);
  if (code) {
    const rest = msg.replace(new RegExp(`^${code}:?\\s*`), '').trim();
    if (code === 'BUSY') {
      if (!rest) return 'Please wait until the current task finishes.';
      if (/^wait\b/i.test(rest)) return ensurePeriod(`Please ${rest.charAt(0).toLowerCase()}${rest.slice(1)}`);
      return `Please wait until "${rest.replace(/^"|"$/g, '')}" finishes.`;
    }
    if (rest) msg = rest;
    else return CODE_MESSAGES[code] || fallback;
  }
  if (!msg) return fallback;
  return msg.charAt(0).toUpperCase() + msg.slice(1);
}

/**
 * @param {string} s
 * @returns {string}
 */
function ensurePeriod(s) {
  return /[.!?]$/.test(s) ? s : `${s}.`;
}
