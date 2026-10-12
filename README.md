<!-- cspell:words Kirigami mtgtoolkit Upscayl upscales SUMZ LOCALAPPDATA NSIS pycache asar -->

# Kirigami (切り紙)

Make print-and-cut card proxies with your Silhouette cutting machine, without typing a single command.

Kirigami is a Windows app that downloads card pictures for your deck, lets you check them, can sharpen
them with Upscayl, lays them out in a PDF with registration marks, and walks you through printing and
cutting. It is a friendly front end for [Silhouette Card Maker](https://alan-cha.github.io/silhouette-card-maker)
by Alan Cha ([source code](https://github.com/Alan-Cha/silhouette-card-maker)): the Silhouette Card Maker
engine, bundled with the app, does the actual work of downloading cards and making PDFs, and its
tutorial, game plugins and cutting templates are what Kirigami is built on.

> **Proxies are for casual play and playtesting only.** They must be easy to identify as proxies. Never
> use them to deceive people, in sanctioned tournaments, or to sell cards you don't own the rights to.

- [User guide](#user-guide)
  - [What you need](#what-you-need)
  - [Install](#install)
  - [First start](#first-start)
  - [Making proxies in 5 steps](#making-proxies-in-5-steps)
  - [Sharper prints with Upscayl (optional)](#sharper-prints-with-upscayl-optional)
  - [Printer alignment (two-sided printing only)](#printer-alignment-two-sided-printing-only)
  - [Print and cut tips](#print-and-cut-tips)
  - [Where your files are](#where-your-files-are)
  - [Updates](#updates)
  - [Starting over and uninstalling](#starting-over-and-uninstalling)
  - [Logs](#logs)
  - [Troubleshooting](#troubleshooting)
  - [Getting help](#getting-help)
- [Developer guide](#developer-guide)
  - [Development](#development)
  - [Releasing](#releasing)
- [License](#license)

---

# User guide

## What you need

- A Windows 10 or 11 PC (64-bit) and an internet connection (for the one-time setup and for downloading
  card pictures).
- A Silhouette cutting machine (Cameo 5 Alpha, Cameo 5, Cameo 4, Portrait or similar) and the free
  [Silhouette Studio](https://www.silhouetteamerica.com/silhouette-studio) software.
- A printer and card stock. A laminator is optional.
- Optional: [Upscayl](https://upscayl.org), a free program that makes small card pictures sharper.

The [supply list](https://alan-cha.github.io/silhouette-card-maker/tutorial/supplies/) and the
[tutorial](https://alan-cha.github.io/silhouette-card-maker/tutorial/) explain the equipment in detail.

## Install

1. Download **Kirigami-Setup-<version>.exe** from the
   [releases page](https://github.com/mtgtoolkit/kirigami/releases) and double-click it.
2. The app installs for your Windows user only (no administrator password needed), adds a desktop and a
   Start menu shortcut, and opens when it's done.

**"Windows protected your PC"?** The installer is not code-signed yet, so Microsoft Defender SmartScreen
may warn you the first time. Click **More info**, then **Run anyway**.

**Smart App Control** (some Windows 11 PCs) can block programs that are not code-signed, and it has no
"Run anyway" button. If the installer is blocked and you trust it, you can turn Smart App Control off in
**Windows Security > App & browser control > Smart App Control settings**. Read Microsoft's explanation
there first: on some Windows versions it can't be turned back on without resetting Windows.

Antivirus programs sometimes flag new unsigned programs too. If yours quarantines the app or the
component download, add an exception for the Kirigami folders listed in
[Where your files are](#where-your-files-are).

## First start

The app opens on a short setup with three steps:

1. **Welcome**: what the app does and what you need. Read the Purpose notice and tick **I understand**.
2. **Checklist**:
   - **Card maker data folder**: where your cards, deck lists and alignment are kept (created for you).
   - **Card maker components**: click **Install**. This is a one-time download of a private copy of
     Python and the card maker components (about 400 MB on disk, usually a few minutes). Nothing is
     installed system-wide, and it doesn't interfere with any Python you already have.
   - **Upscayl**: shown as found, or "Not installed (optional)" with **Download** and **Locate...**.
   - **Silhouette Studio**: shown as found, or with a download link. You need it to cut, not to make PDFs.
3. **Your equipment**: choose your paper (Letter or A4 is preselected from your Windows region) and your
   cutting machine. This sets the paper size and the registration marks for you.

At the end you can **Try with sample cards**: the app generates nine numbered test cards and a test back
at your card size, so you can try the whole process (and a first test cut) before using a real deck.

> Tip: make your first sheet on plain card stock to find your cutting settings and check registration
> before printing a real deck.

## Making proxies in 5 steps

The sidebar follows the order you work in. Every page ends with a button to the next step.

### 1. Get cards

1. Pick your game. More than 20 games are supported, including Magic: The Gathering, Pokémon, Yu-Gi-Oh!, Lorcana,
   One Piece, Digimon, Flesh and Blood, Star Wars: Unlimited, Riftbound and many more.
2. Pick the format of your deck list. **How to get this list** explains where to export it, and
   **Insert example** shows what it looks like.
3. Give the app your deck: paste the list (and give it a name), pick one of your **Saved lists**,
   **Choose a file...**, or paste a deck link or code, depending on the game.
4. Optional: open **More options** for game-specific choices (for Magic: card language, preferred
   printings, tokens...).
5. Keep **Start fresh** ticked to move the cards currently loaded to **Recently removed** first (you
   can restore them later), then click **Download cards**.

When it finishes you see how many cards were downloaded, which cards failed and why (with **Copy
names** and **Edit list**), and the PDF settings recommended for that game (for example the smaller
Japanese card size for Yu-Gi-Oh!).

### 2. Your cards

Check every card before printing:

- **Fronts**: one picture per printed card. Use **+1 copy** / **-1 copy**, **Remove** (with Undo), or
  **Add images...** and drag and drop your own pictures. Identical pictures can be grouped (xN).
- **Common back (all cards)**: the picture printed behind every single-sided card. Choose one, or **No
  back** to leave the backs blank.
- **Unique backs (double-faced cards)**: backs that belong to one specific front (for example
  double-faced Magic cards). The app pairs them automatically.

Badges warn you about blurry (low-resolution) pictures and pictures with the wrong shape. If two
pictures have the same name, only one would be printed: click **Fix names automatically**. Removed
cards stay in **Recently removed** for 14 days.

### 3. Upscale (optional)

If Upscayl is installed, the app can sharpen small pictures for crisp prints. You don't need to start
it yourself: while the switch is on, **Make PDF** upscales automatically, and only as much as your
print resolution needs. See [Sharper prints with Upscayl](#sharper-prints-with-upscayl-optional).

### 4. Make PDF

1. Check the **paper**, **card size** (with typical games) and your cutting machine.
2. Choose the **sides**: **Fronts only**, or **Fronts and backs** (needs a printer that prints
   two-sided on card stock, and a one-time [Printer alignment](#printer-alignment-two-sided-printing-only)).
3. Choose the **print resolution**: Standard 300, High 600, Very high 1200 or Maximum 1440 PPI. Each
   choice shows the file size, memory and time it needs.
4. Name the file and click **Create PDF**.

The panel on the right shows how many sheets you will print, a preview of the page (click a slot to
**Leave slot empty**), the cutting template to use, and any problem to fix first. Very large PDFs are
made in parts and joined automatically so your computer doesn't run out of memory.

**More options** has every setting of the card maker: **Fill rounded corners**, **Trim thin edge
lines**, **Trim image edges** (for pictures that already include bleed, like MPCFill), **Extra outer
bleed**, **Image shape** (Stretch / Crop), JPEG quality, **Text printed on each sheet**, **Show cut
lines**, **Tight layout** (more cards per sheet), registration marks, specialty layouts, **Apply my
printer alignment** and **Make PNG images instead of a PDF**. You can save your favorite combination
as a preset. The built-in **My usual settings** preset is: A4, 1440 PPI, fronts only, 4-corner marks,
Fill rounded corners 2 mm and Trim thin edge lines 0.5 mm (Setup adapts the paper and marks to your
equipment).

### 5. Print & cut

A checklist made for your PDF: print settings, how to check the card size, and how to cut.
**Open cutting template** opens the matching Silhouette Studio template for you. See
[Print and cut tips](#print-and-cut-tips).

## Sharper prints with Upscayl (optional)

[Upscayl](https://upscayl.org) is a free AI upscaler. The app never includes it; it uses the copy you
installed (it finds it automatically, or use **Locate...**). A graphics card that supports Vulkan is
needed; most recent ones do.

- **Model**: Upscayl Standard is a good default; Upscayl Lite is much faster. Models marked
  Non-Commercial are for personal use only.
- **Max scale** and **Smart scale**: with Smart scale on, pictures that are already sharp enough for
  your print resolution are left alone.
- **Try on one card** shows a before/after comparison.
- Upscaled pictures are cached: the first PDF takes longer, the next ones reuse them. **Clear upscaled
  images** frees the space.

If your graphics card can't run Upscayl, the app uses the original pictures and tells you so.

## Printer alignment (two-sided printing only)

Most printers shift the back side slightly. Printer alignment measures that shift once so the backs of
your cards line up with the fronts. Redo it after changing printer, paper size or card stock.

1. Print the alignment sheet for your paper, two-sided ("Flip on long edge"), at 100% scale, on the card
   stock you will use.
2. Hold it against a window or a lamp and look at the back.
3. Find the square that lines up with its shadow and type its two red numbers.
4. Save. New PDFs made with **Fronts and backs** then use **Apply my printer alignment**.

If no square lines up, make a shifted sheet and repeat. You can also apply the alignment to a PDF you
already made (under Advanced).

## Print and cut tips

- Print from your PDF viewer at **Actual size / 100%**. Never use "Fit" or "Shrink oversized pages".
- Measure one printed card: a standard card must be exactly 63 x 88 mm. If not, scaling is on.
- Two-sided: print with **Flip on long edge**.
- In Silhouette Studio, open the template whose name is printed on the edge of the sheet, select your
  machine (Cameo 5 Alpha users with 3-corner marks: select **Cameo 5**), and place the sheet in the
  top-left corner of the mat grid with the black square at the top left.
- Templates contain no cut settings. Test on scrap first; start around force 25, speed 25, depth 7 and
  1 pass, then add passes.
- If registration fails, cover the card next to the bottom-left mark with a Post-it note (remove it
  before cutting) or leave that slot empty, keep the marks clean, and try different lighting.

The [cutting guide](https://alan-cha.github.io/silhouette-card-maker/tutorial/guide/) and
[troubleshooting page](https://alan-cha.github.io/silhouette-card-maker/tutorial/troubleshooting/)
have photos of every step.

## Where your files are

| What | Where |
| --- | --- |
| Settings and logs | `%APPDATA%\Kirigami` |
| Your cards, deck lists and printer alignment (the "card maker data folder"), plus the card maker components | `%LOCALAPPDATA%\Kirigami` |
| Your PDFs (and copies of the cutting templates you opened) | `Documents\Kirigami` |
| The program itself | `%LOCALAPPDATA%\Programs\kirigami` |

Paste a path such as `%LOCALAPPDATA%\Kirigami` into the File Explorer address bar to open it.
**Settings** has buttons to open these folders, change the output folder and see how much space
upscaled pictures and recently removed cards use.

## Updates

Kirigami has two parts that get updated: the app itself and the Silhouette Card Maker engine it uses.

### App updates

New versions of Kirigami are published on the [releases page](https://github.com/mtgtoolkit/kirigami/releases).

### Card maker engine updates

Every Kirigami installer includes a copy of the Silhouette Card Maker engine, the program that downloads
the cards and makes the PDFs. [Silhouette Card Maker](https://github.com/Alan-Cha/silhouette-card-maker)
keeps getting new games and fixes, so Kirigami keeps its engine up to date by itself while it runs:

- About a minute after Kirigami starts, then every hour, it asks GitHub whether the engine changed. This
  check is tiny and needs no account.
- When there is a newer version, Kirigami downloads only the files that changed, checks each one against
  GitHub, and keeps the new version next to the one you use (in `%LOCALAPPDATA%\Kirigami\engines`).
- It switches to the new version only when no task is running, never in the middle of downloading cards
  or making a PDF. The activity bar then shows "Updating the card maker engine": the card maker files are
  replaced, the components the new version needs are installed if they changed, and a test PDF checks that
  everything works. A message tells you what changed.
- If anything goes wrong, the version you had is put back right away, and Kirigami does not install the
  version that failed again by itself.
- Without an internet connection, Kirigami keeps working with the engine it has and tries again later.

**Settings > Card maker engine** shows the version in use (with its date, and whether it came with the
installer or was downloaded) and when Kirigami last checked. There you can:

- click **Check now** to look for a newer version right away (this also retries a version that failed
  before, for example after you fixed your own Python);
- click **Roll back** to go back to the version you had before the last update. Kirigami then does not
  reinstall the version you left; the next newer one is installed as usual;
- turn off **Keep the card maker engine up to date automatically** to stop the automatic checks.
  **Check now** still works.

Engine updates never touch your cards, deck lists, PDFs, printer alignment or settings, and **Reset all
settings** does not change the engine. Installing a newer Kirigami also brings a newer engine: Kirigami
always uses the newest one it has. To turn engine updates off completely (for example on a managed
computer), set the environment variable `SCM_ENGINE_UPDATES=0`. They are also off while Kirigami is linked
to an engine folder with `SCM_ENGINE_DIR` (see [The engine](#the-engine)).

## Starting over and uninstalling

- **Recently removed** (in Your cards) restores cards you removed; **Empty all** deletes them.
- **Settings > Reset all settings** puts every setting back to its default (your cards, PDFs and
  alignment are kept).
- **Settings > Card maker components > Repair components** reinstalls the components if something is
  broken.
- To uninstall, use **Windows Settings > Apps > Installed apps > Kirigami > Uninstall**.
  Your cards, settings and PDFs are kept; delete the folders listed above if you want them gone too.

## Logs

Every download, PDF and setup run is logged. Click **Details** in the activity bar at the bottom of the
window to see the live log, **Copy log**, or **Open logs folder**
(`%APPDATA%\Kirigami\logs`). Attach the log when you ask for help.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The component install fails | Check your internet connection and try **Install** again. Antivirus "HTTPS scanning" and company proxies can block the download: pause it or try another network. |
| "Windows blocked writing the file" | The PDF is probably open in your PDF viewer: close it, or use **Keep both**. OneDrive syncing or Windows "Controlled folder access" can also block the Documents folder: choose another output folder in Settings. |
| "Your computer ran out of memory" | Lower the print resolution (PPI). Very big PDFs are already made in parts automatically. |
| Some cards failed to download | Check the spelling and set codes in your list (the result shows the reason for each card), then download again. For Magic, try **Ignore exact printings**. |
| "None of your lines were recognized" | The selected list format doesn't match your list: compare it with **Insert example**. |
| A game says "currently broken" | The game's deck website changed (currently Echoes of Astra and Sorcery: Contested Realm). Check for an app update. |
| Cards are the wrong size | Printing was scaled: print at **Actual size / 100%**. |
| Registration fails | See [Print and cut tips](#print-and-cut-tips). Check that the machine selected in Silhouette Studio matches your marks (3-corner or 4-corner). |
| Backs don't line up with fronts | Do the [Printer alignment](#printer-alignment-two-sided-printing-only) and keep **Apply my printer alignment** on. |
| Upscaling is off or images look the same | Upscayl wasn't found or your graphics card couldn't run it: see the Upscale page. |
| The app doesn't open | Look for a SmartScreen, Smart App Control or antivirus message, see [Install](#install). |

## Getting help

- [Tutorial](https://alan-cha.github.io/silhouette-card-maker/tutorial/) and
  [troubleshooting](https://alan-cha.github.io/silhouette-card-maker/tutorial/troubleshooting/) on the
  [Silhouette Card Maker website](https://alan-cha.github.io/silhouette-card-maker)
- [Silhouette Card Maker Discord community](https://discord.gg/jhsKmAgbXc): search `#troubleshooting`
  first, then ask with photos and your log.
- [Kirigami releases](https://github.com/mtgtoolkit/kirigami/releases) and
  [problem reports](https://github.com/mtgtoolkit/kirigami/issues) (attach your log)

---

# Developer guide

## Development

Kirigami is an Electron app for Windows; this section explains how to run it from source, test it and build it.
The repository holds no engine code: the Silhouette Card Maker engine is downloaded at the exact commit
pinned in `engine.lock.json`.

### Requirements

- Windows 10/11 x64 (the code is kept cross-platform where cheap, but only Windows is packaged).
- Node.js 22.12 or newer (24 recommended) and Git.
- An internet connection the first time (engine files, uv, and the app's own Python setup). No Python
  install is needed: the app installs its own with uv, like the installed app does.

### Getting started

```powershell
npm ci                  # the pinned dev tools (Electron, electron-builder, Playwright)
npm run fetch-uv        # uv, which the app's Setup uses to install Python and the card maker components
npm start               # builds build/engine from engine.lock.json first (prestart), then opens the app
```

`npm start` runs the app like an installed copy, with its own folders: settings and logs in
`%APPDATA%\Kirigami (dev)`, the card maker data folder (`workspace\`), the components (`venv\`) and caches
in `%LOCALAPPDATA%\Kirigami (dev)`, and PDFs in `workspace\game\output`. The first start shows Setup:
click **Install** to create the Python environment. Before starting, `prestart` checks `build/engine`
against `engine.lock.json` (well under a second when nothing changed); offline, it keeps the engine it
already has.

### The engine

| Where | What it is | How to get it |
| --- | --- | --- |
| `engine.lock.json` | The engine commit Kirigami ships: repository, branch, commit SHA and commit date. Committed. | `npm run fetch-engine -- --update` moves it to the latest commit of the branch (commit the change). |
| `build/engine/` | The engine files the installer ships as `resources\engine` (root scripts, `requirements.txt`, `LICENSE.md`, `assets`, `plugins`, `calibration`, `cutting_templates`), plus `.engine-manifest.json` with the commit and every file's size, SHA-1 and git blob SHA-1. Git-ignored. | `npm run fetch-engine` (also run by `npm start`, `npm run pack` and `npm run dist`). |
| `.engine-src/` | A sparse checkout of the same commit with what the tests also need: the README, the Hugo documentation and the test images. Git-ignored, about 80 MB. | `npm run engine:checkout`; add `-- --venv` to also create `.engine-src\venv` with the engine requirements (the Python the integration and end-to-end tests use). |

`npm run fetch-engine` downloads each file from `raw.githubusercontent.com` at the pinned commit and checks
it against the git blob SHA-1 listed in that commit's tree, so the commit SHA is the only thing to trust.
Downloads are cached by content in `build/.engine-cache` (set `SCM_ENGINE_CACHE` to share one cache between
several clones or worktrees), so moving to a newer commit only downloads the files that changed. Listing a
commit's files costs one GitHub API call (cached per commit), and `--update` one more; GitHub allows 60 calls
per hour per IP address without a token, so set `GITHUB_TOKEN` (or `GH_TOKEN`) if you hit the limit.
Other options: `--check` (exit 1 when `build/engine` is missing or does not match the lock, without network),
`--force` (rebuild), `--verify <folder>` (check a packaged `resources\engine`), `--help`.

**Working on the engine itself.** Set `SCM_ENGINE_DIR` to a Silhouette Card Maker checkout to link the app
to it instead of `build/engine`:

```powershell
$env:SCM_ENGINE_DIR = 'D:\src\silhouette-card-maker'; npm start
```

In this linked mode the checkout is also the card maker data folder (its own `game\` and
`data\offset_data.json`) and its `venv` is the Python (`python -m venv venv`, then
`.\venv\Scripts\pip install -r requirements.txt` in the checkout, or pick another one with **Use another
Python...** in Setup). Your edits run as they are: the app never copies or updates engine files there, and
`prestart` skips `build/engine`.

### Tests

| Command | What it does |
| --- | --- |
| `npm test` | Unit tests with Node's test runner (`node --test "test/unit/**/*.test.js"`). No Electron needed. The catalog tests compare the app's game and option data with the real engine: run `npm run engine:checkout` once so they all run (with only `build/engine` the documentation checks are skipped; without any engine, every engine check is skipped with the reason). |
| `npm run e2e` | End-to-end tests with Playwright driving Electron, on temporary copies of the engine (never a real `game\` folder). Needs `npm run engine:checkout -- --venv` (or `SCM_TEST_PYTHON`); the suite is skipped with the reason otherwise. Set `SCM_E2E_UPSCAYL=1` to include the Upscayl test, `SCM_E2E_OFFLINE=1` to skip the card download. |
| `npm run e2e:packaged` | The same tests against `dist/win-unpacked/Kirigami.exe` (run `npm run pack` first), which uses the engine it ships. Sets `SCM_E2E_PACKAGED=1` for the test helpers. |
| `node test/integration/<name>.int.js` | Longer checks against the real engine, its Python and (for `fetch`) the card websites: `helper`, `fetch`, `pdf`, `upscayl`. Each one documents its options at the top of the file. |

Every test finds the engine through `test/support/engine.js`: `SCM_TEST_ENGINE_DIR`, else `SCM_ENGINE_DIR`,
else `.engine-src`, else `build/engine`. The test Python is `SCM_TEST_PYTHON`, else `<engine>\venv`.

### Building

| Command | What it does |
| --- | --- |
| `npm run fetch-uv` | Downloads uv 0.12.22 for Windows into `build/uv/` and verifies its SHA-256 (skipped when already verified; `--force` to redo). |
| `npm run fetch-engine` | Builds `build/engine/` from `engine.lock.json` (see [The engine](#the-engine)). |
| `npm run pack` | `fetch-uv` + `fetch-engine` + an unpacked build in `dist/win-unpacked/` (fast, for testing). |
| `npm run dist` | `fetch-uv` + `fetch-engine` + the one-click NSIS installer `dist/Kirigami-Setup-<version>.exe`. |
| `npm run icon` | Regenerates `build/icon.png` (512 px) and `build/icon.ico` (16 to 256 px) with `scripts/make-icon.py` (uv runs it with numpy and Pillow in a throwaway environment). |

### Environment variables (development and tests)

| Variable | Effect |
| --- | --- |
| `SCM_ENGINE_DIR` | Link the app to this engine folder (see [The engine](#the-engine)). |
| `SCM_ENGINE_CACHE` | Download cache of `npm run fetch-engine` (default `build/.engine-cache`). |
| `GITHUB_TOKEN`, `GH_TOKEN` | GitHub token for `npm run fetch-engine` (avoids the API rate limit; CI sets it). |
| `SCM_TEST_ENGINE_DIR` | Engine folder for the tests only. |
| `SCM_TEST_PYTHON` | Python for the tests (it needs the engine requirements). |
| `SCM_USER_DATA_DIR` | Use this folder for settings and logs. |
| `SCM_DATA_DIR` | Use this folder for app data (components, caches, default workspace). |
| `SCM_WORKSPACE_DIR` | Use this folder as the card maker data folder (it must contain the engine files). |
| `SCM_UPSCAYL_BIN` | Path to `upscayl-bin.exe` (skips detection). |
| `SCM_DISABLE_SINGLE_INSTANCE=1` | Allow several app windows (tests). |
| `SCM_NO_AUTO_OPEN=1` | Never open files, folders, other programs or web pages (tests). |
| `SCM_E2E=1` | Test mode: no confirmation dialogs on quit, no notifications. |

### Packaging notes

- `package.json` > `build` is the electron-builder configuration. `build/engine` is copied as is to
  `resources/engine` (its manifest included); `src/main/engine-files.js` decides which engine files that
  is. uv goes to `resources/bin`, and `src/python/` is unpacked from the asar archive so Python can run it.
- At startup the app copies the engine's Python files into the card maker data folder and refreshes that
  copy whenever the engine manifest changes (a new engine commit).
- The installer is a per-user one-click NSIS installer (no admin rights), installed in
  `%LOCALAPPDATA%\Programs\kirigami`. Uninstalling keeps user data.
- `appId` (`com.mtgtoolkit.kirigami`) must stay equal to `APP_ID` in `src/main/main.js`: Windows uses it
  to group the taskbar button and to show notifications from the shortcut the installer creates.
- Builds are not code-signed yet: users see SmartScreen warnings (documented above).
- `npmRebuild` is off: the app has no native modules.

### Architecture

- `src/main/`: the Electron main process, split into small services (paths, settings, jobs, Python
  environment, cards, fetch, Upscayl, PDF, printer alignment...). Only `main.js`, `ipc.js` and
  `protocol.js` use Electron APIs; the rest is plain Node and unit-tested. `engine-files.js` (the engine
  file set and manifest) and `engine-remote.js` (GitHub access with an injected `fetch`) are shared with
  the build scripts.
- `src/preload/preload.js`: exposes the `window.scm` API to the page (context isolation, sandbox).
- `src/python/scm_helper.py`: a helper the app runs with the card maker's Python (introspection,
  environment checks, image preparation, PDF merging).
- `src/renderer/`: the interface, in vanilla ES modules (no framework, no bundler). Plain-language
  data lives in `src/renderer/js/data/` (game catalog, option help, Upscayl models, help links).
- `scripts/`: build helpers (`fetch-uv.mjs`, `fetch-engine.mjs`, `checkout-engine.mjs`, `make-icon.py`).
- `test/unit`, `test/e2e`, `test/integration`, `test/fixtures`: tests and captured engine outputs;
  `test/support/engine.js` locates the engine for all of them.

## Releasing

Kirigami releases are published on [GitHub Releases](https://github.com/mtgtoolkit/kirigami/releases).

---

# License

Kirigami is released under the [MIT License](LICENSE), Copyright (c) 2026 mtgtoolkit. The Silhouette Card
Maker engine it bundles is MIT-licensed by Alan Cha. [LICENSES.md](LICENSES.md) has the full texts and
every third-party notice.
