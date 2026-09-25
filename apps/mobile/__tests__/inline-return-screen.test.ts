import {
  canConfirmInlineReturn,
  canGetInlineReturnQuote,
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
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
  it("matches inlineReturnSubmitKey over the parsed boxes/pieces, ignoring empty lines", () => {
    const lines = [line({ productId: "b", boxes: "2", pieces: "1" }), line({ productId: "a" })];
    expect(screenReturnKey("c1", "o1", lines, "n1")).toBe(
      inlineReturnSubmitKey(
        { customerId: "c1", orderId: "o1", items: [{ productId: "b", boxes: 2, pieces: 1 }] },
        "n1",
      ),
    );
  });
  it("is stable for the same nonce and changes with the nonce", () => {
    const lines = [line({ boxes: "1" })];
    expect(screenReturnKey("c", "o", lines, "n")).toBe(screenReturnKey("c", "o", lines, "n"));
    expect(screenReturnKey("c", "o", lines, "n")).not.toBe(screenReturnKey("c", "o", lines, "m"));
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
