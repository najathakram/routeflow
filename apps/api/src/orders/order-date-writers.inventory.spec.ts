/**
 * W-1188 pin (a): the sale's business date has ONE writer and ONE gate.
 *  - `Order.orderDate` is written in exactly one place, `OrdersService.create` (the shorthand `orderDate,` in its
 *    order.create data), and no update path writes it. Every `orderDate:` key in source is on a reviewed list.
 *  - every `resolveOrderDate(` call in the API passes a `policy` (the compiler already requires it; this keeps a
 *    cast from hiding one) and the callers are exactly the two reviewed files.
 *  - the old UTC-leaking `parseOrderDate` stays deleted.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.ts$/.test(name) && !/\.(spec|test|db\.spec)\.ts$/.test(name)) files.push(path);
  }
};
walk(SRC);
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");
const read = (p: string) => readFileSync(p, "utf8");

describe("W-1188: one order-date writer, one gate", () => {
  it("`orderDate,` (the write into order.create data) appears in exactly one file, once", () => {
    const hits = files.flatMap((f) => {
      const n = read(f)
        .split("\n")
        .filter((l) => /^\s+orderDate,\s*$/.test(l)).length;
      return n > 0 ? [`${rel(f)}:${n}`] : [];
    });
    expect(hits).toEqual(["orders/orders.service.ts:1"]);
  });

  it("every `orderDate:` key in source is a reviewed read, a pass-through or the stamp; a new one needs a review", () => {
    // Reviewed 2026-11-09 (W-1188 PR-1b). Reads: where/select/orderBy in analytics, suggestions, open lines, product open
    // orders, commissions, receipts. Pass-through of the DTO day: counter-sale.service, orders.service createSale.
    // Parked list (W-1188 PR-3, reviewed 2026-11-11): counter-park.service.ts (the list maps the parked payload's day onto
    // the list row, only when isCalendarDay) and counter-park.fixtures.ts (the fake list row). Both are READS of the parked
    // payload, never a write to Order.orderDate; the day was whitelisted by sanitizeParkedPayload at park and resume, and the
    // resumed sale still goes through the one writer and its gate (resolveOrderDate) at Complete.
    // order-date.ts holds the gate (resolve/drift/audit meta). A hit outside this list, or one more in a listed file,
    // fails here so a second writer (or an update path) cannot slip in beside the one reviewed writer.
    const reviewed: Record<string, number> = {
      "analytics/analytics.service.ts": 2,
      "customers/customer-order-suggestions.service.ts": 3,
      "documents/receipt-model.ts": 1,
      "documents/receipt.fixtures.ts": 1,
      "documents/receipt.service.ts": 1,
      "orders/counter-sale/counter-park.fixtures.ts": 1,
      "orders/counter-sale/counter-park.service.ts": 1,
      "orders/counter-sale/counter-sale-today.ts": 1,
      "orders/counter-sale/counter-sale.service.ts": 1,
      "orders/open-order-lines.ts": 4,
      "orders/order-date.ts": 4,
      "orders/orders.service.ts": 1,
      "products/product-open-orders.service.ts": 1,
      "sales-agents/commission-engine.service.ts": 2,
    };
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = read(f)
        .split("\n")
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l) && /\borderDate\s*:/.test(l)).length;
      if (n > 0) found[rel(f)] = n;
    }
    expect(found).toEqual(reviewed);
  });

  it("every resolveOrderDate( call passes a policy, from the reviewed files (the create() path goes through order-date.ts itself)", () => {
    const callers: string[] = [];
    for (const f of files) {
      if (rel(f) === "orders/order-date.ts") continue;
      const text = read(f);
      let at = text.indexOf("resolveOrderDate(");
      while (at !== -1) {
        callers.push(rel(f));
        const call = text.slice(at, text.indexOf(");", at) + 2);
        expect(call).toMatch(/policy/);
        at = text.indexOf("resolveOrderDate(", at + 1);
      }
    }
    expect(callers.sort()).toEqual(["orders/sale-options.ts"]);
  });

  it("parseOrderDate (the UTC end-of-day leak) is gone", () => {
    expect(files.filter((f) => /\bparseOrderDate\(/.test(read(f))).map(rel)).toEqual([]);
  });
});
