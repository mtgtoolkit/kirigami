'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getPaths, venvPython, exe, GAME_KINDS } = require('../../src/main/paths');

const W = path.win32;
const P = path.posix;

const winDev = {
  isPackaged: false,
  appDir: 'D:\\Dev\\kirigami',
  resourcesPath: 'D:\\Dev\\kirigami\\node_modules\\electron\\dist\\resources',
  userData: 'C:\\Users\\me\\AppData\\Roaming\\Kirigami (dev)',
  appData: 'C:\\Users\\me\\AppData\\Roaming',
  documents: 'C:\\Users\\me\\Documents',
  localAppData: 'C:\\Users\\me\\AppData\\Local',
  platform: 'win32',
  env: {},
  settings: {},
};

const winPackaged = {
  ...winDev,
  isPackaged: true,
  appDir: 'C:\\Program Files\\SCM\\resources\\app.asar',
  resourcesPath: 'C:\\Program Files\\SCM\\resources',
  userData: 'C:\\Users\\me\\AppData\\Roaming\\Kirigami',
};

test('dev on Windows: managed engine from build/engine, app-owned venv and workspace under LOCALAPPDATA (dev)', () => {
  const p = getPaths(winDev);
  const data = 'C:\\Users\\me\\AppData\\Local\\Kirigami (dev)';
  const ws = `${data}\\workspace`;
  assert.equal(p.isDev, true);
  assert.equal(p.engineMode, 'managed');
  assert.equal(p.bundledEngineDir, 'D:\\Dev\\kirigami\\build\\engine');
  assert.equal(p.engineSourceDir, 'D:\\Dev\\kirigami\\build\\engine');
  assert.equal(p.enginesDir, `${data}\\engines`);
  assert.equal(p.dataDir, data);
  assert.equal(p.workspaceDir, ws);
  assert.equal(p.venvDir, `${data}\\venv`);
  assert.equal(p.pythonPath, `${data}\\venv\\Scripts\\python.exe`);
  assert.equal(p.appOwnedVenv, true);
  assert.equal(p.outputDir, `${ws}\\game\\output`);
  assert.equal(p.helperScript, 'D:\\Dev\\kirigami\\src\\python\\scm_helper.py');
  assert.equal(p.bundledUv, 'D:\\Dev\\kirigami\\build\\uv\\uv.exe');
  assert.equal(p.logsDir, W.join(winDev.userData, 'logs'));
  assert.equal(p.scmCacheDir, W.join(p.dataDir, 'scm-cache'));
  assert.equal(p.uvPythonDir, W.join(p.dataDir, 'python'));
  assert.equal(p.uvCacheDir, W.join(p.dataDir, 'uv-cache'));
  assert.equal(p.binDir, W.join(p.dataDir, 'bin'));
  assert.equal(p.cuttingTemplatesDir, 'D:\\Dev\\kirigami\\build\\engine\\cutting_templates');
  assert.equal(p.calibrationDir, 'D:\\Dev\\kirigami\\build\\engine\\calibration');
  assert.equal(p.samplesDir, 'D:\\Dev\\kirigami\\build\\engine\\examples\\ZERO SUMZ');
  assert.equal(p.gameDir('front'), `${ws}\\game\\front`);
  assert.equal(p.gameDir('double_sided'), `${ws}\\game\\double_sided`);
  assert.equal(p.gameDir('decklist'), `${ws}\\game\\decklist`);
  assert.equal(p.upscaledRoot, `${ws}\\game\\upscaled`);
  assert.equal(p.upscaledDir('back'), `${ws}\\game\\upscaled\\back`);
  assert.equal(p.stageRoot, `${ws}\\game\\.stage`);
  assert.equal(p.trashRoot, `${ws}\\game\\.trash`);
  assert.equal(p.dataPath, `${ws}\\data\\offset_data.json`);
  assert.equal(p.settingsFile, W.join(winDev.userData, 'settings.json'));
  assert.equal(p.previewDir, W.join(p.scmCacheDir, 'preview'));
  assert.equal(p.tmpDir, W.join(p.scmCacheDir, 'tmp'));
});

