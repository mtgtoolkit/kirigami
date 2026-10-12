/**
 * UI kit (spec §8.3). Every view builds its DOM with these helpers so the app looks and behaves
 * consistently (styling lives in css/app.css). All components are plain DOM elements; components
 * with state expose small imperative methods on the returned element (`setValue`, `setLoading`…).
 *
 * Importing this module does not touch the DOM (pure helpers such as `parseLengthValue` are
 * unit-testable in Node); the component functions need `document`.
 *
 * Spec exports: h, icon, button, field, select, toggle, checkbox, radioCards, segmented, textInput,
 * numberInput, lengthInput, textArea, chipsInput, multiSelectChips, section, card, badge, tabs,
 * progressBar, emptyState, callout, helpTip, toast, confirmDialog, modal, spinner, clear, mountInto,
 * copyText.
 * Extra helpers: uid, pageHeader, stack, row, grid, twoColumn, stat, kv, statusRow, imageTile,
 * divider, kbd, skeleton, attachTooltip, popoverMenu, showError, parseLengthValue, formatLengthValue.
 *
 * @module core/ui
 */

import { createIcon } from './icons.js';
import { errorMessage } from './format.js';

/* ------------------------------------------------------------------------------------------------
 * Core DOM helpers
 * ---------------------------------------------------------------------------------------------- */

let idCounter = 0;

/**
 * Unique id for aria wiring (`ui-1`, `field-2`…).
 * @param {string} [prefix]
 * @returns {string}
 */
export function uid(prefix = 'ui') {
  idCounter += 1;
  return `${prefix}-${idCounter}`;
}

const UNITLESS = new Set([
  'opacity', 'zIndex', 'z-index', 'flex', 'flexGrow', 'flex-grow', 'flexShrink', 'flex-shrink', 'order',
  'fontWeight', 'font-weight', 'lineHeight', 'line-height', 'zoom', 'gridRow', 'grid-row', 'gridColumn',
  'grid-column', 'aspectRatio', 'aspect-ratio', 'scale', 'columns', 'tabSize',
]);

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function classNames(value) {
  if (!value) return [];
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) return value.flatMap(classNames);
  if (typeof value === 'object') return Object.entries(value).filter(([, on]) => on).map(([c]) => c);
  return [];
}

/**
 * @param {HTMLElement} el
 * @param {string|Record<string, unknown>} style
 */
function applyStyle(el, style) {
  if (style === null || style === undefined || style === false) return;
  if (typeof style === 'string') {
    el.style.cssText = el.style.cssText ? `${el.style.cssText};${style}` : style;
    return;
  }
  for (const [key, raw] of Object.entries(style)) {
    if (raw === null || raw === undefined || raw === false) continue;
    const value = typeof raw === 'number' && !UNITLESS.has(key) && !key.startsWith('--') ? `${raw}px` : String(raw);
    if (key.startsWith('--') || key.includes('-')) el.style.setProperty(key, value);
    else el.style[key] = value;
  }
}

/**
 * @param {Element} el
 * @param {string} name
 * @param {unknown} value null/false removes, true sets an empty attribute.
 */
function setAttr(el, name, value) {
  if (value === null || value === undefined || value === false) el.removeAttribute(name);
  else el.setAttribute(name, value === true ? '' : String(value));
}

/**
 * @param {unknown} v
 * @returns {boolean}
 */
function isPropsObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    && !(typeof Node !== 'undefined' && v instanceof Node);
}

/**
 * @param {Element} el
 * @param {unknown[]} children
 */
function appendChildren(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/**
 * @param {HTMLElement} el
 * @param {string} key
 * @param {unknown} value
 */
function applyProp(el, key, value) {
  switch (key) {
    case 'class':
    case 'className': {
      const list = classNames(value);
      if (list.length) el.classList.add(...list);
      return;
    }
    case 'style': applyStyle(el, value); return;
    case 'attrs':
      for (const [k, v] of Object.entries(value || {})) setAttr(el, k, v);
      return;
    case 'dataset':
      for (const [k, v] of Object.entries(value || {})) if (v !== null && v !== undefined) el.dataset[k] = String(v);
      return;
    case 'html': el.innerHTML = value === null || value === undefined ? '' : String(value); return;
    case 'disabled':
      if ('disabled' in el) el.disabled = !!value;
      else setAttr(el, 'aria-disabled', value ? 'true' : null);
      return;
    case 'title': if (value !== null && value !== '') el.title = String(value); return;
    case 'hidden': el.hidden = !!value; return;
    case 'for':
    case 'htmlFor': setAttr(el, 'for', value); return;
    default:
      if (/^on[A-Z]/.test(key)) {
        if (typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
        return;
      }
      if (key.startsWith('aria-') || key.startsWith('data-') || key === 'role') {
        setAttr(el, key, value);
        return;
      }
      if (key in el && typeof el[key] !== 'function') {
        try {
          el[key] = value;
          return;
        } catch {
          /* fall through to attribute */
        }
      }
      setAttr(el, key, value);
  }
}

/**
 * Create an element. `tag` may carry classes (`'div.card.is-active'`).
 *
 * Props: `class` (string | array | {name: bool}), `style` (string | object; numbers get `px`),
 * `attrs` (attributes; null/false removes), `dataset`, `on<Event>` listeners (`onClick`, `onKeydown`…),
 * `value`, `checked`, `disabled`, `title`, `html` (trusted static markup only), `ref(el)`, plus any
 * DOM property or attribute (`id`, `type`, `placeholder`, `aria-*`, `role`…).
 * Children: nodes, strings, numbers, nested arrays; null/undefined/booleans are skipped.
 *
 * @param {string} tag
 * @param {object|Node|string|Array|null} [props]
 * @param {...unknown} children
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  let p = props;
  if (!isPropsObject(p)) {
    children.unshift(p);
    p = {};
  }
  const [name, ...cls] = String(tag || 'div').split('.');
  const el = document.createElement(name || 'div');
  const extra = cls.filter(Boolean);
  if (extra.length) el.classList.add(...extra);
  const deferred = [];
  for (const [key, value] of Object.entries(p)) {
    if (value === undefined) continue;
    if (key === 'value' || key === 'checked' || key === 'selected' || key === 'ref') deferred.push([key, value]);
    else applyProp(el, key, value);
  }
  appendChildren(el, children);
  for (const [key, value] of deferred) {
    if (key === 'ref') {
      if (typeof value === 'function') value(el);
    } else if (key === 'value') {
      el.value = value === null ? '' : value;
    } else {
      el[key] = !!value;
    }
  }
  return el;
}

/**
 * Inline SVG icon (see core/icons.js for names).
 * @param {string} name
 * @param {{ size?: number, class?: string, title?: string, strokeWidth?: number }} [options]
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 16, class: className, title, strokeWidth } = {}) {
  return createIcon(name, { size, class: className, title, strokeWidth });
}

/**
 * Remove every child of `el`.
 * @template {Element} T
 * @param {T} el
 * @returns {T}
 */
export function clear(el) {
  if (el) el.replaceChildren();
  return el;
}

/**
 * Replace the children of `container` with `children` (nodes, strings, nested arrays).
 * @template {Element} T
 * @param {T} container
 * @param {...unknown} children
 * @returns {T}
 */
export function mountInto(container, ...children) {
  if (!container) return container;
  container.replaceChildren();
  appendChildren(container, children);
  return container;
}

/**
 * Copy text with the async clipboard API (Electron 44 has no renderer `clipboard` module).
 * @param {string} text
 * @returns {Promise<boolean>} false when the clipboard is unavailable or permission was denied.
 */
export async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(String(text ?? ''));
    return true;
  } catch {
    return false;
  }
}

/**
 * Show an error as a toast (used for failures of async button handlers).
 * @param {unknown} err
 * @param {{ title?: string }} [options]
 */
export function showError(err, { title = "That didn't work" } = {}) {
  // eslint-disable-next-line no-console
  console.warn('[ui]', err);
  try {
    toast({ variant: 'danger', title, message: errorMessage(err), timeout: 8000 });
  } catch {
    /* toast root unavailable (e.g. during teardown) */
  }
}

/**
 * Normalize action specs (Nodes or `{ label, onClick, variant, icon }` objects) to buttons.
 * @param {unknown} actions
 * @param {{ size?: string, firstVariant?: string, variant?: string }} [defaults]
 * @returns {Node[]}
 */
function renderActions(actions, defaults = {}) {
  const list = (Array.isArray(actions) ? actions : [actions]).flat(Infinity).filter(Boolean);
  return list.map((a, i) => {
    if (a instanceof Node) return a;
    if (typeof a !== 'object') return document.createTextNode(String(a));
    return button({
      size: defaults.size ?? 'sm',
      variant: a.variant ?? (i === 0 && defaults.firstVariant ? defaults.firstVariant : (defaults.variant ?? 'secondary')),
      ...a,
    });
  });
}

/* ------------------------------------------------------------------------------------------------
 * Buttons & small display elements
 * ---------------------------------------------------------------------------------------------- */

/**
 * Button. When `onClick` returns a Promise the button shows a spinner and ignores clicks until it
 * settles; a rejection is shown as an error toast (so async handlers never fail silently).
 * Icon-only buttons (no label) use `title` as their accessible name.
 *
 * @param {object} [options]
 * @param {string} [options.label]
 * @param {string} [options.icon] leading icon name
 * @param {string} [options.iconRight] trailing icon name
 * @param {'secondary'|'primary'|'ghost'|'danger'|'link'} [options.variant]
 * @param {'sm'|'md'|'lg'} [options.size]
 * @param {(ev: MouseEvent) => any} [options.onClick]
 * @param {boolean} [options.disabled]
 * @param {string} [options.title]
 * @param {boolean} [options.loading]
 * @param {string} [options.type]
 * @param {string} [options.ariaLabel]
 * @param {string|string[]} [options.class]
 * @param {Record<string, unknown>} [options.attrs]
 * @param {boolean} [options.block] full width
 * @returns {HTMLButtonElement & { setLoading(v: boolean): void, setLabel(t: string): void, setDisabled(v: boolean): void }}
 */
