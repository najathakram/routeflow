import {
  buildCaptureRequest,
  buildQuoteRequest,
  DEFAULT_EXCESS_OPTION,
  dropExcessAndRequote,
  extractRefusalMessage,
  groupQuoteChunks,
  hasAnyQtyEntered,
  isBoxedProduct,
  mintReturnKey,
  RETURNS_NOT_ENABLED_MESSAGE,
  sumChunkTotals,
  type InlineReturnLineDraft,
} from "./inline-return-state";
import type { InlineReturnQuoteChunk, InlineReturnQuoteResponse } from "@routeflow/types";

function line(overrides: Partial<InlineReturnLineDraft> = {}): InlineReturnLineDraft {
  return {
    productId: "prod-1",
    productName: "Widget",
    unitsPerBox: null,
    boxes: "",
    pieces: "",
    reason: "",
    note: "",
    ...overrides,
  };
}

function chunk(overrides: Partial<InlineReturnQuoteChunk> = {}): InlineReturnQuoteChunk {
  return {
    sourceOrderId: "order-1",
    sourceInvoiceItemId: "inv-item-1",
    sourceOrderItemId: "order-item-1",
    productId: "prod-1",
    pieces: 10,
    subtotal: 20,
    taxAmount: 2,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 2,
    ...overrides,
  };
}

function quoteResponse(chunks: InlineReturnQuoteChunk[]): InlineReturnQuoteResponse {
  return {
    chunks,
    subtotal: chunks.reduce((s, c) => s + c.subtotal, 0),
    taxAmount: chunks.reduce((s, c) => s + c.taxAmount, 0),
    categoryTax: chunks.reduce((s, c) => s + c.categoryTax, 0),
    total: chunks.reduce((s, c) => s + c.subtotal + c.taxAmount + c.categoryTax, 0),
    productBreakdown: {},
  };
}

describe("isBoxedProduct", () => {
  it("is true only when unitsPerBox > 1", () => {
    expect(isBoxedProduct({ unitsPerBox: 12 })).toBe(true);
    expect(isBoxedProduct({ unitsPerBox: 1 })).toBe(false);
    expect(isBoxedProduct({ unitsPerBox: null })).toBe(false);
    expect(isBoxedProduct({ unitsPerBox: undefined })).toBe(false);
  });
});

describe("hasAnyQtyEntered", () => {
  it("is false when every line is empty", () => {
    expect(hasAnyQtyEntered([line(), line({ productId: "prod-2" })])).toBe(false);
  });

  it("is true when any line has boxes or pieces entered", () => {
    expect(hasAnyQtyEntered([line(), line({ productId: "prod-2", pieces: "3" })])).toBe(true);
    expect(hasAnyQtyEntered([line({ boxes: "1" })])).toBe(true);
  });

  it("ignores a zero or garbage entry (not a real qty)", () => {
    expect(hasAnyQtyEntered([line({ boxes: "0", pieces: "0" })])).toBe(false);
    expect(hasAnyQtyEntered([line({ boxes: "abc" })])).toBe(false);
  });
});

describe("buildQuoteRequest — never a bare qty", () => {
  it("always sends boxes AND pieces explicitly, never a bare qty, for a boxed product", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", unitsPerBox: 12, boxes: "2", pieces: "3" }),
    ]);
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 2, pieces: 3 }]);
    // qty is present (DTO requires it) but is never the real return quantity.
    expect(req.items[0].qty).not.toBe(2);
    expect(req.items[0].qty).not.toBe(3);
  });

  it("also sends boxes AND pieces explicitly for a non-boxed product (never a bare qty)", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-2", unitsPerBox: null, pieces: "5" }),
    ]);
    expect(req.items).toEqual([{ productId: "prod-2", qty: 1, boxes: 0, pieces: 5 }]);
  });

  it("drops lines with no qty entered", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", pieces: "3" }),
      line({ productId: "prod-2" }),
    ]);
    expect(req.items.map((i) => i.productId)).toEqual(["prod-1"]);
  });

  it("omits routeRunStopId for an office (non-driver) caller", () => {
    const req = buildQuoteRequest("cust-1", [line({ pieces: "1" })]);
    expect(req).not.toHaveProperty("routeRunStopId");
  });
});

describe("groupQuoteChunks", () => {
  it("splits covered (matched) chunks from the excess (unmatched) chunk", () => {
    const covered1 = chunk({ sourceOrderId: "order-newest", pieces: 5 });
    const covered2 = chunk({ sourceOrderId: "order-older", pieces: 3 });
    const excess = chunk({ sourceOrderId: null, pieces: 2 });
    const { covered, excess: excessChunks } = groupQuoteChunks(
      quoteResponse([covered1, covered2, excess]),
    );
    expect(covered).toEqual([covered1, covered2]);
    expect(excessChunks).toEqual([excess]);
  });

  it("preserves the API's own order — never re-sorts (already newest-invoice-first)", () => {
    const newest = chunk({ sourceOrderId: "order-newest" });
    const older = chunk({ sourceOrderId: "order-older" });
    const { covered } = groupQuoteChunks(quoteResponse([newest, older]));
    expect(covered[0]).toBe(newest);
    expect(covered[1]).toBe(older);
  });

  it("returns an empty excess array when the quote returns no unmatched chunk", () => {
    const { excess } = groupQuoteChunks(quoteResponse([chunk()]));
    expect(excess).toEqual([]);
  });
});

