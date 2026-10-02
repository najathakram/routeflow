/**
 * B956: the contacts and invoices importers reject a customer row whose NAME starts with
 * = + - @ TAB CR LF (the ONE shared guard, customer-name-guard.ts), with the readable message. A bad
 * row never aborts the batch and never half-writes; good rows in the same file still import.
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

describe("ImportService — formula-led customer names (B956)", () => {
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

  const MSG = "businessName must not start with = + - @ or a tab/line break";

  it("importContacts rejects the bad row with the readable message and still imports the good one", async () => {
    const res = await service.importContacts(
      Buffer.from("Customer Name\n=HYPERLINK(1)\nAcme Supply\n-2+3+cmd|' /C calc'!A0\n"),
      "user-1",
    );

    expect(res.created).toBe(1);
    expect(res.skipped).toBe(2);
    expect(res.errors.filter((e: string) => e.endsWith(MSG))).toHaveLength(2);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1); // only the good row wrote
  });

  it("importContacts: a numeric-only name (a phone-like value) is not a formula and imports", async () => {
    const res = await service.importContacts(
      Buffer.from('Customer Name\n"+1 555 123 4567"\n'),
      "user-1",
    );
    expect(res.created).toBe(1);
    expect(res.errors).toEqual([]);
  });

  it("importContacts: an unchanged legacy formula-led name still updates its row (change-only)", async () => {
    prisma.customer.findMany.mockResolvedValue([
      {
        id: "cust-1",
        businessName: "=LEGACY",
        contactName: "=LEGACY",
        displayName: null,
        zohoContactId: null,
        addresses: [],
        contactPersons: [],
      },
    ]);
    const res = await service.importContacts(
      Buffer.from("Customer Name,Phone\n=LEGACY,555\n"),
      "user-1",
    );
    expect(res.errors.filter((e: string) => e.endsWith(MSG))).toEqual([]);
  });

  it("importInvoices rejects a formula-led auto-created customer name before any user or customer write", async () => {
    const res = await service.importInvoices(
      Buffer.from("Invoice Number,Customer Name,Total\nINV-1,=EVIL(1),10\n"),
      "user-1",
    );

    expect(res.errors.some((e: string) => e.endsWith(MSG))).toBe(true);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
