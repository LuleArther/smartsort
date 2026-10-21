<?php
/* =========================================================
   LUTHER SORT, SERVER CONFIG (example)
   Copy this file to config.php (same folder) and fill in your
   keys. config.php is git-ignored and blocked from the web by
   api/.htaccess, never put real keys in this example file.
   ========================================================= */
return [

  /* AI providers, tried in this order. If one is rate-limited,
     down, or returns an unusable answer, the next one is tried.
     Leave a key empty to skip that provider. */
  'providers' => [
    [
      'type'   => 'gemini',
      // Free key: https://aistudio.google.com/apikey
      'key'    => '',
      // Tried in order, the first one that works is used. Model IDs
      // change over time; if every one returns 404, check the current
      // list at https://ai.google.dev/gemini-api/docs/models
      'models' => ['gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    ],
    [
      'type'   => 'groq',
      // Free key: https://console.groq.com/keys
      'key'    => '',
      // Must be a vision-capable model, see https://console.groq.com/docs/vision
      'models' => ['meta-llama/llama-4-scout-17b-16e-instruct'],
    ],
    // Local testing only: returns a fixed, clearly labelled sample
    // answer without calling any AI. Never enable on the live site.
    // ['type' => 'demo'],
  ],

  /* Plastic types Luther Plastics currently accepts from the public.
     Keep in sync with supply-partner.html on the main website. */
  'accepted_plastics' => ['PET', 'HDPE', 'PP', 'PVC'],

  /* Abuse protection, so free-tier quotas can't be burned by one
     visitor. Counts are per visitor IP, plus one site-wide daily cap
     that should stay below your providers' combined free limits. */
  'limits' => [
    'per_ip_per_minute' => 6,
    'per_ip_per_day'    => 40,
    'global_per_day'    => 800,
  ],

  /* Main website, used for links in the app. */
  'main_site' => 'https://www.lutherplastics.com',
];
