// Friendly documentation for every create_pdf.py and offset_pdf.py option, plus the plain-language
// reference data the PDF, Print & cut, Printer alignment and Setup views need (card and paper sizes,
// resolution presets, cutting machines, calibration steps, print tips, registration help).
//
// Pure data plus tiny helpers. No DOM access and no imports.
// Sources: create_pdf.py / offset_pdf.py click options, assets/layouts.json, README.md, the Hugo docs
// (tutorial, cutting guide, troubleshooting, borderless), and research verified on 2026-10-03.
//
// Copy rule: labels and help never show raw flag names. Treat every export as read-only.

/**
 * @typedef {Object} OptionDoc
 * @property {string} name            click parameter name (= settings.pdf.options key for create_pdf).
 * @property {string} flag            Long CLI flag (for "Show command" only; never shown in messages).
 * @property {'flag'|'choice'|'length'|'int'|'float'|'text'|'multi_int'|'path'} kind
 * @property {string} label           Friendly label (spec §8.4 copy rules).
 * @property {string} help            One or two plain sentences.
 * @property {string} valueFormat     What values are accepted, in plain words.
 * @property {string} recommended     Recommended value / when to use it.
 * @property {string} group           OPTION_GROUPS id.
 * @property {boolean} advanced       true = under "More options".
 * @property {boolean} [internal]     true = managed by the app (folders, output path, version): never shown.
 * @property {*} cliDefault           The engine's own default (null = option omitted).
 * @property {string[]} [units]       Units for length fields: crop ['mm','in','%'], extend_* ['mm','in','px'].
 *                                    '%' and 'px' mean a bare number on the command line.
 * @property {string[]} [choices]     Allowed values for choice options.
 * @property {string[]} [choiceLabels] Friendly labels, same order as choices.
 * @property {string[]} [choiceDescriptions] Optional one-line explanations, same order as choices.
 * @property {string} [nullLabel]     Label of the "not set" choice for optional choice options.
 * @property {{on:string, off:string}} [flagLabels] Labels for the two states of a flag shown as a choice
 *                                    (e.g. only_fronts: "Fronts only" / "Fronts and backs").
 * @property {number} [min]
 * @property {number} [max]
 * @property {string} [unit]          Unit suffix for number fields (e.g. 'PPI').
 * @property {string[]} [suggestions] Quick-pick values in command-line form (e.g. '2mm', '3.5mm').
 * @property {string} [warning]       Caveat to show when the option is turned on / set.
 * @property {string} [backsOf]       For *_backs options: the front option it mirrors.
 */

/** Option groups, in display order. */
export const OPTION_GROUPS = [
  { id: 'basics', label: 'Basics', description: 'Paper, card size and which sides to print.' },
  { id: 'quality', label: 'Print quality', description: 'How sharp the PDF is and how big the file gets.' },
  { id: 'image_fixes', label: 'Image fixes', description: 'Fix rounded corners, thin borders, extra bleed and picture shape.' },
  { id: 'backs', label: 'Back side', description: 'The same fixes for the common back image, and printer alignment.' },
  { id: 'cutting', label: 'Cutting machine', description: 'Registration marks, empty slots and cut-line preview.' },
  { id: 'layout', label: 'Layout', description: 'Tight layout, specialty layouts and the text printed on each sheet.' },
  { id: 'output', label: 'Output', description: 'PDF or PNG pages.' },
  { id: 'internal', label: 'Managed by the app', description: 'Folders and file paths the app fills in for you.' },
];

/** Units accepted by the length fields (lengthInput `units`). */
export const LENGTH_UNITS = {
  crop: ['mm', 'in', '%'],
  extend: ['mm', 'in', 'px'],
};

const CROP_FORMAT = 'A length per edge such as 3mm or 0.125in (measured on the finished card), or a percentage of the picture removed in total (6.5% = 3.25% from each side). Use a dot for decimals; no spaces, no negative numbers.';
const EXTEND_FORMAT = 'A length such as 0.5mm or 0.02in, or a number of pixels (measured at 300 PPI, whatever the print resolution). Use a dot for decimals; no spaces, no negative numbers. Empty or 0 = off.';

