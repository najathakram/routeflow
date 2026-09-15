/**
 * Feature registry — the single source of truth for every grantable feature in RouteFlow:
 * add-ons, plan flags, limits, metered caps, and config toggles. `addon-gate-registry.ts` is now
 * a thin, byte-identical projection of the six `RequireAddon`-gated rows here (see
 * `ADDON_GATE_REGISTRY`/`addonGateState` below); `AddonGuard` keeps importing that file, unchanged.
 *
 * This PR (feature grants PR-1) only adds the data model and the addon-gate derivation — nothing
 * new is wired to `FEATURE_REGISTRY` yet. Future PRs read it directly for a shadow entitlement
 * resolver, a Prisma-backed schema, and a grants dashboard.
 *
 * `feature-registry.spec.ts` is what keeps this file honest: a zero-diff `toEqual` against
 * today's addon-gate literal, a live-call-site scan for both `@RequireAddon` and
 * `@RequirePlanFlag`, a `DARK_PLAN_FLAGS` (`plan-flag.guard.ts`) parity check, catalog-key
 * coverage against `publish-plan-catalog-v8..v11.ts`, `reviewBy`-not-expired, and
 * `requires`/`conflicts` acyclic/reference checks.
 *
 * Why the projection exists: PR #475 (2026-08-29) added `@RequireAddon("ocr")` to four routes
 * with no grant for the tenants already using them; every one of them was denied for five days
 * before a client reported it. `addon-gate-registry.spec.ts`'s P1a-P1h checks (now driven off
 * this file's data) are what make shipping an unregistered `@RequireAddon` key impossible.
 */

export type FeatureKind = "boolean" | "limit" | "metered";
export type FeatureArea =
  "routes" | "catalog" | "finance" | "compliance" | "integrations" | "sales" | "platform";
export type FeatureGateVia = "RequireAddon" | "RequirePlanFlag" | "guard" | "service" | "none";
export type FeatureGateState = "dark" | "enforced" | "none";

export interface FeatureGate {
  via: FeatureGateVia;
  state: FeatureGateState;
  /** Only meaningful when `via` turns a kill-switch env var on/off (RequirePlanFlag/service today). */
  envSwitched?: true;
  /**
   * `service`-gated features only: what a resolution THROW falls back to.
   * `"closed"` = fall back to the SAFE/restrictive behavior (the check still runs / the
   * restriction still applies) — matches `PlanFlagGuard`'s own "FAIL CLOSED" convention.
   * `"open"` = fall back to the permissive behavior (the restriction is skipped).
   * This is about the FALLBACK on error, never about the flag's granted/ungranted state.
   */
  failMode?: "open" | "closed";
  /** YYYY-MM-DD the gate first shipped (git history, not memory). */
  added: string;
  /** `dark` rows only — YYYY-MM-DD by which the row must be flipped to `enforced` or this date extended. */
  reviewBy?: string;
  /** Informational: the routes/call sites that carry this key today. */
  routes: readonly string[];
  /** The UI or script that writes the row/flag that grants this key — a gate nothing can grant is an outage. */
  grantPath: string;
  /** The deploy-day decision for tenants that already use the feature, in writing. */
  backfill: string;
}

export interface FeatureBilling {
  /** Metadata only, per the tenant's PINNED catalog version — never read at runtime by this PR. */
  skus: readonly string[];
  /** The dotted catalog-flag string this feature is bridged to/from, when it differs from `key` itself. */
  catalogFlag?: string;
  selfService: boolean;
}

export interface FeatureSettingsField {
  type: "boolean" | "string" | "enum";
  key: string;
  label: string;
  default?: boolean | string;
  maxLength?: number;
  options?: readonly string[];
}
export type FeatureSettingsDescriptor = readonly FeatureSettingsField[];

export interface FeatureConfigMode {
  label: string;
  available: boolean;
  requires?: { allOf?: readonly string[] };
  settings: FeatureSettingsDescriptor;
}

export interface FeatureDef {
  key: string;
  kind: FeatureKind;
  area: FeatureArea;
  label: string;
  description: string;
  internal?: true;
  gate: FeatureGate;
  billing: FeatureBilling;
  defaultGranted: boolean;
  requires?: { allOf?: readonly string[]; anyOf?: readonly string[] };
  conflicts?: readonly string[];
  meter?: string;
  config?: { fallbackMode: "unset"; modes: Record<string, FeatureConfigMode> };
}

