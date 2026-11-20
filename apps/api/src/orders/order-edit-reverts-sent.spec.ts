import { Logger } from "@nestjs/common";
import { editRevertedInvoicesFor } from "../invoices/order-edit-revert-set";
import { editRevertsSentInvoices } from "./order-find-one";

/**
 * B1372 (SA-1177 K2): the order read's `editRevertsSentInvoices` names the sent invoices an items edit turns back into
 * drafts, by the edit's OWN routing rule (`resyncsInPlace`) and selection (`selectEditRevertedInvoices`), so the web's
 * confirm and the edit can never disagree. Staff reads only. Placeholders throughout.
 */
function db(linked: Array<{ id: string; depositPercent?: number | null }>, nonVoidCount = 1) {
  return {
    invoice: {
      findMany: jest.fn().mockResolvedValue(
        linked.map((l) => ({
          id: l.id,
          invoiceNumber: `INV-${l.id}`,
          internalNotes: null,
          depositPercent: l.depositPercent ?? null,
        })),
      ),
      count: jest.fn().mockResolvedValue(nonVoidCount),
    },
    order: { findFirst: jest.fn().mockResolvedValue({ status: "CONFIRMED" }) },
  };
}
const routeMode = { getEffectiveMode: jest.fn().mockResolvedValue("unset") };
const order = (status: string, fulfillPath = "ROUTE") =>
  ({ id: "o1", status, fulfillPath, shippedAt: null, tenantId: "t1" }) as any;

describe("editRevertedInvoicesFor (B1372 K2)", () => {
  it("an undelivered order: the sent invoices the edit reverts", async () => {
    const d = db([{ id: "a" }, { id: "b" }]);
    const got = await editRevertedInvoicesFor(d as any, order("CONFIRMED"), routeMode);
    expect(got.map((i) => i.invoiceNumber)).toEqual(["INV-a", "INV-b"]);
  });

  it.each(["OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED", "DELIVERED"])(
    "%s: the edit re-syncs in place, nothing reverts, so nothing to confirm (no invoice read)",
    async (status) => {
      const d = db([{ id: "a" }]);
      expect(await editRevertedInvoicesFor(d as any, order(status), routeMode)).toEqual([]);
      expect(d.invoice.findMany).not.toHaveBeenCalled();
    },
  );

  it("the exempt deposit mirror (sole non-void invoice) stays SENT, so it is not named", async () => {
    const d = db([{ id: "dep", depositPercent: 30 }], 1);
    expect(await editRevertedInvoicesFor(d as any, order("PENDING"), routeMode)).toEqual([]);
  });

  // SA-1181 interim for B1374: while the fence reverts a sent deposit request that has a regulated -R# sibling, the
  // confirm names it, so staff are warned before that revert too.
  it("a sent deposit request with a regulated -R# sibling is reverted, so the confirm names it", async () => {
    const d = db([{ id: "dep", depositPercent: 30 }], 2);
    const got = await editRevertedInvoicesFor(d as any, order("PENDING"), routeMode);
    expect(got.map((i) => i.invoiceNumber)).toEqual(["INV-dep"]);
  });
});

describe("editRevertsSentInvoices on the order read (B1372 K2)", () => {
  const self = (d: unknown) =>
    ({ prisma: { forTenant: () => d }, featureConfig: routeMode }) as any;

  it.each(["OPERATOR", "TENANT_ADMIN"])("%s: the invoice numbers", async (role) => {
    const d = db([{ id: "a" }]);
    expect(await editRevertsSentInvoices(self(d), order("CONFIRMED"), { role } as any)).toEqual([
      "INV-a",
    ]);
  });

  it.each(["CUSTOMER", "DRIVER"])("%s: always [] and no reads", async (role) => {
    const d = db([{ id: "a" }]);
    expect(await editRevertsSentInvoices(self(d), order("CONFIRMED"), { role } as any)).toEqual([]);
    expect(d.invoice.findMany).not.toHaveBeenCalled();
  });

  it("a failed read never breaks the order page: [] and a logged warn", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const d = db([{ id: "a" }]);
    d.invoice.findMany.mockRejectedValueOnce(new Error("db down"));
    const role = "OPERATOR";
    expect(await editRevertsSentInvoices(self(d), order("CONFIRMED"), { role } as any)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("db down"));
    warn.mockRestore();
  });
});
