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
  keyReusedReturnOf,
  INLINE_RETURN_KEY_REUSED_CODE,
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

  it("includes routeRunStopId only when supplied (driver captures)", () => {
    expect(buildQuoteRequest("cust-1", [line({ pieces: "1" })])).not.toHaveProperty(
      "routeRunStopId",
    );
    expect(buildQuoteRequest("cust-1", [line({ pieces: "1" })], "stop-1").routeRunStopId).toBe(
      "stop-1",
    );
  });

  // SA-101(2)/B3/B765: `lines` is keyed by productId elsewhere in the dialog
  // (updateLine/removeLine), so a source order with two lines of one product (a Case line
  // and a pack line, say) can hydrate two draft rows sharing a productId. Before this fix
  // each became its OWN request item; the server's per-item allocation re-derives its
  // remaining-supply view fresh per item rather than decrementing a shared one, so two
  // items for one product would each draw against the SAME undiminished supply — a silent
  // double-count. This pins that the request always merges them into ONE item.
  it("merges two draft rows sharing a productId into ONE request item, summing boxes/pieces (never double-counted)", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", boxes: "1", pieces: "0" }),
      line({ productId: "prod-1", boxes: "0", pieces: "5" }),
    ]);
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 5 }]);
  });

  it("three rows sharing a productId still merge into one — not just a pairwise merge", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", pieces: "2" }),
      line({ productId: "prod-1", pieces: "3" }),
      line({ productId: "prod-1", pieces: "4" }),
    ]);
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 9 }]);
  });

  it("does NOT merge across different products — each keeps its own item", () => {
    const req = buildQuoteRequest("cust-1", [
      line({ productId: "prod-1", pieces: "2" }),
      line({ productId: "prod-2", pieces: "3" }),
    ]);
    expect(req.items).toEqual(
      expect.arrayContaining([
        { productId: "prod-1", qty: 1, boxes: 0, pieces: 2 },
        { productId: "prod-2", qty: 1, boxes: 0, pieces: 3 },
      ]),
    );
    expect(req.items).toHaveLength(2);
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

// #2693: what option 3 can do BEFORE any re-quote is sent. Resolved at call time so a missing
// export fails these cases (red) rather than the whole file.
const pkg = require("./inline-return-state");

describe("#2693: 'return only what was bought' availability", () => {
  it("an all-excess quote (nothing matched to any invoice) cannot return only what was bought", () => {
    const quote = quoteResponse([chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 })]);
    expect(pkg.canReturnOnlyPurchased(quote)).toBe(false);
  });

  it("a quote with any covered piece can", () => {
    const quote = quoteResponse([
      chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 }),
      chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 }),
    ]);
    expect(pkg.canReturnOnlyPurchased(quote)).toBe(true);
  });

  it("names every product that drops to zero (bought never), in line order, each once", () => {
    const quote = quoteResponse([
      chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 }),
      chunk({ productId: "prod-1", sourceOrderId: null, pieces: 2 }),
      chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 }),
      chunk({ productId: "prod-3", sourceOrderId: null, pieces: 1 }),
      chunk({ productId: "prod-3", sourceOrderId: null, pieces: 1 }),
    ]);
    const lines = [
      { productId: "prod-3", productName: "Gadget" },
      { productId: "prod-1", productName: "Widget" },
      { productId: "prod-2", productName: "Sprocket" },
    ];
    expect(pkg.notBoughtBeforeNames(quote, lines)).toEqual(["Gadget", "Sprocket"]);
  });

  it("the friendly text is the owner's wording, never the DTO's", () => {
    expect(pkg.NOTHING_BOUGHT_BEFORE_MESSAGE).toBe(
      "This customer hasn't bought these items before — there's no invoice to return them against.",
    );
  });
});

