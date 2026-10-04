import { lineStockView } from "./line-stock";

const boxed = { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 };

describe("lineStockView", () => {
  it("never shows 0 while loading (availablePieces unknown)", () => {
    expect(lineStockView({ line: boxed, availablePieces: undefined, allowOversell: true })).toEqual(
      { state: "loading" },
    );
    expect(lineStockView({ line: boxed, availablePieces: 30, allowOversell: undefined })).toEqual({
      state: "loading",
    });
  });

  it("boxed: 30 pieces on hand of a 12-pack reads '2 cases left' + 6 units, in the line's unit", () => {
    const v = lineStockView({ line: boxed, availablePieces: 30, allowOversell: false });
    expect(v).toMatchObject({ state: "ready", level: "ok", label: "2 cases + 6 units left" });
  });

  it("matches the server number: server refuses when line pieces > currentStock (decrementStockForSale)", () => {
    // 3 cases = 36 pieces vs 30 on hand: the server would throw Insufficient stock.
    const over = lineStockView({
      line: { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      availablePieces: 30,
      allowOversell: false,
    });
    expect(over).toMatchObject({ level: "low", blocksSubmit: true });
    // exactly equal is accepted by the server (check is `currentStock < pieces`).
    const equal = lineStockView({
      line: { qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 },
      availablePieces: 30,
      allowOversell: false,
    });
    expect(equal).toMatchObject({ level: "ok", blocksSubmit: false, message: null });
  });

  it("whole cases read singular/plural", () => {
    expect(lineStockView({ line: boxed, availablePieces: 12, allowOversell: true })).toMatchObject({
      label: "1 case left",
    });
    expect(lineStockView({ line: boxed, availablePieces: 24, allowOversell: true })).toMatchObject({
      label: "2 cases left",
    });
  });

  it("unit-mode line on a boxed product counts in units", () => {
    const v = lineStockView({
      line: { qty: 5, boxes: 0, pieces: 5, unitsPerBox: 12 },
      availablePieces: 30,
      allowOversell: true,
      sellByUnit: true,
    });
    expect(v).toMatchObject({ label: "30 units left", level: "ok" });
  });

  it("plain (non-boxed) line uses the product unit", () => {
    expect(
      lineStockView({ line: { qty: 3 }, availablePieces: 12, allowOversell: true, unit: "bag" }),
    ).toMatchObject({ label: "12 bag left" });
  });

  it("amber when the order qty exceeds stock, red at 0 (and at negative stock, shown as 0)", () => {
    expect(
      lineStockView({ line: { qty: 5 }, availablePieces: 4, allowOversell: true }),
    ).toMatchObject({ level: "low" });
    expect(
      lineStockView({ line: { qty: 1 }, availablePieces: 0, allowOversell: true }),
    ).toMatchObject({ level: "out", label: "0 left" });
    expect(
      lineStockView({ line: { qty: 1 }, availablePieces: -3, allowOversell: true }),
    ).toMatchObject({ level: "out", label: "0 left" });
    expect(
      lineStockView({ line: { qty: 4 }, availablePieces: 4, allowOversell: true }),
    ).toMatchObject({ level: "ok" });
  });

  it("policy blocks: fixed 'reduce or remove' copy and blocksSubmit", () => {
    const v = lineStockView({
      line: { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      availablePieces: 24,
      allowOversell: false,
    });
    expect(v).toMatchObject({
      level: "low",
      blocksSubmit: true,
      message: "Only 2 cases left — reduce or remove",
    });
  });

  it("policy allows: soft note, never blocks", () => {
    const v = lineStockView({
      line: { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      availablePieces: 24,
      allowOversell: true,
    });
    expect(v).toMatchObject({
      level: "low",
      blocksSubmit: false,
      message: "Only 2 cases left — this order will go below stock",
    });
  });

  it("edit mode: only the increase over the saved line counts (mirrors settleStockForEdit delta)", () => {
    // saved 24 pcs, still 24 pcs, stock 0 -> delta 0 -> not over, not blocked.
    const untouched = lineStockView({
      line: boxed,
      availablePieces: 0,
      allowOversell: false,
      savedPieces: 24,
    });
    expect(untouched).toMatchObject({ level: "out", blocksSubmit: false, message: null });
    // raised to 36 with 6 left -> delta 12 > 6 -> over.
    const raised = lineStockView({
      line: { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      availablePieces: 6,
      allowOversell: false,
      savedPieces: 24,
    });
    expect(raised).toMatchObject({ level: "low", blocksSubmit: true });
  });
});
