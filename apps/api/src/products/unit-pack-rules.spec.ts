import { ConflictException } from "@nestjs/common";
import { assertPackKeepsLevelsValid } from "./unit-pack-rules";

const levels = [
  { label: "Case", factorToBase: 288 },
  { label: "Pallet", factorToBase: 5760 },
];

describe("assertPackKeepsLevelsValid", () => {
  it("passes when the product has no levels, whatever the pack becomes", () => {
    expect(() =>
      assertPackKeepsLevelsValid([], { unit: "Case", unitsPerBox: 288, regulated: true }),
    ).not.toThrow();
  });

  it("passes an unrelated pack edit", () => {
    expect(() =>
      assertPackKeepsLevelsValid(levels, { unit: "Box", unitsPerBox: 24, regulated: false }),
    ).not.toThrow();
  });

  it("refuses renaming the pack onto a level label (case-insensitive) — it would re-price new lines at the pack factor", () => {
    expect(() =>
      assertPackKeepsLevelsValid(levels, { unit: " case ", unitsPerBox: 24, regulated: false }),
    ).toThrow(ConflictException);
  });

  it("refuses resizing the pack onto a level factor", () => {
    expect(() =>
      assertPackKeepsLevelsValid(levels, { unit: "Box", unitsPerBox: 288, regulated: false }),
    ).toThrow(ConflictException);
  });

  it("a pack with no size (factor 1) collides with a Piece level", () => {
    expect(() =>
      assertPackKeepsLevelsValid([{ label: "Piece", factorToBase: 1 }], {
        unit: "Each",
        unitsPerBox: null,
        regulated: false,
      }),
    ).toThrow(ConflictException);
  });

  it("refuses moving a product that already has an above-pack level into a regulated section", () => {
    expect(() =>
      assertPackKeepsLevelsValid(levels, { unit: "Box", unitsPerBox: 24, regulated: true }),
    ).toThrow(ConflictException);
  });

  it("allows a regulated product whose levels are all at or below the pack", () => {
    expect(() =>
      assertPackKeepsLevelsValid([{ label: "Piece", factorToBase: 1 }], {
        unit: "Box",
        unitsPerBox: 24,
        regulated: true,
      }),
    ).not.toThrow();
  });

  it("a blank pack name is treated as the Box default, like the ladder", () => {
    expect(() =>
      assertPackKeepsLevelsValid([{ label: "box", factorToBase: 6 }], {
        unit: "",
        unitsPerBox: 24,
        regulated: false,
      }),
    ).toThrow(ConflictException);
  });
});
