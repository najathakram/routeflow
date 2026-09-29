import { isFirstWaiterOnEditorRow, pollUntil, LockRow } from "./lock-edge";

const tuple = (granted: boolean, relation = '"Product"'): LockRow => ({
  locktype: "tuple",
  granted,
  relation,
  transactionid: null,
});
const xid = (granted: boolean, id: string): LockRow => ({
  locktype: "transactionid",
  granted,
  relation: null,
  transactionid: id,
});

describe("isFirstWaiterOnEditorRow", () => {
  it("accepts a granted Product tuple lock plus a wait on the editor xid", () => {
    expect(isFirstWaiterOnEditorRow([tuple(true), xid(false, "700")], "700")).toBe(true);
  });
  it("rejects a wait on some other transaction", () => {
    expect(isFirstWaiterOnEditorRow([tuple(true), xid(false, "701")], "700")).toBe(false);
  });
  it("rejects a second waiter (ungranted tuple lock)", () => {
    expect(isFirstWaiterOnEditorRow([tuple(false), xid(false, "700")], "700")).toBe(false);
  });
  it("rejects a tuple lock on another relation or no tuple lock", () => {
    expect(isFirstWaiterOnEditorRow([tuple(true, '"Order"'), xid(false, "700")], "700")).toBe(
      false,
    );
    expect(isFirstWaiterOnEditorRow([xid(false, "700")], "700")).toBe(false);
  });
});

describe("pollUntil", () => {
  it("returns the first defined value", async () => {
    let n = 0;
    await expect(pollUntil(async () => (++n >= 3 ? n : undefined), 500, 1)).resolves.toBe(3);
  });
  it("returns undefined after the timeout and probes at least once", async () => {
    const probe = jest.fn(async () => undefined);
    await expect(pollUntil(probe, 30, 5)).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalled();
  });
});
