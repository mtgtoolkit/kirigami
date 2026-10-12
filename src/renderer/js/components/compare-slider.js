/**
 * Before/after comparison slider (used for the Upscale "Try on one card" preview).
 *
 * The "after" image is clipped at the handle position. Drag anywhere on the image, or focus the
 * handle (role="slider") and use ←/→ (Shift = bigger steps), PageUp/PageDown, Home/End. A zoom
 * control (Fit / 2× / 4×) helps inspect detail; both images stay aligned while panning.
 *
 * @module components/compare-slider
 */

import { h, icon, segmented } from '../core/ui.js';

/**
 * @param {object} options
 * @param {string} options.before image URL (e.g. scm-img://…)
 * @param {string} options.after image URL
 * @param {string} [options.beforeLabel] default 'Original'
 * @param {string} [options.afterLabel] default 'Upscaled'
 * @param {unknown} [options.beforeCaption] e.g. '745 × 1040 px · 1.2 MB'
 * @param {unknown} [options.afterCaption]
 * @param {number} [options.initial] initial split in percent (default 50)
 * @param {string} [options.alt] alt text describing the image
 * @param {boolean} [options.zoom] show the zoom control (default true)
 * @returns {HTMLElement & { setPosition(percent: number): void }}
 */
export function compareSlider({
  before, after, beforeLabel = 'Original', afterLabel = 'Upscaled', beforeCaption, afterCaption, initial = 50, alt = '', zoom = true,
} = {}) {
  let position = clampPercent(initial);
  let zoomLevel = 1;

  const imgBefore = h('img.compare-img', { src: before, alt: alt ? `${alt} (${beforeLabel})` : beforeLabel, draggable: false, decoding: 'async' });
  const imgAfter = h('img.compare-img', { src: after, alt: alt ? `${alt} (${afterLabel})` : afterLabel, draggable: false, decoding: 'async' });
  const afterClip = h('div.compare-after', imgAfter);
  const handle = h('div', {
    class: 'compare-handle',
    role: 'slider',
    tabIndex: 0,
    attrs: { 'aria-label': `${beforeLabel} / ${afterLabel} split`, 'aria-valuemin': '0', 'aria-valuemax': '100' },
  }, h('span.compare-knob', icon('chevrons-left-right', { size: 16 })));
  const canvas = h('div.compare-canvas', imgBefore, afterClip, handle,
    h('span.compare-tag.compare-tag-before', beforeLabel),
    h('span.compare-tag.compare-tag-after', afterLabel));
  const viewport = h('div.compare-viewport', canvas);

  const apply = () => {
    afterClip.style.clipPath = `inset(0 0 0 ${position}%)`;
    handle.style.left = `${position}%`;
    handle.setAttribute('aria-valuenow', String(Math.round(position)));
    handle.setAttribute('aria-valuetext', `${Math.round(100 - position)}% ${afterLabel}`);
  };
  const setPosition = (p) => {
    position = clampPercent(p);
    apply();
  };

  const onLoad = () => {
    const w = imgAfter.naturalWidth || imgBefore.naturalWidth;
    const hgt = imgAfter.naturalHeight || imgBefore.naturalHeight;
    if (w && hgt) canvas.style.aspectRatio = `${w} / ${hgt}`;
  };
  imgAfter.addEventListener('load', onLoad);
  imgBefore.addEventListener('load', onLoad);

  let dragging = false;
  const fromEvent = (ev) => {
    const r = canvas.getBoundingClientRect();
    if (r.width > 0) setPosition(((ev.clientX - r.left) / r.width) * 100);
  };
  canvas.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    dragging = true;
    canvas.setPointerCapture(ev.pointerId);
    canvas.classList.add('is-dragging');
    fromEvent(ev);
    handle.focus({ preventScroll: true });
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (dragging) fromEvent(ev);
  });
  const stop = (ev) => {
    if (!dragging) return;
    dragging = false;
    canvas.classList.remove('is-dragging');
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* already released */
    }
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  handle.addEventListener('keydown', (ev) => {
    const step = ev.shiftKey ? 10 : 2;
    const map = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -10, PageUp: 10 };
    if (ev.key in map) {
      ev.preventDefault();
      setPosition(position + map[ev.key]);
    } else if (ev.key === 'Home') {
      ev.preventDefault();
      setPosition(0);
    } else if (ev.key === 'End') {
      ev.preventDefault();
      setPosition(100);
    }
  });

  const zoomControl = zoom ? segmented({
    size: 'sm',
    ariaLabel: 'Zoom',
    value: 1,
    options: [{ value: 1, label: 'Fit' }, { value: 2, label: '2×' }, { value: 4, label: '4×' }],
    onChange: (z) => {
      const prev = zoomLevel;
      zoomLevel = Number(z) || 1;
      const cx = (viewport.scrollLeft + viewport.clientWidth / 2) / prev;
      const cy = (viewport.scrollTop + viewport.clientHeight / 2) / prev;
      canvas.style.height = `calc(var(--compare-h) * ${zoomLevel})`;
      viewport.classList.toggle('is-zoomed', zoomLevel > 1);
      // Keep the visible centre in place.
      requestAnimationFrame(() => {
        viewport.scrollLeft = cx * zoomLevel - viewport.clientWidth / 2;
        viewport.scrollTop = cy * zoomLevel - viewport.clientHeight / 2;
      });
    },
  }) : null;

  apply();
  const el = h('div.compare',
    viewport,
    h('div.compare-footer',
      h('div.compare-caption', h('strong', beforeLabel), beforeCaption ? h('span', beforeCaption) : null),
      zoomControl,
      h('div.compare-caption.is-right', h('strong', afterLabel), afterCaption ? h('span', afterCaption) : null)));
  el.setPosition = setPosition;
  return el;
}

/**
 * @param {number} p
 * @returns {number}
 */
function clampPercent(p) {
  const n = Number(p);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

export default compareSlider;
