/**
 * I-101 backlog 4, 6 and 7 (units tested matrix 2026-10-28, rows I4, I7, T2, M2): a unit line through the INVOICES paths that were
 * mocked or not tested, on REAL Postgres, on the linked ladder the matrix fixture names.
 *
 * Fixture (the #3918 fixture): ONE family with TWO variants. Per variant the pack is 10 pieces (`Product.unitsPerBox`), a Case is
 * 200 pieces (perParent 20) and a Pallet is 4,800 pieces (parent = the Case, perParent 24); levels written by the REAL units
 * writer. Box price a1 = 20 (Case 400, Pallet 9,600), a2 = 30 (Case 600, Pallet 14,400): a piece costs box / 10 (a1 2.00, a2 3.00)
 * at every level. Orders are made by the REAL `OrdersService.create`; invoices by the REAL `InvoicesService`. Every expected value
 * below is the ladder arithmetic written down here, never copied from a run (OP-2: a value that disagrees with it is a bug to
 * file, not a value to pin).
 *
 *   I4  `createPartialFromOrder` of a unit line, in pieces: 250 of 3 Cases bills 1 Case + 50 pieces at 250 x the piece price, label
 *       and factor kept, `invoicedQty` +250; the remaining 350 bills 1 Case + 150 pieces; 5,000 of 2 Pallets bills 1 Pallet + 200
 *       pieces, and the remaining 4,600 bills 0 Pallets + 4,600 pieces. A fractional 249.5 is refused 400 "not a whole number of
 *       pieces" and nothing is written.
 *   I7  a delivery stop rebuilds the order's open draft on the delivered basis (`reconcileOrderDeliveredInvoices`): 450 of 3 Cases
 *       delivered rebuilds the draft line to 2 Cases + 50 pieces (qty 450, factor 200, label kept), also when the draft's item still
 *       carries a Pallet pack (4,800); 3,000 of 1 Pallet rebuilds to 0 Pallets + 3,000 pieces.
 *   M2  the sale facts read a stored unit line by its own snapshot: 3 Cases invoiced = 600 pieces, 3 selling units, 1,200 (a1) gross,
 *       2.00 per piece (never the 400 Case price).
 *
 *   T2  a recurring PACK-count template line of a ladder product still generates boxes of the pack. A template line CANNOT carry a
 *       unit today (no unitLabel in the DTO; the generator does not copy one), so that half of row 6 has nothing to pin.
 *
 * Run via `npm run local:test:db`; collected only by jest.db.config.js. SAFETY: one throwaway `qa-i101i-<run>` tenant approved by
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
const VARIANTS = [
  { name: "a1", boxPrice: 20 },
  { name: "a2", boxPrice: 30 },
] as const;
type Variant = (typeof VARIANTS)[number];
const START_STOCK = 1_000_000;
const pieceOf = (v: { boxPrice: number }) => v.boxPrice / PACK; // a1 2.00, a2 3.00 at every level

/** Per level: the order size (units), then partials as [pieces billed, boxes (units), pieces]. */
interface LevelPlan {
  level: string;
  factor: number;
  count: number;
  partials: ReadonlyArray<readonly [number, number, number]>;
  delivered: number;
  deliveredSplit: readonly [number, number];
}
const LEVELS: ReadonlyArray<LevelPlan> = [
  {
    level: CASE.label,
    factor: CASE.factor,
    count: 3,
    partials: [
      [250, 1, 50],
      [350, 1, 150],
    ],
    delivered: 450,
    deliveredSplit: [2, 50],
  },
  {
    level: PALLET.label,
    factor: PALLET.factor,
    count: 2,
    partials: [
      [5000, 1, 200],
      [4600, 0, 4600],
    ],
    delivered: 3000,
    deliveredSplit: [0, 3000],
  },
];

