/**
 * F-05 (#2093, owner ruling 2026-09-25): historical invoice IMPORT is EXEMPT — every row imports
 * UNCHANGED (never skipped, never modified) even when a line is banned today; the run only gets
 * a visible flag (`result.restrictedLines`) plus ONE audit row for the whole run, written outside
 * any per-invoice transaction. Mirrors the split test's shape (invoices.service.spec.ts).
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

describe("ImportService.importInvoices — restricted-lines flag (F-05 #2093)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let restrictions: { checkLinesSellable: jest.Mock };

  const csv = (invNo: string) =>
    Buffer.from(
      "Invoice Number,Customer Name,Total,SubTotal,Item Name,SKU,Quantity,Item Price\n" +
        `${invNo},Acme Co,10,10,Widget,SKU-TOB,1,10\n`,
    );

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-1" });
    prisma.invoice.findFirst.mockResolvedValue(null); // no existing invoice with this number
    prisma.product.findFirst.mockResolvedValue({ id: "p-tob" }); // SKU match
    prisma.invoice.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "inv-1", ...args.data }),
    );
    restrictions = {
      checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
    };

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

  it("imports the row UNCHANGED and flags it; writes ONE audit row for the run", async () => {
    restrictions.checkLinesSellable.mockResolvedValue({
      outcome: "BLOCK",
      reasons: [{ productId: "p-tob", productName: "Cigs", ruleId: "r1", message: "no CA" }],
    });

    const result = await service.importInvoices(csv("INV-200"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect(prisma.invoice.create).toHaveBeenCalledTimes(1); // the row still imports
    expect(result.restrictedLines).toEqual([
      { invoiceNumber: "INV-200", productId: "p-tob", productName: "Cigs", message: "no CA" },
    ]);
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
      action: "invoice.import.restricted_lines",
      meta: { invoiceNumbers: ["INV-200"], productIds: ["p-tob"] },
    });
  });

  it("ALLOW imports normally with an empty restrictedLines and no audit row", async () => {
    const result = await service.importInvoices(csv("INV-201"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.restrictedLines).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("a failing restrictions check never blocks the import — the row still lands, unflagged", async () => {
    restrictions.checkLinesSellable.mockRejectedValue(new Error("db down"));

    const result = await service.importInvoices(csv("INV-202"), "user-1");

    expect(result.imported).toBe(1);
    expect(result.restrictedLines).toEqual([]);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
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
    expect(restrictions.checkLinesSellable).toHaveBeenCalledTimes(1);
  });
});
