/**
 * Kitchen sink (dev only, `#/kitchen`, not in the navigation): renders every UI-kit component,
 * the activity bar in each state, sheet previews, and the other shared components for visual QA.
 *
 * @module views/kitchen
 */

import * as ui from '../core/ui.js';
import * as format from '../core/format.js';
import { iconNames } from '../core/icons.js';
import { createStore } from '../core/store.js';
import { renderRouteError } from '../core/router.js';
import { mountActivityBar } from '../components/activity.js';
import { pagePreview } from '../components/page-preview.js';
import { nextStep } from '../components/next-step.js';
import { compareSlider } from '../components/compare-slider.js';

const { h, icon } = ui;

/** Real layouts (computed from the engine) used when introspection is not available. */
const SAMPLE_LAYOUTS = [
  { key: 'letter|standard|default', paper: 'letter', card: 'standard', variant: 'default', specialty: null, orientation: 'landscape', registrationOrientation: 'landscape', rows: 2, cols: 4, cardsPerPage: 8, xPos: [140, 899, 1658, 2417], yPos: [228, 1282], cardWidthPx: 744, cardHeightPx: 1039, paperWidthPx: 3300, paperHeightPx: 2550, inset: '10mm', thickness: '1mm', length: '8.04mm', cardWidthMm: 63, cardHeightMm: 88, paperWidthMm: 279.4, paperHeightMm: 215.9, template: 'letter-standard-v6', templateFile: null, error: null },
  { key: 'a4|standard|borderless', paper: 'a4', card: 'standard', variant: 'borderless', specialty: null, orientation: 'portrait', registrationOrientation: 'portrait', rows: 3, cols: 3, cardsPerPage: 9, xPos: [109, 868, 1627], yPos: [180, 1234, 2288], cardWidthPx: 744, cardHeightPx: 1039, paperWidthPx: 2480, paperHeightPx: 3508, inset: '3.5mm', thickness: '1mm', length: '10.5mm', cardWidthMm: 63, cardHeightMm: 88, paperWidthMm: 297, paperHeightMm: 210, template: 'a4-standard-borderless-v2', templateFile: null, error: null },
  { key: 'letter|tarot|default', paper: 'letter', card: 'tarot', variant: 'default', specialty: null, orientation: 'portrait', registrationOrientation: 'portrait', rows: 2, cols: 2, cardsPerPage: 4, xPos: [442, 1282], yPos: [218, 1658], cardWidthPx: 825, cardHeightPx: 1425, paperWidthPx: 2550, paperHeightPx: 3300, inset: '10mm', thickness: '1mm', length: '26.16mm', cardWidthMm: 69.85, cardHeightMm: 120.65, paperWidthMm: 279.4, paperHeightMm: 215.9, template: 'letter-tarot-v3', templateFile: null, error: null },
  { key: 'a4|japanese|default', paper: 'a4', card: 'japanese', variant: 'default', specialty: null, orientation: 'portrait', registrationOrientation: 'portrait', rows: 3, cols: 3, cardsPerPage: 9, xPos: [180, 892, 1604], yPos: [215, 1246, 2277], cardWidthPx: 697, cardHeightPx: 1016, paperWidthPx: 2480, paperHeightPx: 3508, inset: '10mm', thickness: '1mm', length: '6.94mm', cardWidthMm: 59, cardHeightMm: 86, paperWidthMm: 297, paperHeightMm: 210, template: 'a4-japanese-v4', templateFile: null, error: null },
  { key: 'specialty:a4-commander', name: 'a4-commander', paper: 'a4', card: null, variant: null, specialty: 'a4-commander', orientation: 'portrait', registrationOrientation: 'portrait', rows: 10, cols: 10, cardsPerPage: 100, xPos: [122, 347, 572, 797, 1022, 1247, 1472, 1697, 1922, 2147], yPos: [216, 525, 834, 1143, 1452, 1761, 2070, 2379, 2688, 2997], cardWidthPx: 210, cardHeightPx: 294, paperWidthPx: 2480, paperHeightPx: 3508, inset: '10mm', thickness: '1mm', length: '7.03mm', cardWidthMm: 17.82, cardHeightMm: 24.89, paperWidthMm: 297, paperHeightMm: 210, template: 'a4-commander-v1', templateFile: null, error: null },
];

/**
 * Find a layout by key in introspection data, falling back to the samples.
 * @param {any} introspection
 * @param {string} key
 */
function layoutFor(introspection, key) {
  const layouts = introspection?.layouts;
  const all = [...(layouts?.combos || []), ...(layouts?.specialty || [])];
  return all.find((l) => l && l.key === key) || SAMPLE_LAYOUTS.find((l) => l.key === key) || null;
}

/**
 * Draw a fake card image (data URL) for demos.
 * @param {number} w
 * @param {number} h
 * @param {{ hue?: number, title?: string, pixelate?: number }} [opts]
 * @returns {string}
 */
