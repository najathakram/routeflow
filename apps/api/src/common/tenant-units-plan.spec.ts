/**
 * Units U-6: the pure planner behind scripts/backfill-tenant-units.mjs. No DB, no Prisma.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  planTenantUnits,
  planParentFills,
  nameKeyOf,
  unitNameKey,
  archivedLinkLines,
  overflowLines,
  cappedAtApplyLines,
  MAX_ACTIVE_TENANT_UNITS,
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
  it("nameKey is NFC, then trim, then case-fold (unitNameKey)", () => {
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

    it("an EXISTING parent that is a factor-1 row is left (fill-only), counted and listed", () => {
      const r = planParentFills([
        lvl("pc", 1),
        lvl("case", 12, { parentUnitId: "pc" }),
        lvl("tray", 6, { parentUnitId: "pc", perParent: 6 }),
        lvl("box", 24),
      ]);
      // case keeps its pointer and only gets perParent; tray is already filled
      expect(r.parentFills).toContainEqual(
        expect.objectContaining({ productUnitId: "case", parentUnitId: "pc", perParent: 12 }),
      );
      expect(r.explicitPieceParents).toEqual([
        { productUnitId: "case", label: "case" },
        { productUnitId: "tray", label: "tray" },
      ]);
      const main = plan([lvl("pc", 1), lvl("case", 12, { parentUnitId: "pc" })], []);
      expect(main.counts.explicitPieceParent).toBe(1);
    });

    it("a factor-1 level is the base itself: nothing to fill, nothing reported", () => {
      expect(planParentFills([lvl("b", 1)])).toEqual({
        parentFills: [],
        parentSkips: [],
        explicitPieceParents: [],
      });
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

describe("one unit-name key (U-6, SA-810 / SA-797 G1)", () => {
  // The planner keys by the SAME function U-1's `unitNameKey` is: NFC, then trim, then case-fold.
  // `tenant-units-parity.spec.ts` pins the port against the TypeScript original.
  it("exports unitNameKey, and nameKeyOf is that very function", () => {
    expect(typeof unitNameKey).toBe("function");
    expect(nameKeyOf).toBe(unitNameKey);
  });

  it.each([
    ["Caf\u00e9 (NFC)", "Caf\u00e9", "caf\u00e9"],
    ["Cafe + U+0301 (NFD)", "Cafe\u0301", "caf\u00e9"],
    ["\u00c9TUI", "\u00c9TUI", "\u00e9tui"],
    ["E + U+0301 + TUI (NFD)", "E\u0301TUI", "\u00e9tui"],
    ["NBSP padded", "\u00a0Case\u00a0", "case"],
    ["Stra\u00dfe keeps the sharp s", "Stra\u00dfe", "stra\u00dfe"],
    ["STRASSE stays its own word", "STRASSE", "strasse"],
    ["trailing spaces", "Case   ", "case"],
    ["mixed unicode whitespace", "\u2003\ufeffCase\u3000", "case"],
  ])("keys %s", (_label, input, key) => {
    expect(unitNameKey(input)).toBe(key);
  });

  it("the plan merges NFC / NFD / \u00c9TUI / NBSP spellings and keeps Stra\u00dfe and STRASSE apart", () => {
    const r = plan(
      [
        pu("a", "Caf\u00e9"),
        pu("b", "Cafe\u0301"),
        pu("c", "\u00c9TUI"),
        pu("d", "E\u0301tui\u00a0"),
        pu("e", "Stra\u00dfe"),
        pu("f", "STRASSE"),
        pu("g", "Case  "),
        pu("h", "\u00a0case"),
      ],
      [],
    );
    // most used first (two spellings each for caf\u00e9, case, \u00e9tui), then by key
    expect(r.toCreate.map((c: { nameKey: string }) => c.nameKey)).toEqual([
      "caf\u00e9",
      "case",
      "\u00e9tui",
      "strasse",
      "stra\u00dfe",
    ]);
  });
});

describe("SA-810 cap: the backfill is a SYSTEM writer (U-6)", () => {
  const units = (active: number, archived = 0) => [
    ...Array.from({ length: active }, (_, i) => ({ nameKey: `have${i}`, name: `Have${i}` })),
    ...Array.from({ length: archived }, (_, i) => ({
      nameKey: `old${i}`,
      name: `Old${i}`,
      archivedAt: new Date("2026-01-01"),
    })),
  ];
  const words = (n: number) => Array.from({ length: n }, (_, i) => pu(`w${i}`, `Word${i}`));
  const run = (existingUnits: object[], productUnits: PU[], products: P[] = []) =>
    planTenantUnits({ productUnits, products, existingUnits });
  const keys = (r: { toCreate: Array<{ nameKey: string }> }) => r.toCreate.map((c) => c.nameKey);

  it("pins the cap at SA-810's 200", () => {
    expect(MAX_ACTIVE_TENANT_UNITS).toBe(200);
  });

  it("195 active + 10 planned: 5 created, 5 reported as overflow, those levels left unlinked", () => {
    const r = run(units(195), words(10));
    expect(r.toCreate).toHaveLength(5);
    expect(r.overflow).toHaveLength(5);
    expect(r.counts).toMatchObject({
      tenantUnitsCreated: 5,
      tenantUnitsOverflow: 5,
      productUnitsLinked: 5,
      productUnitsUnlinkedOverflow: 5,
    });
    const created = new Set(keys(r));
    const over = new Set(r.overflow.map((o: { name: string }) => o.name.toLowerCase()));
    expect(created.size + over.size).toBe(10);
    for (const k of created) expect(over.has(k)).toBe(false);
    // a link is planned only for a level whose unit is created: an overflow level stays unlinked
    expect(r.links.every((l: { nameKey: string }) => created.has(l.nameKey))).toBe(true);
    expect(195 + r.toCreate.length).toBe(MAX_ACTIVE_TENANT_UNITS);
  });

  it("keeps the most used names and reports the rest by name with their counts", () => {
    const levels = [...words(6), pu("x1", "Word5"), pu("x2", "word5"), pu("y1", "Word4")];
    const r = run(units(197), levels, [prod("p1", "Word4"), prod("p2", "Word0")]);
    // most used first (Word4 and Word5 tie on 3 uses, broken by key), NOT alphabetical
    expect(keys(r)).toEqual(["word4", "word5", "word0"]);
    expect(r.overflow).toEqual([
      { name: "Word1", levels: 1, products: 0 },
      { name: "Word2", levels: 1, products: 0 },
      { name: "Word3", levels: 1, products: 0 },
    ]);
  });

  it("toCreate is ordered by uses desc then key asc even when everything fits the room", () => {
    // room 3, three candidates: nothing overflows, but the apply may find less room and cut the tail
    const levels = [
      pu("a", "aaa"),
      pu("b", "bbb"),
      ...Array.from({ length: 100 }, (_, i) => pu(`z${i}`, "zzz")),
    ];
    const r = run(units(197), levels);
    expect(r.overflow).toEqual([]);
    expect(keys(r)).toEqual(["zzz", "aaa", "bbb"]);
  });

  it("cappedAtApplyLines names every unit the apply-time cap left out, capped at 50 names", () => {
    expect(cappedAtApplyLines([])).toEqual([]);
    expect(cappedAtApplyLines(["Bbb", "Aaa"])).toEqual([
      "left out at apply time, the tenant reached the 200-unit cap since planning (SA-810): " +
        "2 unit name(s)",
      "  Bbb",
      "  Aaa",
    ]);
    const many = Array.from({ length: 60 }, (_, i) => `N${i}`);
    const lines = cappedAtApplyLines(many);
    expect(lines).toHaveLength(1 + 50 + 1);
    expect(lines[lines.length - 1]).toBe("  ... and 10 more");
  });

  it("a tenant already over the cap is grandfathered: 0 new units, nothing refused", () => {
    const r = run(units(230), [pu("c", "Case"), ...words(3)]);
    expect(r.toCreate).toEqual([]);
    expect(r.counts.tenantUnitsCreated).toBe(0);
    expect(r.overflow.map((o: { name: string }) => o.name)).toEqual([
      "Case",
      "Word0",
      "Word1",
      "Word2",
    ]);
  });

  it("a grandfathered tenant still links levels to units it already has", () => {
    const r = run([...units(230), { nameKey: "case", name: "Case" }], [pu("c", "Case")]);
    expect(r.toCreate).toEqual([]);
    expect(r.overflow).toEqual([]);
    expect(r.links).toEqual([{ productUnitId: "c", nameKey: "case", label: "Case" }]);
  });

  it("exactly 200 active: no room; 199: room for one", () => {
    expect(run(units(200), words(2)).toCreate).toHaveLength(0);
    expect(run(units(199), words(2)).toCreate).toHaveLength(1);
  });

  it("archived units do not count against the cap (U-1 unitRoom counts archivedAt null only)", () => {
    const r = run(units(190, 40), words(10));
    expect(r.toCreate).toHaveLength(10);
    expect(r.overflow).toEqual([]);
  });

  it("under the cap nothing changes: no overflow, every unit created", () => {
    const r = run(units(10), words(3));
    expect(r.toCreate).toHaveLength(3);
    expect(r.overflow).toEqual([]);
    expect(r.counts).toMatchObject({ tenantUnitsOverflow: 0, productUnitsUnlinkedOverflow: 0 });
  });

  it("prints the overflow as names and counts only, capped at 50 names", () => {
    expect(overflowLines([])).toEqual([]);
    expect(overflowLines([{ name: "Word1", levels: 2, products: 1 }])).toEqual([
      "not added, the tenant is at the 200-unit cap (SA-810): 1 unit name(s); " +
        "their levels stay unlinked and still sell by label",
      "  Word1: 2 level(s), 1 pack word(s)",
    ]);
    const many = Array.from({ length: 60 }, (_, i) => ({ name: `N${i}`, levels: 1, products: 0 }));
    const lines = overflowLines(many);
    expect(lines).toHaveLength(1 + 50 + 1);
    expect(lines[lines.length - 1]).toBe("  ... and 10 more");
  });
});
