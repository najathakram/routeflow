import {
  applyCoveredPiecesToLines,
  buildCaptureRequest,
  buildQuoteRequest,
  coveredPiecesByProduct,
  DEFAULT_EXCESS_OPTION,
  dropExcessAndRequote,
  extractRefusalMessage,
  groupQuoteChunks,
  hasAnyQtyEntered,
  isBoxedProduct,
  RETURNS_NOT_ENABLED_MESSAGE,
  submitKeyItemsFrom,
  sumChunkTotals,
  type InlineReturnLineDraft,
} from "../lib/inline-return-state";
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
  });
});

describe("hasAnyQtyEntered", () => {
  it("is false when every line is empty, true when any has boxes or pieces", () => {
    expect(hasAnyQtyEntered([line(), line({ productId: "p2" })])).toBe(false);
    expect(hasAnyQtyEntered([line({ boxes: "1" })])).toBe(true);
    expect(hasAnyQtyEntered([line({ pieces: "3" })])).toBe(true);
  });

  it("ignores a zero or garbage entry", () => {
    expect(hasAnyQtyEntered([line({ boxes: "0", pieces: "0" })])).toBe(false);
    expect(hasAnyQtyEntered([line({ boxes: "abc" })])).toBe(false);
  });
});

describe("buildQuoteRequest — never a bare qty", () => {
  it("always sends boxes AND pieces explicitly for a boxed product", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", unitsPerBox: 12, boxes: "2", pieces: "3" }),
    ]);
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 2, pieces: 3 }]);
    expect(req.items[0].qty).not.toBe(2);
    expect(req.items[0].qty).not.toBe(3);
  });

  it("also sends boxes AND pieces explicitly for a non-boxed product", () => {
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

  it("includes routeRunStopId only when supplied (driver captures)", () => {
    expect(buildQuoteRequest("cust-1", [line({ pieces: "1" })])).not.toHaveProperty(
      "routeRunStopId",
    );
    expect(buildQuoteRequest("cust-1", [line({ pieces: "1" })], "stop-1").routeRunStopId).toBe(
      "stop-1",
    );
  });
});

describe("groupQuoteChunks", () => {
  it("splits covered from excess and preserves the API's own order", () => {
    const covered1 = chunk({ sourceOrderId: "order-newest", pieces: 5 });
    const covered2 = chunk({ sourceOrderId: "order-older", pieces: 3 });
    const excess = chunk({ sourceOrderId: null, pieces: 2 });
    const { covered, excess: excessChunks } = groupQuoteChunks(
      quoteResponse([covered1, covered2, excess]),
    );
    expect(covered).toEqual([covered1, covered2]);
    expect(excessChunks).toEqual([excess]);
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
});

describe("DEFAULT_EXCESS_OPTION", () => {
  it("defaults to credit at current price", () => {
    expect(DEFAULT_EXCESS_OPTION).toBe("CREDIT_AT_CURRENT_PRICE");
  });
});

describe("dropExcessAndRequote — option 3", () => {
  it("caps each product at its covered pieces and drops the excess", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 });
    const req = dropExcessAndRequote("cust-1", quoteResponse([covered, excess]));
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 4 }]);
  });

  it("drops a product entirely when it had zero covered pieces", () => {
    const excessOnly = chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 });
    expect(dropExcessAndRequote("cust-1", quoteResponse([excessOnly])).items).toEqual([]);
  });
});

describe("applyCoveredPiecesToLines / invariant: submitted quantities never diverge from the last displayed quote (SA-071b §8.1a(5))", () => {
  it("caps a line's boxes/pieces to the covered total so a later capture never over-sends", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 });
    const lines = [line({ productId: "prod-1", pieces: "10" })];
    const result = applyCoveredPiecesToLines(lines, quoteResponse([covered, excess]));
    expect(result).toEqual([{ ...lines[0], boxes: "0", pieces: "4" }]);
  });

  it("removes a line entirely when its product had zero covered pieces", () => {
    const excessOnly = chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 });
    const lines = [line({ productId: "prod-2", pieces: "9" })];
    expect(applyCoveredPiecesToLines(lines, quoteResponse([excessOnly]))).toEqual([]);
  });

  it("RED case from the ruling: an unsynced line still carries the ORIGINAL over-return amount", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 12 });
    const quote = quoteResponse([covered, excess]);
    const staleLine = line({ productId: "prod-1", pieces: "16" }); // never synced
    expect(Number(staleLine.pieces)).not.toBe(coveredPiecesByProduct(quote).get("prod-1"));
    expect(Number(staleLine.pieces)).toBe(16);
  });

  it("holds across multiple products in one quote", () => {
    const chunks = [
      chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 }),
      chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 }),
      chunk({ productId: "prod-2", sourceOrderId: "order-1", pieces: 7 }),
    ];
    const quote = quoteResponse(chunks);
    const lines = [
      line({ productId: "prod-1", pieces: "10" }),
      line({ productId: "prod-2", pieces: "7" }),
    ];
    const synced = applyCoveredPiecesToLines(lines, quote);
    const totals = coveredPiecesByProduct(quote);
    for (const l of synced) {
      expect(Number(l.pieces)).toBe(totals.get(l.productId));
    }
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
    expect(JSON.stringify(req)).not.toMatch(/subtotal|unitPrice|taxAmount|categoryTax|"total"/i);
  });

  it("carries the required returnKey unchanged (caller-derived, never minted here)", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ pieces: "1" })],
      returnKey: "stable-key-123",
      reason: "EXCESS_ORDER",
    });
    expect(req.returnKey).toBe("stable-key-123");
  });

  it("a line's own reason override wins over the capture-level fallback", () => {
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

  it("includes routeRunStopId only for a driver capture", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [line({ pieces: "1" })],
      returnKey: "key-1",
      reason: "DAMAGED",
      routeRunStopId: "stop-1",
    });
    expect(req.routeRunStopId).toBe("stop-1");
  });
});

describe("submitKeyItemsFrom", () => {
  it("mirrors buildCaptureRequest's own quantity filter/shape, for the submit-key derivation", () => {
    const lines = [
      line({ productId: "prod-1", boxes: "1", pieces: "2" }),
      line({ productId: "prod-2" }), // no qty — dropped
    ];
    expect(submitKeyItemsFrom(lines)).toEqual([{ productId: "prod-1", boxes: 1, pieces: 2 }]);
  });
});

describe("extractRefusalMessage", () => {
  it("renders the fixed copy for a 403 ADDON_GATE refusal", () => {
    const err = {
      response: { status: 403, data: { code: "ADDON_GATE", message: "guard wording" } },
    };
    expect(extractRefusalMessage(err)).toBe(RETURNS_NOT_ENABLED_MESSAGE);
  });

  it("renders the API's own message verbatim for a business refusal", () => {
    const err = {
      response: {
        status: 400,
        data: { message: "Cannot capture a return against a cancelled order" },
      },
    };
    expect(extractRefusalMessage(err)).toBe("Cannot capture a return against a cancelled order");
  });

  it("joins an array message", () => {
    expect(
      extractRefusalMessage({ response: { status: 400, data: { message: ["a", "b"] } } }),
    ).toBe("a b");
  });

  it("falls back for a shape with no response body", () => {
    expect(extractRefusalMessage(new Error("network down"), "fallback")).toBe("fallback");
  });
});
