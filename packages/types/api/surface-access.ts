// ─── Surface registry (W-1496 T1, SA-1548 D1 "R3a") ──────────────────────────────────────────────────
//
// ONE answer to "may this staff member use this page or action", shared by web and mobile. Pure functions only:
// no React, no fetch. Nothing calls `mayUse` yet (T2 wires the menu to it).
//
// Access is NEVER stored here. A page's group (or BASE / ADMIN) comes from `routeAccess(href)` in ./permissions, the
// one route map the server pin (apps/api/src/common/surface-inventory.spec.ts) checks against the pinned server
// map. This file only says WHICH pages exist, which server read each one makes, and which web gates (plan flag,
// config mode, add-on) hide it today.

import { routeAccess } from "./permissions";
import { staffMay, type StaffCapability } from "./staff-capabilities";

/** One OPERATOR menu page. It carries no group and no access level; both come from `routeAccess(href)`. */
export interface PageSurface {
  /** The menu href. `/compliance/:sectionId` is a pattern: `:name` matches exactly one path segment. */
  href: string;
  /** The `Controller.method` (a key of the pinned PERMISSION_MAP) behind the page's main list or read. */
  primaryRead: string;
  /** The plan flag that gates the page (PLAN_GATED_NAV[href] in apps/web/lib/plan-gated-nav.ts). */
  planFlag?: string;
  /** The back-office config mode that hides the page when off (the MODE_GATED_NAV key). */
  mode?: string;
  /** The OperatorNavContext flag that gates the href in build-operator-nav today. Recorded only; T1 does not read it. */
  addon?: string;
}

/**
 * Exactly one row per OPERATOR menu href: the OPERATOR_NAV leaves, INSIGHTS_LEAF and the injected hrefs, with
 * /compliance/:sectionId as one pattern row. apps/web/app/(dashboard)/_components/page-surfaces.test.ts pins the set
 * to what `buildOperatorNav` can produce.
 *
 * `addon` is set only where ONE boolean context flag decides the href. /dispatch and /drivers (shown when routesAccess
 * OR deliveryAccess), /routes/my-runs (canActAsDriver and a visible Dispatch group) and /compliance/:sectionId (a
 * non-empty regulatedSections list) have no single flag, so they carry none.
 */
export const PAGE_SURFACES: readonly PageSurface[] = [
  { href: "/dashboard", primaryRead: "SettingsController.getSettings" },
  { href: "/orders", primaryRead: "OrdersController.findAll" },
  {
    href: "/orders/counter-sale",
    primaryRead: "CounterSaleController.today",
    addon: "counterEnabled",
  },
  {
    href: "/estimates",
    primaryRead: "EstimatesController.findAll",
    planFlag: "flag.estimates",
  },
  { href: "/returns", primaryRead: "ReturnsController.findAll", planFlag: "flag.returns" },
  { href: "/dispatch", primaryRead: "RouteRunsController.findAll" },
  { href: "/routes", primaryRead: "RoutesController.findAll", addon: "routesAccess" },
  { href: "/routes/my-runs", primaryRead: "RouteRunsController.findAll" },
  { href: "/deliveries", primaryRead: "RoutesController.findAll", addon: "deliveryAccess" },
  { href: "/shipments", primaryRead: "InvoicesController.findAll" },
  { href: "/drivers", primaryRead: "DriversController.findAll" },
  { href: "/customers", primaryRead: "CustomersController.findAll" },
  { href: "/sales-agents", primaryRead: "SalesAgentsController.findAll", addon: "hasSalesAgents" },
  { href: "/inventory", primaryRead: "InventoryController.getStockOverview" },
  { href: "/purchase-orders", primaryRead: "InventoryController.listPOs" },
  { href: "/products", primaryRead: "ProductsController.findAll" },
  { href: "/promotions", primaryRead: "PromotionsController.findAll", mode: "promotions" },
  { href: "/suppliers", primaryRead: "SuppliersController.findAll", planFlag: "flag.suppliers" },
  {
    href: "/vendor-bills",
    primaryRead: "VendorBillsController.findAll",
    planFlag: "flag.ap_bills",
  },
  { href: "/finance/statements", primaryRead: "SupplierStatementsController.findOne" },
  { href: "/finance/dashboard", primaryRead: "BookkeepingController.getFinanceDashboard" },
  { href: "/invoices", primaryRead: "InvoicesController.findAll" },
  { href: "/finance/payments", primaryRead: "InvoicesController.listAllPayments" },
  { href: "/finance/payment-requests", primaryRead: "PaymentRequestsController.list" },
  {
    href: "/finance/commissions",
    primaryRead: "CommissionStatementsController.findAll",
    addon: "hasSalesAgents",
  },
  {
    href: "/credit-notes",
    primaryRead: "CreditNotesController.findAll",
    planFlag: "flag.credit_notes",
  },
  {
    href: "/finance/reports",
    primaryRead: "BookkeepingController.getSalesByCustomer",
    planFlag: "flag.reports",
  },
  { href: "/analytics", primaryRead: "AnalyticsController.getRevenue", planFlag: "flag.analytics" },
  {
    href: "/insights",
    primaryRead: "ProductInsightsController.getInsights",
    planFlag: "flag.analytics",
  },
  { href: "/settings", primaryRead: "SettingsController.getSettings" },
  { href: "/compliance/:sectionId", primaryRead: "RegulatedController.getLedger" },
];

