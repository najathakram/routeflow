import { codeTakenBy, familyGridConflicts, nameTakenBy } from "./product-family-conflicts";
import { T, makeTx, product, row } from "./product-code-release.fake-tx";

describe("familyGridConflicts (in-request duplicates, pure)", () => {
  it("a code used twice across ALL code columns and rows is reported for EVERY row that repeats it", () => {
    const out = familyGridConflicts([
      { row: 0, name: "A", sku: "S1", barcode: "B1" },
      { row: 1, name: "B", sku: "S2", unitSku: "S1" }, // S1 again (sku vs unitSku: one namespace pair)
      { row: 2, name: "C", barcode: "B1" }, // B1 again
    ]);
    expect(out).toEqual(
      expect.arrayContaining([
        { row: 0, field: "sku", value: "S1", reason: "DUPLICATE_IN_REQUEST" },
        { row: 1, field: "unitSku", value: "S1", reason: "DUPLICATE_IN_REQUEST" },
        { row: 0, field: "barcode", value: "B1", reason: "DUPLICATE_IN_REQUEST" },
        { row: 2, field: "barcode", value: "B1", reason: "DUPLICATE_IN_REQUEST" },
      ]),
    );
    expect(out).toHaveLength(4);
  });

  it("variant names are unique case-insensitively; every repeat is reported", () => {
    const out = familyGridConflicts([
      { row: 0, name: "Cherry" },
      { row: 1, name: "cherry " },
      { row: 2, name: "Lime" },
    ]);
    expect(out).toEqual([
      { row: 0, field: "name", value: "Cherry", reason: "DUPLICATE_IN_REQUEST" },
      { row: 1, field: "name", value: "cherry", reason: "DUPLICATE_IN_REQUEST" },
    ]);
  });

  it("a clean grid has no conflicts; blank codes are ignored", () => {
    expect(
      familyGridConflicts([
        { row: 0, name: "A", sku: "S1", barcode: "" },
        { row: 1, name: "B", sku: "S2", barcode: "  " },
      ]),
    ).toEqual([]);
  });
});

describe("codeTakenBy (ACTIVE holders of the same tenant)", () => {
  it("names the active holder of each code with its row, field and productId", async () => {
    const tx = makeTx({
      products: [product({ id: "h1", sku: "S1" }), product({ id: "h2", barcode: "B2" })],
    });
    const out = await codeTakenBy(tx, T, [
      { row: 0, field: "sku", value: "S1" },
      { row: 1, field: "barcode", value: "B2" },
      { row: 2, field: "sku", value: "FREE" },
    ]);
    expect(out).toEqual([
      { row: 0, field: "sku", value: "S1", reason: "CODE_TAKEN", conflictProductId: "h1" },
      { row: 1, field: "barcode", value: "B2", reason: "CODE_TAKEN", conflictProductId: "h2" },
    ]);
  });

  it("a level-row barcode counts; retired codes and INACTIVE owners are FREE (SA-603)", async () => {
    const tx = makeTx({
      products: [
        product({ id: "lv", name: "LV" }),
        product({ id: "old", isActive: false, sku: "S9" }),
        product({ id: "ret", retiredSku: "R1" }),
      ],
      barcodes: [row("r1", "lv", "UNIT", "ROW1")],
    });
    const out = await codeTakenBy(tx, T, [
      { row: 0, field: "barcode", value: "ROW1" },
      { row: 1, field: "sku", value: "S9" },
      { row: 2, field: "sku", value: "R1" },
    ]);
    expect(out).toEqual([
      { row: 0, field: "barcode", value: "ROW1", reason: "CODE_TAKEN", conflictProductId: "lv" },
    ]);
  });

  it("never sees another tenant's product, and can exclude the products being edited", async () => {
    const foreign = { ...product({ id: "f", sku: "S1" }), tenantId: "tenant-b" };
    const tx = makeTx({ products: [foreign, product({ id: "self", sku: "S2" })] });
    expect(await codeTakenBy(tx, T, [{ row: 0, field: "sku", value: "S1" }])).toEqual([]);
    expect(
      await codeTakenBy(tx, T, [{ row: 0, field: "sku", value: "S2" }], {
        excludeProductIds: ["self"],
      }),
    ).toEqual([]);
  });
});

describe("nameTakenBy", () => {
  it("an ACTIVE same-name product in the same parent scope conflicts (case-insensitive); inactive and other scopes do not", async () => {
    const tx = makeTx({
      products: [
        product({ id: "n1", name: "Soda" }),
        product({ id: "n2", name: "Gone", isActive: false }),
        product({ id: "n3", name: "Sibling", parentProductId: "fam-x" }),
      ],
    });
    const out = await nameTakenBy(tx, T, [
      { row: "family", name: "soda", parentProductId: null },
      { row: 0, name: "Gone", parentProductId: null },
      { row: 1, name: "Sibling", parentProductId: null }, // a variant name elsewhere: other scope
    ]);
    expect(out).toEqual([
      {
        row: "family",
        field: "name",
        value: "soda",
        reason: "NAME_TAKEN",
        conflictProductId: "n1",
      },
    ]);
  });
});
