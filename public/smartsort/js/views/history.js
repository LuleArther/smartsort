/* =========================================================
   SMARTSORT, HISTORY
   Every recorded identification, newest first, with filters, weight
   editing (items are often weighed after sorting) and CSV/JSON export
   of whatever the filters show.
   ========================================================= */
import { MODES, MANUAL } from '../config.js';
import * as store from '../store.js';
import { filterRecords, toCsv, STATUS_LABEL } from '../records.js';
import { esc, $, $$, icon, fmtPct, fmtDateTime, fmtMs, parseKg, toast, download, stamp } from '../ui.js';

const PAGE = 50;
const f = { period: 'all', mode: '', status: '', uncertainOnly: false, page: 0 };

function filtered(ctx) {
  return filterRecords(ctx.records, { mode: f.mode, period: f.period, sessionId: ctx.session.id })
    .filter((r) => (!f.status || r.status === f.status) && (!f.uncertainOnly || r.state !== 'confident'))
    .sort((a, b) => b.ts - a.ts);
}

const opt = (value, label, current) => `<option value="${value}" ${value === current ? 'selected' : ''}>${label}</option>`;

function predictedCell(r) {
  if (!r.predicted && !r.reasons?.length) return '<span class="text-muted">—</span>';
  const conf = r.confidence != null ? fmtPct(r.confidence) : r.qualitative ? esc(r.qualitative) : '';
  const state = r.state === 'confident'
    ? '<span class="tag tag-ok">confident</span>'
    : `<span class="tag tag-warn" data-tip="${esc((r.reasons || []).join(' '))}" tabindex="0">${r.state === 'noitem' ? 'no item' : 'uncertain'}</span>`;
  return `${esc(r.predictedLabel || 'None')} <span class="text-muted">${conf}</span> ${state}`;
}

