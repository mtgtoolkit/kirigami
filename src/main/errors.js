'use strict';

/**
 * errors.js — pure helpers that turn raw process failures (Python tracebacks, click usage errors,
 * Windows crash exit codes, Node spawn/file-system errors) into plain-language messages for people
 * with no developer knowledge.
 *
 * Rules: the user-facing `message` never contains tracebacks or raw command-line flags (except in
 * the generic fallback, which quotes the one-line Python message); everything raw goes to `details`.
 * No Electron, no I/O — unit-tested against real tracebacks in test/fixtures/tracebacks/.
 */

const TRACEBACK_HEADER_RE = /^Traceback \(most recent call last\):\s*$/;
/** Spec §5.3 exception line. */
const EXCEPTION_LINE_RE = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt))(?::\s*(.*))?$/;
/** Any dotted identifier, optionally followed by ": message" (e.g. requests.exceptions.ConnectTimeout). */
const LOOSE_EXCEPTION_LINE_RE = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?::(?:\s+(.*))?)?$/;
const CLICK_ERROR_RE = /^Error: (.+)$/;
const CLICK_USAGE_RE = /^Usage: /;

/** Windows NTSTATUS crash codes reported as process exit codes (unsigned). */
const CRASH_EXIT_CODES = new Set([
  3221225477, // 0xC0000005 access violation
  3221226505, // 0xC0000409 stack buffer overrun / fail-fast
  3221225725, // 0xC00000FD stack overflow
]);

/** Exact user-facing messages (spec §5.3) — exported for tests and other modules. */
const MESSAGES = Object.freeze({
  OUT_OF_MEMORY: 'Your computer ran out of memory. Lower the print resolution (PPI) or make the PDF in smaller parts.',
  OUTPUT_LOCKED: 'Windows blocked writing the file (it may be open in another program, synced by OneDrive, or protected by Controlled folder access). Close it or choose another output folder.',
  MISSING_PACKAGES: 'Some card maker components are missing. Open Settings → Repair components.',
  NOT_FOUND: "The card website couldn't find something in your list (check spelling or set codes).",
  RATE_LIMITED: 'The card website is busy. Wait a minute and try again.',
  BAD_ENCODING: "The deck list file isn't plain text.",
  DS_WITHOUT_FRONT: 'Some unique backs have no matching front image.',
  DOES_NOT_FIT: "These cards don't fit on this paper. Choose a bigger paper.",
  DISK_FULL: 'Your disk is full. Free up some space (or choose another output folder) and try again.',
  FRONTS_ONLY_WITH_BACKS: '"Fronts only" can\'t be used while you have unique backs (double-faced cards). Choose "Fronts and backs", or print the back faces as separate cards.',
  UPSCAYL_CRASHED: 'Upscayl stopped unexpectedly (often a graphics driver problem or not enough graphics memory). Try another model or a smaller tile size, or turn upscaling off.',
  BAD_OFFSET: 'Your saved printer alignment is invalid. Open Printer alignment and choose "Reset to 0, 0, 0".',
  CANCELLED: 'Cancelled.',
});

