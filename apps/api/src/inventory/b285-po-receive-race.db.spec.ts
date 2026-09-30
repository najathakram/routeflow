/**
 * B285 pin — PO receive vs concurrent writers, on REAL concurrency: three PrismaService pools
 * (= separate DB connections) and a barrier that holds the receive transaction OPEN after it has
 * read the product, so the competing write genuinely contends with it. A sequential run proves
 * nothing.
 *
 *  (a) receive 20 while a sale decrements 10 from stock 50 → stock 60 (not 70), one lot, one
 *      movement, qtyReceived 20, and the sale was observed BLOCKED on a row lock (the contention
 *      was real, not scheduled around).
 *  (b) two concurrent receives of the SAME PO line → exactly one posts: stock 70, one lot,
 *      qtyReceived 20 (a double post gives 90 / two lots).
 *  (c) an UNLINKED vendor bill received while a PO receive of the same product is open →
 *      stock 80 and blended average 3.0000 under either serial order. A bill linked to a PO moves
 *      no stock and never writes PurchaseOrderItem.qtyReceived (VendorBillsService.receive
 *      guard e; the bill's qtyReceived is VendorBillItem's), so the only state a bill shares with
 *      a PO receive is the Product row — that is what (c) races.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Every tenant is a throwaway
 * `qa-b285-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly
 * what this run created, in FK order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "./inventory.service";
import { VendorBillsService } from "../vendor-bills/vendor-bills.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PlatformConfigService } from "../platform-admin/platform-config.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { DuplicateMatchService } from "../import/duplicate-match.service";
import { StorageService } from "../storage/storage.service";
import { ProductAliasService } from "../import/product-alias.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(`qa-b285-${RUN_SUFFIX}-${tenantSeq}-${label}`, "b285-po-receive-race");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Holds callers until `parties` have arrived, or `timeoutMs` passes (a caller blocked behind a
 *  lock never arrives — the timeout is what lets the lock holder carry on). */
class Barrier {
  private arrived = 0;
  private waiters: Array<() => void> = [];
  private markParked!: () => void;
  /** Resolves when the first caller has arrived, i.e. is parked inside its transaction. */
  readonly parked = new Promise<void>((resolve) => {
    this.markParked = resolve;
  });
  constructor(
    private readonly parties: number,
    private readonly timeoutMs: number,
  ) {}
  async arrive(): Promise<void> {
    this.arrived += 1;
    this.markParked();
    if (this.arrived >= this.parties) {
      this.waiters.forEach((w) => w());
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
      setTimeout(resolve, this.timeoutMs);
    });
  }
}

interface Services {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  inventory: InventoryService;
  bills: VendorBillsService;
}

