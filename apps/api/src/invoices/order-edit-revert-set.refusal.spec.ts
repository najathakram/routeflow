import { BadRequestException } from "@nestjs/common";
import {
  DOOR_EDIT_INVOICE_HAS_PAYMENTS_MESSAGE,
  EDIT_BLOCKING_INVOICE_WHERE,
  EDIT_BLOCKING_STATUSES,
  doorRefusalCopy,
  revertLinkedInvoicesToDraft,
} from "./order-edit-revert-set";

/** SA-1144: the unit lane catches the refusal going missing (the DB spec is the only other net). */
describe("revertLinkedInvoicesToDraft refusal (SA-1144)", () => {
  const db = (heldStatus: string | null, sent: unknown[] = []) => ({
    invoice: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.status.in.includes("PAID")) {
          return heldStatus
            ? [{ id: "i1", invoiceNumber: "INV-1", depositPercent: null, status: heldStatus }]
            : [];
        }
        return sent;
      }),
      count: jest.fn(),
      update: jest.fn(),
    },
    invoicePayment: { count: jest.fn().mockResolvedValue(0) },
    order: { findFirst: jest.fn() },
  });

  it.each(["PAID", "PARTIAL", "WRITTEN_OFF"])(
    "a %s invoice refuses with ORDER_EDIT_INVOICE_HAS_PAYMENTS and writes nothing",
    async (status) => {
      const d = db(status);
      const err = await revertLinkedInvoicesToDraft(d, "o1").catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS" });
      expect(d.invoice.update).not.toHaveBeenCalled();
    },
  );

  it("refuses under preflightOnly too, and says 'written off' for a written-off invoice", async () => {
    const err = await revertLinkedInvoicesToDraft(db("WRITTEN_OFF"), "o1", {
      preflightOnly: true,
    }).catch((e) => e);
    expect(err.getResponse().message).toContain("written off");
  });

  it("no money-holding invoice: nothing refuses", async () => {
    expect(await revertLinkedInvoicesToDraft(db(null), "o1")).toEqual([]);
  });

  it("the merge fragment reads the same status list and also catches a live payment", () => {
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

describe("doorRefusalCopy (SA-1144 D6)", () => {
  it("swaps the message for the driver's copy and keeps the code and the 400", () => {
    const src = new BadRequestException({
      code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS",
      message: "Remove its payments first",
    });
    const out = (() => {
      try {
        return doorRefusalCopy(src);
      } catch (e) {
        return e as BadRequestException;
      }
    })();
    expect(out.getStatus()).toBe(400);
    expect(out.getResponse()).toEqual({
      code: "ORDER_EDIT_INVOICE_HAS_PAYMENTS",
      message: DOOR_EDIT_INVOICE_HAS_PAYMENTS_MESSAGE,
    });
  });

  it("passes any other error through unchanged", () => {
    const other = new Error("boom");
    expect(() => doorRefusalCopy(other)).toThrow(other);
    const bad = new BadRequestException("plain");
    expect(() => doorRefusalCopy(bad)).toThrow(bad);
  });
});
