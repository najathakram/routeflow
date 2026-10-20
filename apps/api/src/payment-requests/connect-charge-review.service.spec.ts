/**
 * Row 616: a Stripe refund / dispute on a connected account must FLAG the paid invoice for
 * review (never change an amount or a status) and tell the tenant's staff once.
 * Mocked at the module boundary; the DB is never touched.
 */
import { Test } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { ConnectChargeReviewService } from "./connect-charge-review.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ConnectChargeReviewService", () => {
  let service: ConnectChargeReviewService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const tenantContext = { run: jest.fn((_id: string, fn: () => unknown) => fn()) };
  const notifications = { sendToUser: jest.fn() };
  const audit = { log: jest.fn() };

  const input = {
    tenantId: "tenant-1",
    kind: "refund" as const,
    eventId: "evt_1",
    paymentIntentId: "pi_1",
    chargeId: "ch_1",
  };
  const payment = (internalNotes: string | null = null) => ({
    id: "pay-1",
    invoice: { id: "inv-1", invoiceNumber: "INV-100", internalNotes },
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    (prisma as any).invoicePayment.findMany = jest.fn().mockResolvedValue([payment()]);
    (prisma as any).invoice.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma as any).advancePayment.findMany = jest.fn().mockResolvedValue([]);
    (prisma as any).advancePayment.updateMany = jest.fn().mockResolvedValue({ count: 1 });
    (prisma as any).user.findMany = jest.fn().mockResolvedValue([{ id: "op-1" }, { id: "op-2" }]);
    notifications.sendToUser.mockResolvedValue(1);
    audit.log.mockResolvedValue(undefined);
    const module = await Test.createTestingModule({
      providers: [
        ConnectChargeReviewService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: tenantContext },
        { provide: NotificationsService, useValue: notifications },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = module.get(ConnectChargeReviewService);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });

  it("flags the invoice (notes breadcrumb, no status/amount change) and notifies staff once", async () => {
    await expect(service.flagForReview(input)).resolves.toBe("flagged");

    expect(tenantContext.run).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    expect((prisma as any).invoicePayment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          reference: "pi_1",
          status: "PAID",
          method: { in: ["CREDIT_CARD", "ACH"] },
        },
      }),
    );
    const call = (prisma as any).invoice.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: "inv-1", internalNotes: null });
    expect(Object.keys(call.data)).toEqual(["internalNotes"]);
    expect(call.data.internalNotes).toContain("[REVIEW]");
    expect(call.data.internalNotes).toContain("evt_1");
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "Invoice", entityId: "inv-1", tenantId: "tenant-1" }),
    );
    // staff of THIS tenant only, one push each, invoice number but no customer data
    expect((prisma as any).user.findMany.mock.calls[0][0].where.tenantId).toBe("tenant-1");
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    const [, payload] = notifications.sendToUser.mock.calls[0];
    expect(payload.body).toContain("INV-100");
  });

  it("appends to existing internal notes instead of replacing them", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([payment("earlier note")]);
    await service.flagForReview(input);
    const call = (prisma as any).invoice.updateMany.mock.calls[0][0];
    expect(call.where.internalNotes).toBe("earlier note");
    expect(call.data.internalNotes.startsWith("earlier note\n[REVIEW]")).toBe(true);
  });

  it("a redelivered event does not flag or notify a second time", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([
      payment("[REVIEW] Stripe reported a refund ... (evt_1)."),
    ]);
    await expect(service.flagForReview(input)).resolves.toBe("already_flagged");
    expect((prisma as any).invoice.updateMany).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("throws when the flag write fails so the webhook answers non-2xx, and notifies nobody", async () => {
    (prisma as any).invoice.updateMany.mockRejectedValue(new Error("db down"));
    await expect(service.flagForReview(input)).rejects.toThrow("db down");
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("throws when a concurrent edit makes the compare-and-set miss", async () => {
    (prisma as any).invoice.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.flagForReview(input)).rejects.toThrow(/changed while flagging/);
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("an unknown PaymentIntent is a warn + no_matching_payment with no notification", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([]);
    await expect(service.flagForReview(input)).resolves.toBe("no_matching_payment");
    expect(Logger.prototype.warn).toHaveBeenCalled();
    expect((prisma as any).invoice.updateMany).not.toHaveBeenCalled();
    expect(notifications.sendToUser).not.toHaveBeenCalled();
  });

  it("a charge with no PaymentIntent is a warn + no_matching_payment", async () => {
    await expect(service.flagForReview({ ...input, paymentIntentId: null })).resolves.toBe(
      "no_matching_payment",
    );
    expect((prisma as any).invoicePayment.findMany).not.toHaveBeenCalled();
  });

  it("a push failure never fails the webhook once the flag is durable", async () => {
    notifications.sendToUser.mockRejectedValue(new Error("expo down"));
    await expect(service.flagForReview(input)).resolves.toBe("flagged");
  });

  it("one PaymentIntent split across invoices flags each invoice and sends one message per staff member", async () => {
    (prisma as any).invoicePayment.findMany.mockResolvedValue([
      payment(),
      { id: "pay-2", invoice: { id: "inv-2", invoiceNumber: "INV-101", internalNotes: null } },
    ]);
    await expect(service.flagForReview({ ...input, kind: "dispute" })).resolves.toBe("flagged");
    expect((prisma as any).invoice.updateMany).toHaveBeenCalledTimes(2);
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    expect(notifications.sendToUser.mock.calls[0][1].body).toContain("INV-100, INV-101");
  });

  describe("on-account credit (AdvancePayment) booked from the same PaymentIntent", () => {
    const advance = (notes: string | null = null) => ({ id: "adv-1", notes });

    it("flags an advance-only settlement (no InvoicePayment) and notifies once", async () => {
      (prisma as any).invoicePayment.findMany.mockResolvedValue([]);
      (prisma as any).advancePayment.findMany.mockResolvedValue([advance()]);

      await expect(service.flagForReview(input)).resolves.toBe("flagged");

      expect((prisma as any).advancePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { reference: "pi_1", method: { in: ["CREDIT_CARD", "ACH"] } },
        }),
      );
      const call = (prisma as any).advancePayment.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: "adv-1", notes: null });
      expect(Object.keys(call.data)).toEqual(["notes"]);
      expect(call.data.notes).toContain("[REVIEW]");
      expect(call.data.notes).toContain("evt_1");
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ entityType: "AdvancePayment", entityId: "adv-1" }),
      );
      expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
    });

    it("a split payment flags BOTH the invoice and the on-account credit", async () => {
      (prisma as any).advancePayment.findMany.mockResolvedValue([advance("old")]);

      await expect(service.flagForReview(input)).resolves.toBe("flagged");

      expect((prisma as any).invoice.updateMany).toHaveBeenCalledTimes(1);
      const call = (prisma as any).advancePayment.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({ id: "adv-1", notes: "old" });
      expect(call.data.notes.startsWith("old\n[REVIEW]")).toBe(true);
      expect(notifications.sendToUser.mock.calls[0][1].body).toContain("INV-100");
    });

    it("redelivery with both already flagged does nothing", async () => {
      (prisma as any).invoicePayment.findMany.mockResolvedValue([payment("[REVIEW] (evt_1)")]);
      (prisma as any).advancePayment.findMany.mockResolvedValue([advance("[REVIEW] (evt_1)")]);

      await expect(service.flagForReview(input)).resolves.toBe("already_flagged");

      expect((prisma as any).advancePayment.updateMany).not.toHaveBeenCalled();
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });

    it("redelivery after the invoice flag landed but the advance flag failed flags the advance", async () => {
      (prisma as any).invoicePayment.findMany.mockResolvedValue([payment("[REVIEW] (evt_1)")]);
      (prisma as any).advancePayment.findMany.mockResolvedValue([advance()]);

      await expect(service.flagForReview(input)).resolves.toBe("flagged");

      expect((prisma as any).invoice.updateMany).not.toHaveBeenCalled();
      expect((prisma as any).advancePayment.updateMany).toHaveBeenCalledTimes(1);
    });

    it("an advance flag write failure throws and notifies nobody", async () => {
      (prisma as any).advancePayment.findMany.mockResolvedValue([advance()]);
      (prisma as any).advancePayment.updateMany.mockRejectedValue(new Error("db down"));
      await expect(service.flagForReview(input)).rejects.toThrow("db down");
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });
  });

  it("sends the staff pushes in parallel, and one slow push does not block the rest", async () => {
    const started: string[] = [];
    notifications.sendToUser.mockImplementation((id: string) => {
      started.push(id);
      return id === "op-1" ? new Promise(() => undefined) : Promise.resolve(1);
    });
    // op-1 never resolves: a serial loop would hang here and never reach op-2.
    const done = service.flagForReview(input);
    await new Promise((r) => setTimeout(r, 20));
    expect(started).toEqual(["op-1", "op-2"]);
    void done;
  });
});