const NETWORK_TYPES = new Set([
  'ConnectionError', 'ConnectTimeout', 'ReadTimeout', 'Timeout', 'SSLError', 'ProxyError', 'MaxRetryError',
  'NewConnectionError', 'NameResolutionError', 'ConnectTimeoutError', 'ReadTimeoutError', 'ProtocolError',
  'ChunkedEncodingError', 'RemoteDisconnected', 'ConnectionResetError', 'ConnectionRefusedError',
  'ConnectionAbortedError', 'gaierror', 'IncompleteRead', 'RetryError',
]);
const NETWORK_TEXT_RE = new RegExp([
  'getaddrinfo failed', 'Failed to resolve', 'Name or service not known', 'nodename nor servname',
  'Temporary failure in name resolution', 'Max retries exceeded', 'CERTIFICATE_VERIFY_FAILED',
  'certificate verify failed', '\\bSSLError\\b', '\\bConnectTimeout\\b', '\\bReadTimeout\\b',
  'Connection (?:refused|reset|aborted)', 'actively refused', 'Remote end closed connection',
  'dns error', 'failed to lookup address', 'error sending request for url', 'tcp connect error',
  'operation timed out', 'connection timed out', 'invalid peer certificate', 'UnknownIssuer',
  'WinError 1006[01]', 'WinError 10054', '\\bECONNREFUSED\\b', '\\bECONNRESET\\b', '\\bENOTFOUND\\b',
  '\\bETIMEDOUT\\b', '\\bEAI_AGAIN\\b',
].join('|'), 'i');
const MEMORY_TEXT_RE = /\bMemoryError\b|Unable to allocate \d|Cannot allocate memory|\[Errno 12\]|\bstd::bad_alloc\b/;
const PERMISSION_TEXT_RE = /\[Errno 13\]|\[WinError 5\]|\[WinError 32\]|Permission denied|being used by another process/i;
const BAD_IMAGE_TEXT_RE = /\bUnidentifiedImageError\b|\bDecompressionBombError\b|cannot identify image file|image file is truncated|Truncated File Read|broken data stream/;
const FAILED_TO_LOAD_RE = /Failed to load (?:front|back|double-sided) image "([^"]*)"/;
const CANNOT_IDENTIFY_RE = /cannot identify image file '((?:[^'\\]|\\.)*)'/;
const IMAGE_LINE_RE = /^Image \d+: (.+)$/;
const DISK_FULL_TEXT_RE = /\[Errno 28\]|No space left on device|not enough space on the disk|\[WinError 112\]/i;

const MAX_SHORT_MESSAGE = 200;
const MAX_DETAILS = 20000;

/**
 * Normalize stderr input (string, array of strings/lines, null) into an array of lines without
 * line terminators.
 * @param {string|string[]|null|undefined} input
 * @returns {string[]}
 */
function toLines(input) {
  if (input == null) return [];
  const parts = Array.isArray(input) ? input : [input];
  const out = [];
  for (const part of parts) {
    if (part == null) continue;
    for (const line of String(part).split(/\r\n|\n|\r/)) out.push(line);
  }
  // A trailing newline in a single string produces one empty last element: drop it.
  if (out.length && out[out.length - 1] === '' && !Array.isArray(input)) out.pop();
  return out;
}

function lastSegment(type) {
  if (!type) return null;
  const parts = String(type).split('.');
  return parts[parts.length - 1] || null;
}

function truncate(text, max = MAX_SHORT_MESSAGE) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Parse the exception of the LAST traceback block that starts at `headerIndex`. */
function parseTracebackBlock(lines, headerIndex) {
  let end = lines.length;
  while (end > headerIndex + 1 && !lines[end - 1].trim()) end -= 1;
  const body = lines.slice(headerIndex + 1, end);

  let excIndex = -1;
  let type = null;
  let message = '';
  // The exception line is the first non-indented line after the stack frames.
  for (let i = 0; i < body.length; i += 1) {
    const line = body[i];
    if (!line.trim() || /^\s/.test(line)) continue;
    const text = line.trimEnd();
    const m = EXCEPTION_LINE_RE.exec(text) || LOOSE_EXCEPTION_LINE_RE.exec(text);
    if (m) {
      excIndex = i;
      type = m[1];
      message = (m[2] || '').trim();
    }
    break;
  }
  // Spec fallback: the last line of the block matching the exception pattern.
  if (excIndex < 0) {
    for (let i = body.length - 1; i >= 0; i -= 1) {
      const m = EXCEPTION_LINE_RE.exec(body[i].trimEnd());
      if (m) {
        excIndex = i;
        type = m[1];
        message = (m[2] || '').trim();
        break;
      }
    }
  }
  if (excIndex < 0) return null;
  const notes = body.slice(excIndex + 1).map((l) => l.trimEnd()).filter((l) => l.trim());
  const result = {
    type,
    message: message || (notes.length && !/^\s/.test(notes[0]) ? notes[0].trim() : ''),
    raw: lines.slice(headerIndex, end).join('\n'),
  };
  if (notes.length) result.notes = notes;
  return result;
}

