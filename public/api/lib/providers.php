<?php
/* =========================================================
   LUTHER SORT, AI PROVIDERS
   One function per provider, each takes a JPEG/PNG/WebP image and
   returns the model's raw decoded JSON (an array), or throws
   ProviderError. normalize_result() turns any provider's answer into
   the one shape the front end expects, so a provider can be swapped
   without touching app.js.
   ========================================================= */

class ProviderError extends Exception {
  /** true = worth trying the next provider/model (rate limit, outage, bad model id) */
  public bool $retryable;
  public function __construct(string $msg, bool $retryable = true) {
    parent::__construct($msg);
    $this->retryable = $retryable;
  }
}

const MATERIALS     = ['plastic', 'organic', 'paper', 'metal', 'glass', 'textile', 'electronic', 'other'];
const PLASTIC_TYPES = ['PET', 'HDPE', 'PVC', 'LDPE', 'PP', 'PS', 'OTHER', 'UNKNOWN'];
const RESIN_CODES   = ['PET' => 1, 'HDPE' => 2, 'PVC' => 3, 'LDPE' => 4, 'PP' => 5, 'PS' => 6, 'OTHER' => 7];

const PROMPT = <<<TXT
You are Luther Sort, a waste identification assistant for Luther Plastics, a plastic recycling company in Uganda.

Look at the photo and identify the waste item(s) in it. Break each item into its separate physical parts when they are made of different materials (for example a drinking bottle is usually a PET body, an HDPE or PP cap, and a PP or paper label).

For every part:
- "part": short name of the part, e.g. "Bottle body", "Cap", "Label", "Banana peel".
- "material": one of plastic, organic, paper, metal, glass, textile, electronic, other. Food and plant waste is organic.
- "plastic_type": only for plastic parts, one of PET, HDPE, PVC, LDPE, PP, PS, OTHER, UNKNOWN. Use null for non-plastic parts.
- "confidence": high, medium or low. Use high only when a resin identification code is clearly visible, or the item type almost always uses one plastic (e.g. clear soda bottle body = PET).
- "reason": one short sentence on the visible evidence (shape, transparency, rigidity, stamped code, typical use).

Also return:
- "is_waste_item": false if the photo shows no identifiable object (a face, a blank wall, a blurry frame).
- "summary": one plain sentence describing what you see, for a non-expert.
- "tips": up to 3 short, practical preparation tips before recycling (e.g. "Remove the cap and recycle it separately", "Rinse out any drink").

Rules: never invent a resin code you cannot see. If unsure of the plastic type, say UNKNOWN with low confidence rather than guessing. Keep text simple, the reader may be a member of the public.

Reply with JSON only, in exactly this shape:
{"is_waste_item": true, "summary": "...", "parts": [{"part": "...", "material": "plastic", "plastic_type": "PET", "confidence": "high", "reason": "..."}], "tips": ["..."]}
TXT;

/* Gemini's structured-output schema (OpenAPI subset), forces valid JSON. */
function gemini_schema(): array {
  return [
    'type' => 'OBJECT',
    'required' => ['is_waste_item', 'summary', 'parts', 'tips'],
    'properties' => [
      'is_waste_item' => ['type' => 'BOOLEAN'],
      'summary' => ['type' => 'STRING'],
      'parts' => [
        'type' => 'ARRAY',
        'items' => [
          'type' => 'OBJECT',
          'required' => ['part', 'material', 'confidence', 'reason'],
          'properties' => [
            'part' => ['type' => 'STRING'],
            'material' => ['type' => 'STRING', 'enum' => MATERIALS],
            'plastic_type' => ['type' => 'STRING', 'enum' => PLASTIC_TYPES, 'nullable' => true],
            'confidence' => ['type' => 'STRING', 'enum' => ['high', 'medium', 'low']],
            'reason' => ['type' => 'STRING'],
          ],
        ],
      ],
      'tips' => ['type' => 'ARRAY', 'items' => ['type' => 'STRING']],
    ],
  ];
}

function http_post_json(string $url, array $headers, array $body, int $timeout = 45): array {
  $ch = curl_init($url);
  curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => $timeout,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_HTTPHEADER => array_merge(['Content-Type: application/json'], $headers),
    CURLOPT_POSTFIELDS => json_encode($body),
  ]);
  $raw = curl_exec($ch);
  $status = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
  $err = curl_error($ch);
  curl_close($ch);
  if ($raw === false) throw new ProviderError("network error: $err");
  return [$status, $raw];
}

/* Classify an upstream HTTP failure: 400/401/403 mean our key or
   request is wrong (retrying the same provider won't help, but the
   next provider might), 404 is usually a retired model id. */
function check_status(string $who, int $status, string $raw): void {
  if ($status >= 200 && $status < 300) return;
  $snippet = substr(preg_replace('/\s+/', ' ', $raw), 0, 200);
  throw new ProviderError("$who HTTP $status: $snippet");
}

