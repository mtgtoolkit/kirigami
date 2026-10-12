'use strict';

// Tests for src/main/errors.js against REAL Python outputs captured by
// test/fixtures/tracebacks/generate.py (see index.json there).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parsePythonError, friendlyError, userError, humanizeFlags, programLabel, MESSAGES,
} = require('../../src/main/errors');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'tracebacks');
const INDEX = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'index.json'), 'utf8'));

function fixture(name) {
  const stderr = fs.readFileSync(path.join(FIXTURES, `${name}.txt`), 'utf8');
  const stdoutFile = path.join(FIXTURES, `${name}.stdout.txt`);
  const stdout = fs.existsSync(stdoutFile) ? fs.readFileSync(stdoutFile, 'utf8') : '';
  return {
    stderrLines: stderr.split(/\r?\n/),
    stdoutLines: stdout.split(/\r?\n/).filter(Boolean),
    exitCode: INDEX[name].exitCode,
  };
}

/** What jobs.js builds for a failed Python child (JobProcessError shape). */
function processError(name, overrides = {}) {
  const f = fixture(name);
  return {
    name: 'JobProcessError',
    message: `Python exited with code ${f.exitCode}`,
    code: f.exitCode,
    exitCode: f.exitCode,
    signal: null,
    stderrTail: f.stderrLines.slice(-30),
    stdoutTail: f.stdoutLines.slice(-30),
    pythonError: parsePythonError(f.stderrLines),
    command: '"C:\\scm\\venv\\Scripts\\python.exe" create_pdf.py --ppi=300',
    program: 'Python',
    ...overrides,
  };
}

// name -> [expected exception type, message prefix, friendly code, kind]
const EXPECTED = {
  network_dns: ['requests.exceptions.ConnectionError', "HTTPConnectionPool(host='scm-fixture.invalid'", 'NETWORK', 'fetch'],
  network_timeout: ['requests.exceptions.ConnectTimeout', "HTTPConnectionPool(host='10.255.255.1'", 'NETWORK', 'fetch'],
  network_refused: ['requests.exceptions.ConnectionError', "HTTPConnectionPool(host='127.0.0.1', port=9)", 'NETWORK', 'fetch'],
  http_404: ['requests.exceptions.HTTPError', '404 Client Error: Not Found for url', 'NOT_FOUND', 'fetch'],
  http_429: ['requests.exceptions.HTTPError', '429 Client Error: Too Many Requests', 'RATE_LIMITED', 'fetch'],
  ssl_error: ['requests.exceptions.SSLError', "HTTPSConnectionPool(host='127.0.0.1'", 'NETWORK', 'fetch'],
  pil_unidentified: ['PIL.UnidentifiedImageError', "cannot identify image file 'not_an_image.png'", 'BAD_IMAGE', 'pdf'],
  pil_truncated: ['OSError', 'Truncated File Read', 'BAD_IMAGE', 'pdf'],
  memory_error: ['MemoryError', '', 'OUT_OF_MEMORY', 'pdf'],
  numpy_memory_error: ['numpy._core._exceptions._ArrayMemoryError', 'Unable to allocate', 'OUT_OF_MEMORY', 'pdf'],
  module_not_found: ['ModuleNotFoundError', "No module named 'scm_missing_module_xyz'", 'MISSING_PACKAGES', 'pdf'],
  import_error: ['ImportError', "cannot import name 'NotAThing' from 'PIL'", 'MISSING_PACKAGES', 'pdf'],
  unicode_decode: ['UnicodeDecodeError', "'utf-8' codec can't decode byte 0xff", 'BAD_ENCODING', 'fetch'],
  permission_open: ['PermissionError', '[Errno 13] Permission denied', 'OUTPUT_LOCKED', 'pdf'],
  file_not_found: ['FileNotFoundError', '[Errno 2] No such file or directory', 'UNKNOWN', 'pdf'],
  click_usage: ['UsageError', "Invalid value for '--card_size'", 'UNKNOWN', 'pdf'],
  pdf_bad_image: ['OSError', 'Failed to load front image "game\\front\\broken.png"', 'BAD_IMAGE', 'pdf'],
  pdf_decompression_bomb: ['PIL.Image.DecompressionBombError', 'Image size (400000000 pixels) exceeds limit', 'BAD_IMAGE', 'pdf'],
  pdf_permission_denied: ['PermissionError', "[Errno 13] Permission denied: 'out/deck.pdf'", 'OUTPUT_LOCKED', 'pdf'],
  pdf_ds_without_front: ['Exception', 'Double-sided backs "{\'beta.png\'}" do not have matching fronts', 'DS_WITHOUT_FRONT', 'pdf'],
  pdf_does_not_fit: ['ValueError', 'No valid layout fits without intruding', 'DOES_NOT_FIT', 'pdf'],
  pdf_offset_validation: ['pydantic_core._pydantic_core.ValidationError', '1 validation error for OffsetData', 'BAD_OFFSET', 'pdf'],
};

