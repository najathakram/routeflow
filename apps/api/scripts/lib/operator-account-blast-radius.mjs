/**
 * Pure mapping + aggregation layer for `report-operator-account-blast-radius.mjs`.
 *
 * No I/O here (so a unit spec can pin it without a database): the account-administration handler
 * list, the regex the report pushes down to SQL, how an AuditLog `action` maps back to a handler,
 * and how per-(tenant, action) row counts roll up into per-tenant counts.
 *
 * HOW AuditLog RECORDS A REQUEST (apps/api/src/audit/audit.interceptor.ts, a global
 * APP_INTERCEPTOR): ONLY mutating methods (POST / PUT / PATCH / DELETE) are logged, AFTER the
 * route guards pass and BEFORE the handler runs, as
 *   action     = `${METHOD} /${path segments}`   (global prefix `api/v1` and the query string dropped)
 *   entityType = first path segment               (`users`, `settings`, `tenant`, `import`, ...)
 *   entityId   = second path segment or null      (for `PATCH /users/:id` this is the TARGET user)
 *   userId     = the JWT subject; impersonatedBy = the platform admin when impersonating.
 * Consequences the report states loudly:
 *   - GET handlers leave NO trace: they cannot be counted (see `untraceableHandlers`).
 *   - A row means "an OPERATOR got past the guards to this handler", not that the call succeeded
 *     (a later 400 / 500 is still logged); a call the guards refused (401 / 403) is never logged.
 *   - The audit row carries no handler name, so a handler is recognised by its method + path.
 */

/** Path prefixes a handler may be mounted under (the settings controller has two). */
const PREFIX_ALIASES = { "/settings": ["/settings", "/tenant/settings"] };

/**
 * Every handler that account administration closes to admins. `id` is `<area>.<handler>`;
 * `controller` is the source file (relative to apps/api/src) that declares it, which the unit
 * spec checks against the code so this list cannot drift from the controllers silently.
 * `nonSelfOnly`: only a call whose target user differs from the actor counts (PATCH /users/:id).
 */
