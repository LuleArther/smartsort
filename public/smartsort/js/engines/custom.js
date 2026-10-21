/* =========================================================
   SMARTSORT, CUSTOM MODEL ENGINE
   Runs an image classifier exported as a TensorFlow.js model, for
   example from Teachable Machine (teachablemachine.withgoogle.com,
   "Image project" > Export > TensorFlow.js). Uploaded models are
   saved in this browser (IndexedDB) so they survive a reload.
   Class names are matched to category names or ids; a class called
   "empty", "background" or "no item" means nothing is in view.
   ========================================================= */
import { loadTf } from './features.js';
import { squareCrop } from '../camera.js';
import { slugify } from '../config.js';

const EMPTY_RE = /^(empty|background|none|nothing|no[ _-]?item|no[ _-]?object|_empty)$/i;
const loaded = new Map(); // cache key -> Promise<model>

const storageKey = (mode) => `indexeddb://smartsort-custom-${mode}`;
const cacheKey = (mode, cfg) => `${mode}|${cfg.source}|${cfg.url || ''}|${cfg.savedAt || ''}`;

async function loadAny(tf, src) {
  try { return { model: await tf.loadLayersModel(src), kind: 'layers' }; } catch (layersErr) {
    if (typeof src !== 'string' || src.startsWith('indexeddb://')) throw layersErr;
    return { model: await tf.loadGraphModel(src), kind: 'graph' };
  }
}

async function readJsonFile(file) { return JSON.parse(await file.text()); }

function labelsFromMetadata(meta) {
  return Array.isArray(meta?.labels) ? meta.labels.map(String) : null;
}

/* From a URL to model.json; metadata.json (Teachable Machine) is looked
   for next to it. Returns the config to store in settings. */
export async function importFromUrl(mode, url, labelsText) {
  const tf = await loadTf();
  const { model } = await loadAny(tf, url);
  let labels = parseLabels(labelsText);
  let name = url.split('/').slice(-2, -1)[0] || 'model';
  if (!labels) {
    try {
      const meta = await (await fetch(new URL('metadata.json', new URL(url, location.href)))).json();
      labels = labelsFromMetadata(meta);
      if (meta.modelName) name = meta.modelName;
    } catch { /* no metadata next to the model */ }
  }
  checkLabels(model, labels);
  return { source: 'url', url, labels, name, savedAt: Date.now() };
}

/* From files picked by the operator: model.json, weights .bin files
   and (optionally) metadata.json. */
export async function importFromFiles(mode, fileList, labelsText) {
  const tf = await loadTf();
  const files = [...fileList];
  const json = files.find((f) => /model\.json$/i.test(f.name)) || files.find((f) => f.name.endsWith('.json') && !/metadata/i.test(f.name));
  const weights = files.filter((f) => f.name.endsWith('.bin'));
  const metaFile = files.find((f) => /metadata\.json$/i.test(f.name));
  if (!json || !weights.length) throw new Error('Select the model.json file together with its .bin weight file(s), and metadata.json if you have it.');
  const model = await tf.loadLayersModel(tf.io.browserFiles([json, ...weights]));
  let labels = parseLabels(labelsText);
  let name = json.name.replace(/\.json$/, '');
  if (!labels && metaFile) {
    const meta = await readJsonFile(metaFile);
    labels = labelsFromMetadata(meta);
    if (meta.modelName) name = meta.modelName;
  }
  checkLabels(model, labels);
  await model.save(storageKey(mode));
  return { source: 'upload', labels, name, savedAt: Date.now() };
}

function parseLabels(text) {
  const list = String(text || '').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  return list.length ? list : null;
}

function checkLabels(model, labels) {
  if (!labels) throw new Error('No class names found. Include metadata.json, or type the class names in order, separated by commas.');
  const out = model.outputs[0].shape;
  const n = out[out.length - 1];
  if (n && n !== labels.length) throw new Error(`The model has ${n} outputs but ${labels.length} class names were given.`);
}

export async function remove(mode) {
  const tf = await loadTf();
  try { await tf.io.removeModel(storageKey(mode)); } catch { /* not stored */ }
  for (const k of loaded.keys()) if (k.startsWith(`${mode}|`)) loaded.delete(k);
}

export async function load(mode, cfg) {
  if (!cfg) throw new Error('No custom model is set up for this mode. Add one in Settings.');
  const key = cacheKey(mode, cfg);
  if (!loaded.has(key)) {
    const p = (async () => {
      const tf = await loadTf();
      const { model, kind } = await loadAny(tf, cfg.source === 'upload' ? storageKey(mode) : cfg.url);
      return { model, kind, tf };
    })();
    loaded.set(key, p);
    p.catch(() => loaded.delete(key));
  }
  return loaded.get(key);
}

function matchCategory(label, categories) {
  const l = slugify(label);
  return categories.find((c) => c.id === l || slugify(c.label) === l || (c.resin && String(c.resin) === l)) || null;
}

export async function classify(input, mode, settings) {
  const modeCfg = settings.modes[mode];
  const cfg = modeCfg.custom;
  const { model, tf } = await load(mode, cfg);
  const shape = model.inputs[0].shape;
  const h = shape[1] || 224;
  const crop = squareCrop(input.full, h);
  const out = tf.tidy(() => {
    const x = tf.browser.fromPixels(crop).toFloat().div(127.5).sub(1).expandDims(0);
    let y = model.predict(x);
    if (Array.isArray(y)) y = y[0];
    y = y.reshape([-1]);
    const sum = y.sum().dataSync()[0];
    return Math.abs(sum - 1) > 0.01 ? tf.softmax(y) : y;
  });
  const probs = await out.data();
  out.dispose();

  const scores = [];
  let empty = 0, topUnmatched = null, topP = -1;
  cfg.labels.forEach((label, i) => {
    const p = probs[i] ?? 0;
    const cat = matchCategory(label, modeCfg.categories);
    if (EMPTY_RE.test(label.trim())) empty += p;
    else if (cat) {
      const existing = scores.find((s) => s.id === cat.id);
      if (existing) existing.p += p; else scores.push({ id: cat.id, p });
    }
    if (p > topP) { topP = p; topUnmatched = !cat && !EMPTY_RE.test(label.trim()) ? label : null; }
  });
  // Only a confident "empty" means nothing is there; a weak one is just uncertain.
  const isEmptyTop = topP >= modeCfg.minConfidence && cfg.labels.some((l, i) => EMPTY_RE.test(l.trim()) && probs[i] === topP);

  return {
    engine: 'custom',
    modelVersion: `custom/${cfg.name}@${new Date(cfg.savedAt).toISOString().slice(0, 16)}`,
    confidenceKind: 'probability',
    scores,
    noItem: isEmptyTop ? 'The model sees the empty inspection area. Place one item in view.' : null,
    unsupportedLabel: topUnmatched,
    evidence: [`Model classes: ${cfg.labels.map((l, i) => `${l} ${((probs[i] || 0) * 100).toFixed(0)}%`).join(', ')}`],
    emptyP: empty,
  };
}
