'use strict';

// scripts/release-notes.mjs writes what users read on the release page (and in the app's update notes).
// These tests cover how commits are sorted and how the notes read for a first release, a normal release,
// an app-only and an engine-only release; git and GitHub stay out of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCRIPT = pathToFileURL(path.join(__dirname, '..', '..', 'scripts', 'release-notes.mjs')).href;
const load = () => import(SCRIPT);

const APP_URL = 'https://github.com/mtgtoolkit/kirigami';
const ENGINE_REPO = 'Alan-Cha/silhouette-card-maker';
const OLD_ENGINE = '1111111111111111111111111111111111111111';
const NEW_ENGINE = '0da09b729814aa5aafde024b5a6059624fa87951';
const ENGINE = Object.freeze({
  repository: ENGINE_REPO,
  ref: 'refs/heads/main',
  commit: NEW_ENGINE,
  committedAt: '2026-10-12T15:55:38Z',
  version: '3.0.0',
  title: 'Add Python 3.15 support',
});
const sha = (digit) => String(digit).repeat(40);
const COMMITS = Object.freeze([
  { sha: sha('a'), subject: 'docs: explain how to cut a release' },
  { sha: sha('b'), subject: 'fix(pdf): keep the bleed when cropping' },
  { sha: sha('c'), subject: 'chore(release): v1.1.0 [skip ci]' },
  { sha: sha('d'), subject: 'feat(updates): install app updates on restart' },
  { sha: sha('e'), subject: 'Merge the update work' },
  { sha: sha('f'), subject: 'feat!: drop Windows 7 support' },
]);

test('parseSubject: conventional subjects split into type, scope and text', async () => {
  const { parseSubject } = await load();
  assert.deepEqual(parseSubject('feat(engine): fetch a pinned engine'), { type: 'feat', scope: 'engine', text: 'fetch a pinned engine' });
  assert.deepEqual(parseSubject('fix: keep fixtures byte-exact'), { type: 'fix', scope: null, text: 'keep fixtures byte-exact' });
  assert.deepEqual(parseSubject('Feat!: breaking'), { type: 'feat', scope: null, text: 'breaking' });
  assert.deepEqual(parseSubject('  Update README  '), { type: null, scope: null, text: 'Update README' });
  assert.deepEqual(parseSubject('ci:'), { type: null, scope: null, text: 'ci:' });
});

test('groupCommits: New, Fixed, then everything else; release commits left out; order kept', async () => {
  const { groupCommits } = await load();
  assert.deepEqual(groupCommits(COMMITS), [
    {
      title: 'New',
      commits: [
        { sha: sha('d'), line: '**updates:** install app updates on restart' },
        { sha: sha('f'), line: 'drop Windows 7 support' },
      ],
    },
    { title: 'Fixed', commits: [{ sha: sha('b'), line: '**pdf:** keep the bleed when cropping' }] },
    {
      title: 'Other changes',
      commits: [
        { sha: sha('a'), line: 'docs: explain how to cut a release' },
        { sha: sha('e'), line: 'Merge the update work' },
      ],
    },
  ]);
  assert.deepEqual(groupCommits([{ sha: sha('c'), subject: 'chore(release): v1.0.0 [skip ci]' }]), []);
  assert.deepEqual(groupCommits([]), []);
});

