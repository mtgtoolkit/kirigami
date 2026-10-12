'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  encodePath, decodePath, toFileUrl, parseImageUrl, isImageExtension, sniffImageMime, isUncOrDevicePath, SCHEME,
} = require('../../src/main/img-url');

const WIN_PATHS = [
  'D:\\Development\\Proxies\\card-maker\\game\\front\\Lightning Bolt.png',
  'C:\\Users\\Sébastien\\Cartes à jouer\\dossier é ü\\carte #1 (copie).png',
  'C:\\Users\\me\\game\\front\\100% legit?.jpg',
  'C:\\Users\\me\\game\\front\\日本語のカード.webp',
  'C:\\Users\\me\\game\\front\\emoji \u{1F0CF} card&co=1+2;x.png',
  'C:\\a b\\c#d\\e%20f.png',
];
const POSIX_PATHS = [
  '/home/me/game/front/Lightning Bolt.png',
  '/home/me/Cartes à jouer/carte #1 (copie).png',
  '/tmp/a%2Fb?c=d#e.png',
];

test('encodePath/decodePath round-trip (non-ASCII, spaces, #, %, ?)', () => {
  for (const p of [...WIN_PATHS, ...POSIX_PATHS]) {
    const enc = encodePath(p);
    assert.match(enc, /^[A-Za-z0-9_-]+$/, 'base64url alphabet only, no padding');
    assert.equal(decodePath(enc), p);
  }
  assert.throws(() => encodePath(''), TypeError);
  assert.throws(() => encodePath(null), TypeError);
});

test('decodePath rejects invalid or non-canonical input', () => {
  for (const bad of ['', '!!', 'YQ==', 'YR', 'a b', 'AA', '_w', 'x'.repeat(40000), null, 42]) {
    assert.throws(() => decodePath(bad), TypeError, `should reject ${JSON.stringify(bad)?.slice(0, 20)}`);
  }
  assert.throws(() => decodePath(Buffer.from('C:\\a\u0000.png').toString('base64url')), TypeError, 'NUL');
  assert.throws(() => decodePath(Buffer.from([0xff, 0xfe, 0x41]).toString('base64url')), TypeError, 'invalid UTF-8');
});

test('toFileUrl builds scm-img://file/<b64>?v=<mtime>', () => {
  const p = WIN_PATHS[1];
  assert.equal(toFileUrl(p, 1696333333123.789), `${SCHEME}://file/${encodePath(p)}?v=1696333333124`);
  assert.equal(toFileUrl(p), `${SCHEME}://file/${encodePath(p)}`);
  assert.equal(toFileUrl(p, NaN), `${SCHEME}://file/${encodePath(p)}`);
  const url = new URL(toFileUrl(p, 5));
  assert.equal(url.protocol, 'scm-img:');
  assert.equal(url.hostname, 'file');
  assert.equal(url.searchParams.get('v'), '5');
});

test('parseImageUrl round-trips Windows and POSIX paths through URL parsing', () => {
  for (const p of WIN_PATHS) assert.equal(parseImageUrl(toFileUrl(p, 1), 'win32'), p);
  for (const p of POSIX_PATHS) assert.equal(parseImageUrl(toFileUrl(p, 1), 'linux'), p);
  // host is case-insensitive in standard URLs; the encoded path is case-sensitive and preserved
  const upper = toFileUrl(WIN_PATHS[0]).replace('://file/', '://FILE/');
  assert.equal(parseImageUrl(upper, 'win32'), WIN_PATHS[0]);
  // trailing slash tolerated
  assert.equal(parseImageUrl(`${toFileUrl(WIN_PATHS[0])}/`, 'win32'), WIN_PATHS[0]);
});

test('parseImageUrl normalizes ".." (the protocol then checks the allowed roots)', () => {
  const url = toFileUrl('C:\\ws\\game\\front\\..\\..\\secret.png');
  assert.equal(parseImageUrl(url, 'win32'), 'C:\\ws\\secret.png');
});

test('parseImageUrl rejects other schemes/hosts, relative, UNC, device and ADS paths', () => {
  const enc = (p) => `${SCHEME}://file/${Buffer.from(p, 'utf8').toString('base64url')}`;
  const bad = [
    'file:///C:/x.png',
    `https://file/${encodePath('C:\\x.png')}`,
    `${SCHEME}://other/${encodePath('C:\\x.png')}`,
    `${SCHEME}://file/`,
    `${SCHEME}://file/not*base64`,
    'not a url',
    enc('relative\\x.png'),
    enc('C:x.png'),
    enc('\\\\server\\share\\x.png'),
    enc('//server/share/x.png'),
    enc('\\\\?\\C:\\x.png'),
    enc('\\\\.\\pipe\\x'),
    enc('\\Windows\\x.png'),
    enc('C:\\game\\a.png:Zone.Identifier'),
  ];
  for (const url of bad) assert.throws(() => parseImageUrl(url, 'win32'), TypeError, url);
  assert.throws(() => parseImageUrl(enc('relative/x.png'), 'linux'), TypeError);
  assert.throws(() => parseImageUrl(enc('//server/x.png'), 'linux'), TypeError);
});

test('isUncOrDevicePath / isImageExtension', () => {
  assert.equal(isUncOrDevicePath('\\\\server\\share'), true);
  assert.equal(isUncOrDevicePath('//server/share'), true);
  assert.equal(isUncOrDevicePath('\\\\?\\C:\\x'), true);
  assert.equal(isUncOrDevicePath('C:\\x'), false);
  for (const name of ['a.png', 'B.JPG', 'c.jpeg', 'd.webp', 'e.gif', 'f.bmp', 'g.tif', 'h.TIFF', 'i.avif', 'j.jfif']) {
    assert.equal(isImageExtension(name), true, name);
  }
  for (const name of ['a.txt', 'b.json', 'c.py', 'd', 'e.png.exe', '', null]) {
    assert.equal(isImageExtension(name), false, String(name));
  }
});

test('sniffImageMime recognizes image headers and rejects others', () => {
  const b = (...bytes) => Uint8Array.from(bytes);
  const ascii = (s, pad = 16) => {
    const out = new Uint8Array(Math.max(pad, s.length));
    for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
    return out;
  };
  assert.equal(sniffImageMime(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'image/png');
  assert.equal(sniffImageMime(b(0xff, 0xd8, 0xff, 0xe0, 0, 0)), 'image/jpeg');
  assert.equal(sniffImageMime(ascii('GIF89a')), 'image/gif');
  assert.equal(sniffImageMime(ascii('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImageMime(ascii('BM')), 'image/bmp');
  assert.equal(sniffImageMime(b(0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0)), 'image/tiff');
  assert.equal(sniffImageMime(b(0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8)), 'image/tiff');
  assert.equal(sniffImageMime(ascii('\u0000\u0000\u0000\u001cftypavif')), 'image/avif');
  assert.equal(sniffImageMime(ascii('\u0000\u0000\u0000\u000cjP  \r\n\u0087\n')), 'image/jp2');
  assert.equal(sniffImageMime(ascii('\u0000\u0000\u0000\u0018ftypheic')), null, 'HEIC is not served');
  assert.equal(sniffImageMime(ascii('{"json": true}')), null);
  assert.equal(sniffImageMime(b(1, 2)), null);
  assert.equal(sniffImageMime('PNG'), null);
});
