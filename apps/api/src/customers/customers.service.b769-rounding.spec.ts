import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Same stand-in as customers.service.spec.ts: a real advisory lock needs a live DB connection,
// which is out of scope for a unit test — this reproduces just the property
// applyAdvancePaymentToInvoice's lock depends on (mutual exclusion by key), nothing more.
jest.mock("../common/db-locks", () => ({
  withAdvisoryLock: jest.fn((_opts: any, fn: () => Promise<any>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
}));

const MOCK_CUSTOMER = { id: "cust-1", businessName: "Acme Corp" };

// B769: split into its own file rather than grown inline — customers.service.spec.ts is
// already at its size-ratchet ceiling (see common/size-ratchet.spec.ts).
describe("CustomersService — B769 money rounding", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn(), syncInvoiceCommission: jest.fn() },
        },
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), delete: jest.fn(), presignedUrl: jest.fn() },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn() } },
        { provide: RegulatedLedgerService, useValue: { reverseInvoiceEntries: jest.fn() } },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  it("REG-B769 applyAdvancePaymentToInvoice rounds a sub-cent apply amount before writing (10.005 -> 10.01)", async () => {
    prisma.advancePayment.findUnique.mockResolvedValue({
      id: "ap-1",
      balance: 1000,
      customerId: "cust-1",
    });
    prisma.invoice.findUnique.mockResolvedValue({
      id: "inv-1",
      total: 1000,
      status: "SENT",
      dueDate: null,
      payments: [],
    });

    await service.applyAdvancePaymentToInvoice("ap-1", { invoiceId: "inv-1", amount: 10.005 });

    // Unrounded, Math.min(1000, 1000, 10.005) writes 10.005 verbatim to both rows.
    expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ amount: 10.01 }) }),
    );
    expect(prisma.advancePayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { decrement: 10.01 } } }),
    );
  });

  it("REG-B769 createAdvancePayment rounds a sub-cent amount to exactly 0 and refuses it (0.004 -> $0 row)", async () => {
    prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

    // 0.004 is > 0 unrounded, so today's raw write lets a sub-cent "payment" through as a
    // $0.00 AdvancePayment row stored forever. Rounded first, it becomes exactly 0, which the
    // existing `dto.amount <= 0` guard already refuses.
    await expect(
      service.createAdvancePayment("cust-1", { amount: 0.004, method: "CASH" } as any),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.advancePayment.create).not.toHaveBeenCalled();
  });

  it("REG-B769 createAdvancePayment rounds a real sub-cent amount before writing (10.005 -> 10.01)", async () => {
    prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

    await service.createAdvancePayment("cust-1", { amount: 10.005, method: "CASH" } as any);

    expect(prisma.advancePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ amount: 10.01, balance: 10.01 }),
      }),
    );
  });
});
