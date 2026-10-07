/**
 * #3168 packing slips: the pure page builder (the PDF template is mocked under Jest, so everything
 * the slip decides lives here) and a source pin that the template prints no money.
 */
import * as fs from "fs";
import * as path from "path";
import { FulfillPath, OrderStatus } from "@prisma/client";
import { buildPackingSlipPages, classifyForSlip } from "./packing-slip-data";

const seller = { businessName: "Acme Wholesale", addressLine1: "1 Main St", city: "Town" } as any;
const order = (over: any = {}) => ({
  id: "o1",
  orderNumber: "SO-1",
  status: OrderStatus.OUT_FOR_DELIVERY,
  fulfillPath: FulfillPath.SHIP,
  shippingCarrier: "UPS",
  shippingTrackingNumber: "1Z999",
  customer: {
    businessName: "Shop One",
    contactName: "Pat",
    addresses: [{ line1: "9 Elm", city: "Ville", state: "CA", zip: "90001", isDefault: true }],
  },
  items: [
    {
      id: "i1",
      name: "Widget",
      qty: 12,
      boxes: 2,
      pieces: 0,
      unitLabel: null,
      status: "PENDING",
      unitPrice: 5,
      subtotal: 60,
      product: null,
    },
    {
      id: "i2",
      name: "Gone",
      qty: 1,
      boxes: 0,
      pieces: 1,
      unitLabel: null,
      status: "CANCELLED",
      unitPrice: 9,
      subtotal: 9,
      product: null,
    },
    {
      id: "i3",
      name: "Cased",
      qty: 3,
      boxes: 3,
      pieces: 0,
      unitLabel: "Case",
      status: "PENDING",
      unitPrice: 7,
      subtotal: 21,
      product: null,
    },
  ],
  ...over,
});

describe("classifyForSlip", () => {
  it("SHIP + live -> null", () => expect(classifyForSlip(order())).toBeNull());
  it("non-SHIP -> NOT_CARRIER_ORDER", () =>
    expect(classifyForSlip(order({ fulfillPath: FulfillPath.ROUTE }))).toBe("NOT_CARRIER_ORDER"));
  it("cancelled -> NOT_CONFIRMED", () =>
    expect(classifyForSlip(order({ status: OrderStatus.CANCELLED }))).toBe("NOT_CONFIRMED"));
});

describe("buildPackingSlipPages", () => {
  it("one page per order, in order", () => {
    const pages = buildPackingSlipPages(
      [order(), order({ id: "o2", orderNumber: "SO-2" })],
      seller,
    );
    expect(pages.map((p) => p.orderNumber)).toEqual(["SO-1", "SO-2"]);
  });
  it("drops cancelled lines and shows qty in the line's display unit", () => {
    const [p] = buildPackingSlipPages([order()], seller);
    expect(p.lines.map((l) => l.name)).toEqual(["Widget", "Cased"]);
    expect(p.lines[1].qtyText).toMatch(/3\s*Case/i);
  });
  it("carries carrier, tracking and the ship-to block", () => {
    const [p] = buildPackingSlipPages([order()], seller);
    expect(p.carrier).toBe("UPS");
    expect(p.trackingNumber).toBe("1Z999");
    expect(p.shipTo).toEqual(expect.arrayContaining(["Shop One", "9 Elm"]));
  });
  it("NO money field anywhere on a page", () => {
    const json = JSON.stringify(buildPackingSlipPages([order()], seller));
    expect(json).not.toMatch(/unitPrice|subtotal|price|total|amount|tax|"5"|\$/i);
    for (const l of buildPackingSlipPages([order()], seller)[0].lines) {
      expect(Object.keys(l).sort()).toEqual(["name", "qtyText", "sku"]);
    }
  });
  it("the template source prints no money", () => {
    const src = fs.readFileSync(path.join(__dirname, "packing-slip-pdf-template.tsx"), "utf8");
    expect(src).not.toMatch(
      /unitPrice|subtotal|taxAmount|\btotal\b|price|fmt\(|toFixed|\$\{?\s*\d/i,
    );
  });

  it("prefers the SHIPPING address over a default billing one, then falls back (#3168 d)", () => {
    const billing = {
      line1: "1 Bill",
      city: "B",
      state: "CA",
      zip: "1",
      isDefault: true,
      addressType: "BILLING",
    };
    const shipping = {
      line1: "2 Ship",
      city: "S",
      state: "CA",
      zip: "2",
      isDefault: false,
      addressType: "SHIPPING",
    };
    const withShip = buildPackingSlipPages(
      [
        order({
          customer: { businessName: "Shop", contactName: "Pat", addresses: [billing, shipping] },
        }),
      ],
      seller,
    )[0];
    expect(withShip.shipTo).toContain("2 Ship");
    expect(withShip.shipTo).not.toContain("1 Bill");
    const billingOnly = buildPackingSlipPages(
      [order({ customer: { businessName: "Shop", contactName: "Pat", addresses: [billing] } })],
      seller,
    )[0];
    expect(billingOnly.shipTo).toContain("1 Bill");
  });
});
