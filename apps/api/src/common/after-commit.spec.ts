import { AfterCommit, gatewayFor, withAfterCommit } from "./after-commit";

/** #2175 (SA-487): the after-commit queue itself. */
describe("after-commit helper (#2175)", () => {
  const gateway = { emitInvoiceUpdated: jest.fn(), emitCreditNoteVoided: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  it("defer() queues the call with its arguments; nothing is sent until flush()", () => {
    const after = new AfterCommit();
    after.defer(gateway).emitInvoiceUpdated("t1", { invoiceId: "inv-1" });
    expect(gateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    after.flush();
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledWith("t1", { invoiceId: "inv-1" });
    after.flush(); // a second flush sends nothing again
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
  });

  it("withAfterCommit: success sends each queued emit once, after the transaction resolved", async () => {
    let committed = false;
    const prisma = {
      tenantTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        const r = await fn({});
        expect(gateway.emitInvoiceUpdated).not.toHaveBeenCalled();
        committed = true;
        return r;
      }),
    };
    gateway.emitInvoiceUpdated.mockImplementation(() => expect(committed).toBe(true));
    const result = await withAfterCommit(prisma as any, async (_tx, after) => {
      after.defer(gateway).emitInvoiceUpdated("t1", { invoiceId: "inv-1" });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
  });

  it("withAfterCommit: a failed commit sends NOTHING and rethrows", async () => {
    const prisma = {
      tenantTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        await fn({});
        throw new Error("commit failed");
      }),
    };
    await expect(
      withAfterCommit(prisma as any, async (_tx, after) => {
        after.defer(gateway).emitInvoiceUpdated("t1", { invoiceId: "inv-1" });
      }),
    ).rejects.toThrow("commit failed");
    expect(gateway.emitInvoiceUpdated).not.toHaveBeenCalled();
  });

  it("a re-run attempt starts clean: a rolled-back attempt's emits are never sent", async () => {
    const prisma = {
      // Two attempts, as a retrying transaction would: the first queues, then is abandoned.
      tenantTransaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
        await fn({ attempt: 1 });
        return fn({ attempt: 2 });
      }),
    };
    await withAfterCommit(prisma as any, async (tx: { attempt: number }, after) => {
      after.defer(gateway).emitInvoiceUpdated("t1", { attempt: tx.attempt });
    });
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledWith("t1", { attempt: 2 });
  });

  it("an emit that throws after commit is logged, never fails the committed write", () => {
    const after = new AfterCommit();
    after.push(() => {
      throw new Error("socket down");
    });
    after.defer(gateway).emitCreditNoteVoided("t1", {});
    expect(() => after.flush()).not.toThrow();
    expect(gateway.emitCreditNoteVoided).toHaveBeenCalledTimes(1);
  });

  it("gatewayFor: the gateway itself outside a tx; the caller's queue inside one; refused without it", () => {
    expect(gatewayFor(undefined, undefined, gateway, "site")).toBe(gateway);
    const after = new AfterCommit();
    gatewayFor({}, after, gateway, "site").emitInvoiceUpdated("t1", {});
    expect(gateway.emitInvoiceUpdated).not.toHaveBeenCalled();
    after.flush();
    expect(gateway.emitInvoiceUpdated).toHaveBeenCalledTimes(1);
    expect(() => gatewayFor({}, undefined, gateway, "site")).toThrow(
      "site: a caller-owned transaction must pass its AfterCommit queue (#2175)",
    );
  });
});
