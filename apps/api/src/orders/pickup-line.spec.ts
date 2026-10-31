import { pickupLineOf, readPickupAddress } from "./pickup-line";

/** W-1043 (SA-1062 MUST 20) R19: the one seam for the pickup tail of the Ready email (#3167 adds hours here). */
describe("pickupLineOf", () => {
  it("names the address after a leading space, ending in a full stop", () => {
    expect(
      pickupLineOf({ street: "12 Main St", city: "Springfield", state: "NY", zip: "12345" }),
    ).toBe(" Pick up at 12 Main St, Springfield, NY 12345.");
  });
  it("keeps what is there when the city line is partial", () => {
    expect(pickupLineOf({ street: "12 Main St", city: "Springfield" })).toBe(
      " Pick up at 12 Main St, Springfield.",
    );
    expect(pickupLineOf({ street: "12 Main St", zip: "12345" })).toBe(
      " Pick up at 12 Main St, 12345.",
    );
  });
  it("trims blanks", () => {
    expect(pickupLineOf({ street: "  12 Main St ", city: " ", state: null, zip: "" })).toBe(
      " Pick up at 12 Main St.",
    );
  });
  it.each([null, undefined, {}, { street: "  " }, { city: "Springfield", zip: "12345" }])(
    "a business with no street address reads blank: %j",
    (cfg) => {
      expect(pickupLineOf(cfg as never)).toBe("");
    },
  );
});

/** SA-1062 MUST 20: the receipt's fallback. A config with no address fields reads the `settings.*` rows. */
describe("readPickupAddress", () => {
  const prismaWith = (
    config: Record<string, string | null> | null,
    rows: { key: string; value: string }[],
  ) =>
    ({
      tenantConfig: { findUnique: jest.fn().mockResolvedValue(config) },
      forTenant: () => ({ systemConfig: { findMany: jest.fn().mockResolvedValue(rows) } }),
    }) as never;
  const settingsRows = [
    { key: "settings.street", value: "34 Oak Ave" },
    { key: "settings.city", value: "Riverton" },
    { key: "settings.state", value: "CA" },
    { key: "settings.zip", value: "90210" },
  ];

  it("falls back to the settings rows when the config has no address fields", async () => {
    const config = { addressLine1: null, city: null, state: null, zip: null };
    const address = await readPickupAddress(prismaWith(config, settingsRows), "t1");
    expect(pickupLineOf(address)).toBe(" Pick up at 34 Oak Ave, Riverton, CA 90210.");
  });
  it("prefers the config's own fields over the settings rows", async () => {
    const config = { addressLine1: "12 Main St", city: "Springfield", state: "NY", zip: "12345" };
    const address = await readPickupAddress(prismaWith(config, settingsRows), "t1");
    expect(pickupLineOf(address)).toBe(" Pick up at 12 Main St, Springfield, NY 12345.");
  });
});
