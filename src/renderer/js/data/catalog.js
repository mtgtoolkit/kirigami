// Game plugin catalog for the "Get cards" view.
//
// Pure data plus a few tiny helpers. No DOM access and no imports, so the module can be
// unit-tested in Node and loaded as a native ES module by the renderer.
//
// Sources: the plugin code in <engine>/plugins/<id>/ (DeckFormat enums in deck_formats.py,
// click options in fetch.py, URL regexes in deck_formats.py / mastervault.py / mtg_parser),
// the plugin READMEs, and research verified on 2026-10-03 (including the verifier corrections:
// Elestrals takes a deck ID, Echoes of Astra example deck 648 and broken status).
//
// Treat every exported object as read-only: views must copy before changing anything.

/**
 * Create-PDF settings recommended for a plugin or a deck format. Keys are create_pdf option
 * names (same names as settings.pdf.options). A key set to null means "turn this option off".
 * Contains option keys ONLY, so it can be merged straight into the PDF options.
 * @typedef {Object} PdfRecommendation
 * @property {string} [card_size]       Canonical card size name (assets/layouts.json key).
 * @property {string|null} [crop]       Length string such as '3mm', or null for no trim.
 * @property {string|null} [extend_corners]
 */

/**
 * @typedef {Object} DeckFormat
 * @property {string} id                 DeckFormat enum value passed to fetch.py (exact).
 * @property {string} label              Short name shown in the format select.
 * @property {'file'|'url'|'text_inline'} inputKind
 *   file: the plugin reads a deck list file (paste, saved list or chosen file);
 *   url: a web link (some also accept a bare deck number, see howToGet);
 *   text_inline: a short code typed or pasted on one line (no file).
 * @property {string} fileExtensionHint  Typical extension with dot ('.txt'), '' when not a file.
 * @property {string[]} fileExtensions   Extensions (no dot) for the "Choose a file" dialog filter; [] when not a file.
 * @property {string} description        What this format is, in plain words.
 * @property {string} howToGet           Where to find / how to export it.
 * @property {string} example            Text for "Insert example".
 * @property {string} [pattern]          JS RegExp source (no flags, case-sensitive). Test it against the TRIMMED
 *                                       input with `new RegExp(pattern).test(value.trim())`. Copied from the plugin
 *                                       code: anchored with '^' where Python uses re.match (start only) and with
 *                                       '^...$' where it uses fullmatch; unanchored where the plugin searches
 *                                       anywhere (see `extract`).
 * @property {boolean} [extract]         true when the plugin (or the app's fetch service) uses the first match of
 *                                       `pattern` found anywhere in the input, so a pasted link containing the
 *                                       code is accepted.
 * @property {PdfRecommendation} [recommendedPdf]  Format-specific PDF settings (override the plugin's).
 * @property {string} [recommendedPdfNote]          Why, in plain words.
 * @property {string} [warning]          Important caveat to show next to the format (plain words).
 */

/**
 * @typedef {Object} PluginOption
 * @property {string} name               click parameter name (also the `options` key in fetch requests).
 * @property {string} flag               Long flag, e.g. '--prefer_set'.
 * @property {'flag'|'choice'|'multi_choice'|'multi_text'} kind
 *   flag: on/off; choice: one value; multi_choice / multi_text: an ordered list (the flag is repeated per value).
 * @property {string[]|null} choices     Allowed values for choice kinds, else null.
 * @property {string[]|null} choiceLabels Friendly labels, same order as `choices`, else null.
 * @property {boolean|string|string[]} default  false for flags, the click default for choices, [] for lists.
 * @property {string} label
 * @property {string} help
 * @property {boolean} advanced          true = shown under "More options".
 * @property {boolean} [lowercase]       true = lowercase every value before passing it to the plugin.
 * @property {string} [placeholder]      Input placeholder for multi_text options.
 * @property {string[]} [onlyForFormats] Format ids where the option has an effect (absent = all formats).
 */

/**
 * @typedef {Object} Plugin
 * @property {string} id                 Folder name under <engine>/plugins.
 * @property {string} displayName
 * @property {string} shortDescription
 * @property {string[]} keywords         Extra search words for the game picker (lowercase).
 * @property {string} imageSource        Where the pictures come from (plain words).
 * @property {string} recommendedCardSize Canonical card size name for create_pdf.
 * @property {boolean} producesDoubleSided true when the plugin can write unique backs (game/double_sided).
 * @property {boolean} writesBackImages  true when the plugin writes a common back (game/back). False for all.
 * @property {'ok'|'broken'} status
 * @property {string|null} statusMessage Plain-language reason when status is 'broken', else null.
 * @property {string|null} backHint      Advice about the common card back, or null.
 * @property {string} defaultFormat      Format to preselect when the user has no saved choice.
 * @property {PdfRecommendation} recommendedPdf  Plugin-wide PDF settings (always includes card_size).
 * @property {string} [recommendedPdfNote]
 * @property {string} docsUrl            Project documentation page for this plugin.
 * @property {DeckFormat[]} formats      In DeckFormat enum order.
 * @property {PluginOption[]} options    In fetch.py declaration order.
 * @property {string[]} notes            Plain-language tips for the result / help panel.
 */

const DOCS_BASE = 'https://alan-cha.github.io/silhouette-card-maker/plugins/';

/** Join lines for multi-line examples. */
const lines = (...l) => l.join('\n');

/** Shorthand for a deck list file format. */
function fileFormat(id, label, ext, extra) {
  const exts = Array.isArray(ext) ? ext : [ext];
  return {
    id,
    label,
    inputKind: 'file',
    fileExtensionHint: `.${exts[0]}`,
    fileExtensions: exts.includes('txt') ? exts : [...exts, 'txt'],
    ...extra,
  };
}

/** Shorthand for a web link format. */
function urlFormat(id, label, pattern, extra) {
  return { id, label, inputKind: 'url', fileExtensionHint: '', fileExtensions: [], pattern, ...extra };
}

/** Shorthand for a one-line code format. */
function inlineFormat(id, label, pattern, extra) {
  return { id, label, inputKind: 'text_inline', fileExtensionHint: '', fileExtensions: [], pattern, ...extra };
}

/** Shorthand for an on/off plugin option. */
function flagOption(name, label, help, advanced, extra) {
  return { name, flag: `--${name}`, kind: 'flag', choices: null, choiceLabels: null, default: false, label, help, advanced, ...extra };
}

// MTG deck links: the plugin hands the link to the mtg_parser library (venv: mtg_parser 0.0.1a55), whose site
// parsers use build_pattern() = '^(?:https?://)?(?:[a-zA-Z0-9-]+\.)*<domain>/<path>' with re.match.
const MTG_URL_PATTERN = new RegExp([
  '^(?:https?:\\/\\/)?(?:[a-zA-Z0-9-]+\\.)*(?:',
  [
    'aetherhub\\.com\\/Deck\\/.+',
    'archidekt\\.com\\/decks\\/\\d+',
    'deckstats\\.net\\/decks\\/\\d+\\/\\d+-.*',
    'moxfield\\.com\\/decks\\/[a-zA-Z0-9_-]+',
    'mtggoldfish\\.com\\/deck\\/\\d+',
    'mtgjson\\.com\\/api\\/v5\\/decks\\/.+\\.json',
    'scryfall\\.com\\/@.+\\/decks\\/\\w{8}-\\w{4}-\\w{4}-\\w{4}-\\w{12}',
    'tappedout\\.net\\/mtg-decks\\/.+',
    'tcgplayer\\.com\\/(?:content\\/)?magic-the-gathering\\/deck\\/.+\\/\\d+',
  ].join('|'),
  ')',
].join('')).source;

const MTG_LOOKUP_FORMATS = ['archidekt', 'cubecobra_csv', 'deckstats', 'moxfield', 'mtga', 'mtgo', 'scryfall_json', 'simple', 'url'];

