/**
 * PRODUCTION GUARD — shared utility
 *
 * Call this at the very top of any script that creates, truncates, or
 * replaces data. Exits immediately unless the process is outside Railway, not
 * NODE_ENV=production, AND the database it is about to dial is PROVABLY local.
 *
 * Usage:
 *   const { productionGuard } = require("./lib/production-guard");
 *   const target = productionGuard({ requireFlag: "--confirm", dbUrl });
 *   const pool = new Pool(target);   // dial exactly what was checked
 *
 * #2206: the old check was a Railway-hostname SUBSTRING test on the raw
 * DATABASE_URL. `pg` resolves the host itself and honours `?host=` /
 * `?hostaddr=` / `?service=` overrides, so `postgresql://u:p@localhost/x?host=<railway proxy>`
 * read as local while pg dialled production; a lookalike such as
 * `evil.railway.app.attacker.com` was only "caught" by accident; and scripts
 * that dial a DIFFERENT url than process.env.DATABASE_URL (a DATABASE_PUBLIC_URL
 * preference, an apps/api/.env fallback) were never checked at all.
 *
 * Now: an ALLOW-list, never a deny-list. The URL the script will actually use is
 * passed in and resolved by the same parser pg uses (`local-db-target.cjs`,
 * #2162/#2205): only localhost / 127.0.0.1 / ::1 / the compose host `postgres`
 * pass; any host-redirecting query parameter, multi-host list, socket path,
 * lookalike, empty or unparseable value is refused. Fail closed.
 */

"use strict";

const { localConnectionConfig } = require("./local-db-target.cjs");

/**
 * Pure decision (no exit, no logging) so it can be pinned by a spec.
 * @param {string|null|undefined} dbUrl  the URL the script will dial
 * @param {{ RAILWAY_ENVIRONMENT?: string, NODE_ENV?: string }} env
 * @param {{ requireDb?: boolean }} [opts]  requireDb=false: the script dials no database
 * @returns {{ ok: true, config: object|null } | { ok: false, reason: string }}
 */
function classifyDbTarget(dbUrl, env = process.env, { requireDb = true } = {}) {
  if (env.RAILWAY_ENVIRONMENT !== undefined) {
    return { ok: false, reason: "running inside Railway (RAILWAY_ENVIRONMENT is set)" };
  }
  if (env.NODE_ENV === "production") {
    return { ok: false, reason: "NODE_ENV is production" };
  }
  if (!requireDb) return { ok: true, config: null };
  const config = localConnectionConfig(dbUrl);
  if (!config) {
    return {
      ok: false,
      reason:
        "the database URL is not provably local (only localhost / 127.0.0.1 / ::1 / postgres, " +
        "no host/hostaddr/service query parameters, no multi-host or socket forms)",
    };
  }
  return { ok: true, config };
}

/** Redact credentials for display; never print a password. */
function describe(dbUrl) {
  if (!dbUrl) return "(not set)";
  return (
    String(dbUrl)
      .replace(/:\/\/[^@/]*@/, "://***@")
      .slice(0, 60) + "…"
  );
}

/**
 * @param {{ requireFlag?: string, dbUrl?: string|null, requireDb?: boolean }} [opts]
 *   dbUrl: the URL the script will ACTUALLY dial (after its own fallbacks). Required unless
 *   requireDb is false (a script that talks to no database).
 * @returns {object|null} the provably-local pg connection fields (host, port, user, password,
 *   database) to build the pg Pool/Client from, or null when requireDb is false.
 */
function productionGuard({ requireFlag, dbUrl, requireDb = true } = {}) {
  const verdict = classifyDbTarget(dbUrl, process.env, { requireDb });
  if (!verdict.ok) {
    console.error("╔══════════════════════════════════════════════════════════╗");
    console.error("║  BLOCKED: this script runs only against a LOCAL database ║");
    console.error("║  (real tenant data would be destroyed).                  ║");
    console.error("╠══════════════════════════════════════════════════════════╣");
    console.error("║  Reason            :", verdict.reason);
    console.error("║  NODE_ENV          :", process.env.NODE_ENV || "unknown");
    console.error("║  RAILWAY_ENVIRONMENT:", process.env.RAILWAY_ENVIRONMENT ?? "(not set)");
    if (requireDb) console.error("║  Database target   :", describe(dbUrl));
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

  console.log(
    "✔ Production guard passed — local target:",
    verdict.config
      ? `${verdict.config.host}:${verdict.config.port}/${verdict.config.database}`
      : "(no database)",
  );
  return verdict.config;
}

module.exports = { productionGuard, classifyDbTarget };
