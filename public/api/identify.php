<?php
/* =========================================================
   LUTHER SORT, IDENTIFY ENDPOINT
   POST application/json {"image": "<base64>", "mime": "image/jpeg"}
   → 200 {"ok": true, "result": {...}, "provider": "gemini"}
   → 4xx/5xx {"ok": false, "error": "<message safe to show a visitor>"}

   Images are processed in memory only, never written to disk or
   logged. Provider keys live in config.php, never sent to the browser.
   ========================================================= */
declare(strict_types=1);
require __DIR__ . '/lib/providers.php';

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function reply(int $status, array $body): never {
  http_response_code($status);
  echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
  exit;
}
function fail(int $status, string $msg): never { reply($status, ['ok' => false, 'error' => $msg]); }

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'Use POST.');

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) fail(503, 'Luther Sort is not configured yet.');
$config = require $configFile;

/* ---------- Rate limiting (flat files, no database needed) ---------- */
function bump_counter(string $key, int $windowSeconds, int $max): bool {
  $dir = __DIR__ . '/storage';
  if (!is_dir($dir)) @mkdir($dir, 0750, true);
  $file = $dir . '/rl_' . hash('sha256', $key) . '.json';
  $fp = fopen($file, 'c+');
  if (!$fp) return true; // fail open rather than block everyone if storage breaks
  flock($fp, LOCK_EX);
  $now = time();
  $data = json_decode(stream_get_contents($fp) ?: '', true);
  if (!is_array($data) || ($data['reset'] ?? 0) <= $now) $data = ['count' => 0, 'reset' => $now + $windowSeconds];
  $allowed = $data['count'] < $max;
  if ($allowed) $data['count']++;
  ftruncate($fp, 0); rewind($fp); fwrite($fp, json_encode($data));
  flock($fp, LOCK_UN); fclose($fp);
  return $allowed;
}
// Occasionally sweep expired counter files so storage/ doesn't grow forever.
if (random_int(1, 50) === 1) {
  foreach (glob(__DIR__ . '/storage/rl_*.json') ?: [] as $f) {
    if (filemtime($f) < time() - 2 * 86400) @unlink($f);
  }
}

$ip = $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$lim = $config['limits'] ?? [];
if (!bump_counter("min:$ip", 60, (int) ($lim['per_ip_per_minute'] ?? 6)))
  fail(429, 'Too many photos in a short time. Please wait a minute and try again.');
if (!bump_counter("day:$ip", 86400, (int) ($lim['per_ip_per_day'] ?? 40)))
  fail(429, "You've reached today's limit for photo checks. Please come back tomorrow.");
if (!bump_counter('global:day', 86400, (int) ($lim['global_per_day'] ?? 800)))
  fail(429, 'Luther Sort is very busy today. Please try again tomorrow.');

/* ---------- Validate the upload ---------- */
$raw = file_get_contents('php://input', false, null, 0, 8 * 1024 * 1024 + 1);
if ($raw === false || strlen($raw) > 8 * 1024 * 1024) fail(413, 'That photo is too large. Please try a smaller one.');
$in = json_decode($raw, true);
$b64 = is_array($in) && is_string($in['image'] ?? null) ? $in['image'] : '';
$bytes = base64_decode($b64, true);
if ($bytes === false || strlen($bytes) < 1000) fail(400, "We couldn't read that photo. Please try again.");
$info = @getimagesizefromstring($bytes);
$allowedMime = ['image/jpeg', 'image/png', 'image/webp'];
if (!$info || !in_array($info['mime'], $allowedMime, true))
  fail(415, 'Please use a JPG, PNG or WebP photo.');
$mime = $info['mime']; // trust the decoded bytes, not the client's claim
$b64 = base64_encode($bytes);

/* ---------- Ask each provider in turn ---------- */
$accepted = array_map('strtoupper', $config['accepted_plastics'] ?? []);
$lastError = '';
foreach ($config['providers'] ?? [] as $p) {
  $type = $p['type'] ?? '';
  if ($type === 'demo') {
    reply(200, ['ok' => true, 'provider' => 'demo', 'result' => normalize_result(call_demo(), $accepted)]);
  }
  if (empty($p['key'])) continue;
  foreach ($p['models'] ?? [] as $model) {
    try {
      $data = match ($type) {
        'gemini' => call_gemini($p, $model, $mime, $b64),
        'groq'   => call_groq($p, $model, $mime, $b64),
        default  => throw new ProviderError("unknown provider type '$type'", false),
      };
      reply(200, ['ok' => true, 'provider' => $type, 'result' => normalize_result($data, $accepted)]);
    } catch (ProviderError $e) {
      // Server log only, for debugging on Hostinger. No image data here.
      error_log('[luther-sort] ' . $e->getMessage());
      $lastError = $e->getMessage();
    }
  }
}

fail(503, $lastError === ''
  ? 'Luther Sort is not configured yet.'
  : "We couldn't identify that right now. Please try again in a moment.");
