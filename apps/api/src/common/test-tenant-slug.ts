/**
 * The approved test-tenant slugs, mirrored for the API runtime. The API's dist cannot `require`
 * `scripts/lib/test-tenants.cjs` (that file is not in the image), so this is a literal copy.
 * `settings-fulfilment/fulfilment-self-serve.spec.ts` pins it to the original (same list, same pattern).
 */
const TEST_TENANT_SLUGS: ReadonlySet<string> = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_TENANT_PATTERN = /^(qa|e2e|ux-audit)-/;

export function isTestTenantSlug(slug: unknown): boolean {
  if (typeof slug !== "string" || slug.length === 0) return false;
  return TEST_TENANT_SLUGS.has(slug) || TEST_TENANT_PATTERN.test(slug);
}
