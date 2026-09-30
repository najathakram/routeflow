import {
  buildUpdateItems,
  emptyEditLine,
  explainEditError,
  isEditable,
  isReceived,
  linesChanged,
  toEditLine,
  validateEditLines,
} from "./purchase-orders-edit";
import type { POItem } from "./purchase-orders-shared";

const item = (o: Partial<POItem> = {}): POItem => ({
  id: "i1",
  productId: "p1",
  qtyOrdered: "10",
  qtyReceived: "0",
  unitCost: "3",
  sku: null,
  packSize: null,
  ...o,
});
const upb = (map: Record<string, number>) => (id: string) => map[id] ?? 0;

describe("toEditLine", () => {
  // B699: a stored packSize > 1 means the line is PER CASE (update-purchase-order.dto.ts), so a per-piece
  // line is one with no stored pack; the stored-pack case is pinned in purchase-orders-stored-pack-b699.test.ts.
  it("passes a per-piece line (no stored pack) through, carrying id / received / sku / packSize", () => {
    const l = toEditLine(item({ qtyReceived: "4", sku: "W-1", packSize: null }), 0);
    expect(l).toMatchObject({
      id: "i1",
      productId: "p1",
      qty: "10",
      unitCost: "3",
      boxes: "",
      pieces: "",
      received: 4,
      sku: "W-1",
      packSize: null,
    });
  });

  it("shows a boxed line as Boxes + Pieces and a Cost-per-Box", () => {
    // 27 pcs of a 12/box product @ $2/pc → 2 boxes + 3 pcs, $24 a box
    const l = toEditLine(item({ qtyOrdered: "27", unitCost: "2" }), 12);
    expect(l).toMatchObject({ qty: "", boxes: "2", pieces: "3", unitCost: "24" });
  });
});

describe("round trip: an unedited line is not an edit", () => {
  it.each([
    ["non-boxed", item({ qtyOrdered: "10.5", unitCost: "3.25" }), 0],
    ["boxed, clean cost", item({ qtyOrdered: "27", unitCost: "2" }), 12],
    // 5 per box ÷ 3 = 1.6667/pc: multiplying back must land on the same stored cost
    ["boxed, awkward cost", item({ qtyOrdered: "30", unitCost: "1.6667" }), 3],
  ])("%s", (_name, it, perBox) => {
    const po = { items: [it] };
    const built = buildUpdateItems([toEditLine(it, perBox)], () => perBox);
    expect(linesChanged(po, built)).toBe(false);
    if (perBox > 1) {
      // a boxed line goes as the ENTERED case figures; the server derives pieces and per-piece cost
      expect((built[0].cases ?? 0) * perBox + (built[0].loosePieces ?? 0)).toBe(
        Number(it.qtyOrdered),
      );
      expect(built[0].packSize).toBe(perBox);
      expect(built[0].caseCost).toBeCloseTo(Number(it.unitCost) * perBox, 4);
      expect(built[0]).not.toHaveProperty("qtyOrdered");
      expect(built[0]).not.toHaveProperty("unitCost");
    } else {
      expect(built[0].qtyOrdered).toBeCloseTo(Number(it.qtyOrdered), 6);
      expect(built[0].unitCost).toBeCloseTo(Number(it.unitCost), 4);
    }
  });
});

