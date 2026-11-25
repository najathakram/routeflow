/**
 * B1385: a DRAFT (or PENDING) payment's leftover is not spendable credit. Red-first on the wrong values the unfixed code
 * gives: the apply list returns the $200 row, the apply writes a PAID ADVANCE row of $200 on a SENT invoice, and
 * the pure filter keeps the row. Mocked at the module boundary (`forTenant()` / the tenant transaction).
 */
import "reflect-metadata";
import { Test } from "@nestjs/testing";
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
import { API_ERROR_CODES } from "../common/api-error-codes";
import { createMockPrisma } from "../testing/prisma-mock";
import { filterAvailableAdvances } from "./available-credit";

jest.mock("../common/tenant-time-zone", () => ({
  tenantTimeZone: jest.fn().mockResolvedValue(null),
}));
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn((_opts: any, fn: () => Promise<any>) =>
    fn().then((value) => ({ acquired: true, value })),
  ),
}));

/** A $200 excess of a $500 acme group: sourced to the group's first payment row. */
const sourced = (id = "ap-1", sourcePaymentId = "pay-src") => ({
  id,
  customerId: "cust-1",
  balance: 200,
  sourcePaymentId,
  receivedAt: new Date("2026-11-01T12:00:00Z"),
});

describe("B1385: an unconfirmed payment's leftover is not spendable credit", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const sourceStatusIs = (status: string) =>
    prisma.invoicePayment.findMany.mockResolvedValue([{ id: "pay-src", status }]);

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({
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
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
      ],
    }).compile();
    service = module.get(CustomersService);
  });

  describe("filterAvailableAdvances (the one predicate)", () => {
    it.each(["DRAFT", "PENDING", "VOID"])(
      "drops an advance sourced to a %s payment",
      async (status) => {
        sourceStatusIs(status);
        expect(await filterAvailableAdvances(prisma as any, [sourced()])).toEqual([]);
      },
    );

    it("keeps a PAID-sourced advance and an unsourced one", async () => {
      sourceStatusIs("PAID");
      const unsourced = { ...sourced("ap-2", ""), sourcePaymentId: null };
      const kept = await filterAvailableAdvances(prisma as any, [sourced(), unsourced]);
      expect(kept.map((a) => a.id)).toEqual(["ap-1", "ap-2"]);
    });
  });

  describe("getAdvancePayments (the apply list)", () => {
    it("does not list a DRAFT group's $200 excess", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1" });
      prisma.advancePayment.findMany.mockResolvedValue([sourced()]);
      sourceStatusIs("DRAFT");
      expect(await service.getAdvancePayments("cust-1")).toEqual([]);
    });

    it("lists the same excess once its group is PAID", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
      prisma.customer.findUnique.mockResolvedValue({ id: "cust-1" });
      prisma.advancePayment.findMany.mockResolvedValue([sourced()]);
      sourceStatusIs("PAID");
      expect(await service.getAdvancePayments("cust-1")).toHaveLength(1);
    });
  });

  describe("applyAdvancePaymentToInvoice", () => {
    const run = () =>
      (service as any).applyAdvancePaymentToInvoice("ap-1", { invoiceId: "inv-1" }, "cust-1");

    beforeEach(() => {
      prisma.advancePayment.findUnique.mockResolvedValue(sourced());
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        customerId: "cust-1",
        total: 200,
        status: "SENT",
        dueDate: null,
        payments: [],
      });
    });

    it("refuses a DRAFT-sourced advance: coded 400, no PAID ADVANCE row, balance untouched", async () => {
      sourceStatusIs("DRAFT");
      const err: any = await run().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toEqual(
        expect.objectContaining({ code: API_ERROR_CODES.ADVANCE_NOT_AVAILABLE }),
      );
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
      expect(prisma.advancePayment.update).not.toHaveBeenCalled();
      expect(prisma.invoice.update).not.toHaveBeenCalled();
    });
  });
});
