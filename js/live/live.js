/* =========================================================
   SMARTSORT, LIVE DETECTION
   Classifies the camera feed continuously and draws the result over
   the video. Two layouts:
     hand-held        one item held up to the camera; the centre of the
                      frame is classified (as in WasteDetector). Space
                      records the item through the normal confirm flow;
                      optionally stable results are recorded on their own.
     table/conveyor   fixed camera over a plain surface. Every item is
                      found against the learned empty background, tracked,
                      decided once, recorded as "auto", and sent to the
                      machine link with its position.
   A result is only acted on when its averaged scores pass the mode's
   thresholds after `stableFrames` frames; otherwise it is shown as
   uncertain and (table layout) routed to manual inspection.
   ========================================================= */
import * as camera from '../camera.js';
import * as engines from '../engines/index.js';
import * as machine from './machine.js';
import { decide } from '../decision.js';
import { makeRecord } from '../records.js';
import { ObjectFinder } from './foreground.js';
import { Tracker } from './tracker.js';
import { MANUAL } from '../config.js';
import { esc, $, icon, categoryMark, binGraphic, fmtPct, fmtTime, toast } from '../ui.js';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

let ctx = null;
let hooks = null;
let running = false;
let layout = lsGet('smartsort.liveLayout') === 'table' ? 'table' : 'handheld';
const finder = new ObjectFinder();
const tracker = new Tracker();
let fps = 0;
let lastPanel = 0;
let warning = null;
let error = null;
const feed = [];

export const isOn = () => running;
export const getLayout = () => layout;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function init(appCtx, appHooks) {
  ctx = appCtx;
  hooks = appHooks;
  machine.onChange(() => { if (running && layout === 'table') renderPanel(true); });
}

export function start() {
  if (running) return;
  if (ctx.modeCfg().engine === 'cloud') { toast('Live detection needs a local engine. The cloud engine is too slow and sends every frame off the device.', 'warn'); return false; }
  running = true;
  error = null;
  tracker.reset();
  syncUi();
  loop();
  return true;
}

export function stop() {
  running = false;
  tracker.reset();
  clearOverlay();
  syncUi();
}

export function reset() { tracker.reset(); feed.length = 0; error = null; if (ctx) syncUi(); }

export function setLayout(l) {
  layout = l === 'table' ? 'table' : 'handheld';
  lsSet('smartsort.liveLayout', layout);
  tracker.reset();
  syncUi();
  if (running) renderPanel(true);
}

export async function learnBackground() {
  const video = hooks.video();
  if (!camera.isActive() || !video.videoWidth) { toast('Start the camera first.', 'warn'); return; }
  toast('Learning the empty background… keep the surface clear.');
  await finder.learn(video);
  tracker.reset();
  warning = null;
  toast('Background learned. Place items on the surface.', 'ok');
  renderPanel(true);
}

const isVision = () => engines.effective(ctx.mode, ctx.settings) === 'vision';
const sceneLayout = () => layout === 'table' || isVision();

export function syncUi() {
  const vp = $('#viewport');
  vp.dataset.live = running ? 'on' : 'off';
  vp.dataset.layout = layout;
  vp.dataset.engine = ctx.modeCfg().engine;
  $('#live-toggle').checked = running;
  for (const b of document.querySelectorAll('#live-layout [data-layout]')) b.setAttribute('aria-checked', String(b.dataset.layout === layout));
  $('#btn-learn-bg').hidden = layout !== 'table';
  $('#live-stats').textContent = '';
  if (!running) hooks.renderIdle();
}

/* ---------- Loop ---------- */
async function loop() {
  while (running) {
    const video = hooks.video();
    if (hooks.isPaused() || !camera.isActive() || !video.videoWidth) {
      clearOverlay();
      await sleep(200);
      continue;
    }
    const t0 = performance.now();
    try {
      await step(video);
      error = null;
    } catch (e) {
      if (e.offline) {
        // The AI computer went away: carry on with the built-in model.
        engines.markVisionDown(ctx.mode, e.message);
        tracker.reset();
        hooks.engineChanged?.();
        continue;
      }
      console.error('[smartsort] live', e);
      error = e.message;
      renderPanel(true);
      await sleep(1500);
    }
    const dt = Math.max(1, performance.now() - t0);
    fps = fps ? fps * 0.85 + (1000 / dt) * 0.15 : 1000 / dt;
    await nextFrame();
  }
}

/* Square crop around a detected box, with some margin, so the model
   sees the whole item roughly centred, as in its training photos. */