/** @type {Record<string, OptionDoc>} create_pdf.py options, in command-line order. */
export const CREATE_PDF_OPTIONS = {
  front_dir_path: {
    name: 'front_dir_path', flag: '--front_dir_path', kind: 'path',
    label: 'Card fronts folder',
    help: 'The folder with the front picture of every card. One picture = one printed card. The app always points this at a prepared copy of your cards.',
    valueFormat: 'A folder inside the card maker data folder (subfolders are included; natural name order).',
    recommended: 'Managed by the app (your cards from "Your cards").',
    group: 'internal', advanced: true, internal: true, cliDefault: 'game/front',
  },
  back_dir_path: {
    name: 'back_dir_path', flag: '--back_dir_path', kind: 'path',
    label: 'Common back folder',
    help: 'The folder with the ONE back picture printed behind every single-sided card. The app always passes a folder with your chosen back only.',
    valueFormat: 'A folder with 0 or 1 picture.',
    recommended: 'Managed by the app (Your cards, Common back).',
    group: 'internal', advanced: true, internal: true, cliDefault: 'game/back',
  },
  double_sided_dir_path: {
    name: 'double_sided_dir_path', flag: '--double_sided_dir_path', kind: 'path',
    label: 'Unique backs folder',
    help: 'Back pictures of double-faced cards. Each one has the same name as its front picture (the file type may differ).',
    valueFormat: 'A folder; each back must sit in the same subfolder as its front.',
    recommended: 'Managed by the app (Your cards, Unique backs).',
    group: 'internal', advanced: true, internal: true, cliDefault: 'game/double_sided',
  },
  output_path: {
    name: 'output_path', flag: '--output_path', kind: 'path',
    label: 'Save PDF as',
    help: 'Where the finished PDF is saved. A file with the same name is replaced.',
    valueFormat: 'A file name ending in .pdf.',
    recommended: 'Chosen with the file name and folder fields of Make PDF.',
    group: 'internal', advanced: true, internal: true, cliDefault: 'game/output/game.pdf',
  },
  output_images: {
    name: 'output_images', flag: '--output_images', kind: 'flag',
    label: 'Make PNG images instead of a PDF',
    help: 'Saves every page as a picture (page1.png, page2.png, ...) in a folder instead of making a PDF. Useful to check the layout against the cutting template in Silhouette Studio, or to print from other software.',
    valueFormat: 'On or off. With fronts and backs, odd pages are fronts and even pages are backs.',
    recommended: 'Off. Turn it on only to check the layout.',
    group: 'output', advanced: true, cliDefault: false,
  },
  card_size: {
    name: 'card_size', flag: '--card_size', kind: 'choice',
    label: 'Card size',
    help: 'The size of the cards you are making. It must match the cutting template you use. Standard fits most trading card games; Yu-Gi-Oh! uses Japanese size.',
    valueFormat: 'One of the card sizes in the list.',
    recommended: 'Standard (63 x 88 mm) for most games; Japanese (59 x 86 mm) for Yu-Gi-Oh!.',
    group: 'basics', advanced: false, cliDefault: 'standard',
    choices: null, // filled below from CARD_SIZES (canonical names only)
  },
  paper_size: {
    name: 'paper_size', flag: '--paper_size', kind: 'choice',
    label: 'Paper size',
    help: 'The paper you print on. Letter (US and Canada) and A4 (most other countries) fit the standard 12 x 12 in cutting mat; Legal, Tabloid, A3 and Arch B need a 12 x 24 in mat and a printer that takes them.',
    valueFormat: 'One of the paper sizes in the list.',
    recommended: 'Letter or A4, whichever your printer and country use.',
    group: 'basics', advanced: false, cliDefault: 'letter',
    choices: null, // filled below from PAPER_SIZES
  },
  registration: {
    name: 'registration', flag: '--registration', kind: 'choice',
    label: 'Registration marks (the corner marks your machine scans before cutting)',
    help: '3-corner marks (a black square and two L shapes) work with every Silhouette machine. 4-corner marks (L shapes in all corners) are the newer Cameo 5 Alpha style. Cameo 5 Alpha owners can keep 3-corner marks by selecting "Cameo 5" as the machine in Silhouette Studio, which many find more reliable.',
    valueFormat: '3 or 4.',
    recommended: 'Follow your cutting machine (set in Settings, Equipment).',
    group: 'cutting', advanced: true, cliDefault: '3',
    choices: ['3', '4'],
    choiceLabels: ['3-corner marks (all machines)', '4-corner marks (Cameo 5 Alpha)'],
    choiceDescriptions: [
      'Black square top-left, L shapes top-right and bottom-left.',
      'L shapes in all four corners. Select "Cameo 5 Alpha" as the machine in Silhouette Studio.',
    ],
  },
  registration_orientation: {
    name: 'registration_orientation', flag: '--registration_orientation', kind: 'choice',
    label: 'Registration mark direction',
    help: 'Turns only the registration marks, not the cards, as if the sheet were loaded the other way round. Only for special setups where you also changed the page orientation in Silhouette Studio; the included templates expect Automatic.',
    valueFormat: 'Automatic, Portrait or Landscape.',
    recommended: 'Automatic.',
    group: 'cutting', advanced: true, cliDefault: null,
    choices: ['portrait', 'landscape'], choiceLabels: ['Portrait', 'Landscape'],
    nullLabel: 'Automatic (match the card layout)',
    warning: 'The included cutting templates expect Automatic: change the page orientation in Silhouette Studio to match.',
  },
  specialty: {
    name: 'specialty', flag: '--specialty', kind: 'choice',
    label: 'Specialty layout',
    help: 'A ready-made layout that prints 100 mini cards per sheet (10 x 10), for example a whole Commander deck in miniature. It replaces the card and paper size.',
    valueFormat: 'None, A4 or Letter mini-card layout.',
    recommended: 'None.',
    group: 'layout', advanced: true, cliDefault: null,
    choices: ['a4-commander', 'letter-commander'],
    choiceLabels: ['100 mini cards on A4 (about 18 x 25 mm each)', '100 mini cards on Letter (about 17 x 24 mm each)'],
    nullLabel: 'None',
    warning: 'No cutting template is included for specialty layouts: you need your own. Cannot be combined with Tight layout.',
  },
  only_fronts: {
    name: 'only_fronts', flag: '--only_fronts', kind: 'flag',
    label: 'Fronts only',
    help: 'Prints only the card fronts, with no back pages. Choose "Fronts and backs" to print the common back and unique backs on the back of each sheet (needs two-sided printing on card stock).',
    valueFormat: 'Fronts only, or Fronts and backs.',
    recommended: 'Fronts only unless your printer prints two-sided on card stock and you did the Printer alignment.',
    group: 'basics', advanced: false, cliDefault: false,
    flagLabels: { on: 'Fronts only', off: 'Fronts and backs' },
  },
  fit: {
    name: 'fit', flag: '--fit', kind: 'choice',
    label: 'Image shape',
    help: 'What to do when a picture\'s proportions differ from the card. Stretch fills the card exactly (the picture may look squashed); Crop keeps the proportions and trims the overflow evenly from the edges. Applies to fronts and unique backs.',
    valueFormat: 'Stretch or Crop.',
    recommended: 'Stretch when your pictures already have the card\'s proportions (most downloaded cards); Crop when they don\'t.',
    group: 'image_fixes', advanced: true, cliDefault: 'stretch',
    choices: ['stretch', 'crop'], choiceLabels: ['Stretch', 'Crop'],
    choiceDescriptions: ['Fill the card exactly (may distort the picture).', 'Keep proportions and trim the overflow.'],
  },
  fit_backs: {
    name: 'fit_backs', flag: '--fit_backs', kind: 'choice',
    label: 'Image shape (common back)',
    help: 'Same choice as Image shape, for the common back picture only.',
    valueFormat: 'Same as fronts, Stretch or Crop.',
    recommended: 'Same as fronts.',
    group: 'backs', advanced: true, cliDefault: null, backsOf: 'fit',
    choices: ['stretch', 'crop'], choiceLabels: ['Stretch', 'Crop'],
    nullLabel: 'Same as fronts',
  },
  crop: {
    name: 'crop', flag: '--crop', kind: 'length',
    label: 'Trim image edges',
    help: 'Removes a border from every front picture (and unique back) before it is placed. Use it when your pictures already include extra print bleed around the card, such as MPCFill images, so the art lines up with the cut.',
    valueFormat: CROP_FORMAT,
    recommended: '3mm for pictures with built-in bleed (such as MPCFill); empty otherwise. Keep it small (up to about 10 mm or 20%).',
    group: 'image_fixes', advanced: true, cliDefault: null,
    units: LENGTH_UNITS.crop, suggestions: ['3mm'],
  },
  crop_backs: {
    name: 'crop_backs', flag: '--crop_backs', kind: 'length',
    label: 'Trim image edges (common back)',
    help: 'Same as Trim image edges, for the common back picture only (unique backs use the fronts setting).',
    valueFormat: CROP_FORMAT,
    recommended: '3mm if your back picture includes bleed; empty otherwise.',
    group: 'backs', advanced: true, cliDefault: null, backsOf: 'crop',
    units: LENGTH_UNITS.crop, suggestions: ['3mm'],
  },
  extend_edges: {
    name: 'extend_edges', flag: '--extend_edges', kind: 'length',
    label: 'Trim thin edge lines',
    help: 'Replaces a thin strip around each front picture with the colors just inside it. Fixes pictures with a faint (often 1-pixel) border line, which would otherwise show as a wrong-colored edge on cut cards.',
    valueFormat: EXTEND_FORMAT,
    recommended: 'A few pixels (3 px, about 0.25 mm) or 0.5mm. Keep it under about 3 mm.',
    group: 'image_fixes', advanced: true, cliDefault: null,
    units: LENGTH_UNITS.extend, suggestions: ['0.5mm', '3'],
  },
  extend_edges_backs: {
    name: 'extend_edges_backs', flag: '--extend_edges_backs', kind: 'length',
    label: 'Trim thin edge lines (common back)',
    help: 'Same as Trim thin edge lines, for the common back picture only.',
    valueFormat: EXTEND_FORMAT,
    recommended: 'Same value as the fronts if your back picture has a thin border line; empty otherwise.',
    group: 'backs', advanced: true, cliDefault: null, backsOf: 'extend_edges',
    units: LENGTH_UNITS.extend, suggestions: ['0.5mm', '3'],
  },
  extend_corners: {
    name: 'extend_corners', flag: '--extend_corners', kind: 'length',
    label: 'Fill rounded corners',
    help: 'Pictures with rounded corners leave white or dark slivers on the corners of cut cards. This fills the corner areas with the card\'s own edge colors. Enter roughly the corner radius of your pictures.',
    valueFormat: EXTEND_FORMAT,
    recommended: '2mm to 3.5mm for trading cards (3.5mm is the documented starting point; experiment). Values above about 10 mm make no sense.',
    group: 'image_fixes', advanced: true, cliDefault: null,
    units: LENGTH_UNITS.extend, suggestions: ['2mm', '3.5mm'],
  },
  extend_corners_backs: {
    name: 'extend_corners_backs', flag: '--extend_corners_backs', kind: 'length',
    label: 'Fill rounded corners (common back)',
    help: 'Same as Fill rounded corners, for the common back picture only.',
    valueFormat: EXTEND_FORMAT,
    recommended: 'Same value as the fronts if your back picture has rounded corners.',
    group: 'backs', advanced: true, cliDefault: null, backsOf: 'extend_corners',
    units: LENGTH_UNITS.extend, suggestions: ['2mm', '3.5mm'],
  },
  extend_bleed: {
    name: 'extend_bleed', flag: '--extend_bleed', kind: 'length',
    label: 'Extra outer bleed',
    help: 'Extends the card colors further past the outside edges of the cards along the sheet border (front pages), so a slightly off cut doesn\'t leave white edges. The gap between neighboring cards stays 1.25 mm.',
    valueFormat: EXTEND_FORMAT,
    recommended: 'Off, or a small value. Too much paints over the registration marks: on Letter with standard cards stay under about 0.6 mm; A4 allows about 4.5 mm.',
    group: 'image_fixes', advanced: true, cliDefault: null,
    units: LENGTH_UNITS.extend, suggestions: ['0.5mm', '1mm'],
    warning: 'Large values can cover the registration marks and make cutting fail.',
  },
  extend_bleed_backs: {
    name: 'extend_bleed_backs', flag: '--extend_bleed_backs', kind: 'length',
    label: 'Extra outer bleed (back pages)',
    help: 'Same as Extra outer bleed, for the back pages (common back and unique backs).',
    valueFormat: EXTEND_FORMAT,
    recommended: 'Same value as the fronts.',
    group: 'backs', advanced: true, cliDefault: null, backsOf: 'extend_bleed',
    units: LENGTH_UNITS.extend, suggestions: ['0.5mm', '1mm'],
    warning: 'Large values can cover the registration marks and make cutting fail.',
  },
  ppi: {
    name: 'ppi', flag: '--ppi', kind: 'int',
    label: 'Print resolution',
    help: 'How sharp the PDF is, in pixels per inch (PPI). Higher is sharper but makes bigger files, takes longer and needs much more memory. A resolution higher than your pictures adds no detail (unless they are upscaled).',
    valueFormat: 'A whole number from 1 to 2400.',
    recommended: '300 is normal print quality; 600 or more for high-resolution or upscaled pictures.',
    group: 'quality', advanced: false, cliDefault: 300,
    min: 1, max: 2400, unit: 'PPI',
  },
  quality: {
    name: 'quality', flag: '--quality', kind: 'int',
    label: 'JPEG quality',
    help: 'Each PDF page is stored as one JPEG picture. 100 keeps the best quality (largest file); lower numbers make smaller files but can add blur and blocky spots.',
    valueFormat: 'A whole number from 0 to 100.',
    recommended: '100. Below about 50 the pages look visibly worse.',
    group: 'quality', advanced: true, cliDefault: 100,
    min: 0, max: 100,
  },
  load_offset: {
    name: 'load_offset', flag: '--load_offset', kind: 'flag',
    label: 'Apply my printer alignment',
    help: 'Shifts and turns every back page by the correction you measured in Printer alignment, so fronts and backs line up. Only used when printing fronts and backs.',
    valueFormat: 'On or off.',
    recommended: 'On once you have done the Printer alignment and print fronts and backs.',
    group: 'backs', advanced: true, cliDefault: false,
    warning: 'Never used with Fronts only (it would shift every second front page).',
  },
  skip: {
    name: 'skip', flag: '--skip', kind: 'multi_int',
    label: 'Leave slot empty',
    help: 'Leaves chosen card slots empty on every sheet (and the matching back slots). Often used for the slot next to the bottom-left registration mark, when the cutter confuses card art with the mark. Click slots in the page preview.',
    valueFormat: 'Slots chosen in the page preview. Leaving every slot empty is not allowed.',
    recommended: 'None. If registration fails, leave the slot next to the bottom-left mark empty.',
    group: 'cutting', advanced: false, cliDefault: [],
    min: 0,
  },
  label: {
    name: 'label', flag: '--label', kind: 'text',
    label: 'Text printed on each sheet',
    help: 'Your own short text (for example the deck name) printed along the edge of each front page, before the sheet number and template name.',
    valueFormat: 'Any short text; keep it under about 40 characters so it stays clear of the corner marks.',
    recommended: 'A short deck name, or empty.',
    group: 'layout', advanced: true, cliDefault: null,
    max: 40,
  },
  show_outline: {
    name: 'show_outline', flag: '--show_outline', kind: 'flag',
    label: 'Show cut lines',
    help: 'Draws a thin white line exactly where each card will be cut, to check that important art or text isn\'t too close to the edge.',
    valueFormat: 'On or off.',
    recommended: 'Off for real prints; on only to preview.',
    group: 'cutting', advanced: true, cliDefault: false,
    warning: 'The cut lines are part of the PDF and will be printed.',
  },
  borderless: {
    name: 'borderless', flag: '--borderless', kind: 'flag',
    label: 'Tight layout (fits more cards; special mat placement)',
    help: 'Moves the registration marks closer to the paper edge (3.5 mm instead of 10 mm), so more cards fit on many sizes (Letter with standard cards: 9 instead of 8). Uses the matching tight-layout cutting template, and the sheet must be placed 6.5 mm away from the mat grid.',
    valueFormat: 'On or off. Not available on A3 or Arch B, nor with a specialty layout.',
    recommended: 'Off unless your printer prints accurately close to the edge at 100% scale.',
    group: 'layout', advanced: true, cliDefault: false,
    warning: 'Place the sheet 6.5 mm away from the mat grid, and make sure your printer prints the marks 3.5 mm from the edge without scaling.',
  },
  version: {
    name: 'version', flag: '--version', kind: 'flag',
    label: 'Show program version',
    help: 'Prints the card maker version and stops without making anything.',
    valueFormat: 'Not used by the app.',
    recommended: 'Not used.',
    group: 'internal', advanced: true, internal: true, cliDefault: false,
  },
};

