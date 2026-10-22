# Bouncer POC, spike round 3 (throwaway)

This extension actually dismisses cookie banners, so you can feel the latency while browsing.
It always picks the option that gives the site the least data. It is a spike: plain JS, no
build step, no tests.

## Load it (and unload round 2 first)

1. Open `chrome://extensions` and **Remove** "Cookie banner prompt variants (spike round 2)".
   If you still have "Cookie banner Prompt API latency spike", remove that too. Two
   extensions must never act on the same pages.
2. Turn on Developer mode → **Load unpacked** → choose this folder (`spike/bouncer-poc`).
3. `node_modules/` (only `@duckduckgo/autoconsent@16.59.0`) is already installed here. If it
   is missing, run `npm install` in this folder.
4. Pin the toolbar icon so the badge stays visible.

It is ON by default. Click the popup to get a global on/off switch and a "disable on this site"
checkbox. Changes apply on the next page load.

## What it does on each page

1. **Known CMPs → autoconsent.** This path uses `@duckduckgo/autoconsent`'s own rule engine
   (1,159 compact rules) in opt-out mode, with the content script and background protocol from the
   package's reference addon (`dist/addon-mv3`):
   - Known CMP containers are pre-hidden from `document_start`.
   - autoconsent runs the opt-out, including multi-step settings flows, and then runs its own
     self-test where the rule has one.
   - Main-world `eval` snippets run through `chrome.scripting.executeScript`.
   - Its heuristic clicking and cosmetic-only rules are switched **off**. Unknown banners
     belong to path 2.
2. **Everything else → the round-2 `h-safe` pipeline, using the `g-def-short` gate.**
   - autoconsent gets first claim. The pipeline waits until autoconsent has made two more
     detection passes after the banner appeared, or 1.5 s, whichever comes first. If it claims
     the banner, ours stands down and the log says "deferred".
   - **Fast heuristic path:** autoconsent's text patterns match *and* a button reads as "reject".
     It clicks reject without calling the model.
   - Otherwise, **the Gemini Nano gate must say "consent"** before anything is hidden or
     clicked. The AI then labels only the controls the regex couldn't classify, and the JS
     chooser decides:
     - `reject`: click it.
     - `save`: switch off optional toggles, switch on "do not sell" opt-out toggles, then save.
     - `settings`: click it, wait for the preference panel, then decide on the panel the same way.
   - The banner is hidden only once the decision is made.
   - If the banner doesn't go away within 3 s, the action **failed**. The banner is put back.
   - `no_option` (Agree-only), `unsure`, "not a consent dialog", model unavailable and any error
     all mean **left alone**: nothing is touched.
   - Page scroll is unlocked after a successful dismissal if it was locked. After an autoconsent
     opt-out it is unlocked only if still locked 0.6 s later.
3. **What it never does:** scroll, move focus, or capture events. It only calls `.click()` on the
   chosen controls. The AI path runs in the top frame only; autoconsent runs in all frames, as
   its reference addon does.

## Toolbar badge

- **Green number**: ms from navigation start until the banner was gone.
- **–**: a banner was seen but left alone.
- **!**: an action failed.
- **Empty**: no banner was found. Also empty for "deferred" until autoconsent finishes.

Sites that reload themselves after consent clear the badge, because the badge resets on each
page load.

## Popup decision log (last 50)

Each row shows the site and the path taken: `autoconsent: <rule name>`, `heuristic`, `ai`, or
`deferred` (hidden unless you tick the box). It also shows:
- the gate result and what was clicked;
- found / decided / gone, in ms since navigation start;
- model calls, and whether a call paid a **COLD** start (a base session took more than 2 s to
  create);
- autoconsent click count and self-test result;
- the outcome.

**Copy log JSON** exports everything. The export also includes per-call timings, any base
sessions created and how long each took, and the service worker's age.

## Try it

- **Known CMPs:**
  - `https://docs.nvidia.com/openshell/home` (OneTrust)
  - `https://stackoverflow.com/questions` (OneTrust)
  - `https://www.pfa.dk/` (Cookiebot)
  - `https://www.trustarc.com/` (TrustArc)
  - `https://www.hubspot.com/`
  - `https://www.vestas.com/en` (Cookie Information)
  - `https://www.drift.com/` (Ketch)
  - `https://www.chubbiesshorts.com/` (Termly)
  - A rule only acts when the banner shows, so once you have opted out on a site, use a private
    window or clear that site's data to see it again.
- **Must be left alone:** `https://www.pinterest.com/ideas/` (login wall), `https://www.cnn.com/`
  (Agree-only), and chat widgets such as `https://www.livechat.com/`.
- **Cold start:** close every tab that uses the model and wait more than 30 s, so the service
  worker stops and the model unloads. Then visit a page that needs the AI path. Its log row
  shows `COLD start` and the base-session create time. Reload, and the row should say `warm`.
- **Local test pages** for the non-CMP paths:
  1. From the `cookie-accepter` folder, run `python3 -m http.server 8765 --bind 127.0.0.1 -d spike/bouncer-poc/testpages`.
  2. Open the pages listed in the table below.

| Page | Expected |
|---|---|
| `http://127.0.0.1:8765/custom-reject.html` | Heuristic fast path clicks "Reject all"; no model call. |
| `http://127.0.0.1:8765/custom-settings.html` | Needs the model. The gate says consent → click "Cookie settings" → panel → switch Analytics and Marketing off, "Do not sell" on → "Save choices". Status shows `ana=false,mkt=false,dns=true`. Scroll gets unlocked. |
| `http://127.0.0.1:8765/agree-only.html` | `no_option` → left alone. |
| `http://127.0.0.1:8765/login-wall.html` | The gate says not consent → left alone. |
| `http://127.0.0.1:8765/broken-reject.html` | Reject does nothing → failed → banner put back. |

## What to paste back

Browse normally for a while with it on. Then click **Copy log JSON** and paste it, and add a line
on how it *felt*. Which banners did you still see flash? Did anything you needed disappear?

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3. Permissions: `storage`, `scripting`, `tabs`, plus `<all_urls>` host access. |
| `background.js` | Module service worker: the autoconsent background protocol, the pipeline, the log and the badge. |
| `bouncer.js` | Top-frame content script for path 2 (detect → decide → hide → act → verify or restore). |
| `detect.js` | Banner and preference-panel detection and serialisation (round 2, extended). |
| `variants.js`, `runner.js` | The round-2 pipeline (`h-bouncer` = `h-safe` with `g-def-short`) and all `LanguageModel` calls. |
| `popup.*` | Decision log and on/off switches. |
| `mock-model.js` | Test hook only. When `chrome.storage.local.debugMockModel` is `true`, it swaps in a deterministic fake model so the AI path's page mechanics can be tested without Gemini Nano. Off by default, with no UI. |
| `testpages/` | The local pages above. |
