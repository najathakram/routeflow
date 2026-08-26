import { Test, TestingModule } from "@nestjs/testing";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { ConfigService } from "@nestjs/config";

// Mock invoice.service.ts to avoid loading @react-pdf/renderer (ESM-only)
jest.mock("./invoice.service", () => ({
  InvoiceService: jest.fn().mockImplementation(() => ({
    generateInvoice: jest.fn(),
    getPresignedUrl: jest.fn(),
  })),
}));

// Mock VendorBillsService to prevent deep dependency chain — bulkMarkPaid
// writes the BillPayment ledger directly via PrismaService, it never calls
// into VendorBillsService.
jest.mock("../vendor-bills/vendor-bills.service", () => ({
  VendorBillsService: jest.fn().mockImplementation(() => ({})),
}));

import { BookkeepingService } from "./bookkeeping.service";
import { InvoiceService } from "./invoice.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { StorageService } from "../storage/storage.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("BookkeepingService.bulkMarkPaid", () => {
  let service: BookkeepingService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        BookkeepingService,
        { provide: PrismaService, useValue: prisma },
        { provide: InvoiceService, useValue: { getPresignedUrl: jest.fn() } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("https://example.com/file"),
            getSignedUrl: jest.fn().mockResolvedValue("https://example.com/signed"),
            delete: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: VendorBillsService,
          useValue: { createFromExpense: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue(null),
            set: jest.fn().mockResolvedValue(undefined),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();

    service = module.get<BookkeepingService>(BookkeepingService);
  });

  const bill = (over: Partial<Record<string, unknown>> = {}) => ({
    id: "bill-1",
    billNumber: "BILL-2026-0001",
    status: "RECEIVED",
    totalOwed: 100,
    payments: [] as { amount: number }[],
    ...over,
  });

  /** How the service resolves ids to bills: identity only, no money fields. */
  const stubList = (rows: ReturnType<typeof bill>[]) =>
    prisma.vendorBill.findMany.mockResolvedValue(
      rows.map((b) => ({ id: b.id, billNumber: b.billNumber })),
    );

  /**
   * The money side is re-read inside the transaction and totalled off the
   * BillPayment ledger, so the fixture carries `payments`, not `totalPaid`.
   */
  const stubLedger = (rows: ReturnType<typeof bill>[]) =>
    prisma.vendorBill.findUnique.mockImplementation(
      async ({ where }: any) => rows.find((b) => b.id === where.id) ?? null,
    );

  it("partitions mixed eligible/ineligible bill ids, never throwing per item", async () => {
    const eligible = bill({
      id: "bill-eligible",
      billNumber: "BILL-A",
      totalOwed: 100,
      payments: [{ amount: 20 }],
    });
    const ineligible = bill({
      id: "bill-ineligible",
      billNumber: "BILL-B",
      totalOwed: 50,
      payments: [{ amount: 50 }], // fully paid already — no outstanding balance
    });
    stubList([eligible, ineligible]);
    stubLedger([eligible, ineligible]);

    const result = await service.bulkMarkPaid({
      ids: [eligible.id, ineligible.id],
      method: "CASH" as any,
    } as any);

    expect(result.paid).toBe(1);
    expect(result.skipped).toEqual([
      { id: "bill-ineligible", billNumber: "BILL-B", reason: "No outstanding balance" },
    ]);
    // The eligible bill was paid its full remaining balance (100 - 20 = 80),
    // through the same ledger recordPayment writes.
    expect(prisma.billPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        vendorBillId: "bill-eligible",
        amount: 80,
        method: "CASH",
      }),
    });
    expect(prisma.vendorBill.update).toHaveBeenCalledWith({
      where: { id: "bill-eligible" },
      data: { totalPaid: 100, status: "PAID" },
    });
  });

  it("sums the remaining balances actually paid into totalAmount", async () => {
    const a = bill({ id: "bill-a", billNumber: "BILL-A", totalOwed: 100 });
    const b = bill({
      id: "bill-b",
      billNumber: "BILL-B",
      totalOwed: 40,
      payments: [{ amount: 10 }],
    });
    stubList([a, b]);
    stubLedger([a, b]);

    const result = await service.bulkMarkPaid({
      ids: [a.id, b.id],
      method: "ACH" as any,
    } as any);

    expect(result.paid).toBe(2);
    expect(result.totalAmount).toBe(130); // 100 + 30
    expect(result.skipped).toEqual([]);
  });

  it("skips a VOID bill without paying it", async () => {
    const voided = bill({
      id: "bill-void",
      billNumber: "BILL-V",
      status: "VOID",
      totalOwed: 100,
    });
    stubList([voided]);
    stubLedger([voided]);

    const result = await service.bulkMarkPaid({ ids: [voided.id], method: "CASH" as any } as any);

    expect(result.paid).toBe(0);
    expect(result.skipped).toEqual([
      { id: "bill-void", billNumber: "BILL-V", reason: "Bill is void" },
    ]);
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("eligibility is arithmetic: a short-received PARTIAL bill is fully payable", async () => {
    // PARTIAL here means SHORT-RECEIVED, not part-paid (landmine: VendorBillStatus.PARTIAL
    // is overloaded). An empty payment ledger must still make it fully eligible.
    const shortReceived = bill({
      id: "bill-short",
      billNumber: "BILL-S",
      status: "PARTIAL",
      totalOwed: 250,
    });
    stubList([shortReceived]);
    stubLedger([shortReceived]);

    const result = await service.bulkMarkPaid({
      ids: [shortReceived.id],
      method: "CHECK" as any,
    } as any);

    expect(result.paid).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(prisma.billPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ vendorBillId: "bill-short", amount: 250 }),
    });
    expect(prisma.vendorBill.update).toHaveBeenCalledWith({
      where: { id: "bill-short" },
      data: { totalPaid: 250, status: "PAID" },
    });
  });

  it("a linked expense's bill gets a payment and reaches PAID", async () => {
    const linkedBill = bill({ id: "bill-linked", billNumber: "BILL-L", totalOwed: 200 });
    // The id passed in resolves to nothing in VendorBill...
    prisma.vendorBill.findMany.mockResolvedValue([]);
    // ...but to an Expense whose vendorBillId points at the bill above
    // (Expense.vendorBillId has no Prisma relation — manual lookup only).
    prisma.expense.findMany.mockResolvedValue([
      { id: "expense-1", status: "PENDING", vendorBillId: "bill-linked" },
    ]);
    stubLedger([linkedBill]);
    // The expense.vendorBillId -> VendorBill identity lookup (id + billNumber only).
    prisma.vendorBill.findFirst.mockResolvedValue({
      id: linkedBill.id,
      billNumber: linkedBill.billNumber,
    });
    // updateExpense's own lookup of the expense row
    prisma.expense.findFirst.mockResolvedValue({
      id: "expense-1",
      status: "PENDING",
      receivedAt: null,
      paidAt: null,
      vendorBillId: "bill-linked",
    });

    const result = await service.bulkMarkPaid({ ids: ["expense-1"], method: "CASH" as any } as any);

    expect(result.paid).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.totalAmount).toBe(200);
    // The BILL got the payment...
    expect(prisma.billPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ vendorBillId: "bill-linked", amount: 200 }),
    });
    expect(prisma.vendorBill.update).toHaveBeenCalledWith({
      where: { id: "bill-linked" },
      data: { totalPaid: 200, status: "PAID" },
    });
    // ...and the expense's own status still gets stamped (buildStatusPatch unchanged).
    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expense-1" },
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
  });

  it("never pays a bill twice when one request reaches it as both an expense and a bill", async () => {
    // The classic double-pay: ids carry an expense AND the bill it links to.
    // Iteration 1 settles the bill; iteration 2 must see the ledger it just
    // wrote, not a pre-loop snapshot that still says totalPaid = 0.
    const written: { vendorBillId: string; amount: number }[] = [];
    prisma.billPayment.create.mockImplementation(async ({ data }: any) => {
      written.push({ vendorBillId: data.vendorBillId, amount: data.amount });
      return data;
    });
    prisma.vendorBill.findMany.mockResolvedValue([{ id: "bill-linked", billNumber: "BILL-L" }]);
    prisma.expense.findMany.mockResolvedValue([
      { id: "expense-1", status: "PENDING", vendorBillId: "bill-linked" },
    ]);
    prisma.vendorBill.findUnique.mockImplementation(async ({ where }: any) =>
      where.id === "bill-linked"
        ? bill({
            id: "bill-linked",
            billNumber: "BILL-L",
            totalOwed: 200,
            payments: written.filter((p) => p.vendorBillId === "bill-linked"),
          })
        : null,
    );
    // The expense.vendorBillId -> VendorBill identity lookup (id + billNumber only).
    prisma.vendorBill.findFirst.mockResolvedValue({ id: "bill-linked", billNumber: "BILL-L" });
    prisma.expense.findFirst.mockResolvedValue({
      id: "expense-1",
      status: "PENDING",
      receivedAt: null,
      paidAt: null,
      vendorBillId: "bill-linked",
    });

    const result = await service.bulkMarkPaid({
      ids: ["expense-1", "bill-linked"],
      method: "CASH" as any,
    } as any);

    expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
    expect(result.paid).toBe(1);
    expect(result.totalAmount).toBe(200);
    expect(result.skipped).toEqual([
      { id: "bill-linked", billNumber: "BILL-L", reason: "No outstanding balance" },
    ]);
  });

  it("an unlinked expense behaves as before: status flips, no BillPayment is created", async () => {
    prisma.vendorBill.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([
      { id: "expense-2", status: "PENDING", vendorBillId: null },
    ]);
    prisma.expense.findFirst.mockResolvedValue({
      id: "expense-2",
      status: "PENDING",
      receivedAt: null,
      paidAt: null,
      vendorBillId: null,
    });

    const result = await service.bulkMarkPaid({ ids: ["expense-2"], method: "CASH" as any } as any);

    expect(result.paid).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(result.totalAmount).toBe(0);
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.expense.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "expense-2" },
        data: expect.objectContaining({ status: "PAID" }),
      }),
    );
  });

  it("reports an id that resolves to neither a bill nor an expense as skipped", async () => {
    prisma.vendorBill.findMany.mockResolvedValue([]);
    prisma.expense.findMany.mockResolvedValue([]);

    const result = await service.bulkMarkPaid({
      ids: ["nonexistent"],
      method: "CASH" as any,
    } as any);

    expect(result.paid).toBe(0);
    expect(result.skipped).toEqual([{ id: "nonexistent", billNumber: "", reason: "Not found" }]);
  });
});
