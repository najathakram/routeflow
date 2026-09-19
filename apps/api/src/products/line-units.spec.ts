import { BadRequestException, ConflictException } from "@nestjs/common";
import { normalizeBoxesPieces, computeLineSubtotal, type LadderUnit } from "@routeflow/pricing";
import { lineUnitsPerBoxSnapshot, resolveLineUnits } from "./line-units";

const none = {
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const caseRow: LadderUnit = { ...none, label: "Case", factorToBase: 288, price: 480 };
const pieceRow: LadderUnit = { ...none, label: "Piece", factorToBase: 1, price: 2 };
const boxed = { unit: "Box", unitsPerBox: 24, pricePerUnit: 42 };

describe("resolveLineUnits — pack behaviour is today's, byte for byte", () => {
  it.each([
    ["boxed", { ...boxed }, 24],
    ["single-piece pack", { ...boxed, unitsPerBox: 1 }, 1],
    ["no pack size (null)", { ...boxed, unitsPerBox: null }, 0],
    ["no pack size (undefined)", { unit: "Each", pricePerUnit: 3 }, 0],
  ])("%s: no label -> Number(product.unitsPerBox ?? 0), no unitLabel persisted", (_n, p, want) => {
    const r = resolveLineUnits(p, [caseRow], undefined);
    expect(r).toEqual({ unitsPerBox: want, unitLabel: null, kind: "pack" });
    expect(r.unitsPerBox).toBe(Number((p as { unitsPerBox?: number | null }).unitsPerBox ?? 0));
  });

  it("naming the pack's own label is still a plain pack line (label null)", () => {
    expect(resolveLineUnits(boxed, [], { unitLabel: " box " })).toEqual({
      unitsPerBox: 24,
      unitLabel: null,
      kind: "pack",
    });
  });

  it("'Piece' on a product with no pack size is not a unit-aware line", () => {
    expect(resolveLineUnits({ unit: "Each", pricePerUnit: 3 }, [], { unitLabel: "Piece" })).toEqual(
      {
        unitsPerBox: 0,
        unitLabel: null,
        kind: "pack",
      },
    );
  });
});

describe("resolveLineUnits — the factor comes from the SERVER ladder", () => {
  it("a level label resolves to that level's factor and is persisted", () => {
    expect(resolveLineUnits(boxed, [caseRow], { unitLabel: "Case" })).toEqual({
      unitsPerBox: 288,
      unitLabel: "Case",
      kind: "level",
    });
  });

  it("Piece on a boxed product is factor 1, labelled Piece", () => {
    expect(resolveLineUnits(boxed, [], { unitLabel: "piece" })).toEqual({
      unitsPerBox: 1,
      unitLabel: "Piece",
      kind: "piece",
    });
    expect(resolveLineUnits(boxed, [pieceRow], { unitLabel: "Piece" }).unitsPerBox).toBe(1);
  });

  it("an unknown label is a 400 — the client can never invent a unit or a factor", () => {
    expect(() => resolveLineUnits(boxed, [caseRow], { unitLabel: "Truckload" })).toThrow(
      BadRequestException,
    );
  });

  it("a corrupt ladder row is invisible (factor 0 / negative), so its label is a 400 too", () => {
    const bad: LadderUnit = { ...none, label: "Bad", factorToBase: 0 };
    expect(() => resolveLineUnits(boxed, [bad], { unitLabel: "Bad" })).toThrow(BadRequestException);
  });
});

describe("resolveLineUnits — a rewrite keeps the LINE's snapshot, never the live product", () => {
  const caseLine = { unitLabel: "Case", unitsPerBox: 288 };

  it("no requested label: the existing snapshot factor wins even if the pack was resized since", () => {
    const resizedPack = { ...boxed, unitsPerBox: 12 };
    expect(resolveLineUnits(resizedPack, [caseRow], undefined, caseLine)).toEqual({
      unitsPerBox: 288,
      unitLabel: "Case",
      kind: "level",
    });
  });

  it("the ladder row was DELETED or its factor changed after the sale: the snapshot still wins", () => {
    expect(resolveLineUnits(boxed, [], undefined, caseLine).unitsPerBox).toBe(288);
    expect(
      resolveLineUnits(boxed, [{ ...caseRow, factorToBase: 300 }], { unitLabel: "case" }, caseLine)
        .unitsPerBox,
    ).toBe(288);
  });

  it("the same label re-sent (any casing) keeps the snapshot; a DIFFERENT label re-resolves from the ladder", () => {
    expect(resolveLineUnits(boxed, [caseRow], { unitLabel: "CASE" }, caseLine).unitsPerBox).toBe(
      288,
    );
    expect(resolveLineUnits(boxed, [caseRow], { unitLabel: "Piece" }, caseLine)).toMatchObject({
      unitsPerBox: 1,
      unitLabel: "Piece",
    });
  });

  it("a Piece line on a boxed product keeps factor 1 (a re-derive would give the pack's 24)", () => {
    expect(resolveLineUnits(boxed, [], undefined, { unitLabel: "Piece", unitsPerBox: 1 })).toEqual({
      unitsPerBox: 1,
      unitLabel: "Piece",
      kind: "piece",
    });
  });

  it("a unit-aware line with no usable snapshot is refused (409), never guessed from the pack", () => {
    for (const bad of [null, undefined, 0, -3, "x"]) {
      expect(() =>
        resolveLineUnits(boxed, [caseRow], undefined, {
          unitLabel: "Case",
          unitsPerBox: bad as never,
        }),
      ).toThrow(ConflictException);
    }
  });

  it("an existing PACK line (no label) rewrites exactly like a new pack line", () => {
    expect(
      resolveLineUnits(boxed, [caseRow], undefined, { unitLabel: null, unitsPerBox: 24 }),
    ).toEqual({
      unitsPerBox: 24,
      unitLabel: null,
      kind: "pack",
    });
  });
});

describe("lineUnitsPerBoxSnapshot", () => {
  it("a unit-aware line ALWAYS snapshots its factor, including 1", () => {
    expect(
      lineUnitsPerBoxSnapshot({ unitsPerBox: 1, unitLabel: "Piece", kind: "piece" }, null),
    ).toBe(1);
    expect(lineUnitsPerBoxSnapshot({ unitsPerBox: 288, unitLabel: "Case", kind: "level" }, 2)).toBe(
      288,
    );
  });

  it("a pack line keeps today's rule: only a box-split line over a real pack snapshots", () => {
    const pack = { unitsPerBox: 24, unitLabel: null, kind: "pack" as const };
    expect(lineUnitsPerBoxSnapshot(pack, 3)).toBe(24);
    expect(lineUnitsPerBoxSnapshot(pack, null)).toBeNull();
    expect(lineUnitsPerBoxSnapshot({ ...pack, unitsPerBox: 1 }, 3)).toBeNull();
    expect(lineUnitsPerBoxSnapshot({ ...pack, unitsPerBox: 0 }, 3)).toBeNull();
  });
});

describe("money seam: the relabelled triple prices correctly through the EXISTING pricing helpers", () => {
  it("2 cases + 12 pieces at 480/case: whole cases bill 960, loose pieces prorate off the CASE factor (288)", () => {
    const u = resolveLineUnits(boxed, [caseRow], { unitLabel: "Case" });
    const split = normalizeBoxesPieces({ boxes: 2, pieces: 12, unitsPerBox: u.unitsPerBox });
    expect(split).toEqual({ boxes: 2, pieces: 12, qty: 588 });
    const sub = computeLineSubtotal({
      unitPrice: 480,
      qty: split.qty,
      boxes: split.boxes,
      pieces: split.pieces,
      unitsPerBox: u.unitsPerBox,
    });
    expect(sub).toBe(980); // 2 x 480 + 12 x (480 / 288)
  });

  it("the 4x bug this whole design prevents: re-deriving the pack factor (24) bills 1200 instead of 980", () => {
    const wrong = computeLineSubtotal({
      unitPrice: 480,
      qty: 588,
      boxes: 2,
      pieces: 12,
      unitsPerBox: 24,
    });
    expect(wrong).toBe(1200); // 2 x 480 + 12 x (480 / 24)
  });

  it("a Piece line on a boxed product is qty x piece price (no proration, boxes/pieces null)", () => {
    const u = resolveLineUnits(boxed, [], { unitLabel: "Piece" });
    const split = normalizeBoxesPieces({ qty: 30, unitsPerBox: u.unitsPerBox });
    expect(split).toEqual({ boxes: null, pieces: null, qty: 30 });
    expect(
      computeLineSubtotal({
        unitPrice: 1.75,
        qty: 30,
        boxes: null,
        pieces: null,
        unitsPerBox: u.unitsPerBox,
      }),
    ).toBe(52.5);
  });
});