function cropAround(frame, b) {
  const fw = frame.width, fh = frame.height;
  const side = Math.min(Math.max(b.w * fw, b.h * fh) * 1.25, Math.min(fw, fh));
  const cx = (b.x + b.w / 2) * fw, cy = (b.y + b.h / 2) * fh;
  const x = Math.min(Math.max(0, cx - side / 2), fw - side);
  const y = Math.min(Math.max(0, cy - side / 2), fh - side);
  const c = document.createElement('canvas');
  c.width = c.height = 320;
  c.getContext('2d').drawImage(frame, x, y, side, side, 0, 0, 320, 320);
  return c;
}

async function classifyCrop(mode, crop) {
  return engines.classify(mode, ctx.settings, { full: crop, crop224: camera.squareCrop(crop, 224) }, (id) => ctx.labelOf(id, mode));
}

async function step(video) {
  const mode = ctx.mode;
  const cfg = ctx.modeCfg();
  const L = ctx.settings.live;
  if (cfg.engine === 'cloud') { stop(); toast('Live detection stopped: the cloud engine is selected for this mode.', 'warn'); return; }
  const frame = camera.captureFrame(video);
  if (isVision()) return visionStep(video, frame, mode, cfg, L);
  const dets = [];

  if (layout === 'table') {
    if (!finder.hasBackground) { tracker.reset(); draw(video); renderPanel(); await sleep(150); return; }
    const { boxes, coverage } = finder.detect(video, L);
    warning = coverage > 0.6 ? 'Most of the view differs from the learned background. If the camera moved or the light changed, clear the surface and learn the background again.' : null;
    for (const b of boxes.slice(0, L.maxItems)) {
      const crop = cropAround(frame, b);
      dets.push({ box: b, out: await classifyCrop(mode, crop), crop });
    }
  } else {
    const side = Math.min(frame.width, frame.height);
    const box = { x: (frame.width - side) / 2 / frame.width, y: (frame.height - side) / 2 / frame.height, w: side / frame.width, h: side / frame.height, cx: 0.5, cy: 0.5 };
    const crop = camera.squareCrop(frame, 320);
    dets.push({ box, out: await classifyCrop(mode, crop), crop });
  }
  if (mode !== ctx.mode) return; // mode switched while classifying

  const gone = tracker.update(dets);
  // An item that leaves (e.g. on a conveyor) before a decision was seen
  // long enough to judge: route it to manual rather than lose it.
  if (layout === 'table') for (const t of gone) if (!t.decided && t.hits >= L.stableFrames) await finalize(t, decide(Tracker.smoothed(t), cfg, null), mode);

  for (const t of tracker.tracks) await evaluate(t, cfg, L, mode);
  draw(video);
  $('#live-stats').textContent = `${fps.toFixed(0)} fps${layout === 'table' ? ` · ${tracker.tracks.length} item${tracker.tracks.length === 1 ? '' : 's'} in view` : ''}`;
  renderPanel();
}

/* Vision AI: one scan names and boxes every item in the frame, so no
   background is needed in either layout. A scan takes about a second,
   so an item is decided after `stableScans` scans in a row agree. */
async function visionStep(video, frame, mode, cfg, L) {
  if (!fps) $('#live-stats').textContent = 'Scanning\u2026 (the first scan also loads the model)';
  let { items, model } = await engines.vision.scan(frame, ctx.settings);
  if (mode !== ctx.mode || !running) return;
  // Table layout with a learned background: only trust items standing on
  // something that differs from the empty surface (the model can mistake
  // a textured, empty belt for a bag or film).
  if (layout === 'table' && finder.hasBackground) {
    const { boxes } = finder.detect(video, L);
    items = items.filter((it) => it.person || boxes.some((b) => overlap(it.box, b) >= 0.25));
  }
  const dets = items.map((it) => ({ box: it.box, label: it.name.toLowerCase(), group: it.category, out: engines.vision.itemResult(it, mode, cfg, model), crop: cropAround(frame, it.box) }));
  // Each scan is a full picture of the scene: an item missing from one
  // scan is no longer drawn, and is dropped after a second miss.
  const gone = tracker.update(dets, { maxMisses: 1 });
  const scans = Math.max(1, ctx.settings.vision.stableScans || 2);
  const VL = { ...L, stableFrames: scans, maxFrames: scans + 4 };
  if (layout === 'table') {
    for (const t of gone) if (!t.decided && !t.last?.item?.person && t.hits >= scans) await finalize(t, decide(Tracker.smoothed(t), cfg, null), mode);
  }
  for (const t of tracker.tracks) await evaluate(t, cfg, VL, mode);
  draw(video);
  $('#live-stats').textContent = `${fps.toFixed(1)} scans/s \u00b7 ${items.length} thing${items.length === 1 ? '' : 's'} in view`;
  renderPanel();
}

