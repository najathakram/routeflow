import { storedSaleState } from "./sale-replay-guard";

/**
 * Row 383: the ONE "is this stored sale still a sale?" rule. A counter sale's invoice is sent by createSale BEFORE the tender, so
 * an unsent DRAFT invoice on a PENDING / DELIVERED order is a HALF sale: by-key must say "incomplete" (the till re-POSTs the same
 * key), never "live".
 */
describe("storedSaleState", () => {
  it("a CANCELLED order is voided; an order whose every invoice is VOID / WRITTEN_OFF is voided", () => {
    expect(storedSaleState("CANCELLED", [])).toBe("voided");
    expect(storedSaleState("DELIVERED", ["VOID"])).toBe("voided");
    expect(storedSaleState("DELIVERED", ["VOID", "WRITTEN_OFF"])).toBe("voided");
  });

  it("no invoice rows: PENDING / DELIVERED is incomplete, any other status is changed", () => {
    expect(storedSaleState("PENDING", [])).toBe("incomplete");
    expect(storedSaleState("DELIVERED", [])).toBe("incomplete");
    expect(storedSaleState("CONFIRMED", [])).toBe("changed");
  });

  it("RED before the fix: a DELIVERED / PENDING order whose live invoice is still a DRAFT is incomplete (the send never finished)", () => {
    expect(storedSaleState("DELIVERED", ["DRAFT"])).toBe("incomplete");
    expect(storedSaleState("PENDING", ["DRAFT"])).toBe("incomplete");
    // a sibling (regulated split) still DRAFT while another was sent: still unfinished
    expect(storedSaleState("DELIVERED", ["SENT", "DRAFT"])).toBe("incomplete");
    // a voided sibling does not hide a live DRAFT
    expect(storedSaleState("DELIVERED", ["VOID", "DRAFT"])).toBe("incomplete");
  });

  it("PIN: a fully sent (or paid, overdue, partial) sale reads live; so does a moved-on order with a DRAFT", () => {
    for (const s of ["SENT", "PAID", "PARTIALLY_PAID", "OVERDUE"]) {
      expect(storedSaleState("DELIVERED", [s])).toBe("live");
    }
    expect(storedSaleState("DELIVERED", ["SENT", "PAID"])).toBe("live");
    // staff moved the order on: never judged half, so it is never rung (and charged) twice
    expect(storedSaleState("CONFIRMED", ["DRAFT"])).toBe("live");
    expect(storedSaleState("PARTIALLY_DELIVERED", ["PAID"])).toBe("live");
  });
});
