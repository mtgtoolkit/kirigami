// Help and project links used by the sidebar Help menu, Setup, Print & cut, Settings (About) and the
// "Get cards" plugin pages.
//
// Pure data plus tiny helpers. No DOM access and no imports.
// Documentation URLs follow the Hugo site structure (hugo/content -> pretty URLs under the site base,
// e.g. content/tutorial/troubleshooting.md -> /tutorial/troubleshooting/); a unit test checks every one
// against hugo/content. The engine repository URL comes from the engine README / hugo.yaml.
//
// Two projects are linked from here: the documentation, community and donations belong to the
// Silhouette Card Maker engine (by Alan Cha), while app releases and bug reports belong to Kirigami
// itself, so "Check for updates" and "Report a problem" use APP_REPO_URL.

/** Silhouette Card Maker documentation site (GitHub Pages, deployed from the engine's hugo/). */
export const SITE_URL = 'https://alan-cha.github.io/silhouette-card-maker';

/** Silhouette Card Maker engine source repository (upstream). */
export const REPO_URL = 'https://github.com/Alan-Cha/silhouette-card-maker';

/** Kirigami's own repository: app releases and the issue tracker (package.json homepage). */
export const APP_REPO_URL = 'https://github.com/mtgtoolkit/kirigami';

/** Community Discord invite (README / hugo.yaml). */
export const DISCORD_URL = 'https://discord.gg/jhsKmAgbXc';

/**
 * @typedef {Object} HelpLink
 * @property {string} id
 * @property {string} label        Menu / button text.
 * @property {string} description  One line shown under the label or as a tooltip.
 * @property {string} url          Always http(s).
 * @property {string} icon         Icon name suggestion for ui.icon() (falls back to a generic link icon).
 * @property {string|null} source  Hugo content file the URL comes from (relative to hugo/content), null for external sites.
 */

/** @type {HelpLink[]} */
export const HELP_LINKS = [
  {
    id: 'tutorial', label: 'Tutorial', icon: 'book-open',
    description: 'Step-by-step guide to making your first cards, from supplies to cutting.',
    url: `${SITE_URL}/tutorial/`, source: 'tutorial/_index.md',
  },
  {
    id: 'troubleshooting', label: 'Troubleshooting', icon: 'life-buoy',
    description: 'Fixes for registration failures, wrong card sizes, misaligned backs and lamination problems.',
    url: `${SITE_URL}/tutorial/troubleshooting/`, source: 'tutorial/troubleshooting.md',
  },
  {
    id: 'supplies', label: 'Supply list', icon: 'shopping-cart',
    description: 'Recommended cutting machine, card stock, laminator and other supplies.',
    url: `${SITE_URL}/tutorial/supplies/`, source: 'tutorial/supplies.md',
  },
  {
    id: 'costs', label: 'Estimated costs', icon: 'info',
    description: 'What the equipment and each card cost.',
    url: `${SITE_URL}/tutorial/costs/`, source: 'tutorial/costs.md',
  },
  {
    id: 'primer', label: 'Silhouette primer', icon: 'scissors',
    description: 'How Silhouette cutting machines, mats, blades and registration marks work.',
    url: `${SITE_URL}/tutorial/primer/`, source: 'tutorial/primer.md',
  },
  {
    id: 'guide', label: 'Cutting guide', icon: 'scissors',
    description: 'Printing, laminating, placing the sheet on the mat and cutting.',
    url: `${SITE_URL}/tutorial/guide/`, source: 'tutorial/guide.md',
  },
  {
    id: 'cuttingSettings', label: 'Finding your cutting settings', icon: 'sliders',
    description: 'How to find the force, speed, depth and passes for your card stock.',
    url: `${SITE_URL}/tutorial/guide/#cutting-settings`, source: 'tutorial/guide.md',
  },
  {
    id: 'createDocs', label: 'PDF options reference', icon: 'file-text',
    description: 'Every option for making the PDF, explained (documentation of create_pdf.py).',
    url: `${SITE_URL}/docs/create/`, source: 'docs/create.md',
  },
  {
    id: 'offsetDocs', label: 'Printer alignment reference', icon: 'crosshair',
    description: 'How the alignment sheet and the front/back offset work (documentation of offset_pdf.py).',
    url: `${SITE_URL}/docs/offset/`, source: 'docs/offset.md',
  },
  {
    id: 'borderless', label: 'Tight layout (borderless templates)', icon: 'maximize',
    description: 'How the tight layout fits more cards and how to place the sheet on the mat.',
    url: `${SITE_URL}/miscellaneous/borderless/`, source: 'miscellaneous/borderless.md',
  },
  {
    id: 'verifyTemplates', label: 'Check a cutting template', icon: 'file-check',
    description: 'Compare the PDF pages with the cutting template in Silhouette Studio.',
    url: `${SITE_URL}/miscellaneous/verify/`, source: 'miscellaneous/verify.md',
  },
  {
    id: 'plugins', label: 'Supported games', icon: 'layers',
    description: 'The card download plugins and their deck list formats.',
    url: `${SITE_URL}/plugins/`, source: 'plugins/_index.md',
  },
  {
    id: 'discord', label: 'Discord', icon: 'message-circle',
    description: 'Ask questions, search solved problems in #troubleshooting and share your cards.',
    url: DISCORD_URL, source: null,
  },
  {
    id: 'website', label: 'Project website', icon: 'globe',
    description: 'Silhouette Card Maker documentation.',
    url: `${SITE_URL}/`, source: '_index.md',
  },
  {
    id: 'updates', label: 'Check for updates', icon: 'arrow-up-circle',
    description: 'Releases of Kirigami on GitHub.',
    url: `${APP_REPO_URL}/releases`, source: null,
  },
  {
    id: 'repo', label: 'Source code', icon: 'link',
    description: 'The Silhouette Card Maker engine on GitHub.',
    url: REPO_URL, source: null,
  },
  {
    id: 'issues', label: 'Report a problem', icon: 'alert-circle',
    description: 'Open an issue on GitHub (attach the log from the activity bar).',
    url: `${APP_REPO_URL}/issues`, source: null,
  },
  {
    id: 'donate', label: 'Donate', icon: 'star',
    description: 'Support the Silhouette Card Maker project.',
    url: `${SITE_URL}/donate/`, source: 'donate/_index.md',
  },
];

