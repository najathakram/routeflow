/**
 * Buyer portal visibility, end to end on REAL Postgres (sitting-b schema bundle, stage 1 + 2).
 *
 * The rule under test (`buyer-product-visibility.ts`, L-167: one predicate, never a call-site copy):
 * a product a BUYER may see is active AND `portalVisible` AND (standalone OR its parent is
 * `portalVisible`). A hidden PARENT hides every variant even though the variant's own flag is true.
 * Past orders/invoices are documents, not product reads, and keep showing hidden products. Staff
 * reads never use the predicate. The writer is the real `ProductPortalVisibilityService`.
 *
 * Surfaces driven through REAL services (no mocks of the predicate or of Prisma):
 *   BuyerCatalogService.getCatalog (list, search by exact name), getCatalogCounts, getCategories,
 *   getProductDetail, getFavorites, addFavorite; BuyerController.scanProduct (sku + barcode + a ProductBarcode ROW code, via an
 *   Object.create'd controller holding the real catalog + stock-alert services);
 *   BuyerDashboardService.getDashboard (frequently-ordered / new / featured / suggested rails);
 *   ReplenishmentService.estimates + ShelfService.shelf; StockAlertService.subscribe;
 *   ProductsService.findAll/findOne (STAFF reads); OrdersService.create and updateOrderItems
 *   (CUSTOMER refused, STAFF allowed); ProductPortalVisibilityService.setOne/setBulk + AuditLog.
 * Lowest-level reads (documented where used): the past-order and invoice document reads go straight
 * to `prisma.forTenant().order/invoice.findUnique({include: product})`, the same include the
 * document endpoints use, because the point there is "no visibility predicate on document reads"
 * and OrdersService.findOne/InvoicesService would pull a large harness for no extra proof.
 *
 * WRITTEN, NOT RUN by its author: DB specs are F2's lane (`npm run local:test:db`). F2 adjusts any
 * fixture field the schema demands. Every tenant is a throwaway `qa-buyer-vis-<run>-<n>` slug
 * approved by `assertTestTenant`; each `it` seeds its own tenant(s), and `afterAll` deletes exactly
 * the tenants this run created (best-effort, never masking a test result).
 *
 * KNOWN RISK for case (f): in this tree the CUSTOMER replace-all branch of updateOrderItems (the
 * path a buyer edit really takes) loads products by id with no archived/hidden refusal; only the
 * create() branch and the diff-add branch call `isBuyerVisibleProduct`. The replace-all pin below
 * asserts the intended rule and is expected to go red until that branch refuses too.
 */
