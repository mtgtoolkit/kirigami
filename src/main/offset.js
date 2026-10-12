'use strict';

/**
 * offset.js — printer alignment (spec §9.9): the saved offset file, calibration sheets (bundled or
 * generated, e.g. Legal), shifted calibration sheets, applying an alignment to an existing PDF, and
 * PDF inspection.
 *
 * - The offset file is `<workspace>/data/offset_data.json` (the engine reads it relative to its working
 *   folder). The engine validates it with pydantic `OffsetData(x_offset:int, y_offset:int,
 *   angle_offset:float=0.0)` and CRASHES on invalid values (it catches the wrong ValidationErr class),
 *   so the app only writes integers for x/y and readOffset() mirrors pydantic's lax coercion.
 * - offset_pdf.py always loads the saved offset first and only replaces the values passed on the
 *   command line. The app always passes all three values and runs it in a scratch working folder
 *   (absolute paths everywhere), so a damaged offset file can never break these jobs.
 *
 * No require('electron'): everything comes through `deps` (spec §12).
 */

const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const util = require('./util');
const { userError } = require('./errors');
const { moveIntoPlace, lockedCode } = require('./pdf');

const OFFSET_LIMIT = 100000;
const ANGLE_LIMIT = 360;
const MEMORY_ERROR_FRACTION = 0.85;
const MEMORY_WARNING_FRACTION = 0.5;
const CALIBRATION_PPI = 300;
const SHIFTED_KEEP = 10;
const PAGE_LINE_RE = /^Page (\d+)\s*$/;
const HELPER_PASS_THROUGH_CODES = new Set([
  'NOT_INSTALLED', 'HELPER_MISSING', 'PYTHON_START_FAILED', 'BLOCKED', 'PYTHON_SETUP', 'PYTHON_BUSY', 'TIMEOUT', 'CANCELLED',
]);

