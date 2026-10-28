import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import type { CreateOrderOptions } from "./order-create-options";
import type { SaleOptions } from "./sale-options";

/**
 * SA-1034: the price-edit capability is checked at every override site, through the ONE helper
 * `assertPriceEditAllowed` (staff-override.ts), with a required boolean that every compute site gets from the ONE
 * helper `priceEditAllowedFor` (auth/permissions/price-edit.ts: the deny list and the permissions mode read once).
 *
 *  - `decideTierOverride(` has exactly the callers listed below; a new one is reviewed and added here.
 *  - each override-site file has EXACTLY its count of `assertPriceEditAllowed(` and `priceEditAllowedFor(` calls: a
 *    new site raises its count in its own diff, where it is reviewed (OP-7).
 *  - `assertPriceEditAllowed` takes a required `boolean`.
 *  - `staffMay(…, "EDIT_LINE_PRICE"…)` is called only inside price-edit.ts (and not at all anywhere else).
 *  - neither `CreateOrderOptions` nor `SaleOptions` declares `priceEditAllowed`: a caller passes a principal, never a boolean.
 * Pure source reads: no Nest, no database.
 */
const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name !== "node_modules" && name !== "testing") sourceFiles(abs, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) {
      out.push(relative(SRC, abs));
    }
  }
  return out;
}

/** The code of a file with `//` and block comments removed, so a mention in prose never counts. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const callCount = (text: string, name: string) =>
  [...code(text).matchAll(new RegExp(`(?<!function )\\b${name}\\(`, "g"))].length;

const DECIDE_TIER_OVERRIDE_CALLERS: Record<string, number> = {
  "orders/orders.service.ts": 2, // create (pack line) + updateOrderItems (substitute)
  "orders/replace-all-line-build.ts": 1, // the create auto-merge's new line
  "invoices/invoice-line-override.ts": 1, // invoice line create / edit (pack line)
};

/** Exact: the `assertPriceEditAllowed(` calls each override-site file makes. */
const ASSERT_COUNTS: Record<string, number> = {
  "orders/orders.service.ts": 4, // create pack, substitute, diff-add, existing-line edit
  "orders/unit-line-build.ts": 1, // a unit line's new override (create + unit-line-edit)
  "orders/replace-all-line-build.ts": 1, // replace-all repriced line + the create auto-merge's new line
  "invoices/invoice-line-override.ts": 1, // invoice line create / edit, pack and unit
  "estimates/estimates.service.ts": 1, // estimate create: a typed catalog price under list (rule 5)
};

/**
 * Exact: the `assertCustomPricesAllowed(` calls, one per AUTHORING site of a custom (no product) priced line (rule 4).
 * COPY sites never call it: the create auto-merge and the buyer/driver replace (orders.service), the estimate convert
 * (it copies through buildManualInvoiceLines, which must stay free of it), the recurring run (source "template-run"),
 * and order -> invoice generation.
 */
const CUSTOM_ASSERT_COUNTS: Record<string, number> = {
  "orders/orders.service.ts": 3, // create (covers the counter), staff full replace (new lines), diff-add
  "invoices/invoices.service.ts": 2, // direct invoice create, invoice edit (new / re-priced custom lines)
  "estimates/estimates.service.ts": 1, // estimate create
  "recurring-invoices/recurring-invoices.service.ts": 1, // template create + update, through one private method
};

/** Exact: the `priceEditAllowedFor(` compute sites (the helper's own definition is not a call). */
const COMPUTE_COUNTS: Record<string, number> = {
  "orders/orders.service.ts": 2, // create, updateOrderItems (each once, before its transaction)
  "invoices/invoice-line-override.ts": 1, // loadOverride: invoice create and edit
  "returns/inline-returns-quote.service.ts": 1, // priceInlineReturn: the quote and the capture's credit price
  "estimates/estimates.service.ts": 1, // create
  "recurring-invoices/recurring-invoices.service.ts": 1, // assertCustomLinesAllowed (template create + update)
};

