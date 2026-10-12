'use strict';

/**
 * locks.js — coordination between Python users (spec §5.2). No Electron, no I/O.
 *
 * - Shared lock: helper runs (introspect, env-check, prepare-upscale, …) may overlap freely.
 * - Exclusive lock: environment setup/repair. It waits for running shared holders to finish, then
 *   runs alone; exclusive callers queue in FIFO order.
 * - While an exclusive holder is running OR waiting, new shared callers are rejected immediately
 *   with Error('Setting up the card maker components…') (code 'PYTHON_SETUP') instead of piling up
 *   behind a multi-minute install.
 *
 * Card/decklist mutations use a different rule (spec §5.2): they throw
 * Error('BUSY: wait until "<title>" finishes') while jobs.isMutating() — see assertNotMutating().
 */

const SETUP_IN_PROGRESS_MESSAGE = 'Setting up the card maker components…';

/**
 * Build the error thrown by mutations while a mutating job runs.
 * @param {string} title title of the running job
 * @returns {Error & { code: 'BUSY' }}
 */
function busyError(title) {
  const err = new Error(`BUSY: wait until "${title || 'the current task'}" finishes`);
  err.code = 'BUSY';
  return err;
}

/**
 * Throw busyError() when `jobs.isMutating()` (setup, fetch, upscale, pdf, offset, calibration).
 * @param {{ isMutating(): boolean, active(): ({ title: string }|null) }} jobs a JobManager
 */
function assertNotMutating(jobs) {
  if (jobs && typeof jobs.isMutating === 'function' && jobs.isMutating()) {
    const active = typeof jobs.active === 'function' ? jobs.active() : null;
    throw busyError(active && active.title);
  }
}

/**
 * Create the Python shared/exclusive lock.
 * @returns {{
 *   withPythonShared<T>(fn: () => T|Promise<T>): Promise<T>,
 *   withPythonExclusive<T>(fn: () => T|Promise<T>): Promise<T>,
 *   pythonBusy(): boolean,
 *   state(): { shared: number, exclusive: boolean, pending: number }
 * }}
 *   pythonBusy() is true while an exclusive holder runs or waits (i.e. exactly when
 *   withPythonShared would reject).
 */
function createLocks() {
  let shared = 0;
  let exclusiveActive = false;
  const exclusiveQueue = [];

  const exclusiveHeldOrPending = () => exclusiveActive || exclusiveQueue.length > 0;

  function pump() {
    if (exclusiveActive || shared > 0 || exclusiveQueue.length === 0) return;
    const next = exclusiveQueue.shift();
    exclusiveActive = true;
    // Release BEFORE settling the caller's promise, so that code continuing after
    // `await withPythonExclusive(...)` can immediately take the shared lock.
    Promise.resolve()
      .then(() => next.fn())
      .then(
        (value) => {
          exclusiveActive = false;
          pump();
          next.resolve(value);
        },
        (err) => {
          exclusiveActive = false;
          pump();
          next.reject(err);
        },
      );
  }

  async function withPythonShared(fn) {
    if (typeof fn !== 'function') throw new TypeError('withPythonShared: fn must be a function');
    if (exclusiveHeldOrPending()) {
      const err = new Error(SETUP_IN_PROGRESS_MESSAGE);
      err.code = 'PYTHON_SETUP';
      throw err;
    }
    shared += 1;
    try {
      return await fn();
    } finally {
      shared -= 1;
      pump();
    }
  }

  function withPythonExclusive(fn) {
    if (typeof fn !== 'function') return Promise.reject(new TypeError('withPythonExclusive: fn must be a function'));
    return new Promise((resolve, reject) => {
      exclusiveQueue.push({ fn, resolve, reject });
      pump();
    });
  }

  return {
    withPythonShared,
    withPythonExclusive,
    pythonBusy: () => exclusiveHeldOrPending(),
    state: () => ({ shared, exclusive: exclusiveActive, pending: exclusiveQueue.length }),
  };
}

module.exports = {
  createLocks,
  busyError,
  assertNotMutating,
  SETUP_IN_PROGRESS_MESSAGE,
};
