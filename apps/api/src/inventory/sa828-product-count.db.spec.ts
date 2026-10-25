/**
 * SA-828 (row 657) - `countProduct` executed against real Postgres: the server's ladder factor,
 * the single ADJUSTMENT movement with its reason, the no-op SET, the whole-pack refusal, and SA-828a's
 * parts ("3 cases + 4 boxes" = 120, the resolved factors in the note, a duplicate unit refused).
 * Throwaway `qa-sa802-*` tenants; collected only by `jest.db.config.js` (`npm run test:db`).
 */
import { describeDb } from "../common/testing/db-spec";
import { useStockDateWorld } from "./testing/sa802-world";

describeDb("SA-828 countProduct (DB)", () => {
  const t = useStockDateWorld("sa828-product-count.db.spec");

  const caseProduct = async (w: { tenantId: string }, factor: number, stock: number) => {
    const id = await t.newProduct(w as any, `Acme Soda ${factor}`, {
      unitsPerBox: factor,
      currentStock: stock,
    });
    await t.prisma.productUnit.create({
      data: { tenantId: w.tenantId, productId: id, label: "Case", factorToBase: factor },
    });
    return id;
  };

  it("C1: SET 3 Cases (12/case) from 20 -> 36, one ADJUSTMENT +16 with reason and note; ADJUST -1 Case (24) -> -24", async () => {
    const w = await t.newWorld("c1");
    const id = await caseProduct(w, 12, 20);
    const res = await t.inTenant(w, () =>
      t.inventory.countProduct(
        id,
        {
          mode: "SET",
          parts: [{ unit: "Case", quantity: 3 }],
          reason: "DAMAGED",
          reasonNote: "water leak",
        } as any,
        w.userId,
      ),
    );
    expect(res.stockAfter).toBe(36);
    expect(res.deltaPieces).toBe(16);
    expect(await t.stockOf(id)).toBe(36);
    const moves = await t.movementsOf(id);
    expect(moves).toHaveLength(1);
    expect(moves[0].type).toBe("ADJUSTMENT");
    expect(Number(moves[0].quantity)).toBe(16);
    expect(moves[0].reason).toBe("DAMAGED");
    expect(moves[0].reasonNote).toBe("water leak");
    expect(moves[0].effectiveAt).toBeInstanceOf(Date);
    expect(res.movementId).toBe(moves[0].id);

    const w2 = await t.newWorld("c1b");
    const id2 = await caseProduct(w2, 24, 100);
    await t.inTenant(w2, () =>
      t.inventory.countProduct(
        id2,
        {
          mode: "ADJUST",
          parts: [{ unit: "Case", quantity: 1 }],
          sign: "-",
          reason: "THEFT",
        } as any,
        w2.userId,
      ),
    );
    const moves2 = await t.movementsOf(id2);
    expect(moves2).toHaveLength(1);
    expect(Number(moves2[0].quantity)).toBe(-24);
    expect(moves2[0].reason).toBe("THEFT");
    expect(await t.stockOf(id2)).toBe(76);
  });

  it("SET equal to the current stock writes no movement and returns movementId null", async () => {
    const w = await t.newWorld("noop");
    const id = await caseProduct(w, 12, 36);
    const res = await t.inTenant(w, () =>
      t.inventory.countProduct(
        id,
        { mode: "SET", parts: [{ unit: "Case", quantity: 3 }], reason: "COUNT_CORRECTION" } as any,
        w.userId,
      ),
    );
    expect(res.movementId).toBeNull();
    expect(res.deltaPieces).toBe(0);
    expect(await t.movementsOf(id)).toHaveLength(0);
    expect(await t.stockOf(id)).toBe(36);
  });

  it("a fractional Case is 400 COUNT_FRACTIONAL_PACK and writes nothing", async () => {
    const w = await t.newWorld("frac");
    const id = await caseProduct(w, 12, 20);
    await expect(
      t.inTenant(w, () =>
        t.inventory.countProduct(
          id,
          {
            mode: "SET",
            parts: [{ unit: "Case", quantity: 2.5 }],
            reason: "COUNT_CORRECTION",
          } as any,
          w.userId,
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "COUNT_FRACTIONAL_PACK" } });
    expect(await t.movementsOf(id)).toHaveLength(0);
    expect(await t.stockOf(id)).toBe(20);
  });

  it('SA-828a C1: SET "3 Case + 4 Box" on a 24 / 12 ladder = 120 pieces; the note records the factors', async () => {
    const w = await t.newWorld("parts");
    const id = await t.newProduct(w, "Acme Cola", { unit: "Piece", currentStock: 20 });
    await t.prisma.productUnit.createMany({
      data: [
        { tenantId: w.tenantId, productId: id, label: "Box", factorToBase: 12, sortOrder: 1 },
        { tenantId: w.tenantId, productId: id, label: "Case", factorToBase: 24, sortOrder: 2 },
      ],
    });
    const res = await t.inTenant(w, () =>
      t.inventory.countProduct(
        id,
        {
          mode: "SET",
          parts: [
            { unit: "Case", quantity: 3 },
            { unit: "Box", quantity: 4 },
          ],
          reason: "COUNT_CORRECTION",
        } as any,
        w.userId,
      ),
    );
    expect(res.stockAfter).toBe(120);
    expect(await t.stockOf(id)).toBe(120);
    const moves = await t.movementsOf(id);
    expect(moves).toHaveLength(1); // ONE ADJUSTMENT carries the pieces
    expect(Number(moves[0].quantity)).toBe(100);
    expect(moves[0].notes).toMatch(
      /^Product count: set to 3 Case \(x24\) \+ 4 Box \(x12\) = 120 pieces/,
    );
  });

  it("SA-828a: a unit named twice is 400 COUNT_DUPLICATE_UNIT and writes nothing", async () => {
    const w = await t.newWorld("dup");
    const id = await caseProduct(w, 12, 20);
    await expect(
      t.inTenant(w, () =>
        t.inventory.countProduct(
          id,
          {
            mode: "SET",
            parts: [
              { unit: "Case", quantity: 1 },
              { unit: "case", quantity: 2 },
            ],
            reason: "COUNT_CORRECTION",
          } as any,
          w.userId,
        ),
      ),
    ).rejects.toMatchObject({ response: { code: "COUNT_DUPLICATE_UNIT" } });
    expect(await t.movementsOf(id)).toHaveLength(0);
    expect(await t.stockOf(id)).toBe(20);
  });

  it("SA-957 L5: another tenant's product id is a 404, with no movement or stock change in either tenant", async () => {
    const mine = await t.newWorld("iso-a");
    const theirs = await t.newWorld("iso-b");
    const theirProduct = await caseProduct(theirs, 12, 20);
    await expect(
      t.inTenant(mine, () =>
        t.inventory.countProduct(
          theirProduct,
          {
            mode: "SET",
            parts: [{ unit: "Case", quantity: 3 }],
            reason: "COUNT_CORRECTION",
          } as any,
          mine.userId,
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(await t.movementsOf(theirProduct)).toHaveLength(0);
    expect(await t.stockOf(theirProduct)).toBe(20);
  });

  it("a session count commit's movement carries reason COUNT_CORRECTION", async () => {
    const w = await t.newWorld("sess");
    const id = await t.newProduct(w, "Acme Widget");
    const session = await t.prisma.stockCountSession.create({
      data: { tenantId: w.tenantId, startedById: w.userId, name: "sa828 count" },
    });
    await t.prisma.stockCountLine.create({
      data: {
        tenantId: w.tenantId,
        sessionId: session.id,
        productId: id,
        mode: "REPLACE",
        countedQty: 90,
        expectedQty: 100,
        countedById: w.userId,
      },
    });
    await t.inTenant(w, () =>
      t.inventory.commitStockCountSession(session.id, {} as any, { sub: w.userId }),
    );
    const moves = await t.movementsOf(id);
    expect(moves).toHaveLength(1);
    expect(moves[0].reason).toBe("COUNT_CORRECTION");
    expect(await t.stockOf(id)).toBe(90);
  });
});
