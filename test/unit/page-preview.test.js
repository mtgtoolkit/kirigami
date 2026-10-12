'use strict';

// Geometry tests for src/renderer/js/components/page-preview.js (pure helpers only).
// Expected positions follow spec §1 / utilities.py: portrait layouts are drawn portrait and rotated
// 90° counter-clockwise into the landscape PDF, so skip index 0 ends at the bottom-left.
// Layout objects below are real values computed with the engine (page_manager.generate_layout).
// When test/fixtures/introspection.json exists, invariants are checked for every layout in it.

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MODULE = path.join(__dirname, '..', '..', 'src', 'renderer', 'js', 'components', 'page-preview.js');
const FIXTURE = path.join(__dirname, '..', 'fixtures', 'introspection.json');

const LETTER_STANDARD = {
  key: 'letter|standard|default', variant: 'default', orientation: 'landscape', registrationOrientation: 'landscape', rows: 2, cols: 4,
  xPos: [140, 899, 1658, 2417], yPos: [228, 1282], cardWidthPx: 744, cardHeightPx: 1039, paperWidthPx: 3300, paperHeightPx: 2550,
  inset: '10mm', thickness: '1mm', length: '8.04mm',
};
const LETTER_TAROT = {
  key: 'letter|tarot|default', variant: 'default', orientation: 'portrait', registrationOrientation: 'portrait', rows: 2, cols: 2,
  xPos: [442, 1282], yPos: [218, 1658], cardWidthPx: 825, cardHeightPx: 1425, paperWidthPx: 2550, paperHeightPx: 3300,
  inset: '10mm', thickness: '1mm', length: '26.16mm',
};
const A4_BORDERLESS = {
  key: 'a4|standard|borderless', variant: 'borderless', orientation: 'portrait', registrationOrientation: 'portrait', rows: 3, cols: 3,
  xPos: [109, 868, 1627], yPos: [180, 1234, 2288], cardWidthPx: 744, cardHeightPx: 1039, paperWidthPx: 2480, paperHeightPx: 3508,
  inset: '3.5mm', thickness: '1mm', length: '10.5mm',
};
const LETTER_BUSINESS = {
  key: 'letter|business|default', variant: 'default', orientation: 'portrait', registrationOrientation: 'portrait', rows: 5, cols: 2,
  xPos: [218, 1283], yPos: [120, 735, 1350, 1965, 2580], cardWidthPx: 1050, cardHeightPx: 600, paperWidthPx: 2550, paperHeightPx: 3300,
  inset: '10mm', thickness: '1mm', length: '7.2mm',
};

const PX_PER_MM = 300 / 25.4;
const near = (a, b, eps = 0.5) => Math.abs(a - b) <= eps;

