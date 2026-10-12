'use strict';

// Unit tests for the pure renderer modules: core/format.js, core/store.js, core/router.js (hash
// helpers), core/ui.js (length helpers + export surface) and core/icons.js. These modules are ES
// modules (src/renderer/package.json has "type": "module"), loaded here with dynamic import().

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer', 'js');
const load = (rel) => import(pathToFileURL(path.join(RENDERER, rel)).href);
const ws = (s) => String(s).replace(/\s/g, ' ');

describe('core/format', () => {
  let f;
  before(async () => {
    f = await load('core/format.js');
  });

  it('formatBytes uses binary units with friendly rounding', () => {
    assert.equal(f.formatBytes(0), '0 B');
    assert.equal(f.formatBytes(512), '512 B');
    assert.equal(f.formatBytes(1024), '1 KB');
    assert.equal(f.formatBytes(1536), '1.5 KB');
    assert.equal(f.formatBytes(601e6), '573 MB');
    assert.equal(f.formatBytes(4.2 * 1024 ** 3), '4.2 GB');
    assert.equal(f.formatBytes(11 * 1024 ** 3), '11 GB');
    assert.equal(f.formatBytes(1023.7 * 1024), '1 MB', 'rounds up into the next unit');
    assert.equal(f.formatBytes(-2048), '-2 KB');
    assert.equal(f.formatBytes(15 * 1024 ** 2, { decimals: 2 }), '15.00 MB');
    assert.equal(f.formatBytes('2048'), '2 KB');
    for (const bad of [null, undefined, '', 'abc', NaN, Infinity, true]) assert.equal(f.formatBytes(bad), '—');
  });

  it('formatDuration exact and approximate styles', () => {
    assert.equal(f.formatDuration(0), '0 s');
    assert.equal(f.formatDuration(400), '0.4 s');
    assert.equal(f.formatDuration(999), '1 s');
    assert.equal(f.formatDuration(45_000), '45 s');
    assert.equal(f.formatDuration(59_600), '1 min');
    assert.equal(f.formatDuration(125_000), '2 min 5 s');
    assert.equal(f.formatDuration(180_000), '3 min');
    assert.equal(f.formatDuration(3_600_000), '1 h');
    assert.equal(f.formatDuration(4_800_000), '1 h 20 min');
    assert.equal(f.formatDuration(30_000, { approximate: true }), 'less than a minute');
    assert.equal(f.formatDuration(150_000, { approximate: true }), 'about 3 min');
    assert.equal(f.formatDuration(4_800_000, { approximate: true }), 'about 1 h 20 min');
    assert.equal(f.formatDuration(7_200_000, { approximate: true }), 'about 2 h');
    for (const bad of [-5, null, undefined, 'x', NaN]) assert.equal(f.formatDuration(bad), '—');
  });

  it('formatClock has a stable stopwatch format', () => {
    assert.equal(f.formatClock(5_000), '0:05');
    assert.equal(f.formatClock(754_000), '12:34');
    assert.equal(f.formatClock(3_723_000), '1:02:03');
    assert.equal(f.formatClock(null), '0:00');
    assert.equal(f.formatClock(-10), '0:00');
  });

  it('formatNumber groups thousands and limits decimals', () => {
    assert.equal(f.formatNumber(1234), '1,234');
    assert.equal(f.formatNumber(12.345), '12.35');
    assert.equal(f.formatNumber(1234.5, { decimals: 2 }), '1,234.50');
    assert.equal(ws(f.formatNumber(1234.5, { locale: 'de-DE' })), '1.234,5');
    assert.equal(f.formatNumber(NaN), '—');
    assert.equal(f.formatNumber(null), '—');
  });

  it('pluralize derives English plurals', () => {
    assert.equal(f.pluralize(1, 'card'), '1 card');
    assert.equal(f.pluralize(2, 'card'), '2 cards');
    assert.equal(f.pluralize(0, 'card'), '0 cards');
    assert.equal(f.pluralize(3, 'copy'), '3 copies');
    assert.equal(f.pluralize(2, 'day'), '2 days');
    assert.equal(f.pluralize(2, 'box'), '2 boxes');
    assert.equal(f.pluralize(2, 'batch'), '2 batches');
    assert.equal(f.pluralize(1234, 'card'), '1,234 cards');
    assert.equal(f.pluralize(5, 'person', 'people'), '5 people');
    assert.equal(f.pluralize(1, 'person', 'people'), '1 person');
    assert.equal(f.pluralize(2, 'card', { includeCount: false }), 'cards');
    assert.equal(f.pluralize(2, 'person', 'people', { includeCount: false }), 'people');
  });

  it('quoteArg quotes only when needed, with Windows escaping', () => {
    assert.equal(f.quoteArg('game/front'), 'game/front');
    assert.equal(f.quoteArg('--ppi=1440'), '--ppi=1440');
    assert.equal(f.quoteArg('C:\\Users\\me\\deck.txt'), 'C:\\Users\\me\\deck.txt');
    assert.equal(f.quoteArg('my deck.txt'), '"my deck.txt"');
    assert.equal(f.quoteArg(''), '""');
    assert.equal(f.quoteArg(null), '""');
    assert.equal(f.quoteArg('say "hi"'), '"say \\"hi\\""');
    assert.equal(f.quoteArg('C:\\with space\\'), '"C:\\with space\\\\"');
    assert.equal(f.quoteArg('Mise à jour'), '"Mise à jour"');
    assert.equal(f.quoteArg(1440), '1440');
  });

  it('escapeHtml escapes the five special characters', () => {
    assert.equal(f.escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(f.escapeHtml(null), '');
  });

  it('formatDate words dates relative to now', () => {
    const now = Date.UTC(2026, 9, 3, 15, 0); // Saturday 3 Oct 2026, 15:00 UTC
    const opts = { now, locale: 'en-US', timeZone: 'UTC' };
    assert.equal(ws(f.formatDate(Date.UTC(2026, 9, 3, 14, 32), opts)), 'today at 2:32 PM');
    assert.equal(ws(f.formatDate(new Date(Date.UTC(2026, 9, 2, 9, 10)), opts)), 'yesterday at 9:10 AM');
    assert.equal(ws(f.formatDate(Date.UTC(2026, 8, 29, 16, 0), opts)), 'Tuesday at 4:00 PM');
    assert.equal(ws(f.formatDate(Date.UTC(2026, 6, 4, 8, 5), opts)), 'Jul 4, 8:05 AM');
    assert.equal(ws(f.formatDate(new Date(Date.UTC(2025, 9, 3, 8, 5)).toISOString(), opts)), 'Oct 3, 2025');
    assert.equal(f.formatDate(Date.UTC(2026, 9, 3, 14, 32), { ...opts, dateOnly: true }), 'today');
    assert.equal(ws(f.formatDate(Date.UTC(2026, 9, 3, 14, 32), { ...opts, absolute: true })), 'Oct 3, 2:32 PM');
    assert.equal(f.formatDate('not a date', opts), '—');
    assert.equal(f.formatDate(null, opts), '—');
  });

  it('errorCode recovers codes from bridge errors', () => {
    assert.equal(f.errorCode(new Error('BUSY: wait until "Make PDF" finishes')), 'BUSY');
    assert.equal(f.errorCode(new Error('NOT_READY')), 'NOT_READY');
    assert.equal(f.errorCode({ code: 'NETWORK', message: 'x' }), 'NETWORK');
    assert.equal(f.errorCode(new Error("Error invoking remote method 'x': Error: BUSY: Make PDF")), 'BUSY');
    assert.equal(f.errorCode(new Error('PermissionError: [Errno 13]')), null);
    assert.equal(f.errorCode(new Error('HTTP 404 not found')), null);
    assert.equal(f.errorCode(null), null);
  });

  it('errorMessage gives one plain sentence', () => {
    assert.equal(f.errorMessage(new Error('BUSY: wait until "Make PDF" finishes')), 'Please wait until "Make PDF" finishes.');
    assert.equal(f.errorMessage(new Error('BUSY: Make PDF')), 'Please wait until "Make PDF" finishes.');
    assert.equal(f.errorMessage(new Error('BUSY:')), 'Please wait until the current task finishes.');
    assert.match(f.errorMessage(new Error('NOT_READY')), /setting up/i);
    assert.equal(f.errorMessage(new Error("Error invoking remote method 'cards:add': Error: Save the image to your computer first")), 'Save the image to your computer first');
    assert.equal(f.errorMessage({ message: 'Your computer ran out of memory.', code: 'OUT_OF_MEMORY' }), 'Your computer ran out of memory.');
    assert.equal(f.errorMessage({ userMessage: 'Already friendly.' }), 'Already friendly.');
    assert.equal(f.errorMessage('plain text'), 'Plain text');
    assert.equal(f.errorMessage(null), 'Something went wrong.');
    assert.equal(f.errorMessage('', 'Fallback'), 'Fallback');
  });
});

describe('core/store', () => {
  let s;
  before(async () => {
    s = await load('core/store.js');
  });

  it('get/set/update/subscribe with unsubscribe and wildcard', () => {
    const store = s.createStore({ a: 1 });
    const calls = [];
    const all = [];
    const off = store.subscribe('a', (v, prev, key) => calls.push([v, prev, key]));
    store.subscribe('*', (v, prev, key) => all.push(key));
    assert.equal(store.get('a'), 1);
    store.set('a', 2);
    store.set('a', 2); // identical primitive: no notification
    store.update('a', (v) => v + 1);
    off();
    store.set('a', 10);
    store.set('b', 'x');
    assert.deepEqual(calls, [[2, 1, 'a'], [3, 2, 'a']]);
    assert.deepEqual(all, ['a', 'a', 'a', 'b']);
    assert.deepEqual(store.snapshot(), { a: 10, b: 'x' });
  });

  it('objects always notify (in-place mutation + set) and immediate subscription', () => {
    const obj = { n: 1 };
    const store = s.createStore({ o: obj });
    let count = 0;
    let seen = null;
    store.subscribe('o', (v) => { count += 1; seen = v; }, { immediate: true });
    assert.equal(count, 1);
    obj.n = 2;
    store.set('o', obj);
    assert.equal(count, 2);
    assert.equal(seen.n, 2);
  });

  it('a throwing subscriber does not stop the others', () => {
    const errors = [];
    const store = s.createStore({}, { onError: (err, key) => errors.push([err.message, key]) });
    const got = [];
    store.subscribe('k', () => { throw new Error('boom'); });
    store.subscribe('k', (v) => got.push(v));
    store.set('k', 5);
    assert.deepEqual(got, [5]);
    assert.deepEqual(errors, [['boom', 'k']]);
  });

  it('rejects bad arguments', () => {
    const store = s.createStore();
    assert.throws(() => store.set('', 1), TypeError);
    assert.throws(() => store.subscribe('a', null), TypeError);
    assert.throws(() => store.update('a', 1), TypeError);
  });

  it('reduceJobEvent: started → step → progress → log → finished', () => {
    let job = s.reduceJobEvent(null, {
      type: 'started', jobId: 7, kind: 'pdf', title: 'Make PDF', startedAt: 1000,
      steps: [{ id: 'prepare', label: 'Preparing', status: 'pending' }, { id: 'render', label: 'Rendering', status: 'pending' }],
    });
    assert.equal(job.jobId, '7');
    assert.equal(job.status, 'running');
    assert.equal(job.steps.length, 2);
    assert.equal(job.startedAt, 1000);
    job = s.reduceJobEvent(job, { type: 'step', jobId: 7, stepId: 'prepare', status: 'running' });
    assert.equal(s.currentStep(job).step.id, 'prepare');
    job = s.reduceJobEvent(job, { type: 'step', jobId: 7, stepId: 'prepare', status: 'done' });
    job = s.reduceJobEvent(job, { type: 'step', jobId: 7, stepId: 'render', status: 'running', label: 'Rendering part 1/2' });
    assert.deepEqual(s.currentStep(job), { step: { id: 'render', label: 'Rendering part 1/2', status: 'running' }, index: 1, total: 2 });
    job = s.reduceJobEvent(job, { type: 'step', jobId: 7, stepId: 'merge', status: 'pending', label: 'Joining' });
    assert.equal(job.steps.length, 3, 'unknown step ids are appended');
    job = s.reduceJobEvent(job, { type: 'progress', jobId: 7, percent: 145, current: 3, total: 62, label: 'Card 3 of 62' });
    assert.deepEqual(job.progress, { percent: 100, current: 3, total: 62, label: 'Card 3 of 62' });
    job = s.reduceJobEvent(job, { type: 'progress', jobId: 7, percent: null, label: 'Saving…' });
    assert.equal(job.progress.percent, null);
    const lines = (n, from) => Array.from({ length: n }, (_, i) => ({ stream: 'stdout', line: `line ${from + i}`, ts: i }));
    job = s.reduceJobEvent(job, { type: 'log', jobId: 7, lines: lines(2, 1) }, { maxLines: 3 });
    job = s.reduceJobEvent(job, { type: 'log', jobId: 7, lines: [...lines(2, 3), 'plain string line'] }, { maxLines: 3 });
    assert.deepEqual(job.logLines.map((l) => l.line), ['line 3', 'line 4', 'plain string line']);
    assert.equal(job.logTotal, 5);
    const sameRef = s.reduceJobEvent(job, { type: 'log', jobId: 7, lines: [] });
    assert.equal(sameRef, job, 'empty log batches keep the same object');
    job = s.reduceJobEvent(job, {
      type: 'finished', jobId: 7, kind: 'pdf', status: 'succeeded', result: { pdfPath: 'x.pdf' }, error: null,
      warnings: ['Offset cannot be applied', { message: 'Ignoring skip indices' }, 42], endedAt: 9000, durationMs: 8000,
    });
    assert.equal(job.status, 'succeeded');
    assert.deepEqual(job.warnings, ['Offset cannot be applied', 'Ignoring skip indices']);
    assert.equal(job.durationMs, 8000);
    assert.equal(job.dismissed, false);
  });

  it('reduceJobEvent: events for an unknown job create a placeholder needing sync', () => {
    const prev = s.jobFromStarted({ jobId: '1', kind: 'fetch', title: 'Old' });
    const job = s.reduceJobEvent(prev, { type: 'progress', jobId: '2', percent: 10 });
    assert.equal(job.jobId, '2');
    assert.equal(job.needsSync, true);
    assert.equal(job.progress.percent, 10);
    assert.equal(s.reduceJobEvent(prev, { type: 'log' }), prev, 'events without jobId are ignored');
    const finished = s.reduceJobEvent(null, { type: 'finished', jobId: '3', status: 'weird' });
    assert.equal(finished.status, 'failed', 'unknown final status counts as failed');
  });

  it('jobFromSummary normalizes summaries and seeds the log', () => {
    const job = s.jobFromSummary({ id: 5, kind: 'upscale', title: 'Upscale', status: 'running', startedAt: 1, progress: { percent: 12, label: 'x' } }, 'a\r\nb\nc\n');
    assert.equal(job.jobId, '5');
    assert.deepEqual(job.logLines.map((l) => l.line), ['a', 'b', 'c']);
    assert.equal(job.logTotal, 3);
    assert.equal(job.progress.percent, 12);
    assert.equal(s.jobFromSummary(null), null);
    assert.equal(s.jobFromSummary({ title: 'no id' }), null);
    assert.equal(s.jobFromSummary({ jobId: 1, status: 'bogus' }).status, 'running');
  });
});

describe('core/router hash helpers', () => {
  let r;
  before(async () => {
    r = await load('core/router.js');
  });

  it('parseHash', () => {
    assert.deepEqual(r.parseHash('#/pdf?tab=more&x=1'), { id: 'pdf', params: { tab: 'more', x: '1' } });
    assert.deepEqual(r.parseHash('#/cards'), { id: 'cards', params: {} });
    assert.deepEqual(r.parseHash('#/cards/'), { id: 'cards', params: {} });
    assert.deepEqual(r.parseHash('#cards'), { id: 'cards', params: {} });
    assert.deepEqual(r.parseHash(''), { id: '', params: {} });
    assert.deepEqual(r.parseHash('#/'), { id: '', params: {} });
    assert.deepEqual(r.parseHash('#/fetch?deck=my%20deck'), { id: 'fetch', params: { deck: 'my deck' } });
  });

  it('buildHash round-trips and skips null params', () => {
    assert.equal(r.buildHash('fetch'), '#/fetch');
    assert.equal(r.buildHash('pdf', { tab: 'more', n: null, u: undefined }), '#/pdf?tab=more');
    const hash = r.buildHash('fetch', { deck: 'my deck & co', n: 3 });
    assert.deepEqual(r.parseHash(hash), { id: 'fetch', params: { deck: 'my deck & co', n: '3' } });
  });

  it('registerView validates its input', () => {
    assert.throws(() => r.registerView({}), TypeError);
    assert.throws(() => r.registerView({ id: 'x' }), TypeError);
    r.registerView({ id: 'unit-test-view', title: 'Unit', load: async () => ({}) });
    assert.equal(r.hasView('unit-test-view'), true);
    assert.equal(r.currentRoute(), null);
  });
});

describe('core/ui (pure parts)', () => {
  let ui;
  before(async () => {
    ui = await load('core/ui.js');
  });

  it('exports every UI-kit function required by the spec', () => {
    const required = ['h', 'icon', 'button', 'field', 'select', 'toggle', 'checkbox', 'radioCards', 'segmented', 'textInput',
      'numberInput', 'lengthInput', 'textArea', 'chipsInput', 'multiSelectChips', 'section', 'card', 'badge', 'tabs',
      'progressBar', 'emptyState', 'callout', 'helpTip', 'toast', 'confirmDialog', 'modal', 'spinner', 'clear', 'mountInto', 'copyText'];
    for (const name of required) assert.equal(typeof ui[name], 'function', `ui.${name}`);
  });

  it('parseLengthValue splits engine length strings', () => {
    assert.deepEqual(ui.parseLengthValue('2mm', ['mm', 'in', 'px']), { number: '2', unit: 'mm', valid: true });
    assert.deepEqual(ui.parseLengthValue('0.5in', ['mm', 'in', 'px']), { number: '0.5', unit: 'in', valid: true });
    assert.deepEqual(ui.parseLengthValue('2.50mm', ['mm', 'in']), { number: '2.5', unit: 'mm', valid: true });
    assert.deepEqual(ui.parseLengthValue('3', ['mm', 'in', '%']), { number: '3', unit: '%', valid: true });
    assert.deepEqual(ui.parseLengthValue('3', ['mm', 'in', 'px']), { number: '3', unit: 'px', valid: true });
    assert.deepEqual(ui.parseLengthValue('12px', ['mm', 'in', 'px']), { number: '12', unit: 'px', valid: true });
    assert.deepEqual(ui.parseLengthValue(null, ['mm', 'in']), { number: '', unit: 'mm', valid: true });
    assert.equal(ui.parseLengthValue('3', ['mm', 'in']).valid, false, 'bare number without a bare unit');
    assert.equal(ui.parseLengthValue('abc', ['mm']).valid, false);
    assert.equal(ui.parseLengthValue('-2mm', ['mm']).valid, false);
  });

  it('formatLengthValue builds engine strings (bare numbers for % and px)', () => {
    assert.equal(ui.formatLengthValue('2', 'mm'), '2mm');
    assert.equal(ui.formatLengthValue('0,5', 'in'), '0.5in');
    assert.equal(ui.formatLengthValue('3', '%'), '3');
    assert.equal(ui.formatLengthValue('12', 'px'), '12');
    assert.equal(ui.formatLengthValue('1.', 'mm'), '1mm');
    assert.equal(ui.formatLengthValue('.5', 'mm'), '0.5mm');
    assert.equal(ui.formatLengthValue('2.123456', 'mm'), '2.1235mm');
    assert.equal(ui.formatLengthValue('  ', 'mm'), null);
    assert.equal(ui.formatLengthValue('', 'mm'), null);
    for (const bad of ['-1', '1e3', '2 mm', 'x', '1.2.3']) assert.equal(ui.formatLengthValue(bad, 'mm'), undefined, bad);
  });
});

describe('core/icons', () => {
  it('provides every icon the views rely on', async () => {
    const { iconMarkup, iconNames } = await load('core/icons.js');
    const required = ['download', 'images', 'sparkles', 'file-pdf', 'file-text', 'printer', 'scissors', 'crosshair', 'settings',
      'help', 'check', 'x', 'alert-triangle', 'info', 'trash', 'undo', 'plus', 'minus', 'copy', 'folder-open', 'external-link',
      'refresh', 'search', 'chevron-up', 'chevron-down', 'chevron-left', 'chevron-right', 'eye', 'grid', 'layers', 'cpu', 'play',
      'square', 'stop', 'clock', 'moon', 'sun', 'monitor', 'upload', 'link', 'file', 'wand'];
    for (const name of required) assert.ok(iconMarkup(name), name);
    assert.ok(iconMarkup('upscale'), 'aliases resolve');
    assert.equal(iconMarkup('definitely-not-an-icon'), null);
    assert.ok(iconNames().length >= required.length);
  });
});
