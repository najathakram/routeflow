import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { StatementApplyService } from "./statement-apply.service";
import { PrismaService } from "../prisma/prisma.service";
import { createMockPrisma } from "../testing/prisma-mock";

const D = (n: number | string) => new Prisma.Decimal(n);

/**
 * createMockPrisma() predates SupplierStatementScan (added by WP1's migration
 * #3 schema change) — graft a model proxy onto both the tenant-scoped surface
 * and the tenantTransaction surface, the same pattern
 * supplier-payment.spec.ts already uses for SupplierCredit.
 */
function graftSupplierStatementScan(prisma: ReturnType<typeof createMockPrisma>) {
  const model = {
    findUnique: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({}),
  };
  (prisma as any).supplierStatementScan = model;
  (prisma.forTenant() as any).supplierStatementScan = model;
  return model;
}

const scanRow = (overrides: Record<string, unknown> = {}) => ({
  id: "scan-1",
  tenantId: "tenant-1",
  supplierId: "sup-1",
  status: "SCANNED",
  extractedPayload: { lines: [] },
  appliedPaymentGroupId: null,
  appliedAt: null,
  appliedById: null,
  ...overrides,
});

/**
 * A vendor bill as applyStatement would load it — used both as the
 * `vendorBill.findUnique` ledger detail INSIDE the transaction and, reused
 * as-is, as one of the `vendorBill.findMany` candidates `fetchMatchableBills`
 * hands to the real `matchStatementLines` (which only reads
 * id/billNumber/supplierInvoiceNumber/totalOwed/billDate/status off it).
 */
const vendorBill = (overrides: Record<string, unknown> = {}) => ({
  id: "bill-1",
  billNumber: "BILL-2026-0001",
  supplierId: "sup-1",
  status: "RECEIVED",
  supplierInvoiceNumber: "INV-1001",
  totalOwed: D(100),
  totalPaid: D(0),
  billDate: new Date("2026-08-01"),
  payments: [] as { amount: Prisma.Decimal }[],
  ...overrides,
});

const statementLine = (overrides: Record<string, unknown> = {}) => ({
  date: "2026-08-01",
  kind: "INVOICE",
  refNumber: "INV-1001",
  amount: 100,
  runningBalance: 0,
  ...overrides,
});

