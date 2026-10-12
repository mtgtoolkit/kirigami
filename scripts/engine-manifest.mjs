#!/usr/bin/env node
// List every engine file the installer ships (package.json build.extraResources entry from ".." to "engine"),
// with size and SHA-1, into build/engine-meta/.engine-manifest.json.
//
// electron-builder copies that file next to the engine (resources/engine/.engine-manifest.json). At startup the
// app compares the manifest's SHA-1 with the marker in a managed workspace and refreshes the engine code there
// when it changed (see src/main/workspace.js). The output is deterministic (sorted, no timestamps), so the
// SHA-1 only changes when a shipped engine file changes.
//
//   node scripts/engine-manifest.mjs           write the manifest
//   node scripts/engine-manifest.mjs --check   exit 1 if the manifest is missing or out of date (writes nothing)
//
// The filter is read from package.json (single source of truth) and evaluated like electron-builder 26
// (app-builder-lib fileMatcher/filter): minimatch-style globs relative to the engine root with dot:true, applied
// in order (a file is included by a positive pattern and can then be excluded by a later "!" pattern), a bare
// dot-less non-glob pattern also matches everything below it, and a top-level node_modules is never copied.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const OUT_FILE = path.join(APP_DIR, 'build', 'engine-meta', '.engine-manifest.json');
const MANIFEST_FORMAT = 1;

const log = (msg) => console.log(`[engine-manifest] ${msg}`);

/** The extraResources entry that ships the engine. */
async function readEngineResource() {
  const pkg = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8'));
  const entries = (pkg.build && Array.isArray(pkg.build.extraResources)) ? pkg.build.extraResources : [];
  const entry = entries.find((e) => e && typeof e === 'object' && e.from === '..' && e.to === 'engine');
  if (!entry || !Array.isArray(entry.filter) || entry.filter.length === 0) {
    throw new Error('package.json build.extraResources has no { from: "..", to: "engine", filter: [...] } entry');
  }
  return { root: path.resolve(APP_DIR, entry.from), patterns: entry.filter.map(String) };
}

const hasMagic = (segment) => /[*?[\]{}]/.test(segment);

/** Translate one path segment of a glob (no '/') into a RegExp source. Supports * ? [..] {a,b}. */
function segmentSource(segment) {
  let out = '';
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '*') {
      while (segment[i + 1] === '*') i++;
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end < 0) { out += '\\['; continue; }
      let body = segment.slice(i + 1, end).replace(/\\/g, '\\\\');
      if (body.startsWith('!')) body = `^${body.slice(1)}`;
      out += `[${body}]`;
      i = end;
    } else if (ch === '{') {
      const end = segment.indexOf('}', i + 1);
      if (end < 0) { out += '\\{'; continue; }
      out += `(?:${segment.slice(i + 1, end).split(',').map(segmentSource).join('|')})`;
      i = end;
    } else {
      out += ch.replace(/[.+^$()|\\]/g, '\\$&');
    }
  }
  return out;
}

/**
 * Compile a glob (posix, relative, no leading '!') into { full: RegExp, segments: (RegExp|'**')[] }.
 * '**' matches zero or more whole path segments.
 */
function compileGlob(glob) {
  const segments = glob.split('/').filter((s, i, all) => s !== '' || i === all.length - 1);
  let source = '';
  let afterGlobstar = false;
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === '**') {
      if (last) source += i === 0 ? '.*' : '(?:/.*)?';
      else { source += i === 0 ? '(?:[^/]+/)*' : '/(?:[^/]+/)*'; afterGlobstar = true; }
      return;
    }
    source += (i === 0 || afterGlobstar ? '' : '/') + segmentSource(segment);
    afterGlobstar = false;
  });
  return {
    full: new RegExp(`^${source}$`),
    segments: segments.map((s) => (s === '**' ? '**' : new RegExp(`^${segmentSource(s)}$`))),
  };
}

