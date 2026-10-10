/**
 * READ-ONLY census for SA-769 (D-S2, owner answer 2026-10-10): a business profile's module grants are
 * COMP rows (`TenantAddon.isComp`), no longer GRANT feature overrides.
 *
 * Tenants whose EARLIER profile apply wrote GRANT overrides for the profile modules keep them: they are
 * already unbilled and their access is unchanged. This report lists exactly those overrides so the
 * follow-up can convert them (dry-run first, owner yes per live tenant); the conversion is NOT built here.
 *
 * One row per ACTIVE GRANT override (not revoked, not expired) on a profile module of a non-deleted tenant:
 *   - tenantId, module (featureKey), overrideId, tenantClass, createdAt
 *   - fromProfile: the override's reason starts "Business profile:" (written by a profile apply) rather than
 *     a hand-made admin override. Hand-made ones are NOT part of the old shape and stay as they are.
 *   - hasActiveRow: an ACTIVE add-on row already exists for the module (the override is then redundant)
 *
 * NEVER RUN FROM AN IMPLEMENTATION SESSION. The fleet lead runs it under its `railway run` authorization
 * (warn-then-approve):
 *
 *   railway run --service postgres node apps/api/scripts/report-profile-grant-overrides.mjs [--json]
 *
 * Output is tenant UUIDs, override ids, module keys and COUNTS only: no tenant name or slug, no user id and
 * not the free-text reason (it classifies a row, it is never printed). `--self-test` runs the pure checks with
 * no database and exits.
 *
 * SAFETY: `default_transaction_read_only = on` before any other query; `statement_timeout` and `lock_timeout`
 * cap every query; the connection is closed in `finally`; only SELECT appears below.
 */
import { createRequire } from "module";
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveReportDbUrl } from "./lib/report-db-url.mjs";
const require = createRequire(import.meta.url);
const { Client } = require("pg");

/**
 * Mirror of PROFILE_MODULE_KEYS (apps/api/src/billing/business-profiles.ts). A .mjs cannot import the TS
 * list; report-profile-grant-overrides.sa769.spec.ts pins the two deep-equal. None of them is a
 * legacy-bridged add-on key, so the row match below is a plain addonKey / sku match.
 */
export const PROFILE_MODULE_KEYS = ["recurring_routes", "order_delivery", "driver_payments"];

/** The reason text `BusinessProfileService.plan` writes on every override it creates ("Business profile: <label>"). */
export const PROFILE_REASON_PREFIX = "Business profile:";

/** No-DB checks of the pure parts (`--self-test`). Throws on the first failure. */
export function selfTest() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error(`self-test failed: ${msg}`);
  };
  assert(PROFILE_MODULE_KEYS.length === 3, "three profile modules");
  assert(PROFILE_MODULE_KEYS.at(-1) === "driver_payments", "driver_payments last");
  assert(PROFILE_REASON_PREFIX === "Business profile:", "reason prefix");
}

const OVERRIDES_SQL = `
  SELECT o.id AS "overrideId",
         o."tenantId" AS "tenantId",
         o."featureKey" AS "module",
         t.class AS "tenantClass",
         o."createdAt" AS "createdAt",
         (o.reason LIKE 'Business profile:%') AS "fromProfile",
         EXISTS (
           SELECT 1 FROM "TenantAddon" a
            WHERE a."tenantId" = o."tenantId"
              AND a.active = true
              AND (a."addonKey" = o."featureKey" OR a.sku = o."featureKey")
         ) AS "hasActiveRow"
    FROM "TenantFeatureOverride" o
    JOIN "Tenant" t ON t.id = o."tenantId"
   WHERE o.effect = 'GRANT'
     AND o."revokedAt" IS NULL
     AND (o."expiresAt" IS NULL OR o."expiresAt" > now())
     AND o."featureKey" = ANY($1::text[])
     AND t."deletedAt" IS NULL
   ORDER BY o."tenantId" ASC, o."createdAt" ASC, o.id ASC`;

async function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    console.log("self-test ok");
    return;
  }
  const json = process.argv.slice(2).includes("--json");

  // Fail closed BEFORE any connection is attempted (B768: the redacted target goes to stderr).
  const databaseUrl = resolveReportDbUrl("report-profile-grant-overrides");
  if (!databaseUrl) {
    process.exitCode = 2;
    return;
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    // Hard read-only guarantee + query caps, before anything else runs.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '45s'");
    await client.query("SET lock_timeout = '5s'");

    const { rows: found } = await client.query(OVERRIDES_SQL, [PROFILE_MODULE_KEYS]);
    const rows = found.map((r) => ({
      tenantId: r.tenantId,
      module: r.module,
      overrideId: r.overrideId,
      tenantClass: r.tenantClass,
      fromProfile: r.fromProfile === true,
      hasActiveRow: r.hasActiveRow === true,
      createdAt: new Date(r.createdAt).toISOString(),
    }));
    const summary = {
      overrides: rows.length,
      tenants: new Set(rows.map((r) => r.tenantId)).size,
      writtenByProfileApply: rows.filter((r) => r.fromProfile).length,
      handMade: rows.filter((r) => !r.fromProfile).length,
      alsoHeldByActiveRow: rows.filter((r) => r.hasActiveRow).length,
    };

    if (json) {
      console.log(JSON.stringify({ summary, rows }, null, 2));
      return;
    }

    console.log("\n=== profile module grant overrides (old shape) ===");
    console.log("    session is READ ONLY; no writes are possible\n");
    console.table(summary);
    if (rows.length) console.table(rows);
    else console.log("\nNo active grant override on a profile module.");
    console.log(
      "\nfromProfile=false rows are hand-made admin overrides: not part of the old shape, left as they are." +
        "\nConverting the fromProfile rows to comp rows is a follow-up (dry-run first, owner yes per live tenant).",
    );
    console.log("\n=== END - session was read-only; nothing was modified ===\n");
  } catch (e) {
    console.error("profile grant override census failed:", e.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

// Run only when executed directly (the spec imports the exports above).
const entry = process.argv[1] ? basename(realpathSync(process.argv[1])) : "";
if (entry === basename(fileURLToPath(import.meta.url))) {
  await main();
}
