# SmartSort

AI-assisted waste identification and sorting for recycling stations: the MVP described in the SmartSort PRD (Luther Plastics Ltd, MTN Apache Foundation Environment Challenge).

An operator shows one item to a camera, or uploads a photo. SmartSort predicts the material, shows its confidence, and recommends a collection bin. The operator then confirms, corrects, or sends the item to manual inspection, and the result is recorded. If a result is uncertain, SmartSort never recommends a material bin. The item goes to the manual inspection area, and the screen lists the reasons.

It lives in `public/smartsort/`, next to the existing public "Luther Sort" page (`public/index.html`), and does not change that page.

## Online (free): GitHub Pages

**Live site: https://lulearther.github.io/smartsort/**

It's served free with HTTPS (needed for the camera) from the `gh-pages` branch. To publish changes, commit to `main`, then:

```sh
sh tools/deploy-pages.sh     # pushes public/smartsort/ to gh-pages; live in about a minute
```

### This PC as the AI server for everyone

While the Luther PC runs the AI server, **everyone using the link** gets the Vision AI from the PC's GPU: phones, other laptops, anywhere. When the PC is off, the site falls back to the built-in model in each browser, and switches back by itself when the PC returns.

Double-click **`tools/vision-server/start-ai-server.cmd`**, or run `node tools/vision-server/start.mjs`. Keep the "SmartSort AI server" window open; close it to go offline.

On the Luther PC it starts by itself at login, via `SmartSort AI server.cmd` in the Windows Startup folder (`shell:startup`); delete that file to stop it starting automatically. Ollama also starts at login.

What it does:

1. Starts a **gatekeeper** (`tools/vision-server/server.mjs`) on `127.0.0.1:11435` in front of Ollama. It lets through only one kind of request: one image, sent to the vision model, from the SmartSort site.
   - Downloading, deleting or running other models is refused, and so is text-only chat.
   - Requests are limited in size and rate, and queued so the GPU is not swamped.
   - Photos are never stored or logged, and visitor IPs are logged only as anonymous hashes.
   - Ollama itself stays private on the PC.
2. Opens a free **Cloudflare quick tunnel** (no account needed) to the gatekeeper. `cloudflared` is downloaded to `%LOCALAPPDATA%\SmartSort\` on first run.
3. Publishes the tunnel's current address to `endpoint.json` on the repo's `vision-endpoint` branch, which the website reads. Quick tunnels get a new address each start; this step is what lets the same link keep working. If the tunnel drops it is reopened and republished, and on exit the PC is marked offline.

It needs Ollama running with `qwen2.5vl:3b`, and the GitHub CLI logged in (`gh auth login`), which is used to publish the address.

Notes:

- The GPU is shared: a 3B model answers one picture at a time, so many live viewers at once slow each other down.
- Quick tunnels have no uptime guarantee. For a permanent address, create a free Cloudflare account, set up a named tunnel, and point the site at it.
- Visitors see a notice that their photos are sent to the Luther Plastics AI computer.

What works where:

- **Any device** (phones, laptops): camera, upload, live detection, records, dashboard and training all run in the browser. Identification uses the built-in waste model, so no internet is needed after the first visit and nothing is sent anywhere.
- **The station PC with Ollama:** open **https://lulearther.github.io/smartsort/?station** (or Settings › Vision AI › *Use this computer's Ollama*). When the browser asks to let the site access devices on your local network, choose **Allow**. SmartSort then uses the Vision AI, and remembers the choice in that browser.
  - Ollama must trust the site. On the development PC this is already set; on a new station PC run this once and restart Ollama:

    ```bat
    setx OLLAMA_ORIGINS "https://lulearther.github.io"
    ```

  - The website never contacts Ollama by itself, so visitors are not shown that permission prompt.

Records and training photos are stored in each browser separately: export them from History or the Train tab to combine them.

## Run it locally

Any static web server works. Camera access needs `https://` or `localhost`.

```sh
cd public
python -m http.server 8765
# open http://localhost:8765/smartsort/
```

To deploy on Hostinger, upload `public/` as it is. SmartSort is then at `https://<subdomain>/smartsort/`. Turn on the HTTPS redirect in `public/.htaccess` once SSL is active, because phones only allow the camera over HTTPS.