/**
 * Extract the Python exception from stderr output.
 *
 * Order: the exception line of the FINAL `Traceback (most recent call last):` block (first
 * non-indented line after the frames — handles chained exceptions, multi-line messages such as
 * pydantic's, and exception names without an Error suffix such as ConnectTimeout; falls back to the
 * last line of the block matching the spec pattern); else a click usage `Error: …` line (exit 2);
 * else the last non-empty stderr line.
 *
 * @param {string|string[]} stderrLines stderr as lines (or one string)
 * @returns {{ type: string|null, message: string, raw: string, notes?: string[] }|null}
 *   `type` is the dotted exception name ('UsageError' for click errors, null for the last-line
 *   fallback); `raw` is the traceback block / usage block / line; null when there is no output.
 */
function parsePythonError(stderrLines) {
  const lines = toLines(stderrLines);
  if (!lines.length) return null;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (TRACEBACK_HEADER_RE.test(lines[i])) {
      const parsed = parseTracebackBlock(lines, i);
      if (parsed) return parsed;
      break;
    }
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = CLICK_ERROR_RE.exec(lines[i].trimEnd());
    if (m) {
      let start = i;
      for (let j = i - 1; j >= 0 && j >= i - 6; j -= 1) {
        if (CLICK_USAGE_RE.test(lines[j])) { start = j; break; }
      }
      return { type: 'UsageError', message: m[1].trim(), raw: lines.slice(start, i + 1).join('\n') };
    }
  }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const t = lines[i].trim();
    if (t) return { type: null, message: t, raw: lines[i] };
  }
  return null;
}

/**
 * Create an Error whose message is already written for end users; friendlyError() passes it
 * through unchanged (code and details preserved).
 * @param {string} message plain-language message
 * @param {{ code?: string, details?: string, cause?: unknown }} [opts]
 * @returns {Error & { friendly: true, code: string, details: string }}
 */
function userError(message, { code = 'ERROR', details = '', cause } = {}) {
  const err = new Error(String(message));
  err.friendly = true;
  err.code = code;
  err.details = details ? String(details) : '';
  if (cause !== undefined) err.cause = cause;
  return err;
}

function basenameAny(p) {
  const s = String(p).replace(/\\\\/g, '\\');
  const parts = s.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : s;
}

function programLabel(cmdOrName) {
  if (!cmdOrName) return 'the program';
  const base = basenameAny(String(cmdOrName)).replace(/\.(exe|cmd|bat|com)$/i, '');
  const lower = base.toLowerCase();
  if (/^python(w)?(\d+(\.\d+)?)?$/.test(lower) || lower === 'py') return 'Python';
  if (lower.startsWith('upscayl')) return 'Upscayl';
  if (lower === 'uv') return 'the component installer (uv)';
  if (lower === 'powershell' || lower === 'pwsh') return 'PowerShell';
  return base || 'the program';
}

function isErrnoCode(code) {
  return typeof code === 'string' && /^E[A-Z0-9_]+$/.test(code);
}

