/**
 * units_v1 — DB lane: the unit ladder against a REAL Postgres, the proof required before any tenant is
 * granted `flag.units_v1` (lead ruling on #1101). The unit specs run on mocks; this file exercises what
 * they cannot: Prisma `Decimal` ladder rows through `resolveUnitPrice`, the tenant-scoped ladder read,
 * the exact OrderItem column fit (qty Decimal(10,3), subtotal Decimal(10,2)), the stock decrement in
 * BASE pieces under the real `FOR UPDATE` statement, and the boxes/pieces rollover.
 *
 *  L1 the ladder read through forTenant() returns real Decimal rows, prices a Case line, and is
 *     invisible to another tenant
 *  L2 a Case line is priced by the ladder AND stocked in base pieces (qty x factor) — the same number
 *     the OrderItem stores and the stock statement decrements
 *  L3 a Pallet line derives its price from the pack and oversells for staff (stock goes negative, warn)
 *  L4 the maximum line the builder accepts fits the real columns, and one unit more overflows them
 *  L5 pack boxes/pieces rollover: 1 box + 30 loose pieces of a 24-box is 2 boxes + 6 pieces = 54 base
 *     pieces, priced at 2.25 boxes, persisted and read back
 *  L6 tiers through real Decimal rows: an explicit tier price wins, a level with only a base price scales
 *     by the pack's tier ratio, a derived level uses the pack's tier price, and a typed price is
 *     DISCOUNTED below / MANUAL above the ladder
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. Test tenant
 * only (`qa-*`, enforced by assertTestTenant).
 */