function isObj(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function settingsOf(deps) {
  try {
    const s = deps && deps.settings && typeof deps.settings.get === 'function' ? deps.settings.get() : null;
    return isObj(s) ? s : {};
  } catch {
    return {};
  }
}

async function statSafe(p) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function isCancel(err, ctx) {
  return (ctx && ctx.cancelled) || (err && (err.name === 'CancelledError' || err.code === 'CANCELLED'));
}

function totalMemoryOf(deps) {
  const seam = deps && deps.totalMemBytes;
  const v = typeof seam === 'function' ? seam() : seam;
  return Number.isFinite(v) && v > 0 ? v : os.totalmem();
}

/**
 * pydantic 2 lax `int` (checked against the engine's pydantic 2.13): int, integral float, bool, and
 * strings like " +12 ", "1_000" or "12.0" (ASCII digits only; "1e3", "0x10", "12.5" fail). null when
 * the engine would reject the value.
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceInt(v) {
  let n = null;
  if (typeof v === 'number') n = Number.isInteger(v) ? v : null;
  else if (typeof v === 'boolean') n = v ? 1 : 0;
  else if (typeof v === 'string' && /^\s*[-+]?[0-9]+(?:_[0-9]+)*(?:\.0+)?\s*$/.test(v)) {
    const parsed = Number(v.trim().replace(/_/g, '').replace(/\.0+$/, ''));
    n = Number.isFinite(parsed) && Number.isInteger(parsed) ? parsed : null;
  }
  return n === null ? null : n || 0; // no -0
}

/**
 * pydantic 2 lax `float` (number, bool, numeric string with spaces), restricted to FINITE values: the
 * engine would accept "nan"/"inf" and then fail while rotating the pages.
 * @param {unknown} v
 * @returns {number|null}
 */
function coerceFloat(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'boolean') n = v ? 1 : 0;
  else if (typeof v === 'string' && /^\s*[-+]?(?:[0-9]+(?:_[0-9]+)*(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?\s*$/.test(v)) {
    n = Number(v.trim().replace(/_/g, ''));
  }
  return Number.isFinite(n) ? n || 0 : null;
}

// ---------------------------------------------------------------------------------------------
// The saved offset
// ---------------------------------------------------------------------------------------------

/**
 * Read `<workspace>/data/offset_data.json`.
 * @param {object} deps
 * @returns {Promise<{ x_offset: number|null, y_offset: number|null, angle_offset: number|null, valid: boolean, error: string|null }|null>}
 *   null when no alignment is saved
 */
async function readOffset(deps) {
  const file = deps.getPaths().dataPath;
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    return { x_offset: null, y_offset: null, angle_offset: null, valid: false, error: 'The saved printer alignment could not be read.' };
  }
  const damaged = { x_offset: null, y_offset: null, angle_offset: null, valid: false, error: 'The saved printer alignment file is damaged.' };
  const bom = text.charCodeAt(0) === 0xfeff;
  let data;
  try {
    data = JSON.parse(bom ? text.slice(1) : text);
  } catch {
    return damaged;
  }
  if (bom && isObj(data)) {
    // Python's json.load refuses a UTF-8 BOM: the engine would silently print without the alignment.
    return {
      ...damaged,
      x_offset: coerceInt(data.x_offset),
      y_offset: coerceInt(data.y_offset),
      angle_offset: data.angle_offset === undefined ? 0 : coerceFloat(data.angle_offset),
      error: 'The saved printer alignment file was changed by another program and the card maker can\'t read it. Save your alignment again, or reset it.',
    };
  }
  if (!isObj(data)) return damaged;
  const x = coerceInt(data.x_offset);
  const y = coerceInt(data.y_offset);
  const angle = data.angle_offset === undefined ? 0 : coerceFloat(data.angle_offset);
  const problems = [];
  if (x === null) problems.push('the horizontal shift (x) is not a whole number');
  if (y === null) problems.push('the vertical shift (y) is not a whole number');
  if (angle === null) problems.push('the rotation is not a number');
  return {
    x_offset: x,
    y_offset: y,
    angle_offset: angle,
    valid: problems.length === 0,
    error: problems.length ? `The saved printer alignment is invalid: ${problems.join(', ')}.` : null,
  };
}

/**
 * Save the alignment (x/y rounded to whole pixels at 300 PPI, angle in degrees). After saving a
 * non-zero alignment, "Apply my printer alignment" (pdf.options.load_offset) is switched on (it only
 * has an effect for two-sided PDFs).
 * @param {object} deps
 * @param {{ x_offset: number|string, y_offset: number|string, angle_offset?: number|string }} v
 * @returns {Promise<object>} readOffset() after saving
 */
async function writeOffset(deps, v) {
  const value = isObj(v) ? v : {};
  const num = (raw) => (typeof raw === 'string' ? Number(raw.trim().replace(',', '.')) : Number(raw));
  const x = Math.round(num(value.x_offset));
  const y = Math.round(num(value.y_offset));
  const angleRaw = value.angle_offset === undefined || value.angle_offset === null || value.angle_offset === '' ? 0 : num(value.angle_offset);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(angleRaw)) {
    throw userError('The alignment values must be numbers.', { code: 'INVALID_OFFSET' });
  }
  if (Math.abs(x) > OFFSET_LIMIT || Math.abs(y) > OFFSET_LIMIT || Math.abs(angleRaw) > ANGLE_LIMIT) {
    throw userError('These alignment values are far too large. Check the numbers on your calibration sheet.', { code: 'INVALID_OFFSET' });
  }
  const angle = Math.round(angleRaw * 10000) / 10000 || 0;
  const data = { x_offset: x || 0, y_offset: y || 0, angle_offset: angle };
  const file = deps.getPaths().dataPath;
  try {
    await util.atomicWriteFile(file, `${JSON.stringify(data, null, 4)}\n`);
  } catch (err) {
    throw userError('The printer alignment could not be saved. Check that the card maker data folder is writable.', {
      code: 'OFFSET_WRITE_FAILED', details: String(err && err.message), cause: err,
    });
  }
  if ((data.x_offset || data.y_offset || data.angle_offset) && deps.settings && typeof deps.settings.update === 'function') {
    try {
      deps.settings.update({ pdf: { options: { load_offset: true } } });
    } catch { /* settings are best effort here */ }
  }
  return readOffset(deps);
}

/**
 * Reset the alignment to 0, 0, 0.
 * @param {object} deps
 * @returns {Promise<object>} readOffset() after saving
 */
async function resetOffset(deps) {
  return writeOffset(deps, { x_offset: 0, y_offset: 0, angle_offset: 0 });
}

// ---------------------------------------------------------------------------------------------
// Calibration sheets
// ---------------------------------------------------------------------------------------------

