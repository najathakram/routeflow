import { DEAD_RETURN_STATUSES } from "../../returns/return-statuses";
import { readReturnItems } from "./counter-return-read";

/**
 * SA-1211 A1.1 (VF-6): the counter receipt lists the returned items with their reason, from the STORED return lines
 * (server data, used as given). A return that was refused or cancelled is not a returned item; a sale with no live return
 * serves none and reads nothing.
 */
const db = (rows: unknown[], lines: unknown[] = []) => {
  const findMany = jest.fn().mockResolvedValue(rows);
  const lineMany = jest.fn().mockResolvedValue(lines);
  return {
    handle: { returnItem: { findMany }, orderItem: { findMany: lineMany } } as never,
    findMany,
    lineMany,
  };
};
const item = (over: Record<string, unknown>) => ({
  qty: "1.000",
  reason: null,
  sourceOrderItemId: null,
  product: { name: "Acme" },
  return: { kind: "INLINE" },
  ...over,
});

describe("readReturnItems (the returned items a counter receipt lists)", () => {
  it("reads the stored lines of the live returns, tenant-scoped, and names item, quantity and reason", async () => {
    const { handle, findMany } = db([
      item({ qty: "2.000", reason: "DAMAGED", product: { name: "Acme Snack" } }),
      item({ product: { name: "Acme Soda" } }),
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
      { name: "Acme Snack", qty: 2, reason: "DAMAGED", kind: "INLINE", line: null },
      { name: "Acme Soda", qty: 1, reason: null, kind: "INLINE", line: null },
    ]);
  });

  it("SA-1231: serves each item with its return's kind and a snapshot of the sold line, in ONE batched read", async () => {
    const { handle, lineMany } = db(
      [
        item({
          qty: "24.000",
          reason: "DAMAGED",
          sourceOrderItemId: "oi-1",
          product: { name: "Acme Case" },
        }),
        item({ qty: "5.000", sourceOrderItemId: "oi-1", return: { kind: "STANDARD" } }),
      ],
      [
        {
          id: "oi-1",
          productId: "p1",
          qty: "1.000",
          unitLabel: null,
          unitsPerBox: 24,
          boxes: 1,
          pieces: 0,
        },
      ],
    );
    const out = await readReturnItems("t1", handle, [{ id: "r1", status: "APPROVED" }]);
    expect(lineMany).toHaveBeenCalledTimes(1);
    expect(lineMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", id: { in: ["oi-1"] } });
    const line = { unitLabel: null, unitsPerBox: 24, boxes: 1, pieces: 0, qty: 1 };
    expect(out).toEqual([
      { name: "Acme Case", qty: 24, reason: "DAMAGED", kind: "INLINE", line },
      { name: "Acme", qty: 5, reason: null, kind: "STANDARD", line },
    ]);
  });

  it("SA-1231: a never-sold item reads no line; a dangling line id serves null and never throws", async () => {
    const { handle, lineMany } = db([item({})]);
    const never = await readReturnItems("t1", handle, [{ id: "r1", status: "APPROVED" }]);
    expect(never?.[0].line).toBeNull();
    expect(lineMany).not.toHaveBeenCalled(); // no sold line named: no extra read
    const dangling = db([item({ sourceOrderItemId: "gone" })], []);
    const out = await readReturnItems("t1", dangling.handle, [{ id: "r1", status: "APPROVED" }]);
    expect(out?.[0].line).toBeNull();
  });

  it("SA-1231: every status the shared dead list names is dropped (one list, not a second copy)", async () => {
    for (const status of DEAD_RETURN_STATUSES) {
      const { handle, findMany } = db([item({})]);
      expect(await readReturnItems("t1", handle, [{ id: "r1", status }])).toBeUndefined();
      expect(findMany).not.toHaveBeenCalled();
    }
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
    const { handle, findMany } = db([item({ reason: "DAMAGED" })]);
    await readReturnItems("t1", handle, [
      { id: "r1", status: "APPROVED" },
      { id: "r1", status: "APPROVED" },
    ]);
    expect(findMany.mock.calls[0][0].where.returnId).toEqual({ in: ["r1"] });
  });
});
