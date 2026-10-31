/**
 * SA-927 PR-A parity (part 2) - the NON-order stock writers outside inventory.service: vendor bills,
 * returns, parked-restock resolution, the Zoho stock import and the product bulk create. Real Postgres.
 *
 * Every `it` is one event on fresh products and asserts the LITERAL state master leaves (rows in fold
 * order, counter, average) through `parityState`; the stock-writer helper must leave exactly the same
 * rows. Odd master values are marked `// SA-927: master value`. Throwaway `qa-sa927b-*` tenant.
 *
 * Collected only by jest.db.config.js (`.db.spec.ts$`). Run via `npm run local:test:db`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { InventoryService } from "./inventory.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { ReturnsService } from "../returns/returns.service";
import { InlineReturnsService } from "../returns/inline-returns.service";
import { ParkedRestockResolutionService } from "../returns/parked-restock-resolution.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { AuditService } from "../audit/audit.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NumberingService } from "../import/numbering.service";
import { ImportService } from "../import/import.service";
import { ExternalRefService } from "../import/external-ref.service";
import { CustomersService } from "../customers/customers.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { ProductsService } from "../products/products.service";
import { AddonService } from "../billing/addon.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { expectLedgerConsistent, seedOpeningRow } from "./testing/ledger-consistency";
import { parityState, parityWindow } from "./testing/stock-parity";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
/** Fixed past dates so the bill rows' effectiveAt is a stable ISO literal and no replay is triggered. */
const OPENING_AT = "2020-02-10 00:00:00";
const BILL_DATE = "2020-03-15";
const BILL_AT = "2020-03-15T00:00:00.000Z";

