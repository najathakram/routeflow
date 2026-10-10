/**
 * B562 PR-2 (SA-136 §6.1, DB spec part 1) — every order stock event appends its SALE movement, and the
 * ledger then explains the counter.
 *
 * Drives the REAL stock writers against real Postgres: `decrementStockForSale` / `settleStockForEdit`
 * (orders/order-stock.ts — the only code paths create, promote, edit, cancel, uncancel, demote and the
 * standing-order generator use to move `Product.currentStock`), and `ReturnsService.cancel`. Which
 * event each OrdersService call site passes is pinned by the unit specs; this file proves the writes.
 *
 * Invariant under test (SA-136 §1): after every write, one movement exists for it with the signed
 * quantity that moved the counter and `stockAfter` = the counter after the write, so Σ quantity =
 * currentStock — `stock-ledger-gap.mjs` exits 0 and the replay reports no gap. The negative control
 * reproduces a pre-PR-2 raw decrement: the detector exits 2 and the replay REFUSES (L-207 stands).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Every tenant is a throwaway
 * `qa-b562-sl-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * rows this run created, in FK order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import * as path from "path";
import { ConflictException, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import {
  decrementStockForSale,
  restoreStockForReopen,
  settleStockForEdit,
} from "../orders/order-stock";
import { bookRestockMovement } from "../returns/returns-restock.util";
import { ReturnsService } from "../returns/returns.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b562-sl-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "b562-sale-ledger.db.spec.ts",
  );
};

const GAP_SCRIPT = path.resolve(__dirname, "../../scripts/stock-ledger-gap.mjs");
const n = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

describeDb("B562 PR-2 sale ledger — real Postgres", () => {
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
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await prisma?.$disconnect();
  });

  async function cleanupTenant(tenantId: string): Promise<void> {
    await prisma.returnItem.deleteMany({ where: { return: { tenantId } } });
    await prisma.return.deleteMany({ where: { tenantId } });
    await prisma.order.deleteMany({ where: { tenantId } });
    await prisma.customer.deleteMany({ where: { tenantId } });
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    slug: string;
    tenantId: string;
    operatorId: string;
    customerId: string;
    orderId: string;
    productId: string;
    otherProductId: string;
  }

  /** A tenant with two AVCO products that each opened with 100 pieces @ $2 (a real PURCHASE). */
  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B562 SL ${slug}` } });
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
    const mk = (name: string) =>
      prisma.product.create({
        data: {
          name,
          unit: "ea",
          pricePerUnit: 5,
          currentStock: 0,
          costingMethod: "AVCO",
          tenantId: tenant.id,
        },
      });
    const a = await mk(`Widget A ${slug}`);
    const b = await mk(`Widget B ${slug}`);
    const w: World = {
      slug,
      tenantId: tenant.id,
      operatorId: operator.id,
      customerId: customer.id,
      orderId: order.id,
      productId: a.id,
      otherProductId: b.id,
    };
    for (const productId of [a.id, b.id]) {
      // eslint-disable-next-line no-await-in-loop
      await tenantCtx.run(w.tenantId, () =>
        inventory.recordPurchase({ productId, quantity: 100, unitCost: 2 }, w.operatorId),
      );
    }
    return w;
  }

  const deps = (w: World) => ({ logger: new Logger("b562-sale-ledger"), tenantId: w.tenantId });
  const inTx = <T>(w: World, fn: (tx: any) => Promise<T>) =>
    tenantCtx.run(w.tenantId, () => prisma.tenantTransaction(fn));
  const counter = async (productId: string) =>
    n((await prisma.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const rowsOf = (productId: string, type?: "SALE" | "RETURN") =>
    prisma.stockMovement.findMany({
      where: { productId, ...(type ? { type } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  const ledgerSum = async (productId: string) =>
    (await rowsOf(productId)).reduce((s, m) => s + Number(m.quantity), 0);
  const operator = (w: World) => ({ sub: w.operatorId, role: "OPERATOR" }) as any;

  function runGapDetector(w: World) {
    return spawnSync(process.execPath, [GAP_SCRIPT, "--tenant", w.slug], {
      env: { ...process.env },
      encoding: "utf8",
      timeout: 60_000,
    });
  }

  it("create: two lines of one product write ONE SALE row of −5, stockAfter = the counter it left", async () => {
    const w = await seedWorld("create");
    await inTx(w, (tx) =>
      decrementStockForSale(
        deps(w),
        tx,
        [
          { productId: w.productId, qty: 2 },
          { productId: w.productId, qty: 3 },
        ],
        true,
        { orderId: w.orderId, notes: "CREATE", performedById: w.operatorId },
      ),
    );
    expect(await counter(w.productId)).toBe(95);
    const sales = await rowsOf(w.productId, "SALE");
    expect(sales).toHaveLength(1);
    expect(n(sales[0].quantity)).toBe(-5);
    expect(n(sales[0].stockAfter)).toBe(95);
    expect(sales[0]).toMatchObject({
      reference: `ORDER:${w.orderId}`,
      notes: "CREATE",
      performedById: w.operatorId,
      tenantId: w.tenantId,
    });
    expect(n(sales[0].unitCost)).toBe(2); // AVCO: the average
    expect(n(sales[0].avgCostAfter)).toBe(2); // a sale never moves it
    expect(await ledgerSum(w.productId)).toBe(95);
  });

  it("edit +2 then −1 → two SALE rows, each stockAfter equal to the counter right after its write", async () => {
    const w = await seedWorld("edit");
    const order = { id: w.orderId, status: "PENDING" };
    const line = (qty: number) => [{ productId: w.productId, qty, status: "PENDING" }];
    await inTx(w, (tx) =>
      decrementStockForSale(deps(w), tx, [{ productId: w.productId, qty: 5 }], true, {
        orderId: w.orderId,
        notes: "CREATE",
        performedById: w.operatorId,
      }),
    );
    await inTx(w, (tx) => settleStockForEdit(deps(w), tx, order, line(5), line(7), operator(w)));
    expect(await counter(w.productId)).toBe(93);
    await inTx(w, (tx) => settleStockForEdit(deps(w), tx, order, line(7), line(6), operator(w)));
    expect(await counter(w.productId)).toBe(94);

    const sales = await rowsOf(w.productId, "SALE");
    expect(sales.map((m) => [n(m.quantity), n(m.stockAfter), m.notes])).toEqual([
      [-5, 95, "CREATE"],
      [-2, 93, "EDIT"],
      [1, 94, "EDIT"],
    ]);
    expect(await ledgerSum(w.productId)).toBe(94);
  });

  it("cancel credits only the undelivered remainder; a fully delivered line credits nothing and writes no row", async () => {
    const w = await seedWorld("cancel");
    await inTx(w, (tx) =>
      decrementStockForSale(
        deps(w),
        tx,
        [
          { productId: w.productId, qty: 10 },
          { productId: w.otherProductId, qty: 3 },
        ],
        true,
        { orderId: w.orderId, notes: "CREATE", performedById: w.operatorId },
      ),
    );
    const held = [
      { productId: w.productId, qty: 10, deliveredQty: 4, status: "PENDING" },
      { productId: w.otherProductId, qty: 3, deliveredQty: 3, status: "PENDING" },
    ];
    await inTx(w, (tx) =>
      settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "CONFIRMED" },
        held,
        [],
        operator(w),
        {
          notes: "CANCEL",
        },
      ),
    );
    expect(await counter(w.productId)).toBe(96); // 100 − 10 + 6
    expect(await counter(w.otherProductId)).toBe(97); // delivered: nothing comes back
    const aSales = await rowsOf(w.productId, "SALE");
    expect(aSales.map((m) => [n(m.quantity), n(m.stockAfter), m.notes])).toEqual([
      [-10, 90, "CREATE"],
      [6, 96, "CANCEL"],
    ]);
    expect((await rowsOf(w.otherProductId, "SALE")).map((m) => m.notes)).toEqual(["CREATE"]);

    // uncancel: the delivered portion is modelled as already held, so the re-take is exactly the credit.
    await inTx(w, (tx) =>
      restoreStockForReopen(deps(w), tx, w.orderId, [
        { productId: w.productId, qty: 10, deliveredQty: 4 },
      ]),
    );
    expect(await counter(w.productId)).toBe(90);
    const last = (await rowsOf(w.productId, "SALE")).at(-1)!;
    expect([n(last.quantity), n(last.stockAfter), last.notes, last.performedById]).toEqual([
      -6,
      90,
      "UNCANCEL",
      null,
    ]);
    expect(await ledgerSum(w.productId)).toBe(90);
    expect(await ledgerSum(w.otherProductId)).toBe(97);
  });

  it("a DRAFT order moves no stock and writes no row", async () => {
    const w = await seedWorld("draft");
    await inTx(w, (tx) =>
      settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "DRAFT" },
        [],
        [{ productId: w.productId, qty: 5 }],
        operator(w),
      ),
    );
    expect(await counter(w.productId)).toBe(100);
    expect(await rowsOf(w.productId, "SALE")).toHaveLength(0);
  });

  it("a staff oversell still writes its row, with the negative stockAfter the counter really holds", async () => {
    const w = await seedWorld("oversell");
    await inTx(w, (tx) =>
      decrementStockForSale(deps(w), tx, [{ productId: w.productId, qty: 104 }], true, {
        orderId: w.orderId,
        notes: "CREATE",
        performedById: w.operatorId,
      }),
    );
    expect(await counter(w.productId)).toBe(-4);
    const [sale] = await rowsOf(w.productId, "SALE");
    expect([n(sale.quantity), n(sale.stockAfter)]).toEqual([-104, -4]);
  });

  it("a return cancel APPENDS reversing RETURN rows; the originals stay untouched", async () => {
    const w = await seedWorld("return");
    const ret = await prisma.return.create({
      data: {
        orderId: w.orderId,
        customerId: w.customerId,
        reason: "DAMAGED",
        status: "RECEIVED",
        tenantId: w.tenantId,
        items: {
          create: [{ productId: w.productId, qty: 3, restock: true, tenantId: w.tenantId }],
        },
      },
    });
    const originalId = await inTx(w, (tx) =>
      bookRestockMovement(tx, {
        returnId: ret.id,
        productId: w.productId,
        pieces: new Prisma.Decimal(36),
        userId: w.operatorId,
      }),
    );
    expect(await counter(w.productId)).toBe(136);
    const before = await prisma.stockMovement.findUniqueOrThrow({ where: { id: originalId! } });

    // ReturnsService.cancel reads only prisma + the ledger service on this path.
    const returns = Object.create(ReturnsService.prototype) as ReturnsService;
    Object.assign(returns, {
      prisma,
      ledger: { unreverseReturnEntries: jest.fn().mockResolvedValue(undefined) },
      logger: new Logger("b562-returns"),
    });
    await tenantCtx.run(w.tenantId, () => returns.cancel(ret.id, operator(w)));

    expect(await counter(w.productId)).toBe(100);
    const rows = await rowsOf(w.productId, "RETURN");
    expect(rows).toHaveLength(2);
    const after = rows.find((m) => m.id === originalId)!;
    expect(after).toEqual(before); // the receive's own row, byte-identical
    const reversal = rows.find((m) => m.id !== originalId)!;
    expect(reversal).toMatchObject({
      reference: `RET-${ret.id.slice(0, 8)}`,
      notes: "RETURN_CANCELLED",
      performedById: w.operatorId,
    });
    expect([n(reversal.quantity), n(reversal.stockAfter)]).toEqual([-36, 100]);
    expect(await ledgerSum(w.productId)).toBe(100);
  });

  it("B703 (SA-136b): a box-unaware 2-box line on a 12-pack moves 24 pieces; the cancel credit is capped in pieces", async () => {
    const w = await seedWorld("b703");
    await prisma.product.update({ where: { id: w.productId }, data: { unitsPerBox: 12 } });
    // qty is a BOX count: no boxes/pieces split, no unitLabel, no own pack snapshot.
    const boxUnaware = { productId: w.productId, boxes: null, pieces: null, unitsPerBox: null };
    await inTx(w, (tx) =>
      decrementStockForSale(deps(w), tx, [{ ...boxUnaware, qty: 2 }], true, {
        orderId: w.orderId,
        notes: "CREATE",
        performedById: w.operatorId,
      }),
    );
    expect(await counter(w.productId)).toBe(76);
    // One box went out the door, then the order is cancelled: only the undelivered 12 come back.
    await inTx(w, (tx) =>
      settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "PENDING" },
        [{ ...boxUnaware, qty: 2, deliveredQty: 1, status: "PENDING" }],
        [],
        operator(w),
        { notes: "CANCEL" },
      ),
    );
    expect(await counter(w.productId)).toBe(88);
    const sales = await rowsOf(w.productId, "SALE");
    expect(sales.map((m) => [n(m.quantity), n(m.stockAfter), m.notes])).toEqual([
      [-24, 76, "CREATE"],
      [12, 88, "CANCEL"],
    ]);
    expect(await ledgerSum(w.productId)).toBe(88);
    expect(runGapDetector(w).status).toBe(0);
  });

  it("the ledger explains the counter: the gap detector exits 0 and the replay reports no gap", async () => {
    const w = await seedWorld("gap-zero");
    await inTx(w, (tx) =>
      decrementStockForSale(deps(w), tx, [{ productId: w.productId, qty: 8 }], true, {
        orderId: w.orderId,
        notes: "CREATE",
        performedById: w.operatorId,
      }),
    );
    await inTx(w, (tx) =>
      settleStockForEdit(
        deps(w),
        tx,
        { id: w.orderId, status: "PENDING" },
        [{ productId: w.productId, qty: 8, status: "PENDING" }],
        [{ productId: w.productId, qty: 5 }],
        operator(w),
      ),
    );
    const res = runGapDetector(w);
    expect(res.stdout).toContain("NO DRIFT");
    expect(res.status).toBe(0);
    const replay = await inTx(w, (tx) =>
      inventory.recomputeProductInTx(tx, w.productId, { throwOnGap: false }),
    );
    expect(replay).toMatchObject({ gapDetected: false, stockDrift: 0 });
  });

  it("control: a pre-PR-2 raw decrement (no SALE row) is drift — the detector exits 2 and the replay REFUSES", async () => {
    const w = await seedWorld("gap-control");
    await prisma.product.update({
      where: { id: w.productId },
      data: { currentStock: { decrement: 7 } },
    });
    const res = runGapDetector(w);
    expect(res.status).toBe(2);
    expect(res.stdout).toContain(w.productId);
    expect(res.stdout).toContain("drift=-7");
    await expect(
      inTx(w, (tx) => inventory.recomputeProductInTx(tx, w.productId)),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
