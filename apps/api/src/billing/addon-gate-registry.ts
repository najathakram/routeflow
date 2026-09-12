/**
 * Add-on gate registry — the ONE place every `@RequireAddon(key)` key is declared with its rollout state.
 *
 * `addon-gate-registry.spec.ts` fails `npm run verify` when a key used in a controller has no row here,
 * when a row has no live call site, when a `dark` row has passed its `reviewBy` date without a decision,
 * or when `ocr` is not `dark` (deploy-day decision 2026-09-04). `AddonGuard` reads `state`:
 *   - `dark`     → allow the request and log ONE warn ("addon gate would deny (dark) …") so the blast
 *                  radius is readable in the API logs before anyone is denied;
 *   - `enforced` → deny with 403 `{ code: "ADDON_GATE", addonKeys, message }`.
 * A NEW gate is added as `dark`. Flipping a row to `enforced` is a separate, reviewed diff, made only
 * after the owner has run the read-only blast-radius report against production
 * (`railway run --service postgres node apps/api/scripts/report-addon-gate-blast-radius.mjs --addon <key>`)
 * and either it lists zero live tenants or the grants it lists have been applied in Platform Admin.
 * Unregistered keys are treated as `enforced` at runtime — never looser than today; the spec is what makes
 * shipping an unregistered key impossible.
 *
 * Why this exists: PR #475 (2026-08-29) added `@RequireAddon("ocr")` to four routes with no grant for the
 * tenants already using them; every one of them was denied for five days before a client reported it.
 */
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

export const ADDON_GATE_REGISTRY: Readonly<Record<string, AddonGateEntry>> = {
  ocr: {
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
  tobacco_dealer: {
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
  recurring_routes: {
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
  order_delivery: {
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
  crm_gohighlevel: {
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
      "New feature 2026-09-11: no tenant has a connection; gate stays dark through the pilot; " +
      "flip after the blast-radius report",
    reviewBy: "2027-03-11",
  },
  developer_mode: {
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
};

/** Runtime state for a key; unregistered keys enforce (the spec keeps them from ever shipping). */
export function addonGateState(key: string): AddonGateState {
  return ADDON_GATE_REGISTRY[key]?.state ?? "enforced";
}
