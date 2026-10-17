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

// Feature grants v2 brief C: `import type` only — never a value import — @routeflow/types'
// entry point is raw TS with no build step; a value import would crash `node dist/main.js`
// (see no-runtime-workspace-imports.spec.ts). FeatureLifecycle is brief A's shared contract type.
import type { FeatureLifecycle } from "@routeflow/types";

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
  /**
   * Feature grants v2 brief C: optional so PR-5b's `catalog_varieties` (not built yet) and any
   * other pre-existing config mode compile unchanged without one. `routes_dispatch`'s four modes
   * below are the first to carry it, all `"ga"` — no `"beta"`/`"proposed"` value ships here.
   */
  lifecycle?: FeatureLifecycle;
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
  config?: { fallbackMode: "unset" | "off"; modes: Record<string, FeatureConfigMode> };
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
        "GET /regulated/parked-reversals",
        "POST /regulated/parked-reversals/:id/resolve",
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
  // The SEND path (MailboxSendService.trySend) is gated on this key too, though it is not an HTTP
  // route and so is not in `routes`: it shares the guard's decision (addon-access.ts) — dark = send
  // + would-deny warning, enforced = `addon_required` (EmailService falls through to the next
  // transport). Covered by mailbox-send.addon-gate.spec.ts.
  {
    key: "email.connected_mailbox",
    kind: "boolean",
    area: "integrations",
    label: "Connected email mailbox",
    description:
      "Send tenant-branded mail through a connected Google or Microsoft mailbox (Gmail API / Graph).",
    gate: {
      via: "RequireAddon",
      state: "dark",
      added: "2026-09-17",
      routes: [
        "GET /settings/email/mailbox",
        "GET /settings/email/mailbox/google/start",
        "GET /settings/email/mailbox/microsoft/start",
        "GET /settings/email/mailbox/confirm/:token/preview",
        "POST /settings/email/mailbox/confirm",
        "POST /settings/email/mailbox/confirm/cancel",
        "DELETE /settings/email/mailbox",
      ],
      grantPath:
        'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "email.connected_mailbox")',
      backfill:
        "New feature 2026-09-17: no tenant has a connection; gate stays dark through the pilot " +
        "(owner review window for Google gmail.send verification — see local-assets/handoff/" +
        "2026-09-17/email-connect/design.md §5).",
      reviewBy: "2027-03-17",
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
  {
    key: "orders_inline_returns",
    kind: "boolean",
    area: "sales",
    label: "Returns at order entry",
    description:
      "Staff/drivers can capture a return and credit it in the same flow as recording a new order.",
    gate: {
      via: "RequireAddon",
      // Owner-answers.md Q-A (2026-09-15, second round): "Enforced from day one — an
      // owner exception to 'new gates ship dark' (zero existing users, so the blast
      // radius is empty by construction)." The registry's dark-first rule exists to
      // protect tenants ALREADY using an unguarded surface from a surprise denial;
      // there is no existing call site or tenant grant for this key, so that risk
      // does not exist here — the owner's written exception is satisfied by
      // construction, not waived.
      state: "enforced",
      added: "2026-09-16",
      routes: [
        "POST /returns/inline/quote",
        "POST /orders/:id/inline-returns (PR-1d)",
        "POST /returns/inline/:id/* (PR-1c/1d)",
      ],
      grantPath:
        "Default-granted to every tenant whose plan carries flag.returns (owner ruling " +
        '2026-09-28); remove per tenant with a DENY override (addonKey "orders_inline_returns")',
      backfill:
        'New feature 2026-09-16; zero existing users. Owner ruling 2026-09-28 ("On for ' +
        'everyone"): defaultGranted, so no TenantAddon row is needed and none is backfilled — ' +
        "isDefaultGrantedAddon() grants it at runtime; flag.returns still gates it (requires).",
    },
    billing: { skus: [], selfService: false },
    // Owner ruling 2026-09-28: "On for everyone". Honoured at runtime by
    // isDefaultGrantedAddon() (AddonService → AddonGuard, /tenants/me/addons, hasAddon), not just
    // the explain/preview resolver; `requires` below still gates it, and a DENY override removes it.
    defaultGranted: true,
    requires: { allOf: ["flag.returns"] },
    config: {
      fallbackMode: "unset",
      modes: {
        unset: { label: "Not configured (feature ungranted)", available: true, settings: [] },
        standard: {
          label: "Standard",
          available: true,
          settings: [
            {
              type: "enum",
              key: "priceSource",
              label: "Price source when unmatched",
              options: ["last_invoice_then_offered", "offered_only"],
              default: "last_invoice_then_offered",
            },
            {
              type: "string",
              key: "soldWindowDays",
              label: "Sold window (days)",
              default: "90",
            },
            {
              type: "enum",
              key: "overReturnPolicy",
              label: "Staff over-return policy",
              options: ["warn", "hold", "block"],
              default: "warn",
            },
            {
              type: "enum",
              key: "driverOverReturnPolicy",
              label: "Driver over-return policy",
              options: ["warn", "block"],
              default: "warn",
            },
            {
              type: "string",
              key: "driverCreditCap",
              label: "Driver credit cap (0 = order gross)",
              default: "0",
            },
            {
              type: "boolean",
              key: "reasonRequired",
              label: "Require a reason",
              default: true,
            },
            {
              type: "enum",
              key: "photoRequired",
              label: "Photo evidence required",
              options: ["never", "damaged", "always"],
              default: "damaged",
            },
          ],
        },
      },
    },
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
    key: "flag.units_v1",
    kind: "boolean",
    area: "catalog",
    label: "Multi-level units",
    description:
      "Sell a product by Case/Pallet/Piece levels with their own prices; per-line unit picker.",
    gate: {
      via: "RequirePlanFlag",
      // Brand-new key nobody uses, so it ships ENFORCED-BUT-UNGRANTED (invisible until an
      // owner override GRANT), not `dark` — a dark flag is courtesy-allowed to every tenant.
      state: "enforced",
      added: "2026-09-19",
      routes: ["ALL /products/:productId/units (class-level)"],
      grantPath: "Owner override GRANT per tenant (feature grants) — no plan bundles it yet",
      backfill: "New key: no tenant has used it, so there is nothing to backfill.",
    },
    billing: { skus: [], selfService: false },
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
    key: "flag.units_prices_v2",
    kind: "boolean",
    area: "catalog",
    label: "Units and prices v2",
    description: "The one price grid per product: every unit, every tier, Set or Auto.",
    gate: {
      via: "RequirePlanFlag",
      // SA-796 R-5: a stated exception to the DARK_PLAN_FLAGS rule. The key gates a NEW route and
      // UI with zero prior users (blast radius 0), and "dark" would allow it for every tenant, so
      // it ships ENFORCED-BUT-UNGRANTED like flag.units_v1.
      state: "enforced",
      added: "2026-10-16",
      routes: [
        "GET /products/:productId/price-grid (product-pricing.controller.ts, class-level)",
        "GET /products/:productId/customer-prices (product-pricing.controller.ts, class-level)",
        "POST /products/:productId/prices (product-pricing.controller.ts, class-level)",
        "POST /products/:productId/prices/undo (product-pricing.controller.ts, class-level)",
        "GET /customers/:customerId/unit-prices (customer-unit-prices.controller.ts, class-level)",
        "products.service.ts create and importFromZoho, product-families.service.ts createFamily and updateVariants (hasFlag, S4)",
      ],
      grantPath:
        "Owner override GRANT per tenant after the 95/95 live check (S28); the local test tenant for proofs",
      backfill: "New key: no tenant has used it, so there is nothing to backfill.",
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

  // ── Six rows added by the Lite plan (Lite-L2, 2026-09-15): five brand-new class-level
  // RequirePlanFlag controllers, plus addon.buyer_portal's gate.via flipped from "none" to
  // "RequirePlanFlag" now that customers.controller.ts's portal endpoints actually enforce it
  // (see the "frozen catalog-only rows" block below, now three rows instead of four).
  {
    key: "flag.estimates",
    kind: "boolean",
    area: "sales",
    label: "Estimates",
    description: "Quote customers and convert accepted estimates to orders/invoices.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: ["ALL /estimates/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.recurring_invoices",
    kind: "boolean",
    area: "finance",
    label: "Recurring invoices",
    description: "Scheduled, auto-generated recurring invoices on a customer cadence.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: ["ALL /recurring-invoices/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.credit_notes",
    kind: "boolean",
    area: "finance",
    label: "Credit notes",
    description: "Issue and apply credit notes against invoices.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: ["ALL /credit-notes/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.suppliers",
    kind: "boolean",
    area: "finance",
    label: "Suppliers",
    description: "Supplier/vendor directory feeding purchasing and AP bills.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: ["ALL /suppliers/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "flag.messaging",
    kind: "boolean",
    area: "platform",
    label: "Messaging",
    description: "In-app customer/driver messaging threads.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: ["ALL /messages/* (class-level)"],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
  },
  {
    key: "addon.buyer_portal",
    kind: "boolean",
    area: "sales",
    label: "Buyer portal",
    description: "Self-serve ordering portal for a tenant's own customers.",
    gate: {
      via: "RequirePlanFlag",
      state: "dark",
      envSwitched: true,
      added: "2026-09-15",
      reviewBy: "2027-01-31",
      routes: [
        "GET /customers/pending-portal-approvals",
        "POST /customers/:id/portal-invite",
        "POST /customers/:id/portal-resend",
        "POST /customers/:id/portal-disconnect",
        "GET /customers/:id/portal-status",
        "POST /customers/:id/portal-approve",
        "POST /customers/:id/portal-decline",
      ],
      grantPath: DARK_PLAN_FLAG_GRANT_PATH,
      backfill: DARK_PLAN_FLAG_BACKFILL,
    },
    billing: { skus: ["BUYER_PORTAL"], selfService: false },
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

  // ── Three frozen catalog-only rows — no server-side gate exists for any of these.
  // (addon.buyer_portal moved above: Lite-L2 gave it a real RequirePlanFlag gate.)
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
    key: "mixed_packs",
    kind: "boolean",
    area: "catalog",
    label: "Mixed packs",
    description:
      "Family price authority and fixed recipes: a family owns its variants' prices, and a recipe sells a fixed mix of them as one product.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-09-29",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: false,
    // #2717 M2 (SA-574 Q5): the mode is read only, never a setting. `on` turns family price
    // write-through and the recipe routes on for the tenant; the owner flips it per tenant.
    config: {
      fallbackMode: "off",
      modes: {
        off: { label: "Off (today's behavior)", available: true, settings: [] },
        on: { label: "On", available: true, settings: [] },
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
    // Feature grants v2 brief C (2-block diff, block 2 of 2): every mode gets `lifecycle: "ga"`
    // (all four shipped GA on 2026-09-15, not new/beta) and `mixed`'s label reads "Both" per
    // design 2026-09-17 §2 — `requires.allOf` is unchanged from PR-1. Only AND-groups (`allOf`)
    // are used anywhere here; there is deliberately no `anyOf` on a config mode (XOR-select-one
    // semantics: exactly one mode value is ever active per tenant per feature, enforced by
    // TenantFeatureConfig's `@@unique([tenantId, featureKey])`, not an OR of requirements).
    config: {
      fallbackMode: "unset",
      modes: {
        unset: {
          label: "Not configured (today's behavior)",
          available: true,
          lifecycle: "ga",
          settings: [],
        },
        scheduled: {
          label: "Scheduled",
          available: true,
          lifecycle: "ga",
          requires: { allOf: ["recurring_routes"] },
          settings: [],
        },
        adhoc: {
          label: "Ad hoc",
          available: true,
          lifecycle: "ga",
          requires: { allOf: ["order_delivery"] },
          settings: [],
        },
        mixed: {
          label: "Both",
          available: true,
          lifecycle: "ga",
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
  {
    key: "fulfilment_model",
    kind: "boolean",
    area: "routes",
    label: "Where orders go",
    description:
      "Whether a tenant's orders go out on its own delivery runs, ship by carrier, or both. Unset keeps today's behavior exactly.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-10-04",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: true,
    // Business profiles 1A: a free configuration row (never gates a paid feature). `unset` is
    // today, for every existing tenant. `delivery` and `both` need a fleet key (FeatureConfigService.set refuses them
    // otherwise; the registry's mode schema stays allOf-only); the ship and in-store modes need none.
    config: {
      fallbackMode: "unset",
      modes: {
        unset: {
          label: "Not configured (today's behavior)",
          available: true,
          lifecycle: "ga",
          settings: [],
        },
        delivery: {
          label: "Own delivery",
          available: true,
          lifecycle: "ga",
          settings: [],
        },
        ship: { label: "Ship by carrier", available: true, lifecycle: "ga", settings: [] },
        both: {
          label: "Both",
          available: true,
          lifecycle: "ga",
          settings: [],
        },
        // SA-671 M1 lifted (pickup mode API): PICKUP orders can be written (counter sale, order-ahead
        // pickup), so a tenant may now be SET to an in-store mode. A STORED mode that the registry
        // marks UNAVAILABLE would derive as unset (deriveFulfilmentCapability, SA-666a/b).
        pickup: { label: "In store only", available: true, lifecycle: "proposed", settings: [] },
        pickup_ship: {
          label: "In store + shipping",
          available: true,
          lifecycle: "proposed",
          settings: [],
        },
      },
    },
  },
  {
    key: "counter_sales",
    kind: "boolean",
    area: "routes",
    label: "Counter sales",
    description:
      "Lets a business that is not in-store sell over the counter too. In-store modes always have the counter; unset keeps today's behavior.",
    gate: {
      via: "none",
      state: "none",
      added: "2026-10-04",
      routes: [],
      grantPath: NEW_ROW_GRANT_PATH,
      backfill: NEW_ROW_BACKFILL,
    },
    billing: { skus: [], selfService: false },
    defaultGranted: true,
    // Business profiles 1A: a free configuration row; clients read `capabilities.fulfilment.counter`
    // only, never this value.
    config: {
      fallbackMode: "unset",
      modes: {
        unset: {
          label: "Not configured (today's behavior)",
          available: true,
          lifecycle: "ga",
          settings: [],
        },
        on: { label: "On", available: true, lifecycle: "ga", settings: [] },
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

const REGISTERED_FEATURE_KEYS = new Set(FEATURE_REGISTRY.map((f) => f.key));
const GATE_VIA_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f.gate.via]));

/** True when `key` names a row in FEATURE_REGISTRY (any gate kind) — feature-grant overrides
 * may target any registered key, not only RequireAddon/RequirePlanFlag ones. */
export function isRegisteredFeatureKey(key: string): boolean {
  return REGISTERED_FEATURE_KEYS.has(key);
}

/**
 * `key`'s gate.via, or undefined when unregistered. Feature-grants PR-1: a key's override
 * only belongs in a given "list of held X" response when its gate.via matches that list's
 * kind — an addon-keyed override belongs in an addons array, a plan-flag-keyed override in a
 * flags array; mixing them in would surface a key a consumer never checks.
 */
export function gateVia(key: string): FeatureGateVia | undefined {
  return GATE_VIA_BY_KEY.get(key);
}

/**
 * B524 fix round (Opus review of PR #913, finding F2): `TenantAddon.addonKey` (what
 * `AddonService.enableAddon` receives) and `FeatureDef.key` (what the registry indexes
 * `requires` by) are the SAME string for a bare `RequireAddon` row (`driver_payments`,
 * `tobacco_dealer`, `ocr`, …) but DIVERGE for the two `LEGACY_ADDON_KEY_TO_SKU`-bridged legacy
 * keys that map to a `RequirePlanFlag` row instead: addonKey `"msrp"` is registry key
 * `"flag.msrp"`, addonKey `"sales_agents"` is `"flag.sales_agents"`. Looking `addonKey` up
 * directly in `FEATURE_REGISTRY` (what the pre-fix code did) silently found nothing for those
 * two and skipped the requires check outright — harmless today only because neither bridged
 * row currently declares `requires`, not because the lookup was correct. This is the exact
 * inverse of the web app's own `ADDON_ROW_KEY_BY_REGISTRY_KEY` (`FeatureConsole.tsx`, #899) —
 * hand-kept in sync with it the same way `checkFeatureRequires` is kept in sync with its web
 * twin, for the same reason (no shared module reaches both apps).
 */
export const ADDON_KEY_TO_REGISTRY_KEY: Readonly<Record<string, string>> = {
  tobacco_dealer: "tobacco_dealer",
  driver_payments: "driver_payments",
  recurring_routes: "recurring_routes",
  order_delivery: "order_delivery",
  ocr: "ocr",
  developer_mode: "developer_mode",
  msrp: "flag.msrp",
  sales_agents: "flag.sales_agents",
};

const FEATURE_DEF_BY_KEY = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));

/** `key`'s full FeatureDef, or undefined when unregistered. */
export function featureDefByKey(key: string): FeatureDef | undefined {
  return FEATURE_DEF_BY_KEY.get(key);
}

export interface FeatureRequirementStatus {
  satisfied: boolean;
  missingAllOf: string[];
  unmetAnyOf: string[] | null;
}

/**
 * B524: the server-side twin of `checkRequires` in
 * `apps/web/app/(platform-admin)/admin/tenants/[id]/_features/FeatureConsole.tsx` (#899) —
 * SAME semantics, deliberately, including the empty-`requires.anyOf: []`-is-satisfied quirk
 * (`anyOf.length === 0` short-circuits `anyOfSatisfied` to true, same as the web copy). This
 * is a hand-kept parallel implementation, not a shared module: the web app has no build step
 * that reaches server TS, so a real shared import isn't available. `feature-registry.spec.ts`
 * closes the quirk from the other end instead of leaving the two copies to agree on it by
 * accident — it rejects any registry row whose `requires.anyOf` is `[]` outright, so the
 * ambiguous input can never actually reach either copy of this function.
 */
export function checkFeatureRequires(
  requires: FeatureDef["requires"],
  effectiveKeys: ReadonlySet<string>,
): FeatureRequirementStatus {
  const missingAllOf = (requires?.allOf ?? []).filter((k) => !effectiveKeys.has(k));
  const anyOf = requires?.anyOf;
  const anyOfSatisfied = !anyOf || anyOf.length === 0 || anyOf.some((k) => effectiveKeys.has(k));
  return {
    satisfied: missingAllOf.length === 0 && anyOfSatisfied,
    missingAllOf,
    unmetAnyOf: anyOfSatisfied ? null : [...anyOf],
  };
}

/**
 * Owner ruling 2026-09-28 ("On for everyone") / SA-540: the ONE rule for an add-on-keyed feature
 * (`gate.via` "RequireAddon" | "guard") that a tenant holds WITHOUT a TenantAddon row:
 *
 *   effective(addon) = (preset ∪ registry defaultGranted ∪ explicit grants) − explicit denies,
 *   AND its `requires` are met — a SEPARATE conjunct that an add-on default never satisfies.
 *
 * This function is the default term plus the `requires` conjunct: true when the row is
 * `defaultGranted: true` and its `requires` hold against the tenant's REQUIREMENT set,
 * `(rowKeys ∪ entFlags ∪ GRANT overrides) − DENY overrides` (ent.flags = plan flags plus add-on
 * granted flags; overrides applied exactly as PlanFlagGuard/hasFlag apply them, strictly, with no
 * dark courtesy). Default-granted keys are never in that set, so a default cannot satisfy another
 * key's `requires`. A DENY override on the feature key itself is the caller's job (AddonService,
 * AddonGuard, /tenants/me/addons, the old path and the resolver all check it first).
 *
 * Every runtime and report path that decides "does this tenant hold add-on X" calls THIS function
 * (AddonService.getActiveAddons/hasAddon, EntitlementAuthority's old paths, resolveOneKey); the
 * publish/blast-radius scripts' mirror (`scripts/lib/feature-registry-mirror.cjs`) keeps a JS twin,
 * pinned by `feature-registry-mirror.parity.spec.ts`. Never re-derive it inline. `defaultGranted`
 * on a flag-keyed row is unrelated; resolveOneKey reads that one directly.
 */
export function isDefaultGrantedAddon(
  feature: Pick<FeatureDef, "defaultGranted" | "requires"> & {
    gate: Pick<FeatureDef["gate"], "via">;
  },
  rowKeys: Iterable<string>,
  entFlags: Iterable<string>,
  overrides?: ReadonlyMap<string, "GRANT" | "DENY">,
): boolean {
  if (!feature.defaultGranted) return false;
  if (feature.gate.via !== "RequireAddon" && feature.gate.via !== "guard") return false;
  const effective = new Set<string>([...rowKeys, ...entFlags]);
  for (const [k, effect] of overrides ?? []) {
    if (effect === "GRANT") effective.add(k);
    else effective.delete(k);
  }
  return checkFeatureRequires(feature.requires, effective).satisfied;
}

/** Every key a default-granted add-on's `requires` names — the overrides that predicate needs. */
export function defaultGrantRequirementKeys(features: readonly FeatureDef[]): string[] {
  const keys = new Set<string>();
  for (const f of features)
    for (const k of [...(f.requires?.allOf ?? []), ...(f.requires?.anyOf ?? [])]) keys.add(k);
  return [...keys];
}

/** The add-on-keyed registry rows a tenant may hold with no row (see `isDefaultGrantedAddon`). */
export const DEFAULT_GRANTED_ADDON_FEATURES: readonly FeatureDef[] = FEATURE_REGISTRY.filter(
  (f) => f.defaultGranted && (f.gate.via === "RequireAddon" || f.gate.via === "guard"),
);

/** Human-readable phrase for what's unmet — mirrors `describeUnmetRequirement` in
 *  FeatureConsole.tsx, resolving registry keys to their `label`s. `undefined` when satisfied. */
export function describeUnmetFeatureRequirement(
  status: FeatureRequirementStatus,
): string | undefined {
  if (status.satisfied) return undefined;
  const label = (key: string) => featureDefByKey(key)?.label ?? key;
  const parts: string[] = [];
  if (status.missingAllOf.length > 0) parts.push(status.missingAllOf.map(label).join(" and "));
  if (status.unmetAnyOf) parts.push(status.unmetAnyOf.map(label).join(" or "));
  return parts.join(" and ");
}
