import { billLinesFromPO, billQuantitiesFromPO, lotUnitLabel } from "./po-bill-lines";
import { buildPOLine } from "./po-line";

const poLine = (
  o: Parameters<typeof buildPOLine>[0],
  extra: Record<string, unknown> = {},
): Parameters<typeof billLinesFromPO>[0][number] => ({
  productId: "p1",
  sku: "W-24",
  ...buildPOLine(o),
  ...extra,
});
const boxes = (cases: number, loosePieces = 0, caseCost = 5, packSize = 24) =>
  poLine({ packSize, caseCost, cases, loosePieces });

describe("billLinesFromPO (SA-1207 P2a)", () => {
  it("whole boxes become a case line at the PO's stored pack, in boxes", () => {
    expect(billLinesFromPO([boxes(5)])).toEqual([
      expect.objectContaining({
        productId: "p1",
        sku: "W-24",
        qty: 5,
        unitCost: 5,
        packSize: 24,
        unitLabel: null,
      }),
    ]);
  });

  it("5 boxes + 2 loose is ONE lot: qty 1, pack = the pieces, the stored total, a box/piece label", () => {
    expect(billLinesFromPO([boxes(5, 2)])).toEqual([
      expect.objectContaining({
        qty: 1,
        unitCost: 25.42,
        packSize: 122,
        unitLabel: "5 Boxes + 2 Pieces",
      }),
    ]);
  });

  it("loose pieces alone (fewer than a box) are a lot labelled in pieces", () => {
    const [l] = billLinesFromPO([boxes(0, 7)]);
    expect(l).toMatchObject({ qty: 1, packSize: 7, unitLabel: "7 Pieces" });
  });

  it("whole boxes whose case line would not reproduce the stored total exactly become a lot", () => {
    // 21 pcs at pack 7, total 25.00: 3 boxes x 8.3333 = 24.9999, not 25.00
    const line = poLine({ qtyOrdered: 21, unitCost: 1.1905 }, { packSize: 7, totalCost: 25 });
    const [l] = billLinesFromPO([line]);
    expect(l).toMatchObject({ qty: 1, unitCost: 25, packSize: 21 });
    expect(l.unitLabel).toBe("3 Boxes");
  });

  it("a piece line is qty x unitCost when that equals the stored total, else a lot", () => {
    expect(billLinesFromPO([poLine({ qtyOrdered: 12, unitCost: 3.33 })])).toEqual([
      expect.objectContaining({ qty: 12, unitCost: 3.33, packSize: null, unitLabel: null }),
    ]);
    // 302 x 1.6667 = 503.3434, the stored total is 503.34
    const [l] = billLinesFromPO([poLine({ qtyOrdered: 302, unitCost: 1.6667 })]);
    expect(l).toMatchObject({ qty: 1, unitCost: 503.34, packSize: 302, unitLabel: "302 Pieces" });
  });

  it("a partial quantity is pro rata on the stored total, never the live catalog pack", () => {
    const line = boxes(10); // 240 pcs, 50.00
    expect(billLinesFromPO([line], [120])[0]).toMatchObject({ qty: 5, unitCost: 5, packSize: 24 });
    expect(billLinesFromPO([line], [122])[0]).toMatchObject({
      qty: 1,
      unitCost: 25.42,
      packSize: 122,
    });
  });

  it("leaves out a line with nothing to bill", () => {
    expect(billLinesFromPO([boxes(5), boxes(3)], [0, 72])).toHaveLength(1);
  });

  it("a fractional piece quantity cannot be a lot (the pack is whole): it stays a piece line", () => {
    const [l] = billLinesFromPO([poLine({ qtyOrdered: 2.5, unitCost: 3.3333 })]);
    expect(l).toMatchObject({ qty: 2.5, unitCost: 3.3333, packSize: null, unitLabel: null });
  });

  it("starts from what was received, else what was ordered (a PO is never billed past what it ordered)", () => {
    const a = boxes(5);
    const b = boxes(3);
    expect(billQuantitiesFromPO([a, b])).toEqual([120, 72]);
    expect(
      billQuantitiesFromPO([
        { ...a, qtyReceived: 48 },
        { ...b, qtyReceived: 0 },
      ]),
    ).toEqual([48, 0]);
    expect(billQuantitiesFromPO([{ ...a, qtyReceived: 999 }])).toEqual([120]);
  });
});

describe("lotUnitLabel", () => {
  it("speaks in boxes and pieces only", () => {
    expect(lotUnitLabel(122, 24)).toBe("5 Boxes + 2 Pieces");
    expect(lotUnitLabel(25, 24)).toBe("1 Box + 1 Piece");
    expect(lotUnitLabel(1, null)).toBe("1 Piece");
    expect(lotUnitLabel(48, 24)).toBe("2 Boxes");
  });
});
