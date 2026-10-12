#!/usr/bin/env node
'use strict';

/**
 * Regenerates the captured plugin outputs in this folder (used by test/unit/fetch-parse.test.js).
 *
 * Every run uses a TEMP copy of the engine code (root *.py, requirements.txt, assets/, plugins/),
 * never the repository's game/ or data/ folders. Plugins are started exactly like fetch.js does:
 *   <python> plugins/<id>/fetch.py [--name=value ...] -- <deck> <format>
 * with cwd = the temp workspace and the app's Python environment (jobs.pythonEnv).
 * Network access is required (Scryfall, YGOPRODeck, Archon Arcana, Master Vault).
 *
 * Output: one `<name>.txt` per run:
 *   # key: value            header (command, exit code, files written, duration)
 *   [stdout] line / [stderr] line   (each stream in order; streams are not interleaved exactly)
 * plus `index.json` with the same metadata. The temp workspace path is replaced by <WORKSPACE>.
 *
 * Usage (from electron-app/): node test/fixtures/plugin-output/capture.js [--python <exe>] [--only name,name]
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pythonEnv } = require('../../../src/main/jobs');

const HERE = __dirname;
const APP_DIR = path.resolve(HERE, '..', '..', '..');
const ENGINE = path.resolve(APP_DIR, '..');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const PYTHON = option('--python', path.join(ENGINE, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
const ONLY = option('--only', '').split(',').filter(Boolean);

/** Little-endian uint32 passcodes -> base64 (YDKE section). */
function ydkeSection(codes) {
  const buf = Buffer.alloc(codes.length * 4);
  codes.forEach((c, i) => buf.writeUInt32LE(c, i * 4));
  return buf.toString('base64');
}

const RUNS = [
  {
    name: 'mtg_mtga_mixed',
    plugin: 'mtg',
    format: 'mtga',
    deck: { file: 'mixed.txt', text: 'Deck\n2 Lightning Bolt\n1 Sol Ring\n1 Delver of Secrets\n1 Lightnig Boltt\n\nSideboard\n1 Counterspell\n' },
    note: 'MTG Arena list: Deck/Sideboard headers, a blank line, a double-faced card and one misspelled card.',
  },
  {
    name: 'mtg_bom',
    plugin: 'mtg',
    format: 'mtga',
    deck: { file: 'bom.txt', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('1 Sol Ring\n2 Lightning Bolt\n', 'utf8')]) },
    note: 'UTF-8 BOM: the plugin reads with open(path, "r"), so the first card line is skipped.',
  },
  {
    name: 'mtg_missing_file',
    plugin: 'mtg',
    format: 'mtga',
    deckPath: 'game/decklist/does-not-exist.txt',
    note: 'Missing deck file: "<path> is not a valid file." and exit code 0.',
  },
  {
    name: 'mtg_bad_json',
    plugin: 'mtg',
    format: 'scryfall_json',
    deck: { file: 'broken.json', text: '{"entries": [not json' },
    note: 'Unparsable Scryfall JSON: Python traceback and a non-zero exit code.',
  },
  {
    name: 'mtg_options',
    plugin: 'mtg',
    format: 'simple',
    deck: { file: 'simple.txt', text: 'Sol Ring\n' },
    options: ['--prefer_older_sets', '--prefer_set=lea'],
    note: 'Options passed as --name=value before "--".',
  },
  {
    name: 'yugioh_ydke',
    plugin: 'yugioh',
    format: 'ydke',
    deckPath: `ydke://${ydkeSection([89631139, 89631139, 46986414])}!!!`,
    note: 'Inline YDKE code (no deck file): the plugin prints one saved image path per copy.',
  },
  {
    name: 'yugioh_ydke_bad_code',
    plugin: 'yugioh',
    format: 'ydke',
    deckPath: `ydke://${ydkeSection([46986414, 1234])}!!!`,
    note: 'Unknown passcode: YGOPRODeck answers with a placeholder card image, so nothing is reported.',
  },
  {
    name: 'yugioh_ydke_malformed',
    plugin: 'yugioh',
    format: 'ydke',
    deckPath: 'ydke://abc',
    note: 'Malformed YDKE code: ValueError traceback and a non-zero exit code.',
  },
  {
    name: 'mtg_url_unrecognized',
    plugin: 'mtg',
    format: 'url',
    deckPath: 'https://example.com/decks/12345',
    note: 'Deck link from an unsupported site: "URL not recognized by any supported site: ..." and exit code 0.',
  },
  {
    name: 'mtg_url_archidekt',
    plugin: 'mtg',
    format: 'url',
    deckPath: 'https://archidekt.com/decks/1',
    note: 'Public Archidekt deck link: Index lines carry set code and collector number; includes a double-faced card.',
  },
  {
    name: 'mtg_url_missing_deck',
    plugin: 'mtg',
    format: 'url',
    deckPath: 'https://archidekt.com/decks/999999999',
    note: 'Deck link to a deck that does not exist (or is private).',
  },
  {
    name: 'keyforge_archon_mixed',
    plugin: 'keyforge',
    format: 'archon_arcana',
    deck: { file: 'archon.txt', text: 'Ecto-Charge\nGracchan Reform\nGracchan Reform\nZzqx Not A Real Card\n' },
    note: 'KeyForge summary format: "N card(s) did not work:" then "  - name (error)".',
  },
  {
    name: 'keyforge_bad_deck_url',
    plugin: 'keyforge',
    format: 'master_vault_url',
    deckPath: 'https://www.keyforgegame.com/deck-details/00000000-0000-4000-8000-000000000000',
    note: 'Deck-level failure: "Error: ..." without a card, then "1 deck(s) did not work:".',
  },
];

