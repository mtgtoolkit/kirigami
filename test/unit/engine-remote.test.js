'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const remoteModule = require('../../src/main/engine-remote');
const { gitBlobSha1 } = require('../../src/main/engine-files');

const {
  createEngineRemote, pktLine, parsePktLines, lsRefsRequestBody, parseLsRefs, rateLimitInfo, rawFileUrl,
  DEFAULT_ENGINE_REPOSITORY, DEFAULT_ENGINE_REF,
} = remoteModule;

const REPO = 'Alan-Cha/silhouette-card-maker';
const COMMIT = '0da09b729814aa5aafde024b5a6059624fa87951';
const OTHER = '1111111111111111111111111111111111111111';
const NOW = Date.UTC(2026, 9, 12, 18, 0, 0);

/**
 * A fake fetch: `handler(url, init, callNumber)` returns a Response (or throws, like a network failure).
 * Every call is recorded with its url and init.
 */
function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, init });
    return handler(url, init, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function client(fetch, extra = {}) {
  const delays = [];
  const remote = createEngineRemote({ fetch, sleep: async (ms) => { delays.push(ms); }, now: () => NOW, ...extra });
  return { remote, delays };
}

const json = (value, init = {}) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

test('pkt-line encoding and the ls-refs request body', () => {
  assert.equal(pktLine('command=ls-refs\n'), '0014command=ls-refs\n');
  assert.equal(pktLine(''), '0004');
  assert.equal(lsRefsRequestBody('refs/heads/main'), '0014command=ls-refs\n0001001fref-prefix refs/heads/main\n0000');
  assert.throws(() => pktLine('x'.repeat(70000)), RangeError);
});

test('parsePktLines decodes data and special packets and refuses malformed input', () => {
  assert.deepEqual(parsePktLines('0009hello0000000100020006ok'), [
    { type: 'data', text: 'hello' }, { type: 'flush' }, { type: 'delim' }, { type: 'end' }, { type: 'data', text: 'ok' },
  ]);
  assert.deepEqual(parsePktLines(Buffer.alloc(0)), []);
  for (const bad of ['zzzz', '0003', '0010short', '00']) {
    assert.throws(() => parsePktLines(bad), (err) => err.code === 'BAD_RESPONSE', bad);
  }
});

test('parseLsRefs matches the exact ref name (ref-prefix matches by prefix)', () => {
  const body = [
    pktLine(`${OTHER} refs/heads/main-old\n`),
    pktLine(`${COMMIT} refs/heads/main symref-target:refs/heads/x\n`),
    '0000',
  ].join('');
  assert.equal(parseLsRefs(body, 'refs/heads/main'), COMMIT);
  assert.equal(parseLsRefs(body, 'refs/heads/main-old'), OTHER);
  assert.equal(parseLsRefs(body, 'refs/heads/mai'), null);
  assert.equal(parseLsRefs('0000', 'refs/heads/main'), null);
  assert.throws(() => parseLsRefs(pktLine('ERR access denied\n'), 'refs/heads/main'), (err) => err.code === 'BAD_RESPONSE' && /access denied/.test(err.details));
});

test('rateLimitInfo: primary limit, secondary limit (retry-after) and plain 429', () => {
  const h = (o) => new Headers(o);
  assert.deepEqual(rateLimitInfo(403, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1791831480', 'x-ratelimit-limit': '60' }), NOW),
    { resetAt: 1791831480000, limit: 60 });
  assert.deepEqual(rateLimitInfo(429, h({ 'retry-after': '30' }), NOW), { resetAt: NOW + 30000, limit: null });
  assert.deepEqual(rateLimitInfo(403, h({ 'retry-after': new Date(NOW + 120000).toUTCString() }), NOW), { resetAt: NOW + 120000, limit: null });
  assert.deepEqual(rateLimitInfo(429, h({}), NOW), { resetAt: NOW + 60000, limit: null });
  assert.deepEqual(rateLimitInfo(403, h({ 'x-ratelimit-remaining': '0' }), NOW), { resetAt: NOW + 60000, limit: null });
  assert.equal(rateLimitInfo(403, h({ 'x-ratelimit-remaining': '12' }), NOW), null, 'a plain 403 is not a limit');
  assert.equal(rateLimitInfo(200, h({ 'x-ratelimit-remaining': '0' }), NOW), null);
  assert.equal(rateLimitInfo(404, null, NOW), null);
});

test('rawFileUrl encodes every path segment', () => {
  assert.equal(rawFileUrl(REPO, COMMIT, 'examples/ZERO SUMZ/#1 100%.png'),
    `https://raw.githubusercontent.com/${REPO}/${COMMIT}/examples/ZERO%20SUMZ/%231%20100%25.png`);
});

test('lsRemote: one git protocol v2 POST, exact ref match, no REST API', async () => {
  const fetch = fakeFetch(() => new Response(`${pktLine(`${COMMIT} refs/heads/main\n`)}0000`, { status: 200 }));
  const { remote } = client(fetch, { token: 'secret' });
  assert.deepEqual(await remote.lsRemote(REPO, 'main'), { commit: COMMIT, ref: 'refs/heads/main' });
  const [{ url, init }] = fetch.calls;
  assert.equal(url, `https://github.com/${REPO}.git/git-upload-pack`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Git-Protocol'], 'version=2');
  assert.equal(init.headers['Content-Type'], 'application/x-git-upload-pack-request');
  assert.equal(init.headers.Authorization, undefined, 'the token is only for the REST API');
  assert.match(init.headers['User-Agent'], /Kirigami/);
  assert.equal(init.body, lsRefsRequestBody('refs/heads/main'));
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(DEFAULT_ENGINE_REPOSITORY, REPO);
  assert.equal(DEFAULT_ENGINE_REF, 'refs/heads/main');

  const missing = client(fakeFetch(() => new Response('0000', { status: 200 }))).remote;
  await assert.rejects(missing.lsRemote(REPO, 'gone'), (err) => err.code === 'REF_NOT_FOUND' && err.friendly && /refs\/heads\/gone/.test(err.message));
});

test('getTree: authenticated when a token is given, complete trees only', async () => {
  const tree = [{ path: 'create_pdf.py', mode: '100644', type: 'blob', sha: OTHER, size: 6134, url: 'x' }, { path: 'plugins', mode: '040000', type: 'tree', sha: COMMIT }];
  const fetch = fakeFetch(() => json({ sha: 'tree-sha', truncated: false, tree }));
  const { remote } = client(fetch, { token: 'secret' });
  const result = await remote.getTree(REPO, COMMIT);
  assert.deepEqual(result, {
    commit: COMMIT,
    entries: [
      { path: 'create_pdf.py', mode: '100644', type: 'blob', sha: OTHER, size: 6134 },
      { path: 'plugins', mode: '040000', type: 'tree', sha: COMMIT },
    ],
  });
  assert.equal(fetch.calls[0].url, `https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`);
  assert.equal(fetch.calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(fetch.calls[0].init.headers.Accept, 'application/vnd.github+json');

  const anonymous = fakeFetch(() => json({ truncated: false, tree }));
  await client(anonymous).remote.getTree(REPO, COMMIT);
  assert.equal(anonymous.calls[0].init.headers.Authorization, undefined);

  const truncated = client(fakeFetch(() => json({ truncated: true, tree }))).remote;
  await assert.rejects(truncated.getTree(REPO, COMMIT), { code: 'TREE_TRUNCATED' });
  const garbage = client(fakeFetch(() => new Response('<html>', { status: 200 }))).remote;
  await assert.rejects(garbage.getTree(REPO, COMMIT), { code: 'BAD_RESPONSE' });
});

test('rate limiting is reported with its reset time and never retried', async () => {
  const fetch = fakeFetch(() => new Response('{"message":"API rate limit exceeded"}', {
    status: 403,
    headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String((NOW + 3600000) / 1000), 'x-ratelimit-limit': '60' },
  }));
  const { remote, delays } = client(fetch);
  await assert.rejects(remote.getTree(REPO, COMMIT), (err) => {
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.resetAt, NOW + 3600000);
    assert.equal(err.friendly, true);
    assert.match(err.message, /limiting requests/);
    assert.match(err.details, /60 requests per hour/);
    return true;
  });
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(delays, []);
});

test('getCommit returns the committer date (UTC, no milliseconds) and the message', async () => {
  const fetch = fakeFetch(() => json({ sha: COMMIT, message: 'Add Python 3.15 support\n\nDetails', committer: { date: '2026-10-12T17:55:38+02:00' } }));
  const { remote } = client(fetch);
  assert.deepEqual(await remote.getCommit(REPO, COMMIT), { commit: COMMIT, committedAt: '2026-10-12T15:55:38Z', message: 'Add Python 3.15 support\n\nDetails' });
  assert.equal(fetch.calls[0].url, `https://api.github.com/repos/${REPO}/git/commits/${COMMIT}`);
  const wrong = client(fakeFetch(() => json({ sha: OTHER, committer: { date: '2026-10-12T15:55:38Z' } }))).remote;
  await assert.rejects(wrong.getCommit(REPO, COMMIT), { code: 'BAD_RESPONSE' });
});

test('downloadFile verifies the git blob SHA-1 and retries damaged or failed downloads', async () => {
  const good = Buffer.from('print("create")\n');
  const blob = gitBlobSha1(good);
  let n = 0;
  const flaky = fakeFetch(() => {
    n += 1;
    if (n === 1) throw new TypeError('fetch failed');
    if (n === 2) return new Response('busy', { status: 503 });
    if (n === 3) return new Response('print("tampered")\n', { status: 200 });
    return new Response(good, { status: 200 });
  });
  const { remote, delays } = client(flaky, { retries: 3, token: 'secret' });
  const data = await remote.downloadFile(REPO, COMMIT, 'plugins/my game/fetch.py', blob);
  assert.ok(Buffer.isBuffer(data) && data.equals(good));
  assert.equal(flaky.calls.length, 4);
  assert.deepEqual(delays, [500, 1000, 2000]);
  assert.equal(flaky.calls[0].url, `https://raw.githubusercontent.com/${REPO}/${COMMIT}/plugins/my%20game/fetch.py`);
  assert.equal(flaky.calls[0].init.headers.Authorization, undefined, 'no token for raw.githubusercontent.com');

  const tampered = fakeFetch(() => new Response('print("tampered")\n', { status: 200 }));
  await assert.rejects(client(tampered, { retries: 1 }).remote.downloadFile(REPO, COMMIT, 'create_pdf.py', blob), (err) => {
    assert.equal(err.code, 'ENGINE_INTEGRITY');
    assert.match(err.message, /create_pdf\.py/);
    assert.match(err.details, new RegExp(`expected git blob ${blob}`));
    return true;
  });
  assert.equal(tampered.calls.length, 2);

  const notFound = fakeFetch(() => new Response('404: Not Found', { status: 404, statusText: 'Not Found' }));
  await assert.rejects(client(notFound).remote.downloadFile(REPO, COMMIT, 'create_pdf.py', blob), (err) => err.code === 'HTTP_ERROR' && err.status === 404);
  assert.equal(notFound.calls.length, 1, 'a 404 is not retried');

  const offline = fakeFetch(() => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
  await assert.rejects(client(offline).remote.downloadFile(REPO, COMMIT, 'create_pdf.py', blob), (err) => {
    assert.equal(err.code, 'NETWORK');
    assert.match(err.message, /internet connection/);
    assert.match(err.details, /ENOTFOUND/);
    return true;
  });
  assert.equal(offline.calls.length, 3, 'two retries by default');
});

test('timeouts and cancellation', async () => {
  const hanging = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  }));
  await assert.rejects(client(hanging, { timeoutMs: 20, retries: 0 }).remote.lsRemote(REPO), (err) => err.code === 'NETWORK' && /timed out/.test(err.details));

  const controller = new AbortController();
  const cancelled = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
    setTimeout(() => controller.abort(), 5);
  }));
  await assert.rejects(client(cancelled, { signal: controller.signal }).remote.getTree(REPO, COMMIT), (err) => err.code === 'CANCELLED');
  assert.equal(cancelled.calls.length, 1, 'a cancelled request is not retried');
  await assert.rejects(client(cancelled, { signal: controller.signal }).remote.getTree(REPO, COMMIT), { code: 'CANCELLED' });
  assert.equal(cancelled.calls.length, 1, 'nothing is sent once cancelled');
});

test('arguments are validated before any request', async () => {
  const fetch = fakeFetch(() => { throw new Error('must not be called'); });
  const { remote } = client(fetch);
  await assert.rejects(remote.lsRemote('not a repo'), TypeError);
  await assert.rejects(remote.lsRemote(REPO, 'bad ref'), TypeError);
  await assert.rejects(remote.getTree(REPO, 'abc'), TypeError);
  await assert.rejects(remote.getCommit(REPO, COMMIT.toUpperCase()), TypeError);
  await assert.rejects(remote.downloadFile(REPO, COMMIT, '../escape.py', COMMIT), TypeError);
  await assert.rejects(remote.downloadFile(REPO, COMMIT, 'create_pdf.py', 'nope'), TypeError);
  assert.equal(fetch.calls.length, 0);
  assert.throws(() => createEngineRemote({}), TypeError);
});
