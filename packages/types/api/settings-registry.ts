import { PREF } from "./preferences";

/**
 * Settings registry (WS5 / SA-602): every configurable setting, in ALL THREE homes, with the
 * screen that edits it. `validateSettingsRegistry` is the single rule set; the api spec
 * (every SystemConfig key a settings controller writes is registered) and the web spec (every
 * screen resolves to something the operator can open) both run it.
 *
 * Homes (SA-602, split by KIND):
 *  - `policy`       tenant BEHAVIOUR switches (policy store, #1337);
 *  - `systemConfig` tenant CONFIG DATA (SystemConfig); no new behaviour key may live here;
 *  - `userPref`     per-USER preferences (`users/me/preferences`);
 *  - `featureConfig` tenant BEHAVIOUR modes stored as `TenantFeatureConfig` rows (the feature
 *    registry's config blocks, e.g. `fulfilment_model`); the key IS the feature key.
 */
export type SettingHome = "policy" | "systemConfig" | "userPref" | "featureConfig";
export type SettingKind = "config" | "behaviour" | "preference" | "memo";
export type SettingStatus =
  | "live"
  | "legacy"
  | "pending #1337"
  | "moves to policy (PR-3)"
  | "pending WS4"
  | "pending SA-762r API";

export interface SettingRow {
  /** Exact key, or a prefix pattern ending in `*` (e.g. `margin.floor.category.*`). */
  key: string;
  home: SettingHome;
  kind: SettingKind;
  status: SettingStatus;
  /** A hub href (`/settings?tab=…`, `/settings/…`), an in-hub anchor (`#…`), or an off-hub screen. */
  screen?: string;
  /** Required instead of `screen` for rows whose surface is not built yet. */
  plannedSurface?: string;
  adminOnly?: boolean;
}

/**
 * SystemConfig BEHAVIOUR keys grandfathered from before SA-602. FROZEN: a spec pins the exact key
 * set, so "no new ones may join" is enforced, not a comment. Each carries why it is grandfathered
 * and where it moves (the policy registry, #1337, R1.3 keys).
 */
export const LEGACY_SYSTEM_CONFIG_BEHAVIOUR: Record<string, { reason: string; target: string }> = {
  "selling_restrictions.enabled": {
    reason:
      "Master on/off for selling restrictions; shipped as a SystemConfig switch before SA-602.",
    target: "policy key (R1.3) once #1337 lands; moved per key with a backfill, never in bulk",
  },
  "selling_restrictions.governing_address": {
    reason: "Billing-first vs shipping-first changes enforcement outcomes; written with .enabled.",
    target: "policy key (R1.3) moving together with selling_restrictions.enabled",
  },
  "invoice.depositCollectAtOrder": {
    reason: "Boolean tenant policy switch in SystemConfig since #465 (2026-08-27), before SA-602.",
    target: "policy key (R1.3) under the invoicing area",
  },
};

export const LEGACY_SYSTEM_CONFIG_BEHAVIOUR_KEYS = Object.keys(LEGACY_SYSTEM_CONFIG_BEHAVIOUR);

/** The only keys allowed to carry status "moves to policy (PR-3)" (the credit enforce flags). */
export const CREDIT_LIMIT_MOVING_KEYS = [
  "credit_limit.enforce_new_orders",
  "credit_limit.enforce_delivery",
] as const;

/** Screens that live outside the settings hub link list, each with why it is still a screen. */
export const OFF_HUB_SCREENS: Record<string, string> = {
  "/settings": "Pricing tier names card, rendered on the hub page itself",
  "/compliance/[categoryId]": "Tobacco analytics toggle in the compliance pack panel",
  "app:language-switcher": "Web language switcher (locale)",
  "mobile:settings": "Mobile operator settings (push notifications)",
  implicit: "Remembered last-used default; not a setting anyone edits",
  "/settings?tab=fulfilment#delivery-method":
    "Fulfillment tab, Delivery method card: reached by its ?tab= link, shown only when self-serve is on",
  "/settings?tab=fulfilment#counter-sales":
    "Fulfillment tab, Counter sales card: reached by its ?tab= link, shown only when self-serve is on",
};

const cfg = (key: string, screen: string, extra: Partial<SettingRow> = {}): SettingRow => ({
  key,
  home: "systemConfig",
  kind: "config",
  status: "live",
  screen,
  ...extra,
});

