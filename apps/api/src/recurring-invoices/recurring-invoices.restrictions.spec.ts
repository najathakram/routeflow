/**
 * F-05 (#2093, SA-205) — a recurring invoice SELLS its lines. A banned line refuses the WHOLE document:
 * it is never dropped so the rest issues (that would change the invoice's money with nobody deciding).
 *  - "Run now" is an operator deciding: 409, the template untouched;
 *  - the unattended run skips the cycle BEFORE it is claimed, suspends the template, writes an AuditLog row
 *    and notifies once; a tenant-owned template sells as STAFF;
 *  - productless (custom) lines are exempt by owner ruling: they are not asked about.
 * The choke point itself is proven in `selling-restrictions.service.spec.ts`.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("RecurringInvoicesService — selling restrictions (F-05)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const restrictions = { assertLinesSellable: jest.fn(), checkLinesSellable: jest.fn() };
  const notifications = { sendToUser: jest.fn() };
  const invoices = { create: jest.fn() };
  const ri = {
    id: "ri1",
    customerId: "c1",
    frequency: "MONTHLY",
    dayOfMonth: 1,
    nextRunAt: new Date("2026-09-01T00:00:00Z"),
    items: [
      { productId: "p-banned", description: "Banned", qty: 1, unitPrice: 10 },
      { productId: null, description: "Custom fee", qty: 1, unitPrice: 5 },
    ],
    customer: { id: "c1" },
  };
  const block = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" }],
  };
  const cron = () => (service as any).generateInvoiceFromTemplate(ri);

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    restrictions.assertLinesSellable.mockResolvedValue(undefined);
    restrictions.checkLinesSellable.mockResolvedValue(block);
    notifications.sendToUser.mockResolvedValue(1);
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }, { id: "op2" }]);
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: invoices },
        { provide: SellingRestrictionsService, useValue: restrictions },
        { provide: NotificationsService, useValue: notifications },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
  });

  it("the unattended run skips the whole cycle, unclaimed: no invoice, no claim, and productless lines are not asked about", async () => {
    expect(await cron()).toBeNull();
    expect(restrictions.checkLinesSellable).toHaveBeenCalledWith({
      tenantId: "test-tenant",
      customerId: "c1",
      lines: [{ productId: "p-banned" }],
      channel: "STAFF",
    });
    expect(invoices.create).not.toHaveBeenCalled();
    // the only template write is the suspension — the cycle is never claimed (nextRunAt untouched)
    expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled();
  });

  it("suspends the template with the reason, audits it (rule ids) and notifies each operator once", async () => {
    await cron();
    expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
      where: { id: "ri1" },
      data: expect.objectContaining({
        isActive: false,
        lastRunStatus: "FAILED",
        lastError: expect.stringContaining("Banned Cola"),
      }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "recurring-invoice.suspended",
        entityId: "ri1",
        meta: expect.objectContaining({ ruleIds: ["rule-1"] }),
      }),
    });
    expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
  });

  it("an ALLOW verdict does not suspend anything", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 0 }); // stop at the claim
    await cron();
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("Run now is refused with the 409 and leaves the template alone", async () => {
    prisma.recurringInvoice.findUnique.mockResolvedValue(ri);
    restrictions.assertLinesSellable.mockRejectedValue(
      new ConflictException({ code: "SELLING_RESTRICTED", message: "banned", blockedLines: [] }),
    );
    await expect(service.runNow("ri1")).rejects.toMatchObject({
      response: { code: "SELLING_RESTRICTED" },
    });
    expect(restrictions.assertLinesSellable).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "STAFF", lines: [{ productId: "p-banned" }] }),
    );
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
    expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled();
  });

  it("suspend moves nextRunAt forward IN THE SAME UPDATE; reactivating then bills exactly ONE invoice, for the NEXT cycle", async () => {
    await cron();
    const data = prisma.recurringInvoice.update.mock.calls[0][0].data;
    expect(data.isActive).toBe(false);
    expect(data.nextRunAt.getTime()).toBeGreaterThan(Date.now()); // the skipped cycle is never a make-up
    // reactivation is audited...
    prisma.recurringInvoice.findUnique.mockResolvedValue(ri);
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri1", isActive: true });
    await service.activate("ri1", "u9");
    expect(prisma.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: "recurring-invoice.reactivated", userId: "u9" }),
    });
    // ...and the next due tick (nextRunAt reached, ban lifted) claims THAT cycle once and issues one invoice
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    invoices.create.mockResolvedValue({ id: "inv-1" });
    await (service as any)
      .generateInvoiceFromTemplate({ ...ri, nextRunAt: data.nextRunAt })
      .catch(() => undefined);
    expect(prisma.recurringInvoice.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurringInvoice.updateMany.mock.calls[0][0].where.nextRunAt).toEqual(
      data.nextRunAt,
    );
    expect(invoices.create).toHaveBeenCalledTimes(1);
  });
});
