import { computeLineSubtotal } from "@routeflow/pricing";
import {
  counterCartToDraftPayload,
  counterShipDraftInput,
  COUNTER_SHIP_FAILED_COPY,
  COUNTER_SHIP_WALK_IN_CAPTION,
} from "./counter-ship-handoff";
import type { SaleLine } from "@/app/(dashboard)/orders/_components/counter-sale-scan";

/**
 * B1210: the pure mapper behind "Ship this order instead". The counter cart + customer become the order
 * builder's parked-draft payload (OrderDraftPayload + fulfillPath), keeping the quantities and the price the
 * clerk SAW. Money is not re-derived here: the line carries unitPrice / boxes / pieces as they were rung.
 */

const CUSTOMER = { id: "c-1", businessName: "Acme Co", pricingTier: 3, email: "a@b.test" } as any;
const CASE_LINE: SaleLine = {
  tempId: "p-pack-0",
  productId: "p-pack",
  name: "Sample Cola 24pk",
  unitPrice: 27.5,
  qty: 30,
  unitsPerBox: 24,
  boxes: 1,
  pieces: 6,
  listPrice: 30,
  unit: "case",
  priceType: "SPECIAL",
};
const PLAIN_LINE: SaleLine = {
  tempId: "p-cola-1",
  productId: "p-cola",
  name: "Sample Chips",
  unitPrice: 2.5,
  qty: 4,
  listPrice: 2.5,
  unit: "each",
  priceType: "STANDARD",
};

describe("counterCartToDraftPayload", () => {
  it("keeps quantity, boxes/pieces, the tier unit price the clerk saw, list price, unit and price type", () => {
    const p = counterCartToDraftPayload([CASE_LINE, PLAIN_LINE], CUSTOMER);
    expect(p.lineItems).toHaveLength(2);
    expect(p.lineItems[0]).toMatchObject({
      productId: "p-pack",
      productName: "Sample Cola 24pk",
      unit: "case",
      listPrice: 30,
      unitPrice: 27.5,
      priceType: "SPECIAL",
      specialPrice: 27.5,
      qty: 30,
      unitsPerBox: 24,
      boxes: 1,
      pieces: 6,
    });
    expect(p.lineItems[1]).toMatchObject({
      productId: "p-cola",
      unit: "each",
      listPrice: 2.5,
      unitPrice: 2.5,
      priceType: "STANDARD",
      qty: 4,
    });
    expect(p.lineItems[1].specialPrice).toBeUndefined();
  });

  it("the parked lines price to exactly what the counter showed (boxed proration, no qty * price)", () => {
    const p = counterCartToDraftPayload([CASE_LINE], CUSTOMER);
    const li = p.lineItems[0];
    const parked = computeLineSubtotal({
      unitPrice: li.unitPrice,
      qty: li.qty,
      boxes: li.boxes ?? null,
      pieces: li.pieces ?? null,
      unitsPerBox: li.unitsPerBox ?? null,
    });
    const seen = computeLineSubtotal({
      unitPrice: CASE_LINE.unitPrice,
      qty: CASE_LINE.qty,
      boxes: CASE_LINE.boxes ?? null,
      pieces: CASE_LINE.pieces ?? null,
      unitsPerBox: CASE_LINE.unitsPerBox ?? null,
    });
    expect(parked).toBe(seen);
    expect(parked).not.toBe(27.5 * 30); // the over-charge a naive qty * price would make
  });

  it("gives every line a FRESH tempId (not the counter's, unique across lines)", () => {
    const p = counterCartToDraftPayload([CASE_LINE, PLAIN_LINE], CUSTOMER);
    const ids = p.lineItems.map((l) => l.tempId);
    expect(new Set(ids).size).toBe(2);
    expect(ids).not.toContain(CASE_LINE.tempId);
    expect(ids).not.toContain(PLAIN_LINE.tempId);
    const again = counterCartToDraftPayload([CASE_LINE, PLAIN_LINE], CUSTOMER);
    expect(again.lineItems.map((l) => l.tempId)).not.toEqual(ids);
  });

  it("maps the customer to {id, businessName, pricingTier} only, and sets fulfillPath SHIP", () => {
    const p = counterCartToDraftPayload([PLAIN_LINE], CUSTOMER);
    expect(p.customer).toEqual({ id: "c-1", businessName: "Acme Co", pricingTier: 3 });
    expect(p.fulfillPath).toBe("SHIP");
  });

  it("fills the builder's other payload fields with their empty defaults", () => {
    const p = counterCartToDraftPayload([PLAIN_LINE], CUSTOMER);
    expect(p).toMatchObject({
      orderDiscount: "",
      shippingFee: "",
      requestedDeliveryDate: "",
      orderDate: "",
      notes: "",
      urgent: false,
      floorAcked: [],
    });
  });

  it("a line held before the snapshot existed falls back to its own price and 'each'", () => {
    const old: SaleLine = {
      tempId: "x-0",
      productId: "x",
      name: "Old",
      unitPrice: 3,
      qty: 2,
    };
    const li = counterCartToDraftPayload([old], CUSTOMER).lineItems[0];
    expect(li).toMatchObject({ listPrice: 3, unit: "each", priceType: "STANDARD", unitPrice: 3 });
  });

  it("does not mutate its inputs", () => {
    const lines = [{ ...CASE_LINE }];
    const before = JSON.stringify(lines);
    counterCartToDraftPayload(lines, CUSTOMER);
    expect(JSON.stringify(lines)).toBe(before);
  });
});

describe("the parked draft carries no cost or margin data", () => {
  const keys = (v: unknown, out: string[] = []): string[] => {
    if (Array.isArray(v)) v.forEach((x) => keys(x, out));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        out.push(k);
        keys(x, out);
      }
    return out;
  };

  it("no key matching /cost|margin/i at any depth, even if the cart line carries one", () => {
    const withCost = { ...CASE_LINE, unitCost: 19.25, averageCost: 19.25 } as any;
    const payload = counterCartToDraftPayload([withCost, PLAIN_LINE], CUSTOMER);
    expect(keys(payload).filter((k) => /cost|margin/i.test(k))).toEqual([]);
    const dto = counterShipDraftInput([withCost], CUSTOMER);
    expect(keys(dto).filter((k) => /cost|margin/i.test(k))).toEqual([]);
  });
});

describe("counterShipDraftInput", () => {
  it("is an ORDER draft titled 'Order, <customer>' carrying the payload", () => {
    const dto = counterShipDraftInput([PLAIN_LINE], CUSTOMER);
    expect(dto).toMatchObject({
      kind: "ORDER",
      customerId: "c-1",
      customerName: "Acme Co",
      title: "Order, Acme Co",
    });
    expect((dto.payload as any).fulfillPath).toBe("SHIP");
    expect((dto.payload as any).lineItems).toHaveLength(1);
  });
});

describe("copy", () => {
  it("is the exact spec copy", () => {
    expect(COUNTER_SHIP_FAILED_COPY).toBe("Couldn't move this sale to shipping. Try again.");
    expect(COUNTER_SHIP_WALK_IN_CAPTION).toBe("Who are we shipping to? Find a customer.");
  });
});