export function button(options = {}) {
  const {
    label, icon: iconName, iconRight, variant = 'secondary', size = 'md', onClick,
    disabled = false, title, loading = false, type = 'button',
  } = options;
  const hasLabel = !(label === undefined || label === null || label === '');
  const iconOnly = !hasLabel && !!iconName;
  const el = h('button', {
    type,
    class: ['btn', `btn-${variant}`, `btn-${size}`, iconOnly && 'btn-icon', options.block && 'btn-block', options.class],
    title: title ?? undefined,
    attrs: { 'aria-label': options.ariaLabel ?? (iconOnly ? (title || iconName) : null), ...(options.attrs || {}) },
    dataset: options.dataset,
  });
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16;
  const labelEl = hasLabel ? h('span.btn-label', label) : null;
  if (iconName) el.append(h('span.btn-lead', icon(iconName, { size: iconSize })));
  if (labelEl) el.append(labelEl);
  if (iconRight) el.append(h('span.btn-trail', icon(iconRight, { size: iconSize })));
  el.disabled = !!disabled;

  let explicitLoading = !!loading;
  let autoLoading = false;
  let pending = false;
  const renderLoading = () => {
    const on = explicitLoading || autoLoading;
    el.classList.toggle('is-loading', on);
    setAttr(el, 'aria-busy', on ? 'true' : null);
    setAttr(el, 'aria-disabled', on ? 'true' : null);
    const existing = el.querySelector(':scope > .btn-spinner');
    if (on && !existing) el.append(h('span.btn-spinner', { 'aria-hidden': 'true' }, spinner(iconSize)));
    if (!on && existing) existing.remove();
  };

  el.addEventListener('click', (ev) => {
    if (el.disabled || explicitLoading || pending) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
      return;
    }
    if (typeof onClick !== 'function') return;
    let result;
    try {
      result = onClick(ev);
    } catch (err) {
      showError(err);
      return;
    }
    if (result && typeof result.then === 'function') {
      pending = true;
      const timer = setTimeout(() => {
        autoLoading = true;
        renderLoading();
      }, 120);
      Promise.resolve(result)
        .catch((err) => showError(err))
        .finally(() => {
          clearTimeout(timer);
          pending = false;
          autoLoading = false;
          renderLoading();
        });
    }
  });

  el.setLoading = (v) => {
    explicitLoading = !!v;
    renderLoading();
  };
  el.setLabel = (text) => {
    if (labelEl) labelEl.textContent = text;
  };
  el.setDisabled = (v) => {
    el.disabled = !!v;
  };
  if (explicitLoading) renderLoading();
  return el;
}

/**
 * Pill badge.
 * @param {string|number} text
 * @param {'neutral'|'success'|'warning'|'danger'|'info'|'accent'} [variant]
 * @param {{ icon?: string, title?: string, class?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function badge(text, variant = 'neutral', { icon: iconName, title, class: className } = {}) {
  return h('span', { class: ['badge', `badge-${variant}`, className], title },
    iconName && icon(iconName, { size: 12, strokeWidth: 2.5 }),
    h('span.badge-text', String(text ?? '')));
}

/**
 * Loading spinner (decorative unless `label` is given).
 * @param {number} [size]
 * @param {{ label?: string }} [options]
 * @returns {HTMLSpanElement}
 */
export function spinner(size = 16, { label } = {}) {
  return h('span', {
    class: 'spinner',
    style: { '--spinner-size': `${Number(size) || 16}px` },
    attrs: label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' },
  });
}

/**
 * Keyboard key hint.
 * @param {string} text
 * @returns {HTMLElement}
 */
export function kbd(text) {
  return h('kbd.kbd', text);
}

/**
 * Horizontal divider, optionally with a centered label.
 * @param {{ label?: string }} [options]
 * @returns {HTMLElement}
 */
export function divider({ label } = {}) {
  if (!label) return h('hr.divider');
  return h('div.divider-label', { role: 'separator' }, h('span', label));
}

/**
 * Shimmering placeholder lines for loading states.
 * @param {{ lines?: number, height?: number|string, width?: string }} [options]
 * @returns {HTMLElement}
 */
export function skeleton({ lines = 3, height, width } = {}) {
  const el = h('div.skeleton-group', { attrs: { 'aria-hidden': 'true' } });
  for (let i = 0; i < lines; i += 1) {
    el.append(h('div.skeleton', {
      style: {
        height: height ?? undefined,
        width: width ?? (i === lines - 1 && lines > 1 ? '60%' : undefined),
      },
    }));
  }
  return el;
}

/* ------------------------------------------------------------------------------------------------
 * Layout helpers
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {unknown[]} args
 * @returns {[object, unknown[]]}
 */
function splitOpts(args) {
  if (args.length && isPropsObject(args[0]) && !Array.isArray(args[0])) return [args[0], args.slice(1)];
  return [{}, args];
}

/**
 * Vertical stack with consistent spacing: `stack(child, child)` or `stack({ gap: 8 }, ...children)`.
 * @param {...unknown} args
 * @returns {HTMLElement}
 */
export function stack(...args) {
  const [opts, children] = splitOpts(args);
  return h('div', { class: ['stack', opts.class], style: opts.gap !== undefined ? { '--gap': `${opts.gap}px` } : null }, children);
}

/**
 * Horizontal row (wraps, vertically centered): `row({ gap, justify: 'between', wrap: false }, ...children)`.
 * @param {...unknown} args
 * @returns {HTMLElement}
 */
export function row(...args) {
  const [opts, children] = splitOpts(args);
  const justify = { between: 'space-between', end: 'flex-end', center: 'center', start: 'flex-start' }[opts.justify] || opts.justify;
  return h('div', {
    class: ['row', opts.wrap === false && 'row-nowrap', opts.class],
    style: {
      '--gap': opts.gap !== undefined ? `${opts.gap}px` : null,
      justifyContent: justify || null,
      alignItems: opts.align || null,
    },
  }, children);
}

/**
 * Responsive grid: `grid({ min: 220 }, ...children)` (auto-fill columns ≥ min px) or
 * `grid({ columns: 3 }, ...)`.
 * @param {...unknown} args
 * @returns {HTMLElement}
 */
export function grid(...args) {
  const [opts, children] = splitOpts(args);
  return h('div', {
    class: ['grid', opts.columns && 'grid-fixed', opts.class],
    style: {
      '--min': opts.min ? `${opts.min}px` : null,
      '--cols': opts.columns ? String(opts.columns) : null,
      '--gap': opts.gap !== undefined ? `${opts.gap}px` : null,
    },
  }, children);
}

/**
 * Main column + sticky side column (stacks below ~880 px of available width).
 * @param {{ main: unknown, aside: unknown, asideWidth?: number, class?: string }} options
 * @returns {HTMLElement}
 */
export function twoColumn({ main, aside, asideWidth = 340, class: className } = {}) {
  return h('div', { class: ['two-col', className], style: { '--aside-w': `${asideWidth}px` } },
    h('div.two-col-main', main),
    h('aside.two-col-aside', aside));
}

/**
 * Standard page header for views.
 * @param {{ title: string, subtitle?: unknown, icon?: string, step?: number|string, stepTotal?: number, actions?: unknown }} options
 * @returns {HTMLElement}
 */
export function pageHeader({ title, subtitle, icon: iconName, step, stepTotal = 5, actions } = {}) {
  let eyebrow = null;
  if (step !== undefined && step !== null) {
    eyebrow = h('div.page-eyebrow', typeof step === 'number' ? `Step ${step} of ${stepTotal}` : String(step));
  }
  return h('header.page-header',
    iconName && h('div.page-header-icon', icon(iconName, { size: 22 })),
    h('div.page-header-main', eyebrow, h('h1.page-title', title), subtitle && h('p.page-subtitle', subtitle)),
    actions && h('div.page-header-actions', renderActions(actions, { size: 'md' })));
}

/**
 * Small statistic tile ("62 cards").
 * @param {{ label: string, value: unknown, hint?: unknown, icon?: string, variant?: string }} options
 * @returns {HTMLElement}
 */
export function stat({ label, value, hint, icon: iconName, variant } = {}) {
  return h('div', { class: ['stat', variant && `stat-${variant}`] },
    h('div.stat-label', iconName && icon(iconName, { size: 14 }), label),
    h('div.stat-value', value === null || value === undefined ? '—' : value),
    hint && h('div.stat-hint', hint));
}

/**
 * Definition list of label/value rows: `kv([['Version', '1.0'], { label, value }])`.
 * @param {Array<[unknown, unknown]|{ label: unknown, value: unknown }>} rows
 * @param {{ class?: string }} [options]
 * @returns {HTMLElement}
 */
export function kv(rows = [], { class: className } = {}) {
  return h('dl', { class: ['kv', className] }, rows.filter(Boolean).map((r) => {
    const [label, value] = Array.isArray(r) ? r : [r.label, r.value];
    return h('div.kv-row', h('dt', label), h('dd', value === null || value === undefined || value === '' ? '—' : value));
  }));
}

const STATUS_ICONS = {
  ok: ['check-circle', 'success'],
  success: ['check-circle', 'success'],
  warning: ['alert-triangle', 'warning'],
  error: ['x-circle', 'danger'],
  danger: ['x-circle', 'danger'],
  info: ['info', 'info'],
  pending: ['circle', 'muted'],
  optional: ['circle-dot', 'muted'],
};

/**
 * Checklist row with a status icon (setup checklist, environment status…).
 * @param {{ status?: 'ok'|'warning'|'error'|'info'|'pending'|'running'|'optional', title: unknown, message?: unknown, actions?: unknown, detail?: unknown }} options
 * @returns {HTMLElement}
 */
export function statusRow({ status = 'pending', title, message, actions, detail } = {}) {
  const [iconName, tone] = STATUS_ICONS[status] || STATUS_ICONS.pending;
  const indicator = status === 'running'
    ? h('span.status-icon.status-running', spinner(18, { label: 'In progress' }))
    : h('span', { class: ['status-icon', `status-${tone}`] }, icon(iconName, { size: 18, title: status }));
  return h('div', { class: ['status-row', `is-${status}`] },
    indicator,
    h('div.status-body',
      h('div.status-title', title),
      message && h('div.status-message', message),
      detail && h('div.status-detail', detail)),
    actions && h('div.status-actions', renderActions(actions, { size: 'sm' })));
}