export const CLOSED_HANDLERS = [
  // users (6) + non-self update
  h("users.createOperator", "POST", "/users/operator", "users/users.controller.ts"),
  h("users.changeStatus", "PATCH", "/users/:id/status", "users/users.controller.ts"),
  h("users.resetPassword", "POST", "/users/:id/reset-password", "users/users.controller.ts"),
  h("users.unlock", "POST", "/users/:id/unlock", "users/users.controller.ts"),
  h("users.toggleAdmin", "PATCH", "/users/:id/admin", "users/users.controller.ts"),
  h("users.toggleDriverPermit", "PATCH", "/users/:id/driver-permit", "users/users.controller.ts"),
  h("users.update", "PATCH", "/users/:id", "users/users.controller.ts", { nonSelfOnly: true }),
  // stripe-connect (2)
  h(
    "stripe-connect.link",
    "POST",
    "/settings/stripe-connect/link",
    "stripe-connect/stripe-connect.controller.ts",
    { method: "link" },
  ),
  h(
    "stripe-connect.disconnect",
    "DELETE",
    "/settings/stripe-connect",
    "stripe-connect/stripe-connect.controller.ts",
    { method: "disconnect" },
  ),
  // data import (13)
  h("import.importContacts", "POST", "/import/contacts", "import/import.controller.ts"),
  h("import.importInvoices", "POST", "/import/invoices", "import/import.controller.ts"),
  h("import.importPayments", "POST", "/import/payments", "import/import.controller.ts"),
  h("import.importExpenses", "POST", "/import/expenses", "import/import.controller.ts"),
  h("import.listExpenseBatches", "GET", "/import/expenses/batches", "import/import.controller.ts"),
  h(
    "import.repairInventoryPurchaseExpenses",
    "POST",
    "/import/expenses/repair-inventory",
    "import/import.controller.ts",
  ),
  h(
    "import.rollbackExpenseBatch",
    "DELETE",
    "/import/expenses/batch/:batchId",
    "import/import.controller.ts",
  ),
  h("import.importProducts", "POST", "/import/products", "import/import.controller.ts"),
  h("import.importInventory", "POST", "/import/inventory", "import/import.controller.ts"),
  h(
    "import.importExpenseSuppliers",
    "POST",
    "/import/expense-suppliers",
    "import/import.controller.ts",
  ),
  h(
    "import.markSupplierOnlyCustomers",
    "POST",
    "/import/contacts/mark-supplier-only",
    "import/import.controller.ts",
  ),
  h(
    "import.diagnoseOrphanedContacts",
    "GET",
    "/import/contacts/orphans",
    "import/import.controller.ts",
  ),
  h(
    "import.adoptOrphanedContacts",
    "POST",
    "/import/contacts/adopt-orphans",
    "import/import.controller.ts",
  ),
  // migration (6)
  h("migration.list", "GET", "/import/migration", "import/migration.controller.ts"),
  h("migration.create", "POST", "/import/migration", "import/migration.controller.ts"),
  h("migration.get", "GET", "/import/migration/:id", "import/migration.controller.ts"),
  h("migration.stage", "POST", "/import/migration/:id/stage", "import/migration.controller.ts"),
  h("migration.confirm", "POST", "/import/migration/:id/confirm", "import/migration.controller.ts"),
  h("migration.undo", "POST", "/import/migration/:id/undo", "import/migration.controller.ts"),
  // document numbering (3)
  h("numbering.getSettings", "GET", "/import/numbering", "import/numbering.controller.ts"),
  h(
    "numbering.previewPrefix",
    "GET",
    "/import/numbering/:docType/preview",
    "import/numbering.controller.ts",
  ),
  h(
    "numbering.updateSettings",
    "PUT",
    "/import/numbering/:docType",
    "import/numbering.controller.ts",
  ),
  // billing export (1)
  h("billing.export", "GET", "/billing/export", "billing/settings-billing.controller.ts"),
  // email sending + Anthropic settings (12)
  h("settings.getEmailSettings", "GET", "/settings/email", "system-config/settings.controller.ts"),
  h(
    "settings.updateEmailSettings",
    "POST",
    "/settings/email",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.testEmailSettings",
    "POST",
    "/settings/email/test",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.verifyEmailConnection",
    "POST",
    "/settings/email/verify",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.getSendingDomain",
    "GET",
    "/settings/email/domain",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.addSendingDomain",
    "POST",
    "/settings/email/domain",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.refreshSendingDomain",
    "POST",
    "/settings/email/domain/refresh",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.verifySendingDomain",
    "POST",
    "/settings/email/domain/verify",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.setSendingFrom",
    "POST",
    "/settings/email/domain/from",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.removeSendingDomain",
    "DELETE",
    "/settings/email/domain",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.getAnthropicSettings",
    "GET",
    "/settings/anthropic",
    "system-config/settings.controller.ts",
  ),
  h(
    "settings.updateAnthropicSettings",
    "PATCH",
    "/settings/anthropic",
    "system-config/settings.controller.ts",
  ),
  // CRM connection (4)
  h("crm.saveConnection", "PATCH", "/crm/gohighlevel/connection", "crm/crm.controller.ts"),
  h("crm.testConnection", "POST", "/crm/gohighlevel/connection/test", "crm/crm.controller.ts"),
  h("crm.disconnect", "DELETE", "/crm/gohighlevel/connection", "crm/crm.controller.ts"),
  h("crm.updateConfig", "PATCH", "/crm/gohighlevel/config", "crm/crm.controller.ts"),
  // bulk wipes (4) + product import (1)
  h("customers.deleteAll", "DELETE", "/customers/all", "customers/customers.controller.ts"),
  h(
    "customers.cleanupPreview",
    "GET",
    "/customers/cleanup-preview",
    "customers/customers.controller.ts",
  ),
  h(
    "customers.cleanupImported",
    "DELETE",
    "/customers/cleanup-imported",
    "customers/customers.controller.ts",
  ),
  h("products.clearAll", "DELETE", "/products/clear-all", "products/products.controller.ts"),
  h("products.importFromZoho", "POST", "/products/import", "products/products.controller.ts"),
];

function h(id, httpMethod, route, controller, extra = {}) {
  const method = extra.method ?? id.slice(id.indexOf(".") + 1);
  return {
    id,
    httpMethod,
    route,
    controller,
    method,
    nonSelfOnly: Boolean(extra.nonSelfOnly),
    // Only mutations are audited; a GET handler is invisible to this report.
    audited: httpMethod !== "GET",
  };
}

