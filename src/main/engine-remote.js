'use strict';

/**
 * engine-remote.js — GitHub access for the Silhouette Card Maker engine. The `fetch` implementation is
 * injected (no Electron, no file system): the main process passes Electron's `net.fetch` (system proxy
 * and certificates), build scripts pass Node's global `fetch`, tests pass a fake.
 *
 * Request budget, chosen so that checking often costs nothing:
 * - lsRemote: one git protocol v2 `ls-refs` POST to github.com. It is not the REST API, so it uses no
 *   quota, and the answer is about 65 bytes. Checking for a new engine is just this.
 * - getTree / getCommit: one REST call each, only when the commit changed. Unauthenticated REST calls are
 *   limited to 60 per hour per IP address (shared by every program on the network), so a token is used
 *   when the caller has one (build scripts read GITHUB_TOKEN / GH_TOKEN; the app never needs one).
 * - downloadFile: raw.githubusercontent.com (no REST quota), one file at a time, verified against the git
 *   blob SHA-1 listed in the commit's tree (ENGINE_INTEGRITY on mismatch). The 538 MiB repository
 *   tarball is never downloaded.
 *
 * Every request has a timeout; a file download fails only when it stops receiving data (so a slow
 * connection still gets large files). Network failures, 5xx answers and damaged downloads are retried a few
 * times; rate limiting (403/429 with `x-ratelimit-remaining: 0`, or a `retry-after`) is never retried
 * here: it becomes a RATE_LIMITED error carrying `resetAt` so the caller can come back later.
 */

const { userError } = require('./errors');
const { gitBlobSha1, isRepository, isSha, isSafeRelativePath, normalizeRef } = require('./engine-files');

/** The upstream engine Kirigami follows by default. */
const DEFAULT_ENGINE_REPOSITORY = 'Alan-Cha/silhouette-card-maker';
const DEFAULT_ENGINE_REF = 'refs/heads/main';

const DEFAULT_USER_AGENT = 'Kirigami (+https://github.com/mtgtoolkit/kirigami)';
const DEFAULT_TIMEOUT_MS = 30 * 1000;
/**
 * A file download is stopped when nothing arrives for this long. Not a limit on the whole file: a slow
 * connection could never fetch a large one (a calibration PDF) within a fixed time, and would fail forever.
 */
const DEFAULT_DOWNLOAD_STALL_MS = 60 * 1000;
const DEFAULT_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 500;
/** Wait used when GitHub signals a limit without saying until when. */
const DEFAULT_RATE_LIMIT_WAIT_MS = 60 * 1000;
const MAX_PKT_LINE = 65520;

function assertRepository(repo) {
  if (!isRepository(repo)) throw new TypeError(`Invalid GitHub repository "${repo}" (expected "owner/name")`);
}

function assertCommit(sha) {
  if (!isSha(sha)) throw new TypeError(`Invalid commit "${sha}" (expected a 40-character SHA-1)`);
}

/**
 * Encode one git pkt-line: 4 hex digits giving the length (including themselves), then the payload.
 * @param {string} text
 * @returns {string}
 */
function pktLine(text) {
  const length = Buffer.byteLength(text) + 4;
  if (length > MAX_PKT_LINE) throw new RangeError('pkt-line too long');
  return length.toString(16).padStart(4, '0') + text;
}

/**
 * Decode a pkt-line stream into packets. Special packets: '0000' flush, '0001' delimiter,
 * '0002' response end. Throws BAD_RESPONSE on malformed or truncated input.
 * @param {Buffer|Uint8Array|string} input
 * @returns {Array<{type:'data', text:string}|{type:'flush'|'delim'|'end'}>}
 */
