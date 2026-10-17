import { applyLadderChange } from "@routeflow/pricing";
import { detailsPricePatch, editTierPatch, editTierPatchMoves } from "./product-tier-patch";

/**
 * REG (product page audit 2026-10-14, money): the detail page's list field did not move the tiers, unlike the products
 * list quick-save. Raising the list 10 → 12 saved tiers 2-5 still at 10, so tier 2-5 customers kept the old price.
 * The edit form shows each tier's stored value (Product tiers are NOT NULL; 0 = follows the list).
 */
const stored = (t2: string, t3: string, t4: string, t5: string) => ({
  pricePerUnit: "10.00",
  priceTier2: t2,
  priceTier3: t3,
  priceTier4: t4,
  priceTier5: t5,
});
/** The draft exactly as the form shows a stored product (String(parseFloat(value))). */
const shown = (s: ReturnType<typeof stored>) => ({
  pricePerUnit: String(parseFloat(s.pricePerUnit)),
  priceTier2: String(parseFloat(s.priceTier2)),
  priceTier3: String(parseFloat(s.priceTier3)),
  priceTier4: String(parseFloat(s.priceTier4)),
  priceTier5: String(parseFloat(s.priceTier5)),
});

describe("editTierPatch: the detail page moves tiers with the list exactly like the quick-save", () => {
  it("REG: 10/10/10/10 with the list raised to 12 sends 12/12/12/12", () => {
    const s = stored("10.00", "10.00", "10.00", "10.00");
    expect(editTierPatch(s, { ...shown(s), pricePerUnit: "12" })).toEqual({
      priceTier2: "12.00",
      priceTier3: "12.00",
      priceTier4: "12.00",
      priceTier5: "12.00",
    });
  });

  it("REG: 9/10/0/10 → 12 sends 9/12/0/12 (a discount and a follows-list 0 stay)", () => {
    const s = stored("9.00", "10.00", "0.00", "10.00");
    expect(editTierPatch(s, { ...shown(s), pricePerUnit: "12" })).toEqual({
      priceTier2: "9",
      priceTier3: "12.00",
      priceTier4: "0",
      priceTier5: "12.00",
    });
  });

  it("a list cut 10 → 8: equal tiers move, a tier above the new list is capped (8/8/0/8)", () => {
    const s = stored("9.00", "10.00", "0.00", "10.00");
    const p = editTierPatch(s, { ...shown(s), pricePerUnit: "8" });
    expect([p.priceTier2, p.priceTier3, p.priceTier4, p.priceTier5]).toEqual([
      "8.00",
      "8.00",
      "0",
      "8.00",
    ]);
  });

  it("7/10/0/10 → 8 gives 7/8/0/8", () => {
    const s = stored("7.00", "10.00", "0.00", "10.00");
    const p = editTierPatch(s, { ...shown(s), pricePerUnit: "8" });
    expect([p.priceTier2, p.priceTier3, p.priceTier4, p.priceTier5]).toEqual([
      "7",
      "8.00",
      "0",
      "8.00",
    ]);
  });

  it("a tier the operator typed in the same edit wins over the cascade", () => {
    const s = stored("10.00", "10.00", "10.00", "10.00");
    const p = editTierPatch(s, { ...shown(s), pricePerUnit: "12", priceTier3: "11" });
    expect(p.priceTier3).toBe("11");
    expect(p.priceTier2).toBe("12.00");
  });

  it("an unrelated edit (list unchanged) sends the stored tiers unchanged", () => {
    const s = stored("9.00", "10.00", "0.00", "10.00");
    expect(editTierPatch(s, shown(s))).toEqual({
      priceTier2: "9",
      priceTier3: "10",
      priceTier4: "0",
      priceTier5: "10",
    });
  });

  it("the detail payload's moved tiers equal the quick-save's applyLadderChange for the same change", () => {
    const s = stored("9.00", "10.00", "0.00", "10.00");
    const detail = editTierPatch(s, { ...shown(s), pricePerUnit: "12" });
    const quick = applyLadderChange("pricePerUnit", s.pricePerUnit, "12", s);
    for (const [k, v] of Object.entries(quick)) expect(detail[k as keyof typeof detail]).toBe(v);
  });
});

describe("editTierPatchMoves: the note shows only when a save would move a tier", () => {
  it("a list raise over equal tiers moves them; an unrelated edit or a typed tier does not", () => {
    const s = stored("9.00", "10.00", "0.00", "10.00");
    expect(editTierPatchMoves(s, { ...shown(s), pricePerUnit: "12" })).toEqual({
      priceTier3: "12.00",
      priceTier5: "12.00",
    });
    expect(editTierPatchMoves(s, shown(s))).toEqual({});
    const typed = { ...shown(s), pricePerUnit: "12", priceTier3: "11", priceTier5: "11" };
    expect(editTierPatchMoves(s, typed)).toEqual({});
  });
});

describe("#3470 review: a list change from 0 and typed tiers", () => {
  it("a list change from 0 keeps 0 tiers at 0 and a typed tier keeps its value", () => {
    const s = {
      pricePerUnit: "0",
      priceTier2: "0",
      priceTier3: "0",
      priceTier4: "0",
      priceTier5: "0",
    };
    const p = editTierPatch(s, {
      pricePerUnit: "12",
      priceTier2: "0",
      priceTier3: "9",
      priceTier4: "0",
      priceTier5: "0",
    });
    expect(p).toEqual({ priceTier2: "0", priceTier3: "9", priceTier4: "0", priceTier5: "0" });
  });
});

describe("detailsPricePatch: the Details save sends only the prices the operator changed", () => {
  const s = stored("9.00", "10.00", "0.00", "10.00");
  const seeded = shown(s);

  it("REG: an untouched draft sends no price key at all (a v2 save may have moved them since)", () => {
    expect(detailsPricePatch(s, { ...seeded }, seeded)).toEqual({
      pricePerUnit: undefined,
      priceTier2: undefined,
      priceTier3: undefined,
      priceTier4: undefined,
      priceTier5: undefined,
    });
  });

  it("a changed list price is sent with the ladder's tiers, exactly as editTierPatch builds them", () => {
    const draft = { ...seeded, pricePerUnit: "12" };
    expect(detailsPricePatch(s, draft, seeded)).toEqual({
      pricePerUnit: "12",
      ...editTierPatch(s, draft),
    });
  });

  it("a changed tier is sent alone; the list price and the other tiers stay out", () => {
    const out = detailsPricePatch(s, { ...seeded, priceTier2: "7" }, seeded);
    expect(out.priceTier2).toBe("7");
    expect(out.pricePerUnit).toBeUndefined();
    expect(out.priceTier3).toBeUndefined();
    expect(out.priceTier5).toBeUndefined();
  });

  it("with no recorded edit session it falls back to sending every price (the pre-fix shape)", () => {
    expect(detailsPricePatch(s, { ...seeded }, undefined).pricePerUnit).toBe("10");
  });
});