/* Share of box a covered by box b. */
function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / (a.w * a.h || 1);
}

async function evaluate(t, cfg, L, mode) {
  const d = decide(Tracker.smoothed(t), cfg, null);
  t.view = d;
  if (t.decided) {
    if (isVision()) {
      // A different item now sits where this one was: decide afresh.
      const changed = t.last?.qualitative === 'high' && d.predicted && d.predicted !== t.decided.predicted;
      t.changeCount = changed ? (t.changeCount || 0) + 1 : 0;
      if (t.changeCount >= 2) { t.decided = null; t.hits = 1; t.changeCount = 0; }
      return;
    }
    // Hand-held: the same track persists, so start a new one when a
    // different item appears (answer changes or the picture changes).
    if (layout === 'handheld') {
      const changed = camera.hashDistance(t.lockHash, camera.averageHash(t.crop)) > 14;
      t.changeCount = d.predicted !== t.decided.predicted || changed ? (t.changeCount || 0) + 1 : 0;
      if (t.changeCount >= 3) tracker.reset();
    }
    return;
  }
  if (t.hits < L.stableFrames || d.state === 'noitem') return;
  if (d.state === 'confident') await finalize(t, d, mode);
  else if (layout === 'table' && t.hits >= L.maxFrames) await finalize(t, d, mode);
}

async function finalize(t, d, mode) {
  t.decided = d;
  t.lockHash = camera.averageHash(t.crop);
  const L = ctx.settings.live;
  if (layout === 'handheld' && !L.autoRecordHandheld) return;
  const finalCat = d.state === 'confident' ? ctx.category(d.predicted, mode) : null;
  const thumb = camera.toJpeg(t.crop, 240, 0.75);
  const item = t.last?.item;
  const rec = makeRecord(ctx, {
    mode, d, status: 'auto', finalCat, source: `live-${layout}`,
    extra: {
      position: { x: t.box.x, y: t.box.y, w: t.box.w, h: t.box.h, cx: t.box.cx, cy: t.box.cy },
      trackId: t.id,
      ...(item ? { itemName: item.name, material: item.material } : {}),
    },
  });
  await ctx.addRecord(rec, ctx.settings.storeThumbnails ? thumb : null);
  feed.unshift({ rec, thumb });
  feed.length = Math.min(feed.length, 12);
  hooks.onRecorded(rec);
  if (layout === 'table' && (finalCat || ctx.settings.machine.sendUncertain)) {
    machine.send({
      type: finalCat ? 'sort' : 'manual',
      id: rec.id,
      track: t.id,
      mode,
      category: finalCat ? finalCat.id : MANUAL.id,
      ...(item ? { item: item.name, material: item.material } : {}),
      bin: rec.binName,
      confidence: d.confidence == null ? null : Math.round(d.confidence * 1000) / 1000,
      x: round(t.box.cx), y: round(t.box.cy), w: round(t.box.w), h: round(t.box.h),
    });
  }
  renderPanel(true);
}

const round = (v) => Math.round(v * 1000) / 1000;

/* ---------- Overlay ---------- */
function overlay() { return $('#overlay'); }

function clearOverlay() {
  const c = overlay();
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
}

