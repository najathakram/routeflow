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
