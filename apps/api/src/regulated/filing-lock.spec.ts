import { ConflictException } from "@nestjs/common";
import { RegulatedLedgerService } from "./regulated-ledger.service";
import * as fs from "fs";
import * as path from "path";
import {
  assertLedgerRowsNotLocked,
  assertOrderEditNotLocked,
  isMoneyBearingEdit,
  assertSalesNotLockedForEdit,
} from "./filing-lock";
import { lockedFilingsCovering } from "./filed-periods";

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
const CTX = { tenantId: "t1" };
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
    orderItemId: "ol-1",
    invoiceItemId: null,
    entryType: "SALE",
    qty: 12,
    netSales: 120,
    categoryTax: 0.6,
    ...over,
  });
  it("refuses with FILED_PERIOD_LOCKED naming the filing and period", async () => {
    const p = assertSalesNotLockedForEdit(db([filing()], [sale()]), {
      tenantId: "t1",
      orderId: "o1",
    });
    await expect(p).rejects.toBeInstanceOf(ConflictException);
    await expect(p).rejects.toMatchObject({
      response: { code: "FILED_PERIOD_LOCKED", filingId: "f-1", periodKey: "2026-09" },
    });
  });
  it("passes when the line's sales are in an open period or no sale exists", async () => {
    await expect(
      assertSalesNotLockedForEdit(db([filing()], [sale({ periodBucket: "2026-10" })]), {
        tenantId: "t1",
        orderId: "o1",
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertSalesNotLockedForEdit(db([filing()], []), { tenantId: "t1", orderId: "o1" }),
    ).resolves.toBeUndefined();
  });
  it("does not read the ledger at all when the tenant has no locked filing", async () => {
    const d = db([], [sale()]);
    await assertSalesNotLockedForEdit(d, { tenantId: "t1", orderId: "o1" });
    expect(d.regulatedSalesLedger.findMany).not.toHaveBeenCalled();
  });
});

