import {
  buildLadderView,
  canonicalUnitRef,
  ladderPrice,
  refForLabel,
  type LadderViewUnit,
} from "./price-ladder";
import { resolveCustomerUnitPrice } from "./customer-unit-price";
import { unitCodeOf } from "./invoice-display";
import type { LadderProduct } from "./unit-levels";

// SA-809 K1: a ladder ref names the LEVEL, not the ProductUnit row behind it. The 1-piece level is always "base"
// ("pack" for a one-piece pack), so creating or deleting the factor-1 row never moves a stored ref.
const unit = (id: string, label: string, factorToBase: number, price: string | null = null) => ({
  id,
  label,
  factorToBase,
  price,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const PIECE_ID = "3f1c2e2a-0000-4000-8000-000000000001";
const HALF_ID = "3f1c2e2a-0000-4000-8000-000000000002";
const box: LadderProduct = { unit: "Box", unitsPerBox: 12, pricePerUnit: "12.00" };
const refs = (p: LadderProduct, u: readonly LadderViewUnit[]) =>
  buildLadderView(p, u).rows.map((r) => r.ref);

describe("SA-809 level refs", () => {
  it("K1a: a factor-1 ProductUnit row is named base, not its id", () => {
    const view = buildLadderView(box, [unit(PIECE_ID, "Piece", 1, "1.50")]);
    const piece = view.rows.find((r) => r.factor === 1)!;
    expect(piece.ref).toBe("base");
    expect(piece.kind).toBe("base");
    expect(piece.set[0]).toBe(1.5); // still priced from the row
    expect(refForLabel(box, [unit(PIECE_ID, "Piece", 1)], "Piece")).toBe("base");
    expect(view.rows.map((r) => r.ref)).not.toContain(PIECE_ID);
  });

  it("K1b: creating, then deleting, the factor-1 row leaves every ref unchanged", () => {
    const half = unit(HALF_ID, "Half", 6);
    const without = refs(box, [half]);
    const withPiece = refs(box, [half, unit(PIECE_ID, "Piece", 1)]);
    expect(withPiece).toEqual(without);
    expect(without).toEqual(["pack", HALF_ID, "base"]);
    // a stored base customer price resolves the same before and after the row exists
    const price = (u: LadderViewUnit[]) =>
      resolveCustomerUnitPrice({
        product: box,
        units: u,
        customer: { tier: 1, unitPrices: { base: 2 } },
        unit: "base",
      });
    expect(price([half]).price).toBe(2);
    expect(price([half, unit(PIECE_ID, "Piece", 1)]).price).toBe(2);
  });

  it("K1c: a one-piece pack is named pack; a factor-1 row there (unreachable via the service, priced by master's golden file) is base, never its id", () => {
    const single: LadderProduct = { unit: "Each", unitsPerBox: 1, pricePerUnit: "3.00" };
    expect(refs(single, [])).toEqual(["pack"]);
    expect(refForLabel(single, [], "Piece")).toBe("pack");
    expect(refs(single, [unit(PIECE_ID, "Piece", 1)])).toEqual(["pack", "base"]);
    expect(canonicalUnitRef([unit(PIECE_ID, "Piece", 1)], PIECE_ID)).toBe("base");
  });

  it("canonicalUnitRef: a write naming the 1-piece row's id stores base; other refs pass through", () => {
    const units = [unit(HALF_ID, "Half", 6), unit(PIECE_ID, "Piece", 1)];
    expect(canonicalUnitRef(units, PIECE_ID)).toBe("base");
    expect(canonicalUnitRef(units, HALF_ID)).toBe(HALF_ID);
    expect(canonicalUnitRef(units, "pack")).toBe("pack");
    expect(canonicalUnitRef(units, "base")).toBe("base");
    const other = "3f1c2e2a-0000-4000-8000-0000000000ff";
    expect(canonicalUnitRef(units, other)).toBe(other);
    // a customer unit price asked for by the row's id resolves on the level ref
    const r = resolveCustomerUnitPrice({
      product: box,
      units,
      customer: { tier: 1, unitPrices: { base: 2 } },
      unit: PIECE_ID,
    });
    expect([r.unit, r.price, r.source]).toEqual(["base", 2, "customer"]);
  });

  it("pin: every ladder row with factor 1 is base or pack, and exactly one row is base (boxed packs)", () => {
    const products: LadderProduct[] = [
      box,
      { unit: "Each", unitsPerBox: 1, pricePerUnit: "3.00" },
      { unit: "Case", unitsPerBox: 24, pricePerUnit: "48.00" },
    ];
    const rowSets: LadderViewUnit[][] = [
      [],
      [unit(PIECE_ID, "Piece", 1)],
      [unit(HALF_ID, "Half", 6), unit(PIECE_ID, "Piece", 1, "1.00")],
      [unit(PIECE_ID, "Piece", 1), unit("3f1c2e2a-0000-4000-8000-000000000003", "Single", 1)],
    ];
    for (const p of products) {
      for (const u of rowSets) {
        const view = buildLadderView(p, u);
        const ones = view.rows.filter((r) => r.factor === 1);
        for (const o of ones) expect(["base", "pack"]).toContain(o.ref);
        if ((p.unitsPerBox ?? 1) > 1) expect(ones.map((o) => o.ref)).toEqual(["base"]);
        else expect(ones.map((o) => o.ref)).toContain("pack");
        for (const r of view.rows) expect(() => ladderPrice(view, r.ref, 1)).not.toThrow();
      }
    }
  });

  it("the 1-piece row's own code is read from the base ref, falling back as before", () => {
    expect(unitCodeOf({ sku: "S", unitCodes: { base: "B1" } }, "base")).toBe("B1");
    expect(unitCodeOf({ sku: "S", unitSku: "U" }, "base")).toBe("U");
  });
});
