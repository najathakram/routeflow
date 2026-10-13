import { PriceType } from "@prisma/client";
import type { LadderUnit } from "@routeflow/pricing";
import { buildInvoiceUnitLine } from "../invoices/invoice-unit-line";
import { resolveLineUnits } from "../products/line-units";
import { buildUnitLine, categoryTaxForLine } from "./unit-line-build";

/**
 * H3 parity — POST /orders/sell (buildUnitLine) and POST /invoices (buildInvoiceUnitLine) must
 * store the same price and line total for the same typed input. Case list $24 / tier-3 $20, x3:
 * the operator types $24 (the list price) with a reason. Before H3 the order path billed the TIER
 * price ($60, SPECIAL) while the manual invoice billed the typed $72. The invoice path takes the
 * typed price verbatim (it has no tier concept and no reason column), so the order path now has to
 * honour the same typed price. DB twin: unit-line-price-parity.db.spec.ts.
 */
const product = {
  name: "Widget",
  unit: "Box",
  unitsPerBox: 24,
  pricePerUnit: "1.00",
  priceTier3: "0.8333",
};
const units: LadderUnit[] = [
  {
    label: "Case",
    factorToBase: 288,
    price: "24.00",
    priceTier2: null,
    priceTier3: "20.00",
    priceTier4: null,
    priceTier5: null,
  },
];
const resolved = resolveLineUnits(product, units, { unitLabel: "Case" });
const noTax = (qty: number, subtotal: number) => categoryTaxForLine(null, qty, subtotal);

function bothPaths(typed: number, reason?: string) {
  const order = buildUnitLine({
    product,
    units,
    resolved,
    item: { productId: "p1", qty: 3, unitLabel: "Case", unitPrice: typed, overrideReason: reason },
    tier: 3,
    taxFor: noTax,
    position: 0,
    tenantId: "t1",
    overriddenBy: "staff-1",
  });
  const invoice = buildInvoiceUnitLine({
    item: { description: "Widget", productId: "p1", qty: 3, unitPrice: typed, unitLabel: "Case" },
    product: {},
    resolved,
    category: null,
    tenantId: "t1",
  });
  return { order, invoice };
}

describe("H3 — /orders/sell and /invoices store the same unit-line price for the same input", () => {
  const shape = (l: {
    unitPrice: number;
    subtotal: number;
    qty: number;
    boxes: number | null;
    pieces: number | null;
    unitsPerBox: number | null;
    unitLabel: string | null;
  }) => ({
    unitPrice: l.unitPrice,
    subtotal: l.subtotal,
    qty: l.qty,
    boxes: l.boxes,
    pieces: l.pieces,
    unitsPerBox: l.unitsPerBox,
    unitLabel: l.unitLabel,
  });

  it("typed $24 (list) with a reason: both store $24 and a $72 total", () => {
    const { order, invoice } = bothPaths(24, "agreed at list");
    expect(shape(order)).toEqual(shape(invoice));
    expect(order).toMatchObject({
      unitPrice: 24,
      subtotal: 72,
      priceType: PriceType.MANUAL,
      overrideReason: "agreed at list",
      overriddenBy: "staff-1",
    });
  });

  it("typed $18 (below the tier) with a reason: both store $18 and a $54 total", () => {
    const { order, invoice } = bothPaths(18, "damaged cartons");
    expect(shape(order)).toEqual(shape(invoice));
    expect(order.subtotal).toBe(54);
  });

  it("typed $20 (the tier price): both store $20 and a $60 total, the order line is not an override", () => {
    const { order, invoice } = bothPaths(20);
    expect(shape(order)).toEqual(shape(invoice));
    expect(order).toMatchObject({ unitPrice: 20, subtotal: 60, priceType: PriceType.SPECIAL });
    expect(order).not.toHaveProperty("overriddenBy");
  });
});
