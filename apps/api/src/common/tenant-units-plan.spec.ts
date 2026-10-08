/**
 * Units U-6: the pure planner behind scripts/backfill-tenant-units.mjs. No DB, no Prisma.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { planTenantUnits, nameKeyOf } = require("../../scripts/lib/tenant-units-plan.cjs");

type PU = { id: string; label: string | null; tenantUnitId: string | null };
type P = { id: string; unit: string | null; packLabel: string | null };
const pu = (id: string, label: string, tenantUnitId: string | null = null): PU => ({
  id,
  label,
  tenantUnitId,
});
const prod = (id: string, unit: string | null, packLabel: string | null = null): P => ({
  id,
  unit,
  packLabel,
});
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
    // 1 distinct too-long level/unit key + 0 pack fills (the long unit is counted once as a key,
    // and again as a skipped pack fill)
    expect(r.counts.skippedTooLong).toBe(2);
    expect(r.packFills).toEqual([]);
  });

  it("links only NULL tenantUnitId levels, including to a pre-existing unit", () => {
    const r = plan([pu("a", "Case"), pu("b", "Case", "already")], [], ["case"]);
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([{ productUnitId: "a", nameKey: "case", label: "Case" }]);
    expect(r.counts.tenantUnitsExisting).toBe(1);
  });

  it("fills packLabel from unit only where null/blank and unit non-empty", () => {
    const r = plan(
      [],
      [prod("p1", " Case "), prod("p2", "Box", "Carton"), prod("p3", ""), prod("p4", "Tray", "")],
    );
    expect(r.packFills).toEqual([
      { productId: "p1", packLabel: "Case", unit: " Case " },
      { productId: "p4", packLabel: "Tray", unit: "Tray" },
    ]);
  });

  it("fills packLabel with the tenant's canonical casing, never the product's own (a)", () => {
    const r = plan(
      [pu("a", "Case"), pu("b", "Case")],
      [prod("p1", "CASE"), prod("p2", "case"), prod("p3", "Case")],
    );
    expect(r.packFills).toEqual([
      { productId: "p1", packLabel: "Case", unit: "CASE" },
      { productId: "p2", packLabel: "Case", unit: "case" },
      { productId: "p3", packLabel: "Case", unit: "Case" },
    ]);
  });

  it("uses a pre-existing TenantUnit's own name as the canonical casing (a)", () => {
    const r = planTenantUnits({
      productUnits: [],
      products: [prod("p1", "CASE"), prod("p2", "case")],
      existingUnits: [{ nameKey: "case", name: "Case" }],
    });
    expect(r.packFills.map((f: { packLabel: string }) => f.packLabel)).toEqual(["Case", "Case"]);
  });

  it("never fills a pack label for a Piece synonym, whatever its casing (b)", () => {
    const r = plan(
      [],
      [
        prod("p1", "each"),
        prod("p2", "Pcs"),
        prod("p3", "PIECE"),
        prod("p4", " Unit "),
        prod("p5", "Pieces"),
      ],
    );
    expect(r.packFills).toEqual([]);
    expect(r.counts.productsPackLabelFilled).toBe(0);
  });

  it("a fill's data is packLabel only; unit rides along solely as the write guard's source (c)", () => {
    const r = plan([pu("a", "Case")], [prod("p1", "CASE")]);
    expect(r.packFills).toEqual([{ productId: "p1", packLabel: "Case", unit: "CASE" }]);
  });

  it("a second plan after the fill writes nothing (d)", () => {
    const first = plan([pu("a", "Case")], [prod("p1", "CASE"), prod("p2", "each")]);
    const filled = first.packFills.map((f: { productId: string; packLabel: string }) =>
      prod(f.productId, f.productId === "p1" ? "CASE" : "each", f.packLabel),
    );
    const second = plan([pu("a", "Case", "u1")], [...filled, prod("p2", "each", null)], ["case"]);
    expect(second.packFills).toEqual([]);
    expect(second.links).toEqual([]);
    expect(second.toCreate).toEqual([]);
  });

  it("carries the raw source value of every link and fill, for the write guards", () => {
    const r = plan([pu("a", " Case ")], [prod("p1", " Tray ")]);
    expect(r.links).toEqual([{ productUnitId: "a", nameKey: "case", label: " Case " }]);
    expect(r.packFills).toEqual([{ productId: "p1", packLabel: "Tray", unit: " Tray " }]);
  });

  it("never plans a fill over a whitespace-only packLabel (the write guard matches NULL or empty)", () => {
    const r = plan(
      [],
      [prod("p1", "Tray", "   "), prod("p2", "Tray", ""), prod("p3", "Tray", null)],
    );
    expect(r.packFills.map((f: { productId: string }) => f.productId)).toEqual(["p2", "p3"]);
    expect(r.counts.productsPackLabelFilled).toBe(2);
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

  it("skips the fill when the unit's KEY is too long, even if the word itself is not", () => {
    // 16 x U+0130 is 16 UTF-16 units, but lowercases to 32: no TenantUnit, so no fill either.
    const word = "\u0130".repeat(16);
    expect(word.length).toBeLessThanOrEqual(30);
    const r = plan([], [prod("p1", word)]);
    expect(r.toCreate).toEqual([]);
    expect(r.packFills).toEqual([]);
  });

  it("fills a unit that merely CONTAINS a synonym word (Each Case is a pack)", () => {
    const r = plan([], [prod("p1", "Each Case"), prod("p2", "Unit Pack")]);
    expect(r.packFills).toEqual([
      { productId: "p1", packLabel: "Each Case", unit: "Each Case" },
      { productId: "p2", packLabel: "Unit Pack", unit: "Unit Pack" },
    ]);
  });

  it("is idempotent: an already-backfilled tenant plans zero changes", () => {
    const r = plan(
      [pu("a", "Case", "u1")],
      [prod("p1", "Case", "Case"), prod("p2", "Pack", "Pack")],
      ["case", "pack"],
    );
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([]);
    expect(r.packFills).toEqual([]);
    expect(r.counts).toMatchObject({
      tenantUnitsCreated: 0,
      productUnitsLinked: 0,
      productsPackLabelFilled: 0,
    });
  });
});