function draw(video) {
  const c = overlay();
  const cw = c.clientWidth, ch = c.clientHeight, dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) { c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr); }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cw, ch);
  // Map frame coordinates to the screen under object-fit: cover.
  const vw = video.videoWidth, vh = video.videoHeight;
  const s = Math.max(cw / vw, ch / vh);
  const ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
  const X = (x) => ox + x * vw * s, Y = (y) => oy + y * vh * s;

  const scene = sceneLayout();
  const vision = isVision();
  const placed = [];
  const tracks = visibleTracks();
  tracks.forEach((t, i) => {
    const item = t.last?.item;
    const d = t.decided || t.view;
    const confident = t.decided && d.state === 'confident';
    const cat = d.predicted ? ctx.category(d.predicted) : null;
    const color = item?.person ? '#9FB3AC' : confident ? cat?.color || '#1C6FB8' : t.decided ? '#E0A100' : '#FFFFFF';
    const bx = X(t.box.x), by = Y(t.box.y), bw = t.box.w * vw * s, bh = t.box.h * vh * s;
    if (scene) {
      g.lineWidth = item?.person ? 1.5 : 2.5;
      g.strokeStyle = color;
      g.globalAlpha = t.decided || item?.person ? 1 : 0.75;
      g.setLineDash(t.decided || item?.person ? [] : [6, 5]);
      g.beginPath(); g.roundRect(bx, by, bw, bh, 6); g.stroke();
      g.setLineDash([]);
      g.globalAlpha = 1;
      if (layout === 'table') { // centre point, where a machine would pick
        const cx = X(t.box.cx), cy = Y(t.box.cy);
        g.beginPath(); g.moveTo(cx - 6, cy); g.lineTo(cx + 6, cy); g.moveTo(cx, cy - 6); g.lineTo(cx, cy + 6); g.stroke();
      }
    }
    if (vision) { drawTag(g, t, i + 1, { bx, by, bw, cw, color, confident, cat, item, d, placed }); return; }
    const conf = d.confidence != null ? ` ${fmtPct(d.confidence)}` : '';
    const what = item && !item.person ? `${item.name} \u00b7 ` : '';
    const text = item?.person ? 'Person \u00b7 not waste'
      : d.state === 'noitem' ? 'No item'
      : confident ? `\u2713 ${what}${cat?.label || ''}${conf}`
      : t.decided ? `? ${what}manual inspection`
      : `${what}${cat?.label || '\u2026'}${conf}`;
    g.font = '700 15px Montserrat, "Segoe UI", sans-serif';
    const tw = g.measureText(text).width + 16;
    const lx = scene ? Math.min(Math.max(0, bx), cw - tw) : (cw - tw) / 2;
    const ly = scene ? Math.max(0, by - 28) : 12;
    g.fillStyle = 'rgba(0,51,42,0.88)';
    g.beginPath(); g.roundRect(lx, ly, tw, 26, 6); g.fill();
    g.fillStyle = confident ? color : '#FFFFFF';
    g.fillRect(lx, ly + 22, tw, 4);
    g.fillStyle = '#FFFFFF';
    g.fillText(text, lx + 8, ly + 18);
  });
}

/* Tracks seen in the latest scan, largest first, at most 6 (people last). */
function visibleTracks() {
  const vis = tracker.tracks.filter((t) => t.view && (!isVision() || t.misses === 0));
  if (!isVision()) return vis;
  const size = (t) => (t.last?.item?.person ? -1 : t.box.w * t.box.h);
  return vis.sort((a, b) => size(b) - size(a)).slice(0, 6);
}

/* Vision AI tag: a numbered badge always; the name and category beside it
   only where that does not cover another tag. The list next to the video
   uses the same numbers. */
function drawTag(g, t, n, { bx, by, bw, cw, color, confident, cat, item, d, placed }) {
  const r = 11;
  const cx = Math.min(Math.max(bx + r + 4, r + 2), cw - r - 2), cy = Math.max(by + r + 4, r + 2);
  g.fillStyle = item?.person ? '#5E6B66' : confident ? color : 'rgba(0,51,42,0.9)';
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#FFFFFF';
  g.font = '800 12px Montserrat, "Segoe UI", sans-serif';
  g.textAlign = 'center';
  g.fillText(String(n), cx, cy + 4);
  g.textAlign = 'left';
  placed.push({ x: cx - r, y: cy - r, w: r * 2, h: r * 2 });

  const name = item?.person ? 'Person' : item ? item.name : cat?.label || '';
  const text = item?.person ? 'Person \u00b7 not waste' : `${confident ? '\u2713 ' : ''}${name}${cat && !item?.person ? ` \u00b7 ${d.state === 'confident' || !t.decided ? cat.label : 'check'}` : ''}`;
  g.font = '700 13px Montserrat, "Segoe UI", sans-serif';
  const tw = Math.min(g.measureText(text).width + 12, Math.max(60, bw - r * 2 - 8));
  const box = { x: cx + r + 4, y: cy - 11, w: tw, h: 22 };
  if (box.x + box.w > cw) return;
  if (placed.some((p) => box.x < p.x + p.w && p.x < box.x + box.w && box.y < p.y + p.h && p.y < box.y + box.h)) return;
  placed.push(box);
  g.fillStyle = 'rgba(0,51,42,0.85)';
  g.beginPath(); g.roundRect(box.x, box.y, box.w, box.h, 5); g.fill();
  g.save();
  g.beginPath(); g.rect(box.x, box.y, box.w - 4, box.h); g.clip();
  g.fillStyle = '#FFFFFF';
  g.fillText(text, box.x + 6, box.y + 15);
  g.restore();
}