/** Ids of the sidebar Help menu, in order (spec §8.1). */
export const HELP_MENU = ['tutorial', 'troubleshooting', 'supplies', 'discord', 'website', 'updates'];

/** Third-party downloads the app points to (never bundled). */
export const EXTERNAL_LINKS = {
  upscayl: { label: 'Download Upscayl', url: 'https://upscayl.org', description: 'Free AI image upscaler (optional) for sharper prints.' },
  upscaylCustomModels: { label: 'More Upscayl models', url: 'https://github.com/upscayl/custom-models', description: 'Extra community models; select their "models" folder in the Upscale settings.' },
  silhouetteStudio: { label: 'Download Silhouette Studio', url: 'https://www.silhouetteamerica.com/silhouette-studio', description: 'Free software from Silhouette America to open the cutting templates and send them to your machine.' },
  keyforgeBlankBacks: { label: 'Blank KeyForge card backs', url: 'https://github.com/keyteki/keyteki/tree/master/client/assets/img/idbacks/idback_blanks', description: 'Card back images for KeyForge proxies.' },
};

const LINK_BY_ID = new Map(HELP_LINKS.map((l) => [l.id, l]));

/**
 * Help link by id.
 * @param {string} id
 * @returns {HelpLink|null}
 */
export function getHelpLink(id) {
  return (typeof id === 'string' && LINK_BY_ID.get(id)) || null;
}

/**
 * The sidebar Help menu entries, in order.
 * @returns {HelpLink[]}
 */
export function helpMenuLinks() {
  return HELP_MENU.map((id) => LINK_BY_ID.get(id)).filter(Boolean);
}

/**
 * Documentation page of a game plugin (hugo/content/plugins/<id>.md).
 * @param {string} pluginId e.g. 'mtg'
 * @returns {string}
 */
export function pluginDocsUrl(pluginId) {
  const id = String(pluginId || '').replace(/[^a-z0-9_]/gi, '');
  return id ? `${SITE_URL}/plugins/${id}/` : `${SITE_URL}/plugins/`;
}

/**
 * True for absolute http(s) URLs (the only kind scm.shell.openExternal accepts).
 * @param {string} url
 * @returns {boolean}
 */
export function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\/[^\s/]+/i.test(url.trim());
}
