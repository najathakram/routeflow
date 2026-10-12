import { readFileSync } from "fs";
import { join } from "path";
import {
  buyerSavePlan,
  customLineCount,
  CUSTOM_LINES_NOTE,
  hydrateBuyerDraft,
  type BuyerOrderLineLike,
} from "../lib/buyer-edit-items";

// B889: a seller-added custom (unlisted) line has productId null and no product. The buyer
// draft was keyed on productId, so every custom line landed on key "null" (several collapsed into
// ONE row, the last one winning), was labelled "Product", and Save sent {productId: null} — which
// the server ignores (B51 preserves custom lines), so the buyer's edit silently did nothing
// (runtime repro #2554 5876190546). Web skips custom lines and says so; mobile now mirrors it.

const catalogLine = (over: Partial<BuyerOrderLineLike> = {}): BuyerOrderLineLike => ({
  id: "L1",
  productId: "p1",
  qty: 1,
  unitPrice: 3.49,
  status: "PENDING",
  product: { name: "Cleaner", unit: "bottle" },
  ...over,
});
const customLine = (over: Partial<BuyerOrderLineLike> = {}): BuyerOrderLineLike => ({
  id: "C1",
  productId: null,
  qty: 3,
  unitPrice: 5,
  status: "PENDING",
  product: null,
  ...over,
});

describe("B889: seller-added custom lines on the buyer edit-items screen", () => {
  const lines = [catalogLine(), customLine(), customLine({ id: "C2", qty: 2, unitPrice: 4 })];

  it("the draft skips custom lines: no 'null' key, no 'Product' row, no collapse", () => {
    const draft = hydrateBuyerDraft(lines);
    expect(Object.keys(draft)).toEqual(["L1"]);
    expect(Object.values(draft).map((d) => d.name)).toEqual(["Cleaner"]);
  });

  it("Save never sends a null productId — only the catalog lines ride the replace", () => {
    const plan = buyerSavePlan(lines, hydrateBuyerDraft(lines));
    expect(plan).toEqual({
      kind: "replace",
      items: [{ productId: "p1", qty: 1, orderItemId: "L1" }],
    });
  });

  it("a stray null-product draft entry is still dropped from Save (belt)", () => {
    const draft = {
      ...hydrateBuyerDraft(lines),
      null: { productId: null as unknown as string, name: "Product", qty: 9, unitPrice: 5 },
    };
    const plan = buyerSavePlan(lines, draft);
    expect(plan.kind).toBe("replace");
    if (plan.kind === "replace") expect(plan.items.every((i) => !!i.productId)).toBe(true);
  });

  // Lead fold (#2709): "custom" is productId null ONLY. A CATALOG line whose product relation is
  // missing (productId set, product null) must stay — the replace-by-product Save would otherwise
  // delete it.
  it("a catalog line with a missing product relation stays in the draft AND the Save plan", () => {
    const orphan = catalogLine({ id: "L9", productId: "p9", product: null, qty: 4 });
    const draft = hydrateBuyerDraft([catalogLine(), orphan]);
    expect(Object.keys(draft).sort()).toEqual(["L1", "L9"]);
    expect(buyerSavePlan([catalogLine(), orphan], draft)).toEqual({
      kind: "replace",
      items: [
        { productId: "p1", qty: 1, orderItemId: "L1" },
        { productId: "p9", qty: 4, orderItemId: "L9" },
      ],
    });
    expect(customLineCount([orphan])).toBe(0);
  });

  it("counts live custom lines for the note; a cancelled one does not count", () => {
    expect(customLineCount(lines)).toBe(2);
    expect(customLineCount([catalogLine(), customLine({ status: "CANCELLED" })])).toBe(0);
    expect(customLineCount([catalogLine()])).toBe(0);
  });

  it("the note is web's wording", () => {
    expect(CUSTOM_LINES_NOTE).toBe(
      "Custom items added by the seller aren't listed here — they stay on your order as they are.",
    );
  });

  // RN screens aren't renderable in this lane — the wiring is source-pinned.
  it("the screen shows the note when the order has a live custom line", () => {
    const src = readFileSync(
      join(__dirname, "..", "app/(customer)/orders/[id]/edit-items.tsx"),
      "utf8",
    );
    expect(src).toMatch(/customLineCount\(order\.lineItems\) > 0/);
    expect(src).toMatch(/\{CUSTOM_LINES_NOTE\}/);
  });
});
