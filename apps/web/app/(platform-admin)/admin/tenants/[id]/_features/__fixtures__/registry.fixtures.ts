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

/** A free configuration row: no plan flag or add-on gates it (`gate.via: "none"`), so an
 *  override on it would do nothing. Kept out of REGISTRY_FIXTURE so its row counts stay put. */
export const FULFILMENT_MODEL_ROW: FeatureRegistryRow = {
  key: "fulfilment_model",
  kind: "boolean",
  area: "routes",
  label: "Where orders go",
  description: "Whether orders go out on delivery runs, ship by carrier, or both.",
  lifecycle: "ga",
  internal: false,
  gate: { via: "none", state: "none" },
  billing: { skus: [] },
  config: {
    fallbackMode: "unset",
    modes: [
      { key: "unset", label: "Not configured (today's behavior)", lifecycle: "ga" },
      { key: "delivery", label: "Own delivery", lifecycle: "ga" },
      { key: "ship", label: "Ship by carrier", lifecycle: "ga" },
    ],
  },
};

/** A plain on/off row nothing checks yet (`gate.via: "none"`, no `config`). */
export const UNCHECKED_SETTING_ROW: FeatureRegistryRow = {
  key: "unchecked_setting",
  kind: "boolean",
  area: "platform",
  label: "Unchecked setting",
  description: "A setting no route or screen reads yet.",
  lifecycle: "proposed",
  internal: false,
  gate: { via: "none", state: "none" },
  billing: { skus: [] },
};