test('every fixture listed in index.json has an expectation (and vice versa)', () => {
  assert.deepEqual(Object.keys(EXPECTED).sort(), Object.keys(INDEX).sort());
});

test('fixtures are real failures with the expected exit codes', () => {
  for (const [name, meta] of Object.entries(INDEX)) {
    assert.equal(meta.exitCode, name === 'click_usage' ? 2 : 1, name);
  }
});

for (const [name, [type, messagePrefix, code, kind]] of Object.entries(EXPECTED)) {
  test(`parsePythonError + friendlyError: ${name}`, () => {
    const { stderrLines } = fixture(name);
    const pe = parsePythonError(stderrLines);
    assert.ok(pe, 'parsed');
    assert.equal(pe.type, type);
    assert.ok(pe.message.startsWith(messagePrefix), `message "${pe.message}" should start with "${messagePrefix}"`);
    assert.ok(pe.raw.length > 0);

    const fe = friendlyError({ err: processError(name), kind });
    assert.equal(fe.code, code, `${name}: ${fe.message}`);
    // Never a traceback or a raw command-line flag in the message.
    assert.doesNotMatch(fe.message, /Traceback|File "|\n/);
    assert.doesNotMatch(fe.message, /(^|\s|')--[a-z]/);
    // The raw exception text goes to details.
    const lastException = stderrLines.filter((l) => l.startsWith(type.split('.').pop()) || l.startsWith(type) || l.startsWith('Error: ')).pop();
    if (lastException) assert.ok(fe.details.includes(lastException.slice(0, 40)), `${name}: details keep the raw exception`);
  });
}

test('chained tracebacks: the FINAL exception wins (not socket.gaierror / urllib3 errors)', () => {
  const pe = parsePythonError(fixture('network_dns').stderrLines);
  assert.equal(pe.type, 'requests.exceptions.ConnectionError');
  assert.ok(pe.raw.startsWith('Traceback (most recent call last):'));
  assert.ok(!pe.raw.includes('socket.gaierror'), 'raw is the final block only');
});

test('pydantic multi-line message: exception line found even though the last stderr line is indented', () => {
  const { stderrLines } = fixture('pdf_offset_validation');
  const pe = parsePythonError(stderrLines);
  assert.equal(pe.message, '1 validation error for OffsetData');
  assert.ok(Array.isArray(pe.notes));
  assert.equal(pe.notes[0], 'x_offset');
  assert.match(pe.notes[1], /Input should be a valid integer/);
});

test('exact user messages for the spec table', () => {
  assert.equal(friendlyError({ err: processError('memory_error'), kind: 'pdf' }).message, MESSAGES.OUT_OF_MEMORY);
  assert.equal(MESSAGES.OUT_OF_MEMORY, 'Your computer ran out of memory. Lower the print resolution (PPI) or make the PDF in smaller parts.');
  assert.equal(friendlyError({ err: processError('pdf_permission_denied'), kind: 'pdf' }).message, MESSAGES.OUTPUT_LOCKED);
  assert.equal(friendlyError({ err: processError('module_not_found') }).message, 'Some card maker components are missing. Open Settings → Repair components.');
  assert.equal(friendlyError({ err: processError('http_404'), kind: 'fetch' }).message, "The card website couldn't find something in your list (check spelling or set codes).");
  assert.equal(friendlyError({ err: processError('http_429'), kind: 'fetch' }).message, 'The card website is busy. Wait a minute and try again.');
  assert.equal(friendlyError({ err: processError('unicode_decode'), kind: 'fetch' }).message, "The deck list file isn't plain text.");
  assert.equal(friendlyError({ err: processError('pdf_ds_without_front'), kind: 'pdf' }).message, 'Some unique backs have no matching front image.');
  assert.equal(friendlyError({ err: processError('pdf_does_not_fit'), kind: 'pdf' }).message, "These cards don't fit on this paper. Choose a bigger paper.");
  assert.equal(
    friendlyError({ err: processError('network_dns'), kind: 'fetch' }).message,
    "Couldn't reach scm-fixture.invalid. Check your internet connection (antivirus HTTPS scanning can also block it).",
  );
});

test('BAD_IMAGE names the file (from the message, Pillow text, context, or the last "Image N:" line)', () => {
  assert.equal(friendlyError({ err: processError('pdf_bad_image'), kind: 'pdf' }).message,
    'broken.png is damaged, not an image, or too large.');
  assert.equal(friendlyError({ err: processError('pil_unidentified'), kind: 'pdf' }).message,
    'not_an_image.png is damaged, not an image, or too large.');
  // DecompressionBombError has no file name: taken from the stdout "Image 2: b_bomb.png" line.
  assert.equal(friendlyError({ err: processError('pdf_decompression_bomb'), kind: 'pdf' }).message,
    'b_bomb.png is damaged, not an image, or too large.');
  assert.equal(friendlyError({ err: processError('pil_truncated'), kind: 'pdf' }).message,
    'One of your images is damaged, not an image, or too large.');
  assert.equal(friendlyError({ err: processError('pil_truncated'), kind: 'pdf', context: { file: 'C:\\cards\\Bolt.jpg' } }).message,
    'Bolt.jpg is damaged, not an image, or too large.');
  const locked = friendlyError({
    err: { message: 'x', stderrTail: ['Traceback (most recent call last):', '  File "u.py", line 1, in g', 'OSError: Failed to load front image "game/front/a.png": [Errno 13] Permission denied: \'game/front/a.png\''], code: 1 },
    kind: 'pdf',
  });
  assert.equal(locked.code, 'FILE_LOCKED');
  assert.match(locked.message, /^Windows blocked reading a\.png/);
});

test('the documented "does not fit on paper size" text also maps to DOES_NOT_FIT', () => {
  const err = { code: 1, stderrTail: ['Traceback (most recent call last):', '  File "x.py", line 1', 'Exception: Card size "tarot" does not fit on paper size "letter".'] };
  assert.equal(friendlyError({ err, kind: 'pdf' }).code, 'DOES_NOT_FIT');
});

test('Windows crash exit codes and POSIX SIGKILL mean out of memory', () => {
  for (const code of [3221225477, 3221226505, 3221225725, -1073741819, -1073740791, -1073741571]) {
    const fe = friendlyError({ err: { name: 'JobProcessError', code, stderrTail: [], command: 'python create_pdf.py', program: 'Python' }, kind: 'pdf' });
    assert.equal(fe.code, 'OUT_OF_MEMORY', String(code));
    assert.equal(fe.message, MESSAGES.OUT_OF_MEMORY);
  }
  const killed = friendlyError({ err: { name: 'JobProcessError', code: null, signal: 'SIGKILL', stderrTail: [], command: 'python x' }, kind: 'pdf' });
  assert.equal(killed.code, 'OUT_OF_MEMORY');
  const details = friendlyError({ err: { name: 'JobProcessError', code: 3221225477, stderrTail: [], command: 'python x' } }).details;
  assert.match(details, /Exit code: 3221225477 \(0xC0000005\)/);
});

test('a crash of Upscayl is not reported as "computer ran out of memory"', () => {
  const byCommand = friendlyError({ err: { name: 'JobProcessError', code: 3221225477, stderrTail: [], command: '"C:\\Upscayl\\resources\\bin\\upscayl-bin.exe" -i a -o b' }, kind: 'pdf' });
  assert.equal(byCommand.code, 'UPSCAYL_CRASHED');
  const byKind = friendlyError({ err: { name: 'JobProcessError', code: 3221225477, stderrTail: [] }, kind: 'upscale' });
  assert.equal(byKind.code, 'UPSCAYL_CRASHED');
  const python = friendlyError({ err: { name: 'JobProcessError', code: 3221225477, stderrTail: [], command: 'python scm_helper.py prepare-upscale' }, kind: 'upscale' });
  assert.equal(python.code, 'OUT_OF_MEMORY');
});

test('generic failures: short Python message, never raw flags', () => {
  const fe = friendlyError({ err: processError('file_not_found'), kind: 'pdf' });
  assert.equal(fe.message, "Something went wrong: FileNotFoundError: [Errno 2] No such file or directory: 'missing-deck.txt'");
  const click = friendlyError({ err: processError('click_usage'), kind: 'pdf' });
  assert.match(click.message, /^Something went wrong: Invalid value for 'card size': 'nope' is not one of/);
  assert.ok(click.message.length <= 'Something went wrong: '.length + 200);
  const noStderr = friendlyError({ err: { name: 'JobProcessError', code: 1, stderrTail: [], command: '"C:\\venv\\Scripts\\python.exe" x.py', program: 'Python' } });
  assert.equal(noStderr.message, 'Something went wrong: Python stopped with exit code 1.');
  assert.equal(noStderr.code, 'UNKNOWN');
});

test('helper-style failures ({ message, traceback }) are parsed from the traceback', () => {
  const traceback = fs.readFileSync(path.join(FIXTURES, 'pdf_permission_denied.txt'), 'utf8');
  const err = Object.assign(new Error("PermissionError: [Errno 13] Permission denied: 'out/deck.pdf'"), { traceback });
  const fe = friendlyError({ err, kind: 'pdf' });
  assert.equal(fe.code, 'OUTPUT_LOCKED');
  assert.ok(fe.details.includes('PermissionError: [Errno 13]'));
  // An Error whose message is a Python exception line is treated as Python, not passed through raw.
  const plain = friendlyError({ err: new Error('ValueError: unexpected layout'), kind: 'pdf' });
  assert.equal(plain.message, 'Something went wrong: ValueError: unexpected layout');
});

test('Node spawn errors: ENOENT -> could not start, EPERM/EACCES -> blocked', () => {
  const enoent = Object.assign(new Error('spawn C:\\venv\\Scripts\\python.exe ENOENT'), {
    code: 'ENOENT', errno: -4058, syscall: 'spawn C:\\venv\\Scripts\\python.exe', path: 'C:\\venv\\Scripts\\python.exe',
  });
  assert.deepEqual(
    { code: friendlyError({ err: enoent }).code, message: friendlyError({ err: enoent }).message },
    { code: 'START_FAILED', message: 'Could not start Python.' },
  );
  const eacces = Object.assign(new Error('spawn EACCES'), { code: 'EACCES', errno: -4092, syscall: 'spawn C:\\Upscayl\\resources\\bin\\upscayl-bin.exe', path: 'C:\\Upscayl\\resources\\bin\\upscayl-bin.exe' });
  assert.equal(friendlyError({ err: eacces }).message, 'Windows or your antivirus blocked Upscayl.');
  assert.equal(friendlyError({ err: eacces }).code, 'START_BLOCKED');
});

test('Node file-system errors: locked output and full disk', () => {
  const ebusy = Object.assign(new Error("EBUSY: resource busy or locked, rename 'a' -> 'b'"), { code: 'EBUSY', errno: -4082, syscall: 'rename', path: 'a' });
  assert.equal(friendlyError({ err: ebusy, kind: 'pdf' }).code, 'OUTPUT_LOCKED');
  const enospc = Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', errno: -4055, syscall: 'write' });
  assert.equal(friendlyError({ err: enospc, kind: 'pdf' }).code, 'DISK_FULL');
  const pyDisk = { code: 1, stderrTail: ['Traceback (most recent call last):', '  File "x", line 1', 'OSError: [Errno 28] No space left on device'] };
  assert.equal(friendlyError({ err: pyDisk, kind: 'pdf' }).code, 'DISK_FULL');
});

test('cancellation, user errors and app errors', () => {
  const cancelled = Object.assign(new Error('Cancelled'), { name: 'CancelledError', code: 'CANCELLED' });
  assert.deepEqual(friendlyError({ err: cancelled }), { message: 'Cancelled.', details: '', code: 'CANCELLED' });
  const abort = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  assert.equal(friendlyError({ err: abort }).code, 'CANCELLED');

  const ue = userError('The deck list file could not be found', { code: 'DECK_FILE_MISSING', details: 'path: x.txt' });
  assert.equal(ue.friendly, true);
  assert.deepEqual(friendlyError({ err: ue }), { message: 'The deck list file could not be found', details: 'path: x.txt', code: 'DECK_FILE_MISSING' });

  // Plain app errors are already written for users.
  const app = new Error('None of your lines were recognized. Is the list format right? (selected: MTG Arena)');
  assert.equal(friendlyError({ err: app, kind: 'fetch' }).message, app.message);
  const busy = Object.assign(new Error('BUSY: wait until "Making the PDF" finishes'), { code: 'BUSY' });
  assert.deepEqual([friendlyError({ err: busy }).message, friendlyError({ err: busy }).code], [busy.message, 'BUSY']);

  // Programming errors get the generic prefix.
  const te = friendlyError({ err: new TypeError("Cannot read properties of undefined (reading 'x')") });
  assert.equal(te.code, 'UNKNOWN');
  assert.match(te.message, /^Something went wrong: Cannot read properties/);
  assert.match(te.details, /TypeError/);

  assert.equal(friendlyError({ err: 'plain string' }).message, 'Something went wrong: plain string');
  assert.equal(friendlyError({ err: null }).message, 'Something went wrong: unknown error');
  assert.equal(friendlyError().code, 'UNKNOWN');
});

test('network host: from the error text, from context, or a per-kind fallback', () => {
  assert.match(friendlyError({ err: processError('network_dns'), kind: 'fetch', context: { host: 'api.scryfall.com' } }).message,
    /^Couldn't reach api\.scryfall\.com\./);
  const bare = { code: 1, stderrTail: ['socket.gaierror: [Errno 11001] getaddrinfo failed'] };
  assert.match(friendlyError({ err: bare, kind: 'fetch' }).message, /^Couldn't reach the card website\./);
  // uv (setup) style output
  const uv = {
    name: 'JobProcessError', code: 2, command: 'uv pip install', stderrTail: [
      'error: Failed to fetch: `https://pypi.org/simple/pillow/`',
      '  Caused by: Request failed after 3 retries',
      '  Caused by: error sending request for url (https://pypi.org/simple/pillow/)',
      '  Caused by: dns error: failed to lookup address information: No such host is known. (os error 11001)',
    ],
  };
  const fe = friendlyError({ err: uv, kind: 'setup' });
  assert.equal(fe.code, 'NETWORK');
  assert.match(fe.message, /^Couldn't reach pypi\.org\./);
});

test('BAD_ENCODING only applies to deck lists (fetch jobs)', () => {
  assert.equal(friendlyError({ err: processError('unicode_decode'), kind: 'fetch' }).code, 'BAD_ENCODING');
  assert.equal(friendlyError({ err: processError('unicode_decode') }).code, 'BAD_ENCODING');
  assert.equal(friendlyError({ err: processError('unicode_decode'), kind: 'pdf' }).code, 'UNKNOWN');
});

test('parsePythonError edge cases', () => {
  assert.equal(parsePythonError(null), null);
  assert.equal(parsePythonError([]), null);
  assert.equal(parsePythonError(''), null);
  assert.equal(parsePythonError(['', '   ']), null);
  // String input with CRLF line endings.
  const s = 'Traceback (most recent call last):\r\n  File "a.py", line 1, in <module>\r\nKeyError: \'image_uris\'\r\n';
  assert.deepEqual({ ...parsePythonError(s), raw: undefined }, { type: 'KeyError', message: "'image_uris'", raw: undefined });
  // Exception without message, trailing blank lines.
  assert.equal(parsePythonError(['Traceback (most recent call last):', '  File "a", line 1', 'KeyboardInterrupt', '', '']).type, 'KeyboardInterrupt');
  // Names without an Error suffix are still found in a traceback block.
  assert.equal(parsePythonError(['Traceback (most recent call last):', '  File "a", line 1', 'StopIteration']).type, 'StopIteration');
  // The first exception line wins over exception-looking continuation lines.
  const multi = parsePythonError(['Traceback (most recent call last):', '  File "a", line 1', 'RuntimeError: outer', 'ValueError: inner text']);
  assert.equal(multi.type, 'RuntimeError');
  assert.deepEqual(multi.notes, ['ValueError: inner text']);
  // Noise before the traceback (warnings) is ignored.
  const noisy = parsePythonError(['C:\\x.py:3: DeprecationWarning: old', '  warnings.warn()', 'Traceback (most recent call last):', '  File "a", line 1', 'OSError: boom']);
  assert.deepEqual([noisy.type, noisy.message], ['OSError', 'boom']);
  // click usage error without a Usage line.
  assert.deepEqual({ ...parsePythonError(['Error: No such option: --nope']), raw: undefined }, { type: 'UsageError', message: 'No such option: --nope', raw: undefined });
  // Fallback: last non-empty line.
  assert.deepEqual(parsePythonError(['something happened', 'vkQueueSubmit failed -4', '']), { type: null, message: 'vkQueueSubmit failed -4', raw: 'vkQueueSubmit failed -4' });
});

test('helpers: humanizeFlags and programLabel', () => {
  assert.equal(humanizeFlags("Invalid value for '--card_size': 'x'"), "Invalid value for 'card size': 'x'");
  assert.equal(humanizeFlags('use --only_fronts or --load-offset'), 'use only fronts or load offset');
  assert.equal(humanizeFlags('a--b stays'), 'a--b stays');
  assert.equal(programLabel('C:\\venv\\Scripts\\python.exe'), 'Python');
  assert.equal(programLabel('/usr/bin/python3.12'), 'Python');
  assert.equal(programLabel('D:\\Tools\\Upscayl\\resources\\bin\\upscayl-bin.exe'), 'Upscayl');
  assert.equal(programLabel('uv.exe'), 'the component installer (uv)');
  assert.equal(programLabel('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'PowerShell');
  assert.equal(programLabel(null), 'the program');
});
