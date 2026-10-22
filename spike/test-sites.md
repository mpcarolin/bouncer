# Cookie-banner test sites (confirmed from US / Arizona, 2026-10-22)

These were checked with `agent-browser` in headless Chrome, using a normal desktop Chrome user agent and
`--disable-blink-features=AutomationControlled`. Without the real user agent, many sites returned bot walls.

**How the autoconsent column was filled.** The installed `@duckduckgo/autoconsent@16.59.0` bundle
(`dist/autoconsent.playwright.js`) was injected as an init script into every frame. It was given the full
`rules/rules.json`, which includes the generated `auto_*` rules. It ran with `autoAction: null`, so it only
detected and never clicked. The column shows the rule that reported `cmpDetected`/`popupFound`.
- Lower-case names come from `rules.json`.
- `Onetrust`, `Cybotcookiebot`, `TrustArc-top`, `Klaro` and `Sourcepoint-frame` are built-in code CMPs (`lib/cmps/*.ts`).
- **none** means no rule fired within 15 s of load, in the top frame or any iframe.

Button labels are verbatim: they come from the DOM or the accessibility snapshot.

## A. Home-grown banners, or banners autoconsent does not recognise (AI fallback path)

| URL | vendor | autoconsent rule? | buttons offered (verbatim) | has reject? | notes |
|---|---|---|---|---|---|
| https://www.lemonde.fr/en/ | home-grown (`.gdpr-lmd-wall`, also exposes `__tcfapi`) | none | "Accept", "Cookie settings", "Reject all cookies" | yes, but hidden-ish | Full-screen modal wall. "Reject all cookies" is a small link (`.gdpr-lmd-wall__refuse-link`) placed *above* the modal, at top ≈ −27 px, so it starts off-screen. Visually, the only choices are Accept / Cookie settings. A good adversarial case. |
| https://www.ons.gov.uk | home-grown (ONS design system `.cookies-banner`) | none | "Accept additional cookies", "Reject additional cookies", "Manage settings" | yes | The `gov-uk` rule does not match it. "Manage settings" is a link to a separate page. |
| https://www.parliament.uk | home-grown (`.p-cookie-manager`) | none | "Accept additional cookies", "Reject additional cookies", "Cookie settings" | yes | The only parliament rule is for parliamentlive.tv. |
| https://www.bankofengland.co.uk | home-grown (`.cookie-content`) | none | "Accept recommended cookies", "Proceed with necessary cookies only" | yes (worded as "necessary only") | No button contains the word "reject", so the regex fast path will miss it. Tests the LLM labelling. |
| https://monzo.com | home-grown (CSS-module `CookieBanner_CookieBanner__Content__*`) | none | "Accept all", "Reject all", "Customise" | yes | Classes are hashed. |
| https://www.revolut.com | home-grown (Revolut UI kit, hashed `Box-rui__*` classes) | none | "Accept all", "Reject non-essential cookies", "Learn more and manage" | yes | Bottom-right card. The page also shows a region bar with its own "Close" button. |
| https://www.ovhcloud.com/en/ | home-grown (`.cmp-consent-modal`) | none | "Continue without accepting", "Configure", "Accept all" | yes (a link) | Centred modal. The opt-out is a small underlined link at the top-left, in the CNIL style. |
| https://www.scaleway.com/en/ | home-grown (hashed CSS module, titled "Cookie time!") | none | "Reject all", "Accept all", "Manage your preferences" | yes | Bottom bar. |
| https://www.iubenda.com/en/ | iubenda / team.blue, new banner inside the `<tb-banner-wrapper>` shadow root (closed: `shadowRoot` is null) | none | tabs "Notice", "Preferences"; "Reject", "Accept" | yes | The `iubenda` rule targets `#iubenda-cs-banner`, which this new banner does not use. A DOM walk cannot see inside the closed shadow root; the accessibility snapshot can. A good test of whether the extension can reach closed shadow DOM. |
| https://www.deepl.com/en/translator | home-grown (`#cookieBanner`) | none | "Close" (plus a "Privacy Policy" link) | no | US visitors get a notice only, with no choice offered. The expected outcome is "no_option" (leave it alone) or close it. |
| https://www.dropbox.com | home-grown, rendered inside an iframe | `auto_US_dropbox.com_0_+1` (generated) | "Customize cookies", "Decline", "Accept All", X | yes | Covered only by a *generated* rule, so it falls to the AI path if generated rules are off. |
| https://www.deezer.com/us/ | home-grown (`.gdpr-modalContainer`) | `auto_US_deezer.com_0` (generated) | "Accept", "Refuse", "Preferences" | yes ("Refuse") | Covered only by a generated rule. |
| https://www.inmobi.com | home-grown, on InMobi's own site (not their Choice CMP) | `inmobi` (site-specific) | "DECLINE", "CUSTOMIZE", "ACCEPT ALL" | yes | |

