/**
 * I-101 backlog (units tested matrix 2026-10-28), the SALE-LEDGER row: a unit line through the REAL `RegulatedLedgerService.writeSaleEntries`
 * (and the delivered-basis re-sync, `settleRegulatedLedger`) on a TRACKED category, on real Postgres, on the #3918 ladder.
 *
 * Fixture: one family, variants with pack 10, Case 200 (perParent 20), Pallet 4,800 (parent Case, perParent 24); box price 20, so a
 * piece costs 2.00 at every level (Case 400, Pallet 9,600). One variant is tracked under a per-piece EXCISE ($0.25 a piece), one
 * under a PERCENT_OF_SALE levy (10%). Orders are made by the REAL `OrdersService.create`, invoices by the REAL `InvoicesService`.
 * A Case or Pallet line on a tracked product exists only as LEGACY state: both front doors refuse it today (G1), so the fixture
 * attaches the section after the levels, straight in the table. Expected values are the ladder arithmetic written down here, never copied from a run (OP-2: a disagreeing value is a bug to file,
 * not a value to pin):
 *
 *   G1           the units writer refuses a level above the pack on a tracked product (400), and the pack rule `ProductsService.update`
 *                applies refuses attaching a section to a product that has them (409). Pinned: the rule is the design, not a defect.
 *   SALE         3 Cases = 600 pieces: ledger qty 600, unitBasisQty 600 (pieces, NOT 3 units), net 1,200.00, levy 150.00 (excise 600 x 0.25)
 *                or 120.00 (10% of 1,200); 2 Pallets = 9,600 pieces, net 19,200.00, levy 2,400.00 / 1,920.00. The invoice line carries the
 *                same levy, and the ledger row matches the invoice line.
 *   RE-SYNC      a delivery stop (450 of the 3 Cases; 3,000 of 1 Pallet) rebuilds the draft and re-syncs the ledger: the invoice's rows
 *                SUM to the delivered pieces, net and levy (450 pieces = 900.00 net, 112.50 / 90.00 levy; 3,000 pieces = 6,000.00,
 *                750.00 / 600.00), also when the draft's item still carries a stale Pallet pack.
 *
 * Run via `npm run local:test:db`; collected only by jest.db.config.js. SAFETY: one throwaway `qa-i101l-<run>` tenant approved by
 * `assertTestTenant`; afterAll deletes exactly its rows.
 */
jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: class InvoicePdfService {},
}));
jest.mock("../storage/compress.util", () => ({ compressDocument: jest.fn() }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: jest.fn().mockImplementation(() => ({})),
}));

import { randomUUID } from "crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { Logger } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "../orders/orders.service";
import { ProductUnitsService } from "../products/product-units.service";
import { assertPackKeepsLevelsValid } from "../products/unit-pack-rules";
import { InvoicesService } from "./invoices.service";
import { RecurringInvoicesService } from "../recurring-invoices/recurring-invoices.service";
import { ProductInsightsService } from "../sales-facts/product-insights.service";
import { SalesFactsService } from "../sales-facts/sales-facts.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { EmailService } from "../email/email.service";
import { InvoicePdfService } from "./invoice-pdf.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { MessagingService } from "../messaging/messaging.service";
import { StorageService } from "../storage/storage.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EstimatesService } from "../estimates/estimates.service";
import { NumberingService } from "../import/numbering.service";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { NotificationsService } from "../notifications/notifications.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "../orders/testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const PACK = 10;
const CASE = { label: "Case", factor: 200, perParent: 20 };
const PALLET = { label: "Pallet", factor: 4800, perParent: 24 };
const START_STOCK = 1_000_000;
const BOX_PRICE = 20;
const PIECE_PRICE = BOX_PRICE / PACK; // 2.00 at every level
const EXCISE_RATE = 0.25; // $ per piece
const PERCENT_RATE = 0.1;
const TAX_KINDS = ["EXCISE", "PERCENT"] as const;
type TaxKind = (typeof TAX_KINDS)[number];
const levyOf = (kind: TaxKind, pieces: number) =>
  kind === "EXCISE" ? pieces * EXCISE_RATE : pieces * PIECE_PRICE * PERCENT_RATE;

