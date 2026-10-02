/**
 * Bill-state locks — every writer of a vendor bill's money or receipt state against a concurrent
 * writer of the SAME bill, on real concurrency: separate DB connections, and the FIRST writer is
 * parked INSIDE its transaction (after all its work, holding its locks, before commit) while the
 * second writer is started. A writer that takes no lock proceeds straight through and commits on
 * top of the parked one, so each case is red on code without the lock and green with it — by
 * construction, not by timing luck.
 *
 * Writers covered: update, delete, bulkDelete, receive, void, recordPayment,
 * recordSupplierPayment, bookkeeping bulk mark-paid (payBillFully), supplier statement apply.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-b285-*` tenants.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { InventoryService } from "../inventory/inventory.service";
import { VendorBillsService } from "./vendor-bills.service";
import { BookkeepingService } from "../bookkeeping/bookkeeping.service";
import { StatementApplyService } from "../supplier-statements/statement-apply.service";
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
  return assertTestTenant(`qa-b285-${RUN_SUFFIX}-${tenantSeq}-${label}`, "bill-state-locks");
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** How long the parked writer holds its locks (well under Prisma's 5 s interactive-tx timeout). */
const HOLD_MS = 1500;

interface Services {
  prisma: PrismaService;
  tenantCtx: TenantContextService;
  inventory: InventoryService;
  bills: VendorBillsService;
  bookkeeping: BookkeepingService;
  statements: StatementApplyService;
}

