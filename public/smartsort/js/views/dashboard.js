/* =========================================================
   SMARTSORT, DASHBOARD
   Counts, measured mass, verified accuracy and activity for the
   active mode, from recorded identifications only. Accuracy is shown
   with its sample size; environmental impact is deliberately not
   calculated (see the note at the bottom of the page).
   ========================================================= */
import { MODES, MANUAL } from '../config.js';
import { filterRecords, computeStats, timeBuckets } from '../records.js';
import { esc, categoryMark, fmtPct, fmtKg, fmtMs, fmtNum } from '../ui.js';

let period = 'session';

const PERIODS = [['session', 'This session'], ['today', 'Today'], ['week', 'Last 7 days'], ['all', 'All time']];

function hbars(rows, { valueFmt, emptyText, tipUnit }) {
  const max = Math.max(...rows.map((r) => r.value), 0);
  if (!max) return `<p class="empty-chart">${esc(emptyText)}</p>`;
  return `<ul class="hbars">${rows.map((r) => `
    <li>
      <span class="hb-label">${r.mark}${esc(r.label)}</span>
      <span class="hb-track"><span class="hb-bar" tabindex="0" style="width:${(r.value / max) * 100}%" data-tip="${esc(`${r.label}: ${valueFmt(r.value)}${r.tip ? ` · ${r.tip}` : ''}`)}"></span></span>
      <span class="hb-value">${esc(valueFmt(r.value))}</span>
    </li>`).join('')}</ul>`;
}