/* ------------------------------------------------------------------------------------------------
 * Form controls
 * ---------------------------------------------------------------------------------------------- */

const LABELABLE = 'input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]), select, textarea';

/**
 * @param {unknown} control
 * @returns {HTMLElement|null}
 */
function findLabelable(control) {
  if (!(control instanceof Element)) return null;
  if (control.matches(LABELABLE)) return /** @type {HTMLElement} */ (control);
  if (control.matches('label, .toggle, .check')) return null;
  return control.querySelector(LABELABLE);
}

/**
 * Labelled form row: label (+ optional help tooltip), control, hint and error text, with
 * `for`/`aria-labelledby`/`aria-describedby` wired automatically.
 *
 * @param {object} options
 * @param {unknown} [options.label]
 * @param {string} [options.help] longer explanation shown in a (?) tooltip next to the label
 * @param {unknown} [options.hint] short text below the control
 * @param {unknown} [options.error] error text (red) below the control
 * @param {Node} options.control
 * @param {boolean} [options.inline] label left, control right
 * @param {boolean} [options.required]
 * @param {string|string[]} [options.class]
 * @returns {HTMLElement & { setError(msg: unknown): void, setHint(msg: unknown): void }}
 */
export function field({ label, help, hint, error, control, inline = false, required = false, class: className } = {}) {
  const id = uid('field');
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const labelable = findLabelable(control);
  if (labelable && !labelable.id) labelable.id = `${id}-control`;
  const labelEl = label
    ? h(labelable ? 'label' : 'div', { class: 'field-label', id: labelId, for: labelable ? labelable.id : null },
      label, required && h('span.field-required', { 'aria-hidden': 'true' }, ' *'))
    : null;
  const head = (labelEl || help) ? h('div.field-head', labelEl, help && helpTip(help)) : null;
  const hintEl = h('div.field-hint', { id: hintId, hidden: !hint }, hint || '');
  const errorText = h('span');
  const errorEl = h('div.field-error', { id: errorId, hidden: !error }, icon('alert-circle', { size: 14 }), errorText);
  if (error) mountInto(errorText, error);
  const controlWrap = h('div.field-control', control);
  const el = h('div', { class: ['field', inline && 'field-inline', error && 'has-error', className] }, head, controlWrap, hintEl, errorEl);

  const group = control instanceof Element
    ? (control.matches('[role="radiogroup"], [role="group"], [role="tablist"]') ? control : control.querySelector('[role="radiogroup"], [role="group"], [role="tablist"]'))
    : null;
  const target = labelable || group || null;
  if (target && !labelable && labelEl) target.setAttribute('aria-labelledby', labelId);
  if (!target && labelEl && control instanceof Element) {
    // A bare toggle/checkbox (no own label text) gets its name from the field label.
    const inner = control.querySelector('input[type="checkbox"], input[type="radio"]');
    if (inner && !inner.getAttribute('aria-label') && !control.querySelector('.toggle-label, .check-label')) {
      inner.setAttribute('aria-labelledby', labelId);
    }
  }
  if (target && required) target.setAttribute('aria-required', 'true');
  const describe = () => {
    if (!target) return;
    const ids = [];
    if (!hintEl.hidden) ids.push(hintId);
    if (!errorEl.hidden) ids.push(errorId);
    setAttr(target, 'aria-describedby', ids.length ? ids.join(' ') : null);
    setAttr(target, 'aria-invalid', errorEl.hidden ? null : 'true');
  };
  describe();
  el.setError = (msg) => {
    const has = !(msg === null || msg === undefined || msg === '' || msg === false);
    errorEl.hidden = !has;
    if (has) mountInto(errorText, msg);
    el.classList.toggle('has-error', has);
    describe();
  };
  el.setHint = (msg) => {
    const has = !(msg === null || msg === undefined || msg === '' || msg === false);
    hintEl.hidden = !has;
    mountInto(hintEl, has ? msg : '');
    describe();
  };
  return el;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (a === null || a === undefined || b === null || b === undefined) return false;
  return String(a) === String(b);
}

/**
 * Native select with typed values, optional groups and a description line for the selected option.
 *
 * @param {object} options
 * @param {Array<{ value: any, label?: string, description?: string, disabled?: boolean }|{ group: string, options: any[] }|string|number>} options.options
 * @param {any} [options.value]
 * @param {(value: any, option: object) => void} [options.onChange]
 * @param {boolean} [options.disabled]
 * @param {string} [options.placeholder] shown when no option matches `value`
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.showDescription] show the selected option's description below (default true)
 * @param {number|string} [options.width]
 * @returns {HTMLElement & { select: HTMLSelectElement, value: any, setValue(v: any): void, setOptions(opts: any[], value?: any): void, setDisabled(v: boolean): void }}
 */
export function select({
  options = [], value, onChange, disabled = false, placeholder, ariaLabel, showDescription = true, width, class: className,
} = {}) {
  const sel = h('select', { class: 'select-native', disabled, attrs: { 'aria-label': ariaLabel } });
  const desc = h('div.select-desc', { hidden: true });
  /** @type {Array<{ value: any, label?: string, description?: string, disabled?: boolean }>} */
  let flat = [];
  let placeholderOption = null;

  const makeOption = (o) => {
    const norm = o !== null && typeof o === 'object' ? o : { value: o, label: String(o) };
    const index = flat.length;
    flat.push(norm);
    return h('option', { value: String(index), disabled: !!norm.disabled, title: norm.description || undefined },
      norm.label ?? String(norm.value));
  };
  const updateDesc = () => {
    const o = flat[Number(sel.value)];
    const text = showDescription && sel.value !== '' ? (o?.description || '') : '';
    desc.textContent = text;
    desc.hidden = !text;
  };
  const setValue = (v) => {
    const index = flat.findIndex((o) => sameValue(o.value, v));
    if (index >= 0) {
      sel.value = String(index);
      if (placeholderOption) placeholderOption.hidden = true;
    } else {
      if (!placeholderOption) {
        placeholderOption = h('option', { value: '', disabled: true }, placeholder ?? 'Choose…');
        sel.prepend(placeholderOption);
      }
      placeholderOption.hidden = false;
      sel.value = '';
    }
    updateDesc();
  };
  const build = (opts, current) => {
    sel.replaceChildren();
    flat = [];
    placeholderOption = null;
    for (const o of opts || []) {
      if (o && typeof o === 'object' && Array.isArray(o.options)) {
        const g = h('optgroup', { label: String(o.group ?? o.label ?? '') });
        for (const child of o.options) g.append(makeOption(child));
        sel.append(g);
      } else {
        sel.append(makeOption(o));
      }
    }
    setValue(current);
  };
  sel.addEventListener('change', () => {
    const o = flat[Number(sel.value)];
    updateDesc();
    if (o && typeof onChange === 'function') onChange(o.value, o);
  });
  const wrap = h('div', { class: ['select', className], style: width !== undefined ? { width } : null },
    h('div.select-box', sel, icon('chevron-down', { size: 16, class: 'select-chevron' })),
    desc);
  build(options, value);
  wrap.select = sel;
  wrap.setValue = setValue;
  wrap.setOptions = (opts, v) => build(opts, v === undefined ? flat[Number(sel.value)]?.value : v);
  wrap.setDisabled = (v) => {
    sel.disabled = !!v;
  };
  Object.defineProperty(wrap, 'value', {
    get: () => (sel.value === '' ? undefined : flat[Number(sel.value)]?.value),
    set: setValue,
  });
  return wrap;
}

/**
 * Switch (role="switch") with label and description.
 * @param {{ checked?: boolean, onChange?: (checked: boolean) => void, label?: unknown, description?: unknown, disabled?: boolean, ariaLabel?: string, class?: string }} [options]
 * @returns {HTMLLabelElement & { input: HTMLInputElement, setChecked(v: boolean): void, setDisabled(v: boolean): void }}
 */
export function toggle({ checked = false, onChange, label, description, disabled = false, ariaLabel, class: className } = {}) {
  return checkLike('toggle', { checked, onChange, label, description, disabled, ariaLabel, className });
}

/**
 * Checkbox with label and description.
 * @param {{ checked?: boolean, onChange?: (checked: boolean) => void, label?: unknown, description?: unknown, disabled?: boolean, ariaLabel?: string, class?: string }} [options]
 * @returns {HTMLLabelElement & { input: HTMLInputElement, setChecked(v: boolean): void, setDisabled(v: boolean): void }}
 */
export function checkbox({ checked = false, onChange, label, description, disabled = false, ariaLabel, class: className } = {}) {
  return checkLike('check', { checked, onChange, label, description, disabled, ariaLabel, className });
}

/**
 * @param {'toggle'|'check'} kind
 * @param {object} o
 */
function checkLike(kind, { checked, onChange, label, description, disabled, ariaLabel, className }) {
  const id = uid(kind);
  const input = h('input', {
    type: 'checkbox',
    class: `${kind}-input`,
    id,
    disabled,
    attrs: { role: kind === 'toggle' ? 'switch' : null, 'aria-label': label ? null : (ariaLabel || null) },
  });
  input.checked = !!checked;
  const descId = description ? `${id}-desc` : null;
  if (descId) input.setAttribute('aria-describedby', descId);
  const visual = kind === 'toggle'
    ? h('span.toggle-track', { 'aria-hidden': 'true' }, h('span.toggle-thumb'))
    : h('span.check-box', { 'aria-hidden': 'true' }, icon('check', { size: 12, strokeWidth: 3.2 }));
  const text = (label || description)
    ? h(`span.${kind}-text`,
      label && h(`span.${kind}-label`, label),
      description && h(`span.${kind}-desc`, { id: descId }, description))
    : null;
  const el = h('label', { class: [kind, disabled && 'is-disabled', !text && `${kind}-bare`, className], for: id }, input, visual, text);
  input.addEventListener('change', () => {
    if (typeof onChange === 'function') onChange(input.checked);
  });
  el.input = input;
  el.setChecked = (v) => {
    input.checked = !!v;
  };
  el.setDisabled = (v) => {
    input.disabled = !!v;
    el.classList.toggle('is-disabled', !!v);
  };
  return el;
}

