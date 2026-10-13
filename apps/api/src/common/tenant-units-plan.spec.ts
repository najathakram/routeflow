/**
 * Units U-6: the pure planner behind scripts/backfill-tenant-units.mjs. No DB, no Prisma.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  planTenantUnits,
  planParentFills,
  nameKeyOf,
  archivedLinkLines,
} = require("../../scripts/lib/tenant-units-plan.cjs");

type PU = {
  id: string;
  productId: string;
  label: string | null;
  tenantUnitId: string | null;
  factorToBase: number;
  parentUnitId: string | null;
  perParent: number | null;
};
type P = { id: string; unit: string | null };
/** A ladder level; factor 1 (the base) by default, so link-only cases plan no parent fill. */
const pu = (
  id: string,
  label: string,
  tenantUnitId: string | null = null,
  ladder: Partial<Pick<PU, "productId" | "factorToBase" | "parentUnitId" | "perParent">> = {},
): PU => ({
  id,
  productId: `p-${id}`,
  label,
  tenantUnitId,
  factorToBase: 1,
  parentUnitId: null,
  perParent: null,
  ...ladder,
});
const prod = (id: string, unit: string | null): P => ({ id, unit });
const plan = (productUnits: PU[], products: P[], existing: string[] = []) =>
  planTenantUnits({
    productUnits,
    products,
    existingUnits: existing.map((nameKey) => ({ nameKey })),
  });

