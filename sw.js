/* =========================================================
   SMARTSORT, SERVICE WORKER
   Lets the station keep working without internet once it has been
   opened online one time. App files: network first (so updates
   arrive), cache as fallback. Model weights and TensorFlow.js: cache
   first (they are versioned and large). The cloud API is never cached.
   Bump VERSION when shipping changes to force a fresh precache.
   ========================================================= */
const VERSION = 'smartsort-v7';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/smartsort.css',
  'js/app.js',
  'js/config.js',
  'js/store.js',
  'js/camera.js',
  'js/decision.js',
  'js/records.js',
  'js/ui.js',
  'js/engines/index.js',
  'js/engines/features.js',
  'js/engines/baseline.js',
  'js/engines/knn.js',
  'js/engines/custom.js',
  'js/engines/cloud.js',
  'js/views/dashboard.js',
  'js/views/history.js',
  'js/views/train.js',
  'js/views/settings.js',
  'js/engines/waste.js',
  'js/engines/vision.js',
  'js/live/live.js',
  'js/live/foreground.js',
  'js/live/tracker.js',
  'js/live/machine.js',
  'vendor/ort/ort.webgpu.min.js',
  'vendor/ort/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/ort/ort-wasm-simd-threaded.jsep.wasm',
  'models/waste_yolov8n_cls/meta.json',
  'models/waste_yolov8n_cls/model-640.onnx',
  'vendor/tf.min.js',
  'models/mobilenet_v2_100_224/model.json',
  'models/mobilenet_v2_100_224/labels.json',
  'models/mobilenet_v2_100_224/group1-shard1of4.bin',
  'models/mobilenet_v2_100_224/group1-shard2of4.bin',
  'models/mobilenet_v2_100_224/group1-shard3of4.bin',
  'models/mobilenet_v2_100_224/group1-shard4of4.bin',
  'img/logomark-gold.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('smartsort-') && k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.pathname.includes('/api/')) return;
  const immutable = /\/(models|vendor)\//.test(url.pathname) || url.hostname === 'cdn.jsdelivr.net';

  if (immutable) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com'))) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(req, copy));
    }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: url.origin === location.origin }).then((hit) => hit || Response.error())));
});
