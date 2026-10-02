/**
 * B964-1: the contacts and invoices importers reject a row whose ADDRESS (billing/shipping line, city, state, ZIP) or tobacco
 * LICENSE number starts with = + - @ TAB CR LF (common/text-cell-guards.ts), with the readable label message. A bad row never
 * aborts the batch and never half-writes; good rows in the same file still import.
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

describe("ImportService — formula-led addresses and license numbers (B964-1)", () => {
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

  const CITY_MSG = "City can't start with =, +, -, @ or a tab/line break";

  it("importContacts rejects a row with a formula-led billing city, imports the good row, writes nothing for the bad one", async () => {
    const res = await service.importContacts(
      Buffer.from(
        "Customer Name,Billing Address,Billing City,Billing State,Billing Code\n" +
          "Bad Co,12 Main St,=cmd|' /C calc'!A0,TX,78701\n" +
          "Good Co,12 Main St,Austin,TX,78701\n",
      ),
      "user-1",
    );
    expect(res.created).toBe(1);
    expect(res.skipped).toBe(1);
    expect(res.errors.filter((e: string) => e.endsWith(CITY_MSG))).toHaveLength(1);
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Billing Address", "Address line 1"],
    ["Shipping Address", "Address line 1"],
    ["Shipping City", "City"],
    ["Shipping Code", "ZIP code"],
  ])("a formula-led %s is refused as %s", async (column, label) => {
    const res = await service.importContacts(
      Buffer.from(`Customer Name,${column}\nBad Co,@SUM(A1)\n`),
      "user-1",
    );
    expect(res.created).toBe(0);
    expect(
      res.errors.some((e: string) =>
        e.endsWith(`${label} can't start with =, +, -, @ or a tab/line break`),
      ),
    ).toBe(true);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("a ZIP+4 and an ordinary address import fine", async () => {
    const res = await service.importContacts(
      Buffer.from(
        "Customer Name,Billing Address,Billing City,Billing Code\nAcme,1 Main,Austin,78701-1234\n",
      ),
      "user-1",
    );
    expect(res.created).toBe(1);
    expect(res.errors).toEqual([]);
  });

  const existingCustomer = (addresses: unknown[]) => ({
    id: "cust-1",
    businessName: "Acme",
    contactName: "Acme",
    displayName: null,
    zohoContactId: null,
    tobaccoLicenseNo: null,
    addresses,
    contactPersons: [],
  });

  it("(lead Opus 1) change-only: an EXISTING customer that already HAS a billing address is not refused for a formula-led billing cell the importer would never write", async () => {
    prisma.customer.findMany.mockResolvedValue([
      existingCustomer([
        { addressType: "BILLING", line1: "=LEGACY", city: "=LEGACY", state: "TX", zip: "78701" },
      ]),
    ]);
    const res = await service.importContacts(
      Buffer.from("Customer Name,Billing Address,Billing City\nAcme,=LEGACY,=LEGACY\n"),
      "user-1",
    );
    expect(res.errors.filter((e: string) => /can't start with/.test(e))).toEqual([]);
    expect(res.skipped).toBe(0);
  });

  it("(lead Opus 1) the same existing customer WITHOUT a billing address IS refused: that cell WOULD be written", async () => {
    prisma.customer.findMany.mockResolvedValue([existingCustomer([])]);
    const res = await service.importContacts(
      Buffer.from("Customer Name,Billing Address,Billing City\nAcme,@x,Austin\n"),
      "user-1",
    );
    expect(
      res.errors.some((e: string) =>
        e.endsWith("Address line 1 can't start with =, +, -, @ or a tab/line break"),
      ),
    ).toBe(true);
  });

  it("(lead Opus 1) a formula-led SHIPPING cell is ignored when the customer already has a shipping address", async () => {
    prisma.customer.findMany.mockResolvedValue([
      existingCustomer([
        { addressType: "BILLING", line1: "1 Main", city: "Austin", state: "TX", zip: "78701" },
        { addressType: "SHIPPING", line1: "=LEGACY", city: "Dallas", state: "TX", zip: "75001" },
      ]),
    ]);
    const res = await service.importContacts(
      Buffer.from("Customer Name,Shipping Address,Shipping City\nAcme,=LEGACY,Dallas\n"),
      "user-1",
    );
    expect(res.errors.filter((e: string) => /can't start with/.test(e))).toEqual([]);
  });

  it("a formula-led Tobacco Licence No rejects the row with the readable label", async () => {
    const res = await service.importContacts(
      Buffer.from("Customer Name,Tobacco Licence No\nBad Co,=1+1\n"),
      "user-1",
    );
    expect(res.created).toBe(0);
    expect(
      res.errors.some((e: string) =>
        e.endsWith("Tobacco license number can't start with =, +, -, @ or a tab/line break"),
      ),
    ).toBe(true);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  it("importContacts: an UNCHANGED legacy formula-led license on an existing customer does not reject the row (change-only)", async () => {
    prisma.customer.findMany.mockResolvedValue([
      {
        id: "cust-1",
        businessName: "Acme",
        contactName: "Acme",
        displayName: null,
        tobaccoLicenseNo: "=LEGACY",
        zohoContactId: null,
        addresses: [],
        contactPersons: [],
      },
    ]);
    const res = await service.importContacts(
      Buffer.from("Customer Name,Tobacco Licence No\nAcme,=LEGACY\n"),
      "user-1",
    );
    expect(res.errors.filter((e: string) => /Tobacco license number can't start/.test(e))).toEqual(
      [],
    );
  });

  it("importInvoices rejects an invoice group whose auto-created customer's street/city/ZIP is formula-led, before any write", async () => {
    const res = await service.importInvoices(
      Buffer.from("Invoice Number,Customer Name,Total,Billing City\nINV-1,Acme,10,=EVIL(1)\n"),
      "user-1",
    );
    expect(res.errors.some((e: string) => e.endsWith(CITY_MSG))).toBe(true);
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});
