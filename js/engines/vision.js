/* =========================================================
   SMARTSORT, VISION AI ENGINE
   A vision-language model served by Ollama (default qwen2.5vl:3b on
   this machine's GPU, free and offline) looks at the whole picture and
   lists every item it sees, with a bounding box, its material in plain
   words and, for plastics, the likely resin type. SmartSort maps those
   words to its own categories (rules below), so the model is never
   forced to pick from a fixed list it may misread. People are
   recognised and shown but never treated as waste.
   The model rates its own confidence high/medium/low; only "high" is
   acted on, and that rating is shown as-is, never as a percentage.
   ========================================================= */

export const DEFAULTS = { url: 'http://localhost:11434', model: 'qwen2.5vl:3b' };

/* Plain-language material -> general-mode category. First match wins,
   so the more specific rules come first. */
const MATERIAL_RULES = [
  ['person', /\b(human|person|people|skin|face|hand|body|man|woman|child|hair)\b/],
  ['mixed', /\bmixed\b|multiple|multi-material|composite|various|several materials/],
  ['electronics', /electronic|circuit|battery|cable|wire/],
  ['plastic', /plastic|polyethylene|polypropylene|polystyrene|\bpvc\b|\bpet\b|hdpe|ldpe|nylon|acrylic|styrofoam|polymer|vinyl|\bfoam\b/],
  ['glass', /glass/],
  ['paper', /paper|cardboard|carton|newspaper|tissue|book/],
  ['metal', /alumin|steel|metal|iron|\btin\b|copper|brass|chrome|zinc/],
  ['textile', /fabric|cotton|cloth|textile|wool|denim|polyester|silk|linen|canvas|knit|woven|straw|jute|felt/],
  ['wood', /wood|timber|plywood|bamboo|cork|mdf|chipboard/],
  ['ceramic', /ceramic|tile|porcelain|stone|concrete|brick|marble|clay|granite|cement|terracotta/],
  ['rubber', /rubber|latex|silicone/],
  ['leather', /leather|suede/],
  ['organic', /fruit|food|vegetable|peel|leaf|leaves|plant|organic|banana|bread|meat|egg|flower|grass|seed|nut|bone/],
];
const RESIN_TO_ID = { PET: 'pet', HDPE: 'hdpe', PP: 'pp', LDPE: 'ldpe', PVC: 'pvc', PS: 'ps', OTHER: 'other_plastic', UNKNOWN: 'other_plastic' };
const Q = { high: 0.9, medium: 0.6, low: 0.3 };

/* Objects whose material is settled by what they are, whatever words the
   model used for the material (a small model once called a jerrycan
   "rubber"). Checked against the object name only. */
const NAME_RULES = [
  [/^(person|people|man|woman|men|women|boy|girl|child|baby|face|hand|human|worker)\b/, 'person', null],
  // In Uganda's waste stream these are almost always PET, whatever the model calls the material.
  [/\b(water|soda|soft drink|drink|juice|mineral water|plastic) bottle\b/, 'plastic', 'PET'],
  [/\b(plastic|carrier|shopping|polythene|polyethylene|garbage|bin) bag\b|\bkaveera\b/, 'plastic', 'LDPE'],
  // Accessories keep the material the model saw ("iMac keyboard" is not an iMac).
  [/\b(keyboard|mouse|mouse ?pad|phone case|laptop (bag|sleeve|stand))\b/, null, null],
  // Devices built from metal, plastic, glass and electronics together.
  [/\b(laptop|notebook computer|macbook|imac|all-in-one|computer|desktop|pc tower|(smart|mobile |cell ?)?phone|iphone|tablet|ipad|monitor|television|\btv\b|printer|camera|speaker|headphones?|earphones?|router|game console|microwave|fridge|refrigerator|washing machine|blender|electric kettle|radio|smartwatch|power bank)\b/, 'mixed', null],
  [/jerry ?can|jerrican/, 'plastic', 'HDPE'],
  [/\bplastic\b/, 'plastic', null],
  [/\b(t-?shirt|shirt|trousers|jeans|dress|skirt|socks?|jacket|sweater|towel|curtain|clothing|clothes|garment|scarf|blanket|bedsheet|hat)\b/, 'textile', null],
  [/\b(newspaper|magazine|cardboard|carton)\b/, 'paper', null],
  [/\b(plant|flower|leaf|leaves|fruit|vegetable|peel)\b/, 'organic', null],
];

