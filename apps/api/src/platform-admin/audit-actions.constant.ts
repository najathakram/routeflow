/**
 * Stable, structured audit action codes for platform-admin (super-admin) actions.
 *
 * The global AuditInterceptor records a generic row for every mutation (e.g.
 * `PATCH /platform-admin/tenants/<id>/status` with tenantId=null), which never
 * surfaces when the audit log is filtered by the affected tenant. To make
 * platform actions traceable per-tenant, PlatformAdminService emits its OWN
 * rows with these codes, keyed to the TARGET tenant (tenantId=<target>,
 * userId=<super-admin>, entityType="tenant", entityId=<target>).
 *
 * Codes are the source of truth: the API maps them to `actionLabel` on read and
 * serves them to the audit-log filter dropdown via the /audit-logs/facets
 * endpoint, so the label lives in exactly one place.
 */
export const ADMIN_AUDIT_ENTITY = "tenant" as const;

export const AdminAuditAction = {
  TENANT_CREATED: "TENANT_CREATED",
  TENANT_SUSPENDED: "TENANT_SUSPENDED",
  TENANT_REACTIVATED: "TENANT_REACTIVATED",
  TENANT_STATUS_CHANGED: "TENANT_STATUS_CHANGED",
  TENANT_PLAN_CHANGED: "TENANT_PLAN_CHANGED",
  TENANT_TRIAL_EXTENDED: "TENANT_TRIAL_EXTENDED",
  TENANT_SUBSCRIPTION_ACTIVATED: "TENANT_SUBSCRIPTION_ACTIVATED",
  /**
   * The billing MARKER of a manual activation, written INSIDE its transaction (so it exists exactly when the
   * activation does). A completed card checkout reads the latest one, under the same tenant row lock, to know
   * whether the tenant moved to manual invoicing after the checkout session was created. NOT the post-commit
   * TENANT_SUBSCRIPTION_ACTIVATED trail row, which is best-effort (AuditService swallows write errors) and
   * lands after the commit.
   */
  TENANT_MANUAL_ACTIVATION_MARKER: "TENANT_MANUAL_ACTIVATION_MARKER",
  /**
   * SA-733r11/r12 (row 385): APPEND-ONLY correction markers read by the catch-up beside the activation markers
   * (never an edit of the original row). VOID `{ voidsMarkerId, reason, actor, ownerApprovedAt }`: that activation's
   * window is NOT paid coverage. RESTORE `{ restoresMarkerId, ... }`: undoes a VOID (the latest of the two per
   * activation marker wins, by createdAt then id). BILLING_START_OVERRIDE `{ billingStart, reason, actor,
   * ownerApprovedAt }`: the catch-up floor, an anchor 1st at 12:00Z not before go-live.
   */
  TENANT_MANUAL_ACTIVATION_COVERAGE_VOID: "TENANT_MANUAL_ACTIVATION_COVERAGE_VOID",
  TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE: "TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE",
  TENANT_BILLING_START_OVERRIDE: "TENANT_BILLING_START_OVERRIDE",
  /** SA-733r9: a catch-up line under Stripe's $0.50 minimum was forgiven (one row per session id). */
  CATCHUP_MINIMUM_FORGIVEN: "catchup.minimum-forgiven",
  TENANT_DELETED: "TENANT_DELETED",
  TENANT_CONFIG_UPDATED: "TENANT_CONFIG_UPDATED",
  TENANT_ADMIN_PASSWORD_RESET: "TENANT_ADMIN_PASSWORD_RESET",
  TENANT_ADMIN_CREATED: "TENANT_ADMIN_CREATED",
  ADDON_ENABLED: "ADDON_ENABLED",
  ADDON_DISABLED: "ADDON_DISABLED",
  ADDON_COMPED: "ADDON_COMPED",
  ADDON_UNCOMPED: "ADDON_UNCOMPED",
  /** A duplicate checkout was cancelled; its first invoice was charged and has to be refunded in Stripe. */
  STRIPE_DUPLICATE_CHECKOUT: "STRIPE_DUPLICATE_CHECKOUT",
  /** A checkout add-on (its row, or its item) had no usable quantity: any item was removed (or the SKU left off the checkout) and nothing is billed for it. */
  ADDON_CHECKOUT_ITEM_UNUSABLE: "ADDON_CHECKOUT_ITEM_UNUSABLE",
  /** A PAID checkout was refused because no Stripe customer / subscription row exists to verify it against. */
  STRIPE_PAID_CHECKOUT_NOT_APPLIED: "STRIPE_PAID_CHECKOUT_NOT_APPLIED",
  /** A checkout listed add-on SKUs that no recognised Stripe item carries: not billed, no second item created. */
  ADDON_CHECKOUT_ITEMS_UNRECOGNISED: "ADDON_CHECKOUT_ITEMS_UNRECOGNISED",
  ADDON_MANUAL_INVOICE_DUE: "ADDON_MANUAL_INVOICE_DUE",
  ADDON_MANUAL_INVOICE_STOP: "ADDON_MANUAL_INVOICE_STOP",
  IMPERSONATION_STARTED: "IMPERSONATION_STARTED",
  TENANT_CLASS_CHANGED: "TENANT_CLASS_CHANGED",
  FEATURE_OVERRIDE_SET: "FEATURE_OVERRIDE_SET",
  FEATURE_OVERRIDE_REVOKED: "FEATURE_OVERRIDE_REVOKED",
  BUSINESS_PROFILE_APPLIED: "BUSINESS_PROFILE_APPLIED",
  ENTITLEMENTS_MODE_CHANGED: "ENTITLEMENTS_MODE_CHANGED",
  FEATURE_DIFF_EXPLAINED: "FEATURE_DIFF_EXPLAINED",
  CONFIG_SNAPSHOT_RESTORED: "CONFIG_SNAPSHOT_RESTORED",
  CONFIG_SNAPSHOT_FLAG_CHANGED: "CONFIG_SNAPSHOT_FLAG_CHANGED",
  // #2159 S1 — wholesaler onboarding cases. tenantId is null until the case is activated.
  ONBOARDING_CASE_CREATED: "ONBOARDING_CASE_CREATED",
  ONBOARDING_STAGE_ADVANCED: "ONBOARDING_STAGE_ADVANCED",
  ONBOARDING_STEP_WAIVED: "ONBOARDING_STEP_WAIVED",
  // #2159 S2 — the intake link.
  ONBOARDING_LINK_ISSUED: "ONBOARDING_LINK_ISSUED",
  ONBOARDING_LINK_REVOKED: "ONBOARDING_LINK_REVOKED",
  // Manual invoices due (PR1): the issuer's notices, written in the issuing transaction.
  RF_INVOICE_ISSUED: "RF_INVOICE_ISSUED",
  RF_INVOICE_NEEDS_PRICE: "RF_INVOICE_NEEDS_PRICE",
  RF_INVOICE_STALE_PERIOD: "RF_INVOICE_STALE_PERIOD",
  // Manual invoices due (PR2): the office's actions on an invoice, written in the action's transaction.
  RF_INVOICE_MARKED_PAID: "RF_INVOICE_MARKED_PAID",
  RF_INVOICE_REOPENED: "RF_INVOICE_REOPENED",
  RF_INVOICE_VOIDED: "RF_INVOICE_VOIDED",
  RF_INVOICE_IRREGULAR_PERIOD: "RF_INVOICE_IRREGULAR_PERIOD",
  RF_INVOICE_SENT: "RF_INVOICE_SENT",
  // Counter day close (SA-750r3): a tenant operator or admin reopened a closed till window. Written INSIDE the reopen transaction
  // (entityType "CounterDayClose", meta = the snapshot that was in force), so the old figures are never lost.
  COUNTER_DAY_CLOSE_REOPENED: "COUNTER_DAY_CLOSE_REOPENED",
  // Feature-config writes (FeatureConfigService): logged under their own entity type, so the
  // Audit Log tab labels them instead of printing the raw code. Values equal the service's
  // FEATURE_CONFIG_SET_ACTION / FEATURE_CONFIG_CLEARED_ACTION (pinned by the constant spec).
  FEATURE_CONFIG_SET: "FEATURE_CONFIG_SET",
  FEATURE_CONFIG_CLEARED: "FEATURE_CONFIG_CLEARED",
} as const;

