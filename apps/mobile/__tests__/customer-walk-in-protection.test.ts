import { canDeleteCustomer } from "../lib/customer-walk-in-protection";

describe("canDeleteCustomer", () => {
  it("offers no Delete for the walk-in customer", () => {
    expect(canDeleteCustomer({ isWalkIn: true })).toBe(false);
  });

  it("offers Delete for an ordinary customer (flag false, null or absent)", () => {
    expect(canDeleteCustomer({ isWalkIn: false })).toBe(true);
    expect(canDeleteCustomer({ isWalkIn: null })).toBe(true);
    expect(canDeleteCustomer({})).toBe(true);
  });
});
