import { readFileSync } from "fs";
import { join } from "path";
import {
  buyerSavePlan,
  hydrateBuyerDraft,
  isBuyerUnitLine,
  readOnlyNotice,
  readOnlyQtyText,
  type BuyerOrderLineLike,
} from "../lib/buyer-edit-items";

// #2270: on the buyer edit-items screen a units_v1 Case line showed its stored BASE qty (48)
// beside "/ Case", and any save of that order returned 409 UNIT_AWARE_LINE. The server refuses
// every buyer edit of such an order (unit-aware-guard.ts + order-edit-payload.ts), so the screen
// shows the COUNT and is read-only for it. Fixtures are server-shaped: qty in base pieces.

const caseLine = (over: Partial<BuyerOrderLineLike> = {}): BuyerOrderLineLike => ({
  id: "L1",
  productId: "p1",
  qty: 48, // 4 Cases x 12
  boxes: 4,
  unitsPerBox: 12,
  unitLabel: "Case",
  unitPrice: 65,
  status: "PENDING",
  product: { name: "Case widget", unit: "box" },
  ...over,
});
const packLine = (over: Partial<BuyerOrderLineLike> = {}): BuyerOrderLineLike => ({
  id: "L2",
  productId: "p2",
  qty: 3,
  boxes: null,
  unitsPerBox: null,
  unitLabel: null,
  unitPrice: 5,
  status: "PENDING",
  product: { name: "Loose widget", unit: "ea" },
  ...over,
});

describe("hydrateBuyerDraft: a unit line shows its COUNT (#2270)", () => {
  it.each([
    ["boxes 4", caseLine(), 4],
    ["boxes 0 (stored anomaly), 48 = 4 x 12", caseLine({ boxes: 0 }), 4],
    ["boxes null", caseLine({ boxes: null }), 4],
  ])("%s => 4 Cases, never 48", (_n, li, expected) => {
    const d = hydrateBuyerDraft([li]);
    expect(d.L1.qty).toBe(expected);
    expect(d.L1.unitLabel).toBe("Case");
  });

  it("an underivable count keeps the stored qty WITHOUT the unit label (never '40 / Case')", () => {
    const d = hydrateBuyerDraft([caseLine({ qty: 40, boxes: 0 })]);
    expect(d.L1.qty).toBe(40);
    expect(d.L1.unitLabel).toBeNull();
  });

  it("a pack line is unchanged", () => {
    expect(hydrateBuyerDraft([packLine()]).L2).toMatchObject({ qty: 3, unitLabel: null });
  });
});

describe("readOnlyQtyText: a read-only row still SHOWS its quantity (#2316 review)", () => {
  it.each([
    ["4 Cases (boxes 4)", caseLine(), "4 Cases"],
    ["4 Cases (boxes 0, 48 = 4 x 12)", caseLine({ boxes: 0 }), "4 Cases"],
    ["1 Case", caseLine({ qty: 12, boxes: 1 }), "1 Case"],
    ["a LOCKED unit line reads 'locked', never 40", caseLine({ qty: 40, boxes: 0 }), "locked"],
    ["a pack line reads its qty + unit", packLine(), "3 ea"],
  ])("%s", (_n, li, expected) => {
    const d = hydrateBuyerDraft([li]);
    expect(readOnlyQtyText(d[li.id])).toBe(expected); // fixtures are catalog lines
  });
});

describe("a CANCELLED unit line (F2, #2316): never an editable row, never re-sent", () => {
  const lines = () => [caseLine({ status: "CANCELLED", qty: 24, boxes: 2 }), packLine()];

  it("pin (a): a CANCELLED Case line is never in the draft as an editable row", () => {
    const draft = hydrateBuyerDraft(lines());
    expect(draft.L1).toBeUndefined();
    expect(Object.keys(draft)).toEqual(["L2"]);
  });

  it("pin (b): a CANCELLED Case line is never in the save payload", () => {
    const plan = buyerSavePlan(lines(), hydrateBuyerDraft(lines()));
    expect(plan).toEqual({
      kind: "replace",
      items: [{ productId: "p2", qty: 3, orderItemId: "L2" }],
    });
    expect(JSON.stringify(plan)).not.toContain("p1");
  });
});

describe("a CANCELLED pack line is never re-sent either (F2, #2316)", () => {
  it("the cancelled pack line is skipped from the draft and the replace payload", () => {
    const lines = [
      packLine({ status: "CANCELLED", qty: 24 }),
      packLine({ id: "L3", productId: "p3", qty: 7 }),
    ];
    const draft = hydrateBuyerDraft(lines);
    expect(draft.L2).toBeUndefined();
    expect(buyerSavePlan(lines, draft)).toEqual({
      kind: "replace",
      items: [{ productId: "p3", qty: 7, orderItemId: "L3" }],
    });
  });
});

