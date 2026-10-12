'use strict';

/**
 * Windows "Uninstall" registry lookups (installed programs), done with ONE PowerShell
 * call that prints UTF-8 JSON. reg.exe output is in the OEM code page (cp850 here), which
 * mangles non-ASCII names, hence PowerShell + `[Console]::OutputEncoding=UTF8`.
 *
 * Results are cached per pattern for the session (pass `{ refresh: true }` to re-query).
 * Every failure (timeout, PowerShell missing, bad JSON) resolves to [] — detection is
 * best effort and must never break the app. Non-Windows platforms always get [].
 */

const child_process = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 10000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

const UNINSTALL_KEYS = Object.freeze([
  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
  'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
]);

const FIELDS = Object.freeze(['DisplayName', 'DisplayVersion', 'DisplayIcon', 'InstallLocation']);

/** pattern -> Promise<entries> (successful lookups only). */
const cache = new Map();

/**
 * Quote a string for a PowerShell single-quoted literal. PowerShell also treats the
 * typographic single quotes U+2018..U+201B as quote characters, so double those too.
 * @param {string} value
 * @returns {string}
 */
function psQuote(value) {
  return `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/g, (q) => q + q)}'`;
}

/**
 * Build the PowerShell script for a `-like` pattern (e.g. 'Upscayl*'). The script only
 * uses single quotes so it survives Windows command-line quoting unchanged.
 * @param {string} namePattern PowerShell wildcard pattern matched against DisplayName.
 * @returns {string}
 */
function buildUninstallScript(namePattern) {
  const keys = UNINSTALL_KEYS.map(psQuote).join(',');
  return [
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8',
    "$ErrorActionPreference='SilentlyContinue'",
    `$r=@(Get-ItemProperty -Path ${keys} -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like ${psQuote(namePattern)} } | Select-Object ${FIELDS.join(',')})`,
    "if($r.Count -eq 0){'[]'}else{ConvertTo-Json -InputObject $r -Compress -Depth 2}",
  ].join(';');
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = (typeof value === 'string' ? value : String(value)).trim();
  return text === '' ? null : text;
}

/**
 * Parse PowerShell's ConvertTo-Json output. Handles a single object (`{...}`) as well as an
 * array, a UTF-8 BOM, empty output and leading noise. Entries without DisplayName are dropped.
 * @param {string} text
 * @returns {Array<{DisplayName:string, DisplayVersion:string|null, DisplayIcon:string|null, InstallLocation:string|null}>}
 */
function parseUninstallJson(text) {
  if (typeof text !== 'string') return [];
  const trimmed = text.replace(/^\uFEFF/, '').trim();
  if (!trimmed) return [];
  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    const start = trimmed.search(/[[{]/);
    if (start < 0) return [];
    try {
      data = JSON.parse(trimmed.slice(start));
    } catch {
      return [];
    }
  }
  const list = Array.isArray(data) ? data : data && typeof data === 'object' ? [data] : [];
  const entries = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const entry = {};
    for (const field of FIELDS) entry[field] = cleanString(item[field]);
    if (entry.DisplayName) entries.push(entry);
  }
  return entries;
}

/**
 * Extract an executable path from a DisplayIcon value such as
 * `"C:\Program Files\App\App.exe",0` (quotes and icon index removed).
 * @param {string|null} displayIcon
 * @returns {string|null}
 */
function exePathFromDisplayIcon(displayIcon) {
  const text = cleanString(displayIcon);
  if (!text) return null;
  let value = text;
  const quoted = /^"([^"]+)"/.exec(value);
  if (quoted) value = quoted[1];
  else value = value.replace(/,\s*-?\d+\s*$/, '');
  value = value.trim();
  return value || null;
}

function runPowerShell(script, { timeoutMs, spawnImpl, systemRoot }) {
  return new Promise((resolve) => {
    const exe = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    let child;
    try {
      child = spawnImpl(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ ok: false, error, stdout: '', stderr: '' });
      return;
    }
    const out = [];
    const err = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    let timedOut = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ...result,
        timedOut,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: new Error(`PowerShell did not answer within ${timeoutMs} ms`) });
    }, timeoutMs);
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        if (outBytes < MAX_OUTPUT_BYTES) {
          out.push(chunk);
          outBytes += chunk.length;
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        if (errBytes < 64 * 1024) {
          err.push(chunk);
          errBytes += chunk.length;
        }
      });
    }
    child.on('error', (error) => finish({ ok: false, error }));
    child.on('close', (code) => finish({ ok: code === 0, code }));
  });
}

