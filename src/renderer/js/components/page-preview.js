/**
 * Sheet preview (spec §8.5): draws card slots and registration marks exactly where create_pdf puts
 * them, in the orientation of the finished (always landscape) PDF page.
 *
 * Geometry (spec §1, verified against utilities.py / page_manager.py):
 * - Layout coordinates are px at 300 PPI in the LAYOUT orientation: slot i sits at
 *   `(xPos[i % cols], yPos[floor(i / cols)])`, size `cardWidthPx × cardHeightPx`.
 * - Portrait layouts are rotated 90° counter-clockwise into the landscape PDF:
 *   `(x, y) → (y, paperWidthPx − x)`, so slot 0 ends at the bottom-left.
 * - Registration marks are drawn on a canvas in the REGISTRATION orientation (black square
 *   top-left; 3 marks: L top-right and bottom-left, bottom-right empty; 4 marks: four L), rotated
 *   into the layout orientation when it differs (90° CCW if the marks are portrait, else 90° CW),
 *   then follow the portrait→landscape rotation.
 * - "Bottom-left mark" = the L mark at the bottom-left of the sheet as placed on the cutting mat
 *   (black square top-left); for portrait layouts it appears bottom-RIGHT in the landscape preview.
 *
 * The pure helpers (`slotGeometry`, `previewBox`, `registrationMarks`, `slotNearBottomLeftMark`,
 * `lastSheetEmptySlots`, `parseLengthMm`) never touch the DOM and are unit-tested in Node.
 *
 * @module components/page-preview
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const PX_PER_MM = 300 / 25.4;

/* ------------------------------------------------------------------------------------------------
 * Pure geometry
 * ---------------------------------------------------------------------------------------------- */

/**
 * Parse an engine length string to millimetres (`'10mm'`, `'0.5in'`, `'1cm'`, `'3pt'`, bare number = mm
 * like `size_convert.size_to_mm`).
 * @param {unknown} value
 * @param {number} fallbackMm
 * @returns {number}
 */
export function parseLengthMm(value, fallbackMm) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*(mm|cm|in|pt|px)?\s*$/i.exec(String(value ?? ''));
  if (!m) return fallbackMm;
  const n = Number(m[1]);
  switch ((m[2] || 'mm').toLowerCase()) {
    case 'cm': return n * 10;
    case 'in': return n * 25.4;
    case 'pt': return (n / 72) * 25.4;
    case 'px': return n / PX_PER_MM;
    default: return n;
  }
}

/**
 * True when the layout object has the fields the preview needs.
 * @param {any} layout
 * @returns {boolean}
 */
export function isDrawableLayout(layout) {
  return !!layout
    && Array.isArray(layout.xPos) && layout.xPos.length > 0
    && Array.isArray(layout.yPos) && layout.yPos.length > 0
    && [layout.cardWidthPx, layout.cardHeightPx, layout.paperWidthPx, layout.paperHeightPx]
      .every((n) => Number.isFinite(n) && n > 0);
}

/**
 * @param {any} layout
 * @returns {boolean}
 */
function isPortraitLayout(layout) {
  if (layout.orientation === 'portrait') return true;
  if (layout.orientation === 'landscape') return false;
  return layout.paperHeightPx > layout.paperWidthPx;
}

/**
 * Size of the finished landscape page in px at 300 PPI.
 * @param {any} layout
 * @returns {{ width: number, height: number }}
 */
export function previewBox(layout) {
  if (!isDrawableLayout(layout)) return { width: 0, height: 0 };
  return isPortraitLayout(layout)
    ? { width: layout.paperHeightPx, height: layout.paperWidthPx }
    : { width: layout.paperWidthPx, height: layout.paperHeightPx };
}

/**
 * Map a point from layout coordinates to the finished landscape page.
 * @param {any} layout
 * @returns {(x: number, y: number) => [number, number]}
 */
function layoutToFinal(layout) {
  if (!isPortraitLayout(layout)) return (x, y) => [x, y];
  const W = layout.paperWidthPx;
  return (x, y) => [y, W - x];
}