There is no build step and nothing to install. Inference runs in the browser, with ONNX Runtime Web (the waste model, using WebGPU on the graphics card where available) and TensorFlow.js (the other engines). The model files are served from this site, and a service worker caches them, so after the first visit a station keeps working offline.

## Vision AI (recommended): identifies anything in view

SmartSort's most accurate engine is a **vision-language model running in [Ollama](https://ollama.com) on the station's own computer**. It is free, works offline, and photos never leave the machine. One request per frame returns **every item in view**, with:

- an outline box,
- its name ("water bottle", "t-shirt", "bunch of bananas"),
- its material in plain words,
- for plastics, the likely resin type (PET, HDPE, PP, LDPE, PVC, PS).

SmartSort maps those words to its categories: plastic, glass, metal, paper/cardboard, organic, **textile, wood, ceramic/stone, rubber, leather, electronics**, and **Multiple materials** for devices built from several materials (laptops, phones, tablets, monitors, printers, appliances), which go to e-waste / mixed-material collection. Accessories such as keyboards and mice keep the single material the model sees. In live view, at most 6 items are shown, largest first, each with a numbered badge that matches the list beside the video; parts of an item (the keys of a keyboard) are left out. In plastic mode it maps them to PET/HDPE/PP/LDPE…, and anything that isn't plastic is reported as "Not plastic: …". **People are recognised and shown as "Person · not waste"**, never sorted.

Setup (already done on the development PC, RTX 5060):

```sh
# install Ollama from https://ollama.com, then:
ollama pull qwen2.5vl:3b      # 3.2 GB; ~1 s per picture on a mid-range GPU, precise boxes
```

SmartSort detects Ollama by itself and switches both modes to Vision AI the first time it finds it. It keeps falling back to the built-in waste model whenever Ollama isn't running, and retries every 30 seconds. Settings › Vision AI sets the address and model; `gemma3:4b` also works, but it is slower and its boxes are rougher.

**Opening SmartSort from the website instead of localhost:** Ollama only accepts requests from pages it trusts. On the station PC, set the site address once and restart Ollama:

```bat
setx OLLAMA_ORIGINS "https://your-subdomain.lutherplastics.com"
```

The browser may also ask for permission to access devices on the local network; allow it.

Tested on 15 free-licensed photos (Wikimedia Commons). It got right: a person, a T-shirt (cotton → textile), a wooden plank with a metal rivet, floor tiles (ceramic), rain boots (rubber), a handbag (leather), a jerrycan (HDPE), PET water bottles, an aluminium can, four glass bottles, a carrier bag (LDPE) and a bunch of bananas. In a three-item table scene, each item was outlined and sorted once. Known misses: a straw hat came back as "wood", a polypropylene mint box as "PS", and one jerrycan's material was called "rubber". Some well-known objects are therefore corrected by name in `js/engines/vision.js`, e.g. jerrycan → HDPE.

## Operating modes and engines

There are two modes, switched at the top of the screen:

- **General waste:** plastic, glass, paper and cardboard, metal, organic, other.
- **Plastic type:** PET, HDPE, PP, LDPE, other or unknown. PVC and PS are available but off by default.

Each mode has its own engine, chosen in Settings:

