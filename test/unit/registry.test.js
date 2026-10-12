'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const registry = require('../../src/main/registry');

/** Fake child_process.spawn: behavior(cmd, args) -> { stdout, stderr, code, delayMs, hang, throws, error } */
function fakeSpawn(behavior) {
  const calls = [];
  const spawn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    const spec = behavior(cmd, args) || {};
    if (spec.throws) throw spec.throws;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
      setImmediate(() => child.emit('close', null, 'SIGTERM'));
      return true;
    };
    if (!spec.hang) {
      setTimeout(() => {
        if (spec.error) {
          child.emit('error', spec.error);
          return;
        }
        if (spec.stdoutChunks) for (const chunk of spec.stdoutChunks) child.stdout.write(chunk);
        if (spec.stdout) child.stdout.write(Buffer.isBuffer(spec.stdout) ? spec.stdout : Buffer.from(spec.stdout, 'utf8'));
        if (spec.stderr) child.stderr.write(spec.stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit('close', spec.code === undefined ? 0 : spec.code, null);
      }, spec.delayMs || 1);
    }
    return child;
  };
  return { spawn, calls };
}

test.beforeEach(() => registry.clearCache());

test('parseUninstallJson handles a single object, arrays, BOM, noise and junk', () => {
  const one = '{"DisplayName":"Upscayl 2.15.0","DisplayVersion":"2.15.0","DisplayIcon":"D:\\\\Tools\\\\Upscayl.exe,0","InstallLocation":null}';
  assert.deepEqual(registry.parseUninstallJson(one), [
    { DisplayName: 'Upscayl 2.15.0', DisplayVersion: '2.15.0', DisplayIcon: 'D:\\Tools\\Upscayl.exe,0', InstallLocation: null },
  ]);
  const arr = `\uFEFF[${one},{"DisplayName":"Other","DisplayVersion":1.5,"DisplayIcon":"","InstallLocation":"  C:\\\\x  "}]`;
  const parsed = registry.parseUninstallJson(arr);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1], { DisplayName: 'Other', DisplayVersion: '1.5', DisplayIcon: null, InstallLocation: 'C:\\x' });
  assert.deepEqual(registry.parseUninstallJson('WARNING: something\r\n[' + one + ']'), registry.parseUninstallJson(one));
  assert.deepEqual(registry.parseUninstallJson(''), []);
  assert.deepEqual(registry.parseUninstallJson('[]'), []);
  assert.deepEqual(registry.parseUninstallJson('not json'), []);
  assert.deepEqual(registry.parseUninstallJson('null'), []);
  assert.deepEqual(registry.parseUninstallJson('[1, "x", {"DisplayVersion": "1"}]'), []);
  assert.deepEqual(registry.parseUninstallJson(undefined), []);
});

test('buildUninstallScript uses single quotes only and escapes the pattern', () => {
  const script = registry.buildUninstallScript("O'Brien*");
  assert.ok(!script.includes('"'), 'no double quotes (they would break Windows command-line quoting)');
  assert.match(script, /-like 'O''Brien\*'/);
  assert.match(script, /\[Console\]::OutputEncoding=\[System\.Text\.Encoding\]::UTF8/);
  assert.match(script, /ConvertTo-Json -InputObject \$r -Compress/);
  for (const key of registry.UNINSTALL_KEYS) assert.ok(script.includes(`'${key}'`), key);
  assert.match(registry.buildUninstallScript('a\u2019b'), /-like 'a\u2019\u2019b'/);
});

test('exePathFromDisplayIcon strips quotes and icon index', () => {
  assert.equal(registry.exePathFromDisplayIcon('D:\\Tools\\Upscayl\\Upscayl.exe,0'), 'D:\\Tools\\Upscayl\\Upscayl.exe');
  assert.equal(registry.exePathFromDisplayIcon('"C:\\Program Files\\App\\App.exe",-101'), 'C:\\Program Files\\App\\App.exe');
  assert.equal(registry.exePathFromDisplayIcon('C:\\App\\App.exe'), 'C:\\App\\App.exe');
  assert.equal(registry.exePathFromDisplayIcon(''), null);
  assert.equal(registry.exePathFromDisplayIcon(null), null);
});

test('queryUninstall returns [] on non-Windows without spawning', async () => {
  const fake = fakeSpawn(() => ({ stdout: '[]' }));
  assert.deepEqual(await registry.queryUninstall('Upscayl*', { platform: 'linux', spawnImpl: fake.spawn }), []);
  assert.equal(fake.calls.length, 0);
});