/**
 * Slot rectangles in finished (landscape) page coordinates, px at 300 PPI.
 * Index = row-major in the layout orientation (`col = i % cols`, `row = floor(i / cols)`), i.e. the
 * numbering used by `--skip`.
 *
 * @param {any} layout introspection Layout (spec §7)
 * @returns {Array<{ index: number, row: number, col: number, x: number, y: number, w: number, h: number }>}
 *   empty array when the layout is not drawable.
 */
export function slotGeometry(layout) {
  if (!isDrawableLayout(layout)) return [];
  const cols = layout.xPos.length;
  const rows = layout.yPos.length;
  const cw = layout.cardWidthPx;
  const ch = layout.cardHeightPx;
  const portrait = isPortraitLayout(layout);
  const W = layout.paperWidthPx;
  const slots = [];
  for (let index = 0; index < rows * cols; index += 1) {
    const col = index % cols;
    const row = Math.floor(index / cols);
    const x = layout.xPos[col];
    const y = layout.yPos[row];
    if (portrait) {
      slots.push({ index, row, col, x: y, y: W - (x + cw), w: ch, h: cw });
    } else {
      slots.push({ index, row, col, x, y, w: cw, h: ch });
    }
  }
  return slots;
}

/**
 * Registration mark shapes in finished page coordinates.
 * Mark geometry follows page_manager.generate_reg_mark: inset from the paper edge, 5 mm square for
 * the 3-mark pattern, L arms of `length` (clamped 5–20 mm) and `thickness` (clamped 0.5–1 mm).
 *
 * @param {any} layout
 * @param {'3'|'4'|3|4} [registration]
 * @returns {Array<{ type: 'square', corner: 'tl', x: number, y: number, w: number, h: number } | { type: 'L', corner: 'tl'|'tr'|'bl'|'br', cornerX: number, cornerY: number, lines: Array<{ x1: number, y1: number, x2: number, y2: number }>, thickness: number }>}
 *   `corner` names the corner in the registration orientation (black square top-left).
 */
export function registrationMarks(layout, registration = '3') {
  if (!isDrawableLayout(layout)) return [];
  const four = String(registration) === '4';
  const portraitLayout = isPortraitLayout(layout);
  const long = Math.max(layout.paperWidthPx, layout.paperHeightPx);
  const short = Math.min(layout.paperWidthPx, layout.paperHeightPx);
  const layoutOrientation = portraitLayout ? 'portrait' : 'landscape';
  const regOrientation = layout.registrationOrientation === 'portrait' || layout.registrationOrientation === 'landscape'
    ? layout.registrationOrientation
    : layoutOrientation;
  const RW = regOrientation === 'portrait' ? short : long;
  const RH = regOrientation === 'portrait' ? long : short;

  const defaultInset = layout.variant === 'borderless' ? 3.5 : 10;
  const inset = Math.min(parseLengthMm(layout.inset, defaultInset), 86.36) * PX_PER_MM;
  const t = Math.max(0.5, Math.min(parseLengthMm(layout.thickness, 1), 1)) * PX_PER_MM;
  const len = Math.max(5, Math.min(parseLengthMm(layout.length, 5), 20)) * PX_PER_MM;
  const square = 5 * PX_PER_MM;

  // Registration canvas → layout canvas.
  let regToLayout = (x, y) => [x, y];
  if (regOrientation !== layoutOrientation) {
    regToLayout = regOrientation === 'portrait'
      ? (x, y) => [y, RW - x] // 90° CCW (PIL rotate(90))
      : (x, y) => [RH - y, x]; // 90° CW (PIL rotate(-90))
  }
  const toFinal = layoutToFinal(layout);
  const map = (x, y) => {
    const [lx, ly] = regToLayout(x, y);
    return toFinal(lx, ly);
  };

  const shapes = [];
  if (!four) {
    // Filled 5 mm square; matplotlib strokes its edge with the mark thickness.
    const [ax, ay] = map(inset - t / 2, inset - t / 2);
    const [bx, by] = map(inset + square + t / 2, inset + square + t / 2);
    shapes.push({ type: 'square', corner: 'tl', x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) });
  }
  const arm = len - t / 2;
  const L = (corner, cx, cy, dx, dy) => {
    const [px, py] = map(cx, cy);
    const [hx, hy] = map(cx + dx * arm, cy);
    const [vx, vy] = map(cx, cy + dy * arm);
    shapes.push({
      type: 'L',
      corner,
      cornerX: px,
      cornerY: py,
      thickness: t,
      lines: [{ x1: px, y1: py, x2: hx, y2: hy }, { x1: px, y1: py, x2: vx, y2: vy }],
    });
  };
  if (four) L('tl', inset, inset, 1, 1);
  L('tr', RW - inset, inset, -1, 1);
  L('bl', inset, RH - inset, 1, -1);
  if (four) L('br', RW - inset, RH - inset, -1, -1);
  return shapes;
}

