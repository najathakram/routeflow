/**
 * Shared test constants — credentials and tenant slug.
 * Operator/customer values come from the e2e seed applied to the e2e-routeflow tenant.
 * Override PLAYWRIGHT_TENANT_SLUG env var if you use a different seed tenant.
 *
 * Super-admin credentials are NEVER hardcoded — set PLAYWRIGHT_SA_USERNAME /
 * PLAYWRIGHT_SA_PASSWORD in the environment; super-admin specs skip when absent.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

// Only approved test tenants may be targeted by e2e — never a live client tenant.
export const TENANT_SLUG: string = assertTestTenant(
  process.env.PLAYWRIGHT_TENANT_SLUG ?? "e2e-routeflow",
  "playwright e2e",
);

export const CREDENTIALS = {
  superAdmin: {
    username: process.env.PLAYWRIGHT_SA_USERNAME ?? "",
    password: process.env.PLAYWRIGHT_SA_PASSWORD ?? "",
  },
  operator: { username: "admin", password: "Admin@123" },
  customer: { username: "harbor_cafe", password: "Customer1!" },
  tenantAdmin: { username: "e2e_admin", password: "TenantAdmin1!" },
  // Dedicated identity for the spec that revokes /auth/sessions rows server-side (L-050) — never
  // the shared operator/tenant-admin above, which every storageState: operator.json project
  // also loads. Seeded by apps/api/scripts/e2e-seed.js.
  sessionsOp: { username: "e2e_sessions_op", password: "Sessions1!" },
} as const;

/** True when super-admin credentials are provided via env (super-admin specs skip otherwise). */
export const HAS_SUPER_ADMIN_CREDS =
  CREDENTIALS.superAdmin.username.length > 0 && CREDENTIALS.superAdmin.password.length > 0;

// A unique-enough email for the buyer register test (timestamp suffix)
export function uniqueBuyerEmail(): string {
  return `e2e_buyer_${Date.now()}@example.com`;
}
