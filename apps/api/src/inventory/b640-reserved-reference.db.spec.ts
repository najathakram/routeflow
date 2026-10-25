/**
 * B640 (row 562 S1, T13), real Postgres: a count's idempotency is keyed on its movement reference
 * `STOCK_COUNT-<sessionId>`, so a free-text reference that starts with it must never be accepted.
 *
 *  (R1) an adjustment planted with the count's reference is refused (400 STOCK_REFERENCE_RESERVED), and
 *       the count then applies EVERY line. Master: the adjustment is recorded, and the commit skips that
 *       product silently ("already committed"), leaving its stock one unit off the count.
 *  (R2) the same for a purchase.
 *  (R3) the legacy one-shot commit refuses a sessionId that names a durable session: nothing is written
 *       under the durable session's reference.
 *  (R4) an ordinary reference still works, and the legacy commit with its own fresh id still applies.
 */
import { randomUUID } from "crypto";
import { describeDb } from "../common/testing/db-spec";
import { useCountDbHarness } from "./testing/count-db-harness";

describeDb("B640 - a planted count reference cannot suppress a count", () => {
  const h = useCountDbHarness("b640-reserved-reference.db.spec");

  const code = (e: any) => e?.getResponse?.()?.code;

  it("(R1) a planted adjustment is refused and the count then applies every line", async () => {
    const w = await h.seedCountWorld("r1", 2); // two REPLACE lines: counted 90 of 100
    const planted = h
      .inTenant(h.A, w, () =>
        h.A.inventory.recordAdjustment(
          { productId: w.idOf(1), quantity: 1, reference: `STOCK_COUNT-${w.sessionId}` } as any,
          w.userId,
        ),
      )
      .catch((e) => e);

    const err: any = await planted;
    const res: any = await h.commitSession(h.A, w);

    console.log(
      `B640(R1) observed: plantedStatus=${err?.getStatus?.() ?? "accepted"} code=${code(err)} ` +
        `applied=${res.applied} stock1=${await h.stockOfId(w.idOf(1))} stock2=${await h.stockOfId(w.idOf(2))}`,
    );
    expect(err?.getStatus?.()).toBe(400);
    expect(code(err)).toBe("STOCK_REFERENCE_RESERVED");
    expect(res.applied).toBe(2);
    expect(await h.stockOfId(w.idOf(1))).toBe(90);
    expect(await h.stockOfId(w.idOf(2))).toBe(90);
    expect(await h.countMovements(w)).toHaveLength(2);
  }, 60_000);

  it("(R2) a planted purchase is refused the same way, in any letter case", async () => {
    const w = await h.seedCountWorld("r2", 1);

    const err: any = await h
      .inTenant(h.A, w, () =>
        h.A.inventory.recordPurchase(
          {
            productId: w.idOf(1),
            quantity: 5,
            unitCost: 2,
            reference: ` stock_count-${w.sessionId}`,
          } as any,
          w.userId,
        ),
      )
      .catch((e) => e);

    expect(err?.getStatus?.()).toBe(400);
    expect(code(err)).toBe("STOCK_REFERENCE_RESERVED");
    expect(await h.stockOfId(w.idOf(1))).toBe(100);
  }, 60_000);

  it("(R3) the legacy commit refuses a sessionId that names a durable session", async () => {
    const w = await h.seedCountWorld("r3", 1);

    const err: any = await h
      .inTenant(h.A, w, () =>
        h.A.inventory.commitStockCount(
          {
            sessionId: w.sessionId,
            items: [{ productId: w.idOf(1), quantity: 5, mode: "REPLACE" }],
          } as any,
          w.userId,
        ),
      )
      .catch((e) => e);

    console.log(`B640(R3) observed: status=${err?.getStatus?.() ?? "accepted"} code=${code(err)}`);
    expect(err?.getStatus?.()).toBe(400);
    expect(code(err)).toBe("STOCK_REFERENCE_RESERVED");
    expect(await h.countMovements(w)).toHaveLength(0);
    expect(await h.stockOfId(w.idOf(1))).toBe(100);
    // and the durable count still commits normally afterwards
    const res: any = await h.commitSession(h.A, w);
    expect(res.applied).toBe(1);
    expect(await h.stockOfId(w.idOf(1))).toBe(90);
  }, 60_000);

  it("(R4) an ordinary reference and a fresh legacy session id still work", async () => {
    const w = await h.seedCountWorld("r4", 1);

    await h.inTenant(h.A, w, () =>
      h.A.inventory.recordAdjustment(
        { productId: w.idOf(1), quantity: 1, reference: "RECOUNT-AISLE-3" } as any,
        w.userId,
      ),
    );
    const legacy: any = await h.inTenant(h.A, w, () =>
      h.A.inventory.commitStockCount(
        {
          sessionId: randomUUID(),
          items: [{ productId: w.idOf(1), quantity: 50, mode: "REPLACE" }],
        } as any,
        w.userId,
      ),
    );

    expect(legacy.applied).toBe(1);
    expect(await h.stockOfId(w.idOf(1))).toBe(50);
  }, 60_000);
});
