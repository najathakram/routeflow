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
  TENANT_DELETED: "TENANT_DELETED",
  TENANT_CONFIG_UPDATED: "TENANT_CONFIG_UPDATED",
  TENANT_ADMIN_PASSWORD_RESET: "TENANT_ADMIN_PASSWORD_RESET",
  TENANT_ADMIN_CREATED: "TENANT_ADMIN_CREATED",
  ADDON_ENABLED: "ADDON_ENABLED",
  ADDON_DISABLED: "ADDON_DISABLED",
  IMPERSONATION_STARTED: "IMPERSONATION_STARTED",
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
  TENANT_DELETED: "Tenant deleted",
  TENANT_CONFIG_UPDATED: "Configuration updated",
  TENANT_ADMIN_PASSWORD_RESET: "Admin password reset",
  TENANT_ADMIN_CREATED: "Admin account created",
  ADDON_ENABLED: "Add-on enabled",
  ADDON_DISABLED: "Add-on disabled",
  IMPERSONATION_STARTED: "Impersonation started",
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
