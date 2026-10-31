import type { CustomerLayerUnit } from "@routeflow/pricing";
import { resolveCounterPriceEdit } from "@/lib/counter-price-edit";
import { cartTotals } from "@/lib/counter-sale";
import { toSaleItem } from "./counter-sale-line-edit";
import { applyPriceEdit, priceEditLineOf } from "./counter-sale-price-edit";
import { repriceLines } from "./counter-sale-reprice";
import { addScannedProduct } from "./counter-sale-scan";

/**
 * SA-1068 (T1-T4, T6, T7): the till shows the price the server will book. A named customer's remembered price ABOVE list
 * (a sticky upsell) is what a plain scan lands at, as MANUAL; one at or under list, or none, leaves the tier price; a layer
 * row beats it. The request still carries no price for an unedited line (M8): the server stays the authority.
 */
const product = { id: "p-1", name: "Cola", unit: "each", pricePerUnit: "10", priceTier3: "8" };
const layer: CustomerLayerUnit[] = [
  { ref: "pack", label: null, price: 7, listPrice: 10, source: "customer", aboveList: false },
];
const scan = (tier: number, lay?: CustomerLayerUnit[], remembered?: number | null) =>
  addScannedProduct([], product, "CASE" as never, 2, tier, lay, remembered)[0];

describe("T1: a named customer with a remembered price above list", () => {
  it("a scan lands at the remembered price, MANUAL", () => {
    const l = scan(1, undefined, 15);
    expect(l.unitPrice).toBe(15);
    expect(l.priceType).toBe("MANUAL");
    expect(l.remembered).toBe(true);
    expect(l.listPrice).toBe(10);
  });
});

describe("T2: the request carries no price for that line", () => {
  it("toSaleItem has no unitPrice for an unedited remembered line", () => {
    const l = scan(1, undefined, 15);
    expect(toSaleItem(l)).toEqual({ productId: "p-1", qty: 2 });
  });
});

describe("T3: a remembered price at or below list is not an upsell", () => {
  it.each([9, 10, null, undefined])("remembered %s leaves the tier price", (remembered) => {
    const l = scan(1, undefined, remembered);
    expect(l.unitPrice).toBe(10);
    expect(l.priceType).toBe("STANDARD");
  });

  it("a premium tier price is the customer's normal price, not an upsell", () => {
    const l = scan(3, undefined, 8);
    expect(l.unitPrice).toBe(8);
    expect(l.priceType).toBe("SPECIAL");
  });
});

describe("T4: a layer row beats the remembered price", () => {
  it("the layer price stands", () => {
    const l = scan(1, layer, 15);
    expect(l.unitPrice).toBe(7);
    expect(l.priceType).not.toBe("MANUAL");
  });
});

describe("T6: a walk-in cart, the customer picked, then back to walk-in", () => {
  it("shows the remembered price for the customer and the tier price both ways", () => {
    const walkIn = scan(1);
    expect(walkIn.unitPrice).toBe(10);
    const named = repriceLines(
      [walkIn],
      () => 1,
      undefined,
      () => 15,
    );
    expect(named.lines[0]).toMatchObject({ unitPrice: 15, priceType: "MANUAL", remembered: true });
    expect(named.changed).toBe(1);
    const back = repriceLines(
      named.lines,
      () => 1,
      undefined,
      () => null,
    );
    expect(back.lines[0]).toMatchObject({ unitPrice: 10, priceType: "STANDARD" });
    expect(back.lines[0].remembered).toBeUndefined();
    expect(back.changed).toBe(1);
  });

  it("with no remembered lookup nothing moves", () => {
    const walkIn = scan(1);
    const r = repriceLines([walkIn], () => 1);
    expect(r.changed).toBe(0);
    expect(r.lines[0]).toEqual(walkIn);
  });

  it("a hand-typed price keeps its net while the struck 'was' figure follows the remembered price", () => {
    const walkIn = scan(1);
    const [typed] = applyPriceEdit([walkIn], walkIn.tempId, {
      mode: "set",
      value: 12,
      unitPrice: 12,
      override: true,
    });
    const r = repriceLines(
      [typed],
      () => 1,
      undefined,
      () => 15,
    );
    expect(r.lines[0]).toMatchObject({ unitPrice: 12, tierPrice: 15, priceEdited: true });
    expect(r.kept).toBe(1);
  });
});

describe("T7: the clerk types the tier price on a remembered line", () => {
  it("the override stays, the price is sent, and the screen total is the tier total", () => {
    const l = scan(1, undefined, 15);
    const edit = resolveCounterPriceEdit("set", 10, priceEditLineOf(l, 1));
    expect(edit).toMatchObject({ ok: true, override: true, unitPrice: 10 });
    const [typed] = applyPriceEdit([l], l.tempId, {
      mode: "set",
      value: 10,
      unitPrice: 10,
      override: true,
    });
    expect(typed).toMatchObject({ unitPrice: 10, tierPrice: 15, priceEdited: true });
    expect(toSaleItem(typed)).toEqual({ productId: "p-1", qty: 2, unitPrice: 10 });
    expect(cartTotals([typed], 0).subtotal).toBe(20);
  });
});
