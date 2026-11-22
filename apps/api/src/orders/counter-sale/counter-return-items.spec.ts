import { readReturnItems } from "./counter-return-read";

/**
 * SA-1211 A1.1 (VF-6): the counter receipt lists the returned items with their reason, from the STORED return lines
 * (server data, used as given). A return that was refused or cancelled is not a returned item; a sale with no live return
 * serves none and reads nothing.
 */
const db = (rows: unknown[]) => {
  const findMany = jest.fn().mockResolvedValue(rows);
  return { handle: { returnItem: { findMany } } as never, findMany };
};

describe("readReturnItems (the returned items a counter receipt lists)", () => {
  it("reads the stored lines of the live returns, tenant-scoped, and names item, quantity and reason", async () => {
    const { handle, findMany } = db([
      { qty: "2.000", reason: "DAMAGED", product: { name: "Acme Snack" } },
      { qty: "1.000", reason: null, product: { name: "Acme Soda" } },
    ]);
    const out = await readReturnItems("t1", handle, [
      { id: "r1", status: "APPROVED" },
      { id: "r2", status: "REJECTED" },
      { id: "r3", status: "PROCESSED" },
      { id: "r4", status: "CANCELLED" },
    ]);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      returnId: { in: ["r1", "r3"] },
    });
    expect(out).toEqual([
      { name: "Acme Snack", qty: 2, reason: "DAMAGED" },
      { name: "Acme Soda", qty: 1, reason: null },
    ]);
  });

  it("a sale with no live return reads nothing and serves no items", async () => {
    const { handle, findMany } = db([]);
    expect(await readReturnItems("t1", handle, [])).toBeUndefined();
    expect(await readReturnItems("t1", handle, [{ id: "r2", status: "REJECTED" }])).toBeUndefined();
    expect(findMany).not.toHaveBeenCalled();
  });

  it("a return whose lines cannot be found serves no items (never an empty list)", async () => {
    const { handle } = db([]);
    expect(await readReturnItems("t1", handle, [{ id: "r1", status: "APPROVED" }])).toBeUndefined();
  });

  it("the same return named twice (own and carried) is read once", async () => {
    const { handle, findMany } = db([
      { qty: "1.000", reason: "DAMAGED", product: { name: "Acme" } },
    ]);
    await readReturnItems("t1", handle, [
      { id: "r1", status: "APPROVED" },
      { id: "r1", status: "APPROVED" },
    ]);
    expect(findMany.mock.calls[0][0].where.returnId).toEqual({ in: ["r1"] });
  });
});
