import {
  handOverStampLine,
  handOverStampName,
  isHandedOver,
  seesHandOverStamp,
} from "./handover-stamp";

describe("handOverStampLine (row 342)", () => {
  it("register and cashier", () => {
    expect(handOverStampLine({ registerKey: "main", soldBy: { username: "Pat" } })).toBe(
      "Handed over by Pat · main",
    );
  });
  it("register only (no cashier stamped)", () => {
    expect(handOverStampLine({ registerKey: "main", soldBy: null })).toBe("Handed over · main");
    expect(handOverStampLine({ registerKey: "front" })).toBe("Handed over · front");
  });
  it("an unstamped register (null) reads as main", () => {
    expect(handOverStampLine({ registerKey: null, soldBy: { username: "pat" } })).toBe(
      "Handed over by pat · main",
    );
    expect(handOverStampLine({ registerKey: null, handedOverBy: null, soldBy: null })).toBe(
      "Handed over · main",
    );
    expect(handOverStampLine({ registerKey: "  ", soldBy: { username: " " } })).toBe(
      "Handed over · main",
    );
  });
  it("an absent registerKey (older API / no stamp on the read)", () => {
    expect(handOverStampLine({ soldBy: { username: "pat" } })).toBe("Handed over by pat");
    expect(handOverStampLine({})).toBeNull();
    expect(handOverStampLine({ soldBy: null, handedOverBy: null })).toBeNull();
    expect(handOverStampLine({ soldBy: { username: " " } })).toBeNull();
    expect(handOverStampLine(null)).toBeNull();
    expect(handOverStampLine(undefined)).toBeNull();
  });
  it("prefers the API's handedOverBy over the cashier relation", () => {
    expect(
      handOverStampLine({ registerKey: "main", handedOverBy: "Pat", soldBy: { username: "x" } }),
    ).toBe("Handed over by Pat · main");
  });
});

describe("handOverStampLine time (row 342)", () => {
  const at = "2026-10-07T15:14:00.000Z";
  it("adds the hand-over time in the business's zone", () => {
    expect(
      handOverStampLine(
        { registerKey: "main", handedOverBy: "Pat", deliveredAt: at },
        "America/New_York",
      ),
    ).toBe("Handed over by Pat · main · Oct 7, 2026, 11:14 AM");
  });
  it("shows no time while the zone is unknown (never a time in the wrong zone)", () => {
    expect(handOverStampLine({ registerKey: "main", handedOverBy: "Pat", deliveredAt: at })).toBe(
      "Handed over by Pat · main",
    );
  });
  it("no cashier: register and time only; no time on the order: none", () => {
    expect(handOverStampLine({ registerKey: null, deliveredAt: at }, "UTC")).toBe(
      "Handed over · main · Oct 7, 2026, 3:14 PM",
    );
    expect(
      handOverStampLine({ registerKey: "main", handedOverBy: "Pat", deliveredAt: null }, "UTC"),
    ).toBe("Handed over by Pat · main");
  });
  it("a time alone is not a stamp", () => {
    expect(handOverStampLine({ deliveredAt: at }, "UTC")).toBeNull();
  });
});

describe("handOverStampName (row 342)", () => {
  it("username first, then name, then first + last", () => {
    expect(handOverStampName({ soldBy: { username: " pat ", name: "Pat S" } })).toBe("pat");
    expect(handOverStampName({ soldBy: { name: "Pat Smith" } })).toBe("Pat Smith");
    expect(handOverStampName({ soldBy: { firstName: "Pat", lastName: "Smith" } })).toBe(
      "Pat Smith",
    );
    expect(handOverStampName({ soldBy: { firstName: "Pat" } })).toBe("Pat");
  });
  it("never puts an email on the page", () => {
    expect(handOverStampName({ soldBy: { username: "pat@shop.test" } })).toBeNull();
    expect(
      handOverStampName({ soldBy: { username: "pat@shop.test", name: "p@shop.test" } }),
    ).toBeNull();
    expect(
      handOverStampName({ soldBy: { username: "pat@shop.test", firstName: "Pat", lastName: "S" } }),
    ).toBe("Pat S");
  });
  it("no cashier: null", () => {
    expect(handOverStampName({})).toBeNull();
    expect(handOverStampName({ soldBy: {} })).toBeNull();
  });
});

describe("isHandedOver (row 342)", () => {
  it("a counter sale, or a DELIVERED pickup order", () => {
    expect(isHandedOver({ counterSale: true, fulfillPath: "PICKUP", status: "DELIVERED" })).toBe(
      true,
    );
    expect(isHandedOver({ fulfillPath: "PICKUP", status: "DELIVERED" })).toBe(true);
  });
  it("not a pickup still waiting, nor a route/ship order", () => {
    expect(isHandedOver({ fulfillPath: "PICKUP", status: "CONFIRMED" })).toBe(false);
    expect(isHandedOver({ fulfillPath: "ROUTE", status: "DELIVERED" })).toBe(false);
    expect(isHandedOver({ fulfillPath: "SHIP", status: "DELIVERED" })).toBe(false);
  });
  it("a page without fulfillPath shows it whenever the stamp exists", () => {
    expect(isHandedOver({ status: "DELIVERED" })).toBe(true);
    expect(isHandedOver({})).toBe(true);
  });
});

describe("seesHandOverStamp (row 342)", () => {
  it("staff roles only", () => {
    for (const r of ["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])
      expect(seesHandOverStamp(r)).toBe(true);
    for (const r of ["CUSTOMER", "DRIVER", "", null, undefined])
      expect(seesHandOverStamp(r)).toBe(false);
  });
});
