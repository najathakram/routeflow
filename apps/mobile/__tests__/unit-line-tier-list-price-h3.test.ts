import type { ProductUnitLevel } from "@routeflow/types";
import type { LadderProduct } from "@routeflow/pricing";
import { computeInvoiceTotals } from "../lib/invoice-totals";
import { buildUnitOptions } from "../lib/unit-options";
import {
  chooseInvoiceUnit,
  invoiceTotalsLine,
  saleItemDto,
  type InvoiceLineState,
} from "../lib/invoice-unit-pick";

jest.mock("../lib/toast", () => ({ showToast: jest.fn() }));

/**
 * H3 pin — a tier-3 customer's Case: list $24 / tier $20, x3. The operator types $24 (the LIST
 * price) with a reason. The preview total must be $72, and the POST /orders/sell item carries
 * unitPrice 24 + the reason, which the server now bills as $24 x 3 = $72 (it used to bill the tier
 * price, $60, with no reason). Typing the tier price sends no price at all (not an override).
 */
const PRODUCT: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "48.00" };
const CASE = {
  id: "Case",
  label: "Case",
  factorToBase: 12,
  price: "24.00",
  priceTier2: null,
  priceTier3: "20.00",
  priceTier4: null,
  priceTier5: null,
  isDefaultSelling: false,
  sortOrder: 0,
} as ProductUnitLevel;

const caseOption = buildUnitOptions(PRODUCT, [CASE], 3).find((o) => o.value === "Case")!;
const BOX_LINE: InvoiceLineState = { qty: 24, boxes: 1, pieces: 0, sellBy: "case" };
const caseLine = (over: Partial<InvoiceLineState>): InvoiceLineState => ({
  ...chooseInvoiceUnit(BOX_LINE, caseOption, 24),
  qty: 3,
  ...over,
});
const previewTotal = (line: InvoiceLineState) =>
  computeInvoiceTotals({ lines: [invoiceTotalsLine(line, 24, 40, 0)] }).total;
const p = { id: "p1", unitsPerBox: 24 };
const ctx = { catalogPrice: 40, listPrice: 48, isSpecial: true };

describe("H3: a Case typed at the LIST price on a tier customer", () => {
  it("the ladder gives the Case a $20 tier price and a $24 list price", () => {
    expect(caseOption).toMatchObject({ price: 20, listPrice: 24 });
  });

  it("the preview total for typed $24 x 3 is $72 (the stored total), and the tier price previews $60", () => {
    expect(previewTotal(caseLine({ unitPrice: 24, overrideReason: "agreed at list" }))).toBe(72);
    expect(previewTotal(caseLine({}))).toBe(60);
  });

  it("the sale item sends unitPrice 24 with the reason; with no reason it is refused", () => {
    const typed = caseLine({ unitPrice: 24 });
    expect(saleItemDto(typed, p, ctx)).toEqual({ refused: true });
    expect(saleItemDto({ ...typed, overrideReason: " agreed at list " }, p, ctx)).toEqual({
      productId: "p1",
      qty: 3,
      unitLabel: "Case",
      unitPrice: 24,
      overrideReason: "agreed at list",
    });
  });

  it("typing the tier price back sends no price (the server bills the ladder, no override)", () => {
    const item = saleItemDto(caseLine({ unitPrice: 20 }), p, ctx);
    expect(item).toEqual({ productId: "p1", qty: 3, unitLabel: "Case" });
  });
});