jest.mock("../invoices/invoices.service", () => ({
  InvoicesService: jest.fn().mockImplementation(() => ({})),
}));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { ConflictException, Logger, NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { normalizeScanCode } from "@routeflow/scanning";
import { findScanMatches } from "../products/scan-match";
import { buyerVisibilityFor, buyerVisibleProductWhere } from "./buyer-product-visibility";
import { ProductLabelsService } from "../product-labels/product-labels.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { AuditService } from "../audit/audit.service";
import { StorageService } from "../storage/storage.service";
import { AddonService } from "../billing/addon.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { FeatureConfigService } from "../billing/feature-config.service";
import { FeatureOverrideService } from "../billing/feature-override.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { ProductsService } from "../products/products.service";
import { ProductPortalVisibilityService } from "../products/product-portal-visibility.service";
import { OrdersService } from "../orders/orders.service";
import { NO_BACKORDER_VIEW } from "../orders/buyer-backorder-view";
import { PromotionsService } from "../promotions/promotions.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { BuyerController } from "./buyer.controller";
import { RegulatedVisibilityService } from "./regulated-visibility.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const FILE = "buyer-portal-visibility.db.spec.ts";
const AUDIT_ACTION = "product.portal_visibility_changed";

interface Fx {
  tenantId: string;
  slug: string;
  adminUserId: string;
  buyerUserId: string;
  buyerAccountId: string;
  customerId: string;
  /** family parent */
  P: any;
  V1: any;
  V2: any;
  /** a sellable variant that is NOT on the past order: the positive control for the suggested rail */
  V3: any;
  /** standalone */
  S: any;
  /**
   * One ProductBarcode ROW code per product (productId -> code), deliberately != Product.barcode / sku, so the
   * buyer scan's row tier (SA-578) is exercised on every product the matrix hides or shows.
   */
  rowCodes: Record<string, string>;
  orderId: string;
  invoiceId: string;
}

describeDb("buyer portal visibility — the one rule, end to end, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let products: ProductsService;
  let portal: ProductPortalVisibilityService;
  let catalog: BuyerCatalogService;
  let dashboard: BuyerDashboardService;
  let replenishment: ReplenishmentService;
  let shelf: ShelfService;
  let stockAlerts: StockAlertService;
  let restrictions: SellingRestrictionsService;
  let controller: any;
  let orders: any;
  const run = randomUUID().slice(0, 8);
  let seq = 0;
  const tenantIds: string[] = [];
  const buyerAccountIds: string[] = [];
  const emitProductUpdated = jest.fn();

  // ─── harness ────────────────────────────────────────────────────────────────

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    const storage = {
      presignedUrls: jest.fn().mockResolvedValue([]),
      presignedUrl: jest.fn().mockResolvedValue(null),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProductsService,
        { provide: PrismaService, useValue: prisma },
        { provide: StorageService, useValue: storage },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(false) } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        { provide: FeatureOverrideService, useValue: { get: jest.fn().mockResolvedValue(null) } },
        entitlementAuthorityFromEntitlements,
        {
          provide: PlanCatalogService,
          useValue: { upgradeTargetForFlag: jest.fn().mockResolvedValue(null) },
        },
        { provide: RouteFlowGateway, useValue: { emitProductUpdated } },
        {
          provide: FeatureConfigService,
          useValue: { getEffectiveMode: jest.fn().mockResolvedValue("on") },
        },
      ],
    }).compile();
    products = moduleRef.get(ProductsService);

    const systemConfig = new SystemConfigService(
      prisma,
      new EncryptionService({ get: () => undefined } as any),
    );
    // One forgiving gateway: every emit is a no-op spy.
    const gateway: any = new Proxy({}, { get: () => jest.fn() });
    // Same OrdersService harness shape as orders-inline-return-create / buyer-edit-cancelled-line.
    orders = Object.assign(Object.create(OrdersService.prototype), {
      prisma,
      gateway,
      systemConfig,
      entitlements: { hasFlag: async (_t: string, k: string) => k !== "flag.units_prices_v2" },
      sellingRestrictions: {
        getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
        assertLinesSellable: async () => undefined,
      },
      authGuard: { assertAuthorizedOrThrow: async () => undefined },
      promotionsService: { activeForCatalog: async () => [] },
      tenantCtx,
      logger: new Logger(OrdersService.name),
      inlineReturns: {},
      invoicesService: {
        revertLinkedInvoicesForOrderEdit: async () => undefined,
        resyncOrderInvoicesForEdit: async () => [],
        ...INVOICE_EDIT_STUBS,
        reconcileOrderDraftInvoice: async () => undefined,
      },
      creditNotes: { settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }) },
    });

    const visibility = new RegulatedVisibilityService(prisma);
    const promotions = new PromotionsService(prisma);
    // The REAL engine: portal limits (selling restrictions) hide products through the one visibility context.
    restrictions = new SellingRestrictionsService(prisma, new ProductLabelsService(prisma));
    replenishment = new ReplenishmentService(prisma, restrictions);
    shelf = new ShelfService(replenishment, prisma, storage as any);
    stockAlerts = new StockAlertService(prisma, {} as any, restrictions);
    catalog = new BuyerCatalogService(
      prisma,
      products,
      storage as any,
      visibility,
      orders,
      replenishment,
      promotions,
      // OOS PR2: this spec is about portal visibility; the buyer cannot backorder here.
      { resolve: async () => NO_BACKORDER_VIEW } as any,
      restrictions,
    );
    dashboard = new BuyerDashboardService(prisma, storage as any, visibility, restrictions);
    // scanProduct only touches prisma + the catalog + stock-alert services.
    controller = Object.assign(Object.create(BuyerController.prototype), {
      prisma,
      catalogService: catalog,
      stockAlertService: stockAlerts,
    });
    portal = new ProductPortalVisibilityService(prisma, new AuditService(prisma), {
      emitProductUpdated,
    } as any);
  }, 120_000);

  afterAll(async () => {
    const del = async (model: string, where: Record<string, unknown>) => {
      try {
        await (raw as any)[model]?.deleteMany({ where });
      } catch {
        // Best-effort: a failed cleanup must never mask a test's own result.
      }
    };
    for (const tenantId of tenantIds) {
      const t = { tenantId };
      for (const m of [
        "auditLog",
        "stockAlert",
        "buyerFavorite",
        "customerPrice",
        "invoiceItem",
        "invoice",
        "orderRevision",
        "orderItem",
        "order",
        "stockMovement",
        "productUnit",
        "sellingRestriction",
        "productCategoryLabel",
      ]) {
        // eslint-disable-next-line no-await-in-loop
        await del(m, t);
      }
      // eslint-disable-next-line no-await-in-loop
      await del("product", { tenantId, parentProductId: { not: null } });
      // eslint-disable-next-line no-await-in-loop
      await del("product", t);
      await del("productCategory", t);
      for (const m of ["customerAddress", "customerLink", "customer", "user", "systemConfig"]) {
        // eslint-disable-next-line no-await-in-loop
        await del(m, t);
      }
      // eslint-disable-next-line no-await-in-loop
      await raw.tenant.deleteMany({ where: { id: tenantId } }).catch(() => undefined);
    }
    await del("buyerAccount", { id: { in: buyerAccountIds } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  // ─── seeding ────────────────────────────────────────────────────────────────

  let barcodeSeq = 0;
  const nextBarcode = () =>
    `8${String(Date.now()).slice(-8)}${String(++barcodeSeq).padStart(3, "0")}`;

  /**
   * One tenant: family parent P (kind FAMILY) with variants V1, V2; standalone S; a buyer customer
   * with an ACTIVE CustomerLink and a favourite of S; one past DELIVERED order + SENT invoice
   * containing V1, V2 and S. Names are the SAME in every tenant (isolation case) plus the run id.
   */
  async function seedTenant(label: string): Promise<Fx> {
    seq += 1;
    const slug = assertTestTenant(`qa-buyer-vis-${run}-${seq}-${label}`, FILE);
    const tenantId = (await raw.tenant.create({ data: { slug, name: `BuyerVis ${slug}` } })).id;
    tenantIds.push(tenantId);

    const mkUser = (role: "TENANT_ADMIN" | "CUSTOMER", tag: string) =>
      raw.user.create({
        data: {
          email: `${tag}-${run}-${seq}@example.test`,
          username: `${tag}-${run}-${seq}`,
          role,
          tenantId,
        },
      });
    const admin = await mkUser("TENANT_ADMIN", "admin");
    const buyerUser = await mkUser("CUSTOMER", "buyer");
    const customer = await raw.customer.create({
      data: {
        userId: buyerUser.id,
        businessName: "Acme Wholesale Foods",
        contactName: "Acme Buyer",
        tenantId,
      },
    });
    const buyerAccount = await raw.buyerAccount.create({
      data: {
        email: `ba-${run}-${seq}@example.test`,
        passwordHash: "x",
        name: "Acme Buyer",
        emailVerified: true,
      },
    });
    buyerAccountIds.push(buyerAccount.id);
    await raw.customerLink.create({
      data: {
        buyerAccountId: buyerAccount.id,
        customerId: customer.id,
        tenantId,
        status: "ACTIVE",
        linkedAt: new Date(),
      },
    });

    const mkProduct = (name: string, extra: Record<string, unknown>) =>
      raw.product.create({
        data: {
          tenantId,
          name,
          sku: `${extra.skuTag ?? "SKU"}-${run}-${seq}`.replace("undefined", ""),
          barcode: nextBarcode(),
          unit: "case",
          unitsPerBox: 12,
          pricePerUnit: "10.00",
          currentStock: 100,
          ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "skuTag")),
        } as any,
      });
    const P = await mkProduct(`Acme Soda ${run}`, {
      skuTag: "P",
      kind: "FAMILY",
      category: "Acme Family",
    });
    const V1 = await mkProduct(`Acme Soda Cherry ${run}`, {
      skuTag: "V1",
      kind: "VARIANT",
      parentProductId: P.id,
      variantName: "Cherry",
      category: "Acme Family",
      isFeatured: true,
    });
    const V2 = await mkProduct(`Acme Soda Lime ${run}`, {
      skuTag: "V2",
      kind: "VARIANT",
      parentProductId: P.id,
      variantName: "Lime",
      category: "Acme Family",
    });
    // Positive control (Opus #2856 r2): sellable, in a rail-eligible category, NOT on the past order, so it is the one
    // product the "suggested" rail can show (P, the FAMILY container, never can).
    const V3 = await mkProduct(`Acme Soda Mango ${run}`, {
      skuTag: "V3",
      kind: "VARIANT",
      parentProductId: P.id,
      variantName: "Mango",
      category: "Acme Family",
    });
    const S = await mkProduct(`Acme Crackers ${run}`, {
      skuTag: "S",
      category: "Acme Solo",
      isFeatured: true,
    });

    await raw.buyerFavorite.create({
      data: { buyerAccountId: buyerAccount.id, customerId: customer.id, productId: S.id, tenantId },
    });

    // A row code per product that is NOT its legacy barcode or sku: a scan of it can only resolve through the
    // ProductBarcode tier, which must apply the buyer visibility scope exactly like the legacy columns do.
    const rowCodes: Record<string, string> = {};
    for (const [tag, p] of Object.entries({ P, V1, V2, V3, S })) {
      const code = `ROW-${tag}-${run}-${seq}`;
      await raw.productBarcode.create({
        data: {
          tenantId,
          productId: p.id,
          code,
          level: "UNIT",
          symbology: "CODE128",
          origin: "ENTERED",
        },
      });
      rowCodes[p.id] = code;
    }

    const lines = [V1, V2, S].map((p) => ({
      tenantId,
      productId: p.id,
      qty: 2,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: "10.00",
      subtotal: "20.00",
      status: "DELIVERED" as const,
    }));
    const order = await raw.order.create({
      data: {
        tenantId,
        customerId: customer.id,
        status: "DELIVERED",
        subtotal: "60.00",
        total: "60.00",
        lineItems: { create: lines as any },
      },
    });
    const invoice = await raw.invoice.create({
      data: {
        tenantId,
        invoiceNumber: `INV-BV-${run}-${seq}`,
        customerId: customer.id,
        orderId: order.id,
        status: "SENT",
        subtotal: "60.00",
        total: "60.00",
        items: {
          create: [V1, V2, S].map((p) => ({
            tenantId,
            description: p.name,
            productId: p.id,
            qty: "2",
            unitPrice: "10.00",
            subtotal: "20.00",
          })) as any,
        },
      },
    });

    return {
      tenantId,
      slug,
      adminUserId: admin.id,
      buyerUserId: buyerUser.id,
      buyerAccountId: buyerAccount.id,
      customerId: customer.id,
      P,
      V1,
      V2,
      V3,
      S,
      rowCodes,
      orderId: order.id,
      invoiceId: invoice.id,
    };
  }

  const inTenant = <T>(f: Fx, fn: () => Promise<T>) => tenantCtx.run(f.tenantId, fn);

  const principal = (f: Fx, role: "CUSTOMER" | "TENANT_ADMIN"): JwtPayload =>
    ({
      sub: role === "CUSTOMER" ? f.buyerUserId : f.adminUserId,
      username: `${role.toLowerCase()}-${run}`,
      role,
      status: "ACTIVE",
      forcePasswordChange: false,
      tenantId: f.tenantId,
      tenantSlug: f.slug,
    }) as JwtPayload;

  const setOne = (f: Fx, id: string, visible: boolean) =>
    inTenant(f, () => portal.setOne(id, visible, f.adminUserId));

  // ─── buyer / staff views ────────────────────────────────────────────────────

  const ids = (rows: Array<Record<string, any>>, key = "id") => new Set(rows.map((r) => r[key]));

  /** Everything a buyer can list, count or be served as a rail, read through the real services. */
  async function buyerView(f: Fx) {
    return inTenant(f, async () => {
      const list = await catalog.getCatalog({ limit: 100 }, f.customerId, f.buyerAccountId);
      const counts = await catalog.getCatalogCounts(f.customerId, f.buyerAccountId);
      const categories = (await catalog.getCategories(f.customerId)) as string[];
      const favorites = await catalog.getFavorites(f.buyerAccountId, f.customerId);
      const dash = await dashboard.getDashboard(f.customerId);
      const replen = await replenishment.estimates(f.customerId);
      const shelfRows = await shelf.shelf(f.customerId);
      return {
        list: ids(list.data),
        counts,
        countCategoryNames: counts.categories.map((c: any) => c.name),
        categories,
        favorites: ids(
          (favorites as any[]).filter((x) => !x.unavailable),
          "productId",
        ),
        favoriteStubs: (favorites as any[]).filter((x) => x.unavailable === true),
        frequent: ids(dash.frequentlyOrdered, "productId"),
        newRail: ids(dash.newFromSeller),
        featured: ids(dash.featuredItems),
        suggested: ids(dash.suggestedItems),
        replen: ids(replen, "productId"),
        shelf: ids(shelfRows, "productId"),
      };
    });
  }
  type View = Awaited<ReturnType<typeof buyerView>>;

  const asBool = async (fn: () => Promise<unknown>, reachableOn: unknown[] = []) => {
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof NotFoundException) return false;
      if (reachableOn.some((c) => e instanceof (c as any))) return true;
      throw e;
    }
  };

  /** Per-product point reads: search by exact name, detail, sku + barcode scan (+ writes on request). */
  async function probe(f: Fx, p: any, opts: { write?: boolean } = {}) {
    return inTenant(f, async () => {
      const search = await catalog.getCatalog({ search: p.name, limit: 100 }, f.customerId);
      const scan = (code: string) =>
        asBool(() =>
          controller.scanProduct(code, { customerId: f.customerId, tenantId: f.tenantId }),
        );
      return {
        search: search.data.some((r: any) => r.id === p.id),
        detail: await asBool(() => catalog.getProductDetail(p.id, f.customerId)),
        scanSku: await scan(p.sku),
        scanBarcode: await scan(p.barcode),
        // a ProductBarcode ROW code (!= barcode, != sku): the row tier honours the same buyer scope
        scanRow: await scan(f.rowCodes[p.id]),
        // The row tier ALONE, with the buyer scope: scanProduct's getProductDetail 404s any product the buyer
        // cannot see on its own, so the endpoint cannot tell a scoped row tier from an unscoped one. This can.
        scanRowLookup:
          (await findScanMatches(
            prisma.forTenant(),
            normalizeScanCode(f.rowCodes[p.id]),
            buyerVisibleProductWhere(
              await buyerVisibilityFor(restrictions, f.tenantId, f.customerId),
            ),
          )) !== null,
        ...(opts.write
          ? {
              subscribe: await asBool(() => stockAlerts.subscribe(f.customerId, p.id, f.tenantId)),
              addFavorite: await asBool(
                () => catalog.addFavorite(f.buyerAccountId, f.customerId, p.id, f.tenantId),
                [ConflictException],
              ),
            }
          : {}),
      };
    });
  }

  /** STAFF reads never use the buyer predicate: list + detail still return the product. */
  async function staffSees(f: Fx, p: any) {
    return inTenant(f, async () => {
      const all = await products.findAll({ limit: 100 } as any);
      const one = await products.findOne(p.id).catch(() => null);
      return { inList: all.data.some((r: any) => r.id === p.id), detail: one?.id === p.id };
    });
  }

  /** What each rail shows for one product, given what the fixture put on it. */
  function expectSurfaces(
    f: Fx,
    v: View,
    p: any,
    visibleIn: boolean,
    hiddenBy: "curation" | "restriction" = "curation",
  ) {
    const id = p.id;
    // P is a FAMILY container (kind FAMILY, WS6/Q3): NON-SELLABLE, so it is in no buyer read whether hidden or not.
    const visible = id === f.P.id ? false : visibleIn;
    expect(v.list.has(id)).toBe(visible);
    expect(v.newRail.has(id)).toBe(visible);
    if ([f.V1.id, f.V2.id, f.S.id].includes(id)) {
      // on the past order: frequently-ordered, replenishment, shelf
      expect(v.frequent.has(id)).toBe(visible);
      expect(v.replen.has(id)).toBe(visible);
      expect(v.shelf.has(id)).toBe(visible);
    }
    if ([f.V1.id, f.S.id].includes(id)) expect(v.featured.has(id)).toBe(visible);
    if (id === f.S.id) {
      expect(v.favorites.has(id)).toBe(visible);
      // SA-606 M3: a favourite the tenant hid is kept as a name-only "No longer available online" stub: no price.
      // A product a selling restriction hides from this buyer is "hidden completely" (owner): the row is dropped.
      const stub = v.favoriteStubs.find((x: any) => x.productId === id);
      expect(Boolean(stub)).toBe(!visible && hiddenBy === "curation");
      if (stub) {
        expect(stub).toMatchObject({
          unavailable: true,
          unavailableText: "No longer available online",
        });
        expect(stub).not.toHaveProperty("buyerPrice");
      }
    }
    // V3 is the ONLY sellable product in a rail-eligible category that is not on the order: suggested when visible, absent
    // when it or its parent is hidden. P (the FAMILY container) never appears there.
    if (id === f.V3.id) expect(v.suggested.has(id)).toBe(visible);
    if (id === f.P.id) expect(v.suggested.has(id)).toBe(false);
  }

  async function expectProbe(f: Fx, p: any, visibleIn: boolean, write = false) {
    const visible = p.id === f.P.id ? false : visibleIn; // FAMILY container: never buyer-visible
    const r = await probe(f, p, { write });
    expect(r.search).toBe(visible);
    expect(r.detail).toBe(visible);
    expect(r.scanSku).toBe(visible);
    expect(r.scanBarcode).toBe(visible);
    // hidden product / hidden-parent variant / FAMILY container => 404 by row code too; visible control => 200
    expect(r.scanRow).toBe(visible);
    expect(r.scanRowLookup).toBe(visible);
    if (write) {
      expect((r as any).subscribe).toBe(visible);
      expect((r as any).addFavorite).toBe(visible);
    }
  }

  async function expectStaffSees(f: Fx, p: any) {
    expect(await staffSees(f, p)).toEqual({ inList: true, detail: true });
  }

  // ─── (a) all visible ────────────────────────────────────────────────────────

  it("(a) all visible: every buyer read includes the variants and the standalone product (P, the FAMILY container, never)", async () => {
    const f = await seedTenant("a-all");
    const v = await buyerView(f);
    for (const p of [f.P, f.V1, f.V2, f.V3, f.S]) expectSurfaces(f, v, p, true);
    expect(v.counts.total).toBe(4); // V1, V2, V3, S (the FAMILY parent P is not sellable)
    expect(v.countCategoryNames.sort()).toEqual(["Acme Family", "Acme Solo"]);
    expect(v.counts.categories.find((c: any) => c.name === "Acme Family")?.count).toBe(3);
    expect([...v.categories].sort()).toEqual(["Acme Family", "Acme Solo"]);
    // Point reads + the two writes (positive control that the harness can subscribe / favourite).
    await expectProbe(f, f.S, true, true);
    await expectProbe(f, f.V1, true, true);
    await expectProbe(f, f.V2, true);
  });

  // ─── (b) hide a standalone product ──────────────────────────────────────────

  it("(b) hiding standalone S removes it from every buyer read while STAFF still see it", async () => {
    const f = await seedTenant("b-solo");
    expect(await setOne(f, f.S.id, false)).toEqual({ id: f.S.id, portalVisible: false });

    const v = await buyerView(f);
    expectSurfaces(f, v, f.S, false);
    for (const p of [f.P, f.V1, f.V2, f.V3]) expectSurfaces(f, v, p, true);
    expect(v.counts.total).toBe(3);
    expect(v.countCategoryNames).toEqual(["Acme Family"]); // S was the only "Acme Solo" product
    expect(v.categories).toEqual(["Acme Family"]);

    // search by its exact name, detail (404), sku + barcode scan, stock-alert subscribe, add-favourite
    await expectProbe(f, f.S, false, true);
    await expectStaffSees(f, f.S);
    // the siblings are untouched
    await expectProbe(f, f.V1, true);
  });

  // ─── (c) hide the parent ────────────────────────────────────────────────────

  it("(c) hiding PARENT P hides V1 and V2 though their own flag is true; unhiding P restores", async () => {
    const f = await seedTenant("c-parent");
    await setOne(f, f.P.id, false);
    const variantFlags = await raw.product.findMany({
      where: { id: { in: [f.V1.id, f.V2.id] } },
      select: { portalVisible: true },
    });
    expect(variantFlags.map((r) => r.portalVisible)).toEqual([true, true]); // no cascade write

    const hidden = await buyerView(f);
    for (const p of [f.P, f.V1, f.V2, f.V3]) expectSurfaces(f, hidden, p, false);
    expectSurfaces(f, hidden, f.S, true);
    expect(hidden.counts.total).toBe(1);
    expect(hidden.categories).toEqual(["Acme Solo"]);
    expect(hidden.countCategoryNames).toEqual(["Acme Solo"]);
    for (const p of [f.P, f.V1, f.V2, f.V3]) {
      // eslint-disable-next-line no-await-in-loop
      await expectProbe(f, p, false, true);
      // eslint-disable-next-line no-await-in-loop
      await expectStaffSees(f, p);
    }
    await expectProbe(f, f.S, true);

    await setOne(f, f.P.id, true);
    const back = await buyerView(f);
    for (const p of [f.P, f.V1, f.V2, f.V3, f.S]) expectSurfaces(f, back, p, true);
    expect(back.counts.total).toBe(4);
    await expectProbe(f, f.V1, true);
    await expectProbe(f, f.V2, true);
  });

  // ─── (d) hide one variant ───────────────────────────────────────────────────

  it("(d) hiding V1 only: V2 and S stay visible (P is a FAMILY container, never buyer-visible)", async () => {
    const f = await seedTenant("d-variant");
    await setOne(f, f.V1.id, false);
    const v = await buyerView(f);
    expectSurfaces(f, v, f.V1, false);
    for (const p of [f.P, f.V2, f.V3, f.S]) expectSurfaces(f, v, p, true);
    expect(v.counts.total).toBe(3);
    await expectProbe(f, f.V1, false, true);
    await expectProbe(f, f.V2, true);
    await expectProbe(f, f.P, true);
    await expectStaffSees(f, f.V1);
  });

  // ─── (e) documents are not product reads ────────────────────────────────────

  it("(e) the past order and invoice that contain hidden V1 still return it", async () => {
    const f = await seedTenant("e-docs");
    await setOne(f, f.V1.id, false);
    // Lowest-level document reads (see header): no visibility predicate exists on these reads.
    const { order, invoice } = await inTenant(f, async () => ({
      order: await prisma.forTenant().order.findUnique({
        where: { id: f.orderId },
        include: { lineItems: { include: { product: { select: { id: true, name: true } } } } },
      }),
      invoice: await prisma.forTenant().invoice.findUnique({
        where: { id: f.invoiceId },
        include: { items: true },
      }),
    }));
    const orderLine = order!.lineItems.find((l: any) => l.productId === f.V1.id);
    expect(orderLine?.product?.id).toBe(f.V1.id);
    expect(order!.lineItems).toHaveLength(3);
    expect(invoice!.items.some((i: any) => i.productId === f.V1.id)).toBe(true);
    expect(invoice!.items).toHaveLength(3);

    // Same for a hidden PARENT: every variant line stays on the documents.
    await setOne(f, f.P.id, false);
    const again = await inTenant(f, () =>
      prisma.forTenant().order.findUnique({
        where: { id: f.orderId },
        include: { lineItems: { include: { product: { select: { id: true } } } } },
      }),
    );
    expect(again!.lineItems.map((l: any) => l.product?.id).sort()).toEqual(
      [f.V1.id, f.V2.id, f.S.id].sort(),
    );
  });

  // ─── (f) order writes ───────────────────────────────────────────────────────

  describe("(f) order writes: a CUSTOMER cannot add a hidden product, STAFF can", () => {
    const counts = (f: Fx) =>
      inTenant(f, async () => ({
        orders: await raw.order.count({ where: { tenantId: f.tenantId } }),
        items: await raw.orderItem.count({ where: { order: { tenantId: f.tenantId } } }),
        stock: (await raw.product.findMany({ where: { tenantId: f.tenantId } }))
          .map((p) => `${p.id}:${Number(p.currentStock)}`)
          .sort(),
      }));

    const buyerCreate = (f: Fx, productId: string) =>
      inTenant(f, () =>
        orders.create({ items: [{ productId, qty: 1 }] }, principal(f, "CUSTOMER"), {
          skipAutoMerge: true,
        }),
      );
    const staffCreate = (f: Fx, productId: string) =>
      inTenant(f, () =>
        orders.create(
          { customerId: f.customerId, items: [{ productId, qty: 1 }] },
          principal(f, "TENANT_ADMIN"),
          { skipAutoMerge: true },
        ),
      );

    /** SA-606 WS6: the buyer refusal is the existing 409 envelope naming the hidden product. */
    const hiddenBody = (productId: string) => ({
      code: "SELLING_RESTRICTED",
      blockedLines: [expect.objectContaining({ productId, reason: "HIDDEN_FROM_PORTAL" })],
    });

    it("create: hidden standalone product => 409 SELLING_RESTRICTED (HIDDEN_FROM_PORTAL), nothing persisted; staff create succeeds", async () => {
      const f = await seedTenant("f-create-solo");
      // Positive control first: a VISIBLE product creates for the buyer (harness is sound).
      await expect(buyerCreate(f, f.V2.id)).resolves.toBeDefined();
      await setOne(f, f.S.id, false);
      const before = await counts(f);
      await expect(buyerCreate(f, f.S.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(buyerCreate(f, f.S.id)).rejects.toMatchObject({ response: hiddenBody(f.S.id) });
      expect(await counts(f)).toEqual(before);

      const staffOrder = await staffCreate(f, f.S.id);
      expect(staffOrder).toBeDefined();
      expect((await counts(f)).orders).toBe(before.orders + 1);
    });

    it("create: a product under a hidden PARENT => 409 SELLING_RESTRICTED, nothing persisted; staff create succeeds", async () => {
      const f = await seedTenant("f-create-parent");
      await setOne(f, f.P.id, false);
      const before = await counts(f);
      await expect(buyerCreate(f, f.V1.id)).rejects.toBeInstanceOf(ConflictException);
      await expect(buyerCreate(f, f.V1.id)).rejects.toMatchObject({
        response: hiddenBody(f.V1.id),
      });
      expect(await counts(f)).toEqual(before);

      await expect(staffCreate(f, f.V1.id)).resolves.toBeDefined();
      expect((await counts(f)).orders).toBe(before.orders + 1);
    });

    it("updateOrderItems (buyer full replace): naming a hidden product or a product under a hidden parent => 409 SELLING_RESTRICTED HIDDEN_FROM_PORTAL, rows unchanged", async () => {
      const f = await seedTenant("f-update");
      const open = await raw.order.create({
        data: {
          tenantId: f.tenantId,
          customerId: f.customerId,
          status: "PENDING",
          subtotal: "20.00",
          total: "20.00",
          lineItems: {
            create: [
              {
                tenantId: f.tenantId,
                productId: f.V2.id,
                qty: 12,
                boxes: 1,
                pieces: 0,
                unitsPerBox: 12,
                unitPrice: "10.00",
                subtotal: "10.00",
              },
            ] as any,
          },
        },
      });
      const rows = () =>
        raw.orderItem.findMany({ where: { orderId: open.id }, orderBy: { createdAt: "asc" } });
      const edit = (items: any[]) =>
        inTenant(f, () => orders.updateOrderItems(open.id, { items }, principal(f, "CUSTOMER")));
      const before = await rows();

      await setOne(f, f.S.id, false);
      await expect(
        edit([
          { productId: f.V2.id, qty: 12 },
          { productId: f.S.id, qty: 12 },
        ]),
      ).rejects.toMatchObject({ response: hiddenBody(f.S.id) });
      expect(await rows()).toEqual(before);

      await setOne(f, f.S.id, true);
      await setOne(f, f.P.id, false);
      await expect(
        edit([
          { productId: f.V2.id, qty: 12 }, // V2 is itself under the hidden parent
          { productId: f.V1.id, qty: 12 },
        ]),
      ).rejects.toMatchObject({ response: hiddenBody(f.V1.id) });
      expect(await rows()).toEqual(before);

      // Unhidden again: the same edit is accepted (the refusal was the rule, not the harness).
      await setOne(f, f.P.id, true);
      await expect(edit([{ productId: f.V2.id, qty: 12 }])).resolves.toBeDefined();
    });
  });

  // ─── (g) tenant isolation ───────────────────────────────────────────────────

  it("(g) hiding a product in tenant A changes nothing in tenant B (same names)", async () => {
    const a = await seedTenant("g-a");
    const b = await seedTenant("g-b");
    expect(a.S.name).toBe(b.S.name);
    const bBefore = await buyerView(b);

    await setOne(a, a.S.id, false);
    await setOne(a, a.P.id, false);

    const aView = await buyerView(a);
    expect(aView.counts.total).toBe(0);
    const bAfter = await buyerView(b);
    expect(bAfter.counts.total).toBe(4);
    expect(bAfter.list).toEqual(bBefore.list);
    expect(bAfter.categories).toEqual(bBefore.categories);
    for (const p of [b.P, b.V1, b.V2, b.S]) expectSurfaces(b, bAfter, p, true);
    await expectProbe(b, b.S, true);
    await expectProbe(a, a.S, false);
    // B's rows were never written.
    const bFlags = await raw.product.findMany({ where: { tenantId: b.tenantId } });
    expect(bFlags.every((p) => p.portalVisible)).toBe(true);
    // A cross-tenant id is not addressable through A's writer.
    await expect(setOne(a, b.S.id, false)).rejects.toBeInstanceOf(NotFoundException);
    expect((await raw.product.findUniqueOrThrow({ where: { id: b.S.id } })).portalVisible).toBe(
      true,
    );
  });

  // ─── (h) bulk writer ────────────────────────────────────────────────────────

  describe("(h) setBulk", () => {
    const auditRows = (f: Fx, entityIds?: string[]) =>
      raw.auditLog.findMany({
        where: {
          tenantId: f.tenantId,
          action: AUDIT_ACTION,
          ...(entityIds ? { entityId: { in: entityIds } } : {}),
        },
      });
    const flags = async (pids: string[]) =>
      Object.fromEntries(
        (await raw.product.findMany({ where: { id: { in: pids } } })).map((p) => [
          p.id,
          p.portalVisible,
        ]),
      );

    it("hides [S, V2] together: one AuditLog row per changed product, none for unchanged ones", async () => {
      const f = await seedTenant("h-bulk");
      const res = await inTenant(f, () => portal.setBulk([f.S.id, f.V2.id], false, f.adminUserId));
      expect(res).toEqual({ portalVisible: false, updated: 2, unchanged: 0 });
      expect(await flags([f.S.id, f.V2.id])).toEqual({ [f.S.id]: false, [f.V2.id]: false });
      const rows = await auditRows(f);
      expect(rows.map((r) => r.entityId).sort()).toEqual([f.S.id, f.V2.id].sort());
      expect(rows.every((r) => r.entityType === "Product" && r.userId === f.adminUserId)).toBe(
        true,
      );
      expect(
        rows.every((r) => (r.meta as any)?.from === true && (r.meta as any)?.to === false),
      ).toBe(true);

      // Mixed: S is already hidden, V1 is not => only V1 changes and only V1 is audited.
      const mixed = await inTenant(f, () =>
        portal.setBulk([f.S.id, f.V1.id], false, f.adminUserId),
      );
      expect(mixed).toEqual({ portalVisible: false, updated: 1, unchanged: 1 });
      expect((await auditRows(f)).length).toBe(3);
      expect((await auditRows(f, [f.V1.id])).length).toBe(1);
      expect((await auditRows(f, [f.S.id])).length).toBe(1); // still only the first write's row

      // Fully unchanged: no writes, no audit rows.
      const noop = await inTenant(f, () => portal.setBulk([f.S.id, f.V2.id], false, f.adminUserId));
      expect(noop).toEqual({ portalVisible: false, updated: 0, unchanged: 2 });
      expect((await auditRows(f)).length).toBe(3);
    });

    it("is all-or-nothing: one foreign-tenant id aborts with 404 and leaves both products unchanged", async () => {
      const f = await seedTenant("h-abort-a");
      const other = await seedTenant("h-abort-b");
      await expect(
        inTenant(f, () => portal.setBulk([f.S.id, f.V2.id, other.S.id], false, f.adminUserId)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await flags([f.S.id, f.V2.id])).toEqual({ [f.S.id]: true, [f.V2.id]: true });
      expect(
        (await raw.product.findUniqueOrThrow({ where: { id: other.S.id } })).portalVisible,
      ).toBe(true);
      expect((await auditRows(f)).length).toBe(0);
      expect((await auditRows(other)).length).toBe(0);
      // An unknown id in an otherwise valid list behaves the same.
      await expect(
        inTenant(f, () => portal.setBulk([f.S.id, randomUUID()], false, f.adminUserId)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await flags([f.S.id])).toEqual({ [f.S.id]: true });
    });
  });
  // ─── portal limits: selling restrictions hide products from the buyer portal (lane A) ──────────

  describe("portal limits: a selling restriction hides products from the portal, on every buyer surface", () => {
    const ruleBase = {
      jurisdiction: "STATE" as const,
      states: ["TX"],
      surface: "BUYER_PORTAL" as const,
      reason: "Portal limit",
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
    };
    const addState = (f: Fx, state: string) =>
      raw.customerAddress.create({
        data: {
          tenantId: f.tenantId,
          customerId: f.customerId,
          line1: "1 Test St",
          city: "Testville",
          state,
          stateCode: state,
          zip: "00000",
          isDefault: true,
          addressType: "BILLING",
        },
      });
    const productRule = (f: Fx, productId: string, over: Record<string, unknown> = {}) =>
      raw.sellingRestriction.create({
        data: { tenantId: f.tenantId, productId, ...ruleBase, ...over } as any,
      });
    const categoryRule = (f: Fx, categoryId: string, over: Record<string, unknown> = {}) =>
      raw.sellingRestriction.create({
        data: { tenantId: f.tenantId, categoryId, ...ruleBase, ...over } as any,
      });
    const mkCategory = (f: Fx, name: string) =>
      raw.productCategory.create({ data: { tenantId: f.tenantId, name } });
    const include = (f: Fx, productId: string, categoryId: string) =>
      raw.productCategoryLabel.create({
        data: { tenantId: f.tenantId, productId, categoryId, mode: "INCLUDE" },
      });
    const check = (f: Fx, p: any, channel: "BUYER_PORTAL" | "STAFF" = "BUYER_PORTAL") =>
      inTenant(f, () =>
        restrictions.checkLinesSellable({
          tenantId: f.tenantId,
          customerId: f.customerId,
          lines: [{ productId: p.id, qtyDelta: 1 }],
          channel,
        }),
      );

    it("(a) a TX buyer and a TX BUYER_PORTAL product rule: list, search, counts, detail, scan, rails, favourites, replenishment and alerts all exclude it; staff still see it", async () => {
      const f = await seedTenant("sr-a");
      await addState(f, "TX");
      await productRule(f, f.S.id);

      const v = await buyerView(f);
      expectSurfaces(f, v, f.S, false, "restriction");
      for (const p of [f.P, f.V1, f.V2, f.V3]) expectSurfaces(f, v, p, true);
      expect(v.counts.total).toBe(3);
      expect(v.categories).toEqual(["Acme Family"]);
      await expectProbe(f, f.S, false, true);
      await expectProbe(f, f.V1, true);
      await expectStaffSees(f, f.S);
      // past documents are untouched
      const order = await inTenant(f, () =>
        prisma.forTenant().order.findUnique({
          where: { id: f.orderId },
          include: { lineItems: { include: { product: true } } },
        }),
      );
      expect(order?.lineItems.some((l: any) => l.productId === f.S.id)).toBe(true);
    });

    it("(a2) the same rule leaves a buyer in another state seeing everything", async () => {
      const f = await seedTenant("sr-a2");
      await addState(f, "NY");
      await productRule(f, f.S.id);
      const v = await buyerView(f);
      for (const p of [f.P, f.V1, f.V2, f.V3, f.S]) expectSurfaces(f, v, p, true);
      await expectProbe(f, f.S, true, true);
    });

    it("(a3) a product rule on the family parent hides every variant under it", async () => {
      const f = await seedTenant("sr-a3");
      await addState(f, "TX");
      await productRule(f, f.P.id);
      const v = await buyerView(f);
      for (const p of [f.V1, f.V2, f.V3]) expectSurfaces(f, v, p, false);
      expectSurfaces(f, v, f.S, true);
      expect(v.counts.total).toBe(1);
    });

    it("(b) a category rule hides a variant through its parent's label (the EXCLUDE opt-out is proven in selling-restrictions/portal-limits-variants.db.spec.ts)", async () => {
      const f = await seedTenant("sr-b");
      await addState(f, "TX");
      const cat = await mkCategory(f, "Limited");
      await include(f, f.P.id, cat.id);
      await categoryRule(f, cat.id);
      const v = await buyerView(f);
      for (const p of [f.V1, f.V2, f.V3]) expectSurfaces(f, v, p, false);
      expectSurfaces(f, v, f.S, true);
      expect((await check(f, f.V1)).outcome).toBe("BLOCK");
      expect((await check(f, f.S)).outcome).toBe("ALLOW");
    });

    it("(c) a buyer with no state on file still sees a portal-limit product, and checkout ALLOWs", async () => {
      const f = await seedTenant("sr-c");
      await productRule(f, f.S.id);
      const v = await buyerView(f);
      expectSurfaces(f, v, f.S, true);
      await expectProbe(f, f.S, true, true);
      expect((await check(f, f.S)).outcome).toBe("ALLOW");
    });

    it("(d) a buyer with no state on file does NOT see a legal-ban (surface ALL) product, and checkout 409s", async () => {
      const f = await seedTenant("sr-d");
      await productRule(f, f.S.id, { surface: "ALL" });
      const v = await buyerView(f);
      expectSurfaces(f, v, f.S, false, "restriction");
      await expectProbe(f, f.S, false);
      await expect(
        inTenant(f, () =>
          restrictions.assertLinesSellable({
            tenantId: f.tenantId,
            customerId: f.customerId,
            lines: [{ productId: f.S.id, qtyDelta: 1 }],
            channel: "BUYER_PORTAL",
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("(e) the switch is staff-only: with it off a portal rule still hides and 409s the portal, and staff are not gated", async () => {
      const f = await seedTenant("sr-e"); // no SystemConfig row = switch OFF
      await addState(f, "TX");
      await productRule(f, f.S.id);
      expect((await check(f, f.S, "BUYER_PORTAL")).outcome).toBe("BLOCK");
      expect((await check(f, f.S, "STAFF")).outcome).toBe("OFF");
      const v = await buyerView(f);
      expectSurfaces(f, v, f.S, false, "restriction");
    });

    it("(g) a rule with a future effectiveFrom does not hide yet, and hides at/after it", async () => {
      const f = await seedTenant("sr-g");
      await addState(f, "TX");
      const from = new Date(Date.now() + 2 * 86_400_000);
      await productRule(f, f.S.id, { effectiveFrom: from });
      const now = await buyerView(f);
      expectSurfaces(f, now, f.S, true);
      const later = await inTenant(f, () =>
        restrictions.restrictedProductIdsFor(
          f.tenantId,
          f.customerId,
          new Date(from.getTime() + 1),
        ),
      );
      expect(later.has(f.S.id)).toBe(true);
      const before = await inTenant(f, () =>
        restrictions.restrictedProductIdsFor(
          f.tenantId,
          f.customerId,
          new Date(from.getTime() - 1),
        ),
      );
      expect(before.has(f.S.id)).toBe(false);
    });

    it("(j) a back-in-stock fire never pushes a restricted buyer and leaves their alert PENDING; lifting the limit lets it fire", async () => {
      const f = await seedTenant("sr-j");
      await addState(f, "TX");
      await productRule(f, f.S.id);
      await raw.stockAlert.create({
        data: {
          tenantId: f.tenantId,
          customerId: f.customerId,
          productId: f.S.id,
          status: "PENDING",
        },
      });
      const push = jest.fn().mockResolvedValue(1);
      const alerts = new StockAlertService(prisma, { sendToCustomer: push } as any, restrictions);

      const blocked = await inTenant(f, () => alerts.fireForProducts([f.S.id]));
      expect(blocked.notified).toBe(0);
      expect(push).not.toHaveBeenCalled();
      const row = await raw.stockAlert.findFirstOrThrow({
        where: { tenantId: f.tenantId, productId: f.S.id },
      });
      expect(row.status).toBe("PENDING");

      await raw.sellingRestriction.updateMany({
        where: { tenantId: f.tenantId },
        data: { liftedAt: new Date() },
      });
      const lifted = await inTenant(f, () => alerts.fireForProducts([f.S.id]));
      expect(lifted.notified).toBe(1);
      expect(push).toHaveBeenCalledTimes(1);
    });

    it("a lifted rule hides nothing, and an ended rule hides nothing", async () => {
      const f = await seedTenant("sr-lift");
      await addState(f, "TX");
      await productRule(f, f.S.id, { liftedAt: new Date() });
      await productRule(f, f.V1.id, { effectiveTo: new Date(Date.now() - 86_400_000) });
      const v = await buyerView(f);
      expectSurfaces(f, v, f.S, true);
      expectSurfaces(f, v, f.V1, true);
    });
  });
  // H6 (qa-azm 2026-10-13): a family made the way product-families.service makes one stores each variant with
  // name = variantName (the bare label) and NO category. The buyer must still see "<Family> - <Variant>" under the
  // family's category, and find it by the family's name, as the restriction messages name it.
  describe("H6: family variants carry a display name and the family's category on every buyer read", () => {
    async function seedChips(f: Fx) {
      const family = await raw.product.create({
        data: {
          tenantId: f.tenantId,
          name: `Crunch Potato Chips ${run}`,
          sku: `CHIPS-${run}-${seq}`,
          kind: "FAMILY",
          category: "Snacks",
          unit: "case",
          unitsPerBox: 24,
          pricePerUnit: "9.99",
          currentStock: 0,
        } as any,
      });
      const mk = (label: string) =>
        raw.product.create({
          data: {
            tenantId: f.tenantId,
            name: label,
            variantName: label,
            kind: "VARIANT",
            parentProductId: family.id,
            sku: `CHIPS-${label.toUpperCase()}-${run}-${seq}`,
            unit: "case",
            unitsPerBox: 24,
            pricePerUnit: "9.99",
            currentStock: 50,
          } as any,
        });
      const classic = await mk("Classic");
      const bbq = await mk("BBQ");
      return { family, classic, bbq, display: `Crunch Potato Chips ${run} - Classic` };
    }

    it("list tiles name the variant '<Family> - <Variant>' and give it the family's category", async () => {
      const f = await seedTenant("h6-list");
      const c = await seedChips(f);
      const list = await inTenant(f, () =>
        catalog.getCatalog({ limit: 100 }, f.customerId, f.buyerAccountId),
      );
      const tile = list.data.find((r: any) => r.id === c.classic.id) as any;
      expect(tile).toBeDefined();
      expect(tile.name).toBe(c.display);
      expect(tile.category).toBe("Snacks");
    });

    it("search by the family's words ('chips', 'potato chips') finds the variants", async () => {
      const f = await seedTenant("h6-search");
      const c = await seedChips(f);
      for (const q of ["chips", "potato chips", "Crunch"]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await inTenant(f, () =>
          catalog.getCatalog({ search: q, limit: 100 }, f.customerId),
        );
        const got = new Set(r.data.map((x: any) => x.id));
        expect([q, got.has(c.classic.id), got.has(c.bbq.id)]).toEqual([q, true, true]);
      }
      // the family container itself is still never a tile
      const r = await inTenant(f, () =>
        catalog.getCatalog({ search: "chips", limit: 100 }, f.customerId),
      );
      expect(r.data.some((x: any) => x.id === c.family.id)).toBe(false);
    });

    it("the category filter, the category list and the rail counts include the variants under the family's category", async () => {
      const f = await seedTenant("h6-category");
      const c = await seedChips(f);
      const filtered = await inTenant(f, () =>
        catalog.getCatalog({ category: "Snacks", limit: 100 }, f.customerId),
      );
      const ids = new Set(filtered.data.map((x: any) => x.id));
      expect(ids.has(c.classic.id) && ids.has(c.bbq.id)).toBe(true);
      const categories = (await inTenant(f, () => catalog.getCategories(f.customerId))) as string[];
      expect(categories).toContain("Snacks");
      const counts = await inTenant(f, () =>
        catalog.getCatalogCounts(f.customerId, f.buyerAccountId),
      );
      const snacks = counts.categories.find((x: any) => x.name === "Snacks");
      expect(snacks?.count).toBeGreaterThanOrEqual(2);
    });

    it("the product detail of a variant opened directly carries the display name and the family's category", async () => {
      const f = await seedTenant("h6-detail");
      const c = await seedChips(f);
      const d = (await inTenant(f, () =>
        catalog.getProductDetail(c.classic.id, f.customerId),
      )) as any;
      expect(d.name).toBe(c.display);
      expect(d.category).toBe("Snacks");
    });

    it("restriction messages name the variant by its display name", async () => {
      const f = await seedTenant("h6-restriction");
      const c = await seedChips(f);
      const labels = await inTenant(f, () =>
        new ProductLabelsService(prisma).effectiveLabels(f.tenantId, [c.classic.id]),
      );
      expect(labels.get(c.classic.id)?.name).toBe(c.display);
    });
  });
});
