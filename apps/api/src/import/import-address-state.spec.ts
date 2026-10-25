import { Test } from "@nestjs/testing";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * F4 — a contacts CSV writes CustomerAddress rows through `ImportService.importContacts`; the
 * restrictions engine reads ONLY `stateCode`, so each row must carry the derived columns (a batch
 * of imported customers with NULL codes is INDETERMINATE for every state-rule product). Harness as
 * `import-customer-cap.spec.ts`.
 */
describe("ImportService.importContacts — address state columns (F4)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: {} },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: {} },
        {
          provide: ExternalRefService,
          useValue: { findLocalId: jest.fn().mockResolvedValue(null), record: jest.fn() },
        },
        // B858/B859 harness note: not yet consumed by ImportService's constructor (RC1) — added
        // here so this module keeps compiling once FIX2 wires them in. This spec doesn't touch
        // product/customer commercial fields, so no assertion changes.
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

  it("a new customer's billing and shipping addresses carry stateCode / stateNeedsReview", async () => {
    const csv = [
      "Customer Name,Billing Address,Billing City,Billing State,Billing Code,Shipping Address,Shipping City,Shipping State,Shipping Code",
      "Acme Supply,1 Congress Ave,Austin,Texas,78701,9 Dock Rd,Elsewhere,Tejas,00000",
    ].join("\n");

    const res = await service.importContacts(Buffer.from(csv), "user-1");

    expect(res.created).toBe(1);
    const rows = prisma.customerAddress.create.mock.calls.map((c: any) => c[0].data);
    expect(rows).toHaveLength(2);
    const byLabel = Object.fromEntries(rows.map((r: any) => [r.label, r]));
    expect(byLabel.Billing).toMatchObject({
      state: "Texas",
      stateCode: "TX",
      stateNeedsReview: false,
    });
    expect(byLabel.Shipping).toMatchObject({
      state: "Tejas",
      stateCode: null,
      stateNeedsReview: true,
    });
  });

  it("an ambiguous 'Washington' resolves only where a civilian zip confirms it (F5)", async () => {
    const csv = [
      "Customer Name,Billing Address,Billing City,Billing State,Billing Code,Shipping Address,Shipping City,Shipping State,Shipping Code",
      "Beta Foods,1 Pike St,Seattle,Washington,98101,2 Main St,Washington,Washington,20001",
    ].join("\n");

    await service.importContacts(Buffer.from(csv), "user-1");

    const rows = prisma.customerAddress.create.mock.calls.map((c: any) => c[0].data);
    const byLabel = Object.fromEntries(rows.map((r: any) => [r.label, r]));
    expect(byLabel.Billing).toMatchObject({ stateCode: "WA", stateNeedsReview: false });
    expect(byLabel.Shipping).toMatchObject({ stateCode: null, stateNeedsReview: true }); // a DC zip
  });
});
