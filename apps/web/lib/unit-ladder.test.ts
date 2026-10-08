import {
  blankRow,
  collapsedText,
  draftFromServer,
  emptyDraft,
  mapLadderError,
  removeRowAndDescendants,
  resolveDraft,
  summaryText,
  toPutBody,
  unitNameError,
  unitsPerBoxText,
  type LadderDraft,
  type LadderRow,
} from "./unit-ladder";

const row = (
  label: string,
  perParent: string,
  parentLabel: string,
  extra: Partial<LadderRow> = {},
) => ({
  ...blankRow(label, parentLabel),
  perParent,
  ...extra,
});
const draft = (rows: LadderRow[], over: Partial<LadderDraft> = {}): LadderDraft => ({
  ...emptyDraft(),
  baseLabel: "Bottle",
  rows,
  ...over,
});
const errOf = (d: LadderDraft, i: number) => resolveDraft(d).errors.get(d.rows[i].key)?.message;

describe("resolveDraft", () => {
  it("6 Bottle = 1 Pack, 4 Pack = 1 Case -> Case holds 24 Bottles", () => {
    const d = draft([row("Pack", "6", "Bottle"), row("Case", "4", "Pack")]);
    const r = resolveDraft(d);
    expect(r.errors.size).toBe(0);
    expect([...r.factors.values()]).toEqual([6, 24]);
    expect(summaryText(d, r)).toBe("1 Case = 4 Packs = 24 Bottles");
  });

  it.each([
    ["", "blank"],
    ["1", "under 2"],
    ["2.5", "not whole"],
    ["abc", "not a number"],
  ])("perParent %p (%s) -> whole-number message", (n) => {
    expect(errOf(draft([row("Pack", n, "Bottle")]), 0)).toBe("Enter a whole number, 2 or more.");
  });

  it("over 1,000,000 -> the cap message", () => {
    const d = draft([row("Pack", "1000", "Bottle"), row("Pallet", "1001", "Pack")]);
    expect(errOf(d, 1)).toBe(
      "That's more than 1,000,000 Bottles in one Pallet. Check the numbers.",
    );
  });

  it("same unit twice, right = base, and same size twice", () => {
    expect(errOf(draft([row("Pack", "6", "Bottle"), row("pack", "4", "Pack")]), 1)).toBe(
      "Pack is already in this ladder. Use each unit once.",
    );
    expect(errOf(draft([row("Bottle", "6", "Bottle")]), 0)).toBe("Pick a bigger unit than Bottle.");
    expect(errOf(draft([row("Pack", "6", "Bottle"), row("Tray", "6", "Bottle")]), 1)).toBe(
      "Pack and Tray would both hold 6 Bottles. Change one.",
    );
  });

  it("a legacy flat ladder (Case 50, Inner 12) is two siblings under the base", () => {
    const d = draft([row("Case", "50", "Bottle"), row("Inner", "12", "Bottle")]);
    expect([...resolveDraft(d).factors.values()]).toEqual([50, 12]);
  });

  it("the pack named like the smallest unit is refused", () => {
    const d = draft([row("Case", "6", "Bottle")], { packLevel: "Case" });
    expect(resolveDraft(d, { packWord: "bottle" }).errors.get(d.rows[0].key)?.message).toBe(
      "The pack can't have the same name as the smallest unit.",
    );
  });
});

describe("draftFromServer", () => {
  const lvl = (o: Record<string, unknown>) =>
    ({
      id: "u",
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      isDefaultSelling: false,
      sortOrder: 0,
      ...o,
    }) as never;

  it("a legacy level loads as '[50] [Piece] = 1 [Case]'", () => {
    const d = draftFromServer({ unit: "Box", unitsPerBox: null }, [
      lvl({ label: "Case", factorToBase: 50 }),
    ]);
    expect(d.rows).toHaveLength(1);
    expect([d.rows[0].perParent, d.rows[0].parentLabel, d.rows[0].label]).toEqual([
      "50",
      "Piece",
      "Case",
    ]);
  });

  it("rebuilds a chain from perParent, and the pack becomes a row of its own", () => {
    const d = draftFromServer(
      { unit: "Box", unitsPerBox: 24, baseUnitLabel: "Bottle", packLabel: "Case" },
      [lvl({ id: "a", label: "Pack", factorToBase: 6, perParent: 6 })],
    );
    expect(d.rows.map((r) => [r.label, r.perParent, r.parentLabel])).toEqual([
      ["Pack", "6", "Bottle"],
      ["Case", "4", "Pack"],
    ]);
    expect(d.packLevel).toBe("Case");
    expect(unitsPerBoxText(d)).toBe("Case = 24 Bottles (from your units below)");
  });

  it("a plain boxed product loads as '[24] [Piece] = 1 [Box]'", () => {
    const d = draftFromServer({ unit: "Box", unitsPerBox: 24 }, []);
    expect(d.rows.map((r) => [r.label, r.perParent, r.parentLabel])).toEqual([
      ["Box", "24", "Piece"],
    ]);
  });
});

