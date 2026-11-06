import { readFileSync } from "fs";
import { join } from "path";

/**
 * W1 (COPY 2s): a customer the geocoder could not place reads as something the admin can fix. A tenant cannot set a
 * server key, so the old line ("Set GOOGLE_MAPS_API_KEY to auto-geocode") sent them to a setting they do not have.
 * Both routes that validate stop coordinates (optimize and the run reorder) carry the same words.
 */
const SRC = readFileSync(join(__dirname, "route-optimization.service.ts"), "utf8");

describe("route optimization: the unplaced-customers message", () => {
  it("says what to check, on both validation sites", () => {
    const line = "We couldn't place these customers on the map: ${names}. Check their addresses.";
    expect(SRC.split(line)).toHaveLength(3);
  });

  it("no longer tells a tenant to set a server key", () => {
    expect(SRC).not.toMatch(/Set GOOGLE_MAPS_API_KEY/);
    expect(SRC).not.toMatch(/Missing geocoded addresses/);
  });
});
