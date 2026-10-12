/**
 * Printer alignment view (`#/offset`, spec §8.4 "Printer alignment", §9.9, §13.3).
 *
 * Guided loop for two-sided printing:
 *  1. Print the alignment sheet for the paper (`scm.offset.calibration`, generated with
 *     `scm.offset.generateCalibration` when none ships). With a saved alignment, a check sheet that
 *     already contains it can be made (`scm.offset.shiftedCalibration`, opened when ready).
 *  2. Look through the sheet against a window or lamp and find the square that lines up.
 *  3. Type the two red numbers; choose which sheet was printed (Add to its correction vs Replace),
 *     see the resulting total, optionally a rotation (Advanced), Save (`scm.offset.save`, integers
 *     for X/Y). Saving a non-zero alignment turns on settings.pdf.options.load_offset.
 *  No square lines up → "Make a shifted sheet" (+20 px towards the side that is closest) and repeat.
 * Also: reset a damaged alignment file (`scm.offset.reset`), a notice when printing fronts only, and
 * "Advanced: align an existing PDF" (file chooser + `scm.offset.pdfInfo` → resolution → memory
 * estimate → `scm.offset.apply` job → result card).
 *
 * @module views/offset
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { nextStep } from '../components/next-step.js';
import {
  CALIBRATION_STEPS, CALIBRATION_NOTES, OFFSET_OPTIONS, PAPER_SIZES, getPaperSize, fillPlaceholders,
} from '../data/option-docs.js';
import { getHelpLink } from '../data/help.js';
import { normalizeOptions, baseName, shortPath, createSlot, fkWrap } from './pdf.js';

const { h, icon } = ui;

const READING_LIMIT = 500;
const ANGLE_LIMIT = 10;
const DEFAULT_SHIFT = 20;
const MEMORY_BLOCK_RATIO = 0.85;
const MEMORY_HEAVY_RATIO = 0.5;

/** Shift directions for "Make a shifted sheet", as seen when looking at the BACK of the sheet. */
const SHIFT_DIRECTIONS = Object.freeze([
  { value: 'right', label: 'Right side', icon: 'chevron-right', dx: 1, dy: 0 },
  { value: 'left', label: 'Left side', icon: 'chevron-left', dx: -1, dy: 0 },
  { value: 'up', label: 'Top', icon: 'chevron-up', dx: 0, dy: 1 },
  { value: 'down', label: 'Bottom', icon: 'chevron-down', dx: 0, dy: -1 },
]);

/** Remembered while the app runs (survives leaving and re-opening the page). */
const session = {
  paper: null,
  /** correction contained in the last sheet opened from this page: { x, y, angle } */
  printedWith: null,
  /** 'add' | 'replace' | null (null = automatic) */
  mode: null,
  showRotation: false,
  shiftDir: 'right',
  shiftAmount: DEFAULT_SHIFT,
  /** jobId -> { purpose: 'generate'|'shifted'|'check'|'apply', paper, shift } */
  jobs: new Map(),
  handled: new Set(),
  /** last shifted/check sheet made here: { path, shift, purpose } */
  lastSheet: null,
  /** { value, at } shown after saving */
  saved: null,
  apply: { path: null, info: null, error: null, ppi: null, confirm: false, loading: false },
  applyOpen: false,
};

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Saved alignment as numbers, or null when none / unreadable.
 * @param {any} info result of scm.offset.get()
 * @returns {{ x: number, y: number, angle: number }|null}
 */
export function savedValues(info) {
  if (!info || typeof info !== 'object' || info.valid === false) return null;
  const x = Number(info.x_offset);
  const y = Number(info.y_offset);
  const angle = Number(info.angle_offset ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.round(x), y: Math.round(y), angle: Number.isFinite(angle) ? angle : 0 };
}

/**
 * True when a correction is not 0, 0, 0.
 * @param {{ x: number, y: number, angle?: number }|null|undefined} v
 * @returns {boolean}
 */
export function isNonZero(v) {
  return !!v && (Number(v.x) !== 0 || Number(v.y) !== 0 || Number(v.angle || 0) !== 0);
}

/**
 * Resulting alignment from the two red numbers.
 * @param {{ x: number, y: number }} base correction contained in the printed sheet
 * @param {number|null} readX
 * @param {number|null} readY
 * @param {number} angle total rotation
 * @param {'add'|'replace'} mode
 * @returns {{ x: number, y: number, angle: number }|null} null until both numbers are typed
 */
export function computeTotal(base, readX, readY, angle, mode) {
  if (!Number.isInteger(readX) || !Number.isInteger(readY)) return null;
  const add = mode === 'add' && base;
  return {
    x: add ? base.x + readX : readX,
    y: add ? base.y + readY : readY,
    angle: Number.isFinite(angle) ? angle : 0,
  };
}

/**
 * Memory needed to align a PDF (spec §9.9): (1.5 × pages + 2) × page bitmap bytes at `ppi`.
 * @param {{ pages: number, widthIn: number, heightIn: number }} info
 * @param {number} ppi
 * @returns {number|null}
 */
export function alignMemoryBytes(info, ppi) {
  const pages = Number(info?.pages);
  const w = Number(info?.widthIn);
  const hgt = Number(info?.heightIn);
  if (!(pages > 0 && w > 0 && hgt > 0 && ppi > 0)) return null;
  const pageBytes = Math.floor(w * ppi) * Math.floor(hgt * ppi) * 3;
  return (1.5 * pages + 2) * pageBytes;
}

/**
 * Signed number for display ("+12", "−5", "0").
 * @param {number} n
 * @returns {string}
 */