## B. No reject button (exercises the settings flow)

| URL | vendor | autoconsent rule? | buttons offered (verbatim) | has reject? | notes |
|---|---|---|---|---|---|
| https://www.klarna.com/us/ | OneTrust | Onetrust | "Change settings", "Close" | no | Has no accept button either. A scam-warning bar also has a "close announcement" button. |
| https://www.dyson.com/en | OneTrust | Onetrust | "Manage Cookies Settings", "Close" | no | Settings + close only. |
| https://www.cmu.edu | OneTrust | Onetrust | "Review Cookie Settings", "Accept Cookies", "Close" | no | A US university. |
| https://www.irishtimes.com | OneTrust (TCF) | Onetrust | "I ACCEPT", "MANAGE SETTINGS", "List of Partners (vendors)" | no | |
| https://www.ieee.org | Osano | osano | "Manage Preferences", "Close this consent banner" | no | The same Osano layout appears on osano.com. |
| https://www.twilio.com | TrustArc | TrustArc-top | "OK, got it", "Adjust preferences" | no | |
| https://redis.io | TrustArc | TrustArc-top | "Accept", "More Info", "Close cookie consent" | no | |
| https://www.northwestern.edu | CookieYes | cookieyes | "Adjust or Reject Cookies", "Accept All" | no direct reject | Reject sits behind "Adjust or Reject". |
| https://www.usc.edu | CookieYes (notice style) | cookieyes | "OK" | no | Notice only. |
| https://termly.io | Termly | Termly | "Preferences", "Accept" | no | |
| https://complianz.io | Complianz (opt-out banner variant) | Complianz banner | "Accept", "Close dialog" | no | |
| https://www.expedia.com | OneTrust (notice only) | Onetrust | "Close" | no | |

## C. Vendor spread

| URL | vendor | autoconsent rule? | buttons offered (verbatim) | has reject? | notes |
|---|---|---|---|---|---|
| https://www.funda.nl | Didomi (TCF) | didomi | "Voorkeuren wijzigen", "Alles weigeren", "Alles accepteren" | yes | A Dutch site, but the banner shows to a US IP. The only Didomi banner found that renders from here; didomi.io and cbc.ca load Didomi but show nothing. |
| https://www.zalando.co.uk | Usercentrics | usercentrics-api | "Set preferences", "Only essential", "Accept all" | yes ("Only essential") | trivago.com also shows a Usercentrics banner. |
| https://www.theguardian.com/us | Sourcepoint (US-National notice, in an iframe) | sourcepoint-top + Sourcepoint-frame | "Do not sell or share my personal information", close (X) | n/a (a CCPA opt-out) | A US-only privacy notice, not a GDPR consent banner. |
| https://mistral.ai | Axeptio | axeptio | "Close", "Accept all", "Next" (plus per-vendor info buttons) | via "Close" | A stepper UI. axept.io shows the classic "No, thanks" / "I want to choose" / "Ok for me". |
| https://kiprotect.com | Klaro | Klaro | "Let me choose", "I decline", "That's ok" | yes | |
| https://www.arduino.cc | iubenda (classic) | iubenda | "MANAGE PREFERENCES", "REJECT", "ACCEPT", "×" | yes | |
| https://www.britishmuseum.org | Cookiebot (new `ckb-` UI, TCF) | Cybotcookiebot | "Allow all cookies", "Manage cookies", "Reject all cookies" | yes | |
| https://www.ox.ac.uk | Civic Cookie Control | civic-cookie-control | "Accept all", "I do not accept", "Settings" | yes | metoffice.gov.uk uses Civic too. |
| https://www.itv.com | Cassie | cassie | "ACCEPT", "REJECT", "MANAGE" | yes | |
| https://www.royalmail.com | TrustArc | TrustArc-top | "Accept all", "Decline all", "Let me choose" | yes | digitalocean.com: "Agree & proceed", "Decline all", "Manage choices". |
| https://www.sparkfun.com | Amasty GDPR (Magento) | amasty-gdpr | "ACCEPT ALL COOKIES", "CUSTOMIZE SETTINGS", "DENY ALL" | yes | Electronics retailer, US. |
| https://www.gatech.edu | Drupal EU Cookie Compliance | eu-cookie-compliance-banner | "More info", "Accept", "Decline" | yes | A US university. |
| https://www.decathlon.com | Shopify privacy banner | shopify | "Manage preferences", "Accept", "Decline" | yes | US store. |
| https://www.nature.com | Springer Nature `cc-banner` | cc-banner-springer | "Accept all cookies", "Reject optional cookies", "Manage preferences" | yes | |
| https://www.sainsburys.co.uk | OneTrust (TCF) | Onetrust | "Continue and accept", "Required only", "Let me choose" | yes ("Required only") | Unusual wording for the reject option. |
| https://www.docker.com | OneTrust | Onetrust | "Cookies Settings", "Reject All", "Accept All Cookies" | yes | Standard OneTrust. Same layout on unity.com, arm.com, cambridge.org, purdue.edu, imperial.ac.uk, netlify.com, miro.com, bt.com and rightmove.co.uk. |