describe("collapsedText", () => {
  it("nothing set up", () => {
    expect(collapsedText(emptyDraft(), null)).toBe("Sold in single pieces.");
    expect(collapsedText(emptyDraft(), 12)).toBe("Sold by the box (12 pieces) and by the piece.");
  });
  it("set up shows the chain", () => {
    const d = draft([row("Pack", "6", "Bottle"), row("Case", "4", "Pack")]);
    expect(collapsedText(d, null)).toBe("1 Case = 4 Packs = 24 Bottles");
  });
});

describe("toPutBody", () => {
  it("sends the chain, the pack and Piece as null", () => {
    const d = draft(
      [
        row("Pack", "6", "Bottle", { price: "12", tiers: ["", "9", "", ""] }),
        row("Case", "4", "Pack"),
      ],
      { packLevel: "Case", newUnits: ["Case"] },
    );
    const b = toPutBody(d, { sendBase: false, sendCodes: false });
    expect(b.baseUnitLabel).toBe("Bottle");
    expect(b.packLevel).toBe("Case");
    expect(b.levels[0]).toMatchObject({
      label: "Pack",
      perParent: 6,
      parentLabel: null,
      price: 12,
      tiers: [null, 9, null, null],
      sortOrder: 0,
    });
    // the pack's price is the product's own, so the pack row carries none
    expect(b.levels[1]).toMatchObject({ label: "Case", perParent: 4, parentLabel: "Pack" });
    expect("price" in b.levels[1]).toBe(false);
    expect(b.newUnits).toEqual(["Case"]);
    expect("base" in b).toBe(false);
    expect("sku" in b.levels[0]).toBe(false);
  });
  it("Piece base is null", () => {
    expect(
      toPutBody({ ...draft([]), baseLabel: "" }, { sendBase: false, sendCodes: false })
        .baseUnitLabel,
    ).toBeNull();
  });
});

describe("removeRowAndDescendants", () => {
  it("drops the row and everything built on it", () => {
    const rows = [
      row("Pack", "6", "Bottle"),
      row("Case", "4", "Pack"),
      row("Pallet", "10", "Case"),
      row("Tray", "3", "Bottle"),
    ];
    expect(removeRowAndDescendants(rows, rows[0].key).map((r) => r.label)).toEqual(["Tray"]);
  });
});

describe("unitNameError", () => {
  it.each([
    ["  ", "Enter a name."],
    ["x".repeat(31), "Keep it to 30 characters or fewer."],
    [" case ", "You already have a unit called Case."],
    ["Crate", null],
  ])("%p", (name, expected) => {
    expect(unitNameError(name, ["Case"])).toBe(expected);
  });
});

describe("mapLadderError", () => {
  const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });
  it("maps the used-size 409 by status + exact text and offers a new unit", () => {
    const text =
      '"Pack" is already used on an order or invoice at a different size, so its size cannot change. Create a new unit instead.';
    expect(mapLadderError(err(409, { message: text }))).toEqual({
      rowLabel: "Pack",
      field: "perParent",
      message: text,
      offerNewUnit: true,
    });
  });
  it("maps a code clash and the lock timeout", () => {
    expect(
      mapLadderError(
        err(409, {
          code: "BARCODE_TAKEN",
          field: "barcode",
          level: "Pack",
          productName: "Gift Box",
        }),
      ).message,
    ).toBe(
      "That barcode is already on Gift Box. One barcode can only belong to one product. Use a different one, or change Gift Box first.",
    );
    expect(
      mapLadderError(
        err(409, { code: "CODE_TAKEN", field: "sku", productName: "Gift Box", inactive: true }),
      ).message,
    ).toBe(
      "That SKU is on Gift Box, which is turned off. Turn it back on to change it, or use a different SKU.",
    );
    expect(mapLadderError(err(503, {})).message).toBe(
      "Couldn't check that code right now. Your entry is still here. Try again.",
    );
  });
});