function collectFacts(err, context) {
  const f = {
    raw: err,
    message: '',
    name: null,
    exitCode: null,
    signal: null,
    nodeCode: null,
    syscall: null,
    path: null,
    appCode: null,
    friendlyMessage: null,
    friendlyDetails: '',
    stderrLines: [],
    stdoutLines: [],
    traceback: null,
    pythonError: null,
    command: null,
    program: null,
    stack: null,
    isProcessError: false,
    isPlainError: false,
    cancelled: false,
  };
  if (err == null) {
    f.message = 'unknown error';
    return f;
  }
  if (typeof err !== 'object') {
    f.message = String(err);
    return f;
  }

  f.message = typeof err.message === 'string' ? err.message : '';
  f.name = typeof err.name === 'string' ? err.name : null;
  f.stack = typeof err.stack === 'string' ? err.stack : null;
  if (typeof err.exitCode === 'number') f.exitCode = err.exitCode;
  else if (typeof err.code === 'number') f.exitCode = err.code;
  if (typeof err.signal === 'string' && err.signal) f.signal = err.signal;
  if (isErrnoCode(err.code) && (err.syscall || typeof err.errno === 'number')) f.nodeCode = err.code;
  if (typeof err.syscall === 'string') f.syscall = err.syscall;
  if (typeof err.path === 'string') f.path = err.path;
  if (typeof err.code === 'string' && /^[A-Z][A-Z0-9_]*$/.test(err.code) && !f.nodeCode) f.appCode = err.code;
  f.cancelled = f.name === 'CancelledError' || f.name === 'AbortError' || err.code === 'CANCELLED';
  if (err.friendly === true || typeof err.userMessage === 'string') {
    f.friendlyMessage = typeof err.userMessage === 'string' ? err.userMessage : f.message;
    f.friendlyDetails = typeof err.details === 'string' ? err.details : '';
  }
  f.stderrLines = toLines(err.stderrTail != null ? err.stderrTail : err.stderr);
  f.stdoutLines = toLines(err.stdoutTail != null ? err.stdoutTail : err.stdout);
  if (typeof err.traceback === 'string' && err.traceback.trim()) f.traceback = err.traceback;
  if (typeof err.command === 'string') f.command = err.command;
  f.program = (typeof err.program === 'string' && err.program) || (context && context.program) || null;
  f.isProcessError = f.name === 'JobProcessError' || (f.exitCode !== null && (f.stderrLines.length > 0 || !!f.command));

  if (err.pythonError && typeof err.pythonError === 'object') f.pythonError = err.pythonError;
  else if (f.traceback) f.pythonError = parsePythonError(f.traceback);
  else if (f.stderrLines.length) f.pythonError = parsePythonError(f.stderrLines);
  if (!f.pythonError && f.message && EXCEPTION_LINE_RE.test(f.message.split(/\r?\n/)[0])) {
    // e.g. helper.js rejecting with the helper's "{error}" string "PermissionError: [Errno 13] …"
    f.pythonError = parsePythonError([f.message]);
  }
  f.isPlainError = err instanceof Error && Object.getPrototypeOf(err) === Error.prototype
    && !f.nodeCode && !f.isProcessError && !f.pythonError;

  f.pyType = f.pythonError ? f.pythonError.type : null;
  f.pyTypeBase = lastSegment(f.pyType);
  f.text = [
    f.pyType, f.pythonError && f.pythonError.message, f.pythonError && f.pythonError.raw,
    f.traceback, ...f.stderrLines, f.message,
  ].filter(Boolean).join('\n');
  f.lastImage = null;
  for (let i = f.stdoutLines.length - 1; i >= 0; i -= 1) {
    const m = IMAGE_LINE_RE.exec(f.stdoutLines[i].trim());
    if (m) { f.lastImage = m[1].trim(); break; }
  }
  return f;
}

function isUpscaylFailure(f, kind) {
  const hay = `${f.program || ''} ${f.command || ''}`.toLowerCase();
  if (hay.includes('upscayl')) return true;
  return (kind === 'upscale' || kind === 'preview' || kind === 'probe') && !/python/.test(hay);
}