/** Parse the filter like app-builder-lib: normalize, negations, and the "bare name also matches name/**" rule. */
function parsePatterns(rawPatterns) {
  const parsed = [];
  for (let raw of rawPatterns) {
    raw = raw.replace(/\\/g, '/');
    const negate = raw.startsWith('!');
    let glob = path.posix.normalize(negate ? raw.slice(1) : raw).replace(/^\.\//, '');
    if (glob === '.') glob = '';
    parsed.push({ negate, glob, ...compileGlob(glob) });
    if (!negate && !glob.includes('.') && !glob.split('/').some(hasMagic)) {
      parsed.push({ negate: false, glob: `${glob}/**/*`, ...compileGlob(`${glob}/**/*`) });
    }
  }
  return parsed;
}

/**
 * minimatch-all semantics (app-builder-lib util/filter.js): patterns in order; while unmatched only positive
 * patterns are tried, once matched only negated ones. A negated minimatch pattern's match() is inverted, so a
 * matching "!" pattern un-matches the path and a non-matching one keeps it.
 */
function isIncluded(rel, patterns) {
  let match = false;
  for (const p of patterns) {
    if (match !== p.negate) continue;
    match = p.negate ? !p.full.test(rel) : p.full.test(rel);
  }
  return match;
}

/** Could any positive pattern match something inside directory `relDir` (posix, '' = root)? */
function mayContainMatches(relDir, patterns) {
  const dirSegs = relDir ? relDir.split('/') : [];
  return patterns.some((p) => {
    if (p.negate) return false;
    for (let i = 0; i < dirSegs.length; i++) {
      const seg = p.segments[i];
      if (seg === undefined) return false; // pattern is shorter than the directory depth
      if (seg === '**') return true; // globstar can absorb the rest
      if (!seg.test(dirSegs[i])) return false;
    }
    return p.segments.length > dirSegs.length; // something can still follow inside this directory
  });
}

/** Directory excluded outright by a negative pattern (e.g. a __pycache__ folder). */
function isExcludedDir(relDir, patterns) {
  return patterns.some((p) => p.negate && p.full.test(relDir) && /\*\*$/.test(p.glob));
}

/** Walk the engine root; returns sorted posix relative paths of shipped files. */
async function collectFiles(root, patterns) {
  const files = [];
  const skipped = [];
  async function walk(relDir) {
    const abs = relDir ? path.join(root, ...relDir.split('/')) : root;
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'EACCES' || err.code === 'EPERM')) { skipped.push(`${relDir || '.'} (${err.code})`); return; }
      throw err;
    }
    for (const entry of entries) {
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.name === '.DS_Store' || entry.name === '.gitkeep') continue; // builder-util walk() always skips these
      if (!relDir && entry.name === 'node_modules') continue; // electron-builder never copies the root node_modules
      if (entry.isSymbolicLink()) { if (isIncluded(rel, patterns)) skipped.push(`${rel} (symbolic link)`); continue; }
      if (entry.isDirectory()) {
        if (!isExcludedDir(rel, patterns) && mayContainMatches(rel, patterns)) await walk(rel);
      } else if (entry.isFile() && isIncluded(rel, patterns)) {
        files.push(rel);
      }
    }
  }
  await walk('');
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { files, skipped };
}

async function sha1File(file) {
  const hash = createHash('sha1');
  await pipeline(createReadStream(file), hash);
  return hash.digest('hex');
}

/** Engine version from create_pdf.py's @click.version_option("x.y.z"), or null. */
async function readEngineVersion(root) {
  try {
    const source = await fs.readFile(path.join(root, 'create_pdf.py'), 'utf8');
    const m = /version_option\(\s*["']([^"']+)["']/.exec(source);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function buildManifest() {
  const { root, patterns: rawPatterns } = await readEngineResource();
  try {
    await fs.access(path.join(root, 'create_pdf.py'));
  } catch {
    throw new Error(`engine not found: ${path.join(root, 'create_pdf.py')} is missing`);
  }
  const patterns = parsePatterns(rawPatterns);
  const { files, skipped } = await collectFiles(root, patterns);
  if (files.length === 0) throw new Error('the engine filter matched no files');
  for (const required of ['create_pdf.py', 'offset_pdf.py', 'utilities.py', 'requirements.txt', 'assets/layouts.json']) {
    if (!files.includes(required)) throw new Error(`the engine filter does not ship ${required}`);
  }
  const entries = [];
  let totalBytes = 0;
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    const stat = await fs.stat(abs);
    totalBytes += stat.size;
    entries.push({ path: rel, size: stat.size, sha1: await sha1File(abs) });
  }
  const manifest = {
    format: MANIFEST_FORMAT,
    engineVersion: await readEngineVersion(root),
    filter: rawPatterns,
    fileCount: entries.length,
    totalBytes,
    files: entries,
  };
  return { text: `${JSON.stringify(manifest, null, 2)}\n`, manifest, skipped };
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log('Usage: node scripts/engine-manifest.mjs [--check]\nWrites build/engine-meta/.engine-manifest.json (engine files shipped by the installer, with SHA-1).');
    return;
  }
  const { text, manifest, skipped } = await buildManifest();
  for (const s of skipped) log(`warning: not shipped: ${s}`);
  const sha1 = createHash('sha1').update(text).digest('hex');
  const rel = path.relative(APP_DIR, OUT_FILE);
  let current = null;
  try {
    current = await fs.readFile(OUT_FILE, 'utf8');
  } catch { /* missing */ }

  if (args.has('--check')) {
    if (current === text) {
      log(`${rel} is up to date (${manifest.fileCount} files, sha1 ${sha1})`);
      return;
    }
    log(`${rel} is ${current === null ? 'missing' : 'out of date'}: run "npm run manifest"`);
    process.exitCode = 1;
    return;
  }

  if (current === text) {
    log(`${rel} already up to date: ${manifest.fileCount} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB, sha1 ${sha1}`);
    return;
  }
  await fs.mkdir(path.dirname(OUT_FILE), { recursive: true });
  const tmp = `${OUT_FILE}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, OUT_FILE);
  log(`wrote ${rel}: ${manifest.fileCount} files, ${(manifest.totalBytes / 1048576).toFixed(1)} MB, engine ${manifest.engineVersion || 'unknown'}, sha1 ${sha1}`);
}

main().catch((err) => {
  console.error(`[engine-manifest] ERROR: ${err && err.message ? err.message : err}`);
  process.exitCode = 1;
});
