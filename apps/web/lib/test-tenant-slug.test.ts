/**
 * The web copy of the test-tenant pattern must agree with the repo-root policy module
 * (scripts/lib/test-tenants.cjs, the single source of truth) — a drift would make the platform-admin
 * create form mislabel a slug without any build failing.
 */
import { isTestTenantSlug } from "./test-tenant-slug";

const policy = require("../../../scripts/lib/test-tenants.cjs") as {
  isTestTenant: (slug: string) => boolean;
  TEST_TENANT_SLUGS: Set<string>;
};

describe("isTestTenantSlug agrees with scripts/lib/test-tenants.cjs", () => {
  const SLUGS = [
    ...policy.TEST_TENANT_SLUGS,
    "qa-foods",
    "qa-",
    "e2e-run-1",
    "ux-audit-7",
    "qa",
    "e2e",
    "test-foods",
    "acme-foods",
    "acme-qa-foods",
    "routeflow-hq",
    "a",
  ];

  it.each(SLUGS)("%s", (slug) => {
    expect(isTestTenantSlug(slug)).toBe(policy.isTestTenant(slug));
  });

  it("is case- and whitespace-insensitive like the form needs, and false for empty input", () => {
    expect(isTestTenantSlug("  QA-Foods ")).toBe(true);
    expect(isTestTenantSlug("")).toBe(false);
    expect(isTestTenantSlug("   ")).toBe(false);
  });
});
