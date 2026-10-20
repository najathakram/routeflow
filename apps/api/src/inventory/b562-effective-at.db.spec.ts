/**
 * B562 PR-1 (SA-136 §3) — DB-lane proof for `StockMovement.effectiveAt`.
 *
 * `effectiveAt` is a movement's accounting date; `createdAt` is write-once insertion time. The
 * backdated writers (recordPurchase / recordAdjustment here; vendor-bill receive and the stock-count
 * commit in their unit specs) put the effective date in `effectiveAt` and leave `createdAt` to the
 * database. The replay and the point-in-time cost index order by (effectiveAt, createdAt, id), so a
 * backdated row inserted LAST still sorts at its own date. This PR is behaviour-neutral: a gap-free
 * replay yields the same figures master produced when the date sat in `createdAt`. The replay's
 * snapshot REWRITE on gap-free products is unchanged here; SA-136 §4 removes it in PR-3.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`), run via `npm run local:test:db`.
 * `requireLocalDatabaseUrl()` refuses any non-local host. Every tenant is a throwaway
 * `qa-b562-pr1-<run>-<n>-<label>` slug approved by `assertTestTenant`; `afterAll` deletes exactly
 * the rows this run created, in FK order.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { costAt, fetchCostIndex } from "../common/invoiced-sales";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN_SUFFIX = randomUUID().slice(0, 8);
let tenantSeq = 0;
const freshTenantSlug = (label: string): string => {
  tenantSeq += 1;
  return assertTestTenant(
    `qa-b562-pr1-${RUN_SUFFIX}-${tenantSeq}-${label}`,
    "b562-effective-at.db.spec.ts",
  );
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const d1 = new Date(NOW - 10 * DAY);
const d2 = new Date(NOW - 8 * DAY);
const d3 = new Date(NOW - 6 * DAY);
const d4 = new Date(NOW - 4 * DAY);

const n4 = (v: Prisma.Decimal | null | undefined) =>
  v == null ? null : Number(Number(v).toFixed(4));

describeDb("B562 PR-1 effectiveAt — real Postgres", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let service: InventoryService;
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
    service = module.get(InventoryService);
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
    userId: string;
    productId: string;
  }

  /** A tenant with one AVCO product at zero stock and an operator. */
  async function seedWorld(label: string): Promise<World> {
    const slug = freshTenantSlug(label);
    const tenant = await prisma.tenant.create({ data: { slug, name: `B562 PR-1 ${slug}` } });
    createdTenantIds.push(tenant.id);
    const user = await prisma.user.create({
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
        pricePerUnit: 25,
        currentStock: 0,
        costingMethod: "AVCO",
        tenantId: tenant.id,
      },
    });
    return { tenantId: tenant.id, userId: user.id, productId: product.id };
  }

  const inTenant = <T>(w: World, fn: () => Promise<T>) => tenantCtx.run(w.tenantId, fn);
  const purchase = (w: World, quantity: number, unitCost: number, at: Date) =>
    inTenant(w, () =>
      service.recordPurchase(
        { productId: w.productId, quantity, unitCost, effectiveDate: at.toISOString() },
        w.userId,
      ),
    );
  const productOf = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });

  it("a backdated purchase and adjustment store the date in effectiveAt; createdAt is the insertion time", async () => {
    const w = await seedWorld("dates");
    const before = Date.now();
    const bought = await purchase(w, 10, 4, d2);
    const adjusted = await inTenant(w, () =>
      service.recordAdjustment(
        {
          productId: w.productId,
          quantity: -1,
          effectiveDate: d3.toISOString(),
          reason: "COUNT_CORRECTION",
        },
        w.userId,
      ),
    );

    for (const [row, at] of [
      [bought, d2],
      [adjusted, d3],
    ] as const) {
      const stored = await prisma.stockMovement.findUniqueOrThrow({ where: { id: row.id } });
      expect(stored.effectiveAt.getTime()).toBe(at.getTime());
      // Write-once insertion time: now, not the backdate (clock-skew slack of a minute).
      expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    }
  });

  // B562 PR-3 (SA-136 §4) made snapshots WRITE-ONCE: a backdated row carries the state after ITS
  // insertion, and the replay folds in accounting order but rewrites no row — it appends a dated
  // COST_BASIS correction only when the average it implies differs (here it doesn't).
  it("the replay folds a backdated purchase inserted LAST at its own date; every row keeps its insertion snapshot", async () => {
    const w = await seedWorld("replay");
    await purchase(w, 100, 10, d1);
    await purchase(w, 50, 12, d4);
    // Inserted last, dated between the two: the replay must fold it second.
    await purchase(w, 100, 20, d2);

    const p = await productOf(w);
    expect(Number(p.currentStock)).toBe(250);
    // d1 100@10 → d2 +100@20 = 200@15 → d4 +50@12 = 250@14.4
    expect(n4(p.averageCost)).toBe(14.4);

    const rows = await prisma.stockMovement.findMany({
      where: { productId: w.productId },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });
    // In accounting order d1, d2, d4 — each row's own insertion-time state: d1 100@10; d4 inserted
    // second (150 @ (100×10 + 50×12)/150 = 10.6667); d2 inserted last (250 @ (150×10.6667 + 100×20)/250
    // = 14.4). The fold (d1 → d2 → d4) is 14.4 = the average, but the LAST row in accounting order (d4)
    // holds 10.6667 — the figure the cost index would read for today — so the replay appends one
    // COST_BASIS row dated now carrying 14.4.
    expect(rows.map((r) => Number(r.stockAfter))).toEqual([100, 250, 150, 250]);
    expect(rows.map((r) => n4(r.avgCostAfter))).toEqual([10, 14.4, 10.6667, 14.4]);
    expect(rows.map((r) => r.type)).toEqual(["PURCHASE", "PURCHASE", "PURCHASE", "COST_BASIS"]);
    expect(rows[3].notes).toBe("as-of-now snapshot 10.6667 → 14.4");
  });

  it("the point-in-time cost index keys on effectiveAt, so a backdated receipt costs the period it belongs to", async () => {
    const w = await seedWorld("costidx");
    await purchase(w, 100, 10, d1);
    await purchase(w, 50, 12, d4);
    await purchase(w, 100, 20, d2);

    const index = await inTenant(w, () =>
      fetchCostIndex(prisma.forTenant(), [w.productId], new Date()),
    );
    expect(costAt(index, w.productId, new Date(d1.getTime() + DAY))).toBe(10);
    // The backdated d2 receipt keys the period it belongs to (not insertion day), carrying the average
    // known when it was entered — PR-3's write-once snapshots never restate a past period.
    expect(costAt(index, w.productId, d3)).toBe(14.4);
    expect(costAt(index, w.productId, new Date())).toBe(14.4);
  });
});
