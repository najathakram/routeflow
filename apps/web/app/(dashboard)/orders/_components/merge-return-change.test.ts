import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";
import { mergeReturnChange } from "./merge-return-change";

// SA-1060 A-5: what merging changes about a quoted return, from the box's quote and the merge target's. Pure.
function chunk(over: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: null,
    sourceInvoiceItemId: null,
    sourceOrderItemId: null,
    productId: "prod-1",
    pieces: 3,
    subtotal: 30,
    taxAmount: 2.4,
    categoryTax: 0,
    priceSource: "TIER",
    unitPrice: 10,
    neverSold: false,
    ...over,
  } as InlineReturnQuoteChunk;
}

function quote(
  total: number,
  chunks: InlineReturnQuoteChunk[] = [chunk()],
): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: 30,
    taxAmount: Math.round((total - 30) * 100) / 100,
    categoryTax: 0,
    total,
    productBreakdown: {},
    canRefund: false,
    paidInFull: false,
    paidMethods: [],
    paidWithStoreCredit: false,
    customerIsWalkIn: false,
  } as InlineReturnQuoteResponse;
}

const SOLD = quote(32.4);
const NEVER = quote(30, [chunk({ taxAmount: 0, neverSold: true })]);

describe("mergeReturnChange (SA-1060 A-5)", () => {
  it("NS-15: merging turns a sold return into a never-sold one -> the amount and the stock", () => {
    expect(mergeReturnChange(SOLD, NEVER)).toBe(
      "If you merge, this return is $30.00, not added to stock.",
    );
  });

  it("NS-19: the same answer on both sides -> no line", () => {
    expect(mergeReturnChange(SOLD, quote(32.4))).toBeNull();
    expect(mergeReturnChange(NEVER, NEVER)).toBeNull();
  });

  it("a different total with no stock change ends at the amount", () => {
    expect(mergeReturnChange(SOLD, quote(25.2))).toBe("If you merge, this return is $25.20.");
  });

  it("a different total where the box already said not added to stock ends at the amount (no stock change)", () => {
    expect(mergeReturnChange(NEVER, quote(20, [chunk({ taxAmount: 0, neverSold: true })]))).toBe(
      "If you merge, this return is $20.00.",
    );
  });

  it("only the products that become never-sold count: another product's flag does not name stock", () => {
    const box = quote(60, [chunk({ productId: "a" }), chunk({ productId: "b", neverSold: true })]);
    const merged = quote(55, [
      chunk({ productId: "a" }),
      chunk({ productId: "b", neverSold: true }),
    ]);
    expect(mergeReturnChange(box, merged)).toBe("If you merge, this return is $55.00.");
  });

  it("NS-25: only one of two products flips -> some of it is not added to stock", () => {
    const box = quote(60, [chunk({ productId: "a" }), chunk({ productId: "b" })]);
    const merged = quote(55, [
      chunk({ productId: "a", neverSold: true }),
      chunk({ productId: "b" }),
    ]);
    expect(mergeReturnChange(box, merged)).toBe(
      "If you merge, this return is $55.00, some of it not added to stock.",
    );
  });

  it("every product never sold after the merge reads NS-15's words, though one was never sold before", () => {
    const box = quote(60, [chunk({ productId: "a", neverSold: true }), chunk({ productId: "b" })]);
    const merged = quote(55, [
      chunk({ productId: "a", neverSold: true }),
      chunk({ productId: "b", neverSold: true }),
    ]);
    expect(mergeReturnChange(box, merged)).toBe(
      "If you merge, this return is $55.00, not added to stock.",
    );
  });

  it("NS-24: the same total with a stock flip still shows a line (tax-exempt: $30 on both sides)", () => {
    const soldExempt = quote(30, [chunk({ taxAmount: 0 })]);
    expect(mergeReturnChange(soldExempt, NEVER)).toBe(
      "If you merge, this return is $30.00, not added to stock.",
    );
    expect(mergeReturnChange(NEVER, soldExempt)).toBe("If you merge, this return is $30.00.");
  });

  it("a total that moves by a cent of float noise is not a change", () => {
    expect(mergeReturnChange(quote(32.4), quote(32.4000001))).toBeNull();
  });
});
