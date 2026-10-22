# Prompt variants spike, round 2 (throwaway)

Compares Gemini Nano prompt variants, the `@duckduckgo/autoconsent` text heuristics, and hybrid
pipelines that combine them. Each runs over 27 real captured fixtures and is scored
against an expected answer. The extension is plain JS with no build step. **Measurement only:**
nothing here clicks, hides or changes a page.

Round 1 lives in `../prompt-latency/`. Its results are the `../prompt-latency-*.json` files.

## Setup (once)

1. Check the model: `chrome://on-device-internals` → **Model Status** should show it ready.
   The round-1 bench already confirmed it on this Mac (Chrome 155, `available`).
2. `chrome://extensions` → Developer mode → **Load unpacked** → this folder
   (`spike/prompt-variants`).
3. The autoconsent heuristics load from `node_modules/` inside this folder. If
   `node_modules` is missing, run `npm install` here. It installs only `@duckduckgo/autoconsent@16.59.0`.

## 1. Mechanical baseline (no model, runs in Node)

```
node baseline.mjs
```

This prints one row per fixture and writes `baseline-results.json`. That file already holds
the results, so you don't need to run it.

## 2. Side-by-side bench

Click the toolbar icon → **Open bench**.

- The default selection is every variant except `g-def-tiny` and `d-baseline` (round 1
  already measured the baseline). It uses all 27 fixtures and 3 iterations, which the page
  estimates at about 10 minutes. Untick variants or fixtures to run less; the
  positives/negatives buttons select subsets.
- **greedy** asks for `topK: 1, temperature: 0`. That option is deprecated, but extensions still honour it.
  If this Chrome exposes `samplingMode`, the page uses `samplingMode: "most-predictable"` instead.
  The results record what the session reports back (`sessions.<variant>.<key>.topK/temperature`).
- Click **Run** and wait. Then click **Save results JSON** (or **Copy**).
- Optional second run: tick **greedy** and run again. Then compare the `consistent` column.

### What the table shows

- **correct**: runs that matched the expected answer.
- **FP / FN**: FP means the variant acted on a non-consent element. FN means it missed a real
  consent dialog.
- **ms**: median and p90 per decision. It excludes the one-time creation of the base session
  and the token measurement.
- **TTFT**: time to the first token of the first model call.
- **in tok**: `measureContextUsage` of the per-banner input, measured on iteration 0 only.
- **calls/run**: model calls per decision.
- **consistent**: fixtures where every iteration gave the same output.
- **The matrix below the table**: one row per fixture. A cell shows correct/n and the most
  common output; `*` means the iterations disagreed. Hover a cell to see every output.

The saved JSON has `summary` (one line per variant) and `perFixture` (expected, correct, outputs).
Both diff cleanly between runs. `raw` holds every run.

## 3. Cold start

### Bench button

1. On the bench page, set **wait** (try 0, then 60, then 300 seconds).
2. Click **Measure cold start**.
3. Choose where it runs:
   - **this page**: it destroys every session this extension holds, waits, then times
     `availability()` → `create()` → the first prompt. Then it does the same again warm.
   - **service worker**: same, but the page sends nothing to the service worker while it waits,
     so the worker goes idle and Chrome stops it (after about 30 s). `swAgeMs` shows how long the
     worker had been running; a small number means it was just restarted.

If the cold `createMs` grows with the wait, Chrome has unloaded the model from memory.
Compare it with a warm create of about 430 ms; round 1 saw 9 s on the first create.
Other tabs or extensions using the model keep it loaded, so close them for this test.

### Live mode

1. Live mode is on by default. The popup selects the pipeline (`h-safe` by default).
2. Close the bench tab. Wait more than 30 s without touching anything.
3. Visit `https://docs.nvidia.com/openshell/home`. When it loads, record the popup's top row.
4. Reload the page. Record the row again.
5. Repeat with `https://www.ikea.com/us/en/`, which needs the model, and with
   `https://www.pinterest.com/ideas/`, a login wall that only the gatekeeper should reject.
6. Click **Copy live results JSON**.

For each visit, the popup shows banner→decision ms, whether this was the service worker's first
decision, the worker's age, any base sessions it had to create (with ms), and the number of model
calls.

## 4. What to paste back

1. The bench JSON, default settings.
2. Optional: the bench JSON with **greedy** on.
3. The cold-start JSON. It is included in the bench JSON under `coldStarts` if you save after
   measuring.
4. The live-results JSON.

## Variants

