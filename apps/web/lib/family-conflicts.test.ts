import { familyCellKey, getFamilyConflicts } from "./family-conflicts";

const err = (status: number, data: unknown) => ({ response: { status, data } });
const conflict = (rows: unknown[]) =>
  err(409, { code: "FAMILY_ROWS_CONFLICT", message: "RAW SERVER TEXT", rows });

describe("getFamilyConflicts — FAMILY_ROWS_CONFLICT -> one fixed message per offending cell", () => {
  it("maps EVERY row at once, keyed row:field, with the right copy per reason", () => {
    const r = getFamilyConflicts(
      conflict([
        { row: 0, field: "sku", value: "COLA-6", reason: "CODE_TAKEN", conflictProductId: "h1" },
        {
          row: 2,
          field: "barcode",
          value: "4000000000019",
          reason: "CODE_TAKEN",
          conflictProductId: "h2",
        },
        {
          row: 2,
          field: "unitSku",
          value: "COLA-1",
          reason: "CODE_TAKEN",
          conflictProductId: "h3",
        },
        { row: 1, field: "name", value: "Cherry", reason: "NAME_TAKEN", conflictProductId: "h4" },
        { row: 3, field: "sku", value: "DUP-1", reason: "DUPLICATE_IN_REQUEST" },
      ]),
    );
    expect(r?.kind).toBe("ROWS");
    if (r?.kind !== "ROWS") return;
    expect(r.cells[familyCellKey(0, "sku")]).toEqual({
      message: `The SKU "COLA-6" is already used by another product.`,
      productId: "h1",
    });
    expect(r.cells[familyCellKey(2, "barcode")].message).toBe(
      `The barcode "4000000000019" is already used by another product.`,
    );
    expect(r.cells[familyCellKey(2, "unitSku")].message).toBe(
      `The unit code "COLA-1" is already used by another product.`,
    );
    expect(r.cells[familyCellKey(1, "name")].message).toBe(
      `A product named "Cherry" already exists.`,
    );
    expect(r.cells[familyCellKey(3, "sku")]).toEqual({
      message: `"DUP-1" appears more than once in this list.`,
    });
    expect(Object.keys(r.cells)).toHaveLength(5);
    expect(r.count).toBe(5);
    expect(r.summary).toBe("Nothing was saved. Fix the 5 marked cells and try again.");
  });

  it("the container row ('family') maps to the family-name message, not a grid cell", () => {
    const r = getFamilyConflicts(
      conflict([
        {
          row: "family",
          field: "name",
          value: "Cola",
          reason: "NAME_TAKEN",
          conflictProductId: "h9",
        },
      ]),
    );
    expect(r).toMatchObject({
      kind: "ROWS",
      familyMessages: [`A product named "Cola" already exists.`],
      cells: {},
      count: 1,
      summary: "Nothing was saved. Fix the marked field and try again.",
    });
  });

  it("the server message is never carried", () => {
    const r = getFamilyConflicts(
      conflict([{ row: 0, field: "sku", value: "X", reason: "CODE_TAKEN" }]),
    );
    expect(JSON.stringify(r)).not.toMatch(/RAW SERVER TEXT/);
  });

  it("an unknown reason/field in a row still gets a fixed fallback line (never dropped)", () => {
    const r = getFamilyConflicts(
      conflict([{ row: 0, field: "weird", value: "v", reason: "NEW_REASON" }]),
    );
    if (r?.kind !== "ROWS") throw new Error("expected ROWS");
    expect(r.cells[familyCellKey(0, "weird" as any)].message).toBe(
      `"v" conflicts with another product.`,
    );
  });

  it("FAMILY_NOT_FOUND -> its own kind (the family was removed); nothing from the server", () => {
    expect(getFamilyConflicts(err(404, { code: "FAMILY_NOT_FOUND", message: "RAW" }))).toEqual({
      kind: "NOT_FOUND",
    });
  });

  it("FAMILY_PRICE_AUTHORITY (mixed packs: the family owns the variants' price) -> its own kind", () => {
    expect(
      getFamilyConflicts(err(409, { code: "FAMILY_PRICE_AUTHORITY", message: "RAW" })),
    ).toEqual({
      kind: "PRICE_AUTHORITY",
    });
  });

  it.each([
    ["a 500", err(500, { message: "boom" })],
    ["another 409", err(409, { code: "CODE_TAKEN" })],
    ["a network error", new Error("Network Error")],
    ["null", null],
    ["FAMILY_ROWS_CONFLICT with no rows", err(409, { code: "FAMILY_ROWS_CONFLICT", rows: [] })],
  ])("%s -> null (the caller shows one generic toast)", (_n, e) => {
    expect(getFamilyConflicts(e)).toBeNull();
  });
});
