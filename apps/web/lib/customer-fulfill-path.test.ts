import { payloadFulfillPath } from "./customer-fulfill-path";

/**
 * Both rules at once (SA-655 + the fleet-off capability preselect): a PICKUP customer's save omits the
 * field; every other value goes through the account's preselect.
 */
describe("payloadFulfillPath", () => {
  const shipOnly = (v?: string | null) => (v === "SHIP" ? "SHIP" : "SHIP") as "ROUTE" | "SHIP";
  const both = (v?: string | null) => (v === "SHIP" ? "SHIP" : "ROUTE") as "ROUTE" | "SHIP";

  it("omits the field for a PICKUP customer, whatever the account offers", () => {
    expect(payloadFulfillPath("PICKUP", shipOnly, "SHIP")).toBeUndefined();
    expect(payloadFulfillPath("PICKUP", both, "ROUTE")).toBeUndefined();
  });

  it("sends the account's preselect for ROUTE / SHIP / unset", () => {
    expect(payloadFulfillPath("ROUTE", shipOnly, "SHIP")).toBe("SHIP"); // ship-only: ROUTE is not offered
    expect(payloadFulfillPath("ROUTE", both, "ROUTE")).toBe("ROUTE");
    expect(payloadFulfillPath("SHIP", both, "ROUTE")).toBe("SHIP");
    expect(payloadFulfillPath(undefined, both, "ROUTE")).toBe("ROUTE");
  });
});

/**
 * SA-1066 M9 (A-1): on a pickup, or pickup and ship, business the account default is PICKUP, the form can only hold ROUTE or
 * SHIP, and `pickForm` turns PICKUP into SHIP. Nobody chose that SHIP (the picker is hidden there), so the payload carries no
 * path at all: a create is stored as ROUTE (no preference) and an update keeps what is stored.
 */
describe("payloadFulfillPath: a pickup-default account never writes SHIP by accident", () => {
  // the real preselect on these accounts: PICKUP is not a form value, so every pick lands on SHIP
  const pickupDefault = (_v?: string | null) => "SHIP" as "ROUTE" | "SHIP";

  it.each([undefined, "ROUTE", "SHIP", "PICKUP"] as const)(
    "R15/R15a/R15b/R15c/R15f: a %s form value sends no fulfillPath when the account default is PICKUP",
    (value) => {
      expect(payloadFulfillPath(value, pickupDefault, "PICKUP")).toBeUndefined();
    },
  );

  it.each([
    ["SHIP", "ROUTE", "SHIP"],
    ["ROUTE", "ROUTE", "ROUTE"],
    ["ROUTE", "SHIP", "SHIP"],
  ] as const)(
    "R15e: a %s-default account is as before (value %s sends %s)",
    (staffDefault, value, sent) => {
      const pick = (v?: string | null) =>
        v === "ROUTE" && staffDefault !== "SHIP" ? "ROUTE" : "SHIP";
      expect(payloadFulfillPath(value, pick as never, staffDefault)).toBe(sent);
    },
  );

  it("R15e: an unset default (capability unknown) is as before", () => {
    const both = (v?: string | null) => (v === "SHIP" ? "SHIP" : "ROUTE") as "ROUTE" | "SHIP";
    expect(payloadFulfillPath("ROUTE", both, undefined)).toBe("ROUTE");
    expect(payloadFulfillPath("ROUTE", both, null)).toBe("ROUTE");
  });
});
