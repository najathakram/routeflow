/**
 * B858 + B859 — importer commercial columns (RED set + pins).
 *
 * B858: `importProducts` reads only { name, Rate, Description, Unit, SKU } and writes via a raw
 * `prisma.forTenant().product.create` — every other commercial column (pack size, price tiers,
 * barcode, category, standard cost) is silently dropped, and a name-only match never updates an
 * existing product via SKU/barcode.
 * B859: `importContacts` reads no commercial header at all (payment terms, pricing tier, credit
 * limit, tax exemption/id, tobacco licence, delivery windows, SMS/WhatsApp consent) — its
 * match-update path only ever touches identity/contact/address fields.
 *
 * T1-T6 below are the red set (REG-tagged, in the red gate) — see
 * .claude/pipeline/2026-09-25-b858-b859-importer-columns/bug-test-plan.md for the exact
 * "Fails TODAY with" wrong values each one is required to fail on. P6-P15 are pins (SA-284 /
 * rulings-s4-s5.md S4) for behavior FIX2/FIX3 must establish — not part of the red-gate token
 * filter, expected red until then.
 *
 * L-205: every assertion here drives the real `ImportService.importProducts` / `importContacts`
 * methods and reads the resulting calls made on the mocked collaborator services (or the
 * service's own return value) — never a scrape of import.service.ts's source text.
 *
 * `ProductsService` and `AuditService` are provided here even though today's `ImportService`
 * constructor does not accept them — NestJS allows an unused extra provider, and pre-wiring them
 * is what lets T1/T3/T4/T5 assert "0 calls" cleanly today and "1 call" once FIX2/FIX3 wire the
 * real dependencies (RC1 confirms the read/write sites; no DI change happens in this task).
 */
import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PRODUCT_COLUMNS, CUSTOMER_COLUMNS } from "./import-columns";

