/**
 * #2572 (tier 2): a row INSERTed for a customer after the delete's in-tx reads (a concurrent
 * invoice create) makes the customer-row delete fail on the foreign key: a raw Prisma P2003,
 * which reached the client as a 500. Every customer delete now maps a P2003 from THAT statement
 * to a 409 (the tx rolls back, nothing deleted); any other error passes through unchanged. The
 * real-PG behaviour is pinned in customer-delete-fk-race-2572.db.spec.ts. Red-first.
 * Bootstrap copied from imported-customers-guard-2569.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";

const fkViolation = () =>
  new Prisma.PrismaClientKnownRequestError("Foreign key constraint violated on the constraint", {
    code: "P2003",
    clientVersion: "test",
  });

describe("customer deletes: a late FK insert is a 409, not a raw P2003 500 (#2572)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockResolvedValue([
      { id: "cust-1", userId: "user-1", customerLink: null },
    ] as any);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        // B65-class invariant: CustomersService now reverses a destroyed
        // invoice's regulated-ledger entries, so the collaborator must be provided.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  const refused = (caught: any) => {
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.message).toBe(
      "Customer records changed while deleting — nothing was deleted; please retry.",
    );
  };

  it("deleteAllCustomers: a P2003 on the customer delete ⇒ 409, the users are not deleted", async () => {
    prisma.customer.deleteMany.mockRejectedValue(fkViolation());
    refused(await service.deleteAllCustomers().catch((e) => e));
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteImportedCustomers: a P2003 on the customer delete ⇒ 409, the users are not deleted", async () => {
    prisma.customer.deleteMany.mockRejectedValue(fkViolation());
    refused(await service.runImportedCustomersCleanup().catch((e) => e));
    expect(prisma.user.deleteMany).not.toHaveBeenCalled();
  });

  it("deleteCustomer (record-free hard delete): a P2003 on the customer delete ⇒ 409, the user is not deleted", async () => {
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      userId: "user-1",
      deletedAt: null,
      user: { status: "ACTIVE", username: "shop" },
    } as any);
    prisma.customer.delete.mockRejectedValue(fkViolation());
    refused(await service.deleteCustomer("cust-1").catch((e) => e));
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a non-FK Prisma error",
      () => new Prisma.PrismaClientKnownRequestError("x", { code: "P2034", clientVersion: "test" }),
    ],
    ["a plain error", () => new Error("db down")],
  ])("%s from the customer delete passes through unchanged", async (_n, make) => {
    const err = make();
    prisma.customer.deleteMany.mockRejectedValue(err);
    expect(await service.deleteAllCustomers().catch((e) => e)).toBe(err);
  });

  it("a P2003 from any OTHER statement is not masked as a 409", async () => {
    const err = fkViolation();
    prisma.customerPrice.deleteMany.mockRejectedValue(err); // runs unconditionally
    expect(await service.deleteAllCustomers().catch((e) => e)).toBe(err);
  });
});
