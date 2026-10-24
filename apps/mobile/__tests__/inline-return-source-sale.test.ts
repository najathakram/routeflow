import { readFileSync } from "fs";
import { join } from "path";
import {
  buildInlineReturnCapture,
  inlineReturnHref,
  initialInlineReturnScreen,
  inlineReturnScreenReducer as reduce,
  onlyPurchasedRequote,
  sourceSaleOf,
} from "../lib/inline-return-screen";
import type { InlineReturnLineDraft } from "@routeflow/returns";
import type { InlineReturnQuoteResponse } from "@routeflow/types";

// SA-740 (row 190): a counter return names the sale it is from. A walk-in is one shared customer row, so the
// server refuses a quote without a source sale and pins the match to it; a named customer is left unpinned.

const line = (over: Partial<InlineReturnLineDraft> = {}): InlineReturnLineDraft => ({
  productId: "p1",
  productName: "Widget",
  unitsPerBox: null,
  boxes: "",
  pieces: "2",
  reason: "",
  note: "",
  ...over,
});

describe("sourceSaleOf — which sale the screen pins the return to", () => {
  it("an explicit route param wins", () => {
    expect(
      sourceSaleOf({ routeSourceOrderId: "sale-1", orderId: "o1", customerIsWalkIn: false }),
    ).toBe("sale-1");
  });
  it("a walk-in's order is the source (the screen was opened from that sale)", () => {
    expect(sourceSaleOf({ orderId: "o1", customerIsWalkIn: true })).toBe("o1");
  });
  it.each([
    ["a named customer", { orderId: "o1", customerIsWalkIn: false }],
    ["an unknown customer (order still loading)", { orderId: "o1" }],
    ["no order (customer-detail entry)", { customerIsWalkIn: true }],
    ["blank params", { routeSourceOrderId: "", orderId: "", customerIsWalkIn: true }],
  ])("%s pins nothing", (_label, args) => {
    expect(sourceSaleOf(args)).toBeUndefined();
  });
});

describe("inlineReturnHref carries sourceOrderId only when given", () => {
  it("adds it", () => {
    expect(
      inlineReturnHref({ customerId: "c1", orderId: "o1", sourceOrderId: "o1" }).params,
    ).toEqual({
      customerId: "c1",
      orderId: "o1",
      sourceOrderId: "o1",
    });
  });
  it("omits it otherwise", () => {
    expect(inlineReturnHref({ customerId: "c1", orderId: "o1" }).params).not.toHaveProperty(
      "sourceOrderId",
    );
  });
});

describe("the capture and the 'return only what was bought' re-quote stay pinned to the same sale", () => {
  const quote = {
    chunks: [{ sourceOrderId: "sale-1", productId: "p1", pieces: 2 }],
  } as unknown as InlineReturnQuoteResponse;
  const state = reduce(initialInlineReturnScreen, { type: "quoted", quote, lines: [line()] });

  it("capture carries sourceOrderId", () => {
    const req = buildInlineReturnCapture(state, {
      customerId: "c1",
      orderId: "o1",
      nonce: "n",
      reason: "DAMAGED",
      sourceOrderId: "sale-1",
    })!;
    expect(req.sourceOrderId).toBe("sale-1");
  });
  it("capture omits it when none", () => {
    const req = buildInlineReturnCapture(state, {
      customerId: "c1",
      orderId: "o1",
      nonce: "n",
      reason: "DAMAGED",
    })!;
    expect(req).not.toHaveProperty("sourceOrderId");
  });
  it("the re-quote carries it", () => {
    expect(onlyPurchasedRequote("c1", quote, [line()], "sale-1").sourceOrderId).toBe("sale-1");
    expect(onlyPurchasedRequote("c1", quote, [line()])).not.toHaveProperty("sourceOrderId");
  });
});

describe("the screen wiring", () => {
  const src = readFileSync(join(__dirname, "../app/(operator)/returns/inline.tsx"), "utf8");
  it("sends the source sale on the quote, the capture and the re-quote", () => {
    expect(src).toContain("buildQuoteRequest(customerId, lines, undefined, sourceOrderId)");
    expect(src).toContain("sourceOrderId,");
    expect(src).toContain(
      "onlyPurchasedRequote(customerId, screen.quote, screen.quotedLines, sourceOrderId)",
    );
    expect(src).toContain("sourceSaleOf(");
  });
});