/** @type {Record<string, OptionDoc>} offset_pdf.py options, in command-line order. */
export const OFFSET_OPTIONS = {
  pdf_path: {
    name: 'pdf_path', flag: '--pdf_path', kind: 'path',
    label: 'PDF to align',
    help: 'The PDF whose back pages (pages 2, 4, 6...) should be moved. It must have alternating front and back pages.',
    valueFormat: 'An existing PDF file.',
    recommended: 'A PDF made with "Fronts and backs" and without "Apply my printer alignment".',
    group: 'internal', advanced: false, cliDefault: 'game/output/game.pdf',
  },
  output_pdf_path: {
    name: 'output_pdf_path', flag: '--output_pdf_path', kind: 'path',
    label: 'Save aligned PDF as',
    help: 'Where the aligned copy is saved. The original PDF is not changed.',
    valueFormat: 'A file name ending in .pdf.',
    recommended: 'The app saves "<name>_offset.pdf" in your output folder.',
    group: 'internal', advanced: true, internal: true, cliDefault: null,
  },
  x_offset: {
    name: 'x_offset', flag: '--x_offset', kind: 'int',
    label: 'Horizontal shift (X)',
    help: 'Moves every back page left or right, in steps of 1/300 inch (about 0.085 mm): positive = right, negative = left, as seen when looking at the back. Read it from the alignment sheet.',
    valueFormat: 'A whole number (can be negative).',
    recommended: 'The first red number of the square that lines up.',
    group: 'backs', advanced: false, cliDefault: null,
    unit: 'steps',
  },
  y_offset: {
    name: 'y_offset', flag: '--y_offset', kind: 'int',
    label: 'Vertical shift (Y)',
    help: 'Moves every back page up or down in the same 1/300-inch steps: positive = up, negative = down, as seen when looking at the back.',
    valueFormat: 'A whole number (can be negative).',
    recommended: 'The second red number of the square that lines up.',
    group: 'backs', advanced: false, cliDefault: null,
    unit: 'steps',
  },
  angle: {
    name: 'angle', flag: '--angle', kind: 'float',
    label: 'Rotation (degrees)',
    help: 'Turns every back page around its center: positive = clockwise, negative = counter-clockwise, as seen when looking at the back. Only needed when cards in the middle line up but cards near opposite edges are off in opposite directions.',
    valueFormat: 'A decimal number of degrees, usually between -1 and 1 (for example 0.2).',
    recommended: '0. Try small steps such as 0.1 to 0.3 only if needed.',
    group: 'backs', advanced: true, cliDefault: null,
    unit: '°',
  },
  save: {
    name: 'save', flag: '--save', kind: 'flag',
    label: 'Remember these values',
    help: 'Saves the shift and rotation so they are used for every new PDF with "Apply my printer alignment". The app saves them for you.',
    valueFormat: 'Not used by the app (it writes the alignment file itself).',
    recommended: 'Managed by the app.',
    group: 'internal', advanced: true, internal: true, cliDefault: false,
  },
  ppi: {
    name: 'ppi', flag: '--ppi', kind: 'int',
    label: 'Resolution',
    help: 'The PDF is redrawn at this resolution. Use the resolution the PDF was made with to keep it sharp; the physical shift stays the same at any resolution.',
    valueFormat: 'A whole number from 1 to 2400.',
    recommended: 'The PDF\'s own resolution (detected automatically), else 300.',
    group: 'quality', advanced: true, cliDefault: 300,
    min: 1, max: 2400, unit: 'PPI',
  },
};

