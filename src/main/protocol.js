'use strict';

/**
 * `scm-img://` protocol: serves local card images to the sandboxed renderer (spec §9.11).
 * Only files inside `<workspace>/game/` and `<scmCacheDir>/preview/` are served; everything else
 * (other folders, UNC/device paths, non-images, folders, missing files) gets a 404.
 */

const path = require('node:path');
const fsp = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { protocol, net } = require('electron');
const { SCHEME, parseImageUrl, isImageExtension, sniffImageMime } = require('./img-url');
const { isInside, samePath } = require('./util');

let schemesRegistered = false;

/**
 * Register `scm-img` as a privileged scheme. Must run at module top level of main.js, before the
 * app is ready (Electron allows a single call).
 */
function registerPrivilegedSchemes() {
  if (schemesRegistered) return;
  schemesRegistered = true;
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

function allowedRoots(deps) {
  const p = deps.getPaths();
  return [path.join(p.workspaceDir, 'game'), p.previewDir || path.join(p.scmCacheDir, 'preview')];
}

async function readHead(abs, bytes) {
  const handle = await fsp.open(abs, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Handle one `scm-img` request (exported for diagnostics).
 * @param {Request} request
 * @param {object} deps app deps (getPaths, logger)
 * @returns {Promise<Response>}
 */
async function handleImageRequest(request, deps) {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405 });
    }
    const abs = parseImageUrl(request.url);
    const roots = allowedRoots(deps);
    if (!roots.some((root) => isInside(root, abs) && !samePath(root, abs))) {
      if (deps.logger) deps.logger.warn(`scm-img: refused a file outside the card folders: ${abs}`);
      return notFound();
    }
    const st = await fsp.stat(abs);
    if (!st.isFile()) return notFound();
    if (isImageExtension(abs)) {
      return await net.fetch(pathToFileURL(abs).href);
    }
    // Images without an image extension (the engine detects images by content): sniff the header.
    const mime = sniffImageMime(await readHead(abs, 64));
    if (!mime) return notFound();
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-type': mime } });
    const body = await fsp.readFile(abs);
    return new Response(body, { status: 200, headers: { 'content-type': mime, 'content-length': String(body.length) } });
  } catch {
    // net.fetch rejects (instead of resolving 404) for missing files; invalid URLs throw too.
    return notFound();
  }
}

/**
 * Install the `scm-img` handler on the default session (after app ready).
 * @param {object} deps needs `getPaths()`; `logger` optional
 */
function registerImageProtocol(deps) {
  if (protocol.isProtocolHandled(SCHEME)) protocol.unhandle(SCHEME);
  protocol.handle(SCHEME, (request) => handleImageRequest(request, deps));
}

module.exports = { registerPrivilegedSchemes, registerImageProtocol, handleImageRequest };
