import { createProvider } from "../ai/compose.ts";
import { startBackground } from "../core/background-app.ts";
import { chromeAcLib, chromeBackground } from "../platform/chrome/background.ts";

startBackground(chromeBackground(), createProvider(), { acLib: chromeAcLib() });
