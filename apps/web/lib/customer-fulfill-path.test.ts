import { payloadFulfillPath } from "./customer-fulfill-path";

/**
 * Both rules at once (SA-655 + the fleet-off capability preselect): a PICKUP customer's save omits the
 * field; every other value goes through the account's preselect.
 */
describe("payloadFulfillPath", () => {
  const shipOnly = (v?: string | null) => (v === "SHIP" ? "SHIP" : "SHIP") as "ROUTE" | "SHIP";
  const both = (v?: string | null) => (v === "SHIP" ? "SHIP" : "ROUTE") as "ROUTE" | "SHIP";

  it("omits the field for a PICKUP customer, whatever the account offers", () => {
    expect(payloadFulfillPath("PICKUP", shipOnly, "SHIP", "PICKUP")).toBeUndefined();
    expect(payloadFulfillPath("PICKUP", both, "ROUTE", "PICKUP")).toBeUndefined();
  });

  it("sends the account's preselect for ROUTE / SHIP / unset", () => {
    expect(payloadFulfillPath("ROUTE", shipOnly, "SHIP", "ROUTE")).toBe("SHIP"); // ship-only: ROUTE is not offered
    expect(payloadFulfillPath("ROUTE", both, "ROUTE", "ROUTE")).toBe("ROUTE");
    expect(payloadFulfillPath("SHIP", both, "ROUTE", "ROUTE")).toBe("SHIP");
    expect(payloadFulfillPath(undefined, both, "ROUTE", "ROUTE")).toBe("ROUTE");
  });
});

/**
 * SA-1066 M9 (A-1, A-4): on a pickup, or pickup and ship, business the account default is PICKUP, the form can only hold ROUTE
 * or SHIP, and `pickForm` turns PICKUP into SHIP. A value the form opened with is nobody's choice, so the payload carries no
 * path: a create is stored as ROUTE (no preference) and an update keeps what is stored. A value the clerk changed is a choice
 * and goes out; `opened` is the value the form opened with.
 */
describe("payloadFulfillPath: a pickup-default account never writes SHIP by accident", () => {
  // the real preselect on these accounts: PICKUP is not a form value, so every pick lands on SHIP
  const pickupDefault = (_v?: string | null) => "SHIP" as "ROUTE" | "SHIP";

  it.each([undefined, "ROUTE", "SHIP", "PICKUP"] as const)(
    "R15/R15a/R15b/R15c/R15f: a %s form value still equal to what the form opened with sends no fulfillPath",
    (value) => {
      expect(payloadFulfillPath(value, pickupDefault, "PICKUP", value as never)).toBeUndefined();
    },
  );

  it("R-A4a: a stored PICKUP customer whose clerk picked Ship sends SHIP", () => {
    expect(payloadFulfillPath("SHIP", pickupDefault, "PICKUP", "PICKUP")).toBe("SHIP");
  });

  it("R-A4c: picking Ship and then Pickup again is back at what the form opened with: nothing is sent", () => {
    expect(payloadFulfillPath("PICKUP", pickupDefault, "PICKUP", "PICKUP")).toBeUndefined();
  });

  it("R-A4: a changed value that is PICKUP itself still omits the field (the server keeps what is stored)", () => {
    expect(payloadFulfillPath("PICKUP", pickupDefault, "PICKUP", "SHIP")).toBeUndefined();
  });

  it("R-A4f: a create passes the account's new-customer path as opened: nothing is sent", () => {
    expect(payloadFulfillPath("SHIP", pickupDefault, "PICKUP", "SHIP")).toBeUndefined();
  });

  it.each([
    ["SHIP", "ROUTE", "SHIP"],
    ["ROUTE", "ROUTE", "ROUTE"],
    ["ROUTE", "SHIP", "SHIP"],
  ] as const)(
    "R15e: a %s-default account is as before (value %s sends %s)",
    (staffDefault, value, sent) => {
      const pick = (v?: string | null) =>
        v === "ROUTE" && staffDefault !== "SHIP" ? "ROUTE" : "SHIP";
      expect(payloadFulfillPath(value, pick as never, staffDefault, value)).toBe(sent);
    },
  );

  it("R15e: an unset default (capability unknown) is as before", () => {
    const both = (v?: string | null) => (v === "SHIP" ? "SHIP" : "ROUTE") as "ROUTE" | "SHIP";
    expect(payloadFulfillPath("ROUTE", both, undefined, "ROUTE")).toBe("ROUTE");
    expect(payloadFulfillPath("ROUTE", both, null, "ROUTE")).toBe("ROUTE");
  });
});