function parsePktLines(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const packets = [];
  let offset = 0;
  while (offset < buf.length) {
    const head = buf.toString('latin1', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw badResponse(`malformed pkt-line length "${head}" at byte ${offset}`);
    const length = parseInt(head, 16);
    if (length === 0) packets.push({ type: 'flush' });
    else if (length === 1) packets.push({ type: 'delim' });
    else if (length === 2) packets.push({ type: 'end' });
    else if (length < 4) throw badResponse(`invalid pkt-line length ${length} at byte ${offset}`);
    else {
      if (offset + length > buf.length) throw badResponse('truncated pkt-line');
      packets.push({ type: 'data', text: buf.toString('utf8', offset + 4, offset + length) });
    }
    offset += length < 4 ? 4 : length;
  }
  return packets;
}

/**
 * Body of a protocol v2 `ls-refs` request for one ref (GitHub matches ref-prefix by prefix, so the
 * answer is filtered by exact name in parseLsRefs).
 * @param {string} ref full ref name
 * @returns {string}
 */
function lsRefsRequestBody(ref) {
  return `${pktLine('command=ls-refs\n')}0001${pktLine(`ref-prefix ${ref}\n`)}0000`;
}

/**
 * Commit SHA of `ref` in an `ls-refs` answer, or null when the ref is not listed.
 * Lines are "<sha> <refname>[ <attributes>]"; an "ERR <message>" packet becomes an error.
 * @param {Buffer|Uint8Array|string} body
 * @param {string} ref full ref name
 * @returns {string|null}
 */
function parseLsRefs(body, ref) {
  for (const packet of parsePktLines(body)) {
    if (packet.type !== 'data') continue;
    const line = packet.text.replace(/\n$/, '');
    if (line.startsWith('ERR ')) throw badResponse(`the git server answered: ${line.slice(4)}`);
    const m = /^([0-9a-f]{40}) (\S+)(?: .*)?$/.exec(line);
    if (m && m[2] === ref) return m[1];
  }
  return null;
}

/**
 * Rate limiting signalled by a GitHub answer, or null. Primary limit: 403/429 with
 * `x-ratelimit-remaining: 0` (resets at `x-ratelimit-reset`, epoch seconds). Secondary limit: 403/429 with
 * `retry-after` (seconds). A bare 429 is treated as a limit too.
 * @param {number} status
 * @param {{get(name:string): (string|null)}} headers
 * @param {number} [now=Date.now()]
 * @returns {{resetAt:number, limit:number|null}|null}
 */
function rateLimitInfo(status, headers, now = Date.now()) {
  if (status !== 403 && status !== 429) return null;
  const header = (name) => {
    const value = headers && typeof headers.get === 'function' ? headers.get(name) : null;
    return value === null || value === undefined ? null : String(value).trim();
  };
  const limitHeader = header('x-ratelimit-limit');
  const limit = limitHeader !== null && Number.isFinite(Number(limitHeader)) ? Number(limitHeader) : null;
  const info = (resetAt) => ({ resetAt, limit });
  if (header('x-ratelimit-remaining') === '0') {
    const reset = Number(header('x-ratelimit-reset'));
    return info(Number.isFinite(reset) && reset > 0 ? reset * 1000 : now + DEFAULT_RATE_LIMIT_WAIT_MS);
  }
  const retryAfter = header('retry-after');
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return info(now + seconds * 1000);
    const date = Date.parse(retryAfter);
    if (!Number.isNaN(date)) return info(Math.max(date, now));
  }
  return status === 429 ? info(now + DEFAULT_RATE_LIMIT_WAIT_MS) : null;
}

function badResponse(detail) {
  return userError('GitHub sent an answer Kirigami could not read. Try again later.', { code: 'BAD_RESPONSE', details: detail });
}

