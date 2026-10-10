import { keepsHeldUnit } from "../orders/unit-label-norm";
import { resolveLineUnits } from "../products/line-units";
import {
  sellableLinesForMergeEdit,
  type EditItem,
  type ExistingLine,
  type LiveUnitsPerBox,
} from "./order-edit-lines";

/** A stored order line; override only what a case is about. */
const line = (over: Partial<ExistingLine> = {}): ExistingLine => ({
  id: "li-1",
  productId: "p1",
  qty: 5,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  status: "PENDING",
  ...over,
});

/** Payload items carry more than `EditItem` names (unitPrice, notes, …) — cast, don't widen. */
const items = (...list: Array<Record<string, unknown>>): EditItem[] => list as EditItem[];

const merge = (existing: ExistingLine[], payload: EditItem[], live?: LiveUnitsPerBox) =>
  sellableLinesForMergeEdit(existing, payload, { liveUnitsPerBox: live });

describe("sellableLinesForMergeEdit", () => {
  it("a NEW id-less line — even for a product already on the order (the service appends) — has no qtyDelta (always checked)", () => {
    expect(merge([line()], items({ productId: "p2", qty: 3 }))).toStrictEqual([
      { productId: "p2" },
    ]);
    expect(merge([line()], items({ productId: "p1", qty: 2 }))).toStrictEqual([
      { productId: "p1" },
    ]);
  });

  it("an INCREASE on an existing line carries the positive delta", () => {
    expect(merge([line()], items({ id: "li-1", action: "UPDATE", qty: 8 }))).toStrictEqual([
      { productId: "p1", qtyDelta: 3 },
    ]);
  });

  it("an EQUAL quantity carries delta 0 and a DECREASE a negative one (never checked downstream)", () => {
    expect(merge([line()], items({ id: "li-1", action: "UPDATE", qty: 5 }))).toStrictEqual([
      { productId: "p1", qtyDelta: 0 },
    ]);
    expect(merge([line()], items({ id: "li-1", action: "UPDATE", qty: 2 }))).toStrictEqual([
      { productId: "p1", qtyDelta: -3 },
    ]);
  });

  describe("removals", () => {
    it("CANCEL and DELETE that NAME a line emit nothing, whatever else they carry", () => {
      const existing = [line()];
      expect(merge(existing, items({ id: "li-1", action: "CANCEL" }))).toEqual([]);
      expect(merge(existing, items({ id: "li-1", action: "DELETE" }))).toEqual([]);
      expect(merge(existing, items({ id: "li-1", action: "CANCEL", qty: 99 }))).toEqual([]);
      expect(
        merge(existing, items({ id: "li-1", action: "DELETE", substituteProductId: "p9" })),
      ).toEqual([]);
    });

    it("BLOCKER: an id-LESS CANCEL / DELETE is an ADD in the service (the append runs before `action` is read) — it is checked", () => {
      for (const action of ["CANCEL", "DELETE"] as const) {
        expect(merge([], items({ productId: "p-banned", qty: 10, action }))).toStrictEqual([
          { productId: "p-banned" },
        ]);
        // the service's add predicate also accepts a box split in place of a quantity
        expect(merge([], items({ productId: "p-banned", boxes: 2, action }))).toStrictEqual([
          { productId: "p-banned" },
        ]);
      }
    });
  });

  it("a SUBSTITUTE is a product new to the order; the displaced product's quantity no longer matters", () => {
    expect(
      merge([line()], items({ id: "li-1", action: "UPDATE", substituteProductId: "p9", qty: 50 })),
    ).toStrictEqual([{ productId: "p9" }]);
  });

  it("an UNREADABLE qty (NaN, Infinity, a string) on an existing line is never 'no change' — checked (COORD: NaN stays checked); null is absent", () => {
    for (const qty of [Number.NaN, Number.POSITIVE_INFINITY, "5"])
      expect(merge([line()], items({ id: "li-1", qty }))).toStrictEqual([{ productId: "p1" }]);
    expect(merge([line()], items({ id: "li-1", qty: null, notes: "x" }))).toEqual([]);
  });

  it("a price / notes / reason-only edit (no quantity) emits nothing", () => {
    expect(
      merge([line()], items({ id: "li-1", action: "UPDATE", unitPrice: 9, notes: "chilled" })),
    ).toEqual([]);
    expect(merge([line()], items({ id: "li-1", overrideReason: "damaged" }))).toEqual([]);
  });

  it("an id line that also names a DIFFERENT product checks that product as new (and still sizes the existing line)", () => {
    expect(merge([line()], items({ id: "li-1", productId: "p2", qty: 5 }))).toStrictEqual([
      { productId: "p2" },
      { productId: "p1", qtyDelta: 0 },
    ]);
  });

  it("an id that matches no existing line emits nothing without a productId, a new line with one", () => {
    expect(merge([line()], items({ id: "ghost", qty: 3 }))).toEqual([]);
    expect(merge([line()], items({ id: "ghost", productId: "p2", qty: 3 }))).toStrictEqual([
      { productId: "p2" },
    ]);
  });

  it("an unlisted (catalog-free) line has no product to restrict", () => {
    expect(merge([line()], items({ name: "Delivery surcharge", qty: 1, unitPrice: 5 }))).toEqual(
      [],
    );
    const unlistedStored = line({ id: "li-u", productId: null, qty: 2 });
    expect(merge([unlistedStored], items({ id: "li-u", qty: 9 }))).toEqual([]);
  });

  it("a CANCELLED line contributes 0 goods — even a stale pre-F07 qty — so a qty edit on it is an increase from zero", () => {
    // The service never revives it (a harmless over-check); this pins the baseline: 0, not 24.
    const stale = line({ status: "CANCELLED", qty: 24 });
    expect(merge([stale], items({ id: "li-1", qty: 4 }))).toStrictEqual([
      { productId: "p1", qtyDelta: 4 },
    ]);
  });

  it("reads a Decimal-like stored qty (string and toNumber objects)", () => {
    for (const qty of ["5.000", { toNumber: () => 5 }]) {
      expect(merge([line({ qty })], items({ id: "li-1", qty: 8 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 3 },
      ]);
    }
  });

  it("an id-less line: a known quantity <= 0 is never written (not checked; the DTO refuses it too); NO quantity is unsized (checked)", () => {
    expect(merge([], items({ productId: "p2", qty: 0 }))).toEqual([]);
    expect(merge([], items({ productId: "p2" }))).toStrictEqual([{ productId: "p2" }]);
  });

  it("OVER-BLOCK class (documented, fail closed): lines are never netted — a repack and a grow-and-cancel are both checked", () => {
    const boxed = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    expect(
      merge([boxed], items({ id: "li-1", boxes: 1 }, { productId: "p1", qty: 12 })),
    ).toStrictEqual([{ productId: "p1", qtyDelta: -12 }, { productId: "p1" }]);
    const two = [line({ id: "a", qty: 10 }), line({ id: "b", qty: 5 })];
    expect(merge(two, items({ id: "a", qty: 12 }, { id: "b", action: "CANCEL" }))).toStrictEqual([
      { productId: "p1", qtyDelta: 2 },
    ]);
  });

  describe("boxed lines (boxes / pieces)", () => {
    const boxed = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });

    it("sizes a split from the line's snapshotted unitsPerBox: 3 boxes + 6 pieces = 42 vs 24", () => {
      expect(merge([boxed], items({ id: "li-1", boxes: 3, pieces: 6 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 18 },
      ]);
    });

    it("a split back to fewer boxes is a decrease", () => {
      expect(merge([boxed], items({ id: "li-1", boxes: 1, pieces: 0 }))).toStrictEqual([
        { productId: "p1", qtyDelta: -12 },
      ]);
    });

    it("the snapshot wins over the live product, as in the service (snapshot 12, live 24)", () => {
      const live = new Map([["p1", 24]]);
      expect(merge([boxed], items({ id: "li-1", boxes: 3 }), live)).toStrictEqual([
        { productId: "p1", qtyDelta: 12 }, // 36 - 24, not 72 - 24
      ]);
    });

    it("MAJOR (review): a null snapshot is sized by the LIVE product, never by arithmetic on the row — a re-packed product (12 → 24) is an increase", () => {
      const legacy = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: null });
      const live = new Map([["p1", 24]]);
      expect(merge([legacy], items({ id: "li-1", boxes: 2 }), live)).toStrictEqual([
        { productId: "p1", qtyDelta: 24 }, // the service writes 48; row arithmetic said 24 → 0
      ]);
      // an unchanged pack size is a plain echo
      expect(merge([legacy], items({ id: "li-1", boxes: 2 }), new Map([["p1", 12]]))).toStrictEqual(
        [{ productId: "p1", qtyDelta: 0 }],
      );
    });

    it("a split it cannot size (null snapshot, product not in the live map) is UNSIZED — checked, never guessed", () => {
      const legacy = line({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: null });
      expect(merge([legacy], items({ id: "li-1", boxes: 1 }))).toStrictEqual([{ productId: "p1" }]);
      expect(merge([legacy], items({ id: "li-1", boxes: 1 }), new Map())).toStrictEqual([
        { productId: "p1" },
      ]);
    });

    it("a split on a LOOSE product (snapshot 0 or 1, or live box size <= 1) is ignored by the service: `qty ?? stored`", () => {
      const plain = line({ qty: 5, unitsPerBox: 1 });
      expect(merge([plain], items({ id: "li-1", boxes: 9 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 0 },
      ]);
      // a snapshot of 0 is not "missing" (`?? null`): the service skips the live lookup
      expect(
        merge([line({ unitsPerBox: 0 })], items({ id: "li-1", boxes: 9 }), new Map([["p1", 12]])),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 0 }]);
      expect(merge([plain], items({ id: "li-1", boxes: 9, qty: 8 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 3 },
      ]);
      const unsnapshotted = line({ qty: 5 });
      expect(
        merge([unsnapshotted], items({ id: "li-1", pieces: 9 }), new Map([["p1", null]])),
      ).toStrictEqual([{ productId: "p1", qtyDelta: 0 }]);
    });

    it("MAJOR (review): a pieces-only REDUCTION of a box-unaware line is a decrease — its stored qty is cases, the split writes pieces", () => {
      const cases = line({ qty: 5, boxes: null, pieces: null, unitsPerBox: null });
      const live = new Map([["p1", 12]]);
      expect(merge([cases], items({ id: "li-1", pieces: 7 }), live)).toStrictEqual([
        { productId: "p1", qtyDelta: -53 }, // 7 pieces vs 5 cases = 60 pieces
      ]);
      expect(merge([cases], items({ id: "li-1", boxes: 5 }), live)).toStrictEqual([
        { productId: "p1", qtyDelta: 0 },
      ]);
      expect(merge([cases], items({ id: "li-1", boxes: 6 }), live)).toStrictEqual([
        { productId: "p1", qtyDelta: 12 },
      ]);
    });

    it("the split WINS over `qty` (normalizeBoxesPieces ignores it): a stale larger qty cannot trap a cut", () => {
      expect(merge([boxed], items({ id: "li-1", qty: 1, boxes: 5 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 36 }, // 60 - 24
      ]);
      expect(merge([boxed], items({ id: "li-1", qty: 100, boxes: 1 }))).toStrictEqual([
        { productId: "p1", qtyDelta: -12 }, // the service writes 12
      ]);
    });

    it("a zero boxes+pieces payload is 'not using box entry': the plain qty stands", () => {
      expect(merge([boxed], items({ id: "li-1", qty: 30, boxes: 0, pieces: 0 }))).toStrictEqual([
        { productId: "p1", qtyDelta: 6 },
      ]);
    });
  });
});

