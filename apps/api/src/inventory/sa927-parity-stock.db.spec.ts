/**
 * SA-927 PR-A parity - the NON-order stock writers of inventory.service.ts against real Postgres.
 *
 * Every `it` runs one stock event on fresh products and asserts, with `toEqual`, the LITERAL state the
 * event leaves: Product.currentStock, Product.averageCost and every StockMovement row it wrote (type,
 * quantity, reference with ids tokenized, effectiveAt "now"/ISO, stockAfter, avgCostAfter). The expected
 * values come from the business rule (e.g. stock 10 @ 2.00, purchase 10 @ 4 -> avg 3.00, PURCHASE +10,
 * stockAfter 20, avgCostAfter 3), and are GREEN on master. The one-helper change (SA-927 PR-A) must keep
 * them green unchanged - that is the parity proof. `expectLedgerConsistent` closes every event.
 *
 * `STOCK_PARITY_DUMP=<file>` (see testing/stock-parity.ts) also dumps each state for a master/branch diff.
 *
 * Collected only by `jest.db.config.js` (`.db.spec.ts$`). Throwaway `qa-sa927-<run>` tenant
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

describeDb("SA-927 parity - inventory stock writers write the same rows", () => {
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
    const slug = assertTestTenant(`qa-sa927-${RUN}`, "sa927-parity-stock.db.spec.ts");
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
          console.error("SA-927 parity-stock cleanup step failed:", e);
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

  // ── inventory.recordPurchase ────────────────────────────────────────────────

  it("recordPurchase AVCO: 10 @ 2.00 + 10 @ 4 -> 20 @ 3.00, one PURCHASE row", async () => {
    const p = await product({ label: "Purchase AVCO", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() =>
      inventory.recordPurchase(
        { productId: p.id, quantity: 10, unitCost: 4, supplierId, reference: "REF-P-AVCO" } as any,
        userId,
      ),
    );
    expect(await state(p.id, window, "inventory.purchase.avco")).toEqual({
      currentStock: 20,
      averageCost: 3,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "REF-P-AVCO",
          effectiveAt: "now",
          stockAfter: 20,
          avgCostAfter: 3,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("recordPurchase STANDARD: the receipt does not move the average (2.00 stays), stock 20", async () => {
    const p = await product({
      label: "Purchase STD",
      stock: 10,
      avg: 2,
      method: "STANDARD",
      standardCost: 5,
    });
    const window = parityWindow();
    await inTenant(() =>
      inventory.recordPurchase(
        { productId: p.id, quantity: 10, unitCost: 4, reference: "REF-P-STD" } as any,
        userId,
      ),
    );
    expect(await state(p.id, window, "inventory.purchase.standard")).toEqual({
      currentStock: 20,
      averageCost: 2,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "REF-P-STD",
          effectiveAt: "now",
          stockAfter: 20,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("recordPurchase back-dated before the opening row: the row keeps its date, replay may append COST_BASIS", async () => {
    const p = await product({ label: "Purchase backdated", stock: 10, avg: 2 });
    const window = parityWindow();
    const backdated = new Date(Date.now() - 2 * 3_600_000);
    const movement = await inTenant(() =>
      inventory.recordPurchase(
        {
          productId: p.id,
          quantity: 10,
          unitCost: 4,
          reference: "REF-P-BACK",
          effectiveDate: backdated.toISOString(),
        } as any,
        userId,
      ),
    );
    // The PURCHASE row is the write-once snapshot of the counter fold: stock 10 + 10 = 20, avg
    // (10 * 2 + 10 * 4) / 20 = 3.00, dated 2h ago. The opening row (+10 at -1h, no cost) is NEWER, so the
    // replay re-folds the ledger from the purchase (10 @ 4 -> average 4.00), moves the average and appends
    // ONE dated zero-quantity COST_BASIS correction named RECOMPUTE:PURCHASE:<movement id> (SA-136 s4).
    expect(
      await state(p.id, window, "inventory.purchase.backdated", { [movement.id]: "<movement>" }),
    ).toEqual({
      currentStock: 20,
      averageCost: 4, // SA-927: master value (the replayed average, not the snapshot's 3)
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "REF-P-BACK",
          effectiveAt: backdated.toISOString(),
          stockAfter: 20,
          avgCostAfter: 3,
        },
        {
          type: "COST_BASIS",
          quantity: 0,
          reference: "RECOMPUTE:PURCHASE:<movement>",
          effectiveAt: "now",
          stockAfter: 20,
          avgCostAfter: 4,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── inventory.recordAdjustment ──────────────────────────────────────────────

  it("recordAdjustment +5 on 10 @ 2.00 -> 15, the average never moves", async () => {
    const p = await product({ label: "Adjust plus", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() =>
      inventory.recordAdjustment(
        { productId: p.id, quantity: 5, reference: "REF-A-PLUS", notes: "found" } as any,
        userId,
      ),
    );
    expect(await state(p.id, window, "inventory.adjust.plus")).toEqual({
      currentStock: 15,
      averageCost: 2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: 5,
          reference: "REF-A-PLUS",
          effectiveAt: "now",
          stockAfter: 15,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("recordAdjustment -4 on 10 @ 2.00 -> 6, the average never moves", async () => {
    const p = await product({ label: "Adjust minus", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() =>
      inventory.recordAdjustment(
        { productId: p.id, quantity: -4, reference: "REF-A-MINUS", notes: "damaged" } as any,
        userId,
      ),
    );
    expect(await state(p.id, window, "inventory.adjust.minus")).toEqual({
      currentStock: 6,
      averageCost: 2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: -4,
          reference: "REF-A-MINUS",
          effectiveAt: "now",
          stockAfter: 6,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── inventory.recordSale ────────────────────────────────────────────────────

  it("recordSale 3 of 10 @ 2.00 -> 7, one SALE row costed at the average", async () => {
    const p = await product({ label: "Sale", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() =>
      prisma.tenantTransaction((tx) =>
        inventory.recordSale(p.id, new Prisma.Decimal(3), "REF-SALE", userId, tx),
      ),
    );
    expect(await state(p.id, window, "inventory.recordSale")).toEqual({
      currentStock: 7,
      averageCost: 2,
      rows: [
        {
          type: "SALE",
          quantity: -3,
          reference: "REF-SALE",
          effectiveAt: "now",
          stockAfter: 7,
          avgCostAfter: 2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── stock count commit (legacy client-session path -> applyStockCountItemsInTx) ──

  it("commitStockCount: REPLACE 7 on 10 -> -3, ADD 4 on 5 -> +4, one ADJUSTMENT row each", async () => {
    const replace = await product({ label: "Count replace", stock: 10, avg: 2 });
    const add = await product({ label: "Count add", stock: 5, avg: 1.5 });
    const sessionId = randomUUID();
    const window = parityWindow();
    await inTenant(() =>
      inventory.commitStockCount(
        {
          sessionId,
          items: [
            { productId: replace.id, quantity: 7, mode: "REPLACE" },
            { productId: add.id, quantity: 4, mode: "ADD" },
          ],
        } as any,
        userId,
      ),
    );
    const tokens = { [sessionId]: "<session>" };
    expect(await state(replace.id, window, "inventory.count.replace", tokens)).toEqual({
      currentStock: 7,
      averageCost: 2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: -3,
          reference: "STOCK_COUNT-<session>",
          effectiveAt: "now",
          stockAfter: 7,
          avgCostAfter: 2,
        },
      ],
    });
    expect(await state(add.id, window, "inventory.count.add", tokens)).toEqual({
      currentStock: 9,
      averageCost: 1.5,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: 4,
          reference: "STOCK_COUNT-<session>",
          effectiveAt: "now",
          stockAfter: 9,
          avgCostAfter: 1.5,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [replace.id, add.id], pool);
  });

  // ── inventory.assignToVariants ──────────────────────────────────────────────

  it("assignToVariants: parent 20 @ 3.00 -> variant A +5 (0 stock), variant B +6 (4 @ 1.00)", async () => {
    const parent = await product({ label: "Variant parent", stock: 20, avg: 3 });
    const a = await product({
      label: "Variant A",
      stock: 0,
      avg: null,
      parentProductId: parent.id,
    });
    const b = await product({ label: "Variant B", stock: 4, avg: 1, parentProductId: parent.id });
    const window = parityWindow();
    await inTenant(() =>
      inventory.assignToVariants(
        {
          parentProductId: parent.id,
          assignments: [
            { productId: a.id, qty: 5 },
            { productId: b.id, qty: 6 },
          ],
        } as any,
        userId,
      ),
    );
    const tokens = await uuidTokens([parent.id, a.id, b.id]);
    // parent: -11 at its own average (unchanged). A: nextAverage(0 @ null, 5 @ 3) = 3.00.
    // B: (4 * 1 + 6 * 3) / 10 = 2.20.
    expect(await state(parent.id, window, "inventory.assign.parent", tokens)).toEqual({
      currentStock: 9,
      averageCost: 3,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: -11,
          reference: "VARIANT_ASSIGN-<id1>",
          effectiveAt: "now",
          stockAfter: 9,
          avgCostAfter: 3,
        },
      ],
    });
    expect(await state(a.id, window, "inventory.assign.variantA", tokens)).toEqual({
      currentStock: 5,
      averageCost: 3,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: 5,
          reference: "VARIANT_ASSIGN-<id1>",
          effectiveAt: "now",
          stockAfter: 5,
          avgCostAfter: 3,
        },
      ],
    });
    expect(await state(b.id, window, "inventory.assign.variantB", tokens)).toEqual({
      currentStock: 10,
      averageCost: 2.2,
      rows: [
        {
          type: "ADJUSTMENT",
          quantity: 6,
          reference: "VARIANT_ASSIGN-<id1>",
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 2.2,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [parent.id, a.id, b.id], pool);
  });

  // ── purchase orders: receive, then an edit that reverses + re-posts ─────────

  async function receivedPo(productId: string, qty: number, cost: number) {
    const created = await inTenant(() =>
      inventory.createPurchaseOrder(
        { supplierId, items: [{ productId, qty, unitCost: cost }] },
        userId,
      ),
    );
    await inTenant(() => inventory.sendPurchaseOrder(created.id));
    return created;
  }

  it("receivePurchaseOrder: 10 @ 4 on 10 @ 2.00 -> 20 @ 3.00, one PURCHASE row named by the PO number", async () => {
    const p = await product({ label: "PO receive", stock: 10, avg: 2 });
    const created = await receivedPo(p.id, 10, 4);
    const window = parityWindow();
    await inTenant(() =>
      inventory.receivePurchaseOrder(
        created.id,
        { items: [{ itemId: created.items[0].id, receivedQty: 10 }] },
        userId,
      ),
    );
    expect(
      await state(p.id, window, "inventory.po.receive", { [created.poNumber]: "<po>" }),
    ).toEqual({
      currentStock: 20,
      averageCost: 3,
      rows: [
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<po>",
          effectiveAt: "now",
          stockAfter: 20,
          avgCostAfter: 3,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("updatePurchaseOrder reapplyInventory: reverse the receipt (-10), re-post 10 @ 6 -> 20 @ 4.00", async () => {
    const p = await product({ label: "PO edit", stock: 10, avg: 2 });
    const created = await receivedPo(p.id, 10, 4);
    await inTenant(() =>
      inventory.receivePurchaseOrder(
        created.id,
        { items: [{ itemId: created.items[0].id, receivedQty: 10 }] },
        userId,
      ),
    );
    const window = parityWindow();
    await new Promise((r) => setTimeout(r, 60));
    const since = new Date(); // the receipt above stays out of the asserted rows
    await inTenant(() =>
      inventory.updatePurchaseOrder(
        created.id,
        {
          reapplyInventory: true,
          items: [{ id: created.items[0].id, productId: p.id, qtyOrdered: 10, unitCost: 6 }],
        } as any,
        userId,
      ),
    );
    // receipt 20 @ 3.00 -> reversal (10 @ 4 out of 20 @ 3: (60 - 40) / 10 = 2.00) at stock 10 ->
    // re-post (10 * 2 + 10 * 6) / 20 = 4.00 at stock 20. The receipt row was written before `window`
    // started, so `since` keeps only the two rows the edit wrote.
    expect(
      await state(p.id, window, "inventory.po.edit", { [created.poNumber]: "<po>" }, since),
    ).toEqual({
      currentStock: 20,
      averageCost: 4,
      rows: [
        {
          type: "PURCHASE",
          quantity: -10,
          reference: "<po>",
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 2,
        },
        {
          type: "PURCHASE",
          quantity: 10,
          reference: "<po>",
          effectiveAt: "now",
          stockAfter: 20,
          avgCostAfter: 4,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  // ── inventory.setCostBasis ──────────────────────────────────────────────────

  it("setCostBasis AVCO: 10 @ 2.00 -> average 5, a zero-quantity COST_BASIS row", async () => {
    const p = await product({ label: "Cost basis AVCO", stock: 10, avg: 2 });
    const window = parityWindow();
    await inTenant(() =>
      inventory.setCostBasis(p.id, { unitCost: 5, notes: "correct" } as any, userId),
    );
    expect(await state(p.id, window, "inventory.costBasis.avco")).toEqual({
      currentStock: 10,
      averageCost: 5,
      rows: [
        {
          type: "COST_BASIS",
          quantity: 0,
          reference: null,
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 5,
        },
      ],
    });
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });

  it("setCostBasis STANDARD: average and standardCost both become 5", async () => {
    const p = await product({
      label: "Cost basis STD",
      stock: 10,
      avg: 2,
      method: "STANDARD",
      standardCost: 3,
    });
    const window = parityWindow();
    await inTenant(() =>
      inventory.setCostBasis(p.id, { unitCost: 5, notes: "correct" } as any, userId),
    );
    expect(await state(p.id, window, "inventory.costBasis.standard")).toEqual({
      currentStock: 10,
      averageCost: 5,
      rows: [
        {
          type: "COST_BASIS",
          quantity: 0,
          reference: null,
          effectiveAt: "now",
          stockAfter: 10,
          avgCostAfter: 5,
        },
      ],
    });
    const after = await prisma.product.findUniqueOrThrow({ where: { id: p.id } });
    expect(Number(after.standardCost)).toBe(5);
    await expectLedgerConsistent(tenantId, [p.id], pool);
  });
});