/**
 * @typedef {Object} CardSizeInfo
 * @property {string} name        Canonical create_pdf name.
 * @property {string} label       Friendly name.
 * @property {number} widthMm     As defined in assets/layouts.json (some sizes are wider than tall).
 * @property {number} heightMm
 * @property {string} dimensions  Display string in the size's native unit, e.g. '63 x 88 mm' or '2.5 x 3.5 in'.
 * @property {string} games       Typical games / uses.
 * @property {string[]} aliases   Other names create_pdf accepts (resolve before any lookup).
 * @property {boolean} common     Shown first in the card size select.
 * @property {boolean} landscape  Defined wider than tall: portrait pictures are squashed unless rotated.
 */

/** @type {CardSizeInfo[]} Canonical card sizes (assets/layouts.json), most useful first. */
export const CARD_SIZES = [
  { name: 'standard', label: 'Standard', widthMm: 63, heightMm: 88, dimensions: '63 x 88 mm', games: 'Most trading card games: Magic: The Gathering, Pokémon, Lorcana, One Piece, Riftbound, Digimon, Star Wars: Unlimited, Flesh and Blood, KeyForge and more', aliases: ['euro_poker'], common: true, landscape: false },
  { name: 'japanese', label: 'Japanese', widthMm: 59, heightMm: 86, dimensions: '59 x 86 mm', games: 'Yu-Gi-Oh! and other Japanese-size card games', aliases: [], common: true, landscape: false },
  { name: 'poker', label: 'Poker', widthMm: 63.5, heightMm: 88.9, dimensions: '2.5 x 3.5 in', games: 'Standard playing cards and poker-size card games', aliases: [], common: true, landscape: false },
  { name: 'bridge', label: 'Bridge', widthMm: 57.15, heightMm: 88.9, dimensions: '2.25 x 3.5 in', games: 'Bridge-size playing cards', aliases: [], common: true, landscape: false },
  { name: 'standard_double', label: 'Oversized (standard double)', widthMm: 88, heightMm: 126, dimensions: '88 x 126 mm', games: 'Magic: The Gathering oversized cards: Planechase, Archenemy, oversized Commander', aliases: [], common: true, landscape: false },
  { name: 'tarot', label: 'Tarot', widthMm: 69.85, heightMm: 120.65, dimensions: '2.75 x 4.75 in', games: 'Tarot cards and tarot-size game cards', aliases: [], common: true, landscape: false },
  { name: 'jumbo', label: 'Jumbo', widthMm: 88.9, heightMm: 139.7, dimensions: '3.5 x 5.5 in', games: 'Jumbo / oversized cards', aliases: [], common: false, landscape: false },
  { name: 'mini', label: 'Mini', widthMm: 44.45, heightMm: 63.5, dimensions: '1.75 x 2.5 in', games: 'Mini cards', aliases: [], common: false, landscape: false },
  { name: 'euro_mini', label: 'Mini European', widthMm: 44, heightMm: 68, dimensions: '44 x 68 mm', games: 'Mini European board-game cards', aliases: ['mini_euro'], common: false, landscape: false },
  { name: 'american_mini', label: 'Mini American', widthMm: 41, heightMm: 63, dimensions: '41 x 63 mm', games: 'Mini American board-game cards', aliases: ['mini_american'], common: false, landscape: false },
  { name: 'catan', label: 'Catan', widthMm: 54, heightMm: 80, dimensions: '54 x 80 mm', games: 'Catan-size cards and other 54 x 80 mm board-game cards', aliases: [], common: false, landscape: false },
  { name: 'business', label: 'Business card (US)', widthMm: 88.9, heightMm: 50.8, dimensions: '3.5 x 2 in', games: 'US business cards (wide: use landscape pictures)', aliases: [], common: false, landscape: true },
  { name: 'euro_business', label: 'Business card (EU) / photocard', widthMm: 85, heightMm: 55, dimensions: '85 x 55 mm', games: 'European business cards and K-pop photocards (wide: rotate portrait pictures first)', aliases: ['photo'], common: false, landscape: true },
  { name: 'credit', label: 'Credit card', widthMm: 85.725, heightMm: 53.975, dimensions: '3.375 x 2.125 in', games: 'Credit-card / ID-card size items (wide: use landscape pictures)', aliases: [], common: false, landscape: true },
  { name: 'domino', label: 'Domino', widthMm: 44.45, heightMm: 88.9, dimensions: '1.75 x 3.5 in', games: 'Domino-shaped cards or tiles', aliases: [], common: false, landscape: false },
  { name: '70mm_square', label: 'Square 70 mm', widthMm: 70, heightMm: 70, dimensions: '70 x 70 mm', games: 'Square cards or tiles', aliases: [], common: false, landscape: false },
  { name: 'bridge_square', label: 'Square 2.25 in', widthMm: 57.15, heightMm: 57.15, dimensions: '2.25 x 2.25 in', games: 'Square cards', aliases: [], common: false, landscape: false },
  { name: 'domino_square', label: 'Square 1.75 in', widthMm: 44.45, heightMm: 44.45, dimensions: '1.75 x 1.75 in', games: 'Small square cards or tokens', aliases: [], common: false, landscape: false },
  { name: 'micro', label: 'Micro', widthMm: 31.75, heightMm: 44.45, dimensions: '1.25 x 1.75 in', games: 'Tiny cards', aliases: [], common: false, landscape: false },
];