describe("isMoneyBearingEdit decides from the service's own full-replace condition", () => {
  it("any edit that will deleteMany the lines is money-bearing", () => {
    // CUSTOMER / DRIVER and not a diff payload -> the full-replace branch (deleteMany), even with items: []
    expect(isMoneyBearingEdit({ items: [] }, "CUSTOMER")).toBe(true);
    expect(isMoneyBearingEdit({ items: [] }, "DRIVER")).toBe(true);
    expect(isMoneyBearingEdit({ items: null }, "CUSTOMER")).toBe(true);
    // ...but a diff payload (replaceAll:false, or an id / action / substitute) merges instead
    expect(isMoneyBearingEdit({ replaceAll: false, items: [] }, "CUSTOMER")).toBe(false);
    expect(isMoneyBearingEdit({ items: [{ id: "a", notes: "n" }] }, "DRIVER")).toBe(false);
    // staff replace only on an explicit replaceAll:true
    expect(isMoneyBearingEdit({ items: [] }, "OPERATOR")).toBe(false);
    expect(isMoneyBearingEdit({ replaceAll: true, items: [] }, "OPERATOR")).toBe(true);
    // a DRIVER never replaces-all on the staff branch, but a non-diff driver list replaces on the buyer branch
    expect(isMoneyBearingEdit({ replaceAll: true, items: [] }, "DRIVER")).toBe(true);
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

describe("the edit guard is scoped to the lines the edit changes and ignores a square sale (review M3)", () => {
  const dbRows = (filings: any[], rows: any[]) => ({
    regulatedFiling: { findMany: jest.fn(async () => filings) },
    regulatedSalesLedger: {
      findMany: jest.fn(async (a: any) => {
        const ids: string[] | undefined = a.where.orderItemId?.in;
        return rows.filter((r) => !ids || ids.includes(r.orderItemId));
      }),
    },
  });
  const sold = (orderItemId: string, over: Record<string, unknown> = {}) => ({
    orderItemId,
    invoiceItemId: null,
    trackedCategoryId: "cat-1",
    periodBucket: "2026-09",
    entryType: "SALE",
    qty: 12,
    netSales: 120,
    categoryTax: 0.6,
    ...over,
  });

  it("a change to ONE named line passes when only ANOTHER line was sold in the locked period", async () => {
    const d = dbRows([filing()], [sold("tobacco-line")]);
    await expect(
      assertOrderEditNotLocked(d as any, "o1", { items: [{ id: "soda-line", qty: 3 }] }, CTX),
    ).resolves.toBeUndefined();
    await expect(
      assertOrderEditNotLocked(d as any, "o1", { items: [{ id: "tobacco-line", qty: 3 }] }, CTX),
    ).rejects.toMatchObject({ response: { code: "FILED_PERIOD_LOCKED" } });
  });

  it("a replace-all or a new line is judged against the whole order", async () => {
    const d = dbRows([filing()], [sold("tobacco-line")]);
    await expect(
      assertOrderEditNotLocked(d as any, "o1", { replaceAll: true, items: [] }, CTX),
    ).rejects.toMatchObject({
      response: { code: "FILED_PERIOD_LOCKED" },
    });
    await expect(
      assertOrderEditNotLocked(d as any, "o1", { items: [{ productId: "p1", qty: 1 }] }, CTX),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  // Opus review of #3726, finding 1: the CUSTOMER / DRIVER non-diff path runs `orderItem.deleteMany` on EVERY
  // line even when `items` is empty and `replaceAll` is absent, so "no items" is not "no money".
  it("an empty-items full replace deletes the lines, so it is refused for a CUSTOMER or DRIVER and nothing is read past the guard", async () => {
    const d = dbRows([filing()], [sold("tobacco-line")]);
    for (const role of ["CUSTOMER", "DRIVER"])
      await expect(
        assertOrderEditNotLocked(d as any, "o1", { items: [] }, { tenantId: "t1", role }),
      ).rejects.toMatchObject({ response: { code: "FILED_PERIOD_LOCKED" } });
    // the same payload from staff takes the merge branch (no replaceAll flag): it deletes nothing
    for (const role of ["TENANT_ADMIN", "OPERATOR"])
      await expect(
        assertOrderEditNotLocked(d as any, "o1", { items: [] }, { tenantId: "t1", role }),
      ).resolves.toBeUndefined();
  });

  it("a buyer's id-less full list and a driver's non-diff list replace every line", async () => {
    const d = dbRows([filing()], [sold("tobacco-line")]);
    await expect(
      assertOrderEditNotLocked(
        d as any,
        "o1",
        { items: [{ productId: "p1", notes: "n" }] },
        { tenantId: "t1", role: "CUSTOMER" },
      ),
    ).rejects.toMatchObject({ response: { code: "FILED_PERIOD_LOCKED" } });
  });

  it("a sale already fully reversed in that period is not at stake", async () => {
    const d = dbRows(
      [filing()],
      [
        sold("tobacco-line"),
        sold("tobacco-line", {
          entryType: "REVERSAL",
          qty: -12,
          netSales: -120,
          categoryTax: -0.6,
        }),
      ],
    );
    await expect(
      assertOrderEditNotLocked(d as any, "o1", { items: [{ id: "tobacco-line", qty: 3 }] }, CTX),
    ).resolves.toBeUndefined();
  });
});

describe("caller pin: every money-moving entry point is behind a guard (B297 PR5)", () => {
  const src = (rel: string) =>
    fs.readFileSync(path.resolve(__dirname, rel), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  it("orders.updateOrderItems, invoices.update and applyPriceAdjustment (single + bulk preflight) call the edit guard", () => {
    expect(src("../orders/orders.service.ts")).toMatch(/assertOrderEditNotLocked\(/);
    expect(
      src("../invoices/invoices.service.ts").match(/assertSalesNotLockedForEdit\(/g)?.length,
    ).toBeGreaterThanOrEqual(2);
    expect(src("../invoices/price-adjustment-ledger.ts")).toMatch(/assertSalesNotLockedForEdit\(/);
  });
  it("updateOrderItems judges the edit with the caller's role and tenant BEFORE the first line delete", () => {
    const svc = src("../orders/orders.service.ts");
    const call = svc.indexOf("assertOrderEditNotLocked(");
    expect(svc.slice(call, call + 200)).toMatch(/role: user\?\.role/);
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(svc.indexOf("tx.orderItem.deleteMany", call));
    // the service's full-replace branch and the guard share ONE predicate
    expect(svc).toMatch(/takesBuyerDriverReplace\(/);
  });
  it("every ledger writer runs the ledger guard, and an undo is a counter-entry with no undo guard (SA-819 call 2)", () => {
    const ledger = src("regulated-ledger.service.ts");
    expect(ledger.match(/assertLedgerRowsNotLocked\(/g)?.length).toBeGreaterThanOrEqual(7);
    expect(ledger).not.toMatch(/assertUndoNotLocked|refuseLocked/);
  });
});

/**
 * SA-819 call 2 (the SA's ruling): the undo guard is DROPPED. Since SA-839 an undo books a counter-entry into the
 * CURRENT period and never touches a locked filing's rows, so voiding a credit note or cancelling a return whose
 * REVERSAL rows sit in a locked bucket is allowed. The ledger guard on the writers stays.
 */
describe("an undo of a document in a locked period is allowed and books a counter-entry now", () => {
  const original = {
    id: "rev-1",
    tenantId: "t1",
    trackedCategoryId: "cat-1",
    trackedSubcategoryId: null,
    entryType: "REVERSAL",
    orderId: "o1",
    orderItemId: "ol-1",
    invoiceId: "i1",
    invoiceItemId: "ii-1",
    creditNoteId: "cn-1",
    correctsEntryId: null,
    qty: -1,
    unitBasisQty: -1,
    netSales: -10,
    categoryTax: 0,
    soldAt: new Date("2026-09-12T00:00:00Z"),
    periodBucket: "2026-09",
  };
  it("voiding a credit note whose reversal sits in a locked bucket writes its counter-entry", async () => {
    const createMany = jest.fn();
    const d: any = db([filing()], [original]);
    d.regulatedSalesLedger.findMany = jest.fn(async () => [original]);
    d.regulatedSalesLedger.createMany = createMany;
    d.regulatedFiling.findFirst = jest.fn(async () => filing()); // the amended-period label read
    const svc: any = new RegulatedLedgerService({} as any);
    const out = await svc.unreverseCreditNoteEntries({ creditNoteId: "cn-1", db: d });
    expect(out.written).toBe(1);
    const [row] = createMany.mock.calls[0][0].data;
    expect(row).toMatchObject({ correctsEntryId: "rev-1", netSales: 10, qty: 1 });
    expect(row.periodBucket).not.toBe("2026-09"); // the current period, never the locked one
  });
});
