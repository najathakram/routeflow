import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CustomersService } from "./customers.service";
import { CustomersController } from "./customers.controller";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createMockPrisma } from "../testing/prisma-mock";

// Same stand-in as the sibling customers.service specs: a real advisory lock needs a live DB
// connection, so this keeps only the property the apply path relies on (run the callback).
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn((_opts: any, fn: () => Promise<any>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
}));

type ApplyFn = (
  advancePaymentId: string,
  dto: { invoiceId: string; amount?: number },
  routeCustomerId: string,
) => Promise<any>;

/** Advance payment apply checks the invoice's customer (B808): both rows must be one customer's. */
describe("CustomersService.applyAdvancePaymentToInvoice — customer match (B808)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let apply: ApplyFn;

  const advanceOf = (customerId: string, balance = 100) => ({
    id: "ap-1",
    customerId,
    balance,
  });
  const invoiceOf = (customerId: string, total = 60) => ({
    id: "inv-1",
    customerId,
    total,
    status: "SENT",
    dueDate: null,
    payments: [],
  });
  const expectNothingWritten = () => {
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.advancePayment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  };

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
    const target = service as unknown as { applyAdvancePaymentToInvoice: ApplyFn };
    apply = (apId, dto, routeCustomerId) =>
      target.applyAdvancePaymentToInvoice(apId, dto, routeCustomerId);
  });

  it("refuses an invoice that belongs to another customer: 400 with the mismatch code, nothing written", async () => {
    prisma.advancePayment.findUnique.mockResolvedValue(advanceOf("cust-a"));
    prisma.invoice.findUnique.mockResolvedValue(invoiceOf("cust-b"));

    const err: any = await apply("ap-1", { invoiceId: "inv-1" }, "cust-a").catch((e) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({ code: API_ERROR_CODES.ADVANCE_CUSTOMER_MISMATCH }),
    );
    // The advance balance is untouched and no InvoicePayment row exists.
    expectNothingWritten();
  });

  it("refuses when the route's customer is not the advance's customer: 404, nothing written", async () => {
    prisma.advancePayment.findUnique.mockResolvedValue(advanceOf("cust-a"));
    prisma.invoice.findUnique.mockResolvedValue(invoiceOf("cust-a"));

    // `:id` names customer B, but the advance belongs to customer A.
    await expect(apply("ap-1", { invoiceId: "inv-1" }, "cust-b")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expectNothingWritten();
    expect(prisma.invoice.findUnique).not.toHaveBeenCalled();
  });

  it("applies the lesser of the advance balance and the invoice balance for the same customer ($100 advance, $60 invoice -> $60 applied, $40 left)", async () => {
    let balance = 100;
    prisma.advancePayment.findUnique.mockImplementation(async () => advanceOf("cust-a", balance));
    prisma.advancePayment.update.mockImplementation(async ({ data }: any) => {
      balance = Math.round((balance - Number(data.balance.decrement)) * 100) / 100;
      return { id: "ap-1", balance };
    });
    prisma.invoice.findUnique.mockResolvedValue(invoiceOf("cust-a", 60));

    const result = await apply("ap-1", { invoiceId: "inv-1" }, "cust-a");

    expect(result.appliedAmount).toBe(60);
    expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
    expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          invoiceId: "inv-1",
          amount: 60,
          method: "ADVANCE",
          advancePaymentId: "ap-1",
        }),
      }),
    );
    expect(prisma.advancePayment.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { balance: { decrement: 60 } } }),
    );
    expect(balance).toBe(40);
    expect(prisma.invoice.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "PAID" }) }),
    );
  });
});

describe("CustomersController.applyAdvancePayment passes the route customer (B808)", () => {
  it("calls customersService.applyAdvancePaymentToInvoice(apId, dto, id)", () => {
    const controller = Object.create(CustomersController.prototype) as any;
    controller.customersService = { applyAdvancePaymentToInvoice: jest.fn().mockReturnValue("ok") };
    const dto = { invoiceId: "inv-1", amount: 10 };

    expect(controller.applyAdvancePayment("cust-a", "ap-1", dto)).toBe("ok");
    expect(controller.customersService.applyAdvancePaymentToInvoice).toHaveBeenCalledWith(
      "ap-1",
      dto,
      "cust-a",
    );
  });
});