function columns({ hourly, buckets }) {
  if (!buckets.length) return '<p class="empty-chart">No items recorded in this period.</p>';
  const max = Math.max(...buckets.map((b) => b.n), 1);
  const fmtKey = (t) => (hourly
    ? new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
    : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
  const labelEvery = Math.ceil(buckets.length / 8);
  return `
    <div class="cols-wrap">
      <div class="cols-y"><span>${max}</span><span>0</span></div>
      <div class="cols">
        ${buckets.map((b, i) => `
          <div class="col">
            <span class="col-bar" tabindex="0" style="height:${(b.n / max) * 100}%" data-tip="${esc(`${fmtKey(b.t)}${hourly ? '–' + fmtKey(b.t + 3600000) : ''}: ${b.n} item${b.n === 1 ? '' : 's'}`)}"></span>
            <span class="col-x">${i % labelEvery === 0 || i === buckets.length - 1 ? esc(fmtKey(b.t)) : ''}</span>
          </div>`).join('')}
      </div>
    </div>
    <p class="small text-muted">Items recorded per ${hourly ? 'hour' : 'day'}.</p>`;
}

/* Brand-green sequential ramp for the confusion matrix, light -> dark. */
const RAMP = ['#F2F7F5', '#DCE9E4', '#B4D2C6', '#86B5A3', '#4F8E78', '#1F6A52', '#004739'];

function confusionTable(stats, cfg, labelOf) {
  const ids = new Set();
  for (const [pred, row] of stats.confusion) { ids.add(pred); for (const f of row.keys()) ids.add(f); }
  if (!ids.size) return '<p class="empty-chart">No identified items yet. The table fills in as operators confirm or correct results.</p>';
  const order = cfg.categories.map((c) => c.id).filter((id) => ids.has(id));
  for (const id of ids) if (!order.includes(id)) order.push(id);
  let max = 1;
  for (const row of stats.confusion.values()) for (const n of row.values()) max = Math.max(max, n);
  const cell = (n, diag) => {
    if (!n) return `<td class="cm-cell${diag ? ' diag' : ''}">·</td>`;
    const step = Math.min(RAMP.length - 1, 1 + Math.floor((n / max) * (RAMP.length - 2)));
    return `<td class="cm-cell${diag ? ' diag' : ''}" style="background:${RAMP[step]};color:${step >= 4 ? '#fff' : '#101915'}">${n}</td>`;
  };
  return `
    <div class="table-scroll">
      <table class="cm">
        <caption class="visually-hidden">Predicted category (rows) against final category set by the operator (columns)</caption>
        <thead><tr><th scope="col">Predicted ↓ / Final →</th>${order.map((id) => `<th scope="col">${esc(labelOf(id))}</th>`).join('')}</tr></thead>
        <tbody>${order.filter((id) => stats.confusion.has(id)).map((pred) => `
          <tr><th scope="row">${esc(labelOf(pred))}</th>${order.map((f) => cell(stats.confusion.get(pred).get(f) || 0, f === pred)).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="small text-muted">Includes uncertain results (their best guess) whenever the operator identified the item. Diagonal = prediction matched the operator.</p>`;
}

export function render(el, ctx) {
  const cfg = ctx.modeCfg();
  const recs = filterRecords(ctx.records, { mode: ctx.mode, period, sessionId: ctx.session.id });
  const s = computeStats(recs);
  const labelOf = (id) => ctx.labelOf(id);
  const cats = [...cfg.categories.filter((c) => c.enabled !== false || s.byFinal.has(c.id)), MANUAL];

  const countRows = cats.map((c) => {
    const b = s.byFinal.get(c.id) || { count: 0 };
    return { label: c.label, value: b.count, mark: categoryMark(c.id === MANUAL.id ? null : c, 'xs') };
  });
  const massRows = cats.map((c) => {
    const b = s.byFinal.get(c.id) || { kg: 0, weighed: 0, count: 0 };
    return { label: c.label, value: b.kg, mark: categoryMark(c.id === MANUAL.id ? null : c, 'xs'), tip: `${b.weighed} of ${b.count} items weighed` };
  });

  const tiles = [
    ['Verified accuracy', s.accuracy == null ? '—' : fmtPct(s.accuracy), s.accuracyN ? `${s.accuracyN} confident results checked by an operator` : 'No confident results checked yet'],
    ['Uncertain rate', fmtPct(s.uncertainRate), `${s.uncertain} of ${s.total} sent for checking`],
    ['Correction rate', fmtPct(s.correctionRate), `${s.corrected} corrected of ${s.confirmed + s.corrected} identified`],
    ['Recorded mass', s.weighed ? fmtKg(s.kg) : '—', s.weighed ? `${s.weighed} of ${s.total} items weighed` : 'No weights entered'],
    ['Mass to recycling streams', s.weighed ? fmtKg(s.kgRecyclable) : '—', 'Weighed items in bins marked recyclable'],
    ['Median response time', fmtMs(s.medianMs), 'Capture to result, excluding first model load'],
  ];

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1>Dashboard</h1>
        <p class="text-muted">${esc(MODES[ctx.mode].long)}. Switch mode at the top to see the other mode.</p>
      </div>
      <div class="seg" role="radiogroup" aria-label="Period">
        ${PERIODS.map(([id, label]) => `<button type="button" role="radio" aria-checked="${id === period}" data-period="${id}">${label}</button>`).join('')}
      </div>
    </div>

    <div class="dash-hero panel">
      <div><span class="tile-label">Items recorded</span><span class="hero-value">${fmtNum(s.total)}</span>
      <span class="tile-sub">${s.confirmed} confirmed · ${s.corrected} corrected · ${s.manual} to manual inspection${s.auto ? ` · ${s.auto} auto-recorded, not yet verified` : ''}</span></div>
    </div>

    <div class="tiles">
      ${tiles.map(([l, v, sub]) => `<div class="tile panel"><span class="tile-label">${l}</span><span class="tile-value">${v}</span><span class="tile-sub">${esc(sub)}</span></div>`).join('')}
    </div>

    <div class="dash-grid">
      <section class="panel">
        <h2>Items by final category</h2>
        ${hbars(countRows, { valueFmt: (v) => fmtNum(v), emptyText: 'No items recorded in this period.' })}
      </section>
      <section class="panel">
        <h2>Recorded mass by category</h2>
        ${hbars(massRows, { valueFmt: (v) => fmtKg(v), emptyText: 'No weights recorded in this period. Enter a weight when recording an item, or later in History.' })}
      </section>
      <section class="panel">
        <h2>Activity</h2>
        ${columns(timeBuckets(recs, period))}
      </section>
      <section class="panel">
        <h2>Predicted vs operator-confirmed</h2>
        ${confusionTable(s, cfg, labelOf)}
      </section>
    </div>

    <section class="panel note-panel">
      <h2>How these figures are calculated</h2>
      <ul>
        <li><b>Items recorded</b> counts results an operator confirmed, corrected or sent to manual inspection. Discarded captures and frames left in view are not counted.</li>
        <li><b>Verified accuracy</b> = confirmed ÷ (confirmed + corrected), over results where SmartSort recommended a bin. It reflects operator checks at this station, not a controlled test set, so treat small samples with care.</li>
        <li><b>Mass</b> is only what operators entered from a scale. SmartSort never estimates weight from images.</li>
        <li><b>Environmental impact</b> (for example CO₂ avoided) is not shown. It needs a documented method and emission factors agreed by Luther Plastics before any figure is reported.</li>
      </ul>
    </section>`;

  el.querySelector('.seg').addEventListener('click', (e) => {
    const b = e.target.closest('[data-period]');
    if (b) { period = b.dataset.period; render(el, ctx); }
  });
}
