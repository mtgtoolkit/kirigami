'use strict';

/**
 * print.js — data for the "Print & cut" page (spec §9.10): Silhouette Studio detection, the last PDF,
 * the cutting template of the current settings, and opening a template in Silhouette Studio.
 *
 * openTemplate() copies the engine's .studio3 file to `<outputDir>/templates/` first, so Silhouette
 * Studio never edits (or locks) the original template, and the copy sits next to the user's PDFs.
 *
 * No require('electron'): everything comes through `deps` (spec §12).
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const { userError } = require('./errors');
const { templateForOptions } = require('./pdf');

const RETRYABLE_COPY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const NOT_INSTALLED_MESSAGE = 'Silhouette Studio doesn\'t seem to be installed';

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

function lazyService(name) {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require(`./${name}`);
  } catch {
    return null;
  }
}

async function detectStudio(deps) {
  try {
    const seam = deps && isObj(deps.seams) ? deps.seams.registry : null; // tests (same convention as python-env)
    const registry = seam || lazyService('registry');
    if (registry && typeof registry.findSilhouetteStudio === 'function') {
      const found = await registry.findSilhouetteStudio({ logger: deps.logger });
      if (isObj(found)) return { found: !!found.found, path: found.path || null, version: found.version || null };
    }
  } catch (err) {
    if (deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn('[print] Silhouette Studio detection failed:', err);
  }
  return { found: false, path: null, version: null };
}

/**
 * Everything the Print & cut page shows.
 * @param {object} deps
 * @returns {Promise<{ silhouetteStudio: { found: boolean, path: string|null, version: string|null },
 *   lastPdf: object|null, template: { name: string|null, file: string|null },
 *   paperSize: string|null, cardSize: string|null, cardDims: string|null, registration: string|null,
 *   borderless: boolean, specialty: string|null, onlyFronts: boolean, layoutKey: string|null, error: string|null }>}
 *   lastPdf = settings.pdf.lastPdf plus `exists` (and the size on disk when it exists)
 */
async function printInfo(deps) {
  const settings = settingsOf(deps);
  const [silhouetteStudio, current] = await Promise.all([
    detectStudio(deps),
    templateForOptions(deps, {}).catch((err) => ({
      name: null, file: null, layoutKey: null, paperSize: null, cardSize: null, layout: null, options: {}, error: err && err.message ? err.message : String(err),
    })),
  ]);
  const last = isObj(settings.pdf) && isObj(settings.pdf.lastPdf) ? settings.pdf.lastPdf : null;
  let lastPdf = null;
  if (last && typeof last.path === 'string' && last.path) {
    const st = await statSafe(last.path);
    lastPdf = { ...last, exists: !!(st && st.isFile()), sizeBytes: st && st.isFile() ? st.size : (Number.isFinite(last.sizeBytes) ? last.sizeBytes : null) };
  }
  const layout = current.layout;
  const opts = isObj(current.options) ? current.options : {};
  const cardDims = layout && Number.isFinite(layout.cardWidthMm) && Number.isFinite(layout.cardHeightMm)
    ? `${layout.cardWidthMm} x ${layout.cardHeightMm} mm` : null;
  return {
    silhouetteStudio,
    lastPdf,
    template: { name: current.name || null, file: current.file || null },
    paperSize: current.paperSize || null,
    cardSize: current.cardSize || null,
    cardDims,
    registration: typeof opts.registration === 'string' ? opts.registration : null,
    borderless: opts.borderless === true,
    specialty: opts.specialty || null,
    onlyFronts: opts.only_fronts !== false,
    layoutKey: current.layoutKey || null,
    error: current.error || null,
  };
}

/**
 * Copy a cutting template to `<outputDir>/templates/<name>.studio3` (overwriting an older copy) and open
 * it with the default app (Silhouette Studio).
 * @param {object} deps
 * @param {string} file absolute path of a .studio3 file (ipc.js only accepts the app's templates)
 * @returns {Promise<{ opened: boolean, copiedTo: string|null, error: string|null }>}
 */
async function openTemplate(deps, file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/\.studio3$/i.test(file)) {
    throw userError('This is not a Silhouette Studio cutting template.', { code: 'INVALID_ARGUMENT' });
  }
  const st = await statSafe(file);
  if (!st || !st.isFile()) {
    return { opened: false, copiedTo: null, error: 'The cutting template file is missing. Please reinstall Kirigami.' };
  }
  const paths = deps.getPaths();
  const destDir = path.join(paths.outputDir, 'templates');
  const dest = path.join(destDir, path.basename(file));
  let copiedTo = null;
  try {
    await fsp.mkdir(destDir, { recursive: true });
    await fsp.copyFile(file, dest);
    copiedTo = dest;
  } catch (err) {
    // A copy that is open in Silhouette Studio can't be replaced: open that copy instead.
    if (err && RETRYABLE_COPY_CODES.has(err.code) && (await statSafe(dest))) {
      copiedTo = dest;
    } else {
      if (deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn('[print] could not copy the cutting template:', err);
      return { opened: false, copiedTo: null, error: `The cutting template could not be copied to ${destDir}. Choose another output folder in Settings.` };
    }
  }
  if (typeof deps.openPath !== 'function') return { opened: false, copiedTo, error: NOT_INSTALLED_MESSAGE };
  let res;
  try {
    res = await deps.openPath(copiedTo);
  } catch (err) {
    res = err && err.message ? err.message : String(err);
  }
  if (res) {
    if (deps.logger && typeof deps.logger.warn === 'function') deps.logger.warn(`[print] opening ${copiedTo} failed: ${res}`);
    return { opened: false, copiedTo, error: NOT_INSTALLED_MESSAGE };
  }
  return { opened: true, copiedTo, error: null };
}

module.exports = { printInfo, openTemplate };
