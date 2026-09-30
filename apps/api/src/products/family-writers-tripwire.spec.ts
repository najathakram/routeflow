import { readdirSync, readFileSync } from "fs";
import { join, relative } from "path";

/**
 * WS8 (SA-606): a FAMILY is never on a sellable line and never stocked. STRUCTURAL tripwire (Opus #2881 B1): every non-spec
 * source file that WRITES a sales / PO / template / recurring line, or a StockMovement / StockLot, must either call the
 * ONE `assertSellableLines` (products/sellable-lines.ts) or sit on the reasoned ALLOW list below. A new writer file that
 * is on neither list is red, and the guard call counts are pinned, so a removed call is red too.
 *
 * A "writer site" is: `<line|stock delegate>.create|createMany|upsert(`, a nested `lineItems|items: { create`, or an
 * `<line delegate>.update(Many)(` whose data names `productId` (the substitution shape).
 */
const SRC = join(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const WRITER =
  /\b(?:orderItem|invoiceItem|estimateItem|purchaseOrderItem|orderTemplateItem|recurringInvoiceItem|stockMovement|stockLot)\s*\.\s*(?:create|createMany|upsert)\s*\(|\b(?:lineItems|items)\s*:\s*\{\s*create\b|\b(?:orderItem|invoiceItem|estimateItem|purchaseOrderItem|orderTemplateItem)\s*\.\s*update(?:Many)?\s*\(\s*\{[^}]{0,400}?\bproductId\b/g;
const GUARD = /assertSellableLines\(/g;

/** Files that call the guard: the EXACT call count is pinned. */
const GUARDED: Record<string, { calls: number; why: string }> = {
  "orders/orders.service.ts": {
    calls: 6,
    why: "create(); updateOrderItems: replace-all (x2 load sites), the diff edit-add, the substitute line; approveChangeRequestAtStop ADD_ITEM",
  },
  "orders/change-requests.service.ts": {
    calls: 1,
    why: "a door ADD_ITEM is refused at filing time, before it can reach approval",
  },
  "estimates/estimates.service.ts": { calls: 1, why: "estimate create/update line load" },
  "invoices/manual-invoice-context.ts": { calls: 1, why: "manual invoice create line products" },
  "invoices/invoice-edit-plan.ts": {
    calls: 1,
    why: "loadEditCatalog: PATCH /invoices/:id line products (create and update do NOT share manual-invoice-context)",
  },
  "inventory/inventory.service.ts": {
    calls: 5,
    why: "createDraftPurchaseOrderInTx, createPurchaseOrder, updatePurchaseOrder, recordPurchase (StockLot), recordAdjustment",
  },
  "order-templates/order-templates.service.ts": {
    calls: 4,
    why: "template create, update (replace-all), addItem, generateOrder (would become a SALE movement)",
  },
  "recurring-invoices/recurring-invoices.service.ts": {
    calls: 1,
    why: "the assertNoFamilyLines helper, which BOTH template create and the replace-all update call (pinned in the wiring spec)",
  },
  "vendor-bills/vendor-bills.service.ts": {
    calls: 1,
    why: "receiving a bill line writes a StockLot + PURCHASE movement: a FAMILY is refused there",
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
    why: "invoice import links by sku/unitSku/NAME: the name lookup excludes kind FAMILY (pinned below); the Zoho stock-sync movement only touches products matched by sku",
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
  rel: relative(SRC, p),
  src: strip(readFileSync(p, "utf8")),
}));

describe("FAMILY never on a sellable line or in stock: a structural tripwire (WS8)", () => {
  it.each(Object.entries(GUARDED))(
    "%s calls assertSellableLines exactly %d time(s)",
    (file, { calls, why }) => {
      expect(why.length).toBeGreaterThan(10);
      const f = files.find((x) => x.rel === file)!;
      expect(f).toBeDefined();
      expect(count(GUARD, f.src)).toBe(calls);
      expect(f.src).toMatch(/from "\.\.\/products\/sellable-lines"/);
    },
  );

  it.each(Object.entries(ALLOWED))(
    "%s is an allowed writer with %d pinned site(s)",
    (file, { sites, why }) => {
      expect(why.length).toBeGreaterThan(20);
      const f = files.find((x) => x.rel === file)!;
      expect(f).toBeDefined();
      expect(count(GUARD, f.src)).toBe(0); // a guarded file belongs in GUARDED, not here
      expect(count(WRITER, f.src)).toBe(sites);
    },
  );

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

  it("import.service's product NAME lookup excludes FAMILY (families have no codes, so the name is the only path)", () => {
    const f = files.find((x) => x.rel === "import/import.service.ts")!;
    expect(f.src).toMatch(/kind:\s*\{\s*not:\s*"FAMILY"\s*\}/);
  });
});