describe("applyCoveredPiecesToLines — keeps Step 1's own state in sync with option 3", () => {
  it("caps a line's boxes/pieces to the covered total so a later capture never over-sends", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 });
    const lines = [line({ productId: "prod-1", boxes: "0", pieces: "10" })];
    const result = applyCoveredPiecesToLines(lines, quoteResponse([covered, excess]));
    expect(result).toEqual([{ ...lines[0], boxes: "0", pieces: "4" }]);
  });

  it("removes a line entirely when its product had zero covered pieces", () => {
    const excessOnly = chunk({ productId: "prod-2", sourceOrderId: null, pieces: 9 });
    const lines = [line({ productId: "prod-2", pieces: "9" })];
    expect(applyCoveredPiecesToLines(lines, quoteResponse([excessOnly]))).toEqual([]);
  });

  it("leaves other fields (reason, note, productName) untouched", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const lines = [
      line({ productId: "prod-1", pieces: "10", reason: "DAMAGED", note: "dented box" }),
    ];
    const result = applyCoveredPiecesToLines(lines, quoteResponse([covered]));
    expect(result[0]).toMatchObject({ reason: "DAMAGED", note: "dented box", pieces: "4" });
  });

  // SA-108b (Opus review of #1293): TWO rows of the SAME product (SA-108's own fix made this
  // possible — a source order with a Case line and a pack line hydrate as two independently
  // editable rows). Before this fix, BOTH rows were set to the FULL covered total, and
  // buildCaptureRequest's own (correct) productId merge then summed them — a silent 2x credit.
  it("two rows of the same product: the FIRST gets the covered total, siblings are zeroed — never each getting the full amount", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const lines = [
      line({ productId: "prod-1", pieces: "3", note: "row A" }),
      line({ productId: "prod-1", pieces: "7", note: "row B" }),
    ];
    const result = applyCoveredPiecesToLines(lines, quoteResponse([covered]));
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ note: "row A", pieces: "4" });
    expect(result[1]).toMatchObject({ note: "row B", pieces: "0" });
    // Never both rows carrying the covered amount — that's the exact double-count the fix
    // guards against.
    expect(result.filter((l) => l.pieces === "4")).toHaveLength(1);
  });

  it("the zeroed sibling naturally drops out of the built request — buildCaptureRequest filters boxes/pieces both 0", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const lines = [
      line({ productId: "prod-1", pieces: "3" }),
      line({ productId: "prod-1", pieces: "7" }),
    ];
    const applied = applyCoveredPiecesToLines(lines, quoteResponse([covered]));
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: applied,
      returnKey: "key-1",
      reason: "DAMAGED",
    });
    // Exactly the covered amount — never 8 (4+4, the pre-fix double-count).
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 0, pieces: 4 }]);
  });
});

describe("coveredPiecesByProduct", () => {
  it("sums only covered (matched) chunks — never the excess chunk", () => {
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 6 });
    const result = coveredPiecesByProduct(quoteResponse([covered, excess]));
    expect(result.get("prod-1")).toBe(4);
  });
});

