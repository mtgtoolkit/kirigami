/**
 * Settings view (`#/settings`, spec §8.4 "Settings", §13.3).
 *
 * Sections: Equipment (paper + cutting machine → also the PDF paper size and registration marks),
 * Card maker data folder (open / change / back to default), Card maker components (status, repair,
 * another Python, install into it, back to the app's own components), Upscayl (program, models,
 * extra models folder, detect again), PDF folder, Appearance (theme, advanced options by default),
 * Storage (upscaled pictures cache, Recently removed, data folder), Help and logs, About, and
 * Reset all settings.
 *
 * Every section is re-rendered only when the data it shows changes (keyed renders), keeping keyboard
 * focus on the same control. Protected settings (folders, Python, Upscayl paths) always go through
 * their validated APIs; the rest through `scm.settings.update`.
 *
 * @module views/settings
 */

import * as ui from '../core/ui.js';
import { nextStep } from '../components/next-step.js';
import { EXTERNAL_LINKS, getHelpLink } from '../data/help.js';
import {
  slot, swap, fk, isJobRunning, busyMessage, openLink, openFolder, refreshAppInfo, saveSettings, infoRow,
  componentsSummary, componentsButtons, setupFixButtons, createSetupMonitor, locateUpscayl, gpuText,
  equipmentEditor, equipmentFromSettings, equipmentPatch, frameThrottle, chooseOtherPython, useDefaultPython,
  repairInAppLocation, startSetup, afterEnvChange, applyUpscaylStatus, failureMessage, usesAppLocationVenv,
} from './setup.js';

const { h } = ui;

/** In-page links under the header: [section element id, label]. */
const SECTION_LINKS = Object.freeze([
  ['settings-equipment', 'Equipment'],
  ['settings-workspace', 'Data folder'],
  ['settings-components', 'Components'],
  ['settings-upscayl', 'Upscayl'],
  ['settings-output', 'PDF folder'],
  ['settings-appearance', 'Appearance'],
  ['settings-storage', 'Storage'],
  ['settings-help', 'Help and logs'],
  ['settings-about', 'About'],
  ['settings-reset', 'Reset'],
]);

/**
 * A slot that re-renders only when its key changes.
 * @param {string} name
 * @param {() => string} keyFn
 * @param {() => unknown} renderFn
 * @returns {{ el: HTMLElement, update(force?: boolean): void }}
 */
function keyedSection(name, keyFn, renderFn) {
  const el = slot(name);
  let last = null;
  return {
    el,
    update(force = false) {
      const key = keyFn();
      if (!force && key === last) return;
      last = key;
      swap(el, renderFn());
    },
  };
}

/**
 * Wrap a section body in the standard section + card look.
 * @param {{ id: string, title: string, description?: string, icon: string, children: unknown, actions?: unknown, variant?: string }} o
 * @returns {HTMLElement}
 */
