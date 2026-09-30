/**
 * Shared HTTP client for `report-tenant-plan.mjs` / `set-e2e-tenant-plan.mjs` (B450).
 *
 * Both scripts resolve/inspect/write a tenant's plan ONLY through the deployed API's
 * real, validated platform-admin surface (`SUPER_ADMIN` login → `/platform-admin/*`)
 * — never a direct DB/Prisma connection and never a hand-rolled mirror of
 * `EntitlementsService`/`plan-catalog.constants.ts` (unlike `audit-tenant-entitlements.mjs`,
 * which has to mirror that logic in plain SQL because it talks to Postgres directly; going
 * through the API means every read/write here uses the exact same code path a live admin
 * click would, so it can never drift from it). Requires a *running* API — `railway run`
 * (a DB tunnel) does nothing for these; set `API_URL` to point at it instead.
 *
 * "Read-only" caveat: resolving live flags requires impersonating the tenant's
 * TENANT_ADMIN (there is no other endpoint that returns EntitlementsService's resolved
 * view), which the API itself audit-logs as an IMPERSONATION_STARTED action — the one
 * side effect either script has, inherent to reusing the real path safely.
 */

const DEFAULT_BASE = "http://localhost:3000/api/v1";

export function resolveApiBase() {
  const base = process.env.API_URL || DEFAULT_BASE;
  console.log(
    `API base: ${base}${process.env.API_URL ? "" : " (default — set API_URL to override)"}`,
  );
  return base;
}

async function request(base, method, path, { token, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = json?.message ?? text ?? res.statusText;
    throw new Error(
      `${method} ${path} → ${res.status}: ${Array.isArray(message) ? message.join("; ") : message}`,
    );
  }
  return json;
}

/** SUPER_ADMIN login via the normal `/auth/login` — a SUPER_ADMIN user carries no
 *  tenantId, so no `X-Tenant-Slug` header is needed. Requires
 *  `SUPER_ADMIN_USERNAME`/`SUPER_ADMIN_PASSWORD` in the environment (never hardcoded). */
export async function loginAsSuperAdmin(base) {
  const username = process.env.SUPER_ADMIN_USERNAME;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  if (!username || !password) {
    throw new Error(
      "SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD must be set in the environment.",
    );
  }
  const result = await request(base, "POST", "/auth/login", { body: { username, password } });
  if (result?.user?.role !== "SUPER_ADMIN") {
    throw new Error(`Expected role SUPER_ADMIN, got ${result?.user?.role ?? "(none)"}`);
  }
  return result.accessToken;
}

/**
 * Exact (case-insensitive) slug match against `/platform-admin/tenants?search=`
 * (`listTenants()` returns `{data, meta}`, and its `subscription` projection is
 * partial — id-only lookup here, the caller fetches the full record separately).
 * Throws on zero or more-than-one match rather than guessing.
 */
export async function findTenantBySlug(base, adminToken, slug) {
  const result = await request(
    base,
    "GET",
    `/platform-admin/tenants?search=${encodeURIComponent(slug)}&limit=10`,
    {
      token: adminToken,
    },
  );
  const matches = (result?.data ?? []).filter((t) => t.slug?.toLowerCase() === slug.toLowerCase());
  if (matches.length === 0) {
    throw new Error(`No tenant found with slug "${slug}".`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Ambiguous: ${matches.length} tenants matched slug "${slug}" exactly — refusing to guess.`,
    );
  }
  return matches[0];
}

/** Full tenant record (legacy `plan` enum + the COMPLETE `subscription` row, including
 *  `planKey`/`planVersionId` — the list endpoint's projection omits those) via
 *  `GET /platform-admin/tenants/:id`. */
export async function getTenantDetail(base, adminToken, tenantId) {
  return request(base, "GET", `/platform-admin/tenants/${tenantId}`, { token: adminToken });
}

/**
 * The tenant's RESOLVED view — `{planKey, flags, planName, status, ...}` exactly as
 * `EntitlementsService`/`SubscriptionService.getSubscription()` compute it for that
 * tenant's own dashboard. Reached by impersonating its TENANT_ADMIN (15-min token,
 * audit-logged by the API itself) and calling `/billing/subscription` as them.
 */
export async function getResolvedSubscription(base, adminToken, tenantId) {
  const { accessToken } = await request(
    base,
    "POST",
    `/platform-admin/tenants/${tenantId}/impersonate`,
    {
      token: adminToken,
    },
  );
  return request(base, "GET", "/billing/subscription", { token: accessToken });
}

/** `PATCH /platform-admin/tenants/:id/plan` — the same write a platform-admin UI click makes. */
export async function updateTenantPlan(base, adminToken, tenantId, plan) {
  return request(base, "PATCH", `/platform-admin/tenants/${tenantId}/plan`, {
    token: adminToken,
    body: { plan },
  });
}

/** The 5 Lite-L2 flags this whole investigation is about — display labels only, not
 *  business logic (the actual grant decision always comes from the resolved `flags` array
 *  above, never re-derived here). */
export const LITE_L2_FLAGS = [
  "flag.estimates",
  "flag.recurring_invoices",
  "flag.credit_notes",
  "flag.suppliers",
  "flag.messaging",
];
