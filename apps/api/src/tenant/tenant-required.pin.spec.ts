import "reflect-metadata";
import { AppModule } from "../app.module";
import { collectControllers, routesOf, type RouteRecord } from "../common/testing/route-table";
import { PLATFORM_SCOPED_KEY } from "./platform-scoped.decorator";

/**
 * W-767 (SA-908) allow-list pin: every mutating route a tenantless SUPER_ADMIN may write through is `@PlatformScoped()`,
 * listed here by verb, path and `Controller#handler`, so a new one fails until it is reviewed. Static metadata walk:
 * no DB, no Nest boot (the read-only-route-pin pattern).
 *
 * The rule the list keeps: platform-scoped == the super-admin back office (`SuperAdminGuard`). A tenant route marked by
 * mistake would let a tenantless write through the interceptor, so the two sets must stay equal.
 */
const rows: Array<{ route: RouteRecord; platform: boolean }> = collectControllers(
  AppModule,
).flatMap((ctrl) =>
  routesOf(ctrl).map((route) => ({
    route,
    platform: !!(
      Reflect.getMetadata(PLATFORM_SCOPED_KEY, (ctrl as any).prototype[route.handler]) ??
      Reflect.getMetadata(PLATFORM_SCOPED_KEY, ctrl)
    ),
  })),
);
const key = (r: RouteRecord) => `${r.method} ${r.path} ${r.controller}#${r.handler}`;