describe("invariant: submitted quantities never diverge from the last displayed quote (SA-071b §8.1a(5))", () => {
  // Amendment to SA-071b §5 following the 36b5a200 fix: "the client sends quantities only"
  // protects PRICES (the server recomputes money), but is not by itself sufficient — the
  // submitted quantities must derive from the SAME state the displayed quote was computed
  // against, and every re-quote must write back into the submit-state. A screen that can
  // re-quote without syncing its own submit-state is a money bug every server-side price
  // guard passes, because the server prices whatever quantity it's handed correctly.
  it("after applyCoveredPiecesToLines, a line's own pieces exactly equal the quote's covered total for its product — never more, never less", () => {
    const products = [
      { productId: "prod-1", covered: 4, excess: 6 },
      { productId: "prod-2", covered: 7, excess: 0 },
    ];
    const chunks = products.flatMap(({ productId, covered, excess }) => [
      chunk({ productId, sourceOrderId: "order-1", pieces: covered }),
      ...(excess > 0 ? [chunk({ productId, sourceOrderId: null, pieces: excess })] : []),
    ]);
    const quote = quoteResponse(chunks);
    const lines = products.map(
      ({ productId, covered, excess }) => line({ productId, pieces: String(covered + excess) }), // Step 1's original, larger ask
    );

    const synced = applyCoveredPiecesToLines(lines, quote);
    const totals = coveredPiecesByProduct(quote);

    for (const l of synced) {
      expect(Number(l.pieces)).toBe(totals.get(l.productId));
    }
    // The invariant covers every product the quote priced — not just the first one.
    expect(synced.map((l) => l.productId).sort()).toEqual(
      [...totals.keys()].filter((k) => (totals.get(k) ?? 0) > 0).sort(),
    );
  });

  it("RED case from the ruling: without the sync, a stale line would still carry the ORIGINAL over-return amount", () => {
    // This is the exact shape of the bug 36b5a200 fixed: a line built from Step 1's raw input
    // (never passed through applyCoveredPiecesToLines) still holds the original, larger ask —
    // demonstrating why "the client sends quantities only" is not sufficient on its own.
    const covered = chunk({ productId: "prod-1", sourceOrderId: "order-1", pieces: 4 });
    const excess = chunk({ productId: "prod-1", sourceOrderId: null, pieces: 12 });
    const quote = quoteResponse([covered, excess]);
    const staleLine = line({ productId: "prod-1", pieces: "16" }); // never synced

    expect(Number(staleLine.pieces)).not.toBe(coveredPiecesByProduct(quote).get("prod-1"));
    expect(Number(staleLine.pieces)).toBe(16); // the divergence the ruling names
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

  // SA-101(2)/B3/B765 — same double-count guard as buildQuoteRequest's, on the capture path.
  it("merges two draft rows sharing a productId into ONE capture item, summing boxes/pieces", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [
        line({ productId: "prod-1", boxes: "1", pieces: "0" }),
        line({ productId: "prod-1", boxes: "0", pieces: "3" }),
      ],
      returnKey: "key-1",
      reason: "DAMAGED",
    });
    expect(req.items).toEqual([{ productId: "prod-1", qty: 1, boxes: 1, pieces: 3 }]);
  });

  it("merging keeps the FIRST occurrence's reason/condition — quantities are the only thing summed", () => {
    const req = buildCaptureRequest({
      customerId: "cust-1",
      orderId: "order-1",
      lines: [
        line({ productId: "prod-1", pieces: "2", reason: "DAMAGED", note: "first row" }),
        line({ productId: "prod-1", pieces: "3", reason: "WRONG_ITEM", note: "second row" }),
      ],
      returnKey: "key-1",
      reason: "QUALITY_ISSUE",
    });
    expect(req.items).toEqual([
      {
        productId: "prod-1",
        qty: 1,
        boxes: 0,
        pieces: 5,
        reason: "DAMAGED",
        condition: "first row",
      },
    ]);
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

describe("keyReusedReturnOf (#2647)", () => {
  const err = (data: unknown, status = 409) => ({ response: { status, data } });
  it("returns the recorded return from a key-reused 409 body", () => {
    expect(
      keyReusedReturnOf(
        err({ code: INLINE_RETURN_KEY_REUSED_CODE, returnId: "r1", returnNumber: "RET-1" }),
      ),
    ).toEqual({ returnId: "r1", returnNumber: "RET-1" });
  });
  it("a missing returnNumber is null, not undefined", () => {
    expect(keyReusedReturnOf(err({ code: INLINE_RETURN_KEY_REUSED_CODE, returnId: "r1" }))).toEqual(
      { returnId: "r1", returnNumber: null },
    );
  });
  it.each([
    ["another code", err({ code: "INLINE_RETURN_KEY_CONFLICT", returnId: "r1" })],
    ["no returnId", err({ code: INLINE_RETURN_KEY_REUSED_CODE })],
    ["an empty returnId", err({ code: INLINE_RETURN_KEY_REUSED_CODE, returnId: "" })],
    ["no response", new Error("network")],
    ["undefined", undefined],
  ])("%s ⇒ null", (_n, e) => {
    expect(keyReusedReturnOf(e)).toBeNull();
  });
});