/* ---------- Result panel while live ---------- */
function feedHtml() {
  if (!feed.length) return '';
  return `
    <h3 class="live-h">Recorded automatically</h3>
    <ul class="live-feed">
      ${feed.map(({ rec, thumb }) => {
        const cats = ctx.modeCfg(rec.mode).categories.filter((c) => c.enabled !== false);
        const current = ctx.records.find((r) => r.id === rec.id) || rec;
        return `<li>
          <img src="${thumb}" alt="">
          <div><b>${esc(current.itemName ? `${current.itemName} \u2192 ` : '')}${esc(current.finalLabel || 'Manual inspection')}</b>${current.confidence != null ? ` <span class="text-muted">${fmtPct(current.confidence)}</span>` : ''}<br>
          <span class="small text-muted">${esc(current.binName)} · ${fmtTime(current.ts)}</span></div>
          ${current.status === 'auto' ? `<label class="verify"><span class="visually-hidden">Verify</span><select data-verify="${esc(rec.id)}">
            <option value="">Verify…</option>
            ${cats.map((c) => `<option value="${esc(c.id)}">${c.id === rec.final ? '✓ ' : ''}${esc(c.label)}</option>`).join('')}
            <option value="manual">Manual inspection</option>
          </select></label>` : `<span class="tag tag-${current.status}">${{ confirmed: 'Verified', corrected: 'Corrected', manual: 'Manual' }[current.status]}</span>`}
        </li>`;
      }).join('')}
    </ul>`;
}

function machineLine() {
  const m = machine.status();
  if (m.transport === 'none') return `<p class="small text-muted machine-line">${icon('layers')} No machine connected. Sort commands are shown here and in Settings › Machine link.</p>`;
  return `<p class="small machine-line ${m.connected ? '' : 'text-warn'}">${icon('layers')} ${m.transport === 'serial' ? 'USB serial' : 'WebSocket'}: ${m.connected ? `connected · ${m.sent} command${m.sent === 1 ? '' : 's'} sent` : esc(m.error || 'not connected')}</p>`;
}

