// #2695 (SA-557): the operator inline-return screen's staff credit price override — the pure
// decisions (role gate, Get-quote gate, the capture and "return only what was bought" requests)
// plus a source pin that the screen renders the input only behind the role gate (no renderer here).
import { readFileSync } from "fs";
import { join } from "path";
import {
  buildInlineReturnCapture,
  canGetInlineReturnQuote,
  captureFailureMessage,
  canOverrideInlineReturnCredit,
  initialInlineReturnScreen,
  inlineReturnScreenReducer,
  onlyPurchasedRequote,
} from "../lib/inline-return-screen";
import {
  extractRefusalMessage,
  keyReusedReturnOf,
  type InlineReturnLineDraft,
} from "@routeflow/returns";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

const line = (over: Partial<InlineReturnLineDraft> = {}): InlineReturnLineDraft => ({
  productId: "p1",
  productName: "Widget",
  unitsPerBox: null,
  boxes: "",
  pieces: "",
  reason: "",
  note: "",
  ...over,
});

const chunk = (over: Partial<InlineReturnQuoteChunk>): InlineReturnQuoteChunk => ({
  sourceOrderId: "o1",
  sourceInvoiceItemId: "ii1",
  sourceOrderItemId: "oi1",
  productId: "p1",
  pieces: 4,
  subtotal: 20,
  taxAmount: 1,
  categoryTax: 0,
  priceSource: "SOURCE_INVOICE",
  unitPrice: 5,
  ...over,
});

const OVERRIDE = { creditUnitPrice: "3.50", overrideReason: " dented " };

describe("#2695 mobile credit price override", () => {
  it("is offered to OPERATOR and TENANT_ADMIN only, by the JWT role", () => {
    expect(
      ["OPERATOR", "TENANT_ADMIN", "DRIVER", "CUSTOMER", undefined].map((role) =>
        canOverrideInlineReturnCredit(role ? { role } : null),
      ),
    ).toEqual([true, true, false, false, false]);
  });

  it("Get quote stays disabled while an override can't be sent (a price with no reason)", () => {
    expect(canGetInlineReturnQuote([line({ pieces: "4", ...OVERRIDE })], "ord-1")).toBe(true);
    expect(canGetInlineReturnQuote([line({ pieces: "4", creditUnitPrice: "3.50" })], "ord-1")).toBe(
      false,
    );
    expect(canGetInlineReturnQuote([line({ pieces: "4" })], "ord-1")).toBe(true);
  });

  it("the capture (built from the QUOTED snapshot) sends the same override the quote did", () => {
    const quote = { chunks: [chunk({})] } as unknown as InlineReturnQuoteResponse;
    const state = inlineReturnScreenReducer(initialInlineReturnScreen, {
      type: "quoted",
      quote,
      lines: [line({ pieces: "4", ...OVERRIDE })],
    });
    const request = buildInlineReturnCapture(state, {
      customerId: "c1",
      orderId: "ord-1",
      nonce: "n1",
      reason: "DAMAGED",
    });
    expect(request?.items).toEqual([
      expect.objectContaining({ pieces: 4, creditUnitPrice: 3.5, overrideReason: "dented" }),
    ]);
  });

  it("'Return only what was bought' re-quotes WITH the snapshot's override", () => {
    const quote = {
      chunks: [chunk({ pieces: 4 }), chunk({ sourceOrderId: null, pieces: 2 })],
    } as unknown as InlineReturnQuoteResponse;
    expect(onlyPurchasedRequote("c1", quote, [line({ pieces: "6", ...OVERRIDE })]).items).toEqual([
      {
        productId: "p1",
        qty: 1,
        boxes: 0,
        pieces: 4,
        creditUnitPrice: 3.5,
        overrideReason: "dented",
      },
    ]);
  });

  it("the screen renders the credit price input only behind the role gate, and re-quotes via the snapshot", () => {
    const src = readFileSync(join(__dirname, "../app/(operator)/returns/inline.tsx"), "utf8");
    const gate = src.indexOf("{canOverrideCredit && (");
    expect(gate).toBeGreaterThan(-1);
    expect(src.indexOf("accessibilityLabel={`Credit price, ")).toBeGreaterThan(gate);
    expect(src.match(/Credit price, \$\{/g)).toHaveLength(1);
    expect(src).toContain("onlyPurchasedRequote(customerId, screen.quote, screen.quotedLines)");
    expect(src).not.toContain("dropExcessAndRequote(");
  });

  describe("RETURN_CREDIT_OVER_CAP 400 (lead: the refusal renders inline, and the draft survives)", () => {
    const message =
      "Widget: a credit price can only be lowered — the most this return can credit is $5.00 per unit.";
    const overCap = {
      response: { status: 400, data: { code: "RETURN_CREDIT_OVER_CAP", productId: "p1", message } },
    };

    it("the quote refusal text is the server's own message (what the screen's refused step shows)", () => {
      expect(extractRefusalMessage(overCap)).toBe(message);
    });

    it("a capture 400 shows the message and says the attempt wasn't recorded", () => {
      expect(captureFailureMessage(overCap)).toBe(`${message} This attempt wasn't recorded.`);
    });

    it("it is not a recorded return, so the screen keeps the draft lines and overrides for a fix-and-retry", () => {
      expect(keyReusedReturnOf(overCap)).toBeNull();
      const src = readFileSync(join(__dirname, "../app/(operator)/returns/inline.tsx"), "utf8");
      // refuse() clears the draft ONLY for a recorded (key-reused) return.
      expect(src).toMatch(/if \(recorded\) \{\s*setLines\(\[\]\);/);
      expect(src).toContain("onError: (e) => refuse(extractRefusalMessage(e), e)");
    });
  });

  it("two rows of one product with different overrides keep Get quote disabled", () => {
    expect(
      canGetInlineReturnQuote(
        [
          line({ pieces: "4", creditUnitPrice: "3", overrideReason: "a" }),
          line({ pieces: "2", creditUnitPrice: "2", overrideReason: "a" }),
        ],
        "ord-1",
      ),
    ).toBe(false);
  });
});
