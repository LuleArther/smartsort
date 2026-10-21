/* =========================================================
   SMARTSORT, APP
   Wires the Sort screen (capture > identify > record), the session
   counters, mode switching, engine status and keyboard shortcuts.
   The other tabs live in js/views/ and share the `ctx` object.
   ========================================================= */
import { loadSettings, saveSettings, MODES, ENGINES, MANUAL } from './config.js';
import * as store from './store.js';
import * as camera from './camera.js';
import * as engines from './engines/index.js';
import { addSample, NotReadyError } from './engines/knn.js';
import { decide } from './decision.js';
import { computeStats, makeRecord } from './records.js';
import * as live from './live/live.js';
import { esc, $, $$, icon, categoryMark, binGraphic, toast, fmtPct, fmtKg, fmtMs, fmtTime, parseKg, initTooltips } from './ui.js';
import * as dashboardView from './views/dashboard.js';
import * as historyView from './views/history.js';
import * as trainView from './views/train.js';
import * as settingsView from './views/settings.js';

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

const VIEWS = { dashboard: dashboardView, history: historyView, train: trainView, settings: settingsView };

/* ---------- Shared state ---------- */
export const ctx = {
  settings: loadSettings(),
  mode: MODES[lsGet('smartsort.mode')] ? lsGet('smartsort.mode') : 'general',
  view: 'sort',
  session: null,
  records: [],
  modeCfg(mode = ctx.mode) { return ctx.settings.modes[mode]; },
  category(id, mode = ctx.mode) {
    if (id == null || id === MANUAL.id) return MANUAL;
    return ctx.modeCfg(mode).categories.find((c) => c.id === id) || null;
  },
  labelOf(id, mode = ctx.mode) {
    if (id === '_empty') return 'No item';
    return ctx.category(id, mode)?.label || id;
  },
  save() {
    if (!saveSettings(ctx.settings)) toast('Settings could not be saved in this browser. They will reset on reload.', 'warn');
  },
  refreshEngine: () => refreshEngine(),
  rerenderSession: () => renderSession(),
  async addRecord(rec, thumb) {
    await store.put('records', rec);
    if (thumb) await store.put('thumbs', { id: rec.id, dataUrl: thumb });
    ctx.records.push(rec);
  },
  async updateRecord(rec) {
    await store.put('records', rec);
    const i = ctx.records.findIndex((r) => r.id === rec.id);
    if (i >= 0) ctx.records[i] = rec;
    renderSession();
  },
  async deleteRecord(id) {
    await store.del('records', id);
    await store.del('thumbs', id);
    ctx.records = ctx.records.filter((r) => r.id !== id);
    renderSession();
  },
  async clearRecords() {
    await store.clear('records');
    await store.clear('thumbs');
    ctx.records = [];
    renderSession();
  },
};

/* ---------- Engine status ---------- */
let engineToken = 0;
const engineState = { state: 'loading', text: '', error: null, notReady: null };

function setChip(state, text) {
  const chip = $('#engine-chip');
  chip.dataset.state = state;
  $('#engine-text').textContent = text;
  $('#engine-retry').hidden = state !== 'error';
  Object.assign(engineState, { state, text });
}

async function refreshEngine() {
  const mode = ctx.mode;
  const cfg = ctx.modeCfg();
  const eng = ENGINES[cfg.engine];
  const token = ++engineToken;
  engineState.error = null;
  engineState.notReady = null;
  engineState.fallback = null;
  setChip('loading', `${eng.short}: loading…`);
  renderBanners();
  try {
    const r = await engines.prepare(mode, ctx.settings);
    if (token !== engineToken) return;
    if (r.fallback) {
      engineState.fallback = r.fallback;
      setChip('warn', `${ENGINES[engines.effective(mode, ctx.settings)].short} \u00b7 Vision AI offline`);
    } else if (!r.ready) { engineState.notReady = r.message; setChip('warn', `${eng.short}: not trained`); }
    else if (cfg.engine === 'cloud') setChip(navigator.onLine ? 'ready' : 'error', navigator.onLine ? 'Cloud AI · online' : 'Cloud AI · offline');
    else setChip('ready', `${eng.short} · ready`);
  } catch (e) {
    if (token !== engineToken) return;
    console.error('[smartsort] engine', e);
    engineState.error = e.message;
    setChip('error', `${eng.short}: failed to load`);
  }
  renderBanners();
}

