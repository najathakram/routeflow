import { BUSINESS_PROFILE_KEYS } from "@routeflow/types";
import { INCLUDED_FREE_COPY, profileBullets, profilePlainCopy } from "./profile-plain-copy";
import * as setupCopy from "./setup-copy";

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
      in_store_retailer: "Counter sales only",
      in_store_shipping_retailer: "Counter + shipping",
      delivery_pos: "Delivery + counter",
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
      "Orders are collected at the counter only",
      "No routes, delivery or driver payments",
    ]);
    expect(profileBullets("future")).toEqual([]);
  });
});

describe("SA-769: the comp line of the profile preview", () => {
  it("the copy a module the profile will comp carries is fixed here, not typed in the modal", () => {
    expect(INCLUDED_FREE_COPY).toBe("Included free with this profile");
  });
});

/**
 * BO-11: what each preset writes to `counter_sales` once BO-04 lands (the Delivery and Shipping-only presets write
 * `unset`; the three counter presets write `on`). The server definitions live in
 * `apps/api/src/billing/business-profiles.ts`; web cannot import them, so the table is pinned here.
 */
const COUNTER_EFFECT: Record<(typeof BUSINESS_PROFILE_KEYS)[number], "unset" | "on"> = {
  delivery_distributor: "unset",
  shipping_wholesaler: "unset",
  in_store_retailer: "on",
  in_store_shipping_retailer: "on",
  delivery_pos: "on",
};

describe("BO-11: every counter promise matches what the preset writes", () => {
  it("pins an effect for every preset key", () => {
    expect(Object.keys(COUNTER_EFFECT).sort()).toEqual([...BUSINESS_PROFILE_KEYS].sort());
  });

  it.each(BUSINESS_PROFILE_KEYS.filter((k) => COUNTER_EFFECT[k] === "unset"))(
    "%s turns counter sales off, so its copy never says the counter is left as it is",
    (key) => {
      const all = [profilePlainCopy(key, "x", "y").line, ...profileBullets(key)];
      for (const text of all) expect(text).not.toMatch(/left as|as they are|unchanged/i);
      expect(profileBullets(key)).toContain("No counter sales");
    },
  );

  it.each(BUSINESS_PROFILE_KEYS.filter((k) => COUNTER_EFFECT[k] === "on"))(
    "%s turns counter sales on, so a bullet promises the counter and none denies it",
    (key) => {
      const bullets = profileBullets(key);
      expect(bullets.some((b) => /^Counter in the menu/.test(b))).toBe(true);
      for (const b of bullets) expect(b).not.toMatch(/no counter sales/i);
    },
  );
});

/** Every string the two copy modules hand to the screen, including what their functions return. */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

describe("BO-11: one name per idea in the Backoffice copy", () => {
  const strings = [
    ...collectStrings(setupCopy),
    INCLUDED_FREE_COPY,
    ...BUSINESS_PROFILE_KEYS.flatMap((k) => {
      const c = profilePlainCopy(k, "x", "y");
      return [c.name, c.line, ...profileBullets(k)];
    }),
    ...[
      ...setupCopy.FLEET_MODULES.map((m) => m.key),
      "fulfilment_model",
      "counter_sales",
      "other",
    ].map(setupCopy.keyLabel),
    ...["unset", "delivery", "ship", "both", "pickup", "pickup_ship", "teleport"].map(
      setupCopy.fulfilmentModeLabel,
    ),
  ];

  it("collects a meaningful number of strings (the sweep is not vacuous)", () => {
    expect(strings.length).toBeGreaterThan(30);
  });

  it("never calls the till POS", () => {
    expect(strings.filter((s) => /\bPOS\b/.test(s))).toEqual([]);
  });

  it("never says in store or in-store: the till is the counter", () => {
    expect(strings.filter((s) => /\bin[- ]store\b/i.test(s))).toEqual([]);
  });
});
