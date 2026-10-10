import { BUSINESS_PROFILE_KEYS } from "@routeflow/types";
import { profileBullets, profilePlainCopy } from "./profile-plain-copy";

describe("SA-1: profile plain copy", () => {
  it("has plain copy for every profile key the contract lists", () => {
    for (const key of BUSINESS_PROFILE_KEYS) {
      const copy = profilePlainCopy(key, "Server label", "Server description");
      expect(copy.name).not.toBe("Server label");
      expect(copy.line.length).toBeGreaterThan(10);
      expect(copy.secondary).toBe("Server label");
    }
  });

  it("maps the four profiles to their plain names", () => {
    const names = Object.fromEntries(
      BUSINESS_PROFILE_KEYS.map((k) => [k, profilePlainCopy(k, "x", "y").name]),
    );
    expect(names).toEqual({
      delivery_distributor: "Delivery",
      shipping_wholesaler: "Shipping only",
      in_store_retailer: "POS only: counter sales",
      in_store_shipping_retailer: "POS + shipping",
      delivery_pos: "Delivery + POS",
    });
  });

  it("an unknown key falls back to the server label and description, with no secondary line", () => {
    expect(profilePlainCopy("future", "Future profile", "Server text")).toEqual({
      name: "Future profile",
      line: "Server text",
      secondary: null,
    });
  });

  it("SA-2: each profile has exactly three 'what the business will see' bullets; unknown keys have none", () => {
    for (const key of BUSINESS_PROFILE_KEYS) expect(profileBullets(key)).toHaveLength(3);
    expect(profileBullets("in_store_retailer")).toEqual([
      "Counter in the menu",
      "Orders are in-store pickup only",
      "No routes, delivery or driver payments",
    ]);
    expect(profileBullets("future")).toEqual([]);
  });
});