/* ---------- Banners ---------- */
const dismissed = new Set();
function renderBanners() {
  const cfg = ctx.modeCfg();
  const list = [];
  if (!store.persistent) list.push({ id: 'storage', kind: 'warn', text: 'This browser is blocking local storage (private window?). Records and training photos will be lost when the page is closed.' });
  if (!window.isSecureContext) list.push({ id: 'insecure', kind: 'warn', text: 'The live camera only works over https:// or on localhost. Upload image still works.' });
  if (engineState.error) list.push({ id: 'engine-error', kind: 'error', text: `${engineState.error} Check the connection and press Retry, or choose another engine in Settings.`, sticky: true });
  if (engineState.fallback) list.push({ id: 'vision-down', kind: 'warn', text: `Vision AI is not available, so the ${ENGINES[engines.effective(ctx.mode, ctx.settings)].short.toLowerCase()} is used instead. ${engineState.fallback} SmartSort retries every 30 seconds.`, sticky: true });
  if (engineState.notReady) list.push({ id: 'not-ready', kind: 'warn', text: engineState.notReady, action: { label: 'Open Train', view: 'train' }, sticky: true });
  if (cfg.engine === 'baseline' && ctx.mode === 'plastic') list.push({ id: 'baseline-plastic', kind: 'info', text: 'The baseline model recognises object types, not polymers, so most plastic-type results will be flagged uncertain. For real plastic sorting, train the local model with your own PET, HDPE, PP and LDPE items.', action: { label: 'Open Train', view: 'train' } });
  if (!IS_LOCAL && cfg.engine !== 'vision') list.push({ id: 'vision-hint', kind: 'info', text: 'Using the built-in waste model in this browser. On the station computer with Ollama, open Settings \u203a Vision AI \u203a "Use this computer\u2019s Ollama" (or this page with ?station) to identify every material, plastic types and people.', action: { label: 'Open Settings', view: 'settings' } });
  if (cfg.engine === 'cloud') list.push({ id: 'cloud-privacy', kind: 'info', text: 'Cloud AI is on for this mode: each captured photo is sent to the Luther Sort server and an external AI service to be identified. Photos are not stored by SmartSort’s server.' });
  if (cfg.engine === 'cloud' && !navigator.onLine) list.push({ id: 'offline', kind: 'error', text: 'No internet connection, so the cloud engine cannot work. Switch to a local engine in Settings.', sticky: true });

  $('#banners').innerHTML = list.filter((b) => b.sticky || !dismissed.has(b.id)).map((b) => `
    <div class="banner banner-${b.kind}" data-id="${b.id}">
      ${icon(b.kind === 'info' ? 'layers' : 'alert')}
      <p>${esc(b.text)}</p>
      ${b.action ? `<button type="button" class="link-btn" data-goto="${b.action.view}">${esc(b.action.label)}</button>` : ''}
      ${b.sticky ? '' : `<button type="button" class="icon-btn" data-dismiss="${b.id}" aria-label="Dismiss">${icon('x')}</button>`}
    </div>`).join('');
}