export function render(el, ctx) {
  const rows = filtered(ctx);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  f.page = Math.min(f.page, pages - 1);
  const pageRows = rows.slice(f.page * PAGE, (f.page + 1) * PAGE);

  el.innerHTML = `
    <div class="view-head">
      <div>
        <h1>History</h1>
        <p class="text-muted">${rows.length} record${rows.length === 1 ? '' : 's'} match the filters. Stored on this device only.</p>
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn-outline btn-sm" data-export="csv" ${rows.length ? '' : 'disabled'}>${icon('download')} Export CSV</button>
        <button type="button" class="btn btn-outline btn-sm" data-export="json" ${rows.length ? '' : 'disabled'}>${icon('download')} Export JSON</button>
      </div>
    </div>

    <div class="filters panel">
      <label class="field"><span>Period</span><select data-f="period">
        ${opt('session', 'This session', f.period)}${opt('today', 'Today', f.period)}${opt('week', 'Last 7 days', f.period)}${opt('all', 'All time', f.period)}
      </select></label>
      <label class="field"><span>Mode</span><select data-f="mode">
        ${opt('', 'Both modes', f.mode)}${Object.values(MODES).map((m) => opt(m.id, m.label, f.mode)).join('')}
      </select></label>
      <label class="field"><span>Outcome</span><select data-f="status">
        ${opt('', 'Any', f.status)}${Object.entries(STATUS_LABEL).map(([k, v]) => opt(k, v, f.status)).join('')}
      </select></label>
      <label class="check"><input type="checkbox" data-f="uncertainOnly" ${f.uncertainOnly ? 'checked' : ''}> Uncertain only</label>
    </div>

    ${rows.length ? `
    <div class="panel table-panel">
      <div class="table-scroll">
        <table class="history">
          <thead><tr>
            <th scope="col"><span class="visually-hidden">Photo</span></th>
            <th scope="col">Time</th><th scope="col">Mode</th><th scope="col">Prediction</th>
            <th scope="col">Final</th><th scope="col">Outcome</th><th scope="col">Weight (kg)</th>
            <th scope="col">Model</th><th scope="col"><span class="visually-hidden">Actions</span></th>
          </tr></thead>
          <tbody>
            ${pageRows.map((r) => `
            <tr data-id="${esc(r.id)}">
              <td><img class="h-thumb" data-thumb="${esc(r.id)}" alt="" width="48" height="48"></td>
              <td class="nowrap">${esc(fmtDateTime(r.ts))}${r.duplicateOf ? ` <span class="tag tag-warn" data-tip="Looked like the previous item when it was recorded" tabindex="0">dup?</span>` : ''}</td>
              <td>${esc(MODES[r.mode]?.label || r.mode)}</td>
              <td>${predictedCell(r)}</td>
              <td><b>${esc(r.finalLabel || 'Manual inspection')}</b><br><span class="small text-muted">${esc(r.binName)}</span></td>
              <td><span class="tag tag-${r.status}">${esc(STATUS_LABEL[r.status])}</span>${r.addedToTraining ? '<br><span class="small text-muted">in training set</span>' : ''}
                ${r.status === 'auto' ? `<br><select class="verify-select" data-verify="${esc(r.id)}" aria-label="Verify this record">
                  <option value="">Verify…</option>
                  ${ctx.modeCfg(r.mode).categories.filter((c) => c.enabled !== false).map((c) => `<option value="${esc(c.id)}">${c.id === r.final ? '✓ ' : ''}${esc(c.label)}</option>`).join('')}
                  <option value="manual">Manual inspection</option>
                </select>` : ''}</td>
              <td><input class="weight-edit" type="text" inputmode="decimal" value="${r.weightKg ?? ''}" aria-label="Weight in kg" placeholder="—"></td>
              <td class="small"><code>${esc(r.engine)}</code><br><span class="text-muted">${esc(fmtMs(r.ms))}</span></td>
              <td><button type="button" class="icon-btn" data-del="${esc(r.id)}" aria-label="Delete record">${icon('trash')}</button></td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      ${pages > 1 ? `<div class="pager">
        <button type="button" class="btn btn-ghost btn-sm" data-page="-1" ${f.page === 0 ? 'disabled' : ''}>Newer</button>
        <span>Page ${f.page + 1} of ${pages}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-page="1" ${f.page >= pages - 1 ? 'disabled' : ''}>Older</button>
      </div>` : ''}
    </div>` : `<div class="panel empty-state">${icon('layers', 'ico-xl')}<p>No records yet for these filters. Records appear here when an operator confirms, corrects or sends an item to manual inspection.</p></div>`}`;

  // Thumbnails load after the table is on screen.
  for (const img of $$('[data-thumb]', el)) {
    store.get('thumbs', img.dataset.thumb).then((t) => { if (t) img.src = t.dataUrl; else img.replaceWith(Object.assign(document.createElement('span'), { className: 'h-thumb h-thumb-none' })); });
  }

  el.querySelector('.filters').addEventListener('change', (e) => {
    const k = e.target.dataset.f;
    if (!k) return;
    f[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    f.page = 0;
    render(el, ctx);
  });

  el.onclick = async (e) => {
    const exp = e.target.closest('[data-export]')?.dataset.export;
    if (exp === 'csv') download(`smartsort-records-${stamp()}.csv`, toCsv(rows), 'text/csv');
    if (exp === 'json') download(`smartsort-records-${stamp()}.json`, JSON.stringify({ format: 'smartsort-records-v1', exported: new Date().toISOString(), records: rows.map(({ hash, ...r }) => r) }, null, 2), 'application/json');
    const page = e.target.closest('[data-page]')?.dataset.page;
    if (page) { f.page += Number(page); render(el, ctx); }
    const del = e.target.closest('[data-del]')?.dataset.del;
    if (del && confirm('Delete this record? Counters and the dashboard will update.')) {
      await ctx.deleteRecord(del);
      render(el, ctx);
      toast('Record deleted.');
    }
  };

  el.onchange = async (e) => {
    const vid = e.target.dataset.verify;
    if (vid && e.target.value) {
      const rec = ctx.records.find((r) => r.id === vid);
      const val = e.target.value;
      const cat = val === 'manual' ? null : ctx.category(val, rec.mode);
      await ctx.updateRecord({
        ...rec,
        status: val === 'manual' ? 'manual' : val === rec.predicted ? 'confirmed' : 'corrected',
        final: cat ? cat.id : null, finalLabel: cat?.label || null, binName: cat ? cat.bin : MANUAL.bin, recyclable: !!cat?.recyclable,
      });
      render(el, ctx);
      toast('Record verified.', 'ok');
      return;
    }
    if (!e.target.classList.contains('weight-edit')) return;
    const id = e.target.closest('tr').dataset.id;
    const rec = ctx.records.find((r) => r.id === id);
    const raw = e.target.value.trim();
    const kg = parseKg(raw);
    if (raw && kg == null) { toast('Enter a weight in kg, e.g. 0.45', 'warn'); e.target.value = rec.weightKg ?? ''; return; }
    await ctx.updateRecord({ ...rec, weightKg: kg });
    toast(kg == null ? 'Weight cleared.' : `Weight saved: ${kg} kg`, 'ok');
  };
}
