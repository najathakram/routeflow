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
    expect(r.links).toEqual([{ productUnitId: "b", nameKey: ok }]);
    // 1 distinct too-long level/unit key + 0 pack fills (the long unit is counted once as a key,
    // and again as a skipped pack fill)
    expect(r.counts.skippedTooLong).toBe(2);
    expect(r.packFills).toEqual([]);
  });

  it("links only NULL tenantUnitId levels, including to a pre-existing unit", () => {
    const r = plan([pu("a", "Case"), pu("b", "Case", "already")], [], ["case"]);
    expect(r.toCreate).toEqual([]);
    expect(r.links).toEqual([{ productUnitId: "a", nameKey: "case" }]);
    expect(r.counts.tenantUnitsExisting).toBe(1);
  });

  it("fills packLabel from unit only where null/blank and unit non-empty", () => {
    const r = plan(
      [],
      [prod("p1", " Case "), prod("p2", "Box", "Carton"), prod("p3", ""), prod("p4", "Tray", "")],
    );
    expect(r.packFills).toEqual([
      { productId: "p1", packLabel: "Case" },
      { productId: "p4", packLabel: "Tray" },
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