/* ---------- Navigation and modes ---------- */
function go(view) {
  if (!VIEWS[view] && view !== 'sort') view = 'sort';
  if (ctx.view !== view) VIEWS[ctx.view]?.unmount?.();
  ctx.view = view;
  $$('.tabs button').forEach((b) => (b.dataset.view === view ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')));
  for (const v of $$('.view')) v.hidden = v.id !== `view-${view}`;
  if (VIEWS[view]) VIEWS[view].render($(`#view-${view}`), ctx);
  if (view === 'sort') { live.syncUi(); renderSession(); if (!pending) renderIdle(); }
}

function setMode(mode) {
  if (!MODES[mode] || mode === ctx.mode) return;
  if (pending) { pending = null; toast('Unrecorded result discarded because the mode changed.', 'warn'); }
  live.reset();
  ctx.mode = mode;
  lsSet('smartsort.mode', mode);
  $$('#mode-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === mode)));
  document.body.dataset.mode = mode;
  refreshEngine();
  if (ctx.view === 'sort') { renderIdle(); renderSession(); } else VIEWS[ctx.view]?.render($(`#view-${ctx.view}`), ctx);
}

/* ---------- Camera ---------- */
const video = () => $('#video');

function showCameraMessage(iconName, text) {
  $('#camera-msg').hidden = false;
  $('#camera-msg-icon').innerHTML = icon(iconName);
  $('#camera-msg-text').textContent = text;
}

camera.onStreamChange(async (stream) => {
  const active = camera.isActive();
  video().srcObject = active ? stream : null;
  $('#camera-msg').hidden = active;
  if (!active) showCameraMessage('cameraOff', 'The camera is off. Press Start camera, or upload an image.');
  $('#btn-camera').innerHTML = active ? `${icon('stop')} <span>Stop camera</span>` : `${icon('play')} <span>Start camera</span>`;
  updateCaptureButton();
  if (active) {
    const cams = await camera.listCameras();
    const sel = $('#camera-select');
    const current = camera.activeDeviceId();
    sel.innerHTML = cams.map((c, i) => `<option value="${esc(c.deviceId)}" ${c.deviceId === current ? 'selected' : ''}>${esc(c.label || `Camera ${i + 1}`)}</option>`).join('');
    $('.camera-select-wrap').hidden = cams.length < 2;
  }
});

async function startCamera(deviceId = lsGet('smartsort.cameraId')) {
  showCameraMessage('camera', 'Starting camera…');
  try {
    await camera.start(deviceId || null);
    lsSet('smartsort.camera', 'on');
    if (lsGet('smartsort.live') !== 'off' && !live.isOn()) live.start();
  } catch (e) {
    if (deviceId && e.code === 'unavailable') return startCamera(null); // remembered camera unplugged
    showCameraMessage('cameraOff', e.message);
    toast(e.message, 'error');
  }
}

function updateCaptureButton() {
  $('#btn-capture').disabled = !camera.isActive() || busy;
}

/* ---------- Sort flow ---------- */
let pending = null; // the result on screen that has not been recorded yet
let holdUntil = 0;
let busy = false;
let lastRecorded = null;

function duplicateOf(hash) {
  const windowMs = (ctx.settings.duplicateWindowSec || 0) * 1000;
  if (!windowMs) return null;
  const recent = ctx.records.filter((r) => r.hash && r.ts > Date.now() - windowMs).sort((a, b) => b.ts - a.ts)[0];
  if (recent && camera.hashDistance(recent.hash, hash) <= 5) return { id: recent.id, ago: Math.round((Date.now() - recent.ts) / 1000) };
  return null;
}

async function captureFromCamera() {
  if (!camera.isActive()) return;
  let canvas;
  try { canvas = camera.captureFrame(video()); } catch (e) { toast(e.message, 'warn'); return; }
  const flash = $('#flash');
  flash.classList.remove('go'); void flash.offsetWidth; flash.classList.add('go');
  analyse(canvas, 'camera');
}

async function analyse(canvas, source) {
  if (busy) return;
  if (pending) { toast('Record or discard the current result first.', 'warn'); $('[data-primary]')?.focus(); return; }
  busy = true;
  holdUntil = 0;
  updateCaptureButton();
  const mode = ctx.mode;
  const thumb = camera.toJpeg(canvas, 360, 0.75);
  renderBusy(thumb);
  const quality = ctx.settings.qualityChecks ? camera.assessQuality(canvas) : { issues: [] };
  const input = { full: canvas, crop224: camera.squareCrop(canvas, 224) };
  const hash = camera.averageHash(canvas);
  const base = { mode, input, quality, hash, source, thumb, ts: Date.now(), dup: duplicateOf(hash) };
  try {
    const out = await engines.classify(mode, ctx.settings, input, (id) => ctx.labelOf(id, mode));
    if (mode !== ctx.mode) return; // mode switched mid-analysis
    pending = { ...base, out, d: decide(out, ctx.modeCfg(mode), quality) };
    renderResult();
  } catch (e) {
    if (mode !== ctx.mode) return;
    console.error('[smartsort] classify', e);
    pending = { ...base, error: e };
    renderError();
  } finally {
    busy = false;
    updateCaptureButton();
    $('#result-panel').setAttribute('aria-busy', 'false');
  }
}

function retryPending() {
  const p = pending;
  if (!p) return;
  pending = null;
  analyse(p.input.full, p.source);
}

function discardPending() {
  if (!pending) return;
  pending = null;
  holdUntil = 0;
  renderIdle();
  toast('Discarded. Nothing was recorded.');
}

async function record(status, finalId = null) {
  const p = pending;
  if (!p) return;
  const mode = p.mode;
  const finalCat = finalId ? ctx.category(finalId, mode) : null;
  const d = p.d || {};
  const wantTraining = $('#add-training')?.checked && finalCat;
  const rec = makeRecord(ctx, {
    mode, d, status, finalCat, source: p.source, error: p.error,
    weightKg: parseKg($('#weight-input')?.value), hash: p.hash, quality: p.quality,
    extra: {
      duplicateOf: p.dup?.id || null,
      ...(p.out?.item ? { itemName: p.out.item.name, material: p.out.item.material } : {}),
    },
  });
  pending = null; // before any await, so a double press cannot record twice
  if (wantTraining) {
    try {
      await addSample(mode, finalCat.id, p.input, 'record');
      rec.addedToTraining = true;
      if (ctx.modeCfg(mode).engine === 'knn') refreshEngine();
    } catch (e) { toast(`Could not add to training set: ${e.message}`, 'error'); }
  }
  try {
    await ctx.addRecord(rec, ctx.settings.storeThumbnails ? p.thumb : null);
  } catch (e) {
    pending = p;
    toast(`Could not save the record: ${e.message}`, 'error');
    return;
  }
  lastRecorded = rec;
  holdUntil = Date.now() + 2500; // let the operator see the summary before live view resumes
  renderRecorded(rec, p.thumb);
  renderSession(rec.final ?? 'manual');
}

/* ---------- Result panel rendering ---------- */
const panel = () => $('#result-panel');

function renderIdle() {
  if (live.isOn()) { live.renderPanel(true); return; }
  const cfg = ctx.modeCfg();
  panel().innerHTML = `
    <div class="result-idle">
      ${icon('search', 'ico-xl')}
      <h2>Ready for the next item</h2>
      <p class="text-muted">${esc(MODES[ctx.mode].long)} using the ${esc(ENGINES[engines.effective(ctx.mode, ctx.settings)].short.toLowerCase())}. Present one item and press <b>Capture</b>, or upload a photo.<span class="kbd-hint"> Shortcut: <kbd>Space</kbd></span></p>
      ${lastRecorded && lastRecorded.mode === ctx.mode ? `<p class="small text-muted">Last recorded at ${fmtTime(lastRecorded.ts)}: ${esc(lastRecorded.finalLabel || 'Manual inspection')}.</p>` : ''}
    </div>`;
}

function renderBusy(thumb) {
  panel().setAttribute('aria-busy', 'true');
  const loading = engineState.state === 'loading';
  panel().innerHTML = `
    <div class="result-busy">
      <div class="result-thumb-wrap"><img class="result-thumb" src="${thumb}" alt="Captured item"><div class="scan" aria-hidden="true"></div></div>
      <div><div class="spinner" aria-hidden="true"></div><p class="state-title">${loading ? 'Loading the model, then identifying…' : 'Identifying…'}</p>
      <p class="text-muted small">${loading ? 'The first run loads the model; later items are faster.' : ''}</p></div>
    </div>`;
}

function renderError() {
  const p = pending;
  const notReady = p.error instanceof NotReadyError;
  panel().innerHTML = `
    <div class="result result-error">
      <div class="result-top">
        <img class="result-thumb" src="${p.thumb}" alt="Captured item">
        <div>
          <span class="status-pill status-none">${icon('alert')} ${notReady ? 'Model not ready' : 'Could not identify'}</span>
          <h2 class="result-title">${notReady ? 'The local model needs training' : 'Something went wrong'}</h2>
          <p>${esc(p.error.message)}</p>
        </div>
      </div>
      ${recordForm({ allowTraining: false })}
      <div class="actions">
        <button type="button" class="btn btn-secondary" data-act="retry" data-primary>${icon('refresh')} Try again <kbd>Enter</kbd></button>
        <button type="button" class="btn btn-outline" data-act="manual">${icon('search')} Send to manual inspection <kbd>M</kbd></button>
        ${notReady ? '<button type="button" class="btn btn-outline" data-goto="train">Open Train</button>' : ''}
        <button type="button" class="btn btn-ghost" data-act="discard">${icon('x')} Discard <kbd>Esc</kbd></button>
      </div>
    </div>`;
}

function confidenceBlock(d, cfg) {
  if (d.confidence == null && d.qualitative) {
    return `<p class="conf-qual">AI self-rating: <b>${esc(d.qualitative)}</b> <span class="text-muted small">(not a measured probability; only "high" is accepted)</span></p>`;
  }
  if (d.confidence == null) return '';
  const ok = d.state === 'confident';
  return `
    <div class="conf" data-ok="${ok}">
      <div class="conf-row"><span>Confidence</span><b>${fmtPct(d.confidence)}</b></div>
      <div class="conf-track" role="img" aria-label="Confidence ${fmtPct(d.confidence)}, required ${fmtPct(cfg.minConfidence)}">
        <div class="conf-fill" style="width:${Math.round(d.confidence * 100)}%"></div>
        <div class="conf-tick" style="left:${Math.round(cfg.minConfidence * 100)}%" title="Required: ${fmtPct(cfg.minConfidence)}"></div>
      </div>
      <p class="small text-muted">Required in this mode: ${fmtPct(cfg.minConfidence)}</p>
    </div>`;
}

function recordForm({ allowTraining = true, trainingChecked = false } = {}) {
  return `
    <div class="record-form">
      <label class="field field-inline">
        <span>${icon('scale')} Weight (kg, optional)</span>
        <input type="text" inputmode="decimal" id="weight-input" placeholder="e.g. 0.45" autocomplete="off">
      </label>
      ${allowTraining ? `<label class="check"><input type="checkbox" id="add-training" ${trainingChecked ? 'checked' : ''}> Add this photo to the training set under the final category</label>` : ''}
    </div>`;
}

function renderResult() {
  const p = pending;
  const d = p.d;
  const cfg = ctx.modeCfg(p.mode);
  const best = d.predicted ? ctx.category(d.predicted, p.mode) : null;
  const dest = d.destination;
  const status = {
    confident: ['status-ok', 'checkCircle', 'Confident result'],
    uncertain: ['status-warn', 'alert', 'Uncertain: manual inspection'],
    noitem: ['status-none', 'minusCircle', 'No item detected'],
  }[d.state];
  const alts = d.alternatives.filter((a) => a.id !== d.predicted);
  const isKnn = cfg.engine === 'knn';

  let title;
  if (d.state === 'confident') title = `${categoryMark(best, 'lg')}<span>${esc(best.label)}</span>`;
  else if (d.state === 'uncertain') title = `${categoryMark(null, 'lg')}<span>Unable to identify this material reliably</span>`;
  else title = `${categoryMark(null, 'lg')}<span>No waste item detected</span>`;

  let actions;
  if (d.state === 'confident') {
    actions = `
      <button type="button" class="btn btn-secondary" data-act="confirm" data-primary>${icon('check')} Confirm ${esc(best.label)} <kbd>Enter</kbd></button>
      <button type="button" class="btn btn-outline" data-act="correct">${icon('pencil')} Correct <kbd>C</kbd></button>
      <button type="button" class="btn btn-outline" data-act="manual">${icon('search')} Manual inspection <kbd>M</kbd></button>
      <button type="button" class="btn btn-ghost" data-act="discard">${icon('x')} Discard <kbd>Esc</kbd></button>`;
  } else if (d.state === 'uncertain') {
    actions = `
      <button type="button" class="btn btn-secondary" data-act="manual" data-primary>${icon('search')} Send to manual inspection <kbd>Enter</kbd></button>
      <button type="button" class="btn btn-outline" data-act="correct">${icon('pencil')} Identify manually <kbd>C</kbd></button>
      <button type="button" class="btn btn-ghost" data-act="discard">${icon('x')} Discard <kbd>Esc</kbd></button>`;
  } else {
    actions = `
      <button type="button" class="btn btn-secondary" data-act="discard" data-primary>${icon('refresh')} Try again <kbd>Enter</kbd></button>
      <button type="button" class="btn btn-outline" data-act="correct">${icon('pencil')} There is an item: identify manually <kbd>C</kbd></button>`;
  }

  panel().innerHTML = `
    <div class="result result-${d.state}">
      <div class="result-top">
        <img class="result-thumb" src="${p.thumb}" alt="Captured item">
        <div class="result-main">
          <span class="status-pill ${status[0]}">${icon(status[1])} ${status[2]}</span>
          <h2 class="result-title">${title}</h2>
          ${d.state !== 'confident' && best && !d.unrecognised ? `<p class="best-guess">Best guess, not reliable: <b>${esc(best.label)}</b>${d.confidence != null ? ` (${fmtPct(d.confidence)})` : d.qualitative ? ` (AI rating: ${esc(d.qualitative)})` : ''}</p>` : ''}
          ${d.state === 'confident' ? confidenceBlock(d, cfg) : ''}
        </div>
      </div>

      ${d.state !== 'noitem' ? `
      <div class="destination" style="--cat:${esc(dest.color)}">
        ${binGraphic(dest)}
        <div>
          <p class="eyebrow">Recommended destination</p>
          <p class="dest-bin">${esc(dest.bin)}</p>
          <p class="dest-instr">${esc(dest.instruction)}</p>
          ${d.state === 'confident' && best.examples ? `<p class="small text-muted">Typical items: ${esc(best.examples)}</p>` : ''}
        </div>
      </div>` : ''}

      ${sceneBlock(p)}
      ${d.reasons.length ? `<div class="reasons"><p class="reasons-title">${d.state === 'noitem' ? 'Why' : 'Why it was flagged'}</p><ul>${d.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul></div>` : ''}
      ${d.warnings.length ? `<ul class="warnings">${d.warnings.map((w) => `<li>${icon('alert')} ${esc(w)}</li>`).join('')}</ul>` : ''}
      ${p.dup ? `<p class="dup-warning">${icon('alert')} This looks like the item recorded ${p.dup.ago} s ago. Record it only if it is a different item; otherwise discard.</p>` : ''}
      ${alts.length && d.state !== 'noitem' && !d.unrecognised ? `<p class="alts">Other possibilities: ${alts.map((a) => `${esc(ctx.labelOf(a.id, p.mode))} ${a.p != null ? fmtPct(a.p) : esc(a.q || '')}`).join(' · ')}</p>` : ''}

      <details class="tech">
        <summary>Technical details</summary>
        <dl>
          <dt>Engine</dt><dd>${esc(ENGINES[d.engine]?.label || d.engine)}</dd>
          <dt>Model version</dt><dd><code>${esc(d.modelVersion)}</code></dd>
          <dt>Response time</dt><dd>${fmtMs(d.ms)}</dd>
          ${d.margin != null ? `<dt>Margin over 2nd</dt><dd>${fmtPct(d.margin)} (required ${fmtPct(cfg.minMargin)})</dd>` : ''}
          ${d.evidence.map((e) => `<dt>Evidence</dt><dd>${esc(e)}</dd>`).join('')}
          <dt>Image check</dt><dd>brightness ${p.quality.mean ?? '—'}, contrast ${p.quality.contrast ?? '—'}, sharpness ${p.quality.sharpness ?? '—'}</dd>
        </dl>
      </details>

      ${recordForm({ trainingChecked: false })}
      ${isKnn ? '' : '<p class="small text-muted training-note">Ticking "Add to training set" stores this photo’s features for the local model (Train tab). Nothing learns automatically.</p>'}
      <div class="actions" id="result-actions">${actions}</div>
      <div class="picker" id="picker" hidden></div>
    </div>`;
  $('[data-primary]')?.focus({ preventScroll: true });
}

/* Vision AI: draw every item it found on the captured photo. */
function annotate(src, items) {
  const scale = Math.min(1, 640 / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  const g = c.getContext('2d');
  g.drawImage(src, 0, 0, c.width, c.height);
  g.font = '700 14px Montserrat, "Segoe UI", sans-serif';
  items.forEach((it, i) => {
    const cat = it.person ? null : ctx.category(it.result.scores[0]?.id);
    const color = it.person ? '#9FB3AC' : cat?.color || '#E0A100';
    const x = it.box.x * c.width, y = it.box.y * c.height, w = it.box.w * c.width, h = it.box.h * c.height;
    g.lineWidth = 3;
    g.strokeStyle = color;
    g.strokeRect(x, y, w, h);
    const text = `${i + 1}. ${it.person ? 'person' : it.name}`;
    const tw = g.measureText(text).width + 12;
    g.fillStyle = 'rgba(0,51,42,0.88)';
    g.fillRect(Math.min(x, c.width - tw), Math.max(0, y - 22), tw, 22);
    g.fillStyle = '#fff';
    g.fillText(text, Math.min(x, c.width - tw) + 6, Math.max(0, y - 22) + 16);
  });
  return c.toDataURL('image/jpeg', 0.85);
}

function sceneBlock(p) {
  const items = p.out?.items;
  if (!items?.length) return '';
  const rows = items.map((it, i) => {
    if (it.person) return `<li><span class="cat-mark cat-mark-sm is-none">${icon('user')}</span><span><b>${i + 1}. Person</b> <span class="text-muted">not waste, ignored</span></span></li>`;
    const id = it.result.scores[0]?.id;
    const cat = id ? ctx.category(id, p.mode) : null;
    const note = it.result.unrecognised ? `<span class="tag tag-warn">${esc(it.result.unrecognised)}</span>`
      : `<span class="tag ${it.confidence === 'high' ? 'tag-ok' : 'tag-warn'}">${esc(cat?.bin || '')}${it.confidence === 'high' ? '' : ' (check)'}</span>`;
    return `<li>${categoryMark(cat, 'sm')}<span><b>${i + 1}. ${esc(it.name)}</b> <span class="text-muted">${esc(it.material)}${it.resin ? ` \u00b7 ${esc(it.resin)}` : ''} \u2192 ${esc(cat?.label || '')} \u00b7 rated ${esc(it.confidence)}</span></span>${note}</li>`;
  }).join('');
  return `
    <div class="scene">
      <p class="reasons-title">Everything in the picture</p>
      <img class="scene-img" src="${annotate(p.input.full, items)}" alt="Captured photo with each item outlined and numbered">
      <ul class="live-items">${rows}</ul>
    </div>`;
}

function openPicker() {
  const p = pending;
  if (!p) return;
  const cats = ctx.modeCfg(p.mode).categories.filter((c) => c.enabled !== false);
  const picker = $('#picker');
  if (!picker) {
    // Error state has no picker; manual identification goes through the same list.
    return;
  }
  $('#result-actions').hidden = true;
  picker.hidden = false;
  picker.innerHTML = `
    <p class="picker-title">What is this item? <span class="text-muted small">Press 1–${Math.min(cats.length, 9)} or click</span></p>
    <div class="picker-grid">
      ${cats.map((c, i) => `<button type="button" class="pick" data-pick="${esc(c.id)}">${i < 9 ? `<kbd>${i + 1}</kbd>` : ''}${categoryMark(c, 'sm')}<span>${esc(c.label)}</span></button>`).join('')}
    </div>
    <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-pick">Cancel <kbd>Esc</kbd></button>`;
  picker.querySelector('.pick')?.focus();
}

function closePicker() {
  const picker = $('#picker');
  if (!picker || picker.hidden) return false;
  picker.hidden = true;
  $('#result-actions').hidden = false;
  $('[data-primary]')?.focus();
  return true;
}

function pick(id) {
  const p = pending;
  if (!p) return;
  record(p.d && id === p.d.predicted ? 'confirmed' : 'corrected', id);
}

function renderRecorded(rec, thumb) {
  const cat = ctx.category(rec.final, rec.mode);
  const verb = { confirmed: 'Confirmed', corrected: 'Corrected', manual: 'Sent to manual inspection' }[rec.status];
  panel().innerHTML = `
    <div class="result-recorded">
      <img class="result-thumb" src="${thumb}" alt="">
      <div>
        <span class="status-pill status-ok">${icon('check')} Recorded</span>
        <h2 class="result-title">${categoryMark(rec.final ? cat : null, 'md')}<span>${esc(rec.finalLabel || 'Manual inspection')}</span></h2>
        <p>${esc(verb)} · ${esc(rec.binName)}${rec.weightKg != null ? ` · ${fmtKg(rec.weightKg)}` : ''}${rec.addedToTraining ? ' · added to training set' : ''}</p>
        <p class="text-muted small">Place the item in its bin, then capture the next one.<span class="kbd-hint"> Shortcut: <kbd>Space</kbd></span></p>
        <button type="button" class="btn btn-ghost btn-sm" data-undo="${esc(rec.id)}">${icon('refresh')} Undo this record</button>
      </div>
    </div>`;
  toast(`Recorded: ${rec.finalLabel || 'Manual inspection'} → ${rec.binName}`, 'ok');
}

/* ---------- Session counters ---------- */
async function startSession() {
  ctx.session = { id: store.uid(), startedAt: Date.now() };
  await store.kvSet('session', ctx.session);
}

function renderSession(flashId = null) {
  if (!ctx.session) return;
  const cfg = ctx.modeCfg();
  const recs = ctx.records.filter((r) => r.sessionId === ctx.session.id && r.mode === ctx.mode);
  const allSession = ctx.records.filter((r) => r.sessionId === ctx.session.id).length;
  const s = computeStats(recs);
  $('#session-meta').textContent = `${MODES[ctx.mode].long} · started ${new Date(ctx.session.startedAt).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}${allSession !== recs.length ? ` · ${allSession} items across both modes` : ''}`;
  const tiles = [
    ['Items recorded', s.total],
    ['Confirmed', s.confirmed],
    ['Corrected', s.corrected],
    ['Uncertain', s.uncertain],
    ['Manual inspection', s.manual],
    ...(s.auto ? [['Auto-recorded', s.auto, 'Live detection, not yet verified']] : []),
    ['Weighed mass', s.weighed ? fmtKg(s.kg) : '—', s.weighed ? `${s.weighed} of ${s.total} items weighed` : 'No weights entered'],
  ];
  const cats = [...cfg.categories.filter((c) => c.enabled !== false || s.byFinal.has(c.id)), MANUAL];
  $('#session-body').innerHTML = `
    <div class="tiles tiles-session">
      ${tiles.map(([l, v, sub]) => `<div class="tile"><span class="tile-label">${l}</span><span class="tile-value">${v}</span>${sub ? `<span class="tile-sub">${sub}</span>` : ''}</div>`).join('')}
    </div>
    <ul class="cat-counts">
      ${cats.map((c) => {
        const b = s.byFinal.get(c.id) || { count: 0, kg: 0, weighed: 0 };
        return `<li class="${flashId === c.id ? 'bump' : ''}">${categoryMark(c.id === MANUAL.id ? null : c, 'sm')}<span class="cc-label">${esc(c.label)}</span><b>${b.count}</b>${b.weighed ? `<span class="cc-kg">${fmtKg(b.kg)}</span>` : ''}</li>`;
      }).join('')}
    </ul>`;
}

/* ---------- Events ---------- */
function bindEvents() {
  $('#mode-switch').addEventListener('click', (e) => { const b = e.target.closest('[data-mode]'); if (b) setMode(b.dataset.mode); });
  $('#mode-switch').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const next = ctx.mode === 'general' ? 'plastic' : 'general';
    setMode(next);
    $(`#mode-switch [data-mode="${next}"]`).focus();
  });
  $('.tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-view]'); if (b) go(b.dataset.view); });
  $('#engine-retry').addEventListener('click', refreshEngine);
  $('#btn-camera').addEventListener('click', () => (camera.isActive() ? (camera.stop(), lsSet('smartsort.camera', 'off')) : startCamera()));
  $('#camera-select').addEventListener('change', (e) => { lsSet('smartsort.cameraId', e.target.value); startCamera(e.target.value); });
  $('#btn-capture').addEventListener('click', captureFromCamera);
  $('#file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try { analyse(await camera.fromFile(file), 'upload'); } catch (err) { toast(err.message, 'error'); }
  });
  const vp = $('#viewport');
  vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.classList.add('drop'); });
  vp.addEventListener('dragleave', () => vp.classList.remove('drop'));
  vp.addEventListener('drop', async (e) => {
    e.preventDefault();
    vp.classList.remove('drop');
    const file = e.dataTransfer.files[0];
    if (file) try { analyse(await camera.fromFile(file), 'upload'); } catch (err) { toast(err.message, 'error'); }
  });
  $('#btn-new-session').addEventListener('click', async () => {
    if (pending) { toast('Record or discard the current result first.', 'warn'); return; }
    await startSession();
    lastRecorded = null;
    renderSession();
    renderIdle();
    toast('New session started. Earlier records stay in History.');
  });

  $('#live-toggle').addEventListener('change', async (e) => {
    lsSet('smartsort.live', e.target.checked ? 'on' : 'off');
    if (!e.target.checked) { live.stop(); return; }
    if (!camera.isActive()) await startCamera();
    if (!camera.isActive() || live.start() === false) e.target.checked = false;
  });
  $('#live-layout').addEventListener('click', (e) => { const b = e.target.closest('[data-layout]'); if (b) live.setLayout(b.dataset.layout); });
  $('#btn-learn-bg').addEventListener('click', () => live.learnBackground());
  panel().addEventListener('change', (e) => live.onPanelChange(e));

  panel().addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    const pickId = e.target.closest('[data-pick]')?.dataset.pick;
    const undo = e.target.closest('[data-undo]')?.dataset.undo;
    if (pickId) return pick(pickId);
    if (undo) {
      await ctx.deleteRecord(undo);
      lastRecorded = null;
      renderIdle();
      toast('Record removed. Training photos added with it are kept; remove them in the Train tab if needed.');
      return;
    }
    if (act === 'confirm' && pending?.d) record('confirmed', pending.d.predicted);
    else if (act === 'manual') record('manual', null);
    else if (act === 'correct') openPicker();
    else if (act === 'cancel-pick') closePicker();
    else if (act === 'discard') discardPending();
    else if (act === 'retry') retryPending();
  });

  document.addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) go(g.dataset.goto);
    const d = e.target.closest('[data-dismiss]');
    if (d) { dismissed.add(d.dataset.dismiss); renderBanners(); }
  });

  document.addEventListener('keydown', (e) => {
    if (ctx.view !== 'sort' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t.closest('input, textarea, select, [contenteditable]')) {
      if (e.key === 'Enter' && t.id === 'weight-input') { e.preventDefault(); $('[data-primary]')?.click(); }
      return;
    }
    const onButton = t.closest('button, a, summary, label');
    const pickerOpen = $('#picker') && !$('#picker').hidden;
    if (pickerOpen && /^[1-9]$/.test(e.key)) {
      const btn = $$('#picker [data-pick]')[Number(e.key) - 1];
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      if (!closePicker()) discardPending();
    } else if (e.key === ' ' && !onButton) {
      e.preventDefault();
      if (!pending) captureFromCamera();
      else toast('Record or discard the current result first.', 'warn');
    } else if (e.key === 'Enter' && !onButton) {
      e.preventDefault();
      $('[data-primary]')?.click();
    } else if ((e.key === 'c' || e.key === 'C') && pending) {
      e.preventDefault();
      if (pending.error) return;
      openPicker();
    } else if ((e.key === 'm' || e.key === 'M') && pending) {
      e.preventDefault();
      record('manual', null);
    }
  });

  window.addEventListener('online', () => { if (ctx.modeCfg().engine === 'cloud') refreshEngine(); });
  window.addEventListener('offline', () => { if (ctx.modeCfg().engine === 'cloud') refreshEngine(); });
  window.addEventListener('beforeunload', (e) => { if (pending) { e.preventDefault(); e.returnValue = ''; } });
}

