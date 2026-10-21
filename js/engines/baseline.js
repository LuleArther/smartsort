/* =========================================================
   SMARTSORT, BASELINE ENGINE
   MobileNet V2 was trained on ImageNet's 1000 everyday object
   classes, not on materials. This engine adds up the probability the
   model gives to object classes that are usually made of each
   material (e.g. "water bottle" and "pop bottle" for PET). The score
   is the model's real probability mass for those classes, but the
   mapping from object to material is a rule of thumb, which is why
   this is a baseline for demonstrations and not for production.
   ========================================================= */
import { extract, EXTRACTOR_ID } from './features.js';

export const VERSION = `baseline-imagenet-map-1/${EXTRACTOR_ID}`;

/* ImageNet class index -> category id, per mode. Index = position in
   the 1000-class list (background logit already removed). */
const MAP = {
  general: {
    plastic: [898, 737, 728, 692, 463, 720, 631, 838, 804, 899, 793, 455, 647],
    glass: [440, 907, 441, 572, 438, 883, 966, 901, 711],
    paper: [478, 549, 700, 999, 917, 921, 922, 918],
    metal: [653, 473, 585, 822, 488, 677, 783, 567, 909, 469],
    organic: [954, 950, 951, 948, 949, 953, 957, 952, 955, 956, 936, 937, 938, 939, 940, 941, 942, 943, 944, 945, 947, 987, 998, 988, 958, 930, 931, 963, 935],
    other: [529, 806, 610, 608, 841, 911, 487, 673, 761, 508, 770, 630],
  },
  plastic: {
    pet: [898, 737],                 // water bottle, pop bottle
    hdpe: [899, 631, 804, 720, 838], // water jug, lotion, soap dispenser, pill bottle, sunscreen
    pp: [463, 455, 647],             // bucket, bottlecap, measuring cup
    ldpe: [728, 692, 793],           // plastic bag, packet, shower cap
  },
};

/* Below this much total probability on mapped classes, the model is
   looking at something outside the waste list (a person, a desk...). */
const MIN_COVERAGE = 0.15;

let labels = null;
async function loadLabels() {
  if (!labels) {
    try { labels = await (await fetch(`models/${EXTRACTOR_ID}/labels.json`)).json(); } catch { labels = []; }
  }
  return labels;
}

export async function classify(input, mode) {
  const feats = input.features || (input.features = await extract(input.crop224));
  const { probs } = feats;
  const names = await loadLabels();
  const map = MAP[mode] || {};
  const scores = Object.entries(map).map(([id, idx]) => ({ id, p: idx.reduce((s, i) => s + probs[i], 0) }));
  const coverage = scores.reduce((s, x) => s + x.p, 0);

  const top = [...probs.keys()].sort((a, b) => probs[b] - probs[a]).slice(0, 3)
    .map((i) => ({ label: names[i] || `class ${i}`, p: probs[i] }));
  const evidence = `Model saw: ${top.map((t) => `${t.label} ${(t.p * 100).toFixed(0)}%`).join(', ')}`;

  return {
    engine: 'baseline',
    modelVersion: VERSION,
    confidenceKind: 'probability',
    scores,
    unrecognised: coverage < MIN_COVERAGE ? 'The baseline model did not recognise any item on its waste list in this image.' : null,
    evidence: [evidence],
  };
}