describe("validateEditLines", () => {
  const p = upb({ p1: 0, p2: 12 });

  it("needs at least one line", () => {
    expect(validateEditLines([], p)).toMatch(/at least one line/);
    expect(validateEditLines([emptyEditLine()], p)).toMatch(/at least one line/);
  });

  it("needs a product, a positive quantity and a cost", () => {
    expect(validateEditLines([{ ...emptyEditLine(), id: "i1", received: 0 }], p)).toMatch(
      /Choose a product/,
    );
    expect(validateEditLines([{ ...emptyEditLine(), productId: "p1", unitCost: "1" }], p)).toMatch(
      /quantity above zero/,
    );
    expect(validateEditLines([{ ...emptyEditLine(), productId: "p1", qty: "2" }], p)).toBeNull(); // cost blank = 0 is allowed
    expect(
      validateEditLines([{ ...emptyEditLine(), productId: "p1", qty: "2", unitCost: "-1" }], p),
    ).toMatch(/valid cost/);
  });

  it("refuses a received line below what was received — the message names the return", () => {
    const line = { ...toEditLine(item({ qtyReceived: "8" }), 0), qty: "7" };
    const msg = validateEditLines([line], p);
    expect(msg).toMatch(/can't go below what was already received \(8\)/);
    expect(msg).toMatch(/recording a return/);
  });

  it("allows raising a received line and adding a new one", () => {
    const raised = { ...toEditLine(item({ qtyReceived: "8" }), 0), qty: "20" };
    const fresh = { ...emptyEditLine(), productId: "p2", boxes: "1", pieces: "0", unitCost: "24" };
    expect(validateEditLines([raised, fresh], p)).toBeNull();
  });

  it("compares a boxed line in PIECES (boxes × per-box + pieces)", () => {
    // received 27 pcs; 2 boxes + 2 pcs = 26 pcs is below it
    const line = {
      ...toEditLine(item({ qtyOrdered: "27", qtyReceived: "27", unitCost: "2" }), 12),
      pieces: "2",
    };
    expect(validateEditLines([{ ...line, productId: "p2" }], p)).toMatch(
      /below what was already received/,
    );
    // and the untouched boxed line (27 pcs) is fine
    expect(validateEditLines([{ ...line, productId: "p2", pieces: "3" }], p)).toBeNull();
  });
});

describe("buildUpdateItems", () => {
  const p = upb({ p1: 0, p2: 12 });

  it("keeps id / sku / packSize on existing lines, none on new ones, and drops blank rows", () => {
    const existing = toEditLine(item({ sku: "W-1", packSize: null }), 0);
    const fresh = { ...emptyEditLine(), productId: "p2", boxes: "2", pieces: "3", unitCost: "24" };
    const out = buildUpdateItems([existing, fresh, emptyEditLine()], p);
    expect(out).toEqual([
      { id: "i1", productId: "p1", qtyOrdered: 10, unitCost: 3, sku: "W-1", packSize: null },
      // a boxed line: the ENTERED case figures (the server computes pieces, per-piece cost and the total)
      { productId: "p2", packSize: 12, caseCost: 24, cases: 2, loosePieces: 3 },
    ]);
  });
});

// PO line money: 1,000 boxes of 12 entered at $11.00 a box total exactly $11,000.00. The old per-piece route
// stored 0.9167 a piece and totalled $11,000.40; the edit form read 11.0004 back.
describe("exact case cost (PO line money)", () => {
  const p = upb({ p1: 0, p2: 12 });
  const stored = item({
    id: "i1",
    productId: "p2",
    qtyOrdered: "12000",
    qtyReceived: "0",
    unitCost: "0.9167",
    totalCost: "11000.40",
  });

  it("shows a STORED row's honest derived case cost, unmasked: 0.9167 x 12 = 11.0004", () => {
    expect(toEditLine(stored, 12)).toMatchObject({
      boxes: "1000",
      pieces: "0",
      unitCost: "11.0004",
    });
  });

  it("a NEW exact row (1,000 cases stored at $11,000.00) reads back 11, and saving it unchanged is not an edit", () => {
    const exact = item({ ...stored, totalCost: "11000.00" });
    const line = toEditLine(exact, 12);
    expect(line).toMatchObject({ boxes: "1000", pieces: "0", unitCost: "11" });
    expect(linesChanged({ items: [exact] }, buildUpdateItems([line], p))).toBe(false);
  });

  it("an unchanged stored row is NOT an edit (rows are read as stored, never rewritten)", () => {
    const built = buildUpdateItems([toEditLine(stored, 12)], p);
    expect(linesChanged({ items: [stored] }, built)).toBe(false);
  });

  it("re-entering the case cost as 11.00 IS an edit: the quantity and 4 dp cost match but the total moves 11,000.40 -> 11,000.00", () => {
    const built = buildUpdateItems([{ ...toEditLine(stored, 12), unitCost: "11" }], p);
    expect(built[0]).toEqual({
      id: "i1",
      productId: "p2",
      packSize: 12,
      caseCost: 11,
      cases: 1000,
      loosePieces: 0,
      sku: null,
    });
    expect(linesChanged({ items: [stored] }, built)).toBe(true);
  });

  it("the save payload carries no client total or per-piece figure for a boxed line", () => {
    const built = buildUpdateItems([{ ...toEditLine(stored, 12), unitCost: "11" }], p);
    for (const k of ["qtyOrdered", "unitCost", "totalCost"]) expect(built[0]).not.toHaveProperty(k);
  });
});

describe("linesChanged", () => {
  const po = {
    items: [
      item({ qtyOrdered: "10", unitCost: "3" }),
      item({ id: "i2", productId: "p2", qtyOrdered: "5", unitCost: "2" }),
    ],
  };
  const same = () => [
    { id: "i1", productId: "p1", qtyOrdered: 10, unitCost: 3 },
    { id: "i2", productId: "p2", qtyOrdered: 5, unitCost: 2 },
  ];

  it("false when nothing moved", () => expect(linesChanged(po, same())).toBe(false));
  it("true on a quantity change", () => {
    const x = same();
    x[0].qtyOrdered = 11;
    expect(linesChanged(po, x)).toBe(true);
  });
  it("true on a cost change", () => {
    const x = same();
    x[1].unitCost = 2.5;
    expect(linesChanged(po, x)).toBe(true);
  });
  it("true on an added line, a removed line, or a re-pointed product", () => {
    expect(linesChanged(po, [...same(), { productId: "p1", qtyOrdered: 1, unitCost: 1 }])).toBe(
      true,
    );
    expect(linesChanged(po, same().slice(0, 1))).toBe(true);
    const x = same();
    x[0].productId = "p2";
    expect(linesChanged(po, x)).toBe(true);
  });
});

describe("status helpers", () => {
  it("isReceived is PARTIAL/RECEIVED only", () => {
    expect(
      ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"].map((s) =>
        isReceived({ status: s as never }),
      ),
    ).toEqual([false, false, true, true, false]);
  });
  it("isEditable is everything but CLOSED", () => {
    expect(
      ["DRAFT", "SENT", "PARTIAL", "RECEIVED", "CLOSED"].map((s) =>
        isEditable({ status: s as never }),
      ),
    ).toEqual([true, true, true, true, false]);
  });
});