| id | kind | idea |
|---|---|---|
| `m-autoconsent` | mechanical | Gate: autoconsent `checkHeuristicPatterns` must match and `isExcludedPopup` must not. Decision: `classifyButtonTextRegex` labels plus our toggle rules, then the shared chooser. No model. |
| `g-bare` | gate | "Is this a cookie or tracking consent dialog? yes/no". |
| `g-def` | gate | A definition plus explicit counterexamples: login, newsletter, chat, paywall, age gate, app/notification prompts, surveys, announcement bars. |
| `g-fewshot` | gate | The definition plus 5 synthetic examples. |
| `g-def-text` / `g-def-short` / `g-def-tiny` | gate | The definition with text only / text cut to 150 chars plus controls / text cut to 60 chars plus controls. |
| `d-baseline` | decide | The round-1 prompt, verbatim. |
| `d-rubric` | decide | A detailed priority rubric. It explains toggles, says to ignore category-name buttons and links, and adds `no_option` and `unsure`. |
| `d-fewshot` | decide | A compact rubric plus 4 synthetic worked examples. None of them are fixtures. |
| `d-labels` | decide | The model labels every control. Labels: accept, reject, settings, save, close, link, toggle-optional, toggle-necessary, toggle-optout, other. Deterministic JS then picks the action. |
| `d-narrow` | decide | Up to 3 one-token questions with an index enum: "which control refuses?", then "which saves?", then "which opens settings?". Toggles are decided by regex. |
| `h-fast` | hybrid | Regex labels first. Fast path: if the regex gate matches and there is a reject button, it decides with no model call. If the regex gate says no, the AI gate (`g-def`) runs. The AI labels only the controls regex couldn't classify. |
| `h-safe` | hybrid | Same, but the AI gate always runs unless the fast path applies. |

Decider outputs separate `no_option` (a consent dialog with no way to refuse, such as an
"Agree"-only dialog) from `unsure` (can't tell what the controls do). A failed parse is recorded
as `unparseable`.

## Fixtures (`fixtures/`, captured 2026-10-22 from a US IP)

There are 16 positives and 11 negatives. Every fixture has the same serialised shape that
`detect.js` produces, plus `kind`, `category`, `gate.expected`, `expected` (the acceptable
decisions) and, for round-2 captures, `detectorPicked` and `fullText` (up to 4000 chars).

- **Positives from round 1** (unchanged):
  - nvidia, stackoverflow, trustarc, pfa-cookiebot, hubspot, vestas, ikea
  - cnn: borderline
  - tv2-danish: non-English
  - nvidia-settings and arla-settings: second-stage settings panels
- **Positives new in round 2:**
  - jackdaniels-onetrust, huel-onetrust
  - chubbies-termly and drift-ketch: no reject button, so the answer is settings
  - tidio-cookiebot: an opt-out toggle that has to be switched **on**
- **Negatives:**
  - Login walls: pinterest and tiktok (the generic detector picks both up), instagram.
  - Newsletter: taylorstitch.
  - Promo: brooklinen.
  - Announcement bars: allbirds, drsquatch.
  - Paywall: newsweek.
  - Age gate: jackdaniels.
  - Chat widgets: livechat, taylorstitch-chat.
  - **Not captured** (none showed up from a US headless browser): notification soft-prompts,
    app-install banners, surveys, "we updated our privacy policy" notices.

Judgement calls:
- **cnn**: an "Agree"-only terms and data dialog. Gate = consent; decision = `no_option`
  (the user's decision). Whether to act on it is a product setting.
- **drift-ketch**: the only choices are "close banner" and "Open Preferences". Closing a US
  notice banner usually means implied consent, so the expected answer is `settings`.
- **chubbies-termly**: either "Preferences" button counts as correct.
- **nvidia-settings**: "Decline All" (`reject:12`) or "Save and Accept" with every toggle already
  off (`save:13`) both count as correct.
- **tidio-cookiebot**: the least-data answer is to switch ON "Do not sell and share my personal
  information", then Confirm. Only `d-labels`, the hybrids and the mechanical variant can express
  "turn on".

The round-2 serialiser skips `<select>`/`<option>` text, because an age gate's country list
drowned out the real text. Round-1 fixtures were captured before this change.

## Files

| File | Role |
|---|---|
| `variants.js` | Every prompt, the mechanical and hybrid logic, the chooser and the scorer. No `LanguageModel` calls. |
| `runner.js` | Every `LanguageModel` call: primed base sessions per prompt key, `clone()`, streaming, timing, the greedy option, the cold probe. |
| `bench.html` / `bench.js` | The side-by-side bench, an ES module. |
| `background.js` | Module service worker for live mode and the cold probe. |
| `content.js`, `detect.js` | Live-mode detection and serialisation. Read-only. |
| `popup.*` | Live results and the pipeline picker. |
| `baseline.mjs`, `baseline-results.json` | The Node mechanical baseline. |
