/* =========================================================
   SMARTSORT, WASTE MODEL ENGINE
   YOLOv8n classification model trained on ~25,000 waste photos
   (metal, organic, paper & cardboard, plastic, glass), from the
   WasteDetector project (github.com/xrl3y/WasteDetector, MIT),
   converted to ONNX by tools/export-waste-model.py. Runs in the
   browser with ONNX Runtime Web: WebGPU when available, otherwise
   WebAssembly on the CPU. Output is a real softmax probability.
   ========================================================= */
import { squareCrop } from '../camera.js';

const DIR = 'models/waste_yolov8n_cls/';
const ORT_SRC = 'vendor/ort/ort.webgpu.min.js';

let ready = null;
let meta = null;
let session = null;
export let provider = null;
let queue = Promise.resolve(); // ONNX sessions run one inference at a time

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement('script'), { src, async: true });
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`could not load ${src}`)); };
    document.head.appendChild(s);
  });
}

export function load() {
  if (!ready) {
    ready = (async () => {
      if (!window.ort) await loadScript(ORT_SRC);
      const ort = window.ort;
      ort.env.wasm.wasmPaths = new URL('vendor/ort/', location.href).href;
      ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
      meta = await (await fetch(`${DIR}meta.json`)).json();
      const model = await (await fetch(`${DIR}${meta.file}`)).arrayBuffer();
      const tries = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
      let lastErr;
      for (const ep of tries) {
        try {
          session = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all' });
          provider = ep;
          await runRaw(new Float32Array(3 * meta.imgsz * meta.imgsz)); // warm-up (compiles GPU shaders)
          return meta;
        } catch (e) { lastErr = e; session = null; console.warn(`[smartsort] waste model on ${ep} failed`, e); }
      }
      throw new Error(`The waste model could not be loaded (${lastErr?.message || 'unknown error'}).`);
    })();
    ready.catch(() => { ready = null; });
  }
  return ready;
}

function runRaw(chw) {
  const ort = window.ort;
  const job = queue.then(async () => {
    const x = new ort.Tensor('float32', chw, [1, 3, meta.imgsz, meta.imgsz]);
    const out = await session.run({ [session.inputNames[0]]: x });
    return out[session.outputNames[0]].data;
  });
  queue = job.catch(() => {});
  return job;
}

/* Same preprocessing as Ultralytics' classify transforms: centre
   square crop, resize, RGB scaled to 0..1, channels first. */
function toCHW(canvas) {
  const n = meta.imgsz;
  const { data } = squareCrop(canvas, n).getContext('2d').getImageData(0, 0, n, n);
  const chw = new Float32Array(3 * n * n);
  for (let i = 0, p = 0; i < n * n; i++, p += 4) {
    chw[i] = data[p] / 255;
    chw[n * n + i] = data[p + 1] / 255;
    chw[2 * n * n + i] = data[p + 2] / 255;
  }
  return chw;
}

export async function probabilities(canvas) {
  await load();
  return runRaw(toCHW(canvas));
}

export async function classify(input, mode) {
  if (mode !== 'general') throw new Error('The waste model only knows general waste types. In Plastic type mode, use the local model.');
  await load();
  const probs = await probabilities(input.full);
  const scores = meta.names.map((name, i) => ({ id: meta.map[name], p: probs[i] }));
  return {
    engine: 'waste',
    modelVersion: meta.version,
    confidenceKind: 'probability',
    scores,
    evidence: [`Model classes: ${meta.names.map((n, i) => `${meta.labels[n]} ${(probs[i] * 100).toFixed(0)}%`).join(', ')}`],
  };
}
