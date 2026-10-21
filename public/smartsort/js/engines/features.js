/* =========================================================
   SMARTSORT, FEATURE EXTRACTOR
   Loads TensorFlow.js and MobileNet V2 (ImageNet) once, then gives
   every engine what it needs from a single forward pass:
     probs      1000 ImageNet class probabilities (baseline engine)
     embedding  1280-d L2-normalised feature vector (local model)
   Both files are served from this site (see tools/fetch-vendor.mjs)
   so inference runs on this device and works offline; the CDN and
   TF Hub copies are only fallbacks.
   ========================================================= */

export const EXTRACTOR_ID = 'mobilenet_v2_100_224';
const TFJS_SOURCES = ['vendor/tf.min.js', 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js'];
const MODEL_SOURCES = [
  { url: `models/${EXTRACTOR_ID}/model.json` },
  { url: 'https://tfhub.dev/google/imagenet/mobilenet_v2_100_224/classification/2', fromTFHub: true },
];
const EMBEDDING_NODE = 'module_apply_default/MobilenetV2/Logits/AvgPool';
const SIZE = 224;

let tfPromise = null;
let modelPromise = null;
export let backend = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => { s.remove(); reject(new Error(`could not load ${src}`)); };
    document.head.appendChild(s);
  });
}

export function loadTf() {
  if (!tfPromise) {
    tfPromise = (async () => {
      for (const src of TFJS_SOURCES) {
        try { await loadScript(src); if (window.tf) break; } catch (e) { console.warn('[smartsort]', e.message); }
      }
      const tf = window.tf;
      if (!tf) throw new Error('TensorFlow.js could not be loaded.');
      try { await tf.setBackend('webgl'); } catch { /* falls through to whatever tf picks */ }
      await tf.ready();
      backend = tf.getBackend();
      return tf;
    })();
    tfPromise.catch(() => { tfPromise = null; });
  }
  return tfPromise;
}

export function loadExtractor() {
  if (!modelPromise) {
    modelPromise = (async () => {
      const tf = await loadTf();
      let lastErr = null;
      for (const src of MODEL_SOURCES) {
        try {
          const model = await tf.loadGraphModel(src.url, src.fromTFHub ? { fromTFHub: true } : undefined);
          tf.tidy(() => model.execute(tf.zeros([1, SIZE, SIZE, 3]), [EMBEDDING_NODE, model.outputs[0].name]));
          return model;
        } catch (e) { lastErr = e; console.warn('[smartsort] model source failed:', src.url, e); }
      }
      throw new Error(`The image model could not be loaded (${lastErr?.message || 'unknown error'}).`);
    })();
    modelPromise.catch(() => { modelPromise = null; });
  }
  return modelPromise;
}

/* canvas: any canvas; it is centre-cropped to 224x224 by the caller. */
export async function extract(canvas) {
  const tf = await loadTf();
  const model = await loadExtractor();
  const [probsT, embT] = tf.tidy(() => {
    const x = tf.browser.fromPixels(canvas).toFloat().div(255).expandDims(0);
    const [emb, logits] = model.execute(x, [EMBEDDING_NODE, model.outputs[0].name]);
    const probs = tf.softmax(logits.slice([0, 1], [-1, 1000])).squeeze(); // drop "background" logit 0
    const e = emb.reshape([-1]);
    return [probs, e.div(e.norm().add(1e-8))];
  });
  const [probs, embedding] = await Promise.all([probsT.data(), embT.data()]);
  probsT.dispose();
  embT.dispose();
  return { probs, embedding: Float32Array.from(embedding) };
}
