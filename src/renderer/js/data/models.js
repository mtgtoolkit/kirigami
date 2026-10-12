// Upscayl built-in AI models, with friendly names and descriptions for the Upscale view.
//
// Pure data plus tiny helpers. No DOM access and no imports.
// Source: Upscayl 2.15.0 (common/models-list + renderer/locales/en.json), as installed on the reference
// machine (<Upscayl>\resources\models\<id>.param|.bin). Upscayl is AGPL software: the app never bundles it
// or its models, it only uses the copy the user installed. The main process reports which models are
// actually present (scm.upscayl.status().models); this file only adds names and descriptions.

/**
 * @typedef {Object} UpscaylModel
 * @property {string} id              File name without extension (<id>.param + <id>.bin).
 * @property {string} displayName     Name shown in Upscayl's own model list.
 * @property {string} description     Plain-language description (Upscayl's wording, lightly edited).
 * @property {boolean} nonCommercial  Upscayl marks these "Non-Commercial": not for commercial use.
 * @property {string} recommendedFor  When to pick it, for card proxies.
 * @property {number} scale           Native scale of the model.
 * @property {number} sizeMb          Approximate size of the .bin file.
 */

/** @type {UpscaylModel[]} In display order (the default first). */
export const UPSCAYL_MODELS = [
  {
    id: 'upscayl-standard-4x',
    displayName: 'Upscayl Standard',
    description: 'Suitable for most images.',
    nonCommercial: false,
    recommendedFor: 'Most card pictures. A good default.',
    scale: 4,
    sizeMb: 33.4,
  },
  {
    id: 'upscayl-lite-4x',
    displayName: 'Upscayl Lite',
    description: 'Suitable for most images. High-speed upscaling with minimal quality loss.',
    nonCommercial: false,
    recommendedFor: 'Big decks or older graphics cards: much faster, slightly softer.',
    scale: 4,
    sizeMb: 2.4,
  },
  {
    id: 'high-fidelity-4x',
    displayName: 'High Fidelity',
    description: 'For all kinds of images, with a focus on realistic details and smooth textures.',
    nonCommercial: false,
    recommendedFor: 'Painted or photographic card art.',
    scale: 4,
    sizeMb: 33.4,
  },
  {
    id: 'digital-art-4x',
    displayName: 'Digital Art',
    description: 'For digital art and illustrations.',
    nonCommercial: false,
    recommendedFor: 'Cartoon, anime and flat-color card art.',
    scale: 4,
    sizeMb: 8.9,
  },
  {
    id: 'remacri-4x',
    displayName: 'Remacri (Non-Commercial)',
    description: 'For natural images, with added sharpness and detail. No commercial use.',
    nonCommercial: true,
    recommendedFor: 'Extra crisp results for personal use.',
    scale: 4,
    sizeMb: 33.4,
  },
  {
    id: 'ultramix-balanced-4x',
    displayName: 'Ultramix (Non-Commercial)',
    description: 'For natural images, with a balance of sharpness and detail. No commercial use.',
    nonCommercial: true,
    recommendedFor: 'Balanced detail for personal use.',
    scale: 4,
    sizeMb: 33.4,
  },
  {
    id: 'ultrasharp-4x',
    displayName: 'Ultrasharp (Non-Commercial)',
    description: 'For natural images, with a focus on sharpness. No commercial use.',
    nonCommercial: true,
    recommendedFor: 'Maximum sharpness for personal use.',
    scale: 4,
    sizeMb: 33.4,
  },
];

/** Model used when the user has not chosen one (settings.upscayl.model default). */
export const DEFAULT_MODEL_ID = 'upscayl-standard-4x';

/** Order in which a replacement model is picked when the configured one is missing (spec §9.7). */
export const MODEL_FALLBACK_ORDER = ['upscayl-standard-4x', 'high-fidelity-4x', 'digital-art-4x'];

/** Built-in models Upscayl labels "Non-Commercial". */
export const NON_COMMERCIAL_MODEL_IDS = UPSCAYL_MODELS.filter((m) => m.nonCommercial).map((m) => m.id);

const MODEL_BY_ID = new Map(UPSCAYL_MODELS.map((m) => [m.id, m]));

/**
 * Built-in model info by id.
 * @param {string} id
 * @returns {UpscaylModel|null}
 */
export function getModel(id) {
  return (typeof id === 'string' && MODEL_BY_ID.get(id)) || null;
}

/**
 * Whether an id is one of Upscayl's built-in models.
 * @param {string} id
 * @returns {boolean}
 */
export function isBuiltInModel(id) {
  return MODEL_BY_ID.has(id);
}

/**
 * Native scale of a model, from its id: the first "<digit>x" (main-process rule, e.g. '4x_NMKD-Siax_200k'
 * -> 4), else the first "x<digit>" (names like 'realesr-animevideov3-x2' -> 2, which Upscayl itself also
 * recognizes), else 4. Only a fallback: prefer the `scale` reported by scm.upscayl.status().
 * @param {string} id
 * @returns {number}
 */
export function modelScale(id) {
  const builtIn = getModel(id);
  if (builtIn) return builtIn.scale;
  const match = /(\d)x/i.exec(String(id || '')) || /x(\d)/i.exec(String(id || ''));
  const n = match ? Number(match[1]) : 4;
  return n >= 1 && n <= 16 ? n : 4;
}

/**
 * Friendly name for any model id: the built-in display name, or a tidied version of a custom file name
 * ('4x_NMKD-Siax_200k' -> '4x NMKD Siax 200k').
 * @param {string} id
 * @returns {string}
 */
export function modelDisplayName(id) {
  const builtIn = getModel(id);
  if (builtIn) return builtIn.displayName;
  const text = String(id || '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || 'Unnamed model';
}

/**
 * Merge the models the main process found (scm.upscayl.status().models: { id, name, description, scale,
 * custom, nonCommercial }) with the friendly data above, keeping built-ins in display order and custom
 * models after them (by name).
 * @param {{id:string, scale?:number, custom?:boolean, nonCommercial?:boolean}[]} found
 * @returns {{id:string, displayName:string, description:string, recommendedFor:string, nonCommercial:boolean, custom:boolean, scale:number}[]}
 */
export function describeModels(found) {
  const list = Array.isArray(found) ? found.filter((m) => m && typeof m.id === 'string') : [];
  const order = new Map(UPSCAYL_MODELS.map((m, i) => [m.id, i]));
  const described = list.map((m) => {
    const builtIn = getModel(m.id);
    const custom = Boolean(m.custom) || !builtIn;
    return {
      id: m.id,
      displayName: builtIn && !m.custom ? builtIn.displayName : modelDisplayName(m.id),
      description: builtIn && !m.custom ? builtIn.description : 'Custom model from your custom models folder.',
      recommendedFor: builtIn && !m.custom ? builtIn.recommendedFor : '',
      nonCommercial: Boolean(m.nonCommercial) || Boolean(builtIn && builtIn.nonCommercial && !m.custom),
      custom,
      scale: Number.isFinite(m.scale) ? m.scale : modelScale(m.id),
    };
  });
  return described.sort((a, b) => {
    const ia = a.custom ? Infinity : (order.has(a.id) ? order.get(a.id) : Infinity);
    const ib = b.custom ? Infinity : (order.has(b.id) ? order.get(b.id) : Infinity);
    if (ia !== ib) return ia - ib;
    return a.displayName.localeCompare(b.displayName, undefined, { numeric: true, sensitivity: 'base' });
  });
}
