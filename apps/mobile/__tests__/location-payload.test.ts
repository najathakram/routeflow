/**
 * B185 (F25-location) — red set for the `buildLocationPayload` seam.
 * REG-B185: today's inline payload construction (`heading: coords.heading ?? null`,
 * `speedKph: coords.speed != null ? coords.speed * 3.6 : null`, no `accuracy` field
 * at all) is copied verbatim into this seam by the build phase, so these tests must
 * fail against that verbatim body — the platform sentinel `-1` for heading/speed
 * passes straight through instead of mapping to `null`, and `accuracy` is silently
 * dropped regardless of value.
 */
import { buildLocationPayload } from "../lib/location-payload";

describe("buildLocationPayload", () => {
  it("REG-B185 maps iOS heading/speed sentinels to null", () => {
    const payload = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: -1, speed: -1 },
      "2026-09-04T00:00:00.000Z",
    );
    // Asserted as one pair so BOTH of today's wrong values surface in the
    // failure diff (heading -1, speedKph -3.6) instead of only the first.
    expect({ heading: payload.heading, speedKph: payload.speedKph }).toEqual({
      heading: null,
      speedKph: null,
    });
  });

  it("passes a valid heading through and converts speed from m/s to km/h", () => {
    const moving = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 90, speed: 10 },
      "2026-09-04T00:00:00.000Z",
    );
    expect({ heading: moving.heading, speedKph: moving.speedKph }).toEqual({
      heading: 90,
      speedKph: 36,
    });

    const stationary = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 0, speed: 0 },
      "2026-09-04T00:00:00.000Z",
    );
    expect({ heading: stationary.heading, speedKph: stationary.speedKph }).toEqual({
      heading: 0,
      speedKph: 0,
    });
  });

  it("REG-B185 passes a valid accuracy through", () => {
    const payload = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, accuracy: 4.5 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(payload.accuracy).toBe(4.5);
  });

  // Pin — deliberately NOT REG-tagged, so it sits outside the red gate. A
  // negative `accuracy` must never reach the payload; that holds today for the
  // wrong reason (the verbatim body has no `accuracy` field at all) and after
  // the fix for the right one (the sentinel is rejected). It therefore cannot
  // go red pre-fix, and it guards against a fix that keeps the sentinel.
  it("omits a negative accuracy", () => {
    const payload = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, accuracy: -1 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(payload.accuracy).toBeUndefined();
  });

  it("REG-B185 omits an accuracy above the DTO's @Max(99999.99) bound", () => {
    const payload = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, accuracy: 1e6 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(payload.accuracy).toBeUndefined();
  });

  it("REG-B185 clamps an implausible heading to null but passes 360 through", () => {
    const tooHigh = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 361 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(tooHigh.heading).toBeNull();

    const atBoundary = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 360 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(atBoundary.heading).toBe(360);
  });

  it("omits an implausible speed instead of failing the ping", () => {
    const implausible = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 45, speed: 200 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(implausible.speedKph).toBeNull();
    expect(implausible.heading).toBe(45);

    const plausible = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, speed: 138 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(plausible.speedKph).toBeCloseTo(496.8, 6);
  });

  it("REG-B185 clears the MAX_SPEED_KPH boundary exactly at the DTO's @Max(500)", () => {
    const atBoundary = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 10, speed: 500 / 3.6 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(atBoundary.speedKph).toBeCloseTo(500, 9);
    expect(atBoundary.heading).toBe(10);

    const justAboveBoundary = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 10, speed: 500 / 3.6 + 0.01 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(justAboveBoundary.speedKph).toBeNull();
    expect(justAboveBoundary.heading).toBe(10);
  });

  it("REG-B185 maps non-finite speeds to null without disturbing heading/accuracy", () => {
    const infiniteSpeed = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 20, speed: Infinity, accuracy: 3 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(infiniteSpeed.speedKph).toBeNull();
    expect(infiniteSpeed.heading).toBe(20);
    expect(infiniteSpeed.accuracy).toBe(3);

    const nanSpeed = buildLocationPayload(
      { latitude: 34.05, longitude: -118.24, heading: 20, speed: NaN, accuracy: 3 },
      "2026-09-04T00:00:00.000Z",
    );
    expect(nanSpeed.speedKph).toBeNull();
    expect(nanSpeed.heading).toBe(20);
    expect(nanSpeed.accuracy).toBe(3);
  });
});
