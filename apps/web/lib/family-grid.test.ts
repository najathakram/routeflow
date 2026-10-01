import {
  MAX_FAMILY_ROWS,
  blankRow,
  diffVariantUpdates,
  patchRowToGridIndex,
  validateRows,
  toCreateRequest,
  validateFamilyForm,
  type FamilyForm,
  type GridRow,
} from "./family-grid";

const row = (over: Partial<GridRow> = {}): GridRow => ({
  ...blankRow("k1"),
  name: "Cherry",
  pricePerUnit: "1.50",
  ...over,
});
const form = (over: Partial<FamilyForm> = {}): FamilyForm => ({
  name: "Cola",
  category: "",
  description: "",
  pricePerUnit: "",
  standardCost: "",
  copyFamilyPrice: false,
  rows: [row()],
  ...over,
});

describe("validateFamilyForm — mirrors the API DTO so the common mistakes never cost a round trip", () => {
  it("a good form is valid", () => {
    expect(validateFamilyForm(form())).toMatchObject({
      valid: true,
      family: {},
      rows: {},
      formError: null,
    });
  });

  it("family name is required (trimmed)", () => {
    expect(validateFamilyForm(form({ name: "   " })).family.name).toBe("Enter a family name.");
  });

  it.each([
    ["", "Enter a price."],
    ["abc", "Enter a price like 1.50."],
    ["-1", "Enter a price like 1.50."],
    ["123456789", "Enter a price like 1.50."], // > 8 integer digits
    ["1.5", null],
    ["0", null],
    ["12345678.999", null],
  ])("variant price %j -> %j", (price, msg) => {
    const v = validateFamilyForm(form({ rows: [row({ pricePerUnit: price })] }));
    expect(v.rows[0]?.pricePerUnit ?? null).toBe(msg);
  });

  it.each([
    ["", null], // blank = inherits the family cost (SA-606g)
    ["2.5", null],
    ["x", "Enter a cost like 0.80, or leave blank to use the family cost."],
    ["1234567", "Enter a cost like 0.80, or leave blank to use the family cost."], // > 6 integer digits
  ])("variant cost %j -> %j", (cost, msg) => {
    const v = validateFamilyForm(form({ rows: [row({ standardCost: cost })] }));
    expect(v.rows[0]?.standardCost ?? null).toBe(msg);
  });

  it("family price / cost, when given, follow the same rules; blank is allowed", () => {
    expect(validateFamilyForm(form({ pricePerUnit: "x" })).family.pricePerUnit).toBe(
      "Enter a price like 1.50.",
    );
    expect(validateFamilyForm(form({ standardCost: "x" })).family.standardCost).toBe(
      "Enter a cost like 0.80.",
    );
    expect(validateFamilyForm(form({ pricePerUnit: "", standardCost: "" })).valid).toBe(true);
  });

  it("variant name required; units/case must be a whole number >= 1 when given", () => {
    const v = validateFamilyForm(
      form({ rows: [row({ name: "", unitsPerBox: "0" }), row({ key: "k2", unitsPerBox: "2.5" })] }),
    );
    expect(v.rows[0]).toMatchObject({
      name: "Enter a name.",
      unitsPerBox: "Whole number, 1 or more.",
    });
    expect(v.rows[1]?.unitsPerBox).toBe("Whole number, 1 or more.");
    expect(validateFamilyForm(form({ rows: [row({ unitsPerBox: "12" })] })).valid).toBe(true);
  });

  it("duplicates inside the grid are flagged on BOTH rows before submit (names and each code field, case-insensitive)", () => {
    const v = validateFamilyForm(
      form({
        rows: [
          row({ key: "a", name: "Cherry", sku: "SKU-1" }),
          row({ key: "b", name: "cherry ", sku: "sku-1", barcode: "B1" }),
          row({ key: "c", name: "Lime", barcode: "B1" }),
        ],
      }),
    );
    expect(v.rows[0]).toMatchObject({
      name: "Appears more than once.",
      sku: "Appears more than once.",
    });
    expect(v.rows[1]).toMatchObject({
      name: "Appears more than once.",
      sku: "Appears more than once.",
      barcode: "Appears more than once.",
    });
    expect(v.rows[2]).toMatchObject({ barcode: "Appears more than once." });
    expect(v.valid).toBe(false);
  });

  it("blank codes are never duplicates of each other", () => {
    const v = validateFamilyForm(
      form({ rows: [row({ key: "a", name: "A" }), row({ key: "b", name: "B" })] }),
    );
    expect(v.valid).toBe(true);
  });

  it("needs 1..200 variants", () => {
    expect(validateFamilyForm(form({ rows: [] })).formError).toBe("Add at least one variant.");
    const many = Array.from({ length: MAX_FAMILY_ROWS + 1 }, (_, i) =>
      row({ key: `k${i}`, name: `V${i}` }),
    );
    expect(validateFamilyForm(form({ rows: many })).formError).toBe(
      "A family takes up to 200 variants at a time.",
    );
    expect(validateFamilyForm(form({ rows: many.slice(0, MAX_FAMILY_ROWS) })).valid).toBe(true);
  });
});