describeDb("Bill-state locks — real Postgres, parked first writer", () => {
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
    const bills = module.get(VendorBillsService);
    const s: Services = {
      prisma,
      tenantCtx,
      inventory: module.get(InventoryService),
      bills,
      // payBillFully only needs prisma; the rest of the constructor is unused on that path
      bookkeeping: new BookkeepingService(
        prisma,
        {} as never,
        {} as never,
        bills,
        {} as never,
        {} as never,
        {} as never,
      ),
      statements: new StatementApplyService(prisma),
    };
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
        await prisma.supplierStatementScan.deleteMany({ where: { tenantId } });
        await prisma.stockLot.deleteMany({ where: { tenantId } });
        await prisma.stockMovement.deleteMany({ where: { tenantId } });
        await prisma.product.deleteMany({ where: { tenantId } });
        await prisma.supplier.deleteMany({ where: { tenantId } });
        await prisma.user.deleteMany({ where: { tenantId } });
        await prisma.tenant.delete({ where: { id: tenantId } });
      })().catch((e: unknown) => {
        // Never mask a test's own result, but never hide a leaked tenant either.
        // eslint-disable-next-line no-console
        console.error(`bill-state-locks cleanup failed for tenant ${tenantId}:`, e);
      });
    }
    await Promise.all(services.map((s) => s.prisma.$disconnect()));
  });

  afterEach(() => jest.restoreAllMocks());

  interface World {
    tenantId: string;
    userId: string;
    supplierId: string;
    productId: string;
  }

  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await A.prisma.tenant.create({ data: { slug, name: `Bill locks ${slug}` } });
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
        currentStock: 50,
        averageCost: 2,
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

  /** A DRAFT unlinked bill: 10 x 6 = 60 owed. */
  async function draftBill(w: World) {
    return inTenant(A, w, () =>
      A.bills.create({
        supplierId: w.supplierId,
        billDate: "2026-09-01",
        items: [{ productId: w.productId, description: "Widget", qty: 10, unitCost: 6 }],
      } as never),
    ) as Promise<any>;
  }

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

  const codeOf = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? (r.reason?.getResponse?.()?.code ?? r.reason?.message) : undefined;
  const pay = (svc: Services, w: World, id: string, amount: number) =>
    inTenant(svc, w, () => svc.bills.recordPayment(id, { amount, method: "CASH" } as never));

  it("(h) update() vs a parked receive: the edit is refused, the received bill is untouched", async () => {
    const w = await seedWorld("h");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)),
      () =>
        inTenant(C, w, () =>
          C.bills.update(bill.id, {
            items: [{ productId: w.productId, description: "Widget", qty: 4, unitCost: 6 }],
          }),
        ),
    );
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({
      where: { id: bill.id },
      include: { items: true },
    });
    console.log(
      `B285(h) observed: first=${first.status} second=${second.status}/${codeOf(second)} ` +
        `stock=${(await productOf(w)).currentStock} status=${finalBill.status} ` +
        `qty=${finalBill.items.map((i) => i.qty)}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(codeOf(second)).toBe("BILL_STATE_CHANGED");
    expect(Number((await productOf(w)).currentStock)).toBe(60);
    expect(finalBill.status).toBe("RECEIVED");
    expect(finalBill.items.map((i) => Number(i.qty))).toEqual([10]);
  });

  it("(i) delete() vs a parked receive: the delete is refused, no stock without a bill", async () => {
    const w = await seedWorld("i");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)),
      () => inTenant(C, w, () => C.bills.delete(bill.id)),
    );
    const still = await A.prisma.vendorBill.findUnique({ where: { id: bill.id } });
    console.log(
      `B285(i) observed: first=${first.status} second=${second.status}/${codeOf(second)} ` +
        `stock=${(await productOf(w)).currentStock} billExists=${!!still}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(codeOf(second)).toBe("BILL_STATE_CHANGED");
    expect(Number((await productOf(w)).currentStock)).toBe(60);
    expect(still).not.toBeNull();
  });

  it("(l) bulkDelete() vs a parked receive: the received bill is skipped, not deleted", async () => {
    const w = await seedWorld("l");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)),
      () => inTenant(C, w, () => C.bills.bulkDelete([bill.id])),
    );
    const still = await A.prisma.vendorBill.findUnique({ where: { id: bill.id } });
    const result = second.status === "fulfilled" ? second.value : null;
    console.log(
      `B285(l) observed: first=${first.status} deleted=${result?.deleted} skipped=${result?.skipped.length} ` +
        `stock=${(await productOf(w)).currentStock} billExists=${!!still}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(result?.deleted).toBe(0);
    expect(result?.skipped).toHaveLength(1);
    expect(Number((await productOf(w)).currentStock)).toBe(60);
    expect(still).not.toBeNull();
  });

  it("(j) two payments: the second waits, sees the first, and is refused", async () => {
    const w = await seedWorld("j");
    const bill = await draftBill(w); // 60 owed
    const [first, second] = await race(
      () => pay(A, w, bill.id, 40),
      () => pay(C, w, bill.id, 40),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(j) observed: first=${first.status} second=${second.status} payments=${rows.length} ` +
        `totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    expect(rows).toHaveLength(1);
    expect(Number(finalBill.totalPaid)).toBe(40);
  });

  it("(k) voidBill() vs a parked payment: the void is refused, totalPaid is not overwritten", async () => {
    const w = await seedWorld("k");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => pay(A, w, bill.id, 20),
      () => inTenant(C, w, () => C.bills.voidBill(bill.id, w.userId)),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(k) observed: first=${first.status} second=${second.status}/${codeOf(second)} ` +
        `status=${finalBill.status} payments=${rows.length} totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(codeOf(second)).toBe("BILL_STATE_CHANGED");
    expect(Number(finalBill.totalPaid)).toBe(20);
    expect(rows).toHaveLength(1);
    expect(finalBill.status).not.toBe("VOID");
  });

  it("(k2) a payment vs a parked void: the payment is refused with BILL_VOID", async () => {
    const w = await seedWorld("k2");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => inTenant(A, w, () => A.bills.voidBill(bill.id, w.userId)),
      () => pay(C, w, bill.id, 20),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(k2) observed: first=${first.status} second=${second.status}/${codeOf(second)} ` +
        `status=${finalBill.status} payments=${rows.length}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(codeOf(second)).toBe("BILL_VOID");
    expect(rows).toHaveLength(0);
    expect(finalBill.status).toBe("VOID");
  });

  it("(m) recordSupplierPayment vs a parked payment: it pays only what is really outstanding", async () => {
    const w = await seedWorld("m");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => pay(A, w, bill.id, 40),
      () =>
        inTenant(C, w, () =>
          C.bills.recordSupplierPayment({
            supplierId: w.supplierId,
            totalAmount: 40,
            method: "CASH",
            allocations: [{ vendorBillId: bill.id, amount: 40 }],
          } as never),
        ),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(m) observed: first=${first.status} second=${second.status} payments=${rows.length} ` +
        `totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected"); // 40 > the 20 still outstanding
    expect(rows).toHaveLength(1);
    expect(Number(finalBill.totalPaid)).toBe(40);
  });

  it("(n) bulk mark-paid vs a parked payment: it pays the real remainder (20), never 60", async () => {
    const w = await seedWorld("n");
    const bill = await draftBill(w);
    const [first, second] = await race(
      () => pay(A, w, bill.id, 40),
      () =>
        inTenant(C, w, () =>
          C.bookkeeping.bulkMarkPaid({ ids: [bill.id], method: "CASH" } as never),
        ),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const sum = rows.reduce((t, r) => t + Number(r.amount), 0);
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(n) observed: first=${first.status} second=${second.status} payments=${rows.length} ` +
        `sum=${sum} totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(sum).toBe(60);
    expect(Number(finalBill.totalPaid)).toBe(60);
  });

  it("(o) statement apply (implied paid) vs a parked payment: no bill is paid past its total", async () => {
    const w = await seedWorld("o");
    const bill = await draftBill(w);
    await inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId)); // not a draft
    const scan = await A.prisma.supplierStatementScan.create({
      data: {
        tenantId: w.tenantId,
        supplierId: w.supplierId,
        fileHash: randomUUID(),
        extractedPayload: { lines: [] },
      },
    });
    const [first, second] = await race(
      () => pay(A, w, bill.id, 40),
      () =>
        inTenant(C, w, () =>
          C.statements.applyStatement(
            scan.id,
            { confirmed: [], impliedPaid: { billIds: [bill.id] } } as never,
            { sub: w.userId },
          ),
        ),
    );
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    const sum = rows.reduce((t, r) => t + Number(r.amount), 0);
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(o) observed: first=${first.status} second=${second.status} payments=${rows.length} ` +
        `sum=${sum} totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");
    expect(sum).toBe(60);
    expect(Number(finalBill.totalPaid)).toBe(60);
  });

  // Not a race: create() nests its lines, so they carry a NULL tenantId, and update() used to
  // replace them with a tenant-scoped deleteMany that cannot see them — the old line stayed beside
  // the new one. The replacement is now parent-scoped (`items: { deleteMany: {} }`).
  it("(p) editing a bill's lines replaces them: one line, and receive posts only the new one", async () => {
    const w = await seedWorld("p");
    const bill = await draftBill(w); // one line, qty 10
    // a legacy line written before lines were stamped: explicitly NULL tenantId, via the raw client
    await A.prisma.vendorBillItem.create({
      data: {
        vendorBillId: bill.id,
        description: "Legacy",
        qty: 3,
        unitCost: 6,
        tenantId: null,
      },
    });
    await A.prisma.vendorBillItem.updateMany({
      where: { vendorBillId: bill.id },
      data: { tenantId: null },
    });
    await A.prisma.vendorBill.update({ where: { id: bill.id }, data: { totalOwed: 78 } });
    await inTenant(A, w, () =>
      A.bills.update(bill.id, {
        items: [{ productId: w.productId, description: "Widget", qty: 4, unitCost: 6 }],
      }),
    );
    let items = await A.prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    console.log(`B285(p) observed after edit: lines=${items.map((i) => i.qty)}`);
    expect(items.map((i) => Number(i.qty))).toEqual([4]);
    // the new line is stamped with the tenant
    expect(items[0].tenantId).toBe(w.tenantId);

    // editing the edited bill again (its line now carries the tenant stamp or not) replaces again
    await inTenant(A, w, () =>
      A.bills.update(bill.id, {
        items: [{ productId: w.productId, description: "Widget", qty: 7, unitCost: 6 }],
      }),
    );
    items = await A.prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(items.map((i) => Number(i.qty))).toEqual([7]);

    await inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId));
    console.log(`B285(p) observed after receive: stock=${(await productOf(w)).currentStock}`);
    expect(Number((await productOf(w)).currentStock)).toBe(57); // 50 + 7, not + 10 + 7
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect(Number(finalBill.totalOwed)).toBe(42); // 7 x 6
  });

  it("(p2) an edit that clears every line leaves none", async () => {
    const w = await seedWorld("p2");
    const bill = await draftBill(w);
    await inTenant(A, w, () => A.bills.update(bill.id, { items: [] }));
    const items = await A.prisma.vendorBillItem.findMany({ where: { vendorBillId: bill.id } });
    expect(items).toHaveLength(0);
  });

  it("(q) a payment that rounds to zero is refused, not written as a 0.00 row", async () => {
    const w = await seedWorld("q");
    const bill = await draftBill(w);
    await expect(pay(A, w, bill.id, 0.004)).rejects.toThrow(/greater than zero/i);
    const rows = await A.prisma.billPayment.findMany({ where: { vendorBillId: bill.id } });
    expect(rows).toHaveLength(0);
  });

  it("(r) revertToDraft() vs a parked payment: the revert is refused and stock stays with the bill", async () => {
    const w = await seedWorld("r");
    const bill = await draftBill(w);
    await inTenant(A, w, () => A.bills.receive(bill.id, undefined, w.userId));
    const [first, second] = await race(
      () => pay(A, w, bill.id, 20),
      () => inTenant(C, w, () => C.bills.revertToDraft(bill.id)),
    );
    const finalBill = await A.prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    console.log(
      `B285(r) observed: first=${first.status} second=${second.status}/${codeOf(second)} ` +
        `stock=${(await productOf(w)).currentStock} status=${finalBill.status} totalPaid=${finalBill.totalPaid}`,
    );
    expect(first.status).toBe("fulfilled");
    expect(codeOf(second)).toBe("BILL_STATE_CHANGED");
    expect(Number((await productOf(w)).currentStock)).toBe(60);
    expect(finalBill.status).toBe("PARTIAL");
    expect(Number(finalBill.totalPaid)).toBe(20);
  });
});
