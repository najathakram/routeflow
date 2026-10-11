import {
  STOCK_COUNT_FINISH_WITH_SKIPS_LABEL,
  STOCK_COUNT_RECOUNT_COPY,
  stockCountCommitFailure,
  stockCountSavingCopy,
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
});