/** Shared text for the seven `RequirePlanFlag` rows that ship dark under the 2026-08-23 rollout. */
const DARK_PLAN_FLAG_GRANT_PATH =
  "Plan-bundled — granted by a plan's featureFlags or a granting AddonSku; no separate admin " +
  "grant surface (dark: allowed regardless of plan until the flip)";
const DARK_PLAN_FLAG_BACKFILL =
  "2026-08-23 rollout (owner ruling 2026-09-15): reviewBy proposed 2027-01-31, one flag flipped " +
  "to enforced per PR after PR-8 starts, each on its own blast-radius report.";
const ENFORCED_PLAN_FLAG_GRANT_PATH =
  "Plan-bundled — granted by a plan's featureFlags or a granting AddonSku; no separate admin grant surface";
const CATALOG_ONLY_GRANT_PATH =
  "Plan-bundled or the BUYER_PORTAL AddonSku — no server-side gate exists; catalog metadata only";
const CATALOG_ONLY_BACKFILL = "Catalog-only flag; no gate to backfill.";
const NEW_ROW_GRANT_PATH = "Config only — no grant surface; free for every plan";
const NEW_ROW_BACKFILL = "New registry entry; nothing to backfill.";

export const FEATURE_REGISTRY: readonly FeatureDef[] = [
  // ── Six RequireAddon rows — byte-identical to today's ADDON_GATE_REGISTRY (see the zero-diff
  // proof in feature-registry.spec.ts). Copied verbatim from addon-gate-registry.ts.
  {
    key: "ocr",
    kind: "metered",
    area: "finance",
    label: "OCR document scanning",
    description: "AI-assisted line-item extraction from scanned invoices and statements.",
    gate: {
      via: "RequireAddon",
      state: "dark",
      added: "2026-08-29",
      routes: [
        "POST /vendor-bills/scan-invoice",
        "POST /bookkeeping/expenses/:id/extract-items",
        "POST /import/batch/:id/scan",
        "POST /supplier-statements/scan",
      ],
      grantPath:
        'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "ocr")',
      backfill:
        "Owner decision 2026-09-05: OCR available to all tenants; gate stays dark until OCR is " +
        "monetized; no grants required",
      reviewBy: "2027-03-31",
    },
    billing: { skus: ["OCR_PACK_250"], catalogFlag: "addon.ocr", selfService: false },
    defaultGranted: false,
    meter: "SCANS",
  },
  {
    key: "tobacco_dealer",
    kind: "boolean",
    area: "compliance",
    label: "Regulated tobacco dealer program",
    description: "Unlocks the regulated-items ledger, filings, and compliance reports.",
    gate: {
      via: "RequireAddon",
      state: "enforced",
      added: "2026-07-04",
      routes: [
        "GET /regulated/ledger",
        "GET /regulated/reports/preview",
        "GET /regulated/reports/csv",
        "GET /regulated/filings",
        "POST /regulated/filings/prepare",
        "GET /regulated/filings/:id/csv",
        "GET /regulated/filings/:id/pdf",
        "ALL /tobacco/* (class-level)",
      ],
      grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "tobacco_dealer")',
      backfill: "Live before the registry existed (regulated program); no change.",
    },
    billing: {
      skus: ["REGULATED_ITEMS"],
      catalogFlag: "addon.regulated_items",
      selfService: false,
    },
    defaultGranted: false,
  },
  {
    key: "recurring_routes",
    kind: "boolean",
    area: "routes",
    label: "Recurring routes",
    description: "Scheduled, repeating delivery routes and driver run planning.",
    gate: {
      via: "RequireAddon",
      state: "enforced",
      added: "2026-08-29",
      routes: [
        "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of order_delivery/developer_mode)",
        "ALL /routes/* (route-optimization.controller.ts, class-level, any-of order_delivery/developer_mode)",
        "ALL /routes/* (routes.controller.ts, class-level, any-of order_delivery/developer_mode)",
        "ALL /route-runs/* (routes.controller.ts, class-level, any-of order_delivery/developer_mode)",
        "PATCH /trips/routes/:routeId/planning (any-of order_delivery/developer_mode)",
        "ALL /drivers/* (class-level, any-of order_delivery/developer_mode)",
      ],
      grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "recurring_routes")',
      backfill:
        "Live before the registry existed; any-of with order_delivery/developer_mode; no change.",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "order_delivery",
    kind: "boolean",
    area: "routes",
    label: "Ad hoc order delivery",
    description: "One-off, on-demand delivery routes outside the recurring schedule.",
    gate: {
      via: "RequireAddon",
      state: "enforced",
      added: "2026-08-29",
      routes: [
        "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of recurring_routes/developer_mode)",
        "ALL /routes/* (route-optimization.controller.ts, class-level, any-of recurring_routes/developer_mode)",
        "ALL /routes/* (routes.controller.ts, class-level, any-of recurring_routes/developer_mode)",
        "ALL /route-runs/* (routes.controller.ts, class-level, any-of recurring_routes/developer_mode)",
        "ALL /trips/* (class-level, any-of developer_mode)",
        "PATCH /trips/routes/:routeId/planning (any-of recurring_routes/developer_mode)",
        "ALL /drivers/* (class-level, any-of recurring_routes/developer_mode)",
      ],
      grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "order_delivery")',
      backfill: "Live before the registry existed; no change.",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "crm_gohighlevel",
    kind: "boolean",
    area: "integrations",
    label: "GoHighLevel CRM sync",
    description: "Two-way sync of pipelines, contacts, and handoffs with GoHighLevel.",
    gate: {
      via: "RequireAddon",
      state: "dark",
      added: "2026-09-11",
      routes: [
        "GET /crm/gohighlevel",
        "PATCH /crm/gohighlevel/connection",
        "POST /crm/gohighlevel/connection/test",
        "DELETE /crm/gohighlevel/connection",
        "GET /crm/gohighlevel/pipelines",
        "PATCH /crm/gohighlevel/config",
        "POST /crm/gohighlevel/sync",
        "GET /crm/gohighlevel/handoffs",
        "POST /crm/gohighlevel/handoffs/:id/retry",
        "POST /crm/gohighlevel/handoffs/:id/dismiss",
        "POST /crm/gohighlevel/import-existing/preview",
        "POST /crm/gohighlevel/import-existing",
      ],
      grantPath:
        'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "crm_gohighlevel")',
      backfill:
        "New feature 2026-09-11: no tenant has a connection; gate stays dark through the pilot. " +
        "Owner ruling 2026-09-12: BILLABLE add-on at $9.99/month — a follow-up publishes the sellable " +
        "AddonSku (FLAT, granting this key) in the next catalog version; flip to enforced only after that " +
        "SKU exists, the pilot tenant holds it, and the blast-radius report is clean",
      reviewBy: "2027-03-11",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "developer_mode",
    kind: "boolean",
    area: "platform",
    label: "Developer mode",
    description: "Internal switch unlocking in-development mobile/dispatch surfaces.",
    internal: true,
    gate: {
      via: "RequireAddon",
      state: "enforced",
      added: "2026-08-21",
      routes: [
        "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of recurring_routes/order_delivery)",
        "ALL /routes/* (route-optimization.controller.ts, class-level, any-of recurring_routes/order_delivery)",
        "ALL /routes/* (routes.controller.ts, class-level, any-of recurring_routes/order_delivery)",
        "ALL /route-runs/* (routes.controller.ts, class-level, any-of recurring_routes/order_delivery)",
        "ALL /trips/* (class-level, any-of order_delivery)",
        "PATCH /trips/routes/:routeId/planning (any-of recurring_routes/order_delivery)",
        "ALL /drivers/* (class-level, any-of recurring_routes/order_delivery)",
      ],
      grantPath:
        "Platform Admin internal switch (never named in tenant-facing text — see INTERNAL_ADDON_KEYS).",
      backfill: "Internal flag; no change.",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },

  // ── One hand-written-guard row (not a decorator).
  {
    key: "driver_payments",
    kind: "boolean",
    area: "routes",
    label: "At-door payment collection",
    description: "Lets a driver collect and record a payment at the delivery stop.",
    gate: {
      via: "guard",
      state: "enforced",
      added: "2026-08-24",
      routes: ["POST /route-runs/:id/stops/:stopId/complete-with-payment"],
      grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "driver_payments")',
      backfill:
        "Live before the registry existed; per-tenant opt-in for at-door payment collection " +
        "(owner decision 2026-08-24); no change.",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
    requires: { anyOf: ["recurring_routes", "order_delivery"] },
  },

  // ── Nine RequirePlanFlag rows — key IS the dotted legacy catalog-flag string.
  {
    key: "flag.msrp",
    kind: "boolean",
    area: "catalog",
    label: "MSRP pricing",
    description: "Manufacturer-suggested retail price fields on products and bulk edit.",
    gate: {
      via: "RequirePlanFlag",
      state: "enforced",
      added: "2026-08-22",
      routes: ["POST /products/msrp/bulk"],
      grantPath: ENFORCED_PLAN_FLAG_GRANT_PATH,
      backfill:
        "Live before the PLAN_FLAG_ENFORCEMENT switch existed; enforces regardless of the env var.",
    },
    billing: { skus: ["MSRP"], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.sales_agents",
    kind: "boolean",
    area: "sales",
    label: "Sales agents & commissions",
    description: "Sales-agent assignment, commission rules, and commission statements.",
    gate: {
      via: "RequirePlanFlag",
      state: "enforced",
      added: "2026-08-23",
      routes: ["ALL /sales-agents/* (class-level)", "ALL /commission-statements/* (class-level)"],
      grantPath: ENFORCED_PLAN_FLAG_GRANT_PATH,
      backfill:
        "Live before the PLAN_FLAG_ENFORCEMENT switch existed; enforces regardless of the env var.",
    },
    billing: { skus: ["SALES_AGENTS"], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.analytics",
    kind: "boolean",
    area: "sales",
    label: "Analytics dashboard",
    description: "Revenue, product, customer, and route performance analytics.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: ["ALL /analytics/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: ["FORECASTING"], selfService: true },
    defaultGranted: false,
  },
  {
    key: "flag.forecasting",
    kind: "boolean",
    area: "finance",
    label: "Inventory forecasting",
    description: "Reorder-point forecasting and reorder-settings tuning per product.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: [
        "GET /inventory/forecasting",
        "PATCH /inventory/products/:productId/reorder-settings",
      ],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: ["FORECASTING"], selfService: true },
    defaultGranted: false,
  },
  {
    key: "flag.reports",
    kind: "boolean",
    area: "finance",
    label: "Bookkeeping reports",
    description: "The extended bookkeeping report suite (P&L, aging, sales, and more).",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: [
        "GET /bookkeeping/reports/* (18 handlers: pl, aging, cashflow, ar-aging-invoices, " +
          "sales-by-customer, sales-by-item, customer-balance, invoice-details, bad-debts, " +
          "payments-received, time-to-get-paid, expense-details, expenses-by-category, " +
          "expenses-by-customer, sales-by-driver, ar-aging-details, estimate-details, refund-history)",
      ],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.returns",
    kind: "boolean",
    area: "sales",
    label: "Returns",
    description: "Customer and driver return intake, approval, and credit-note flow.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: ["ALL /returns/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.ap_bills",
    kind: "boolean",
    area: "finance",
    label: "AP bills",
    description: "Vendor bill capture, approval, and accounts-payable tracking.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: ["ALL /vendor-bills/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.pricing_tiers",
    kind: "boolean",
    area: "sales",
    label: "Customer pricing tiers",
    description: "Per-customer negotiated prices, overriding the catalog price.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: [
        "GET /customers/:id/prices",
        "POST /customers/:id/prices",
        "DELETE /customers/:id/prices/:priceId",
      ],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.import_integrations",
    kind: "boolean",
    area: "integrations",
    label: "Migration import integrations",
    description: "Bulk migration import from a prior system into RouteFlow.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: ["ALL /import/migration/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },

  // ── One service-gated row (not a decorator; gate.via is deliberately "service", not
  // "RequirePlanFlag" — it is excluded from the @RequirePlanFlag call-site scan and from the
  // DARK_PLAN_FLAGS parity check on purpose).
  {
    key: "flag.credit_limits",
    kind: "boolean",
    area: "finance",
    label: "Customer credit limits",
    description: "Blocks an order edit that would push a customer over their credit limit.",
    gate: {
      via: "service",
      // "closed" — matches the actual code: on an entitlement-resolution throw,
      // orders.service.ts's isCreditLimitCheckEnabled() returns true and the credit check
      // still runs (an over-limit edit is still blocked). Never "open": that would read as
      // "skip the check on error", which is the opposite of what ships today.
      state: "dark",
      envSwitched: true,
      failMode: "closed",
      added: "2026-08-23",
      reviewBy: "2027-01-31",
      routes: ["orders.service.ts assertWithinCreditLimit (internal check, not a route)"],
      grantPath:
        "Plan-bundled (GROWTH+) — granted by a plan's featureFlags; no separate admin grant surface",
      backfill:
        "2026-08-23 rollout: same PLAN_FLAG_ENFORCEMENT switch as PlanFlagGuard, legacy behavior " +
        "(switch off) runs the check; reviewBy proposed 2027-01-31 (owner ruling 2026-09-15).",
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },

  // ── Four frozen catalog-only rows — no server-side gate exists for any of these.
  {
    key: "addon.buyer_portal",
    kind: "boolean",
    area: "sales",
    label: "Buyer portal",
    description: "Self-serve ordering portal for a tenant's own customers.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-08-21",
      routes: [],
      grantPath: CATALOG_ONLY_GRANT_PATH,
      backfill: CATALOG_ONLY_BACKFILL,
    },
    billing: { skus: ["BUYER_PORTAL"], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.dispatch_live",
    kind: "boolean",
    area: "routes",
    label: "Live dispatch",
    description:
      "Real-time dispatch board — catalog metadata only; UI-gated by developer_mode today.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-08-21",
      routes: [],
      grantPath: CATALOG_ONLY_GRANT_PATH,
      backfill: CATALOG_ONLY_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.settlement",
    kind: "boolean",
    area: "finance",
    label: "Driver run settlement",
    description: "Per-run driver cash/settlement reconciliation — no implementation exists yet.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-08-21",
      routes: [],
      grantPath: CATALOG_ONLY_GRANT_PATH,
      backfill: CATALOG_ONLY_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.api_sso",
    kind: "boolean",
    area: "integrations",
    label: "API / SSO access",
    description: "Single sign-on and API-key access for the tenant — no implementation exists yet.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-08-21",
      routes: [],
      grantPath: CATALOG_ONLY_GRANT_PATH,
      backfill: CATALOG_ONLY_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },

  // ── Seven brand-new rows — pure data, no consumer yet.
  {
    key: "limit_seats",
    kind: "limit",
    area: "platform",
    label: "Seat limit",
    description:
      "The number of user seats a tenant's plan includes before an extra pack is needed.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: ["SEAT_EXTRA"], selfService: false },
    defaultGranted: false,
  },
  {
    key: "limit_routes",
    kind: "limit",
    area: "platform",
    label: "Route limit",
    description:
      "The number of active routes a tenant's plan includes before an extra pack is needed.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: ["ROUTE_EXTRA"], selfService: false },
    defaultGranted: false,
  },
  {
    key: "limit_customers",
    kind: "limit",
    area: "platform",
    label: "Customer limit",
    description: "The number of customers a tenant's plan includes before an extra pack is needed.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: ["CUSTOMER_PACK_100"], selfService: true },
    defaultGranted: false,
  },
  {
    key: "metered_scans",
    kind: "metered",
    area: "platform",
    label: "Scan meter",
    description: "Monthly OCR scan usage counted against a tenant's plan allowance.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
    meter: "SCANS",
  },
  {
    key: "metered_msgs",
    kind: "metered",
    area: "platform",
    label: "Message meter",
    description: "Monthly outbound message usage counted against a tenant's plan allowance.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: ["MSG_BUNDLE_500"], selfService: false },
    defaultGranted: false,
    meter: "MSGS",
  },
  {
    key: "catalog_varieties",
    kind: "boolean",
    area: "catalog",
    label: "Product varieties",
    description: "How a product's variety/flavor options are captured on an order line.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: true,
    config: {
      fallbackMode: "unset",
      modes: {
        unset: { label: "Not configured (today's behavior)", available: true, settings: [] },
        child_skus: {
          label: "Child SKUs",
          available: true,
          settings: [
            {
              type: "boolean",
              key: "autoSuffix",
              label: "Auto-suffix new variant SKUs",
              default: true,
            },
            {
              type: "boolean",
              key: "alsoLineNotes",
              label: "Also show a line note field",
              default: false,
            },
          ],
        },
        line_notes: {
          label: "Line notes",
          available: true,
          settings: [
            {
              type: "boolean",
              key: "required",
              label: "Require a note on every line",
              default: false,
            },
            {
              type: "string",
              key: "label",
              label: "Field label",
              maxLength: 24,
              default: "Flavor",
            },
          ],
        },
        single_sku: { label: "Single SKU", available: false, settings: [] },
      },
    },
  },
  {
    key: "routes_dispatch",
    kind: "boolean",
    area: "routes",
    label: "Dispatch run kind",
    description: "Whether a tenant's routes run on a schedule, ad hoc, or a mix of both.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-15",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: true,
    config: {
      fallbackMode: "unset",
      modes: {
        unset: { label: "Not configured (today's behavior)", available: true, settings: [] },
        scheduled: {
          label: "Scheduled",
          available: true,
          requires: { allOf: ["recurring_routes"] },
          settings: [],
        },
        adhoc: {
          label: "Ad hoc",
          available: true,
          requires: { allOf: ["order_delivery"] },
          settings: [],
        },
        mixed: {
          label: "Mixed",
          available: true,
          requires: { allOf: ["recurring_routes", "order_delivery"] },
          settings: [
            {
              type: "enum",
              key: "defaultKind",
              label: "Default run kind",
              options: ["scheduled", "adhoc"],
              default: "scheduled",
            },
          ],
        },
      },
    },
  },
];

