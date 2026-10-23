/**
 * Row 563 (SA-794 → SA-802 → SA-802a / SA-808a) against real Postgres: every stock write whose date a PERSON chose is
 * refused (409 STOCK_DATE_IN_FILED_PERIOD, naming the period) when the date falls before the latest filed period's close for
 * any touched regulated product, and nothing is written. Non-regulated products keep backdating. A replay of a count that
 * ALREADY committed is never refused (the gate sits after the idempotency read / the COMMITTED re-read).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Every tenant is a throwaway `qa-*` slug (the harness).
 */
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness, type CountWorld } from "./testing/count-db-harness";

/** The FILED month is last month; today is open. */
const today = new Date();
const monthStart = (back: number) =>
  new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 1));
const FILED_START = monthStart(1);
const FILED_END_EXCL = monthStart(0);
const IN_FILED = new Date(
  Date.UTC(FILED_START.getUTCFullYear(), FILED_START.getUTCMonth(), 15, 10),
);
const BEFORE_FILED = new Date(
  Date.UTC(monthStart(2).getUTCFullYear(), monthStart(2).getUTCMonth(), 15, 10),
);
const FILED_LABEL = FILED_START.toLocaleString("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});
const TOMORROW = new Date(today.getTime() + 36 * 3600 * 1000);

describeDb(
  "Row 563: a person-dated stock write never changes a filed period (real Postgres)",
  () => {
    const h = useCountDbHarness("stock-write-date.db.spec");

    const tobacco = (id: string) =>
      h.A.prisma.product.update({ where: { id }, data: { isTobacco: true } });
    const tracked = async (w: CountWorld, id: string) => {
      const cat = await h.A.prisma.trackedCategory.create({
        data: { name: `Vape ${id}`, taxType: "NONE", tenantId: w.tenantId },
      });
      await h.A.prisma.product.update({ where: { id }, data: { trackedCategoryId: cat.id } });
      return cat.id;
    };
    const tobaccoReport = (w: CountWorld, status = "GENERATED") =>
      h.A.prisma.tobaccoReport.create({
        data: {
          tenantId: w.tenantId,
          periodYear: FILED_START.getUTCFullYear(),
          periodMonth: FILED_START.getUTCMonth() + 1,
          periodStart: FILED_START,
          periodEnd: new Date(FILED_END_EXCL.getTime() - 1),
          status,
          rows: [],
        } as any,
      });
    const filing = (w: CountWorld, categoryId: string, status = "LOCKED") =>
      h.A.prisma.regulatedFiling.create({
        data: {
          tenantId: w.tenantId,
          trackedCategoryId: categoryId,
          reportTemplate: "GENERIC",
          periodKey: `${FILED_START.getUTCFullYear()}-${String(FILED_START.getUTCMonth() + 1).padStart(2, "0")}`,
          periodStart: FILED_START,
          periodEnd: FILED_END_EXCL,
          status,
          rows: [],
        } as any,
      });
    const movementsOf = (w: CountWorld, productId: string) =>
      h.A.prisma.stockMovement.findMany({ where: { tenantId: w.tenantId, productId } });
    const lotsOf = (w: CountWorld, productId: string) =>
      h.A.prisma.stockLot.findMany({ where: { tenantId: w.tenantId, productId } });
    const statusOf = (e: any) => e?.getStatus?.();
    const bodyOf = (e: any) => e?.getResponse?.() ?? {};
    const adjust = (w: CountWorld, productId: string, date?: Date) =>
      h.inTenant(h.A, w, () =>
        h.A.inventory.recordAdjustment(
          { productId, quantity: 5, effectiveDate: date?.toISOString() } as any,
          w.userId,
        ),
      );
    const purchase = (w: CountWorld, productId: string, date?: Date) =>
      h.inTenant(h.A, w, () =>
        h.A.inventory.recordPurchase(
          { productId, quantity: 5, unitCost: 3, effectiveDate: date?.toISOString() } as any,
          w.userId,
        ),
      );
    const legacyCount = (w: CountWorld, sessionId: string, productId: string, date?: Date) =>
      h.inTenant(h.A, w, () =>
        h.A.inventory.commitStockCount(
          {
            sessionId,
            items: [{ productId, quantity: 80, mode: "REPLACE" }],
            effectiveDate: date?.toISOString(),
          } as any,
          w.userId,
        ),
      );

    it("R1: a session commit dated in a reported tobacco month is 409 naming the month; nothing written", async () => {
      const w = await h.seedCountWorld("r1", 1);
      await tobacco(w.idOf(1));
      await tobaccoReport(w);
      const err: any = await h
        .commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() })
        .catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(bodyOf(err)).toMatchObject({
        code: "STOCK_DATE_IN_FILED_PERIOD",
        period: FILED_LABEL,
      });
      expect(await h.countMovements(w)).toHaveLength(0);
      expect(await h.stockOfId(w.idOf(1))).toBe(100);
      expect((await h.sessionOf(w)).status).not.toBe("COMMITTED");
    }, 60_000);

    it("R2: a session commit dated tomorrow is the existing 400", async () => {
      const w = await h.seedCountWorld("r2", 1);
      const err: any = await h
        .commitSession(h.A, w, { effectiveDate: TOMORROW.toISOString() })
        .catch((e) => e);
      expect(statusOf(err)).toBe(400);
      expect(await h.countMovements(w)).toHaveLength(0);
    }, 60_000);

    it("R3: an adjustment backdated into a reported tobacco month is 409; no movement, no lot", async () => {
      const w = await h.seedCountWorld("r3", 1, { lines: false });
      await tobacco(w.idOf(1));
      await tobaccoReport(w);
      const err: any = await adjust(w, w.idOf(1), IN_FILED).catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(await movementsOf(w, w.idOf(1))).toHaveLength(0);
      expect(await lotsOf(w, w.idOf(1))).toHaveLength(0);
      expect(await h.stockOfId(w.idOf(1))).toBe(100);
    }, 60_000);

    it("R4: a session commit dated inside a LOCKED filing for the line's tracked category is 409", async () => {
      const w = await h.seedCountWorld("r4", 1);
      await filing(w, await tracked(w, w.idOf(1)));
      const err: any = await h
        .commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() })
        .catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(await h.countMovements(w)).toHaveLength(0);
    }, 60_000);

    it("R5 (SA-802a): dated in an UNFILED month before a LOCKED one is 409 naming the filed month", async () => {
      const w = await h.seedCountWorld("r5", 1);
      await filing(w, await tracked(w, w.idOf(1)));
      const err: any = await h
        .commitSession(h.A, w, { effectiveDate: BEFORE_FILED.toISOString() })
        .catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(bodyOf(err)).toMatchObject({ period: FILED_LABEL });
      expect(await h.countMovements(w)).toHaveLength(0);
    }, 60_000);

    it("R6: a purchase backdated into a reported tobacco month is 409; no lot, average cost unchanged", async () => {
      const w = await h.seedCountWorld("r6", 1, { lines: false });
      await tobacco(w.idOf(1));
      await tobaccoReport(w);
      const err: any = await purchase(w, w.idOf(1), IN_FILED).catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(await lotsOf(w, w.idOf(1))).toHaveLength(0);
      const p = await h.A.prisma.product.findUniqueOrThrow({ where: { id: w.idOf(1) } });
      expect(Number(p.averageCost)).toBe(2);
    }, 60_000);

    it("R7: a legacy one-shot count dated into a reported month is 409; nothing written", async () => {
      const w = await h.seedCountWorld("r7", 1, { lines: false });
      await tobacco(w.idOf(1));
      await tobaccoReport(w);
      const err: any = await legacyCount(w, "legacy-r7", w.idOf(1), IN_FILED).catch((e) => e);
      expect(statusOf(err)).toBe(409);
      expect(await movementsOf(w, w.idOf(1))).toHaveLength(0);
    }, 60_000);

    it("R8: a legacy count REPLAYED after its month got filed returns the prior result (never refused)", async () => {
      const w = await h.seedCountWorld("r8", 1, { lines: false });
      await tobacco(w.idOf(1));
      const first: any = await legacyCount(w, "legacy-r8", w.idOf(1), IN_FILED); // the month is open: accepted
      expect(first.alreadyCommitted).toBeFalsy();
      await tobaccoReport(w); // the month is filed afterwards
      const replay: any = await legacyCount(w, "legacy-r8", w.idOf(1), IN_FILED);
      expect(replay).toMatchObject({ alreadyCommitted: true, movementIds: first.movementIds });
    }, 60_000);

    it("R9: committing an ALREADY committed session after its month got filed is the already-committed outcome", async () => {
      const w = await h.seedCountWorld("r9", 1);
      await tobacco(w.idOf(1));
      const first: any = await h.commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() });
      expect((await h.sessionOf(w)).status).toBe("COMMITTED");
      await tobaccoReport(w);
      const again: any = await h.commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() });
      expect(again).toMatchObject({ alreadyCommitted: true });
      expect(await h.countMovements(w)).toHaveLength(
        first.movementIds?.length ?? (await h.countMovements(w)).length,
      );
    }, 60_000);

    describe("guards (accepted before and after)", () => {
      it("G1: the same backdates on a NON-regulated product are accepted", async () => {
        const w = await h.seedCountWorld("g1", 1);
        await tobaccoReport(w); // a filed month exists, but this product is not regulated
        await adjust(w, w.idOf(1), IN_FILED);
        expect(await movementsOf(w, w.idOf(1))).toHaveLength(1);
        await h.commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() });
        expect((await h.sessionOf(w)).status).toBe("COMMITTED");
      }, 60_000);

      it("G2: a date in a FAILED tobacco month with no later filed month is accepted", async () => {
        const w = await h.seedCountWorld("g2", 1, { lines: false });
        await tobacco(w.idOf(1));
        await tobaccoReport(w, "FAILED");
        await adjust(w, w.idOf(1), IN_FILED);
        expect(await movementsOf(w, w.idOf(1))).toHaveLength(1);
      }, 60_000);

      it("G4: no date given is now, accepted even with a filed month", async () => {
        const w = await h.seedCountWorld("g4", 1, { lines: false });
        await tobacco(w.idOf(1));
        await tobaccoReport(w);
        await adjust(w, w.idOf(1));
        expect(await movementsOf(w, w.idOf(1))).toHaveLength(1);
      }, 60_000);

      it("G5: a mixed count (one tobacco line, one plain) dated in the filed month is refused WHOLE", async () => {
        const w = await h.seedCountWorld("g5", 2);
        await tobacco(w.idOf(2));
        await tobaccoReport(w);
        const err: any = await h
          .commitSession(h.A, w, { effectiveDate: IN_FILED.toISOString() })
          .catch((e) => e);
        expect(statusOf(err)).toBe(409);
        expect(await h.countMovements(w)).toHaveLength(0);
        expect(await h.stockOfId(w.idOf(1))).toBe(100);
      }, 60_000);
    });
  },
);