/**
 * #2275 / SA-408 — a units_v1 line stores PIECES (`qty`) and its unit's factor on the row
 * (`unitsPerBox`); an edit of it sends a COUNT of that unit in `qty`. Master compared the count to
 * the stored pieces (3 → 4 Cases of 12: 4 − 36 = −32), so an increase on a banned product passed as a
 * decrease. It is compared in pieces: incoming count × the HELD row's snapshot factor.
 */
describe("sellableLinesForMergeEdit — a unit line nets in PIECES at its held factor (#2275)", () => {
  const caseLine = (over: Partial<ExistingLine> = {}) =>
    line({ unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: 3, pieces: 0, ...over } as any);
  const count = (qty: number, unitLabel = "Case") => items({ id: "li-1", unitLabel, qty });

  it("3 → 4 Cases of a 12-pack is +12 pieces — an increase, so it is checked (master: −32 passed)", () => {
    expect(merge([caseLine()], count(4))).toEqual([{ productId: "p1", qtyDelta: 12 }]);
  });

  it("3 → 2 Cases is −12 pieces — a decrease, never checked downstream", () => {
    expect(merge([caseLine()], count(2))).toEqual([{ productId: "p1", qtyDelta: -12 }]);
  });

  it("an unchanged re-send after the Case is repacked 12 → 24 nets 0 (the held factor, not the live one)", () => {
    expect(merge([caseLine()], count(3), new Map([["p1", 24]]))).toEqual([
      { productId: "p1", qtyDelta: 0 },
    ]);
  });

  it("SA-408b: a held row with no usable snapshot factor is UNSIZED — checked, never sized by the live pack", () => {
    // The live pack is the PACK's size, not the Case's: 4 × 6 − 36 = −12 would pass an increase.
    expect(merge([caseLine({ unitsPerBox: null })], count(4), new Map([["p1", 6]]))).toEqual([
      { productId: "p1" },
    ]);
    expect(merge([caseLine({ unitsPerBox: 0 })], count(4), new Map([["p1", 12]]))).toEqual([
      { productId: "p1" },
    ]);
    expect(merge([caseLine({ unitsPerBox: null })], count(4))).toEqual([{ productId: "p1" }]);
  });

  it("SA-408b: the label compare uses THE one normaliser — 'case' and ' Case' are the held Case", () => {
    expect(merge([caseLine()], count(4, "case"))).toEqual([{ productId: "p1", qtyDelta: 12 }]);
    expect(merge([caseLine()], count(4, " Case "))).toEqual([{ productId: "p1", qtyDelta: 12 }]);
  });

  it("SA-408b: a PACK line's split still sizes from the live pack when its snapshot is null", () => {
    expect(
      merge(
        [line({ qty: 6, boxes: 1, pieces: 0, unitsPerBox: null })],
        items({ id: "li-1", boxes: 2, pieces: 0 }),
        new Map([["p1", 6]]),
      ),
    ).toEqual([{ productId: "p1", qtyDelta: 6 }]);
  });

  it("a DIFFERENT unit re-denominates the line (staff): its factor is not the held one — checked", () => {
    expect(merge([caseLine()], count(1, "Pallet"))).toEqual([{ productId: "p1" }]);
  });

  it("pack lines are unchanged: a bare qty on a plain line is still qty − stored", () => {
    expect(merge([line({ qty: 5 })], items({ id: "li-1", qty: 7 }))).toEqual([
      { productId: "p1", qtyDelta: 2 },
    ]);
  });
});