describe("buyerSavePlan (#2270)", () => {
  it("an order with a live unit line is read-only: refused locally with the notice, no payload", () => {
    const lines = [caseLine(), packLine()];
    const untouched = hydrateBuyerDraft(lines);
    const edited = { ...untouched, L2: { ...untouched.L2, qty: 5 } };
    for (const draft of [untouched, edited]) {
      expect(buyerSavePlan(lines, draft)).toEqual({
        kind: "refuse",
        message: readOnlyNotice("Case"),
      });
    }
  });

  it("a CANCELLED unit line doesn't lock the order (mirrors the server's isUnitAwareLine)", () => {
    expect(isBuyerUnitLine(caseLine({ status: "CANCELLED" }))).toBe(false);
    const lines = [caseLine({ status: "CANCELLED" }), packLine()];
    expect(buyerSavePlan(lines, hydrateBuyerDraft([packLine()]))).toEqual({
      kind: "replace",
      items: [{ productId: "p2", qty: 3, orderItemId: "L2" }],
    });
  });

  it("an order with no unit line keeps the replace-by-product payload exactly", () => {
    const lines = [packLine(), packLine({ id: "L3", productId: "p3", qty: 7 })];
    const draft = hydrateBuyerDraft(lines);
    draft.L2 = { ...draft.L2, qty: 9 };
    expect(buyerSavePlan(lines, draft)).toEqual({
      kind: "replace",
      items: [
        { productId: "p2", qty: 9, orderItemId: "L2" },
        { productId: "p3", qty: 7, orderItemId: "L3" },
      ],
    });
  });

  it("an emptied pack-only order still asks for at least one item", () => {
    expect(buyerSavePlan([packLine()], {})).toEqual({
      kind: "refuse",
      message: "Add at least one item.",
    });
  });
});

describe("buyer edit-items.tsx wiring pins (#2270)", () => {
  const src = readFileSync(join(__dirname, "../app/(customer)/orders/[id]/edit-items.tsx"), "utf8");

  it("hydrates through hydrateBuyerDraft and saves through buyerSavePlan", () => {
    expect(src).toMatch(/hydrateBuyerDraft\(order\.lineItems\)/);
    const saveAt = src.indexOf("const save = () => {");
    const planAt = src.indexOf("buyerSavePlan(", saveAt);
    const mutateAt = src.indexOf("updateMut.mutate(", saveAt);
    expect(planAt).toBeGreaterThan(saveAt);
    expect(planAt).toBeLessThan(mutateAt);
  });

  it("rebuilds the draft whenever the order's unit status changes (no stale count after a cancel)", () => {
    expect(src).toMatch(/const unitKey = order \? orderUnitLabel\(order\.lineItems\) : null;/);
    expect(src).toMatch(/\}, \[order\?\.id, unitKey\]\);/);
  });

  it("says read-only UP FRONT and hides the steppers, Add product and Save for a unit order", () => {
    expect(src).toMatch(/readOnlyNotice\(/);
    // #2316 review: the hidden stepper is REPLACED by the quantity text, never just removed.
    expect(src).toMatch(
      /\{readOnly \? \(\s*<Text style=\{styles\.qtyText\}>\{readOnlyQtyText\(item\)\}<\/Text>\s*\) : \(\s*<View style=\{styles\.qtyRow\}>/,
    );
    expect(src).toMatch(/\{readOnly \? null : \(\s*<Pressable style=\{styles\.addBtn\}/);
    expect(src).toMatch(/\{readOnly \? null : \(\s*<View style=\{styles\.footer\}>/);
  });
});

// B297 row 352 (SA-734r2 r-note 4): after a rate change one product can be two lines sold at different
// excise rates. The draft is keyed by the stored line, so neither row overwrites the other, and Save names
// each line — the server then keeps each at the rate it was sold at.
describe("two lines of one product stay two rows and Save names each (row 352)", () => {
  const twoLines = () => [
    packLine({ id: "L2", productId: "p2", qty: 12 }),
    packLine({ id: "L7", productId: "p2", qty: 8 }),
  ];

  it("hydrates both lines, neither collapsing the other", () => {
    const d = hydrateBuyerDraft(twoLines());
    expect(Object.keys(d).sort()).toEqual(["L2", "L7"]);
    expect([d.L2.qty, d.L7.qty]).toEqual([12, 8]);
  });

  it("Save sends one entry per line, each with its orderItemId", () => {
    const d = hydrateBuyerDraft(twoLines());
    d.L7 = { ...d.L7, qty: 3 };
    expect(buyerSavePlan(twoLines(), d)).toEqual({
      kind: "replace",
      items: [
        { productId: "p2", qty: 12, orderItemId: "L2" },
        { productId: "p2", qty: 3, orderItemId: "L7" },
      ],
    });
  });

  it("a catalog add carries no orderItemId (a new line)", () => {
    const d = {
      ...hydrateBuyerDraft([packLine()]),
      p9: { productId: "p9", name: "New", qty: 1, unitPrice: 2 },
    };
    expect(buyerSavePlan([packLine()], d)).toEqual({
      kind: "replace",
      items: [
        { productId: "p2", qty: 3, orderItemId: "L2" },
        { productId: "p9", qty: 1 },
      ],
    });
  });
});
