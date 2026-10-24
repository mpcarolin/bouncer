# Bouncer

Bouncer is a Chrome extension that refuses cookie consent banners. It uses
DuckDuckGo's autoconsent rule engine, plus its own path gated by Chrome's
on-device AI, and it never clicks "accept all" unless you turn on agree to
dismiss.

## Load it unpacked

1. `pnpm install && pnpm build`
2. Open `chrome://extensions` and turn on Developer mode.
3. Choose "Load unpacked" and select the `dist/chrome` folder.
