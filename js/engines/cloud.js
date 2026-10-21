/* =========================================================
   SMARTSORT, CLOUD ENGINE
   Sends the photo to the Luther Sort endpoint (public/api/identify.php),
   which asks a vision AI (Gemini, then Groq). The photo leaves this
   device, so this engine is opt-in and the UI says so. The AI rates
   its own confidence as high/medium/low; SmartSort shows that rating
   as-is and never turns it into a percentage.
   ========================================================= */
import { toJpeg } from '../camera.js';

const MATERIAL_TO_GENERAL = { plastic: 'plastic', glass: 'glass', paper: 'paper', metal: 'metal', organic: 'organic', textile: 'other', electronic: 'other', other: 'other' };
const TYPE_TO_PLASTIC = { PET: 'pet', HDPE: 'hdpe', PP: 'pp', LDPE: 'ldpe', PVC: 'pvc', PS: 'ps', OTHER: 'other_plastic', UNKNOWN: 'other_plastic' };
const RANK = { high: 3, medium: 2, low: 1 };

export async function classify(input, mode, settings) {
  if (!navigator.onLine) throw new Error('No internet connection. The cloud engine needs internet; switch to a local engine in Settings.');
  const dataUrl = toJpeg(input.full, 1024, 0.85);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 40000);
  let res, body;
  try {
    res = await fetch(settings.cloudEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: dataUrl.split(',')[1], mime: 'image/jpeg' }),
      signal: ctrl.signal,
    });
    body = await res.json().catch(() => null);
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? 'The cloud AI took too long to answer. Try again.' : 'The cloud AI could not be reached. Check the internet connection or the endpoint in Settings.');
  } finally { clearTimeout(timer); }
  if (!res.ok || !body?.ok) throw new Error(body?.error || `The cloud AI returned an error (HTTP ${res.status}).`);

  const r = body.result;
  const parts = r.parts || [];
  const evidence = [r.summary, ...parts.map((p) => `${p.part}: ${p.material}${p.plastic_type ? ` (${p.plastic_type})` : ''}, ${p.confidence}. ${p.reason}`)].filter(Boolean);
  const base = { engine: 'cloud', modelVersion: `cloud/${body.provider || 'unknown'}`, confidenceKind: 'qualitative', evidence, scores: [] };

  if (!r.is_waste_item || !parts.length) return { ...base, noItem: 'The AI did not see a waste item in this photo.' };

  // The main part decides the bin: in plastic mode the first plastic part
  // (usually the body), otherwise the first part listed.
  const main = mode === 'plastic' ? parts.find((p) => p.material === 'plastic') : parts[0];
  if (!main) return { ...base, unrecognised: 'The AI found no plastic part in this item.' };
  const id = mode === 'plastic' ? TYPE_TO_PLASTIC[main.plastic_type] || 'other_plastic' : MATERIAL_TO_GENERAL[main.material] || 'other';
  // Other listed parts become alternatives, ranked by the AI's own rating.
  const others = parts.filter((p) => p !== main)
    .map((p) => ({ id: mode === 'plastic' ? TYPE_TO_PLASTIC[p.plastic_type] : MATERIAL_TO_GENERAL[p.material], q: p.confidence }))
    .filter((p) => p.id && p.id !== id);
  return {
    ...base,
    qualitative: main.confidence,
    scores: [{ id, p: RANK[main.confidence] || 1, q: main.confidence }, ...others.map((o) => ({ id: o.id, p: (RANK[o.q] || 1) - 0.5, q: o.q }))],
    partNote: parts.length > 1 ? `Main part: ${main.part}. Other parts may need a different bin.` : null,
  };
}
