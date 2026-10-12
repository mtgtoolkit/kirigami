#!/usr/bin/env node
// Download the pinned uv release (Windows x64) into build/uv/ for packaging.
//
// electron-builder copies build/uv/{uv.exe, LICENSE*} to <install>/resources/bin/, where the app uses uv to
// install its own Python and the card maker components on first run (no system Python needed).
//
//   node scripts/fetch-uv.mjs            download + verify (skipped when build/uv/uv.exe is already verified)
//   node scripts/fetch-uv.mjs --force    download again even if uv.exe is present
//
// Security: the zip must match the pinned SHA-256 (published by Astral next to the release asset) and the
// extracted uv.exe must match its own pinned SHA-256. Nothing unverified is ever written to build/uv/.
// Extraction: tar -xf (Windows 10+ ships bsdtar, which reads zip), falling back to PowerShell Expand-Archive
// (and to `unzip` on macOS/Linux build machines).

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const UV_VERSION = '0.12.22';
const ASSET = 'uv-x86_64-pc-windows-msvc.zip';
/** SHA-256 of the release zip (also published as <asset>.sha256 on the release page). */
const ZIP_SHA256 = 'ea1397797a0ca15f63516dd0f49c2dde9776db9be5861cab152ebe8ad199894d';
/** SHA-256 of uv.exe inside that zip (lets re-runs verify the extracted file without downloading). */
const UV_EXE_SHA256 = '99ab16660d3b19f4e336eee57e7203daa52c18d3cec8aae13a95b9cfa46d85d1';
const DOWNLOAD_URLS = [
  `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${ASSET}`,
  // Astral's official mirror (used first by their own installer); same file, same hash.
  `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${ASSET}`,
];
const ATTEMPTS_PER_URL = 2;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const OUT_DIR = path.join(APP_DIR, 'build', 'uv');
const UV_EXE = path.join(OUT_DIR, 'uv.exe');
const LICENSE_FILE = path.join(OUT_DIR, 'LICENSE-uv.txt');

const LICENSE_TEXT = `uv ${UV_VERSION} - bundled with Silhouette Card Maker as resources/bin/uv.exe
==========================================================================

uv is an extremely fast Python package and project manager by Astral Software Inc.
Project:  https://github.com/astral-sh/uv
Source:   https://github.com/astral-sh/uv/tree/${UV_VERSION}
Binary:   ${DOWNLOAD_URLS[0]}
          (SHA-256 ${ZIP_SHA256}), uv.exe unmodified (SHA-256 ${UV_EXE_SHA256})

uv is dual-licensed under the Apache License, Version 2.0 or the MIT License, at your option.
It is redistributed here under the terms of the MIT License, reproduced below.
Full license texts:
  https://github.com/astral-sh/uv/blob/${UV_VERSION}/LICENSE-MIT
  https://github.com/astral-sh/uv/blob/${UV_VERSION}/LICENSE-APACHE
uv includes third-party Rust crates under their own permissive licenses; see the uv repository.

--------------------------------------------------------------------------
MIT License

Copyright (c) 2025 Astral Software Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`.replace(/\n/g, os.EOL === '\r\n' ? '\r\n' : '\n');

const log = (msg) => console.log(`[fetch-uv] ${msg}`);

/** SHA-256 (hex) of a file, streamed; null when the file does not exist. */
async function sha256File(file) {
  try {
    const hash = createHash('sha256');
    await pipeline(createReadStream(file), hash);
    return hash.digest('hex');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/** Download `url` to `dest` while hashing; resolves the SHA-256 hex. */
async function download(url, dest) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const total = Number(response.headers.get('content-length')) || 0;
  const showProgress = Boolean(total && process.stdout.isTTY);
  const hash = createHash('sha256');
  let received = 0;
  let lastReport = Date.now();
  const meter = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      received += chunk.length;
      const now = Date.now();
      if (showProgress && now - lastReport > 500) {
        lastReport = now;
        process.stdout.write(`[fetch-uv]   ${((received / total) * 100).toFixed(0)}% of ${(total / 1048576).toFixed(1)} MB\r`);
      }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(dest));
  if (showProgress) process.stdout.write(`${' '.repeat(60)}\r`);
  if (total && received !== total) throw new Error(`incomplete download (${received} of ${total} bytes)`);
  return hash.digest('hex');
}

/** Run a command synchronously; true when it exits 0. */
function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, encoding: 'utf8' });
  if (result.error) return { ok: false, detail: result.error.message };
  return { ok: result.status === 0, detail: `${result.stderr || ''}${result.stdout || ''}`.trim() };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/** Extract uv.exe from the zip into `workDir`; returns the extracted path. */
