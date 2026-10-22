# Prior art: on-device / built-in-LLM cookie consent handling

Researched 2026-10-22. Question: has anyone already built "Bouncer": autoconsent rules first, with an on-device LLM (Chrome Prompt API / Gemini Nano) as a fallback gatekeeper for unrecognised banners. The deterministic code always picks the least-invasive option.

Bottom line: **nobody has shipped Bouncer's specific combination.** Two shipped or published projects run Gemini Nano on cookie banners, but both use AI first, are small, and lack the safety architecture. The closest *architecture* is DuckDuckGo's own **offline** rule-generation pipeline. It does the same gatekeeper and button-classification steps with an LLM, but in a crawler with a cloud model, not in the browser.

---

## 1. Closest matches, ranked

### 1.1 JokubasBu/CookieExtension (thesis workspace): **close**
- Link: https://github.com/JokubasBu/CookieExtension
- Model / where: Chrome built-in `LanguageModel` (Gemini Nano) in the extension, with an OpenAI provider as an alternative ([chrome-builtin-provider.ts](https://github.com/JokubasBu/CookieExtension/blob/main/extension/src/lib/chrome-builtin-provider.ts), [background/index.ts](https://github.com/JokubasBu/CookieExtension/blob/main/extension/src/background/index.ts)).
- What it does: scans the DOM for banner candidates, ranks the controls, and sends a compacted snapshot to the model. The model returns JSON (`banner_detected`, `step_type`: direct_action / open_options / no_good_option, and a target control). It uses `responseConstraint`. It can open settings once and re-ask, but **it does not toggle category sliders**. The code's own failure message says: "the extension does not toggle category sliders". A "normalizer" overrides unsafe picks: when the model selects "Allow all", it substitutes the Preferences button.
- Rules + AI? **AI-first, no CMP rule engine.** Deterministic code only ranks controls and vetoes unsafe choices.
- Trigger: **manual.** The popup sends `analyzeTab` and then `applyRecommendation`, and the content script only answers messages ([content/index.ts](https://github.com/JokubasBu/CookieExtension/blob/main/extension/src/content/index.ts)). It is not silent on page load.
- Status: 0 stars, a single "init" commit dated 2026-05-20, described as a "Cookie banner thesis workspace". Not on the Web Store.
- **Useful data: a benchmark on 41 labelled real sites, mostly Lithuanian, including negatives** ([results/](https://github.com/JokubasBu/CookieExtension/tree/main/benchmark/results)). I computed these from the CSVs:

  | model | banner-detected match | action match | overall match | median latency |
  |---|---|---|---|---|
  | Gemini Nano (on-device) | 40/41 | 29/41 | **25/41 (61%)** | ~3.1 s |
  | gpt-5.4-nano (cloud) | 41/41 | 37/41 | 35/41 | ~2.3 s |
  | gpt-5.5 (cloud) | 41/41 | 41/41 | 41/41 | ~4.9 s |

  Nano is good at **detection** (the gatekeeper job) and weak at **choosing the action** end to end. That supports Bouncer's split: Nano labels, regex and deterministic JS decide.
- How it differs from Bouncer: no autoconsent first pass, AI chooses the action, no toggle-off-and-save, manual trigger, no learned rules. Its fixtures overlap with our test cases (`more-options-toggle-save.html`, `no-good-option.html`, `more-options-necessary-button.html`).

### 1.2 Agent Papaya (formerly Papaya CookieMonster): **partial overlap**
- Links: GitHub https://github.com/papayaverse/agent_papaya (and the older https://github.com/papayaverse/cookie_monster); Web Store https://chromewebstore.google.com/detail/llnpmgaejhooellpbbbicjhdfipckdka; Devpost https://devpost.com/software/papaya-cookiemonster
- Model / where: Gemini Nano through `LanguageModel.create`, in the background script ([background.js](https://github.com/papayaverse/agent_papaya/blob/main/background.js)). It was submitted to the **Google Chrome Built-in AI Challenge 2024**, and the Devpost page says "Submitted to Google Chrome Built-in AI Challenge".
- What it does: auto-clicks banners according to a stored preference. The preferences are `marketing` and `performance` booleans, both defaulting to false, so in effect reject. It ships a pre-crawled per-domain button database (`url_data2.json`) and falls back to Nano, which is prompted to label buttons as `accept_all`, `reject_all`, `manage_preferences` and so on. It also does GPC, and has a Nano-powered chat ("why did you click that?", "report wrong button").
- Rules + AI? A per-domain lookup table followed by AI. There is no CMP rule engine and no gatekeeper question.
- **Privacy caveat:** it POSTs browsing and click data and preferences to a Heroku backend (`cookie-monster-preferences-api-…herokuapp.com/dataBrowsing`, `/cookiePreferences`; see background.js `saveBackendData`). Its Devpost "what's next" section pitches data monetisation ("Papaya Payback"). So the AI is local, but the extension as a whole is not.
- Status: 66 users, 5.0 stars from 5 ratings, v5.8.4, last updated 2025-11-04 ([Web Store](https://chromewebstore.google.com/detail/llnpmgaejhooellpbbbicjhdfipckdka?hl=en-US)). Last GitHub push 2025-07-19, 7 stars. Effectively dormant.
- How it differs: AI picks the button, there is no gatekeeper role and no autoconsent, data leaves the machine, it does not toggle-and-save, and there is no rule-export loop.

### 1.3 DuckDuckGo autoconsent + tracker-radar-collector LLM pipeline: **close in architecture, but offline/cloud**
- Links: https://github.com/duckduckgo/autoconsent, https://github.com/duckduckgo/tracker-radar-collector
- Engine: the autoconsent library already has a **regex heuristic mode** for unknown popups ([lib/heuristic-classify.ts](https://github.com/duckduckgo/autoconsent/blob/main/lib/heuristic-classify.ts), [lib/heuristic-patterns.ts](https://github.com/duckduckgo/autoconsent/blob/main/lib/heuristic-patterns.ts)). It has `DETECT_PATTERNS` (multilingual "we use cookies…" regexes), `DETECT_NEVER_MATCH_PATTERNS`, and `classifyButtonTextRegex` returning reject / settings / accept / acknowledge / other. `classifyPopup` returns `reject | tier1 | tier2 | none`, and `heuristicMode` is `'off' | 'reject' | 'tier1' | 'tier2'` ([lib/types.ts](https://github.com/duckduckgo/autoconsent/blob/main/lib/types.ts)). **This is most of Bouncer's "regex picks the button" layer, already built.** Bouncer should build on it rather than write its own.
- The LLM part runs **offline in DDG's crawler**, not in the browser. `post-processing/detect-cookie-popups.js` asks `gpt-4.1-nano` whether a candidate is a cookie popup, which is the gatekeeper question. `generate-autoconsent-rules/detection.js` uses `gpt-4o-mini` to classify button text into the same 5 labels. `verification.js` uses the LLM to look for false-positive and false-negative reject buttons. The output feeds `rules/generated/auto_XX_*.json` in autoconsent, and an LLM-labelled CSV (`data/labelled-button-texts.csv`) benchmarks the regexes. See the [post-processing README](https://github.com/duckduckgo/tracker-radar-collector/blob/main/post-processing/README.md). Rule fixes are also opened by an agent account ("daxtheduck"), for example [autoconsent PR #1943](https://github.com/duckduckgo/autoconsent/pull/1943), and the repo carries an [AGENTS.md](https://github.com/duckduckgo/autoconsent/blob/main/AGENTS.md).
- How it differs: identical decomposition (LLM gatekeeper, LLM button labels, deterministic rule), but run **centrally and in the cloud**, with results shipped as rules. Bouncer runs the same idea **on the user's machine, at browse time**, for the long tail the crawl never visited.
- AGENTS.md policy is worth copying: never click a TIER2 (single-Accept) button in an opt-out flow, treat paywalls (pay-or-OK) as out of scope, and treat age gates, login walls, newsletters and app prompts as out of scope.

### 1.4 Brave Cookiecrumbler: **partial overlap (same gatekeeper, server-side, hides)**
- Links: https://brave.com/privacy-updates/33-cookiecrumbler/ (2025-04-24), https://github.com/brave/cookiecrumbler (166 stars, active, pushed 2026-10-22)
- Model / where: open-source LLMs (default `llama3` through Ollama, or AWS Bedrock through LiteLLM) on **Brave's backend**. Puppeteer crawls region lists and the LLM confirms candidates. Output is suggested **filter-list (hide) rules**, triaged by humans as [GitHub issues](https://github.com/brave-experiments/cookiecrumbler-issues/issues). Brave says it may move into the browser after a privacy review, and the README says "In the future, we could even bundle it in the browser."
- Action: Brave **hides** notices with cosmetic filters. It does not click reject.
- Directly reusable code:
  - Candidate finder ([src/inpage/index.mjs](https://github.com/brave/cookiecrumbler/blob/main/src/inpage/index.mjs)): `position: fixed|sticky` plus visible, drops elements with more than 10 first-party links (headers and footers), keeps innermost non-parent elements, recurses into iframes, then calls the LLM on `innerText`. It also detects a leftover full-screen overlay and scroll lock after hiding.
  - Gatekeeper prompt ([src/text-classification.mjs](https://github.com/brave/cookiecrumbler/blob/main/src/text-classification.mjs)): 500 chars of `innerText`, boolean answer, `max_tokens: 2`, temperature 0. It explicitly excludes age gates, permission prompts and header/footer links, and **falls back to a keyword classifier when the LLM fails.**
- How it differs: server-side, hide-not-reject, feeds filter lists. Same gatekeeper question as Bouncer.

### 1.5 Auto Cookie Decline (Chrome Web Store): **unverifiable claim**
- https://chromewebstore.google.com/detail/auto-cookie-decline/aeinacoibaflanchchcnkabmndmejffg. The listing says "Powered by AI", claims "no external APIs", clicks Reject/Decline and hides when it cannot. It names no model, the package is 6.64 KiB (too small to bundle a model, and nothing points to the Prompt API), it has 9 users, v1.0 from 2026-03-25, and its privacy declarations contradict its description. Most likely "AI" is marketing. **Different.**

---

## 2. Adjacent: cloud-LLM, classic-ML, or LLM-maintained projects (brief)

| Project | AI / where | Action | Status | Relation |
|---|---|---|---|---|
| **CookieEnforcer** (Khandelwal, Nayak, Harkous, Fawaz; USENIX Sec '23) [arXiv](https://arxiv.org/abs/2204.04221), [Google Research](https://research.google/pubs/cookieenforcer-automated-cookie-notice-analysis-and-enforcement/) | Detects notices from their rendering pattern. A seq2seq text model predicts the click sequence that disables all non-essential cookies, toggles included. | Reject / toggles off | Research prototype, 91% step accuracy | The academic ancestor of "open settings and turn off every toggle" |
| **reject-cookies** (mitch292) [repo](https://github.com/mitch292/reject-cookies), [blog](https://blog.bymitch.com/posts/reject-cookies-automation/) | Rules at runtime. **Claude in a weekly GitHub Action** reads user reports, screenshots and HTML, then opens rule PRs (about $10/month). | Reject | 64 stars, active | The "learned rules shared via PR" idea, but central and cloud-based |
| **CMPMapper** [repo](https://github.com/keyfive5/CMPMapper) | LLM-assisted generation of Consent-O-Matic rules from crawled HTML | n/a (tooling) | 1 star, 2025-12 | Rule generation, offline |
| **Cookie Marshal AI Agent** [repo](https://github.com/katipally/Cookie-Marshal-AI-Agent) | Rules plus Q-learning. Explicitly *no* LLM (the author cites latency) | Reject / toggles | 0 stars, learning project | Rules + learning, no LLM |
| **CookieBlock** (ETH Zürich) [site](https://infsec.ethz.ch/research/software/cookieblock.html) | Local classic ML (classifies *cookies* by purpose) | Deletes cookies by category, ignores banners | Maintained research tool | Different layer |
| **No, Thanks** [Devpost](https://devpost.com/software/no-thanks-5okas9) | Multimodal cloud LLM driving Playwright | Reject / prefs | Hackathon prototype, not an extension | Agent approach |
| **CookieLens** [Devpost](https://devpost.com/software/cookielens-know-before-you-accept-01swdq) | Groq Llama 3.1 summarises the privacy policy | Informs, doesn't click | Hackathon | Different |
| **Refuse to Share** [Devpost](https://devpost.com/software/refuse-to-share), [Web Store](https://chromewebstore.google.com/detail/refuse-to-share/aamlemephhalccdeakeghnpjlgncadnl) | **No AI.** CMP adapters, toggles optional categories off, saves, verifies dismissal, abstains when unsure | Reject / toggles | Started 2026-10-02 | Same "conservative, abstain, verify" philosophy, without AI |
| **AutoCookie** [chromeboard](https://chromeboard.com/extension/autocookie-aaogmlanmefihpngoienpolheeoddonh) | Not stated, "all processing on device" | Reject, then necessary-only; accepts only on a verified pay-or-OK wall in "Autopilot" | 11 users, 2026-09-29 | Similar policy ladder, no evidence of AI |
| **Script-AI-Browser-Agent** [issue #91](https://github.com/cerealdevnull/Script-AI-Browser-Agent/issues/91) | Runs autoconsent in reject mode *before* the agent's LLM sees the page | Reject | Active | Uses autoconsent the way Bouncer does |
| **Browser agents** (Comet, Atlas, Claude CU, ChatGPT Agent) [SecurePrivacy summary](https://secureprivacy.ai/blog/ai-agents-cookie-consent-bypass-gdpr-compliance-gap) | Cloud LLM agents | Often **accept all** | n/a | Counter-example: an LLM left alone tends to accept |

## 3. Browser-vendor features

- **Chrome:** no built-in cookie-banner handling. The Prompt API is available to extensions (`LanguageModel`, available to extensions without an origin trial from Chrome 138, and the origin-trial name `AIPromptAPIForExtension` still appears in code) ([Chrome docs](https://developer.chrome.com/docs/extensions/ai/prompt-api), [Chromium doc](https://chromium.googlesource.com/chromium/src/+/main/docs/experiments/prompt-api-for-extension.md)). Nobody at Google has shipped a Nano cookie feature. The silent ~4 GB model download is itself a consent controversy ([The Register, 2026-05-07](https://www.theregister.com/ai-and-ml/2026/05/07/chrome-silently-installs-a-4-gb-local-llm-on-your-computer/5230893)). That matters for Bouncer's messaging and for its "AI required" stance.
- **Edge:** the Prompt API uses built-in **Phi-4-mini** (Canary/Dev 138+) and, from 150, the smaller CPU-capable **Aion-1.0-Instruct**. It is available to extensions, still a developer preview, and needs 20 GB free ([MS Learn](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api), [Edge blog](https://blogs.windows.com/msedgedev/2025/05/19/introducing-the-prompt-and-writing-assistance-apis/)). Same API shape, so Bouncer could port. No cookie feature.
- **Firefox:** the built-in "cookie banner reduction" (Firefox 120, Germany first, a hand-curated site list, no ML) is **no longer available**. SUMO points users to uBO's cookie lists ([SUMO](https://support.mozilla.org/en-US/kb/cookie-banner-reduction), [chipp.in on FF120](https://chipp.in/security-privacy/firefox-120-will-block-cookie-banners-but-only-in-germany/)). Firefox exposes local inference to extensions through `browser.trial.ml` (since 134, behind flags, Transformers.js models, no general chat LLM) ([Mozilla blog](https://blog.mozilla.org/en/products/firefox/firefox-ai/running-inference-in-web-extensions/), [docs](https://firefox-source-docs.mozilla.org/toolkit/components/ml/extensions-api-example/README.html)). No cookie use found. A user on Mozilla Connect has suggested exactly the local-LLM idea ([idea thread](https://connect.mozilla.org/t5/ideas/automatic-cookie-consent-banner-handling/idc-p/133222)).
- **Brave:** filter-list hiding, on by default ("Block cookie consent notices"), plus Cookiecrumbler on the server (§1.4). Leo's local / bring-your-own models are not used for this.
- **Opera:** a "cookie dialog blocker" on Android, based on CSS/JS rules and tested on 15k sites ([pplware](https://pplware.sapo.pt/browsers/opera-fim-banners-cookies-android/)). No AI involvement found.
- **DuckDuckGo browsers:** autoconsent with the regex heuristic (§1.3). There is no ML in the client. The LLMs are only in the offline pipeline.

## 4. Non-AI incumbents (one line each)

- **autoconsent** (DDG): rules plus regex heuristic, rejects; used by DDG and others. https://github.com/duckduckgo/autoconsent
- **Consent-O-Matic** (Aarhus, 4.3k stars): CMP rules, fills preferences per category. https://github.com/cavi-au/Consent-O-Matic
- **Ghostery Never-Consent**: auto-rejects consent dialogs (autoconsent-style). https://ghostery.com/blog/never-consent-by-ghostery
- **I don't care about cookies**: mostly hides or accepts. Not privacy-preserving on the consent itself. https://www.i-dont-care-about-cookies.eu/
- **uBO / AdGuard cookie-notice lists**: cosmetic hiding only. https://github.com/uBlockOrigin/uAssets
- **Mozilla cookie-banner-rules-list** (backing for the retired Firefox feature): https://github.com/mozilla/cookie-banner-rules-list

---

## 5. Verdict: how close is the closest match?

| Rank | Project | Closeness |
|---|---|---|
| 1 | JokubasBu/CookieExtension | **Close.** Same model, same goal (reject, necessary-only, open settings), but AI-first, manual trigger, no toggles, no rule engine, unreleased |
| 2 | DDG autoconsent heuristic + tracker-radar LLM pipeline | **Close in architecture.** Same gatekeeper and button-label decomposition, but offline and in the cloud |
| 3 | Agent Papaya | **Partial overlap.** Shipped Gemini Nano cookie clicker, but AI-first, phones home, dormant |
| 4 | Brave Cookiecrumbler | **Partial overlap.** Same gatekeeper prompt idea, server-side, hides |
| 5 | CookieEnforcer | **Partial overlap.** Same "turn every toggle off" goal with ML, research only |

**No exact match exists.**

### What is genuinely novel in Bouncer
1. **Running the gatekeeper on the user's machine, at browse time, after a mature rule engine.** DDG and Brave both run the "is this a cookie dialog?" LLM *centrally*. Projects that run it locally (Papaya, CookieExtension) skip the rule engine and let the LLM pick the action.
2. **The AI only labels; regex and deterministic JS decide.** No found project restricts the on-device model this tightly. The CookieExtension numbers (Nano: 40/41 on detection, 25/41 on full decisions) are independent evidence that this is the right split.
3. **Silent, automatic toggle-off-and-save for unknown CMPs.** autoconsent's heuristic never toggles: settings means `none`. CookieExtension explicitly doesn't toggle. Refuse to Share and CookieEnforcer do, but without a local LLM.
4. **Local learning that emits autoconsent-format rules, shareable through PRs.** DDG (crawler) and reject-cookies (Claude in CI) generate rules *centrally*. Doing it from real users' browsing, locally and opt-in, is new. It needs a privacy story for PR submission.
5. **"Agree-only" leave-alone behaviour and banner restore on failure** as explicit, user-visible policies. This is close to DDG's TIER2 rule, but exposed as a setting.

The novelty is in the combination and the guardrails. "Gemini Nano + cookie banners" alone has been done at least twice.

### Ideas worth borrowing
- **Build on autoconsent's heuristic exports rather than writing new regexes.** `checkHeuristicPatterns`, `classifyButtonTextRegex`, `isExcludedPopup` and `classifyPopup` are exported as `@duckduckgo/autoconsent/heuristics` (per the tracker-radar README). Then Nano only needs to handle the `none` cases and the gatekeeper question.
- **Use DDG's gatekeeper prompt** (positive and negative examples: age gate, footer links, notification prompt, minified JS) and their **5-label button prompt**. It already encodes "accept necessary only → reject", "Do not sell → reject", "allow selection → accept", "Cancel → other", and the tie-break order reject > accept > settings > acknowledge > other. Both are in tracker-radar-collector `post-processing/`.
- **Use Brave's candidate filter** (fixed/sticky + visible, drop elements with many first-party links, innermost elements, iframe text) and its **"problematic overlay / scroll-lock" check** after hiding. Use its **keyword fallback when the LLM errors**. Bouncer currently says "AI required", but a keyword fallback could feed the "restore banner" path.
- **Brave's boolean-only, 500-char, temperature-0 prompt** keeps latency low. Pair it with `responseConstraint` (as CookieExtension does) for Nano.
- **DDG's labelled button-text CSV** (`autoconsent/data/labelled-button-texts.csv`) is a free multilingual eval set for Bouncer's regex and Nano labeller.
- **CookieExtension's fixtures and benchmark harness** (Playwright, built-in stub, per-provider CSVs). Its compaction tactics fit Nano's ~6k-token input budget: one candidate, at most 8 controls, 80/240-char caps, opaque `c0`/`b0` IDs mapped back to selectors.
- **The "unsafe pick" normaliser:** if anything ever selects accept-all, redirect it to settings or abstain. This mirrors DDG's "never click TIER2 in opt-out".
- **reject-cookies' report → screenshot/HTML → LLM-PR loop** is a working template for Bouncer's "shareable learned rules" stretch goal, done centrally from user reports instead of uploading browsing data.
- **AutoCookie / Refuse to Share policy ladder:** reject, then necessary-only, then toggle-off and save, then verify the banner is gone and the choice persisted, otherwise abstain. Post-action verification (did the banner disappear, was a consent cookie written) is worth adding to the decision log.