describe("toCreateRequest — the exact POST /products/families body", () => {
  it("trims, omits blanks, keeps money as strings and unitsPerBox as an integer", () => {
    const body = toCreateRequest(
      form({
        name: " Cola ",
        category: "Drinks",
        description: "",
        pricePerUnit: "2.00",
        standardCost: "",
        copyFamilyPrice: true,
        rows: [
          row({
            name: " Cherry ",
            sku: " C-1 ",
            barcode: "",
            unitSku: "C-U",
            unitsPerBox: "12",
            pricePerUnit: "1.50",
            standardCost: "0.8",
          }),
          row({ key: "k2", name: "Lime", pricePerUnit: "1.5" }),
        ],
      }),
    );
    expect(body).toEqual({
      family: { name: "Cola", category: "Drinks", pricePerUnit: "2.00" },
      variants: [
        {
          name: "Cherry",
          sku: "C-1",
          unitSku: "C-U",
          unitsPerBox: 12,
          pricePerUnit: "1.50",
          standardCost: "0.8",
        },
        { name: "Lime", pricePerUnit: "1.5" },
      ],
      copyFamilyPrice: true,
    });
  });

  it("copyFamilyPrice is omitted when off", () => {
    expect(toCreateRequest(form())).not.toHaveProperty("copyFamilyPrice");
  });
});

describe("diffVariantUpdates — ONE all-or-nothing PATCH body from the edited grid", () => {
  const orig: GridRow[] = [
    { ...row({ key: "v1", name: "Cherry", sku: "C-1", pricePerUnit: "1.50" }), id: "id1" },
    { ...row({ key: "v2", name: "Lime", pricePerUnit: "1.50" }), id: "id2" },
    { ...row({ key: "v3", name: "Mango", pricePerUnit: "1.75" }), id: "id3" },
  ];

  it("no edits -> an empty body (nothing to send)", () => {
    expect(diffVariantUpdates(orig, orig)).toEqual({});
  });

  it("changed fields only, per id; new rows -> add; removed rows -> deactivate", () => {
    const edited: GridRow[] = [
      { ...orig[0], pricePerUnit: "1.60", sku: "C-1" }, // only the price changed
      // v2 removed
      orig[2],
      { ...row({ key: "n1", name: "Peach", pricePerUnit: "2.00", unitsPerBox: "6" }) }, // new, no id
    ];
    expect(diffVariantUpdates(orig, edited)).toEqual({
      update: [{ id: "id1", pricePerUnit: "1.60" }],
      deactivate: ["id2"],
      add: [{ name: "Peach", unitsPerBox: 6, pricePerUnit: "2.00" }],
    });
  });

  it("a cleared optional field is sent as an empty string so the server can clear it", () => {
    const edited = [{ ...orig[0], sku: "" }, orig[1], orig[2]];
    expect(diffVariantUpdates(orig, edited)).toEqual({ update: [{ id: "id1", sku: "" }] });
  });

  it("an emptied units/case or cost cell is not sent (the contract has no clear for them)", () => {
    const base = [{ ...orig[0], unitsPerBox: "6", standardCost: "0.9" }, orig[1], orig[2]];
    const edited = [{ ...base[0], unitsPerBox: "", standardCost: "" }, orig[1], orig[2]];
    expect(diffVariantUpdates(base, edited)).toEqual({});
  });

  it("an untouched blank cost stays absent (inherit), a typed cost is a string", () => {
    const edited = [{ ...orig[0], standardCost: "0.9" }, orig[1], orig[2]];
    expect(diffVariantUpdates(orig, edited)).toEqual({
      update: [{ id: "id1", standardCost: "0.9" }],
    });
  });
});

describe("patchRowToGridIndex — a PATCH conflict's `row` is add rows first, then update rows (offset by add.length)", () => {
  const saved = (i: number): GridRow => ({ ...row({ key: `s${i}`, name: `S${i}` }), id: `id${i}` });
  const edited: GridRow[] = [
    { ...saved(1), pricePerUnit: "9" }, // update[0] -> request row add.length + 0
    row({ key: "n1", name: "New1" }), //   add[0]    -> request row 0
    saved(2), //                          unchanged: not in the request
    { ...saved(3), sku: "Z" }, //         update[1] -> request row add.length + 1
    row({ key: "n2", name: "New2" }), //   add[1]    -> request row 1
  ];
  const original = [saved(1), saved(2), saved(3)];
  const req = diffVariantUpdates(original, edited);

  it("maps every request row back to the grid row that produced it", () => {
    expect(req.add).toHaveLength(2);
    expect(req.update).toHaveLength(2);
    expect(patchRowToGridIndex(0, req, edited)).toBe(1); // New1
    expect(patchRowToGridIndex(1, req, edited)).toBe(4); // New2
    expect(patchRowToGridIndex(2, req, edited)).toBe(0); // first update = saved 1
    expect(patchRowToGridIndex(3, req, edited)).toBe(3); // second update = saved 3
  });

  it("an out-of-range row maps to null (never a wrong cell)", () => {
    expect(patchRowToGridIndex(9, req, edited)).toBeNull();
    expect(patchRowToGridIndex(-1, req, edited)).toBeNull();
  });
});

describe("validateRows — the row rules alone (family detail edit has no family fields)", () => {
  it("returns the same per-cell messages as validateFamilyForm's rows", () => {
    const rows = [row({ name: "", pricePerUnit: "x" })];
    expect(validateRows(rows).rows).toEqual(validateFamilyForm(form({ rows })).rows);
    expect(validateRows([row()]).valid).toBe(true);
  });
});
