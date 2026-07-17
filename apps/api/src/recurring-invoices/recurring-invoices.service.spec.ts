import { Test } from "@nestjs/testing";
import { RecurringInvoicesService } from "./recurring-invoices.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { InvoicesService } from "../invoices/invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * Locks the pause/resume contract. `deactivate()` (DELETE) sets isActive=false;
 * `activate()` (POST /:id/activate) sets it back to true — the ONLY resume path,
 * since update() never maps isActive and the ValidationPipe rejects a partial
 * `{ isActive }` PATCH body.
 */
describe("RecurringInvoicesService (pause/resume)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: {} },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    // findOne() (called by activate/deactivate) needs the row to exist.
    prisma.recurringInvoice.findUnique.mockResolvedValue({ id: "ri-1", isActive: false });
    prisma.recurringInvoice.update.mockImplementation((a: any) =>
      Promise.resolve({ id: "ri-1", ...a.data }),
    );
  });

  it("activate() sets isActive=true", async () => {
    const res = await service.activate("ri-1");
    expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
      where: { id: "ri-1" },
      data: { isActive: true },
    });
    expect(res.isActive).toBe(true);
  });

  it("deactivate() sets isActive=false", async () => {
    const res = await service.deactivate("ri-1");
    expect(prisma.recurringInvoice.update).toHaveBeenCalledWith({
      where: { id: "ri-1" },
      data: { isActive: false },
    });
    expect(res.isActive).toBe(false);
  });

  it("activate() 404s when the template is missing", async () => {
    prisma.recurringInvoice.findUnique.mockResolvedValue(null);
    await expect(service.activate("nope")).rejects.toThrow();
    expect(prisma.recurringInvoice.update).not.toHaveBeenCalled();
  });
});

// R5 — auto-send must ACTUALLY email the customer (was mark-as-sent-only, which flipped
// the invoice to SENT without any email despite the "Auto-send to customer" setting).
describe("RecurringInvoicesService (auto-send honesty, R5)", () => {
  let service: RecurringInvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let invoices: { create: jest.Mock; send: jest.Mock; sendEmail: jest.Mock };

  const template = (autoSend: boolean) => ({
    id: "ri-1",
    customerId: "c1",
    discount: 0,
    shippingFee: 0,
    notes: null,
    terms: null,
    autoSend,
    frequency: "MONTHLY",
    dayOfWeek: null,
    dayOfMonth: 1,
    nextRunAt: new Date("2026-07-01"),
    items: [{ description: "x", productId: null, qty: 1, unitPrice: 10, discount: 0, taxRate: 0 }],
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    invoices = {
      create: jest.fn().mockResolvedValue({ id: "inv-1" }),
      send: jest.fn().mockResolvedValue({ id: "inv-1" }),
      sendEmail: jest.fn().mockResolvedValue({ success: true }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        RecurringInvoicesService,
        { provide: PrismaService, useValue: prisma },
        { provide: TenantContextService, useValue: {} },
        { provide: InvoicesService, useValue: invoices },
      ],
    }).compile();
    service = mod.get(RecurringInvoicesService);
    prisma.invoice.update.mockResolvedValue({ id: "inv-1" });
    prisma.recurringInvoice.update.mockResolvedValue({ id: "ri-1" });
  });

  it("auto-send EMAILS the invoice (sendEmail), not the mark-as-sent-only path", async () => {
    await (service as any).generateInvoiceFromTemplate(template(true));
    expect(invoices.sendEmail).toHaveBeenCalledWith("inv-1");
    expect(invoices.send).not.toHaveBeenCalled();
  });

  it("does NOT send anything when autoSend is off", async () => {
    await (service as any).generateInvoiceFromTemplate(template(false));
    expect(invoices.sendEmail).not.toHaveBeenCalled();
    expect(invoices.send).not.toHaveBeenCalled();
  });

  it("still completes generation (no throw) and advances the schedule when the email fails", async () => {
    invoices.sendEmail.mockRejectedValueOnce({ response: { code: "EMAIL_NOT_CONFIGURED" } });
    await expect(
      (service as any).generateInvoiceFromTemplate(template(true)),
    ).resolves.toBeDefined();
    // The invoice is left generated (DRAFT) and the template's nextRunAt still advances.
    expect(prisma.recurringInvoice.update).toHaveBeenCalled();
  });
});