/**
 * Large selectable cards backed by native radios (arrow keys move the selection).
 *
 * @param {object} options
 * @param {Array<{ value: any, label: unknown, description?: unknown, badge?: string|{ text: string, variant?: string }|Node, icon?: string|Node, disabled?: boolean }>} options.options
 * @param {any} [options.value]
 * @param {(value: any, option: object) => void} [options.onChange]
 * @param {number} [options.columns] fixed column count (default: responsive auto-fill)
 * @param {boolean} [options.disabled]
 * @param {string} [options.ariaLabel]
 * @param {boolean} [options.compact] smaller padding (for long lists)
 * @returns {HTMLElement & { setValue(v: any): void }}
 */
export function radioCards({ options = [], value, onChange, columns, disabled = false, ariaLabel, compact = false, class: className, name } = {}) {
  const group = name || uid('radio');
  const el = h('div', {
    class: ['radio-cards', columns && 'has-cols', compact && 'is-compact', className],
    role: 'radiogroup',
    attrs: { 'aria-label': ariaLabel },
    style: columns ? { '--cols': String(columns) } : null,
  });
  const items = options.filter(Boolean).map((o, i) => {
    const isDisabled = !!(disabled || o.disabled);
    const input = h('input', { type: 'radio', name: group, value: String(i), class: 'radio-card-input', disabled: isDisabled });
    const descId = o.description ? uid('rc-desc') : null;
    if (descId) input.setAttribute('aria-describedby', descId);
    let badgeEl = null;
    if (o.badge instanceof Node) badgeEl = o.badge;
    else if (typeof o.badge === 'string') badgeEl = badge(o.badge, 'neutral');
    else if (o.badge && typeof o.badge === 'object') badgeEl = badge(o.badge.text, o.badge.variant || 'neutral');
    let iconEl = null;
    if (o.icon instanceof Node) iconEl = h('span.radio-card-icon.is-custom', o.icon);
    else if (typeof o.icon === 'string') iconEl = h('span.radio-card-icon', icon(o.icon, { size: 18 }));
    const card = h('label', { class: ['radio-card', isDisabled && 'is-disabled'] },
      input,
      h('span.radio-card-top',
        iconEl,
        h('span.radio-card-label', o.label),
        badgeEl,
        h('span.radio-card-check', { 'aria-hidden': 'true' }, icon('check', { size: 12, strokeWidth: 3.2 }))),
      o.description && h('span.radio-card-desc', { id: descId }, o.description));
    input.addEventListener('change', () => {
      if (!input.checked) return;
      sync();
      if (typeof onChange === 'function') onChange(o.value, o);
    });
    return { input, card, option: o };
  });
  const sync = () => {
    for (const it of items) it.card.classList.toggle('is-selected', it.input.checked);
  };
  const setValue = (v) => {
    for (const it of items) it.input.checked = sameValue(it.option.value, v);
    sync();
  };
  el.append(...items.map((it) => it.card));
  setValue(value);
  el.setValue = setValue;
  return el;
}

/**
 * Segmented control (2–5 short options) backed by native radios.
 * @param {{ options: Array<{ value: any, label?: string, icon?: string, title?: string, disabled?: boolean }>, value?: any, onChange?: (value: any) => void, disabled?: boolean, ariaLabel?: string, size?: 'sm'|'md', block?: boolean }} options
 * @returns {HTMLElement & { setValue(v: any): void, setDisabled(v: boolean): void }}
 */
export function segmented({ options = [], value, onChange, disabled = false, ariaLabel, size = 'md', block = false, class: className } = {}) {
  const group = uid('seg');
  const el = h('div', { class: ['seg', `seg-${size}`, block && 'seg-block', disabled && 'is-disabled', className], role: 'radiogroup', attrs: { 'aria-label': ariaLabel } });
  const items = options.filter(Boolean).map((o, i) => {
    const input = h('input', { type: 'radio', name: group, value: String(i), class: 'seg-input', disabled: disabled || o.disabled, attrs: { 'aria-label': !o.label ? (o.title || String(o.value)) : null } });
    const item = h('label', { class: ['seg-item', o.disabled && 'is-disabled'], title: o.title },
      input,
      o.icon && icon(o.icon, { size: size === 'sm' ? 14 : 16 }),
      o.label && h('span.seg-label', o.label));
    input.addEventListener('change', () => {
      if (!input.checked) return;
      sync();
      if (typeof onChange === 'function') onChange(o.value, o);
    });
    return { input, item, option: o };
  });
  const sync = () => {
    for (const it of items) it.item.classList.toggle('is-selected', it.input.checked);
  };
  const setValue = (v) => {
    for (const it of items) it.input.checked = sameValue(it.option.value, v);
    sync();
  };
  el.append(...items.map((it) => it.item));
  setValue(value);
  el.setValue = setValue;
  el.setDisabled = (v) => {
    el.classList.toggle('is-disabled', !!v);
    for (const it of items) it.input.disabled = !!v || !!it.option.disabled;
  };
  return el;
}

/**
 * Text input. Returns the `<input>` itself, or a wrapper (with `.input`) when `icon` is given.
 * @param {{ value?: string, placeholder?: string, onInput?: (v: string, ev: Event) => void, onChange?: (v: string, ev: Event) => void, onEnter?: (v: string) => void, type?: string, disabled?: boolean, width?: number|string, icon?: string, ariaLabel?: string, maxLength?: number, class?: string }} [options]
 * @returns {HTMLInputElement|HTMLElement}
 */
export function textInput({
  value = '', placeholder, onInput, onChange, onEnter, type = 'text', disabled = false, width, icon: iconName, ariaLabel, maxLength, class: className,
} = {}) {
  const input = h('input', {
    type,
    class: ['input', className],
    placeholder,
    disabled,
    attrs: { 'aria-label': ariaLabel, maxlength: maxLength, spellcheck: 'false', autocomplete: 'off' },
  });
  input.value = value ?? '';
  input.addEventListener('input', (ev) => {
    if (typeof onInput === 'function') onInput(input.value, ev);
  });
  input.addEventListener('change', (ev) => {
    if (typeof onChange === 'function') onChange(input.value, ev);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && typeof onEnter === 'function') onEnter(input.value);
  });
  const widthStyle = width !== undefined ? (typeof width === 'number' ? `${width}px` : width) : null;
  if (!iconName) {
    if (widthStyle) input.style.width = widthStyle;
    return input;
  }
  const wrap = h('div.input-affix', { style: widthStyle ? { width: widthStyle } : null },
    icon(iconName, { size: 16, class: 'input-affix-icon' }), input);
  wrap.input = input;
  return wrap;
}

/**
 * @param {unknown} v
 * @returns {number|null}
 */
function toNumberOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * @param {number} step
 * @returns {number}
 */
function decimalsOf(step) {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * Numeric input (text field with validation; ArrowUp/ArrowDown step, Shift ×10).
 * `onChange(number|null)` fires for every valid in-range value while typing and once more on blur
 * after clamping; empty input emits null.
 *
 * @param {{ value?: number|null, min?: number, max?: number, step?: number, onChange?: (v: number|null) => void, suffix?: string, disabled?: boolean, integer?: boolean, placeholder?: string, width?: number|string, ariaLabel?: string, stepper?: boolean }} [options]
 * @returns {HTMLElement & { input: HTMLInputElement, setValue(v: number|null): void }}
 */
export function numberInput({
  value, min, max, step = 1, onChange, suffix, disabled = false, integer = false, placeholder, width, ariaLabel, stepper = false,
} = {}) {
  const input = h('input', {
    type: 'text',
    class: 'input number-input-field',
    disabled,
    placeholder,
    attrs: {
      inputmode: integer ? 'numeric' : 'decimal',
      'aria-label': ariaLabel,
      role: 'spinbutton',
      'aria-valuemin': min ?? null,
      'aria-valuemax': max ?? null,
      autocomplete: 'off',
      spellcheck: 'false',
    },
  });
  let current = toNumberOrNull(value);
  const show = (n) => {
    input.value = n === null ? '' : String(n);
    setAttr(input, 'aria-valuenow', n === null ? null : n);
  };
  show(current);
  const allowNegative = min === undefined || min === null || min < 0;
  const parse = (text) => {
    const t = String(text).trim().replace(',', '.');
    if (t === '') return { ok: true, value: null };
    const re = integer
      ? (allowNegative ? /^-?\d+$/ : /^\d+$/)
      : (allowNegative ? /^-?(?:\d+\.?\d*|\.\d+)$/ : /^(?:\d+\.?\d*|\.\d+)$/);
    if (!re.test(t)) return { ok: false, value: null };
    const n = Number(t);
    return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, value: null };
  };
  const inRange = (n) => (min === undefined || min === null || n >= min) && (max === undefined || max === null || n <= max);
  const clamp = (n) => {
    let v = n;
    if (min !== undefined && min !== null) v = Math.max(min, v);
    if (max !== undefined && max !== null) v = Math.min(max, v);
    return v;
  };
  const setInvalid = (bad) => {
    wrap.classList.toggle('is-invalid', bad);
    setAttr(input, 'aria-invalid', bad ? 'true' : null);
  };
  const emit = (n) => {
    if (Object.is(n, current)) return;
    current = n;
    setAttr(input, 'aria-valuenow', n === null ? null : n);
    if (typeof onChange === 'function') onChange(n);
  };
  const stepBy = (dir, big) => {
    const base = current ?? (min ?? 0);
    const amount = step * (big ? 10 : 1);
    let n = Number((base + dir * amount).toFixed(Math.max(decimalsOf(step), decimalsOf(base))));
    if (integer) n = Math.round(n);
    n = clamp(n);
    show(n);
    setInvalid(false);
    emit(n);
  };
  input.addEventListener('input', () => {
    const p = parse(input.value);
    const valid = p.ok && (p.value === null || inRange(p.value));
    setInvalid(!valid && input.value.trim() !== '');
    if (valid) emit(p.value);
  });
  input.addEventListener('change', () => {
    const p = parse(input.value);
    setInvalid(false);
    if (!p.ok) {
      show(current);
      return;
    }
    if (p.value === null) {
      emit(null);
      return;
    }
    let n = integer ? Math.round(p.value) : p.value;
    n = clamp(n);
    show(n);
    emit(n);
  });
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      stepBy(ev.key === 'ArrowUp' ? 1 : -1, ev.shiftKey);
    }
  });
  const wrap = h('div', {
    class: ['number-input', suffix && 'has-suffix', stepper && 'has-stepper', disabled && 'is-disabled'],
    style: width !== undefined ? { width } : null,
  },
  input,
  suffix && h('span.input-suffix', { 'aria-hidden': 'true' }, suffix),
  stepper && h('span.number-stepper',
    h('button', { type: 'button', class: 'number-step', tabIndex: -1, 'aria-label': 'Decrease', disabled, onClick: () => stepBy(-1, false) }, icon('minus', { size: 14 })),
    h('button', { type: 'button', class: 'number-step', tabIndex: -1, 'aria-label': 'Increase', disabled, onClick: () => stepBy(1, false) }, icon('plus', { size: 14 }))));
  wrap.input = input;
  wrap.setValue = (n) => {
    current = toNumberOrNull(n);
    show(current);
    setInvalid(false);
  };
  return wrap;
}

