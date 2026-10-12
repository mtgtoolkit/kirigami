'use strict';

/**
 * Every filesystem location the app uses, computed from plain inputs (PURE: no Electron, no I/O).
 * main.js builds the inputs from Electron (`app.getPath`, `process.resourcesPath`, …) and the
 * current settings: `deps.getPaths = () => getPaths({ ...electronValues, settings: settings.get() })`.
 */

const path = require('node:path');

/** Folder names that live directly under `<workspace>/game/`. */
const GAME_KINDS = Object.freeze(['front', 'back', 'double_sided', 'decklist', 'output']);
/** Kinds that can be upscaled (sub-folders of `<workspace>/game/upscaled/`). */
const UPSCALE_KINDS = Object.freeze(['front', 'back', 'double_sided']);

const DEV_DATA_FOLDER = 'Kirigami (dev)';
const DATA_FOLDER = 'Kirigami';

function pathApi(platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Executable file name for the platform (`uv` → `uv.exe` on Windows).
 * @param {string} name
 * @param {string} [platform=process.platform]
 * @returns {string}
 */
function exe(name, platform = process.platform) {
  return platform === 'win32' ? `${name}.exe` : name;
}

/**
 * Python interpreter inside a virtual environment.
 * @param {string} venvDir
 * @param {string} [platform=process.platform]
 * @returns {string} `<venv>\Scripts\python.exe` on Windows, `<venv>/bin/python` elsewhere
 */
function venvPython(venvDir, platform = process.platform) {
  const p = pathApi(platform);
  return platform === 'win32' ? p.join(venvDir, 'Scripts', 'python.exe') : p.join(venvDir, 'bin', 'python');
}

/**
 * Compute all app paths (spec §3).
 *
 * @param {object} input
 * @param {boolean} input.isPackaged      app.isPackaged
 * @param {string} input.appDir           app.getAppPath() (dev: the electron-app folder; packaged: …/resources/app.asar)
 * @param {string} [input.resourcesPath]  process.resourcesPath (required when packaged)
 * @param {string} input.userData         app.getPath('userData')
 * @param {string} [input.appData]        app.getPath('appData')
 * @param {string} [input.documents]      app.getPath('documents')
 * @param {string|null} [input.localAppData] %LOCALAPPDATA% (Windows)
 * @param {string} [input.platform]       process.platform
 * @param {object} [input.env]            environment (SCM_DATA_DIR, SCM_WORKSPACE_DIR overrides)
 * @param {object} [input.settings]       current settings (workspaceDir, venvDir, pythonPath, outputDir)
 * @returns {Readonly<object>} paths; see spec §3 (+ extras: platform, appDir, resourcesPath, userData,
 *   settingsFile, tmpDir, previewDir, mplDir, calibrationCacheDir, jobsLogDir, decklistDir)
 */
function getPaths(input = {}) {
  const platform = nonEmptyString(input.platform) || process.platform;
  const p = pathApi(platform);
  const env = input.env && typeof input.env === 'object' ? input.env : {};
  const settings = input.settings && typeof input.settings === 'object' ? input.settings : {};
  const isPackaged = !!input.isPackaged;
  const isDev = !isPackaged;

  const appDir = nonEmptyString(input.appDir);
  const resourcesPath = nonEmptyString(input.resourcesPath);
  const userData = nonEmptyString(input.userData);
  if (!userData) throw new TypeError('getPaths: userData is required');
  if (isDev && !appDir) throw new TypeError('getPaths: appDir is required in development');
  if (isPackaged && !resourcesPath) throw new TypeError('getPaths: resourcesPath is required when packaged');
  if (isPackaged && !appDir) throw new TypeError('getPaths: appDir is required');

  const settingWorkspace = nonEmptyString(settings.workspaceDir);
  const settingVenv = nonEmptyString(settings.venvDir);
  const settingPython = nonEmptyString(settings.pythonPath);
  const settingOutput = nonEmptyString(settings.outputDir);
  const envData = nonEmptyString(env.SCM_DATA_DIR);
  const envWorkspace = nonEmptyString(env.SCM_WORKSPACE_DIR);
  const localAppData = nonEmptyString(input.localAppData);

  const engineSourceDir = isDev ? p.resolve(appDir, '..') : p.join(resourcesPath, 'engine');

  let dataDir;
  if (envData) dataDir = p.resolve(envData);
  else if (platform === 'win32' && localAppData) dataDir = p.join(localAppData, isDev ? DEV_DATA_FOLDER : DATA_FOLDER);
  else dataDir = p.join(userData, 'data');

  const workspaceDir = envWorkspace ? p.resolve(envWorkspace)
    : settingWorkspace ? p.resolve(settingWorkspace)
      : isDev ? engineSourceDir : p.join(dataDir, 'workspace');
  const venvDir = settingVenv ? p.resolve(settingVenv) : isDev ? p.join(engineSourceDir, 'venv') : p.join(dataDir, 'venv');
  const pythonPath = settingPython ? p.resolve(settingPython) : venvPython(venvDir, platform);
  const appOwnedVenv = !settingVenv && !settingPython && !isDev;

  const scmCacheDir = p.join(dataDir, 'scm-cache');
  const logsDir = p.join(userData, 'logs');
  const documents = nonEmptyString(input.documents);
  const defaultPackagedOutput = documents ? p.join(documents, DATA_FOLDER) : p.join(dataDir, 'output');
  const outputDir = settingOutput ? p.resolve(settingOutput) : isDev ? p.join(workspaceDir, 'game', 'output') : defaultPackagedOutput;
  const upscaledRoot = p.join(workspaceDir, 'game', 'upscaled');

  /**
   * `<workspace>/game/<kind>` for front|back|double_sided|decklist|output.
   * @param {string} kind
   * @returns {string}
   */
  function gameDir(kind) {
    if (!GAME_KINDS.includes(kind)) throw new TypeError(`Unknown game folder "${kind}"`);
    return p.join(workspaceDir, 'game', kind);
  }

  /**
   * `<workspace>/game/upscaled/<kind>` for front|back|double_sided.
   * @param {string} kind
   * @returns {string}
   */
  function upscaledDir(kind) {
    if (!UPSCALE_KINDS.includes(kind)) throw new TypeError(`Unknown upscale folder "${kind}"`);
    return p.join(upscaledRoot, kind);
  }

  return Object.freeze({
    isDev,
    isPackaged,
    platform,
    appDir,
    resourcesPath,
    userData,
    engineSourceDir,
    dataDir,
    workspaceDir,
    venvDir,
    pythonPath,
    appOwnedVenv,
    uvPythonDir: p.join(dataDir, 'python'),
    uvCacheDir: p.join(dataDir, 'uv-cache'),
    binDir: p.join(dataDir, 'bin'),
    scmCacheDir,
    logsDir,
    helperScript: isDev
      ? p.join(appDir, 'src', 'python', 'scm_helper.py')
      : p.join(resourcesPath, 'app.asar.unpacked', 'src', 'python', 'scm_helper.py'),
    bundledUv: isDev ? p.join(appDir, 'build', 'uv', exe('uv', platform)) : p.join(resourcesPath, 'bin', exe('uv', platform)),
    cuttingTemplatesDir: p.join(engineSourceDir, 'cutting_templates'),
    calibrationDir: p.join(engineSourceDir, 'calibration'),
    samplesDir: p.join(engineSourceDir, 'examples', 'ZERO SUMZ'),
    outputDir,
    gameDir,
    upscaledRoot,
    upscaledDir,
    stageRoot: p.join(workspaceDir, 'game', '.stage'),
    trashRoot: p.join(workspaceDir, 'game', '.trash'),
    dataPath: p.join(workspaceDir, 'data', 'offset_data.json'),
    // extras (derived; documented in the module JSDoc)
    decklistDir: p.join(workspaceDir, 'game', 'decklist'),
    settingsFile: p.join(userData, 'settings.json'),
    jobsLogDir: p.join(logsDir, 'jobs'),
    tmpDir: p.join(scmCacheDir, 'tmp'),
    previewDir: p.join(scmCacheDir, 'preview'),
    mplDir: p.join(scmCacheDir, 'mpl'),
    calibrationCacheDir: p.join(scmCacheDir, 'calibration'),
  });
}

module.exports = { getPaths, venvPython, exe, GAME_KINDS, UPSCALE_KINDS };