// ─── mayUse ─────────────────────────────────────────────────────────────────────────────────────────────

/** The state of one plan flag, as the web's plan hook reports it (mirrors PlanFlagState in apps/web/lib/plan-gated-nav.ts). */
export interface SurfacePlanFlagState {
  enabled: boolean;
  resolved: boolean;
  failed: boolean;
}

export interface SurfacePrincipal {
  role: string | null | undefined;
  /** The operator's denied groups; `undefined` while they load (loading hides). */
  deniedGroups: readonly string[] | undefined;
  /** Plan flag states keyed by flag name (e.g. "flag.analytics"). A plan-gated page needs its flag present here. */
  plan?: Readonly<Record<string, SurfacePlanFlagState>>;
}

export type SurfaceRef = { page: string } | { action: StaffCapability };

function normalizeHref(href: string): string {
  const cut = href.search(/[?#]/);
  const bare = cut === -1 ? href : href.slice(0, cut);
  const trimmed = bare.length > 1 ? bare.replace(/\/+$/, "") : bare;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

/** The registry row for `href`: an exact match, or a `:param` pattern row matching segment for segment. */
function findSurface(href: string): PageSurface | undefined {
  const target = normalizeHref(href);
  const exact = PAGE_SURFACES.find((s) => s.href === target);
  if (exact) return exact;
  const parts = target.split("/");
  return PAGE_SURFACES.find((s) => {
    if (!s.href.includes("/:")) return false;
    const pattern = s.href.split("/");
    return (
      pattern.length === parts.length &&
      pattern.every((seg, i) => (seg.startsWith(":") ? parts[i] !== "" : seg === parts[i]))
    );
  });
}

function planVisible(row: PageSurface, principal: SurfacePrincipal): boolean {
  if (!row.planFlag) return true;
  const state = principal.plan?.[row.planFlag];
  if (!state) return false;
  return state.resolved ? state.enabled : state.failed;
}

/**
 * May this principal use this page or action? Pure.
 *
 * action: loading denied groups (`undefined`) -> false; otherwise exactly `staffMay`.
 * page:   only staff (OPERATOR, TENANT_ADMIN) read operator rows; a buyer or driver gets their own menu's verdict.
 *         A href with no registry row is refused (closed world). Then plan AND permission: a row's plan flag must be
 *         visible (resolved ? enabled : failed, so a failed plan load fails open) AND the role must be permitted
 *         (TENANT_ADMIN always; OPERATOR needs loaded groups, a known non-ADMIN access, and for GROUPS at least one
 *         group not denied). The plan's fail-open never reopens a permission-denied page.
 *
 * `mode` and `addon` on a row are recorded only; this does not read them (T2 wires them).
 */
export function mayUse(principal: SurfacePrincipal, ref: SurfaceRef): boolean {
  if ("action" in ref) {
    if (principal.deniedGroups === undefined) return false;
    return staffMay(principal.role, ref.action, principal.deniedGroups);
  }
  if (principal.role !== "OPERATOR" && principal.role !== "TENANT_ADMIN") return false;
  const row = findSurface(ref.page);
  if (!row) return false;
  if (!planVisible(row, principal)) return false;
  if (principal.role === "TENANT_ADMIN") return true;
  const denied = principal.deniedGroups;
  if (denied === undefined) return false;
  const access = routeAccess(row.href.replace(/:[A-Za-z]+/g, "x"));
  switch (access.kind) {
    case "BASE":
      return true;
    case "GROUPS":
      return access.anyOf.some((g) => !denied.includes(g));
    default:
      return false; // ADMIN (not an operator's page) and UNKNOWN (closed)
  }
}
