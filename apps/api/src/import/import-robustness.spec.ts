/**
 * F17 — import robustness regression pins.
 *
 * REG-B98  (T-B98):  bare `parseFloat` truncates comma-thousands money at the
 *   comma ("1,234.56" → 1) and returns NaN on a leading currency symbol
 *   ("$2,000" → NaN) across every importer that reads a money/rate column.
 *   Fixed by routing every money/qty read through `parseImportNumber` /
 *   `parseImportMoney` (apps/api/src/import/parse-import-number.ts).
 * REG-B99  (T-B99):  `importPayments` promises a dedupe fallback for rows
 *   without a `InvoicePayment ID` (comment at the top of the try block) but
 *   never implements it — a re-uploaded payments file doubles every payment.
 *   Fixed by a per-invoice snapshot (payments that existed BEFORE this run's
 *   inserts) so a re-upload dedupes against history while two identical
 *   legit rows inside ONE file still both import. Two further defects in the
 *   same blast radius, found by the F17 final pass:
 *     (a) the snapshot match was not COUNT-aware — it left the matched entry
 *         in place, so ONE history row absorbed MANY incoming rows and a real
 *         second payment was silently lost on the operator's documented
 *         re-upload recovery. Each snapshot entry now dedupes at most one row.
 *     (b) the post-import tenant-wide status recalc summed `status !== "VOID"`
 *         and flipped PAID at `total - 0.01`, so an unrelated payments upload
 *         could flip an invoice to PAID on the strength of an unconfirmed
 *         DRAFT payment. It now sums CONFIRMED rows only (`sumConfirmed`,
 *         ../invoices/payment-predicates.ts, campaign batch F03) at
 *         `total - 0.001`, matching InvoicesService.recomputeStatus.
 *   Three further properties of the same fix, each unpinned until the F17
 *   adversarial pass and each a money bug if it regresses:
 *     (c) the snapshot Map is keyed by invoice.id. Collapsing it to one shared
 *         key makes a single global snapshot decide every invoice's rows, so
 *         one invoice's history swallows (or lets through) another's payment.
 *     (d) the snapshot filter drops BOTH "zoho-import" placeholders AND VOID
 *         rows. A VOID row is money that was never collected — re-recording a
 *         bounced check must import, not dedupe against the voided row.
 *     (e) rows carrying an `InvoicePayment ID` take the reference branch and
 *         never the amount/date fallback: an already-seen id is `skipped`,
 *         and a NEW id imports even when amount/method/date collide.
 * REG-B112 (T-B112): `parseCsv` doesn't pass `bom: true` to csv-parse, so a
 *   UTF-8-BOM-prefixed file (a common Excel "CSV UTF-8" export) leaves the
 *   BOM glued to the first header key — every row's first column reads as
 *   undefined and gets silently skipped.
 *
 * These tests drive the real public `ImportService` methods with raw CSV
 * Buffers end to end and assert on the values written to a mocked
 * PrismaService — never on `parse-import-number.ts` directly (it doesn't
 * exist yet on this tree).
 */
import { Test } from "@nestjs/testing";
import { InvoiceStatus } from "@prisma/client";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";

