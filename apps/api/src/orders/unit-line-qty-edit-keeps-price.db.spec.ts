/**
 * H3 — DB lane: a qty-only edit of a stored unit line keeps its stored price and decision, read back from
 * real Postgres. Tier-3 customer, Case list $24 / tier $20; the stored line is a MANUAL $24 override with a
 * reason and a stamp. `updateUnitLine` (the writer behind the per-line UPDATE) runs against the real row:
 *
 *  Q1 a qty-only edit keeps unitPrice, priceType, originalPrice, overrideReason and overriddenBy; the
 *     subtotal is the new count x the KEPT price (never the $20 tier price)
 *  Q2 an explicit price change without a reason is the 400 and the row is untouched
 *  Q3 a STANDARD (tier-priced) stored line keeps its stored price on a qty-only edit, as a pack line does
 *
 * Run via `npm run local:test:db` (compose Postgres); collected only by jest.db.config.js. Test tenant only
 * (`qa-*`, enforced by assertTestTenant).
 */
import { randomUUID } from "crypto";
import { BadRequestException } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";
import type { LadderUnit } from "@routeflow/pricing";
import { describeDb, requireLocalDatabaseUrl } from "../common/testing/db-spec";
import { resolveLineUnits } from "../products/line-units";
import { updateUnitLine, type UnitWriteContext } from "./unit-line-edit";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertTestTenant } = require("../../../../scripts/lib/test-tenants.cjs");

describeDb("H3 qty-only unit edit keeps the stored price — real Postgres", () => {
  let pool: Pool;
  let raw: PrismaClient;
  const run = randomUUID().slice(0, 8);
  const slug = assertTestTenant(`qa-h3qty-${run}`, "unit-line-qty-edit-keeps-price.db.spec.ts");
  let tenantId = "";
  let userId = "";
  let customerId = "";
  let orderId = "";
  let productId = "";

  async function seedLine(over: Record<string, unknown>) {
    return raw.orderItem.create({
      data: {
        orderId,
        productId,
        tenantId,
        qty: 864,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 288,
        unitLabel: "Case",
        unitPrice: "24.00",
        subtotal: "72.00",
        priceType: "MANUAL",
        originalPrice: "24.00",
        overrideReason: "agreed at list",
        overriddenBy: "stamp-user",
        ...over,
      } as never,
    });
  }

  /** Run the real writer against the real row, the way updateOrderItems wires it. */
  async function qtyEdit(lineId: string, item: Record<string, unknown>) {
    const row = await raw.product.findUniqueOrThrow({ where: { id: productId } });
    const product = { ...row, pricePerUnit: String(row.pricePerUnit) } as never;
    const ladder = (await raw.productUnit.findMany({
      where: { productId },
    })) as unknown as LadderUnit[];
    const held = new Map(
      (await raw.orderItem.findMany({ where: { orderId } })).map((l) => [l.id, l]),
    );
    const ctx = {
      tx: raw,
      orderId,
      ladders: new Map([[productId, ladder]]),
      tenantId,
      tier: () => 3,
      overriddenBy: userId,
      held,
      categoryMap: new Map(),
    } as unknown as UnitWriteContext;
    await updateUnitLine(
      ctx,
      lineId,
      product,
      resolveLineUnits(product, ladder, { unitLabel: "Case" }),
      { productId, unitLabel: "Case", ...item },
      false,
    );
    return raw.orderItem.findUniqueOrThrow({ where: { id: lineId } });
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: requireLocalDatabaseUrl() });
    raw = new PrismaClient({ adapter: new PrismaPg(pool) });
    tenantId = (await raw.tenant.create({ data: { slug, name: `H3 ${slug}` } })).id;
    userId = (
      await raw.user.create({
        data: {
          email: `h3q-${run}@example.test`,
          username: `h3q-${run}`,
          role: "CUSTOMER",
          tenantId,
        },
      })
    ).id;
    customerId = (
      await raw.customer.create({
        data: { userId, businessName: "H3 co", contactName: "Tester", pricingTier: 3, tenantId },
      })
    ).id;
    orderId = (await raw.order.create({ data: { customerId, tenantId, total: "0.00" } })).id;
    productId = (
      await raw.product.create({
        data: {
          name: `Widget ${run}`,
          unit: "Box",
          pricePerUnit: "1.00",
          unitsPerBox: 24,
          tenantId,
        },
      })
    ).id;
    await raw.productUnit.create({
      data: {
        tenantId,
        productId,
        label: "Case",
        factorToBase: 288,
        price: "24.00",
        priceTier3: "20.00",
      },
    });
  }, 120_000);

  afterAll(async () => {
    await raw?.orderItem.deleteMany({ where: { orderId } });
    await raw?.order.deleteMany({ where: { id: orderId } });
    await raw?.productUnit.deleteMany({ where: { productId } });
    await raw?.product.deleteMany({ where: { id: productId } });
    await raw?.customer.deleteMany({ where: { id: customerId } });
    await raw?.user.deleteMany({ where: { id: userId } });
    await raw?.tenant.deleteMany({ where: { id: tenantId } });
    await raw?.$disconnect();
    await pool?.end();
  }, 120_000);

  it("Q1: a qty-only edit keeps price, type, original, reason and stamp; subtotal = 5 x the kept $24", async () => {
    const line = await seedLine({});
    const row = await qtyEdit(line.id, { id: line.id, qty: 5 });
    expect(row).toMatchObject({
      priceType: "MANUAL",
      overrideReason: "agreed at list",
      overriddenBy: "stamp-user",
      boxes: 5,
    });
    expect(Number(row.unitPrice)).toBe(24);
    expect(Number(row.originalPrice)).toBe(24);
    expect(Number(row.subtotal)).toBe(120);
    expect(Number(row.qty)).toBe(1440);
  });

  it("Q2: an explicit price change without a reason is the 400 and the row is untouched", async () => {
    const line = await seedLine({});
    await expect(qtyEdit(line.id, { id: line.id, qty: 3, unitPrice: 22 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const row = await raw.orderItem.findUniqueOrThrow({ where: { id: line.id } });
    expect(Number(row.unitPrice)).toBe(24);
    expect(row.overrideReason).toBe("agreed at list");
  });

  it("Q3: a STANDARD stored line keeps its stored price on a qty-only edit (the tier price has moved on)", async () => {
    const line = await seedLine({
      unitPrice: "19.00",
      subtotal: "57.00",
      priceType: "STANDARD",
      originalPrice: null,
      overrideReason: null,
      overriddenBy: null,
    });
    const row = await qtyEdit(line.id, { id: line.id, qty: 2 });
    expect(Number(row.unitPrice)).toBe(19);
    expect(Number(row.subtotal)).toBe(38);
    expect(row.priceType).toBe("STANDARD");
    expect(row.overriddenBy).toBeNull();
  });
});
