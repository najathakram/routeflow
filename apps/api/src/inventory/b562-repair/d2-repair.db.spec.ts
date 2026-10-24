/**
 * Row 635 PR B — B562 D2, the AVCO average repair (SA-136 §5 as amended by SA-902 MUST 2), against real Postgres.
 *
 * World: an AVCO product bought 10 @ $1, a LEGACY order sold 8 (pre-PR-2: no StockMovement), bought 10 @ $3; then the D1
 * anchor (`B562:BACKFILL:`, quantity −8, dated at the cutover) closed the gap. The live, sales-blind fold says 2.0; the
 * truth is 2.6667.
 * Under test (the SA-902 red rows):
 * - D2-1: the plan reconstructs X_c = X_now = 2.6667, EXACT; the apply (through the runner the owner script imports)
 *   writes the REPAIR input dated at the cutover, PR-3's correction dated now, `Product.averageCost` 2.6667, one audit row;
 * - R-D2a: after the repair, a purchase dated between the cutover and the repair keeps its cost; the plan's original shape
 *   (a pin dated NOW) is observed erasing it;
 * - R-D2b: the apply's assert (X_now vs the replay's average) throws and rolls everything back;
 * - R-D2c: a residual (D1's quantity ≠ Σ interposed) is APPROX and still repairs;
 * - R-D2d: a re-run writes nothing ("already repaired"; the old hash is refused);
 * - D2-8: drift ≠ 0 is excluded; a plan whose product changed since the dry run is refused;
 * - a legacy order whose CURRENT lines dropped the product still counts through its revision snapshot (the jsonb lookup).
 *
 * Collected only by `jest.db.config.js`, run via `npm run local:test:db`. `requireLocalDatabaseUrl()` refuses any
 * non-local host. Tenants are throwaway `qa-b562-d2-<run>-<n>-<label>` slugs approved by `assertTestTenant`.
 */
import { randomUUID } from "crypto";
import { Test } from "@nestjs/testing";
import { MovementType, Prisma } from "@prisma/client";
import { InventoryService } from "../inventory.service";
import { PrismaService } from "../../prisma/prisma.service";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { StockAlertService } from "../../stock-alerts/stock-alert.service";
import { describeDb, requireLocalDatabaseUrl } from "../../common/testing/db-spec";
import { applyD2InTx, D2Refusal, planD2, planHashOf } from "./d2-repair";
import { runD2Apply, runD2Plan } from "./d2-runner";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../../scripts/lib/test-tenants.cjs");

const RUN = randomUUID().slice(0, 8);
let seq = 0;
const CUT = new Date("2026-09-24T00:00:00.000Z");
const at = (iso: string) => new Date(iso);
const n = (v: Prisma.Decimal | number | string | null | undefined) =>
  v == null ? null : Number(v);

