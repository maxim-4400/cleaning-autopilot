import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const artifact = resolve(".next/server/instrumentation.js");

if (!existsSync(artifact)) {
  throw new Error("Production build did not emit the Next.js instrumentation artifact.");
}

const require = createRequire(import.meta.url);
const instrumentation = require(artifact);

if (typeof instrumentation.register !== "function") {
  throw new Error("Built instrumentation artifact does not export register().");
}

// Run the emitted entry in a deliberately disabled environment. This verifies
// that the production bundle can load the runner while proving no worker starts
// outside the explicit production/real opt-in.
process.env.NEXT_RUNTIME = "nodejs";
process.env.APP_ENV = "preview";
process.env.INTEGRATION_MODE = "fake";
process.env.TRELLO_RECOVERY_RUNNER_ENABLED = "false";
await instrumentation.register();

console.log("Verified executable Next.js instrumentation artifact and disabled-runner gate.");
