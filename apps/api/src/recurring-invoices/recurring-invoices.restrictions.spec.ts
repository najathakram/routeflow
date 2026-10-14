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
      fulfilmentKind: "DELIVERY",
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
    prisma.recurringInvoice.findUnique.mockResolvedValue({ ...ri, isActive: false });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    await service.activate("ri1", "u9");
    prisma.recurringInvoice.updateMany.mockClear(); // only the cron's claim below is counted
    expect(prisma.auditLog.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({ action: "recurring-invoice.reactivated", userId: "u9" }),
    });
    // ...and the next due tick (nextRunAt reached, ban lifted) claims THAT cycle once and issues one invoice
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    invoices.create.mockResolvedValue({ id: "inv-1" });
    await (service as any).generateInvoiceFromTemplate({ ...ri, nextRunAt: data.nextRunAt });
    expect(prisma.recurringInvoice.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.recurringInvoice.updateMany.mock.calls[0][0].where.nextRunAt).toEqual(
      data.nextRunAt,
    );
    expect(invoices.create).toHaveBeenCalledTimes(1);
  });

  describe("reactivation never bills a cycle inside the suspension (SA-247(b), Opus #2129)", () => {
    const suspended = (
      nextRunAt: Date,
      lastError = "Suspended: a line is under a selling restriction (X).",
    ) => ({
      ...ri,
      nextRunAt,
      lastError,
    });
    const activate = async (row: object) => {
      prisma.recurringInvoice.findUnique.mockResolvedValue({ isActive: false, ...row });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
      await service.activate("ri1", "u9");
      return prisma.recurringInvoice.updateMany.mock.calls[0]?.[0]?.data;
    };

    it("the clock is past nextRunAt: it moves to the next occurrence AFTER NOW and the audit records the skipped cycle", async () => {
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const data = await activate(suspended(past));
      expect(data.isActive).toBe(true);
      expect(data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: "recurring-invoice.reactivated",
        meta: { skippedCycleDueAt: past.toISOString() },
      });
    });

    it("nextRunAt still in the future: left alone", async () => {
      const future = new Date(Date.now() + 5 * 24 * 3600 * 1000);
      const data = await activate(suspended(future));
      expect(data).toEqual({ isActive: true, lastRunStatus: null, lastError: null });
    });

    it("an admin-paused template (no restriction suspension) is treated the same: a stale date is advanced (SA-268)", async () => {
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const data = await activate(suspended(past, "boom"));
      expect(data.nextRunAt.getTime()).toBeGreaterThan(Date.now());
      expect(prisma.auditLog.create.mock.calls[0][0].data.meta).toMatchObject({
        skippedCycleDueAt: past.toISOString(),
      });
    });

    it("activate on an ACTIVE template changes nothing: no update, no audit, the failed cycle is not advanced (money)", async () => {
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      prisma.recurringInvoice.findUnique.mockResolvedValue({
        ...suspended(past, "boom"),
        isActive: true,
      });
      const res = await service.activate("ri1", "u9");
      expect(res).toMatchObject({ isActive: true });
      expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("the update is CONDITIONAL on isActive=false, and a lost race (count 0) writes no audit", async () => {
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      prisma.recurringInvoice.findUnique.mockResolvedValue({ ...suspended(past), isActive: false });
      prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 0 });
      await service.activate("ri1", "u9");
      expect(prisma.recurringInvoice.updateMany.mock.calls[0][0].where).toEqual({
        id: "ri1",
        isActive: false,
      });
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      // a lost race returns a FRESH read (findOne + the re-read), never the stale row
      expect(prisma.recurringInvoice.findUnique).toHaveBeenCalledTimes(2);
    });

    it("an admin-paused template's own lastError is left alone (only the suspension notice is cleared)", async () => {
      const past = new Date(Date.now() - 3 * 24 * 3600 * 1000);
      const data = await activate(suspended(past, "boom"));
      expect(data).not.toHaveProperty("lastError");
    });
  });
});