describe("sumChunkTotals — sums already-priced figures, never derives a new price", () => {
  it("totals equal the sum of each chunk's own already-rounded components", () => {
    const chunks = [
      chunk({ subtotal: 20, taxAmount: 2, categoryTax: 0.5 }),
      chunk({ subtotal: 30, taxAmount: 3, categoryTax: 1 }),
    ];
    expect(sumChunkTotals(chunks)).toEqual({
      subtotal: 50,
      taxAmount: 5,
      categoryTax: 1.5,
      total: 56.5,
    });
  });

  it("is zero for an empty chunk list", () => {
    expect(sumChunkTotals([])).toEqual({ subtotal: 0, taxAmount: 0, categoryTax: 0, total: 0 });
  });
});

describe("DEFAULT_EXCESS_OPTION", () => {
  it("defaults to credit at current price", () => {
    expect(DEFAULT_EXCESS_OPTION).toBe("CREDIT_AT_CURRENT_PRICE");
  });
});

describe("dropExcessAndRequote — option 3, 'return only what was bought'", () => {
  it("caps each product at its covered (matched) pieces and drops the excess", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 });
    const req = dropExcessAndRequote("cust-1", quoteResponse([covered, excess]));
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 4 }]);
  });

  it("drops a product entirely when it had zero covered pieces (pure excess)", () => {
    const excessOnly = chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 });
    const req = dropExcessAndRequote("cust-1", quoteResponse([excessOnly]));
    expect(req.items).toEqual([]);
  });

  it("sums covered pieces across multiple invoice lines for the same product", () => {
    const a = chunk({ productId: "prod-1", sourceOrderId: "order-a", pieces: 3 });
    const b = chunk({ productId: "prod-1", sourceOrderId: "order-b", pieces: 2 });
    const req = dropExcessAndRequote("cust-1", quoteResponse([a, b]));
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 5 }]);
  });
});

describe("buildCaptureRequest — quantities only, never a price the quote displayed", () => {
  it("sends only productId/qty/boxes/pieces/reason/condition per item — no price field", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ productId: "prod-1", boxes: "1", pieces: "2", note: "box dented" })],
      returnKey: "key-1",
      reason: "DAMAGED",
    });
    expect(req.items).toEqual([
      { productId: "prod-1", qty: 1, boxes: 1, pieces: 2, condition: "box dented" },
    ]);
    const serialized = JSON.stringify(req);
    // Never leak a subtotal/unitPrice/total the quote screen rendered.
    expect(serialized).not.toMatch(/subtotal|unitPrice|taxAmount|categoryTax|"total"/i);
  });

  it("carries the required returnKey unchanged", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ pieces: "1" })],
      returnKey: "stable-key-123",
      reason: "EXCESS_ORDER",
    });
    expect(req.returnKey).toBe("stable-key-123");
  });

  it("uses a line's own reason override when set, else falls back at capture level only", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ productId: "prod-1", pieces: "1", reason: "QUALITY_ISSUE" })],
      returnKey: "key-1",
      reason: "DAMAGED",
    });
    expect(req.items[0].reason).toBe("QUALITY_ISSUE");
    expect(req.reason).toBe("DAMAGED");
  });

  it("drops a line with no qty entered", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ productId: "prod-1", pieces: "1" }), line({ productId: "prod-2" })],
      returnKey: "key-1",
      reason: "DAMAGED",
    });
    expect(req.items.map((i) => i.productId)).toEqual(["prod-1"]);
  });
});

describe("mintReturnKey", () => {
  it("mints a well-formed UUID", () => {
    expect(mintReturnKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("mints a different value on each call (the caller, not this function, holds it stable)", () => {
    expect(mintReturnKey()).not.toBe(mintReturnKey());
  });
});

describe("extractRefusalMessage", () => {
  it("renders the fixed copy for a 403 ADDON_GATE refusal, not the guard's own wording", () => {
    const err = {
      response: {
        status: 403,
        data: {
          code: "ADDON_GATE",
          message: 'This feature requires the "orders_inline_returns" add-on.',
        },
      },
    };
    expect(extractRefusalMessage(err)).toBe(RETURNS_NOT_ENABLED_MESSAGE);
  });

  it("renders the fixed copy for a 403 PLAN_GATE refusal", () => {
    const err = { response: { status: 403, data: { code: "PLAN_GATE", message: "upgrade" } } };
    expect(extractRefusalMessage(err)).toBe(RETURNS_NOT_ENABLED_MESSAGE);
  });

  it("renders the fixed copy for any bare 403 with no code (defensive default)", () => {
    const err = { response: { status: 403, data: { message: "Forbidden" } } };
    expect(extractRefusalMessage(err)).toBe(RETURNS_NOT_ENABLED_MESSAGE);
  });

  it("renders the API's own message verbatim for a business refusal (not 403)", () => {
    const err = {
      response: {
        status: 400,
        data: { message: "Cannot capture a return against a cancelled order" },
      },
    };
    expect(extractRefusalMessage(err)).toBe("Cannot capture a return against a cancelled order");
  });

  it("joins an array message", () => {
    const err = { response: { status: 400, data: { message: ["a", "b"] } } };
    expect(extractRefusalMessage(err)).toBe("a b");
  });

  it("falls back for a shape with no response body", () => {
    expect(extractRefusalMessage(new Error("network down"), "fallback text")).toBe("fallback text");
  });
});
