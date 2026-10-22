# Prompt API latency spike (throwaway)

Measures how long Chrome's on-device model (Gemini Nano, via the Prompt API's `LanguageModel`
global) takes to decide how to answer a cookie consent banner. Plain JS, Manifest V3, no build.
**Measurement only:** live mode never clicks, hides, or changes anything on a page.

## 1. Check that the on-device model works

Documented requirements (developer.chrome.com/docs/ai/get-started, checked 2026-10-22): macOS 13+,
**22 GB free** on the volume holding your Chrome profile (the model is deleted if free space drops
below 10 GB), and either a GPU with >4 GB VRAM or 16 GB RAM + 4 cores. You need an unmetered
connection only for the first download. You need no flag on current desktop Chrome. The Prompt API
has been available to extensions since Chrome 138.

1. Open `chrome://on-device-internals`. The **Model Status** tab shows whether the model is
   downloaded. If anything fails, the **Broker State** tab shows the error.
2. If the API is missing or always says `unavailable`, try `chrome://flags/#prompt-api` (it used to
   be `#prompt-api-for-gemini-nano`) → Enabled, and restart Chrome.

## 2. Load the extension

`chrome://extensions` → turn on Developer mode → **Load unpacked** → choose this folder
(`spike/prompt-latency`). After you change files, click the reload icon on the card.

## 3. Run the bench (canned fixtures, reproducible)

Click the extension's toolbar icon → **Open bench**. The bench page opens.

- The status line shows `availability()` from the bench page and from the service worker.
- If it says `downloadable` or `downloading`, click **Download model**. Downloads need a click
  (user activation). Wait for 100%. Then `chrome://on-device-internals` should show the model.
- Keep the defaults (5 iterations; both strategies; all three output modes; all fixtures). Click
  **Run benchmark**. That is 11 fixtures × 2 × 3 × 5 = 330 decisions, so expect several minutes.
- Then set **run in → service worker** and run it again. Live mode runs the model in the service
  worker, so it is the product-relevant context.
- Optional, if time allows: set **banner text chars** to `0` (controls only) and run once more.
  Prompt length is the main latency lever.

What it reports:
- **Session timings:** the first `create()` in the context, `create()` with and without the system
  prompt, creating the primed base session, and `clone()` from it. Plus `contextWindow` and the
  token usage of the system prompt.
- **Per fixture × strategy × output mode:** setup (`create` or `clone`), time to first token
  (`promptStreaming`), prompt time, decision time (setup + prompt) as min/median/max, input
  tokens (`measureContextUsage`), and correct/N against the fixture's expected answer.
- **Strategies:** `clone` clones a primed base session that already holds the system prompt.
  `fresh` calls `create()` with `initialPrompts` every time.
- **Output modes:** `schema` sets `responseConstraint` to a JSON schema. `schema-omit` adds
  `omitResponseConstraintInput: true`, so the schema stays out of the prompt tokens. `none` has no
  constraint; the bench parses the JSON from the model's text.

## 4. Live mode (real pages)

Live mode is on by default. The content script runs on every page. It finds a likely banner
(known vendor selectors first, then a generic fixed/high-z-index element that mentions
cookies, consent or privacy). It serialises the banner and sends it to the service worker,
which runs the model. The popup lists the last 50 results and the toolbar badge shows
banner→decision ms. The popup can also switch the model to run in the content script itself,
change the output mode, and change the text length. Reload the page after you change a setting.

Visit each of these twice: once after Chrome has been idle for more than 30 s, so the service
worker is cold, and once with a reload straight after:
`https://docs.nvidia.com/openshell/home`, `https://stackoverflow.com/questions`,
`https://www.trustarc.com/`, `https://www.ikea.com/us/en/`, `https://www.hubspot.com/`,
`https://www.pfa.dk/`. Add any sites of your own that show a banner.

Key fields per result. `t.*` values are ms since navigation start.
- `t.bannerFoundAt`: when detection first saw the banner. A human could start reading here.
- `t.aiAddedAfterBannerFoundMs`: banner seen → decision ready. This is the number to compare
  with a human clicking Reject.
- `t.serializeMs`, `t.scanCostTotalMs` (all detection scans), `t.messageOverheadMs`
  (round trip minus the worker's own work).
- `model.setupMs` / `ttftMs` / `promptMs`. `model.baseWasWarm: false` or
  `firstDecisionInThisSw: true` means the service worker had to build its session from scratch.

## 5. What to paste back

1. The bench JSON from the **this extension page** run: click **Copy results as JSON** (or **Save
   results as .json**).
2. The bench JSON from the **service worker** run.
3. The live-mode JSON: popup → **Copy live results as JSON**.
4. Your Mac model, chip and RAM (Apple menu → About This Mac). Also say whether anything else heavy
   was running.

Each JSON includes `navigator.userAgent` and the Chrome version.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3. Permission: `storage`. Content script on `<all_urls>` at `document_start`, in all frames. |
| `detect.js` | Banner detection and compact serialisation. The content script and fixture capture both use it. |
| `engine.js` | Every Prompt API call: prompt, schema, `decide()`, session timings, scoring. Used by the bench page, the service worker and the content script. |
| `background.js` | Service worker. Runs live-mode decisions (it clones a primed base session) and the bench's service-worker mode. Stores live results. |
| `content.js` | Live-mode timing harness. Read-only. |
| `bench.html` / `bench.js` | Fixture benchmark. |
| `popup.html` / `popup.js` | Live results and settings. |
| `fixtures/*.json` | Banners captured from real sites on 2026-10-22 with `detect.js`, plus `expected` answers. |

Fixtures were captured from a US IP, so some EU-only banners are missing. `nvidia-settings` and
`arla-settings` are second-stage OneTrust preference centres; the other nine are first-load
banners. `cnn` is a trap (an "Agree"-only terms dialog, where the right answer is `none`).
`tv2-danish` tests a language outside the documented model languages (en/ja/es/de/fr).