describe('page-preview geometry', () => {
  let pp;
  before(async () => {
    pp = await import(pathToFileURL(MODULE).href);
  });

  it('parseLengthMm understands engine length strings', () => {
    assert.equal(pp.parseLengthMm('10mm', 0), 10);
    assert.equal(pp.parseLengthMm('0.5in', 0), 12.7);
    assert.equal(pp.parseLengthMm('1cm', 0), 10);
    assert.ok(near(pp.parseLengthMm('72pt', 0), 25.4, 1e-9));
    assert.ok(near(pp.parseLengthMm('300px', 0), 25.4, 1e-9));
    assert.equal(pp.parseLengthMm('7', 0), 7, 'bare numbers are millimetres like size_convert.size_to_mm');
    assert.equal(pp.parseLengthMm('garbage', 3.5), 3.5);
    assert.equal(pp.parseLengthMm(null, 1), 1);
  });

  it('landscape layout: identity, row-major from the top-left', () => {
    assert.deepEqual(pp.previewBox(LETTER_STANDARD), { width: 3300, height: 2550 });
    const slots = pp.slotGeometry(LETTER_STANDARD);
    assert.equal(slots.length, 8);
    assert.deepEqual(slots[0], { index: 0, row: 0, col: 0, x: 140, y: 228, w: 744, h: 1039 });
    assert.deepEqual(slots[1], { index: 1, row: 0, col: 1, x: 899, y: 228, w: 744, h: 1039 });
    assert.deepEqual(slots[3], { index: 3, row: 0, col: 3, x: 2417, y: 228, w: 744, h: 1039 });
    assert.deepEqual(slots[4], { index: 4, row: 1, col: 0, x: 140, y: 1282, w: 744, h: 1039 });
    assert.deepEqual(slots[7], { index: 7, row: 1, col: 3, x: 2417, y: 1282, w: 744, h: 1039 });
  });

  it('letter|tarot portrait 2×2 is turned 90° CCW: index 0 bottom-left, index 1 above it, index 2 to its right', () => {
    assert.deepEqual(pp.previewBox(LETTER_TAROT), { width: 3300, height: 2550 });
    const s = pp.slotGeometry(LETTER_TAROT);
    assert.equal(s.length, 4);
    // (x, y) in the portrait layout -> (y, 2550 - x - cardWidth) on the landscape page; sizes swap.
    assert.deepEqual(s[0], { index: 0, row: 0, col: 0, x: 218, y: 2550 - (442 + 825), w: 1425, h: 825 });
    assert.deepEqual(s[1], { index: 1, row: 0, col: 1, x: 218, y: 2550 - (1282 + 825), w: 1425, h: 825 });
    assert.deepEqual(s[2], { index: 2, row: 1, col: 0, x: 1658, y: 2550 - (442 + 825), w: 1425, h: 825 });
    assert.deepEqual(s[3], { index: 3, row: 1, col: 1, x: 1658, y: 2550 - (1282 + 825), w: 1425, h: 825 });
    assert.ok(s[1].y < s[0].y && s[1].x === s[0].x, 'index 1 sits directly above index 0');
    assert.ok(s[2].x > s[0].x && s[2].y === s[0].y, 'index 2 starts the next column at the bottom');
  });

  it('portrait numbering runs up the leftmost column (letter|business 5 rows × 2 cols)', () => {
    const s = pp.slotGeometry(LETTER_BUSINESS);
    assert.equal(s.length, 10);
    // Layout row 0 (indices 0,1) becomes the leftmost column; index 0 at the bottom.
    assert.equal(s[0].x, 120);
    assert.equal(s[1].x, 120);
    assert.ok(s[0].y > s[1].y);
    // Last layout row (indices 8, 9) becomes the rightmost column.
    assert.equal(s[8].x, 2580);
    assert.ok(s[8].y > s[9].y);
    assert.deepEqual([s[0].w, s[0].h], [600, 1050], 'cards are drawn sideways');
  });

  it('registration marks: 3-mark pattern on a landscape layout', () => {
    const marks = pp.registrationMarks(LETTER_STANDARD, '3');
    const square = marks.find((m) => m.type === 'square');
    const ls = marks.filter((m) => m.type === 'L');
    assert.ok(square, 'black square');
    assert.equal(ls.length, 2);
    const inset = 10 * PX_PER_MM;
    const t = 1 * PX_PER_MM;
    assert.ok(near(square.x, inset - t / 2) && near(square.y, inset - t / 2), 'square at the top-left inset');
    assert.ok(near(square.w, 5 * PX_PER_MM + t));
    const tr = ls.find((m) => m.corner === 'tr');
    const bl = ls.find((m) => m.corner === 'bl');
    assert.ok(near(tr.cornerX, 3300 - inset) && near(tr.cornerY, inset), 'L at the top-right');
    assert.ok(near(bl.cornerX, inset) && near(bl.cornerY, 2550 - inset), 'L at the bottom-left');
    assert.equal(ls.find((m) => m.corner === 'br'), undefined, 'bottom-right stays empty');
    // Arms are length − thickness/2 long (projecting caps add the rest).
    const armLen = Math.hypot(bl.lines[0].x2 - bl.lines[0].x1, bl.lines[0].y2 - bl.lines[0].y1);
    assert.ok(near(armLen, 8.04 * PX_PER_MM - t / 2));
  });

  it('registration marks: 4 L marks; length and thickness are clamped like generate_reg_mark', () => {
    const marks = pp.registrationMarks(LETTER_TAROT, '4');
    assert.equal(marks.filter((m) => m.type === 'L').length, 4);
    assert.equal(marks.filter((m) => m.type === 'square').length, 0);
    const t = 1 * PX_PER_MM;
    const L = marks[0];
    const armLen = Math.hypot(L.lines[0].x2 - L.lines[0].x1, L.lines[0].y2 - L.lines[0].y1);
    assert.ok(near(armLen, 20 * PX_PER_MM - t / 2), '26.16mm is clamped to 20mm');
    const tiny = pp.registrationMarks({ ...LETTER_STANDARD, length: '1mm', thickness: '3mm' }, '4');
    assert.ok(near(tiny[0].thickness, 1 * PX_PER_MM), 'thickness clamped to 1mm');
    const tinyArm = Math.hypot(tiny[0].lines[0].x2 - tiny[0].lines[0].x1, tiny[0].lines[0].y2 - tiny[0].lines[0].y1);
    assert.ok(near(tinyArm, 5 * PX_PER_MM - tiny[0].thickness / 2), 'length clamped to 5mm');
  });

  it('portrait layouts: the black square ends bottom-left on the landscape page', () => {
    const square = pp.registrationMarks(A4_BORDERLESS, '3').find((m) => m.type === 'square');
    const box = pp.previewBox(A4_BORDERLESS);
    assert.ok(square.x < box.width * 0.1, 'left');
    assert.ok(square.y > box.height * 0.9, 'bottom');
    const ls = pp.registrationMarks(A4_BORDERLESS, '3').filter((m) => m.type === 'L');
    const corners = ls.map((m) => [m.cornerX < box.width / 2 ? 'left' : 'right', m.cornerY < box.height / 2 ? 'top' : 'bottom'].join('-')).sort();
    assert.deepEqual(corners, ['left-top', 'right-bottom']);
  });

  it('registration orientation override turns only the marks', () => {
    const turned = { ...LETTER_STANDARD, registrationOrientation: 'portrait' };
    const box = pp.previewBox(turned);
    assert.deepEqual(pp.slotGeometry(turned), pp.slotGeometry(LETTER_STANDARD), 'slots unchanged');
    const marks = pp.registrationMarks(turned, '3');
    const square = marks.find((m) => m.type === 'square');
    assert.ok(square.x < box.width * 0.1 && square.y > box.height * 0.85, 'square moves to the bottom-left');
    const corners = marks.filter((m) => m.type === 'L')
      .map((m) => [m.cornerX < box.width / 2 ? 'left' : 'right', m.cornerY < box.height / 2 ? 'top' : 'bottom'].join('-')).sort();
    assert.deepEqual(corners, ['left-top', 'right-bottom']);
    // Portrait layout + landscape marks: square back at the top-left of the PDF page.
    const back = pp.registrationMarks({ ...A4_BORDERLESS, registrationOrientation: 'landscape' }, '3').find((m) => m.type === 'square');
    assert.ok(back.x < 200 && back.y < 200);
  });

  it('slotNearBottomLeftMark = (rows − 1) × cols with default orientation', () => {
    assert.equal(pp.slotNearBottomLeftMark(LETTER_STANDARD), 4);
    assert.equal(pp.slotNearBottomLeftMark(LETTER_TAROT), 2);
    assert.equal(pp.slotNearBottomLeftMark(A4_BORDERLESS), 6);
    assert.equal(pp.slotNearBottomLeftMark(LETTER_BUSINESS), 8);
    assert.equal(pp.slotNearBottomLeftMark({ ...LETTER_STANDARD, registrationOrientation: 'portrait' }), 7);
    assert.equal(pp.slotNearBottomLeftMark(null), -1);
  });

  it('lastSheetEmptySlots fills non-skipped slots in index order', () => {
    assert.deepEqual(pp.lastSheetEmptySlots(8, [], 5), [5, 6, 7]);
    assert.deepEqual(pp.lastSheetEmptySlots(8, [4], 5), [6, 7]);
    assert.deepEqual(pp.lastSheetEmptySlots(8, [0, 1], 6), []);
    assert.deepEqual(pp.lastSheetEmptySlots(8, [], 8), []);
    assert.deepEqual(pp.lastSheetEmptySlots(8, [], null), []);
    assert.deepEqual(pp.lastSheetEmptySlots(4, [], 0), [0, 1, 2, 3]);
  });

  it('invalid layouts are handled without throwing', () => {
    for (const bad of [null, undefined, {}, { xPos: [], yPos: [1] }, { ...LETTER_STANDARD, cardWidthPx: 0 }]) {
      assert.deepEqual(pp.slotGeometry(bad), []);
      assert.deepEqual(pp.registrationMarks(bad), []);
      assert.deepEqual(pp.previewBox(bad), { width: 0, height: 0 });
    }
  });

  it('every layout in test/fixtures/introspection.json satisfies the invariants', (t) => {
    if (!fs.existsSync(FIXTURE)) {
      t.skip('fixture not generated yet');
      return;
    }
    const intro = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    const layouts = [...(intro.layouts?.combos || []), ...(intro.layouts?.specialty || [])].filter((l) => !l.error);
    assert.ok(layouts.length >= 200, `expected the full layout set, got ${layouts.length}`);
    for (const layout of layouts) {
      const label = layout.key;
      const slots = pp.slotGeometry(layout);
      const box = pp.previewBox(layout);
      assert.equal(slots.length, layout.rows * layout.cols, `${label}: slot count`);
      assert.equal(slots.length, layout.cardsPerPage, `${label}: cardsPerPage`);
      assert.ok(box.width >= box.height, `${label}: landscape page`);
      for (const s of slots) {
        assert.ok(s.x >= 0 && s.y >= 0 && s.x + s.w <= box.width + 1 && s.y + s.h <= box.height + 1, `${label}: slot ${s.index} inside the page`);
      }
      for (let i = 0; i < slots.length; i += 1) {
        for (let j = i + 1; j < slots.length; j += 1) {
          const a = slots[i];
          const b = slots[j];
          const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          assert.ok(!overlap, `${label}: slots ${i} and ${j} overlap`);
        }
      }
      const minX = Math.min(...slots.map((s) => s.x));
      const minY = Math.min(...slots.map((s) => s.y));
      const maxBottom = Math.max(...slots.map((s) => s.y + s.h));
      if (layout.orientation === 'portrait') {
        assert.ok(slots[0].x === minX && slots[0].y + slots[0].h === maxBottom, `${label}: index 0 bottom-left`);
      } else {
        assert.ok(slots[0].x === minX && slots[0].y === minY, `${label}: index 0 top-left`);
      }
      if (layout.registrationOrientation === layout.orientation) {
        assert.equal(pp.slotNearBottomLeftMark(layout), (layout.rows - 1) * layout.cols, `${label}: slot next to the bottom-left mark`);
      }
      for (const reg of ['3', '4']) {
        const marks = pp.registrationMarks(layout, reg);
        assert.equal(marks.filter((m) => m.type === 'L').length, reg === '4' ? 4 : 2, `${label}: L marks (${reg})`);
        for (const m of marks) {
          const pts = m.type === 'square' ? [[m.x, m.y], [m.x + m.w, m.y + m.h]] : m.lines.flatMap((l) => [[l.x1, l.y1], [l.x2, l.y2]]);
          for (const [x, y] of pts) assert.ok(x >= 0 && y >= 0 && x <= box.width && y <= box.height, `${label}: mark inside the page`);
        }
      }
      const square = pp.registrationMarks(layout, '3').find((m) => m.type === 'square');
      if (layout.orientation === 'portrait') assert.ok(square.y > box.height / 2 && square.x < box.width / 2, `${label}: square bottom-left`);
      else assert.ok(square.y < box.height / 2 && square.x < box.width / 2, `${label}: square top-left`);
    }
  });
});
