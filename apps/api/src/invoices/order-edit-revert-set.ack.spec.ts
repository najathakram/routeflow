import { ConflictException } from "@nestjs/common";
import {
  revertLinkedInvoicesToDraft,
  seesSentRevertConfirm,
  sentRevertNeedsAck,
} from "./order-edit-revert-set";

/**
 * B1372 N2 (SA-1177 A2 K3): the server enforces the "this edit turns sent invoices back into drafts" confirm. Under the
 * edit's row lock, an unconfirmed staff edit whose revert set holds a sent invoice is a 409 naming it, before any write.
 * Placeholders only.
 */
describe("revertLinkedInvoicesToDraft: the sent-revert confirm (B1372 N2)", () => {
  const sentInvoice = {
    id: "inv-1",
    invoiceNumber: "INV-1001",
    internalNotes: null,
    depositPercent: null,
  };
  const db = (sent: unknown[]) => {
    const calls: string[] = [];
    return {
      calls,
      invoice: {
        findMany: jest.fn(async ({ where }: any) => {
          if (where.OR) return []; // the blocking read: nothing paid or closed
          if (where.status?.in) return sent; // the revert set
          calls.push("lock-read");
          return sent.map((s: any) => ({ id: s.id }));
        }),
        count: jest.fn().mockResolvedValue(1),
        update: jest.fn(async () => calls.push("update")),
      },
      invoicePayment: { count: jest.fn().mockResolvedValue(0) },
      order: { findFirst: jest.fn().mockResolvedValue({ status: "PENDING" }) },
      $executeRaw: jest.fn(async () => {
        calls.push("lock");
        return 0;
      }),
    };
  };

  it("PIN: an invoice sent between the read and the save, no ack: 409 with its number, under the lock, nothing written", async () => {
    const d = db([sentInvoice]);
    const err = await revertLinkedInvoicesToDraft(d, "o1", {
      lockRows: true,
      requireAck: true,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "ORDER_EDIT_REVERTS_SENT_INVOICE",
      invoiceNumbers: ["INV-1001"],
    });
    expect(d.invoice.update).not.toHaveBeenCalled();
    expect(d.calls).toEqual(["lock-read", "lock"]);
  });

  it("with the ack (requireAck false): it reverts as before", async () => {
    const d = db([sentInvoice]);
    expect(await revertLinkedInvoicesToDraft(d, "o1", { lockRows: true })).toEqual(["inv-1"]);
    expect(d.invoice.update).toHaveBeenCalledTimes(1);
  });

  it("no sent invoice in the set: no 409 even without the ack", async () => {
    expect(await revertLinkedInvoicesToDraft(db([]), "o1", { requireAck: true })).toEqual([]);
  });

  it("the read-only preflight never asks for the ack", async () => {
    const d = db([sentInvoice]);
    expect(
      await revertLinkedInvoicesToDraft(d, "o1", { preflightOnly: true, requireAck: true }),
    ).toEqual([]);
    expect(d.invoice.update).not.toHaveBeenCalled();
  });
});

describe("who must confirm (B1372 N2, one predicate with the order read)", () => {
  it.each(["TENANT_ADMIN", "OPERATOR", "SUPER_ADMIN"])("%s sees the confirm", (role) => {
    expect(seesSentRevertConfirm(role)).toBe(true);
  });

  it.each(["CUSTOMER", "DRIVER", null, undefined])("%s never sees it", (role) => {
    expect(seesSentRevertConfirm(role)).toBe(false);
  });

  it("staff with no ack must confirm; with the ack, or in the create-merge, need not", () => {
    const staff = { role: "OPERATOR" };
    expect(sentRevertNeedsAck(staff, {})).toBe(true);
    expect(sentRevertNeedsAck(staff, { ackSentRevert: true })).toBe(false);
    expect(sentRevertNeedsAck(staff, {}, { isCreateMerge: true })).toBe(false);
  });

  it("a buyer, a driver or no user (a system call) is never asked", () => {
    expect(sentRevertNeedsAck({ role: "CUSTOMER" }, {})).toBe(false);
    expect(sentRevertNeedsAck({ role: "DRIVER" }, {})).toBe(false);
    expect(sentRevertNeedsAck(undefined, {})).toBe(false);
  });
});
