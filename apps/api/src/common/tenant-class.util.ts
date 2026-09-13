import { TenantClass } from "@prisma/client";

/**
 * Inlined from scripts/lib/test-tenants.cjs (the repo-root single source of truth for the
 * test-tenant policy). Repo-root `scripts/` is NOT copied into the API Docker image
 * (apps/api/Dockerfile), so this file cannot import that module directly — `nest build` would
 * pass under host tsc (which resolves the relative path fine) but fail with TS2307 inside the
 * image build, where the file the import points to simply isn't there. Kept byte-for-byte equal
 * to the .cjs values; tenant-class.util.spec.ts asserts the two never drift.
 */
const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

/** The one hardcoded exception: routeflow-demo is TEST_TENANT_SLUGS-approved for the write
 * policy but is classified DEMO here — visible in lists, excluded from revenue and sends,
 * distinct from TEST which is hidden by default everywhere. */
const DEMO_SLUG = "routeflow-demo";

/** The house tenant's slug, classified INTERNAL. Set once by bootstrap-house-tenant.mjs
 * (Task 11); this classifier must recognize it even before that script has run, so a
 * re-run of the backfill after bootstrap never reclassifies it. */
const HOUSE_TENANT_SLUG = "routeflow-hq";

/**
 * Pure classification from slug alone. Order matters: DEMO and INTERNAL are checked
 * before the generic TEST pattern because routeflow-demo would otherwise match
 * TEST_TENANT_SLUGS. Every other approved-test slug pattern maps to TEST; everything
 * else is PRODUCTION.
 */
export function classifyTenantSlug(slug: string): TenantClass {
  if (slug === DEMO_SLUG) return TenantClass.DEMO;
  if (slug === HOUSE_TENANT_SLUG) return TenantClass.INTERNAL;
  if (TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug)) return TenantClass.TEST;
  return TenantClass.PRODUCTION;
}
