import type { UnitOption } from "@/lib/unit-options";
import { saleLineMovedOffSpecial, saleLineNeedsReason } from "@/lib/sale-line-pricing";
import { computeInvoiceLineTotal } from "@routeflow/pricing";
import {
  chooseUnit,
  saleUnitPriceField,
  type InvoiceUnitFields,
} from "./invoice-line-unit-adapter";

/**
 * H3 pin — a tier-3 customer's Case: list $24 / tier $20, x3. The operator types $24 (the LIST
 * price) with a reason. The New-sale preview must show $72, the POST /orders/sell item must carry
 * unitPrice 24 + the reason (the server now bills $24 x 3 = $72; it used to bill the tier price,
 * $60, with no reason), and typing the tier price back sends no price at all.
 */
const tier3 = () => 3;
const CASE: UnitOption = {
  value: "Case",
  label: "Case",
  factorToBase: 12,
  kind: "level",
  price: 20,
  listPrice: 24,
};
const packLine: InvoiceUnitFields = {
  key: "k1",
  productId: "p1",
  description: "Soda",
  qty: 24,
  boxes: 1,
  pieces: 0,
  unitsPerBox: 24,
  unitPrice: 40,
  unit: "Box",
  listPrice: 48,
  priceType: "SPECIAL",
  avgCost: 30,
  tierPrices: { pricePerUnit: "48" },
};
const caseLine = (over: Partial<InvoiceUnitFields>): InvoiceUnitFields => ({
  ...chooseUnit([packLine], "k1", CASE, false, tier3)[0],
  qty: 3,
  ...over,
});
const preview = (l: InvoiceUnitFields) =>
  computeInvoiceLineTotal({
    unitPrice: Number(l.unitPrice),
    qty: Number(l.qty),
    boxes: l.boxes ?? null,
    pieces: l.pieces ?? null,
    unitsPerBox: l.unitsPerBox ?? null,
    discount: 0,
  });

describe("H3: a Case typed at the LIST price on a tier customer (New sale)", () => {
  it("the picked Case line is judged against the $20 tier price (list $24), special tier", () => {
    expect(caseLine({}).pricing).toEqual({ tierPrice: 20, listPrice: 24, isSpecialTier: true });
  });

  it("typed $24 x 3 previews $72 (the stored total); the tier price previews $60", () => {
    expect(preview(caseLine({ unitPrice: 24 }))).toBe(72);
    expect(preview(caseLine({}))).toBe(60);
  });

  it("typed $24 sends unitPrice 24, needs a reason, and sends the reason once given", () => {
    const typed = caseLine({ unitPrice: 24 });
    expect(saleUnitPriceField(typed)).toEqual({ unitPrice: 24 });
    expect(saleLineMovedOffSpecial(typed)).toBe(true);
    expect(saleLineNeedsReason(typed)).toBe(true);
    expect(saleLineNeedsReason({ ...typed, overrideReason: "agreed at list" })).toBe(false);
  });

  it("typing the tier price back sends no price and needs no reason", () => {
    const tier = caseLine({ unitPrice: 20 });
    expect(saleUnitPriceField(tier)).toEqual({});
    expect(saleLineNeedsReason(tier)).toBe(false);
    expect(saleLineMovedOffSpecial(tier)).toBe(false);
  });
});