export type AdminAuditActionCode = (typeof AdminAuditAction)[keyof typeof AdminAuditAction];

/** Human-readable label per action code — the single source shown in every admin UI. */
export const ADMIN_AUDIT_ACTION_LABELS: Record<AdminAuditActionCode, string> = {
  TENANT_CREATED: "Tenant created",
  TENANT_SUSPENDED: "Tenant suspended",
  TENANT_REACTIVATED: "Tenant reactivated",
  TENANT_STATUS_CHANGED: "Status changed",
  TENANT_PLAN_CHANGED: "Plan changed",
  TENANT_TRIAL_EXTENDED: "Trial extended",
  TENANT_SUBSCRIPTION_ACTIVATED: "Subscription activated (manual)",
  TENANT_MANUAL_ACTIVATION_MARKER: "Manual activation recorded (billing marker)",
  TENANT_MANUAL_ACTIVATION_COVERAGE_VOID: "Manual activation coverage voided (billing correction)",
  TENANT_MANUAL_ACTIVATION_COVERAGE_RESTORE:
    "Manual activation coverage restored (billing correction)",
  TENANT_BILLING_START_OVERRIDE: "Billing start set (billing correction)",
  CATCHUP_MINIMUM_FORGIVEN: "Catch-up line under the card minimum forgiven",
  TENANT_DELETED: "Tenant deleted",
  TENANT_CONFIG_UPDATED: "Configuration updated",
  TENANT_ADMIN_PASSWORD_RESET: "Admin password reset",
  TENANT_ADMIN_CREATED: "Admin account created",
  ADDON_ENABLED: "Add-on enabled",
  ADDON_DISABLED: "Add-on disabled",
  ADDON_COMPED: "Add-on granted as a comp (free, not billed)",
  ADDON_UNCOMPED: "Add-on comp removed (now billable)",
  STRIPE_DUPLICATE_CHECKOUT: "Duplicate checkout (refund needed)",
  ADDON_CHECKOUT_ITEM_UNUSABLE: "Checkout add-on not billed (no usable quantity)",
  STRIPE_PAID_CHECKOUT_NOT_APPLIED: "Paid checkout not applied (reconcile in Stripe)",
  ADDON_CHECKOUT_ITEMS_UNRECOGNISED: "Checkout add-on items not recognised (check Stripe)",
  ADDON_MANUAL_INVOICE_DUE: "Add-on to invoice manually",
  ADDON_MANUAL_INVOICE_STOP: "Add-on to stop invoicing manually",
  IMPERSONATION_STARTED: "Impersonation started",
  TENANT_CLASS_CHANGED: "Class changed",
  FEATURE_OVERRIDE_SET: "Feature override set",
  FEATURE_OVERRIDE_REVOKED: "Feature override revoked",
  BUSINESS_PROFILE_APPLIED: "Business profile applied",
  ENTITLEMENTS_MODE_CHANGED: "Entitlements mode changed",
  FEATURE_DIFF_EXPLAINED: "Feature resolver diff explained",
  CONFIG_SNAPSHOT_RESTORED: "Configuration snapshot restored",
  CONFIG_SNAPSHOT_FLAG_CHANGED: "Config snapshot flag changed",
  ONBOARDING_CASE_CREATED: "Onboarding case created",
  ONBOARDING_STAGE_ADVANCED: "Onboarding stage advanced",
  ONBOARDING_STEP_WAIVED: "Onboarding step waived",
  ONBOARDING_LINK_ISSUED: "Onboarding intake link issued",
  ONBOARDING_LINK_REVOKED: "Onboarding intake link revoked",
  RF_INVOICE_ISSUED: "RouteFlow invoice issued",
  RF_INVOICE_NEEDS_PRICE: "RouteFlow invoice not issued (no price)",
  RF_INVOICE_STALE_PERIOD: "RouteFlow invoice not issued (stale period)",
  RF_INVOICE_MARKED_PAID: "RouteFlow invoice marked paid",
  RF_INVOICE_REOPENED: "RouteFlow invoice reopened",
  RF_INVOICE_VOIDED: "RouteFlow invoice voided",
  RF_INVOICE_IRREGULAR_PERIOD: "RouteFlow invoice needs review (irregular period)",
  RF_INVOICE_SENT: "RouteFlow invoice emailed",
  COUNTER_DAY_CLOSE_REOPENED: "Counter day close reopened",
  FEATURE_CONFIG_SET: "Feature setting changed",
  FEATURE_CONFIG_CLEARED: "Feature setting cleared",
};

/** Facet list for the audit-log filter dropdown (code + label), ordered as declared. */
export const ADMIN_AUDIT_ACTION_FACETS: ReadonlyArray<{
  code: AdminAuditActionCode;
  label: string;
}> = (Object.keys(ADMIN_AUDIT_ACTION_LABELS) as AdminAuditActionCode[]).map((code) => ({
  code,
  label: ADMIN_AUDIT_ACTION_LABELS[code],
}));

/** Returns the friendly label for a known admin action code, or null for legacy/interceptor rows. */
export function adminAuditActionLabel(action: string): string | null {
  return (ADMIN_AUDIT_ACTION_LABELS as Record<string, string>)[action] ?? null;
}
