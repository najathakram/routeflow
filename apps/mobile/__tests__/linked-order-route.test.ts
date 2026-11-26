import { readFileSync } from "fs";
import { join } from "path";
import { linkedOrderTarget } from "../lib/linked-order-route";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("linkedOrderTarget (B1443)", () => {
  it("routes an invoice with a linked order to that order's screen", () => {
    expect(linkedOrderTarget({ orderId: "o1", order: { orderNumber: "1001" } })).toEqual({
      id: "o1",
      label: "Order 1001",
      route: "/(operator)/orders/o1",
    });
  });

  it("routes a return by its order object when orderId is absent", () => {
    expect(linkedOrderTarget({ order: { id: "o2", orderNumber: "ORD-7" } })?.route).toBe(
      "/(operator)/orders/o2",
    );
  });

  it("falls back to the existing 'Open order' words without a number", () => {
    expect(linkedOrderTarget({ orderId: "o3", order: null })?.label).toBe("Open order");
    expect(linkedOrderTarget({ orderId: "o3", order: { orderNumber: "  " } })?.label).toBe(
      "Open order",
    );
  });

  it("returns null when nothing is linked", () => {
    expect(linkedOrderTarget(null)).toBeNull();
    expect(linkedOrderTarget({ orderId: null, order: null })).toBeNull();
    expect(linkedOrderTarget({ orderId: "" })).toBeNull();
  });
});

describe("staff screens that show a linked order call the helper (B1443)", () => {
  const invoice = read("app/(operator)/(tabs)/invoices/[id].tsx");
  const ret = read("app/(operator)/returns/[id].tsx");

  it("invoice detail uses linkedOrderTarget and no longer gates the order tile on a pending mirror", () => {
    expect(invoice).toContain("linkedOrderTarget(");
    expect(invoice).not.toContain("pendingMirror && invoice.orderId");
  });

  it("return detail uses linkedOrderTarget", () => {
    expect(ret).toContain("linkedOrderTarget(");
  });
});