const BARE_UNITS = new Set(['%', 'px']);

/**
 * Format a number without exponent notation and with at most 4 decimals.
 * @param {number} n
 * @returns {string}
 */
function trimNumber(n) {
  const fixed = Number(n.toFixed(4));
  return Object.is(fixed, -0) ? '0' : String(fixed);
}

/**
 * Split an engine length string into number text + unit for {@link lengthInput}.
 * `'2mm'` → `{ number: '2', unit: 'mm' }`; a bare number maps to the bare unit ('%' or 'px') in
 * `units`; null/'' → empty number with the first unit.
 *
 * @param {string|number|null|undefined} value
 * @param {string[]} [units]
 * @returns {{ number: string, unit: string, valid: boolean }}
 */
export function parseLengthValue(value, units = ['mm', 'in']) {
  const list = Array.isArray(units) && units.length ? units : ['mm', 'in'];
  if (value === null || value === undefined || value === '') return { number: '', unit: list[0], valid: true };
  const s = String(value).trim();
  const m = /^(\d+(?:\.\d+)?|\.\d+)\s*(mm|in|%|px)?$/i.exec(s);
  if (!m) return { number: '', unit: list[0], valid: false };
  const num = trimNumber(Number(m[1]));
  const unit = m[2] ? m[2].toLowerCase() : null;
  if (unit && list.includes(unit)) return { number: num, unit, valid: true };
  if (!unit || BARE_UNITS.has(unit)) {
    const bare = list.find((u) => BARE_UNITS.has(u));
    if (bare && (!unit || unit === bare)) return { number: num, unit: bare, valid: true };
  }
  return { number: num, unit: list[0], valid: false };
}

/**
 * Build the engine length string from number text + unit: `('2', 'mm')` → `'2mm'`,
 * `('3', '%')` → `'3'` (bare number = percent / pixels per spec §1). Empty → null; invalid → undefined.
 * Accepts ',' as decimal separator; rejects negatives and garbage.
 *
 * @param {string} numberText
 * @param {string} unit
 * @returns {string|null|undefined}
 */
export function formatLengthValue(numberText, unit) {
  const t = String(numberText ?? '').trim().replace(',', '.');
  if (t === '') return null;
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(t)) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return undefined;
  const s = trimNumber(n);
  return BARE_UNITS.has(unit) ? s : `${s}${unit}`;
}

const UNIT_LABELS = { mm: 'mm', in: 'in', '%': '%', px: 'px' };

/**
 * Length input: number + unit picker. Emits engine strings: `'2mm'`, `'0.1in'`, bare `'3'` for
 * '%'/'px', or null when empty. Switching between mm and in converts the number.
 *
 * @param {{ value?: string|null, onChange?: (v: string|null) => void, units?: string[], placeholder?: string, disabled?: boolean, ariaLabel?: string, width?: number|string }} [options]
 * @returns {HTMLElement & { input: HTMLInputElement, setValue(v: string|null): void }}
 */
export function lengthInput({ value, onChange, units = ['mm', 'in'], placeholder = '0', disabled = false, ariaLabel, width } = {}) {
  const list = Array.isArray(units) && units.length ? units : ['mm', 'in'];
  let parsed = parseLengthValue(value, list);
  let unit = parsed.unit;
  let lastEmitted = value === undefined ? null : value;
  const input = h('input', {
    type: 'text',
    class: 'input length-input-field',
    disabled,
    placeholder,
    attrs: { inputmode: 'decimal', 'aria-label': ariaLabel, autocomplete: 'off', spellcheck: 'false' },
  });
  input.value = parsed.number;
  const unitSel = h('select', { class: 'length-unit', disabled, attrs: { 'aria-label': 'Unit' } },
    list.map((u) => h('option', { value: u }, UNIT_LABELS[u] || u)));
  unitSel.value = unit;
  const wrap = h('div', { class: ['length-input', disabled && 'is-disabled'], style: width !== undefined ? { width } : null }, input, unitSel);
  const setInvalid = (bad) => {
    wrap.classList.toggle('is-invalid', bad);
    setAttr(input, 'aria-invalid', bad ? 'true' : null);
  };
  const emit = () => {
    const out = formatLengthValue(input.value, unit);
    if (out === undefined) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (out === lastEmitted) return;
    lastEmitted = out;
    if (typeof onChange === 'function') onChange(out);
  };
  input.addEventListener('input', emit);
  input.addEventListener('change', () => {
    const out = formatLengthValue(input.value, unit);
    if (out === undefined) return;
    const p = parseLengthValue(out, list);
    input.value = p.number;
  });
  unitSel.addEventListener('change', () => {
    const next = unitSel.value;
    const t = String(input.value).trim().replace(',', '.');
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) {
      if (unit === 'mm' && next === 'in') input.value = trimNumber(Number((n / 25.4).toFixed(3)));
      else if (unit === 'in' && next === 'mm') input.value = trimNumber(Number((n * 25.4).toFixed(2)));
    }
    unit = next;
    emit();
  });
  wrap.input = input;
  wrap.setValue = (v) => {
    parsed = parseLengthValue(v, list);
    unit = parsed.unit;
    input.value = parsed.number;
    unitSel.value = unit;
    lastEmitted = v ?? null;
    setInvalid(false);
  };
  return wrap;
}

/**
 * Multi-line text area (monospace by default, for deck lists).
 * @param {{ value?: string, placeholder?: string, onInput?: (v: string) => void, onChange?: (v: string) => void, rows?: number, monospace?: boolean, disabled?: boolean, ariaLabel?: string, class?: string }} [options]
 * @returns {HTMLTextAreaElement}
 */
export function textArea({ value = '', placeholder, onInput, onChange, rows = 10, monospace = true, disabled = false, ariaLabel, class: className } = {}) {
  const ta = h('textarea', {
    class: ['input', 'textarea', monospace && 'mono', className],
    rows,
    placeholder,
    disabled,
    attrs: { 'aria-label': ariaLabel, spellcheck: 'false', autocomplete: 'off' },
  });
  ta.value = value ?? '';
  ta.addEventListener('input', () => {
    if (typeof onInput === 'function') onInput(ta.value);
  });
  ta.addEventListener('change', () => {
    if (typeof onChange === 'function') onChange(ta.value);
  });
  return ta;
}

/**
 * Free-form chips: type and press Enter (or comma) to add; Backspace on empty removes the last.
 * @param {{ values?: string[], onChange?: (values: string[]) => void, placeholder?: string, suggestions?: Array<string|{ value: string, label?: string }>, validate?: (v: string) => boolean, ariaLabel?: string, disabled?: boolean }} [options]
 * @returns {HTMLElement & { input: HTMLInputElement, setValues(v: string[]): void }}
 */
export function chipsInput({ values = [], onChange, placeholder = 'Type and press Enter', suggestions = [], validate, ariaLabel, disabled = false } = {}) {
  let list = (values || []).map(String);
  const listId = suggestions && suggestions.length ? uid('chips-dl') : null;
  const input = h('input', {
    type: 'text',
    class: 'chips-input-field',
    placeholder,
    disabled,
    attrs: { list: listId, 'aria-label': ariaLabel, autocomplete: 'off', spellcheck: 'false' },
  });
  const chips = h('span.chips-list');
  const el = h('div', { class: ['chips-input', disabled && 'is-disabled'] }, chips, input,
    listId && h('datalist', { id: listId }, suggestions.map((s) => (typeof s === 'object'
      ? h('option', { value: String(s.value) }, s.label ?? '')
      : h('option', { value: String(s) })))));
  el.addEventListener('mousedown', (ev) => {
    if (ev.target === el || ev.target === chips) {
      ev.preventDefault();
      input.focus();
    }
  });
  const commit = () => {
    if (typeof onChange === 'function') onChange([...list]);
  };
  const render = () => {
    chips.replaceChildren(...list.map((v, i) => h('span.chip.chip-removable',
      h('span.chip-text', v),
      h('button', {
        type: 'button',
        class: 'chip-remove',
        disabled,
        attrs: { 'aria-label': `Remove ${v}` },
        onClick: () => {
          list.splice(i, 1);
          render();
          commit();
          input.focus();
        },
      }, icon('x', { size: 12 })))));
  };
  const add = (raw) => {
    const parts = String(raw).split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
    let changed = false;
    let rejected = false;
    for (const p of parts) {
      if (typeof validate === 'function' && validate(p) === false) {
        rejected = true;
        continue;
      }
      if (!list.includes(p)) {
        list.push(p);
        changed = true;
      }
    }
    el.classList.toggle('is-invalid', rejected);
    if (changed) {
      render();
      commit();
    }
    return !rejected;
  };
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ',') {
      if (input.value.trim()) {
        ev.preventDefault();
        if (add(input.value)) input.value = '';
      } else if (ev.key === ',') {
        ev.preventDefault();
      }
    } else if (ev.key === 'Backspace' && input.value === '' && list.length) {
      list.pop();
      render();
      commit();
    }
  });
  input.addEventListener('input', (ev) => {
    el.classList.remove('is-invalid');
    if (ev.inputType === 'insertReplacementText' || ev.inputType === undefined) {
      // A datalist suggestion was picked.
      if (input.value.trim() && add(input.value)) input.value = '';
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim() && add(input.value)) input.value = '';
  });
  render();
  el.input = input;
  el.setValues = (vals) => {
    list = (vals || []).map(String);
    render();
  };
  return el;
}