| Engine | What it is | When to use it |
|---|---|---|
| **Vision AI** (auto-selected when Ollama is running) | Vision-language model in Ollama (default `qwen2.5vl:3b`) | Best accuracy and the widest range of materials, people recognised, several items per picture. ~1 s per picture. Confidence is the model's own high/medium/low rating; only "high" is acted on. |
| **Waste model** (default, general mode) | YOLOv8n classifier trained on ~25,000 waste photos (metal, organic, paper/cardboard, plastic, glass) from [WasteDetector](https://github.com/xrl3y/WasteDetector) (MIT), converted to ONNX at 640 px | General waste, including live detection. 10 ms per frame on this PC's GPU, ~95 ms on CPU only. It has no "other" or "nothing" class, so it always names the closest of its five types. |
| **Baseline** | MobileNet V2 (ImageNet) plus a rule-of-thumb map from object type to material, e.g. "water bottle" → PET | Demos, out of the box. It recognises objects, not materials, so most plastic-type results come back uncertain. |
| **Local model** | k-nearest-neighbours over MobileNet features of photos taken in the **Train** tab | The real path for PET/HDPE/PP/LDPE at a station. Train it with verified items under the station's own lighting. |
| **Custom model** | Any TensorFlow.js image classifier, e.g. a Teachable Machine export (model.json + weights.bin + metadata.json) | When a model is trained elsewhere. Class names must match category names; a class called "Empty"/"Background" means no item. |
| **Cloud AI** | Sends the photo to `public/api/identify.php` (Gemini, then Groq) | Optional and needs internet. Photos leave the device, and the UI says so. Its confidence is the AI's own high/medium/low rating, not a probability; only "high" is accepted. |

A new engine is one module with a `classify()` function, registered in `js/engines/index.js`.

## When is a result trusted?

A result is **confident** only if all of these hold:

- the top category reaches the mode's minimum confidence (default 55% general, 70% plastic);
- it leads the second choice by the minimum margin (default 15% / 20%);
- the engine recognised the item. The local model also requires a minimum similarity to at least one training photo;
- the image is not too dark, overexposed or blank.

Anything else goes to manual inspection, and the screen lists every reason. Thresholds, categories, bin names, instructions and colours can all be changed per mode in Settings.

## Live detection (Sort tab)

Turn on **Live detection** below the camera. It stays on by default once the camera starts. There are two layouts:

- **Hand-held:** hold one item inside the square. The centre of the frame is classified continuously, averaged over recent frames, and shown over the video. Press **Space** to record the item through the normal confirm/correct flow. You can also tick *Record stable results automatically*: each new item is then recorded once, and a new record is only made when the answer or the picture changes.
- With **Vision AI**, both layouts outline every item the model sees (about 1 scan per second). An item is decided once two scans in a row agree. In table layout, *Learn empty background* is optional but recommended: the model is then only trusted where something actually differs from the empty surface, which stops a textured belt being mistaken for a bag.
- **Table / conveyor:** the camera is fixed, looking down at a plain surface. Clear the surface and press **Learn empty background**. Every item placed on it is then found, boxed and tracked. Each item gets one decision: a material bin once its averaged confidence passes the mode's thresholds, or manual inspection if it doesn't within `maxFrames`. That decision is recorded as **Auto (unverified)** and sent to the machine link. Operators can verify or correct auto records from the live list or in History; only verified records count towards accuracy.

Items are found by comparing each frame with the empty background (shadows are ignored), so this layout needs a fixed camera, a plain surface that contrasts with the items, and steady light. Items touching each other merge into one box. Tune sensitivity, minimum size and frame counts in Settings › Live detection.

## Machine link (for the future sorting machine)

In table/conveyor mode, each decided item is sent as one line of JSON over **USB serial** (Web Serial, Chrome/Edge) or **WebSocket** (Settings › Machine link):

```json
{"type":"sort","id":"…","track":3,"mode":"general","category":"glass","bin":"Glass collection bin","confidence":0.998,"x":0.803,"y":0.695,"w":0.288,"h":0.392,"ts":"…"}
```

- `x`, `y` are the item's centre in the camera frame, from 0 to 1 starting at the top left. `w`, `h` are the box size. Converting these into arm or gate coordinates is a calibration step on the controller.
- Uncertain items are sent as `"type":"manual"` (configurable) and never as a material bin.
- Every command is also dispatched in the page as a `smartsort:command` DOM event.
- [tools/controller-example/smartsort_controller.ino](tools/controller-example/smartsort_controller.ino) is a minimal Arduino/ESP32 sketch that turns a diverter servo per category.

This link is not a safety system. The machine needs its own hardware emergency stop, guards and interlocks.

## Training the local model (Train tab)

1. Switch to the mode you want to train, usually Plastic type.
2. For each category, capture or upload photos of **verified** items: resin code checked, or tested. Aim for 20+ per category: different sides, clean and dirty, whole and crushed. The ×10 button takes 10 photos while you turn the item.
3. Add photos of the empty inspection area to **No item**.
4. Press **Run evaluation**, then **Use local model for this mode**.
5. While sorting, tick "Add this photo to the training set" on a result to add an operator-verified example. Nothing learns automatically.

Training sets can be exported and imported between stations. Only feature vectors and small thumbnails are stored, never the full photos.

## Records and dashboard

- A record is written only when an operator confirms, corrects or sends an item to manual inspection. Discarded captures and frames left in view are never counted. If a capture looks like the item recorded just before, SmartSort shows a warning.
- Each record keeps the prediction, confidence, final category, status, timestamp, station, engine, model version, response time, optional weight and the reasons for uncertainty.
- **Dashboard** (per mode, by session/today/7 days/all time) shows items per category, verified accuracy with its sample size, uncertain and correction rates, recorded mass, mass sent to recycling streams, median response time, activity over time, and a predicted-vs-confirmed table.
- **History** has filters, weight editing after the fact, and CSV/JSON export.
- Weight is only what operators type in from a scale. Environmental-impact figures are deliberately not calculated until Luther Plastics agrees a documented method.

Everything is stored in the browser's IndexedDB on that device. There is no central database yet; use export to collect data.

## Keyboard shortcuts (Sort tab)

`Space` capture (also in live mode) · `Enter` main action · `C` correct / identify manually · `1`–`9` pick a category · `M` manual inspection · `Esc` discard

## Honest limitations

- The Vision AI judges material from appearance and common knowledge ("clear drink bottle → PET"). It is a strong guide, but not a chemical test. A small model can still misjudge unusual items, so start with operators confirming results.
- An ordinary camera cannot reliably tell polymers apart: PET, PP and HDPE can look identical. SmartSort's plastic-type result is a **prediction**, not a material identification. Industrial use would need a material sensor (e.g. NIR) or another verification method.
- The baseline engine is a demonstration aid, not a waste model.
- The waste model's 94% figure is its authors' own validation split. On 13 unrelated web photos it got 9 right; the misses were a crushed can, a degraded bag and a bottle in a street scene. Measure it on Luther Plastics' own items before relying on it. To improve it, retrain the same YOLOv8n-cls model on local photos (Ultralytics `model.train(...)`, as in WasteDetector's `Train.py`), then re-export with `tools/export-waste-model.py`. Adding "other" and "empty" classes would fix its biggest gap.
- Table mode finds items by background difference, not by a detection model. For cluttered, overlapping waste on a moving belt, the next step is a YOLOv8 **detection** model trained on labelled photos from the line. The live pipeline (tracker, decisions, machine link) is built to take one in place of the background finder.
- The local model's leave-one-out score is optimistic, because photos of the same item look alike. The real measure is Verified accuracy on the dashboard during supervised sorting, compared with a documented manual baseline.
- No physical sorting hardware is connected yet (PRD Phase 4).

