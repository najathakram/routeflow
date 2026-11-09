/**
 * W-1188 pin (a): the sale's business date has ONE writer and ONE gate.
 *  - `Order.orderDate` is written in exactly one place, `OrdersService.create` (the shorthand `orderDate,` in its
 *    order.create data), and no update path writes it.
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

  it("every resolveOrderDate( call passes a policy, from the two reviewed files", () => {
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
    expect(callers.sort()).toEqual(["orders/orders.service.ts", "orders/sale-options.ts"]);
  });

  it("parseOrderDate (the UTC end-of-day leak) is gone", () => {
    expect(files.filter((f) => /\bparseOrderDate\(/.test(read(f))).map(rel)).toEqual([]);
  });
});
