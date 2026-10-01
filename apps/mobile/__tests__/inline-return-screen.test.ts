import {
  buildInlineReturnCapture,
  canConfirmInlineReturn,
  canGetInlineReturnQuote,
  canLeaveInlineReturn,
  captureFailureMessage,
  formatRefundAmount,
  initialInlineReturnScreen,
  inlineReturnScreenReducer as reduce,
  inlineReturnsAddonState,
  inlineReturnsGate,
  linesFromOrder,
  screenReturnKey,
  type InlineReturnScreenEvent,
  type InlineReturnScreenState,
} from "../lib/inline-return-screen";
import { DEFAULT_EXCESS_OPTION, type InlineReturnLineDraft } from "@routeflow/returns";
import { inlineReturnSubmitKey } from "../lib/inline-return-submit-key";
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
const run = (events: InlineReturnScreenEvent[], from = initialInlineReturnScreen) =>
  events.reduce<InlineReturnScreenState>(reduce, from);
const quoted = (
  lines: InlineReturnLineDraft[] = [line({ boxes: "1" })],
): InlineReturnScreenEvent => ({
  type: "quoted",
  quote,
  lines,
});

describe("canGetInlineReturnQuote / canConfirmInlineReturn", () => {
  it("quote needs a carrying order AND a quantity", () => {
    expect(canGetInlineReturnQuote([line({ boxes: "1" })], "")).toBe(false);
    expect(canGetInlineReturnQuote([line()], "o1")).toBe(false);
    expect(canGetInlineReturnQuote([line({ pieces: "3" })], "o1")).toBe(true);
  });
  it("confirm needs a reason", () => {
    expect(canConfirmInlineReturn("")).toBe(false);
    expect(canConfirmInlineReturn("DAMAGED")).toBe(true);
  });
});

describe("screenReturnKey", () => {
  it("is the per-attempt key, independent of the lines", () => {
    expect(screenReturnKey("c1", "o1", "n1")).toBe(
      inlineReturnSubmitKey({ customerId: "c1", orderId: "o1" }, "n1"),
    );
    expect(screenReturnKey("c", "o", "n")).not.toBe(screenReturnKey("c", "o", "m"));
  });
});

describe("reducer — flow", () => {
  it("lines -> quote -> capturing -> success", () => {
    let s = run([quoted()]);
    expect(s.step).toBe("quote");
    s = run([{ type: "captureStarted" }], s);
    expect(s.step).toBe("capturing");
    s = run([{ type: "captured", result: record }], s);
    expect(s).toMatchObject({ step: "success", result: record });
  });
  it("#2647: a key-reused refusal carries the recorded return; any other refusal carries none", () => {
    const recorded = { returnId: "ret-9", returnNumber: "RET-2026-0042" };
    expect(
      run([quoted(), { type: "captureStarted" }, { type: "refused", message: "m", recorded }]),
    ).toMatchObject({ step: "refused", recorded });
    expect(
      run([quoted(), { type: "captureStarted" }, { type: "refused", message: "m" }]),
    ).toMatchObject({ step: "refused", recorded: null });
  });

  it("a refusal lands on refused; edit returns to lines", () => {
    const s = run([quoted(), { type: "captureStarted" }, { type: "refused", message: "nope" }]);
    expect(s).toMatchObject({ step: "refused", message: "nope" });
    expect(run([{ type: "edit" }], s)).toEqual(initialInlineReturnScreen);
  });
  it("cannot capture without a quote", () => {
    expect(run([{ type: "captureStarted" }])).toEqual(initialInlineReturnScreen);
  });
});

describe("reducer — a landed capture is never dropped (Opus #2087 point 1: duplicate credit)", () => {
  it("navigation is locked while a capture is pending: edit is ignored, and so is a re-quote", () => {
    const capturing = run([quoted(), { type: "captureStarted" }]);
    expect(canLeaveInlineReturn(capturing)).toBe(false);
    expect(run([{ type: "edit" }], capturing)).toBe(capturing);
    expect(run([quoted([line({ boxes: "9" })])], capturing)).toBe(capturing);
  });
  it("leaving is allowed on every other step", () => {
    expect(canLeaveInlineReturn(initialInlineReturnScreen)).toBe(true);
    expect(canLeaveInlineReturn(run([quoted()]))).toBe(true);
  });
  it("captured ALWAYS shows the success result, from any step (even lines/quote/refused)", () => {
    for (const from of [
      initialInlineReturnScreen,
      run([quoted()]),
      run([{ type: "refused", message: "x" }]),
    ]) {
      expect(run([{ type: "captured", result: record }], from)).toMatchObject({
        step: "success",
        result: record,
      });
    }
  });
  it("a late refusal never overwrites a landed result", () => {
    const done = run([quoted(), { type: "captureStarted" }, { type: "captured", result: record }]);
    expect(run([{ type: "refused", message: "late" }], done)).toBe(done);
  });
});

