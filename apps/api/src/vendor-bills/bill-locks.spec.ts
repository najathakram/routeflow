import { lockBillRows } from "./bill-locks";

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
