/**
 * B288 (SA-814 R5-3): void, revert-to-draft, delete and bulk-delete used to keep or destroy a bill's
 * CASH payments. Now each is a 409 BILL_HAS_PAYMENTS (with the structured `amount`) decided as the
 * FIRST statement under the bill row lock, before any stock, credit, payment or bill write; the exit
 * is move-to-credit (one SupplierCredit equal to the payment, dated at the payment, in one tx).
 *
 * Mock-Prisma spec: "unchanged" is asserted as "no write call of any kind". The refusal is read
 * under a real row lock only in Postgres, which `local:test:db` covers for the sibling bill locks.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { VendorBillsService } from "./vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { ProductAliasService } from "../import/product-alias.service";
import { StorageService } from "../storage/storage.service";
import { InventoryService } from "../inventory/inventory.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { billCashPaid, billCashPaidRefusal, isCashBillPayment } from "./bill-cash-guard";

jest.mock("@anthropic-ai/sdk", () => ({ __esModule: true, default: jest.fn(() => ({})) }));
jest.mock("sharp", () => ({ __esModule: true, default: jest.fn(() => ({})) }));

const D = (n: number | string) => new Prisma.Decimal(n);

const PAID_ON = new Date("2026-05-10T00:00:00.000Z");

/** $200 of CASH (a check) on a $500 bill. */
const cashPayment = (overrides: Record<string, unknown> = {}) => ({
  id: "pay-cash",
  vendorBillId: "bill-1",
  amount: D(200),
  method: "CHECK",
  reference: "CHK-1041",
  notes: null,
  paidAt: PAID_ON,
  createdAt: new Date("2026-05-11T09:00:00.000Z"),
  paymentGroupId: null,
  supplierCreditId: null,
  ...overrides,
});

/** A draw of on-account supplier credit: a CREDIT_NOTE row carrying `supplierCreditId`. */
const creditDraw = (overrides: Record<string, unknown> = {}) => ({
  id: "pay-draw",
  vendorBillId: "bill-1",
  amount: D(300),
  method: "CREDIT_NOTE",
  reference: "SUPPLIER_CREDIT-credit-1",
  notes: null,
  paidAt: PAID_ON,
  createdAt: PAID_ON,
  paymentGroupId: null,
  supplierCreditId: "credit-1",
  ...overrides,
});

const partPaidBill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "PARTIAL",
  billDate: new Date("2026-05-01"),
  receivedDate: new Date("2026-05-02"),
  purchaseOrderId: null,
  totalOwed: D(500),
  totalPaid: D(200),
  items: [
    {
      id: "item-1",
      productId: "prod-1",
      description: "Flour 25lb",
      qty: D(5),
      unitCost: D(3.5),
      qtyReceived: D(5),
      product: { id: "prod-1", name: "Flour 25lb", currentStock: D(10), averageCost: D(2) },
    },
  ],
  payments: [cashPayment()],
  ...overrides,
});