/**
 * Toggleable chips for picking several fixed options.
 * @param {{ options: Array<string|{ value: any, label?: string, description?: string, disabled?: boolean }>, values?: any[], onChange?: (values: any[]) => void, disabled?: boolean, ariaLabel?: string }} [options]
 * @returns {HTMLElement & { setValues(v: any[]): void }}
 */
export function multiSelectChips({ options = [], values = [], onChange, disabled = false, ariaLabel } = {}) {
  const norm = options.filter((o) => o !== null && o !== undefined)
    .map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  let selected = new Set((values || []).map(String));
  const el = h('div.chip-group', { role: 'group', attrs: { 'aria-label': ariaLabel } });
  const buttons = norm.map((o) => {
    const b = h('button', {
      type: 'button',
      class: 'chip chip-toggle',
      disabled: disabled || o.disabled,
      title: o.description,
      attrs: { 'aria-pressed': String(selected.has(String(o.value))) },
    }, h('span.chip-check', { 'aria-hidden': 'true' }, icon('check', { size: 12, strokeWidth: 3 })), h('span', o.label ?? String(o.value)));
    b.addEventListener('click', () => {
      const key = String(o.value);
      if (selected.has(key)) selected.delete(key);
      else selected.add(key);
      b.setAttribute('aria-pressed', String(selected.has(key)));
      if (typeof onChange === 'function') onChange(norm.filter((x) => selected.has(String(x.value))).map((x) => x.value));
    });
    return b;
  });
  el.append(...buttons);
  el.setValues = (vals) => {
    selected = new Set((vals || []).map(String));
    buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(selected.has(String(norm[i].value)))));
  };
  return el;
}

/* ------------------------------------------------------------------------------------------------
 * Containers
 * ---------------------------------------------------------------------------------------------- */

/**
 * Page section with a heading row; optionally collapsible (accordion pattern).
 * @param {{ title?: unknown, description?: unknown, icon?: string, collapsible?: boolean, collapsed?: boolean, actions?: unknown, children?: unknown, class?: string, id?: string, onToggle?: (collapsed: boolean) => void }} [options]
 * @returns {HTMLElement & { body: HTMLElement, setCollapsed(v: boolean): void }}
 */
export function section({ title, description, icon: iconName, collapsible = false, collapsed = false, actions, children, class: className, id, onToggle } = {}) {
  const bodyId = uid('section-body');
  const body = h('div.section-body', { id: bodyId }, children);
  const iconEl = iconName ? h('span.section-icon', icon(iconName, { size: 18 })) : null;
  let toggleBtn = null;
  let headMain;
  if (collapsible) {
    toggleBtn = h('button', { type: 'button', class: 'section-toggle', attrs: { 'aria-expanded': String(!collapsed), 'aria-controls': bodyId } },
      iconEl,
      h('span.section-titles', h('span.section-title', title), description && h('span.section-desc', description)),
      h('span.section-chevron', icon('chevron-down', { size: 18 })));
    headMain = h('h2.section-heading', toggleBtn);
  } else {
    headMain = h('div.section-head-main', iconEl,
      h('div.section-titles', title && h('h2.section-title', title), description && h('p.section-desc', description)));
  }
  const header = (title || description || actions) ? h('header.section-header', headMain, actions && h('div.section-actions', renderActions(actions))) : null;
  const el = h('section', { class: ['section', collapsible && 'is-collapsible', collapsible && collapsed && 'is-collapsed', className], id }, header, body);
  body.hidden = collapsible && collapsed;
  const setCollapsed = (v) => {
    el.classList.toggle('is-collapsed', v);
    body.hidden = v;
    if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(!v));
  };
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      const next = !el.classList.contains('is-collapsed');
      setCollapsed(next);
      if (typeof onToggle === 'function') onToggle(next);
    });
  }
  el.body = body;
  el.setCollapsed = setCollapsed;
  return el;
}

/**
 * Surface card with optional header.
 * @param {{ title?: unknown, subtitle?: unknown, icon?: string, actions?: unknown, children?: unknown, footer?: unknown, class?: string, variant?: 'accent'|'success'|'warning'|'danger'|'flat' }} [options]
 * @returns {HTMLElement & { body: HTMLElement }}
 */
export function card({ title, subtitle, icon: iconName, actions, children, footer, class: className, variant } = {}) {
  const header = (title || subtitle || actions || iconName)
    ? h('div.card-header',
      iconName && h('span.card-icon', icon(iconName, { size: 18 })),
      h('div.card-titles', title && h('h3.card-title', title), subtitle && h('p.card-subtitle', subtitle)),
      actions && h('div.card-actions', renderActions(actions)))
    : null;
  const body = h('div.card-body', children);
  const el = h('div', { class: ['card', variant && `card-${variant}`, className] }, header, body, footer && h('div.card-footer', footer));
  el.body = body;
  return el;
}

/**
 * Tab strip (role="tablist"; arrow keys/Home/End move and select). The view renders the panel.
 * @param {{ tabs: Array<{ id: string, label: unknown, badge?: string|number|null, icon?: string, disabled?: boolean, panelId?: string }>, active?: string, onChange?: (id: string) => void, ariaLabel?: string, class?: string }} options
 * @returns {HTMLElement & { setActive(id: string): void, setBadge(id: string, badge: string|number|null): void }}
 */
export function tabs({ tabs: items = [], active, onChange, ariaLabel, class: className } = {}) {
  const el = h('div', { class: ['tabs', className], role: 'tablist', attrs: { 'aria-label': ariaLabel } });
  let current = active ?? items[0]?.id;
  const renderBadge = (b) => (b === null || b === undefined || b === '' ? null : h('span.tab-badge', String(b)));
  const buttons = items.map((t) => {
    const b = h('button', {
      type: 'button',
      class: 'tab',
      role: 'tab',
      id: uid('tab'),
      disabled: t.disabled,
      dataset: { tab: t.id },
      attrs: { 'aria-selected': 'false', 'aria-controls': t.panelId || null },
    }, t.icon && icon(t.icon, { size: 16 }), h('span.tab-label', t.label), h('span.tab-badge-slot', renderBadge(t.badge)));
    b.addEventListener('click', () => selectTab(t.id, true));
    return b;
  });
  const selectTab = (id, emit) => {
    const changed = id !== current;
    current = id;
    buttons.forEach((b, i) => {
      const on = items[i].id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      b.classList.toggle('is-active', on);
    });
    if (emit && changed && typeof onChange === 'function') onChange(id);
  };
  el.addEventListener('keydown', (ev) => {
    const enabled = buttons.filter((b) => !b.disabled);
    const idx = enabled.indexOf(document.activeElement);
    if (idx === -1) return;
    let next = null;
    if (ev.key === 'ArrowRight') next = enabled[(idx + 1) % enabled.length];
    else if (ev.key === 'ArrowLeft') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (ev.key === 'Home') next = enabled[0];
    else if (ev.key === 'End') next = enabled[enabled.length - 1];
    if (!next) return;
    ev.preventDefault();
    next.focus();
    selectTab(next.dataset.tab, true);
  });
  el.append(...buttons);
  selectTab(current, false);
  el.setActive = (id) => selectTab(id, false);
  el.setBadge = (id, b) => {
    const i = items.findIndex((t) => t.id === id);
    if (i >= 0) mountInto(buttons[i].querySelector('.tab-badge-slot'), renderBadge(b));
  };
  return el;
}

/**
 * Progress bar; `percent` null = indeterminate.
 * @param {{ percent?: number|null, label?: string, showValue?: boolean }} [options]
 * @returns {HTMLElement & { update(percent: number|null, label?: string): void }}
 */
export function progressBar({ percent = null, label, showValue = true } = {}) {
  const fill = h('div.progress-fill');
  const labelEl = h('span.progress-label');
  const valueEl = h('span.progress-value');
  const meta = h('div.progress-meta', labelEl, valueEl);
  const el = h('div', { class: 'progress', role: 'progressbar', attrs: { 'aria-valuemin': '0', 'aria-valuemax': '100' } },
    meta, h('div.progress-track', fill));
  const update = (p, l) => {
    const determinate = typeof p === 'number' && Number.isFinite(p);
    el.classList.toggle('is-indeterminate', !determinate);
    let pctText = '';
    if (determinate) {
      const c = Math.max(0, Math.min(100, p));
      fill.style.width = `${c}%`;
      const shown = c >= 100 ? 100 : Math.min(99, Math.round(c));
      pctText = `${shown}%`;
      el.setAttribute('aria-valuenow', String(shown));
    } else {
      fill.style.width = '';
      el.removeAttribute('aria-valuenow');
    }
    valueEl.textContent = showValue ? pctText : '';
    if (l !== undefined) labelEl.textContent = l ?? '';
    const text = [labelEl.textContent, pctText].filter(Boolean).join(' ');
    setAttr(el, 'aria-valuetext', text || (determinate ? null : 'In progress'));
    meta.hidden = !labelEl.textContent && !valueEl.textContent;
  };
  update(percent, label ?? '');
  el.update = update;
  return el;
}

