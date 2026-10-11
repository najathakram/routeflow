/**
 * A customer's login account loses its outstanding set-password / reset links in the SAME
 * transaction as every write that changes the account's standing: a non-ACTIVE status change,
 * the soft-delete tombstone, and the restore (which rewrites status and email).
 * Reactivation burns nothing. Bootstrap copied from customer-delete-guards-2558.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("CustomersService — link revocation on account standing changes", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let tx: any;
  let events: string[];

  /** The userIds whose PasswordResetToken rows the tx was asked to burn. */
  const burnedFor = () =>
    tx.$executeRaw.mock.calls
      .filter(([strings]: any[]) => strings.join("").includes('UPDATE "PasswordResetToken"'))
      .map((c: any[]) => c[1] as string);

  beforeEach(async () => {
    prisma = createMockPrisma();
    events = [];
    // The tx client is the mock client plus a recording raw executor; every user write that
    // reaches the plain (non-tx) client rejects, so a write that escaped the tx fails the test.
    tx = {
      ...prisma,
      user: {
        ...prisma.user,
        update: jest.fn(() => {
          events.push("user.update");
          return Promise.resolve({ id: "user-1" });
        }),
      },
      customer: { ...prisma.customer, update: jest.fn().mockResolvedValue({}) },
      $executeRaw: jest.fn(() => {
        events.push("revoke");
        return Promise.resolve(1);
      }),
    };
    prisma.user.update.mockRejectedValue(new Error("user write outside the transaction"));
    prisma.tenantTransaction.mockImplementation((fn: any) => fn(tx));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
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
        entitlementAuthorityFromEntitlements,
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

  const customerRow = (over: Record<string, unknown> = {}) => ({
    id: "cust-1",
    userId: "user-1",
    deletedAt: null,
    isWalkIn: false,
    email: "acme@shop.example",
    user: { status: "ACTIVE", username: "acme" },
    ...over,
  });

  describe("changeStatus", () => {
    it.each(["SUSPENDED", "INACTIVE"])(
      "to %s: writes the status and burns the links in the same transaction",
      async (status) => {
        prisma.customer.findUnique.mockResolvedValue(customerRow() as any);

        await service.changeStatus("cust-1", { status } as any);

        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        expect(tx.user.update).toHaveBeenCalledWith(
          expect.objectContaining({ where: { id: "user-1" }, data: { status } }),
        );
        expect(burnedFor()).toEqual(["user-1"]);
      },
    );

    it("INACTIVE -> INACTIVE still burns the links", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({ user: { status: "INACTIVE", username: "acme" } }) as any,
      );

      await service.changeStatus("cust-1", { status: "INACTIVE" } as any);

      expect(burnedFor()).toEqual(["user-1"]);
    });

    it("reactivation burns nothing", async () => {
      prisma.customer.findUnique.mockResolvedValue(customerRow() as any);

      await service.changeStatus("cust-1", { status: "ACTIVE" } as any);

      expect(tx.user.update).toHaveBeenCalledTimes(1);
      expect(burnedFor()).toEqual([]);
    });

    it("a failed burn fails the change", async () => {
      prisma.customer.findUnique.mockResolvedValue(customerRow() as any);
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await expect(service.changeStatus("cust-1", { status: "SUSPENDED" } as any)).rejects.toThrow(
        "db down",
      );
    });
  });

  describe("deleteCustomer (soft-delete tombstone)", () => {
    const seedSoftDelete = () => {
      prisma.customer.findUnique.mockResolvedValue(customerRow() as any);
      prisma.order.count.mockResolvedValue(0);
      prisma.return.count.mockResolvedValue(0);
      prisma.advancePayment.aggregate.mockResolvedValue({ _sum: { balance: 0 } });
      prisma.creditNote.findMany.mockResolvedValue([]);
    };

    it("burns the links in the same transaction as the deletedAt / identity tombstone", async () => {
      seedSoftDelete();

      await expect(service.deleteCustomer("cust-1", true)).resolves.toEqual({
        success: true,
        softDeleted: true,
      });

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
      expect(burnedFor()).toEqual(["user-1"]);
    });

    it("a failed burn fails the delete (the tombstone rolls back with it)", async () => {
      seedSoftDelete();
      tx.$executeRaw.mockRejectedValue(new Error("db down"));

      await expect(service.deleteCustomer("cust-1", true)).rejects.toThrow("db down");
    });
  });

  describe("restoreCustomer (rewrites status and email)", () => {
    it("burns the links in the same transaction as the restoring write", async () => {
      prisma.customer.findUnique.mockResolvedValue(
        customerRow({
          deletedAt: new Date(),
          user: { status: "SUSPENDED", username: "acme~removed~cust-1" },
        }) as any,
      );

      await service.restoreCustomer("cust-1");

      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      expect(tx.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: expect.objectContaining({ status: "SUSPENDED", deletedAt: null }),
        }),
      );
      expect(burnedFor()).toEqual(["user-1"]);
    });
  });
});
