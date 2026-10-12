'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const { makeSandbox, writeSettings, launch, go, waitForJob, shot } = require('./helpers');

const ROUTES = ['setup', 'fetch', 'cards', 'upscale', 'pdf', 'print', 'offset', 'settings'];
const UPSCALE = process.env.SCM_E2E_UPSCAYL === '1';

test.describe.configure({ mode: 'serial' });

test.describe('Silhouette Card Maker desktop app', () => {
  let dirs; let app; let win; let problems;

  test.beforeAll(async () => {
    dirs = makeSandbox();
    // Upscaling is opt-in for the suite (it depends on the machine's GPU).
    writeSettings(dirs, { upscayl: { enabled: UPSCALE, askedOnce: true } });
    ({ app, win, problems } = await launch(dirs));
  });

  test.afterAll(async () => {
    if (app) await app.close().catch(() => {});
    if (dirs) fs.rmSync(dirs.root, { recursive: true, force: true, maxRetries: 5 });
  });

  test('every screen renders without errors', async () => {
    for (const r of ROUTES) {
      await go(win, r);
      await win.waitForTimeout(1500);
      await shot(win, `view-${r}`);
    }
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('Make PDF: Create PDF produces a file', async () => {
    // Quick PDF: fronts only at 300 PPI (the default 1440 PPI is slow for a test).
    await win.evaluate(() => window.scm.settings.update({ pdf: { options: { ppi: 300 }, fileName: 'e2e-proxies' } }));
    await go(win, 'pdf');
    const create = win.getByRole('button', { name: /^Create (PDF|PNG pages)$/ });
    await expect(create).toBeEnabled({ timeout: 60000 });
    const since = Date.now();
    await create.click();
    const job = await waitForJob(win, 'pdf', since);
    await win.waitForTimeout(1000);
    await shot(win, 'pdf-result');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const pdf = path.join(dirs.out, 'e2e-proxies.pdf');
    expect(fs.existsSync(pdf)).toBe(true);
    expect(fs.statSync(pdf).size).toBeGreaterThan(10000);
    if (UPSCALE) expect(fs.readdirSync(path.join(dirs.ws, 'game', 'upscaled', 'front')).length).toBeGreaterThan(0);
    expect(problems, problems.join('\n')).toEqual([]);
  });

  test('Get cards: an MTG Arena list downloads the cards (needs internet)', async () => {
    test.skip(process.env.SCM_E2E_OFFLINE === '1', 'offline run');
    await win.evaluate(() => window.scm.settings.update({
      fetch: {
        plugin: 'mtg', formatByPlugin: { mtg: 'mtga' }, clearBeforeFetch: false,
        source: { kind: 'text', deckName: 'e2e-deck', text: '1 Lightning Bolt\n1 Llanowar Elves\n' },
      },
    }));
    await go(win, 'fetch');
    const before = (await win.evaluate(() => window.scm.cards.summary())).front;
    const download = win.getByRole('button', { name: 'Download cards' });
    await expect(download).toBeEnabled({ timeout: 30000 });
    const since = Date.now();
    await download.click();
    const job = await waitForJob(win, 'fetch', since);
    await win.waitForTimeout(1000);
    await shot(win, 'fetch-result');
    expect(job.status, JSON.stringify(job.error)).toBe('succeeded');
    const after = (await win.evaluate(() => window.scm.cards.summary())).front;
    expect(after).toBe(before + 2);
    expect(problems, problems.join('\n')).toEqual([]);
  });
});