/**
 * Paper sizes known to an engine folder, merged like utilities.load_layout_config():
 * assets/layouts.json, then assets/extra_layouts/*.json in file name order.
 * @param {string} root engine folder
 * @returns {Promise<{ names: string[], aliases: Record<string, string> }|null>} null without layouts.json
 */
async function readPaperSizes(root) {
  const main = util.readJson(path.join(root, 'assets', 'layouts.json'), null);
  if (!isObj(main) || !isObj(main.paper_sizes)) return null;
  const names = [];
  const aliases = {};
  const add = (sizes) => {
    if (!isObj(sizes)) return;
    for (const [name, def] of Object.entries(sizes)) {
      if (!names.includes(name)) names.push(name);
      for (const alias of Array.isArray(def && def.aliases) ? def.aliases : []) aliases[String(alias).toLowerCase()] = name;
    }
  };
  add(main.paper_sizes);
  let extras = [];
  try {
    extras = (await fsp.readdir(path.join(root, 'assets', 'extra_layouts'))).filter((n) => /\.json$/i.test(n)).sort();
  } catch { /* no extra layouts */ }
  for (const name of extras) {
    const data = util.readJson(path.join(root, 'assets', 'extra_layouts', name), null);
    if (isObj(data)) add(data.paper_sizes);
  }
  return { names, aliases };
}

/**
 * The engine folder that makes calibration sheets: the workspace when it has
 * generate_calibration.py (its own scripts and layouts, extra layouts included), else the bundled
 * engine. `script` is null when neither has the script.
 * @param {object} paths deps.getPaths()
 * @returns {Promise<{ root: string|null, script: string|null, names: string[], aliases: Record<string, string> }>}
 */
async function calibrationEngine(paths) {
  const roots = [paths.workspaceDir, paths.engineSourceDir].filter((r, i, all) => r && all.findIndex((o) => util.samePath(o, r)) === i);
  for (const root of roots) {
    const script = path.join(root, 'generate_calibration.py');
    if (!(await statSafe(script))) continue;
    const sizes = await readPaperSizes(root);
    if (sizes) return { root, script, ...sizes };
  }
  for (const root of roots.slice().reverse()) {
    const sizes = await readPaperSizes(root);
    if (sizes) return { root, script: null, ...sizes };
  }
  return { root: null, script: null, names: [], aliases: {} };
}

/**
 * Canonical paper name ('ANSI_A' → 'letter'); null when unknown.
 * @param {{ names: string[], aliases: Record<string, string> }} sizes
 * @param {string} paper
 * @returns {string|null}
 */
function resolvePaper(sizes, paper) {
  const p = String(paper || '').trim().toLowerCase();
  if (!p) return null;
  const exact = sizes.names.find((n) => n.toLowerCase() === p);
  if (exact) return exact;
  return sizes.aliases[p] || null;
}

/**
 * Paper name for messages: 'a4' → 'A4', 'arch_b' → 'Arch B', 'letter' → 'Letter'.
 * @param {string} name
 * @returns {string}
 */
