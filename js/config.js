/* =========================================================
   SMARTSORT, CONFIGURATION
   Modes, categories, bins and thresholds. Everything here is a
   default: operators change it in Settings and the result is kept
   in localStorage, merged over these defaults on load (so new
   defaults added in a later version still appear).
   ========================================================= */

const STORAGE_KEY = 'smartsort.settings.v1';

export const MODES = {
  general: { id: 'general', label: 'General waste', long: 'General Waste Identification' },
  plastic: { id: 'plastic', label: 'Plastic type', long: 'Plastic Type Identification' },
};

export const ENGINES = {
  vision: {
    id: 'vision',
    label: 'Vision AI (Ollama, e.g. qwen2.5vl:3b)',
    short: 'Vision AI',
    note: 'A vision-language model running in Ollama on this computer: free and offline. Names every item in view with its material (plastic types, glass, metal, paper, wood, textile, ceramic, rubber, leather, organic…) and recognises people. About 1 second per picture on a mid-range GPU. Confidence is the model’s own high/medium/low rating; only high is acted on.',
  },
  waste: {
    id: 'waste',
    label: 'Waste model (YOLOv8, trained on waste photos)',
    short: 'Waste model',
    modes: ['general'],
    note: 'Trained on about 25,000 photos of metal, organic, paper and cardboard, plastic and glass (WasteDetector project). Fast enough for live detection. General waste mode only: it does not know plastic types, and it has no "other" class, so anything shown to it is forced into one of the five.',
  },
  baseline: {
    id: 'baseline',
    label: 'Baseline (pre-trained ImageNet model)',
    short: 'Baseline model',
    note: 'Works out of the box. Maps everyday object types (e.g. "water bottle") to typical materials. It does not identify materials, so it is weak for plastic types. Use it to demonstrate the workflow, then train a local model.',
  },
  knn: {
    id: 'knn',
    label: 'Locally trained model (Train tab)',
    short: 'Local model',
    note: 'Learns from photos of your own items taken in the Train tab. The best option for distinguishing PET, HDPE, PP and LDPE under your lighting.',
  },
  custom: {
    id: 'custom',
    label: 'Custom TensorFlow.js model (e.g. Teachable Machine)',
    short: 'Custom model',
    note: 'Load an image model exported from Teachable Machine or another TensorFlow.js tool. Class names must match category names.',
  },
  cloud: {
    id: 'cloud',
    label: 'Cloud vision AI (sends photos to a server)',
    short: 'Cloud AI',
    note: 'Sends each photo to the Luther Sort server, which asks an AI vision service. Needs internet. Confidence is the AI’s own high/medium/low rating, not a measured probability.',
  },
};

/* The destination for anything SmartSort will not commit to. Never
   a polymer bin: uncertain items always go to a person. */
export const MANUAL = {
  id: 'manual',
  label: 'Manual inspection',
  bin: 'Manual inspection area',
  instruction: 'Unable to identify this material reliably. Please inspect it manually.',
  color: '#8A6A1F',
};

/* Special training class: photos of the empty inspection area, so the
   local model can tell "nothing there" from an item. */
export const EMPTY_CLASS = { id: '_empty', label: 'No item (empty area)', instruction: 'Take photos of the empty inspection area and background.' };

