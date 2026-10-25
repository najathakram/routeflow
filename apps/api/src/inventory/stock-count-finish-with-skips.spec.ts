import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { buildCountUnitWorld, CountUnitWorld, D, pid } from "./testing/count-unit-harness";

/**
 * SA-767 L-2.4 item C (r-note 4 C), unit level: "Finish with skips" (`finishWithSkips: true` on the
 * commit) for a PARTLY committed count. A line whose product is permanently uncountable (now a FAMILY,
 * or deleted) is skipped and recorded (one `stock-count.line-skipped` audit row each + a notes line);
 * every other remaining line commits as usual; the session is then CASed to COMMITTED. Transient errors
 * are never "permanent". The real-Postgres proof is `sa767-count-finish-with-skips.db.spec.ts`.
 */
const mockWithAdvisoryLock = jest.fn();
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: (...args: unknown[]) => mockWithAdvisoryLock(...args),
}));

describe("commitStockCountSession - finish with skips (SA-767 L-2.4 C)", () => {
  let w: CountUnitWorld;
  const line = (i: number) => ({
    id: `line-${i}`,
    sessionId: "sess-1",
    productId: pid(i),
    mode: "REPLACE",
    countedQty: D(90),
    expectedQty: D(100),
    unitCostOverride: null,
  });
  const session = (over: Record<string, unknown> = {}) => ({
    id: "sess-1",
    status: "OPEN",
    movementReference: null,
    notes: null,
    startedAt: new Date("2026-10-01T00:00:00Z"),
    lines: [line(1), line(2), line(3)],
    ...over,
  });
  const commit = (dto: Record<string, unknown> = {}) =>
    w.service.commitStockCountSession("sess-1", dto as any, { sub: "user-1" });

  beforeEach(async () => {
    w = await buildCountUnitWorld(mockWithAdvisoryLock);
    w.seed([pid(1), pid(2), pid(3)]);
    w.stock.set(pid(1), D(90)); // p001 was applied by an earlier run
    w.ledger.push({ id: "mv-old", productId: pid(1), type: "ADJUSTMENT" });
    w.prisma.stockCountSession.findUnique.mockResolvedValue(session());
  });

  describe("a product that became a FAMILY", () => {
    beforeEach(() => w.kinds.set(pid(3), "FAMILY"));

    it("without the flag the permanent failure still errors and writes nothing new", async () => {
      const err: any = await commit().catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "FAMILY_NOT_SELLABLE" });
      expect(w.prisma.product.update).not.toHaveBeenCalled();
      expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
      expect(w.audit.log).not.toHaveBeenCalled();
    });

    it("with the flag: commits the rest, skips the family, one audit row, one notes line, COMMITTED once", async () => {
      const res: any = await commit({ finishWithSkips: true });

      expect(w.prisma.product.update).toHaveBeenCalledTimes(1); // p002 only (p001 done, p003 skipped)
      expect(w.prisma.product.update.mock.calls[0][0].where).toEqual({ id: pid(2) });
      expect(res.skippedProducts).toEqual([
        { productId: pid(3), name: `Widget ${pid(3)}`, reason: "PRODUCT_IS_FAMILY" },
      ]);
      expect(res.movementIds).toEqual(expect.arrayContaining(["mv-old"]));

      expect(w.prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
      const cas = w.prisma.stockCountSession.updateMany.mock.calls[0][0];
      expect(cas.where).toEqual({ id: "sess-1", status: { in: ["OPEN", "REVIEW"] } });
      expect(cas.data.status).toBe("COMMITTED");
      const noteLines = String(cas.data.notes).split("\n");
      expect(noteLines).toHaveLength(1);
      expect(noteLines[0]).toContain(pid(3));

      expect(w.audit.log).toHaveBeenCalledTimes(1);
      expect(w.audit.log.mock.calls[0][0]).toMatchObject({
        action: "stock-count.line-skipped",
        userId: "user-1",
        meta: { sessionId: "sess-1", productId: pid(3), reason: "PRODUCT_IS_FAMILY" },
      });
    });

    it("the customer's own notes stay, the skip lines are appended after them", async () => {
      await commit({ finishWithSkips: true, notes: "aisle 3" });

      const notes = String(w.prisma.stockCountSession.updateMany.mock.calls[0][0].data.notes);
      expect(notes.split("\n")[0]).toBe("aisle 3");
      expect(notes.split("\n")).toHaveLength(2);
    });

    it("a CAS that matches no row (someone else finished) records no audit row", async () => {
      w.prisma.stockCountSession.updateMany.mockResolvedValue({ count: 0 });
      w.prisma.stockCountSession.findUnique
        .mockResolvedValueOnce(session())
        .mockResolvedValueOnce(session())
        .mockResolvedValue({ status: "COMMITTED" });

      const res: any = await commit({ finishWithSkips: true });

      expect(res.alreadyCommitted).toBe(true);
      expect(w.audit.log).not.toHaveBeenCalled();
    });
  });

  it("a deleted product: without the flag 404 with the ids; with the flag skipped as PRODUCT_DELETED", async () => {
    w.gone.add(pid(3));

    const plain: any = await commit().catch((e) => e);
    expect(plain).toBeInstanceOf(NotFoundException);
    expect(plain.getResponse()).toMatchObject({ missingProductIds: [pid(3)] });

    const res: any = await commit({ finishWithSkips: true });
    expect(res.skippedProducts).toEqual([{ productId: pid(3), reason: "PRODUCT_DELETED" }]);
    expect(w.audit.log.mock.calls[0][0].meta).toMatchObject({ reason: "PRODUCT_DELETED" });
  });

  it("an INACTIVE product is still counted (the committer never refused it): not a skip reason", async () => {
    w.active.set(pid(3), false);

    const res: any = await commit({ finishWithSkips: true });

    expect(res.skippedProducts).toEqual([]);
    expect(w.prisma.product.update).toHaveBeenCalledTimes(2); // p002 and p003
    expect(w.audit.log).not.toHaveBeenCalled();
  });

  it("a line already applied is never reported as skipped, even when its product is now a FAMILY", async () => {
    w.kinds.set(pid(1), "FAMILY");

    const res: any = await commit({ finishWithSkips: true });

    expect(res.skippedProducts).toEqual([]);
    expect(w.prisma.product.update).toHaveBeenCalledTimes(2); // p002, p003
  });

  it("the flag on a count with no movement yet is refused (it is the escape for a partly saved count)", async () => {
    w.ledger.length = 0;
    w.kinds.set(pid(3), "FAMILY");

    const err: any = await commit({ finishWithSkips: true }).catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(w.prisma.product.update).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
  });

  it("a TRANSIENT failure is never a skip: a lock timeout retries, then is the 503 - nothing recorded", async () => {
    w.kinds.set(pid(3), "FAMILY");
    w.prisma.product.update.mockRejectedValue(
      Object.assign(new Error("lock timeout"), { code: "55P03" }),
    );

    const err: any = await commit({ finishWithSkips: true }).catch((e) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.getResponse()).toMatchObject({ code: "LOCK_UNAVAILABLE" });
    expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
    expect(w.audit.log).not.toHaveBeenCalled();
  });

  // n2: the pre-checks read the products BEFORE the lock; a product can be variant-assigned (become a
  // FAMILY) between that read and a batch. The batch re-checks `kind` on the rows it read UNDER the lock.
  describe("a product that became a FAMILY AFTER the pre-checks (found under the batch lock)", () => {
    beforeEach(() => {
      const base = w.prisma.product.findMany.getMockImplementation()!;
      w.prisma.product.findMany.mockImplementation(async (args: any) => {
        const rows = await base(args);
        if (!args?.select) return rows; // the pre-check read still sees STANDARD
        return rows.map((r: any) => (r.id === pid(3) ? { ...r, kind: "FAMILY" } : r));
      });
    });

    it("without the flag: the same coded FAMILY_NOT_SELLABLE 400 as the pre-check, nothing written", async () => {
      const err: any = await commit().catch((e) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({
        code: "FAMILY_NOT_SELLABLE",
        productIds: [pid(3)],
      });
      expect(w.prisma.product.update).not.toHaveBeenCalled(); // not even p002
      expect(w.prisma.stockMovement.create).not.toHaveBeenCalled();
      expect(w.prisma.stockCountSession.updateMany).not.toHaveBeenCalled();
    });

    it("with the flag: skipped + audited as PRODUCT_IS_FAMILY, the rest commits, COMMITTED once", async () => {
      const res: any = await commit({ finishWithSkips: true });

      expect(res.skippedProducts).toEqual([
        { productId: pid(3), name: `Widget ${pid(3)}`, reason: "PRODUCT_IS_FAMILY" },
      ]);
      expect(w.prisma.product.update).toHaveBeenCalledTimes(1); // p002 only
      expect(w.prisma.product.update.mock.calls[0][0].where).toEqual({ id: pid(2) });
      expect(w.prisma.stockCountSession.updateMany).toHaveBeenCalledTimes(1);
      expect(String(w.prisma.stockCountSession.updateMany.mock.calls[0][0].data.notes)).toContain(
        pid(3),
      );
      expect(w.audit.log).toHaveBeenCalledTimes(1);
      expect(w.audit.log.mock.calls[0][0]).toMatchObject({
        action: "stock-count.line-skipped",
        meta: { sessionId: "sess-1", productId: pid(3), reason: "PRODUCT_IS_FAMILY" },
      });
    });

    it("the batch reads kind and name under the lock (they are in the locked select)", async () => {
      await commit({ finishWithSkips: true });

      const locked = w.prisma.product.findMany.mock.calls
        .map((c: any[]) => c[0])
        .find((a: any) => a?.select);
      expect(locked.select).toMatchObject({ kind: true, name: true });
    });
  });
});