function demoCard(w, h, { hue = 250, title = 'Demo card', pixelate = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d');
  const r = Math.round(w * 0.05);
  const bg = g.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${hue} 70% 32%)`);
  bg.addColorStop(1, `hsl(${(hue + 60) % 360} 65% 22%)`);
  g.fillStyle = '#111';
  g.fillRect(0, 0, w, h);
  g.fillStyle = bg;
  g.beginPath();
  g.roundRect(w * 0.04, h * 0.03, w * 0.92, h * 0.94, r);
  g.fill();
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.font = `600 ${Math.round(w * 0.075)}px "Segoe UI", sans-serif`;
  g.fillText(title, w * 0.1, h * 0.11);
  const art = g.createRadialGradient(w * 0.5, h * 0.36, w * 0.05, w * 0.5, h * 0.36, w * 0.5);
  art.addColorStop(0, `hsl(${(hue + 140) % 360} 90% 70%)`);
  art.addColorStop(1, `hsl(${hue} 60% 18%)`);
  g.fillStyle = art;
  g.fillRect(w * 0.1, h * 0.15, w * 0.8, h * 0.42);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = Math.max(1, w * 0.006);
  for (let i = 0; i < 9; i += 1) {
    g.beginPath();
    g.arc(w * 0.5, h * 0.36, w * (0.04 + i * 0.035), 0, Math.PI * 2);
    g.stroke();
  }
  g.fillStyle = 'rgba(255,255,255,0.75)';
  for (let i = 0; i < 5; i += 1) g.fillRect(w * 0.1, h * (0.63 + i * 0.055), w * (i === 4 ? 0.45 : 0.8), h * 0.02);
  if (!pixelate) return c.toDataURL('image/png');
  const small = document.createElement('canvas');
  small.width = Math.max(1, Math.round(w / pixelate));
  small.height = Math.max(1, Math.round(h / pixelate));
  small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const og = out.getContext('2d');
  og.imageSmoothingEnabled = false;
  og.drawImage(small, 0, 0, w, h);
  return out.toDataURL('image/png');
}

/**
 * Activity bar demo bound to its own store.
 * @param {string} label
 * @param {object|null} job
 * @param {object[]} jobs
 * @param {object} ctx
 */
function activityDemo(label, job, jobs, ctx) {
  const store = createStore({ job, jobs, appInfo: { paths: { logs: 'C:\\Logs' } } });
  const fakeApi = {
    jobs: {
      cancel: async () => {
        await new Promise((r) => setTimeout(r, 600));
        store.update('job', (j) => ({ ...j, status: 'cancelled', endedAt: Date.now(), durationMs: 83_000 }));
        return true;
      },
      log: async () => (job?.logLines || []).map((l) => l.line).join('\n') || 'Demo log line 1\nDemo log line 2',
    },
    shell: { openPath: async () => true, showItemInFolder: async () => true },
  };
  const host = h('div.activity.kitchen-activity');
  const unmount = mountActivityBar(host, { store, api: fakeApi, format, navigate: ctx.navigate });
  ctx.onCleanup?.(unmount);
  return h('div.stack', { style: { '--gap': '6px' } }, h('div.kitchen-label', label), host);
}

/**
 * @param {string} id
 * @param {string} title
 * @param {string} description
 * @param  {...unknown} children
 */
function kSection(id, title, description, ...children) {
  const s = ui.section({ title, description, children });
  s.id = id;
  return s;
}

export default {
  id: 'kitchen',
  title: 'UI kitchen',
  icon: 'grid',

  /**
   * @param {HTMLElement} container
   * @param {any} ctx
   */
  mount(container, ctx) {
    const intro = ctx.store?.get('introspection') || null;
    const sections = [
      ['k-colors', 'Colors & type'], ['k-buttons', 'Buttons'], ['k-forms', 'Form controls'], ['k-choice', 'Choices'],
      ['k-display', 'Display'], ['k-feedback', 'Feedback'], ['k-overlays', 'Overlays'], ['k-activity', 'Activity bar'],
      ['k-preview', 'Sheet preview'], ['k-media', 'Media'], ['k-errors', 'Error panel'], ['k-icons', 'Icons'],
    ];
    const jump = ui.row({ gap: 6 }, sections.map(([id, label]) => ui.button({
      label, size: 'sm', variant: 'secondary',
      onClick: () => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    })));

    /* ---------------- Colors & type ---------------- */
    const tokens = ['--bg', '--layer', '--surface', '--surface-2', '--border', '--text', '--muted', '--accent', '--teal', '--success', '--warning', '--danger', '--info'];
    const colors = kSection('k-colors', 'Colors & type', 'Theme tokens (switch the theme from the sidebar to compare).',
      h('div.kitchen-swatches', tokens.map((t) => h('div.kitchen-swatch', h('div.kitchen-swatch-chip', { style: { background: `var(${t})` } }), h('code', t)))),
      ui.card({
        children: h('div.stack.kitchen-type', { style: { '--gap': '8px' } },
          h('div.k-h1', 'Page title — 26 / 32 semibold'),
          h('div.k-h2', 'Section title — 17 / 22 semibold'),
          h('p', 'Body text — 14 / 20. Make print-and-cut proxy sheets for your Silhouette cutter.'),
          h('p.muted.small', 'Muted small text — 13 / 18 for hints and secondary information.'),
          h('p.mono.small', 'Monospace — python create_pdf.py --paper_size a4 --ppi 1440'),
        ),
      }));

    /* ---------------- Buttons ---------------- */
    const variants = ['primary', 'secondary', 'ghost', 'danger', 'link'];
    const buttons = kSection('k-buttons', 'Buttons', 'Variants, sizes, icons, loading and disabled states. Async handlers show a spinner automatically.',
      ...['sm', 'md', 'lg'].map((size) => ui.row({ gap: 8 }, h('span.kitchen-label', { style: { width: '32px' } }, size),
        variants.map((v) => ui.button({ label: v[0].toUpperCase() + v.slice(1), variant: v, size, icon: v === 'primary' ? 'file-pdf' : undefined })))),
      ui.row({ gap: 8 },
        ui.button({ label: 'Download cards', icon: 'download', variant: 'primary', size: 'lg' }),
        ui.button({ label: 'Make PDF', iconRight: 'arrow-right', variant: 'primary' }),
        ui.button({ label: 'Async (2 s)', icon: 'refresh', onClick: () => new Promise((r) => setTimeout(r, 2000)) }),
        ui.button({ label: 'Failing async', icon: 'alert-triangle', onClick: async () => { throw new Error('BUSY: wait until "Make PDF" finishes'); } }),
        ui.button({ label: 'Loading', variant: 'primary', loading: true }),
        ui.button({ label: 'Disabled', disabled: true }),
        ui.button({ icon: 'trash', title: 'Remove', variant: 'ghost' }),
        ui.button({ icon: 'copy', title: 'Copy', variant: 'secondary' }),
        ui.button({ icon: 'x', title: 'Close', variant: 'ghost', size: 'sm' })));

    /* ---------------- Form controls ---------------- */
    const paperOptions = [
      { value: 'letter', label: 'Letter', description: '8.5 × 11 in (215.9 × 279.4 mm)' },
      { value: 'legal', label: 'Legal', description: '8.5 × 14 in — needs a 12 × 24 in mat' },
      { value: 'a4', label: 'A4', description: '210 × 297 mm' },
      { group: 'Large printers', options: [{ value: 'a3', label: 'A3', description: '297 × 420 mm' }, { value: 'tabloid', label: 'Tabloid', description: '11 × 17 in' }, { value: 'arch_b', label: 'Arch B', disabled: true, description: '12 × 18 in' }] },
    ];
    const lengthOut = h('code', 'extend_corners = "2mm"');
    const cropOut = h('code', 'crop = null');
    const ppiOut = h('code', 'ppi = 1440');
    const formField = ui.field({ label: 'Deck name', hint: 'Used for the deck list file and the PDF name.', control: ui.textInput({ value: 'my-deck', placeholder: 'my-deck' }) });
    const errorField = ui.field({ label: 'Deck link', error: 'This does not look like a Moxfield deck link.', control: ui.textInput({ value: 'https://example.com/deck', type: 'url' }) });
    const forms = kSection('k-forms', 'Form controls', 'Labels, hints, help tips and errors are wired with for / aria-describedby automatically.',
      ui.grid({ min: 260, gap: 20 },
        formField,
        errorField,
        ui.field({ label: 'Search games', control: ui.textInput({ icon: 'search', placeholder: 'Search 22 games…', type: 'search' }) }),
        ui.field({ label: 'Paper', help: 'Pick the paper you will print on. Bigger paper fits more cards but needs a bigger cutting mat.', control: ui.select({ options: paperOptions, value: 'a4' }) }),
        ui.field({ label: 'Print resolution (custom)', hint: h('span', 'Value: ', ppiOut), control: ui.numberInput({ value: 1440, min: 1, max: 2400, integer: true, suffix: 'PPI', onChange: (v) => { ppiOut.textContent = `ppi = ${v}`; } }) }),
        ui.field({ label: 'Copies', control: ui.numberInput({ value: 1, min: 1, max: 99, integer: true, stepper: true, width: 140 }) }),
        ui.field({ label: 'Fill rounded corners', hint: h('span', 'Emits: ', lengthOut), control: ui.lengthInput({ value: '2mm', units: ['mm', 'in', 'px'], onChange: (v) => { lengthOut.textContent = `extend_corners = ${JSON.stringify(v)}`; } }) }),
        ui.field({ label: 'Trim image edges', hint: h('span', 'Bare number = percent. Emits: ', cropOut), control: ui.lengthInput({ value: null, units: ['mm', 'in', '%'], onChange: (v) => { cropOut.textContent = `crop = ${JSON.stringify(v)}`; } }) }),
        ui.field({ label: 'Unknown value', hint: 'Select with a value that is not in the list shows a placeholder.', control: ui.select({ options: paperOptions, value: 'ansi_c', placeholder: 'Choose a paper…' }) })),
      ui.field({ label: 'Deck list', hint: 'Paste your list, one card per line.', control: ui.textArea({ rows: 5, value: '4 Lightning Bolt\n4 Counterspell\n1 Black Lotus\n20 Mountain' }) }),
      ui.grid({ min: 280, gap: 20 },
        ui.field({ label: 'Leave slots empty (free chips)', control: ui.chipsInput({ values: ['1', '5'], suggestions: ['1', '2', '3', '4', '5', '6', '7', '8'], validate: (v) => /^\d+$/.test(v) }) }),
        ui.field({ label: 'Upscale these images', control: ui.multiSelectChips({ options: [{ value: 'front', label: 'Fronts' }, { value: 'back', label: 'Common back' }, { value: 'double_sided', label: 'Unique backs' }], values: ['front', 'double_sided'] }) })),
      ui.card({
        title: 'Inline fields',
        children: [
          ui.field({ inline: true, label: 'Open the PDF when it is ready', hint: 'Skipped for files bigger than 300 MB.', control: ui.toggle({ checked: true, ariaLabel: 'Open the PDF when it is ready' }) }),
          ui.divider(),
          ui.field({ inline: true, label: 'JPEG quality', control: ui.numberInput({ value: 100, min: 0, max: 100, integer: true, suffix: '%', width: 120 }) }),
        ],
      }));

    /* ---------------- Choices ---------------- */
    const segOut = h('span.muted.small', 'Fronts only');
    const choice = kSection('k-choice', 'Choices', 'Toggles, checkboxes, segmented controls and radio cards (arrow keys move the selection).',
      ui.grid({ min: 280, gap: 20 },
        ui.stack({ gap: 14 },
          ui.toggle({ checked: true, label: 'Upscale for sharper prints', description: 'Make PDF upscales automatically while this is on.' }),
          ui.toggle({ checked: false, label: 'Show cut lines', description: 'Warning: the lines are printed.' }),
          ui.toggle({ checked: true, disabled: true, label: 'Disabled switch' }),
          ui.checkbox({ checked: true, label: 'Start fresh', description: 'Move the 62 cards currently loaded to Recently removed first.' }),
          ui.checkbox({ checked: false, label: 'I have my own cutting template' }),
          ui.checkbox({ checked: false, disabled: true, label: 'Disabled checkbox' })),
        ui.stack({ gap: 14 },
          ui.field({ label: 'Sides', control: ui.segmented({ value: 'fronts', options: [{ value: 'fronts', label: 'Fronts only' }, { value: 'both', label: 'Fronts and backs' }], onChange: (v) => { segOut.textContent = v === 'fronts' ? 'Fronts only' : 'Fronts and backs'; } }) }),
          segOut,
          ui.field({ label: 'Image shape', control: ui.segmented({ size: 'sm', value: 'stretch', options: [{ value: 'stretch', label: 'Stretch', icon: 'maximize' }, { value: 'crop', label: 'Crop', icon: 'scissors' }] }) }),
          ui.field({ label: 'Theme', control: ui.segmented({ block: true, value: 'system', options: [{ value: 'system', label: 'System', icon: 'monitor' }, { value: 'light', label: 'Light', icon: 'sun' }, { value: 'dark', label: 'Dark', icon: 'moon' }] }) }))),
      ui.field({
        label: 'Cutting machine',
        control: ui.radioCards({
          value: 'cameo4',
          columns: 3,
          options: [
            { value: 'cameo5alpha', label: 'Cameo 5 Alpha', description: 'Four corner marks.', icon: 'scissors', badge: { text: 'New', variant: 'accent' } },
            { value: 'cameo5', label: 'Cameo 5', description: '3-corner marks.', icon: 'scissors' },
            { value: 'cameo4', label: 'Cameo 4', description: '3-corner marks.', icon: 'scissors' },
            { value: 'portrait', label: 'Portrait', description: 'Letter or A4 only.', icon: 'scissors', badge: 'Small' },
            { value: 'other', label: 'Other / not sure', description: 'Uses the 3-corner marks that every Silhouette can read.', icon: 'help' },
            { value: 'disabled', label: 'Unavailable', description: 'Disabled option.', icon: 'ban', disabled: true },
          ],
        }),
      }),
      ui.field({
        label: 'Print resolution',
        control: ui.radioCards({
          value: 1440,
          compact: true,
          options: [
            { value: 300, label: 'Standard · 300', description: '≈ 40 MB · 1 GB memory' },
            { value: 600, label: 'High · 600', description: '≈ 160 MB · 2 GB memory' },
            { value: 1200, label: 'Very high · 1200', description: '≈ 640 MB · 5 GB memory' },
            { value: 1440, label: 'Maximum · 1440', description: '≈ 920 MB · 7 GB memory', badge: { text: 'Your usual', variant: 'success' } },
          ],
        }),
      }));

    /* ---------------- Display ---------------- */
    const tabPanel = h('p.muted', 'Showing: Fronts (62)');
    const display = kSection('k-display', 'Display', 'Cards, sections, tabs, stats, key/value lists and status rows.',
      ui.tabs({
        ariaLabel: 'Card kinds',
        tabs: [{ id: 'front', label: 'Fronts', badge: 62 }, { id: 'back', label: 'Common back', badge: 1 }, { id: 'ds', label: 'Unique backs', badge: 4 }, { id: 'off', label: 'Disabled', disabled: true }],
        active: 'front',
        onChange: (id) => { tabPanel.textContent = `Showing: ${id}`; },
      }),
      tabPanel,
      ui.grid({ min: 150, gap: 12 },
        ui.stat({ label: 'Cards', value: '62', hint: 'fronts', icon: 'layers' }),
        ui.stat({ label: 'Per sheet', value: '8', hint: 'A4 · standard' }),
        ui.stat({ label: 'Sheets', value: '8', hint: '6 empty slots', variant: 'accent' }),
        ui.stat({ label: 'Memory', value: format.formatBytes(7.4e9), hint: '24% of your memory', variant: 'warning' })),
      ui.grid({ min: 300, gap: 16 },
        ui.card({
          title: 'Card maker components',
          subtitle: 'Python 3.12.7 · all packages installed',
          icon: 'package',
          actions: [ui.button({ label: 'Repair', size: 'sm', icon: 'refresh' })],
          children: [
            ui.statusRow({ status: 'ok', title: 'Card maker data folder', message: 'D:\\Development\\Proxies\\card-maker' }),
            ui.statusRow({ status: 'running', title: 'Installing components', message: 'One-time download, a few minutes.' }),
            ui.statusRow({ status: 'warning', title: 'Upscayl', message: 'Not installed (optional)', actions: [{ label: 'Download', icon: 'external-link' }, { label: 'Locate…' }] }),
            ui.statusRow({ status: 'error', title: 'Silhouette Studio', message: 'Not found on this computer.' }),
            ui.statusRow({ status: 'pending', title: 'Your equipment', message: 'Choose your paper and cutting machine.' }),
          ],
        }),
        ui.stack({ gap: 16 },
          ui.card({ title: 'About', children: ui.kv([['Version', '1.0.0'], ['Python', '3.12.7'], ['Engine', '3.0.0'], ['Workspace', 'D:\\Development\\Proxies\\card-maker']]) }),
          ui.card({ title: 'Accent card', subtitle: 'variant: accent', variant: 'accent', children: h('p.small.muted', 'Used for highlighted results.') }),
          ui.card({ title: 'Footer card', footer: [ui.button({ label: 'Cancel', variant: 'ghost' }), ui.button({ label: 'Save', variant: 'primary' })], children: h('p.small', 'Cards can carry a footer with actions.') }))),
      ui.section({
        title: 'More options',
        description: 'Collapsible section (accordion pattern).',
        icon: 'sliders',
        collapsible: true,
        collapsed: false,
        children: h('p.muted', 'Fill rounded corners, Trim thin edge lines, Trim image edges, Extra outer bleed…'),
      }),
      ui.section({ title: 'Collapsed section', collapsible: true, collapsed: true, children: h('p', 'Hidden content') }),
      ui.row({ gap: 8 }, h('span', 'Help tip:'), ui.helpTip('Registration marks are the corner marks your machine scans before cutting.\nKeep them clean and visible.'), ui.kbd('Ctrl'), ui.kbd('C')));

    /* ---------------- Feedback ---------------- */
    const pb = ui.progressBar({ percent: 12, label: 'Card 7 of 60: Lightning Bolt' });
    let pct = 12;
    const timer = setInterval(() => {
      pct = pct >= 100 ? 0 : pct + 7;
      pb.update(pct, `Card ${Math.max(1, Math.round(pct * 0.6))} of 60: Lightning Bolt`);
    }, 700);
    ctx.onCleanup?.(() => clearInterval(timer));
    const feedback = kSection('k-feedback', 'Feedback', 'Badges, progress, spinners, callouts and empty states.',
      ui.row({ gap: 8 }, ['neutral', 'success', 'warning', 'danger', 'info', 'accent'].map((v) => ui.badge(v, v)), ui.badge('Upscaled', 'accent', { icon: 'sparkles' }), ui.badge('×4', 'neutral')),
      ui.grid({ min: 260, gap: 20 },
        pb,
        ui.progressBar({ percent: null, label: 'Saving part 1 of 2…' }),
        ui.row({ gap: 14 }, ui.spinner(14), ui.spinner(18), ui.spinner(24), ui.spinner(32, { label: 'Loading' }))),
      ui.skeleton({ lines: 3 }),
      ui.callout({ variant: 'info', title: 'Your cards come from Yu-Gi-Oh!', message: 'Use Japanese size (59 × 86 mm)?', actions: [{ label: 'Apply', variant: 'primary' }, { label: 'Not now' }] }),
      ui.callout({ variant: 'success', title: '58 of 60 cards downloaded', message: '2 cards could not be found.' }),
      ui.callout({ variant: 'warning', title: 'Two images share the name “Island”', message: 'Island.png and Island.jpg — only one would be printed.', actions: [{ label: 'Fix names automatically', icon: 'wand' }] }),
      ui.callout({ variant: 'danger', title: 'Your computer would run out of memory', message: 'Lower the print resolution to 600 PPI or make the PDF in smaller parts.' }),
      ui.callout({ variant: 'accent', message: 'Tip: make your first sheet on plain card stock to find your cutting settings.', onDismiss: () => {} }),
      ui.callout({ variant: 'neutral', compact: true, message: 'Compact neutral callout.' }),
      ui.emptyState({ icon: 'images', title: 'No cards yet', message: 'Download a deck from a card website or try the sample cards to see how it works.', actions: [{ label: 'Get cards', icon: 'download' }, { label: 'Try sample cards', icon: 'layers' }] }));

    /* ---------------- Overlays ---------------- */
    const overlays = kSection('k-overlays', 'Overlays', 'Toasts (aria-live), confirmation dialogs, modals (focus trap + Esc) and menus.',
      ui.row({ gap: 8 },
        ...['info', 'success', 'warning', 'danger'].map((v) => ui.button({ label: `Toast: ${v}`, size: 'sm', onClick: () => ui.toast({ variant: v, title: `${v[0].toUpperCase()}${v.slice(1)} toast`, message: 'This message disappears after a few seconds.' }) })),
        ui.button({ label: 'Toast with Undo', size: 'sm', icon: 'undo', onClick: () => ui.toast({ variant: 'success', title: 'Moved 3 cards to Recently removed', actions: [{ label: 'Undo', onClick: () => ui.toast({ variant: 'info', title: 'Restored' }) }] }) })),
      ui.row({ gap: 8 },
        ui.button({ label: 'Confirm dialog', onClick: async () => { const ok = await ui.confirmDialog({ title: 'Replace the current cards?', message: 'The 62 cards currently loaded move to Recently removed. You can restore them for 14 days.', confirmLabel: 'Replace' }); ui.toast({ title: ok ? 'Confirmed' : 'Cancelled' }); } }),
        ui.button({ label: 'Danger confirm', variant: 'danger', onClick: async () => { await ui.confirmDialog({ title: 'Empty Recently removed?', message: 'This permanently deletes 3 batches (142 images).', confirmLabel: 'Delete forever', danger: true }); } }),
        ui.button({
          label: 'Modal',
          onClick: () => ui.modal({
            title: 'Equivalent command',
            content: [h('p', 'This is what the app runs (on a prepared copy of your images):'), h('pre.mono.small', { style: { whiteSpace: 'pre-wrap', margin: 0, padding: '12px', background: 'var(--input-bg)', border: '1px solid var(--border)', borderRadius: '8px' } }, 'python create_pdf.py --paper_size=a4 --ppi=1440 --only_fronts --registration=4 --extend_corners=2mm --extend_edges=0.5mm'), ui.field({ label: 'Focus trap test', control: ui.textInput({ value: 'Tab cycles inside the dialog' }) })],
            actions: [{ label: 'Close' }, { label: 'Copy', variant: 'primary', icon: 'copy', onClick: async () => { await ui.copyText('python create_pdf.py'); ui.toast({ variant: 'success', title: 'Copied' }); return false; } }],
          }),
        }),
        ui.button({ label: 'Wide modal', onClick: () => ui.modal({ title: 'Wide modal', wide: true, content: h('div.thumb-grid', Array.from({ length: 6 }, (_, i) => ui.imageTile({ src: demoCard(252, 352, { hue: i * 50, title: `Card ${i + 1}` }), title: `card-${i + 1}.png` }))), actions: [{ label: 'Done', variant: 'primary' }] }) }),
        (() => {
          const b = ui.button({ label: 'Menu', iconRight: 'chevron-down', attrs: { 'aria-haspopup': 'menu' } });
          b.addEventListener('click', () => ui.popoverMenu({ anchor: b, items: [{ heading: 'Card' }, { label: 'View', icon: 'eye' }, { label: 'Add a copy', icon: 'plus' }, { label: 'Remove a copy', icon: 'minus' }, { divider: true }, { label: 'Open the website', icon: 'globe', external: true }, { label: 'Disabled item', icon: 'ban', disabled: true }] }));
          return b;
        })()));

    /* ---------------- Activity bar ---------------- */
    const now = Date.now();
    const logLines = [
      { stream: 'stdout', line: 'Index: 1, quantity: 4, set code: M10, collector number: 146, name: Lightning Bolt' },
      { stream: 'stdout', line: 'Index: 2, quantity: 4, set code: CMR, collector number: 395, name: Counterspell' },
      { stream: 'stderr', line: 'Downloading https://cards.scryfall.io/png/front/…' },
      { stream: 'warn', line: 'Card "Black Lotus" has several printings; using the newest.' },
      { stream: 'stdout', line: 'Error: 404 Client Error: Not Found for url: https://api.scryfall.com/cards/xyz/123' },
      { stream: 'stdout', line: 'Image 29: game/.stage/1/c1/front/Lightning Bolt.png' },
    ];
    const steps = [
      { id: 'prepare', label: 'Preparing images', status: 'done' },
      { id: 'upscale', label: 'Upscaling', status: 'done' },
      { id: 'render', label: 'Rendering part 1 of 2', status: 'running' },
      { id: 'merge', label: 'Joining parts', status: 'pending' },
      { id: 'finish', label: 'Finishing', status: 'pending' },
    ];
    const history = [
      { jobId: '7', kind: 'pdf', title: 'Make PDF', status: 'succeeded', startedAt: now - 3_600_000, durationMs: 245_000 },
      { jobId: '6', kind: 'fetch', title: 'Download Magic cards', status: 'failed', startedAt: now - 90_000_000, durationMs: 12_000 },
      { jobId: '5', kind: 'upscale', title: 'Upscale images', status: 'cancelled', startedAt: now - 200_000_000, durationMs: 61_000 },
    ];
    const baseJob = { jobId: '8', kind: 'pdf', title: 'Make PDF', steps, logLines, logTotal: logLines.length, result: null, error: null, warnings: [], startedAt: now - 83_000, endedAt: null, durationMs: null, dismissed: false };
    const activity = kSection('k-activity', 'Activity bar', 'Each demo has its own store; open Details to see the log and history.',
      activityDemo('Idle', null, history, ctx),
      activityDemo('Running', { ...baseJob, status: 'running', progress: { percent: 46.5, current: 29, total: 62, label: 'Card 29 of 62' } }, history, ctx),
      activityDemo('Running (indeterminate)', { ...baseJob, jobId: '9', status: 'running', progress: { percent: null, label: 'Saving part 1 of 2…' } }, history, ctx),
      activityDemo('Succeeded with warnings', { ...baseJob, status: 'succeeded', result: { pdfPath: 'C:\\Users\\me\\Documents\\Kirigami\\my-deck.pdf' }, warnings: ['Offset cannot be applied to fronts only.', 'Ignoring skip indices that are outside range 0-7: [9]'], endedAt: now, durationMs: 125_000 }, history, ctx),
      activityDemo('Failed', { ...baseJob, kind: 'fetch', title: 'Download Magic cards', status: 'failed', error: { message: "Couldn't reach api.scryfall.com. Check your internet connection (antivirus HTTPS scanning can also block it).", details: 'Traceback (most recent call last):\n  File "plugins/mtg/fetch.py", line 40\nrequests.exceptions.ConnectionError: HTTPSConnectionPool…', code: 'NETWORK' }, endedAt: now, durationMs: 12_000 }, history, ctx),
      activityDemo('Cancelled', { ...baseJob, kind: 'upscale', title: 'Upscale images', status: 'cancelled', endedAt: now, durationMs: 61_000 }, history, ctx));

    /* ---------------- Sheet preview ---------------- */
    const letterStd = layoutFor(intro, 'letter|standard|default');
    const a4Borderless = layoutFor(intro, 'a4|standard|borderless');
    const tarot = layoutFor(intro, 'letter|tarot|default');
    const japanese = layoutFor(intro, 'a4|japanese|default');
    const commander = layoutFor(intro, 'specialty:a4-commander');
    let skipA = [];
    const skipOut = h('code', 'skip = []');
    const previewA = pagePreview({
      layout: letterStd,
      registration: '3',
      skip: skipA,
      cardsOnLastSheet: 5,
      onToggleSkip: (i) => {
        skipA = skipA.includes(i) ? skipA.filter((x) => x !== i) : [...skipA, i].sort((a, b) => a - b);
        skipOut.textContent = `skip = [${skipA.join(', ')}]`;
        previewA.update({ skip: skipA });
      },
      caption: 'Letter · standard · 3-corner marks (click slots)',
    });
    const preview = kSection('k-preview', 'Sheet preview', 'Slots and marks exactly as create_pdf places them; portrait layouts are turned to match the landscape PDF.',
      ui.grid({ min: 320, gap: 24 },
        ui.stack({ gap: 8 }, previewA, h('div.small.muted', skipOut)),
        pagePreview({ layout: a4Borderless, registration: '3', skip: [6], onToggleSkip: () => {}, caption: 'A4 · standard · tight layout (portrait, turned)' }),
        pagePreview({ layout: tarot, registration: '4', caption: 'Letter · tarot · 4-corner marks (portrait, turned)' }),
        pagePreview({ layout: japanese, registration: '3', cardsOnLastSheet: 4, caption: 'A4 · Japanese · last sheet has 4 cards' }),
        pagePreview({ layout: commander, registration: '3', onToggleSkip: () => {}, caption: 'Specialty · A4 commander (100 per sheet)' }),
        pagePreview({ layout: { ...letterStd, registrationOrientation: 'portrait' }, registration: '3', caption: 'Letter · standard · marks turned (registration orientation portrait)' }),
        pagePreview({ layout: null, caption: 'Missing layout' })));

    /* ---------------- Media ---------------- */
    const before = demoCard(300, 420, { hue: 265, title: 'Lightning Bolt', pixelate: 5 });
    const after = demoCard(1200, 1680, { hue: 265, title: 'Lightning Bolt' });
    const tiles = [
      ui.imageTile({ src: demoCard(252, 352, { hue: 10, title: 'Bolt' }), title: 'Lightning Bolt.png', subtitle: '745 × 1040', badges: [ui.badge('Upscaled', 'accent', { icon: 'sparkles' })], count: 4, onOpen: () => {}, actions: [{ icon: 'eye', title: 'View' }, { icon: 'plus', title: 'Add a copy' }, { icon: 'minus', title: 'Remove a copy' }, { icon: 'trash', title: 'Remove' }] }),
      ui.imageTile({ src: demoCard(252, 352, { hue: 200, title: 'Island' }), title: 'Island.png', badges: [ui.badge('May print blurry', 'warning', { icon: 'alert-triangle' })], onOpen: () => {} }),
      ui.imageTile({ src: demoCard(252, 352, { hue: 120, title: 'Forest' }), title: 'Forest.jpg', badges: [ui.badge('Will be stretched', 'info')], selected: true }),
      ui.imageTile({ src: 'scm-img://file/missing?v=1', title: 'broken-file.webp', fallbackText: 'WEBP' }),
      ui.imageTile({ src: demoCard(252, 352, { hue: 320, title: 'Swamp with a very long name' }), title: 'Swamp with a very long name that truncates.png', count: 2 }),
    ];
    const media = kSection('k-media', 'Media', 'Image tiles (lazy, fallback on error), compare slider and the next-step footer.',
      h('div.thumb-grid', { style: { '--thumb-size': '150px' } }, tiles),
      ui.card({ title: 'Compare slider', subtitle: 'Drag, or focus the handle and use the arrow keys.', children: compareSlider({ before, after, beforeCaption: '300 × 420 px', afterCaption: '1200 × 1680 px · 4×', alt: 'Lightning Bolt' }) }),
      nextStep({ text: '62 cards ready', detail: '8 sheets of A4 · fronts only', actionLabel: 'Make PDF', onAction: () => ctx.navigate('pdf') }),
      nextStep({ text: 'Your PDF is ready', tone: 'neutral', icon: 'printer', actionLabel: 'Print & cut', onAction: () => ctx.navigate('print'), secondary: { label: 'Open PDF', icon: 'file-pdf', onClick: () => {} } }));

    /* ---------------- Error panel ---------------- */
    const errHost = h('div');
    renderRouteError(errHost, { title: 'Make PDF', error: new TypeError('Failed to fetch dynamically imported module: file:///…/views/pdf.js'), onRetry: () => ui.toast({ title: 'Retry clicked' }) });
    const errors = kSection('k-errors', 'Error panel', 'Shown by the router when a view is missing or throws while opening.', errHost);

    /* ---------------- Icons ---------------- */
    const icons = kSection('k-icons', 'Icons', 'Inline SVG set adapted from Lucide (ISC).',
      h('div.kitchen-icons', iconNames().map((n) => h('div.kitchen-icon', icon(n, { size: 20 }), h('span', n)))));

    container.append(
      ui.pageHeader({ title: 'UI kitchen', subtitle: 'Every shared component in one place, for visual checks in both themes.', icon: 'grid', step: 'Developer tools' }),
      jump,
      colors, buttons, forms, choice, display, feedback, overlays, activity, preview, media, errors, icons,
    );
    return () => clearInterval(timer);
  },
};