/**
 * @typedef {Object} PaperSizeInfo
 * @property {string} name        Canonical create_pdf name.
 * @property {string} label       Friendly label with size, e.g. 'A4 (210 x 297 mm)'.
 * @property {string} shortLabel  e.g. 'A4'.
 * @property {number} widthMm     Short side (portrait, as the sheet goes into the printer).
 * @property {number} heightMm    Long side.
 * @property {string} region      Where it is common.
 * @property {string} mat         Cutting mat needed.
 * @property {boolean} calibrationIncluded  An alignment sheet ships with the card maker (else it is generated).
 * @property {boolean} tightLayout          Tight layout (borderless) templates exist.
 * @property {string[]} aliases
 */

/** @type {PaperSizeInfo[]} Canonical paper sizes (assets/layouts.json). */
export const PAPER_SIZES = [
  { name: 'letter', label: 'Letter (8.5 x 11 in)', shortLabel: 'Letter', widthMm: 215.9, heightMm: 279.4, region: 'US, Canada and parts of Latin America', mat: '12 x 12 in', calibrationIncluded: true, tightLayout: true, aliases: ['ansi_a'] },
  { name: 'a4', label: 'A4 (210 x 297 mm)', shortLabel: 'A4', widthMm: 210, heightMm: 297, region: 'Most other countries', mat: '12 x 12 in', calibrationIncluded: true, tightLayout: true, aliases: [] },
  { name: 'legal', label: 'Legal (8.5 x 14 in)', shortLabel: 'Legal', widthMm: 215.9, heightMm: 355.6, region: 'US and Canada', mat: '12 x 24 in', calibrationIncluded: false, tightLayout: true, aliases: [] },
  { name: 'tabloid', label: 'Tabloid (11 x 17 in)', shortLabel: 'Tabloid', widthMm: 279.4, heightMm: 431.8, region: 'US and Canada (large printers)', mat: '12 x 24 in', calibrationIncluded: true, tightLayout: true, aliases: ['ansi_b'] },
  { name: 'a3', label: 'A3 (297 x 420 mm)', shortLabel: 'A3', widthMm: 297, heightMm: 420, region: 'Large printers outside North America', mat: '12 x 24 in', calibrationIncluded: true, tightLayout: false, aliases: [] },
  { name: 'arch_b', label: 'Arch B (12 x 18 in)', shortLabel: 'Arch B', widthMm: 304.8, heightMm: 457.2, region: 'Large-format printers', mat: '12 x 24 in', calibrationIncluded: true, tightLayout: false, aliases: [] },
];