/**
 * #2288 / SA-447 — a HELD unit line whose incoming `unitLabel` is CLEARED (explicit null, "", or
 * blank) is re-denominated to the PACK by the write (`products/line-units.ts` resolveLineUnits: only
 * an ABSENT label, or the same one re-sent, keeps the held unit). The netting used to read
 * `item.unitLabel ?? ""` and net the count at the HELD factor, so the netting and the write disagreed
 * on pieces. A cleared label is a re-denomination: unsized, so the choke point checks the product in
 * full. An absent label keeps today's SA-408 netting; a pack line is untouched.
 */
describe("sellableLinesForMergeEdit — a cleared unitLabel on a held unit line re-denominates (#2288, SA-447)", () => {
  const caseLine = (over: Partial<ExistingLine> = {}) =>
    line({ unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: 3, pieces: 0, ...over } as any);

  it.each([
    ["null", null],
    ['""', ""],
    ["blank", "   "],
  ])(
    "SA-447: unitLabel %s on a held Case line is a re-denomination — unsized, checked",
    (_l, label) => {
      expect(merge([caseLine()], items({ id: "li-1", unitLabel: label, qty: 4 }))).toEqual([
        { productId: "p1" },
      ]);
    },
  );

  it("SA-447: a cleared label with no qty is still a re-denomination — checked", () => {
    expect(merge([caseLine()], items({ id: "li-1", unitLabel: null }))).toEqual([
      { productId: "p1" },
    ]);
  });

  it("SA-447: an ABSENT unitLabel keeps today's SA-408 netting (count × held factor)", () => {
    expect(merge([caseLine()], items({ id: "li-1", qty: 4 }))).toEqual([
      { productId: "p1", qtyDelta: 12 },
    ]);
  });

  it("SA-447: the SAME label (through norm) keeps the netting", () => {
    expect(merge([caseLine()], items({ id: "li-1", unitLabel: " case ", qty: 4 }))).toEqual([
      { productId: "p1", qtyDelta: 12 },
    ]);
  });

  it("SA-447: a DIFFERENT label on a held line is still a re-denomination — checked", () => {
    expect(merge([caseLine()], items({ id: "li-1", unitLabel: "Pallet", qty: 1 }))).toEqual([
      { productId: "p1" },
    ]);
  });

  it("SA-447: unitLabel null on a PACK line is untouched by this branch — qty − stored", () => {
    expect(merge([line({ qty: 5 })], items({ id: "li-1", unitLabel: null, qty: 7 }))).toEqual([
      { productId: "p1", qtyDelta: 2 },
    ]);
  });
});

