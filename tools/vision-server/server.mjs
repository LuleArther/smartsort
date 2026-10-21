// SmartSort vision gatekeeper.
//
// Lets the public SmartSort site use the Ollama vision model on this PC,
// without exposing Ollama itself to the internet. Only two things are
// allowed through, and only for the configured model:
//   GET  /api/tags   which models are ready (filtered to the vision model)
//   POST /api/chat   one image, one prompt, bounded output
// Everything else (pulling, deleting or running other models...) is refused.
// Requests are size- and rate-limited, queued so the GPU is not swamped,
// and only accepted from the SmartSort site. Photos are passed to Ollama
// in memory and never written to disk or logged.
//
// Started by start.mjs, which also opens the public tunnel.
import http from 'node:http';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PORT = Number(process.env.SMARTSORT_PORT || 11435);
const OLLAMA = process.env.OLLAMA_HOST_URL || 'http://127.0.0.1:11434';
export const MODEL = process.env.SMARTSORT_MODEL || 'qwen2.5vl:3b';
const ORIGINS = new Set([
  'https://lulearther.github.io',
  'http://localhost:8765',
  'http://127.0.0.1:8765',
  ...(process.env.SMARTSORT_ORIGINS || '').split(',').filter(Boolean),
]);
const MAX_BODY = 3 * 1024 * 1024; // one ~0.8 MP JPEG, base64-encoded, is well under 1 MB
const MAX_QUEUE = 8;              // requests waiting for the GPU before new ones get "busy"
const PER_IP_PER_MIN = 150;       // live mode makes about 1-2 requests per second per viewer

let waiting = 0;
let chain = Promise.resolve(); // one Ollama request at a time
const hits = new Map(); // ip -> { n, reset }

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ipOf = (req) => String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
const tag = (ip) => createHash('sha256').update(ip).digest('hex').slice(0, 8); // logs never hold raw IPs

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (origin && ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, reset: now + 60000 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60000; }
  h.n++;
  hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return h.n > PER_IP_PER_MIN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const parts = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('too large'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
}

/* Rebuild the request from allowed fields only, with bounded options. */
function sanitize(body) {
  const fail = (msg) => { throw Object.assign(new Error(msg), { status: 400 }); };
  if (body.model !== MODEL) fail(`Only ${MODEL} is available.`);
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (msgs.length !== 1 || msgs[0].role !== 'user') fail('Send exactly one user message.');
  const { content, images } = msgs[0];
  if (typeof content !== 'string' || content.length > 4000) fail('Prompt missing or too long.');
  if (!Array.isArray(images) || images.length !== 1 || typeof images[0] !== 'string') fail('Send exactly one image.');
  const o = body.options || {};
  return {
    model: MODEL,
    stream: false,
    keep_alive: '30m',
    format: body.format && typeof body.format === 'object' ? body.format : 'json',
    options: {
      temperature: Math.min(1, Math.max(0, Number(o.temperature) || 0)),
      num_ctx: 4096,
      num_predict: Math.min(1200, Math.max(16, Number(o.num_predict) || 700)),
    },
    messages: [{ role: 'user', content, images: [images[0]] }],
  };
}

async function ollama(path, init) {
  const res = await fetch(`${OLLAMA}${path}`, { ...init, signal: AbortSignal.timeout(90000) });
  return { status: res.status, body: await res.json().catch(() => ({ error: 'Bad reply from Ollama' })) };
}

export const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  const t0 = Date.now();
  const path = (req.url || '/').split('?')[0];
  const ip = ipOf(req);
  const done = (status, body) => { send(res, status, body, origin); log(req.method, path, status, `${Date.now() - t0}ms`, tag(ip)); };

  if (req.method === 'OPTIONS') {
    if (!ORIGINS.has(origin)) return done(403, { error: 'Origin not allowed' });
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    });
    return res.end();
  }
  // Browsers always send Origin on these cross-site calls; anything else is refused.
  if (path !== '/health' && !ORIGINS.has(origin)) return done(403, { error: 'Origin not allowed' });

  try {
    if (req.method === 'GET' && path === '/health') return done(200, { ok: true, model: MODEL, waiting });
    if (req.method === 'GET' && path === '/api/tags') {
      const r = await ollama('/api/tags');
      const models = (r.body.models || []).filter((m) => m.name === MODEL || m.name === `${MODEL}:latest`);
      return done(r.status === 200 ? 200 : 503, r.status === 200 ? { models } : { error: 'Ollama is not running on the AI computer.' });
    }
    if (req.method === 'POST' && path === '/api/chat') {
      if (limited(ip)) return done(429, { error: 'Too many requests. Slow down a little.' });
      if (waiting >= MAX_QUEUE) return done(503, { error: 'The AI computer is busy. Try again in a moment.' });
      const clean = sanitize(JSON.parse(await readBody(req)));
      waiting++;
      const job = chain.then(() => ollama('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(clean) }));
      chain = job.catch(() => {});
      try {
        const r = await job;
        return done(r.status, r.status === 200 ? { message: { content: r.body.message?.content ?? '' } } : { error: r.body.error || 'Ollama error' });
      } finally { waiting--; }
    }
    return done(404, { error: 'Not found' });
  } catch (e) {
    return done(e.status || (e instanceof SyntaxError ? 400 : 502), { error: e.status ? e.message : 'The AI computer could not answer.' });
  }
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  server.listen(PORT, '127.0.0.1', () => log(`gatekeeper on http://127.0.0.1:${PORT} -> ${OLLAMA} (${MODEL})`));
}
