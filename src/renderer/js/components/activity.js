/**
 * Bottom activity bar (spec §8.5).
 *
 * - idle: "Ready";
 * - running: title, current step, progress bar, elapsed time, Stop (with confirmation);
 * - finished: status + message, persists until dismissed or the next job starts, plus quick actions
 *   (Open PDF, See your cards…);
 * - "Details" drawer (max 40vh): live log (monospace, auto-scrolls unless the user scrolled up,
 *   stderr tinted, warnings/errors coloured, batches appended without re-rendering), Copy log,
 *   Open logs folder, and the job history (view any past job's log).
 *
 * Reads the `job`, `jobs` and `appInfo` store keys (see core/store.js); never mutates job state
 * except setting `dismissed`.
 *
 * @module components/activity
 */

import {
  h, icon, button, badge, progressBar, spinner, confirmDialog, toast, copyText, tabs, uid, showError,
} from '../core/ui.js';
import * as defaultFormat from '../core/format.js';
import { currentStep } from '../core/store.js';

/** Friendly names per job kind (spec §5.1 kinds). */
export const JOB_KIND_LABELS = Object.freeze({
  setup: 'Setup',
  fetch: 'Get cards',
  upscale: 'Upscale',
  pdf: 'Make PDF',
  offset: 'Printer alignment',
  calibration: 'Calibration sheet',
  preview: 'Upscale preview',
  probe: 'Graphics card check',
  samples: 'Sample cards',
  engine: 'Card maker engine update',
});

/** Icon per job kind. */
export const JOB_KIND_ICONS = Object.freeze({
  setup: 'package',
  fetch: 'download',
  upscale: 'sparkles',
  pdf: 'file-pdf',
  offset: 'crosshair',
  calibration: 'crosshair',
  preview: 'sparkles',
  probe: 'cpu',
  samples: 'layers',
  engine: 'arrow-up-circle',
});

const MAX_DOM_LINES = 1000;

/**
 * CSS modifier for a log line.
 * @param {{ stream?: string, line?: string }} entry
 * @returns {string}
 */
function lineTone(entry) {
  const stream = String(entry.stream || 'info').toLowerCase();
  if (stream === 'error') return 'log-error';
  if (stream === 'warn' || stream === 'warning') return 'log-warn';
  const text = String(entry.line || '');
  if (/^\s*(Error:|Traceback \(most recent call last\)|[A-Za-z_.]*(Error|Exception):)/.test(text)) return 'log-error';
  if (/^\s*(Warning|WARNING)\b/.test(text)) return 'log-warn';
  if (stream === 'stderr') return 'log-stderr';
  return 'log-info';
}

/**
 * Mount the activity bar into `el`.
 * @param {HTMLElement} el
 * @param {{ store: import('../core/store.js').Store, api?: any, format?: any, navigate?: (id: string, params?: object) => void }} ctx
 * @returns {() => void} unmount
 */