// ── Derived: byte-identical projection of today's ADDON_GATE_REGISTRY. ─────────────────────────

export type AddonGateState = "dark" | "enforced";

export interface AddonGateEntry {
  /** `dark` = allow + warn; `enforced` = deny. */
  state: AddonGateState;
  /** YYYY-MM-DD the gate first shipped (git history, not memory). */
  added: string;
  /** Informational: the routes that carry this key today (`METHOD /path`). */
  routes: readonly string[];
  /** The UI or script that writes THIS exact `TenantAddon.addonKey` — a gate nothing can grant is an outage. */
  grantPath: string;
  /** The deploy-day decision for tenants that already use the feature, in writing. */
  backfill: string;
  /** `dark` rows only — YYYY-MM-DD by which the row must be flipped to `enforced` or this date extended. */
  reviewBy?: string;
}

/**
 * The ONE place every `@RequireAddon(key)` key's rollout state is declared — derived from
 * `FEATURE_REGISTRY`'s `RequireAddon` rows so it can never drift from the bigger registry.
 * `AddonGuard` reads `state`:
 *   - `dark`     → allow the request and log ONE warn ("addon gate would deny (dark) …") so the
 *                  blast radius is readable in the API logs before anyone is denied;
 *   - `enforced` → deny with 403 `{ code: "ADDON_GATE", addonKeys, message }`.
 * A NEW gate is added as `dark`. Flipping a row to `enforced` is a separate, reviewed diff, made
 * only after the owner has run the read-only blast-radius report against production
 * (`railway run --service postgres node apps/api/scripts/report-addon-gate-blast-radius.mjs --addon <key>`)
 * and either it lists zero live tenants or the grants it lists have been applied in Platform Admin.
 * Unregistered keys are treated as `enforced` at runtime — never looser than today; the spec is
 * what makes shipping an unregistered key impossible.
 *
 * Why this exists: PR #475 (2026-08-29) added `@RequireAddon("ocr")` to four routes with no grant
 * for the tenants already using them; every one of them was denied for five days before a client
 * reported it.
 */
export const ADDON_GATE_REGISTRY: Readonly<Record<string, AddonGateEntry>> = Object.fromEntries(
  FEATURE_REGISTRY.filter((f) => f.gate.via === "RequireAddon").map((f) => [
    f.key,
    {
      state: f.gate.state === "dark" ? "dark" : "enforced",
      added: f.gate.added,
      // Copied, not aliased — a future caller mutating this array must never corrupt the
      // FEATURE_REGISTRY row it was derived from.
      routes: [...f.gate.routes],
      grantPath: f.gate.grantPath,
      backfill: f.gate.backfill,
      ...(f.gate.reviewBy !== undefined ? { reviewBy: f.gate.reviewBy } : {}),
    },
  ]),
);

/** Runtime state for a key; unregistered keys enforce (the spec keeps them from ever shipping). */
export function addonGateState(key: string): AddonGateState {
  return ADDON_GATE_REGISTRY[key]?.state ?? "enforced";
}
