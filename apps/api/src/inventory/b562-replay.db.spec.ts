/**
 * B562 PR-3 (SA-136 §4, §6.1 DB spec part 2) — the cost replay is history-preserving.
 *
 * Drives the REAL writers against real Postgres: `InventoryService.recordPurchase` (backdated via
 * `effectiveDate`), `decrementStockForSale` (the order sale, which since PR-2 books its SALE row) and
 * `InventoryService.recomputeCosts` (the endpoint's service call).
 *
 * Under test:
 * - the §0 pair (buy 10 @ $1, sell 8, buy 10 @ $3) replays to the TRUE average 2.6667 with the SALE
 *   rows present; the endpoint dry-runs by default and its apply APPENDS one dated COST_BASIS row;
 * - a backdated purchase (effectiveAt before the sale) is ACCEPTED and appends exactly one COST_BASIS
 *   correction, its own row keeping the snapshot of the state after its insertion;
 * - a second backdated purchase is folded correctly — a replay's own RECOMPUTE: row is never an input;
 * - snapshots on every pre-existing row are byte-identical before and after each replay;
 * - with the SALE rows deleted the ledger can't explain the counter: the endpoint reports the gap and
 *   a backdated purchase REFUSES (the L-207 guard still stands).
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Every tenant is a throwaway
 * `qa-b562-rp-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly the
 * rows this run created, in FK order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { ConflictException, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { decrementStockForSale } from "../orders/order-stock";
import { costAt, fetchCostIndex } from "../common/invoiced-sales";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b562-rp-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "b562-replay.db.spec.ts",
  );
};

const DAY = 24 * 3600 * 1000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const n = (v: Prisma.Decimal | null | undefined) => (v == null ? null : Number(v));

describeDb("B562 PR-3 history-preserving replay — real Postgres", () => {
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
    await prisma.stockLot.deleteMany({ where: { tenantId } });
    await prisma.stockMovement.deleteMany({ where: { tenantId } });
    await prisma.product.deleteMany({ where: { tenantId } });
    await prisma.user.deleteMany({ where: { tenantId } });
    await prisma.tenant.delete({ where: { id: tenantId } });
  }

  interface World {
    tenantId: string;
    operatorId: string;
    productId: string;
  }

  /**
   * The §0 pair on one AVCO product: 10 @ $1 dated three days ago, an order sale of 8 (now), then
   * 10 @ $3 (now) → counter 12, average (2×1 + 10×3)/12 = 2.6667.
   */
  async function seedPair(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B562 RP ${slug}` } });
    createdTenantIds.push(tenant.id);
    const operator = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "OPERATOR",
        tenantId: tenant.id,
      },
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
    const w: World = { tenantId: tenant.id, operatorId: operator.id, productId: product.id };
    await purchase(w, 10, 1, daysAgo(3));
    await inTx(w, (tx) =>
      decrementStockForSale(
        { logger: new Logger("b562-replay"), tenantId: w.tenantId },
        tx,
        [{ productId: w.productId, qty: 8 }],
        true,
        { orderId: randomUUID(), notes: "CREATE", performedById: w.operatorId },
      ),
    );
    await purchase(w, 10, 3);
    return w;
  }

  const inTx = <T>(w: World, fn: (tx: any) => Promise<T>) =>
    tenantCtx.run(w.tenantId, () => prisma.tenantTransaction(fn));
  const purchase = (w: World, quantity: number, unitCost: number, effectiveDate?: string) =>
    tenantCtx.run(w.tenantId, () =>
      inventory.recordPurchase(
        { productId: w.productId, quantity, unitCost, effectiveDate } as any,
        w.operatorId,
      ),
    );
  const recompute = (w: World, dto: Record<string, unknown>) =>
    tenantCtx.run(w.tenantId, () =>
      inventory.recomputeCosts({ productIds: [w.productId], ...dto }, w.operatorId),
    );
  /** SA-372: the point-in-time cost the COGS reader would use for this product at `at`. */
  const costOn = async (w: World, at: Date) =>
    costAt(
      await tenantCtx.run(w.tenantId, () =>
        fetchCostIndex(prisma.forTenant(), [w.productId], new Date()),
      ),
      w.productId,
      at,
    );
  const productRow = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
  const ledger = (w: World) =>
    prisma.stockMovement.findMany({
      where: { productId: w.productId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
  /** Every snapshot column that must be write-once, per row id. */
  const snapshots = async (w: World) =>
    new Map(
      (await ledger(w)).map((m) => [
        m.id,
        JSON.stringify([m.avgCostAfter, m.stockAfter, m.effectiveAt, m.createdAt, m.quantity]),
      ]),
    );
  const corrections = async (w: World) =>
    (await ledger(w)).filter(
      (m) => m.type === "COST_BASIS" && m.reference?.startsWith("RECOMPUTE:"),
    );

  it("the §0 pair replays to 2.6667 with the SALE rows present; dry run is the default; apply APPENDS one correction", async () => {
    const w = await seedPair("pair");
    expect(n((await productRow(w)).averageCost)).toBe(2.6667);
    expect(n((await productRow(w)).currentStock)).toBe(12);
    // What the old sales-blind replay wrote over it: (10×1 + 10×3)/20 = 2.0.
    await prisma.product.update({ where: { id: w.productId }, data: { averageCost: 2 } });
    const before = await snapshots(w);

    const dry = await recompute(w, {});
    expect(dry.dryRun).toBe(true);
    expect(dry.results).toEqual([
      expect.objectContaining({ gap: 0, oldAvgCost: 2, newAvgCost: 2.6667, correctionId: null }),
    ]);
    expect(n((await productRow(w)).averageCost)).toBe(2); // nothing written
    expect(await corrections(w)).toHaveLength(0);

    const applied = await recompute(w, { dryRun: false, reason: "B562 pin" });
    expect(applied.updated).toBe(1);
    expect(n((await productRow(w)).averageCost)).toBe(2.6667);
    const [c] = await corrections(w);
    expect(c.id).toBe(applied.results[0].correctionId);
    expect(c).toMatchObject({
      reference: "RECOMPUTE:ENDPOINT",
      notes: "2 → 2.6667",
      performedById: w.operatorId,
      tenantId: w.tenantId,
    });
    expect([n(c.quantity), n(c.unitCost), n(c.avgCostAfter), n(c.stockAfter)]).toEqual([
      0, 2.6667, 2.6667, 12,
    ]);
    // Write-once: every pre-existing row is byte-identical.
    const after = await snapshots(w);
    for (const [id, snap] of before) expect(after.get(id)).toBe(snap);

    // A second apply finds nothing to correct and writes nothing.
    const again = await recompute(w, { dryRun: false });
    expect(again.updated).toBe(0);
    expect(await corrections(w)).toHaveLength(1);
  });

  it("a backdated purchase is ACCEPTED, keeps its own snapshot, and appends exactly one COST_BASIS correction", async () => {
    const w = await seedPair("backdated");
    const before = await snapshots(w);
    // SA-372: a date before every backdated row below — its cost must never be restated.
    const early = new Date(daysAgo(2.8));
    const earlyCost = await costOn(w, early);
    expect(earlyCost).toBe(1);

    // D: 10 @ $5 dated two days ago — before the sale.
    const d = await purchase(w, 10, 5, daysAgo(2));
    // D's own row carries the state after ITS insertion: (12×2.6667 + 50)/22 = 3.7273, counter 22.
    const dRow = await prisma.stockMovement.findUniqueOrThrow({ where: { id: d.id } });
    expect([n(dRow.avgCostAfter), n(dRow.stockAfter)]).toEqual([3.7273, 22]);
    // The replay in accounting order: 10@1 → 1; +10@5 → 20 @ 3; sell 8 → 12; +10@3 → 22 @ 3.0.
    expect(n((await productRow(w)).averageCost)).toBe(3);
    const cs = await corrections(w);
    expect(cs).toHaveLength(1);
    expect(cs[0]).toMatchObject({ reference: `RECOMPUTE:PURCHASE:${d.id}`, notes: "3.7273 → 3" });
    expect([n(cs[0].avgCostAfter), n(cs[0].stockAfter)]).toEqual([3, 22]);
    const after = await snapshots(w);
    for (const [id, snap] of before) expect(after.get(id)).toBe(snap);
    // SA-372: the correction dated now is the tail the cost index reads, so the current period
    // costs at the replayed average; the earlier period is untouched.
    expect(await costOn(w, new Date())).toBe(n((await productRow(w)).averageCost));
    expect(await costOn(w, early)).toBe(earlyCost);

    // E: 10 @ $1 dated 2.5 days ago. The fold must skip the RECOMPUTE row above — folding it would
    // pin the average at 3 and "correct" E away. Own row: (22×3 + 10)/32 = 2.375, counter 32.
    // Fold: 10@1 → 1; +10@1 → 20 @ 1; +10@5 → 30 @ 2.3333; sell 8 → 22; +10@3 → 32 @ 2.5416.
    const e = await purchase(w, 10, 1, daysAgo(2.5));
    const eRow = await prisma.stockMovement.findUniqueOrThrow({ where: { id: e.id } });
    expect([n(eRow.avgCostAfter), n(eRow.stockAfter)]).toEqual([2.375, 32]);
    expect(n((await productRow(w)).averageCost)).toBe(2.5416);
    const cs2 = await corrections(w);
    expect(cs2).toHaveLength(2);
    expect(cs2[1]).toMatchObject({
      reference: `RECOMPUTE:PURCHASE:${e.id}`,
      notes: "2.375 → 2.5416",
    });
    expect(await recompute(w, {})).toMatchObject({
      results: [expect.objectContaining({ gap: 0, newAvgCost: 2.5416 })],
    });
    expect(await costOn(w, new Date())).toBe(2.5416);
    expect(await costOn(w, early)).toBe(earlyCost);
    // Idempotent: the correction is now the tail, so a second apply writes nothing.
    expect((await recompute(w, { dryRun: false })).updated).toBe(0);
    expect(await corrections(w)).toHaveLength(2);
  });

  it("with the SALE rows deleted the ledger can't explain the counter: the endpoint reports it and a backdated purchase REFUSES", async () => {
    const w = await seedPair("refuse");
    await prisma.stockMovement.deleteMany({ where: { productId: w.productId, type: "SALE" } });
    const before = await snapshots(w);

    const res = await recompute(w, { dryRun: false });
    expect(res.results).toEqual([]);
    expect(res.gapsDetected).toEqual([
      expect.objectContaining({ productId: w.productId, stockDrift: -8 }),
    ]);
    await expect(purchase(w, 10, 5, daysAgo(2))).rejects.toBeInstanceOf(ConflictException);

    // Nothing was written: no correction, the average and every snapshot untouched.
    expect(await corrections(w)).toHaveLength(0);
    expect(n((await productRow(w)).averageCost)).toBe(2.6667);
    expect(n((await productRow(w)).currentStock)).toBe(12);
    expect(await snapshots(w)).toEqual(before);
  });
});