test('linked engine (SCM_ENGINE_DIR): the checkout is engine, workspace and venv, and is not app-owned', () => {
  const engine = 'D:\\Dev\\silhouette-card-maker';
  for (const base of [winDev, winPackaged]) {
    const p = getPaths({ ...base, env: { SCM_ENGINE_DIR: engine }, engineDir: 'C:\\ignored\\engines\\abc' });
    assert.equal(p.engineMode, 'linked');
    assert.equal(p.engineSourceDir, engine);
    assert.equal(p.workspaceDir, engine);
    assert.equal(p.venvDir, `${engine}\\venv`);
    assert.equal(p.pythonPath, `${engine}\\venv\\Scripts\\python.exe`);
    assert.equal(p.appOwnedVenv, false);
    assert.equal(p.cuttingTemplatesDir, `${engine}\\cutting_templates`);
    assert.equal(p.calibrationDir, `${engine}\\calibration`);
    assert.equal(p.gameDir('front'), `${engine}\\game\\front`);
    assert.equal(p.bundledEngineDir, base.isPackaged ? 'C:\\Program Files\\SCM\\resources\\engine' : 'D:\\Dev\\kirigami\\build\\engine');
  }
  assert.equal(getPaths({ ...winDev, env: { SCM_ENGINE_DIR: engine } }).outputDir, `${engine}\\game\\output`);
  // The other overrides still win over the linked defaults; a relative folder is resolved; blank is ignored.
  const o = getPaths({ ...winDev, env: { SCM_ENGINE_DIR: engine, SCM_WORKSPACE_DIR: 'E:\\ws' }, settings: { pythonPath: 'C:\\Py\\python.exe' } });
  assert.equal(o.workspaceDir, 'E:\\ws');
  assert.equal(o.pythonPath, 'C:\\Py\\python.exe');
  assert.equal(getPaths({ ...winDev, env: { SCM_ENGINE_DIR: '  ' } }).engineMode, 'managed');
  assert.equal(getPaths({ ...winDev, platform: 'linux', env: { SCM_ENGINE_DIR: '/src/scm' } }).engineSourceDir, '/src/scm');
});

test('managed engine: input.engineDir (a downloaded engine) replaces the bundled one', () => {
  const downloaded = 'C:\\Users\\me\\AppData\\Local\\Kirigami\\engines\\0da09b729814aa5aafde024b5a6059624fa87951';
  const p = getPaths({ ...winPackaged, engineDir: downloaded });
  assert.equal(p.engineMode, 'managed');
  assert.equal(p.engineSourceDir, downloaded);
  assert.equal(p.bundledEngineDir, 'C:\\Program Files\\SCM\\resources\\engine');
  assert.equal(p.enginesDir, 'C:\\Users\\me\\AppData\\Local\\Kirigami\\engines');
  assert.equal(p.cuttingTemplatesDir, `${downloaded}\\cutting_templates`);
  assert.equal(p.calibrationDir, `${downloaded}\\calibration`);
  assert.equal(p.workspaceDir, W.join(p.dataDir, 'workspace'), 'the workspace does not move with the engine');
  assert.equal(p.appOwnedVenv, true);
  // undefined / blank means "the bundled engine"
  assert.equal(getPaths({ ...winPackaged, engineDir: undefined }).engineSourceDir, p.bundledEngineDir);
  assert.equal(getPaths({ ...winDev, engineDir: ' ' }).engineSourceDir, 'D:\\Dev\\kirigami\\build\\engine');
});

test('packaged on Windows: bundled engine, app-owned venv, workspace and output in user folders', () => {
  const p = getPaths(winPackaged);
  assert.equal(p.isDev, false);
  assert.equal(p.engineMode, 'managed');
  assert.equal(p.engineSourceDir, 'C:\\Program Files\\SCM\\resources\\engine');
  assert.equal(p.bundledEngineDir, p.engineSourceDir);
  assert.equal(p.enginesDir, 'C:\\Users\\me\\AppData\\Local\\Kirigami\\engines');
  assert.equal(p.dataDir, 'C:\\Users\\me\\AppData\\Local\\Kirigami');
  assert.equal(p.workspaceDir, W.join(p.dataDir, 'workspace'));
  assert.equal(p.venvDir, W.join(p.dataDir, 'venv'));
  assert.equal(p.pythonPath, W.join(p.dataDir, 'venv', 'Scripts', 'python.exe'));
  assert.equal(p.appOwnedVenv, true);
  assert.equal(p.outputDir, 'C:\\Users\\me\\Documents\\Kirigami');
  assert.equal(p.helperScript, 'C:\\Program Files\\SCM\\resources\\app.asar.unpacked\\src\\python\\scm_helper.py');
  assert.equal(p.bundledUv, 'C:\\Program Files\\SCM\\resources\\bin\\uv.exe');
  assert.equal(p.cuttingTemplatesDir, 'C:\\Program Files\\SCM\\resources\\engine\\cutting_templates');
  assert.equal(p.gameDir('output'), W.join(p.workspaceDir, 'game', 'output'));
});

test('Windows without LOCALAPPDATA falls back to <userData>/data', () => {
  const p = getPaths({ ...winPackaged, localAppData: null });
  assert.equal(p.dataDir, W.join(winPackaged.userData, 'data'));
  const d = getPaths({ ...winDev, localAppData: '' });
  assert.equal(d.dataDir, W.join(winDev.userData, 'data'));
});

test('packaged on Linux: data under userData, POSIX venv python, uv without .exe', () => {
  const p = getPaths({
    isPackaged: true,
    appDir: '/opt/scm/resources/app.asar',
    resourcesPath: '/opt/scm/resources',
    userData: '/home/me/.config/Kirigami',
    documents: '/home/me/Documents',
    localAppData: '/should/be/ignored',
    platform: 'linux',
    env: {},
    settings: {},
  });
  assert.equal(p.dataDir, '/home/me/.config/Kirigami/data');
  assert.equal(p.workspaceDir, '/home/me/.config/Kirigami/data/workspace');
  assert.equal(p.pythonPath, '/home/me/.config/Kirigami/data/venv/bin/python');
  assert.equal(p.bundledUv, '/opt/scm/resources/bin/uv');
  assert.equal(p.outputDir, P.join('/home/me/Documents', 'Kirigami'));
  assert.equal(p.logsDir, '/home/me/.config/Kirigami/logs');
});