/**
 * Index of the slot nearest to the bottom-left L mark (the slot people cover with a Post-it or
 * leave empty when registration fails). For default layouts this is `(rows − 1) × cols`.
 * @param {any} layout
 * @returns {number} slot index, or -1 when the layout is not drawable.
 */
export function slotNearBottomLeftMark(layout) {
  const slots = slotGeometry(layout);
  if (slots.length === 0) return -1;
  const mark = registrationMarks(layout, '4').find((m) => m.type === 'L' && m.corner === 'bl');
  if (!mark) return -1;
  let best = -1;
  let bestDist = Infinity;
  for (const s of slots) {
    const cx = s.x + s.w / 2;
    const cy = s.y + s.h / 2;
    const d = (cx - mark.cornerX) ** 2 + (cy - mark.cornerY) ** 2;
    if (d < bestDist - 1e-6) {
      bestDist = d;
      best = s.index;
    }
  }
  return best;
}

/**
 * Slots that stay empty on the LAST sheet: cards fill the non-skipped slots in index order.
 * @param {number} slotCount cards per page
 * @param {number[]} skip skipped slot indices
 * @param {number|null|undefined} cardsOnLastSheet
 * @returns {number[]} indices (ascending); empty when unknown or the last sheet is full.
 */
export function lastSheetEmptySlots(slotCount, skip, cardsOnLastSheet) {
  if (!Number.isFinite(cardsOnLastSheet) || cardsOnLastSheet < 0) return [];
  const skipped = new Set((skip || []).filter((i) => Number.isInteger(i)));
  const usable = [];
  for (let i = 0; i < slotCount; i += 1) if (!skipped.has(i)) usable.push(i);
  if (cardsOnLastSheet >= usable.length) return [];
  return usable.slice(Math.max(0, Math.floor(cardsOnLastSheet)));
}

/* ------------------------------------------------------------------------------------------------
 * DOM component
 * ---------------------------------------------------------------------------------------------- */

let previewCounter = 0;

/**
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {...Node} children
 * @returns {SVGElement}
 */
