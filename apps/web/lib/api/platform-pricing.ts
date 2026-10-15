// Platform-admin billing pricing: catalog-driven Stripe prices + per-tenant custom fees.
// Mirrors the existing platform-admin fetch pattern (plain async functions over
// `superAdminClient`, called from component-local state — this area has no TanStack Query).
// Backing endpoints: WP2/WP3 of `.claude/pipeline/plans/2026-08-21-platform-billing-pricing.md`
// (`PlatformPricingService` + `platform-admin.controller.ts`).
import { API_ERROR_CODES } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";

export type BillingInterval = "month" | "year";

/** `PlatformPricingService.resolveTenantPricing` output. */
export interface TenantPricingResolution {
  planKey: string;
  planName: string;
  monthly: number;
  annual: number;
  source: "override" | "catalog";
  currency: string;
}

/**
 * `GET /platform-admin/tenants/:id/billing/pricing` — resolution + live-subscription
 * context. The resolved figures are NULL (`resolvable: false`) for a plan the catalog
 * can't price (ENTERPRISE / isCustom with no custom fee yet); the endpoint still returns
 * the raw override columns + subscription state so the custom-fee form stays usable.
 */
export interface TenantPricingResponse {
  resolvable: boolean;
  planKey: string | null;
  planName: string | null;
  monthly: number | null;
  annual: number | null;
  source: "override" | "catalog" | null;
  currency: string;
  /** Raw override columns — prefill the editor from these, never from the resolution. */
  override: { monthly: number | null; annual: number | null };
  subscription: {
    stripeSubId: string | null;
    status: "none" | "canceling" | "active";
    periodEnd: string | null;
    billingInterval: BillingInterval | null;
  };
}

/** When a price override takes effect on a live Stripe subscription (`next_cycle` is the default). */
export type PriceOverrideEffective = "next_cycle" | "now_prorated";

/** `BillingService.syncStripeSubscriptionPrice` result. */
export interface PriceSyncResult {
  synced: boolean;
  reason?: string;
  oldAmount?: number;
  newAmount?: number;
  /** The proration mode actually sent to Stripe: `none` even for `now_prorated` on a past-due subscription. */
  proration?: "none" | "create_prorations";
  /** Stripe already billed the new amount, so nothing was sent. */
  unchanged?: boolean;
}

/** `PlatformAdminService.updateTenantPriceOverride` — the resolution flattened with `sync`. */
export interface PriceOverrideUpdateResult extends TenantPricingResolution {
  sync: PriceSyncResult;
}

export interface PlanPriceFanoutResult {
  planKey: string;
  monthlyPrice: number;
  annualPrice: number | null;
  updated: number;
  synced: number;
  failed: number;
}

/** `PlanDefinition` row as projected by the public catalog (`GET /billing/plans`). Decimal
 *  fields serialize as strings — see plan-catalog.controller.ts. */
export interface PlanCatalogEntry {
  planKey: string;
  name: string;
  monthlyPrice: string | null;
  annualPrice: string | null;
  isCustom: boolean;
  sortOrder: number;
}

export interface PlanCatalogResponse {
  version: string | number;
  effectiveAt: string | null;
  plans: PlanCatalogEntry[];
}

function errorMessage(err: unknown, fallback: string): string {
  return (
    (
      err as { response?: { data?: { message?: string | string[] } } }
    )?.response?.data?.message?.toString() ?? fallback
  );
}

export { errorMessage as platformPricingErrorMessage };

/** Fixed copy for an admin-created checkout refused in the window before the 1st (the API's CHECKOUT_ANCHOR_WINDOW). */
const CHECKOUT_REOPENS_SOON_COPY = "Checkout reopens in a few minutes.";

/**
 * The admin "Create checkout session" failure: the anchor window gets FIXED copy plus the browser-local time of the
 * `retryAt` field (never the server's message); every other failure keeps the existing message path.
 */
export function tenantCheckoutErrorMessage(err: unknown): string {
  const body = (err as { response?: { data?: { code?: unknown; retryAt?: unknown } } } | undefined)
    ?.response?.data;
  if (body?.code === API_ERROR_CODES.CHECKOUT_ANCHOR_WINDOW) {
    const retryAt = new Date(typeof body.retryAt === "string" ? body.retryAt : NaN);
    return Number.isNaN(retryAt.getTime())
      ? CHECKOUT_REOPENS_SOON_COPY
      : `Checkout reopens at ${retryAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  }
  return errorMessage(err, "Failed to create checkout session");
}

export async function fetchTenantPricing(tenantId: string): Promise<TenantPricingResponse> {
  const res = await superAdminClient.get(`/platform-admin/tenants/${tenantId}/billing/pricing`);
  return res.data;
}

export async function updateTenantPriceOverride(
  tenantId: string,
  body: { monthly?: number | null; annual?: number | null; effective?: PriceOverrideEffective },
): Promise<PriceOverrideUpdateResult> {
  const res = await superAdminClient.patch(
    `/platform-admin/tenants/${tenantId}/billing/price-override`,
    body,
  );
  return res.data;
}

export async function createTenantCheckout(
  tenantId: string,
  interval: BillingInterval = "month",
): Promise<{ checkoutUrl: string }> {
  const res = await superAdminClient.post(`/platform-admin/tenants/${tenantId}/billing/checkout`, {
    interval,
  });
  return res.data;
}

export async function fetchPlanCatalog(): Promise<PlanCatalogResponse> {
  const res = await superAdminClient.get(`/billing/plans`);
  return res.data;
}

export async function updatePlanPrices(
  planKey: string,
  body: { monthly: number; annual?: number | null },
): Promise<PlanPriceFanoutResult> {
  const res = await superAdminClient.patch(`/platform-admin/plans/${planKey}/prices`, body);
  return res.data;
}