const GENERAL_CATEGORIES = [
  { id: 'plastic', label: 'Plastic', bin: 'Plastic collection bin', color: '#1C6FB8', recyclable: true,
    examples: 'Bottles, jerrycans, containers, bags', instruction: 'Empty and drain. Place in the plastic collection bin.' },
  { id: 'glass', label: 'Glass', bin: 'Glass collection bin', color: '#178A7E', recyclable: true,
    examples: 'Bottles, jars', instruction: 'Handle with care. Place in the glass collection bin.' },
  { id: 'paper', label: 'Paper and cardboard', bin: 'Paper collection bin', color: '#8C6239', recyclable: true,
    examples: 'Cartons, boxes, newspaper, office paper', instruction: 'Keep dry and flatten boxes. Place in the paper collection bin.' },
  { id: 'metal', label: 'Metal', bin: 'Metal collection bin', color: '#5B6770', recyclable: true,
    examples: 'Cans, tins, scrap metal', instruction: 'Empty cans. Place in the metal collection bin.' },
  { id: 'organic', label: 'Organic waste', bin: 'Organic waste collection bin', color: '#3C7A2A', recyclable: false,
    examples: 'Food scraps, peels, plant material', instruction: 'Place in the organic waste collection bin.' },
  { id: 'textile', label: 'Textile', bin: 'Textile collection', color: '#A0446E', recyclable: true,
    examples: 'Clothes, fabric, sacks', instruction: 'Keep dry. Place in the textile collection.' },
  { id: 'wood', label: 'Wood', bin: 'Wood collection', color: '#8A5A2B', recyclable: true,
    examples: 'Planks, pallets, furniture parts', instruction: 'Remove nails where possible. Place in the wood collection.' },
  { id: 'ceramic', label: 'Ceramic and stone', bin: 'Rubble / inert waste', color: '#6E7B85', recyclable: false,
    examples: 'Tiles, plates, bricks, concrete', instruction: 'Place in the rubble / inert waste area.' },
  { id: 'rubber', label: 'Rubber', bin: 'Rubber collection', color: '#2F3A40', recyclable: true,
    examples: 'Boots, tyres, tubes', instruction: 'Place in the rubber collection.' },
  { id: 'leather', label: 'Leather', bin: 'Residual waste bin', color: '#6B3E26', recyclable: false,
    examples: 'Bags, shoes, belts', instruction: 'Not recyclable here. Place in the residual waste bin.' },
  { id: 'mixed', label: 'Multiple materials', bin: 'E-waste / mixed-material collection', color: '#5A4E8C', recyclable: true,
    examples: 'Laptops, phones, tablets, monitors, appliances', instruction: 'Made of several materials (metal, plastic, glass, battery). Do not crush. Place in the e-waste / mixed-material collection for dismantling.' },
  { id: 'electronics', label: 'Electronics', bin: 'E-waste collection', color: '#3D4F9F', recyclable: true,
    examples: 'Phones, cables, batteries, circuit boards', instruction: 'Do not crush. Batteries out. Place in the e-waste collection.' },
  { id: 'other', label: 'Other waste', bin: 'Residual waste bin', color: '#4A4F4D', recyclable: false,
    examples: 'Mixed or unrecognised materials', instruction: 'Not recyclable here. Place in the residual waste bin.' },
];

const PLASTIC_CATEGORIES = [
  { id: 'pet', label: 'PET', resin: 1, bin: 'PET collection bin', color: '#1C6FB8', recyclable: true,
    examples: 'Water and soft-drink bottles', instruction: 'Remove the cap (it is usually PP or HDPE). Place the bottle in the PET collection bin.' },
  { id: 'hdpe', label: 'HDPE', resin: 2, bin: 'HDPE collection bin', color: '#178A7E', recyclable: true,
    examples: 'Jerrycans, detergent and milk containers', instruction: 'Empty and drain. Place in the HDPE collection bin.' },
  { id: 'pp', label: 'PP', resin: 5, bin: 'PP collection bin', color: '#B5651D', recyclable: true,
    examples: 'Bottle caps, buckets, basins, food tubs', instruction: 'Place in the PP collection bin.' },
  { id: 'ldpe', label: 'LDPE', resin: 4, bin: 'LDPE collection bin', color: '#7B4FA0', recyclable: true,
    examples: 'Carrier bags, films, flexible packaging', instruction: 'Shake out contents. Place in the LDPE collection bin.' },
  { id: 'pvc', label: 'PVC', resin: 3, bin: 'PVC collection bin', color: '#5B6770', recyclable: true, enabled: false,
    examples: 'Pipes, some packaging, cable insulation', instruction: 'Place in the PVC collection bin.' },
  { id: 'ps', label: 'PS', resin: 6, bin: 'PS collection bin', color: '#8C6239', recyclable: false, enabled: false,
    examples: 'Disposable cups, foam takeaway boxes', instruction: 'Place in the PS collection bin.' },
  { id: 'other_plastic', label: 'Other or unknown plastic', resin: 7, bin: 'Manual inspection area', color: '#4A4F4D', recyclable: false,
    examples: 'Mixed, multilayer or unmarked plastics', instruction: 'Check for a resin code. If there is none, leave it for manual inspection.' },
];

