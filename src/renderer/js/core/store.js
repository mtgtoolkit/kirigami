/**
 * Tiny key/value store with per-key subscriptions (spec §8.2), plus the pure reducers that turn
 * `jobs:event` payloads (spec §5.1) into the `job` store entry.
 *
 * Store keys used by the app shell (js/main.js):
 * - `settings`      full settings object (spec §4)
 * - `env`           result of scm.env.status()
 * - `introspection` result of scm.engine.introspect() or null
 * - `introspectionStatus` `{ state: 'idle'|'loading'|'ready'|'error', error: string|null }`
 * - `cards`         `{ summary: Summary|null, version: number }` — version increments on every change
 * - `job`           active (or last finished) job, see {@link jobFromStarted}
 * - `jobs`          job history summaries, newest first
 * - `appInfo`       result of scm.app.info()
 * - `lastResults`   `{ [kind]: { jobId, title, status, result, error, warnings, at } }`
 * - `route`         `{ id, params }` of the current view
 *
 * No DOM access: importable from Node unit tests.
 *
 * @module core/store
 */

/**
 * @callback Subscriber
 * @param {*} value new value
 * @param {*} previous previous value
 * @param {string} key the key that changed
 */

/**
 * @typedef {object} Store
 * @property {(key: string) => any} get
 * @property {(key: string, value: any) => any} set Sets and notifies; returns the value.
 * @property {(key: string, fn: (previous: any) => any) => any} update Sets `fn(previous)`.
 * @property {(key: string, cb: Subscriber, options?: { immediate?: boolean }) => () => void} subscribe
 *   Subscribe to one key, or to `'*'` for every change. Returns the unsubscribe function.
 * @property {() => Record<string, any>} snapshot Plain object copy of all keys (debugging).
 */

/**
 * Create a store.
 *
 * Notification rules: subscribers run synchronously, in subscription order. Setting a primitive to
 * the identical value is a no-op; setting an object always notifies (so in-place mutation followed
 * by `set` works). A throwing subscriber never stops the others: its error is re-thrown
 * asynchronously so it still shows up in the console / e2e page-error checks.
 *
 * @param {Record<string, any>} [initial]
 * @param {{ onError?: (err: unknown, key: string) => void }} [options] `onError` receives subscriber
 *   errors (default: re-throw asynchronously).
 * @returns {Store}
 */
export function createStore(initial = {}, { onError } = {}) {
  const state = new Map(Object.entries(initial || {}));
  /** @type {Map<string, Set<Subscriber>>} */
  const subscribers = new Map();

  function notify(key, value, previous) {
    for (const k of [key, '*']) {
      const set = subscribers.get(k);
      if (!set || set.size === 0) continue;
      for (const cb of [...set]) {
        if (!set.has(cb)) continue; // unsubscribed by an earlier subscriber
        try {
          cb(value, previous, key);
        } catch (err) {
          if (typeof onError === 'function') onError(err, key);
          else queueMicrotask(() => { throw err; });
        }
      }
    }
  }

  function set(key, value) {
    if (typeof key !== 'string' || !key) throw new TypeError('store.set: key must be a non-empty string');
    const previous = state.get(key);
    state.set(key, value);
    const isObject = value !== null && typeof value === 'object';
    if (!isObject && Object.is(previous, value)) return value;
    notify(key, value, previous);
    return value;
  }

  return {
    get(key) {
      return state.get(key);
    },
    set,
    update(key, fn) {
      if (typeof fn !== 'function') throw new TypeError('store.update: fn must be a function');
      return set(key, fn(state.get(key)));
    },
    subscribe(key, cb, { immediate = false } = {}) {
      if (typeof cb !== 'function') throw new TypeError('store.subscribe: callback must be a function');
      let set = subscribers.get(key);
      if (!set) {
        set = new Set();
        subscribers.set(key, set);
      }
      set.add(cb);
      if (immediate) cb(state.get(key), undefined, key);
      return () => {
        set.delete(cb);
      };
    },
    snapshot() {
      return Object.fromEntries(state);
    },
  };
}

