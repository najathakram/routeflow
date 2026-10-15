import type { LadderUnit } from "@routeflow/pricing";
import { resolveLineUnits } from "../products/line-units";
import { createUnitLine, type UnitWriteContext } from "./unit-line-edit";

/**
 * Units P0b x H3 (train S3 review): a replace-all entry re-writes a line whose unit the ladder no longer names from the
 * HELD line's own snapshot, but ONLY for the same product. Another product named under that line's id must not be
 * billed at the held line's price: it is the 400 UNIT_NOT_OFFERED it was before P0b. And a gone MANUAL/DISCOUNTED
 * snapshot with no typed price keeps ITS reason and user rather than stamping the acting user with no reason.
 */
const productA = { id: "pA", name: "Alpha", unit: "Box", unitsPerBox: 12, pricePerUnit: "10.00" };
const productB = { id: "pB", name: "Beta", unit: "Box", unitsPerBox: 12, pricePerUnit: "10.00" };
const carton = (price: string): LadderUnit => ({
  label: "Carton",
  factorToBase: 12,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const noLevel = [] as LadderUnit[]; // B's ladder has no Carton
// the held line: product A, sold by "Carton" (a level A's ladder lost), MANUAL $50 by u-old
const held = {
  id: "L1",
  productId: "pA",
  unitLabel: "Carton",
  unitsPerBox: 12,
  unitPrice: "50.00",
  priceType: "MANUAL",
  originalPrice: "50.00",
  overrideReason: "agreed at 50",
  overriddenBy: "u-old",
};

function ctxFor(ladders: Record<string, LadderUnit[]>) {
  const ctx = {
    tx: { orderItem: { create: jest.fn(), update: jest.fn() } },
    authorOf: Object.assign(() => "STAFF" as const, { editor: "STAFF" as const }),
    orderId: "ord-1",
    ladders: new Map(Object.entries(ladders)),
    tenantId: "t1",
    tier: () => 1,
    overriddenBy: "u-now",
    held: new Map([[held.id, held]]),
    categoryMap: new Map(),
  };
  return ctx as unknown as UnitWriteContext & typeof ctx;
}

describe("createUnitLine - the held line's snapshot belongs to its own product", () => {
  it("another product under the held line's id is UNIT_NOT_OFFERED, never billed at that line's price", async () => {
    const ctx = ctxFor({ pA: [], pB: noLevel });
    const item = { id: "L1", productId: "pB", qty: 2, unitLabel: "Carton" };
    // the caller resolves against the held line (by id) exactly like updateOrderItems does
    const resolved = resolveLineUnits(productB, noLevel, item, held);
    await expect(
      createUnitLine(ctx, "ord-1", productB as never, resolved, item, 0),
    ).rejects.toMatchObject({
      response: { code: "UNIT_NOT_OFFERED" },
    });
    expect(ctx.tx.orderItem.create).not.toHaveBeenCalled();
  });

  it("the SAME product keeps its snapshot (unit lost from the ladder): price, type and original price carry over", async () => {
    const ctx = ctxFor({ pA: [] });
    const item = { id: "L1", productId: "pA", qty: 2, unitLabel: "Carton" };
    const resolved = resolveLineUnits(productA, [], item, held);
    await createUnitLine(ctx, "ord-1", productA as never, resolved, item, 0);
    const data = ctx.tx.orderItem.create.mock.calls[0][0].data;
    expect(Number(data.unitPrice)).toBe(50);
    expect(data.priceType).toBe("MANUAL");
  });

  it("N2: a gone MANUAL snapshot with no typed price keeps ITS reason and user, not the acting user", async () => {
    const ctx = ctxFor({ pA: [] });
    const item = { id: "L1", productId: "pA", qty: 2, unitLabel: "Carton" };
    const resolved = resolveLineUnits(productA, [], item, held);
    await createUnitLine(ctx, "ord-1", productA as never, resolved, item, 0);
    const data = ctx.tx.orderItem.create.mock.calls[0][0].data;
    expect(data.overrideReason).toBe("agreed at 50");
    expect(data.overriddenBy).toBe("u-old");
  });
});