export const SETTINGS_REGISTRY: SettingRow[] = [
  // ── systemConfig: settings controller writers ────────────────────────────────
  cfg("settings.taxRate", "/settings?tab=profile"),
  cfg("settings.logoUrl", "/settings?tab=profile"),
  // SA-762r: the Business profile "Receipt footer" field is built; PATCH /settings does not
  // persist `receiptFooter` until the API PR lands, so the row is honest about it.
  {
    key: "settings.receiptFooter",
    home: "systemConfig",
    kind: "config",
    status: "pending SA-762r API",
    plannedSurface: "Settings → Business profile → Receipt footer (API write lands with SA-762r)",
  },
  ...[
    "fromName",
    "fromEmail",
    "smtpHost",
    "smtpPort",
    "smtpUser",
    "smtpPassword",
    "smtpSecure",
  ].map((k) => cfg(`email.${k}`, "/settings?tab=email")),
  cfg("email.sendingDomain", "/settings?tab=email"),
  cfg("anthropic.apiKey", "/settings?tab=integrations"),
  ...[
    "serviceTimeMinutes",
    "defaultStartTime",
    "averageSpeedKmh",
    "defaultDepotLat",
    "defaultDepotLng",
  ].map((k) => cfg(`route.${k}`, "#route-defaults")),
  cfg("invoice.defaultTerms", "/settings?tab=invoicing"),
  cfg("invoice.hideOriginalPrice", "/settings?tab=invoicing"),
  cfg("invoice.depositDefaultPercent", "/settings?tab=invoicing"),
  {
    key: "invoice.depositCollectAtOrder",
    home: "systemConfig",
    kind: "behaviour",
    status: "legacy",
    screen: "/settings?tab=invoicing",
  },
  cfg("costing.method", "/settings?tab=costing"),
  cfg("margin.floor.default", "/settings?tab=costing"),
  cfg("margin.floor.category.*", "/settings?tab=costing"),
  cfg("remittance.config", "/settings?tab=remittance"),
  cfg("pricing.tierLabels", "/settings"),
  // ── systemConfig: other writers ──────────────────────────────────────────────
  cfg("tobacco.excludeFromMainAnalytics", "/compliance/[categoryId]", { adminOnly: true }),
  {
    key: "selling_restrictions.enabled",
    home: "systemConfig",
    kind: "behaviour",
    status: "legacy",
    screen: "/settings/restrictions",
    adminOnly: true,
  },
  {
    key: "selling_restrictions.governing_address",
    home: "systemConfig",
    kind: "behaviour",
    status: "legacy",
    screen: "/settings/restrictions",
    adminOnly: true,
  },
  ...["credit_limit.enforce_new_orders", "credit_limit.enforce_delivery"].map(
    (key): SettingRow => ({
      key,
      home: "systemConfig",
      kind: "behaviour",
      status: "moves to policy (PR-3)",
      plannedSurface: "PR-3 credit Off/Watch card",
    }),
  ),
  // WS4 (SA-606) staff order email "Also send to" list: tenant CONFIG DATA (a JSON array of
  // addresses, written by `StaffEmailSettingsService` via `PUT /messaging/staff-email-settings`).
  // The switch that decides whether anything is sent is the policy row below, not this key.
  {
    key: "notifications.staffCc",
    home: "systemConfig",
    kind: "config",
    status: "pending WS4",
    plannedSurface: "WS4 staff order email 'Also send to' list (Settings → Notifications tab)",
    adminOnly: true,
  },
  // ── policy (#1337): pending, no code yet ─────────────────────────────────────
  ...(
    [
      ["notifications.staffOrderEmail", "WS4 staff order email switch (Notifications tab)"],
      ["credit.enforceNewOrders", "PR-3 credit Off/Watch card"],
      ["credit.enforceDelivery", "PR-3 credit Off/Watch card"],
    ] as const
  ).map(([key, plannedSurface]): SettingRow => ({
    key,
    home: "policy",
    kind: "behaviour",
    status: "pending #1337",
    plannedSurface,
    adminOnly: true,
  })),
  // WS8: the out-of-stock ordering switch (Settings -> Orders & stock), `PATCH /settings/inventory`.
  // Operators open the card read-only; only a TENANT_ADMIN changes it, so the row is not adminOnly.
  {
    key: "orders.buyerOversell",
    home: "policy",
    kind: "behaviour",
    status: "live",
    screen: "#out-of-stock-ordering",
  },
  // ── featureConfig: tenant-admin Fulfillment tab (`/settings/fulfilment`), dark behind
  // FULFILMENT_SELF_SERVE. The key is the feature-registry key; both rows are admin-only (an
  // operator reads the tab but cannot change it).
  ...(["fulfilment_model", "counter_sales"] as const).map((key): SettingRow => ({
    key,
    home: "featureConfig",
    kind: "behaviour",
    status: "live",
    screen:
      key === "fulfilment_model"
        ? "/settings?tab=fulfilment#delivery-method"
        : "/settings?tab=fulfilment#counter-sales",
    adminOnly: true,
  })),
  // ── userPref: derived from PREF so the list cannot drift ─────────────────────
  {
    key: PREF.lowStockDigestEnabled,
    home: "userPref",
    kind: "preference",
    status: "live",
    screen: "/settings?tab=notifications",
    adminOnly: true,
  },
  {
    key: PREF.staffOrderEmail,
    home: "userPref",
    kind: "preference",
    status: "pending WS4",
    plannedSurface: "WS4 staff order email toggle (My account → Email me about)",
    adminOnly: true,
  },
  {
    key: PREF.staffBuyerChangeEmail,
    home: "userPref",
    kind: "preference",
    status: "pending WS4",
    plannedSurface: "WS4 staff buyer-change email toggle (My account → Email me about)",
    adminOnly: true,
  },
  {
    key: PREF.pushEnabled,
    home: "userPref",
    kind: "preference",
    status: "live",
    screen: "mobile:settings",
  },
  {
    key: PREF.locale,
    home: "userPref",
    kind: "preference",
    status: "live",
    screen: "app:language-switcher",
  },
  {
    key: PREF.billLastSupplierId,
    home: "userPref",
    kind: "memo",
    status: "live",
    screen: "implicit",
  },
  {
    key: PREF.paymentLastMethod,
    home: "userPref",
    kind: "memo",
    status: "live",
    screen: "implicit",
  },
];

