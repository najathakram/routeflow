/**
 * Row 510 (rulings Q2 + SA-205) — a recurring INVOICE and its restricted lines:
 *  - MANUAL "Run now" (POST /recurring-invoices/:id/run) is the warning dialog for the clicker: the choke point is asked
 *    as STAFF with the clicker as principal, the optional body ack and the invoice create's own `n:<index>` keys; a
 *    breach is 409 RESTRICTION_WARNING (the template untouched, nothing claimed, no invoice); with a valid ack the
 *    invoice is created with the ack and the clicker, so the stamps are written BY THAT USER;
 *  - SCHEDULED runs keep SA-205: the whole cycle is skipped (never a partial invoice with the clean lines), staff are
 *    told, the template is suspended; no ack is ever applied and no stamp is ever written;
 *  - an override is never carried forward: the next scheduled run starts with no ack at all.
 * The choke point and the stamps themselves are proven in the selling-restrictions specs and the DB lane.
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
import type { JwtPayload } from "../auth/jwt-payload.interface";

const operator = { sub: "u-op", role: "OPERATOR", tenantId: "test-tenant" } as JwtPayload;
const ack = {
  warningHash: "rw1:abc",
  restrictionOverrides: [{ lineKey: "n:0", reason: "Licensed buyer" }],
};

describe("RecurringInvoicesService — Run now takes the ack, scheduled runs skip the cycle (row 510)", () => {
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
    discount: 0,
    shippingFee: 0,
    items: [
      { productId: "p-banned", description: "Banned", qty: 1, unitPrice: 10, discount: 0 },
      { productId: "p-clean", description: "Clean A", qty: 1, unitPrice: 5, discount: 0 },
      { productId: null, description: "Custom fee", qty: 1, unitPrice: 5, discount: 0 },
    ],
    customer: { id: "c1" },
  };
  const block = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-banned", productName: "Banned Cola", ruleId: "rule-1" }],
  };
  const warning = () =>
    new ConflictException({
      code: "RESTRICTION_WARNING",
      message: "This sale includes a restricted product. Give a reason to sell it anyway.",
      lines: [{ lineKey: "n:0", productId: "p-banned" }],
      warningHash: "rw1:abc",
    });

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    prisma.recurringInvoice.findUnique.mockResolvedValue(ri);
    prisma.recurringInvoice.updateMany.mockResolvedValue({ count: 1 });
    prisma.product.findMany.mockResolvedValue([]);
    prisma.user.findMany.mockResolvedValue([{ id: "op1" }, { id: "admin1" }]);
    restrictions.assertLinesSellable.mockResolvedValue({ stamp: jest.fn() });
    restrictions.checkLinesSellable.mockResolvedValue({ outcome: "ALLOW", reasons: [] });
    notifications.sendToUser.mockResolvedValue(1);
    invoices.create.mockResolvedValue({ id: "inv-1" });
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

  describe("Run now (manual)", () => {
    it("asks as STAFF with the clicker, the ack and the invoice's own line keys (the productless line is not asked about)", async () => {
      await service.runNow("ri1", operator, ack);
      expect(restrictions.assertLinesSellable).toHaveBeenCalledTimes(1);
      const call = restrictions.assertLinesSellable.mock.calls[0][0];
      expect(call).toMatchObject({
        tenantId: "test-tenant",
        customerId: "c1",
        channel: "STAFF",
        document: "INVOICE",
        path: "DELIVERY",
        principal: operator,
        ack,
        lines: [
          { productId: "p-banned", lineKey: "n:0" },
          { productId: "p-clean", lineKey: "n:1" },
        ],
      });
    });

    it("a breach is 409 RESTRICTION_WARNING: no claim, no invoice, no suspension, no notice", async () => {
      restrictions.assertLinesSellable.mockRejectedValue(warning());
      await expect(service.runNow("ri1", operator)).rejects.toMatchObject({
        response: { code: "RESTRICTION_WARNING", warningHash: "rw1:abc" },
      });
      expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled();
      expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
      expect(invoices.create).not.toHaveBeenCalled();
      expect(notifications.sendToUser).not.toHaveBeenCalled();
    });

    it("with a valid ack the invoice is generated WITH the ack and the clicker (so the stamps are by that user)", async () => {
      await service.runNow("ri1", operator, ack);
      expect(invoices.create).toHaveBeenCalledTimes(1);
      const [dto, actor] = invoices.create.mock.calls[0];
      expect(actor).toBe(operator);
      expect(dto.warningHash).toBe("rw1:abc");
      expect(dto.restrictionOverrides).toEqual(ack.restrictionOverrides);
      // the lines are exactly the template's (nothing dropped, so the keys the warning named still match)
      expect(dto.items.map((i: any) => i.productId)).toEqual(["p-banned", "p-clean", null]);
    });

    it("no body at all (first press) passes no ack and no overrides", async () => {
      await service.runNow("ri1", operator);
      const [dto] = invoices.create.mock.calls[0];
      expect(dto.warningHash).toBeUndefined();
      expect(dto.restrictionOverrides).toBeUndefined();
    });
  });

  describe("scheduled run (SA-205): skip the cycle, notify, suspend, never partial", () => {
    const cron = () => (service as any).generateInvoiceFromTemplate(ri);

    it("1 breached + 1 clean + 1 custom line issues NOTHING (no 2-line partial invoice) and claims nothing", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      expect(await cron()).toBeNull();
      expect(invoices.create).not.toHaveBeenCalled();
      expect(prisma.recurringInvoice.updateMany).not.toHaveBeenCalled();
    });

    it("suspends the template (cycle moved past now), audits it and tells each operator and admin once", async () => {
      restrictions.checkLinesSellable.mockResolvedValue(block);
      await cron();
      expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
        where: { id: "ri1" },
        data: expect.objectContaining({ isActive: false, lastRunStatus: "FAILED" }),
      });
      expect(
        prisma.recurringInvoice.update.mock.calls[0][0].data.nextRunAt.getTime(),
      ).toBeGreaterThan(Date.now());
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ action: "recurring-invoice.suspended" }),
      });
      expect(notifications.sendToUser).toHaveBeenCalledTimes(2);
      expect(notifications.sendToUser.mock.calls[0][1].body).toContain("Banned Cola");
    });

    it("never asks for an ack and never passes one or an actor to the create (an override is not carried forward)", async () => {
      await cron(); // ALLOW: the cycle is billed
      expect(restrictions.assertLinesSellable).not.toHaveBeenCalled();
      expect(invoices.create).toHaveBeenCalledTimes(1);
      const [dto, actor] = invoices.create.mock.calls[0];
      expect(actor).toBeUndefined();
      expect(dto).not.toHaveProperty("warningHash");
      expect(dto).not.toHaveProperty("restrictionOverrides");
    });
  });
});