describeDb("SA-927 parity - bills, returns, import and bulk create write the same rows", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let bills: VendorBillsService;
  let returns: ReturnsService;
  let inline: any;
  let parked: ParkedRestockResolutionService;
  let importService: ImportService;
  let products: ProductsService;
  let tenantId = "";
  let userId = "";
  let supplierId = "";
  let customerId = "";
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const anyMethod = new Proxy(
      {},
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
    );
    const hasFlag = jest.fn().mockResolvedValue(false);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        VendorBillsService,
        ReturnsService,
        CreditNotesService,
        RegulatedLedgerService,
        CommissionEngineService,
        AuditService,
        ParkedRestockResolutionService,
        ImportService,
        ExternalRefService,
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
        {
          provide: PlatformConfigService,
          useValue: {
            resolveAnthropicKey: jest.fn().mockResolvedValue(null),
            recordAiUsage: jest.fn(),
          },
        },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: DuplicateMatchService,
          useValue: {
            normalizeNumber: (raw: string) => (raw ?? "").toUpperCase().replace(/\s+/g, ""),
            findVendorBillDuplicate: jest.fn().mockResolvedValue(null),
            findScanDuplicate: jest.fn().mockResolvedValue(null),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn(),
            presignedUrl: jest.fn().mockResolvedValue("http://mock-url"),
            presignedUrls: jest.fn().mockResolvedValue([]),
            delete: jest.fn(),
          },
        },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
        { provide: EntitlementsService, useValue: { hasFlag } },
        { provide: RouteFlowGateway, useValue: anyMethod },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockImplementation(async () => `CN-S927-${++seq}`) },
        },
        {
          provide: CustomersService,
          useValue: {
            assertCustomerCapNotExceeded: jest.fn().mockResolvedValue(undefined),
            maybeStartCustomerGrace: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: SellingRestrictionsService,
          useValue: {
            checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
          },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements,
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
      ],
    }).compile();
    bills = module.get(VendorBillsService);
    returns = module.get(ReturnsService);
    parked = module.get(ParkedRestockResolutionService);
    importService = module.get(ImportService);
    products = module.get(ProductsService);
    const ledger = module.get(RegulatedLedgerService);
    inline = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      gateway: anyMethod,
      ledger,
      creditNotes: module.get(CreditNotesService),
      numbering: module.get(NumberingService),
      addonService: { hasAddon: async () => true },
      quoteService: {},
      idempotency: {},
      logger: new Logger(InlineReturnsService.name),
    });

    const slug = assertTestTenant(
      `qa-sa927b-${RUN}`,
      "sa927-parity-bills-returns-import.db.spec.ts",
    );
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-927b ${slug}` } })).id;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
    });
    userId = user.id;
    supplierId = (await prisma.supplier.create({ data: { name: `Supplier ${slug}`, tenantId } }))
      .id;
    const custUser = await prisma.user.create({
      data: {
        email: `cust-${slug}@example.invalid`,
        username: `cust-${slug}`,
        role: "CUSTOMER",
        tenantId,
      },
    });
    customerId = (
      await prisma.customer.create({
        data: { userId: custUser.id, businessName: `Cust ${slug}`, contactName: "QA", tenantId },
      })
    ).id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
      const billIds = vb.map((b) => b.id);
      const where = { where: { tenantId } };
      const steps: Array<() => Promise<unknown>> = [
        () => prisma.auditLog.deleteMany(where),
        () => prisma.returnParkedRestock.deleteMany(where),
        () => prisma.returnItem.deleteMany(where),
        () => prisma.return.deleteMany(where),
        () => prisma.creditNoteItem.deleteMany(where),
        () => prisma.creditNote.deleteMany(where),
        () => prisma.invoicePayment.deleteMany(where),
        () => prisma.invoiceItem.deleteMany(where),
        () => prisma.invoice.deleteMany(where),
        () => prisma.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } }),
        () => prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } }),
        () => prisma.vendorBill.deleteMany(where),
        () => prisma.stockLot.deleteMany(where),
        () => prisma.stockMovement.deleteMany(where),
        () => prisma.orderItem.deleteMany(where),
        () => prisma.order.deleteMany(where),
        () => prisma.product.deleteMany(where),
        () => prisma.supplier.deleteMany(where),
        () => prisma.customer.deleteMany(where),
        () => prisma.user.deleteMany(where),
        () => prisma.tenant.deleteMany({ where: { id: tenantId } }),
      ];
      for (const step of steps) {
        // eslint-disable-next-line no-await-in-loop
        await step().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error("SA-927 parity part 2 cleanup step failed:", e);
        });
      }
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** A fresh product at `stock` @ `avg`. `opening: "past"` dates the opening row 2020-02-10 (bills), else now-1h. */
  async function product(opts: {
    label: string;
    stock: number;
    avg?: number | null;
    method?: "AVCO" | "STANDARD";
    opening?: "past" | "recent";
  }) {
    seq += 1;
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: `${opts.label} ${RUN}-${seq}`,
        sku: `S927B-${RUN}-${seq}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: opts.stock,
        averageCost: opts.avg ?? null,
        costingMethod: opts.method ?? "AVCO",
        ...(opts.method === "STANDARD" && opts.avg != null ? { standardCost: opts.avg } : {}),
      },
    });
    if (opts.opening === "past") {
      await pool.query(
        `INSERT INTO "StockMovement" (id, "productId", type, quantity, "stockAfter", notes, "tenantId", "effectiveAt", "createdAt")
         VALUES (gen_random_uuid()::text, $1, 'ADJUSTMENT', $2, $2, 'OPENING', $3, $4::timestamp, $4::timestamp)`,
        [p.id, opts.stock, tenantId, OPENING_AT],
      );
    } else {
      await seedOpeningRow(pool, tenantId, p.id, opts.stock);
    }
    return p;
  }

  const state = (
    productId: string,
    window: ReturnType<typeof parityWindow>,
    label: string,
    tokens: Record<string, string> = {},
  ) => parityState(pool, productId, { window, since: window.start, tokens, label });

  // ── vendor bills ────────────────────────────────────────────────────────────

  async function createBill(productId: string, qty: number, unitCost: number) {
    const bill: any = await inTenant(() =>
      bills.create({
        supplierId,
        billDate: BILL_DATE,
        items: [{ productId, description: "Widget", qty, unitCost }],
      } as never),
    );
    return { id: bill.id as string, billNumber: bill.billNumber as string };
  }

  it("bill receive AVCO: 10 @ 2.00 + bill 10 @ 4 -> 20 @ 3.00, one PURCHASE row dated the bill date", async () => {
    const p = await product({ label: "Bill AVCO", stock: 10, avg: 2, opening: "past" });
    const bill = await createBill(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() => bills.receive(bill.id, undefined, userId));
    expect(await state(p.id, window, "bill.receive.avco", { [bill.billNumber]: "<bill>" })).toEqual(
      {
        currentStock: 20,
        averageCost: 3,
        rows: [
          {
            type: "PURCHASE",
            quantity: 10,
            reference: "<bill>",
            effectiveAt: BILL_AT,
            stockAfter: 20,
            avgCostAfter: 3,
          },
        ],
      },
    );
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("bill receive STANDARD: the average stays 2.00, stock 20, the row carries 2.00", async () => {
    const p = await product({
      label: "Bill STD",
      stock: 10,
      avg: 2,
      method: "STANDARD",
      opening: "past",
    });
    const bill = await createBill(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() => bills.receive(bill.id, undefined, userId));
    expect(await state(p.id, window, "bill.receive.std", { [bill.billNumber]: "<bill>" })).toEqual({
      currentStock: 20,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 20,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("bill revertToDraft AVCO: receive then revert appends a signed -10 PURCHASE row, average back to 2.00", async () => {
    const p = await product({ label: "Bill revert", stock: 10, avg: 2, opening: "past" });
    const bill = await createBill(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() => bills.receive(bill.id, undefined, userId));
    await inTenant(() => bills.revertToDraft(bill.id, userId));
    // SA-927: master value - the reversal is dated at the receipt's own instant (a tie with the receipt
    // on effectiveAt; fold order is then createdAt).
    expect(await state(p.id, window, "bill.revert.avco", { [bill.billNumber]: "<bill>" })).toEqual({
      currentStock: 10,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 20,
          avgCostAfter: 3,
        },
        {
          type: "PURCHASE",
          quantity: -10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 10,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("bill revertToDraft STANDARD: the operator-set cost 2.00 is not 'undone'", async () => {
    const p = await product({
      label: "Bill revert STD",
      stock: 10,
      avg: 2,
      method: "STANDARD",
      opening: "past",
    });
    const bill = await createBill(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() => bills.receive(bill.id, undefined, userId));
    await inTenant(() => bills.revertToDraft(bill.id, userId));
    expect(await state(p.id, window, "bill.revert.std", { [bill.billNumber]: "<bill>" })).toEqual({
      currentStock: 10,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 20,
          avgCostAfter: 2,
        },
        {
          type: "PURCHASE",
          quantity: -10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 10,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("bill void of a received bill: the same signed -10 PURCHASE reversal as the revert", async () => {
    const p = await product({ label: "Bill void", stock: 10, avg: 2, opening: "past" });
    const bill = await createBill(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() => bills.receive(bill.id, undefined, userId));
    await inTenant(() => bills.voidBill(bill.id, userId));
    expect(await state(p.id, window, "bill.void", { [bill.billNumber]: "<bill>" })).toEqual({
      currentStock: 10,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 20,
          avgCostAfter: 3,
        },
        {
          type: "PURCHASE",
          quantity: -10,
          reference: "<bill>",
          effectiveAt: BILL_AT,
          stockAfter: 10,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── returns ─────────────────────────────────────────────────────────────────

  /** An order with one 10-piece line of `productId`, a paid invoice, and a STANDARD return of `qty` pieces. */
  async function seedReturn(
    productId: string,
    qty: number,
    opts: { kind?: "STANDARD" | "INLINE"; status: "IN_TRANSIT" | "RECEIVED" },
  ) {
    seq += 1;
    const order = await prisma.order.create({
      data: {
        tenantId,
        customerId,
        orderNumber: `ORD-S927B-${RUN}-${seq}`,
        subtotal: 100,
        tax: 0,
        total: 100,
        status: "PENDING",
      } as any,
    });
    const orderItem = await prisma.orderItem.create({
      data: {
        tenantId,
        orderId: order.id,
        productId,
        name: "line",
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      } as any,
    });
    const invoice = await prisma.invoice.create({
      data: {
        tenantId,
        customerId,
        orderId: order.id,
        invoiceNumber: `INV-S927B-${RUN}-${seq}`,
        status: "PAID",
        subtotal: 100,
        taxAmount: 0,
        total: 100,
      },
    });
    await prisma.invoiceItem.create({
      data: {
        tenantId,
        invoiceId: invoice.id,
        orderItemId: orderItem.id,
        productId,
        description: "line",
        qty: 10,
        unitPrice: 10,
        subtotal: 100,
      } as any,
    });
    await prisma.invoicePayment.create({
      data: { tenantId, invoiceId: invoice.id, amount: 100, method: "CASH", status: "PAID" },
    });
    const ret = await prisma.return.create({
      data: {
        tenantId,
        orderId: order.id,
        customerId,
        reason: "WRONG_ITEM",
        status: opts.status,
        kind: opts.kind ?? "STANDARD",
        returnNumber: `RTN-S927B-${RUN}-${seq}`,
        items: { create: [{ tenantId, productId, qty, restock: true }] },
      } as any,
      include: { items: true },
    });
    return ret;
  }
  const retToken = (id: string) => ({ [id.slice(0, 8)]: "<ret8>" });
  const operator = () => ({ sub: userId, role: "OPERATOR", tenantId }) as any;

  it("returns receive: a 2-piece return restocks 2 at the current average (RETURN row, RET-<id8>), average unchanged", async () => {
    const p = await product({ label: "Ret receive", stock: 5, avg: 2 });
    const ret = await seedReturn(p.id, 2, { status: "IN_TRANSIT" });
    const window = parityWindow();
    await inTenant(() => returns.receive(ret.id, userId));
    expect(await state(p.id, window, "returns.receive", retToken(ret.id))).toEqual({
      currentStock: 7,
      averageCost: 2,
      rows: [
        {
          type: "RETURN",
          quantity: 2,
          reference: "RET-<ret8>",
          effectiveAt: "now",
          stockAfter: 7,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("returns cancel after receive: appends a -2 RETURN row on the same reference, history kept", async () => {
    const p = await product({ label: "Ret cancel", stock: 5, avg: 2 });
    const ret = await seedReturn(p.id, 2, { status: "IN_TRANSIT" });
    await inTenant(() => returns.receive(ret.id, userId));
    await new Promise((r) => setTimeout(r, 60));
    const since = new Date();
    await inTenant(() => returns.cancel(ret.id, operator()));
    expect(
      await parityState(pool, p.id, {
        window: parityWindow(),
        since,
        tokens: retToken(ret.id),
        label: "returns.cancel",
      }),
    ).toEqual({
      currentStock: 5,
      averageCost: 2,
      rows: [
        {
          type: "RETURN",
          quantity: -2,
          reference: "RET-<ret8>",
          effectiveAt: "now",
          stockAfter: 5,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("inline returns cancel of an applied return: a -2 RETURN row on RET-CANCEL-<id8>", async () => {
    const p = await product({ label: "Inline cancel", stock: 7, avg: 2 });
    const ret = await seedReturn(p.id, 2, { kind: "INLINE", status: "RECEIVED" });
    const window = parityWindow();
    await inTenant(() => inline.cancel(ret.id, operator()));
    expect(await state(p.id, window, "inline.cancel", retToken(ret.id))).toEqual({
      currentStock: 5,
      averageCost: 2,
      rows: [
        {
          type: "RETURN",
          quantity: -2,
          reference: "RET-CANCEL-<ret8>",
          effectiveAt: "now",
          stockAfter: 5,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("parked restock resolve: 3 boxes x 12 supplied -> +36 RETURN on RET-<id8>", async () => {
    const p = await product({ label: "Parked", stock: 4, avg: 2 });
    const ret = await seedReturn(p.id, 3, { status: "RECEIVED" });
    const itemId = (ret as any).items[0].id as string;
    const row = await prisma.returnParkedRestock.create({
      data: {
        tenantId,
        returnId: ret.id,
        returnItemId: itemId,
        productId: p.id,
        returnedQty: 3,
        reason: "qa unknown pack",
      },
    });
    const window = parityWindow();
    await inTenant(() => parked.resolve(row.id, 12, { id: userId }));
    expect(await state(p.id, window, "parked.resolve", retToken(ret.id))).toEqual({
      currentStock: 40,
      averageCost: 2,
      rows: [
        {
          type: "RETURN",
          quantity: 36,
          reference: "RET-<ret8>",
          effectiveAt: "now",
          stockAfter: 40,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── import: Zoho stock sync ─────────────────────────────────────────────────

  const csv = (name: string, sku: string, closing: number) =>
    Buffer.from(`Item Name,SKU,Closing Stock\n${name},${sku},${closing}\n`);

  it("importInventory existing product, closing 7 on 10 @ 2.00: one ADJUSTMENT -3 'Zoho stock sync'", async () => {
    const p = await product({ label: "Zoho sync down", stock: 10, avg: 2 });
    const window = parityWindow();
    const out = await inTenant(() =>
      importService.importInventory(csv(p.name, p.sku as string, 7), userId),
    );
    expect(out).toMatchObject({ updated: 1, created: 0, skipped: 0 });
    expect(await state(p.id, window, "import.sync.down")).toEqual({
      currentStock: 7,
      averageCost: 2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: -3,
          reference: null,
          effectiveAt: "now",
          stockAfter: 7,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("importInventory existing product, closing 15 on 10 @ 2.00: one ADJUSTMENT +5, average unchanged", async () => {
    const p = await product({ label: "Zoho sync up", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() => importService.importInventory(csv(p.name, p.sku as string, 15), userId));
    expect(await state(p.id, window, "import.sync.up")).toEqual({
      currentStock: 15,
      averageCost: 2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: 5,
          reference: null,
          effectiveAt: "now",
          stockAfter: 15,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  async function zohoCreate(label: string, closing: number) {
    seq += 1;
    const name = `Zoho New ${label} ${RUN}-${seq}`;
    const sku = `ZNEW-${RUN}-${seq}`;
    const window = parityWindow();
    const out = await inTenant(() =>
      importService.importInventory(csv(name, sku, closing), userId),
    );
    expect(out).toMatchObject({ created: 1, updated: 0, skipped: 0 });
    const created = await prisma.product.findFirstOrThrow({ where: { tenantId, sku } });
    return { id: created.id, window };
  }

  it("importInventory Zoho create 12: PURCHASE 12 'Opening stock (Zoho import)', NULL cost fields (all but stockAfter)", async () => {
    const z = await zohoCreate("fields", 12);
    const got = await state(z.id, z.window, "import.zoho.create");
    // SA-927a named diff: the opening row's stockAfter is asserted in the next test (master writes NULL).
    // Everything else is the master value and must not change: unit cost, avgCostAfter and
    // Product.averageCost are NULL (not 0).
    expect({
      ...got,
      rows: got.rows.map(({ stockAfter: _stockAfter, ...rest }) => rest),
    }).toEqual({
      currentStock: 12,
      averageCost: null, // SA-927: master value
      rows: [
        {
          type: "PURCHASE",
          quantity: 12,
          reference: null,
          effectiveAt: "now",
          avgCostAfter: null, // SA-927: master value
        },
      ],
    });
    const { rows } = await pool.query(
      `SELECT "unitCost", notes, type FROM "StockMovement" WHERE "productId" = $1`,
      [z.id],
    );
    expect(rows).toEqual([
      { unitCost: null, notes: "Opening stock (Zoho import)", type: "PURCHASE" },
    ]);
  });

  it("importInventory Zoho create 12 (SA-927a named diff): the opening row's stockAfter = closingStock, red on NULL", async () => {
    const z = await zohoCreate("stockafter", 12);
    const got = await state(z.id, z.window, "import.zoho.create.stockAfter");
    // SA-927a named diff: the ONE allowed parity diff vs master. Master writes NULL here (RED on master).
    expect(got.rows.map((r) => r.stockAfter)).toEqual([12]);
    await expectLedgerConsistent(tenantId, [z.id], pool);
  });

  // ── products bulk create (importFromZoho) ───────────────────────────────────

  async function bulkCreate(label: string, extra: Record<string, unknown>) {
    seq += 1;
    const name = `Bulk ${label} ${RUN}-${seq}`;
    const window = parityWindow();
    const out = await inTenant(() =>
      products.importFromZoho({
        items: [{ name, unit: "each", pricePerUnit: "3.00", ...extra }],
      } as any),
    );
    expect(out).toMatchObject({ created: 1, skipped: 0, errors: [] });
    const created = await prisma.product.findFirstOrThrow({ where: { tenantId, name } });
    return { id: created.id, window };
  }

  it("products bulk create with opening stock 10 @ 2.00: PURCHASE 10 'Opening stock (bulk import)', cost 2.00", async () => {
    const b = await bulkCreate("cost", { currentStock: "10", averageCost: "2.00" });
    expect(await state(b.id, b.window, "products.bulk.cost")).toEqual({
      currentStock: 10,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: null,
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 2,
        },
      ],
    });
    const { rows } = await pool.query(
      `SELECT "unitCost", notes FROM "StockMovement" WHERE "productId" = $1`,
      [b.id],
    );
    expect(rows.map((r) => [Number(r.unitCost), r.notes])).toEqual([
      [2, "Opening stock (bulk import)"],
    ]);
    await expectLedgerConsistent(tenantId, [b.id], pool);
  });

  it("products bulk create with opening stock 6 and no cost: the row and the average carry NULL cost", async () => {
    const b = await bulkCreate("nocost", { currentStock: "6" });
    expect(await state(b.id, b.window, "products.bulk.nocost")).toEqual({
      currentStock: 6,
      averageCost: null, // SA-927: master value
      rows: [
        {
          type: "PURCHASE",
          quantity: 6,
          reference: null,
          effectiveAt: "now",
          stockAfter: 6,
          avgCostAfter: null, // SA-927: master value
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [b.id], pool);
  });

  it("products bulk create with no opening stock writes no movement row", async () => {
    const b = await bulkCreate("zero", {});
    expect(await state(b.id, b.window, "products.bulk.zero")).toEqual({
      currentStock: 0,
      averageCost: null,
      rows: [],
    });
  });
});
