/**
 * #2587 / SA-516 (tier 1): a customer delete never destroys a money record. Credit notes of ANY
 * status, transaction payments, advance payments and invoice payments:
 *   - bulk paths (`deleteAllCustomers`, `deleteImportedCustomers`): the pre-flight refuses with a
 *     409 naming the customer, the in-tx re-check repeats it, and those tables are only ever
 *     "deleted" as a compare-and-set expecting ZERO rows (a row that slipped past ⇒ 409, rollback);
 *   - single path (`deleteCustomer`, SA-516a): any money record ⇒ 409 without force, the existing
 *     soft delete with force (records preserved), and the hard branch re-checks the set in its tx.
 * Supersedes the REG-B189 pins that asserted the credit notes (and their order links) were deleted.
 * "Cleanup imported" (SA-516 (1)) is fail-closed by construction: non-ACTIVE-linked AND
 * money-record-free only. Red-first. Bootstrap copied from imported-customers-guard-2569.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
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

type Kind = "creditNote" | "advancePayment" | "payment" | "invoicePayment";
const KINDS: Kind[] = ["creditNote", "advancePayment", "payment", "invoicePayment"];

/** A money-record row owned by `customerId`, in the shape each count query selects. */
function row(kind: Kind, customerId: string): Record<string, unknown> {
  if (kind === "payment") return { transaction: { customerId } };
  if (kind === "invoicePayment") return { invoice: { customerId } };
  // creditNote rows also feed deleteCustomer's open-credit read: a fully used note (not "open").
  return { customerId, amount: 10, amountUsed: 10 };
}

const MONEY_TABLES: Kind[] = KINDS;

describe("customer deletes never destroy a money record (#2587, SA-516)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
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

  const noMoneyDeleted = () => {
    for (const t of MONEY_TABLES) expect((prisma as any)[t].deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
  };

  const BULK: Array<[string, () => Promise<unknown>, string]> = [
    ["deleteAllCustomers", () => service.deleteAllCustomers(), "cust-1"],
    ["deleteImportedCustomers", () => service.deleteImportedCustomers(), "cust-1"],
  ];

  const seedBulk = () =>
    prisma.customer.findMany.mockResolvedValue([
      { id: "cust-1", userId: "user-1", customerLink: null },
      { id: "cust-2", userId: "user-2", customerLink: { status: "ACTIVE" } },
    ] as any);

  describe.each(BULK)("%s", (_name, run, blocked) => {
    it.each(KINDS)(
      "a %s ⇒ the pre-flight refuses naming the customer, nothing deleted",
      async (kind) => {
        seedBulk();
        ((prisma as any)[kind].findMany as jest.Mock).mockResolvedValue([row(kind, blocked)]);
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(caught.message).toContain(`${blocked}: 1 record(s)`);
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
        noMoneyDeleted();
      },
    );

    it.each(KINDS)(
      "a %s appearing after the pre-flight ⇒ the in-tx re-check refuses before any delete",
      async (kind) => {
        seedBulk();
        ((prisma as any)[kind].findMany as jest.Mock)
          .mockResolvedValueOnce([])
          .mockResolvedValue([row(kind, blocked)]);
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        noMoneyDeleted();
        expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
      },
    );

    it.each(["creditNote", "advancePayment"] as Kind[])(
      "a %s slipping past the re-check ⇒ the zero-row CAS refuses (409, rollback)",
      async (kind) => {
        seedBulk();
        ((prisma as any)[kind].deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
      },
    );

    it("money-record-free ⇒ proceeds; the credit-note table is touched only by the zero-row CAS", async () => {
      seedBulk();
      await run();
      expect(prisma.creditNote.deleteMany).toHaveBeenCalledWith({
        where: { customerId: { in: expect.arrayContaining([blocked]) } },
      });
      expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
      expect(prisma.customer.deleteMany).toHaveBeenCalled();
    });
  });

  it("cleanup imported checks only the non-ACTIVE-linked customers it would delete", async () => {
    seedBulk();
    await service.deleteImportedCustomers();
    expect((prisma.creditNote.findMany as jest.Mock).mock.calls[0][0].where).toEqual({
      customerId: { in: ["cust-1"] },
    });
  });

  describe("deleteCustomer (single, SA-516a)", () => {
    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: null,
        user: { status: "ACTIVE", username: "shop" },
      } as any);
    });

    it.each(KINDS)("a %s without force ⇒ 409, nothing deleted or soft-deleted", async (kind) => {
      ((prisma as any)[kind].findMany as jest.Mock).mockResolvedValue([row(kind, "cust-1")]);
      const caught: any = await service.deleteCustomer("cust-1").catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("Cannot delete customer with existing financial records");
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      noMoneyDeleted();
    });

    // The batchDelete shape (force + hardDeleteWhenRecordFree): pre-fix these customers counted as
    // record-free and were hard-deleted with their money records.
    it.each(KINDS)(
      "a %s with force (batch shape) ⇒ the soft delete, records preserved",
      async (kind) => {
        ((prisma as any)[kind].findMany as jest.Mock).mockResolvedValue([row(kind, "cust-1")]);
        await expect(
          service.deleteCustomer("cust-1", true, { hardDeleteWhenRecordFree: true }),
        ).resolves.toEqual({
          success: true,
          softDeleted: true,
        });
        expect(prisma.customer.update).toHaveBeenCalled();
        expect(prisma.customer.delete).not.toHaveBeenCalled();
        noMoneyDeleted();
      },
    );

    it.each(KINDS)(
      "a %s appearing before the hard branch's tx ⇒ its in-tx twin refuses",
      async (kind) => {
        const m = ((prisma as any)[kind].findMany as jest.Mock).mockResolvedValue([
          row(kind, "cust-1"),
        ]);
        // the pre-flight reads credit notes twice (the open-credit read + the money-record count)
        for (let i = 0; i < (kind === "creditNote" ? 2 : 1); i++) m.mockResolvedValueOnce([]);
        const caught: any = await service
          .deleteCustomer("cust-1", true, { hardDeleteWhenRecordFree: true })
          .catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.customer.delete).not.toHaveBeenCalled();
        noMoneyDeleted();
      },
    );
  });
});