/* Used only when the model's material words are vague ("mixed",
   "electronic", none): everyday objects with one main material. */
const VAGUE_NAME_RULES = [
  [/\b(keyboard|mouse|remote( control)?|toothbrush|pen|toy|bucket|basin|tub|crate|plastic chair)\b/, 'plastic'],
  [/\b(notebook|note ?pad|book|diary|envelope|folder)\b/, 'paper'],
];
const VAGUE = new Set(['mixed', 'electronics', 'other']);

export function vagueOverride(name) {
  const n = String(name).toLowerCase();
  for (const [re, category] of VAGUE_NAME_RULES) if (re.test(n)) return category;
  return null;
}

export function nameOverride(name) {
  const n = String(name).toLowerCase();
  for (const [re, category, resin] of NAME_RULES) if (re.test(n)) return category ? { category, resin } : null;
  return null;
}

export function materialCategory(materialText, name = '') {
  const s = `${materialText} ${name}`.toLowerCase();
  // The material words decide; the object name is only a fallback.
  for (const [id, re] of MATERIAL_RULES) if (re.test(String(materialText).toLowerCase())) return id;
  for (const [id, re] of MATERIAL_RULES) if (re.test(s)) return id;
  return 'other';
}

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          material: { type: 'string' },
          plastic_type: { type: 'string', enum: ['PET', 'HDPE', 'PVC', 'LDPE', 'PP', 'PS', 'OTHER', 'UNKNOWN', 'NONE'] },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          box: { type: 'array', items: { type: 'integer' }, minItems: 4, maxItems: 4 },
        },
        required: ['name', 'material', 'plastic_type', 'confidence', 'box'],
      },
    },
  },
  required: ['items'],
};

const PROMPT = 'You are the vision system of a waste sorting machine. List the separate physical things in the image, '
  + 'largest or most central first, at most 6. A bunch, pile, stack or group of the same thing is ONE entry '
  + '(e.g. "bunch of bananas", "stack of papers"); never list the same object twice. Never list parts of an object: '
  + 'a keyboard is one item (not its keys), a bottle is one item (not its label), a laptop is one item (not its screen). '

  + 'People count: if a person, face or hand is visible, '
  + 'list it with name "person" and material "human". Do not list sky, walls, floors, shadows, reflections, text or logos. '
  + 'For each thing give: name (e.g. "water bottle", "t-shirt", "banana", "floor tile"); material in plain words '
  + '(e.g. "clear plastic", "cotton fabric", "wood", "ceramic", "rubber", "leather", "glass", "aluminium", "cardboard", "fruit"); '
  + 'for plastic things the most likely resin type (PET for clear drink bottles, HDPE for opaque milk jugs, detergent bottles '
  + 'and jerrycans, LDPE for bags and film, PP for bottle caps, tubs, buckets and basins, PS for foam and disposable cups), '
  + 'otherwise NONE; your confidence; and the bounding box [x_min, y_min, x_max, y_max] in pixels. Reply in JSON.';

const cfgOf = (settings) => ({ ...DEFAULTS, ...(settings.vision || {}) });

/* Qwen2.5-VL reports boxes in pixels of the image it actually sees. It
   resizes anything that is not a multiple of 28 px, so send it a frame
   that already is one (about 0.8 megapixels), and boxes map back exactly. */
function frameFor(src) {
  const target = 812000;
  const s = Math.sqrt(target / (src.width * src.height));
  let w = Math.max(28, Math.round((src.width * s) / 28) * 28);
  let h = Math.max(28, Math.round((src.height * s) / 28) * 28);
  while (w * h < 802816) { if (w / h < src.width / src.height) w += 28; else h += 28; }
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(src, 0, 0, w, h);
  return c;
}

