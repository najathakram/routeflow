/**
 * SA-802 - the filed-period date gate, executed against real Postgres (field names, tenant scoping).
 * Throwaway `qa-sa802-*` tenants; collected only by `jest.db.config.js` (`npm run test:db`).
 */
import { describeDb } from "../common/testing/db-spec";
import { useStockDateWorld } from "./testing/sa802-world";

const SEP_START = new Date("2026-09-01T00:00:00.000Z");
const SEP_END_INCLUSIVE = new Date("2026-09-30T23:59:59.999Z");
const SEP_END_EXCLUSIVE = new Date("2026-10-01T00:00:00.000Z");

const tobaccoReport = (tenantId: string) => ({
  tenantId,
  periodYear: 2026,
  periodMonth: 9,
  periodStart: SEP_START,
  periodEnd: SEP_END_INCLUSIVE,
  status: "GENERATED" as const,
  rows: [],
});

describeDb("SA-802 stock write date gate (DB)", () => {
  const t = useStockDateWorld("sa802-stock-write-date.db.spec");

  it("G2b: a tobacco adjustment dated inside a GENERATED report month is refused and writes nothing", async () => {
    const w = await t.newWorld("g2b");
    const productId = await t.newProduct(w, "Acme Cigar", { isTobacco: true });
    await t.prisma.tobaccoReport.create({ data: tobaccoReport(w.tenantId) });

    const dto = {
      productId,
      quantity: -5,
      effectiveDate: "2026-09-15T12:00:00.000Z",
    };
    await expect(
      t.inTenant(w, () => t.inventory.recordAdjustment(dto as any, w.userId)),
    ).rejects.toMatchObject({ response: { code: "STOCK_DATE_IN_FILED_PERIOD" } });
    expect(await t.movementsOf(productId)).toHaveLength(0);
    expect(await t.stockOf(productId)).toBe(100);

    await t.inTenant(w, () =>
      t.inventory.recordAdjustment(
        { ...dto, effectiveDate: "2026-10-02T12:00:00.000Z" } as any,
        w.userId,
      ),
    );
    expect(await t.movementsOf(productId)).toHaveLength(1);
    expect(await t.stockOf(productId)).toBe(95);
  });

  it("G2e/G2a: a count commit dated before a LOCKED category filing is 409 naming the day and category; nothing written", async () => {
    const w = await t.newWorld("g2e");
    const cat = await t.prisma.trackedCategory.create({
      data: { tenantId: w.tenantId, name: "Acme Vape" },
    });
    const productId = await t.newProduct(w, "Acme Pod", { trackedCategoryId: cat.id });
    await t.prisma.regulatedFiling.create({
      data: {
        tenantId: w.tenantId,
        trackedCategoryId: cat.id,
        reportTemplate: "GENERIC",
        cadence: "MONTHLY",
        periodKey: "2026-09",
        periodStart: SEP_START,
        periodEnd: SEP_END_EXCLUSIVE,
        status: "LOCKED",
        rows: [],
        lockedAt: new Date("2026-10-05T00:00:00.000Z"),
      },
    });
    const session = await t.prisma.stockCountSession.create({
      data: { tenantId: w.tenantId, startedById: w.userId, name: "sa802 count" },
    });
    await t.prisma.stockCountLine.create({
      data: {
        tenantId: w.tenantId,
        sessionId: session.id,
        productId,
        mode: "REPLACE",
        countedQty: 90,
        expectedQty: 100,
        countedById: w.userId,
      },
    });

    const err: any = await t
      .inTenant(w, () =>
        t.inventory.commitStockCountSession(
          session.id,
          { effectiveDate: "2026-08-20T12:00:00.000Z" } as any,
          { sub: w.userId },
        ),
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err?.getStatus?.()).toBe(409);
    expect(err.response.code).toBe("STOCK_DATE_IN_FILED_PERIOD");
    expect(err.response.message).toContain("September 30, 2026");
    expect(err.response.message).toContain("Acme Vape");

    expect(
      await t.prisma.stockMovement.findMany({
        where: { tenantId: w.tenantId, reference: `STOCK_COUNT-${session.id}` },
      }),
    ).toHaveLength(0);
    expect(await t.stockOf(productId)).toBe(100);
    const after = await t.prisma.stockCountSession.findUniqueOrThrow({ where: { id: session.id } });
    expect(after.status).not.toBe("COMMITTED");
  });

  it("tenant isolation: another tenant's GENERATED tobacco report does not block this tenant", async () => {
    const other = await t.newWorld("iso-other");
    await t.prisma.tobaccoReport.create({ data: tobaccoReport(other.tenantId) });
    const w = await t.newWorld("iso-mine");
    const productId = await t.newProduct(w, "Acme Cigar", { isTobacco: true });

    await t.inTenant(w, () =>
      t.inventory.recordAdjustment(
        {
          productId,
          quantity: -3,
          effectiveDate: "2026-09-15T12:00:00.000Z",
        } as any,
        w.userId,
      ),
    );
    expect(await t.movementsOf(productId)).toHaveLength(1);
    expect(await t.stockOf(productId)).toBe(97);
  });
});
