import {
  DARK_PLAN_FLAGS,
  isPlanFlagEnforcementOn,
  isDarkFlag,
  allowsFlag,
} from "./plan-flag-policy";

describe("DARK_PLAN_FLAGS", () => {
  it("contains the 2026-08-23 rollout flags plus the WP2 Lite extension flags", () => {
    expect([...DARK_PLAN_FLAGS].sort()).toEqual(
      [
        "flag.analytics",
        "flag.ap_bills",
        "flag.import_integrations",
        "flag.forecasting",
        "flag.pricing_tiers",
        "flag.reports",
        "flag.returns",
        "flag.estimates",
        "flag.recurring_invoices",
        "flag.credit_notes",
        "flag.suppliers",
        "flag.messaging",
        "addon.buyer_portal",
      ].sort(),
    );
  });

  it("does NOT contain flag.msrp — it was already enforced before the kill switch existed", () => {
    expect(DARK_PLAN_FLAGS.has("flag.msrp")).toBe(false);
  });

  it("does NOT contain unrelated flags (e.g. flag.dispatch_live, flag.credit_limits)", () => {
    expect(DARK_PLAN_FLAGS.has("flag.dispatch_live")).toBe(false);
    expect(DARK_PLAN_FLAGS.has("flag.credit_limits")).toBe(false);
  });
});

describe("isPlanFlagEnforcementOn", () => {
  it("is false when PLAN_FLAG_ENFORCEMENT is unset", () => {
    expect(isPlanFlagEnforcementOn({})).toBe(false);
  });

  it('is false for "off" and any other value', () => {
    expect(isPlanFlagEnforcementOn({ PLAN_FLAG_ENFORCEMENT: "off" })).toBe(false);
    expect(isPlanFlagEnforcementOn({ PLAN_FLAG_ENFORCEMENT: "banana" })).toBe(false);
  });

  it('is true only for the exact value "on"', () => {
    expect(isPlanFlagEnforcementOn({ PLAN_FLAG_ENFORCEMENT: "on" })).toBe(true);
    expect(isPlanFlagEnforcementOn({ PLAN_FLAG_ENFORCEMENT: "ON" })).toBe(false);
  });
});

describe("isDarkFlag", () => {
  it("is true for a DARK_PLAN_FLAGS member when enforcement is off", () => {
    expect(isDarkFlag("flag.reports", {})).toBe(true);
    expect(isDarkFlag("addon.buyer_portal", { PLAN_FLAG_ENFORCEMENT: "off" })).toBe(true);
  });

  it("is false for a DARK_PLAN_FLAGS member when enforcement is on", () => {
    expect(isDarkFlag("flag.reports", { PLAN_FLAG_ENFORCEMENT: "on" })).toBe(false);
  });

  it("is false for a flag outside DARK_PLAN_FLAGS regardless of enforcement", () => {
    expect(isDarkFlag("flag.msrp", {})).toBe(false);
    expect(isDarkFlag("flag.msrp", { PLAN_FLAG_ENFORCEMENT: "on" })).toBe(false);
  });
});

describe("allowsFlag", () => {
  const env = {}; // PLAN_FLAG_ENFORCEMENT unset → dark flags courtesy-allow non-always-enforced tenants

  it("allows a courtesy-dark tenant (non always-enforced plan) that lacks the flag outright", () => {
    const ent = { planKey: "STARTER", flags: [] as string[] };
    expect(allowsFlag(ent, "flag.reports", env)).toBe(true);
  });

  it("still allows when the tenant DOES carry the flag (redundant but consistent)", () => {
    const ent = { planKey: "SCALE", flags: ["flag.reports"] };
    expect(allowsFlag(ent, "flag.reports", env)).toBe(true);
  });

  it("denies an always-enforced plan (LITE) that lacks a dark flag — no courtesy allow (R3a.7)", () => {
    const ent = { planKey: "LITE", flags: [] as string[] };
    expect(allowsFlag(ent, "flag.reports", env)).toBe(false);
  });

  it("allows an always-enforced plan (LITE) that DOES carry the dark flag", () => {
    const ent = { planKey: "LITE", flags: ["flag.reports"] };
    expect(allowsFlag(ent, "flag.reports", env)).toBe(true);
  });

  it("denies any tenant (including a non-always-enforced plan) missing a non-dark flag", () => {
    const ent = { planKey: "STARTER", flags: [] as string[] };
    expect(allowsFlag(ent, "flag.msrp", env)).toBe(false);
  });

  it("allows any tenant carrying a non-dark flag", () => {
    const ent = { planKey: "STARTER", flags: ["flag.msrp"] };
    expect(allowsFlag(ent, "flag.msrp", env)).toBe(true);
  });

  it("with enforcement ON, a non-always-enforced tenant loses the dark courtesy allow too", () => {
    const ent = { planKey: "STARTER", flags: [] as string[] };
    expect(allowsFlag(ent, "flag.reports", { PLAN_FLAG_ENFORCEMENT: "on" })).toBe(false);
  });
});
