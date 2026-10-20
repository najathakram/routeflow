/**
 * B297 PR3 (SA-734r2 B3 / B4 / R3 / R5, L-169) — real-Postgres pins for the INVOICE side of the snapshot
 * recompute: applyPriceAdjustment on an issued invoice and the PATCH /invoices/:id matched row. The category
 * rate is RAISED after the line was priced; the line must keep the rate in its own stamped trio, and so must
 * the regulated ledger's SALE rows the adjustment rewrites (R5: assert the invoice line amount AND the SALE
 * rows, not only the line). A NULL-trio line prices at the live rate once and stamps it.
 *
 * Real: PrismaService, InvoicesService, the regulated ledger. Stubbed collaborators are the set every
 * invoices DB spec stubs, none of which the excise depends on. Each case fails on master's live-rate
 * recompute on its own wrong value.
 *
 * Runs only under `npm run local:test:db` (jest.db.config.js). Every tenant is a throwaway
 * `qa-b297-<run>-<n>` slug approved by `assertTestTenant`, deleted in FK order in afterAll.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));
import { Test } from "@nestjs/testing";
import { spawnSync } from "child_process";
import * as path from "path";
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { InvoicesService } from "./invoices.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const SNAPSHOT_RATE = 0.05;
const LIVE_RATE = 0.07;

describeDb("B297 PR3 — invoice recompute reads the line's rate snapshot, real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let invoices: InvoicesService;
  const tenantIds: string[] = [];
  const warn = jest.spyOn(Logger.prototype, "warn");
  let seq = 0;

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InvoicesService,
        {
          provide: SellingRestrictionsService,
          useValue: { assertLinesSellable: jest.fn().mockResolvedValue(undefined) },
        },
        EstimatesService,
        NumberingService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: RouteFlowGateway,
          useValue: {
            emitInvoiceUpdated: jest.fn(),
            emitOrderCreated: jest.fn(),
            emitOrderStatusChanged: jest.fn(),
            emitLowStock: jest.fn(),
            emitStopCompleted: jest.fn(),
            emitUrgentOrder: jest.fn(),
          },
        },
        {
          provide: EmailService,
          useValue: {
            sendInvoice: jest.fn(),
            isEmailConfigured: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: InvoicePdfService, useValue: { getOrGenerate: jest.fn() } },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(null), set: jest.fn() },
        },
        RegulatedLedgerService,
        {
          provide: AuthorizationGuardService,
          useValue: {
            assertAuthorizedOrThrow: jest.fn().mockResolvedValue(undefined),
            checkAuthorized: jest.fn().mockResolvedValue({ blocked: [] }),
          },
        },
        {
          provide: CreditNotesService,
          useValue: {
            autoApplyOldestCreditsInTx: jest
              .fn()
              .mockResolvedValue({ applied: 0, invoiceStatus: null }),
            settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
            releaseInvoiceCreditsInTx: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: MessagingService,
          useValue: { notify: jest.fn().mockResolvedValue([]), notifyEvent: jest.fn() },
        },
        {
          provide: StorageService,
          useValue: { upload: jest.fn(), presignedUrl: jest.fn(), delete: jest.fn() },
        },
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();
    invoices = mod.get(InvoicesService);
  });

  afterAll(async () => {
    const swallow = () => undefined; // a failed cleanup must never mask a test's result
    for (const tenantId of tenantIds) {
      const where = { where: { tenantId } };
      await prisma.regulatedSalesLedger.deleteMany(where).catch(swallow);
      await prisma.invoicePayment.deleteMany(where).catch(swallow);
      await prisma.invoiceItem.deleteMany(where).catch(swallow);
      await prisma.invoice.deleteMany(where).catch(swallow);
      await prisma.orderItem.deleteMany(where).catch(swallow);
      await prisma.order.deleteMany(where).catch(swallow);
      await prisma.product.deleteMany(where).catch(swallow);
      await prisma.trackedCategory.deleteMany(where).catch(swallow);
      await prisma.customer.deleteMany(where).catch(swallow);
      await prisma.user.deleteMany(where).catch(swallow);
      await prisma.auditLog.deleteMany(where).catch(swallow);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(swallow);
    }
    warn.mockRestore();
    await prisma?.$disconnect();
  });

  beforeEach(() => warn.mockClear());

  /**
   * One tenant, one EXCISE_PER_UNIT category at the snapshot rate, one product in it, and one invoice with one
   * regulated line of 12 pieces at $10 whose excise was priced at the snapshot rate: 12 x 0.05 = 0.60. The
   * category rate is then RAISED to the live rate. `nullTrio` plants a legacy line with no stamped trio.
   */
  async function seed(
    label: string,
    opts: {
      status?: "DRAFT" | "SENT";
      nullTrio?: boolean;
      exempt?: boolean;
      noCategory?: boolean;
    } = {},
  ) {
    seq += 1;
    const slug = assertTestTenant(
      `qa-b297-${RUN}-${seq}-${label}`,
      "b297-invoice-snapshot.db.spec.ts",
    );
    const tenant = await prisma.tenant.create({ data: { slug, name: `B297 ${slug}` } });
    tenantIds.push(tenant.id);
    const tenantId = tenant.id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "CUSTOMER", tenantId },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `c ${label}`,
        contactName: `c ${label}`,
        tenantId,
        isTaxExempt: !!opts.exempt,
      },
    });
    const category = await prisma.trackedCategory.create({
      data: {
        tenantId,
        name: `cat ${label}`,
        taxType: "EXCISE_PER_UNIT",
        rate: SNAPSHOT_RATE,
      },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `p ${label}`,
        unit: "each",
        pricePerUnit: 10,
        trackedCategoryId: opts.noCategory ? null : category.id,
      },
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId: customer.id,
        invoiceNumber: `INV-B297-${RUN}-${seq}`,
        status: opts.status ?? "SENT",
        subtotal: 120,
        // SA-814 R5-2: the header agrees with the line's levy (a recompute refuses one that does not)
        taxAmount: opts.noCategory ? 4.2 : 0.6,
        total: opts.noCategory ? 124.2 : 120.6,
      },
    });
    const item = await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        productId: product.id,
        description: `p ${label}`,
        qty: 12,
        unitPrice: 10,
        discount: 0,
        taxRate: 0,
        subtotal: 120,
        trackedCategoryId: opts.noCategory ? null : category.id,
        categoryTaxAmount: opts.noCategory ? 4.2 : 0.6,
        categoryTaxType: opts.nullTrio || opts.noCategory ? null : "EXCISE_PER_UNIT",
        categoryTaxRate: opts.nullTrio || opts.noCategory ? null : SNAPSHOT_RATE,
        categoryPriceIncludesTax: opts.nullTrio || opts.noCategory ? null : false,
      },
    });
    if ((opts.status ?? "SENT") !== "DRAFT" && !opts.noCategory) {
      // The SALE row the invoice's issue wrote, at the snapshot rate: an issued invoice's price change books
      // an append-only CORRECTION against it (never a rewrite), so this is what the filing keeps reporting.
      const soldAt = new Date();
      await prisma.regulatedSalesLedger.create({
        data: {
          tenantId,
          trackedCategoryId: category.id,
          entryType: "SALE",
          invoiceId: invoice.id,
          invoiceItemId: item.id,
          qty: 12,
          unitBasisQty: 12,
          netSales: 120,
          categoryTax: 0.6,
          soldAt,
          periodBucket: `${soldAt.getUTCFullYear()}-${String(soldAt.getUTCMonth() + 1).padStart(2, "0")}`,
        },
      });
    }
    await prisma.trackedCategory.update({ where: { id: category.id }, data: { rate: LIVE_RATE } });
    return {
      tenantId,
      categoryId: category.id,
      productId: product.id,
      invoiceId: invoice.id,
      itemId: item.id,
    };
  }
  type Seeded = Awaited<ReturnType<typeof seed>>;

  const adjust = (s: Seeded, newUnitPrice: number) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.applyPriceAdjustment(s.invoiceId, {
        items: [{ itemId: s.itemId, newUnitPrice }],
        scope: "SINGLE",
      } as any),
    );
  const patch = (s: Seeded, qty: number) =>
    tenantCtx.run(s.tenantId, () =>
      invoices.update(s.invoiceId, {
        items: [
          {
            id: s.itemId,
            productId: s.productId,
            description: "Cigar",
            qty,
            unitPrice: 10,
          },
        ],
      } as any),
    );

  /** The persisted line as TEXT straight from Postgres. */
  const stored = async (s: Seeded) => {
    const [l] = await prisma.$queryRaw<
      Array<{ amount: string; type: string | null; rate: string | null; includes: boolean | null }>
    >`SELECT "categoryTaxAmount"::text AS amount, "categoryTaxType"::text AS type,
             "categoryTaxRate"::text AS rate, "categoryPriceIncludesTax" AS includes
        FROM "InvoiceItem" WHERE id = ${s.itemId}`;
    return l;
  };
  /** The regulated ledger's NET excise for the tenant (SALE + REVERSAL + corrections): what the filing reports. */
  const ledgerTax = async (s: Seeded) => {
    const [r] = await prisma.$queryRaw<Array<{ tax: string | null }>>`
      SELECT sum("categoryTax")::text AS tax FROM "RegulatedSalesLedger" WHERE "tenantId" = ${s.tenantId}`;
    return r.tax;
  };
  const warnedAbout = (id: string) =>
    warn.mock.calls.some((c) => typeof c[0] === "string" && (c[0] as string).includes(id));

  it("applyPriceAdjustment: a price change after a rate raise leaves the excise at the snapshot rate, on the line AND the SALE rows", async () => {
    const s = await seed("adjust");
    await adjust(s, 11);
    expect(await stored(s)).toMatchObject({
      amount: "0.60",
      type: "EXCISE_PER_UNIT",
      rate: "0.0500",
    });
    expect(await ledgerTax(s)).toBe("0.60"); // master books a +0.24 correction: the filing reads 0.84
    const [inv] = await prisma.$queryRaw<Array<{ taxAmount: string }>>`
      SELECT "taxAmount"::text AS "taxAmount" FROM "Invoice" WHERE id = ${s.invoiceId}`;
    expect(inv.taxAmount).toBe("0.60");
  });

  it("applyPriceAdjustment: a NULL-trio line prices at the live rate once, stamps the trio and warns naming the line", async () => {
    const s = await seed("adjust-null", { nullTrio: true });
    await adjust(s, 11);
    expect(await stored(s)).toMatchObject({
      amount: "0.84",
      type: "EXCISE_PER_UNIT",
      rate: "0.0700",
      includes: false,
    });
    expect(warnedAbout(s.itemId)).toBe(true);
    await prisma.trackedCategory.update({ where: { id: s.categoryId }, data: { rate: 0.09 } });
    warn.mockClear();
    await adjust(s, 12);
    expect(await stored(s)).toMatchObject({ amount: "0.84", rate: "0.0700" }); // stamped: no longer follows the category
    expect(warnedAbout(s.itemId)).toBe(false);
  });

  it("PATCH /invoices/:id: a changed matched row re-prices at its own snapshot rate (R3)", async () => {
    const s = await seed("patch", { status: "DRAFT" });
    await patch(s, 6);
    expect(await stored(s)).toMatchObject({
      amount: "0.30",
      type: "EXCISE_PER_UNIT",
      rate: "0.0500",
    }); // master: 6 x 0.07 = 0.42
  });

  it("PATCH /invoices/:id: a NULL-trio matched row prices at the live rate once and stamps it", async () => {
    const s = await seed("patch-null", { status: "DRAFT", nullTrio: true });
    await patch(s, 6);
    expect(await stored(s)).toMatchObject({
      amount: "0.42",
      type: "EXCISE_PER_UNIT",
      rate: "0.0700",
    });
    expect(warnedAbout(s.itemId)).toBe(true);
  });

  it("PATCH /invoices/:id: a NULL-trio row whose product has since moved to another category stays on its own category (withRowCategories)", async () => {
    const s = await seed("patch-moved", { status: "DRAFT", nullTrio: true });
    const other = await prisma.trackedCategory.create({
      data: {
        tenantId: s.tenantId,
        name: `other ${RUN}`,
        taxType: "PERCENT_OF_SALE",
        rate: 0.5,
      },
    });
    await prisma.product.update({
      where: { id: s.productId },
      data: { trackedCategoryId: other.id },
    });
    await patch(s, 6);
    const [l] = await prisma.$queryRaw<
      Array<{ category: string | null; amount: string; type: string | null; rate: string | null }>
    >`SELECT "trackedCategoryId" AS category, "categoryTaxAmount"::text AS amount,
             "categoryTaxType"::text AS type, "categoryTaxRate"::text AS rate
        FROM "InvoiceItem" WHERE id = ${s.itemId}`;
    // priced at ITS OWN category's live rate (6 x 0.07), stamped with that category's trio, never moved
    expect(l).toEqual({
      category: s.categoryId,
      amount: "0.42",
      type: "EXCISE_PER_UNIT",
      rate: "0.0700",
    });
  });

  it("PATCH /invoices/:id: a no-category row with a stored levy keeps it through a quantity edit, with a warn [L1]", async () => {
    const s = await seed("patch-l1", { status: "DRAFT", noCategory: true });
    await prisma.product.update({ where: { id: s.productId }, data: { trackedCategoryId: null } });
    await patch(s, 6);
    expect(await stored(s)).toMatchObject({ amount: "4.20", type: null, rate: null }); // master: 0.00
    expect(warnedAbout(s.itemId)).toBe(true);
  });

  it("row 338: a no-category row with a stored levy stays category-less and keeps it even when its product is regulated now", async () => {
    const s = await seed("patch-l1-regulated", { status: "DRAFT", noCategory: true });
    // the product IS in the regulated category now, unlike the sibling case above (a noCategory seed
    // creates the product category-less)
    await prisma.product.update({
      where: { id: s.productId },
      data: { trackedCategoryId: s.categoryId },
    });
    await patch(s, 6);
    const [l] = await prisma.$queryRaw<
      Array<{ category: string | null; amount: string; type: string | null }>
    >`SELECT "trackedCategoryId" AS category, "categoryTaxAmount"::text AS amount,
             "categoryTaxType"::text AS type
        FROM "InvoiceItem" WHERE id = ${s.itemId}`;
    expect(l).toEqual({ category: null, amount: "4.20", type: null }); // master: re-priced 0.42, moved to the category
    expect(warnedAbout(s.itemId)).toBe(true);
  });

  it("the sizing report counts the planted NULL-trio lines, keeps an exempt customer's line out of (b), and prints no identifier", async () => {
    const stale = await seed("size-stale", { nullTrio: true }); // stored 0.60, live 0.07 x 12 = 0.84: would re-price
    const exempt = await seed("size-exempt", { nullTrio: true, exempt: true });
    await prisma.invoiceItem.update({
      where: { id: exempt.itemId },
      data: { categoryTaxAmount: 0 },
    });
    await prisma.invoiceItem.update({
      where: { id: stale.itemId },
      data: { createdAt: new Date() },
    });
    const script = path.resolve(__dirname, "../../scripts/report-b297-trio-sizing.mjs");
    const res = spawnSync(process.execPath, [script, "--json", "--since", "2026-01-01"], {
      encoding: "utf8",
      env: { ...process.env },
    });
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    // qa-* tenants are the report's own `test` block; at least our two planted lines are in it
    const inv = out.test.InvoiceItem;
    expect(inv.nullTrio).toBeGreaterThanOrEqual(2);
    expect(inv.nullTrioSince).toBeGreaterThanOrEqual(2);
    expect(inv.mismatch).toBeGreaterThanOrEqual(1);
    expect(inv.exempt).toBeGreaterThanOrEqual(1);
    expect(res.stdout).not.toMatch(/qa-b297|example\.invalid|[0-9a-f]{8}-[0-9a-f]{4}-/);
    // re-pricing the stale line away takes (b) down by exactly one: stamp it at the live rate
    // an exempt line's stored amount never moves (b): it is excluded whatever it holds
    await prisma.invoiceItem.update({
      where: { id: exempt.itemId },
      data: { categoryTaxAmount: 5 },
    });
    await prisma.invoiceItem.update({
      where: { id: stale.itemId },
      data: { categoryTaxAmount: 0.84 },
    });
    const again = JSON.parse(
      spawnSync(process.execPath, [script, "--json"], { encoding: "utf8", env: { ...process.env } })
        .stdout,
    );
    expect(again.test.InvoiceItem.mismatch).toBe(inv.mismatch - 1);
  });
});
