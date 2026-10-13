import { BadRequestException } from "@nestjs/common";
import type { LadderUnit } from "@routeflow/pricing";
import { resolveLineUnits } from "../products/line-units";
import { createUnitLine, updateUnitLine, type UnitWriteContext } from "./unit-line-edit";

/**
 * H3 (coordinator ruling): re-sending a unit line whose price equals the price ALREADY STORED on that same
 * line is not a new override. It keeps the stored priceType, original price, reason and stamp, and needs no
 * reason, so an unchanged, already-overridden line is never 400'd (or re-stamped) by an edit that re-writes it.
 * Only a CHANGED price, or a new or substitute line, is judged against the customer's tier price.
 * Fixture: tier-3 customer, Case list $24 / tier $20, x3; the stored line is MANUAL $24 "agreed at list" by u-old.
 */
const product = { id: "p1", name: "Widget", unit: "Box", unitsPerBox: 24, pricePerUnit: "10.00" };
const units: LadderUnit[] = [
  {
    label: "Case",
    factorToBase: 288,
    price: "24.00",
    priceTier2: null,
    priceTier3: "20.00",
    priceTier4: null,
    priceTier5: null,
  },
  {
    label: "Pallet",
    factorToBase: 5760,
    price: "400.00",
    priceTier2: null,
    priceTier3: "380.00",
    priceTier4: null,
    priceTier5: null,
  },
];
const resolved = (label = "Case") => resolveLineUnits(product, units, { unitLabel: label });

const storedOverride = {
  id: "L1",
  productId: "p1",
  unitLabel: "Case",
  unitPrice: "24.00",
  priceType: "MANUAL",
  originalPrice: "24.00",
  overrideReason: "agreed at list",
  overriddenBy: "u-old",
};
const storedSpecial = {
  ...storedOverride,
  unitPrice: "20.00",
  priceType: "SPECIAL",
  originalPrice: "24.00",
  overrideReason: null,
  overriddenBy: null,
};

function makeCtx(held: Array<Record<string, unknown>> = [storedOverride]) {
  const ctx = {
    tx: { orderItem: { create: jest.fn(), update: jest.fn() } },
    orderId: "ord-1",
    ladders: new Map([["p1", units]]),
    tenantId: "t1",
    tier: () => 3,
    overriddenBy: "u-now",
    held: new Map(held.map((h) => [h.id as string, h])),
    categoryMap: new Map(),
  };
  return ctx as unknown as UnitWriteContext & typeof ctx;
}
const item = (over: Record<string, unknown>) => ({
  productId: "p1",
  qty: 3,
  unitLabel: "Case",
  ...over,
});
const created = (ctx: ReturnType<typeof makeCtx>) => ctx.tx.orderItem.create.mock.calls[0][0].data;
const updated = (ctx: ReturnType<typeof makeCtx>) => ctx.tx.orderItem.update.mock.calls[0][0].data;

describe("replace-all createUnitLine — a paired stored line (sourceLineId, same product and unit)", () => {
  it("re-sending the stored override price with NO reason succeeds and keeps price, type, reason and stamp", async () => {
    const ctx = makeCtx();
    await createUnitLine(
      ctx,
      "ord-1",
      product,
      resolved(),
      item({ sourceLineId: "L1", unitPrice: 24 }),
      0,
    );
    expect(created(ctx)).toMatchObject({
      unitPrice: 24,
      subtotal: 72,
      priceType: "MANUAL",
      originalPrice: 24,
      overrideReason: "agreed at list",
      overriddenBy: "u-old", // the stored stamp, not the editor
    });
  });

  it("re-sending a stored SPECIAL price keeps it SPECIAL with no stamp", async () => {
    const ctx = makeCtx([storedSpecial]);
    await createUnitLine(
      ctx,
      "ord-1",
      product,
      resolved(),
      item({ sourceLineId: "L1", unitPrice: 20 }),
      0,
    );
    expect(created(ctx)).toMatchObject({ unitPrice: 20, priceType: "SPECIAL", subtotal: 60 });
    expect(created(ctx)).not.toHaveProperty("overriddenBy");
  });

  it("a CHANGED price is re-decided against the tier price: with no reason sent it 400s, even with one on file", async () => {
    const ctx = makeCtx();
    await expect(
      createUnitLine(
        ctx,
        "ord-1",
        product,
        resolved(),
        item({ sourceLineId: "L1", unitPrice: 18 }),
        0,
      ),
    ).rejects.toThrow(/reason is required/);
    await createUnitLine(
      ctx,
      "ord-1",
      product,
      resolved(),
      item({ sourceLineId: "L1", unitPrice: 18, overrideReason: "damaged" }),
      0,
    );
    expect(created(ctx)).toMatchObject({
      unitPrice: 18,
      priceType: "DISCOUNTED",
      overrideReason: "damaged",
      overriddenBy: "u-now",
    });
  });

  it("a CHANGED price on a stored SPECIAL line with no reason 400s", async () => {
    const ctx = makeCtx([storedSpecial]);
    await expect(
      createUnitLine(
        ctx,
        "ord-1",
        product,
        resolved(),
        item({ sourceLineId: "L1", unitPrice: 24 }),
        0,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ctx.tx.orderItem.create).not.toHaveBeenCalled();
  });

  it("a NEW line (no pairing) typed at the list price with no reason 400s", async () => {
    const ctx = makeCtx();
    await expect(
      createUnitLine(ctx, "ord-1", product, resolved(), item({ unitPrice: 24 }), 0),
    ).rejects.toThrow(/reason is required/);
  });

  it("a pairing to a line of another product, or sold in another unit, is not the same line", async () => {
    const other = makeCtx([{ ...storedOverride, productId: "p2" }]);
    await expect(
      createUnitLine(
        other,
        "ord-1",
        product,
        resolved(),
        item({ sourceLineId: "L1", unitPrice: 24 }),
        0,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    const pallet = makeCtx(); // the stored line is a Case; this one is a Pallet at the same typed price
    await expect(
      createUnitLine(
        pallet,
        "ord-1",
        product,
        resolved("Pallet"),
        item({ sourceLineId: "L1", unitLabel: "Pallet", unitPrice: 24 }),
        0,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("per-line updateUnitLine — the stored line by id", () => {
  it("re-sending the stored override price with NO reason succeeds and writes the stored type, reason and stamp", async () => {
    const ctx = makeCtx();
    await updateUnitLine(ctx, "L1", product, resolved(), item({ id: "L1", unitPrice: 24 }), false);
    expect(updated(ctx)).toMatchObject({
      unitPrice: 24,
      subtotal: 72,
      priceType: "MANUAL",
      overrideReason: "agreed at list",
      overriddenBy: "u-old",
    });
  });

  it("a SUBSTITUTE is a new sale: the same typed price is judged against the tier price and 400s", async () => {
    const ctx = makeCtx();
    await expect(
      updateUnitLine(
        ctx,
        "L1",
        product,
        resolved(),
        { id: "L1", substituteProductId: "p1", qty: 3, unitLabel: "Case", unitPrice: 24 },
        true,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("a line unchanged in price and edited only in qty still reprices from the ladder (no price sent)", async () => {
    const ctx = makeCtx();
    await updateUnitLine(ctx, "L1", product, resolved(), item({ id: "L1", qty: 5 }), false);
    expect(updated(ctx)).toMatchObject({ unitPrice: 20, priceType: "SPECIAL", subtotal: 100 });
  });
});
