import { createProvider } from "../ai/compose.ts";
import { startBackground } from "../core/background-app.ts";
import { chromeBackground } from "../platform/chrome/background.ts";

startBackground(chromeBackground(), createProvider());
