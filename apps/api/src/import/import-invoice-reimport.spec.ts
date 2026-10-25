/**
 * #2468 (SA-468, tier 1): a Zoho invoice RE-import must never resurrect an invoice the app VOIDed or
 * WROTE OFF. Both re-import branches of `importInvoices` — the source-numbered upsert and the
 * numberless (Invoice ID) re-import — now sync status inside ONE tx that locks the invoice row,
 * re-reads its status under the lock, and SKIP a VOID / WRITTEN_OFF prior with a row error: no status
 * write, no synthetic payment. Harness: import-payments-tx.spec.ts's (records which tx each write ran
 * in). Real-Postgres race proof: the DB lane (F2).
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { ProductsService } from "../products/products.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";

type Write = {
  op: "payment" | "invoiceUpdate" | "invoiceCreate";
  tx: number | null;
  invoiceId?: string;
};

describe("#2468 invoice re-import never resurrects a VOID / WRITTEN_OFF invoice (SA-468)", () => {
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
        // #2185 (B858/B859): ImportService routes product writes through ProductsService; this
        // suite never reaches a product write, so the stub only satisfies DI.
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
        // #2093: importInvoices flags banned lines (never blocks); ALLOW keeps this suite's rows unflagged.
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

  const numberless = (status = "Paid", balance = "0") =>
    "Invoice ID,Customer Name,Total,Balance Due,Invoice Status\n" +
    `zoho-77,Acme Corp,100.00,${balance},${status}\n`;
  const numbered = (status = "Paid", balance = "0") =>
    "Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n" +
    `INV-8801,Acme Corp,100.00,${balance},${status}\n`;
  const prior = (status: InvoiceStatus) => ({
    id: "inv-prior",
    invoiceNumber: "INV-8801",
    customerId: "cust-1",
    total: 100,
    status,
    dueDate: null,
    paidAt: null,
  });
  const writesOf = (op: Write["op"]) => writes.filter((w) => w.op === op);

  describe("numberless re-import (Invoice ID)", () => {
    beforeEach(() => {
      externalRefs.findLocalId.mockResolvedValueOnce(null).mockResolvedValueOnce("inv-prior");
      prisma.invoicePayment.findFirst.mockResolvedValue(null);
    });

    it.each([
      [InvoiceStatus.VOID, "invoice is voided"],
      [InvoiceStatus.WRITTEN_OFF, "invoice is written off"],
    ])(
      "a %s prior re-imported with Balance Due 0 is SKIPPED with a row error — no status write, no payment",
      async (st, why) => {
        prisma.invoice.findFirst.mockResolvedValue(prior(st));
        const r = await service.importInvoices(Buffer.from(numberless()), "user-1");
        expect(r.errors).toEqual([expect.stringContaining(why)]);
        expect(r.errors[0]).toContain("import-ref zoho-77");
        expect({ updated: r.updated, skipped: r.skipped, imported: r.imported }).toEqual({
          updated: 0,
          skipped: 1,
          imported: 0,
        });
        expect(writesOf("invoiceUpdate")).toHaveLength(0);
        expect(writesOf("payment")).toHaveLength(0);
        expect(writesOf("invoiceCreate")).toHaveLength(0);
      },
    );

    it("a void that lands while the import waits: SENT before the lock, VOID under it ⇒ skipped, nothing written", async () => {
      prisma.invoice.findFirst
        .mockResolvedValueOnce(prior(InvoiceStatus.SENT)) // the pre-tx lookup
        .mockResolvedValue(prior(InvoiceStatus.VOID)); // re-read under the row lock
      const r = await service.importInvoices(Buffer.from(numberless()), "user-1");
      expect(r.errors).toEqual([expect.stringContaining("invoice is voided")]);
      expect(writesOf("invoiceUpdate")).toHaveLength(0);
      expect(writesOf("payment")).toHaveLength(0);
    });

    // #2478: an already-VOID / WRITTEN_OFF invoice re-imported with the SAME status and dates would
    // change nothing, so every run of the same file is a silent no-op skip, never a row error.
    it.each([
      [InvoiceStatus.VOID, "Void"],
      [InvoiceStatus.WRITTEN_OFF, "Written Off"],
    ])(
      "#2478: a %s prior re-imported unchanged is a silent skip — no error, no write",
      async (st, csvStatus) => {
        prisma.invoice.findFirst.mockResolvedValue(prior(st));
        const r = await service.importInvoices(Buffer.from(numberless(csvStatus)), "user-1");
        expect(r.errors).toEqual([]);
        expect({ updated: r.updated, skipped: r.skipped, imported: r.imported }).toEqual({
          updated: 0,
          skipped: 1,
          imported: 0,
        });
        expect(writesOf("invoiceUpdate")).toHaveLength(0);
        expect(writesOf("payment")).toHaveLength(0);
        expect(writesOf("invoiceCreate")).toHaveLength(0);
      },
    );

    it("control: a SENT prior still syncs to PAID with one synthetic payment, in one tx", async () => {
      prisma.invoice.findFirst.mockResolvedValue(prior(InvoiceStatus.SENT));
      const r = await service.importInvoices(Buffer.from(numberless()), "user-1");
      expect(r.errors).toEqual([]);
      expect(r.updated).toBe(1);
      const [upd] = writesOf("invoiceUpdate");
      const [pay] = writesOf("payment");
      expect(upd?.tx).not.toBeNull();
      expect(pay?.tx).toBe(upd?.tx);
    });
  });

  describe("source-numbered re-import (Invoice Number)", () => {
    it.each([
      [InvoiceStatus.VOID, "invoice is voided"],
      [InvoiceStatus.WRITTEN_OFF, "invoice is written off"],
    ])(
      "an existing %s invoice is SKIPPED with a row error — its status is never overwritten",
      async (st, why) => {
        prisma.invoice.findFirst.mockResolvedValue(prior(st));
        const r = await service.importInvoices(Buffer.from(numbered()), "user-1");
        expect(r.errors).toEqual([expect.stringContaining(why)]);
        expect(r.errors[0]).toContain("INV-8801");
        expect(r.updated).toBe(0);
        expect(writesOf("invoiceUpdate")).toHaveLength(0);
      },
    );

    it.each([
      [InvoiceStatus.VOID, "Void"],
      [InvoiceStatus.WRITTEN_OFF, "Written Off"],
    ])(
      "#2478: an existing %s invoice re-imported unchanged is a silent skip, every run",
      async (st, csvStatus) => {
        prisma.invoice.findFirst.mockResolvedValue(prior(st));
        for (let run = 0; run < 2; run++) {
          const r = await service.importInvoices(Buffer.from(numbered(csvStatus)), "user-1");
          expect(r.errors).toEqual([]);
          expect(r.skipped).toBe(1);
          expect(r.updated).toBe(0);
        }
        expect(writesOf("invoiceUpdate")).toHaveLength(0);
      },
    );

    it("#2478: a VOID invoice whose re-import WOULD change a field (its due date) is still refused", async () => {
      prisma.invoice.findFirst.mockResolvedValue({
        ...prior(InvoiceStatus.VOID),
        dueDate: new Date("2026-01-15T00:00:00Z"),
      });
      const r = await service.importInvoices(Buffer.from(numbered("Void")), "user-1");
      expect(r.errors).toEqual([expect.stringContaining("invoice is voided")]);
      expect(writesOf("invoiceUpdate")).toHaveLength(0);
    });

    it("control: a SENT invoice still syncs its status, now under the row lock (inside a tx)", async () => {
      prisma.invoice.findFirst.mockResolvedValue(prior(InvoiceStatus.SENT));
      const r = await service.importInvoices(Buffer.from(numbered()), "user-1");
      expect(r.updated).toBe(1);
      const [upd] = writesOf("invoiceUpdate");
      expect(upd?.tx).not.toBeNull();
    });
  });
});
