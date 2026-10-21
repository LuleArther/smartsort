/* =========================================================
   SMARTSORT, CAMERA AND IMAGES
   Live camera via getUserMedia, still capture, image upload, and
   the canvas helpers every engine shares. Camera errors are turned
   into a short code plus an operator-readable message.
   ========================================================= */

const MAX_SIDE = 1024; // captured frames are downscaled to this; plenty for 224px models

export class CameraError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

let stream = null;
const listeners = new Set();
export const onStreamChange = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(stream));

export const isActive = () => !!stream && stream.getVideoTracks().some((t) => t.readyState === 'live');
export const currentStream = () => stream;

export async function start(deviceId = null) {
  if (!window.isSecureContext) {
    throw new CameraError('insecure', 'The camera needs a secure connection. Open SmartSort over https:// or on localhost, or use Upload image.');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraError('unsupported', 'This browser cannot use a camera. Use Upload image instead, or try a recent Chrome, Edge or Firefox.');
  }
  stop();
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    stream = null;
    emit();
    const map = {
      NotAllowedError: ['denied', 'Camera permission was denied. Allow camera access in the browser’s address bar, then press Start camera again.'],
      SecurityError: ['denied', 'Camera access is blocked on this page.'],
      NotFoundError: ['unavailable', 'No camera was found. Connect a webcam, or use Upload image.'],
      OverconstrainedError: ['unavailable', 'The selected camera is not available. Choose another camera.'],
      NotReadableError: ['busy', 'The camera is in use by another application, or failed to start. Close other apps using it and try again.'],
      AbortError: ['busy', 'The camera failed to start. Try again.'],
    };
    const [code, msg] = map[e.name] || ['unavailable', `The camera could not be started (${e.name || 'unknown error'}).`];
    throw new CameraError(code, msg);
  }
  stream.getVideoTracks().forEach((t) => t.addEventListener('ended', () => { stream = null; emit(); }));
  emit();
  return stream;
}

export function stop() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  emit();
}

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

export const activeDeviceId = () => stream?.getVideoTracks()[0]?.getSettings?.().deviceId || null;

function canvasFrom(source, w, h) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
  return c;
}

/* Grabs the current video frame as a canvas. */
export function captureFrame(video) {
  if (!video.videoWidth) throw new CameraError('noframe', 'The camera has not produced an image yet. Wait a moment and try again.');
  return canvasFrom(video, video.videoWidth, video.videoHeight);
}

/* Decodes an uploaded image file into a canvas. */
export async function fromFile(file) {
  if (!file.type.startsWith('image/') && !/\.(jpe?g|png|webp|gif|bmp|heic|heif)$/i.test(file.name)) {
    throw new CameraError('badfile', `"${file.name}" is not an image.`);
  }
  try {
    const bmp = await createImageBitmap(file);
    const c = canvasFrom(bmp, bmp.width, bmp.height);
    bmp.close?.();
    return c;
  } catch {
    const hint = /hei[cf]/i.test(file.type + file.name) ? ' HEIC photos are not supported by this browser; export as JPEG first.' : '';
    throw new CameraError('badfile', `"${file.name}" could not be read as an image.${hint}`);
  }
}

/* Centre square crop, resized: what the 224px models see. */
export function squareCrop(src, size) {
  const s = Math.min(src.width, src.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, (src.width - s) / 2, (src.height - s) / 2, s, s, 0, 0, size, size);
  return c;
}

export function toJpeg(src, maxSide, quality = 0.8) {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

/* ---------- Image quality ----------
   Cheap checks on a 128px greyscale copy. Thresholds are deliberately
   loose: they catch a covered lens, a blank frame or a very dark room,
   not ordinary variation. */
function grey(src, size = 128) {
  const c = squareCrop(src, size);
  const { data } = c.getContext('2d').getImageData(0, 0, size, size);
  const g = new Float32Array(size * size);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return { g, size };
}

export function assessQuality(src) {
  const { g, size } = grey(src);
  let sum = 0;
  for (const v of g) sum += v;
  const mean = sum / g.length;
  let varSum = 0;
  for (const v of g) varSum += (v - mean) ** 2;
  const contrast = Math.sqrt(varSum / g.length);
  // Variance of the Laplacian: low means few sharp edges (blur or blank).
  let lapSum = 0, lapSq = 0, n = 0;
  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const i = y * size + x;
      const l = g[i - size] + g[i + size] + g[i - 1] + g[i + 1] - 4 * g[i];
      lapSum += l; lapSq += l * l; n++;
    }
  }
  const sharpness = lapSq / n - (lapSum / n) ** 2;

  const issues = [];
  if (mean < 40) issues.push({ code: 'dark', severe: true, text: 'The image is very dark. Add light or move the item closer to a light source.' });
  else if (mean > 230) issues.push({ code: 'bright', severe: true, text: 'The image is overexposed. Reduce glare or direct light.' });
  if (contrast < 12) issues.push({ code: 'flat', severe: true, text: 'The image has almost no detail. Check that the lens is not covered and an item is in view.' });
  else if (sharpness < 20) issues.push({ code: 'blurry', severe: false, text: 'The image looks blurry. Hold the item still and keep it in focus.' });
  return { mean: Math.round(mean), contrast: Math.round(contrast), sharpness: Math.round(sharpness), issues };
}

/* 64-bit average hash, as a bit string. Used to warn when the same
   item seems to be recorded twice in a row. */
export function averageHash(src) {
  const { g } = grey(src, 8);
  const mean = g.reduce((a, b) => a + b, 0) / g.length;
  let bits = '';
  for (const v of g) bits += v > mean ? '1' : '0';
  return bits;
}

export function hashDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}