describe("ImportService — import robustness (F17)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
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
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  describe("REG-B98 — comma-thousands and currency-symbol money parsing", () => {
    it("REG-B98 (T-B98): importInvoices stores comma/currency money cent-exact across total/subtotal/discount/shipping/line unitPrice", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });

      const csv =
        "Invoice Number,Customer Name,Total,SubTotal,Entity Discount Amount,Shipping Charge,Item Name,Quantity,Item Price,Item Total\n" +
        'INV-2001,Acme Corp,"1,234.56","$2,000.00","$34.56","$15.00",Widget,"1,200","$500.25","$1,000.50"\n';

      await service.importInvoices(Buffer.from(csv), "user-1");

      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      expect(data.total).toBe(1234.56);
      expect(data.subtotal).toBe(2000);
      expect(data.discount).toBe(34.56);
      expect(data.shippingFee).toBe(15);
      const item = data.items.create[0];
      expect(item.unitPrice).toBe(500.25);
      expect(item.subtotal).toBe(1000.5);
      // import.service.ts:684 (line qty) is a parseImportNumber call site in R1 too —
      // it is a COUNT, not money, so it is parsed but never cent-rounded. Bare
      // parseFloat("1,200") is 1, so this is red today.
      expect(item.qty).toBe(1200);
    });

    it("REG-B98 (T-B98): a comma/currency line-level Discount Amount is applied cent-exact and drives the derived line subtotal", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });

      // No "Item Total" column, so the line subtotal must come from the
      // `qty * unitPrice - itemDiscount` fallback — the only path that reads
      // the line-level discount at all.
      const csv =
        "Invoice Number,Customer Name,Total,Item Name,Quantity,Item Price,Discount Amount\n" +
        'INV-6001,Acme Corp,"3,000.00",Widget,3,"$1,000.00","$1,250.75"\n';

      await service.importInvoices(Buffer.from(csv), "user-1");

      expect(prisma.invoice.create).toHaveBeenCalledTimes(1);
      const data = (prisma.invoice.create.mock.calls[0][0] as any).data;
      const item = data.items.create[0];
      expect(item.unitPrice).toBe(1000);
      expect(item.discount).toBe(1250.75);
      expect(item.subtotal).toBe(1749.25); // 3 × 1000 − 1250.75
      // "Discount Amount" doubles as the invoice-level discount fallback.
      expect(data.discount).toBe(1250.75);
    });

    it("REG-B98 (T-B98): importPayments stores a comma-formatted payment amount cent-exact", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1", invoiceNumber: "INV-3001" });
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here

      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        'INV-3001,"2,345.10",Cash,2026-01-01\n';

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      const data = (prisma.invoicePayment.create.mock.calls[0][0] as any).data;
      expect(data.amount).toBe(2345.1);
      expect(result.imported).toBe(1);
    });

    it("REG-B98 (T-B98): importExpenses stores a currency-symbol expense amount cent-exact", async () => {
      prisma.expenseCategory.create.mockResolvedValue({ id: "cat-1" });

      const csv = "Expense Category,Expense Date,Total\n" + 'Fuel,2026-01-05,"$3,456.78"\n';

      const result = await service.importExpenses(Buffer.from(csv), "user-1");

      expect(prisma.expense.create).toHaveBeenCalledTimes(1);
      const data = (prisma.expense.create.mock.calls[0][0] as any).data;
      expect(data.amount).toBe(3456.78);
      expect(result.imported).toBe(1);
    });

    it("REG-B98 (T-B98): importProducts stores a comma-thousands rate cent-exact", async () => {
      const csv = "Item Name,Rate\n" + 'Widget XL,"4,567.89"\n';

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(prisma.product.create).toHaveBeenCalledTimes(1);
      const data = (prisma.product.create.mock.calls[0][0] as any).data;
      expect(data.pricePerUnit).toBe(4567.89);
      expect(result.imported).toBe(1);
    });

    it("REG-B98 (T-B98): importInventory reads a comma-thousands Closing Stock exactly and skips a non-numeric one instead of zeroing stock", async () => {
      const csv = "Item Name,Closing Stock\n" + 'Widget A,"2,100.00"\n' + "Widget B,N/A\n";

      const result = await service.importInventory(Buffer.from(csv), "user-1");

      // The NaN-vs-0 contract is load-bearing: an unparseable cell must skip the
      // row, never fall through and write the stock level down to 0.
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(1);
      expect(prisma.product.create).toHaveBeenCalledTimes(1);
      const data = (prisma.product.create.mock.calls[0][0] as any).data;
      expect(data.name).toBe("Widget A");
      expect(data.currentStock).toBe(2100);
    });

    it("REG-B98 (T-B98): a comma/currency Balance Due drives PAID vs PARTIAL, and an absent Balance Due still falls back to the Zoho status label", async () => {
      prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });

      const csv =
        "Invoice Number,Customer Name,Total,Balance Due,Invoice Status\n" +
        'INV-5001,Acme Corp,"2,000.00","$0.00",\n' +
        'INV-5002,Acme Corp,"2,000.00","$772.50",\n' +
        'INV-5003,Acme Corp,"2,000.00",,Overdue\n';

      await service.importInvoices(Buffer.from(csv), "user-1");

      const calls = prisma.invoice.create.mock.calls as any[];
      const byNumber = (num: string) =>
        calls.find((c) => c[0].data.invoiceNumber === num)?.[0].data;

      // Comma-thousands "0.00" reads as fully paid (fully paid, balance ~0).
      expect(byNumber("INV-5001")?.status).toBe(InvoiceStatus.PAID);
      // Currency-symbol "$772.50" reads as a genuine partial balance.
      expect(byNumber("INV-5002")?.status).toBe(InvoiceStatus.PARTIAL);
      // An EMPTY Balance Due cell (the column exists) → the `|| "NaN"` absence
      // sentinel must still fall back to the Zoho label.
      expect(byNumber("INV-5003")?.status).toBe(InvoiceStatus.OVERDUE);
    });
  });

  describe("REG-B99 — payments dedupe with snapshot semantics", () => {
    it("REG-B99 (T-B99): a re-uploaded payments row (no InvoicePayment ID) dedupes against history without re-flipping statuses, while two identical rows in one file both import", async () => {
      // Stateful invoice fake so the post-loop status recalc really runs on BOTH
      // passes. Each invoice totals 1000 and the file pays 500, so a regressed
      // dedupe would double-record to 1000 and flip the invoice to PAID — the
      // exact user harm B99 names.
      const invoiceStore: Record<string, any> = {
        "inv-1": {
          id: "inv-1",
          invoiceNumber: "INV-9001",
          total: 1000,
          status: InvoiceStatus.SENT,
          dueDate: null,
          paidAt: null,
        },
        "inv-2": {
          id: "inv-2",
          invoiceNumber: "INV-9002",
          total: 1000,
          status: InvoiceStatus.SENT,
          dueDate: null,
          paidAt: null,
        },
      };
      prisma.invoice.findFirst.mockImplementation(
        async ({ where }: any) =>
          Object.values(invoiceStore).find((i) => i.invoiceNumber === where.invoiceNumber) ?? null,
      );

      // A tiny stateful fake so a "re-upload" genuinely sees the payment the
      // previous run wrote, the way a real Postgres re-read would.
      const paymentStore: any[] = [];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        // `status` is not written by the importer — schema.prisma defaults
        // InvoicePayment.status to PAID, so every row it creates is CONFIRMED.
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on any row

      // The recalc reads every invoice with its payments, then writes the changed
      // ones through `$transaction([...updates])` — the array form, not a callback.
      prisma.invoice.findMany.mockImplementation(async () =>
        Object.values(invoiceStore).map((inv) => ({
          ...inv,
          payments: paymentStore.filter((p) => p.invoiceId === inv.id),
        })),
      );
      prisma.invoice.update.mockImplementation(async ({ where, data }: any) => {
        Object.assign(invoiceStore[where.id], data);
        return invoiceStore[where.id];
      });
      const transaction = prisma.$transaction as unknown as jest.Mock;
      transaction.mockImplementation(async (ops: any) => Promise.all(ops));

      // ── Re-upload: the exact same single-row file imported twice ───────────
      const reuploadCsv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9001,500.00,Cash,2026-02-10\n";

      const firstRun = await service.importPayments(Buffer.from(reuploadCsv), "user-1");
      expect(firstRun.imported).toBe(1);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      // 500 of a 1000 invoice — the recalc flips SENT → PARTIAL exactly once.
      expect(invoiceStore["inv-1"].status).toBe(InvoiceStatus.PARTIAL);
      const invoiceWritesAfterFirstRun = prisma.invoice.update.mock.calls.length;
      const recalcTxAfterFirstRun = transaction.mock.calls.length;

      const secondRun = await service.importPayments(Buffer.from(reuploadCsv), "user-1");
      expect(secondRun.imported).toBe(0);
      expect(secondRun.duplicates).toBe(1);
      // No second create call — the dedupe must fire BEFORE any write.
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      // …and statuses are not double-flipped: the surviving single 500 payment
      // still recomputes to PARTIAL, so the recalc writes nothing on this run.
      expect(invoiceStore["inv-1"].status).toBe(InvoiceStatus.PARTIAL);
      expect(invoiceStore["inv-1"].paidAt).toBeNull();
      expect(prisma.invoice.update.mock.calls.length).toBe(invoiceWritesAfterFirstRun);
      expect(transaction.mock.calls.length).toBe(recalcTxAfterFirstRun);

      // ── Snapshot semantics: two identical LEGIT rows in ONE file both import ──
      const twoRowCsv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9002,100.00,Cash,2026-02-01\n" +
        "INV-9002,100.00,Cash,2026-02-01\n";

      const thirdRun = await service.importPayments(Buffer.from(twoRowCsv), "user-1");
      expect(thirdRun.imported).toBe(2);
      expect(thirdRun.duplicates).toBe(0);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(3); // 1 (run 1) + 2 (run 3)
      expect(invoiceStore["inv-2"].status).toBe(InvoiceStatus.PARTIAL);
    });

    it("REG-B99 (T-B99): the synthetic zoho-import placeholder is replaced by the real payment, never treated as a duplicate of it", async () => {
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-3", invoiceNumber: "INV-9003" });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on the row

      // importInvoices already wrote the placeholder for this PAID invoice:
      // same amount, method OTHER, createdAt = the invoice's payment date.
      const paymentStore: any[] = [
        {
          id: "pay-placeholder",
          invoiceId: "inv-3",
          amount: 100,
          method: "OTHER",
          reference: "zoho-import",
          notes: "Imported from Zoho",
          status: "PAID",
          createdAt: new Date("2026-06-01"),
        },
      ];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.deleteMany.mockImplementation(async ({ where }: any) => {
        const before = paymentStore.length;
        for (let i = paymentStore.length - 1; i >= 0; i--) {
          if (
            paymentStore[i].invoiceId === where.invoiceId &&
            paymentStore[i].reference === where.reference
          )
            paymentStore.splice(i, 1);
        }
        return { count: before - paymentStore.length };
      });
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });

      // Blank Mode maps to OTHER — exactly the placeholder's method — and the
      // date matches, so an unfiltered snapshot would call this a duplicate.
      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date,Reference Number\n" +
        "INV-9003,100.00,,2026-06-01,CHK-4471\n";

      const result = (await service.importPayments(Buffer.from(csv), "user-1")) as any;

      expect(result.imported).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      const created = (prisma.invoicePayment.create.mock.calls[0][0] as any).data;
      expect(created.reference).toBe("CHK-4471");
      // The placeholder is gone; only the real payment survives.
      expect(paymentStore).toHaveLength(1);
      expect(paymentStore[0].reference).toBe("CHK-4471");
    });

    it("REG-B99 (T-B99): one history row dedupes AT MOST ONE incoming row — the second identical real payment still imports", async () => {
      // The file holds two identical legitimate $500 CASH rows for one invoice.
      // On the operator's first upload row 1 persisted and row 2 hit the per-row
      // catch, so history holds ONE of them. They re-upload the same file (the
      // documented recovery): row 1 must dedupe against that single history row
      // and row 2 — a real payment that was never recorded — must land. A
      // snapshot match that is not consumed lets that one history row absorb
      // BOTH rows, reporting "0 imported, 2 duplicates" and losing $500.
      const invoice = {
        id: "inv-4",
        invoiceNumber: "INV-9004",
        total: 1000,
        status: InvoiceStatus.PARTIAL,
        dueDate: null,
        paidAt: null,
      };
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      const paymentStore: any[] = [
        {
          id: "pay-history",
          invoiceId: "inv-4",
          amount: 500,
          method: "CASH",
          reference: null,
          status: "PAID",
          createdAt: new Date("2026-03-01"),
        },
      ];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on any row

      prisma.invoice.findMany.mockImplementation(async () => [
        { ...invoice, payments: paymentStore.filter((p) => p.invoiceId === invoice.id) },
      ]);
      prisma.invoice.update.mockImplementation(async ({ data }: any) => {
        Object.assign(invoice, data);
        return invoice;
      });
      (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (ops: any) =>
        Promise.all(ops),
      );

      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9004,500.00,Cash,2026-03-01\n" +
        "INV-9004,500.00,Cash,2026-03-01\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(result.duplicates).toBe(1);
      expect(result.imported).toBe(1);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      // The money is whole again: 500 (history) + 500 (the recovered row).
      expect(paymentStore).toHaveLength(2);
      expect(paymentStore.reduce((s, p) => s + Number(p.amount), 0)).toBe(1000);
      expect(invoice.status).toBe(InvoiceStatus.PAID);
    });

    it("REG-B99 (T-B99): the post-import recalc counts CONFIRMED payments only — a DRAFT payment covering the full total never flips an invoice to PAID", async () => {
      // The uploaded file touches INV-9007 alone, but the recalc sweeps EVERY
      // invoice in the tenant — so an unrelated upload must not settle invoices
      // on the strength of unconfirmed money. Only `status === "PAID"` counts
      // (../invoices/payment-predicates.ts, campaign batch F03).
      const draftCovered = {
        id: "inv-draft",
        invoiceNumber: "INV-9005",
        total: 1000,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      const confirmedCovered = {
        id: "inv-confirmed",
        invoiceNumber: "INV-9006",
        total: 1000,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      // One cent short of the total: PAID slack is a tenth of a cent
      // (InvoicesService.recomputeStatus), not a whole cent.
      const centShort = {
        id: "inv-short",
        invoiceNumber: "INV-9008",
        total: 1000,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      const target = {
        id: "inv-target",
        invoiceNumber: "INV-9007",
        total: 250,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      const invoiceStore = [draftCovered, confirmedCovered, centShort, target];

      const paymentStore: any[] = [
        {
          id: "pay-draft",
          invoiceId: "inv-draft",
          amount: 1000,
          method: "CHECK",
          reference: null,
          status: "DRAFT", // an unconfirmed bulk bank-reconciliation row
          createdAt: new Date("2026-04-01"),
        },
        {
          id: "pay-confirmed",
          invoiceId: "inv-confirmed",
          amount: 1000,
          method: "CHECK",
          reference: null,
          status: "PAID",
          createdAt: new Date("2026-04-01"),
        },
        {
          id: "pay-short",
          invoiceId: "inv-short",
          amount: 999.99,
          method: "CHECK",
          reference: null,
          status: "PAID",
          createdAt: new Date("2026-04-01"),
        },
      ];

      prisma.invoice.findFirst.mockImplementation(
        async ({ where }: any) =>
          invoiceStore.find((i) => i.invoiceNumber === where.invoiceNumber) ?? null,
      );
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on the row
      prisma.invoice.findMany.mockImplementation(async () =>
        invoiceStore.map((inv) => ({
          ...inv,
          payments: paymentStore.filter((p) => p.invoiceId === inv.id),
        })),
      );
      prisma.invoice.update.mockImplementation(async ({ where, data }: any) => {
        const inv = invoiceStore.find((i) => i.id === where.id)!;
        Object.assign(inv, data);
        return inv;
      });
      (prisma.$transaction as unknown as jest.Mock).mockImplementation(async (ops: any) =>
        Promise.all(ops),
      );

      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9007,100.00,Cash,2026-04-10\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(result.imported).toBe(1);
      // The unconfirmed payment is NOT collected money: the invoice stays SENT.
      expect(draftCovered.status).toBe(InvoiceStatus.SENT);
      expect(draftCovered.paidAt).toBeNull();
      // The confirmed one settles, so the recalc itself still works.
      expect(confirmedCovered.status).toBe(InvoiceStatus.PAID);
      // A cent short is NOT paid.
      expect(centShort.status).toBe(InvoiceStatus.PARTIAL);
      // …and the row this file actually paid partly settles as normal.
      expect(target.status).toBe(InvoiceStatus.PARTIAL);
    });

    it("REG-B99 (T-B99): the pre-run snapshot is keyed PER INVOICE — one invoice's history never dedupes another invoice's row", async () => {
      // One file, two different invoices, one $500 CASH row each. Invoice A already
      // holds that payment (a re-upload), invoice B holds nothing (a brand-new
      // payment). Correct: B's row imports, A's row dedupes. A single FLAT snapshot
      // shared by every invoice would cross-contaminate the two — whichever invoice
      // is seen first would decide the fate of both, so a real payment is either
      // swallowed or double-recorded. The row order below (B first) is deliberate:
      // it makes the flat-snapshot failure surface as B's empty history letting A's
      // re-uploaded row through a second time.
      const invoiceA = {
        id: "inv-a",
        invoiceNumber: "INV-9101",
        total: 5000,
        status: InvoiceStatus.PARTIAL,
        dueDate: null,
        paidAt: null,
      };
      const invoiceB = {
        id: "inv-b",
        invoiceNumber: "INV-9102",
        total: 5000,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      const invoiceStore = [invoiceA, invoiceB];
      prisma.invoice.findFirst.mockImplementation(
        async ({ where }: any) =>
          invoiceStore.find((i) => i.invoiceNumber === where.invoiceNumber) ?? null,
      );

      // Only invoice A has history; invoice B has none at all.
      const paymentStore: any[] = [
        {
          id: "pay-a-history",
          invoiceId: "inv-a",
          amount: 500,
          method: "CASH",
          reference: null,
          status: "PAID",
          createdAt: new Date("2026-07-01"),
        },
      ];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on any row
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here

      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9102,500.00,Cash,2026-07-01\n" +
        "INV-9101,500.00,Cash,2026-07-01\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(result.imported).toBe(1);
      expect(result.duplicates).toBe(1);
      // Exactly one write, and it belongs to the invoice with NO history.
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect((prisma.invoicePayment.create.mock.calls[0][0] as any).data.invoiceId).toBe("inv-b");
      // Each invoice ends with exactly one $500 payment — none lost, none doubled.
      expect(paymentStore.filter((p) => p.invoiceId === "inv-a")).toHaveLength(1);
      expect(paymentStore.filter((p) => p.invoiceId === "inv-b")).toHaveLength(1);
      // Each invoice loaded its OWN history exactly once.
      expect(prisma.invoicePayment.findMany).toHaveBeenCalledTimes(2);
    });

    it("REG-B99 (T-B99): a VOID payment in history is not collected money — an identical incoming row imports instead of being deduped away", async () => {
      // The operator's earlier check bounced and was voided. They re-record the
      // payment (same amount, same method, same day). A VOID row is money that was
      // never collected, so it must not stand in as the incoming row's duplicate —
      // deduping against it would silently drop the replacement payment.
      const invoice = {
        id: "inv-void",
        invoiceNumber: "INV-9201",
        total: 1000,
        status: InvoiceStatus.SENT,
        dueDate: null,
        paidAt: null,
      };
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      const paymentStore: any[] = [
        {
          id: "pay-bounced",
          invoiceId: "inv-void",
          amount: 500,
          method: "CHECK",
          reference: "CHK-9001",
          status: "VOID", // the bounced check
          createdAt: new Date("2026-05-01"),
        },
      ];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoicePayment.findFirst.mockResolvedValue(null); // no InvoicePayment ID on the row
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here

      const csv =
        "Invoice Number,Amount Applied to Invoice,Mode,Date,Reference Number\n" +
        "INV-9201,500.00,Check,2026-05-01,CHK-9002\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(result.imported).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect((prisma.invoicePayment.create.mock.calls[0][0] as any).data.reference).toBe(
        "CHK-9002",
      );
      // The voided row stays put; the replacement is recorded beside it.
      expect(paymentStore).toHaveLength(2);
    });

    it("REG-B99 (T-B99): a row whose InvoicePayment ID is already a payment reference on the invoice is SKIPPED by the reference check, not counted as an amount/date duplicate", async () => {
      // ID-bearing rows take the reference branch. The row below ALSO collides with
      // history on amount/method/date, so if that branch were bypassed the fallback
      // would classify it as a `duplicates` hit instead — a different tally the
      // operator reads on the import summary.
      const invoice = {
        id: "inv-zoho",
        invoiceNumber: "INV-9301",
        total: 1000,
        status: InvoiceStatus.PARTIAL,
        dueDate: null,
        paidAt: null,
      };
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      const existing = {
        id: "pay-zoho-history",
        invoiceId: "inv-zoho",
        amount: 500,
        method: "CASH",
        reference: "PAY-778899",
        status: "PAID",
        createdAt: new Date("2026-08-01"),
      };
      const paymentStore: any[] = [existing];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.findFirst.mockImplementation(
        async ({ where }: any) =>
          paymentStore.find(
            (p) => p.invoiceId === where.invoiceId && p.reference === where.reference,
          ) ?? null,
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here

      const csv =
        "Invoice Number,InvoicePayment ID,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9301,PAY-778899,500.00,Cash,2026-08-01\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      // The reference branch increments `skipped`, NOT `duplicates`.
      expect(result.skipped).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.imported).toBe(0);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.findFirst).toHaveBeenCalledWith({
        where: { invoiceId: "inv-zoho", reference: "PAY-778899" },
      });
      expect(paymentStore).toHaveLength(1);
    });

    it("REG-B99 (T-B99): an ID-bearing row with a NEW InvoicePayment ID imports even when its amount/method/date collide with history", async () => {
      // A second, genuinely distinct payment of the same amount and method on the
      // same day, carrying its own Zoho id. The external id is authoritative: it
      // says this is NOT the row already on file, so the amount/date fallback must
      // never get a say and the payment must land.
      const invoice = {
        id: "inv-zoho2",
        invoiceNumber: "INV-9302",
        total: 2000,
        status: InvoiceStatus.PARTIAL,
        dueDate: null,
        paidAt: null,
      };
      prisma.invoice.findFirst.mockResolvedValue(invoice);

      const paymentStore: any[] = [
        {
          id: "pay-zoho2-history",
          invoiceId: "inv-zoho2",
          amount: 500,
          method: "CASH",
          reference: "PAY-111111",
          status: "PAID",
          createdAt: new Date("2026-08-02"),
        },
      ];
      prisma.invoicePayment.findMany.mockImplementation(async ({ where }: any) =>
        paymentStore.filter((p) => p.invoiceId === where.invoiceId),
      );
      prisma.invoicePayment.findFirst.mockImplementation(
        async ({ where }: any) =>
          paymentStore.find(
            (p) => p.invoiceId === where.invoiceId && p.reference === where.reference,
          ) ?? null,
      );
      prisma.invoicePayment.create.mockImplementation(async ({ data }: any) => {
        const rec = { id: `pay-${paymentStore.length + 1}`, status: "PAID", ...data };
        paymentStore.push(rec);
        return rec;
      });
      prisma.invoice.findMany.mockResolvedValue([]); // status recalc is not under test here

      const csv =
        "Invoice Number,InvoicePayment ID,Amount Applied to Invoice,Mode,Date\n" +
        "INV-9302,PAY-222222,500.00,Cash,2026-08-02\n";

      const result = await service.importPayments(Buffer.from(csv), "user-1");

      expect(result.imported).toBe(1);
      expect(result.duplicates).toBe(0);
      expect(result.skipped).toBe(0);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      const created = (prisma.invoicePayment.create.mock.calls[0][0] as any).data;
      // The Zoho id is stored as the reference so the NEXT re-upload dedupes on it.
      expect(created.reference).toBe("PAY-222222");
      expect(created.amount).toBe(500);
      // Both payments are on the books: 500 (history) + 500 (the new one).
      expect(paymentStore).toHaveLength(2);
      expect(paymentStore.reduce((s, p) => s + Number(p.amount), 0)).toBe(1000);
    });
  });

  describe("REG-B112 — UTF-8 BOM on the first CSV column", () => {
    it("REG-B112 (T-B112): a BOM-prefixed contacts buffer imports with a clean first-column key instead of being skipped", async () => {
      const bomCsv = "\uFEFFCustomer Name\nAcme Distributors\n";

      const result = await service.importContacts(Buffer.from(bomCsv, "utf8"), "user-1");

      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
      const data = (prisma.customer.create.mock.calls[0][0] as any).data;
      expect(data.businessName).toBe("Acme Distributors");
    });
  });
});
