import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * B981: the two customer-create refusals carry a stable `body.code`, so clients map copy by code and not by
 * an exact server string. The message stays for logs and API callers.
 */
describe("CustomersService.create refusals carry a body.code (B981)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };
    const mod = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        { provide: StorageService, useValue: {} },
        {
          provide: MeterService,
          useValue: {
            read: jest.fn().mockResolvedValue({
              meter: "CUSTOMERS",
              used: 0,
              included: null,
              remaining: null,
              resetsAt: null,
            }),
          },
        },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: EmailService, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
      ],
    }).compile();
    service = mod.get(CustomersService);
  });

  it("a taken email or username is a 400 with body.code CUSTOMER_EMAIL_OR_USERNAME_TAKEN", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "existing" });
    const err: any = await service
      .create({ username: "taken", businessName: "Test", contactName: "Test" } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({
        code: API_ERROR_CODES.CUSTOMER_EMAIL_OR_USERNAME_TAKEN,
        message: "Email or username already taken",
      }),
    );
  });

  it("an unknown sales agent is a 400 with body.code CUSTOMER_SALES_AGENT_UNKNOWN", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const tx = {
      user: { create: jest.fn().mockResolvedValue({ id: "u1" }) },
      customer: { create: jest.fn().mockResolvedValue({ id: "c1" }) },
      customerAddress: { createMany: jest.fn() },
      salesAgent: { findFirst: jest.fn().mockResolvedValue(null) },
      agentAssignment: { create: jest.fn() },
    };
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) => fn(tx));
    const err: any = await service
      .create({
        username: "acme",
        businessName: "Acme",
        contactName: "Jane",
        salesAgentId: "gone",
      } as any)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.getResponse()).toEqual(
      expect.objectContaining({
        code: API_ERROR_CODES.CUSTOMER_SALES_AGENT_UNKNOWN,
        message: "Unknown sales agent",
      }),
    );
    expect(tx.agentAssignment.create).not.toHaveBeenCalled();
  });
});