function settingsSection({ id, title, description, icon, children, actions, variant }) {
  return ui.section({ id, title, description, icon, actions, children: ui.card({ children, variant }) });
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',

  /**
   * @param {HTMLElement} container
   * @param {object} ctx
   */
  mount(container, ctx) {
    const { api, store, format } = ctx;
    const view = {
      pending: null,
      cache: { loading: true },
      trash: { loading: true },
    };
    const monitor = createSetupMonitor(ctx, { logOpen: false, logHeight: 200 });

    const settings = () => store.get('settings') || {};
    const env = () => store.get('env') || null;
    const appInfo = () => store.get('appInfo') || {};
    const job = () => store.get('job');
    const busy = () => isJobRunning(job());
    const busyTitle = () => busyMessage(job()) || undefined;

    /* ------------------------------------------------------------------ attention */

    const attention = keyedSection('attention',
      () => JSON.stringify([env()?.ready, env()?.python?.code, settings().setupComplete, busy()]),
      () => {
        const e = env();
        if (!e || e.ready) return null;
        if (!settings().setupComplete) {
          return ui.callout({
            variant: 'info',
            title: 'Finish the one-time setup',
            message: 'A few things are needed before you can make cards.',
            actions: [{ label: 'Open setup', variant: 'primary', icon: 'arrow-right', onClick: () => ctx.navigate('setup') }],
          });
        }
        return ui.callout({
          variant: 'warning',
          title: 'The card maker components need attention',
          message: 'They are needed to download cards and make PDFs.',
          actions: [{ label: 'Show me', icon: 'arrow-down', onClick: () => document.getElementById('settings-components')?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }],
        });
      });

    /* ------------------------------------------------------------------ equipment */

    const equipment = keyedSection('equipment',
      () => JSON.stringify([settings().equipment, settings().pdf?.options?.paper_size, settings().pdf?.options?.registration, appInfo().country]),
      () => settingsSection({
        id: 'settings-equipment',
        title: 'Equipment',
        description: 'Your paper and cutting machine. They set the paper size and registration marks of your PDFs.',
        icon: 'scissors',
        children: equipmentEditor({
          compact: true,
          value: equipmentFromSettings(settings(), appInfo()),
          onChange: async (next) => {
            try {
              await saveSettings(ctx, equipmentPatch(next));
            } catch (err) {
              ui.showError(err, { title: 'Could not save your equipment' });
              equipment.update(true);
            }
          },
        }),
      }));

    /* ------------------------------------------------------------------ data folder */

    async function changeWorkspace(dir) {
      const target = dir === undefined
        ? await api.dialog.openFolder({ purpose: 'workspace', title: 'Choose the card maker data folder' })
        : dir;
      if (target === undefined || (dir === undefined && !target)) return;
      const toDefault = target === null;
      const ok = await ui.confirmDialog({
        title: toDefault ? 'Go back to the default folder?' : 'Use this folder for your cards?',
        message: h('div.stack', { style: { '--gap': '10px' } },
          toDefault ? null : h('p.mono.small', { style: { overflowWrap: 'anywhere' } }, target),
          h('p', 'Your current cards, deck lists and printer alignment stay where they are. From now on the app uses the cards in the new folder (it prepares the card maker files there if needed).')),
        confirmLabel: toDefault ? 'Use the default folder' : 'Use this folder',
      });
      if (!ok) return;
      try {
        const status = await api.env.setWorkspace(target);
        await afterEnvChange(ctx, status);
        ctx.refresh.cards();
        ui.toast({ variant: 'success', title: 'Card maker data folder changed', message: ctx.store.get('appInfo')?.paths?.workspace || undefined });
      } catch (err) {
        ui.showError(err, { title: "Couldn't use this folder" });
      }
    }

    const dataFolder = keyedSection('workspace',
      () => JSON.stringify([env()?.workspace, settings().workspaceDir, appInfo().paths?.workspace, busy()]),
      () => {
        const ws = env()?.workspace || null;
        const where = ws?.path || appInfo().paths?.workspace || null;
        const custom = !!settings().workspaceDir;
        let message;
        let tone = 'muted';
        if (!ws) message = 'Checking…';
        else if (ws.ok) message = ws.external ? 'A card maker folder on this computer, used as it is.' : 'Prepared and managed by the app.';
        else if (ws.needsUpdate) message = 'It will be prepared the next time the components are set up.';
        else {
          message = ws.error || 'The card maker files could not be found here.';
          tone = 'danger';
        }
        return settingsSection({
          id: 'settings-workspace',
          title: 'Card maker data folder',
          description: 'Holds your card pictures, deck lists and printer alignment.',
          icon: 'folder',
          children: [
            infoRow({
              icon: tone === 'danger' ? 'alert-circle' : 'folder-open',
              tone,
              title: where ? h('span', { style: { overflowWrap: 'anywhere' } }, where) : 'Not set',
              message,
              actions: [
                where && ui.button({ label: 'Open', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => openFolder(ctx, where) }),
                fk(ui.button({ label: 'Change…', size: 'sm', disabled: busy(), title: busyTitle(), onClick: () => changeWorkspace() }), 'ws-change'),
                custom && ui.button({ label: 'Use default', icon: 'undo', size: 'sm', variant: 'ghost', disabled: busy(), title: busyTitle(), onClick: () => changeWorkspace(null) }),
              ],
            }),
            h('p.small.muted', 'Changing the folder does not move your cards. Your PDFs go to the PDF folder below.'),
          ],
        });
      });

    /* ------------------------------------------------------------------ components */

    function setPending(label) {
      view.pending = label;
      components.update();
    }

    async function pendingWhile(label, fn) {
      setPending(label);
      try {
        return await fn();
      } finally {
        setPending(null);
      }
    }

    const components = keyedSection('components',
      () => {
        const e = env();
        const j = job();
        const last = store.get('lastResults')?.setup;
        return JSON.stringify([e ? [e.ready, e.busy, e.python, e.workspace?.ok] : null, j ? [j.jobId, j.kind, j.status] : null,
          last ? [last.jobId, last.status, last.error?.code] : null, view.pending, settings().pythonPath || null]);
      },
      () => {
        const e = env();
        const j = job();
        const py = e?.python || {};
        const summary0 = componentsSummary(e, j);
        const summary = view.pending ? { ...summary0, status: 'running', message: view.pending } : summary0;
        const last = store.get('lastResults')?.setup;
        const failure = last && last.status === 'failed' && !e?.ready && !busy() && last.error ? last.error : null;
        const isBusy = busy();
        const extra = [];
        if (summary.status !== 'running') {
          extra.push(fk(ui.button({ label: 'Use a different Python…', icon: 'folder-open', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => pendingWhile('Checking the Python you chose…', () => chooseOtherPython(ctx)) }), 'py-choose'));
          if (summary.custom && !summary.installed && summary.primary !== 'installCustom') {
            extra.push(ui.button({ label: 'Install components into this Python', icon: 'download', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => startSetup(ctx, { installIntoCustom: true }) }));
          }
          if (!py.appOwned && summary.status !== 'ok' && summary.primary !== 'appVenv' && !summary.custom && !usesAppLocationVenv(ctx)) {
            extra.push(ui.button({ label: "Repair in the app's own location", icon: 'wand', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => repairInAppLocation(ctx) }));
          }
          if (summary.custom) {
            extra.push(fk(ui.button({ label: "Reset to the app's own components", icon: 'undo', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => pendingWhile('Switching back…', () => useDefaultPython(ctx)) }), 'py-reset'));
          }
          extra.push(ui.button({ label: 'Check again', icon: 'refresh', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => pendingWhile('Checking…', () => ctx.refresh.env({ refresh: true })) }));
        }
        const detail = [];
        if (failure) {
          detail.push(ui.callout({
            variant: 'danger', compact: true, title: 'The last repair did not finish', message: failureMessage(ctx, failure),
            actions: setupFixButtons(ctx, failure, { custom: summary.custom }), class: 'mt-8',
          }));
        }
        if (j && j.kind === 'setup') detail.push(monitor.el);
        const rows = [
          ['Status', summary.status === 'ok' ? 'Ready' : (summary.status === 'running' ? 'Working…' : 'Needs attention')],
          ['Python', py.version || '—'],
          ['Location', py.path || '—'],
          ['Type', summary.custom ? 'Your own Python' : "The app's own components"],
        ];
        if (Array.isArray(py.missing) && py.missing.length) rows.push(['Missing', py.missing.join(', ')]);
        return settingsSection({
          id: 'settings-components',
          title: 'Card maker components',
          description: 'The Python programs that download cards and make PDFs.',
          icon: 'package',
          children: [
            ui.statusRow({
              status: summary.status,
              title: summary.status === 'ok' ? 'Card maker components are ready' : 'Card maker components',
              message: summary.message,
              detail: detail.length ? h('div.stack', { style: { '--gap': '8px' } }, detail) : null,
              actions: componentsButtons(ctx, summary, { showRepairWhenOk: true, onPending: setPending, menu: false, primary: !failure }),
            }),
            ui.kv(rows),
            extra.length ? h('div.row', { style: { '--gap': '8px' } }, extra) : null,
          ],
        });
      });

    /* ------------------------------------------------------------------ Upscayl */

    async function detectUpscaylAgain() {
      try {
        applyUpscaylStatus(ctx, await api.upscayl.status({ refresh: true }));
      } catch {
        /* the full refresh below reports the state */
      }
      await ctx.refresh.env({ refresh: true });
      const up = env()?.upscayl;
      ui.toast({ variant: up?.found ? 'success' : 'info', title: up?.found ? `Upscayl found${up.version ? ` (version ${up.version})` : ''}` : 'Upscayl was not found on this computer' });
    }

    async function useAutomaticUpscayl() {
      try {
        applyUpscaylStatus(ctx, await api.upscayl.locate(null));
        await ctx.refresh.env({ refresh: true });
        ui.toast({ variant: 'info', title: 'Upscayl is detected automatically again' });
      } catch (err) {
        ui.showError(err, { title: "Couldn't change the Upscayl location" });
      }
    }

    async function setModelsFolder(dir) {
      const target = dir === undefined
        ? await api.dialog.openFolder({ purpose: 'upscayl-models', title: 'Choose a folder with Upscayl models (.param and .bin files)' })
        : dir;
      if (dir === undefined && !target) return;
      try {
        const status = await api.upscayl.setCustomModelsDir(target);
        applyUpscaylStatus(ctx, status);
        await ctx.refresh.env({ refresh: true });
        if (target) {
          const n = (status?.models || env()?.upscayl?.models || []).filter((m) => m && m.custom).length;
          ui.toast({ variant: n ? 'success' : 'warning', title: n ? `${format.pluralize(n, 'extra model')} found` : 'No models found in this folder', message: n ? undefined : 'A model is a pair of files with the same name: <name>.param and <name>.bin.' });
        } else {
          ui.toast({ variant: 'info', title: 'Extra models folder removed' });
        }
      } catch (err) {
        ui.showError(err, { title: "Couldn't use this models folder" });
      }
    }

    const upscayl = keyedSection('upscayl',
      () => JSON.stringify([env()?.upscayl, settings().upscayl?.binPath, settings().upscayl?.customModelsDir, busy()]),
      () => {
        const up = env()?.upscayl || null;
        const s = settings().upscayl || {};
        const isBusy = busy();
        const children = [];
        if (up && up.found) {
          children.push(ui.statusRow({
            status: 'ok',
            title: `Upscayl${up.version ? ` ${up.version}` : ''} is installed`,
            message: 'Make PDF uses it to sharpen low-resolution pictures while upscaling is on.',
            actions: [
              ui.button({ label: 'Detect again', icon: 'refresh', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => detectUpscaylAgain() }),
              fk(ui.button({ label: 'Locate…', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => locateUpscayl(ctx) }), 'up-locate'),
            ],
          }));
          const models = Array.isArray(up.models) ? up.models : [];
          const custom = models.filter((m) => m && m.custom).length;
          children.push(ui.kv([
            ['Program', up.binPath || '—'],
            ['Models folder', up.modelsDir || '—'],
            ['Models', models.length ? `${format.pluralize(models.length, 'model')}${custom ? ` (${custom} extra)` : ''}` : 'None found'],
            ['Graphics card', gpuText(up)?.replace(/^Graphics cards?: /, '') || 'Detected when you first upscale (or on the Upscale page)'],
          ]));
        } else {
          children.push(ui.statusRow({
            status: 'optional',
            title: 'Upscayl is not installed (optional)',
            message: up?.error && settings().upscayl?.binPath ? up.error : 'This free app makes low-resolution card pictures sharper when printed. Install it, then come back and click Detect again.',
            actions: [
              ui.button({ label: 'Download', icon: 'external-link', size: 'sm', onClick: () => openLink(ctx, EXTERNAL_LINKS.upscayl.url) }),
              ui.button({ label: 'Detect again', icon: 'refresh', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => detectUpscaylAgain() }),
              fk(ui.button({ label: 'Locate…', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => locateUpscayl(ctx) }), 'up-locate'),
            ],
          }));
        }
        children.push(infoRow({
          icon: 'folder',
          title: 'Extra models folder',
          message: s.customModelsDir ? h('span', { style: { overflowWrap: 'anywhere' } }, s.customModelsDir) : 'None. You can add community models (optional).',
          actions: [
            !s.customModelsDir && ui.button({ label: 'More models', icon: 'external-link', size: 'sm', variant: 'ghost', onClick: () => openLink(ctx, EXTERNAL_LINKS.upscaylCustomModels.url) }),
            fk(ui.button({ label: s.customModelsDir ? 'Change…' : 'Choose…', size: 'sm', disabled: isBusy, title: busyTitle(), onClick: () => setModelsFolder() }), 'up-models'),
            s.customModelsDir && ui.button({ label: 'Remove', icon: 'x', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => setModelsFolder(null) }),
          ],
        }));
        const foot = [h('span.small.muted', 'Model, scale and graphics card choices are on the Upscale page.'), ui.button({ label: 'Open Upscale', variant: 'link', size: 'sm', iconRight: 'arrow-right', onClick: () => ctx.navigate('upscale') })];
        if (s.binPath) foot.push(ui.button({ label: 'Use automatic detection', icon: 'undo', size: 'sm', variant: 'ghost', disabled: isBusy, title: busyTitle(), onClick: () => useAutomaticUpscayl() }));
        children.push(h('div.row', { style: { '--gap': '8px' } }, foot));
        return settingsSection({
          id: 'settings-upscayl',
          title: 'Upscayl',
          description: 'Optional free app that sharpens card pictures. It is never bundled; the app uses your installed copy.',
          icon: 'sparkles',
          children,
        });
      });

    /* ------------------------------------------------------------------ output folder */

    async function changeOutput(dir) {
      const target = dir === undefined ? await api.dialog.openFolder({ purpose: 'output', title: 'Choose where to save your PDFs' }) : dir;
      if (dir === undefined && !target) return;
      try {
        await saveSettings(ctx, { outputDir: target });
        await refreshAppInfo(ctx);
        ui.toast({ variant: 'success', title: target ? 'PDF folder changed' : 'Using the default PDF folder', message: appInfo().paths?.output || undefined });
      } catch (err) {
        ui.showError(err, { title: "Couldn't change the PDF folder" });
      }
    }

    const output = keyedSection('output',
      () => JSON.stringify([appInfo().paths?.output, settings().outputDir]),
      () => {
        const where = appInfo().paths?.output || settings().outputDir || null;
        return settingsSection({
          id: 'settings-output',
          title: 'PDF folder',
          description: 'Where your PDFs (and cutting template copies) are saved.',
          icon: 'file-pdf',
          children: infoRow({
            icon: 'folder-open',
            title: where ? h('span', { style: { overflowWrap: 'anywhere' } }, where) : 'Default folder',
            message: settings().outputDir ? 'A folder you chose.' : 'The default folder.',
            actions: [
              where && ui.button({ label: 'Open', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => openFolder(ctx, where, { missingMessage: 'This folder is created when you make your first PDF.' }) }),
              fk(ui.button({ label: 'Change…', size: 'sm', onClick: () => changeOutput() }), 'out-change'),
              settings().outputDir && ui.button({ label: 'Use default', icon: 'undo', size: 'sm', variant: 'ghost', onClick: () => changeOutput(null) }),
            ],
          }),
        });
      });

    /* ------------------------------------------------------------------ appearance */

    const appearance = keyedSection('appearance',
      () => JSON.stringify([settings().theme, settings().ui?.advancedMode]),
      () => settingsSection({
        id: 'settings-appearance',
        title: 'Appearance',
        icon: 'palette',
        children: [
          ui.field({
            label: 'Theme',
            inline: true,
            control: fk(ui.segmented({
              ariaLabel: 'Theme',
              value: ['light', 'dark'].includes(settings().theme) ? settings().theme : 'system',
              options: [
                { value: 'system', label: 'System', icon: 'monitor' },
                { value: 'light', label: 'Light', icon: 'sun' },
                { value: 'dark', label: 'Dark', icon: 'moon' },
              ],
              onChange: async (v) => {
                try {
                  await saveSettings(ctx, { theme: v });
                } catch (err) {
                  ui.showError(err, { title: 'Could not save the theme' });
                }
              },
            }), 'theme'),
          }),
          ui.divider(),
          fk(ui.toggle({
            checked: !!settings().ui?.advancedMode,
            label: 'Show advanced options by default',
            description: 'Opens the “More options” parts of Get cards, Upscale and Make PDF automatically.',
            onChange: async (on) => {
              try {
                await saveSettings(ctx, { ui: { advancedMode: on } });
              } catch (err) {
                ui.showError(err, { title: 'Could not save this option' });
              }
            },
          }), 'advanced'),
        ],
      }));

    /* ------------------------------------------------------------------ storage */

    async function loadStorage() {
      const [c, t] = await Promise.allSettled([api.upscayl.cacheInfo(), api.cards.trashList()]);
      if (ctx.signal.aborted) return;
      view.cache = c.status === 'fulfilled' ? { data: c.value || null } : { error: api.errorMessage(c.reason) };
      view.trash = t.status === 'fulfilled' ? { data: Array.isArray(t.value) ? t.value : [] } : { error: api.errorMessage(t.reason) };
      storage.update();
    }
    let trashTimer = null;
    const reloadSoon = () => {
      clearTimeout(trashTimer);
      trashTimer = setTimeout(() => {
        if (!ctx.signal.aborted) loadStorage();
      }, 600);
    };
    ctx.onCleanup(() => clearTimeout(trashTimer));

    async function clearUpscaled() {
      const files = Number(view.cache?.data?.files) || 0;
      const ok = await ui.confirmDialog({
        title: 'Delete the upscaled pictures?',
        message: `${files ? `${format.pluralize(files, 'upscaled picture')} (${format.formatBytes(view.cache.data.bytes)}) will be deleted. ` : ''}Your original card pictures are not touched. Sharp copies are made again the next time you make a PDF with upscaling on, which takes a while.`,
        confirmLabel: 'Delete upscaled pictures',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api.upscayl.clearCache();
        ui.toast({ variant: 'success', title: 'Upscaled pictures deleted', message: res && Number.isFinite(res.removed) ? `${format.pluralize(res.removed, 'file')} removed.` : undefined });
        ctx.refresh.cards();
      } catch (err) {
        ui.showError(err, { title: "Couldn't delete the upscaled pictures" });
      }
      loadStorage();
    }

    async function emptyTrash() {
      const list = Array.isArray(view.trash?.data) ? view.trash.data : [];
      const count = list.reduce((n, b) => n + (Number(b?.count) || 0), 0);
      const ok = await ui.confirmDialog({
        title: 'Empty Recently removed?',
        message: `${count ? `${format.pluralize(count, 'picture')} will be deleted forever. ` : ''}You can't undo this.`,
        confirmLabel: 'Delete forever',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await api.cards.emptyTrash();
        ui.toast({ variant: 'success', title: 'Recently removed is empty', message: res && Number.isFinite(res.removed) ? `${format.pluralize(res.removed, 'picture')} deleted.` : undefined });
        ctx.refresh.cards();
      } catch (err) {
        ui.showError(err, { title: "Couldn't empty Recently removed" });
      }
      loadStorage();
    }

    const storage = keyedSection('storage',
      () => JSON.stringify([view.cache, view.trash, busy(), appInfo().paths?.data]),
      () => {
        const isBusy = busy();
        const c = view.cache;
        const t = view.trash;
        let cacheMsg;
        let cacheDetail = null;
        if (c.loading) cacheMsg = 'Checking…';
        else if (c.error) cacheMsg = 'Not available right now.';
        else {
          const files = Number(c.data?.files) || 0;
          cacheMsg = files ? `${format.pluralize(files, 'upscaled picture')} · ${format.formatBytes(c.data.bytes)}` : 'No upscaled pictures yet.';
          const total = Number(c.data?.total) || 0;
          const upToDate = Number(c.data?.upToDate) || 0;
          if (total && upToDate) {
            if (upToDate >= total) {
              cacheDetail = total === 1
                ? 'Your card is sharp enough or has a sharp copy ready.'
                : `All ${format.formatNumber(total)} current cards are sharp enough or have a sharp copy ready.`;
            } else {
              cacheDetail = `${format.formatNumber(upToDate)} of your ${format.pluralize(total, 'current card')} ${upToDate === 1 ? 'is' : 'are'} sharp enough or ${upToDate === 1 ? 'has' : 'have'} a sharp copy ready.`;
            }
          }
        }
        let trashMsg;
        if (t.loading) trashMsg = 'Checking…';
        else if (t.error) trashMsg = 'Not available right now.';
        else {
          const list = t.data || [];
          const count = list.reduce((n, b) => n + (Number(b?.count) || 0), 0);
          const bytes = list.reduce((n, b) => n + (Number(b?.bytes) || 0), 0);
          trashMsg = list.length ? `${format.pluralize(count, 'picture')} in ${format.pluralize(list.length, 'batch', 'batches')}${bytes ? ` · ${format.formatBytes(bytes)}` : ''}` : 'Empty.';
        }
        const cacheFiles = Number(c.data?.files) || 0;
        const trashCount = (t.data || []).length;
        const dataDir = appInfo().paths?.data || null;
        return settingsSection({
          id: 'settings-storage',
          title: 'Storage',
          description: 'Space used by the app besides your cards and PDFs.',
          icon: 'hard-drive',
          children: [
            infoRow({
              icon: 'sparkles',
              title: 'Upscaled pictures',
              message: cacheMsg,
              detail: cacheDetail,
              actions: fk(ui.button({ label: 'Delete…', icon: 'trash', size: 'sm', disabled: isBusy || !cacheFiles || !!c.error, title: isBusy ? busyTitle() : undefined, onClick: () => clearUpscaled() }), 'st-cache'),
            }),
            infoRow({
              icon: 'trash',
              title: 'Recently removed',
              message: trashMsg,
              detail: 'Removed cards are kept for 14 days so you can restore them in Your cards.',
              actions: [
                trashCount ? ui.button({ label: 'Restore…', icon: 'undo', size: 'sm', variant: 'ghost', onClick: () => ctx.navigate('cards') }) : null,
                fk(ui.button({ label: 'Empty…', icon: 'trash', size: 'sm', disabled: isBusy || !trashCount || !!t.error, title: isBusy ? busyTitle() : undefined, onClick: () => emptyTrash() }), 'st-trash'),
              ],
            }),
            infoRow({
              icon: 'hard-drive',
              title: 'App data folder',
              message: 'Python, the components, caches and temporary files.',
              detail: dataDir,
              actions: dataDir ? ui.button({ label: 'Open', icon: 'folder-open', size: 'sm', variant: 'ghost', onClick: () => openFolder(ctx, dataDir) }) : null,
            }),
          ],
        });
      });

    /* ------------------------------------------------------------------ help & logs, about */

    const helpLogs = keyedSection('help', () => JSON.stringify([appInfo().paths?.logs]), () => {
      const logs = appInfo().paths?.logs || null;
      const links = ['tutorial', 'troubleshooting', 'discord', 'issues'].map((id) => getHelpLink(id)).filter(Boolean);
      return settingsSection({
        id: 'settings-help',
        title: 'Help and logs',
        icon: 'life-buoy',
        children: [
          infoRow({
            icon: 'file-text',
            title: 'Logs',
            message: 'Every task writes a log. Attach the newest one when you ask for help.',
            detail: logs,
            actions: logs ? ui.button({ label: 'Open logs folder', icon: 'folder-open', size: 'sm', onClick: () => openFolder(ctx, logs) }) : null,
          }),
          h('div.row', { style: { '--gap': '8px' } }, links.map((l) => ui.button({ label: l.label, icon: l.icon, size: 'sm', variant: 'ghost', title: l.description, onClick: () => openLink(ctx, l.url) }))),
        ],
      });
    });

    const about = keyedSection('about',
      () => {
        const e = env();
        return JSON.stringify([appInfo().version, appInfo().isDev, appInfo().versions, store.get('introspection')?.engineVersion, e?.python?.version,
          e?.upscayl?.found, e?.upscayl?.version, e?.silhouetteStudio?.found, e?.silhouetteStudio?.version]);
      },
      () => {
        const info = appInfo();
        const e = env();
        const intro = store.get('introspection');
        const v = info.versions || {};
        const rows = [
          ['Kirigami', `${info.version || '—'}${info.isDev ? ' (development)' : ''}`],
          ['Silhouette Card Maker engine', intro?.engineVersion || (e?.ready ? 'Loading…' : '—')],
          ['Python', e?.python?.version || '—'],
          ['Upscayl', e?.upscayl?.found ? (e.upscayl.version || 'Installed') : 'Not installed'],
          ['Silhouette Studio', e?.silhouetteStudio?.found ? (e.silhouetteStudio.version || 'Installed') : 'Not found'],
        ];
        if (v.electron) rows.push(['Desktop runtime', `Electron ${v.electron}${v.chrome ? ` · Chromium ${v.chrome}` : ''}`]);
        const links = ['website', 'repo', 'updates', 'donate'].map((id) => getHelpLink(id)).filter(Boolean);
        return settingsSection({
          id: 'settings-about',
          title: 'About',
          icon: 'info',
          children: [
            ui.kv(rows),
            h('div.row', { style: { '--gap': '8px' } }, links.map((l) => ui.button({ label: l.label, icon: l.icon, size: 'sm', variant: 'ghost', title: l.description, onClick: () => openLink(ctx, l.url) }))),
          ],
        });
      });

    /* ------------------------------------------------------------------ reset */

    async function resetAll() {
      const ok = await ui.confirmDialog({
        title: 'Reset all settings?',
        message: h('div.stack', { style: { '--gap': '10px' } },
          h('p', 'Every choice goes back to its default: equipment, PDF options and presets, folders, Python, Upscayl settings and theme.'),
          h('p', 'Your cards, deck lists, PDFs and printer alignment are kept. You will go through the quick setup again.')),
        confirmLabel: 'Reset all settings',
        danger: true,
      });
      if (!ok) return;
      try {
        const next = await api.settings.reset();
        if (next && typeof next === 'object') ctx.store.set('settings', next);
        await Promise.allSettled([ctx.refresh.env({ refresh: true }), refreshAppInfo(ctx)]);
        ctx.refresh.cards();
        ui.toast({ variant: 'success', title: 'Settings reset', message: 'Let’s go through the quick setup again.' });
        ctx.navigate('setup');
      } catch (err) {
        ui.showError(err, { title: "Couldn't reset the settings" });
      }
    }

    const reset = keyedSection('reset', () => JSON.stringify([busy()]), () => settingsSection({
      id: 'settings-reset',
      title: 'Reset',
      icon: 'rotate-ccw',
      variant: 'danger',
      children: infoRow({
        icon: 'rotate-ccw',
        tone: 'danger',
        title: 'Reset all settings',
        message: 'Puts every choice back to its default. Your cards, deck lists, PDFs and printer alignment are kept.',
        actions: fk(ui.button({ label: 'Reset all settings…', variant: 'danger', size: 'sm', disabled: busy(), title: busyTitle(), onClick: () => resetAll() }), 'reset'),
      }),
    }));

    /* ------------------------------------------------------------------ footer */

    const footer = keyedSection('footer', () => JSON.stringify([Number(store.get('cards')?.summary?.front) || 0, !!env()?.ready]), () => {
      const fronts = Number(store.get('cards')?.summary?.front) || 0;
      return nextStep({
        text: 'Changes are saved automatically',
        detail: fronts ? `${format.pluralize(fronts, 'card')} ready in Your cards.` : 'Next: download the cards of a deck.',
        tone: 'neutral',
        icon: 'check-circle',
        actionLabel: fronts ? 'Your cards' : 'Get cards',
        onAction: () => ctx.navigate(fronts ? 'cards' : 'fetch'),
      });
    });

    /* ------------------------------------------------------------------ mount */

    const sections = [attention, equipment, dataFolder, components, upscayl, output, appearance, storage, helpLogs, about, reset, footer];
    const jumpTo = (id) => {
      const target = document.getElementById(id);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const heading = target.querySelector('h2, .section-title');
      if (heading) {
        if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    };
    const jumps = h('nav.row', { attrs: { 'aria-label': 'Settings sections' }, style: { '--gap': '8px', margin: '-8px 0 8px' } },
      h('span.small.faint', { attrs: { 'aria-hidden': 'true' } }, 'Jump to'),
      SECTION_LINKS.map(([id, label]) => h('button.chip.chip-toggle', { type: 'button', onClick: () => jumpTo(id) }, label)));
    container.append(
      ui.pageHeader({ title: 'Settings', subtitle: 'Your equipment, folders, components and preferences. Changes are saved automatically.', icon: 'settings' }),
      attention.el,
      jumps,
      ...sections.filter((s) => s !== attention).map((s) => s.el),
    );
    const updateAll = (force = false) => {
      for (const s of sections) s.update(force);
    };
    updateAll(true);

    ctx.subscribe('settings', () => updateAll());
    ctx.subscribe('env', () => updateAll());
    ctx.subscribe('appInfo', () => updateAll());
    ctx.subscribe('introspection', () => about.update());
    ctx.subscribe('lastResults', (r, prev) => {
      components.update();
      if (r?.upscale !== prev?.upscale || r?.fetch !== prev?.fetch || r?.pdf !== prev?.pdf) reloadSoon();
    });
    ctx.subscribe('cards', () => {
      footer.update();
      reloadSoon();
    });
    ctx.subscribe('job', frameThrottle(() => {
      if (!ctx.signal.aborted) updateAll();
    }));

    loadStorage();
  },
};
