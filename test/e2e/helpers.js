'use strict';
/**
 * Shared e2e helpers: build an isolated temp workspace (copy of the engine code + test images),
 * pre-write settings, and launch the app (dev build, or the packaged build when SCM_E2E_PACKAGED=1).
 * The user's real game/, data/ and settings are never touched.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('@playwright/test');

const APP_DIR = path.resolve(__dirname, '..', '..');
const ENGINE = path.resolve(APP_DIR, '..');
const VENV_PY = path.join(ENGINE, 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const SHOTS = path.join(APP_DIR, 'test-results');

/** Temp workspace with the engine code and (optionally) 3 test images in game/front. */
function makeSandbox({ images = 3 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scm-e2e-'));
  const ws = path.join(root, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  for (const f of fs.readdirSync(ENGINE)) {
    if (f.endsWith('.py') || f === 'requirements.txt') fs.copyFileSync(path.join(ENGINE, f), path.join(ws, f));
  }
  for (const d of ['assets', 'plugins', 'cutting_templates', 'calibration']) {
    fs.cpSync(path.join(ENGINE, d), path.join(ws, d), {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !/[\\/]dxf([\\/]|$)/.test(src),
    });
  }
  const front = path.join(ws, 'game', 'front');
  fs.mkdirSync(front, { recursive: true });
  const src = path.join(ENGINE, 'test', 'images');
  for (const f of fs.readdirSync(src).slice(0, images)) fs.copyFileSync(path.join(src, f), path.join(front, f));
  const dirs = { root, ws, userData: path.join(root, 'ud'), data: path.join(root, 'dd'), out: path.join(root, 'out') };
  for (const d of [dirs.userData, dirs.data, dirs.out]) fs.mkdirSync(d, { recursive: true });
  return dirs;
}

function writeSettings(dirs, extra = {}) {
  const settings = {
    setupComplete: true,
    welcomeAccepted: true,
    pythonPath: VENV_PY,
    outputDir: dirs.out,
    equipment: { machine: 'cameo5alpha', paper: 'a4' },
    ...extra,
  };
  fs.writeFileSync(path.join(dirs.userData, 'settings.json'), JSON.stringify(settings, null, 2));
}

async function launch(dirs) {
  const env = {
    ...process.env,
    SCM_USER_DATA_DIR: dirs.userData,
    SCM_DATA_DIR: dirs.data,
    SCM_WORKSPACE_DIR: dirs.ws,
    SCM_NO_AUTO_OPEN: '1',
    SCM_DISABLE_SINGLE_INSTANCE: '1',
    SCM_E2E: '1',
  };
  const packaged = process.env.SCM_E2E_PACKAGED === '1' || process.env.npm_lifecycle_event === 'e2e:packaged';
  const app = await electron.launch(packaged
    ? { executablePath: path.join(APP_DIR, 'dist', 'win-unpacked', 'Silhouette Card Maker.exe'), args: [], env, timeout: 90000 }
    : { args: [APP_DIR], env, timeout: 90000 });
  const win = await app.firstWindow();
  const problems = [];
  win.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  win.on('console', (m) => { if (m.type() === 'error') problems.push(`console.error: ${m.text()}`); });
  win.on('requestfailed', (r) => { if (r.url().startsWith('scm-img:')) problems.push(`image failed: ${r.url()}`); });
  await win.waitForFunction(() => !!window.scm && !!document.querySelector('main h1'), null, { timeout: 60000 });
  return { app, win, problems };
}

async function go(win, route) {
  await win.evaluate((r) => { location.hash = '#/' + r; }, route);
  await win.waitForTimeout(300);
  await win.locator('main h1').first().waitFor({ timeout: 30000 });
}

/** Wait until a job of this kind, finished after `since`, is in the history; returns its summary. */
async function waitForJob(win, kind, since, timeoutMs = 8 * 60 * 1000) {
  // Polled from Node: waitForFunction does not await async predicates.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = await win.evaluate(async ([k, t]) => {
      const active = await window.scm.jobs.active();
      if (active && active.kind === k) return null;
      const hist = await window.scm.jobs.history();
      return hist.find((j) => j.kind === k && (j.endedAt || 0) >= t) || null;
    }, [kind, since]);
    if (done) return done;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for the ${kind} job`);
}

async function shot(win, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await win.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

module.exports = { APP_DIR, ENGINE, VENV_PY, makeSandbox, writeSettings, launch, go, waitForJob, shot };