function s(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/**
 * @param {string} tag
 * @param {string} [className]
 * @param {...(Node|string)} children
 * @returns {HTMLElement}
 */
function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const round = (n) => Math.round(n * 10) / 10;

/**
 * Interactive sheet preview.
 *
 * @param {object} props
 * @param {any} props.layout introspection Layout (spec §7)
 * @param {number[]} [props.skip] skipped slot indices (0-based)
 * @param {(index: number) => void} [props.onToggleSkip] makes slots clickable; called with the 0-based index
 * @param {'3'|'4'} [props.registration]
 * @param {number|null} [props.cardsOnLastSheet] cards on the last sheet (dashed slots stay empty there)
 * @param {number|null|false} [props.highlightIndex] slot to highlight; undefined/null = automatic
 *   (slot next to the bottom-left mark, 3-mark pattern only); false or -1 = none
 * @param {boolean} [props.showLegend] default true
 * @param {string} [props.caption] optional caption above the legend
 * @returns {HTMLElement & { update(next: object): void, highlightIndex: number }}
 */
export function pagePreview(props) {
  previewCounter += 1;
  const uidBase = `pp${previewCounter}`;
  const root = el('figure', 'page-preview');
  const live = el('div', 'sr-only');
  live.setAttribute('aria-live', 'polite');
  let state = { skip: [], registration: '3', showLegend: true, ...props };

  function resolvedHighlight() {
    const hi = state.highlightIndex;
    if (hi === false || hi === -1) return -1;
    if (Number.isInteger(hi)) return hi;
    return String(state.registration) === '3' ? slotNearBottomLeftMark(state.layout) : -1;
  }

  function render() {
    const { layout } = state;
    root.replaceChildren();
    if (!isDrawableLayout(layout)) {
      root.classList.add('is-empty');
      root.append(el('div', 'pp-empty', 'No sheet preview available for this combination.'));
      root.highlightIndex = -1;
      return;
    }
    root.classList.remove('is-empty');
    const box = previewBox(layout);
    const slots = slotGeometry(layout);
    const skipped = new Set((state.skip || []).filter((i) => Number.isInteger(i) && i >= 0 && i < slots.length));
    const highlight = resolvedHighlight();
    root.highlightIndex = highlight;
    const emptyLast = new Set(lastSheetEmptySlots(slots.length, [...skipped], state.cardsOnLastSheet));
    const interactive = typeof state.onToggleSkip === 'function';
    const minCard = Math.min(layout.cardWidthPx, layout.cardHeightPx);
    const radius = Number.isFinite(layout.radiusPx) && layout.radiusPx >= 0
      ? Math.min(layout.radiusPx, minCard / 2)
      : Math.min(35, minCard * 0.06);
    const hatchId = `${uidBase}-hatch`;
    const hatchGap = Math.max(18, Math.round(minCard / 9));

    const svg = s('svg', {
      viewBox: `0 0 ${box.width} ${box.height}`,
      class: 'pp-svg',
      role: 'group',
      'aria-label': `Sheet preview: ${slots.length} card slots${skipped.size ? `, ${skipped.size} left empty` : ''}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    svg.append(s('defs', {},
      s('pattern', { id: hatchId, patternUnits: 'userSpaceOnUse', width: hatchGap, height: hatchGap, patternTransform: 'rotate(45)' },
        s('rect', { width: hatchGap, height: hatchGap, class: 'pp-hatch-bg' }),
        s('line', { x1: 0, y1: 0, x2: 0, y2: hatchGap, class: 'pp-hatch-line', 'stroke-width': Math.max(4, hatchGap * 0.18) }))));
    svg.append(s('rect', { class: 'pp-paper', x: 0, y: 0, width: box.width, height: box.height }));

    const slotLayer = s('g', { class: 'pp-slots' });
    for (const slot of slots) {
      const isSkipped = skipped.has(slot.index);
      const isHighlight = slot.index === highlight;
      const isEmptyLast = !isSkipped && emptyLast.has(slot.index);
      const n = slot.index + 1;
      const label = isSkipped
        ? `Slot ${n}: left empty${interactive ? '. Click to use it again.' : ''}`
        : `Slot ${n}${isHighlight ? ' (next to the bottom-left mark)' : ''}${isEmptyLast ? ' (empty on the last sheet)' : ''}${interactive ? '. Click to leave it empty.' : ''}`;
      const g = s('g', {
        class: ['pp-slot', isSkipped && 'is-skipped', isHighlight && 'is-highlight', isEmptyLast && 'is-empty-last', interactive && 'is-interactive'].filter(Boolean).join(' '),
        'data-index': slot.index,
        role: interactive ? 'button' : 'img',
        tabindex: interactive ? 0 : null,
        'aria-pressed': interactive ? String(isSkipped) : null,
        'aria-label': label,
      });
      g.append(s('title', {}, label));
      g.append(s('rect', { class: 'pp-card', x: round(slot.x), y: round(slot.y), width: round(slot.w), height: round(slot.h), rx: radius, ry: radius }));
      if (isSkipped) {
        g.append(s('rect', { class: 'pp-hatch', x: round(slot.x), y: round(slot.y), width: round(slot.w), height: round(slot.h), rx: radius, ry: radius, fill: `url(#${hatchId})` }));
      }
      const fontSize = Math.max(28, Math.min(slot.w, slot.h) * (slots.length > 40 ? 0.42 : 0.26));
      const cx = slot.x + slot.w / 2;
      const cy = slot.y + slot.h / 2;
      g.append(s('text', {
        class: 'pp-num',
        x: round(cx),
        y: round(cy),
        'font-size': round(fontSize),
        'text-anchor': 'middle',
        'dominant-baseline': 'central',
      }, document.createTextNode(String(n))));
      if (isHighlight) {
        const pad = Math.max(10, minCard * 0.035);
        g.prepend(s('rect', {
          class: 'pp-highlight-ring',
          x: round(slot.x - pad),
          y: round(slot.y - pad),
          width: round(slot.w + 2 * pad),
          height: round(slot.h + 2 * pad),
          rx: radius + pad,
          ry: radius + pad,
        }));
      }
      if (interactive) {
        const toggle = () => {
          if (!isSkipped && skipped.size + 1 >= slots.length) {
            live.textContent = 'At least one slot must hold a card.';
            g.classList.remove('is-refused');
            // Restart the refusal animation.
            void g.getBoundingClientRect();
            g.classList.add('is-refused');
            return;
          }
          const message = isSkipped ? `Slot ${n} will hold a card again.` : `Slot ${n} will be left empty.`;
          const nextSkip = isSkipped
            ? [...skipped].filter((i) => i !== slot.index)
            : [...skipped, slot.index].sort((a, b) => a - b);
          const callback = state.onToggleSkip;
          // Optimistic update; the parent stays authoritative and may call update({ skip }) later.
          state = { ...state, skip: nextSkip };
          render();
          live.textContent = message;
          root.querySelector(`.pp-slot[data-index="${slot.index}"]`)?.focus({ preventScroll: true });
          callback(slot.index);
        };
        g.addEventListener('click', toggle);
        g.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
          }
        });
      }
      slotLayer.append(g);
    }
    svg.append(slotLayer);

    const markLayer = s('g', { class: 'pp-marks', 'aria-hidden': 'true' });
    for (const m of registrationMarks(layout, state.registration)) {
      if (m.type === 'square') {
        markLayer.append(s('rect', { class: 'pp-mark-square', x: round(m.x), y: round(m.y), width: round(m.w), height: round(m.h) }));
      } else {
        for (const ln of m.lines) {
          markLayer.append(s('line', {
            class: 'pp-mark-line', x1: round(ln.x1), y1: round(ln.y1), x2: round(ln.x2), y2: round(ln.y2), 'stroke-width': round(m.thickness),
          }));
        }
      }
    }
    svg.append(markLayer);

    const stage = el('div', 'pp-stage');
    stage.style.aspectRatio = `${box.width} / ${box.height}`;
    stage.append(svg);
    root.append(stage);

    if (state.showLegend !== false) {
      const legend = el('figcaption', 'pp-legend');
      if (state.caption) legend.append(el('span', 'pp-caption', state.caption));
      const item = (cls, text) => el('span', 'pp-legend-item', el('span', `pp-swatch ${cls}`), text);
      legend.append(item('is-card', 'Card'));
      if (interactive || skipped.size) legend.append(item('is-skipped', interactive ? 'Left empty (click a slot)' : 'Left empty'));
      if (highlight >= 0) legend.append(item('is-highlight', 'Next to the bottom-left mark'));
      if (emptyLast.size) legend.append(item('is-empty-last', `Empty on the last sheet (${emptyLast.size})`));
      root.append(legend);
    }
    root.append(live);
  }

  render();
  root.update = (next = {}) => {
    state = { ...state, ...next };
    const active = document.activeElement;
    const focusedIndex = active && root.contains(active) ? active.closest?.('.pp-slot')?.dataset?.index : undefined;
    const liveText = live.textContent;
    render();
    live.textContent = liveText;
    if (focusedIndex !== undefined && root.isConnected) {
      root.querySelector(`.pp-slot[data-index="${focusedIndex}"]`)?.focus({ preventScroll: true });
    }
  };
  return root;
}

export default pagePreview;
