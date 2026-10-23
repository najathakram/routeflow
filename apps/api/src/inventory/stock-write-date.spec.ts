import { BadRequestException, ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { stockWriteDate } from "./stock-write-date";

/**
 * Row 563 (SA-794 → SA-802 → SA-802a / SA-808a): the ONE date gate for every stock write whose date a person chose. A date
 * before the latest filed period's close (`filedThrough`: a non-FAILED tobacco report for a tobacco product, a GENERATED or
 * LOCKED filing for its tracked category) would change a filed figure, so it is REFUSED (409 STOCK_DATE_IN_FILED_PERIOD,
 * naming the period). Never clamped: the person chose the date. Future dates keep the existing 400; no date means now.
 */
const NOW = new Date("2026-10-23T12:00:00.000Z");
const SEPT = {
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-09-30T23:59:59.999Z"), // tobacco reports store an INCLUSIVE end
};
const SEPT_FILING = {
  periodStart: new Date("2026-09-01T00:00:00.000Z"),
  periodEnd: new Date("2026-10-01T00:00:00.000Z"), // filings store an EXCLUSIVE end
  periodKey: "2026-09",
  cadence: "MONTHLY",
};

function db(opts: {
  products?: Array<{
    id: string;
    isTobacco?: boolean;
    trackedCategoryId?: string | null;
    categoryName?: string;
  }>;
  report?: unknown;
  filing?: unknown;
}) {
  return {
    product: {
      findMany: jest.fn().mockResolvedValue(
        (opts.products ?? []).map((p) => ({
          id: p.id,
          isTobacco: !!p.isTobacco,
          trackedCategoryId: p.trackedCategoryId ?? null,
          trackedCategory: p.trackedCategoryId ? { name: p.categoryName ?? "Vapes" } : null,
        })),
      ),
    },
    tobaccoReport: { findFirst: jest.fn().mockResolvedValue(opts.report ?? null) },
    regulatedFiling: { findFirst: jest.fn().mockResolvedValue(opts.filing ?? null) },
  };
}
const call = (d: ReturnType<typeof db>, raw: string | undefined, productIds = ["p1"]) =>
  stockWriteDate(d, { tenantId: "t1", productIds, raw, now: NOW });
const conflict = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ConflictException);
    return (e as ConflictException).getResponse() as Record<string, unknown>;
  }
  throw new Error("expected a 409");
};

