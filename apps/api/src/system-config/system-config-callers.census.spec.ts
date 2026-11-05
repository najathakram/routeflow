import * as fs from "fs";
import * as path from "path";

/**
 * SA-1102 §2.2 (S-9): the SystemConfigService caller census. `SystemConfigService.get/getAll/set` read the tenant's
 * row through `prisma.forTenant()`, which returns the UNSCOPED client when no tenant is in context, so a tenantless
 * call reads (or writes) ANOTHER business's row. The throw that closes that (SYSTEM_CONFIG_TENANT_REQUIRED) may land
 * only while every caller is proven to run inside a tenant. This table is that proof, and it must EQUAL the source
 * both ways: a new caller fails until it is classified here, and a row whose file no longer calls the service is
 * stale and fails (the tenant-refs-writers.inventory.spec.ts pattern).
 *
 *   REQUEST - reached only through a tenant-guarded controller (the JWT guard sets the tenant; a SUPER_ADMIN without a
 *             selected business now gets the coded 500 instead of another business's row).
 *   CTX     - runs inside `tenantCtx.run(tenantId, ...)`: a cron that iterates tenants, a queue processor, or the
 *             buyer portal's BuyerTenantInterceptor.
 *   EXPLICIT- a `getForTenant(tenantId, key)` caller. None exists: no job needs one, so the method is not built.
 *   NONE    - no tenant in context. MUST stay empty: a NONE site is fixed (CTX / EXPLICIT) before the throw lands.
 */
type Cls = "REQUEST" | "CTX" | "EXPLICIT";
interface Row {
  cls: Cls[];
  /** The call count in the file (pins an ADDED call in an already-classified file). */
  calls: number;
  via: string;
}
const R = (calls: number, via: string, ...cls: Cls[]): Row => ({ cls, calls, via });

const SRC = path.join(__dirname, "..");

const TABLE: Record<string, Row> = {
  "analytics/analytics.service.ts": R(
    1,
    "AnalyticsController (tenant JWT): tobacco-exclude flag",
    "REQUEST",
  ),
  "buyer/buyer.controller.ts": R(
    1,
    "BuyerTenantInterceptor sets the seller's tenant for GET remittance",
    "CTX",
  ),
  "common/tax-rate.ts": R(
    1,
    "free function; callers are orders.service and inline-returns-quote",
    "REQUEST",
    "CTX",
  ),
  "invoices/invoice-pdf.service.ts": R(
    3,
    "InvoicesController / BuyerController (CTX) and the recurring-invoice cron's send (CTX)",
    "REQUEST",
    "CTX",
  ),
  "invoices/invoice-reminder-email.ts": R(
    2,
    "free function; InvoicesService.sendReminder via InvoicesController",
    "REQUEST",
  ),
  "invoices/invoices.service.ts": R(
    8,
    "InvoicesController; the recurring-invoice cron runs generateInvoiceFromTemplate inside tenantCtx.run",
    "REQUEST",
    "CTX",
  ),
  "order-templates/order-templates.service.ts": R(
    1,
    "OrderTemplatesController; the daily cron wraps each tenant in tenantCtx.run",
    "REQUEST",
    "CTX",
  ),
  "orders/orders.service.ts": R(
    1,
    "OrdersController / buyer routes (BuyerTenantInterceptor); order-sweep wraps each group in tenantCtx.run",
    "REQUEST",
    "CTX",
  ),
  "products/products.service.ts": R(
    1,
    "ProductsController; product-import.processor wraps its job in tenantCtx.run",
    "REQUEST",
    "CTX",
  ),
  "returns/inline-returns-quote.service.ts": R(
    1,
    "orders controllers (order inline return)",
    "REQUEST",
  ),
  "route-optimization/route-analysis.service.ts": R(
    4,
    "RouteOptimizationController: route.* settings (the key reads left with SA-1102 item 3)",
    "REQUEST",
  ),
  "route-optimization/route-optimization.service.ts": R(
    7,
    "RouteOptimizationController",
    "REQUEST",
  ),
  "system-config/quick-keys-settings.service.ts": R(
    2,
    "SettingsController (counter quick keys)",
    "REQUEST",
  ),
  "system-config/settings.controller.ts": R(
    44,
    "SettingsController (@Roles, tenant JWT); receiptFooter already refuses without a tenant",
    "REQUEST",
  ),
  "tobacco/tobacco.service.ts": R(
    2,
    "TobaccoController settings (the monthly report cron does not call these two)",
    "REQUEST",
  ),
  "trips/trips.service.ts": R(4, "TripsController (driver / dispatch, tenant JWT)", "REQUEST"),
  "vendor-bills/vendor-bills.service.ts": R(
    1,
    "VendorBillsController scan-invoice; BatchController (requireTenant)",
    "REQUEST",
  ),
};

/** Test harnesses that build the service graph: they call nothing in production, so they are exempt and listed. */
const TEST_ONLY = [
  "common/testing/orders-service-db-harness.ts",
  "invoices/testing/split-invoice-service.ts",
  "orders/testing/orders-service-harness.ts",
  "orders/testing/oversell-harness.ts",
];

const METHODS =
  "get|getAll|set|getMarginConfig|setMarginConfig|getRemittanceConfig|setRemittanceConfig|getPricingTierLabels|setPricingTierLabels|getZohoConfig|setZohoConfig";
// Every name the service is held under today: systemConfig, systemConfigService, svc, and deps.systemConfig.
const CALL = new RegExp(
  `\\b(?:systemConfig|systemConfigService|svc)\\s*\\??\\.\\s*(?:${METHODS})\\s*\\(`,
  "g",
);
// A delegation to the one free function that takes the service.
const FREE_FN = /\bcurrentTaxRate\s*\(/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(SRC, p).replace(/\\/g, "/");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/** file -> call count, for every production file that calls the service (or the free function). */
function scan(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(SRC)) {
    const r = rel(file);
    if (r.endsWith(".spec.ts") || r.includes("/testing/")) continue;
    if (r === "system-config/system-config.service.ts") continue; // the service's own internal this.get/this.set
    const text = strip(fs.readFileSync(file, "utf8"));
    // `svc` is also a common name for other services: only a file that names SystemConfigService counts.
    if (!text.includes("SystemConfigService")) continue;
    const own = (text.match(CALL) ?? []).length;
    // tax-rate.ts defines currentTaxRate; its callers delegate, they do not read SystemConfig themselves.
    const delegations = r === "common/tax-rate.ts" ? 0 : (text.match(FREE_FN) ?? []).length;
    if (own + delegations > 0) found[r] = own + delegations;
  }
  return found;
}

describe("SystemConfigService caller census (SA-1102 S-9)", () => {
  const found = scan();

  it("every production caller is classified, and every row is still a caller (both ways)", () => {
    expect(Object.keys(found).sort()).toEqual(Object.keys(TABLE).sort());
  });

  it("pins each file's call count, so an added call in a classified file is reviewed", () => {
    const counts = Object.fromEntries(Object.entries(TABLE).map(([f, r]) => [f, r.calls]));
    expect(found).toEqual(counts);
  });

  it("NONE = 0: every row names at least one tenant-bearing class and a reason", () => {
    const none = Object.entries(TABLE).filter(([, r]) => r.cls.length === 0 || !r.via.trim());
    expect(none).toEqual([]);
  });

  it("the exempt harnesses still exist (a deleted harness is a stale row)", () => {
    for (const f of TEST_ONLY) expect(fs.existsSync(path.join(SRC, f))).toBe(true);
  });
});