## Files

```
public/smartsort/
  index.html, css/smartsort.css, sw.js, manifest.webmanifest, .htaccess
  js/app.js            Sort screen, recording, session counters, engine status, shortcuts
  js/config.js         modes, categories, bins, thresholds (defaults + saved settings)
  js/decision.js       confidence / margin / quality rules -> confident | uncertain | no item
  js/camera.js         camera, upload, cropping, image-quality checks, duplicate hash
  js/store.js          IndexedDB (records, thumbnails, training samples)
  js/records.js        statistics and CSV export
  js/engines/          vision (Ollama vision model), waste (YOLOv8 ONNX), features (TF.js + MobileNet), baseline, knn (local), custom, cloud
  js/live/             live loop + overlay, object finder, tracker, machine link
  js/views/            dashboard, history, train, settings
  vendor/tf.min.js     TensorFlow.js 4.22.0 (Apache-2.0)
  vendor/ort/          ONNX Runtime Web 1.20.1 (MIT)
  models/waste_yolov8n_cls/      WasteDetector YOLOv8n-cls, ONNX 640 px (MIT, see LICENSE-WasteDetector.txt)
  models/mobilenet_v2_100_224/   MobileNet V2 weights (Apache-2.0) + ImageNet labels
tools/deploy-pages.sh   publishes public/smartsort/ to GitHub Pages (gh-pages branch)
tools/fetch-vendor.mjs  re-downloads vendor/ and the MobileNet model (node tools/fetch-vendor.mjs)
tools/export-waste-model.py  converts a YOLOv8 classification .pt to ONNX for SmartSort
tools/controller-example/    Arduino/ESP32 sketch for the machine link
```

Before commercial deployment, review the licences of any training data and models (PRD §11).
