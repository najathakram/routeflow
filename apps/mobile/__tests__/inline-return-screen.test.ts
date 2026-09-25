import {
  canConfirmInlineReturn,
  canGetInlineReturnQuote,
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
  inlineReturnsGate,
  screenReturnKey,
} from "../lib/inline-return-screen";
import { inlineReturnSubmitKey } from "../lib/inline-return-submit-key";
import type { InlineReturnLineDraft } from "@routeflow/returns";
import type { InlineReturnQuoteResponse, InlineReturnRecord } from "@routeflow/types";

const line = (over: Partial<InlineReturnLineDraft> = {}): InlineReturnLineDraft => ({
  productId: "p1",
  productName: "Widget",
  unitsPerBox: 12,
  boxes: "",
  pieces: "",
  reason: "",
  note: "",
  ...over,
});

const quote = { chunks: [] } as unknown as InlineReturnQuoteResponse;
const record = { id: "r1" } as unknown as InlineReturnRecord;

describe("canGetInlineReturnQuote", () => {
  it("needs a carrying order AND at least one quantity", () => {
    expect(canGetInlineReturnQuote([line({ boxes: "1" })], "")).toBe(false);
    expect(canGetInlineReturnQuote([line()], "o1")).toBe(false);
    expect(canGetInlineReturnQuote([line({ pieces: "3" })], "o1")).toBe(true);
  });
});

describe("canConfirmInlineReturn", () => {
  it("needs a reason", () => {
    expect(canConfirmInlineReturn("")).toBe(false);
    expect(canConfirmInlineReturn("DAMAGED")).toBe(true);
  });
});

describe("screenReturnKey", () => {
  it("is the per-attempt key inlineReturnSubmitKey(customer, order, nonce) — independent of the lines (edit/re-quote safe)", () => {
    const key = inlineReturnSubmitKey({ customerId: "c1", orderId: "o1" }, "n1");
    expect(screenReturnKey("c1", "o1", "n1")).toBe(key);
  });
  it("is stable for the same nonce and changes with the nonce", () => {
    expect(screenReturnKey("c", "o", "n")).toBe(screenReturnKey("c", "o", "n"));
    expect(screenReturnKey("c", "o", "n")).not.toBe(screenReturnKey("c", "o", "m"));
  });
});

describe("inlineReturnScreenReducer", () => {
  it("lines -> quote -> success", () => {
    let s = initialInlineReturnScreen;
    expect(s.step).toBe("lines");
    s = inlineReturnScreenReducer(s, { type: "quoted", quote });
    expect(s).toMatchObject({ step: "quote", quote });
    s = inlineReturnScreenReducer(s, { type: "captured", result: record });
    expect(s).toMatchObject({ step: "success", result: record });
  });
  it("any refusal lands on refused with the message; back returns to lines and keeps nothing stale", () => {
    let s = inlineReturnScreenReducer(initialInlineReturnScreen, { type: "quoted", quote });
    s = inlineReturnScreenReducer(s, { type: "refused", message: "nope" });
    expect(s).toMatchObject({ step: "refused", message: "nope" });
    s = inlineReturnScreenReducer(s, { type: "edit" });
    expect(s).toEqual(initialInlineReturnScreen);
  });
  it("a re-quote (excess option) stays on the quote step with the new quote", () => {
    const q2 = { chunks: [1] } as unknown as InlineReturnQuoteResponse;
    let s = inlineReturnScreenReducer(initialInlineReturnScreen, { type: "quoted", quote });
    s = inlineReturnScreenReducer(s, { type: "quoted", quote: q2 });
    expect(s).toMatchObject({ step: "quote", quote: q2 });
  });
  it("ignores captured when no quote was taken (cannot skip the quote step)", () => {
    expect(
      inlineReturnScreenReducer(initialInlineReturnScreen, { type: "captured", result: record }),
    ).toEqual(initialInlineReturnScreen);
  });
});

describe("inlineReturnsGate — mirrors web RecordReturnAction's orders_inline_returns add-on gate", () => {
  it("is loading until the add-ons fetch resolved", () => {
    expect(inlineReturnsGate({ enabled: false, resolved: false })).toBe("loading");
  });
  it("blocks (fails closed) when the tenant lacks the add-on", () => {
    expect(inlineReturnsGate({ enabled: false, resolved: true })).toBe("blocked");
  });
  it("allows only when resolved AND granted", () => {
    expect(inlineReturnsGate({ enabled: true, resolved: true })).toBe("allowed");
  });
});