/** Maximum number of log lines kept in the `job` store entry. */
export const MAX_JOB_LOG_LINES = 1000;

/**
 * @typedef {object} JobState
 * @property {string} jobId
 * @property {string|null} kind
 * @property {string} title
 * @property {Array<{ id: string, label: string, status: string }>} steps
 * @property {{ percent: number|null, current: number|null, total: number|null, label: string|null }|null} progress
 * @property {Array<{ stream: string, line: string, ts?: number }>} logLines last ≤1000 lines
 * @property {number} logTotal total number of lines ever received (lets renderers append only new ones)
 * @property {'running'|'succeeded'|'failed'|'cancelled'} status
 * @property {*} result
 * @property {{ message: string, details?: string, code?: string }|null} error
 * @property {string[]} warnings
 * @property {number|null} startedAt
 * @property {number|null} endedAt
 * @property {number|null} durationMs
 * @property {boolean} dismissed user dismissed the finished status in the activity bar
 * @property {boolean} [needsSync] state was created from a partial event; re-sync with scm.jobs.active()
 */

/**
 * Normalize a step list from an event or summary.
 * @param {unknown} steps
 * @returns {Array<{ id: string, label: string, status: string }>}
 */
function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps
    .filter((s) => s && (typeof s === 'object' || typeof s === 'string'))
    .map((s) => (typeof s === 'string'
      ? { id: s, label: s, status: 'pending' }
      : { id: String(s.id ?? s.label ?? ''), label: String(s.label ?? s.id ?? ''), status: String(s.status || 'pending') }));
}

/**
 * Normalize warnings to plain strings (main may send strings or `{ message }` objects).
 * @param {unknown} warnings
 * @returns {string[]}
 */
export function normalizeWarnings(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((w) => (typeof w === 'string' ? w : (w && typeof w === 'object' ? String(w.message ?? w.text ?? '') : '')))
    .filter(Boolean);
}

/**
 * Build a fresh running job state from a `started` event.
 * @param {object} evt
 * @returns {JobState}
 */
export function jobFromStarted(evt) {
  return {
    jobId: String(evt.jobId),
    kind: evt.kind ?? null,
    title: evt.title || 'Working…',
    steps: normalizeSteps(evt.steps),
    progress: null,
    logLines: [],
    logTotal: 0,
    status: 'running',
    result: null,
    error: null,
    warnings: [],
    startedAt: Number.isFinite(evt.startedAt) ? evt.startedAt : Date.now(),
    endedAt: null,
    durationMs: null,
    dismissed: false,
  };
}

/**
 * Build a job state from a summary returned by `scm.jobs.active()` / `history()`. Field names are
 * read defensively (`jobId` or `id`).
 *
 * @param {object|null} summary
 * @param {string} [logText] optional full log (from scm.jobs.log) to seed `logLines`.
 * @returns {JobState|null}
 */
export function jobFromSummary(summary, logText) {
  if (!summary || typeof summary !== 'object') return null;
  const jobId = summary.jobId ?? summary.id;
  if (jobId === undefined || jobId === null) return null;
  const status = ['running', 'succeeded', 'failed', 'cancelled'].includes(summary.status) ? summary.status : 'running';
  const lines = typeof logText === 'string' && logText
    ? logText.split(/\r\n|\n|\r/).filter((l, i, arr) => !(i === arr.length - 1 && l === '')).map((line) => ({ stream: 'info', line }))
    : [];
  const progress = summary.progress && typeof summary.progress === 'object'
    ? {
      percent: Number.isFinite(summary.progress.percent) ? summary.progress.percent : null,
      current: summary.progress.current ?? null,
      total: summary.progress.total ?? null,
      label: summary.progress.label ?? null,
    }
    : null;
  return {
    jobId: String(jobId),
    kind: summary.kind ?? null,
    title: summary.title || 'Working…',
    steps: normalizeSteps(summary.steps),
    progress,
    logLines: lines.slice(-MAX_JOB_LOG_LINES),
    logTotal: lines.length,
    status,
    result: summary.result ?? null,
    error: summary.error ?? null,
    warnings: normalizeWarnings(summary.warnings),
    startedAt: Number.isFinite(summary.startedAt) ? summary.startedAt : null,
    endedAt: Number.isFinite(summary.endedAt) ? summary.endedAt : null,
    durationMs: Number.isFinite(summary.durationMs) ? summary.durationMs : null,
    dismissed: false,
  };
}

