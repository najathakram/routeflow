import { readFileSync } from "fs";
import { join } from "path";
import { AIM_BOX_FRACTION, aimBoxInVideoPixels, boundsFromResultPoints } from "./scan-aim";

/**
 * The web phone scanner's aim box (owner ruling 2026-09-24): the SAME centered box the camera strip already DRAWS
 * (`h-3/5 w-5/6`), expressed in the VIDEO's pixel space so it can be compared with zxing's result points. The preview is
 * `object-cover`, so what the operator sees is a cropped, scaled window of the frame: the mapping has to undo that.
 */
describe("AIM_BOX_FRACTION is the drawn box (w-5/6, h-3/5)", () => {
  it("matches the overlay's classes", () => {
    expect(AIM_BOX_FRACTION).toEqual({ width: 5 / 6, height: 3 / 5 });
  });
  it("ScanOrderScreen DRAWS that same box (the visible overlay and the enforced rect share the fractions)", () => {
    const src = readFileSync(
      join(__dirname, "../app/(dashboard)/orders/_components/scan/ScanOrderScreen.tsx"),
      "utf8",
    );
    expect(src).toMatch(/h-3\/5 w-5\/6 rounded border-2/);
  });
});

describe("aimBoxInVideoPixels (object-cover mapping)", () => {
  it("same aspect: the box is the centered fraction of the frame", () => {
    const r = aimBoxInVideoPixels({
      videoWidth: 1200,
      videoHeight: 600,
      clientWidth: 600,
      clientHeight: 300,
    });
    expect(r).toEqual({ x: 100, y: 120, width: 1000, height: 360 });
  });
  it("wide frame in a short strip: the sides are cropped, so the box is narrower than 5/6 of the frame", () => {
    // 1280x720 frame shown at 390x144 (strip): scale = max(390/1280, 144/720) = 0.3047; visible = 390/0.3047 = 1280 wide, 472 tall
    const r = aimBoxInVideoPixels({
      videoWidth: 1280,
      videoHeight: 720,
      clientWidth: 390,
      clientHeight: 144,
    })!;
    const scale = Math.max(390 / 1280, 144 / 720);
    const visW = 390 / scale;
    const visH = 144 / scale;
    expect(r.width).toBeCloseTo(visW * (5 / 6), 5);
    expect(r.height).toBeCloseTo(visH * (3 / 5), 5);
    expect(r.x + r.width / 2).toBeCloseTo(640, 5); // centered
    expect(r.y + r.height / 2).toBeCloseTo(360, 5);
  });
  it("fails OPEN (null = no aim-box filtering) when the video has no size yet", () => {
    expect(
      aimBoxInVideoPixels({ videoWidth: 0, videoHeight: 0, clientWidth: 390, clientHeight: 144 }),
    ).toBeNull();
    expect(
      aimBoxInVideoPixels({ videoWidth: 1280, videoHeight: 720, clientWidth: 0, clientHeight: 0 }),
    ).toBeNull();
  });
});

describe("boundsFromResultPoints", () => {
  const pt = (x: number, y: number) => ({ getX: () => x, getY: () => y });
  it("is the bounding box of the points", () => {
    expect(boundsFromResultPoints([pt(10, 40), pt(50, 20), pt(30, 60)])).toEqual({
      origin: { x: 10, y: 20 },
      size: { width: 40, height: 40 },
    });
  });
  it("is undefined (fail open) for no points", () => {
    expect(boundsFromResultPoints([])).toBeUndefined();
    expect(boundsFromResultPoints(undefined)).toBeUndefined();
    expect(boundsFromResultPoints(null)).toBeUndefined();
  });
  it("a 1D code (points on ONE scan line, zero height) still gets a non-degenerate rect centred on the line", () => {
    const b = boundsFromResultPoints([pt(10, 50), pt(50, 50)])!;
    expect(b.size.width).toBe(40);
    expect(b.size.height).toBe(1); // never 0: the shared check would read 0 as "no geometry" and accept anywhere
    expect(b.origin.y + b.size.height / 2).toBe(50);
    expect(b.origin.x + b.size.width / 2).toBe(30);
  });
});