async function extractUvExe(zipPath, workDir) {
  const attempts = [];
  // 1) tar -xf. Prefer Windows' own bsdtar: a GNU tar earlier on PATH (Git for Windows) cannot read zip files.
  const systemTar = process.platform === 'win32' && process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : null;
  const tars = [];
  if (systemTar && await exists(systemTar)) tars.push(systemTar);
  tars.push('tar');
  for (const tar of tars) {
    const result = run(tar, ['-xf', zipPath, '-C', workDir, 'uv.exe']);
    const out = path.join(workDir, 'uv.exe');
    if (result.ok && await exists(out)) return out;
    attempts.push(`${tar}: ${result.detail || 'failed'}`);
    await fs.rm(out, { force: true });
  }
  // 2) PowerShell Expand-Archive (extracts everything into a sub folder).
  if (process.platform === 'win32') {
    const dest = path.join(workDir, 'expanded');
    const ps = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
    const quote = (s) => `'${s.replace(/'/g, "''")}'`;
    const result = run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${quote(zipPath)} -DestinationPath ${quote(dest)} -Force`]);
    const out = path.join(dest, 'uv.exe');
    if (result.ok && await exists(out)) return out;
    attempts.push(`PowerShell Expand-Archive: ${result.detail || 'failed'}`);
  } else {
    // 3) unzip on macOS / Linux build machines.
    const result = run('unzip', ['-o', '-q', zipPath, 'uv.exe', '-d', workDir]);
    const out = path.join(workDir, 'uv.exe');
    if (result.ok && await exists(out)) return out;
    attempts.push(`unzip: ${result.detail || 'failed'}`);
  }
  throw new Error(`could not extract uv.exe from the zip:\n  ${attempts.join('\n  ')}`);
}

/** Write the license notice only when its content changed (keeps the build folder stable). */
async function writeLicense() {
  let current = null;
  try {
    current = await fs.readFile(LICENSE_FILE, 'utf8');
  } catch { /* missing */ }
  if (current !== LICENSE_TEXT) {
    await fs.writeFile(LICENSE_FILE, LICENSE_TEXT, 'utf8');
    log(`wrote ${path.relative(APP_DIR, LICENSE_FILE)}`);
  }
}

/** Copy into place atomically: temp file in the same folder, then rename over the old one. */
async function installFile(src, dest) {
  const tmp = `${dest}.tmp-${process.pid}`;
  await fs.copyFile(src, tmp);
  try {
    await fs.rename(tmp, dest);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    if (err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES')) {
      throw new Error(`${dest} is in use (is a uv process or an antivirus scan running?). Close it and run again.`);
    }
    throw err;
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node scripts/fetch-uv.mjs [--force]\nDownloads and verifies uv ' + UV_VERSION + ' (Windows x64) into build/uv/.');
    return;
  }
  const force = args.has('--force');
  await fs.mkdir(OUT_DIR, { recursive: true });

  if (!force && await sha256File(UV_EXE) === UV_EXE_SHA256) {
    await writeLicense();
    log(`uv ${UV_VERSION} already present and verified: ${path.relative(APP_DIR, UV_EXE)}`);
    return;
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'scm-fetch-uv-'));
  try {
    const zipPath = path.join(workDir, ASSET);
    let verified = false;
    let mismatches = 0;
    const failures = [];
    for (const url of DOWNLOAD_URLS) {
      for (let attempt = 1; attempt <= ATTEMPTS_PER_URL && !verified; attempt++) {
        log(`downloading ${url}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        try {
          const digest = await download(url, zipPath);
          if (digest !== ZIP_SHA256) {
            mismatches++;
            throw new Error(`SHA-256 mismatch: got ${digest}, expected ${ZIP_SHA256}`);
          }
          verified = true;
        } catch (err) {
          failures.push(`${url}: ${err && err.message ? err.message : err}`);
          log(`  failed: ${err && err.message ? err.message : err}`);
          await fs.rm(zipPath, { force: true });
        }
      }
      if (verified) break;
    }
    if (!verified) {
      const hint = mismatches === failures.length
        ? 'The downloaded file never matched the pinned SHA-256: do not use it. Check the release page and the pins in this script.'
        : 'Check your internet connection. Behind a proxy, set HTTPS_PROXY and NODE_USE_ENV_PROXY=1.';
      throw new Error(`could not download a verified copy of ${ASSET}.\n  ${failures.join('\n  ')}\n${hint}`);
    }
    log('zip SHA-256 verified');

    const extracted = await extractUvExe(zipPath, workDir);
    const exeDigest = await sha256File(extracted);
    if (exeDigest !== UV_EXE_SHA256) {
      throw new Error(`uv.exe SHA-256 mismatch after extraction: got ${exeDigest}, expected ${UV_EXE_SHA256}`);
    }
    await installFile(extracted, UV_EXE);
    await writeLicense();
    log(`uv ${UV_VERSION} ready: ${path.relative(APP_DIR, UV_EXE)} (SHA-256 verified)`);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`[fetch-uv] ERROR: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