test('queryUninstall spawns PowerShell by absolute path, parses JSON and caches per pattern', async () => {
  const fake = fakeSpawn(() => ({ stdout: '{"DisplayName":"Upscayl 2.15.0","DisplayVersion":"2.15.0","DisplayIcon":"D:\\\\U\\\\Upscayl.exe,0","InstallLocation":""}' }));
  const opts = { platform: 'win32', spawnImpl: fake.spawn, systemRoot: 'C:\\Windows' };
  const first = await registry.queryUninstall('Upscayl*', opts);
  assert.equal(first.length, 1);
  assert.equal(first[0].DisplayVersion, '2.15.0');
  assert.equal(first[0].InstallLocation, null);
  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call.cmd, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.deepEqual(call.args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(call.args[4], /-like 'Upscayl\*'/);
  assert.equal(call.options.windowsHide, true);
  assert.equal(call.options.shell, false);
  assert.deepEqual(call.options.stdio, ['ignore', 'pipe', 'pipe']);

  const second = await registry.queryUninstall('Upscayl*', opts);
  assert.equal(second, first, 'cached promise result');
  assert.equal(fake.calls.length, 1);
  await registry.queryUninstall('Upscayl*', { ...opts, refresh: true });
  assert.equal(fake.calls.length, 2);
  await registry.queryUninstall('Other*', opts);
  assert.equal(fake.calls.length, 3);
});

test('queryUninstall decodes UTF-8 split across chunks', async () => {
  const json = Buffer.from('[{"DisplayName":"Silhouette Studio® Ünïcode","DisplayVersion":"5.0"}]', 'utf8');
  const cut = json.indexOf(Buffer.from('®', 'utf8')) + 1; // split inside the 2-byte character
  const fake = fakeSpawn(() => ({ stdoutChunks: [json.subarray(0, cut), json.subarray(cut)] }));
  const result = await registry.queryUninstall('Silhouette*', { platform: 'win32', spawnImpl: fake.spawn });
  assert.equal(result[0].DisplayName, 'Silhouette Studio® Ünïcode');
});

test('queryUninstall resolves [] on timeout, spawn errors and non-zero exits, and does not cache failures', async () => {
  const hang = fakeSpawn(() => ({ hang: true }));
  const started = Date.now();
  assert.deepEqual(await registry.queryUninstall('Upscayl*', { platform: 'win32', spawnImpl: hang.spawn, timeoutMs: 50 }), []);
  assert.ok(Date.now() - started < 2000);

  const enoent = fakeSpawn(() => ({ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }));
  const warnings = [];
  assert.deepEqual(
    await registry.queryUninstall('Upscayl*', { platform: 'win32', spawnImpl: enoent.spawn, logger: { warn: (m) => warnings.push(m) } }),
    [],
  );
  assert.equal(warnings.length, 1);

  const throws = fakeSpawn(() => ({ throws: new Error('EINVAL') }));
  assert.deepEqual(await registry.queryUninstall('Upscayl*', { platform: 'win32', spawnImpl: throws.spawn }), []);

  const failing = fakeSpawn(() => ({ code: 1, stdout: '[{"DisplayName":"X"}]' }));
  assert.deepEqual(await registry.queryUninstall('Upscayl*', { platform: 'win32', spawnImpl: failing.spawn }), []);

  const ok = fakeSpawn(() => ({ stdout: '[{"DisplayName":"Upscayl"}]' }));
  const result = await registry.queryUninstall('Upscayl*', { platform: 'win32', spawnImpl: ok.spawn });
  assert.equal(result.length, 1, 'previous failures were not cached');
});

test('queryUninstall rejects invalid patterns', async () => {
  await assert.rejects(registry.queryUninstall('', { platform: 'win32' }), TypeError);
  await assert.rejects(registry.queryUninstall('a\nb', { platform: 'win32' }), TypeError);
  await assert.rejects(registry.queryUninstall(42, { platform: 'win32' }), TypeError);
});

test('findSilhouetteStudio picks the newest entry and derives the exe path', async () => {
  const fake = fakeSpawn(() => ({
    stdout: JSON.stringify([
      { DisplayName: 'Silhouette Studio', DisplayVersion: '4.5.1', DisplayIcon: 'C:\\Old\\Silhouette Studio.exe,0', InstallLocation: 'C:\\Old\\' },
      { DisplayName: 'Silhouette Studio', DisplayVersion: '5.0.523', DisplayIcon: '"D:\\Tools\\CameoStudio\\Silhouette Studio.exe",0', InstallLocation: 'D:\\Tools\\CameoStudio\\' },
    ]),
  }));
  const found = await registry.findSilhouetteStudio({ platform: 'win32', spawnImpl: fake.spawn });
  assert.deepEqual(found, {
    found: true,
    path: 'D:\\Tools\\CameoStudio\\Silhouette Studio.exe',
    version: '5.0.523',
    name: 'Silhouette Studio',
    installLocation: 'D:\\Tools\\CameoStudio\\',
  });
  registry.clearCache();
  const none = await registry.findSilhouetteStudio({ platform: 'win32', spawnImpl: fakeSpawn(() => ({ stdout: '[]' })).spawn });
  assert.equal(none.found, false);
  assert.equal(none.path, null);
});
