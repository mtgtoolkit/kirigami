'use strict';

// Consistency tests for the renderer data modules (src/renderer/js/data/*.js) against the real engine:
// plugin folders, DeckFormat enums (deck_formats.py), click options (fetch.py, create_pdf.py,
// offset_pdf.py), assets/layouts.json and the Hugo documentation tree. Read-only: nothing is written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENGINE_DIR = path.resolve(APP_DIR, '..');
const DATA_DIR = path.join(APP_DIR, 'src', 'renderer', 'js', 'data');
const HUGO_CONTENT = path.join(ENGINE_DIR, 'hugo', 'content');
const ENGINE_PRESENT = fs.existsSync(path.join(ENGINE_DIR, 'create_pdf.py')) && fs.existsSync(path.join(ENGINE_DIR, 'plugins'));
const SKIP_ENGINE = ENGINE_PRESENT ? false : `engine not found at ${ENGINE_DIR}`;

/** Import a renderer ES module (the renderer files are native ES modules). */
function load(name) {
  return import(pathToFileURL(path.join(DATA_DIR, name)).href);
}

const read = (file) => fs.readFileSync(file, 'utf8');

// ─── Tiny Python source parsers (good enough for the engine's simple declarations) ───

/** Values of `class <name>(...)` enum members: NAME = 'value' / "value". Returns [] when missing. */
function parseEnum(source, className) {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^class\\s+${className}\\s*\\(`).test(l));
  if (start < 0) return [];
  const values = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (!/^\s/.test(line)) break; // dedent = end of class body
    const m = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(['"])(.*?)\2/.exec(line);
    if (m) values.push({ member: m[1], value: m[3] });
  }
  return values;
}

/** Find an enum class in any .py file of a folder (non-recursive). */
function findEnum(dir, className) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.py'))) {
    const values = parseEnum(read(path.join(dir, file)), className);
    if (values.length) return values;
  }
  return [];
}

/** Return the text inside the balanced parentheses that start at `openIndex` (the '(' index). */
function balanced(source, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses at ${openIndex}`);
}

/**
 * click options declared with @click.option(...) / @option(...) (+ @click.version_option -> 'version'),
 * in declaration order: [{ name, args }].
 */
