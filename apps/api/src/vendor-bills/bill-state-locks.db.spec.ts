/**
 * Bill-state locks — update(), delete(), recordPayment() and voidBill() against a concurrent
 * writer of the SAME bill, on real concurrency (separate DB connections + a barrier that lets both
 * callers pass their pre-transaction reads before either opens a transaction). Follow-ups to the
 * B285 bill-lock work: update()/delete() used to check DRAFT outside their tx, recordPayment read
 * the payments unlocked, and the receipt fingerprint ignored totalPaid.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-b285-*` tenants.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory/inventory.service";
import { VendorBillsService } from "./vendor-bills.service";
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

describeDb("Bill-state locks — real Postgres, separate connections", () => {
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
        await prisma.billPayment.deleteMany({
          where: { vendorBillId: { in: vb.map((b) => b.id) } },
        });
        await prisma.vendorBillItem.deleteMany({
          where: { vendorBillId: { in: vb.map((b) => b.id) } },
        });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`B285 spec cleanup failed for tenant ${tenantId}:`, e);
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

  /** Both callers pass their pre-transaction reads before either opens its transaction. */
  function holdBothBeforeTx(barrier: Barrier) {
    for (const svc of [A, C]) {
      const prismaSvc = svc.prisma as unknown as {
        tenantTransaction: (...a: unknown[]) => Promise<unknown>;
      };
      const original = prismaSvc.tenantTransaction.bind(prismaSvc);
      jest.spyOn(prismaSvc, "tenantTransaction").mockImplementation(async (...args: unknown[]) => {
        await barrier.arrive();
        return original(...args);
      });
    }
  }

  async function draftBill(w: World, qty = 10, unitCost = 6) {
    return inTenant(A, w, () =>
      A.bills.create({
        supplierId: w.supplierId,
        billDate: "2026-09-01",
        items: [{ productId: w.productId, description: "Widget", qty, unitCost }],
      } as never),
    ) as Promise<any>;
  }

  const readable = (r: PromiseRejectedResult) => r.reason?.getResponse?.() ?? {};

  it("(h) update() racing a receive of the same DRAFT bill: one wins, the other gets BILL_STATE_CHANGED", async () => {
    const w = await seedWorld("h", 50, 2);
    const bill = await draftBill(w);
    holdBothBeforeTx(new Barrier(2, 1500));
    const settled = await Promise.allSettled([
      inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)),
      inTenant(C, w, () =>
        C.bills.update(bill.id, {
          items: [{ productId: w.productId, description: "Widget", qty: 4, unitCost: 6 }],
        }),
      ),
    ]);
    const p = await productOf(w);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({
      where: { id: bill.id },
      include: { items: true },
    });
    console.log(
      `B285(h) observed: rejected=${rejected.length} code=${rejected.map((r) => readable(r).code)} ` +
        `stock=${p.currentStock} status=${finalBill.status} qty=${finalBill.items.map((i) => i.qty)}`,
    );
    expect(rejected).toHaveLength(1);
    expect(readable(rejected[0]).code).toBe("BILL_STATE_CHANGED");
    // receive won: stock +10 and the lines are the original 10; update won: nothing received
    const stock = Number(p.currentStock);
    expect(
      (stock === 60 && Number(finalBill.items[0].qty) === 10) ||
        (stock === 50 && Number(finalBill.items[0].qty) === 4 && finalBill.status === "DRAFT"),
    ).toBe(true);
  });

  it("(i) delete() racing a receive of the same DRAFT bill: never stock with no bill", async () => {
    const w = await seedWorld("i", 50, 2);
    const bill = await draftBill(w);
    holdBothBeforeTx(new Barrier(2, 1500));
    const settled = await Promise.allSettled([
      inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)),
      inTenant(C, w, () => C.bills.delete(bill.id)),
    ]);
    const p = await productOf(w);
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const still = await A.prisma.vendorBill.findUnique({ where: { id: bill.id } });
    console.log(
      `B285(i) observed: rejected=${rejected.length} code=${rejected.map((r) => readable(r).code)} ` +
        `stock=${p.currentStock} billExists=${!!still}`,
    );
    expect(rejected).toHaveLength(1);
    expect(readable(rejected[0]).code).toBe("BILL_STATE_CHANGED");
    const stock = Number(p.currentStock);
    expect((stock === 60 && !!still) || (stock === 50 && !still)).toBe(true);
  });

  it("(j) two payments racing on one bill: the second is refused, totalPaid = the payments", async () => {
    const w = await seedWorld("j", 50, 2);
    const bill = await draftBill(w); // 10 x 6 = 60 owed
    holdBothBeforeTx(new Barrier(2, 1500));
    const pay = (svc: Services) =>
      inTenant(svc, w, () =>
        svc.bills.recordPayment(bill.id, { amount: 40, method: "CASH" } as never),
      );
    const settled = await Promise.allSettled([pay(A), pay(C)]);
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(j) observed: fulfilled=${settled.filter((r) => r.status === "fulfilled").length} ` +
        `payments=${rows.length} totalPaid=${finalBill.totalPaid}`,
    );
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(rows).toHaveLength(1);
    expect(Number(finalBill.totalPaid)).toBe(40);
  });

  it("(k) voidBill racing a payment: one wins; a void never overwrites the payment's totalPaid, a VOID bill takes no payment", async () => {
    const w = await seedWorld("k", 50, 2);
    const bill = await draftBill(w);
    holdBothBeforeTx(new Barrier(2, 1500));
    const settled = await Promise.allSettled([
      inTenant(A, w, () => A.bills.recordPayment(bill.id, { amount: 20, method: "CASH" } as never)),
      inTenant(C, w, () => C.bills.voidBill(bill.id, w.userId)),
    ]);
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    console.log(
      `B285(k) observed: rejected=${rejected.length} code=${rejected.map((r) => readable(r).code)} ` +
        `status=${finalBill.status} payments=${rows.length} totalPaid=${finalBill.totalPaid}`,
    );
    expect(rejected).toHaveLength(1);
    expect(["BILL_STATE_CHANGED", "BILL_VOID"]).toContain(readable(rejected[0]).code);
    // the bill's running total always equals the payment rows that exist
    expect(Number(finalBill.totalPaid)).toBe(rows.reduce((t, r) => t + Number(r.amount), 0));
  });
});