export function signed(n) {
  const v = Number(n) || 0;
  if (v > 0) return `+${format.formatNumber(v)}`;
  if (v < 0) return `−${format.formatNumber(Math.abs(v))}`;
  return '0';
}

/**
 * Path of the file produced by a calibration / offset job result.
 * @param {any} result
 * @returns {string|null}
 */
export function resultPath(result) {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') return null;
  return result.path || result.pdfPath || result.outputPath || null;
}

/* ------------------------------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------------------------- */

export default {
  id: 'offset',
  title: 'Printer alignment',
  icon: 'crosshair',

  /**
   * @param {HTMLElement} container
   * @param {any} ctx view context (spec §13.3)
   * @returns {() => void}
   */
  mount(container, ctx) {
    const { api, store } = ctx;
    const navigate = (id, params) => ctx.navigate(id, params);
    let disposed = false;

    /** undefined = loading; null = none saved */
    let offsetInfo;
    let offsetError = null;
    /** @type {{ path: string|null, canGenerate: boolean }|null} */
    let calib = null;
    let calibError = null;
    let calibLoading = false;
    let calibSeq = 0;

    let readX = null;
    let readY = null;
    let angleValue = 0;
    let angleTouched = false;

    /** @type {Array<{ refresh(force?: boolean): void }>} */
    let slots = [];
    /** @type {Record<string, any>} */
    let refs = {};

    const settings = () => store.get('settings') || {};
    const opts = () => normalizeOptions(settings().pdf?.options);
    const paper = () => session.paper || opts().paper_size || 'letter';
    const paperInfo = () => getPaperSize(paper());
    const saved = () => savedValues(offsetInfo);
    const base = () => session.printedWith || saved() || { x: 0, y: 0, angle: 0 };
    const mode = () => {
      if (!isNonZero(base())) return 'replace';
      if (session.mode) return session.mode;
      if (session.printedWith) return isNonZero(session.printedWith) ? 'add' : 'replace';
      return 'replace';
    };
    const runningJob = () => {
      const j = store.get('job');
      return j && j.status === 'running' ? j : null;
    };
    const busy = () => !!runningJob();
    const total = () => computeTotal(base(), readX, readY, angleValue, mode());

    /* ------------------------------ loading ------------------------------ */

    async function loadOffset() {
      try {
        const v = await api.offset.get();
        if (disposed) return;
        offsetInfo = v && typeof v === 'object' ? v : null;
        offsetError = null;
      } catch (err) {
        if (disposed) return;
        offsetInfo = null;
        offsetError = api.errorMessage(err);
      }
      if (!angleTouched) {
        angleValue = saved()?.angle || 0;
        refs.angleInput?.setValue(angleValue);
      }
      refresh();
    }

    async function loadCalibration() {
      const seq = ++calibSeq;
      calibLoading = true;
      calibError = null;
      refresh();
      try {
        const res = await api.offset.calibration(paper());
        if (disposed || seq !== calibSeq) return;
        calib = res && typeof res === 'object' ? { path: res.path || null, canGenerate: !!res.canGenerate } : { path: null, canGenerate: false };
      } catch (err) {
        if (disposed || seq !== calibSeq) return;
        calib = null;
        calibError = api.errorMessage(err);
      } finally {
        if (!disposed && seq === calibSeq) {
          calibLoading = false;
          refresh();
        }
      }
    }

    /* ------------------------------ actions ------------------------------ */

    async function openSheet(path, shift) {
      await api.shell.openPath(path);
      session.printedWith = shift ? { x: shift.x, y: shift.y, angle: shift.angle || 0 } : { x: 0, y: 0, angle: 0 };
      session.mode = null;
      refresh();
    }

    /** A job can finish before its id comes back from the start call: handle a result already in the store. */
    function checkFinishedNow() {
      if (disposed) return;
      const results = store.get('lastResults') || {};
      for (const kind of ['calibration', 'offset']) {
        if (results[kind]) handleFinished(results[kind], { autoOpen: true });
      }
    }

    async function generateSheet() {
      const res = await api.offset.generateCalibration(paper());
      if (res?.jobId) session.jobs.set(String(res.jobId), { purpose: 'generate', paper: paper(), shift: { x: 0, y: 0, angle: 0 } });
      checkFinishedNow();
      refresh();
    }

    async function makeShiftedSheet(shift, purpose) {
      const req = { paper: paper(), x: Math.round(shift.x), y: Math.round(shift.y), angle: Number(shift.angle) || 0 };
      const res = await api.offset.shiftedCalibration(req);
      if (res?.jobId) session.jobs.set(String(res.jobId), { purpose, paper: req.paper, shift: { x: req.x, y: req.y, angle: req.angle } });
      checkFinishedNow();
      refresh();
    }

    async function saveAlignment() {
      const t = total();
      if (!t) return;
      const value = await api.offset.save({ x_offset: t.x, y_offset: t.y, angle_offset: t.angle });
      if (disposed) return;
      const v = value && typeof value === 'object' ? value : { x_offset: t.x, y_offset: t.y, angle_offset: t.angle };
      offsetInfo = { valid: true, error: null, ...v };
      const s = savedValues(offsetInfo) || { x: t.x, y: t.y, angle: t.angle };
      if (isNonZero(s)) await api.settings.update({ pdf: { options: { load_offset: true } } });
      session.saved = { value: s, at: Date.now() };
      session.printedWith = null;
      session.mode = null;
      readX = null;
      readY = null;
      refs.xInput?.setValue(null);
      refs.yInput?.setValue(null);
      ui.toast({
        variant: 'success',
        title: isNonZero(s) ? 'Printer alignment saved' : 'Saved: your printer needs no correction',
        message: isNonZero(s) ? 'New PDFs made with “Fronts and backs” will line up the backs.' : undefined,
      });
      refresh();
    }

    async function resetAlignment() {
      const ok = await ui.confirmDialog({
        title: 'Reset your printer alignment?',
        message: 'The saved alignment goes back to 0, 0, 0 (no correction).',
        confirmLabel: 'Reset to 0, 0, 0',
      });
      if (!ok) return;
      const value = await api.offset.reset();
      if (disposed) return;
      offsetInfo = value && typeof value === 'object' ? { valid: true, error: null, ...value } : { valid: true, error: null, x_offset: 0, y_offset: 0, angle_offset: 0 };
      offsetError = null;
      session.saved = null;
      if (!angleTouched) {
        angleValue = 0;
        refs.angleInput?.setValue(0);
      }
      ui.toast({ variant: 'success', title: 'Printer alignment reset to 0, 0, 0' });
      refresh();
    }

    async function setLoadOffset(on) {
      await api.settings.update({ pdf: { options: { load_offset: !!on } } });
      refresh();
    }

    async function choosePdf() {
      const file = await api.dialog.openFile({ purpose: 'pdf', title: 'Choose the PDF to align', filters: [{ name: 'PDF files', extensions: ['pdf'] }] });
      if (!file || disposed) return;
      session.apply = { path: file, info: null, error: null, ppi: null, confirm: false, loading: true };
      refresh();
      // session.apply outlives the page: finish it even after unmount, or the next visit would show
      // "Reading the PDF…" forever. refresh() is a no-op once disposed.
      try {
        const info = await api.offset.pdfInfo(file);
        if (session.apply.path !== file) return;
        session.apply.info = info && typeof info === 'object' ? info : null;
        const ppi = Math.round(Number(info?.ppi));
        session.apply.ppi = Number.isFinite(ppi) && ppi >= 1 && ppi <= 2400 ? ppi : 300;
      } catch (err) {
        if (session.apply.path !== file) return;
        session.apply.error = api.errorMessage(err);
        session.apply.ppi = 300;
      }
      session.apply.loading = false;
      refresh();
    }

    async function applyToPdf() {
      const s = saved();
      const a = session.apply;
      if (!s || !a.path) return;
      const req = { pdfPath: a.path, x_offset: s.x, y_offset: s.y, angle_offset: s.angle, ppi: a.ppi || null };
      if (a.confirm) req.ignoreMemoryLimit = true;
      const res = await api.offset.apply(req);
      if (res?.jobId) session.jobs.set(String(res.jobId), { purpose: 'apply' });
      checkFinishedNow();
      refresh();
    }

    /** React to a finished calibration / offset job started from this page. */
    function handleFinished(result, { autoOpen }) {
      if (!result || !result.jobId || session.handled.has(result.jobId)) return;
      const meta = session.jobs.get(result.jobId);
      if (!meta) return;
      session.handled.add(result.jobId);
      if (meta.purpose === 'apply') {
        refresh();
        return;
      }
      if (result.status !== 'succeeded') {
        if (autoOpen && result.status === 'failed') {
          ui.toast({ variant: 'danger', title: 'The sheet could not be made', message: result.error?.message || undefined, timeout: 8000 });
        }
        refresh();
        return;
      }
      const path = resultPath(result.result);
      if (meta.purpose === 'generate') {
        loadCalibration();
      } else if (path) {
        session.lastSheet = { path, shift: meta.shift, purpose: meta.purpose };
      }
      if (path) {
        session.printedWith = meta.purpose === 'generate' ? { x: 0, y: 0, angle: 0 } : { ...meta.shift };
        session.mode = null;
        if (autoOpen) {
          api.shell.openPath(path).catch((err) => ui.showError(err, { title: 'Could not open the sheet' }));
          ui.toast({
            variant: 'success',
            title: meta.purpose === 'generate' ? 'Alignment sheet ready' : (meta.purpose === 'check' ? 'Check sheet ready' : 'Shifted sheet ready'),
            message: 'Print it two-sided with “Flip on long edge” at actual size, on your card stock.',
          });
        }
      }
      refresh();
    }

    /* ------------------------------ parts ------------------------------ */

    function renderTopNotices() {
      const out = [];
      if (offsetInfo && offsetInfo.valid === false) {
        out.push(ui.callout({
          variant: 'danger',
          title: "Your saved alignment can't be read",
          message: `The alignment file is damaged${offsetInfo.error ? ` (${offsetInfo.error})` : ''}. Reset it, then measure your printer again.`,
          actions: [{ label: 'Reset to 0, 0, 0', icon: 'rotate-ccw', variant: 'primary', onClick: resetAlignment }],
        }));
      }
      if (opts().only_fronts) {
        out.push(ui.callout({
          variant: 'info',
          title: 'You print fronts only',
          message: 'Printer alignment only matters when you print fronts and backs (two-sided). You can still set it up now for later.',
          actions: [{ label: 'Make PDF', onClick: () => navigate('pdf') }],
        }));
      }
      return out;
    }

    function jobProgress(kinds, label) {
      const j = runningJob();
      if (!j || !kinds.includes(j.kind)) return null;
      const bar = ui.progressBar({ percent: Number.isFinite(j.progress?.percent) ? j.progress.percent : null, label: j.progress?.label || label });
      refs.progress = bar;
      return h('div.stack', { style: { '--gap': '8px' } }, h('div.small.strong', label), bar);
    }

    function updateProgress() {
      const j = runningJob();
      if (!refs.progress || !j) return;
      refs.progress.update(Number.isFinite(j.progress?.percent) ? j.progress.percent : null, j.progress?.label || '');
    }

    function renderSheetActions() {
      refs.progress = null;
      const parts = [];
      const running = jobProgress(['calibration'], 'Making the sheet…');
      if (running) parts.push(running);
      const p = paperInfo();
      if (calibLoading && !calib) {
        parts.push(h('div.row.small.muted', { style: { '--gap': '8px' } }, ui.spinner(14), 'Looking for the alignment sheet…'));
      } else if (calibError) {
        parts.push(ui.callout({ variant: 'warning', compact: true, title: 'The alignment sheet could not be found', message: calibError, actions: [{ label: 'Try again', icon: 'refresh', onClick: loadCalibration }] }));
      } else if (calib?.path) {
        parts.push(ui.row({ gap: 8 },
          fkWrap('open-sheet', ui.button({ label: 'Open the alignment sheet', icon: 'file-pdf', variant: 'primary', onClick: () => openSheet(calib.path, null) })),
          fkWrap('show-sheet', ui.button({ label: 'Show file', icon: 'folder-open', variant: 'ghost', onClick: () => api.shell.showItemInFolder(calib.path) }))));
      } else if (calib && calib.canGenerate) {
        parts.push(ui.callout({
          variant: 'info',
          compact: true,
          message: p && !p.calibrationIncluded ? CALIBRATION_NOTES.legal : `No alignment sheet ships for ${p ? p.shortLabel : 'this paper'}: the app makes one for you.`,
          actions: [{ label: 'Make the alignment sheet', icon: 'file-pdf', variant: 'primary', disabled: busy(), onClick: generateSheet }],
        }));
      } else if (calib) {
        parts.push(ui.callout({ variant: 'warning', compact: true, message: 'No alignment sheet is available for this paper size.' }));
      }
      const last = session.lastSheet;
      if (last && last.path) {
        const what = last.purpose === 'check' ? 'check sheet' : 'shifted sheet';
        parts.push(ui.row({ gap: 8 },
          h('span.small.muted', `Your ${what} (X ${signed(last.shift.x)}, Y ${signed(last.shift.y)}) is ready.`),
          fkWrap('open-last', ui.button({ label: 'Open it', size: 'sm', variant: 'link', onClick: () => openSheet(last.path, last.shift) }))));
      }
      const s = saved();
      if (s && isNonZero(s)) {
        parts.push(ui.callout({
          variant: 'neutral',
          compact: true,
          icon: 'info',
          title: 'Already saved an alignment?',
          message: `Print the check sheet instead: it includes your alignment (X ${signed(s.x)}, Y ${signed(s.y)}), so the middle square (0, 0) should line up. If another square lines up, type its numbers below and choose “Add”.`,
          actions: [{ label: 'Make the check sheet', icon: 'file-pdf', disabled: busy(), onClick: () => makeShiftedSheet(s, 'check') }],
        }));
      }
      return parts;
    }

    function renderWhichSheet() {
      const b = base();
      if (!isNonZero(b)) return null;
      const cards = ui.radioCards({
        value: mode(),
        columns: 2,
        compact: true,
        ariaLabel: 'Which sheet did you print?',
        options: [
          {
            value: 'add',
            label: 'Add to my current alignment',
            description: `The sheet I printed already includes a correction (X ${signed(b.x)}, Y ${signed(b.y)}).`,
          },
          {
            value: 'replace',
            label: 'Replace my alignment',
            description: 'I printed the plain alignment sheet, without any correction.',
          },
        ],
        onChange: (v) => {
          session.mode = v;
          refresh();
        },
      });
      return ui.field({ label: 'Which sheet did you print?', control: fkWrap('which-sheet', cards) });
    }

    function renderTotal() {
      const t = total();
      if (!t) {
        return h('p.small.muted', 'Type both red numbers of the square that lines up best (the middle square is 0, 0).');
      }
      const b = base();
      const add = mode() === 'add' && isNonZero(b);
      const hint = (from, read) => (add ? `${signed(from)} ${read < 0 ? '−' : '+'} ${format.formatNumber(Math.abs(read))}` : 'from the sheet');
      return h('div.stack', { style: { '--gap': '8px' } },
        h('div.small.strong', 'Your new alignment'),
        ui.grid({ columns: 3, gap: 8 },
          ui.stat({ label: 'X (left / right)', value: signed(t.x), hint: hint(b.x, readX) }),
          ui.stat({ label: 'Y (down / up)', value: signed(t.y), hint: hint(b.y, readY) }),
          ui.stat({ label: 'Rotation', value: `${format.formatNumber(t.angle, { maximumFractionDigits: 2 })}°`, hint: t.angle ? 'degrees' : 'none' })),
        !isNonZero(t) ? h('p.small.text-success', 'All zero: your printer needs no correction.') : null);
    }

    function renderSave() {
      const t = total();
      const parts = [];
      const s = session.saved;
      if (s && Date.now() - s.at < 10 * 60 * 1000) {
        parts.push(ui.callout({
          variant: 'success',
          compact: true,
          title: `Saved: X ${signed(s.value.x)}, Y ${signed(s.value.y)}${s.value.angle ? `, ${s.value.angle}°` : ''}`,
          message: isNonZero(s.value)
            ? 'New PDFs made with “Fronts and backs” shift their back pages by this amount. Check it with a sheet that includes it: the middle square should now line up.'
            : 'Your printer needs no correction.',
          actions: isNonZero(s.value)
            ? [{ label: 'Make a check sheet', icon: 'file-pdf', disabled: busy(), onClick: () => makeShiftedSheet(s.value, 'check') }, { label: 'Make PDF', variant: 'ghost', onClick: () => navigate('pdf') }]
            : [{ label: 'Make PDF', variant: 'ghost', onClick: () => navigate('pdf') }],
        }));
      }
      const disabled = !t || busy();
      parts.push(ui.row({ gap: 12, justify: 'between' },
        h('span.small.muted', busy() ? `Wait until “${runningJob()?.title || 'the current task'}” finishes.` : (t ? 'Saved alignments are used for every new two-sided PDF.' : '')),
        fkWrap('save', ui.button({ label: 'Save alignment', icon: 'save', variant: 'primary', disabled, onClick: saveAlignment }))));
      return parts;
    }

    function renderShifted() {
      const dir = SHIFT_DIRECTIONS.find((d) => d.value === session.shiftDir) || SHIFT_DIRECTIONS[0];
      const amount = Number.isInteger(session.shiftAmount) && session.shiftAmount > 0 ? session.shiftAmount : DEFAULT_SHIFT;
      const b = base();
      const target = { x: b.x + dir.dx * amount, y: b.y + dir.dy * amount, angle: angleValue || 0 };
      return h('div.stack', { style: { '--gap': '10px' } },
        h('p.small', `The new sheet includes a correction of X ${signed(target.x)}, Y ${signed(target.y)}${isNonZero(b) ? ` (your current X ${signed(b.x)}, Y ${signed(b.y)} plus ${amount} steps towards the ${dir.label.toLowerCase()})` : ''}. Print it and find the square that lines up: the numbers you type above are then added to this correction.`),
        h('div', fkWrap('make-shifted', ui.button({ label: 'Make a shifted sheet', icon: 'file-pdf', disabled: busy(), onClick: () => makeShiftedSheet(target, 'shifted') }))));
    }

    function renderAlignmentCard() {
      if (offsetInfo === undefined) {
        return ui.card({ title: 'Your alignment', icon: 'crosshair', children: ui.skeleton({ lines: 3 }) });
      }
      const children = [];
      if (offsetError) {
        children.push(ui.callout({ variant: 'warning', compact: true, title: "Your alignment can't be read right now", message: offsetError, actions: [{ label: 'Try again', icon: 'refresh', onClick: loadOffset }] }));
        return ui.card({ title: 'Your alignment', icon: 'crosshair', children });
      }
      if (offsetInfo && offsetInfo.valid === false) {
        // The prominent callout at the top of the page has the Reset button.
        children.push(ui.callout({ variant: 'danger', compact: true, message: 'The saved alignment file is damaged and can\'t be used. Reset it with the button at the top of the page.' }));
        return ui.card({ title: 'Your alignment', icon: 'crosshair', children });
      }
      const s = saved() || { x: 0, y: 0, angle: 0 };
      const nonZero = isNonZero(s);
      children.push(ui.grid({ columns: 3, gap: 8 },
        ui.stat({ label: 'X', value: signed(s.x), hint: s.x > 0 ? 'right' : (s.x < 0 ? 'left' : null) }),
        ui.stat({ label: 'Y', value: signed(s.y), hint: s.y > 0 ? 'up' : (s.y < 0 ? 'down' : null) }),
        ui.stat({ label: 'Rotation', value: `${format.formatNumber(s.angle, { maximumFractionDigits: 2 })}°` })));
      if (!offsetInfo) children.push(h('p.small.muted', 'Nothing saved yet: two-sided PDFs are printed without correction.'));
      else if (!nonZero) children.push(h('p.small.muted', 'No correction: fronts and backs already line up.'));
      if (nonZero) {
        const o = opts();
        children.push(fkWrap('load-offset', ui.toggle({
          checked: !!o.load_offset,
          label: 'Apply my printer alignment',
          description: o.only_fronts ? 'Used when you make a PDF with “Fronts and backs”.' : 'New two-sided PDFs shift their back pages by this amount.',
          onChange: (v) => setLoadOffset(v),
        })));
        children.push(ui.row({ gap: 8 }, fkWrap('reset', ui.button({ label: 'Reset to 0, 0, 0', icon: 'rotate-ccw', size: 'sm', variant: 'ghost', disabled: busy(), onClick: resetAlignment }))));
      }
      return ui.card({ title: 'Your alignment', icon: 'crosshair', children });
    }

    function renderApply() {
      const a = session.apply;
      const s = saved();
      const parts = [];
      parts.push(h('p.small.muted', 'Shifts the back pages (2, 4, 6…) of a PDF you already made, and saves a copy next to your PDFs. Use it for PDFs made without “Apply my printer alignment”.'));
      parts.push(ui.row({ gap: 8, wrap: false },
        fkWrap('choose-pdf', ui.button({ label: a.path ? 'Choose another PDF…' : 'Choose a PDF…', icon: 'file-pdf', onClick: choosePdf })),
        a.path ? h('span.mono.small.truncate', { title: a.path, style: { flex: '1', minWidth: '0' } }, baseName(a.path)) : null));
      if (a.loading) {
        parts.push(h('div.row.small.muted', { style: { '--gap': '8px' } }, ui.spinner(14), 'Reading the PDF…'));
        return parts;
      }
      if (!a.path) return parts;
      if (a.error) parts.push(ui.callout({ variant: 'warning', compact: true, message: `The PDF could not be read: ${a.error}` }));
      const info = a.info;
      const warnings = [];
      const last = settings().pdf?.lastPdf;
      const sameAsLast = last && typeof last.path === 'string' && last.path.toLowerCase() === a.path.toLowerCase();
      if (sameAsLast && last.loadOffset) warnings.push('This PDF was made with your printer alignment already: aligning it again would shift the backs twice.');
      if (sameAsLast && last.onlyFronts) warnings.push('This PDF has fronts only: aligning it would shift every second front page.');
      if (info && Number(info.pages) % 2 === 1) warnings.push(`This PDF has ${format.pluralize(Number(info.pages), 'page')}: an odd number, so it may not alternate fronts and backs.`);
      if (info) {
        const rows = [['Pages', format.formatNumber(info.pages)]];
        if (Number(info.widthIn) > 0 && Number(info.heightIn) > 0) rows.push(['Page size', `${format.formatNumber(info.widthIn, { maximumFractionDigits: 2 })} x ${format.formatNumber(info.heightIn, { maximumFractionDigits: 2 })} in`]);
        rows.push(['Made at', Number(info.ppi) > 0 ? `${format.formatNumber(Math.round(info.ppi))} PPI` : 'unknown resolution']);
        parts.push(ui.kv(rows));
      }
      for (const w of warnings) parts.push(ui.callout({ variant: 'warning', compact: true, message: w }));
      refs.applyPpi = ui.numberInput({
        value: a.ppi,
        min: 1,
        max: 2400,
        integer: true,
        suffix: 'PPI',
        width: 150,
        ariaLabel: 'Resolution of the aligned PDF',
        onChange: (v) => {
          if (v === null) return;
          session.apply.ppi = v;
          session.apply.confirm = false;
          memorySlot.refresh();
          applyButtonSlot.refresh();
        },
      });
      parts.push(ui.field({
        label: 'Resolution',
        help: OFFSET_OPTIONS.ppi.help,
        hint: 'Keep the resolution the PDF was made with, so it stays sharp.',
        control: fkWrap('apply-ppi', refs.applyPpi),
      }));
      parts.push(memorySlot.el, applyButtonSlot.el);
      memorySlot.refresh(true);
      applyButtonSlot.refresh(true);
      return parts;
    }

    function memoryRatio() {
      const a = session.apply;
      const need = a.info ? alignMemoryBytes(a.info, a.ppi || 300) : null;
      const totalMem = Number(store.get('appInfo')?.totalMemBytes) || 0;
      return { need, totalMem, ratio: need && totalMem ? need / totalMem : 0 };
    }

    const memorySlot = createSlot(() => [session.apply.path, session.apply.ppi, session.apply.confirm, !!session.apply.info], () => {
      const { need, totalMem, ratio } = memoryRatio();
      if (!need) return null;
      const text = `Needs about ${format.formatBytes(need)} of memory${totalMem ? ` (your computer has ${format.formatBytes(totalMem)})` : ''}.`;
      if (ratio > MEMORY_BLOCK_RATIO) {
        return ui.callout({
          variant: 'danger',
          compact: true,
          message: h('span', `${text} That is more than your computer can spare: lower the resolution.`),
          actions: [fkWrap('apply-confirm', ui.checkbox({
            checked: !!session.apply.confirm,
            label: 'Align anyway (other programs may become very slow)',
            onChange: (v) => {
              session.apply.confirm = v;
              memorySlot.refresh();
              applyButtonSlot.refresh();
            },
          }))],
        });
      }
      return h('p.small', { class: ratio > MEMORY_HEAVY_RATIO ? 'text-warning' : 'muted' }, ratio > MEMORY_HEAVY_RATIO ? `${text} Close other programs while it runs.` : text);
    });

    const applyButtonSlot = createSlot(() => [session.apply.path, session.apply.ppi, session.apply.confirm, offsetInfo, runningJob()?.jobId, !!session.apply.info], () => {
      const s = saved();
      const a = session.apply;
      const { ratio } = memoryRatio();
      const blocked = ratio > MEMORY_BLOCK_RATIO && !a.confirm;
      const out = [];
      const outDir = settings().outputDir || store.get('appInfo')?.paths?.output || '';
      const stem = baseName(a.path || '').replace(/\.pdf$/i, '');
      if (!s || !isNonZero(s)) {
        out.push(ui.callout({ variant: 'info', compact: true, message: 'Save an alignment first (step 3): there is nothing to apply yet.' }));
      } else {
        out.push(h('p.small.muted', { title: outDir || undefined }, `Shift: X ${signed(s.x)}, Y ${signed(s.y)}${s.angle ? `, ${s.angle}°` : ''}. Saved as ${stem}_offset.pdf${outDir ? ` in ${shortPath(outDir, 3)}` : ''}.`));
      }
      out.push(ui.row({ justify: 'end' }, fkWrap('apply-run', ui.button({
        label: 'Align this PDF',
        icon: 'crosshair',
        variant: 'primary',
        disabled: !s || !isNonZero(s) || blocked || busy() || !a.path,
        onClick: applyToPdf,
      }))));
      return out;
    });

    function renderApplyProgress() {
      refs.applyProgress = null;
      const j = runningJob();
      if (!j || j.kind !== 'offset') return null;
      const bar = ui.progressBar({ percent: Number.isFinite(j.progress?.percent) ? j.progress.percent : null, label: j.progress?.label || 'Aligning the PDF…' });
      refs.applyProgress = bar;
      return h('div.stack', { style: { '--gap': '8px' } }, h('div.small.strong', 'Aligning the PDF…'), bar);
    }

    function renderApplyResult() {
      const r = store.get('lastResults')?.offset;
      if (!r || !session.jobs.has(r.jobId)) return null;
      if (r.status === 'failed') {
        return ui.callout({ variant: 'danger', compact: true, title: 'The PDF could not be aligned', message: r.error?.message || 'Open Details in the bar at the bottom to see what happened.' });
      }
      if (r.status !== 'succeeded') return null;
      const path = resultPath(r.result);
      return ui.callout({
        variant: 'success',
        title: 'Aligned PDF ready',
        message: path ? h('span.mono.small', { title: path }, baseName(path)) : 'The aligned copy was saved next to your PDFs.',
        actions: path ? [
          { label: 'Open PDF', icon: 'file-pdf', variant: 'primary', onClick: () => api.shell.openPath(path) },
          { label: 'Show in folder', icon: 'folder-open', onClick: () => api.shell.showItemInFolder(path) },
        ] : null,
      });
    }

    function stepText(id, values) {
      const step = CALIBRATION_STEPS.find((s) => s.id === id);
      return step ? fillPlaceholders(step.text, values) : '';
    }

    /* ------------------------------ build ------------------------------ */

    function refresh(force = false) {
      if (disposed) return;
      for (const s of slots) s.refresh(force);
      updateProgress();
      if (refs.applyProgress) {
        const j = runningJob();
        if (j && j.kind === 'offset') refs.applyProgress.update(Number.isFinite(j.progress?.percent) ? j.progress.percent : null, j.progress?.label || '');
      }
    }

    function build() {
      slots = [memorySlot, applyButtonSlot];
      refs = {};
      const slot = (deps, render) => {
        const s = createSlot(deps, render);
        slots.push(s);
        return s.el;
      };
      const values = { paper: paperInfo()?.label || paper() };

      // Step 1
      const paperSelect = ui.select({
        value: paper(),
        options: PAPER_SIZES.map((x) => ({ value: x.name, label: x.label })),
        ariaLabel: 'Paper size of the alignment sheet',
        onChange: (v) => {
          session.paper = v;
          calib = null;
          loadCalibration();
          refresh();
        },
      });
      const step1 = ui.card({
        title: '1. Print the alignment sheet',
        subtitle: 'Two pages: a grid of squares on the front, the same squares with small red numbers on the back.',
        icon: 'printer',
        children: [
          ui.field({ label: 'Paper', hint: 'Use the paper and card stock you print your cards on.', control: fkWrap('paper', paperSelect) }),
          slot(() => [paper()], () => h('p.small', stepText('print', { paper: paperInfo()?.label || paper() }))),
          slot(() => [calib, calibLoading, calibError, runningJob()?.jobId, runningJob()?.kind, session.lastSheet?.path, offsetInfo, paper()], renderSheetActions),
        ],
      });

      // Step 2
      const step2 = ui.card({
        title: '2. Find the square that lines up',
        icon: 'eye',
        children: [
          h('p.small', stepText('look', values)),
          h('p.small', stepText('find', values)),
          h('p.small.muted', CALIBRATION_NOTES.units),
        ],
      });

      // Step 3
      refs.xInput = ui.numberInput({
        value: readX,
        min: -READING_LIMIT,
        max: READING_LIMIT,
        integer: true,
        width: 130,
        placeholder: '0',
        ariaLabel: 'First red number (X)',
        onChange: (v) => {
          readX = Number.isInteger(v) ? v : null;
          refresh();
        },
      });
      refs.yInput = ui.numberInput({
        value: readY,
        min: -READING_LIMIT,
        max: READING_LIMIT,
        integer: true,
        width: 130,
        placeholder: '0',
        ariaLabel: 'Second red number (Y)',
        onChange: (v) => {
          readY = Number.isInteger(v) ? v : null;
          refresh();
        },
      });
      refs.angleInput = ui.numberInput({
        value: angleValue,
        min: -ANGLE_LIMIT,
        max: ANGLE_LIMIT,
        step: 0.1,
        width: 130,
        suffix: '°',
        ariaLabel: 'Rotation in degrees',
        onChange: (v) => {
          angleTouched = true;
          angleValue = Number.isFinite(v) ? v : 0;
          refresh();
        },
      });
      const angleField = ui.field({
        label: OFFSET_OPTIONS.angle.label,
        help: OFFSET_OPTIONS.angle.help,
        hint: 'Usually between -1 and 1. Try 0.1 to 0.3 first.',
        control: fkWrap('angle', refs.angleInput),
      });
      // A compact disclosure (a nested section heading would be bigger than the card title).
      const rotation = slot(() => [session.showRotation, angleValue !== 0], () => {
        const open = session.showRotation;
        const toggleBtn = ui.button({
          label: open ? 'Hide rotation' : 'Advanced: rotation',
          variant: 'link',
          size: 'sm',
          iconRight: open ? 'chevron-up' : 'chevron-down',
          attrs: { 'aria-expanded': String(open) },
          onClick: () => {
            session.showRotation = !open;
            refresh();
          },
        });
        return h('div.stack', { style: { '--gap': '10px' } },
          ui.row({ gap: 8 },
            fkWrap('rotation-toggle', toggleBtn),
            !open ? h('span.small.muted', angleValue !== 0
              ? `Rotation: ${format.formatNumber(angleValue, { maximumFractionDigits: 2 })}°`
              : 'Rarely needed: only when cards near opposite edges are off in opposite directions.') : null),
          open ? h('div.stack', { style: { '--gap': '12px' } }, h('p.small.muted', CALIBRATION_NOTES.rotation), angleField) : null);
      });
      const step3 = ui.card({
        title: '3. Type the two red numbers',
        subtitle: 'Of the square where front and back line up best.',
        icon: 'crosshair',
        children: [
          ui.row({ gap: 16, align: 'flex-start' },
            ui.field({ label: 'First number (X)', hint: 'Left / right', control: fkWrap('x', refs.xInput) }),
            ui.field({ label: 'Second number (Y)', hint: 'Down / up', control: fkWrap('y', refs.yInput) })),
          slot(() => [base(), mode(), session.mode], renderWhichSheet),
          slot(() => [total(), base(), mode()], renderTotal),
          rotation,
          slot(() => [!!total(), runningJob()?.jobId, session.saved?.at], renderSave),
        ],
      });

      // No match
      const dirSeg = ui.segmented({
        value: session.shiftDir,
        options: SHIFT_DIRECTIONS.map((d) => ({ value: d.value, label: d.label, icon: d.icon })),
        ariaLabel: 'Where are the squares closest to lining up?',
        onChange: (v) => {
          session.shiftDir = v;
          refresh();
        },
      });
      const amountInput = ui.numberInput({
        value: session.shiftAmount,
        min: 1,
        max: 300,
        integer: true,
        width: 120,
        suffix: 'steps',
        ariaLabel: 'Shift amount in steps',
        onChange: (v) => {
          if (!Number.isInteger(v) || v < 1) return;
          session.shiftAmount = v;
          refresh();
        },
      });
      const noMatch = ui.card({
        title: 'No square lines up?',
        icon: 'search',
        children: [
          h('p.small', CALIBRATION_NOTES.noMatch),
          ui.row({ gap: 16, align: 'flex-end' },
            ui.field({ label: 'Where are the squares closest to lining up?', hint: 'As seen when looking at the back of the sheet.', control: fkWrap('shift-dir', dirSeg) }),
            ui.field({ label: 'Shift by', control: fkWrap('shift-amount', amountInput) })),
          slot(() => [session.shiftDir, session.shiftAmount, base(), angleValue, runningJob()?.jobId], renderShifted),
        ],
      });

      // Advanced: existing PDF
      const apply = ui.section({
        title: 'Advanced: align an existing PDF',
        description: 'Correct a PDF you already made, instead of making it again.',
        icon: 'file-pdf',
        collapsible: true,
        collapsed: !session.applyOpen,
        onToggle: (collapsed) => { session.applyOpen = !collapsed; },
        children: ui.card({
          children: [
            slot(() => [session.apply.path, session.apply.loading, session.apply.error, session.apply.info, settings().pdf?.lastPdf], renderApply),
            slot(() => [runningJob()?.jobId, runningJob()?.kind], renderApplyProgress),
            slot(() => [store.get('lastResults')?.offset?.jobId, store.get('lastResults')?.offset?.status], renderApplyResult),
          ],
        }),
      });

      // Aside
      const docs = getHelpLink('offsetDocs');
      const trouble = getHelpLink('troubleshooting');
      const notes = ui.card({
        title: 'Good to know',
        icon: 'info',
        children: [
          h('ul.prose.small', { style: { margin: '0', paddingLeft: '18px' } },
            h('li', CALIBRATION_NOTES.units),
            h('li', CALIBRATION_NOTES.doubleCorrection),
            h('li', 'Redo the alignment after changing printer, paper size or card stock.')),
          h('div.stack', { style: { '--gap': '4px' } },
            docs ? h('div', ui.button({ label: docs.label, variant: 'link', size: 'sm', iconRight: 'external-link', onClick: () => api.shell.openExternal(docs.url) })) : null,
            trouble ? h('div', ui.button({ label: trouble.label, variant: 'link', size: 'sm', iconRight: 'external-link', onClick: () => api.shell.openExternal(trouble.url) })) : null),
        ],
      });

      const header = ui.pageHeader({
        title: 'Printer alignment',
        subtitle: CALIBRATION_NOTES.intro,
        icon: 'crosshair',
        step: 'One-time setup',
      });

      const main = [step1, step2, step3, noMatch, apply];
      const aside = [slot(() => [offsetInfo, offsetError, settings().pdf?.options?.load_offset, settings().pdf?.options?.only_fronts, runningJob()?.jobId], renderAlignmentCard), notes];
      const footer = slot(() => [isNonZero(saved()), opts().only_fronts, !!opts().load_offset], () => {
        const nonZero = isNonZero(saved());
        const o = opts();
        let text = 'Alignment done?';
        let detail = 'Save the numbers from your sheet above, then make your PDF with “Fronts and backs”.';
        let tone = 'neutral';
        if (nonZero && !o.load_offset) {
          text = 'Your alignment is saved but not used';
          detail = 'Turn on “Apply my printer alignment” (under Your alignment) so new two-sided PDFs use it.';
          tone = 'warning';
        } else if (nonZero) {
          text = 'Your alignment is saved';
          detail = o.only_fronts
            ? 'It is used when you choose “Fronts and backs” in Make PDF.'
            : 'Your next two-sided PDF will line up the backs.';
          tone = 'success';
        }
        return nextStep({
          text,
          detail,
          actionLabel: 'Make PDF',
          icon: tone === 'success' ? 'check-circle' : (tone === 'warning' ? 'alert-triangle' : 'file-pdf'),
          tone,
          onAction: () => navigate('pdf'),
        });
      });

      ui.mountInto(container,
        header,
        slot(() => [offsetInfo?.valid, offsetInfo?.error, opts().only_fronts], renderTopNotices),
        ui.twoColumn({ main, aside, asideWidth: 320 }),
        footer);
    }

    /* ------------------------------ subscriptions ------------------------------ */

    ctx.subscribe('settings', () => refresh());
    // Slots depend on the running job id/kind; progress bars are updated in place by refresh().
    ctx.subscribe('job', () => refresh());
    ctx.subscribe('lastResults', (next, prev) => {
      for (const kind of ['calibration', 'offset']) {
        const r = next?.[kind];
        if (r && r.jobId !== prev?.[kind]?.jobId) handleFinished(r, { autoOpen: true });
      }
      refresh();
    });

    /* ------------------------------ start ------------------------------ */

    // A job started from this page may have finished while the page was closed.
    const results = store.get('lastResults') || {};
    for (const kind of ['calibration', 'offset']) {
      if (results[kind]) handleFinished(results[kind], { autoOpen: false });
    }
    build();
    refresh(true);
    loadOffset();
    loadCalibration();

    return () => {
      disposed = true;
    };
  },
};
