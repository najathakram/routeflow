/**
 * Security tests for the credit-notes module.
 *
 * F10-003: findAllForUser returns [] for a DRIVER, but findOneForUser used to
 * gate only CUSTOMER and fall through for DRIVER — so a driver could read any
 * credit note in the tenant by id. findOneForUser now denies DRIVER outright,
 * mirroring the list. OPERATOR keeps full access; a CUSTOMER keeps own-only.
 */
import { Test } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";

const MOCK_CN = {
  id: "cn-1",
  customerId: "cust-1",
  creditNoteNumber: "CN-2026-001",
  customer: { id: "cust-1", businessName: "Acme" },
  invoice: { id: "inv-1", invoiceNumber: "INV-1" },
};

const jwt = (role: string, sub = "u1") =>
  ({ sub, role, status: "ACTIVE", forcePasswordChange: false }) as any;

describe("CreditNotesService — F10-003 findOneForUser role gate", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn(),
            unreverseCreditNoteEntries: jest.fn(),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.creditNote.findUnique.mockResolvedValue(MOCK_CN);
  });

  it("DRIVER is denied (403) and never even reads the credit note", async () => {
    await expect(service.findOneForUser("cn-1", jwt("DRIVER"))).rejects.toThrow(ForbiddenException);
    expect(prisma.creditNote.findUnique).not.toHaveBeenCalled();
  });

  it("OPERATOR can read any credit note", async () => {
    const cn = await service.findOneForUser("cn-1", jwt("OPERATOR"));
    expect(cn.id).toBe("cn-1");
    expect(prisma.customer.findFirst).not.toHaveBeenCalled();
  });

  it("CUSTOMER can read their own credit note", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    const cn = await service.findOneForUser("cn-1", jwt("CUSTOMER", "cust-user"));
    expect(cn.id).toBe("cn-1");
  });

  it("CUSTOMER cannot read another customer's credit note (403)", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-OTHER" });
    await expect(service.findOneForUser("cn-1", jwt("CUSTOMER", "other-user"))).rejects.toThrow(
      ForbiddenException,
    );
  });
});
