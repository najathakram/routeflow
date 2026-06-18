/**
 * Shared test constants — credentials and tenant slug.
 * All values come from the fresh-data.js seed already applied to the Railway DB.
 * Override PLAYWRIGHT_TENANT_SLUG env var if you use a different seed tenant.
 */

export const TENANT_SLUG = process.env.PLAYWRIGHT_TENANT_SLUG ?? "e2e-routeflow";

export const CREDENTIALS = {
  superAdmin: { username: "najathakram", password: "Najath123!" },
  operator: { username: "admin", password: "Admin@123" },
  customer: { username: "harbor_cafe", password: "Customer1!" },
} as const;

// A unique-enough email for the buyer register test (timestamp suffix)
export function uniqueBuyerEmail(): string {
  return `e2e_buyer_${Date.now()}@example.com`;
}