describe("StatementApplyService — applyStatement (WP3)", () => {
  let service: StatementApplyService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let scanModel: ReturnType<typeof graftSupplierStatementScan>;

  const user = { sub: "user-1" };

  beforeEach(async () => {
    prisma = createMockPrisma();
    scanModel = graftSupplierStatementScan(prisma);

    const module: TestingModule = await Test.createTestingModule({
      providers: [StatementApplyService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<StatementApplyService>(StatementApplyService);
  });

  it("is idempotent: applying an already-APPLIED scan returns the stored payment group and writes nothing", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ status: "APPLIED", appliedPaymentGroupId: "group-existing" }),
    );

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [{ billId: "bill-1", amount: 100 }] },
      user,
    );

    expect(result.alreadyApplied).toBe(true);
    expect(result.paymentGroupId).toBe("group-existing");
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    expect(scanModel.update).not.toHaveBeenCalled();
  });

  it("throws when the scan does not exist", async () => {
    scanModel.findUnique.mockResolvedValue(null);

    await expect(
      service.applyStatement("missing", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(NotFoundException);
  });

  it("throws when the scan was discarded", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ status: "DISCARDED" }));

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("throws when the statement has not been matched to a supplier yet", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ supplierId: null }));

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("throws when there is nothing to apply", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow());

    await expect(service.applyStatement("scan-1", { confirmed: [] }, user)).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects a confirmed amount that exceeds the statement's own line, and writes nothing", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine({ amount: 100 })] } }),
    );
    const bill = vendorBill({ totalOwed: D(500) });
    prisma.vendorBill.findMany.mockResolvedValue([bill]);
    prisma.vendorBill.findUnique.mockResolvedValue(bill);

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 150 }] }, user),
    ).rejects.toThrow(/exceeds the statement's own line/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
    expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
  });

  it("rejects a confirmed amount that exceeds the bill's remaining balance, and writes nothing", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine({ amount: 100 })] } }),
    );
    // $100 owed, $60 already paid on the ledger -> only $40 left, but the
    // operator confirmed $90 (still within the statement's own $100 line).
    prisma.vendorBill.findMany.mockResolvedValue([vendorBill({ totalOwed: D(100) })]);
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({ totalOwed: D(100), payments: [{ amount: D(60) }] }),
    );

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 90 }] }, user),
    ).rejects.toThrow(/exceeds its remaining balance/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("rejects a confirmed bill when no statement line backs it at all", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill());

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(/No line on this statement/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("never pays a VOID bill", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine()] } }),
    );
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ status: "VOID" }));

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(/void/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("never pays a confirmed DRAFT bill — a statement can't settle stock that was never received", async () => {
    // A draft posted by an invoice scan carries the very
    // supplierInvoiceNumber the statement line matches on, so it tiers
    // EXACT_REF and the review screen would otherwise arrive pre-checked.
    // Flipping it to PAID locks it out of edit/revert/delete and the
    // needs-mapping queue for a receipt that never happened.
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine()] } }),
    );
    const draft = vendorBill({ status: "DRAFT" });
    prisma.vendorBill.findMany.mockResolvedValue([draft]);
    prisma.vendorBill.findUnique.mockResolvedValue(draft);

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(/still a draft/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("rejects a confirmed bill belonging to a different supplier than the statement", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine()] } }),
    );
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ supplierId: "sup-OTHER" }));

    await expect(
      service.applyStatement("scan-1", { confirmed: [{ billId: "bill-1", amount: 100 }] }, user),
    ).rejects.toThrow(/does not belong to this statement's supplier/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("writes one BillPayment per confirmed bill sharing one paymentGroupId, and records it on the scan", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({
        extractedPayload: {
          lines: [
            statementLine({ refNumber: "INV-1001", amount: 100 }),
            statementLine({ refNumber: "INV-1002", amount: 50 }),
          ],
        },
      }),
    );
    const bill1 = vendorBill({
      id: "bill-1",
      supplierInvoiceNumber: "INV-1001",
      totalOwed: D(100),
    });
    const bill2 = vendorBill({ id: "bill-2", supplierInvoiceNumber: "INV-1002", totalOwed: D(50) });
    prisma.vendorBill.findMany.mockResolvedValue([bill1, bill2]);
    prisma.vendorBill.findUnique.mockResolvedValueOnce(bill1).mockResolvedValueOnce(bill2);
    prisma.vendorBill.update
      .mockResolvedValueOnce({ id: "bill-1", status: "PAID", totalPaid: D(100) })
      .mockResolvedValueOnce({ id: "bill-2", status: "PAID", totalPaid: D(50) });
    prisma.billPayment.create
      .mockResolvedValueOnce({ id: "pay-1" })
      .mockResolvedValueOnce({ id: "pay-2" });

    const result = await service.applyStatement(
      "scan-1",
      {
        confirmed: [
          { billId: "bill-1", amount: 100 },
          { billId: "bill-2", amount: 50 },
        ],
      },
      user,
    );

    expect(prisma.billPayment.create).toHaveBeenCalledTimes(2);
    const groupIds = prisma.billPayment.create.mock.calls.map((c: any) => c[0].data.paymentGroupId);
    expect(groupIds.every((g: string) => !!g)).toBe(true);
    expect(new Set(groupIds).size).toBe(1);
    expect(result.paymentGroupId).toBe(groupIds[0]);
    expect(result.payments.map((p) => p.vendorBillId)).toEqual(["bill-1", "bill-2"]);
    expect(result.bills.map((b) => b.id)).toEqual(["bill-1", "bill-2"]);
    expect(result.excess).toBe(0);
    expect(prisma.supplierCredit.create).not.toHaveBeenCalled();

    expect(scanModel.update).toHaveBeenCalledWith({
      where: { id: "scan-1" },
      data: expect.objectContaining({
        status: "APPLIED",
        appliedPaymentGroupId: result.paymentGroupId,
        appliedById: "user-1",
      }),
    });
  });

  it("never mints SupplierCredit from the gap between a statement line and the confirmed amount", async () => {
    // The statement's own line says $100 against this invoice; the bill only
    // still owes $70 (already partly settled, or the line simply disagrees
    // with our books). The operator confirms the $70 the bill can take. The
    // remaining $30 is NOT cash anyone paid — it is an accounting
    // discrepancy — so banking it as on-account credit would hand the tenant
    // $30 of spendable credit out of thin air, which the next bill would
    // silently draw down.
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine({ amount: 100 })] } }),
    );
    // The matcher pairs by ref number, not by amount, so the $30 gap between
    // the line and this bill's own totalOwed doesn't block the EXACT_REF match.
    prisma.vendorBill.findMany.mockResolvedValue([vendorBill({ totalOwed: D(70) })]);
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill({ totalOwed: D(70) }));
    prisma.vendorBill.update.mockResolvedValueOnce({
      id: "bill-1",
      status: "PAID",
      totalPaid: D(70),
    });
    prisma.billPayment.create.mockResolvedValueOnce({ id: "pay-1" });

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [{ billId: "bill-1", amount: 70 }] },
      user,
    );

    expect(result.excess).toBe(0);
    expect(prisma.supplierCredit.create).not.toHaveBeenCalled();
    expect(prisma.billPayment.create.mock.calls[0][0].data.amount).toBe(70);
  });

  it("does NOT backdate a payment to the statement line's (invoice) date", async () => {
    // line.date is when the SUPPLIER ISSUED the invoice, not when it was
    // paid — writing it onto BillPayment.paidAt would book the cash into an
    // already-closed period (bookkeeping's cash-flow report buckets by paidAt).
    scanModel.findUnique.mockResolvedValue(
      scanRow({
        extractedPayload: { lines: [statementLine({ amount: 100, date: "2026-01-05" })] },
      }),
    );
    prisma.vendorBill.findMany.mockResolvedValue([vendorBill()]);
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill());
    prisma.billPayment.create.mockResolvedValueOnce({ id: "pay-1" });

    await service.applyStatement(
      "scan-1",
      { confirmed: [{ billId: "bill-1", amount: 100 }] },
      user,
    );

    expect(prisma.billPayment.create.mock.calls[0][0].data.paidAt).toBeUndefined();
  });

  it("accepts a candidate the operator picked that is NOT the matcher's primary suggestion", async () => {
    // Two non-VOID bills carry the same supplierInvoiceNumber (a re-issued
    // invoice). The matcher can only make one of them the primary pick; the
    // review screen offers both, and picking the loser must not fail the apply.
    scanModel.findUnique.mockResolvedValue(
      scanRow({
        extractedPayload: { lines: [statementLine({ refNumber: "INV-1001", amount: 100 })] },
      }),
    );
    const primary = vendorBill({ id: "bill-1", supplierInvoiceNumber: "INV-1001" });
    const other = vendorBill({ id: "bill-2", supplierInvoiceNumber: "INV-1001" });
    prisma.vendorBill.findMany.mockResolvedValue([primary, other]);
    prisma.vendorBill.findUnique.mockResolvedValue(other);
    prisma.billPayment.create.mockResolvedValueOnce({ id: "pay-1" });

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [{ lineIndex: 0, billId: "bill-2", amount: 100 }] },
      user,
    );

    expect(result.payments.map((p) => p.vendorBillId)).toEqual(["bill-2"]);
    expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a lineIndex that doesn't list the confirmed bill as a candidate", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({
        extractedPayload: {
          lines: [
            statementLine({ refNumber: "INV-1001", amount: 100 }),
            statementLine({ refNumber: "SOMETHING-ELSE", amount: 999, date: "2020-01-01" }),
          ],
        },
      }),
    );
    prisma.vendorBill.findMany.mockResolvedValue([vendorBill()]);
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill());

    await expect(
      service.applyStatement(
        "scan-1",
        { confirmed: [{ lineIndex: 1, billId: "bill-1", amount: 100 }] },
        user,
      ),
    ).rejects.toThrow(/No line on this statement/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("rejects the same bill confirmed on two lines, and writes nothing", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({ extractedPayload: { lines: [statementLine(), statementLine()] } }),
    );

    await expect(
      service.applyStatement(
        "scan-1",
        {
          confirmed: [
            { lineIndex: 0, billId: "bill-1", amount: 60 },
            { lineIndex: 1, billId: "bill-1", amount: 40 },
          ],
        },
        user,
      ),
    ).rejects.toThrow(/only be settled once/);

    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("honors a FUZZY-tier match (amount + date agree, ref number doesn't) exactly as the review screen showed it", async () => {
    scanModel.findUnique.mockResolvedValue(
      scanRow({
        extractedPayload: {
          lines: [statementLine({ refNumber: "SOME-OTHER-REF", amount: 100, date: "2026-08-01" })],
        },
      }),
    );
    // supplierInvoiceNumber doesn't match the line's refNumber, but the
    // amount and billDate both agree within the matcher's own tolerances —
    // the same FUZZY pairing statement-matcher.spec.ts (WP2) covers.
    const bill = vendorBill({
      supplierInvoiceNumber: "INV-9999",
      totalOwed: D(100),
      billDate: new Date("2026-08-01"),
    });
    prisma.vendorBill.findMany.mockResolvedValue([bill]);
    prisma.vendorBill.findUnique.mockResolvedValue(bill);
    prisma.vendorBill.update.mockResolvedValueOnce({
      id: "bill-1",
      status: "PAID",
      totalPaid: D(100),
    });
    prisma.billPayment.create.mockResolvedValueOnce({ id: "pay-1" });

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [{ billId: "bill-1", amount: 100 }] },
      user,
    );

    expect(result.payments.map((p) => p.vendorBillId)).toEqual(["bill-1"]);
    expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
  });

  it("marks an impliedPaid bill fully paid without requiring a matching statement line, sharing the same payment group, and never folds it into confirmed", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({
        id: "bill-old",
        supplierInvoiceNumber: "OLD-1",
        totalOwed: D(200),
        payments: [],
      }),
    );
    prisma.vendorBill.update.mockResolvedValueOnce({
      id: "bill-old",
      status: "PAID",
      totalPaid: D(200),
    });
    prisma.billPayment.create.mockResolvedValueOnce({ id: "pay-implied" });

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [], impliedPaid: { billIds: ["bill-old"] } },
      user,
    );

    expect(result.payments).toEqual([{ id: "pay-implied", vendorBillId: "bill-old", amount: 200 }]);
    expect(result.bills).toEqual([{ id: "bill-old", status: "PAID", totalPaid: 200 }]);
    expect(prisma.billPayment.create).toHaveBeenCalledTimes(1);
    expect(prisma.billPayment.create.mock.calls[0][0].data.amount).toBe(200);
    expect(prisma.billPayment.create.mock.calls[0][0].data.paymentGroupId).toBe(
      result.paymentGroupId,
    );
  });

  it("skips an impliedPaid bill that's already settled in our own books, without writing a $0 payment", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({ id: "bill-settled", totalOwed: D(200), payments: [{ amount: D(200) }] }),
    );

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [], impliedPaid: { billIds: ["bill-settled"] } },
      user,
    );

    expect(result.payments).toEqual([]);
    expect(result.bills).toEqual([]);
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("rejects an impliedPaid DRAFT bill — marking it paid would lock it out of the draft lifecycle", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({ id: "bill-draft", status: "DRAFT", totalOwed: D(200) }),
    );

    await expect(
      service.applyStatement(
        "scan-1",
        { confirmed: [], impliedPaid: { billIds: ["bill-draft"] } },
        user,
      ),
    ).rejects.toThrow(/still a draft/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
    expect(prisma.vendorBill.update).not.toHaveBeenCalled();
  });

  it("rejects an impliedPaid bill belonging to a different supplier than the statement", async () => {
    scanModel.findUnique.mockResolvedValue(scanRow({ extractedPayload: { lines: [] } }));
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({ id: "bill-old", supplierId: "sup-OTHER", totalOwed: D(200) }),
    );

    await expect(
      service.applyStatement(
        "scan-1",
        { confirmed: [], impliedPaid: { billIds: ["bill-old"] } },
        user,
      ),
    ).rejects.toThrow(/does not belong to this statement's supplier/);

    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });

  it("locks the scan row with SELECT ... FOR UPDATE BEFORE re-reading its status, so concurrent Applies serialize under READ COMMITTED", async () => {
    const order: string[] = [];
    const txExecuteRaw = jest.fn(() => {
      order.push("lock");
      return Promise.resolve(0);
    });
    (prisma.tenantTransaction as unknown as jest.Mock).mockImplementation((fn: any) =>
      fn({ ...(prisma as any), $executeRaw: txExecuteRaw }),
    );
    scanModel.findUnique.mockImplementation(() => {
      order.push("read");
      return Promise.resolve(scanRow({ extractedPayload: { lines: [] } }));
    });
    prisma.vendorBill.findUnique.mockResolvedValue(
      vendorBill({ id: "bill-settled", totalOwed: D(200), payments: [{ amount: D(200) }] }),
    );

    await service.applyStatement(
      "scan-1",
      { confirmed: [], impliedPaid: { billIds: ["bill-settled"] } },
      user,
    );

    // The transaction alone does NOT close the race: at READ COMMITTED both
    // racers would still see SCANNED and both would write a full payment set.
    expect(order).toEqual(["read", "lock", "read"]);
    const [strings, ...values] = txExecuteRaw.mock.calls[0] as unknown as [string[], ...unknown[]];
    expect(strings.join("?")).toContain('"SupplierStatementScan"');
    expect(strings.join("?")).toContain("FOR UPDATE");
    expect(values).toEqual(["scan-1"]);
  });

  it("closes the race where two concurrent Applies target the same scan: the second sees APPLIED inside the transaction and writes nothing further", async () => {
    scanModel.findUnique
      .mockResolvedValueOnce(scanRow({ status: "SCANNED" })) // outer check
      .mockResolvedValueOnce(scanRow({ status: "APPLIED", appliedPaymentGroupId: "group-raced" })); // race-guard re-check inside the transaction
    prisma.vendorBill.findUnique.mockResolvedValue(vendorBill());

    const result = await service.applyStatement(
      "scan-1",
      { confirmed: [{ billId: "bill-1", amount: 100 }] },
      user,
    );

    expect(result.alreadyApplied).toBe(true);
    expect(result.paymentGroupId).toBe("group-raced");
    expect(prisma.billPayment.create).not.toHaveBeenCalled();
  });
});
