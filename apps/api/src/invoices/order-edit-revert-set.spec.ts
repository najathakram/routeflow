import { selectEditRevertedInvoices } from "./order-edit-revert-set";

/**
 * #2178 — the ONE selection of the invoices an undelivered order edit reverts to DRAFT, shared by
 * `revertLinkedInvoicesForOrderEdit` (which reverts them) and the inline-return preflight (which must
 * price against the matching set AFTER that revert, so it excludes them). A second copy of this
 * predicate could drift; this pins the one.
 */
function db(opts: {
  linked: Array<{ id: string; depositPercent?: number | null }>;
  orderStatus?: string;
  nonVoidCount?: number;
}) {
  return {
    invoice: {
      findMany: jest.fn().mockResolvedValue(
        opts.linked.map((l) => ({
          id: l.id,
          invoiceNumber: `INV-${l.id}`,
          internalNotes: null,
          depositPercent: l.depositPercent ?? null,
        })),
      ),
      count: jest.fn().mockResolvedValue(opts.nonVoidCount ?? 1),
    },
    order: { findFirst: jest.fn().mockResolvedValue({ status: opts.orderStatus ?? "PENDING" }) },
  };
}

describe("selectEditRevertedInvoices (#2178)", () => {
  it("reads the order's own non-batch SENT/VIEWED/OVERDUE invoices", async () => {
    const d = db({ linked: [{ id: "a" }, { id: "b" }] });
    const got = await selectEditRevertedInvoices(d as any, "o1");
    expect(got.map((i) => i.id)).toEqual(["a", "b"]);
    expect(d.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId: "o1",
          deliveryBatchId: null,
          status: { in: ["SENT", "VIEWED", "OVERDUE"] },
        },
      }),
    );
    expect(d.order.findFirst).not.toHaveBeenCalled(); // no deposit in play ⇒ no fence reads
  });

  it("leaves out the exempt deposit mirror (sole non-void invoice, order not delivered/cancelled)", async () => {
    const d = db({ linked: [{ id: "dep", depositPercent: 30 }], nonVoidCount: 1 });
    expect(await selectEditRevertedInvoices(d as any, "o1")).toEqual([]);
  });

  it("keeps a deposit invoice outside the fence (a delivered order, or a sibling exists)", async () => {
    const delivered = db({ linked: [{ id: "dep", depositPercent: 30 }], orderStatus: "DELIVERED" });
    expect((await selectEditRevertedInvoices(delivered as any, "o1")).map((i) => i.id)).toEqual([
      "dep",
    ]);
    const sibling = db({ linked: [{ id: "dep", depositPercent: 30 }], nonVoidCount: 2 });
    expect((await selectEditRevertedInvoices(sibling as any, "o1")).map((i) => i.id)).toEqual([
      "dep",
    ]);
  });
});
