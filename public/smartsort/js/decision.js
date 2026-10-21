/* =========================================================
   SMARTSORT, DECISION RULES
   Turns an engine's raw scores into what the operator sees. The rule
   that matters: SmartSort only recommends a material bin when the
   result clears every check. Anything else goes to manual inspection,
   with the reasons listed, and the best guess shown as a guess.
   ========================================================= */
import { MANUAL, enabledCategories } from './config.js';

export const pct = (p) => `${Math.round(p * 100)}%`;

export function decide(out, modeCfg, quality) {
  const enabled = enabledCategories(modeCfg);
  const enabledIds = new Set(enabled.map((c) => c.id));
  const labelOf = (id) => modeCfg.categories.find((c) => c.id === id)?.label || id;

  // Merge duplicate ids (keep the higher score), then rank.
  const merged = new Map();
  for (const s of out.scores || []) {
    if (!s.id) continue;
    const prev = merged.get(s.id);
    if (!prev || s.p > prev.p) merged.set(s.id, s);
  }
  const all = [...merged.values()].sort((a, b) => b.p - a.p);
  const ranked = all.filter((s) => enabledIds.has(s.id));
  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const isProb = out.confidenceKind === 'probability';
  const margin = best && isProb ? best.p - (second?.p || 0) : null;

  const reasons = [];
  const warnings = (quality?.issues || []).filter((i) => !i.severe).map((i) => i.text);
  let state;

  if (out.noItem) {
    state = 'noitem';
    reasons.push(out.noItem);
  } else {
    if (out.unrecognised) reasons.push(out.unrecognised);
    if (all[0] && !enabledIds.has(all[0].id)) {
      reasons.push(`The model's top answer is "${labelOf(all[0].id)}", which is not an enabled category at this station.`);
    }
    if (out.unsupportedLabel) reasons.push(`The model's top answer "${out.unsupportedLabel}" does not match any category. Rename the class or add a matching category.`);
    // When nothing was recognised, the scores are noise: say that once
    // instead of also listing thresholds they missed.
    if (out.unrecognised) { /* reason already given */ }
    else if (!best) reasons.push('No supported category was scored for this item.');
    else if (isProb) {
      if (best.p < modeCfg.minConfidence) reasons.push(`Confidence ${pct(best.p)} is below the ${pct(modeCfg.minConfidence)} required in this mode.`);
      if (second && margin < modeCfg.minMargin) reasons.push(`Too close to call between ${labelOf(best.id)} (${pct(best.p)}) and ${labelOf(second.id)} (${pct(second.p)}).`);
    } else if (out.qualitative !== 'high') {
      reasons.push(`The AI rated its own confidence as ${out.qualitative || 'unknown'}; only high is accepted.`);
    }
    for (const i of quality?.issues || []) if (i.severe) reasons.push(i.text);
    state = reasons.length ? 'uncertain' : 'confident';
  }

  const category = best ? modeCfg.categories.find((c) => c.id === best.id) : null;
  const destination = state === 'confident' ? category : MANUAL;
  return {
    state,
    unrecognised: !!out.unrecognised,
    predicted: best?.id ?? null,
    confidence: isProb && best ? best.p : null,
    qualitative: isProb ? null : out.qualitative || null,
    margin,
    alternatives: ranked.slice(0, 4).map((s) => ({ id: s.id, p: isProb ? s.p : null, q: s.q || null })),
    reasons,
    warnings: out.partNote ? [out.partNote, ...warnings] : warnings,
    destination,
    evidence: out.evidence || [],
    engine: out.engine,
    modelVersion: out.modelVersion,
    ms: out.ms,
  };
}
