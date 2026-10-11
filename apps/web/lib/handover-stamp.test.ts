import {
  handOverStampLine,
  handOverStampName,
  isHandedOver,
  seesHandOverStamp,
} from "./handover-stamp";

describe("handOverStampLine (row 342)", () => {
  it("register and cashier", () => {
    expect(handOverStampLine({ registerKey: "main", soldBy: { username: "Pat" } })).toBe(
      "Handed over at register main by Pat",
    );
  });
  it("register only (no cashier stamped)", () => {
    expect(handOverStampLine({ registerKey: "main", soldBy: null })).toBe(
      "Handed over at register main",
    );
    expect(handOverStampLine({ registerKey: "front" })).toBe("Handed over at register front");
  });
  it("cashier only (no register stamped)", () => {
    expect(handOverStampLine({ registerKey: null, soldBy: { username: "pat" } })).toBe(
      "Handed over by pat",
    );
  });
  it("neither: null", () => {
    expect(handOverStampLine({})).toBeNull();
    expect(handOverStampLine({ registerKey: null, soldBy: null })).toBeNull();
    expect(handOverStampLine({ registerKey: "  ", soldBy: { username: " " } })).toBeNull();
    expect(handOverStampLine(null)).toBeNull();
    expect(handOverStampLine(undefined)).toBeNull();
  });
  it("prefers the API's handedOverBy over the cashier relation", () => {
    expect(
      handOverStampLine({ registerKey: "main", handedOverBy: "Pat", soldBy: { username: "x" } }),
    ).toBe("Handed over at register main by Pat");
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
