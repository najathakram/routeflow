import { countUnbookedReversals } from "./unbooked-reversals";

/** SA-835: the period count is per tenant and counts reversals (returns / credit notes), not notice rows. */
describe("countUnbookedReversals", () => {
  const range = {
    from: new Date("2026-10-01T00:00:00Z"),
    toExclusive: new Date("2026-11-01T00:00:00Z"),
  };
  const notice = (tenantId: string, meta: Record<string, unknown>) => ({ tenantId, meta });

  // A tiny auditLog that honours the where it is given (tenantId, action).
  const dbOf = (rows: Array<{ tenantId: string; meta: unknown }>) => ({
    auditLog: {
      findMany: jest.fn(async ({ where }: any) =>
        rows.filter((r) => r.tenantId === where.tenantId).map((r) => ({ meta: r.meta })),
      ),
    },
  });

  it("does not count another tenant's notice", async () => {
    const db = dbOf([
      notice("t1", { returnId: "r1", saleEntryId: "s1" }),
      notice("t2", { returnId: "r2", saleEntryId: "s2" }),
    ]);
    await expect(countUnbookedReversals(db, range, "t1")).resolves.toBe(1);
    await expect(countUnbookedReversals(db, range, "t2")).resolves.toBe(1);
  });

  it("scopes the query by tenantId, and counts nothing without a tenant", async () => {
    const db = dbOf([notice("t1", { returnId: "r1", saleEntryId: "s1" })]);
    await countUnbookedReversals(db, range, "t1");
    expect(db.auditLog.findMany.mock.calls[0][0].where.tenantId).toBe("t1");
    await expect(countUnbookedReversals(db, range, null)).resolves.toBe(0);
  });

  it("counts distinct returns and credit notes, not notice rows", async () => {
    const db = dbOf([
      notice("t1", { returnId: "r1", saleEntryId: "s1" }),
      notice("t1", { returnId: "r1", saleEntryId: "s2" }),
      notice("t1", { creditNoteId: "c1", saleEntryId: "s1" }),
      notice("t1", { creditNoteId: "c1", returnId: null, saleEntryId: "s1" }),
    ]);
    await expect(countUnbookedReversals(db, range, "t1")).resolves.toBe(2);
  });
});