/** @type {Plugin[]} */
export const PLUGINS = [
  // ───────────────────────────────────────────── Magic: The Gathering
  {
    id: 'mtg',
    displayName: 'Magic: The Gathering',
    shortDescription: 'Downloads the picture of every card in your deck list from Scryfall, including the backs of double-faced cards and, if you want, the tokens they make. MPCFill orders use your chosen MPCFill images.',
    keywords: ['mtg', 'magic', 'scryfall', 'commander', 'edh', 'mpcfill', 'moxfield', 'archidekt', 'arena'],
    imageSource: 'Scryfall (high-quality PNG pictures). MPCFill orders download from MPCFill; CubeCobra and Scryfall files may use their own picture links.',
    recommendedCardSize: 'standard',
    producesDoubleSided: true,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'mtga',
    recommendedPdf: { card_size: 'standard', crop: null },
    recommendedPdfNote: 'Magic cards are standard size (63 x 88 mm). Scryfall pictures have no extra bleed, so no trimming is needed.',
    docsUrl: `${DOCS_BASE}mtg/`,
    formats: [
      fileFormat('archidekt', 'Archidekt export', 'txt', {
        description: 'Text deck list exported from Archidekt (archidekt.com). Every line includes the set code and collector number, so you get the exact printings you picked.',
        howToGet: 'On archidekt.com, open your deck and choose Export from the deck menu. Keep the set code and collector number turned on, then copy or download the text. Lines without a "(set) number" part are skipped.',
        example: lines(
          "1x Agadeem's Awakening // Agadeem, the Undercrypt (znr) 90 [Resilience,Land]",
          "1x Ashnod's Altar (ema) 218 *F* [Mana Advantage]",
          "1x Assassin's Trophy (sld) 139 [Targeted Disruption]",
          '2x Boseiju Reaches Skyward // Branch of Boseiju (neo) 177 [Ramp]',
        ),
      }),
      fileFormat('cubecobra_csv', 'CubeCobra cube (CSV)', 'csv', {
        description: 'Spreadsheet (CSV) export of a whole cube from CubeCobra (cubecobra.com). Custom picture links saved in the cube are used; other cards come from Scryfall.',
        howToGet: 'On cubecobra.com, open your cube, click Export and choose the CSV (comma-separated) option, then choose the downloaded .csv file.',
        example: lines(
          'name,CMC,Type,Color,Set,Collector Number,Rarity,Color Category,status,Finish,maybeboard,image URL,image Back URL,tags,Notes,MTGO ID,Custom',
          '"Lightning Bolt",1,"Instant",R,"leb","162",common,null,Owned,Non-foil,false,,,"","",-1,false',
          '"Death Ward",1,"Instant",W,"leb","18",common,null,Owned,Non-foil,false,"https://i.imgur.com/ytZ2uaY.png",,"","",-1,false',
        ),
      }),
      fileFormat('deckstats', 'Deckstats export', 'txt', {
        description: 'Text deck list exported from Deckstats (deckstats.net). Lines can include the exact printing, such as [2XM#310].',
        howToGet: 'On deckstats.net, open your deck, use Export and choose the Deckstats text format (the one with set info like [2XM#310]), then copy the text.',
        example: lines('//Main', '1 [2XM#310] Ash Barrens', '1 Blinkmoth Nexus', '1 Bloodstained Mire', '//Sideboard', '1 [2XM#315] Darksteel Citadel'),
      }),
      fileFormat('moxfield', 'Moxfield export (with set codes)', 'txt', {
        description: 'Text export from Moxfield (moxfield.com) where every line ends with the set code and collector number, like "1 Sol Ring (SLD) 123".',
        howToGet: 'On moxfield.com, open your deck and go to More, then Export. Copy the Moxfield export (lines end with "(SET) number"). Lines without a set code are skipped, so for a plain list choose "MTG Arena export" or "MTGO / plain text list" instead.',
        example: lines('1 Ainok Bond-Kin (2X2) 5', '1 Pegasus Guardian // Rescue the Foal (CLB) 36', '2 Witch Enchanter // Witch-Blessed Meadow (MH3) 239', '', 'SIDEBOARD:', '1 Containment Priest (M21) 13'),
      }),
      fileFormat('mpcfill_xml', 'MPCFill order (XML)', 'xml', {
        description: 'Order file downloaded from MPCFill (mpcfill.com). It downloads the exact custom images you picked there, including custom backs of double-faced cards.',
        howToGet: 'On mpcfill.com, finish or load your project and use Download, then XML, to save the order file. Choose that .xml file here.',
        example: lines(
          '<order>',
          '  <details><quantity>2</quantity></details>',
          '  <fronts><card><id>1ezjK8iXEdNIE_Ks0CpsTdSHfbePvw_dJ</id><slots>0,1</slots><name>Aberrant Researcher.png</name></card></fronts>',
          '  <backs><card><id>1X9bpWccFfqBjNAhp3j8uJf85ihtMabWi</id><slots>0,1</slots><name>Perfected Form.png</name></card></backs>',
          '</order>',
        ),
        recommendedPdf: { crop: '3mm' },
        recommendedPdfNote: 'MPCFill images already include print bleed: trim 3 mm from each edge so the art lines up with the cut.',
        warning: 'The order\'s shared card back is not downloaded: add your back image in Your cards, Common back. Printing preferences don\'t apply to MPCFill orders.',
      }),
      fileFormat('mtga', 'MTG Arena export', 'txt', {
        description: 'The text you get from MTG Arena\'s Export button, or from "Copy for MTGA" on deck websites. Set codes are optional.',
        howToGet: 'In MTG Arena, open the deck and click Export (it copies the list), then paste it here. Moxfield and Archidekt also offer an MTG Arena export.',
        example: lines('Deck', '2 Arid Mesa (MH2) 244', '1 Lion Sash (NEO) 26', '2x Mountain', '1 Lightning Bolt'),
      }),
      fileFormat('mtgo', 'MTGO / plain text list', 'txt', {
        description: 'A simple "quantity + card name" list, as exported by Magic Online and most deck websites.',
        howToGet: 'Export the deck from Magic Online as a text file, or use an "MTGO" or "plain text" export on a deck website (for example Moxfield: More, Export, Copy for MTGO). Lines look like "4 Lightning Bolt", with a plain number first.',
        example: lines('1 Ainok Bond-Kin', '2 Witch Enchanter', '', 'SIDEBOARD:', '1 Containment Priest'),
      }),
      fileFormat('scryfall_json', 'Scryfall deck (JSON)', 'json', {
        description: 'A deck file in JSON format downloaded from the Scryfall deck builder (scryfall.com).',
        howToGet: 'On scryfall.com, open your deck and use its export option to download the deck as JSON, then choose that .json file here.',
        example: lines(
          '{"entries": {"mainboard": [',
          '  {"count": 4, "card_digest": {"name": "Lightning Bolt", "set": "clu", "collector_number": "141"}}',
          ']}}',
        ),
        warning: 'Every section of the file is downloaded (main deck, sideboard, maybeboard). One failing card stops the whole download.',
      }),
      fileFormat('simple', 'Card names only', 'txt', {
        description: 'A plain list with one card name per line and no quantities. Each line becomes one printed card.',
        howToGet: 'Type or paste card names, one per line, without numbers. Repeat a name to get more copies. Don\'t include headings like "Deck" or "Sideboard": they would be looked up as card names.',
        example: lines('Isshin, Two Heavens as One', 'Arid Mesa', 'Battlefield Forge', 'Blazemire Verge'),
      }),
      urlFormat('url', 'Deck link (web address)', MTG_URL_PATTERN, {
        description: 'The web address of a public deck on Moxfield, Archidekt, Aetherhub, Deckstats, MTGGoldfish, MTGJSON, Scryfall, TappedOut or TCGplayer. The deck is downloaded automatically.',
        howToGet: 'Open the deck on one of the supported sites, make sure it is public, and copy the address from the browser\'s address bar. Deckstats links must include the deck name part (.../decks/123/4567-my-deck), Scryfall links the @username, and MTGGoldfish links must be /deck/<number> pages. If a site blocks the download, export the deck as text instead.',
        example: 'https://archidekt.com/decks/8497473',
        warning: 'Deckstats, TappedOut, MTGGoldfish, MTGJSON and TCGplayer links don\'t give exact printings: turn on "Ignore exact printings" or every card will fail. Moxfield links only include the commander, companions and main deck.',
      }),
    ],
    options: [
      flagOption('ignore_set_and_collector_number', 'Ignore exact printings',
        'Ignore the set codes and collector numbers in your list and let the app choose a version of each card using the preferences below. Turn this on if cards fail with "not found".', false,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      flagOption('prefer_older_sets', 'Prefer oldest printings',
        'When a card\'s set isn\'t given, pick its oldest printing instead of the newest.', true,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      {
        name: 'prefer_set', flag: '--prefer_set', kind: 'multi_text', choices: null, choiceLabels: null, default: [],
        label: 'Preferred sets',
        help: 'Set codes to use first when a card\'s set isn\'t given, in order of preference (for example eld, then woe).',
        advanced: true, lowercase: true, placeholder: 'Set code, e.g. eld', onlyForFormats: MTG_LOOKUP_FORMATS,
      },
      {
        name: 'ignore_set', flag: '--ignore_set', kind: 'multi_text', choices: null, choiceLabels: null, default: [],
        label: 'Excluded sets',
        help: 'Set codes that should never be used when the app picks a printing (for example sld).',
        advanced: true, lowercase: true, placeholder: 'Set code, e.g. sld', onlyForFormats: MTG_LOOKUP_FORMATS,
      },
      flagOption('prefer_showcase', 'Prefer showcase art',
        'When choosing a printing, prefer versions with the special "showcase" frame.', true,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      flagOption('prefer_extra_art', 'Prefer full / borderless / extended art',
        'When choosing a printing, prefer full-art, borderless or extended-art versions.', false,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      {
        name: 'prefer_lang', flag: '--prefer_lang', kind: 'multi_choice',
        choices: ['en', 'sp', 'fr', 'de', 'it', 'pt', 'jp', 'kr', 'ru', 'cs', 'ct', 'ag', 'ph'],
        choiceLabels: ['English', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Japanese', 'Korean', 'Russian',
          'Simplified Chinese', 'Traditional Chinese', 'Ancient Greek', 'Phyrexian'],
        default: [],
        label: 'Card language',
        help: 'Download cards in these languages when available (first choice first). Cards not printed in your language come in English.',
        advanced: false, onlyForFormats: MTG_LOOKUP_FORMATS,
      },
      flagOption('prefer_ub', 'Prefer Universes Beyond',
        'When choosing a printing, prefer crossover versions (Universes Beyond, such as The Lord of the Rings or Warhammer 40,000) if they exist.', true,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      flagOption('ignore_ub', 'Avoid Universes Beyond',
        'When choosing a printing, skip crossover (Universes Beyond) versions whenever a regular Magic version exists.', true,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
      flagOption('tokens', 'Include tokens',
        'Also download the tokens your cards create (one token per copy of the card that makes it).', false,
        { onlyForFormats: MTG_LOOKUP_FORMATS }),
    ],
    notes: [
      'Every card line in your list is downloaded, including sideboard and maybeboard sections: remove the lines you don\'t want printed.',
      'Double-faced cards get their back picture automatically (see Unique backs in Your cards).',
      'If cards fail with "not found" (common with MTG Arena-only set codes), turn on "Ignore exact printings" and download again.',
      'Printing preferences only apply to cards without a set code in your list, or to every card when "Ignore exact printings" is on. Card language applies to all cards.',
      'MPCFill orders already include print bleed: use "Trim image edges" 3 mm when you make the PDF.',
      'Names must be exact (no spelling correction). Downloads take about one second per card.',
    ],
  },

  // ───────────────────────────────────────────── Yu-Gi-Oh!
  {
    id: 'yugioh',
    displayName: 'Yu-Gi-Oh!',
    shortDescription: 'Downloads the picture of every card in your YDK deck file or YDKE deck code from YGOPRODeck.',
    keywords: ['ygo', 'yugioh', 'yu-gi-oh', 'ydk', 'ydke', 'ygoprodeck', 'edopro', 'omega'],
    imageSource: 'YGOPRODeck card picture server.',
    recommendedCardSize: 'japanese',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'ydk',
    recommendedPdf: { card_size: 'japanese' },
    recommendedPdfNote: 'Yu-Gi-Oh! cards are Japanese size (59 x 86 mm), smaller than most card games. The plugin documentation says to use this size.',
    docsUrl: `${DOCS_BASE}yugioh/`,
    formats: [
      // parse_ydke: must start with 'ydke://' and split into exactly 4 parts on '!'; parts 1-3 are base64
      // (decoded), the 4th part is ignored.
      inlineFormat('ydke', 'YDKE deck code (ydke://...)', /^ydke:\/\/[A-Za-z0-9+/=]*![A-Za-z0-9+/=]*![A-Za-z0-9+/=]*![^!]*$/.source, {
        description: 'A copy-paste deck code starting with ydke://, used by EDOPro, YGO Omega and YGOPRODeck. Paste the code itself; no file is needed.',
        howToGet: 'In EDOPro, YGO Omega or on ygoprodeck.com, use the option that copies the deck as a YDKE code, then paste the whole code, starting with ydke:// and ending with "!".',
        example: 'ydke://CDfpAQg36QGBAyEEgQMhBOcqwwXnKsMFSIA/AUiAPwFIgD8B/s84AJuTywGbk8sBm5PLATUHgwI1B4MCNQeDAv2JnAX9iZwF/YmcBdcanwGglAQCE0dlADm+EgQ5vhIE/fqRBYv9YwAQLRoCEC0aAhAtGgIeN4IBPqRxAf4KgAQiSJkAIkiZACJImQBL8mcCS/JnAkvyZwIkQTwBNlmlBQ==!tGFNAfmCDgQUh7AFmBskA45gkQMm1FgAQvNMAGlM5gWNJ5gDSw97ATI1VQLERCEFqRp+AMoavwGS+pQA!reIKAq3iCgKt4goCRK0EBUStBAVErQQF+9wUAUO+3QBDvt0AtYgRALWIEQC1iBEAkvrlAWaDAgCc4b0A!',
      }),
      fileFormat('ydk', 'YDK deck file', 'ydk', {
        description: 'A deck file (.ydk) used by YGOPRODeck, EDOPro and other simulators. It lists card passwords under #main, #extra and !side.',
        howToGet: 'On ygoprodeck.com, open your deck and use Export / Download to get the .ydk file. EDOPro and YGO Omega also keep decks as .ydk files (EDOPro: in its "deck" folder), which you can choose directly.',
        example: lines('#main', '91073013', '92895501', '#extra', '90448279', '!side', '27204311'),
      }),
    ],
    options: [],
    notes: [
      'Main, Extra and Side deck cards are all downloaded: remove the side deck if you don\'t want it printed.',
      'Use the Japanese card size (59 x 86 mm) when you make the PDF.',
      'If one card can\'t be downloaded (unknown password or no internet), the download stops; the cards saved so far are kept.',
    ],
  },

  // ───────────────────────────────────────────── Pokémon
  {
    id: 'pokemon',
    displayName: 'Pokémon',
    shortDescription: 'Downloads the picture of every card in your Pokémon TCG (or TCG Pocket) deck list from Limitless TCG, with pokemontcg.io as a backup.',
    keywords: ['pokemon', 'pokémon', 'ptcg', 'limitless', 'pocket', 'tcg live'],
    imageSource: 'Limitless TCG picture library, with pokemontcg.io as a backup.',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'limitless',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Pokémon cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}pokemon/`,
    formats: [
      fileFormat('limitless', 'Limitless TCG / TCG Live export', 'txt', {
        description: 'Text deck list from Limitless TCG (limitlesstcg.com) for the Pokémon TCG or TCG Pocket. Each line is quantity, card name, set code and card number. The Pokémon TCG Live export uses the same layout.',
        howToGet: 'On limitlesstcg.com (or the Limitless Pocket site), open a deck list and click Export / Copy, then paste it here. In Pokémon TCG Live, use the deck\'s Export button.',
        example: lines('Pokémon: 13', '3 Charcadet SSP 32', '3 Ceruledge ex SSP 36', 'Trainer: 27', "3 Boss's Orders MEG 114", '4 Nest Ball SVI 181'),
      }),
    ],
    options: [],
    notes: [
      'Only lines with quantity, name, set code and number are used (for example "3 Charcadet SSP 32"); headings like "Pokémon: 13" are skipped.',
      'Pokémon TCG Pocket pictures are small, so they print softer.',
      'Card names with characters Windows doesn\'t allow in file names (such as ":" in "Type: Null") may fail.',
    ],
  },

  // ───────────────────────────────────────────── Lorcana
  {
    id: 'lorcana',
    displayName: 'Disney Lorcana',
    shortDescription: 'Downloads the picture of every card in your Dreamborn deck list from Lorcast, with optional special artwork (Enchanted, Epic, Iconic, Promo).',
    keywords: ['lorcana', 'disney', 'dreamborn', 'lorcast'],
    imageSource: 'Lorcast card database.',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'dreamborn',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Lorcana cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}lorcana/`,
    formats: [
      fileFormat('dreamborn', 'Dreamborn deck list', 'txt', {
        description: 'Text deck list exported from Dreamborn.ink, with one "quantity card name" per line. Optional markers like *E* pick special artwork.',
        howToGet: 'On dreamborn.ink, open your deck, click Export and copy the text deck list. For special artwork, add *E* (Enchanted), *EP* (Epic), *I* (Iconic), *P* (Promo), or an exact print like *P1* or *P2-15* after a card name.',
        example: lines('1 Elsa, Spirit of Winter', '4 Magic Broom, Illuminary Keeper', '4 Diablo - Obedient Raven', '1 Anna - True-Hearted *E*', '1 Mickey Mouse - True Friend *P2-15*'),
      }),
    ],
    options: [],
    notes: [
      'Use full card names ("Name - Version") so the right card is found: the first search result is used.',
      'Lines that don\'t start with a quantity are skipped.',
    ],
  },

  // ───────────────────────────────────────────── One Piece
  {
    id: 'one_piece',
    displayName: 'One Piece Card Game',
    shortDescription: 'Downloads the picture of every card code in your deck list from the official One Piece Card Game website.',
    keywords: ['one piece', 'optcg', 'onepiece', 'bandai', 'egman', 'optcgsim'],
    imageSource: 'Official One Piece Card Game website (Bandai, English).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'egman',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'One Piece cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}one_piece/`,
    formats: [
      fileFormat('egman', 'Egman Events deck list', 'txt', {
        description: 'Text deck list from Egman Events (egmanevents.com), with quantity, card code and card name on each line.',
        howToGet: 'On egmanevents.com, open the deck list, use its copy / export button and paste the result here. Lines look like "4 OP01-016 Nami".',
        example: lines('1 OP12-001 Silvers Rayleigh', '4 OP01-016 Nami', '4 OP03-008 Buggy', '2 OP06-018 Gum-Gum King Kong Gatling', '2 ST21-017 Gum-Gum Mole Pistol'),
      }),
      fileFormat('optcgsim', 'OPTCG Sim deck list', 'txt', {
        description: 'The deck code list used by OPTCG Simulator (optcgsim.com), with one entry like "4xOP01-016" per line.',
        howToGet: 'In OPTCG Sim\'s deck builder, or with a deck website\'s "export for OPTCG Sim" option, copy the deck and paste it here. Lines look exactly like "4xOP01-016" (no spaces).',
        example: lines('1xOP12-001', '4xOP01-016', '2xOP02-015', '4xOP03-008', '1xST21-017'),
      }),
    ],
    options: [],
    notes: [
      'Card codes must be uppercase, like OP01-016 or ST21-017. Alternate-art codes (like OP01-016_p1) are skipped.',
      'Cards missing from the official English website fail with "not found".',
    ],
  },

  // ───────────────────────────────────────────── Digimon
  {
    id: 'digimon',
    displayName: 'Digimon Card Game',
    shortDescription: 'Downloads the picture of every card code in your deck list from the official Digimon Card Game website.',
    keywords: ['digimon', 'dcg', 'bandai'],
    imageSource: 'Official Digimon Card Game website (Bandai, English).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'digimoncardio',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Digimon cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}digimon/`,
    formats: [
      fileFormat('digimoncardapp', 'digimoncard.app export', 'txt', {
        description: 'Text export from digimoncard.app: card code, card name, then quantity on each line.',
        howToGet: 'On digimoncard.app, open your deck, choose Export and the text option, then paste it here. Lines look like "BT11-005 Koromon 4".',
        example: lines('// Digimon DeckList', '', 'BT11-005 Koromon 4', 'EX10-006 Agumon 4', 'BT11-062 Agumon (X Antibody) 4', 'P-107 Defense Training 4'),
      }),
      fileFormat('digimoncarddev', 'digimoncard.dev export', 'txt', {
        description: 'Text export from digimoncard.dev: quantity, card name, then card code on each line.',
        howToGet: 'On digimoncard.dev, open your deck, choose Export and the text list, then paste it here. Lines look like "4 Arukenimon   BT16-072".',
        example: lines('// Digimon DeckList', '', '1 DemiMeramon             BT15-006', '2 Myotismon ACE           BT15-076', '4 Arukenimon & Mummymon   BT16-089', '1 Ukkomon                    P-123'),
      }),
      fileFormat('digimoncardio', 'digimoncard.io export', 'txt', {
        description: 'Text export from digimoncard.io: quantity, card name, then card code on each line.',
        howToGet: 'On digimoncard.io, open the deck and use Export / copy deck list (text), then paste it here. Lines look like "4 Gabumon BT15-020".',
        example: lines('// Digimon Deck List', '4 BlitzGreymon EX9-013', '2 Blue Scramble LM-028', '4 Gabumon (X Antibody) BT9-020', '// Egg Deck', '4 Wanyamon BT11-002'),
      }),
      fileFormat('digimonmeta', 'DigimonMeta export', 'txt', {
        description: 'Text export from DigimonMeta (digimonmeta.com): a quantity followed by the card code in parentheses.',
        howToGet: 'On digimonmeta.com, open the deck, export or copy the list, and paste it here. Lines look like "4 (BT22-002)".',
        example: lines('4 (BT22-002)', '4 (ST19-03)', '4 (EX7-024)', '2 (EX9-024)', '4 (P-165)'),
      }),
      fileFormat('tts', 'Tabletop Simulator export', 'txt', {
        description: 'A Tabletop Simulator deck export: one bracketed list of card codes, offered by deck builders such as digimoncard.dev.',
        howToGet: 'Use the "Tabletop Simulator" export of your deck builder (for example digimoncard.dev) and paste the single bracketed line unchanged.',
        example: '["Exported from https://digimoncard.dev","BT15-006","BT15-006","BT2-070","P-123"]',
        warning: 'The text must be one valid bracketed list, or the download stops with an error.',
      }),
      fileFormat('untap', 'Untap export', 'txt', {
        description: 'A deck list in the format used by the Untap online play table (untap.in): quantity, card name, (DCG) and the card code in parentheses.',
        howToGet: 'Use the "Untap" export option of your deck builder, or export the deck from untap.in, and paste it here. Lines look like "4 Analogman (DCG) (BT11-092)".',
        example: lines('1 MetalTyrannomon                      (DCG) (BT11-055)', '4 Analogman                            (DCG) (BT11-092)', '1 Chaosdramon (X Antibody)             (DCG) (BT12-072)', '1 Ukkomon                                 (DCG) (P-123)'),
      }),
    ],
    options: [],
    notes: [
      'Card codes must be uppercase (like BT15-006 or P-107); alternate-art suffixes are skipped. Egg deck lines are included.',
      'Unknown codes fail with "not found"; the other cards still download.',
    ],
  },

  // ───────────────────────────────────────────── Flesh and Blood
  {
    id: 'flesh_and_blood',
    displayName: 'Flesh and Blood',
    shortDescription: 'Downloads the pictures for a Flesh and Blood deck built on Fabrary, from the official Flesh and Blood card database.',
    keywords: ['fab', 'flesh and blood', 'fabrary', 'legend story'],
    imageSource: 'Official Flesh and Blood card database (CardVault, Legend Story Studios).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'fabrary',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Flesh and Blood cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}flesh_and_blood/`,
    formats: [
      fileFormat('fabrary', 'Fabrary deck export', 'txt', {
        description: 'The text export from Fabrary (fabrary.net), the popular Flesh and Blood deck builder. Each card line looks like "3x Card Name (red)"; the pitch color is optional.',
        howToGet: 'On fabrary.net, open your deck and use its export / copy option to get the deck as text (lines like "3x Ancestral Empowerment (red)"), then paste it here.',
        example: lines('Hero: Cindra, Dracai of Retribution', 'Arena cards', '1x Blood Splattered Vest', 'Deck cards', '3x Ancestral Empowerment (red)', '2x Concealed Blade (blue)'),
      }),
    ],
    options: [],
    notes: [
      'The hero on the "Hero:" line isn\'t downloaded. To print it, add a line like "1x Cindra, Dracai of Retribution".',
      'Pitch colors must be lowercase: (red), (yellow) or (blue). Other lines are skipped.',
    ],
  },

  // ───────────────────────────────────────────── Star Wars: Unlimited
  {
    id: 'star_wars_unlimited',
    displayName: 'Star Wars: Unlimited',
    shortDescription: 'Downloads Star Wars: Unlimited card pictures from SWUDB, including the back side of leader cards, for a deck list from SWUDB or Melee.',
    keywords: ['swu', 'star wars', 'unlimited', 'swudb', 'melee'],
    imageSource: 'SWUDB (swudb.com).',
    recommendedCardSize: 'standard',
    producesDoubleSided: true,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'swudb_json',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Star Wars: Unlimited cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}star_wars_unlimited/`,
    formats: [
      fileFormat('melee', 'Melee / SWUDB text list', 'txt', {
        description: 'A text list where each line is "quantity | card name | subtitle", under Leaders / Base / Deck / Sideboard headings. It is the format used to submit decks on melee.gg, and SWUDB can export it.',
        howToGet: 'On swudb.com, open your deck, open its Export menu and choose the Melee (melee.gg) format, then copy the text. A list copied from melee.gg in the same layout also works.',
        example: lines('Leaders', '1 | Han Solo | Audacious Smuggler', 'Base', '1 | Level 1313', 'Deck', '3 | Millennium Falcon | Piece of Junk'),
        warning: 'Card names may only contain letters, numbers, spaces, apostrophes and hyphens; other lines are skipped. SWUDB JSON avoids this.',
      }),
      fileFormat('picklist', 'SWUDB picklist', 'txt', {
        description: 'SWUDB\'s checklist-style export: one "[ ]" box per copy, then the card name and subtitle. The line of set numbers under each card is ignored.',
        howToGet: 'On swudb.com, open your deck, open its Export menu and choose Picklist, then copy the text.',
        example: lines('[ ]          Han Solo | Audacious Smuggler', '             SOR 017, SOR 283, SOR 267', '', '[ ] [ ] [ ]  Millennium Falcon | Piece of Junk', '             SOR 193, SOR 455'),
      }),
      fileFormat('swudb_json', 'SWUDB JSON (most reliable)', 'json', {
        description: 'SWUDB\'s JSON export: card IDs (like SOR_017) with counts for the leader, base, deck and sideboard. Cards are identified by ID, so names with punctuation or accents are no problem.',
        howToGet: 'On swudb.com, open your deck, open its Export menu and choose JSON (copy or download), then paste it here or choose the file.',
        example: lines(
          '{',
          '  "leader": {"id": "SOR_017", "count": 1},',
          '  "base": {"id": "TWI_029", "count": 1},',
          '  "deck": [{"id": "SOR_203", "count": 3}, {"id": "SHD_202", "count": 3}],',
          '  "sideboard": []',
          '}',
        ),
      }),
    ],
    options: [],
    notes: [
      'Leaders get their back side automatically (see Unique backs in Your cards). Landscape leaders and bases are turned upright.',
      'Sideboard cards are downloaded too.',
      'The newest art of each card is used, which may differ from the exact printing in your list.',
      'A card whose subtitle contains "?" can\'t be saved on Windows and fails.',
    ],
  },

  // ───────────────────────────────────────────── Riftbound
  {
    id: 'riftbound',
    displayName: 'Riftbound',
    shortDescription: 'Downloads Riftbound (League of Legends TCG) card pictures from Piltover Archive or Riftmana for a deck list or deck code.',
    keywords: ['riftbound', 'league of legends', 'lol', 'piltover', 'riftmana', 'pixelborn'],
    imageSource: 'Piltover Archive (or Riftmana, see More options).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'tts',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Riftbound cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}riftbound/`,
    formats: [
      fileFormat('piltover_archive', 'Piltover Archive text list', 'txt', {
        description: 'A plain text list from the Piltover Archive deck builder (piltoverarchive.com), with "quantity card name" on each line. Each name is looked up to find its card number.',
        howToGet: 'On piltoverarchive.com, open your deck and use its export / copy option to get the deck as a text list (lines like "3 Seal of Unity"), then paste it here.',
        example: lines('1 Viktor, Herald of the Arcane', '1 Viktor, Leader', '3 Seal of Unity', '3 Stupefy', "1 Targon's Peak", '12 Order Rune'),
        warning: 'An unknown card name stops the whole download. The Tabletop Simulator code is more reliable.',
      }),
      fileFormat('pixelborn', 'Pixelborn deck code', 'txt', {
        description: 'A deck code from Pixelborn, the former Riftbound online client: one long code of letters and numbers. Pixelborn shut down in August 2025, so this is only for old codes.',
        howToGet: 'Paste the Pixelborn deck code on its own, with nothing else.',
        example: 'T0dOLTI2NS0xJE9HTi0yNDYtMSRPR04tMjQ1LTE=',
        warning: 'An invalid code stops the download with an error.',
      }),
      fileFormat('tts', 'Tabletop Simulator (TTS) code', 'txt', {
        description: 'A Tabletop Simulator deck code: one line of card codes like OGN-265-1 (set, card number, art), one code per copy. Riftbound deck builders such as Piltover Archive can export it.',
        howToGet: 'In the Piltover Archive deck builder (or another Riftbound deck builder), use the Tabletop Simulator / TTS export, copy the code and paste it on a single line.',
        example: 'OGN-265-1 OGN-246-1 OGN-245-1 OGN-245-1 OGN-245-1 OGN-095-1',
        warning: 'Keep the whole code on ONE line: codes split across lines are skipped.',
      }),
    ],
    options: [
      {
        name: 'source', flag: '--source', kind: 'choice',
        choices: ['piltover_archive', 'riftmana'], choiceLabels: ['Piltover Archive', 'Riftmana'],
        default: 'piltover_archive',
        label: 'Picture source',
        help: 'Which website the card pictures come from. Keep the default; switch to Riftmana if some pictures fail to download.',
        advanced: true,
      },
    ],
    notes: [
      'Battlefield cards are horizontal and are not turned automatically, so they may look squashed on the printed card.',
      'Alternate arts that don\'t exist on the picture website fail with "not found".',
      'If the websites change their bot protection, downloads can fail with "forbidden" errors; try again later.',
    ],
  },

  // ───────────────────────────────────────────── Gundam
  {
    id: 'gundam',
    displayName: 'Gundam Card Game',
    shortDescription: 'Downloads Gundam Card Game pictures from Bandai\'s official website for a deck list from DeckPlanet, Egman Events, ExBurst or Limitless.',
    keywords: ['gundam', 'gcg', 'bandai', 'deckplanet', 'exburst'],
    imageSource: 'Official Gundam Card Game website (Bandai, English).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'deckplanet',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Gundam Card Game cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}gundam/`,
    formats: [
      fileFormat('deckplanet', 'DeckPlanet list', 'txt', {
        description: 'A text list from the DeckPlanet deck builder (deckplanet.net), with "quantity name [card number]" on each line.',
        howToGet: 'On deckplanet.net, open your Gundam deck and use its export / copy deck list option (lines like "2 Guntank [GD01-008]"), then paste it here.',
        example: lines('2 Guntank [GD01-008]', '4 Gundam (MA Form) [ST01-002]', '4 Demi Trainer [ST01-008]', '4 Amuro Ray [ST01-010]'),
      }),
      fileFormat('egman', 'Egman Events list', 'txt', {
        description: 'Deck list text from Egman Events (egmanevents.com), with "quantity card number name" on each line.',
        howToGet: 'On egmanevents.com, open the deck list and copy it (lines like "4 GD01-039 Dopp"), then paste it here.',
        example: lines('4 GD01-039 Dopp', '4 ST03-007 Zaku I | MS-05', '4 GD01-035 Zaku II | MS-06', '3 ST01-001 Gundam | RX-78-2'),
      }),
      fileFormat('exburst', 'ExBurst list', 'txt', {
        description: 'Deck list text from the ExBurst deck builder (exburst.dev), with "quantity x card number" on each line.',
        howToGet: 'On exburst.dev, open your deck and use its export / copy option (lines like "4 x ST04-008"), then paste it here.',
        example: lines('4 x ST04-008', '4 x ST01-005', '4 x GD01-059', '3 x GD01-044'),
      }),
      fileFormat('limitless', 'Limitless list', 'txt', {
        description: 'Deck list text from Limitless TCG (limitlesstcg.com), with "quantity name card number" on each line.',
        howToGet: 'On limitlesstcg.com, open the Gundam deck list and use its export / copy option (lines like "4 Dopp GD01-039"), then paste it here.',
        example: lines('4 Dopp GD01-039', '4 Zaku Ⅰ ST03-007', '3 Guntank GD01-008', '3 Gundam ST01-001'),
      }),
    ],
    options: [],
    notes: [
      'Only the card number in each line is used; names are ignored. Unknown numbers fail with "not found".',
    ],
  },

  // ───────────────────────────────────────────── Netrunner
  {
    id: 'netrunner',
    displayName: 'Netrunner',
    shortDescription: 'Downloads Netrunner card pictures from the NRO proxy library, using NetrunnerDB card data, for a deck from NetrunnerDB or Jinteki.net.',
    keywords: ['netrunner', 'android', 'nrdb', 'netrunnerdb', 'jinteki', 'nsg', 'nro'],
    imageSource: 'NRO proxy pictures (via NetrunnerDB card data).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'bbcode',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Netrunner cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}netrunner/`,
    formats: [
      fileFormat('bbcode', 'NetrunnerDB bbCode (forum)', 'txt', {
        description: 'NetrunnerDB\'s forum-post export (bbCode), with [url] card links and [i] set names. It includes the identity card.',
        howToGet: 'On netrunnerdb.com, open the deck list, then click Actions, Export, "bbCode". Copy the text and paste it here.',
        example: lines(
          '[url=https://netrunnerdb.com/en/card/35046]AU Co.: The Gold Standard in Clones[/url] (Elevation)',
          '',
          '[b]Agenda (11)[/b]',
          '3x [url=https://netrunnerdb.com/en/card/34040]Fujii Asset Retrieval[/url] [i](The Automata Initiative)[/i]',
          '3x [url=https://netrunnerdb.com/en/card/30075]Hedge Fund[/url] [i](System Gateway)[/i]',
        ),
      }),
      fileFormat('jinteki', 'Jinteki.net list', 'txt', {
        description: 'A card list for the Jinteki.net online client, with "quantity card name" on each line. It normally does not include the identity card.',
        howToGet: 'On netrunnerdb.com, open the deck list, then click Actions, Export, "Jinteki.net format". Copy the text and paste it here. To print the identity, add it as a line like "1 AU Co.: The Gold Standard in Clones".',
        example: lines('3 Fujii Asset Retrieval', '3 Hybrid Release', '1 Longevity Serum', '3 Hedge Fund'),
      }),
      fileFormat('markdown', 'NetrunnerDB Markdown (Reddit)', 'txt', {
        description: 'NetrunnerDB\'s Markdown export, meant for Reddit posts, with linked card names and set names. It includes the identity card.',
        howToGet: 'On netrunnerdb.com, open the deck list, then click Actions, Export, "Markdown (Reddit)". Copy the text and paste it here.',
        example: lines(
          '[AU Co.: The Gold Standard in Clones](https://netrunnerdb.com/en/card/35046) _(Elevation)_',
          '',
          '###Agenda (11)',
          '* 3x [Fujii Asset Retrieval](https://netrunnerdb.com/en/card/34040) _(The Automata Initiative)_',
          '* 3x [Hedge Fund](https://netrunnerdb.com/en/card/30075) _(System Gateway)_',
        ),
      }),
      fileFormat('plain_text', 'NetrunnerDB plain text', 'txt', {
        description: 'NetrunnerDB\'s plain-text export: "3x Card Name" lines grouped by card type. The identity line has no quantity, so the identity is not downloaded.',
        howToGet: 'On netrunnerdb.com, open the deck list, then click Actions, Export, "Plain text". Copy the text and paste it here. Choose bbCode, Markdown or the text file instead if you want the identity printed.',
        example: lines('AU Co.: The Gold Standard in Clones', '', 'Agenda (11)', '3x Fujii Asset Retrieval', '2x Spin Doctor ●●', '3x Hedge Fund'),
      }),
      fileFormat('text', 'NetrunnerDB text file', 'txt', {
        description: 'NetrunnerDB\'s downloadable text file, with "3x Card Name (Set Name)" lines grouped by card type. It includes the identity card.',
        howToGet: 'On netrunnerdb.com, open the deck list, then click Actions, Download, "Text file", and choose the downloaded .txt file.',
        example: lines('-i-m-in-love-with-the-auco-by-r-e-genasis-1st-spb-mc-', 'AU Co.: The Gold Standard in Clones (Elevation)', '', 'Agenda (11)', '1x Longevity Serum (System Gateway)', '2x Spin Doctor (System Gateway) ••'),
        warning: 'Each line is checked against NetrunnerDB first: without internet access every line is skipped.',
      }),
    ],
    options: [],
    notes: [
      'The identity card is included with the bbCode, Markdown and text file exports, but not with plain text or Jinteki.net lists.',
      'Cards are looked up by name and the newest printing is used.',
      'Cards with a back side (such as flip identities) only get their front.',
    ],
  },

  // ───────────────────────────────────────────── Altered
  {
    id: 'altered',
    displayName: 'Altered',
    shortDescription: 'Downloads Altered card pictures from the official Altered website for a deck list exported from Ajordat.',
    keywords: ['altered', 'equinox', 'ajordat'],
    imageSource: 'Official Altered website.',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'ajordat',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Altered cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}altered/`,
    formats: [
      fileFormat('ajordat', 'Ajordat list', 'txt', {
        description: 'Deck list text from Ajordat\'s Altered deck builder (altered.ajordat.com): a quantity and an Altered card reference (like ALT_CORE_B_OR_08_C) on each line, including unique cards.',
        howToGet: 'On altered.ajordat.com, open your deck and export / copy the deck list as text (lines like "3 ALT_ALIZE_B_MU_31_R2"), then paste it here.',
        example: lines('1 ALT_COREKS_B_OR_01_C', '3 ALT_ALIZE_B_MU_31_R2', '2 ALT_ALIZE_B_OR_42_R1', '1 ALT_CORE_B_OR_20_U_7022'),
      }),
    ],
    options: [],
    notes: [
      'Quantities must be a single digit (1 to 9); other lines are skipped.',
      'Pictures come in the website\'s default language.',
    ],
  },

  // ───────────────────────────────────────────── Ashes Reborn
  {
    id: 'ashes_reborn',
    displayName: 'Ashes Reborn',
    shortDescription: 'Downloads every card of an Ashes Reborn deck shared on Ashes.live or AshesDB (Phoenixborn, deck cards and conjurations).',
    keywords: ['ashes', 'ashes reborn', 'phoenixborn', 'ashes.live', 'ashesdb', 'plaid hat'],
    imageSource: 'Ashes.live or AshesDB (see More options).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'ashes_share_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Ashes Reborn cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}ashes_reborn/`,
    formats: [
      urlFormat('ashes_share_url', 'Ashes.live share link', /^https:\/\/ashes.live\/decks\/share\/(.+)\/*/.source, {
        description: 'A deck share link from Ashes.live, the community deck builder for Ashes Reborn.',
        howToGet: 'On ashes.live, open your deck and copy its share link from the share option. It must start with https://ashes.live/decks/share/ (no "www."). The normal deck page address doesn\'t work.',
        example: 'https://ashes.live/decks/share/57be4c41-6b6f-4770-8e30-b2fe9b9a6c72/',
      }),
      urlFormat('ashesdb_share_url', 'AshesDB share link', /^https:\/\/ashesdb.plaidhatgames.com\/decks\/share\/(.+)\/*/.source, {
        description: 'A deck share link from AshesDB, Plaid Hat Games\' official Ashes Reborn deck builder.',
        howToGet: 'On ashesdb.plaidhatgames.com, open your deck and copy its share link from the share option. It must contain /decks/share/.',
        example: 'https://ashesdb.plaidhatgames.com/decks/share/0f8855d9-3c02-45e8-8458-366cbd755a04/',
      }),
    ],
    options: [
      {
        name: 'source', flag: '--source', kind: 'choice',
        choices: ['ashes', 'ashesdb'], choiceLabels: ['Ashes.live', 'AshesDB (Plaid Hat Games)'],
        default: 'ashes',
        label: 'Picture source',
        help: 'Which website the card pictures come from (the deck itself is read from the site in your link). AshesDB sometimes has larger pictures and newer cards.',
        advanced: true,
      },
    ],
    notes: [
      'The Phoenixborn and conjurations are included, so you get more pictures than the 30 deck cards.',
      'Pictures are low resolution: turning on upscaling gives sharper prints.',
      'An unknown or unshared deck stops the download with an error.',
    ],
  },

  // ───────────────────────────────────────────── Bushiroad
  {
    id: 'bushiroad',
    displayName: 'Bushiroad games (Vanguard, Weiss Schwarz, Shadowverse: Evolve, Godzilla, hololive)',
    shortDescription: 'Downloads every card of an English Bushiroad Deck Log deck (Cardfight!! Vanguard, Weiss Schwarz, Shadowverse: Evolve, Godzilla Card Game or hololive OCG), including the reverse side of double-sided cards.',
    keywords: ['bushiroad', 'deck log', 'decklog', 'vanguard', 'cardfight', 'weiss schwarz', 'weiss', 'shadowverse', 'evolve', 'godzilla', 'hololive'],
    imageSource: 'The official English website of each game.',
    recommendedCardSize: 'standard',
    producesDoubleSided: true,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'bushiroad_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'These games use standard-size cards (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}bushiroad/`,
    formats: [
      urlFormat('bushiroad_url', 'Bushiroad Deck Log link', /^https?:\/\/decklog(?:-en)?\.bushiroad\.com\/view\/(\w+)\s*/.source, {
        description: 'A deck link from Bushiroad Deck Log (English site), where players build decks for Cardfight!! Vanguard, Weiss Schwarz, Shadowverse: Evolve, Godzilla Card Game and hololive OCG.',
        howToGet: 'On decklog-en.bushiroad.com, open the deck (or save your own to get a deck code) and copy the full page address, like https://decklog-en.bushiroad.com/view/1HF6L. The short code on its own is not accepted.',
        example: 'https://decklog-en.bushiroad.com/view/1HF6L',
        warning: 'Only English Deck Log decks work; Japanese decklog.bushiroad.com decks are not supported.',
      }),
    ],
    options: [],
    notes: [
      'Double-sided cards get their reverse side automatically (see Unique backs in Your cards). Landscape pictures are turned upright.',
      'Official pictures are small and have rounded corners: upscaling and "Fill rounded corners" help.',
    ],
  },

  // ───────────────────────────────────────────── Echoes of Astra
  {
    id: 'echoes_of_astra',
    displayName: 'Echoes of Astra',
    shortDescription: 'Downloads every card of a public Echoes of Astra deck built on AstraBuilder, using the official card pictures.',
    keywords: ['echoes of astra', 'astra', 'astrabuilder'],
    imageSource: 'Official Echoes of Astra card pictures (via AstraBuilder).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'broken',
    statusMessage: 'Currently broken: the deck website changed, so no deck can be downloaded right now. Check for an app update.',
    backHint: null,
    defaultFormat: 'astrabuilder_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Echoes of Astra cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}echoes_of_astra/`,
    formats: [
      urlFormat('astrabuilder_url', 'AstraBuilder deck link', /^https:\/\/www\.astra-builder\.com\/\w+\/create\?deck=(\d+)/.source, {
        description: 'A deck link from AstraBuilder (astra-builder.com), the deck builder for Echoes of Astra. The deck must be public.',
        howToGet: 'On www.astra-builder.com, open your deck and copy the address from the browser bar, like https://www.astra-builder.com/en/create?deck=648. It must include "www." and the language part (like /en/).',
        example: 'https://www.astra-builder.com/en/create?deck=648',
      }),
    ],
    options: [],
    notes: [
      'Private, deleted or unknown decks stop the download with an error.',
    ],
  },

  // ───────────────────────────────────────────── Elestrals
  {
    id: 'elestrals',
    displayName: 'Elestrals',
    shortDescription: 'Downloads every card of a deck saved on the Elestrals Play Network, using the deck\'s ID.',
    keywords: ['elestrals', 'elestral', 'play network'],
    imageSource: 'Elestrals Play Network.',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'elestrals',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Elestrals cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}elestrals/`,
    formats: [
      inlineFormat('elestrals', 'Elestrals Play Network deck ID', /[0-9a-fA-F]{24}/.source, {
        extract: true,
        description: 'The ID of a deck saved on the Elestrals Play Network (play.elestrals.com): a 24-character code of letters and numbers, like 6883b784bd9cf7315d565843.',
        howToGet: 'On play.elestrals.com/decks, open your deck (it should be public) and copy the 24-character ID from the page address. You can also paste the whole deck link: the ID is picked out of it automatically.',
        example: '6883b784bd9cf7315d565843',
      }),
    ],
    options: [],
    notes: [
      'Every section of the deck is downloaded, including side cards.',
      'If one card can\'t be downloaded, the whole download stops; the cards saved so far are kept.',
      'Pictures keep their rounded corners: "Fill rounded corners" helps.',
    ],
  },

  // ───────────────────────────────────────────── Final Fantasy TCG
  {
    id: 'final_fantasy',
    displayName: 'Final Fantasy TCG',
    shortDescription: 'Reads a Final Fantasy Trading Card Game deck list (Untap, Tabletop Simulator or OCTGN) and downloads the pictures from Square Enix\'s official card browser.',
    keywords: ['final fantasy', 'fftcg', 'ff', 'square enix', 'materia hunter', 'octgn', 'untap'],
    imageSource: 'Official FFTCG card browser (Square Enix).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: null,
    defaultFormat: 'tts',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Final Fantasy TCG cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}final_fantasy/`,
    formats: [
      fileFormat('octgn_xml', 'OCTGN deck file', ['o8d', 'xml'], {
        description: 'An OCTGN deck file (XML) for Final Fantasy TCG. It lists cards by name only, so a different printing (or a different card with the same name) may be picked.',
        howToGet: 'Save or export the deck from OCTGN, or from a deck builder that offers an OCTGN export; the file usually ends in .o8d. Prefer the Tabletop Simulator or Untap export when you can: they include serial codes.',
        example: lines(
          '<deck game="285a8cdb-1d02-4edd-a9de-1ade9d5a4f43">',
          '<section name="Forwards" shared="False">',
          '<card qty="3" id="6048684b-b336-40e3-bbd4-8b47adde3e85">Wuk Lamat</card>',
          '</section>',
          '</deck>',
        ),
      }),
      fileFormat('tts', 'Tabletop Simulator list (e.g. Materia Hunter)', 'txt', {
        description: 'The Tabletop Simulator text export from FFTCG deck builders such as Materia Hunter (materiahunter.com). Header and section lines are ignored; card lines look like "3 Rufus (20-040L)".',
        howToGet: 'On materiahunter.com, open your deck, use its Tabletop Simulator (TTS) export, copy all the text and paste it here.',
        example: lines('--Generated By materiahunter.com--', 'Forward(6):', '3 Rufus (20-040L)', '3 Cloud (11-136S)', 'Backup(1):', '1 Jessie (1-204S)'),
      }),
      fileFormat('untap', 'Untap deck list', 'txt', {
        description: 'A plain-text deck list with one card per line: quantity, card name and serial code in parentheses, like "3 Rufus (20-040L)". This is the format of the Untap online play site.',
        howToGet: 'Use your deck builder\'s Untap export, or type the list yourself: one card per line as quantity, name and serial code in parentheses.',
        example: lines('3 Rufus (20-040L)', '3 Cloud (11-136S)', '1 Jessie (1-204S)', '1 Shantotto (1-107L)'),
      }),
    ],
    options: [],
    notes: [
      'Card lines must look exactly like "3 Rufus (20-040L)": "3x" quantities, missing codes and trailing spaces make a line be skipped.',
      'The official card search sometimes returns a different card for a serial code; check your cards before printing.',
    ],
  },

  // ───────────────────────────────────────────── Grand Archive
  {
    id: 'grand_archive',
    displayName: 'Grand Archive',
    shortDescription: 'Downloads Grand Archive card pictures for a deck list copied from Omnideck, using the official Grand Archive card database.',
    keywords: ['grand archive', 'gatcg', 'omnideck'],
    imageSource: 'Official Grand Archive card database (gatcg.com).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: 'Grand Archive cards share one card back, which is not downloaded. To print backs, add a back image in Your cards, Common back.',
    defaultFormat: 'omnideck',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Grand Archive cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}grand_archive/`,
    formats: [
      fileFormat('omnideck', 'Omnideck deck list (text)', 'txt', {
        description: 'A plain-text card list in Omnideck\'s format: one card per line, as quantity then card name. Omnideck is the Grand Archive deck builder.',
        howToGet: 'Open your deck on Omnideck (omnideck.net), use its export / copy-as-text option, and paste the list here. Card lines look like "3 Incapacitate"; headings such as "# Main Deck" are ignored.',
        example: lines('# Main Deck', '3 Incapacitate', '4 Sable Remnant', '4 Slice and Dice', '', '# Material Deck', '1 Spirit of Wind', '1 Tristan, Underhanded'),
      }),
    ],
    options: [],
    notes: [
      'Main deck and material deck cards are all downloaded.',
      'The first edition\'s picture is always used; names with accents may not be found.',
    ],
  },

  // ───────────────────────────────────────────── KeyForge
  {
    id: 'keyforge',
    displayName: 'KeyForge',
    shortDescription: 'Downloads KeyForge card pictures from the Archon Arcana wiki, for a Master Vault or Decks of KeyForge deck link or a simple list of card names.',
    keywords: ['keyforge', 'master vault', 'decks of keyforge', 'dok', 'archon arcana'],
    imageSource: 'Archon Arcana wiki (deck contents from Master Vault).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: 'KeyForge cards share one card back, which is not downloaded. To print backs, add a back image in Your cards, Common back (blank KeyForge backs are linked from the plugin documentation).',
    defaultFormat: 'master_vault_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'KeyForge uses the standard card size (63 x 88 mm), as the plugin documentation says.',
    docsUrl: `${DOCS_BASE}keyforge/`,
    formats: [
      fileFormat('archon_arcana', 'Card list (names or Archon Arcana links)', 'txt', {
        description: 'A simple list with one KeyForge card per line, written as a card name or an Archon Arcana wiki link. Repeat a line for each extra copy. Useful for printing specific cards rather than a whole deck.',
        howToGet: 'Type the card names, one per line, repeating a line once per extra copy. You can also paste links copied from a card\'s page on archonarcana.com. Lines starting with # or // are ignored.',
        example: lines('Ecto-Charge', 'Gracchan Reform', 'Gracchan Reform', 'AEmber Imp', 'https://www.archonarcana.com/wiki/Gracchan_Reform'),
      }),
      urlFormat('master_vault_url', 'Master Vault deck link',
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.source, {
          extract: true,
          description: 'A link to a deck on Master Vault, the official KeyForge deck registry (keyforgegame.com). The whole deck is downloaded, including its Prophecy cards.',
          howToGet: 'Find the deck on keyforgegame.com (Master Vault) and copy the page address from the browser bar. It looks like https://www.keyforgegame.com/deck-details/<long id>. The long deck ID on its own also works.',
          example: 'https://www.keyforgegame.com/deck-details/4b86855f-71e5-4f54-a20d-2a58ec973f9c',
        }),
      urlFormat('decks_of_keyforge_url', 'Decks of KeyForge deck link',
        /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.source, {
          extract: true,
          description: 'A link to a deck on Decks of KeyForge (decksofkeyforge.com), the popular deck-rating site. The deck itself is read from Master Vault using the ID in the link.',
          howToGet: 'Search for the deck on decksofkeyforge.com, open it, and copy the page address from the browser bar (https://decksofkeyforge.com/decks/<long id>).',
          example: 'https://decksofkeyforge.com/decks/4b86855f-71e5-4f54-a20d-2a58ec973f9c',
        }),
    ],
    options: [],
    notes: [
      'Prophecy cards in a Master Vault deck are downloaded too.',
      'Card enhancements (bonus icons) are not shown on the pictures.',
      'Names are matched against the wiki; a close-but-different card may occasionally be picked, so check your cards.',
    ],
  },

  // ───────────────────────────────────────────── Lord of the Rings LCG
  {
    id: 'lotr_lcg',
    displayName: 'Lord of the Rings: Living Card Game',
    shortDescription: 'Downloads Lord of the Rings LCG pictures for RingsDB decks and fellowships, and complete quest and encounter sets for scenarios from Hall of Beorn.',
    keywords: ['lotr', 'lord of the rings', 'lcg', 'ringsdb', 'hall of beorn', 'middle-earth'],
    imageSource: 'RingsDB (player cards) and Hall of Beorn (scenario cards).',
    recommendedCardSize: 'standard',
    producesDoubleSided: true,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: 'Player cards and encounter cards have different backs, and neither is downloaded. Make player decks and scenarios as separate PDFs, each with the matching image in Your cards, Common back.',
    defaultFormat: 'ringsdb_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Lord of the Rings LCG cards are standard size (about 63 x 88 mm).',
    docsUrl: `${DOCS_BASE}lotr_lcg/`,
    formats: [
      urlFormat('ringsdb_url', 'RingsDB deck list link',
        /^(?:https?:\/\/(?:www\.)?ringsdb\.com\/decklist\/view\/(\d+)(?:\/\S*)?|https?:\/\/(?:www\.)?ringsdb\.com\/api\/public\/decklist\/(\d+)\.json|(\d+))\s*$/.source, {
          description: 'A link to a published player deck on RingsDB (ringsdb.com). All heroes and player cards are downloaded.',
          howToGet: 'On ringsdb.com, open a published deck list and copy the page address (https://ringsdb.com/decklist/view/<number>/...). You can also type just the number. Private deck links (.../deck/view/...) are not accepted: publish the deck first.',
          example: 'https://ringsdb.com/decklist/view/337/two-player-core-set-1-2-1.0',
        }),
      urlFormat('ringsdb_fellowship_url', 'RingsDB fellowship link',
        /^(?:https?:\/\/(?:www\.)?ringsdb\.com\/fellowship\/view\/(\d+)(?:\/\S*)?|(\d+))\s*$/.source, {
          description: 'A link to a published RingsDB fellowship (a group of player decks played together). The cards of every deck in the fellowship are downloaded.',
          howToGet: 'On ringsdb.com, open a published fellowship and copy the page address (https://ringsdb.com/fellowship/view/<number>/...), or type just the number.',
          example: 'https://ringsdb.com/fellowship/view/7100/beginnermono-spherefellowship',
        }),
      urlFormat('ringsdb_scenario_url', 'RingsDB scenario number',
        /^(?:https?:\/\/(?:www\.)?ringsdb\.com\/api\/public\/scenario\/(\d+)\.json|(\d+))\s*$/.source, {
          description: 'A RingsDB scenario number (or its API link) for a quest such as Passage Through Mirkwood. The quest and encounter cards are downloaded from Hall of Beorn.',
          howToGet: 'Type the RingsDB scenario number (for example 1 = Passage Through Mirkwood) or the link https://ringsdb.com/api/public/scenario/<number>.json. Normal RingsDB page links are not accepted; if you don\'t know the number, use the Hall of Beorn scenario link instead.',
          example: 'https://ringsdb.com/api/public/scenario/1.json',
          warning: 'Scenario downloads are slow: expect about a minute before the first card appears.',
        }),
      urlFormat('hallofbeorn_url', 'Hall of Beorn scenario link',
        /^https?:\/\/(?:www\.)?hallofbeorn\.com\/LotR\/Scenarios\/([^\s/]+)\s*$/.source, {
          description: 'A link to a scenario page on Hall of Beorn (hallofbeorn.com), the Lord of the Rings LCG card database. All quest and encounter cards of the scenario are downloaded.',
          howToGet: 'On hallofbeorn.com, open Scenarios, click your scenario, and copy the page address (https://hallofbeorn.com/LotR/Scenarios/<Scenario-Name>) with no slash at the end. Exact capitalization is faster.',
          example: 'https://hallofbeorn.com/LotR/Scenarios/Passage-Through-Mirkwood',
          warning: 'Scenario downloads are slow: expect about a minute before the first card appears.',
        }),
    ],
    options: [
      {
        name: 'scenario_mode', flag: '--scenario_mode', kind: 'choice',
        choices: ['normal', 'easy', 'nightmare'], choiceLabels: ['Normal', 'Easy', 'Nightmare'],
        default: 'normal',
        label: 'Scenario difficulty',
        help: 'How many copies of each encounter card to download for a scenario.',
        advanced: false,
        onlyForFormats: ['ringsdb_scenario_url', 'hallofbeorn_url'],
      },
    ],
    notes: [
      'Quest cards get their back side automatically (see Unique backs in Your cards). Landscape quest cards are turned upright.',
      'Sideboard cards of RingsDB decks are not downloaded.',
      'Hall of Beorn scenario data can change without notice; if a scenario fails, try again later.',
    ],
  },

  // ───────────────────────────────────────────── Arkham Horror LCG
  {
    id: 'arkham_horror_lcg',
    displayName: 'Arkham Horror: The Card Game',
    shortDescription: 'Downloads Arkham Horror: The Card Game pictures from ArkhamDB, including investigator backs, for an ArkhamDB deck link or an exported deck file.',
    keywords: ['arkham', 'arkham horror', 'ahlcg', 'lcg', 'arkhamdb', 'arkham.build'],
    imageSource: 'ArkhamDB.',
    recommendedCardSize: 'standard',
    producesDoubleSided: true,
    writesBackImages: false,
    status: 'ok',
    statusMessage: null,
    backHint: 'The player card back is not downloaded: add it in Your cards, Common back. Encounter cards use a different back, so print them as a separate PDF.',
    defaultFormat: 'arkhamdb_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Arkham Horror LCG cards are standard size (about 63 x 88 mm).',
    docsUrl: `${DOCS_BASE}arkham_horror_lcg/`,
    formats: [
      fileFormat('arkhamdb_json', 'ArkhamDB JSON export file', 'json', {
        description: 'A deck file exported from ArkhamDB (arkhamdb.com) or Arkham.Build with "Export JSON". It lists the investigator and each card\'s code and quantity.',
        howToGet: 'On arkhamdb.com, open your deck and use Export JSON, then choose the downloaded .json file. Arkham.Build\'s Export JSON file works too.',
        example: lines('{', '  "investigator_code": "01001",', '  "slots": {', '    "01006": 1,', '    "01016": 1,', '    "01086": 2', '  }', '}'),
      }),
      urlFormat('arkhamdb_url', 'ArkhamDB deck link', /^https?:\/\/arkhamdb\.com\/(deck|decklist)\/view\/(\d+)/.source, {
        description: 'A link to a deck on ArkhamDB (arkhamdb.com): a published deck list, or a personal deck its owner made publicly viewable.',
        howToGet: 'Open the deck on arkhamdb.com and copy the address from the browser bar: published deck lists look like https://arkhamdb.com/decklist/view/<number>/<name>, personal decks like https://arkhamdb.com/deck/view/<number>. Links with "www." or from arkham.build are not accepted; if a personal deck fails, publish it or use Export JSON.',
        example: 'https://arkhamdb.com/decklist/view/1',
      }),
    ],
    options: [],
    notes: [
      'The investigator is added automatically; side-deck cards are not downloaded.',
      'Investigators and other two-sided cards get their back side automatically (see Unique backs in Your cards). Landscape cards are turned upright.',
      'ArkhamDB pictures are small, so prints look soft: turning on upscaling helps.',
    ],
  },

  // ───────────────────────────────────────────── Sorcery: Contested Realm
  {
    id: 'sorcery_contested_realm',
    displayName: 'Sorcery: Contested Realm',
    shortDescription: 'Downloads Sorcery: Contested Realm card pictures from Curiosa for a Curiosa deck link.',
    keywords: ['sorcery', 'contested realm', 'curiosa'],
    imageSource: 'Curiosa (curiosa.io).',
    recommendedCardSize: 'standard',
    producesDoubleSided: false,
    writesBackImages: false,
    status: 'broken',
    statusMessage: 'Currently broken: Curiosa moved to sorcerytcg.com and the card downloader needs an update. Check for an app update.',
    backHint: 'Spellbook and Atlas cards have different backs: print them as separate PDFs, each with its own Common back.',
    defaultFormat: 'curiosa_url',
    recommendedPdf: { card_size: 'standard' },
    recommendedPdfNote: 'Sorcery: Contested Realm cards are standard size (63 x 88 mm).',
    docsUrl: `${DOCS_BASE}sorcery_contested_realm/`,
    formats: [
      urlFormat('curiosa_url', 'Curiosa deck link', /^https:\/\/curiosa\.io\/decks\/(\w+)/.source, {
        description: 'A link to a deck on Curiosa (curiosa.io), the Sorcery: Contested Realm deck builder. The main deck, avatar, sideboard and maybeboard are all downloaded.',
        howToGet: 'Open the deck on Curiosa and copy its address (https://curiosa.io/decks/<id>). Links of the form https://sorcerytcg.com/decks/<id> are not accepted.',
        example: 'https://curiosa.io/decks/cme5x329q00k9jo04ouuycsek',
      }),
    ],
    options: [],
    notes: [
      'Site cards are horizontal and are not turned automatically, so they may look squashed on the printed card.',
    ],
  },
];

/** Index for O(1) lookups; built once at module load. */
const PLUGIN_BY_ID = new Map(PLUGINS.map((p) => [p.id, p]));

/**
 * Find a plugin by id.
 * @param {string} id Plugin folder name, e.g. 'mtg'.
 * @returns {Plugin|null}
 */
export function getPlugin(id) {
  if (typeof id !== 'string') return null;
  return PLUGIN_BY_ID.get(id) || null;
}

/**
 * Find a deck format of a plugin. Format ids are compared exactly (click accepts any case, but the
 * catalog stores the canonical lowercase enum values).
 * @param {string} pluginId
 * @param {string} formatId
 * @returns {DeckFormat|null}
 */
export function getFormat(pluginId, formatId) {
  const plugin = getPlugin(pluginId);
  if (!plugin || typeof formatId !== 'string') return null;
  return plugin.formats.find((f) => f.id === formatId) || null;
}

/**
 * Format to preselect for a plugin: the saved choice when it is still valid, else the plugin's default.
 * @param {string} pluginId
 * @param {string|null} [savedFormatId]
 * @returns {string|null} null for an unknown plugin.
 */
export function getDefaultFormat(pluginId, savedFormatId = null) {
  const plugin = getPlugin(pluginId);
  if (!plugin) return null;
  if (savedFormatId && plugin.formats.some((f) => f.id === savedFormatId)) return savedFormatId;
  return plugin.defaultFormat;
}

/**
 * PDF settings recommended for cards fetched with this plugin and format: the plugin-wide values
 * overridden by the format-specific ones. Returns a NEW object containing create_pdf option keys only
 * (e.g. { card_size: 'standard', crop: '3mm' }); {} for an unknown plugin.
 * @param {string} pluginId
 * @param {string|null} [formatId]
 * @returns {PdfRecommendation}
 */
export function getRecommendedPdf(pluginId, formatId = null) {
  const plugin = getPlugin(pluginId);
  if (!plugin) return {};
  const format = formatId ? getFormat(pluginId, formatId) : null;
  return { ...(plugin.recommendedPdf || {}), ...((format && format.recommendedPdf) || {}) };
}

/**
 * Plain-language explanation of getRecommendedPdf(): the format note when the format has its own
 * recommendation, else the plugin note.
 * @param {string} pluginId
 * @param {string|null} [formatId]
 * @returns {string}
 */
export function getRecommendedPdfNote(pluginId, formatId = null) {
  const plugin = getPlugin(pluginId);
  if (!plugin) return '';
  const format = formatId ? getFormat(pluginId, formatId) : null;
  return (format && format.recommendedPdfNote) || plugin.recommendedPdfNote || '';
}

/**
 * Options of a plugin that matter for a given format (options with `onlyForFormats` are dropped for
 * other formats).
 * @param {string} pluginId
 * @param {string|null} [formatId] When omitted, every option is returned.
 * @returns {PluginOption[]}
 */
export function getOptionsForFormat(pluginId, formatId = null) {
  const plugin = getPlugin(pluginId);
  if (!plugin) return [];
  if (!formatId) return plugin.options.slice();
  return plugin.options.filter((o) => !Array.isArray(o.onlyForFormats) || o.onlyForFormats.includes(formatId));
}

/**
 * Check a typed or pasted value against a format's pattern. Formats without a pattern (deck list
 * files, some links) accept any non-empty value.
 * @param {DeckFormat|null} format
 * @param {string} value
 * @returns {boolean}
 */
export function matchesFormatPattern(format, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return false;
  if (!format || !format.pattern) return true;
  try {
    return new RegExp(format.pattern).test(text);
  } catch {
    return true; // A broken pattern must never block the user; the plugin will report problems.
  }
}

/**
 * The value that will reach the plugin for url / text_inline formats: trimmed, and for formats with
 * `extract: true` the first match of the pattern (e.g. the 24-character Elestrals deck ID inside a
 * pasted link). Returns '' for empty input.
 * @param {DeckFormat|null} format
 * @param {string} value
 * @returns {string}
 */
export function normalizeInlineValue(format, value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || !format || !format.extract || !format.pattern) return text;
  try {
    const match = new RegExp(format.pattern).exec(text);
    return match ? match[0] : text;
  } catch {
    return text;
  }
}

/**
 * Filter plugins for the searchable game picker. Matches every word of the query (case- and
 * accent-insensitive) against the display name, id and keywords. An empty query returns all plugins.
 * @param {string} query
 * @param {Plugin[]} [plugins] Defaults to PLUGINS (pass a merged list to include introspected plugins).
 * @returns {Plugin[]}
 */
export function searchPlugins(query, plugins = PLUGINS) {
  const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return plugins.slice();
  return plugins.filter((p) => {
    const haystack = fold([p.displayName, p.id, p.id.replace(/_/g, ' '), ...(p.keywords || [])].join(' '));
    return words.every((w) => haystack.includes(w));
  });
}