function copyEngine(dest) {
  for (const name of fs.readdirSync(ENGINE)) {
    const src = path.join(ENGINE, name);
    if (fs.statSync(src).isFile() && (/\.py$/i.test(name) || name === 'requirements.txt')) fs.copyFileSync(src, path.join(dest, name));
  }
  for (const dir of ['assets', 'plugins']) {
    fs.cpSync(path.join(ENGINE, dir), path.join(dest, dir), {
      recursive: true,
      filter: (src) => !/__pycache__|\.pyc$/i.test(src),
    });
  }
  for (const kind of ['front', 'back', 'double_sided', 'decklist', 'output']) fs.mkdirSync(path.join(dest, 'game', kind), { recursive: true });
}

function countFiles(dir) {
  let n = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && !/^(readme|empty)\.md$/i.test(entry.name)) n += 1;
  }
  return n;
}

function run(ws, spec) {
  for (const kind of ['front', 'double_sided']) {
    fs.rmSync(path.join(ws, 'game', kind), { recursive: true, force: true });
    fs.mkdirSync(path.join(ws, 'game', kind), { recursive: true });
  }
  let deckPath = spec.deckPath;
  if (spec.deck) {
    const file = path.join(ws, 'game', 'decklist', spec.deck.file);
    fs.writeFileSync(file, spec.deck.bytes || Buffer.from(spec.deck.text, 'utf8'));
    deckPath = `game/decklist/${spec.deck.file}`;
  }
  const argv = [`plugins/${spec.plugin}/fetch.py`, ...(spec.options || []), '--', deckPath, spec.format];
  const started = Date.now();
  const r = childProcess.spawnSync(PYTHON, argv, {
    cwd: ws,
    env: pythonEnv(process.env, {}, path.join(ws, '.mpl-cache-parent')),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 300000,
  });
  const durationMs = Date.now() - started;
  const split = (text) => {
    const lines = String(text || '').split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  return {
    argv,
    exitCode: r.status,
    signal: r.signal,
    durationMs,
    stdout: split(r.stdout),
    stderr: split(r.stderr),
    files: { front: countFiles(path.join(ws, 'game', 'front')), double_sided: countFiles(path.join(ws, 'game', 'double_sided')) },
  };
}

function sanitize(text, ws) {
  let out = String(text);
  const variants = new Set([ws, ws.replace(/\\/g, '/'), ws.replace(/\//g, '\\'), ws.replace(/\\/g, '\\\\')]);
  for (const v of variants) out = out.split(v).join('<WORKSPACE>');
  const home = os.homedir();
  for (const v of new Set([home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\')])) out = out.split(v).join('<HOME>');
  return out;
}

function main() {
  if (!fs.existsSync(PYTHON)) {
    console.error(`Python not found: ${PYTHON} (use --python <exe>)`);
    process.exit(2);
  }
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-plugin-capture-'));
  const index = fs.existsSync(path.join(HERE, 'index.json')) ? JSON.parse(fs.readFileSync(path.join(HERE, 'index.json'), 'utf8')) : {};
  try {
    copyEngine(ws);
    for (const spec of RUNS) {
      if (ONLY.length && !ONLY.includes(spec.name)) continue;
      process.stdout.write(`${spec.name} ... `);
      const res = run(ws, spec);
      const header = [
        `# name: ${spec.name}`,
        `# note: ${spec.note}`,
        `# command: python ${res.argv.map((a) => (/[\s"]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`,
        `# exit: ${res.exitCode === null ? `signal ${res.signal}` : res.exitCode}`,
        `# files: front=${res.files.front} double_sided=${res.files.double_sided}`,
        `# duration_ms: ${res.durationMs}`,
        `# captured: ${new Date().toISOString().slice(0, 10)}`,
      ];
      const body = [...res.stdout.map((l) => `[stdout] ${l}`), ...res.stderr.map((l) => `[stderr] ${l}`)];
      fs.writeFileSync(path.join(HERE, `${spec.name}.txt`), `${sanitize([...header, ...body].join('\n'), ws)}\n`, 'utf8');
      index[spec.name] = {
        plugin: spec.plugin,
        format: spec.format,
        argv: res.argv.map((a) => sanitize(a, ws)),
        exitCode: res.exitCode,
        files: res.files,
        durationMs: res.durationMs,
        note: spec.note,
      };
      console.log(`exit ${res.exitCode}, front ${res.files.front}, double_sided ${res.files.double_sided}, ${res.durationMs} ms`);
    }
    fs.writeFileSync(path.join(HERE, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

main();
