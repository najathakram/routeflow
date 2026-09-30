import type { FeatureRegistryRow } from "../types";

// 3 areas × 2 keys = 6 rows. One key (`route_optimization`) carries `config` (mode selector);
// one key (`developer_mode`) is `internal: true` (hidden behind the "show internal" toggle).
// Mirrors real registry-row shapes from apps/web/e2e/48-feature-overrides.spec.ts's
// REGISTRY_FIXTURE, extended with area/lifecycle/gate/billing/config per brief A's contract.
export const REGISTRY_FIXTURE: FeatureRegistryRow[] = [
  {
    key: "tobacco_dealer",
    kind: "boolean",
    area: "compliance",
    label: "Regulated items (tobacco)",
    description: "License-column ledgers, monthly tobacco reports, regulated filings.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequireAddon", state: "enforced" },
    billing: { skus: ["tobacco_dealer"] },
  },
  {
    key: "msrp",
    kind: "boolean",
    area: "compliance",
    label: "MSRP on invoices",
    description: "Suggested retail price (per piece) on products, customers, and invoices.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "service", state: "enforced" },
    billing: { skus: ["msrp"] },
  },
  {
    key: "recurring_routes",
    kind: "boolean",
    area: "routes",
    label: "Recurring routes",
    description: "Standing route templates and scheduled dispatch.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "RequireAddon", state: "enforced" },
    billing: { skus: ["recurring_routes"] },
  },
  {
    key: "route_optimization",
    kind: "boolean",
    area: "routes",
    label: "Route optimization mode",
    description: "How dispatch chooses stop order for this tenant's routes.",
    lifecycle: "beta",
    internal: false,
    gate: { via: "RequirePlanFlag", state: "dark" },
    billing: { skus: [] },
    config: {
      fallbackMode: "manual",
      modes: [
        { key: "manual", label: "Manual dispatch", lifecycle: "ga" },
        {
          key: "scheduled",
          label: "Scheduled dispatch",
          lifecycle: "beta",
          requires: ["route_scheduling_addon"],
        },
        { key: "mixed", label: "Both", lifecycle: "ga" },
      ],
    },
  },
  {
    key: "developer_mode",
    kind: "boolean",
    area: "platform",
    label: "Developer mode",
    description: "Unlocks in-development surfaces (mobile driver-app preview, dispatch API).",
    lifecycle: "beta",
    internal: true,
    gate: { via: "RequireAddon", state: "dark" },
    billing: { skus: [] },
  },
  {
    key: "boxes_pieces_mode",
    kind: "boolean",
    area: "platform",
    label: "Boxes & pieces display",
    description: "Whether order/invoice line quantities show boxes, pieces, or both.",
    lifecycle: "ga",
    internal: false,
    gate: { via: "guard", state: "enforced" },
    billing: { skus: [] },
  },
];
