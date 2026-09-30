// Platform-admin billing pricing: catalog-driven Stripe prices + per-tenant custom fees.
// Mirrors the existing platform-admin fetch pattern (plain async functions over
// `superAdminClient`, called from component-local state — this area has no TanStack Query).
// Backing endpoints: WP2/WP3 of `.claude/pipeline/plans/2026-08-21-platform-billing-pricing.md`
// (`PlatformPricingService` + `platform-admin.controller.ts`).
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

/** `BillingService.syncStripeSubscriptionPrice` result. */
export interface PriceSyncResult {
  synced: boolean;
  reason?: string;
  oldAmount?: number;
  newAmount?: number;
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

export async function fetchTenantPricing(tenantId: string): Promise<TenantPricingResponse> {
  const res = await superAdminClient.get(`/platform-admin/tenants/${tenantId}/billing/pricing`);
  return res.data;
}

export async function updateTenantPriceOverride(
  tenantId: string,
  body: { monthly?: number | null; annual?: number | null },
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
