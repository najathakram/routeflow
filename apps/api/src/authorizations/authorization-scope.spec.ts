import { isScopeActive, scopeApplies } from "./authorization-scope";

describe("isScopeActive", () => {
  const now = new Date("2026-07-07T12:00:00Z");

  it("ORDER scope matches only its order id", () => {
    expect(isScopeActive("ORDER:ord-1", { orderId: "ord-1", now })).toBe(true);
    expect(isScopeActive("ORDER:ord-1", { orderId: "ord-2", now })).toBe(false);
    expect(isScopeActive("ORDER:ord-1", { now })).toBe(false); // no order in context
  });

  it("UNTIL scope is active before the deadline, inactive after", () => {
    expect(isScopeActive("UNTIL:2026-07-08T00:00:00Z", { now })).toBe(true);
    expect(isScopeActive("UNTIL:2026-07-06T00:00:00Z", { now })).toBe(false);
  });

  it("fails CLOSED on empty / malformed / bad-date scopes", () => {
    expect(isScopeActive("", { now })).toBe(false);
    expect(isScopeActive("garbage", { now })).toBe(false);
    expect(isScopeActive("UNTIL:not-a-date", { now })).toBe(false);
    expect(isScopeActive("WHATEVER:x", { now })).toBe(false);
  });
});

describe("scopeApplies", () => {
  it("no city filter → applies everywhere", () => {
    expect(scopeApplies(null, "Oakland")).toBe(true);
    expect(scopeApplies({}, undefined)).toBe(true);
    expect(scopeApplies({ cities: [] }, undefined)).toBe(true);
  });

  it("city filter matches case-insensitively", () => {
    expect(scopeApplies({ cities: ["Oakland"] }, "oakland")).toBe(true);
    expect(scopeApplies({ cities: ["Oakland", "Berkeley"] }, "Berkeley")).toBe(true);
  });

  it("known other city → does NOT apply (don't gate)", () => {
    expect(scopeApplies({ cities: ["Oakland"] }, "Fresno")).toBe(false);
  });

  it("UNKNOWN city → fails CLOSED and DOES gate (compliance safety)", () => {
    expect(scopeApplies({ cities: ["Oakland"] }, undefined)).toBe(true);
    expect(scopeApplies({ cities: ["Oakland"] }, null)).toBe(true);
  });
});