const EXPECTED_PLATFORM_WRITES: string[] = [
  "DELETE /api/v1/billing/admin/plans/versions/:versionId PlanAdminController#discardDraft",
  "DELETE /api/v1/platform-admin/customer-links/:id CustomerLinksAdminController#removeLink",
  "DELETE /api/v1/platform-admin/tenants/:id PlatformAdminController#deleteTenant",
  "DELETE /api/v1/platform-admin/tenants/:id/feature-config/:key FeatureConfigController#clearState",
  "PATCH /api/v1/billing/admin/plans/versions/:versionId/definitions/:planKey PlanAdminController#updateDefinition",
  "PATCH /api/v1/billing/admin/plans/versions/:versionId/skus/:sku PlanAdminController#updateSku",
  "PATCH /api/v1/platform-admin/ai-config PlatformAdminController#updateAiConfig",
  "PATCH /api/v1/platform-admin/buyer-accounts/:id BuyerAdminController#updateBuyer",
  "PATCH /api/v1/platform-admin/buyer-accounts/:id/status BuyerAdminController#setBuyerStatus",
  "PATCH /api/v1/platform-admin/config/auto-locks AutoLocksAdminController#set",
  "PATCH /api/v1/platform-admin/onboarding/cases/:id OnboardingController#update",
  "PATCH /api/v1/platform-admin/plans/:planKey/prices PlatformAdminController#updatePlanPrices",
  "PATCH /api/v1/platform-admin/tenants/:id/billing/price-override PlatformAdminController#updateTenantPriceOverride",
  "PATCH /api/v1/platform-admin/tenants/:id/class PlatformAdminController#updateTenantClass",
  "PATCH /api/v1/platform-admin/tenants/:id/config PlatformAdminController#updateTenantConfig",
  "PATCH /api/v1/platform-admin/tenants/:id/plan PlatformAdminController#updatePlan",
  "PATCH /api/v1/platform-admin/tenants/:id/status PlatformAdminController#updateStatus",
  "POST /api/v1/billing/admin/plans/versions PlanAdminController#createDraft",
  "POST /api/v1/billing/admin/plans/versions/:versionId/publish PlanAdminController#publish",
  "POST /api/v1/billing/checkout BillingController#createCheckout",
  "POST /api/v1/billing/tenants/:tenantId/ensure-customer BillingController#ensureCustomer",
  "POST /api/v1/billing/tenants/:tenantId/portal BillingController#createPortal",
  "POST /api/v1/platform-admin/ai-config/test PlatformAdminController#testAiConnection",
  "POST /api/v1/platform-admin/buyer-accounts/:id/impersonate BuyerAdminController#impersonateBuyer",
  "POST /api/v1/platform-admin/buyer-accounts/:id/links BuyerAdminController#addBuyerLink",
  "POST /api/v1/platform-admin/buyer-merge-requests BuyerAdminMergeController#create",
  "POST /api/v1/platform-admin/buyer-merge-requests/:id/execute BuyerAdminMergeController#execute",
  "POST /api/v1/platform-admin/buyer-merge-requests/:id/reject BuyerAdminMergeController#reject",
  "POST /api/v1/platform-admin/features/diffs/:id/explain PlatformAdminController#explainFeatureDiff",
  "POST /api/v1/platform-admin/onboarding/cases OnboardingController#create",
  "POST /api/v1/platform-admin/onboarding/cases/:id/adopt-catalog OnboardingController#adoptCatalog",
  "POST /api/v1/platform-admin/onboarding/cases/:id/advance OnboardingController#advance",
  "POST /api/v1/platform-admin/onboarding/cases/:id/auto-checks OnboardingController#runAutoChecks",
  "POST /api/v1/platform-admin/onboarding/cases/:id/files OnboardingController#uploadFile",
  "POST /api/v1/platform-admin/onboarding/cases/:id/intake-link OnboardingController#issueLink",
  "POST /api/v1/platform-admin/onboarding/cases/:id/intake-link/revoke OnboardingController#revokeLink",
  "POST /api/v1/platform-admin/onboarding/cases/:id/sections/:key/review OnboardingController#reviewSection",
  "POST /api/v1/platform-admin/onboarding/cases/:id/steps/:key/complete OnboardingController#complete",
  "POST /api/v1/platform-admin/onboarding/cases/:id/steps/:key/reopen OnboardingController#reopen",
  "POST /api/v1/platform-admin/onboarding/cases/:id/steps/:key/waive OnboardingController#waive",
  "POST /api/v1/platform-admin/rf-invoices/:id/mark-paid RfInvoicesController#markPaid",
  "POST /api/v1/platform-admin/rf-invoices/:id/reopen RfInvoicesController#reopen",
  "POST /api/v1/platform-admin/rf-invoices/:id/send RfInvoicesController#sendOne",
  "POST /api/v1/platform-admin/rf-invoices/:id/void RfInvoicesController#voidInvoice",
  "POST /api/v1/platform-admin/rf-invoices/send RfInvoicesController#sendMany",
  "POST /api/v1/platform-admin/tenants PlatformAdminController#createTenant",
  "POST /api/v1/platform-admin/tenants/:id/activate-subscription PlatformAdminController#activateManualSubscription",
  "POST /api/v1/platform-admin/tenants/:id/addons/disable PlatformAdminController#disableAddon",
  "POST /api/v1/platform-admin/tenants/:id/addons/enable PlatformAdminController#enableAddon",
  "POST /api/v1/platform-admin/tenants/:id/addons/uncomp PlatformAdminController#uncompAddon",
  "POST /api/v1/platform-admin/tenants/:id/admin PlatformAdminController#createTenantAdmin",
  "POST /api/v1/platform-admin/tenants/:id/billing/catchup-checkout CatchupAdminController#open",
  "POST /api/v1/platform-admin/tenants/:id/billing/checkout PlatformAdminController#createCheckout",
  "POST /api/v1/platform-admin/tenants/:id/billing/portal PlatformAdminController#createPortal",
  "POST /api/v1/platform-admin/tenants/:id/business-capabilities PlatformAdminController#applyBusinessCapabilities",
  "POST /api/v1/platform-admin/tenants/:id/business-capabilities/preview PlatformAdminController#previewBusinessCapabilities",
  "POST /api/v1/platform-admin/tenants/:id/business-profile PlatformAdminController#applyBusinessProfile",
  "POST /api/v1/platform-admin/tenants/:id/business-profile/preview PlatformAdminController#previewBusinessProfile",
  "POST /api/v1/platform-admin/tenants/:id/config-snapshots/:snapshotId/restore PlatformAdminController#restoreConfigSnapshot",
  "POST /api/v1/platform-admin/tenants/:id/extend-trial PlatformAdminController#extendTrial",
  "POST /api/v1/platform-admin/tenants/:id/feature-overrides PlatformAdminController#createFeatureOverride",
  "POST /api/v1/platform-admin/tenants/:id/feature-overrides/:overrideId/revoke PlatformAdminController#revokeFeatureOverride",
  "POST /api/v1/platform-admin/tenants/:id/features/preview PlatformAdminController#previewTenantFeatures",
  "POST /api/v1/platform-admin/tenants/:id/impersonate PlatformAdminController#impersonate",
  "POST /api/v1/platform-admin/tenants/:id/reset-admin-password PlatformAdminController#resetAdminPassword",
  "POST /api/v1/platform-admin/tenants/:id/rf-invoices/issue RfInvoicesController#issueForTenant",
  "PUT /api/v1/platform-admin/app-links PlatformAdminController#updateAppLinks",
  "PUT /api/v1/platform-admin/entitlements/config-snapshot PlatformAdminController#setConfigSnapshotFlag",
  "PUT /api/v1/platform-admin/entitlements/mode PlatformAdminController#setEntitlementsMode",
  "PUT /api/v1/platform-admin/tenants/:id/feature-config/:key FeatureConfigController#setState",
];

describe("W-767: the @PlatformScoped() write routes (TenantRequiredInterceptor's allow-list)", () => {
  it("is exactly this list (count and names): a new platform write is reviewed before it ships", () => {
    const found = rows
      .filter((x) => x.platform && x.route.mutating)
      .map((x) => key(x.route))
      .sort();
    expect(found).toEqual([...EXPECTED_PLATFORM_WRITES].sort());
  });

  it("platform-scoped == the SuperAdminGuard back office: every admin write is marked, and no tenant route is", () => {
    const writes = rows.filter((x) => x.route.mutating);
    const adminUnmarked = writes.filter((x) => x.route.context === "SUPER_ADMIN" && !x.platform);
    const markedNotAdmin = writes.filter((x) => x.platform && x.route.context !== "SUPER_ADMIN");
    expect(adminUnmarked.map((x) => key(x.route))).toEqual([]);
    expect(markedNotAdmin.map((x) => key(x.route))).toEqual([]);
  });
});
