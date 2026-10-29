/**
 * I-101 backlog 1, 2, 3 and 5 (units tested matrix 2026-10-28, rows O11, O9, S1, O3): a unit line through the ORDERS paths
 * that were mocked or not tested, on REAL Postgres, on the linked ladder the matrix fixture names.
 *
 * Fixture (the #3918 fixture): ONE family with TWO variants. Per variant the pack is 10 pieces (`Product.unitsPerBox`), a Case is
 * 200 pieces (perParent 20) and a Pallet is 4,800 pieces (parent = the Case, perParent 24); levels written by the REAL units
 * writer. Box price a1 = 20 (Case 400, Pallet 9,600), a2 = 30 (Case 600, Pallet 14,400): a Case is 20 x box, a Pallet 24 x Case.
 * Every expected value below is the ladder arithmetic written down here, never copied from a run (OP-2: a value that disagrees
 * with it is a bug to file, not a value to pin).
 *
 *   O11/O3  an order of 2 of a level plus 3 pack boxes (30 pcs) of the SAME product stores both lines (qty in pieces, the
 *           level's factor snapshot, the pack line's own) and takes the sum from stock; cancelling it puts the sum back
 *           (2 x factor + 30 pieces) and writes one CANCEL movement per line's worth.
 *   O9      two PENDING orders of one customer, one holding a unit line: `mergeAllPendingForCustomer` folds nothing and answers
 *           null; `forceConsolidateCustomer` refuses naming the unit line; neither writes anything.
 *   S1      a BUYER raising an existing unit line past the stock that is left is refused 409 INSUFFICIENT_STOCK with the policy
 *           off (stock and line unchanged), and accepted under the backorder policy (stock goes negative); STAFF may oversell.
 *
 * Run via `npm run local:test:db`; collected only by jest.db.config.js. SAFETY: one throwaway `qa-i101o-<run>` tenant approved by
 * `assertTestTenant`; afterAll deletes exactly its rows.
 */
