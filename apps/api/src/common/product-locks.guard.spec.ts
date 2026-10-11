/**
 * SA-767 L-1 — structural pin for the ONE Product stock lock (#2841).
 *
 * `lockProductsForStock` (common/product-locks.ts) is the only place a stock / cost writer takes
 * Product row locks: ONE statement, tenant-filtered, `ORDER BY rank, id FOR UPDATE`, where rank is
 * the catalog house order by ROLE (family role -> recipe-product role -> everything else), spelled
 * once as `PRODUCT_LOCK_RANK_SQL` (the stock-side twin of the HOUSE LOCK ORDER comment in
 * products/product-catalog-sync.ts). Before it,
 * order-stock.ts locked `WHERE id IN (...) FOR UPDATE` (index scan order) with no tenant filter, and
 * `lockProducts` locked one id at a time in id order: a stock writer holding a component and then
 * asking for the family deadlocks (40P01) against a catalog writer (B908).
 *
 * Plain jest, reads source, no DB. Comments are stripped before scanning so prose never counts.
 */
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..");

const strip = (code: string) =>
  code
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/.*$/gm, (m, lead: string) => lead + " ".repeat(m.length - lead.length));

const read = (rel: string) => {
  const file = path.join(SRC, rel);
  return fs.existsSync(file) ? strip(fs.readFileSync(file, "utf8")) : "";
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      return e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
    }
    return /\.ts$/.test(e.name) && !/\.(spec|test)\.ts$/.test(e.name)
      ? [path.join(dir, e.name)]
      : [];
  });
}