describe("reducer — offline-queued capture is a pending success (REG-B308)", () => {
  it("queued lands on its own step, from capturing or anywhere", () => {
    expect(run([quoted(), { type: "captureStarted" }, { type: "queued" }]).step).toBe("queued");
    expect(run([{ type: "queued" }]).step).toBe("queued");
  });
  it("a queued step is not overwritten by a late refusal", () => {
    const q = run([{ type: "queued" }]);
    expect(run([{ type: "refused", message: "late" }], q)).toBe(q);
  });
  it("leaving a queued/success step is allowed", () => {
    expect(canLeaveInlineReturn(run([{ type: "queued" }]))).toBe(true);
  });
});

describe("§8.1a(5) — capture sends the QUOTED quantities, never live-edited ones", () => {
  const base = { customerId: "c", orderId: "o", nonce: "n1", reason: "DAMAGED" as const };
  it("builds the request from the snapshot carried in the state", () => {
    const live = [line({ boxes: "1", pieces: "2" })];
    const s = run([quoted(live)]);
    live[0]!.boxes = "9"; // the live array is edited AFTER the quote
    live[0]!.pieces = "99";
    const req = buildInlineReturnCapture(s, base)!;
    expect(req.items).toEqual([{ productId: "p1", qty: 1, boxes: 1, pieces: 2 }]);
    expect(req.returnKey).toBe(screenReturnKey("c", "o", "n1"));
    expect(req.reason).toBe("DAMAGED");
  });
  it("a re-quote replaces the snapshot with the re-quoted lines", () => {
    const s = run([quoted([line({ pieces: "12" })]), quoted([line({ boxes: "0", pieces: "4" })])]);
    expect(buildInlineReturnCapture(s, base)!.items).toEqual([
      { productId: "p1", qty: 1, boxes: 0, pieces: 4 },
    ]);
  });
  it("there is nothing to capture outside quote/capturing", () => {
    expect(buildInlineReturnCapture(initialInlineReturnScreen, base)).toBeNull();
    expect(buildInlineReturnCapture(run([{ type: "queued" }]), base)).toBeNull();
  });
});

describe("excess option resets on every fresh quote (Opus #2087 point 5)", () => {
  it("a fresh quote after edit starts from the default", () => {
    let s = run([
      {
        ...(quoted() as {
          type: "quoted";
          quote: InlineReturnQuoteResponse;
          lines: InlineReturnLineDraft[];
        }),
        excessOption: "RETURN_ONLY_PURCHASED",
      },
    ]);
    expect(s).toMatchObject({ excessOption: "RETURN_ONLY_PURCHASED" });
    s = run([{ type: "edit" }, quoted()], s);
    expect(s).toMatchObject({ excessOption: DEFAULT_EXCESS_OPTION });
  });
  it("defaults when the event carries no option", () => {
    expect(run([quoted()])).toMatchObject({ excessOption: DEFAULT_EXCESS_OPTION });
  });
});

describe("formatRefundAmount — refundAmount is a Decimal STRING on the wire (Opus #2087 point 4)", () => {
  it("formats a decimal string, a number, and hides null/garbage", () => {
    expect(formatRefundAmount("12.5000")).toBe("$12.50");
    expect(formatRefundAmount(7)).toBe("$7.00");
    expect(formatRefundAmount(null)).toBeNull();
    expect(formatRefundAmount(undefined)).toBeNull();
    expect(formatRefundAmount("abc")).toBeNull();
  });
});

