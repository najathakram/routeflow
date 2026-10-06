/**
 * B1050 (SA-703) — SKELETON, DB lane (PINS ONLY, written ahead of the fix; type-checked, not yet run:
 * the local DB is blocked). Edits below a line's delivered qty must not double-decrement stock.
 *
 * Booked C per product = Σ(matched by non-null id) max(q, d) + max(Σunmatched final q, Σunmatched
 * held d); the counter moves by C_after − C_before and the SALE ledger explains it (Σ quantity =
 * counter). Drives the REAL `settleStockForEdit` / `restoreStockForReopen` against real Postgres with
 * real OrderItem rows read the way `OrdersService.updateOrderItems` reads them (inside the tx, ids
 * included). TODO(builder, post-#3244): once the DB is unblocked, swap the `edit` helper for
 * `OrdersService.updateOrderItems` through the full Nest module so the call site (ids in the
 * held-read select, `recreated` wiring at replace-all) is proven too.
 *
 * Collected only by `jest.db.config.js`; `requireLocalDatabaseUrl()` refuses non-local hosts; every
 * tenant is a throwaway `qa-b1050-<run>-<n>-<label>` slug approved by `assertTestTenant`.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  restoreStockForReopen,
  settleStockForEdit,
  STOCK_SETTLE_SELECT,
} from "../orders/order-stock";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b1050-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "b1050-delivered-edit.db.spec.ts",
  );
};
const n = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

describeDb("B1050 delivered-qty edits — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inventory: InventoryService;
  const createdTenantIds: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    inventory = module.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await cleanupTenant(tenantId).catch(() => {
        // Best-effort: cleanup must never mask a test's own result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    operatorId: string;
    orderId: string;
    productId: string;
  }

  /** A tenant with one AVCO product that opened with 100 pieces @ $2; the order holds 10 → counter 90. */
  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B1050 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const operator = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const buyer = await prisma.user.create({
      data: {
        email: `${slug}-b@example.invalid`,
        username: `${slug}-b`,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: buyer.id,
        businessName: `Acme ${slug}`,
        contactName: "Acme Buyer",
        tenantId: tenant.id,
      },
    });
    const order = await prisma.order.create({
      data: { customerId: customer.id, tenantId: tenant.id, status: "PENDING" },
    });
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 5,
        currentStock: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    const w = {
      tenantId: tenant.id,
      operatorId: operator.id,
      orderId: order.id,
      productId: product.id,
    };
    await tenantCtx.run(w.tenantId, () =>
      inventory.recordPurchase(
        { productId: w.productId, quantity: 100, unitCost: 2 },
        w.operatorId,
      ),
    );
    return w;
  }

  const deps = (w: World) => ({ logger: new Logger("b1050"), tenantId: w.tenantId });
  const inTx = <T>(w: World, fn: (tx: any) => Promise<T>) =>
    tenantCtx.run(w.tenantId, () => prisma.tenantTransaction(fn));
  const operator = (w: World) => ({ sub: w.operatorId, role: "OPERATOR" }) as any;
  const counter = async (w: World) =>
    n((await prisma.product.findUniqueOrThrow({ where: { id: w.productId } })).currentStock);
  const ledgerSum = async (w: World) =>
    (await prisma.stockMovement.findMany({ where: { productId: w.productId } })).reduce(
      (s, m) => s + Number(m.quantity),
      0,
    );
  const addLine = (w: World, qty: number, deliveredQty: number) =>
    prisma.orderItem.create({
      data: {
        orderId: w.orderId,
        productId: w.productId,
        qty,
        deliveredQty,
        unitPrice: 5,
        subtotal: qty * 5,
        status: "PENDING",
      },
    });

  /** One edit as updateOrderItems performs it: read held (with ids) in the tx, settle, then write qty. */
  async function edit(w: World, finals: Array<{ id?: string; qty: number }>) {
    await inTx(w, async (tx) => {
      const heldItems = await tx.orderItem.findMany({
        where: { orderId: w.orderId },
        select: { id: true, ...STOCK_SETTLE_SELECT },
      });
      const final = finals.map((f) => ({ ...f, productId: w.productId }));
      await settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "PENDING" },
        heldItems,
        final,
        operator(w),
      );
      for (const f of finals) {
        if (f.id) await tx.orderItem.update({ where: { id: f.id }, data: { qty: f.qty } });
      }
    });
  }

  // Counter 90 + ledger Σ = 90: the order's own 10 pieces were booked (a real CREATE row).
  const bookCreate = (w: World, qty: number) =>
    inTx(w, (tx) =>
      settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "PENDING" },
        [],
        [{ productId: w.productId, qty }],
        operator(w),
        { notes: "CREATE" },
      ),
    );

  it("repro-1: held {q6,d10}, counter 90 → raise to 10 moves nothing; ledger Σ == counter", async () => {
    const w = await seedWorld("repro1");
    const line = await addLine(w, 10, 10);
    await bookCreate(w, 10);
    await edit(w, [{ id: line.id, qty: 6 }]); // below delivered: books nothing back (cap = 0)
    expect(await counter(w)).toBe(90);
    await edit(w, [{ id: line.id, qty: 10 }]); // back up to delivered: still nothing
    expect(await counter(w)).toBe(90);
    expect(await ledgerSum(w)).toBe(90);
  });

  it("pooled: delivered A + undelivered B, drop A → no credit; the counter never double-pays", async () => {
    const w = await seedWorld("pooled");
    const a = await addLine(w, 5, 5);
    const b = await addLine(w, 5, 0);
    await bookCreate(w, 10);
    await edit(w, [{ id: b.id, qty: 5 }]); // A removed
    expect(await counter(w)).toBe(90);
    expect(a.id).toBeDefined();
    expect(await ledgerSum(w)).toBe(90);
  });

  it("cancel → reopen: cancel credits Σ max(0, q − d); reopen takes the same back; Σ ledger == counter", async () => {
    const w = await seedWorld("cancel-reopen");
    const a = await addLine(w, 6, 10);
    const b = await addLine(w, 5, 0);
    await bookCreate(w, 11);
    const held: any[] = await inTx(w, (tx) =>
      tx.orderItem.findMany({
        where: { orderId: w.orderId },
        select: { id: true, ...STOCK_SETTLE_SELECT },
      }),
    );
    await inTx(w, (tx) =>
      settleStockForEdit(deps(w), tx, { id: w.orderId, status: "PENDING" }, held, [], operator(w), {
        notes: "CANCEL",
      }),
    );
    expect(await counter(w)).toBe(94); // 89 + 5 (b's undelivered 5; a is fully delivered)
    await inTx(w, (tx) =>
      restoreStockForReopen(deps(w), tx, w.orderId, [
        { productId: w.productId, qty: 6, deliveredQty: 10 },
        { productId: w.productId, qty: 5, deliveredQty: 0 },
      ]),
    );
    expect(await counter(w)).toBe(89);
    expect(await ledgerSum(w)).toBe(89);
    expect([a.id, b.id]).toHaveLength(2);
  });
});
