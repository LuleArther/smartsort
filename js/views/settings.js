/* =========================================================
   SMARTSORT, SETTINGS
   Engines, thresholds, categories and bins per mode, plus station,
   privacy and data management. Every change is saved immediately.
   ========================================================= */
import { MODES, ENGINES, loadSettings, resetSettings, slugify } from '../config.js';
import * as store from '../store.js';
import { custom, knn, vision } from '../engines/index.js';
import * as machine from '../live/machine.js';
import { esc, icon, toast, download, stamp, fmtPct } from '../ui.js';

let el = null;
let ctx = null;
let machineHooked = false;

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

function modeSection(mode) {
  const cfg = ctx.settings.modes[mode];
  const c = cfg.custom;
  return `
  <section class="panel settings-mode" data-mode-section="${mode}">
    <h2>${esc(MODES[mode].long)}</h2>

    <fieldset class="engines">
      <legend>Identification engine</legend>
      ${Object.values(ENGINES).filter((e) => !e.modes || e.modes.includes(mode)).map((e) => `
        <label class="engine-opt ${cfg.engine === e.id ? 'is-on' : ''}">
          <input type="radio" name="engine-${mode}" value="${e.id}" data-engine="${mode}" ${cfg.engine === e.id ? 'checked' : ''}>
          <span><b>${esc(e.label)}</b><span class="small text-muted">${esc(e.note)}</span></span>
        </label>`).join('')}
    </fieldset>

    <div class="custom-model ${cfg.engine === 'custom' ? '' : 'is-muted'}">
      <h3>Custom model</h3>
      <p class="small text-muted">${c ? `Loaded: <b>${esc(c.name)}</b> (${c.source === 'url' ? esc(c.url) : 'stored in this browser'}), classes: ${esc(c.labels.join(', '))}` : 'None loaded. Teachable Machine: Image project › Export model › TensorFlow.js › Download, then pick all three files below.'}</p>
      <div class="custom-grid">
        <label class="field"><span>Model files (model.json, weights.bin, metadata.json)</span><input type="file" multiple accept=".json,.bin" data-custom-files="${mode}"></label>
        <label class="field"><span>or model.json URL</span><input type="url" placeholder="https://…/model.json" data-custom-url="${mode}" value="${esc(c?.source === 'url' ? c.url : '')}"></label>
        <label class="field"><span>Class names in order (only if there is no metadata.json)</span><input type="text" placeholder="PET, HDPE, PP, LDPE, Empty" data-custom-labels="${mode}"></label>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-outline btn-sm" data-custom-load="${mode}">Load model</button>
        ${c ? `<button type="button" class="btn btn-ghost btn-sm" data-custom-remove="${mode}">Remove</button>` : ''}
        <span class="small text-muted" data-custom-status="${mode}"></span>
      </div>
    </div>

    <div class="thresholds">
      <h3>When to trust a result</h3>
      <label class="field range-field"><span>Minimum confidence: <b data-out="modes.${mode}.minConfidence">${fmtPct(cfg.minConfidence)}</b></span>
        <input type="range" min="0.3" max="0.99" step="0.01" value="${cfg.minConfidence}" data-set="modes.${mode}.minConfidence" data-num></label>
      <label class="field range-field"><span>Minimum lead over the second choice: <b data-out="modes.${mode}.minMargin">${fmtPct(cfg.minMargin)}</b></span>
        <input type="range" min="0" max="0.6" step="0.01" value="${cfg.minMargin}" data-set="modes.${mode}.minMargin" data-num></label>
      <p class="small text-muted">Below either threshold the item goes to manual inspection. Raise them if wrong bins are being recommended; lower them if too many good results are flagged.</p>
    </div>

    <h3>Categories and bins</h3>
    <div class="table-scroll">
      <table class="cat-table">
        <thead><tr><th scope="col">On</th><th scope="col">Category</th><th scope="col">Destination bin</th><th scope="col">Instruction for operators</th><th scope="col">Typical items</th><th scope="col">Colour</th><th scope="col">Recyclable</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
        <tbody>
          ${cfg.categories.map((cat, i) => `
          <tr>
            <td><input type="checkbox" aria-label="Enable ${esc(cat.label)}" data-set="modes.${mode}.categories.${i}.enabled" ${cat.enabled !== false ? 'checked' : ''}></td>
            <td><input type="text" aria-label="Category name" data-set="modes.${mode}.categories.${i}.label" value="${esc(cat.label)}"><span class="small text-muted">id: ${esc(cat.id)}</span></td>
            <td><input type="text" aria-label="Destination bin" data-set="modes.${mode}.categories.${i}.bin" value="${esc(cat.bin)}"></td>
            <td><textarea rows="2" aria-label="Instruction" data-set="modes.${mode}.categories.${i}.instruction">${esc(cat.instruction)}</textarea></td>
            <td><input type="text" aria-label="Typical items" data-set="modes.${mode}.categories.${i}.examples" value="${esc(cat.examples || '')}"></td>
            <td><input type="color" aria-label="Bin colour" data-set="modes.${mode}.categories.${i}.color" value="${esc(cat.color || '#4A4F4D')}"></td>
            <td><input type="checkbox" aria-label="Counts as recyclable" data-set="modes.${mode}.categories.${i}.recyclable" ${cat.recyclable ? 'checked' : ''}></td>
            <td>${cat.custom ? `<button type="button" class="icon-btn" data-cat-del="${mode}:${i}" aria-label="Remove ${esc(cat.label)}">${icon('trash')}</button>` : ''}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="add-cat">
      <label class="field"><span>New category</span><input type="text" placeholder="e.g. Textiles" data-new-cat="${mode}"></label>
      <button type="button" class="btn btn-outline btn-sm" data-add-cat="${mode}">${icon('plus')} Add</button>
      <p class="small text-muted">New categories can be predicted by the local or a custom model once trained. The baseline and cloud engines only know the built-in ones.</p>
    </div>
  </section>`;
}

function draw() {
  const s = ctx.settings;
  el.innerHTML = `
    <div class="view-head"><div><h1>Settings</h1><p class="text-muted">Changes are saved on this device as soon as you make them.</p></div></div>

    <section class="panel">
      <h2>Station</h2>
      <div class="form-grid">
        <label class="field"><span>Station name (saved with each record)</span><input type="text" data-set="station" value="${esc(s.station)}"></label>
        <label class="field"><span>Warn about a possible repeat of the last item within (seconds, 0 = off)</span><input type="number" min="0" max="600" step="5" data-set="duplicateWindowSec" data-num value="${s.duplicateWindowSec}"></label>
        <label class="check"><input type="checkbox" data-set="qualityChecks" ${s.qualityChecks ? 'checked' : ''}> Check image quality (too dark, overexposed, blank or blurry) before trusting a result</label>
      </div>
    </section>

    ${Object.keys(MODES).map(modeSection).join('')}

    <section class="panel">
      <h2>Local model</h2>
      <div class="form-grid">
        <label class="field"><span>Neighbours compared (k)</span><input type="number" min="1" max="25" step="1" data-set="knn.k" data-num value="${s.knn.k}"></label>
        <label class="field"><span>Minimum similarity to a training photo (0–1)</span><input type="number" min="0" max="1" step="0.01" data-set="knn.minSimilarity" data-num value="${s.knn.minSimilarity}"></label>
      </div>
      <p class="small text-muted">Items less similar than this to every training photo are sent to manual inspection as unrecognised. The closest similarity is shown under Technical details on each result.</p>
    </section>

    <section class="panel">
      <h2>Vision AI (Ollama)</h2>
      <div class="form-grid">
        <label class="field"><span>Ollama address</span><input type="text" data-set="vision.url" value="${esc(s.vision.url)}"></label>
        <label class="field"><span>Vision model</span><input type="text" data-set="vision.model" value="${esc(s.vision.model)}" placeholder="qwen2.5vl:3b"></label>
        <label class="field"><span>Scans in a row that must agree before an item is decided (live)</span><input type="number" min="1" max="10" step="1" data-set="vision.stableScans" data-num value="${s.vision.stableScans}"></label>
      </div>
      <div class="btn-row" style="margin-top:0.9rem">
        <button type="button" class="btn btn-secondary btn-sm" data-vision-use>Use this computer\u2019s Ollama</button>
        <button type="button" class="btn btn-outline btn-sm" data-vision-test>Test connection</button>
        <span class="small text-muted" data-vision-status></span>
      </div>
      <p class="small text-muted">Runs on this computer's GPU through <a href="https://ollama.com" target="_blank" rel="noopener">Ollama</a>: free, and photos never leave the machine. Install a model with <code>ollama pull qwen2.5vl:3b</code> (fast, accurate boxes) or try <code>gemma3:4b</code>. When SmartSort is opened from your website instead of localhost, Ollama must allow that site: set the environment variable <code>OLLAMA_ORIGINS</code> to the site address (e.g. <code>https://sort.lutherplastics.com</code>) and restart Ollama.</p>
    </section>

    <section class="panel">
      <h2>Live detection</h2>
      <div class="form-grid">
        <label class="field"><span>Frames an item must be seen before a decision</span><input type="number" min="1" max="60" step="1" data-set="live.stableFrames" data-num value="${s.live.stableFrames}"></label>
        <label class="field"><span>Give up and send to manual inspection after (frames, table layout)</span><input type="number" min="5" max="300" step="1" data-set="live.maxFrames" data-num value="${s.live.maxFrames}"></label>
        <label class="field"><span>Most items classified per frame (table layout)</span><input type="number" min="1" max="20" step="1" data-set="live.maxItems" data-num value="${s.live.maxItems}"></label>
        <label class="field"><span>Object sensitivity: colour difference from the background (lower finds fainter items, but more false ones)</span><input type="number" min="8" max="120" step="1" data-set="live.sensitivity" data-num value="${s.live.sensitivity}"></label>
        <label class="field"><span>Smallest item (% of the picture)</span><input type="number" min="0.05" max="20" step="0.05" data-set="live.minAreaPct" data-num value="${s.live.minAreaPct}"></label>
      </div>
      <p class="small text-muted">Decisions use the averaged scores over recent frames and the same confidence thresholds as single captures.</p>
    </section>

    <section class="panel" id="machine-section">${machineHtml()}</section>

    <section class="panel">
      <h2>Privacy and cloud</h2>
      <div class="form-grid">
        <label class="check"><input type="checkbox" data-set="storeThumbnails" ${s.storeThumbnails ? 'checked' : ''}> Keep a small photo with each record (on this device only), for review in History</label>
        <label class="field"><span>Cloud engine endpoint</span><input type="text" data-set="cloudEndpoint" value="${esc(s.cloudEndpoint)}"></label>
      </div>
      <p class="small text-muted">The baseline, local and custom engines run entirely in this browser. Only the cloud engine sends photos off the device. Storage: ${store.persistent ? 'saved in this browser (IndexedDB)' : '<b>not persistent</b> in this browser session'}.</p>
    </section>

    <section class="panel">
      <h2>Data</h2>
      <div class="btn-row">
        <button type="button" class="btn btn-outline btn-sm" data-export-settings>${icon('download')} Export settings</button>
        <label class="btn btn-outline btn-sm">${icon('upload')} Import settings<input type="file" accept=".json,application/json" class="visually-hidden" data-import-settings></label>
        <button type="button" class="btn btn-ghost btn-sm" data-reset>Reset settings to defaults</button>
        <button type="button" class="btn btn-danger btn-sm" data-erase-records>${icon('trash')} Erase all records</button>
        <button type="button" class="btn btn-danger btn-sm" data-erase-training>${icon('trash')} Erase all training photos</button>
      </div>
      <p class="small text-muted">Export records from the History tab before erasing them.</p>
    </section>`;
}

function machineHtml() {
  const s = ctx.settings.machine;
  const m = machine.status();
  return `
      <h2>Machine link</h2>
      <p class="small text-muted">In live table/conveyor mode, every decided item is sent as one line of JSON to a sorting controller (Arduino, ESP32, PLC gateway…), with its category, bin, confidence and position in the camera frame (x, y from 0 to 1, top left). Uncertain items are sent as <code>"type":"manual"</code> and never as a material bin. This link is not a safety system: the machine needs its own emergency stop and interlocks.</p>
      <div class="form-grid">
        <label class="field"><span>Connection</span><select data-set="machine.transport">
          <option value="none" ${s.transport === 'none' ? 'selected' : ''}>None (show commands only)</option>
          <option value="serial" ${s.transport === 'serial' ? 'selected' : ''} ${machine.serialSupported() ? '' : 'disabled'}>USB serial${machine.serialSupported() ? '' : ' (needs Chrome or Edge)'}</option>
          <option value="websocket" ${s.transport === 'websocket' ? 'selected' : ''}>WebSocket</option>
        </select></label>
        ${s.transport === 'serial' ? `<label class="field"><span>Baud rate</span><input type="number" data-set="machine.baud" data-num value="${s.baud}"></label>` : ''}
        ${s.transport === 'websocket' ? `<label class="field"><span>WebSocket URL</span><input type="text" data-set="machine.wsUrl" value="${esc(s.wsUrl)}"></label>` : ''}
        <label class="check"><input type="checkbox" data-set="machine.sendUncertain" ${s.sendUncertain ? 'checked' : ''}> Send uncertain items as "manual" (so the machine can divert them)</label>
      </div>
      <div class="btn-row" style="margin-top:0.9rem">
        ${s.transport !== 'none' ? (m.connected
          ? '<button type="button" class="btn btn-outline btn-sm" data-machine="disconnect">Disconnect</button>'
          : '<button type="button" class="btn btn-secondary btn-sm" data-machine="connect">Connect</button>') : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-machine="test">Send test command</button>
        <span class="small ${m.connected ? '' : 'text-muted'}">${m.connected ? `Connected (${m.transport}) · ${m.sent} sent` : esc(m.error || 'Not connected')}</span>
      </div>
      ${m.log.length ? `<pre class="machine-log">${m.log.slice(0, 8).map((l) => `${l.delivered ? '→' : '·'} ${esc(l.line)}`).join('\n')}</pre>` : ''}`;
}

function after(kind) {
  ctx.save();
  if (kind === 'engine') ctx.refreshEngine();
  ctx.rerenderSession();
}

async function onChange(e) {
  const t = e.target;
  if (t.dataset.engine) {
    ctx.settings.modes[t.dataset.engine].engine = t.value;
    after('engine');
    draw();
    toast(`${MODES[t.dataset.engine].label}: ${ENGINES[t.value].short} selected.`, 'ok');
    return;
  }
  const path = t.dataset.set;
  if (path) {
    let v = t.type === 'checkbox' ? t.checked : t.value;
    if (t.hasAttribute('data-num')) {
      v = Number(v);
      if (!Number.isFinite(v)) { toast('Enter a number.', 'warn'); return; }
    }
    if (path.endsWith('.label') && !String(v).trim()) { toast('A category needs a name.', 'warn'); draw(); return; }
    setPath(ctx.settings, path, v);
    if (path === 'machine.transport') { await machine.disconnect(); after('plain'); draw(); return; }
    after(/enabled|knn|vision|modes\.\w+\.min/.test(path) ? 'engine' : 'plain');
    return;
  }
  if (t.hasAttribute('data-import-settings')) {
    const file = t.files[0];
    t.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data.format !== 'smartsort-settings-v1' || !data.settings?.modes) throw new Error('This is not a SmartSort settings file.');
      localStorage.setItem('smartsort.settings.v1', JSON.stringify(data.settings));
      Object.assign(ctx.settings, loadSettings());
      after('engine');
      draw();
      toast('Settings imported.', 'ok');
    } catch (err) { toast(err.message.startsWith('Unexpected') ? 'That file could not be read.' : err.message, 'error'); }
  }
}

function onInput(e) {
  const t = e.target;
  if (t.type === 'range' && t.dataset.set) {
    const out = el.querySelector(`[data-out="${t.dataset.set}"]`);
    if (out) out.textContent = fmtPct(Number(t.value));
  }
}

async function onClick(e) {
  const t = e.target;
  if (t.closest('[data-vision-use]')) {
    const status = el.querySelector('[data-vision-status]');
    status.textContent = 'Connecting\u2026 if the browser asks to access devices on your local network, choose Allow.';
    status.textContent = (await ctx.useLocalVision()) ? `Connected: ${ctx.settings.vision.model} is used for both modes.` : 'Not connected. Is Ollama running, and is this site allowed in OLLAMA_ORIGINS?';
    draw();
    return;
  }
  if (t.closest('[data-vision-test]')) {
    const status = el.querySelector('[data-vision-status]');
    status.textContent = 'Checking\u2026';
    try { await vision.check(ctx.settings, { timeout: 60000 }); status.textContent = `Connected: ${ctx.settings.vision.model} is ready.`; } catch (err) { status.textContent = err.message; }
    return;
  }
  const mAct = t.closest('[data-machine]')?.dataset.machine;
  if (mAct) {
    const s = ctx.settings.machine;
    if (mAct === 'connect') await (s.transport === 'serial' ? machine.connectSerial(s.baud) : machine.connectWebSocket(s.wsUrl));
    if (mAct === 'disconnect') await machine.disconnect();
    if (mAct === 'test') await machine.send({ type: 'test', category: 'plastic', bin: 'Plastic collection bin', confidence: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 });
    return;
  }
  const addMode = t.closest('[data-add-cat]')?.dataset.addCat;
  if (addMode) {
    const input = el.querySelector(`[data-new-cat="${addMode}"]`);
    const label = input.value.trim();
    const id = slugify(label);
    const cats = ctx.settings.modes[addMode].categories;
    if (!id) { toast('Type a category name first.', 'warn'); return; }
    if (cats.some((c) => c.id === id) || id === 'manual' || id === '_empty') { toast('A category with that name already exists.', 'warn'); return; }
    cats.push({ id, label, bin: `${label} collection bin`, instruction: `Place in the ${label} collection bin.`, examples: '', color: '#4A4F4D', recyclable: false, enabled: true, custom: true });
    after('engine');
    draw();
    toast(`Added ${label}. Train it in the Train tab.`, 'ok');
    return;
  }
  const del = t.closest('[data-cat-del]')?.dataset.catDel;
  if (del) {
    const [mode, i] = del.split(':');
    const cat = ctx.settings.modes[mode].categories[Number(i)];
    if (!confirm(`Remove the category "${cat.label}"? Existing records keep their label; its training photos stay until cleared.`)) return;
    ctx.settings.modes[mode].categories.splice(Number(i), 1);
    after('engine');
    draw();
    return;
  }
  const loadMode = t.closest('[data-custom-load]')?.dataset.customLoad;
  if (loadMode) {
    const status = el.querySelector(`[data-custom-status="${loadMode}"]`);
    const files = el.querySelector(`[data-custom-files="${loadMode}"]`).files;
    const url = el.querySelector(`[data-custom-url="${loadMode}"]`).value.trim();
    const labels = el.querySelector(`[data-custom-labels="${loadMode}"]`).value;
    if (!files.length && !url) { toast('Choose the model files or enter a model.json URL.', 'warn'); return; }
    status.textContent = 'Loading model…';
    try {
      const cfg = files.length ? await custom.importFromFiles(loadMode, files, labels) : await custom.importFromUrl(loadMode, url, labels);
      const cats = ctx.settings.modes[loadMode].categories;
      const unmatched = cfg.labels.filter((l) => !/^(empty|background|none|nothing|no[ _-]?item|no[ _-]?object|_empty)$/i.test(l.trim()) && !cats.some((c) => c.id === slugify(l) || slugify(c.label) === slugify(l)));
      ctx.settings.modes[loadMode].custom = cfg;
      ctx.settings.modes[loadMode].engine = 'custom';
      after('engine');
      draw();
      toast(unmatched.length ? `Model loaded. These classes match no category and will be flagged: ${unmatched.join(', ')}` : 'Model loaded and selected for this mode.', unmatched.length ? 'warn' : 'ok');
    } catch (err) {
      console.error(err);
      status.textContent = '';
      toast(`Model could not be loaded: ${err.message}`, 'error');
    }
    return;
  }
  const removeMode = t.closest('[data-custom-remove]')?.dataset.customRemove;
  if (removeMode) {
    await custom.remove(removeMode);
    const cfg = ctx.settings.modes[removeMode];
    cfg.custom = null;
    if (cfg.engine === 'custom') cfg.engine = 'baseline';
    after('engine');
    draw();
    return;
  }
  if (t.closest('[data-export-settings]')) {
    download(`smartsort-settings-${stamp()}.json`, JSON.stringify({ format: 'smartsort-settings-v1', exported: new Date().toISOString(), settings: ctx.settings }, null, 2), 'application/json');
    return;
  }
  if (t.closest('[data-reset]') && confirm('Reset all settings, categories and bins to the defaults? Records and training photos are kept.')) {
    Object.keys(ctx.settings).forEach((k) => delete ctx.settings[k]);
    Object.assign(ctx.settings, resetSettings());
    after('engine');
    draw();
    toast('Settings reset.');
    return;
  }
  if (t.closest('[data-erase-records]') && confirm(`Erase all ${ctx.records.length} records on this device? This cannot be undone.`)) {
    await ctx.clearRecords();
    toast('All records erased.');
    return;
  }
  if (t.closest('[data-erase-training]') && confirm('Erase all training photos for both modes? The local model will need to be trained again.')) {
    await store.clear('samples');
    knn.invalidate();
    ctx.refreshEngine();
    toast('Training photos erased.');
  }
}

export function render(container, appCtx) {
  el = container;
  ctx = appCtx;
  el.onchange = onChange;
  el.oninput = onInput;
  el.onclick = onClick;
  if (!machineHooked) {
    machineHooked = true;
    machine.onChange(() => { const m = el?.querySelector('#machine-section'); if (m && !el.hidden && el.closest('.view') && !el.closest('[hidden]')) m.innerHTML = machineHtml(); });
  }
  draw();
}

