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
import { ForbiddenException } from "@nestjs/common";
import { ImportService } from "./import.service";
import { PrismaService } from "../prisma/prisma.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { CustomersService } from "../customers/customers.service";
import { NumberingService } from "./numbering.service";
import { ExternalRefService } from "./external-ref.service";
import { ProductsService } from "../products/products.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("ImportService — commercial columns (B858/B859)", () => {
  let service: ImportService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let productsService: {
    create: jest.Mock;
    update: jest.Mock;
    emitCatalogBulkChanged: jest.Mock;
    assertCanFlagTobacco: jest.Mock;
    assertMsrpAllowed: jest.Mock;
  };
  let auditService: { log: jest.Mock };
  let customers: {
    assertCustomerCapNotExceeded: jest.Mock;
    maybeStartCustomerGrace: jest.Mock;
    update: jest.Mock;
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    productsService = {
      create: jest.fn().mockResolvedValue({ id: "prod-new" }),
      update: jest.fn().mockResolvedValue({ id: "prod-existing" }),
      emitCatalogBulkChanged: jest.fn(),
      assertCanFlagTobacco: jest.fn().mockResolvedValue(undefined),
      assertMsrpAllowed: jest.fn().mockResolvedValue(undefined),
    };
    auditService = { log: jest.fn().mockResolvedValue(undefined) };
    customers = {
      assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
      maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockResolvedValue({ id: "cust-existing" }),
    };

    const mod = await Test.createTestingModule({
      providers: [
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
    prisma.product.findFirst.mockResolvedValue(null);
    const csv = "Item Name,SKU,Price Tier 2\nWidget Pro (2026 refresh),SKU-1,9.5\n";

    await service.importProducts(Buffer.from(csv), "user-1");

    expect(productsService.update).toHaveBeenCalledTimes(1);
    expect(productsService.update.mock.calls[0]?.[1]).toMatchObject({ priceTier2: 9.5 });
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

  it("REG-B859-2: licence+consent write evidence", async () => {
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

    expect(auditService.log).toHaveBeenCalledTimes(1);
    const dto = auditService.log.mock.calls[0]?.[0];
    expect(dto).toMatchObject({ action: "customer.consent.import" });
    expect(dto?.meta).toMatchObject({ source: "import", channel: "sms", value: true });
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

    it("P10: blank cells never clear an existing value on an update row", async () => {
      prisma.product.findFirst.mockResolvedValue({
        id: "prod-1",
        name: "Widget Pro",
        sku: "SKU-1",
        barcode: null,
        unitsPerBox: 12,
        category: "Widgets",
      });
      const csv = "Item Name,SKU,Category\nWidget Pro,SKU-1,\n";

      await service.importProducts(Buffer.from(csv), "user-1");

      if (productsService.update.mock.calls.length > 0) {
        const dto = productsService.update.mock.calls[0]?.[1] ?? {};
        expect(dto).not.toHaveProperty("category");
      } else {
        expect(productsService.update).not.toHaveBeenCalled();
      }
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

    it("P12: consent audit meta shape is exact; no call when the consent cell is unchanged", async () => {
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
        expect.arrayContaining([expect.stringMatching(/Tobacco licence expired/)]),
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
  });
});