/** Print resolution presets for Make PDF (a "Custom" entry is added by the view). */
export const PPI_PRESETS = [
  { value: 300, label: 'Standard', description: 'Normal print quality. Small files, quick to make.' },
  { value: 600, label: 'High', description: 'Sharper with high-resolution or upscaled pictures. About 4x the memory and file size of Standard.' },
  { value: 1200, label: 'Very high', description: 'For upscaled pictures on a good printer. Needs a lot of memory; big decks are made in parts.' },
  { value: 1440, label: 'Maximum', description: 'Matches high-end photo printers. Needs the most memory and time; big decks are made in parts.' },
];

/**
 * @typedef {Object} MachineInfo
 * @property {string} id                 settings.equipment.machine value.
 * @property {string} label
 * @property {string} description
 * @property {'3'|'4'} registration      Registration marks to use by default.
 * @property {string} studioMachine      Machine to select in Silhouette Studio with that registration.
 * @property {{registration:'3'|'4', studioMachine:string, label:string}|null} alternative  Other valid setup.
 * @property {string} mat                Cutting mat for Letter / A4.
 * @property {string[]|null} supportedPapers  null = any paper (with the right mat).
 * @property {string|null} paperWarning  Shown when another paper is chosen.
 */

/** @type {MachineInfo[]} Cutting machines offered in Setup and Settings. */
export const MACHINES = [
  {
    id: 'cameo5alpha', label: 'Cameo 5 Alpha',
    description: 'Can read the newer 4-corner marks.',
    registration: '4', studioMachine: 'Cameo 5 Alpha',
    alternative: { registration: '3', studioMachine: 'Cameo 5', label: '3-corner marks (often more reliable): then select "Cameo 5" in Silhouette Studio' },
    mat: '12 x 12 in (12 x 24 in for Legal, Tabloid, A3 and Arch B)',
    supportedPapers: null, paperWarning: null,
  },
  {
    id: 'cameo5', label: 'Cameo 5',
    description: 'Cameo 5 or Cameo 5 Plus. Uses 3-corner marks.',
    registration: '3', studioMachine: 'Cameo 5',
    alternative: null,
    mat: '12 x 12 in (12 x 24 in for Legal, Tabloid, A3 and Arch B)',
    supportedPapers: null, paperWarning: null,
  },
  {
    id: 'cameo4', label: 'Cameo 4',
    description: 'Cameo 4, 4 Plus or 4 Pro. Uses 3-corner marks.',
    registration: '3', studioMachine: 'Cameo 4',
    alternative: null,
    mat: '12 x 12 in (12 x 24 in for Legal, Tabloid, A3 and Arch B)',
    supportedPapers: null, paperWarning: null,
  },
  {
    id: 'portrait', label: 'Portrait',
    description: 'Portrait 3 or Portrait 4. Uses 3-corner marks; cuts sheets up to Letter / A4.',
    registration: '3', studioMachine: 'your Portrait model',
    alternative: null,
    mat: '8 x 12 in',
    supportedPapers: ['letter', 'a4'],
    paperWarning: 'The Portrait only cuts sheets up to Letter or A4 size.',
  },
  {
    id: 'other', label: 'Other / not sure',
    description: '3-corner marks work with every Silhouette machine.',
    registration: '3', studioMachine: 'your machine',
    alternative: null,
    mat: '12 x 12 in (12 x 24 in for Legal, Tabloid, A3 and Arch B)',
    supportedPapers: null, paperWarning: null,
  },
];

/** Countries that use Letter paper (app.getLocaleCountryCode()); everyone else gets A4. */
export const LETTER_COUNTRIES = ['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'CR', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN'];

/**
 * Printer alignment (offset) steps for the Printer alignment view. `text` may contain {paper}.
 * @type {{id:string, title:string, text:string}[]}
 */
export const CALIBRATION_STEPS = [
  {
    id: 'print',
    title: 'Print the alignment sheet',
    text: 'Print the 2-page alignment sheet for {paper} on the card stock you will use, two-sided with "Flip on long edge", at "Actual size" / 100% (never "Fit to page"). Use the same printer and settings as for your cards.',
  },
  {
    id: 'look',
    title: 'Look through the sheet',
    text: 'Hold the sheet against a window or a strong lamp and look at the BACK side ("Back"). You will see the front squares shining through next to the printed back squares, each with small red numbers.',
  },
  {
    id: 'find',
    title: 'Find the square that lines up',
    text: 'Find the square where the back square sits exactly on top of its shadow, so you see one crisp square instead of two. Type its two red numbers: the first is X, the second is Y. If the middle square (0, 0) lines up best, your printer needs no correction.',
  },
  {
    id: 'save',
    title: 'Save your alignment',
    text: 'Save the numbers. If the sheet you printed already included a correction, choose "Add to my current alignment". From now on, "Apply my printer alignment" corrects the back pages of new PDFs.',
  },
  {
    id: 'verify',
    title: 'Check it (optional)',
    text: 'Print a check sheet made with your saved numbers: the middle square (0, 0) should now line up.',
  },
];