describe("linesFromOrder — pre-fill from the carrying order, SOLD pack not live", () => {
  const li = (over: Record<string, unknown>) =>
    ({
      id: "l1",
      productId: "p1",
      qty: 30,
      boxes: 2,
      pieces: 6,
      unitPrice: 1,
      subtotal: 1,
      status: "X",
      unitsPerBox: 12,
      unitLabel: "Case",
      product: { name: "Widget", unit: "pcs", unitsPerBox: 24 },
      ...over,
    }) as any;
  it("uses the line's sold unitsPerBox snapshot over the live product pack", () => {
    const [d] = linesFromOrder([li({})]);
    expect(d).toMatchObject({
      productId: "p1",
      productName: "Widget",
      unitsPerBox: 12,
      boxes: "",
      pieces: "",
    });
  });
  it("falls back to the live pack only when the line has no snapshot", () => {
    const [d] = linesFromOrder([li({ unitsPerBox: null })]);
    expect(d!.unitsPerBox).toBe(24);
  });
  it("labels what was sold via formatQtySplit and carries the unit label", () => {
    const [d] = linesFromOrder([li({})]);
    expect(d!.soldLabel).toBe("2 Cases + 6 pcs");
    expect(d!.boxLabel).toBe("Case");
  });
  it("skips unlisted lines (no productId) and de-duplicates a product", () => {
    expect(
      linesFromOrder([li({ productId: null }), li({ id: "a" }), li({ id: "b" })]),
    ).toHaveLength(1);
  });
});

describe("inlineReturnsAddonState — keyed off the DATA, not isSuccess (no flicker on refetch)", () => {
  it("unresolved without data; resolved with data; enabled iff listed", () => {
    expect(inlineReturnsAddonState(undefined)).toEqual({ enabled: false, resolved: false });
    expect(inlineReturnsAddonState({ addons: [] })).toEqual({ enabled: false, resolved: true });
    expect(inlineReturnsAddonState({ addons: ["orders_inline_returns"] })).toEqual({
      enabled: true,
      resolved: true,
    });
  });
});

describe("inlineReturnsGate", () => {
  it("loading / blocked (fails closed) / allowed", () => {
    expect(inlineReturnsGate({ enabled: false, resolved: false })).toBe("loading");
    expect(inlineReturnsGate({ enabled: false, resolved: true })).toBe("blocked");
    expect(inlineReturnsGate({ enabled: true, resolved: true })).toBe("allowed");
  });
});

describe("captureFailureMessage — uncertain vs definite failures (Opus #2111)", () => {
  it("a 5xx / timeout / 408 / 429 / retry-409 reads as unconfirmed and says a retry sends the same request", () => {
    for (const err of [
      { response: { status: 503, data: { message: "down" } } },
      { code: "ECONNABORTED", message: "timeout" },
      { response: { status: 408, data: {} } },
      { response: { status: 429, data: {} } },
      { message: "Network Error" },
    ]) {
      const msg = captureFailureMessage(err);
      expect(msg).toMatch(/couldn't confirm/i);
      expect(msg).toMatch(/same request/i);
    }
  });
  it("401, 403 and a code-less 400 are DEFINITE non-writes: they say nothing was recorded, never 'couldn't confirm'", () => {
    for (const err of [
      { response: { status: 401, data: {} } },
      { response: { status: 403, data: { message: "You do not have access" } } },
      { response: { status: 400, data: { message: "items must not be empty" } } },
    ]) {
      const msg = captureFailureMessage(err);
      expect(msg).toMatch(/this attempt wasn't recorded/i);
      expect(msg).not.toMatch(/couldn't confirm/i);
    }
    expect(
      captureFailureMessage({
        response: { status: 400, data: { message: "items must not be empty" } },
      }),
    ).toContain("items must not be empty");
  });
  it("run-on server messages get a separator before the note (no 'foo bar Nothing...')", () => {
    expect(
      captureFailureMessage({ response: { status: 400, data: { message: "No access" } } }),
    ).toBe("No access. This attempt wasn't recorded.");
    expect(
      captureFailureMessage({ response: { status: 400, data: { message: "No access." } } }),
    ).toBe("No access. This attempt wasn't recorded.");
  });
  it("a coded business refusal shows the server's own message", () => {
    expect(
      captureFailureMessage({
        response: {
          status: 400,
          data: {
            code: "INLINE_RETURN_ORDER_CANCELLED",
            message: "Cannot capture a return against a cancelled order",
          },
        },
      }),
    ).toBe("Cannot capture a return against a cancelled order");
  });
});

describe("linesFromOrder — cancelled lines are excluded", () => {
  it("a CANCELLED order line is never offered for return", () => {
    const li = (id: string, productId: string, status: string) =>
      ({ id, productId, qty: 1, status, product: { name: id, unit: "pcs" } }) as any;
    expect(
      linesFromOrder([li("a", "p1", "CANCELLED"), li("b", "p2", "CONFIRMED")]).map(
        (l) => l.productId,
      ),
    ).toEqual(["p2"]);
  });
});
