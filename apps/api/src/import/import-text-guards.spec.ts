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

  it("a formula-led Shipping Code is refused as ZIP code when the row has a shipping address to write", async () => {
    const res = await service.importContacts(
      Buffer.from("Customer Name,Shipping Address,Shipping Code\nBad Co,1 Dock St,@SUM(A1)\n"),
      "user-1",
    );
    expect(res.created).toBe(0);
    expect(
      res.errors.some((e: string) =>
        e.endsWith("ZIP code can't start with =, +, -, @ or a tab/line break"),
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

  it("(lead Opus r2) shipping == billing writes no shipping row, so a stored legacy billing row is not refused on re-import", async () => {
    prisma.customer.findMany.mockResolvedValue([
      existingCustomer([
        { addressType: "BILLING", line1: "=LEGACY", city: "=LEGACY", state: "TX", zip: "78701" },
      ]),
    ]);
    const res = await service.importContacts(
      Buffer.from(
        "Customer Name,Billing Address,Billing City,Shipping Address,Shipping City\nAcme,=LEGACY,=LEGACY,=LEGACY,=LEGACY\n",
      ),
      "user-1",
    );
    expect(res.errors.filter((e: string) => /can't start with/.test(e))).toEqual([]);
    expect(res.skipped).toBe(0);
  });

  describe("person names (B984)", () => {
    it("a formula-led Salutation is refused as 'Salutation' for a NEW customer: nothing is written", async () => {
      const res = await service.importContacts(
        Buffer.from("Customer Name,Salutation\nBad Co,=HYPERLINK(1)\n"),
        "user-1",
      );
      expect(res.created).toBe(0);
      expect(res.skipped).toBe(1);
      expect(
        res.errors.some((e: string) =>
          e.endsWith("Salutation can't start with =, +, -, @ or a tab/line break"),
        ),
      ).toBe(true);
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    // The row's contact name is DERIVED from first + last, so B956's name guard already refuses a bad first/last name for a new
    // customer (with its own wording); the pin here is that the ROW is refused and nothing is written.
    it.each(["First Name", "Last Name"])(
      "a formula-led %s refuses the row for a NEW customer: nothing is written",
      async (column) => {
        const res = await service.importContacts(
          Buffer.from(`Customer Name,${column}\nBad Co,=HYPERLINK(1)\n`),
          "user-1",
        );
        expect(res.created).toBe(0);
        expect(res.skipped).toBe(1);
        expect(res.errors.some((e: string) => /start with/.test(e))).toBe(true);
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );

    it("a good row alongside a bad one still imports (row-level rejection)", async () => {
      const res = await service.importContacts(
        Buffer.from("Customer Name,First Name\nBad Co,@cmd\nGood Co,Jo\n"),
        "user-1",
      );
      expect(res.created).toBe(1);
      expect(res.skipped).toBe(1);
    });

    it("change-only: an existing customer whose stored firstName is formula-led and that already has a contact is NOT refused for echoing it", async () => {
      prisma.customer.findMany.mockResolvedValue([
        {
          ...existingCustomer([]),
          contactName: "=LEGACY",
          firstName: "=LEGACY",
          contactPersons: [{ id: "cp-1" }],
        },
      ]);
      const res = await service.importContacts(
        Buffer.from("Customer Name,First Name\nAcme,=LEGACY\n"),
        "user-1",
      );
      expect(res.errors.filter((e: string) => /can't start with/.test(e))).toEqual([]);
      expect(res.skipped).toBe(0);
    });

    it("B984 (Opus): an existing customer with NO contact is checked ONLY when a contact will be created: a legacy salutation echo without a first/last name is not refused", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { ...existingCustomer([]), salutation: "=LEGACY", contactPersons: [] },
      ]);
      const res = await service.importContacts(
        Buffer.from("Customer Name,Salutation\nAcme,=LEGACY\n"),
        "user-1",
      );
      expect(res.errors.filter((e: string) => /can't start with/.test(e))).toEqual([]);
      expect(res.skipped).toBe(0);
    });

    it("an existing customer with NO contact would get the CSV name written into a NEW ContactPerson: refused even if the customer's own copy matches", async () => {
      prisma.customer.findMany.mockResolvedValue([
        {
          ...existingCustomer([]),
          contactName: "=LEGACY",
          firstName: "=LEGACY",
          contactPersons: [],
        },
      ]);
      const res = await service.importContacts(
        Buffer.from("Customer Name,First Name\nAcme,=LEGACY\n"),
        "user-1",
      );
      expect(res.skipped).toBe(1);
      expect(
        res.errors.some((e: string) =>
          e.endsWith("First name can't start with =, +, -, @ or a tab/line break"),
        ),
      ).toBe(true);
    });
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

  describe("importInventory (Zoho stock CSV): product names (B964-2)", () => {
    it("rejects a NEW product whose name is formula-led (readable row error) and still creates the good one", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.create.mockResolvedValue({ id: "p-new" });
      const res = await service.importInventory(
        Buffer.from("Item Name,SKU,Closing Stock\n=HYPERLINK(1),,5\nCola,,5\n"),
        "user-1",
      );
      expect(res.created).toBe(1);
      expect(res.skipped).toBe(1);
      expect(res.errors).toEqual([
        "=HYPERLINK(1): Product name can't start with =, +, -, @ or a tab/line break",
      ]);
    });

    it("an EXISTING product with a legacy formula-led name still gets its stock synced (only its stock is written)", async () => {
      prisma.product.findFirst.mockResolvedValue({ id: "p-1", name: "=LEGACY", currentStock: 1 });
      prisma.product.update.mockResolvedValue({ id: "p-1" });
      const res = await service.importInventory(
        Buffer.from("Item Name,SKU,Closing Stock\n=LEGACY,,9\n"),
        "user-1",
      );
      expect(res.errors).toEqual([]);
      expect(res.updated).toBe(1);
    });
  });
});