describeDb("B285 — PO receive vs concurrent writers — real Postgres, separate connections", () => {
  const services: Services[] = [];
  const createdTenantIds: string[] = [];

  async function build(): Promise<Services> {
    const tenantCtx = new TenantContextService();
    const prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VendorBillsService,
        InventoryService,
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
        { provide: StorageService, useValue: { upload: jest.fn(), presignedUrl: jest.fn() } },
        {
          provide: ProductAliasService,
          useValue: { resolveMany: jest.fn(), learn: jest.fn(), unlearn: jest.fn() },
        },
      ],
    }).compile();
    const s = {
      prisma,
      tenantCtx,
      inventory: module.get(InventoryService),
      bills: module.get(VendorBillsService),
    };
    services.push(s);
    return s;
  }

  let A: Services; // the receive + all seeding
  let B: Services; // the competing writer, on its own connection pool
  let C: Services; // a second receiver for case (b)

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    A = await build();
    B = await build();
    C = await build();
  });

  afterAll(async () => {
    const prisma = A?.prisma;
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        const pos = await prisma.purchaseOrder.findMany({
          where: { tenantId },
          select: { id: true },
        });
        await prisma.purchaseOrderItem.deleteMany({
          where: { poId: { in: pos.map((p) => p.id) } },
        });
        await prisma.purchaseOrder.deleteMany({ where: { tenantId } });
        const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
        await prisma.vendorBillItem.deleteMany({ where: { billId: { in: vb.map((b) => b.id) } } });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch(() => {
        // Best-effort: a failed cleanup must never mask a test's own pass/fail result.
      });
    }
    await Promise.all(services.map((s) => s.prisma.$disconnect()));
  });

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  async function seedWorld(label: string, stock: number, avg: number): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await A.prisma.tenant.create({ data: { slug, name: `B285 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await A.prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
    });
    const supplier = await A.prisma.supplier.create({
      data: { name: `Supplier ${slug}`, tenantId: tenant.id },
    });
    const product = await A.prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: stock,
        averageCost: avg,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, supplierId: supplier.id, productId: product.id };
  }

  const inTenant = <T>(s: Services, w: World, fn: () => Promise<T>) =>
    s.tenantCtx.run(w.tenantId, fn);
  const productOf = (w: World) =>
    A.prisma.product.findUniqueOrThrow({ where: { id: w.productId } });

  async function sentPo(w: World, qty: number, cost: number) {
    const po = await inTenant(A, w, () =>
      A.inventory.createPurchaseOrder(
        { supplierId: w.supplierId, items: [{ productId: w.productId, qty, unitCost: cost }] },
        w.userId,
      ),
    );
    await inTenant(A, w, () => A.inventory.sendPurchaseOrder(po.id));
    return po;
  }

  /** Make `svc`'s receive pause at the barrier AFTER it has read the product and BEFORE it
   *  writes — the window in which an unlocked writer can slip in. */
  function holdReceiveAt(svc: Services, barrier: Barrier) {
    const inv = svc.inventory as unknown as {
      postPoReceipt: (...a: unknown[]) => Promise<unknown>;
    };
    const original = inv.postPoReceipt.bind(inv);
    jest.spyOn(inv, "postPoReceipt").mockImplementation(async (...args: unknown[]) => {
      await barrier.arrive();
      return original(...args);
    });
  }

  /** True once some backend is waiting on a lock (polled, never assumed). */
  async function sawLockWait(withinMs: number): Promise<boolean> {
    const deadline = Date.now() + withinMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      const rows = await A.prisma.$queryRaw<Array<{ n: bigint }>>`
        SELECT count(*)::bigint AS n FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (Number(rows[0]?.n ?? 0) > 0) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(50);
    }
    return false;
  }

  afterEach(() => jest.restoreAllMocks());

  it("(a) a sale committing while a receive is open is not erased: 50 +20 −10 = 60", async () => {
    const w = await seedWorld("a", 50, 2);
    const po = await sentPo(w, 20, 4);
    // the receive parks for up to 3s inside its txn; the sale (connection B) must contend with it
    const barrier = new Barrier(2, 4000);
    holdReceiveAt(A, barrier);

    const receive = inTenant(A, w, () =>
      A.inventory.receivePurchaseOrder(
        po.id,
        { items: [{ itemId: po.items[0].id, receivedQty: 20 }] },
        w.userId,
      ),
    );
    await barrier.parked;
    let receiveDoneAt = Infinity;
    let saleDoneAt = Infinity;
    void receive.then(() => {
      receiveDoneAt = performance.now();
    });
    const sale = inTenant(B, w, () =>
      B.prisma.product.update({
        where: { id: w.productId },
        data: { currentStock: { decrement: 10 } },
      }),
    );
    void sale.then(() => {
      saleDoneAt = performance.now();
    });
    await sawLockWait(2500);
    await Promise.all([receive, sale]);
    // the sale contended with the open receive: it could only finish once the receive had
    const blocked = saleDoneAt >= receiveDoneAt;

    const p = await productOf(w);
    const moves = await A.prisma.stockMovement.findMany({ where: { tenantId: w.tenantId } });
    const lots = await A.prisma.stockLot.findMany({ where: { tenantId: w.tenantId } });
    const line = await A.prisma.purchaseOrderItem.findFirstOrThrow({ where: { poId: po.id } });
    console.log(
      `B285(a) observed: blocked=${blocked} stock=${p.currentStock} avg=${p.averageCost} ` +
        `moves=${moves.length} stockAfter=${moves[0]?.stockAfter} lots=${lots.length} ` +
        `qtyReceived=${line.qtyReceived}`,
    );
    expect(blocked).toBe(true);
    expect(Number(p.currentStock)).toBe(60);
    expect(moves).toHaveLength(1);
    // the receive's snapshot is a real running total: receive-then-sale = 70, sale-then-receive = 60
    expect([60, 70]).toContain(Number(moves[0].stockAfter));
    expect(lots).toHaveLength(1);
    expect(Number(lots[0].qty)).toBe(20);
    expect(Number(line.qtyReceived)).toBe(20);
  });

  it("(b) two concurrent receives of the same PO line post exactly once", async () => {
    const w = await seedWorld("b", 50, 2);
    const po = await sentPo(w, 20, 4);
    const barrier = new Barrier(2, 2000);
    holdReceiveAt(A, barrier);
    holdReceiveAt(C, barrier);
    const dto = { items: [{ itemId: po.items[0].id, receivedQty: 20 }] };

    const settled = await Promise.allSettled([
      inTenant(A, w, () => A.inventory.receivePurchaseOrder(po.id, dto, w.userId)),
      inTenant(C, w, () => C.inventory.receivePurchaseOrder(po.id, dto, w.userId)),
    ]);

    const p = await productOf(w);
    const lots = await A.prisma.stockLot.findMany({ where: { tenantId: w.tenantId } });
    const line = await A.prisma.purchaseOrderItem.findFirstOrThrow({ where: { poId: po.id } });
    console.log(
      `B285(b) observed: fulfilled=${settled.filter((s) => s.status === "fulfilled").length} ` +
        `stock=${p.currentStock} lots=${lots.length} qtyReceived=${line.qtyReceived}`,
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    expect(Number(p.currentStock)).toBe(70);
    expect(lots).toHaveLength(1);
    expect(Number(line.qtyReceived)).toBe(20);
  });

  it("(c) an unlinked bill received while a PO receive is open: stock 80, average 3.0000", async () => {
    const w = await seedWorld("c", 50, 2);
    const po = await sentPo(w, 20, 4);
    const bill: any = await inTenant(A, w, () =>
      A.bills.create({
        supplierId: w.supplierId,
        billDate: "2026-09-01",
        items: [{ productId: w.productId, description: "Widget", qty: 10, unitCost: 6 }],
      } as never),
    );
    expect(bill.purchaseOrder).toBeNull();
    const barrier = new Barrier(2, 4000);
    holdReceiveAt(A, barrier);

    const receive = inTenant(A, w, () =>
      A.inventory.receivePurchaseOrder(
        po.id,
        { items: [{ itemId: po.items[0].id, receivedQty: 20 }] },
        w.userId,
      ),
    );
    await barrier.parked;
    const billReceive = inTenant(B, w, () => B.bills.receive(bill.id, undefined, w.userId));
    await sawLockWait(2500);
    await Promise.all([receive, billReceive]);

    const p = await productOf(w);
    const moves = await A.prisma.stockMovement.findMany({
      where: { tenantId: w.tenantId },
      orderBy: { createdAt: "asc" },
    });
    console.log(
      `B285(c) observed: stock=${p.currentStock} avg=${p.averageCost} ` +
        `stockAfter=[${moves.map((m) => m.stockAfter).join(",")}] ` +
        `avgAfter=[${moves.map((m) => m.avgCostAfter).join(",")}]`,
    );
    expect(Number(p.currentStock)).toBe(80);
    // (50*2 + 20*4 + 10*6) / 80 = 3 — the same under either serial order
    expect(Math.abs(Number(p.averageCost) - 3)).toBeLessThan(0.001);
    // each movement's snapshot is a real running total: the stockAfters are {70,80} or {60,80}
    expect(Math.max(...moves.map((m) => Number(m.stockAfter)))).toBe(80);
  });
});