function timeOfDay(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function rateLimitedError(what, url, limited) {
  const err = userError(`Could not ${what}: GitHub is limiting requests from this network until ${timeOfDay(limited.resetAt)}. Try again after that.`, {
    code: 'RATE_LIMITED',
    details: `${url}\nrate limit reached${limited.limit ? ` (${limited.limit} requests per hour)` : ''}; resets at ${new Date(limited.resetAt).toISOString()}`,
  });
  err.resetAt = limited.resetAt;
  return err;
}

function networkError(what, url, cause) {
  const reason = cause && cause.name === 'TimeoutError' ? 'the request timed out'
    : cause && cause.name === 'AbortError' ? 'the request was cancelled'
      : `${cause && cause.message ? cause.message : cause}${cause && cause.cause && cause.cause.code ? ` (${cause.cause.code})` : ''}`;
  const err = userError(`Could not ${what}: GitHub could not be reached. Check your internet connection.`, {
    code: cause && cause.name === 'AbortError' ? 'CANCELLED' : 'NETWORK',
    details: `${url}\n${reason}`,
    cause,
  });
  err.retryable = err.code === 'NETWORK';
  return err;
}

function httpError(what, url, status, statusText) {
  const err = userError(`Could not ${what}: GitHub answered with error ${status}. Try again later.`, {
    code: 'HTTP_ERROR',
    details: `${url}\nHTTP ${status} ${statusText || ''}`.trim(),
  });
  err.status = status;
  err.retryable = status >= 500 || status === 408 || status === 429;
  return err;
}

function defaultSleep(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * An abort signal that fires once `touch()` was not called for `ms` (armed at creation).
 * @param {number} ms
 * @returns {{signal: AbortSignal, touch: () => void, stop: () => void}}
 */
function stallWatch(ms) {
  const controller = new AbortController();
  let timer = null;
  const watch = {
    signal: controller.signal,
    touch() {
      clearTimeout(timer);
      timer = setTimeout(() => {
        controller.abort(Object.assign(new Error(`nothing was received for ${Math.round(ms / 1000)} s`), { name: 'TimeoutError' }));
      }, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
  watch.touch();
  return watch;
}

/** A response body, read chunk by chunk so that `watch` sees the download progress. */
async function readBody(response, watch) {
  if (!response.body || typeof response.body.getReader !== 'function') return Buffer.from(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    watch.touch();
  }
  return Buffer.concat(chunks);
}

/**
 * Create the GitHub client.
 * @param {object} options
 * @param {typeof fetch} options.fetch          fetch implementation (Electron net.fetch, Node fetch, a fake)
 * @param {string|null} [options.token]          GitHub token for REST calls (never sent to other hosts)
 * @param {string} [options.userAgent]
 * @param {number} [options.timeoutMs=30000]     per request (ls-refs, tree, commit)
 * @param {number} [options.downloadStallMs=60000] a file download that receives nothing for this long fails
 * @param {number} [options.retries=2]           extra attempts after a retryable failure
 * @param {AbortSignal} [options.signal]         cancels every request (e.g. on quit)
 * @param {(ms:number)=>Promise<void>} [options.sleep] delay between attempts (tests pass a no-op)
 * @param {()=>number} [options.now]             clock for rate-limit times
 * @returns {{lsRemote:Function, getTree:Function, getCommit:Function, downloadFile:Function}}
 */
function createEngineRemote({
  fetch: fetchImpl,
  token = null,
  userAgent = DEFAULT_USER_AGENT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  downloadStallMs = DEFAULT_DOWNLOAD_STALL_MS,
  retries = DEFAULT_RETRIES,
  signal = null,
  sleep = defaultSleep,
  now = Date.now,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('createEngineRemote: a fetch function is required');

  function requestSignal(ms) {
    const timeout = AbortSignal.timeout(ms);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  /**
   * One HTTP exchange with retries. `read(response, watch)` turns a 2xx answer into the result; it runs
   * inside the retry loop, so a body that breaks off or fails verification is fetched again. With
   * `stallMs`, the exchange fails when nothing arrives for that long (`read` calls watch.touch() per
   * chunk) instead of after `timeout` in total.
   */
  async function request(url, init, { what, timeout = timeoutMs, stallMs = 0, read }) {
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      if (signal && signal.aborted) throw networkError(what, url, Object.assign(new Error('cancelled'), { name: 'AbortError' }));
      const watch = stallMs > 0 ? stallWatch(stallMs) : null;
      // A stalled download aborts with the watch's TimeoutError (retried), not as a cancellation.
      const failure = (err) => networkError(what, url, watch && watch.signal.aborted ? watch.signal.reason : err);
      try {
        let response;
        try {
          const requestSignalFor = watch ? (signal ? AbortSignal.any([signal, watch.signal]) : watch.signal) : requestSignal(timeout);
          response = await fetchImpl(url, { ...init, redirect: 'follow', signal: requestSignalFor });
        } catch (err) {
          lastError = failure(err);
          if (!lastError.retryable) throw lastError;
          continue;
        }
        const limited = rateLimitInfo(response.status, response.headers, now());
        if (limited) throw rateLimitedError(what, url, limited);
        if (!response.ok) {
          lastError = httpError(what, url, response.status, response.statusText);
          if (!lastError.retryable) throw lastError;
          continue;
        }
        try {
          return await read(response, watch);
        } catch (err) {
          lastError = err && err.friendly ? err : failure(err);
          if (!lastError.retryable) throw lastError;
        }
      } finally {
        if (watch) watch.stop();
      }
    }
    throw lastError;
  }

  function restHeaders() {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': userAgent };
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  async function readJson(response) {
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw badResponse(`not JSON: ${text.slice(0, 200)}`);
    }
  }

  /**
   * Latest commit of a branch, through the git protocol (no REST quota).
   * @param {string} repo 'owner/name'
   * @param {string} [ref='refs/heads/main'] branch name or full ref
   * @returns {Promise<{commit:string, ref:string}>}
   */
  async function lsRemote(repo, ref = DEFAULT_ENGINE_REF) {
    assertRepository(repo);
    const fullRef = normalizeRef(ref);
    const url = `https://github.com/${repo}.git/git-upload-pack`;
    const what = 'check for a new card maker engine';
    const commit = await request(url, {
      method: 'POST',
      headers: {
        'Git-Protocol': 'version=2',
        'Content-Type': 'application/x-git-upload-pack-request',
        Accept: 'application/x-git-upload-pack-result',
        'User-Agent': userAgent,
      },
      body: lsRefsRequestBody(fullRef),
    }, { what, read: async (res) => parseLsRefs(Buffer.from(await res.arrayBuffer()), fullRef) });
    if (!commit) {
      throw userError(`Could not ${what}: ${fullRef} was not found in ${repo}.`, { code: 'REF_NOT_FOUND', details: url });
    }
    return { commit, ref: fullRef };
  }

  /**
   * Every file of a commit with its git blob SHA-1 (one REST call).
   * @param {string} repo
   * @param {string} commit 40-hex SHA
   * @returns {Promise<{commit:string, entries:Array<{path:string, mode:string, type:string, sha:string, size?:number}>}>}
   */
  async function getTree(repo, commit) {
    assertRepository(repo);
    assertCommit(commit);
    const url = `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`;
    const data = await request(url, { headers: restHeaders() }, { what: 'list the card maker engine files', read: readJson });
    if (!data || !Array.isArray(data.tree)) throw badResponse(`${url}: no "tree" array`);
    if (data.truncated) {
      throw userError('Could not list the card maker engine files: GitHub returned an incomplete list.', { code: 'TREE_TRUNCATED', details: url });
    }
    const entries = data.tree.map((e) => ({
      path: String(e && e.path),
      mode: String(e && e.mode),
      type: String(e && e.type),
      sha: String(e && e.sha),
      ...(e && Number.isSafeInteger(e.size) ? { size: e.size } : {}),
    }));
    return { commit, entries };
  }

  /**
   * Commit date (committer date, ISO-8601 UTC) and message (one REST call).
   * @param {string} repo
   * @param {string} sha 40-hex SHA
   * @returns {Promise<{commit:string, committedAt:string, message:string}>}
   */
  async function getCommit(repo, sha) {
    assertRepository(repo);
    assertCommit(sha);
    const url = `https://api.github.com/repos/${repo}/git/commits/${sha}`;
    const data = await request(url, { headers: restHeaders() }, { what: 'read the card maker engine version', read: readJson });
    const date = data && data.committer && Date.parse(data.committer.date);
    if (!data || data.sha !== sha || !Number.isFinite(date)) throw badResponse(`${url}: unexpected commit data`);
    return { commit: sha, committedAt: new Date(date).toISOString().replace('.000Z', 'Z'), message: String(data.message || '') };
  }

  /**
   * Download one file of a commit and verify it against its git blob SHA-1.
   * @param {string} repo
   * @param {string} commit 40-hex SHA
   * @param {string} filePath POSIX path inside the repository
   * @param {string} expectedBlob git blob SHA-1 from the commit's tree
   * @returns {Promise<Buffer>}
   */
  async function downloadFile(repo, commit, filePath, expectedBlob) {
    assertRepository(repo);
    assertCommit(commit);
    if (!isSafeRelativePath(filePath)) throw new TypeError(`Invalid engine file path "${filePath}"`);
    if (!isSha(expectedBlob)) throw new TypeError(`Invalid blob SHA-1 for ${filePath}`);
    const url = rawFileUrl(repo, commit, filePath);
    return request(url, { headers: { 'User-Agent': userAgent } }, {
      what: 'download the card maker engine',
      stallMs: downloadStallMs,
      read: async (res, watch) => {
        const data = await readBody(res, watch);
        const blob = gitBlobSha1(data);
        if (blob !== expectedBlob) {
          const err = userError(`A downloaded card maker engine file was damaged (${filePath}). Try again later.`, {
            code: 'ENGINE_INTEGRITY',
            details: `${url}\nexpected git blob ${expectedBlob}, got ${blob} (${data.length} bytes)`,
          });
          err.retryable = true;
          throw err;
        }
        return data;
      },
    });
  }

  return { lsRemote, getTree, getCommit, downloadFile };
}

/**
 * raw.githubusercontent.com URL of a file at a commit (each path segment URL-encoded: names may contain
 * spaces, '#' or '%').
 * @param {string} repo
 * @param {string} commit
 * @param {string} filePath
 * @returns {string}
 */
function rawFileUrl(repo, commit, filePath) {
  return `https://raw.githubusercontent.com/${repo}/${commit}/${filePath.split('/').map(encodeURIComponent).join('/')}`;
}

module.exports = {
  DEFAULT_ENGINE_REPOSITORY,
  DEFAULT_ENGINE_REF,
  createEngineRemote,
  pktLine,
  parsePktLines,
  lsRefsRequestBody,
  parseLsRefs,
  rateLimitInfo,
  rawFileUrl,
};
