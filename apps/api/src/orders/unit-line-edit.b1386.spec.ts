import { updateUnitLine, type UnitWriteContext } from "./unit-line-edit";
import { resolveLineUnits } from "../products/line-units";
import type { LadderUnit } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { BUYER_LINE_QTY_OVER_MAX_MESSAGE } from "./buyer-line-cap";

/**
 * B1386: a buyer's per-line DIFF on a unit-aware line (SA-407) skips pairEditLines and reaches updateUnitLine,
 * which caps the built PIECE total (rise-only against the held line) when the editor is a CUSTOMER
 * (`repriceTierOnQtyOnly === true`).
 */
const product = { id: "p1", unit: "Box", unitsPerBox: 24, pricePerUnit: "10.00" };
const units: LadderUnit[] = [
  {
    label: "Case",
    factorToBase: 24,
    price: "220.00",
    priceTier2: null,
    priceTier3: null,
    priceTier4: null,
    priceTier5: null,
  },
];
const resolved = resolveLineUnits(product, units, { unitLabel: "Case" });
const lookupOf = (editor: "STAFF" | "BUYER") => Object.assign(() => editor, { editor });
const held = (pieces: number) => ({
  qty: pieces,
  unitLabel: "Case",
  unitPrice: "220.00",
  priceType: "TIER",
  originalPrice: null,
});

function makeCtx(buyer: boolean | undefined, heldPieces: number) {
  const ctx: UnitWriteContext & { tx: { orderItem: { create: jest.Mock; update: jest.Mock } } } = {
    tx: { orderItem: { create: jest.fn(), update: jest.fn() } },
    authorOf: lookupOf(buyer ? "BUYER" : "STAFF"),
    orderId: "ord-1",
    ladders: new Map([["p1", units]]),
    tenantId: "t1",
    tier: () => 1,
    categoryMap: new Map(),
    priceEditAllowed: false,
    flooredDelivered: new Map(),
    held: new Map([["line-1", held(heldPieces)]]),
    repriceTierOnQtyOnly: buyer,
  };
  return ctx;
}
const run = (ctx: UnitWriteContext, qty: number, beforeQty: number) =>
  updateUnitLine(ctx, "line-1", product, resolved, { qty, unitLabel: "Case" }, false, beforeQty);

describe("REG-B1386 unit-line diff cap", () => {
  it("E7 refuses a buyer raise to 4,167 cases (100,008 pieces) and writes nothing", async () => {
    const ctx = makeCtx(true, 240);
    await expect(run(ctx, 4_167, 10)).rejects.toMatchObject({
      response: {
        code: API_ERROR_CODES.BUYER_LINE_QTY_OVER_MAX,
        message: BUYER_LINE_QTY_OVER_MAX_MESSAGE,
      },
    });
    expect(ctx.tx.orderItem.update).not.toHaveBeenCalled();
  });
});

describe("unit-line diff cap pins (B1386)", () => {
  it("P9 staff may raise a line to 10,000 cases (240,000 pieces) and it is written", async () => {
    const ctx = makeCtx(undefined, 240);
    await expect(run(ctx, 10_000, 10)).resolves.toBeUndefined();
    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
  });

  it("P10 a buyer resending a held 5,000-case (120,000 piece) line unchanged is allowed (rise-only)", async () => {
    const ctx = makeCtx(true, 120_000);
    await expect(run(ctx, 5_000, 5_000)).resolves.toBeUndefined();
    expect(ctx.tx.orderItem.update).toHaveBeenCalledTimes(1);
  });
});
