/**
 * The invoice CSV import never matches the tenant's walk-in customer by name: a row that names it is
 * skipped with a row error, no invoice is written for it, and the other rows still import.
 */
import { Test } from "@nestjs/testing";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

describe("ImportService.importInvoices: the walk-in customer is never matched", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let customers: {
    assertCustomerCapNotExceeded: jest.Mock;
    maybeStartCustomerGrace: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
      // B858/B859 harness note: not yet called by ImportService (RC1) — added so this mock is
      // ready for FIX2's commercial-column update path.
      update: jest.fn().mockResolvedValue({ id: "cust-1" }),
    };
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        { provide: CustomersService, useValue: customers },
        // Harness: ImportService injects NumberingService (B267/B269);
        // these suites never exercise a mint, so the mock only satisfies DI.
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") },
        },
        // Harness: ImportService injects ExternalRefService (B268/D4 re-import
        // idempotency for source-numberless rows). Mocked at the module boundary;
        // `findLocalId` → null means "never imported before", the state every
        // suite here assumes.
        {
          provide: ExternalRefService,
          useValue: {
            findLocalId: jest.fn().mockResolvedValue(null),
            record: jest.fn().mockResolvedValue(undefined),
          },
        },
        // B858/B859 harness note: not yet consumed by ImportService's constructor (RC1) — added
        // here so this module keeps compiling once FIX2 wires them in.
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
        { provide: AuditService, useValue: { log: jest.fn().mockResolvedValue(undefined) } },
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

  const WALK_IN = {
    id: "walk-1",
    businessName: "Counter Sales",
    zohoContactId: "ZC-1",
    isWalkIn: true,
    deletedAt: null,
  };
  const RESERVED = "Row 1 skipped: this name is reserved for walk-in sales.";

  beforeEach(() => {
    // The walk-in lookup finds it; an ordinary customer query carrying the isWalkIn exclusion does not.
    prisma.customer.findFirst.mockImplementation((async (args: any) =>
      args?.where?.isWalkIn === true
        ? WALK_IN
        : JSON.stringify(args?.where ?? {}).includes("isWalkIn")
          ? null
          : { id: "walk-1", businessName: "Counter Sales", isWalkIn: true }) as any);
  });

  it("a row naming the walk-in is skipped with a row error and writes no invoice", async () => {
    const res: any = await service.importInvoices(
      Buffer.from(
        "Invoice Number,Customer Name,Total\nINV-1,counter  sales,10\nINV-2,Acme Supply,20\n",
      ),
      "user-1",
    );

    expect(res.errors).toContain(RESERVED);
    expect(res.skipped).toBe(1);
    expect(res.imported).toBe(1);
    expect(prisma.customer.update).not.toHaveBeenCalled();
    const invoiceCustomers = JSON.stringify(
      [...prisma.invoice.create.mock.calls, ...prisma.tenantTransaction.mock.calls].map(
        (c) => c[0],
      ),
    );
    expect(invoiceCustomers).not.toContain("walk-1");
    expect(customers.maybeStartCustomerGrace).toHaveBeenCalledTimes(1);
  });
});