export function renderPanel(force = false) {
  if (!running || hooks.isPaused()) return;
  const now = performance.now();
  if (!force && now - lastPanel < 250) return;
  lastPanel = now;
  const panel = hooks.panel();
  if (panel.contains(document.activeElement) && document.activeElement.tagName === 'SELECT') return; // operator is choosing
  const cfg = ctx.modeCfg();
  let body;

  if (error) {
    body = `<div class="reasons"><p class="reasons-title">Live detection problem</p><p>${esc(error)}</p></div>`;
  } else if (sceneLayout()) {
    if (!isVision() && !finder.hasBackground) {
      body = `<div class="result-idle">${icon('layers', 'ico-xl')}<h2>Learn the empty surface first</h2>
        <p class="text-muted">Point the camera straight down at the table or conveyor, clear it completely, then press <b>Learn empty background</b>. Items placed on it afterwards are found and sorted one by one.</p></div>`;
    } else {
      const rows = visibleTracks().map((t, i) => {
        const num = isVision() ? `<span class="num-badge">${i + 1}</span>` : '';
        const d = t.decided || t.view;
        const item = t.last?.item;
        if (item?.person) return `<li>${num}<span class="cat-mark cat-mark-sm is-none">${icon('user')}</span><span><b>Person</b> <span class="text-muted">not waste, ignored</span></span></li>`;
        const cat = d.predicted ? ctx.category(d.predicted) : null;
        const state = t.decided ? (d.state === 'confident' ? `<span class="tag tag-ok">${icon('check')} ${esc(cat.bin)}</span>` : '<span class="tag tag-warn">manual inspection</span>') : '<span class="tag">identifying\u2026</span>';
        const conf = d.confidence != null ? fmtPct(d.confidence) : d.qualitative ? `rated ${esc(d.qualitative)}` : '';
        const label = item
          ? `<b>${esc(item.name)}</b> <span class="text-muted">${esc(item.material)}${item.resin ? ` \u00b7 ${esc(item.resin)}` : ''} \u2192 ${esc(cat?.label || '')}</span>`
          : `<b>${esc(cat?.label || '\u2026')}</b>`;
        return `<li>${num}${categoryMark(t.decided && d.state !== 'confident' ? null : cat, 'sm')}<span>${label} <span class="small text-muted">${conf}</span></span>${state}</li>`;
      });
      body = `
        <span class="status-pill status-ok">${icon('play')} Live: ${isVision() ? 'Vision AI scene scan' : 'table / conveyor'}</span>
        <h3 class="live-h">In view now (${rows.length})</h3>
        ${rows.length ? `<ul class="live-items">${rows.join('')}</ul>` : '<p class="text-muted">No items on the surface.</p>'}
        ${warning ? `<p class="dup-warning">${icon('alert')} ${esc(warning)}</p>` : ''}
        ${layout === 'table' ? machineLine() : `<label class="check live-auto"><input type="checkbox" id="live-auto" ${ctx.settings.live.autoRecordHandheld ? 'checked' : ''}> Record each new item automatically</label>`}`;
    }
  } else {
    const t = tracker.tracks[0];
    const d = t?.decided || t?.view;
    if (!d) {
      body = `<div class="result-idle"><div class="spinner" aria-hidden="true"></div><h2>Watching…</h2><p class="text-muted">Hold one item inside the square.</p></div>`;
    } else {
      const cat = d.predicted ? ctx.category(d.predicted) : null;
      const stable = !!t.decided && d.state === 'confident';
      const pill = stable ? ['status-ok', 'checkCircle', 'Stable result'] : d.state === 'confident' ? ['status-none', 'refresh', 'Settling…'] : ['status-warn', 'alert', 'Uncertain'];
      body = `
        <span class="status-pill ${pill[0]}">${icon(pill[1])} ${pill[2]}</span>
        <h2 class="result-title">${categoryMark(cat, 'lg')}<span>${esc(cat?.label || 'Unknown')}</span></h2>
        ${d.confidence != null ? `<div class="conf" data-ok="${d.state === 'confident'}">
          <div class="conf-row"><span>Confidence (averaged over recent frames)</span><b>${fmtPct(d.confidence)}</b></div>
          <div class="conf-track"><div class="conf-fill" style="width:${Math.round(d.confidence * 100)}%"></div><div class="conf-tick" style="left:${Math.round(cfg.minConfidence * 100)}%"></div></div></div>` : ''}
        ${stable ? `<div class="destination" style="--cat:${esc(cat.color)}">${binGraphic(cat)}<div><p class="eyebrow">Recommended destination</p><p class="dest-bin">${esc(cat.bin)}</p><p class="dest-instr">${esc(cat.instruction)}</p></div></div>`
          : d.reasons.length ? `<p class="small text-muted">${esc(d.reasons[0])}</p>` : ''}
        <p class="small text-muted">${ctx.settings.live.autoRecordHandheld ? 'Stable results are recorded automatically (unverified).' : 'Press <b>Capture</b> (Space) to record this item and confirm it.'}</p>
        ${engines.effective(ctx.mode, ctx.settings) === 'waste' ? '<p class="small text-muted">The waste model always names the closest of its five types, even when no item is held up. Read results only while an item fills the square.</p>' : ''}`;
    }
    body += `<label class="check live-auto"><input type="checkbox" id="live-auto" ${ctx.settings.live.autoRecordHandheld ? 'checked' : ''}> Record stable results automatically</label>`;
  }
  panel.innerHTML = `<div class="live-panel">${body}${feedHtml()}</div>`;
}

/* Feed and panel events (delegated by app.js). */
export async function onPanelChange(e) {
  if (e.target.id === 'live-auto') {
    ctx.settings.live.autoRecordHandheld = e.target.checked;
    ctx.save();
    renderPanel(true);
    return true;
  }
  const id = e.target.dataset.verify;
  if (!id || !e.target.value) return false;
  const rec = ctx.records.find((r) => r.id === id);
  if (!rec) return true;
  const val = e.target.value;
  const cat = val === 'manual' ? null : ctx.category(val, rec.mode);
  await ctx.updateRecord({
    ...rec,
    status: val === 'manual' ? 'manual' : val === rec.predicted ? 'confirmed' : 'corrected',
    final: cat ? cat.id : null,
    finalLabel: cat?.label || null,
    binName: cat ? cat.bin : MANUAL.bin,
    recyclable: !!cat?.recyclable,
  });
  e.target.blur();
  renderPanel(true);
  toast('Verified.', 'ok');
  return true;
}
