// Smoke test: every new module loads without throwing.
// Run with: `node scripts/load-modules.js` from inside the backend/ dir.
"use strict";
require("../src/services/metrics");
require("../src/services/lifecycle");
require("../src/middleware/requestId");
require("../src/middleware/metrics");
require("../src/routes/metrics");
require("../src/routes/health");
require("../src/routes/readiness");
require("../src/services/indexerService");
console.log("all modules load OK");