function paperLabel(name) {
  const s = String(name || '');
  if (/^[abc]\d+$/i.test(s)) return s.toUpperCase();
  return s.split('_').map((w) => (w.length <= 1 ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}

function generatedCalibrationDir(paths) {
  return path.join(paths.scmCacheDir, 'calibration');
}

async function usablePdf(file) {
  const st = await statSafe(file);
  return !!(st && st.isFile() && st.size > 0);
}

/**
 * Calibration sheet for a paper: the bundled `calibration/<paper>-calibration.pdf` (engine, then the
 * workspace's own calibration folder), else one generated earlier under
 * `<scmCacheDir>/calibration/calibration/`.
 * @param {object} deps
 * @param {string} paper paper name or alias
 * @returns {Promise<{ path: string|null, canGenerate: boolean, generated: boolean, paper: string|null, error?: string }>}
 */
async function calibrationFor(deps, paper) {
  const paths = deps.getPaths();
  const engine = await calibrationEngine(paths);
  const canonical = resolvePaper(engine, paper);
  if (!canonical) return { path: null, canGenerate: false, generated: false, paper: null, error: `Unknown paper size "${paper}".` };
  const canGenerate = !!engine.script;
  const name = `${canonical}-calibration.pdf`;
  const bundled = [path.join(paths.calibrationDir, name)];
  const workspaceSheet = path.join(paths.workspaceDir, 'calibration', name);
  if (!util.samePath(workspaceSheet, bundled[0])) bundled.push(workspaceSheet);
  for (const file of bundled) {
    if (await usablePdf(file)) return { path: file, canGenerate, generated: false, paper: canonical };
  }
  const generated = path.join(generatedCalibrationDir(paths), 'calibration', name);
  if (await usablePdf(generated)) return { path: generated, canGenerate, generated: true, paper: canonical };
  return { path: null, canGenerate, generated: false, paper: canonical };
}

function requireJobs(deps) {
  if (!deps || !deps.jobs || typeof deps.jobs.start !== 'function') throw userError('Part of the app is missing (jobs).', { code: 'SERVICE_UNAVAILABLE' });
  const active = typeof deps.jobs.active === 'function' ? deps.jobs.active() : null;
  if (active) throw userError(`BUSY: wait until "${active.title || 'the current task'}" finishes`, { code: 'BUSY' });
}

async function requirePython(paths) {
  const st = await statSafe(paths.pythonPath);
  if (!st || !st.isFile()) throw userError('The card maker components are not installed yet. Open Setup to install them.', { code: 'NOT_INSTALLED' });
}

/**
 * Run generate_calibration.py inside a job. The script writes `calibration/<paper>-calibration.pdf`
 * for EVERY paper size relative to its working folder, so it runs in `<scmCacheDir>/calibration`
 * (never inside the engine). Returns the requested paper's sheet.
 */
async function generateInJob(ctx, paths, engine, paper) {
  const outDir = generatedCalibrationDir(paths);
  await fsp.mkdir(path.join(outDir, 'calibration'), { recursive: true });
  // The script writes into <cwd>/calibration in place: run it in a per-job folder and move the
  // finished sheets afterwards, so a cancelled run never leaves a truncated sheet that would be reused.
  const workDir = path.join(outDir, `.job-${ctx.jobId}`);
  await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
  await fsp.mkdir(path.join(workDir, 'calibration'), { recursive: true });
  const paperCount = engine.names.length;
  let done = 0;
  ctx.progress({ percent: null, label: 'Making the calibration sheets…' });
  try {
    await ctx.spawn(paths.pythonPath, [engine.script], {
      cwd: workDir,
      env: ctx.pythonEnv(),
      name: 'the card maker',
      onLine: (line, stream) => {
        if (stream === 'stdout' && /^Calibration PDF: /.test(line)) {
          done += 1;
          if (paperCount > 0) ctx.progress({ current: Math.min(done, paperCount), total: paperCount, label: `Calibration sheet ${Math.min(done, paperCount)} of ${paperCount}` });
        }
      },
    });
    ctx.throwIfCancelled();
    for (const name of await fsp.readdir(path.join(workDir, 'calibration'))) {
      if (!/-calibration\.pdf$/i.test(name)) continue;
      await util.moveFile(path.join(workDir, 'calibration', name), path.join(outDir, 'calibration', name));
    }
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
  const target = path.join(outDir, 'calibration', `${paper}-calibration.pdf`);
  if (!(await usablePdf(target))) {
    throw userError(`The calibration sheet for ${paperLabel(paper)} paper could not be made.`, { code: 'NO_OUTPUT' });
  }
  return target;
}

/**
 * Start a 'calibration' job that generates the calibration sheets (needed for papers without a
 * bundled sheet, e.g. Legal).
 * @param {object} deps
 * @param {string} paper paper name or alias
 * @returns {Promise<{ jobId: string }>} job result: { path, paper }
 */
async function startGenerateCalibrationJob(deps, paper) {
  requireJobs(deps);
  const paths = deps.getPaths();
  const engine = await calibrationEngine(paths);
  const canonical = resolvePaper(engine, paper);
  if (!canonical) throw userError(`Unknown paper size "${paper}".`, { code: 'UNKNOWN_PAPER' });
  if (!engine.script) throw userError('The calibration sheet maker is missing. Please reinstall Kirigami.', { code: 'ENGINE_MISSING' });
  await requirePython(paths);
  const jobId = deps.jobs.start('calibration', {
    title: `Making the ${paperLabel(canonical)} calibration sheet`,
    steps: [{ id: 'generate', label: 'Make the calibration sheet' }],
  }, async (ctx) => {
    ctx.step('generate', 'running');
    const target = await generateInJob(ctx, paths, engine, canonical);
    ctx.step('generate', 'done');
    return { path: target, paper: canonical };
  });
  return { jobId };
}

function offsetScript(paths) {
  return path.join(paths.workspaceDir, 'offset_pdf.py');
}

async function resolveOffsetScript(paths) {
  for (const candidate of [offsetScript(paths), path.join(paths.engineSourceDir, 'offset_pdf.py')]) {
    if (await statSafe(candidate)) return candidate;
  }
  throw userError(`The card maker files were not found in ${paths.workspaceDir}. Open Settings and choose Repair components.`, { code: 'ENGINE_MISSING' });
}

function formatAngle(angle) {
  const a = Math.round(Number(angle) * 10000) / 10000 || 0;
  return String(a);
}

/**
 * Validate an alignment request: x/y rounded to whole pixels, angle in degrees; missing values are 0,
 * anything not a finite number (or absurdly large) is refused.
 * @param {unknown} rawX
 * @param {unknown} rawY
 * @param {unknown} rawAngle
 * @returns {{ x: number, y: number, angle: number }}
 */
function alignmentValues(rawX, rawY, rawAngle) {
  const num = (v) => {
    if (v === undefined || v === null || v === '') return 0;
    const n = typeof v === 'string' ? Number(v.trim().replace(',', '.')) : typeof v === 'number' ? v : Number.NaN;
    return Number.isFinite(n) ? n : null;
  };
  const xs = num(rawX);
  const ys = num(rawY);
  const as = num(rawAngle);
  if (xs === null || ys === null || as === null) {
    throw userError('The alignment values must be numbers.', { code: 'INVALID_OFFSET' });
  }
  const x = Math.round(xs) || 0;
  const y = Math.round(ys) || 0;
  const angle = Math.round(as * 10000) / 10000 || 0;
  if (Math.abs(x) > OFFSET_LIMIT || Math.abs(y) > OFFSET_LIMIT || Math.abs(angle) > ANGLE_LIMIT) {
    throw userError('These alignment values are far too large. Check the numbers on your calibration sheet.', { code: 'INVALID_OFFSET' });
  }
  return { x, y, angle };
}

/**
 * offset_pdf.py inside a job: writes a partial file next to `outputPath`, renames it into place.
 * @returns {Promise<{ path: string, fallback: boolean, pages: number|null }>}
 */
async function runOffsetPdf(ctx, paths, { script, pdfPath, outputPath, x, y, angle, ppi, pages }) {
  const scratch = path.join(paths.scmCacheDir, 'tmp', `offset-${ctx.jobId}`);
  const partial = path.join(path.dirname(outputPath), `.${path.basename(outputPath, path.extname(outputPath))}.partial-${ctx.jobId}.pdf`);
  await fsp.mkdir(scratch, { recursive: true });
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  let nonexistent = false;
  let saved = false;
  let lastPage = 0;
  try {
    await ctx.spawn(paths.pythonPath, [
      script,
      `--pdf_path=${pdfPath}`,
      `--output_pdf_path=${partial}`,
      `--x_offset=${x}`,
      `--y_offset=${y}`,
      `--angle=${formatAngle(angle)}`,
      `--ppi=${ppi}`,
    ], {
      cwd: scratch,
      env: ctx.pythonEnv(),
      name: 'the card maker',
      onLine: (line, stream) => {
        if (stream !== 'stdout') return;
        const m = PAGE_LINE_RE.exec(line);
        if (m) {
          lastPage = Number(m[1]);
          if (pages && lastPage >= pages) ctx.progress({ percent: null, current: lastPage, total: pages, label: 'Saving the PDF…' });
          else ctx.progress({ current: lastPage, total: pages || null, percent: pages ? undefined : null, label: pages ? `Page ${lastPage} of ${pages}` : `Page ${lastPage}` });
        } else if (/Cannot offset nonexistent PDF/.test(line)) {
          nonexistent = true;
        } else if (/^Offset PDF: /.test(line)) {
          saved = true;
        }
      },
    });
    ctx.throwIfCancelled();
    if (nonexistent) throw userError(`Could not find "${path.basename(pdfPath)}".`, { code: 'PDF_MISSING' });
    const st = await statSafe(partial);
    if (!saved || !st || !st.isFile() || st.size === 0) throw userError('The aligned PDF was not saved. See the log for details.', { code: 'NO_OUTPUT' });
    const moved = await moveIntoPlace(partial, outputPath);
    return { ...moved, pages: lastPage || pages || null };
  } finally {
    await fsp.rm(partial, { force: true }).catch(() => {});
    await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Start a 'calibration' job making a calibration sheet whose back page is shifted by (x, y, angle)
 * (generates the plain sheet first when the paper has none).
 * @param {object} deps
 * @param {{ paper: string, x: number, y: number, angle: number }} req
 * @returns {Promise<{ jobId: string }>} job result: { path, paper, x, y, angle }
 */
async function startShiftedCalibrationJob(deps, req) {
  requireJobs(deps);
  const r = isObj(req) ? req : {};
  const paths = deps.getPaths();
  const { x, y, angle } = alignmentValues(r.x, r.y, r.angle);
  const info = await calibrationFor(deps, r.paper);
  if (!info.paper) throw userError(info.error || `Unknown paper size "${r.paper}".`, { code: 'UNKNOWN_PAPER' });
  if (!info.path && !info.canGenerate) throw userError('The calibration sheet maker is missing. Please reinstall Kirigami.', { code: 'ENGINE_MISSING' });
  await requirePython(paths);
  const script = await resolveOffsetScript(paths);
  const engine = info.path ? null : await calibrationEngine(paths);
  const steps = [];
  if (!info.path) steps.push({ id: 'generate', label: 'Make the calibration sheet' });
  steps.push({ id: 'shift', label: 'Shift the back page' });
  const outDir = generatedCalibrationDir(paths);
  const outputPath = path.join(outDir, `${info.paper}-shifted-${x}_${y}_${formatAngle(angle)}.pdf`);
  const jobId = deps.jobs.start('calibration', { title: `Making a shifted ${paperLabel(info.paper)} calibration sheet`, steps }, async (ctx) => {
    let source = info.path;
    if (!source) {
      ctx.step('generate', 'running');
      source = await generateInJob(ctx, paths, engine, info.paper);
      ctx.step('generate', 'done');
    }
    ctx.step('shift', 'running');
    await pruneShiftedSheets(outDir, outputPath);
    const moved = await runOffsetPdf(ctx, paths, {
      script, pdfPath: source, outputPath, x, y, angle, ppi: CALIBRATION_PPI, pages: 2,
    });
    ctx.step('shift', 'done');
    return { path: moved.path, paper: info.paper, x, y, angle };
  });
  return { jobId };
}

/**
 * Keep the newest shifted calibration sheets only (they pile up while a user tries offsets).
 * @param {string} dir <scmCacheDir>/calibration
 * @param {string} keepPath the sheet about to be (re)made
 * @param {number} [keep=10]
 */
async function pruneShiftedSheets(dir, keepPath, keep = SHIFTED_KEEP) {
  let names;
  try {
    names = (await fsp.readdir(dir)).filter((n) => /-shifted-.*\.pdf$/i.test(n) && !n.startsWith('.'));
  } catch {
    return;
  }
  const entries = [];
  for (const name of names) {
    const full = path.join(dir, name);
    if (util.samePath(full, keepPath)) continue;
    const st = await statSafe(full);
    if (st && st.isFile()) entries.push({ full, mtimeMs: st.mtimeMs });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const e of entries.slice(Math.max(0, keep - 1))) await fsp.rm(e.full, { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------------------------
// Applying an alignment to an existing PDF
// ---------------------------------------------------------------------------------------------

/**
 * Pages, size and resolution of a PDF (helper pdf-info) plus a memory estimate for offset_pdf.
 * @param {object} deps
 * @param {string} pdfPath absolute path
 * @param {{ signal?: AbortSignal }} [opts]
 * @returns {Promise<{ pages: number, ppi: number|null, widthIn: number|null, heightIn: number|null,
 *   bytes?: number, totalMemBytes: number, peakBytes: number|null, estimatePpi: number }>}
 */
async function pdfInfo(deps, pdfPath, opts = {}) {
  if (typeof pdfPath !== 'string' || !path.isAbsolute(pdfPath)) throw userError('Choose a PDF file.', { code: 'INVALID_ARGUMENT' });
  const st = await statSafe(pdfPath);
  if (!st || !st.isFile()) throw userError(`Could not find "${path.basename(pdfPath)}".`, { code: 'PDF_MISSING' });
  if (!deps.helper || typeof deps.helper.run !== 'function') throw userError('Part of the app is missing (helper).', { code: 'SERVICE_UNAVAILABLE' });
  let info;
  try {
    info = await deps.helper.run('pdf-info', ['--pdf', pdfPath], { timeoutMs: 120000, signal: opts.signal });
  } catch (err) {
    if (err && HELPER_PASS_THROUGH_CODES.has(err.code)) throw err;
    if (err && err.name === 'CancelledError') throw err;
    throw userError(`"${path.basename(pdfPath)}" is not a PDF the app can read.`, { code: 'BAD_PDF', details: String((err && (err.details || err.message)) || err), cause: err });
  }
  const pages = Number.isInteger(info && info.pages) ? info.pages : 0;
  const ppi = info && Number.isFinite(info.ppi) && info.ppi > 0 ? info.ppi : null;
  const widthIn = info && Number.isFinite(info.widthIn) ? info.widthIn : null;
  const heightIn = info && Number.isFinite(info.heightIn) ? info.heightIn : null;
  const estimatePpi = ppi || CALIBRATION_PPI;
  return {
    ...(isObj(info) ? info : {}),
    pages,
    ppi,
    widthIn,
    heightIn,
    totalMemBytes: totalMemoryOf(deps),
    estimatePpi,
    peakBytes: offsetPeakBytes({ pages, widthIn, heightIn, ppi: estimatePpi }),
  };
}

/**
 * Peak memory of offset_pdf.py: every page rendered at `ppi` plus a shifted copy of every 2nd page plus
 * save buffers ≈ (1.5 × pages + 2) × page bytes.
 * @param {{ pages: number, widthIn: number|null, heightIn: number|null, ppi: number }} input
 * @returns {number|null}
 */
function offsetPeakBytes({ pages, widthIn, heightIn, ppi }) {
  if (!Number.isFinite(widthIn) || !Number.isFinite(heightIn) || !Number.isFinite(ppi) || !pages) return null;
  const pageBytes = Math.ceil(widthIn * ppi) * Math.ceil(heightIn * ppi) * 3;
  return Math.round((1.5 * pages + 2) * pageBytes);
}

/**
 * Start an 'offset' job applying (x, y, angle) to every back page of an existing PDF; the result is
 * saved as `<outputDir>/<name>_offset.pdf` (or `outputPath`).
 * @param {object} deps
 * @param {{ pdfPath: string, x_offset: number, y_offset: number, angle_offset: number, ppi: number|null,
 *   outputPath?: string, ignoreMemoryLimit?: boolean }} req
 * @returns {Promise<{ jobId: string }>} job result: { pdfPath, sizeBytes, pages, ppi, source, durationMs, ... }
 */
async function startOffsetJob(deps, req) {
  requireJobs(deps);
  const r = isObj(req) ? req : {};
  const paths = deps.getPaths();
  const pdfPath = typeof r.pdfPath === 'string' ? path.resolve(r.pdfPath) : null;
  if (!pdfPath || !/\.pdf$/i.test(pdfPath)) throw userError('Choose a PDF file.', { code: 'INVALID_ARGUMENT' });
  const st = await statSafe(pdfPath);
  if (!st || !st.isFile()) throw userError(`Could not find "${path.basename(pdfPath)}".`, { code: 'PDF_MISSING' });
  const { x, y, angle } = alignmentValues(r.x_offset, r.y_offset, r.angle_offset);
  const requestedPpi = r.ppi === null || r.ppi === undefined ? null : Number(r.ppi);
  if (requestedPpi !== null && (!Number.isInteger(requestedPpi) || requestedPpi < 1 || requestedPpi > 2400)) {
    throw userError('The resolution must be a whole number from 1 to 2400.', { code: 'INVALID_PPI' });
  }
  const base = path.basename(pdfPath).replace(/\.pdf$/i, '');
  const outputPath = typeof r.outputPath === 'string' && r.outputPath
    ? path.resolve(r.outputPath)
    : path.join(paths.outputDir, `${base}_offset.pdf`);
  if (util.samePath(outputPath, pdfPath)) {
    throw userError('Choose another name for the aligned PDF: it can\'t replace the original.', { code: 'INVALID_ARGUMENT' });
  }
  const locked = await lockedCode(outputPath);
  if (locked) {
    throw userError(`${path.basename(outputPath)} is open in another program (probably your PDF viewer). Close it and try again.`, { code: 'OUTPUT_LOCKED' });
  }
  await requirePython(paths);
  const script = await resolveOffsetScript(paths);
  const steps = [
    { id: 'inspect', label: 'Check the PDF' },
    { id: 'apply', label: 'Apply the alignment' },
  ];
  const jobId = deps.jobs.start('offset', { title: `Applying printer alignment to ${path.basename(pdfPath)}`, steps }, async (ctx) => {
    const started = Date.now();
    ctx.step('inspect', 'running');
    ctx.progress({ percent: null, label: 'Checking the PDF…' });
    const info = await pdfInfo(deps, pdfPath, { signal: ctx.signal });
    if (!info.pages) throw userError('This PDF has no pages.', { code: 'BAD_PDF' });
    const ppi = requestedPpi || info.ppi || CALIBRATION_PPI;
    const peak = offsetPeakBytes({ pages: info.pages, widthIn: info.widthIn, heightIn: info.heightIn, ppi });
    const total = totalMemoryOf(deps);
    if (Number.isFinite(peak) && peak > MEMORY_ERROR_FRACTION * total) {
      if (r.ignoreMemoryLimit === true) {
        ctx.warn(`This needs about ${formatBytes(peak)} of memory, more than your computer can spare: it may fail or make your computer very slow.`);
      } else {
        throw userError(`Applying the alignment to this ${info.pages}-page PDF at ${ppi} PPI needs about ${formatBytes(peak)} of memory, more than your computer can spare. Use a lower resolution, or make the PDF again with "Apply my printer alignment" turned on.`, { code: 'OUT_OF_MEMORY' });
      }
    } else if (Number.isFinite(peak) && peak > MEMORY_WARNING_FRACTION * total) {
      ctx.warn(`This needs about ${formatBytes(peak)} of memory. Close other programs while it runs.`);
    }
    if (info.pages % 2 === 1) ctx.warn('This PDF has an odd number of pages: only pages 2, 4, 6… (the backs) are moved.');
    ctx.log(`Applying x ${x}, y ${y}, angle ${formatAngle(angle)} at ${ppi} PPI to ${info.pages} pages.`);
    ctx.step('inspect', 'done');
    ctx.step('apply', 'running');
    const moved = await runOffsetPdf(ctx, paths, { script, pdfPath, outputPath, x, y, angle, ppi, pages: info.pages });
    if (moved.fallback) ctx.warn(`${path.basename(outputPath)} is open in another program, so the aligned PDF was saved as ${path.basename(moved.path)}.`);
    ctx.step('apply', 'done');
    const out = await statSafe(moved.path);
    const result = {
      pdfPath: moved.path,
      sizeBytes: out ? out.size : 0,
      pages: info.pages,
      ppi,
      source: pdfPath,
      x_offset: x,
      y_offset: y,
      angle_offset: angle,
      durationMs: Date.now() - started,
    };
    try {
      const s = settingsOf(deps);
      const last = isObj(s.pdf) && isObj(s.pdf.lastPdf) ? s.pdf.lastPdf : null;
      if (last && typeof last.path === 'string' && util.samePath(last.path, pdfPath)) {
        // pdf.secPerCard is "seconds per card at lastPdf.ppi": keep it consistent when the ppi changes
        const prevSec = s.pdf.secPerCard;
        const rescaled = Number.isFinite(prevSec) && prevSec > 0 && Number.isFinite(last.ppi) && last.ppi > 0 && last.ppi !== ppi
          ? { secPerCard: Math.round(prevSec * (ppi / last.ppi) ** 2 * 10000) / 10000 }
          : {};
        deps.settings.update({
          pdf: {
            ...rescaled,
            lastPdf: {
              ...last,
              path: moved.path,
              ppi,
              loadOffset: true,
              pages: info.pages,
              at: new Date().toISOString(),
              sizeBytes: result.sizeBytes,
            },
          },
        });
      }
    } catch { /* best effort */ }
    return result;
  });
  return { jobId };
}

module.exports = {
  readOffset,
  writeOffset,
  resetOffset,
  calibrationFor,
  startGenerateCalibrationJob,
  startShiftedCalibrationJob,
  startOffsetJob,
  pdfInfo,
  // extras (tested)
  coerceInt,
  coerceFloat,
  offsetPeakBytes,
  resolvePaper,
  readPaperSizes,
  calibrationEngine,
  paperLabel,
  pruneShiftedSheets,
};
