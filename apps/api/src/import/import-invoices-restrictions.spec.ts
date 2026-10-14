import * as fs from "fs";
import * as path from "path";
/**
 * F-05 (#2093, owner ruling 2026-09-25; row 510 ruling 2026-10-13): historical invoice IMPORT is EXEMPT. Every row
 * imports (never refused, never skipped for a restriction) even when a line is banned today. The run gets a visible
 * flag (`result.restrictedLines`), ONE run-level audit row, and (row 510) the breached catalog lines are MARKED: the
 * invoice item carries the fixed `Imported (historical)` reason, the importing user, the time and ALL the rule ids
 * matched, with one `selling_restriction.overridden` audit row per marked line in the same transaction.
 * Mirrors the split test's shape (invoices.service.spec.ts).
 */
import { Test } from "@nestjs/testing";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductsService } from "../products/products.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RESTRICTION_OVERRIDE_IMPORTED_REASON } from "../selling-restrictions/override-constants";

describe("ImportService.importInvoices — historical import is exempt, marked and audited (F-05 #2093, row 510)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictions: { judgeStaffWrite: jest.Mock };

  const csv = (invNo: string) =>
    Buffer.from(
      "Invoice Number,Customer Name,Total,SubTotal,Item Name,SKU,Quantity,Item Price\n" +
        `${invNo},Acme Co,10,10,Widget,SKU-TOB,1,10\n`,
    );
  const allow = { outcome: "ALLOW", reasons: [], breaches: [], basis: "CUSTOMER" };
  const block = {
    outcome: "BLOCK",
    reasons: [{ productId: "p-tob", productName: "Cigs", ruleId: "r1", message: "no CA" }],
    breaches: [
      {
        productId: "p-tob",
        productName: "Cigs",
        outcome: "BLOCK",
        ruleIds: ["r2", "r1"],
        rules: [],
        unknownProduct: false,
        state: "CA",
      },
    ],
    basis: "CUSTOMER",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.invoice.findFirst.mockResolvedValue(null); // no existing invoice with this number
    prisma.product.findFirst.mockResolvedValue({ id: "p-tob" }); // SKU match
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "inv-1", ...args.data }),
    );
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "ii-1" }]);
    prisma.invoiceItem.updateMany.mockResolvedValue({ count: 1 });
    restrictions = { judgeStaffWrite: jest.fn().mockResolvedValue(allow) };

    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: {} },
        {
          provide: CustomersService,
          useValue: { maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        {
          provide: ExternalRefService,
          useValue: { findLocalId: jest.fn().mockResolvedValue(null), record: jest.fn() },
        },
        { provide: ProductsService, useValue: {} },
        { provide: SellingRestrictionsService, useValue: restrictions },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  it("imports the row (never refused), flags it, MARKS the item with the imported reason and audits it", async () => {
    restrictions.judgeStaffWrite.mockResolvedValue(block);

    const result = await service.importInvoices(csv("INV-200"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toEqual([]);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1); // the row still imports, unchanged
    expect(result.restrictedLines).toEqual([
      { invoiceNumber: "INV-200", productId: "p-tob", productName: "Cigs", message: "no CA" },
    ]);
    // the marker: fixed reason, the importing user, a time, and ALL the rules matched (sorted)
    expect(prisma.invoiceItem.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.invoiceItem.updateMany.mock.calls[0][0]).toEqual({
      where: { id: { in: ["ii-1"] }, invoiceId: "inv-1" },
      data: {
        restrictionOverrideReason: RESTRICTION_OVERRIDE_IMPORTED_REASON,
        restrictionOverrideBy: "user-1",
        restrictionOverrideAt: expect.any(Date),
        restrictionOverrideRuleIds: ["r1:CA", "r2:CA"],
      },
    });
    expect(RESTRICTION_OVERRIDE_IMPORTED_REASON).toBe("Imported (historical)");
    // the audit: one overridden row for the line + the run-level row
    const audits = prisma.auditLog.create.mock.calls.map((c: any) => c[0].data);
    expect(audits).toHaveLength(2);
    expect(audits.find((a: any) => a.action === "selling_restriction.overridden")).toMatchObject({
      userId: "user-1",
      entityType: "InvoiceItem",
      entityId: "ii-1",
      meta: {
        documentType: "INVOICE",
        documentId: "inv-1",
        productId: "p-tob",
        ruleIds: ["r1:CA", "r2:CA"],
        reason: "Imported (historical)",
        warningHash: null,
      },
    });
    expect(audits.find((a: any) => a.action === "invoice.import.restricted_lines")).toMatchObject({
      meta: { invoiceNumbers: ["INV-200"], productIds: ["p-tob"] },
    });
  });

  it("the marker stores each rule at the state it was matched at: an unresolved customer state is ruleId:UNKNOWN", async () => {
    restrictions.judgeStaffWrite.mockResolvedValue({
      ...block,
      outcome: "INDETERMINATE",
      breaches: [{ ...block.breaches[0], outcome: "INDETERMINATE", state: null }],
    });

    await service.importInvoices(csv("INV-204"), "user-1");

    expect(prisma.invoiceItem.updateMany.mock.calls[0][0].data.restrictionOverrideRuleIds).toEqual([
      "r1:UNKNOWN",
      "r2:UNKNOWN",
    ]);
    const overridden = prisma.auditLog.create.mock.calls
      .map((c: any) => c[0].data)
      .find((a: any) => a.action === "selling_restriction.overridden");
    expect(overridden.meta.ruleIds).toEqual(["r1:UNKNOWN", "r2:UNKNOWN"]);
  });

  it("ALLOW imports normally: empty restrictedLines, no marker, no audit row", async () => {
    const result = await service.importInvoices(csv("INV-201"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.restrictedLines).toEqual([]);
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a failing restrictions check never blocks the import: the row still lands, unmarked", async () => {
    restrictions.judgeStaffWrite.mockRejectedValue(new Error("db down"));

    const result = await service.importInvoices(csv("INV-202"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.restrictedLines).toEqual([]);
    expect(prisma.invoiceItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a failing MARK write never blocks the import: the line is still flagged in the report", async () => {
    restrictions.judgeStaffWrite.mockResolvedValue(block);
    prisma.invoiceItem.updateMany.mockRejectedValue(new Error("write failed"));

    const result = await service.importInvoices(csv("INV-203"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.restrictedLines).toHaveLength(1);
  });

  it("batches the check ONCE per customer, not once per row (two invoices, same customer)", async () => {
    prisma.invoice.create
      .mockImplementationOnce((args: any) => Promise.resolve({ id: "inv-1", ...args.data }))
      .mockImplementationOnce((args: any) => Promise.resolve({ id: "inv-2", ...args.data }));

    const twoRows = Buffer.from(
      "Invoice Number,Customer Name,Total,SubTotal,Item Name,SKU,Quantity,Item Price\n" +
        "INV-300,Acme Co,10,10,Widget,SKU-TOB,1,10\n" +
        "INV-301,Acme Co,10,10,Widget,SKU-TOB,1,10\n",
    );

    const result = await service.importInvoices(twoRows, "user-1");

    expect(result.imported).toBe(2);
    expect(restrictions.judgeStaffWrite).toHaveBeenCalledTimes(1);
  });
});

/**
 * Which import path is which (row 510 ruling Q3). `importInvoices` is the ONLY import that writes a customer sale and
 * it is HISTORICAL (exempt, marked). No other import creates an order or an invoice, so there is no "import of NEW
 * sales" that could refuse a breached row; adding one must fail this pin until it is classified.
 */
describe("import paths: only importInvoices writes a customer sale", () => {
  const dir = __dirname;
  const read = (f: string) => fs.readFileSync(path.join(dir, f), "utf8");
  const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(f));

  it("no import file other than import.service.ts creates an order, an invoice or their lines", () => {
    const writers = files.filter((f) =>
      /\b(?:order|orderItem|invoice|invoiceItem)\.(?:create|createMany|update)\b|\bcreateSale\b|invoicesService\.create|ordersService\.create/.test(
        code(read(f)),
      ),
    );
    expect(writers).toEqual(["import.service.ts"]);
  });

  it("inside import.service.ts only importInvoices creates an invoice, and no import creates an order", () => {
    const src = code(read("import.service.ts"));
    expect(src).not.toMatch(/\b(?:order|orderItem)\.create\b|\bcreateSale\b/);
    const methods = [...src.matchAll(/\n  async (\w+)\(/g)].map((m) => ({
      name: m[1],
      at: m.index as number,
    }));
    const creators = [...src.matchAll(/\binvoice\.create\b/g)].map((m) => {
      const owner = [...methods].reverse().find((x) => x.at < (m.index as number));
      return owner?.name;
    });
    expect([...new Set(creators)]).toEqual(["importInvoices"]);
  });

  it("the historical import never refuses on a restriction: no 409 or ImportRowRefused near the marker", () => {
    const src = code(read("import-restriction-marker.ts"));
    expect(src).not.toMatch(/ConflictException|ImportRowRefused|throw /);
  });
});
