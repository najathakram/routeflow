import { ConflictException } from "@nestjs/common";
import { assertBillWithinPo, findPoMatchViolations, PO_PRICE_EPSILON } from "./po-bill-match";

const po = (productId: string, qtyOrdered: number, unitCost: number) => ({
  productId,
  qtyOrdered,
  unitCost,
});
const bill = (productId: string | null, qty: number, unitCost: number, description = "Widget") => ({
  productId,
  description,
  qty,
  unitCost,
});

describe("findPoMatchViolations — the bill-vs-PO hard gate (units/PO step 7)", () => {
  it("passes a bill that matches the PO exactly (equal qty and price are NOT an overrun)", () => {
    expect(findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 24, 2.5)])).toEqual([]);
  });

  it("passes a bill for LESS than the PO (a partial invoice is legitimate)", () => {
    expect(findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 10, 2)])).toEqual([]);
  });

  it("blocks a line billed for more pieces than ordered", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 25, 2.5)]);
    expect(v).toEqual([
      {
        reason: "QTY_EXCEEDS_PO",
        productId: "p1",
        description: "Widget",
        billed: "25",
        allowed: "24",
      },
    ]);
  });

  it("sums a product billed on several lines before comparing to what was ordered", () => {
    const v = findPoMatchViolations(
      [po("p1", 24, 2.5)],
      [bill("p1", 12, 2.5), bill("p1", 13, 2.5)],
    );
    expect(v.map((x) => x.reason)).toEqual(["QTY_EXCEEDS_PO"]);
    expect(v[0].billed).toBe("25");
  });

  it("sums a product ordered on several PO lines", () => {
    expect(
      findPoMatchViolations([po("p1", 10, 2.5), po("p1", 14, 2.5)], [bill("p1", 24, 2.5)]),
    ).toEqual([]);
  });

  it("blocks a per-piece price above the PO's", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 24, 2.6)]);
    expect(v).toEqual([
      {
        reason: "PRICE_EXCEEDS_PO",
        productId: "p1",
        description: "Widget",
        billed: "2.6",
        allowed: "2.5",
      },
    ]);
  });

  it("tolerates only 4dp rounding on price — one cent over is blocked", () => {
    expect(
      findPoMatchViolations([po("p1", 1, 2.5)], [bill("p1", 1, 2.5 + Number(PO_PRICE_EPSILON))]),
    ).toEqual([]);
    expect(findPoMatchViolations([po("p1", 1, 2.5)], [bill("p1", 1, 2.51)])).toHaveLength(1);
  });

  it("compares against the HIGHEST PO cost when a product is on several PO lines", () => {
    expect(findPoMatchViolations([po("p1", 5, 2), po("p1", 5, 3)], [bill("p1", 10, 3)])).toEqual(
      [],
    );
    expect(
      findPoMatchViolations([po("p1", 5, 2), po("p1", 5, 3)], [bill("p1", 10, 3.5)]),
    ).toHaveLength(1);
  });

  it("blocks a mapped line whose product is not on the PO", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p2", 1, 1, "Gadget")]);
    expect(v).toEqual([
      { reason: "NOT_ON_PO", productId: "p2", description: "Gadget", billed: "1", allowed: "" },
    ]);
  });

  it("ignores unmapped lines (no productId) — they move no stock and can't be matched", () => {
    expect(
      findPoMatchViolations(
        [po("p1", 24, 2.5)],
        [bill("p1", 24, 2.5), bill(null, 99, 99, "Freight")],
      ),
    ).toEqual([]);
  });

  it("reports every violation, qty and price on different lines", () => {
    const v = findPoMatchViolations(
      [po("p1", 5, 2), po("p2", 5, 2)],
      [bill("p1", 9, 2, "A"), bill("p2", 5, 4, "B")],
    );
    expect(v.map((x) => `${x.reason}:${x.productId}`).sort()).toEqual([
      "PRICE_EXCEEDS_PO:p2",
      "QTY_EXCEEDS_PO:p1",
    ]);
  });
});

describe("assertBillWithinPo", () => {
  it("is a no-op for a bill within the PO", () => {
    expect(() =>
      assertBillWithinPo("PO-2026-0001", [po("p1", 5, 2)], [bill("p1", 5, 2)]),
    ).not.toThrow();
  });

  it("throws a 409 BILL_EXCEEDS_PO naming the PO, the line and what to do", () => {
    let err: unknown;
    try {
      assertBillWithinPo("PO-2026-0001", [po("p1", 5, 2)], [bill("p1", 6, 2, "Flour 25lb")]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConflictException);
    const body = (err as ConflictException).getResponse() as Record<string, any>;
    expect(body.code).toBe("BILL_EXCEEDS_PO");
    expect(body.poNumber).toBe("PO-2026-0001");
    expect(body.message).toMatch(/PO-2026-0001/);
    expect(body.message).toMatch(/"Flour 25lb": billed 6 pcs, PO-2026-0001 allows 5/);
    expect(body.message).toMatch(/Edit the purchase order to match the invoice first/);
    expect(body.violations).toHaveLength(1);
  });
});