function parseClickOptions(source) {
  const result = [];
  const re = /@(?:click\.)?(option|version_option)\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const args = balanced(source, m.index + m[0].length - 1);
    if (m[1] === 'version_option') {
      result.push({ name: 'version', args });
      continue;
    }
    const strings = [...args.matchAll(/(['"])(.*?)\1/g)].map((s) => s[2]);
    const long = strings.find((s) => s.startsWith('--'));
    assert.ok(long, `option without a long flag: ${args.slice(0, 80)}`);
    result.push({ name: long.slice(2).replace(/-/g, '_'), args });
  }
  return result;
}

/** Convert a layouts.json length ('63mm', '2.5in') to millimetres. */
function toMm(value) {
  const m = /^([\d.]+)(mm|in)$/.exec(String(value));
  assert.ok(m, `unexpected length ${value}`);
  return m[2] === 'mm' ? Number(m[1]) : Number(m[1]) * 25.4;
}

const close = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;

/** Every user-facing string of an object tree, skipping keys that legitimately hold flags/regexes/urls. */
function userFacingStrings(value, skipKeys, out = [], keyPath = '') {
  if (typeof value === 'string') out.push({ keyPath, text: value });
  else if (Array.isArray(value)) value.forEach((v, i) => userFacingStrings(v, skipKeys, out, `${keyPath}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (skipKeys.has(k)) continue;
      userFacingStrings(v, skipKeys, out, keyPath ? `${keyPath}.${k}` : k);
    }
  }
  return out;
}

// ─── catalog.js ───

test('catalog: 22 plugins with unique ids matching engine plugin folders', { skip: SKIP_ENGINE }, async () => {
  const { PLUGINS } = await load('catalog.js');
  assert.equal(PLUGINS.length, 22);
  const ids = PLUGINS.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate plugin ids');
  const folders = fs.readdirSync(path.join(ENGINE_DIR, 'plugins'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(ENGINE_DIR, 'plugins', d.name, 'fetch.py')))
    .map((d) => d.name);
  for (const id of ids) assert.ok(folders.includes(id), `no plugin folder for catalog id "${id}"`);
  for (const folder of folders) assert.ok(ids.includes(folder), `plugin folder "${folder}" is missing from the catalog`);
});

test('catalog: format ids equal the DeckFormat enum values (same order)', { skip: SKIP_ENGINE }, async () => {
  const { PLUGINS } = await load('catalog.js');
  for (const plugin of PLUGINS) {
    const source = read(path.join(ENGINE_DIR, 'plugins', plugin.id, 'deck_formats.py'));
    const enumValues = parseEnum(source, 'DeckFormat').map((e) => e.value);
    assert.ok(enumValues.length > 0, `${plugin.id}: DeckFormat enum not found`);
    assert.deepEqual(plugin.formats.map((f) => f.id), enumValues, `${plugin.id}: formats differ from DeckFormat`);
  }
});

test('catalog: option names, kinds, choices and defaults match the click options of fetch.py', { skip: SKIP_ENGINE }, async () => {
  const { PLUGINS } = await load('catalog.js');
  for (const plugin of PLUGINS) {
    const dir = path.join(ENGINE_DIR, 'plugins', plugin.id);
    const clickOptions = parseClickOptions(read(path.join(dir, 'fetch.py')));
    assert.deepEqual(plugin.options.map((o) => o.name), clickOptions.map((o) => o.name), `${plugin.id}: options differ from fetch.py`);
    for (const option of plugin.options) {
      const { args } = clickOptions.find((c) => c.name === option.name);
      assert.equal(option.flag, `--${option.name}`, `${plugin.id}.${option.name}: flag`);
      const isFlag = /is_flag\s*=\s*True/.test(args);
      const multiple = /multiple\s*=\s*True/.test(args);
      const choiceEnum = /Choice\(\s*\[\s*\w+\.value\s+for\s+\w+\s+in\s+(\w+)\s*\]/.exec(args);
      if (isFlag) {
        assert.equal(option.kind, 'flag', `${plugin.id}.${option.name}: kind`);
        assert.equal(option.default, false, `${plugin.id}.${option.name}: flag default`);
      } else if (multiple) {
        assert.equal(option.kind, choiceEnum ? 'multi_choice' : 'multi_text', `${plugin.id}.${option.name}: kind`);
        assert.deepEqual(option.default, [], `${plugin.id}.${option.name}: list default`);
      } else {
        assert.equal(option.kind, 'choice', `${plugin.id}.${option.name}: kind`);
      }
      if (choiceEnum) {
        const values = findEnum(dir, choiceEnum[1]);
        assert.ok(values.length > 0, `${plugin.id}.${option.name}: enum ${choiceEnum[1]} not found`);
        assert.deepEqual(option.choices, values.map((v) => v.value), `${plugin.id}.${option.name}: choices`);
        assert.equal(option.choiceLabels.length, option.choices.length, `${plugin.id}.${option.name}: choiceLabels`);
        const def = /default\s*=\s*(\w+)\.(\w+)\.value/.exec(args);
        if (def) {
          const member = findEnum(dir, def[1]).find((v) => v.member === def[2]);
          assert.ok(member, `${plugin.id}.${option.name}: default member`);
          assert.equal(option.default, member.value, `${plugin.id}.${option.name}: default`);
        }
      }
      assert.ok(option.label && option.help, `${plugin.id}.${option.name}: label/help`);
      assert.equal(typeof option.advanced, 'boolean');
      if (option.onlyForFormats) {
        for (const f of option.onlyForFormats) assert.ok(plugin.formats.some((x) => x.id === f), `${plugin.id}.${option.name}: unknown format ${f}`);
      }
    }
  }
});

test('catalog: recommended card sizes are layouts.json card sizes or aliases', { skip: SKIP_ENGINE }, async () => {
  const { PLUGINS, getRecommendedPdf } = await load('catalog.js');
  const layouts = JSON.parse(read(path.join(ENGINE_DIR, 'assets', 'layouts.json')));
  const known = new Set(Object.entries(layouts.card_sizes).flatMap(([k, v]) => [k, ...(v.aliases || [])]));
  for (const plugin of PLUGINS) {
    assert.ok(known.has(plugin.recommendedCardSize), `${plugin.id}: unknown card size ${plugin.recommendedCardSize}`);
    assert.equal(plugin.recommendedPdf.card_size, plugin.recommendedCardSize, `${plugin.id}: recommendedPdf.card_size`);
    for (const format of plugin.formats) {
      const rec = getRecommendedPdf(plugin.id, format.id);
      assert.ok(known.has(rec.card_size), `${plugin.id}/${format.id}: card size`);
      for (const key of Object.keys(rec)) assert.ok(['card_size', 'crop', 'extend_corners'].includes(key), `${plugin.id}/${format.id}: unexpected key ${key}`);
    }
  }
});

test('catalog: shapes, patterns and examples', async () => {
  const { PLUGINS } = await load('catalog.js');
  for (const plugin of PLUGINS) {
    for (const key of ['displayName', 'shortDescription', 'imageSource', 'docsUrl']) assert.ok(typeof plugin[key] === 'string' && plugin[key], `${plugin.id}.${key}`);
    assert.ok(['ok', 'broken'].includes(plugin.status), `${plugin.id}.status`);
    if (plugin.status === 'broken') assert.ok(plugin.statusMessage, `${plugin.id}: broken plugins need a message`);
    else assert.equal(plugin.statusMessage, null);
    assert.equal(typeof plugin.producesDoubleSided, 'boolean');
    assert.equal(plugin.writesBackImages, false);
    assert.ok(plugin.formats.some((f) => f.id === plugin.defaultFormat), `${plugin.id}: defaultFormat`);
    assert.ok(Array.isArray(plugin.notes) && Array.isArray(plugin.keywords));
    for (const format of plugin.formats) {
      const where = `${plugin.id}/${format.id}`;
      assert.ok(['file', 'url', 'text_inline'].includes(format.inputKind), `${where}: inputKind`);
      for (const key of ['label', 'description', 'howToGet', 'example']) assert.ok(typeof format[key] === 'string' && format[key], `${where}.${key}`);
      if (format.inputKind === 'file') {
        assert.match(format.fileExtensionHint, /^\.[a-z0-9]+$/, `${where}: fileExtensionHint`);
        assert.ok(format.fileExtensions.includes(format.fileExtensionHint.slice(1)) && format.fileExtensions.includes('txt'), `${where}: fileExtensions`);
        assert.equal(format.pattern, undefined, `${where}: file formats have no pattern`);
      } else {
        assert.equal(format.fileExtensionHint, '');
        assert.ok(format.pattern, `${where}: url/text_inline formats carry the plugin's pattern`);
        const re = new RegExp(format.pattern);
        assert.ok(re.test(format.example.trim()), `${where}: example must match the pattern`);
        assert.ok(!/\n/.test(format.example), `${where}: one-line example`);
      }
    }
  }
});

test('catalog: verifier corrections are applied', async () => {
  const { getPlugin, getFormat, matchesFormatPattern, normalizeInlineValue } = await load('catalog.js');
  const elestrals = getFormat('elestrals', 'elestrals');
  assert.equal(elestrals.inputKind, 'text_inline');
  assert.equal(elestrals.pattern, '[0-9a-fA-F]{24}');
  assert.equal(elestrals.extract, true);
  assert.ok(matchesFormatPattern(elestrals, '6883b784bd9cf7315d565843'));
  assert.ok(!matchesFormatPattern(elestrals, 'https://play.elestrals.com/decks/'));
  assert.equal(normalizeInlineValue(elestrals, '  https://play.elestrals.com/decks/6883b784bd9cf7315d565843?x=1 '), '6883b784bd9cf7315d565843');

  const astra = getPlugin('echoes_of_astra');
  assert.equal(astra.status, 'broken');
  assert.match(astra.statusMessage, /broken/i);
  assert.match(getFormat('echoes_of_astra', 'astrabuilder_url').example, /deck=648$/);
  assert.equal(getPlugin('sorcery_contested_realm').status, 'broken');
});

test('catalog: helper functions', async () => {
  const c = await load('catalog.js');
  assert.equal(c.getPlugin('nope'), null);
  assert.equal(c.getPlugin(42), null);
  assert.equal(c.getFormat('mtg', 'nope'), null);
  assert.equal(c.getFormat('mtg', 'mtga').inputKind, 'file');
  assert.deepEqual(c.getRecommendedPdf('mtg', 'mpcfill_xml'), { card_size: 'standard', crop: '3mm' });
  assert.deepEqual(c.getRecommendedPdf('mtg', 'mtga'), { card_size: 'standard', crop: null });
  assert.deepEqual(c.getRecommendedPdf('yugioh'), { card_size: 'japanese' });
  assert.deepEqual(c.getRecommendedPdf('nope'), {});
  const rec = c.getRecommendedPdf('yugioh');
  rec.card_size = 'changed';
  assert.equal(c.getPlugin('yugioh').recommendedPdf.card_size, 'japanese', 'getRecommendedPdf returns a copy');
  assert.match(c.getRecommendedPdfNote('mtg', 'mpcfill_xml'), /bleed/);
  assert.equal(c.getDefaultFormat('mtg'), 'mtga');
  assert.equal(c.getDefaultFormat('mtg', 'moxfield'), 'moxfield');
  assert.equal(c.getDefaultFormat('mtg', 'ydk'), 'mtga');
  assert.equal(c.getDefaultFormat('nope'), null);
  assert.equal(c.getOptionsForFormat('mtg', 'mpcfill_xml').length, 0);
  assert.equal(c.getOptionsForFormat('mtg', 'mtga').length, 10);
  assert.deepEqual(c.getOptionsForFormat('lotr_lcg', 'ringsdb_url'), []);
  assert.equal(c.getOptionsForFormat('lotr_lcg', 'hallofbeorn_url')[0].name, 'scenario_mode');
  assert.equal(c.matchesFormatPattern(c.getFormat('mtg', 'mtga'), '1 Sol Ring'), true);
  assert.equal(c.matchesFormatPattern(c.getFormat('mtg', 'url'), '   '), false);
  assert.equal(c.matchesFormatPattern(c.getFormat('mtg', 'url'), 'https://example.com/deck/1'), false);
  assert.equal(c.matchesFormatPattern(c.getFormat('arkham_horror_lcg', 'arkhamdb_url'), ' https://arkhamdb.com/deck/view/42 '), true);
  assert.equal(c.normalizeInlineValue(c.getFormat('yugioh', 'ydke'), '  ydke://a!b!c!  '), 'ydke://a!b!c!');
  assert.deepEqual(c.searchPlugins('weiss').map((p) => p.id), ['bushiroad']);
  assert.ok(c.searchPlugins('POKEMON').some((p) => p.id === 'pokemon'));
  assert.ok(c.searchPlugins('magic gathering').some((p) => p.id === 'mtg'));
  assert.equal(c.searchPlugins('').length, c.PLUGINS.length);
});

test('catalog: plugin docs pages exist in hugo/content', { skip: SKIP_ENGINE }, async () => {
  const { PLUGINS } = await load('catalog.js');
  const { pluginDocsUrl } = await load('help.js');
  for (const plugin of PLUGINS) {
    assert.equal(plugin.docsUrl, pluginDocsUrl(plugin.id));
    assert.ok(fs.existsSync(path.join(HUGO_CONTENT, 'plugins', `${plugin.id}.md`)), `${plugin.id}: hugo page missing`);
  }
});

// ─── option-docs.js ───

test('option-docs: every create_pdf.py and offset_pdf.py option is documented, in CLI order', { skip: SKIP_ENGINE }, async () => {
  const { CREATE_PDF_OPTIONS, OFFSET_OPTIONS, OPTION_GROUPS } = await load('option-docs.js');
  const createOpts = parseClickOptions(read(path.join(ENGINE_DIR, 'create_pdf.py'))).map((o) => o.name);
  const offsetOpts = parseClickOptions(read(path.join(ENGINE_DIR, 'offset_pdf.py'))).map((o) => o.name);
  assert.deepEqual(Object.keys(CREATE_PDF_OPTIONS), createOpts);
  assert.deepEqual(Object.keys(OFFSET_OPTIONS), offsetOpts);
  const groups = new Set(OPTION_GROUPS.map((g) => g.id));
  for (const [table, docs] of [['create_pdf', CREATE_PDF_OPTIONS], ['offset_pdf', OFFSET_OPTIONS]]) {
    for (const [name, doc] of Object.entries(docs)) {
      const where = `${table}.${name}`;
      assert.equal(doc.name, name, where);
      assert.equal(doc.flag, `--${name}`, `${where}: flag`);
      for (const key of ['label', 'help', 'valueFormat', 'recommended']) assert.ok(typeof doc[key] === 'string' && doc[key], `${where}.${key}`);
      assert.ok(groups.has(doc.group), `${where}: group`);
      assert.equal(typeof doc.advanced, 'boolean', `${where}: advanced`);
      if (doc.choices) assert.equal(doc.choiceLabels.length, doc.choices.length, `${where}: choiceLabels`);
      if (doc.backsOf) assert.ok(docs[doc.backsOf], `${where}: backsOf`);
    }
  }
});

test('option-docs: engine defaults and choices match create_pdf.py / layouts.json', { skip: SKIP_ENGINE }, async () => {
  const { CREATE_PDF_OPTIONS: o, OFFSET_OPTIONS } = await load('option-docs.js');
  const layouts = JSON.parse(read(path.join(ENGINE_DIR, 'assets', 'layouts.json')));
  const src = read(path.join(ENGINE_DIR, 'create_pdf.py'));
  const opt = (name) => parseClickOptions(src).find((x) => x.name === name).args;
  assert.match(opt('ppi'), new RegExp(`default=${o.ppi.cliDefault}\\b`));
  assert.match(opt('quality'), new RegExp(`default=${o.quality.cliDefault}\\b`));
  assert.match(opt('card_size'), new RegExp(`default="${o.card_size.cliDefault}"`));
  assert.match(opt('paper_size'), new RegExp(`default="${o.paper_size.cliDefault}"`));
  assert.match(opt('front_dir_path'), /default=front_directory/);
  assert.equal(OFFSET_OPTIONS.ppi.cliDefault, 300);
  assert.deepEqual([...o.specialty.choices].sort(), Object.keys(layouts.specialty_layouts).sort());
  const utilities = read(path.join(ENGINE_DIR, 'utilities.py'));
  const enums = read(path.join(ENGINE_DIR, 'enums.py'));
  const enumValues = (name) => (parseEnum(utilities, name).length ? parseEnum(utilities, name) : parseEnum(enums, name)).map((e) => e.value);
  assert.deepEqual(o.fit.choices, enumValues('FitMode'));
  assert.deepEqual(o.registration.choices, enumValues('Registration'));
  assert.deepEqual(o.registration_orientation.choices, enumValues('Orientation'));
  assert.equal(o.registration.cliDefault, '3');
  assert.equal(o.fit.cliDefault, 'stretch');
  assert.equal(o.ppi.min, 1);
  assert.equal(o.ppi.max, 2400);
  assert.deepEqual([o.quality.min, o.quality.max], [0, 100]);
});

test('option-docs: spec §8.4 labels and units', async () => {
  const { CREATE_PDF_OPTIONS: o, LENGTH_UNITS } = await load('option-docs.js');
  assert.equal(o.borderless.label, 'Tight layout (fits more cards; special mat placement)');
  assert.equal(o.extend_corners.label, 'Fill rounded corners');
  assert.equal(o.extend_edges.label, 'Trim thin edge lines');
  assert.equal(o.extend_bleed.label, 'Extra outer bleed');
  assert.equal(o.crop.label, 'Trim image edges');
  assert.equal(o.skip.label, 'Leave slot empty');
  assert.equal(o.load_offset.label, 'Apply my printer alignment');
  assert.equal(o.label.label, 'Text printed on each sheet');
  assert.equal(o.output_images.label, 'Make PNG images instead of a PDF');
  assert.equal(o.fit.label, 'Image shape');
  assert.deepEqual(o.fit.choiceLabels, ['Stretch', 'Crop']);
  assert.equal(o.registration.label, 'Registration marks (the corner marks your machine scans before cutting)');
  assert.deepEqual(LENGTH_UNITS.crop, ['mm', 'in', '%']);
  assert.deepEqual(LENGTH_UNITS.extend, ['mm', 'in', 'px']);
  for (const name of ['crop', 'crop_backs']) assert.deepEqual(o[name].units, ['mm', 'in', '%'], name);
  for (const name of ['extend_edges', 'extend_edges_backs', 'extend_corners', 'extend_corners_backs', 'extend_bleed', 'extend_bleed_backs']) {
    assert.deepEqual(o[name].units, ['mm', 'in', 'px'], name);
    assert.equal(o[name].kind, 'length', name);
  }
});

test('option-docs: CARD_SIZES and PAPER_SIZES match assets/layouts.json', { skip: SKIP_ENGINE }, async () => {
  const d = await load('option-docs.js');
  const layouts = JSON.parse(read(path.join(ENGINE_DIR, 'assets', 'layouts.json')));
  assert.deepEqual(d.CARD_SIZES.map((c) => c.name).sort(), Object.keys(layouts.card_sizes).sort());
  for (const size of d.CARD_SIZES) {
    const def = layouts.card_sizes[size.name];
    assert.ok(close(size.widthMm, toMm(def.width)) && close(size.heightMm, toMm(def.height)), `${size.name}: dimensions`);
    assert.deepEqual(size.aliases, def.aliases || [], `${size.name}: aliases`);
    assert.equal(size.landscape, size.widthMm > size.heightMm, `${size.name}: landscape flag`);
    assert.ok(size.label && size.dimensions && size.games, `${size.name}: text`);
  }
  assert.deepEqual(d.PAPER_SIZES.map((p) => p.name).sort(), Object.keys(layouts.paper_sizes).sort());
  for (const paper of d.PAPER_SIZES) {
    const def = layouts.paper_sizes[paper.name];
    const [a, b] = [toMm(def.width), toMm(def.height)].sort((x, y) => x - y);
    assert.ok(close(paper.widthMm, a) && close(paper.heightMm, b), `${paper.name}: dimensions`);
    assert.deepEqual(paper.aliases, def.aliases || [], `${paper.name}: aliases`);
    const calibration = fs.existsSync(path.join(ENGINE_DIR, 'calibration', `${paper.name}-calibration.pdf`));
    assert.equal(paper.calibrationIncluded, calibration, `${paper.name}: calibrationIncluded`);
    const tightTemplates = fs.existsSync(path.join(ENGINE_DIR, 'cutting_templates', 'borderless'))
      && fs.readdirSync(path.join(ENGINE_DIR, 'cutting_templates', 'borderless')).some((f) => f.startsWith(`${paper.name}-`) && f.endsWith('.studio3'));
    assert.equal(paper.tightLayout, tightTemplates, `${paper.name}: tightLayout`);
  }
  assert.equal(d.resolveCardSize('EURO_POKER'), 'standard');
  assert.equal(d.resolveCardSize('mini_american'), 'american_mini');
  assert.equal(d.resolvePaperSize('ansi_a'), 'letter');
  assert.equal(d.resolveCardSize('bogus'), null);
  assert.equal(d.describeCardSize('photo'), 'Business card (EU) / photocard (85 x 55 mm)');
});

test('option-docs: presets, machines and helpers', async () => {
  const d = await load('option-docs.js');
  assert.deepEqual(d.PPI_PRESETS.map((p) => [p.value, p.label]), [[300, 'Standard'], [600, 'High'], [1200, 'Very high'], [1440, 'Maximum']]);
  assert.deepEqual(d.MACHINES.map((m) => m.id), ['cameo5alpha', 'cameo5', 'cameo4', 'portrait', 'other']);
  assert.equal(d.registrationForMachine('cameo5alpha'), '4');
  for (const id of ['cameo5', 'cameo4', 'portrait', 'other', null, 'unknown']) assert.equal(d.registrationForMachine(id), '3', String(id));
  assert.equal(d.registrationFitsMachine('cameo5alpha', '3'), true);
  assert.equal(d.registrationFitsMachine('cameo4', '4'), false);
  assert.equal(d.registrationFitsMachine(null, '4'), true);
  assert.equal(d.studioMachineFor('cameo5alpha', '3'), 'Cameo 5');
  assert.equal(d.studioMachineFor('cameo5alpha', '4'), 'Cameo 5 Alpha');
  assert.deepEqual(d.getMachine('portrait').supportedPapers, ['letter', 'a4']);
  assert.equal(d.defaultPaperForCountry('us'), 'letter');
  assert.equal(d.defaultPaperForCountry('PR'), 'letter');
  assert.equal(d.defaultPaperForCountry('FR'), 'a4');
  assert.equal(d.defaultPaperForCountry(null), 'a4');
  assert.equal(d.fillPlaceholders('{paper} / {missing}', { paper: 'A4' }), 'A4 / {missing}');
  assert.equal(d.getOptionDoc('angle', 'offset_pdf').kind, 'float');
  assert.equal(d.getOptionDoc('toString'), null);
  assert.ok(d.CALIBRATION_STEPS.length >= 4 && d.REGISTRATION_HELP.troubleshooting.length > 0);
  for (const section of ['print', 'check', 'cut', 'finish']) {
    assert.ok(d.PRINT_TIPS[section].length > 0, section);
    for (const tip of d.PRINT_TIPS[section]) assert.ok(['always', 'twoSided', 'tight', 'largePaper', 'threeMarks', 'fourMarks'].includes(tip.when), tip.id);
  }
});

test('copy rule: user-facing text never shows raw command-line flags', async () => {
  const catalog = await load('catalog.js');
  const docs = await load('option-docs.js');
  const models = await load('models.js');
  const help = await load('help.js');
  // Keys holding identifiers, flags, regexes, URLs or option-name references (not shown as prose).
  const skip = new Set(['flag', 'pattern', 'example', 'url', 'docsUrl', 'name', 'choices', 'id', 'source', 'backsOf',
    'onlyForFormats', 'defaultFormat', 'recommendedCardSize', 'fileExtensions', 'fileExtensionHint', 'keywords']);
  const texts = [
    ...userFacingStrings(catalog.PLUGINS, skip),
    ...userFacingStrings({ ...docs }, skip),
    ...userFacingStrings(models.UPSCAYL_MODELS, skip),
    ...userFacingStrings(help.HELP_LINKS, skip),
  ];
  assert.ok(texts.length > 300);
  const offenders = texts.filter((t) => /(^|\s)--[a-z]/.test(t.text) || /\b(?:only_fronts|load_offset|extend_corners|show_outline)\b/.test(t.text));
  assert.deepEqual(offenders, []);
});

// ─── models.js ───

test('models: the 7 Upscayl built-in models', async () => {
  const m = await load('models.js');
  assert.deepEqual(m.UPSCAYL_MODELS.map((x) => x.id).sort(), [
    'digital-art-4x', 'high-fidelity-4x', 'remacri-4x', 'ultramix-balanced-4x', 'ultrasharp-4x', 'upscayl-lite-4x', 'upscayl-standard-4x',
  ]);
  assert.deepEqual([...m.NON_COMMERCIAL_MODEL_IDS].sort(), ['remacri-4x', 'ultramix-balanced-4x', 'ultrasharp-4x']);
  assert.equal(m.DEFAULT_MODEL_ID, 'upscayl-standard-4x');
  assert.equal(m.UPSCAYL_MODELS[0].id, m.DEFAULT_MODEL_ID);
  for (const model of m.UPSCAYL_MODELS) assert.ok(model.displayName && model.description && model.recommendedFor, model.id);
  assert.equal(m.modelScale('realesr-animevideov3-x2'), 2);
  assert.equal(m.modelScale('4x_NMKD-Siax_200k'), 4);
  assert.equal(m.modelScale('something'), 4);
  assert.equal(m.modelDisplayName('4x_NMKD-Siax_200k'), '4x NMKD Siax 200k');
  const described = m.describeModels([{ id: 'zz-x2', custom: true, scale: 2 }, { id: 'remacri-4x', scale: 4 }, { id: 'upscayl-standard-4x', scale: 4 }]);
  assert.deepEqual(described.map((x) => x.id), ['upscayl-standard-4x', 'remacri-4x', 'zz-x2']);
  assert.equal(described[1].nonCommercial, true);
  assert.equal(described[2].custom, true);
  assert.deepEqual(m.describeModels(null), []);
});

test('models: ids match an installed Upscayl when one is present', {
  skip: fs.existsSync('D:\\Tools\\Upscaly\\Upscayl\\resources\\models') ? false : 'no local Upscayl install at the reference path',
}, async () => {
  const m = await load('models.js');
  const files = fs.readdirSync('D:\\Tools\\Upscaly\\Upscayl\\resources\\models');
  for (const model of m.UPSCAYL_MODELS) {
    assert.ok(files.includes(`${model.id}.param`) && files.includes(`${model.id}.bin`), model.id);
  }
});

// ─── help.js ───

const ICONS_FILE = path.join(APP_DIR, 'src', 'renderer', 'js', 'core', 'icons.js');

test('help: suggested icons exist in the UI icon set', { skip: fs.existsSync(ICONS_FILE) ? false : 'icons.js not present' }, async () => {
  const h = await load('help.js');
  const { iconMarkup } = await import(pathToFileURL(ICONS_FILE).href);
  for (const link of h.HELP_LINKS) assert.ok(iconMarkup(link.icon), `${link.id}: unknown icon "${link.icon}"`);
});

/** Map a documentation-site URL to the Hugo content file that produces it. */
function contentFileForUrl(url, siteUrl) {
  const rel = url.slice(siteUrl.length).split('#')[0].replace(/^\/+|\/+$/g, '');
  if (!rel) return '_index.md';
  const asSection = path.join(rel, '_index.md');
  if (fs.existsSync(path.join(HUGO_CONTENT, asSection))) return asSection.split(path.sep).join('/');
  return `${rel}.md`;
}

test('help: documentation links point at existing Hugo pages', { skip: SKIP_ENGINE }, async () => {
  const h = await load('help.js');
  const ids = h.HELP_LINKS.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, 'duplicate help ids');
  for (const id of h.HELP_MENU) assert.ok(h.getHelpLink(id), `menu id ${id}`);
  assert.deepEqual(h.helpMenuLinks().map((l) => l.label), ['Tutorial', 'Troubleshooting', 'Supply list', 'Discord', 'Project website', 'Check for updates']);
  for (const link of h.HELP_LINKS) {
    assert.ok(h.isHttpUrl(link.url), `${link.id}: http(s)`);
    if (link.url.startsWith(h.SITE_URL)) {
      const file = contentFileForUrl(link.url, h.SITE_URL);
      assert.equal(link.source, file, `${link.id}: source`);
      assert.ok(fs.existsSync(path.join(HUGO_CONTENT, file)), `${link.id}: ${file} missing`);
      const anchor = link.url.split('#')[1];
      if (anchor) {
        const headings = read(path.join(HUGO_CONTENT, file)).split(/\r?\n/).filter((l) => /^#{1,6}\s/.test(l))
          .map((l) => l.replace(/^#+\s*/, '').trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-'));
        assert.ok(headings.includes(anchor), `${link.id}: heading for #${anchor}`);
      }
    } else {
      assert.equal(link.source, null, `${link.id}: external links have no source`);
    }
  }
  const readme = read(path.join(ENGINE_DIR, 'README.md'));
  assert.ok(readme.includes(h.DISCORD_URL), 'Discord invite matches README');
  assert.ok(readme.includes(h.SITE_URL), 'site URL matches README');
  const hugoConfig = read(path.join(ENGINE_DIR, 'hugo', 'hugo.yaml'));
  assert.ok(hugoConfig.includes(h.REPO_URL), 'repo URL matches hugo.yaml');
  assert.equal(h.getHelpLink('tutorial').url, 'https://alan-cha.github.io/silhouette-card-maker/tutorial/');
  assert.equal(h.pluginDocsUrl('../x'), `${h.SITE_URL}/plugins/x/`);
  assert.equal(h.isHttpUrl('javascript:alert(1)'), false);
});

// Runs without the engine: these links belong to Kirigami itself, not to the upstream project.
test('help: app updates and problem reports go to the Kirigami repository', async () => {
  const h = await load('help.js');
  const pkg = JSON.parse(read(path.join(APP_DIR, 'package.json')));
  assert.equal(h.APP_REPO_URL, 'https://github.com/mtgtoolkit/kirigami');
  assert.equal(pkg.homepage, h.APP_REPO_URL, 'package.json homepage');
  assert.equal(pkg.repository.url, `${h.APP_REPO_URL}.git`, 'package.json repository');
  assert.notEqual(h.APP_REPO_URL, h.REPO_URL, 'app and engine repositories are separate');
  assert.equal(h.getHelpLink('updates').url, `${h.APP_REPO_URL}/releases`);
  assert.equal(h.getHelpLink('issues').url, `${h.APP_REPO_URL}/issues`);
  assert.equal(h.getHelpLink('repo').url, h.REPO_URL, 'the source code link stays on the engine');
  // The renderer's built-in Help menu fallback (used when help.js cannot be loaded) must agree.
  const rendererMain = read(path.join(APP_DIR, 'src', 'renderer', 'js', 'main.js'));
  assert.ok(rendererMain.includes(`updates: '${h.APP_REPO_URL}/releases',`), 'renderer main.js HELP_FALLBACK.updates');
});
