import {
  STOCK_COUNT_FINISH_WITH_SKIPS_LABEL,
  STOCK_COUNT_RECOUNT_COPY,
  STOCK_COUNT_ENTER_AS_YOU_GO_COPY,
  stockCountCommitFailure,
  stockCountProductInOpenCount,
  stockCountSavingCopy,
} from "@routeflow/types";

/**
 * SA-767 L-2.4 D (r-note 4 D, G7): the copy of a stock-count commit, by state. Exact sentences are
 * pinned; the numbers come from structured body fields and nothing of the server's message is shown.
 */
const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("stockCountCommitFailure", () => {
  it("503 with committedLines > 0: Partly saved", () => {
    const f = stockCountCommitFailure(
      err(503, {
        code: "LOCK_UNAVAILABLE",
        message: "RAW SERVER TEXT",
        committedLines: 50,
        totalLines: 120,
      }),
    );
    expect(f).toEqual({ copy: "Partly saved — commit again to finish", permanent: false });
  });

  it.each([
    ["committedLines 0", { committedLines: 0, totalLines: 120 }],
    ["no progress fields", {}],
  ])("503 with %s: Nothing was saved", (_n, extra) => {
    const f = stockCountCommitFailure(err(503, { code: "LOCK_UNAVAILABLE", ...extra }));
    expect(f).toEqual({ copy: "Nothing was saved — try again", permanent: false });
  });

  it("409 STOCK_COUNT_COMMITTING: the being-saved sentence", () => {
    expect(stockCountCommitFailure(err(409, { code: "STOCK_COUNT_COMMITTING" }))).toEqual({
      copy: "This count is being saved. Try again in a moment.",
      permanent: false,
    });
  });

  it.each([
    ["a product family (400)", err(400, { code: "FAMILY_NOT_SELLABLE" })],
    ["a deleted product (404)", err(404, { missingProductIds: ["p1"] })],
  ])("%s is a permanent refusal", (_n, e) => {
    expect(stockCountCommitFailure(e)).toMatchObject({ permanent: true });
  });

  it.each([
    ["a 500", err(500, {})],
    ["a 400 without a code", err(400, { message: "x" })],
    ["no response (network)", new Error("Network Error")],
    ["null", null],
  ])("%s has no count-specific copy (the caller keeps its generic message)", (_n, e) => {
    expect(stockCountCommitFailure(e)).toBeNull();
  });
});

describe("stock-count commit copy", () => {
  it("Saving count… N of M", () => {
    expect(stockCountSavingCopy({ committedLines: 5, totalLines: 12 })).toBe(
      "Saving count… 5 of 12",
    );
  });

  it("the finish-with-skips button and the recount line", () => {
    expect(STOCK_COUNT_FINISH_WITH_SKIPS_LABEL).toBe("Finish with skips");
    expect(STOCK_COUNT_RECOUNT_COPY).toBe("Recount these in a new session");
  });
});

// SA-767 r-note 5: one open count per product (SA-3), and the count screen help line (residual).
describe("one open count per product copy", () => {
  it("an add refused by another open count: Already being counted in <session>, with its id for the link", () => {
    const e = err(409, {
      code: "PRODUCT_IN_OPEN_COUNT",
      message: "RAW SERVER TEXT",
      sessionId: "sess-9",
      sessionName: "Aisle 3",
    });
    expect(stockCountProductInOpenCount(e)).toEqual({
      copy: "Already being counted in Aisle 3",
      sessionId: "sess-9",
    });
  });

  it('an unnamed session reads "another count"', () => {
    expect(
      stockCountProductInOpenCount(
        err(409, { code: "PRODUCT_IN_OPEN_COUNT", sessionId: "s", sessionName: null }),
      )?.copy,
    ).toBe("Already being counted in another count");
  });

  it.each([
    ["another 409", err(409, { code: "STOCK_COUNT_COMMITTING" })],
    ["a 400", err(400, { code: "PRODUCT_IN_OPEN_COUNT" })],
    ["no response", new Error("Network Error")],
    ["null", null],
  ])("%s is not this refusal", (_n, e) => {
    expect(stockCountProductInOpenCount(e)).toBeNull();
  });

  it("a commit refused for a legacy overlap has its own non-permanent sentence", () => {
    expect(
      stockCountCommitFailure(
        err(409, {
          code: "PRODUCT_IN_OPEN_COUNT",
          conflicts: [{ productId: "p1", sessionId: "s", sessionName: "Aisle 3" }],
        }),
      ),
    ).toEqual({
      copy: "Some products are also in another open count. Remove them from one count, then commit again.",
      permanent: false,
    });
  });

  it("the count screen help line", () => {
    expect(STOCK_COUNT_ENTER_AS_YOU_GO_COPY).toBe(
      "Enter counts as you go, right after you count each product.",
    );
  });
});
