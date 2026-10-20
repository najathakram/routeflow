import { BadRequestException, ConflictException } from "@nestjs/common";
import { stockWriteDate, effectiveDateOf } from "./stock-write-date";

/**
 * SA-802 / SA-802a — `stockWriteDate`: the one date gate for a client-dated stock write. A date a
 * person chose is refused (409 STOCK_DATE_IN_FILED_PERIOD) when it falls before the close of the
 * latest filed period covering any product in the write; documents move forward instead (SA-808).
 */
const NOW = new Date("2026-10-19T12:00:00.000Z");
const T = "tenant-1";

interface Fx {
  products?: Array<{ id: string; isTobacco: boolean; trackedCategoryId: string | null }>;
  tobacco?: { periodStart: string; periodEnd: string } | null;
  /** Latest GENERATED|LOCKED filing per tracked category id. */
  filings?: Record<
    string,
    { periodStart: string; periodEnd: string; periodKey?: string; cadence?: string } | null
  >;
  categories?: Record<string, string>;
}

const makeDb = (fx: Fx) => {
  const db = {
    product: { findMany: jest.fn().mockResolvedValue(fx.products ?? []) },
    tobaccoReport: {
      findFirst: jest.fn().mockResolvedValue(
        fx.tobacco
          ? {
              periodStart: new Date(fx.tobacco.periodStart),
              periodEnd: new Date(fx.tobacco.periodEnd),
            }
          : null,
      ),
    },
    regulatedFiling: {
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        const f = fx.filings?.[args.where.trackedCategoryId];
        return f
          ? {
              periodStart: new Date(f.periodStart),
              periodEnd: new Date(f.periodEnd),
              periodKey: f.periodKey ?? "2026-09",
              cadence: f.cadence ?? "MONTHLY",
            }
          : null;
      }),
    },
    trackedCategory: {
      findFirst: jest.fn().mockImplementation(async (args: any) => {
        const name = fx.categories?.[args.where.id];
        return name ? { name } : null;
      }),
    },
  };
  return db;
};

