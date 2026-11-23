import { billLineLocked, billLineUnit } from "./bill-line-unit";
import { linePack } from "./pricing";

describe("billLineUnit (SA-1207 S2b spec 4)", () => {
  it.each([
    [{ packSize: 24 }, "case", 24, null],
    [{ packSize: 24, unitLabel: null }, "case", 24, null],
    [{ packSize: 7, unitLabel: "7 Pieces" }, "lot", 7, "7 Pieces"],
    [{ packSize: null, unitLabel: "1 Piece" }, "piece", 1, "1 Piece"],
    [{ packSize: 1, unitLabel: "1 Piece" }, "piece", 1, "1 Piece"],
    [{ packSize: null }, "unstated", 1, null],
    [{ packSize: 0 }, "unstated", 1, null],
    [{ packSize: 1 }, "unstated", 1, null],
    [{ packSize: 12, unitLabel: "  " }, "case", 12, null],
    [{ packSize: "6", unitLabel: "6 Pieces" }, "lot", 6, "6 Pieces"],
  ])("%j is a %s of %d", (item, kind, factor, label) => {
    expect(billLineUnit(item)).toMatchObject({ kind, factor, label });
  });

  it("a stated piece is stated, never unknown", () => {
    expect(billLineUnit({ unitLabel: "1 Piece" }).stated).toBe(true);
    expect(billLineUnit({ packSize: 1 }).stated).toBe(false);
  });

  it("only a lot or a group child is locked", () => {
    expect(billLineLocked({ packSize: 7, unitLabel: "7 Pieces" })).toBe(true);
    expect(billLineLocked({ packSize: 6, unitLabel: null, familyGroupId: "g" })).toBe(true);
    expect(billLineLocked({ packSize: 6 })).toBe(false);
    expect(billLineLocked({ unitLabel: "1 Piece" })).toBe(false);
  });

  it("linePack reads through it: a stated lot's own pack wins over the live pack", () => {
    expect(linePack({ packSize: 7, unitLabel: "7 Pieces" }, 24)).toBe(7);
    expect(linePack({ packSize: null }, 24)).toBe(24);
    expect(linePack({ packSize: 1 }, 24)).toBe(24);
  });
});