describe("explainEditError", () => {
  it("turns PO_LOT_PARTIALLY_CONSUMED into operator words that point at 'Keep stock as is'", () => {
    const msg = explainEditError({
      response: { data: { code: "PO_LOT_PARTIALLY_CONSUMED", message: "x" } },
    });
    expect(msg).toMatch(/already been sold or used/);
    expect(msg).toMatch(/Keep stock as is/);
  });
  it("joins a class-validator message array into one sentence", () => {
    expect(
      explainEditError({ response: { data: { message: ["a must be x", "b must be y"] } } }),
    ).toBe("a must be x; b must be y");
  });
  it("otherwise shows the server's own message, and null when there is none", () => {
    expect(
      explainEditError({ response: { data: { message: "Cannot edit a closed purchase order" } } }),
    ).toBe("Cannot edit a closed purchase order");
    expect(explainEditError(new Error("boom"))).toBeNull();
  });
});

describe("DTO bounds mirrored client-side", () => {
  const p = (id: string) => (id === "p2" ? 12 : 0);
  const line = (o: Record<string, unknown> = {}) => ({
    ...emptyEditLine(),
    productId: "p1",
    qty: "5",
    unitCost: "1",
    ...o,
  });

  it("caps a purchase order at 200 lines", () => {
    const many = Array.from({ length: 201 }, () => line());
    expect(validateEditLines(many, p)).toMatch(/at most 200 lines/);
    expect(validateEditLines(many.slice(0, 200), p)).toBeNull();
  });

  it("enforces the quantity and cost ranges", () => {
    expect(validateEditLines([line({ qty: "0.0004" })], p)).toMatch(/at least 0.001/);
    expect(validateEditLines([line({ qty: "0.001" })], p)).toBeNull();
    expect(validateEditLines([line({ qty: "9999999" })], p)).toBeNull();
    expect(validateEditLines([line({ qty: "10000000" })], p)).toMatch(/9,999,999/);
    expect(validateEditLines([line({ unitCost: "999999" })], p)).toBeNull();
    expect(validateEditLines([line({ unitCost: "1000000" })], p)).toMatch(/999,999/);
  });

  it("buildUpdateItems rounds to the stored precision (3dp qty, 4dp cost)", () => {
    const out = buildUpdateItems([line({ qty: "1.23456", unitCost: "2.999999" })], p);
    expect(out[0]).toMatchObject({ qtyOrdered: 1.235, unitCost: 3 });
  });
});