/**
 * Empty state with icon, title, message and actions (first action is primary).
 * @param {{ icon?: string, title?: unknown, message?: unknown, action?: unknown, actions?: unknown, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function emptyState({ icon: iconName = 'images', title, message, action, actions, class: className } = {}) {
  const acts = action ?? actions;
  return h('div', { class: ['empty', className] },
    h('div.empty-icon', icon(iconName, { size: 28 })),
    title && h('h3.empty-title', title),
    message && h('p.empty-message', message),
    acts && h('div.empty-actions', renderActions(acts, { size: 'md', firstVariant: 'primary' })));
}

const CALLOUT_ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle', accent: 'sparkles', neutral: 'info' };

/**
 * Inline message box.
 * @param {{ variant?: 'info'|'success'|'warning'|'danger'|'accent'|'neutral', title?: unknown, message?: unknown, actions?: unknown, icon?: string, compact?: boolean, onDismiss?: () => void, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function callout({ variant = 'info', title, message, actions, icon: iconName, compact = false, onDismiss, class: className } = {}) {
  const el = h('div', { class: ['callout', `callout-${variant}`, compact && 'callout-compact', className] },
    h('span.callout-icon', icon(iconName || CALLOUT_ICONS[variant] || 'info', { size: 18 })),
    h('div.callout-body',
      title && h('div.callout-title', title),
      message && h('div.callout-message', message),
      actions && h('div.callout-actions', renderActions(actions, { size: 'sm' }))));
  if (typeof onDismiss === 'function') {
    el.append(button({
      icon: 'x', variant: 'ghost', size: 'sm', title: 'Dismiss', class: 'callout-dismiss',
      onClick: () => {
        el.remove();
        onDismiss();
      },
    }));
  }
  return el;
}

/**
 * Image tile for card grids: lazy full-file image, fallback tile on error, badges and hover actions.
 * @param {{ src?: string, alt?: string, title?: unknown, subtitle?: unknown, badges?: Node[], actions?: unknown, selected?: boolean, onOpen?: () => void, fallbackText?: string, count?: number, class?: string }} [options]
 * @returns {HTMLElement}
 */
export function imageTile({ src, alt = '', title, subtitle, badges = [], actions, selected = false, onOpen, fallbackText, count, class: className } = {}) {
  const media = h(onOpen ? 'button' : 'div', {
    class: 'img-tile-media',
    type: onOpen ? 'button' : undefined,
    attrs: onOpen ? { 'aria-label': `View ${typeof title === 'string' ? title : 'image'}` } : null,
    onClick: onOpen ? () => onOpen() : undefined,
  });
  const fallback = () => mountInto(media, h('span.img-tile-fallback', icon('image', { size: 22 }), h('span', fallbackText || 'Preview unavailable')));
  if (src) {
    const img = h('img', { src, alt, loading: 'lazy', decoding: 'async', draggable: false });
    img.addEventListener('error', fallback, { once: true });
    media.append(img);
  } else {
    fallback();
  }
  return h('figure', { class: ['img-tile', selected && 'is-selected', className] },
    h('div.img-tile-frame',
      media,
      (badges && badges.length) ? h('div.img-tile-badges', badges) : null,
      count && count > 1 ? h('span.img-tile-count', `×${count}`) : null,
      actions && h('div.img-tile-actions', renderActions(actions, { size: 'sm', variant: 'secondary' }))),
    (title || subtitle) && h('figcaption.img-tile-caption',
      title && h('span.img-tile-title', { title: typeof title === 'string' ? title : undefined }, title),
      subtitle && h('span.img-tile-sub', subtitle)));
}

/* ------------------------------------------------------------------------------------------------
 * Floating layers: tooltips, menus, toasts, modals
 * ---------------------------------------------------------------------------------------------- */

/**
 * @param {string} id
 * @param {string} className
 * @param {Record<string, string>} [attrs]
 * @returns {HTMLElement}
 */
function layerRoot(id, className, attrs = {}) {
  let el = document.getElementById(id);
  if (!el) {
    el = h('div', { id, class: className, attrs });
    document.body.append(el);
  }
  return el;
}

/**
 * Place a fixed-position element next to an anchor, flipping/clamping to stay in the viewport.
 * @param {HTMLElement} el
 * @param {Element} anchor
 * @param {'top'|'bottom'|'top-start'|'bottom-start'|'right-end'} [placement]
 */
function positionFloating(el, anchor, placement = 'top') {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  el.style.left = '0px';
  el.style.top = '0px';
  const w = el.offsetWidth;
  const ht = el.offsetHeight;
  const gap = 8;
  let top;
  let left;
  if (placement === 'right-end') {
    left = r.right + gap;
    top = r.bottom - ht;
    if (left + w > vw - 8) left = Math.max(8, r.left - w - gap);
  } else {
    const preferTop = placement.startsWith('top');
    top = preferTop ? r.top - ht - gap : r.bottom + gap;
    if (preferTop && top < 8) top = r.bottom + gap;
    if (!preferTop && top + ht > vh - 8) top = r.top - ht - gap;
    left = placement.endsWith('start') ? r.left : r.left + r.width / 2 - w / 2;
  }
  left = Math.max(8, Math.min(left, vw - w - 8));
  top = Math.max(8, Math.min(top, vh - ht - 8));
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

let tooltipEl = null;
let tooltipOwner = null;
let tooltipTimer = null;

function hideTooltipNow() {
  clearTimeout(tooltipTimer);
  tooltipTimer = null;
  if (tooltipEl) tooltipEl.classList.remove('is-visible');
  tooltipOwner = null;
}

/**
 * Attach a hover/focus tooltip to any element (visual only; give the element its own accessible
 * name/description).
 * @param {HTMLElement} el
 * @param {string|(() => string)} text
 * @param {{ delay?: number, placement?: 'top'|'bottom' }} [options]
 * @returns {() => void} detach
 */
export function attachTooltip(el, text, { delay = 300, placement = 'top' } = {}) {
  const show = (immediate) => {
    clearTimeout(tooltipTimer);
    const run = () => {
      if (!el.isConnected) return;
      if (!tooltipEl) {
        tooltipEl = h('div.tooltip', { attrs: { 'aria-hidden': 'true' } });
        layerRoot('popover-root', 'popover-root').append(tooltipEl);
      }
      tooltipEl.textContent = typeof text === 'function' ? text() : String(text ?? '');
      if (!tooltipEl.textContent) return;
      tooltipOwner = el;
      tooltipEl.classList.add('is-visible');
      positionFloating(tooltipEl, el, placement);
    };
    if (immediate) run();
    else tooltipTimer = setTimeout(run, delay);
  };
  const hide = () => {
    if (tooltipOwner === el || tooltipTimer) hideTooltipNow();
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape' && tooltipOwner === el) hideTooltipNow();
  };
  const onEnter = () => show(false);
  const onFocus = () => {
    if (el.matches(':focus-visible')) show(true);
  };
  el.addEventListener('pointerenter', onEnter);
  el.addEventListener('pointerleave', hide);
  el.addEventListener('focus', onFocus);
  el.addEventListener('blur', hide);
  el.addEventListener('keydown', onKey);
  el._showTooltip = () => show(true);
  return () => {
    el.removeEventListener('pointerenter', onEnter);
    el.removeEventListener('pointerleave', hide);
    el.removeEventListener('focus', onFocus);
    el.removeEventListener('blur', hide);
    el.removeEventListener('keydown', onKey);
    hide();
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => hideTooltipNow(), { capture: true, passive: true });
  window.addEventListener('blur', () => hideTooltipNow());
}

/**
 * Small (?) button that explains something in a tooltip (also readable by screen readers).
 * @param {string} text
 * @param {{ label?: string }} [options]
 * @returns {HTMLElement}
 */
export function helpTip(text, { label = 'More information' } = {}) {
  const descId = uid('tip');
  const btn = h('button', { type: 'button', class: 'help-tip', attrs: { 'aria-label': label, 'aria-describedby': descId } },
    icon('help', { size: 15 }));
  attachTooltip(btn, text, { delay: 150 });
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    if (tooltipOwner === btn) hideTooltipNow();
    else btn._showTooltip();
  });
  return h('span.help-tip-wrap', btn, h('span.sr-only', { id: descId }, text));
}

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])', '[contenteditable="true"]',
].join(',');

/**
 * Keyboard-focusable descendants in tab order (one entry per radio group).
 * @param {Element} root
 * @returns {HTMLElement[]}
 */
function focusables(root) {
  const seenGroups = new Set();
  const all = [...root.querySelectorAll(FOCUSABLE)].filter((el) => {
    if (el.closest('[hidden], [inert]')) return false;
    if (el.getClientRects().length === 0) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  });
  return all.filter((el) => {
    if (!(el instanceof HTMLInputElement) || el.type !== 'radio' || !el.name) return true;
    if (seenGroups.has(el.name)) return false;
    const groupEls = all.filter((x) => x instanceof HTMLInputElement && x.type === 'radio' && x.name === el.name);
    const checked = groupEls.find((x) => x.checked);
    if ((checked && checked === el) || (!checked && groupEls[0] === el)) {
      seenGroups.add(el.name);
      return true;
    }
    return false;
  });
}

/**
 * Keep Tab/Shift+Tab inside `root`.
 * @param {KeyboardEvent} ev
 * @param {HTMLElement} root
 */
function trapTab(ev, root) {
  if (ev.key !== 'Tab') return;
  const list = focusables(root);
  if (list.length === 0) {
    ev.preventDefault();
    root.focus();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (ev.shiftKey && (active === first || !root.contains(active) || active === root)) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && (active === last || !root.contains(active))) {
    ev.preventDefault();
    first.focus();
  }
}

