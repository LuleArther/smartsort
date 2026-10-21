/* =========================================================
   SMARTSORT, RECORDS AND STATISTICS
   A record is written only when an operator acts on a result
   (confirm, correct, or send to manual inspection). Camera frames
   are never counted by themselves, so an item left in view is not
   counted twice. Every figure on the dashboard is computed from these
   records; nothing is estimated from images.
   ========================================================= */

import { MANUAL } from './config.js';
import { uid } from './store.js';

export const STATUS_LABEL = { confirmed: 'Confirmed', corrected: 'Corrected', manual: 'Manual inspection', auto: 'Auto (unverified)' };

/* One record from a decision. status: confirmed | corrected | manual,
   or auto when live detection recorded it without an operator. */
export function makeRecord(ctx, { mode, d = {}, status, finalCat = null, source, error = null, weightKg = null, hash = null, quality = null, extra = {} }) {
  return {
    id: uid(),
    ts: Date.now(),
    sessionId: ctx.session.id,
    station: ctx.settings.station,
    mode,
    source,
    engine: d.engine || ctx.modeCfg(mode).engine,
    modelVersion: d.modelVersion || null,
    ms: d.ms ?? null,
    state: d.state || 'uncertain',
    predicted: d.predicted || null,
    predictedLabel: d.predicted ? ctx.labelOf(d.predicted, mode) : null,
    confidence: d.confidence ?? null,
    qualitative: d.qualitative ?? null,
    alternatives: d.alternatives || [],
    reasons: error ? [`Engine error: ${error.message}`] : d.reasons || [],
    status,
    final: finalCat ? finalCat.id : null,
    finalLabel: finalCat?.label || null,
    binName: finalCat ? finalCat.bin : MANUAL.bin,
    recyclable: !!finalCat?.recyclable,
    weightKg,
    hash,
    duplicateOf: null,
    addedToTraining: false,
    quality: quality ? { mean: quality.mean, contrast: quality.contrast, sharpness: quality.sharpness, issues: (quality.issues || []).map((i) => i.code) } : null,
    ...extra,
  };
}

export function filterRecords(records, { mode, period, sessionId }) {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const since = {
    session: null,
    today: startOfDay,
    week: startOfDay - 6 * 86400000,
    all: 0,
  }[period] ?? 0;
  return records.filter((r) => (!mode || r.mode === mode)
    && (period === 'session' ? r.sessionId === sessionId : r.ts >= since));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function computeStats(records) {
  const byFinal = new Map();
  let manual = 0, uncertain = 0, confirmed = 0, corrected = 0, auto = 0, committedVerified = 0, committedRight = 0;
  let kg = 0, kgRecyclable = 0, weighed = 0;
  const confusion = new Map(); // predicted -> Map(final -> n)

  for (const r of records) {
    if (r.state !== 'confident') uncertain++;
    if (r.status === 'confirmed') confirmed++;
    if (r.status === 'corrected') corrected++;
    if (r.status === 'auto') auto++;
    if (r.final == null) manual++;
    const key = r.final ?? 'manual';
    const b = byFinal.get(key) || { count: 0, kg: 0, weighed: 0 };
    b.count++;
    if (r.weightKg != null) { b.kg += r.weightKg; b.weighed++; }
    byFinal.set(key, b);
    if (r.weightKg != null) {
      kg += r.weightKg; weighed++;
      if (r.recyclable) kgRecyclable += r.weightKg;
    }
    // Accuracy only counts results SmartSort committed to (a bin was
    // recommended) and an operator then checked.
    if (r.state === 'confident' && (r.status === 'confirmed' || r.status === 'corrected')) {
      committedVerified++;
      if (r.status === 'confirmed') committedRight++;
    }
    if (r.predicted && r.final) {
      const row = confusion.get(r.predicted) || new Map();
      row.set(r.final, (row.get(r.final) || 0) + 1);
      confusion.set(r.predicted, row);
    }
  }
  const verified = confirmed + corrected;
  return {
    total: records.length,
    byFinal,
    manual,
    uncertain,
    confirmed,
    corrected,
    auto,
    uncertainRate: records.length ? uncertain / records.length : null,
    correctionRate: verified ? corrected / verified : null,
    accuracy: committedVerified ? committedRight / committedVerified : null,
    accuracyN: committedVerified,
    kg, kgRecyclable, weighed,
    medianMs: median(records.map((r) => r.ms).filter((x) => x != null)),
    confusion,
  };
}

/* Items per hour (for a day or less) or per day. */
export function timeBuckets(records, period) {
  const hourly = period === 'session' || period === 'today';
  if (!records.length) return { hourly, buckets: [] };
  const keyOf = (ts) => {
    const d = new Date(ts);
    return hourly ? new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime()
      : new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const counts = new Map();
  for (const r of records) counts.set(keyOf(r.ts), (counts.get(keyOf(r.ts)) || 0) + 1);
  const keys = [...counts.keys()].sort((a, b) => a - b);
  const step = hourly ? 3600000 : 86400000;
  const out = [];
  // Fill gaps so empty hours/days show as zero rather than vanishing.
  for (let t = keys[0]; t <= keys[keys.length - 1]; t = hourly ? t + step : keyOf(t + step + 7200000)) {
    out.push({ t, n: counts.get(t) || 0 });
    if (out.length > 400) break;
  }
  return { hourly, buckets: out };
}

const CSV_COLUMNS = [
  ['id', (r) => r.id],
  ['timestamp', (r) => new Date(r.ts).toISOString()],
  ['station', (r) => r.station],
  ['session_id', (r) => r.sessionId],
  ['mode', (r) => r.mode],
  ['source', (r) => r.source],
  ['engine', (r) => r.engine],
  ['model_version', (r) => r.modelVersion],
  ['response_ms', (r) => r.ms],
  ['result_state', (r) => r.state],
  ['predicted', (r) => r.predictedLabel || r.predicted || ''],
  ['confidence', (r) => (r.confidence == null ? '' : r.confidence.toFixed(4))],
  ['ai_self_rating', (r) => r.qualitative || ''],
  ['status', (r) => r.status],
  ['final_category', (r) => r.finalLabel || r.final || 'Manual inspection'],
  ['destination', (r) => r.binName],
  ['weight_kg', (r) => r.weightKg ?? ''],
  ['recyclable_stream', (r) => (r.recyclable ? 'yes' : 'no')],
  ['uncertain_reasons', (r) => (r.reasons || []).join(' | ')],
  ['possible_duplicate', (r) => (r.duplicateOf ? 'yes' : 'no')],
  ['added_to_training', (r) => (r.addedToTraining ? 'yes' : 'no')],
  ['position_x', (r) => (r.position ? r.position.cx.toFixed(3) : '')],
  ['position_y', (r) => (r.position ? r.position.cy.toFixed(3) : '')],
];

export function toCsv(records) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const r of [...records].sort((a, b) => a.ts - b.ts)) lines.push(CSV_COLUMNS.map(([, f]) => cell(f(r))).join(','));
  return lines.join('\r\n');
}