interface LevelPlan {
  level: string;
  factor: number;
  count: number;
  delivered: number;
}
const LEVELS: ReadonlyArray<LevelPlan> = [
  { level: CASE.label, factor: CASE.factor, count: 3, delivered: 450 },
  { level: PALLET.label, factor: PALLET.factor, count: 2, delivered: 3000 },
];

describeDb(
  "I-101 sale-ledger row: unit lines on the ladder 10 / 200 / 4800 through the REAL writeSaleEntries",
  () => {
    let pool: Pool;
    let raw: PrismaClient;
    let prisma: PrismaService;
    let tenantCtx: TenantContextService;
    let orders: any;
    let invoices: InvoicesService;
    let units: ProductUnitsService;
    const run = randomUUID().slice(0, 8);
    const slug = assertTestTenant(`qa-i101l-${run}`, "units-ladder-sale-ledger-i101.db.spec.ts");
    let tenantId = "";
    let operatorUserId = "";
    let familyId = "";
    const categoryIds: Record<string, string> = {};
    const variantIds: Record<string, string> = {};
    const userIds: string[] = [];
    let custSeq = 0;

    const staff = (): JwtPayload =>
      ({
        sub: operatorUserId,
        username: `op-${run}`,
        role: "OPERATOR",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    const inTenant = <T>(fn: () => Promise<T>): Promise<T> => tenantCtx.run(tenantId, fn);
    const num = (v: unknown) => (v == null ? null : Number(v));
    const round2 = (n: number) => Math.round(n * 100) / 100;

    async function newCustomer(label: string) {
      custSeq += 1;
      const user = await raw.user.create({
        data: {
          email: `c${custSeq}-${run}@example.test`,
          username: `c${custSeq}-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      });
      userIds.push(user.id);
      const customer = await raw.customer.create({
        data: {
          userId: user.id,
          businessName: `Acme ${label}`,
          contactName: "Tester",
          isTaxExempt: false,
          tenantId,
        },
      });
      return customer.id;
    }

    /** A real staff order of `count` units of `level` for variant `v`, confirmed. */
    async function unitOrder(kind: TaxKind, level: string, count: number, label: string) {
      const customerId = await newCustomer(label);
      const productId = variantIds[kind];
      const order = (await inTenant(() =>
        orders.create(
          { customerId, items: [{ productId, qty: count, unitLabel: level }] },
          staff(),
          {
            skipAutoMerge: true,
          },
        ),
      )) as { id: string };
      await inTenant(() =>
        orders.changeStatus(order.id, { status: "CONFIRMED" } as any, staff() as any),
      );
      const [line] = await raw.orderItem.findMany({ where: { orderId: order.id } });
      return { orderId: order.id, line, customerId, productId };
    }

    const invoiceLines = (orderId: string) =>
      raw.invoiceItem.findMany({
        where: { invoice: { orderId } },
        orderBy: { createdAt: "asc" },
      });

    /** One more variant (own product, so its sale facts hold only the lines the test made). */
    async function newVariant(name: string, boxPrice: number, trackedCategoryId: string) {
      const id = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Family ${run} ${name}`,
            variantName: name,
            parentProductId: familyId,
            kind: "VARIANT",
            unit: "each",
            unitsPerBox: PACK,
            pricePerUnit: boxPrice.toFixed(2),
            currentStock: START_STOCK,
            isActive: true,
          },
        })
      ).id;
      const caseRow: any = await inTenant(() =>
        units.create(
          id,
          { label: CASE.label, factorToBase: CASE.factor, perParent: CASE.perParent } as any,
          operatorUserId,
        ),
      );
      await inTenant(() =>
        units.create(
          id,
          {
            label: PALLET.label,
            factorToBase: PALLET.factor,
            parentUnitId: caseRow.id,
            perParent: PALLET.perParent,
          } as any,
          operatorUserId,
        ),
      );
      // LEGACY STATE: the levels pre-date the section. Neither door allows the section and a level above the pack together
      // any more (see G1), so the section goes on straight in the table, the only way a Case or Pallet line on a tracked
      // product can exist.
      await raw.product.update({ where: { id }, data: { trackedCategoryId } });
      return id;
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
      raw = new PrismaClient({ adapter: new PrismaPg(pool) });
      tenantCtx = new TenantContextService();
      prisma = new PrismaService(tenantCtx);
      await prisma.$connect();
      const systemConfig = new SystemConfigService(
        prisma,
        new EncryptionService({ get: () => undefined } as any),
      );
      const anyMethod = new Proxy(
        {},
        {
          get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()),
        },
      );
      const quiet = new Proxy(
        {},
        {
          get: (_t, prop) =>
            prop === "then" || typeof prop === "symbol" ? undefined : async () => undefined,
        },
      );
      orders = Object.assign(Object.create(OrdersService.prototype), {
        prisma,
        gateway: {
          emitOrderCreated: jest.fn(),
          emitUrgentOrder: jest.fn(),
          emitOrderStatusChanged: jest.fn(),
          emitLowStock: jest.fn(),
        },
        notifications: quiet,
        messaging: quiet,
        systemConfig,
        entitlements: { hasFlag: async () => true },
        sellingRestrictions: {
          getPolicy: async () => ({ enabled: false, addressPrecedence: "BILLING_FIRST" }),
          assertLinesSellable: async () => undefined,
        },
        authGuard: { assertAuthorizedOrThrow: async () => undefined },
        promotionsService: { activeForCatalog: async () => [] },
        tenantCtx,
        invoicesService: {
          findOpenOrderDraft: async () => null,
          revertLinkedInvoicesForOrderEdit: async () => undefined,
          resyncOrderInvoicesForEdit: async () => [],
          ...INVOICE_EDIT_STUBS,
          reconcileOrderDraftInvoice: async () => undefined,
        },
        creditNotes: {
          settleOrderCreditsInTx: async () => ({ applied: 0, unapplied: 0 }),
          previewOrderCreditRelease: async () => [],
          releaseOrderCreditsInTx: async () => undefined,
        },
        logger: new Logger(OrdersService.name),
        inlineReturns: {},
        oversellReader: { read: async () => "off" },
      });
      units = new ProductUnitsService(prisma);

      const moduleRef = await Test.createTestingModule({
        providers: [
          InvoicesService,
          RecurringInvoicesService,
          EstimatesService,
          NumberingService,
          ProductInsightsService,
          SalesFactsService,
          {
            provide: SellingRestrictionsService,
            useValue: {
              assertLinesSellable: jest.fn().mockResolvedValue(undefined),
              checkLinesSellable: jest.fn().mockResolvedValue({ outcome: "ALLOW", reasons: [] }),
            },
          },
          {
            provide: NotificationsService,
            useValue: { sendToUser: jest.fn().mockResolvedValue(1) },
          },
          { provide: PrismaService, useValue: prisma },
          { provide: TenantContextService, useValue: tenantCtx },
          { provide: RouteFlowGateway, useValue: anyMethod },
          {
            provide: EmailService,
            useValue: {
              sendInvoice: jest.fn().mockResolvedValue({ delivered: true }),
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
          { provide: MessagingService, useValue: { notify: jest.fn(), notifyEvent: jest.fn() } },
          { provide: StorageService, useValue: { upload: jest.fn(), delete: jest.fn() } },
          {
            provide: EntitlementAuthority,
            inject: [EntitlementsService],
            useFactory: (e: { hasFlag?: (t: string, k: string) => Promise<boolean> }) => ({
              can: (t: string, k: string) => e.hasFlag?.(t, k) ?? Promise.resolve(false),
            }),
          },
          {
            provide: EntitlementsService,
            useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
          },
          {
            provide: CommissionEngineService,
            useValue: {
              syncInvoiceCommissionSafe: jest.fn(),
              syncOrderInvoices: jest.fn(),
              removeInvoiceCommission: jest.fn(),
            },
          },
        ],
      }).compile();
      invoices = moduleRef.get(InvoicesService);

      tenantId = (await raw.tenant.create({ data: { slug, name: `I101l ${slug}` } })).id;
      operatorUserId = (
        await raw.user.create({
          data: {
            email: `op-${run}@example.test`,
            username: `op-${run}`,
            role: "OPERATOR",
            tenantId,
          },
        })
      ).id;
      familyId = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Family ${run}`,
            unit: "each",
            pricePerUnit: "0.00",
            kind: "FAMILY",
            parentProductId: null,
            isActive: true,
          },
        })
      ).id;
      // two tracked categories: a per-piece excise (EXCISE_RATE a piece) and a percent-of-sale levy (PERCENT_RATE)
      categoryIds.EXCISE = (
        await raw.trackedCategory.create({
          data: {
            tenantId,
            name: "Excise",
            taxType: "EXCISE_PER_UNIT",
            rate: EXCISE_RATE,
            unitBasis: "pack",
          },
        })
      ).id;
      categoryIds.PERCENT = (
        await raw.trackedCategory.create({
          data: { tenantId, name: "Percent", taxType: "PERCENT_OF_SALE", rate: PERCENT_RATE },
        })
      ).id;
      for (const k of TAX_KINDS) variantIds[k] = await newVariant(k, BOX_PRICE, categoryIds[k]);
    }, 180_000);

    afterAll(async () => {
      try {
        const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
          (o) => o.id,
        );
        await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
        await raw.stockMovement.deleteMany({ where: { tenantId } });
        await raw.regulatedSalesLedger.deleteMany({ where: { tenantId } });
        await raw.invoiceItem.deleteMany({ where: { tenantId } });
        await raw.invoice.deleteMany({ where: { tenantId } });
        await raw.numberingSequence.deleteMany({ where: { tenantId } });
        await raw.recurringInvoiceItem.deleteMany({ where: { tenantId } });
        await raw.recurringInvoice.deleteMany({ where: { tenantId } });
        await raw.orderItem.deleteMany({ where: { tenantId } });
        await raw.order.deleteMany({ where: { tenantId } });
        await raw.auditLog.deleteMany({ where: { tenantId } });
        await raw.productUnit.deleteMany({ where: { tenantId } });
        await raw.tenantUnit.deleteMany({ where: { tenantId } });
        await raw.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } });
        await raw.product.deleteMany({ where: { tenantId } });
        await raw.customer.deleteMany({ where: { tenantId } });
        await raw.trackedCategory.deleteMany({ where: { tenantId } });
        await raw.user.deleteMany({ where: { tenantId } });
        await raw.tenant.deleteMany({ where: { id: tenantId } });
      } finally {
        await _resetLockPoolForTests();
        await prisma?.$disconnect();
        await raw?.$disconnect();
        await pool?.end();
      }
    }, 120_000);

    it("G1: the front doors refuse a Case or Pallet on a tracked product (a filing could not count it), in both directions", async () => {
      // writer door: a level above the pack on a product that already has the section
      const tracked = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Family ${run} g1`,
            variantName: "g1",
            parentProductId: familyId,
            kind: "VARIANT",
            unit: "each",
            unitsPerBox: PACK,
            trackedCategoryId: categoryIds.EXCISE,
            pricePerUnit: BOX_PRICE.toFixed(2),
            isActive: true,
          },
        })
      ).id;
      const err: any = await inTenant(() =>
        units.create(
          tracked,
          { label: CASE.label, factorToBase: CASE.factor, perParent: CASE.perParent } as any,
          operatorUserId,
        ),
      ).catch((e) => e);
      expect(err?.getStatus?.()).toBe(400);
      expect(String(err?.message)).toMatch(/regulated product cannot be sold above its pack size/);
      expect(await raw.productUnit.count({ where: { productId: tracked } })).toBe(0);
      // product door: attaching a section to a product that has the levels (the rule `ProductsService.update` applies)
      const levels = [
        { label: CASE.label, factorToBase: CASE.factor },
        { label: PALLET.label, factorToBase: PALLET.factor },
      ];
      expect(() =>
        assertPackKeepsLevelsValid(levels, { unit: "each", unitsPerBox: PACK, regulated: true }),
      ).toThrow(/regulated product can't be sold above its pack/);
      expect(() =>
        assertPackKeepsLevelsValid(levels, { unit: "each", unitsPerBox: PACK, regulated: false }),
      ).not.toThrow();
    });

    const ledgerRows = (orderId: string) =>
      raw.regulatedSalesLedger.findMany({
        where: { orderId },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });
    const sum = (rows: any[], f: string) => round2(rows.reduce((n, r) => n + Number(r[f]), 0));

    for (const kind of TAX_KINDS) {
      for (const l of LEVELS) {
        it(`SALE ${kind}: a ${l.level} line writes ONE SALE row of ${l.count * l.factor} pieces with its net and levy, matching the invoice line`, async () => {
          const pieces = l.count * l.factor;
          const o = await unitOrder(kind, l.level, l.count, `sale-${kind}-${l.level}`);
          await inTenant(() => invoices.createInvoiceFromOrder(o.orderId));
          const rows = await ledgerRows(o.orderId);
          expect(rows).toHaveLength(1);
          const [sale] = rows;
          const item = (await invoiceLines(o.orderId))[0];
          expect({
            entryType: sale.entryType,
            trackedCategoryId: sale.trackedCategoryId,
            orderItemId: sale.orderItemId,
            invoiceItemId: sale.invoiceItemId,
            qty: num(sale.qty),
            unitBasisQty: num(sale.unitBasisQty),
            netSales: num(sale.netSales),
            categoryTax: num(sale.categoryTax),
          }).toEqual({
            entryType: "SALE",
            trackedCategoryId: categoryIds[kind],
            orderItemId: o.line.id,
            invoiceItemId: item.id,
            qty: pieces,
            unitBasisQty: pieces,
            netSales: round2(pieces * PIECE_PRICE),
            categoryTax: round2(levyOf(kind, pieces)),
          });
          expect(num(item.categoryTaxAmount)).toBe(round2(levyOf(kind, pieces)));
          expect(num(item.subtotal)).toBe(round2(pieces * PIECE_PRICE));
        });
      }
    }

    for (const kind of TAX_KINDS) {
      for (const l of LEVELS) {
        it(`RE-SYNC ${kind}: a delivery stop of ${l.delivered} pieces of a ${l.level} line leaves the invoice's ledger rows summing to ${l.delivered} pieces, also off a stale Pallet pack`, async () => {
          for (const stalePack of [null, 4800]) {
            const o = await unitOrder(
              kind,
              l.level,
              l.count,
              `resync-${kind}-${l.level}-${stalePack ?? "own"}`,
            );
            await inTenant(() => invoices.createInvoiceFromOrder(o.orderId));
            const draft = await raw.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
            if (stalePack != null)
              await raw.invoiceItem.updateMany({
                where: { invoiceId: draft.id },
                data: { unitsPerBox: stalePack },
              });
            await raw.orderItem.update({
              where: { id: o.line.id },
              data: { deliveredQty: l.delivered },
            });
            await inTenant(() => invoices.reconcileOrderDeliveredInvoices(o.orderId));
            const rows = await ledgerRows(o.orderId);
            expect({
              qty: sum(rows, "qty"),
              unitBasisQty: sum(rows, "unitBasisQty"),
              netSales: sum(rows, "netSales"),
              categoryTax: sum(rows, "categoryTax"),
            }).toEqual({
              qty: l.delivered,
              unitBasisQty: l.delivered,
              netSales: round2(l.delivered * PIECE_PRICE),
              categoryTax: round2(levyOf(kind, l.delivered)),
            });
            // the invoice line and the live ledger agree on the pieces
            const [item] = await invoiceLines(o.orderId);
            expect(num(item.qty)).toBe(l.delivered);
            expect(num(item.categoryTaxAmount)).toBe(round2(levyOf(kind, l.delivered)));
          }
        });
      }
    }
  },
);