/* If Ollama with the vision model is running on this computer, use it
   (once: an operator who later picks another engine keeps that choice). */
const IS_LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const STATION_LINK = new URLSearchParams(location.search).has('station');

/* On localhost, or when opened with ?station, look for Ollama on this
   computer and use it. A website never probes it uninvited: browsers ask
   the visitor before a site may reach the local network, and phones
   opening the link should not see that prompt. */
async function detectVision() {
  if (ctx.settings.vision.autoDetected || (!IS_LOCAL && !STATION_LINK)) return;
  if (!IS_LOCAL) setChip('loading', 'Connecting to Ollama: allow access if the browser asks\u2026');
  await ctx.useLocalVision({ quiet: true });
}

ctx.useLocalVision = async ({ quiet = false } = {}) => {
  try {
    await engines.vision.check(ctx.settings, { timeout: IS_LOCAL ? 4000 : 60000 });
  } catch (e) {
    if (!quiet) toast(e.message, 'error');
    return false;
  }
  ctx.settings.vision.autoDetected = true;
  for (const m of Object.keys(MODES)) ctx.settings.modes[m].engine = 'vision';
  ctx.save();
  toast(`Vision AI connected (${ctx.settings.vision.model} in Ollama) and selected for both modes.`, 'ok');
  await refreshEngine();
  live.reset();
  return true;
};

