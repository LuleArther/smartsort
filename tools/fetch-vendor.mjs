// Downloads the third-party runtime files SmartSort serves itself, so the
// station works offline and does not depend on CDNs at sorting time:
//   - TensorFlow.js (Apache-2.0)            -> public/smartsort/vendor/tf.min.js
//   - MobileNet V2 1.0 224, ImageNet (Apache-2.0, Google, via TF Hub/Kaggle)
//                                           -> public/smartsort/models/mobilenet_v2_100_224/
// Usage: node tools/fetch-vendor.mjs   (Node 18+)
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'smartsort');
const TFJS_VERSION = '4.22.0';
const TFJS_URL = `https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@${TFJS_VERSION}/dist/tf.min.js`;
const HUB = 'https://tfhub.dev/google/imagenet/mobilenet_v2_100_224/classification/2';
const MODEL_DIR = join(ROOT, 'models', 'mobilenet_v2_100_224');

async function get(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

async function save(path, buf) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log(`  ${path.slice(ROOT.length + 1)}  ${(buf.length / 1024).toFixed(0)} KB`);
}

console.log('TensorFlow.js', TFJS_VERSION);
await save(join(ROOT, 'vendor', 'tf.min.js'), await get(TFJS_URL));

// ONNX Runtime Web (MIT): runs the YOLOv8 waste model. The WebGPU build
// uses the GPU where the browser supports it and falls back to WASM.
const ORT_VERSION = '1.20.1';
console.log('ONNX Runtime Web', ORT_VERSION);
for (const f of ['ort.webgpu.min.js', 'ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
  await save(join(ROOT, 'vendor', 'ort', f), await get(`https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/${f}`));
}

console.log('MobileNet V2 (TF Hub)');
const modelJson = JSON.parse((await get(`${HUB}/model.json?tfjs-format=file`)).toString('utf8'));
for (const group of modelJson.weightsManifest) {
  for (const p of group.paths) await save(join(MODEL_DIR, p), await get(`${HUB}/${p}?tfjs-format=file`));
}
await save(join(MODEL_DIR, 'model.json'), Buffer.from(JSON.stringify(modelJson)));

// ImageNet class names (first synonym only), so results can say what the
// baseline model saw. Taken from the @tensorflow-models/mobilenet package.
console.log('ImageNet labels');
const src = (await get('https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/imagenet_classes.js')).toString('utf8');
const labels = [];
for (const m of src.matchAll(/(\d+):\s*(['"])((?:\\.|(?!\2).)*)\2/g)) labels[Number(m[1])] = m[3].replace(/\\(.)/g, '$1').split(',')[0].trim();
if (labels.length !== 1000 || labels.includes(undefined)) throw new Error(`expected 1000 ImageNet labels, got ${labels.length}`);
await save(join(MODEL_DIR, 'labels.json'), Buffer.from(JSON.stringify(labels)));
console.log('Done.');
