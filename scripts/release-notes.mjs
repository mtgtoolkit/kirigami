#!/usr/bin/env node
// Write the release notes of a Kirigami version: the app's commits since the previous release tag (new
// features, fixes, then everything else) and the Silhouette Card Maker engine commit the installer bundles
// (engine.lock.json), each linked to its repository. The release workflow puts them on the draft release it
// creates; run it locally to preview what the next release will say.
//
//   node scripts/release-notes.mjs                            notes for package.json's version, to stdout
//   node scripts/release-notes.mjs --since <tag>              compare with this tag (default: the latest v* tag
//                                                             reachable from HEAD, other than this version's)
//   node scripts/release-notes.mjs --out <file>               write them to a file instead
//   node scripts/release-notes.mjs --repository <owner/name>  link the app's commits there (default: package.json)
//
// The engine commit's title costs one GitHub API call; GITHUB_TOKEN or GH_TOKEN lifts the 60-calls-per-hour
// limit (CI sets it). Without network the notes leave the title out rather than fail.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubSlug } from './check-package.mjs';

const require = createRequire(import.meta.url);
const engineFiles = require('../src/main/engine-files.js');
const { createEngineRemote } = require('../src/main/engine-remote.js');

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(SCRIPT_DIR, '..');
const ENGINE_BUILD_DIR = path.join(APP_DIR, 'build', 'engine');
const ENGINE_TITLE_TIMEOUT_MS = 15 * 1000;
/** Commit groups in the order they are listed; `types: null` takes every other commit. */
const GROUPS = Object.freeze([
  Object.freeze({ title: 'New', types: Object.freeze(['feat']) }),
  Object.freeze({ title: 'Fixed', types: Object.freeze(['fix']) }),
  Object.freeze({ title: 'Other changes', types: null }),
]);
/** The commits a release itself makes; they say nothing a reader needs. */
const RELEASE_COMMIT = /^chore\(release\):/;

const warn = (msg) => console.error(`[release-notes] ${msg}`);
const short = (sha) => String(sha).slice(0, 7);

function usage() {
  return [
    'Usage: node scripts/release-notes.mjs [--since <tag>] [--out <file>] [--repository <owner/name>]',
    "Prints the release notes for package.json's version: commits since the previous v* tag and the bundled engine.",
    '  --since <tag>              previous release tag (default: latest v* tag reachable from HEAD)',
    '  --out <file>               write the notes to this file',
    '  --repository <owner/name>  repository the commit links point to (default: package.json repository)',
  ].join('\n');
}

function parseArgs(argv) {
  const args = { since: null, out: null, repository: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--since' || a === '--out' || a === '--repository') {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${a} needs a value\n${usage()}`);
      args[a.slice(2)] = value;
    } else throw new Error(`unknown option ${a}\n${usage()}`);
  }
  return args;
}

/**
 * A commit subject split the conventional way ("feat(engine): fetch ..." -> type feat, scope engine).
 * Subjects that do not follow the convention keep their text and get no type.
 * @param {string} subject
 * @returns {{type:string|null, scope:string|null, text:string}}
 */
export function parseSubject(subject) {
  const text = String(subject).trim();
  const match = /^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/i.exec(text);
  return match ? { type: match[1].toLowerCase(), scope: match[2] || null, text: match[3] } : { type: null, scope: null, text };
}

/**
 * Commits sorted into GROUPS (empty groups left out), release commits dropped, git log order kept. Each
 * entry's `line` is what the notes show: in "New" and "Fixed" the type is the heading already, so the line is
 * the description with its scope in bold; under "Other changes" the whole subject stays (docs:, ci:, ...).
 * @param {{sha:string, subject:string}[]} commits
 * @returns {{title:string, commits:{sha:string, line:string}[]}[]}
 */
export function groupCommits(commits) {
  const groups = GROUPS.map((group) => ({ title: group.title, types: group.types, commits: [] }));
  for (const commit of commits) {
    if (RELEASE_COMMIT.test(commit.subject)) continue;
    const parsed = parseSubject(commit.subject);
    const group = groups.find((g) => g.types === null || g.types.includes(parsed.type));
    const line = group.types === null ? String(commit.subject).trim() : `${parsed.scope ? `**${parsed.scope}:** ` : ''}${parsed.text}`;
    group.commits.push({ sha: commit.sha, line });
  }
  return groups.filter((g) => g.commits.length).map(({ title, commits: list }) => ({ title, commits: list }));
}

/**
 * The release notes, in Markdown.
 * @param {object} input
 * @param {string} input.version            version being released, e.g. '1.2.0' (tag v1.2.0)
 * @param {string} input.appUrl             https://github.com/<owner>/<name> of the app
 * @param {string|null} input.previousTag   previous release tag, null for the first release
 * @param {{sha:string, subject:string}[]} input.commits  app commits since previousTag, newest first
 * @param {{repository:string, commit:string, committedAt:string, version?:string|null, title?:string|null}} input.engine
 *   the bundled engine (engine.lock.json, plus its version and commit title when known)
 * @param {{repository:string, commit:string}|null} [input.previousEngine]  the engine previousTag bundled
 * @returns {string}
 */
