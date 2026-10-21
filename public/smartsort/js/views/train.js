/* =========================================================
   SMARTSORT, TRAIN
   Builds the local model for the active mode from operators' own
   photos: capture or upload examples per category, check them with a
   leave-one-out evaluation, and move the set between stations as a
   JSON file. Only feature vectors and small thumbnails are stored.
   ========================================================= */
import { MODES, EMPTY_CLASS } from '../config.js';
import * as store from '../store.js';
import * as camera from '../camera.js';
import { knn } from '../engines/index.js';
import { EXTRACTOR_ID, loadExtractor } from '../engines/features.js';
import { esc, $, $$, icon, categoryMark, toast, download, stamp, fmtPct } from '../ui.js';

let el = null;
let ctx = null;
let busy = false;
let lastEval = null;

const b64 = {
  enc(f32) {
    const bytes = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(str) {
    const bin = atob(str);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Float32Array(bytes.buffer);
  },
};

function classesFor(cfg) {
  return [...cfg.categories.filter((c) => c.enabled !== false), { ...EMPTY_CLASS, empty: true }];
}

async function afterChange() {
  knn.invalidate(ctx.mode);
  lastEval = null;
  if (ctx.modeCfg().engine === 'knn') ctx.refreshEngine();
  await draw();
}

async function addFromCanvas(categoryId, canvas, source) {
  await knn.addSample(ctx.mode, categoryId, { full: canvas, crop224: camera.squareCrop(canvas, 224) }, source);
}

async function captureInto(categoryId, count) {
  if (busy) return;
  if (!camera.isActive()) { toast('Start the camera first, or use Upload.', 'warn'); return; }
  busy = true;
  const btns = $$('[data-cap], [data-burst], [data-upload-label]', el);
  btns.forEach((b) => b.setAttribute('disabled', ''));
  const status = $(`[data-status="${categoryId}"]`, el);
  try {
    await loadExtractor();
    for (let i = 0; i < count; i++) {
      if (status) status.textContent = count > 1 ? `Capturing ${i + 1} of ${count}… turn the item slowly` : 'Capturing…';
      await addFromCanvas(categoryId, camera.captureFrame($('#train-video', el)), 'train-camera');
      if (count > 1) await new Promise((r) => setTimeout(r, 350));
    }
    toast(`${count} photo${count > 1 ? 's' : ''} added to ${ctx.labelOf(categoryId)}.`, 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy = false;
    await afterChange();
  }
}

async function uploadInto(categoryId, files) {
  if (busy || !files.length) return;
  busy = true;
  let ok = 0, failed = 0;
  try {
    await loadExtractor();
    for (const file of files) {
      try { await addFromCanvas(categoryId, await camera.fromFile(file), 'train-upload'); ok++; } catch { failed++; }
      const status = $(`[data-status="${categoryId}"]`, el);
      if (status) status.textContent = `Adding ${ok + failed} of ${files.length}…`;
    }
    toast(`${ok} photo${ok === 1 ? '' : 's'} added to ${ctx.labelOf(categoryId)}${failed ? `, ${failed} could not be read` : ''}.`, failed ? 'warn' : 'ok');
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    busy = false;
    await afterChange();
  }
}

function evalBlock(cfg) {
  if (!lastEval) return '<p class="text-muted">Run an evaluation after adding photos to see how well the categories separate.</p>';
  const e = lastEval;
  if (!e.n) return '<p class="text-muted">No photos to evaluate.</p>';
  const rows = classesFor(cfg).filter((c) => e.perClass[c.id]);
  return `
    <div class="tiles">
      <div class="tile"><span class="tile-label">Top-choice accuracy</span><span class="tile-value">${fmtPct(e.accuracy)}</span><span class="tile-sub">${e.n} photos, each tested against the others</span></div>
      <div class="tile"><span class="tile-label">Would get a bin</span><span class="tile-value">${fmtPct(e.committedRate)}</span><span class="tile-sub">the rest go to manual inspection at current thresholds</span></div>
      <div class="tile"><span class="tile-label">Accuracy when a bin is given</span><span class="tile-value">${fmtPct(e.committedAccuracy)}</span><span class="tile-sub">what operators would see as confident</span></div>
    </div>
    <table class="simple">
      <thead><tr><th scope="col">Category</th><th scope="col">Photos</th><th scope="col">Recognised correctly</th><th scope="col">Most often confused with</th></tr></thead>
      <tbody>${rows.map((c) => {
        const pc = e.perClass[c.id];
        const conf = Object.entries(e.confusion[c.id] || {}).filter(([id]) => id !== c.id).sort((a, b) => b[1] - a[1])[0];
        return `<tr><td>${esc(c.label)}</td><td>${pc.n}</td><td>${fmtPct(pc.correct / pc.n)}</td><td>${conf ? `${esc(ctx.labelOf(conf[0]))} (${conf[1]})` : '—'}</td></tr>`;
      }).join('')}</tbody>
    </table>
    <p class="small text-muted">Photos of the same item taken seconds apart look alike, so this figure is optimistic. The real test is new items at the station: watch Verified accuracy on the Dashboard.</p>`;
}

async function draw() {
  if (!el) return;
  const cfg = ctx.modeCfg();
  const samples = await knn.samplesFor(ctx.mode);
  const byClass = {};
  for (const s of samples) (byClass[s.categoryId] ||= []).push(s);
  const classes = classesFor(cfg);
  const ready = knn.readiness(samples, cfg.categories.filter((c) => c.enabled !== false).map((c) => c.id));
  const active = cfg.engine === 'knn';

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1>Train the local model</h1>
        <p class="text-muted">${esc(MODES[ctx.mode].long)} · ${samples.length} training photo${samples.length === 1 ? '' : 's'} · ${ready.ready ? 'ready to use' : `needs at least ${knn.MIN_PER_CLASS} photos in two or more categories`}</p>
      </div>
      <div class="btn-row">
        ${active ? `<span class="tag tag-ok">${icon('check')} In use for this mode</span>`
          : `<button type="button" class="btn btn-secondary btn-sm" data-use ${ready.ready ? '' : 'disabled'}>Use local model for this mode</button>`}
      </div>
    </div>

    <div class="train-grid">
      <div class="panel train-camera">
        <h2>Camera</h2>
        <div class="viewport viewport-sm">
          <video id="train-video" playsinline muted autoplay></video>
          <div class="frame-guide" aria-hidden="true"></div>
          ${camera.isActive() ? '' : `<div class="viewport-msg"><p>The camera is off.</p><button type="button" class="btn btn-primary btn-sm" data-start-cam>${icon('play')} Start camera</button></div>`}
        </div>
        <ol class="steps small">
          <li>Use real items from the sorting line, cleaned and dirty, crushed and whole.</li>
          <li>Aim for 20+ photos per category from different sides, under the station’s normal lighting and background.</li>
          <li>Add photos of the empty inspection area to the <b>No item</b> class.</li>
          <li>Only label items whose material you have verified (resin code or test).</li>
        </ol>
      </div>

      <div class="train-classes">
        ${classes.map((c) => {
          const list = (byClass[c.id] || []).sort((a, b) => b.ts - a.ts);
          const n = list.length;
          const okCount = n >= knn.MIN_PER_CLASS;
          return `
          <article class="panel class-card">
            <header>
              ${c.empty ? `<span class="cat-mark cat-mark-md is-none">${icon('minusCircle')}</span>` : categoryMark(c, 'md')}
              <div><h3>${esc(c.label)}</h3><p class="small ${okCount || c.empty ? 'text-muted' : 'text-warn'}" data-status="${esc(c.id)}">${n} photo${n === 1 ? '' : 's'}${okCount ? '' : c.empty ? ' · optional, recommended' : ` · needs ${knn.MIN_PER_CLASS - n} more`}</p></div>
            </header>
            <div class="thumbs">
              ${list.slice(0, 12).map((s) => `<span class="thumb"><img src="${s.thumb}" alt=""><button type="button" class="thumb-del" data-del-sample="${esc(s.id)}" aria-label="Remove this photo">${icon('x')}</button></span>`).join('')}
              ${n > 12 ? `<span class="thumb thumb-more">+${n - 12}</span>` : ''}
            </div>
            <div class="btn-row">
              <button type="button" class="btn btn-outline btn-sm" data-cap="${esc(c.id)}">${icon('camera')} Capture</button>
              <button type="button" class="btn btn-outline btn-sm" data-burst="${esc(c.id)}" data-tip="Takes 10 photos over about 4 seconds while you turn the item">×10</button>
              <label class="btn btn-ghost btn-sm" data-upload-label>${icon('upload')} Upload<input type="file" accept="image/*" multiple class="visually-hidden" data-upload="${esc(c.id)}"></label>
              ${n ? `<button type="button" class="btn btn-ghost btn-sm" data-clear="${esc(c.id)}">Clear</button>` : ''}
            </div>
          </article>`;
        }).join('')}
      </div>
    </div>

    <section class="panel">
      <div class="panel-head"><h2>Check the model</h2>
        <button type="button" class="btn btn-outline btn-sm" data-eval ${samples.length >= 4 ? '' : 'disabled'}>Run evaluation</button></div>
      ${evalBlock(cfg)}
    </section>

    <section class="panel">
      <h2>Share between stations</h2>
      <p class="text-muted small">Export this mode’s training set as a file and import it on another device running SmartSort. Imports add to what is already here.</p>
      <div class="btn-row">
        <button type="button" class="btn btn-outline btn-sm" data-export ${samples.length ? '' : 'disabled'}>${icon('download')} Export training set</button>
        <label class="btn btn-outline btn-sm">${icon('upload')} Import training set<input type="file" accept="application/json,.json" class="visually-hidden" data-import></label>
      </div>
    </section>`;

  const v = $('#train-video', el);
  if (camera.isActive()) v.srcObject = camera.currentStream();
}

async function onClick(e) {
  const t = e.target;
  const cap = t.closest('[data-cap]')?.dataset.cap;
  const burst = t.closest('[data-burst]')?.dataset.burst;
  if (cap) return captureInto(cap, 1);
  if (burst) return captureInto(burst, 10);
  if (t.closest('[data-start-cam]')) {
    try { await camera.start(); } catch (err) { toast(err.message, 'error'); }
    return draw();
  }
  const delS = t.closest('[data-del-sample]')?.dataset.delSample;
  if (delS) { await store.del('samples', delS); return afterChange(); }
  const clear = t.closest('[data-clear]')?.dataset.clear;
  if (clear && confirm(`Remove all training photos for ${ctx.labelOf(clear)} in this mode?`)) {
    for (const s of await knn.samplesFor(ctx.mode)) if (s.categoryId === clear) await store.del('samples', s.id);
    return afterChange();
  }
  if (t.closest('[data-eval]')) {
    lastEval = knn.evaluate(await knn.samplesFor(ctx.mode), ctx.settings, ctx.modeCfg());
    return draw();
  }
  if (t.closest('[data-use]')) {
    ctx.modeCfg().engine = 'knn';
    ctx.save();
    ctx.refreshEngine();
    toast(`The local model is now used for ${MODES[ctx.mode].label} mode.`, 'ok');
    return draw();
  }
  if (t.closest('[data-export]')) {
    const samples = await knn.samplesFor(ctx.mode);
    const out = {
      format: 'smartsort-training-v1',
      extractor: EXTRACTOR_ID,
      mode: ctx.mode,
      exported: new Date().toISOString(),
      station: ctx.settings.station,
      categories: ctx.modeCfg().categories.map(({ id, label }) => ({ id, label })),
      samples: samples.map((s) => ({ id: s.id, categoryId: s.categoryId, ts: s.ts, source: s.source, thumb: s.thumb, embedding: b64.enc(s.embedding) })),
    };
    download(`smartsort-training-${ctx.mode}-${stamp()}.json`, JSON.stringify(out), 'application/json');
  }
}

async function onChange(e) {
  const up = e.target.dataset.upload;
  if (up) { const files = [...e.target.files]; e.target.value = ''; return uploadInto(up, files); }
  if (e.target.hasAttribute('data-import')) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'smartsort-training-v1') throw new Error('This is not a SmartSort training file.');
      if (data.extractor !== EXTRACTOR_ID) throw new Error(`This file was made with a different image model (${data.extractor}).`);
      if (data.mode !== ctx.mode) throw new Error(`This file is for ${MODES[data.mode]?.label || data.mode} mode. Switch mode at the top first.`);
      const known = new Set([...ctx.modeCfg().categories.map((c) => c.id), EMPTY_CLASS.id]);
      let added = 0, skipped = 0;
      for (const s of data.samples || []) {
        if (!known.has(s.categoryId)) { skipped++; continue; }
        const embedding = b64.dec(s.embedding);
        if (embedding.length !== 1280) { skipped++; continue; }
        await store.put('samples', { id: s.id || store.uid(), mode: ctx.mode, categoryId: s.categoryId, extractor: EXTRACTOR_ID, embedding, thumb: s.thumb, ts: s.ts || Date.now(), source: 'import' });
        added++;
      }
      toast(`Imported ${added} photo${added === 1 ? '' : 's'}${skipped ? `; ${skipped} skipped (unknown category)` : ''}.`, skipped ? 'warn' : 'ok');
      await afterChange();
    } catch (err) {
      toast(err.message.startsWith('Unexpected') ? 'That file could not be read.' : err.message, 'error');
    }
  }
}

export function render(container, appCtx) {
  el = container;
  ctx = appCtx;
  el.onclick = onClick;
  el.onchange = onChange;
  draw();
}

export function unmount() {
  const v = el && $('#train-video', el);
  if (v) v.srcObject = null;
}
