import { lockBillRows, lockSupplierCredits } from "./bill-locks";

describe("lockBillRows", () => {
  const txWith = () => {
    const calls: unknown[][] = [];
    const tx = { $executeRaw: jest.fn(async (...a: unknown[]) => void calls.push(a)) };
    return { tx: tx as never, tx_: tx, calls };
  };

  it("locks each distinct id once, in sorted order", async () => {
    const { tx, tx_ } = txWith();
    await lockBillRows(tx, "t-1", ["b", "a", "b", "c"]);
    const ids = tx_.$executeRaw.mock.calls.map((c) => (c as unknown[])[1]);
    expect(ids).toEqual(["a", "b", "c"]);
  });

  it("fails closed without a tenant: it must never silently lock nothing", async () => {
    const { tx, tx_ } = txWith();
    await expect(lockBillRows(tx, null, ["a"])).rejects.toThrow(/tenant/i);
    await expect(lockBillRows(tx, undefined as never, ["a"])).rejects.toThrow(/tenant/i);
    expect(tx_.$executeRaw).not.toHaveBeenCalled();
  });

  it("an empty id list is a no-op, even without a tenant check failing the caller", async () => {
    const { tx, tx_ } = txWith();
    await lockBillRows(tx, "t-1", []);
    expect(tx_.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("lockSupplierCredits (B291)", () => {
  const txWith = () => {
    const tx = { $executeRaw: jest.fn(async () => 0) };
    return { tx: tx as never, raw: tx.$executeRaw };
  };

  it("is ONE sorted FOR UPDATE statement carrying the bound tenant predicate", async () => {
    const { tx, raw } = txWith();
    await lockSupplierCredits(tx, "t-1", {
      supplierIds: ["s-2", "s-1", "s-2"],
      creditIds: ["c-1"],
    });
    expect(raw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = raw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const sql = strings.join("?");
    expect(sql).toContain('FROM "SupplierCredit" WHERE "tenantId" = ?');
    expect(sql).toContain('ORDER BY "receivedAt", id FOR UPDATE');
    // Bound parameters, not interpolated text: tenant first, then the de-duplicated id sets.
    expect(values).toEqual(["t-1", ["s-2", "s-1"], ["c-1"]]);
  });

  it("ignores null suppliers and locks nothing when nothing is named", async () => {
    const { tx, raw } = txWith();
    await lockSupplierCredits(tx, "t-1", { supplierIds: [null, undefined] });
    await lockSupplierCredits(tx, null, {});
    expect(raw).not.toHaveBeenCalled();
  });

  it("fails closed without a tenant: it must never silently lock nothing", async () => {
    const { tx, raw } = txWith();
    await expect(lockSupplierCredits(tx, null, { supplierIds: ["s-1"] })).rejects.toThrow(
      /tenant/i,
    );
    expect(raw).not.toHaveBeenCalled();
  });
});
