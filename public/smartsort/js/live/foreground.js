/* =========================================================
   SMARTSORT, OBJECT FINDER (table / conveyor layout)
   Finds items on a plain surface seen by a fixed camera, by comparing
   each frame with a learned picture of the empty surface:
     1. per-pixel colour difference from the background (shadows,
        which are darker but the same colour, are ignored)
     2. noise removal (erode) and joining nearby parts (dilate)
     3. connected regions -> one box per item, in 0..1 frame units
   Works at 160 px wide, so it costs ~1 ms per frame. The background
   adapts slowly where no item is seen, to follow daylight changes.
   ========================================================= */

const W = 160;

export class ObjectFinder {
  constructor() {
    this.bg = null;
    this.w = W;
    this.h = 0;
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
  }

  get hasBackground() { return !!this.bg; }

  pixels(video) {
    const h = Math.round((W * video.videoHeight) / video.videoWidth);
    if (this.canvas.width !== W || this.canvas.height !== h) {
      this.canvas.width = W;
      this.canvas.height = h;
      if (this.h && this.h !== h) this.bg = null; // camera resolution changed
    }
    this.h = h;
    this.ctx.drawImage(video, 0, 0, W, h);
    return this.ctx.getImageData(0, 0, W, h).data;
  }

  /* Averages a few frames of the empty surface. */
  async learn(video, frames = 8) {
    let acc = null;
    for (let f = 0; f < frames; f++) {
      const d = this.pixels(video);
      if (!acc) acc = new Float32Array(d.length);
      for (let i = 0; i < d.length; i++) acc[i] += d[i];
      await new Promise((r) => setTimeout(r, 60));
    }
    for (let i = 0; i < acc.length; i++) acc[i] /= frames;
    this.bg = acc;
  }

  clear() { this.bg = null; }

  /* opts: { sensitivity, minAreaPct } -> { boxes, coverage } */
  detect(video, opts) {
    const d = this.pixels(video);
    const { w, h, bg } = this;
    const n = w * h;
    let mask = new Uint8Array(n);
    const t = opts.sensitivity;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const br = bg[p], bgc = bg[p + 1], bb = bg[p + 2];
      const diff = (Math.abs(r - br) + Math.abs(g - bgc) + Math.abs(b - bb)) / 3;
      if (diff < t) continue;
      // Shadow test: darker than the background by a similar ratio in
      // every channel, i.e. same colour, less light.
      const sum = r + g + b + 1, bsum = br + bgc + bb + 1;
      const ratio = sum / bsum;
      if (ratio > 0.4 && ratio < 0.92) {
        const chroma = Math.abs(r / sum - br / bsum) + Math.abs(g / sum - bgc / bsum);
        if (chroma < 0.045) continue;
      }
      mask[i] = 1;
    }
    mask = morph(mask, w, h, 1, false); // erode: drop speckle noise
    mask = morph(mask, w, h, 3, true);  // dilate: join parts of one item

    let coverage = 0;
    for (let i = 0; i < n; i++) coverage += mask[i];
    coverage /= n;

    // Follow slow lighting changes where nothing is detected.
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      if (mask[i]) continue;
      bg[p] += (d[p] - bg[p]) * 0.02;
      bg[p + 1] += (d[p + 1] - bg[p + 1]) * 0.02;
      bg[p + 2] += (d[p + 2] - bg[p + 2]) * 0.02;
    }

    const minArea = (opts.minAreaPct / 100) * n;
    let boxes = components(mask, w, h).filter((c) => c.area >= minArea);
    boxes = mergeNear(boxes, 3);
    return {
      coverage,
      boxes: boxes.map((b) => ({
        x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0 + 1) / w, h: (b.y1 - b.y0 + 1) / h,
        cx: b.sx / b.area / w, cy: b.sy / b.area / h, area: b.area / n,
      })).sort((a, b) => b.area - a.area),
    };
  }
}

/* Square-window dilate (any neighbour set) or erode (all neighbours set). */
function morph(src, w, h, r, dilate) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      scan: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx, yy = y + dy;
          const s = xx >= 0 && xx < w && yy >= 0 && yy < h ? src[yy * w + xx] : 0;
          if (dilate && s) { v = 1; break scan; }
          if (!dilate && !s) { v = 0; break scan; }
        }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function components(mask, w, h) {
  const seen = new Uint8Array(mask.length);
  const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const c = { x0: w, y0: h, x1: 0, y1: 0, area: 0, sx: 0, sy: 0 };
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      const x = i % w, y = (i / w) | 0;
      c.area++; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (x > 0 && mask[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && mask[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && mask[i - w] && !seen[i - w]) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && mask[i + w] && !seen[i + w]) { seen[i + w] = 1; stack.push(i + w); }
    }
    out.push(c);
  }
  return out;
}

/* Joins boxes that overlap or nearly touch (one item split in two). */
function mergeNear(boxes, gap) {
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        if (a.x0 - gap <= b.x1 && b.x0 - gap <= a.x1 && a.y0 - gap <= b.y1 && b.y0 - gap <= a.y1) {
          boxes[i] = {
            x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1),
            area: a.area + b.area, sx: a.sx + b.sx, sy: a.sy + b.sy,
          };
          boxes.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return boxes;
}