describe("SA-1034: price-edit capability is checked at every override site", () => {
  const files = sourceFiles(SRC);

  it("decideTierOverride( has exactly 4 callers outside staff-override.ts (a new caller must be reviewed)", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      if (f === join("orders", "staff-override.ts")) continue;
      const n = callCount(read(f), "decideTierOverride");
      if (n > 0) found[f.split("\\").join("/")] = n;
    }
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(4);
    expect(found).toEqual(DECIDE_TIER_OVERRIDE_CALLERS);
  });

  it.each(Object.entries(ASSERT_COUNTS))(
    "%s has exactly %i assertPriceEditAllowed( calls",
    (file, n) => {
      expect(callCount(read(file), "assertPriceEditAllowed")).toBe(n);
    },
  );

  it("assertPriceEditAllowed( is called nowhere else outside staff-override.ts", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      if (f === join("orders", "staff-override.ts")) continue;
      const n = callCount(read(f), "assertPriceEditAllowed");
      if (n > 0) found[f.split("\\").join("/")] = n;
    }
    expect(found).toEqual(ASSERT_COUNTS);
  });

  it.each(Object.entries(CUSTOM_ASSERT_COUNTS))(
    "%s has exactly %i assertCustomPricesAllowed( calls",
    (file, n) => {
      expect(callCount(read(file), "assertCustomPricesAllowed")).toBe(n);
    },
  );

  it("assertCustomPricesAllowed( is called nowhere else outside staff-override.ts (never in the shared copy builders)", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      if (f === join("orders", "staff-override.ts")) continue;
      const n = callCount(read(f), "assertCustomPricesAllowed");
      if (n > 0) found[f.split("\\").join("/")] = n;
    }
    expect(found).toEqual(CUSTOM_ASSERT_COUNTS);
  });

  it("orders.service.ts holds exactly 7 `productId: null` sites, each classified in the SA-1034 PR body", () => {
    // AUTHORING (assertCustomPricesAllowed): create, staff full replace, diff-add. COPY: the two auto-merge re-homes and
    // the buyer/driver replace (a buyer's entry is ignored, B51; a driver keeps today's behaviour). The seventh is the
    // `where: { productId: null }` filter. A new site must be classed AUTHORING or COPY in its own diff.
    expect([...code(read("orders/orders.service.ts")).matchAll(/productId: null/g)]).toHaveLength(
      7,
    );
  });

  it("priceEditAllowedFor( is called at exactly the compute sites, once each per request path", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = callCount(read(f), "priceEditAllowedFor");
      if (n > 0) found[f.split("\\").join("/")] = n;
    }
    expect(found).toEqual(COMPUTE_COUNTS);
  });

  it("assertPriceEditAllowed takes a required boolean (no undefined, no optional parameter)", () => {
    const sig = read("orders/staff-override.ts").match(
      /export function assertPriceEditAllowed\(([^)]*)\)/,
    );
    expect(sig).not.toBeNull();
    const params = sig![1];
    expect(params).toMatch(/^\s*\w+\s*:\s*boolean\s*$/);
    expect(params).not.toMatch(/undefined|\?/);
  });

  it("unit-line-edit threads the capability into both unit-line builders", () => {
    const n = [
      ...code(read("orders/unit-line-edit.ts")).matchAll(
        /priceEditAllowed: ctx\.priceEditAllowed/g,
      ),
    ].length;
    expect(n).toBe(2);
  });

  it('staffMay(…, "EDIT_LINE_PRICE"…) is called only inside auth/permissions/price-edit.ts', () => {
    const where: string[] = [];
    for (const f of files) {
      for (const m of code(read(f)).matchAll(/staffMay\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) {
        if (m[1].includes('"EDIT_LINE_PRICE"')) where.push(f.split("\\").join("/"));
      }
    }
    // price-edit.ts holds the two (role-only and enforced); the capability tables define the row, they do not call it.
    expect(where).toEqual(["auth/permissions/price-edit.ts", "auth/permissions/price-edit.ts"]);
  });

  it("neither CreateOrderOptions nor SaleOptions declares priceEditAllowed (a caller passes a principal, never a boolean)", () => {
    expect(code(read("orders/order-create-options.ts"))).not.toContain("priceEditAllowed");
    expect(code(read("orders/sale-options.ts"))).not.toContain("priceEditAllowed");
    // type level: an excess property on either type is a compile error (check-types fails if it is ever re-added)
    // @ts-expect-error priceEditAllowed is not a create() option
    const create: CreateOrderOptions = { priceEditAllowed: true };
    // @ts-expect-error priceEditAllowed is not a sale option
    const sale: SaleOptions = { priceEditAllowed: true };
    expect([create, sale]).toHaveLength(2);
  });
});
