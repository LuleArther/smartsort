/* =========================================================
   SMARTSORT, UI HELPERS
   Escaping, formatting, icons and small shared components. Views
   build HTML with template strings, so every value that came from a
   person or a model goes through esc().
   ========================================================= */

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const fmtPct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
export const fmtKg = (kg) => (kg == null ? '—' : kg >= 1000 ? `${(kg / 1000).toFixed(2)} t` : `${kg.toFixed(kg < 10 ? 2 : 1)} kg`);
export const fmtNum = (n) => new Intl.NumberFormat('en-GB').format(n);
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const fmtDateTime = (ts) => new Date(ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
export const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`);

const P = {
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  cameraOff: '<path d="M2 2l20 20"/><path d="M7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16"/><path d="M9.5 4h5L17 7h3a2 2 0 0 1 2 2v7.5"/><path d="M14.12 15.12A3 3 0 1 1 9.88 10.88"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M17 8l-5-5-5 5"/><path d="M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m8.5 12.5 2.5 2.5 5-6"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  minusCircle: '<circle cx="12" cy="12" r="10"/><path d="M8 12h8"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  pencil: '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  scale: '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/><path d="m5 7-3 7a3 3 0 0 0 6 0z"/><path d="m19 7-3 7a3 3 0 0 0 6 0z"/>',
  bottle: '<path d="M10 2h4v3l2 3v12a2 2 0 0 1-2 2h-4a2 2 0 0 1-2-2V8l2-3z"/><path d="M8 12h8"/>',
  jar: '<path d="M8 2h8v3H8z"/><path d="M7 5h10v15a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/><path d="M7 10h10"/>',
  paper: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>',
  can: '<ellipse cx="12" cy="5" rx="7" ry="2"/><path d="M5 5v14c0 1.1 3.1 2 7 2s7-.9 7-2V5"/><path d="M5 12c0 1.1 3.1 2 7 2s7-.9 7-2"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  box: '<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  play: '<path d="m6 3 14 9-14 9z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  shirt: '<path d="M20.38 3.46 16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23z"/>',
  tree: '<path d="M12 22v-7"/><path d="M8 15h8l-4-6 3 0-3-5-3 5h3z"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18M12 3v18"/>',
  tire: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/>',
  bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  cpu: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
};

export const icon = (name, cls = '') => `<svg class="ico ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || P.box}</svg>`;

const GENERAL_ICON = { plastic: 'bottle', glass: 'jar', paper: 'paper', metal: 'can', organic: 'leaf', other: 'box', manual: 'search', textile: 'shirt', wood: 'tree', ceramic: 'grid', rubber: 'tire', leather: 'bag', electronics: 'cpu', mixed: 'layers', person: 'user' };

/* Category mark: resin-code triangle for plastics, a pictogram otherwise. */
export function categoryMark(cat, size = 'md') {
  if (!cat) return `<span class="cat-mark cat-mark-${size} is-none">${icon('minusCircle')}</span>`;
  if (cat.resin) {
    return `<span class="cat-mark cat-mark-${size} is-resin" style="--cat:${esc(cat.color)}" aria-hidden="true">
      <svg viewBox="0 0 40 40"><path d="M20 4 37 34H3z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/><text x="20" y="29" text-anchor="middle" font-size="13" font-weight="800" fill="currentColor">${esc(cat.resin)}</text></svg></span>`;
  }
  return `<span class="cat-mark cat-mark-${size}" style="--cat:${esc(cat.color || '#4A4F4D')}" aria-hidden="true">${icon(GENERAL_ICON[cat.id] || 'box')}</span>`;
}

/* A collection bin in the category's colour. The bin name is always
   printed beside it, colour never carries the meaning alone. */
export function binGraphic(cat) {
  const color = esc(cat?.color || '#8A6A1F');
  return `<svg class="bin-svg" viewBox="0 0 64 72" aria-hidden="true">
    <rect x="6" y="8" width="52" height="8" rx="3" fill="${color}"/>
    <rect x="24" y="2" width="16" height="7" rx="2" fill="${color}"/>
    <path d="M10 18h44l-4 48a4 4 0 0 1-4 4H18a4 4 0 0 1-4-4z" fill="${color}"/>
    <path d="M22 28v32M32 28v32M42 28v32" stroke="rgba(255,255,255,0.55)" stroke-width="3" stroke-linecap="round"/>
  </svg>`;
}

/* One shared tooltip for chart marks: any element with data-tip shows
   it on hover or keyboard focus. */
export function initTooltips() {
  const tip = document.getElementById('tooltip');
  const show = (el) => {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2))}px`;
    tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 8) + window.scrollY}px`;
  };
  const hide = () => { tip.hidden = true; };
  document.addEventListener('pointerover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
  document.addEventListener('scroll', hide, { passive: true });
}

let toastTimer = null;
export function toast(message, kind = 'info') {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

export function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');

/* Parses an operator-typed weight in kg; null when empty or invalid. */
export function parseKg(v) {
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 1000) / 1000 : null;
}
