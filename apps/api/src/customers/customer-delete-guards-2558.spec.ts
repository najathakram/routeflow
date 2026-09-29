/**
 * #2558 / SA-510a: the in-transaction guards behind a customer delete (customer-delete-preflight.ts).
 * The pre-flight runs OUTSIDE the transaction, so an invoice sent, paid or marked OVERDUE between it
 * and the delete used to be destroyed. Now:
 *   (1) every path re-checks INSIDE the tx and refuses (409, rollback) before any delete;
 *   (2) deleteAllCustomers' invoice delete is a compare-and-set (non-blocking statuses only, and
 *       exactly the rows it read);
 *   (3) deleteCustomer's record-free hard-delete branch refuses if ANY invoice or payment exists.
 * Bootstrap copied from customers.service.delete-all.spec.ts (whose tenantTransaction mock runs the
 * callback against the same mock client).
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
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
import {
  assertNoBlockingInvoices,
  assertRecordFreeInTx,
  deleteNonBlockingInvoicesCas,
  readInvoicesAssertingNoneBlocking,
} from "./customer-delete-preflight";

describe("CustomersService — in-tx delete guards (#2558, SA-510a)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const SEEDED_CUSTOMERS = [
    { id: "cust-1", userId: "user-1" },
    { id: "cust-2", userId: "user-2" },
  ];

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockResolvedValue(SEEDED_CUSTOMERS as any);

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
        entitlementAuthorityFromEntitlements, // #2241
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

  const noDestructiveWrites = () => {
    expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoiceItem.deleteMany).not.toHaveBeenCalled();
    expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
  };

  describe("deleteAllCustomers", () => {
    it("(1) an invoice that turned OVERDUE after the pre-flight is refused inside the tx; nothing is deleted", async () => {
      prisma.invoice.groupBy.mockResolvedValue([]); // the pre-flight saw nothing blocking
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-1", customerId: "cust-1", status: "DRAFT" },
        { id: "inv-2", customerId: "cust-2", status: "OVERDUE" },
      ]);
      const caught: any = await service.deleteAllCustomers().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toMatch(
        /issued, paid or written-off invoices.*cust-2: 1 invoice\(s\)/,
      );
      noDestructiveWrites();
    });

    it("(2) CAS miss: the invoice delete removed fewer rows than it read ⇒ 409 before the customers go", async () => {
      prisma.invoice.groupBy.mockResolvedValue([]);
      prisma.invoice.findMany.mockResolvedValue([
        { id: "inv-1", customerId: "cust-1", status: "DRAFT" },
        { id: "inv-2", customerId: "cust-2", status: "DRAFT" },
      ]);
      prisma.invoice.deleteMany.mockResolvedValue({ count: 1 });
      const caught: any = await service.deleteAllCustomers().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toMatch(/changed while they were being deleted/);
      expect(prisma.invoice.deleteMany.mock.calls[0][0].where).toEqual({
        customerId: { in: ["cust-1", "cust-2"] },
        status: { notIn: ["SENT", "VIEWED", "PARTIAL", "PAID", "OVERDUE", "VOID", "WRITTEN_OFF"] },
      });
      expect(prisma.customer.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("deleteCustomer / batchDelete: the record-free hard-delete branch", () => {
    const recordFree = () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: null,
        user: { status: "ACTIVE", username: "shop" },
      });
      prisma.order.count.mockResolvedValue(0);
      prisma.return.count.mockResolvedValue(0);
      prisma.advancePayment.aggregate.mockResolvedValue({ _sum: { balance: 0 } });
      prisma.creditNote.findMany.mockResolvedValue([]);
    };

    it.each([
      ["an invoice", 1, 0],
      ["an invoice payment", 0, 1],
    ])(
      "(3) %s created after the pre-flight ⇒ 409 inside the tx, nothing deleted",
      async (_l, inv, pay) => {
        recordFree();
        // the outside pre-flight counts 0 invoices; the in-tx recount sees the new row
        prisma.invoice.count.mockResolvedValueOnce(0).mockResolvedValue(inv);
        prisma.invoicePayment.count.mockResolvedValue(pay);
        const caught: any = await service.deleteCustomer("cust-1").catch((e) => e);
        expect(caught).toBeInstanceOf(ConflictException);
        expect(caught.message).toMatch(/gained invoices or payments while being deleted/);
        noDestructiveWrites();
        expect(prisma.customer.delete).not.toHaveBeenCalled();
      },
    );

    it("batchDelete reports the in-tx refusal for that customer and deletes nothing", async () => {
      recordFree();
      prisma.invoice.groupBy.mockResolvedValue([]);
      prisma.invoice.count.mockResolvedValueOnce(0).mockResolvedValue(1);
      prisma.invoicePayment.count.mockResolvedValue(0);
      const res = await service.batchDelete(["cust-1"]);
      expect(res.deleted).toBe(0);
      expect(res.failed[0]).toEqual(
        expect.objectContaining({ id: "cust-1", reason: expect.stringMatching(/gained invoices/) }),
      );
      noDestructiveWrites();
    });
  });

  describe("the helpers", () => {
    it("assertNoBlockingInvoices caps the breakdown only when asked", async () => {
      const rows = Array.from({ length: 12 }, (_, i) => ({
        customerId: `c${i}`,
        _count: { _all: 1 },
      }));
      const db = { invoice: { groupBy: jest.fn().mockResolvedValue(rows) } };
      const capped: any = await assertNoBlockingInvoices(db, ["x"], { capList: true }).catch(
        (e) => e,
      );
      expect(capped.message).toMatch(/c9: 1 invoice\(s\); and 2 more\.$/);
      const full: any = await assertNoBlockingInvoices(db, ["x"]).catch((e) => e);
      expect(full.message).toMatch(/c11: 1 invoice\(s\)\.$/);
    });

    it("readInvoicesAssertingNoneBlocking returns the ids when only DRAFTs remain (a VOID blocks, SA-530)", async () => {
      const tx = {
        invoice: {
          findMany: jest.fn().mockResolvedValue([
            { id: "a", customerId: "c", status: "DRAFT" },
            { id: "b", customerId: "c", status: "DRAFT" },
          ]),
        },
      };
      await expect(readInvoicesAssertingNoneBlocking(tx, ["c"])).resolves.toEqual([
        { id: "a" },
        { id: "b" },
      ]);
    });

    it("deleteNonBlockingInvoicesCas passes on an exact count and refuses otherwise", async () => {
      const tx = (count: number) => ({
        invoice: { deleteMany: jest.fn().mockResolvedValue({ count }) },
      });
      await expect(deleteNonBlockingInvoicesCas(tx(2), ["c"], 2)).resolves.toBeUndefined();
      await expect(deleteNonBlockingInvoicesCas(tx(3), ["c"], 2)).rejects.toThrow(
        ConflictException,
      );
    });

    it("assertRecordFreeInTx passes only with no invoice and no payment", async () => {
      const tx = (i: number, p: number) => ({
        invoice: { count: jest.fn().mockResolvedValue(i) },
        invoicePayment: { count: jest.fn().mockResolvedValue(p) },
      });
      await expect(assertRecordFreeInTx(tx(0, 0), "c")).resolves.toBeUndefined();
      await expect(assertRecordFreeInTx(tx(1, 0), "c")).rejects.toThrow(ConflictException);
      await expect(assertRecordFreeInTx(tx(0, 1), "c")).rejects.toThrow(ConflictException);
    });
  });
});