function decode_model_json(string $text): array {
  $text = trim($text);
  // Some models wrap JSON in ```json fences despite instructions.
  $text = preg_replace('/^```(?:json)?\s*|\s*```$/i', '', $text);
  $data = json_decode($text, true);
  if (!is_array($data)) throw new ProviderError('model returned non-JSON output');
  return $data;
}

function call_gemini(array $cfg, string $model, string $mime, string $b64): array {
  $url = 'https://generativelanguage.googleapis.com/v1beta/models/' . rawurlencode($model) . ':generateContent';
  [$status, $raw] = http_post_json($url, ['x-goog-api-key: ' . $cfg['key']], [
    'contents' => [[
      'parts' => [
        ['inline_data' => ['mime_type' => $mime, 'data' => $b64]],
        ['text' => PROMPT],
      ],
    ]],
    'generationConfig' => [
      'temperature' => 0.2,
      'responseMimeType' => 'application/json',
      'responseSchema' => gemini_schema(),
    ],
  ]);
  check_status("gemini/$model", $status, $raw);
  $res = json_decode($raw, true);
  $text = $res['candidates'][0]['content']['parts'][0]['text'] ?? null;
  if (!is_string($text)) throw new ProviderError("gemini/$model: empty or blocked response");
  return decode_model_json($text);
}

function call_groq(array $cfg, string $model, string $mime, string $b64): array {
  [$status, $raw] = http_post_json('https://api.groq.com/openai/v1/chat/completions', ['Authorization: Bearer ' . $cfg['key']], [
    'model' => $model,
    'temperature' => 0.2,
    'response_format' => ['type' => 'json_object'],
    'messages' => [[
      'role' => 'user',
      'content' => [
        ['type' => 'text', 'text' => PROMPT],
        ['type' => 'image_url', 'image_url' => ['url' => "data:$mime;base64,$b64"]],
      ],
    ]],
  ]);
  check_status("groq/$model", $status, $raw);
  $res = json_decode($raw, true);
  $text = $res['choices'][0]['message']['content'] ?? null;
  if (!is_string($text)) throw new ProviderError("groq/$model: empty response");
  return decode_model_json($text);
}

/* Local UI testing without any AI key. Clearly labelled so it can
   never be mistaken for a real identification. */
function call_demo(): array {
  return [
    'is_waste_item' => true,
    'summary' => 'DEMO RESPONSE, no AI is connected. This is a fixed sample of a plastic drinking bottle.',
    'parts' => [
      ['part' => 'Bottle body', 'material' => 'plastic', 'plastic_type' => 'PET', 'confidence' => 'high', 'reason' => 'Sample data.'],
      ['part' => 'Cap', 'material' => 'plastic', 'plastic_type' => 'PP', 'confidence' => 'medium', 'reason' => 'Sample data.'],
      ['part' => 'Label', 'material' => 'paper', 'plastic_type' => null, 'confidence' => 'low', 'reason' => 'Sample data.'],
    ],
    'tips' => ['Sample tip: remove the cap and recycle it separately.'],
  ];
}

/* Coerce whatever the model sent into the exact shape app.js expects.
   Never trust model output blindly: enums are clamped, strings are
   trimmed and length-limited, and "accepted" is decided here from
   config, never by the model. */
function normalize_result(array $d, array $accepted): array {
  $str = fn($v, $max) => mb_substr(trim(is_string($v) ? $v : ''), 0, $max);
  $parts = [];
  foreach (array_slice(is_array($d['parts'] ?? null) ? $d['parts'] : [], 0, 8) as $p) {
    if (!is_array($p)) continue;
    $material = strtolower($str($p['material'] ?? '', 20));
    if (!in_array($material, MATERIALS, true)) $material = 'other';
    $type = null;
    if ($material === 'plastic') {
      $type = strtoupper($str($p['plastic_type'] ?? '', 10));
      if (!in_array($type, PLASTIC_TYPES, true)) $type = 'UNKNOWN';
    }
    $conf = strtolower($str($p['confidence'] ?? '', 10));
    if (!in_array($conf, ['high', 'medium', 'low'], true)) $conf = 'low';
    $parts[] = [
      'part' => $str($p['part'] ?? '', 60) ?: 'Item',
      'material' => $material,
      'plastic_type' => $type,
      'resin_code' => $type ? (RESIN_CODES[$type] ?? null) : null,
      'confidence' => $conf,
      'reason' => $str($p['reason'] ?? '', 240),
      'accepted' => $type !== null && in_array($type, $accepted, true),
    ];
  }
  $tips = [];
  foreach (array_slice(is_array($d['tips'] ?? null) ? $d['tips'] : [], 0, 3) as $t) {
    $t = $str($t, 160);
    if ($t !== '') $tips[] = $t;
  }
  return [
    'is_waste_item' => (bool) ($d['is_waste_item'] ?? count($parts) > 0) && count($parts) > 0,
    'summary' => $str($d['summary'] ?? '', 300),
    'parts' => $parts,
    'tips' => $tips,
  ];
}
