/**
 * B291 — supplier-credit draws against a concurrent writer of the SAME supplier's credit, on real
 * concurrency: separate DB connections, and the FIRST writer is parked INSIDE its transaction (all
 * its work done, its locks held, before commit) while the second writer starts. Code that reads a
 * credit without a lock lets the second writer read the pre-draw balance and draw it again (master:
 * $2,000 drawn against a $1,000 credit); with the credit row lock the second waits, then reads the
 * balance the first left. Harness mirrors bill-state-locks.db.spec.ts.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-b291-*` tenants.
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
  return assertTestTenant(`qa-b291-${RUN_SUFFIX}-${tenantSeq}-${label}`, "supplier-credit-lock");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long the parked writer holds its locks (well under Prisma's 5 s interactive-tx timeout). */
const HOLD_MS = 1500;

interface Services {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  bills: VendorBillsService;
}

describeDb("Supplier credit draws — real Postgres, parked first writer", () => {
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
    const s: Services = { prisma, tenantCtx, bills: module.get(VendorBillsService) };
    services.push(s);
    return s;
  }

  let A: Services; // seeding + the PARKED first writer
  let C: Services; // the second writer, on its own connection

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    A = await build();
    C = await build();
  });

  afterAll(async () => {
    const prisma = A?.prisma;
    for (const tenantId of createdTenantIds) {
      // eslint-disable-next-line no-await-in-loop
      await (async () => {
        const vb = await prisma.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
        const billIds = vb.map((b) => b.id);
        await prisma.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await prisma.vendorBill.deleteMany({ where: { tenantId } });
        await prisma.supplierCredit.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`supplier-credit-lock cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await Promise.all(services.map((s) => s.prisma.$disconnect()));
  });

  afterEach(() => jest.restoreAllMocks());

  interface World {
    tenantId: string;
    supplierId: string;
    productId: string;
    creditId: string;
  }

  /** A tenant with one supplier; `credit: true` also gives it ONE $1,000 on-account credit. */
  async function seedWorld(label: string, opts: { credit: boolean }): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await A.prisma.tenant.create({ data: { slug, name: `Credit lock ${slug}` } });
    createdTenantIds.push(tenant.id);
    await A.prisma.user.create({
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
        currentStock: 0,
        averageCost: 2,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    const w: World = {
      tenantId: tenant.id,
      supplierId: supplier.id,
      productId: product.id,
      creditId: "",
    };
    if (opts.credit) await addCredit(w);
    return w;
  }

  async function addCredit(w: World): Promise<void> {
    const credit = await A.prisma.supplierCredit.create({
      data: {
        supplierId: w.supplierId,
        amount: 1000,
        balance: 1000,
        method: "CASH",
        tenantId: w.tenantId,
      },
    });
    w.creditId = credit.id;
  }

  const inTenant = <T>(s: Services, w: World, fn: () => Promise<T>) =>
    s.tenantCtx.run(w.tenantId, fn);

  /** A DRAFT bill owing qty x unitCost; the supplier's credit auto-applies inside create(). */
  const createBill = (s: Services, w: World, qty: number, unitCost: number) =>
    inTenant(
      s,
      w,
      () =>
        s.bills.create({
          supplierId: w.supplierId,
          billDate: "2026-09-01",
          items: [
            { productId: w.productId, description: `Line ${qty}x${unitCost}`, qty, unitCost },
          ],
        } as never) as Promise<any>,
    );

  /**
   * Park the NEXT transaction `svc` opens: its callback runs to completion (all writes done, all
   * locks held), then it waits HOLD_MS before committing. Resolves once it is parked.
   */
  function parkNextTx(svc: Services): Promise<void> {
    let markParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      markParked = resolve;
    });
    const p = svc.prisma as unknown as {
      tenantTransaction: (fn: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => unknown;
    };
    const original = p.tenantTransaction.bind(p);
    jest.spyOn(p, "tenantTransaction").mockImplementation(((
      fn: (tx: unknown) => Promise<unknown>,
      ...rest: unknown[]
    ) =>
      original(
        async (tx: unknown) => {
          const out = await fn(tx);
          markParked();
          await sleep(HOLD_MS);
          return out;
        },
        ...rest,
      )) as never);
    return parked;
  }

  /** Run `first` parked inside its tx, start `second` once it is parked, return both outcomes. */
  async function race<T1, T2>(
    first: () => Promise<T1>,
    second: () => Promise<T2>,
  ): Promise<[PromiseSettledResult<T1>, PromiseSettledResult<T2>]> {
    const parked = parkNextTx(A);
    const firstRun = first();
    await parked;
    const secondRun = second();
    return [
      (await Promise.allSettled([firstRun]))[0],
      (await Promise.allSettled([secondRun]))[0],
    ] as [PromiseSettledResult<T1>, PromiseSettledResult<T2>];
  }

  const drawsOf = async (w: World) => {
    const rows = await A.prisma.billPayment.findMany({ where: { supplierCreditId: w.creditId } });
    return rows.reduce((sum, r) => sum + Number(r.amount), 0);
  };
  const balanceOf = async (w: World) =>
    Number(
      (await A.prisma.supplierCredit.findUniqueOrThrow({ where: { id: w.creditId } })).balance,
    );

  it("(a) two concurrent bills on one $1,000 credit: draws total $1,000 and the balance is 0", async () => {
    const w = await seedWorld("a", { credit: false });
    // Y is a draft that owes 1,000 and drew nothing (no credit existed yet). The credit then
    // appears, and two bills reach for it at once: a NEW bill (parked, holding the credit) and an
    // edit of Y that re-draws. (Two concurrent creates would collide on nextBillNumber instead.)
    const y = await createBill(A, w, 50, 20);
    await addCredit(w);
    const [first, second] = await race(
      () => createBill(A, w, 100, 10), // owes 1,000
      () => inTenant(C, w, () => C.bills.update(y.id, { notes: "re-draw" })),
    );
    const drawn = await drawsOf(w);
    const balance = await balanceOf(w);
    // eslint-disable-next-line no-console
    console.log(
      `B291(a) observed: first=${first.status} second=${second.status} drawn=${drawn} balance=${balance}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    expect(drawn).toBe(1000); // master: 2000 drawn against a 1000 credit
    expect(balance).toBe(0);
    const paid = await A.prisma.vendorBill.findMany({
      where: { tenantId: w.tenantId },
      select: { totalPaid: true },
    });
    expect(paid.reduce((sum, b) => sum + Number(b.totalPaid), 0)).toBe(1000);
  });

  it("(b) an edit's refund-and-redraw vs a concurrent create: no over-draw, no deadlock", async () => {
    const w = await seedWorld("b", { credit: true });
    const x = await createBill(A, w, 60, 10); // owes 600; draws 600, credit balance 400
    expect(await balanceOf(w)).toBe(400);

    const [first, second] = await race(
      // refunds the 600 and re-draws only the 200 the corrected bill owes (credit holds 800)
      () =>
        inTenant(A, w, () =>
          A.bills.update(x.id, {
            items: [{ productId: w.productId, description: "Corrected", qty: 20, unitCost: 10 }],
          }),
        ),
      () => createBill(C, w, 100, 10), // owes 1,000: can only get what is really left
    );
    const xAfter = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: x.id } });
    const drawn = await drawsOf(w);
    const balance = await balanceOf(w);
    // eslint-disable-next-line no-console
    console.log(
      `B291(b) observed: first=${first.status} second=${second.status} xPaid=${xAfter.totalPaid} drawn=${drawn} balance=${balance}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    expect(Number(xAfter.totalPaid)).toBe(200);
    expect(drawn).toBe(1000); // 200 (edited bill) + 800 (new bill), the whole credit and no more
    expect(balance).toBe(0);
  });
});
