/* =========================================================
   SMARTSORT, ITEM TRACKER
   Keeps one track per physical item across frames, so an item is
   decided and counted once however long it stays in view. Each track
   averages the model's scores over recent frames (one bad frame does
   not flip the answer) and smooths its box for display.
   ========================================================= */

const ALPHA = 0.35;      // weight of the newest frame in the running average
const MATCH_IOU = 0.2;
const MAX_MISSES = 4;    // frames a track survives without being seen

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter || 1);
};

export class Tracker {
  constructor() { this.tracks = []; this.nextId = 1; }

  reset() { this.tracks = []; }

  /* dets: [{ box, out, crop, label?, group? }] where out is an engine
     result. With labels (Vision AI item names), a detection only joins a
     track with the same name, or one of the same category that it mostly
     overlaps: a different item taking the place of a decided one must not
     inherit that decision. Returns the tracks that left the view. */
  update(dets, { maxMisses = MAX_MISSES } = {}) {
    const free = new Set(this.tracks);
    const pairs = [];
    for (const d of dets) {
      for (const t of this.tracks) {
        const v = iou(d.box, t.box);
        if (d.label && t.label) {
          const same = d.label === t.label;
          if (same ? v >= MATCH_IOU / 2 : d.group && d.group === t.group && v >= 0.45) pairs.push({ d, t, v: v + (same ? 0.3 : 0) });
        } else if (v >= MATCH_IOU) pairs.push({ d, t, v });
      }
    }
    pairs.sort((a, b) => b.v - a.v);
    const used = new Set();
    for (const { d, t } of pairs) {
      if (used.has(d) || !free.has(t)) continue;
      used.add(d);
      free.delete(t);
      this.feed(t, d);
    }
    for (const d of dets) if (!used.has(d)) this.tracks.push(this.feed(this.create(d.box), d));
    const gone = [];
    for (const t of free) if (++t.misses > maxMisses) gone.push(t);
    this.tracks = this.tracks.filter((t) => !gone.includes(t));
    return gone;
  }

  create(box) {
    return { id: this.nextId++, box: { ...box }, ema: new Map(), hits: 0, misses: 0, born: Date.now(), decided: null, last: null, crop: null };
  }

  feed(t, d) {
    t.misses = 0;
    t.hits++;
    for (const k of ['x', 'y', 'w', 'h', 'cx', 'cy']) if (d.box[k] != null) t.box[k] = t.box[k] == null ? d.box[k] : t.box[k] + (d.box[k] - t.box[k]) * 0.5;
    const seen = new Set();
    for (const s of d.out.scores || []) {
      seen.add(s.id);
      t.ema.set(s.id, t.ema.has(s.id) ? t.ema.get(s.id) + (s.p - t.ema.get(s.id)) * ALPHA : s.p);
    }
    for (const [id, p] of t.ema) if (!seen.has(id)) t.ema.set(id, p * (1 - ALPHA));
    t.last = d.out;
    t.crop = d.crop;
    if (d.label) t.label = d.label;
    if (d.group) t.group = d.group;
    return t;
  }

  /* The track's averaged scores, in the shape decide() expects. */
  static smoothed(t) {
    return { ...t.last, scores: [...t.ema].map(([id, p]) => ({ id, p })) };
  }
}
