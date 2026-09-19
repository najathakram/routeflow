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

  it("a missing/corrupt snapshot is RECOVERED from the ladder by label (never from the pack)", () => {
    for (const bad of [null, undefined, 0, -3, Number.NaN]) {
      expect(
        resolveLineUnits(boxed, [caseRow], undefined, { unitLabel: "Case", unitsPerBox: bad }),
      ).toEqual({ unitsPerBox: 288, unitLabel: "Case", kind: "level" });
    }
  });

  it("no snapshot AND no ladder row for the label: refused (409), never guessed from the pack", () => {
    expect(() =>
      resolveLineUnits(boxed, [], undefined, { unitLabel: "Case", unitsPerBox: null }),
    ).toThrow(ConflictException);
    // The pack's own label as a held label resolves to the pack (factor unknown here): also refused.
    expect(() =>
      resolveLineUnits(boxed, [], undefined, { unitLabel: "Box", unitsPerBox: null }),
    ).toThrow(ConflictException);
  });

  it("requested.unitLabel undefined = unchanged; null or blank = an explicit switch back to the pack", () => {
    expect(resolveLineUnits(boxed, [caseRow], undefined, caseLine).unitLabel).toBe("Case");
    for (const clear of [null, "", "  "]) {
      expect(resolveLineUnits(boxed, [caseRow], { unitLabel: clear }, caseLine)).toEqual({
        unitsPerBox: 24,
        unitLabel: null,
        kind: "pack",
      });
    }
  });

  it("kind follows the label: a Case line whose snapshot is 1 is still a level, a Piece line is a piece", () => {
    expect(
      resolveLineUnits(boxed, [caseRow], undefined, { unitLabel: "Case", unitsPerBox: 1 }).kind,
    ).toBe("piece"); // factor 1 == a single piece whatever it is called
    expect(
      resolveLineUnits(boxed, [], undefined, { unitLabel: "Piece", unitsPerBox: 1 }).kind,
    ).toBe("piece");
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

describe("lineUnitsPerBoxSnapshot — pinned against the real persisted expressions", () => {
  // The two site rules today: orders.service.ts `boxes != null && upb > 1 ? upb : null`,
  // invoices.service.ts:1011/2419 `upb > 0 ? upb : null`.
  const orderRule = (boxes: number | null, upb: number) => (boxes != null && upb > 1 ? upb : null);
  const positiveRule = (upb: number) => (upb > 0 ? upb : null);

  it("a unit-aware line ALWAYS snapshots its factor, including 1", () => {
    expect(
      lineUnitsPerBoxSnapshot({ unitsPerBox: 1, unitLabel: "Piece", kind: "piece" }, null),
    ).toBe(1);
    expect(lineUnitsPerBoxSnapshot({ unitsPerBox: 288, unitLabel: "Case", kind: "level" }, 2)).toBe(
      288,
    );
    expect(
      lineUnitsPerBoxSnapshot(
        { unitsPerBox: 1, unitLabel: "Piece", kind: "piece" },
        null,
        "positive",
      ),
    ).toBe(1);
  });

  it.each([0, 1, 2, 24])(
    '"boxed" equals the orders rule for a pack line, upb=%i, boxes null/0/3',
    (upb) => {
      for (const boxes of [null, 0, 3]) {
        const pack = { unitsPerBox: upb, unitLabel: null, kind: "pack" as const };
        expect(lineUnitsPerBoxSnapshot(pack, boxes)).toBe(orderRule(boxes, upb));
      }
    },
  );

  it.each([0, 1, 2, 24])(
    '"positive" equals the invoice copy rule for a pack line, upb=%i (boxes ignored)',
    (upb) => {
      for (const boxes of [null, 3]) {
        const pack = { unitsPerBox: upb, unitLabel: null, kind: "pack" as const };
        expect(lineUnitsPerBoxSnapshot(pack, boxes, "positive")).toBe(positiveRule(upb));
      }
    },
  );
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

  it("the 4x bug this design prevents: a rewrite of a Case line after the pack was resized still bills 980, not 1200", () => {
    const caseLine = { unitLabel: "Case", unitsPerBox: 288 };
    const resized = { ...boxed, unitsPerBox: 24 };
    const bill = (upb: number) =>
      computeLineSubtotal({ unitPrice: 480, qty: 588, boxes: 2, pieces: 12, unitsPerBox: upb });
    // Through the helper: the line's own snapshot (288) drives the price.
    expect(bill(resolveLineUnits(resized, [caseRow], undefined, caseLine).unitsPerBox)).toBe(980);
    // What every site did before (re-read the live pack) prices the same line wrong.
    expect(bill(Number(resized.unitsPerBox))).toBe(1200); // 2 x 480 + 12 x (480 / 24)
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
