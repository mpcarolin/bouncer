# Bouncer — design (phase 1: cookie consent)

Date: 2026-10-22. Status: draft for approval.

Bouncer is a Chrome extension that deals with cookie consent banners the moment they appear,
always choosing the option that gives the site the least data about you. It does as much as
possible with fixed rules and uses Chrome's built-in on-device model (the Prompt API, Gemini
Nano) only where judgment is needed.

Everything in this document was decided by the owner unless it is marked **(builder's call)**
(a call made during design that the owner hasn't explicitly confirmed) or listed under "Left to
the builder". Evidence comes from three throwaway spikes in `spike/` (see "Evidence" at the end).

## Why

Cookie banners interrupt every first visit, and the least-invasive choice is often buried
behind "Manage settings". The owner wants a tool they rely on every day, published on their
public GitHub and in the Chrome Web Store. Existing extensions in this space get poor reviews
for two reasons: they miss banners (false negatives), and they act on things that are not
cookie banners, such as hiding a chat widget (false positives). Bouncer has to be good at both.

Prior art (`spike/prior-art.md`): Gemini Nano has been pointed at cookie banners before (a
thesis project, CookieExtension; a Built-in AI Challenge entry, Agent Papaya). In both, the AI
picks the button, and both projects are unreleased or dormant. DuckDuckGo and Brave run LLMs on
consent popups only on their servers, to generate rules. Bouncer's distinguishing combination:
a mature rule engine first, then an on-device AI used as a *gatekeeper and labeller* (never the
decider), and silently working through settings panels to turn everything off.

## Goals

1. **Least data, actually recorded.** Bouncer refuses: it clicks reject, or opens settings,
   switches off every optional category and saves. Hiding a banner without answering it is
   not a success, because many US sites track by default until told no.
2. **Fast.** The goal is a banner gone **under 3 seconds** after it appears; faster is
   better. People landing on a page are usually reading before they get to the banner, and
   in the owner's POC testing most banners went in 0–2 s.
3. **No false positives.** Bouncer never hides or clicks anything that is not a cookie
   consent dialog. A missed banner is acceptable; touching a chat widget is not.
4. **Never get in the way.** Bouncer never interferes with scrolling, focus, typing or clicking.
5. **Private.** Nothing about the pages you visit leaves your machine. No server, no analytics,
   no network calls by the extension.

## Non-goals (phase 1)

- Newsletter modals, "get our app" banners, notification prompts, surveys, login walls,
  paywalls, age gates. These are later phases. In phase 1 the gatekeeper exists precisely
  to *leave these alone*.
- US "Do not sell or share my personal information" notices (for example theguardian.com/us).
  These are left alone in phase 1 (stretch goal below).
- Working without the on-device model. The model is a hard requirement (see Constraints).
- Browsers other than desktop Chrome.

## Anti-goals (failure even if it "works")

- Hiding or clicking a non-consent element: chat widgets, login walls, age gates, site
  announcement bars.
- Ever clicking "Accept"/"Agree" on the user's behalf unless the user has turned that on.
- Any visible interference: scroll jumps, stolen focus, swallowed clicks or keys.
- Too slow to matter: a banner that sits there longer than a human would take to dismiss it.
- Sending page content anywhere.

## Constraints

- **Chrome's on-device model is required.** Documented requirements (checked 2026-10-22):
  Chrome 138+, macOS 13+, 22 GB free on the profile's volume (the model is deleted below
  10 GB), and a GPU with >4 GB VRAM or 16 GB RAM with 4+ cores. The first model download needs
  a user click on an extension page (a service worker cannot trigger it).
- **Do not publish hardware or performance costs in the README until they have been
  benchmarked by the project itself.** The numbers above are Chrome's, not ours.
- **Nothing is submitted to the Chrome Web Store** until the owner has used the extension in
  their own browser (loaded unpacked) for a while and is satisfied.
- Manifest V3. Content scripts on all URLs are unavoidable for this job; keep every other
  permission to the minimum.
- `@duckduckgo/autoconsent` is MPL-2.0: Bouncer can use any licence for its own code, but
  changes to autoconsent's files must be shared. Don't fork its files; wrap them.

## Stack

TypeScript, Vite, pnpm (same as the owner's `astragent` project). Manifest V3.
`@duckduckgo/autoconsent` (16.x) for the rule engine and the text heuristics.
Project licence: MIT **(builder's call)**.

## How a page visit works

### 1. Known consent vendors: autoconsent's rule engine

autoconsent recognises the big consent platforms (OneTrust, Cookiebot, TrustArc, HubSpot,
Ketch, Termly, Cookie Information, Usercentrics, Didomi, …) and many specific sites. Bouncer
runs it in opt-out mode:

- The banner is hidden immediately (autoconsent's pre-hide).
- autoconsent performs the opt-out, including multi-step settings flows.
- Afterwards, autoconsent's self-test checks that the opt-out was stored, where the rule has one.
- Settings used in the spike, and kept: `heuristicMode: 'off'` (unknown banners belong to
  Bouncer's own path), and cosmetic-only rules off (they hide without refusing, which breaks
  Goal 1; those banners fall through to Bouncer's path).
- autoconsent's *generated* site rules (`auto_*`) stay on **(builder's call)**. They cover
  some home-grown banners, such as Dropbox and Deezer.

In the spike this path dismissed every real vendor banner that was tried, with the opt-out
confirmed in the stored consent. For example, Stack Overflow was gone 0.5 s after the banner
appeared, with every optional group refused.

### 2. Everything else: Bouncer's own path ("hybrid safe" in the spikes)

**a. Find a candidate.** Look for a visible fixed or sticky element, a high-z-index element,
or a dialog (`role=dialog` or `aria-modal`). Its text must mention cookies, consent or privacy,
and it must contain at least one button. Search inside open shadow roots. Then apply two
borrowed refinements:
- Skip elements with more than ~10 first-party links. These are headers and footers. (Brave's
  approach; their exact threshold.)
- Ignore the text of `<select>`/`<option>`, so a country list doesn't drown the real text.

Banners usually appear 1.4–3 s after navigation, after the page's load event, so detection
keeps watching (the spike watched for 20 s).

**b. Give autoconsent first claim.** If autoconsent recognises the same banner, Bouncer stands
down. Without this the two paths race: on Vestas both clicked. The spike waited for two more
autoconsent detection passes or 1.5 s, whichever came first, which costs about 0.5 s on the
no-model path. Bouncer starts its decision in parallel during that wait.

**c. Serialise.** Produce a compact description of the candidate: its text, and a numbered list
of controls with role, visible label, toggle state (on/off/disabled) and id. Detection takes
under 7 ms and serialisation about 1 ms.

**d. Gatekeeper (AI): "is this a cookie/tracking consent dialog?"** Nothing is hidden or
clicked until this says yes.
- Use the spike's `g-def-short` prompt: a definition plus explicit counterexamples, the first
  150 characters of text plus the controls, and a constrained yes/no answer.
- In the spike it scored 81/81 with 0 false positives across 16 consent banners and 11
  non-consent overlays (login walls, chat widgets, newsletters, promos, age gates, paywalls,
  announcement bars). It answered the same way every time. Median 0.44 s, p90 0.58 s.
- Few-shot examples made it worse (7 false positives). Don't add them.
- DuckDuckGo's gatekeeper prompt (tracker-radar-collector `post-processing/`) has useful
  negative examples. Compare it against ours.
- One exception, measured in the spike: if autoconsent's text patterns match *and* a control
  reads as reject, decide with no model call. This path still never acts on a dialog with no
  refuse option. It runs whether or not the model is available, so automated tests in browsers
  without the model can cover it **(builder's call)**.

**e. Label the controls.** autoconsent's `classifyButtonTextRegex` labels each control first.
The AI is asked to label only the controls the regex could not classify. Labels: accept,
reject, settings, save, close, link, toggle-optional, toggle-necessary, toggle-optout, other.

**f. Choose (deterministic code, never the AI).** In order of preference:
1. A reject-equivalent ("Reject all", "Necessary only", "Decline", "Continue without
   accepting"). Prefer a button over a link: without this rule, TrustArc's "Do Not Sell"
   link gets picked.
2. Save with every optional toggle off, and every opt-out toggle ("do not sell") turned *on*.
3. Open settings, then go to the second stage on the panel that appears (no gate needed there).
   This includes the owner's rule: **if "Close" sits next to a settings route, go through
   settings rather than clicking Close.** A settings route must open in place. **Never
   navigate the user away.** A "settings" link to another page doesn't count as a route.
4. Close (an X or a "Close" control) when nothing above applies: **click Close by default**,
   and log it as `dismissed (close)`. A setting can change this to "leave it" (`no_option`).
   Some vendors (Axeptio, Complianz, Osano) store Close as a refusal. On others, Close may
   count as implied consent, which is why it's last and why it's configurable.
5. No way to refuse ("Agree"-only, "OK"-only): the outcome is `no_option`.
6. Can't tell what the controls do: the outcome is `unsure`.

**g. Act.**
- Hide the banner once the decision is made, then call `.click()` on the chosen controls only.
- The spike's chooser never had to scroll an off-screen control (Le Monde's reject link starts
  above the modal) into view. If it must, do it without moving the page.
- **Verify** that the banner has gone. Where the vendor exposes it, also check the stored
  choice. Only then count it a success.
- If the page had locked scrolling, unlock it.
- The spike treated "still there after 3 s" as a failure.

**h. Remember.** When the AI path succeeds on a site, save what worked as a local per-site rule.
The next visit then needs no model call. Store it in autoconsent's JSON rule format, so it could
later be contributed upstream (stretch goal). If a learned rule stops working, discard it and
let the pipeline run again. Learned rules stay on the user's machine only.

### 3. Outcomes and defaults

| Outcome | What Bouncer does | Setting? |
|---|---|---|
| dismissed | banner gone, refusal recorded | — |
| not_consent | nothing touched | — |
| dismissed (close) | only Close was available; clicked it | yes: "click Close" (default) or "leave it" |
| no_option (Agree-/OK-only, or settings only via another page) | **leave it alone** | yes: "leave it" (default) or "agree to dismiss" |
| unsure / unparseable | nothing touched; restore it if it was hidden | — |
| failed (acted, banner didn't go or choice not stored) | **put the banner back** | yes: "put it back" (default) or "keep it hidden" |
| model unavailable | known vendors are still handled by autoconsent, and so is the no-model fast path (§2d); nothing else is touched | — |

`no_option` and `unsure` must stay distinct all the way through the code and the log.

The same outcome rules apply to autoconsent's path **(builder's call)**:
- If its opt-out errors, times out or fails its self-test, the outcome is `failed`. The user's
  "failed" setting applies, so by default the banner is un-hidden.
- If the rule has no self-test, Bouncer runs its own check that the banner has gone. A banner
  that is gone but has no stored-choice check is logged as `dismissed (unverified)`.
- Do this by listening to autoconsent's messages (`optOutResult`, `selfTestResult`, `autoconsentDone`)
  and using its un-hide mechanism, not by editing its files.

## The on-device model

**Measured** on the owner's Mac (Apple Silicon, 16 GB, Chrome 155):

| Operation | Time |
|---|---|
| Cold start (load model + create session) | 9.6 s, about 10.3 s to the first answer |
| Creating a session from scratch while the model is loaded | ~0.43 s |
| Cloning a primed session (system prompt already loaded) | ~0 ms |
| Gate answer | ~0.44 s median |

The model appears to unload as soon as no session holds it: a cold start after a zero-second
wait still took 9.6 s. That is one observation, not a certainty.

Decisions:
- **Keep the model loaded, configurable (owner).** By default a hidden extension page (an
  offscreen document) holds one primed session open, so every decision clones it at ~0 ms. A
  setting switches to "warm up when a page starts loading". That option hides about 2 s of the
  cold start, because banners arrive ~2 s after navigation.
- Before this default is final, measure the memory it costs. This is owed.
- The service worker is killed after ~30 s idle and loses any session it holds. Don't keep the
  primed session in the service worker.
- **Time-box every Prompt API call.** `availability()` hung indefinitely in a browser without
  the model.
- **First run:** an onboarding page checks availability and offers the (user-clicked) model
  download with progress. If the device can't run the model, it says so plainly.
- Languages: the model documents en/ja/es/de/fr only. A Danish banner worked in the spike.
  Treat other languages as best effort.

## What the user sees

- **While browsing: nothing (phase 1 is silent).** No badge, toasts or icons change. The
  spike's toolbar badge was a measuring tool; drop it **(builder's call)**.
- **Settings page** (opened from the toolbar icon):
  - global on/off
  - disable on this site
  - the two defaults in the table above
  - keep model loaded / warm on navigation
  - learned-rules list with delete **(builder's call)**
  - model status and download.
- **Decision log** on the settings page. It ships in the Store build too. Per decision: site, time,
  path (autoconsent rule name / heuristic / AI / learned rule / deferred), gate result, labels,
  what was clicked and which toggles changed, timings (found, decided, gone), model calls, cold
  vs warm, verification result, and outcome. Keep it local and exportable as JSON.
  **Retention: the last 24 hours. Discard older entries.** The retention period is a
  configurable value in code, but there's no settings UI for it in phase 1.

## Testing and release

- **Development fixtures:** `spike/prompt-variants/fixtures/` (27: 16 consent, 11 non-consent).
  Use them as unit tests for the gate, labeller and chooser, and as the AI benchmark. They hold
  serialised banners, not page markup, so testing the detector and serialiser needs new page
  captures. Take those from sites outside the held-out set.
- **Held-out set: `spike/test-sites.md`** (41 live sites, none used for tuning). It includes 10
  home-grown banners autoconsent doesn't know, about 12 with no reject button, and adversarial
  cases (Le Monde's off-screen reject link, Bank of England's "necessary only" wording, the
  iubenda banner in a closed shadow root). Freeze the rules, then measure against this set
  once. Never tune against it. If it gets tuned on, capture a new held-out set.
- **DuckDuckGo's labelled button-text CSV** (in the autoconsent repo) is a free multilingual
  test for the labeller.
- **Automated** (Puppeteer/Playwright with the extension loaded): the autoconsent path and the
  non-AI path on live sites. The AI path can't be automated: test browsers don't ship the
  on-device model. Test it by hand in real Chrome, guided by the decision log.
- **Latency target:** a banner gone under 3 s after it appears, measured from the decision
  log on the held-out set with the model warm. Report the cold-start case separately.
- **Benchmarks** feed the README's statement of costs (latency, memory, disk). Publish none
  before measuring.
- **Release gate:** dogfooding in the owner's Chrome (loaded unpacked) until the owner is
  satisfied. Then the Store.

## Known limitations (found in the spikes)

- **Closed shadow roots** (iubenda's new banner) are invisible to page scripts. The spike
  could see inside only through the accessibility tree.
- **The AI path runs in the top frame only.** autoconsent covers its known iframe banners;
  unknown banners in cross-origin iframes are missed.
- **When autoconsent reports a vendor but no popup** (TikTok), Bouncer stands down and may miss
  another overlay on that page.
- **The generic detector misses** banners whose markup doesn't mention cookies or consent and
  that have no dialog role.
- **Sites that reload after consent** (Huel) work, but the reload restarts detection.

## Stretch goals (not phase 1)

- **Shareable rules:** an open path for contributing site rules as pull requests (learned rules
  are already in autoconsent's format). The reject-cookies project's report → screenshot → LLM
  pull request loop is a working template.
- **Opting out of US data sale** on "Do not sell or share" notices.
- **Later phases:** newsletters, app-install prompts, notification prompts, and possibly other
  overlays. The name "Bouncer" was chosen to cover these.

## Left to the builder

- Module layout, message passing, and what runs in the content script, service worker and
  offscreen document (beyond the session-holding rule above).
- Exact timeouts and wait windows (the spike's values are starting points), prompt wording
  improvements measured against the fixtures, log size, the settings page design, and the
  onboarding page design.
- Whether to lift code from `spike/bouncer-poc/`. It is throwaway, written without tests, so
  treat it as a reference, not a base.

## Evidence

- `spike/prompt-latency/`: first latency benchmark.
  `spike/prompt-latency-*.json` holds the owner's results.
- `spike/prompt-variants/`: gatekeeper and decider prompt comparison, the rules-only baseline
  and the hybrids. `spike/prompt-variants-*.json` holds the results.
- `spike/bouncer-poc/`: working POC that dismisses banners. Its `README.md` lists what was
  verified.
- `spike/test-sites.md`: held-out live sites.
- `spike/prior-art.md`: prior art, with sources.