test('environment overrides win over settings and defaults', () => {
  const p = getPaths({
    ...winPackaged,
    env: { SCM_DATA_DIR: 'E:\\tmp\\scm-data', SCM_WORKSPACE_DIR: 'E:\\tmp\\ws' },
    settings: { workspaceDir: 'F:\\ignored-workspace' },
  });
  assert.equal(p.dataDir, 'E:\\tmp\\scm-data');
  assert.equal(p.workspaceDir, 'E:\\tmp\\ws');
  assert.equal(p.venvDir, 'E:\\tmp\\scm-data\\venv');
  assert.equal(p.scmCacheDir, 'E:\\tmp\\scm-data\\scm-cache');
  assert.equal(p.gameDir('front'), 'E:\\tmp\\ws\\game\\front');
  assert.equal(p.dataPath, 'E:\\tmp\\ws\\data\\offset_data.json');
  // empty strings are ignored
  const q = getPaths({ ...winPackaged, env: { SCM_DATA_DIR: '', SCM_WORKSPACE_DIR: '  ' } });
  assert.equal(q.dataDir, 'C:\\Users\\me\\AppData\\Local\\Kirigami');
});

test('settings override workspace, venv, python and output; custom python/venv is not app-owned', () => {
  const ws = getPaths({ ...winPackaged, settings: { workspaceDir: 'F:\\Cards' } });
  assert.equal(ws.workspaceDir, 'F:\\Cards');
  assert.equal(ws.gameDir('back'), 'F:\\Cards\\game\\back');
  assert.equal(ws.appOwnedVenv, true);

  const venv = getPaths({ ...winPackaged, settings: { venvDir: 'F:\\venvs\\scm' } });
  assert.equal(venv.venvDir, 'F:\\venvs\\scm');
  assert.equal(venv.pythonPath, 'F:\\venvs\\scm\\Scripts\\python.exe');
  assert.equal(venv.appOwnedVenv, false);

  const py = getPaths({ ...winPackaged, settings: { pythonPath: 'C:\\Python312\\python.exe' } });
  assert.equal(py.pythonPath, 'C:\\Python312\\python.exe');
  assert.equal(py.venvDir, W.join(py.dataDir, 'venv'));
  assert.equal(py.appOwnedVenv, false);

  const out = getPaths({ ...winDev, settings: { outputDir: 'G:\\PDFs' } });
  assert.equal(out.outputDir, 'G:\\PDFs');

  // null / non-string settings are ignored
  const n = getPaths({ ...winPackaged, settings: { workspaceDir: null, venvDir: 42, pythonPath: '' } });
  assert.equal(n.workspaceDir, W.join(n.dataDir, 'workspace'));
  assert.equal(n.appOwnedVenv, true);
});

test('the venv is app-owned unless an engine is linked or a custom Python/venv is set', () => {
  assert.equal(getPaths(winDev).appOwnedVenv, true);
  assert.equal(getPaths(winPackaged).appOwnedVenv, true);
  assert.equal(getPaths({ ...winDev, env: { SCM_ENGINE_DIR: 'D:\\Dev\\scm' } }).appOwnedVenv, false);
  assert.equal(getPaths({ ...winDev, settings: { venvDir: 'D:\\venv' } }).appOwnedVenv, false);
});

test('gameDir / upscaledDir only accept known kinds', () => {
  const p = getPaths(winDev);
  for (const kind of GAME_KINDS) assert.ok(p.gameDir(kind).endsWith(kind));
  assert.throws(() => p.gameDir('upscaled'), TypeError);
  assert.throws(() => p.gameDir('..'), TypeError);
  assert.throws(() => p.upscaledDir('decklist'), TypeError);
  assert.equal(p.upscaledDir('double_sided'), W.join(p.upscaledRoot, 'double_sided'));
});

test('result is frozen and required inputs are validated', () => {
  const p = getPaths(winDev);
  assert.ok(Object.isFrozen(p));
  assert.throws(() => getPaths({ ...winDev, userData: '' }), TypeError);
  assert.throws(() => getPaths({ ...winDev, appDir: undefined }), TypeError);
  assert.throws(() => getPaths({ ...winPackaged, resourcesPath: undefined }), TypeError);
});

test('packaged without a documents folder keeps output inside the data folder', () => {
  const p = getPaths({ ...winPackaged, documents: undefined });
  assert.equal(p.outputDir, W.join(p.dataDir, 'output'));
});

test('exe() and venvPython()', () => {
  assert.equal(exe('uv', 'win32'), 'uv.exe');
  assert.equal(exe('uv', 'darwin'), 'uv');
  assert.equal(venvPython('C:\\v', 'win32'), 'C:\\v\\Scripts\\python.exe');
  assert.equal(venvPython('/v', 'linux'), '/v/bin/python');
});