export function mountActivityBar(el, ctx = {}) {
  const { store, api } = ctx;
  if (!store) throw new TypeError('mountActivityBar: ctx.store is required');
  const fmt = ctx.format || defaultFormat;
  const navigate = typeof ctx.navigate === 'function' ? ctx.navigate : null;

  const drawerId = uid('activity-drawer');
  const drawer = h('div.activity-drawer', { id: drawerId, hidden: true, role: 'region', attrs: { 'aria-label': 'Activity details' } });
  const bar = h('div.activity-bar');
  const announcer = h('div.sr-only', { attrs: { 'aria-live': 'polite' } });
  el.classList.add('activity');
  el.replaceChildren(drawer, bar, announcer);

  let drawerOpen = false;
  let drawerTab = 'log';
  /** @type {{ jobId: string, title: string, text: string, at: number|null }|null} */
  let viewing = null;
  let barKey = '';
  let lastAnnounceKey = '';
  let elapsedTimer = null;
  let pendingFrame = 0;
  let pendingTimeout = 0;
  let stopping = false;
  let historyVersion = 0;
  /** @type {Record<string, any>} */
  let refs = {};

  // Drawer skeleton (built once).
  const logEl = h('div.log', { role: 'log', tabIndex: 0, attrs: { 'aria-label': 'Task log', 'aria-live': 'off' } });
  const jumpBtn = button({ label: 'Jump to latest', icon: 'arrow-down', size: 'sm', variant: 'secondary', class: 'log-jump', onClick: () => scrollLogToBottom() });
  jumpBtn.hidden = true;
  const logTop = h('div.log-top');
  const logPane = h('div.log-pane', logTop, h('div.log-wrap', logEl, jumpBtn));
  const historyPane = h('div.history-pane', { hidden: true });
  const tabStrip = tabs({
    ariaLabel: 'Activity details',
    tabs: [{ id: 'log', label: 'Log' }, { id: 'history', label: 'History' }],
    active: 'log',
    onChange: (id) => {
      drawerTab = id;
      renderDrawer(true);
    },
  });
  const drawerActions = h('div.drawer-actions',
    button({ label: 'Copy log', icon: 'copy', size: 'sm', variant: 'ghost', onClick: copyLog }),
    button({ label: 'Open logs folder', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: openLogsFolder }),
    button({ icon: 'chevron-down', size: 'sm', variant: 'ghost', title: 'Hide details', onClick: () => setDrawer(false) }));
  drawer.append(h('div.drawer-head', tabStrip, drawerActions), h('div.drawer-body', logPane, historyPane));

  let renderedLogJob = null;
  let renderedLogTotal = 0;
  logEl.addEventListener('scroll', () => {
    if (isLogAtBottom()) jumpBtn.hidden = true;
  });

  function isLogAtBottom() {
    return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 24;
  }
  function scrollLogToBottom() {
    logEl.scrollTop = logEl.scrollHeight;
    jumpBtn.hidden = true;
  }

  function schedule() {
    if (pendingFrame || pendingTimeout) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible' && typeof requestAnimationFrame === 'function') {
      pendingFrame = requestAnimationFrame(() => {
        pendingFrame = 0;
        render();
      });
    } else {
      pendingTimeout = setTimeout(() => {
        pendingTimeout = 0;
        render();
      }, 50);
    }
  }

  function visibleJob() {
    const job = store.get('job');
    return job && !job.dismissed ? job : null;
  }

  function render() {
    const job = visibleJob();
    const key = job ? `${job.jobId}|${job.status}|${(job.warnings || []).length}` : 'idle';
    if (key !== barKey) {
      barKey = key;
      if (!job || job.status !== 'running') stopping = false;
      buildBar(job);
      announce(job);
      if (job && job.status === 'running' && viewing) {
        viewing = null; // a new job started: show its live log
      }
    }
    updateBar(job);
    el.dataset.state = job ? job.status : 'idle';
    if (drawerOpen) renderDrawer(false);
    manageTimer(job);
  }

  function announce(job) {
    if (!job) return;
    const k = `${job.jobId}|${job.status}`;
    if (k === lastAnnounceKey) return;
    lastAnnounceKey = k;
    const title = job.title || 'Task';
    if (job.status === 'running') announcer.textContent = `${title} started.`;
    else if (job.status === 'succeeded') announcer.textContent = `${title} finished.`;
    else if (job.status === 'cancelled') announcer.textContent = `${title} was stopped.`;
    else announcer.textContent = `${title} failed. ${job.error?.message || ''}`;
  }

  function detailsButton() {
    const b = button({
      label: 'Details',
      icon: drawerOpen ? 'chevron-down' : 'chevron-up',
      size: 'sm',
      variant: 'ghost',
      attrs: { 'aria-expanded': String(drawerOpen), 'aria-controls': drawerId },
      onClick: () => setDrawer(!drawerOpen),
    });
    b.classList.add('activity-details-btn');
    return b;
  }

  function kindActions(job) {
    const r = job.result || {};
    const out = [];
    if (job.status === 'succeeded') {
      const pdfPath = r.pdfPath || r.outputPath || (job.kind === 'calibration' ? r.path : null);
      if (pdfPath && api && ['pdf', 'offset', 'calibration'].includes(job.kind)) {
        // PNG pages (pdf job with isImages): outputPath is the folder of page images.
        const isImages = job.kind === 'pdf' && r.isImages === true;
        out.push(button({
          label: job.kind === 'calibration' ? 'Open sheet' : (isImages ? 'Open folder' : 'Open PDF'),
          icon: isImages ? 'folder-open' : 'file-pdf',
          size: 'sm',
          variant: 'secondary',
          onClick: () => api.shell.openPath(pdfPath),
        }));
        if (job.kind === 'pdf' && !isImages) {
          out.push(button({ label: 'Show in folder', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => api.shell.showItemInFolder(pdfPath) }));
        }
      }
      if ((job.kind === 'fetch' || job.kind === 'samples') && navigate) {
        out.push(button({ label: 'See your cards', iconRight: 'arrow-right', size: 'sm', variant: 'secondary', onClick: () => navigate('cards') }));
      }
    } else if (job.status === 'failed' && job.kind === 'setup' && navigate) {
      out.push(button({ label: 'Open setup', size: 'sm', variant: 'secondary', onClick: () => navigate('setup') }));
    }
    return out;
  }

  function buildBar(job) {
    refs = {};
    bar.className = 'activity-bar';
    if (!job) {
      bar.classList.add('is-idle');
      const history = store.get('jobs') || [];
      bar.replaceChildren(
        h('span.activity-status.is-idle', h('span.activity-dot')),
        h('div.activity-text', h('div.activity-title', 'Ready')),
        h('div.activity-spacer'),
        h('div.activity-actions', history.length || drawerOpen ? detailsButton() : null),
      );
      return;
    }
    if (job.status === 'running') {
      bar.classList.add('is-running');
      refs.sub = h('div.activity-sub');
      refs.progress = progressBar({ percent: null, showValue: false });
      refs.pct = h('span.activity-pct');
      refs.elapsed = h('span.activity-elapsed', { title: 'Time elapsed' }, icon('clock', { size: 13 }), h('span'));
      refs.stop = button({
        label: stopping ? 'Stopping…' : 'Stop',
        icon: 'stop',
        size: 'sm',
        variant: 'secondary',
        loading: stopping,
        onClick: () => cancelJob(job),
      });
      bar.replaceChildren(
        h('span.activity-status.is-running', spinner(18, { label: 'Working' })),
        h('div.activity-text',
          h('div.activity-title', icon(JOB_KIND_ICONS[job.kind] || 'zap', { size: 14, class: 'activity-kind-icon' }), h('span', job.title || 'Working…')),
          refs.sub),
        h('div.activity-progress', refs.progress),
        h('div.activity-meta', refs.pct, refs.elapsed),
        h('div.activity-actions', detailsButton(), refs.stop),
      );
      return;
    }
    const statusMap = {
      succeeded: ['check-circle', 'is-success'],
      failed: ['x-circle', 'is-danger'],
      cancelled: ['stop', 'is-muted'],
    };
    const [statusIcon, tone] = statusMap[job.status] || statusMap.failed;
    bar.classList.add(`is-${job.status}`);
    const title = job.title || JOB_KIND_LABELS[job.kind] || 'Task';
    let headline;
    let sub;
    if (job.status === 'succeeded') {
      headline = `${title} finished`;
      sub = job.durationMs !== null && job.durationMs !== undefined ? `Done in ${fmt.formatDuration(job.durationMs)}` : 'Done';
    } else if (job.status === 'cancelled') {
      headline = `${title} was stopped`;
      sub = 'Nothing else will change. You can start it again any time.';
    } else {
      headline = `${title} failed`;
      sub = job.error?.message || 'Open Details to see what happened.';
    }
    const warnCount = (job.warnings || []).length;
    const warnBadge = warnCount
      ? h('button', { type: 'button', class: 'activity-warn-btn', title: 'Show warnings', onClick: () => setDrawer(true, 'log') },
        badge(fmt.pluralize(warnCount, 'warning'), 'warning', { icon: 'alert-triangle' }))
      : null;
    bar.replaceChildren(
      h('span', { class: ['activity-status', tone] }, icon(statusIcon, { size: 18 })),
      h('div.activity-text',
        h('div.activity-title', h('span', headline), warnBadge),
        h('div.activity-sub', { title: typeof sub === 'string' ? sub : undefined }, sub)),
      h('div.activity-spacer'),
      h('div.activity-actions',
        ...kindActions(job),
        detailsButton(),
        button({ icon: 'x', size: 'sm', variant: 'ghost', title: 'Dismiss', onClick: dismiss })),
    );
  }

  function updateBar(job) {
    if (!job || job.status !== 'running' || !refs.progress) return;
    const { step, index, total } = currentStep(job);
    const stepText = step ? (total > 1 ? `Step ${index + 1} of ${total}: ${step.label}` : step.label) : '';
    const progressLabel = job.progress?.label || '';
    const sub = [stepText, progressLabel].filter(Boolean).join(' · ') || 'Working…';
    if (refs.sub.textContent !== sub) {
      refs.sub.textContent = sub;
      refs.sub.title = sub;
    }
    const pct = job.progress?.percent;
    refs.progress.update(Number.isFinite(pct) ? pct : null, sub);
    refs.pct.textContent = Number.isFinite(pct) ? `${pct >= 100 ? 100 : Math.min(99, Math.round(pct))}%` : '';
    updateElapsed(job);
  }

  function updateElapsed(job) {
    if (!refs.elapsed || !job?.startedAt) {
      if (refs.elapsed) refs.elapsed.hidden = true;
      return;
    }
    refs.elapsed.hidden = false;
    refs.elapsed.lastChild.textContent = fmt.formatClock(Date.now() - job.startedAt);
  }

  function manageTimer(job) {
    const running = job && job.status === 'running';
    if (running && !elapsedTimer) {
      elapsedTimer = setInterval(() => updateElapsed(visibleJob()), 1000);
    } else if (!running && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  async function cancelJob(job) {
    const ok = await confirmDialog({
      title: `Stop “${job.title || 'this task'}”?`,
      message: 'The task stops right away. Files that were already finished are kept; you can start it again later.',
      confirmLabel: 'Stop',
      cancelLabel: 'Keep going',
      danger: true,
    });
    if (!ok || !api) return;
    const live = visibleJob();
    if (!live || live.jobId !== job.jobId || live.status !== 'running') return;
    stopping = true;
    refs.stop?.setLoading(true);
    refs.stop?.setLabel('Stopping…');
    try {
      const res = await api.jobs.cancel(job.jobId);
      if (res === false) {
        stopping = false;
        refs.stop?.setLoading(false);
        refs.stop?.setLabel('Stop');
        toast({ variant: 'warning', title: 'This task could not be stopped', message: 'It may already be finishing.' });
      }
    } catch (err) {
      stopping = false;
      refs.stop?.setLoading(false);
      refs.stop?.setLabel('Stop');
      showError(err, { title: 'Could not stop the task' });
    }
  }

  function dismiss() {
    store.update('job', (j) => (j ? { ...j, dismissed: true } : j));
  }

  function setDrawer(open, tab) {
    const active = document.activeElement;
    // Keep keyboard focus on the toggle (it is rebuilt) or move it there when the drawer closes
    // while focus was inside it.
    const refocus = !!active && (active.classList?.contains('activity-details-btn') || (!open && drawer.contains(active)));
    drawerOpen = !!open;
    if (tab) {
      drawerTab = tab;
      tabStrip.setActive(tab);
    }
    drawer.hidden = !drawerOpen;
    el.classList.toggle('is-open', drawerOpen);
    barKey = ''; // rebuild the bar (Details button state)
    render();
    if (drawerOpen) {
      renderDrawer(true);
      if (drawerTab === 'log') scrollLogToBottom();
    }
    if (refocus) bar.querySelector('.activity-details-btn')?.focus({ preventScroll: true });
  }

  function renderDrawer(full) {
    tabStrip.setBadge('history', (store.get('jobs') || []).length || null);
    logPane.hidden = drawerTab !== 'log';
    historyPane.hidden = drawerTab !== 'history';
    if (drawerTab === 'history') {
      if (full || historyPane.dataset.version !== String(historyVersion)) renderHistory();
      return;
    }
    if (viewing) {
      if (full || renderedLogJob !== `history:${viewing.jobId}`) renderViewedLog();
      return;
    }
    renderCurrentLog(full);
  }

  function lineEl(entry) {
    return h('div', { class: ['log-line', lineTone(entry)] }, entry.line === '' ? ' ' : entry.line);
  }

  function renderLogTop(job) {
    const parts = [];
    if (viewing) {
      parts.push(h('div.log-banner',
        icon('history', { size: 14 }),
        h('span', 'Showing the log of ', h('strong', viewing.title), viewing.at ? ` (${fmt.formatDate(viewing.at)})` : ''),
        button({
          label: 'Back to current',
          size: 'sm',
          variant: 'link',
          onClick: () => {
            viewing = null;
            renderedLogJob = null;
            renderDrawer(true);
            scrollLogToBottom();
          },
        })));
    } else if (job && job.status !== 'running') {
      const warnings = job.warnings || [];
      if (warnings.length) {
        parts.push(h('div.log-notes.is-warning',
          h('div.log-notes-title', icon('alert-triangle', { size: 14 }), fmt.pluralize(warnings.length, 'warning')),
          h('ul', warnings.map((w) => h('li', w)))));
      }
      if (job.status === 'failed' && job.error) {
        parts.push(h('div.log-notes.is-danger',
          h('div.log-notes-title', icon('x-circle', { size: 14 }), job.error.message || 'The task failed'),
          job.error.details ? h('details', h('summary', 'Technical details'), h('pre', String(job.error.details))) : null));
      }
    }
    logTop.replaceChildren(...parts);
    logTop.hidden = parts.length === 0;
  }

  function renderCurrentLog(full) {
    const job = store.get('job');
    const topKey = job ? `${job.jobId}|${job.status}|${(job.warnings || []).length}` : 'none';
    if (full || logTop.dataset.key !== topKey) {
      renderLogTop(job);
      logTop.dataset.key = topKey;
    }
    if (!job) {
      logEl.replaceChildren(h('div.log-empty', 'Nothing has run yet. When the app works on something, its progress shows up here.'));
      renderedLogJob = null;
      renderedLogTotal = 0;
      return;
    }
    const lines = job.logLines || [];
    const total = job.logTotal ?? lines.length;
    const newCount = total - renderedLogTotal;
    const atBottom = isLogAtBottom();
    if (full || renderedLogJob !== job.jobId || newCount < 0 || newCount > lines.length) {
      if (lines.length) logEl.replaceChildren(...lines.map(lineEl));
      else logEl.replaceChildren(h('div.log-empty', job.status === 'running' ? 'Waiting for the first messages…' : 'This task did not write anything to its log.'));
    } else if (newCount > 0) {
      logEl.querySelector('.log-empty')?.remove();
      const frag = document.createDocumentFragment();
      for (const entry of lines.slice(lines.length - newCount)) frag.append(lineEl(entry));
      logEl.append(frag);
      const excess = logEl.childElementCount - MAX_DOM_LINES;
      for (let i = 0; i < excess; i += 1) logEl.firstElementChild?.remove();
    }
    const changed = renderedLogJob !== job.jobId || newCount !== 0;
    renderedLogJob = job.jobId;
    renderedLogTotal = total;
    if (changed) {
      if (atBottom || full) scrollLogToBottom();
      else jumpBtn.hidden = false;
    }
  }

  function renderViewedLog() {
    renderLogTop(null);
    const text = viewing.text || '';
    const lines = text ? text.split(/\r\n|\n|\r/) : [];
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    logEl.replaceChildren(...(lines.length
      ? lines.slice(-5000).map((line) => lineEl({ stream: 'info', line }))
      : [h('div.log-empty', 'This log is empty.')]));
    renderedLogJob = `history:${viewing.jobId}`;
    renderedLogTotal = -1;
    logEl.scrollTop = 0;
  }

  function renderHistory() {
    const jobs = store.get('jobs') || [];
    historyPane.dataset.version = String(historyVersion);
    if (!jobs.length) {
      historyPane.replaceChildren(h('div.log-empty', 'No tasks yet.'));
      return;
    }
    const statusBadge = {
      succeeded: () => badge('Done', 'success'),
      failed: () => badge('Failed', 'danger'),
      cancelled: () => badge('Stopped', 'neutral'),
      running: () => badge('Running', 'accent'),
    };
    historyPane.replaceChildren(h('ul.history-list', jobs.map((j) => {
      const jobId = j.jobId ?? j.id;
      const title = j.title || JOB_KIND_LABELS[j.kind] || 'Task';
      const at = j.startedAt ?? j.endedAt ?? null;
      return h('li.history-item',
        h('span.history-icon', icon(JOB_KIND_ICONS[j.kind] || 'zap', { size: 16 })),
        h('div.history-text',
          h('div.history-title', title),
          h('div.history-sub', [at ? fmt.formatDate(at) : null, Number.isFinite(j.durationMs) ? fmt.formatDuration(j.durationMs) : null].filter(Boolean).join(' · '))),
        (statusBadge[j.status] || statusBadge.failed)(),
        api && jobId !== undefined && button({
          label: 'View log',
          size: 'sm',
          variant: 'ghost',
          onClick: async () => {
            const text = await api.jobs.log(jobId);
            viewing = { jobId: String(jobId), title, text: typeof text === 'string' ? text : '', at };
            drawerTab = 'log';
            tabStrip.setActive('log');
            renderDrawer(true);
          },
        }));
    })));
  }

  async function copyLog() {
    let text = '';
    try {
      if (viewing) text = viewing.text || '';
      else {
        const job = store.get('job');
        if (job && api) {
          const full = await api.jobs.log(job.jobId).catch(() => null);
          text = typeof full === 'string' && full ? full : (job.logLines || []).map((l) => l.line).join('\n');
        }
      }
    } catch {
      /* fall through */
    }
    if (!text) {
      toast({ variant: 'info', title: 'The log is empty', timeout: 2500 });
      return;
    }
    const ok = await copyText(text);
    toast({ variant: ok ? 'success' : 'warning', title: ok ? 'Log copied to the clipboard' : 'Could not copy the log', timeout: 2500 });
  }

  async function openLogsFolder() {
    const dir = store.get('appInfo')?.paths?.logs;
    if (!dir || !api) {
      toast({ variant: 'warning', title: 'The logs folder is not available yet' });
      return;
    }
    await api.shell.openPath(dir);
  }

  const unsubs = [
    store.subscribe('job', schedule),
    store.subscribe('jobs', () => {
      historyVersion += 1;
      if (!visibleJob()) barKey = '';
      schedule();
    }),
  ];
  render();

  return function unmountActivityBar() {
    for (const off of unsubs) off();
    if (pendingFrame) cancelAnimationFrame(pendingFrame);
    if (pendingTimeout) clearTimeout(pendingTimeout);
    if (elapsedTimer) clearInterval(elapsedTimer);
    el.replaceChildren();
    el.classList.remove('is-open');
  };
}

export default mountActivityBar;