/** Extra guidance for the Printer alignment view. */
export const CALIBRATION_NOTES = {
  intro: 'Only needed for two-sided printing. Redo it after changing printer, paper size or card stock.',
  units: 'One step is 1/300 inch (about 0.085 mm). Positive X moves the backs right, positive Y moves them up, as seen when looking at the back.',
  noMatch: 'If no square lines up, your printer\'s shift is bigger than the sheet shows: make a shifted sheet (for example 20 steps in the direction the backs need to move), print it, find the square that lines up, and add the numbers to the shift you used.',
  rotation: 'The sheet measures shift, not rotation. If cards in the middle line up but cards near opposite edges are off in opposite directions, the back is slightly turned: try 0.1 to 0.3 degrees (positive if the backs look turned counter-clockwise compared with the fronts, negative if clockwise).',
  doubleCorrection: 'Use the alignment once: either "Apply my printer alignment" when making the PDF, or align an existing PDF, never both.',
  legal: 'No alignment sheet ships for Legal paper: the app makes one for you.',
};

/**
 * One checklist line of Print & cut.
 * @typedef {Object} Tip
 * @property {string} id
 * @property {string} text  May contain placeholders filled by fillPlaceholders(): {paper} paper label,
 *                          {cardDims} card size like "63 x 88 mm", {template} template name,
 *                          {studioMachine} machine to select in Silhouette Studio.
 * @property {'always'|'twoSided'|'tight'|'largePaper'|'threeMarks'|'fourMarks'} when  Show only in that situation.
 */

/** @type {{print: Tip[], check: Tip[], cut: Tip[], finish: Tip[]}} Print & cut checklist, by section. */
export const PRINT_TIPS = {
  print: [
    { id: 'viewer', when: 'always', text: 'Open the PDF in your PDF viewer and print from there (not from Silhouette Studio).' },
    { id: 'scale', when: 'always', text: 'Set the scale to "Actual size" or 100%. Never use "Fit", "Shrink oversized pages" or "Fit to printable area": the cards would come out the wrong size and registration would fail.' },
    { id: 'paper', when: 'always', text: 'Choose the paper size {paper}.' },
    { id: 'quality', when: 'always', text: 'Choose the best print quality and the paper type that matches your card stock.' },
    { id: 'borderless', when: 'always', text: 'Turn off the printer\'s own borderless printing mode.' },
    { id: 'duplex', when: 'twoSided', text: 'Print two-sided with "Flip on long edge". Without automatic two-sided printing: print the odd pages, put the stack back in the tray, then print the even pages. Try it on plain paper first.' },
  ],
  check: [
    { id: 'measure', when: 'always', text: 'Measure one printed card: it must be exactly {cardDims}. If it isn\'t, scaling is still on in the print settings.' },
    { id: 'margins', when: 'always', text: 'Compare the white margins with the PDF: they must match.' },
    { id: 'laminate', when: 'always', text: 'Optional: laminate the sheets. Card stock is thick, so use a higher laminator setting than the pouch rating.' },
  ],
  cut: [
    { id: 'template', when: 'always', text: 'Open the cutting template {template} in Silhouette Studio (its name is also printed along the edge of each sheet).' },
    { id: 'machine', when: 'always', text: 'Select your machine in Silhouette Studio: {studioMachine}.' },
    { id: 'place', when: 'always', text: 'Place the sheet in the top-left corner of the mat grid, aligned by the paper edge (not the lamination), as shown in Silhouette Studio.' },
    { id: 'square', when: 'threeMarks', text: 'The black square goes at the top left.' },
    { id: 'tight', when: 'tight', text: 'Tight layout: keep the sheet 6.5 mm away from the mat grid on the top and left (masking tape over the grid helps).' },
    { id: 'bigmat', when: 'largePaper', text: 'This paper is longer than 12 in: use a 12 x 24 in cutting mat.' },
    { id: 'postit', when: 'always', text: 'If registration fails, cover the card next to the bottom-left mark with a Post-it note (remove it after registration, before cutting), or leave that slot empty in Make PDF.' },
    { id: 'settings', when: 'always', text: 'Templates contain no cut settings: test on scrap first. Start around force 25, speed 25, depth 7 and 1 pass, then add passes until the cut is clean. Save them as a material in Silhouette Studio.' },
    { id: 'send', when: 'always', text: 'Load the mat (left edge against the notch, pinch rollers in place) and click Send.' },
  ],
  finish: [
    { id: 'peel', when: 'always', text: 'Peel off the cards and remove the waste.' },
    { id: 'reseal', when: 'always', text: 'If you laminated, put the cut cards through the laminator again to seal the edges.' },
    { id: 'first', when: 'always', text: 'Make your first sheet on plain card stock to find your cutting settings and check registration before printing a real deck.' },
  ],
};

/** Plain-language explanation of registration marks. */
export const REGISTRATION_HELP = {
  title: 'Registration marks',
  summary: 'The small black shapes near the corners of every sheet. Before cutting, your Silhouette scans them to find exactly where the printed cards are on the mat, even if the sheet is slightly crooked.',
  three: '3-corner marks: a black square at the top left and L shapes at the top right and bottom left (the bottom right stays empty). Works with every Silhouette machine; the included cutting templates are made for it.',
  four: '4-corner marks: L shapes in all four corners. Only for the Cameo 5 Alpha, with "Cameo 5 Alpha" selected as the machine in Silhouette Studio. Many Alpha owners keep 3-corner marks and select "Cameo 5" instead, which is often more reliable.',
  topLeft: '"Top left" means the corner with the black square when the sheet is placed the way the template shows it. Layouts printed sideways show the square at the bottom left of the PDF preview: that is normal.',
  orientation: 'Registration mark direction turns only the marks, not the cards. Leave it on Automatic unless you load the sheet the other way round and changed the page orientation in Silhouette Studio to match.',
  troubleshooting: [
    'Keep the area around the marks clean and light-colored.',
    'Cover the card next to the bottom-left mark with a Post-it note (remove it before cutting), or leave that slot empty.',
    'Change the room lighting; avoid direct sunlight on the machine.',
    'Check that you printed at 100% scale and placed the sheet exactly as the template shows.',
    'On foil or holographic card stock, put matte tape over the marks.',
  ],
};