jest.mock("../invoices/invoice-pdf.service", () => ({
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
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { _resetLockPoolForTests } from "../common/db-locks";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { EncryptionService } from "../common/encryption.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { OrdersService } from "./orders.service";
import { ProductUnitsService } from "../products/product-units.service";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { INVOICE_EDIT_STUBS } from "./testing/invoice-edit-stubs";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const PACK = 10;
const CASE = { label: "Case", factor: 200, perParent: 20 };
const PALLET = { label: "Pallet", factor: 4800, perParent: 24 };
const VARIANTS = [
  { name: "a1", boxPrice: 20, casePrice: 400, palletPrice: 9600 },
  { name: "a2", boxPrice: 30, casePrice: 600, palletPrice: 14400 },
] as const;
const LEVELS = [
  { level: "Case", factor: CASE.factor, price: (v: (typeof VARIANTS)[number]) => v.casePrice },
  {
    level: "Pallet",
    factor: PALLET.factor,
    price: (v: (typeof VARIANTS)[number]) => v.palletPrice,
  },
] as const;
const START_STOCK = 100_000;
const PACK_BOXES = 3; // pack boxes on the mixed order = 30 pieces

describeDb("I-101 orders branch: unit lines on the ladder 10 / 200 / 4800, real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let orders: any;
  let units: ProductUnitsService;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-i101o-${run}`, "units-ladder-orders-i101.db.spec.ts");
  let tenantId = "";
  let operatorUserId = "";
  let familyId = "";
  const variantIds: Record<string, string> = {};
  const userIds: string[] = [];
  let policy: "off" | "backorder" = "off";
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
  const stockOf = async (productId: string) =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);

  /** A fresh customer (and its buyer user), so one customer's pending orders never meet another test's. */
  async function newCustomer(label: string) {
    custSeq += 1;
    const user = await raw.user.create({
      data: {
        email: `b${custSeq}-${run}@example.test`,
        username: `b${custSeq}-${run}`,
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
    const buyer = (): JwtPayload =>
      ({
        sub: user.id,
        username: `b${custSeq}-${run}`,
        role: "CUSTOMER",
        status: "ACTIVE",
        forcePasswordChange: false,
        tenantId,
        tenantSlug: slug,
      }) as JwtPayload;
    return { customerId: customer.id, buyer };
  }

  const createOrder = (customerId: string, items: any[]) =>
    inTenant(
      async () =>
        (await orders.create({ customerId, items }, staff(), { skipAutoMerge: true })) as {
          id: string;
        },
    );
  const linesOf = (orderId: string) =>
    raw.orderItem.findMany({ where: { orderId }, orderBy: { position: "asc" } });

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
      // the policy the reader answers is switched per test (`policy`); only a CUSTOMER role reads it
      oversellReader: { read: async () => policy },
    });
    units = new ProductUnitsService(prisma);

    tenantId = (await raw.tenant.create({ data: { slug, name: `I101o ${slug}` } })).id;
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
    for (const v of VARIANTS) {
      variantIds[v.name] = (
        await raw.product.create({
          data: {
            tenantId,
            name: `Family ${run} ${v.name}`,
            variantName: v.name,
            parentProductId: familyId,
            kind: "VARIANT",
            unit: "each",
            unitsPerBox: PACK,
            pricePerUnit: v.boxPrice.toFixed(2),
            currentStock: START_STOCK,
            isActive: true,
          },
        })
      ).id;
      const caseRow: any = await inTenant(() =>
        units.create(
          variantIds[v.name],
          { label: CASE.label, factorToBase: CASE.factor, perParent: CASE.perParent } as any,
          operatorUserId,
        ),
      );
      await inTenant(() =>
        units.create(
          variantIds[v.name],
          {
            label: PALLET.label,
            factorToBase: PALLET.factor,
            parentUnitId: caseRow.id,
            perParent: PALLET.perParent,
          } as any,
          operatorUserId,
        ),
      );
    }
  }, 120_000);

  afterAll(async () => {
    try {
      const ids = (await raw.order.findMany({ where: { tenantId }, select: { id: true } })).map(
        (o) => o.id,
      );
      await (raw as any).orderRevision?.deleteMany?.({ where: { orderId: { in: ids } } });
      await raw.stockMovement.deleteMany({ where: { tenantId } });
      await raw.invoiceItem.deleteMany({ where: { tenantId } });
      await raw.invoice.deleteMany({ where: { tenantId } });
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
      it(`O3 + O11 ${v.name}: 2 ${l.level} and ${PACK_BOXES} pack boxes of one product are both stored, take the sum from stock, and a cancel puts the sum back`, async () => {
        const productId = variantIds[v.name];
        const { customerId } = await newCustomer(`o11-${v.name}-${l.level}`);
        const stock0 = await stockOf(productId);
        const unitPieces = 2 * l.factor;
        const packPieces = PACK_BOXES * PACK;

        // O3: both lines stored
        const order = await createOrder(customerId, [
          { productId, qty: 2, unitLabel: l.level },
          { productId, qty: packPieces, boxes: PACK_BOXES, pieces: 0 },
        ]);
        const [unitLine, packLine] = await linesOf(order.id);
        expect({
          unitLabel: unitLine.unitLabel,
          boxes: num(unitLine.boxes),
          qty: num(unitLine.qty),
          unitsPerBox: num(unitLine.unitsPerBox),
          unitPrice: num(unitLine.unitPrice),
          subtotal: num(unitLine.subtotal),
        }).toEqual({
          unitLabel: l.level,
          boxes: 2,
          qty: unitPieces,
          unitsPerBox: l.factor,
          unitPrice: l.price(v),
          subtotal: 2 * l.price(v),
        });
        expect({
          unitLabel: packLine.unitLabel,
          boxes: num(packLine.boxes),
          pieces: num(packLine.pieces),
          qty: num(packLine.qty),
          unitsPerBox: num(packLine.unitsPerBox),
          unitPrice: num(packLine.unitPrice),
          subtotal: num(packLine.subtotal),
        }).toEqual({
          unitLabel: null,
          boxes: PACK_BOXES,
          pieces: 0,
          qty: packPieces,
          unitsPerBox: PACK,
          unitPrice: v.boxPrice,
          subtotal: PACK_BOXES * v.boxPrice,
        });
        expect(num((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).total)).toBe(
          2 * l.price(v) + PACK_BOXES * v.boxPrice,
        );
        // O3: stock = the sum in pieces
        expect(await stockOf(productId)).toBe(stock0 - unitPieces - packPieces);

        // O11: confirm, then cancel through the real status path; the whole sum comes back
        await inTenant(() =>
          orders.changeStatus(order.id, { status: "CONFIRMED" } as any, staff() as any),
        );
        const beforeCancel = new Date();
        await inTenant(() =>
          orders.changeStatus(order.id, { status: "CANCELLED" } as any, staff() as any),
        );
        expect((await raw.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
          "CANCELLED",
        );
        expect((await linesOf(order.id)).map((x) => x.status)).toEqual(["CANCELLED", "CANCELLED"]);
        expect(await stockOf(productId)).toBe(stock0);
        const cancelMoves = await raw.stockMovement.findMany({
          where: { productId, createdAt: { gte: beforeCancel } },
          orderBy: { createdAt: "asc" },
        });
        process.stdout.write(
          `
I101 O11 ${v.name} ${l.level} cancel movements: ${JSON.stringify(cancelMoves.map((m) => ({ type: m.type, quantity: Number(m.quantity), reference: m.reference, stockAfter: num(m.stockAfter) })))}
`,
        );
        // the returned pieces are the movements written by the cancel (one per line or one summed): their sum is the order's pieces
        expect(cancelMoves.reduce((n, m) => n + Math.abs(Number(m.quantity)), 0)).toBe(
          unitPieces + packPieces,
        );
      }, 120_000);
    }
  }

  for (const [v, l] of [
    [VARIANTS[0], LEVELS[0]],
    [VARIANTS[1], LEVELS[1]],
  ] as const) {
    it(`O9 ${v.name} ${l.level}: auto-merge folds nothing and answers null; force-consolidate refuses naming the unit line; nothing is written`, async () => {
      const productId = variantIds[v.name];
      const { customerId } = await newCustomer(`o9-${v.name}-${l.level}`);
      const o1 = await createOrder(customerId, [{ productId, qty: 1, unitLabel: l.level }]);
      const o2 = await createOrder(customerId, [{ productId, qty: 20, boxes: 2, pieces: 0 }]);
      const stock0 = await stockOf(productId);
      const snapshot = async () => ({
        orders: (
          await raw.order.findMany({
            where: { customerId },
            orderBy: { id: "asc" },
            select: { id: true, status: true, total: true },
          })
        ).map((o) => [o.id, o.status, num(o.total)]),
        lines: (await raw.orderItem.findMany({ where: { order: { customerId } } }))
          .map((x) => [x.id, x.status, x.unitLabel, num(x.qty), num(x.subtotal)])
          .sort(),
        stock: await stockOf(productId),
      });
      const before = await snapshot();
      expect(before.orders.length).toBe(2);

      // (a) the auto-merge sweep: folds nothing, returns null
      const merged = await inTenant(() => orders.mergeAllPendingForCustomer(customerId, {}));
      expect(merged).toBeNull();
      expect(await snapshot()).toEqual(before);

      // (b) force consolidate: refuses, naming the unit-aware line; nothing is written
      const err: any = await inTenant(() => orders.forceConsolidateCustomer(customerId)).then(
        () => null,
        (e: any) => e,
      );
      process.stdout.write(
        `\nI101 O9 ${v.name} ${l.level} force-consolidate answered: ${err ? JSON.stringify({ status: err.getStatus?.(), body: err.getResponse?.() }) : "ACCEPTED (no refusal)"}\n`,
      );
      expect(err).not.toBeNull();
      expect(err.getStatus()).toBe(409);
      expect(JSON.stringify(err.getResponse())).toContain(l.level);
      expect(await snapshot()).toEqual(before);
      expect([o1.id, o2.id].sort()).toEqual(before.orders.map((o) => o[0] as string).sort());
    }, 120_000);
  }

  for (const [v, l] of [
    [VARIANTS[0], LEVELS[0]],
    [VARIANTS[1], LEVELS[1]],
  ] as const) {
    it(`S1 ${v.name} ${l.level}: a buyer raising the unit line past the stock left is 409 INSUFFICIENT_STOCK (policy off) and accepted under backorder; staff may oversell`, async () => {
      const productId = variantIds[v.name];
      const { customerId, buyer } = await newCustomer(`s1-${v.name}-${l.level}`);
      // the stock left after the order below is `room` pieces: less than one more level for a Case, 1.5 levels short for a Pallet
      const room = l.factor / 2;
      await raw.product.update({
        where: { id: productId },
        data: { currentStock: l.factor + room },
      });
      policy = "off";
      const order = await createOrder(customerId, [{ productId, qty: 1, unitLabel: l.level }]);
      const [line] = await linesOf(order.id);
      expect(await stockOf(productId)).toBe(room);

      const edit = (qty: number) =>
        inTenant(() =>
          orders.updateOrderItems(
            order.id,
            { replaceAll: false, items: [{ id: line.id, unitLabel: l.level, qty }] },
            buyer(),
          ),
        );
      const err: any = await edit(2).then(
        () => null,
        (e: any) => e,
      );
      process.stdout.write(
        `\nI101 S1 ${v.name} ${l.level} buyer raise 1 -> 2 (policy off) answered: ${err ? JSON.stringify({ status: err.getStatus?.(), body: err.getResponse?.() }) : "ACCEPTED (no refusal)"}\n`,
      );
      expect(err).not.toBeNull();
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "INSUFFICIENT_STOCK" });
      expect(await stockOf(productId)).toBe(room);
      expect(num((await linesOf(order.id))[0].qty)).toBe(l.factor);

      // backorder: the same raise goes through and stock goes negative by the shortfall
      policy = "backorder";
      await edit(2);
      expect(num((await linesOf(order.id))[0].qty)).toBe(2 * l.factor);
      expect(await stockOf(productId)).toBe(room - l.factor);
      policy = "off";

      // staff may oversell: a second order of one more level takes stock further negative
      const second = await createOrder(customerId, [{ productId, qty: 1, unitLabel: l.level }]);
      expect(second.id).toBeTruthy();
      expect(await stockOf(productId)).toBe(room - 2 * l.factor);
    }, 120_000);
  }
});