describeDb("B562 D2 average repair — real Postgres (row 635, SA-902)", () => {
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  let inventory: InventoryService;
  const tenants: string[] = [];

  beforeAll(async () => {
    requireLocalDatabaseUrl();
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();
    const mod = await Test.createTestingModule({
      providers: [
        InventoryService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: StockAlertService,
          useValue: { fireForProducts: jest.fn().mockResolvedValue({ notified: 0 }) },
        },
      ],
    }).compile();
    inventory = mod.get(InventoryService);
  });

  afterAll(async () => {
    for (const tenantId of tenants) {
      const where = { where: { tenantId } };
      // eslint-disable-next-line no-await-in-loop
      await prisma.auditLog.deleteMany(where).catch(() => undefined);
      await prisma.stockLot.deleteMany(where).catch(() => undefined);
      await prisma.stockMovement.deleteMany(where).catch(() => undefined);
      await prisma.orderRevision.deleteMany(where).catch(() => undefined);
      await prisma.orderItem.deleteMany(where).catch(() => undefined);
      await prisma.order.deleteMany(where).catch(() => undefined);
      await prisma.product.deleteMany(where).catch(() => undefined);
      await prisma.customer.deleteMany(where).catch(() => undefined);
      await prisma.user.deleteMany(where).catch(() => undefined);
      await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
    }
    await prisma?.$disconnect();
  });

  interface World {
    tenantId: string;
    productId: string;
    customerId: string;
    userId: string;
  }

  /** A raw ledger row (the legacy and D1 rows are inserted as they stand in production). */
  const movement = (
    w: World,
    type: MovementType,
    quantity: number,
    effectiveAt: Date,
    extra: { unitCost?: number; reference?: string; createdAt?: Date } = {},
  ) =>
    prisma.stockMovement.create({
      data: {
        tenantId: w.tenantId,
        productId: w.productId,
        type,
        quantity,
        unitCost: extra.unitCost ?? null,
        reference: extra.reference ?? null,
        effectiveAt,
        createdAt: extra.createdAt ?? effectiveAt,
      },
    });

  /** A legacy order (no SALE row) of `qty` pieces, created at `createdAt`. */
  async function legacyOrder(
    w: World,
    qty: number,
    createdAt: Date,
    opts: { revisionOnly?: boolean; updatedAt?: Date } = {},
  ) {
    const o = await prisma.order.create({
      data: {
        tenantId: w.tenantId,
        customerId: w.customerId,
        status: "DELIVERED",
        createdAt,
        updatedAt: opts.updatedAt ?? createdAt,
      } as any,
    });
    if (opts.revisionOnly) {
      // The product was dropped by a later edit; only a revision snapshot shows it held `qty` at create time.
      await prisma.orderRevision.create({
        data: {
          tenantId: w.tenantId,
          orderId: o.id,
          revisionNumber: 1,
          createdAt,
          snapshot: {
            lineItems: [
              {
                productId: w.productId,
                qty,
                boxes: null,
                pieces: qty,
                unitsPerBox: 1,
                status: "PENDING",
              },
            ],
          },
        },
      });
      return o.id;
    }
    await prisma.orderItem.create({
      data: {
        tenantId: w.tenantId,
        orderId: o.id,
        productId: w.productId,
        qty,
        unitPrice: 5,
        pieces: qty,
        unitsPerBox: 1,
      } as any,
    });
    return o.id;
  }

  /**
   * The headline world: 10 @ $1 (09-01), a legacy sale of `sold` (09-05), 10 @ $3 (09-10); the D1 anchor −`anchorQty` at
   * the cutover, entered 10-20. The counter and the average are what production holds after D1: 20 − anchorQty, 2.0.
   */
  async function seed(
    label: string,
    opts: { sold?: number; anchorQty?: number; costingMethod?: "AVCO" | "FIFO" | "LIFO" } = {},
  ): Promise<World> {
    seq += 1;
    const slug = assertTestTenant(`qa-b562-d2-${RUN}-${seq}-${label}`, "d2-repair.db.spec.ts");
    const tenant = await prisma.tenant.create({ data: { slug, name: `D2 ${slug}` } });
    tenants.push(tenant.id);
    const user = await prisma.user.create({
      data: {
        email: `${slug}@example.invalid`,
        username: slug,
        role: "CUSTOMER",
        tenantId: tenant.id,
      },
    });
    const customer = await prisma.customer.create({
      data: {
        userId: user.id,
        businessName: `D2 ${label}`,
        contactName: "QA",
        tenantId: tenant.id,
      },
    });
    const sold = opts.sold ?? 8;
    const anchorQty = opts.anchorQty ?? sold;
    const product = await prisma.product.create({
      data: {
        name: `Widget ${slug}`,
        unit: "ea",
        pricePerUnit: 5,
        currentStock: 20 - anchorQty,
        averageCost: 2,
        costingMethod: opts.costingMethod ?? "AVCO",
        tenantId: tenant.id,
      },
    });
    const w: World = {
      tenantId: tenant.id,
      productId: product.id,
      customerId: customer.id,
      userId: user.id,
    };
    await movement(w, MovementType.PURCHASE, 10, at("2026-09-01T00:00:00.000Z"), { unitCost: 1 });
    await legacyOrder(w, sold, at("2026-09-05T00:00:00.000Z"));
    await movement(w, MovementType.PURCHASE, 10, at("2026-09-10T00:00:00.000Z"), { unitCost: 3 });
    await movement(w, MovementType.SALE, -anchorQty, CUT, {
      reference: "B562:BACKFILL:d1hash",
      createdAt: at("2026-10-20T00:00:00.000Z"),
    });
    return w;
  }

  const plan = (w: World, productIds?: string[]) =>
    tenantCtx.run(w.tenantId, () =>
      planD2(prisma.forTenant(), { tenantId: w.tenantId, productIds }),
    );
  const product = (w: World) => prisma.product.findUniqueOrThrow({ where: { id: w.productId } });
  const rowsOf = (w: World) =>
    prisma.stockMovement.findMany({
      where: { productId: w.productId },
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
    });

  it("D2-1 (headline): plan 2.6667 EXACT; the runner's apply anchors the input at the cutover, PR-3 corrects now, one audit row", async () => {
    const w = await seed("d21");
    const p = await runD2Plan({ tenantId: w.tenantId });
    expect(p.skipped).toEqual([]);
    expect(p.entries).toHaveLength(1);
    expect(p.entries[0]).toMatchObject({
      xC: "2.6667",
      xNow: "2.6667",
      confidence: "EXACT",
      residual: "0",
    });
    const applied = await runD2Apply({
      tenantId: w.tenantId,
      planHash: p.planHash,
      productIds: [w.productId],
    });
    expect(applied).toHaveLength(1);
    expect(n((await product(w)).averageCost)).toBe(2.6667);
    const rows = await rowsOf(w);
    const repair = rows.find((r) => r.reference === `B562:REPAIR:${p.planHash}`)!;
    expect(repair).toMatchObject({ type: "COST_BASIS", effectiveAt: CUT });
    expect(n(repair.quantity)).toBe(0);
    expect(n(repair.unitCost)).toBe(2.6667);
    expect(n(repair.avgCostAfter)).toBe(2.6667);
    expect(n(repair.stockAfter)).toBe(12);
    const correction = rows.find((r) => r.reference === `RECOMPUTE:REPAIR:${p.planHash}`)!;
    expect(correction.effectiveAt.getTime()).toBeGreaterThan(Date.now() - 120_000); // dated now (SA-134)
    expect(n(correction.unitCost)).toBe(2.6667);
    const audits = await prisma.auditLog.findMany({
      where: { tenantId: w.tenantId, action: "INVENTORY_B562_D2_REPAIR_APPLY" },
    });
    expect(audits).toHaveLength(1);
    expect((audits[0].meta as any).repairs[0]).toMatchObject({
      productId: w.productId,
      xC: "2.6667",
    });
  }, 120_000);

  /** recordPurchase backdated to 10-01 (after the cutover, before the repair ran): 10 @ $5. */
  const lateBill = (w: World) =>
    tenantCtx.run(w.tenantId, () =>
      inventory.recordPurchase(
        {
          productId: w.productId,
          quantity: 10,
          unitCost: 5,
          effectiveDate: "2026-10-01T00:00:00.000Z",
        } as any,
        w.userId,
      ),
    );

  it("R-D2a (MUST 2): a bill dated after the cutover but entered after the repair keeps its cost", async () => {
    const w = await seed("d2a");
    const p = await plan(w);
    await tenantCtx.run(w.tenantId, () =>
      prisma.tenantTransaction((tx) =>
        applyD2InTx(tx, {
          tenantId: w.tenantId,
          planHash: planHashOf(p.entries),
          productIds: [w.productId],
          recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
        }),
      ),
    );
    await lateBill(w);
    // (12 × 2.6667 + 10 × 5) / 22 = 3.7273
    expect(n((await product(w)).averageCost)).toBe(3.7273);
  }, 120_000);

  it("R-D2a observe: the plan's ORIGINAL shape (a pin dated now) erases that bill's cost", async () => {
    const w = await seed("d2a-obs");
    // What D2-7 first proposed: a COST_BASIS input at X_now, dated NOW.
    await movement(w, MovementType.COST_BASIS, 0, new Date(), {
      unitCost: 2.6667,
      reference: "B562:REPAIR:pin-at-now",
    });
    await prisma.product.update({ where: { id: w.productId }, data: { averageCost: 2.6667 } });
    await lateBill(w);
    // The bill folds BEFORE the pin, so the replay pins the average back to 2.6667: the $5 is gone.
    expect(n((await product(w)).averageCost)).toBe(2.6667);
  }, 120_000);

  it("R-D2b: the apply's assert throws and rolls back every write when D2 and the replay disagree", async () => {
    const w = await seed("d2b");
    const p = await plan(w);
    const before = await rowsOf(w);
    const err = await tenantCtx
      .run(w.tenantId, () =>
        prisma.tenantTransaction((tx) =>
          applyD2InTx(tx, {
            tenantId: w.tenantId,
            planHash: planHashOf(p.entries),
            productIds: [w.productId],
            recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
            expectXNow: () => "9.9999",
          }),
        ),
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(D2Refusal);
    expect(await rowsOf(w)).toHaveLength(before.length);
    expect(n((await product(w)).averageCost)).toBe(2);
    expect(
      await prisma.auditLog.count({
        where: { tenantId: w.tenantId, action: "INVENTORY_B562_D2_REPAIR_APPLY" },
      }),
    ).toBe(0);
  }, 120_000);

  it("R-D2c: a residual (D1 −9, interposed −8) is APPROX with the residual named, and still repairs to the fold's figure", async () => {
    const w = await seed("d2c", { sold: 8, anchorQty: 9 });
    const p = await plan(w);
    expect(p.entries[0]).toMatchObject({ confidence: "APPROX", residual: "-1" });
    expect(p.entries[0].reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/residual/)]),
    );
    await tenantCtx.run(w.tenantId, () =>
      prisma.tenantTransaction((tx) =>
        applyD2InTx(tx, {
          tenantId: w.tenantId,
          planHash: planHashOf(p.entries),
          productIds: [w.productId],
          recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
        }),
      ),
    );
    expect(n((await product(w)).averageCost)).toBe(Number(p.entries[0].xNow));
    expect(n((await product(w)).currentStock)).toBe(11); // the counter never moves
  }, 120_000);

  it("R-D2d: a re-run is idempotent — the product is 'already repaired' and the old hash is refused; no second row", async () => {
    const w = await seed("d2d");
    const p = await plan(w);
    const apply = (hash: string) =>
      tenantCtx.run(w.tenantId, () =>
        prisma.tenantTransaction((tx) =>
          applyD2InTx(tx, {
            tenantId: w.tenantId,
            planHash: hash,
            productIds: [w.productId],
            recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
          }),
        ),
      );
    await apply(planHashOf(p.entries));
    const again = await plan(w);
    expect(again.entries).toEqual([]);
    expect(again.skipped).toEqual([{ productId: w.productId, reason: "ALREADY_REPAIRED" }]);
    expect(await apply(planHashOf(p.entries)).catch((e) => e)).toBeInstanceOf(D2Refusal);
    expect((await rowsOf(w)).filter((r) => r.reference?.startsWith("B562:REPAIR:"))).toHaveLength(
      1,
    );
  }, 120_000);

  it("Opus #3696 MUST 1: a stored FIFO product is costed at the average (SA-804), so it is repaired: 2.0 → 2.6667 (head: skipped NOT_AVCO)", async () => {
    const w = await seed("fifo", { costingMethod: "FIFO" });
    const p = await plan(w);
    expect(p.skipped).toEqual([]);
    expect(p.entries[0]).toMatchObject({ xC: "2.6667", xNow: "2.6667" });
  }, 120_000);

  it("SA-911: a pre-cutover draft promoted AFTER the cutover (its ORDER:<id> PROMOTE row) is not interposed; residual 0", async () => {
    const w = await seed("promoted");
    // A draft created 09-08 for 5, promoted 09-26 by PR-2's code: the ledger holds its PROMOTE SALE row; the counter moved.
    const draft = await prisma.order.create({
      data: {
        tenantId: w.tenantId,
        customerId: w.customerId,
        status: "PENDING",
        createdAt: at("2026-09-08T00:00:00.000Z"),
        updatedAt: at("2026-09-26T00:00:00.000Z"),
      } as any,
    });
    await prisma.orderItem.create({
      data: {
        tenantId: w.tenantId,
        orderId: draft.id,
        productId: w.productId,
        qty: 5,
        unitPrice: 5,
        pieces: 5,
        unitsPerBox: 1,
      } as any,
    });
    await prisma.stockMovement.create({
      data: {
        tenantId: w.tenantId,
        productId: w.productId,
        type: MovementType.SALE,
        quantity: -5,
        reference: `ORDER:${draft.id}`,
        notes: "PROMOTE",
        effectiveAt: at("2026-09-26T00:00:00.000Z"),
        createdAt: at("2026-09-26T00:00:00.000Z"),
      },
    });
    await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 7 } });
    const p = await plan(w);
    expect(p.entries[0]).toMatchObject({ legacyOrders: 2, residual: "0", xC: "2.6667" });
  }, 120_000);

  describe("guards", () => {
    it("D2-8: drift ≠ 0 is excluded (D1 first)", async () => {
      const w = await seed("drift");
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 13 } });
      const p = await plan(w);
      expect(p.entries).toEqual([]);
      expect(p.skipped).toEqual([{ productId: w.productId, reason: "DRIFT", detail: "1" }]);
    }, 120_000);

    it("a product that changed since the dry run refuses the whole apply and writes nothing", async () => {
      const w = await seed("changed");
      const p = await plan(w);
      await movement(w, MovementType.PURCHASE, 1, at("2026-10-05T00:00:00.000Z"), { unitCost: 4 });
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 13 } });
      const err = await tenantCtx
        .run(w.tenantId, () =>
          prisma.tenantTransaction((tx) =>
            applyD2InTx(tx, {
              tenantId: w.tenantId,
              planHash: planHashOf(p.entries),
              productIds: [w.productId],
              recompute: (t, id, o) => inventory.recomputeProductInTx(t, id, o),
            }),
          ),
        )
        .catch((e) => e);
      expect(err).toBeInstanceOf(D2Refusal);
      expect((await rowsOf(w)).filter((r) => r.reference?.startsWith("B562:REPAIR:"))).toHaveLength(
        0,
      );
    }, 120_000);

    it("a requested product with no D1 anchor is listed, not repaired", async () => {
      const w = await seed("noanchor");
      await prisma.stockMovement.deleteMany({
        where: { productId: w.productId, reference: { startsWith: "B562:BACKFILL:" } },
      });
      await prisma.product.update({ where: { id: w.productId }, data: { currentStock: 20 } });
      const p = await plan(w, [w.productId]);
      expect(p.skipped).toEqual([{ productId: w.productId, reason: "NO_ANCHOR" }]);
    }, 120_000);

    it("a legacy order whose current lines dropped the product is found through its revision snapshot (the jsonb lookup)", async () => {
      // The usual legacy sale of 8, plus an order created 09-05 holding 8 that a 09-20 edit dropped (its pieces came back):
      // it nets 0, so the residual stays 0, but its stock was out from 09-05 to 09-20 — across the 10 @ $3 bill (APPROX).
      const w = await seed("revonly");
      await legacyOrder(w, 8, at("2026-09-05T00:00:00.000Z"), {
        revisionOnly: true,
        updatedAt: at("2026-09-20T00:00:00.000Z"),
      });
      const p = await plan(w);
      expect(p.entries[0]).toMatchObject({ legacyOrders: 2, residual: "0", confidence: "APPROX" });
      expect(p.entries[0].reasons).toEqual(
        expect.arrayContaining([expect.stringMatching(/costful row .* FINAL window/)]),
      );
    }, 120_000);
  });
});
