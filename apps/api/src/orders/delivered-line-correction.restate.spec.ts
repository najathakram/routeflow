/**
 * SA-1536 (ab), §8.4 item 3: `restateInvoices` restates the live invoices IN the edit transaction when the correction
 * map is not empty, and fails closed (a typed 409) when the rebuild throws or cannot restate a live invoice.
 */
import { ForbiddenException } from "@nestjs/common";
import { EDIT_TX_BUDGET_MS, deliveredLineEdit } from "./delivered-line-correction";
import { LONG_BUDGET_MS } from "../common/tx-retry";

const TX = { marker: "tx" };

function build(opts: {
  live: Array<{ invoiceNumber: string }>;
  resync?: jest.Mock;
  noService?: boolean;
}) {
  const resync = opts.resync ?? jest.fn().mockResolvedValue([{ id: "inv-1" }]);
  const tx = {
    ...TX,
    invoice: { findMany: jest.fn().mockResolvedValue(opts.live) },
  };
  const dl = deliveredLineEdit({
    deps: (opts.noService
      ? {}
      : { invoicesService: { resyncOrderInvoicesForEdit: resync } }) as any,
    order: { id: "order-1", status: "CONFIRMED", lineItems: [] } as any,
    dto: {},
    user: { role: "TENANT_ADMIN", sub: "user-1" },
    isDiffPayload: false,
    prisma: { forTenant: () => ({}), getTenantId: () => "tenant-1" },
  });
  return { dl, tx, resync };
}
const MAP = new Map([["line-1", 0]]);

describe("SA-1536 (ab) / SA-1544 (aq) (ar) restateInvoices", () => {
  it("restates in the given tx with an after-commit queue and the actor, and says so (restatedInTx)", async () => {
    const { dl, tx, resync } = build({ live: [{ invoiceNumber: "INV-1" }] });
    expect(dl.restatedInTx()).toBe(false);
    await dl.restateInvoices(tx, MAP);
    expect(dl.restatedInTx()).toBe(true); // wrong value: false (the tail would resync and follow prices again)
    expect(resync).toHaveBeenCalledTimes(1);
    const [orderId, passedTx, after, actor] = resync.mock.calls[0];
    expect(orderId).toBe("order-1");
    expect(passedTx).toBe(tx);
    expect(after).toBeDefined();
    expect(actor).toBe("user-1");
  });

  it("an empty or absent map does nothing and the post-commit path stays as it was", async () => {
    const { dl, tx, resync } = build({ live: [{ invoiceNumber: "INV-1" }] });
    await dl.restateInvoices(tx, undefined);
    expect(dl.restatedInTx()).toBe(false);
    await dl.restateInvoices(tx, new Map());
    expect(dl.restatedInTx()).toBe(false);
    expect(resync).not.toHaveBeenCalled();
  });

  it("an order with no live invoice passes: nothing bills the pieces, nothing is restated", async () => {
    const { dl, tx, resync } = build({ live: [] });
    await expect(dl.restateInvoices(tx, MAP)).resolves.toBeUndefined();
    expect(dl.restatedInTx()).toBe(false);
    expect(resync).not.toHaveBeenCalled();
  });

  it("a retried attempt starts clean: the flag is per attempt", async () => {
    const { dl, tx } = build({ live: [{ invoiceNumber: "INV-1" }] });
    await dl.restateInvoices(tx, MAP);
    expect(dl.restatedInTx()).toBe(true);
    await dl.restateInvoices(tx, undefined); // the next attempt finds nothing to restate
    expect(dl.restatedInTx()).toBe(false);
  });

  it("a null answer while a live invoice exists (an unclean partition) is the typed 409 ORDER_INVOICES_NEED_REVIEW naming the invoice", async () => {
    const resync = jest.fn().mockResolvedValue(null);
    const { dl, tx } = build({ live: [{ invoiceNumber: "INV-8" }], resync });
    await expect(dl.restateInvoices(tx, MAP)).rejects.toMatchObject({
      status: 409,
      response: { code: "ORDER_INVOICES_NEED_REVIEW", message: expect.stringContaining("INV-8") },
    });
    expect(dl.restatedInTx()).toBe(false);
  });

  // SA-1544 (aq): no catch-all. The retry loop (retryStockTx) only sees an error that reaches it untouched.
  it.each([
    ["40P01 deadlock", { code: "40P01", message: "deadlock detected" }],
    ["40001 serialization", { code: "40001", message: "could not serialize access" }],
    [
      "P2034 write conflict",
      { code: "P2034", message: "Transaction failed due to a write conflict" },
    ],
    ["P2028 expired budget", { code: "P2028", message: "Transaction already closed" }],
    ["an untyped error", new Error("boom")],
  ])(
    "%s from the rebuild propagates as the SAME error, never a 409 needs-review",
    async (_n, thrown) => {
      const err = Object.assign(new Error((thrown as Error).message), thrown);
      const resync = jest.fn().mockRejectedValue(err);
      const { dl, tx } = build({ live: [{ invoiceNumber: "INV-7" }], resync });
      await expect(dl.restateInvoices(tx, MAP)).rejects.toBe(err); // wrong value: a ConflictException ORDER_INVOICES_NEED_REVIEW
      expect(dl.restatedInTx()).toBe(false);
    },
  );

  it("an HttpException from the rebuild passes through untouched", async () => {
    const forbidden = new ForbiddenException("no");
    const resync = jest.fn().mockRejectedValue(forbidden);
    const { dl, tx } = build({ live: [{ invoiceNumber: "INV-9" }], resync });
    await expect(dl.restateInvoices(tx, MAP)).rejects.toBe(forbidden);
  });
});

describe("SA-1544 (as) txOptions: EDIT_TX_BUDGET_MS by lock class", () => {
  const input = (role: string, status: string, delivered: number, tenant: string | null = "t") =>
    deliveredLineEdit({
      deps: {} as any,
      order: {
        id: "o",
        status,
        lineItems: [{ id: "l", status: "PENDING", deliveredQty: delivered }],
      } as any,
      dto: {},
      user: { role, sub: "u" },
      isDiffPayload: false,
      prisma: { forTenant: () => ({}), getTenantId: () => tenant },
    });
  it("the correction lock class gets 20 s; every other edit 15 s; both under the retry loop's long budget", () => {
    expect(input("TENANT_ADMIN", "CONFIRMED", 4).txOptions()).toEqual({ timeout: 20_000 });
    expect(input("TENANT_ADMIN", "PARTIALLY_DELIVERED", 4).txOptions()).toEqual({
      timeout: 20_000,
    });
    expect(input("TENANT_ADMIN", "CONFIRMED", 0).txOptions()).toEqual({ timeout: 15_000 }); // holds none
    expect(input("OPERATOR", "CONFIRMED", 4).txOptions()).toEqual({ timeout: 15_000 }); // not an admin
    expect(input("TENANT_ADMIN", "DELIVERED", 4).txOptions()).toEqual({ timeout: 15_000 }); // reopen first
    expect(input("TENANT_ADMIN", "CONFIRMED", 4, null).txOptions()).toEqual({ timeout: 15_000 }); // no tenant context
    expect(EDIT_TX_BUDGET_MS.correction).toBeLessThan(LONG_BUDGET_MS);
    expect(EDIT_TX_BUDGET_MS.other).toBeLessThan(EDIT_TX_BUDGET_MS.correction);
  });
});
