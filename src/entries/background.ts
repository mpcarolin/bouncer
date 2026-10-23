import { createProvider } from "../ai/compose.ts";

// Placeholder wiring until Task 11; keeps the provider in the bundle so the build check means something.
const provider = createProvider();
provider.status().then((s) => console.log("bouncer up", s.state));