/**
 * Pure reducer: apply one `jobs:event` payload to the current job state.
 *
 * - `started` always replaces the state.
 * - Events for another (unknown) job create a placeholder marked `needsSync: true`, so the shell can
 *   fetch the title/steps with `scm.jobs.active()` (happens after a renderer reload).
 * - `log` appends and keeps the last `maxLines` lines; `logTotal` counts every line ever received.
 *
 * @param {JobState|null} prev
 * @param {object} evt `{ type: 'started'|'step'|'progress'|'log'|'finished', jobId, ... }`
 * @param {{ maxLines?: number }} [options]
 * @returns {JobState|null} the new state (a new object whenever something changed).
 */
export function reduceJobEvent(prev, evt, { maxLines = MAX_JOB_LOG_LINES } = {}) {
  if (!evt || typeof evt !== 'object' || evt.jobId === undefined || evt.jobId === null) return prev;
  if (evt.type === 'started') return jobFromStarted(evt);
  const jobId = String(evt.jobId);
  let job = prev;
  if (!job || job.jobId !== jobId) {
    job = { ...jobFromStarted({ jobId, kind: evt.kind ?? null, title: evt.title }), startedAt: null, needsSync: true };
  }
  switch (evt.type) {
    case 'step': {
      const stepId = String(evt.stepId ?? '');
      const exists = job.steps.some((s) => s.id === stepId);
      const steps = exists
        ? job.steps.map((s) => (s.id === stepId ? { ...s, status: String(evt.status || s.status), label: evt.label || s.label } : s))
        : [...job.steps, { id: stepId, label: evt.label || stepId, status: String(evt.status || 'running') }];
      return { ...job, steps };
    }
    case 'progress':
      return {
        ...job,
        progress: {
          percent: Number.isFinite(evt.percent) ? Math.max(0, Math.min(100, evt.percent)) : null,
          current: Number.isFinite(evt.current) ? evt.current : null,
          total: Number.isFinite(evt.total) ? evt.total : null,
          label: evt.label ?? null,
        },
      };
    case 'log': {
      const incoming = Array.isArray(evt.lines)
        ? evt.lines
          .filter((l) => l && (typeof l === 'object' || typeof l === 'string'))
          .map((l) => (typeof l === 'string' ? { stream: 'info', line: l } : { stream: l.stream || 'info', line: String(l.line ?? ''), ts: l.ts }))
        : [];
      if (incoming.length === 0) return job;
      const merged = job.logLines.concat(incoming);
      return {
        ...job,
        logLines: merged.length > maxLines ? merged.slice(merged.length - maxLines) : merged,
        logTotal: job.logTotal + incoming.length,
      };
    }
    case 'finished': {
      const status = ['succeeded', 'failed', 'cancelled'].includes(evt.status) ? evt.status : 'failed';
      return {
        ...job,
        kind: evt.kind ?? job.kind,
        status,
        result: evt.result ?? null,
        error: evt.error ?? null,
        warnings: normalizeWarnings(evt.warnings),
        endedAt: Number.isFinite(evt.endedAt) ? evt.endedAt : Date.now(),
        durationMs: Number.isFinite(evt.durationMs) ? evt.durationMs : null,
        dismissed: false,
      };
    }
    default:
      return job;
  }
}

/**
 * The step currently running (or the last non-pending one), for labels like "Step 2 of 4".
 * @param {JobState|null} job
 * @returns {{ step: object|null, index: number, total: number }}
 */
export function currentStep(job) {
  const steps = job?.steps || [];
  let index = steps.findIndex((s) => s.status === 'running' || s.status === 'active');
  if (index === -1 && job?.status === 'running') {
    index = steps.findIndex((s) => s.status === 'pending');
  }
  return { step: index >= 0 ? steps[index] : null, index, total: steps.length };
}