**Not found:** no site showed a Quantcast/InMobi Choice (`qc-cmp2`) banner to this IP.

## Rejected candidates (no banner from here, blocked, or unreliable)

- **No banner shown to the US. A CMP may load, but nothing renders:** arizona.edu, asu.edu (Cassie loaded), nau.edu, stanford.edu, harvard.edu, yale.edu, princeton.edu, psu.edu, umich.edu, utexas.edu, colorado.edu, washington.edu, jhu.edu, ucsd.edu, jetbrains.com (CookieHub loaded), kayak.com (TCF stub), notion.com, grammarly.com, eventbrite.com, patreon.com, indiegogo.com and airtable.com (Transcend detected, nothing visible), didomi.io, cbc.ca (Didomi), theglobeandmail.com (Ketch), wired.com (Fides), render.com (Osano loaded), hellofresh.com and n26.com (Usercentrics loaded), slack.com, atlassian.com, about.gitlab.com, booking.com, cloudflare.com, grafana.com, bose.com, sonos.com, npr.org, asos.com, vinted.com, espn.com, cnet.com, chess.com, discord.com, nintendo.com, namecheap.com, ticketmaster.com, nationalgeographic.com, coursera.org, spotify.com, soundcloud.com, microchip.com, nxp.com, st.com, digikey.com, mathworks.com, analog.com, mouser.com, lufthansa.com, klm.com, airbnb.com, hilton.com, marriott.com, zara.com/us, hm.com, uniqlo.com, levi.com, patagonia.com, adidas.com, supabase.com, vercel.com, sentry.io, fly.io, proton.me, vivaldi.com, epicgames.com, hostinger.com, quora.com, yelp.com, wikihow.com, wise.com, elastic.co, mongodb.com, postman.com, forbes.com, latimes.com, politico.com, usatoday.com, nytimes.com, telegraph.co.uk, news.sky.com, abc.net.au, smh.com.au, canada.ca, express.co.uk, ladbible.com, livescience.com, elpais.com, nrk.no, ucl.ac.uk, easyjet.com, just-eat.co.uk, argos.co.uk, tripadvisor.com, economist.com.
- **Not a cookie banner:** bloomberg.com ("We've updated our terms", Accept only), mcdonalds.com (a T&C-change banner).
- **Blocked:** reuters.com ("Access is temporarily restricted"), sephora.com (Akamai "Access Denied" when headless), bol.com (IP blocked), united.com and klm.com (`ERR_HTTP2_PROTOCOL_ERROR`). tfl.gov.uk showed a Cloudflare challenge, and no banner after the user-agent fix.
- **Intermittent, so excluded:** zoom.com (OneTrust, "Cookies Settings" + X with no accept or reject, seen on the first load but not the second), typeform.com (OneTrust, "Cookie settings" + Close, same pattern) and monday.com (CookieHub detected once, not on retry). All three are worth retrying, because the no-accept/no-reject layout is valuable.
- **Banner inside an iframe; labels not captured:** heise.de, spiegel.de, ft.com, politico.eu (Sourcepoint TCF), theatlantic.com (Sourcepoint), dr.dk (Cookiebot), abnamro.nl, ns.nl, thetrainline.com (OneTrust TCF). They are probably usable, but the buttons were not verified.
- **Already-tested vendor homepages, left out as duplicates:** osano.com, cookieyes.com, axept.io, usercentrics.com.