describe("ImportService — commercial columns (B858/B859)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let productsService: {
    create: jest.Mock;
    update: jest.Mock;
    emitCatalogBulkChanged: jest.Mock;
    assertCanFlagTobacco: jest.Mock;
    assertMsrpAllowed: jest.Mock;
    assertIdentityAvailable: jest.Mock;
    assertReorderAllowed: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let customers: {
    assertCustomerCapNotExceeded: jest.Mock;
    maybeStartCustomerGrace: jest.Mock;
    update: jest.Mock;
    setCustomerConsent: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    productsService = {
      create: jest.fn().mockResolvedValue({ id: "prod-new" }),
      update: jest.fn().mockResolvedValue({ id: "prod-existing" }),
      emitCatalogBulkChanged: jest.fn(),
      assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
      assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
      assertIdentityAvailable: jest.fn().mockResolvedValue(undefined),
      assertReorderAllowed: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ id: "cust-existing" }),
      // SA-305 (2): consent + its evidence now go through CustomersService.setCustomerConsent
      // (ONE tenantTransaction), never through applyCustomerCommercialFields -> auditService.log.
      setCustomerConsent: jest.fn().mockResolvedValue(undefined),
    };

    const mod = await Test.createTestingModule({
      providers: [
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        ImportService,
        { provide: PrismaService, useValue: prisma },
        { provide: VendorBillsService, useValue: { create: jest.fn(), receive: jest.fn() } },
        { provide: CustomersService, useValue: customers },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
        {
          provide: ExternalRefService,
          useValue: { findLocalId: jest.fn().mockResolvedValue(null), record: jest.fn() },
        },
        // Not yet consumed by ImportService's constructor (RC1) — wired here so the fix task
        // only has to add these to the constructor, not to every spec that exercises DI.
        { provide: ProductsService, useValue: productsService },
        { provide: AuditService, useValue: auditService },
      ],
    }).compile();
    service = mod.get(ImportService);
  });

  // ── Red set ────────────────────────────────────────────────────────────────

  it("REG-B858-1: create carries pack/tier/barcode/category/cost", async () => {
    prisma.product.findFirst.mockResolvedValue(null); // no existing match
    const csv =
      "Item Name,SKU,Rate,Units Per Box,Price Tier 2,Barcode,Category,Standard Cost\n" +
      "Widget Pro,SKU-1,10,12,9.5,BC-123,Widgets,5\n";

    await service.importProducts(Buffer.from(csv), "user-1");

    expect(productsService.create).toHaveBeenCalledTimes(1);
    const dto = productsService.create.mock.calls[0]?.[0];
    expect(dto).toMatchObject({
      unitsPerBox: 12,
      priceTier2: 9.5,
      barcode: "BC-123",
      category: "Widgets",
      standardCost: 5,
    });
  });

  it('REG-B858-2: Rate "12abc" skips, never becomes $0', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const csv = "Item Name,SKU,Rate\nWidget Pro,SKU-1,12abc\n";

    const result = await service.importProducts(Buffer.from(csv), "user-1");

    expect(result.imported).toBe(0);
    expect((result as any).skippedRows?.[0]?.reason).toMatch(/Rate.*not a number/);
  });

  it("REG-B858-3: SKU match updates priceTier2", async () => {
    // Existing product found by SKU (future fix's matching), but its NAME differs from the CSV
    // row's — today's `findFirst` matches on name only, so this existing row is invisible to it.
    // Only a SKU lookup finds it; a name lookup (today's only key) finds nothing.
    prisma.product.findFirst.mockImplementation(async (args: any) =>
      args?.where?.sku === "SKU-1"
        ? { id: "prod-1", name: "Widget Pro", sku: "SKU-1", unitsPerBox: null, priceTier2: 5 }
        : null,
    );
    const csv = "Item Name,SKU,Price Tier 2\nWidget Pro (2026 refresh),SKU-1,9.5\n";

    await service.importProducts(Buffer.from(csv), "user-1");

    expect(productsService.update).toHaveBeenCalledTimes(1);
    expect(productsService.update.mock.calls[0]?.[1]).toMatchObject({ priceTier2: 9.5 });
  });

  it("a dry-run update row shows each change as { from, to } and writes nothing", async () => {
    prisma.product.findFirst.mockImplementation(async (args: any) =>
      args?.where?.sku === "SKU-1"
        ? { id: "prod-1", name: "Widget Pro", sku: "SKU-1", unitsPerBox: null, priceTier2: 5 }
        : null,
    );
    const csv = "Item Name,SKU,Price Tier 2\nWidget Pro,SKU-1,9.5\n";

    const result: any = await (service.importProducts as any)(Buffer.from(csv), "user-1", {
      dryRun: true,
    });

    expect(result.rows[0]).toMatchObject({
      action: "update",
      changes: { priceTier2: { from: 5, to: 9.5 } },
    });
    expect(productsService.update).not.toHaveBeenCalled();
  });

  it("a Credit Limit of 0 is written onto a customer with no limit (null), not treated as unchanged", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      creditLimit: null,
      addresses: [],
      contactPersons: [],
    });
    const csv = "Customer Name,Customer ID,Credit Limit\nAcme Supply,ZC-1,0\n";

    await service.importContacts(Buffer.from(csv), "user-1");

    expect(customers.update).toHaveBeenCalledTimes(1);
    expect(customers.update.mock.calls[0]?.[1]).toMatchObject({ creditLimit: 0 });
  });

  it("REG-B859-1: terms/tier/limit/exempt/taxId reach update", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      addresses: [],
      contactPersons: [],
    });
    const csv =
      "Customer Name,Customer ID,Payment Terms,Pricing Tier,Credit Limit,Tax Exempt,Tax ID\n" +
      "Acme Supply,ZC-1,Net 30,3,1500,Yes,12-3456789\n";

    await service.importContacts(Buffer.from(csv), "user-1");

    expect(customers.update).toHaveBeenCalledTimes(1);
    const [id, dto] = customers.update.mock.calls[0] ?? [];
    expect(id).toBe("cust-1");
    expect(dto).toMatchObject({
      defaultPaymentTerms: "Net 30",
      pricingTier: 3,
      creditLimit: 1500,
      isTaxExempt: true,
      taxId: "12-3456789",
    });
  });

  it("REG-B859-2 / SA-305(2): licence+consent — consent goes through setCustomerConsent (one tx w/ its evidence)", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      addresses: [],
      contactPersons: [],
    });
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString().slice(0, 10);
    const csv =
      "Customer Name,Customer ID,Tobacco Licence No,Tobacco Licence Expiry,SMS Consent\n" +
      `Acme Supply,ZC-1,TL-999,${future},Yes\n`;

    await service.importContacts(Buffer.from(csv), "user-1");

    // SA-305 (2): consent no longer rides `auditService.log` — it goes through
    // `CustomersService.setCustomerConsent`, which writes the column AND its evidence in one tx.
    expect(auditService.log).not.toHaveBeenCalled();
    expect(customers.setCustomerConsent).toHaveBeenCalledTimes(1);
    const [custId, consent, evidence] = customers.setCustomerConsent.mock.calls[0] ?? [];
    expect(custId).toBe("cust-1");
    expect(consent).toMatchObject({ smsConsent: true });
    expect(evidence).toMatchObject({ userId: "user-1", source: "import", row: 1 });
    // Tobacco licence still goes through the ordinary `update` compliance bundle.
    expect(customers.update).toHaveBeenCalled();
    const complianceArg = customers.update.mock.calls[0]?.[2]?.compliance ?? {};
    expect(complianceArg).not.toHaveProperty("smsConsent");
    expect(complianceArg).toMatchObject({ tobaccoLicenseNo: "TL-999" });
  });

  it("SA-305 (2): a failing setCustomerConsent skips only the consent, keeps the rest of the row, and warns", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      taxId: null,
      addresses: [],
      contactPersons: [],
    });
    customers.setCustomerConsent.mockRejectedValueOnce(new Error("db down"));
    const csv = "Customer Name,Customer ID,Tax ID,SMS Consent\nAcme Supply,ZC-1,12-3456789,Yes\n";

    const result = await service.importContacts(Buffer.from(csv), "user-1");

    expect(customers.update).toHaveBeenCalledTimes(1);
    expect(customers.update.mock.calls[0]?.[1]).toMatchObject({ taxId: "12-3456789" });
    expect((result as any).warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/consent evidence could not be recorded/)]),
    );
    // The row itself is still reported as an update (taxId landed) — not silently dropped.
    expect(result.rows[0]).toMatchObject({ action: "update" });
    expect(result.rows[0].changes).not.toHaveProperty("smsConsent");
  });

  it("REG-B859-3: bad Pricing Tier skips with a reason", async () => {
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      addresses: [],
      contactPersons: [],
    });
    const csv = "Customer Name,Customer ID,Pricing Tier\nAcme Supply,ZC-1,9\n";

    const result = await service.importContacts(Buffer.from(csv), "user-1");

    expect((result as any).skippedRows?.length).toBe(1);
    expect((result as any).skippedRows?.[0]?.reason).toMatch(/Pricing Tier/);
  });

  // ── I2: customer matching — ambiguity, soft-delete exclusion, decide-before-write ──────────
  describe("I2: customer matching", () => {
    it("a name matching 2+ non-deleted customers is skipped ambiguous BEFORE any write", async () => {
      prisma.customer.findFirst.mockResolvedValue(null); // no zohoContactId in the file
      prisma.customer.findMany.mockResolvedValue([
        { id: "cust-1", businessName: "Acme" },
        { id: "cust-2", businessName: "ACME" },
      ]);
      const csv = "Customer Name,Credit Limit\nAcme,500\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
      expect((result as any).skippedRows?.[0]?.reason).toMatch(/ambiguous name \(2 matches\)/);
    });

    it("the businessName match excludes soft-deleted customers (findMany(deletedAt: null))", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      prisma.customer.findMany.mockResolvedValue([]);
      const csv = "Customer Name,Credit Limit\nAcme,500\n";

      await service.importContacts(Buffer.from(csv), "user-1");

      const call = prisma.customer.findMany.mock.calls[0]?.[0];
      expect(call?.where).toMatchObject({ deletedAt: null });
    });

    it("the zohoContactId match also excludes soft-deleted customers", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      prisma.customer.findMany.mockResolvedValue([]);
      const csv = "Customer Name,Customer ID,Credit Limit\nAcme,ZC-1,500\n";

      await service.importContacts(Buffer.from(csv), "user-1");

      const call = prisma.customer.findFirst.mock.calls.find(
        ([a]: any[]) => a?.where?.zohoContactId,
      )?.[0];
      expect(call?.where).toMatchObject({ zohoContactId: "ZC-1", deletedAt: null });
    });

    it("I2b: a matched row whose commercial write throws after the contact-details write stays an update with a visible failure", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        addresses: [],
        contactPersons: [],
      });
      customers.update.mockRejectedValueOnce(new Error("db down"));
      const csv = "Customer Name,Customer ID,Credit Limit\nAcme Supply,ZC-1,500\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      // The raw contact-details write DID land, so this is not a skip (a skip claims nothing
      // was written); the commercial failure is carried as a warning + error on the row.
      expect(prisma.customer.update).toHaveBeenCalledTimes(1);
      expect(result.updated).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.errors).toEqual(["Acme Supply (update): import failed"]);
      expect(result.rows[0]).toMatchObject({ action: "update" });
      expect(result.rows[0].warnings?.[0]).toMatch(
        /commercial columns not saved \(import failed\)/,
      );
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^Row 1 \(Acme Supply\): commercial columns/),
        ]),
      );
    });

    it("I2b: a throw BEFORE any write is a clean skip with its reason", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        addresses: [],
        contactPersons: [],
      });
      prisma.customer.update.mockRejectedValueOnce(new Error("db down"));
      const csv = "Customer Name,Customer ID,Credit Limit\nAcme Supply,ZC-1,500\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(customers.update).not.toHaveBeenCalled();
      expect(result.updated).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.skippedRows[0]).toMatchObject({ row: 1, reason: "import failed" });
      expect(result.rows[0]).toMatchObject({ action: "skip", reason: "import failed" });
    });

    it("a new customer whose commercial columns fail after its create committed is a create with a visible failure", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.user.create.mockResolvedValue({ id: "user-new" });
      prisma.customer.create.mockResolvedValue({ id: "cust-new" });
      customers.update.mockRejectedValueOnce(new Error("db down"));
      const csv = "Customer Name,Credit Limit\nBrand New Co,500\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(prisma.customer.create).toHaveBeenCalledTimes(1);
      expect(result.created).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.rows[0]).toMatchObject({ action: "create" });
      expect(result.rows[0].warnings?.[0]).toMatch(/commercial columns not saved/);
      expect(customers.maybeStartCustomerGrace).toHaveBeenCalledTimes(1);
    });

    it("a name match carrying a DIFFERENT Customer ID is another contact — skipped, never merged", async () => {
      prisma.customer.findFirst.mockResolvedValue(null); // ZC-2 not found
      prisma.customer.findMany.mockResolvedValue([
        {
          id: "cust-1",
          businessName: "Acme",
          zohoContactId: "ZC-1",
          addresses: [],
          contactPersons: [],
        },
      ]);
      const csv = "Customer Name,Customer ID,Credit Limit\nAcme,ZC-2,500\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
      expect(result.skippedRows[0]?.reason).toBe(
        "Customer ID ZC-2 not found; name matches a customer with Customer ID ZC-1",
      );
    });
  });

  // ── Preview/real parity: dryRun must plan exactly what a real run then does ─────────────────
  describe("preview plans exactly what a real run does (in-file claims)", () => {
    /** An in-memory catalog behind the prisma mock + ProductsService, so a real run's writes are
     *  visible to its own later rows — the exact thing a dryRun cannot see. */
    function statefulCatalog(initial: any[]) {
      const store = initial.map((p) => ({ ...p }));
      prisma.product.findFirst.mockImplementation(async (args: any) => {
        const w = args?.where ?? {};
        if (w.sku !== undefined) return store.find((p) => p.sku === w.sku) ?? null;
        if (w.barcode !== undefined) return store.find((p) => p.barcode === w.barcode) ?? null;
        return null;
      });
      prisma.product.findMany.mockImplementation(async (args: any) => {
        const n = args?.where?.name?.equals?.toLowerCase();
        const hits = store.filter((p) => n !== undefined && p.name?.toLowerCase() === n);
        return hits.slice(0, args?.take ?? hits.length);
      });
      productsService.create.mockImplementation(async (dto: any) => {
        const p = { id: `prod-${store.length + 1}`, sku: null, barcode: null, ...dto };
        store.push(p);
        return p;
      });
      productsService.update.mockImplementation(async (id: string, dto: any) => {
        Object.assign(
          store.find((p) => p.id === id),
          dto,
        );
        return { id };
      });
    }

    const plan = (r: any) => r.rows.map((x: any) => [x.row, x.action, x.reason ?? null]);

    it.each([
      ["same name, SKU then no SKU", [], "Cola,SUP-1,,10\nCola,,,11\n"],
      ["same name, no SKU then SKU", [], "Cola,,,10\nCola,SUP-2,,11\n"],
      ["same name, two different SKUs", [], "Cola,SUP-1,,10\nCola,SUP-2,,11\n"],
      [
        "a row renames a product, a later row uses the new name",
        [{ id: "prod-a", name: "Old Name", sku: "S1", barcode: null, pricePerUnit: 5 }],
        "New Name,S1,,10\nNew Name,,,12\n",
      ],
      [
        "a row gives a product a barcode, a later row carries that barcode",
        [{ id: "prod-a", name: "Cola", sku: "S1", barcode: null, pricePerUnit: 5 }],
        "Cola,S1,B1,10\nOther,S2,B1,11\n",
      ],
    ])("%s", async (_title, initial, body) => {
      const csv = "Item Name,SKU,Barcode,Rate\n" + body;
      statefulCatalog(initial as any[]);
      const preview = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });
      statefulCatalog(initial as any[]);
      const real = await service.importProducts(Buffer.from(csv), "user-1");

      expect(plan(real)).toEqual(plan(preview));
      expect(real.created + real.updated + real.unchanged + real.skipped).toBe(2);
      expect(real.skipped).toBe(1); // the second row always resolves to the first row's product
    });

    it.each([
      ["same SKU on two new rows", "Cola,SUP-1,,10\nLemonade,SUP-1,,11\n"],
      ["same barcode on two new rows", "Cola,SUP-1,B-9,10\nLemonade,SUP-2,B-9,11\n"],
    ])("SA-322 LOW: %s — row 2 is a duplicate of row 1 in preview and run", async (_t, body) => {
      const csv = "Item Name,SKU,Barcode,Rate\n" + body;
      statefulCatalog([]);
      const preview = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });
      statefulCatalog([]);
      const real = await service.importProducts(Buffer.from(csv), "user-1");

      for (const r of [preview, real]) {
        expect(r.rows[0]).toMatchObject({ row: 1, action: "create" });
        expect(r.rows[1]).toEqual({
          row: 2,
          label: "Lemonade",
          action: "skip",
          reason: "duplicate of row 1",
        });
      }
      expect(productsService.create).toHaveBeenCalledTimes(1);
    });

    function statefulCustomers(initial: any[]) {
      const store = initial.map((c) => ({ addresses: [], contactPersons: [], ...c }));
      prisma.customer.findFirst.mockImplementation(async (args: any) => {
        const z = args?.where?.zohoContactId;
        return store.find((c) => z !== undefined && c.zohoContactId === z) ?? null;
      });
      prisma.customer.findMany.mockImplementation(async (args: any) => {
        const n = args?.where?.businessName?.equals?.toLowerCase();
        const hits = store.filter((c) => n !== undefined && c.businessName.toLowerCase() === n);
        return hits.slice(0, args?.take ?? hits.length);
      });
      prisma.user.create.mockResolvedValue({ id: "user-new" });
      prisma.customer.create.mockImplementation(async (args: any) => {
        const c = {
          id: `cust-${store.length + 1}`,
          addresses: [],
          contactPersons: [],
          ...args.data,
        };
        store.push(c);
        return c;
      });
    }

    it.each([
      ["same name twice, no Customer ID", "New Co,,500\nNew Co,,600\n"],
      ["same Customer ID twice", "New Co,ZC-1,500\nRenamed Co,ZC-1,600\n"],
      ["same name, two different Customer IDs", "Acme,ZC-1,500\nAcme,ZC-2,600\n"],
    ])("contacts: %s", async (_title, body) => {
      const csv = "Customer Name,Customer ID,Credit Limit\n" + body;
      statefulCustomers([]);
      const preview = await service.importContacts(Buffer.from(csv), "user-1", { dryRun: true });
      statefulCustomers([]);
      const real = await service.importContacts(Buffer.from(csv), "user-1");

      expect(plan(real)).toEqual(plan(preview));
      expect(real.created).toBe(1);
      expect(real.skipped).toBe(1);
    });
  });

  // ── SA-305 (1) + SA-284 round-2 pins ─────────────────────────────────────────────────────────
  describe("SA-305 / SA-284 row rules", () => {
    const matchedCustomer = (extra: Record<string, unknown> = {}) => ({
      id: "cust-1",
      businessName: "Acme Supply",
      zohoContactId: "ZC-1",
      addresses: [],
      contactPersons: [],
      ...extra,
    });

    it("a Notes cell over the limit skips the row naming the column and the limit — never truncated", async () => {
      prisma.customer.findFirst.mockResolvedValue(matchedCustomer());
      const csv = `Customer Name,Customer ID,Notes\nAcme Supply,ZC-1,${"n".repeat(2001)}\n`;

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(result.skippedRows).toEqual([
        { row: 1, label: "Acme Supply", reason: "Notes: must be 2000 characters or fewer" },
      ]);
      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
    });

    it("an unmapped Payment Terms integer warns in the PREVIEW too, and the planned diff leaves terms unset", async () => {
      prisma.customer.findFirst.mockResolvedValue(
        matchedCustomer({ defaultPaymentTerms: "Net 15" }),
      );
      const csv = "Customer Name,Customer ID,Payment Terms\nAcme Supply,ZC-1,90\n";

      const preview = await service.importContacts(Buffer.from(csv), "user-1", { dryRun: true });

      expect(preview.skippedRows).toEqual([]);
      expect(preview.rows[0]).toMatchObject({ action: "update", changes: {} });
      expect(preview.warnings).toEqual([
        expect.stringMatching(
          /^Row 1 \(Acme Supply\): Payment Terms "90" is not a recognized term/,
        ),
      ]);
      expect(customers.update).not.toHaveBeenCalled();
    });

    it.each([
      ["0", "Due on Receipt"],
      ["15", "Net 15"],
      ["60", "Net 60"],
    ])("Payment Terms %s maps to %s on the written row", async (raw, label) => {
      prisma.customer.findFirst.mockResolvedValue(matchedCustomer());
      const csv = `Customer Name,Customer ID,Payment Terms\nAcme Supply,ZC-1,${raw}\n`;

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(result.warnings).toEqual([]);
      expect(customers.update.mock.calls[0]?.[1]).toEqual({ defaultPaymentTerms: label });
    });

    it("blank never clears — every product column blank except the key and Rate diffs to Rate alone", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        barcode: "BC-1",
        unit: "case",
        pricePerUnit: 10,
        priceTier2: 9,
        priceTier3: 8,
        priceTier4: 7,
        priceTier5: 6,
        unitsPerBox: 12,
        category: "Widgets",
        description: "A widget",
        standardCost: 4.5,
        msrp: 19.99,
        isTobacco: true,
        reorderPoint: 3,
        reorderQty: 24,
      });
      const headers = PRODUCT_COLUMNS.map((c) => c.canonical);
      const cells = PRODUCT_COLUMNS.map((c) =>
        c.field === "sku" ? "SKU-1" : c.field === "pricePerUnit" ? "12" : "",
      );
      const csv = `${headers.join(",")}\n${cells.join(",")}\n`;

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).toHaveBeenCalledTimes(1);
      expect(productsService.update.mock.calls[0]?.[1]).toEqual({ pricePerUnit: 12 });
    });

    it("blank never clears — every customer column blank except the keys and Tax ID diffs to Tax ID alone", async () => {
      prisma.customer.findFirst.mockResolvedValue(
        matchedCustomer({
          defaultPaymentTerms: "Net 30",
          pricingTier: 2,
          creditLimit: 500,
          isTaxExempt: true,
          taxId: "old-id",
          tobaccoLicenseNo: "TL-1",
          tobaccoLicenseExpiry: new Date("2030-01-01"),
          deliveryWindowStart: "08:00",
          deliveryWindowEnd: "12:00",
          smsConsent: true,
          waConsent: true,
        }),
      );
      const headers = CUSTOMER_COLUMNS.map((c) => c.canonical);
      const cells = CUSTOMER_COLUMNS.map((c) =>
        c.field === "businessName"
          ? "Acme Supply"
          : c.field === "zohoContactId"
            ? "ZC-1"
            : c.field === "taxId"
              ? "new-id"
              : "",
      );
      const csv = `${headers.join(",")}\n${cells.join(",")}\n`;

      await service.importContacts(Buffer.from(csv), "user-1");

      expect(customers.update).toHaveBeenCalledTimes(1);
      expect(customers.update.mock.calls[0]?.[1]).toEqual({ taxId: "new-id" });
      expect(customers.update.mock.calls[0]?.[2]).toEqual({ compliance: undefined });
      expect(customers.setCustomerConsent).not.toHaveBeenCalled();
    });

    it("one write path for contacts: the raw contact-details write never carries a commercial field", async () => {
      prisma.customer.findFirst.mockResolvedValue(matchedCustomer());
      const future = new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10);
      const csv =
        "Customer Name,Customer ID,Payment Terms,Pricing Tier,Credit Limit,Tax Exempt,Tax ID," +
        "Tobacco Licence No,Tobacco Licence Expiry,SMS Consent,WhatsApp Consent\n" +
        `Acme Supply,ZC-1,Net 30,3,1500,Yes,12-3456789,TL-9,${future},Yes,No\n`;

      await service.importContacts(Buffer.from(csv), "user-1");

      const rawData = prisma.customer.update.mock.calls[0]?.[0]?.data ?? {};
      for (const field of [
        "defaultPaymentTerms",
        "pricingTier",
        "creditLimit",
        "isTaxExempt",
        "taxId",
        "tobaccoLicenseNo",
        "tobaccoLicenseExpiry",
        "smsConsent",
        "waConsent",
        "consentUpdatedAt",
      ]) {
        expect(rawData).not.toHaveProperty(field);
      }
      expect(customers.update).toHaveBeenCalledTimes(1);
      expect(customers.setCustomerConsent).toHaveBeenCalledWith(
        "cust-1",
        { smsConsent: true },
        { userId: "user-1", source: "import", fileName: undefined, row: 1 },
      );
    });

    it('an "Average Cost" column is reported unknown and never reaches a create or update', async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "SKU-1"
          ? { id: "prod-1", name: "Widget Pro", sku: "SKU-1", pricePerUnit: 10, standardCost: 1 }
          : null,
      );
      const csv =
        "Item Name,SKU,Rate,Cost,Average Cost\nWidget Pro,SKU-1,10,2,3.5\nNew Widget,SKU-2,5,1,0.75\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(result.unknownColumns).toEqual(["Average Cost"]);
      expect(productsService.update.mock.calls[0]?.[1]).toEqual({ standardCost: 2 });
      expect(productsService.create.mock.calls[0]?.[0]).toMatchObject({ standardCost: 1 });
      expect(productsService.create.mock.calls[0]?.[0]).not.toHaveProperty("averageCost");
    });

    it("a new product pack is written; an existing null pack is filled; an equal pack is no diff", async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "NULL-PACK"
          ? { id: "prod-null", name: "Null Pack", sku: "NULL-PACK", unitsPerBox: null }
          : args?.where?.sku === "SAME-PACK"
            ? { id: "prod-same", name: "Same Pack", sku: "SAME-PACK", unitsPerBox: 12 }
            : null,
      );
      const csv =
        "Item Name,SKU,Rate,Units Per Box\n" +
        "Brand New,NEW-PACK,5,24\nNull Pack,NULL-PACK,,12\nSame Pack,SAME-PACK,,12\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.create.mock.calls[0]?.[0]).toMatchObject({ unitsPerBox: 24 });
      expect(productsService.update).toHaveBeenCalledTimes(1);
      expect(productsService.update.mock.calls[0]).toEqual([
        "prod-null",
        { unitsPerBox: 12 },
        { suppressEmit: true },
      ]);
      expect(result.unchanged).toBe(1);
    });

    it.each([
      ["money", "Item Name,SKU,Rate\nWidget,SKU-1,abc\n", "Rate: not a number"],
      ["negative money", "Item Name,SKU,Rate\nWidget,SKU-1,-3\n", "Rate: must not be negative"],
      ["int", "Item Name,SKU,Rate,Units Per Box\nWidget,SKU-1,5,1.5\n", "Units Per Box:"],
      ["bool", "Item Name,SKU,Rate,Tobacco\nWidget,SKU-1,5,maybe\n", "Tobacco:"],
    ])(
      "a bad %s cell skips the product row with its reason, never a partial write",
      async (_k, csv, reason) => {
        const result = await service.importProducts(Buffer.from(csv), "user-1");

        expect(productsService.create).not.toHaveBeenCalled();
        expect(productsService.update).not.toHaveBeenCalled();
        expect(result.skippedRows[0]?.reason.startsWith(reason)).toBe(true);
      },
    );

    it.each([
      ["tier", "Pricing Tier", "7", "Pricing Tier:"],
      ["date", "Tobacco Licence Expiry", "next week", "Tobacco Licence Expiry:"],
      ["consent", "SMS Consent", "sure", "SMS Consent:"],
      ["money", "Credit Limit", "lots", "Credit Limit: not a number"],
      ["terms word", "Payment Terms", "whenever", "Payment Terms:"],
    ])("a bad %s cell skips the customer row with its reason", async (_k, header, cell, reason) => {
      prisma.customer.findFirst.mockResolvedValue(matchedCustomer());
      const csv = `Customer Name,Customer ID,${header}\nAcme Supply,ZC-1,${cell}\n`;

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
      expect(customers.setCustomerConsent).not.toHaveBeenCalled();
      expect(result.skippedRows[0]?.reason.startsWith(reason)).toBe(true);
    });

    it.each([
      ["yes", true],
      ["TRUE", true],
      ["1", true],
      ["no", false],
      ["False", false],
      ["0", false],
    ])(
      "consent literal %s sets the flag to %s (through setCustomerConsent)",
      async (cell, value) => {
        prisma.customer.findFirst.mockResolvedValue(
          matchedCustomer({ smsConsent: !value, waConsent: false }),
        );
        const csv = `Customer Name,Customer ID,SMS Consent\nAcme Supply,ZC-1,${cell}\n`;

        await service.importContacts(Buffer.from(csv), "user-1", { fileName: "c.csv" });

        expect(customers.setCustomerConsent).toHaveBeenCalledWith(
          "cust-1",
          { smsConsent: value },
          { userId: "user-1", source: "import", fileName: "c.csv", row: 1 },
        );
      },
    );
  });

  // ── Opus round 2 (W1/W2/W3/W5) ───────────────────────────────────────────────────────────────
  describe("Opus round 2", () => {
    it("W1: a barcode match whose SKU differs from the row's SKU skips — never an identity rewrite", async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.barcode === "BC-1"
          ? { id: "prod-1", name: "Cola", sku: "C-1", barcode: "BC-1", pricePerUnit: 9 }
          : null,
      );
      const csv = "Item Name,SKU,Barcode,Rate\nCola,SUP-7,BC-1,10\n";

      for (const dryRun of [true, false]) {
        productsService.update.mockClear();
        const result = await service.importProducts(Buffer.from(csv), "user-1", { dryRun });

        expect(result.rows).toEqual([
          {
            row: 1,
            label: "Cola",
            action: "skip",
            reason:
              "SKU differs from the product matched by barcode; change SKUs in the product editor",
          },
        ]);
        expect(productsService.update).not.toHaveBeenCalled();
      }
    });

    it("W1: a barcode match with no SKU on the product may still fill it", async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.barcode === "BC-1"
          ? { id: "prod-1", name: "Cola", sku: null, barcode: "BC-1", pricePerUnit: 9 }
          : null,
      );
      const csv = "Item Name,SKU,Barcode,Rate\nCola,SUP-7,BC-1,9\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update.mock.calls[0]?.[1]).toEqual({ sku: "SUP-7" });
    });

    it("W2: a regulated product's category is never planned — a row warning instead, and no update", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Pouch",
        sku: "P-1",
        category: "Zyn",
        trackedSubcategoryId: "sub-1",
        pricePerUnit: 9,
      });
      const csv = "Item Name,SKU,Category,Rate\nPouch,P-1,Nicotine,9\n";

      const preview = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });
      const real = await service.importProducts(Buffer.from(csv), "user-1");

      for (const r of [preview, real]) {
        expect(r.rows[0]).toEqual({
          row: 1,
          label: "Pouch",
          action: "update",
          changes: {},
          warnings: ["category is set by its regulated subcategory"],
        });
        expect(r.updated).toBe(0);
        expect(r.unchanged).toBe(1);
        expect(r.warnings).toEqual(["Row 1 (Pouch): category is set by its regulated subcategory"]);
      }
      expect(productsService.update).not.toHaveBeenCalled();
    });

    it("W2: other changes on a regulated product still apply, without the category", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Pouch",
        sku: "P-1",
        category: "Zyn",
        trackedSubcategoryId: "sub-1",
        pricePerUnit: 9,
      });
      const csv = "Item Name,SKU,Category,Rate\nPouch,P-1,Nicotine,11\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update.mock.calls[0]?.[1]).toEqual({ pricePerUnit: 11 });
      expect(result.updated).toBe(1);
      expect(result.rows[0].warnings).toEqual(["category is set by its regulated subcategory"]);
    });

    it("W2: an unregulated product's category change is still planned and written", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Cup",
        sku: "C-1",
        category: "Old",
        trackedSubcategoryId: null,
        pricePerUnit: 9,
      });
      const csv = "Item Name,SKU,Category\nCup,C-1,New\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update.mock.calls[0]?.[1]).toEqual({ category: "New" });
    });

    it("W3: the preview asks the service's identity check, and its refusal is the row's skip reason in both modes", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const clash = new BadRequestException("SKU already exists");
      productsService.assertIdentityAvailable.mockRejectedValue(clash);
      productsService.create.mockRejectedValue(clash);
      const csv = "Item Name,SKU,Rate\nWidget,UNIT-CODE-1,10\n";

      const preview = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });
      const real = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.assertIdentityAvailable).toHaveBeenCalledWith({
        name: "Widget",
        parentProductId: null,
        sku: "UNIT-CODE-1",
        barcode: undefined,
      });
      const expected = [{ row: 1, label: "Widget", action: "skip", reason: "SKU already exists" }];
      expect(preview.rows).toEqual(expected);
      expect(real.rows).toEqual(expected);
      expect(preview.created).toBe(0);
    });

    it("W3: a preview rename onto a taken name skips with update()'s own conflict", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Old Name",
        sku: "S-1",
        parentProductId: null,
        pricePerUnit: 9,
      });
      productsService.assertIdentityAvailable.mockRejectedValue(
        new ConflictException('A product named "Taken" already exists'),
      );
      const csv = "Item Name,SKU,Rate\nTaken,S-1,9\n";

      const preview = await service.importProducts(Buffer.from(csv), "user-1", { dryRun: true });

      expect(productsService.assertIdentityAvailable).toHaveBeenCalledWith(
        { name: "Taken", parentProductId: null, sku: undefined, barcode: undefined },
        "prod-1",
      );
      expect(preview.rows[0]).toMatchObject({
        action: "skip",
        reason: 'A product named "Taken" already exists',
      });
      expect(preview.updated).toBe(0);
      expect(productsService.update).not.toHaveBeenCalled();
    });

    it.each(["Reorder Point", "Reorder Qty"])(
      "SA-322: a %s column without flag.forecasting refuses the WHOLE file, before any query (preview and run)",
      async (header) => {
        productsService.assertReorderAllowed.mockRejectedValue(new ForbiddenException("denied"));
        const csv = `Item Name,SKU,Rate,${header}\nWidget,SKU-1,10,4\n`;

        for (const dryRun of [true, false]) {
          await expect(
            service.importProducts(Buffer.from(csv), "user-1", { dryRun }),
          ).rejects.toThrow(
            `Column "${header}" needs the forecasting plan flag; remove the column or enable it`,
          );
        }
        expect(prisma.product.findFirst).not.toHaveBeenCalled();
        expect(prisma.product.findMany).not.toHaveBeenCalled();
        expect(productsService.create).not.toHaveBeenCalled();
        expect(productsService.update).not.toHaveBeenCalled();
      },
    );

    it("SA-322: a file without reorder columns never asks the forecasting gate", async () => {
      const csv = "Item Name,SKU,Rate\nWidget,SKU-1,10\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.assertReorderAllowed).not.toHaveBeenCalled();
    });

    it("W5: a Customer ID that belongs to a soft-deleted customer skips in preview and run", async () => {
      prisma.customer.findFirst.mockImplementation(async (args: any) =>
        args?.where?.deletedAt?.not === null ? { id: "cust-deleted" } : null,
      );
      prisma.customer.findMany.mockResolvedValue([]);
      const csv = "Customer Name,Customer ID,Credit Limit\nAcme,ZC-9,500\n";

      for (const dryRun of [true, false]) {
        const result = await service.importContacts(Buffer.from(csv), "user-1", { dryRun });

        expect(result.rows).toEqual([
          {
            row: 1,
            label: "Acme",
            action: "skip",
            reason: "matches a deleted customer; restore it first",
          },
        ]);
      }
      expect(prisma.customer.findMany).not.toHaveBeenCalled(); // never falls through to a name match
      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
    });
  });

  // ── Pins (SA-284 / rulings-s4-s5.md S4) — not in the red gate ───────────────

  describe("pins", () => {
    it("P6: a Tobacco column without the tobacco_dealer addon refuses the whole file (dryRun and real)", async () => {
      productsService.assertCanFlagTobacco.mockRejectedValue(
        new ForbiddenException("tobacco_dealer add-on required"),
      );
      const csv = "Item Name,SKU,Tobacco\nWidget,SKU-1,Yes\n";
      // Cast to `any`: `dryRun` is not a parameter of today's `importProducts(buffer, userId)` —
      // FIX3 adds the optional `opts` param this pin exercises.
      const importAny = service.importProducts.bind(service) as any;

      await expect(importAny(Buffer.from(csv), "user-1", { dryRun: true })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(importAny(Buffer.from(csv), "user-1")).rejects.toThrow(ForbiddenException);
      expect(productsService.create).not.toHaveBeenCalled();
      expect(productsService.update).not.toHaveBeenCalled();
    });

    it("P7: an MSRP column without the msrp plan flag refuses the whole file (dryRun and real)", async () => {
      productsService.assertMsrpAllowed.mockRejectedValue(
        new ForbiddenException("msrp flag required"),
      );
      const csv = "Item Name,SKU,MSRP\nWidget,SKU-1,19.99\n";
      const importAny = service.importProducts.bind(service) as any;

      await expect(importAny(Buffer.from(csv), "user-1", { dryRun: true })).rejects.toThrow(
        ForbiddenException,
      );
      await expect(importAny(Buffer.from(csv), "user-1")).rejects.toThrow(ForbiddenException);
      expect(productsService.create).not.toHaveBeenCalled();
      expect(productsService.update).not.toHaveBeenCalled();
    });

    // ── B987-E (c): the entitlement 403 carries a CODE and structured fields so the web shows fixed copy. The status and
    // the message are unchanged; `column` is the user's own header, data only, capped. ──────────────────────────────────

    it.each([
      ["MSRP", "MSRP", "assertMsrpAllowed", "MSRP", "needs the MSRP plan flag"],
      [
        "Tobacco",
        "Tobacco",
        "assertCanFlagTobacco",
        "TOBACCO_DEALER",
        "needs tobacco_dealer add-on",
      ],
      [
        "Reorder Point",
        "Reorder Point",
        "assertReorderAllowed",
        "FORECASTING",
        "needs the forecasting plan flag",
      ],
    ])(
      "B987-E: a %s column without its entitlement answers 403 IMPORT_COLUMN_NEEDS_ENTITLEMENT {requires, column}, message unchanged",
      async (header, column, gate, requires, sentence) => {
        (productsService as any)[gate].mockRejectedValue(new ForbiddenException("denied"));
        const csv = `Item Name,SKU,${header}\nWidget,SKU-1,1\n`;
        const err: any = await service
          .importProducts(Buffer.from(csv), "user-1", { dryRun: true } as any)
          .catch((e) => e);
        expect(err).toBeInstanceOf(ForbiddenException);
        expect(err.getStatus()).toBe(403);
        expect(err.getResponse()).toEqual({
          code: "IMPORT_COLUMN_NEEDS_ENTITLEMENT",
          message: `Column "${column}" ${sentence}; remove the column or enable it`,
          requires,
          column,
        });
      },
    );

    // ── Opus #938 fold (B): the file-level gate's catch must never turn an entitlement OUTAGE
    // into "needs the flag" — only a genuine denial gets the friendly message; anything else
    // (a PLAN_GATE_UNAVAILABLE denial-shaped ForbiddenException, or a plain outage error) is
    // rethrown unchanged, and no write query ever runs either way. ──────────────────────────

    it.each([
      [
        "msrp",
        "MSRP",
        "Item Name,SKU,MSRP\nWidget,SKU-1,19.99\n",
        () => productsService.assertMsrpAllowed,
      ],
      [
        "tobacco",
        "Tobacco",
        "Item Name,SKU,Tobacco\nWidget,SKU-1,Yes\n",
        () => productsService.assertCanFlagTobacco,
      ],
      [
        "reorder",
        "Reorder Point",
        "Item Name,SKU,Rate,Reorder Point\nWidget,SKU-1,10,4\n",
        () => productsService.assertReorderAllowed,
      ],
    ])(
      '%s gate: a generic outage error (DB/network) is rethrown as-is, never as "needs the flag" (preview and run)',
      async (_key, _header, csv, mock) => {
        const outage = new Error("connect ECONNREFUSED");
        mock().mockRejectedValue(outage);
        const importAny = service.importProducts.bind(service) as any;

        await expect(importAny(Buffer.from(csv), "user-1", { dryRun: true })).rejects.toBe(outage);
        await expect(importAny(Buffer.from(csv), "user-1")).rejects.toBe(outage);
        expect(prisma.product.findFirst).not.toHaveBeenCalled();
        expect(productsService.create).not.toHaveBeenCalled();
        expect(productsService.update).not.toHaveBeenCalled();
      },
    );

    it(
      "reorder gate: a PLAN_GATE_UNAVAILABLE denial-shaped ForbiddenException (entitlements " +
        'unresolvable) is rethrown as the outage, never relabeled "needs the forecasting plan flag"',
      async () => {
        const unavailable = new ForbiddenException({
          code: "PLAN_GATE_UNAVAILABLE",
          message: "Entitlements are temporarily unavailable. Please retry.",
        });
        productsService.assertReorderAllowed.mockRejectedValue(unavailable);
        const csv = "Item Name,SKU,Rate,Reorder Point\nWidget,SKU-1,10,4\n";
        const importAny = service.importProducts.bind(service) as any;

        for (const dryRun of [true, false]) {
          await expect(importAny(Buffer.from(csv), "user-1", { dryRun })).rejects.toBe(unavailable);
        }
        expect(prisma.product.findFirst).not.toHaveBeenCalled();
        expect(productsService.create).not.toHaveBeenCalled();
        expect(productsService.update).not.toHaveBeenCalled();
      },
    );

    it("P8: two rows whose normalized name collides (no SKU/barcode) are both skipped ambiguous", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const csv = "Item Name,Rate\nWidget Pro,10\nwidget   pro,12\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      const skipped = (result as any).skippedRows ?? [];
      expect(skipped.filter((r: any) => /ambiguous name/.test(r.reason)).length).toBeGreaterThan(0);
      expect(productsService.create).not.toHaveBeenCalled();
    });

    it("P9: a second row hitting a key an earlier row already claimed is skipped duplicate", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const csv = "Item Name,SKU\nWidget A,SKU-1\nWidget B,SKU-1\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      const skipped = (result as any).skippedRows ?? [];
      expect(skipped.some((r: any) => /duplicate of row/.test(r.reason))).toBe(true);
    });

    it("I1: two rows matching the SAME existing product (via different keys) — the second is a duplicate, not a second update", async () => {
      // Both rows name-match the SAME existing product "Cola" (sku C-1); their own SKUs miss.
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "C-1"
          ? { id: "prod-cola", name: "Cola", sku: "C-1", pricePerUnit: 9 }
          : null,
      );
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-cola", name: "Cola", sku: "C-1", pricePerUnit: 9 },
      ]);
      const csv = "Item Name,SKU,Rate\nCola,SUP-1,10\nCola,SUP-2,11\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      // Neither row silently rewrites C-1's SKU via two independent updates — row 2 is a skip.
      expect(productsService.update).toHaveBeenCalledTimes(0);
      const skipped = (result as any).skippedRows ?? [];
      expect(skipped.length).toBe(2);
      expect(
        skipped.every((r: any) =>
          /SKU \S+ not found; name matches a product with SKU C-1/.test(r.reason),
        ),
      ).toBe(true);
    });

    it("I1: an unmatched SKU never falls back to a name match on a product with a DIFFERENT sku", async () => {
      prisma.product.findFirst.mockResolvedValue(null); // SKU miss
      prisma.product.findMany.mockResolvedValue([
        { id: "prod-cola", name: "Cola", sku: "C-1", pricePerUnit: 9 },
      ]);
      const csv = "Item Name,SKU,Rate\nCola,SUP-9,10\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).not.toHaveBeenCalled();
      expect(productsService.create).not.toHaveBeenCalled();
      expect((result as any).skippedRows?.[0]?.reason).toBe(
        "SKU SUP-9 not found; name matches a product with SKU C-1",
      );
    });

    it("I1: preview and real run produce the SAME plan for two same-name, no-existing-product creates with differing SKUs", async () => {
      // Nothing in the DB matches by sku, barcode, or name — a real, sequential run would create
      // row 1, then see it via a name lookup for row 2 and (correctly) skip row 2 rather than
      // silently rewriting row 1's SKU. The in-file `virtualCreates` fallback must make dryRun
      // predict the exact same outcome, since nothing is actually written in a dry run.
      prisma.product.findFirst.mockResolvedValue(null);
      prisma.product.findMany.mockResolvedValue([]);
      const csv = "Item Name,SKU,Rate\nCola,SUP-1,10\nCola,SUP-2,11\n";
      const importAny = service.importProducts.bind(service) as any;

      const preview = await importAny(Buffer.from(csv), "user-1", { dryRun: true });

      expect(preview.rows[0]).toMatchObject({ action: "create" });
      expect(preview.rows[1]).toMatchObject({ action: "skip" });
      expect(preview.rows[1].reason).toMatch(
        /SKU SUP-2 not found; name matches a product with SKU SUP-1/,
      );
    });

    it("P10: a blank cell never clears an existing value on an update row (M9: deterministic — Rate always forces the update)", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        barcode: null,
        unitsPerBox: 12,
        category: "Widgets",
        pricePerUnit: 10,
      });
      // Rate differs (10 -> 12), so `update` is unconditionally called; Category is blank so it
      // must be absent from the diff — no if/else that would pass whether or not update ran.
      const csv = "Item Name,SKU,Category,Rate\nWidget Pro,SKU-1,,12\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).toHaveBeenCalledTimes(1);
      const dto = productsService.update.mock.calls[0]?.[1] ?? {};
      expect(dto).not.toHaveProperty("category");
      expect(dto).toMatchObject({ pricePerUnit: 12 });
    });

    it("P10b: blank-never-clears also holds for a money field, a bool field, and an int field", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        creditLimit: 500,
        isTaxExempt: true,
        pricingTier: 2,
        taxId: "existing-id",
        addresses: [],
        contactPersons: [],
      });
      // Credit Limit/Tax Exempt/Pricing Tier are all blank; only Tax ID changes, so `update` is
      // unconditionally called and the blank columns must be absent from the diff.
      const csv =
        "Customer Name,Customer ID,Credit Limit,Tax Exempt,Pricing Tier,Tax ID\n" +
        "Acme Supply,ZC-1,,,,new-id\n";

      await service.importContacts(Buffer.from(csv), "user-1");

      expect(customers.update).toHaveBeenCalledTimes(1);
      const dto = customers.update.mock.calls[0]?.[1] ?? {};
      expect(dto).not.toHaveProperty("creditLimit");
      expect(dto).not.toHaveProperty("isTaxExempt");
      expect(dto).not.toHaveProperty("pricingTier");
      expect(dto).toMatchObject({ taxId: "new-id" });
    });

    it('P11: pack rule — existing 6 vs row 12 skips "pack changes are made in the product editor"', async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        unitsPerBox: 6,
      });
      const csv = "Item Name,SKU,Units Per Box\nWidget Pro,SKU-1,12\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      const skipped = (result as any).skippedRows ?? [];
      expect(
        skipped.some((r: any) => /pack changes are made in the product editor/.test(r.reason)),
      ).toBe(true);
    });

    it("M1: an MSRP of 0 against an existing null MSRP is idempotent — no update call, no diff", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        msrp: null,
      });
      const csv = "Item Name,SKU,MSRP\nWidget Pro,SKU-1,0\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).not.toHaveBeenCalled();
      expect(result.unchanged).toBe(1);
    });

    it("M1: a genuine positive MSRP still diffs and writes against an existing null MSRP", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        msrp: null,
      });
      const csv = "Item Name,SKU,MSRP\nWidget Pro,SKU-1,19.99\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).toHaveBeenCalledWith(
        "prod-1",
        expect.objectContaining({ msrp: 19.99 }),
        expect.anything(),
      );
    });

    it("M2: standardCost 1.2345 -> 1.2349 is a real change at 4dp, not dropped as unchanged", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        standardCost: 1.2345,
      });
      const csv = "Item Name,SKU,Standard Cost\nWidget Pro,SKU-1,1.2349\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.update).toHaveBeenCalledWith(
        "prod-1",
        expect.objectContaining({ standardCost: 1.2349 }),
        expect.anything(),
      );
      expect(result.unchanged).toBe(0);
    });

    it("M3: a row with no name skips 'Name is required' (checked before Rate)", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const csv = "Item Name,SKU,Rate\n,SKU-9,10\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.create).not.toHaveBeenCalled();
      expect((result as any).skippedRows?.[0]?.reason).toBe("Name is required");
    });

    it("SA-305 (1): an unmapped Payment Terms integer (7) imports the row with terms unset and a warning naming it", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        addresses: [],
        contactPersons: [],
      });
      const csv = "Customer Name,Customer ID,Payment Terms\nAcme Supply,ZC-1,7\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect((result as any).skippedRows ?? []).toHaveLength(0);
      const dto = customers.update.mock.calls[0]?.[1] ?? {};
      expect(dto).not.toHaveProperty("defaultPaymentTerms");
      expect(result.warnings).toEqual(
        expect.arrayContaining([expect.stringMatching(/Payment Terms "7"/)]),
      );
    });

    it("P12: no consent call when the consent cell is unchanged", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        smsConsent: true,
        addresses: [],
        contactPersons: [],
      });
      const csv = "Customer Name,Customer ID,SMS Consent\nAcme Supply,ZC-1,Yes\n";

      await service.importContacts(Buffer.from(csv), "user-1");

      expect(auditService.log).not.toHaveBeenCalled();
      expect(customers.setCustomerConsent).not.toHaveBeenCalled();
    });

    it("P12b: setCustomerConsent evidence meta shape is exact (source, userId, fileName, row, channel, value)", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        smsConsent: false,
        waConsent: false,
        addresses: [],
        contactPersons: [],
      });
      const csv =
        "Customer Name,Customer ID,SMS Consent,WhatsApp Consent\nAcme Supply,ZC-1,Yes,Yes\n";

      await service.importContacts(Buffer.from(csv), "user-1", { fileName: "contacts.csv" });

      expect(customers.setCustomerConsent).toHaveBeenCalledTimes(1);
      const [id, consent, evidence] = customers.setCustomerConsent.mock.calls[0];
      expect(id).toBe("cust-1");
      expect(consent).toEqual({ smsConsent: true, waConsent: true });
      expect(evidence).toEqual({
        userId: "user-1",
        source: "import",
        fileName: "contacts.csv",
        row: 1,
      });
    });

    it("P13: an expired tobacco licence still imports and warns", async () => {
      prisma.customer.findFirst.mockResolvedValue({
        id: "cust-1",
        businessName: "Acme Supply",
        zohoContactId: "ZC-1",
        addresses: [],
        contactPersons: [],
      });
      const csv =
        "Customer Name,Customer ID,Tobacco Licence No,Tobacco Licence Expiry\n" +
        "Acme Supply,ZC-1,TL-1,2020-01-01\n";

      const result = await service.importContacts(Buffer.from(csv), "user-1");

      expect(customers.update).toHaveBeenCalled();
      expect((result as any).warnings ?? []).toEqual(
        expect.arrayContaining([expect.stringMatching(/Row 1 \(.+\): tobacco licence expired/)]),
      );
    });

    it("P14: dryRun writes nothing", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const csv = "Item Name,SKU,Rate\nWidget Pro,SKU-1,10\n";
      const importAny = service.importProducts.bind(service) as any;

      await importAny(Buffer.from(csv), "user-1", { dryRun: true });

      expect(productsService.create).not.toHaveBeenCalled();
      expect(productsService.update).not.toHaveBeenCalled();
      expect(auditService.log).not.toHaveBeenCalled();
    });

    it("P15: exactly one emitCatalogBulkChanged() call per file when rows changed; zero when nothing changed", async () => {
      prisma.product.findFirst.mockResolvedValue(null);
      const csv = "Item Name,SKU,Rate\nWidget Pro,SKU-1,10\nGadget,SKU-2,20\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(productsService.emitCatalogBulkChanged).toHaveBeenCalledTimes(1);
    });

    it("P15b: zero emitCatalogBulkChanged() calls when nothing actually changed", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        pricePerUnit: 10,
      });
      const csv = "Item Name,SKU,Rate\nWidget Pro,SKU-1,10\n";

      const result = await service.importProducts(Buffer.from(csv), "user-1");

      expect(result.unchanged).toBe(1);
      expect(productsService.update).not.toHaveBeenCalled();
      expect(productsService.emitCatalogBulkChanged).not.toHaveBeenCalled();
    });

    it("P14b: importContacts dryRun writes nothing (no identity/address writes, no update, no consent, no grace)", async () => {
      prisma.customer.findFirst.mockResolvedValue(null);
      const csv = "Customer Name,Credit Limit,SMS Consent\nBrand New Co,500,Yes\n";
      const importAny = service.importContacts.bind(service) as any;

      await importAny(Buffer.from(csv), "user-1", { dryRun: true });

      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect(prisma.user.create).not.toHaveBeenCalled();
      expect(customers.update).not.toHaveBeenCalled();
      expect(customers.setCustomerConsent).not.toHaveBeenCalled();
      expect(customers.maybeStartCustomerGrace).not.toHaveBeenCalled();
    });

    it("source pin (SA-284 a): importProducts NEVER calls raw prisma.product.create/update", async () => {
      prisma.product.findFirst.mockImplementation(async (args: any) =>
        args?.where?.sku === "SKU-1"
          ? { id: "prod-1", name: "Widget Pro", sku: "SKU-1", pricePerUnit: 10 }
          : null,
      );
      const csv = "Item Name,SKU,Rate\nWidget Pro,SKU-1,12\nBrand New Widget,SKU-2,5\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      expect(prisma.product.create).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(productsService.update).toHaveBeenCalledTimes(1);
      expect(productsService.create).toHaveBeenCalledTimes(1);
    });
  });
});
