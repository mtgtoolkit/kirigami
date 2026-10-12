'use strict';

/**
 * Sandboxed preload: exposes `window.scm` (spec §6).
 *
 * Rules: CommonJS, only require('electron'); no Buffer / setImmediate / timers / events (removed
 * from sandboxed preloads in Electron 45). Every method returns a Promise (ipcRenderer.invoke).
 * Errors carry only a message: Electron's "Error invoking remote method '…': Error: " prefix is
 * stripped, so prefixes such as "BUSY:" and "NOT_READY" stay recognizable.
 * Events: ONE ipcRenderer listener per channel fans out to a Set of callbacks; callbacks receive
 * only the payload; subscribe functions return an unsubscribe function. `app:notice` events that
 * arrive before anyone subscribed are kept (max 20) and delivered to the first subscriber.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/;
const EVENT_CHANNELS = ['jobs:event', 'settings:changed', 'cards:changed', 'app:notice'];
const BUFFERED_CHANNELS = ['app:notice'];
const MAX_BUFFERED = 20;

function cleanError(err) {
  const raw = err && typeof err.message === 'string' ? err.message : String(err);
  const message = raw.replace(REMOTE_ERROR_PREFIX, '').trim() || 'Something went wrong.';
  return new Error(message);
}

function invoke(channel, ...args) {
  let pending;
  try {
    pending = ipcRenderer.invoke(channel, ...args);
  } catch (err) {
    return Promise.reject(cleanError(err));
  }
  return pending.catch((err) => {
    throw cleanError(err);
  });
}

const listeners = new Map();
const buffers = new Map();

function dispatch(channel, payload) {
  const set = listeners.get(channel);
  if (set.size === 0) {
    const buffer = buffers.get(channel);
    if (buffer) {
      buffer.push(payload);
      if (buffer.length > MAX_BUFFERED) buffer.shift();
    }
    return;
  }
  for (const cb of Array.from(set)) {
    try {
      cb(payload);
    } catch (err) {
      console.error(`[scm] a "${channel}" listener failed:`, err);
    }
  }
}

for (const channel of EVENT_CHANNELS) {
  listeners.set(channel, new Set());
  if (BUFFERED_CHANNELS.includes(channel)) buffers.set(channel, []);
  ipcRenderer.on(channel, (_event, payload) => dispatch(channel, payload));
}

function subscribe(channel, cb) {
  if (!EVENT_CHANNELS.includes(channel)) throw new TypeError(`Unknown event "${channel}"`);
  if (typeof cb !== 'function') throw new TypeError(`"${channel}" needs a callback function`);
  const set = listeners.get(channel);
  set.add(cb);
  const buffer = buffers.get(channel);
  if (buffer && buffer.length) {
    const pending = buffer.splice(0, buffer.length);
    Promise.resolve().then(() => {
      for (const payload of pending) {
        if (!set.has(cb)) return;
        try {
          cb(payload);
        } catch (err) {
          console.error(`[scm] a "${channel}" listener failed:`, err);
        }
      }
    });
  }
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    set.delete(cb);
  };
}

const scm = {
  app: {
    info: () => invoke('app:info'),
    onNotice: (cb) => subscribe('app:notice', cb),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    reset: () => invoke('settings:reset'),
    onChanged: (cb) => subscribe('settings:changed', cb),
  },
  env: {
    status: (opts = {}) => invoke('env:status', opts),
    setup: (opts = {}) => invoke('env:setup', opts),
    usePython: (exePathOrNull) => invoke('env:usePython', exePathOrNull === undefined ? null : exePathOrNull),
    useAppVenv: () => invoke('env:useAppVenv'),
    setWorkspace: (dirOrNull) => invoke('env:setWorkspace', dirOrNull === undefined ? null : dirOrNull),
  },
  engine: {
    introspect: (opts = {}) => invoke('engine:introspect', opts),
  },
  decklists: {
    list: () => invoke('decklists:list'),
    read: (name) => invoke('decklists:read', name),
    write: (name, text, opts = { keepBoth: true }) => invoke('decklists:write', name, text, opts),
    remove: (name) => invoke('decklists:remove', name),
  },
  cards: {
    list: (kind) => invoke('cards:list', kind),
    summary: () => invoke('cards:summary'),
    add: (kind, absPaths) => invoke('cards:add', kind, absPaths),
    remove: (kind, rels) => invoke('cards:remove', kind, rels),
    clear: (kind, opts = {}) => invoke('cards:clear', kind, opts),
    duplicate: (kind, rel, copies = 1) => invoke('cards:duplicate', kind, rel, copies),
    fixCollisions: (kind) => invoke('cards:fixCollisions', kind),
    setBack: (back) => invoke('cards:setBack', back),
    setPartnerBack: (frontRel, absPath) => invoke('cards:setPartnerBack', frontRel, absPath),
    removePartnerBack: (frontRel) => invoke('cards:removePartnerBack', frontRel),
    trashList: () => invoke('cards:trashList'),
    restore: (batchId) => invoke('cards:restore', batchId),
    emptyTrash: () => invoke('cards:emptyTrash'),
    loadSamples: (opts = {}) => invoke('cards:loadSamples', opts),
    openFolder: (kind) => invoke('cards:openFolder', kind),
    onChanged: (cb) => subscribe('cards:changed', cb),
  },
  fetch: {
    start: (req) => invoke('fetch:start', req),
  },
  upscayl: {
    status: (opts = {}) => invoke('upscayl:status', opts),
    locate: (pathOrNull) => invoke('upscayl:locate', pathOrNull === undefined ? null : pathOrNull),
    setCustomModelsDir: (dirOrNull) => invoke('upscayl:setCustomModelsDir', dirOrNull === undefined ? null : dirOrNull),
    detectGpus: () => invoke('upscayl:detectGpus'),
    start: (opts = {}) => invoke('upscayl:start', opts),
    preview: (card) => invoke('upscayl:preview', card),
    cacheInfo: () => invoke('upscayl:cacheInfo'),
    clearCache: () => invoke('upscayl:clearCache'),
  },
  pdf: {
    plan: (options) => invoke('pdf:plan', options),
    start: (options) => invoke('pdf:start', options),
  },
  offset: {
    get: () => invoke('offset:get'),
    save: (value) => invoke('offset:save', value),
    reset: () => invoke('offset:reset'),
    calibration: (paper) => invoke('offset:calibration', paper),
    generateCalibration: (paper) => invoke('offset:generateCalibration', paper),
    shiftedCalibration: (req) => invoke('offset:shiftedCalibration', req),
    apply: (req) => invoke('offset:apply', req),
    pdfInfo: (pdfPath) => invoke('offset:pdfInfo', pdfPath),
  },
  print: {
    info: () => invoke('print:info'),
    openTemplate: (templateFile) => invoke('print:openTemplate', templateFile),
  },
  jobs: {
    active: () => invoke('jobs:active'),
    history: () => invoke('jobs:history'),
    cancel: (jobId) => invoke('jobs:cancel', jobId),
    log: (jobId) => invoke('jobs:log', jobId),
    onEvent: (cb) => subscribe('jobs:event', cb),
  },
  shell: {
    openPath: (p) => invoke('shell:openPath', p),
    showItemInFolder: (p) => invoke('shell:showItemInFolder', p),
    openExternal: (url) => invoke('shell:openExternal', url),
  },
  dialog: {
    openFiles: (opts = {}) => invoke('dialog:openFiles', opts),
    openFile: (opts = {}) => invoke('dialog:openFile', opts),
    openFolder: (opts = {}) => invoke('dialog:openFolder', opts),
    saveFile: (opts = {}) => invoke('dialog:saveFile', opts),
  },
  files: {
    /** Absolute path of a dropped/selected File; '' for items without a file on disk (e.g. dragged from a browser). */
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || '';
      } catch {
        return '';
      }
    },
  },
  /** Generic subscription for any of the event channels; returns an unsubscribe function. */
  on: (channel, cb) => subscribe(channel, cb),
};

contextBridge.exposeInMainWorld('scm', scm);
