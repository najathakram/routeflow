import { BadRequestException } from "@nestjs/common";
import {
  EDIT_BLOCKING_INVOICE_WHERE,
  EDIT_BLOCKING_STATUSES,
  revertLinkedInvoicesToDraft,
} from "./order-edit-revert-set";

/** SA-1144 case 21: the unit lane catches the refusal going missing (the DB spec is the only other net). */
describe("revertLinkedInvoicesToDraft refusal (SA-1144)", () => {
  /** The blocking read carries the shared fragment's OR; the revert read has status.in (SENT...); the lock read has neither. */
  const db = (
    held: Array<{ status: string; depositPercent?: number | null }>,
    sent: unknown[] = [],
  ) => {
    const calls: string[] = [];
    return {
      calls,
      invoice: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.OR) {
            calls.push("blocking-read");
            return held.map((h, i) => ({
              id: `i${i}`,
              invoiceNumber: `INV-${i}`,
              depositPercent: h.depositPercent ?? null,
              ...h,
            }));
          }
          if (where.status?.in) return sent;
          calls.push("lock-read");
          return [{ id: "i0" }];
        }),
        count: jest.fn().mockResolvedValue(2),
        update: jest.fn(),
      },
      invoicePayment: { count: jest.fn().mockResolvedValue(0) },
      order: { findFirst: jest.fn().mockResolvedValue({ status: "PENDING" }) },
      $executeRaw: jest.fn(async () => {
        calls.push("lock");
        return 0;
      }),
    };
  };

  it.each(["PAID", "PARTIAL", "WRITTEN_OFF", "SENT", "DRAFT"])(
    "an order whose invoice (%s) is found by the blocking read refuses with ORDER_EDIT_INVOICE_HAS_PAYMENTS and writes nothing",
    async (status) => {
      const d = db([{ status }]);
      const err = await revertLinkedInvoicesToDraft(d, "o1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS" });
      expect(d.invoice.update).not.toHaveBeenCalled();
    },
  );

  it("refuses under preflightOnly too; written off reads differently; a SENT invoice with a payment keeps F2's sentence", async () => {
    const wo = await revertLinkedInvoicesToDraft(db([{ status: "WRITTEN_OFF" }]), "o1", {
      preflightOnly: true,
    }).catch((e) => e);
    expect(wo.getResponse().message).toContain("written off");
    const sent = await revertLinkedInvoicesToDraft(db([{ status: "SENT" }]), "o1").catch((e) => e);
    expect(sent.getResponse().message).toBe(
      "This order can't be edited while invoice INV-0 has payments recorded. Void the invoice or remove its payments first.",
    );
  });

  it("no blocking invoice: nothing refuses", async () => {
    expect(await revertLinkedInvoicesToDraft(db([]), "o1")).toEqual([]);
  });

  it("the exempt deposit mirror (sole non-void invoice, PARTIAL) is not refused; a fully PAID one is", async () => {
    const exempt = db([{ status: "PARTIAL", depositPercent: 30 }]);
    exempt.invoice.count.mockResolvedValue(1);
    expect(await revertLinkedInvoicesToDraft(exempt, "o1")).toEqual([]);
    const paid = db([{ status: "PAID", depositPercent: 30 }]);
    paid.invoice.count.mockResolvedValue(1);
    await expect(revertLinkedInvoicesToDraft(paid, "o1")).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("Decision 1: under lockRows the invoices are locked BEFORE the blocking set is read", async () => {
    const d = db([{ status: "PAID" }]);
    await revertLinkedInvoicesToDraft(d, "o1", { lockRows: true }).catch(() => undefined);
    expect(d.calls).toEqual(["lock-read", "lock", "blocking-read"]);
  });

  it("the merge fragment and the edit refusal read one status list and one fragment (Decision 7)", () => {
    expect(EDIT_BLOCKING_STATUSES).toEqual(["PAID", "PARTIAL", "WRITTEN_OFF"]);
    expect(EDIT_BLOCKING_INVOICE_WHERE).toMatchObject({
      deliveryBatchId: null,
      status: { not: "VOID" },
      OR: [
        { status: { in: EDIT_BLOCKING_STATUSES } },
        { payments: { some: { status: { not: "VOID" } } } },
      ],
    });
  });
});
