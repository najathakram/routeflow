/**
 * Test-tenant policy — single source of truth.
 *
 * ALL testing, seeding, QA, and cleanup (local or production) may target ONLY
 * the approved test tenants below. Live client tenants must never be touched
 * by any script, test, or fixture. See CLAUDE.md "Test tenants & real-client
 * data (policy)".
 *
 * Consumed by:
 *  - apps/api/scripts/*.js       → require("../../../scripts/lib/test-tenants.cjs")
 *  - scripts/*.mjs               → import { assertTestTenant } from "./lib/test-tenants.cjs"
 *  - apps/web/e2e/helpers/*.ts   → require via relative path (see constants.ts)
 *
 * Keep exports static (plain `module.exports = { ... }`) so Node's CJS→ESM
 * named-export interop keeps working for the .mjs consumers.
 */

const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow"]);

// Throwaway tenants created for QA/e2e runs. Lowercase only — tenant slugs are
// lowercased at login/creation time.
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

function isTestTenant(slug) {
  if (typeof slug !== "string" || slug.length === 0) return false;
  return TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug);
}

function assertTestTenant(slug, context) {
  if (isTestTenant(slug)) return slug;
  const where = context ? ` (${context})` : "";
  throw new Error(
    `Test-tenant policy violation${where}: tenant "${slug}" is not an approved test tenant. ` +
      `Testing/seeding/cleanup may only target: ${[...TEST_TENANT_SLUGS].join(", ")}, ` +
      `or throwaway slugs matching ${TEST_TENANT_PATTERN}. ` +
      `Live client tenants must never be used for testing — see CLAUDE.md ` +
      `"Test tenants & real-client data (policy)".`,
  );
}

module.exports = { TEST_TENANT_SLUGS, TEST_TENANT_PATTERN, isTestTenant, assertTestTenant };
