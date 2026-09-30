/**
 * #2190 - the INVOICE importer no longer coerces a present-but-unparseable money cell to $0.
 * Contract (same as the products/customers path, #2185): a blank cell keeps today's default; a
 * non-blank cell that is not a number skips the WHOLE invoice group before any write, with the
 * reason `<Column header>: not a number`. Negative money is legitimate on an invoice (credits).
 */
import { Test } from "@nestjs/testing";
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

const HEAD = [
  "Invoice Number",
  "Customer Name",
  "Total",
  "SubTotal",
  "Entity Discount Amount",
  "Shipping Charge",
  "Balance Due",
  "Invoice Status",
  "Item Name",
  "Quantity",
  "Item Price",
  "Discount Amount",
  "Item Total",
];

/** One-line invoice CSV; `over` replaces named columns. */
function csv(over: Record<string, string> = {}, extraRows: Array<Record<string, string>> = []) {
  const base: Record<string, string> = {
    "Invoice Number": "INV-9001",
    "Customer Name": "Acme Corp",
    Total: "100.00",
    SubTotal: "100.00",
    "Entity Discount Amount": "0",
    "Shipping Charge": "0",
    "Balance Due": "100.00",
    "Invoice Status": "Sent",
    "Item Name": "Widget",
    Quantity: "2",
    "Item Price": "50.00",
    "Discount Amount": "0",
    "Item Total": "100.00",
  };
  const line = (r: Record<string, string>) => HEAD.map((h) => `"${r[h] ?? ""}"`).join(",");
  const lines = [HEAD.join(","), line({ ...base, ...over })];
  for (const r of extraRows) lines.push(line({ ...base, ...r }));
  return lines.join("\n");
}

describe("#2190 invoice importer: a bad money cell skips the invoice, never imports $0", () => {
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
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  let created: any[];

  beforeEach(() => {
    created = [];
    prisma.tenantTransaction.mockImplementation(async (fn: any) =>
      fn({ ...prisma.forTenant(), $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
    prisma.invoice.findFirst.mockResolvedValue(null);
    prisma.invoice.create.mockImplementation(async (a: any) => {
      created.push(a.data);
      return { id: "inv-new", invoiceNumber: a.data.invoiceNumber };
    });
    prisma.invoicePayment.create.mockResolvedValue({ id: "pay-1" });
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", businessName: "Acme Corp" });
  });

  const run = (text: string) => service.importInvoices(Buffer.from(text), "user-1");

  const BAD: Array<[string, Record<string, string>]> = [
    ["Total", { Total: "12abc" }],
    ["SubTotal", { SubTotal: "abc" }],
    ["Entity Discount Amount", { "Entity Discount Amount": "1x" }],
    ["Shipping Charge", { "Shipping Charge": "free" }],
    ["Balance Due", { "Balance Due": "n/a" }],
    ["Item Price", { "Item Price": "12abc" }],
    ["Discount Amount", { "Discount Amount": "abc" }],
    ["Item Total", { "Item Total": "9.9.9" }],
  ];

  it.each(BAD)(
    "(a) a present unparseable %s skips the invoice and writes nothing",
    async (col, over) => {
      const r = await run(csv(over));
      expect(r.imported).toBe(0);
      expect(r.skipped).toBe(1);
      expect(r.errors).toHaveLength(1);
      expect(r.errors[0]).toContain(`${col}: not a number`);
      expect(prisma.invoice.create).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    },
  );

  it("(a) a bad cell on a LATER line row skips the whole invoice group", async () => {
    const r = await run(csv({}, [{ "Item Name": "Gadget", "Item Price": "abc" }]));
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(0);
    expect(r.errors[0]).toContain("Item Price: not a number");
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("(a) a value beyond the Decimal(10,2) column is a bad cell too", async () => {
    const r = await run(csv({ Total: "999999999.99" }));
    expect(r.skipped).toBe(1);
    expect(r.errors[0]).toContain("Total:");
    expect(prisma.invoice.create).not.toHaveBeenCalled();
  });

  it("(b) blank cells keep today's defaults", async () => {
    const r = await run(
      csv({
        Total: "",
        SubTotal: "",
        "Entity Discount Amount": "",
        "Shipping Charge": "",
        "Balance Due": "",
        "Item Price": "",
        "Discount Amount": "",
        "Item Total": "",
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.imported).toBe(1);
    const d = created[0];
    expect([d.total, d.subtotal, d.discount, d.shippingFee]).toEqual([0, 0, 0, 0]);
    expect(d.items.create[0]).toMatchObject({ unitPrice: 0, discount: 0, subtotal: 0 });
  });

  it("(b) blank SubTotal falls back to Total; blank Item Total falls back to qty*price-discount", async () => {
    const r = await run(csv({ SubTotal: "", "Item Total": "", "Discount Amount": "5" }));
    expect(r.errors).toEqual([]);
    expect(created[0].subtotal).toBe(100);
    expect(created[0].items.create[0].subtotal).toBe(95);
  });

  it("(b) blank Balance Due stays absent: status follows the label, no synthetic payment", async () => {
    const r = await run(csv({ "Balance Due": "", "Invoice Status": "Paid" }));
    expect(r.imported).toBe(1);
    expect(prisma.invoicePayment.create.mock.calls[0][0].data.amount).toBe(100);
  });

  it("(c) valid formatted cells still import", async () => {
    const r = await run(
      csv({
        Total: "$1,234.50",
        SubTotal: "$1,234.50",
        "Entity Discount Amount": "$10.00",
        "Shipping Charge": "$5.00",
        "Balance Due": "$1,234.50",
        "Item Price": "$617.25",
        "Discount Amount": "$0.00",
        "Item Total": "$1,234.50",
      }),
    );
    expect(r.errors).toEqual([]);
    expect(r.imported).toBe(1);
    const d = created[0];
    expect([d.total, d.subtotal, d.discount, d.shippingFee]).toEqual([1234.5, 1234.5, 10, 5]);
    expect(d.items.create[0]).toMatchObject({ unitPrice: 617.25, subtotal: 1234.5 });
  });

  it("(c) a NEGATIVE money cell is legitimate (credit-like) and imports", async () => {
    const r = await run(csv({ "Entity Discount Amount": "-5.00", "Item Total": "-20" }));
    expect(r.errors).toEqual([]);
    expect(r.imported).toBe(1);
    expect(created[0].discount).toBe(-5);
    expect(created[0].items.create[0].subtotal).toBe(-20);
  });

  it("a good invoice in the same file still imports when another is skipped", async () => {
    const text = csv({ "Invoice Number": "INV-1", Total: "abc" }, [
      { "Invoice Number": "INV-2", Total: "50" },
    ]);
    const r = await run(text);
    expect(r.skipped).toBe(1);
    expect(r.imported).toBe(1);
    expect(created).toHaveLength(1);
    expect(created[0].invoiceNumber).toBe("INV-2");
  });
});
