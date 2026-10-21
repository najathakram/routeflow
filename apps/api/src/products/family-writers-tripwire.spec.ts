import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * WS8 (SA-606): a FAMILY is never on a sellable line and never stocked. STRUCTURAL tripwire (Opus #2881 B1): every non-spec
 * source file that WRITES a sales / PO / template / recurring line, or a StockMovement / StockLot, must either call the
 * ONE `assertSellableLines` (products/sellable-lines.ts) or sit on the reasoned ALLOW list below. A new writer file that
 * is on neither list is red, and the guard call counts are pinned, so a removed call is red too.
 *
 * A "writer site" is: `<line|stock delegate>.create|createMany|createManyAndReturn|upsert(`, a nested `lineItems|items: { create|createMany`, or an
 * `<line delegate>.update(Many)(` whose `data` names `productId` (the substitution shape). The GUARDED rows pin the
 * writer SITE count of the file too (Opus #2881 B6): a new unguarded writer inside an already-guarded file is red until the
 * row is revisited, so it cannot slip past as "the file already calls the guard".
 */
const SRC = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const WRITER =
  /\b(?:orderItem|invoiceItem|estimateItem|purchaseOrderItem|orderTemplateItem|recurringInvoiceItem|stockMovement|stockLot)\s*\.\s*(?:create|createMany|createManyAndReturn|upsert)\s*\(|\b(?:lineItems|items)\s*:\s*\{\s*create(?:Many)?\b|\b(?:orderItem|invoiceItem|estimateItem|purchaseOrderItem|orderTemplateItem|recurringInvoiceItem)\s*\.\s*update(?:Many)?\s*\([^;]{0,300}?\bdata\s*:\s*\{[^}]{0,300}?\bproductId\b/g;
const GUARD = /assertSellableLines\(/g;

/** Files that call the guard: the EXACT call count is pinned. */
const GUARDED: Record<string, { calls: number; sites: number; why: string }> = {
  "orders/orders.service.ts": {
    calls: 6,
    sites: 12,
    why: "create(); updateOrderItems: replace-all (x2 load sites), the diff edit-add, the substitute line; approveChangeRequestAtStop ADD_ITEM",
  },
  "orders/change-requests.service.ts": {
    calls: 1,
    sites: 0,
    why: "a door ADD_ITEM is refused at filing time, before it can reach approval",
  },
  "estimates/estimates.service.ts": { calls: 1, sites: 2, why: "estimate create/update line load" },
  "invoices/manual-invoice-context.ts": {
    calls: 1,
    sites: 0,
    why: "manual invoice create line products",
  },
  "invoices/invoice-edit-plan.ts": {
    calls: 1,
    sites: 0,
    why: "loadEditCatalog: PATCH /invoices/:id line products (create and update do NOT share manual-invoice-context)",
  },
  "inventory/inventory.service.ts": {
    calls: 11,
    sites: 16,
    why: "PO draft/create/update, recordPurchase (StockLot), recordAdjustment, commitStockCount (+ applyStockCountItemsInTx), commitStockCountSession (+ its batch re-check of kind under the product lock, SA-767 n2), upsertStockCountLine, setCostBasis, bulkSetCostBasis; the other writer sites (assignToVariants, PO receive/reverse, cost replay) move stock only out of / into a product that HAS stock: a FAMILY is created with zero stock and never receives any (every entry point above refuses it), so their pool checks reject it",
  },
  "order-templates/order-templates.service.ts": {
    calls: 4,
    sites: 4,
    why: "template create, update (replace-all), addItem, generateOrder (would become a SALE movement)",
  },
  "recurring-invoices/recurring-invoices.service.ts": {
    calls: 1,
    sites: 2,
    why: "the assertNoFamilyLines helper, which BOTH template create and the replace-all update call (pinned in the wiring spec)",
  },
  "vendor-bills/vendor-bills.service.ts": {
    calls: 1,
    sites: 5,
    why: "receiving a bill line writes a StockLot + PURCHASE movement: a FAMILY is refused there (the 4th site is the ONE reversal row revertToDraft and voidBill share (appendBillReversals): it mirrors a receipt row found by the receive() note, so it assumes that row was written by receive() under this guard — a receipt that predates the guard could name a FAMILY, and the reversal then just undoes it; the 5th is voidBill's shortfall ADJUSTMENT (SA-808b): stock with no receipt record is taken out of the product the BILL LINE names, which the receive guard already kept off FAMILY)",
  },
};

/** Writer files that do NOT call the guard, each with the reason it cannot carry a FAMILY line. `sites` is pinned. */
const ALLOWED: Record<string, { sites: number; why: string }> = {
  "bookkeeping/bookkeeping.service.ts": {
    sites: 1,
    why: "the nested itemised ExpenseLineItem rows of an expense (account / notes / amount): an accounting line that has no product column",
  },
  "invoices/invoices.service.ts": {
    sites: 9,
    why: "every line it writes comes from an order line, an estimate line (guarded at their writers) or from manual-invoice-context / invoice-edit-plan (both GUARDED above)",
  },
  "products/products.service.ts": {
    sites: 1,
    why: "opening-stock PURCHASE movement on the product THIS call just created; CreateProductDto has no `kind`, so it is always STANDARD",
  },
  "inventory/sale-movement.ts": {
    sites: 1,
    why: "recordSaleMovement is a leaf called by the order / template writers after they passed the guard; it never loads a product itself",
  },
  "returns/returns-restock.util.ts": {
    sites: 1,
    why: "restocks the product of a RETURN line, which is copied from an order line that was already guarded",
  },
  "returns/inline-returns.service.ts": {
    sites: 2,
    why: "return lines are chosen from the customer's own order/invoice lines (guarded at their writers); no free product id",
  },
  "returns/returns.service.ts": {
    sites: 2,
    why: "return lines/restock derive from the order lines being returned (guarded at their writers)",
  },
  "orders/unit-line-edit.ts": {
    sites: 1,
    why: "a leaf called from orders.service paths that already ran assertSellableLines on the product it passes in",
  },
  "import/import.service.ts": {
    sites: 3,
    why: "invoice import links by sku/unitSku/NAME: the invoice-line NAME fallback excludes kind FAMILY (folded into #2877, which owns that lookup and pins it); the Zoho stock-sync movement only touches products matched by sku",
  },
};

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "testing" || e.name === "node_modules") continue;
      walk(p, out);
    } else if (
      e.name.endsWith(".ts") &&
      !e.name.endsWith(".spec.ts") &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
};
const count = (re: RegExp, s: string) => (s.match(re) ?? []).length;
const files = walk(SRC).map((p) => ({
  rel: relative(SRC, p).split("\\").join("/"), // the PC (Windows) verify keys files with `/`
  src: strip(readFileSync(p, "utf8")),
}));

describe("FAMILY never on a sellable line or in stock: a structural tripwire (WS8)", () => {
  it.each(Object.entries(GUARDED))(
    "%s: guard calls and writer sites are pinned",
    (file, { calls, sites, why }) => {
      expect(why.length).toBeGreaterThan(10);
      const f = files.find((x) => x.rel === file)!;
      expect(f).toBeDefined();
      expect(count(GUARD, f.src)).toBe(calls);
      expect(count(WRITER, f.src)).toBe(sites);
      expect(f.src).toMatch(/from "\.\.\/products\/sellable-lines"/);
    },
  );

  it.each(Object.entries(ALLOWED))("%s: allowed writer, sites pinned", (file, { sites, why }) => {
    expect(why.length).toBeGreaterThan(20);
    const f = files.find((x) => x.rel === file)!;
    expect(f).toBeDefined();
    expect(count(GUARD, f.src)).toBe(0); // a guarded file belongs in GUARDED, not here
    expect(count(WRITER, f.src)).toBe(sites);
  });

  it("every writer file is guarded or allow-listed (a NEW writer file fails here until it calls the guard or is reasoned)", () => {
    const writers = files.filter((f) => count(WRITER, f.src) > 0).map((f) => f.rel);
    const known = new Set([...Object.keys(GUARDED), ...Object.keys(ALLOWED)]);
    expect(writers.filter((w) => !known.has(w)).sort()).toEqual([]);
  });

  it("no non-spec file outside those lists (and outside products/) calls the guard", () => {
    const callers = files
      .filter((f) => count(GUARD, f.src) > 0 && !f.rel.startsWith("products/"))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual(Object.keys(GUARDED).sort());
  });
});

/**
 * SA-823 (PR-1) class pins: ONE family creator, ONE reparent path with its audit writers, units v2 untouched.
 * `files` is comment-stripped, so prose can neither satisfy nor trip a pin.
 */
const srcOf = (rel: string): string => files.find((x) => x.rel === rel)!.src;
/** A method body: from its `async name(` to the next sibling method (or end of file). */
const methodBody = (src: string, name: string): string => {
  const start = src.indexOf(`async ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}(?:private |public |protected )?(?:async |get |static )/);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("SA-823: one family creator, one reparent path, units v2 untouched", () => {
  it('T10: only createFamilyContainer writes kind: "FAMILY" in src', () => {
    const FAMILY_KIND = /\bkind\s*:\s*(?:"FAMILY"|ProductKind\.FAMILY)/;
    const writers = files.filter((f) => FAMILY_KIND.test(f.src)).map((f) => f.rel);
    expect(writers).toEqual(["products/product-families.service.ts"]);
    const svc = srcOf("products/product-families.service.ts");
    expect(methodBody(svc, "createFamilyContainer")).toMatch(FAMILY_KIND);
    expect(methodBody(svc, "createFamily")).not.toMatch(FAMILY_KIND);
    expect(methodBody(svc, "createFamily")).toMatch(/this\.createFamilyContainer\(/);
  });

  it("T11: product.family_assigned is written only by writeFamilyAssigned (SA-823b); create(), update()'s reparent block, inventory createVariantRowInTx and the family editor call it; bulkAssignParent goes through assignToParent", () => {
    const holders = files
      .filter((f) => /PRODUCT_FAMILY_ASSIGNED/.test(f.src))
      .map((f) => [f.rel, count(/PRODUCT_FAMILY_ASSIGNED/g, f.src)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(holders).toEqual([
      ["audit/audit-actions.constant.ts", 1],
      ["products/product-parent.ts", 1],
    ]);
    // global regexes so a SECOND call in any body is caught
    const CALL = /writeFamilyAssigned\(/g;
    const ps = srcOf("products/products.service.ts");
    expect(count(CALL, methodBody(ps, "update"))).toBe(1);
    expect(count(CALL, methodBody(ps, "create"))).toBe(1);
    expect(
      count(CALL, methodBody(srcOf("inventory/inventory.service.ts"), "createVariantRowInTx")),
    ).toBe(1);
    const fs = srcOf("products/product-families.service.ts");
    expect(count(CALL, methodBody(fs, "createFamily"))).toBe(1);
    expect(count(CALL, methodBody(fs, "updateVariants"))).toBe(1);
    // no other file or method calls the writer, and none writes the row inline
    const callers = files
      .filter((f) => count(CALL, f.src) > 0)
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual([
      "inventory/inventory.service.ts",
      "products/product-families.service.ts",
      "products/product-parent.ts",
      "products/products.service.ts",
    ]);
    expect(ps).not.toMatch(/audit\.log\([^)]*family_assigned/);
    const bulk = methodBody(ps, "bulkAssignParent");
    expect(bulk).toMatch(/this\.assignToParent\(/);
    expect(bulk).not.toMatch(/this\.update\(|\.product\.(?:create|update|upsert|updateMany)\(/);
    expect(methodBody(ps, "assignToParent")).toMatch(/this\.update\(/);
    expect(methodBody(ps, "unlinkFromParent")).toMatch(/this\.update\(/);
  });

  it("T13 (PR-2): createFamilyContainer is called only by createFamily and the import's ensureFamily; the import family branch writes no productUnit and no Product row itself", () => {
    const CALL = /createFamilyContainer\(/g;
    const callers = files
      .filter((f) => count(CALL, f.src) > 0)
      .map((f) => [f.rel, count(CALL, f.src)])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(callers).toEqual([
      ["import/product-family-import.service.ts", 1],
      ["products/product-families.service.ts", 2], // its definition and the createFamily call
    ]);
    const imp = srcOf("import/product-family-import.service.ts");
    expect(imp).not.toMatch(/productUnit/);
    expect(imp).not.toMatch(
      /\.product\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/,
    );
    expect(imp).not.toMatch(/kind\s*:\s*"FAMILY"/);
  });

  it("T12: no productUnit write in the family service, product-parent.ts or the reparent paths of ProductsService", () => {
    const UNIT_WRITE =
      /\bproductUnit\s*\.\s*(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/;
    expect(srcOf("products/product-families.service.ts")).not.toMatch(UNIT_WRITE);
    expect(srcOf("products/product-parent.ts")).not.toMatch(UNIT_WRITE);
    const ps = srcOf("products/products.service.ts");
    for (const m of ["assignToParent", "unlinkFromParent", "bulkAssignParent"]) {
      expect(methodBody(ps, m)).not.toMatch(UNIT_WRITE);
    }
    const update = methodBody(ps, "update");
    const block = update.slice(
      update.indexOf("fromParentId ="),
      update.indexOf("family.propagate"),
    );
    expect(block.length).toBeGreaterThan(100);
    expect(block).not.toMatch(UNIT_WRITE);
  });
});
