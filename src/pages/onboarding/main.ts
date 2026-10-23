import { chromePage } from "../../platform/chrome/page.ts";
import { renderOnboarding } from "./render.ts";

const root = document.getElementById("app");
if (!root) throw new Error("onboarding page has no #app");
await renderOnboarding(root, chromePage());
