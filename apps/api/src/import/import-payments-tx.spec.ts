/**
 * #2262 / SA-404b: the bulk Zoho import writes each invoice's payments AND its Invoice status in ONE
 * transaction that updates (or creates) the Invoice row — restoring #2258's invariant (every
 * InvoicePayment writer touches its Invoice in the same tx, which makes voidInvoice's Serializable
 * re-check sound) and making invoice + payments atomic. Harness: import-robustness.spec.ts's, with
 * tenantTransaction instrumented so every write records WHICH transaction it ran in.
 * Real-Postgres atomicity/void-serialization proof: import-payments-tx.db.spec.ts (F2 lane).
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

type Write = {
  op: "payment" | "invoiceUpdate" | "invoiceCreate";
  tx: number | null;
  invoiceId?: string;
};

describe("#2262 import writes payments + the Invoice row in one transaction (SA-404b)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let numbering: { reserveNext: jest.Mock };
  let externalRefs: { findLocalId: jest.Mock; record: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    numbering = { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") };
    externalRefs = {
      findLocalId: jest.fn().mockResolvedValue(null),
      record: jest.fn().mockResolvedValue(undefined),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        // Harness: ImportService injects NumberingService (B267/B269); most
        // suites here never exercise a mint, so the default mock just satisfies DI
        // — REG-B268-E below drives it into failure on purpose.
        { provide: NumberingService, useValue: numbering },
        // Harness: ImportService injects ExternalRefService (B268/D4 re-import
        // idempotency for source-numberless rows). `findLocalId` → null is
        // "never imported before", the state every suite here assumes.
        { provide: ExternalRefService, useValue: externalRefs },
        // #2185 (B858/B859): ImportService routes product writes through ProductsService. This
        // suite imports payments only, so it never calls it; the stub just satisfies DI.
        {
          provide: ProductsService,
          useValue: {
            create: jest.fn().mockResolvedValue({ id: "prod-1" }),
            update: jest.fn().mockResolvedValue({ id: "prod-1" }),
            emitCatalogBulkChanged: jest.fn(),
            assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
            assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            judgeStaffWrite: jest.fn().mockResolvedValue({
              outcome: "ALLOW",
              reasons: [],
              breaches: [],
              basis: "CUSTOMER",
            }),
          },
        },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  let writes: Write[];
  let currentTx: number | null;

  beforeEach(() => {
    writes = [];
    currentTx = null;
    let n = 0;
    prisma.tenantTransaction.mockImplementation(async (fn: any) => {
      const id = ++n;
      currentTx = id;
      try {
        return await fn({ ...prisma.forTenant(), $executeRaw: jest.fn().mockResolvedValue(0) });
      } finally {
        currentTx = null;
      }
    });
    prisma.invoicePayment.create.mockImplementation(async (a: any) => {
      writes.push({ op: "payment", tx: currentTx, invoiceId: a.data.invoiceId });
      return { id: "pay-1" };
    });
    prisma.invoice.update.mockImplementation(async (a: any) => {
      writes.push({ op: "invoiceUpdate", tx: currentTx, invoiceId: a.where.id });
      return { id: a.where.id };
    });
    prisma.invoice.create.mockImplementation(async () => {
      writes.push({ op: "invoiceCreate", tx: currentTx, invoiceId: "inv-new" });
      return { id: "inv-new" };
    });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });
  });

  /** Every payment write ran in a tx that also wrote THAT invoice's row (update or create). */
  const expectPaymentsWithTheirInvoice = () => {
    const payments = writes.filter((w) => w.op === "payment");
    expect(payments.length).toBeGreaterThan(0);
    for (const p of payments) {
      expect(p.tx).not.toBeNull();
      const sameTx = writes.filter((w) => w.tx === p.tx && w.op !== "payment");
      expect(sameTx.map((w) => w.invoiceId)).toContain(p.invoiceId);
    }
  };

  it("importInvoices: a NEW PAID invoice and its synthetic payment are written in one tx", async () => {
    const csv =
      "Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n" +
      "INV-8801,Acme Corp,100.00,0,Paid\n";
    await service.importInvoices(Buffer.from(csv), "user-1");
    expectPaymentsWithTheirInvoice();
  });

  it("importInvoices: a numberless RE-import that flips to PAID updates the invoice and adds its payment in one tx", async () => {
    externalRefs.findLocalId.mockResolvedValueOnce(null).mockResolvedValueOnce("inv-prior");
    prisma.invoice.findFirst.mockResolvedValue({
      id: "inv-prior",
      customerId: "cust-1",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
      paidAt: null,
    });
    prisma.invoicePayment.findFirst.mockResolvedValue(null);
    const csv =
      "Invoice ID,Customer Name,Total,Balance Due,Invoice Status\n" +
      "zoho-77,Acme Corp,100.00,0,Paid\n";
    await service.importInvoices(Buffer.from(csv), "user-1");
    expectPaymentsWithTheirInvoice();
  });

  it("importPayments: each payment and its invoice's status UPDATE are one tx (the row is touched even if the status is unchanged)", async () => {
    const inv = {
      id: "inv-1",
      invoiceNumber: "INV-3001",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
    };
    prisma.invoice.findFirst.mockResolvedValue(inv);
    prisma.invoice.findUnique.mockResolvedValue({
      ...inv,
      payments: [{ amount: 40, status: "PAID" }],
    });
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]); // the end-of-run sweep is not under test here
    const csv = "Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-3001,40,Cash,2026-01-01\n";
    const result = await service.importPayments(Buffer.from(csv), "user-1");
    expect(result.imported).toBe(1);
    expectPaymentsWithTheirInvoice();
  });

  it("importPayments: a failed payment write leaves the invoice untouched (the row is an error, not half-written)", async () => {
    const inv = {
      id: "inv-1",
      invoiceNumber: "INV-3001",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
    };
    prisma.invoice.findFirst.mockResolvedValue(inv);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoicePayment.create.mockImplementationOnce(async (a: any) => {
      writes.push({ op: "payment", tx: currentTx, invoiceId: a.data.invoiceId });
      throw new Error("insert failed");
    });
    const csv = "Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-3001,40,Cash,2026-01-01\n";
    const result = await service.importPayments(Buffer.from(csv), "user-1");
    expect(result.errors.join(" ")).toMatch(/Payment for INV-3001/); // pushRowError sanitizes the cause
    // SA-424 N3: the failed insert was attempted INSIDE the per-row tx (pre-fix it ran on the pool,
    // tx null) and nothing was written to the invoice in that tx — so the rollback takes all of it.
    const attempt = writes.find((w) => w.op === "payment");
    expect(attempt?.tx).not.toBeNull();
    expect(writes.filter((w) => w.op === "invoiceUpdate" && w.tx === attempt?.tx)).toHaveLength(0);
  });

  it("importPayments (SA-424 N1): an invoice found VOID under the lock is a row error — no payment, placeholder kept", async () => {
    const inv = {
      id: "inv-1",
      invoiceNumber: "INV-3001",
      total: 100,
      status: InvoiceStatus.SENT,
      dueDate: null,
    };
    prisma.invoice.findFirst
      .mockResolvedValueOnce(inv) // the pre-tx lookup by number: still SENT
      .mockResolvedValue({ ...inv, status: InvoiceStatus.VOID }); // under the lock: voided meanwhile
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    const csv = "Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-3001,40,Cash,2026-01-01\n";
    const result = await service.importPayments(Buffer.from(csv), "user-1");
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.errors).toEqual(["Payment for INV-3001: invoice is voided"]);
    expect(writes.filter((w) => w.op === "payment")).toHaveLength(0);
    expect(prisma.invoicePayment.deleteMany).not.toHaveBeenCalled(); // the placeholder stays
  });

  it("importPayments (SA-424 N2): the end sweep is a compare-and-set on the status it read", async () => {
    prisma.invoice.findFirst.mockResolvedValue(null); // no rows import; only the sweep runs
    prisma.invoice.findMany.mockResolvedValue([
      {
        id: "inv-9",
        status: InvoiceStatus.SENT,
        total: 100,
        dueDate: null,
        payments: [{ amount: 100, status: "PAID" }],
      },
    ]);
    prisma.invoice.updateMany.mockResolvedValue({ count: 0 }); // voided since the read ⇒ no match
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (ops: any) =>
      Promise.all(ops),
    );
    const csv = "Invoice Number,Amount Applied to Invoice,Mode,Date\nINV-X,40,Cash,2026-01-01\n";
    await service.importPayments(Buffer.from(csv), "user-1");
    expect(prisma.invoice.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inv-9", status: InvoiceStatus.SENT } }),
    );
    expect(prisma.invoice.update).not.toHaveBeenCalled(); // never a blind write by id
  });
});
