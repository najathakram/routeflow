import { applyLadderChange } from "@routeflow/pricing";
import {
  cascadeTiers,
  detailsPriceMoves,
  detailsPricePatch,
  editTierPatch,
  editTierPatchMoves,
} from "./product-tier-patch";

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
  const none = {
    pricePerUnit: undefined,
    priceTier2: undefined,
    priceTier3: undefined,
    priceTier4: undefined,
    priceTier5: undefined,
  };

  it("REG: an untouched draft sends no price key at all (a v2 save may have moved them since)", () => {
    expect(detailsPricePatch(s, { ...seeded }, seeded)).toEqual(none);
  });

  it("an equal value typed differently (10 vs 10.00) is not a change", () => {
    expect(detailsPricePatch(s, { ...seeded, pricePerUnit: "10.00" }, seeded)).toEqual(none);
  });

  it("a changed list price is sent with ONLY the tiers the ladder moves (9/10/0/10 -> 12 sends 12, T3, T5)", () => {
    expect(detailsPricePatch(s, { ...seeded, pricePerUnit: "12" }, seeded)).toEqual({
      ...none,
      pricePerUnit: "12",
      priceTier3: "12.00",
      priceTier5: "12.00",
    });
  });

  it("MUST 1: a tier a v2 save moved while the form was open is not reverted by a list edit", () => {
    // list 10, T2 9, T3 8; the v2 grid saved T2 = 8.50 (the fresh product); the operator raises the list to 11.
    const old = stored("9.00", "8.00", "0.00", "0.00");
    const fresh = { ...old, priceTier2: "8.50" };
    expect(detailsPricePatch(fresh, { ...shown(old), pricePerUnit: "11" }, shown(old))).toEqual({
      ...none,
      pricePerUnit: "11",
    });
  });

  it("MUST 1: whether an untouched tier moves is decided on its FRESH value, not the one the form opened with", () => {
    // Opened with T2 tracking the list (10); the v2 grid then set T2 = 8.50, so a list change must not move it.
    const old = stored("10.00", "8.00", "0.00", "0.00");
    const fresh = { ...old, priceTier2: "8.50" };
    expect(
      detailsPricePatch(fresh, { ...shown(old), pricePerUnit: "11" }, shown(old)).priceTier2,
    ).toBeUndefined();
    // ...and a tier that NOW tracks the list moves from the fresh value (T3 8 -> 10 by v2, list 10 -> 11).
    const fresh3 = { ...old, priceTier3: "10.00" };
    expect(
      detailsPricePatch(fresh3, { ...shown(old), pricePerUnit: "11" }, shown(old)).priceTier3,
    ).toBe("11.00");
  });

  it("a changed tier is sent alone; the list price and the other tiers stay out", () => {
    const out = detailsPricePatch(s, { ...seeded, priceTier2: "7" }, seeded);
    expect(out).toEqual({ ...none, priceTier2: "7" });
  });

  it("a tier the operator typed wins over a ladder move, whatever the fresh value is", () => {
    const out = detailsPricePatch(s, { ...seeded, pricePerUnit: "12", priceTier3: "10.5" }, seeded);
    expect(out.priceTier3).toBe("10.5");
    expect(out.pricePerUnit).toBe("12");
  });

  it("with no recorded edit session it falls back to sending every price (the pre-fix shape)", () => {
    expect(detailsPricePatch(s, { ...seeded }, undefined).pricePerUnit).toBe("10");
  });
});

describe("detailsPriceMoves: the note names exactly the tiers the save moves with the list", () => {
  const s = stored("9.00", "10.00", "0.00", "10.00");
  const seeded = shown(s);

  it("names the tiers the ladder moves and none the operator typed", () => {
    expect(detailsPriceMoves(s, { ...seeded, pricePerUnit: "12" }, seeded)).toEqual({
      priceTier3: "12.00",
      priceTier5: "12.00",
    });
    expect(
      detailsPriceMoves(s, { ...seeded, pricePerUnit: "12", priceTier3: "10.5" }, seeded),
    ).toEqual({ priceTier5: "12.00" });
  });

  it("is empty when nothing moves", () => {
    expect(detailsPriceMoves(s, { ...seeded }, seeded)).toEqual({});
    expect(detailsPriceMoves(s, { ...seeded, priceTier2: "7" }, seeded)).toEqual({});
  });
});

describe("detailsPricePatch: what counts as a change", () => {
  const s = stored("9.00", "10.00", "0.00", "10.00");
  const seeded = shown(s);

  it("a value that rounds to the same cents (10.004 vs 10) is the same price, so it is not sent", () => {
    const out = detailsPricePatch(s, { ...seeded, pricePerUnit: "10.004" }, seeded);
    expect(out.pricePerUnit).toBeUndefined();
    expect(
      detailsPricePatch(s, { ...seeded, priceTier2: "9.004" }, seeded).priceTier2,
    ).toBeUndefined();
  });

  it("a cleared tier (0, 'follow the list') is a typed change and is sent as 0", () => {
    const out = detailsPricePatch(s, { ...seeded, priceTier3: "0" }, seeded);
    expect(out.priceTier3).toBe("0");
    expect(out.priceTier2).toBeUndefined();
    expect(out.pricePerUnit).toBeUndefined();
  });
});

describe("cascadeTiers: the in-form cascade reads fresh values for tiers the operator has not touched", () => {
  const old = stored("9.00", "9.00", "0.00", "0.00");
  const seeded = shown(old);

  it("an untouched tier is read from the fresh product, a typed one from the draft", () => {
    const fresh = { ...old, priceTier3: "8.00" };
    const draft = { ...seeded, priceTier2: "9.5", priceTier4: "7" };
    const t = cascadeTiers(fresh, draft, seeded);
    expect(t.priceTier3).toBe("8.00"); // untouched: fresh
    expect(t.priceTier4).toBe("7"); // typed: the draft
    expect(t.priceTier5).toBe("0.00"); // untouched: fresh
  });

  it("without a seed it is the draft, as before", () => {
    expect(cascadeTiers(old, { ...seeded, priceTier3: "5" }, undefined).priceTier3).toBe("5");
  });
});