/**
 * #2288 / SA-447 source pin: the netting reads `unitLabel` with the SAME three cases as the write's
 * resolveLineUnits — absent (undefined) = the held unit; the same label re-sent = the held unit;
 * explicit null / "" / blank = the pack. If either side changes its reading, this fails until the
 * other is changed with it.
 */
describe("#2288 / SA-447 / SA-070 — the netting and resolveLineUnits share ONE keep-held-unit rule", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("fs") as typeof import("fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require("path") as typeof import("path");

  // SA-070: ONE keep-held-unit rule (orders/unit-label-norm.ts keepsHeldUnit) drives both sides.
  // Behavioural: for every label case the write (resolveLineUnits) and the netting agree with it.
  const product = { unit: "Box", unitsPerBox: 6, pricePerUnit: "55.00" };
  const ladder = [
    {
      label: "Case",
      factorToBase: 12,
      price: "100.00",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
    },
    {
      label: "Pallet",
      factorToBase: 240,
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
    },
  ];
  const held = { unitLabel: "Case", unitsPerBox: 12 };
  it.each([
    ["absent", undefined, true],
    ["the same label", "Case", true],
    ["the same label through norm", " case ", true],
    ["null", null, false],
    ['""', "", false],
    ["blank", "   ", false],
    ["another unit", "Pallet", false],
  ] as const)(
    "SA-070: %s — keepsHeldUnit, the write and the netting agree",
    (_l, explicit, keeps) => {
      expect(keepsHeldUnit(explicit, "Case")).toBe(keeps);
      const written = resolveLineUnits(
        product,
        ladder,
        explicit === undefined ? {} : { unitLabel: explicit },
        held,
      );
      expect(written.unitLabel === "Case" && written.unitsPerBox === 12).toBe(keeps);
      const netted = merge(
        [line({ unitLabel: "Case", unitsPerBox: 12, qty: 36, boxes: 3, pieces: 0 } as any)],
        items({ id: "li-1", qty: 4, ...(explicit === undefined ? {} : { unitLabel: explicit }) }),
      );
      expect("qtyDelta" in netted[0]).toBe(keeps);
    },
  );

  it("SA-070: a line with no held unit keeps nothing", () => {
    expect(keepsHeldUnit(undefined, null)).toBe(false);
    expect(keepsHeldUnit("Case", "")).toBe(false);
  });

  // SA-447a: with the label ABSENT, a qty/price edit of a held unit line never reaches the netting
  // because updateOrderItems refuses it first (UNIT_AWARE_LINE). The real-PG pin relies on that
  // order; this fails if a later reorder puts the restriction check ahead of the label check.
  it("SA-447a: in updateOrderItems, assertUnitLabelNamed runs BEFORE assertLinesSellable", () => {
    const service = readFileSync(join(__dirname, "..", "orders", "orders.service.ts"), "utf8");
    const start = service.indexOf("  async updateOrderItems(");
    expect(start).toBeGreaterThan(-1);
    const rest = service.slice(start + 1);
    const nextMethod = rest.search(/\n  (?:async |private |public |protected )?[A-Za-z]+\(/);
    const body = nextMethod === -1 ? rest : rest.slice(0, nextMethod);
    const labelCheck = body.indexOf("assertUnitLabelNamed(");
    const restrictionCheck = body.indexOf("assertLinesSellable(");
    expect(labelCheck).toBeGreaterThan(-1);
    expect(restrictionCheck).toBeGreaterThan(-1);
    expect(labelCheck).toBeLessThan(restrictionCheck);
  });
});