/** A `FROM "Product"` followed by `FOR UPDATE` inside ONE string / template literal (no backtick between). */
const RAW_PRODUCT_LOCK = /FROM\s+\\?"Product\\?"[^`]*?FOR\s+(?:NO\s+KEY\s+)?UPDATE/;

/**
 * Every non-spec file allowed to hold a raw `FROM "Product" ... FOR UPDATE` statement, with why.
 * A new stock / cost writer calls `lockProductsForStock`; it never adds itself here. SA-767
 * L-2..L-5 writers (recordPurchase, recordAdjustment, counts, cost basis, replay, returns, import,
 * reopen, writeOff) hold no raw statement today (they lock through `lockProducts`, now a delegate
 * of the helper, or not at all), so none is listed under an L-2..L-5 reason.
 */
const RAW_LOCK_ALLOW_LIST: Record<string, string> = {
  "common/product-locks.ts": "the one stock-writer helper (this guard pins its SQL)",
  "products/product-catalog-sync.ts":
    "lockProductRow: the catalog house lock (family / recipe product / component rows), taken first",
  "products/recipe-category-guard.ts":
    "lockProductsForCategoryWrite: a catalog writer; locks family, recipe product, then targets in the house order",
};

describe("SA-767 L-1 — lockProductsForStock is the one Product stock lock", () => {
  const helper = read("common/product-locks.ts");

  it("the helper statement is tenant-filtered, ranked by PRODUCT_LOCK_RANK_SQL then id, FOR UPDATE", () => {
    expect(helper).toMatch(/"tenantId"\s*=\s*\$\{tenantId\}/);
    expect(helper).toMatch(/p\.id\s*=\s*ANY\(\$\{ids\}::text\[\]\)/);
    expect(helper).toMatch(/ORDER BY\s+\$\{PRODUCT_LOCK_RANK_SQL\}\s*,\s*p\.id\s+FOR UPDATE/);
    // One statement: a single lock call, never a per-id loop.
    expect((helper.match(/FOR UPDATE/g) ?? []).length).toBe(1);
    expect(helper).toMatch(/export async function lockProductsForStock\b/);
  });

  it("the rank fragment is exported, by role, and the ONLY ORDER BY expression in the helper", () => {
    expect(helper).toMatch(/export const PRODUCT_LOCK_RANK_SQL\s*=\s*Prisma\.sql`/);
    // Exactly one ORDER BY in the whole helper: ORDER BY <rank>, id; the fragment has none.
    expect((helper.match(/ORDER BY/gi) ?? []).length).toBe(1);
    const fragment = helper.slice(
      helper.indexOf("export const PRODUCT_LOCK_RANK_SQL"),
      helper.indexOf("export async function lockProductsForStock"),
    );
    expect(fragment).not.toMatch(/ORDER BY/i);
    expect(fragment).toMatch(/kind\s*=\s*'FAMILY'/);
    expect(fragment).toMatch(/kind\s*=\s*'RECIPE'/);
    // The family role: a child Product (parentProductId) or a Recipe (familyProductId), same tenant.
    expect(fragment).toMatch(
      /c\."parentProductId"\s*=\s*p\.id\s+AND\s+c\."tenantId"\s*=\s*p\."tenantId"/,
    );
    expect(fragment).toMatch(
      /rf\."familyProductId"\s*=\s*p\.id\s+AND\s+rf\."tenantId"\s*=\s*p\."tenantId"/,
    );
    // The recipe-product role: a Recipe (productId), same tenant.
    expect(fragment).toMatch(
      /rp\."productId"\s*=\s*p\.id\s+AND\s+rp\."tenantId"\s*=\s*p\."tenantId"/,
    );
    // First match wins (family role 0 before recipe-product role 1), the rest is 2.
    expect(fragment.replace(/\s+/g, " ")).toMatch(/WHEN .*THEN 0 WHEN .*THEN 1 ELSE 2 END/);
  });

  it("the HOUSE LOCK ORDER comment in product-catalog-sync.ts names PRODUCT_LOCK_RANK_SQL as its stock-side twin", () => {
    const raw = fs.readFileSync(path.join(SRC, "products/product-catalog-sync.ts"), "utf8");
    const block = raw.slice(raw.indexOf("HOUSE LOCK ORDER"));
    const comment = block.slice(0, block.indexOf("*/"));
    expect(comment).toMatch(/PRODUCT_LOCK_RANK_SQL/);
    expect(comment).toMatch(/common\/product-locks\.ts/);
  });

  it("SET LOCAL lock_timeout is the helper's FIRST statement, before the lock (r-note 2 (c))", () => {
    expect(helper).toMatch(/export const STOCK_LOCK_TIMEOUT\s*=\s*"5s"/);
    const set = helper.search(/SET LOCAL lock_timeout\s*=/);
    const lock = helper.search(/FOR UPDATE/);
    expect(set).toBeGreaterThan(-1);
    expect(set).toBeLessThan(lock);
    // after the empty-tenant / empty-ids guards (nothing to lock = no statement), before the lock
    expect(helper.search(/if\s*\(\s*ids\.length === 0\s*\)\s*return/)).toBeLessThan(set);
    // SET LOCAL only: a session-level SET would leak the timeout to the pooled connection
    expect(helper).not.toMatch(/SET lock_timeout/);
  });

  it("refuses an empty tenant id (never an unfiltered lock)", () => {
    expect(helper).toMatch(/if\s*\(\s*!tenantId\s*\)\s*throw/);
  });

  it('no non-spec file outside the named allow-list holds a raw FROM "Product" ... FOR UPDATE', () => {
    const offenders: string[] = [];
    const seen = new Set<string>();
    for (const file of walk(SRC)) {
      const rel = path.relative(SRC, file).replace(/\\/g, "/");
      if (!RAW_PRODUCT_LOCK.test(strip(fs.readFileSync(file, "utf8")))) continue;
      seen.add(rel);
      if (!(rel in RAW_LOCK_ALLOW_LIST)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // The allow-list stays honest: every entry still has the statement it is excused for.
    expect([...seen].sort()).toEqual(Object.keys(RAW_LOCK_ALLOW_LIST).sort());
  });

  it("order-stock.ts locks through the helper with the ambient tenant, twice", () => {
    const src = read("orders/order-stock.ts");
    expect(src).toMatch(
      /import\s*\{\s*lockProductsForStock\s*\}\s*from\s*"..\/common\/product-locks"/,
    );
    expect((src.match(/lockProductsForStock\(\s*\w+\s*,\s*deps\.tenantId/g) ?? []).length).toBe(2);
  });

  it("InventoryService.lockProducts delegates to the helper (no per-id loop)", () => {
    const src = read("inventory/inventory.service.ts");
    const body = src.slice(src.indexOf("async lockProducts("));
    const end = body.indexOf("\n  }\n");
    const method = body.slice(0, end);
    expect(method).toMatch(/lockProductsForStock\(\s*tx\s*,\s*this\.prisma\.getTenantId\(\)/);
    expect(method).not.toMatch(/for\s*\(/);
  });
});

/**
 * B908 — the global lock order for the stock paths that already lock through `lockProducts`:
 * (advisory) -> the DOMAIN row (PurchaseOrder / VendorBill) -> Products -> anything else, and no
 * Product value is read before the Product lock. Source-order pin over each method body.
 */
function methodBody(src: string, name: string): string {
  const head = src.search(new RegExp(`\n  (?:private |public )?async ${name}\\(`));
  if (head < 0) return "";
  const rest = src.slice(head + 1);
  const next = rest
    .slice(1)
    .search(/\n  (?:private |public |protected )?(?:async )?\w+\(|\n  \/\*\*/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

/** The first index of `re` in `body`, or Infinity. */
const at = (body: string, re: RegExp) => {
  const m = re.exec(body);
  return m ? m.index : Infinity;
};

/**
 * True iff the domain lock comes first, then the product lock, then the first single-row Product
 * read / write (the stock and cost values a writer decides from). updatePurchaseOrder's one
 * pre-lock `tx.product.findMany` is the line-product existence / kind validation (404 + the FAMILY
 * refusal): it decides no stock or cost value, so `findMany` is not counted.
 */
function domainThenProducts(body: string, domainLock: RegExp): boolean {
  const d = at(body, domainLock);
  const p = at(body, /\blockProducts\(/);
  const read = at(body, /\btx\.product\.(?:findUnique|findFirst|update)\(/);
  return d < p && p < read;
}

describe("SA-767 L-1 / B908 — domain row, then Products, then reads", () => {
  const inv = read("inventory/inventory.service.ts");
  const bills = read("vendor-bills/vendor-bills.service.ts");

  const PO = /this\.lockPurchaseOrder\(/;
  const BILL = /this\.lockBillAndAssertReceiptState\(/;
  const cases = [
    {
      site: "InventoryService.receivePurchaseOrder",
      src: inv,
      name: "receivePurchaseOrder",
      re: PO,
    },
    { site: "InventoryService.updatePurchaseOrder", src: inv, name: "updatePurchaseOrder", re: PO },
    { site: "VendorBillsService.receive", src: bills, name: "receive", re: BILL },
    { site: "VendorBillsService.revertToDraft", src: bills, name: "revertToDraft", re: BILL },
    { site: "VendorBillsService.voidBill", src: bills, name: "voidBill", re: BILL },
  ];

  it.each(cases)("$site: domain lock < lockProducts < first Product read", ({ src, name, re }) => {
    const body = methodBody(src, name);
    expect(body).not.toBe("");
    expect(domainThenProducts(body, re)).toBe(true);
  });

  it("the pin has teeth: Products locked before the domain row, or read before the lock, fail it", () => {
    const re = /this\.lockPurchaseOrder\(/;
    const ok = "this.lockPurchaseOrder(tx); this.lockProducts(tx); tx.product.findUnique(x)";
    const productsFirst = "this.lockProducts(tx); this.lockPurchaseOrder(tx); tx.product.update(x)";
    const readFirst = "this.lockPurchaseOrder(tx); tx.product.findUnique(x); this.lockProducts(tx)";
    expect(domainThenProducts(ok, re)).toBe(true);
    expect(domainThenProducts(productsFirst, re)).toBe(false);
    expect(domainThenProducts(readFirst, re)).toBe(false);
  });
});

/**
 * SA-767 Nit 6: every wrapped stock writer retries through `retryStockTx` (exhausted attempts are a
 * coded 503 LOCK_UNAVAILABLE), never the bare `retryOnTxConflict`.
 */
describe("SA-767 Nit 6 — the stock writers use retryStockTx", () => {
  const inv = read("inventory/inventory.service.ts");
  const bills = read("vendor-bills/vendor-bills.service.ts");

  it.each([
    ["inventory.receivePurchaseOrder", inv],
    ["inventory.updatePurchaseOrder", inv],
    // SA-767 L-2: the manual stock / cost writers.
    ["inventory.recordPurchase", inv],
    ["inventory.recordAdjustment", inv],
    ["inventory.assignToVariants", inv],
    ["inventory.commitStockCount", inv],
    ["inventory.commitStockCountSession", inv],
    ["inventory.setCostBasis", inv],
    ["inventory.bulkSetCostBasis", inv],
    ["vendorBills.receive", bills],
    ["vendorBills.revertToDraft", bills],
    ["vendorBills.voidBill", bills],
  ])("%s runs inside retryStockTx", (label, src) => {
    expect(src).toContain(`retryStockTx("${label}"`);
  });

  it("the inventory service no longer uses the bare retryOnTxConflict (SA-767 L-2)", () => {
    expect(inv).not.toMatch(/retryOnTxConflict/);
  });

  it("the vendor-bill service no longer imports the bare retryOnTxConflict", () => {
    expect(bills).not.toMatch(/\bretryOnTxConflict\b/);
  });
});

/**
 * SA-767 r-note 3 (b): the order sale sites (create, the DRAFT<->PENDING moves, cancel, reopen, edit,
 * the at-door merge, standing-order generation) run their stock tx inside `retryStockTx`, so a lock
 * wait that gave up re-runs the tx and an exhausted retry is the coded 503. Behaviour is pinned in
 * orders/orders.lock-retry.spec.ts; this is the placement pin, next to the L-2 sites above.
 */
describe("SA-767 r-note 3 (b) — the order sale sites use retryStockTx", () => {
  // raw (unstripped): the comment stripper trips on glob-like text in this very large file
  const orders = fs.readFileSync(path.join(SRC, "orders/orders.service.ts"), "utf8");

  it.each([
    "orders.create",
    "orders.promoteDraft",
    "orders.demoteToDraft",
    "orders.cancel",
    "orders.reopen",
    "orders.approveChangeRequestAtStop",
  ])("orders.service runs %s through stockTx", (label) => {
    const at = orders.indexOf(`"${label}"`);
    expect(at).toBeGreaterThan(-1);
    expect(orders.slice(Math.max(0, at - 40), at)).toMatch(/this\.stockTx\(\s*$/);
  });

  it("stockTx is retryStockTx around the unchanged tenantTransaction(fn, opts)", () => {
    expect(orders).toContain("retryStockTx(label, () => this.prisma.tenantTransaction(fn, opts))");
  });

  it.each([
    ["orders/order-inline-return.ts", "orders.updateOrderItems"],
    ["order-templates/order-templates.service.ts", "orderTemplates.generate"],
  ])("%s wraps %s in retryStockTx", (rel, label) => {
    expect(read(rel)).toContain(`retryStockTx("${label}"`);
  });

  it("the orders service no longer uses the bare retryOnTxConflict", () => {
    expect(orders).not.toMatch(/\bretryOnTxConflict\b/);
  });
});
