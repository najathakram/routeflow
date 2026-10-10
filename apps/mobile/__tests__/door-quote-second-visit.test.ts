/**
 * #2300: on a SECOND visit (#1353 caps the re-delivery to the server's served `remaining`), the
 * payment screen's door quote must never fall back to the FULL order total while the order's own
 * details are still loading — that overstates what is owed, and `invoiceTotal` also caps what the
 * close records as collected. It prices the stop snapshot's remaining-based fallback lines instead.
 * A first visit keeps the full-order path exactly as before.
 */
import * as shortPick from "../lib/short-pick";
import { readFileSync } from "fs";
import { join } from "path";

const { reconciledTotal } = shortPick;
// Resolved at call time so a missing export fails the test (red), not the whole file.
const doorQuoteLines = (...args: unknown[]) => (shortPick as any).doorQuoteLines(...args);
const isLaterVisit = (...args: unknown[]) => (shortPick as any).isLaterVisit(...args);

// Second visit: 10 ordered ($100), 4 delivered at the first visit, 6 served as remaining.
const secondVisitOrder = {
  lineItems: [{ id: "a", productId: "p", status: "PENDING", qty: 10, subtotal: 100, remaining: 6 }],
};
// First visit: everything served as remaining.
const firstVisitOrder = {
  lineItems: [
    { id: "a", productId: "p", status: "PENDING", qty: 10, subtotal: 100, remaining: 10 },
  ],
};

describe("#2300 door quote while an order's details are loading", () => {
  it("a second visit that hasn't loaded prices the served remaining ($60), not the full $100", () => {
    const lines = doorQuoteLines(secondVisitOrder, [], false);
    expect(lines.map((l: any) => [l.orderItemId, l.orderedQty])).toEqual([["a", 6]]);
    expect(reconciledTotal(lines, {})).toBe(60);
  });

  it("a first visit that hasn't loaded keeps the full-order path ([] ⇒ fullOrderTotal)", () => {
    expect(doorQuoteLines(firstVisitOrder, [], false)).toEqual([]);
  });

  it("a landed order uses its rich lines, and a landed order with none keeps the full path", () => {
    const rich = [
      {
        orderItemId: "a",
        productId: "p",
        orderedQty: 6,
        subtotal: 60,
        freeUnits: 0,
        freeUnitSize: 1,
      },
    ];
    expect(doorQuoteLines(secondVisitOrder, rich, true)).toEqual(rich);
    expect(doorQuoteLines(secondVisitOrder, [], true)).toEqual([]);
  });

  it("isLaterVisit: served remaining below qty on an active line; cancelled or unserved lines don't count", () => {
    expect(isLaterVisit(secondVisitOrder)).toBe(true);
    expect(isLaterVisit(firstVisitOrder)).toBe(false);
    expect(isLaterVisit({ lineItems: [{ id: "a", productId: "p", qty: 10, subtotal: 100 }] })).toBe(
      false,
    );
    expect(
      isLaterVisit({
        lineItems: [
          { id: "a", productId: "p", status: "CANCELLED", qty: 10, subtotal: 100, remaining: 0 },
        ],
      }),
    ).toBe(false);
  });
});

describe("#2300 wiring pin", () => {
  const payment = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/payment.tsx"),
    "utf8",
  );

  it("invoiceTotal prices doorQuoteLines(o, rich, landed), never the rich lines alone", () => {
    expect(payment).toMatch(
      /doorQuoteLines\(\s*o,\s*richShortPickLinesByOrder\[o\.id\]\s*\?\?\s*\[\],\s*!!ordersById\[o\.id\],?\s*\)/,
    );
    expect(payment).not.toMatch(/const shortPickLines = richShortPickLinesByOrder\[o\.id\]/);
  });
});
