/**
 * Locks the "Open in Google Maps" deep-link builder used by the driver route
 * screen: sequential directions links chunked at Google Maps' 9-waypoint
 * mobile-app limit, with each leg handing off at the previous leg's
 * destination so stop order survives across links.
 */
import { buildGoogleMapsLegs, type GmapsPoint } from "../lib/gmaps-export";

function point(lat: number, lng: number): GmapsPoint {
  return { lat, lng };
}

describe("buildGoogleMapsLegs", () => {
  it("returns nothing for fewer than 2 points", () => {
    expect(buildGoogleMapsLegs([])).toEqual([]);
    expect(buildGoogleMapsLegs([point(40.7128, -74.006)])).toEqual([]);
  });

  it("2 points build a single link with no waypoints param", () => {
    const legs = buildGoogleMapsLegs([point(40.7128, -74.006), point(40.73061, -73.935242)]);

    expect(legs).toHaveLength(1);
    expect(legs[0]!.label).toBe("Open in Google Maps");
    expect(legs[0]!.url).not.toContain("waypoints=");
  });

  it("url starts with the Google Maps directions deep-link prefix", () => {
    const legs = buildGoogleMapsLegs([point(40.7128, -74.006), point(40.73061, -73.935242)]);

    expect(legs[0]!.url.startsWith("https://www.google.com/maps/dir/?api=1")).toBe(true);
  });

  it("formats coordinates to 6 decimal places", () => {
    const legs = buildGoogleMapsLegs([point(40.712776, -74.0059731), point(40.73061, -73.935242)]);

    const url = new URL(legs[0]!.url);
    expect(url.searchParams.get("origin")).toBe("40.712776,-74.005973");
    expect(url.searchParams.get("destination")).toBe("40.730610,-73.935242");
  });

  it("a middle stop is carried as a waypoint", () => {
    const legs = buildGoogleMapsLegs([
      point(40.7128, -74.006),
      point(40.72, -74.0),
      point(40.73061, -73.935242),
    ]);

    expect(legs).toHaveLength(1);
    const url = new URL(legs[0]!.url);
    expect(url.searchParams.get("waypoints")).toBe("40.720000,-74.000000");
  });

  it("12 points chunk into 2 legs, with leg 2's origin equal to leg 1's destination", () => {
    const points: GmapsPoint[] = Array.from({ length: 12 }, (_, i) =>
      point(40 + i * 0.01, -74 - i * 0.01),
    );

    const legs = buildGoogleMapsLegs(points);

    expect(legs).toHaveLength(2);
    expect(legs[0]!.label).toBe("Leg 1");
    expect(legs[1]!.label).toBe("Leg 2");

    const leg1 = new URL(legs[0]!.url);
    const leg2 = new URL(legs[1]!.url);
    expect(leg1.searchParams.get("destination")).toBe(leg2.searchParams.get("origin"));

    // Leg 1 covers origin + 9 waypoints + destination (indices 0-10); leg 2
    // is the handoff point through the final stop (indices 10-11).
    expect(leg1.searchParams.get("origin")).toBe("40.000000,-74.000000");
    expect(leg1.searchParams.get("destination")).toBe("40.100000,-74.100000");
    expect(leg2.searchParams.get("destination")).toBe("40.110000,-74.110000");
  });

  it("every leg's url starts with the Google Maps directions deep-link prefix", () => {
    const points: GmapsPoint[] = Array.from({ length: 12 }, (_, i) =>
      point(40 + i * 0.01, -74 - i * 0.01),
    );

    for (const leg of buildGoogleMapsLegs(points)) {
      expect(leg.url.startsWith("https://www.google.com/maps/dir/?api=1")).toBe(true);
    }
  });
});