/**
 * Query the Windows Uninstall registry keys (HKCU, HKLM, HKLM WOW6432Node) for programs
 * whose DisplayName matches a PowerShell wildcard pattern.
 *
 * @param {string} namePattern e.g. 'Upscayl*' or 'Silhouette Studio*'
 * @param {object} [options]
 * @param {number} [options.timeoutMs=10000] PowerShell is killed after this delay.
 * @param {boolean} [options.refresh=false] Ignore the session cache.
 * @param {string} [options.platform=process.platform]
 * @param {Function} [options.spawnImpl=child_process.spawn] (tests)
 * @param {string} [options.systemRoot=%SystemRoot%]
 * @param {{warn?: Function}} [options.logger]
 * @returns {Promise<Array<{DisplayName:string, DisplayVersion:string|null, DisplayIcon:string|null, InstallLocation:string|null}>>}
 */
function queryUninstall(namePattern, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    refresh = false,
    platform = process.platform,
    spawnImpl = child_process.spawn,
    systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows',
    logger = null,
  } = options || {};
  if (platform !== 'win32') return Promise.resolve([]);
  if (typeof namePattern !== 'string' || !namePattern.trim() || namePattern.length > 200 || /[\0-\x1f]/.test(namePattern)) {
    return Promise.reject(new TypeError('queryUninstall: namePattern must be a short, non-empty string'));
  }
  const key = namePattern;
  if (!refresh && cache.has(key)) return cache.get(key);

  const promise = runPowerShell(buildUninstallScript(namePattern), { timeoutMs, spawnImpl, systemRoot }).then((result) => {
    if (!result.ok) {
      if (cache.get(key) === promise) cache.delete(key);
      if (logger && typeof logger.warn === 'function') {
        const reason = result.error ? result.error.message : `exit code ${result.code}`;
        logger.warn(`Registry lookup for "${namePattern}" failed: ${reason} ${result.stderr ? result.stderr.trim().slice(0, 500) : ''}`);
      }
      return [];
    }
    return parseUninstallJson(result.stdout);
  });
  cache.set(key, promise);
  return promise;
}

function compareVersions(a, b) {
  const pa = String(a || '').split(/[^\d]+/).filter(Boolean).map(Number);
  const pb = String(b || '').split(/[^\d]+/).filter(Boolean).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Detect Silhouette Studio from the Uninstall keys (informational only).
 * @param {object} [options] Same options as queryUninstall.
 * @returns {Promise<{found:boolean, path:string|null, version:string|null, name:string|null, installLocation:string|null}>}
 */
async function findSilhouetteStudio(options = {}) {
  const entries = await queryUninstall('Silhouette Studio*', options);
  if (!entries.length) return { found: false, path: null, version: null, name: null, installLocation: null };
  const best = entries.slice().sort((a, b) => compareVersions(b.DisplayVersion, a.DisplayVersion))[0];
  const exe = exePathFromDisplayIcon(best.DisplayIcon);
  let exePath = null;
  if (exe && /\.exe$/i.test(exe)) exePath = exe;
  else if (best.InstallLocation) {
    const guess = path.win32.join(best.InstallLocation, 'Silhouette Studio.exe');
    exePath = fs.existsSync(guess) ? guess : null;
  }
  return {
    found: true,
    path: exePath || best.InstallLocation || null,
    version: best.DisplayVersion || null,
    name: best.DisplayName,
    installLocation: best.InstallLocation || null,
  };
}

/** Forget cached lookups (tests, or after the user installs a program). */
function clearCache() {
  cache.clear();
}

module.exports = {
  queryUninstall,
  findSilhouetteStudio,
  parseUninstallJson,
  buildUninstallScript,
  exePathFromDisplayIcon,
  clearCache,
  UNINSTALL_KEYS,
};