/* ---------- Start ---------- */
async function init() {
  for (const el of $$('[data-icon]')) el.outerHTML = icon(el.dataset.icon);
  document.body.dataset.mode = ctx.mode;
  $$('#mode-switch button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.mode === ctx.mode)));
  initTooltips();
  live.init(ctx, {
    isPaused: () => !!pending || busy || Date.now() < holdUntil,
    video,
    panel,
    renderIdle: () => { if (!pending) renderIdle(); },
    onRecorded: (rec) => renderSession(rec.final ?? 'manual'),
  });
  bindEvents();
  showCameraMessage('cameraOff', 'The camera is off. Press Start camera, or upload an image.');

  await store.open();
  ctx.records = await store.all('records');
  ctx.session = await store.kvGet('session');
  if (!ctx.session) await startSession();
  renderSession();
  renderIdle();
  renderBanners();
  await detectVision();
  refreshEngine();

  // Restart the camera if it was on last time and permission is already granted.
  if (lsGet('smartsort.camera') === 'on' && window.isSecureContext) {
    try {
      const perm = await navigator.permissions?.query({ name: 'camera' });
      if (!perm || perm.state === 'granted') startCamera();
    } catch { /* permissions API without "camera" (Firefox) */ }
  }

  // Switch back to the Vision AI by itself once Ollama is running again.
  setInterval(async () => {
    if (await engines.retryVision(ctx.mode, ctx.settings)) {
      await refreshEngine();
      live.reset();
      toast('Vision AI is available again and back in use.', 'ok');
    }
  }, 10000);

  if ('serviceWorker' in navigator && window.isSecureContext && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[smartsort] service worker', e));
  }
  const hash = location.hash.slice(1);
  if (VIEWS[hash]) go(hash);
}

init();
