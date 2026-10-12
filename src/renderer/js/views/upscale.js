/**
 * "Upscale" view (`#/upscale`, spec §8.4 "Upscale", §9.7, §13.3).
 *
 * Upscaling is optional and uses the copy of Upscayl the user installed (never bundled). This page:
 * - shows whether Upscayl was found (version, location, graphics cards) with Locate / Download;
 * - explains that Make PDF upscales automatically while the switch is on (settings.upscayl.enabled);
 * - lets the user pick the AI model (Non-Commercial / Custom badges, missing-model warning), the
 *   maximum scale, smart scale, output format (+ WebP compression), the graphics card (Detect GPUs
 *   job), advanced options (tile size, TTA, threads, custom models folder) and which images to
 *   upscale (targets);
 * - estimates the work from scm.pdf.plan({ ...pdf options, upscale: true }).upscale, or — when the
 *   PDF planner is unavailable — from the card lists with the same smart-scale rules;
 * - runs "Upscale now" (scm.upscayl.start) and "Try on one card" (scm.upscayl.preview, then a
 *   before/after compare slider), and shows the upscaled-images cache with "Clear".
 *
 * Every setting is saved with settings.update({ upscayl: … }). Buttons that start jobs or change
 * files are disabled while a job runs.
 *
 * Pure helpers are exported for unit tests.
 *
 * @module views/upscale
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { nextStep } from '../components/next-step.js';
import { compareSlider } from '../components/compare-slider.js';
import { describeModels, MODEL_FALLBACK_ORDER, modelDisplayName } from '../data/models.js';
import { EXTERNAL_LINKS } from '../data/help.js';
import { openCardPicker, cardDimensions, effectivePpi, normalizeCardList, baseName, shortName, LOW_RES_INFO_PPI } from './cards.js';

const { h, icon } = ui;

/* ------------------------------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------------------------- */

/** settings.upscayl defaults (spec §4), used when a key is missing. */
export const UPSCAYL_DEFAULTS = Object.freeze({
  enabled: true,
  model: 'upscayl-standard-4x',
  scale: 4,
  smartScale: true,
  format: 'same',
  compression: 0,
  gpuId: 'auto',
  tileSize: 0,
  tta: false,
  threads: '',
  targets: Object.freeze({ front: true, back: true, double_sided: true }),
  secPerImage: 3,
});

/** Pillow refuses bigger images (spec §1): upscaled pictures are capped below this pixel count. */
export const MAX_UPSCALED_PIXELS = 89e6;
/** Approximate size of one 4× upscaled card picture (745 × 1040 → 2980 × 4160 PNG). */
export const BYTES_PER_4X_IMAGE = 15 * 1024 * 1024;

const UPSCAYL_URL = EXTERNAL_LINKS?.upscayl?.url || 'https://upscayl.org';
const CUSTOM_MODELS_URL = EXTERNAL_LINKS?.upscaylCustomModels?.url || 'https://github.com/upscayl/custom-models';

/** Card and settings of the last "Try on one card" (kept across visits for "Show the last preview again"). */
let lastPreviewRequest = null;
/** Preview job started from this page that has not finished yet (survives leaving and coming back). */
let pendingPreview = null;
/** Preview jobs whose result was already shown (so a finished preview is offered only once). */
const shownPreviewJobs = new Set();

const FORMAT_OPTIONS = [
  { value: 'same', label: 'Same as original', description: 'PNG stays PNG, JPG stays JPG, WebP stays WebP; other types become PNG.' },
  { value: 'png', label: 'PNG', description: 'Best quality, biggest files.' },
  { value: 'jpg', label: 'JPG', description: 'Much smaller files with a tiny loss of quality.' },
  { value: 'webp', label: 'WebP', description: 'Smallest files; choose how much to compress below.' },
];

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for unit tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * settings.upscayl with defaults filled in.
 * @param {object|null|undefined} settings
 * @returns {typeof UPSCAYL_DEFAULTS & Record<string, any>}
 */
export function upscaylSettings(settings) {
  const up = settings && typeof settings.upscayl === 'object' && settings.upscayl ? settings.upscayl : {};
  return {
    ...UPSCAYL_DEFAULTS,
    ...up,
    targets: { ...UPSCAYL_DEFAULTS.targets, ...(up.targets && typeof up.targets === 'object' ? up.targets : {}) },
  };
}

/**
 * Defensive UpscaylStatus normalization (spec §6).
 * @param {unknown} raw
 * @returns {{ found: boolean, binPath: string|null, modelsDir: string|null, customModelsDir: string|null, version: string|null, source: string|null, models: object[], gpus: Array<{ id: string|number, name: string }>|null, error: string|null }|null}
 */
export function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => (typeof v === 'string' && v ? v : null);
  return {
    found: !!raw.found,
    binPath: str(raw.binPath),
    modelsDir: str(raw.modelsDir),
    customModelsDir: str(raw.customModelsDir),
    version: str(raw.version),
    source: str(raw.source),
    models: Array.isArray(raw.models) ? raw.models.filter((m) => m && typeof m.id === 'string') : [],
    gpus: Array.isArray(raw.gpus) ? raw.gpus.filter((g) => g && (typeof g.id === 'number' || typeof g.id === 'string')) : null,
    error: str(raw.error),
  };
}

/**
 * The model Upscayl will really use: the configured one when installed, else the first available
 * of the fallback order (spec §9.7), else any.
 * @param {string|null|undefined} configured
 * @param {Array<{ id: string }>} models available models
 * @returns {{ id: string|null, missing: boolean }} `missing` = the configured model is not installed
 */
export function effectiveModel(configured, models) {
  const ids = (Array.isArray(models) ? models : []).map((m) => m && m.id).filter(Boolean);
  if (configured && ids.includes(configured)) return { id: configured, missing: false };
  const fallback = MODEL_FALLBACK_ORDER.find((id) => ids.includes(id)) || ids[0] || null;
  return { id: fallback, missing: !!configured && ids.length > 0 };
}

/**
 * How one image would be upscaled (mirror of the main-process planner, spec §9.7).
 *
 * @param {{ width?: number|null, height?: number|null }} image size after EXIF rotation
 * @param {{ targetPpi: number, cardWidthMm: number, maxScale?: number, smartScale?: boolean }} options
 * @returns {{ action: 'sharp'|'upscale', scale: number, effPpi: number|null, tooBig?: boolean }}
 */
export function planScale(image, { targetPpi, cardWidthMm, maxScale = 4, smartScale = true }) {
  const max = [2, 3, 4].includes(Number(maxScale)) ? Number(maxScale) : 4;
  const eff = effectivePpi(image?.width, cardWidthMm);
  let scale = max;
  if (smartScale && eff !== null && Number(targetPpi) > 0) {
    if (eff >= Number(targetPpi)) return { action: 'sharp', scale: 1, effPpi: eff };
    scale = [2, 3, 4].find((s) => s <= max && eff * s >= Number(targetPpi)) || max;
  }
  const w = Number(image?.width);
  const hgt = Number(image?.height);
  if (w > 0 && hgt > 0) {
    while (scale > 2 && w * hgt * scale * scale > MAX_UPSCALED_PIXELS) scale -= 1;
    if (w * hgt * scale * scale > MAX_UPSCALED_PIXELS) return { action: 'sharp', scale: 1, effPpi: eff, tooBig: true };
  }
  return { action: 'upscale', scale, effPpi: eff };
}

/**
 * Local estimate of an upscale run (used when the PDF planner is not available). Identical
 * pictures (same hash) are counted once, like the real planner.
 *
 * @param {object} input
 * @param {Array<{ rel: string, hash?: string|null, width?: number|null, height?: number|null, upscaled?: boolean }>} input.items
 * @param {number} input.targetPpi
 * @param {number} input.cardWidthMm
 * @param {number} [input.maxScale]
 * @param {boolean} [input.smartScale]
 * @param {number} [input.secPerImage]
 * @returns {{ total: number, needed: number, cached: number, sharp: number, secEst: number, bytesEst: number }}
 */