/**
 * Popover menu anchored to a button (role="menu"; arrows/Home/End move, Esc closes and returns
 * focus to the anchor, click outside closes).
 *
 * @param {{ anchor: HTMLElement, items: Array<{ label: unknown, icon?: string, hint?: string, title?: string, onSelect?: () => void, external?: boolean, disabled?: boolean }|{ divider: true }|{ heading: string }>, placement?: 'top-start'|'bottom-start'|'top'|'bottom'|'right-end', label?: string, onClose?: () => void, class?: string }} options
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function popoverMenu({ anchor, items = [], placement = 'bottom-start', label, onClose, class: className } = {}) {
  const root = layerRoot('popover-root', 'popover-root');
  const menuEl = h('div', { class: ['menu', className], role: 'menu', tabIndex: -1, attrs: { 'aria-label': label } });
  const entries = [];
  for (const item of items) {
    if (!item) continue;
    if (item.divider) {
      menuEl.append(h('div.menu-sep', { role: 'separator' }));
      continue;
    }
    if (item.heading) {
      menuEl.append(h('div.menu-heading', { role: 'presentation' }, item.heading));
      continue;
    }
    const btn = h('button', { type: 'button', class: 'menu-item', role: 'menuitem', tabIndex: -1, disabled: item.disabled, title: item.title || undefined },
      item.icon ? icon(item.icon, { size: 16, class: 'menu-item-icon' }) : h('span.menu-item-icon'),
      h('span.menu-item-label', item.label, item.hint && h('span.menu-item-hint', item.hint)),
      item.external && icon('external-link', { size: 14, class: 'menu-item-ext' }));
    btn.addEventListener('click', () => {
      close();
      if (typeof item.onSelect === 'function') {
        try {
          const r = item.onSelect();
          if (r && typeof r.then === 'function') r.catch((err) => showError(err));
        } catch (err) {
          showError(err);
        }
      }
    });
    entries.push(btn);
    menuEl.append(btn);
  }
  let closed = false;
  const onDocPointer = (ev) => {
    if (!menuEl.contains(ev.target) && !(anchor && anchor.contains(ev.target))) close(false);
  };
  const onResize = () => close(false);
  function close(restoreFocus = true) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onDocPointer, true);
    window.removeEventListener('resize', onResize);
    menuEl.remove();
    if (anchor) anchor.setAttribute('aria-expanded', 'false');
    if (restoreFocus && anchor && anchor.isConnected) anchor.focus();
    if (typeof onClose === 'function') onClose();
  }
  menuEl.addEventListener('keydown', (ev) => {
    const enabled = entries.filter((b) => !b.disabled);
    const idx = enabled.indexOf(document.activeElement);
    let next = null;
    if (ev.key === 'ArrowDown') next = enabled[(idx + 1) % enabled.length];
    else if (ev.key === 'ArrowUp') next = enabled[(idx - 1 + enabled.length) % enabled.length];
    else if (ev.key === 'Home') next = enabled[0];
    else if (ev.key === 'End') next = enabled[enabled.length - 1];
    else if (ev.key === 'Escape') {
      ev.preventDefault();
      close(true);
      return;
    } else if (ev.key === 'Tab') {
      close(false);
      return;
    }
    if (next) {
      ev.preventDefault();
      next.focus();
    }
  });
  root.append(menuEl);
  if (anchor) {
    anchor.setAttribute('aria-expanded', 'true');
    positionFloating(menuEl, anchor, placement);
  }
  document.addEventListener('pointerdown', onDocPointer, true);
  window.addEventListener('resize', onResize);
  const firstEnabled = entries.find((b) => !b.disabled);
  (firstEnabled || menuEl).focus();
  return { close: () => close(false), el: menuEl };
}

const TOAST_ICONS = { info: 'info', success: 'check-circle', warning: 'alert-triangle', danger: 'alert-circle', accent: 'sparkles', neutral: 'info' };
const MAX_TOASTS = 4;

/**
 * Transient notification (bottom-right, aria-live). Hover/focus pauses the timer. Toasts with
 * actions stay at least 8 s when the default timeout is used.
 *
 * @param {{ variant?: 'info'|'success'|'warning'|'danger'|'accent'|'neutral', title?: unknown, message?: unknown, actions?: Array<{ label: string, onClick?: () => any }>, timeout?: number }} [options]
 *   `timeout` 0 keeps the toast until closed.
 * @returns {{ close: () => void, el: HTMLElement }}
 */
export function toast({ variant = 'info', title, message, actions = [], timeout = 5000 } = {}) {
  const root = layerRoot('toast-root', 'toast-root', { role: 'region', 'aria-label': 'Notifications', 'aria-live': 'polite' });
  let closed = false;
  let timer = null;
  let remaining = actions.length && timeout === 5000 ? 8000 : timeout;
  let startedAt = 0;
  const el = h('div', { class: ['toast', `toast-${variant}`], role: variant === 'danger' ? 'alert' : 'status' });
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    el.classList.add('is-leaving');
    const done = () => el.remove();
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) done();
    else {
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 400);
    }
  };
  const actionButtons = (actions || []).filter(Boolean).map((a) => button({
    label: a.label,
    size: 'sm',
    variant: a.variant || 'secondary',
    icon: a.icon,
    onClick: async () => {
      try {
        if (typeof a.onClick === 'function') await a.onClick();
      } finally {
        close();
      }
    },
  }));
  el.append(
    h('span.toast-icon', icon(TOAST_ICONS[variant] || 'info', { size: 18 })),
    h('div.toast-body',
      title && h('div.toast-title', title),
      message && h('div.toast-message', message),
      actionButtons.length ? h('div.toast-actions', actionButtons) : null),
    button({ icon: 'x', variant: 'ghost', size: 'sm', title: 'Dismiss', class: 'toast-close', onClick: close }),
  );
  const start = () => {
    if (!remaining || remaining <= 0) return;
    startedAt = Date.now();
    clearTimeout(timer);
    timer = setTimeout(close, remaining);
  };
  const pause = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining = Math.max(1200, remaining - (Date.now() - startedAt));
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', start);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', (ev) => {
    if (!el.contains(ev.relatedTarget)) start();
  });
  root.append(el);
  const live = [...root.querySelectorAll('.toast:not(.is-leaving)')];
  for (const old of live.slice(0, Math.max(0, live.length - MAX_TOASTS))) old.querySelector('.toast-close')?.click();
  start();
  return { close, el };
}

/**
 * Modal dialog (native `<dialog>` + explicit focus trap). Esc and a backdrop click close it unless
 * `dismissible: false`. Focus returns to the previously focused element.
 *
 * Actions: Nodes, or `{ label, variant, icon, onClick({ close }), autofocus, disabled }`; an action
 * closes the modal after `onClick` resolves unless it returns `false`.
 *
 * @param {{ title?: unknown, content?: unknown, actions?: unknown[], wide?: boolean, onClose?: (reason: string) => void, dismissible?: boolean, class?: string, initialFocus?: HTMLElement }} [options]
 * @returns {{ close: (reason?: string) => void, el: HTMLDialogElement, body: HTMLElement }}
 */
export function modal({ title, content, actions = [], wide = false, onClose, dismissible = true, class: className, initialFocus } = {}) {
  const root = layerRoot('modal-root', 'modal-root');
  const titleId = uid('modal-title');
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const dialog = h('dialog', { class: ['modal', wide && 'modal-wide', className], attrs: { 'aria-labelledby': title ? titleId : null, 'aria-modal': 'true' } });
  let closed = false;
  let closeReason = 'close';

  const closeBtn = button({ icon: 'x', variant: 'ghost', size: 'sm', title: 'Close', class: 'modal-close', onClick: () => close('close') });
  const header = h('header.modal-header', title ? h('h2.modal-title', { id: titleId }, title) : h('span'), dismissible ? closeBtn : null);
  const body = h('div.modal-body', typeof content === 'string' ? h('p', content) : content);
  const actionEls = (actions || []).filter(Boolean).map((a) => {
    if (a instanceof Node) return a;
    const b = button({
      label: a.label,
      variant: a.variant || 'secondary',
      icon: a.icon,
      disabled: a.disabled,
      onClick: async () => {
        // Ignore clicks during the closing animation (e.g. Cancel then a quick "Delete forever").
        if (closed) return;
        const r = typeof a.onClick === 'function' ? await a.onClick({ close }) : undefined;
        if (r !== false) close(a.reason || 'action');
      },
    });
    if (a.autofocus) b.dataset.autofocus = 'true';
    return b;
  });
  const footer = actionEls.length ? h('footer.modal-footer', actionEls) : null;
  dialog.append(h('div.modal-inner', header, body, footer));

  const finish = () => {
    if (dialog.isConnected) dialog.remove();
    if (previouslyFocused && previouslyFocused.isConnected) {
      try {
        previouslyFocused.focus({ preventScroll: true });
      } catch {
        /* ignore */
      }
    }
    if (typeof onClose === 'function') onClose(closeReason);
  };
  function close(reason = 'close') {
    if (closed) return;
    closed = true;
    closeReason = reason;
    dialog.classList.add('is-closing');
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const done = () => {
      if (dialog.open) dialog.close();
      finish();
    };
    if (reduce) done();
    else setTimeout(done, 140);
  }
  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    if (dismissible) close('escape');
  });
  dialog.addEventListener('close', () => {
    // Browser-forced close (e.g. repeated Esc): clean up once.
    if (!closed) {
      closed = true;
      closeReason = 'escape';
      finish();
    }
  });
  dialog.addEventListener('keydown', (ev) => trapTab(ev, dialog));
  let downOnBackdrop = false;
  dialog.addEventListener('mousedown', (ev) => {
    downOnBackdrop = ev.target === dialog;
  });
  dialog.addEventListener('click', (ev) => {
    if (dismissible && downOnBackdrop && ev.target === dialog) close('backdrop');
    downOnBackdrop = false;
  });

  root.append(dialog);
  dialog.showModal();
  const target = initialFocus
    || dialog.querySelector('[data-autofocus="true"]')
    || focusables(body)[0]
    || actionEls.find((b) => b instanceof HTMLElement && !b.disabled)
    || (dismissible ? closeBtn : dialog);
  try {
    target.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  return { close, el: dialog, body };
}

/**
 * Confirmation dialog. Danger dialogs focus the cancel button first.
 * @param {{ title?: unknown, message?: unknown, confirmLabel?: string, cancelLabel?: string, danger?: boolean }} [options]
 * @returns {Promise<boolean>} true when confirmed.
 */
export function confirmDialog({ title = 'Are you sure?', message, confirmLabel = 'OK', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    const content = message === undefined || message === null ? null
      : (typeof message === 'string' ? h('p.confirm-message', message) : message);
    modal({
      title,
      content,
      class: 'modal-confirm',
      actions: [
        { label: cancelLabel, variant: 'secondary', autofocus: danger, onClick: () => { result = false; } },
        { label: confirmLabel, variant: danger ? 'danger' : 'primary', autofocus: !danger, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}