export const DEFAULT_SETTINGS = {
  station: 'Station 1',
  modes: {
    general: { engine: 'waste', minConfidence: 0.55, minMargin: 0.15, categories: GENERAL_CATEGORIES, custom: null },
    plastic: { engine: 'baseline', minConfidence: 0.70, minMargin: 0.20, categories: PLASTIC_CATEGORIES, custom: null },
  },
  knn: { k: 7, minSimilarity: 0.55 },
  qualityChecks: true,
  storeThumbnails: true,
  duplicateWindowSec: 45,
  cloudEndpoint: '../api/identify.php',
  live: {
    stableFrames: 5,     // frames an item must be seen before a decision
    maxFrames: 30,       // after this many frames without a confident result: manual inspection
    maxItems: 6,         // items classified per frame in table mode
    sensitivity: 28,     // colour difference from the background that counts as an object (0-255)
    minAreaPct: 0.4,     // smallest object, as % of the frame
    autoRecordHandheld: false,
  },
  vision: { url: 'http://localhost:11434', model: 'qwen2.5vl:3b', stableScans: 2, autoDetected: false },
  machine: { transport: 'none', wsUrl: 'ws://localhost:8080', baud: 115200, sendUncertain: true },
  settingsVersion: 2,
};

const clone = (o) => JSON.parse(JSON.stringify(o));

/* Merge saved categories over defaults by id: saved edits win, new
   default categories are appended, operator-added ones are kept. */
function mergeCategories(defaults, saved) {
  if (!Array.isArray(saved)) return clone(defaults);
  const byId = new Map(saved.map((c) => [c.id, c]));
  const out = defaults.map((d) => ({ enabled: true, ...d, ...(byId.get(d.id) || {}) }));
  for (const c of saved) if (!defaults.some((d) => d.id === c.id)) out.push({ enabled: true, ...c, custom: true });
  return out;
}

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; } catch { saved = {}; }
  const s = {
    ...clone(DEFAULT_SETTINGS),
    ...saved,
    knn: { ...DEFAULT_SETTINGS.knn, ...(saved.knn || {}) },
    live: { ...DEFAULT_SETTINGS.live, ...(saved.live || {}) },
    machine: { ...DEFAULT_SETTINGS.machine, ...(saved.machine || {}) },
    vision: { ...DEFAULT_SETTINGS.vision, ...(saved.vision || {}) },
  };
  s.modes = {};
  for (const id of Object.keys(MODES)) {
    const d = DEFAULT_SETTINGS.modes[id];
    const m = (saved.modes || {})[id] || {};
    s.modes[id] = { ...clone(d), ...m, categories: mergeCategories(d.categories, m.categories) };
    const eng = ENGINES[s.modes[id].engine];
    if (!eng || (eng.modes && !eng.modes.includes(id))) s.modes[id].engine = d.engine;
  }
  // v1 shipped with the baseline engine as the general-mode default; the
  // waste model replaced it, so move stations that never chose otherwise.
  if ((saved.settingsVersion || 1) < 2 && s.modes.general.engine === 'baseline') s.modes.general.engine = 'waste';
  s.settingsVersion = DEFAULT_SETTINGS.settingsVersion;
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); return true; } catch { return false; }
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
  return loadSettings();
}

export const enabledCategories = (modeCfg) => modeCfg.categories.filter((c) => c.enabled !== false);

export function categoryById(modeCfg, id) {
  if (id === MANUAL.id || id == null) return MANUAL;
  return modeCfg.categories.find((c) => c.id === id) || null;
}

/* Turns an operator-typed category name into a stable id. */
export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
