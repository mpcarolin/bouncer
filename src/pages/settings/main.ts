import { chromePage } from "../../platform/chrome/page.ts";
import { renderSettings } from "./render.ts";

const root = document.getElementById("app");
if (!root) throw new Error("settings page has no #app");
const site = new URLSearchParams(location.search).get("site") ?? undefined;
await renderSettings(root, chromePage(), { site });