describe("B288 — a bill with cash payments", () => {
  let service: VendorBillsService;
  let prisma: ReturnType<typeof createMockPrisma>;

  /** Every call that would write money, stock or the bill. */
  const writes = () => [
    prisma.billPayment.create,
    prisma.billPayment.deleteMany,
    prisma.billPayment.update,
    (prisma.supplierCredit as any).create,
    (prisma.supplierCredit as any).update,
    prisma.vendorBill.update,
    prisma.vendorBill.delete,
    prisma.vendorBill.deleteMany,
    prisma.stockMovement.create,
    prisma.product.update,
    prisma.stockLot.update,
    prisma.stockLot.delete,
    prisma.stockLot.deleteMany,
  ];
  const expectNothingWritten = () => {
    for (const fn of writes()) expect(fn).not.toHaveBeenCalled();
  };

  /** The payments the cash read sees (the same rows the move-to-credit read includes on the bill). */
  const seed = (bill: ReturnType<typeof partPaidBill>) => {
    prisma.vendorBill.findUnique.mockResolvedValue(bill as any);
    prisma.billPayment.findMany.mockResolvedValue(bill.payments as any);
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // The bill read is repeated inside the tx (B285 row lock + state fingerprint).
    prisma.vendorBill.findUnique.mockImplementation(
      () =>
        prisma.vendorBill.findUnique.mock.results.filter((r) => r.type === "return").at(-1)?.value,
    );
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey: jest.fn().mockResolvedValue(null),
            recordAiUsage: jest.fn(),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: DuplicateMatchService, useValue: {} },
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: InventoryService,
          useValue: { recomputeProductInTx: jest.fn(), lockProducts: jest.fn() },
        },
        ProductAliasService,
      ],
    }).compile();
    service = module.get(VendorBillsService);
  });

  // ─── the pure guard ─────────────────────────────────────────────────────────

  describe("billCashPaidRefusal", () => {
    it("refuses cash, with the structured amount and the SA-814 copy", () => {
      expect(billCashPaidRefusal([cashPayment()])).toEqual({
        code: API_ERROR_CODES.BILL_HAS_PAYMENTS,
        message: "This bill has $200.00 in payments. Move them to a supplier credit first.",
        amount: 200,
      });
    });

    it("sums every non-credit method, rounded to cents", () => {
      const payments = [
        cashPayment({ amount: D("10.10"), method: "CASH" }),
        cashPayment({ id: "p2", amount: D("20.20"), method: "ACH" }),
        cashPayment({ id: "p3", amount: D("0.01"), method: "ZELLE" }),
      ];
      expect(billCashPaid(payments)).toBe(30.31);
    });

    it("never counts a credit draw, or a CREDIT_NOTE row, as cash", () => {
      expect(billCashPaidRefusal([creditDraw()])).toBeNull();
      expect(billCashPaidRefusal([cashPayment({ method: "CREDIT_NOTE" })])).toBeNull();
      expect(isCashBillPayment(creditDraw())).toBe(false);
      expect(isCashBillPayment(cashPayment())).toBe(true);
    });

    it("lets a sub-cent residue through and refuses nothing for no payments", () => {
      expect(billCashPaidRefusal([cashPayment({ amount: D("0.0004") })])).toBeNull();
      expect(billCashPaidRefusal([])).toBeNull();
    });
  });

  // ─── void / revert / delete / bulk delete ───────────────────────────────────

  describe("part-paid bill ($200 cash on $500)", () => {
    const expect409 = async (run: () => Promise<unknown>) => {
      const err: any = await run().catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toEqual({
        code: API_ERROR_CODES.BILL_HAS_PAYMENTS,
        message: "This bill has $200.00 in payments. Move them to a supplier credit first.",
        amount: 200,
      });
    };

    it("voidBill is 409 and writes nothing (master voided it and kept the payments)", async () => {
      seed(partPaidBill());
      await expect409(() => service.voidBill("bill-1", "user-1"));
      expectNothingWritten();
    });

    it("voidBill refuses before it reads or reverses any stock", async () => {
      seed(partPaidBill());
      await service.voidBill("bill-1", "user-1").catch(() => undefined);
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
      expect(prisma.billPayment.findMany).toHaveBeenCalledTimes(1);
    });

    it("a never-received PAID bill with cash is refused too (the no-reversal branch)", async () => {
      seed(partPaidBill({ status: "PAID", receivedDate: null, totalPaid: D(200) }));
      await expect409(() => service.voidBill("bill-1", "user-1"));
      expectNothingWritten();
    });

    it("revertToDraft is 409 and writes nothing (master kept the payments on the draft)", async () => {
      seed(partPaidBill());
      await expect409(() => service.revertToDraft("bill-1", "user-1"));
      expectNothingWritten();
    });

    it("delete is 409, not the 400 status refusal, and writes nothing (master destroyed the payments)", async () => {
      seed(partPaidBill());
      await expect409(() => service.delete("bill-1"));
      expectNothingWritten();
    });

    it("delete of a cash-bearing DRAFT or VOID bill is 409 as well", async () => {
      for (const status of ["DRAFT", "VOID"]) {
        seed(partPaidBill({ status, receivedDate: null }));
        // eslint-disable-next-line no-await-in-loop
        await expect409(() => service.delete("bill-1"));
      }
      expectNothingWritten();
    });

    it("bulkDelete skips the cash-bearing bill (per-bill outcome) and deletes the rest", async () => {
      const clean = { id: "bill-2", status: "DRAFT", billNumber: "BILL-2026-0002" };
      prisma.vendorBill.findMany.mockResolvedValue([
        { id: "bill-1", status: "DRAFT", billNumber: "BILL-2026-0001" },
        clean,
      ] as any);
      prisma.billPayment.findMany.mockResolvedValue([
        cashPayment({ vendorBillId: "bill-1" }),
      ] as any);

      const result = await service.bulkDelete(["bill-1", "bill-2"]);

      expect(result.deleted).toBe(1);
      expect(result.skipped).toEqual([
        {
          id: "bill-1",
          billNumber: "BILL-2026-0001",
          reason: "This bill has $200.00 in payments. Move them to a supplier credit first.",
          code: API_ERROR_CODES.BILL_HAS_PAYMENTS,
          amount: 200,
        },
      ]);
      expect(prisma.vendorBill.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ["bill-2"] } },
      });
      expect(prisma.billPayment.deleteMany).toHaveBeenCalledWith({
        where: { vendorBillId: { in: ["bill-2"] } },
      });
    });

    it("bulkDelete of only cash-bearing bills deletes nothing", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([
        { id: "bill-1", status: "VOID", billNumber: "BILL-2026-0001" },
      ] as any);
      prisma.billPayment.findMany.mockResolvedValue([
        cashPayment({ vendorBillId: "bill-1" }),
      ] as any);

      const result = await service.bulkDelete(["bill-1"]);

      expect(result.deleted).toBe(0);
      expect(result.skipped).toHaveLength(1);
      expectNothingWritten();
    });
  });

  describe("control: a credit-only-drawn DRAFT still deletes and refunds the credit", () => {
    const drawnDraft = () =>
      partPaidBill({
        status: "DRAFT",
        receivedDate: null,
        totalPaid: D(300),
        payments: [creditDraw()],
        items: [],
      });

    it("delete refunds the credit and removes the bill", async () => {
      seed(drawnDraft());
      (prisma.supplierCredit as any).findUnique.mockResolvedValue({
        id: "credit-1",
        amount: D(300),
        balance: D(0),
      });

      await expect(service.delete("bill-1")).resolves.toEqual({ success: true });

      expect((prisma.supplierCredit as any).update).toHaveBeenCalledWith({
        where: { id: "credit-1" },
        data: { balance: { increment: 300 } }, // F35 (B291): refunds are relative under the credit lock
      });
      expect(prisma.vendorBill.delete).toHaveBeenCalledWith({ where: { id: "bill-1" } });
    });

    it("voidBill refunds the credit and voids", async () => {
      seed(drawnDraft());
      (prisma.supplierCredit as any).findUnique.mockResolvedValue({
        id: "credit-1",
        amount: D(300),
        balance: D(0),
      });

      await service.voidBill("bill-1", "user-1");

      expect((prisma.supplierCredit as any).update).toHaveBeenCalledTimes(1);
      expect(prisma.vendorBill.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "VOID" }) }),
      );
    });

    it("bulkDelete of the credit-drawn DRAFT deletes it", async () => {
      prisma.vendorBill.findMany.mockResolvedValue([
        { id: "bill-1", status: "DRAFT", billNumber: "BILL-2026-0001" },
      ] as any);
      prisma.billPayment.findMany.mockResolvedValue([creditDraw()] as any);
      (prisma.supplierCredit as any).findUnique.mockResolvedValue({
        id: "credit-1",
        amount: D(300),
        balance: D(0),
      });

      const result = await service.bulkDelete(["bill-1"]);

      expect(result).toEqual({ deleted: 1, skipped: [] });
    });
  });

  // ─── the exit: move a payment to a supplier credit ──────────────────────────

  describe("movePaymentToSupplierCredit", () => {
    const creditRow = { id: "credit-new", supplierId: "sup-1", amount: D(200), balance: D(200) };

    beforeEach(() => {
      (prisma.supplierCredit as any).create.mockResolvedValue(creditRow);
      prisma.billPayment.deleteMany.mockResolvedValue({ count: 1 });
      prisma.vendorBill.update.mockImplementation(async ({ data }: any) => ({
        id: "bill-1",
        ...data,
      }));
    });

    it("$200 payment -> one $200 credit dated at the payment, payment gone, bill unpaid again", async () => {
      seed(partPaidBill());

      const out = await service.movePaymentToSupplierCredit("bill-1", "pay-cash", "user-1");

      // One credit, equal to the payment, on the bill's supplier, dated at the ORIGINAL payment (SA-814n).
      expect((prisma.supplierCredit as any).create).toHaveBeenCalledTimes(1);
      const credit = (prisma.supplierCredit as any).create.mock.calls[0][0].data;
      expect(credit).toMatchObject({
        supplierId: "sup-1",
        amount: 200,
        balance: 200,
        method: "CHECK",
        reference: "CHK-1041",
      });
      expect(credit.receivedAt).toEqual(PAID_ON);
      expect(credit.notes).toContain("BILL-2026-0001");
      // The payment row is removed, scoped to this bill.
      expect(prisma.billPayment.deleteMany).toHaveBeenCalledWith({
        where: { id: "pay-cash", vendorBillId: "bill-1" },
      });
      // Back to unpaid; a fully received bill goes back to RECEIVED.
      expect(prisma.vendorBill.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "bill-1" },
          data: { totalPaid: 0, status: "RECEIVED" },
        }),
      );
      expect(out.supplierCredit).toBe(creditRow);
      // Audit row.
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: AUDIT_ACTIONS.VENDOR_BILL_PAYMENT_MOVED_TO_CREDIT,
          entityType: "VendorBill",
          entityId: "bill-1",
          userId: "user-1",
          meta: expect.objectContaining({
            paymentId: "pay-cash",
            supplierCreditId: "credit-new",
            amount: 200,
            statusBefore: "PARTIAL",
            statusAfter: "RECEIVED",
          }),
        }),
      });
    });

    it("then the void is no longer refused", async () => {
      seed(partPaidBill());
      await service.movePaymentToSupplierCredit("bill-1", "pay-cash", "user-1");

      // The bill as the move left it: no payments, unpaid.
      seed(partPaidBill({ status: "RECEIVED", totalPaid: D(0), payments: [] }));
      prisma.product.findFirst.mockResolvedValue({ currentStock: D(5), averageCost: D(3.5) });
      prisma.stockLot.findMany.mockResolvedValue([]);
      // receive() wrote one PURCHASE row; the void appends its reversal (as vendor-bills.service.spec does).
      prisma.stockMovement.findMany.mockImplementation(async ({ where }: any) =>
        where.notes && typeof where.notes === "object"
          ? []
          : [
              {
                id: "mv-1",
                quantity: D(5),
                unitCost: D(3.5),
                effectiveAt: new Date("2026-05-02"),
              },
            ],
      );

      await expect(service.voidBill("bill-1", "user-1")).resolves.toBeDefined();
      expect(prisma.vendorBill.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: "VOID" }) }),
      );
    });

    it("keeps the other payments: totalPaid is recomputed from the rest, never subtracted blind", async () => {
      seed(
        partPaidBill({
          totalPaid: D(500),
          status: "PAID",
          payments: [cashPayment(), cashPayment({ id: "pay-2", amount: D(300), method: "CASH" })],
        }),
      );

      await service.movePaymentToSupplierCredit("bill-1", "pay-cash", "user-1");

      expect(prisma.vendorBill.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { totalPaid: 300, status: "PARTIAL" } }),
      );
    });

    it("a never-received bill whose cash leaves is a DRAFT again; a VOID bill stays VOID", async () => {
      seed(partPaidBill({ status: "PARTIAL", receivedDate: null }));
      await service.movePaymentToSupplierCredit("bill-1", "pay-cash");
      expect(prisma.vendorBill.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { totalPaid: 0, status: "DRAFT" } }),
      );

      seed(partPaidBill({ status: "VOID" }));
      await service.movePaymentToSupplierCredit("bill-1", "pay-cash");
      expect(prisma.vendorBill.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ data: { totalPaid: 0, status: "VOID" } }),
      );
    });

    it("refuses a credit DRAW (409 BILL_PAYMENT_NOT_CASH) and writes nothing", async () => {
      seed(partPaidBill({ payments: [creditDraw()] }));
      const err: any = await service
        .movePaymentToSupplierCredit("bill-1", "pay-draw")
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.BILL_PAYMENT_NOT_CASH);
      expectNothingWritten();
    });

    it("refuses a bill with no supplier (409 BILL_PAYMENT_NO_SUPPLIER) and writes nothing", async () => {
      seed(partPaidBill({ supplierId: null }));
      const err: any = await service
        .movePaymentToSupplierCredit("bill-1", "pay-cash")
        .catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.BILL_PAYMENT_NO_SUPPLIER);
      expectNothingWritten();
    });

    it("404s an unknown bill or a payment that is not on this bill", async () => {
      prisma.vendorBill.findUnique.mockReset();
      prisma.vendorBill.findUnique.mockResolvedValue(null);
      await expect(service.movePaymentToSupplierCredit("nope", "pay-cash")).rejects.toBeInstanceOf(
        NotFoundException,
      );

      seed(partPaidBill());
      await expect(
        service.movePaymentToSupplierCredit("bill-1", "someone-elses-payment"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expectNothingWritten();
    });

    it("rolls back (throws) when the payment row was not removed, so the credit is never minted alone", async () => {
      seed(partPaidBill());
      prisma.billPayment.deleteMany.mockResolvedValue({ count: 0 });

      const err: any = await service
        .movePaymentToSupplierCredit("bill-1", "pay-cash")
        .catch((e) => e);

      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse().code).toBe(API_ERROR_CODES.BILL_STATE_CHANGED);
      expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    });
  });
});