describeDb("I-101 invoices branch: unit lines on the ladder 10 / 200 / 4800, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let invoices: InvoicesService;
  let recurring: RecurringInvoicesService;
  let insights: ProductInsightsService;
  let units: ProductUnitsService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-i101i-${run}`, "units-ladder-invoices-i101.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let familyId = "";
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
        isTaxExempt: true,
        tenantId,
      },
    });
    return customer.id;
  }

  /** A real staff order of `count` units of `level` for variant `v`, confirmed. */
  async function unitOrder(v: { name: string }, level: string, count: number, label: string) {
    const customerId = await newCustomer(label);
    const productId = variantIds[v.name];
    const order = (await inTenant(() =>
      orders.create({ customerId, items: [{ productId, qty: count, unitLabel: level }] }, staff(), {
        skipAutoMerge: true,
      }),
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
  const shape = (l: any) => ({
    unitLabel: l.unitLabel,
    qty: num(l.qty),
    boxes: num(l.boxes),
    pieces: num(l.pieces),
    unitsPerBox: num(l.unitsPerBox),
    subtotal: num(l.subtotal),
  });

  /** One more variant (own product, so its sale facts hold only the lines the test made). */
  async function newVariant(name: string, boxPrice: number) {
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
      { get: (_t, prop) => (prop === "then" || typeof prop === "symbol" ? undefined : jest.fn()) },
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
        { provide: NotificationsService, useValue: { sendToUser: jest.fn().mockResolvedValue(1) } },
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
        {
          provide: RegulatedLedgerService,
          useValue: {
            writeSaleEntries: jest.fn(),
            reverseInvoiceEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
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
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
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
    recurring = moduleRef.get(RecurringInvoicesService);
    insights = moduleRef.get(ProductInsightsService);

    tenantId = (await raw.tenant.create({ data: { slug, name: `I101i ${slug}` } })).id;
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
    for (const v of VARIANTS) variantIds[v.name] = await newVariant(v.name, v.boxPrice);
  }, 180_000);

  afterAll(async () => {
    try {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { tenantId } });
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
      await raw.user.deleteMany({ where: { tenantId } });
      await raw.tenant.deleteMany({ where: { id: tenantId } });
    } finally {
      await _resetLockPoolForTests();
      await prisma?.$disconnect();
      await raw?.$disconnect();
      await pool?.end();
    }
  }, 120_000);

  for (const v of VARIANTS) {
    for (const l of LEVELS) {
      it(`I4 ${v.name}: partial invoices of a ${l.level} line bill ${l.partials
        .map(([q]) => q)
        .join(" then ")} pieces as units + pieces at the line's own factor`, async () => {
        const o = await unitOrder(v, l.level, l.count, `i4-${v.name}-${l.level}`);
        const total = l.count * l.factor;
        let billed = 0;
        for (const [pcs, boxes, pieces] of l.partials) {
          await inTenant(() =>
            invoices.createPartialFromOrder(o.orderId, {
              items: [{ orderItemId: o.line.id, qty: pcs }],
            } as any),
          );
          billed += pcs;
          const lines = await invoiceLines(o.orderId);
          expect(shape(lines[lines.length - 1])).toEqual({
            unitLabel: l.level,
            qty: pcs,
            boxes,
            pieces,
            unitsPerBox: l.factor,
            subtotal: round2(pcs * pieceOf(v)),
          });
          expect(
            num((await raw.orderItem.findUniqueOrThrow({ where: { id: o.line.id } })).invoicedQty),
          ).toBe(billed);
        }
        expect(billed).toBe(total);
        const all = await invoiceLines(o.orderId);
        expect(round2(all.reduce((n, x) => n + Number(x.subtotal), 0))).toBe(
          round2(total * pieceOf(v)),
        );
      });
    }
  }

  it("I4: a fractional 249.5 pieces of a Case line is refused 400 'not a whole number of pieces', nothing written", async () => {
    const v = VARIANTS[0];
    const o = await unitOrder(v, CASE.label, 3, "i4-frac");
    const err: any = await inTenant(() =>
      invoices.createPartialFromOrder(o.orderId, {
        items: [{ orderItemId: o.line.id, qty: 249.5 }],
      } as any),
    ).catch((e) => e);
    expect(String(err?.message)).toMatch(/not a whole number of pieces/);
    expect(err?.getStatus?.()).toBe(400);
    expect(await invoiceLines(o.orderId)).toEqual([]);
    expect(
      num((await raw.orderItem.findUniqueOrThrow({ where: { id: o.line.id } })).invoicedQty),
    ).toBe(0);
  });

  for (const v of VARIANTS) {
    for (const l of LEVELS) {
      it(`I7 ${v.name}: a delivery stop rebuilds the open ${l.level} draft to ${l.delivered} pieces at the line's own factor, also off a stale Pallet pack`, async () => {
        for (const stalePack of [null, 4800]) {
          const o = await unitOrder(
            v,
            l.level,
            l.count,
            `i7-${v.name}-${l.level}-${stalePack ?? "own"}`,
          );
          await inTenant(() => invoices.createInvoiceFromOrder(o.orderId));
          const draft = await raw.invoice.findFirstOrThrow({ where: { orderId: o.orderId } });
          expect(draft.status).toBe("DRAFT");
          expect(shape((await invoiceLines(o.orderId))[0])).toEqual({
            unitLabel: l.level,
            qty: l.count * l.factor,
            boxes: l.count,
            pieces: 0,
            unitsPerBox: l.factor,
            subtotal: round2(l.count * l.factor * pieceOf(v)),
          });
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
          const [units0, pieces0] = l.deliveredSplit;
          const rebuilt = await invoiceLines(o.orderId);
          expect(rebuilt.map(shape)).toEqual([
            {
              unitLabel: l.level,
              qty: l.delivered,
              boxes: units0,
              pieces: pieces0,
              unitsPerBox: l.factor,
              subtotal: round2(l.delivered * pieceOf(v)),
            },
          ]);
          expect(
            num((await raw.invoice.findUniqueOrThrow({ where: { id: draft.id } })).subtotal),
          ).toBe(round2(l.delivered * pieceOf(v)));
        }
      });
    }
  }

  for (const l of LEVELS) {
    it(`M2 ${l.level}: the sale facts read an invoiced ${l.level} line by its own snapshot (${l.count * l.factor} pieces, ${l.count} selling units, 2.00 a piece)`, async () => {
      const v = VARIANTS[0];
      const productId = await newVariant(`m2-${l.level.toLowerCase()}`, v.boxPrice);
      const customerId = await newCustomer(`m2-${l.level}`);
      const order = (await inTenant(() =>
        orders.create(
          { customerId, items: [{ productId, qty: l.count, unitLabel: l.level }] },
          staff(),
          { skipAutoMerge: true },
        ),
      )) as { id: string };
      await inTenant(() =>
        orders.changeStatus(order.id, { status: "CONFIRMED" } as any, staff() as any),
      );
      await inTenant(() => invoices.createInvoiceFromOrder(order.id));
      // sale facts count issued invoices only (a DRAFT is not a sale): issue the one the order made
      await raw.invoice.updateMany({ where: { orderId: order.id }, data: { status: "SENT" } });
      const day = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);
      const res = await inTenant(() =>
        insights.getProductInsights(productId, { from: day(-1), to: day(1) } as any),
      );
      expect(res.totals).toMatchObject({
        invoicedQtyPieces: l.count * l.factor,
        unresolvedSaleLines: 0,
        sellingUnits: l.count,
        legacyLines: 0,
        lineGross: round2(l.count * l.factor * pieceOf(v)),
      });
      expect(res.price).toMatchObject({
        avgPerPiece: pieceOf(v),
        minPerPiece: pieceOf(v),
        maxPerPiece: pieceOf(v),
      });
    });
  }

  it("T2 control: a recurring PACK-count template line of a ladder product generates 2 boxes of the pack, unaffected by the levels", async () => {
    // The template cannot carry a unit today (the DTO has no unitLabel and the generator does not copy one), so the
    // line under test is the pack count: 2 boxes of 10 = 20 pieces at the box price.
    const v = VARIANTS[1];
    const customerId = await newCustomer("t2-pack");
    const ri = await raw.recurringInvoice.create({
      data: {
        customerId,
        frequency: "MONTHLY",
        dayOfMonth: 1,
        nextRunAt: new Date("2026-07-01T00:00:00Z"),
        tenantId,
        items: {
          create: [
            {
              description: "Box",
              productId: variantIds[v.name],
              qty: 2,
              unitPrice: v.boxPrice,
              tenantId,
            },
          ],
        },
      },
      include: { items: true },
    });
    await inTenant(() => (recurring as any).generateInvoiceFromTemplate(ri));
    const line = await raw.invoiceItem.findFirstOrThrow({ where: { invoice: { customerId } } });
    expect(shape(line)).toEqual({
      unitLabel: null,
      qty: 2 * PACK,
      boxes: 2,
      pieces: 0,
      unitsPerBox: PACK,
      subtotal: 2 * v.boxPrice,
    });
  });
});