export function renderReleaseNotes({ version, appUrl, previousTag, commits, engine, previousEngine = null }) {
  const lines = [];
  const commitLink = (sha) => `[${short(sha)}](${appUrl}/commit/${sha})`;

  lines.push(previousTag ? `## Changes since ${previousTag}` : '## Changes', '');
  if (!previousTag) lines.push('The first release of Kirigami.', '');
  const groups = groupCommits(commits);
  if (!groups.length) {
    lines.push(`No changes to the app itself${previousTag ? ` since ${previousTag}` : ''}.`, '');
  } else {
    for (const group of groups) {
      lines.push(`### ${group.title}`, '');
      for (const c of group.commits) lines.push(`- ${c.line} (${commitLink(c.sha)})`);
      lines.push('');
    }
  }
  if (previousTag) lines.push(`Full list: [${previousTag}...v${version}](${appUrl}/compare/${previousTag}...v${version})`, '');

  const engineUrl = `https://github.com/${engine.repository}`;
  const date = String(engine.committedAt).slice(0, 10);
  lines.push('## Card maker engine', '');
  lines.push(`This installer includes [Silhouette Card Maker](${engineUrl})${engine.version ? ` ${engine.version}` : ''} at commit `
    + `[${short(engine.commit)}](${engineUrl}/commit/${engine.commit})${engine.title ? ` "${engine.title}"` : ''} (${date}).`);
  if (previousEngine && previousTag) {
    if (previousEngine.repository !== engine.repository) {
      lines.push('', `${previousTag} bundled ${previousEngine.repository} at ${short(previousEngine.commit)}.`);
    } else if (previousEngine.commit === engine.commit) {
      lines.push('', `Same engine commit as ${previousTag}.`);
    } else {
      lines.push('', `Engine changes since ${previousTag}: [${short(previousEngine.commit)}...${short(engine.commit)}](${engineUrl}/compare/${previousEngine.commit}...${engine.commit})`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

/** Run git in the app folder; stdout, or null when git fails (and `optional`). */
function git(args, { optional = false } = {}) {
  const result = spawnSync('git', args, { cwd: APP_DIR, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(result.error.code === 'ENOENT' ? 'git was not found on PATH' : `git: ${result.error.message}`);
  if (result.status !== 0) {
    if (optional) return null;
    throw new Error(`git ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || '').trim()}`);
  }
  return result.stdout;
}

/** The latest v* tag reachable from HEAD, ignoring this version's own tag (so the notes can be re-made). */
function previousReleaseTag(version) {
  const out = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*', '--exclude', `v${version}`, 'HEAD'], { optional: true });
  return out ? out.trim() : null;
}

/** Commits in `since..HEAD` (all of HEAD's history without `since`), newest first, merges left out. */
function commitsSince(since) {
  const out = git(['log', '--no-merges', '--format=%H%x1f%s%x1e', since ? `${since}..HEAD` : 'HEAD']);
  return out.split('\x1e').map((record) => record.trim()).filter(Boolean).map((record) => {
    const [sha, subject = ''] = record.split('\x1f');
    return { sha, subject };
  });
}

/** engine.lock.json as of a tag, or null when that tag has none (or an unreadable one). */
function engineLockAt(tag) {
  const text = git(['show', `${tag}:engine.lock.json`], { optional: true });
  if (text === null) return null;
  try {
    return engineFiles.parseEngineLock(text);
  } catch {
    return null;
  }
}

/** The engine version from build/engine's manifest when it was built from this lock (npm run fetch-engine). */
async function builtEngineVersion(lock) {
  try {
    const manifest = await engineFiles.readManifest(ENGINE_BUILD_DIR);
    return manifest && engineFiles.sameSource(manifest.source, lock) ? manifest.engineVersion || null : null;
  } catch {
    return null;
  }
}

/** First line of the engine commit's message (one REST call), or null when GitHub cannot be asked. */
async function engineCommitTitle(lock) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || null;
  try {
    const remote = createEngineRemote({ fetch, token, timeoutMs: ENGINE_TITLE_TIMEOUT_MS, retries: 1 });
    const info = await remote.getCommit(lock.repository, lock.commit);
    return info.message.split(/\r?\n/)[0].trim() || null;
  } catch (err) {
    warn(`leaving the engine commit title out: ${err && err.message ? err.message : err}`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  const pkg = JSON.parse(await fs.readFile(path.join(APP_DIR, 'package.json'), 'utf8'));
  const slug = githubSlug(args.repository || pkg.repository);
  if (!slug) {
    throw new Error(args.repository ? `--repository ${args.repository} is not "owner/name"` : 'package.json has no GitHub repository: pass --repository <owner/name>');
  }
  const lock = engineFiles.parseEngineLock(await fs.readFile(path.join(APP_DIR, 'engine.lock.json'), 'utf8'));

  const previousTag = args.since || previousReleaseTag(pkg.version);
  if (previousTag && git(['rev-parse', '--verify', '--quiet', `${previousTag}^{commit}`], { optional: true }) === null) {
    throw new Error(`${previousTag} is not a tag or commit of this repository`);
  }
  const notes = renderReleaseNotes({
    version: pkg.version,
    appUrl: `https://github.com/${slug}`,
    previousTag,
    commits: commitsSince(previousTag),
    engine: { ...lock, version: await builtEngineVersion(lock), title: await engineCommitTitle(lock) },
    previousEngine: previousTag ? engineLockAt(previousTag) : null,
  });

  if (args.out) {
    await fs.writeFile(path.resolve(args.out), notes);
    console.error(`[release-notes] wrote ${path.resolve(args.out)} (v${pkg.version}, ${previousTag ? `since ${previousTag}` : 'first release'})`);
  } else {
    process.stdout.write(notes);
  }
}

/** True when node was started with this file (not when a test imports it). */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  const norm = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
  return norm(process.argv[1]) === norm(fileURLToPath(import.meta.url));
}

if (isEntryPoint()) {
  main().catch((err) => {
    console.error(`[release-notes] ERROR: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  });
}
