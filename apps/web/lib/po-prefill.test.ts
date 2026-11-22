import { buildPOLine } from "@routeflow/pricing";
import { billItemFromRow, prefillBillFromPO, type PoForPrefill } from "./po-prefill";

const item = (
  id: string | null,
  name: string,
  o: Parameters<typeof buildPOLine>[0],
  extra: Record<string, unknown> = {},
) =>
  ({
    id,
    productId: `p-${name}`,
    product: { id: `p-${name}`, name, unit: "Piece" },
    sku: null,
    qtyReceived: 0,
    ...buildPOLine(o),
    ...extra,
  }) as unknown as PoForPrefill["items"][number];

const po = (items: PoForPrefill["items"]): PoForPrefill => ({
  id: "po1",
  poNumber: "PO-1",
  supplier: { id: "s1" },
  items,
});

describe("prefillBillFromPO (SA-1207 P2b)", () => {
  it("fills the bill in the PO's own unit: boxes for a whole-box line, a lot for the rest", () => {
    const out = prefillBillFromPO(
      po([
        item("i1", "Water", { packSize: 24, caseCost: 5, cases: 5 }),
        item("i2", "Soda", { packSize: 24, caseCost: 5, cases: 5, loosePieces: 2 }),
      ]),
    );
    expect(out.supplierId).toBe("s1");
    expect(out.rows).toEqual([
      expect.objectContaining({
        description: "Water",
        qty: "5",
        unitCost: "5",
        packSize: 24,
        unit: "Box",
      }),
      expect.objectContaining({ description: "Soda", qty: "1", unitCost: "25.42", packSize: 122 }),
    ]);
    expect(out.rows[1].unitLabel).toBe("5 Boxes + 2 Pieces");
  });

  it("bills what arrived when anything did, and counts a line that received nothing", () => {
    const out = prefillBillFromPO(
      po([
        item("i1", "Water", { packSize: 24, caseCost: 5, cases: 5 }, { qtyReceived: 48 }),
        item("i2", "Soda", { packSize: 24, caseCost: 5, cases: 3 }, { qtyReceived: 0 }),
      ]),
    );
    expect(out.rows.map((r) => [r.description, r.qty])).toEqual([["Water", "2"]]);
    expect(out.zeroCount).toBe(1);
  });

  it("a fractional boxed line is listed by name, never billed", () => {
    const out = prefillBillFromPO(
      po([item("i1", "Water", { packSize: 12, caseCost: 6, cases: 2 }, { qtyOrdered: 24.5 })]),
    );
    expect(out.rows).toEqual([]);
    expect(out.byHand).toEqual(["Water"]);
  });

  it("every PO line is a row, listed or zero: NaN and fractional quantities are listed, a negative is nothing to bill", () => {
    const items = [
      item("i1", "A", { qtyOrdered: 4, unitCost: 2.5 }, { qtyReceived: 4 }),
      item("i2", "B", { qtyOrdered: 4, unitCost: 2.5 }, { qtyReceived: "n/a" }),
      item(
        null,
        "C",
        { packSize: 12, caseCost: 6, cases: 2 },
        { qtyOrdered: 24.5, qtyReceived: 24.5 },
      ),
      item(null, "D", { qtyOrdered: 4, unitCost: 2.5 }, { qtyReceived: -2 }),
      item("i5", "E", { qtyOrdered: 4, unitCost: 2.5 }, { qtyReceived: 0 }),
    ];
    const out = prefillBillFromPO(po(items));
    expect(out.rows.map((r) => r.description)).toEqual(["A"]);
    expect(out.byHand).toEqual(["B", "C"]);
    expect(out.zeroCount).toBe(2);
    expect(out.rows.length + out.byHand.length + out.zeroCount).toBe(items.length);
  });
});

describe("billItemFromRow", () => {
  it("sends the line's own unit: the pack and the lot label go with qty and unitCost, in numbers", () => {
    const row = {
      productId: "p1",
      description: " Soda ",
      unit: "Box",
      qty: "1",
      unitCost: "25.42",
      packSize: 122,
      unitLabel: "5 Boxes + 2 Pieces",
    };
    expect(billItemFromRow(row)).toEqual({
      productId: "p1",
      description: "Soda",
      qty: 1,
      unitCost: 25.42,
      packSize: 122,
      unitLabel: "5 Boxes + 2 Pieces",
    });
  });

  it("a hand-typed row stays as it was: no pack, no label", () => {
    const item = billItemFromRow({
      productId: "",
      description: "Freight",
      unit: "",
      qty: "1",
      unitCost: "9",
    });
    expect(item).toEqual({ description: "Freight", qty: 1, unitCost: 9, productId: undefined });
    expect("packSize" in item).toBe(false);
    expect("unitLabel" in item).toBe(false);
  });
});