/** True when `key` is covered by an exact row or a `prefix*` pattern row. */
export function isRegisteredSettingKey(
  key: string,
  rows: readonly SettingRow[] = SETTINGS_REGISTRY,
): boolean {
  return rows.some((r) =>
    r.key.endsWith("*") ? key.startsWith(r.key.slice(0, -1)) : r.key === key,
  );
}

/** Every rule the registry must satisfy; an empty array means valid. */
export function validateSettingsRegistry(
  rows: readonly SettingRow[] = SETTINGS_REGISTRY,
  /**
   * The feature-registry keys that carry a `config` block (the api owns that registry; this package
   * cannot import it). When given, every `featureConfig` row must name one of them.
   */
  featureConfigKeys?: readonly string[],
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.key)) problems.push(`${r.key}: duplicate key`);
    seen.add(r.key);
    const hasSurface = !!r.screen || !!r.plannedSurface;
    if (!hasSurface) problems.push(`${r.key}: no screen and no plannedSurface`);
    if (r.screen && r.plannedSurface) problems.push(`${r.key}: has both screen and plannedSurface`);
    const pending = r.status !== "live" && r.status !== "legacy";
    if (pending && r.screen) problems.push(`${r.key}: pending rows cannot claim a screen`);
    if (
      r.status === "moves to policy (PR-3)" &&
      !(CREDIT_LIMIT_MOVING_KEYS as readonly string[]).includes(r.key)
    )
      problems.push(`${r.key}: only the named credit_limit.* keys may be "moves to policy (PR-3)"`);
    if (r.plannedSurface && r.status === "live")
      problems.push(`${r.key}: live rows need a screen, not a plannedSurface`);
    if (r.home === "policy" && r.status !== "pending #1337" && r.status !== "live")
      problems.push(`${r.key}: policy rows are "pending #1337" until #1337 lands`);
    if (r.home === "policy" && r.kind !== "behaviour")
      problems.push(`${r.key}: the policy store holds behaviour switches only`);
    if (r.home === "featureConfig") {
      if (r.kind !== "behaviour")
        problems.push(`${r.key}: feature-config rows are behaviour modes only`);
      if (featureConfigKeys && !featureConfigKeys.includes(r.key))
        problems.push(`${r.key}: not a feature-registry key with a config block`);
    }
    if (r.home === "userPref" && r.kind !== "preference" && r.kind !== "memo")
      problems.push(`${r.key}: per-user home holds preferences only`);
    if (r.home === "systemConfig" && r.kind === "behaviour") {
      const legacy = r.key in LEGACY_SYSTEM_CONFIG_BEHAVIOUR;
      const moving = r.status === "moves to policy (PR-3)";
      if (!legacy && !moving)
        problems.push(
          `${r.key}: new SystemConfig behaviour key — behaviour switches belong in the policy store (SA-602)`,
        );
      if (legacy && r.status !== "legacy")
        problems.push(`${r.key}: grandfathered key must carry status "legacy"`);
    }
  }
  return problems;
}
