import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// SA-762r: the void restocks in full ONLY because it undoes the hand-over before the cancel. SA-763r: createSale's
// DELIVERED write now stamps deliveredQty = qty (markSaleDelivered -> stampDeliveredInFull, in one tx), so the void's
// reset is no longer a no-op: it is what makes a counter-sale void restock. This spec pins that coupling; the real-DB
// case "(i)" in counter-sale-void.db.spec.ts seeds deliveredQty = qty and proves the restock.
const read = (rel: string) => readFileSync(join(__dirname, rel), "utf8");

describe("the counter void and the DELIVERED write (structure)", () => {
  it("createSale's DELIVERED write goes through markSaleDelivered (status, date and the stamp in one tx), so the void's reset is the net", () => {
    const src = read("../orders.service.ts");
    const start = src.indexOf("async createSale(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n  async ", start + 1)).replace(/\/\/.*$/gm, ""); // comments only name the rule
    expect(body).toMatch(/markSaleDelivered\(this\.prisma, order\.id,/);
    expect(body).not.toMatch(/deliveredQty/); // the stamp lives in delivered-stamp.ts, not inline
    const stamp = read("../delivered-stamp.ts");
    expect(stamp).toMatch(
      /export async function markSaleDelivered[\s\S]*?status: OrderStatus\.DELIVERED, deliveredAt[\s\S]*?stampDeliveredInFull\(tx, orderId, "entry"\)/,
    );
  });

  it("the void resets the hand-over under the order lock, after the tender voids and BEFORE the cancel unwind", () => {
    const svc = read("counter-sale-void.service.ts");
    const at = (needle: string) => svc.indexOf(needle);
    expect(svc.match(/clearUnevidencedDelivered\(tx, orderId\)/g)).toHaveLength(1);
    expect(at("lockOrderAndInvoicesInTx(tx, orderId)")).toBeLessThan(
      at("clearUnevidencedDelivered(tx, orderId)"),
    );
    expect(at("this.invoices.voidPaymentInTx(")).toBeLessThan(
      at("clearUnevidencedDelivered(tx, orderId)"),
    );
    expect(at("clearUnevidencedDelivered(tx, orderId)")).toBeLessThan(
      at("this.orders.cancelOrderInTx("),
    );
  });

  it("the units still booked out are read BEFORE the reset and handed to the cancel as its bookedFloor (SA-763r)", () => {
    const svc = read("counter-sale-void.service.ts");
    const at = (needle: string) => svc.indexOf(needle);
    expect(at("unevidencedDeliveredFloor(tx, orderId)")).toBeGreaterThan(-1);
    expect(at("unevidencedDeliveredFloor(tx, orderId)")).toBeLessThan(
      at("clearUnevidencedDelivered(tx, orderId)"),
    );
    expect(svc).toMatch(/notes: "CANCEL",\s*bookedFloor,/);
  });

  it("the reset leaves evidence alone: it asks the delivery-evidence reader which lines have a qualifying row", () => {
    const src = read("../delivered-stamp.ts");
    expect(src).toMatch(/deliveredBasisByLine\(tx, orderId\)/);
    expect(src).toMatch(/!hasDeliveryEvidence\(basis, id\)/);
  });

  it("only the counter-sale void imports clearUnevidencedDelivered (the office cancel and the demotion keep the stamp)", () => {
    const SRC = join(__dirname, "..", "..");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (p.endsWith(".ts") && !p.endsWith(".spec.ts")) out.push(p);
      }
      return out;
    };
    const users = walk(SRC)
      .filter((p) => /clearUnevidencedDelivered/.test(readFileSync(p, "utf8")))
      .map((p) => p.slice(SRC.length + 1))
      .sort();
    expect(users).toEqual([
      "orders/counter-sale/counter-sale-void.service.ts",
      "orders/delivered-stamp.ts",
    ]);
  });
});
