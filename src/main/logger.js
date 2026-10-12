'use strict';

/**
 * Main application log: `<logsDir>/app.log`, rotated at 5 MB, keeping app.1.log … app.3.log.
 * Writes are synchronous appends (low volume; nothing is lost if the process dies). Logging never
 * throws. Job output has its own per-job files (jobs.js).
 */

const fs = require('node:fs');
const path = require('node:path');
const { inspect } = require('node:util');

const MAX_ARG_CHARS = 20000;

function formatArg(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) {
    const extra = {};
    for (const key of ['code', 'errno', 'syscall', 'path', 'details', 'stderrTail', 'command']) {
      if (arg[key] !== undefined) extra[key] = arg[key];
    }
    let text = arg.stack || `${arg.name}: ${arg.message}`;
    if (Object.keys(extra).length) text += ` ${safeInspect(extra)}`;
    if (arg.cause) text += `\n  caused by: ${formatArg(arg.cause)}`;
    return text;
  }
  if (arg === undefined) return 'undefined';
  if (arg === null || typeof arg !== 'object') return String(arg);
  return safeInspect(arg);
}

function safeInspect(value) {
  try {
    return inspect(value, { depth: 6, breakLength: Infinity, maxArrayLength: 50, maxStringLength: 4000 });
  } catch {
    return '[unprintable]';
  }
}

/**
 * Create the app logger.
 * @param {string} logsDir
 * @param {{ maxBytes?: number, maxFiles?: number, mirrorToConsole?: boolean, fileName?: string }} [opts]
 *   maxFiles = number of rotated backups kept (default 3).
 * @returns {{ info(...args: any[]): void, warn(...args: any[]): void, error(...args: any[]): void,
 *             debug(...args: any[]): void, file: string }}
 */
function createLogger(logsDir, opts = {}) {
  const maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0 ? opts.maxBytes : 5 * 1024 * 1024;
  const maxFiles = Number.isInteger(opts.maxFiles) && opts.maxFiles >= 1 ? opts.maxFiles : 3;
  const mirror = !!opts.mirrorToConsole;
  const fileName = opts.fileName || 'app.log';
  const file = path.join(logsDir, fileName);
  const ext = path.extname(fileName);
  const stem = fileName.slice(0, fileName.length - ext.length);
  const backup = (i) => path.join(logsDir, `${stem}.${i}${ext}`);

  let size = 0;
  let disabled = false;
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    size = fs.statSync(file).size;
  } catch {
    size = 0;
  }

  function rotate() {
    try { fs.rmSync(backup(maxFiles), { force: true }); } catch { /* ignore */ }
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      try { fs.renameSync(backup(i), backup(i + 1)); } catch { /* missing */ }
    }
    try { fs.renameSync(file, backup(1)); } catch { /* missing / locked: keep appending */ }
    size = 0;
    try { size = fs.statSync(file).size; } catch { /* new file */ }
  }

  function write(level, args) {
    let message;
    try {
      message = args.map((a) => {
        const s = formatArg(a);
        return s.length > MAX_ARG_CHARS ? `${s.slice(0, MAX_ARG_CHARS)}… [truncated]` : s;
      }).join(' ');
    } catch {
      message = '[unformattable log message]';
    }
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    if (!disabled) {
      try {
        const bytes = Buffer.byteLength(line);
        if (size > 0 && size + bytes > maxBytes) rotate();
        fs.appendFileSync(file, line, 'utf8');
        size += bytes;
      } catch (err) {
        if (err && (err.code === 'ENOENT')) {
          try { fs.mkdirSync(logsDir, { recursive: true }); fs.appendFileSync(file, line, 'utf8'); } catch { disabled = true; }
        }
      }
    }
    if (mirror) {
      try {
        const out = line.trimEnd();
        // eslint-disable-next-line no-console
        if (level === 'ERROR') console.error(out); else if (level === 'WARN') console.warn(out); else console.log(out);
      } catch { /* closed stdio */ }
    }
  }

  return {
    file,
    info: (...args) => write('INFO', args),
    warn: (...args) => write('WARN', args),
    error: (...args) => write('ERROR', args),
    debug: (...args) => write('DEBUG', args),
  };
}

module.exports = { createLogger };
