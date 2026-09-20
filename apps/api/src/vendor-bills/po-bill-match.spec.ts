import { ConflictException } from "@nestjs/common";
import { assertBillWithinPo, findPoMatchViolations } from "./po-bill-match";

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
const reasons = (v: { reason: string }[]) => v.map((x) => x.reason).sort();

describe("findPoMatchViolations — the bill-vs-PO hard gate (units/PO step 7)", () => {
  it("passes a bill that matches the PO exactly (equal qty and price are NOT an overrun)", () => {
    expect(findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 24, 2.5)])).toEqual([]);
  });

  it("passes a bill for LESS than the PO (a partial invoice is legitimate)", () => {
    expect(findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 10, 2)])).toEqual([]);
  });

  it("blocks more pieces than ordered — the quantity AND the whole-bill money", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 25, 2.5)]);
    expect(reasons(v)).toEqual(["QTY_EXCEEDS_PO", "TOTAL_EXCEEDS_PO"]);
    expect(v.find((x) => x.reason === "QTY_EXCEEDS_PO")).toMatchObject({
      productId: "p1",
      billed: "25",
      allowed: "24",
    });
    expect(v.find((x) => x.reason === "TOTAL_EXCEEDS_PO")).toMatchObject({
      billed: "62.5",
      allowed: "60",
    });
  });

  it("sums a product billed on several lines before comparing to what was ordered", () => {
    const v = findPoMatchViolations(
      [po("p1", 24, 2.5)],
      [bill("p1", 12, 2.5), bill("p1", 13, 2.5)],
    );
    expect(reasons(v)).toEqual(["QTY_EXCEEDS_PO", "TOTAL_EXCEEDS_PO"]);
    expect(v.find((x) => x.reason === "QTY_EXCEEDS_PO")!.billed).toBe("25");
  });

  it("sums a product ordered on several PO lines", () => {
    expect(
      findPoMatchViolations([po("p1", 10, 2.5), po("p1", 14, 2.5)], [bill("p1", 24, 2.5)]),
    ).toEqual([]);
  });

  it("blocks a per-piece price above the PO's", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p1", 24, 2.6)]);
    expect(reasons(v)).toEqual(["PRICE_EXCEEDS_PO", "TOTAL_EXCEEDS_PO"]);
    expect(v.find((x) => x.reason === "PRICE_EXCEEDS_PO")).toMatchObject({
      billed: "2.6",
      allowed: "2.5",
    });
  });

  it("tolerates a cent of entry rounding per line — a 3-pack billed at 10.00 against a 3.33/pc PO passes", () => {
    // 3 pcs @ 3.33 = 9.99 on the PO; the supplier bills one 3-pack at 10.00 = 3.3333/pc
    expect(findPoMatchViolations([po("p1", 3, 3.33)], [bill("p1", 3, 3.3333)])).toEqual([]);
    // exactly one cent over is still rounding …
    expect(findPoMatchViolations([po("p1", 1, 2.5)], [bill("p1", 1, 2.51)])).toEqual([]);
    // … two cents is not
    expect(reasons(findPoMatchViolations([po("p1", 1, 2.5)], [bill("p1", 1, 2.52)]))).toEqual([
      "PRICE_EXCEEDS_PO",
      "TOTAL_EXCEEDS_PO",
    ]);
  });

  it("a mixed-cost PO can't have its cheap lines billed at its dear price (whole-bill money)", () => {
    // PO: 5 @ $2 + 5 @ $3 = $25. The old per-product max-cost check let 10 @ $3 = $30 through.
    const poLines = [po("p1", 5, 2), po("p1", 5, 3)];
    expect(findPoMatchViolations(poLines, [bill("p1", 5, 2), bill("p1", 5, 3)])).toEqual([]);
    const v = findPoMatchViolations(poLines, [bill("p1", 10, 3)]);
    expect(reasons(v)).toEqual(["TOTAL_EXCEEDS_PO"]);
    expect(v[0]).toMatchObject({ billed: "30", allowed: "25" });
  });

  it("closes the review's hole: 20 pcs at the dear line's price on a 10 @ $10 + 10 @ $1 PO", () => {
    const v = findPoMatchViolations([po("p1", 10, 10), po("p1", 10, 1)], [bill("p1", 20, 10)]);
    expect(reasons(v)).toEqual(["TOTAL_EXCEEDS_PO"]);
    expect(v[0]).toMatchObject({ billed: "200", allowed: "110" });
  });

  it("blocks a mapped line whose product is not on the PO", () => {
    const v = findPoMatchViolations([po("p1", 24, 2.5)], [bill("p2", 1, 1, "Gadget")]);
    expect(v).toEqual([
      { reason: "NOT_ON_PO", productId: "p2", description: "Gadget", billed: "1", allowed: "" },
    ]);
  });

  it("blocks an UNMAPPED line — money the PO never authorised (the review's freight/qty-100 exploit)", () => {
    const v = findPoMatchViolations(
      [po("p1", 24, 2.5)],
      [bill("p1", 24, 2.5), bill(null, 100, 50, "Widget")],
    );
    expect(v).toEqual([
      {
        reason: "UNMAPPED_LINE",
        productId: "",
        description: "Widget",
        billed: "5000",
        allowed: "",
      },
    ]);
  });

  it("reports every violation, on different lines", () => {
    const v = findPoMatchViolations(
      [po("p1", 5, 2), po("p2", 5, 2)],
      [bill("p1", 9, 2, "A"), bill("p2", 5, 4, "B")],
    );
    expect(reasons(v)).toEqual(["PRICE_EXCEEDS_PO", "QTY_EXCEEDS_PO", "TOTAL_EXCEEDS_PO"]);
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
    expect(body.message).toMatch(/the bill totals 12, PO-2026-0001 authorised 10/);
    expect(body.message).toMatch(/Edit the purchase order to match the invoice first/);
    expect(body.violations).toHaveLength(2);
  });

  it("explains an unmapped line in operator terms", () => {
    let err: unknown;
    try {
      assertBillWithinPo("PO-2026-0001", [po("p1", 5, 2)], [bill(null, 1, 30, "Freight")]);
    } catch (e) {
      err = e;
    }
    const body = (err as ConflictException).getResponse() as Record<string, any>;
    expect(body.message).toMatch(/"Freight" isn't linked to a product on PO-2026-0001/);
    expect(body.message).toMatch(/freight and other charges belong on their own bill/);
  });
});
