import { regulatedContentChanged, type RegulatedLineContent } from "./regulated-content-change";

/** Row 683 (SA-789 F2): the comparison that decides whether a rebuild resyncs the regulated ledger. */
const line = (over: Partial<RegulatedLineContent> = {}): RegulatedLineContent => ({
  orderItemId: "ol-1",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  qty: 75,
  unitsPerBox: null,
  unitLabel: null,
  subtotal: 75,
  categoryTaxAmount: 0,
  ...over,
});

describe("regulatedContentChanged (683)", () => {
  it("the same regulated content (only the item ids rotated): unchanged", () => {
    expect(regulatedContentChanged([line()], [line()])).toBe(false);
  });

  it("decimal noise from the database (75 vs '75.000') is the same", () => {
    expect(regulatedContentChanged([line({ qty: "75.000", subtotal: "75.00" })], [line()])).toBe(
      false,
    );
  });

  it.each([
    ["qty", { qty: 50 }],
    ["category", { trackedCategoryId: "cat-2" }],
    ["subcategory", { trackedSubcategoryId: "sub-1" }],
    ["pack size", { unitsPerBox: 24 }],
    ["selling unit", { unitLabel: "Case" }],
    ["net", { subtotal: 70 }],
    ["category tax", { categoryTaxAmount: 1.5 }],
  ])("a %s change: changed", (_n, over) => {
    expect(regulatedContentChanged([line()], [line(over as Partial<RegulatedLineContent>)])).toBe(
      true,
    );
  });

  it("a regulated line added or removed: changed", () => {
    expect(regulatedContentChanged([line()], [line(), line({ orderItemId: "ol-2" })])).toBe(true);
    expect(regulatedContentChanged([line()], [])).toBe(true);
  });

  it("non-regulated lines never count (an NSF fee, a plain product)", () => {
    const plain = line({ trackedCategoryId: null, qty: 9 });
    expect(regulatedContentChanged([line(), plain], [line()])).toBe(false);
  });

  it("order does not matter", () => {
    const a = [line(), line({ orderItemId: "ol-2", qty: 3 })];
    expect(regulatedContentChanged(a, [...a].reverse())).toBe(false);
  });
});

it("a missing read on either side counts as no regulated lines, never a throw", () => {
  expect(regulatedContentChanged(undefined, [])).toBe(false);
  expect(regulatedContentChanged(null, [])).toBe(false);
  expect(regulatedContentChanged(undefined, [line()])).toBe(true);
});