/** "Leave slot empty" explanation for the page preview. */
export const SKIP_HELP = 'Click a slot in the preview to leave it empty on every sheet (the matching back slot stays empty too). The slot next to the bottom-left registration mark is the usual choice when the cutter confuses card art with the mark.';

// Fill choice lists from the canonical size tables (single source of truth).
CREATE_PDF_OPTIONS.card_size.choices = CARD_SIZES.map((c) => c.name);
CREATE_PDF_OPTIONS.card_size.choiceLabels = CARD_SIZES.map((c) => `${c.label} (${c.dimensions})`);
CREATE_PDF_OPTIONS.paper_size.choices = PAPER_SIZES.map((p) => p.name);
CREATE_PDF_OPTIONS.paper_size.choiceLabels = PAPER_SIZES.map((p) => p.label);

const CARD_ALIASES = new Map(CARD_SIZES.flatMap((c) => c.aliases.map((a) => [a, c.name])));
const PAPER_ALIASES = new Map(PAPER_SIZES.flatMap((p) => p.aliases.map((a) => [a, p.name])));

/**
 * Documentation for an option.
 * @param {string} name   Option name, e.g. 'extend_corners'.
 * @param {'create_pdf'|'offset_pdf'} [command]
 * @returns {OptionDoc|null}
 */
export function getOptionDoc(name, command = 'create_pdf') {
  const table = command === 'offset_pdf' ? OFFSET_OPTIONS : CREATE_PDF_OPTIONS;
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name] : null;
}

/**
 * Canonical card size name for a name or alias (case-insensitive); null when unknown.
 * @param {string} name e.g. 'euro_poker' -> 'standard'.
 * @returns {string|null}
 */
export function resolveCardSize(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (CARD_SIZES.some((c) => c.name === key)) return key;
  return CARD_ALIASES.get(key) || null;
}

/**
 * Canonical paper size name for a name or alias (case-insensitive); null when unknown.
 * @param {string} name e.g. 'ansi_a' -> 'letter'.
 * @returns {string|null}
 */
export function resolvePaperSize(name) {
  if (typeof name !== 'string') return null;
  const key = name.trim().toLowerCase();
  if (PAPER_SIZES.some((p) => p.name === key)) return key;
  return PAPER_ALIASES.get(key) || null;
}

/**
 * Card size info by name or alias.
 * @param {string} name
 * @returns {CardSizeInfo|null}
 */
export function getCardSize(name) {
  const canonical = resolveCardSize(name);
  return canonical ? CARD_SIZES.find((c) => c.name === canonical) || null : null;
}

/**
 * Paper size info by name or alias.
 * @param {string} name
 * @returns {PaperSizeInfo|null}
 */
export function getPaperSize(name) {
  const canonical = resolvePaperSize(name);
  return canonical ? PAPER_SIZES.find((p) => p.name === canonical) || null : null;
}

/**
 * Friendly card size text, e.g. 'Japanese (59 x 86 mm)'. Falls back to the raw name.
 * @param {string} name
 * @returns {string}
 */
export function describeCardSize(name) {
  const info = getCardSize(name);
  return info ? `${info.label} (${info.dimensions})` : String(name || '');
}

/**
 * Cutting machine info.
 * @param {string|null} id settings.equipment.machine
 * @returns {MachineInfo|null}
 */
export function getMachine(id) {
  return MACHINES.find((m) => m.id === id) || null;
}

/**
 * Registration marks for a machine (spec: Cameo 5 Alpha -> '4', every other machine or unknown -> '3').
 * @param {string|null} machineId
 * @returns {'3'|'4'}
 */
export function registrationForMachine(machineId) {
  const machine = getMachine(machineId);
  return machine ? machine.registration : '3';
}

/**
 * Whether a registration choice fits the machine (both 3 and 4 are fine on the Cameo 5 Alpha; only 3
 * elsewhere). Unknown machine -> true (nothing to contradict).
 * @param {string|null} machineId
 * @param {string} registration '3' | '4'
 * @returns {boolean}
 */
export function registrationFitsMachine(machineId, registration) {
  const machine = getMachine(machineId);
  if (!machine) return true;
  if (String(registration) === machine.registration) return true;
  return Boolean(machine.alternative && machine.alternative.registration === String(registration));
}

/**
 * Machine to select in Silhouette Studio for a machine + registration combination.
 * @param {string|null} machineId
 * @param {string} registration
 * @returns {string}
 */
export function studioMachineFor(machineId, registration) {
  const machine = getMachine(machineId);
  if (!machine) return String(registration) === '4' ? 'Cameo 5 Alpha' : 'your machine';
  if (machine.alternative && machine.alternative.registration === String(registration)) return machine.alternative.studioMachine;
  return machine.studioMachine;
}

/**
 * Paper to preselect from the OS country code (Letter for LETTER_COUNTRIES, else A4).
 * @param {string|null|undefined} countryCode e.g. 'US', 'fr'
 * @returns {'letter'|'a4'}
 */
export function defaultPaperForCountry(countryCode) {
  const code = typeof countryCode === 'string' ? countryCode.trim().toUpperCase() : '';
  return LETTER_COUNTRIES.includes(code) ? 'letter' : 'a4';
}

/**
 * Replace {placeholders} in tip texts. Unknown placeholders are left as they are.
 * @param {string} text
 * @param {Record<string, string|number>} values
 * @returns {string}
 */
export function fillPlaceholders(text, values = {}) {
  return String(text).replace(/\{(\w+)\}/g, (whole, key) =>
    (Object.prototype.hasOwnProperty.call(values, key) && values[key] != null ? String(values[key]) : whole));
}