import { randomUUID } from "crypto";
import { Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import { computeLineSubtotal, normalizeBoxesPieces, type LadderUnit } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { PrismaService } from "../prisma/prisma.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { resolveLineUnits } from "../products/line-units";
import { decrementStockForSale, type StockLineUnits } from "./order-stock";
import {
  MAX_LINE_QTY,
  MAX_LINE_SUBTOTAL,
  buildUnitLine,
  categoryTaxForLine,
} from "./unit-line-build";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

/**
 * TODO(2026-09-20, #1090): replace this inline read with `loadUnitLadders` from `unit-line-build.ts`
 * when #1090 is on master. Until then L1 proves the query shape and its tenant scoping, NOT the
 * helper itself.
 *
 * VERBATIM copy of `loadUnitLadders` on #1090's branch (feat/u-orders-create-unit-wire2) — same
 * `where`, same `orderBy sortOrder asc`, same grouping and empty-ids guard. Keep it identical: a
 * stand-in that drifts proves a different query than production runs.
 */
async function loadUnitLadders(
  db: { productUnit: { findMany(args: any): Promise<any[]> } },
  productIds: ReadonlyArray<string>,
): Promise<Map<string, LadderUnit[]>> {
  const ids = [...new Set(productIds.filter(Boolean))];
  const out = new Map<string, LadderUnit[]>();
  if (ids.length === 0) return out;
  const rows = await db.productUnit.findMany({
    where: { productId: { in: ids } },
    orderBy: { sortOrder: "asc" },
  });
  for (const r of rows) {
    const list = out.get(r.productId) ?? [];
    list.push(r as LadderUnit);
    out.set(r.productId, list);
  }
  return out;
}

describeDb("units_v1 ladder — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient; // superuser fixture client — deliberately unscoped
  let prisma: PrismaService;
  let tenantCtx: TenantContextService;
  const run = randomUUID().slice(0, 8);
  const slugA = assertTestTenant(`qa-ladder-${run}-a`, "unit-ladder.db.spec.ts");
  const slugB = assertTestTenant(`qa-ladder-${run}-b`, "unit-ladder.db.spec.ts");
  let tenantA = "";
  let tenantB = "";
  let userId = "";
  let customerId = "";
  let orderId = "";
  let productId = "";

  // B297/SA-088 (#938 fix): this fixture's product carries no trackedCategoryId, so a NULL
  // category — never a bare 0 — is the correct "no regulated tax" shape. Reuses the real
  // production helper `categoryTaxForLine` (the ONE place taxFor's {amount, snapshot} shape
  // is produced) instead of hand-rolling an equivalent that can drift from the real contract
  // the way the old `() => 0` did: buildUnitLine destructures `taxFor(...).snapshot.categoryTaxType`,
  // and a bare number crashes with "Cannot read properties of undefined (reading 'categoryTaxType')".
  const taxNone = (qty: number, subtotal: number) => categoryTaxForLine(null, qty, subtotal);
  const stockOf = async () =>
    Number((await raw.product.findUniqueOrThrow({ where: { id: productId } })).currentStock);
  const ladderOf = (tenantId: string) =>
    tenantCtx.run(tenantId, () => loadUnitLadders(prisma.forTenant(), [productId]));

  /**
   * The real stock statement (FOR UPDATE + aggregated UPDATE) inside a tenant-scoped transaction.
   * B703 (SA-136b): it is handed the line's unit fields, as create() does — a unit line's `qty` is
   * already base pieces, which only its `unitLabel` tells the piece converter.
   */
  const stock = (line: StockLineUnits & { qty: unknown }) =>
    tenantCtx.run(tenantA, () =>
      prisma.tenantTransaction(async (tx: any) => {
        await decrementStockForSale(
          { logger: new Logger("unit-ladder.db.spec"), tenantId: tenantA },
          tx,
          [{ ...line, productId, qty: Number(line.qty) }],
          true,
          // B562 PR-2: the SALE movement's reference/event (this spec has no acting user).
          { orderId: orderId || "unit-ladder-spec", notes: "CREATE", performedById: null },
        );
      }),
    );

  /** Build a Case/Pallet line from the REAL ladder rows and the REAL product row. */
  async function unitLine(
    label: string,
    qty: number,
    extra: Record<string, unknown> = {},
    tier: 1 | 2 | 3 | 4 | 5 = 1,
  ) {
    const row = await raw.product.findUniqueOrThrow({ where: { id: productId } });
    // the product's Decimals are coerced to strings at the boundary (what the production builder does
    // with them); the LADDER rows below stay real Prisma Decimals
    const product = {
      ...row,
      pricePerUnit: String(row.pricePerUnit),
      priceTier2: String(row.priceTier2),
      priceTier3: String(row.priceTier3),
      priceTier4: String(row.priceTier4),
      priceTier5: String(row.priceTier5),
    };
    const ladder = (await ladderOf(tenantA)).get(productId) ?? [];
    return buildUnitLine({
      product,
      units: ladder,
      resolved: resolveLineUnits(product, ladder, { unitLabel: label }),
      item: { productId, qty, unitLabel: label, ...extra },
      tier,
      taxFor: taxNone,
      position: 0,
      tenantId: tenantA,
    });
  }

  /** Persist a built line as a real OrderItem (the columns create() writes) and read it back. */
  async function persist(line: Record<string, any>) {
    const row = await raw.orderItem.create({
      data: { ...line, orderId, productId, tenantId: tenantA } as never,
    });
    return raw.orderItem.findUniqueOrThrow({ where: { id: row.id } });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantCtx = new TenantContextService();
    prisma = new PrismaService(tenantCtx);
    await prisma.$connect();

    tenantA = (await raw.tenant.create({ data: { slug: slugA, name: `Ladder ${slugA}` } })).id;
    tenantB = (await raw.tenant.create({ data: { slug: slugB, name: `Ladder ${slugB}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `ladder-${run}@example.test`,
          username: `ladder-${run}`,
          role: "CUSTOMER",
          tenantId: tenantA,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "Ladder co", contactName: "Tester", tenantId: tenantA },
      })
    ).id;
    orderId = (await raw.order.create({ data: { customerId, tenantId: tenantA, total: "0.00" } }))
      .id;
    // A 24-piece Box at $42.00; Case = 288 pieces with an explicit $480.00; Pallet = 5760, derived.
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "Box",
          pricePerUnit: "42.00",
          unitsPerBox: 24,
          priceTier2: "21.00",
          priceTier3: "40.00",
          currentStock: "10000",
          tenantId: tenantA,
        },
      })
    ).id;
    await raw.productUnit.createMany({
      data: [
        {
          tenantId: tenantA,
          productId,
          label: "Case",
          factorToBase: 288,
          price: "480.00",
          priceTier3: "450.00",
        },
        { tenantId: tenantA, productId, label: "Pallet", factorToBase: 5760, sortOrder: 1 },
      ],
    });
  }, 120_000);

  afterAll(async () => {
    await raw.orderItem.deleteMany({ where: { orderId } });
    await raw.order.deleteMany({ where: { id: orderId } });
    await raw.productUnit.deleteMany({ where: { productId } });
    await raw.stockMovement.deleteMany({ where: { productId } }); // B562 PR-2: the SALE rows
    await raw.product.deleteMany({ where: { id: productId } });
    await raw.customer.deleteMany({ where: { id: customerId } });
    await raw.user.deleteMany({ where: { id: userId } });
    await raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB].filter(Boolean) } } });
    await prisma?.$disconnect();
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("L1: the ladder is read through forTenant() as real Decimal rows, prices a Case line, and is invisible to another tenant", async () => {
    const ladder = (await ladderOf(tenantA)).get(productId) ?? [];
    expect(ladder.map((u) => [u.label, u.factorToBase])).toEqual([
      ["Case", 288],
      ["Pallet", 5760],
    ]);
    // a Prisma Decimal, not a number (and not null): the price math must coerce it; the derived
    // Pallet level carries NO price of its own
    expect(ladder[0].price).toBeInstanceOf(Prisma.Decimal);
    expect(ladder[1].price).toBeNull();
    const line = await unitLine("Case", 3);
    expect(line).toMatchObject({ unitPrice: 480, subtotal: 1440, qty: 864, unitsPerBox: 288 });
    // tenant B sees none of tenant A's levels (the tenant extension scopes the read)
    expect((await ladderOf(tenantB)).get(productId)).toBeUndefined();
  });

  it("L2: a Case line is priced by the ladder AND stocked in base pieces — one number in the OrderItem and the stock statement", async () => {
    const before = await stockOf();
    const line = await unitLine("Case", 3);
    const row = await persist(line);
    expect(Number(row.qty)).toBe(864); // Decimal(10,3) round-trip
    expect(row).toMatchObject({ unitLabel: "Case", boxes: 3, pieces: 0, unitsPerBox: 288 });
    expect(Number(row.unitPrice)).toBe(480);
    expect(Number(row.subtotal)).toBe(1440);
    await stock(row);
    expect(await stockOf()).toBe(before - 864);
  });

  it("L3: a Pallet line derives its price from the pack (42 x 5760 / 24) and oversells for staff, taking stock negative", async () => {
    const line = await unitLine("Pallet", 2);
    expect(line).toMatchObject({ unitPrice: 10080, subtotal: 20160, qty: 11520 });
    const before = await stockOf();
    await stock(line);
    expect(await stockOf()).toBe(before - 11520);
    expect(await stockOf()).toBeLessThan(0);
  });

  it("L4: the largest line the builder accepts fits the real columns exactly", async () => {
    const row = await persist({
      ...(await unitLine("Case", 1)),
      qty: MAX_LINE_QTY,
      subtotal: MAX_LINE_SUBTOTAL,
    });
    expect(Number(row.qty)).toBe(MAX_LINE_QTY);
    expect(Number(row.subtotal)).toBe(MAX_LINE_SUBTOTAL);
    // the other half of the claim: the guard sits at the column edge, so one unit more must not fit
    // (Decimal(10,3) qty, Decimal(10,2) subtotal) — otherwise the constants guard nothing
    await expect(
      persist({ ...(await unitLine("Case", 1)), qty: MAX_LINE_QTY + 1 }),
    ).rejects.toThrow();
    await expect(
      persist({ ...(await unitLine("Case", 1)), subtotal: MAX_LINE_SUBTOTAL + 0.01 }),
    ).rejects.toThrow();
  });

  it("L5: pack rollover — 1 box + 30 loose pieces of a 24-box is 2 boxes + 6 pieces (54 base pieces), priced at 2.25 boxes, persisted", async () => {
    const split = normalizeBoxesPieces({ boxes: 1, pieces: 30, unitsPerBox: 24 });
    expect(split).toEqual({ boxes: 2, pieces: 6, qty: 54 });
    const subtotal = computeLineSubtotal({
      unitPrice: 42,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: 24,
    });
    expect(subtotal).toBe(94.5);
    const row = await persist({
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: 24,
      unitPrice: 42,
      subtotal,
    });
    expect(Number(row.qty)).toBe(54);
    expect(row).toMatchObject({ boxes: 2, pieces: 6, unitsPerBox: 24, unitLabel: null });
    expect(Number(row.subtotal)).toBe(94.5);
  });

  it("L6: tiers through real Decimal rows — explicit tier wins, a base-only level scales by the pack ratio, a derived level uses the pack tier price, a typed price is DISCOUNTED/MANUAL", async () => {
    // tier 3: the Case has its own $450 → wins (SPECIAL, list $480 kept as originalPrice)
    expect(await unitLine("Case", 3, {}, 3)).toMatchObject({
      unitPrice: 450,
      subtotal: 1350,
      priceType: "SPECIAL",
      originalPrice: 480,
    });
    // tier 2: no explicit tier-2 Case price → base 480 x (pack tier-2 $21 / pack $42) = 240
    expect(await unitLine("Case", 3, {}, 2)).toMatchObject({ unitPrice: 240, subtotal: 720 });
    // tier 3: the derived Pallet has no price of its own → pack tier-3 $40 x 5760 / 24 = 9600
    expect(await unitLine("Pallet", 1, {}, 3)).toMatchObject({ unitPrice: 9600, subtotal: 9600 });
    // a typed price below list is DISCOUNTED (list kept), above list is a MANUAL upsell
    expect(await unitLine("Case", 3, { unitPrice: 400 })).toMatchObject({
      unitPrice: 400,
      subtotal: 1200,
      priceType: "DISCOUNTED",
      originalPrice: 480,
    });
    expect(await unitLine("Case", 3, { unitPrice: 500 })).toMatchObject({
      unitPrice: 500,
      subtotal: 1500,
      priceType: "MANUAL",
      originalPrice: 480,
    });
  });
});
