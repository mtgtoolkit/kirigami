'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getPaths, venvPython, exe, GAME_KINDS } = require('../../src/main/paths');

const W = path.win32;
const P = path.posix;

const winDev = {
  isPackaged: false,
  appDir: 'D:\\Dev\\card-maker\\electron-app',
  resourcesPath: 'D:\\Dev\\card-maker\\electron-app\\node_modules\\electron\\dist\\resources',
  userData: 'C:\\Users\\me\\AppData\\Roaming\\Silhouette Card Maker (dev)',
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
  userData: 'C:\\Users\\me\\AppData\\Roaming\\Silhouette Card Maker',
};

test('dev on Windows: engine = parent of the app folder, repo venv, data under LOCALAPPDATA (dev)', () => {
  const p = getPaths(winDev);
  assert.equal(p.isDev, true);
  assert.equal(p.engineSourceDir, 'D:\\Dev\\card-maker');
  assert.equal(p.dataDir, 'C:\\Users\\me\\AppData\\Local\\Silhouette Card Maker (dev)');
  assert.equal(p.workspaceDir, 'D:\\Dev\\card-maker');
  assert.equal(p.venvDir, 'D:\\Dev\\card-maker\\venv');
  assert.equal(p.pythonPath, 'D:\\Dev\\card-maker\\venv\\Scripts\\python.exe');
  assert.equal(p.appOwnedVenv, false);
  assert.equal(p.outputDir, 'D:\\Dev\\card-maker\\game\\output');
  assert.equal(p.helperScript, 'D:\\Dev\\card-maker\\electron-app\\src\\python\\scm_helper.py');
  assert.equal(p.bundledUv, 'D:\\Dev\\card-maker\\electron-app\\build\\uv\\uv.exe');
  assert.equal(p.logsDir, W.join(winDev.userData, 'logs'));
  assert.equal(p.scmCacheDir, W.join(p.dataDir, 'scm-cache'));
  assert.equal(p.uvPythonDir, W.join(p.dataDir, 'python'));
  assert.equal(p.uvCacheDir, W.join(p.dataDir, 'uv-cache'));
  assert.equal(p.binDir, W.join(p.dataDir, 'bin'));
  assert.equal(p.cuttingTemplatesDir, 'D:\\Dev\\card-maker\\cutting_templates');
  assert.equal(p.calibrationDir, 'D:\\Dev\\card-maker\\calibration');
  assert.equal(p.samplesDir, 'D:\\Dev\\card-maker\\examples\\ZERO SUMZ');
  assert.equal(p.gameDir('front'), 'D:\\Dev\\card-maker\\game\\front');
  assert.equal(p.gameDir('double_sided'), 'D:\\Dev\\card-maker\\game\\double_sided');
  assert.equal(p.gameDir('decklist'), 'D:\\Dev\\card-maker\\game\\decklist');
  assert.equal(p.upscaledRoot, 'D:\\Dev\\card-maker\\game\\upscaled');
  assert.equal(p.upscaledDir('back'), 'D:\\Dev\\card-maker\\game\\upscaled\\back');
  assert.equal(p.stageRoot, 'D:\\Dev\\card-maker\\game\\.stage');
  assert.equal(p.trashRoot, 'D:\\Dev\\card-maker\\game\\.trash');
  assert.equal(p.dataPath, 'D:\\Dev\\card-maker\\data\\offset_data.json');
  assert.equal(p.settingsFile, W.join(winDev.userData, 'settings.json'));
  assert.equal(p.previewDir, W.join(p.scmCacheDir, 'preview'));
  assert.equal(p.tmpDir, W.join(p.scmCacheDir, 'tmp'));
});

test('packaged on Windows: bundled engine, app-owned venv, workspace and output in user folders', () => {
  const p = getPaths(winPackaged);
  assert.equal(p.isDev, false);
  assert.equal(p.engineSourceDir, 'C:\\Program Files\\SCM\\resources\\engine');
  assert.equal(p.dataDir, 'C:\\Users\\me\\AppData\\Local\\Silhouette Card Maker');
  assert.equal(p.workspaceDir, W.join(p.dataDir, 'workspace'));
  assert.equal(p.venvDir, W.join(p.dataDir, 'venv'));
  assert.equal(p.pythonPath, W.join(p.dataDir, 'venv', 'Scripts', 'python.exe'));
  assert.equal(p.appOwnedVenv, true);
  assert.equal(p.outputDir, 'C:\\Users\\me\\Documents\\Silhouette Card Maker');
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
    userData: '/home/me/.config/Silhouette Card Maker',
    documents: '/home/me/Documents',
    localAppData: '/should/be/ignored',
    platform: 'linux',
    env: {},
    settings: {},
  });
  assert.equal(p.dataDir, '/home/me/.config/Silhouette Card Maker/data');
  assert.equal(p.workspaceDir, '/home/me/.config/Silhouette Card Maker/data/workspace');
  assert.equal(p.pythonPath, '/home/me/.config/Silhouette Card Maker/data/venv/bin/python');
  assert.equal(p.bundledUv, '/opt/scm/resources/bin/uv');
  assert.equal(p.outputDir, P.join('/home/me/Documents', 'Silhouette Card Maker'));
  assert.equal(p.logsDir, '/home/me/.config/Silhouette Card Maker/logs');
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
  assert.equal(q.dataDir, 'C:\\Users\\me\\AppData\\Local\\Silhouette Card Maker');
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

test('dev is never app-owned, even without custom settings', () => {
  assert.equal(getPaths(winDev).appOwnedVenv, false);
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
