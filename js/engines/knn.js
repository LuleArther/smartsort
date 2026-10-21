/* =========================================================
   SMARTSORT, LOCALLY TRAINED ENGINE
   k-nearest-neighbours over MobileNet feature vectors of photos the
   operators took in the Train tab. "Training" is storing labelled
   examples; a new item is classified by the labels of the k most
   similar examples. Confidence is the similarity-weighted share of
   the vote for the winning category. An item that is not similar to
   any example is reported as unrecognised instead of being forced
   into the nearest category.
   ========================================================= */
import * as store from '../store.js';
import { extract, EXTRACTOR_ID } from './features.js';
import { EMPTY_CLASS } from '../config.js';
import { toJpeg } from '../camera.js';

export const MIN_PER_CLASS = 3;
const cache = new Map(); // mode -> samples

export async function samplesFor(mode) {
  if (!cache.has(mode)) {
    const rows = await store.byIndex('samples', 'mode', mode);
    cache.set(mode, rows.filter((r) => r.extractor === EXTRACTOR_ID));
  }
  return cache.get(mode);
}

export const invalidate = (mode) => (mode ? cache.delete(mode) : cache.clear());

/* Stores one labelled example: the feature vector plus a small
   thumbnail so operators can review it. The full photo is not kept. */
export async function addSample(mode, categoryId, input, source) {
  const feats = input.features || (input.features = await extract(input.crop224));
  const sample = {
    id: store.uid(),
    mode,
    categoryId,
    extractor: EXTRACTOR_ID,
    embedding: feats.embedding,
    thumb: toJpeg(input.crop224, 112, 0.7),
    ts: Date.now(),
    source,
  };
  await store.put('samples', sample);
  invalidate(mode);
  return sample;
}

function fnv(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function versionOf(samples) {
  return `knn-${samples.length}s-${fnv(samples.map((s) => s.id).sort().join(','))}/${EXTRACTOR_ID}`;
}

/* Which categories have enough examples to be predicted at all. */
export function readiness(samples, categoryIds) {
  const counts = {};
  for (const s of samples) counts[s.categoryId] = (counts[s.categoryId] || 0) + 1;
  const trained = categoryIds.filter((id) => (counts[id] || 0) >= MIN_PER_CLASS);
  return { counts, trained, ready: trained.length >= 2 };
}

const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

/* Neighbour weight falls off sharply with distance from the closest
   match (softmax over similarity, temperature T), so a near-identical
   example outweighs several loosely similar ones. */
const T = 0.05;

export function vote(embedding, samples, k, excludeId = null) {
  const sims = [];
  for (const s of samples) if (s.id !== excludeId) sims.push({ s, sim: dot(embedding, s.embedding) });
  sims.sort((a, b) => b.sim - a.sim);
  const nn = sims.slice(0, Math.max(1, Math.min(k, sims.length)));
  const top = nn[0]?.sim ?? 0;
  const w = {};
  let total = 0;
  for (const { s, sim } of nn) { const v = Math.exp((sim - top) / T); w[s.categoryId] = (w[s.categoryId] || 0) + v; total += v; }
  const scores = Object.entries(w).map(([id, v]) => ({ id, p: total ? v / total : 0 }));
  return { scores, nearest: top, neighbours: nn.slice(0, 3).map(({ s, sim }) => ({ id: s.categoryId, sim })) };
}

export class NotReadyError extends Error {}

export async function classify(input, mode, settings, labelOf) {
  const modeCfg = settings.modes[mode];
  const all = await samplesFor(mode);
  const usable = all.filter((s) => s.categoryId === EMPTY_CLASS.id || modeCfg.categories.some((c) => c.id === s.categoryId && c.enabled !== false));
  const { ready } = readiness(usable, modeCfg.categories.filter((c) => c.enabled !== false).map((c) => c.id));
  if (!ready) {
    throw new NotReadyError(`The local model for this mode is not trained yet. In the Train tab, add at least ${MIN_PER_CLASS} photos for at least two categories.`);
  }
  const feats = input.features || (input.features = await extract(input.crop224));
  const { scores, nearest, neighbours } = vote(feats.embedding, usable, settings.knn.k);
  const winner = [...scores].sort((a, b) => b.p - a.p)[0];
  const unlike = nearest < settings.knn.minSimilarity;

  return {
    engine: 'knn',
    modelVersion: versionOf(usable),
    confidenceKind: 'probability',
    scores: scores.filter((s) => s.id !== EMPTY_CLASS.id),
    // "Unlike every example" wins over "looks empty": a weak match to the
    // empty-area photos does not mean nothing is there.
    noItem: winner?.id === EMPTY_CLASS.id && !unlike && winner.p >= modeCfg.minConfidence ? 'This looks like the empty inspection area. Place one item in view.' : null,
    unrecognised: unlike
      ? `This item does not closely resemble any training photo (closest similarity ${nearest.toFixed(2)}, minimum ${settings.knn.minSimilarity}). Add training photos of items like this one.`
      : null,
    evidence: [`Closest training photos: ${neighbours.map((n) => `${labelOf(n.id)} ${n.sim.toFixed(2)}`).join(', ')} (similarity, 1 = identical)`],
    nearest,
  };
}

/* Leave-one-out: classify each training photo against all the others.
   Photos of the same item taken seconds apart make this optimistic,
   which the Train tab says next to the figure. */
export function evaluate(samples, settings, modeCfg) {
  const enabled = new Set(modeCfg.categories.filter((c) => c.enabled !== false).map((c) => c.id));
  const pool = samples.filter((s) => enabled.has(s.categoryId) || s.categoryId === EMPTY_CLASS.id);
  const perClass = {};
  const confusion = {};
  let correct = 0, committed = 0, committedCorrect = 0;
  for (const s of pool) {
    const { scores, nearest } = vote(s.embedding, pool, settings.knn.k, s.id);
    const sorted = [...scores].sort((a, b) => b.p - a.p);
    const top = sorted[0] || { id: null, p: 0 };
    const margin = top.p - (sorted[1]?.p || 0);
    const pc = (perClass[s.categoryId] ||= { n: 0, correct: 0 });
    pc.n++;
    if (top.id === s.categoryId) { pc.correct++; correct++; }
    (confusion[s.categoryId] ||= {})[top.id] = ((confusion[s.categoryId] || {})[top.id] || 0) + 1;
    const confident = top.p >= modeCfg.minConfidence && margin >= modeCfg.minMargin && nearest >= settings.knn.minSimilarity;
    if (confident) { committed++; if (top.id === s.categoryId) committedCorrect++; }
  }
  return {
    n: pool.length,
    accuracy: pool.length ? correct / pool.length : null,
    committedRate: pool.length ? committed / pool.length : null,
    committedAccuracy: committed ? committedCorrect / committed : null,
    perClass,
    confusion,
  };
}
