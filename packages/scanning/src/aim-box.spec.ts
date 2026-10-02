import { isWithinAimBox, type AimBoxRect } from "./aim-box";

const AIM_BOX: AimBoxRect = { x: 100, y: 200, width: 200, height: 200 }; // center at (200, 300)

function boundsAt(cx: number, cy: number, width = 20, height = 20) {
  return { origin: { x: cx - width / 2, y: cy - height / 2 }, size: { width, height } };
}

describe("isWithinAimBox", () => {
  it("accepts a code whose center sits inside the box", () => {
    expect(isWithinAimBox(boundsAt(200, 300), AIM_BOX)).toBe(true);
  });

  it("accepts a code whose center sits exactly on the box's edge (inclusive)", () => {
    expect(isWithinAimBox(boundsAt(100, 300), AIM_BOX)).toBe(true); // left edge
    expect(isWithinAimBox(boundsAt(300, 300), AIM_BOX)).toBe(true); // right edge
    expect(isWithinAimBox(boundsAt(200, 200), AIM_BOX)).toBe(true); // top edge
    expect(isWithinAimBox(boundsAt(200, 400), AIM_BOX)).toBe(true); // bottom edge
  });

  it("rejects a code whose center sits just outside the box", () => {
    expect(isWithinAimBox(boundsAt(99, 300), AIM_BOX)).toBe(false);
    expect(isWithinAimBox(boundsAt(301, 300), AIM_BOX)).toBe(false);
    expect(isWithinAimBox(boundsAt(200, 199), AIM_BOX)).toBe(false);
    expect(isWithinAimBox(boundsAt(200, 401), AIM_BOX)).toBe(false);
  });

  it("uses the CENTER of bounds, not full containment — a box larger than the aim box still counts if centered", () => {
    // A code whose reported bounds is bigger than the whole aim box (undershoots per
    // expo-camera's own docs — "bounds doesn't have to bound the whole barcode" cuts both
    // ways) still passes as long as its center is inside.
    expect(isWithinAimBox(boundsAt(200, 300, 500, 500), AIM_BOX)).toBe(true);
  });

  it("fails open (accepts) when bounds is null or undefined", () => {
    expect(isWithinAimBox(null, AIM_BOX)).toBe(true);
    expect(isWithinAimBox(undefined, AIM_BOX)).toBe(true);
  });

  it("fails open when bounds is a degenerate (zero-size) rectangle", () => {
    expect(isWithinAimBox({ origin: { x: 0, y: 0 }, size: { width: 0, height: 0 } }, AIM_BOX)).toBe(
      true,
    );
    expect(
      isWithinAimBox({ origin: { x: 500, y: 500 }, size: { width: 0, height: 10 } }, AIM_BOX),
    ).toBe(true);
    expect(
      isWithinAimBox({ origin: { x: 500, y: 500 }, size: { width: 10, height: 0 } }, AIM_BOX),
    ).toBe(true);
  });

  it("fails open on a negative-size rectangle too (never crashes, never divides oddly)", () => {
    expect(
      isWithinAimBox({ origin: { x: 500, y: 500 }, size: { width: -10, height: 10 } }, AIM_BOX),
    ).toBe(true);
  });
});