let inflight = Promise.resolve();

export async function check(settings) {
  const { url, model } = cfgOf(settings);
  let tags;
  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) });
    tags = await res.json();
  } catch {
    throw new Error(`Ollama is not reachable at ${url}. Start Ollama on this computer. If SmartSort is opened from a website, also allow that site in OLLAMA_ORIGINS (see README).`);
  }
  const have = (tags.models || []).map((m) => m.name);
  if (!have.some((n) => n === model || n === `${model}:latest`)) {
    throw new Error(`The vision model "${model}" is not installed in Ollama. On this computer run: ollama pull ${model}`);
  }
  return true;
}

/* Returns every item in the picture: name, material words, SmartSort
   category, resin type, rating and a box in 0..1 frame units. */
export async function scan(canvas, settings) {
  const { url, model } = cfgOf(settings);
  const frame = frameFor(canvas);
  const image = frame.toDataURL('image/jpeg', 0.85).split(',')[1];
  const job = inflight.then(async () => {
    let res;
    try {
      res = await fetch(`${url}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(90000),
        body: JSON.stringify({
          model,
          stream: false,
          format: SCHEMA,
          keep_alive: '30m',
          options: { temperature: 0, num_ctx: 4096, num_predict: 1200 },
          messages: [{ role: 'user', content: `${PROMPT} The image is ${frame.width}x${frame.height} pixels.`, images: [image] }],
        }),
      });
    } catch (e) {
      throw new Error(e.name === 'TimeoutError' ? 'The vision model took too long to answer.' : `Ollama is not reachable at ${url}. Is it running?`);
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ? `Ollama: ${body.error}` : `Ollama returned HTTP ${res.status}.`);
    const items = parseItems(body.message.content);
    if (!items) throw new Error('The vision model gave an answer SmartSort could not read. Try again.');
    return items;
  });
  inflight = job.catch(() => {});
  const raw = await job;

  const out = [];
  for (const it of raw.slice(0, 10)) {
    if (!Array.isArray(it.box) || it.box.length !== 4) continue;
    let [x0, y0, x1, y1] = it.box.map(Number);
    if (x1 < x0) [x0, x1] = [x1, x0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    const clamp = (v) => Math.min(1, Math.max(0, v));
    const box = { x: clamp(x0 / frame.width), y: clamp(y0 / frame.height) };
    box.w = clamp(x1 / frame.width) - box.x;
    box.h = clamp(y1 / frame.height) - box.y;
    if (box.w < 0.01 || box.h < 0.01) continue;
    if (NO_MATERIAL.test(String(it.material || ''))) continue; // e.g. "moon": not a physical item here
    box.cx = box.x + box.w / 2;
    box.cy = box.y + box.h / 2;
    const override = nameOverride(it.name);
    let category = override?.category || materialCategory(it.material, it.name);
    if (!override && VAGUE.has(category)) category = vagueOverride(it.name) || category;
    // "Mixed" is only believed for devices (named in NAME_RULES).
    if (category === 'mixed' && override?.category !== 'mixed') {
      category = it.plastic_type && !['NONE', 'UNKNOWN'].includes(it.plastic_type) ? 'plastic' : 'other';
    }
    const dup = out.find((o) => o.name === it.name && iou(o.box, box) > 0.85);
    if (dup) continue; // smaller models sometimes repeat an item
    out.push({
      name: String(it.name || 'item').slice(0, 40),
      material: String(it.material || '').slice(0, 40),
      category,
      resin: category === 'plastic' ? override?.resin || (it.plastic_type && it.plastic_type !== 'NONE' ? it.plastic_type : null) : null,
      confidence: Q[it.confidence] ? it.confidence : 'low',
      box,
      person: category === 'person',
    });
  }
  return { items: tidy(out), model };
}

/* Keeps the list readable: drops specks, and drops parts reported inside
   a bigger item of the same kind (the keys of a keyboard). A different
   item lying on something (a phone on a mouse pad) is kept. */
const PART_WORDS = /\b(keys?|button|screen|display|label|sticker|logo|strap|handle|wheel|trackpad|touchpad|lens|zip|zipper|buckle)\b/i;

function tidy(items) {
  const area = (b) => b.w * b.h;
  const inside = (a, b) => {
    const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
    const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
    return (ix * iy) / (area(a) || 1);
  };
  const word = (n) => n.toLowerCase().split(/\s+/).pop().replace(/s$/, '');
  const kept = items.filter((it) => it.person || area(it.box) >= 0.012);
  // Bottle caps are not parts here: a PP cap is sorted apart from a PET bottle.
  return kept.filter((it) => !kept.some((big) => big !== it && !big.person && !it.person
    && area(big.box) > area(it.box) * 3 && inside(it.box, big.box) > 0.8
    && (big.name.toLowerCase().includes(word(it.name)) || PART_WORDS.test(it.name))))
    .slice(0, 6);
}

/* A long answer (many items) can be cut off mid-item; keep every item
   that was complete. */
function parseItems(text) {
  try { return JSON.parse(text).items || []; } catch { /* try to salvage */ }
  const found = [];
  for (const m of String(text).matchAll(/\{[^{}]*"box"\s*:\s*\[[^\]]*\][^{}]*\}/g)) {
    try { found.push(JSON.parse(m[0])); } catch { /* skip broken item */ }
  }
  return found.length ? found : null;
}

const NO_MATERIAL = /^\s*(none|unknown|n\/a|na|null|nothing|-)?\s*$/i;

function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
}

/* One item -> the engine result shape the decision rules expect. */
export function itemResult(item, mode, modeCfg, model) {
  const base = {
    engine: 'vision',
    modelVersion: `ollama/${model}`,
    confidenceKind: 'qualitative',
    qualitative: item.confidence,
    evidence: [`${item.name}: ${item.material}${item.resin ? ` (${item.resin})` : ''}, rated ${item.confidence}`],
    item,
  };
  if (item.person) return { ...base, scores: [], noItem: 'This is a person, not waste.' };
  let id;
  if (mode === 'plastic') {
    if (item.category !== 'plastic') return { ...base, scores: [], unrecognised: `Not plastic: ${item.name} looks like ${item.material}.` };
    id = RESIN_TO_ID[item.resin] || 'other_plastic';
  } else {
    id = modeCfg.categories.some((c) => c.id === item.category && c.enabled !== false) ? item.category : 'other';
  }
  return { ...base, scores: [{ id, p: Q[item.confidence], q: item.confidence }] };
}

/* Single-capture entry point: the biggest non-person item decides the
   bin; every item is returned for display. */
export async function classify(input, mode, settings) {
  const modeCfg = settings.modes[mode];
  const { items, model } = await scan(input.full, settings);
  const things = items.filter((i) => !i.person);
  const pick = mode === 'plastic' ? things.find((i) => i.category === 'plastic') || things[0] : things[0];
  const all = items.map((i) => ({ ...i, result: itemResult(i, mode, modeCfg, model) }));
  if (!pick) {
    return {
      engine: 'vision', modelVersion: `ollama/${model}`, confidenceKind: 'qualitative', scores: [], items: all,
      noItem: items.length ? 'Only a person is visible. Hold up or place an item.' : 'The vision model did not see any item.',
      evidence: items.map((i) => `${i.name}: ${i.material}`),
    };
  }
  const main = itemResult(pick, mode, modeCfg, model);
  return {
    ...main,
    items: all,
    mainIndex: items.indexOf(pick),
    partNote: things.length > 1 ? `${things.length} items in the picture; the bin is for "${pick.name}". Capture items one at a time, or use live table mode to sort them all.` : null,
    evidence: items.map((i) => `${i.name}: ${i.material}${i.resin ? ` (${i.resin})` : ''}, rated ${i.confidence}`),
  };
}