describe("stockWriteDate (row 563)", () => {
  it("no date: now, and nothing is read", async () => {
    const d = db({ products: [{ id: "p1", isTobacco: true }], report: SEPT });
    await expect(call(d, undefined)).resolves.toEqual(NOW);
    expect(d.product.findMany).not.toHaveBeenCalled();
  });

  it("a future date (beyond the 5-minute skew) is refused with the existing 400, before any read", async () => {
    const d = db({ products: [{ id: "p1", isTobacco: true }] });
    await expect(call(d, "2026-10-24T00:00:00.000Z")).rejects.toBeInstanceOf(BadRequestException);
    expect(d.product.findMany).not.toHaveBeenCalled();
  });

  it("a tobacco product backdated into a reported (GENERATED) month: 409 naming the month", async () => {
    const d = db({ products: [{ id: "p1", isTobacco: true }], report: SEPT });
    const body = await conflict(call(d, "2026-09-15T10:00:00.000Z"));
    expect(body).toMatchObject({
      code: API_ERROR_CODES.STOCK_DATE_IN_FILED_PERIOD,
      productId: "p1",
      period: "September 2026",
    });
    expect(String(body.message)).toMatch(/September 2026/);
  });

  it("a date in an unfiled month BEFORE a filed one is refused too (SA-802a: date < filedThrough)", async () => {
    const d = db({ products: [{ id: "p1", trackedCategoryId: "cat-1" }], filing: SEPT_FILING });
    const body = await conflict(call(d, "2026-08-20T10:00:00.000Z"));
    expect(body).toMatchObject({ period: "September 2026" });
  });

  it("the boundary: the filed period's close is accepted; 1 ms before it is refused", async () => {
    const d = db({ products: [{ id: "p1", trackedCategoryId: "cat-1" }], filing: SEPT_FILING });
    await expect(call(d, "2026-10-01T00:00:00.000Z")).resolves.toEqual(
      new Date("2026-10-01T00:00:00.000Z"),
    );
    await conflict(call(d, "2026-09-30T23:59:59.999Z"));
  });

  it("a non-regulated product is never refused (backdating stays allowed)", async () => {
    const d = db({ products: [{ id: "p1" }], report: SEPT, filing: SEPT_FILING });
    await expect(call(d, "2026-09-15T10:00:00.000Z")).resolves.toEqual(
      new Date("2026-09-15T10:00:00.000Z"),
    );
  });

  it("a FAILED tobacco month with no later filed month is open (the lookup skips FAILED)", async () => {
    const d = db({ products: [{ id: "p1", isTobacco: true }], report: null });
    await expect(call(d, "2026-09-15T10:00:00.000Z")).resolves.toBeInstanceOf(Date);
    expect(d.tobaccoReport.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { not: "FAILED" } }),
      }),
    );
  });

  it("a mixed write (one regulated product, one plain) is refused as a whole", async () => {
    const d = db({
      products: [{ id: "plain" }, { id: "tob", isTobacco: true }],
      report: SEPT,
    });
    const body = await conflict(call(d, "2026-09-15T10:00:00.000Z", ["plain", "tob"]));
    expect(body).toMatchObject({ productId: "tob" });
  });

  it("refuses to run without a tenant (a filing lookup with no tenant would call every period open)", async () => {
    const d = db({ products: [{ id: "p1", isTobacco: true }], report: SEPT });
    await expect(
      stockWriteDate(d, {
        tenantId: null,
        productIds: ["p1"],
        raw: "2026-09-15T10:00:00.000Z",
        now: NOW,
      }),
    ).rejects.toThrow(/tenant/);
  });

  describe("W-755 (SA-894 LOW-1, SA-802a): the boundary, latest wins, the message names WHAT is filed, one read per key", () => {
    it("tobacco's INCLUSIVE periodEnd + 1 ms is the close: the next month's first instant is accepted, the last ms refused", async () => {
      const d = db({ products: [{ id: "p1", isTobacco: true }], report: SEPT });
      await expect(call(d, "2026-10-01T00:00:00.000Z")).resolves.toEqual(
        new Date("2026-10-01T00:00:00.000Z"),
      );
      await conflict(call(d, "2026-09-30T23:59:59.999Z"));
    });

    it("tobacco AND a tracked category both filed: the LATER close wins, with its own label and name", async () => {
      const OCT_FILING = {
        periodStart: new Date("2026-10-01T00:00:00.000Z"),
        periodEnd: new Date("2026-11-01T00:00:00.000Z"),
        periodKey: "2026-10",
        cadence: "MONTHLY",
      };
      const later = db({
        products: [
          { id: "p1", isTobacco: true, trackedCategoryId: "cat-1", categoryName: "Vapes" },
        ],
        report: SEPT,
        filing: OCT_FILING,
      });
      const body = await conflict(call(later, "2026-10-15T10:00:00.000Z"));
      expect(body).toMatchObject({ period: "October 2026", filedFor: "Vapes" });

      const earlier = db({
        products: [
          { id: "p1", isTobacco: true, trackedCategoryId: "cat-1", categoryName: "Vapes" },
        ],
        report: {
          periodStart: OCT_FILING.periodStart,
          periodEnd: new Date("2026-10-31T23:59:59.999Z"),
        },
        filing: SEPT_FILING,
      });
      const body2 = await conflict(call(earlier, "2026-10-15T10:00:00.000Z"));
      expect(body2).toMatchObject({ period: "October 2026", filedFor: "Tobacco" });
    });

    it("a TIE keeps tobacco (the common case: tobacco products carry the Tobacco tracked category too)", async () => {
      // The tobacco report's inclusive end + 1 ms and the September filing's exclusive end are the same instant.
      const d = db({
        products: [
          { id: "p1", isTobacco: true, trackedCategoryId: "cat-1", categoryName: "Vapes" },
        ],
        report: SEPT, // periodEnd 2026-09-30T23:59:59.999Z → through 2026-10-01T00:00:00.000Z
        filing: SEPT_FILING, // periodEnd 2026-10-01T00:00:00.000Z
      });
      const body = await conflict(call(d, "2026-09-15T10:00:00.000Z"));
      expect(body).toMatchObject({ period: "September 2026", filedFor: "Tobacco" });
    });

    it("the 409 names what is filed: Tobacco", async () => {
      const d = db({ products: [{ id: "p1", isTobacco: true }], report: SEPT });
      const body = await conflict(call(d, "2026-09-15T10:00:00.000Z"));
      expect(body).toMatchObject({ filedFor: "Tobacco" });
      expect(String(body.message)).toContain("already filed for Tobacco (September 2026)");
    });

    it("the 409 names what is filed: the tracked category's name", async () => {
      const d = db({
        products: [{ id: "p1", trackedCategoryId: "cat-1", categoryName: "Vapes" }],
        filing: SEPT_FILING,
      });
      const body = await conflict(call(d, "2026-09-15T10:00:00.000Z"));
      expect(body).toMatchObject({ filedFor: "Vapes" });
      expect(String(body.message)).toContain("already filed for Vapes (September 2026)");
    });

    it("the product read selects the category name (the message's source)", async () => {
      const d = db({ products: [{ id: "p1", trackedCategoryId: "cat-1" }] });
      await call(d, "2026-09-15T10:00:00.000Z");
      expect(d.product.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: expect.objectContaining({ trackedCategory: { select: { name: true } } }),
        }),
      );
    });

    it("many products sharing tobacco and one category read each filing ONCE per call", async () => {
      const d = db({
        products: [
          { id: "a", isTobacco: true, trackedCategoryId: "cat-1" },
          { id: "b", isTobacco: true, trackedCategoryId: "cat-1" },
          { id: "c", isTobacco: true, trackedCategoryId: "cat-1" },
          { id: "d", trackedCategoryId: "cat-2" },
          { id: "e", trackedCategoryId: "cat-2" },
        ],
      });
      await call(d, "2026-09-15T10:00:00.000Z", ["a", "b", "c", "d", "e"]);
      expect(d.tobaccoReport.findFirst).toHaveBeenCalledTimes(1);
      expect(d.regulatedFiling.findFirst).toHaveBeenCalledTimes(2);
    });
  });
});
