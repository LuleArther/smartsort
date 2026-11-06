// SmartSort vision worker (Cloudflare Workers, free plan).
//
// The website sends one photo; this asks Gemini what is in it and returns
// the same item list the Ollama engine produces. It exists so the Gemini
// key stays secret, and it only does this one job: the prompt and output
// format live here, so callers cannot use the key for anything else.
//   GET  /health     is the service up
//   POST /identify   { image: base64 JPEG, width, height } -> { items, model }
// Photos pass through in memory and are never stored or logged here, but
// Gemini's free tier may use them to improve Google's products.
const MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']; // tried in order
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const ORIGINS = new Set(['https://lulearther.github.io', 'http://localhost:8765', 'http://127.0.0.1:8765']);
const MAX_BODY = 3 * 1024 * 1024;
const PER_IP_PER_MIN = 20; // best effort: counted separately on each Cloudflare server
const TIMEOUT_MS = 20000;
const hits = new Map();

const SCHEMA = {
  type: 'OBJECT',
  required: ['items'],
  properties: {
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['name', 'material', 'plastic_type', 'confidence', 'box_2d'],
        properties: {
          name: { type: 'STRING' },
          material: { type: 'STRING' },
          plastic_type: { type: 'STRING', enum: ['PET', 'HDPE', 'PVC', 'LDPE', 'PP', 'PS', 'OTHER', 'UNKNOWN', 'NONE'] },
          confidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          box_2d: { type: 'ARRAY', items: { type: 'INTEGER' } },
        },
      },
    },
  },
};

const PROMPT = 'You are the vision system of a waste sorting machine. List the separate physical things in the image, '
  + 'largest or most central first, at most 6. A bunch, pile, stack or group of the same thing is ONE entry '
  + '(e.g. "bunch of bananas", "stack of papers"); never list the same object twice. Never list parts of an object: '
  + 'a keyboard is one item (not its keys), a bottle is one item (not its label), a laptop is one item (not its screen). '
  + 'People count: if a person, face or hand is visible, list it with name "person" and material "human". '
  + 'Do not list sky, walls, floors, shadows, reflections, text or logos. '
  + 'For each thing give: name (e.g. "water bottle", "t-shirt", "banana", "floor tile"); material in plain words '
  + '(e.g. "clear plastic", "cotton fabric", "wood", "ceramic", "rubber", "leather", "glass", "aluminium", "cardboard", "fruit"); '
  + 'for plastic things the most likely resin type (PET for clear drink bottles, HDPE for opaque milk jugs, detergent bottles '
  + 'and jerrycans, LDPE for bags and film, PP for bottle caps, tubs, buckets and basins, PS for foam and disposable cups), '
  + 'otherwise NONE; your confidence; and box_2d, the bounding box as [ymin, xmin, ymax, xmax] scaled to 0-1000.';

function reply(status, body, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  if (ORIGINS.has(origin)) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
  return new Response(JSON.stringify(body), { status, headers });
}

function limited(ip) {
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, reset: now + 60000 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60000; }
  h.n += 1;
  hits.set(ip, h);
  if (hits.size > 5000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
  return h.n > PER_IP_PER_MIN;
}

/* Gemini boxes are [ymin, xmin, ymax, xmax] in 0-1000; the app wants
   [xmin, ymin, xmax, ymax] in pixels of the frame it sent. */
function toItem(it, width, height) {
  const b = it.box_2d;
  if (!Array.isArray(b) || b.length !== 4) return null;
  const { box_2d, ...rest } = it;
  return { ...rest, box: [b[1] / 1000 * width, b[0] / 1000 * height, b[3] / 1000 * width, b[2] / 1000 * height].map(Math.round) };
}

async function askGemini(model, image, key) {
  const res = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: 'image/jpeg', data: image } }, { text: PROMPT }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 1500, responseMimeType: 'application/json', responseSchema: SCHEMA },
    }),
  });
  if (!res.ok) return { status: res.status };
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  try { return { items: JSON.parse(text).items || [] }; } catch { return { status: 502 }; }
}

async function identify(request, env, origin) {
  const ip = request.headers.get('cf-connecting-ip') || '?';
  if (limited(ip)) return reply(429, { error: 'Too many photos in a short time. Wait a minute and try again.' }, origin);
  if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return reply(413, { error: 'Photo too large.' }, origin);
  let body;
  try { body = await request.json(); } catch { return reply(400, { error: 'Bad request.' }, origin); }
  const { image, width, height } = body || {};
  if (typeof image !== 'string' || !image || image.length > MAX_BODY) return reply(400, { error: 'Send one photo.' }, origin);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8000 || height > 8000) return reply(400, { error: 'Bad image size.' }, origin);
  for (const model of MODELS) {
    let r;
    try { r = await askGemini(model, image, env.GEMINI_API_KEY); } catch { continue; } // timeout or network: try the next model
    if (r.items) return reply(200, { items: r.items.map((it) => toItem(it, width, height)).filter(Boolean), model: `gemini/${model}` }, origin);
  }
  // Free limit reached, bad key, outage: 503 sends the app to its built-in model.
  return reply(503, { error: 'The Vision AI is busy or has reached its free limit.' }, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';
    const { pathname } = new URL(request.url);
    if (request.method === 'OPTIONS') {
      if (!ORIGINS.has(origin)) return new Response(null, { status: 403 });
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600', Vary: 'Origin' } });
    }
    if (request.method === 'GET' && pathname === '/health') return reply(200, { ok: true }, origin);
    if (request.method === 'POST' && pathname === '/identify') {
      if (!ORIGINS.has(origin)) return reply(403, { error: 'Origin not allowed.' }, origin);
      return identify(request, env, origin);
    }
    return reply(404, { error: 'Not found.' }, origin);
  },
};
