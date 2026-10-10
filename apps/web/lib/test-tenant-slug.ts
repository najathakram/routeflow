/**
 * Mirrors the test-tenant policy in scripts/lib/test-tenants.cjs (and the API's tenant-class.util):
 * a slug that matches is a TEST tenant. The platform-admin create form uses it to say so before the
 * super admin submits — the API allows these slugs there, but flags them.
 */
const TEST_TENANT_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

export function isTestTenantSlug(slug: string): boolean {
  const s = slug.trim().toLowerCase();
  return s.length > 0 && (TEST_TENANT_SLUGS.has(s) || TEST_TENANT_PATTERN.test(s));
}