test('renderReleaseNotes: a release after another one links the commits, the full diff and the engine diff', async () => {
  const { renderReleaseNotes } = await load();
  const notes = renderReleaseNotes({
    version: '1.2.0',
    appUrl: APP_URL,
    previousTag: 'v1.1.0',
    commits: COMMITS,
    engine: ENGINE,
    previousEngine: { repository: ENGINE_REPO, commit: OLD_ENGINE },
  });
  assert.equal(notes, [
    '## Changes since v1.1.0',
    '',
    '### New',
    '',
    `- **updates:** install app updates on restart ([ddddddd](${APP_URL}/commit/${sha('d')}))`,
    `- drop Windows 7 support ([fffffff](${APP_URL}/commit/${sha('f')}))`,
    '',
    '### Fixed',
    '',
    `- **pdf:** keep the bleed when cropping ([bbbbbbb](${APP_URL}/commit/${sha('b')}))`,
    '',
    '### Other changes',
    '',
    `- docs: explain how to cut a release ([aaaaaaa](${APP_URL}/commit/${sha('a')}))`,
    `- Merge the update work ([eeeeeee](${APP_URL}/commit/${sha('e')}))`,
    '',
    `Full list: [v1.1.0...v1.2.0](${APP_URL}/compare/v1.1.0...v1.2.0)`,
    '',
    '## Card maker engine',
    '',
    `This installer includes [Silhouette Card Maker](https://github.com/${ENGINE_REPO}) 3.0.0 at commit `
      + `[0da09b7](https://github.com/${ENGINE_REPO}/commit/${NEW_ENGINE}) "Add Python 3.15 support" (2026-10-12).`,
    '',
    `Engine changes since v1.1.0: [1111111...0da09b7](https://github.com/${ENGINE_REPO}/compare/${OLD_ENGINE}...${NEW_ENGINE})`,
    '',
  ].join('\n'));
});

test('renderReleaseNotes: the first release says so and has no comparison links', async () => {
  const { renderReleaseNotes } = await load();
  const notes = renderReleaseNotes({
    version: '1.0.0',
    appUrl: APP_URL,
    previousTag: null,
    commits: [{ sha: sha('d'), subject: 'feat: rename the app to Kirigami' }],
    engine: { ...ENGINE, version: null, title: null },
    previousEngine: null,
  });
  assert.match(notes, /^## Changes\n\nThe first release of Kirigami\.\n\n### New\n\n- rename the app to Kirigami /);
  assert.doesNotMatch(notes, /compare|Full list|since/);
  // Without the build/engine manifest or GitHub, the engine line still names the commit and its date.
  assert.match(notes, new RegExp(`includes \\[Silhouette Card Maker\\]\\(https://github.com/${ENGINE_REPO}\\) at commit \\[0da09b7\\]\\([^)]+\\) \\(2026-10-12\\)\\.\\n$`));
});

test('renderReleaseNotes: an engine-only release and an unchanged engine', async () => {
  const { renderReleaseNotes } = await load();
  const engineOnly = renderReleaseNotes({
    version: '1.0.1',
    appUrl: APP_URL,
    previousTag: 'v1.0.0',
    commits: [{ sha: sha('c'), subject: 'chore(release): v1.0.0 [skip ci]' }],
    engine: ENGINE,
    previousEngine: { repository: ENGINE_REPO, commit: OLD_ENGINE },
  });
  assert.match(engineOnly, /^## Changes since v1\.0\.0\n\nNo changes to the app itself since v1\.0\.0\.\n/);
  assert.match(engineOnly, /Engine changes since v1\.0\.0: \[1111111\.\.\.0da09b7\]/);

  const appOnly = renderReleaseNotes({
    version: '1.0.2',
    appUrl: APP_URL,
    previousTag: 'v1.0.1',
    commits: [{ sha: sha('b'), subject: 'fix: a fix' }],
    engine: ENGINE,
    previousEngine: { repository: ENGINE_REPO, commit: NEW_ENGINE },
  });
  assert.match(appOnly, /\n\nSame engine commit as v1\.0\.1\.\n$/);

  const moved = renderReleaseNotes({
    version: '1.0.3',
    appUrl: APP_URL,
    previousTag: 'v1.0.2',
    commits: [],
    engine: ENGINE,
    previousEngine: { repository: 'someone/fork', commit: OLD_ENGINE },
  });
  assert.match(moved, /v1\.0\.2 bundled someone\/fork at 1111111\./);
  assert.doesNotMatch(moved, /\/compare\/1111111/);
});
