/**
 * The account-admin endpoints an OPERATOR can call today and a TENANT_ADMIN alone will keep (owner
 * ruling 2026-10-07). One list, shared by the read-only usage report
 * (`apps/api/scripts/report-operator-account-blast-radius.mjs`) and the spec that pins it to the real
 * controller metadata (`src/common/operator-account-routes.spec.ts`).
 *
 * The AuditLog row for a mutation is written by `AuditInterceptor` with `action` = `"<METHOD> /<path>"`
 * (no `/api/v1`, real ids in the path), so each entry is a regex over that string. Reads (GET) leave no
 * row, so a closed GET (settings email / AI key reads, billing export, import list reads) cannot be
 * counted: `READS_NOT_COUNTED` names them, so the report says what it cannot see.
 */

/** @type {{ group: string; label: string; re: string; notSelf?: boolean }[]} */
const CLOSED_MUTATIONS = [
  { group: "users", label: "create operator", re: "^POST /users/operator$" },
  { group: "users", label: "change status", re: "^PATCH /users/[^/]+/status$" },
  { group: "users", label: "reset password", re: "^POST /users/[^/]+/reset-password$" },
  { group: "users", label: "unlock login", re: "^POST /users/[^/]+/unlock$" },
  { group: "users", label: "toggle admin", re: "^PATCH /users/[^/]+/admin$" },
  { group: "users", label: "toggle driver permit", re: "^PATCH /users/[^/]+/driver-permit$" },
  // Editing ANOTHER user (a self edit stays allowed): the row's userId differs from the entity id.
  { group: "users", label: "edit another user", re: "^PATCH /users/[^/]+$", notSelf: true },
  { group: "stripe", label: "connect", re: "^POST /settings/stripe-connect/link$" },
  { group: "stripe", label: "disconnect", re: "^DELETE /settings/stripe-connect$" },
  {
    group: "import",
    label: "CSV imports and repairs",
    re: "^(POST|DELETE) /import/(contacts|invoices|payments|expenses|products|inventory|expense-suppliers)(/.*)?$",
  },
  { group: "migration", label: "migration jobs", re: "^(POST|DELETE) /import/migration(/.*)?$" },
  { group: "numbering", label: "document numbering", re: "^PUT /import/numbering/[^/]+$" },
  {
    group: "email-ai",
    label: "SMTP, sending domain, AI key",
    re: "^(POST|PATCH|DELETE) /(tenant/)?settings/(email(/.*)?|anthropic)$",
  },
  {
    group: "crm",
    label: "CRM connection and config",
    re: "^(PATCH|DELETE|POST) /crm/gohighlevel/(connection(/test)?|config)$",
  },
  { group: "wipes", label: "delete all customers", re: "^DELETE /customers/all$" },
  {
    group: "wipes",
    label: "clean up imported customers",
    re: "^DELETE /customers/cleanup-imported$",
  },
  { group: "wipes", label: "clear all products", re: "^DELETE /products/clear-all$" },
  { group: "wipes", label: "Zoho product import", re: "^POST /products/import$" },
];

/** Closed handlers that are reads: no AuditLog row exists, so the report cannot count them. */
const READS_NOT_COUNTED = [
  "GET /settings/email, /settings/email/domain, /settings/anthropic",
  "GET /billing/export",
  "GET /customers/cleanup-preview",
  "GET /import/expenses/batches, /import/contacts/orphans, /import/migration, /import/numbering",
];

module.exports = { CLOSED_MUTATIONS, READS_NOT_COUNTED };
