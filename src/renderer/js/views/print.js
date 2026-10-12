/**
 * Print & cut view (`#/print`, spec §8.4 "Print & cut", §13.3).
 *
 * A step-by-step checklist (Print → Check → Cut → Finish) filled from the last PDF
 * (`scm.print.info().lastPdf`, else settings.pdf.lastPdf) and the current Make PDF settings
 * (`scm.pdf.plan(...)` for the layout, template and skip slots). Tips come from option-docs
 * PRINT_TIPS, filtered by their `when` field and filled with `fillPlaceholders({ paper, cardDims,
 * template, studioMachine })`.
 *
 * Actions: open the PDF, open the cutting template (`scm.print.openTemplate`, which copies the
 * .studio3 next to your PDFs and opens it), "Leave that slot empty" (adds the slot next to the
 * bottom-left mark to settings.pdf.skipByLayout and goes back to Make PDF), help links.
 * Degrades gracefully: without print.info or a plan it still works from settings + introspection.
 *
 * @module views/print
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { pagePreview, slotNearBottomLeftMark } from '../components/page-preview.js';
import { nextStep } from '../components/next-step.js';
import {
  PRINT_TIPS, REGISTRATION_HELP, fillPlaceholders, getCardSize, getPaperSize, getMachine, studioMachineFor,
} from '../data/option-docs.js';
import { EXTERNAL_LINKS, getHelpLink } from '../data/help.js';
import { normalizeOptions, findLayout, layoutKeyFor, cleanSkip, baseName, dirName, shortPath, dateText } from './pdf.js';

const { h, icon } = ui;

/** Papers longer than a 12 x 12 in mat (spec: legal, tabloid, a3, arch_b need a 12 x 24 in mat). */
const LARGE_PAPER_MM = 305;
const FOCUSABLE = 'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

/* ------------------------------------------------------------------------------------------------
 * Pure helpers (exported for tests)
 * ---------------------------------------------------------------------------------------------- */

/**
 * Situation flags used by PRINT_TIPS `when` values.
 * @param {{ twoSided?: boolean, tight?: boolean, paper?: string, registration?: string }} input
 * @returns {{ always: true, twoSided: boolean, tight: boolean, largePaper: boolean, threeMarks: boolean, fourMarks: boolean }}
 */
export function tipFlags({ twoSided = false, tight = false, paper = 'letter', registration = '3' } = {}) {
  const info = getPaperSize(paper);
  const longSide = info ? Math.max(info.widthMm, info.heightMm) : 0;
  return {
    always: true,
    twoSided: !!twoSided,
    tight: !!tight,
    largePaper: longSide > LARGE_PAPER_MM,
    threeMarks: String(registration) !== '4',
    fourMarks: String(registration) === '4',
  };
}

/**
 * Tips of one checklist section that apply to the situation, with placeholders filled.
 * @param {Array<{ id: string, when: string, text: string }>} tips
 * @param {ReturnType<typeof tipFlags>} flags
 * @param {Record<string, string>} values placeholder values ({paper}, {cardDims}, {template}, {studioMachine})
 * @returns {Array<{ id: string, text: string }>}
 */
export function selectTips(tips, flags, values) {
  return (Array.isArray(tips) ? tips : [])
    .filter((t) => t && (t.when === 'always' || flags[t.when]))
    .map((t) => ({ id: t.id, text: fillPlaceholders(t.text, values) }));
}

/**
 * Card dimensions text for the "measure one card" tip.
 * @param {Record<string, any>} opts normalized options
 * @param {any} layout introspection layout (used for specialty layouts)
 * @returns {string}
 */
export function cardDimsText(opts, layout) {
  if (!opts.specialty) {
    const info = getCardSize(opts.card_size);
    if (info) return info.dimensions;
  }
  const w = Number(layout?.cardWidthMm);
  const hgt = Number(layout?.cardHeightMm);
  if (w > 0 && hgt > 0) return `${format.formatNumber(w, { maximumFractionDigits: 1 })} x ${format.formatNumber(hgt, { maximumFractionDigits: 1 })} mm`;
  return 'the card size you chose';
}

