/**
 * Row 591 — `typedLinePrice` is the one place a client-typed line price is honoured: staff only, and a
 * `null` is "no price sent" exactly like an absent one (`Number(null)` is 0, a typed $0 nobody typed).
 */
import { typedLinePrice } from "./driver-line-price";

const staff = { role: "OPERATOR" };
const admin = { role: "TENANT_ADMIN" };
const driver = { role: "DRIVER" };

describe("typedLinePrice", () => {
  it("staff + null -> null (no price sent, never a typed $0)", () => {
    expect(typedLinePrice(staff, null)).toBeNull();
    expect(typedLinePrice(admin, null)).toBeNull();
  });

  it("staff + undefined -> null", () => {
    expect(typedLinePrice(staff, undefined)).toBeNull();
  });

  it("staff + an explicit 0 -> 0 (a real typed price, unchanged)", () => {
    expect(typedLinePrice(staff, 0)).toBe(0);
    expect(typedLinePrice(staff, "0")).toBe(0);
  });

  it("staff + a price -> the number", () => {
    expect(typedLinePrice(staff, 5)).toBe(5);
    expect(typedLinePrice(admin, "7.5")).toBe(7.5);
  });

  it("a driver's price is always dropped", () => {
    expect(typedLinePrice(driver, 5)).toBeNull();
    expect(typedLinePrice(driver, 0)).toBeNull();
    expect(typedLinePrice(driver, null)).toBeNull();
  });
});