function extractHost(f, context) {
  if (context && typeof context.host === 'string' && context.host) return context.host;
  const m = /host='([^']+)'/.exec(f.text) || /Failed to resolve '([^']+)'/.exec(f.text)
    || /\bhttps?:\/\/([^/\s'"`:)\]]+)/i.exec(f.text);
  return m ? m[1] : null;
}

/** Rules in priority order; each returns { code, message } or null. */
const RULES = [
  function spawnFailure(f) {
    if (!f.nodeCode || !f.syscall || !f.syscall.startsWith('spawn')) return null;
    const name = programLabel(f.program || f.path || f.syscall.replace(/^spawn\s*/, ''));
    if (f.nodeCode === 'EPERM' || f.nodeCode === 'EACCES') {
      return { code: 'START_BLOCKED', message: `Windows or your antivirus blocked ${name}.` };
    }
    return { code: 'START_FAILED', message: `Could not start ${name}.` };
  },
  function outOfMemory(f, kind) {
    const typeHit = !!f.pyTypeBase && /MemoryError$/.test(f.pyTypeBase);
    const textHit = MEMORY_TEXT_RE.test(f.text);
    const crash = f.exitCode !== null && CRASH_EXIT_CODES.has(f.exitCode >>> 0);
    const killed = f.signal === 'SIGKILL';
    if (!typeHit && !textHit && !crash && !killed) return null;
    if (!typeHit && !textHit && isUpscaylFailure(f, kind)) {
      return { code: 'UPSCAYL_CRASHED', message: MESSAGES.UPSCAYL_CRASHED };
    }
    return { code: 'OUT_OF_MEMORY', message: MESSAGES.OUT_OF_MEMORY };
  },
  function missingPackages(f) {
    if ((f.pyTypeBase === 'ModuleNotFoundError' || f.pyTypeBase === 'ImportError')
      || /\bNo module named\b|DLL load failed while importing/.test(f.text)) {
      return { code: 'MISSING_PACKAGES', message: MESSAGES.MISSING_PACKAGES };
    }
    return null;
  },
  function dsWithoutFront(f) {
    return /do not have matching fronts/.test(f.text) ? { code: 'DS_WITHOUT_FRONT', message: MESSAGES.DS_WITHOUT_FRONT } : null;
  },
  function frontsOnlyWithBacks(f) {
    return /Cannot use "--only_fronts" with double-sided cards/.test(f.text)
      ? { code: 'FRONTS_ONLY_WITH_BACKS', message: MESSAGES.FRONTS_ONLY_WITH_BACKS } : null;
  },
  function badOffset(f) {
    return /validation error for OffsetData/.test(f.text) ? { code: 'BAD_OFFSET', message: MESSAGES.BAD_OFFSET } : null;
  },
  function doesNotFit(f) {
    // "does not fit on paper size" (utilities.generate_pdf) is the documented text; the current
    // engine raises page_manager's "No valid layout fits …" ValueError first for oversized cards.
    return /does not fit on paper size|No valid layout fits/.test(f.text)
      ? { code: 'DOES_NOT_FIT', message: MESSAGES.DOES_NOT_FIT } : null;
  },
  function badImage(f, kind, context) {
    const failed = FAILED_TO_LOAD_RE.exec(f.text);
    const typeHit = f.pyTypeBase === 'UnidentifiedImageError' || f.pyTypeBase === 'DecompressionBombError';
    if (!failed && !typeHit && !BAD_IMAGE_TEXT_RE.test(f.text)) return null;
    let file = failed ? failed[1] : null;
    if (!file) {
      const m = CANNOT_IDENTIFY_RE.exec(f.text);
      if (m && !m[1].startsWith('<')) file = m[1];
    }
    if (!file && context && typeof context.file === 'string') file = context.file;
    if (!file) file = f.lastImage;
    const name = file ? basenameAny(file) : null;
    if (failed && PERMISSION_TEXT_RE.test(f.text)) {
      return {
        code: 'FILE_LOCKED',
        message: `Windows blocked reading ${name || 'one of your images'} (it may be open in another program or blocked by your antivirus). Close it and try again.`,
      };
    }
    return {
      code: 'BAD_IMAGE',
      message: name ? `${name} is damaged, not an image, or too large.` : 'One of your images is damaged, not an image, or too large.',
    };
  },
  function outputLocked(f) {
    const nodeLock = (f.nodeCode === 'EPERM' || f.nodeCode === 'EACCES' || f.nodeCode === 'EBUSY')
      && !(f.syscall && f.syscall.startsWith('spawn'));
    if (f.pyTypeBase === 'PermissionError' || nodeLock || PERMISSION_TEXT_RE.test(f.text)) {
      return { code: 'OUTPUT_LOCKED', message: MESSAGES.OUTPUT_LOCKED };
    }
    return null;
  },
  function diskFull(f) {
    return f.nodeCode === 'ENOSPC' || DISK_FULL_TEXT_RE.test(f.text) ? { code: 'DISK_FULL', message: MESSAGES.DISK_FULL } : null;
  },
  function rateLimited(f) {
    return /\b429\b[^\n]*(?:Too Many Requests|Client Error)|Too Many Requests|too many 429 error responses|\brate[ -]?limit/i.test(f.text)
      ? { code: 'RATE_LIMITED', message: MESSAGES.RATE_LIMITED } : null;
  },
  function notFound(f) {
    const httpType = f.pyTypeBase === 'HTTPError';
    if ((httpType && /\b404\b/.test(f.pythonError.message || ''))
      || /\b404 Client Error\b|HTTPError:?\s*404\b|status(?: code)?[ :=]+404\b/i.test(f.text)) {
      return { code: 'NOT_FOUND', message: MESSAGES.NOT_FOUND };
    }
    return null;
  },
  function network(f, kind, context) {
    if (!(f.pyTypeBase && NETWORK_TYPES.has(f.pyTypeBase)) && !NETWORK_TEXT_RE.test(f.text)) return null;
    const fallbackHost = kind === 'fetch' ? 'the card website' : kind === 'setup' ? 'the download server' : 'the website';
    const host = extractHost(f, context) || fallbackHost;
    return {
      code: 'NETWORK',
      message: `Couldn't reach ${host}. Check your internet connection (antivirus HTTPS scanning can also block it).`,
    };
  },
  function badEncoding(f, kind) {
    if (kind && kind !== 'fetch') return null;
    return f.pyTypeBase === 'UnicodeDecodeError' || /UnicodeDecodeError|codec can't decode byte/.test(f.text)
      ? { code: 'BAD_ENCODING', message: MESSAGES.BAD_ENCODING } : null;
  },
];

/**
 * "--card_size" -> "card size" so fallback messages never show raw command-line flags.
 * @param {string} text
 * @returns {string}
 */
function humanizeFlags(text) {
  return String(text).replace(/(^|[\s'"(\[,])--([A-Za-z][\w-]*)/g, (_m, pre, name) => `${pre}${name.replace(/[_-]+/g, ' ')}`);
}

function shortPythonMessage(pe) {
  const base = lastSegment(pe.type);
  const msg = humanizeFlags((pe.message || '').trim());
  if (!base) return truncate(msg);
  if (!msg) return base;
  if (base === 'Exception' || base === 'UsageError') return truncate(msg);
  return truncate(`${base}: ${msg}`);
}

function buildDetails(f) {
  const parts = [];
  if (f.friendlyDetails) parts.push(f.friendlyDetails);
  if (f.stderrLines.length) {
    parts.push(f.stderrLines.slice(-60).join('\n'));
  } else if (f.traceback) {
    parts.push(f.traceback.trim());
  } else if (f.pythonError && f.pythonError.raw && f.pythonError.type !== null) {
    parts.push(f.pythonError.raw);
  }
  if (f.stdoutLines.length) parts.push(`Output:\n${f.stdoutLines.slice(-15).join('\n')}`);
  if (f.command) parts.push(`Command: ${f.command}`);
  if (f.exitCode !== null) {
    const unsigned = f.exitCode >>> 0;
    const hex = unsigned > 0xFFFF ? ` (0x${unsigned.toString(16).toUpperCase()})` : '';
    parts.push(`Exit code: ${f.exitCode}${hex}`);
  }
  if (f.signal) parts.push(`Signal: ${f.signal}`);
  if (f.nodeCode) parts.push(`Error code: ${f.nodeCode}${f.syscall ? ` (${f.syscall})` : ''}${f.path ? `: ${f.path}` : ''}`);
  const jsError = f.raw instanceof Error && !f.isProcessError;
  if (jsError && !f.friendlyMessage) {
    parts.push(f.stack || f.message);
  } else if (!parts.length && f.message) {
    parts.push(f.message);
  }
  const text = parts.filter(Boolean).join('\n\n');
  return text.length > MAX_DETAILS ? `${text.slice(0, MAX_DETAILS)}\n… (truncated)` : text;
}

/**
 * Map any failure to `{ message, details, code }` for the UI (spec §5.3 table).
 *
 * Accepted `err` shapes (all optional): an Error, a JobProcessError
 * `{ code:exitCode, signal, stderrTail[], stdoutTail[], pythonError, command }`, a helper failure
 * `{ message, traceback }`, a Node errno error `{ code:'ENOENT', syscall, path }`, an error created
 * with userError() (`friendly: true`, passed through), a CancelledError/AbortError, a string, or null.
 *
 * Codes: OUT_OF_MEMORY, OUTPUT_LOCKED, MISSING_PACKAGES, NETWORK, NOT_FOUND, RATE_LIMITED,
 * BAD_ENCODING, DS_WITHOUT_FRONT, BAD_IMAGE, DOES_NOT_FIT, UNKNOWN (spec) plus START_FAILED,
 * START_BLOCKED, DISK_FULL, FILE_LOCKED, FRONTS_ONLY_WITH_BACKS, UPSCAYL_CRASHED, CANCELLED, and any
 * code carried by a userError (e.g. TIMEOUT, BUSY).
 *
 * @param {{ err: unknown, kind?: string|null, context?: { host?: string, file?: string, program?: string } }} input
 *   kind = job kind ('fetch', 'pdf', …) used to word some messages; context.host names the website
 *   for network errors; context.file names the image for BAD_IMAGE when the output doesn't.
 * @returns {{ message: string, details: string, code: string }}
 */
function friendlyError({ err, kind = null, context = {} } = {}) {
  const f = collectFacts(err, context || {});
  if (f.cancelled) return { message: MESSAGES.CANCELLED, details: '', code: 'CANCELLED' };
  if (f.friendlyMessage) {
    return { message: f.friendlyMessage, details: buildDetails(f), code: f.appCode || 'ERROR' };
  }
  for (const rule of RULES) {
    const hit = rule(f, kind, context || {});
    if (hit) return { message: hit.message, details: buildDetails(f), code: hit.code };
  }
  let message;
  if (f.pythonError) {
    message = `Something went wrong: ${shortPythonMessage(f.pythonError)}`;
  } else if (f.isProcessError) {
    const who = programLabel(f.program || (f.command ? f.command.split(' ')[0].replace(/^"|"$/g, '') : null));
    message = f.signal
      ? `Something went wrong: ${who} was stopped (${f.signal}).`
      : `Something went wrong: ${who} stopped with exit code ${f.exitCode}.`;
  } else if (f.isPlainError && f.message) {
    // Errors thrown by app code are written for users already.
    return { message: f.message, details: buildDetails(f), code: f.appCode || 'UNKNOWN' };
  } else {
    message = `Something went wrong: ${truncate(humanizeFlags(f.message || 'unknown error'))}`;
  }
  return { message, details: buildDetails(f), code: 'UNKNOWN' };
}

module.exports = {
  parsePythonError,
  friendlyError,
  userError,
  programLabel,
  humanizeFlags,
  MESSAGES,
  CRASH_EXIT_CODES,
};
