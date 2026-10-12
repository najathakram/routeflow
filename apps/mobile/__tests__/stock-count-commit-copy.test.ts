import {
  STOCK_COUNT_FINISH_WITH_SKIPS_LABEL,
  STOCK_COUNT_RECOUNT_COPY,
  STOCK_COUNT_ENTER_AS_YOU_GO_COPY,
  stockCountCommitFailure,
  stockCountProductInOpenCount,
  stockCountCommitPollMs,
  stockCountSavingCopy,
  stockCountSavingLine,
} from "@routeflow/types/stock-count-commit-copy";

/**
 * SA-767 L-2.4 D: the mobile count screen reads the same shared copy as web. Exact sentences pinned;
 * the web test (`apps/web/lib/stock-count-commit-copy.test.ts`) covers the full state table.
 */
const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("stock-count commit copy (mobile)", () => {
  it("503 by committedLines: Partly saved / Nothing was saved", () => {
    expect(
      stockCountCommitFailure(err(503, { code: "LOCK_UNAVAILABLE", committedLines: 3 }))?.copy,
    ).toBe("Partly saved — commit again to finish");
    expect(
      stockCountCommitFailure(err(503, { code: "LOCK_UNAVAILABLE", committedLines: 0 }))?.copy,
    ).toBe("Nothing was saved — try again");
  });

  it("a permanent refusal is flagged so the screen can offer Finish with skips", () => {
    expect(stockCountCommitFailure(err(400, { code: "FAMILY_NOT_SELLABLE" }))?.permanent).toBe(
      true,
    );
    expect(STOCK_COUNT_FINISH_WITH_SKIPS_LABEL).toBe("Finish with skips");
    expect(STOCK_COUNT_RECOUNT_COPY).toBe("Recount these in a new session");
  });

  it("Saving count… N of M", () => {
    expect(stockCountSavingCopy({ committedLines: 2, totalLines: 9 })).toBe("Saving count… 2 of 9");
  });

  // n3: the review screen's "Saving count… N of M" line - one selection shared with web.
  describe("stockCountSavingLine / stockCountCommitPollMs", () => {
    it("the detail's commit progress wins (numbers), pending or not", () => {
      const commit = { committedLines: 4, totalLines: 12 };
      expect(stockCountSavingLine({ pending: true, commit })).toBe("Saving count… 4 of 12");
      expect(stockCountSavingLine({ pending: false, commit })).toBe("Saving count… 4 of 12");
    });

    it("a commit in flight with no detail progress yet is the bare line", () => {
      expect(stockCountSavingLine({ pending: true, commit: null })).toBe("Saving count…");
      expect(stockCountSavingLine({ pending: true })).toBe("Saving count…");
    });

    it("nothing pending and no unfinished commit: no line", () => {
      expect(stockCountSavingLine({ pending: false, commit: null })).toBeNull();
      expect(stockCountSavingLine({ pending: false })).toBeNull();
    });

    it("the detail is polled every 2 s only while the commit mutation is pending, then stops", () => {
      expect(stockCountCommitPollMs(true)).toBe(2000);
      expect(stockCountCommitPollMs(false)).toBe(false);
    });
  });

  // SA-767 r-note 5 SA-3: the same shared copy as web, and the code is in the mobile types stub.
  describe("one open count per product", () => {
    it("PRODUCT_IN_OPEN_COUNT is a registered API error code", () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { API_ERROR_CODES } = require("@routeflow/types");
      expect(API_ERROR_CODES.PRODUCT_IN_OPEN_COUNT).toBe("PRODUCT_IN_OPEN_COUNT");
    });

    it("an add refused by another open count: Already being counted in <session>", () => {
      expect(
        stockCountProductInOpenCount(
          err(409, { code: "PRODUCT_IN_OPEN_COUNT", sessionId: "s9", sessionName: "Aisle 3" }),
        ),
      ).toEqual({ copy: "Already being counted in Aisle 3", sessionId: "s9" });
      expect(stockCountProductInOpenCount(err(409, { code: "STOCK_COUNT_COMMITTING" }))).toBeNull();
    });

    it("the commit overlap sentence and the help line", () => {
      expect(
        stockCountCommitFailure(err(409, { code: "PRODUCT_IN_OPEN_COUNT", conflicts: [] }))?.copy,
      ).toBe(
        "Some products are also in another open count. Remove them from one count, then commit again.",
      );
      expect(STOCK_COUNT_ENTER_AS_YOU_GO_COPY).toBe(
        "Enter counts as you go, right after you count each product.",
      );
    });
  });
});