export function estimateLocally({ items, targetPpi, cardWidthMm, maxScale = 4, smartScale = true, secPerImage = 3 }) {
  const seen = new Set();
  let needed = 0;
  let cached = 0;
  let sharp = 0;
  let bytes = 0;
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue;
    const key = it.hash ? `h:${it.hash}` : `r:${it.kind || ''}/${it.rel}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (it.upscaled) {
      cached += 1;
      continue;
    }
    const p = planScale(it, { targetPpi, cardWidthMm, maxScale, smartScale });
    if (p.action === 'sharp') {
      sharp += 1;
      continue;
    }
    needed += 1;
    bytes += BYTES_PER_4X_IMAGE * (p.scale / 4) ** 2;
  }
  const sec = Number(secPerImage) > 0 ? Number(secPerImage) : UPSCAYL_DEFAULTS.secPerImage;
  return { total: seen.size, needed, cached, sharp, secEst: needed * sec, bytesEst: Math.round(bytes) };
}

/**
 * Normalize an upscale estimate to `{ needed, cached, sharp, secEst, bytesEst }`. Accepts the
 * `upscale` part of a PdfPlan (spec §9.8) and scm.upscayl.cacheInfo() (same fields). Returns null
 * when there is no usable estimate (missing, `available: false`, or no `needed` count).
 * @param {unknown} up
 * @returns {{ needed: number, cached: number, sharp: number, secEst: number|null, bytesEst: number|null }|null}
 */
export function normalizePlanEstimate(up) {
  if (!up || typeof up !== 'object' || up.available === false) return null;
  const n = (v) => (v !== null && v !== '' && v !== undefined && Number.isFinite(Number(v)) ? Number(v) : null);
  const needed = n(up.needed);
  if (needed === null || needed < 0) return null;
  return { needed, cached: n(up.cached) || 0, sharp: n(up.sharp) || 0, secEst: n(up.secEst), bytesEst: n(up.bytesEst) };
}

/**
 * Valid value for the threads option: empty (automatic) or `load:process:save`, e.g. `1:2:2`
 * (the process part may list one value per graphics card: `1:2,2:2`, up to 8). Same rule as the
 * main process (anything else is ignored there).
 * @param {string} text
 * @returns {boolean}
 */
export function isValidThreads(text) {
  const t = String(text ?? '').trim();
  return t === '' || /^\d{1,3}:\d{1,3}(?:,\d{1,3}){0,7}:\d{1,3}$/.test(t);
}

/**
 * Valid tile size: 0 (automatic) or a whole number from 32 to 16384 (the main process ignores
 * other values and lets Upscayl choose).
 * @param {number|null} value
 * @returns {boolean}
 */
export function isValidTileSize(value) {
  return value === 0 || (Number.isInteger(value) && value >= 32 && value <= 16384);
}

/**
 * The GPUs detected for the Upscayl in use: the status list, else the list saved in settings when
 * it was detected for the same program (settings.upscayl.gpusDetectedFor = binPath).
 * @param {{ gpus?: Array<{ id: number|string, name: string }>|null, binPath?: string|null }|null} status
 * @param {{ gpus?: unknown, gpusDetectedFor?: unknown }} up settings.upscayl
 * @returns {Array<{ id: number|string, name: string }>|null} null = not detected yet
 */
export function detectedGpus(status, up) {
  if (status && Array.isArray(status.gpus)) return status.gpus;
  const saved = up && Array.isArray(up.gpus) ? up.gpus.filter((g) => g && (typeof g.id === 'number' || typeof g.id === 'string')) : null;
  if (!saved) return null;
  const forBin = typeof up.gpusDetectedFor === 'string' ? up.gpusDetectedFor : '';
  const bin = status && typeof status.binPath === 'string' ? status.binPath : '';
  if (!forBin || !bin) return null;
  const norm = (p) => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
  return norm(forBin) === norm(bin) ? saved : null;
}

/**
 * Human text for a preview size (`beforeSize` / `afterSize` may be bytes, `{ width, height, bytes }`
 * or a ready string).
 * @param {unknown} v
 * @returns {string|null}
 */
export function describeImageSize(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? format.formatBytes(v) : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    const w = Number(v.width ?? v.w);
    const hgt = Number(v.height ?? v.h);
    const parts = [];
    if (w > 0 && hgt > 0) parts.push(`${format.formatNumber(w)} × ${format.formatNumber(hgt)} px`);
    const bytes = Number(v.bytes ?? v.size);
    if (Number.isFinite(bytes) && bytes > 0) parts.push(format.formatBytes(bytes));
    return parts.join(' · ') || null;
  }
  return null;
}

/**
 * Friendly GPU option list: "Automatic" + detected cards (+ the saved choice when it is no longer
 * detected).
 * @param {Array<{ id: string|number, name: string }>|null} gpus
 * @param {string|number|null} current settings.upscayl.gpuId
 * @returns {Array<{ value: string, label: string, description?: string }>}
 */
export function gpuOptions(gpus, current) {
  const list = Array.isArray(gpus) ? gpus : [];
  const out = [{ value: 'auto', label: 'Automatic', description: 'Recommended: Upscayl picks the best graphics card.' }];
  const seen = new Set();
  for (const g of list) {
    const id = String(g.id);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ value: id, label: g.name ? String(g.name) : `Graphics card ${id}` });
  }
  const cur = current === null || current === undefined || current === '' ? 'auto' : String(current);
  if (cur !== 'auto' && !seen.has(cur)) out.push({ value: cur, label: `Graphics card ${cur} (not detected)` });
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {object|null} job
 * @returns {boolean}
 */
function isRunning(job) {
  return !!job && job.status === 'running';
}

export default {
  id: 'upscale',
  title: 'Upscale',
  icon: 'sparkles',

  /**
   * @param {HTMLElement} container
   * @param {object} ctx view context (spec §13.3)
   * @returns {() => void} unmount
   */
  mount(container, ctx) {
    const { api, store } = ctx;
    const disposers = [];

    const state = {
      status: normalizeStatus(store.get('env')?.upscayl),
      statusLoading: true,
      statusError: null,
      cache: null,
      cacheError: null,
      estimate: null,
      estimateSource: null,
      estimateLoading: false,
      estimateError: null,
      lists: { front: null, back: null, double_sided: null },
      listsError: null,
      busy: isRunning(store.get('job')),
      // A preview started before leaving this page still opens when it finishes.
      previewJobId: pendingPreview ? pendingPreview.jobId : null,
      previewRequest: pendingPreview ? pendingPreview.request : null,
      probeJobId: null,
      upscaleJobId: null,
    };

    const settings = () => store.get('settings') || {};
    const up = () => upscaylSettings(settings());
    const platform = () => store.get('appInfo')?.platform || 'win32';
    const save = (patch) => api.settings.update({ upscayl: patch }).catch((err) => ui.showError(err, { title: 'Could not save this setting' }));

    /* ---------------- skeleton ---------------- */

    const headerEl = ui.pageHeader({
      title: 'Upscale',
      step: 3,
      icon: 'sparkles',
      subtitle: 'Make small card images sharper before printing, with the free Upscayl program installed on your computer. This step is optional.',
    });
    const statusEl = h('div');
    const bodyEl = h('div.stack', { style: { '--gap': '24px' } });
    const footerEl = h('div');
    container.append(headerEl, statusEl, bodyEl, footerEl);

    const applyBusy = () => {
      for (const el of container.querySelectorAll('[data-job-control]')) {
        const extra = el.dataset.blocked === '1';
        if ('disabled' in el) el.disabled = state.busy || extra;
      }
    };
    /**
     * Mark a control that starts a job or changes files (disabled while a job runs).
     * @param {HTMLElement} el
     * @param {boolean} [blocked] also disabled for another reason
     */
    const jobControl = (el, blocked = false) => {
      el.dataset.jobControl = '1';
      el.dataset.blocked = blocked ? '1' : '0';
      if ('disabled' in el) el.disabled = state.busy || blocked;
      return el;
    };

    /* ---------------- status ---------------- */

    let statusToken = 0;
    const syncEnvUpscayl = (status) => {
      // Keep the sidebar badge ("On" / "Not installed") in step with what this page found.
      if (!status) return;
      const env = store.get('env');
      if (env && typeof env === 'object') store.set('env', { ...env, upscayl: status });
    };

    async function loadStatus({ refresh = false } = {}) {
      const token = ++statusToken;
      try {
        const st = normalizeStatus(await api.upscayl.status({ refresh }));
        if (token !== statusToken || ctx.signal.aborted) return;
        state.status = st;
        state.statusError = st ? null : 'Upscayl status is not available.';
        if (st) syncEnvUpscayl(st);
      } catch (err) {
        if (token !== statusToken || ctx.signal.aborted) return;
        state.statusError = api.errorMessage(err);
        if (!state.status) state.status = normalizeStatus(store.get('env')?.upscayl);
      } finally {
        if (token === statusToken && !ctx.signal.aborted) {
          state.statusLoading = false;
          renderAll();
        }
      }
    }

    async function locate() {
      const isWin = platform() === 'win32';
      const file = await api.dialog.openFile({
        purpose: 'upscayl',
        title: 'Find Upscayl (Upscayl.exe or upscayl-bin.exe)',
        filters: isWin ? [{ name: 'Upscayl program', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }] : undefined,
      });
      if (!file) return;
      await applyLocation(file);
    }

    async function applyLocation(target) {
      try {
        const res = normalizeStatus(await api.upscayl.locate(target));
        if (res) {
          state.status = res;
          syncEnvUpscayl(res);
        } else {
          await loadStatus({ refresh: true });
        }
        if (target === null) {
          ui.toast({ variant: 'info', title: 'Looking for Upscayl automatically', timeout: 3500 });
        } else if (state.status?.found) {
          ui.toast({ variant: 'success', title: `Upscayl${state.status.version ? ` ${state.status.version}` : ''} is ready`, timeout: 3500 });
        } else {
          ui.toast({ variant: 'warning', title: 'This does not look like Upscayl', message: state.status?.error || 'Choose Upscayl.exe in the folder where Upscayl is installed.', timeout: 8000 });
        }
      } catch (err) {
        ui.showError(err, { title: 'Could not use this Upscayl' });
      } finally {
        renderAll();
        scheduleEstimate();
      }
    }

    async function detectGpus() {
      try {
        const res = await api.upscayl.detectGpus();
        state.probeJobId = res?.jobId ? String(res.jobId) : null;
        renderAll();
        checkTrackedJobs();
      } catch (err) {
        ui.showError(err, { title: 'Could not check the graphics cards' });
      }
    }

    async function chooseCustomModels() {
      const dir = await api.dialog.openFolder({ purpose: 'upscayl', title: 'Choose the folder named “models” with your extra models' });
      if (!dir) return;
      await setCustomModels(dir);
    }

    async function setCustomModels(dir) {
      try {
        const res = normalizeStatus(await api.upscayl.setCustomModelsDir(dir));
        if (res) {
          state.status = res;
          syncEnvUpscayl(res);
        } else {
          await loadStatus({ refresh: true });
        }
        const custom = (state.status?.models || []).filter((m) => m.custom).length;
        ui.toast({
          variant: dir === null || custom ? 'success' : 'warning',
          title: dir === null ? 'Custom models removed' : custom ? `Found ${format.pluralize(custom, 'custom model')}` : 'No models were found in this folder',
          message: dir !== null && !custom ? 'The folder must contain pairs of .param and .bin files.' : undefined,
          timeout: 5000,
        });
      } catch (err) {
        ui.showError(err, { title: 'Could not use this folder' });
      } finally {
        renderAll();
      }
    }

    function statusCard() {
      const st = state.status;
      if (!st && state.statusLoading) {
        return ui.card({ title: 'Looking for Upscayl…', icon: 'sparkles', children: ui.skeleton({ lines: 2 }) });
      }
      const recheck = ui.button({ label: 'Check again', icon: 'refresh', size: 'sm', variant: 'ghost', onClick: () => loadStatus({ refresh: true }) });
      if (!st || !st.found) {
        const unknown = !st && !!state.statusError;
        const reason = st?.error || state.statusError;
        return ui.card({
          icon: 'sparkles',
          title: unknown ? 'Couldn\'t check for Upscayl' : 'Upscayl is not installed (optional)',
          subtitle: 'Your PDF can be made without it.',
          actions: [recheck],
          children: [
            h('p.prose', unknown
              ? 'Upscayl is a free program that makes small card images sharper before printing. The card maker could not check whether it is installed right now; try again in a moment.'
              : 'Upscayl is a free program that makes small card images sharper before printing. Install it from upscayl.org: the card maker finds it automatically. If you installed it somewhere unusual, locate it yourself.'),
            reason ? ui.callout({ variant: 'neutral', compact: true, message: reason }) : null,
            ui.row({ gap: 8 },
              ui.button({ label: 'Download Upscayl', icon: 'external-link', variant: unknown ? 'secondary' : 'primary', onClick: () => api.shell.openExternal(UPSCAYL_URL) }),
              jobControl(ui.button({ label: 'Locate…', icon: 'folder-open', onClick: () => locate() }))),
          ],
        });
      }
      const gpus = detectedGpus(st, up());
      const probing = !!state.probeJobId;
      const gpuText = probing
        ? h('span.row', { style: { '--gap': '8px', display: 'inline-flex' } }, ui.spinner(14), 'checking…')
        : gpus && gpus.length
          ? gpus.map((g) => g.name || `Graphics card ${g.id}`).join(', ')
          : gpus ? 'none detected' : 'not checked yet';
      const userLocated = st.source === 'settings' || !!settings()?.upscayl?.binPath;
      const customCount = st.models.filter((m) => m.custom).length;
      const modelsText = st.models.length
        ? `${format.pluralize(st.models.length, 'model')}${customCount ? ` (${format.formatNumber(customCount)} custom)` : ''}`
        : 'no AI models found';
      const usable = st.models.length > 0;
      const name = `Upscayl${st.version ? ` ${st.version}` : ''}`;
      return ui.card({
        icon: usable ? 'check-circle' : 'alert-triangle',
        variant: usable ? 'success' : 'warning',
        title: usable ? `${name} is ready` : `${name} was found, but it can't be used yet`,
        subtitle: `${userLocated ? 'You located it yourself' : 'Found automatically on this computer'} · ${modelsText}`,
        actions: [recheck],
        children: [
          st.error ? ui.callout({ variant: usable ? 'neutral' : 'warning', compact: true, message: st.error }) : null,
          h('div.stack', { style: { '--gap': '4px' } },
            h('div.small', h('span.muted', 'Graphics card: '), gpuText),
            h('div.tiny.mono.faint.truncate', { title: st.binPath || '' }, st.binPath || '')),
          ui.row({ gap: 8 },
            jobControl(ui.button({ label: gpus ? 'Detect graphics cards again' : 'Detect graphics cards', icon: 'cpu', size: 'sm', onClick: () => detectGpus() }), probing || !usable),
            jobControl(ui.button({ label: 'Change location…', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => locate() })),
            userLocated ? jobControl(ui.button({ label: 'Find it automatically', size: 'sm', variant: 'ghost', onClick: () => applyLocation(null) })) : null),
        ],
      });
    }

    /* ---------------- settings form ---------------- */

    /** Controls kept between renders so settings changes don't rebuild (and blur) them. */
    let controls = null;
    let formKey = '';

    function modelOptions() {
      const models = describeModels(state.status?.models || []);
      return models.map((m) => {
        const badges = [];
        if (m.nonCommercial) badges.push(ui.badge('Non-Commercial', 'warning', { title: 'Upscayl marks this model as not for commercial use.' }));
        if (m.custom) badges.push(ui.badge('Custom', 'info'));
        const scaleNote = m.scale && m.scale !== 4 ? ` Native ${m.scale}× model.` : '';
        const name = m.displayName.replace(/\s*\(Non-Commercial\)\s*$/i, '');
        return {
          value: m.id,
          // Badges sit next to the name and wrap below it in narrow cards (a long one-word name
          // would otherwise run into them).
          label: badges.length
            ? h('span', { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', minWidth: 0 } },
              h('span', { style: { overflowWrap: 'anywhere' } }, name), badges)
            : name,
          description: `${m.recommendedFor || m.description}${scaleNote}`,
        };
      });
    }

    function buildForm() {
      const u = up();
      const st = state.status;
      const c = {};

      /* enable switch + note */
      c.enabled = ui.toggle({
        checked: u.enabled !== false,
        label: 'Upscale automatically when I make a PDF',
        description: 'Only images that need it are upscaled, and the results are kept for next time.',
        onChange: (v) => save({ enabled: v }),
      });
      const note = ui.callout({
        variant: 'accent',
        icon: 'sparkles',
        title: 'You don\'t need to run this yourself',
        message: h('div.stack', { style: { '--gap': '12px' } },
          h('span', 'Make PDF upscales automatically while this switch is on. Use this page to choose how, or to check the result on one card first.'),
          c.enabled),
      });

      /* model */
      const models = st?.models || [];
      const eff = effectiveModel(u.model, models);
      c.modelWarning = h('div');
      c.model = models.length
        ? ui.radioCards({
          ariaLabel: 'AI model',
          value: models.some((m) => m.id === u.model) ? u.model : eff.id,
          options: modelOptions(),
          onChange: (v) => save({ model: v }),
        })
        : ui.callout({ variant: 'warning', title: 'No models found', message: 'Upscayl\'s models folder is empty or missing. Reinstall Upscayl, or add a custom models folder below.' });
      const modelSection = ui.section({
        title: 'AI model',
        description: 'Each model sharpens pictures in its own way. Upscayl Standard suits most cards; try a card first to compare.',
        icon: 'wand',
        children: [c.modelWarning, c.model],
      });

      /* quality */
      c.scale = ui.segmented({
        ariaLabel: 'Maximum scale',
        value: Number(u.scale) || 4,
        options: [{ value: 2, label: '2×' }, { value: 3, label: '3×' }, { value: 4, label: '4×' }],
        onChange: (v) => save({ scale: Number(v) }),
      });
      c.smart = ui.toggle({
        checked: u.smartScale !== false,
        label: 'Smart scale',
        description: 'Only as much as your print resolution needs; skips images that are already sharp.',
        onChange: (v) => save({ smartScale: v }),
      });
      c.format = ui.select({
        ariaLabel: 'Output format',
        options: FORMAT_OPTIONS,
        value: u.format || 'same',
        onChange: (v) => {
          save({ format: v });
          c.compressionField.hidden = v !== 'webp';
        },
      });
      c.compression = ui.numberInput({
        value: Number.isFinite(Number(u.compression)) ? Number(u.compression) : 0,
        min: 0,
        max: 100,
        integer: true,
        suffix: '%',
        width: 120,
        ariaLabel: 'WebP compression',
        onChange: (v) => {
          if (v === null) return;
          const n = Math.max(0, Math.min(100, Math.round(v)));
          later('compression', () => save({ compression: n }));
        },
      });
      c.compressionField = ui.field({
        label: 'WebP compression',
        hint: '0 = best quality and bigger files; higher values make smaller files with some quality loss.',
        control: c.compression,
      });
      c.compressionField.hidden = (u.format || 'same') !== 'webp';
      const gpus = detectedGpus(st, u);
      c.gpu = ui.select({
        ariaLabel: 'Graphics card',
        options: gpuOptions(gpus, u.gpuId),
        value: u.gpuId === null || u.gpuId === undefined || u.gpuId === '' ? 'auto' : String(u.gpuId),
        onChange: (v) => save({ gpuId: v }),
      });
      const qualitySection = ui.section({
        title: 'Quality',
        description: 'How much bigger the pictures may get, and how they are saved.',
        icon: 'sliders',
        children: ui.grid({ min: 260, gap: 20 },
          ui.field({ label: 'Maximum scale', help: 'How much bigger a picture may become. 4× turns a 745 × 1040 picture into 2980 × 4160.', control: c.scale }),
          ui.field({ label: 'Output format', control: c.format }),
          h('div', c.smart),
          c.compressionField,
          ui.field({
            label: 'Graphics card',
            help: 'Upscayl runs on your graphics card. Keep "Automatic" unless you have several and upscaling fails.',
            hint: gpus === null ? 'Use “Detect graphics cards” above to list yours.' : null,
            control: c.gpu,
          })),
      });

      /* advanced */
      c.tile = ui.numberInput({
        value: Number(u.tileSize) || 0,
        min: 0,
        max: 16384,
        step: 32,
        integer: true,
        width: 140,
        suffix: 'px',
        ariaLabel: 'Tile size',
        onChange: (v) => {
          // Checked after a short pause so typing "128" doesn't flag "1" and "12" on the way.
          c.tileField?.setError(null);
          if (v === null) {
            later('tile', () => {});
            return;
          }
          const n = Math.max(0, Math.round(v));
          later('tile', () => {
            if (!isValidTileSize(n)) {
              c.tileField?.setError('Use 0 (automatic) or a number from 32 to 16384.');
              return;
            }
            save({ tileSize: n });
          });
        },
      });
      c.tta = ui.toggle({
        checked: !!u.tta,
        label: 'Extra-careful mode (TTA)',
        description: 'Slightly better results, but about 8 times slower.',
        onChange: (v) => save({ tta: v }),
      });
      c.threads = ui.textInput({
        value: typeof u.threads === 'string' ? u.threads : String(u.threads ?? ''),
        placeholder: 'Automatic',
        width: 160,
        ariaLabel: 'Threads',
        onInput: (v) => {
          c.threadsField.setError(null);
          later('threads', () => {
            if (!isValidThreads(v)) {
              c.threadsField.setError('Use three numbers like 1:2:2, or leave it empty.');
              return;
            }
            save({ threads: v.trim() });
          });
        },
      });
      c.threadsField = ui.field({
        label: 'Threads',
        help: 'How many pictures Upscayl loads, processes and saves at the same time (load:process:save). Leave it empty unless you know you need it.',
        hint: 'Empty = automatic. Example: 1:2:2.',
        control: c.threads,
      });
      const customDir = st?.customModelsDir || settings()?.upscayl?.customModelsDir || null;
      const customBlock = h('div.stack', { style: { '--gap': '8px' } },
        h('div.small', customDir
          ? h('span.mono', { style: { wordBreak: 'break-all' } }, customDir)
          : h('span.muted', 'None. Extra models can be downloaded from the Upscayl custom models page.')),
        ui.row({ gap: 8 },
          jobControl(ui.button({ label: customDir ? 'Change folder…' : 'Choose folder…', icon: 'folder-open', size: 'sm', onClick: () => chooseCustomModels() })),
          customDir ? jobControl(ui.button({ label: 'Remove', icon: 'x', size: 'sm', variant: 'ghost', onClick: () => setCustomModels(null) })) : null,
          ui.button({ label: 'Get more models', icon: 'external-link', size: 'sm', variant: 'link', onClick: () => api.shell.openExternal(CUSTOM_MODELS_URL) })));
      const advancedNonDefault = (Number(u.tileSize) || 0) !== 0 || !!u.tta || !!String(u.threads || '').trim() || !!customDir;
      const advancedSection = ui.section({
        title: 'Advanced',
        description: 'Only change these if upscaling fails or you use your own models.',
        icon: 'settings',
        collapsible: true,
        collapsed: !advancedNonDefault,
        children: ui.grid({ min: 260, gap: 20 },
          (c.tileField = ui.field({ label: 'Tile size', help: 'Pictures are processed in square tiles. 0 = automatic. Try 128 or 64 if upscaling fails on a graphics card with little memory.', hint: '0 = automatic', control: c.tile })),
          h('div', c.tta),
          c.threadsField,
          ui.field({ label: 'Custom models folder', help: 'A folder named "models" that contains pairs of .param and .bin files (Upscayl custom models).', control: customBlock })),
      });

      /* targets */
      const t = u.targets;
      const targetBox = (key, label, description) => ui.checkbox({
        checked: t[key] !== false,
        label,
        description,
        onChange: (v) => save({ targets: { [key]: v } }),
      });
      c.targets = {
        front: targetBox('front', 'Fronts', 'The front of every card.'),
        back: targetBox('back', 'Common back', 'The back printed behind every card.'),
        double_sided: targetBox('double_sided', 'Unique backs', 'The backs of double-faced cards.'),
      };
      const targetsSection = ui.section({
        title: 'Which images',
        description: 'Choose what gets upscaled. The common back is only used when you print fronts and backs.',
        icon: 'images',
        children: ui.grid({ min: 200, gap: 12 }, c.targets.front, c.targets.back, c.targets.double_sided),
      });

      controls = c;
      return { note, modelSection, qualitySection, advancedSection, targetsSection };
    }

    /** Debounced actions of typed fields: one pending action per key. */
    const pending = new Map();
    function later(key, fn, ms = 450) {
      const prev = pending.get(key);
      if (prev) clearTimeout(prev.timer);
      const entry = {
        fn,
        timer: setTimeout(() => {
          if (pending.get(key) === entry) pending.delete(key);
          fn();
        }, ms),
      };
      pending.set(key, entry);
    }
    disposers.push(() => {
      // Keep what the user just typed even when they leave the page right away.
      for (const { timer, fn } of [...pending.values()]) {
        clearTimeout(timer);
        try {
          fn();
        } catch {
          /* the page is gone; nothing to show */
        }
      }
      pending.clear();
    });

    /** Update control values from settings (after a change made elsewhere) without rebuilding. */
    function syncControls() {
      if (!controls) return;
      const u = up();
      controls.enabled.setChecked(u.enabled !== false);
      controls.smart.setChecked(u.smartScale !== false);
      controls.tta.setChecked(!!u.tta);
      controls.scale.setValue(Number(u.scale) || 4);
      controls.format.setValue(u.format || 'same');
      controls.compressionField.hidden = (u.format || 'same') !== 'webp';
      if (document.activeElement !== controls.compression.input) controls.compression.setValue(Number(u.compression) || 0);
      if (document.activeElement !== controls.tile.input) controls.tile.setValue(Number(u.tileSize) || 0);
      if (document.activeElement !== controls.threads) controls.threads.value = typeof u.threads === 'string' ? u.threads : '';
      controls.gpu.setOptions(gpuOptions(detectedGpus(state.status, u), u.gpuId), u.gpuId === null || u.gpuId === undefined || u.gpuId === '' ? 'auto' : String(u.gpuId));
      if (controls.model && typeof controls.model.setValue === 'function') {
        const eff = effectiveModel(u.model, state.status?.models || []);
        controls.model.setValue((state.status?.models || []).some((m) => m.id === u.model) ? u.model : eff.id);
      }
      for (const key of ['front', 'back', 'double_sided']) controls.targets[key].setChecked(u.targets[key] !== false);
      renderModelWarning();
    }

    function renderModelWarning() {
      if (!controls?.modelWarning) return;
      const u = up();
      const models = state.status?.models || [];
      const eff = effectiveModel(u.model, models);
      ui.mountInto(controls.modelWarning, eff.missing && eff.id ? ui.callout({
        variant: 'warning',
        compact: true,
        title: `“${modelDisplayName(u.model)}” is not installed`,
        message: `Upscayl will use “${modelDisplayName(eff.id)}” instead. Choose another model below to keep this choice.`,
        actions: [ui.button({ label: `Use ${modelDisplayName(eff.id)}`, size: 'sm', onClick: () => save({ model: eff.id }) })],
      }) : null);
      controls.modelWarning.hidden = !(eff.missing && eff.id);
    }

    /* ---------------- estimate + actions ---------------- */

    const estimateEl = h('div');
    const cacheEl = h('div');

    async function loadLists() {
      const results = await Promise.allSettled(['front', 'back', 'double_sided'].map((k) => api.cards.list(k)));
      if (ctx.signal.aborted) return;
      state.listsError = null;
      ['front', 'back', 'double_sided'].forEach((k, i) => {
        if (results[i].status === 'fulfilled') state.lists[k] = normalizeCardList(results[i].value, k);
        else state.listsError = api.errorMessage(results[i].reason);
      });
    }

    /** Items a "Upscale now" run would process (targets; the back only when one is resolved). */
    function localItems() {
      const u = up();
      const items = [];
      if (u.targets.front !== false) items.push(...(state.lists.front?.images || []).map((i) => ({ ...i, kind: 'front' })));
      if (u.targets.double_sided !== false) items.push(...(state.lists.double_sided?.images || []).map((i) => ({ ...i, kind: 'double_sided' })));
      if (u.targets.back !== false) {
        const backs = state.lists.back?.images || [];
        const b = store.get('cards')?.summary?.back;
        let chosen = null;
        if (b?.mode === 'file' && b.file) chosen = backs.find((x) => x.rel === b.file) || null;
        else if ((!b || b.mode === 'auto') && backs.length === 1) chosen = backs[0];
        if (chosen) items.push({ ...chosen, kind: 'back' });
      }
      return items;
    }

    let estimateTimer = null;
    let estimateToken = 0;
    function scheduleEstimate(delay = 350) {
      clearTimeout(estimateTimer);
      // Late callers (loadStatus().then, loadLists().then) must not start a plan after unmount.
      if (ctx.signal.aborted) return;
      estimateTimer = setTimeout(() => {
        computeEstimate().catch((err) => {
          // eslint-disable-next-line no-console
          console.warn('[upscale] estimate failed', err);
        });
      }, delay);
    }
    disposers.push(() => clearTimeout(estimateTimer));

    async function computeEstimate() {
      if (!state.status?.found || !state.status.models.length) {
        // Nothing can be upscaled until Upscayl and its models are available.
        estimateToken += 1;
        state.estimate = null;
        state.estimateSource = null;
        state.estimateLoading = false;
        state.estimateError = null;
        renderEstimate();
        return;
      }
      const token = ++estimateToken;
      state.estimateLoading = true;
      renderEstimate();
      let est = null;
      let source = null;
      try {
        const options = { ...(settings()?.pdf?.options || {}), upscale: true };
        const plan = await api.pdf.plan(options);
        est = normalizePlanEstimate(plan?.upscale);
        if (est) source = 'plan';
      } catch {
        // The PDF planner is unavailable (or refused these options): use the fallbacks below.
      }
      if (!est) {
        // Second choice: the main process's own dry run for "Upscale now" (part of cacheInfo).
        try {
          const info = await api.upscayl.cacheInfo();
          if (info && typeof info === 'object' && !ctx.signal.aborted) {
            state.cache = info;
            state.cacheError = null;
            renderCache();
            est = normalizePlanEstimate(info);
            if (est) source = 'cache';
          }
        } catch {
          // Not available either: estimate locally below.
        }
      }
      if (!est) {
        if (!state.lists.front) await loadLists();
        if (state.lists.front) {
          const u = up();
          const dims = cardDimensions(settings(), store.get('introspection'));
          est = estimateLocally({
            items: localItems(),
            targetPpi: Number(settings()?.pdf?.options?.ppi) || 300,
            cardWidthMm: dims.widthMm,
            maxScale: u.scale,
            smartScale: u.smartScale !== false,
            secPerImage: u.secPerImage,
          });
          source = 'local';
        }
      }
      if (token !== estimateToken || ctx.signal.aborted) return;
      state.estimate = est;
      state.estimateSource = source;
      state.estimateError = est ? null : 'No estimate right now: your cards could not be read.';
      state.estimateLoading = false;
      renderEstimate();
    }

    async function loadCache() {
      try {
        const info = await api.upscayl.cacheInfo();
        if (ctx.signal.aborted) return;
        state.cache = info && typeof info === 'object' ? info : null;
        state.cacheError = null;
      } catch (err) {
        if (ctx.signal.aborted) return;
        state.cacheError = api.errorMessage(err);
      }
      renderCache();
    }

    async function upscaleNow() {
      const u = up();
      const targets = { front: u.targets.front !== false, back: u.targets.back !== false, double_sided: u.targets.double_sided !== false };
      if (!targets.front && !targets.back && !targets.double_sided) {
        ui.toast({ variant: 'warning', title: 'Choose which images to upscale', message: 'Tick at least one box under “Which images”.' });
        return;
      }
      try {
        const res = await api.upscayl.start({ targets });
        state.upscaleJobId = res?.jobId ? String(res.jobId) : null;
      } catch (err) {
        ui.showError(err, { title: 'Could not start upscaling' });
      }
    }

    async function stopJob(job) {
      const ok = await ui.confirmDialog({
        title: 'Stop upscaling?',
        message: 'Images upscaled so far are kept for next time. The rest will be upscaled when you make the PDF (or run this again).',
        confirmLabel: 'Stop',
        cancelLabel: 'Keep going',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.jobs.cancel(job.jobId);
      } catch (err) {
        ui.showError(err, { title: 'Could not stop upscaling' });
      }
    }

    async function tryOnOneCard() {
      if (!state.lists.front) await loadLists();
      const fronts = state.lists.front?.images || [];
      if (!fronts.length) {
        ui.toast({ variant: 'info', title: 'No cards to try', message: 'Get some cards first, then try upscaling one of them.' });
        return;
      }
      const dims = cardDimensions(settings(), store.get('introspection'));
      const card = await openCardPicker({
        images: fronts,
        unique: true,
        dims,
        title: 'Try upscaling one card',
        message: 'Choose a card (low-resolution ones show the biggest difference). It is upscaled with your current settings so you can compare it with the original. Nothing in your deck is changed.',
        badgeFor: (img) => {
          const p = effectivePpi(img.width, dims.widthMm);
          return p !== null && p < LOW_RES_INFO_PPI ? 'Low resolution' : null;
        },
      });
      if (!card || ctx.signal.aborted) return;
      const u = up();
      try {
        const request = { rel: card.rel, name: card.name || baseName(card.rel), model: effectiveModel(u.model, state.status?.models || []).id, scale: Number(u.scale) || 4 };
        const res = await api.upscayl.preview({ kind: 'front', rel: card.rel });
        const jobId = res?.jobId ? String(res.jobId) : null;
        lastPreviewRequest = request;
        pendingPreview = jobId ? { jobId, request } : null;
        if (ctx.signal.aborted) return;
        state.previewJobId = jobId;
        state.previewRequest = request;
        renderEstimate();
        checkTrackedJobs();
      } catch (err) {
        ui.showError(err, { title: 'Could not start the preview' });
      }
    }

    /**
     * Before/after modal of a finished "Try on one card" job.
     * @param {object} result preview job result (spec §9.7 + extras: name, model, scale, captions…)
     * @param {object|null} request what was asked (fallback for the name/model)
     * @param {string|null} jobId marks this preview as shown
     */
    function showPreview(result, request, jobId) {
      const before = result?.before;
      const after = result?.after;
      if (!before || !after) {
        ui.toast({ variant: 'warning', title: 'The preview has no picture', message: 'Try another card, or check the log in the activity bar.' });
        return;
      }
      const req = request || {};
      const name = typeof result.name === 'string' && result.name ? result.name : (req.name || null);
      const modelId = typeof result.model === 'string' && result.model ? result.model : (req.model || null);
      const modelName = modelId ? modelDisplayName(modelId) : null;
      const scale = Number(result.scale) || null;
      const took = Number(result.seconds) > 0 ? ` It took ${format.formatDuration(Number(result.seconds) * 1000)}.` : '';
      const how = modelName ? ` Upscaled${scale ? ` ${scale}×` : ''} with ${modelName}.` : '';
      const effPpi = Number(result.effPpi);
      const targetPpi = Number(result.targetPpi);
      if (jobId) shownPreviewJobs.add(String(jobId));
      ui.modal({
        title: name ? `Preview: ${shortName(name, 70)}` : 'Upscaling preview',
        wide: true,
        content: [
          h('p.small.muted', `Drag the handle to compare.${how}${took} This is only a preview: your deck is unchanged.`),
          result.alreadySharp ? ui.callout({
            variant: 'info',
            compact: true,
            message: `This card is already sharp enough for your print resolution${effPpi > 0 && targetPpi > 0 ? ` (about ${format.formatNumber(Math.round(effPpi))} of ${format.formatNumber(targetPpi)} pixels per inch)` : ''}, so Make PDF won't upscale it. The preview shows what 2× would look like.`,
          }) : null,
          compareSlider({
            before,
            after,
            beforeLabel: 'Original',
            afterLabel: 'Upscaled',
            beforeCaption: typeof result.beforeCaption === 'string' && result.beforeCaption ? result.beforeCaption : describeImageSize(result.beforeSize),
            afterCaption: typeof result.afterCaption === 'string' && result.afterCaption ? result.afterCaption : describeImageSize(result.afterSize),
            alt: name || 'Card',
          }),
        ],
        actions: [{ label: 'Close', variant: 'primary' }],
      });
    }

    function estimateLines() {
      const est = state.estimate;
      if (!est) return null;
      const parts = [];
      if (est.needed > 0) {
        parts.push(h('div', { style: { fontSize: '17px', lineHeight: '24px', fontWeight: '650' } },
          `${format.pluralize(est.needed, 'image')} ${est.needed === 1 ? 'needs' : 'need'} upscaling`));
        const meta = [
          Number.isFinite(est.secEst) && est.secEst !== null ? format.formatDuration(est.secEst * 1000, { approximate: true }) : null,
          Number.isFinite(est.bytesEst) && est.bytesEst !== null ? `about ${format.formatBytes(est.bytesEst)}` : null,
        ].filter(Boolean);
        if (meta.length) parts.push(h('div.muted', meta.join(' · ')));
      } else {
        parts.push(h('div', { style: { fontSize: '17px', lineHeight: '24px', fontWeight: '650' } }, 'Nothing to upscale right now'));
        parts.push(h('div.muted.small', est.cached || est.sharp ? 'Your images are already upscaled or sharp enough for your print resolution.' : 'There are no images to upscale yet.'));
      }
      const extra = [
        est.cached ? `${format.formatNumber(est.cached)} already upscaled` : null,
        est.sharp ? `${format.formatNumber(est.sharp)} already sharp enough` : null,
      ].filter(Boolean);
      if (extra.length && est.needed > 0) parts.push(h('div.small.muted', extra.join(' · ')));
      return parts;
    }

    function lastResultCallout() {
      const r = store.get('lastResults')?.upscale;
      if (!r || isRunning(store.get('job'))) return null;
      if (r.status === 'succeeded') {
        const res = r.result || {};
        const done = Number(res.upscaled) || 0;
        const bits = [
          Number(res.cached) ? `${format.formatNumber(res.cached)} were already done` : null,
          Number(res.sharp) ? `${format.formatNumber(res.sharp)} were sharp enough` : null,
          Number(res.fallbacks) ? `${format.formatNumber(res.fallbacks)} kept the original` : null,
          Number(res.skipped) ? `${format.formatNumber(res.skipped)} skipped` : null,
        ].filter(Boolean);
        const warn = !!(Number(res.fallbacks) || res.disabledUpscaling);
        const sentence = bits.length ? `${bits.join(' · ')}.` : '';
        return ui.callout({
          variant: warn ? 'warning' : 'success',
          compact: true,
          title: done ? `Upscaled ${format.pluralize(done, 'image')}${r.durationMs ? ` in ${format.formatDuration(r.durationMs)}` : ''}` : 'Upscaling finished',
          message: [sentence, ...(r.warnings || []).slice(0, 2)].filter(Boolean).join(' ') || undefined,
        });
      }
      if (r.status === 'failed') {
        return ui.callout({ variant: 'danger', compact: true, title: 'Upscaling did not finish', message: r.error?.message || 'Something went wrong.' });
      }
      if (r.status === 'cancelled') return ui.callout({ variant: 'neutral', compact: true, message: 'Upscaling was stopped. Images finished so far are kept.' });
      return null;
    }

    /** Live progress of a running "Upscale now" job (updated in place, see renderEstimate). */
    let runningRefs = null;

    function renderEstimate() {
      if (ctx.signal.aborted) return;
      const job = store.get('job');
      const running = isRunning(job) ? job : null;
      const st = state.status;
      const children = [];

      if (running && running.kind === 'upscale') {
        const p = running.progress || {};
        const percent = Number.isFinite(p.percent) ? p.percent : null;
        const label = p.label || 'Upscaling…';
        if (runningRefs && runningRefs.jobId === running.jobId && estimateEl.contains(runningRefs.bar)) {
          // Same job: only move the bar (rebuilding would steal clicks from the Stop button).
          runningRefs.bar.update(percent, label);
          return;
        }
        const bar = ui.progressBar({ percent, label });
        runningRefs = { jobId: running.jobId, bar };
        children.push(h('div.stack', { style: { '--gap': '12px' } },
          h('div', { style: { fontSize: '16px', fontWeight: '650' } }, running.title || 'Upscaling images'),
          bar,
          h('p.small.muted', 'You can keep using the app; the activity bar at the bottom shows the details.'),
          ui.row({ gap: 8 }, ui.button({ label: 'Stop', icon: 'stop', size: 'sm', onClick: () => stopJob(running) }))));
      } else {
        runningRefs = null;
        const noCards = !(state.lists.front?.images?.length || Number(store.get('cards')?.summary?.front));
        const unusable = !st?.found || !st.models.length;
        const previewRunning = running && running.kind === 'preview';
        const lastPreview = store.get('lastResults')?.preview;
        const previewReady = !previewRunning && lastPreview?.status === 'succeeded' && lastPreview.result?.before && lastPreview.result?.after;
        const openLastPreview = () => showPreview(lastPreview.result, state.previewRequest || lastPreviewRequest, lastPreview.jobId);
        if (previewReady && !shownPreviewJobs.has(String(lastPreview.jobId))) {
          // Finished while the user was on another page: offer it once, at the top.
          const name = lastPreview.result.name || lastPreviewRequest?.name;
          children.push(ui.callout({
            variant: 'accent',
            compact: true,
            icon: 'eye',
            title: 'Your preview is ready',
            message: name ? `“${shortName(name, 50)}” before and after upscaling.` : undefined,
            actions: [{ label: 'Show preview', variant: 'primary', onClick: openLastPreview }],
          }));
        }
        if (unusable && st?.found) children.push(h('p.small.muted', 'Upscaling can start once Upscayl\'s AI models are available (see above).'));
        else if (state.estimateLoading && !state.estimate) children.push(ui.skeleton({ lines: 2 }));
        else if (state.estimate) children.push(h('div.stack', { style: { '--gap': '2px' } }, estimateLines()));
        else if (state.estimateError) children.push(h('p.small.muted', state.estimateError));
        children.push(ui.row({ gap: 8 },
          jobControl(ui.button({ label: 'Upscale now', icon: 'sparkles', variant: 'primary', onClick: () => upscaleNow() }), unusable || (!!state.estimate && state.estimate.needed === 0) || noCards),
          jobControl(ui.button({ label: previewRunning ? 'Making the preview…' : 'Try on one card', icon: previewRunning ? undefined : 'eye', loading: !!previewRunning, onClick: () => tryOnOneCard() }), unusable || noCards)));
        if (running && running.kind !== 'preview' && running.kind !== 'upscale') {
          children.push(h('p.small.muted', `Available when “${running.title || 'the current task'}” finishes.`));
        } else if (noCards && !unusable) {
          children.push(h('p.small.muted', 'Add some cards first (Get cards or Your cards).'));
        }
        if (previewReady && shownPreviewJobs.has(String(lastPreview.jobId))) {
          children.push(ui.button({ label: 'Show the last preview again', variant: 'link', size: 'sm', onClick: openLastPreview }));
        }
      }
      const last = lastResultCallout();
      if (last) children.push(last);
      const upscaling = !!(running && running.kind === 'upscale');
      const subtitles = {
        plan: 'For your next PDF, with your current cards, print resolution and settings.',
        cache: 'For your current cards, print resolution and settings.',
        local: 'Approximate, for your current cards and print resolution.',
      };
      ui.mountInto(estimateEl, ui.card({
        title: upscaling ? 'Upscaling now' : 'Estimate',
        subtitle: upscaling ? null : (subtitles[state.estimateSource] || subtitles.cache),
        icon: upscaling ? 'sparkles' : 'clock',
        children,
      }));
      applyBusy();
    }

    async function clearCache() {
      const files = Number(state.cache?.files) || 0;
      const ok = await ui.confirmDialog({
        title: 'Delete the upscaled images?',
        message: `${files ? `${format.pluralize(files, 'upscaled image')} (${format.formatBytes(state.cache?.bytes)}) will be deleted. ` : ''}Your original card images are not touched. Images are upscaled again the next time they are needed.`,
        confirmLabel: 'Delete upscaled images',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api.upscayl.clearCache();
        const n = Number(res?.removed) || 0;
        ui.toast({ variant: 'success', title: n ? `Deleted ${format.pluralize(n, 'upscaled image')}` : 'Upscaled images deleted', timeout: 3500 });
      } catch (err) {
        ui.showError(err, { title: 'Could not delete the upscaled images' });
      } finally {
        loadCache();
        scheduleEstimate(50);
        ctx.refresh?.cards?.();
      }
    }

    function renderCache() {
      if (ctx.signal.aborted) return;
      const info = state.cache;
      const folder = store.get('appInfo')?.paths?.upscaledRoot || null;
      const files = Number(info?.files) || 0;
      const rows = info ? [
        ['Saved copies', files ? `${format.pluralize(files, 'image')} · ${format.formatBytes(info.bytes)}` : 'None yet'],
        Number.isFinite(Number(info.total)) && Number(info.total) > 0
          ? ['Up to date', `${format.formatNumber(Number(info.upToDate) || 0)} of ${format.pluralize(Number(info.total), 'card image')}`]
          : null,
      ] : null;
      ui.mountInto(cacheEl, ui.card({
        title: 'Upscaled images',
        subtitle: 'Kept so the next PDF is quick. Deleting them is safe.',
        icon: 'hard-drive',
        children: [
          rows ? ui.kv(rows) : state.cacheError ? h('p.small.muted', `Could not read the upscaled images: ${state.cacheError}`) : ui.skeleton({ lines: 2 }),
          ui.row({ gap: 8 },
            folder ? ui.button({ label: 'Open folder', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => api.shell.openPath(folder) }) : null,
            jobControl(ui.button({ label: 'Clear upscaled images', icon: 'trash', size: 'sm', variant: 'ghost', onClick: () => clearCache() }), !files)),
        ],
      }));
      applyBusy();
    }

    /* ---------------- layout ---------------- */

    function renderFooter() {
      const st = state.status;
      const u = up();
      let text;
      let detail;
      let tone = 'neutral';
      let iconName = 'file-pdf';
      if (!st?.found) {
        text = 'Upscaling is optional';
        detail = 'You can make your PDF without it; Upscayl can be added any time.';
      } else if (u.enabled !== false) {
        text = 'Upscaling is on';
        detail = 'Make PDF upscales the images that need it automatically (kept for next time).';
        tone = 'success';
        iconName = 'check-circle';
      } else {
        text = 'Upscaling is off';
        detail = 'Your PDF will use the original images.';
      }
      ui.mountInto(footerEl, nextStep({ text, detail, tone, icon: iconName, actionLabel: 'Make PDF', onAction: () => ctx.navigate('pdf') }));
    }

    function renderBody() {
      const st = state.status;
      if (!st?.found) {
        controls = null;
        formKey = '';
        ui.mountInto(bodyEl,
          state.statusLoading && !st ? null : ui.card({
            title: 'What upscaling does',
            icon: 'zoom-in',
            children: h('div.prose',
              h('p', 'Card pictures downloaded from the web are often small. Printed at full card size they can look soft.'),
              h('p', 'Upscayl uses an AI model to make each picture 2 to 4 times bigger and sharper before the PDF is made. It runs on your own computer, needs a graphics card, and is completely free.')),
          }),
          ui.grid({ min: 300, gap: 16 }, cacheEl));
        renderCache();
        return;
      }
      const key = JSON.stringify([st.binPath, st.models.map((m) => [m.id, m.custom ? 1 : 0, m.nonCommercial ? 1 : 0]), st.gpus, st.customModelsDir]);
      if (key !== formKey || !controls) {
        formKey = key;
        const parts = buildForm();
        ui.mountInto(bodyEl,
          parts.note,
          narrowSlot,
          ui.twoColumn({
            main: [parts.modelSection, parts.qualitySection, parts.targetsSection, parts.advancedSection],
            aside: [estimateEl, cacheEl],
            asideWidth: 330,
          }));
        renderModelWarning();
        placeEstimate();
      } else {
        syncControls();
      }
      renderEstimate();
      renderCache();
    }

    /*
     * Narrow windows (the two columns stack below ~900 px of content width): the Estimate card with
     * "Upscale now" / "Try on one card" would end up below every setting, so it moves to a slot
     * above the columns; it goes back to the side column when there is room again.
     */
    const narrowSlot = h('div', { hidden: true });
    function placeEstimate() {
      const twoCol = bodyEl.querySelector(':scope > .two-col');
      const aside = twoCol?.querySelector(':scope > .two-col-aside');
      if (!twoCol || !aside) return;
      const tracks = getComputedStyle(twoCol).gridTemplateColumns.trim().split(/\s+/).filter(Boolean).length;
      const stacked = tracks < 2;
      if (stacked && estimateEl.parentNode !== narrowSlot) narrowSlot.append(estimateEl);
      else if (!stacked && estimateEl.parentNode !== aside) aside.prepend(estimateEl);
      narrowSlot.hidden = !narrowSlot.firstChild;
    }
    if (typeof ResizeObserver === 'function') {
      let lastWidth = -1;
      const ro = new ResizeObserver((entries) => {
        const width = Math.round(entries[entries.length - 1]?.contentRect?.width || 0);
        if (width === lastWidth) return;
        lastWidth = width;
        placeEstimate();
      });
      ro.observe(bodyEl);
      disposers.push(() => ro.disconnect());
    }

    function renderAll() {
      if (ctx.signal.aborted) return;
      ui.mountInto(statusEl, statusCard());
      renderBody();
      renderFooter();
      applyBusy();
    }

    /* ---------------- store subscriptions ---------------- */

    /** Finished jobs already handled (each finish is acted on once). */
    const handledJobs = new Set();

    /**
     * React once to a finished job: show the preview, refresh the GPU list, reload cache/estimate.
     * @param {object|null} job store `job` entry
     */
    function handleFinished(job) {
      if (!job || isRunning(job)) return;
      const id = String(job.jobId);
      if (handledJobs.has(id)) return;
      if (id === state.previewJobId) {
        handledJobs.add(id);
        state.previewJobId = null;
        if (pendingPreview && pendingPreview.jobId === id) pendingPreview = null;
        if (job.status === 'succeeded') showPreview(job.result, state.previewRequest, id);
        else if (job.status === 'failed') ui.toast({ variant: 'danger', title: 'The preview did not work', message: job.error?.message || 'Something went wrong.', timeout: 9000 });
        renderEstimate();
        return;
      }
      if (id === state.probeJobId) {
        handledJobs.add(id);
        state.probeJobId = null;
        if (job.status === 'succeeded') {
          const n = Array.isArray(job.result?.gpus) ? job.result.gpus.length : null;
          ui.toast({ variant: 'success', title: n === null ? 'Graphics cards checked' : `Found ${format.pluralize(n, 'graphics card')}`, timeout: 3500 });
        } else if (job.status === 'failed') {
          ui.toast({ variant: 'warning', title: 'Could not check the graphics cards', message: job.error?.message || undefined, timeout: 8000 });
        }
        loadStatus({ refresh: false });
        return;
      }
      if (job.kind === 'upscale' || job.kind === 'pdf') {
        handledJobs.add(id);
        state.upscaleJobId = null;
        loadCache();
        scheduleEstimate(200);
      }
    }

    /** A job we started may already be over by the time its id is known: check the store. */
    function checkTrackedJobs() {
      const job = store.get('job');
      if (job && (String(job.jobId) === state.previewJobId || String(job.jobId) === state.probeJobId)) handleFinished(job);
    }

    ctx.subscribe('job', (job) => {
      const busy = isRunning(job);
      const busyChanged = busy !== state.busy;
      state.busy = busy;
      handleFinished(job);
      if (busyChanged || (job && (job.kind === 'upscale' || job.kind === 'preview' || job.kind === 'probe'))) {
        renderEstimate();
        if (busyChanged) ui.mountInto(statusEl, statusCard());
        applyBusy();
      }
    });

    let lastSettingsSig = '';
    const settingsSig = () => {
      const s = settings();
      return JSON.stringify([s?.upscayl, s?.pdf?.options?.ppi, s?.pdf?.options?.card_size, s?.pdf?.options?.specialty]);
    };
    lastSettingsSig = settingsSig();
    ctx.subscribe('settings', () => {
      const sig = settingsSig();
      if (sig === lastSettingsSig) return;
      lastSettingsSig = sig;
      syncControls();
      renderFooter();
      scheduleEstimate();
    });

    let lastVersion = store.get('cards')?.version ?? 0;
    ctx.subscribe('cards', (c) => {
      const v = c?.version ?? 0;
      if (v === lastVersion) return;
      lastVersion = v;
      loadLists().then(() => scheduleEstimate(150)).catch(() => {});
    });

    ctx.subscribe('lastResults', () => renderEstimate());

    /* ---------------- first render ---------------- */

    if (state.previewJobId) {
      // A preview started on an earlier visit: keep waiting only if it is still running; a finished
      // one is offered in the Estimate card instead of popping up unexpectedly.
      const j = store.get('job');
      if (!(j && String(j.jobId) === state.previewJobId && isRunning(j))) {
        state.previewJobId = null;
        state.previewRequest = null;
        pendingPreview = null;
      }
    }
    renderAll();
    loadStatus({ refresh: false }).then(() => scheduleEstimate(50));
    loadCache();
    loadLists().then(() => {
      if (!ctx.signal.aborted) renderEstimate();
    }).catch(() => {});

    return () => {
      statusToken += 1;
      estimateToken += 1;
      for (const fn of disposers.splice(0)) {
        try {
          fn();
        } catch {
          /* keep cleaning */
        }
      }
    };
  },
};