const SEPT = { periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z" };

const run = (db: ReturnType<typeof makeDb>, raw: string | undefined, productIds = ["p1"]) =>
  stockWriteDate(db, { tenantId: T, productIds, raw, now: NOW });

describe("stockWriteDate (SA-802)", () => {
  it("G2b: a date inside a GENERATED tobacco month is a 409 naming the last day and tobacco", async () => {
    const db = makeDb({
      products: [{ id: "p1", isTobacco: true, trackedCategoryId: null }],
      // TobaccoReport.periodEnd is the INCLUSIVE last instant of the month.
      tobacco: { periodStart: SEPT.periodStart, periodEnd: "2026-09-30T23:59:59.999Z" },
    });
    const err = await run(db, "2026-09-15T00:00:00.000Z").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "STOCK_DATE_IN_FILED_PERIOD",
      message:
        "This date is on or before September 30, 2026, which is already filed (for tobacco). " +
        "Use a date after September 30, 2026.",
      period: "September 2026",
    });
  });

  it("G2b: the first instant after the filed month is accepted", async () => {
    const db = makeDb({
      products: [{ id: "p1", isTobacco: true, trackedCategoryId: null }],
      tobacco: { periodStart: SEPT.periodStart, periodEnd: "2026-09-30T23:59:59.999Z" },
    });
    const d = await run(db, "2026-10-01T00:00:00.000Z");
    expect(d.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("G2a: a date inside a LOCKED tracked-category filing is a 409 naming the category", async () => {
    const db = makeDb({
      products: [{ id: "p1", isTobacco: false, trackedCategoryId: "cat-1" }],
      filings: { "cat-1": SEPT },
      categories: { "cat-1": "Vape products" },
    });
    const err = await run(db, "2026-09-10T00:00:00.000Z").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "STOCK_DATE_IN_FILED_PERIOD",
      message:
        "This date is on or before September 30, 2026, which is already filed (for Vape products). " +
        "Use a date after September 30, 2026.",
      filedThrough: "2026-10-01T00:00:00.000Z",
    });
  });

  it("G2e: an unfiled August is still closed when that category's September is LOCKED", async () => {
    const db = makeDb({
      products: [{ id: "p1", isTobacco: false, trackedCategoryId: "cat-1" }],
      filings: { "cat-1": SEPT },
      categories: { "cat-1": "Vape products" },
    });
    const err = await run(db, "2026-08-10T00:00:00.000Z").catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse().message).toContain("September 30, 2026");
  });

  it("G2c: a non-regulated product backdates freely", async () => {
    const db = makeDb({ products: [{ id: "p1", isTobacco: false, trackedCategoryId: null }] });
    const d = await run(db, "2020-01-01T00:00:00.000Z");
    expect(d.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(db.tobaccoReport.findFirst).not.toHaveBeenCalled();
    expect(db.regulatedFiling.findFirst).not.toHaveBeenCalled();
  });

  it("G2d: a FAILED tobacco month with no later filed month leaves the date open", async () => {
    // The query excludes FAILED rows, so a lone FAILED month comes back as no report at all.
    const db = makeDb({
      products: [{ id: "p1", isTobacco: true, trackedCategoryId: null }],
      tobacco: null,
    });
    const d = await run(db, "2026-09-15T00:00:00.000Z");
    expect(d.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(db.tobaccoReport.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: T,
      status: { not: "FAILED" },
    });
  });

  it("G2d: a FAILED month BEFORE a later filed month is closed", async () => {
    // August FAILED, September GENERATED: the latest non-FAILED report is September.
    const db = makeDb({
      products: [{ id: "p1", isTobacco: true, trackedCategoryId: null }],
      tobacco: { periodStart: SEPT.periodStart, periodEnd: "2026-09-30T23:59:59.999Z" },
    });
    await expect(run(db, "2026-08-15T00:00:00.000Z")).rejects.toBeInstanceOf(ConflictException);
  });

  it("when tobacco and a category are both filed, the later close is the one named", async () => {
    const db = makeDb({
      products: [
        { id: "p1", isTobacco: true, trackedCategoryId: null },
        { id: "p2", isTobacco: false, trackedCategoryId: "cat-1" },
      ],
      tobacco: { periodStart: "2026-08-01T00:00:00.000Z", periodEnd: "2026-08-31T23:59:59.999Z" },
      filings: { "cat-1": SEPT },
      categories: { "cat-1": "Vape products" },
    });
    const err = await run(db, "2026-08-20T00:00:00.000Z", ["p1", "p2"]).catch((e) => e);
    expect(err.getResponse().message).toContain("(for Vape products)");
    expect(err.getResponse().message).toContain("September 30, 2026");
  });

  it("falls back to a generic name when the category cannot be read", async () => {
    const db = makeDb({
      products: [{ id: "p1", isTobacco: false, trackedCategoryId: "cat-1" }],
      filings: { "cat-1": SEPT },
    });
    const err = await run(db, "2026-09-10T00:00:00.000Z").catch((e) => e);
    expect(err.getResponse().message).toContain("(for a regulated category)");
  });

  it("a future date is a 400 before any read; a missing date is now", async () => {
    const db = makeDb({ products: [{ id: "p1", isTobacco: false, trackedCategoryId: null }] });
    await expect(run(db, "2026-10-20T12:00:00.000Z")).rejects.toBeInstanceOf(BadRequestException);
    expect(db.product.findMany).not.toHaveBeenCalled();
    expect((await run(db, undefined)).toISOString()).toBe(NOW.toISOString());
  });

  it("fails closed with no tenant, and with no product ids returns the date unread", async () => {
    const db = makeDb({});
    await expect(
      stockWriteDate(db, { tenantId: null, productIds: ["p1"], raw: undefined, now: NOW }),
    ).rejects.toThrow(/tenant/);
    const d = await run(db, "2020-01-01T00:00:00.000Z", []);
    expect(d.toISOString()).toBe("2020-01-01T00:00:00.000Z");
    expect(db.product.findMany).not.toHaveBeenCalled();
  });

  it("two lines sharing a category cost ONE filing read (and one product read)", async () => {
    const db = makeDb({
      products: [
        { id: "p1", isTobacco: false, trackedCategoryId: "cat-1" },
        { id: "p2", isTobacco: false, trackedCategoryId: "cat-1" },
        { id: "p3", isTobacco: true, trackedCategoryId: "cat-1" },
        { id: "p4", isTobacco: true, trackedCategoryId: null },
      ],
      filings: { "cat-1": SEPT },
    });
    await run(db, "2026-10-05T00:00:00.000Z", ["p1", "p2", "p3", "p4", "p1"]);
    expect(db.product.findMany).toHaveBeenCalledTimes(1);
    expect(db.regulatedFiling.findFirst).toHaveBeenCalledTimes(1);
    expect(db.tobaccoReport.findFirst).toHaveBeenCalledTimes(1);
  });

  it("effectiveDateOf is re-exported from the same module (skew bound unchanged)", () => {
    expect(() => effectiveDateOf("2026-10-19T12:06:00.000Z", NOW)).toThrow(BadRequestException);
    expect(effectiveDateOf(undefined, NOW)).toBe(NOW);
  });
});
