import { ConflictException } from "@nestjs/common";
import {
  assertLedgerRowsNotLocked,
  isMoneyBearingEdit,
  assertSalesNotLockedForEdit,
  lockedFilingsCovering,
} from "./filing-lock";

/**
 * B297 PR5 (SA-088 D4, SA-734r2 B6): a LOCKED filing closes the (tenant, category, period) triple.
 * `lockedFilingsCovering` finds the LOCKED filings that cover given (category, periodBucket) pairs; the ledger
 * guard refuses any write into one (LEDGER_PERIOD_LOCKED, zero rows); the edit guard refuses a money-bearing
 * edit to a line whose SALE rows sit in one (FILED_PERIOD_LOCKED, naming the filing and period).
 */
const filing = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  trackedCategoryId: "cat-1",
  periodKey: "2026-09",
  periodStart: new Date("2026-09-01T00:00:00Z"),
  periodEnd: new Date("2026-10-01T00:00:00Z"),
  status: "LOCKED",
  ...over,
});
const db = (filings: any[], sales: any[] = []) => ({
  regulatedFiling: {
    findMany: jest.fn(async (a: any) =>
      filings.filter(
        (f) =>
          f.status === "LOCKED" &&
          (a?.where?.trackedCategoryId?.in ?? [f.trackedCategoryId]).includes(f.trackedCategoryId),
      ),
    ),
  },
  regulatedSalesLedger: { findMany: jest.fn(async () => sales) },
});

describe("lockedFilingsCovering", () => {
  it("returns the LOCKED filing whose period covers the bucket, per category", async () => {
    const r = await lockedFilingsCovering(db([filing()]), [
      { trackedCategoryId: "cat-1", periodBucket: "2026-09" },
      { trackedCategoryId: "cat-1", periodBucket: "2026-10" }, // after the period
      { trackedCategoryId: "cat-2", periodBucket: "2026-09" }, // another category
    ]);
    expect(r.map((x) => [x.filing.id, x.periodBucket])).toEqual([["f-1", "2026-09"]]);
  });

  it("covers every month bucket of a QUARTERLY filing", async () => {
    const q = filing({
      periodKey: "2026-Q3",
      periodStart: new Date("2026-07-01T00:00:00Z"),
      periodEnd: new Date("2026-10-01T00:00:00Z"),
    });
    const r = await lockedFilingsCovering(db([q]), [
      { trackedCategoryId: "cat-1", periodBucket: "2026-07" },
      { trackedCategoryId: "cat-1", periodBucket: "2026-09" },
    ]);
    expect(r).toHaveLength(2);
  });

  it("asks the database nothing when there are no rows, and when the client has no filings model (a stub)", async () => {
    const d = db([filing()]);
    expect(await lockedFilingsCovering(d, [])).toEqual([]);
    expect(d.regulatedFiling.findMany).not.toHaveBeenCalled();
    expect(
      await lockedFilingsCovering({} as any, [{ trackedCategoryId: "c", periodBucket: "2026-09" }]),
    ).toEqual([]);
  });
});

describe("assertLedgerRowsNotLocked", () => {
  it("throws LEDGER_PERIOD_LOCKED for a row bucketed into a locked period", async () => {
    await expect(
      assertLedgerRowsNotLocked(db([filing()]), [
        { trackedCategoryId: "cat-1", periodBucket: "2026-09" },
      ]),
    ).rejects.toMatchObject({ response: { code: "LEDGER_PERIOD_LOCKED" } });
  });
  it("passes a row outside every locked period", async () => {
    await expect(
      assertLedgerRowsNotLocked(db([filing()]), [
        { trackedCategoryId: "cat-1", periodBucket: "2026-10" },
      ]),
    ).resolves.toBeUndefined();
  });
});

describe("assertSalesNotLockedForEdit", () => {
  const sale = (over: Record<string, unknown> = {}) => ({
    trackedCategoryId: "cat-1",
    periodBucket: "2026-09",
    ...over,
  });
  it("refuses with FILED_PERIOD_LOCKED naming the filing and period", async () => {
    const p = assertSalesNotLockedForEdit(db([filing()], [sale()]), { orderId: "o1" });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(p).rejects.toMatchObject({
      response: { code: "FILED_PERIOD_LOCKED", filingId: "f-1", periodKey: "2026-09" },
    });
  });
  it("passes when the line's sales are in an open period or no sale exists", async () => {
    await expect(
      assertSalesNotLockedForEdit(db([filing()], [sale({ periodBucket: "2026-10" })]), {
        orderId: "o1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSalesNotLockedForEdit(db([filing()], []), { orderId: "o1" }),
    ).resolves.toBeUndefined();
  });
  it("does not read the ledger at all when the tenant has no locked filing", async () => {
    const d = db([], [sale()]);
    await assertSalesNotLockedForEdit(d, { orderId: "o1" });
    expect(d.regulatedSalesLedger.findMany).not.toHaveBeenCalled();
  });
});

describe("isMoneyBearingEdit", () => {
  it("a note-only or reason-only edit is not money-bearing", () => {
    expect(isMoneyBearingEdit({ items: [{ id: "a", notes: "leave at the dock" }] })).toBe(false);
    expect(isMoneyBearingEdit({ items: [{ id: "a", overrideReason: "x" }] })).toBe(false);
    expect(isMoneyBearingEdit({ items: [] })).toBe(false);
  });
  it("a quantity, split, unit, price, substitute, strike-off, new line or replace-all is", () => {
    for (const item of [
      { id: "a", qty: 2 },
      { id: "a", boxes: 1 },
      { id: "a", pieces: 3 },
      { id: "a", unitLabel: "Case" },
      { id: "a", unitPrice: 5 },
      { id: "a", substituteProductId: "p2" },
      { id: "a", action: "CANCEL" },
      { id: "a", action: "DELETE" },
      { productId: "p1" }, // no id: a new line
    ])
      expect(isMoneyBearingEdit({ items: [item] })).toBe(true);
    expect(isMoneyBearingEdit({ replaceAll: true, items: [{ id: "a", notes: "n" }] })).toBe(true);
  });
});