describe("planTenantUnits (U-6)", () => {
  it("nameKey is lower(trim(name))", () => {
    expect(nameKeyOf("  CaSe ")).toBe("case");
  });

  it("groups by nameKey across levels and legacy words, one unit per key", () => {
    const r = plan([pu("a", "Case"), pu("b", " case ")], [prod("p1", "CASE"), prod("p2", "Pack")]);
    expect(r.toCreate.map((c: { nameKey: string }) => c.nameKey)).toEqual(["case", "pack"]);
    expect(r.counts.tenantUnitsCreated).toBe(2);
  });

  it("uses the most common original casing, ties broken deterministically", () => {
    const r = plan([pu("a", "case"), pu("b", "Case"), pu("c", "Case")], []);
    expect(r.toCreate[0].name).toBe("Case");
    const tie = plan([pu("a", "case"), pu("b", "Case")], []);
    expect(tie.toCreate[0].name).toBe("Case");
  });

  it("skips Piece synonyms: no unit, no link", () => {
    const r = plan(
      [pu("a", "Piece"), pu("b", "each"), pu("c", "PCS"), pu("d", "Unit")],
      [prod("p1", "Pieces")],
    );
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.counts.skippedSynonyms).toBe(5);
  });

  it("skips names over 30 chars (reported), accepts exactly 30", () => {
    const long = "x".repeat(31);
    const ok = "y".repeat(30);
    const r = plan([pu("a", long), pu("b", ok)], [prod("p1", long)]);
    expect(r.toCreate.map((c: { nameKey: string }) => c.nameKey)).toEqual([ok]);
    expect(r.links).toEqual([{ productUnitId: "b", nameKey: ok, label: ok }]);
    // one distinct too-long key (the level and the legacy word share it)
    expect(r.counts.skippedTooLong).toBe(1);
  });

  it("links only NULL tenantUnitId levels, including to a pre-existing unit", () => {
    const r = plan([pu("a", "Case"), pu("b", "Case", "already")], [], ["case"]);
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([{ productUnitId: "a", nameKey: "case", label: "Case" }]);
    expect(r.counts.tenantUnitsExisting).toBe(1);
  });

  it("never plans a Product write: no pack-label fill exists (SA M1, SA-729:52)", () => {
    const r = plan([pu("a", "Case")], [prod("p1", "CASE"), prod("p2", "Tray"), prod("p3", "each")]);
    expect(r).not.toHaveProperty("packFills");
    expect(r.counts).not.toHaveProperty("productsPackLabelFilled");
    // the legacy pack word still NAMES a unit (Tray), it just never writes the product
    expect(r.toCreate.map((c: { nameKey: string }) => c.nameKey)).toEqual(["case", "tray"]);
  });

  it("carries the raw source value of every link, for the write guard", () => {
    const r = plan([pu("a", " Case ")], []);
    expect(r.links).toEqual([{ productUnitId: "a", nameKey: "case", label: " Case " }]);
  });

  it("a casing tie prefers a mixed-case spelling over ALL-CAPS and all-lowercase", () => {
    for (const levels of [
      [pu("a", "CASE"), pu("b", "Case")],
      [pu("a", "Case"), pu("b", "CASE")],
      [pu("a", "case"), pu("b", "CASE"), pu("c", "Case")],
    ]) {
      expect(plan(levels, []).toCreate[0].name).toBe("Case");
    }
    // a real majority still wins, and with no mixed candidate the old order applies
    expect(plan([pu("a", "CASE"), pu("b", "CASE"), pu("c", "Case")], []).toCreate[0].name).toBe(
      "CASE",
    );
    expect(plan([pu("a", "case"), pu("b", "CASE")], []).toCreate[0].name).toBe("CASE");
  });

  it("measures the DISPLAY name for too-long, never the key", () => {
    // 16 x U+0130 is 16 characters, but lowercases to a 32-unit key: the name fits, so it is created.
    const word = "İ".repeat(16);
    expect(word.length).toBeLessThanOrEqual(30);
    expect(nameKeyOf(word).length).toBeGreaterThan(30);
    const r = plan([], [prod("p1", word)]);
    expect(r.toCreate.map((c: { name: string }) => c.name)).toEqual([word]);
    expect(r.counts.skippedTooLong).toBe(0);
  });

  it("names a unit that merely CONTAINS a synonym word (Each Case is a pack)", () => {
    const r = plan([], [prod("p1", "Each Case"), prod("p2", "Unit Pack")]);
    expect(r.toCreate.map((c: { name: string }) => c.name)).toEqual(["Each Case", "Unit Pack"]);
  });

  describe("parent / perParent fill (SA M2, SA-729a item 3)", () => {
    const lvl = (id: string, factorToBase: number, more: Partial<PU> = {}) =>
      pu(id, id, null, { productId: "p1", factorToBase, ...more });
    const fills = (units: PU[]) => planParentFills(units).parentFills;

    it("parent = the largest LOWER level that divides; perParent = the ratio", () => {
      // 1 (base row), 6, 24, 36: 6 -> base (x6); 24 -> 6 (x4); 36 -> 6 (x6, 24 does not divide 36)
      const units = [lvl("b", 1), lvl("six", 6), lvl("tf", 24), lvl("ts", 36)];
      expect(fills(units)).toEqual([
        expect.objectContaining({ productUnitId: "six", parentUnitId: null, perParent: 6 }),
        expect.objectContaining({ productUnitId: "tf", parentUnitId: "six", perParent: 4 }),
        expect.objectContaining({ productUnitId: "ts", parentUnitId: "six", perParent: 6 }),
      ]);
    });

    it("with no base row and no dividing level, the parent is the implicit base piece", () => {
      const [f] = fills([lvl("c", 12), lvl("odd", 5)]).filter(
        (x: { productUnitId: string }) => x.productUnitId === "c",
      );
      expect(f).toMatchObject({ parentUnitId: null, parentFactor: 1, perParent: 12 });
    });

    it("a factor-1 ROW is never a parent: the base is parentUnitId NULL (SA-728)", () => {
      const [f] = fills([lvl("b", 1), lvl("case", 12)]);
      expect(f).toMatchObject({ productUnitId: "case", parentUnitId: null, perParent: 12 });
    });

    describe("the PACK is a lower level (Product.unitsPerBox)", () => {
      const withPack = (upb: number | null, units: PU[]) =>
        planParentFills(units, [{ id: "p1", unitsPerBox: upb }]).parentFills;

      it("upb 12 and Case 48: parentUnitId NULL, perParent 4 (4 Box = 1 Case)", () => {
        expect(withPack(12, [lvl("case", 48)])).toEqual([
          expect.objectContaining({
            productUnitId: "case",
            parentUnitId: null,
            perParent: 4,
            packFactor: 12,
          }),
        ]);
      });

      it("upb 1 (no pack) and Case 12: the base, perParent 12", () => {
        expect(withPack(1, [lvl("case", 12)])).toEqual([
          expect.objectContaining({ parentUnitId: null, perParent: 12, packFactor: null }),
        ]);
      });

      it("a larger dividing ROW wins over the pack; the pack wins over a smaller row", () => {
        const a = withPack(6, [lvl("twelve", 12), lvl("big", 48)]);
        expect(a.find((f: { productUnitId: string }) => f.productUnitId === "big")).toMatchObject({
          parentUnitId: "twelve",
          perParent: 4,
        });
        const b = withPack(12, [lvl("six", 6), lvl("big", 48)]);
        expect(b.find((f: { productUnitId: string }) => f.productUnitId === "big")).toMatchObject({
          parentUnitId: null,
          perParent: 4,
          packFactor: 12,
        });
      });

      it("a row at the pack's own size is the pack's level: the row wins the tie", () => {
        const f = withPack(12, [lvl("box", 12), lvl("big", 48)]).find(
          (x: { productUnitId: string }) => x.productUnitId === "big",
        );
        expect(f).toMatchObject({ parentUnitId: "box", perParent: 4 });
      });

      it("a pack that does not divide, or is not smaller, is ignored", () => {
        expect(withPack(5, [lvl("case", 12)])[0]).toMatchObject({
          perParent: 12,
          packFactor: null,
        });
        expect(withPack(12, [lvl("case", 12)])[0]).toMatchObject({
          perParent: 12,
          packFactor: null,
        });
      });
    });

    it("a factor-1 level is the base itself: nothing to fill, nothing reported", () => {
      expect(planParentFills([lvl("b", 1)])).toEqual({ parentFills: [], parentSkips: [] });
    });

    it("a level that names a parent but has no perParent gets factor / parent factor", () => {
      expect(fills([lvl("six", 6), lvl("tf", 24, { parentUnitId: "six" })])).toContainEqual(
        expect.objectContaining({
          productUnitId: "tf",
          fromParentUnitId: "six",
          parentUnitId: "six",
          perParent: 4,
        }),
      );
    });

    it("a non-divisible pair is reported and skipped, never guessed", () => {
      const r = planParentFills([lvl("ten", 10), lvl("tf", 24, { parentUnitId: "ten" })]);
      expect(r.parentFills.map((f: { productUnitId: string }) => f.productUnitId)).toEqual(["ten"]);
      expect(r.parentSkips).toEqual([
        {
          productUnitId: "tf",
          reason: "its factor is not a whole multiple (>= 2) of its parent's",
        },
      ]);
    });

    it("a parent on another product, or a factor below 1, is reported and skipped", () => {
      const r = planParentFills([lvl("x", 12, { parentUnitId: "elsewhere" }), lvl("zero", 0)]);
      expect(r.parentFills).toEqual([]);
      expect(r.parentSkips.map((s: { productUnitId: string }) => s.productUnitId)).toEqual([
        "x",
        "zero",
      ]);
    });

    it("never crosses products, and a filled level (perParent set) is done", () => {
      const r = planParentFills([
        pu("a6", "a6", null, { productId: "A", factorToBase: 6 }),
        pu("b12", "b12", null, { productId: "B", factorToBase: 12 }),
        pu("done", "done", null, { productId: "B", factorToBase: 24, perParent: 2 }),
      ]);
      expect(r.parentFills).toEqual([
        expect.objectContaining({ productUnitId: "a6", parentUnitId: null, perParent: 6 }),
        expect.objectContaining({ productUnitId: "b12", parentUnitId: null, perParent: 12 }),
      ]);
    });

    it("rides the main plan with its counts", () => {
      const r = plan(
        [lvl("b", 1), lvl("six", 6), lvl("ten", 10), lvl("bad", 25, { parentUnitId: "ten" })],
        [],
      );
      expect(r.counts).toMatchObject({ productUnitsParentFilled: 2, skippedParent: 1 });
    });
  });

  describe("archived units", () => {
    const archived = (nameKey: string, name: string) => ({
      nameKey,
      name,
      archivedAt: new Date("2026-01-01"),
    });

    it("matches an archived unit by key (never a second unit), links to it, keeps its name", () => {
      const r = planTenantUnits({
        // "case" is the majority casing, but the existing unit's name is canonical
        productUnits: [pu("a", "case"), pu("b", "case"), pu("c", "Case")],
        products: [prod("p1", "CASE")],
        existingUnits: [archived("case", "Case")],
      });
      expect(r.toCreate).toEqual([]);
      expect(r.links.map((l: { productUnitId: string }) => l.productUnitId)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(r.archivedLinks).toEqual([{ name: "Case", levels: 3 }]);
    });

    it("reports nothing for a live unit, and one entry per archived unit, sorted by name", () => {
      const r = planTenantUnits({
        productUnits: [pu("a", "tray"), pu("b", "pack"), pu("c", "Crate"), pu("d", "pack")],
        products: [],
        existingUnits: [
          { nameKey: "tray", name: "Tray" },
          archived("pack", "Pack"),
          archived("crate", "Crate"),
        ],
      });
      expect(r.archivedLinks).toEqual([
        { name: "Crate", levels: 1 },
        { name: "Pack", levels: 2 },
      ]);
    });

    it("does not count a level that is already linked", () => {
      const r = planTenantUnits({
        productUnits: [pu("a", "Case", "u1")],
        products: [],
        existingUnits: [archived("case", "Case")],
      });
      expect(r.archivedLinks).toEqual([]);
    });

    it("prints counts-only lines naming the unit, none when there is nothing archived", () => {
      expect(archivedLinkLines([])).toEqual([]);
      expect(archivedLinkLines([{ name: "Case", levels: 3 }])).toEqual([
        'linked to archived unit "Case" \u2014 restore in Settings: 3 product level(s)',
      ]);
    });
  });

  describe("NFC normalisation", () => {
    const composed = "Caf\u00e9";
    const decomposed = "Cafe\u0301";

    it("nameKeyOf folds NFC, trim and case in that order", () => {
      expect(nameKeyOf(decomposed)).toBe(nameKeyOf(composed));
      expect(nameKeyOf(` ${decomposed.toUpperCase()}\u00a0`)).toBe("caf\u00e9");
    });

    it("composed and decomposed spellings are ONE unit with one canonical NFC name", () => {
      const r = plan([pu("a", composed), pu("b", decomposed)], [prod("p1", decomposed)]);
      expect(r.toCreate).toHaveLength(1);
      expect(r.toCreate[0].nameKey).toBe("caf\u00e9");
      expect(r.toCreate[0].name).toBe(composed);
      expect(r.links).toHaveLength(2);
    });

    it("a synonym with a trailing NBSP or odd case is still excluded", () => {
      const r = plan(
        [pu("a", "Each\u00a0")],
        [prod("p1", "Each\u00a0"), prod("p2", " EACH "), prod("p3", "pcs\u00a0")],
      );
      expect(r.toCreate).toEqual([]);
      expect(r.links).toEqual([]);
    });
  });

  it("is idempotent: an already-backfilled tenant plans zero changes", () => {
    const r = plan(
      [pu("a", "Case", "u1", { factorToBase: 12, perParent: 12 })],
      [prod("p1", "Case"), prod("p2", "Pack")],
      ["case", "pack"],
    );
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.parentFills).toEqual([]);
    expect(r.counts).toMatchObject({
      tenantUnitsCreated: 0,
      productUnitsLinked: 0,
      productUnitsParentFilled: 0,
    });
  });
});