/**
 * @param {Element} root
 * @returns {string|null}
 */
function focusedKey(root) {
  const active = document.activeElement;
  if (!active || !root.contains(active)) return null;
  return active.closest('[data-fk]')?.dataset.fk || null;
}

/**
 * @param {Element} root
 * @param {string|null} fk
 */
function refocus(root, fk) {
  if (!fk) return;
  const holder = [...root.querySelectorAll('[data-fk]')].find((el) => el.dataset.fk === fk);
  const target = holder && (holder.matches(FOCUSABLE) ? holder : holder.querySelector(FOCUSABLE));
  try {
    target?.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
}

/* ------------------------------------------------------------------------------------------------
 * View
 * ---------------------------------------------------------------------------------------------- */

export default {
  id: 'print',
  title: 'Print & cut',
  icon: 'scissors',

  /**
   * @param {HTMLElement} container
   * @param {any} ctx view context (spec §13.3)
   * @returns {() => void}
   */
  mount(container, ctx) {
    const { api, store } = ctx;
    const navigate = (id, params) => ctx.navigate(id, params);
    let disposed = false;
    /** @type {any} */
    let info = null;
    let infoError = null;
    /** @type {any} */
    let plan = null;
    /** undefined = loading, null = none saved */
    let offsetInfo;
    let loading = true;
    /** @type {{ opened: boolean, error?: string|null }|null} */
    let templateResult = null;
    let frame = 0;

    const settings = () => store.get('settings') || {};
    const opts = () => normalizeOptions(settings().pdf?.options);

    function lastPdf() {
      const fromInfo = info && info.lastPdf && typeof info.lastPdf === 'object' ? info.lastPdf : null;
      const fromSettings = settings().pdf?.lastPdf;
      return fromInfo || (fromSettings && typeof fromSettings === 'object' ? fromSettings : null);
    }

    function layout() {
      return plan?.layout || findLayout(store.get('introspection'), opts());
    }

    /** Template of the current Make PDF settings. */
    function currentTemplate() {
      const t = info?.template;
      if (t && (t.file || t.name)) return t;
      if (plan?.template) return plan.template;
      const l = layout();
      return l ? { name: l.template || null, file: l.templateFile || null } : { name: null, file: null };
    }

    /** Template to cut with: the one the last PDF was made for (when known), else the current one. */
    function template() {
      const t = lastPdf()?.template;
      if (t && typeof t === 'object' && (t.name || t.file)) return { name: t.name || null, file: t.file || null };
      return currentTemplate();
    }

    /** Paper of the PDF being printed (recorded by the PDF job), else the current setting. */
    function printPaper() {
      const recorded = lastPdf()?.paperSize;
      if (typeof recorded === 'string' && getPaperSize(recorded)) return getPaperSize(recorded).name;
      const o = opts();
      const l = layout();
      return o.specialty && l?.paper ? l.paper : o.paper_size;
    }

    /** Tight layout for the PDF being printed (its template name says so), else the current setting. */
    function printTight() {
      const name = lastPdf()?.template?.name;
      if (typeof name === 'string' && name) return /borderless/i.test(name);
      return !!opts().borderless;
    }

    /**
     * The current Make PDF settings differ from the ones the last PDF was made with (paper or card
     * size), so the sheet in hand doesn't match what Make PDF shows.
     * @returns {boolean}
     */
    function settingsChangedSincePdf() {
      const pdf = lastPdf();
      if (!pdf || typeof pdf.paperSize !== 'string' || !pdf.paperSize) return false;
      const o = opts();
      if (o.specialty) return !!pdf.cardSize;
      const paperDiffers = getPaperSize(pdf.paperSize)?.name !== getPaperSize(o.paper_size)?.name;
      const cardDiffers = typeof pdf.cardSize === 'string' && pdf.cardSize && getCardSize(pdf.cardSize)?.name !== getCardSize(o.card_size)?.name;
      return paperDiffers || !!cardDiffers;
    }

    function studio() {
      return info?.silhouetteStudio || store.get('env')?.silhouetteStudio || null;
    }

    function twoSided() {
      const pdf = lastPdf();
      if (pdf && typeof pdf.onlyFronts === 'boolean') return !pdf.onlyFronts;
      return !opts().only_fronts;
    }

    function planRequest() {
      const s = settings();
      return {
        ...opts(),
        upscale: false,
        fileName: s.pdf?.fileName || null,
        outputDir: s.outputDir || null,
        ackNoTemplate: true,
        ignoreMemoryLimit: true,
        printBackFaces: s.pdf?.printBackFaces !== false,
      };
    }

    let loadSeq = 0;
    async function load() {
      const seq = ++loadSeq;
      loading = true;
      const [infoRes, planRes, offsetRes] = await Promise.allSettled([
        api.print.info(),
        api.pdf.plan(planRequest()),
        api.offset.get(),
      ]);
      if (disposed || seq !== loadSeq) return; // a newer load (new PDF finished) is on its way
      if (infoRes.status === 'fulfilled') {
        info = infoRes.value && typeof infoRes.value === 'object' ? infoRes.value : null;
        infoError = null;
      } else {
        info = null;
        infoError = api.errorMessage(infoRes.reason);
      }
      plan = planRes.status === 'fulfilled' && planRes.value && typeof planRes.value === 'object' ? planRes.value : null;
      offsetInfo = offsetRes.status === 'fulfilled' ? (offsetRes.value && typeof offsetRes.value === 'object' ? offsetRes.value : null) : null;
      loading = false;
      render();
    }

    function scheduleRender() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        render();
      });
    }

    /* ------------------------------ actions ------------------------------ */

    async function openTemplate(file) {
      const res = await api.print.openTemplate(file);
      templateResult = res && typeof res === 'object' ? res : { opened: true };
      if (templateResult.opened === false) {
        ui.toast({ variant: 'warning', title: 'The cutting template could not be opened', message: templateResult.error || "Silhouette Studio doesn't seem to be installed.", timeout: 8000 });
      } else {
        ui.toast({
          variant: 'success',
          title: 'Opening the cutting template',
          message: templateResult.copiedTo ? `A copy was saved in ${dirName(templateResult.copiedTo)}.` : 'It opens in Silhouette Studio.',
        });
      }
      render();
    }

    async function leaveSlotEmpty() {
      const l = layout();
      if (!l) return;
      const o = opts();
      const key = plan?.layoutKey || layoutKeyFor(o);
      const per = Number(l.cardsPerPage) || (Array.isArray(l.xPos) && Array.isArray(l.yPos) ? l.xPos.length * l.yPos.length : 0);
      const current = cleanSkip(settings().pdf?.skipByLayout?.[key], per || null);
      const slot = slotNearBottomLeftMark(l);
      if (slot < 0) return;
      if (!current.includes(slot)) {
        if (per && current.length + 1 >= per) {
          ui.toast({ variant: 'warning', title: 'At least one slot must hold a card', message: 'Use some of the empty slots again in Make PDF first.' });
          return;
        }
        await api.settings.update({ pdf: { skipByLayout: { [key]: [...current, slot].sort((a, b) => a - b) } } });
      }
      ui.toast({ variant: 'success', title: `Slot ${slot + 1} will be left empty on every sheet`, message: 'Make your PDF again, then print it.' });
      navigate('pdf');
    }

    function openLink(id) {
      const link = getHelpLink(id);
      if (link) return api.shell.openExternal(link.url);
      return undefined;
    }

    /* ------------------------------ parts ------------------------------ */

    function tipList(items) {
      // Numbers sit inside the card padding (the default list indent lets them hang outside).
      return h('ol.prose', { style: { margin: '0', maxWidth: 'none', paddingLeft: '24px' } }, items.map((t) => h('li', { dataset: { tip: t.id }, style: { paddingLeft: '2px' } }, t.text)));
    }

    function placeholderValues() {
      const o = opts();
      const l = layout();
      const paperName = printPaper();
      const paper = getPaperSize(paperName);
      const t = template();
      const m = getMachine(settings().equipment?.machine || null);
      const recordedCard = lastPdf()?.cardSize;
      const recordedInfo = typeof recordedCard === 'string' && recordedCard ? getCardSize(recordedCard) : null;
      return {
        paper: paper ? paper.label : String(paperName),
        cardDims: recordedInfo ? recordedInfo.dimensions : cardDimsText(o, l),
        template: t.name ? `“${t.name}”` : 'for your layout',
        studioMachine: studioMachineFor(m ? m.id : null, o.registration),
      };
    }

    function flags() {
      const o = opts();
      return tipFlags({ twoSided: twoSided(), tight: printTight(), paper: printPaper(), registration: o.registration });
    }

    function renderTopNotice() {
      const pdf = lastPdf();
      if (loading && !pdf) return null;
      if (!pdf || !pdf.path) {
        return ui.callout({
          variant: 'accent',
          icon: 'file-pdf',
          title: 'Make your PDF first',
          message: 'This page walks you through printing and cutting it. You can read ahead in the meantime.',
          actions: [{ label: 'Make PDF', icon: 'file-pdf', variant: 'primary', onClick: () => navigate('pdf') }],
        });
      }
      if (pdf.exists === false) {
        return ui.callout({
          variant: 'warning',
          title: 'Your last PDF was moved or deleted',
          message: `“${baseName(pdf.path)}” is no longer in ${shortPath(dirName(pdf.path), 3)}. Make it again, or open it from where you moved it.`,
          actions: [{ label: 'Make PDF', icon: 'file-pdf', variant: 'primary', onClick: () => navigate('pdf') }],
        });
      }
      const out = [];
      if (settingsChangedSincePdf()) {
        out.push(ui.callout({
          variant: 'info',
          title: 'Your Make PDF settings changed since this PDF was made',
          message: 'The steps below match the PDF you made. Make it again to print with your new settings.',
          actions: [{ label: 'Make PDF', icon: 'file-pdf', onClick: () => navigate('pdf') }],
        }));
      }
      if (twoSided()) {
        const o = offsetInfo;
        const saved = o && o.valid !== false && (Number(o.x_offset) || Number(o.y_offset) || Number(o.angle_offset));
        // A valid 0, 0, 0 alignment = measured, no correction needed: nothing to warn about.
        const measuredZero = !!o && o.valid !== false && !saved;
        if (!pdf.loadOffset && !measuredZero) {
          out.push(ui.callout({
            variant: 'warning',
            title: 'The backs may not line up',
            message: saved
              ? 'This PDF was made without your printer alignment. Turn on “Apply my printer alignment” in Make PDF and make it again.'
              : 'Two-sided sheets need a one-time Printer alignment so the backs land exactly behind the fronts.',
            actions: saved
              ? [{ label: 'Make PDF', onClick: () => navigate('pdf') }]
              : [{ label: 'Printer alignment', icon: 'crosshair', onClick: () => navigate('offset') }],
          }));
        }
      }
      return out;
    }

    function renderPrintCard(values, f) {
      const pdf = lastPdf();
      const tips = selectTips(PRINT_TIPS.print, f, values);
      return ui.card({
        title: '1. Print',
        subtitle: 'From your PDF viewer, at actual size.',
        icon: 'printer',
        actions: pdf?.path && pdf.exists !== false ? [h('span', { dataset: { fk: 'open-pdf-1' } }, ui.button({ label: 'Open PDF', icon: 'file-pdf', size: 'sm', variant: 'primary', onClick: () => api.shell.openPath(pdf.path) }))] : null,
        children: tipList(tips),
      });
    }

    function renderCheckCard(values, f) {
      return ui.card({
        title: '2. Check',
        subtitle: 'Before cutting a whole deck.',
        icon: 'ruler',
        children: tipList(selectTips(PRINT_TIPS.check, f, values)),
      });
    }

    function renderRegistrationHelp() {
      const l = layout();
      if (!l) return null;
      const o = opts();
      const key = plan?.layoutKey || layoutKeyFor(o);
      const per = Number(l.cardsPerPage) || null;
      const skip = cleanSkip(settings().pdf?.skipByLayout?.[key], per);
      const slot = slotNearBottomLeftMark(l);
      if (slot < 0) return null;
      const displayLayout = o.registration_orientation ? { ...l, registrationOrientation: o.registration_orientation } : l;
      const mini = pagePreview({ layout: displayLayout, registration: o.registration === '4' ? '4' : '3', skip, highlightIndex: slot, showLegend: false });
      const already = skip.includes(slot);
      return ui.card({
        variant: 'flat',
        title: 'If registration fails',
        children: ui.row({ gap: 16, align: 'flex-start' },
          h('div', { style: { width: '220px', flex: 'none' } }, mini),
          h('div.stack', { style: { '--gap': '10px', flex: '1 1 220px', minWidth: '0' } },
            h('p.small', `Your machine can mistake the art of slot ${slot + 1} (circled) for the bottom-left mark. Cover that card with a Post-it note during registration (remove it before cutting), or leave the slot empty.`),
            h('ul.prose.small', { style: { margin: '0', paddingLeft: '18px' } }, REGISTRATION_HELP.troubleshooting.filter((t) => !/Post-it/i.test(t)).slice(0, 3).map((t) => h('li', t))),
            already
              ? h('p.small.text-success', { dataset: { fk: 'slot-done' } }, `Slot ${slot + 1} is already left empty in Make PDF.`)
              : h('div', { dataset: { fk: 'leave-slot' } }, ui.button({ label: 'Leave that slot empty', icon: 'scan', size: 'sm', onClick: leaveSlotEmpty })))),
      });
    }

    function renderCutCard(values, f) {
      const t = template();
      let tips = selectTips(PRINT_TIPS.cut, f, values);
      if (!t.file) {
        tips = tips.map((tip) => (tip.id === 'template'
          ? { id: tip.id, text: 'Open your own cutting template for this layout in Silhouette Studio: no ready-made template is included for it.' }
          : tip));
      }
      const st = studio();
      const studioMissing = (st && st.found === false) || (templateResult && templateResult.opened === false);
      const children = [];
      if (t.file) {
        children.push(ui.row({ gap: 10, wrap: false },
          h('span', { style: { color: 'var(--muted)', display: 'inline-flex' } }, icon('file', { size: 16 })),
          h('span.mono.small.truncate', { title: t.file, style: { flex: '1', minWidth: '0' } }, `${t.name || baseName(t.file).replace(/\.studio3$/i, '')}.studio3`),
          h('span', { dataset: { fk: 'show-template' } }, ui.button({ label: 'Show file', size: 'sm', variant: 'ghost', icon: 'folder-open', onClick: () => api.shell.showItemInFolder(t.file) }))));
      } else {
        children.push(ui.callout({
          variant: 'warning',
          compact: true,
          message: t.name
            ? `No ready-made cutting template (“${t.name}”) is included for this layout. You need your own.`
            : 'No ready-made cutting template for this combination. You need your own.',
        }));
      }
      if (studioMissing) {
        children.push(ui.callout({
          variant: 'warning',
          compact: true,
          title: "Silhouette Studio doesn't seem to be installed",
          message: `${EXTERNAL_LINKS.silhouetteStudio.description}`,
          actions: [{ label: EXTERNAL_LINKS.silhouetteStudio.label, icon: 'external-link', onClick: () => api.shell.openExternal(EXTERNAL_LINKS.silhouetteStudio.url) }],
        }));
      } else if (st && st.found) {
        children.push(h('p.small.muted', `Silhouette Studio${st.version ? ` ${st.version}` : ''} is installed.`));
      }
      children.push(tipList(tips));
      children.push(renderRegistrationHelp());
      const settingsLink = getHelpLink('cuttingSettings');
      if (settingsLink) {
        children.push(ui.row({ gap: 8 }, ui.button({ label: settingsLink.label, variant: 'link', size: 'sm', iconRight: 'external-link', onClick: () => openLink('cuttingSettings') })));
      }
      return ui.card({
        title: '3. Cut',
        subtitle: 'With Silhouette Studio and your cutting machine.',
        icon: 'scissors',
        actions: t.file ? [h('span', { dataset: { fk: 'open-template' } }, ui.button({ label: 'Open cutting template', icon: 'scissors', size: 'sm', variant: 'primary', onClick: () => openTemplate(t.file) }))] : null,
        children,
      });
    }

    function renderFinishCard(values, f) {
      return ui.card({
        title: '4. Finish',
        icon: 'check-circle',
        children: tipList(selectTips(PRINT_TIPS.finish, f, values)),
      });
    }

    function renderPdfCard() {
      const pdf = lastPdf();
      if (loading && !pdf) return ui.card({ title: 'Your PDF', icon: 'file-pdf', children: ui.skeleton({ lines: 3 }) });
      if (!pdf || !pdf.path) {
        return ui.card({
          title: 'Your PDF',
          icon: 'file-pdf',
          children: [
            h('p.small.muted', "You haven't made a PDF yet."),
            h('div', { dataset: { fk: 'make-pdf' } }, ui.button({ label: 'Make PDF', icon: 'file-pdf', variant: 'primary', size: 'sm', onClick: () => navigate('pdf') })),
          ],
        });
      }
      const missing = pdf.exists === false;
      const rows = [
        ['File', h('span', { title: pdf.path }, baseName(pdf.path))],
        ['Folder', h('span', { title: dirName(pdf.path) }, shortPath(dirName(pdf.path), 1))],
      ];
      if (pdf.at) rows.push(['Made', dateText(pdf.at, store.get('appInfo')?.locale)]);
      if (Number.isFinite(pdf.pages)) rows.push(['Pages', format.pluralize(pdf.pages, 'page')]);
      if (typeof pdf.onlyFronts === 'boolean') rows.push(['Sides', pdf.onlyFronts ? 'Fronts only' : 'Fronts and backs']);
      if (Number.isFinite(pdf.ppi)) rows.push(['Resolution', `${format.formatNumber(pdf.ppi)} PPI`]);
      if (Number.isFinite(pdf.sizeBytes) && pdf.sizeBytes > 0 && !missing) rows.push(['Size', format.formatBytes(pdf.sizeBytes)]);
      if (pdf.onlyFronts === false) rows.push(['Printer alignment', pdf.loadOffset ? 'Applied' : 'Not applied']);
      return ui.card({
        title: 'Your PDF',
        icon: 'file-pdf',
        actions: missing ? [ui.badge('Not found', 'warning', { icon: 'alert-triangle' })] : null,
        children: [
          ui.kv(rows),
          missing
            ? h('div', { dataset: { fk: 'make-pdf' } }, ui.button({ label: 'Make PDF', icon: 'file-pdf', variant: 'primary', size: 'sm', onClick: () => navigate('pdf') }))
            : ui.row({ gap: 8 },
              h('span', { dataset: { fk: 'open-pdf' } }, ui.button({ label: 'Open PDF', icon: 'file-pdf', size: 'sm', variant: 'primary', onClick: () => api.shell.openPath(pdf.path) })),
              h('span', { dataset: { fk: 'show-pdf' } }, ui.button({ label: 'Show in folder', icon: 'folder-open', size: 'sm', onClick: () => api.shell.showItemInFolder(pdf.path) }))),
        ],
      });
    }

    function renderSetupCard() {
      const o = opts();
      const l = layout();
      const paper = getPaperSize(o.specialty && l?.paper ? l.paper : o.paper_size);
      const card = getCardSize(o.card_size);
      const m = getMachine(settings().equipment?.machine || null);
      const t = currentTemplate();
      const reg = o.registration === '4' ? '4' : '3';
      const rows = [
        ['Paper', paper ? paper.label : o.paper_size],
        ['Cards', o.specialty ? cardDimsText(o, l) : (card ? `${card.label} (${card.dimensions})` : o.card_size)],
      ];
      if (o.borderless) rows.push(['Layout', 'Tight layout']);
      rows.push(['Machine', m ? `${m.label} (select “${studioMachineFor(m.id, reg)}”)` : 'Not chosen']);
      rows.push(['Marks', reg === '4' ? '4-corner marks' : '3-corner marks']);
      rows.push(['Template', t.name ? h('span', { style: { overflowWrap: 'anywhere' } }, t.name) : 'None included']);
      if (paper && Math.max(paper.widthMm, paper.heightMm) > LARGE_PAPER_MM) rows.push(['Mat', '12 x 24 in']);
      return ui.card({
        title: 'Your setup',
        subtitle: 'From your current Make PDF settings.',
        icon: 'sliders',
        children: [
          ui.kv(rows),
          ui.row({ gap: 8 }, ui.button({ label: 'Change in Make PDF', size: 'sm', variant: 'link', iconRight: 'arrow-right', onClick: () => navigate('pdf') })),
        ],
      });
    }

    function renderHelpCard() {
      const ids = ['tutorial', 'guide', 'troubleshooting', 'verifyTemplates'];
      if (opts().borderless) ids.splice(2, 0, 'borderless');
      const links = ids.map((id) => getHelpLink(id)).filter(Boolean);
      return ui.card({
        title: 'Need help?',
        icon: 'life-buoy',
        children: h('div.stack', { style: { '--gap': '10px' } }, links.map((l) => h('div.stack', { style: { '--gap': '2px' } },
          h('div', ui.button({ label: l.label, variant: 'link', size: 'sm', iconRight: 'external-link', onClick: () => api.shell.openExternal(l.url) })),
          h('div.tiny.muted', l.description)))),
      });
    }

    function render() {
      if (disposed) return;
      const fk = focusedKey(container);
      const values = placeholderValues();
      const f = flags();
      const header = ui.pageHeader({
        title: 'Print & cut',
        subtitle: 'Print your sheets at actual size, then let your Silhouette cut them out.',
        icon: 'scissors',
        step: 5,
      });
      const main = [
        renderPrintCard(values, f),
        renderCheckCard(values, f),
        renderCutCard(values, f),
        renderFinishCard(values, f),
      ];
      const aside = [renderPdfCard(), renderSetupCard(), renderHelpCard()];
      if (infoError && !loading) {
        aside.push(h('p.tiny.muted', 'Some details could not be loaded; the tips use your Make PDF settings.'));
      }
      const footer = nextStep({
        text: 'All cut?',
        detail: 'Get the cards for your next deck, or change your settings and print again.',
        actionLabel: 'Get cards',
        icon: 'check-circle',
        onAction: () => navigate('fetch'),
        secondary: twoSided()
          ? { label: 'Printer alignment', icon: 'crosshair', onClick: () => navigate('offset') }
          : { label: 'Back to Make PDF', icon: 'file-pdf', onClick: () => navigate('pdf') },
      });
      ui.mountInto(container, header, renderTopNotice(), ui.twoColumn({ main, aside, asideWidth: 320 }), footer);
      refocus(container, fk);
    }

    ctx.subscribe('settings', scheduleRender);
    ctx.subscribe('env', scheduleRender);
    ctx.subscribe('introspection', scheduleRender);
    ctx.subscribe('lastResults', (next, prev) => {
      if (next?.pdf?.jobId !== prev?.pdf?.jobId) load();
    });

    render();
    load();

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
    };
  },
};
