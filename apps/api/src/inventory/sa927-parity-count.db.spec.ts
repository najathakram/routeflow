/**
 * SA-927 PR-A / SA-929 §5 parity - the stock COUNT commits against real Postgres: the durable session
 * (commitStockCountSession) and the legacy client session (commitStockCount), on the lines SA-929 names:
 * a changed line, an unchanged line (counted == expected: no movement), an expected-qty mismatch (a sale
 * landed after the count: the line books counted - expected, the sale survives), a cost-override line, an
 * ADD line, and a legacy REPLACE that names one product twice. Each `it` asserts with `toEqual` the LITERAL
 * state master leaves (Product.currentStock / averageCost and every StockMovement row); the one-helper
 * branch must keep them green unchanged. `STOCK_PARITY_DUMP=<file>` dumps each state for a master/branch diff.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts). Throwaway `qa-sa927-<run>` tenant
 * (`assertTestTenant`); `afterAll` deletes exactly what the run created.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import { Prisma } from "@prisma/client";
import { InventoryService } from "./inventory.service";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { parityState, parityWindow } from "./testing/stock-parity";
import { expectLedgerConsistent, seedOpeningRow } from "./testing/ledger-consistency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

describeDb("SA-927 parity - stock count commits write the same rows (SA-929 §5)", () => {
  let pool: Pool;
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inventory: InventoryService;
  let tenantId = "";
  let userId = "";
  let supplierId = "";
  let seq = 0;

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
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
    const slug = assertTestTenant(`qa-sa927-${RUN}`, "sa927-parity-count.db.spec.ts");
    tenantId = (await prisma.tenant.create({ data: { slug, name: `SA-927 ${slug}` } })).id;
    userId = (
      await prisma.user.create({
        data: { email: `${slug}@example.invalid`, username: slug, role: "OPERATOR", tenantId },
      })
    ).id;
    supplierId = (await prisma.supplier.create({ data: { name: `Supplier ${slug}`, tenantId } }))
      .id;
  }, 120_000);

  afterAll(async () => {
    if (tenantId) {
      const pos = await prisma.purchaseOrder.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const steps: Array<() => Promise<unknown>> = [
        () =>
          prisma.purchaseOrderItem.deleteMany({ where: { poId: { in: pos.map((p) => p.id) } } }),
        () => prisma.purchaseOrder.deleteMany({ where: { tenantId } }),
        () => prisma.stockCountLine.deleteMany({ where: { tenantId } }),
        () => prisma.stockCountSession.deleteMany({ where: { tenantId } }),
        () => prisma.stockLot.deleteMany({ where: { tenantId } }),
        () => prisma.stockMovement.deleteMany({ where: { tenantId } }),
        () => prisma.auditLog.deleteMany({ where: { tenantId } }),
        () => prisma.product.deleteMany({ where: { tenantId, parentProductId: { not: null } } }),
        () => prisma.product.deleteMany({ where: { tenantId } }),
        () => prisma.supplier.deleteMany({ where: { tenantId } }),
        () => prisma.user.deleteMany({ where: { tenantId } }),
        () => prisma.tenant.deleteMany({ where: { id: tenantId } }),
      ];
      for (const step of steps) {
        // eslint-disable-next-line no-await-in-loop
        await step().catch((e: unknown) => {
          // eslint-disable-next-line no-console
          console.error("SA-927 parity-count cleanup step failed:", e);
        });
      }
    }
    await prisma?.$disconnect();
    await pool?.end();
  }, 120_000);

  const inTenant = <T>(fn: () => Promise<T>) => tenantCtx.run(tenantId, fn);

  /** A fresh product with its opening row (stock `stock`, one hour old) and an optional average. */
  async function product(opts: {
    label: string;
    stock: number;
    avg?: number | null;
    method?: "AVCO" | "STANDARD";
    standardCost?: number;
    parentProductId?: string;
  }) {
    seq += 1;
    const p = await prisma.product.create({
      data: {
        tenantId,
        name: `${opts.label} ${RUN}-${seq}`,
        sku: `S927-${RUN}-${seq}`,
        unit: "ea",
        pricePerUnit: 10,
        currentStock: opts.stock,
        averageCost: opts.avg ?? null,
        costingMethod: opts.method ?? "AVCO",
        ...(opts.standardCost != null ? { standardCost: opts.standardCost } : {}),
        ...(opts.parentProductId ? { parentProductId: opts.parentProductId } : {}),
      },
    });
    if (opts.stock !== 0) await seedOpeningRow(pool, tenantId, p.id, opts.stock);
    return p;
  }

  /** Every uuid inside the product's references becomes `<id1>`, `<id2>`... in order of appearance. */
  async function uuidTokens(productIds: string[]): Promise<Record<string, string>> {
    const { rows } = await pool.query(
      `SELECT reference FROM "StockMovement" WHERE "productId" = ANY($1::text[])
        ORDER BY "createdAt", id`,
      [productIds],
    );
    const tokens: Record<string, string> = {};
    for (const r of rows) {
      for (const m of String(r.reference ?? "").match(UUID_RE) ?? []) {
        if (!(m in tokens)) tokens[m] = `<id${Object.keys(tokens).length + 1}>`;
      }
    }
    return tokens;
  }

  const state = async (
    productId: string,
    window: ReturnType<typeof parityWindow>,
    label: string,
    tokens: Record<string, string> = {},
    since: Date = window.start,
  ) => parityState(pool, productId, { window, since, tokens, label });

  const adj = (quantity: number, stockAfter: number, avgCostAfter: number | null) => ({
    type: "ADJUSTMENT",
    quantity,
    reference: "STOCK_COUNT-<session>",
    effectiveAt: "now",
    stockAfter,
    avgCostAfter,
  });

  /** A durable session with one line per entry, every line counted by the spec's user. */
  async function countSession(
    lines: Array<{
      productId: string;
      mode?: "REPLACE" | "ADD";
      counted: number;
      expected: number;
      unitCostOverride?: number;
    }>,
  ) {
    const session = await prisma.stockCountSession.create({
      data: { tenantId, startedById: userId, name: `sa927 count ${RUN}` },
    });
    for (const l of lines) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.stockCountLine.create({
        data: {
          tenantId,
          sessionId: session.id,
          productId: l.productId,
          mode: l.mode ?? "REPLACE",
          countedQty: l.counted,
          expectedQty: l.expected,
          ...(l.unitCostOverride != null ? { unitCostOverride: l.unitCostOverride } : {}),
          countedById: userId,
        },
      });
    }
    return session;
  }

  // ── durable session (commitStockCountSession -> applyStockCountItemsInTx) ───────────────────────

  it("session: changed line (7 counted of 10) -> -3; unchanged line (10 of 10) -> no row", async () => {
    const changed = await product({ label: "Session changed", stock: 10, avg: 2 });
    const same = await product({ label: "Session unchanged", stock: 10, avg: 2 });
    const session = await countSession([
      { productId: changed.id, counted: 7, expected: 10 },
      { productId: same.id, counted: 10, expected: 10 },
    ]);
    const window = parityWindow();
    await inTenant(() => inventory.commitStockCountSession(session.id, {} as any, { sub: userId }));
    const tokens = { [session.id]: "<session>" };
    expect(await state(changed.id, window, "inventory.session.changed", tokens)).toEqual({
      currentStock: 7,
      averageCost: 2,
      rows: [adj(-3, 7, 2)],
    });
    expect(await state(same.id, window, "inventory.session.unchanged", tokens)).toEqual({
      currentStock: 10,
      averageCost: 2,
      rows: [],
    });
    await expectLedgerConsistent(tenantId, [changed.id, same.id], pool);
  });

  it("session: expected-qty mismatch (counted 8 of an expected 10, then a sale of 3) -> -2 on the post-sale 7", async () => {
    const p = await product({ label: "Session mismatch", stock: 10, avg: 2 });
    const session = await countSession([{ productId: p.id, counted: 8, expected: 10 }]);
    const window = parityWindow();
    await inTenant(() =>
      prisma.tenantTransaction((tx) =>
        inventory.recordSale(p.id, new Prisma.Decimal(3), "REF-COUNT-SALE", userId, tx),
      ),
    );
    await inTenant(() => inventory.commitStockCountSession(session.id, {} as any, { sub: userId }));
    expect(
      await state(p.id, window, "inventory.session.mismatch", { [session.id]: "<session>" }),
    ).toEqual({
      currentStock: 5,
      averageCost: 2,
      rows: [
        {
          type: "SALE",
          quantity: -3,
          reference: "REF-COUNT-SALE",
          effectiveAt: "now",
          stockAfter: 7,
          avgCostAfter: 2,
        },
        adj(-2, 5, 2),
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("session: cost override 5.00 on a +2 line -> a COST_BASIS row and the adjustment at 5.00; ADD 4 -> +4", async () => {
    const cost = await product({ label: "Session cost", stock: 10, avg: 2 });
    const add = await product({ label: "Session add", stock: 5, avg: 1.5 });
    const session = await countSession([
      { productId: cost.id, counted: 12, expected: 10, unitCostOverride: 5 },
      { productId: add.id, mode: "ADD", counted: 4, expected: 5 },
    ]);
    const window = parityWindow();
    await inTenant(() => inventory.commitStockCountSession(session.id, {} as any, { sub: userId }));
    const tokens = { [session.id]: "<session>" };
    expect(await state(cost.id, window, "inventory.session.cost", tokens)).toEqual({
      currentStock: 12,
      averageCost: 5,
      // master's fold order (effectiveAt, createdAt, id): the adjustment carries the commit's effective
      // date, taken before the cost row's insert defaults its own, so the adjustment reads first
      rows: [
        adj(2, 12, 5),
        {
          type: "COST_BASIS",
          quantity: 0,
          reference: "STOCK_COUNT-<session>",
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 5,
        },
      ],
    });
    expect(await state(add.id, window, "inventory.session.add", tokens)).toEqual({
      currentStock: 9,
      averageCost: 1.5,
      rows: [adj(4, 9, 1.5)],
    });
    // Not the cost product: on master too, its fold-order newest row is the COST_BASIS (stockAfter 10),
    // not the adjustment (12), so the newest-stockAfter check reads 10 against the counter 12. A
    // pre-existing ordering of the session commit, unchanged by PR-A (raised in the PR, not fixed here).
    await expectLedgerConsistent(tenantId, [add.id], pool);
  });

  // ── legacy client session: one product named twice ─────────────────────────────────────────────

  it("commitStockCount: REPLACE 7 then REPLACE 4 on one product of 10 -> the counter ends at the last count", async () => {
    const p = await product({ label: "Count twice", stock: 10, avg: 2 });
    const sessionId = randomUUID();
    const window = parityWindow();
    await inTenant(() =>
      inventory.commitStockCount(
        {
          sessionId,
          items: [
            { productId: p.id, quantity: 7, mode: "REPLACE" },
            { productId: p.id, quantity: 4, mode: "REPLACE" },
          ],
        } as any,
        userId,
      ),
    );
    expect(
      await state(p.id, window, "inventory.count.replace.twice", { [sessionId]: "<session>" }),
    ).toEqual({
      currentStock: 4,
      averageCost: 2,
      rows: [adj(-3, 7, 2), adj(-3, 4, 2)],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });
});
