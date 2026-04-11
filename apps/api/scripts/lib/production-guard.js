/**
 * PRODUCTION GUARD — shared utility
 *
 * Call this at the very top of any script that creates, truncates, or
 * replaces data.  Exits immediately if the process is running inside a
 * Railway environment or against a production DATABASE_URL.
 *
 * Usage:
 *   const { productionGuard } = require("./lib/production-guard");
 *   productionGuard({ requireFlag: "--i-know-this-deletes-everything" });
 */

"use strict";

function productionGuard({ requireFlag } = {}) {
  const ENV      = process.env.NODE_ENV          || "unknown";
  const DB_URL   = process.env.DATABASE_URL      || "";
  const RAILWAY  = process.env.RAILWAY_ENVIRONMENT;           // set by Railway in every process
  const IS_PROD  = RAILWAY !== undefined
                || ENV === "production"
                || DB_URL.includes("railway.app")
                || DB_URL.includes("railway.internal")
                || DB_URL.includes(".rlwy.net")      // Railway external proxy URLs
                || DB_URL.includes("rlwy.net");       // short form

  if (IS_PROD) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  BLOCKED: This script cannot run in a Railway / prod     ║");
    console.error("║  environment.  Real tenant data would be destroyed.      ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║  NODE_ENV          :", ENV);
    console.error("║  RAILWAY_ENVIRONMENT:", RAILWAY ?? "(not set)");
    console.error("║  DATABASE_URL hint :", DB_URL ? DB_URL.slice(0, 40) + "…" : "(not set)");
    console.error("╚══════════════════════════════════════════════════════════╝");
    process.exit(1);
  }

  if (requireFlag && !process.argv.includes(requireFlag)) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  CONFIRMATION REQUIRED                                   ║");
    console.error("║  This script wipes data.  Re-run with the explicit flag: ║");
    console.error("║                                                          ║");
    console.error(`║    ${requireFlag.padEnd(52)}║`);
    console.error("╚══════════════════════════════════════════════════════════╝");
    process.exit(1);
  }

  console.log("✔ Production guard passed — running in:", ENV, "environment");
}

module.exports = { productionGuard };