/** Handlers the report cannot count at all: no AuditLog row is ever written for a GET. */
export function untraceableHandlers(handlers = CLOSED_HANDLERS) {
  return handlers.filter((x) => !x.audited);
}

/** Handlers whose calls leave an AuditLog row (every non-GET). */
export function traceableHandlers(handlers = CLOSED_HANDLERS) {
  return handlers.filter((x) => x.audited);
}

/** The area prefix of an id: `users.update` -> `users`. */
export function areaOf(id) {
  return id.slice(0, id.indexOf("."));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every concrete path a handler route can be reached on (prefix aliases expanded). */
function routeVariants(route) {
  for (const [prefix, variants] of Object.entries(PREFIX_ALIASES)) {
    if (route === prefix || route.startsWith(`${prefix}/`)) {
      return variants.map((v) => v + route.slice(prefix.length));
    }
  }
  return [route];
}

function segmentsOf(path) {
  return path.split("/").filter(Boolean);
}

/**
 * ONE regex (valid as a JS RegExp AND a Postgres ARE: only anchors, groups, `|` and `[^/]+`) that
 * matches the `action` of every traceable handler; the report passes it to SQL as `action ~ $n`
 * so the database narrows the rows instead of the report pulling the whole audit trail.
 */
export function buildActionRegex(handlers = traceableHandlers()) {
  const alts = [];
  for (const handler of handlers) {
    for (const variant of routeVariants(handler.route)) {
      const body = segmentsOf(variant)
        .map((seg) => (seg.startsWith(":") ? "[^/]+" : escapeRe(seg)))
        .join("/");
      alts.push(`${handler.httpMethod} /${body}`);
    }
  }
  return `^(${alts.join("|")})$`;
}

function compile(handler) {
  return routeVariants(handler.route).map((variant) => {
    const segs = segmentsOf(variant);
    return { handler, segs, statics: segs.filter((s) => !s.startsWith(":")).length };
  });
}

const COMPILED = CLOSED_HANDLERS.flatMap(compile);

/**
 * Which closed handler does an AuditLog `action` belong to? Returns the handler id or null.
 * `action` is `METHOD /seg/seg` exactly as the interceptor writes it. A handler with a more
 * specific (more static segments) route wins, so `DELETE /customers/all` is never read as a
 * param route. `nonSelf` is `entityId !== userId`; a `nonSelfOnly` handler ignores self calls.
 */
export function classifyAction(action, { nonSelf = true } = {}) {
  if (typeof action !== "string") return null;
  const space = action.indexOf(" ");
  if (space < 0) return null;
  const method = action.slice(0, space);
  const segs = segmentsOf(action.slice(space + 1));
  let best = null;
  for (const c of COMPILED) {
    if (c.handler.httpMethod !== method || c.segs.length !== segs.length) continue;
    const ok = c.segs.every((s, i) => s.startsWith(":") || s === segs[i]);
    if (!ok) continue;
    if (!best || c.statics > best.statics) best = c;
  }
  if (!best) return null;
  if (best.handler.nonSelfOnly && !nonSelf) return null;
  return best.handler.id;
}

/**
 * Roll `[{ slug, action, nonSelf, n }]` (one row per tenant + action + self/non-self) up to
 * `[{ slug, total, byHandler: { id: n }, byArea: { area: n } }]`, tenants sorted by slug.
 * Rows that map to no closed handler are ignored; counts are summed, nothing else is kept.
 */
export function aggregateByTenant(rows) {
  const tenants = new Map();
  for (const r of rows) {
    const id = classifyAction(r.action, { nonSelf: r.nonSelf !== false });
    if (!id) continue;
    const n = Number(r.n) || 0;
    if (n <= 0) continue;
    let t = tenants.get(r.slug);
    if (!t) {
      t = { slug: r.slug, total: 0, byHandler: {}, byArea: {} };
      tenants.set(r.slug, t);
    }
    t.total += n;
    t.byHandler[id] = (t.byHandler[id] ?? 0) + n;
    const area = areaOf(id);
    t.byArea[area] = (t.byArea[area] ?? 0) + n;
  }
  return [...tenants.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Sum of every tenant's counts per handler (all tenants together). */
export function totalsByHandler(tenantRows) {
  const out = {};
  for (const t of tenantRows) {
    for (const [id, n] of Object.entries(t.byHandler)) out[id] = (out[id] ?? 0) + n;
  }
  return out;
}
