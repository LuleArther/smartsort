/* =========================================================
   SMARTSORT, ENGINE REGISTRY
   One entry point for the app: prepare(mode) loads whatever the
   mode's engine needs, classify(mode, input) returns that engine's
   raw output plus timing. Adding an engine = one module with a
   classify(input, mode, settings) function, registered here.
   If the Vision AI (Ollama) is unreachable, the mode falls back to the
   built-in engine for that mode and retries Ollama every 30 s.
   ========================================================= */
import * as baseline from './baseline.js';
import * as knn from './knn.js';
import * as custom from './custom.js';
import * as cloud from './cloud.js';
import * as waste from './waste.js';
import * as vision from './vision.js';
import { loadExtractor } from './features.js';

export { knn, custom, waste, vision };

const FALLBACK = { general: 'waste', plastic: 'baseline' };
const RETRY_MS = 30000;
const visionDown = {}; // mode -> { message, since, checking }

/* The engine actually in use for a mode right now. */
export function effective(mode, settings) {
  const engine = settings.modes[mode].engine;
  return engine === 'vision' && visionDown[mode] ? FALLBACK[mode] : engine;
}

export const fallbackReason = (mode, settings) => (settings.modes[mode].engine === 'vision' ? visionDown[mode]?.message || null : null);

async function load(engine, mode, settings) {
  if (engine === 'vision') await vision.check(settings);
  if (engine === 'waste') await waste.load();
  if (engine === 'baseline' || engine === 'knn') await loadExtractor();
  if (engine === 'custom') await custom.load(mode, settings.modes[mode].custom);
}

export async function prepare(mode, settings) {
  const engine = settings.modes[mode].engine;
  if (engine === 'vision') {
    try {
      await vision.check(settings);
      delete visionDown[mode];
    } catch (e) {
      visionDown[mode] = { message: e.message, since: Date.now() };
      await load(FALLBACK[mode], mode, settings);
      return { ready: true, fallback: e.message };
    }
    return { ready: true };
  }
  await load(engine, mode, settings);
  if (engine === 'knn') {
    const samples = await knn.samplesFor(mode);
    const cats = settings.modes[mode].categories.filter((c) => c.enabled !== false).map((c) => c.id);
    if (!knn.readiness(samples, cats).ready) return { ready: false, message: 'Local model not trained yet. Add photos in the Train tab.' };
  }
  return { ready: true };
}

/* While on the fallback, check Ollama again now and then. Returns true
   when the Vision AI came back. */
export async function retryVision(mode, settings) {
  const down = visionDown[mode];
  if (!down || down.checking || Date.now() - down.since < RETRY_MS) return false;
  down.checking = true;
  try {
    await vision.check(settings);
    delete visionDown[mode];
    return true;
  } catch {
    down.since = Date.now();
    return false;
  } finally { down.checking = false; }
}

/* Called when the Vision AI stops answering mid-use. */
export function markVisionDown(mode, message) {
  visionDown[mode] = { message, since: Date.now() };
}

/* input: { full: canvas, crop224: canvas, features?: cached } */
export async function classify(mode, settings, input, labelOf) {
  const engine = effective(mode, settings);
  const t0 = performance.now();
  let out;
  if (engine === 'vision') {
    try {
      out = await vision.classify(input, mode, settings);
    } catch (e) {
      if (!e.offline) throw e;
      // The AI computer went away: answer with the built-in model now.
      markVisionDown(mode, e.message);
      out = await classify(mode, settings, input, labelOf);
      out.fellBack = e.message;
      return out;
    }
  } else if (engine === 'waste') out = await waste.classify(input, mode);
  else if (engine === 'baseline') out = await baseline.classify(input, mode);
  else if (engine === 'knn') out = await knn.classify(input, mode, settings, labelOf);
  else if (engine === 'custom') out = await custom.classify(input, mode, settings);
  else if (engine === 'cloud') out = await cloud.classify(input, mode, settings);
  else throw new Error(`Unknown engine "${engine}".`);
  out.ms = Math.round(performance.now() - t0);
  return out;
}
