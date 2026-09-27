import { b58GuardRefusal, B58GuardInput } from "./b58-guard";

// #2189 / SA-389 (4): the B58 guard as a pure function — rank × cycle × status matrix.
describe("b58GuardRefusal", () => {
  const LIVE = new Date("2026-11-01T00:00:00Z");
  const base: B58GuardInput = {
    status: "ACTIVE",
    fromKey: "TEAM",
    sub: { planKey: "TEAM", cycle: "MONTHLY", periodEnd: LIVE },
    toPlanKey: "TEAM",
    toCycle: "MONTHLY",
  };
  const run = (over: Partial<B58GuardInput>) => b58GuardRefusal({ ...base, ...over });

  it.each([
    // [status, toPlanKey, toCycle, refused?, sameRank?]
    ["ACTIVE", "TEAM", "MONTHLY", true, true], // same rank, same cycle
    ["ACTIVE", "BUSINESS", "MONTHLY", true, false], // different rank, same cycle
    ["ACTIVE", "TEAM", "ANNUAL", false, null], // same rank, different cycle
    ["ACTIVE", "BUSINESS", "ANNUAL", false, null], // different rank, different cycle
    ["TRIAL", "TEAM", "MONTHLY", false, null],
    ["TRIAL", "BUSINESS", "MONTHLY", false, null],
    ["READ_ONLY", "TEAM", "MONTHLY", false, null],
    ["CANCELLED", "BUSINESS", "MONTHLY", false, null],
  ])("%s → %s/%s: refused=%s", (status, toPlanKey, toCycle, refused, sameRank) => {
    const r = run({
      status: status as string,
      toPlanKey: toPlanKey as string,
      toCycle: toCycle as string,
    });
    expect(r !== null).toBe(refused);
    if (r) expect(r.sameRank).toBe(sameRank);
  });

  it("the messages route same rank to 'nothing to change' and different rank to upgrade/downgrade", () => {
    expect(run({})?.message).toBe("You are already on this plan — nothing to change");
    expect(run({ toPlanKey: "BUSINESS" })?.message).toBe(
      "Your subscription is active — use upgrade or downgrade to change plan",
    );
  });

  it("passes when there is no live cycle to protect (no sub, no periodEnd, no fromKey)", () => {
    expect(run({ sub: null })).toBeNull();
    expect(run({ sub: { ...base.sub!, periodEnd: null } })).toBeNull();
    expect(run({ fromKey: null })).toBeNull();
  });

  it("a same-rank pick on a plan-less (manual-activation) row heals it; a different rank still refuses", () => {
    const planless = { ...base.sub!, planKey: null };
    expect(run({ sub: planless })).toBeNull();
    expect(run({ sub: planless, toPlanKey: "BUSINESS" })).not.toBeNull();
  });
});
