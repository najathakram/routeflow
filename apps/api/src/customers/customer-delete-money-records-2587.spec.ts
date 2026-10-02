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
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";

type Kind = "creditNote" | "advancePayment" | "payment" | "invoicePayment";
const KINDS: Kind[] = ["creditNote", "advancePayment", "payment", "invoicePayment"];

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

  /**
   * One money record of `kind` owned by `customerId`, in the shape the aggregated counts read
   * (#2597): a groupBy per customer for credit notes / advances, a groupBy per parent plus the
   * parent's owner for payments. The first `skip` count reads see nothing (a record that appears
   * after the pre-flight).
   */
  const seedMoney = (kind: Kind, customerId: string, skip = 0) => {
    let calls = 0;
    const hit = () => calls++ >= skip;
    const m = prisma as any;
    if (kind === "creditNote" || kind === "advancePayment") {
      m[kind].groupBy.mockImplementation(async () =>
        hit() ? [{ customerId, _count: { _all: 1 } }] : [],
      );
      return;
    }
    const [fk, parent] =
      kind === "payment" ? ["transactionId", "transaction"] : ["invoiceId", "invoice"];
    m[kind].groupBy.mockImplementation(async () =>
      hit() ? [{ [fk]: "parent-1", _count: { _all: 1 } }] : [],
    );
    m[parent].findMany.mockImplementation(async (args: any) =>
      args?.where?.id?.in?.includes("parent-1") ? [{ id: "parent-1", customerId }] : [],
    );
  };

  const noMoneyDeleted = () => {
    for (const t of MONEY_TABLES) expect((prisma as any)[t].deleteMany).not.toHaveBeenCalled();
    expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
  };

  const BULK: Array<[string, () => Promise<unknown>, string]> = [
    ["deleteAllCustomers", () => service.deleteAllCustomers(), "cust-1"],
    ["deleteImportedCustomers", () => service.runImportedCustomersCleanup(), "cust-1"],
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
        seedMoney(kind, blocked);
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
        seedMoney(kind, blocked, 1);
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
    await service.runImportedCustomersCleanup();
    expect((prisma.creditNote.groupBy as jest.Mock).mock.calls[0][0].where).toEqual({
      customerId: { in: ["cust-1"] },
    });
  });

  // REG-B189 inverse (SA-516c(1)): the three REG-B189 describes pinned that each purge site
  // cleared the order↔credit-note links before DELETING the customer's credit notes. SA-516 forbids
  // deleting them, so each site now refuses: a 409 naming the customer, the note and its links kept.
  describe("REG-B189 inverse — a credit note blocks the delete and is kept (SA-516c)", () => {
    const kept = () => {
      expect(prisma.creditNote.deleteMany).not.toHaveBeenCalled();
      expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
    };

    it("REG-B189 deleteAllCustomers: 409 naming the customer, credit note and links kept", async () => {
      seedBulk();
      seedMoney("creditNote", "cust-1");
      const caught: any = await service.deleteAllCustomers().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("cust-1: 1 record(s)");
      kept();
    });

    it("REG-B189 deleteImportedCustomers: 409 naming the customer, credit note and links kept", async () => {
      seedBulk();
      seedMoney("creditNote", "cust-1");
      const caught: any = await service.runImportedCustomersCleanup().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("cust-1: 1 record(s)");
      kept();
    });

    it("REG-B189 deleteCustomer (hard delete): 409, credit note and links kept", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: null,
        user: { status: "ACTIVE", username: "shop" },
      } as any);
      seedMoney("creditNote", "cust-1");
      const caught: any = await service.deleteCustomer("cust-1").catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("credit notes, payments or advance payments");
      kept();
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
      seedMoney(kind, "cust-1");
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
        seedMoney(kind, "cust-1");
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
        seedMoney(kind, "cust-1", 1);
        const caught: any = await service
          .deleteCustomer("cust-1", true, { hardDeleteWhenRecordFree: true })
          .catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.customer.delete).not.toHaveBeenCalled();
        noMoneyDeleted();
      },
    );
  });

  // #2591 / SA-516b: delivery history (ANY RouteRunStop, the customer's own or one on its
  // RouteStop) is refused, never deleted. Pre-fix, cleanup-imported hit an FK 500 on the RouteStop.
  describe("delivery history (#2591, SA-516b)", () => {
    const HISTORY: Array<[string, "own" | "stop"]> = [
      ["its own RouteRunStop", "own"],
      ["a RouteRunStop on its RouteStop", "stop"],
    ];
    /** Delivery history for `cust-1`, seen by every count read after the first `skip` (#2597 shapes). */
    const seedHistory = (via: "own" | "stop", skip = 0) => {
      let calls = 0;
      const hit = () => calls++ >= skip;
      const rows = async () => (hit() ? [{ customerId: "cust-1" }] : []);
      if (via === "own") (prisma.routeRunStop.groupBy as jest.Mock).mockImplementation(rows);
      else (prisma.routeStop.findMany as jest.Mock).mockImplementation(rows);
    };

    describe.each(BULK)("%s", (_name, run) => {
      it.each(HISTORY)("%s ⇒ the pre-flight refuses naming the customer", async (_k, via) => {
        seedBulk();
        seedHistory(via);
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(caught.message).toContain("delivery history");
        expect(caught.message).toContain("cust-1");
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
        expect(prisma.routeRunStop.deleteMany).not.toHaveBeenCalled();
        expect(prisma.routeStop.deleteMany).not.toHaveBeenCalled();
      });

      it("history appearing after the pre-flight ⇒ the in-tx twin refuses before any delete", async () => {
        seedBulk();
        seedHistory("stop", 1);
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        expect(prisma.routeRunStop.deleteMany).not.toHaveBeenCalled();
        expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
      });

      it("a RouteRunStop slipping past the re-check ⇒ the zero-row CAS refuses", async () => {
        seedBulk();
        prisma.routeRunStop.deleteMany.mockResolvedValue({ count: 1 } as any);
        const caught: any = await run().catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(prisma.routeStop.deleteMany).not.toHaveBeenCalled();
        expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
      });

      it("history-free control ⇒ the route template rows (RouteStop/RouteCustomer) are still deleted", async () => {
        seedBulk();
        await run();
        expect(prisma.routeRunStop.deleteMany).toHaveBeenCalledWith({
          where: {
            OR: [
              { customerId: { in: expect.arrayContaining(["cust-1"]) } },
              { routeStop: { customerId: { in: expect.arrayContaining(["cust-1"]) } } },
            ],
          },
        });
        expect(prisma.routeStop.deleteMany).toHaveBeenCalled();
        expect(prisma.routeCustomer.deleteMany).toHaveBeenCalled();
        expect(prisma.customer.deleteMany).toHaveBeenCalled();
      });
    });

    it("single path: history without force ⇒ 409; with force (batch shape) ⇒ the soft delete", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: null,
        user: { status: "ACTIVE", username: "shop" },
      } as any);
      seedHistory("stop");
      const caught: any = await service.deleteCustomer("cust-1").catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("delivery history");
      await expect(
        service.deleteCustomer("cust-1", true, { hardDeleteWhenRecordFree: true }),
      ).resolves.toEqual({ success: true, softDeleted: true });
      expect(prisma.routeRunStop.deleteMany).not.toHaveBeenCalled();
      expect(prisma.customer.delete).not.toHaveBeenCalled();
    });
  });
});
